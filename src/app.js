// Parlementer — pembuatan aplikasi Express.
// Dipisah dari listen() agar app yang sama bisa jalan dua cara:
//   - mode server biasa:  node server.js   (Render / lokal)
//   - mode serverless:    api/index.js     (Vercel Serverless Function)
// Route, middleware, dan aturan main TIDAK berubah di antara keduanya.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { initDb, isPg } from './db.js';
import { registerCore } from './api-core.js';
import { registerCivic } from './api-civic.js';
import { maybeTick, ensureElections } from './tick.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Di belakang proxy (Render / Vercel) agar req.ip = IP asli pengguna.
  // Penting untuk rate limit auth: tanpa ini semua pengguna terlihat satu IP
  // (IP proxy) dan akan saling memblokir.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

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
  app.use('/api/', (req, res, next) => { maybeTick().catch(() => {}); next(); });

  registerCore(app);
  registerCivic(app);

  // Frontend statis + SPA fallback.
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint tidak ditemukan.' });
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  // Error handler.
  app.use((err, req, res, _next) => {
    console.error('[error]', err);
    res.status(err.status || 500).json({ error: err.message || 'Terjadi kesalahan server.' });
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
