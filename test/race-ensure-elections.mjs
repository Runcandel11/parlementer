// Parlementer — probe race ensureElections (Tahap 8).
// Hapus pemilu aktif satu negara, lalu panggil ensureElections 12×
// paralel: harus tersisa MAKSIMAL 1 pemilu per tipe (tanpa duplikat),
// dan pemilu parlemen harus ada (selalu dijadwalkan). Pemilu presiden
// boleh tidak ada bila sistem negara tidak mengadakan pemilu otomatis
// (imperial/diktator + presiden sudah menjabat).
// Dipakai test/e2e.js (SQLite) + test/pg-verify.mjs (Postgres).
// Env: DATABASE_PATH (SQLite) atau DATABASE_URL (Postgres) — dibaca
// src/db.js saat import, seperti server biasa.
// Keluar 0 bila lolos, 1 bila ada duplikat / parlemen hilang.
import { ensureElections } from '../src/tick.js';
import { one, run, sql } from '../src/db.js';

const country = await one('SELECT id FROM country ORDER BY id ASC LIMIT 1');
if (!country) {
  console.log(JSON.stringify({ skipped: 'no country' }));
  process.exit(0);
}
await run("DELETE FROM elections WHERE country_id = ? AND status IN ('scheduled','open')", [country.id]);
await Promise.all(Array.from({ length: 12 }, () => ensureElections()));
// Panggilan berurutan sekali lagi (pastikan yang seharusnya ada memang ada).
await ensureElections();
const rows = await sql(
  "SELECT type, COUNT(*) AS n FROM elections WHERE country_id = ? AND status IN ('scheduled','open') GROUP BY type",
  [country.id],
);
console.log(JSON.stringify({ country: country.id, counts: rows }));
const dup = rows.some((r) => Number(r.n) > 1);
const hasParliament = rows.some((r) => r.type === 'parliament' && Number(r.n) === 1);
if (dup || !hasParliament) {
  console.error(JSON.stringify({ fail: 'duplikat pemilu aktif atau pemilu parlemen hilang', dup, hasParliament }));
  process.exit(1);
}
process.exit(0);
