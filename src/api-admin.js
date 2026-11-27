// API Admin Parlementer — hanya untuk akun admin (email ADMIN_EMAIL).
// Semua route di sini WAJIB lewat adminOnly: sesi login + is_admin = 1,
// selain itu 403. Tidak ada endpoint promosi admin: satu-satunya cara jadi
// admin adalah mendaftar dengan email ADMIN_EMAIL (lihat api-core.js) atau
// migrasi initDb yang menandai email itu.
import { sql, one, run, tx } from './db.js';
import { authRequired, publicId } from './util.js';

const PREMIUM_MONTHS = [1, 3, 6, 12];
const DAY_MS = 24 * 60 * 60 * 1000;
const GRANT_ITEMS = ['Makanan', 'Senjata', 'Tiket'];
const MAX_GRANT = 1000000;

async function adminOnly(req, res, next) {
  const u = await one('SELECT is_admin FROM users WHERE id = ?', [req.userId]);
  if (!u || !u.is_admin) return res.status(403).json({ error: 'Hanya admin yang bisa mengakses ini.' });
  next();
}

async function logAction(t, adminId, targetId, action, detail) {
  await t.run('INSERT INTO admin_actions (admin_id, target_id, action, detail, created_at) VALUES (?,?,?,?,?) RETURNING id',
    [adminId, targetId, action, detail, Date.now()]);
}

async function notifyCitizen(t, citizenId, title, content) {
  await t.run('INSERT INTO notifications (citizen_id, category, title, content, created_at) VALUES (?,?,?,?,?) RETURNING id',
    [citizenId, 'ADMIN', title, content, Date.now()]);
}

async function addItemTx(t, citizenId, commodityId, tier, qty) {
  const row = await t.one('SELECT * FROM inventory WHERE citizen_id = ? AND commodity_id = ? AND tier = ?',
    [citizenId, commodityId, tier]);
  if (row) await t.run('UPDATE inventory SET qty = qty + ? WHERE id = ?', [qty, row.id]);
  else await t.run('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,?,?) RETURNING id',
    [citizenId, commodityId, tier, qty]);
}

function parseTargetId(q) {
  if (!q) return null;
  const s = String(q).trim().toUpperCase();
  const m = s.match(/^PL-?(\d{1,6})$/);
  if (m) return Number(m[1]);
  if (/^\d+$/.test(s)) return Number(s);
  return null;
}

