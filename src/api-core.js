// API inti Parlementer: auth (email+password), dashboard, pekerjaan, perusahaan,
// pasar, valas, peta, inventaris, konvoi, misi, kronik, pencapaian, notifikasi, profil, toko.
import crypto from 'node:crypto';
import { hashPassword, verifyPassword } from './bcrypt-pool.js';
import { sql, one, run, tx, forUpdate, generateReferralCode, convoyBuildings, getParliamentOpensAt, getWorldDay, missionValue, missionClaimedKeys, insertMissionClaim, chronicleDoneKeys, chronicleClaimedChapters, insertChronicleClaim, markChronicleDone, isPg } from './db.js';
import {
  signToken, cookieOptions, COOKIE_NAME, authRequired, citizenRequired,
  loadCitizen, isValidEmail, isValidUsername, todayStr, publicId,
  getUserIdFromReq, bootstrapCodeMatches, fmtRp, parseImageDataUrl,
  isHeicDataUrl, HEIC_ERROR_MESSAGE,
  requireCredit, creditScoreSettled,
} from './util.js';
import { dbRateLimit } from './rate-limit.js';
import { getMyCountry, getIncomeTaxRate, getImportTaxRate, getAdminPayMult, getTravelTickets, hasTradePact, budgetActive, countrySummary, militaryPowerOf, militaryUnitsOf } from './api-civic.js';
import {
  VERSION, WA_TOPUP_URL, MINT_RATE, MIN_OFFER_QTY, TRADE_PACT_TAX_MULT, ideologyDef,
  xpForLevel, isDoubleXpHour, xpGainForShiftEnergy, shiftSalary, fatigueMult, trainCost, trainCostDiscounted, trainCooldownMs, formatCooldownMs, foodEnergy,
  energyCapFor, DAILY_MISSIONS, DAILY_CLAIM, CHRONICLE, travelMinutesFor, MOVE_COOLDOWN_MS, REGION_COORDS,
  ACHIEVEMENTS, achievementProgress, COMPANY_TYPES, RESOURCE_PRODUCTS,
  DAILY_PRODUCTION, PRODUCTION_INPUT, productionInputText, companyProduct, shiftBonusText, SHOP_PACKAGES, SHOP_PREMIUM, PREMIUM_PERKS, CONVOY_BUILDINGS, convoySlotsFor,
  ENERGY_DRINK_NAME, ENERGY_DRINK_PRICE_GOLD, ENERGY_DRINK_ENERGY,
  breadLimitFor, AUTO_WORK_DURATION_MS,
  COMPANY_WAGE_MAX_USD, SHIFT_MAX_PER_CALL,
  PRICE_BAND, WASH_TRADE, creditInfo, CREDIT_MIN_FOR,
  MILITARY_UNITS, militaryPowerFor, unitDamageMult, unitUpkeepFor, unitCountFor, tradeReputation, worldEventFor,
  DAY_MS, FX_OFFER_TTL_MS, REBEL_COST, REBEL_COST_CAPITAL, REBEL_CAPITAL_NAME, WAR_DURATION_MS,
  ONLINE_WINDOW_MS, onlineStatus,
  ADINPLAY_PROPERTY_ID, AD_REWARD_GOLD, AD_TOKEN_TTL_MS, AD_MIN_INTERVAL_MS,
  SHARE_GOLD_PER_CLICK, SHARE_MAX_GOLD_PER_DAY, SHARE_MAX_CLICKS_PER_DAY, SHARE_CODE_CHARS,
} from './game.js';

// Diekspos untuk modul kerja otomatis (src/auto-work.js): performShift
// memakai helper lokal registerCore (addXp, notify, addItem, takeItem)
// sehingga tidak bisa diimpor langsung dari modul lain — registerCore
// mengisi field ini saat aplikasi dibuat (sebelum server menerima request).
export const shiftRunner = { performShift: null };

