// Parlementer — tes DOM menu "Nonton Iklan" berhadiah (AdinPlay, v4.4.0)
// + banner AdSense berhadiah (v5.3.0).
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
//   (7) VERSI: /api/world melaporkan 5.7.2;
//   (8) Banner (slot kosong): /api/me melaporkan banner.enabled=false +
//       rewardGold 15 + dailyCap 10 + viewMs 10000; halaman #/ads
//       menampilkan panel banner + placeholder "belum tersedia" + TIDAK
//       ada tombol klaim; POST /api/ads/banner/start ditolak 503;
//   (9) Banner (slot terisi, server kedua): <ins class="adsbygoogle">
//       ter-render dengan data-ad-client + data-ad-slot yang benar;
//       tombol klaim ada tapi DISABLED (iklan tidak terisi di jsdom —
//       tidak ada hadiah tanpa banner yang benar-benar tampil);
//       POST /api/ads/banner/start memberi token 64 hex + remainingToday 10.
// Alur berhadiah lengkap video (start → reward +30, single-use,
// kedaluwarsa, jeda minimum, tanpa cap) diuji di test/e2e.js [30] dengan
// server yang di-boot memakai ADINPLAY_PROPERTY_ID test; alur banner
// (+15, lihat 10 detik, cap 10/hari, kind token) di test/e2e.js [37]
// dengan server yang di-boot memakai ADSENSE_BANNER_SLOT test.
// Jalankan: node test/ads-dom.js  (atau: npm run test:ads)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3471;
const DB_PATH = '/tmp/parlementer-ads-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;
const EXPECTED_VERSION = '5.7.3';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// Cookie jar per pemain (node fetch tidak menyimpan cookie sendiri).
function makeJar(base) {
  let cookie = '';
  return async (url, opts = {}) => {
    const full = typeof url === 'string' && url.startsWith('/') ? base + url : url;
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

async function bootDom(url, jarFetchFn, base) {
  const html = await (await fetch(base + '/')).text();
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

  console.log('[ads-dom] Menyalakan server di port ' + PORT + ' (tanpa ADINPLAY_PROPERTY_ID, tanpa ADSENSE_BANNER_SLOT) ...');
  let server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'ads-dom-test-secret', ADINPLAY_PROPERTY_ID: '', ADSENSE_BANNER_SLOT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  try {
    await sleep(1200);

    // (7) Versi dulu (tanpa login).
    const world = await (await fetch(BASE + '/api/world')).json();
    check('API /api/world: versi 5.7.3', world.version === EXPECTED_VERSION, `version=${world.version}`);

    const jar = makeJar(BASE);
    const r = await api(jar, '/api/auth/register', { email: 'domAds@test.local', password: 'rahasia123', username: 'warga_ads' });
    check('Daftar warga_ads (API)', r.status === 200 && r.data.ok);

    // (6) /api/me melaporkan iklan belum aktif.
    const me = await api(jar, '/api/me');
    check('/api/me: ads.enabled=false saat property ID kosong', me.data.ads?.enabled === false, JSON.stringify(me.data.ads));
    check('/api/me: ads.rewardGold=30', me.data.ads?.rewardGold === 30, `rewardGold=${me.data.ads?.rewardGold}`);
    check('/api/me: ads.propertyId kosong', me.data.ads?.propertyId === '', `propertyId=${me.data.ads?.propertyId}`);

    // (8) Banner: slot kosong → tidak aktif, tapi angka hadiah/cap tampil.
    const bn = me.data.ads?.banner || {};
    check('/api/me: ads.banner.enabled=false saat slot kosong', bn.enabled === false, JSON.stringify(bn));
    check('/api/me: ads.banner.slot kosong', bn.slot === '', `slot=${bn.slot}`);
    check('/api/me: ads.banner.rewardGold=15', bn.rewardGold === 15, `rewardGold=${bn.rewardGold}`);
    check('/api/me: ads.banner.dailyCap=10', bn.dailyCap === 10, `dailyCap=${bn.dailyCap}`);
    check('/api/me: ads.banner.viewMs=10000', bn.viewMs === 10000, `viewMs=${bn.viewMs}`);

    // (5) /api/ads/start ditolak saat iklan belum aktif.
    const st = await api(jar, '/api/ads/start', {});
    check('POST /api/ads/start ditolak 503 saat iklan belum aktif', st.status === 503, `status=${st.status} ${st.data.error || ''}`);
    const rw = await api(jar, '/api/ads/reward', { token: 'token-palsu' });
    check('POST /api/ads/reward token palsu ditolak 400', rw.status === 400, `status=${rw.status}`);

    // (8) Banner: /start ditolak 503 saat slot kosong; reward palsu 400.
    const bst = await api(jar, '/api/ads/banner/start', {});
    check('POST /api/ads/banner/start ditolak 503 saat slot kosong', bst.status === 503, `status=${bst.status} ${bst.data.error || ''}`);
    const brw = await api(jar, '/api/ads/banner/reward', { token: 'token-palsu' });
    check('POST /api/ads/banner/reward token palsu ditolak 400', brw.status === 400, `status=${brw.status}`);

    // --- DOM: boot di dashboard ---
    dom = await bootDom(BASE + '/#/dashboard', jar, BASE);
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

    // (8) Banner di #/ads saat slot kosong: panel + placeholder, tanpa klaim.
    check('Halaman #/ads menampilkan panel banner "LIHAT BANNER IKLAN"', pageText(dom).includes('LIHAT BANNER IKLAN'), pageText(dom).slice(0, 300));
    check('Halaman #/ads menyebut hadiah banner +15 emas', pageText(dom).includes('+15 emas'), pageText(dom).slice(0, 300));
    check('Halaman #/ads menyebut batas harian banner 10×/hari', pageText(dom).includes('10×/hari'), pageText(dom).slice(0, 300));
    check('Banner slot kosong: placeholder "belum tersedia"', pageText(dom).includes('belum tersedia'), pageText(dom).slice(0, 300));
    check('Banner slot kosong: TIDAK ada tombol klaim', !document.querySelector('#btn-claim-banner'));
    check('Banner slot kosong: TIDAK ada <ins> unit iklan (data-ad-slot)', !document.querySelector('ins.adsbygoogle[data-ad-slot]'));
    // Catatan: pustaka adsbygoogle sendiri menyuntik <ins> tersembunyi
    // (data-ad-hi, display:none) di semua halaman — itu BUKAN unit iklan
    // kita, jadi ceknya memakai [data-ad-slot], bukan .adsbygoogle saja.

    // (1) Klik menu drawer "Nonton Iklan" → pindah ke #/ads.
    dom.window.location.hash = '#/dashboard';
    await sleep(1200);
    document.querySelector('#drawer-nav .nav-item[data-route="ads"]')?.click();
    await sleep(1200);
    check('Klik menu drawer: hash jadi #/ads', dom.window.location.hash === '#/ads', `hash=${dom.window.location.hash}`);
    check('Klik menu drawer: halaman iklan termuat', pageText(dom).includes('Segera hadir'));
  } finally {
    if (dom) { dom.window.close(); dom = null; }
    stop();
  }

  // --- (9) Server kedua: slot banner terisi (ADINPLAY tetap kosong) ---
  const PORT2 = PORT + 1;
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  const DB2 = '/tmp/parlementer-ads-dom2.db';
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB2 + suffix); } catch {} }
  console.log('[ads-dom] Menyalakan server kedua di port ' + PORT2 + ' (ADSENSE_BANNER_SLOT terisi) ...');
  server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT2), DATABASE_PATH: DB2, JWT_SECRET: 'ads-dom-test-secret', ADINPLAY_PROPERTY_ID: '', ADSENSE_BANNER_SLOT: '1234567890' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  stop = () => { try { server.kill('SIGTERM'); } catch {} };
  try {
    await sleep(1200);
    const jar2 = makeJar(BASE2);
    const r2 = await api(jar2, '/api/auth/register', { email: 'domAds2@test.local', password: 'rahasia123', username: 'warga_ads2' });
    check('Daftar warga_ads2 (API, server slot)', r2.status === 200 && r2.data.ok);
    const me2 = await api(jar2, '/api/me');
    const bn2 = me2.data.ads?.banner || {};
    check('/api/me (server slot): banner.enabled=true', bn2.enabled === true, JSON.stringify(bn2));
    check('/api/me (server slot): banner.slot=1234567890', bn2.slot === '1234567890', `slot=${bn2.slot}`);
    const st2 = await api(jar2, '/api/ads/banner/start', {});
    check('POST /api/ads/banner/start (slot terisi): token 64 hex + remainingToday 10',
      st2.status === 200 && typeof st2.data.token === 'string' && st2.data.token.length === 64 && st2.data.remainingToday === 10,
      `status=${st2.status} remaining=${st2.data.remainingToday}`);

    dom = await bootDom(BASE2 + '/#/ads', jar2, BASE2);
    const { document } = dom.window;
    const ins = document.querySelector('ins.adsbygoogle');
    check('Banner slot terisi: <ins class="adsbygoogle"> ter-render', !!ins);
    check('Banner slot terisi: data-ad-slot benar', ins?.getAttribute('data-ad-slot') === '1234567890', `slot=${ins?.getAttribute('data-ad-slot')}`);
    check('Banner slot terisi: data-ad-client = ca-pub-2013457230013617', ins?.getAttribute('data-ad-client') === 'ca-pub-2013457230013617', `client=${ins?.getAttribute('data-ad-client')}`);
    const claimBtn = document.querySelector('#btn-claim-banner');
    check('Banner slot terisi: tombol klaim ada', !!claimBtn);
    check('Banner slot terisi: tombol klaim DISABLED (iklan belum terisi)', claimBtn?.disabled === true);
    check('Banner slot terisi: status memuat banner', (document.querySelector('#banner-status')?.textContent || '').includes('Memuat banner'), document.querySelector('#banner-status')?.textContent);
    check('Banner slot terisi: TIDAK ada placeholder "belum tersedia"', !pageText(dom).includes('belum tersedia'));
  } finally {
    if (dom) dom.window.close();
    stop();
  }
  console.log(`\n[ads-dom] ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
