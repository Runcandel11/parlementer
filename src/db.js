// Parlementer — lapisan database.
// Dua backend: Postgres (bila DATABASE_URL disetel, mis. Neon/Supabase di Render)
// atau SQLite lokal (node:sqlite, file di DATABASE_PATH, default ./data/parlementer.db).
// Semua SQL ditulis dengan placeholder `?`; untuk Postgres diterjemahkan ke $1, $2, ...
// Semua INSERT memakai `RETURNING id` agar lastID konsisten di kedua backend.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ACHIEVEMENTS, ADMIN_JOB_SEATS, PARLIAMENT_OPENS_AT_DEFAULT } from './game.js';

// Email yang menjadi admin otomatis (satu-satunya admin; tidak ada endpoint
// promosi admin). Dibandingkan case-insensitive (email selalu disimpan lowercase).
export const ADMIN_EMAIL = 'koboijuniorkhalid@gmail.com';

// Kode referral: 8 karakter alfanumerik tanpa karakter ambigu (tanpa 0/O, 1/I/l/L).
const REFERRAL_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function makeReferralCode() {
  let code = '';
  for (let i = 0; i < 8; i++) code += REFERRAL_ALPHABET[crypto.randomInt(REFERRAL_ALPHABET.length)];
  return code;
}

// Buat kode referral yang belum dipakai siapa pun (regenerasi bila bentrok).
export async function generateReferralCode(t) {
  const db = t || { one };
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = makeReferralCode();
    const taken = await db.one('SELECT id FROM users WHERE referral_code = ?', [code]);
    if (!taken) return code;
  }
  throw new Error('Gagal membuat kode referral unik.');
}
// PG_MEM_TEST=1 memakai pg-mem (emulator Postgres di memori) untuk menguji jalur
// Postgres tanpa server Postgres sungguhan. Bukan untuk production.
export const isPg = !!process.env.DATABASE_URL || process.env.PG_MEM_TEST === '1';

let sqliteDb = null;
let pool = null;
let poolPromise = null;

// Konfigurasi Pool Postgres dari DATABASE_URL.
//
// Masalah log (Tahap 3): pg-connection-string 2.14+ menulis peringatan
// deprecation ke stderr di SETIAP cold start bila URL mengandung
// sslmode=prefer/require/verify-ca — dan Vercel mengklasifikasikan stderr
// sebagai Error. Di saat yang sama, pg-connection-string 2.x MEMPERLAKUKAN
// sslmode=require sebagai verify-full: `config.ssl` menjadi `{}` kosong,
// yang di Node berarti TLS dengan rejectUnauthorized: true (sertifikat
// server tetap diverifikasi — koneksi Neon yang berhasil membuktikannya).
//
// Perbaikan: bila URL mengandung sslmode, buang parameter itu dari URL dan
// ganti dengan `ssl: { rejectUnauthorized: true }` eksplisit — perilaku TLS
// IDENTIK dengan yang berlaku hari ini, tanpa peringatan. DATABASE_URL
// sendiri tidak diubah (hanya salinan string yang dipakai Pool), dan URL
// tanpa sslmode (mis. Postgres lokal untuk tes) tidak disentuh sama sekali.
export function buildPgPoolConfig(databaseUrl) {
  const raw = databaseUrl || '';
  if (!/[?&]sslmode=[^&]*/.test(raw)) return { connectionString: raw };
  const connectionString = raw
    .replace(/([?&])sslmode=[^&]*(&|$)/g, (m, sep, tail) => (tail ? sep : ''))
    .replace(/[?&]$/, '');
  return { connectionString, ssl: { rejectUnauthorized: true } };
}

async function ensurePool() {
  if (pool) return pool;
  if (!poolPromise) {
    poolPromise = (async () => {
      if (process.env.PG_MEM_TEST === '1') {
        const { newDb } = await import('pg-mem');
        const mem = newDb();
        const pgMem = mem.adapters.createPg();
        pool = new pgMem.Pool();
      } else {
        const pg = (await import('pg')).default;
        // BIGINT (int8, oid 20) dikembalikan node-postgres sebagai STRING
        // secara default — di frontend, new Date("1793...") = Invalid Date,
        // sehingga SEMUA waktu chat (dan semua fmtTime/fmtDate lain) rusak
        // di live. Di SQLite lokal angkanya number, jadi bug ini tidak
        // pernah terlihat di tes lokal. Parse jadi Number: timestamp ms
        // (~1,8e12) jauh di bawah batas aman 2^53, jadi tidak ada risiko
        // presisi. (Tahap 5 — bug "Invalid Date" 27 Nov 2026.)
        pg.types.setTypeParser(20, (v) => parseInt(v, 10));
        // Pool kecil: di serverless tiap instance fungsi punya pool sendiri,
        // dan Neon free tier membatasi jumlah koneksi bersamaan. max 3
        // per instance sudah cukup untuk game ini (mode server biasa juga
        // tetap jalan normal dengan pool sekecil ini).
        pool = new pg.Pool({
          ...buildPgPoolConfig(process.env.DATABASE_URL),
          max: 3,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
        });
        pool.on('error', (e) => console.error('[db] pool error:', e.message));
      }
      return pool;
    })();
  }
  return poolPromise;
}

if (!isPg) {
  // Di Vercel filesystem read-only kecuali /tmp; path default dialihkan ke sana
  // supaya import modul tidak crash sebelum ensureReady() sempat menolak dengan
  // pesan yang jelas (DATABASE_URL wajib di Vercel — lihat src/app.js).
  const dbPath = process.env.DATABASE_PATH
    || (process.env.VERCEL ? path.join('/tmp', 'parlementer.db') : path.join(__dirname, '..', 'data', 'parlementer.db'));
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  sqliteDb = new DatabaseSync(dbPath);
  sqliteDb.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
}

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

export async function sql(query, params = []) {
  if (isPg) {
    const p = await ensurePool();
    const r = await p.query(toPg(query), params);
    return r.rows;
  }
  return sqliteDb.prepare(query).all(...params);
}

export async function one(query, params = []) {
  const rows = await sql(query, params);
  return rows[0];
}

export async function run(query, params = []) {
  if (isPg) {
    const p = await ensurePool();
    const r = await p.query(toPg(query), params);
    return { id: r.rows[0]?.id ?? null, changes: r.rowCount };
  }
  const r = sqliteDb.prepare(query).run(...params);
  return { id: r.lastInsertRowid ? Number(r.lastInsertRowid) : null, changes: r.changes };
}

export async function exec(query) {
  if (isPg) { const p = await ensurePool(); await p.query(query); return; }
  sqliteDb.exec(query);
}

// Tambahkan FOR UPDATE hanya di Postgres sungguhan. pg-mem dan SQLite
// tidak mendukungnya (keduanya men-serialize tulis, jadi aman tanpa itu).
// Dipakai untuk mengunci baris di dalam tx() agar dua request paralel
// tidak bisa membaca saldo/stok yang sama sebelum yang satu selesai.
export function forUpdate(query) {
  return isPg && process.env.PG_MEM_TEST !== '1' ? query + ' FOR UPDATE' : query;
}

