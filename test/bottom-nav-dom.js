// Parlementer — tes DOM bottom navigation di HP.
// Membuktikan (di jsdom + server sungguhan):
//   (1) SARAN PEMAIN ricky.s888 via Threads (27 Nov 2026): menu utama ada
//       di BAWAH layar HP ala Rival Regions — bar ter-render dengan 5 tab
//       utama (Dashboard, Pekerjaan, Pasar, Obrolan, Profil) + tombol Menu;
//   (2) tiap tab mengarah ke route yang benar (klik tab → hash berubah +
//       halaman termuat);
//   (3) tab aktif mengikuti route saat ini (cermin penanda aktif drawer);
//   (4) tombol Menu membuka drawer kiri yang sudah ada;
//   (5) bar SEMBUNYI di desktop: CSS default display:none, baru tampil
//       (display:flex) di dalam @media (max-width: 899px) — breakpoint
//       yang sama dengan .drawer yang jadi sidebar permanen di >=900px;
//   (6) bar tidak menutupi konten: di lebar mobile .page punya padding
//       bawah ekstra + .energy-bar naik di atas bar;
//   (7) aksesibilitas: <nav aria-label="Navigasi utama"> + tiap tab punya
//       aria-label yang jelas;
//   (8) VERSI: /api/world melaporkan 5.0.1.
// Jalankan: node test/bottom-nav-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3467;
const DB_PATH = '/tmp/parlementer-bottom-nav-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;
const EXPECTED_VERSION = '5.7.4';

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
const activeTab = (dom) => dom.window.document.querySelector('#bottom-nav .bottom-nav-item.active')?.dataset.route || null;

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[bottom-nav-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'bottom-nav-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  try {
    await sleep(1200);

    // (8) Versi dulu (tanpa login).
    const world = await (await fetch(BASE + '/api/world')).json();
    check('API /api/world: versi 5.7.4', world.version === EXPECTED_VERSION, `version=${world.version}`);

    const jar = makeJar();
    const r = await api(jar, '/api/auth/register', { email: 'domNav@test.local', password: 'rahasia123', username: 'warga_nav' });
    check('Daftar warga_nav (API)', r.status === 200 && r.data.ok);

    // (5)+(6)+(7) CSS statis: bar sembunyi di desktop, tampil di mobile,
    // konten tidak tertutup, mode banned menyembunyikan bar.
    const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
    check('CSS: .bottom-nav default display:none (sembunyi di desktop)',
      /\.bottom-nav\s*\{\s*display:\s*none;/.test(css));
    const mobileBlock = css.match(/@media\s*\(max-width:\s*899px\)\s*\{([\s\S]*?)\n\}/);
    check('CSS: ada blok @media (max-width: 899px) — breakpoint yang sama dengan .drawer',
      !!mobileBlock);
    check('CSS: di lebar mobile .bottom-nav display:flex',
      !!mobileBlock && /\.bottom-nav\s*\{[^}]*display:\s*flex/.test(mobileBlock[1]), mobileBlock ? 'blok mobile ditemukan' : 'blok mobile tidak ditemukan');
    check('CSS: di lebar mobile .page padding-bottom 240px (konten tidak tertutup bar)',
      !!mobileBlock && /\.page\s*\{[^}]*padding-bottom:\s*240px/.test(mobileBlock[1]));
    check('CSS: di lebar mobile .energy-bar naik di atas bar bawah',
      !!mobileBlock && /\.energy-bar\s*\{[^}]*bottom:\s*calc\(64px/.test(mobileBlock[1]));
    check('CSS: mode banned menyembunyikan .bottom-nav',
      /#app\.banned\s+\.bottom-nav/.test(css));

    // --- DOM: boot di dashboard ---
    dom = await bootDom(BASE + '/#/dashboard', jar);
    const { document } = dom.window;

    // (7) Aksesibilitas.
    const nav = document.querySelector('#bottom-nav');
    check('Bar ter-render sebagai <nav id="bottom-nav">', !!nav && nav.tagName === 'NAV');
    check('Bar memakai aria-label="Navigasi utama"', nav?.getAttribute('aria-label') === 'Navigasi utama');

    // (1) 5 tab + tombol Menu.
    const tabs = [...document.querySelectorAll('#bottom-nav .bottom-nav-item')];
    check('Bar berisi 6 tombol (5 tab + Menu)', tabs.length === 6, `tombol=${tabs.length}`);
    const routes = tabs.map((b) => b.dataset.route || 'menu');
    check('Tab berurutan: dashboard, jobs, market, chat, profile, Menu',
      routes.join(',') === 'dashboard,jobs,market,chat,profile,menu', `urutan=${routes.join(',')}`);
    const labels = tabs.map((b) => (b.getAttribute('aria-label') || '').trim());
    check('Tiap tab punya aria-label yang jelas',
      labels.join(',') === 'Dashboard,Pekerjaan,Pasar,Obrolan,Profil,Menu', `label=${labels.join(',')}`);
    check('Tiap tab punya ikon + label singkat',
      tabs.every((b) => b.querySelector('.bn-ico') && b.querySelector('.bn-label')?.textContent.trim().length > 0));

    // (3) Tab aktif mengikuti route awal (#/dashboard).
    check('Route #/dashboard: tab Dashboard aktif', activeTab(dom) === 'dashboard', `aktif=${activeTab(dom)}`);

    // (2) Klik tab Pekerjaan → pindah route + tab aktif ikut.
    document.querySelector('#bottom-nav .bottom-nav-item[data-route="jobs"]')?.click();
    await sleep(1500);
    check('Klik tab Pekerjaan: hash jadi #/jobs', dom.window.location.hash === '#/jobs', `hash=${dom.window.location.hash}`);
    check('Klik tab Pekerjaan: tab Pekerjaan jadi aktif', activeTab(dom) === 'jobs', `aktif=${activeTab(dom)}`);
    check('Klik tab Pekerjaan: halaman Pekerjaan termuat', pageText(dom).includes('KANTOR KETENAGAKERJAAN'));

    // (2) Klik tab Pasar → pindah route + tab aktif ikut.
    document.querySelector('#bottom-nav .bottom-nav-item[data-route="market"]')?.click();
    await sleep(1500);
    check('Klik tab Pasar: hash jadi #/market', dom.window.location.hash === '#/market', `hash=${dom.window.location.hash}`);
    check('Klik tab Pasar: tab Pasar jadi aktif', activeTab(dom) === 'market', `aktif=${activeTab(dom)}`);

    // (2) Klik tab Obrolan → pindah route + tab aktif ikut.
    document.querySelector('#bottom-nav .bottom-nav-item[data-route="chat"]')?.click();
    await sleep(1500);
    check('Klik tab Obrolan: hash jadi #/chat', dom.window.location.hash === '#/chat', `hash=${dom.window.location.hash}`);
    check('Klik tab Obrolan: tab Obrolan jadi aktif', activeTab(dom) === 'chat', `aktif=${activeTab(dom)}`);

    // (2) Klik tab Profil → pindah route + tab aktif ikut.
    document.querySelector('#bottom-nav .bottom-nav-item[data-route="profile"]')?.click();
    await sleep(1500);
    check('Klik tab Profil: hash jadi #/profile', dom.window.location.hash === '#/profile', `hash=${dom.window.location.hash}`);
    check('Klik tab Profil: tab Profil jadi aktif', activeTab(dom) === 'profile', `aktif=${activeTab(dom)}`);

    // (4) Tombol Menu membuka drawer kiri yang sudah ada.
    check('Drawer tertutup sebelum klik Menu', !document.querySelector('#drawer')?.classList.contains('open'));
    document.querySelector('#bottom-nav-menu')?.click();
    await sleep(300);
    check('Klik tombol Menu: drawer terbuka (class open)', !!document.querySelector('#drawer')?.classList.contains('open'));
    check('Klik tombol Menu: overlay drawer ikut terbuka', !!document.querySelector('#drawer-overlay')?.classList.contains('open'));
    check('Klik tombol Menu: drawer tetap berisi menu lama', !!document.querySelector('#drawer-nav .nav-item[data-route="dashboard"]'));

    // Route di luar 5 tab utama (mis. Peta) → tidak ada tab bawah yang aktif.
    document.querySelector('#drawer-close')?.click();
    await sleep(300);
    dom.window.location.hash = '#/map';
    await sleep(1500);
    check('Route #/map: tidak ada tab bawah yang aktif', activeTab(dom) === null, `aktif=${activeTab(dom)}`);
  } finally {
    if (dom) dom.window.close();
    stop();
  }
  console.log(`\n[bottom-nav-dom] ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
