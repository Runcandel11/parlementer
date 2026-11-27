// Parlementer — tes beban ringan (Tahap 8, AUDIT.md §Tahap 8).
// Target jujur: 20–50 pemain bersamaan masih nyaman (arsitektur
// request-response + SQLite lokal; ratusan pemain butuh server persistent
// + Postgres — lihat AUDIT.md "Catatan kejujuran").
// Cara kerja: nyalakan server lokal di DB sekali pakai, seed N warga
// langsung via DB (melewati rate limit registrasi 20/IP — bukan yang
// diukur di sini), lalu N VU paralel menghantam endpoint baca yang
// dipakai pemain (world/me/chat/pasar/regions) + 1 transaksi pasar/detik.
// Auth (register/login) diukur terpisah lewat API sungguhan (5×).
// Jalankan: npm run test:load   (atau: node scripts/loadtest.mjs [--vu 20,50] [--dur 60])
// Hasil mentah: docs/loadtest-2026-11-28.json
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import jwt from 'jsonwebtoken';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3457;
const DB_PATH = '/tmp/parlementer-load.db';
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'loadtest-secret';
const OUT = path.join(ROOT, 'docs', 'loadtest-2026-11-28.json');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const VU_LIST = String(args.vu || '20,50').split(',').map(Number);
const DUR_MS = Number(args.dur || 60) * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const stats = (arr) => {
  if (!arr.length) return { n: 0, errors: 0 };
  return {
    n: arr.length,
    meanMs: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
    p50Ms: pct(arr, 50),
    p95Ms: pct(arr, 95),
    p99Ms: pct(arr, 99),
    maxMs: Math.max(...arr),
  };
};

async function req(method, p, cookie) {
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: method === 'POST' ? JSON.stringify({}) : undefined,
    });
    await res.text();
    return { ms: performance.now() - t0, status: res.status };
  } catch (e) {
    return { ms: performance.now() - t0, status: 0, error: e.message };
  }
}

let server = null;
async function startServer() {
  server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const t0 = performance.now();
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(500);
    try { const r = await fetch(BASE + '/api/world'); ready = r.ok; } catch {}
  }
  return { ready, coldStartMs: Math.round(performance.now() - t0) };
}
const stop = () => { try { server?.kill('SIGTERM'); } catch {} };
process.on('exit', stop);

