// Parlementer — pembuatan aplikasi Express.
// Dipisah dari listen() agar app yang sama bisa jalan dua cara:
//   - mode server biasa:  node server.js   (Render / lokal)
//   - mode serverless:    api/index.js     (Vercel Serverless Function)
// Route, middleware, dan aturan main TIDAK berubah di antara keduanya.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { initDb, isPg, one } from './db.js';
import { registerCore } from './api-core.js';
import { registerCivic } from './api-civic.js';
import { registerMilitary } from './api-military.js';
import { registerAdmin } from './api-admin.js';
import { registerAppeals } from './api-appeals.js';
import { getUserIdFromReq } from './util.js';
import { maybeTick, ensureElections } from './tick.js';
import { maybeAutoWork } from './auto-work.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Di belakang proxy (Render / Vercel) agar req.ip = IP asli pengguna.
  // Penting untuk rate limit auth: tanpa ini semua pengguna terlihat satu IP
  // (IP proxy) dan akan saling memblokir.
  app.set('trust proxy', 1);

  // Pengalihan permanen: siapa pun yang masih membuka lewat Vercel
  // (parlementer.vercel.app) otomatis dipindah ke domain baru
  // https://parlementer.my.id. Hanya aktif bila host berakhiran
  // .vercel.app — di VPS (domain/IP sendiri) tidak berpengaruh.
  // 308 menjaga method + body (aman untuk POST API).
  app.use((req, res, next) => {
    const host = String(req.headers.host || '');
    if (host.endsWith('.vercel.app')) {
      return res.redirect(308, 'https://parlementer.my.id' + req.originalUrl);
    }
    next();
  });

  // Batas body JSON 3 MB (dulu 1 MB): artikel dengan sampul (500 KB) +
  // thumbnail (50 KB) + 3 gambar di isi (3 × 300 KB) bisa mencapai ~2 MB
  // dalam base64 — 1 MB akan menolak artikel bergambar yang sah sebelum
  // sampai ke validasi handler. Batas per-bidang tetap ditegakkan di
  // handler masing-masing (avatar 500 KB, sampul 500 KB, gambar isi 300 KB).
  app.use(express.json({ limit: '3mb' }));

  // Security headers (manual, tanpa dependensi baru). CSP mengizinkan
  // Google Fonts (dipakai UI) dan skrip/gaya dari origin sendiri saja —
  // DITAMBAH AdinPlay (v4.4.0, iklan berhadiah): library tag dimuat dari
  // api.adinplay.com; video VAST datang dari berbagai CDN iklan (media-src
  // https:), unit VPAID jalan di iframe lintas-origin (frame-src https:),
  // dan piksel pelacak iklan memakai img https:. Ini pelonggaran yang
  // disengaja untuk iklan; skrip tetap hanya dari 'self' + AdinPlay.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' https://api.adinplay.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self' https://api.adinplay.com; frame-src https:; frame-ancestors 'none'",
    );
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  // Rate limit sederhana untuk auth (30 req/menit per IP).
  const authHits = new Map();
  app.use('/api/auth/', (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const hits = (authHits.get(ip) || []).filter((t) => now - t < 60_000);
    hits.push(now);
    authHits.set(ip, hits);
    if (hits.length > 30) return res.status(429).json({ error: 'Terlalu banyak percobaan. Tunggu sebentar.' });
    next();
  });

  // Tick harian dicek di setiap request API (jalan saat ada yang membuka game).
  // Ini satu-satunya mekanisme tick di serverless: tidak ada proses yang
  // jalan terus, jadi tidak ada setInterval di sana.
  // Kerja otomatis Premium (v4.5.0) ikut dicek di sini — throttle internal
  // (1× per 5 menit) membuatnya murah; di server biasa interval 10 menit
  // di server.js juga memanggilnya.
  app.use('/api/', (req, res, next) => { maybeTick().catch(() => {}); maybeAutoWork().catch(() => {}); next(); });

  // Penjaga akun banned: akun yang di-ban tidak bisa memakai API game apa
  // pun (klaim, latih, kerja, pasar, chat, dll.) walau sesinya masih hidup.
  // Yang dikecualikan: auth (login/logout/me), /api/me (layar banned butuh
  // status akun), sistem banding, dan /api/world (publik). Login akun banned
  // memang diizinkan (lihat api-core.js) agar pemain bisa membuka layar
  // banned dan mengajukan banding — tanpa sesi itu banding tidak mungkin.
  app.use('/api/', async (req, res, next) => {
    const p = req.path;
    if (p.startsWith('/auth/') || p === '/me' || p.startsWith('/appeals') ||
        p.startsWith('/admin/appeals') || p === '/world') return next();
    const uid = getUserIdFromReq(req);
    if (!uid) return next(); // tanpa sesi: authRequired di route yang menolak.
    try {
      const u = await one('SELECT is_banned FROM users WHERE id = ?', [uid]);
      if (u?.is_banned) {
        return res.status(403).json({ error: 'Akun ini dibanned. Ajukan banding untuk memulihkan akses.' });
      }
    } catch { /* DB belum siap — biarkan route yang menangani. */ }
    next();
  });

  registerCore(app);
  registerCivic(app);
  registerMilitary(app);
  registerAdmin(app);
  registerAppeals(app);

  // Frontend statis + SPA fallback.
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint tidak ditemukan.' });
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  // Error handler: pesan 500 generik ke klien (detail + stack hanya di log
  // server). Pesan 4xx yang disengaja (validasi, otorisasi) tetap apa adanya.
  app.use((err, req, res, _next) => {
    console.error('[error]', err);
    const status = err.status || 500;
    if (status >= 500) return res.status(status).json({ error: 'Terjadi kesalahan server.' });
    res.status(status).json({ error: err.message || 'Terjadi kesalahan.' });
  });

  return app;
}