export function registerCore(app) {
  const r = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---------- helpers ----------
  async function addXp(citizen, amount) {
    let { level, xp } = citizen;
    xp += amount;
    const leveled = [];
    while (xp >= xpForLevel(level)) { xp -= xpForLevel(level); level += 1; leveled.push(level); }
    await run('UPDATE citizens SET level = ?, xp = ? WHERE id = ?', [level, xp, citizen.id]);
    for (const lv of leveled) {
      await notify(citizen.id, 'SISTEM', 'Naik Level!', `Selamat! Kamu mencapai Level ${lv}.`);
      if (lv === 5 && citizen.user_id) {
        const u = await one('SELECT referred_by FROM users WHERE id = ?', [citizen.user_id]);
        if (u?.referred_by) {
          await run('UPDATE citizens SET recruits = recruits + 1 WHERE user_id = ?', [u.referred_by]);
          await notifyByUser(u.referred_by, 'SOSIAL', 'Rekrutan naik level', 'Salah satu rekrutanmu mencapai Level 5.');
        }
      }
    }
    // Bonus referral cair saat pendaftar mencapai Level 3 (Tahap 2).
    if (level >= 3 && citizen.user_id) await processReferralPayout(citizen.user_id);
    return { level, xp };
  }

  // Bonus referral (pemilik kode +200 emas + 2 hari premium; pendaftar
  // +100 emas + 1 hari premium) — dibayar SEKALI saat pendaftar mencapai
  // Level 3, dan maks 5 bonus terbayar per hari per pemilik kode (anti
  // farming multi-akun; verifikasi email penuh ditunda ke tahap berikut).
  // Baris referral_pending yang sudah 'paid'/'skipped' tidak diproses lagi.
  // Gagal bayar tidak menggagalkan request pemanggil (level sudah naik);
  // addXp berikutnya akan mencoba lagi karena baris masih 'pending'.
  const REFERRAL_DAILY_CAP = 5;
  async function processReferralPayout(newcomerUserId) {
    const today = todayStr();
    const now = Date.now();
    try {
      await tx(async (t) => {
        const pending = await t.one(
          forUpdate('SELECT * FROM referral_pending WHERE newcomer_id = ? AND status = ?'),
          [newcomerUserId, 'pending']);
        if (!pending) return;
        const paid = await t.one(
          'SELECT COUNT(*) AS n FROM referral_pending WHERE referrer_id = ? AND status = ? AND paid_day = ?',
          [pending.referrer_id, 'paid', today]);
        const refCitizen = await t.one('SELECT id FROM citizens WHERE user_id = ?', [pending.referrer_id]);
        const newCitizen = await t.one('SELECT id FROM citizens WHERE user_id = ?', [newcomerUserId]);
        const newUserRow = await t.one('SELECT username FROM users WHERE id = ?', [newcomerUserId]);
        const newName = newUserRow?.username || 'pendaftar baru';
        if (Number(paid.n) >= REFERRAL_DAILY_CAP) {
          await t.run("UPDATE referral_pending SET status = 'skipped' WHERE id = ?", [pending.id]);
          if (refCitizen) {
            await t.run('INSERT INTO notifications (citizen_id, category, title, content, created_at) VALUES (?,?,?,?,?) RETURNING id',
              [refCitizen.id, 'SOSIAL', 'Batas bonus referral harian',
                `Bonus referral untuk ${newName} tidak cair: kamu sudah menerima ${REFERRAL_DAILY_CAP} bonus referral hari ini.`,
                now]);
          }
          return;
        }
        // Bayar pemilik kode.
        const refUser = await t.one('SELECT premium_until FROM users WHERE id = ?', [pending.referrer_id]);
        const refUntil = Math.max(now, refUser?.premium_until || 0) + REFERRER_PREMIUM_MS;
        await t.run('UPDATE users SET premium_until = ? WHERE id = ?', [refUntil, pending.referrer_id]);
        if (refCitizen) {
          await t.run('UPDATE citizens SET gold = gold + ? WHERE id = ?', [REFERRER_GOLD, refCitizen.id]);
          await t.run('INSERT INTO notifications (citizen_id, category, title, content, created_at) VALUES (?,?,?,?,?) RETURNING id',
            [refCitizen.id, 'SOSIAL', 'Bonus referral!',
              `${newName} mencapai Level 3 memakai kode referralmu. Kamu mendapat +${REFERRER_GOLD} emas + 2 hari Premium.`,
              now]);
        }
        // Bayar pendaftar.
        const newUser = await t.one('SELECT premium_until FROM users WHERE id = ?', [newcomerUserId]);
        const newUntil = Math.max(now, newUser?.premium_until || 0) + NEWCOMER_PREMIUM_MS;
        await t.run('UPDATE users SET premium_until = ? WHERE id = ?', [newUntil, newcomerUserId]);
        if (newCitizen) {
          await t.run('UPDATE citizens SET gold = gold + ? WHERE id = ?', [NEWCOMER_GOLD, newCitizen.id]);
          await t.run('INSERT INTO notifications (citizen_id, category, title, content, created_at) VALUES (?,?,?,?,?) RETURNING id',
            [newCitizen.id, 'SOSIAL', 'Bonus referral!',
              `Kamu mencapai Level 3! Bonus referral cair: +${NEWCOMER_GOLD} emas + 1 hari Premium.`,
              now]);
        }
        await t.run('UPDATE referral_pending SET status = ?, paid_at = ?, paid_day = ? WHERE id = ?',
          ['paid', now, today, pending.id]);
      });
    } catch (e) {
      console.error('[referral] payout gagal:', e.message);
    }
  }

  async function notify(citizenId, category, title, content = '', t) {
    const db = t || { run };
    await db.run('INSERT INTO notifications (citizen_id, category, title, content, created_at) VALUES (?,?,?,?,?) RETURNING id',
      [citizenId, category, title, content, Date.now()]);
  }
  async function notifyByUser(userId, category, title, content = '') {
    const c = await one('SELECT id FROM citizens WHERE user_id = ?', [userId]);
    if (c) await notify(c.id, category, title, content);
  }

  async function addItem(citizenId, commodityId, tier, qty, t) {
    const db = t || { sql, one, run };
    const row = await db.one('SELECT * FROM inventory WHERE citizen_id = ? AND commodity_id = ? AND tier = ?',
      [citizenId, commodityId, tier]);
    if (row) await db.run('UPDATE inventory SET qty = qty + ? WHERE id = ?', [qty, row.id]);
    else await db.run('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,?,?) RETURNING id',
      [citizenId, commodityId, tier, qty]);
  }
  async function takeItem(citizenId, commodityId, tier, qty, t) {
    const db = t || { sql, one, run };
    const row = await db.one(forUpdate('SELECT * FROM inventory WHERE citizen_id = ? AND commodity_id = ? AND tier = ?'),
      [citizenId, commodityId, tier]);
    if (!row || row.qty < qty) return false;
    if (row.qty === qty) await db.run('DELETE FROM inventory WHERE id = ?', [row.id]);
    else await db.run('UPDATE inventory SET qty = qty - ? WHERE id = ?', [qty, row.id]);
    return true;
  }
  // ---------- MISI HARIAN + KRONIK (Tahap 7: tabel relasional) ----------
  // Progres misi dibaca dari mission_progress (hanya 'chat' yang disimpan —
  // 'energy'/'bread' dibaca dari kolom citizens energy_spent_today/
  // bread_today). chronicleDone mendelegasikan ke markChronicleDone
  // (db.js) yang mengunci baris warga di tx sendiri.
  async function chronicleDone(citizen, key) {
    await markChronicleDone(citizen.id, key);
  }

  // ---------- EKONOMI TAHAP 4: kas negara, batas harga, tanda pasar ----------
  const round2 = (n) => Math.round(n * 100) / 100;
  // Pajak pasar -> kas negara (BUG-8). Dipanggil DI DALAM tx yang sama
  // dengan transaksinya. amount dibulatkan ke 2 desimal; nol dilewati.
  // countryId = kas negara yang menerima (penjual untuk pajak lokal,
  // pembeli untuk pajak impor global). NULL = tidak ada negara yang
  // menerima (wilayah merdeka) — pajaknya tidak masuk kas mana pun.
  async function recordTreasury(t, currency, amount, note, countryId = null) {
    const a = round2(amount);
    if (a <= 0) return;
    if (!countryId) return;
    const col = currency === 'gold' ? 'treasury' : 'treasury_usd';
    await t.run(`UPDATE country SET ${col} = ${col} + ? WHERE id = ?`, [a, countryId]);
    await t.run('INSERT INTO treasury_tx (kind, currency, amount, note, country_id, created_at) VALUES (?,?,?,?,?,?) RETURNING id',
      ['pajak_pasar', currency, a, note, countryId, Date.now()]);
  }
  // Pajak penjualan penjual (Tahap 6): bila wilayah penjual SAAT INI
  // dikuasai pemberontak (regions.controller='pemberontak'), pajak TIDAK
  // masuk kas negara — melainkan langsung ke panglima perang (controller_id)
  // dalam mata uang yang sama + notifikasi. Bila wilayah bebas/bernegara,
  // pajak masuk kas negara penjual seperti biasa (recordTreasury).
  async function paySellerTax(t, currency, amount, note, seller, sellerCountry) {
    const a = round2(amount);
    if (a <= 0) return;
    const region = await t.one('SELECT controller, controller_id FROM regions WHERE id = ?', [seller.region_id]);
    if (region?.controller === 'pemberontak' && region.controller_id) {
      const col = currency === 'gold' ? 'gold' : 'usd';
      await t.run(`UPDATE citizens SET ${col} = ${col} + ? WHERE id = ?`, [a, region.controller_id]);
      await notify(region.controller_id, 'EKONOMI', 'Pajak wilayah taklukan',
        `Pajak penjualan ${note} di wilayah yang kamu kuasai: +${a} ${currency === 'gold' ? 'emas' : 'Rupiah'}.`, t);
      return;
    }
    await recordTreasury(t, currency, amount, note, sellerCountry?.id || null);
  }
  async function checkPriceBand(db, commodityId, tier, price) {
    const since = Date.now() - PRICE_BAND.days * 86400000;
    const rows = await db.sql('SELECT price_each FROM market_tx WHERE commodity_id = ? AND tier = ? AND created_at > ? ORDER BY price_each',
      [commodityId, tier, since]);
    if (rows.length < PRICE_BAND.minTx) return { ok: true, median: null, n: rows.length };
    const mid = Math.floor(rows.length / 2);
    const median = rows.length % 2 ? rows[mid].price_each : (rows[mid - 1].price_each + rows[mid].price_each) / 2;
    const lo = median * PRICE_BAND.minMult;
    const hi = median * PRICE_BAND.maxMult;
    if (price < lo || price > hi) return { ok: false, median, n: rows.length, lo, hi };
    return { ok: true, median, n: rows.length };
  }
  async function flagMarket(db, kind, buyerId, sellerId, commodityId, detail) {
    await db.run('INSERT INTO market_flags (kind, buyer_id, seller_id, commodity_id, detail, created_at) VALUES (?,?,?,?,?,?) RETURNING id',
      [kind, buyerId, sellerId, commodityId, detail, Date.now()]);
  }
  // Tolak harga di luar batas wajar SEBELUM transaksi (cek di luar tx agar
  // catatan market_flags tidak ikut ter-rollback saat penolakan).
  // Mengembalikan objek band bila ditolak, null bila lolos.
  async function enforcePriceBand(commodityId, tier, price, actorId) {
    const band = await checkPriceBand({ sql }, commodityId, tier, price);
    if (band.ok) return null;
    await flagMarket({ run }, 'price_band', null, actorId, commodityId,
      `Harga ${price} di luar batas wajar ${band.lo.toFixed(2)}–${band.hi.toFixed(2)} (median 14 hari ${band.median.toFixed(2)}, ${band.n} transaksi).`);
    return band;
  }
  // Wash trading: ≥3 transaksi antara pasangan pembeli↔penjual yang sama
  // dalam 24 jam (dua arah) → catat saja untuk ditinjau admin (bukan ban).
  async function checkWashTrade(t, buyerId, sellerId, commodityId) {
    const since = Date.now() - WASH_TRADE.hours * 3600000;
    const row = await t.one(
      `SELECT COUNT(*) AS n FROM market_tx WHERE created_at > ? AND
       ((buyer_id = ? AND seller_id = ?) OR (buyer_id = ? AND seller_id = ?))`,
      [since, buyerId, sellerId, sellerId, buyerId]);
    if (Number(row.n) >= WASH_TRADE.minTx) {
      await flagMarket(t, 'wash_trade', buyerId, sellerId, commodityId,
        `${row.n} transaksi antara pasangan yang sama dalam 24 jam terakhir.`);
    }
  }

  // ---------- AUTH (email + password) ----------
  // Bonus referral: pemilik kode +200 emas + 2 hari premium; pendaftar baru
  // +100 emas + 1 hari premium — dibayar saat pendaftar mencapai Level 3
  // (bukan saat daftar) dan maks 5 bonus terbayar/hari/pemilik kode.
  // Premium diperpanjang dari premium_until yang masih aktif, atau dari
  // sekarang bila tidak aktif. Bonus dicatat di referral_pending.
  const REFERRER_GOLD = 200;
  const REFERRER_PREMIUM_MS = 2 * DAY_MS;
  const NEWCOMER_GOLD = 100;
  const NEWCOMER_PREMIUM_MS = 1 * DAY_MS;
  const MAX_PASSWORD_BYTES = 72; // bcrypt memotong password di atas 72 byte

  // Registrasi dibatasi 20/IP/24 jam (anti multi-akun massal, DB-backed).
  // Tes e2e memakai tepat 20 pendaftaran dari 127.0.0.1 — pemain tambahan
  // di tes memakai IP berbeda lewat X-Forwarded-For (lihat [23b]/[28]/[5b]).
  const registerRateLimit = dbRateLimit({
    keyFn: (req) => 'register:' + (req.ip || 'unknown'),
    max: 20,
    windowMs: DAY_MS,
    message: 'Terlalu banyak pendaftaran dari alamat ini. Coba lagi besok.',
  });

  app.post('/api/auth/register', registerRateLimit, r(async (req, res) => {
    const { email, password, username, ref, admin_code } = req.body || {};
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Format email tidak valid.' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter.' });
    if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return res.status(400).json({ error: 'Password maksimal 72 karakter.' });
    if (!isValidUsername(username)) return res.status(400).json({ error: 'Nama warga 3–24 karakter, huruf/angka/underscore saja.' });
    const emailTaken = await one('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (emailTaken) return res.status(400).json({ error: 'Email ini sudah terdaftar. Silakan masuk.' });
    const nameTaken = await one('SELECT id FROM users WHERE username = ?', [username]);
    if (nameTaken) return res.status(400).json({ error: 'Nama warga ini sudah dipakai orang lain.' });
    // Admin HANYA lewat kode bootstrap (env var ADMIN_BOOTSTRAP_CODE).
    // Pemberian admin berbasis email DICABUT 27 Nov 2026 (Khalid sudah
    // menjadi admin; akunnya dilindungi migrasi initDb). Email apa pun —
    // termasuk email admin — yang mendaftar tanpa kode bootstrap yang benar
    // menjadi warga biasa.
    let isAdmin = 0;
    if (admin_code) {
      if (!bootstrapCodeMatches(admin_code)) {
        return res.status(400).json({ error: 'Kode bootstrap admin salah.' });
      }
      isAdmin = 1;
    }
    // Referral berbasis KODE unik 8 karakter (bukan nama). Kode tidak valid
    // = diabaikan, registrasi tetap jalan normal tanpa bonus.
    let referredBy = null;
    const refCode = (ref || '').trim().toUpperCase();
    if (refCode) {
      const refUser = await one('SELECT id FROM users WHERE referral_code = ?', [refCode]);
      if (refUser) referredBy = refUser.id;
    }
    const hash = await hashPassword(password);
    const now = Date.now();
    const result = await tx(async (t) => {
      const myCode = await generateReferralCode(t);
      const user = await t.run(
        'INSERT INTO users (email, username, pass_hash, referred_by, referral_code, premium_until, is_admin, created_at) VALUES (?,?,?,?,?,?,?,?) RETURNING id',
        [email.toLowerCase(), username, hash, referredBy, myCode, 0, isAdmin, now]);
      // Wilayah awal ACAK dan merata dari semua region yang ada (Tahap 5,
      // perbaikan bug 2026-11-27: sebelumnya hardcode region 1 = Kepulauan
      // Riau, sehingga SEMUA pemain baru lahir di sana). Query mengambil
      // region yang ada saat ini — bila region bertambah/berkurang, peluang
      // tetap merata tanpa hardcode jumlah. region_id dan home_region_id
      // diisi region acak yang sama. Fallback 1 hanya bila tabel regions
      // kosong (tidak pernah terjadi: seed selalu membuat 17 region).
      const startRegion = await t.one('SELECT id, name FROM regions ORDER BY RANDOM() LIMIT 1');
      const startRegionId = startRegion ? startRegion.id : 1;
      const citizen = await t.run(
        `INSERT INTO citizens (user_id, level, xp, energy, energy_updated_at, gold, usd, region_id, home_region_id, home_changed_at, credit_score, credit_updated_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        [user.id, 1, 0, 100, now, 50, 500, startRegionId, startRegionId, 0, 100, now, now]);
      // Paket awal: 3 Makanan T1, 3 Senjata T1, 3 Tiket T1.
      for (const name of ['Makanan', 'Senjata', 'Tiket']) {
        const com = await t.one('SELECT id FROM commodities WHERE name = ?', [name]);
        await addItem(citizen.id, com.id, 1, 3, t);
      }
      await t.run('INSERT INTO notifications (citizen_id, category, title, content, created_at) VALUES (?,?,?,?,?) RETURNING id',
        [citizen.id, 'SISTEM', 'Selamat datang di Parlementer!',
          `Kamu lahir di ${startRegion?.name || 'Kepulauan Riau'}. Dunia ini masih terpecah — belum ada negara. Dirikan negaramu sendiri atau gabung lewat unifikasi. Ambil pasokan harianmu dan cari pekerjaan dari ADMIN untuk modal awal.`, now]);
      if (referredBy) {
        // Bonus TIDAK langsung cair — dicatat sebagai pending; cair saat
        // pendaftar mencapai Level 3 (lihat processReferralPayout).
        await t.run('INSERT INTO referral_pending (referrer_id, newcomer_id, status, created_at) VALUES (?,?,?,?) RETURNING id',
          [referredBy, user.id, 'pending', now]);
      }
      return { userId: user.id, myCode };
    });
    res.cookie(COOKIE_NAME, signToken(result.userId, 0), cookieOptions());
    res.json({ ok: true, user: { id: result.userId, publicId: publicId(result.userId), email: email.toLowerCase(), username, referralCode: result.myCode } });
  }));

  app.post('/api/auth/login', r(async (req, res) => {
    const { email, password } = req.body || {};
    if (!isValidEmail(email) || !password) return res.status(400).json({ error: 'Email dan password wajib diisi.' });
    const user = await one('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!user) return res.status(400).json({ error: 'Email belum terdaftar.' });
    // Password dicek DULU (sebelum status banned) agar status ban tidak bisa
    // ditebak tanpa password. Akun banned TETAP diberi sesi login — tapi
    // hanya untuk membuka layar banned + sistem banding; semua API game
    // diblokir middleware penjaga banned (lihat src/app.js). Tanpa sesi ini,
    // pemain yang ke-ban tidak akan pernah bisa mengajukan banding.
    const ok = await verifyPassword(password, user.pass_hash);
    if (!ok) return res.status(400).json({ error: 'Password salah.' });
    res.cookie(COOKIE_NAME, signToken(user.id, user.token_version || 0), cookieOptions());
    const citizen = await loadCitizen(user.id);
    res.json({
      ok: true,
      banned: !!user.is_banned,
      banned_reason: user.banned_reason || '',
      user: { id: user.id, publicId: publicId(user.id), email: user.email, username: user.username },
      citizen,
    });
  }));

  app.post('/api/auth/logout', r(async (req, res) => {
    // Cabut sesi di semua perangkat: naikkan token_version agar token lama
    // (termasuk yang masih tersimpan di perangkat lain) ditolak authRequired.
    const uid = getUserIdFromReq(req);
    if (uid) {
      try { await run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [uid]); } catch { /* abaikan */ }
    }
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  }));

  app.get('/api/auth/me', authRequired, r(async (req, res) => {
    const citizen = await loadCitizen(req.userId);
    if (!citizen) return res.status(404).json({ error: 'Warga tidak ditemukan.' });
    res.json({
      version: VERSION,
      user: {
        id: citizen.user_id, publicId: publicId(citizen.user_id), email: citizen.email, username: citizen.username,
        avatar: citizen.avatar || null,
        is_admin: !!citizen.is_admin, is_banned: !!citizen.is_banned, banned_reason: citizen.banned_reason || '',
      },
      citizen,
    });
  }));

  // ---------- JUMLAH PEMAIN ONLINE ----------
  // Tanpa websocket: warga dianggap online bila memanggil /api/me dalam
  // 5 menit terakhir (dashboard mem-poll /api/me tiap 30 detik, jadi
  // jendela 5 menit memberi toleransi beberapa poll yang terlewat).
  // Heartbeat ditulis paling cepat 1×/menit/pemain (murah di Postgres).
  // Akun banned tidak dihitung — heartbeat dilewati + filter is_banned.
  // Ambang ONLINE_WINDOW_MS (src/game.js) dipakai juga profil/daftar
  // warga lewat onlineStatus() — satu definisi untuk seluruh game.
  const ONLINE_HEARTBEAT_MS = 60 * 1000;
  async function countOnline() {
    const row = await one(
      `SELECT COUNT(*) AS n FROM citizens c JOIN users u ON u.id = c.user_id
       WHERE c.last_seen_at > ? AND u.is_banned = 0`,
      [Date.now() - ONLINE_WINDOW_MS]);
    return Number(row?.n || 0);
  }

  // ---------- DASHBOARD / WARGA ----------
  app.get('/api/me', authRequired, citizenRequired, r(async (req, res) => {
    const c = req.citizen;
    // Heartbeat online: sentuh last_seen_at bila sudah >60 detik sejak
    // sentuhan terakhir. Gagal heartbeat tidak boleh menggagalkan
    // pembacaan dashboard (pola yang sama seperti regen energi).
    if (!c.is_banned && Date.now() - (c.last_seen_at || 0) > ONLINE_HEARTBEAT_MS) {
      try { await run('UPDATE citizens SET last_seen_at = ? WHERE id = ?', [Date.now(), c.id]); }
      catch (e) { console.error('[online] heartbeat gagal:', e.message); }
    }
    const region = await one('SELECT r.*, c.name AS country_name FROM regions r LEFT JOIN country c ON c.id = r.country_id WHERE r.id = ?', [c.region_id]);
    const country = await getMyCountry({ one }, c);
    // Wilayah asal / kewarganegaraan (27 Nov 2026): bisa berbeda dari
    // region (lokasi saat ini) bila warga sedang berkunjung ke wilayah lain.
    const homeRegion = c.home_region_id ? await one('SELECT r.*, c.name AS country_name FROM regions r LEFT JOIN country c ON c.id = r.country_id WHERE r.id = ?', [c.home_region_id]) : null;
    // Status perjalanan yang sedang berjalan: null bila tidak bepergian.
    // arrivesAt/remainingMs dipakai hitung mundur di UI. Bila jam tiba
    // sudah lewat, settleTravel di loadCitizen sudah menyelesaikan
    // kedatangan — penjaga > Date.now() di sini hanya pengaman.
    const travel = c.travel_to_region_id && c.travel_arrives_at > Date.now()
      ? { toRegionId: c.travel_to_region_id, toRegionName: (await one('SELECT name FROM regions WHERE id = ?', [c.travel_to_region_id]))?.name || '', arrivesAt: c.travel_arrives_at, remainingMs: Math.max(0, c.travel_arrives_at - Date.now()) }
      : null;
    const parliamentOpensAt = await getParliamentOpensAt();
    const party = c.party_id ? await one('SELECT id, name, tag FROM parties WHERE id = ?', [c.party_id]) : null;
    const job = c.job_id ? await one('SELECT j.*, co.name AS company_name FROM jobs j LEFT JOIN companies co ON co.id = j.company_id WHERE j.id = ?', [c.job_id]) : null;
    const unread = await one('SELECT COUNT(*) AS n FROM notifications WHERE citizen_id = ? AND is_read = 0', [c.id]);
    // Lencana 🔔 ikut menghitung pengumuman yang belum dibaca (dulu hanya
    // notifikasi) — kalau tidak, pengumuman baru tidak menyalakan lencana.
    const unreadAnn = await one('SELECT COUNT(*) AS n FROM announcements a WHERE NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.citizen_id = ?)', [c.id]);
    const unreadDm = await one('SELECT COUNT(*) AS n FROM dms WHERE to_id = ? AND is_read = 0', [c.id]);
    const world = await one('SELECT * FROM world WHERE id = 1');
    const population = await one('SELECT COUNT(*) AS n FROM citizens');
    const activeWars = await sql("SELECT w.*, r.name AS region_name FROM wars w JOIN regions r ON r.id = w.region_id WHERE w.status = 'active' ORDER BY w.created_at DESC");
    // UU yang sedang divoting HANYA dari negaraku (redesain dunia).
    // Tanpa negara: tidak ada UU yang bisa divoting.
    const votingLaws = country
      ? await sql("SELECT l.*, u.username AS proposer FROM laws l JOIN citizens c ON c.id = l.proposer_id JOIN users u ON u.id = c.user_id WHERE l.country_id = ? AND l.status = 'voting' AND l.ends_at > ? ORDER BY l.ends_at ASC", [country.id, Date.now()])
      : [];
    const isPremium = c.premium_until > Date.now();
    // Batas energi & biaya latihan yang berlaku SAAT INI (Tahap 4):
    // 100 + 5×(level−1), +20 Premium, +10 Rumah Sakit Lapangan
    // (energyCapFor — satu rumus, dipakai juga eat + tick + regen).
    // Sekolah Keliling memotong biaya latihan 10%. Dashboard memakai angka
    // ini supaya yang ditampilkan sama dengan yang dibebankan server.
    const buildings = await convoyBuildings(c.id);
    const energyCap = energyCapFor(c.level, isPremium, buildings.has('health'));
    // Anggaran latihan (Tahap 5): bila anggaran 'train' sedang berlaku,
    // biaya latihan 10% lebih murah lagi (setelah diskon Sekolah Keliling).
    const budgetTrain = budgetActive(country) === 'train';
    // Event dunia minggu ini (Tahap 6): Wabah Melanda menaikkan biaya
    // latihan +2 emas — ditampilkan di sini supaya sama dengan yang
    // dibebankan POST /api/train.
    const worldEvent = worldEventFor(world?.day || 1);
    const trainCosts = {};
    for (const [key, col] of [['strength', 'attr_str'], ['strategy', 'attr_edu'], ['charisma', 'attr_eco']]) {
      const base = trainCost(c[col]);
      let cost = buildings.has('education') ? trainCostDiscounted(base) : base;
      if (budgetTrain) cost = Math.max(1, Math.round(cost * 0.9));
      if (worldEvent.key === 'wabah') cost += 2;
      trainCosts[key] = cost;
    }
    // Jeda latihan per atribut (2 menit × level, dikurangi 5% per level
    // Pendidikan, maks −50% — Tahap 7): tombol LATIH di dashboard memakai
    // ini supaya tidak perlu request tambahan. Level yang dipakai = level
    // saat ini — sama dengan level baru setelah latih terakhir, karena
    // atribut hanya naik lewat latihan.
    const trainCooldowns = {};
    for (const [key, col, trainCol] of [['strength', 'attr_str', 'train_str_at'], ['strategy', 'attr_edu', 'train_edu_at'], ['charisma', 'attr_eco', 'train_eco_at']]) {
      const cdMs = trainCooldownMs(c[col], c.attr_edu);
      const remainingMs = Math.max(0, (c[trainCol] || 0) + cdMs - Date.now());
      trainCooldowns[key] = { remainingMs, cooldownMs: cdMs, availableAt: remainingMs > 0 ? (c[trainCol] || 0) + cdMs : null };
    }
    const refUses = await one('SELECT COUNT(*) AS n FROM users WHERE referred_by = ?', [c.user_id]);
    const refPaid = await one("SELECT COUNT(*) AS n FROM referral_pending WHERE referrer_id = ? AND status = 'paid'", [c.user_id]);
    const referral = {
      code: c.referral_code,
      uses: Number(refUses.n),
      // goldEarned = bonus yang SUDAH CAIR (Level 3), bukan total pendaftar.
      goldEarned: Number(refPaid.n) * 200,
    };
    // Militer (Tahap 6): unit + kekuatan + pengali kerusakan + perawatan
    // harian — dipakai dashboard + halaman perang.
    const myUnits = await militaryUnitsOf(c.id);
    const myPower = militaryPowerFor(myUnits);
    const military = {
      units: myUnits, power: myPower,
      mult: Math.round(unitDamageMult(myPower) * 100) / 100,
      upkeep: unitUpkeepFor(myUnits), count: unitCountFor(myUnits),
      defs: MILITARY_UNITS,
    };
    res.json({
      version: VERSION,
      user: {
        id: c.user_id, publicId: publicId(c.user_id), email: c.email, username: c.username,
        avatar: c.avatar || null,
        is_admin: !!c.is_admin, is_banned: !!c.is_banned, banned_reason: c.banned_reason || '',
      },
      citizen: { ...c, isPremium, energyCap, trainCosts, trainCooldowns, breadLimit: breadLimitFor(isPremium) },
      // Kredit skor (v3.0.0): skor + tier + batasan yang berlaku — dipakai
      // dashboard untuk panel skor (satu sumber angka dari game.js).
      credit: creditInfo(c.credit_score),
      military,
      // Event dunia minggu ini (Tahap 6) + reputasi dagang (Tahap 6).
      worldEvent,
      tradeReputation: tradeReputation(c.trades_completed || 0),
      referral,
      region, homeRegion: homeRegion ? { id: homeRegion.id, name: homeRegion.name, type: homeRegion.type, country_id: homeRegion.country_id, country_name: homeRegion.country_name } : null,
      travel, country: countrySummary(country),
      // Parlemen: status buka + tanggal buka (untuk countdown di HUD).
      parliamentOpen: Date.now() >= parliamentOpensAt,
      parliamentOpensAt,
      party, job,
      unread: Number(unread.n) + Number(unreadAnn.n), unreadDm: Number(unreadDm.n),
      world, population: Number(population.n), onlineCount: await countOnline(),
      activeWars, votingLaws,
      xpNext: xpForLevel(c.level),
      // Iklan berhadiah (v4.4.0): klien perlu tahu apakah AdinPlay aktif +
      // hadiah per iklan — Property ID bukan rahasia (tampil di sumber
      // halaman di semua integrasi AdinPlay), jadi aman dikirim ke klien.
      ads: { enabled: ADINPLAY_PROPERTY_ID !== '', propertyId: ADINPLAY_PROPERTY_ID, rewardGold: AD_REWARD_GOLD },
      // Kerja otomatis 24 jam (v4.5.0): status untuk toggle di halaman
      // Pekerjaan — aktif/mati, akhir masa aktif, jumlah shift otomatis,
      // sedang dijeda (kelelahan) atau tidak, jam shift terakhir.
      autoWork: {
        active: (c.auto_work_until || 0) > Date.now(),
        until: c.auto_work_until || 0,
        shifts: c.auto_work_shifts || 0,
        paused: !!(c.auto_work_paused),
        lastAt: c.auto_work_last_at || 0,
      },
    });
  }));

  app.post('/api/claim', authRequired, citizenRequired, r(async (req, res) => {
    const today = todayStr();
    // Atomik: kunci baris warga + UPDATE bersyarat (last_claim_date <> hari
    // ini) + cek changes — dua request paralel, hanya satu yang berhasil.
    // Anggaran pasokan (Tahap 5): bila anggaran 'claim' sedang berlaku,
    // klaim harian memberi +2 emas tambahan. Ideologi Sosialisme: +2 emas
    // juga — TIDAK menumpuk dengan anggaran (maksimal +2 total).
    const locked = await tx(async (t) => {
      const row = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      if (row.last_claim_date === today) throw Object.assign(new Error('Pasokan hari ini sudah diambil. Kembali besok.'), { status: 400 });
      const country = await getMyCountry(t, row);
      const budgetBonus = budgetActive(country) === 'claim' ? 2 : 0;
      const ideologyBonus = ideologyDef(country?.ideology).claimBonus;
      const bonus = Math.max(budgetBonus, ideologyBonus);
      const upd = await t.run('UPDATE citizens SET gold = gold + ?, usd = usd + ?, last_claim_date = ? WHERE id = ? AND last_claim_date <> ?', [DAILY_CLAIM.gold + bonus, DAILY_CLAIM.usd, today, req.citizen.id, today]);
      if (!upd.changes) throw Object.assign(new Error('Pasokan hari ini sudah diambil. Kembali besok.'), { status: 400 });
      return { row, bonus };
    });
    await addXp(locked.row, DAILY_CLAIM.xp);
    await chronicleDone(locked.row, 'claim');
    res.json({ ok: true, reward: { gold: DAILY_CLAIM.gold + locked.bonus, usd: DAILY_CLAIM.usd, xp: DAILY_CLAIM.xp }, budgetBonus: locked.bonus > 0 });
  }));

  // ---------- IKLAN BERHADIAH (AdinPlay, v4.4.0) ----------
  // Alur: klien minta token tontonan (POST /api/ads/start) → video AdinPlay
  // diputar → bila selesai (callback AIP_REWARDEDGRANTED), klien panggil
  // POST /api/ads/reward dengan token itu. Hadiah TIDAK PERNAH diberikan
  // tanpa token server yang valid — callback klien mentah-mentah tidak
  // dipercaya (bisa dipalsukan dari console). Token: acak 256-bit, berlaku
  // 5 menit, satu kali pakai. Jeda minimum 30 detik antar grant per pemain
  // (anti-skrip). TANPA batas harian (perintah pemilik 28 Nov 2026).
  // Bila AdinPlay belum aktif (property ID kosong), /start menolak 503 —
  // klien menampilkan "segera hadir" dan tidak ada hadiah apa pun.
  app.post('/api/ads/start', authRequired, citizenRequired, r(async (req, res) => {
    if (!ADINPLAY_PROPERTY_ID) return res.status(503).json({ error: 'Iklan berhadiah belum aktif. Tunggu aktivasi dari admin.' });
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + AD_TOKEN_TTL_MS;
    await run('INSERT INTO ad_tokens (token, citizen_id, expires_at, used_at) VALUES (?,?,?,NULL)', [token, req.citizen.id, expiresAt]);
    res.json({ ok: true, token, expiresAt });
  }));

  app.post('/api/ads/reward', authRequired, citizenRequired, r(async (req, res) => {
    const { token } = req.body || {};
    if (!token || typeof token !== 'string') return res.status(400).json({ error: 'Token tontonan tidak valid.' });
    const now = Date.now();
    const result = await tx(async (t) => {
      const row = await t.one(forUpdate('SELECT * FROM ad_tokens WHERE token = ?'), [token]);
      if (!row || Number(row.citizen_id) !== req.citizen.id) throw Object.assign(new Error('Token tontonan tidak valid.'), { status: 400 });
      if (row.used_at) throw Object.assign(new Error('Token sudah dipakai.'), { status: 400 });
      if (Number(row.expires_at) <= now) throw Object.assign(new Error('Token sudah kedaluwarsa. Tonton iklan lagi.'), { status: 400 });
      // Jeda minimum antar grant (anti-skrip): 30 detik sejak grant terakhir.
      const last = await t.one('SELECT granted_at FROM ad_rewards WHERE citizen_id = ? ORDER BY granted_at DESC LIMIT 1', [req.citizen.id]);
      if (last && now - Number(last.granted_at) < AD_MIN_INTERVAL_MS) throw Object.assign(new Error('Terlalu cepat. Tunggu sebentar sebelum menonton lagi.'), { status: 400 });
      // Tandai token terpakai + beri emas + catat audit — atomik: UPDATE
      // bersyarat (used_at IS NULL) + cek changes membuat dua request
      // paralel dengan token yang sama hanya satu yang berhasil.
      const upd = await t.run('UPDATE ad_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL', [now, token]);
      if (!upd.changes) throw Object.assign(new Error('Token sudah dipakai.'), { status: 400 });
      await t.run('UPDATE citizens SET gold = gold + ? WHERE id = ?', [AD_REWARD_GOLD, req.citizen.id]);
      await t.run('INSERT INTO ad_rewards (citizen_id, gold, granted_at) VALUES (?,?,?)', [req.citizen.id, AD_REWARD_GOLD, now]);
      return { gold: AD_REWARD_GOLD };
    });
    res.json({ ok: true, reward: { gold: result.gold } });
  }));

  // ---------- LINK SHARE HARIAN (v4.6.0, perintah pemilik 28 Nov 2026) ----------
  // Tiap warga punya link pribadi stabil /s/<kode> (kode acak 10 karakter,
  // dibuat malas saat pertama kali membuka halaman Bagikan Link). Link
  // untuk PUBLIK: siapa pun bisa klik TANPA login/tanpa akun — kliknya
  // tetap terhitung untuk pemilik link. Yang butuh akun hanya pemilik
  // (untuk menerima emas + melihat statistik).
  // Anti-fraud: 1 IP = 1 klik terhitung per hari per link (UNIQUE
  // (owner_id, ip, day) di share_clicks); +10 emas per klik terhitung,
  // maks 200 emas/hari (= 20 klik unik/hari) per pemilik. Hari memakai
  // todayStr() (UTC) — sama seperti klaim harian. Emas diberikan atomik
  // HANYA bila klik terhitung (IP baru hari itu + kuota belum habis);
  // klik duplikat-IP / di luar kuota tetap TERCATAT (gold_given 0) untuk
  // audit, tapi tidak menambah emas. Klik dari pemilik link sendiri
  // TIDAK dihitung bila terdeteksi (sesi login = pemilik) — klik tanpa
  // login dari IP yang sama dengan IP pemilik tidak bisa dibedakan dari
  // klik orang lain di belakang NAT yang sama, jadi batasannya jujur:
  // tanpa login, satu IP hanya bisa memberi +10/hari ke satu link, dan
  // kuota 200/hari tetap butuh 20 IP berbeda. TIDAK ADA kaitannya dengan
  // sistem referral (hadiah referral cair saat pendaftar Level 3 — jalur
  // terpisah, tidak disentuh).
  async function ensureShareCode(citizenId) {
    const row = await one('SELECT share_code FROM citizens WHERE id = ?', [citizenId]);
    if (row?.share_code) return row.share_code;
    for (let attempt = 0; attempt < 5; attempt++) {
      const bytes = crypto.randomBytes(10);
      let code = '';
      for (const b of bytes) code += SHARE_CODE_CHARS[b % SHARE_CODE_CHARS.length];
      const upd = await run('UPDATE citizens SET share_code = ? WHERE id = ? AND share_code IS NULL', [code, citizenId]);
      if (upd.changes) return code;
      const again = await one('SELECT share_code FROM citizens WHERE id = ?', [citizenId]);
      if (again?.share_code) return again.share_code;
    }
    throw Object.assign(new Error('Gagal membuat kode share. Coba lagi.'), { status: 500 });
  }
  // Statistik share SATU warga (satu sumber kebenaran — dipakai GET
  // /api/share DAN GET /api/admin/share): klik terhitung = baris
  // share_clicks dengan gold_given > 0; emas = klik × 10. Klik dengan
  // gold_given 0 (kuota habis) TERCATAT tapi tidak terhitung.
  async function shareStatsFor(ownerId, day) {
    const rows = await sql(
      `SELECT COUNT(*) AS n, COALESCE(SUM(gold_given), 0) AS gold FROM share_clicks
       WHERE owner_id = ? AND gold_given > 0 AND (? IS NULL OR day = ?)`,
      [ownerId, day, day]);
    const total = rows[0] || { n: 0, gold: 0 };
    return { clicks: Number(total.n), gold: Number(total.gold) };
  }

  // Statistik share untuk pemilik link: kode + link + hari ini + total.
  app.get('/api/share', authRequired, citizenRequired, r(async (req, res) => {
    const code = await ensureShareCode(req.citizen.id);
    const day = todayStr();
    const today = await shareStatsFor(req.citizen.id, day);
    const total = await shareStatsFor(req.citizen.id, null);
    res.json({
      ok: true,
      code,
      today: { clicks: today.clicks, gold: today.gold, remaining: Math.max(0, SHARE_MAX_GOLD_PER_DAY - today.gold), cap: SHARE_MAX_GOLD_PER_DAY },
      total: { clicks: total.clicks, gold: total.gold },
      perClick: SHARE_GOLD_PER_CLICK,
      maxClicksPerDay: SHARE_MAX_CLICKS_PER_DAY,
    });
  }));

  // Klik link share — PUBLIK, tanpa login. Mencatat klik lalu redirect
  // ke landing (/). Kode salah → 404 tanpa emas. Klik pemilik sendiri
  // (terdeteksi lewat sesi login) → redirect tanpa mencatat. Duplikat IP
  // di hari yang sama → redirect tanpa emas tambahan. Kuota 200/hari
  // habis → klik tetap tercatat (gold 0), tanpa emas.
  app.get('/s/:code', r(async (req, res) => {
    const code = String(req.params.code || '').trim();
    const owner = code ? await one('SELECT id, user_id FROM citizens WHERE share_code = ?', [code]) : null;
    if (!owner) return res.status(404).send('Link tidak ditemukan.');
    // Klik sendiri: sesi login milik pemilik link → jangan hitung.
    const uid = getUserIdFromReq(req);
    if (uid && Number(uid) === Number(owner.user_id)) return res.redirect('/');
    const ip = (req.ip || 'unknown').slice(0, 45);
    const day = todayStr();
    await tx(async (t) => {
      await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [owner.id]);
      const counted = await t.one(
        'SELECT COUNT(*) AS n FROM share_clicks WHERE owner_id = ? AND day = ? AND gold_given > 0',
        [owner.id, day]);
      const gold = Number(counted.n) < SHARE_MAX_CLICKS_PER_DAY ? SHARE_GOLD_PER_CLICK : 0;
      const insertSql = isPg
        ? 'INSERT INTO share_clicks (owner_id, ip, day, gold_given, created_at) VALUES (?,?,?,?,?) ON CONFLICT (owner_id, ip, day) DO NOTHING'
        : 'INSERT OR IGNORE INTO share_clicks (owner_id, ip, day, gold_given, created_at) VALUES (?,?,?,?,?)';
      const ins = await t.run(insertSql, [owner.id, ip, day, gold, Date.now()]);
      if (ins.changes && gold > 0) {
        await t.run('UPDATE citizens SET gold = gold + ? WHERE id = ?', [gold, owner.id]);
      }
    });
    return res.redirect('/');
  }));

  app.post('/api/train', authRequired, citizenRequired, r(async (req, res) => {
    const { attr } = req.body || {};
    if (!['str', 'edu', 'eco'].includes(attr)) return res.status(400).json({ error: 'Atribut tidak dikenal.' });
    const col = attr === 'str' ? 'attr_str' : attr === 'edu' ? 'attr_edu' : 'attr_eco';
    const trainCol = attr === 'str' ? 'train_str_at' : attr === 'edu' ? 'train_edu_at' : 'train_eco_at';
    const attrLabel = attr === 'str' ? 'Kekuatan' : attr === 'edu' ? 'Pendidikan' : 'Ekonomi';
    // Atomik: kunci baris warga + UPDATE bersyarat (gold >= biaya) + cek
    // changes — biaya tidak pernah terpotong dua kali dari saldo yang sama.
    const now = Date.now();
    const done = await tx(async (t) => {
      const row = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      // Jeda latihan (2 menit × level atribut saat ini = level baru
      // setelah latih terakhir): atribut ini tidak bisa dilatih lagi
      // sampai jedanya habis. Atribut lain tidak ikut terkunci. Kunci
      // baris (FOR UPDATE) membuat dua request paralel berurutan — yang
      // kedua membaca train_*_at yang baru ditulis yang pertama, lalu
      // ditolak 400.
      const cdMs = trainCooldownMs(row[col], row.attr_edu);
      const remainingMs = (row[trainCol] || 0) + cdMs - now;
      if (remainingMs > 0) throw Object.assign(new Error(`Latihan ${attrLabel} masih jeda. Coba lagi dalam ${formatCooldownMs(remainingMs)}.`), { status: 400 });
      // Bonus konvoi (Tahap 3, BUG-7): Sekolah Keliling aktif -> latihan
      // 10% lebih murah (minimal 1 emas). Biaya yang ditampilkan di
      // dashboard memakai angka yang sama (lihat /api/me: trainCosts).
      // Anggaran latihan (Tahap 5): anggaran 'train' yang berlaku memotong
      // 10% lagi (setelah diskon konvoi), minimal 1 emas.
      const buildings = await convoyBuildings(req.citizen.id, t);
      const baseCost = trainCost(row[col]);
      let cost = buildings.has('education') ? trainCostDiscounted(baseCost) : baseCost;
      const country = await getMyCountry(t, row);
      if (budgetActive(country) === 'train') cost = Math.max(1, Math.round(cost * 0.9));
      // Event dunia (Tahap 6): Wabah Melanda -> biaya latihan +2 emas.
      const wday = await getWorldDay(t);
      if (worldEventFor(wday).key === 'wabah') cost += 2;
      const upd = await t.run(`UPDATE citizens SET gold = gold - ?, ${col} = ${col} + 1, ${trainCol} = ? WHERE id = ? AND gold >= ?`, [cost, now, req.citizen.id, cost]);
      if (!upd.changes) throw Object.assign(new Error(`Butuh ${cost} emas untuk latihan ini.`), { status: 400 });
      return { row, cost };
    });
    await addXp(done.row, 20);
    await chronicleDone(done.row, 'train');
    const newLevel = done.row[col] + 1;
    // Jeda setelah latihan memakai Pendidikan SETELAH latihan ini (bila
    // yang dilatih adalah Pendidikan, level barunya yang berlaku).
    const eduAfter = attr === 'edu' ? done.row.attr_edu + 1 : done.row.attr_edu;
    const cooldownMs = trainCooldownMs(newLevel, eduAfter);
    res.json({ ok: true, cost: done.cost, level: newLevel, cooldownMs, availableAt: now + cooldownMs });
  }));

  app.post('/api/eat', authRequired, citizenRequired, r(async (req, res) => {
    const { tier } = req.body || {};
    const t = Math.max(1, Math.min(5, Number(tier) || 1));
    const food = await one('SELECT id FROM commodities WHERE name = ?', ['Makanan']);
    // (v4.5.0, perbaikan bug roti Premium): premium_until HANYA ada di
    // tabel users — baris `locked` (SELECT * FROM citizens) TIDAK
    // pernah punya kolom itu, jadi cap lama selalu tanpa bonus +20.
    // Status Premium diambil dari req.citizen (loadCitizen JOIN users).
    const isPremium = (req.citizen.premium_until || 0) > Date.now();
    const limit = breadLimitFor(isPremium);
    const result = await tx(async (tx) => {
      const locked = await tx.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      if (locked.bread_today >= limit) throw Object.assign(new Error(`Jatah roti harian (${limit}) sudah habis.`), { status: 400 });
      const ok = await takeItem(locked.id, food.id, t, 1, tx);
      if (!ok) throw Object.assign(new Error(`Tidak ada Makanan T${t} di inventaris.`), { status: 400 });
      const gain = foodEnergy(t);
      // Batas energi (Tahap 4): energyCapFor — 100 + 5×(level−1), +20
      // Premium, +10 RS Lapangan. Selaras dengan /api/me dan tick harian.
      const buildings = await convoyBuildings(locked.id, tx);
      const cap = energyCapFor(locked.level, isPremium, buildings.has('health'));
      const energy = Math.min(cap, locked.energy + gain);
      const upd = await tx.run('UPDATE citizens SET energy = ?, bread_today = bread_today + 1 WHERE id = ? AND bread_today < ?', [energy, locked.id, limit]);
      if (!upd.changes) throw Object.assign(new Error(`Jatah roti harian (${limit}) sudah habis.`), { status: 400 });
      // `gained` = SELISIH energi nyata (bukan nominal): bila energi
      // sudah di cap, roti tetap terpotong tapi gained = 0 — toast tidak
      // boleh lagi berbohong "Energi +10".
      return { energy, gained: energy - locked.energy, locked };
    });
    // (Tahap 7) Tulis misi 'bread' ke JSON dihapus — tulis itu mati: progres
    // roti dibaca dari bread_today (sudah +1 di UPDATE di atas). Kolom
    // JSON-nya sudah dihapus.
    await chronicleDone(result.locked, 'eat');
    res.json({ ok: true, energy: result.energy, gained: result.gained });
  }));

  // ---------- MINUMAN ENERGI (tiket #17 LIO, v3.1.0) ----------
  // Kaleng Minuman Energi: beli di Inventaris 0,10 emas/kaleng, sekali
  // minum +1 energi (dibatasi cap energi pemain). Beli: emas dipotong
  // atomik (UPDATE bersyarat + cek changes); minum: kaleng diambil dari
  // inventaris + energi naik, tidak melebihi cap.
  app.post('/api/shop/energy-drink', authRequired, citizenRequired, r(async (req, res) => {
    const rawQty = Number((req.body || {}).qty);
    if (!Number.isInteger(rawQty) || rawQty < 1 || rawQty > 100) return res.status(400).json({ error: 'Jumlah 1–100 kaleng.' });
    const qty = rawQty;
    const cost = Math.round(ENERGY_DRINK_PRICE_GOLD * qty * 100) / 100;
    const drink = await one('SELECT id FROM commodities WHERE name = ?', [ENERGY_DRINK_NAME]);
    if (!drink) return res.status(500).json({ error: 'Minuman Energi belum tersedia.' });
    const bought = await tx(async (t) => {
      const upd = await t.run('UPDATE citizens SET gold = gold - ? WHERE id = ? AND gold >= ?', [cost, req.citizen.id, cost]);
      if (!upd.changes) throw Object.assign(new Error(`Butuh ${cost} emas untuk ${qty} kaleng Minuman Energi.`), { status: 400 });
      await addItem(req.citizen.id, drink.id, 1, qty, t);
      return qty;
    });
    res.json({ ok: true, qty: bought, cost, priceEach: ENERGY_DRINK_PRICE_GOLD });
  }));

  // MINUM SEKALIGUS (v4.6.0, saran LIO): bila qty TIDAK dikirim, minum
  // sampai energi penuh (atau sampai kaleng habis) dalam satu tekan —
  // bukan satu kaleng per tekan. qty eksplisit (1–100) tetap didukung
  // untuk kompatibilitas lama. Kaleng yang tidak terminum tetap di
  // inventaris (tidak ada yang hilang); energi penuh → 400 tanpa kaleng
  // terpotong.
  app.post('/api/inventory/drink', authRequired, citizenRequired, r(async (req, res) => {
    const rawQty = (req.body || {}).qty;
    const qtyGiven = rawQty !== undefined && rawQty !== null;
    if (qtyGiven && (!Number.isInteger(Number(rawQty)) || Number(rawQty) < 1 || Number(rawQty) > 100)) return res.status(400).json({ error: 'Jumlah 1–100 kaleng.' });
    const qty = qtyGiven ? Number(rawQty) : Infinity;
    const drink = await one('SELECT id FROM commodities WHERE name = ?', [ENERGY_DRINK_NAME]);
    if (!drink) return res.status(500).json({ error: 'Minuman Energi belum tersedia.' });
    const result = await tx(async (t) => {
      const locked = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      const buildings = await convoyBuildings(locked.id, t);
      // (v4.5.0, perbaikan bug roti Premium — sama seperti /api/eat):
      // premium_until hanya ada di users; status Premium dari req.citizen.
      const cap = energyCapFor(locked.level, (req.citizen.premium_until || 0) > Date.now(), buildings.has('health'));
      const room = cap - locked.energy;
      if (room <= 0) throw Object.assign(new Error('Energi sudah penuh.'), { status: 400 });
      const stock = await t.one('SELECT * FROM inventory WHERE citizen_id = ? AND commodity_id = ? AND tier = 1', [locked.id, drink.id]);
      const have = stock?.qty || 0;
      if (have <= 0) throw Object.assign(new Error('Tidak ada Minuman Energi di inventaris. Beli dulu di bawah.'), { status: 400 });
      const drinkQty = Math.min(qty, have, room);
      const ok = await takeItem(locked.id, drink.id, 1, drinkQty, t);
      if (!ok) throw Object.assign(new Error('Tidak ada Minuman Energi di inventaris.'), { status: 400 });
      const energy = locked.energy + drinkQty * ENERGY_DRINK_ENERGY;
      await t.run('UPDATE citizens SET energy = ? WHERE id = ?', [energy, locked.id]);
      return { energy, gained: drinkQty * ENERGY_DRINK_ENERGY, drank: drinkQty, remaining: have - drinkQty, cap };
    });
    res.json({ ok: true, ...result });
  }));

  // ---------- MISI HARIAN ----------
  app.get('/api/missions', authRequired, citizenRequired, r(async (req, res) => {
    const c = req.citizen;
    // (Tahap 7) Progres 'chat' + daftar klaim dibaca dari tabel relasional;
    // 'energy'/'bread' dibaca dari kolom citizens (sumber kebenarannya).
    const chat = await missionValue(null, c.id, 'chat');
    const claimed = await missionClaimedKeys(null, c.id);
    res.json({
      missions: DAILY_MISSIONS.map((d) => ({
        ...d,
        progress: d.key === 'energy' ? (c.energy_spent_today || 0) : d.key === 'bread' ? (c.bread_today || 0) : chat,
        claimed: claimed.includes(d.key),
      })),
    });
  }));

  app.post('/api/missions/claim', authRequired, citizenRequired, r(async (req, res) => {
    const { key } = req.body || {};
    const d = DAILY_MISSIONS.find((x) => x.key === key);
    if (!d) return res.status(400).json({ error: 'Misi tidak dikenal.' });
    // Atomik: kunci baris warga, baca progres segar, klaim sekali saja.
    await tx(async (t) => {
      const c = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      const chat = await missionValue(t, c.id, 'chat');
      const progress = key === 'energy' ? (c.energy_spent_today || 0) : key === 'bread' ? (c.bread_today || 0) : chat;
      if (progress < d.target) throw Object.assign(new Error('Misi belum selesai.'), { status: 400 });
      const claimed = await missionClaimedKeys(t, c.id);
      if (claimed.includes(key)) throw Object.assign(new Error('Hadiah misi ini sudah diklaim.'), { status: 400 });
      await insertMissionClaim(t, c.id, key);
      await t.run('UPDATE citizens SET gold = gold + ? WHERE id = ?', [d.reward, c.id]);
    });
    res.json({ ok: true, reward: d.reward });
  }));

  // ---------- KRONIK ----------
  app.get('/api/chronicle', authRequired, citizenRequired, r(async (req, res) => {
    const c = req.citizen;
    const done = await chronicleDoneKeys(null, c.id);
    const claimed = await chronicleClaimedChapters(null, c.id);
    res.json({
      chapters: CHRONICLE.map((ch) => ({
        ...ch,
        done: ch.tasks.filter((t) => done.includes(t.key)).length,
        total: ch.tasks.length,
        claimed: claimed.includes(ch.chapter),
        tasks: ch.tasks.map((t) => ({ ...t, done: done.includes(t.key) })),
      })),
    });
  }));

  app.post('/api/chronicle/claim', authRequired, citizenRequired, r(async (req, res) => {
    const { chapter } = req.body || {};
    const ch = CHRONICLE.find((x) => x.chapter === Number(chapter));
    if (!ch) return res.status(400).json({ error: 'Babak tidak dikenal.' });
    // Atomik: kunci baris warga, baca done/claimed segar, klaim sekali saja.
    await tx(async (t) => {
      const c = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      const done = await chronicleDoneKeys(t, c.id);
      const claimed = await chronicleClaimedChapters(t, c.id);
      if (!ch.tasks.every((t2) => done.includes(t2.key))) throw Object.assign(new Error('Masih ada tugas yang belum selesai di babak ini.'), { status: 400 });
      if (claimed.includes(ch.chapter)) throw Object.assign(new Error('Hadiah babak ini sudah diklaim.'), { status: 400 });
      await insertChronicleClaim(t, c.id, ch.chapter);
      await t.run('UPDATE citizens SET gold = gold + ? WHERE id = ?', [ch.reward, c.id]);
    });
    res.json({ ok: true, reward: ch.reward });
  }));

  // Kunjungan peta (v2.5.0): menandai tugas kronik 'map' selesai. Hanya
  // kunci yang dikenal yang diterima; idempotent (chronicleDone sudah
  // memeriksa duplikat).
  app.post('/api/chronicle/visit', authRequired, citizenRequired, r(async (req, res) => {
    const { key } = req.body || {};
    if (key !== 'map') return res.status(400).json({ error: 'Kunjungan tidak dikenal.' });
    await chronicleDone(req.citizen, 'map');
    res.json({ ok: true });
  }));

  // ---------- PETA: koordinat ibu kota + kunjungan kronik ----------
  // /api/regions menyertakan coords (REGION_COORDS) supaya peta besar di
  // klien bisa menaruh penanda KAMU + label di posisi geografis nyata.
  // POST /api/chronicle/visit menandai tugas kronik 'map' (Jelajahi peta)
  // saat pemain membuka peta besar — sebelumnya tugas ini tidak pernah
  // ditandai selesai oleh endpoint mana pun.

  // ---------- INVENTARIS ----------
  app.get('/api/inventory', authRequired, citizenRequired, r(async (req, res) => {
    const rows = await sql(
      `SELECT i.*, c.name, c.category, c.ref_usd, c.ref_gold FROM inventory i
       JOIN commodities c ON c.id = i.commodity_id WHERE i.citizen_id = ? AND i.qty > 0 ORDER BY c.name, i.tier`,
      [req.citizen.id]);
    const value = rows.reduce((s, x) => s + x.qty * x.ref_usd, 0);
    res.json({ items: rows, totalQty: rows.reduce((s, x) => s + x.qty, 0), marketValue: value });
  }));

  // ---------- PENCAPAIAN ----------
  app.get('/api/achievements', authRequired, citizenRequired, r(async (req, res) => {
    const c = req.citizen;
    const claimed = await sql('SELECT akey FROM achievements WHERE citizen_id = ? AND claimed = 1', [c.id]);
    const claimedSet = new Set(claimed.map((x) => x.akey));
    res.json({
      achievements: ACHIEVEMENTS.map((a) => ({
        ...a,
        progress: achievementProgress(c, a.key),
        claimed: claimedSet.has(a.key),
        ready: achievementProgress(c, a.key) >= a.target && !claimedSet.has(a.key),
      })),
      totalGold: ACHIEVEMENTS.reduce((s, a) => s + a.reward, 0),
    });
  }));

  app.post('/api/achievements/claim', authRequired, citizenRequired, r(async (req, res) => {
    const { key } = req.body || {};
    const a = ACHIEVEMENTS.find((x) => x.key === key);
    if (!a) return res.status(400).json({ error: 'Pencapaian tidak dikenal.' });
    // Atomik (BUG-3): kunci baris warga + INSERT ... ON CONFLICT DO NOTHING
    // — dua klaim paralel hanya satu yang mengembalikan baris (changes=1).
    await tx(async (t) => {
      const c = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      if (achievementProgress(c, key) < a.target) throw Object.assign(new Error('Pencapaian belum tercapai.'), { status: 400 });
      const ins = await t.run('INSERT INTO achievements (citizen_id, akey, claimed) VALUES (?,?,1) ON CONFLICT (citizen_id, akey) DO NOTHING RETURNING citizen_id', [c.id, key]);
      if (!ins.changes) throw Object.assign(new Error('Hadiah sudah diklaim.'), { status: 400 });
      await t.run('UPDATE citizens SET gold = gold + ? WHERE id = ?', [a.reward, c.id]);
    });
    res.json({ ok: true, reward: a.reward });
  }));

  // ---------- AKTIVITAS SAYA (Tahap 3, §7) ----------
  // Riwayat transaksi pasar + aktivitas/pemberitahuan warga. FX tidak punya
  // tautan warga di fx_history (hanya harga), jadi riwayat FX tidak tampil.
  app.get('/api/activity', authRequired, citizenRequired, r(async (req, res) => {
    const transactions = await sql(
      `SELECT t.*, c.name AS commodity_name,
        CASE WHEN t.buyer_id = ? THEN 'beli' ELSE 'jual' END AS direction
       FROM market_tx t JOIN commodities c ON c.id = t.commodity_id
       WHERE t.buyer_id = ? OR t.seller_id = ?
       ORDER BY t.created_at DESC LIMIT 50`,
      [req.citizen.id, req.citizen.id, req.citizen.id]);
    const events = await sql(
      'SELECT * FROM notifications WHERE citizen_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.citizen.id]);
    res.json({ transactions, events });
  }));

  // ---------- NOTIFIKASI ----------
  app.get('/api/notifications', authRequired, citizenRequired, r(async (req, res) => {
    const rows = await sql('SELECT * FROM notifications WHERE citizen_id = ? ORDER BY created_at DESC LIMIT 50', [req.citizen.id]);
    res.json({ notifications: rows });
  }));
  app.post('/api/notifications/read', authRequired, citizenRequired, r(async (req, res) => {
    await run('UPDATE notifications SET is_read = 1 WHERE citizen_id = ?', [req.citizen.id]);
    res.json({ ok: true });
  }));

  // ---------- PENGUMUMAN UPDATE ("Apa yang Baru", Tahap 4) ----------
  // Nomor update stabil = urutan created_at menaik (Update #1 = yang
  // pertama diterbitkan). Diambil dari tabel announcements, bukan hardcode.
  function numberAnnouncements(rows) {
    const asc = [...rows].sort((a, b) => a.created_at - b.created_at || a.id - b.id);
    const num = new Map(asc.map((a, i) => [a.id, i + 1]));
    return rows.map((a) => ({ ...a, num: num.get(a.id) }));
  }
  app.get('/api/announcements', authRequired, citizenRequired, r(async (req, res) => {
    const rows = await sql('SELECT * FROM announcements ORDER BY created_at DESC, id DESC');
    const reads = await sql('SELECT announcement_id FROM announcement_reads WHERE citizen_id = ?', [req.citizen.id]);
    const readSet = new Set(reads.map((x) => x.announcement_id));
    const list = numberAnnouncements(rows).map((a) => ({ ...a, read: readSet.has(a.id) }));
    res.json({ announcements: list, unreadCount: list.filter((a) => !a.read).length });
  }));
  app.post('/api/announcements/read', authRequired, citizenRequired, r(async (req, res) => {
    const { id, all } = req.body || {};
    const now = Date.now();
    if (all) {
      const rows = await sql('SELECT id FROM announcements');
      for (const a of rows) {
        await run('INSERT INTO announcement_reads (announcement_id, citizen_id, read_at) VALUES (?,?,?) ON CONFLICT (announcement_id, citizen_id) DO NOTHING',
          [a.id, req.citizen.id, now]);
      }
    } else if (id) {
      const a = await one('SELECT id FROM announcements WHERE id = ?', [Number(id)]);
      if (!a) return res.status(404).json({ error: 'Pengumuman tidak ditemukan.' });
      await run('INSERT INTO announcement_reads (announcement_id, citizen_id, read_at) VALUES (?,?,?) ON CONFLICT (announcement_id, citizen_id) DO NOTHING',
        [a.id, req.citizen.id, now]);
    } else {
      return res.status(400).json({ error: 'id atau all wajib diisi.' });
    }
    res.json({ ok: true });
  }));

  // ---------- PROFIL ----------
  // Pencarian nama: cocok persis dulu; bila tidak ada, fallback tak peka
  // huruf besar/kecil. Nama tampil selalu huruf besar (CSS
  // .profile-hero-name uppercase), jadi pemain yang membuka
  // #/profile/NAMA-KAPITAL harus tetap menemukan warga yang namanya
  // tersimpan campuran huruf — sebelumnya `=` peka huruf bisa 404.
  app.get('/api/profile/:username', authRequired, r(async (req, res) => {
    // Kolom eksplisit (bukan `c.*`): `id` ada di users DAN citizens —
    // `SELECT *` membuat `u.id` ambigu (driver menyimpan kolom terakhir).
    const q = `SELECT c.id AS citizen_id, u.id AS user_id, u.username, u.avatar, u.premium_until, u.referral_code, u.is_banned,
      c.level, c.xp, c.bio, c.shifts, c.total_salary, c.total_damage, c.attacks, c.frontline_attacks,
      c.attr_str, c.attr_edu, c.attr_eco, c.created_at, c.last_seen_at, c.party_id, c.home_region_id, c.credit_score, c.credit_updated_at, c.trades_completed
      FROM users u JOIN citizens c ON c.user_id = u.id WHERE `;
    let u = await one(q + 'u.username = ?', [req.params.username]);
    if (!u) u = await one(q + 'LOWER(u.username) = LOWER(?)', [req.params.username]);
    if (!u) return res.status(404).json({ error: 'Warga tidak ditemukan.' });
    // Profil menunjukkan wilayah ASAL (kewarganegaraan, home_region_id) —
    // bukan lokasi kunjungan saat ini.
    const region = await one('SELECT r.name, c.name AS country_name FROM regions r LEFT JOIN country c ON c.id = r.country_id WHERE r.id = ?', [u.home_region_id]);
    const party = u.party_id ? await one('SELECT name, tag FROM parties WHERE id = ?', [u.party_id]) : null;
    const companies = await sql('SELECT id, name, type FROM companies WHERE owner_id = ?', [u.citizen_id]);
    const articles = await sql('SELECT id, title, created_at FROM articles WHERE author_id = ? ORDER BY created_at DESC LIMIT 5', [u.citizen_id]);
    // Statistik referral hanya untuk pemilik profil sendiri.
    let referral = null;
    let referralCode = null;
    if (req.userId === u.user_id) {
      const uses = await one('SELECT COUNT(*) AS n FROM users WHERE referred_by = ?', [u.user_id]);
      const paid = await one("SELECT COUNT(*) AS n FROM referral_pending WHERE referrer_id = ? AND status = 'paid'", [u.user_id]);
      referral = { code: u.referral_code, uses: Number(uses.n), goldEarned: Number(paid.n) * 200 };
      referralCode = u.referral_code;
    }
    // Profil publik = ALLOWLIST eksplisit (jangan spread `...u`: baris
    // citizens membawa gold/usd/energi/kelelahan/misi/kronik yang TIDAK
    // boleh bocor ke pemain lain — audit §4.12 memperingatkan pola spread
    // baris user ke respons). last_seen_at = "terakhir main" (kolom sudah
    // ada sejak v7, heartbeat /api/me memperbaruinya).
    res.json({ profile: {
      citizen_id: u.citizen_id, user_id: u.user_id, username: u.username, avatar: u.avatar,
      publicId: publicId(u.user_id), level: u.level, xp: u.xp, bio: u.bio,
      shifts: u.shifts, total_salary: u.total_salary,
      total_damage: u.total_damage, attacks: u.attacks, frontline_attacks: u.frontline_attacks,
      attr_str: u.attr_str, attr_edu: u.attr_edu, attr_eco: u.attr_eco,
      created_at: u.created_at, last_seen_at: u.last_seen_at,
      // Status online per warga (v4.3.0, saran LIO): flag + label siap
      // tampil ("Online" / "Terakhir online 2 jam lalu" /
      // "Belum pernah terlihat online"), dihitung dari last_seen_at yang
      // sama dengan heartbeat /api/me — tanpa sistem paralel.
      ...onlineStatus(u.last_seen_at),
      // Skor kredit bersifat PUBLIK (v3.0.0): semua pemain bisa melihat
      // skor pemain lain — tidak seperti emas/USD/energi yang disembunyikan.
      // Profil TIDAK lewat loadCitizen, jadi pemulihan dihitung di sini
      // tanpa menulis DB (hanya pemilik yang menulis lewat loadCitizen).
      credit_score: creditScoreSettled(u.credit_score, u.credit_updated_at, u.is_banned),
      credit: creditInfo(creditScoreSettled(u.credit_score, u.credit_updated_at, u.is_banned)),
      // Reputasi dagang (Tahap 6) + kekuatan militer (Tahap 6): PUBLIK,
      // seperti skor kredit — bukan data sensitif (bukan emas/USD/energi).
      trades_completed: u.trades_completed || 0,
      trade_reputation: tradeReputation(u.trades_completed || 0).label,
      military_power: await militaryPowerOf(u.citizen_id),
      region_name: region?.name, country_name: region?.country_name || null,
      party, companies, articles, referral, referral_code: referralCode,
      isPremium: u.premium_until > Date.now(),
    } });
  }));
  app.post('/api/profile/bio', authRequired, citizenRequired, r(async (req, res) => {
    const { bio } = req.body || {};
    if ((bio || '').length > 1000) return res.status(400).json({ error: 'Biografi maksimal 1000 karakter.' });
    await run('UPDATE citizens SET bio = ? WHERE id = ?', [bio || '', req.citizen.id]);
    res.json({ ok: true });
  }));
  app.post('/api/profile/rename', authRequired, citizenRequired, r(async (req, res) => {
    const { name } = req.body || {};
    if (!isValidUsername(name)) return res.status(400).json({ error: 'Nama 3–24 karakter, huruf/angka/underscore saja.' });
    await tx(async (t) => {
      const locked = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      if (locked.gold < 50) throw Object.assign(new Error('Ganti nama butuh 50 emas.'), { status: 400 });
      const taken = await t.one('SELECT id FROM users WHERE username = ? AND id != ?', [name, locked.user_id]);
      if (taken) throw Object.assign(new Error('Nama ini sudah dipakai.'), { status: 400 });
      await t.run('UPDATE users SET username = ? WHERE id = ?', [name, locked.user_id]);
      const upd = await t.run('UPDATE citizens SET gold = gold - 50 WHERE id = ? AND gold >= 50', [locked.id]);
      if (!upd.changes) throw Object.assign(new Error('Ganti nama butuh 50 emas.'), { status: 400 });
    });
    res.json({ ok: true });
  }));

  // ---------- FOTO PROFIL ----------
  // Simpan sebagai data URL di kolom users.avatar — tanpa layanan baru
  // (Vercel serverless tidak punya filesystem permanen). Browser sudah
  // me-resize/crop gambar jadi persegi 256×256 sebelum mengirim.
  // Batas: data URL gambar (JPEG/PNG/WebP) yang valid, ≤ 500 KB
  // (dinaikkan dari 100 KB, permintaan ADMIN/Khalid 2026-11-27 — pemain
  // sudah dijanjikan "naik ke 500 KB"). Hanya untuk akun sendiri — tidak
  // ada parameter target, selalu req.userId.
  // Tahap 3 (§6.3): browser juga mengirim avatar_sm — versi 48×48 (≤ 25 KB)
  // yang dipakai di daftar chat/DM supaya satu polling chat tidak lagi
  // mengunduh ~683 KB × 100 pesan. avatar_sm NULL untuk foto lama (belum
  // diunggah ulang) — chat memakai fallback inisial di sana.
  const AVATAR_MAX_BYTES = 500 * 1024;
  const AVATAR_SM_MAX_BYTES = 25 * 1024;
  // Foto perusahaan (v2.4.0): batas yang sama seperti foto profil (500 KB)
  // + thumbnail 50 KB, pola yang sama seperti sampul artikel.
  const COMPANY_PHOTO_MAX_BYTES = 500 * 1024;
  const COMPANY_PHOTO_SM_MAX_BYTES = 50 * 1024;
  // Parser gambar bersama ada di util.js (dipakai juga gambar artikel).
  const parseAvatarDataUrl = (dataUrl, maxBytes = AVATAR_MAX_BYTES) => parseImageDataUrl(dataUrl, maxBytes);
  app.post('/api/profile/avatar', authRequired, r(async (req, res) => {
    // (v4.6.0, penyelidikan bug foto LIO): file HEIC dari galeri HP gagal
    // di-decode browser — kenali di sini supaya pesannya spesifik HEIC
    // (dengan jalan keluar), bukan tuduhan format generik.
    if (isHeicDataUrl(req.body?.avatar)) {
      return res.status(400).json({ error: HEIC_ERROR_MESSAGE });
    }
    const parsed = parseAvatarDataUrl(req.body?.avatar);
    if (!parsed) {
      return res.status(400).json({ error: 'Foto harus gambar JPEG/PNG/WebP yang valid dan ukurannya maksimal 500 KB.' });
    }
    // avatar_sm opsional: bila dikirim harus valid dan ≤ 25 KB. Foto lama
    // yang tidak mengirimkannya tetap tersimpan (avatar_sm NULL).
    let parsedSm = null;
    if (req.body?.avatar_sm) {
      parsedSm = parseAvatarDataUrl(req.body.avatar_sm, AVATAR_SM_MAX_BYTES);
      if (!parsedSm) {
        return res.status(400).json({ error: 'Foto kecil (thumbnail) harus gambar JPEG/PNG/WebP yang valid dan ukurannya maksimal 25 KB.' });
      }
    }
    if (parsedSm) {
      await run('UPDATE users SET avatar = ?, avatar_sm = ? WHERE id = ?', [parsed.dataUrl, parsedSm.dataUrl, req.userId]);
    } else {
      await run('UPDATE users SET avatar = ? WHERE id = ?', [parsed.dataUrl, req.userId]);
    }
    res.json({ ok: true, bytes: parsed.bytes });
  }));
  app.post('/api/profile/avatar/delete', authRequired, r(async (req, res) => {
    await run('UPDATE users SET avatar = NULL, avatar_sm = NULL WHERE id = ?', [req.userId]);
    res.json({ ok: true });
  }));

  // ---------- PEKERJAAN ----------
  app.get('/api/jobs', authRequired, citizenRequired, r(async (req, res) => {
    const { type, region, sort } = req.query;
    let where = '1=1';
    const params = [];
    if (type === 'fixed' || type === 'share') { where += ' AND j.salary_type = ?'; params.push(type); }
    if (region) { where += ' AND j.region_id = ?'; params.push(Number(region)); }
    const order = sort === 'salary' ? 'j.salary DESC' : sort === 'level' ? 'j.level_min ASC' : 'j.created_at DESC';
    const rows = await sql(
      `SELECT j.*, co.name AS company_name, r.name AS region_name,
        (SELECT COUNT(*) FROM citizens WHERE job_id = j.id) AS workers
       FROM jobs j LEFT JOIN companies co ON co.id = j.company_id
       JOIN regions r ON r.id = j.region_id WHERE ${where} ORDER BY ${order}`,
      params);
    const stats = await one('SELECT COUNT(*) AS open, SUM(CASE WHEN is_admin = 0 THEN seats - seats_taken ELSE 0 END) AS seats, MAX(salary) AS best FROM jobs WHERE seats_taken < seats');
    // Upah ADMIN yang berlaku (Tahap 5): UU upah ADMIN mengubah jumlah
    // bahan mentah per shift (pengali admin_pay_mult + ideologi Sosialisme
    // ×1.1). Frontend menampilkan effectiveQty agar yang terlihat sama
    // dengan yang diterima. Event dunia (Tahap 6): Panen Raya menaikkan
    // upah bahan ADMIN +20% — ikut dihitung di sini supaya tampilan dan
    // shift (POST /api/jobs/shift) memakai angka yang sama.
    const myCountry = await getMyCountry({ one }, req.citizen);
    const adminPayMult = getAdminPayMult({ one }, myCountry);
    const wday = await getWorldDay();
    const worldEvent = worldEventFor(wday);
    const eventMult = worldEvent.key === 'panen' ? 1.2 : 1;
    const jobs = rows.map((j) => j.salary_type === 'goods'
      ? { ...j, effectiveQty: Math.max(1, Math.floor((j.pay_qty || 0) * adminPayMult * eventMult)) }
      : j);
    res.json({ jobs, stats, adminPayMult, worldEvent });
  }));

  app.post('/api/jobs/apply', authRequired, citizenRequired, r(async (req, res) => {
    const { job_id } = req.body || {};
    const wasAutoWork = (req.citizen.auto_work_until || 0) > Date.now();
    const oldJobId = req.citizen.job_id;
    // Atomik: kunci baris lowongan + baris warga, baca ulang syarat di dalam
    // tx, naikkan kursi hanya bila masih ada (WHERE seats_taken < seats).
    await tx(async (t) => {
      const job = await t.one(forUpdate('SELECT * FROM jobs WHERE id = ?'), [job_id]);
      if (!job) throw Object.assign(new Error('Lowongan tidak ditemukan.'), { status: 404 });
      const c = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      if (c.level < job.level_min) throw Object.assign(new Error(`Butuh Level ${job.level_min} untuk melamar.`), { status: 400 });
      if (c.region_id !== job.region_id) throw Object.assign(new Error('Kamu harus berada di wilayah perusahaan itu untuk melamar.'), { status: 400 });
      if (c.job_id === job.id) throw Object.assign(new Error('Kamu sudah bekerja di lowongan ini.'), { status: 400 });
      // Lowongan ADMIN tanpa batas pekerja: lewati cek + hitung kursi
      // (jumlah pekerja dibaca dari citizens.job_id di GET /api/jobs).
      if (!job.is_admin && job.seats_taken >= job.seats) throw Object.assign(new Error('Kursi lowongan ini sudah penuh.'), { status: 400 });
      if (c.job_id) await t.run('UPDATE jobs SET seats_taken = seats_taken - 1 WHERE id = ? AND seats_taken > 0', [c.job_id]);
      // Pindah pekerjaan mematikan kerja otomatis (v4.5.0): shift
      // otomatis terikat pekerjaan saat aktivasi; nyalakan lagi manual
      // di pekerjaan baru bila mau.
      if (c.job_id && c.job_id !== job.id) await t.run('UPDATE citizens SET auto_work_until = 0, auto_work_started_at = 0, auto_work_paused = 0 WHERE id = ?', [c.id]);
      await t.run('UPDATE citizens SET job_id = ? WHERE id = ?', [job.id, c.id]);
      if (!job.is_admin) {
        const inc = await t.run('UPDATE jobs SET seats_taken = seats_taken + 1 WHERE id = ? AND seats_taken < seats', [job.id]);
        if (!inc.changes) throw Object.assign(new Error('Kursi lowongan ini sudah penuh.'), { status: 400 });
      }
    });
    if (wasAutoWork && oldJobId && oldJobId !== Number(job_id)) await notify(req.citizen.id, 'SISTEM', 'Kerja otomatis dimatikan', 'Kamu pindah pekerjaan — kerja otomatis berhenti. Nyalakan lagi dari panel PEKERJAANMU bila mau.');
    await chronicleDone(req.citizen, 'job');
    res.json({ ok: true });
  }));

  app.post('/api/jobs/quit', authRequired, citizenRequired, r(async (req, res) => {
    const c = req.citizen;
    if (!c.job_id) return res.status(400).json({ error: 'Kamu sedang tidak bekerja.' });
    const wasAutoWork = (c.auto_work_until || 0) > Date.now();
    await tx(async (t) => {
      await t.run('UPDATE jobs SET seats_taken = seats_taken - 1 WHERE id = ? AND seats_taken > 0', [c.job_id]);
      // Keluar pekerjaan mematikan kerja otomatis (v4.5.0).
      await t.run('UPDATE citizens SET job_id = NULL, auto_work_until = 0, auto_work_started_at = 0, auto_work_paused = 0 WHERE id = ?', [c.id]);
    });
    if (wasAutoWork) await notify(c.id, 'SISTEM', 'Kerja otomatis dimatikan', 'Kamu berhenti bekerja — kerja otomatis berhenti.');
    res.json({ ok: true });
  }));

  // ---------- SHIFT (inti, dipakai endpoint manual + kerja otomatis) ----------
  // Seluruh logika satu giliran kerja — gaji (tetap/bagi hasil/bahan
  // ADMIN), XP proporsional, bonus perusahaan, kelelahan — dipusatkan di
  // sini supaya shift manual (POST /api/jobs/shift) dan shift otomatis
  // (modul auto-work.js) memakai rumus yang SAMA PERSIS. Hasil yang
  // dikembalikan sama persis dengan yang dulu dikirim endpoint.
  async function performShift(userId) {
    // PENTING: parameternya USER id — loadCitizen(userId) memakai
    // `WHERE c.user_id = ?`. BUG LIO + Kenzz 28 Nov 2026 (hotfix v4.5.2):
    // dulu parameter ini bernama citizenId dan dipanggil dengan
    // req.citizen.id / c.id — selama citizens.id == users.id (kasus umum)
    // tidak terlihat, tapi begitu id keduanya bergeser (pendaftaran gagal
    // di tengah jalan, baris dihapus, dsb.) shift memuat WARGA YANG SALAH:
    // warga lain yang user_id-nya kebetulan sama dengan citizen id
    // pemanggil. Bila warga salah itu tidak bekerja → error "Kamu belum
    // punya pekerjaan" padahal pemanggil SUDAH bekerja (panel PEKERJAANMU
    // membaca lewat /api/me yang benar — buktinya screenshot Kenzz: panel
    // menampilkan KERJA - PT BESI JABAR Rp900.000.039/shift, tapi tombol
    // KERJAKAN SATU GILIRAN melempar error itu). Kerja otomatis kena
    // dampak yang sama (shift warga salah, energi + gaji warga salah).
    // Jangan pernah kirim citizen id ke sini.
    const c = await loadCitizen(userId);
    if (!c) throw Object.assign(new Error('Warga tidak ditemukan.'), { status: 404 });
    if (!c.job_id) throw Object.assign(new Error('Kamu belum punya pekerjaan. Lamar dulu di Kantor Ketenagakerjaan.'), { status: 400 });
    const job = await one('SELECT * FROM jobs WHERE id = ?', [c.job_id]);
    if (!job) throw Object.assign(new Error('Lowongan pekerjaanmu sudah tidak ada.'), { status: 400 });
    // Tarif pajak + pengali upah ADMIN yang berlaku (Tahap 5 — dari UU yang
    // disahkan, bukan hardcode). Gaji tetap dipotong tarif UU; lowongan
    // ADMIN dibayar bahan mentah × pengali UU (tanpa pajak). Tarif/pengali
    // mengikuti NEGARA pekerja (tanpa negara = pajak 0%, pengali ×1).
    const myCountry = await getMyCountry({ one }, c);
    // Event dunia minggu ini (Tahap 6): Panen Raya -> upah bahan ADMIN
    // +20%; Festival Rakyat -> XP shift +50%. Dibaca sekali di awal
    // handler supaya ketiga cabang gaji memakai event yang sama.
    // (Tahap 7) Hari dunia dibaca SEBELUM tarif pajak — Pasar Bergairah
    // (−1 poin) berlaku untuk pajak gaji juga, bukan hanya pajak pasar.
    // Sebelumnya taxRate dihitung tanpa `day`, jadi gaji tidak ikut diskon.
    const wday = (await getWorldDay());
    const taxRate = getIncomeTaxRate({ one }, myCountry, wday);
    const adminPayMult = getAdminPayMult({ one }, myCountry);
    const worldEvent = worldEventFor(wday);
    // SHIFT FLEKSIBEL (permintaan pemain LIO, 27 Nov 2026): giliran memakai
    // energi yang ADA sampai 100 — 50 energi pun bisa kerja. Hadiah
    // PROPORSIONAL dengan energi yang dipakai (fraksi = energi/100):
    // 50 energi → ~50% hadiah, 1 energi → ~1% (bukan penuh — itu exploit).
    // Pengurang energi atomik (dipakai ketiga jenis gaji): kunci baris warga,
    // potong energi yang dipakai hanya bila masih cukup (cek changes). Dua
    // shift paralel: yang kedua gagal dengan 400, energi tidak pernah negatif.
    async function spendEnergy(t) {
      const locked = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [c.id]);
      const energy = locked?.energy ?? 0;
      if (energy <= 0) throw Object.assign(new Error('Energi habis (0). Makan roti dulu.'), { status: 400 });
      const used = Math.min(energy, 100);
      const upd = await t.run('UPDATE citizens SET energy = energy - ?, energy_spent_today = energy_spent_today + ?, fatigue = fatigue + ?, shifts = shifts + 1 WHERE id = ? AND energy >= ?', [used, used, used, c.id, used]);
      if (!upd.changes) throw Object.assign(new Error(`Energi tidak cukup (${energy}). Makan roti dulu.`), { status: 400 });
      // (Tahap 7) Tulis misi 'energy' ke JSON dihapus — tulis itu mati:
      // progres energi dibaca dari energy_spent_today (sudah +used di
      // UPDATE di atas). Kolom JSON-nya sudah dihapus.
      return { used, fraction: used / 100, full: used === 100, fatigue: locked.fatigue, eco: locked.attr_eco };
    }
    // XP PROPORSIONAL (tiket #22 LIO, v3.1.0): tiap shift memberi XP
    // sebanding energi yang dipakai — 50 energi -> 10 XP, 1 energi ->
    // minimal 1 XP (tetap nambah, bukan 0). Jam ganda 00:00–01:00 WIB
    // (tiket #21): XP shift ×2. Tugas Kronik "Kerjakan satu giliran"
    // TETAP hanya untuk shift PENUH (100 energi) — kalau shift 1 energi
    // ikut menyelesaikannya, itu exploit hadiah Kronik.
    async function rewardShift(spent) {
      let xpGained = xpGainForShiftEnergy(spent.used);
      // Event dunia (Tahap 6): Festival Rakyat -> XP shift +50% (menumpuk
      // dengan jam ganda ×2 bila bersamaan).
      const festivalXp = worldEvent.key === 'festival';
      if (festivalXp) xpGained = Math.round(xpGained * 1.5);
      await addXp(c, xpGained);
      if (spent.full) await chronicleDone(c, 'shift');
      return { xpGained, doubleXp: isDoubleXpHour(), festivalXp };
    }
    // Akhiran catatan XP: jam ganda dan/atau festival (keduanya bisa aktif
    // bersamaan — jam ganda 00:00–01:00 WIB di minggu festival).
    const xpNoteSuffix = (xp) => `${xp.doubleXp ? ' 🌙 Jam ganda: XP ×2!' : ''}${xp.festivalXp ? ' 🎉 Festival Rakyat: XP ×1,5!' : ''}`;
    const shiftPrefix = (spent) => spent.full ? '' : `Shift ${spent.used} energi (${Math.round(spent.fraction * 100)}%): `;
    const bonusNote = (bonus) => {
      if (!bonus) return '';
      if (bonus.qty > 0) return ` Bonus perusahaan: +${bonus.qty}× ${bonus.product} untuk pemilik ${bonus.company}.`;
      if (bonus.shortage) return ` Bonus perusahaan tertunda (pemilik kehabisan ${bonus.need || 'bahan baku'}).`;
      return '';
    };
    // Bonus shift karyawan (v2.4.0): tiap shift di perusahaan milik warga
    // menambah produk perusahaan ke inventaris PEMILIK — ~1/10 produksi
    // harian per shift penuh, terakumulasi dalam persepuluh unit (kolom
    // companies.bonus_credit) supaya produk bernilai tinggi (Drone, 3/hari)
    // tetap adil. Atomik dengan shift: dipanggil di dalam tx yang sama.
    // Factory butuh 2× Besi Mentah per unit (seperti produksi harian); bila
    // bahan kurang, bonus tertahan sebagai kredit + pemilik diberi tahu
    // sekali per 24 jam. Mengembalikan { company, product, qty } bila ada
    // unit yang masuk, { ..., qty: 0, shortage: true } bila tertahan bahan,
    // atau null bila tidak ada bonus (bukan perusahaan / belum genap 1 unit).
    async function grantCompanyShiftBonus(t, job, spent, worker) {
      if (!job.company_id) return null;
      const co = await t.one(forUpdate('SELECT * FROM companies WHERE id = ?'), [job.company_id]);
      if (!co) return null;
      const product = companyProduct(co);
      const com = product ? await t.one('SELECT * FROM commodities WHERE name = ?', [product]) : null;
      if (!com) return null;
      const daily = DAILY_PRODUCTION[co.type] || 0;
      if (daily <= 0) return null;
      const added = Math.round(daily * spent.fraction);
      const total = (co.bonus_credit || 0) + added;
      let units = Math.floor(total / 10);
      let credit = total - units * 10;
      // Tahap 6 — rantai produksi penuh: bonus shift memakai bahan baku
      // yang sama seperti produksi harian (PRODUCTION_INPUT di game.js —
      // satu sumber kebenaran). Tiap jenis input membatasi unit yang bisa
      // dibuat. (v4.6.0, saran LIO): bahan diambil dari STOK PERUSAHAAN
      // (company_stock — diisi pemilik lewat POST /api/companies/:id/stock),
      // BUKAN LAGI diam-diam dari inventaris pemilik. Bila stok habis,
      // bonus tertahan sebagai kredit + pemilik diberi tahu sekali per
      // 24 jam + SEMUA karyawan perusahaan itu ikut diberi tahu sekali
      // (supaya pekerja yang menekan tombol kerja tahu kenapa bonusnya
      // tertunda — pemberitahuan ke pekerja yang diminta tiket LIO).
      const inputs = PRODUCTION_INPUT[co.type] || [];
      let shortage = false;
      let shortageNeed = '';
      if (units > 0 && inputs.length) {
        const stocks = [];
        for (const input of inputs) {
          const inputRow = await t.one('SELECT id FROM commodities WHERE name = ?', [input.commodity]);
          const stock = inputRow ? await t.one('SELECT * FROM company_stock WHERE company_id = ? AND commodity_id = ?', [co.id, inputRow.id]) : null;
          stocks.push({ input, stock, have: stock?.qty || 0 });
        }
        let affordable = units;
        for (const s of stocks) affordable = Math.min(affordable, Math.floor(s.have / s.input.perUnit));
        shortageNeed = inputs.map((i) => `${i.perUnit}× ${i.commodity}`).join(' + ');
        if (affordable <= 0) {
          units = 0; credit = total; shortage = true;
          const now = Date.now();
          if (!co.bonus_warned_at || now - co.bonus_warned_at > DAY_MS) {
            await t.run('UPDATE companies SET bonus_warned_at = ? WHERE id = ?', [now, co.id]);
            await notify(co.owner_id, 'EKONOMI', 'Bonus shift tertunda',
              `${co.name} tidak mendapat bonus shift: stok bahan habis (butuh ${shortageNeed} per unit ${product}; stok sekarang ${stocks.map((s) => `${s.have}× ${s.input.commodity}`).join(', ')}). Isi stok dari halaman Industri → PERUSAHAANKU → ISI BAHAN.`, t);
            // Beri tahu semua karyawan perusahaan ini (sekali per 24 jam,
            // bersamaan dengan peringatan pemilik) — pekerja yang menekan
            // tombol kerja melihat kenapa bonus perusahaan tertunda.
            await t.run(`INSERT INTO notifications (citizen_id, category, title, content, created_at)
              SELECT c.id, 'EKONOMI', 'Perusahaan kehabisan bahan', ?, ? FROM citizens c JOIN jobs j ON j.id = c.job_id WHERE j.company_id = ?`,
              [`${co.name} kehabisan bahan (butuh ${shortageNeed} per unit ${product}). Produksi & bonus shift berhenti sampai pemilik mengisi stok bahan.`, now, co.id]);
          }
        } else {
          if (affordable < units) { units = affordable; credit = total - units * 10; }
          for (const s of stocks) {
            const used = units * s.input.perUnit;
            if (used <= 0) continue;
            if (!s.stock) { units = 0; credit = total; shortage = true; break; }
            const took = await t.run('UPDATE company_stock SET qty = qty - ? WHERE id = ? AND qty >= ?', [used, s.stock.id, used]);
            if (!took.changes) { units = 0; credit = total; shortage = true; break; }
          }
        }
      }
      await t.run('UPDATE companies SET bonus_credit = ?, bonus_given = bonus_given + ? WHERE id = ?', [credit, units, co.id]);
      if (units > 0) {
        await addItem(co.owner_id, com.id, 1, units, t);
        await notify(co.owner_id, 'EKONOMI', 'Bonus shift karyawan',
          `${worker.username} menyelesaikan shift di ${co.name}: +${units}× ${product} masuk inventarismu.`, t);
        return { company: co.name, product, qty: units };
      }
      return shortage ? { company: co.name, product, qty: 0, shortage: true, need: shortageNeed } : null;
    }
    let goodsNote = '';
    if (job.salary_type === 'goods') {
      // Lowongan ADMIN: dibayar BAHAN MENTAH, bukan uang (tanpa pajak).
      // Jumlah dipengaruhi kelelahan seperti gaji (×0,75 / ×0,5) dan
      // pengali upah ADMIN dari UU yang berlaku (Tahap 5) — lalu dikali
      // fraksi energi, dibulatkan ke BAWAH (floor — sama seperti rumus
      // shift penuh lama dan effectiveQty yang tampil di /api/jobs; 1
      // energi bisa 0 unit).
      const com = await one('SELECT * FROM commodities WHERE name = ?', [job.resource]);
      if (!com) throw Object.assign(new Error('Bahan upah lowongan ini tidak dikenal.'), { status: 500 });
      const spent = await tx(async (t) => {
        const s = await spendEnergy(t);
        // Event dunia (Tahap 6): Panen Raya -> upah bahan ADMIN +20%.
        const panenMult = worldEvent.key === 'panen' ? 1.2 : 1;
        const qty = Math.floor((job.pay_qty || 0) * fatigueMult(s.fatigue) * adminPayMult * panenMult * s.fraction);
        if (qty > 0) await addItem(c.id, com.id, 1, qty, t);
        return { ...s, qty };
      });
      const usdValue = Math.round(spent.qty * com.ref_usd * 100) / 100;
      const note = `${shiftPrefix(spent)}Dibayar ${spent.qty}× ${job.resource} (setara ~${fmtRp(usdValue)}).`;
      const xp = await rewardShift(spent);
      return { ok: true, gross: usdValue, net: 0, tax: 0, goods: `${spent.qty}× ${job.resource}`, goodsQty: spent.qty, goodsName: job.resource, note: note + xpNoteSuffix(xp), xpGained: xp.xpGained, doubleXp: xp.doubleXp, festivalXp: xp.festivalXp, energyUsed: spent.used, energyPct: Math.round(spent.fraction * 100), companyShortage: false };
    }
    if (job.salary_type === 'share') {
      // Bagi hasil: 80–98% dibayar dalam bentuk barang (sumber daya perusahaan).
      const pct = 80 + Math.min(18, Math.floor(job.share_pct || 90) - 80);
      const company = job.company_id ? await one('SELECT * FROM companies WHERE id = ?', [job.company_id]) : null;
      const resource = company?.resource || 'Gandum Mentah';
      const com = await one('SELECT * FROM commodities WHERE name = ?', [resource]);
      const spent = await tx(async (t) => {
        const s = await spendEnergy(t);
        const gross = shiftSalary(job.salary, s.eco, s.fatigue, taxRate).gross * s.fraction;
        const units = Math.max(0, Math.floor((gross * pct / 100) / com.ref_usd));
        if (units > 0) await addItem(c.id, com.id, 1, units, t);
        const bonus = await grantCompanyShiftBonus(t, job, s, c);
        return { ...s, gross, units, bonus };
      });
      goodsNote = `${shiftPrefix(spent)}Dibayar ${spent.units}× ${resource} (bagi hasil ${pct}%).${bonusNote(spent.bonus)}`;
      const xp = await rewardShift(spent);
      return { ok: true, gross: spent.gross, net: 0, tax: 0, goods: `${spent.units}× ${resource}`, goodsQty: spent.units, goodsName: resource, note: goodsNote + xpNoteSuffix(xp), companyBonus: spent.bonus || null, companyShortage: !!(spent.bonus && spent.bonus.shortage), xpGained: xp.xpGained, doubleXp: xp.doubleXp, festivalXp: xp.festivalXp, energyUsed: spent.used, energyPct: Math.round(spent.fraction * 100) };
    }
    const spent = await tx(async (t) => {
      const s = await spendEnergy(t);
      const { gross, net } = shiftSalary(job.salary, s.eco, s.fatigue, taxRate);
      const scaledGross = Math.round(gross * s.fraction * 100) / 100;
      const scaledNet = Math.round(net * s.fraction * 100) / 100;
      await t.run('UPDATE citizens SET usd = usd + ?, total_salary = total_salary + ? WHERE id = ?', [scaledNet, scaledNet, c.id]);
      const bonus = await grantCompanyShiftBonus(t, job, s, c);
      return { ...s, gross: scaledGross, net: scaledNet, tax: Math.round(scaledGross * taxRate * 100) / 100, bonus };
    });
    const xp = await rewardShift(spent);
    const baseNote = `${spent.full ? '' : `Shift ${spent.used} energi (${Math.round(spent.fraction * 100)}%).`}${bonusNote(spent.bonus)}`.trim();
    return { ok: true, gross: spent.gross, net: spent.net, tax: spent.tax, goods: '', goodsQty: 0, goodsName: '', note: (baseNote + xpNoteSuffix(xp)).trim(), companyBonus: spent.bonus || null, companyShortage: !!(spent.bonus && spent.bonus.shortage), xpGained: xp.xpGained, doubleXp: xp.doubleXp, festivalXp: xp.festivalXp, energyUsed: spent.used, energyPct: Math.round(spent.fraction * 100) };
  }

  // Kerja otomatis memakai performShift yang sama — daftarkan di sini
  // (registerCore berjalan sekali saat aplikasi dibuat).
  shiftRunner.performShift = performShift;

  // Endpoint manual — KERJA SATU GILIRAN PAKAI SEMUA ENERGI (v4.6.0, saran
  // LIO): satu tekan menjalankan shift berturut-turut sampai energi habis
  // (140 energi → shift 100 + shift 40 dalam satu aksi), bukan 100 dulu
  // lalu pencet ulang. Tiap shift memakai performShift yang sama persis
  // (gaji/XP/kelelahan/bonus proporsional) — hasil digabung. Berhenti
  // lebih awal bila shift gagal (mis. pekerjaan hilang): hasil parsial
  // tetap dikembalikan; bila shift PERTAMA gagal, error dilempar seperti
  // dulu (400). Kerja otomatis TIDAK berubah — runner memanggil
  // performShift langsung (satu shift per jalan).
  // energyPct mengikuti arti LAMA (fraksi satu shift penuh 100 energi,
  // dirata-rata per shift) supaya klien/tes lama tidak berubah arti:
  // 50 energi 1 shift → 50; 140 energi 2 shift → 70.
  app.post('/api/jobs/shift', authRequired, citizenRequired, r(async (req, res) => {
    const results = [];
    let stoppedBy = '';
    for (let i = 0; i < SHIFT_MAX_PER_CALL; i++) {
      const energyNow = (await one('SELECT energy FROM citizens WHERE id = ?', [req.citizen.id]))?.energy ?? 0;
      if (energyNow <= 0) break;
      try {
        results.push(await performShift(req.userId));
      } catch (e) {
        if (results.length === 0) throw e;
        stoppedBy = e.message || 'Shift berikutnya gagal.';
        break;
      }
    }
    if (results.length === 0) {
      return res.status(400).json({ error: 'Energi habis (0). Makan roti dulu.' });
    }
    const total = (f) => results.reduce((s, r) => s + (Number(r[f]) || 0), 0);
    const energyUsed = total('energyUsed');
    const goodsQty = results.reduce((s, r) => s + (Number(r.goodsQty) || 0), 0);
    const goodsName = results.find((r) => r.goodsName)?.goodsName || '';
    const first = results[0];
    const note = results.length > 1
      ? `${results.length} shift selesai (semua energi dipakai). ${results.map((r) => r.note).filter(Boolean).join(' ')}`
      : first.note;
    res.json({
      ok: true,
      shifts: results.length,
      energyUsed,
      energyPct: Math.round(energyUsed / (100 * results.length) * 100),
      gross: total('gross'), net: total('net'), tax: total('tax'),
      goods: goodsQty > 0 && goodsName ? `${goodsQty}× ${goodsName}` : (first.goods || ''),
      goodsQty, goodsName,
      note: (note + (stoppedBy ? ` Berhenti: ${stoppedBy}` : '')).trim(),
      companyBonus: results.map((r) => r.companyBonus).find((b) => b) || null,
      companyShortage: results.some((r) => r.companyShortage),
      xpGained: total('xpGained'),
      doubleXp: results.some((r) => r.doubleXp),
      festivalXp: results.some((r) => r.festivalXp),
    });
  }));

  // ---------- KERJA OTOMATIS 24 JAM (Premium, v4.5.0) ----------
  // Toggle di panel PEKERJAANMU. Nyalakan: Premium + punya pekerjaan;
  // aktif 24 jam sejak aktivasi, shift jalan otomatis di server (modul
  // auto-work.js). Matikan: berhenti segera. Berhenti otomatis juga bila
  // Premium habis / keluar-pindah pekerjaan / 24 jam habis (diurus runner).
  app.post('/api/jobs/auto-work', authRequired, citizenRequired, r(async (req, res) => {
    const { on } = req.body || {};
    const c = req.citizen;
    if (on) {
      if ((c.premium_until || 0) <= Date.now()) return res.status(403).json({ error: 'Kerja otomatis khusus Premium.' });
      if (!c.job_id) return res.status(400).json({ error: 'Kamu belum punya pekerjaan. Lamar dulu di Kantor Ketenagakerjaan.' });
      const job = await one('SELECT id FROM jobs WHERE id = ?', [c.job_id]);
      if (!job) return res.status(400).json({ error: 'Lowongan pekerjaanmu sudah tidak ada.' });
      const now = Date.now();
      const until = now + AUTO_WORK_DURATION_MS;
      await run('UPDATE citizens SET auto_work_until = ?, auto_work_started_at = ?, auto_work_shifts = 0, auto_work_paused = 0, auto_work_last_at = 0 WHERE id = ?', [until, now, c.id]);
      await notify(c.id, 'SISTEM', 'Kerja otomatis aktif', 'Shift berjalan otomatis di server selama 24 jam, walau aplikasi ditutup. Berhenti otomatis bila Premium habis, kamu pindah/keluar pekerjaan, atau waktunya habis.');
      res.json({ ok: true, autoWork: { active: true, until, shifts: 0, paused: false, lastAt: 0 } });
    } else {
      await run('UPDATE citizens SET auto_work_until = 0, auto_work_started_at = 0, auto_work_paused = 0 WHERE id = ?', [c.id]);
      res.json({ ok: true, autoWork: { active: false, until: 0, shifts: c.auto_work_shifts || 0, paused: false, lastAt: c.auto_work_last_at || 0 } });
    }
  }));

  // ---------- PERUSAHAAN ----------
  app.get('/api/companies', authRequired, citizenRequired, r(async (req, res) => {
    const rows = await sql(
      `SELECT co.*, u.username AS owner_name, r.name AS region_name,
        (SELECT COUNT(*) FROM citizens WHERE job_id IN (SELECT id FROM jobs WHERE company_id = co.id)) AS employees
       FROM companies co JOIN users u ON u.id = (SELECT user_id FROM citizens WHERE id = co.owner_id)
       JOIN regions r ON r.id = co.region_id ORDER BY co.created_at DESC`,
      []);
    // Bonus shift (v2.4.0): teks imbalan per shift penuh + total unit yang
    // sudah masuk inventaris pemilik dari shift karyawan.
    // Tahap 6: input_text = bahan baku yang dibutuhkan per unit (rantai
    // produksi penuh — tampil di kartu perusahaan + form pendirian).
    // v4.6.0: stock = isi stok bahan perusahaan (company_stock) per
    // perusahaan, supaya pemilik & pekerja melihat bahan yang tersedia;
    // myJobs = lowongan milik warga (untuk edit upah).
    const stockRows = await sql(
      `SELECT cs.company_id, c.name AS commodity, cs.qty FROM company_stock cs
       JOIN commodities c ON c.id = cs.commodity_id WHERE cs.qty > 0 ORDER BY c.name`, []);
    const stockByCompany = {};
    for (const s of stockRows) (stockByCompany[s.company_id] ||= []).push({ commodity: s.commodity, qty: Number(s.qty) });
    const myJobs = await sql(
      `SELECT j.id, j.company_id, j.title, j.salary, j.salary_type, j.seats, j.seats_taken,
        (SELECT COUNT(*) FROM citizens WHERE job_id = j.id) AS workers
       FROM jobs j JOIN companies co ON co.id = j.company_id WHERE co.owner_id = ? ORDER BY j.created_at ASC`,
      [req.citizen.id]);
    const withBonus = rows.map((x) => ({ ...x, bonus_text: shiftBonusText(x), bonus_given: x.bonus_given || 0, input_text: productionInputText(x.type), inputs: (PRODUCTION_INPUT[x.type] || []).map((i) => i.commodity), stock: stockByCompany[x.id] || [], jobs: myJobs.filter((j) => j.company_id === x.id) }));
    const mine = withBonus.filter((x) => x.owner_id === req.citizen.id);
    res.json({ companies: withBonus, mine, types: COMPANY_TYPES.map((t) => ({ ...t, input_text: productionInputText(t.type) })), resources: RESOURCE_PRODUCTS });
  }));

  app.post('/api/companies', authRequired, citizenRequired, r(async (req, res) => {
    const { type, name, about, resource } = req.body || {};
    const def = COMPANY_TYPES.find((x) => x.type === type);
    if (!def) return res.status(400).json({ error: 'Jenis perusahaan tidak dikenal.' });
    const c = req.citizen;
    if (type === 'resource' && !RESOURCE_PRODUCTS.includes(resource)) return res.status(400).json({ error: 'Pilih bahan mentah yang diproduksi.' });
    const companyId = await tx(async (t) => {
      const locked = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [c.id]);
      if (locked.gold < def.cost) throw Object.assign(new Error(`Mendirikan ${def.name} butuh ${def.cost} emas (kamu punya ${Math.floor(locked.gold)}).`), { status: 400 });
      const res2 = await t.run(
        `INSERT INTO companies (owner_id, name, about, type, region_id, resource, created_at) VALUES (?,?,?,?,?,?,?) RETURNING id`,
        [c.id, (name || `${def.name} ${c.username}`).slice(0, 60), (about || '').slice(0, 200), type, c.region_id, resource || '', Date.now()]);
      const upd = await t.run('UPDATE citizens SET gold = gold - ? WHERE id = ? AND gold >= ?', [def.cost, c.id, def.cost]);
      if (!upd.changes) throw Object.assign(new Error(`Mendirikan ${def.name} butuh ${def.cost} emas.`), { status: 400 });
      // Lowongan default perusahaan baru (1 kursi, gaji 40 USD).
      // Urutan nilai HARUS cocok dengan kolom: seats_taken=0, region_id
      // = wilayah pemilik (pernah tertukar: seats_taken terisi region_id
      // warga sehingga CHECK seats_taken<=seats gagal bila region > 1 —
      // tersembunyi selama semua pendiri lahir di region 1).
      await t.run(`INSERT INTO jobs (company_id, is_admin, title, salary, salary_type, level_min, tier, seats, seats_taken, region_id, description, created_at)
        VALUES (?,0,?,?,?,1,1,1,0,?,?,?) RETURNING id`,
        [res2.id, `Pekerja ${def.name}`, 40, 'fixed', c.region_id, 'Lowongan dari perusahaan milik warga.', Date.now()]);
      return res2.id;
    });
    await chronicleDone(c, 'company');
    res.json({ ok: true, companyId });
  }));

  // Isi stok bahan perusahaan (v4.6.0, saran LIO): HANYA pemilik.
  // Memindahkan bahan dari inventaris pemilik ke stok perusahaan —
  // produksi harian + bonus shift mengambil dari stok ini, BUKAN LAGI
  // diam-diam dari inventaris. commodity HARUS salah satu bahan baku
  // jenis perusahaan ini (Pabrik Sumber Daya tidak butuh bahan → 400).
  // qty bilangan bulat > 0 dan tidak melebihi stok inventaris pemilik.
  app.post('/api/companies/:id/stock', authRequired, citizenRequired, r(async (req, res) => {
    const co = await one('SELECT * FROM companies WHERE id = ?', [req.params.id]);
    if (!co) return res.status(404).json({ error: 'Perusahaan tidak ditemukan.' });
    if (co.owner_id !== req.citizen.id) return res.status(403).json({ error: 'Hanya pemilik yang bisa mengisi stok perusahaan ini.' });
    const inputs = PRODUCTION_INPUT[co.type] || [];
    if (!inputs.length) return res.status(400).json({ error: `${co.name} tidak butuh bahan baku (menambang langsung dari wilayah).` });
    const { commodity, qty } = req.body || {};
    const input = inputs.find((i) => i.commodity === commodity);
    if (!input) return res.status(400).json({ error: `Bahan yang dibutuhkan: ${inputs.map((i) => i.commodity).join(', ')}.` });
    const n = Number(qty);
    if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: 'Jumlah harus bilangan bulat lebih dari 0.' });
    const com = await one('SELECT * FROM commodities WHERE name = ?', [commodity]);
    if (!com) return res.status(400).json({ error: 'Bahan tidak dikenal.' });
    const stock = await tx(async (t) => {
      const ok = await takeItem(req.citizen.id, com.id, 1, n, t);
      if (!ok) throw Object.assign(new Error(`Kamu tidak punya ${n}× ${commodity} di inventaris.`), { status: 400 });
      const row = await t.one('SELECT * FROM company_stock WHERE company_id = ? AND commodity_id = ?', [co.id, com.id]);
      if (row) await t.run('UPDATE company_stock SET qty = qty + ? WHERE id = ?', [n, row.id]);
      else await t.run('INSERT INTO company_stock (company_id, commodity_id, qty) VALUES (?,?,?) RETURNING id', [co.id, com.id, n]);
      return await t.sql('SELECT c.name AS commodity, cs.qty FROM company_stock cs JOIN commodities c ON c.id = cs.commodity_id WHERE cs.company_id = ? AND cs.qty > 0 ORDER BY c.name', [co.id]);
    });
    res.json({ ok: true, stock: stock.map((s) => ({ commodity: s.commodity, qty: Number(s.qty) })) });
  }));

  // Edit upah lowongan perusahaan (v4.6.0, saran LIO): HANYA pemilik
  // perusahaan pemilik lowongan. Lowongan ADMIN (is_admin=1) bukan milik
  // warga — tidak bisa diubah. Yang bisa diubah: salary (gaji per shift,
  // dalam USD seperti penyimpanan server; klien menampilkan Rupiah).
  // Validasi: 1–1000 USD per shift (Rp18.300–Rp18.300.000).
  app.patch('/api/jobs/:id', authRequired, citizenRequired, r(async (req, res) => {
    const job = await one('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Lowongan tidak ditemukan.' });
    if (job.is_admin) return res.status(403).json({ error: 'Upah lowongan ADMIN tidak bisa diubah.' });
    if (!job.company_id) return res.status(403).json({ error: 'Lowongan ini bukan milik perusahaan.' });
    const co = await one('SELECT * FROM companies WHERE id = ?', [job.company_id]);
    if (!co || co.owner_id !== req.citizen.id) return res.status(403).json({ error: 'Hanya pemilik perusahaan yang bisa mengubah upah ini.' });
    const salary = Number((req.body || {}).salary);
    if (!Number.isFinite(salary) || salary <= 0 || salary > COMPANY_WAGE_MAX_USD) {
      return res.status(400).json({ error: `Upah harus 1–${COMPANY_WAGE_MAX_USD} USD per shift.` });
    }
    await run('UPDATE jobs SET salary = ? WHERE id = ?', [salary, job.id]);
    const updated = await one('SELECT * FROM jobs WHERE id = ?', [job.id]);
    res.json({ ok: true, job: updated });
  }));

  app.post('/api/companies/:id/job', authRequired, citizenRequired, r(async (req, res) => {
    const co = await one('SELECT * FROM companies WHERE id = ?', [req.params.id]);
    if (!co) return res.status(404).json({ error: 'Perusahaan tidak ditemukan.' });
    if (co.owner_id !== req.citizen.id) return res.status(403).json({ error: 'Hanya pemilik yang bisa membuka lowongan.' });
    const { title, salary, salary_type, seats } = req.body || {};
    if (!title || !salary || salary <= 0) return res.status(400).json({ error: 'Judul dan gaji wajib diisi.' });
    const j = await run(`INSERT INTO jobs (company_id, is_admin, title, salary, salary_type, level_min, tier, seats, seats_taken, region_id, description, created_at)
      VALUES (?,0,?,?,?,1,1,?,0,?,?,?) RETURNING id`,
      [co.id, title.slice(0, 80), Number(salary), salary_type === 'share' ? 'share' : 'fixed', Math.max(1, Math.min(20, Number(seats) || 1)), co.region_id, '', Date.now()]);
    res.json({ ok: true, jobId: j.id });
  }));

  // Edit perusahaan (v2.4.0, saran LIO): HANYA pemilik. Yang bisa diubah:
  // nama (1–60 karakter), tentang (maks 200 karakter), dan resource
  // (bahan mentah yang diproduksi — hanya untuk tipe resource, harus salah
  // satu dari RESOURCE_PRODUCTS). Jenis, wilayah, dan pemilik tidak bisa
  // diubah (biaya pendirian sudah dibayar per jenis).
  app.patch('/api/companies/:id', authRequired, citizenRequired, r(async (req, res) => {
    const co = await one('SELECT * FROM companies WHERE id = ?', [req.params.id]);
    if (!co) return res.status(404).json({ error: 'Perusahaan tidak ditemukan.' });
    if (co.owner_id !== req.citizen.id) return res.status(403).json({ error: 'Hanya pemilik yang bisa mengubah perusahaan ini.' });
    const { name, about, resource } = req.body || {};
    const updates = [];
    const values = [];
    if (name !== undefined) {
      const n = String(name).trim();
      if (!n) return res.status(400).json({ error: 'Nama perusahaan tidak boleh kosong.' });
      updates.push('name = ?'); values.push(n.slice(0, 60));
    }
    if (about !== undefined) { updates.push('about = ?'); values.push(String(about).slice(0, 200)); }
    if (resource !== undefined && co.type === 'resource') {
      if (!RESOURCE_PRODUCTS.includes(resource)) return res.status(400).json({ error: 'Pilih bahan mentah yang diproduksi.' });
      updates.push('resource = ?'); values.push(resource);
    }
    if (!updates.length) return res.status(400).json({ error: 'Tidak ada perubahan.' });
    values.push(co.id);
    await run(`UPDATE companies SET ${updates.join(', ')} WHERE id = ?`, values);
    const updated = await one('SELECT * FROM companies WHERE id = ?', [co.id]);
    res.json({ ok: true, company: { ...updated, bonus_text: shiftBonusText(updated), bonus_given: updated.bonus_given || 0 } });
  }));

  // Foto perusahaan (v2.4.0): HANYA pemilik. Batas yang sama seperti foto
  // profil/sampul artikel (500 KB, thumbnail 50 KB); data URL divalidasi
  // magic bytes JPEG/PNG/WebP lewat parseImageDataUrl (SVG ditolak).
  app.post('/api/companies/:id/photo', authRequired, citizenRequired, r(async (req, res) => {
    const co = await one('SELECT * FROM companies WHERE id = ?', [req.params.id]);
    if (!co) return res.status(404).json({ error: 'Perusahaan tidak ditemukan.' });
    if (co.owner_id !== req.citizen.id) return res.status(403).json({ error: 'Hanya pemilik yang bisa memasang foto perusahaan ini.' });
    const { photo, photo_sm } = req.body || {};
    if (!photo) return res.status(400).json({ error: 'Foto perusahaan wajib diisi.' });
    if (isHeicDataUrl(photo)) return res.status(400).json({ error: HEIC_ERROR_MESSAGE });
    const parsed = parseImageDataUrl(photo, COMPANY_PHOTO_MAX_BYTES);
    if (!parsed) return res.status(400).json({ error: 'Foto harus gambar JPEG/PNG/WebP yang valid dan ukurannya maksimal 500 KB.' });
    let photoSmUrl = null;
    if (photo_sm) {
      const parsedSm = parseImageDataUrl(photo_sm, COMPANY_PHOTO_SM_MAX_BYTES);
      if (!parsedSm) return res.status(400).json({ error: 'Thumbnail foto tidak valid (maksimal 50 KB).' });
      photoSmUrl = parsedSm.dataUrl;
    }
    await run('UPDATE companies SET photo = ?, photo_sm = ? WHERE id = ?', [parsed.dataUrl, photoSmUrl, co.id]);
    res.json({ ok: true });
  }));

  // ---------- PASAR ----------
  app.get('/api/market', authRequired, citizenRequired, r(async (req, res) => {
    const scope = req.query.scope === 'global' ? 'global' : 'local';
    const coms = await sql('SELECT * FROM commodities ORDER BY name');
    const since = Date.now() - DAY_MS;
    const stats = await one(
      `SELECT COUNT(*) AS offers FROM market_offers WHERE scope = ?`,
      [scope]);
    const txStats = await one(
      `SELECT COUNT(*) AS tx, COALESCE(SUM(qty),0) AS units, COALESCE(SUM(total),0) AS turnover FROM market_tx WHERE scope = ? AND created_at > ?`,
      [scope, since]);
    const best = await sql(
      `SELECT commodity_id, MIN(price) AS best, COUNT(*) AS n FROM market_offers WHERE scope = ? GROUP BY commodity_id`,
      [scope]);
    const bestMap = Object.fromEntries(best.map((b) => [b.commodity_id, b]));
    // Penawaran termurah dulu (100 teratas) + tag organisasi penjual bila
    // ia anggota organisasi (untuk tampilan kartu penawaran gaya Parlamentum)
    // + reputasi dagang penjual (Tahap 6: tier dari transaksi selesai).
    const offers = await sql(
      `SELECT o.*, u.username AS seller, c.name AS commodity_name, og.tag AS seller_org, sc.trades_completed AS seller_trades FROM market_offers o
       JOIN citizens sc ON sc.id = o.seller_id JOIN users u ON u.id = sc.user_id
       JOIN commodities c ON c.id = o.commodity_id
       LEFT JOIN org_members om ON om.citizen_id = o.seller_id
       LEFT JOIN organizations og ON og.id = om.org_id
       WHERE o.scope = ? ORDER BY o.price ASC LIMIT 100`,
      [scope]);
    const mine = await sql(
      `SELECT o.*, c.name AS commodity_name FROM market_offers o JOIN commodities c ON c.id = o.commodity_id
       WHERE o.seller_id = ? AND o.scope = ? ORDER BY o.created_at DESC`,
      [req.citizen.id, scope]);
    const recentTx = await sql(
      `SELECT t.*, c.name AS commodity_name FROM market_tx t JOIN commodities c ON c.id = t.commodity_id
       WHERE t.scope = ? ORDER BY t.created_at DESC LIMIT 20`,
      [scope]);
    // Order beli terbuka (Tahap 4): yang bisa dipenuhi penjual + milik sendiri.
    const buyOrders = await sql(
      `SELECT o.*, u.username AS buyer, c.name AS commodity_name FROM market_buy_orders o
       JOIN citizens sc ON sc.id = o.buyer_id JOIN users u ON u.id = sc.user_id
       JOIN commodities c ON c.id = o.commodity_id
       WHERE o.scope = ? AND o.qty_filled < o.qty ORDER BY o.price DESC LIMIT 100`,
      [scope]);
    const myBuyOrders = await sql(
      `SELECT o.*, c.name AS commodity_name FROM market_buy_orders o JOIN commodities c ON c.id = o.commodity_id
       WHERE o.buyer_id = ? AND o.scope = ? ORDER BY o.created_at DESC`,
      [req.citizen.id, scope]);
    const wday = await getWorldDay();
    res.json({
      scope, commodities: coms.map((c) => ({ ...c, best: bestMap[c.id]?.best ?? null, offers: bestMap[c.id]?.n ?? 0 })),
      stats: { offers: Number(stats.offers), tx: Number(txStats.tx), units: Number(txStats.units), turnover: Number(txStats.turnover) },
      // Reputasi dagang penjual (Tahap 6): tier dari transaksi selesai.
      offers: offers.map((o) => ({ ...o, seller_reputation: tradeReputation(o.seller_trades || 0).label })),
      mine, recentTx, buyOrders, myBuyOrders,
      // Tarif pajak penghasilan yang berlaku untuk PEMANGGIL (Tahap 5 —
      // dari UU negaranya, bukan hardcode 2%). Tanpa negara = 0%.
      // Nilai efektif dalam persen (mis. Liberalisme: 2% − 1 = 1%).
      // Event dunia (Tahap 6): Pasar Bergairah -> −1 poin.
      taxRate: Math.round(getIncomeTaxRate({ one }, await getMyCountry({ one }, req.citizen), wday) * 100 * 100) / 100,
    });
  }));

  // Grafik harga per komoditas (Tahap 4): agregasi harian dari market_tx —
  // data nyata antar pemain, bukan harga acuan. Rata-rata tertimbang volume.
  app.get('/api/market/prices', authRequired, citizenRequired, r(async (req, res) => {
    const scope = req.query.scope === 'global' ? 'global' : 'local';
    const commodityId = Number(req.query.commodity_id) || 0;
    const days = Math.max(1, Math.min(30, Number(req.query.days) || 14));
    if (!commodityId) return res.status(400).json({ error: 'commodity_id wajib diisi.' });
    const since = Date.now() - days * 86400000;
    const rows = await sql(
      'SELECT price_each, qty, created_at FROM market_tx WHERE scope = ? AND commodity_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT 5000',
      [scope, commodityId, since]);
    const byDay = new Map();
    for (const r of rows) {
      const d = new Date(r.created_at).toISOString().slice(0, 10);
      const b = byDay.get(d) || { date: d, tx: 0, volume: 0, sum: 0, min: Infinity, max: -Infinity };
      b.tx += 1; b.volume += r.qty; b.sum += r.price_each * r.qty;
      b.min = Math.min(b.min, r.price_each); b.max = Math.max(b.max, r.price_each);
      byDay.set(d, b);
    }
    res.json({
      scope, commodity_id: commodityId,
      days: [...byDay.values()].map((b) => ({
        date: b.date, tx: b.tx, volume: b.volume,
        avg: round2(b.sum / b.volume), min: b.min, max: b.max,
      })),
    });
  }));

  app.post('/api/market/buy', authRequired, citizenRequired, requireCredit(CREDIT_MIN_FOR.market, 'bertransaksi di pasar'), r(async (req, res) => {
    const { offer_id, qty } = req.body || {};
    const q = Math.max(1, Math.floor(Number(qty) || 1));
    // Atomik: kunci baris penawaran + kedua warga (urut id menaik agar tidak
    // deadlock) + UPDATE bersyarat + cek changes. Dua pembeli paralel pada
    // penawaran yang sama: hanya satu yang berhasil.
    const result = await tx(async (t) => {
      const offer = await t.one(forUpdate('SELECT * FROM market_offers WHERE id = ?'), [offer_id]);
      if (!offer) throw Object.assign(new Error('Penawaran tidak ditemukan.'), { status: 404 });
      if (offer.qty < q) throw Object.assign(new Error('Jumlah penawaran tidak mencukupi.'), { status: 400 });
      const buyerId = req.citizen.id;
      const sellerId = offer.seller_id;
      if (buyerId === sellerId) throw Object.assign(new Error('Tidak bisa membeli penawaran sendiri.'), { status: 400 });
      const [firstId, secondId] = buyerId < sellerId ? [buyerId, sellerId] : [sellerId, buyerId];
      const firstRow = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [firstId]);
      const secondRow = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [secondId]);
      const buyer = buyerId === firstId ? firstRow : secondRow;
      const seller = sellerId === firstId ? firstRow : secondRow;
      const currency = offer.scope === 'global' ? 'gold' : 'usd';
      const sellerCountry = await getMyCountry(t, seller);
      const buyerCountry = await getMyCountry(t, buyer);
      // (Tahap 7) Pajak impor = tarif NEGARA PEMBELI (getImportTaxRate) —
      // sebelumnya selalu konstanta IMPORT_TAX 2% meski negaranya menetapkan
      // tarif lain di kolom tax_import (data mati). Tanpa negara = 2%.
      const importRate = offer.scope === 'global' ? getImportTaxRate(t, buyerCountry) : 0;
      const unitPrice = offer.price * (1 + importRate);
      const total = unitPrice * q;
      // Tarif pajak penghasilan yang berlaku (Tahap 5 — dari UU yang
      // disahkan). Tarif PENJUAL yang berlaku (pajak dipotong dari hasil
      // jualnya). Perjanjian dagang aktif antara organisasi pembeli &
      // penjual memotong pajak setengah.
      // Event dunia (Tahap 6): Pasar Bergairah -> pajak −1 poin.
      const wday = await getWorldDay(t);
      let taxRate = getIncomeTaxRate(t, sellerCountry, wday);
      const pactDiscount = await hasTradePact(t, buyerId, sellerId);
      if (pactDiscount) taxRate *= TRADE_PACT_TAX_MULT;
      const sellerReceives = offer.price * q * (1 - taxRate);
      const pay = await t.run(`UPDATE citizens SET ${currency} = ${currency} - ? WHERE id = ? AND ${currency} >= ?`, [total, buyer.id, total]);
      if (!pay.changes) throw Object.assign(new Error(`Saldo ${currency === 'gold' ? 'emas' : 'Rupiah'} tidak cukup.`), { status: 400 });
      await t.run(`UPDATE citizens SET ${currency} = ${currency} + ? WHERE id = ?`, [sellerReceives, seller.id]);
      // Tahap 4 (BUG-8): pajak masuk kas negara, bukan menguap.
      // Lokal (USD): pajak dari harga jual -> kas negara PENJUAL.
      // Global (emas): pajak penjual -> kas negara penjual; pajak impor
      // (tarif negara pembeli) yang dibayar pembeli -> kas negara PEMBELI.
      // Tanpa negara di salah satu sisi, bagian itu tidak masuk kas mana pun.
      // Tahap 6: wilayah penjual yang dikuasai pemberontak -> pajak penjual
      // mengalir ke panglima perang (paySellerTax), bukan ke kas negara.
      const gross = offer.price * q;
      if (offer.scope === 'global') {
        await paySellerTax(t, 'gold', gross * taxRate,
          `Pajak penjualan ${q} unit (global)`, seller, sellerCountry);
        await recordTreasury(t, 'gold', gross * importRate,
          `Pajak impor ${q} unit (global)`, buyerCountry?.id || null);
      } else {
        await paySellerTax(t, 'usd', gross * taxRate,
          `Pajak penjualan ${q} unit (lokal)`, seller, sellerCountry);
      }
      if (offer.qty === q) {
        const del = await t.run('DELETE FROM market_offers WHERE id = ? AND qty >= ?', [offer.id, q]);
        if (!del.changes) throw Object.assign(new Error('Jumlah penawaran tidak mencukupi.'), { status: 400 });
      } else {
        const upd = await t.run('UPDATE market_offers SET qty = qty - ? WHERE id = ? AND qty >= ?', [q, offer.id, q]);
        if (!upd.changes) throw Object.assign(new Error('Jumlah penawaran tidak mencukupi.'), { status: 400 });
      }
      await addItem(buyer.id, offer.commodity_id, offer.tier, q, t);
      await t.run('INSERT INTO market_tx (buyer_id, seller_id, scope, commodity_id, tier, qty, price_each, total, created_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id',
        [buyer.id, seller.id, offer.scope, offer.commodity_id, offer.tier, q, offer.price, total, Date.now()]);
      await t.run('UPDATE citizens SET purchases = purchases + 1 WHERE id = ?', [buyer.id]);
      // Reputasi dagang (Tahap 6): transaksi selesai menambah 1 hitungan
      // untuk pembeli DAN penjual.
      await t.run('UPDATE citizens SET trades_completed = trades_completed + 1 WHERE id IN (?, ?)', [buyer.id, seller.id]);
      // Tahap 4: pola bolak-balik mencurigakan dicatat untuk ditinjau admin.
      await checkWashTrade(t, buyer.id, seller.id, offer.commodity_id);
      return { total, sellerReceives, currency };
    });
    await chronicleDone(req.citizen, 'buy');
    res.json({ ok: true, ...result });
  }));

  app.post('/api/market/sell', authRequired, citizenRequired, requireCredit(CREDIT_MIN_FOR.market, 'bertransaksi di pasar'), r(async (req, res) => {
    const { scope, commodity_id, tier, qty, price } = req.body || {};
    const q = Math.floor(Number(qty) || 0);
    const p = Number(price);
    if (q < MIN_OFFER_QTY) return res.status(400).json({ error: `Penawaran minimum ${MIN_OFFER_QTY} unit.` });
    if (!p || p <= 0) return res.status(400).json({ error: 'Harga harus lebih dari 0.' });
    const t = Math.max(1, Math.min(5, Number(tier) || 1));
    // Tahap 4: harga di luar batas wajar ditolak + dicatat di market_flags.
    const bad = await enforcePriceBand(commodity_id, t, p, req.citizen.id);
    if (bad) return res.status(400).json({ error: `Harga di luar batas wajar (median 14 hari ${bad.median.toFixed(2)} — batas ${bad.lo.toFixed(2)}–${bad.hi.toFixed(2)}).` });
    // Atomik: kunci baris warga, ambil barang di dalam tx, lalu pasang
    // penawaran — dua jual paralel tidak bisa mengambil stok yang sama.
    const offerId = await tx(async (tx) => {
      await tx.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      const ok = await takeItem(req.citizen.id, commodity_id, t, q, tx);
      if (!ok) throw Object.assign(new Error('Jumlah di inventaris tidak mencukupi.'), { status: 400 });
      const o = await tx.run(
        'INSERT INTO market_offers (seller_id, scope, commodity_id, tier, qty, price, created_at) VALUES (?,?,?,?,?,?,?) RETURNING id',
        [req.citizen.id, scope === 'global' ? 'global' : 'local', commodity_id, t, q, p, Date.now()]);
      return o.id;
    });
    await chronicleDone(req.citizen, 'sell');
    res.json({ ok: true, offerId });
  }));

  app.post('/api/market/cancel', authRequired, citizenRequired, r(async (req, res) => {
    const { offer_id } = req.body || {};
    const offer = await one('SELECT * FROM market_offers WHERE id = ? AND seller_id = ?', [offer_id, req.citizen.id]);
    if (!offer) return res.status(404).json({ error: 'Penawaran tidak ditemukan.' });
    await tx(async (t) => {
      await t.run('DELETE FROM market_offers WHERE id = ?', [offer.id]);
      await addItem(req.citizen.id, offer.commodity_id, offer.tier, offer.qty, t);
    });
    res.json({ ok: true });
  }));

  // ---------- UBAH PENAWARAN (tiket #23 LIO, v3.1.0) ----------
  // "Penawaranku" selama ini hanya bisa dibatalkan — kini bisa diubah
  // tanpa batalkan dulu: tambah/kurangi jumlah dan/atau ubah harga.
  // Jumlah naik -> selisih diambil dari inventaris; jumlah turun ->
  // selisih kembali ke inventaris. Harga berubah -> cek batas wajar
  // (seperti pasang penawaran baru). Hanya pemilik (bukan pemilik -> 404,
  // pola yang sama seperti cancel). Jumlah hasil akhir >= MIN_OFFER_QTY.
  app.patch('/api/market/offers/:id', authRequired, citizenRequired, requireCredit(CREDIT_MIN_FOR.market, 'bertransaksi di pasar'), r(async (req, res) => {
    const { qty, price } = req.body || {};
    const offerId = Number(req.params.id);
    const newQty = qty === undefined ? null : Math.floor(Number(qty));
    const newPrice = price === undefined ? null : Number(price);
    if (newQty !== null && (!Number.isFinite(newQty) || newQty < MIN_OFFER_QTY)) return res.status(400).json({ error: `Jumlah penawaran minimum ${MIN_OFFER_QTY} unit.` });
    if (newPrice !== null && (!Number.isFinite(newPrice) || newPrice <= 0)) return res.status(400).json({ error: 'Harga harus lebih dari 0.' });
    if (newQty === null && newPrice === null) return res.status(400).json({ error: 'Tidak ada perubahan (isi jumlah dan/atau harga baru).' });
    if (newPrice !== null) {
      const offer0 = await one('SELECT * FROM market_offers WHERE id = ? AND seller_id = ?', [offerId, req.citizen.id]);
      if (!offer0) return res.status(404).json({ error: 'Penawaran tidak ditemukan.' });
      const bad = await enforcePriceBand(offer0.commodity_id, offer0.tier, newPrice, req.citizen.id);
      if (bad) return res.status(400).json({ error: `Harga di luar batas wajar (median 14 hari ${bad.median.toFixed(2)} — batas ${bad.lo.toFixed(2)}–${bad.hi.toFixed(2)}).` });
    }
    const updated = await tx(async (t) => {
      const offer = await t.one(forUpdate('SELECT * FROM market_offers WHERE id = ? AND seller_id = ?'), [offerId, req.citizen.id]);
      if (!offer) throw Object.assign(new Error('Penawaran tidak ditemukan.'), { status: 404 });
      const qty2 = newQty ?? offer.qty;
      const price2 = newPrice ?? offer.price;
      if (qty2 > offer.qty) {
        const ok = await takeItem(req.citizen.id, offer.commodity_id, offer.tier, qty2 - offer.qty, t);
        if (!ok) throw Object.assign(new Error('Jumlah di inventaris tidak mencukupi untuk menambah penawaran.'), { status: 400 });
      } else if (qty2 < offer.qty) {
        await addItem(req.citizen.id, offer.commodity_id, offer.tier, offer.qty - qty2, t);
      }
      const upd = await t.run('UPDATE market_offers SET qty = ?, price = ? WHERE id = ? AND qty = ?', [qty2, price2, offer.id, offer.qty]);
      if (!upd.changes) throw Object.assign(new Error('Penawaran sudah berubah.'), { status: 400 });
      return { ...offer, qty: qty2, price: price2 };
    });
    res.json({ ok: true, offer: updated });
  }));

  // ---------- ORDER BELI / ORDER BOOK (Tahap 4) ----------
  // Dana TIDAK dikunci saat order dipasang (aturan pemilik 28 Nov 2026):
  // pembeli baru dipotong saat ada penjual yang memenuhi order lewat
  // sell-to-order — potong + bayar penjual + pindah barang dalam satu
  // transaksi atomik. Tanpa mesin pencocokan otomatis — penjual memilih
  // order yang mau dipenuhi. Semua langkah atomik (pola Tahap 2:
  // FOR UPDATE + UPDATE bersyarat + cek changes).
  app.post('/api/market/buy-order', authRequired, citizenRequired, requireCredit(CREDIT_MIN_FOR.market, 'bertransaksi di pasar'), r(async (req, res) => {
    const { scope, commodity_id, tier, qty, price } = req.body || {};
    const q = Math.floor(Number(qty) || 0);
    const p = Number(price);
    if (q < MIN_OFFER_QTY) return res.status(400).json({ error: `Order beli minimum ${MIN_OFFER_QTY} unit.` });
    if (!p || p <= 0) return res.status(400).json({ error: 'Harga harus lebih dari 0.' });
    const t = Math.max(1, Math.min(5, Number(tier) || 1));
    const sc = scope === 'global' ? 'global' : 'local';
    const bad = await enforcePriceBand(commodity_id, t, p, req.citizen.id);
    if (bad) return res.status(400).json({ error: `Harga di luar batas wajar (median 14 hari ${bad.median.toFixed(2)} — batas ${bad.lo.toFixed(2)}–${bad.hi.toFixed(2)}).` });
    // Order hanya mencatat — saldo pembeli TIDAK dipotong di sini.
    const o = await tx(async (tx) => tx.run(
      'INSERT INTO market_buy_orders (buyer_id, scope, commodity_id, tier, qty, qty_filled, price, created_at) VALUES (?,?,?,?,?,0,?,?) RETURNING id',
      [req.citizen.id, sc, commodity_id, t, q, p, Date.now()]));
    res.json({ ok: true, orderId: o.id });
  }));

  app.post('/api/market/sell-to-order', authRequired, citizenRequired, requireCredit(CREDIT_MIN_FOR.market, 'bertransaksi di pasar'), r(async (req, res) => {
    const { order_id, qty } = req.body || {};
    const q = Math.max(1, Math.floor(Number(qty) || 1));
    const result = await tx(async (t) => {
      const order = await t.one(forUpdate('SELECT * FROM market_buy_orders WHERE id = ?'), [order_id]);
      if (!order) throw Object.assign(new Error('Order beli tidak ditemukan.'), { status: 404 });
      const remaining = order.qty - order.qty_filled;
      if (remaining <= 0) throw Object.assign(new Error('Order beli sudah terpenuhi.'), { status: 400 });
      if (q > remaining) throw Object.assign(new Error(`Order ini tinggal butuh ${remaining} unit.`), { status: 400 });
      const sellerId = req.citizen.id;
      const buyerId = order.buyer_id;
      if (sellerId === buyerId) throw Object.assign(new Error('Tidak bisa menjual ke order beli sendiri.'), { status: 400 });
      const [firstId, secondId] = buyerId < sellerId ? [buyerId, sellerId] : [sellerId, buyerId];
      const firstRow = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [firstId]);
      const secondRow = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [secondId]);
      const buyer = buyerId === firstId ? firstRow : secondRow;
      const seller = sellerId === firstId ? firstRow : secondRow;
      const ok = await takeItem(sellerId, order.commodity_id, order.tier, q, t);
      if (!ok) throw Object.assign(new Error('Jumlah di inventaris tidak mencukupi.'), { status: 400 });
      const currency = order.scope === 'global' ? 'gold' : 'usd';
      const gross = order.price * q;
      // Tarif pajak penghasilan yang berlaku (Tahap 5 — dari UU yang
      // disahkan) + diskon perjanjian dagang antar organisasi. Tarif
      // PENJUAL yang berlaku; pajak masuk kas negara penjual.
      const sellerCountry = await getMyCountry(t, seller);
      // Event dunia (Tahap 6): Pasar Bergairah -> pajak −1 poin.
      const wday = await getWorldDay(t);
      let taxRate = getIncomeTaxRate(t, sellerCountry, wday);
      if (await hasTradePact(t, buyerId, sellerId)) taxRate *= TRADE_PACT_TAX_MULT;
      const sellerReceives = gross * (1 - taxRate);
      // Pembeli dipotong DI SINI (aturan pemilik 28 Nov 2026) — atomik
      // dengan pembayaran penjual + perpindahan barang. Bila saldo pembeli
      // tidak cukup saat order dipenuhi, seluruh penjualan gagal (400) dan
      // tidak ada yang berubah (transaksi dibatalkan utuh).
      const pay = await t.run(`UPDATE citizens SET ${currency} = ${currency} - ? WHERE id = ? AND ${currency} >= ?`, [gross, buyer.id, gross]);
      if (!pay.changes) throw Object.assign(new Error('Saldo pembeli tidak cukup untuk order ini.'), { status: 400 });
      await t.run(`UPDATE citizens SET ${currency} = ${currency} + ? WHERE id = ?`, [sellerReceives, seller.id]);
      const upd = await t.run('UPDATE market_buy_orders SET qty_filled = qty_filled + ? WHERE id = ? AND qty_filled + ? <= qty', [q, order.id, q]);
      if (!upd.changes) throw Object.assign(new Error('Order beli sudah berubah.'), { status: 400 });
      // Terisi penuh: order selesai dan dihapus dari order book (seperti
      // penawaran pasar yang habis dibeli) — tidak ditinggalkan sebagai baris mati.
      if (order.qty_filled + q >= order.qty) {
        await t.run('DELETE FROM market_buy_orders WHERE id = ?', [order.id]);
      }
      await addItem(buyer.id, order.commodity_id, order.tier, q, t);
      await t.run('INSERT INTO market_tx (buyer_id, seller_id, scope, commodity_id, tier, qty, price_each, total, created_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id',
        [buyer.id, seller.id, order.scope, order.commodity_id, order.tier, q, order.price, gross, Date.now()]);
      // Pajak -> kas negara penjual (BUG-8), dengan tarif yang berlaku.
      // Tahap 6: wilayah penjual yang dikuasai pemberontak -> pajak
      // mengalir ke panglima perang (paySellerTax).
      await paySellerTax(t, currency, gross * taxRate, `Pajak penjualan ${q} unit via order beli`, seller, sellerCountry);
      await t.run('UPDATE citizens SET purchases = purchases + 1 WHERE id = ?', [buyer.id]);
      // Reputasi dagang (Tahap 6): transaksi selesai +1 untuk keduanya.
      await t.run('UPDATE citizens SET trades_completed = trades_completed + 1 WHERE id IN (?, ?)', [buyer.id, seller.id]);
      await checkWashTrade(t, buyer.id, seller.id, order.commodity_id);
      return { total: gross, sellerReceives, currency, filled: order.qty_filled + q, qty: order.qty };
    });
    await chronicleDone(req.citizen, 'sell');
    res.json({ ok: true, ...result });
  }));

  app.post('/api/market/buy-order/cancel', authRequired, citizenRequired, r(async (req, res) => {
    const { order_id } = req.body || {};
    const result = await tx(async (t) => {
      const order = await t.one(forUpdate('SELECT * FROM market_buy_orders WHERE id = ? AND buyer_id = ?'), [order_id, req.citizen.id]);
      if (!order) throw Object.assign(new Error('Order beli tidak ditemukan.'), { status: 404 });
      // Tidak ada dana yang dikunci saat order dipasang (aturan pemilik
      // 28 Nov 2026) — batal cukup menghapus order, tanpa refund.
      // refund: 0 dipertahankan di respons agar UI lama tidak rusak.
      const currency = order.scope === 'global' ? 'gold' : 'usd';
      await t.run('DELETE FROM market_buy_orders WHERE id = ?', [order.id]);
      return { refund: 0, currency };
    });
    res.json({ ok: true, ...result });
  }));

  // Ubah order beli (tiket #23 LIO, v3.1.0): jumlah dan/atau harga.
  // Tanpa escrow (aturan v2.3.0) tidak ada dana yang perlu disesuaikan —
  // cukup ubah barisnya. Jumlah tidak boleh di bawah yang sudah terpenuhi
  // (qty_filled) dan tetap >= MIN_OFFER_QTY. Hanya pemilik (404).
  app.patch('/api/market/buy-orders/:id', authRequired, citizenRequired, requireCredit(CREDIT_MIN_FOR.market, 'bertransaksi di pasar'), r(async (req, res) => {
    const { qty, price } = req.body || {};
    const orderId = Number(req.params.id);
    const newQty = qty === undefined ? null : Math.floor(Number(qty));
    const newPrice = price === undefined ? null : Number(price);
    if (newQty !== null && (!Number.isFinite(newQty) || newQty < MIN_OFFER_QTY)) return res.status(400).json({ error: `Order beli minimum ${MIN_OFFER_QTY} unit.` });
    if (newPrice !== null && (!Number.isFinite(newPrice) || newPrice <= 0)) return res.status(400).json({ error: 'Harga harus lebih dari 0.' });
    if (newQty === null && newPrice === null) return res.status(400).json({ error: 'Tidak ada perubahan (isi jumlah dan/atau harga baru).' });
    if (newPrice !== null) {
      const order0 = await one('SELECT * FROM market_buy_orders WHERE id = ? AND buyer_id = ?', [orderId, req.citizen.id]);
      if (!order0) return res.status(404).json({ error: 'Order beli tidak ditemukan.' });
      const bad = await enforcePriceBand(order0.commodity_id, order0.tier, newPrice, req.citizen.id);
      if (bad) return res.status(400).json({ error: `Harga di luar batas wajar (median 14 hari ${bad.median.toFixed(2)} — batas ${bad.lo.toFixed(2)}–${bad.hi.toFixed(2)}).` });
    }
    const updated = await tx(async (t) => {
      const order = await t.one(forUpdate('SELECT * FROM market_buy_orders WHERE id = ? AND buyer_id = ?'), [orderId, req.citizen.id]);
      if (!order) throw Object.assign(new Error('Order beli tidak ditemukan.'), { status: 404 });
      const qty2 = newQty ?? order.qty;
      const price2 = newPrice ?? order.price;
      if (qty2 < order.qty_filled) throw Object.assign(new Error(`Jumlah tidak boleh di bawah ${order.qty_filled} unit yang sudah terpenuhi.`), { status: 400 });
      const upd = await t.run('UPDATE market_buy_orders SET qty = ?, price = ? WHERE id = ? AND qty = ? AND qty_filled = ?', [qty2, price2, order.id, order.qty, order.qty_filled]);
      if (!upd.changes) throw Object.assign(new Error('Order beli sudah berubah.'), { status: 400 });
      return { ...order, qty: qty2, price: price2 };
    });
    res.json({ ok: true, order: updated });
  }));

  // ---------- VALAS ----------
  app.get('/api/fx', authRequired, citizenRequired, r(async (req, res) => {
    const bestSell = await one("SELECT MIN(price) AS price, COUNT(*) AS n FROM fx_offers WHERE direction = 'sell' AND expires_at > ?", [Date.now()]);
    const bestBuy = await one("SELECT MAX(price) AS price, COUNT(*) AS n FROM fx_offers WHERE direction = 'buy' AND expires_at > ?", [Date.now()]);
    const sells = await sql(
      `SELECT o.*, u.username AS citizen_name FROM fx_offers o JOIN citizens c ON c.id = o.citizen_id JOIN users u ON u.id = c.user_id
       WHERE o.direction = 'sell' AND o.expires_at > ? ORDER BY o.price ASC LIMIT 30`, [Date.now()]);
    const buys = await sql(
      `SELECT o.*, u.username AS citizen_name FROM fx_offers o JOIN citizens c ON c.id = o.citizen_id JOIN users u ON u.id = c.user_id
       WHERE o.direction = 'buy' AND o.expires_at > ? ORDER BY o.price DESC LIMIT 30`, [Date.now()]);
    const mine = await sql('SELECT * FROM fx_offers WHERE citizen_id = ? ORDER BY created_at DESC', [req.citizen.id]);
    const history = await sql('SELECT price, volume, created_at FROM fx_history ORDER BY created_at DESC LIMIT 60');
    const since = Date.now() - DAY_MS;
    const stats = await one('SELECT COUNT(*) AS tx, COALESCE(SUM(volume),0) AS volume FROM fx_history WHERE created_at > ?', [since]);
    res.json({
      mint: MINT_RATE,
      bestSell: bestSell?.price ?? null, sellCount: Number(bestSell?.n || 0),
      bestBuy: bestBuy?.price ?? null, buyCount: Number(bestBuy?.n || 0),
      spread: bestSell?.price && bestBuy?.price ? bestSell.price - bestBuy.price : null,
      sells, buys, mine, history: history.reverse(),
      stats: { tx: Number(stats.tx), volume: Number(stats.volume) },
    });
  }));

  app.post('/api/fx/mint', authRequired, citizenRequired, r(async (req, res) => {
    const gold = Math.floor(Number(req.body?.gold) || 0);
    if (gold <= 0) return res.status(400).json({ error: 'Jumlah emas harus lebih dari 0.' });
    // Atomik: kunci baris warga + UPDATE bersyarat (gold >= jumlah).
    await tx(async (t) => {
      await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      const upd = await t.run('UPDATE citizens SET gold = gold - ?, usd = usd + ? WHERE id = ? AND gold >= ?', [gold, gold * MINT_RATE, req.citizen.id, gold]);
      if (!upd.changes) throw Object.assign(new Error('Emas tidak cukup.'), { status: 400 });
    });
    await chronicleDone(req.citizen, 'fx');
    res.json({ ok: true, usd: gold * MINT_RATE });
  }));

  app.post('/api/fx/offer', authRequired, citizenRequired, r(async (req, res) => {
    const { direction, price, qty_gold } = req.body || {};
    if (!['buy', 'sell'].includes(direction)) return res.status(400).json({ error: 'Arah tidak dikenal.' });
    const p = Number(price), q = Number(qty_gold);
    if (!p || p <= 0 || !q || q <= 0) return res.status(400).json({ error: 'Harga dan jumlah harus lebih dari 0.' });
    // Atomik: kunci baris warga — pengecekan "sudah punya penawaran" dan
    // penguncian dana jalan di dalam tx yang sama, jadi dua penawaran
    // paralel ke arah yang sama tidak bisa lolos dua-duanya.
    const offerId = await tx(async (t) => {
      await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      const existing = await t.one('SELECT id FROM fx_offers WHERE citizen_id = ? AND direction = ? AND expires_at > ?', [req.citizen.id, direction, Date.now()]);
      if (existing) throw Object.assign(new Error('Kamu sudah punya 1 penawaran terbuka ke arah ini. Batalkan dulu.'), { status: 400 });
      // Kunci dana: jual -> emas dikunci; beli -> USD dikunci.
      if (direction === 'sell') {
        const upd = await t.run('UPDATE citizens SET gold = gold - ? WHERE id = ? AND gold >= ?', [q, req.citizen.id, q]);
        if (!upd.changes) throw Object.assign(new Error('Emas tidak cukup untuk penawaran jual ini.'), { status: 400 });
      } else {
        const upd = await t.run('UPDATE citizens SET usd = usd - ? WHERE id = ? AND usd >= ?', [p * q, req.citizen.id, p * q]);
        if (!upd.changes) throw Object.assign(new Error('Rupiah tidak cukup untuk penawaran beli ini.'), { status: 400 });
      }
      const o = await t.run('INSERT INTO fx_offers (citizen_id, direction, price, qty_gold, expires_at, created_at) VALUES (?,?,?,?,?,?) RETURNING id',
        [req.citizen.id, direction, p, q, Date.now() + FX_OFFER_TTL_MS, Date.now()]);
      return o.id;
    });
    await chronicleDone(req.citizen, 'fx');
    res.json({ ok: true, offerId });
  }));

  app.post('/api/fx/take', authRequired, citizenRequired, r(async (req, res) => {
    const { offer_id, qty } = req.body || {};
    const q = Number(qty);
    if (!q || q <= 0) return res.status(400).json({ error: 'Jumlah harus lebih dari 0.' });
    // Atomik: kunci baris penawaran + kedua warga (urut id menaik) +
    // UPDATE bersyarat pada saldo dan qty_filled.
    const result = await tx(async (t) => {
      const offer = await t.one(forUpdate('SELECT * FROM fx_offers WHERE id = ? AND expires_at > ?'), [offer_id, Date.now()]);
      if (!offer) throw Object.assign(new Error('Penawaran tidak ditemukan / sudah kedaluwarsa.'), { status: 404 });
      const remaining = offer.qty_gold - offer.qty_filled;
      if (q > remaining) throw Object.assign(new Error('Jumlah melebihi sisa penawaran.'), { status: 400 });
      const meId = req.citizen.id;
      const otherId = offer.citizen_id;
      if (meId === otherId) throw Object.assign(new Error('Tidak bisa mengambil penawaran sendiri.'), { status: 400 });
      const [firstId, secondId] = meId < otherId ? [meId, otherId] : [otherId, meId];
      await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [firstId]);
      await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [secondId]);
      const usd = offer.price * q;
      if (offer.direction === 'sell') {
        // Saya membeli emas: bayar USD, terima emas (emas penjual sudah dikunci saat pasang).
        const upd = await t.run('UPDATE citizens SET usd = usd - ?, gold = gold + ? WHERE id = ? AND usd >= ?', [usd, q, meId, usd]);
        if (!upd.changes) throw Object.assign(new Error('Rupiah tidak cukup.'), { status: 400 });
        await t.run('UPDATE citizens SET usd = usd + ? WHERE id = ?', [usd, otherId]);
      } else {
        // Saya menjual emas ke penawaran beli: terima USD (USD pembeli sudah dikunci).
        const upd = await t.run('UPDATE citizens SET gold = gold - ?, usd = usd + ? WHERE id = ? AND gold >= ?', [q, usd, meId, q]);
        if (!upd.changes) throw Object.assign(new Error('Emas tidak cukup.'), { status: 400 });
        await t.run('UPDATE citizens SET gold = gold + ? WHERE id = ?', [q, otherId]);
      }
      const filled = offer.qty_filled + q;
      if (filled >= offer.qty_gold) await t.run('DELETE FROM fx_offers WHERE id = ?', [offer.id]);
      else {
        const upd = await t.run('UPDATE fx_offers SET qty_filled = qty_filled + ? WHERE id = ? AND qty_filled + ? <= qty_gold', [q, offer.id, q]);
        if (!upd.changes) throw Object.assign(new Error('Jumlah melebihi sisa penawaran.'), { status: 400 });
      }
      await t.run('INSERT INTO fx_history (price, volume, created_at) VALUES (?,?,?) RETURNING id', [offer.price, q, Date.now()]);
      return { usd, gold: q };
    });
    res.json({ ok: true, ...result });
  }));

  app.post('/api/fx/cancel', authRequired, citizenRequired, r(async (req, res) => {
    const { offer_id } = req.body || {};
    const offer = await one('SELECT * FROM fx_offers WHERE id = ? AND citizen_id = ?', [offer_id, req.citizen.id]);
    if (!offer) return res.status(404).json({ error: 'Penawaran tidak ditemukan.' });
    const remaining = offer.qty_gold - offer.qty_filled;
    await tx(async (t) => {
      await t.run('DELETE FROM fx_offers WHERE id = ?', [offer.id]);
      if (offer.direction === 'sell') await t.run('UPDATE citizens SET gold = gold + ? WHERE id = ?', [remaining, req.citizen.id]);
      else await t.run('UPDATE citizens SET usd = usd + ? WHERE id = ?', [offer.price * remaining, req.citizen.id]);
    });
    res.json({ ok: true });
  }));

  // ---------- PETA ----------
  app.get('/api/regions', authRequired, citizenRequired, r(async (req, res) => {
    const rows = await sql(
      `SELECT r.*, c.name AS country_name,
        (SELECT COUNT(*) FROM citizens WHERE region_id = r.id) AS population,
        (SELECT COUNT(*) FROM companies WHERE region_id = r.id) AS companies,
        (SELECT COUNT(*) FROM war_support WHERE region_id = r.id) AS rebellion,
        (SELECT u.username FROM citizens ci JOIN users u ON u.id = ci.user_id WHERE ci.id = r.controller_id) AS controller_name
       FROM regions r LEFT JOIN country c ON c.id = r.country_id ORDER BY r.id`);
    // Waktu tempuh dari LOKASI SAAT INI (27 Nov 2026) + biaya perjalanan
    // dari NEGARA PEMANGGIL (kewarganegaraan, 1 atau 2 Tiket). `home` =
    // wilayah kewarganegaraan pemanggil.
    // Event dunia (Tahap 6): Badai Besar -> semua perjalanan +5 menit.
    const myRegion = await one('SELECT name FROM regions WHERE id = ?', [req.citizen.region_id]);
    const myCountry = await getMyCountry({ one }, req.citizen);
    const wday = await getWorldDay();
    const worldEvent = worldEventFor(wday);
    const extra = worldEvent.key === 'badai' ? 5 : 0;
    const regions = rows.map((r) => ({ ...r, coords: REGION_COORDS[r.name] || null, travelMinutes: r.id === req.citizen.region_id ? 0 : travelMinutesFor(myRegion?.name, r.name) + extra }));
    res.json({ regions, mine: req.citizen.region_id, home: req.citizen.home_region_id, travelTickets: getTravelTickets({ one }, myCountry), worldEvent });
  }));

  app.get('/api/regions/:id', authRequired, citizenRequired, r(async (req, res) => {
    const reg = await one(
      `SELECT r.*, c.name AS country_name,
        (SELECT COUNT(*) FROM citizens WHERE region_id = r.id) AS population,
        (SELECT COUNT(*) FROM companies WHERE region_id = r.id) AS companies,
        (SELECT COUNT(*) FROM war_support WHERE region_id = r.id) AS rebellion,
        (SELECT u.username FROM citizens ci JOIN users u ON u.id = ci.user_id WHERE ci.id = r.controller_id) AS controller_name
       FROM regions r LEFT JOIN country c ON c.id = r.country_id WHERE r.id = ?`, [req.params.id]);
    if (!reg) return res.status(404).json({ error: 'Wilayah tidak ditemukan.' });
    const war = await one("SELECT * FROM wars WHERE region_id = ? AND status = 'active' ORDER BY created_at DESC", [reg.id]);
    const mySupport = await one('SELECT * FROM war_support WHERE region_id = ? AND citizen_id = ?', [reg.id, req.citizen.id]);
    // Angka yang berlaku (Tahap 5 + redesain dunia): pajak ditampilkan dari
    // NEGARA WILAYAH INI (0% + keterangan merdeka bila tidak bernegara);
    // biaya perjalanan dari NEGARA PEMANGGIL (1 atau 2 Tiket).
    const regionCountry = reg.country_id ? await one('SELECT * FROM country WHERE id = ?', [reg.country_id]) : null;
    const myCountry = await getMyCountry({ one }, req.citizen);
    const myRegion = await one('SELECT name FROM regions WHERE id = ?', [req.citizen.region_id]);
    // Demografi (Tahap 6): sebaran level warga yang berdomisili di wilayah
    // ini (home_region_id) + kekuatan militer total mereka.
    const demo = await one(
      `SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN level < 5 THEN 1 ELSE 0 END), 0) AS pemula,
        COALESCE(SUM(CASE WHEN level >= 5 AND level < 10 THEN 1 ELSE 0 END), 0) AS aktif,
        COALESCE(SUM(CASE WHEN level >= 10 THEN 1 ELSE 0 END), 0) AS veteran,
        COALESCE(ROUND(AVG(level), 1), 0) AS avgLevel
       FROM citizens WHERE home_region_id = ?`, [reg.id]);
    const milRows = await sql(
      'SELECT mu.unit_type, mu.qty FROM military_units mu JOIN citizens c ON c.id = mu.citizen_id WHERE c.home_region_id = ?', [reg.id]);
    const regionPower = militaryPowerFor(milRows.map((x) => ({ type: x.unit_type, qty: x.qty })));
    // Event dunia (Tahap 6): Badai Besar -> perjalanan +5 menit;
    // Pasar Bergairah -> pajak −1 poin (lewat getIncomeTaxRate).
    const wday = await getWorldDay();
    const worldEvent = worldEventFor(wday);
    const travelExtra = worldEvent.key === 'badai' ? 5 : 0;
    res.json({ region: reg, war, mySupport: !!mySupport, mine: req.citizen.region_id === reg.id, home: req.citizen.home_region_id === reg.id, travelTickets: getTravelTickets({ one }, myCountry), travelMinutes: reg.id === req.citizen.region_id ? 0 : travelMinutesFor(myRegion?.name, reg.name) + travelExtra, taxIncome: Math.round(getIncomeTaxRate({ one }, regionCountry, wday) * 100 * 100) / 100, country: countrySummary(regionCountry), demographics: { total: Number(demo.total), pemula: Number(demo.pemula), aktif: Number(demo.aktif), veteran: Number(demo.veteran), avgLevel: Number(demo.avgLevel) }, regionPower, worldEvent });
  }));

  app.post('/api/regions/travel', authRequired, citizenRequired, r(async (req, res) => {
    const { region_id } = req.body || {};
    const c = req.citizen;
    const target = await one('SELECT * FROM regions WHERE id = ?', [region_id]);
    if (!target) return res.status(404).json({ error: 'Wilayah tidak ditemukan.' });
    // TRAVEL = KUNJUNGAN (27 Nov 2026): bepergian TIDAK memindahkan
    // kewarganegaraan — home_region_id tetap. Perjalanan butuh WAKTU
    // TEMPUH berdasar jarak ibu kota (travelMinutesFor: 2 + 1 mnt/100 km,
    // 2–30 mnt); warga tiba saat jam tiba tercapai — kedatangan diselesaikan
    // malas oleh loadCitizen (settleTravel) saat data warga dibaca.
    // Biaya perjalanan dari UU negara PEMANGGIL yang berlaku (Tahap 5):
    // 1 atau 2 Tiket — TIDAK BERUBAH. Tanpa negara = 1 Tiket.
    const ticketsNeeded = getTravelTickets({ one }, await getMyCountry({ one }, c));
    const from = await one('SELECT name FROM regions WHERE id = ?', [c.region_id]);
    // Event dunia (Tahap 6): Badai Besar -> perjalanan +5 menit.
    const wday = await getWorldDay();
    const minutes = travelMinutesFor(from?.name, target.name) + (worldEventFor(wday).key === 'badai' ? 5 : 0);
    const arrivesAt = Date.now() + minutes * 60 * 1000;
    // Atomik: kunci baris warga, pakai tiket + catat perjalanan di dalam tx.
    await tx(async (t) => {
      const locked = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [c.id]);
      if (locked.travel_to_region_id) throw Object.assign(new Error('Kamu sedang dalam perjalanan. Tunggu sampai tiba dulu.'), { status: 400 });
      if (locked.region_id === target.id) throw Object.assign(new Error('Kamu sudah berada di wilayah ini.'), { status: 400 });
      // Tiket: pakai T1 dulu, lalu tingkat lebih tinggi — sebanyak yang
      // dibutuhkan UU saat ini (1 atau 2).
      const ticket = await t.one('SELECT id FROM commodities WHERE name = ?', ['Tiket']);
      let used = 0;
      for (let tier = 1; tier <= 5 && used < ticketsNeeded; tier++) {
        let remaining = ticketsNeeded - used;
        while (remaining > 0) {
          if (await takeItem(locked.id, ticket.id, tier, 1, t)) { used++; remaining--; }
          else break;
        }
      }
      if (used < ticketsNeeded) throw Object.assign(new Error(`Butuh ${ticketsNeeded} Tiket untuk bepergian. Beli di pasar.`), { status: 400 });
      await t.run('UPDATE citizens SET travel_to_region_id = ?, travel_arrives_at = ? WHERE id = ?', [target.id, arrivesAt, locked.id]);
    });
    await chronicleDone(c, 'travel');
    res.json({ ok: true, region: target.name, travelMinutes: minutes, arrivesAt, inTransit: true });
  }));

  // ---------- PINDAH KEWARGANEGARAAN (27 Nov 2026) ----------
  // Aksi TERPISAH dari travel: hanya lewat endpoint ini home_region_id
  // berubah. Syarat: (1) tidak sedang dalam perjalanan, (2) target harus
  // wilayah tempat warga BERADA SAAT INI (harus bepergian dulu ke sana —
  // pindah kewarganegaraan tanpa mengunjungi wilayahnya tidak mungkin),
  // (3) target bukan wilayah asal saat ini, (4) jeda 7 hari sejak pindah
  // terakhir (anti-lompat pemilu/unifikasi). GRATIS — biayanya adalah
  // tiket perjalanan + jedanya. Negara/pajak/voting mengikuti wilayah
  // asal BARU begitu pindah (getMyCountry membaca home_region_id).
  app.post('/api/regions/move', authRequired, citizenRequired, r(async (req, res) => {
    const { region_id } = req.body || {};
    const c = req.citizen;
    const target = await one('SELECT * FROM regions WHERE id = ?', [region_id]);
    if (!target) return res.status(404).json({ error: 'Wilayah tidak ditemukan.' });
    if (c.travel_to_region_id) return res.status(400).json({ error: 'Kamu sedang dalam perjalanan. Pindah kewarganegaraan bisa dilakukan setelah tiba.' });
    if (c.region_id !== target.id) return res.status(400).json({ error: `Kamu harus berada di ${target.name} dulu untuk pindah kewarganegaraan ke sana. Bepergian ke sana dulu.` });
    if (c.home_region_id === target.id) return res.status(400).json({ error: `${target.name} sudah menjadi wilayah kewarganegaraanmu.` });
    if (c.home_changed_at && Date.now() - c.home_changed_at < MOVE_COOLDOWN_MS) {
      const days = Math.ceil((c.home_changed_at + MOVE_COOLDOWN_MS - Date.now()) / (DAY_MS));
      return res.status(400).json({ error: `Pindah kewarganegaraan bisa dilakukan lagi dalam ${days} hari.` });
    }
    // UPDATE bersyarat = penjaga race: bila perjalanan dimulai bersamaan
    // atau jeda belum lewat, perubahan tidak terjadi (changes = 0).
    const upd = await run(
      'UPDATE citizens SET home_region_id = ?, home_changed_at = ? WHERE id = ? AND travel_to_region_id IS NULL AND region_id = ? AND home_region_id <> ? AND (home_changed_at = 0 OR home_changed_at <= ?)',
      [target.id, Date.now(), c.id, target.id, target.id, Date.now() - MOVE_COOLDOWN_MS]);
    if (!upd.changes) return res.status(400).json({ error: 'Tidak bisa pindah kewarganegaraan sekarang. Pastikan kamu sudah tiba, sedang berada di wilayah tujuan, dan jeda 7 hari sudah lewat.' });
    const country = await getMyCountry({ one }, { ...c, home_region_id: target.id });
    await notify(c.id, 'SISTEM', 'Kewarganegaraan pindah', `Kewarganegaraanmu kini ${target.name}${country ? ` — kamu kini warga ${country.name}.` : ' (belum bernegara).'}`);
    res.json({ ok: true, region: target.name, country: country ? country.name : null });
  }));

  app.post('/api/regions/rebel', authRequired, citizenRequired, r(async (req, res) => {
    const { region_id } = req.body || {};
    // Atomik: kunci baris wilayah (men-serialisasi dukungan di wilayah yang
    // sama — dua perang tidak bisa dimulai bersamaan) + kunci baris warga +
    // INSERT ... ON CONFLICT DO NOTHING untuk dukungan + potong emas bersyarat.
    const result = await tx(async (t) => {
      const reg = await t.one(forUpdate('SELECT * FROM regions WHERE id = ?'), [region_id]);
      if (!reg) throw Object.assign(new Error('Wilayah tidak ditemukan.'), { status: 404 });
      const c = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      const existing = await t.one('SELECT * FROM war_support WHERE region_id = ? AND citizen_id = ?', [region_id, c.id]);
      if (existing) throw Object.assign(new Error('Kamu sudah mendukung pemberontakan di wilayah ini.'), { status: 400 });
      const cost = reg.name === REBEL_CAPITAL_NAME ? REBEL_COST_CAPITAL : REBEL_COST; // ibu kota lebih mahal
      const active = await t.one("SELECT * FROM wars WHERE region_id = ? AND status = 'active'", [region_id]);
      if (active) throw Object.assign(new Error('Sudah ada perang aktif di wilayah ini.'), { status: 400 });
      const upd = await t.run('UPDATE citizens SET gold = gold - ? WHERE id = ? AND gold >= ?', [cost, c.id, cost]);
      if (!upd.changes) throw Object.assign(new Error(`Dukung pemberontakan butuh ${cost} emas (hangus).`), { status: 400 });
      const ins = await t.run('INSERT INTO war_support (region_id, citizen_id) VALUES (?,?) ON CONFLICT DO NOTHING RETURNING region_id', [region_id, c.id]);
      if (!ins.changes) throw Object.assign(new Error('Kamu sudah mendukung pemberontakan di wilayah ini.'), { status: 400 });
      const count = await t.one('SELECT COUNT(*) AS n FROM war_support WHERE region_id = ?', [region_id]);
      let warStarted = false;
      if (Number(count.n) >= 5) {
        // Pembela = nama negara pemilik wilayah, atau 'Pembela <Wilayah>'
        // bila wilayah merdeka (redesain dunia — tidak ada lagi RI).
        // Tahap 6: bila wilayah dikuasai pemberontak, pembelanya adalah
        // panglima perang yang sedang berkuasa (namanya).
        const ownerCountry = reg.country_id ? await t.one('SELECT name FROM country WHERE id = ?', [reg.country_id]) : null;
        const warlord = reg.controller === 'pemberontak' && reg.controller_id
          ? await t.one('SELECT u.username FROM citizens ci JOIN users u ON u.id = ci.user_id WHERE ci.id = ?', [reg.controller_id])
          : null;
        const defenderLabel = warlord?.username || ownerCountry?.name || `Pembela ${reg.name}`;
        await t.run(
          `INSERT INTO wars (name, region_id, attacker_label, defender_label, ends_at, created_at) VALUES (?,?,?,?,?,?) RETURNING id`,
          [`Pemberontakan ${reg.name}`, region_id, `Pemberontak ${reg.name}`, defenderLabel, Date.now() + WAR_DURATION_MS, Date.now()]);
        await t.run('DELETE FROM war_support WHERE region_id = ?', [region_id]);
        warStarted = true;
      }
      return { supporters: Number(count.n), warStarted };
    });
    res.json({ ok: true, ...result });
  }));

  // ---------- KONVOI ----------
  app.get('/api/convoy', authRequired, citizenRequired, r(async (req, res) => {
    const c = req.citizen;
    const slots = 1 + (c.level >= 25 ? 1 : 0) + (c.level >= 50 ? 1 : 0) + (c.level >= 100 ? 1 : 0) + (c.premium_until > Date.now() ? 1 : 0);
    const rows = await sql('SELECT * FROM convoys WHERE citizen_id = ? ORDER BY slot', [c.id]);
    // Jumlah bahan yang dimiliki per resep (tiket #20): UI menampilkan
    // "punya X / butuh Y" sebelum membangun.
    const inv = await sql('SELECT i.qty, c.name FROM inventory i JOIN commodities c ON c.id = i.commodity_id WHERE i.citizen_id = ? AND i.tier = 1', [c.id]);
    const owned = Object.fromEntries(inv.map((x) => [x.name, x.qty]));
    const buildings = CONVOY_BUILDINGS.map((b) => ({
      ...b,
      cost: b.cost.map((it) => ({ ...it, owned: owned[it.name] || 0 })),
    }));
    res.json({ slots, used: rows.length, convoys: rows, buildings });
  }));

  app.post('/api/convoy/build', authRequired, citizenRequired, r(async (req, res) => {
    const { building } = req.body || {};
    const def = CONVOY_BUILDINGS.find((b) => b.type === building);
    if (!def) return res.status(400).json({ error: 'Bangunan tidak dikenal.' });
    const c = req.citizen;
    const slots = 1 + (c.level >= 25 ? 1 : 0) + (c.level >= 50 ? 1 : 0) + (c.level >= 100 ? 1 : 0) + (c.premium_until > Date.now() ? 1 : 0);
    // Biaya BAHAN (tiket #20 LIO, v3.1.0) — bukan lagi 10 emas. Atomik:
    // kunci baris warga, cek slot + cek SEMUA bahan dulu, baru potong
    // semuanya; bila satu bahan kurang, tidak ada yang terpotong.
    const convoyId = await tx(async (t) => {
      await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [c.id]);
      const existing = await t.sql('SELECT * FROM convoys WHERE citizen_id = ?', [c.id]);
      if (existing.length >= slots) throw Object.assign(new Error('Slot konvoi penuh. Naik level / Premium untuk slot tambahan.'), { status: 400 });
      if (existing.some((x) => x.building === building)) throw Object.assign(new Error('Satu bangunan per jenis dalam satu waktu.'), { status: 400 });
      const missing = [];
      const items = [];
      for (const it of def.cost) {
        const com = await t.one('SELECT * FROM commodities WHERE name = ?', [it.name]);
        if (!com) throw Object.assign(new Error(`Bahan ${it.name} tidak dikenal.`), { status: 500 });
        const stock = await t.one(forUpdate('SELECT * FROM inventory WHERE citizen_id = ? AND commodity_id = ? AND tier = 1'), [c.id, com.id]);
        const have = stock?.qty || 0;
        if (have < it.qty) missing.push(`${it.name} ${have}/${it.qty}`);
        items.push({ com, stock, qty: it.qty });
      }
      if (missing.length) throw Object.assign(new Error(`Bahan tidak cukup: ${missing.join(', ')}.`), { status: 400 });
      for (const it of items) {
        const ok = await takeItem(c.id, it.com.id, 1, it.qty, t);
        if (!ok) throw Object.assign(new Error('Bahan tidak cukup.'), { status: 400 });
      }
      const slot = existing.length;
      const cv = await t.run('INSERT INTO convoys (citizen_id, slot, building, region_id, expires_at, created_at) VALUES (?,?,?,?,?,?) RETURNING id',
        [c.id, slot, building, c.region_id, Date.now() + 7 * DAY_MS, Date.now()]);
      return cv.id;
    });
    res.json({ ok: true, convoyId });
  }));

  app.post('/api/convoy/demolish', authRequired, citizenRequired, r(async (req, res) => {
    const { id } = req.body || {};
    const cv = await one('SELECT * FROM convoys WHERE id = ? AND citizen_id = ?', [id, req.citizen.id]);
    if (!cv) return res.status(404).json({ error: 'Konvoi tidak ditemukan.' });
    await run('DELETE FROM convoys WHERE id = ?', [id]);
    res.json({ ok: true });
  }));

  // ---------- TOKO & DUNIA ----------
  app.get('/api/shop', authRequired, r(async (req, res) => {
    res.json({ packages: SHOP_PACKAGES, premium: SHOP_PREMIUM, perks: PREMIUM_PERKS, waUrl: WA_TOPUP_URL });
  }));

  // Cache /api/world 30 detik (Tahap 5 — lag): isinya (hari, populasi,
  // jumlah wilayah, jumlah online) berubah lambat — populasi hanya berubah
  // saat ada pendaftaran/perjalanan, dan angka online ikut ter-cache 30
  // detik (jendela 5 menit, jadi tetap segar). Di serverless, cache per
  // instance ini menghemat 3-4 query DB di setiap panggilan saat instance
  // masih hangat.
  // Data per pemain (ME, chat) TIDAK di-cache — hanya data dunia bersama.
  let worldCache = null;
  let worldCacheAt = 0;
  app.get('/api/world', r(async (req, res) => {
    const now = Date.now();
    if (worldCache && now - worldCacheAt < 30 * 1000) return res.json(worldCache);
    const world = await one('SELECT * FROM world WHERE id = 1');
    const population = await one('SELECT COUNT(*) AS n FROM citizens');
    const regions = await one('SELECT COUNT(*) AS n FROM regions');
    const countries = await one('SELECT COUNT(*) AS n FROM country');
    const day = world?.day || 1;
    // Event dunia minggu ini (Tahap 6) — publik, supaya landing + dashboard
    // bisa menampilkan event yang sedang berlaku tanpa login.
    worldCache = { version: VERSION, day, population: Number(population.n), regions: Number(regions.n), countries: Number(countries.n), onlineCount: await countOnline(), event: worldEventFor(day) };
    worldCacheAt = now;
    res.json(worldCache);
  }));

  // ---------- STATISTIK DUNIA (UI batch 2, ala Parlamentum) ----------
  // Semua angka dihitung langsung dari DB — tanpa data palsu. Definisi:
  // - perang diumumkan: jumlah perang (wars) — semua perang di dunia ini
  //   lahir dari pemberontakan (POST /api/regions/rebel).
  // - pemberontakan: jumlah dukungan pemberontakan AKTIF saat ini
  //   (war_support); baris dukungan dihapus begitu perang dimulai, jadi
  //   ini bukan duplikat hitungan perang.
  // - kerusakan: total damage dari war_attacks; senjata digunakan: jumlah
  //   serangan (1 senjata per serangan).
  // - bangunan berdiri: konvoi yang masih aktif (expires_at > sekarang).
  // - kontrak disepakati: transaksi pasar (market_tx) — sama seperti
  //   halaman KONTRAK: tiap pembelian di pasar tercatat sebagai kontrak.
  // - warga terbanyak: dihitung per WILAYAH (pasca-redesain dunia, negara
  //   dibentuk pemain; wilayah tanpa negara tetap dihitung).
  app.get('/api/stats', authRequired, citizenRequired, r(async (req, res) => {
    const warsTotal = await one('SELECT COUNT(*) AS n FROM wars');
    const warsActive = await one("SELECT COUNT(*) AS n FROM wars WHERE status = 'active'");
    const rebelRows = await sql('SELECT region_id FROM war_support');
    const dmg = await one('SELECT COALESCE(SUM(damage), 0) AS total, COUNT(*) AS attacks FROM war_attacks');
    const buildings = await one('SELECT COUNT(*) AS n FROM convoys WHERE expires_at > ?', [Date.now()]);
    const articles = await one('SELECT COUNT(*) AS n FROM articles');
    const papers = await one('SELECT COUNT(*) AS n FROM newspapers');
    const contracts = await one('SELECT COUNT(*) AS n FROM market_tx');
    const partiesN = await one('SELECT COUNT(*) AS n FROM parties');
    const companiesN = await one('SELECT COUNT(*) AS n FROM companies');
    const population = await one('SELECT COUNT(*) AS n FROM citizens');
    const regionsN = await one('SELECT COUNT(*) AS n FROM regions');
    const countriesN = await one('SELECT COUNT(*) AS n FROM country');
    const freeRegions = await one('SELECT COUNT(*) AS n FROM regions WHERE country_id IS NULL');
    // "PEMIMPIN TIAP DAFTAR" mengikuti KEWARGANEGARAAN (home_region_id):
    // Level Tertinggi menampilkan wilayah asal + negara asal pemain.
    const topLevel = (await sql(`SELECT u.username, c.level, c.xp, c.last_seen_at, r.name AS region_name, co.name AS country_name
      FROM citizens c JOIN users u ON u.id = c.user_id JOIN regions r ON r.id = c.home_region_id
      LEFT JOIN country co ON co.id = r.country_id ORDER BY c.level DESC, c.xp DESC LIMIT 3`))
      // Status online per warga (v4.3.0, saran LIO): tiap baris membawa
      // flag online + label siap tampil, seperti /api/profile.
      .map((x) => ({ ...x, ...onlineStatus(x.last_seen_at) }));
    const topRegions = await sql(`SELECT r.id, r.name, r.type, COUNT(c.id) AS citizens, co.name AS country_name
      FROM regions r LEFT JOIN citizens c ON c.home_region_id = r.id LEFT JOIN country co ON co.id = r.country_id
      GROUP BY r.id, r.name, r.type, co.name ORDER BY citizens DESC, r.name ASC LIMIT 3`);
    const topParties = await sql(`SELECT p.id, p.name, p.tag, COUNT(pm.citizen_id) AS members
      FROM parties p LEFT JOIN party_members pm ON pm.party_id = p.id
      GROUP BY p.id, p.name, p.tag ORDER BY members DESC, p.name ASC LIMIT 3`);
    // Kartu wilayahku (dashboard): skor kota, peringkat, infrastruktur,
    // kapasitas, bonus sumber daya, dukungan pemberontakan aktif.
    const myRegion = await one(`SELECT r.*, c.name AS country_name,
      (SELECT COUNT(*) FROM citizens WHERE region_id = r.id) AS population,
      (SELECT COUNT(*) FROM companies WHERE region_id = r.id) AS companies,
      (SELECT COUNT(*) FROM war_support WHERE region_id = r.id) AS rebellion
      FROM regions r LEFT JOIN country c ON c.id = r.country_id WHERE r.id = ?`, [req.citizen.region_id]);
    const rankRow = await one('SELECT COUNT(*) AS n FROM regions WHERE city_score > ?', [myRegion.city_score]);
    const warActive = await one("SELECT COUNT(*) AS n FROM wars WHERE region_id = ? AND status = 'active'", [req.citizen.region_id]);
    const mySupport = await one('SELECT COUNT(*) AS n FROM war_support WHERE region_id = ? AND citizen_id = ?', [req.citizen.region_id, req.citizen.id]);
    const myCountryCitizens = myRegion.country_id
      ? await one('SELECT COUNT(*) AS n FROM citizens c JOIN regions r ON r.id = c.home_region_id WHERE r.country_id = ?', [myRegion.country_id])
      : { n: 0 };
    // Daftar lengkap (?full=level|regions|parties, maks 50) untuk LIHAT SEMUA.
    const full = req.query.full;
    let fullList = null;
    if (full === 'level') {
      fullList = (await sql(`SELECT u.username, c.level, c.xp, c.last_seen_at, r.name AS region_name, co.name AS country_name
        FROM citizens c JOIN users u ON u.id = c.user_id JOIN regions r ON r.id = c.home_region_id
        LEFT JOIN country co ON co.id = r.country_id ORDER BY c.level DESC, c.xp DESC LIMIT 50`))
        .map((x) => ({ ...x, ...onlineStatus(x.last_seen_at) }));
    } else if (full === 'regions') {
      fullList = await sql(`SELECT r.id, r.name, r.type, COUNT(c.id) AS citizens, co.name AS country_name
        FROM regions r LEFT JOIN citizens c ON c.home_region_id = r.id LEFT JOIN country co ON co.id = r.country_id
        GROUP BY r.id, r.name, r.type, co.name ORDER BY citizens DESC, r.name ASC LIMIT 50`);
    } else if (full === 'parties') {
      fullList = await sql(`SELECT p.id, p.name, p.tag, COUNT(pm.citizen_id) AS members
        FROM parties p LEFT JOIN party_members pm ON pm.party_id = p.id
        GROUP BY p.id, p.name, p.tag ORDER BY members DESC, p.name ASC LIMIT 50`);
    }
    res.json({
      world: {
        wars: Number(warsTotal.n), warsActive: Number(warsActive.n),
        rebellions: rebelRows.length, rebellionRegions: new Set(rebelRows.map((x) => x.region_id)).size,
        damage: Number(dmg.total), weapons: Number(dmg.attacks),
        buildings: Number(buildings.n), articles: Number(articles.n),
        newspapers: Number(papers.n), contracts: Number(contracts.n),
        parties: Number(partiesN.n), companies: Number(companiesN.n),
        population: Number(population.n), regions: Number(regionsN.n),
        countries: Number(countriesN.n), freeRegions: Number(freeRegions.n),
      },
      topLevel, topRegions, topParties, fullList,
      myRegion: { ...myRegion, rank: Number(rankRow.n) + 1, warActive: Number(warActive.n) > 0, mySupport: Number(mySupport.n) > 0, countryCitizens: Number(myCountryCitizens.n) },
    });
  }));
}