// Transaksi: fn menerima objek tx dengan sql/one/run yang sama.
export async function tx(fn) {
  if (isPg) {
    const p = await ensurePool();
    const client = await p.connect();
    const t = {
      sql: async (q, p = []) => (await client.query(toPg(q), p)).rows,
      one: async (q, p = []) => (await client.query(toPg(q), p)).rows[0],
      run: async (q, p = []) => {
        const r = await client.query(toPg(q), p);
        return { id: r.rows[0]?.id ?? null, changes: r.rowCount };
      },
      exec: async (q) => { await client.query(q); },
    };
    try {
      await client.query('BEGIN');
      const out = await fn(t);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
  }
  sqliteDb.exec('BEGIN');
  const t = {
    sql: async (q, p = []) => sqliteDb.prepare(q).all(...p),
    one: async (q, p = []) => sqliteDb.prepare(q).get(...p),
    run: async (q, p = []) => {
      const r = sqliteDb.prepare(q).run(...p);
      return { id: r.lastInsertRowid ? Number(r.lastInsertRowid) : null, changes: r.changes };
    },
    exec: async (q) => { sqliteDb.exec(q); },
  };
  try {
    const out = await fn(t);
    sqliteDb.exec('COMMIT');
    return out;
  } catch (e) {
    sqliteDb.exec('ROLLBACK');
    throw e;
  }
}

// Jenis bangunan konvoi AKTIF milik seorang warga (belum kedaluwarsa).
// Dipakai menerapkan bonus konvoi (Tahap 3, BUG-7): 'health', 'education',
// 'industry', 'military'. `t` opsional — bila diberikan (di dalam tx),
// query memakai koneksi transaksi yang sama; bila tidak, memakai pool/sql
// biasa. Mengembalikan Set (kosong bila tidak ada bangunan aktif).
export async function convoyBuildings(citizenId, t = null) {
  const q = 'SELECT DISTINCT building FROM convoys WHERE citizen_id = ? AND expires_at > ?';
  const rows = t ? await t.sql(q, [citizenId, Date.now()]) : await sql(q, [citizenId, Date.now()]);
  return new Set(rows.map((r) => r.building));
}

// --- Hari dunia (Tahap 7) ---
// Satu sumber kebenaran untuk "hari dunia saat ini" — dulu potongan yang
// sama `(await one('SELECT day FROM world WHERE id = 1'))?.day || 1`
// ditulis 9× di api-core/api-civic. `t` opsional (di dalam tx pakai koneksi
// transaksi yang sama, seperti convoyBuildings).
export async function getWorldDay(t = null) {
  const w = t ? await t.one('SELECT day FROM world WHERE id = 1') : await one('SELECT day FROM world WHERE id = 1');
  return w?.day || 1;
}

// --- Misi harian + kronik (Tahap 7): tabel relasional ---
// Dulu tiga kolom JSON TEXT di citizens (missions, chronicle_done,
// chronicle_claimed) yang dibaca-ubah-tulis tanpa kunci — dua aksi paralel
// bisa saling menimpa sehingga satu progres/klaim hilang (balapan
// read-modify-write, pola BUG-16 di audit). Sekarang tiap progres/klaim
// adalah baris sendiri:
//  - mission_progress: progres misi harian yang dihitung dari event
//    (hanya 'chat' + 'last_chat_counted' — 'energy'/'bread' TIDAK disimpan
//    di sini karena progresnya dibaca langsung dari kolom citizens
//    energy_spent_today/bread_today, yang memang sumber kebenarannya);
//  - mission_claims: klaim hadiah misi (UNIQUE citizen+mkey);
//  - chronicle_done: tugas kronik yang selesai (UNIQUE citizen+ckey);
//  - chronicle_claims: klaim hadiah babak kronik (UNIQUE citizen+chapter).
// Semua helper menerima `t` opsional (pola convoyBuildings di atas).
export async function missionValue(t, citizenId, key) {
  const row = t ? await t.one('SELECT value FROM mission_progress WHERE citizen_id = ? AND mkey = ?', [citizenId, key])
    : await one('SELECT value FROM mission_progress WHERE citizen_id = ? AND mkey = ?', [citizenId, key]);
  return row ? Number(row.value) : 0;
}
export async function setMissionValue(t, citizenId, key, value) {
  const db = t || { run };
  const upd = await db.run('UPDATE mission_progress SET value = ? WHERE citizen_id = ? AND mkey = ?', [value, citizenId, key]);
  if (!upd.changes) await db.run('INSERT INTO mission_progress (citizen_id, mkey, value) VALUES (?,?,?)', [citizenId, key, value]);
}
export async function missionClaimedKeys(t, citizenId) {
  const rows = t ? await t.sql('SELECT mkey FROM mission_claims WHERE citizen_id = ?', [citizenId])
    : await sql('SELECT mkey FROM mission_claims WHERE citizen_id = ?', [citizenId]);
  return rows.map((r) => r.mkey);
}
export async function insertMissionClaim(t, citizenId, key) {
  const db = t || { run };
  await db.run('INSERT INTO mission_claims (citizen_id, mkey, claimed_at) VALUES (?,?,?)', [citizenId, key, Date.now()]);
}
export async function chronicleDoneKeys(t, citizenId) {
  const rows = t ? await t.sql('SELECT ckey FROM chronicle_done WHERE citizen_id = ?', [citizenId])
    : await sql('SELECT ckey FROM chronicle_done WHERE citizen_id = ?', [citizenId]);
  return rows.map((r) => r.ckey);
}
export async function chronicleClaimedChapters(t, citizenId) {
  const rows = t ? await t.sql('SELECT chapter FROM chronicle_claims WHERE citizen_id = ?', [citizenId])
    : await sql('SELECT chapter FROM chronicle_claims WHERE citizen_id = ?', [citizenId]);
  return rows.map((r) => r.chapter);
}
export async function insertChronicleClaim(t, citizenId, chapter) {
  const db = t || { run };
  await db.run('INSERT INTO chronicle_claims (citizen_id, chapter, claimed_at) VALUES (?,?,?)', [citizenId, chapter, Date.now()]);
}
// Menandai satu tugas kronik selesai. Pemanggilnya di LUAR transaksi —
// fungsi ini membuka tx sendiri dan mengunci baris warga dulu, supaya dua
// panggilan paralel berurutan: yang kedua melihat baris yang sudah ada dan
// tidak INSERT dua kali (UNIQUE juga menjaga bila balapan tetap terjadi).
export async function markChronicleDone(citizenId, key) {
  await tx(async (t) => {
    await t.one(forUpdate('SELECT id FROM citizens WHERE id = ?'), [citizenId]);
    const ex = await t.one('SELECT 1 AS x FROM chronicle_done WHERE citizen_id = ? AND ckey = ?', [citizenId, key]);
    if (!ex) await t.run('INSERT INTO chronicle_done (citizen_id, ckey, done_at) VALUES (?,?,?)', [citizenId, key, Date.now()]);
  });
}

const idPk = (dialect) => dialect === 'pg'
  ? 'INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY'
  : 'INTEGER PRIMARY KEY AUTOINCREMENT';

function schema(dialect) {
  const id = idPk(dialect);
  return `
CREATE TABLE IF NOT EXISTS users (
  id ${id},
  email TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  referred_by INTEGER,
  referral_code TEXT UNIQUE,
  avatar TEXT,
  avatar_sm TEXT,
  premium_until BIGINT NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_banned INTEGER NOT NULL DEFAULT 0,
  banned_reason TEXT NOT NULL DEFAULT '',
  banned_at BIGINT NOT NULL DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 0 CHECK (token_version >= 0),
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  window_start BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS db_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS referral_pending (
  id ${id},
  referrer_id INTEGER NOT NULL,
  newcomer_id INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'skipped')),
  created_at BIGINT NOT NULL,
  paid_at BIGINT,
  paid_day TEXT
);
CREATE TABLE IF NOT EXISTS admin_actions (
  id ${id},
  admin_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS appeals (
  id ${id},
  user_id INTEGER NOT NULL REFERENCES users(id),
  ban_reason TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'menunggu',
  created_at BIGINT NOT NULL,
  decided_at BIGINT NOT NULL DEFAULT 0,
  decided_by INTEGER
);
CREATE TABLE IF NOT EXISTS appeal_messages (
  id ${id},
  appeal_id INTEGER NOT NULL REFERENCES appeals(id),
  sender_id INTEGER NOT NULL,
  sender_role TEXT NOT NULL DEFAULT 'pemain',
  text TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS citizens (
  id ${id},
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  level INTEGER NOT NULL DEFAULT 1,
  xp INTEGER NOT NULL DEFAULT 0,
  energy INTEGER NOT NULL DEFAULT 100 CHECK (energy >= 0),
  energy_updated_at BIGINT NOT NULL DEFAULT 0,
  -- Kredit skor (v3.0.0, saran LIO tiket #7): semua warga mulai 100;
  -- laporan chat yang terbukti benar menurunkan skor −10; pulih +1/hari
  -- (malas, di loadCitizen); 0 = banned otomatis. Rentang dijaga di
  -- kode (clamp 0..100), bukan CHECK — supaya migrasi kolom lama tidak
  -- perlu menambah constraint.
  credit_score INTEGER NOT NULL DEFAULT 100,
  credit_updated_at BIGINT NOT NULL DEFAULT 0,
  last_seen_at BIGINT NOT NULL DEFAULT 0,
  gold REAL NOT NULL DEFAULT 50 CHECK (gold >= 0),
  usd REAL NOT NULL DEFAULT 500 CHECK (usd >= 0),
  attr_str INTEGER NOT NULL DEFAULT 0,
  attr_edu INTEGER NOT NULL DEFAULT 0,
  attr_eco INTEGER NOT NULL DEFAULT 0,
  train_str_at BIGINT NOT NULL DEFAULT 0,
  train_edu_at BIGINT NOT NULL DEFAULT 0,
  train_eco_at BIGINT NOT NULL DEFAULT 0,
  fatigue INTEGER NOT NULL DEFAULT 0,
  bread_today INTEGER NOT NULL DEFAULT 0,
  -- Kerja otomatis Premium 24 jam (v4.5.0): auto_work_until = akhir masa
  -- aktif (epoch ms; 0 = mati); started_at = awal aktivasi; shifts =
  -- jumlah shift otomatis pada aktivasi ini; paused = 1 bila dijeda
  -- karena kelelahan >= 10.000; last_at = jam shift otomatis terakhir.
  auto_work_until BIGINT NOT NULL DEFAULT 0,
  auto_work_started_at BIGINT NOT NULL DEFAULT 0,
  auto_work_shifts INTEGER NOT NULL DEFAULT 0,
  auto_work_paused INTEGER NOT NULL DEFAULT 0,
  auto_work_last_at BIGINT NOT NULL DEFAULT 0,
  -- Link share harian (v4.6.0): kode acak per warga (unik, stabil) untuk
  -- URL publik /s/<kode>; NULL sampai warga pertama kali membuka halaman
  -- Bagikan Link (dibuat malas di GET /api/share).
  share_code TEXT,
  energy_spent_today INTEGER NOT NULL DEFAULT 0,
  chat_today INTEGER NOT NULL DEFAULT 0,
  last_chat_at BIGINT NOT NULL DEFAULT 0,
  last_claim_date TEXT NOT NULL DEFAULT '',
  region_id INTEGER NOT NULL,
  home_region_id INTEGER NOT NULL,
  -- Perjalanan (27 Nov 2026): travel = kunjungan, bukan pindah.
  -- travel_to_region_id + travel_arrives_at = perjalanan yang sedang
  -- berjalan (NULL/0 = tidak sedang bepergian); home_changed_at = jam
  -- terakhir pindah kewarganegaraan (0 = belum pernah pindah).
  travel_to_region_id INTEGER,
  travel_arrives_at BIGINT NOT NULL DEFAULT 0,
  home_changed_at BIGINT NOT NULL DEFAULT 0,
  party_id INTEGER,
  job_id INTEGER,
  bio TEXT NOT NULL DEFAULT '',
  shifts INTEGER NOT NULL DEFAULT 0,
  total_salary REAL NOT NULL DEFAULT 0,
  total_damage INTEGER NOT NULL DEFAULT 0,
  attacks INTEGER NOT NULL DEFAULT 0,
  frontline_attacks INTEGER NOT NULL DEFAULT 0,
  laws_proposed INTEGER NOT NULL DEFAULT 0,
  purchases INTEGER NOT NULL DEFAULT 0,
  recruits INTEGER NOT NULL DEFAULT 0,
  -- Reputasi dagang (Tahap 6): jumlah transaksi pasar yang selesai
  -- (pembeli dan penjual sama-sama +1). Tier reputasi dihitung dari angka
  -- ini (game.js TRADE_REPUTATION_TIERS) — murni prestise, bukan diskon.
  trades_completed INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS country (
  id ${id},
  name TEXT NOT NULL,
  -- Ideologi + sistem pemerintahan (redesain dunia 27 Nov 2026): tiap
  -- negara punya keduanya; dipilih presiden ATAU lewat UU. CHECK menjaga
  -- nilainya tetap dalam daftar game.js (COUNTRY_IDEOLOGIES /
  -- GOVERNMENT_SYSTEMS). founder_id = pendiri negara (bukan otomatis
  -- presiden — presiden dipilih lewat pemilu + nominasi kepala partai).
  ideology TEXT NOT NULL DEFAULT 'Konservatisme' CHECK (ideology IN ('Konservatisme','Sosialisme','Liberalisme','Nasionalisme')),
  system TEXT NOT NULL DEFAULT 'presidensial' CHECK (system IN ('presidensial','parlementer','imperial','diktator')),
  founder_id INTEGER,
  capital TEXT NOT NULL DEFAULT 'Jakarta',
  founded TEXT NOT NULL DEFAULT '2026-09-23',
  treasury REAL NOT NULL DEFAULT 0,
  treasury_usd REAL NOT NULL DEFAULT 0,
  tax_income REAL NOT NULL DEFAULT 2 CHECK (tax_income >= 0 AND tax_income <= 10),
  tax_production REAL NOT NULL DEFAULT 1,
  tax_import REAL NOT NULL DEFAULT 2,
  tax_export REAL NOT NULL DEFAULT 2,
  president_id INTEGER,
  minister_economy INTEGER,
  minister_foreign INTEGER,
  minister_home INTEGER,
  minister_defense INTEGER,
  admin_pay_mult REAL NOT NULL DEFAULT 1 CHECK (admin_pay_mult >= 0.5 AND admin_pay_mult <= 2),
  travel_tickets INTEGER NOT NULL DEFAULT 1 CHECK (travel_tickets IN (1, 2)),
  mobilization_until BIGINT NOT NULL DEFAULT 0,
  budget_kind TEXT NOT NULL DEFAULT '',
  budget_until BIGINT NOT NULL DEFAULT 0,
  holiday_at BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS regions (
  id ${id},
  name TEXT NOT NULL,
  -- Kolom warisan (dulu nama negara wilayah ini). Sejak redesain dunia
  -- 27 Nov 2026 wilayah TIDAK punya negara di awal: nilainya '' dan TIDAK
  -- DIBACA kode mana pun — keanggotaan negara ada di country_id (NULL =
  -- wilayah merdeka). Kolom dipertahankan supaya migrasi database lama
  -- tidak butuh rebuild tabel; jangan dipakai lagi.
  country TEXT NOT NULL DEFAULT '',
  country_id INTEGER REFERENCES country(id),
  type TEXT NOT NULL DEFAULT 'Daratan',
  -- Kepemilikan wilayah (Tahap 6, BUG-10): siapa yang menguasai wilayah
  -- ini SEKARANG — 'bebas' (tidak ada yang menguasai, controller_id NULL),
  -- 'negara' (controller_id = id negara pemilik, selaras country_id), atau
  -- 'pemberontak' (controller_id = id warga panglima perang yang merebutnya
  -- lewat perang). Pajak pasar wilayah yang dikuasai pemberontak mengalir
  -- ke panglima perang, bukan ke kas negara.
  controller TEXT NOT NULL DEFAULT 'bebas' CHECK (controller IN ('bebas','negara','pemberontak')),
  controller_id INTEGER,
  city_score INTEGER NOT NULL DEFAULT 7,
  capacity INTEGER NOT NULL DEFAULT 100,
  health INTEGER NOT NULL DEFAULT 7,
  education INTEGER NOT NULL DEFAULT 7,
  military INTEGER NOT NULL DEFAULT 7,
  industry INTEGER NOT NULL DEFAULT 7,
  electricity INTEGER NOT NULL DEFAULT 10,
  resource_bonus TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS commodities (
  id ${id},
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'Barang',
  ref_usd REAL NOT NULL DEFAULT 0,
  ref_gold REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS inventory (
  id ${id},
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  commodity_id INTEGER NOT NULL REFERENCES commodities(id),
  tier INTEGER NOT NULL DEFAULT 1,
  qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  UNIQUE(citizen_id, commodity_id, tier)
);
CREATE TABLE IF NOT EXISTS market_offers (
  id ${id},
  seller_id INTEGER NOT NULL REFERENCES citizens(id),
  scope TEXT NOT NULL DEFAULT 'local',
  commodity_id INTEGER NOT NULL REFERENCES commodities(id),
  tier INTEGER NOT NULL DEFAULT 1,
  qty INTEGER NOT NULL CHECK (qty > 0),
  price REAL NOT NULL CHECK (price > 0),
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS market_tx (
  id ${id},
  buyer_id INTEGER NOT NULL,
  seller_id INTEGER NOT NULL,
  scope TEXT NOT NULL DEFAULT 'local',
  commodity_id INTEGER NOT NULL,
  tier INTEGER NOT NULL DEFAULT 1,
  qty INTEGER NOT NULL,
  price_each REAL NOT NULL,
  total REAL NOT NULL,
  created_at BIGINT NOT NULL
);
-- Order beli (Tahap 4; diubah v2.3.0): dana TIDAK dikunci saat order
-- dipasang — pembeli baru dipotong saat penjual memenuhi order
-- (sell-to-order). qty_filled = yang sudah dipenuhi penjual; order
-- terbuka selama qty_filled < qty. Batal order tanpa refund.
CREATE TABLE IF NOT EXISTS market_buy_orders (
  id ${id},
  buyer_id INTEGER NOT NULL REFERENCES citizens(id),
  scope TEXT NOT NULL DEFAULT 'local',
  commodity_id INTEGER NOT NULL REFERENCES commodities(id),
  tier INTEGER NOT NULL DEFAULT 1,
  qty INTEGER NOT NULL CHECK (qty > 0),
  qty_filled INTEGER NOT NULL DEFAULT 0 CHECK (qty_filled >= 0),
  price REAL NOT NULL CHECK (price > 0),
  created_at BIGINT NOT NULL
);
-- Buku kas negara (Tahap 4, BUG-8): tiap pemasukan/pengeluaran kas negara
-- dicatat — pajak pasar masuk sini, bukan menguap. Disimpan selamanya.
CREATE TABLE IF NOT EXISTS treasury_tx (
  id ${id},
  kind TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  amount REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  -- Kas negara yang bersangkutan (redesain dunia): NULL = era negara
  -- tunggal lama (sebelum ada banyak negara).
  country_id INTEGER,
  created_at BIGINT NOT NULL
);
-- Tanda pasar (Tahap 4): heuristik deteksi harga di luar batas wajar +
-- pola wash trading. Hanya LOG untuk ditinjau admin — bukan ban otomatis.
CREATE TABLE IF NOT EXISTS market_flags (
  id ${id},
  kind TEXT NOT NULL,
  buyer_id INTEGER,
  seller_id INTEGER,
  commodity_id INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
-- Pengumuman update game (Tahap 4, "Apa yang Baru"): ditulis admin,
-- dibaca pemain. Nomor update stabil = urutan created_at (Update #1 =
-- pengumuman pertama yang pernah diterbitkan).
CREATE TABLE IF NOT EXISTS announcements (
  id ${id},
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  created_by INTEGER
);
CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  read_at BIGINT NOT NULL,
  UNIQUE(announcement_id, citizen_id)
);
CREATE TABLE IF NOT EXISTS fx_offers (
  id ${id},
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  direction TEXT NOT NULL,
  price REAL NOT NULL,
  qty_gold REAL NOT NULL CHECK (qty_gold >= 0),
  qty_filled REAL NOT NULL DEFAULT 0 CHECK (qty_filled >= 0),
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS fx_history (
  id ${id},
  price REAL NOT NULL,
  volume REAL NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id ${id},
  company_id INTEGER,
  is_admin INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  salary REAL NOT NULL,
  salary_type TEXT NOT NULL DEFAULT 'fixed',
  resource TEXT NOT NULL DEFAULT '',
  pay_qty INTEGER NOT NULL DEFAULT 0,
  share_pct REAL NOT NULL DEFAULT 0,
  level_min INTEGER NOT NULL DEFAULT 1,
  tier INTEGER NOT NULL DEFAULT 1,
  seats INTEGER NOT NULL DEFAULT 4,
  seats_taken INTEGER NOT NULL DEFAULT 0 CHECK (seats_taken >= 0 AND seats_taken <= seats),
  region_id INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS companies (
  id ${id},
  owner_id INTEGER NOT NULL REFERENCES citizens(id),
  name TEXT NOT NULL,
  about TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  region_id INTEGER NOT NULL,
  resource TEXT NOT NULL DEFAULT '',
  photo TEXT,
  photo_sm TEXT,
  bonus_credit INTEGER NOT NULL DEFAULT 0,
  bonus_given INTEGER NOT NULL DEFAULT 0,
  bonus_warned_at BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
-- Stok bahan perusahaan (v4.6.0, saran LIO): bahan produksi TIDAK LAGI
-- diambil diam-diam dari inventaris pemilik — pemilik mengisi stok ini
-- dulu (POST /api/companies/:id/stock); produksi harian (tick) + bonus
-- shift mengambil dari sini. Satu baris per (perusahaan, komoditas).
CREATE TABLE IF NOT EXISTS company_stock (
  id ${id},
  company_id INTEGER NOT NULL REFERENCES companies(id),
  commodity_id INTEGER NOT NULL REFERENCES commodities(id),
  qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  UNIQUE(company_id, commodity_id)
);
-- Jejak klik link share (v4.6.0): satu baris per (pemilik link, IP, hari)
-- — IP yang sama di hari yang sama untuk link yang sama TIDAK dihitung
-- lagi (UNIQUE). gold_given = 10 bila klik terhitung & kuota harian
-- belum habis, 0 bila duplikat-IP tidak mungkin (dicegah UNIQUE) atau
-- kuota 200/hari sudah habis. Jejak ini = audit admin (siapa pemilik,
-- berapa klik terhitung, berapa emas dibayar).
CREATE TABLE IF NOT EXISTS share_clicks (
  id ${id},
  owner_id INTEGER NOT NULL REFERENCES citizens(id),
  ip TEXT NOT NULL,
  day TEXT NOT NULL,
  gold_given INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  UNIQUE(owner_id, ip, day)
);
CREATE TABLE IF NOT EXISTS parties (
  id ${id},
  name TEXT NOT NULL,
  tag TEXT NOT NULL,
  ideology TEXT NOT NULL DEFAULT 'Konservatif',
  leader_id INTEGER NOT NULL REFERENCES citizens(id),
  type TEXT NOT NULL DEFAULT 'open',
  seats INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS party_members (
  party_id INTEGER NOT NULL REFERENCES parties(id),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  role TEXT NOT NULL DEFAULT 'member',
  joined_at BIGINT NOT NULL,
  UNIQUE(party_id, citizen_id)
);
-- Kursi parlemen PER NEGARA (redesain dunia): satu partai bisa punya kursi
-- di parlemen negara A dan 0 kursi di negara B. parties.seats (kolom lama,
-- satu angka global) tidak lagi dipakai — dipertahankan supaya migrasi
-- database lama tidak butuh rebuild tabel.
CREATE TABLE IF NOT EXISTS party_seats (
  party_id INTEGER NOT NULL REFERENCES parties(id),
  country_id INTEGER NOT NULL REFERENCES country(id),
  seats INTEGER NOT NULL DEFAULT 0 CHECK (seats >= 0),
  UNIQUE(party_id, country_id)
);
-- Usulan unifikasi wilayah (redesain dunia): warga wilayah merdeka
-- mengusulkan wilayahnya bergabung ke sebuah negara; warga wilayah itu
-- voting 3 hari. status: 'voting' | 'passed' | 'failed'.
CREATE TABLE IF NOT EXISTS country_joins (
  id ${id},
  country_id INTEGER NOT NULL REFERENCES country(id),
  region_id INTEGER NOT NULL REFERENCES regions(id),
  proposer_id INTEGER NOT NULL REFERENCES citizens(id),
  yes INTEGER NOT NULL DEFAULT 0 CHECK (yes >= 0),
  no INTEGER NOT NULL DEFAULT 0 CHECK (no >= 0),
  status TEXT NOT NULL DEFAULT 'voting' CHECK (status IN ('voting','passed','failed')),
  ends_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS country_join_votes (
  join_id INTEGER NOT NULL REFERENCES country_joins(id),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  vote TEXT NOT NULL,
  UNIQUE(join_id, citizen_id)
);
CREATE TABLE IF NOT EXISTS laws (
  id ${id},
  proposer_id INTEGER NOT NULL REFERENCES citizens(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'general',
  value REAL,
  effect_applied INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'voting',
  yes INTEGER NOT NULL DEFAULT 0,
  abstain INTEGER NOT NULL DEFAULT 0,
  no INTEGER NOT NULL DEFAULT 0,
  ends_at BIGINT NOT NULL,
  -- Negara yang UU ini berlaku (redesain dunia). NULL = UU era negara
  -- tunggal lama (sudah ditutup migrasi, hanya arsip).
  country_id INTEGER,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS law_votes (
  law_id INTEGER NOT NULL REFERENCES laws(id),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  vote TEXT NOT NULL,
  UNIQUE(law_id, citizen_id)
);
-- Anggaran negara (Tahap 5): diusulkan Menteri Ekonomi, divoting parlemen
-- 3 hari, bila lolos biayanya dipotong dari kas negara dan efeknya berlaku
-- 7 hari. kind: 'claim' | 'train' | 'war'.
CREATE TABLE IF NOT EXISTS budgets (
  id ${id},
  proposer_id INTEGER NOT NULL REFERENCES citizens(id),
  kind TEXT NOT NULL CHECK (kind IN ('claim', 'train', 'war')),
  amount INTEGER NOT NULL CHECK (amount >= 50 AND amount <= 500),
  status TEXT NOT NULL DEFAULT 'voting',
  yes INTEGER NOT NULL DEFAULT 0,
  no INTEGER NOT NULL DEFAULT 0,
  ends_at BIGINT NOT NULL,
  country_id INTEGER,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS budget_votes (
  budget_id INTEGER NOT NULL REFERENCES budgets(id),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  vote TEXT NOT NULL,
  UNIQUE(budget_id, citizen_id)
);
-- Pemakzulan presiden (Tahap 5): diusulkan anggota parlemen, divoting
-- 3 hari, bila lolos presiden dicopot (president_id = NULL sampai pemilu
-- berikutnya). Satu pemakzulan aktif dalam satu waktu.
CREATE TABLE IF NOT EXISTS impeachments (
  id ${id},
  president_id INTEGER NOT NULL REFERENCES citizens(id),
  proposer_id INTEGER NOT NULL REFERENCES citizens(id),
  status TEXT NOT NULL DEFAULT 'voting',
  yes INTEGER NOT NULL DEFAULT 0,
  no INTEGER NOT NULL DEFAULT 0,
  ends_at BIGINT NOT NULL,
  country_id INTEGER,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS impeachment_votes (
  impeachment_id INTEGER NOT NULL REFERENCES impeachments(id),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  vote TEXT NOT NULL,
  UNIQUE(impeachment_id, citizen_id)
);
CREATE TABLE IF NOT EXISTS elections (
  id ${id},
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  opens_at BIGINT NOT NULL,
  closes_at BIGINT NOT NULL,
  winner_id INTEGER,
  -- Negara yang pemilu ini (redesain dunia). NULL = pemilu era negara
  -- tunggal lama (sudah ditutup migrasi, hanya arsip).
  country_id INTEGER,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS election_candidates (
  election_id INTEGER NOT NULL REFERENCES elections(id),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  party_id INTEGER,
  votes INTEGER NOT NULL DEFAULT 0,
  UNIQUE(election_id, citizen_id)
);
CREATE TABLE IF NOT EXISTS election_votes (
  election_id INTEGER NOT NULL REFERENCES elections(id),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  candidate_id INTEGER NOT NULL,
  UNIQUE(election_id, citizen_id)
);
CREATE TABLE IF NOT EXISTS wars (
  id ${id},
  name TEXT NOT NULL,
  region_id INTEGER NOT NULL REFERENCES regions(id),
  attacker_label TEXT NOT NULL,
  -- Pembela: nama negara pemilik wilayah, atau 'Pembela <Wilayah>' bila
  -- wilayah merdeka. Diisi saat perang dimulai (bukan default negara).
  defender_label TEXT NOT NULL DEFAULT '',
  score_a INTEGER NOT NULL DEFAULT 0 CHECK (score_a >= 0),
  score_d INTEGER NOT NULL DEFAULT 0 CHECK (score_d >= 0),
  status TEXT NOT NULL DEFAULT 'active',
  winner TEXT NOT NULL DEFAULT '',
  ends_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS war_attacks (
  id ${id},
  war_id INTEGER NOT NULL REFERENCES wars(id),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  side TEXT NOT NULL,
  damage INTEGER NOT NULL,
  ammo TEXT NOT NULL DEFAULT 'Senjata',
  created_at BIGINT NOT NULL
);
-- Unit militer (Tahap 6): satu baris per (warga, jenis unit). qty bisa 0
-- (baris dihapus saat habis — disband menghapus barisnya). CHECK menjaga
-- jenis tetap dalam daftar MILITARY_UNITS (game.js).
CREATE TABLE IF NOT EXISTS military_units (
  id ${id},
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  unit_type TEXT NOT NULL CHECK (unit_type IN ('infantry','drone','heavy')),
  qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  created_at BIGINT NOT NULL,
  UNIQUE(citizen_id, unit_type)
);
CREATE TABLE IF NOT EXISTS war_support (
  region_id INTEGER NOT NULL REFERENCES regions(id),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  UNIQUE(region_id, citizen_id)
);
CREATE TABLE IF NOT EXISTS newspapers (
  id ${id},
  owner_id INTEGER NOT NULL REFERENCES citizens(id),
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS articles (
  id ${id},
  newspaper_id INTEGER NOT NULL REFERENCES newspapers(id),
  author_id INTEGER NOT NULL REFERENCES citizens(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  cover TEXT,
  cover_sm TEXT,
  topic TEXT NOT NULL DEFAULT 'Pengumuman',
  views INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  dislikes INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS article_reactions (
  article_id INTEGER NOT NULL REFERENCES articles(id),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  reaction TEXT NOT NULL,
  UNIQUE(article_id, citizen_id)
);
-- (Tahap 8) Jejak baca artikel: 1 baris per warga per artikel per hari
-- (UTC). Kolom articles.views hanya naik bila baris ini baru — refresh
-- berulang tidak lagi menggembungkan views (skor Liga Pers memakai views,
-- jadi hitungan lama bisa dimanipulasi). PRIMARY KEY rangkap = penolak
-- duplikat di level database (ON CONFLICT DO NOTHING di route baca).
CREATE TABLE IF NOT EXISTS article_views (
  article_id INTEGER NOT NULL REFERENCES articles(id),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  day TEXT NOT NULL,
  PRIMARY KEY (article_id, citizen_id, day)
);
CREATE TABLE IF NOT EXISTS article_comments (
  id ${id},
  article_id INTEGER NOT NULL REFERENCES articles(id),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  content TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id ${id},
  room TEXT NOT NULL,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  content TEXT NOT NULL,
  article_id INTEGER,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_reports (
  id ${id},
  reporter_id INTEGER NOT NULL REFERENCES citizens(id),
  message_id INTEGER NOT NULL REFERENCES chat_messages(id),
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  -- Putusan admin (v3.0.0): '' = belum diputus, 'proven' = terbukti benar
  -- (skor penulis pesan −10), 'not_proven' = tidak terbukti (tanpa efek).
  verdict TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
-- Riwayat perubahan skor kredit (v3.0.0): siapa, berapa, kenapa, kapan --
-- dibaca admin lewat GET /api/admin/credit-history/:userId.
CREATE TABLE IF NOT EXISTS credit_history (
  id ${id},
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  delta INTEGER NOT NULL,
  score_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS blocked (
  blocker_id INTEGER NOT NULL REFERENCES citizens(id),
  blocked_id INTEGER NOT NULL REFERENCES citizens(id),
  UNIQUE(blocker_id, blocked_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id ${id},
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  category TEXT NOT NULL DEFAULT 'SISTEM',
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS dms (
  id ${id},
  from_id INTEGER NOT NULL REFERENCES citizens(id),
  to_id INTEGER NOT NULL REFERENCES citizens(id),
  content TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS achievements (
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  akey TEXT NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(citizen_id, akey)
);
-- Misi harian + kronik (Tahap 7): dulu tiga kolom JSON TEXT di citizens
-- (missions, chronicle_done, chronicle_claimed) — pindah ke tabel
-- relasional supaya progres/klaim tidak bisa hilang karena balapan
-- read-modify-write. UNIQUE di tiap tabel membuat klaim ganda mustahil
-- di level database, bukan hanya di level kode. Lihat helper di atas
-- (missionValue/setMissionValue/markChronicleDone) + migrasi
-- migrateStage7Columns yang memindahkan data lama.
CREATE TABLE IF NOT EXISTS mission_progress (
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  mkey TEXT NOT NULL,
  value BIGINT NOT NULL DEFAULT 0,
  UNIQUE(citizen_id, mkey)
);
CREATE TABLE IF NOT EXISTS mission_claims (
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  mkey TEXT NOT NULL,
  claimed_at BIGINT NOT NULL,
  UNIQUE(citizen_id, mkey)
);
CREATE TABLE IF NOT EXISTS chronicle_done (
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  ckey TEXT NOT NULL,
  done_at BIGINT NOT NULL,
  UNIQUE(citizen_id, ckey)
);
CREATE TABLE IF NOT EXISTS chronicle_claims (
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  chapter INTEGER NOT NULL,
  claimed_at BIGINT NOT NULL,
  UNIQUE(citizen_id, chapter)
);
-- (v4.4.0) Iklan berhadiah AdinPlay — token tontonan satu kali pakai:
-- diterbitkan POST /api/ads/start, dipakai POST /api/ads/reward, lalu
-- ditandai used_at. Token kedaluwarsa (expires_at lewat) tidak bisa
-- dipakai. Baris lama tidak dihapus (jejak audit) — tabel kecil, satu
-- baris per tontonan yang dimulai.
CREATE TABLE IF NOT EXISTS ad_tokens (
  token TEXT PRIMARY KEY,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  expires_at BIGINT NOT NULL,
  used_at BIGINT
);
-- (v4.4.0) Jejak audit hadiah iklan: 1 baris per grant +30 emas, supaya
-- admin bisa melihat siapa saja yang menerima hadiah iklan dan kapan.
CREATE TABLE IF NOT EXISTS ad_rewards (
  id ${id},
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  gold INTEGER NOT NULL,
  granted_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS convoys (
  id ${id},
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  slot INTEGER NOT NULL,
  building TEXT NOT NULL,
  region_id INTEGER NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS organizations (
  id ${id},
  name TEXT NOT NULL,
  tag TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Kerja Sama',
  leader_id INTEGER NOT NULL REFERENCES citizens(id),
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS org_members (
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  joined_at BIGINT NOT NULL,
  UNIQUE(org_id, citizen_id)
);
-- Pakta antar organisasi (Tahap 5 — diplomasi tanpa multi-negara):
-- org_a_id < org_b_id selalu (diurutkan di kode agar UNIQUE bekerja dua
-- arah). kind: 'trade' (pajak antar anggota dipotong 50%) | 'defense'
-- (anggota +10% kerusakan perang). status: 'pending' (menunggu ketua
-- organisasi satunya menyetujui) | 'active'.
CREATE TABLE IF NOT EXISTS org_pacts (
  id ${id},
  org_a_id INTEGER NOT NULL REFERENCES organizations(id),
  org_b_id INTEGER NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL CHECK (kind IN ('trade', 'defense')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  proposer_id INTEGER NOT NULL REFERENCES citizens(id),
  created_at BIGINT NOT NULL,
  UNIQUE(org_a_id, org_b_id, kind)
);
CREATE TABLE IF NOT EXISTS support_tickets (
  id ${id},
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  type TEXT NOT NULL,
  topic TEXT NOT NULL,
  details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'baru',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS world (
  id INTEGER PRIMARY KEY,
  day INTEGER NOT NULL DEFAULT 1,
  last_tick_date TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_market_offers ON market_offers(scope, commodity_id);
CREATE INDEX IF NOT EXISTS idx_chat_room ON chat_messages(room, created_at);
CREATE INDEX IF NOT EXISTS idx_articles_created ON articles(created_at);
CREATE INDEX IF NOT EXISTS idx_notif_citizen ON notifications(citizen_id, created_at);
CREATE INDEX IF NOT EXISTS idx_market_offers_seller ON market_offers(seller_id);
CREATE INDEX IF NOT EXISTS idx_chat_citizen ON chat_messages(citizen_id);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(citizen_id, is_read);
CREATE INDEX IF NOT EXISTS idx_dms_pair ON dms(from_id, to_id);
CREATE INDEX IF NOT EXISTS idx_dms_pair_rev ON dms(to_id, from_id);
CREATE INDEX IF NOT EXISTS idx_inventory_citizen ON inventory(citizen_id);
CREATE INDEX IF NOT EXISTS idx_fx_offers_citizen ON fx_offers(citizen_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_fx_offers_expires ON fx_offers(expires_at);
CREATE INDEX IF NOT EXISTS idx_war_attacks_war ON war_attacks(war_id);
CREATE INDEX IF NOT EXISTS idx_articles_author ON articles(author_id);
CREATE INDEX IF NOT EXISTS idx_articles_newspaper ON articles(newspaper_id);
CREATE INDEX IF NOT EXISTS idx_newspapers_owner ON newspapers(owner_id);
CREATE INDEX IF NOT EXISTS idx_market_tx_buyer ON market_tx(buyer_id);
CREATE INDEX IF NOT EXISTS idx_market_tx_seller ON market_tx(seller_id);
CREATE INDEX IF NOT EXISTS idx_market_buy_orders ON market_buy_orders(scope, commodity_id);
CREATE INDEX IF NOT EXISTS idx_market_buy_orders_buyer ON market_buy_orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_treasury_tx_created ON treasury_tx(created_at);
CREATE INDEX IF NOT EXISTS idx_share_clicks_owner_day ON share_clicks(owner_id, day);
CREATE INDEX IF NOT EXISTS idx_market_flags_created ON market_flags(created_at);
CREATE INDEX IF NOT EXISTS idx_announcement_reads_citizen ON announcement_reads(citizen_id);
CREATE INDEX IF NOT EXISTS idx_convoys_citizen ON convoys(citizen_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_elections_status ON elections(status);
CREATE INDEX IF NOT EXISTS idx_laws_status ON laws(status, ends_at);
-- Indeks country_id TIDAK di sini: kolomnya ditambah migrasi
-- migrateWorldRedesign (DB lama belum punya kolomnya saat schema() jalan —
-- CREATE INDEX di sini akan menggagalkan initDb). Indeks itu dibuat di
-- migrasi, setelah ADD COLUMN (pola yang sama seperti
-- idx_citizens_last_seen di migrateOnlineColumns).
CREATE INDEX IF NOT EXISTS idx_appeals_user ON appeals(user_id, status);
CREATE INDEX IF NOT EXISTS idx_referral_pending_newcomer ON referral_pending(newcomer_id, status);
CREATE INDEX IF NOT EXISTS idx_referral_pending_referrer ON referral_pending(referrer_id, status, paid_day);
`;
}

// --- Data statis (bukan bot): wilayah, komoditas, negara, lowongan ADMIN ---
export const REGIONS = [
  { name: 'Kepulauan Riau', type: 'Pesisir', score: 7, bonus: '' },
  { name: 'Jakarta', type: 'Ibu Kota', score: 10, bonus: '' },
  { name: 'Jawa Barat', type: 'Daratan', score: 8, bonus: '' },
  { name: 'Jawa Tengah', type: 'Daratan', score: 8, bonus: '' },
  { name: 'Jawa Timur', type: 'Daratan', score: 8, bonus: 'Gandum Mentah +15%' },
  { name: 'Sumatera Utara', type: 'Daratan', score: 7, bonus: '' },
  { name: 'Sumatera Barat', type: 'Pesisir', score: 7, bonus: 'Minyak Mentah +15%' },
  { name: 'Sumatera Selatan', type: 'Daratan', score: 7, bonus: 'Batu Bara +15%' },
  { name: 'Kalimantan Barat', type: 'Daratan', score: 6, bonus: 'Kayu +25%' },
  { name: 'Kalimantan Timur', type: 'Daratan', score: 6, bonus: 'Batu Bara +30%' },
  { name: 'Kalimantan Selatan', type: 'Daratan', score: 6, bonus: 'Kayu +25%' },
  { name: 'Sulawesi Selatan', type: 'Pesisir', score: 7, bonus: '' },
  { name: 'Sulawesi Utara', type: 'Pesisir', score: 6, bonus: '' },
  { name: 'Bali', type: 'Pesisir', score: 8, bonus: '' },
  { name: 'Nusa Tenggara Barat', type: 'Pesisir', score: 6, bonus: '' },
  { name: 'Nusa Tenggara Timur', type: 'Pesisir', score: 5, bonus: '' },
  { name: 'Papua', type: 'Pegunungan', score: 5, bonus: 'Tembaga Mentah +20%' },
];

export const COMMODITIES = [
  { name: 'Makanan', category: 'Perbekalan', usd: 10.80, gold: 0.56 },
  { name: 'Senjata', category: 'Senjata', usd: 10.80, gold: 0.46 },
  { name: 'Tiket', category: 'Perjalanan', usd: 22.39, gold: 1.32 },
  { name: 'Kapal', category: 'Armada', usd: 65.00, gold: 2.55 },
  { name: 'Drone', category: 'Armada', usd: 90.00, gold: 2.45 },
  { name: 'Gandum Mentah', category: 'Bahan Mentah', usd: 1.20, gold: 0.05 },
  { name: 'Besi Mentah', category: 'Bahan Mentah', usd: 1.10, gold: 0.04 },
  { name: 'Minyak Mentah', category: 'Bahan Mentah', usd: 1.16, gold: 0.06 },
  { name: 'Kapas Mentah', category: 'Bahan Mentah', usd: 2.00, gold: 0.06 },
  { name: 'Kayu', category: 'Bahan Mentah', usd: 1.00, gold: 0.06 },
  { name: 'Batu Bara', category: 'Bahan Mentah', usd: 1.22, gold: 0.07 },
  { name: 'Tembaga Mentah', category: 'Bahan Mentah', usd: 1.99, gold: 0.06 },
  { name: 'Bahan Bangunan', category: 'Komponen', usd: 17.85, gold: 0.62 },
  { name: 'Bahan Bakar', category: 'Komponen', usd: 27.99, gold: 0.60 },
  { name: 'Elektronik', category: 'Komponen', usd: 18.00, gold: 0.63 },
  // Minuman Energi (v3.1.0, tiket #17 LIO): 0,10 emas/kaleng, +1 energi.
  { name: 'Minuman Energi', category: 'Perbekalan', usd: 1.83, gold: 0.10 },
];

// Lowongan resmi ADMIN — satu-satunya pekerjaan di awal permainan (modal awal).
// ATURAN: lowongan ADMIN dibayar BAHAN MENTAH, bukan uang. `salary` hanya nilai
// setara USD (untuk statistik/sortir); yang diterima per shift adalah `qty`
// unit `resource` (harga pasar bahan ~1–2 USD/unit, jadi jumlahnya puluhan
// unit agar nilainya ≈ gaji lama ~48 USD/shift). Pekerjaan perusahaan pemain
// tetap dibayar seperti semula (USD tetap / bagi hasil).
// Pengumuman pertama (Update #1, Tahap 4) — di-seed sekali saat tabel
// announcements masih kosong. Isinya ringkasan semua perubahan Tahap 4;
// pengumuman berikutnya ditulis admin lewat /api/admin/announcements.
export const ANNOUNCEMENT_TAHAP4_TITLE = 'Pasar Lebih Dalam, Energi Pulih Otomatis & Tampilan Baru';
export const ANNOUNCEMENT_TAHAP4_BODY = `PASAR & EKONOMI
• Grafik harga: tiap komoditas kini punya grafik harga 14 hari dari transaksi nyata antar pemain.
• Order beli: kamu bisa pasang harga belimu sendiri — penjual bisa langsung menjual ke ordermu. Dana dikunci aman saat order dipasang dan kembali bila dibatalkan.
• Pajak masuk kas negara: pajak 2% dari penjualan kini benar-benar masuk kas negara (bukan menguap). Saldo + riwayat pemasukan/pengeluaran bisa dilihat di halaman Negara.
• Pabrik butuh bahan: Pabrik kini mengolah 2× Besi Mentah menjadi 1× Bahan Bangunan setiap hari. Tanpa besi, pabrik berhenti berproduksi.

ENERGI
• Energi pulih otomatis +2 setiap 1 menit sampai batas maksimum — termasuk saat kamu offline, dihitung dari waktu yang berlalu.
• Batas energi naik per level: 100 + 5×(level−1). Bonus Premium +20 dan Rumah Sakit Lapangan +10 tetap berlaku di atasnya.

PERBAIKAN & TAMPILAN
• Badge level di perisai HUD yang terpotong di HP (angka "3/5" kepotong atasnya) kini tampil utuh.
• Tampilan lebih hidup: animasi halus saat pindah halaman dan tombol beranimasi saat ditekan.
• Suara ketukan halus setiap kali menekan tombol — bisa dimatikan di Pengaturan.
• Baru: pengumuman update ("Apa yang Baru") di Notifikasi, dan arsip lengkapnya di Buku Panduan → Riwayat Update.
• Hadiah barang tanpa batas jumlah: admin kini bisa memberi makanan, bahan mentah, dan barang lain sebanyak apa pun (emas/Rupiah tetap dibatasi 1.000.000, Premium 365 hari).
• Keamanan pasar: harga jauh di luar batas wajar kini ditolak, dan pola perdagangan bolak-balik yang mencurigakan dicatat untuk ditinjau admin. Data lama (chat >90 hari dan lainnya) kini dibersihkan otomatis setiap hari.`;

// Pengumuman kedua (Update #2, Tahap 5) — di-seed sekali saat judulnya
// belum ada (bukan saat tabel kosong, karena Update #1 sudah terbit).
// Isinya ringkasan semua perubahan Tahap 5 + perbaikan bug region awal.
export const ANNOUNCEMENT_TAHAP5_TITLE = 'UU Kini Berpengaruh, Menteri Punya Wewenang & Pakta Organisasi';
export const ANNOUNCEMENT_TAHAP5_BODY = `PEMERINTAHAN
• Undang-undang kini benar-benar berpengaruh: UU yang lolos voting parlemen kini mengubah angka game — pajak penghasilan (1–5%), upah lowongan ADMIN (80–120%), dan biaya perjalanan (1 atau 2 Tiket). UU umum tanpa efek angka tetap bisa diusulkan dan ditandai jelas.
• Anggaran negara: Menteri Ekonomi bisa mengusulkan anggaran (pasokan harian +2 emas, latihan 10% lebih murah, atau dana perang +10% kerusakan) — diputuskan parlemen lewat voting 3 hari dan dibayar dari kas negara.
• Menteri punya wewenang nyata: Menteri Pertahanan bisa memobilisasi (+10% kerusakan perang 24 jam, 100 emas kas negara); Menteri Dalam Negeri bisa menetapkan hari libur (+20 energi untuk semua warga, 50 emas kas negara, sekali per 24 jam).
• Pemakzulan: anggota parlemen kini bisa mengusulkan pemakzulan presiden — bila voting lolos, presiden dicopot sampai pemilu berikutnya.

DIPLOMASI
• Pakta antar organisasi: dua organisasi kini bisa mengikat perjanjian dagang (pajak penghasilan antar anggotanya dipotong 50%) atau pakta pertahanan (+10% kerusakan perang bagi anggotanya). Pakta harus disetujui ketua kedua organisasi dan bisa dibubarkan kapan saja.

PERBAIKAN BUG
• Pemain baru tidak lagi semuanya lahir di Kepulauan Riau: wilayah awal kini dipilih acak dan merata dari semua wilayah yang ada. Pemain yang sudah ada tidak dipindah — hanya pendaftaran baru yang memakai wilayah acak.
• Waktu chat kini tampil benar: semua pesan chat sebelumnya menampilkan "Invalid Date" — penyebabnya format waktu dari database yang tidak dikenali browser. Sekarang waktu tampil sebagai jam yang benar ("baru saja", "5 mnt lalu", dst.).
• Game lebih ringan: polling otomatis kini berhenti saat tab tidak aktif (dan langsung menyegarkan saat tab dibuka lagi), dan data dunia di-cache 30 detik — supaya koneksi database tidak berebut dan game tidak terasa nge-lag. Catatan jujur: jeda saat membuka game pertama kali (cold start server gratis) masih bisa terjadi — itu batas paket gratis, bukan bug.
• Server sempat hampir mati karena antrean cold start: setiap kali server bangun, ia menjalankan migrasi berat sambil mengunci database, sehingga yang lain antre puluhan detik lalu timeout. Kini cold start tidak lagi menjalankan migrasi — migrasi hanya jalan sekali tiap update, jadi game tidak lagi timeout saat banyak pemain membuka bersamaan.
• Menulis artikel kini bisa lagi: tombol TULIS ARTIKEL sebelumnya tidak berfungsi karena aturan keamanan browser memblokir tombol-tombol di dalam halaman. Semua tombol navigasi di dalam halaman kini diperbaiki — termasuk pencarian wilayah yang ikut mati.
• Log peringatan admin di server kini tidak lagi berisik: status jalan darurat admin cukup dilihat di Panel Admin.

TAMPILAN BARU
• Tampilan dirombak mengikuti gaya Parlamentum: header dengan perisai level besar, pasokan harian kini di tombol peti di kiri atas (berdenyut emas bila belum diambil), banner undang-undang yang sedang divoting, kartu KRONIKMU dan profil baru, serta rincian energi dan kelelahan saat diketuk. Tampilannya saja yang berubah — semua aturan dan angka game tetap sama.`;

export const ADMIN_JOBS = [  { title: 'Pekerja Gudang Pelabuhan', salary: 48, resource: 'Besi Mentah', qty: 44, region: 'Kepulauan Riau', desc: 'Bongkar muat peti kemas di pelabuhan. Kerja fisik, dibayar besi mentah.' },
  { title: 'Kurir Kota', salary: 46, resource: 'Minyak Mentah', qty: 40, region: 'Kepulauan Riau', desc: 'Antar paket keliling kota. Butuh stamina dan hafal jalan.' },
  { title: 'Pembersih Jalan Kota', salary: 44, resource: 'Kayu', qty: 44, region: 'Jakarta', desc: 'Jaga kebersihan jalan ibu kota setiap pagi.' },
  { title: 'Asisten Toko Kelontong', salary: 45, resource: 'Gandum Mentah', qty: 38, region: 'Jawa Barat', desc: 'Melayani pembeli, menata rak, dan menjaga kasir.' },
  { title: 'Buruh Tani', salary: 42, resource: 'Kapas Mentah', qty: 21, region: 'Jawa Timur', desc: 'Panen dan olah hasil kebun. Bonus panen saat musim raya.' },
  { title: 'Penjaga Malam Pasar', salary: 47, resource: 'Batu Bara', qty: 39, region: 'Sumatera Utara', desc: 'Ronda malam di pasar tradisional sampai subuh.' },
  // Perluasan 27 Nov 2026 (perintah pemilik): lowongan ADMIN ada di SEMUA
  // 17 wilayah — satu per wilayah yang belum punya. Judul unik per
  // lowongan (dipakai runDataFixups untuk mengenali lowongan ADMIN).
  { title: 'Pekerja Gudang Logistik', salary: 46, resource: 'Besi Mentah', qty: 42, region: 'Jawa Tengah', desc: 'Atur stok dan bongkar muat di gudang logistik.' },
  { title: 'Pemandu Wisata Danau', salary: 44, resource: 'Kayu', qty: 40, region: 'Sumatera Barat', desc: 'Antar wisatawan keliling danau dan jelaskan sejarahnya.' },
  { title: 'Buruh Perkebunan Karet', salary: 45, resource: 'Kapas Mentah', qty: 24, region: 'Sumatera Selatan', desc: 'Sadap karet dan olah hasil kebun setiap pagi.' },
  { title: 'Pekerja Hutan Lestari', salary: 46, resource: 'Kayu', qty: 44, region: 'Kalimantan Barat', desc: 'Rawat hutan lestari dan panen kayu legal.' },
  { title: 'Pekerja Tambang Batu Bara', salary: 47, resource: 'Batu Bara', qty: 40, region: 'Kalimantan Timur', desc: 'Kerja di tambang batu bara dengan alat berat.' },
  { title: 'Sopir Angkutan Sungai', salary: 45, resource: 'Minyak Mentah', qty: 38, region: 'Kalimantan Selatan', desc: 'Antar barang lewat sungai dengan perahu motor.' },
  { title: 'Nelayan Pesisir', salary: 44, resource: 'Gandum Mentah', qty: 36, region: 'Sulawesi Selatan', desc: 'Melayang di laut dan jual hasil tangkapan di pasar.' },
  { title: 'Pekerja Pelabuhan Manado', salary: 46, resource: 'Besi Mentah', qty: 40, region: 'Sulawesi Utara', desc: 'Bongkar muat kapal di pelabuhan Manado.' },
  { title: 'Pelayan Warung Pantai', salary: 44, resource: 'Kapas Mentah', qty: 22, region: 'Bali', desc: 'Layani wisatawan di warung tepi pantai.' },
  { title: 'Pemandu Pendaki Rinjani', salary: 43, resource: 'Kayu', qty: 38, region: 'Nusa Tenggara Barat', desc: 'Pandu pendaki dan jaga jalur gunung.' },
  { title: 'Penjaga Pelabuhan Kupang', salary: 45, resource: 'Batu Bara', qty: 36, region: 'Nusa Tenggara Timur', desc: 'Jaga keamanan pelabuhan Kupang siang dan malam.' },
  { title: 'Pekerja Perkebunan Sagu', salary: 46, resource: 'Gandum Mentah', qty: 42, region: 'Papua', desc: 'Olah sagu di perkebunan dan kirim ke pasar.' },
];

// Pastikan SEMUA lowongan ADMIN ada (satu per judul di ADMIN_JOBS) —
// idempotent, dipakai seed DB baru DAN runDataFixups (DB lama yang hanya
// punya 6 lowongan lama mendapat 12 lowongan baru tanpa migrasi skema).
// Kursi ADMIN = ADMIN_JOB_SEATS (tanpa batas pekerja); lowongan ADMIN lama
// (kursi 4) ikut dinaikkan. `db` = { one, run } (modul atau transaksi).
async function ensureAdminJobs(db) {
  const now = Date.now();
  for (const j of ADMIN_JOBS) {
    const reg = await db.one('SELECT id FROM regions WHERE name = ?', [j.region]);
    if (!reg) continue;
    const existing = await db.one('SELECT id, seats FROM jobs WHERE is_admin = 1 AND title = ?', [j.title]);
    if (!existing) {
      await db.run(`INSERT INTO jobs (company_id, is_admin, title, salary, salary_type, resource, pay_qty, level_min, tier, seats, seats_taken, region_id, description, created_at)
        VALUES (NULL,1,?,?, 'goods', ?, ?,1,1,?,0,?,?,?) RETURNING id`,
        [j.title, j.salary, j.resource, j.qty, ADMIN_JOB_SEATS, reg.id, j.desc, now]);
    } else if (Number(existing.seats) !== ADMIN_JOB_SEATS) {
      await db.run('UPDATE jobs SET seats = ? WHERE id = ?', [ADMIN_JOB_SEATS, existing.id]);
    }
  }
}

export async function closeDb() {
  if (pool) { try { await pool.end(); } catch { /* abaikan */ } pool = null; poolPromise = null; }
  if (sqliteDb) { try { sqliteDb.close(); } catch { /* abaikan */ } sqliteDb = null; }
}

export async function initDb() {
  const dialect = isPg ? 'pg' : 'sqlite';
  // Jalur cepat (steady state — DB sudah dimigrasi): SATU query murah ke
  // db_meta, TANPA advisory lock, TANPA DDL. Inilah perbaikan insiden
  // 27 Nov 2026: initDb lama menahan lock global selama ~100 round-trip
  // ke Neon di setiap cold start, sehingga cold start antre puluhan detik.
  // Fixup data murah tetap jalan tiap boot (lihat runDataFixups).
  if ((await schemaVersion()) === String(SCHEMA_VERSION)) {
    await runDataFixups();
    return;
  }
  // Jalur lambat — hanya saat DB baru atau versi lama (sekali per deploy):
  // seluruh migrasi jalan dalam SATU transaksi di bawah advisory lock
  // (dua cold start tidak bisa balapan membuat tabel yang sama; gagal =
  // rollback total, coba lagi bersih). Instance lain yang menunggu lock
  // mengecek ulang versi DI DALAM lock dan langsung kembali bila migrasi
  // sudah diselesaikan instance lain — jadi antrean hanya sepanjang SATU
  // migrasi, bukan sepanjang setiap cold start.
  const migrated = await tx(async (t) => {
    if (isPg && process.env.PG_MEM_TEST !== '1') {
      // pg-mem tidak mengenal pg_advisory_xact_lock; di sana tidak ada
      // instance paralel sehingga lock memang tidak diperlukan.
      await t.sql('SELECT pg_advisory_xact_lock(?::bigint)', [INITDB_LOCK_KEY]);
    }
    // Tabel penanda dibuat lewat schema() di bawah agar baca versi di dalam
    // transaksi tidak bisa gagal (error di dalam transaksi Postgres
    // membatalkan transaksi). CREATE TABLE IF NOT EXISTS di sini no-op
    // untuk DB yang sudah dimigrasi; DDL berat (ALTER kolom dsb.) tetap
    // di-gate versi di bawah.
    if (isPg) await cleanupOrphanTypes(t);
    await t.exec(schema(dialect));
    const current = await t.one("SELECT value FROM db_meta WHERE key = 'schema_version'");
    if (current?.value === String(SCHEMA_VERSION)) return false;
    if (isPg) await migrateTimestampsToBigint(t);
    await migrateUserColumns(t);
    await migrateAdminJobs(t);
    await migrateSupportTickets(t);
    await migrateTahap4Columns(t);
    await migrateTahap5Columns(t);
    await migrateOnlineColumns(t);
    await migrateTrainCooldownColumns(t);
    await migrateArticleImageColumns(t);
    await migrateWorldRedesign(t);
    await migrateTravelColumns(t);
    await migrateCompanyColumns(t);
    await migrateCreditColumns(t);
    await migrateXpRollback(t);
    await migrateStage6Columns(t);
    await migrateStage7Columns(t);
    await migrateStage8Columns(t);
    await migrateAutoWorkColumns(t);
    await migrateShareColumns(t);
    await seed(t);
    // Penanda versi ditulis DI DALAM transaksi migrasi: bila migrasi gagal
    // dan rollback, penanda ikut batal — cold start berikutnya mengulang
    // migrasi dari awal, bukan mengira DB sudah siap.
    const existing = await t.one("SELECT value FROM db_meta WHERE key = 'schema_version'");
    if (existing) await t.run("UPDATE db_meta SET value = ? WHERE key = 'schema_version'", [String(SCHEMA_VERSION)]);
    else await t.run("INSERT INTO db_meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
    return true;
  });
  // CHECK saldo/qty: DI LUAR transaksi utama (satu constraint yang gagal —
  // mis. ada data lama yang melanggar — tidak boleh menggagalkan seluruh
  // initDb). Hanya jalan bila migrasi baru saja dilakukan di panggilan ini
  // (bukan tiap cold start) — dan hanya instance yang bermigrasi yang
  // menjalankannya, jadi tidak ada lagi balapan antar cold start.
  if (migrated) await migrateChecks();
  await runDataFixups();
}

// Perbaikan data murah yang jalan di SETIAP boot (di luar version gate):
//  - semua user yang belum punya kode referral dibuatkan kode unik
//    (registrasi baru selalu mengisi kode; ini hanya untuk baris lama);
//  - akun ADMIN_EMAIL selalu ditandai is_admin = 1 (pengaman akun admin
//    Khalid yang sudah ada; registrasi BARU tidak lagi memberi admin dari
//    email — lihat api-core.js);
//  - akun admin tidak boleh berstatus banned — bila ada yang is_banned=1
//    (mis. ke-ban sebelum flag admin ada), ban-nya dicabut di sini;
//  - lowongan ADMIN selalu bergaji bahan mentah (aturan Tahap 2).
// Semua query berindeks / tabel kecil — tidak ada DDL, tidak ada lock
// panjang. Sengaja TIDAK di-gate versi: tes e2e §15 mengandalkan fixup
// cabut-ban admin ini jalan tiap boot (restart server).
async function runDataFixups() {
  const missing = await sql('SELECT id FROM users WHERE referral_code IS NULL');
  for (const u of missing) {
    const code = await generateReferralCode();
    await run('UPDATE users SET referral_code = ? WHERE id = ?', [code, u.id]);
  }
  await run('UPDATE users SET is_admin = 1 WHERE email = ?', [ADMIN_EMAIL]);
  await run("UPDATE users SET is_banned = 0, banned_reason = '', banned_at = 0 WHERE is_admin = 1 AND is_banned = 1");
  // Minuman Energi (v3.1.0, tiket #17): komoditas baru — seed hanya jalan
  // bila tabel commodities kosong, jadi DB lama dilengkapi di sini
  // (tiap boot, murah: satu SELECT + INSERT bila belum ada).
  const drink = await one("SELECT id FROM commodities WHERE name = 'Minuman Energi'");
  if (!drink) await run("INSERT INTO commodities (name, category, ref_usd, ref_gold) VALUES ('Minuman Energi', 'Perbekalan', 1.83, 0.10)");
  // Lowongan ADMIN baru (perluasan 12 wilayah) juga masuk ke DB lama —
  // runDataFixups jalan tiap boot (jalur cepat), jadi tidak butuh migrasi.
  await ensureAdminJobs({ one, run });
  for (const j of ADMIN_JOBS) {
    await run(
      "UPDATE jobs SET salary_type = 'goods', resource = ?, pay_qty = ?, salary = ? WHERE is_admin = 1 AND title = ?",
      [j.resource, j.qty, j.salary, j.title]);
  }
}

// Kolom yang menyimpan timestamp milidetik (Date.now()) — di Postgres harus
// BIGINT: INTEGER (int4) overflow pada nilai ~1,8 triliun (error 22003).
// Di SQLite BIGINT sama saja dengan INTEGER (64-bit), jadi satu skema untuk
// kedua dialek. Daftar ini juga dipakai migrasi untuk database yang sudah
// terlanjur dibuat dengan kolom INTEGER.
const TS_COLUMNS = ['created_at', 'expires_at', 'ends_at', 'opens_at', 'closes_at', 'joined_at', 'last_chat_at', 'premium_until'];

// Semua nama tabel di skema — dipakai membersihkan tipe komposit yatim.
const TABLE_NAMES = ['users', 'admin_actions', 'appeals', 'appeal_messages', 'citizens', 'regions', 'commodities', 'inventory', 'market_offers', 'market_tx', 'market_buy_orders', 'treasury_tx', 'market_flags', 'announcements', 'announcement_reads', 'fx_offers', 'fx_history', 'jobs', 'companies', 'company_stock', 'share_clicks', 'country', 'party_seats', 'country_joins', 'country_join_votes', 'parties', 'party_members', 'laws', 'law_votes', 'budgets', 'budget_votes', 'impeachments', 'impeachment_votes', 'elections', 'election_candidates', 'election_votes', 'wars', 'war_attacks', 'war_support', 'military_units', 'newspapers', 'articles', 'article_reactions', 'article_views', 'article_comments', 'chat_messages', 'chat_reports', 'credit_history', 'blocked', 'notifications', 'dms', 'achievements', 'convoys', 'organizations', 'org_members', 'org_pacts', 'support_tickets', 'world', 'rate_limits', 'referral_pending', 'db_meta', 'mission_progress', 'mission_claims', 'chronicle_done', 'chronicle_claims', 'ad_tokens', 'ad_rewards'];

// Kunci advisory lock Postgres untuk initDb (satu nilai tetap; hanya dipakai di sini).
const INITDB_LOCK_KEY = 2026112701;

// Versi skema database — penanda di tabel db_meta (key 'schema_version').
// INSIDEN 27 Nov 2026 (server hampir mati 16:16–16:21 WIB): initDb lama
// menjalankan SELURUH init (50 CREATE TABLE + ~25 ALTER + seed — ~100
// round-trip ke Neon) di bawah SATU advisory lock global, di SETIAP cold
// start serverless. Cold start antre 24 detik di balik lock (59×, total
// 1.444 detik), lalu timeout/500; migrasi CHECK di luar lock balapan antar
// instance dan memicu deadlock. Sejak versi ini, initDb di steady state
// hanya melakukan SATU query murah (baca penanda) tanpa lock dan tanpa DDL;
// migrasi penuh hanya jalan sekali saat penanda belum ada / versi lama
// (sekali per deploy). Bila menambah migrasi baru, NAIKKAN angka ini.
// Database lama (tanpa tabel db_meta) dianggap versi < angka ini dan
// dimigrasi penuh sekali — aman, karena semua migrasi idempotent.
const SCHEMA_VERSION = 22;

// Baca penanda versi skema (null bila tabel/baris belum ada = DB lama/baru).
async function schemaVersion() {
  try {
    const row = await one("SELECT value FROM db_meta WHERE key = 'schema_version'");
    return row?.value ?? null;
  } catch {
    return null;
  }
}

// Hapus tipe komposit "yatim" peninggalan run pertama yang gagal: CREATE TABLE
// membuat tipe komposit bernama sama dengan tabelnya; bila tipe itu ada tapi
// tabelnya tidak, CREATE TABLE IF NOT EXISTS justru MELEWATI pembuatan tabel
// (dianggap sudah ada) sehingga tabelnya tidak pernah dibuat dan query
// berikutnya gagal "relation does not exist". Terjadi di Neon setelah run
// pertama membuat tipe "users" lalu gagal di seed (22003).
// Hanya jalan di Postgres (SQLite tidak punya pg_type).
async function cleanupOrphanTypes(t) {
  const types = await t.sql(`SELECT typname FROM pg_type WHERE typtype = 'c'`);
  const tables = await t.sql(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
  const tableSet = new Set(tables.map((r) => r.table_name));
  for (const row of types) {
    const name = row.typname;
    if (TABLE_NAMES.includes(name) && !tableSet.has(name)) {
      // Nama tipe berasal dari daftar tetap di atas (bukan input pengguna).
      await t.exec(`DROP TYPE "${name}"`);
    }
  }
}

// Migrasikan kolom timestamp yang masih INTEGER ke BIGINT (Postgres).
// Database yang dibuat sebelum perbaikan ini punya created_at dkk. bertipe
// INTEGER — seed dan semua tulis Date.now() akan gagal 22003 di sana.
// Idempotent: hanya kolom yang masih 'integer' yang diubah; setelah migrasi
// query tidak menemukan apa-apa. Kolom id (identity) tidak disentuh.
async function migrateTimestampsToBigint(t) {
  const inList = TS_COLUMNS.map((c) => `'${c}'`).join(',');
  const rows = await t.sql(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND data_type = 'integer'
     AND column_name IN (${inList})`);
  for (const r of rows) {
    // Nama tabel/kolom berasal dari information_schema, dikutip ganda agar aman.
    await t.exec(`ALTER TABLE "${r.table_name}" ALTER COLUMN "${r.column_name}" TYPE BIGINT`);
  }
}

// Migrasikan kolom users yang ditambahkan setelah deploy pertama
// (referral_code, is_banned, banned_reason, banned_at, avatar, token_version)
// untuk database yang sudah terlanjur dibuat dengan skema lama (Neon live +
// SQLite lama). Idempotent: kolom yang sudah ada tidak disentuh.
// HANYA DDL — perbaikan datanya (backfill kode referral, pengaman admin)
// jalan tiap boot lewat runDataFixups, bukan di sini.
async function migrateUserColumns(t) {
  if (isPg) {
    await t.exec('ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE');
    await t.exec('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned INTEGER NOT NULL DEFAULT 0');
    await t.exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_reason TEXT NOT NULL DEFAULT ''");
    await t.exec('ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at BIGINT NOT NULL DEFAULT 0');
    await t.exec('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT');
    await t.exec('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_sm TEXT');
    await t.exec('ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0');
  } else {
    const cols = await t.sql('PRAGMA table_info(users)');
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('referral_code')) await t.exec('ALTER TABLE users ADD COLUMN referral_code TEXT UNIQUE');
    if (!names.has('is_banned')) await t.exec('ALTER TABLE users ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0');
    if (!names.has('banned_reason')) await t.exec("ALTER TABLE users ADD COLUMN banned_reason TEXT NOT NULL DEFAULT ''");
    if (!names.has('banned_at')) await t.exec('ALTER TABLE users ADD COLUMN banned_at BIGINT NOT NULL DEFAULT 0');
    if (!names.has('avatar')) await t.exec('ALTER TABLE users ADD COLUMN avatar TEXT');
    if (!names.has('avatar_sm')) await t.exec('ALTER TABLE users ADD COLUMN avatar_sm TEXT');
    if (!names.has('token_version')) await t.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
  }
}

// Migrasikan kolom lowongan ADMIN (resource/pay_qty) untuk database lama.
// HANYA DDL — nilai gajinya disetel tiap boot lewat runDataFixups.
async function migrateAdminJobs(t) {
  if (isPg) {
    await t.exec("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS resource TEXT NOT NULL DEFAULT ''");
    await t.exec('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pay_qty INTEGER NOT NULL DEFAULT 0');
  } else {
    const cols = await t.sql('PRAGMA table_info(jobs)');
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('resource')) await t.exec("ALTER TABLE jobs ADD COLUMN resource TEXT NOT NULL DEFAULT ''");
    if (!names.has('pay_qty')) await t.exec('ALTER TABLE jobs ADD COLUMN pay_qty INTEGER NOT NULL DEFAULT 0');
  }
}

// Migrasikan kolom Tahap 4 untuk database yang sudah ada (Neon live +
// SQLite lama): country.treasury_usd (kas negara dalam USD — pajak pasar
// lokal) dan citizens.energy_updated_at (jam terakhir regen energi).
// Idempotent: kolom yang sudah ada tidak disentuh. Baris warga lama yang
// energy_updated_at-nya masih 0 diperlakukan sebagai "baru saja" saat regen
// (tidak ada windfall energi — lihat util.js applyEnergyRegen).
async function migrateTahap4Columns(t) {
  if (isPg) {
    await t.exec('ALTER TABLE country ADD COLUMN IF NOT EXISTS treasury_usd REAL NOT NULL DEFAULT 0');
    await t.exec('ALTER TABLE citizens ADD COLUMN IF NOT EXISTS energy_updated_at BIGINT NOT NULL DEFAULT 0');
  } else {
    const countryCols = await t.sql('PRAGMA table_info(country)');
    if (!countryCols.some((c) => c.name === 'treasury_usd')) {
      await t.exec('ALTER TABLE country ADD COLUMN treasury_usd REAL NOT NULL DEFAULT 0');
    }
    const citizenCols = await t.sql('PRAGMA table_info(citizens)');
    if (!citizenCols.some((c) => c.name === 'energy_updated_at')) {
      await t.exec('ALTER TABLE citizens ADD COLUMN energy_updated_at BIGINT NOT NULL DEFAULT 0');
    }
  }
}

// Migrasikan kolom Tahap 5 untuk database yang sudah ada (Neon live +
// SQLite lama): country.admin_pay_mult / travel_tickets / mobilization_until
// / budget_kind / budget_until / holiday_at, laws.kind / laws.value /
// laws.effect_applied. Idempotent: kolom yang sudah ada tidak disentuh.
async function migrateTahap5Columns(t) {
  const addCol = async (table, col, ddl) => {
    if (isPg) {
      await t.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${ddl}`);
    } else {
      const cols = await t.sql(`PRAGMA table_info(${table})`);
      if (!cols.some((c) => c.name === col)) await t.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    }
  };
  await addCol('country', 'admin_pay_mult', 'REAL NOT NULL DEFAULT 1');
  await addCol('country', 'travel_tickets', 'INTEGER NOT NULL DEFAULT 1');
  await addCol('country', 'mobilization_until', 'BIGINT NOT NULL DEFAULT 0');
  await addCol('country', 'budget_kind', "TEXT NOT NULL DEFAULT ''");
  await addCol('country', 'budget_until', 'BIGINT NOT NULL DEFAULT 0');
  await addCol('country', 'holiday_at', 'BIGINT NOT NULL DEFAULT 0');
  await addCol('laws', 'kind', "TEXT NOT NULL DEFAULT 'general'");
  await addCol('laws', 'value', 'REAL');
  await addCol('laws', 'effect_applied', 'INTEGER NOT NULL DEFAULT 0');
  // BUG 2026-11-27: kolom citizens.region_id/home_region_id punya
  // DEFAULT 1 — semua INSERT yang lupa mengisi region diam-diam menaruh
  // pemain di Kepulauan Riau (region id 1). Sejak Tahap 5, registrasi
  // selalu mengisi region acak (lihat api-core.js); di sini default lama
  // dicabut dari database Postgres yang sudah ada agar jalur yang lupa
  // mengisi region gagal keras, bukan diam-diam ke region 1. SQLite
  // tidak bisa DROP DEFAULT lewat ALTER (butuh rebuild tabel) — di sana
  // CREATE TABLE baru sudah tanpa default, jadi tetap fail-closed untuk
  // database baru. pg-mem dilewati (tidak mengenal sintaks ini).
  if (isPg && process.env.PG_MEM_TEST !== '1') {
    await t.exec('ALTER TABLE citizens ALTER COLUMN region_id DROP DEFAULT');
    await t.exec('ALTER TABLE citizens ALTER COLUMN home_region_id DROP DEFAULT');
  }
}

// Migrasikan kolom jumlah pemain online (fitur "online sekarang") untuk
// database yang sudah ada (Neon live + SQLite lama): citizens.last_seen_at
// (jam terakhir warga memanggil /api/me, epoch ms). Idempotent: kolom yang
// sudah ada tidak disentuh. Pola sama seperti migrateTahap5Columns.
async function migrateOnlineColumns(t) {
  const addCol = async (table, col, ddl) => {
    if (isPg) {
      await t.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${ddl}`);
    } else {
      const cols = await t.sql(`PRAGMA table_info(${table})`);
      if (!cols.some((c) => c.name === col)) await t.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    }
  };
  await addCol('citizens', 'last_seen_at', 'BIGINT NOT NULL DEFAULT 0');
  // Indeks dibuat DI SINI (setelah ADD COLUMN), bukan di schema(): schema()
  // jalan SEBELUM migrasi, dan database lama (Neon v6) belum punya kolom
  // ini — indeks di schema() akan menggagalkan initDb dengan 42703.
  await t.exec('CREATE INDEX IF NOT EXISTS idx_citizens_last_seen ON citizens(last_seen_at)');
}

// Migrasikan kolom jeda latihan (cooldown) untuk database yang sudah ada
// (Neon live + SQLite lama): citizens.train_str_at / train_edu_at /
// train_eco_at (jam terakhir warga melatih atribut itu, epoch ms; 0 =
// belum pernah). Idempotent: kolom yang sudah ada tidak disentuh. Pola
// sama seperti migrateOnlineColumns.
async function migrateTrainCooldownColumns(t) {
  const addCol = async (table, col, ddl) => {
    if (isPg) {
      await t.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${ddl}`);
    } else {
      const cols = await t.sql(`PRAGMA table_info(${table})`);
      if (!cols.some((c) => c.name === col)) await t.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    }
  };
  await addCol('citizens', 'train_str_at', 'BIGINT NOT NULL DEFAULT 0');
  await addCol('citizens', 'train_edu_at', 'BIGINT NOT NULL DEFAULT 0');
  await addCol('citizens', 'train_eco_at', 'BIGINT NOT NULL DEFAULT 0');
}

