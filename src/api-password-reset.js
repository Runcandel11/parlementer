// Parlementer — sistem LUPA PASSWORD (v5.5.0).
// Game BELUM punya layanan email, jadi alur sepenuhnya in-app (desain yang
// disetujui pemilik, 28 Nov 2026 12:12 WIB):
//   (1) Pemain yang terkunci mengetuk "Lupa Password" di layar login,
//       memasukkan email akunnya (+ keterangan opsional yang membantu admin
//       memastikan ini memang akunnya) → permintaan tercatat.
//   (2) Permintaan muncul di kotak masuk Laporan & Saran admin (digabung
//       ke GET /api/admin/tickets, kind 'password_reset') → admin ACC
//       atau TOLAK lewat POST /api/admin/password-resets/:id/decide.
//   (3) Kalau ACC, pemain mengecek kembali di halaman login dengan email
//       yang sama → muncul tombol sekali pakai "Masuk & Buat Password
//       Baru" → POST /api/auth/reset-login memberi sesi login + menandai
//       akun wajib ganti password → pemain mendarat di halaman
//       #/reset-password dan mengatur passwordnya sendiri.
// Keamanan:
//   - Token dibuat server-side (32 byte acak, disimpan sebagai hash
//     SHA-256); nilai mentahnya TIDAK PERNAH keluar dari server. Yang
//     membuat permintaan ini sekali pakai adalah barisnya: saat
//     reset-login berhasil, status langsung 'used' (UPDATE bersyarat —
//     dua klik paralel hanya satu yang menang) dan tidak bisa dipakai lagi.
//   - Kedaluwarsa: permintaan pending berlaku 7 hari; setelah disetujui,
//     jendela masuk sekali pakai 3 hari (expires_at ditulis ulang saat ACC).
//   - Hanya berlaku untuk akun yang meminta (baris terikat user_id).
//   - Hanya admin yang bisa ACC/TOLAK; setiap keputusan tercatat di
//     admin_actions (logAction) + notifikasi ke pemain.
//   - TIDAK membocorkan apakah sebuah email terdaftar: forgot-password
//     selalu membalas pesan generik yang sama, baik email ada maupun tidak,
//     dan tidak membuat baris untuk email yang tidak terdaftar.
//   - Sisa risiko (dicatat untuk pemilik): persetujuan admin adalah
//     satu-satunya gerbang identitas — siapa pun yang tahu sebuah email
//     bisa memicu permintaan. Admin HARUS memastikan peminta adalah
//     pemilik akun (mis. cocokkan nama warga + keterangan di permintaan,
//     atau konfirmasi lewat WhatsApp/Discord) sebelum mengetuk ACC.
import crypto from 'node:crypto';
import { one, sql, run, tx } from './db.js';
import { authRequired, isValidEmail, publicId, signToken, cookieOptions, COOKIE_NAME, loadCitizen } from './util.js';
import { adminOnly } from './api-admin.js';
import { dbRateLimit } from './rate-limit.js';
import { hashPassword } from './bcrypt-pool.js';
import { notify } from './api-civic.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Permintaan pending berlaku 7 hari; setelah disetujui, jendela masuk
// sekali pakai 3 hari. Angka ini tampil di pesan admin + pemain.
export const PASSWORD_RESET_PENDING_TTL_MS = 7 * DAY_MS;
export const PASSWORD_RESET_APPROVED_TTL_MS = 3 * DAY_MS;
const MAX_PASSWORD_BYTES = 72; // bcrypt memotong password di atas 72 byte
const MAX_NOTE_CHARS = 200;

// Pesan generik — SELALU sama, baik email terdaftar maupun tidak, baik
// sudah ada permintaan aktif maupun belum. Jangan ubah pesannya menjadi
// spesifik per kasus: itu akan membocorkan keberadaan akun.
const GENERIC_MESSAGE = 'Bila email ini terdaftar, permintaanmu sudah dicatat. Admin akan meninjaunya — cek kembali di halaman ini dengan email yang sama.';

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Status efektif: baris pending/approved yang sudah lewat expires_at
// dianggap 'expired' (bukan status tersimpan — tidak ada sweep yang
// menulisnya; semua query memakai filter expires_at > sekarang).
export function effectiveResetStatus(row, now = Date.now()) {
  if ((row.status === 'pending' || row.status === 'approved') && Number(row.expires_at) <= now) return 'expired';
  return row.status;
}

