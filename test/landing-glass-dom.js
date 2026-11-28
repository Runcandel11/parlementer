// Parlementer — tes DOM landing page + UI kaca (jsdom + server sungguhan).
// Membuktikan:
//   (1) LANDING: pengunjung belum login melihat hero (badge, headline,
//       tombol emas AMBIL KEWARGANEGARAAN + MASUK, 3 badge bawah) — tanpa
//       klaim "beta"; CTA membuka form yang benar; tombol kembali ke beranda;
//   (2) Daftar dari form landing berfungsi; pemain login langsung ke
//       dashboard (landing tidak menghadang);
//   (3) ?ref= tetap membuka tab DAFTAR dengan kode terisi;
//   (4) PETA LANGSUNG: wilayah tanpa negara = kaca abu-abu (kelas free) +
//       tanda "?" (17 ubin, semua belum bernegara di DB segar);
//   (5) UI KACA: CSS memakai backdrop-filter; ikon atas diperkecil (32px);
//   (6) VERSI: footer landing + drawer menampilkan "Parlementer v4.5.1"
//       dari konstanta VERSION (API /api/world + /api/me).
// Jalankan: node test/landing-glass-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
import { DatabaseSync } from 'node:sqlite';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3462;
const DB_PATH = '/tmp/parlementer-landing-glass-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;
const EXPECTED_VERSION = '4.5.1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// Cookie jar: node fetch tidak menyimpan cookie sendiri — simpan set-cookie
// dari register dan kirim lagi, supaya boot() di jsdom login.
let cookie = '';
async function jarFetch(url, opts = {}) {
  const full = typeof url === 'string' && url.startsWith('/') ? BASE + url : url;
  const res = await fetch(full, {
    ...opts,
    headers: { ...(opts.headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return res;
}

async function bootDom(url) {
  const html = await (await fetch(BASE + '/')).text();
  const htmlNoFonts = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>\s*/g, '')
    .replace(/<link[^>]*fonts\.gstatic\.com[^>]*>\s*/g, '');
  const dom = new JSDOM(htmlNoFonts, {
    url,
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) { window.fetch = jarFetch; },
  });
  const { window } = dom;
  await new Promise((resolve) => {
    if (window.document.readyState === 'complete') resolve();
    else window.addEventListener('load', resolve);
    setTimeout(resolve, 5000);
  });
  await sleep(1500);
  return dom;
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[landing-glass-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'landing-glass-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  let domRef = null;

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { const r = await fetch(BASE + '/'); up = r.status === 200; } catch { await sleep(250); }
    }
    check('server menyala dan halaman utama 200', up);
    if (!up) { console.log('[landing-glass-dom] server tidak menyala'); process.exitCode = 1; return; }

    // --- HTML statis + API versi ---
    const html = await (await fetch(BASE + '/')).text();
    check('landing: hero ada di HTML (id landing-hero)', html.includes('id="landing-hero"'));
    check('landing: tombol emas AMBIL KEWARGANEGARAAN ada', html.includes('AMBIL KEWARGANEGARAAN'));
    check('landing: headline DUNIA INI DIBENTUK ULANG OLEH PARA PEMAINNYA', html.includes('DUNIA INI') && html.includes('PARA PEMAINNYA'));
    check('landing: 3 badge bawah ada', html.includes('GRATIS DIMAINKAN') && html.includes('DIMAINKAN DI BROWSER') && html.includes('SEMUA BISA DIDAPAT DENGAN BERMAIN'));
    check('landing: badge 100% PEMAIN ASLI (tanpa klaim beta)', html.includes('100% PEMAIN ASLI') && !html.toUpperCase().includes('BETA'));
    const world = await (await fetch(BASE + '/api/world')).json();
    check('API /api/world: versi 4.5.1 (publik, tanpa login)', world.version === EXPECTED_VERSION, `version=${world.version}`);

    // --- Kredit pembuat + SEO JSON-LD (28 Nov 2026) ---
    const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    let ld = null;
    try { ld = ldMatch ? JSON.parse(ldMatch[1]) : null; } catch { ld = null; }
    check('SEO: JSON-LD ada dan valid (parse JSON)', !!ld, ldMatch ? 'script ditemukan' : 'script tidak ditemukan');
    const creators = ld ? (Array.isArray(ld.creator) ? ld.creator : [ld.creator]) : [];
    const khalidLd = creators.find((p) => p && p['@type'] === 'Person' && p.name === 'Khalid Talal Muhammad Zain Al-Ghunaim');
    check('SEO: JSON-LD VideoGame Parlementer', !!ld && ld['@type'] === 'VideoGame' && ld.name === 'Parlementer', ld ? `${ld['@type']}/${ld.name}` : '');
    check('SEO: JSON-LD creator berisi Khalid (CEO & Pengembang)', !!khalidLd && khalidLd.jobTitle === 'CEO & Pengembang', khalidLd ? khalidLd.jobTitle : '');
    check('SEO: JSON-LD author = Khalid (CEO & Pengembang)', !!ld && ld.author?.name === 'Khalid Talal Muhammad Zain Al-Ghunaim' && ld.author?.jobTitle === 'CEO & Pengembang');
    check('SEO: JSON-LD creator berisi Angelica (co-creator)', creators.some((p) => p && p['@type'] === 'Person' && p.name === 'Angelica'));
    const angelicaLd = creators.find((p) => p && p['@type'] === 'Person' && p.name === 'Angelica');
    check('SEO: JSON-LD Angelica jobTitle Asisten Developer', !!angelicaLd && angelicaLd.jobTitle === 'Asisten Developer', angelicaLd ? angelicaLd.jobTitle : '');

    // --- Boot tamu (tanpa cookie): landing tampil, form tersembunyi ---
    dom = await bootDom(BASE + '/');
    const { window } = dom;
    const { document } = window;
    check('tamu: #auth-view tampil, #app tersembunyi', !document.querySelector('#auth-view').hidden && document.querySelector('#app').hidden === true);
    check('tamu: hero landing tampil', !document.querySelector('#landing-hero').hidden);
    check('tamu: kartu login/daftar tersembunyi di awal', document.querySelector('#auth-card-wrap').hidden === true);
    check('tamu: footer landing menampilkan Parlemen v4.5.1', (document.querySelector('#landing-version')?.textContent || '').includes('Parlementer v' + EXPECTED_VERSION), document.querySelector('#landing-version')?.textContent);
    const landingCredits = document.querySelector('#landing-credits')?.textContent || '';
    check('tamu: footer landing menampilkan kredit pembuat (Khalid + Angelica)', landingCredits.includes('Khalid Talal Muhammad Zain Al-Ghunaim') && landingCredits.includes('Angelica'), landingCredits);
    check('tamu: kredit landing menyebut Khalid CEO & Pengembang', landingCredits.includes('CEO & Pengembang'), landingCredits);
    check('tamu: kredit landing menyebut Angelica Asisten Developer', landingCredits.includes('Asisten Developer'), landingCredits);

    // CTA daftar → form DAFTAR; kembali → hero; CTA masuk → form MASUK.
    document.querySelector('#landing-register').click();
    await sleep(200);
    check('CTA daftar: kartu tampil + form DAFTAR tampil, form MASUK tersembunyi', !document.querySelector('#auth-card-wrap').hidden && !document.querySelector('#form-register').hidden && document.querySelector('#form-login').hidden === true);
    check('CTA daftar: hero tersembunyi saat form tampil', document.querySelector('#landing-hero').hidden === true);
    document.querySelector('#auth-back').click();
    await sleep(200);
    check('tombol kembali: hero tampil lagi, kartu tersembunyi', !document.querySelector('#landing-hero').hidden && document.querySelector('#auth-card-wrap').hidden === true);
    document.querySelector('#landing-login').click();
    await sleep(200);
    check('CTA masuk: form MASUK tampil, form DAFTAR tersembunyi', !document.querySelector('#form-login').hidden && document.querySelector('#form-register').hidden === true);

    // --- Daftar dari form landing (jsdom) → langsung ke dashboard ---
    document.querySelector('#landing-register').click();
    await sleep(200);
    const form = document.querySelector('#form-register');
    form.querySelector('input[name="email"]').value = 'landing@test.local';
    form.querySelector('input[name="password"]').value = 'rahasia123';
    form.querySelector('input[name="username"]').value = 'landing_tes';
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await sleep(2500);
    check('daftar dari landing: aplikasi tampil (#app), landing tidak menghadang', document.querySelector('#app').hidden === false && document.querySelector('#auth-view').hidden === true);
    check('login: footer drawer menampilkan Parlemen v4.5.1', (document.querySelector('#drawer-version')?.textContent || '').includes('Parlementer v' + EXPECTED_VERSION), document.querySelector('#drawer-version')?.textContent);
    const drawerCredits = document.querySelector('#drawer-credits')?.textContent || '';
    check('login: footer drawer menampilkan kredit pembuat (Khalid + Angelica)', drawerCredits.includes('Khalid Talal Muhammad Zain Al-Ghunaim') && drawerCredits.includes('Angelica'), drawerCredits);
    check('login: kredit drawer menyebut Khalid CEO & Pengembang', drawerCredits.includes('CEO & Pengembang'), drawerCredits);
    check('login: kredit drawer menyebut Angelica Asisten Developer', drawerCredits.includes('Asisten Developer'), drawerCredits);

    // --- PETA LANGSUNG: wilayah tanpa negara = kaca abu-abu + "?" ---
    const tiles = [...document.querySelectorAll('.map-tile')];
    check('dashboard: PETA LANGSUNG menampilkan 17 ubin wilayah', tiles.length === 17, `ubin=${tiles.length}`);
    const freeTiles = tiles.filter((t) => t.classList.contains('free'));
    check('peta: semua 17 ubin bertanda wilayah belum bernegara (kelas free)', freeTiles.length === 17, `free=${freeTiles.length}`);
    check('peta: semua ubin belum bernegara menampilkan tanda "?"', freeTiles.length === 17 && freeTiles.every((t) => t.textContent.includes('?')));
    const myTile = tiles.find((t) => t.classList.contains('mine'));
    check('peta: ubin wilayahku tetap bertanda KAMU (meski belum bernegara)', !!myTile && myTile.textContent.includes('KAMU'));

    // --- CSS: kaca + ikon kecil ---
    const css = fs.readFileSync(ROOT + 'public/css/style.css', 'utf8');
    check('CSS: panel memakai backdrop-filter (kaca)', css.includes('backdrop-filter: blur(12px)'));
    check('CSS: HUD memakai backdrop-filter (kaca)', /\.hud \{[^}]*backdrop-filter/.test(css));
    check('CSS: ikon atas diperkecil (32px)', /\.hud-icon \{[^}]*width: 32px/.test(css));
    check('CSS: ubin merdeka punya aturan kaca abu-abu (.map-tile.free)', css.includes('.map-tile.free') && css.includes('--glass-free'));
    check('CSS: gaya landing ada (.landing-hero + .landing-title)', css.includes('.landing-hero') && css.includes('.landing-title'));

    // --- ?ref= tetap membuka tab DAFTAR dengan kode terisi ---
    cookie = ''; // tamu baru
    domRef = await bootDom(BASE + '/?ref=ABCDEFGH');
    const docRef = domRef.window.document;
    check('?ref=: kartu tampil langsung (landing dilewati)', !docRef.querySelector('#auth-card-wrap').hidden && docRef.querySelector('#landing-hero').hidden === true);
    check('?ref=: tab DAFTAR aktif + kode terisi', !docRef.querySelector('#form-register').hidden && docRef.querySelector('#form-register input[name="ref"]').value === 'ABCDEFGH');
  } finally {
    stop();
    if (dom) dom.window.close();
    if (domRef) domRef.window.close();
  }

  console.log(`[landing-glass-dom] ${passed} lolos, ${failed} gagal`);
  if (failed) process.exitCode = 1;
}

main();