// Migrasikan kolom perjalanan (27 Nov 2026) untuk database yang sudah
// ada (Neon live + SQLite lama): citizens.travel_to_region_id /
// travel_arrives_at / home_changed_at. Idempotent: kolom yang sudah ada
// tidak disentuh. Pola sama seperti migrateOnlineColumns.
async function migrateTravelColumns(t) {
  const addCol = async (table, col, ddl) => {
    if (isPg) {
      await t.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${ddl}`);
    } else {
      const cols = await t.sql(`PRAGMA table_info(${table})`);
      if (!cols.some((c) => c.name === col)) await t.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    }
  };
  await addCol('citizens', 'travel_to_region_id', 'INTEGER');
  await addCol('citizens', 'travel_arrives_at', 'BIGINT NOT NULL DEFAULT 0');
  await addCol('citizens', 'home_changed_at', 'BIGINT NOT NULL DEFAULT 0');
}

// Migrasikan kolom perusahaan v2.4.0 (foto + bonus shift) untuk database
// lama. Idempotent: kolom yang sudah ada tidak disentuh.
async function migrateCompanyColumns(t) {
  const addCol = async (table, col, ddl) => {
    if (isPg) {
      await t.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${ddl}`);
    } else {
      const cols = await t.sql(`PRAGMA table_info(${table})`);
      if (!cols.some((c) => c.name === col)) await t.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    }
  };
  await addCol('companies', 'photo', 'TEXT');
  await addCol('companies', 'photo_sm', 'TEXT');
  await addCol('companies', 'bonus_credit', 'INTEGER NOT NULL DEFAULT 0');
  await addCol('companies', 'bonus_given', 'INTEGER NOT NULL DEFAULT 0');
  await addCol('companies', 'bonus_warned_at', 'BIGINT NOT NULL DEFAULT 0');
}

