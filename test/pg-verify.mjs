// Parlementer — verifikasi migrasi Postgres sungguhan (Tahap 2).
// Menguji initDb di Postgres 16 lokal (bukan pg-mem/SQLite):
//   (1) initDb idempotent (2× berurutan + 3× paralel — advisory lock),
//   (2) perbaikan state lama: kolom timestamp INTEGER → BIGINT,
//       tipe komposit yatim dihapus, kolom token_version ditambah,
//   (3) CHECK saldo/qty terpasang + ditegakkan,
//   (4) JWT_SECRET fail-closed di production,
//   (5) version gate (perbaikan advisory lock 27 Nov 2026): initDb di
//       steady state hanya baca penanda db_meta (tanpa lock/DDL);
//       migrasi penuh hanya jalan bila penanda dihapus / versi lama.
// Perlu Postgres 16 lokal + role/db tes (dibuat sekali, lihat README):
//   su postgres -c "psql -c \"CREATE ROLE parlementer_test LOGIN PASSWORD 'parlementer_test'\""
//   su postgres -c "psql -c \"CREATE DATABASE parlementer_test OWNER parlementer_test\""
// Jalankan: npm run test:pg-verify   (atau: node test/pg-verify.mjs)
// BUKAN bagian dari test:all — butuh server Postgres lokal.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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

