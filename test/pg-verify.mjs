// Parlementer — verifikasi migrasi Postgres sungguhan (Tahap 2).
// Menguji initDb di Postgres 16 lokal (bukan pg-mem/SQLite):
//   (1) initDb idempotent (2× berurutan + 3× paralel — advisory lock),
//   (2) perbaikan state lama: kolom timestamp INTEGER → BIGINT,
//       tipe komposit yatim dihapus, kolom token_version ditambah,
//   (3) CHECK saldo/qty terpasang + ditegakkan,
//   (4) JWT_SECRET fail-closed di production.
// Perlu Postgres 16 lokal + role/db tes (dibuat sekali, lihat README):
//   su postgres -c "psql -c \"CREATE ROLE parlementer_test LOGIN PASSWORD 'parlementer_test'\""
//   su postgres -c "psql -c \"CREATE DATABASE parlementer_test OWNER parlementer_test\""
// Jalankan: npm run test:pg-verify   (atau: node test/pg-verify.mjs)
// BUKAN bagian dari test:all — butuh server Postgres lokal.
import { spawn } from 'node:child_process';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL
  || 'postgres://parlementer_test:parlementer_test@127.0.0.1:5432/parlementer_test';
process.env.DATABASE_URL = DATABASE_URL;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });

async function dropAll() {
  const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  for (const t of tables.rows) await pool.query(`DROP TABLE IF EXISTS "${t.tablename}" CASCADE`);
  const types = await pool.query("SELECT typname FROM pg_type WHERE typtype = 'c' AND typnamespace = 'public'::regnamespace");
  for (const t of types.rows) await pool.query(`DROP TYPE IF EXISTS "${t.typname}" CASCADE`);
}

