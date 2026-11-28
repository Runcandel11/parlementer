// API Customer Service Parlementer (v5.7.4).
// Satu thread per pemain (cs_threads.citizen_id UNIQUE), dijawab MANUSIA —
// agen CS (Muse Angelica, akun dengan users.is_cs_agent = 1) atau admin.
// BUKAN bot auto-reply: tidak ada balasan otomatis di mana pun; bila belum
// ada balasan, client menampilkan status jujur "Menunggu balasan customer
// service". Parent (Muse utama) membaca riwayat chat CS dan memperbaiki
// apa yang salah — bug/masalah yang dilaporkan pemain lewat CS menjadi
// bahan perbaikan (tiket/batch perbaikan seperti biasa).
//
// PERAN AGEN CS (keputusan desain — lihat docs/ARSITEKTUR.md):
// flag users.is_cs_agent (kolom, pola is_admin). Akun CS HANYA bisa baca +
// balas chat CS (endpoint /api/admin/cs* lewat csStaffOnly); semua endpoint
// admin lain tetap adminOnly (grant, tiket, ban, dsb. → 403 untuk agen CS).
// Akunnya dibuat parent/bos setelah merge — flag di-set manual:
//   UPDATE users SET is_cs_agent = 1 WHERE email = '<email agen CS>';
// Jangan hardcode password/kredensial di repo.
//
// PENANDA BACA (keputusan desain): kolom di cs_threads (pola chat_read,
// tapi dua sisi) — player_last_read_at (pemain sudah baca balasan terakhir?)
// dan agent_last_read_at (staf sudah baca pesan pemain terakhir?). Dot
// belum-dibaca di tombol mengambang = ada balasan (agent/admin) yang
// created_at-nya lebih baru dari player_last_read_at.
import { sql, one, run, tx, forUpdate } from './db.js';
import { authRequired, citizenRequired, publicId } from './util.js';
import { checkRateLimit } from './rate-limit.js';
import { adminOnly, logAction, notifyCitizen } from './api-admin.js';
import { CS_COOLDOWN_MS, CS_MESSAGE_MAX_LEN } from './game.js';

// Staf CS = admin ATAU akun agen CS. Selain itu 403. req.isAdmin dipakai
// handler balasan untuk mencatat sender yang benar ('admin' vs 'agent').
export async function csStaffOnly(req, res, next) {
  const u = await one('SELECT is_admin, is_cs_agent FROM users WHERE id = ?', [req.userId]);
  if (!u || (!u.is_admin && !u.is_cs_agent)) {
    return res.status(403).json({ error: 'Hanya staf Customer Service yang bisa mengakses ini.' });
  }
  req.isAdmin = !!u.is_admin;
  next();
}

// Batas aksi staf CS (pola admin: maks 120 POST/jam per akun, DB-backed).
async function staffPostLimit(req, res, next) {
  try {
    const lim = await checkRateLimit('cs-staff:' + req.userId, 120, 60 * 60 * 1000);
    if (!lim.allowed) return res.status(429).json({ error: 'Terlalu banyak aksi. Coba lagi nanti.' });
  } catch (e) {
    console.error('[rate-limit] cs gagal:', e.message);
  }
  next();
}

function unreadForPlayer(citizenId) {
  return one(
    `SELECT COUNT(*) AS n FROM cs_messages m JOIN cs_threads t ON t.id = m.thread_id
     WHERE t.citizen_id = ? AND m.sender IN ('agent','admin') AND m.created_at > t.player_last_read_at`,
    [citizenId]);
}

