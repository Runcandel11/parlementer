// Parlementer — tes DOM background kontekstual (v5.7.5).
// Membuktikan (di jsdom + server sungguhan):
//   (1) Setiap route di ROUTES punya entri di PAGE_BG (di-parse dari
//       sumber app.js) dan setiap nilai PAGE_BG adalah file yang ada di
//       public/img/backgrounds/ (JPEG, >10 KB).
//   (2) Lapisan #page-bg ada di DOM; tiap pindah halaman, backgroundImage-nya
//       berganti sesuai konteks (war → war.jpg, market → market.jpg,
//       map → map.jpg, chat → night.jpg, parliament → parliament.jpg,
//       dashboard → city.jpg); route tak dikenal jatuh ke city.jpg.
//   (3) Banner .page-hero tampil di atas halaman (gambar yang sama dengan
//       latar) dengan judul h2 di dalamnya.
//   (4) CSS #page-bg full-bleed fixed (position: fixed; inset: 0;
//       background-size: cover) + overlay gelap (::after) — perbaikan
//       halaman Perang dari screenshot pemilik (dulu pita-pita + area hitam).
//   (5) Semua 12 gambar latar bisa diambil server (200 + image/jpeg) dan
//       SOURCES.md mencatat semuanya.
// Jalankan: node test/backgrounds-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pkg from 'jsdom';
import { DatabaseSync } from 'node:sqlite';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3476;
const DB_PATH = '/tmp/parlementer-backgrounds-dom.db';
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
  // --- (1) Cek statis dari sumber: ROUTES vs PAGE_BG vs file gambar ---
  const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const routeSlugs = new Set([
    ...[...appSrc.matchAll(/ROUTES\.([a-z][a-z0-9-]*)\s*=/g)].map((m) => m[1]),
    ...[...appSrc.matchAll(/ROUTES\['([^']+)'\]\s*=/g)].map((m) => m[1]),
  ]);
  const bgBlock = (appSrc.match(/const PAGE_BG = \{([\s\S]*?)\};/) || [])[1] || '';
  const bgMap = new Map([...bgBlock.matchAll(/(?:'([^']+)'|([A-Za-z][A-Za-z0-9-]*))\s*:\s*'([^']+)'/g)].map((m) => [m[1] || m[2], m[3]]));
  check('Statis: ROUTES ditemukan di app.js', routeSlugs.size >= 36, `n=${routeSlugs.size}`);
  const missing = [...routeSlugs].filter((s) => !bgMap.has(s) && !bgMap.has(s.split('/')[0]));
  check('Statis: semua route punya entri PAGE_BG', missing.length === 0, missing.join(',') || `${routeSlugs.size} route terpetakan`);
  const bgDir = path.join(ROOT, 'public/img/backgrounds');
  const files = [...new Set(bgMap.values())].sort();
  check('Statis: 12 gambar latar berbeda di PAGE_BG', files.length === 12, files.join(','));
  for (const f of files) {
    const p = path.join(bgDir, f + '.jpg');
    const ok = fs.existsSync(p) && fs.statSync(p).size > 10 * 1024;
    check(`Statis: file ${f}.jpg ada (>10 KB)`, ok, ok ? `${Math.round(fs.statSync(p).size / 1024)} KB` : 'hilang/kecil');
  }
  const sources = fs.readFileSync(path.join(bgDir, 'SOURCES.md'), 'utf8');
  check('Statis: SOURCES.md mencatat semua gambar', files.every((f) => sources.includes(f + '.jpg')));
  const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
  check('Statis: CSS #page-bg fixed full-bleed', /#page-bg\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/.test(css));
  check('Statis: CSS #page-bg background-size cover', /#page-bg\s*\{[^}]*background-size:\s*cover;/.test(css));
  check('Statis: CSS #page-bg punya overlay gelap (::after)', /#page-bg::after\s*\{[^}]*linear-gradient\(180deg,\s*rgba\(7,11,20/.test(css));
  check('Statis: CSS .page-hero ada', /\.page-hero\s*\{[^}]*background-size:\s*cover;/.test(css));
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  check('Statis: index.html punya <div id="page-bg">', indexHtml.includes('<div id="page-bg"'));

  // --- Server + DOM ---
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }
  console.log('[backgrounds-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'backgrounds-dom-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  try {
    await sleep(1200);
    const jarA = makeJar();
    let r = await api(jarA, '/api/auth/register', { email: 'domBg@test.local', password: 'rahasia123', username: 'warga_bg' });
    check('Daftar pemain (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    r = await api(jarA, '/api/world');
    check('API /api/world: versi 5.7.5', r.data.version === EXPECTED_VERSION, `version=${r.data.version}`);

    // --- (5) Semua gambar bisa diambil server ---
    for (const f of files) {
      const res = await fetch(`${BASE}/img/backgrounds/${f}.jpg`);
      check(`Server: /img/backgrounds/${f}.jpg 200 + image/jpeg`, res.status === 200 && (res.headers.get('content-type') || '').startsWith('image/'), `status=${res.status}`);
    }

    // --- (2)(3) Navigasi antar halaman ganti latar + hero ---
    dom = await bootDom(BASE + '/#/dashboard', jarA);
    const { window } = dom;
    const { document } = window;
    const bgEl = document.querySelector('#page-bg');
    check('#page-bg ada di DOM', !!bgEl);
    const bgOf = () => (bgEl?.style?.backgroundImage || '');
    const heroOf = () => (document.querySelector('.page-hero')?.style?.backgroundImage || '');
    check('Dashboard: latar city.jpg', bgOf().includes('city.jpg'), bgOf());
    check('Dashboard: hero city.jpg + judul h2', heroOf().includes('city.jpg') && !!document.querySelector('.page-hero h2'));

    const go = async (hash) => {
      window.location.hash = hash;
      await sleep(1600);
    };
    await go('#/war');
    check('Perang: latar war.jpg (full-bleed, bukan pita)', bgOf().includes('war.jpg'), bgOf());
    check('Perang: hero war.jpg', heroOf().includes('war.jpg'));
    await go('#/market');
    check('Pasar: latar market.jpg', bgOf().includes('market.jpg'), bgOf());
    check('Pasar: hero market.jpg', heroOf().includes('market.jpg'));
    await go('#/map');
    check('Peta: latar map.jpg', bgOf().includes('map.jpg'), bgOf());
    await go('#/chat');
    check('Chat: latar night.jpg', bgOf().includes('night.jpg'), bgOf());
    await go('#/parliament');
    check('Parlemen: latar parliament.jpg', bgOf().includes('parliament.jpg'), bgOf());
    await go('#/jobs');
    check('Pekerjaan: latar factory.jpg', bgOf().includes('factory.jpg'), bgOf());
    await go('#/press');
    check('Pers: latar press.jpg', bgOf().includes('press.jpg'), bgOf());
    await go('#/shop');
    check('Toko: latar shop.jpg', bgOf().includes('shop.jpg'), bgOf());
    await go('#/book');
    check('Panduan: latar book.jpg', bgOf().includes('book.jpg'), bgOf());
    await go('#/profile');
    check('Profil: latar profile.jpg', bgOf().includes('profile.jpg'), bgOf());
    await go('#/convoy');
    check('Konvoi: latar convoy.jpg', bgOf().includes('convoy.jpg'), bgOf());
    await go('#/tidakada');
    check('Route tak dikenal: fallback city.jpg', bgOf().includes('city.jpg'), bgOf());
    await go('#/war-world');
    check('Dunia Perang: latar war.jpg (sub-route)', bgOf().includes('war.jpg'), bgOf());
  } finally {
    if (dom) dom.window.close();
    stop();
  }

  console.log(`\n[backgrounds-dom] ${passed} lolos, ${failed} gagal.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
