// Parlementer — uji pemulihan (Tahap 8, AUDIT.md §Tahap 8).
// Membuktikan server selamat dari restart mendadak (SIGKILL) di tengah
// beban: boot → aksi pemain nyata (daftar, klaim, lamar, shift, jual) →
// snapshot → SIGKILL di tengah burst request baca → restart di DB yang
// sama → snapshot harus IDENTIK (tanpa saldo negatif / duplikasi) dan
// tick harian tetap jalan tepat 1 hari. Boot kedua membuktikan migrasi
// idempotent.
// Jalankan: npm run test:recovery   (atau: node scripts/recovery-test.mjs)
// Hasil mentah: docs/recovery-2026-11-28.json
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3458;
const DB_PATH = '/tmp/parlementer-recovery.db';
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'recovery-test-secret';
const OUT = path.join(ROOT, 'docs', 'recovery-2026-11-28.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.cookie = ''; }
  async req(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { _raw: text }; }
    return { status: res.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b || {}); }
}

let server = null;
async function startServer() {
  server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(500);
    try { const r = await fetch(BASE + '/api/world'); ready = r.ok; } catch {}
  }
  return ready;
}
const kill9 = () => { try { server?.kill('SIGKILL'); } catch {} };
const stop = () => { try { server?.kill('SIGTERM'); } catch {} };
process.on('exit', stop);

function snapshot() {
  const db = new DatabaseSync(DB_PATH);
  const snap = {
    schemaVersion: db.prepare("SELECT value FROM db_meta WHERE key = 'schema_version'").get()?.value,
    users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
    citizens: db.prepare('SELECT id, gold, usd, energy, level, xp FROM citizens ORDER BY id').all(),
    inventory: db.prepare('SELECT citizen_id, commodity_id, tier, qty FROM inventory ORDER BY citizen_id, commodity_id').all(),
    offers: db.prepare('SELECT id, seller_id, scope, commodity_id, qty, price FROM market_offers ORDER BY id').all(),
    marketTx: db.prepare('SELECT COUNT(*) n FROM market_tx').get().n,
    notifications: db.prepare('SELECT COUNT(*) n FROM notifications').get().n,
    negative: {
      citizens: db.prepare('SELECT COUNT(*) n FROM citizens WHERE gold < 0 OR usd < 0 OR energy < 0').get().n,
      inventory: db.prepare('SELECT COUNT(*) n FROM inventory WHERE qty < 0').get().n,
      offers: db.prepare('SELECT COUNT(*) n FROM market_offers WHERE qty <= 0').get().n,
    },
    world: db.prepare('SELECT day, last_tick_date FROM world WHERE id = 1').get(),
  };
  db.close();
  return snap;
}