export function registerCs(app) {
  const r = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---------- PEMAIN: KIRIM PESAN ----------
  // Thread dibuat otomatis saat pesan pertama. Pesan baru ke thread yang
  // sudah 'closed' membuka lagi thread itu (pemain yang menulis lagi =
  // masalahnya belum selesai). Cooldown 5 detik atomik (pola chat:
  // kunci baris warga, cek last_cs_at segar, simpan + update dalam tx).
  // Tanpa requireCredit: dukungan harus bisa dihubungi siapa pun.
  app.post('/api/cs/messages', authRequired, citizenRequired, r(async (req, res) => {
    const text = String(req.body?.body || req.body?.content || '').trim();
    if (!text || text.length > CS_MESSAGE_MAX_LEN) {
      return res.status(400).json({ error: `Pesan 1–${CS_MESSAGE_MAX_LEN} karakter.` });
    }
    const c = req.citizen;
    const now = Date.now();
    const out = await tx(async (t) => {
      const locked = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [c.id]);
      if (now - (locked.last_cs_at || 0) < CS_COOLDOWN_MS) {
        throw Object.assign(new Error('Tunggu sebentar sebelum mengirim pesan lagi.'), { status: 400 });
      }
      let thread = await t.one('SELECT * FROM cs_threads WHERE citizen_id = ?', [c.id]);
      let reopened = false;
      if (!thread) {
        thread = await t.run(
          'INSERT INTO cs_threads (citizen_id, status, created_at, last_message_at, player_last_read_at, agent_last_read_at) VALUES (?,?,?,?,?,?) RETURNING id',
          [c.id, 'open', now, now, now, 0]);
      } else if (thread.status === 'closed') {
        await t.run("UPDATE cs_threads SET status = 'open', last_message_at = ?, player_last_read_at = ? WHERE id = ?",
          [now, now, thread.id]);
        reopened = true;
      } else {
        await t.run('UPDATE cs_threads SET last_message_at = ?, player_last_read_at = ? WHERE id = ?',
          [now, now, thread.id]);
      }
      const msg = await t.run(
        'INSERT INTO cs_messages (thread_id, sender, sender_id, body, created_at) VALUES (?,?,?,?,?) RETURNING id',
        [thread.id, 'player', c.id, text, now]);
      await t.run('UPDATE citizens SET last_cs_at = ? WHERE id = ?', [now, c.id]);
      return { threadId: thread.id, messageId: msg.id, reopened };
    });
    res.json({ ok: true, ...out });
  }));

  // ---------- PEMAIN: BACA THREAD SENDIRI ----------
  // Hanya thread milik sendiri (tidak ada parameter id — pemain lain tidak
  // bisa membaca thread orang). Membuka thread menandai balasan sudah
  // dibaca (dot mengambang hilang).
  app.get('/api/cs/thread', authRequired, citizenRequired, r(async (req, res) => {
    const thread = await one('SELECT * FROM cs_threads WHERE citizen_id = ?', [req.citizen.id]);
    if (!thread) return res.json({ thread: null, messages: [] });
    const messages = await sql(
      'SELECT * FROM cs_messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC LIMIT 100',
      [thread.id]);
    await run('UPDATE cs_threads SET player_last_read_at = ? WHERE id = ?', [Date.now(), thread.id]);
    res.json({ thread, messages });
  }));

  // ---------- PEMAIN: JUMLAH BALASAN BELUM DIBACA (dot tombol mengambang) ----------
  app.get('/api/cs/unread', authRequired, citizenRequired, r(async (req, res) => {
    const row = await unreadForPlayer(req.citizen.id);
    res.json({ unread: Number(row?.n || 0) });
  }));

  // ---------- STAF: DAFTAR THREAD ----------
  // Pemain, status, pesan terakhir + pengirimnya, waktu, jumlah pesan pemain
  // yang belum dibaca staf. ?status=open|closed untuk filter (default semua).
  app.get('/api/admin/cs', authRequired, csStaffOnly, r(async (req, res) => {
    const status = (req.query.status || '').trim();
    const where = ['open', 'closed'].includes(status) ? 'AND t.status = ?' : '';
    const params = where ? [status] : [];
    const rows = await sql(
      `SELECT t.*, u.username, u.email, u.id AS user_id,
         (SELECT body FROM cs_messages WHERE thread_id = t.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_body,
         (SELECT sender FROM cs_messages WHERE thread_id = t.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_sender,
         (SELECT COUNT(*) FROM cs_messages WHERE thread_id = t.id AND sender = 'player' AND created_at > t.agent_last_read_at) AS unread
       FROM cs_threads t JOIN citizens c ON c.id = t.citizen_id JOIN users u ON u.id = c.user_id
       WHERE 1=1 ${where} ORDER BY t.last_message_at DESC, t.id DESC LIMIT 200`,
      params);
    res.json({ threads: rows.map((t) => ({ ...t, publicId: publicId(t.user_id) })) });
  }));

  // ---------- STAF: ISI SATU THREAD ----------
  // Membuka thread menandai pesan pemain sudah dibaca staf (angka
  // belum-dibaca di daftar hilang).
  app.get('/api/admin/cs/:id', authRequired, csStaffOnly, r(async (req, res) => {
    const id = Number(req.params.id);
    const thread = await one(
      `SELECT t.*, u.username, u.email, u.id AS user_id FROM cs_threads t
       JOIN citizens c ON c.id = t.citizen_id JOIN users u ON u.id = c.user_id WHERE t.id = ?`,
      [id]);
    if (!thread) return res.status(404).json({ error: 'Thread tidak ditemukan.' });
    const messages = await sql(
      'SELECT * FROM cs_messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC LIMIT 200',
      [id]);
    await run('UPDATE cs_threads SET agent_last_read_at = ? WHERE id = ?', [Date.now(), id]);
    res.json({ thread: { ...thread, publicId: publicId(thread.user_id) }, messages });
  }));

  // ---------- STAF: BALAS ----------
  // sender dicatat jujur: 'admin' bila yang membalas admin, 'agent' bila
  // akun agen CS. Balasan ke thread 'closed' membuka lagi thread itu.
  // Pemain mendapat notifikasi "Balasan Customer Service" (dot mengambang
  // + notifikasi — pola balasan tiket).
  app.post('/api/admin/cs/:id/reply', authRequired, csStaffOnly, staffPostLimit, r(async (req, res) => {
    const id = Number(req.params.id);
    const text = String(req.body?.body || req.body?.text || '').trim();
    if (!text || text.length > CS_MESSAGE_MAX_LEN) {
      return res.status(400).json({ error: `Balasan 1–${CS_MESSAGE_MAX_LEN} karakter.` });
    }
    const thread = await one('SELECT * FROM cs_threads WHERE id = ?', [id]);
    if (!thread) return res.status(404).json({ error: 'Thread tidak ditemukan.' });
    const sender = req.isAdmin ? 'admin' : 'agent';
    const now = Date.now();
    const staffCitizen = await one('SELECT id, user_id FROM citizens WHERE user_id = ?', [req.userId]);
    await tx(async (t) => {
      await t.run(
        'INSERT INTO cs_messages (thread_id, sender, sender_id, body, created_at) VALUES (?,?,?,?,?) RETURNING id',
        [id, sender, staffCitizen?.id || null, text, now]);
      await t.run("UPDATE cs_threads SET status = 'open', last_message_at = ?, agent_last_read_at = ? WHERE id = ?",
        [now, now, id]);
      await notifyCitizen(t, thread.citizen_id, 'Balasan Customer Service', text);
      const owner = await t.one('SELECT user_id FROM citizens WHERE id = ?', [thread.citizen_id]);
      if (owner) await logAction(t, req.userId, owner.user_id, 'cs_reply', `CS #${id} (${sender}): "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);
    });
    res.json({ ok: true, sender });
  }));

  // ---------- ADMIN SAJA: TUTUP / BUKA LAGI ----------
  // Agen CS tidak bisa menutup thread (keputusan admin). Menutup tidak
  // menghapus apa pun — pemain yang menulis lagi membuka thread otomatis.
  app.post('/api/admin/cs/:id/close', authRequired, adminOnly, staffPostLimit, r(async (req, res) => {
    const id = Number(req.params.id);
    const thread = await one('SELECT * FROM cs_threads WHERE id = ?', [id]);
    if (!thread) return res.status(404).json({ error: 'Thread tidak ditemukan.' });
    await tx(async (t) => {
      await t.run("UPDATE cs_threads SET status = 'closed' WHERE id = ?", [id]);
      const owner = await t.one('SELECT user_id FROM citizens WHERE id = ?', [thread.citizen_id]);
      if (owner) await logAction(t, req.userId, owner.user_id, 'cs_close', `Thread CS #${id} ditutup.`);
    });
    res.json({ ok: true, status: 'closed' });
  }));

  app.post('/api/admin/cs/:id/reopen', authRequired, adminOnly, staffPostLimit, r(async (req, res) => {
    const id = Number(req.params.id);
    const thread = await one('SELECT * FROM cs_threads WHERE id = ?', [id]);
    if (!thread) return res.status(404).json({ error: 'Thread tidak ditemukan.' });
    await tx(async (t) => {
      await t.run("UPDATE cs_threads SET status = 'open' WHERE id = ?", [id]);
      const owner = await t.one('SELECT user_id FROM citizens WHERE id = ?', [thread.citizen_id]);
      if (owner) await logAction(t, req.userId, owner.user_id, 'cs_reopen', `Thread CS #${id} dibuka lagi.`);
    });
    res.json({ ok: true, status: 'open' });
  }));
}