// Baris AKTIF terbaru untuk satu akun: pending/approved yang belum
// kedaluwarsa (dipakai dedupe permintaan + status check + reset-login).
async function activeRowFor(userId, now = Date.now()) {
  const rows = await sql(
    `SELECT * FROM password_resets WHERE user_id = ? AND status IN ('pending', 'approved')
     AND expires_at > ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    [userId, now]);
  return rows[0] || null;
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

export function registerPasswordReset(app) {
  const r = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---------- Pemain: minta reset password ----------
  // POST /api/auth/forgot-password { email, note? } — publik, tanpa login.
  // Dibatasi 10/IP/jam (DB-backed) + limit auth umum 30/menit/IP (app.js).
  const forgotRateLimit = dbRateLimit({
    keyFn: (req) => 'forgot:' + (req.ip || 'unknown'),
    max: 10,
    windowMs: 60 * 60 * 1000,
    message: 'Terlalu banyak permintaan reset password dari alamat ini. Coba lagi nanti.',
  });
  app.post('/api/auth/forgot-password', forgotRateLimit, r(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const note = String(req.body?.note || '').trim().slice(0, MAX_NOTE_CHARS);
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Format email tidak valid.' });
    const user = await one('SELECT id, username FROM users WHERE email = ?', [email]);
    // Email tidak terdaftar: balas generik TANPA membuat baris — tidak ada
    // yang bisa dibedakan dari luar (status, waktu, maupun isi pesan sama).
    if (!user) return res.json({ ok: true, message: GENERIC_MESSAGE });
    // Satu permintaan AKTIF per akun: bila sudah ada pending/approved yang
    // belum kedaluwarsa, jangan duplikat (admin tidak dibanjiri).
    const existing = await activeRowFor(user.id);
    if (!existing) {
      const now = Date.now();
      const token = crypto.randomBytes(32).toString('hex');
      await run(
        'INSERT INTO password_resets (user_id, token_hash, note, status, created_at, expires_at) VALUES (?,?,?,?,?,?) RETURNING id',
        [user.id, tokenHash(token), note, 'pending', now, now + PASSWORD_RESET_PENDING_TTL_MS]);
      await notifyAdmins('Permintaan reset password baru',
        `${user.username} (${publicId(user.id)}) meminta reset password.${note ? ` Keterangan: "${note}"` : ''} Tinjau di Panel Admin → Laporan & Saran.`);
    }
    res.json({ ok: true, message: GENERIC_MESSAGE });
  }));

  // ---------- Pemain: cek status persetujuan ----------
  // GET /api/auth/forgot-password/status?email= — publik, tanpa login.
  // Hanya menjawab approved ya/tidak. Email tidak terdaftar, belum ada
  // permintaan, masih menunggu, ditolak, dipakai, atau kedaluwarsa semuanya
  // menjawab { approved: false } — tidak ada yang bisa dibedakan.
  app.get('/api/auth/forgot-password/status', r(async (req, res) => {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return res.json({ approved: false });
    const user = await one('SELECT id FROM users WHERE email = ?', [email]);
    if (!user) return res.json({ approved: false });
    const row = await activeRowFor(user.id);
    res.json({ approved: !!(row && row.status === 'approved') });
  }));

  // ---------- Pemain: masuk sekali pakai setelah disetujui ----------
  // POST /api/auth/reset-login { email } — publik, tanpa login.
  // Konsumsi token SECARA ATOMIK (UPDATE bersyarat: hanya baris yang masih
  // 'approved' + belum kedaluwarsa yang berubah; dua klik paralel hanya
  // satu yang menang, yang kalah mendapat 400). Beri sesi login biasa +
  // tandai akun wajib ganti password (pw_reset_required = 1) — client
  // memaksa akun ini ke halaman #/reset-password.
  app.post('/api/auth/reset-login', r(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Format email tidak valid.' });
    const user = await one('SELECT * FROM users WHERE email = ?', [email]);
    const now = Date.now();
    const row = user ? await activeRowFor(user.id, now) : null;
    if (!user || !row || row.status !== 'approved') {
      return res.status(400).json({ error: 'Belum ada persetujuan reset password untuk email ini, atau persetujuan sudah kedaluwarsa/terpakai. Minta lagi lewat Lupa Password bila perlu.' });
    }
    const consumed = await tx(async (t) => {
      const upd = await t.run(
        "UPDATE password_resets SET status = 'used', used_at = ? WHERE id = ? AND status = 'approved' AND expires_at > ?",
        [now, row.id, now]);
      if (!upd.changes) return false;
      await t.run('UPDATE users SET pw_reset_required = 1 WHERE id = ?', [user.id]);
      return true;
    });
    if (!consumed) {
      return res.status(400).json({ error: 'Persetujuan ini sudah dipakai atau kedaluwarsa. Minta lagi lewat Lupa Password bila perlu.' });
    }
    res.cookie(COOKIE_NAME, signToken(user.id, user.token_version || 0), cookieOptions());
    const citizen = await loadCitizen(user.id);
    res.json({
      ok: true,
      mustChangePassword: true,
      user: { id: user.id, publicId: publicId(user.id), email: user.email, username: user.username },
      citizen,
    });
  }));

  // ---------- Pemain: atur password baru ----------
  // POST /api/auth/reset-password { password, password_confirm? } — harus
  // login (sesi dari reset-login). Hanya berlaku bila akun ditandai
  // pw_reset_required = 1; setelah berhasil, flag dibersihkan + semua sesi
  // lain dicabut (token_version naik) sementara sesi saat ini diterbitkan
  // ulang dengan tv baru supaya pemain langsung bisa main.
  app.post('/api/auth/reset-password', authRequired, r(async (req, res) => {
    const password = req.body?.password;
    const confirm = req.body?.password_confirm;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter.' });
    if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return res.status(400).json({ error: 'Password maksimal 72 karakter.' });
    if (confirm !== undefined && confirm !== password) return res.status(400).json({ error: 'Konfirmasi password tidak sama.' });
    const user = await one('SELECT id, token_version, pw_reset_required FROM users WHERE id = ?', [req.userId]);
    if (!user) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
    if (!user.pw_reset_required) {
      return res.status(400).json({ error: 'Akun ini tidak sedang dalam proses reset password.' });
    }
    const hash = await hashPassword(password);
    const newTv = (user.token_version || 0) + 1;
    await run('UPDATE users SET pass_hash = ?, pw_reset_required = 0, token_version = ? WHERE id = ?',
      [hash, newTv, user.id]);
    res.cookie(COOKIE_NAME, signToken(user.id, newTv), cookieOptions());
    res.json({ ok: true });
  }));

  // ---------- Admin: daftar semua permintaan reset ----------
  // GET /api/admin/password-resets — terbaru dulu, lengkap dengan info pemain.
  app.get('/api/admin/password-resets', authRequired, adminOnly, r(async (req, res) => {
    const rows = await sql(
      `SELECT pr.*, u.username, u.email
       FROM password_resets pr JOIN users u ON u.id = pr.user_id
       ORDER BY pr.created_at DESC, pr.id DESC LIMIT 200`);
    const now = Date.now();
    res.json({
      requests: rows.map((row) => ({
        ...row,
        publicId: publicId(row.user_id),
        effectiveStatus: effectiveResetStatus(row, now),
      })),
    });
  }));

  // ---------- Admin: putuskan permintaan (ACC / TOLAK) ----------
  // POST /api/admin/password-resets/:id/decide { decision: 'accept' | 'reject' }
  // accept → status 'approved', jendela masuk sekali pakai 3 hari sejak
  // keputusan; reject → status 'rejected', pemain boleh minta lagi.
  // Hanya permintaan 'pending' yang belum kedaluwarsa yang bisa diputus —
  // keputusan ganda / permintaan basi ditolak 400. Setiap keputusan
  // dicatat di admin_actions + notifikasi ke pemain.
  app.post('/api/admin/password-resets/:id/decide', authRequired, adminOnly, r(async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID permintaan tidak valid.' });
    const decision = req.body?.decision;
    if (decision !== 'accept' && decision !== 'reject') {
      return res.status(400).json({ error: 'Keputusan harus "accept" atau "reject".' });
    }
    const row = await one('SELECT * FROM password_resets WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Permintaan reset password tidak ditemukan.' });
    const now = Date.now();
    if (row.status !== 'pending') {
      return res.status(400).json({ error: 'Permintaan ini sudah diputuskan.' });
    }
    if (Number(row.expires_at) <= now) {
      return res.status(400).json({ error: 'Permintaan ini sudah kedaluwarsa. Pemain perlu mengirim permintaan baru.' });
    }
    const status = decision === 'accept' ? 'approved' : 'rejected';
    const expiresAt = decision === 'accept' ? now + PASSWORD_RESET_APPROVED_TTL_MS : row.expires_at;
    const target = await one('SELECT username FROM users WHERE id = ?', [row.user_id]);
    await tx(async (t) => {
      await t.run(
        'UPDATE password_resets SET status = ?, decided_at = ?, decided_by = ?, expires_at = ? WHERE id = ?',
        [status, now, req.userId, expiresAt, id]);
      await t.run(
        'INSERT INTO admin_actions (admin_id, target_id, action, detail, created_at) VALUES (?,?,?,?,?) RETURNING id',
        [req.userId, row.user_id, decision === 'accept' ? 'password_reset_accept' : 'password_reset_reject',
          `Reset password #${id} (${target?.username || row.user_id}) ${decision === 'accept' ? 'DISETUJUI — jendela masuk sekali pakai 3 hari' : 'DITOLAK'}`, now]);
    });
    if (decision === 'accept') {
      await notifyPlayer(row.user_id, 'Reset passwordmu DISETUJUI',
        'Admin menyetujui permintaan reset passwordmu. Masukkan emailmu di layar login, lalu ketuk "Masuk & Buat Password Baru". Tombol itu sekali pakai dan berlaku 3 hari.');
    } else {
      await notifyPlayer(row.user_id, 'Reset passwordmu DITOLAK',
        'Admin menolak permintaan reset passwordmu. Bila ini memang akunmu, kirim permintaan lagi dengan keterangan yang lebih jelas, atau hubungi admin.');
    }
    res.json({ ok: true, status });
  }));
}
