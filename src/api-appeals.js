// Parlementer — sistem BANDING untuk akun yang di-ban.
// Alur: pemain yang di-ban mengajukan banding dari layar banned (form +
// thread pesan dua arah dengan admin). Admin meninjau dari panel Admin:
// membalas, "Cabut Ban" (terima → unban) atau "Tolak Banding" (pemain boleh
// mengajukan banding baru). Satu appeal AKTIF (status 'menunggu') per akun.
//
// Otorisasi: pemain hanya bisa melihat/membalas appeal miliknya sendiri;
// admin bisa melihat semua. Route ini memakai authRequired saja (bukan
// citizenRequired) supaya pemain banned — yang diblokir middleware penjaga
// banned dari semua API game — tetap bisa mengakses bandingnya. Middleware
// itu mengecualikan path /api/appeals* dan /api/admin/appeals* (lihat
// src/app.js).
import { one, sql, run, tx } from './db.js';
import { authRequired, publicId } from './util.js';
import { adminOnly } from './api-admin.js';
import { notify } from './api-civic.js';

async function loadAppeal(id) {
  const a = await one('SELECT * FROM appeals WHERE id = ?', [id]);
  if (!a) return null;
  const msgs = await sql(
    'SELECT * FROM appeal_messages WHERE appeal_id = ? ORDER BY created_at ASC, id ASC', [id]);
  const u = await one(
    'SELECT id, username, email, is_banned, banned_reason FROM users WHERE id = ?', [a.user_id]);
  return {
    ...a,
    messages: msgs,
    user: u ? {
      id: u.id,
      username: u.username,
      publicId: publicId(u.id),
      is_banned: !!u.is_banned,
      banned_reason: u.banned_reason,
    } : null,
  };
}

async function notifyAdmins(title, content) {
  const admins = await sql(
    'SELECT c.id FROM citizens c JOIN users u ON u.id = c.user_id WHERE u.is_admin = 1');
  for (const a of admins) await notify(a.id, 'ADMIN', title, content);
}

async function notifyPlayer(userId, title, content) {
  const c = await one('SELECT id FROM citizens WHERE user_id = ?', [userId]);
  if (c) await notify(c.id, 'ADMIN', title, content);
}

