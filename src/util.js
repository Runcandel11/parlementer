// Utilitas bersama: JWT (cookie httpOnly + fallback header), validasi, format.
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { one } from './db.js';

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
export const ADMIN_BOOTSTRAP_CODE = process.env.ADMIN_BOOTSTRAP_CODE || '';
if (ADMIN_BOOTSTRAP_CODE) {
  console.log('[security] ADMIN_BOOTSTRAP_CODE aktif — registrasi dengan kode bootstrap yang benar akan menjadi admin.');
} else {
  console.warn('[security] PERINGATAN: ADMIN_BOOTSTRAP_CODE tidak diset — tidak ada jalan darurat membuat admin lewat registrasi.');
}
export function bootstrapCodeMatches(code) {
  if (!ADMIN_BOOTSTRAP_CODE || typeof code !== 'string' || !code) return false;
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
  return c || null;
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

export function fmtUSD(n) {
  return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
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