export function registerAdmin(app) {
  const r = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const admin = (req, res, next) => Promise.resolve(adminOnly(req, res, next)).catch(next);

  // ---------- DAFTAR PEMAIN ----------
  app.get('/api/admin/players', authRequired, admin, r(async (req, res) => {
    const q = (req.query.q || '').trim();
    const params = [];
    let where = '1=1';
    const targetId = parseTargetId(q);
    if (targetId) { where += ' AND u.id = ?'; params.push(targetId); }
    else if (q) { where += ' AND (u.username LIKE ? OR u.email LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
    const rows = await sql(
      `SELECT u.id, u.username, u.email, u.is_admin, u.is_banned, u.banned_reason,
         u.premium_until, u.created_at, c.level, c.gold, c.usd
       FROM users u JOIN citizens c ON c.user_id = u.id
       WHERE ${where} ORDER BY u.id ASC LIMIT 100`,
      params);
    res.json({
      players: rows.map((p) => ({
        ...p,
        publicId: publicId(p.id),
        isPremium: p.premium_until > Date.now(),
      })),
    });
  }));

  // ---------- LOG ADMIN ----------
  app.get('/api/admin/actions', authRequired, admin, r(async (req, res) => {
    const rows = await sql(
      `SELECT a.*, au.username AS admin_name, tu.username AS target_name
       FROM admin_actions a
       JOIN users au ON au.id = a.admin_id
       JOIN users tu ON tu.id = a.target_id
       ORDER BY a.created_at DESC LIMIT 100`);
    res.json({ actions: rows });
  }));

  // ---------- BAN / UNBAN ----------
  app.post('/api/admin/ban', authRequired, admin, r(async (req, res) => {
    const { user_id, reason } = req.body || {};
    const target = await one('SELECT u.*, c.id AS citizen_id FROM users u JOIN citizens c ON c.user_id = u.id WHERE u.id = ?', [Number(user_id)]);
    if (!target) return res.status(404).json({ error: 'Pemain tidak ditemukan.' });
    if (target.is_admin) return res.status(400).json({ error: 'Akun admin tidak bisa dibanned.' });
    if (target.is_banned) return res.status(400).json({ error: 'Pemain ini sudah dibanned.' });
    const cleanReason = (reason || '').trim().slice(0, 200);
    if (!cleanReason) return res.status(400).json({ error: 'Alasan ban wajib diisi.' });
    await tx(async (t) => {
      await t.run('UPDATE users SET is_banned = 1, banned_reason = ?, banned_at = ? WHERE id = ?',
        [cleanReason, Date.now(), target.id]);
      await logAction(t, req.userId, target.id, 'ban', `Ban: ${cleanReason}`);
      await notifyCitizen(t, target.citizen_id, 'Akun dibanned', `Akunmu dibanned oleh admin. Alasan: ${cleanReason}`);
    });
    res.json({ ok: true });
  }));

  app.post('/api/admin/unban', authRequired, admin, r(async (req, res) => {
    const { user_id } = req.body || {};
    const target = await one('SELECT u.*, c.id AS citizen_id FROM users u JOIN citizens c ON c.user_id = u.id WHERE u.id = ?', [Number(user_id)]);
    if (!target) return res.status(404).json({ error: 'Pemain tidak ditemukan.' });
    if (!target.is_banned) return res.status(400).json({ error: 'Pemain ini tidak sedang dibanned.' });
    await tx(async (t) => {
      await t.run("UPDATE users SET is_banned = 0, banned_reason = '', banned_at = 0 WHERE id = ?", [target.id]);
      await logAction(t, req.userId, target.id, 'unban', 'Unban: akses dipulihkan');
      await notifyCitizen(t, target.citizen_id, 'Ban dicabut', 'Admin mencabut ban akunmu. Kamu bisa masuk kembali.');
    });
    res.json({ ok: true });
  }));

  // ---------- BERI PREMIUM ----------
  app.post('/api/admin/premium', authRequired, admin, r(async (req, res) => {
    const { user_id, months } = req.body || {};
    const m = Number(months);
    if (!PREMIUM_MONTHS.includes(m)) return res.status(400).json({ error: 'Durasi premium harus 1, 3, 6, atau 12 bulan.' });
    const target = await one('SELECT u.*, c.id AS citizen_id FROM users u JOIN citizens c ON c.user_id = u.id WHERE u.id = ?', [Number(user_id)]);
    if (!target) return res.status(404).json({ error: 'Pemain tidak ditemukan.' });
    const now = Date.now();
    const until = Math.max(now, target.premium_until || 0) + m * 30 * DAY_MS;
    await tx(async (t) => {
      await t.run('UPDATE users SET premium_until = ? WHERE id = ?', [until, target.id]);
      await logAction(t, req.userId, target.id, 'premium', `Premium ${m} bulan (sampai ${new Date(until).toLocaleDateString('id-ID')})`);
      await notifyCitizen(t, target.citizen_id, 'Kamu mendapat Premium!', `Admin memberimu Premium ${m} bulan. Nikmati keuntungannya!`);
    });
    res.json({ ok: true, premium_until: until });
  }));

  // ---------- BERI EMAS / USD ----------
  app.post('/api/admin/gold', authRequired, admin, r(async (req, res) => {
    const { user_id, amount } = req.body || {};
    const amt = Number(amount);
    if (!amt || amt <= 0 || amt > MAX_GRANT || !Number.isFinite(amt)) {
      return res.status(400).json({ error: `Jumlah emas harus 1–${MAX_GRANT}.` });
    }
    const target = await one('SELECT u.*, c.id AS citizen_id FROM users u JOIN citizens c ON c.user_id = u.id WHERE u.id = ?', [Number(user_id)]);
    if (!target) return res.status(404).json({ error: 'Pemain tidak ditemukan.' });
    await tx(async (t) => {
      await t.run('UPDATE citizens SET gold = gold + ? WHERE id = ?', [amt, target.citizen_id]);
      await logAction(t, req.userId, target.id, 'gold', `+${amt} emas`);
      await notifyCitizen(t, target.citizen_id, 'Hadiah dari admin', `Admin memberimu +${amt} emas.`);
    });
    res.json({ ok: true });
  }));

  app.post('/api/admin/usd', authRequired, admin, r(async (req, res) => {
    const { user_id, amount } = req.body || {};
    const amt = Number(amount);
    if (!amt || amt <= 0 || amt > MAX_GRANT || !Number.isFinite(amt)) {
      return res.status(400).json({ error: `Jumlah USD harus 1–${MAX_GRANT}.` });
    }
    const target = await one('SELECT u.*, c.id AS citizen_id FROM users u JOIN citizens c ON c.user_id = u.id WHERE u.id = ?', [Number(user_id)]);
    if (!target) return res.status(404).json({ error: 'Pemain tidak ditemukan.' });
    await tx(async (t) => {
      await t.run('UPDATE citizens SET usd = usd + ? WHERE id = ?', [amt, target.citizen_id]);
      await logAction(t, req.userId, target.id, 'usd', `+${amt} USD`);
      await notifyCitizen(t, target.citizen_id, 'Hadiah dari admin', `Admin memberimu +${amt} USD.`);
    });
    res.json({ ok: true });
  }));

  // ---------- BERI BARANG ----------
  app.post('/api/admin/item', authRequired, admin, r(async (req, res) => {
    const { user_id, commodity, tier, qty } = req.body || {};
    if (!GRANT_ITEMS.includes(commodity)) return res.status(400).json({ error: 'Barang harus Makanan, Senjata, atau Tiket.' });
    const t = Math.max(1, Math.min(5, Number(tier) || 1));
    const q = Math.floor(Number(qty) || 0);
    if (q <= 0 || q > 10000) return res.status(400).json({ error: 'Jumlah barang harus 1–10000.' });
    const target = await one('SELECT u.*, c.id AS citizen_id FROM users u JOIN citizens c ON c.user_id = u.id WHERE u.id = ?', [Number(user_id)]);
    if (!target) return res.status(404).json({ error: 'Pemain tidak ditemukan.' });
    const com = await one('SELECT id FROM commodities WHERE name = ?', [commodity]);
    await tx(async (tt) => {
      await addItemTx(tt, target.citizen_id, com.id, t, q);
      await logAction(tt, req.userId, target.id, 'item', `+${q}× ${commodity} T${t}`);
      await notifyCitizen(tt, target.citizen_id, 'Hadiah dari admin', `Admin memberimu ${q}× ${commodity} T${t}.`);
    });
    res.json({ ok: true });
  }));

  // ---------- ISI ENERGI ----------
  app.post('/api/admin/energy', authRequired, admin, r(async (req, res) => {
    const { user_id } = req.body || {};
    const target = await one('SELECT u.*, c.id AS citizen_id FROM users u JOIN citizens c ON c.user_id = u.id WHERE u.id = ?', [Number(user_id)]);
    if (!target) return res.status(404).json({ error: 'Pemain tidak ditemukan.' });
    const cap = target.premium_until > Date.now() ? 120 : 100;
    await tx(async (t) => {
      await t.run('UPDATE citizens SET energy = ? WHERE id = ?', [cap, target.citizen_id]);
      await logAction(t, req.userId, target.id, 'energy', `Energi diisi penuh (${cap})`);
      await notifyCitizen(t, target.citizen_id, 'Energi diisi admin', `Admin mengisi energimu sampai penuh (${cap}).`);
    });
    res.json({ ok: true, energy: cap });
  }));
}
