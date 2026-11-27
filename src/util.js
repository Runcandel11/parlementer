// Utilitas bersama: JWT (cookie httpOnly + fallback header), validasi, format.
import jwt from 'jsonwebtoken';
import { one } from './db.js';

export const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (!process.env.JWT_SECRET) {
  console.warn('[auth] PERINGATAN: JWT_SECRET tidak disetel — memakai secret dev. Setel JWT_SECRET di hosting!');
}

export const COOKIE_NAME = 'parlementer_token';

export function signToken(userId) {
  return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '30d' });
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
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
    `SELECT c.*, u.username, u.email, u.premium_until, u.is_admin
     FROM citizens c JOIN users u ON u.id = c.user_id WHERE c.user_id = ?`,
    [userId],
  );
  return c || null;
}

export function authRequired(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'Harus login dulu.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
    next();
  } catch {
    return res.status(401).json({ error: 'Sesi habis, silakan login lagi.' });
  }
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