// Simulasi "DB versi lama": hapus penanda versi agar initDb berikutnya
// menjalankan migrasi penuh. Tanpa ini, initDb di steady state sengaja
// MELEWATI migrasi (version gate, perbaikan advisory lock 27 Nov 2026) —
// tes "rusak lalu perbaiki" harus menghapus penanda dulu, seperti DB lama
// yang memang belum punya penanda.
async function resetVersion() {
  await pool.query("DELETE FROM db_meta WHERE key = 'schema_version'");
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
  check('Seed komoditas: 16 (15 + Minuman Energi v3.1.0)', Number(coms.rows[0].n) === 16);
  const jobs = await pool.query('SELECT COUNT(*) AS n FROM jobs WHERE is_admin = 1');
  check('Seed lowongan ADMIN: 18 (satu per wilayah, Kepri 2)', Number(jobs.rows[0].n) === 18, `n=${jobs.rows[0].n}`);
  const jobRegions = await pool.query('SELECT COUNT(DISTINCT region_id) AS n FROM jobs WHERE is_admin = 1');
  check('Lowongan ADMIN: 17 wilayah tercakup', Number(jobRegions.rows[0].n) === 17, `n=${jobRegions.rows[0].n}`);
  await initDb();
  const regions2 = await pool.query('SELECT COUNT(*) AS n FROM regions');
  check('initDb kedua: seed tidak terduplikasi', Number(regions2.rows[0].n) === 17);

  console.log('\n[2] initDb paralel (3× bersamaan)');
  const t2a = Date.now();
  await Promise.all([initDb(), initDb(), initDb()]);
  const t2b = Date.now() - t2a;
  const regions3 = await pool.query('SELECT COUNT(*) AS n FROM regions');
  check('initDb paralel: seed tetap 17', Number(regions3.rows[0].n) === 17);
  check('initDb paralel 3× selesai cepat (< 10 detik)', t2b < 10000, `${t2b}ms`);

  console.log('\n[3] Perbaikan state lama');
  // Kolom timestamp INTEGER (state sebelum perbaikan 22003): kosongkan tabel,
  // turunkan ke INTEGER, initDb harus mengembalikannya ke BIGINT.
  await pool.query('TRUNCATE notifications');
  await pool.query('ALTER TABLE notifications ALTER COLUMN created_at TYPE INTEGER');
  const before = await pool.query("SELECT data_type FROM information_schema.columns WHERE table_name = 'notifications' AND column_name = 'created_at'");
  check('Setup: created_at sementara INTEGER', before.rows[0].data_type === 'integer');
  await resetVersion();
  await initDb();
  const after = await pool.query("SELECT data_type FROM information_schema.columns WHERE table_name = 'notifications' AND column_name = 'created_at'");
  check('Migrasi: created_at kembali BIGINT', after.rows[0].data_type === 'bigint', `type=${after.rows[0].data_type}`);
  // Tipe komposit yatim: hapus tabel world, buat tipe 'world', initDb harus
  // menghapus tipe itu dan membuat ulang tabelnya.
  await pool.query('DROP TABLE world');
  await pool.query('CREATE TYPE world AS (a int)');
  await resetVersion();
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
  await resetVersion();
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
  // migrateChecks hanya jalan bila instance ini baru saja bermigrasi
  // (perbaikan advisory lock 27 Nov 2026) dan tetap DI LUAR transaksi
  // utama — dua cold start bersamaan dulu bisa sama-sama lolos
  // cek-eksistensi lalu ALTER; yang kalah mendapat 42P07 dan menulis
  // warning "[db] CHECK ...". Sekarang 42P07 ditelan diam-diam (hasil
  // idempotent yang diharapkan).
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    await pool.query('ALTER TABLE jobs DROP CONSTRAINT IF EXISTS ck_jobs_seats_nonneg');
    await resetVersion();
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
  await resetVersion();
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
  await resetVersion();
  await initDb();
  const t5cols2 = await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE (table_name = 'country' AND column_name = 'admin_pay_mult') OR (table_name = 'laws' AND column_name = 'effect_applied')");
  check('Migrasi: kolom Tahap 5 ditambah kembali', Number(t5cols2.rows[0].n) === 2);
  // Migrasi kolom online: hapus kolom, initDb menambahkannya kembali.
  await pool.query('ALTER TABLE citizens DROP COLUMN last_seen_at');
  await resetVersion();
  await initDb();
  const onlineCol = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'citizens' AND column_name = 'last_seen_at'");
  check('Migrasi: kolom citizens.last_seen_at ditambah kembali', onlineCol.rowCount === 1);
  // Migrasi kolom gambar artikel: hapus kolom, initDb menambahkannya kembali.
  await pool.query('ALTER TABLE articles DROP COLUMN cover');
  await pool.query('ALTER TABLE articles DROP COLUMN cover_sm');
  await resetVersion();
  await initDb();
  const artImgCols = await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_name = 'articles' AND column_name IN ('cover', 'cover_sm')");
  check('Migrasi: kolom articles.cover + cover_sm ditambah kembali', Number(artImgCols.rows[0].n) === 2);

  console.log('\n[9] Version gate initDb (perbaikan advisory lock 27 Nov 2026)');
  // Insiden: initDb lama menahan advisory lock global selama ~100 round-trip
  // DDL di SETIAP cold start → antre 24 detik → timeout/500. Sejak perbaikan,
  // steady state hanya baca penanda (tanpa lock/DDL); migrasi penuh hanya
  // bila penanda dihapus / versi lama.
  const ver = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Penanda versi skema = 27', ver.rows[0]?.value === '27', `value=${ver.rows[0]?.value}`);
  const t9a = Date.now();
  await Promise.all([initDb(), initDb(), initDb(), initDb(), initDb()]);
  const t9b = Date.now() - t9a;
  check('initDb paralel 5× (steady state) selesai cepat (< 10 detik)', t9b < 10000, `${t9b}ms`);
  // Kontrak gate: TANPA resetVersion, initDb SENGAJA tidak memperbaiki
  // skema yang dirusak — DDL hanya jalan saat migrasi versi. Ini perilaku
  // yang diinginkan (bukan bug): cold start tidak boleh menjalankan DDL.
  await pool.query('ALTER TABLE users DROP COLUMN token_version');
  await initDb();
  const tvGated = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'token_version'");
  check('Gate: kolom yang dihapus TIDAK diperbaiki tanpa resetVersion', tvGated.rowCount === 0);
  await resetVersion();
  await initDb();
  const tvFixed = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'token_version'");
  check('Setelah resetVersion: migrasi memperbaiki kolom', tvFixed.rowCount === 1);
  // Semua CHECK harus tervalidasi (ADD ... NOT VALID + VALIDATE).
  const unvalidated = await pool.query("SELECT conname FROM pg_constraint WHERE contype = 'c' AND conname LIKE 'ck_%' AND NOT convalidated");
  check('Semua CHECK tervalidasi (tidak ada yang NOT VALID)', unvalidated.rowCount === 0, unvalidated.rows.map((r) => r.conname).join(',') || '0');

  console.log('\n[10] Redesain dunia — migrasi v10 + pembubaran RI');
  // Fresh initDb (dari dropAll di awal) TIDAK membuat negara apa pun.
  const noCountry = await pool.query('SELECT COUNT(*) AS n FROM country');
  check('Fresh initDb: 0 negara (dunia terpecah)', Number(noCountry.rows[0].n) === 0, `n=${noCountry.rows[0].n}`);
  const parOpens = await pool.query("SELECT value FROM db_meta WHERE key = 'parliament_opens_at'");
  check('Seed db_meta parliament_opens_at = 2 Des 2026', parOpens.rows[0]?.value === '1796144400000', `value=${parOpens.rows[0]?.value}`);
  const r10tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('party_seats', 'country_joins', 'country_join_votes')");
  check('3 tabel baru redesain ada', r10tables.rowCount === 3, `n=${r10tables.rowCount}`);
  const r10cols = await pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE (table_name = 'country' AND column_name IN ('system', 'founder_id')) OR (table_name = 'regions' AND column_name = 'country_id') OR (table_name = 'laws' AND column_name = 'country_id')");
  check('Kolom baru redesain ada (country.system/founder_id, regions.country_id, laws.country_id)', r10cols.rowCount === 4, `n=${r10cols.rowCount}`);
  const r10checks = await pool.query("SELECT conname FROM pg_constraint WHERE contype = 'c' AND conname IN ('ck_country_ideology', 'ck_country_system')");
  check('CHECK ideologi + sistem terpasang', r10checks.rowCount === 2, `n=${r10checks.rowCount}`);
  // Migrasi kolom/tabel baru: hapus, initDb mengembalikannya.
  await pool.query('ALTER TABLE country DROP COLUMN system');
  await pool.query('ALTER TABLE country DROP COLUMN founder_id');
  await pool.query('ALTER TABLE regions DROP COLUMN country_id');
  await pool.query('ALTER TABLE laws DROP COLUMN country_id');
  await pool.query('DROP TABLE IF EXISTS party_seats, country_joins, country_join_votes CASCADE');
  await resetVersion();
  await initDb();
  const r10cols2 = await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE (table_name = 'country' AND column_name IN ('system', 'founder_id')) OR (table_name = 'regions' AND column_name = 'country_id') OR (table_name = 'laws' AND column_name = 'country_id')");
  check('Migrasi: kolom redesain ditambah kembali', Number(r10cols2.rows[0].n) === 4, `n=${r10cols2.rows[0].n}`);
  const r10tables2 = await pool.query("SELECT COUNT(*) AS n FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('party_seats', 'country_joins', 'country_join_votes')");
  check('Migrasi: 3 tabel redesain dibuat kembali', Number(r10tables2.rows[0].n) === 3, `n=${r10tables2.rows[0].n}`);
  // Pembubaran RI: fabrikasi state v9 (negara id=1 + wilayah + UU voting +
  // pemilu terjadwal), lalu initDb harus membubarkannya.
  await pool.query("INSERT INTO users (id, email, username, pass_hash, created_at) VALUES (999002, 'ri@test.local', 'warga_ri', 'x', 0)");
  await pool.query("INSERT INTO citizens (id, user_id, region_id, home_region_id, created_at) VALUES (999002, 999002, 1, 1, 0)");
  await pool.query("INSERT INTO country (id, name, ideology, system, capital, founded, treasury, treasury_usd, tax_income, tax_production, tax_import, tax_export) VALUES (1, 'Republik Indonesia', 'Konservatisme', 'presidensial', 'Jakarta', '2026-09-23', 100, 50, 2, 1, 2, 2)");
  await pool.query("UPDATE regions SET country = 'Republik Indonesia', country_id = 1 WHERE id IN (1,2,3)");
  await pool.query("INSERT INTO laws (proposer_id, title, content, kind, status, ends_at, created_at) VALUES (999002, 'UU Lama RI', 'Isi UU lama.', 'general', 'voting', 9999999999999, 0)");
  await pool.query("INSERT INTO elections (type, status, opens_at, closes_at, country_id, created_at) VALUES ('president', 'scheduled', 9999999999999, 9999999999999, 1, 0)");
  const riBefore = await pool.query("SELECT COUNT(*) AS n FROM country WHERE name = 'Republik Indonesia'");
  check('Setup: RI ter-fabrikasi (id=1, kas 100 emas + 50 USD)', Number(riBefore.rows[0].n) === 1);
  await resetVersion();
  await initDb();
  const riAfter = await pool.query('SELECT COUNT(*) AS n FROM country');
  check('Migrasi: baris negara RI hilang (dibubarkan)', Number(riAfter.rows[0].n) === 0, `n=${riAfter.rows[0].n}`);
  const regsAfter = await pool.query("SELECT COUNT(*) AS n FROM regions WHERE country <> '' OR country_id IS NOT NULL");
  check("Migrasi: semua wilayah kembali merdeka (country='' + country_id NULL)", Number(regsAfter.rows[0].n) === 0, `n=${regsAfter.rows[0].n}`);
  const lawAfter = await pool.query("SELECT status FROM laws WHERE title = 'UU Lama RI'");
  check("Migrasi: UU voting era RI jadi 'failed'", lawAfter.rows[0]?.status === 'failed', `status=${lawAfter.rows[0]?.status}`);
  const elAfter = await pool.query("SELECT status FROM elections WHERE country_id = 1 AND type = 'president'");
  check("Migrasi: pemilu terjadwal era RI jadi 'closed'", elAfter.rows[0]?.status === 'closed', `status=${elAfter.rows[0]?.status}`);
  const archive = await pool.query("SELECT kind, currency, amount FROM treasury_tx WHERE kind = 'pembubaran' ORDER BY created_at");
  check('Migrasi: kas RI diarsip sebagai treasury_tx pembubaran (−100 emas, −50 USD)', archive.rows.length === 2 && archive.rows.some((r) => r.currency === 'gold' && Number(r.amount) === -100) && archive.rows.some((r) => r.currency === 'usd' && Number(r.amount) === -50), JSON.stringify(archive.rows));
  const ver10 = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi = 27', ver10.rows[0]?.value === '27', `value=${ver10.rows[0]?.value}`);

  console.log('\n[11] Regresi bug Partai — GET /api/parties di Postgres (ORDER BY ambigu)');
  // Bug live 27 Nov 2026: begitu ada ≥1 partai, GET /api/parties 500 di
  // Postgres ("ORDER BY \"seats\" is ambiguous": p.* membawa parties.seats
  // + alias subquery `seats`). SQLite tidak menangkap ini — hanya Postgres
  // sungguhan yang menolak. Tes ini memanggil endpoint HTTP sungguhan
  // (server di-spawn seperti pg-concurrency).
  const P_PORT = 3466;
  const P_BASE = `http://127.0.0.1:${P_PORT}`;
  class PClient {
    constructor() { this.cookie = ''; }
    async req(method, p, body) {
      const res = await fetch(P_BASE + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) this.cookie = setCookie.split(';')[0];
      let data = null;
      try { data = await res.json(); } catch { data = {}; }
      return { status: res.status, data };
    }
    get(p) { return this.req('GET', p); }
    post(p, b) { return this.req('POST', p, b || {}); }
  }
  const pServer = spawn('node', ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(P_PORT), DATABASE_URL, JWT_SECRET: 'pg-verify-parties-secret', ADMIN_BOOTSTRAP_CODE: 'pg-verify-bootstrap' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let pServerLog = '';
  pServer.stdout.on('data', (d) => { pServerLog += d; });
  pServer.stderr.on('data', (d) => { pServerLog += d; });
  const pStop = () => { try { pServer.kill('SIGTERM'); } catch {} };
  process.on('exit', pStop);
  let pUp = false;
  for (let i = 0; i < 40 && !pUp; i++) {
    await sleep(500);
    try { const rr = await fetch(P_BASE + '/api/world'); pUp = rr.ok; } catch {}
  }
  check('Server tes menyala (Postgres)', pUp);
  if (pUp) {
    const P1 = new PClient();
    let rr = await P1.post('/api/auth/register', { email: 'ketua@pgverify.local', password: 'rahasia123', username: 'ketua_pgverify' });
    check('P1 mendaftar', rr.status === 200, `status=${rr.status}`);
    const p1me = await P1.get('/api/me');
    await pool.query('UPDATE citizens SET level = 10, gold = 100 WHERE id = $1', [p1me.data.citizen.id]);
    rr = await P1.post('/api/parties', { name: 'Partai Verifikasi', tag: 'VERI', ideology: 'Progresif', type: 'open' });
    check('P1 mendirikan partai', rr.status === 200 && !!rr.data.partyId, `status=${rr.status}`);
    const partyId = rr.data.partyId;
    rr = await P1.get('/api/parties');
    check('GET /api/parties sebagai ketua (wilayah merdeka): 200, 1 partai, seats 0, mine benar',
      rr.status === 200 && rr.data.parties?.length === 1 && rr.data.parties[0].seats === 0 && rr.data.mine?.tag === 'VERI' && rr.data.mine?.seats === 0 && rr.data.parties[0].members === 1,
      `status=${rr.status} seats=${rr.data.parties?.[0]?.seats} mine=${rr.data.mine?.tag}`);
    const P2 = new PClient();
    rr = await P2.post('/api/auth/register', { email: 'warga@pgverify.local', password: 'rahasia123', username: 'warga_pgverify' });
    check('P2 mendaftar', rr.status === 200, `status=${rr.status}`);
    rr = await P2.get('/api/parties');
    check('GET /api/parties sebagai warga tanpa partai (wilayah merdeka): 200, mine null',
      rr.status === 200 && rr.data.parties?.length === 1 && rr.data.mine === null,
      `status=${rr.status} mine=${JSON.stringify(rr.data.mine)}`);
    // Kursi per negara: fabrikasi negara + kursi, pindah P2 ke wilayahnya.
    await pool.query("INSERT INTO country (id, name, ideology, system, capital, founded, treasury, treasury_usd, tax_income, tax_production, tax_import, tax_export) VALUES (9001, 'Negara Tes', 'Konservatisme', 'presidensial', 'Jakarta', '2026-11-27', 0, 0, 2, 1, 2, 2)");
    await pool.query("UPDATE regions SET country = 'Negara Tes', country_id = 9001 WHERE id = 5");
    await pool.query('INSERT INTO party_seats (party_id, country_id, seats) VALUES ($1, 9001, 7)', [partyId]);
    const p2me = await P2.get('/api/me');
    // Kursi partai mengikuti KEWARGANEGARAAN (home_region_id, 27 Nov 2026):
    // pindah P2 ke wilayah Negara Tes secara penuh (lokasi + asal).
    await pool.query('UPDATE citizens SET region_id = 5, home_region_id = 5 WHERE id = $1', [p2me.data.citizen.id]);
    rr = await P2.get('/api/parties');
    check('GET /api/parties sebagai warga Negara Tes: kursi partai = 7 (per negara)',
      rr.status === 200 && rr.data.parties?.[0]?.seats === 7,
      `status=${rr.status} seats=${rr.data.parties?.[0]?.seats}`);
    // P1 harus benar-benar warga merdeka untuk cek ini: wilayah lahirnya
    // acak (Tahap 5) — bila kebetulan wilayah 5 (Negara Tes), pindahkan
    // dulu ke wilayah merdeka mana pun supaya kursinya 0.
    const p1Home = (await P1.get('/api/me')).data.citizen.home_region_id;
    if (p1Home === 5) {
      const freeP = await pool.query('SELECT id FROM regions WHERE country_id IS NULL AND id <> 5 ORDER BY id LIMIT 1');
      await pool.query('UPDATE citizens SET region_id = $1, home_region_id = $1 WHERE id = $2', [freeP.rows[0].id, p1me.data.citizen.id]);
    }
    rr = await P1.get('/api/parties');
    check('GET /api/parties sebagai warga merdeka: kursi partai tetap 0',
      rr.status === 200 && rr.data.parties?.[0]?.seats === 0,
      `status=${rr.status} seats=${rr.data.parties?.[0]?.seats}`);
    pStop();
  } else {
    console.log(pServerLog);
    pStop();
  }

  console.log('\n[12] Travel + waktu tempuh — migrasi v11 + endpoint (27 Nov 2026)');
  // Kolom perjalanan ada setelah initDb.
  const tCols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'citizens' AND column_name IN ('travel_to_region_id', 'travel_arrives_at', 'home_changed_at')");
  check('Kolom perjalanan ada (travel_to_region_id, travel_arrives_at, home_changed_at)', tCols.rowCount === 3, `n=${tCols.rowCount}`);
  // Migrasi: hapus kolom, initDb mengembalikannya (versi 11).
  await pool.query('ALTER TABLE citizens DROP COLUMN travel_to_region_id');
  await pool.query('ALTER TABLE citizens DROP COLUMN travel_arrives_at');
  await pool.query('ALTER TABLE citizens DROP COLUMN home_changed_at');
  await resetVersion();
  await initDb();
  const tCols2 = await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_name = 'citizens' AND column_name IN ('travel_to_region_id', 'travel_arrives_at', 'home_changed_at')");
  check('Migrasi: kolom perjalanan ditambah kembali', Number(tCols2.rows[0].n) === 3, `n=${tCols2.rows[0].n}`);
  const ver11 = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi = 27', ver11.rows[0]?.value === '27', `value=${ver11.rows[0]?.value}`);

  console.log('\n[12b] Perusahaan v2.4.0 — migrasi v12 (foto + bonus shift)');
  const coCols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'companies' AND column_name IN ('photo', 'photo_sm', 'bonus_credit', 'bonus_given', 'bonus_warned_at')");
  check('Kolom perusahaan v2.4.0 ada (photo, photo_sm, bonus_credit, bonus_given, bonus_warned_at)', coCols.rowCount === 5, `n=${coCols.rowCount}`);
  // Migrasi: hapus kolom, initDb mengembalikannya (versi 12).
  await pool.query('ALTER TABLE companies DROP COLUMN photo');
  await pool.query('ALTER TABLE companies DROP COLUMN bonus_credit');
  await resetVersion();
  await initDb();
  const coCols2 = await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_name = 'companies' AND column_name IN ('photo', 'photo_sm', 'bonus_credit', 'bonus_given', 'bonus_warned_at')");
  check('Migrasi: kolom perusahaan ditambah kembali', Number(coCols2.rows[0].n) === 5, `n=${coCols2.rows[0].n}`);
  const ver12 = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi = 27', ver12.rows[0]?.value === '27', `value=${ver12.rows[0]?.value}`);

  console.log('\n[12c] Kredit skor v3.0.0 — migrasi v13 (kolom skor + verdict + riwayat)');
  const crCols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'citizens' AND column_name IN ('credit_score', 'credit_updated_at')");
  check('Kolom kredit skor v3.0.0 ada (credit_score, credit_updated_at)', crCols.rowCount === 2, `n=${crCols.rowCount}`);
  const repCols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'chat_reports' AND column_name IN ('verdict')");
  check('Kolom putusan laporan v3.0.0 ada (verdict)', repCols.rowCount === 1, `n=${repCols.rowCount}`);
  const histTbl = await pool.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'credit_history'");
  check('Tabel riwayat skor v3.0.0 ada (credit_history)', Number(histTbl.rows[0].n) === 1, `n=${histTbl.rows[0].n}`);
  // Migrasi: hapus kolom skor, initDb mengembalikannya (versi 13).
  await pool.query('ALTER TABLE citizens DROP COLUMN credit_score');
  await resetVersion();
  await initDb();
  const crCols2 = await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_name = 'citizens' AND column_name IN ('credit_score', 'credit_updated_at')");
  check('Migrasi: kolom kredit skor ditambah kembali', Number(crCols2.rows[0].n) === 2, `n=${crCols2.rows[0].n}`);
  const ver13 = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi = 27', ver13.rows[0]?.value === '27', `value=${ver13.rows[0]?.value}`);

  console.log('\n[12d] Fitur tiket v3.1.0 — Minuman Energi (skala XP ×20 PENSIUN)');
  const drinkRow = await pool.query("SELECT ref_usd, ref_gold, category FROM commodities WHERE name = 'Minuman Energi'");
  check('Komoditas Minuman Energi ada di seed (Perbekalan, 1,83 USD / 0,10 emas)', drinkRow.rowCount === 1
    && drinkRow.rows[0].category === 'Perbekalan' && Number(drinkRow.rows[0].ref_gold) === 0.1 && Number(drinkRow.rows[0].ref_usd) === 1.83,
    JSON.stringify(drinkRow.rows[0]));
  // Skala XP ×20 SUDAH PENSIUN (insiden 28 Nov 2026, v4.3.4): rescale v3.1.0
  // dimaksudkan sekali, tapi migrateXpScale ikut jalan di setiap kenaikan
  // versi dan melipatgandakan XP ×160.000 — fungsinya dihapus. Warga
  // dengan XP 7 (skala baru) harus TETAP 7 saat migrasi; tidak ada lagi
  // perkalian XP di rantai migrasi.
  await pool.query("INSERT INTO users (id, email, username, pass_hash, created_at) VALUES (999003, 'xp@test.local', 'warga_xp', 'x', 0)");
  await pool.query("INSERT INTO citizens (id, user_id, region_id, home_region_id, xp, created_at) VALUES (999003, 999003, 1, 1, 7, 0)");
  await pool.query("INSERT INTO users (id, email, username, pass_hash, created_at) VALUES (999004, 'xp0@test.local', 'warga_xp0', 'x', 0)");
  await pool.query("INSERT INTO citizens (id, user_id, region_id, home_region_id, xp, created_at) VALUES (999004, 999004, 1, 1, 0, 0)");
  await resetVersion();
  await initDb();
  const xpRows = await pool.query('SELECT id, xp FROM citizens WHERE id IN (999003, 999004) ORDER BY id');
  check('Migrasi: XP 7 tetap 7 (tidak ada lagi ×20)', xpRows.rows[0]?.xp === 7, `xp=${xpRows.rows[0]?.xp}`);
  check('Migrasi: XP 0 tetap 0', xpRows.rows[1]?.xp === 0, `xp=${xpRows.rows[1]?.xp}`);
  const ver14 = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi = 27', ver14.rows[0]?.value === '27', `value=${ver14.rows[0]?.value}`);
  // Aturan durasi (unit, tanpa server): Kepri → Jakarta ±830 km = 10 mnt;
  // Jakarta → Bandung ±116 km = 3 mnt; terjauh dipangkas ke 30 mnt.
  const { travelMinutesFor } = await import('../src/game.js');
  check('Durasi Kepri → Jakarta = 10 menit', travelMinutesFor('Kepulauan Riau', 'Jakarta') === 10, `mnt=${travelMinutesFor('Kepulauan Riau', 'Jakarta')}`);
  check('Durasi Jakarta → Jawa Barat = 3 menit', travelMinutesFor('Jakarta', 'Jawa Barat') === 3, `mnt=${travelMinutesFor('Jakarta', 'Jawa Barat')}`);
  check('Durasi Jakarta → Papua dipangkas ke 30 menit', travelMinutesFor('Jakarta', 'Papua') === 30, `mnt=${travelMinutesFor('Jakarta', 'Papua')}`);
  check('Durasi wilayah tak dikenal fallback 10 menit', travelMinutesFor('Jakarta', 'Atlantis') === 10, `mnt=${travelMinutesFor('Jakarta', 'Atlantis')}`);
  // Endpoint travel + move lewat HTTP (server tes kedua, Postgres sungguhan).
  const T_PORT = 3467;
  const T_BASE = `http://127.0.0.1:${T_PORT}`;
  class TClient {
    constructor() { this.cookie = ''; }
    async req(method, p, body) {
      const res = await fetch(T_BASE + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) this.cookie = setCookie.split(';')[0];
      let data = null;
      try { data = await res.json(); } catch { data = {}; }
      return { status: res.status, data };
    }
    get(p) { return this.req('GET', p); }
    post(p, b) { return this.req('POST', p, b || {}); }
  }
  const tServer = spawn('node', ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(T_PORT), DATABASE_URL, JWT_SECRET: 'pg-verify-travel-secret', ADMIN_BOOTSTRAP_CODE: 'pg-verify-bootstrap' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let tServerLog = '';
  tServer.stdout.on('data', (d) => { tServerLog += d; });
  tServer.stderr.on('data', (d) => { tServerLog += d; });
  const tStop = () => { try { tServer.kill('SIGTERM'); } catch {} };
  process.on('exit', tStop);
  let tUp = false;
  for (let i = 0; i < 40 && !tUp; i++) {
    await sleep(500);
    try { const rr = await fetch(T_BASE + '/api/world'); tUp = rr.ok; } catch {}
  }
  check('Server tes travel menyala (Postgres)', tUp);
  if (tUp) {
    const T1 = new TClient();
    let rr = await T1.post('/api/auth/register', { email: 'travel@pgverify.local', password: 'rahasia123', username: 'travel_pgverify' });
    check('T1 mendaftar', rr.status === 200, `status=${rr.status}`);
    const tMe0 = await T1.get('/api/me');
    const tHome0 = tMe0.data.citizen.home_region_id;
    const tRegion0 = tMe0.data.citizen.region_id;
    check('/api/me: homeRegion ada, travel null saat lahir', !!tMe0.data.homeRegion && tMe0.data.travel === null, `home=${tMe0.data.homeRegion?.name} travel=${JSON.stringify(tMe0.data.travel)}`);
    const tRegs = (await T1.get('/api/regions')).data;
    const tTarget = tRegs.regions.find((x) => x.id !== tRegion0);
    check('GET /api/regions: travelMinutes + home + travelTickets ada', tRegs.regions.every((x) => typeof x.travelMinutes === 'number') && tRegs.home === tHome0 && typeof tRegs.travelTickets === 'number', `home=${tRegs.home} tickets=${tRegs.travelTickets}`);
    rr = await T1.post('/api/regions/travel', { region_id: tTarget.id });
    check('Travel dimulai: inTransit + travelMinutes + arrivesAt masa depan', rr.status === 200 && rr.data.inTransit === true && rr.data.travelMinutes > 0 && rr.data.arrivesAt > Date.now(), `status=${rr.status} ${JSON.stringify(rr.data)}`);
    const tMe1 = await T1.get('/api/me');
    check('Selama transit: lokasi belum berubah, travel aktif', tMe1.data.citizen.region_id === tRegion0 && !!tMe1.data.travel && tMe1.data.travel.toRegionId === tTarget.id, `region=${tMe1.data.region?.name}`);
    check('Selama transit: kewarganegaraan tidak berubah', tMe1.data.citizen.home_region_id === tHome0, `home=${tMe1.data.homeRegion?.name}`);
    rr = await T1.post('/api/regions/move', { region_id: tTarget.id });
    check('Pindah kewarganegaraan saat transit ditolak (400)', rr.status === 400, `status=${rr.status}`);
    await pool.query('UPDATE citizens SET travel_arrives_at = $1 WHERE id = $2', [Date.now() - 1000, tMe1.data.citizen.id]);
    const tMe2 = await T1.get('/api/me');
    check('Setelah waktu habis: tiba di tujuan, transit selesai, home tetap', tMe2.data.citizen.region_id === tTarget.id && !tMe2.data.travel && tMe2.data.citizen.home_region_id === tHome0, `region=${tMe2.data.region?.name} home=${tMe2.data.homeRegion?.name}`);
    rr = await T1.post('/api/regions/move', { region_id: tTarget.id });
    check('Pindah kewarganegaraan ke wilayah yang didiami berhasil', rr.status === 200 && rr.data.region === tTarget.name, `status=${rr.status} ${rr.data.error || ''}`);
    const tMe3 = await T1.get('/api/me');
    check('Kewarganegaraan kini wilayah tujuan', tMe3.data.citizen.home_region_id === tTarget.id, `home=${tMe3.data.homeRegion?.name}`);
    rr = await T1.post('/api/regions/move', { region_id: tTarget.id });
    check('Pindah ke wilayah asal sendiri ditolak (400)', rr.status === 400, `status=${rr.status}`);
    tStop();
  } else {
    console.log(tServerLog);
    tStop();
  }

  console.log('\n[15] Tahap 6 v4.0.0 — migrasi v15 (militer, kepemilikan wilayah, reputasi)');
  const milTbl = await pool.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'military_units'");
  check('Tabel military_units ada', Number(milTbl.rows[0].n) === 1, `n=${milTbl.rows[0].n}`);
  const milCheck = await pool.query("SELECT COUNT(*) AS n FROM information_schema.table_constraints WHERE table_name = 'military_units' AND constraint_type = 'CHECK'");
  check('CHECK unit_type di military_units ada', Number(milCheck.rows[0].n) >= 1, `n=${milCheck.rows[0].n}`);
  const regCtrlCols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'regions' AND column_name IN ('controller', 'controller_id')");
  check('Kolom regions.controller + controller_id ada', regCtrlCols.rowCount === 2, `n=${regCtrlCols.rowCount}`);
  const tradeCol = await pool.query("SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'citizens' AND column_name = 'trades_completed'");
  check('Kolom citizens.trades_completed ada, default 0', tradeCol.rowCount === 1 && String(tradeCol.rows[0].column_default || '').includes('0'), JSON.stringify(tradeCol.rows[0]));
  const ver15 = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi = 27', ver15.rows[0]?.value === '27', `value=${ver15.rows[0]?.value}`);
  // Migrasi: hapus tabel + kolom v15, initDb mengembalikannya; backfill
  // wilayah bernegara -> controller='negara'.
  await pool.query("INSERT INTO country (id, name, ideology, system, founder_id, capital, founded, treasury, treasury_usd, tax_income, tax_production, tax_import, tax_export) VALUES (999001, 'Negara Uji Lima Belas', 'Konservatisme', 'presidensial', 999001, 'Jakarta', '2026-11-28', 0, 0, 2, 1, 2, 2)");
  const freeReg15 = await pool.query('SELECT id FROM regions WHERE country_id IS NULL ORDER BY id LIMIT 1');
  const freeReg15Id = freeReg15.rows[0].id;
  await pool.query('UPDATE regions SET country_id = 999001 WHERE id = $1', [freeReg15Id]);
  await pool.query('DROP TABLE military_units');
  await pool.query('ALTER TABLE regions DROP COLUMN controller');
  await pool.query('ALTER TABLE citizens DROP COLUMN trades_completed');
  await resetVersion();
  await initDb();
  const milTbl2 = await pool.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'military_units'");
  check('Migrasi: tabel military_units dibuat kembali', Number(milTbl2.rows[0].n) === 1, `n=${milTbl2.rows[0].n}`);
  const regCtrl2 = await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_name = 'regions' AND column_name IN ('controller', 'controller_id')");
  check('Migrasi: kolom controller kembali', Number(regCtrl2.rows[0].n) === 2, `n=${regCtrl2.rows[0].n}`);
  const backfill15 = await pool.query('SELECT controller, controller_id FROM regions WHERE id = $1', [freeReg15Id]);
  check('Migrasi: backfill wilayah bernegara -> controller=negara', backfill15.rows[0]?.controller === 'negara' && backfill15.rows[0]?.controller_id === 999001, JSON.stringify(backfill15.rows[0]));
  const tradeCol2 = await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_name = 'citizens' AND column_name = 'trades_completed'");
  check('Migrasi: kolom trades_completed kembali', Number(tradeCol2.rows[0].n) === 1, `n=${tradeCol2.rows[0].n}`);
  const ver15b = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi ulang = 27', ver15b.rows[0]?.value === '27', `value=${ver15b.rows[0]?.value}`);
  // CHECK menolak jenis unit tak dikenal; baris valid masuk.
  await pool.query("INSERT INTO users (id, email, username, pass_hash, created_at) VALUES (999005, 'mil@test.local', 'warga_mil', 'x', 0)");
  await pool.query("INSERT INTO citizens (id, user_id, region_id, home_region_id, created_at) VALUES (999005, 999005, 1, 1, 0)");
  let badUnitRejected = false;
  try {
    await pool.query("INSERT INTO military_units (citizen_id, unit_type, qty, created_at) VALUES (999005, 'kavaleri', 1, 0)");
  } catch { badUnitRejected = true; }
  check('CHECK: unit_type tak dikenal ditolak', badUnitRejected);
  await pool.query("INSERT INTO military_units (citizen_id, unit_type, qty, created_at) VALUES (999005, 'infantry', 10, 0) ON CONFLICT (citizen_id, unit_type) DO UPDATE SET qty = 10");
  const milRow = await pool.query('SELECT qty FROM military_units WHERE citizen_id = 999005 AND unit_type = $1', ['infantry']);
  check('Baris militer valid tersimpan (10 Infanteri)', Number(milRow.rows[0]?.qty) === 10, `qty=${milRow.rows[0]?.qty}`);
  await pool.query('DELETE FROM military_units WHERE citizen_id = 999005');
  await pool.query('UPDATE regions SET country_id = NULL, controller = $1, controller_id = NULL WHERE id = $2', ['bebas', freeReg15Id]);
  await pool.query('DELETE FROM country WHERE id = 999001');
  // Fungsi murni Tahap 6 (unit, tanpa server).
  const s6 = await import('../src/game.js');
  check('unitDamageMult(0)=1, (20)=1,1, (100)=1,5, (200)=1,5 (mentok)', s6.unitDamageMult(0) === 1 && s6.unitDamageMult(20) === 1.1 && s6.unitDamageMult(100) === 1.5 && s6.unitDamageMult(200) === 1.5, `${s6.unitDamageMult(20)} / ${s6.unitDamageMult(100)}`);
  check('unitCapFor(1)=60, (10)=150', s6.unitCapFor(1) === 60 && s6.unitCapFor(10) === 150, `${s6.unitCapFor(1)} / ${s6.unitCapFor(10)}`);
  check('worldEventFor: 1 panen, 8 festival, 15 badai, 22 wabah, 29 booming, 36 darurat, 43 panen', s6.worldEventFor(1).key === 'panen' && s6.worldEventFor(8).key === 'festival' && s6.worldEventFor(15).key === 'badai' && s6.worldEventFor(22).key === 'wabah' && s6.worldEventFor(29).key === 'booming' && s6.worldEventFor(36).key === 'darurat' && s6.worldEventFor(43).key === 'panen', `${s6.worldEventFor(1).key}/${s6.worldEventFor(8).key}/${s6.worldEventFor(43).key}`);
  check('worldEventEndsDay: hari 1 berakhir hari 7, hari 8 berakhir hari 14', s6.worldEventEndsDay(1) === 7 && s6.worldEventEndsDay(8) === 14, `${s6.worldEventEndsDay(1)} / ${s6.worldEventEndsDay(8)}`);
  check('tradeReputation: 0 Baru, 10 Aktif, 50 Terpercaya, 150 Saudagar', s6.tradeReputation(0).label === 'Pedagang Baru' && s6.tradeReputation(10).label === 'Pedagang Aktif' && s6.tradeReputation(50).label === 'Pedagang Terpercaya' && s6.tradeReputation(150).label === 'Saudagar Besar', `${s6.tradeReputation(0).label}/${s6.tradeReputation(50).label}`);
  check('tradeReputation(49): tier berikutnya 50 (Terpercaya)', s6.tradeReputation(49).nextMin === 50 && s6.tradeReputation(49).nextLabel === 'Pedagang Terpercaya', JSON.stringify(s6.tradeReputation(49)));
  const heavyInputs = s6.productionInputsFor('heavy');
  check('productionInputsFor(heavy): 2 input (Besi + Minyak, 1× tiap unit)', heavyInputs.length === 2 && heavyInputs.some((i) => i.commodity === 'Besi Mentah' && i.perUnit === 1) && heavyInputs.some((i) => i.commodity === 'Minyak Mentah' && i.perUnit === 1), JSON.stringify(heavyInputs));
  check('productionInputsFor(resource): tanpa input; factory butuh 2× Besi', s6.productionInputsFor('resource').length === 0 && s6.productionInputText('factory').includes('Besi Mentah'), s6.productionInputText('factory'));
  check('MILITARY_UNITS: Infanteri 2/1, Drone 5/2, Berat 12/5 (power/upkeep)', s6.MILITARY_UNITS.infantry.power === 2 && s6.MILITARY_UNITS.infantry.upkeep === 1 && s6.MILITARY_UNITS.drone.power === 5 && s6.MILITARY_UNITS.drone.upkeep === 2 && s6.MILITARY_UNITS.heavy.power === 12 && s6.MILITARY_UNITS.heavy.upkeep === 5, JSON.stringify(s6.MILITARY_UNITS));
  check('militaryPowerFor: 10 Infanteri + 5 Drone = 45; upkeep 20; count 12', s6.militaryPowerFor([{ type: 'infantry', qty: 10 }, { type: 'drone', qty: 5 }]) === 45 && s6.unitUpkeepFor([{ type: 'infantry', qty: 10 }, { type: 'drone', qty: 5 }]) === 20 && s6.unitCountFor([{ type: 'infantry', qty: 10 }, { type: 'heavy', qty: 2 }]) === 12, `${s6.militaryPowerFor([{ type: 'infantry', qty: 10 }, { type: 'drone', qty: 5 }])} / ${s6.unitUpkeepFor([{ type: 'infantry', qty: 10 }, { type: 'drone', qty: 5 }])}`);

  console.log('\n[16] Tahap 7 v4.1.0 — migrasi v16 (misi/kronik relasional)');
  for (const tbl of ['mission_progress', 'mission_claims', 'chronicle_done', 'chronicle_claims']) {
    const n = await pool.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = $1', [tbl]);
    check(`Tabel ${tbl} ada`, Number(n.rows[0].n) === 1, `n=${n.rows[0].n}`);
  }
  const jsonCols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'citizens' AND column_name IN ('missions', 'chronicle_done', 'chronicle_claimed')");
  check('Kolom JSON lama (missions/chronicle_done/chronicle_claimed) sudah tidak ada di citizens', jsonCols.rowCount === 0, `n=${jsonCols.rowCount}`);
  const ver16 = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi = 27', ver16.rows[0]?.value === '27', `value=${ver16.rows[0]?.value}`);
  // Migrasi backfill: kembalikan kolom JSON lama + satu warga legacy,
  // jalankan initDb, pastikan datanya pindah ke tabel baru lalu kolom
  // lama dihapus. Kunci mati ('energy'/'bread' — tidak pernah dibaca)
  // TIDAK ikut pindah.
  await pool.query("ALTER TABLE citizens ADD COLUMN missions TEXT NOT NULL DEFAULT '{}'");
  await pool.query("ALTER TABLE citizens ADD COLUMN chronicle_done TEXT NOT NULL DEFAULT '[]'");
  await pool.query("ALTER TABLE citizens ADD COLUMN chronicle_claimed TEXT NOT NULL DEFAULT '[]'");
  await pool.query("INSERT INTO users (id, email, username, pass_hash, created_at) VALUES (999016, 'tujuh@test.local', 'warga_tujuh', 'x', 0)");
  await pool.query("INSERT INTO citizens (id, user_id, region_id, home_region_id, created_at, missions, chronicle_done, chronicle_claimed) VALUES (999016, 999016, 1, 1, 0, '{\"chat\":3,\"last_chat_counted\":1700000000000,\"claimed\":[\"energy\"],\"energy\":500,\"bread\":10}', '[\"claim\",\"train\"]', '[1]')");
  await resetVersion();
  await initDb();
  const prog16 = await pool.query('SELECT mkey, value FROM mission_progress WHERE citizen_id = 999016 ORDER BY mkey');
  check('Backfill: mission_progress chat=3 + last_chat_counted', prog16.rows.length === 2 && Number(prog16.rows.find((r) => r.mkey === 'chat')?.value) === 3 && Number(prog16.rows.find((r) => r.mkey === 'last_chat_counted')?.value) === 1700000000000, JSON.stringify(prog16.rows));
  const noDead = await pool.query("SELECT COUNT(*) AS n FROM mission_progress WHERE citizen_id = 999016 AND mkey IN ('energy', 'bread')");
  check('Backfill: kunci mati energy/bread TIDAK dipindah', Number(noDead.rows[0].n) === 0, `n=${noDead.rows[0].n}`);
  const claim16 = await pool.query('SELECT mkey FROM mission_claims WHERE citizen_id = 999016');
  check('Backfill: mission_claims berisi energy', claim16.rows.length === 1 && claim16.rows[0].mkey === 'energy', JSON.stringify(claim16.rows));
  const done16 = await pool.query('SELECT ckey FROM chronicle_done WHERE citizen_id = 999016 ORDER BY ckey');
  check('Backfill: chronicle_done berisi claim + train', done16.rows.length === 2 && done16.rows.map((r) => r.ckey).join(',') === 'claim,train', JSON.stringify(done16.rows));
  const claimCh16 = await pool.query('SELECT chapter FROM chronicle_claims WHERE citizen_id = 999016');
  check('Backfill: chronicle_claims berisi babak 1', claimCh16.rows.length === 1 && Number(claimCh16.rows[0].chapter) === 1, JSON.stringify(claimCh16.rows));
  const jsonCols2 = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'citizens' AND column_name IN ('missions', 'chronicle_done', 'chronicle_claimed')");
  check('Migrasi: kolom JSON lama dihapus setelah backfill', jsonCols2.rowCount === 0, `n=${jsonCols2.rowCount}`);
  const ver16b = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi ulang = 27', ver16b.rows[0]?.value === '27', `value=${ver16b.rows[0]?.value}`);
  // UNIQUE: klaim/tugas ganda ditolak di level database.
  let dupClaimRejected = false;
  try { await pool.query("INSERT INTO mission_claims (citizen_id, mkey, claimed_at) VALUES (999016, 'energy', 0)"); } catch { dupClaimRejected = true; }
  check('UNIQUE: klaim misi ganda ditolak', dupClaimRejected);
  let dupDoneRejected = false;
  try { await pool.query("INSERT INTO chronicle_done (citizen_id, ckey, done_at) VALUES (999016, 'claim', 0)"); } catch { dupDoneRejected = true; }
  check('UNIQUE: tugas kronik ganda ditolak', dupDoneRejected);
  await pool.query('DELETE FROM mission_progress WHERE citizen_id = 999016');
  await pool.query('DELETE FROM mission_claims WHERE citizen_id = 999016');
  await pool.query('DELETE FROM chronicle_done WHERE citizen_id = 999016');
  await pool.query('DELETE FROM chronicle_claims WHERE citizen_id = 999016');
  await pool.query('DELETE FROM citizens WHERE id = 999016');
  await pool.query('DELETE FROM users WHERE id = 999016');

  console.log('\n[17] Tahap 8 v4.2.0 — migrasi v17 (dedupe pemilu + article_views)');
  const avTbl = await pool.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'article_views'");
  check('Tabel article_views ada', Number(avTbl.rows[0].n) === 1, `n=${avTbl.rows[0].n}`);
  const idxEl = await pool.query("SELECT COUNT(*) AS n FROM pg_indexes WHERE indexname = 'idx_elections_one_active'");
  check('Indeks unik parsial idx_elections_one_active ada', Number(idxEl.rows[0].n) === 1, `n=${idxEl.rows[0].n}`);
  const ver17 = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi = 27', ver17.rows[0]?.value === '27', `value=${ver17.rows[0]?.value}`);
  // Migrasi dedup: negara uji + 2 pemilu presiden terjadwal ganda (tanpa
  // indeks), lalu resetVersion + initDb → tersisa 1 (id terkecil) + indeks kembali.
  const c8 = await pool.query("INSERT INTO country (name) VALUES ('Negara Delapan') RETURNING id");
  const c8id = c8.rows[0].id;
  await pool.query('DROP INDEX IF EXISTS idx_elections_one_active');
  await pool.query("INSERT INTO elections (type, status, opens_at, closes_at, country_id, created_at) VALUES ('president','scheduled',1000000000000,1000000001000,$1,0)", [c8id]);
  await pool.query("INSERT INTO elections (type, status, opens_at, closes_at, country_id, created_at) VALUES ('president','scheduled',1000000000001,1000000001001,$1,0)", [c8id]);
  await pool.query("INSERT INTO elections (type, status, opens_at, closes_at, country_id, created_at) VALUES ('parliament','scheduled',1000000000002,1000000001002,$1,0)", [c8id]);
  const dupBefore = await pool.query("SELECT COUNT(*) AS n FROM elections WHERE country_id = $1 AND type = 'president' AND status = 'scheduled'", [c8id]);
  check('Sebelum migrasi: 2 pemilu presiden terjadwal ganda', Number(dupBefore.rows[0].n) === 2, `n=${dupBefore.rows[0].n}`);
  await resetVersion();
  await initDb();
  const dupAfter = await pool.query("SELECT id FROM elections WHERE country_id = $1 AND type = 'president' AND status IN ('scheduled','open') ORDER BY id", [c8id]);
  check('Migrasi dedup: tersisa 1 pemilu presiden (id terkecil)', dupAfter.rows.length === 1, `n=${dupAfter.rows.length}`);
  const idxEl2 = await pool.query("SELECT COUNT(*) AS n FROM pg_indexes WHERE indexname = 'idx_elections_one_active'");
  check('Migrasi: indeks unik dibuat kembali', Number(idxEl2.rows[0].n) === 1, `n=${idxEl2.rows[0].n}`);
  const ver17b = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi ulang = 27', ver17b.rows[0]?.value === '27', `value=${ver17b.rows[0]?.value}`);
  // Indeks menolak pemilu aktif kedua secara langsung (bukan hanya via migrasi).
  let dupElRejected = false;
  try {
    await pool.query("INSERT INTO elections (type, status, opens_at, closes_at, country_id, created_at) VALUES ('president','scheduled',1000000000003,1000000001003,$1,0)", [c8id]);
  } catch { dupElRejected = true; }
  check('UNIQUE: pemilu presiden aktif kedua ditolak di level database', dupElRejected);
  // Race ensureElections di Postgres sungguhan (12× paralel via skrip probe).
  const racePg = await new Promise((resolve) => {
    const p = spawn('node', ['test/race-ensure-elections.mjs'], { cwd: ROOT, env: { ...process.env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
  check('Race ensureElections 12× paralel di Postgres: tanpa pemilu ganda', racePg.code === 0, racePg.out.trim().slice(0, 200));
  // UNIQUE article_views: jejak baca ganda (warga+artikel+hari sama) ditolak.
  await pool.query("INSERT INTO users (id, email, username, pass_hash, created_at) VALUES (999017, 'delapan@test.local', 'warga_delapan', 'x', 0)");
  await pool.query("INSERT INTO citizens (id, user_id, region_id, home_region_id, created_at) VALUES (999017, 999017, 1, 1, 0)");
  await pool.query("INSERT INTO newspapers (id, owner_id, name, created_at) VALUES (999017, 999017, 'Koran Delapan', 0)");
  await pool.query("INSERT INTO articles (id, newspaper_id, author_id, title, content, created_at) VALUES (999017, 999017, 999017, 'Artikel Delapan', 'Isi artikel delapan yang cukup panjang.', 0)");
  await pool.query("INSERT INTO article_views (article_id, citizen_id, day) VALUES (999017, 999017, '2026-11-28')");
  let dupViewRejected = false;
  try {
    await pool.query("INSERT INTO article_views (article_id, citizen_id, day) VALUES (999017, 999017, '2026-11-28')");
  } catch { dupViewRejected = true; }
  check('UNIQUE: jejak baca ganda (artikel+warga+hari sama) ditolak', dupViewRejected);
  const viewOk = await pool.query("SELECT COUNT(*) AS n FROM article_views WHERE article_id = 999017");
  check('article_views: tepat 1 baris setelah percobaan duplikat', Number(viewOk.rows[0].n) === 1, `n=${viewOk.rows[0].n}`);
  await pool.query('DELETE FROM article_views WHERE article_id = 999017');
  await pool.query('DELETE FROM articles WHERE id = 999017');
  await pool.query('DELETE FROM newspapers WHERE id = 999017');
  await pool.query('DELETE FROM citizens WHERE id = 999017');
  await pool.query('DELETE FROM users WHERE id = 999017');
  console.log('\n[18] v4.3.4 — eksploitasi XP: bump versi tidak mengalikan XP + rollback');
  // (a) Dua kenaikan SCHEMA_VERSION berurutan pada DB berisi pemain ber-XP:
  // XP harus TETAP (regresi insiden 28 Nov 2026 — migrateXpScale dulu
  // mengalikan XP ×20 di setiap bump).
  await pool.query("INSERT INTO users (id, email, username, pass_hash, created_at) VALUES (999018, 'xp18a@test.local', 'warga_xp_a', 'x', 0)");
  await pool.query("INSERT INTO citizens (id, user_id, level, xp, energy, gold, usd, region_id, home_region_id, created_at) VALUES (999018, 999018, 3, 220, 100, 50, 500, 1, 1, 0)");
  await pool.query("INSERT INTO users (id, email, username, pass_hash, created_at) VALUES (999019, 'xp18b@test.local', 'warga_xp_b', 'x', 0)");
  await pool.query("INSERT INTO citizens (id, user_id, level, xp, energy, gold, usd, region_id, home_region_id, created_at) VALUES (999019, 999019, 5, 234, 100, 50, 500, 1, 1, 0)");
  await resetVersion();
  await initDb();
  let xpA = await pool.query('SELECT level, xp FROM citizens WHERE id = 999018');
  check('Bump versi #1: XP warga A (220) tidak berubah', Number(xpA.rows[0].xp) === 220 && Number(xpA.rows[0].level) === 3, `Lv${xpA.rows[0].level} ${xpA.rows[0].xp} XP`);
  let xpB = await pool.query('SELECT level, xp FROM citizens WHERE id = 999019');
  check('Bump versi #1: XP warga B (234) tidak berubah', Number(xpB.rows[0].xp) === 234 && Number(xpB.rows[0].level) === 5, `Lv${xpB.rows[0].level} ${xpB.rows[0].xp} XP`);
  await resetVersion();
  await initDb();
  xpA = await pool.query('SELECT level, xp FROM citizens WHERE id = 999018');
  check('Bump versi #2: XP warga A (220) tetap tidak berubah', Number(xpA.rows[0].xp) === 220 && Number(xpA.rows[0].level) === 3, `Lv${xpA.rows[0].level} ${xpA.rows[0].xp} XP`);
  xpB = await pool.query('SELECT level, xp FROM citizens WHERE id = 999019');
  check('Bump versi #2: XP warga B (234) tetap tidak berubah', Number(xpB.rows[0].xp) === 234 && Number(xpB.rows[0].level) === 5, `Lv${xpB.rows[0].level} ${xpB.rows[0].xp} XP`);
  const ver18 = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi = 27', ver18.rows[0]?.value === '27', `value=${ver18.rows[0]?.value}`);

  // (b) Rollback ujung-ke-ujung lewat rantai migrasi nyata: data terinflasi
  // -> resetVersion + initDb -> level/XP pulih; ulangi -> tidak berubah.
  await pool.query("DELETE FROM db_meta WHERE key = 'xp_rollback_2026_11_28'");
  const T0 = Date.parse('2026-11-28T01:00:00Z'); // 08:00 WIB 28 Nov 2026 — pagi kaskade
  // Vrix-verify: level 3, XP 1.760.000 (= 11 × 160.000), belum kaskade.
  await pool.query("INSERT INTO users (id, email, username, pass_hash, created_at) VALUES (999020, 'xp18c@test.local', 'vrix_verify', 'x', 0)");
  await pool.query("INSERT INTO citizens (id, user_id, level, xp, energy, gold, usd, region_id, home_region_id, created_at) VALUES (999020, 999020, 3, 1760000, 100, 50, 500, 1, 1, 0)");
  // Dieckmann-verify: kaskade dari (3, 220×8000+40) — hitung di JS.
  let dl = 3, dx = 220 * 8000 + 40;
  const gained = [];
  while (dx >= dl * 100) { dx -= dl * 100; dl += 1; gained.push(dl); }
  await pool.query("INSERT INTO users (id, email, username, pass_hash, created_at) VALUES (999021, 'xp18d@test.local', 'dieckmann_verify', 'x', 0)");
  await pool.query('INSERT INTO citizens (id, user_id, level, xp, energy, gold, usd, region_id, home_region_id, created_at) VALUES (999021, 999021, $1, $2, 100, 50, 500, 1, 1, 0)', [dl, dx]);
  for (const lv of gained) {
    await pool.query("INSERT INTO notifications (citizen_id, category, title, content, created_at) VALUES (999021, 'SISTEM', 'Naik Level!', $1, $2)", [`Selamat! Kamu mencapai Level ${lv}.`, T0]);
  }
  // Referral palsu: pengundang 999022 (emas 500, premium +2 hari),
  // pendaftar 999023 (level benar 2, emas 300, premium +1 hari).
  const nowMs = Date.now();
  await pool.query("INSERT INTO users (id, email, username, pass_hash, premium_until, created_at) VALUES (999022, 'xp18e@test.local', 'pengundang_verify', 'x', $1, 0)", [nowMs + 2 * 86400000 - 3600000]);
  await pool.query("INSERT INTO citizens (id, user_id, level, xp, energy, gold, usd, region_id, home_region_id, created_at) VALUES (999022, 999022, 5, 100, 100, 500, 500, 1, 1, 0)");
  let nl = 2, nx = 20 * 8000 + 40;
  const nGained = [];
  while (nx >= nl * 100) { nx -= nl * 100; nl += 1; nGained.push(nl); }
  await pool.query("INSERT INTO users (id, email, username, pass_hash, referred_by, premium_until, created_at) VALUES (999023, 'xp18f@test.local', 'pendaftar_verify', 'x', 999022, $1, 0)", [nowMs + 1 * 86400000 - 3600000]);
  await pool.query('INSERT INTO citizens (id, user_id, level, xp, energy, gold, usd, region_id, home_region_id, created_at) VALUES (999023, 999023, $1, $2, 100, 300, 500, 1, 1, 0)', [nl, nx]);
  for (const lv of nGained) {
    await pool.query("INSERT INTO notifications (citizen_id, category, title, content, created_at) VALUES (999023, 'SISTEM', 'Naik Level!', $1, $2)", [`Selamat! Kamu mencapai Level ${lv}.`, T0]);
  }
  await pool.query("INSERT INTO referral_pending (referrer_id, newcomer_id, status, created_at, paid_at, paid_day) VALUES (999022, 999023, 'paid', $1, $1, '2026-11-28')", [T0]);
  const premRefBefore = (await pool.query('SELECT premium_until FROM users WHERE id = 999022')).rows[0].premium_until;
  const premNewBefore = (await pool.query('SELECT premium_until FROM users WHERE id = 999023')).rows[0].premium_until;

  await resetVersion();
  await initDb();
  let v = await pool.query('SELECT level, xp FROM citizens WHERE id = 999020');
  check('Rollback (rantai nyata): Vrix Lv3, 1.760.000 XP -> Lv10, 220 XP', Number(v.rows[0].level) === 10 && Number(v.rows[0].xp) === 220, `Lv${v.rows[0].level} ${v.rows[0].xp} XP`);
  v = await pool.query('SELECT level, xp FROM citizens WHERE id = 999021');
  check('Rollback (rantai nyata): Dieckmann kaskade -> Lv10, 260 XP', Number(v.rows[0].level) === 10 && Number(v.rows[0].xp) === 260, `Lv${v.rows[0].level} ${v.rows[0].xp} XP`);
  v = await pool.query('SELECT level, xp, gold FROM citizens WHERE id = 999023');
  check('Rollback (rantai nyata): pendaftar Lv2 legit -> Lv10, 60 XP, emas tetap 300', Number(v.rows[0].level) === 10 && Number(v.rows[0].xp) === 60 && Number(v.rows[0].gold) === 300, `Lv${v.rows[0].level} ${v.rows[0].xp} XP emas=${v.rows[0].gold}`);
  v = await pool.query("SELECT status FROM referral_pending WHERE newcomer_id = 999023");
  check("Rollback (rantai nyata): payout referral TIDAK dibatalkan (tetap 'paid')", v.rows[0]?.status === 'paid', `status=${v.rows[0]?.status}`);
  v = await pool.query('SELECT premium_until FROM users WHERE id = 999022');
  check('Rollback (rantai nyata): premium pengundang tidak berubah', Number(v.rows[0].premium_until) === Number(premRefBefore), `premium_until=${v.rows[0].premium_until}`);
  v = await pool.query('SELECT premium_until FROM users WHERE id = 999023');
  check('Rollback (rantai nyata): premium pendaftar tidak berubah', Number(v.rows[0].premium_until) === Number(premNewBefore), `premium_until=${v.rows[0].premium_until}`);
  const marker18 = await pool.query("SELECT value FROM db_meta WHERE key = 'xp_rollback_2026_11_28'");
  check('Rollback (rantai nyata): penanda db_meta tertulis (3 diubah, 3 di Lv10)', marker18.rowCount === 1 && JSON.parse(marker18.rows[0].value).citizensChanged === 3 && JSON.parse(marker18.rows[0].value).flooredTo10 === 3, `changed=${marker18.rowCount ? JSON.parse(marker18.rows[0].value).citizensChanged : '?'} lantai10=${marker18.rowCount ? JSON.parse(marker18.rows[0].value).flooredTo10 : '?'}`);
  // Idempotensi lewat rantai nyata: resetVersion + initDb lagi.
  await resetVersion();
  await initDb();
  v = await pool.query('SELECT level, xp FROM citizens WHERE id = 999020');
  check('Idempotent (rantai nyata): Vrix tetap Lv10, 220 XP', Number(v.rows[0].level) === 10 && Number(v.rows[0].xp) === 220, `Lv${v.rows[0].level} ${v.rows[0].xp} XP`);
  v = await pool.query('SELECT level, xp FROM citizens WHERE id = 999021');
  check('Idempotent (rantai nyata): Dieckmann tetap Lv10, 260 XP', Number(v.rows[0].level) === 10 && Number(v.rows[0].xp) === 260, `Lv${v.rows[0].level} ${v.rows[0].xp} XP`);
  // Bersih-bersih.
  await pool.query('DELETE FROM notifications WHERE citizen_id IN (999018, 999019, 999020, 999021, 999022, 999023)');
  await pool.query('DELETE FROM referral_pending WHERE newcomer_id = 999023');
  await pool.query('DELETE FROM citizens WHERE id IN (999018, 999019, 999020, 999021, 999022, 999023)');
  await pool.query('DELETE FROM users WHERE id IN (999018, 999019, 999020, 999021, 999022, 999023)');

  console.log('\n[19] v4.4.0 — iklan berhadiah AdinPlay: tabel ad_tokens + ad_rewards');
  const tokTbl = await pool.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'ad_tokens'");
  check('Tabel ad_tokens ada', Number(tokTbl.rows[0].n) === 1, `n=${tokTbl.rows[0].n}`);
  const rwTbl = await pool.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'ad_rewards'");
  check('Tabel ad_rewards ada', Number(rwTbl.rows[0].n) === 1, `n=${rwTbl.rows[0].n}`);
  const ver19 = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi = 27', ver19.rows[0]?.value === '27', `value=${ver19.rows[0].value}`);
  // Kolom + FK: token milik warga uji, hadiah tercatat, token terpakai.
  await pool.query("INSERT INTO users (id, email, username, pass_hash, created_at) VALUES (999024, 'ads19@test.local', 'warga_ads', 'x', 0)");
  await pool.query("INSERT INTO citizens (id, user_id, level, xp, energy, gold, usd, region_id, home_region_id, created_at) VALUES (999024, 999024, 1, 0, 100, 50, 500, 1, 1, 0)");
  await pool.query("INSERT INTO ad_tokens (token, citizen_id, expires_at, used_at) VALUES ('tok19', 999024, $1, NULL)", [Date.now() + 300000]);
  const tokRow = await pool.query("SELECT * FROM ad_tokens WHERE token = 'tok19'");
  check('Baris ad_tokens tersimpan (token + warga + masa berlaku)', tokRow.rowCount === 1 && Number(tokRow.rows[0].citizen_id) === 999024, `rows=${tokRow.rowCount}`);
  await pool.query("UPDATE ad_tokens SET used_at = $1 WHERE token = 'tok19'", [Date.now()]);
  await pool.query("INSERT INTO ad_rewards (citizen_id, gold, granted_at) VALUES (999024, 30, $1)", [Date.now()]);
  const rwRow = await pool.query('SELECT * FROM ad_rewards WHERE citizen_id = 999024');
  check('Baris ad_rewards tersimpan (warga + 30 emas + waktu)', rwRow.rowCount === 1 && Number(rwRow.rows[0].gold) === 30, `rows=${rwRow.rowCount}`);
  // FK: token untuk warga yang tidak ada ditolak.
  let fkRejected = false;
  try { await pool.query("INSERT INTO ad_tokens (token, citizen_id, expires_at, used_at) VALUES ('tok19x', 999999, 0, NULL)"); } catch { fkRejected = true; }
  check('FK ad_tokens.citizen_id menolak warga yang tidak ada', fkRejected);
  let fkRwRejected = false;
  try { await pool.query("INSERT INTO ad_rewards (citizen_id, gold, granted_at) VALUES (999999, 30, 0)"); } catch { fkRwRejected = true; }
  check('FK ad_rewards.citizen_id menolak warga yang tidak ada', fkRwRejected);
  await pool.query("DELETE FROM ad_tokens WHERE token IN ('tok19', 'tok19x')");
  await pool.query('DELETE FROM ad_rewards WHERE citizen_id = 999024');
  await pool.query('DELETE FROM citizens WHERE id = 999024');
  await pool.query('DELETE FROM users WHERE id = 999024');

  console.log('\n[20] v4.5.0 — kerja otomatis Premium 24 jam: kolom auto_work_*');
  const awCols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'citizens' AND column_name LIKE 'auto_work_%'");
  const awNames = awCols.rows.map((r) => r.column_name).sort();
  check('Kolom auto_work_* ada di citizens (5 kolom)', JSON.stringify(awNames) === JSON.stringify(['auto_work_last_at', 'auto_work_paused', 'auto_work_shifts', 'auto_work_started_at', 'auto_work_until']), awNames.join(','));
  const ver20 = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi = 27', ver20.rows[0]?.value === '27', `value=${ver20.rows[0].value}`);
  // Nilai default 0 + tulis/baca status auto-work.
  await pool.query("INSERT INTO users (id, email, username, pass_hash, created_at) VALUES (999025, 'aw20@test.local', 'warga_aw', 'x', 0)");
  await pool.query("INSERT INTO citizens (id, user_id, level, xp, energy, gold, usd, region_id, home_region_id, created_at) VALUES (999025, 999025, 1, 0, 100, 50, 500, 1, 1, 0)");
  const awDef = await pool.query('SELECT auto_work_until, auto_work_shifts, auto_work_paused FROM citizens WHERE id = 999025');
  check('Default auto-work mati (until=0, shifts=0, paused=0)', Number(awDef.rows[0].auto_work_until) === 0 && Number(awDef.rows[0].auto_work_shifts) === 0 && Number(awDef.rows[0].auto_work_paused) === 0, JSON.stringify(awDef.rows[0]));
  await pool.query('UPDATE citizens SET auto_work_until = $1, auto_work_started_at = $1, auto_work_shifts = 3, auto_work_paused = 1, auto_work_last_at = $1 WHERE id = 999025', [Date.now()]);
  const awSet = await pool.query('SELECT auto_work_shifts, auto_work_paused FROM citizens WHERE id = 999025');
  check('Status auto-work tersimpan (shifts=3, paused=1)', Number(awSet.rows[0].auto_work_shifts) === 3 && Number(awSet.rows[0].auto_work_paused) === 1, JSON.stringify(awSet.rows[0]));
  await pool.query('DELETE FROM citizens WHERE id = 999025');
  await pool.query('DELETE FROM users WHERE id = 999025');

  console.log('\n[21] v4.6.0 — share link harian + stok perusahaan: kolom/tabel baru');
  const scCol = await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_name = 'citizens' AND column_name = 'share_code'");
  check('Kolom citizens.share_code ada', Number(scCol.rows[0].n) === 1, `n=${scCol.rows[0].n}`);
  const csTbl = await pool.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'company_stock'");
  check('Tabel company_stock ada', Number(csTbl.rows[0].n) === 1, `n=${csTbl.rows[0].n}`);
  const shTbl = await pool.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'share_clicks'");
  check('Tabel share_clicks ada', Number(shTbl.rows[0].n) === 1, `n=${shTbl.rows[0].n}`);
  const ver21 = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi = 27', ver21.rows[0]?.value === '27', `value=${ver21.rows[0].value}`);
  // share_code unik (kode yang sama ditolak) — NULL tetap boleh ganda.
  await pool.query("INSERT INTO users (id, email, username, pass_hash, created_at) VALUES (999026, 'sh21@test.local', 'warga_sh', 'x', 0)");
  await pool.query("INSERT INTO citizens (id, user_id, level, xp, energy, gold, usd, region_id, home_region_id, created_at) VALUES (999026, 999026, 1, 0, 100, 50, 500, 1, 1, 0)");
  await pool.query("UPDATE citizens SET share_code = 'abc123def4' WHERE id = 999026");
  let dupCodeRejected = false;
  try {
    await pool.query("INSERT INTO users (id, email, username, pass_hash, created_at) VALUES (999027, 'sh21b@test.local', 'warga_sh2', 'x', 0)");
    await pool.query("INSERT INTO citizens (id, user_id, level, xp, energy, gold, usd, region_id, home_region_id, share_code, created_at) VALUES (999027, 999027, 1, 0, 100, 50, 500, 1, 1, 'abc123def4', 0)");
  } catch { dupCodeRejected = true; }
  check('share_code unik: kode yang sama ditolak', dupCodeRejected);
  // share_clicks: 1 IP = 1 klik/hari/link (UNIQUE owner+ip+day) + FK owner.
  await pool.query("INSERT INTO share_clicks (owner_id, ip, day, gold_given, created_at) VALUES (999026, '1.2.3.4', '2026-11-28', 10, 0)");
  let dupClickRejected = false;
  try { await pool.query("INSERT INTO share_clicks (owner_id, ip, day, gold_given, created_at) VALUES (999026, '1.2.3.4', '2026-11-28', 10, 0)"); } catch { dupClickRejected = true; }
  check('UNIQUE share_clicks(owner_id, ip, day): klik kedua IP yang sama di hari yang sama ditolak', dupClickRejected);
  let fkClickRejected = false;
  try { await pool.query("INSERT INTO share_clicks (owner_id, ip, day, gold_given, created_at) VALUES (999999, '1.2.3.4', '2026-11-28', 10, 0)"); } catch { fkClickRejected = true; }
  check('FK share_clicks.owner_id menolak warga yang tidak ada', fkClickRejected);
  // company_stock: satu baris per (perusahaan, komoditas) + FK.
  const com21 = await pool.query('SELECT id FROM commodities ORDER BY id LIMIT 1');
  const com21Id = Number(com21.rows[0].id);
  await pool.query("INSERT INTO companies (id, owner_id, name, type, region_id, created_at) VALUES (999026, 999026, 'Pabrik Tes 21', 'factory', 1, 0)");
  await pool.query('INSERT INTO company_stock (company_id, commodity_id, qty) VALUES (999026, $1, 25)', [com21Id]);
  let dupStockRejected = false;
  try { await pool.query('INSERT INTO company_stock (company_id, commodity_id, qty) VALUES (999026, $1, 5)', [com21Id]); } catch { dupStockRejected = true; }
  check('UNIQUE company_stock(company_id, commodity_id): baris kedua komoditas yang sama ditolak', dupStockRejected);
  const stockRow = await pool.query('SELECT qty FROM company_stock WHERE company_id = 999026 AND commodity_id = $1', [com21Id]);
  check('Baris company_stock tersimpan (qty 25)', Number(stockRow.rows[0]?.qty) === 25, `qty=${stockRow.rows[0]?.qty}`);
  await pool.query('DELETE FROM company_stock WHERE company_id = 999026');
  await pool.query('DELETE FROM companies WHERE id = 999026');
  await pool.query('DELETE FROM share_clicks WHERE owner_id = 999026');
  await pool.query('DELETE FROM citizens WHERE id IN (999026, 999027)');
  await pool.query('DELETE FROM users WHERE id IN (999026, 999027)');

  console.log('\n[22] v4.6.1 — REGRESI insiden 28 Nov 2026: initDb di skema lama (tanpa share_code) TIDAK crash');
  // Kondisi DB live saat v4.6.0 deploy (skema 20): kolom share_code belum
  // ada, tabel share belum ada, penanda versi 20. v4.6.0 crash-loop dengan
  // Postgres 42703 `column "share_code" does not exist` karena
  // CREATE UNIQUE INDEX idx_share_code di schema() jalan SEBELUM
  // migrateShareColumns menambah kolomnya (schema() dieksekusi duluan di
  // dalam transaksi migrasi). Tes-tes sebelumnya lolos karena memakai DB
  // segar — di sana CREATE TABLE citizens sudah berisi share_code.
  // Regresi ini MEMAKSA kondisi skema lama dulu, baru menjalankan initDb.
  await pool.query('DROP INDEX IF EXISTS idx_share_code');
  await pool.query('ALTER TABLE citizens DROP COLUMN IF EXISTS share_code');
  await pool.query('DROP TABLE IF EXISTS company_stock');
  await pool.query('DROP TABLE IF EXISTS share_clicks');
  await pool.query("UPDATE db_meta SET value = '20' WHERE key = 'schema_version'");
  await pool.query("INSERT INTO users (id, email, username, pass_hash, created_at) VALUES (999028, 'sh22@test.local', 'warga_sh22', 'x', 0)");
  await pool.query("INSERT INTO citizens (id, user_id, level, xp, energy, gold, usd, region_id, home_region_id, created_at) VALUES (999028, 999028, 1, 0, 100, 50, 500, 1, 1, 0)");
  const scBefore = await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_name = 'citizens' AND column_name = 'share_code'");
  check('Sebelum migrasi: kolom share_code TIDAK ada (kondisi live v4.6.0)', Number(scBefore.rows[0].n) === 0, `n=${scBefore.rows[0].n}`);
  const verBefore = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Sebelum migrasi: penanda versi = 20 (skema lama)', verBefore.rows[0]?.value === '20', `value=${verBefore.rows[0]?.value}`);
  let initCrashed = null;
  try { await initDb(); } catch (e) { initCrashed = e; }
  check('initDb di skema lama TIDAK crash (regresi 42703)', initCrashed === null, initCrashed ? String(initCrashed.message || initCrashed).slice(0, 200) : '');
  const scAfter = await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_name = 'citizens' AND column_name = 'share_code'");
  check('Setelah migrasi: kolom share_code ada', Number(scAfter.rows[0].n) === 1, `n=${scAfter.rows[0].n}`);
  const idx22 = await pool.query("SELECT COUNT(*) AS n FROM pg_indexes WHERE indexname = 'idx_share_code'");
  check('Setelah migrasi: indeks unik idx_share_code ada', Number(idx22.rows[0].n) === 1, `n=${idx22.rows[0].n}`);
  const cs22 = await pool.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'company_stock'");
  check('Setelah migrasi: tabel company_stock ada', Number(cs22.rows[0].n) === 1, `n=${cs22.rows[0].n}`);
  const sh22 = await pool.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'share_clicks'");
  check('Setelah migrasi: tabel share_clicks ada', Number(sh22.rows[0].n) === 1, `n=${sh22.rows[0].n}`);
  const ver22 = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi = 27', ver22.rows[0]?.value === '27', `value=${ver22.rows[0].value}`);
  // Warga legacy selamat + initDb kedua (steady state) tetap jalan.
  const w22 = await pool.query('SELECT level, xp FROM citizens WHERE id = 999028');
  check('Warga legacy selamat dari migrasi (Lv1, 0 XP)', w22.rowCount === 1 && Number(w22.rows[0].level) === 1 && Number(w22.rows[0].xp) === 0, JSON.stringify(w22.rows[0] || {}));
  await initDb();
  const ver22b = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('initDb ulang: versi tetap 24', ver22b.rows[0]?.value === '27', `value=${ver22b.rows[0].value}`);
  await pool.query('DELETE FROM citizens WHERE id = 999028');
  await pool.query('DELETE FROM users WHERE id = 999028');

  console.log('\n[23] v5.0.0 — ROLLBACK exploit gaji: clawback + clamp dari data live (threshold $100rb)');
  // Skenario live 28 Nov 2026, 11:42–11:47 WIB (angka snapshot, migrasi
  // menghitung ulang dari tabel — TIDAK hardcode): hanya 2 warga di atas
  // $1 jt USD — LIO $2,15e28 dan kenzz $8,25e30 (keduanya usd ==
  // total_salary persis: seluruh USD dari gaji cetak). Batas sah teoretis
  // 2 hari game ≈ $56rb (28 shift/hari × $1000 × 2 hari) → flag $100rb.
  // Emas mereka kecil (LIO 215, kenzz ~0) → emas TIDAK disentuh.
  await pool.query(`INSERT INTO users (id, email, username, pass_hash, created_at) VALUES
    (999030, 'w23_owner@test.local', 'w23_owner', 'x', 0),
    (999031, 'w23_lio@test.local', 'w23_lio', 'x', 0),
    (999032, 'w23_kenzz@test.local', 'w23_kenzz', 'x', 0),
    (999033, 'w23_yawn@test.local', 'w23_yawn', 'x', 0),
    (999034, 'w23_spent@test.local', 'w23_spent', 'x', 0),
    (999035, 'w23_rich@test.local', 'w23_rich', 'x', 0)`);
  await pool.query(`INSERT INTO citizens (id, user_id, level, xp, energy, gold, usd, total_salary, region_id, home_region_id, created_at) VALUES
    (999030, 999030, 5, 0, 100, 0, 1e12, 1e12, 2, 2, 0),
    (999031, 999031, 5, 0, 100, 215.77, 2.1473247e28, 2.1473247e28, 2, 2, 0),
    (999032, 999032, 5, 0, 100, 0, 8.251366e30, 8.251366e30, 2, 2, 0),
    (999033, 999033, 5, 0, 100, 0, 6014, 5464, 2, 2, 0),
    (999034, 999034, 5, 0, 100, 0, 500, 5e15, 2, 2, 0),
    (999035, 999035, 5, 0, 100, 0, 5000, 0, 2, 2, 0)`);
  await pool.query(`INSERT INTO companies (id, owner_id, name, about, type, region_id, resource, created_at) VALUES
    (999040, 999030, 'PT.Makmur TBK', '', 'resource', 2, 'Besi Mentah', 0),
    (999041, 999035, 'PT Kaya', '', 'resource', 2, 'Besi Mentah', 0)`);
  await pool.query(`INSERT INTO jobs (id, company_id, is_admin, title, salary, salary_type, resource, pay_qty, level_min, tier, seats, seats_taken, region_id, description, created_at) VALUES
    (999042, 999040, 0, 'PT.Makmur TBK', 5.464481e27, 'fixed', '', 0, 1, 1, 4, 0, 2, 'uji rollback', 0),
    (999043, 999040, 0, 'PT.Linting TBK', 5.464481e22, 'fixed', '', 0, 1, 1, 4, 0, 2, 'uji rollback', 0),
    (999044, 999040, 0, 'Operator Wajar', 100, 'fixed', '', 0, 1, 1, 4, 0, 2, 'uji rollback', 0),
    (999045, 999041, 0, 'Operator Kaya', 3000, 'fixed', '', 0, 1, 1, 4, 0, 2, 'uji rollback', 0),
    (999046, NULL, 1, 'Pekerja Gudang Pelabuhan', 48, 'goods', 'Besi Mentah', 44, 1, 1, 0, 0, 2, 'ADMIN', 0)`);
  await pool.query('UPDATE citizens SET job_id = 999042 WHERE id = 999031');
  await pool.query('UPDATE citizens SET job_id = 999042 WHERE id = 999032');
  // Paksa migrasi penuh skema 23: hapus penanda wage-rollback + turunkan versi.
  await pool.query("DELETE FROM db_meta WHERE key = 'wage_rollback_2026_11_28'");
  await pool.query("UPDATE db_meta SET value = '22' WHERE key = 'schema_version'");
  let rbCrashed = null;
  try { await initDb(); } catch (e) { rbCrashed = e; }
  check('initDb dengan DB tereksploitasi TIDAK crash', rbCrashed === null, rbCrashed ? String(rbCrashed.message || rbCrashed).slice(0, 200) : '');
  const qCit = async (id) => (await pool.query('SELECT usd, total_salary, gold FROM citizens WHERE id = $1', [id])).rows[0];
  const lio23 = await qCit(999031);
  check('Clawback LIO: usd 2,15e28 → 100.000 (batas sah)', Math.abs(Number(lio23.usd) - 100000) < 0.01, `usd=${lio23.usd}`);
  check('Clawback LIO: total_salary dikoreksi ke 100.000', Math.abs(Number(lio23.total_salary) - 100000) < 0.01, `total_salary=${lio23.total_salary}`);
  check('Clawback LIO: emas TIDAK disentuh (215,77)', Math.abs(Number(lio23.gold) - 215.77) < 0.01, `gold=${lio23.gold}`);
  const kz23 = await qCit(999032);
  check('Clawback kenzz: usd 8,25e30 → 100.000', Math.abs(Number(kz23.usd) - 100000) < 0.01, `usd=${kz23.usd}`);
  check('Clawback kenzz: total_salary dikoreksi ke 100.000', Math.abs(Number(kz23.total_salary) - 100000) < 0.01, `total_salary=${kz23.total_salary}`);
  const sp23 = await qCit(999034);
  check('Clawback sudah-dibelanjakan: usd 500 → 0 (clamp, tidak negatif)', Math.abs(Number(sp23.usd)) < 0.01, `usd=${sp23.usd}`);
  check('Clawback sudah-dibelanjakan: total_salary tetap dikoreksi ke 100.000', Math.abs(Number(sp23.total_salary) - 100000) < 0.01, `total_salary=${sp23.total_salary}`);
  const ow23 = await qCit(999030);
  check('Clawback pemilik-eksploiter: usd 1e12 → 100.000', Math.abs(Number(ow23.usd) - 100000) < 0.01, `usd=${ow23.usd}`);
  const yw23 = await qCit(999033);
  check('Pekerja sah (total_salary 5464) TIDAK disentuh', Math.abs(Number(yw23.usd) - 6014) < 0.01 && Math.abs(Number(yw23.total_salary) - 5464) < 0.01, `usd=${yw23.usd} total_salary=${yw23.total_salary}`);
  const rc23 = await qCit(999035);
  check('Pemilik kaya normal (usd 5000) TIDAK disentuh', Math.abs(Number(rc23.usd) - 5000) < 0.01, `usd=${rc23.usd}`);
  const qJob = async (id) => Number((await pool.query('SELECT salary FROM jobs WHERE id = $1', [id])).rows[0].salary);
  check('Clamp PT.Makmur TBK: gaji 5,46e27 → 100.000 (saldo pemilik SETELAH clawback — urutan benar)', Math.abs(await qJob(999042) - 100000) < 0.01, `salary=${await qJob(999042)}`);
  check('Clamp PT.Linting TBK: gaji 5,46e22 → 100.000', Math.abs(await qJob(999043) - 100000) < 0.01, `salary=${await qJob(999043)}`);
  check('Lowongan wajar (100 ≤ saldo) TIDAK di-clamp', Math.abs(await qJob(999044) - 100) < 0.01, `salary=${await qJob(999044)}`);
  check('Lowongan pemilik kaya (3000 ≤ 5000) TIDAK di-clamp', Math.abs(await qJob(999045) - 3000) < 0.01, `salary=${await qJob(999045)}`);
  check('Lowongan ADMIN TIDAK di-clamp', Math.abs(await qJob(999046) - 48) < 0.01, `salary=${await qJob(999046)}`);
  const mk23 = await pool.query("SELECT value FROM db_meta WHERE key = 'wage_rollback_2026_11_28'");
  let sum23 = null;
  try { sum23 = JSON.parse(mk23.rows[0]?.value || 'null'); } catch {}
  check('Penanda migrasi wage-rollback tersimpan + ringkasan JSON', !!sum23 && typeof sum23 === 'object', `marker=${mk23.rowCount}`);
  check('Ringkasan: 4 warga di-clawback (pemilik + LIO + kenzz + sudah-dibelanjakan)', sum23?.citizensClawedBack >= 4 && (sum23?.clawedBack || []).some((x) => x.citizen === 'w23_lio') && (sum23?.clawedBack || []).some((x) => x.citizen === 'w23_kenzz'), `citizensClawedBack=${sum23?.citizensClawedBack}`);
  check('Ringkasan: sudah-dibelanjakan tercatat tak-terpulihkan (> 4e15)', (sum23?.clawedBack || []).some((x) => x.citizen === 'w23_spent' && x.unrecovered > 4e15), JSON.stringify((sum23?.clawedBack || []).find((x) => x.citizen === 'w23_spent')));
  check('Ringkasan: ≥2 lowongan di-clamp (Makmur + Linting)', sum23?.jobsClamped >= 2 && (sum23?.clamped || []).some((x) => x.job === 'PT.Makmur TBK'), `jobsClamped=${sum23?.jobsClamped}`);
  const ntf23 = await pool.query("SELECT COUNT(*) AS n FROM notifications WHERE citizen_id = 999031 AND title = 'Koreksi Saldo (Bug Gaji)'");
  check('Notifikasi SYSTEM ke LIO (1× Koreksi Saldo)', Number(ntf23.rows[0].n) === 1, `n=${ntf23.rows[0].n}`);
  const ntf23b = await pool.query("SELECT COUNT(*) AS n FROM notifications WHERE citizen_id = 999030 AND title = 'Upah lowongan dikoreksi (aturan gaji baru)'");
  check('Notifikasi SYSTEM ke pemilik per lowongan di-clamp (2×)', Number(ntf23b.rows[0].n) === 2, `n=${ntf23b.rows[0].n}`);
  // Idempotent: migrasi ulang (penanda masih ada) tidak menarik dua kali.
  await resetVersion();
  await initDb();
  const lio23b = await qCit(999031);
  check('Idempotent: LIO tetap 100.000 setelah initDb ulang', Math.abs(Number(lio23b.usd) - 100000) < 0.01 && Math.abs(Number(lio23b.total_salary) - 100000) < 0.01, `usd=${lio23b.usd}`);
  check('Idempotent: gaji Makmur tetap 100.000 setelah initDb ulang', Math.abs(await qJob(999042) - 100000) < 0.01, `salary=${await qJob(999042)}`);
  const ver23 = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi = 27', ver23.rows[0]?.value === '27', `value=${ver23.rows[0]?.value}`);
  await pool.query('DELETE FROM jobs WHERE id IN (999042, 999043, 999044, 999045, 999046)');
  await pool.query('DELETE FROM companies WHERE id IN (999040, 999041)');
  await pool.query('DELETE FROM notifications WHERE citizen_id IN (999030, 999031, 999032, 999033, 999034, 999035)');
  await pool.query('DELETE FROM citizens WHERE id IN (999030, 999031, 999032, 999033, 999034, 999035)');
  await pool.query('DELETE FROM users WHERE id IN (999030, 999031, 999032, 999033, 999034, 999035)');

  console.log('\n[24] v5.0.0 — REGRESI 42P18: GET /api/share di Postgres sungguhan (bukan SQLite)');
  // Bug live 28 Nov 2026, 11:27–11:34 WIB: GET /api/share 500 di setiap
  // request — Postgres 42P18 `could not determine data type of parameter
  // $2` di shareStatsFor (`? IS NULL OR day = ?` dengan day=NULL untuk
  // statistik TOTAL). Tes e2e lolos karena jalan di SQLite (dinamis, tak
  // peduli tipe param). Regresi ini memanggil endpoint HTTP sungguhan
  // melawan Postgres — termasuk pemanggilan total (day NULL).
  const S_PORT = 3467;
  const S_BASE = `http://127.0.0.1:${S_PORT}`;
  const sServer = spawn('node', ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(S_PORT), DATABASE_URL, JWT_SECRET: 'pg-verify-share-secret', ADMIN_BOOTSTRAP_CODE: 'pg-verify-bootstrap' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let sServerLog = '';
  sServer.stdout.on('data', (d) => { sServerLog += d; });
  sServer.stderr.on('data', (d) => { sServerLog += d; });
  const sStop = () => { try { sServer.kill('SIGTERM'); } catch {} };
  process.on('exit', sStop);
  let sUp = false;
  for (let i = 0; i < 40 && !sUp; i++) {
    await sleep(500);
    try { const rr = await fetch(S_BASE + '/api/world'); sUp = rr.ok; } catch {}
  }
  check('Server tes menyala (Postgres)', sUp);
  if (sUp) {
    class SClient {
      constructor() { this.cookie = ''; }
      async req(method, p, body) {
        const res = await fetch(S_BASE + p, {
          method,
          headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        const setCookie = res.headers.get('set-cookie');
        if (setCookie) this.cookie = setCookie.split(';')[0];
        let data = null;
        try { data = await res.json(); } catch { data = {}; }
        return { status: res.status, data };
      }
      get(p) { return this.req('GET', p); }
      post(p, b) { return this.req('POST', p, b || {}); }
    }
    const S1 = new SClient();
    let rr = await S1.post('/api/auth/register', { email: 'share@pgverify.local', password: 'rahasia123', username: 'share_pgverify' });
    check('S1 mendaftar', rr.status === 200, `status=${rr.status}`);
    const s1me = await S1.get('/api/me');
    const s1Id = s1me.data.citizen.id;
    const s1GoldBefore = s1me.data.citizen.gold;
    rr = await S1.get('/api/share');
    check('GET /api/share di Postgres: 200 + kode 10 karakter (bukan 500 42P18)', rr.status === 200 && /^[a-hj-km-np-z2-9]{10}$/.test(rr.data.code || ''), `status=${rr.status} code=${rr.data.code} ${rr.data.error || ''}`);
    const shareCode24 = rr.data.code;
    check('GET /api/share: statistik total ada (panggilan day NULL)', rr.data.total && typeof rr.data.total.clicks === 'number', JSON.stringify(rr.data.total));
    rr = await S1.get('/api/share');
    check('GET /api/share kedua: 200, kode SAMA (idempotent)', rr.status === 200 && rr.data.code === shareCode24, `status=${rr.status} code=${rr.data.code}`);
    const click24 = await fetch(S_BASE + '/s/' + shareCode24, { headers: { 'X-Forwarded-For': '203.0.113.77' }, redirect: 'manual' });
    check('Klik publik /s/:code: redirect (bukan 500)', click24.status >= 300 && click24.status < 400, `status=${click24.status}`);
    const goldAfterClick = (await S1.get('/api/me')).data.citizen.gold;
    check('Klik publik: pemilik +10 emas', goldAfterClick === s1GoldBefore + 10, `gold=${goldAfterClick} (sebelum ${s1GoldBefore})`);
    rr = await S1.get('/api/share');
    check('Statistik setelah klik: 1 klik, 10 emas hari ini', rr.status === 200 && rr.data.today?.clicks === 1 && rr.data.today?.gold === 10, JSON.stringify(rr.data.today));
    const click24b = await fetch(S_BASE + '/s/' + shareCode24, { headers: { 'X-Forwarded-For': '203.0.113.77' }, redirect: 'manual' });
    check('Klik kedua IP yang sama: redirect, tanpa emas tambahan', click24b.status >= 300 && click24b.status < 400 && (await S1.get('/api/me')).data.citizen.gold === s1GoldBefore + 10, `status=${click24b.status}`);
    const bad24 = await fetch(S_BASE + '/s/kode-salah-123', { redirect: 'manual' });
    check('Kode share salah → 404', bad24.status === 404, `status=${bad24.status}`);
    check('Log server: TIDAK ada error 42P18 untuk /api/share', !/42P18/.test(sServerLog), sServerLog.slice(0, 200));
    await pool.query('DELETE FROM share_clicks WHERE owner_id = $1', [s1Id]);
    await pool.query('DELETE FROM inventory WHERE citizen_id = $1', [s1Id]);
    await pool.query('DELETE FROM notifications WHERE citizen_id = $1', [s1Id]);
    await pool.query('DELETE FROM citizens WHERE id = $1', [s1Id]);
    await pool.query("DELETE FROM users WHERE email = 'share@pgverify.local'");
    sStop();
  } else {
    console.log(sServerLog);
    sStop();
  }

  console.log('\n[25] v5.0.1 — DEDUP lowongan: 9 lowongan identik kenzz jadi 1, yang dipegang selamat');
  // Skenario live 28 Nov 2026 (laporan Vincent): kenzz membuka 9 lowongan
  // "Kerja" identik; rollback v5.0.0 men-clamp kesembilan-nya ke $100.000.
  // Migrasi job-dedup HARUS jalan SETELAH wage-rollback (gaji baru identik
  // setelah di-clamp) dan HANYA menghapus baris yang kursinya kosong DAN
  // tidak sedang dipegang warga (job 57 live milik kenzz sendiri).
  await pool.query(`INSERT INTO users (id, email, username, pass_hash, created_at) VALUES
    (999050, 'w25_owner@test.local', 'w25_owner', 'x', 0),
    (999051, 'w25_holder@test.local', 'w25_holder', 'x', 0)`);
  await pool.query(`INSERT INTO citizens (id, user_id, level, xp, energy, gold, usd, total_salary, region_id, home_region_id, created_at) VALUES
    (999050, 999050, 5, 0, 100, 0, 5000, 0, 2, 2, 0),
    (999051, 999051, 5, 0, 100, 0, 0, 0, 2, 2, 0)`);
  await pool.query(`INSERT INTO companies (id, owner_id, name, about, type, region_id, resource, created_at) VALUES
    (999060, 999050, 'PT Dedup', '', 'resource', 2, 'Besi Mentah', 0)`);
  await pool.query(`INSERT INTO jobs (id, company_id, is_admin, title, salary, salary_type, resource, pay_qty, level_min, tier, seats, seats_taken, region_id, description, created_at) VALUES
    (999061, 999060, 0, 'Kerja', 100000, 'fixed', '', 0, 1, 1, 4, 1, 2, 'uji dedup', 0),
    (999062, 999060, 0, 'Kerja', 100000, 'fixed', '', 0, 1, 1, 4, 0, 2, 'uji dedup', 0),
    (999063, 999060, 0, 'Kerja', 100000, 'fixed', '', 0, 1, 1, 4, 0, 2, 'uji dedup', 0),
    (999064, 999060, 0, 'Kerja', 100000, 'fixed', '', 0, 1, 1, 4, 0, 2, 'uji dedup', 0),
    (999065, 999060, 0, 'Kerja', 100000, 'fixed', '', 0, 1, 1, 4, 0, 2, 'uji dedup', 0),
    (999066, 999060, 0, 'Kerja', 100000, 'fixed', '', 0, 1, 1, 4, 0, 2, 'uji dedup', 0),
    (999067, 999060, 0, 'Kerja', 100000, 'fixed', '', 0, 1, 1, 4, 0, 2, 'uji dedup', 0),
    (999068, 999060, 0, 'Kerja', 100000, 'fixed', '', 0, 1, 1, 4, 0, 2, 'uji dedup', 0),
    (999069, 999060, 0, 'Kerja', 100000, 'fixed', '', 0, 1, 1, 4, 0, 2, 'uji dedup', 0),
    (999071, 999060, 0, 'Kerja', 500, 'fixed', '', 0, 1, 1, 4, 2, 2, 'uji dedup', 0),
    (999072, 999060, 0, 'Kerja', 500, 'fixed', '', 0, 1, 1, 4, 0, 2, 'uji dedup', 0),
    (999073, 999060, 0, 'Satpam', 100, 'fixed', '', 0, 1, 1, 4, 0, 2, 'uji dedup', 0),
    (999074, NULL, 1, 'Kerja', 100000, 'goods', 'Besi Mentah', 44, 1, 1, 0, 0, 2, 'ADMIN', 0)`);
  // Lowongan 999061 sedang dipegang warga (analog job 57 kenzz di live).
  await pool.query('UPDATE citizens SET job_id = 999061 WHERE id = 999051');
  // Paksa migrasi penuh skema 24: hapus penanda dedup + turunkan versi.
  await pool.query("DELETE FROM db_meta WHERE key = 'job_dedup_2026_11_28'");
  await pool.query("UPDATE db_meta SET value = '23' WHERE key = 'schema_version'");
  await initDb();
  const g1 = await pool.query("SELECT id FROM jobs WHERE company_id = 999060 AND title = 'Kerja' AND salary = 100000 ORDER BY id");
  check('Dedup: 9 lowongan identik $100.000 jadi 1', g1.rows.length === 1, `tersisa=${g1.rows.length}`);
  check('Dedup: yang tersisa adalah yang sedang dipegang warga (999061)', g1.rows[0]?.id === 999061, `id=${g1.rows[0]?.id}`);
  const holder25 = await pool.query('SELECT job_id FROM citizens WHERE id = 999051');
  check('Dedup: pemegang TIDAK kehilangan pekerjaannya (job_id tetap 999061)', Number(holder25.rows[0]?.job_id) === 999061, `job_id=${holder25.rows[0]?.job_id}`);
  const g2 = await pool.query("SELECT id, seats_taken FROM jobs WHERE company_id = 999060 AND title = 'Kerja' AND salary = 500 ORDER BY id");
  check('Dedup: grup kedua (kursi terisi) tersisa 1 — yang kursinya terisi (999071)', g2.rows.length === 1 && g2.rows[0]?.id === 999071, `tersisa=${JSON.stringify(g2.rows)}`);
  const ctrl25 = await pool.query('SELECT COUNT(*) AS n FROM jobs WHERE id IN (999073, 999074)');
  check('Dedup: lowongan unik + lowongan ADMIN tidak tersentuh', Number(ctrl25.rows[0].n) === 2, `n=${ctrl25.rows[0].n}`);
  const mark25 = await pool.query("SELECT value FROM db_meta WHERE key = 'job_dedup_2026_11_28'");
  const mark25j = JSON.parse(mark25.rows[0]?.value || '{}');
  check('Dedup: penanda tersimpan (9 dihapus, 2 grup dibersihkan)', mark25j.jobsDeleted === 9 && mark25j.groupsCleaned === 2, JSON.stringify(mark25j));
  const notif25 = await pool.query("SELECT content FROM notifications WHERE citizen_id = 999050 AND title = 'Lowongan duplikat dibersihkan'");
  check('Dedup: pemilik mendapat 1 notifikasi (9 lowongan dihapus)', notif25.rows.length === 1 && /9 lowongan duplikat/.test(notif25.rows[0]?.content || ''), `n=${notif25.rows.length}`);
  const ver25 = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi = 27', ver25.rows[0]?.value === '27', `value=${ver25.rows[0]?.value}`);
  // Idempotensi: migrasi kedua tidak menghapus apa-apa lagi.
  await pool.query("UPDATE db_meta SET value = '23' WHERE key = 'schema_version'");
  await initDb();
  const g1b = await pool.query("SELECT COUNT(*) AS n FROM jobs WHERE company_id = 999060 AND title = 'Kerja' AND salary = 100000");
  check('Dedup idempotent: initDb kedua tidak menghapus lagi', Number(g1b.rows[0].n) === 1, `n=${g1b.rows[0].n}`);
  await pool.query('DELETE FROM jobs WHERE id IN (999061, 999071, 999073, 999074)');
  await pool.query('DELETE FROM notifications WHERE citizen_id = 999050');
  await pool.query('DELETE FROM companies WHERE id = 999060');
  await pool.query('DELETE FROM citizens WHERE id IN (999050, 999051)');
  await pool.query("DELETE FROM users WHERE email IN ('w25_owner@test.local', 'w25_holder@test.local')");

  console.log('\n[26] v5.2.0 — Tutorial awal: kolom tutorial_done + backfill warga lama');
  // Warga "lama" (dibuat sebelum migrasi): sisipkan dulu, lalu paksa
  // migrasi penuh skema 27 dengan menghapus kolom + menurunkan versi.
  await pool.query(`INSERT INTO users (id, email, username, pass_hash, created_at) VALUES
    (999080, 'w26_old@test.local', 'w26_old', 'x', 0)`);
  await pool.query(`INSERT INTO citizens (id, user_id, level, xp, energy, gold, usd, region_id, home_region_id, created_at) VALUES
    (999080, 999080, 3, 0, 100, 0, 500, 2, 2, 0)`);
  await pool.query('ALTER TABLE citizens DROP COLUMN tutorial_done');
  await pool.query("DELETE FROM db_meta WHERE key = 'tutorial_backfill_2026_11_28'");
  await pool.query("UPDATE db_meta SET value = '24' WHERE key = 'schema_version'");
  await initDb();
  const col26 = await pool.query("SELECT column_default FROM information_schema.columns WHERE table_name = 'citizens' AND column_name = 'tutorial_done'");
  check('Migrasi: kolom tutorial_done ada (default 0)', col26.rowCount === 1 && String(col26.rows[0]?.column_default) === '0', `default=${col26.rows[0]?.column_default}`);
  const old26 = await pool.query('SELECT tutorial_done FROM citizens WHERE id = 999080');
  check('Backfill: warga LAMA ditandai selesai (tutorial_done = 1)', Number(old26.rows[0]?.tutorial_done) === 1, `tutorial_done=${old26.rows[0]?.tutorial_done}`);
  const ver26 = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi = 27', ver26.rows[0]?.value === '27', `value=${ver26.rows[0]?.value}`);
  const mark26 = await pool.query("SELECT value FROM db_meta WHERE key = 'tutorial_backfill_2026_11_28'");
  check('Backfill: penanda tersimpan', mark26.rowCount === 1, `value=${mark26.rows[0]?.value}`);
  // Warga BARU (dibuat setelah migrasi): default 0 → melihat overlay.
  await pool.query(`INSERT INTO users (id, email, username, pass_hash, created_at) VALUES
    (999081, 'w26_new@test.local', 'w26_new', 'x', 0)`);
  await pool.query(`INSERT INTO citizens (id, user_id, level, xp, energy, gold, usd, region_id, home_region_id, created_at) VALUES
    (999081, 999081, 1, 0, 100, 50, 500, 2, 2, 0)`);
  const new26 = await pool.query('SELECT tutorial_done FROM citizens WHERE id = 999081');
  check('Warga BARU: tutorial_done default 0 (melihat overlay)', Number(new26.rows[0]?.tutorial_done) === 0, `tutorial_done=${new26.rows[0]?.tutorial_done}`);
  // Idempotensi: migrasi kedua (paksa via reset versi) tidak menandai
  // warga baru sebagai selesai — backfill dijaga penanda, sekali saja.
  await pool.query("UPDATE db_meta SET value = '24' WHERE key = 'schema_version'");
  await initDb();
  const new26b = await pool.query('SELECT tutorial_done FROM citizens WHERE id = 999081');
  check('Idempotent: migrasi ulang TIDAK menandai warga baru (tetap 0)', Number(new26b.rows[0]?.tutorial_done) === 0, `tutorial_done=${new26b.rows[0]?.tutorial_done}`);
  const old26b = await pool.query('SELECT tutorial_done FROM citizens WHERE id = 999080');
  check('Idempotent: warga lama tetap 1', Number(old26b.rows[0]?.tutorial_done) === 1, `tutorial_done=${old26b.rows[0]?.tutorial_done}`);
  await pool.query('DELETE FROM citizens WHERE id IN (999080, 999081)');
  await pool.query("DELETE FROM users WHERE email IN ('w26_old@test.local', 'w26_new@test.local')");

  console.log('\n[27] v5.3.0 — Banner AdSense: kolom kind di ad_tokens + ad_rewards');
  // Paksa migrasi penuh skema 27 dengan menghapus kolom kind + menurunkan versi.
  await pool.query('ALTER TABLE ad_tokens DROP COLUMN kind');
  await pool.query('ALTER TABLE ad_rewards DROP COLUMN kind');
  await pool.query("UPDATE db_meta SET value = '25' WHERE key = 'schema_version'");
  await initDb();
  const colT27 = await pool.query("SELECT column_default FROM information_schema.columns WHERE table_name = 'ad_tokens' AND column_name = 'kind'");
  check('Migrasi: ad_tokens.kind ada (default video)', colT27.rowCount === 1 && String(colT27.rows[0]?.column_default) === "'video'::text", `default=${colT27.rows[0]?.column_default}`);
  const colR27 = await pool.query("SELECT column_default FROM information_schema.columns WHERE table_name = 'ad_rewards' AND column_name = 'kind'");
  check('Migrasi: ad_rewards.kind ada (default video)', colR27.rowCount === 1 && String(colR27.rows[0]?.column_default) === "'video'::text", `default=${colR27.rows[0]?.column_default}`);
  const ver27 = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi = 27', ver27.rows[0]?.value === '27', `value=${ver27.rows[0]?.value}`);
  // Grant lama (tanpa kind eksplisit) tetap 'video'.
  await pool.query(`INSERT INTO users (id, email, username, pass_hash, created_at) VALUES
    (999090, 'w27@test.local', 'w27', 'x', 0)`);
  await pool.query(`INSERT INTO citizens (id, user_id, level, xp, energy, gold, usd, region_id, home_region_id, created_at) VALUES
    (999090, 999090, 1, 0, 100, 50, 500, 2, 2, 0)`);
  await pool.query("INSERT INTO ad_rewards (citizen_id, gold, granted_at) VALUES (999090, 30, $1)", [Date.now()]);
  const old27 = await pool.query("SELECT kind FROM ad_rewards WHERE citizen_id = 999090");
  check('Grant lama tanpa kind → default video', old27.rows[0]?.kind === 'video', `kind=${old27.rows[0]?.kind}`);
  // Grant banner tercatat kind=banner; hitung per jenis.
  await pool.query("INSERT INTO ad_rewards (citizen_id, gold, granted_at, kind) VALUES (999090, 15, $1, 'banner')", [Date.now()]);
  const cnt27 = await pool.query("SELECT kind, COUNT(*) AS n FROM ad_rewards WHERE citizen_id = 999090 GROUP BY kind ORDER BY kind");
  check('Hitung grant per kind (1 video + 1 banner)', cnt27.rowCount === 2 && Number(cnt27.rows[0]?.n) === 1 && Number(cnt27.rows[1]?.n) === 1, JSON.stringify(cnt27.rows));
  // FK tetap berlaku untuk grant banner.
  let fk27 = false;
  try { await pool.query("INSERT INTO ad_rewards (citizen_id, gold, granted_at, kind) VALUES (999999, 15, 0, 'banner')"); } catch { fk27 = true; }
  check('FK ad_rewards.citizen_id menolak grant banner warga yang tidak ada', fk27);
  // Idempotensi: migrasi ulang tidak menduplikat kolom kind.
  await pool.query("UPDATE db_meta SET value = '25' WHERE key = 'schema_version'");
  await initDb();
  const colR27b = await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_name = 'ad_rewards' AND column_name = 'kind'");
  check('Idempotent: migrasi ulang tidak menduplikat kolom kind', Number(colR27b.rows[0]?.n) === 1, `n=${colR27b.rows[0]?.n}`);
  await pool.query('DELETE FROM ad_rewards WHERE citizen_id = 999090');
  await pool.query('DELETE FROM citizens WHERE id = 999090');
  await pool.query("DELETE FROM users WHERE email = 'w27@test.local'");

  console.log('\n[28] v5.3.0 — Conversion tracking: kolom first_shift_done');
  // Paksa migrasi penuh skema 27 dengan menghapus kolom + menurunkan versi.
  await pool.query('ALTER TABLE citizens DROP COLUMN first_shift_done');
  await pool.query("UPDATE db_meta SET value = '26' WHERE key = 'schema_version'");
  await initDb();
  const col28 = await pool.query("SELECT column_default FROM information_schema.columns WHERE table_name = 'citizens' AND column_name = 'first_shift_done'");
  check('Migrasi: kolom first_shift_done ada (default 0)', col28.rowCount === 1 && String(col28.rows[0]?.column_default) === '0', `default=${col28.rows[0]?.column_default}`);
  const ver28 = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi = 27', ver28.rows[0]?.value === '27', `value=${ver28.rows[0]?.value}`);
  // Warga baru: default 0 (belum pernah shift).
  await pool.query(`INSERT INTO users (id, email, username, pass_hash, created_at) VALUES
    (999091, 'w28@test.local', 'w28', 'x', 0)`);
  await pool.query(`INSERT INTO citizens (id, user_id, level, xp, energy, gold, usd, region_id, home_region_id, created_at) VALUES
    (999091, 999091, 1, 0, 100, 50, 500, 2, 2, 0)`);
  const new28 = await pool.query('SELECT first_shift_done FROM citizens WHERE id = 999091');
  check('Warga baru: first_shift_done default 0', Number(new28.rows[0]?.first_shift_done) === 0, `first_shift_done=${new28.rows[0]?.first_shift_done}`);
  // UPDATE bersyarat (pola handler shift): hanya satu yang menang.
  const upd28 = await pool.query('UPDATE citizens SET first_shift_done = 1 WHERE id = 999091 AND first_shift_done = 0');
  check('UPDATE bersyarat pertama mengubah 1 baris', upd28.rowCount === 1, `rowCount=${upd28.rowCount}`);
  const upd28b = await pool.query('UPDATE citizens SET first_shift_done = 1 WHERE id = 999091 AND first_shift_done = 0');
  check('UPDATE bersyarat kedua mengubah 0 baris (sudah 1)', upd28b.rowCount === 0, `rowCount=${upd28b.rowCount}`);
  // Idempotensi: migrasi ulang tidak menduplikat kolom.
  await pool.query("UPDATE db_meta SET value = '26' WHERE key = 'schema_version'");
  await initDb();
  const col28b = await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_name = 'citizens' AND column_name = 'first_shift_done'");
  check('Idempotent: migrasi ulang tidak menduplikat kolom', Number(col28b.rows[0]?.n) === 1, `n=${col28b.rows[0]?.n}`);
  await pool.query('DELETE FROM citizens WHERE id = 999091');
  await pool.query("DELETE FROM users WHERE email = 'w28@test.local'");

  await pool.end();
  console.log(`\n[pg-verify] SELESAI: ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[pg-verify] ERROR:', e); process.exit(1); });
