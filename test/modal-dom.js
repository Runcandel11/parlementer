// Parlementer — tes DOM modal LAPORKAN KONTEN (jsdom + server sungguhan).
// Memastikan: (1) modal tertutup saat halaman pertama dimuat, (2) modal hanya
// terbuka lewat openReport (ikon laporkan pada pesan chat), (3) BATAL, Escape,
// dan klik backdrop semuanya menutup modal.
// Jalankan: node test/modal-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3457;
const DB_PATH = '/tmp/parlementer-modal.db';
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[modal-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'modal-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };

  try {
    // Tunggu server siap.
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { const r = await fetch(BASE + '/'); up = r.status === 200; } catch { await sleep(250); }
    }
    check('server menyala dan halaman utama 200', up);
    if (!up) { console.log('[modal-dom] server tidak menyala'); process.exitCode = 1; return; }

    // Ambil HTML sendiri dan buang link font Google (tidak perlu untuk tes,
    // dan lambat/tidak tersedia di VM) — CSS/JS lokal tetap dimuat dari server.
    const html = await (await fetch(BASE + '/')).text();
    const htmlNoFonts = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>\s*/g, '')
      .replace(/<link[^>]*fonts\.gstatic\.com[^>]*>\s*/g, '');
    const dom = new JSDOM(htmlNoFonts, {
      url: BASE + '/',
 // agar fetch relatif & script/style lokal dimuat dari server
      resources: 'usable',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window) { window.fetch = fetch; },
    });

    const { window } = dom;
    const { document } = window;
    // Beri waktu boot() (fetch /api/auth/me) selesai.
    await new Promise((resolve) => {
      if (document.readyState === 'complete') resolve();
      else window.addEventListener('load', resolve);
      setTimeout(resolve, 5000);
    });
    await sleep(500);

    const modal = document.querySelector('#report-modal');
    const display = () => window.getComputedStyle(modal).display;
    const authView = document.querySelector('#auth-view');
    const appView = document.querySelector('#app');

    // 1) Saat load awal: modal tertutup, form login terlihat.
    check('modal LAPORKAN KONTEN tertutup saat load awal', modal.hidden === true && display() === 'none', `hidden=${modal.hidden} display=${display()}`);
    check('form login terlihat saat load awal', authView.hidden === false && window.getComputedStyle(authView).display !== 'none');
    check('tampilan aplikasi tersembunyi saat belum login', appView.hidden === true && window.getComputedStyle(appView).display === 'none');

    // 2) Modal hanya terbuka lewat openReport (jalur ikon laporkan di pesan chat).
    window.openReport(123);
    check('modal terbuka lewat openReport', modal.hidden === false && display() === 'flex', `display=${display()}`);

    // 3a) Tombol BATAL menutup modal.
    document.querySelector('#report-cancel').click();
    check('tombol BATAL menutup modal', modal.hidden === true && display() === 'none');

    // 3b) Tombol Escape menutup modal.
    window.openReport(123);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('tombol Escape menutup modal', modal.hidden === true && display() === 'none');

    // 3c) Klik backdrop menutup modal.
    window.openReport(123);
    modal.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check('klik backdrop menutup modal', modal.hidden === true && display() === 'none');

    // 3d) Klik di dalam kartu modal TIDAK menutupnya.
    window.openReport(123);
    document.querySelector('.modal-card').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check('klik di dalam kartu tidak menutup modal', modal.hidden === false && display() === 'flex');
    document.querySelector('#report-cancel').click();

    // 4) Statis: satu-satunya pemanggil openReport adalah tombol laporkan di pesan chat.
    const js = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
    const callers = [...js.matchAll(/openReport\(/g)].length;
    const viaFlag = /data-report.*openReport|openReport\(Number\(b\.dataset\.report\)\)/.test(js);
    check('openReport hanya dipanggil dari tombol laporkan chat', callers === 2 && viaFlag, `${callers} kemunculan openReport(`);

    dom.window.close();
  } finally {
    stop();
  }

  console.log(`[modal-dom] ${passed} lolos, ${failed} gagal`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