async function main() {
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  console.log('[loadtest] Menyalakan server ...');
  const boot = await startServer();
  if (!boot.ready) { console.error('[loadtest] Server tidak menyala'); process.exit(1); }
  console.log(`[loadtest] Cold start (spawn → /api/world 200): ${boot.coldStartMs} ms`);

  // Auth lewat API sungguhan (5× daftar + 5× login, di bawah batas 30/menit).
  const authLat = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const r = await fetch(BASE + '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `auth${i}@test.local`, password: 'rahasia123', username: `auth_${i}` }),
    });
    await r.text();
    authLat.push({ op: 'register', ms: Math.round(performance.now() - t0), status: r.status });
    const t1 = performance.now();
    const r2 = await fetch(BASE + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `auth${i}@test.local`, password: 'rahasia123' }),
    });
    await r2.text();
    authLat.push({ op: 'login', ms: Math.round(performance.now() - t1), status: r2.status });
  }
  console.log('[loadtest] Auth:', JSON.stringify(authLat));

  // Seed VU lewat DB langsung (bypass rate limit registrasi — yang diukur
  // di sini adalah beban baca + transaksi, bukan bcrypt/rate limit).
  const maxVu = Math.max(...VU_LIST);
  const db = new DatabaseSync(DB_PATH);
  const gandum = db.prepare("SELECT id FROM commodities WHERE name = 'Gandum Mentah'").get();
  const cookies = [];
  for (let i = 0; i < maxVu; i++) {
    const u = db.prepare("INSERT INTO users (email, username, pass_hash, created_at) VALUES (?,?,?,?) RETURNING id")
      .run(`load${i}@test.local`, `load_${i}`, 'x', Date.now()).lastInsertRowid;
    const region = 1 + (i % 17);
    db.prepare('INSERT INTO citizens (user_id, region_id, home_region_id, gold, usd, created_at) VALUES (?,?,?,?,?,?)')
      .run(u, region, region, 1000, 10000, Date.now());
    const c = db.prepare('SELECT id FROM citizens WHERE user_id = ?').get(u).id;
    db.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,?)').run(c, gandum.id, 100);
    const token = jwt.sign({ uid: u, tv: 0 }, JWT_SECRET, { expiresIn: '7d' });
    cookies.push(`parlementer_token=${token}`);
  }
  db.close();

  const endpoints = [
    { name: 'GET /api/world', path: '/api/world', auth: false },
    { name: 'GET /api/me', path: '/api/me', auth: true },
    { name: 'GET /api/chat/global', path: '/api/chat/global', auth: true },
    { name: 'GET /api/market?scope=local', path: '/api/market?scope=local', auth: true },
    { name: 'GET /api/market?scope=global', path: '/api/market?scope=global', auth: true },
    { name: 'GET /api/regions', path: '/api/regions', auth: true },
  ];

  const results = { coldStartMs: boot.coldStartMs, auth: authLat, runs: [] };
  for (const vu of VU_LIST) {
    console.log(`\n[loadtest] === ${vu} VU × ${DUR_MS / 1000} detik ===`);
    const lat = new Map(endpoints.map((e) => [e.name, []]));
    const txLat = [];
    let errors = 0;
    let total = 0;
    const endAt = Date.now() + DUR_MS;
    let stopFlag = false;
    // Transaksi pasar: 1/detik, jual-beli bergantian oleh VU yang berotasi.
    let txCount = 0;
    const txTimer = setInterval(async () => {
      if (stopFlag) return;
      const seller = txCount % vu;
      const t0 = performance.now();
      let r;
      if (txCount % 2 === 0) {
        r = await fetch(BASE + '/api/market/sell', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookies[seller] },
          body: JSON.stringify({ scope: 'local', commodity_id: gandum.id, tier: 1, qty: 10, price: 1 }),
        });
      } else {
        const m = await fetch(BASE + '/api/market?scope=local', { headers: { Cookie: cookies[(seller + 1) % vu] } });
        const mj = await m.json().catch(() => ({}));
        const offer = (mj.offers || [])[0];
        if (!offer) { txCount++; return; }
        r = await fetch(BASE + '/api/market/buy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookies[(seller + 1) % vu] },
          body: JSON.stringify({ offer_id: offer.id, qty: 10 }),
        });
      }
      await r.text();
      txLat.push({ ms: Math.round(performance.now() - t0), status: r.status, n: txCount });
      if (r.status !== 200) errors++;
      txCount++;
    }, 1000);
    const workers = Array.from({ length: vu }, (_, i) => (async () => {
      while (Date.now() < endAt) {
        const e = endpoints[Math.floor(Math.random() * endpoints.length)];
        const r = await req('GET', e.path, e.auth ? cookies[i] : undefined);
        total++;
        if (r.status === 200) lat.get(e.name).push(Math.round(r.ms));
        else errors++;
        await sleep(50 + Math.random() * 100);
      }
    })());
    await Promise.all(workers);
    stopFlag = true;
    clearInterval(txTimer);
    const perEndpoint = {};
    for (const [name, arr] of lat) perEndpoint[name] = { ...stats(arr), errors: 0 };
    const run = {
      vu,
      durationSec: DUR_MS / 1000,
      totalRequests: total,
      reqPerSec: Math.round((total / (DUR_MS / 1000)) * 10) / 10,
      errors,
      perEndpoint,
      txPerSec: { attempted: txLat.length, ok: txLat.filter((t) => t.status === 200).length, ...stats(txLat.map((t) => t.ms)) },
    };
    console.log(JSON.stringify(run, null, 2));
    results.runs.push(run);
  }

  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`\n[loadtest] Hasil mentah: ${OUT}`);
  stop();
}
main().catch((e) => { console.error('[loadtest] ERROR:', e); stop(); process.exit(1); });
