// Parlementer — tes DOM animasi perolehan emas di HUD (v5.7.5).
// Membuktikan (di jsdom + server sungguhan):
//   (1) CSS: pil emas .hud-pill-gold position relative; keyframes goldPop
//       + goldFloat ada; chip .gold-float terikat animasi goldFloat;
//       prefers-reduced-motion mematikan animasi + menyembunyikan chip.
//   (2) app.js: floatGoldGain + pelacak __prevGold ada; renderHUD
//       memanggilnya hanya saat emas naik.
//   (3) Live: klaim pasokan harian (+5 emas, DAILY_CLAIM.gold) → chip
//       "+5" muncul di dalam pil emas + pil berdenyut (kelas
//       hud-gold-pop) + angka #hud-gold bertambah; chip hilang sendiri
//       setelah ~1,1 dtk dan kelas pop dilepas; klaim kedua di hari yang
//       sama ditolak (tombol peti disabled) tanpa chip baru.
// Jalankan: flock /tmp/parl-test.lock node test/gold-float-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pkg from 'jsdom';
import { DatabaseSync } from 'node:sqlite';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3477;
const DB_PATH = '/tmp/parlementer-gold-float-dom.db';
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
  // --- (1)(2) Cek statis dari sumber ---
  const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
  check('Statis: CSS .hud-pill-gold position relative', /\.hud-pill-gold\s*\{[^}]*position:\s*relative;/.test(css));
  check('Statis: CSS @keyframes goldPop ada', /@keyframes goldPop\s*\{[\s\S]*?transform:\s*scale\(1\.12\)/.test(css));
  check('Statis: CSS @keyframes goldFloat ada', /@keyframes goldFloat\s*\{[\s\S]*?translate\(-50%,\s*-26px\)/.test(css));
  check('Statis: CSS .gold-float pakai animasi goldFloat', /\.gold-float\s*\{[^}]*animation:\s*goldFloat 1\.1s ease-out forwards;/.test(css));
  check('Statis: CSS .gold-float pointer-events none', /\.gold-float\s*\{[^}]*pointer-events:\s*none;/.test(css));
  check('Statis: CSS reduced-motion mematikan goldFloat + goldPop', /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.hud-pill-gold\.hud-gold-pop,\s*\.gold-float\s*\{\s*animation:\s*none;/.test(css));
  check('Statis: CSS reduced-motion menyembunyikan chip', /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.gold-float\s*\{\s*display:\s*none;/.test(css));
  const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  check('Statis: app.js punya floatGoldGain', /function floatGoldGain\(delta\)/.test(appSrc));
  check('Statis: app.js punya pelacak __prevGold', /let __prevGold = null;/.test(appSrc));
  check('Statis: renderHUD memanggil floatGoldGain saat emas naik', /if \(__prevGold !== null && c\.gold > __prevGold\) floatGoldGain\(c\.gold - __prevGold\);/.test(appSrc));
  check('Statis: floatGoldGain hanya untuk delta > 0', /if \(!pill \|\| !\(delta > 0\)\) return;/.test(appSrc));
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  check('Statis: index.html pil emas berisi #hud-gold', indexHtml.includes('<span class="hud-pill hud-pill-gold">') && indexHtml.includes('id="hud-gold"'));

  // --- Server + DOM ---
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }
  console.log('[gold-float-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'gold-float-dom-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  try {
    await sleep(1200);
    const jarA = makeJar();
    let r = await api(jarA, '/api/auth/register', { email: 'domGold@test.local', password: 'rahasia123', username: 'warga_emas' });
    check('Daftar pemain (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    r = await api(jarA, '/api/world');
    check('API /api/world: versi 5.7.5', r.data.version === EXPECTED_VERSION, `version=${r.data.version}`);
    r = await (await jarA('/api/me')).json();
    const goldBefore = r?.citizen?.gold;
    check('API /api/me: emas awal berupa angka', typeof goldBefore === 'number', `gold=${goldBefore}`);

    // --- (3) Klaim pasokan harian dari dalam DOM ---
    dom = await bootDom(BASE + '/#/dashboard', jarA);
    const { window } = dom;
    const { document } = window;
    const pill = document.querySelector('.hud-pill-gold');
    check('HUD: pil emas ada di DOM', !!pill);
    const goldEl = document.querySelector('#hud-gold');
    check('HUD: angka emas awal tampil', !!goldEl && goldEl.textContent.trim() !== '', goldEl?.textContent);
    check('HUD: belum ada chip +N sebelum klaim', !document.querySelector('.gold-float'));
    const crate = document.querySelector('#btn-crate');
    check('HUD: tombol peti pasokan ada + bisa diklaim', !!crate && !crate.disabled);
    crate.click();
    // Chip hanya hidup 1,1 dtk: pantau cepat (tiap 100 ms, maks 3 dtk)
    // sampai ia muncul, lalu tangkap teks + kelas pop saat itu juga.
    let chipText = '';
    let popSeen = false;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      const chipNow = document.querySelector('.gold-float');
      if (chipNow) {
        chipText = chipNow.textContent;
        popSeen = pill.classList.contains('hud-gold-pop');
        break;
      }
    }
    check('Klaim: chip +N muncul di pil emas', chipText !== '', chipText || 'tidak ada chip');
    // DAILY_CLAIM.gold = 5; warga baru tanpa negara = tanpa bonus ideologi/anggaran.
    check('Klaim: chip bertuliskan +5', chipText === '+5', chipText || '');
    check('Klaim: pil emas berdenyut (kelas hud-gold-pop)', popSeen);
    await sleep(600); // beri waktu refreshMe + route selesai sebelum cek angka
    r = await (await jarA('/api/me')).json();
    const goldAfter = r?.citizen?.gold;
    check('Klaim: emas naik 5 di server', goldAfter === goldBefore + 5, `${goldBefore} → ${goldAfter}`);
    check('Klaim: angka HUD ikut naik', goldEl.textContent.replace(/\D/g, '') === String(goldAfter), goldEl.textContent);
    await sleep(1400); // chip 1,1 dtk + kelas pop 0,5 dtk harus sudah dilepas
    check('Bersih-bersih: chip hilang sendiri', !document.querySelector('.gold-float'));
    check('Bersih-bersih: kelas pop dilepas', !pill.classList.contains('hud-gold-pop'));
    // Klaim kedua di hari yang sama: tombol peti disabled, tanpa chip baru.
    check('Klaim ke-2: tombol peti disabled (sudah klaim hari ini)', document.querySelector('#btn-crate')?.disabled === true);
    document.querySelector('#btn-crate')?.click();
    await sleep(800);
    check('Klaim ke-2: tidak ada chip baru', !document.querySelector('.gold-float'));
  } finally {
    if (dom) dom.window.close();
    stop();
  }

  console.log(`\n[gold-float-dom] ${passed} lolos, ${failed} gagal.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