// Migrasikan kolom kredit skor v3.0.0 untuk database lama. Idempotent:
// kolom yang sudah ada tidak disentuh.
async function migrateCreditColumns(t) {
  const addCol = async (table, col, ddl) => {
    if (isPg) {
      await t.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${ddl}`);
    } else {
      const cols = await t.sql(`PRAGMA table_info(${table})`);
      if (!cols.some((c) => c.name === col)) await t.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    }
  };
  await addCol('citizens', 'credit_score', 'INTEGER NOT NULL DEFAULT 100');
  await addCol('citizens', 'credit_updated_at', 'BIGINT NOT NULL DEFAULT 0');
  await addCol('chat_reports', 'verdict', "TEXT NOT NULL DEFAULT ''");
}

// INSIDEN 28 Nov 2026 — rollback inflasi XP (×160.000) + penghapusan
// migrateXpScale (v4.3.4).
// AKAR MASALAH: migrateXpScale (UPDATE citizens SET xp = xp * 20) dipanggil
// TANPA PENJAGA di rantai migrasi initDb — bukan sekali saat rescale v3.1.0
// (skema 14), melainkan di SETIAP kenaikan SCHEMA_VERSION (Tahap 6/7/8 =
// skema 15/16/17). Total ×20^4 = ×160.000. Bukti: Vrix 1.760.000 XP =
// 11 × 160.000 persis. Tombol "Pasokan Harian" (+40 XP via addXp) hanya
// PEMICU: loop level-up di addXp memproses XP terinflasi sekaligus.
// PERBAIKAN: pemanggilan migrateXpScale DIHAPUS dari rantai dan fungsinya
// dihapus — rescale sudah selesai bersejarah; pemain baru mulai dari xp 0.
// ROLLBACK (sekali, skema 18): untuk tiap warga, pool P = xp +
// Σ_{k=1}^{level-1} k×100. Level legit L0 = (level terendah dari notifikasi
// "Naik Level!" sejak awal inflasi) − 1; bila tidak ada notifikasi, L0 =
// level saat ini. XP legit X0 = floor((P − Σ_{k=1}^{L0-1} k×100) / 8000) —
// 8000 = 20^3, tiga perkalian BERLEBIH (satu perkalian pertama memang
// rescale v3.1.0). Residu R = (P − Σ) − X0×8000 adalah XP legit yang
// didapat setelah inflasi (< 8000); diproses lewat loop level-up normal
// dari (L0, X0). ATURAN AKHIR (perintah pemilik 28 Nov 2026 08:41 WIB):
// pemain yang terkena inflasi TIDAK dikembalikan ke level legit-nya —
// mereka berakhir di Level 10 (lantai): level akhir = max(level legit,
// 10), XP akhir = XP legit hasil inverse (bila tidak bisa dihitung
// bersih, 0). Pemain yang level legit-nya sudah >= 10 tetap di level
// legit-nya. Pemain yang TIDAK terinflasi (pool di atas L0 < 8000, atau
// state valid tanpa kaskade) TIDAK berubah dan TIDAK dinaikkan ke 10.
// IDEMPOTEN lewat penanda db_meta 'xp_rollback_2026_11_28' (jalan dua
// kali = hasil sama) + ringkasan JSON di penanda yang sama.
// Efek samping — HANYA yang terbukti palsu: payout referral TIDAK
// dibatalkan (pemain kini sah di level >= 10) — hanya DIHITUNG berapa
// payout yang terpicu oleh inflasi. Achievement level <= 10 kini sah
// dipertahankan; hanya level_20/35/50 yang diklaim palsu yang
// dikembalikan. Penghitung rekrutan tidak dikoreksi (rekrutan kini sah
// di level >= 10). Bila data seorang warga tidak cocok dengan model,
// warga itu DILEWATI (dicatat di log + ringkasan) — kecuali pool-nya
// jelas tidak masuk akal (terinflasi tapi tak bisa dihitung bersih),
// yang berakhir di (Lv10, 0 XP) sesuai perintah pemilik. Diekspor
// untuk tes.
// CATATAN KEJUJURAN: XP legit yang didapat DI ANTARA perkalian (03:54–
// 05:16 WIB 28 Nov) ikut terlipat dan tidak bisa dipulihkan persis —
// rollback membagi seluruh pool di atas L0 dengan 8000, jadi sebagian
// kecil XP itu hilang (atau muncul sebagai residu R). Batas atas
// selisihnya < 8000 XP per warga, dan hanya untuk warga yang aktif di
// jendela tengah malam itu.
const XP_ROLLBACK_KEY = 'xp_rollback_2026_11_28';
// Awal inflasi: deploy Tahap 6 (skema 15) ~03:54 WIB 28 Nov 2026 =
// 20:54 UTC 27 Nov 2026; diambil 20:30 UTC sebagai margin aman (level-up
// legit tepat sebelum itu yang ikut tertangkap tetap benar karena ambang
// levelnya masuk ke residu R dan dinaikkan lagi lewat loop level-up).
const XP_INFLATION_START_MS = Date.parse('2026-11-27T20:30:00Z');
const XP_INFLATION_DIVISOR = 8000; // 20^3 — tiga perkalian berlebih
// paid_day (UTC) paling awal yang bisa berisi payout referral palsu:
// kaskade pertama hanya mungkin setelah perkalian terakhir (~22:16 UTC
// 27 Nov 2026). Payout 'paid' sebelum tanggal ini pasti legit.
const XP_ROLLBACK_REFERRAL_SINCE = '2026-11-27';

export async function migrateXpRollback(t) {
  const done = await t.one('SELECT value FROM db_meta WHERE key = ?', [XP_ROLLBACK_KEY]);
  if (done) {
    console.log('[migrasi xp-rollback] sudah pernah jalan — dilewati.');
    return { skipped: true };
  }
  const now = Date.now();
  // Σ_{k=1}^{level-1} k×100 — XP yang sudah "dibelanjakan" untuk mencapai level ini.
  const sumBelow = (level) => 100 * (Math.max(1, level) - 1) * Math.max(1, level) / 2;
  const summary = {
    citizensChecked: 0, citizensChanged: 0, citizensUnchanged: 0, flooredTo10: 0,
    changed: [], skipped: [],
    referralTriggeredByInflation: [], referralKept: 0, referralUnknown: [],
    achievementsReverted: [], achievementsUnrecoverable: [],
  };
  const notes = new Map(); // citizen_id -> [catatan koreksi untuk notifikasi]
  const note = (citizenId, text) => {
    if (!notes.has(citizenId)) notes.set(citizenId, []);
    notes.get(citizenId).push(text);
  };
  const legitLevel = new Map(); // citizen_id -> level legit (hasil inverse, sebelum lantai 10)
  const finalLevel = new Map(); // citizen_id -> level akhir (pasca-rollback, sesudah lantai 10)
  const userToCitizen = new Map(); // user_id -> { id, name, legitLevel, finalLevel }

  // ---- 1. Rollback level + XP tiap warga ----
  const citizens = await t.sql(
    'SELECT c.id, c.user_id, c.level, c.xp, c.gold, c.recruits, u.username AS name FROM citizens c LEFT JOIN users u ON u.id = c.user_id ORDER BY c.id');
  for (const c of citizens) {
    summary.citizensChecked++;
    const displayName = c.name || ('warga#' + c.id);
    const level = Number(c.level);
    const xp = Number(c.xp);
    const recordLevels = (legitLvl, finalLvl) => {
      legitLevel.set(c.id, legitLvl);
      finalLevel.set(c.id, finalLvl);
      userToCitizen.set(c.user_id, { id: c.id, name: displayName, legitLevel: legitLvl, finalLevel: finalLvl });
    };
    if (!Number.isFinite(level) || !Number.isFinite(xp) || level < 1 || xp < 0) {
      summary.skipped.push({ citizen: displayName, reason: 'level/xp tidak valid' });
      recordLevels(level >= 1 ? level : 1, level >= 1 ? level : 1);
      continue;
    }
    const notifs = await t.sql(
      "SELECT content FROM notifications WHERE citizen_id = ? AND title = 'Naik Level!' AND created_at >= ?",
      [c.id, XP_INFLATION_START_MS]);
    const levels = new Set();
    for (const n of notifs) {
      const m = /Level (\d+)/.exec(n.content || '');
      if (m) levels.add(Number(m[1]));
    }
    // Warga yang tidak pernah kaskade DAN statenya valid (xp < ambang
    // levelnya) TIDAK terinflasi: sisa XP terinflasi yang belum kaskade
    // selalu jauh di atas ambang (minimal 160.000 untuk XP pra-inflasi
    // >= 1), jadi state valid + tanpa notifikasi naik level di jendela
    // inflasi = aman dilewati. Ini juga melindungi pemain level tinggi
    // yang sah (xp mereka bisa >= 8000 — pembagi 8000 di bawah akan
    // salah memangkasnya bila penjaga ini tidak ada).
    if (levels.size === 0 && xp < level * 100) {
      recordLevels(level, level);
      summary.citizensUnchanged++;
      continue;
    }
    let L0 = levels.size ? Math.min(...levels) - 1 : level;
    if (L0 < 1) L0 = 1;
    if (L0 > level) {
      summary.skipped.push({ citizen: displayName, reason: 'level asli > level saat ini (data tidak cocok)' });
      recordLevels(level, level);
      continue;
    }
    const pool = xp + sumBelow(level);
    const above = pool - sumBelow(L0);
    if (above < 0) {
      summary.skipped.push({ citizen: displayName, reason: 'pool XP negatif (data tidak cocok)' });
      recordLevels(level, level);
      continue;
    }
    const X0 = Math.floor(above / XP_INFLATION_DIVISOR);
    const R = above - X0 * XP_INFLATION_DIVISOR;
    // Penjaga model: X0 yang wajar untuk sisa level. Bila jauh di atas
    // ambang (100×), pool-nya jelas terinflasi tapi tidak bisa dihitung
    // bersih — perintah pemilik: berakhir di (Lv10, 0 XP).
    if (X0 > 100 * Math.max(1, L0) * 100) {
      recordLevels(10, 10);
      await t.run('UPDATE citizens SET level = ?, xp = ? WHERE id = ?', [10, 0, c.id]);
      summary.citizensChanged++;
      summary.flooredTo10++;
      summary.changed.push({ citizen: displayName, before: `Lv${level} (${xp} XP)`, after: 'Lv10 (0 XP)' });
      note(c.id, `Level disesuaikan ke 10 dengan XP 0 — XP-mu terlipatganda oleh kesalahan sistem (×160.000) sampai tidak bisa dihitung bersih; sebagai pemulihan kamu dikembalikan ke Level 10. Progres aslimu (emas, barang, dan lainnya) tidak berubah.`);
      continue;
    }
    let lvl = L0;
    let rem = X0 + R;
    while (rem >= lvl * 100) { rem -= lvl * 100; lvl += 1; }
    // Level legit (lvl, rem) vs level saat ini: sama = TIDAK terinflasi.
    const inflated = !(lvl === level && rem === xp);
    // LANTAI 10 (perintah pemilik 28 Nov 2026 08:41 WIB): pemain yang
    // terkena inflasi berakhir di max(level legit, 10); XP = XP legit.
    let finalLvl = lvl;
    let finalRem = rem;
    if (inflated) {
      finalLvl = Math.max(lvl, 10);
      if (lvl < 10) summary.flooredTo10++;
    }
    recordLevels(lvl, finalLvl);
    if (!inflated) { summary.citizensUnchanged++; continue; }
    await t.run('UPDATE citizens SET level = ?, xp = ? WHERE id = ?', [finalLvl, finalRem, c.id]);
    summary.citizensChanged++;
    summary.changed.push({ citizen: displayName, before: `Lv${level} (${xp} XP)`, after: `Lv${finalLvl} (${finalRem} XP)` });
    if (lvl < 10) note(c.id, `Level disesuaikan dari ${level} ke 10 — ada kesalahan sistem yang melipatgandakan XP (×160.000) sejak update kemarin. Sebagai pemulihan, semua pemain yang terkena dikembalikan ke Level 10 (bukan ke level awal). Progres aslimu (emas, barang, dan lainnya) tidak berubah.`);
    else note(c.id, `Level dikembalikan dari ${level} ke ${finalLvl} — ada kesalahan sistem yang melipatgandakan XP (×160.000) sejak update kemarin; progres aslimu (emas, barang, dan lainnya) tidak berubah.`);
  }

  // ---- 2. Payout referral yang terpicu selama inflasi (HANYA DILAPORKAN) ----
  // ATURAN BARU (perintah pemilik 28 Nov 2026 08:41 WIB): payout TIDAK
  // dibatalkan — pemain yang terkena inflasi kini sah berada di level
  // >= 10 (>= 3), jadi bonus referral tetap milik mereka. Di sini hanya
  // DIHITUNG berapa payout yang terpicu oleh inflasi (pendaftar belum
  // benar-benar mencapai Level 3 saat payout cair — level legit < 3).
  const paidRows = await t.sql(
    "SELECT id, referrer_id, newcomer_id FROM referral_pending WHERE status = 'paid' AND paid_day >= ? ORDER BY id",
    [XP_ROLLBACK_REFERRAL_SINCE]);
  for (const row of paidRows) {
    const newcomer = userToCitizen.get(row.newcomer_id);
    if (!newcomer) {
      summary.referralUnknown.push({ newcomerUserId: row.newcomer_id, reason: 'warga pendaftar tidak ditemukan' });
      continue;
    }
    if (newcomer.legitLevel >= 3) { summary.referralKept++; continue; }
    const refCitizen = userToCitizen.get(row.referrer_id);
    summary.referralTriggeredByInflation.push({ referrer: refCitizen?.name || ('user#' + row.referrer_id), newcomer: newcomer.name });
  }

  // ---- 3. Klaim achievement palsu (hanya level > 10) ----
  // ATURAN BARU: achievement level <= 10 kini sah (pemain yang terkena
  // inflasi berakhir di Level 10) — hanya level_20/35/50 yang diklaim
  // palsu yang dikembalikan. recruit_/attack_/law_/buy_ tidak kena
  // inflasi XP — tidak pernah disentuh (penghitung rekrutan tidak lagi
  // dikoreksi: rekrutan kini sah berada di level >= 10).
  const claimed = await t.sql('SELECT citizen_id, akey FROM achievements WHERE claimed = 1');
  for (const row of claimed) {
    const a = ACHIEVEMENTS.find((x) => x.key === row.akey);
    if (!a || !a.key.startsWith('level_')) continue;
    const falseClaim = (finalLevel.get(row.citizen_id) ?? 99) < a.target;
    if (!falseClaim) continue;
    const c = await t.one('SELECT c.id, c.gold, u.username AS name FROM citizens c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?', [row.citizen_id]);
    const displayName = c?.name || ('warga#' + row.citizen_id);
    const goldOk = !!c && Number(c.gold) >= a.reward;
    await t.run('DELETE FROM achievements WHERE citizen_id = ? AND akey = ?', [row.citizen_id, row.akey]);
    if (goldOk) {
      await t.run('UPDATE citizens SET gold = ? WHERE id = ?', [Number(c.gold) - a.reward, c.id]);
      summary.achievementsReverted.push({ citizen: displayName, akey: row.akey, reward: a.reward });
    } else {
      summary.achievementsReverted.push({ citizen: displayName, akey: row.akey, reward: a.reward, goldUnrecovered: true });
      summary.achievementsUnrecoverable.push({ citizen: displayName, akey: row.akey, reward: a.reward, reason: 'saldo emas kurang — hadiah tidak bisa ditarik' });
    }
    note(row.citizen_id, `Pencapaian "${a.label}" dibatalkan — syaratnya terpenuhi karena bug XP. Hadiah ${a.reward} emas ditarik${goldOk ? '' : ' (tidak bisa ditarik penuh karena saldo kurang)'}; kamu bisa mengklaimnya lagi saat benar-benar mencapainya.`);
  }

  // ---- 4. Beri tahu warga yang dikoreksi (satu notifikasi per warga) ----
  for (const [citizenId, texts] of notes) {
    await t.run(
      'INSERT INTO notifications (citizen_id, category, title, content, created_at) VALUES (?,?,?,?,?)',
      [citizenId, 'SISTEM', 'Koreksi Level & Hadiah (Bug XP)', texts.join(' '), now]);
  }

  // ---- 5. Penanda idempotensi + ringkasan (JSON, tanpa email/ID pemain) ----
  const existing = await t.one('SELECT value FROM db_meta WHERE key = ?', [XP_ROLLBACK_KEY]);
  if (existing) await t.run('UPDATE db_meta SET value = ? WHERE key = ?', [JSON.stringify(summary), XP_ROLLBACK_KEY]);
  else await t.run('INSERT INTO db_meta (key, value) VALUES (?, ?)', [XP_ROLLBACK_KEY, JSON.stringify(summary)]);

  console.log(`[migrasi xp-rollback] warga dicek=${summary.citizensChecked} diubah=${summary.citizensChanged} tidak-berubah=${summary.citizensUnchanged} dilewati=${summary.skipped.length} berakhir-di-Lv10=${summary.flooredTo10} | referral terpicu-inflasi=${summary.referralTriggeredByInflation.length} dipertahankan=${summary.referralKept} tak-dikenal=${summary.referralUnknown.length} | achievement dikembalikan=${summary.achievementsReverted.length} tak-bisa-ditarik=${summary.achievementsUnrecoverable.length}`);
  for (const ex of summary.changed.slice(0, 5)) console.log(`[migrasi xp-rollback] contoh: ${ex.citizen}: ${ex.before} -> ${ex.after}`);
  for (const s of summary.skipped) console.log(`[migrasi xp-rollback] dilewati: ${s.citizen} (${s.reason})`);
  for (const u of summary.referralUnknown) console.log(`[migrasi xp-rollback] referral tak-dikenal: ${JSON.stringify(u)}`);
  for (const u of summary.achievementsUnrecoverable) console.log(`[migrasi xp-rollback] achievement tak-bisa-ditarik: ${JSON.stringify(u)}`);
  return summary;
}

// Tahap 6 (v4.0.0): militer + kepemilikan wilayah + reputasi dagang.
//  - tabel military_units dibuat di schema() (CREATE TABLE IF NOT EXISTS —
//    no-op di DB lama karena schema() jalan sebelum migrasi);
//  - regions.controller / controller_id: wilayah yang sudah punya negara
//    di-backfill 'negara' + id negaranya; yang merdeka tetap 'bebas'.
//  - citizens.trades_completed: mulai 0 untuk semua warga (riwayat
//    transaksi lama tidak dihitung ulang — reputasi dihitung dari transaksi
//    yang terjadi setelah v4.0.0).
async function migrateStage6Columns(t) {
  const addCol = async (table, col, ddl) => {
    if (isPg) {
      await t.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${ddl}`);
    } else {
      const cols = await t.sql(`PRAGMA table_info(${table})`);
      if (!cols.some((c) => c.name === col)) await t.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    }
  };
  await addCol('regions', 'controller', "TEXT NOT NULL DEFAULT 'bebas'");
  await addCol('regions', 'controller_id', 'INTEGER');
  await addCol('citizens', 'trades_completed', 'INTEGER NOT NULL DEFAULT 0');
  await t.run("UPDATE regions SET controller = 'negara', controller_id = country_id WHERE country_id IS NOT NULL AND (controller = 'bebas' OR controller IS NULL)");
}

