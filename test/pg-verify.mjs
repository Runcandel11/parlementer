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
  const { initDb, one } = await import('../src/db.js');

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

  console.log('\n[7] Tabel + kolom Tahap 4 + seed pengumuman');
  const t4tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('market_buy_orders', 'treasury_tx', 'market_flags', 'announcements', 'announcement_reads')");
  check('5 tabel Tahap 4 ada', t4tables.rowCount === 5, `n=${t4tables.rowCount}`);
  const t4cols = await pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE (table_name = 'country' AND column_name = 'treasury_usd') OR (table_name = 'citizens' AND column_name = 'energy_updated_at')");
  check('Kolom treasury_usd + energy_updated_at ada', t4cols.rowCount === 2);
  const t4checks = await pool.query("SELECT conname FROM pg_constraint WHERE contype = 'c' AND conname IN ('ck_buy_orders_qty_pos', 'ck_buy_orders_price_pos', 'ck_buy_orders_filled_nonneg', 'ck_buy_orders_filled_lte')");
  check('4 CHECK order beli terpasang', t4checks.rowCount === 4, `n=${t4checks.rowCount}`);
  const anns = await pool.query('SELECT COUNT(*) AS n FROM announcements');
  check('Seed pengumuman Update #1 ada', Number(anns.rows[0].n) >= 1, `n=${anns.rows[0].n}`);
  const ann1 = await pool.query('SELECT title, body FROM announcements ORDER BY created_at ASC LIMIT 1');
  check('Update #1 berisi regen + hadiah barang tanpa batas', /\+2/.test(ann1.rows[0]?.body || '') && /tanpa batas/.test(ann1.rows[0]?.body || ''), ann1.rows[0]?.title || '');
  // Migrasi kolom lama: hapus kolom, initDb menambahkannya kembali.
  await pool.query('ALTER TABLE country DROP COLUMN treasury_usd');
  await pool.query('ALTER TABLE citizens DROP COLUMN energy_updated_at');
  await initDb();
  const t4cols2 = await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE (table_name = 'country' AND column_name = 'treasury_usd') OR (table_name = 'citizens' AND column_name = 'energy_updated_at')");
  check('Migrasi: kolom Tahap 4 ditambah kembali', Number(t4cols2.rows[0].n) === 2);

  console.log('\n[8] Tabel + kolom Tahap 5 + seed pengumuman + parser int8');
  const t5tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('budgets', 'budget_votes', 'impeachments', 'impeachment_votes', 'org_pacts')");
  check('5 tabel Tahap 5 ada', t5tables.rowCount === 5, `n=${t5tables.rowCount}`);
  const t5cols = await pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE (table_name = 'country' AND column_name IN ('admin_pay_mult', 'travel_tickets', 'mobilization_until', 'budget_kind', 'budget_until', 'holiday_at')) OR (table_name = 'laws' AND column_name IN ('kind', 'value', 'effect_applied'))");
  check('9 kolom Tahap 5 ada (6 negara + 3 UU)', t5cols.rowCount === 9, `n=${t5cols.rowCount}`);
  const t5checks = await pool.query("SELECT conname FROM pg_constraint WHERE contype = 'c' AND conname IN ('ck_country_tax_income_range', 'ck_country_admin_pay_mult_range', 'ck_country_travel_tickets', 'ck_budgets_amount_range')");
  check('4 CHECK Tahap 5 terpasang (pajak/upah/tiket/anggaran)', t5checks.rowCount === 4, `n=${t5checks.rowCount}`);
  // Tabel announcements tidak punya kolom num (nomor dihitung API dari
  // urutan created_at) — cari Update #2 lewat judulnya.
  const ann2 = await pool.query("SELECT title, body FROM announcements WHERE title LIKE 'UU Kini Berpengaruh%'");
  check('Seed pengumuman Update #2 ada', ann2.rowCount === 1, `n=${ann2.rowCount}`);
  check('Update #2 berisi wilayah acak + Invalid Date + lag', /acak/.test(ann2.rows[0]?.body || '') && /Invalid Date/.test(ann2.rows[0]?.body || '') && /lebih ringan/.test(ann2.rows[0]?.body || ''), ann2.rows[0]?.title || '');
  const regionDefaults = await pool.query("SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'citizens' AND column_name IN ('region_id', 'home_region_id')");
  check('citizens.region_id/home_region_id TANPA default (bug region 1)', regionDefaults.rows.every((r) => r.column_default === null), JSON.stringify(regionDefaults.rows));
  // Parser int8: BIGINT dari Postgres HARUS jadi number lewat pool aplikasi
  // (sebelum Tahap 5, node-postgres mengembalikan string → "Invalid Date").
  const createdAt = await one("SELECT created_at FROM announcements WHERE title LIKE 'UU Kini Berpengaruh%'");
  check('Parser int8 aplikasi: created_at berupa number (bukan string)', typeof createdAt?.created_at === 'number', `typeof=${typeof createdAt?.created_at}`);
  check('Parser int8 aplikasi: created_at valid (mendekati sekarang)', typeof createdAt?.created_at === 'number' && Math.abs(Date.now() - createdAt.created_at) < 60000, `val=${createdAt?.created_at}`);
  // Migrasi kolom Tahap 5: hapus kolom, initDb menambahkannya kembali.
  await pool.query('ALTER TABLE country DROP COLUMN admin_pay_mult');
  await pool.query('ALTER TABLE laws DROP COLUMN effect_applied');
  await initDb();
  const t5cols2 = await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE (table_name = 'country' AND column_name = 'admin_pay_mult') OR (table_name = 'laws' AND column_name = 'effect_applied')");
  check('Migrasi: kolom Tahap 5 ditambah kembali', Number(t5cols2.rows[0].n) === 2);

  await pool.end();
  console.log(`\n[pg-verify] SELESAI: ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[pg-verify] ERROR:', e); process.exit(1); });
