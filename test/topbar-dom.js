// Parlementer — tes DOM top bar v4.5.1: tombol Nonton Iklan di top bar +
// dompet HUD jadi dua pill uang+emas yang sejajar.
// Membuktikan (di jsdom + server sungguhan):
//   (1) #btn-ads ada di .hud-actions, data-goto="#/ads", aria-label
//       "Nonton Iklan", berisi glyph 🎬 — terlihat & bisa diketuk;
//   (2) .hud-wallet berisi TEPAT 2 .hud-pill (uang + emas), bukan dua
//       baris teks menumpuk; pill pertama memuat #hud-usd, kedua
//       memuat #hud-gold; renderHUD tetap mengisi keduanya (Rupiah +
//       emas warga baru: Rp9.150.000 + 50);
//   (3) .hud-wallet tampil flex + pill punya border-radius 999px &
//       white-space:nowrap (tidak meluber/terlipat);
//   (4) CSS HP (≤560px): .hud-side jadi baris horizontal
//       (flex-direction:row) dan .hud-mid jadi baris kedua penuh
//       (display:flex, flex:1 1 100%) — dompet pill muat di layar 360px
//       tanpa tumpang tindih; ada blok ≤400px untuk layar 320px;
//   (5) Klik #btn-ads → pindah ke #/ads dan menampilkan "Segera hadir"
//       (AdinPlay belum aktif: property ID kosong — tidak ada iklan
//       palsu, perilaku sama seperti menu drawer).
// Catatan jujur: jsdom tidak menghitung layout sungguhan, jadi "muat di
// 360px" dibuktikan lewat nilai CSS-nya + hitungan lebar di komentar
// CSS; periksa visual akhir tetap di HP pemilik.
// Jalankan: node test/topbar-dom.js  (atau: npm run test:topbar)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3473;
const DB_PATH = '/tmp/parlementer-topbar-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;
const EXPECTED_VERSION = '4.5.1';

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

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[topbar-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'topbar-dom-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  try {
    await sleep(1200);

    const world = await (await fetch(BASE + '/api/world')).json();
    check('API /api/world: versi 4.5.1', world.version === EXPECTED_VERSION, `version=${world.version}`);

    // --- CSS disajikan + aturan top bar v4.5.1 ada di dalamnya.
    const cssRes = await fetch(BASE + '/css/style.css');
    const css = await cssRes.text();
    check('CSS utama disajikan (200)', cssRes.status === 200 && css.length > 10000, `bytes=${css.length}`);
    check('CSS: .hud-wallet tampil flex (dua pill sejajar)',
      /\.hud-wallet\s*\{[^}]*display:\s*flex/.test(css));
    check('CSS: .hud-pill berbentuk pill (border-radius 999px + nowrap)',
      /\.hud-pill\s*\{[^}]*border-radius:\s*999px[^}]*white-space:\s*nowrap/.test(css));
    check('CSS: desktop .hud-mid display:contents (ikut baris utama)',
      /\.hud-mid\s*\{\s*display:\s*contents/.test(css));
    check('CSS HP (≤560px): .hud-side jadi baris horizontal',
      css.includes('.hud-side { flex-direction: row; }'));
    check('CSS HP (≤560px): .hud-mid jadi baris kedua penuh',
      css.includes('.hud-mid { display: flex; order: 5; flex: 1 1 100%;'));
    check('CSS HP (≤560px): identitas flex 1 di dalam .hud-mid',
      css.includes('.hud-identity { order: 0; flex: 1 1 0; min-width: 0; }'));
    check('CSS: ada blok ≤400px (layar 320px tetap muat)',
      css.includes('@media (max-width: 400px)'));

    // --- Warga baru, boot dashboard.
    const jar = makeJar();
    const r = await api(jar, '/api/auth/register', { email: 'domTop@test.local', password: 'rahasia123', username: 'warga_top' });
    check('Daftar warga_top (API)', r.status === 200 && r.data.ok);
    dom = await bootDom(BASE + '/#/dashboard', jar);
    const doc = dom.window.document;
    const hud = doc.querySelector('header.hud');
    check('Header HUD ada', !!hud);

    // --- (1) Tombol Nonton Iklan di top bar.
    const btnAds = hud?.querySelector('#btn-ads');
    check('Top bar: tombol #btn-ads ada', !!btnAds);
    check('Top bar: #btn-ads di dalam .hud-actions',
      !!btnAds?.closest('.hud-actions'));
    check('Top bar: #btn-ads menuju #/ads', btnAds?.dataset.goto === '#/ads', `data-goto=${btnAds?.dataset.goto}`);
    check('Top bar: #btn-ads punya aria-label "Nonton Iklan"',
      btnAds?.getAttribute('aria-label') === 'Nonton Iklan', btnAds?.getAttribute('aria-label') || '');
    check('Top bar: #btn-ads berisi glyph 🎬',
      (btnAds?.textContent || '').includes('🎬'), btnAds?.textContent.trim());
    check('Top bar: #btn-ads memakai gaya .hud-icon (sejajar tombol lain)',
      btnAds?.classList.contains('hud-icon') === true);
    const actionsOrder = [...(hud?.querySelectorAll('.hud-actions .hud-icon') || [])].map((el) => el.id);
    check('Top bar: urutan aksi chat, lonceng, iklan, gear',
      actionsOrder.join(',') === 'btn-chat,btn-notif,btn-ads,btn-settings', `aksi=${actionsOrder.join(',')}`);

    // --- (2) Dompet = dua pill sejajar, berisi nilai asli.
    const wallet = hud?.querySelector('.hud-wallet');
    const pills = [...(wallet?.querySelectorAll('.hud-pill') || [])];
    check('Dompet: .hud-wallet ada', !!wallet);
    check('Dompet: TEPAT 2 pill (uang + emas), bukan tumpukan baris',
      pills.length === 2, `pill=${pills.length}`);
    check('Dompet: pill pertama memuat #hud-usd',
      !!pills[0]?.querySelector('#hud-usd'));
    check('Dompet: pill kedua memuat #hud-gold',
      !!pills[1]?.querySelector('#hud-gold'));
    check('Dompet: pill uang berisi Rupiah warga baru (Rp9.150.000)',
      (doc.querySelector('#hud-usd')?.textContent || '').includes('Rp9.150.000'),
      doc.querySelector('#hud-usd')?.textContent);
    check('Dompet: pill emas berisi 50',
      (doc.querySelector('#hud-gold')?.textContent || '') === '50',
      doc.querySelector('#hud-gold')?.textContent);
    check('Dompet: .hud-identity + .hud-wallet dibungkus .hud-mid',
      !!hud?.querySelector('.hud-mid > .hud-identity') && !!hud?.querySelector('.hud-mid > .hud-wallet'));

    // --- (3) Gaya terhitung: wallet flex, pill bulat + nowrap.
    const csWallet = dom.window.getComputedStyle(wallet);
    check('Dompet (gaya terhitung): display flex',
      csWallet.display === 'flex', `display=${csWallet.display}`);
    const csPill = dom.window.getComputedStyle(pills[0]);
    check('Pill (gaya terhitung): border-radius 999px',
      csPill.borderRadius === '999px', `border-radius=${csPill.borderRadius}`);
    check('Pill (gaya terhitung): white-space nowrap',
      csPill.whiteSpace === 'nowrap', `white-space=${csPill.whiteSpace}`);

    // --- (5) Klik #btn-ads → #/ads menampilkan "Segera hadir".
    btnAds.click();
    await sleep(900);
    check('Klik #btn-ads: hash pindah ke #/ads',
      dom.window.location.hash === '#/ads', `hash=${dom.window.location.hash}`);
    check('Halaman #/ads: menampilkan "Segera hadir" (AdinPlay belum aktif)',
      pageText(dom).includes('Segera hadir'), pageText(dom).slice(0, 200));
    check('Halaman #/ads: menyebut menunggu aktivasi admin',
      pageText(dom).includes('menunggu aktivasi'), pageText(dom).slice(0, 300));
  } finally {
    if (dom) dom.window.close();
    stop();
  }
  console.log(`\n[topbar-dom] ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