// Tahap 7 (v4.1.0): misi harian + kronik pindah dari JSON TEXT ke tabel
// relasional (mission_progress / mission_claims / chronicle_done /
// chronicle_claims — dibuat di schema() di atas, no-op di DB lama).
// Backfill dari JSON lama, lalu kolom lama dihapus:
//  - missions: hanya 'chat' + 'last_chat_counted' yang dipindah — kunci
//    'energy'/'bread' TIDAK dipindah karena tidak pernah dibaca (progres
//    energi/roti dibaca dari kolom citizens energy_spent_today/bread_today);
//    'claimed' (array) dipindah ke mission_claims.
//  - chronicle_done / chronicle_claimed: tiap elemen array jadi satu baris.
// Idempotent: INSERT ... ON CONFLICT DO NOTHING (pg) / INSERT OR IGNORE
// (SQLite) + DROP COLUMN IF EXISTS — migrasi yang gagal di tengah jalan
// bisa diulang tanpa menduplikasi baris. Database BARU (v16) tidak pernah
// punya kolom JSON itu (schema() sudah tidak membuatnya) — backfill
// dilewati bila kolom 'missions' sudah tidak ada.
async function migrateStage7Columns(t) {
  const hasCol = async (col) => {
    if (isPg) {
      const r = await t.one('SELECT 1 AS x FROM information_schema.columns WHERE table_name = ? AND column_name = ?', ['citizens', col]);
      return !!r;
    }
    const cols = await t.sql('PRAGMA table_info(citizens)');
    return cols.some((c) => c.name === col);
  };
  if (!(await hasCol('missions'))) return;
  const insProgress = isPg
    ? 'INSERT INTO mission_progress (citizen_id, mkey, value) VALUES (?,?,?) ON CONFLICT DO NOTHING'
    : 'INSERT OR IGNORE INTO mission_progress (citizen_id, mkey, value) VALUES (?,?,?)';
  const insClaim = isPg
    ? 'INSERT INTO mission_claims (citizen_id, mkey, claimed_at) VALUES (?,?,?) ON CONFLICT DO NOTHING'
    : 'INSERT OR IGNORE INTO mission_claims (citizen_id, mkey, claimed_at) VALUES (?,?,?)';
  const insDone = isPg
    ? 'INSERT INTO chronicle_done (citizen_id, ckey, done_at) VALUES (?,?,?) ON CONFLICT DO NOTHING'
    : 'INSERT OR IGNORE INTO chronicle_done (citizen_id, ckey, done_at) VALUES (?,?,?)';
  const insClaimCh = isPg
    ? 'INSERT INTO chronicle_claims (citizen_id, chapter, claimed_at) VALUES (?,?,?) ON CONFLICT DO NOTHING'
    : 'INSERT OR IGNORE INTO chronicle_claims (citizen_id, chapter, claimed_at) VALUES (?,?,?)';
  const rows = await t.sql('SELECT id, missions, chronicle_done, chronicle_claimed FROM citizens');
  const parseJson = (s, fallback) => { try { return JSON.parse(s || ''); } catch { return fallback; } };
  for (const row of rows) {
    const m = parseJson(row.missions, {});
    if (Number(m.chat) > 0) await t.run(insProgress, [row.id, 'chat', Math.floor(Number(m.chat))]);
    if (Number(m.last_chat_counted) > 0) await t.run(insProgress, [row.id, 'last_chat_counted', Math.floor(Number(m.last_chat_counted))]);
    for (const k of (Array.isArray(m.claimed) ? m.claimed : [])) await t.run(insClaim, [row.id, String(k), Date.now()]);
    const done = parseJson(row.chronicle_done, []);
    for (const k of (Array.isArray(done) ? done : [])) await t.run(insDone, [row.id, String(k), Date.now()]);
    const claimedCh = parseJson(row.chronicle_claimed, []);
    for (const ch of (Array.isArray(claimedCh) ? claimedCh : [])) await t.run(insClaimCh, [row.id, Number(ch), Date.now()]);
  }
  const dropCol = async (col) => {
    if (isPg) await t.exec(`ALTER TABLE citizens DROP COLUMN IF EXISTS ${col}`);
    else if (await hasCol(col)) await t.exec(`ALTER TABLE citizens DROP COLUMN ${col}`);
  };
  await dropCol('missions');
  await dropCol('chronicle_done');
  await dropCol('chronicle_claimed');
}

