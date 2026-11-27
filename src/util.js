// Utilitas bersama: JWT (cookie httpOnly + fallback header), validasi, format.
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { one, run, convoyBuildings } from './db.js';
import { energyCapFor, ENERGY_REGEN_PER_MIN, ENERGY_REGEN_MS } from './game.js';

export const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
// Fail-closed: di production server MENOLAK start bila JWT_SECRET tidak
// disetel atau masih secret dev yang diketahui publik (audit §4.2).
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev-secret-change-me')) {
  throw new Error('JWT_SECRET wajib disetel di production — server menolak start. Isi JWT_SECRET di Vercel (nilai acak 32 byte, mis. openssl rand -hex 32).');
}
if (!process.env.JWT_SECRET) {
  console.warn('[auth] PERINGATAN: JWT_SECRET tidak disetel — memakai secret dev. Setel JWT_SECRET di hosting!');
}

// Kode bootstrap admin darurat (env var ADMIN_BOOTSTRAP_CODE). Satu-satunya
// jalan membuat akun admin baru lewat registrasi sejak pemberian admin
// berbasis email dicabut (27 Nov 2026 — Khalid sudah menjadi admin).
// Bila env var kosong, registrasi TIDAK BISA membuat admin sama sekali.
// Peringatan saat kode tidak diset hanya ditulis di luar production
// (Tahap 5): di production, "tidak diset" adalah kondisi aman yang
// diinginkan (Khalid sudah admin), jadi memperingatkannya di setiap cold
// start serverless hanya membanjiri log. Statusnya tetap bisa dilihat
// admin lewat GET /api/admin/status (bootstrapActive).
export const ADMIN_BOOTSTRAP_CODE = process.env.ADMIN_BOOTSTRAP_CODE || '';
const bootstrapConfigured = Boolean(ADMIN_BOOTSTRAP_CODE);
if (bootstrapConfigured) {
  console.log('[security] ADMIN_BOOTSTRAP_CODE aktif — registrasi dengan kode bootstrap yang benar akan menjadi admin.');
} else if (process.env.NODE_ENV !== 'production') {
  console.warn('[security] PERINGATAN: ADMIN_BOOTSTRAP_CODE tidak diset — tidak ada jalan darurat membuat admin lewat registrasi.');
}
export function bootstrapActive() {
  return bootstrapConfigured;
}
export function bootstrapCodeMatches(code) {
  if (!ADMIN_BOOTSTRAP_CODE) {
    // Sinyal nyata (bukan noise): ada yang mencoba memakai jalan darurat
    // padahal tidak dikonfigurasi. Tetap ditolak.
    if (typeof code === 'string' && code) {
      console.warn('[security] Registrasi memakai kode bootstrap padahal ADMIN_BOOTSTRAP_CODE tidak diset — ditolak.');
    }
    return false;
  }
  if (typeof code !== 'string' || !code) return false;
  const a = Buffer.from(code);
  const b = Buffer.from(ADMIN_BOOTSTRAP_CODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const COOKIE_NAME = 'parlementer_token';

// Token berlaku 7 hari (dulu 30). Payload membawa tv (token_version user):
// naikkan token_version di DB untuk mencabut semua sesi user itu (logout,
// ban). Token lama tanpa tv dianggap tv=0.
export function signToken(userId, tokenVersion = 0) {
  return jwt.sign({ uid: userId, tv: tokenVersion }, JWT_SECRET, { expiresIn: '7d' });
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

export function readToken(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(new RegExp('(?:^|; )' + COOKIE_NAME + '=([^;]+)'));
  if (m) return decodeURIComponent(m[1]);
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

export async function loadCitizen(userId) {
  const c = await one(
    `SELECT c.*, u.username, u.email, u.premium_until, u.is_admin, u.avatar,
       u.referral_code, u.is_banned, u.banned_reason, u.banned_at
     FROM citizens c JOIN users u ON u.id = c.user_id WHERE c.user_id = ?`,
    [userId],
  );
  if (!c) return null;
  // Kedatangan malas (perjalanan 27 Nov 2026): bila waktu tempuh sudah
  // habis, warga resmi tiba di wilayah tujuan — diselesaikan di sini
  // supaya SETIAP pembacaan warga berikutnya sudah melihat lokasi baru.
  // Gagal menyelesaikan tidak boleh menggagalkan pembacaan data.
  let row = c;
  try { row = await settleTravel(row); }
  catch (e) { console.error('[travel] gagal menyelesaikan kedatangan:', e.message); }
  // Regen energi malas (Tahap 4): tiap kali data warga dibaca, pulihkan
  // +2/menit dari waktu yang berlalu — pemain offline pun pulih saat kembali.
  // Gagal regen tidak boleh menggagalkan pembacaan data.
  try { return await applyEnergyRegen(row); }
  catch (e) { console.error('[regen] gagal:', e.message); return row; }
}

// Selesaikan perjalanan yang waktunya sudah habis: pindahkan region_id ke
// wilayah tujuan + bersihkan status transit. UPDATE bersyarat (cocokkan
// tujuan + jam tiba lama) mencegah dua request paralel menyelesaikan
// perjalanan yang sama dua kali — pola yang sama seperti regen energi.
// Mengembalikan baris warga (yang sudah tiba) atau baris asli bila belum
// waktunya / tidak sedang bepergian.
export async function settleTravel(c) {
  if (!c.travel_to_region_id || !c.travel_arrives_at) return c;
  if (Date.now() < c.travel_arrives_at) return c;
  const upd = await run(
    'UPDATE citizens SET region_id = ?, travel_to_region_id = NULL, travel_arrives_at = 0 WHERE id = ? AND travel_to_region_id = ? AND travel_arrives_at = ?',
    [c.travel_to_region_id, c.id, c.travel_to_region_id, c.travel_arrives_at]);
  if (!upd.changes) {
    // Kalah race: baca ulang baris yang sudah diselesaikan request lain.
    const fresh = await one('SELECT * FROM citizens WHERE id = ?', [c.id]);
    return fresh ? { ...c, ...fresh } : c;
  }
  return { ...c, region_id: c.travel_to_region_id, travel_to_region_id: null, travel_arrives_at: 0 };
}

// Regen energi malas (Tahap 4): +2 tiap 1 menit sejak energy_updated_at,
// berhenti di batas maksimum (energyCapFor). Sisa menit yang belum genap
// dipertahankan (jam baru = jam lama + menit penuh). UPDATE bersyarat pada
// jam lama mencegah dua request paralel menghitung regen yang sama dua kali
// (pola Tahap 2: kunci + cek changes).
export async function applyEnergyRegen(c) {
  const now = Date.now();
  const last = c.energy_updated_at || 0;
  if (!last) {
    // Baris lama (sebelum kolom ini ada): jangan beri windfall energi —
    // cukup tandai jam terakhir = sekarang.
    await run('UPDATE citizens SET energy_updated_at = ? WHERE id = ?', [now, c.id]);
    return { ...c, energy_updated_at: now };
  }
  const elapsed = now - last;
  if (elapsed < ENERGY_REGEN_MS) return c;
  const minutes = Math.floor(elapsed / ENERGY_REGEN_MS);
  const gain = minutes * ENERGY_REGEN_PER_MIN;
  if (gain <= 0) return c;
  // Batas absolut (level + Premium + RS Lapangan): bila energi sudah di
  // atasnya, tidak ada regen yang mungkin — lewati query konvoi.
  const maxCap = 100 + 5 * (Math.max(1, c.level) - 1) + 30;
  if (c.energy >= maxCap) {
    await run('UPDATE citizens SET energy_updated_at = ? WHERE id = ?', [now, c.id]);
    return { ...c, energy_updated_at: now };
  }
  const buildings = await convoyBuildings(c.id);
  const cap = energyCapFor(c.level, (c.premium_until || 0) > now, buildings.has('health'));
  if (c.energy >= cap) {
    await run('UPDATE citizens SET energy_updated_at = ? WHERE id = ?', [now, c.id]);
    return { ...c, energy_updated_at: now };
  }
  const newEnergy = Math.min(cap, c.energy + gain);
  const newTs = last + minutes * ENERGY_REGEN_MS;
  const upd = await run(
    'UPDATE citizens SET energy = ?, energy_updated_at = ? WHERE id = ? AND energy_updated_at = ?',
    [newEnergy, newTs, c.id, last]);
  if (!upd.changes) {
    // Kalah race: baca ulang baris yang sudah di-regen request lain.
    const fresh = await one('SELECT * FROM citizens WHERE id = ?', [c.id]);
    return fresh ? { ...c, ...fresh } : c;
  }
  return { ...c, energy: newEnergy, energy_updated_at: newTs };
}

// Ambil userId dari token sesi tanpa melempar error — untuk middleware yang
// hanya perlu tahu "siapa yang login" (mis. penjaga akun banned). Kembalikan
// null bila tidak ada token atau token tidak valid.
export function getUserIdFromReq(req) {
  const token = readToken(req);
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload.uid;
  } catch {
    return null;
  }
}

// ID publik pemain: PL- + nomor urut 6 digit dari id database (mis. PL-000001).
// Stabil, unik, dan dipakai di tampilan publik — bukan email.
export function publicId(userId) {
  return 'PL-' + String(userId).padStart(6, '0');
}

export async function authRequired(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'Harus login dulu.' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Sesi habis, silakan login lagi.' });
  }
  req.userId = payload.uid;
  // Cabut sesi: token_version di DB harus cocok dengan payload (tv).
  // Token lama tanpa tv dianggap tv=0 (tetap valid sampai kedaluwarsa).
  try {
    const u = await one('SELECT token_version FROM users WHERE id = ?', [payload.uid]);
    if (u && (u.token_version || 0) !== (payload.tv || 0)) {
      return res.status(401).json({ error: 'Sesi dicabut, silakan login lagi.' });
    }
  } catch { /* DB belum siap — biarkan route yang menangani. */ }
  next();
}

export async function citizenRequired(req, res, next) {
  const c = await loadCitizen(req.userId);
  if (!c) return res.status(404).json({ error: 'Warga tidak ditemukan.' });
  req.citizen = c;
  next();
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email || '');
}

export function isValidUsername(name) {
  return /^[A-Za-z0-9_]{3,24}$/.test(name || '');
}

export function todayStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// Kurs tampilan Rupiah — SATU tempat: 1 USD = Rp18.300. Semua teks yang
// dilihat pemain memakai fmtRp; nilai di database & API tetap USD.
export const RP_PER_USD = 18300;
export function fmtRp(usd) {
  return 'Rp' + Math.round(Number(usd || 0) * RP_PER_USD).toLocaleString('id-ID');
}

export function fmtGold(n) {
  return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function fmtIDR(n) {
  return 'Rp' + Number(n || 0).toLocaleString('id-ID');
}

export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

export function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Validasi data URL gambar (JPEG/PNG/WebP) — dipakai foto profil
// (api-core.js) dan gambar artikel: sampul + gambar di isi (api-civic.js).
// Mengembalikan { bytes, dataUrl } atau null bila bukan gambar valid atau
// melebihi batas byte. Periksa magic bytes agar benar-benar file gambar:
// SVG sengaja DITOLAK (tidak ada di daftar tipe) karena SVG bisa membawa
// <script> — tidak boleh masuk lewat kolom gambar mana pun.
export function parseImageDataUrl(dataUrl, maxBytes) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch { return null; }
  if (buf.length === 0 || buf.length > maxBytes) return null;
  const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
  const isWebp = buf.length > 11 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  if (!isJpeg && !isPng && !isWebp) return null;
  return { bytes: buf.length, dataUrl };
}
