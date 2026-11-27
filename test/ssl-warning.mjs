// Parlementer — verifikasi perbaikan warning deprecation SSL (Tahap 3).
// pg-connection-string 2.14+ memicu process.emitWarning saat URL mengandung
// sslmode=... — di Vercel, stderr itu tercatat sebagai Error di SETIAP cold
// start. db.js membuang sslmode dari URL dan menggantinya dengan ssl eksplisit
// yang perilakunya identik (rejectUnauthorized: true = verifikasi sertifikat,
// seperti yang berlaku hari ini). Tes ini tidak butuh DB yang bisa dijangkau:
// pg mengurai connection string saat connect() pertama (sebelum TCP gagal
// ke 127.0.0.1:1) — peringatan sudah terpancar di titik itu.
// Jalankan: npm run test:ssl   (atau: node test/ssl-warning.mjs)
import pg from 'pg';

process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:1/db?sslmode=require';
const { buildPgPoolConfig } = await import('../src/db.js');

const warnings = [];
process.on('warning', (w) => warnings.push(String(w.message || w)));
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// 1) Kontrol: pg mentah + sslmode=require memicu peringatan deprecation.
// connect() ke 127.0.0.1:1 pasti gagal (ECONNREFUSED) — itu tidak masalah:
// parsing URL (dan peringatannya) terjadi sebelum percobaan TCP.
const p1 = new pg.Pool({ connectionString: 'postgres://u:p@127.0.0.1:1/db?sslmode=require', max: 1 });
await p1.connect().catch(() => {});
check('kontrol: pg mentah + sslmode=require memicu peringatan deprecation',
  warnings.some((w) => w.includes('sslmode')), warnings[0] || '');
await p1.end();

// 2) Jalur baru: config hasil sanitize tidak memicu peringatan.
warnings.length = 0;
const cfg = buildPgPoolConfig('postgres://u:p@127.0.0.1:1/db?sslmode=require');
const p2 = new pg.Pool({ ...cfg, max: 1 });
await p2.connect().catch(() => {});
check('config hasil sanitize: tanpa peringatan deprecation', warnings.length === 0, warnings[0] || '');
check('config hasil sanitize: ssl tetap aktif + verifikasi sertifikat', cfg.ssl?.rejectUnauthorized === true);
check('config hasil sanitize: sslmode terbuang dari URL', !cfg.connectionString.includes('sslmode'));
await p2.end();

// 3) URL tanpa sslmode tidak diubah (Postgres lokal untuk tes).
const local = buildPgPoolConfig('postgres://parlementer_test:parlementer_test@127.0.0.1:5432/parlementer_test');
check('URL tanpa sslmode tidak diubah',
  local.connectionString === 'postgres://parlementer_test:parlementer_test@127.0.0.1:5432/parlementer_test' && !('ssl' in local));

// 4) sslmode di tengah query string: param lain dipertahankan.
const mid = buildPgPoolConfig('postgres://u:p@h/db?foo=1&sslmode=require&bar=2');
check('param lain di sekitar sslmode dipertahankan',
  mid.connectionString === 'postgres://u:p@h/db?foo=1&bar=2' && mid.ssl?.rejectUnauthorized === true, mid.connectionString);

console.log(`\n[ssl-warning] SELESAI: ${passed} lolos, ${failed} gagal`);
process.exit(failed ? 1 : 0);