// Tahap 8 (v4.2.0): perbaiki race ensureElections + siapkan dedupe views.
// 1) Pemilu ganda: dulu ensureElections SELECT lalu INSERT — dua panggilan
//    bersamaan (cold start serverless ganda, ensureReady + tick) bisa
//    sama-sama melihat "belum ada" lalu sama-sama INSERT. Pengaman di level
//    database: indeks unik parsial — hanya SATU pemilu 'scheduled'/'open'
//    per (negara, tipe). Pemilu 'closed' tidak dihitung, jadi pemilu
//    berikutnya tetap bisa dijadwalkan setelah yang lama ditutup.
//    Migrasi membersihkan dulu duplikat yang sudah telanjur ada (simpan
//    id terkecil per negara+tipe, hanya baris bernegara — pemilu arsip
//    country_id NULL tidak saling berkonflik di indeks unik) lalu membuat
//    indeksnya. Idempotent: DELETE memakai NOT IN + CREATE INDEX IF NOT
//    EXISTS — migrasi yang gagal di tengah bisa diulang.
// 2) Tabel article_views dibuat schema() di atas (CREATE TABLE IF NOT
//    EXISTS jalan sebelum migrasi ini) — tidak perlu dibuat ulang di sini.
async function migrateStage8Columns(t) {
  // Dedup tanpa subquery NOT IN (parser pg-mem tidak bisa mem-parse
  // `DELETE ... id NOT IN (SELECT MIN(id) ... GROUP BY ...)` — pg-test
  // crash "Ambiguous SQL syntax"): ambil id terkecil per grup dulu,
  // lalu hapus sisanya satu per satu lewat id eksplisit. Sama hasilnya,
  // jalan di SQLite + Postgres + pg-mem.
  const keepers = await t.sql(`SELECT MIN(id) AS id FROM elections WHERE country_id IS NOT NULL AND status IN ('scheduled','open') GROUP BY country_id, type`);
  const keepIds = new Set(keepers.map((r) => Number(r.id)));
  const actives = await t.sql(`SELECT id FROM elections WHERE country_id IS NOT NULL AND status IN ('scheduled','open')`);
  for (const row of actives) {
    if (!keepIds.has(Number(row.id))) await t.run('DELETE FROM elections WHERE id = ?', [row.id]);
  }
  await t.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_elections_one_active ON elections(country_id, type) WHERE status IN ('scheduled','open')`);
}

// Migrasikan kolom kerja otomatis Premium 24 jam (v4.5.0) untuk database
// yang sudah ada: citizens.auto_work_until / auto_work_started_at /
// auto_work_shifts / auto_work_paused / auto_work_last_at. Idempotent:
// kolom yang sudah ada tidak disentuh. Pola sama seperti
// migrateOnlineColumns.
async function migrateAutoWorkColumns(t) {
  const addCol = async (table, col, ddl) => {
    if (isPg) {
      await t.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${ddl}`);
    } else {
      const cols = await t.sql(`PRAGMA table_info(${table})`);
      if (!cols.some((c) => c.name === col)) await t.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    }
  };
  await addCol('citizens', 'auto_work_until', 'BIGINT NOT NULL DEFAULT 0');
  await addCol('citizens', 'auto_work_started_at', 'BIGINT NOT NULL DEFAULT 0');
  await addCol('citizens', 'auto_work_shifts', 'INTEGER NOT NULL DEFAULT 0');
  await addCol('citizens', 'auto_work_paused', 'INTEGER NOT NULL DEFAULT 0');
  await addCol('citizens', 'auto_work_last_at', 'BIGINT NOT NULL DEFAULT 0');
}

