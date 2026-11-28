// Parlementer — tes DOM animasi saldo emas HUD (v5.7.3, poles Lane 2).
// Membuktikan (di jsdom + server sungguhan):
//   (1) CSS: .hud-pill punya position:relative (jangkar chip selisih);
//       aturan .gold-delta + .gold-delta.plus/.minus + keyframes
//       goldBump + goldDeltaFloat ada; ada blok prefers-reduced-motion;
//   (2) Render awal: #hud-gold berisi '50' (emas warga baru) dan TIDAK
//       ada chip .gold-delta (animasi hanya saat emas BERUBAH, bukan
//       saat pertama tampil);
//   (3) Klaim pasokan harian (+5 emas, lewat tombol peti #btn-crate):
//       #hud-gold langsung '55' (nilai akhir, sinkron) + chip '+5'
//       (class plus) muncul di pill emas + pill dapat class gold-bump;
//       chip hilang sendiri setelah ~0,95 detik;
//   (4) Beli 1 kaleng Minuman Energi (−0,10 emas): chip '-0,1' (class
//       minus) muncul; #hud-gold tetap '55' (fmt membulatkan 54,9);
//   (5) prefers-reduced-motion: emas tetap berubah ke '55' tapi TIDAK
//       ada chip dan TIDAK ada class gold-bump.
// Catatan jujur: jsdom tidak menjalankan animasi CSS sungguhan, jadi
// "melayang + menghilang" dibuktikan lewat class/keyframes CSS + chip
// yang ditambah/dihapus JS; periksa visual akhir tetap di browser.
// Jalankan: node test/gold-delta-dom.js  (atau: npm run test:gold-delta)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3476;
const DB_PATH = '/tmp/parlementer-gold-delta-dom.db';
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

