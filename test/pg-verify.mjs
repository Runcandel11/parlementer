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
  check('Penanda versi skema = 15', ver.rows[0]?.value === '15', `value=${ver.rows[0]?.value}`);
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
  check('Versi skema setelah migrasi = 15', ver10.rows[0]?.value === '15', `value=${ver10.rows[0]?.value}`);

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
  check('Versi skema setelah migrasi = 15', ver11.rows[0]?.value === '15', `value=${ver11.rows[0]?.value}`);

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
  check('Versi skema setelah migrasi = 15', ver12.rows[0]?.value === '15', `value=${ver12.rows[0]?.value}`);

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
  check('Versi skema setelah migrasi = 15', ver13.rows[0]?.value === '15', `value=${ver13.rows[0]?.value}`);

  console.log('\n[12d] Fitur tiket v3.1.0 — migrasi v14 (Minuman Energi + skala XP ×20)');
  const drinkRow = await pool.query("SELECT ref_usd, ref_gold, category FROM commodities WHERE name = 'Minuman Energi'");
  check('Komoditas Minuman Energi ada di seed (Perbekalan, 1,83 USD / 0,10 emas)', drinkRow.rowCount === 1
    && drinkRow.rows[0].category === 'Perbekalan' && Number(drinkRow.rows[0].ref_gold) === 0.1 && Number(drinkRow.rows[0].ref_usd) === 1.83,
    JSON.stringify(drinkRow.rows[0]));
  // Migrasi skala XP: warga lama dengan XP skala lama (mis. 7 XP) harus
  // dikali 20 (→ 140) supaya tidak kehilangan progres saat threshold naik
  // dari level×5 menjadi level×100. Warga dengan XP 0 tidak berubah.
  await pool.query("INSERT INTO users (id, email, username, pass_hash, created_at) VALUES (999003, 'xp@test.local', 'warga_xp', 'x', 0)");
  await pool.query("INSERT INTO citizens (id, user_id, region_id, home_region_id, xp, created_at) VALUES (999003, 999003, 1, 1, 7, 0)");
  await pool.query("INSERT INTO users (id, email, username, pass_hash, created_at) VALUES (999004, 'xp0@test.local', 'warga_xp0', 'x', 0)");
  await pool.query("INSERT INTO citizens (id, user_id, region_id, home_region_id, xp, created_at) VALUES (999004, 999004, 1, 1, 0, 0)");
  await resetVersion();
  await initDb();
  const xpRows = await pool.query('SELECT id, xp FROM citizens WHERE id IN (999003, 999004) ORDER BY id');
  check('Migrasi: XP lama 7 → 140 (×20, progres tidak hilang)', xpRows.rows[0]?.xp === 140, `xp=${xpRows.rows[0]?.xp}`);
  check('Migrasi: XP 0 tetap 0', xpRows.rows[1]?.xp === 0, `xp=${xpRows.rows[1]?.xp}`);
  const ver14 = await pool.query("SELECT value FROM db_meta WHERE key = 'schema_version'");
  check('Versi skema setelah migrasi = 15', ver14.rows[0]?.value === '15', `value=${ver14.rows[0]?.value}`);
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
  check('Versi skema setelah migrasi = 15', ver15.rows[0]?.value === '15', `value=${ver15.rows[0]?.value}`);
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
  check('Versi skema setelah migrasi ulang = 15', ver15b.rows[0]?.value === '15', `value=${ver15b.rows[0]?.value}`);
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

  await pool.end();
  console.log(`\n[pg-verify] SELESAI: ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[pg-verify] ERROR:', e); process.exit(1); });
