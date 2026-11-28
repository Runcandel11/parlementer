// Parlementer — tes DOM UI fluid (v5.7.5).
// Membuktikan (di jsdom + server sungguhan):
//   (1) VERSI: /api/world melaporkan 5.7.5.
//   (2) CSS POLISH: keyframes + aturan baru ada di style.css — denyut
//       KAMU (youPulse), rute berjalan (routeMarch), umpan tekan kartu/
//       ubin (:active scale .98), modal memudar (modalFade), halaman
//       masuk berjenjang (nth-child delay), kamera peta pakai transform
//       (bukan lebar), wadah peta touch-action none.
//   (3) REDUCED MOTION: blok @media (prefers-reduced-motion: reduce)
//       mematikan animasi baru (youPulse/routeMarch/modalFade/dotPulse).
//   (4) LIVE: dashboard merender 17 ubin PETA LANGSUNG + ubin wilayah
//       pemain (.mine) dengan titik berdenyut; halaman peta merender
//       vignette + panel yang terisi (bukan "Memuat…").
// Jalankan: node test/ui-fluid-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3476;
const DB_PATH = '/tmp/parlementer-ui-fluid-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;
const EXPECTED_VERSION = '5.7.5';

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
async function api(jar, path, body, method) {
  const res = await jar(path, body === undefined && !method ? undefined : { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function bootDom(url, jarFetchFn) {
  const html = await (await fetch(BASE + '/')).text();
  const htmlNoFonts = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>\s*/g, '')
    .replace(/<link[^>]*fonts\.gstatic\.com[^>]*>\s*/g, '');
  const dom = new JSDOM(htmlNoFonts, {
    url,
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = jarFetchFn;
    },
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

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[ui-fluid-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'ui-fluid-dom-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  try {
    await sleep(1200);

    const jarA = makeJar();
    let r = await api(jarA, '/api/auth/register', { email: 'domFluid@test.local', password: 'rahasia123', username: 'warga_fluid' });
    check('Daftar pemain (API)', r.status === 200 && r.data.ok, `status=${r.status}`);

    // --- (1) VERSI ---
    r = await api(jarA, '/api/world');
    check('API /api/world: versi 5.7.5', r.data.version === EXPECTED_VERSION, `version=${r.data.version}`);

    // --- (2) CSS POLISH (baca file, bukan computed style — jsdom tak berlayout) ---
    const css = fs.readFileSync(ROOT + 'public/css/style.css', 'utf8');
    check('CSS: @keyframes youPulse ada', css.includes('@keyframes youPulse'));
    check('CSS: .map-you-ring memakai animasi youPulse', /\.map-you-ring\s*\{[^}]*animation:\s*youPulse/.test(css));
    check('CSS: @keyframes routeMarch ada', css.includes('@keyframes routeMarch'));
    check('CSS: .map-route memakai animasi routeMarch', /\.map-route\s*\{[^}]*animation:\s*routeMarch/.test(css));
    check('CSS: .map-tile:active scale(.98)', /\.map-tile:active[^{]*\{[^}]*transform:\s*scale\(\.98\)/.test(css) || css.includes('.map-tile:active, .stat-cell:active, .inv-card:active, .food-card:active { transform: scale(.98); }'));
    check('CSS: .stat-cell:active scale(.98)', css.includes('.stat-cell:active'));
    check('CSS: @keyframes modalFade ada', css.includes('@keyframes modalFade'));
    check('CSS: .modal memakai animasi modalFade', /\.modal\s*\{[^}]*animation:\s*modalFade/.test(css));
    check('CSS: halaman masuk berjenjang (.page > *:nth-child(2) delay)', css.includes('.page > *:nth-child(2) { animation-delay: .03s; }'));
    check('CSS: #big-map transisi transform .25s', /#big-map\s*\{[^}]*transition:\s*transform\s*\.25s/.test(css));
    check('CSS: .big-map-wrap touch-action none', /\.big-map-wrap\s*\{[^}]*touch-action:\s*none/.test(css));
    check('CSS: ubin wilayah pemain .mt-dot berdenyut (dotPulse)', css.includes('@keyframes dotPulse') && css.includes('.map-tile.mine .mt-dot'));
    check('CSS: overlay peta (.map-overlay) ada', css.includes('.map-overlay { position: absolute;'));
    check('CSS: @keyframes warPulse ada (lapisan Perang)', css.includes('@keyframes warPulse'));
    check('CSS: panel peta full-bleed (margin -14px)', css.includes('margin-left: -14px'));
    check('CSS: laut gelap (#070b14)', css.includes('.map-ocean { fill: #070b14; }'));

    // --- (3) REDUCED MOTION (gabung semua blok @media multi-baris) ---
    const rmBlocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g)].map((m) => m[0]).join('\n');
    const rmBlock = rmBlocks;
    check('Reduced motion: blok @media ada', rmBlock.length > 0);
    check('Reduced motion: mematikan denyut KAMU (.map-you-ring)', rmBlock.includes('.map-you-ring'));
    check('Reduced motion: mematikan rute (.map-route)', rmBlock.includes('.map-route'));
    check('Reduced motion: mematikan modal (.modal)', rmBlock.includes('.modal'));
    check('Reduced motion: mematikan transisi #big-map', rmBlock.includes('#big-map'));

    // --- (4) LIVE: dashboard + peta ---
    dom = await bootDom(BASE + '/#/dashboard', jarA);
    const { window } = dom;
    const { document } = window;
    await sleep(1500);
    const tiles = document.querySelectorAll('.map-tile');
    check('Dashboard: 17 ubin PETA LANGSUNG', tiles.length === 17, `n=${tiles.length}`);
    const mineTile = document.querySelector('.map-tile.mine');
    check('Dashboard: ubin wilayah pemain (.mine) ada', !!mineTile);
    check('Dashboard: ubin .mine punya titik (.mt-dot)', !!mineTile?.querySelector('.mt-dot'));
    check('Dashboard: halaman ter-render (#page punya anak)', (document.querySelector('#page')?.children.length || 0) > 0);

    window.location.hash = '#/map';
    await sleep(1800);
    check('Peta: #big-map-wrap ada', !!document.querySelector('#big-map-wrap'));
    check('Peta: vignette overlay ada', !!document.querySelector('.map-vignette'));
    check('Peta: cari di overlay kiri atas', !!document.querySelector('.map-overlay-tl #map-search'));
    check('Peta: slider + Lokasi saya di overlay kanan atas', !!document.querySelector('.map-overlay-tr #map-zoom-slider') && !!document.querySelector('.map-overlay-tr #map-locate-me'));
    check('Peta: panel Lapisan Peta di kiri bawah', !!document.querySelector('.map-overlay-bl #map-layer-politics'));
    check('Peta: penanda KAMU (.map-you) ada', !!document.querySelector('.map-you'));
    const panelTxt = document.querySelector('#map-panel-body')?.textContent || '';
    check('Peta: panel terisi (bukan "Memuat…")', panelTxt.length > 20 && !panelTxt.includes('Memuat…'), panelTxt.slice(0, 60));
  } finally {
    if (dom) dom.window.close();
    stop();
  }

  console.log(`\n[ui-fluid-dom] ${passed} lolos, ${failed} gagal.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
