// Parlementer — tes kompresi gzip respons (v5.7.3, poles backend).
// Memverifikasi middleware `compression` di src/app.js:
//   [1] JSON API besar + aset statis JS dikirim gzip bila klien mengirim
//       Accept-Encoding: gzip (hemat bandwidth, load lebih cepat);
//   [2] isi yang didekompres tetap utuh (JSON valid, versi 5.7.3);
//   [3] tanpa Accept-Encoding: gzip, respons dikirim apa adanya;
//   [4] gambar (sudah terkompres) TIDAK dikompres ulang;
//   [5] header Vary: Accept-Encoding ada (cache proxy tidak salah sajikan).
// CATATAN: fetch() Node otomatis mendekompres + menghapus header
// Content-Encoding, jadi tes ini memakai http mentah (node:http).
// Jalankan: npm run test:compression
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3473;
const DB_PATH = '/tmp/parlementer-compression.db';
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// Request mentah: tanpa dekompresi otomatis.
function rawGet(p, acceptEncoding) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + p, { headers: acceptEncoding ? { 'Accept-Encoding': acceptEncoding } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function main() {
  try { fs.unlinkSync(DB_PATH); } catch {}
  try { fs.unlinkSync(DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(DB_PATH + '-shm'); } catch {}

  console.log('[compression] Menyalakan server di port ' + PORT + ' ...');
  let server = null;
  let serverLog = '';
  server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'compression-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  process.on('exit', stop);

  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(500);
    try { const r = await fetch(BASE + '/api/world'); ready = r.ok; } catch {}
  }
  check('Server menyala & /api/world merespons', ready);
  if (!ready) { console.log(serverLog); process.exit(1); }

  // [1] Aset statis besar (app.js) dikompres bila diminta.
  const jsPlain = await rawGet('/js/app.js');
  check('GET /js/app.js tanpa gzip: 200 + tanpa Content-Encoding', jsPlain.status === 200 && !jsPlain.headers['content-encoding'], `status=${jsPlain.status} enc=${jsPlain.headers['content-encoding'] || '-'}`);
  const jsGzip = await rawGet('/js/app.js', 'gzip');
  const jsPlainSize = jsPlain.body.length;
  check('GET /js/app.js + gzip: Content-Encoding gzip', jsGzip.headers['content-encoding'] === 'gzip', `enc=${jsGzip.headers['content-encoding'] || '-'}`);
  check('GET /js/app.js + gzip: ukuran transfer lebih kecil dari aslinya', jsGzip.body.length < jsPlainSize, `${jsGzip.body.length} < ${jsPlainSize} byte`);
  let jsDecompressed = null;
  try { jsDecompressed = gunzipSync(jsGzip.body); } catch {}
  check('GET /js/app.js + gzip: isi terdekompres utuh (sama persis)', jsDecompressed !== null && jsDecompressed.equals(jsPlain.body), jsDecompressed ? `${jsDecompressed.length} byte` : 'gagal gunzip');
  check('GET /js/app.js + gzip: header Vary menyebut Accept-Encoding', String(jsGzip.headers.vary || '').includes('Accept-Encoding'), `vary=${jsGzip.headers.vary || '-'}`);

  // [2] JSON API (/api/world): dikompres bila di atas threshold 1 KB.
  const worldPlain = await rawGet('/api/world');
  const worldGzip = await rawGet('/api/world', 'gzip');
  if (worldPlain.body.length > 1024) {
    check('GET /api/world + gzip: Content-Encoding gzip (di atas threshold 1 KB)', worldGzip.headers['content-encoding'] === 'gzip', `plain=${worldPlain.body.length} byte enc=${worldGzip.headers['content-encoding'] || '-'}`);
    let worldJson = null;
    try { worldJson = JSON.parse(gunzipSync(worldGzip.body).toString('utf8')); } catch {}
    check('GET /api/world + gzip: JSON terdekompres valid, versi 5.7.3', worldJson !== null && worldJson.version === '5.7.3', `version=${worldJson?.version}`);
  } else {
    check('GET /api/world di bawah threshold: tidak dikompres (hemat CPU)', !worldGzip.headers['content-encoding'], `plain=${worldPlain.body.length} byte`);
    let worldJson = null;
    try { worldJson = JSON.parse(worldPlain.body.toString('utf8')); } catch {}
    check('GET /api/world: JSON valid, versi 5.7.3', worldJson !== null && worldJson.version === '5.7.3', `version=${worldJson?.version}`);
  }

  // [3] Gambar tidak dikompres ulang.
  const pngGzip = await rawGet('/favicon.png', 'gzip');
  check('GET /favicon.png + gzip: TIDAK dikompres (sudah terkompres)', pngGzip.status === 200 && !pngGzip.headers['content-encoding'], `status=${pngGzip.status} enc=${pngGzip.headers['content-encoding'] || '-'}`);

  console.log(`\n[compression] ${passed} lolos, ${failed} gagal`);
  stop();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
