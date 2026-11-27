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
  region_id INTEGER NOT NULL DEFAULT 1,
  home_region_id INTEGER NOT NULL DEFAULT 1,
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
  tax_income REAL NOT NULL DEFAULT 2,
  tax_production REAL NOT NULL DEFAULT 1,
  tax_import REAL NOT NULL DEFAULT 2,
  tax_export REAL NOT NULL DEFAULT 2,
  president_id INTEGER,
  minister_economy INTEGER,
  minister_foreign INTEGER,
  minister_home INTEGER,
  minister_defense INTEGER
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
  // Seluruh init (skema + migrasi + seed) jalan dalam SATU transaksi dan —
  // di Postgres sungguhan — di bawah advisory lock. Dua perbaikan dari
  // insiden 500 di Vercel 27 Nov 2026:
  //  1. Dua cold start serverless yang bersamaan tidak lagi bisa balapan
  //     membuat tabel yang sama (yang kalah gagal 23505 pada
  //     pg_type_typname_nsp_index). Lock dilepas otomatis saat COMMIT.
  //  2. Run yang gagal di tengah jalan tidak meninggalkan state parsial
  //     (dulu: skema jadi, seed gagal di tengah — run berikutnya menabrak
  //     state setengah jadi). Kini gagal = rollback total, coba lagi bersih.
  await tx(async (t) => {
    if (isPg && process.env.PG_MEM_TEST !== '1') {
      // pg-mem tidak mengenal pg_advisory_xact_lock; di sana tidak ada
      // instance paralel sehingga lock memang tidak diperlukan.
      await t.sql('SELECT pg_advisory_xact_lock(?::bigint)', [INITDB_LOCK_KEY]);
    }
    if (isPg) await cleanupOrphanTypes(t);
    await t.exec(schema(dialect));
    if (isPg) await migrateTimestampsToBigint(t);
    await migrateUserColumns(t);
    await migrateAdminJobs(t);
    await migrateSupportTickets(t);
    await migrateTahap4Columns(t);
    await seed(t);
  });
  // CHECK saldo/qty untuk database Postgres yang sudah ada: di luar transaksi
  // utama (satu constraint yang gagal — mis. ada data lama yang melanggar —
  // tidak boleh menggagalkan seluruh initDb).
  await migrateChecks();
}

// Kolom yang menyimpan timestamp milidetik (Date.now()) — di Postgres harus
// BIGINT: INTEGER (int4) overflow pada nilai ~1,8 triliun (error 22003).
// Di SQLite BIGINT sama saja dengan INTEGER (64-bit), jadi satu skema untuk
// kedua dialek. Daftar ini juga dipakai migrasi untuk database yang sudah
// terlanjur dibuat dengan kolom INTEGER.
const TS_COLUMNS = ['created_at', 'expires_at', 'ends_at', 'opens_at', 'closes_at', 'joined_at', 'last_chat_at', 'premium_until'];

// Semua nama tabel di skema — dipakai membersihkan tipe komposit yatim.
const TABLE_NAMES = ['users', 'admin_actions', 'appeals', 'appeal_messages', 'citizens', 'regions', 'commodities', 'inventory', 'market_offers', 'market_tx', 'market_buy_orders', 'treasury_tx', 'market_flags', 'announcements', 'announcement_reads', 'fx_offers', 'fx_history', 'jobs', 'companies', 'country', 'parties', 'party_members', 'laws', 'law_votes', 'elections', 'election_candidates', 'election_votes', 'wars', 'war_attacks', 'war_support', 'newspapers', 'articles', 'article_reactions', 'article_comments', 'chat_messages', 'chat_reports', 'blocked', 'notifications', 'dms', 'achievements', 'convoys', 'organizations', 'org_members', 'support_tickets', 'world', 'rate_limits', 'referral_pending'];

// Kunci advisory lock Postgres untuk initDb (satu nilai tetap; hanya dipakai di sini).
const INITDB_LOCK_KEY = 2026112701;

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
// SQLite lama). Idempotent: kolom yang sudah ada tidak disentuh. Setelah itu:
//  - semua user yang belum punya kode referral dibuatkan kode unik;
//  - akun ADMIN_EMAIL selalu ditandai is_admin = 1 (bila sudah terdaftar);
//    PENTING: ini HANYA pengaman untuk akun admin Khalid yang sudah ada
//    (email itu sudah terdaftar atas namanya sejak 27 Nov 2026, jadi tidak
//    ada akun baru yang bisa mengambil email tersebut). Registrasi BARU
//    tidak lagi memberi admin dari email — lihat api-core.js (bootstrap
//    code). Jangan hapus baris ini tanpa memastikan admin Khalid aman.
//  - akun admin tidak boleh berstatus banned — bila ada yang is_banned=1
//    (mis. ke-ban sebelum flag admin ada), ban-nya dicabut di sini.
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
  const missing = await t.sql('SELECT id FROM users WHERE referral_code IS NULL');
  for (const u of missing) {
    const code = await generateReferralCode(t);
    await t.run('UPDATE users SET referral_code = ? WHERE id = ?', [code, u.id]);
  }
  await t.run('UPDATE users SET is_admin = 1 WHERE email = ?', [ADMIN_EMAIL]);
  await t.run("UPDATE users SET is_banned = 0, banned_reason = '', banned_at = 0 WHERE is_admin = 1 AND is_banned = 1");
}

// Migrasikan lowongan ADMIN lama (dibayar USD) ke aturan baru (dibayar bahan
// mentah). Database live sudah berisi 6 lowongan ADMIN dari seed lama — tanpa
// migrasi ini mereka tetap bergaji USD dan kolom resource/pay_qty-nya kosong.
// Idempotent: nilai yang disetel sama setiap kali dijalankan.
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
  for (const j of ADMIN_JOBS) {
    await t.run(
      "UPDATE jobs SET salary_type = 'goods', resource = ?, pay_qty = ?, salary = ? WHERE is_admin = 1 AND title = ?",
      [j.resource, j.qty, j.salary, j.title]);
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
];
async function migrateChecks() {
  if (!isPg || process.env.PG_MEM_TEST === '1') return;
  for (const [table, name, expr] of CHECK_CONSTRAINTS) {
    try {
      // Cek eksistensi lewat pg_class (aman skema) sebelum membuat.
      const exists = await one(
        `SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
         WHERE c.conname = ? AND c.contype = 'c' AND t.relname = ?
         AND t.relnamespace = 'public'::regnamespace`,
        [name, table]);
      if (!exists) await exec(`ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK (${expr})`);
    } catch (e) {
      // 42P07 (duplicate_object): migrateChecks jalan DI LUAR transaksi
      // ber-advisory-lock initDb, jadi dua cold start bersamaan bisa
      // sama-sama lolos cek-eksistensi lalu ALTER — yang kalah mendapat
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
}
