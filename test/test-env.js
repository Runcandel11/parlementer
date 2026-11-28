// Parlementer — env bersama untuk resource tes (v5.7.4, tes paralel per lane).
//
// Masalah yang diatasi: semua perintah tes memakai resource TETAP yang sama
// (e2e port 3456 + /tmp/parlementer-e2e.db; pg-verify/pg-concurrency database
// `parlementer_test` + port 3466/3467; beberapa suite DOM berbagi port
// 3471/3472), sehingga full suite harus antre satu-satu lewat
// `flock /tmp/parl-test.lock`. Dengan env di sini, tiap lane memakai resource
// yang disjoint sehingga 2–3 full suite bisa jalan barengan tanpa flock.
//
// Cara pakai:
//   TEST_LANE=1 node test/e2e.js            — lane 1: port +100, DB -lane1, pg DB parlementer_test_lane1
//   TEST_LANE=2 npm run test:all           — lane 2: port +200, dst.
//   (tanpa env)                             — default persis seperti dulu (backward compatible)
//
// Env var (override eksplisit selalu menang atas turunan TEST_LANE):
//   TEST_LANE         bilangan bulat 0–99 (default 0). Menurunkan: offset port
//                     = N×100, suffix path SQLite = `-laneN`, database Postgres
//                     = `parlementer_test_laneN`.
//   TEST_PORT_OFFSET  offset port eksplisit (bilangan bulat, bisa negatif);
//                     menang atas turunan TEST_LANE.
//   TEST_DB_SUFFIX    suffix path SQLite eksplisit (mis. `-lane1`); menang atas
//                     turunan TEST_LANE. String kosong = tidak disetel.
//   TEST_PG_DB        nama database Postgres eksplisit (mis. `parlementer_test_lane1`);
//                     menang atas turunan TEST_LANE.
//   TEST_E2E_PORT     port server e2e eksplisit (menang atas testPort(3456)).
//   TEST_E2E_DB       path SQLite e2e eksplisit (menang atas testDbPath(...)).
//   DATABASE_URL      (sudah ada) connection string Postgres eksplisit; menang
//                     atas TEST_PG_DB / turunan TEST_LANE.
//
// Batas: stride port per lane = 100 (blok port satu full suite = 3456–3475,
// 20 port). TEST_LANE maks 99 supaya port tetap < 65535 (3456 + 99×100 +
// 19 = 13375). Port turunan yang masuk daftar "forbidden port" WHATWG
// (mis. 3659 = chat-dom lane 2) digeser +20 oleh testPort() — lihat di bawah. Database Postgres per lane HARUS sudah dibuat dulu (sekali,
// sebagai superuser — lihat docs/ARSITEKTUR.md § Tes Paralel):
//   CREATE DATABASE parlementer_test_lane1 OWNER parlementer_test;
//   CREATE DATABASE parlementer_test_lane2 OWNER parlementer_test;

function parseIntEnv(name, { min = null, max = null } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || (min !== null && n < min) || (max !== null && n > max)) {
    throw new Error(`[test-env] ${name}=${JSON.stringify(raw)} tidak valid (harus bilangan bulat${min !== null ? ` ${min}–${max ?? '∞'}` : ''})`);
  }
  return n;
}

// Nomor lane (0 = default, perilaku lama).
export function testLane() {
  return parseIntEnv('TEST_LANE', { min: 0, max: 99 }) ?? 0;
}

// Offset port untuk semua server tes: override eksplisit menang, kalau tidak
// ada turunkan dari TEST_LANE (N×100).
export function portOffset() {
  return parseIntEnv('TEST_PORT_OFFSET') ?? testLane() * 100;
}

// Port server tes: port dasar + offset lane. Hasil selalu port TCP valid.
//
// Port terlarang fetch (daftar "forbidden port" WHATWG): server BISA listen
// di port ini, tapi fetch()/browser menolak konek ("bad port"). Satu-satunya
// yang kena skema lane: 3659 (chat-dom lane 2 = 3459+200) — server jalan
// normal, tapi fetch test tidak pernah berhasil. Port turunan yang terlarang
// digeser +20 (tetap di celah setelah blok lane itu, offset terjaga, jadi
// tidak bentrok dengan suite lain di lane mana pun; 3679 dst. tidak terlarang).
const FORBIDDEN_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);
export function testPort(base) {
  let p = base + portOffset();
  while (FORBIDDEN_PORTS.has(p)) p += 20;
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error(`[test-env] port hasil ${p} (base ${base} + offset ${portOffset()}) di luar 1–65535`);
  }
  return p;
}

// Suffix path SQLite: override eksplisit menang, kalau tidak ada turunkan
// dari TEST_LANE (`-laneN`, atau '' untuk lane 0).
export function dbSuffix() {
  const raw = process.env.TEST_DB_SUFFIX;
  if (raw !== undefined && raw !== '') return raw;
  const lane = testLane();
  return lane > 0 ? `-lane${lane}` : '';
}

// Path SQLite per lane: sisipkan suffix sebelum ekstensi terakhir
// ('/tmp/parlementer-e2e.db' → '/tmp/parlementer-e2e-lane1.db').
export function testDbPath(p) {
  const s = dbSuffix();
  if (!s) return p;
  const i = p.lastIndexOf('.');
  return i > 0 ? p.slice(0, i) + s + p.slice(i) : p + s;
}

// Nama database Postgres untuk pg-verify / pg-concurrency.
export function pgDbName() {
  if (process.env.TEST_PG_DB) return process.env.TEST_PG_DB;
  const lane = testLane();
  return lane > 0 ? `parlementer_test_lane${lane}` : 'parlementer_test';
}

// Connection string Postgres: DATABASE_URL eksplisit menang (perilaku lama);
// bila tidak disetel, bangun dari pgDbName() dengan kredensial lokal default.
export function pgDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  return `postgres://parlementer_test:parlementer_test@127.0.0.1:5432/${pgDbName()}`;
}

// Port eksplisit dari satu env var (mis. TEST_E2E_PORT); null bila tidak disetel.
export function explicitPort(envName) {
  return parseIntEnv(envName, { min: 1, max: 65535 });
}
