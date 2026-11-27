// Parlementer — server standalone (Express + SQLite/Postgres).
// Jalankan: npm start  (PORT default 3000; DATABASE_URL bila memakai Postgres)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { initDb, isPg } from './src/db.js';
import { registerCore } from './src/api-core.js';
import { registerCivic } from './src/api-civic.js';
import { maybeTick, ensureElections } from './src/tick.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Rate limit sederhana untuk auth (10 req/menit per IP).
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
app.use('/api/', (req, res, next) => { maybeTick().catch(() => {}); next(); });

registerCore(app);
registerCivic(app);

// Frontend statis + SPA fallback.
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint tidak ditemukan.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler.
app.use((err, req, res, _next) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({ error: err.message || 'Terjadi kesalahan server.' });
});

await initDb();
await ensureElections();
setInterval(() => { maybeTick().catch(() => {}); }, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`[parlementer] berjalan di http://localhost:${PORT} — database: ${isPg ? 'Postgres (DATABASE_URL)' : 'SQLite lokal'}`);
});
