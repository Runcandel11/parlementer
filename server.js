// Parlementer — server standalone (Express + SQLite/Postgres).
// Jalankan: npm start  (PORT default 3000; DATABASE_URL bila memakai Postgres)
// Aplikasi Express-nya dibuat di src/app.js agar bisa dipakai ulang oleh
// Vercel Serverless Function (api/index.js) tanpa duplikasi.
import { app, ensureReady } from './src/app.js';
import { isPg } from './src/db.js';
import { maybeTick } from './src/tick.js';
import { maybeAutoWork } from './src/auto-work.js';

const PORT = Number(process.env.PORT || 3000);

await ensureReady();

// Tick berkala hanya di mode server biasa. Di serverless (Vercel) interval
// tidak berjalan antar-invocation — tick tetap jalan lewat maybeTick() di
// setiap request API (lihat src/app.js). Kerja otomatis (v4.5.0) ikut
// dicek di interval yang sama + di middleware /api/.
setInterval(() => { maybeTick().catch(() => {}); maybeAutoWork().catch(() => {}); }, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`[parlementer] berjalan di http://localhost:${PORT} — database: ${isPg ? 'Postgres (DATABASE_URL)' : 'SQLite lokal'}`);
});