export const app = createApp();

// Inisialisasi satu kali: schema + seed + jadwal pemilu.
// Di serverless, cold start pertama menjalankan ini; promise di-cache agar
// request yang datang bersamaan tidak menjalankan init dua kali (seed bisa
// terduplikasi). Bila gagal, cache di-reset agar percobaan berikutnya bisa
// mengulang — bukan gagal selamanya.
let readyPromise = null;
export function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      if (process.env.VERCEL && !isPg) {
        throw new Error('DATABASE_URL belum disetel — isi di Vercel Project Settings → Environment Variables (Postgres Neon). SQLite lokal tidak bisa dipakai di Vercel.');
      }
      await initDb();
      await ensureElections();
    })().catch((e) => { readyPromise = null; throw e; });
  }
  return readyPromise;
}

// Default export: handler serverless (req, res).
// Vercel mendeteksi file bernama `app` yang mengimpor express (di root atau
// di src/) sebagai entry aplikasi Express, dan runtime-nya menuntut default
// export berupa function/server — tanpanya deploy gagal dengan
// "Invalid export found in module .../src/app.js. The default export must
// be a function or server" (FUNCTION_INVOCATION_FAILED, exit 1).
// Karena itu handler didefinisikan DI SINI (bukan hanya di api/index.js):
// baik Vercel memuat api/index.js maupun src/app.js langsung sebagai entry,
// keduanya valid dan perilakunya sama (init DB dulu, lalu Express).
// server.js (mode server biasa) tidak memakai export ini.
export default async function handler(req, res) {
  await ensureReady();
  // Tunggu respons Express benar-benar selesai dikirim sebelum fungsi selesai.
  // Kalau hanya `return app(req, res)`, runtime bisa membekukan fungsi saat
  // promise resolve padahal handler async di dalam route belum selesai.
  await new Promise((resolve, reject) => {
    res.once('finish', resolve);
    res.once('close', resolve);
    try {
      app(req, res);
    } catch (err) {
      reject(err);
    }
  });
}
