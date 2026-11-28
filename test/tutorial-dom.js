// Parlementer — tes DOM tutorial awal (overlay pemain baru, v5.2.0).
// Membuktikan (di jsdom + server sungguhan):
//   (1) Warga BARU: overlay #tutorial-modal muncul otomatis saat login
//       pertama, langkah 1 dari 7, tombol "Lewati" selalu ada; modal
//       pengumuman tidak menumpuk di atasnya.
//   (2) "Lewati" ada di TIAP langkah (1–7); tombol Lanjut di langkah
//       terakhir berubah jadi "MULAI BERMAIN".
//   (3) Menyelesaikan semua langkah menutup permanen: /api/me
//       tutorial_done = 1; login ulang (DOM baru) → overlay TIDAK muncul.
//   (4) Warga baru lain: klik "Lewati" di langkah 1 → tertutup;
//       /api/me tutorial_done = 1; login ulang → tidak muncul.
//   (5) "Lihat Tutorial Lagi" di Buku Panduan (#/book) membuka ulang
//       overlay (replay); menutupnya tidak mengubah tutorial_done (tetap 1).
//   (6) Tombol replay yang sama ada di Pengaturan (#/settings).
// Jalankan: node test/tutorial-dom.js  (atau: npm run test:tutorial)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3475;
const DB_PATH = '/tmp/parlementer-tutorial-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;
const EXPECTED_VERSION = '5.7.3';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function makeJar() {
  let cookie = '';
  return async (url, opts = {}) => {
    const full = typeof url === 'string' && url.startsWith('/') ? BASE + url : url;
    const res = await fetch(full, {
      ...opts,
      headers: { ...(opts.headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return res;
  };
}
async function api(jar, path, body) {
  const res = await jar(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function bootDom(url, jarFetchFn) {
  const html = await (await fetch(BASE + '/')).text();
  const htmlNoFonts = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>\s*/g, '')
    .replace(/<link[^>]*fonts\.gstatic\.com[^>]*>/g, '');
  const dom = new JSDOM(htmlNoFonts, {
    url,
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) { window.fetch = jarFetchFn; },
  });
  const { window } = dom;
  await new Promise((resolve) => {
    if (window.document.readyState === 'complete') resolve();
    else window.addEventListener('load', resolve);
    setTimeout(resolve, 5000);
  });
  await sleep(1800);
  return dom;
}
const pageText = (dom) => dom.window.document.querySelector('#page')?.textContent || '';
const tutVisible = (dom) => {
  const m = dom.window.document.querySelector('#tutorial-modal');
  return !!m && !m.hidden;
};
const tutLabel = (dom) => dom.window.document.querySelector('#tutorial-step-label')?.textContent || '';
const skipVisible = (dom) => {
  const b = dom.window.document.querySelector('#tutorial-skip');
  return tutVisible(dom) && !!b && b.textContent.trim() === 'Lewati';
};

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[tutorial-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'tutorial-dom-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  let dom2 = null;
  try {
    await sleep(1200);

    const world = await (await fetch(BASE + '/api/world')).json();
    check('API /api/world: versi 5.7.3', world.version === EXPECTED_VERSION, `version=${world.version}`);

    // --- (1) Warga baru: overlay muncul otomatis saat login pertama.
    const jar = makeJar();
    const r = await api(jar, '/api/auth/register', { email: 'domTut@test.local', password: 'rahasia123', username: 'warga_tut' });
    check('Daftar warga_tut (API)', r.status === 200 && r.data.ok);
    const me0 = (await api(jar, '/api/me')).data.citizen;
    check('Warga baru: /api/me tutorial_done = 0', me0?.tutorial_done === 0, `tutorial_done=${me0?.tutorial_done}`);
    dom = await bootDom(BASE + '/#/dashboard', jar);
    const doc = dom.window.document;
    check('Warga baru: overlay #tutorial-modal MUNCUL otomatis', tutVisible(dom));
    check('Warga baru: langkah 1 dari 7', tutLabel(dom).includes('Langkah 1 dari 7'), tutLabel(dom));
    check('Warga baru: judul langkah 1 "Selamat datang di Parlementer!"',
      (doc.querySelector('#tutorial-title')?.textContent || '').includes('Selamat datang di Parlementer!'));
    check('Warga baru: tombol "Lewati" ada di langkah 1', skipVisible(dom));
    check('Warga baru: tombol Lanjut bertuliskan "Lanjut" di langkah 1',
      (doc.querySelector('#tutorial-next')?.textContent || '').trim() === 'Lanjut');
    check('Warga baru: 7 titik progres, titik 1 aktif',
      doc.querySelectorAll('#tutorial-dots .tutorial-dot').length === 7
      && !!doc.querySelector('#tutorial-dots .tutorial-dot.active'));
    check('Warga baru: modal pengumuman TIDAK menumpuk di atas tutorial',
      !!doc.querySelector('#announce-modal')?.hidden);

    // --- (2) Lewati ada di tiap langkah; langkah terakhir = MULAI BERMAIN.
    for (let step = 2; step <= 7; step++) {
      doc.querySelector('#tutorial-next').click();
      await sleep(700);
      check(`Langkah ${step}: label "Langkah ${step} dari 7"`, tutLabel(dom).includes(`Langkah ${step} dari 7`), tutLabel(dom));
      check(`Langkah ${step}: tombol "Lewati" tetap ada`, skipVisible(dom));
    }
    check('Langkah 7: tombol berubah jadi "MULAI BERMAIN"',
      (doc.querySelector('#tutorial-next')?.textContent || '').trim() === 'MULAI BERMAIN');
    check('Langkah 7: judul tentang partai/negara',
      (doc.querySelector('#tutorial-title')?.textContent || '').includes('dirikan negara'));

    // --- (3) Selesaikan semua langkah → permanen (server) + login ulang diam.
    doc.querySelector('#tutorial-next').click();
    await sleep(700);
    check('Selesai: overlay tertutup', !tutVisible(dom));
    const me1 = (await api(jar, '/api/me')).data.citizen;
    check('Selesai: /api/me tutorial_done = 1 (tersimpan di server)', me1?.tutorial_done === 1, `tutorial_done=${me1?.tutorial_done}`);
    dom2 = await bootDom(BASE + '/#/dashboard', jar);
    check('Login ulang: overlay TIDAK muncul lagi untuk pemain yang sudah selesai', !tutVisible(dom2));
    dom2.window.close(); dom2 = null;

    // --- (4) Warga baru lain: Lewati di langkah 1 → permanen juga.
    const jar2 = makeJar();
    const r2 = await api(jar2, '/api/auth/register', { email: 'domTut2@test.local', password: 'rahasia123', username: 'warga_tut2' });
    check('Daftar warga_tut2 (API)', r2.status === 200 && r2.data.ok);
    dom2 = await bootDom(BASE + '/#/dashboard', jar2);
    check('Warga baru 2: overlay muncul', tutVisible(dom2));
    dom2.window.document.querySelector('#tutorial-skip').click();
    await sleep(700);
    check('Lewati: overlay tertutup', !tutVisible(dom2));
    const me2 = (await api(jar2, '/api/me')).data.citizen;
    check('Lewati: /api/me tutorial_done = 1', me2?.tutorial_done === 1, `tutorial_done=${me2?.tutorial_done}`);
    dom2.window.close(); dom2 = null;
    dom2 = await bootDom(BASE + '/#/dashboard', jar2);
    check('Login ulang warga 2: overlay TIDAK muncul lagi', !tutVisible(dom2));
    dom2.window.close(); dom2 = null;

    // --- (5) Replay dari Buku Panduan.
    dom.window.location.hash = '#/book';
    await sleep(900);
    check('Buku Panduan: tombol "LIHAT TUTORIAL LAGI" ada',
      !!doc.querySelector('[data-replay-tutorial]'));
    doc.querySelector('[data-replay-tutorial]').click();
    await sleep(500);
    check('Replay: overlay muncul lagi dari Buku Panduan', tutVisible(dom));
    check('Replay: kembali ke langkah 1', tutLabel(dom).includes('Langkah 1 dari 7'), tutLabel(dom));
    doc.querySelector('#tutorial-skip').click();
    await sleep(700);
    check('Replay: Lewati menutup overlay', !tutVisible(dom));
    const me3 = (await api(jar, '/api/me')).data.citizen;
    check('Replay: tutorial_done tetap 1', me3?.tutorial_done === 1, `tutorial_done=${me3?.tutorial_done}`);

    // --- (6) Tombol replay juga ada di Pengaturan.
    dom.window.location.hash = '#/settings';
    await sleep(900);
    check('Pengaturan: tombol "LIHAT TUTORIAL LAGI" ada',
      !!doc.querySelector('[data-replay-tutorial]'));
    check('Pengaturan: halaman memuat panel TUTORIAL AWAL',
      pageText(dom).includes('TUTORIAL AWAL'));

    // --- (7) Regresi: pemain baru yang masuk lewat deep link (bukan
    // dashboard) TIDAK dibajak — overlay tidak muncul di halaman lain,
    // dan baru muncul begitu ia sampai di dashboard.
    const jar3 = makeJar();
    const r3 = await api(jar3, '/api/auth/register', { email: 'domTut3@test.local', password: 'rahasia123', username: 'warga_tut3' });
    check('Daftar warga_tut3 (API)', r3.status === 200 && r3.data.ok);
    dom2 = await bootDom(BASE + '/#/companies', jar3);
    await sleep(900);
    check('Deep link #/companies: overlay TIDAK muncul otomatis', !tutVisible(dom2));
    check('Deep link #/companies: rute tetap di perusahaan (tidak dibajak ke dashboard)',
      (dom2.window.location.hash || '') === '#/companies', dom2.window.location.hash);
    dom2.window.location.hash = '#/dashboard';
    await sleep(900);
    check('Pindah ke dashboard: overlay muncul (tertunda, bukan hilang)', tutVisible(dom2));
    dom2.window.close(); dom2 = null;
  } finally {
    if (dom) dom.window.close();
    if (dom2) dom2.window.close();
    stop();
  }
  console.log(`\n[tutorial-dom] ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