// Migrasikan kolom link share harian (v4.6.0) untuk database yang sudah
// ada: citizens.share_code. Idempotent — kolom yang sudah ada tidak
// disentuh. (Tabel share_clicks dibuat lewat schema() di atas.)
// Indeks unik dibuat DI SINI (setelah ADD COLUMN), BUKAN di schema():
// schema() jalan SEBELUM migrasi, dan database lama belum punya kolom ini
// — indeks di schema() menggagalkan initDb (Postgres 42703, insiden
// 28 Nov 2026: v4.6.0 crash-loop di live) sehingga server tidak pernah
// nyala. Pola yang sama seperti migrateOnlineColumns / migrateWorldRedesign.
async function migrateShareColumns(t) {
  const addCol = async (table, col, ddl) => {
    if (isPg) {
      await t.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${ddl}`);
    } else {
      const cols = await t.sql(`PRAGMA table_info(${table})`);
      if (!cols.some((c) => c.name === col)) await t.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    }
  };
  await addCol('citizens', 'share_code', 'TEXT');
  await t.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_share_code ON citizens(share_code) WHERE share_code IS NOT NULL');
}

// Tanggal parlemen dibuka (redesain dunia 27 Nov 2026): disimpan di
// db_meta supaya bisa diubah tanpa deploy; nilai awal = 2 Des 2026 00:00
// WIB (PARLIAMENT_OPENS_AT_DEFAULT di game.js). Dipakai gate parlemen +
// penjadwalan pemilu parlemen pertama tiap negara.
export async function getParliamentOpensAt() {
  try {
    const row = await one("SELECT value FROM db_meta WHERE key = 'parliament_opens_at'");
    const v = Number(row?.value);
    return Number.isFinite(v) && v > 0 ? v : PARLIAMENT_OPENS_AT_DEFAULT;
  } catch {
    return PARLIAMENT_OPENS_AT_DEFAULT;
  }
}

// Redesain dunia (27 Nov 2026): TIDAK ADA lagi negara awal. Migrasi ini
// MEMBUBARKAN Republik Indonesia di database lama:
//  - baris country id=1 dihapus (kasnya diarsipkan dulu ke treasury_tx
//    sebagai baris 'pembubaran' bernilai negatif, supaya jejaknya ada);
//  - semua wilayah kembali merdeka (regions.country = '', country_id NULL);
//  - politik yang masih berjalan (UU/anggaran/pemakzulan/pemilu milik
//    negara yang dibubarkan) ditutup sebagai gagal — tidak bisa dilanjutkan
//    tanpa negara.
// Idempotent: kolom yang sudah ada tidak disentuh; baris country yang
// sudah tidak ada tidak dihapus dua kali; database BARU (v10) tidak pernah
// punya baris country dari seed, jadi migrasi ini no-op di sana.
async function migrateWorldRedesign(t) {
  const addCol = async (table, col, ddl) => {
    if (isPg) {
      await t.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${ddl}`);
    } else {
      const cols = await t.sql(`PRAGMA table_info(${table})`);
      if (!cols.some((c) => c.name === col)) await t.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    }
  };
  await addCol('country', 'system', "TEXT NOT NULL DEFAULT 'presidensial'");
  await addCol('country', 'founder_id', 'INTEGER');
  await addCol('regions', 'country_id', 'INTEGER REFERENCES country(id)');
  await addCol('laws', 'country_id', 'INTEGER');
  await addCol('budgets', 'country_id', 'INTEGER');
  await addCol('impeachments', 'country_id', 'INTEGER');
  await addCol('elections', 'country_id', 'INTEGER');
  await addCol('treasury_tx', 'country_id', 'INTEGER');
  // Indeks dibuat DI SINI (setelah ADD COLUMN), bukan hanya di schema():
  // schema() jalan SEBELUM migrasi, dan database lama belum punya kolom
  // ini — indeks di schema() akan menggagalkan initDb (pola yang sama
  // seperti migrateOnlineColumns).
  await t.exec('CREATE INDEX IF NOT EXISTS idx_party_seats_country ON party_seats(country_id)');
  await t.exec('CREATE INDEX IF NOT EXISTS idx_country_joins_region ON country_joins(region_id, status)');
  await t.exec('CREATE INDEX IF NOT EXISTS idx_regions_country ON regions(country_id)');
  await t.exec('CREATE INDEX IF NOT EXISTS idx_elections_country ON elections(country_id)');
  await t.exec('CREATE INDEX IF NOT EXISTS idx_laws_country ON laws(country_id)');
  await t.exec('CREATE INDEX IF NOT EXISTS idx_treasury_tx_country ON treasury_tx(country_id)');
  // Pembubaran Republik Indonesia. URUTAN PENTING (Postgres menegakkan
  // FK): wilayah dilepas DULU (country='' + country_id=NULL) sebelum baris
  // negara dihapus — sebaliknya DELETE gagal 23503 bila ada wilayah yang
  // masih merujuk negara itu.
  // GATE (perbaikan Tahap 6, v4.0.0): pembubaran HANYA jalan bila negara
  // lama itu masih ada (id=1, nama 'Republik Indonesia'). Tanpa gate ini,
  // UPDATE regions tanpa syarat di bawah akan membubarkan SEMUA negara
  // buatan pemain di SETIAP migrasi penuh (resetVersion + initDb — mis.
  // saat deploy versi baru) — ketahuan saat menguji backfill controller
  // v15: country_id negara uji terhapus sebelum backfill jalan. Negara
  // buatan pemain tidak pernah bisa ber-id 1 + bernama sama persis:
  // sequence id tidak kembali ke 1 setelah baris lama dihapus.
  const old = await t.one("SELECT * FROM country WHERE id = 1 AND name = 'Republik Indonesia'");
  if (old) {
    await t.run("UPDATE regions SET country = '', country_id = NULL");
    const gold = Number(old.treasury) || 0;
    const usd = Number(old.treasury_usd) || 0;
    if (gold > 0) {
      await t.run("INSERT INTO treasury_tx (kind, currency, amount, note, created_at) VALUES ('pembubaran','gold',?,?,?) RETURNING id",
        [-gold, `Pembubaran Republik Indonesia — kas ${gold} emas dihapus (negara dibubarkan, dunia kembali terpecah).`, Date.now()]);
    }
    if (usd > 0) {
      await t.run("INSERT INTO treasury_tx (kind, currency, amount, note, created_at) VALUES ('pembubaran','usd',?,?,?) RETURNING id",
        [-usd, 'Pembubaran Republik Indonesia — kas Rupiah dihapus (negara dibubarkan, dunia kembali terpecah).', Date.now()]);
    }
    await t.run('DELETE FROM country WHERE id = 1');
    await t.run("UPDATE laws SET status = 'failed' WHERE status = 'voting'");
    await t.run("UPDATE budgets SET status = 'failed' WHERE status = 'voting'");
    await t.run("UPDATE impeachments SET status = 'failed' WHERE status = 'voting'");
    await t.run("UPDATE elections SET status = 'closed' WHERE status IN ('scheduled','open')");
  }
}