async function main() {
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  const results = { checks: [] };
  const check = (name, cond, detail = '') => {
    results.checks.push({ name, ok: !!cond, detail: String(detail).slice(0, 300) });
    console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  };

  console.log('[recovery] Boot 1 + aksi pemain ...');
  if (!(await startServer())) { console.error('[recovery] Server tidak menyala'); process.exit(1); }
  const A = new Client();
  let r = await A.post('/api/auth/register', { email: 'pulih@test.local', password: 'rahasia123', username: 'warga_pulih' });
  check('Daftar pemain', r.status === 200, `status=${r.status}`);
  const me = (await A.get('/api/me')).data.citizen;
  r = await A.post('/api/claim', {});
  check('Klaim harian', r.status === 200, `status=${r.status}`);
  const jobs = (await A.get('/api/jobs')).data.jobs.filter((j) => j.is_admin === 1 && j.region_id === me.region_id);
  r = await A.post('/api/jobs/apply', { job_id: jobs[0].id });
  check('Lamar ADMIN', r.status === 200, `status=${r.status}`);
  r = await A.post('/api/jobs/shift', {});
  check('Shift penuh', r.status === 200, `goods=${r.data.goods}`);
  const dbSeed = new DatabaseSync(DB_PATH);
  const gandum = dbSeed.prepare("SELECT id FROM commodities WHERE name = 'Gandum Mentah'").get();
  dbSeed.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,100) ON CONFLICT (citizen_id, commodity_id, tier) DO UPDATE SET qty = qty + 100').run(me.id, gandum.id);
  dbSeed.close();
  r = await A.post('/api/market/sell', { scope: 'local', commodity_id: gandum.id, tier: 1, qty: 10, price: 1 });
  check('Jual 10× Gandum di pasar', r.status === 200 && !!r.data.offerId, `status=${r.status}`);

  const before = snapshot();
  console.log('[recovery] Snapshot sebelum kill:', JSON.stringify({ users: before.users, citizens: before.citizens.length, inventory: before.inventory.length, offers: before.offers.length, marketTx: before.marketTx }));

  // Burst request baca + SIGKILL di tengah jalan (simulasi redeploy/crash).
  console.log('[recovery] Burst 40 request + SIGKILL ...');
  const burst = Promise.allSettled(Array.from({ length: 40 }, (_, i) =>
    fetch(BASE + ['/api/me', '/api/world', '/api/market?scope=local', '/api/chat/global'][i % 4],
      { headers: { Cookie: A.cookie } }).then((x) => x.text())));
  await sleep(50);
  kill9();
  await burst;
  await sleep(500);

  console.log('[recovery] Boot 2 (restart di DB yang sama) ...');
  if (!(await startServer())) { console.error('[recovery] Server tidak menyala setelah kill'); process.exit(1); }
  r = await A.get('/api/world');
  check('Server hidup lagi setelah SIGKILL (/api/world 200)', r.status === 200, `version=${r.data.version}`);
  const after = snapshot();
  check('Skema tetap v17 setelah restart', after.schemaVersion === '17', `value=${after.schemaVersion}`);
  check('Snapshot IDENTIK setelah kill (gold/usd/inventaris/penawaran/jumlah baris)',
    JSON.stringify(before.citizens) === JSON.stringify(after.citizens)
    && JSON.stringify(before.inventory) === JSON.stringify(after.inventory)
    && JSON.stringify(before.offers) === JSON.stringify(after.offers)
    && before.users === after.users && before.marketTx === after.marketTx,
    `users ${before.users}→${after.users}, inv ${before.inventory.length}→${after.inventory.length}, offers ${before.offers.length}→${after.offers.length}, tx ${before.marketTx}→${after.marketTx}`);
  check('Tidak ada saldo/stok negatif setelah restart',
    after.negative.citizens === 0 && after.negative.inventory === 0 && after.negative.offers === 0,
    JSON.stringify(after.negative));
  // Tick tetap jalan tepat 1 hari setelah crash (klaim atomik: tidak ganda).
  const dbTick = new DatabaseSync(DB_PATH);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  dbTick.prepare('UPDATE world SET last_tick_date = ? WHERE id = 1').run(yesterday);
  dbTick.close();
  await A.get('/api/me');
  let day = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const w = await A.get('/api/world');
    day = w.data.day;
    if (day === 2) break;
  }
  check('Tick setelah restart: hari 1 → 2 (tepat 1 hari)', day === 2, `day=${day}`);
  const meAfter = (await A.get('/api/me')).data.citizen;
  check('Energi pulih penuh setelah tick', meAfter.energy === meAfter.energyCap, `energi=${meAfter.energy}/${meAfter.energyCap}`);

  // Boot 3: migrasi idempotent (tidak ada error, data tetap sama).
  console.log('[recovery] Boot 3 (idempotensi migrasi) ...');
  stop();
  await sleep(500);
  if (!(await startServer())) { console.error('[recovery] Server tidak menyala di boot 3'); process.exit(1); }
  r = await A.get('/api/world');
  check('Server hidup di boot ke-3', r.status === 200, `version=${r.data.version} day=${r.data.day}`);
  const after3 = snapshot();
  // Tick di antara boot 2–3 mengisi ulang energi (0 → cap) — itu efek tick
  // yang diharapkan, bukan kerusakan. Bandingkan hanya gold/usd + stok.
  const goldUsd = (s) => JSON.stringify(s.citizens.map((c) => ({ id: c.id, gold: c.gold, usd: c.usd })));
  check('Snapshot tetap identik setelah boot ke-3 (gold/usd/inventaris/penawaran)',
    goldUsd(after) === goldUsd(after3)
    && JSON.stringify(after.inventory) === JSON.stringify(after3.inventory)
    && JSON.stringify(after.offers) === JSON.stringify(after3.offers),
    `day=${after3.world.day}`);

  results.snapshotBefore = before;
  results.snapshotAfter = after;
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`\n[recovery] SELESAI: ${results.checks.filter((c) => c.ok).length}/${results.checks.length} lolos — ${OUT}`);
  stop();
  process.exit(results.checks.every((c) => c.ok) ? 0 : 1);
}
main().catch((e) => { console.error('[recovery] ERROR:', e); stop(); process.exit(1); });
