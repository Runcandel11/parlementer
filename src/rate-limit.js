// Rate limit berbasis database (Tahap 2, audit §4.3).
// Disimpan di tabel rate_limits agar konsisten antar instance serverless
// (rate limit in-memory di app.js hanya berlaku per instance). Pola:
// INSERT baris jendela bila belum ada (di luar tx, abaikan bentrok), lalu
// tx() + SELECT ... FOR UPDATE + update kondisional — dua request paralel
// pada kunci yang sama ter-serialisasi, jadi hitungan tidak pernah lolos.
import { run, tx, forUpdate } from './db.js';

// Cek + tambah hitungan untuk `key` dalam jendela `windowMs`.
// Mengembalikan { allowed, count }. Jendela dihitung dari epoch (bukan
// sliding window) — cukup untuk membatasi pendaftaran massal & grant admin.
export async function checkRateLimit(key, max, windowMs) {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  try {
    await run('INSERT INTO rate_limits (key, count, window_start) VALUES (?,?,?) RETURNING key', [key, 0, windowStart]);
  } catch { /* baris sudah ada (balapan insert) — lanjut ke tx */ }
  return tx(async (t) => {
    const row = await t.one(forUpdate('SELECT * FROM rate_limits WHERE key = ?'), [key]);
    if (!row) return { allowed: true, count: 0 };
    if (Number(row.window_start) !== windowStart) {
      await t.run('UPDATE rate_limits SET count = 1, window_start = ? WHERE key = ?', [windowStart, key]);
      return { allowed: true, count: 1 };
    }
    if (Number(row.count) >= max) return { allowed: false, count: Number(row.count) };
    await t.run('UPDATE rate_limits SET count = count + 1 WHERE key = ?', [key]);
    return { allowed: true, count: Number(row.count) + 1 };
  });
}

// Middleware Express: keyFn(req) mengembalikan kunci (atau null = lewati).
// Bila DB error, fail-open (log saja) agar gangguan DB tidak memblokir
// semua pemain; batas tetap ditegakkan saat DB sehat.
export function dbRateLimit({ keyFn, max, windowMs, message }) {
  return async (req, res, next) => {
    let key = null;
    try { key = keyFn(req); } catch { /* abaikan */ }
    if (!key) return next();
    try {
      const r = await checkRateLimit(key, max, windowMs);
      if (!r.allowed) return res.status(429).json({ error: message || 'Terlalu banyak percobaan. Coba lagi nanti.' });
    } catch (e) {
      console.error('[rate-limit] gagal:', e.message);
    }
    next();
  };
}
