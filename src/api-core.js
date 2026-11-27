// API inti Parlementer: auth (email+password), dashboard, pekerjaan, perusahaan,
// pasar, valas, peta, inventaris, konvoi, misi, kronik, pencapaian, notifikasi, profil, toko.
import bcrypt from 'bcryptjs';
import { sql, one, run, tx, forUpdate, generateReferralCode, convoyBuildings } from './db.js';
import {
  signToken, cookieOptions, COOKIE_NAME, authRequired, citizenRequired,
  loadCitizen, isValidEmail, isValidUsername, todayStr, publicId,
  getUserIdFromReq, bootstrapCodeMatches, fmtRp,
} from './util.js';
import { dbRateLimit } from './rate-limit.js';
import { getCountryRow, getIncomeTaxRate, getAdminPayMult, getTravelTickets, hasTradePact, budgetActive } from './api-civic.js';
import {
  WA_TOPUP_URL, MINT_RATE, IMPORT_TAX, MIN_OFFER_QTY, TRADE_PACT_TAX_MULT,
  xpForLevel, xpGainForShift, shiftSalary, fatigueMult, trainCost, trainCostDiscounted, trainCooldownMs, formatCooldownMs, foodEnergy,
  energyCapFor, DAILY_MISSIONS, CHRONICLE,
  ACHIEVEMENTS, achievementProgress, COMPANY_TYPES, RESOURCE_PRODUCTS,
  DAILY_PRODUCTION, SHOP_PACKAGES, SHOP_PREMIUM, PREMIUM_PERKS, CONVOY_BUILDINGS,
  PRICE_BAND, WASH_TRADE,
} from './game.js';

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

  // Bonus referral (pemilik kode +100 emas + 2 hari premium; pendaftar
  // +50 emas + 1 hari premium) — dibayar SEKALI saat pendaftar mencapai
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
  async function missionProgress(citizen) {
    return JSON.parse(citizen.missions || '{}');
  }
  async function setMission(citizen, key, value) {
    const m = await missionProgress(citizen);
    m[key] = value;
    await run('UPDATE citizens SET missions = ? WHERE id = ?', [JSON.stringify(m), citizen.id]);
  }
  async function chronicleDone(citizen, key) {
    const done = JSON.parse(citizen.chronicle_done || '[]');
    if (!done.includes(key)) {
      done.push(key);
      await run('UPDATE citizens SET chronicle_done = ? WHERE id = ?', [JSON.stringify(done), citizen.id]);
    }
  }

  // ---------- EKONOMI TAHAP 4: kas negara, batas harga, tanda pasar ----------
  const round2 = (n) => Math.round(n * 100) / 100;
  // Pajak pasar -> kas negara (BUG-8). Dipanggil DI DALAM tx yang sama
  // dengan transaksinya. amount dibulatkan ke 2 desimal; nol dilewati.
  async function recordTreasury(t, currency, amount, note) {
    const a = round2(amount);
    if (a <= 0) return;
    const col = currency === 'gold' ? 'treasury' : 'treasury_usd';
    await t.run(`UPDATE country SET ${col} = ${col} + ? WHERE id = 1`, [a]);
    await t.run('INSERT INTO treasury_tx (kind, currency, amount, note, created_at) VALUES (?,?,?,?,?) RETURNING id',
      ['pajak_pasar', currency, a, note, Date.now()]);
  }
  // Batas harga wajar: median harga transaksi 14 hari terakhir untuk
  // komoditas+tier yang sama. Butuh ≥3 transaksi pembanding; pasar yang
  // masih kosong tidak dibatasi.
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
  // Bonus referral: pemilik kode +100 emas + 2 hari premium; pendaftar baru
  // +50 emas + 1 hari premium — dibayar saat pendaftar mencapai Level 3
  // (bukan saat daftar) dan maks 5 bonus terbayar/hari/pemilik kode.
  // Premium diperpanjang dari premium_until yang masih aktif, atau dari
  // sekarang bila tidak aktif. Bonus dicatat di referral_pending.
  const REFERRER_GOLD = 100;
  const REFERRER_PREMIUM_MS = 2 * 24 * 60 * 60 * 1000;
  const NEWCOMER_GOLD = 50;
  const NEWCOMER_PREMIUM_MS = 1 * 24 * 60 * 60 * 1000;
  const MAX_PASSWORD_BYTES = 72; // bcrypt memotong password di atas 72 byte

  // Registrasi dibatasi 20/IP/24 jam (anti multi-akun massal, DB-backed).
  // Tes e2e mendaftar 15 akun dari 127.0.0.1 — di bawah batas ini.
  const registerRateLimit = dbRateLimit({
    keyFn: (req) => 'register:' + (req.ip || 'unknown'),
    max: 20,
    windowMs: 24 * 60 * 60 * 1000,
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
    const hash = await bcrypt.hash(password, 10);
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
      const startRegion = await t.one('SELECT id FROM regions ORDER BY RANDOM() LIMIT 1');
      const startRegionId = startRegion ? startRegion.id : 1;
      const citizen = await t.run(
        `INSERT INTO citizens (user_id, level, xp, energy, energy_updated_at, gold, usd, region_id, home_region_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        [user.id, 1, 0, 100, now, 50, 500, startRegionId, startRegionId, now]);
      // Paket awal: 3 Makanan T1, 3 Senjata T1, 3 Tiket T1.
      for (const name of ['Makanan', 'Senjata', 'Tiket']) {
        const com = await t.one('SELECT id FROM commodities WHERE name = ?', [name]);
        await addItem(citizen.id, com.id, 1, 3, t);
      }
      await t.run('INSERT INTO notifications (citizen_id, category, title, content, created_at) VALUES (?,?,?,?,?) RETURNING id',
        [citizen.id, 'SISTEM', 'Selamat datang di Parlementer!',
          'Kamu warga baru Republik Indonesia. Ambil pasokan harianmu dan cari pekerjaan dari ADMIN untuk modal awal.', now]);
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
    const ok = await bcrypt.compare(password, user.pass_hash);
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
  const ONLINE_WINDOW_MS = 5 * 60 * 1000;
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
    const region = await one('SELECT * FROM regions WHERE id = ?', [c.region_id]);
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
    const votingLaws = await sql("SELECT l.*, u.username AS proposer FROM laws l JOIN citizens c ON c.id = l.proposer_id JOIN users u ON u.id = c.user_id WHERE l.status = 'voting' AND l.ends_at > ? ORDER BY l.ends_at ASC", [Date.now()]);
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
    const country = await getCountryRow({ one });
    const budgetTrain = budgetActive(country) === 'train';
    const trainCosts = {};
    for (const [key, col] of [['strength', 'attr_str'], ['strategy', 'attr_edu'], ['charisma', 'attr_eco']]) {
      const base = trainCost(c[col]);
      let cost = buildings.has('education') ? trainCostDiscounted(base) : base;
      if (budgetTrain) cost = Math.max(1, Math.round(cost * 0.9));
      trainCosts[key] = cost;
    }
    // Jeda latihan per atribut (2 menit × level): tombol LATIH di
    // dashboard memakai ini supaya tidak perlu request tambahan. Level
    // yang dipakai = level saat ini — sama dengan level baru setelah
    // latih terakhir, karena atribut hanya naik lewat latihan.
    const trainCooldowns = {};
    for (const [key, col, trainCol] of [['strength', 'attr_str', 'train_str_at'], ['strategy', 'attr_edu', 'train_edu_at'], ['charisma', 'attr_eco', 'train_eco_at']]) {
      const cdMs = trainCooldownMs(c[col]);
      const remainingMs = Math.max(0, (c[trainCol] || 0) + cdMs - Date.now());
      trainCooldowns[key] = { remainingMs, cooldownMs: cdMs, availableAt: remainingMs > 0 ? (c[trainCol] || 0) + cdMs : null };
    }
    const refUses = await one('SELECT COUNT(*) AS n FROM users WHERE referred_by = ?', [c.user_id]);
    const refPaid = await one("SELECT COUNT(*) AS n FROM referral_pending WHERE referrer_id = ? AND status = 'paid'", [c.user_id]);
    const referral = {
      code: c.referral_code,
      uses: Number(refUses.n),
      // goldEarned = bonus yang SUDAH CAIR (Level 3), bukan total pendaftar.
      goldEarned: Number(refPaid.n) * 100,
    };
    res.json({
      user: {
        id: c.user_id, publicId: publicId(c.user_id), email: c.email, username: c.username,
        avatar: c.avatar || null,
        is_admin: !!c.is_admin, is_banned: !!c.is_banned, banned_reason: c.banned_reason || '',
      },
      citizen: { ...c, isPremium, energyCap, trainCosts, trainCooldowns },
      referral,
      region, party, job,
      unread: Number(unread.n) + Number(unreadAnn.n), unreadDm: Number(unreadDm.n),
      world, population: Number(population.n), onlineCount: await countOnline(),
      activeWars, votingLaws,
      xpNext: xpForLevel(c.level),
    });
  }));

  app.post('/api/claim', authRequired, citizenRequired, r(async (req, res) => {
    const today = todayStr();
    // Atomik: kunci baris warga + UPDATE bersyarat (last_claim_date <> hari
    // ini) + cek changes — dua request paralel, hanya satu yang berhasil.
    // Anggaran pasokan (Tahap 5): bila anggaran 'claim' sedang berlaku,
    // klaim harian memberi +2 emas tambahan.
    const locked = await tx(async (t) => {
      const row = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      if (row.last_claim_date === today) throw Object.assign(new Error('Pasokan hari ini sudah diambil. Kembali besok.'), { status: 400 });
      const country = await getCountryRow(t);
      const bonus = budgetActive(country) === 'claim' ? 2 : 0;
      const upd = await t.run('UPDATE citizens SET gold = gold + ?, usd = usd + 50, last_claim_date = ? WHERE id = ? AND last_claim_date <> ?', [5 + bonus, today, req.citizen.id, today]);
      if (!upd.changes) throw Object.assign(new Error('Pasokan hari ini sudah diambil. Kembali besok.'), { status: 400 });
      return { row, bonus };
    });
    await addXp(locked.row, 2);
    await chronicleDone(locked.row, 'claim');
    res.json({ ok: true, reward: { gold: 5 + locked.bonus, usd: 50, xp: 2 }, budgetBonus: locked.bonus > 0 });
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
      const cdMs = trainCooldownMs(row[col]);
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
      const country = await getCountryRow(t);
      if (budgetActive(country) === 'train') cost = Math.max(1, Math.round(cost * 0.9));
      const upd = await t.run(`UPDATE citizens SET gold = gold - ?, ${col} = ${col} + 1, ${trainCol} = ? WHERE id = ? AND gold >= ?`, [cost, now, req.citizen.id, cost]);
      if (!upd.changes) throw Object.assign(new Error(`Butuh ${cost} emas untuk latihan ini.`), { status: 400 });
      return { row, cost };
    });
    await addXp(done.row, 1);
    await chronicleDone(done.row, 'train');
    const newLevel = done.row[col] + 1;
    const cooldownMs = trainCooldownMs(newLevel);
    res.json({ ok: true, cost: done.cost, level: newLevel, cooldownMs, availableAt: now + cooldownMs });
  }));

  app.post('/api/eat', authRequired, citizenRequired, r(async (req, res) => {
    const { tier } = req.body || {};
    const t = Math.max(1, Math.min(5, Number(tier) || 1));
    const food = await one('SELECT id FROM commodities WHERE name = ?', ['Makanan']);
    const result = await tx(async (tx) => {
      const locked = await tx.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      if (locked.bread_today >= 10) throw Object.assign(new Error('Jatah roti harian (10) sudah habis.'), { status: 400 });
      const ok = await takeItem(locked.id, food.id, t, 1, tx);
      if (!ok) throw Object.assign(new Error(`Tidak ada Makanan T${t} di inventaris.`), { status: 400 });
      const gain = foodEnergy(t);
      // Batas energi (Tahap 4): energyCapFor — 100 + 5×(level−1), +20
      // Premium, +10 RS Lapangan. Selaras dengan /api/me dan tick harian.
      const buildings = await convoyBuildings(locked.id, tx);
      const cap = energyCapFor(locked.level, locked.premium_until > Date.now(), buildings.has('health'));
      const energy = Math.min(cap, locked.energy + gain);
      const upd = await tx.run('UPDATE citizens SET energy = ?, bread_today = bread_today + 1 WHERE id = ? AND bread_today < 10', [energy, locked.id]);
      if (!upd.changes) throw Object.assign(new Error('Jatah roti harian (10) sudah habis.'), { status: 400 });
      return { energy, gained: gain, locked };
    });
    const m = await missionProgress(result.locked);
    await setMission(result.locked, 'bread', Math.min(10, (m.bread || 0) + 1));
    await chronicleDone(result.locked, 'eat');
    res.json({ ok: true, energy: result.energy, gained: result.gained });
  }));

  // ---------- MISI HARIAN ----------
  app.get('/api/missions', authRequired, citizenRequired, r(async (req, res) => {
    const c = req.citizen;
    const m = await missionProgress(c);
    const claimed = m.claimed || [];
    res.json({
      missions: DAILY_MISSIONS.map((d) => ({
        ...d,
        progress: d.key === 'energy' ? (c.energy_spent_today || 0) : d.key === 'bread' ? (c.bread_today || 0) : (m.chat || 0),
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
      const m = JSON.parse(c.missions || '{}');
      const progress = key === 'energy' ? (c.energy_spent_today || 0) : key === 'bread' ? (c.bread_today || 0) : (m.chat || 0);
      if (progress < d.target) throw Object.assign(new Error('Misi belum selesai.'), { status: 400 });
      const claimed = m.claimed || [];
      if (claimed.includes(key)) throw Object.assign(new Error('Hadiah misi ini sudah diklaim.'), { status: 400 });
      claimed.push(key);
      m.claimed = claimed;
      await t.run('UPDATE citizens SET gold = gold + ?, missions = ? WHERE id = ?', [d.reward, JSON.stringify(m), c.id]);
    });
    res.json({ ok: true, reward: d.reward });
  }));

  // ---------- KRONIK ----------
  app.get('/api/chronicle', authRequired, citizenRequired, r(async (req, res) => {
    const c = req.citizen;
    const done = JSON.parse(c.chronicle_done || '[]');
    const claimed = JSON.parse(c.chronicle_claimed || '[]');
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
      const done = JSON.parse(c.chronicle_done || '[]');
      const claimed = JSON.parse(c.chronicle_claimed || '[]');
      if (!ch.tasks.every((t2) => done.includes(t2.key))) throw Object.assign(new Error('Masih ada tugas yang belum selesai di babak ini.'), { status: 400 });
      if (claimed.includes(ch.chapter)) throw Object.assign(new Error('Hadiah babak ini sudah diklaim.'), { status: 400 });
      claimed.push(ch.chapter);
      await t.run('UPDATE citizens SET gold = gold + ?, chronicle_claimed = ? WHERE id = ?', [ch.reward, JSON.stringify(claimed), c.id]);
    });
    res.json({ ok: true, reward: ch.reward });
  }));

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
    const q = 'SELECT u.id, u.username, u.avatar, u.premium_until, u.referral_code, c.* FROM users u JOIN citizens c ON c.user_id = u.id WHERE ';
    let u = await one(q + 'u.username = ?', [req.params.username]);
    if (!u) u = await one(q + 'LOWER(u.username) = LOWER(?)', [req.params.username]);
    if (!u) return res.status(404).json({ error: 'Warga tidak ditemukan.' });
    const region = await one('SELECT name FROM regions WHERE id = ?', [u.region_id]);
    const party = u.party_id ? await one('SELECT name, tag FROM parties WHERE id = ?', [u.party_id]) : null;
    const companies = await sql('SELECT id, name, type FROM companies WHERE owner_id = ?', [u.id]);
    const articles = await sql('SELECT id, title, created_at FROM articles WHERE author_id = ? ORDER BY created_at DESC LIMIT 5', [u.id]);
    // Statistik referral hanya untuk pemilik profil sendiri.
    let referral = null;
    if (req.userId === u.id) {
      const uses = await one('SELECT COUNT(*) AS n FROM users WHERE referred_by = ?', [u.id]);
      const paid = await one("SELECT COUNT(*) AS n FROM referral_pending WHERE referrer_id = ? AND status = 'paid'", [u.id]);
      referral = { code: u.referral_code, uses: Number(uses.n), goldEarned: Number(paid.n) * 100 };
    }
    res.json({ profile: { ...u, publicId: publicId(u.id), referral_code: u.referral_code, referral, pass_hash: undefined, region_name: region?.name, party, companies, articles, isPremium: u.premium_until > Date.now() } });
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
  // Batas: data URL gambar (JPEG/PNG/WebP) yang valid, ≤ 100 KB.
  // Hanya untuk akun sendiri — tidak ada parameter target, selalu req.userId.
  // Tahap 3 (§6.3): browser juga mengirim avatar_sm — versi 48×48 (≤ 25 KB)
  // yang dipakai di daftar chat/DM supaya satu polling chat tidak lagi
  // mengunduh ~136 KB × 100 pesan. avatar_sm NULL untuk foto lama (belum
  // diunggah ulang) — chat memakai fallback inisial di sana.
  const AVATAR_MAX_BYTES = 100 * 1024;
  const AVATAR_SM_MAX_BYTES = 25 * 1024;
  function parseAvatarDataUrl(dataUrl, maxBytes = AVATAR_MAX_BYTES) {
    if (typeof dataUrl !== 'string') return null;
    const m = dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return null;
    let buf;
    try { buf = Buffer.from(m[2], 'base64'); } catch { return null; }
    if (buf.length === 0 || buf.length > maxBytes) return null;
    // Periksa magic bytes agar benar-benar file gambar, bukan teks lain.
    const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
    const isWebp = buf.length > 11 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
    if (!isJpeg && !isPng && !isWebp) return null;
    return { bytes: buf.length, dataUrl };
  }
  app.post('/api/profile/avatar', authRequired, r(async (req, res) => {
    const parsed = parseAvatarDataUrl(req.body?.avatar);
    if (!parsed) {
      return res.status(400).json({ error: 'Foto harus gambar JPEG/PNG/WebP yang valid dan ukurannya maksimal 100 KB.' });
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
    const stats = await one('SELECT COUNT(*) AS open, SUM(seats - seats_taken) AS seats, MAX(salary) AS best FROM jobs WHERE seats_taken < seats');
    // Upah ADMIN yang berlaku (Tahap 5): UU upah ADMIN mengubah jumlah
    // bahan mentah per shift (pengali admin_pay_mult). Frontend menampilkan
    // effectiveQty agar yang terlihat sama dengan yang diterima.
    const adminPayMult = await getAdminPayMult({ one });
    const jobs = rows.map((j) => j.salary_type === 'goods'
      ? { ...j, effectiveQty: Math.max(1, Math.floor((j.pay_qty || 0) * adminPayMult)) }
      : j);
    res.json({ jobs, stats, adminPayMult });
  }));

  app.post('/api/jobs/apply', authRequired, citizenRequired, r(async (req, res) => {
    const { job_id } = req.body || {};
    // Atomik: kunci baris lowongan + baris warga, baca ulang syarat di dalam
    // tx, naikkan kursi hanya bila masih ada (WHERE seats_taken < seats).
    await tx(async (t) => {
      const job = await t.one(forUpdate('SELECT * FROM jobs WHERE id = ?'), [job_id]);
      if (!job) throw Object.assign(new Error('Lowongan tidak ditemukan.'), { status: 404 });
      const c = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      if (c.level < job.level_min) throw Object.assign(new Error(`Butuh Level ${job.level_min} untuk melamar.`), { status: 400 });
      if (c.region_id !== job.region_id) throw Object.assign(new Error('Kamu harus berada di wilayah perusahaan itu untuk melamar.'), { status: 400 });
      if (c.job_id === job.id) throw Object.assign(new Error('Kamu sudah bekerja di lowongan ini.'), { status: 400 });
      if (job.seats_taken >= job.seats) throw Object.assign(new Error('Kursi lowongan ini sudah penuh.'), { status: 400 });
      if (c.job_id) await t.run('UPDATE jobs SET seats_taken = seats_taken - 1 WHERE id = ? AND seats_taken > 0', [c.job_id]);
      await t.run('UPDATE citizens SET job_id = ? WHERE id = ?', [job.id, c.id]);
      const inc = await t.run('UPDATE jobs SET seats_taken = seats_taken + 1 WHERE id = ? AND seats_taken < seats', [job.id]);
      if (!inc.changes) throw Object.assign(new Error('Kursi lowongan ini sudah penuh.'), { status: 400 });
    });
    await chronicleDone(req.citizen, 'job');
    res.json({ ok: true });
  }));

  app.post('/api/jobs/quit', authRequired, citizenRequired, r(async (req, res) => {
    const c = req.citizen;
    if (!c.job_id) return res.status(400).json({ error: 'Kamu sedang tidak bekerja.' });
    await tx(async (t) => {
      await t.run('UPDATE jobs SET seats_taken = seats_taken - 1 WHERE id = ? AND seats_taken > 0', [c.job_id]);
      await t.run('UPDATE citizens SET job_id = NULL WHERE id = ?', [c.id]);
    });
    res.json({ ok: true });
  }));

  app.post('/api/jobs/shift', authRequired, citizenRequired, r(async (req, res) => {
    const c = await loadCitizen(req.userId);
    if (!c.job_id) return res.status(400).json({ error: 'Kamu belum punya pekerjaan. Lamar dulu di Kantor Ketenagakerjaan.' });
    const job = await one('SELECT * FROM jobs WHERE id = ?', [c.job_id]);
    // Tarif pajak + pengali upah ADMIN yang berlaku (Tahap 5 — dari UU yang
    // disahkan, bukan hardcode). Gaji tetap dipotong tarif UU; lowongan
    // ADMIN dibayar bahan mentah × pengali UU (tanpa pajak).
    const taxRate = await getIncomeTaxRate({ one });
    const adminPayMult = await getAdminPayMult({ one });
    const { gross, net } = shiftSalary(job.salary, c.attr_eco, c.fatigue, taxRate);
    // Pengurang energi atomik (dipakai ketiga jenis gaji): kunci baris warga,
    // potong 100 energi hanya bila masih >= 100 (cek changes). Dua shift
    // paralel: yang kedua gagal dengan 400, energi tidak pernah negatif.
    async function spendEnergy(t) {
      const locked = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [c.id]);
      const upd = await t.run('UPDATE citizens SET energy = energy - 100, energy_spent_today = energy_spent_today + 100, fatigue = fatigue + 100, shifts = shifts + 1 WHERE id = ? AND energy >= 100', [c.id]);
      if (!upd.changes) throw Object.assign(new Error(`Energi tidak cukup (${locked?.energy ?? 0}/100). Makan roti dulu.`), { status: 400 });
      const m = JSON.parse(locked.missions || '{}');
      m.energy = Math.min(500, (locked.energy_spent_today || 0) + 100);
      await t.run('UPDATE citizens SET missions = ? WHERE id = ?', [JSON.stringify(m), c.id]);
    }
    let goodsNote = '';
    if (job.salary_type === 'goods') {
      // Lowongan ADMIN: dibayar BAHAN MENTAH, bukan uang (tanpa pajak).
      // Jumlah dipengaruhi kelelahan seperti gaji (×0,75 / ×0,5) dan
      // pengali upah ADMIN dari UU yang berlaku (Tahap 5).
      const com = await one('SELECT * FROM commodities WHERE name = ?', [job.resource]);
      if (!com) throw Object.assign(new Error('Bahan upah lowongan ini tidak dikenal.'), { status: 500 });
      const qty = Math.max(1, Math.floor((job.pay_qty || 0) * fatigueMult(c.fatigue) * adminPayMult));
      const usdValue = Math.round(qty * com.ref_usd * 100) / 100;
      await tx(async (t) => {
        await spendEnergy(t);
        await addItem(c.id, com.id, 1, qty, t);
      });
      const note = `Dibayar ${qty}× ${job.resource} (setara ~${fmtRp(usdValue)}).`;
      await addXp(c, xpGainForShift());
      await chronicleDone(c, 'shift');
      return res.json({ ok: true, gross: usdValue, net: 0, tax: 0, goods: `${qty}× ${job.resource}`, note });
    }
    if (job.salary_type === 'share') {
      // Bagi hasil: 80–98% dibayar dalam bentuk barang (sumber daya perusahaan).
      const pct = 80 + Math.min(18, Math.floor(job.share_pct || 90) - 80);
      const company = job.company_id ? await one('SELECT * FROM companies WHERE id = ?', [job.company_id]) : null;
      const resource = company?.resource || 'Gandum Mentah';
      const com = await one('SELECT * FROM commodities WHERE name = ?', [resource]);
      const units = Math.max(1, Math.floor((gross * pct / 100) / com.ref_usd));
      await tx(async (t) => {
        await spendEnergy(t);
        await addItem(c.id, com.id, 1, units, t);
      });
      goodsNote = ` Dibayar ${units}× ${resource} (bagi hasil ${pct}%).`;
      await addXp(c, xpGainForShift());
      await chronicleDone(c, 'shift');
      return res.json({ ok: true, gross, net: 0, tax: 0, goods: `${units}× ${resource}`, note: goodsNote });
    }
    await tx(async (t) => {
      await spendEnergy(t);
      await t.run('UPDATE citizens SET usd = usd + ?, total_salary = total_salary + ? WHERE id = ?', [net, net, c.id]);
    });
    await addXp(c, xpGainForShift());
    await chronicleDone(c, 'shift');
    res.json({ ok: true, gross, net, tax: gross * taxRate });
  }));

  // ---------- PERUSAHAAN ----------
  app.get('/api/companies', authRequired, citizenRequired, r(async (req, res) => {
    const rows = await sql(
      `SELECT co.*, u.username AS owner_name, r.name AS region_name,
        (SELECT COUNT(*) FROM citizens WHERE job_id IN (SELECT id FROM jobs WHERE company_id = co.id)) AS employees
       FROM companies co JOIN users u ON u.id = (SELECT user_id FROM citizens WHERE id = co.owner_id)
       JOIN regions r ON r.id = co.region_id ORDER BY co.created_at DESC`,
      []);
    const mine = rows.filter((x) => x.owner_id === req.citizen.id);
    res.json({ companies: rows, mine, types: COMPANY_TYPES, resources: RESOURCE_PRODUCTS });
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

  // ---------- PASAR ----------
  app.get('/api/market', authRequired, citizenRequired, r(async (req, res) => {
    const scope = req.query.scope === 'global' ? 'global' : 'local';
    const coms = await sql('SELECT * FROM commodities ORDER BY name');
    const since = Date.now() - 24 * 60 * 60 * 1000;
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
    // ia anggota organisasi (untuk tampilan kartu penawaran gaya Parlamentum).
    const offers = await sql(
      `SELECT o.*, u.username AS seller, c.name AS commodity_name, og.tag AS seller_org FROM market_offers o
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
    res.json({
      scope, commodities: coms.map((c) => ({ ...c, best: bestMap[c.id]?.best ?? null, offers: bestMap[c.id]?.n ?? 0 })),
      stats: { offers: Number(stats.offers), tx: Number(txStats.tx), units: Number(txStats.units), turnover: Number(txStats.turnover) },
      offers, mine, recentTx, buyOrders, myBuyOrders,
      // Tarif pajak penghasilan yang berlaku saat ini (Tahap 5 — dari UU
      // yang disahkan, bukan hardcode 2%). Nilai DB langsung (bukan
      // tarif/100×100) agar eksak, tanpa galat floating point.
      taxRate: Number((await getCountryRow({ one })).tax_income),
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

  app.post('/api/market/buy', authRequired, citizenRequired, r(async (req, res) => {
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
      const unitPrice = offer.price * (offer.scope === 'global' ? (1 + IMPORT_TAX) : 1);
      const total = unitPrice * q;
      // Tarif pajak penghasilan yang berlaku (Tahap 5 — dari UU yang
      // disahkan). Perjanjian dagang aktif antara organisasi pembeli &
      // penjual memotong pajak setengah.
      let taxRate = await getIncomeTaxRate(t);
      const pactDiscount = await hasTradePact(t, buyerId, sellerId);
      if (pactDiscount) taxRate *= TRADE_PACT_TAX_MULT;
      const sellerReceives = offer.price * q * (1 - taxRate);
      const pay = await t.run(`UPDATE citizens SET ${currency} = ${currency} - ? WHERE id = ? AND ${currency} >= ?`, [total, buyer.id, total]);
      if (!pay.changes) throw Object.assign(new Error(`Saldo ${currency === 'gold' ? 'emas' : 'Rupiah'} tidak cukup.`), { status: 400 });
      await t.run(`UPDATE citizens SET ${currency} = ${currency} + ? WHERE id = ?`, [sellerReceives, seller.id]);
      // Tahap 4 (BUG-8): pajak masuk kas negara, bukan menguap.
      // Lokal (USD): pajak dari harga jual. Global (emas): pajak penjual
      // + 2% pajak impor yang dibayar pembeli.
      const gross = offer.price * q;
      if (offer.scope === 'global') {
        await recordTreasury(t, 'gold', gross * taxRate + gross * IMPORT_TAX,
          `Pajak penjualan ${q} unit (global)`);
      } else {
        await recordTreasury(t, 'usd', gross * taxRate,
          `Pajak penjualan ${q} unit (lokal)`);
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
      // Tahap 4: pola bolak-balik mencurigakan dicatat untuk ditinjau admin.
      await checkWashTrade(t, buyer.id, seller.id, offer.commodity_id);
      return { total, sellerReceives, currency };
    });
    await chronicleDone(req.citizen, 'buy');
    res.json({ ok: true, ...result });
  }));

  app.post('/api/market/sell', authRequired, citizenRequired, r(async (req, res) => {
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

  // ---------- ORDER BELI / ORDER BOOK (Tahap 4) ----------
  // Dana pembeli dikunci (escrow) saat order dipasang; penjual memenuhi
  // order lewat sell-to-order (penuh atau sebagian). Tanpa mesin pencocokan
  // otomatis — penjual memilih order yang mau dipenuhi. Semua langkah
  // atomik (pola Tahap 2: FOR UPDATE + UPDATE bersyarat + cek changes).
  app.post('/api/market/buy-order', authRequired, citizenRequired, r(async (req, res) => {
    const { scope, commodity_id, tier, qty, price } = req.body || {};
    const q = Math.floor(Number(qty) || 0);
    const p = Number(price);
    if (q < MIN_OFFER_QTY) return res.status(400).json({ error: `Order beli minimum ${MIN_OFFER_QTY} unit.` });
    if (!p || p <= 0) return res.status(400).json({ error: 'Harga harus lebih dari 0.' });
    const t = Math.max(1, Math.min(5, Number(tier) || 1));
    const sc = scope === 'global' ? 'global' : 'local';
    const bad = await enforcePriceBand(commodity_id, t, p, req.citizen.id);
    if (bad) return res.status(400).json({ error: `Harga di luar batas wajar (median 14 hari ${bad.median.toFixed(2)} — batas ${bad.lo.toFixed(2)}–${bad.hi.toFixed(2)}).` });
    const currency = sc === 'global' ? 'gold' : 'usd';
    const escrow = p * q;
    const orderId = await tx(async (tx) => {
      const locked = await tx.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      const bal = currency === 'gold' ? locked.gold : locked.usd;
      if (bal < escrow) throw Object.assign(new Error(`Saldo ${currency === 'gold' ? 'emas' : 'Rupiah'} tidak cukup untuk mengunci ${currency === 'gold' ? escrow.toFixed(2) + ' emas' : fmtRp(escrow)}.`), { status: 400 });
      const upd = await tx.run(`UPDATE citizens SET ${currency} = ${currency} - ? WHERE id = ? AND ${currency} >= ?`, [escrow, req.citizen.id, escrow]);
      if (!upd.changes) throw Object.assign(new Error('Saldo tidak cukup.'), { status: 400 });
      const o = await tx.run(
        'INSERT INTO market_buy_orders (buyer_id, scope, commodity_id, tier, qty, qty_filled, price, created_at) VALUES (?,?,?,?,?,0,?,?) RETURNING id',
        [req.citizen.id, sc, commodity_id, t, q, p, Date.now()]);
      return o.id;
    });
    res.json({ ok: true, orderId, escrow });
  }));

  app.post('/api/market/sell-to-order', authRequired, citizenRequired, r(async (req, res) => {
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
      // disahkan) + diskon perjanjian dagang antar organisasi.
      let taxRate = await getIncomeTaxRate(t);
      if (await hasTradePact(t, buyerId, sellerId)) taxRate *= TRADE_PACT_TAX_MULT;
      const sellerReceives = gross * (1 - taxRate);
      await t.run(`UPDATE citizens SET ${currency} = ${currency} + ? WHERE id = ?`, [sellerReceives, seller.id]);
      // Dana pembeli sudah dikunci saat order dipasang — tidak ada tagihan lagi.
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
      // Pajak -> kas negara (BUG-8), dengan tarif yang berlaku.
      await recordTreasury(t, currency, gross * taxRate, `Pajak penjualan ${q} unit via order beli`);
      await t.run('UPDATE citizens SET purchases = purchases + 1 WHERE id = ?', [buyer.id]);
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
      const refund = order.price * (order.qty - order.qty_filled);
      const currency = order.scope === 'global' ? 'gold' : 'usd';
      await t.run(`UPDATE citizens SET ${currency} = ${currency} + ? WHERE id = ?`, [refund, req.citizen.id]);
      await t.run('DELETE FROM market_buy_orders WHERE id = ?', [order.id]);
      return { refund, currency };
    });
    res.json({ ok: true, ...result });
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
    const since = Date.now() - 24 * 60 * 60 * 1000;
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
        [req.citizen.id, direction, p, q, Date.now() + 72 * 60 * 60 * 1000, Date.now()]);
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
      `SELECT r.*,
        (SELECT COUNT(*) FROM citizens WHERE region_id = r.id) AS population,
        (SELECT COUNT(*) FROM companies WHERE region_id = r.id) AS companies,
        (SELECT COUNT(*) FROM war_support WHERE region_id = r.id) AS rebellion
       FROM regions r ORDER BY r.id`);
    res.json({ regions: rows, mine: req.citizen.region_id });
  }));

  app.get('/api/regions/:id', authRequired, citizenRequired, r(async (req, res) => {
    const reg = await one(
      `SELECT r.*,
        (SELECT COUNT(*) FROM citizens WHERE region_id = r.id) AS population,
        (SELECT COUNT(*) FROM companies WHERE region_id = r.id) AS companies,
        (SELECT COUNT(*) FROM war_support WHERE region_id = r.id) AS rebellion
       FROM regions r WHERE r.id = ?`, [req.params.id]);
    if (!reg) return res.status(404).json({ error: 'Wilayah tidak ditemukan.' });
    const war = await one("SELECT * FROM wars WHERE region_id = ? AND status = 'active' ORDER BY created_at DESC", [reg.id]);
    const mySupport = await one('SELECT * FROM war_support WHERE region_id = ? AND citizen_id = ?', [reg.id, req.citizen.id]);
    // Angka negara yang berlaku (Tahap 5): biaya perjalanan + tarif pajak
    // — halaman wilayah menampilkannya dinamis, bukan hardcode.
    const country = await getCountryRow({ one });
    res.json({ region: reg, war, mySupport: !!mySupport, mine: req.citizen.region_id === reg.id, home: req.citizen.home_region_id === reg.id, travelTickets: Number(country.travel_tickets) || 1, taxIncome: Number(country.tax_income) });
  }));

  app.post('/api/regions/travel', authRequired, citizenRequired, r(async (req, res) => {
    const { region_id } = req.body || {};
    const c = req.citizen;
    const target = await one('SELECT * FROM regions WHERE id = ?', [region_id]);
    if (!target) return res.status(404).json({ error: 'Wilayah tidak ditemukan.' });
    // Biaya perjalanan dari UU yang berlaku (Tahap 5): 1 atau 2 Tiket.
    const ticketsNeeded = await getTravelTickets({ one });
    // Atomik: kunci baris warga, pakai tiket + pindah di dalam tx yang sama.
    await tx(async (t) => {
      const locked = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [c.id]);
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
      await t.run('UPDATE citizens SET region_id = ? WHERE id = ?', [target.id, locked.id]);
    });
    await chronicleDone(c, 'travel');
    res.json({ ok: true, region: target.name });
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
      const cost = reg.name === 'Jakarta' ? 100 : 50; // ibu kota lebih mahal
      const active = await t.one("SELECT * FROM wars WHERE region_id = ? AND status = 'active'", [region_id]);
      if (active) throw Object.assign(new Error('Sudah ada perang aktif di wilayah ini.'), { status: 400 });
      const upd = await t.run('UPDATE citizens SET gold = gold - ? WHERE id = ? AND gold >= ?', [cost, c.id, cost]);
      if (!upd.changes) throw Object.assign(new Error(`Dukung pemberontakan butuh ${cost} emas (hangus).`), { status: 400 });
      const ins = await t.run('INSERT INTO war_support (region_id, citizen_id) VALUES (?,?) ON CONFLICT DO NOTHING RETURNING region_id', [region_id, c.id]);
      if (!ins.changes) throw Object.assign(new Error('Kamu sudah mendukung pemberontakan di wilayah ini.'), { status: 400 });
      const count = await t.one('SELECT COUNT(*) AS n FROM war_support WHERE region_id = ?', [region_id]);
      let warStarted = false;
      if (Number(count.n) >= 5) {
        await t.run(
          `INSERT INTO wars (name, region_id, attacker_label, defender_label, ends_at, created_at) VALUES (?,?,?,?,?,?) RETURNING id`,
          [`Pemberontakan ${reg.name}`, region_id, `Pemberontak ${reg.name}`, 'Republik Indonesia', Date.now() + 24 * 60 * 60 * 1000, Date.now()]);
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
    res.json({ slots, used: rows.length, convoys: rows, buildings: CONVOY_BUILDINGS });
  }));

  app.post('/api/convoy/build', authRequired, citizenRequired, r(async (req, res) => {
    const { building } = req.body || {};
    const def = CONVOY_BUILDINGS.find((b) => b.type === building);
    if (!def) return res.status(400).json({ error: 'Bangunan tidak dikenal.' });
    const c = req.citizen;
    const slots = 1 + (c.level >= 25 ? 1 : 0) + (c.level >= 50 ? 1 : 0) + (c.level >= 100 ? 1 : 0) + (c.premium_until > Date.now() ? 1 : 0);
    // Atomik: kunci baris warga, cek slot + potong emas bersyarat di dalam tx.
    const convoyId = await tx(async (t) => {
      await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [c.id]);
      const existing = await t.sql('SELECT * FROM convoys WHERE citizen_id = ?', [c.id]);
      if (existing.length >= slots) throw Object.assign(new Error('Slot konvoi penuh. Naik level / Premium untuk slot tambahan.'), { status: 400 });
      if (existing.some((x) => x.building === building)) throw Object.assign(new Error('Satu bangunan per jenis dalam satu waktu.'), { status: 400 });
      const upd = await t.run('UPDATE citizens SET gold = gold - 10 WHERE id = ? AND gold >= 10', [c.id]);
      if (!upd.changes) throw Object.assign(new Error('Membangun konvoi butuh 10 emas.'), { status: 400 });
      const slot = existing.length;
      const cv = await t.run('INSERT INTO convoys (citizen_id, slot, building, region_id, expires_at, created_at) VALUES (?,?,?,?,?,?) RETURNING id',
        [c.id, slot, building, c.region_id, Date.now() + 7 * 24 * 60 * 60 * 1000, Date.now()]);
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
    worldCache = { day: world?.day || 1, population: Number(population.n), regions: Number(regions.n), countries: 1, onlineCount: await countOnline() };
    worldCacheAt = now;
    res.json(worldCache);
  }));
}