export function registerAppeals(app) {
  // ---------- Pemain: ajukan banding ----------
  // POST /api/appeals { text } — hanya untuk akun yang sedang di-ban.
  app.post('/api/appeals', authRequired, async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (text.length < 10) return res.status(400).json({ error: 'Tulis alasan bandingmu (minimal 10 karakter).' });
    if (text.length > 2000) return res.status(400).json({ error: 'Alasan banding maksimal 2000 karakter.' });
    const user = await one('SELECT * FROM users WHERE id = ?', [req.userId]);
    if (!user) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
    if (!user.is_banned) return res.status(400).json({ error: 'Akunmu tidak sedang di-ban, jadi tidak perlu banding.' });
    const active = await one(
      "SELECT id FROM appeals WHERE user_id = ? AND status = 'menunggu'", [req.userId]);
    if (active) {
      return res.status(400).json({ error: 'Kamu sudah punya banding yang sedang menunggu ditinjau.', appealId: active.id });
    }
    const now = Date.now();
    const appeal = await run(
      'INSERT INTO appeals (user_id, ban_reason, text, status, created_at) VALUES (?,?,?,?,?) RETURNING id',
      [req.userId, user.banned_reason || '', text, 'menunggu', now]);
    await run(
      'INSERT INTO appeal_messages (appeal_id, sender_id, sender_role, text, created_at) VALUES (?,?,?,?,?) RETURNING id',
      [appeal.id, req.userId, 'pemain', text, now]);
    await notifyAdmins('Banding baru masuk', `${user.username} (${publicId(user.id)}) mengajukan banding: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);
    res.json({ ok: true, appealId: appeal.id });
  });

  // ---------- Pemain: daftar banding milik sendiri ----------
  // GET /api/appeals/mine — semua banding akun ini, terbaru dulu, beserta thread.
  app.get('/api/appeals/mine', authRequired, async (req, res) => {
    const rows = await sql(
      'SELECT * FROM appeals WHERE user_id = ? ORDER BY created_at DESC, id DESC', [req.userId]);
    const appeals = [];
    for (const a of rows) appeals.push(await loadAppeal(a.id));
    res.json({ appeals });
  });

  // ---------- Detail banding (pemilik atau admin) ----------
  // GET /api/appeals/:id
  app.get('/api/appeals/:id', authRequired, async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID banding tidak valid.' });
    const appeal = await loadAppeal(id);
    if (!appeal) return res.status(404).json({ error: 'Banding tidak ditemukan.' });
    const me = await one('SELECT is_admin FROM users WHERE id = ?', [req.userId]);
    if (appeal.user_id !== req.userId && !me?.is_admin) {
      return res.status(403).json({ error: 'Ini bukan bandingmu.' });
    }
    res.json({ appeal });
  });

  // ---------- Balas di thread banding (pemilik atau admin) ----------
  // POST /api/appeals/:id/message { text }
  app.post('/api/appeals/:id/message', authRequired, async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID banding tidak valid.' });
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Pesan tidak boleh kosong.' });
    if (text.length > 1000) return res.status(400).json({ error: 'Pesan maksimal 1000 karakter.' });
    const appeal = await one('SELECT * FROM appeals WHERE id = ?', [id]);
    if (!appeal) return res.status(404).json({ error: 'Banding tidak ditemukan.' });
    const me = await one('SELECT id, username, is_admin FROM users WHERE id = ?', [req.userId]);
    if (!me) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
    const isAdmin = !!me.is_admin;
    if (appeal.user_id !== req.userId && !isAdmin) {
      return res.status(403).json({ error: 'Ini bukan bandingmu.' });
    }
    if (appeal.status !== 'menunggu') {
      return res.status(400).json({ error: 'Banding ini sudah diputuskan, tidak bisa dibalas lagi.' });
    }
    const now = Date.now();
    const role = isAdmin ? 'admin' : 'pemain';
    await run(
      'INSERT INTO appeal_messages (appeal_id, sender_id, sender_role, text, created_at) VALUES (?,?,?,?,?) RETURNING id',
      [id, req.userId, role, text, now]);
    if (isAdmin) {
      await notifyPlayer(appeal.user_id, 'Admin membalas bandingmu', `Admin membalas bandingmu: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);
    } else {
      await notifyAdmins('Balasan banding baru', `${me.username} membalas banding #${id}.`);
    }
    res.json({ ok: true });
  });

  // ---------- Admin: daftar semua banding ----------
  // GET /api/admin/appeals — terbaru dulu, lengkap dengan info pemain.
  app.get('/api/admin/appeals', authRequired, adminOnly, async (_req, res) => {
    const rows = await sql(
      `SELECT a.*, u.username, u.email,
        (SELECT COUNT(*) FROM appeal_messages WHERE appeal_id = a.id) AS messages_count
       FROM appeals a JOIN users u ON u.id = a.user_id
       ORDER BY a.created_at DESC, a.id DESC`);
    const appeals = rows.map((a) => ({
      ...a,
      publicId: publicId(a.user_id),
    }));
    res.json({ appeals });
  });

  // ---------- Admin: balas banding ----------
  // POST /api/admin/appeals/:id/message { text }
  app.post('/api/admin/appeals/:id/message', authRequired, adminOnly, async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID banding tidak valid.' });
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Pesan tidak boleh kosong.' });
    if (text.length > 1000) return res.status(400).json({ error: 'Pesan maksimal 1000 karakter.' });
    const appeal = await one('SELECT * FROM appeals WHERE id = ?', [id]);
    if (!appeal) return res.status(404).json({ error: 'Banding tidak ditemukan.' });
    if (appeal.status !== 'menunggu') {
      return res.status(400).json({ error: 'Banding ini sudah diputuskan, tidak bisa dibalas lagi.' });
    }
    await run(
      'INSERT INTO appeal_messages (appeal_id, sender_id, sender_role, text, created_at) VALUES (?,?,?,?,?) RETURNING id',
      [id, req.userId, 'admin', text, Date.now()]);
    await notifyPlayer(appeal.user_id, 'Admin membalas bandingmu', `Admin membalas bandingmu: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);
    res.json({ ok: true });
  });

  // ---------- Admin: putuskan banding ----------
  // POST /api/admin/appeals/:id/decide { decision: 'accept' | 'reject' }
  // accept → cabut ban (akun bisa login & main lagi), appeal jadi 'diterima'.
  // reject → appeal jadi 'ditolak'; pemain boleh mengajukan banding baru.
  app.post('/api/admin/appeals/:id/decide', authRequired, adminOnly, async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID banding tidak valid.' });
    const decision = req.body?.decision;
    if (decision !== 'accept' && decision !== 'reject') {
      return res.status(400).json({ error: 'Keputusan harus "accept" atau "reject".' });
    }
    const appeal = await one('SELECT * FROM appeals WHERE id = ?', [id]);
    if (!appeal) return res.status(404).json({ error: 'Banding tidak ditemukan.' });
    if (appeal.status !== 'menunggu') {
      return res.status(400).json({ error: 'Banding ini sudah diputuskan.' });
    }
    const now = Date.now();
    const status = decision === 'accept' ? 'diterima' : 'ditolak';
    await tx(async (t) => {
      await t.run(
        'UPDATE appeals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?',
        [status, now, req.userId, id]);
      if (decision === 'accept') {
        await t.run(
          "UPDATE users SET is_banned = 0, banned_reason = '', banned_at = 0 WHERE id = ?",
          [appeal.user_id]);
        await t.run(
          'INSERT INTO admin_actions (admin_id, target_id, action, detail, created_at) VALUES (?,?,?,?,?) RETURNING id',
          [req.userId, appeal.user_id, 'unban', `Banding #${id} diterima`, now]);
      }
      await t.run(
        'INSERT INTO admin_actions (admin_id, target_id, action, detail, created_at) VALUES (?,?,?,?,?) RETURNING id',
        [req.userId, appeal.user_id, decision === 'accept' ? 'appeal_accept' : 'appeal_reject', `Banding #${id} ${status}`, now]);
    });
    if (decision === 'accept') {
      await notifyPlayer(appeal.user_id, 'Bandingmu DITERIMA', 'Admin mencabut ban akunmu. Kamu bisa masuk ke game lagi.');
    } else {
      await notifyPlayer(appeal.user_id, 'Bandingmu DITOLAK', 'Admin menolak bandingmu. Kamu boleh mengajukan banding baru dengan penjelasan yang lebih lengkap.');
    }
    res.json({ ok: true, status });
  });
}
