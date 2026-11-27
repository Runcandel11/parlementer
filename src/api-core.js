// API inti Parlementer: auth (email+password), dashboard, pekerjaan, perusahaan,
// pasar, valas, peta, inventaris, konvoi, misi, kronik, pencapaian, notifikasi, profil, toko.
import bcrypt from 'bcryptjs';
import { sql, one, run, tx, ADMIN_EMAIL, generateReferralCode } from './db.js';
import {
  signToken, cookieOptions, COOKIE_NAME, authRequired, citizenRequired,
  loadCitizen, isValidEmail, isValidUsername, todayStr, publicId,
} from './util.js';
import {
  WA_TOPUP_URL, MINT_RATE, INCOME_TAX, IMPORT_TAX, MIN_OFFER_QTY,
  xpForLevel, xpGainForShift, shiftSalary, fatigueMult, trainCost, foodEnergy, DAILY_MISSIONS, CHRONICLE,
  ACHIEVEMENTS, achievementProgress, COMPANY_TYPES, RESOURCE_PRODUCTS,
  DAILY_PRODUCTION, SHOP_PACKAGES, SHOP_PREMIUM, PREMIUM_PERKS, CONVOY_BUILDINGS,
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
    return { level, xp };
  }

  async function notify(citizenId, category, title, content = '') {
    await run('INSERT INTO notifications (citizen_id, category, title, content, created_at) VALUES (?,?,?,?,?) RETURNING id',
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
    const row = await db.one('SELECT * FROM inventory WHERE citizen_id = ? AND commodity_id = ? AND tier = ?',
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

  // ---------- AUTH (email + password) ----------
  // Bonus referral: pemilik kode +100 emas + 2 hari premium; pendaftar baru
  // yang memakai kode +50 emas + 1 hari premium. Premium diperpanjang dari
  // premium_until yang masih aktif, atau dari sekarang bila tidak aktif.
  const REFERRER_GOLD = 100;
  const REFERRER_PREMIUM_MS = 2 * 24 * 60 * 60 * 1000;
  const NEWCOMER_GOLD = 50;
  const NEWCOMER_PREMIUM_MS = 1 * 24 * 60 * 60 * 1000;

  app.post('/api/auth/register', r(async (req, res) => {
    const { email, password, username, ref } = req.body || {};
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Format email tidak valid.' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter.' });
    if (!isValidUsername(username)) return res.status(400).json({ error: 'Nama warga 3–24 karakter, huruf/angka/underscore saja.' });
    const emailTaken = await one('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (emailTaken) return res.status(400).json({ error: 'Email ini sudah terdaftar. Silakan masuk.' });
    const nameTaken = await one('SELECT id FROM users WHERE username = ?', [username]);
    if (nameTaken) return res.status(400).json({ error: 'Nama warga ini sudah dipakai orang lain.' });
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
    const isAdmin = email.toLowerCase() === ADMIN_EMAIL ? 1 : 0;
    const result = await tx(async (t) => {
      const myCode = await generateReferralCode(t);
      const user = await t.run(
        'INSERT INTO users (email, username, pass_hash, referred_by, referral_code, premium_until, is_admin, created_at) VALUES (?,?,?,?,?,?,?,?) RETURNING id',
        [email.toLowerCase(), username, hash, referredBy, myCode, referredBy ? now + NEWCOMER_PREMIUM_MS : 0, isAdmin, now]);
      const citizen = await t.run(
        `INSERT INTO citizens (user_id, level, xp, energy, gold, usd, region_id, home_region_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
        [user.id, 1, 0, 100, 50 + (referredBy ? NEWCOMER_GOLD : 0), 500, 1, 1, now]);
      // Paket awal: 3 Makanan T1, 3 Senjata T1, 3 Tiket T1.
      for (const name of ['Makanan', 'Senjata', 'Tiket']) {
        const com = await t.one('SELECT id FROM commodities WHERE name = ?', [name]);
        await addItem(citizen.id, com.id, 1, 3, t);
      }
      await t.run('INSERT INTO notifications (citizen_id, category, title, content, created_at) VALUES (?,?,?,?,?) RETURNING id',
        [citizen.id, 'SISTEM', 'Selamat datang di Parlementer!',
          'Kamu warga baru Republik Indonesia. Ambil pasokan harianmu dan cari pekerjaan dari ADMIN untuk modal awal.', now]);
      if (referredBy) {
        // Bonus pemilik kode: +100 emas + 2 hari premium (diperpanjang bila aktif).
        const refUser = await t.one('SELECT premium_until FROM users WHERE id = ?', [referredBy]);
        const refCitizen = await t.one('SELECT id FROM citizens WHERE user_id = ?', [referredBy]);
        const newUntil = Math.max(now, refUser?.premium_until || 0) + REFERRER_PREMIUM_MS;
        await t.run('UPDATE users SET premium_until = ? WHERE id = ?', [newUntil, referredBy]);
        if (refCitizen) {
          await t.run('UPDATE citizens SET gold = gold + ? WHERE id = ?', [REFERRER_GOLD, refCitizen.id]);
          await t.run('INSERT INTO notifications (citizen_id, category, title, content, created_at) VALUES (?,?,?,?,?) RETURNING id',
            [refCitizen.id, 'SOSIAL', 'Bonus referral!', `${username} mendaftar memakai kode referralmu. Kamu mendapat +${REFERRER_GOLD} emas + 2 hari Premium.`, now]);
        }
      }
      return { userId: user.id, myCode };
    });
    res.cookie(COOKIE_NAME, signToken(result.userId), cookieOptions());
    res.json({ ok: true, user: { id: result.userId, publicId: publicId(result.userId), email: email.toLowerCase(), username, referralCode: result.myCode } });
  }));

  app.post('/api/auth/login', r(async (req, res) => {
    const { email, password } = req.body || {};
    if (!isValidEmail(email) || !password) return res.status(400).json({ error: 'Email dan password wajib diisi.' });
    const user = await one('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!user) return res.status(400).json({ error: 'Email belum terdaftar.' });
    if (user.is_banned) return res.status(403).json({ error: `Akun ini dibanned: ${user.banned_reason || 'tanpa alasan yang dicantumkan'}.` });
    const ok = await bcrypt.compare(password, user.pass_hash);
    if (!ok) return res.status(400).json({ error: 'Password salah.' });
    res.cookie(COOKIE_NAME, signToken(user.id), cookieOptions());
    const citizen = await loadCitizen(user.id);
    res.json({ ok: true, user: { id: user.id, publicId: publicId(user.id), email: user.email, username: user.username }, citizen });
  }));

  app.post('/api/auth/logout', r(async (req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  }));

  app.get('/api/auth/me', authRequired, r(async (req, res) => {
    const citizen = await loadCitizen(req.userId);
    if (!citizen) return res.status(404).json({ error: 'Warga tidak ditemukan.' });
    res.json({
      user: {
        id: citizen.user_id, publicId: publicId(citizen.user_id), email: citizen.email, username: citizen.username,
        is_admin: !!citizen.is_admin, is_banned: !!citizen.is_banned, banned_reason: citizen.banned_reason || '',
      },
      citizen,
    });
  }));

  // ---------- DASHBOARD / WARGA ----------
  app.get('/api/me', authRequired, citizenRequired, r(async (req, res) => {
    const c = req.citizen;
    const region = await one('SELECT * FROM regions WHERE id = ?', [c.region_id]);
    const party = c.party_id ? await one('SELECT id, name, tag FROM parties WHERE id = ?', [c.party_id]) : null;
    const job = c.job_id ? await one('SELECT j.*, co.name AS company_name FROM jobs j LEFT JOIN companies co ON co.id = j.company_id WHERE j.id = ?', [c.job_id]) : null;
    const unread = await one('SELECT COUNT(*) AS n FROM notifications WHERE citizen_id = ? AND is_read = 0', [c.id]);
    const unreadDm = await one('SELECT COUNT(*) AS n FROM dms WHERE to_id = ? AND is_read = 0', [c.id]);
    const world = await one('SELECT * FROM world WHERE id = 1');
    const population = await one('SELECT COUNT(*) AS n FROM citizens');
    const activeWars = await sql("SELECT w.*, r.name AS region_name FROM wars w JOIN regions r ON r.id = w.region_id WHERE w.status = 'active' ORDER BY w.created_at DESC");
    const votingLaws = await sql("SELECT l.*, u.username AS proposer FROM laws l JOIN citizens c ON c.id = l.proposer_id JOIN users u ON u.id = c.user_id WHERE l.status = 'voting' AND l.ends_at > ? ORDER BY l.ends_at ASC", [Date.now()]);
    const isPremium = c.premium_until > Date.now();
    const refUses = await one('SELECT COUNT(*) AS n FROM users WHERE referred_by = ?', [c.user_id]);
    const referral = {
      code: c.referral_code,
      uses: Number(refUses.n),
      // Setiap referral berhasil memberi pemilik kode +100 emas.
      goldEarned: Number(refUses.n) * 100,
    };
    res.json({
      user: {
        id: c.user_id, publicId: publicId(c.user_id), email: c.email, username: c.username,
        is_admin: !!c.is_admin, is_banned: !!c.is_banned, banned_reason: c.banned_reason || '',
      },
      citizen: { ...c, isPremium },
      referral,
      region, party, job,
      unread: Number(unread.n), unreadDm: Number(unreadDm.n),
      world, population: Number(population.n),
      activeWars, votingLaws,
      xpNext: xpForLevel(c.level),
    });
  }));

  app.post('/api/claim', authRequired, citizenRequired, r(async (req, res) => {
    const c = req.citizen;
    const today = todayStr();
    if (c.last_claim_date === today) return res.status(400).json({ error: 'Pasokan hari ini sudah diambil. Kembali besok.' });
    await run('UPDATE citizens SET gold = gold + 5, usd = usd + 50, last_claim_date = ? WHERE id = ?', [today, c.id]);
    await addXp(c, 2);
    await chronicleDone(c, 'claim');
    res.json({ ok: true, reward: { gold: 5, usd: 50, xp: 2 } });
  }));

  app.post('/api/train', authRequired, citizenRequired, r(async (req, res) => {
    const { attr } = req.body || {};
    if (!['str', 'edu', 'eco'].includes(attr)) return res.status(400).json({ error: 'Atribut tidak dikenal.' });
    const col = attr === 'str' ? 'attr_str' : attr === 'edu' ? 'attr_edu' : 'attr_eco';
    const c = req.citizen;
    const cost = trainCost(c[col]);
    if (c.gold < cost) return res.status(400).json({ error: `Butuh ${cost} emas untuk latihan ini.` });
    await run(`UPDATE citizens SET gold = gold - ?, ${col} = ${col} + 1 WHERE id = ?`, [cost, c.id]);
    await addXp(c, 1);
    await chronicleDone(c, 'train');
    res.json({ ok: true, cost, level: c[col] + 1 });
  }));

  app.post('/api/eat', authRequired, citizenRequired, r(async (req, res) => {
    const { tier } = req.body || {};
    const t = Math.max(1, Math.min(5, Number(tier) || 1));
    const c = req.citizen;
    if (c.bread_today >= 10) return res.status(400).json({ error: 'Jatah roti harian (10) sudah habis.' });
    const food = await one('SELECT id FROM commodities WHERE name = ?', ['Makanan']);
    const ok = await takeItem(c.id, food.id, t, 1);
    if (!ok) return res.status(400).json({ error: `Tidak ada Makanan T${t} di inventaris.` });
    const gain = foodEnergy(t);
    const cap = c.premium_until > Date.now() ? 120 : 100;
    const energy = Math.min(cap, c.energy + gain);
    await run('UPDATE citizens SET energy = ?, bread_today = bread_today + 1 WHERE id = ?', [energy, c.id]);
    const m = await missionProgress(c);
    await setMission(c, 'bread', Math.min(10, (m.bread || 0) + 1));
    await chronicleDone(c, 'eat');
    res.json({ ok: true, energy, gained: gain });
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
    const c = req.citizen;
    const m = await missionProgress(c);
    const progress = key === 'energy' ? (c.energy_spent_today || 0) : key === 'bread' ? (c.bread_today || 0) : (m.chat || 0);
    if (progress < d.target) return res.status(400).json({ error: 'Misi belum selesai.' });
    const claimed = m.claimed || [];
    if (claimed.includes(key)) return res.status(400).json({ error: 'Hadiah misi ini sudah diklaim.' });
    claimed.push(key);
    m.claimed = claimed;
    await run('UPDATE citizens SET gold = gold + ?, missions = ? WHERE id = ?', [d.reward, JSON.stringify(m), c.id]);
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
    const c = req.citizen;
    const done = JSON.parse(c.chronicle_done || '[]');
    const claimed = JSON.parse(c.chronicle_claimed || '[]');
    if (!ch.tasks.every((t) => done.includes(t.key))) return res.status(400).json({ error: 'Masih ada tugas yang belum selesai di babak ini.' });
    if (claimed.includes(ch.chapter)) return res.status(400).json({ error: 'Hadiah babak ini sudah diklaim.' });
    claimed.push(ch.chapter);
    await run('UPDATE citizens SET gold = gold + ?, chronicle_claimed = ? WHERE id = ?', [ch.reward, JSON.stringify(claimed), c.id]);
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
    const c = req.citizen;
    if (achievementProgress(c, key) < a.target) return res.status(400).json({ error: 'Pencapaian belum tercapai.' });
    const already = await one('SELECT * FROM achievements WHERE citizen_id = ? AND akey = ? AND claimed = 1', [c.id, key]);
    if (already) return res.status(400).json({ error: 'Hadiah sudah diklaim.' });
    await run('INSERT INTO achievements (citizen_id, akey, claimed) VALUES (?,?,1) RETURNING citizen_id', [c.id, key]);
    await run('UPDATE citizens SET gold = gold + ? WHERE id = ?', [a.reward, c.id]);
    res.json({ ok: true, reward: a.reward });
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

  // ---------- PROFIL ----------
  app.get('/api/profile/:username', authRequired, r(async (req, res) => {
    const u = await one('SELECT u.id, u.username, u.premium_until, u.referral_code, c.* FROM users u JOIN citizens c ON c.user_id = u.id WHERE u.username = ?', [req.params.username]);
    if (!u) return res.status(404).json({ error: 'Warga tidak ditemukan.' });
    const region = await one('SELECT name FROM regions WHERE id = ?', [u.region_id]);
    const party = u.party_id ? await one('SELECT name, tag FROM parties WHERE id = ?', [u.party_id]) : null;
    const companies = await sql('SELECT id, name, type FROM companies WHERE owner_id = ?', [u.id]);
    const articles = await sql('SELECT id, title, created_at FROM articles WHERE author_id = ? ORDER BY created_at DESC LIMIT 5', [u.id]);
    // Statistik referral hanya untuk pemilik profil sendiri.
    let referral = null;
    if (req.userId === u.id) {
      const uses = await one('SELECT COUNT(*) AS n FROM users WHERE referred_by = ?', [u.id]);
      referral = { code: u.referral_code, uses: Number(uses.n), goldEarned: Number(uses.n) * 100 };
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
    const c = req.citizen;
    if (c.gold < 50) return res.status(400).json({ error: 'Ganti nama butuh 50 emas.' });
    const taken = await one('SELECT id FROM users WHERE username = ? AND id != ?', [name, c.user_id]);
    if (taken) return res.status(400).json({ error: 'Nama ini sudah dipakai.' });
    await run('UPDATE users SET username = ? WHERE id = ?', [name, c.user_id]);
    await run('UPDATE citizens SET gold = gold - 50 WHERE id = ?', [c.id]);
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
    res.json({ jobs: rows, stats });
  }));

  app.post('/api/jobs/apply', authRequired, citizenRequired, r(async (req, res) => {
    const { job_id } = req.body || {};
    const c = req.citizen;
    const job = await one('SELECT * FROM jobs WHERE id = ?', [job_id]);
    if (!job) return res.status(404).json({ error: 'Lowongan tidak ditemukan.' });
    if (job.seats_taken >= job.seats) return res.status(400).json({ error: 'Kursi lowongan ini sudah penuh.' });
    if (c.level < job.level_min) return res.status(400).json({ error: `Butuh Level ${job.level_min} untuk melamar.` });
    if (c.region_id !== job.region_id) return res.status(400).json({ error: 'Kamu harus berada di wilayah perusahaan itu untuk melamar.' });
    if (c.job_id) await run('UPDATE jobs SET seats_taken = seats_taken - 1 WHERE id = ?', [c.job_id]);
    await run('UPDATE citizens SET job_id = ? WHERE id = ?', [job.id, c.id]);
    await run('UPDATE jobs SET seats_taken = seats_taken + 1 WHERE id = ?', [job.id]);
    await chronicleDone(c, 'job');
    res.json({ ok: true });
  }));

  app.post('/api/jobs/quit', authRequired, citizenRequired, r(async (req, res) => {
    const c = req.citizen;
    if (!c.job_id) return res.status(400).json({ error: 'Kamu sedang tidak bekerja.' });
    await run('UPDATE jobs SET seats_taken = seats_taken - 1 WHERE id = ?', [c.job_id]);
    await run('UPDATE citizens SET job_id = NULL WHERE id = ?', [c.id]);
    res.json({ ok: true });
  }));

  app.post('/api/jobs/shift', authRequired, citizenRequired, r(async (req, res) => {
    const c = await loadCitizen(req.userId);
    if (!c.job_id) return res.status(400).json({ error: 'Kamu belum punya pekerjaan. Lamar dulu di Kantor Ketenagakerjaan.' });
    if (c.energy < 100) return res.status(400).json({ error: `Energi tidak cukup (${c.energy}/100). Makan roti dulu.` });
    const job = await one('SELECT * FROM jobs WHERE id = ?', [c.job_id]);
    const { gross, net } = shiftSalary(job.salary, c.attr_eco, c.fatigue);
    let goodsNote = '';
    if (job.salary_type === 'goods') {
      // Lowongan ADMIN: dibayar BAHAN MENTAH, bukan uang (tanpa pajak).
      // Jumlah dipengaruhi kelelahan seperti gaji (×0,75 / ×0,5).
      const com = await one('SELECT * FROM commodities WHERE name = ?', [job.resource]);
      if (!com) throw Object.assign(new Error('Bahan upah lowongan ini tidak dikenal.'), { status: 500 });
      const qty = Math.max(1, Math.floor((job.pay_qty || 0) * fatigueMult(c.fatigue)));
      const usdValue = Math.round(qty * com.ref_usd * 100) / 100;
      await tx(async (t) => {
        await t.run('UPDATE citizens SET energy = energy - 100, energy_spent_today = energy_spent_today + 100, fatigue = fatigue + 100, shifts = shifts + 1 WHERE id = ?', [c.id]);
        await addItem(c.id, com.id, 1, qty, t);
      });
      const note = `Dibayar ${qty}× ${job.resource} (setara ~${usdValue} USD).`;
      await addXp(c, xpGainForShift());
      await chronicleDone(c, 'shift');
      await setMission(c, 'energy', Math.min(500, (c.energy_spent_today || 0) + 100));
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
        await t.run('UPDATE citizens SET energy = energy - 100, energy_spent_today = energy_spent_today + 100, fatigue = fatigue + 100, shifts = shifts + 1 WHERE id = ?', [c.id]);
        await addItem(c.id, com.id, 1, units, t);
      });
      goodsNote = ` Dibayar ${units}× ${resource} (bagi hasil ${pct}%).`;
      await addXp(c, xpGainForShift());
      await chronicleDone(c, 'shift');
      const m = await missionProgress(c);
      await setMission(c, 'energy', Math.min(500, (c.energy_spent_today || 0) + 100));
      return res.json({ ok: true, gross, net: 0, tax: 0, goods: `${units}× ${resource}`, note: goodsNote });
    }
    await tx(async (t) => {
      await t.run('UPDATE citizens SET energy = energy - 100, usd = usd + ?, energy_spent_today = energy_spent_today + 100, fatigue = fatigue + 100, shifts = shifts + 1, total_salary = total_salary + ? WHERE id = ?', [net, net, c.id]);
    });
    await addXp(c, xpGainForShift());
    await chronicleDone(c, 'shift');
    await setMission(c, 'energy', Math.min(500, (c.energy_spent_today || 0) + 100));
    res.json({ ok: true, gross, net, tax: gross * INCOME_TAX });
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
    if (c.gold < def.cost) return res.status(400).json({ error: `Mendirikan ${def.name} butuh ${def.cost} emas (kamu punya ${Math.floor(c.gold)}).` });
    if (type === 'resource' && !RESOURCE_PRODUCTS.includes(resource)) return res.status(400).json({ error: 'Pilih bahan mentah yang diproduksi.' });
    const res2 = await run(
      `INSERT INTO companies (owner_id, name, about, type, region_id, resource, created_at) VALUES (?,?,?,?,?,?,?) RETURNING id`,
      [c.id, (name || `${def.name} ${c.username}`).slice(0, 60), (about || '').slice(0, 200), type, c.region_id, resource || '', Date.now()]);
    await run('UPDATE citizens SET gold = gold - ? WHERE id = ?', [def.cost, c.id]);
    // Lowongan default perusahaan baru (1 kursi, gaji 40 USD).
    await run(`INSERT INTO jobs (company_id, is_admin, title, salary, salary_type, level_min, tier, seats, seats_taken, region_id, description, created_at)
      VALUES (?,0,?,?,?,?,1,1,?,0,?,?) RETURNING id`,
      [res2.id, `Pekerja ${def.name}`, 40, 'fixed', 1, c.region_id, 'Lowongan dari perusahaan milik warga.', Date.now()]);
    await chronicleDone(c, 'company');
    res.json({ ok: true, companyId: res2.id });
  }));

  app.post('/api/companies/:id/job', authRequired, citizenRequired, r(async (req, res) => {
    const co = await one('SELECT * FROM companies WHERE id = ?', [req.params.id]);
    if (!co) return res.status(404).json({ error: 'Perusahaan tidak ditemukan.' });
    if (co.owner_id !== req.citizen.id) return res.status(403).json({ error: 'Hanya pemilik yang bisa membuka lowongan.' });
    const { title, salary, salary_type, seats } = req.body || {};
    if (!title || !salary || salary <= 0) return res.status(400).json({ error: 'Judul dan gaji wajib diisi.' });
    const j = await run(`INSERT INTO jobs (company_id, is_admin, title, salary, salary_type, level_min, tier, seats, seats_taken, region_id, description, created_at)
      VALUES (?,0,?,?,?,?,1,1,?,?,0,?,?) RETURNING id`,
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
    const offers = await sql(
      `SELECT o.*, u.username AS seller, c.name AS commodity_name FROM market_offers o
       JOIN citizens sc ON sc.id = o.seller_id JOIN users u ON u.id = sc.user_id
       JOIN commodities c ON c.id = o.commodity_id
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
    res.json({
      scope, commodities: coms.map((c) => ({ ...c, best: bestMap[c.id]?.best ?? null, offers: bestMap[c.id]?.n ?? 0 })),
      stats: { offers: Number(stats.offers), tx: Number(txStats.tx), units: Number(txStats.units), turnover: Number(txStats.turnover) },
      offers, mine, recentTx,
    });
  }));

  app.post('/api/market/buy', authRequired, citizenRequired, r(async (req, res) => {
    const { offer_id, qty } = req.body || {};
    const q = Math.max(1, Math.floor(Number(qty) || 1));
    const result = await tx(async (t) => {
      const offer = await t.one('SELECT * FROM market_offers WHERE id = ?', [offer_id]);
      if (!offer) throw Object.assign(new Error('Penawaran tidak ditemukan.'), { status: 404 });
      if (offer.qty < q) throw Object.assign(new Error('Jumlah penawaran tidak mencukupi.'), { status: 400 });
      const buyer = await t.one('SELECT * FROM citizens WHERE id = ?', [req.citizen.id]);
      const seller = await t.one('SELECT * FROM citizens WHERE id = ?', [offer.seller_id]);
      if (buyer.id === seller.id) throw Object.assign(new Error('Tidak bisa membeli penawaran sendiri.'), { status: 400 });
      const currency = offer.scope === 'global' ? 'gold' : 'usd';
      const unitPrice = offer.price * (offer.scope === 'global' ? (1 + IMPORT_TAX) : 1);
      const total = unitPrice * q;
      if (buyer[currency] < total) throw Object.assign(new Error(`Saldo ${currency === 'gold' ? 'emas' : 'USD'} tidak cukup.`), { status: 400 });
      const sellerReceives = offer.price * q * (1 - INCOME_TAX);
      await t.run(`UPDATE citizens SET ${currency} = ${currency} - ? WHERE id = ?`, [total, buyer.id]);
      await t.run(`UPDATE citizens SET ${currency} = ${currency} + ? WHERE id = ?`, [sellerReceives, seller.id]);
      if (offer.qty === q) await t.run('DELETE FROM market_offers WHERE id = ?', [offer.id]);
      else await t.run('UPDATE market_offers SET qty = qty - ? WHERE id = ?', [q, offer.id]);
      await addItem(buyer.id, offer.commodity_id, offer.tier, q, t);
      await t.run('INSERT INTO market_tx (buyer_id, seller_id, scope, commodity_id, tier, qty, price_each, total, created_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id',
        [buyer.id, seller.id, offer.scope, offer.commodity_id, offer.tier, q, offer.price, total, Date.now()]);
      await t.run('UPDATE citizens SET purchases = purchases + 1 WHERE id = ?', [buyer.id]);
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
    const ok = await takeItem(req.citizen.id, commodity_id, t, q);
    if (!ok) return res.status(400).json({ error: 'Jumlah di inventaris tidak mencukupi.' });
    const o = await run(
      'INSERT INTO market_offers (seller_id, scope, commodity_id, tier, qty, price, created_at) VALUES (?,?,?,?,?,?,?) RETURNING id',
      [req.citizen.id, scope === 'global' ? 'global' : 'local', commodity_id, t, q, p, Date.now()]);
    await chronicleDone(req.citizen, 'sell');
    res.json({ ok: true, offerId: o.id });
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
    const c = req.citizen;
    if (c.gold < gold) return res.status(400).json({ error: 'Emas tidak cukup.' });
    await run('UPDATE citizens SET gold = gold - ?, usd = usd + ? WHERE id = ?', [gold, gold * MINT_RATE, c.id]);
    await chronicleDone(c, 'fx');
    res.json({ ok: true, usd: gold * MINT_RATE });
  }));

  app.post('/api/fx/offer', authRequired, citizenRequired, r(async (req, res) => {
    const { direction, price, qty_gold } = req.body || {};
    if (!['buy', 'sell'].includes(direction)) return res.status(400).json({ error: 'Arah tidak dikenal.' });
    const p = Number(price), q = Number(qty_gold);
    if (!p || p <= 0 || !q || q <= 0) return res.status(400).json({ error: 'Harga dan jumlah harus lebih dari 0.' });
    const existing = await one('SELECT id FROM fx_offers WHERE citizen_id = ? AND direction = ? AND expires_at > ?', [req.citizen.id, direction, Date.now()]);
    if (existing) return res.status(400).json({ error: 'Kamu sudah punya 1 penawaran terbuka ke arah ini. Batalkan dulu.' });
    if (direction === 'sell' && req.citizen.gold < q) return res.status(400).json({ error: 'Emas tidak cukup untuk penawaran jual ini.' });
    if (direction === 'buy' && req.citizen.usd < p * q) return res.status(400).json({ error: 'USD tidak cukup untuk penawaran beli ini.' });
    // Kunci dana: jual -> emas dikunci; beli -> USD dikunci.
    if (direction === 'sell') await run('UPDATE citizens SET gold = gold - ? WHERE id = ?', [q, req.citizen.id]);
    else await run('UPDATE citizens SET usd = usd - ? WHERE id = ?', [p * q, req.citizen.id]);
    const o = await run('INSERT INTO fx_offers (citizen_id, direction, price, qty_gold, expires_at, created_at) VALUES (?,?,?,?,?,?) RETURNING id',
      [req.citizen.id, direction, p, q, Date.now() + 72 * 60 * 60 * 1000, Date.now()]);
    await chronicleDone(req.citizen, 'fx');
    res.json({ ok: true, offerId: o.id });
  }));

  app.post('/api/fx/take', authRequired, citizenRequired, r(async (req, res) => {
    const { offer_id, qty } = req.body || {};
    const q = Number(qty);
    if (!q || q <= 0) return res.status(400).json({ error: 'Jumlah harus lebih dari 0.' });
    const result = await tx(async (t) => {
      const offer = await t.one('SELECT * FROM fx_offers WHERE id = ? AND expires_at > ?', [offer_id, Date.now()]);
      if (!offer) throw Object.assign(new Error('Penawaran tidak ditemukan / sudah kedaluwarsa.'), { status: 404 });
      const remaining = offer.qty_gold - offer.qty_filled;
      if (q > remaining) throw Object.assign(new Error('Jumlah melebihi sisa penawaran.'), { status: 400 });
      const me = await t.one('SELECT * FROM citizens WHERE id = ?', [req.citizen.id]);
      const other = await t.one('SELECT * FROM citizens WHERE id = ?', [offer.citizen_id]);
      if (me.id === other.id) throw Object.assign(new Error('Tidak bisa mengambil penawaran sendiri.'), { status: 400 });
      const usd = offer.price * q;
      if (offer.direction === 'sell') {
        // Saya membeli emas: bayar USD, terima emas (emas penjual sudah dikunci saat pasang).
        if (me.usd < usd) throw Object.assign(new Error('USD tidak cukup.'), { status: 400 });
        await t.run('UPDATE citizens SET usd = usd - ?, gold = gold + ? WHERE id = ?', [usd, q, me.id]);
        await t.run('UPDATE citizens SET usd = usd + ? WHERE id = ?', [usd, other.id]);
      } else {
        // Saya menjual emas ke penawaran beli: terima USD (USD pembeli sudah dikunci).
        if (me.gold < q) throw Object.assign(new Error('Emas tidak cukup.'), { status: 400 });
        await t.run('UPDATE citizens SET gold = gold - ?, usd = usd + ? WHERE id = ?', [q, usd, me.id]);
        await t.run('UPDATE citizens SET gold = gold + ? WHERE id = ?', [q, other.id]);
      }
      const filled = offer.qty_filled + q;
      if (filled >= offer.qty_gold) await t.run('DELETE FROM fx_offers WHERE id = ?', [offer.id]);
      else await t.run('UPDATE fx_offers SET qty_filled = ? WHERE id = ?', [filled, offer.id]);
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
    res.json({ region: reg, war, mySupport: !!mySupport, mine: req.citizen.region_id === reg.id, home: req.citizen.home_region_id === reg.id });
  }));

  app.post('/api/regions/travel', authRequired, citizenRequired, r(async (req, res) => {
    const { region_id } = req.body || {};
    const c = req.citizen;
    const target = await one('SELECT * FROM regions WHERE id = ?', [region_id]);
    if (!target) return res.status(404).json({ error: 'Wilayah tidak ditemukan.' });
    if (target.id === c.region_id) return res.status(400).json({ error: 'Kamu sudah berada di wilayah ini.' });
    // Tiket: pakai T1 dulu, lalu tingkat lebih tinggi.
    const ticket = await one('SELECT id FROM commodities WHERE name = ?', ['Tiket']);
    let used = false;
    for (let tier = 1; tier <= 5 && !used; tier++) {
      used = await takeItem(c.id, ticket.id, tier, 1);
    }
    if (!used) return res.status(400).json({ error: 'Butuh 1 Tiket untuk bepergian. Beli di pasar.' });
    await run('UPDATE citizens SET region_id = ? WHERE id = ?', [target.id, c.id]);
    await chronicleDone(c, 'travel');
    res.json({ ok: true, region: target.name });
  }));

  app.post('/api/regions/rebel', authRequired, citizenRequired, r(async (req, res) => {
    const { region_id } = req.body || {};
    const c = req.citizen;
    const reg = await one('SELECT * FROM regions WHERE id = ?', [region_id]);
    if (!reg) return res.status(404).json({ error: 'Wilayah tidak ditemukan.' });
    const existing = await one('SELECT * FROM war_support WHERE region_id = ? AND citizen_id = ?', [region_id, c.id]);
    if (existing) return res.status(400).json({ error: 'Kamu sudah mendukung pemberontakan di wilayah ini.' });
    const cost = reg.name === 'Jakarta' ? 100 : 50; // ibu kota lebih mahal
    if (c.gold < cost) return res.status(400).json({ error: `Dukung pemberontakan butuh ${cost} emas (hangus).` });
    const active = await one("SELECT * FROM wars WHERE region_id = ? AND status = 'active'", [region_id]);
    if (active) return res.status(400).json({ error: 'Sudah ada perang aktif di wilayah ini.' });
    await run('UPDATE citizens SET gold = gold - ? WHERE id = ?', [cost, c.id]);
    await run('INSERT INTO war_support (region_id, citizen_id) VALUES (?,?) RETURNING region_id', [region_id, c.id]);
    const count = await one('SELECT COUNT(*) AS n FROM war_support WHERE region_id = ?', [region_id]);
    let warStarted = false;
    if (Number(count.n) >= 5) {
      await run(
        `INSERT INTO wars (name, region_id, attacker_label, defender_label, ends_at, created_at) VALUES (?,?,?,?,?,?) RETURNING id`,
        [`Pemberontakan ${reg.name}`, region_id, `Pemberontak ${reg.name}`, 'Republik Indonesia', Date.now() + 24 * 60 * 60 * 1000, Date.now()]);
      await run('DELETE FROM war_support WHERE region_id = ?', [region_id]);
      warStarted = true;
    }
    res.json({ ok: true, supporters: Number(count.n), warStarted });
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
    const existing = await sql('SELECT * FROM convoys WHERE citizen_id = ?', [c.id]);
    if (existing.length >= slots) return res.status(400).json({ error: 'Slot konvoi penuh. Naik level / Premium untuk slot tambahan.' });
    if (existing.some((x) => x.building === building)) return res.status(400).json({ error: 'Satu bangunan per jenis dalam satu waktu.' });
    if (c.gold < 10) return res.status(400).json({ error: 'Membangun konvoi butuh 10 emas.' });
    const slot = existing.length;
    await run('UPDATE citizens SET gold = gold - 10 WHERE id = ?', [c.id]);
    const cv = await run('INSERT INTO convoys (citizen_id, slot, building, region_id, expires_at, created_at) VALUES (?,?,?,?,?,?) RETURNING id',
      [c.id, slot, building, c.region_id, Date.now() + 7 * 24 * 60 * 60 * 1000, Date.now()]);
    res.json({ ok: true, convoyId: cv.id });
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

  app.get('/api/world', r(async (req, res) => {
    const world = await one('SELECT * FROM world WHERE id = 1');
    const population = await one('SELECT COUNT(*) AS n FROM citizens');
    const regions = await one('SELECT COUNT(*) AS n FROM regions');
    res.json({ day: world?.day || 1, population: Number(population.n), regions: Number(regions.n), countries: 1 });
  }));
}
