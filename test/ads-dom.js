// Parlementer — tes DOM menu "Nonton Iklan" berhadiah (AdinPlay, v4.4.0).
// Membuktikan (di jsdom + server sungguhan, property ID KOSONG —
// server di-boot TANPA ADINPLAY_PROPERTY_ID):
//   (1) menu "🎬 Nonton Iklan" ada di drawer (grup EKONOMI) + mengarah ke
//       route #/ads;
//   (2) kartu "NONTON IKLAN" ada di dashboard dengan status "Segera hadir";
//   (3) halaman #/ads menampilkan "Segera hadir" + TIDAK ada tombol
//       tonton (tidak ada iklan palsu, tidak ada hadiah apa pun);
//   (4) TIDAK ada skrip AdinPlay yang dimuat saat ID kosong;
//   (5) POST /api/ads/start ditolak 503 saat iklan belum aktif;
//   (6) /api/me melaporkan ads.enabled=false + rewardGold 30;
//   (7) VERSI: /api/world melaporkan 5.0.1.
// Alur berhadiah lengkap (start → reward +30, single-use, kedaluwarsa,
// jeda minimum, tanpa cap) diuji di test/e2e.js [30] dengan server yang
// di-boot memakai ADINPLAY_PROPERTY_ID test.
// Jalankan: node test/ads-dom.js  (atau: npm run test:ads)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3471;
const DB_PATH = '/tmp/parlementer-ads-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;
const EXPECTED_VERSION = '5.0.1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// Cookie jar per pemain (node fetch tidak menyimpan cookie sendiri).
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

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[ads-dom] Menyalakan server di port ' + PORT + ' (tanpa ADINPLAY_PROPERTY_ID) ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'ads-dom-test-secret', ADINPLAY_PROPERTY_ID: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  try {
    await sleep(1200);

    // (7) Versi dulu (tanpa login).
    const world = await (await fetch(BASE + '/api/world')).json();
    check('API /api/world: versi 5.0.1', world.version === EXPECTED_VERSION, `version=${world.version}`);

    const jar = makeJar();
    const r = await api(jar, '/api/auth/register', { email: 'domAds@test.local', password: 'rahasia123', username: 'warga_ads' });
    check('Daftar warga_ads (API)', r.status === 200 && r.data.ok);

    // (6) /api/me melaporkan iklan belum aktif.
    const me = await api(jar, '/api/me');
    check('/api/me: ads.enabled=false saat property ID kosong', me.data.ads?.enabled === false, JSON.stringify(me.data.ads));
    check('/api/me: ads.rewardGold=30', me.data.ads?.rewardGold === 30, `rewardGold=${me.data.ads?.rewardGold}`);
    check('/api/me: ads.propertyId kosong', me.data.ads?.propertyId === '', `propertyId=${me.data.ads?.propertyId}`);

    // (5) /api/ads/start ditolak saat iklan belum aktif.
    const st = await api(jar, '/api/ads/start', {});
    check('POST /api/ads/start ditolak 503 saat iklan belum aktif', st.status === 503, `status=${st.status} ${st.data.error || ''}`);
    const rw = await api(jar, '/api/ads/reward', { token: 'token-palsu' });
    check('POST /api/ads/reward token palsu ditolak 400', rw.status === 400, `status=${rw.status}`);

    // --- DOM: boot di dashboard ---
    dom = await bootDom(BASE + '/#/dashboard', jar);
    const { document } = dom.window;

    // (1) Menu drawer.
    const navItem = document.querySelector('#drawer-nav .nav-item[data-route="ads"]');
    check('Drawer berisi menu "Nonton Iklan" (data-route=ads)', !!navItem, navItem?.textContent.trim());
    check('Menu drawer memakai ikon 🎬', (navItem?.textContent || '').includes('🎬'));

    // (2) Kartu dashboard.
    const card = document.querySelector('#dash-ads');
    check('Dashboard berisi kartu #dash-ads', !!card);
    check('Kartu dashboard berstatus "Segera hadir"', (card?.textContent || '').includes('Segera hadir'), (card?.textContent || '').slice(0, 120));
    check('Kartu dashboard TIDAK punya tombol tonton saat belum aktif', !document.querySelector('#btn-watch-ad'));

    // (4) Tidak ada skrip AdinPlay yang dimuat saat ID kosong.
    check('Tidak ada <script> AdinPlay yang dimuat saat ID kosong',
      !document.querySelector('script[src*="adinplay"]'));

    // (3) Halaman #/ads: "Segera hadir", tanpa tombol tonton.
    dom.window.location.hash = '#/ads';
    await sleep(1500);
    check('Route #/ads: hash jadi #/ads', dom.window.location.hash === '#/ads', `hash=${dom.window.location.hash}`);
    check('Halaman #/ads menampilkan "Segera hadir"', pageText(dom).includes('Segera hadir'), pageText(dom).slice(0, 120));
    check('Halaman #/ads TIDAK punya tombol tonton iklan', !document.querySelector('#btn-watch-ad'));
    check('Halaman #/ads menyebut hadiah +30 emas', pageText(dom).includes('+30 emas'), pageText(dom).slice(0, 200));
    check('Halaman #/ads TIDAK memuat skrip AdinPlay', !document.querySelector('script[src*="adinplay"]'));

    // (1) Klik menu drawer "Nonton Iklan" → pindah ke #/ads.
    dom.window.location.hash = '#/dashboard';
    await sleep(1200);
    document.querySelector('#drawer-nav .nav-item[data-route="ads"]')?.click();
    await sleep(1200);
    check('Klik menu drawer: hash jadi #/ads', dom.window.location.hash === '#/ads', `hash=${dom.window.location.hash}`);
    check('Klik menu drawer: halaman iklan termuat', pageText(dom).includes('Segera hadir'));
  } finally {
    if (dom) dom.window.close();
    stop();
  }
  console.log(`\n[ads-dom] ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