async function main() {
  console.log('[pg-verify] Database: ' + DATABASE_URL.replace(/:[^:@]+@/, ':***@'));
  await dropAll();

  // initDb diimpor SETELAH DATABASE_URL disetel (db.js membaca env saat import).
  const { initDb } = await import('../src/db.js');

  console.log('\n[1] initDb idempotent');
  await initDb();
  const regions = await pool.query('SELECT COUNT(*) AS n FROM regions');
  check('Seed wilayah: 17', Number(regions.rows[0].n) === 17, `n=${regions.rows[0].n}`);
  const coms = await pool.query('SELECT COUNT(*) AS n FROM commodities');
  check('Seed komoditas: 15', Number(coms.rows[0].n) === 15);
  const jobs = await pool.query('SELECT COUNT(*) AS n FROM jobs WHERE is_admin = 1');
  check('Seed lowongan ADMIN: 6', Number(jobs.rows[0].n) === 6);
  await initDb();
  const regions2 = await pool.query('SELECT COUNT(*) AS n FROM regions');
  check('initDb kedua: seed tidak terduplikasi', Number(regions2.rows[0].n) === 17);

  console.log('\n[2] initDb paralel (3× bersamaan)');
  await Promise.all([initDb(), initDb(), initDb()]);
  const regions3 = await pool.query('SELECT COUNT(*) AS n FROM regions');
  check('initDb paralel: seed tetap 17', Number(regions3.rows[0].n) === 17);

  console.log('\n[3] Perbaikan state lama');
  // Kolom timestamp INTEGER (state sebelum perbaikan 22003): kosongkan tabel,
  // turunkan ke INTEGER, initDb harus mengembalikannya ke BIGINT.
  await pool.query('TRUNCATE notifications');
  await pool.query('ALTER TABLE notifications ALTER COLUMN created_at TYPE INTEGER');
  const before = await pool.query("SELECT data_type FROM information_schema.columns WHERE table_name = 'notifications' AND column_name = 'created_at'");
  check('Setup: created_at sementara INTEGER', before.rows[0].data_type === 'integer');
  await initDb();
  const after = await pool.query("SELECT data_type FROM information_schema.columns WHERE table_name = 'notifications' AND column_name = 'created_at'");
  check('Migrasi: created_at kembali BIGINT', after.rows[0].data_type === 'bigint', `type=${after.rows[0].data_type}`);
  // Tipe komposit yatim: hapus tabel world, buat tipe 'world', initDb harus
  // menghapus tipe itu dan membuat ulang tabelnya.
  await pool.query('DROP TABLE world');
  await pool.query('CREATE TYPE world AS (a int)');
  await initDb();
  const worldTable = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'world'");
  // Setiap tabel Postgres punya tipe komposit bernama sama; yang membuktikan
  // cleanup orphan adalah tipe itu kini milik tabel (typrelid != 0), bukan
  // yatim, dan tabelnya bisa dipakai.
  const worldType = await pool.query("SELECT typrelid FROM pg_type WHERE typname = 'world' AND typtype = 'c'");
  const worldDay = await pool.query('SELECT day FROM world WHERE id = 1');
  check('Migrasi: tabel world dibuat ulang', worldTable.rowCount === 1);
  check('Migrasi: tipe world kini milik tabel (bukan yatim)', worldType.rowCount === 1 && Number(worldType.rows[0].typrelid) !== 0, `typrelid=${worldType.rows[0]?.typrelid}`);
  check('Migrasi: tabel world ter-seed (hari 1)', worldDay.rows[0]?.day === 1, `day=${worldDay.rows[0]?.day}`);
  // Kolom token_version (migrasi Tahap 2): hapus kolom, initDb menambahkannya.
  await pool.query('ALTER TABLE users DROP COLUMN token_version');
  await initDb();
  const tv = await pool.query("SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'token_version'");
  check('Migrasi: kolom token_version ditambah kembali', tv.rowCount === 1, `default=${tv.rows[0]?.column_default}`);

  console.log('\n[4] CHECK saldo/qty + tabel/index baru');
  const checks = await pool.query("SELECT conname FROM pg_constraint WHERE contype = 'c' AND conname LIKE 'ck_%'");
  const names = new Set(checks.rows.map((r) => r.conname));
  const expected = ['ck_citizens_gold_nonneg', 'ck_citizens_usd_nonneg', 'ck_citizens_energy_nonneg',
    'ck_inventory_qty_nonneg', 'ck_market_offers_qty_pos', 'ck_market_offers_price_pos',
    'ck_fx_offers_qty_gold_nonneg', 'ck_fx_offers_qty_filled_nonneg',
    'ck_jobs_seats_nonneg', 'ck_jobs_seats_lte', 'ck_wars_score_a_nonneg', 'ck_wars_score_d_nonneg'];
  check('12 CHECK constraint terpasang', expected.every((n) => names.has(n)), `ditemukan ${checks.rowCount}`);
  const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('rate_limits', 'referral_pending')");
  check('Tabel rate_limits + referral_pending ada', tables.rowCount === 2);
  const idx = await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx_%'");
  check('Index baru terpasang (>= 20 idx_*)', idx.rowCount >= 20, `n=${idx.rowCount}`);
  // Penegakan CHECK: saldo negatif ditolak database.
  let rejected = false;
  try {
    await pool.query("INSERT INTO citizens (user_id, level, xp, energy, gold, usd, region_id, home_region_id, created_at) VALUES (999001, 1, 0, 100, -1, 500, 1, 1, 0)");
  } catch (e) { rejected = e.code === '23514'; }
  check('CHECK menolak gold negatif (23514)', rejected);
  await pool.query('DELETE FROM citizens WHERE user_id = 999001').catch(() => {});
  let rejected2 = false;
  try {
    await pool.query("INSERT INTO market_offers (seller_id, scope, commodity_id, tier, qty, price, created_at) VALUES (1, 'local', 1, 1, 0, 9, 0)");
  } catch (e) { rejected2 = e.code === '23514'; }
  check('CHECK menolak penawaran qty 0 (23514)', rejected2);

  console.log('\n[5] JWT_SECRET fail-closed di production');
  const failClosed = await new Promise((resolve) => {
    const p = spawn('node', ['server.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, NODE_ENV: 'production', DATABASE_PATH: '/tmp/parlementer-failclosed.db' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stderr.on('data', (d) => { out += d; });
    p.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(false); }, 15000);
    p.on('exit', (code) => { clearTimeout(timer); resolve(code !== 0 && /JWT_SECRET wajib disetel/.test(out)); });
  });
  // Pastikan JWT_SECRET tidak ikut terwarisi dari env pemanggil saat tes ini.
  if (process.env.JWT_SECRET) console.log('  (dilewati: JWT_SECRET sudah ada di env pemanggil — hapus env itu untuk menguji fail-closed)');
  check('Server production tanpa JWT_SECRET menolak start', failClosed || !!process.env.JWT_SECRET);

  console.log('\n[6] migrateChecks tanpa warning (Tahap 3: tahan race cold start)');
  // migrateChecks jalan DI LUAR transaksi ber-advisory-lock initDb — dua
  // cold start bersamaan bisa sama-sama lolos cek-eksistensi lalu ALTER;
  // yang kalah dulu mendapat 42P07 dan menulis warning "[db] CHECK ...".
  // Sekarang 42P07 ditelan diam-diam (hasil idempotent yang diharapkan).
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    await pool.query('ALTER TABLE jobs DROP CONSTRAINT IF EXISTS ck_jobs_seats_nonneg');
    await Promise.all([initDb(), initDb(), initDb()]);
  } finally { console.warn = origWarn; }
  const checkWarns = warns.filter((w) => w.includes('[db] CHECK'));
  check('migrateChecks paralel: tanpa warning CHECK', checkWarns.length === 0, checkWarns[0] || '');
  const hasCk = await pool.query("SELECT 1 FROM pg_constraint WHERE conname = 'ck_jobs_seats_nonneg'");
  check('constraint ck_jobs_seats_nonneg terpasang kembali (tepat 1)', hasCk.rowCount === 1);

  await pool.end();
  console.log(`\n[pg-verify] SELESAI: ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[pg-verify] ERROR:', e); process.exit(1); });
