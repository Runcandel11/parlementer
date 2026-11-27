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
  gold REAL NOT NULL DEFAULT 50 CHECK (gold >= 0),
  usd REAL NOT NULL DEFAULT 500 CHECK (usd >= 0),
  attr_str INTEGER NOT NULL DEFAULT 0,
  attr_edu INTEGER NOT NULL DEFAULT 0,
  attr_eco INTEGER NOT NULL DEFAULT 0,
  fatigue INTEGER NOT NULL DEFAULT 0,
  bread_today INTEGER NOT NULL DEFAULT 0,
  energy_spent_today INTEGER NOT NULL DEFAULT 0,
  chat_today INTEGER NOT NULL DEFAULT 0,
  last_chat_at BIGINT NOT NULL DEFAULT 0,
  last_claim_date TEXT NOT NULL DEFAULT '',
  region_id INTEGER NOT NULL,
  home_region_id INTEGER NOT NULL,
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
  chronicle_done TEXT NOT NULL DEFAULT '[]',
  chronicle_claimed TEXT NOT NULL DEFAULT '[]',
  missions TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS regions (
  id ${id},
  name TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'Republik Indonesia',
  type TEXT NOT NULL DEFAULT 'Daratan',
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
-- Order beli (Tahap 4): dana pembeli dikunci (escrow) saat order dipasang.
-- qty_filled = yang sudah dipenuhi penjual; order terbuka selama
-- qty_filled < qty. Dana sisa kembali saat dibatalkan.
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
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS country (
  id ${id},
  name TEXT NOT NULL,
  ideology TEXT NOT NULL DEFAULT 'Konservatisme',
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
  defender_label TEXT NOT NULL DEFAULT 'Republik Indonesia',
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
CREATE INDEX IF NOT EXISTS idx_market_tx_buyer ON market_tx(buyer_id);
CREATE INDEX IF NOT EXISTS idx_market_tx_seller ON market_tx(seller_id);
CREATE INDEX IF NOT EXISTS idx_market_buy_orders ON market_buy_orders(scope, commodity_id);
CREATE INDEX IF NOT EXISTS idx_market_buy_orders_buyer ON market_buy_orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_treasury_tx_created ON treasury_tx(created_at);
CREATE INDEX IF NOT EXISTS idx_market_flags_created ON market_flags(created_at);
CREATE INDEX IF NOT EXISTS idx_announcement_reads_citizen ON announcement_reads(citizen_id);
CREATE INDEX IF NOT EXISTS idx_convoys_citizen ON convoys(citizen_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_elections_status ON elections(status);
CREATE INDEX IF NOT EXISTS idx_laws_status ON laws(status, ends_at);
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
• Hadiah barang tanpa batas jumlah: admin kini bisa memberi makanan, bahan mentah, dan barang lain sebanyak apa pun (emas/USD tetap dibatasi 1.000.000, Premium 365 hari).
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
• Log peringatan admin di server kini tidak lagi berisik: status jalan darurat admin cukup dilihat di Panel Admin.`;

export const ADMIN_JOBS = [  { title: 'Pekerja Gudang Pelabuhan', salary: 48, resource: 'Besi Mentah', qty: 44, region: 'Kepulauan Riau', desc: 'Bongkar muat peti kemas di pelabuhan. Kerja fisik, dibayar besi mentah.' },
  { title: 'Kurir Kota', salary: 46, resource: 'Minyak Mentah', qty: 40, region: 'Kepulauan Riau', desc: 'Antar paket keliling kota. Butuh stamina dan hafal jalan.' },
  { title: 'Pembersih Jalan Kota', salary: 44, resource: 'Kayu', qty: 44, region: 'Jakarta', desc: 'Jaga kebersihan jalan ibu kota setiap pagi.' },
  { title: 'Asisten Toko Kelontong', salary: 45, resource: 'Gandum Mentah', qty: 38, region: 'Jawa Barat', desc: 'Melayani pembeli, menata rak, dan menjaga kasir.' },
  { title: 'Buruh Tani', salary: 42, resource: 'Kapas Mentah', qty: 21, region: 'Jawa Timur', desc: 'Panen dan olah hasil kebun. Bonus panen saat musim raya.' },
  { title: 'Penjaga Malam Pasar', salary: 47, resource: 'Batu Bara', qty: 39, region: 'Sumatera Utara', desc: 'Ronda malam di pasar tradisional sampai subuh.' },
];

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
const TABLE_NAMES = ['users', 'admin_actions', 'appeals', 'appeal_messages', 'citizens', 'regions', 'commodities', 'inventory', 'market_offers', 'market_tx', 'market_buy_orders', 'treasury_tx', 'market_flags', 'announcements', 'announcement_reads', 'fx_offers', 'fx_history', 'jobs', 'companies', 'country', 'parties', 'party_members', 'laws', 'law_votes', 'budgets', 'budget_votes', 'impeachments', 'impeachment_votes', 'elections', 'election_candidates', 'election_votes', 'wars', 'war_attacks', 'war_support', 'newspapers', 'articles', 'article_reactions', 'article_comments', 'chat_messages', 'chat_reports', 'blocked', 'notifications', 'dms', 'achievements', 'convoys', 'organizations', 'org_members', 'org_pacts', 'support_tickets', 'world', 'rate_limits', 'referral_pending', 'db_meta'];

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
const SCHEMA_VERSION = 6;

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
  const countryCount = await t.one('SELECT COUNT(*) AS c FROM country');
  if (Number(countryCount.c) === 0) {
    await t.run(`INSERT INTO country (name, ideology, capital, founded, treasury, tax_income, tax_production, tax_import, tax_export)
      VALUES ('Republik Indonesia','Konservatisme','Jakarta','2026-09-23',0,2,1,2,2) RETURNING id`);
  }
  const jobCount = await t.one('SELECT COUNT(*) AS c FROM jobs WHERE is_admin = 1');
  if (Number(jobCount.c) === 0) {
    for (const j of ADMIN_JOBS) {
      const reg = await t.one('SELECT id FROM regions WHERE name = ?', [j.region]);
      await t.run(`INSERT INTO jobs (company_id, is_admin, title, salary, salary_type, resource, pay_qty, level_min, tier, seats, seats_taken, region_id, description, created_at)
        VALUES (NULL,1,?,?, 'goods', ?, ?,1,1,4,0,?,?,?) RETURNING id`,
        [j.title, j.salary, j.resource, j.qty, reg.id, j.desc, now]);
    }
  }
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