async function bootDom(url, jarFetchFn, stubReducedMotion = false) {
  const html = await (await fetch(BASE + '/')).text();
  const htmlNoFonts = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>\s*/g, '')
    .replace(/<link[^>]*fonts\.gstatic\.com[^>]*>/g, '');
  const dom = new JSDOM(htmlNoFonts, {
    url,
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = jarFetchFn;
      if (stubReducedMotion) {
        window.matchMedia = (q) => ({
          matches: String(q).includes('prefers-reduced-motion'),
          media: q, addListener() {}, removeListener() {},
          addEventListener() {}, removeEventListener() {},
        });
      }
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

// Polling kecil: animasi chip hidup ±0,95 detik, jadi kehadirannya
// harus dicek dalam jendela itu — tunggu sampai kondisi benar.
async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(100);
  }
  return fn();
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[gold-delta-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'gold-delta-dom-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  let domReduced = null;
  try {
    await sleep(1200);

    const world = await (await fetch(BASE + '/api/world')).json();
    check('API /api/world: versi 5.7.3', world.version === EXPECTED_VERSION, `version=${world.version}`);

    // --- (1) CSS disajikan + aturan animasi emas ada di dalamnya.
    const cssRes = await fetch(BASE + '/css/style.css');
    const css = await cssRes.text();
    check('CSS utama disajikan (200)', cssRes.status === 200 && css.length > 10000, `bytes=${css.length}`);
    check('CSS: .hud-pill punya position:relative (jangkar chip)',
      /\.hud-pill\s*\{[^}]*position:\s*relative/.test(css));
    check('CSS: aturan .gold-delta ada', css.includes('.gold-delta {'));
    check('CSS: chip plus hijau + minus merah',
      css.includes('.gold-delta.plus') && css.includes('.gold-delta.minus'));
    check('CSS: keyframes goldBump ada', css.includes('@keyframes goldBump'));
    check('CSS: keyframes goldDeltaFloat ada', css.includes('@keyframes goldDeltaFloat'));
    check('CSS: class gold-bump memakai animasi goldBump',
      /\.hud-pill-gold\.gold-bump\s*\{[^}]*animation:\s*goldBump/.test(css));
    check('CSS: blok prefers-reduced-motion mematikan animasi emas',
      css.includes('@media (prefers-reduced-motion: reduce)') && /\.gold-delta\s*\{\s*animation:\s*none/.test(css));

    // --- (2) Warga baru, boot dashboard: emas awal 50, tanpa chip.
    const jar = makeJar();
    const r = await api(jar, '/api/auth/register', { email: 'domGold@test.local', password: 'rahasia123', username: 'warga_gold' });
    check('Daftar warga_gold (API)', r.status === 200 && r.data.ok);
    dom = await bootDom(BASE + '/#/dashboard', jar);
    const doc = dom.window.document;
    const goldEl = () => doc.querySelector('#hud-gold');
    const goldPill = () => doc.querySelector('.hud-pill-gold');
    const chip = () => doc.querySelector('.gold-delta');
    check('HUD: emas awal warga baru 50', (goldEl()?.textContent || '') === '50', goldEl()?.textContent);
    check('HUD: render awal TIDAK memunculkan chip selisih', !chip());

    // --- (3) Klaim pasokan harian (+5 emas) lewat tombol peti.
    const crate = doc.querySelector('#btn-crate');
    check('HUD: tombol peti pasokan #btn-crate ada', !!crate);
    crate.click();
    const chipSeen = await waitFor(() => !!chip() && (goldEl()?.textContent || '') === '55');
    check('Klaim: #hud-gold langsung 55 (nilai akhir, sinkron)',
      (goldEl()?.textContent || '') === '55', goldEl()?.textContent);
    check('Klaim: chip selisih muncul', !!chip(), chip()?.textContent || '(tidak ada)');
    check('Klaim: chip berisi "+5" (class plus)',
      (chip()?.textContent || '') === '+5' && chip()?.classList.contains('plus'), chip()?.textContent || '(tidak ada)');
    check('Klaim: pill emas dapat class gold-bump',
      goldPill()?.classList.contains('gold-bump') === true);
    check('Klaim: chip aria-hidden (nilai akhir sudah di #hud-gold)',
      chip()?.getAttribute('aria-hidden') === 'true');
    void chipSeen;
    await sleep(1400);
    check('Klaim: chip hilang sendiri setelah animasi (~0,95 dtk)', !chip());
    check('Klaim: class gold-bump ikut dibersihkan',
      goldPill()?.classList.contains('gold-bump') === false);

    // --- (4) Beli 1 kaleng Minuman Energi (−0,10 emas).
    const buy = await api(jar, '/api/shop/energy-drink', { qty: 1 });
    check('Beli 1 kaleng Minuman Energi (API)', buy.status === 200 && buy.data.ok && buy.data.cost === 0.1, `cost=${buy.data.cost}`);
    await dom.window.refreshMe();
    const minusSeen = await waitFor(() => !!chip());
    check('Beli minuman: chip selisih muncul', !!chip(), chip()?.textContent || '(tidak ada)');
    check('Beli minuman: chip berisi "-0,1" (class minus)',
      (chip()?.textContent || '') === '-0,1' && chip()?.classList.contains('minus'), chip()?.textContent || '(tidak ada)');
    check('Beli minuman: #hud-gold tetap 55 (54,9 dibulatkan fmt)',
      (goldEl()?.textContent || '') === '55', goldEl()?.textContent);
    void minusSeen;

    // --- (5) prefers-reduced-motion: nilai berubah, tanpa animasi.
    const jar2 = makeJar();
    const r2 = await api(jar2, '/api/auth/register', { email: 'domGold2@test.local', password: 'rahasia123', username: 'warga_gold2' });
    check('Daftar warga_gold2 (API)', r2.status === 200 && r2.data.ok);
    domReduced = await bootDom(BASE + '/#/dashboard', jar2, true);
    const doc2 = domReduced.window.document;
    const goldEl2 = () => doc2.querySelector('#hud-gold');
    check('Reduced-motion: emas awal 50', (goldEl2()?.textContent || '') === '50', goldEl2()?.textContent);
    doc2.querySelector('#btn-crate').click();
    await waitFor(() => (goldEl2()?.textContent || '') === '55');
    check('Reduced-motion: emas tetap berubah ke 55',
      (goldEl2()?.textContent || '') === '55', goldEl2()?.textContent);
    await sleep(400);
    check('Reduced-motion: TIDAK ada chip selisih', !doc2.querySelector('.gold-delta'));
    check('Reduced-motion: TIDAK ada class gold-bump',
      doc2.querySelector('.hud-pill-gold')?.classList.contains('gold-bump') === false);
  } finally {
    if (dom) dom.window.close();
    if (domReduced) domReduced.window.close();
    stop();
  }
  console.log(`\n[gold-delta-dom] ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