// Migrasikan kolom gambar artikel (sampul + thumbnail) untuk database
// yang sudah ada: articles.cover / cover_sm (data URL gambar, NULL =
// artikel lama tanpa sampul). Idempotent: kolom yang sudah ada tidak
// disentuh. Pola sama seperti migrateTrainCooldownColumns.
async function migrateArticleImageColumns(t) {
  const addCol = async (table, col, ddl) => {
    if (isPg) {
      await t.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${ddl}`);
    } else {
      const cols = await t.sql(`PRAGMA table_info(${table})`);
      if (!cols.some((c) => c.name === col)) await t.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    }
  };
  await addCol('articles', 'cover', 'TEXT');
  await addCol('articles', 'cover_sm', 'TEXT');
}

// Migrasikan tabel support_tickets lama (tanpa kolom status) ke status
// 'baru'/'dibaca'/'selesai' untuk inbox admin. Idempotent: kolom yang sudah
// ada tidak disentuh.
async function migrateSupportTickets(t) {
  if (isPg) {
    await t.exec("ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'baru'");
  } else {
    const cols = await t.sql('PRAGMA table_info(support_tickets)');
    if (!cols.some((c) => c.name === 'status')) {
      await t.exec("ALTER TABLE support_tickets ADD COLUMN status TEXT NOT NULL DEFAULT 'baru'");
    }
  }
}

// Tambahkan CHECK saldo/qty ke database Postgres yang sudah ada (Neon live).
// Hanya jalan di Postgres sungguhan (bukan pg-mem/SQLite — skema baru sudah
// membawa CHECK inline). Idempotent: constraint yang sudah ada dilewati.
// Satu constraint yang gagal (mis. ada data lama yang melanggar) hanya
// diperingatkan, tidak menggagalkan initDb.
const CHECK_CONSTRAINTS = [
  ['citizens', 'ck_citizens_gold_nonneg', 'gold >= 0'],
  ['citizens', 'ck_citizens_usd_nonneg', 'usd >= 0'],
  ['citizens', 'ck_citizens_energy_nonneg', 'energy >= 0'],
  ['inventory', 'ck_inventory_qty_nonneg', 'qty >= 0'],
  ['market_offers', 'ck_market_offers_qty_pos', 'qty > 0'],
  ['market_offers', 'ck_market_offers_price_pos', 'price > 0'],
  ['market_buy_orders', 'ck_buy_orders_qty_pos', 'qty > 0'],
  ['market_buy_orders', 'ck_buy_orders_price_pos', 'price > 0'],
  ['market_buy_orders', 'ck_buy_orders_filled_nonneg', 'qty_filled >= 0'],
  ['market_buy_orders', 'ck_buy_orders_filled_lte', 'qty_filled <= qty'],
  ['fx_offers', 'ck_fx_offers_qty_gold_nonneg', 'qty_gold >= 0'],
  ['fx_offers', 'ck_fx_offers_qty_filled_nonneg', 'qty_filled >= 0'],
  ['jobs', 'ck_jobs_seats_nonneg', 'seats_taken >= 0'],
  ['jobs', 'ck_jobs_seats_lte', 'seats_taken <= seats'],
  ['wars', 'ck_wars_score_a_nonneg', 'score_a >= 0'],
  ['wars', 'ck_wars_score_d_nonneg', 'score_d >= 0'],
  ['country', 'ck_country_tax_income_range', 'tax_income >= 0 AND tax_income <= 10'],
  ['country', 'ck_country_admin_pay_mult_range', 'admin_pay_mult >= 0.5 AND admin_pay_mult <= 2'],
  ['country', 'ck_country_travel_tickets', 'travel_tickets IN (1, 2)'],
  ['country', 'ck_country_ideology', "ideology IN ('Konservatisme','Sosialisme','Liberalisme','Nasionalisme')"],
  ['country', 'ck_country_system', "system IN ('presidensial','parlementer','imperial','diktator')"],
  ['budgets', 'ck_budgets_amount_range', 'amount >= 50 AND amount <= 500'],
];
// Tambahkan CHECK saldo/qty ke database Postgres yang sudah ada (Neon live).
// Hanya jalan di Postgres sungguhan (bukan pg-mem/SQLite — skema baru sudah
// membawa CHECK inline). Idempotent: constraint yang sudah ada dilewati.
// Satu constraint yang gagal (mis. ada data lama yang melanggar) hanya
// diperingatkan, tidak menggagalkan initDb.
// Sejak perbaikan advisory lock (27 Nov 2026): hanya dipanggil oleh instance
// yang baru saja bermigrasi (lihat initDb) — bukan tiap cold start — jadi
// tidak ada lagi balapan antar cold start. ADD memakai NOT VALID (tambah
// tanpa memindai tabel: cepat, tidak memblokir tulis lama — dua ALTER
// market_buy_orders di deploy Tahap 5 masing-masing 5–6 detik karena
// validasi sambil memegang AccessExclusiveLock); VALIDATE sesudahnya hanya
// butuh ShareUpdateExclusive (tidak memblokir INSERT/UPDATE/SELECT game).
// Bila VALIDATE gagal (data lama melanggar), constraint tetap NOT VALID dan
// dicoba divalidasi lagi di migrasi versi berikutnya.
async function migrateChecks() {
  if (!isPg || process.env.PG_MEM_TEST === '1') return;
  for (const [table, name, expr] of CHECK_CONSTRAINTS) {
    try {
      // Cek eksistensi + status validasi lewat pg_constraint (aman skema).
      const row = await one(
        `SELECT convalidated FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
         WHERE c.conname = ? AND c.contype = 'c' AND t.relname = ?
         AND t.relnamespace = 'public'::regnamespace`,
        [name, table]);
      if (row) {
        if (!row.convalidated) await exec(`ALTER TABLE "${table}" VALIDATE CONSTRAINT "${name}"`);
        continue;
      }
      await exec(`ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK (${expr}) NOT VALID`);
      await exec(`ALTER TABLE "${table}" VALIDATE CONSTRAINT "${name}"`);
    } catch (e) {
      // 42P07 (duplicate_object): dua instance masih bisa balapan di jendela
      // kecil ini bila keduanya bermigrasi bersamaan — yang kalah mendapat
      // "constraint already exists". Itu hasil idempotent yang diharapkan,
      // bukan masalah: diam saja. Warning hanya untuk kegagalan lain
      // (mis. ada data lama yang melanggar CHECK).
      if (e.code === '42P07' || /already exists/.test(e.message || '')) continue;
      console.warn(`[db] CHECK ${name} dilewati: ${e.message}`);
    }
  }
}

async function seed(t = { one, run }) {
  const now = Date.now();
  const regionCount = await t.one('SELECT COUNT(*) AS c FROM regions');
  if (Number(regionCount.c) === 0) {
    for (const r of REGIONS) {
      await t.run(
        'INSERT INTO regions (name, type, city_score, capacity, health, education, military, industry, electricity, resource_bonus) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id',
        [r.name, r.type, r.score, 100, 7, 7, 7, 7, 10, r.bonus],
      );
    }
  }
  const comCount = await t.one('SELECT COUNT(*) AS c FROM commodities');
  if (Number(comCount.c) === 0) {
    for (const c of COMMODITIES) {
      await t.run('INSERT INTO commodities (name, category, ref_usd, ref_gold) VALUES (?,?,?,?) RETURNING id',
        [c.name, c.category, c.usd, c.gold]);
    }
  }
  // Negara: TIDAK ADA yang di-seed (redesain dunia 27 Nov 2026) — dunia
  // mulai terpecah; negara hanya terbentuk dari aksi pemain (pendirian /
  // unifikasi). Baris country di database LAMA sudah dibubarkan migrasi
  // (migrateWorldRedesign).
  await t.run("INSERT INTO db_meta (key, value) VALUES ('parliament_opens_at', ?) ON CONFLICT(key) DO NOTHING",
    [String(PARLIAMENT_OPENS_AT_DEFAULT)]);
  // Lowongan ADMIN: pastikan semuanya ada (idempotent — DB lama yang
  // hanya punya 6 lowongan lama ikut dilengkapi 12 lowongan baru di sini).
  await ensureAdminJobs(t);
  const world = await t.one('SELECT * FROM world WHERE id = 1');
  if (!world) {
    await t.run('INSERT INTO world (id, day, last_tick_date) VALUES (1,1,?) RETURNING id',
      [new Date().toISOString().slice(0, 10)]);
  }
  // Pengumuman pertama (Update #1, Tahap 4): di-seed sekali saat tabel
  // masih kosong, supaya langsung tampil setelah deploy ini.
  const annCount = await t.one('SELECT COUNT(*) AS c FROM announcements');
  if (Number(annCount.c) === 0) {
    await t.run('INSERT INTO announcements (title, body, created_at, created_by) VALUES (?,?,?,NULL) RETURNING id',
      [ANNOUNCEMENT_TAHAP4_TITLE, ANNOUNCEMENT_TAHAP4_BODY, now]);
  }
  // Pengumuman kedua (Update #2, Tahap 5): di-seed sekali saat judulnya
  // belum ada. Dipakai juga sebagai penanda bahwa migrasi Tahap 5 sudah
  // berjalan di database ini.
  const ann2 = await t.one('SELECT id FROM announcements WHERE title = ?', [ANNOUNCEMENT_TAHAP5_TITLE]);
  if (!ann2) {
    await t.run('INSERT INTO announcements (title, body, created_at, created_by) VALUES (?,?,?,NULL) RETURNING id',
      [ANNOUNCEMENT_TAHAP5_TITLE, ANNOUNCEMENT_TAHAP5_BODY, now]);
  }
}
