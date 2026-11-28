// Parlementer — tes DOM tempo gerak bersama + micro-interactions (v5.7.3).
// Membuktikan, dari file yang benar-benar disajikan server:
//   (1) Token tempo gerak terdefinisi di :root (tap 100ms, pop 150ms,
//       hover 200ms, card 300ms, ease-out cubic-bezier(0.22,1,0.36,1))
//       — referensi: motion-and-hover-polish (awesomeskills.dev, MIT);
//   (2) Animasi lama (pageIn/popIn/toastIn, transisi tombol) memakai
//       token, bukan angka acak per komponen;
//   (3) Kartu (.card/.offer-card) terangkat tipis saat hover di desktop
//       (translateY(-2px)) — kartu .selected tidak ikut terangkat;
//   (4) Isi bar (.bar > i) dan segmen energi (.energy-segs i) berubah
//       dengan transisi halus, bukan meloncat;
//   (5) Layar login punya latar hidup: lapisan cahaya ::before dengan
//       animasi authDrift 14s;
//   (6) prefers-reduced-motion mematikan SEMUA animasi/transisi baru.
// Catatan jujur: jsdom tidak menjalankan animasi sungguhan, jadi "gerak
// halus" dibuktikan lewat nilai CSS-nya (token, durasi, keyframes,
// aturan reduced-motion). Periksa visual akhir tetap di HP pemilik.
// Jalankan: node test/motion-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3476;
const DB_PATH = '/tmp/parlementer-motion-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;
const EXPECTED_VERSION = '5.7.3';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[motion-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'motion-dom-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { const r = await fetch(BASE + '/'); up = r.status === 200; } catch { await sleep(250); }
    }
    check('server menyala dan halaman utama 200', up);
    if (!up) { console.log('[motion-dom] server tidak menyala'); process.exitCode = 1; return; }

    const world = await (await fetch(BASE + '/api/world')).json();
    check('API /api/world: versi 5.7.3', world.version === EXPECTED_VERSION, `version=${world.version}`);

    const cssRes = await fetch(BASE + '/css/style.css');
    const css = await cssRes.text();
    check('CSS utama disajikan (200)', cssRes.status === 200 && css.length > 10000, `bytes=${css.length}`);

    // --- (1) Token tempo gerak di :root ---
    check('token --motion-tap: 100ms', css.includes('--motion-tap: 100ms;'));
    check('token --motion-pop: 150ms', css.includes('--motion-pop: 150ms;'));
    check('token --motion-hover: 200ms', css.includes('--motion-hover: 200ms;'));
    check('token --motion-card: 300ms', css.includes('--motion-card: 300ms;'));
    check('token --motion-ease-out: cubic-bezier(0.22, 1, 0.36, 1)',
      css.includes('--motion-ease-out: cubic-bezier(0.22, 1, 0.36, 1);'));

    // --- (2) Animasi lama memakai token ---
    check('pageIn memakai token hover (200ms)', css.includes('.page > * { animation: pageIn var(--motion-hover) ease; }'));
    check('popIn modal memakai token pop + ease-out',
      css.includes('.modal-card { animation: popIn var(--motion-pop) var(--motion-ease-out); }'));
    check('popIn popover memakai token pop + ease-out',
      /\.popover-card\s*\{[^}]*animation:\s*popIn var\(--motion-pop\) var\(--motion-ease-out\)/.test(css));
    check('toast memakai token hover', css.includes('.toast { animation: toastIn var(--motion-hover) ease; }'));
    check('transisi tombol memakai token tap/pop',
      css.includes('transition: transform var(--motion-tap) ease, background-color var(--motion-pop) ease, border-color var(--motion-pop) ease, box-shadow var(--motion-pop) ease;'));
    check('umpan balik tekan tombol tetap ada (scale .96 saat :active)',
      css.includes(':active { transform: scale(.96); }'));

    // --- (3) Kartu terangkat saat hover (desktop) ---
    check('kartu punya transisi transform/border/shadow (token card)',
      /\.card,\s*\.offer-card\s*\{[^}]*transition:\s*transform var\(--motion-card\) var\(--motion-ease-out\)/.test(css));
    check('hover kartu: terangkat -2px + border emas redup + bayangan',
      css.includes('.card:not(.selected):hover, .offer-card:hover { transform: translateY(-2px); border-color: var(--gold-dim); box-shadow: 0 8px 24px rgba(0,0,0,.35); }'));
    check('kartu .selected tidak ikut terangkat saat hover',
      css.includes('.card:not(.selected):hover'));

    // --- (4) Bar & segmen energi berubah halus ---
    check('isi bar (.bar > i) bertransisi lebar (token card + ease-out)',
      /\.bar > i\s*\{[^}]*transition:\s*width var\(--motion-card\) var\(--motion-ease-out\)/.test(css));
    check('segmen energi bertransisi warna (token hover)',
      /\.energy-segs i\s*\{[^}]*transition:\s*background-color var\(--motion-hover\) ease/.test(css));

    // --- (5) Latar hidup layar login ---
    check('auth-view berlapis ::before (cahaya emas samar)',
      /\.auth-view::before\s*\{[^}]*background:\s*radial-gradient\(520px 260px at 30% 0%, rgba\(217,164,65,\.14\)/.test(css));
    check('lapisan cahaya bergerak (animasi authDrift 14s alternate)',
      /\.auth-view::before\s*\{[^}]*animation:\s*authDrift 14s ease-in-out infinite alternate/.test(css));
    check('keyframes authDrift ada (geser -4% ke +4%)',
      /@keyframes authDrift\s*\{\s*from\s*\{\s*transform:\s*translateX\(-4%\);\s*\}\s*to\s*\{\s*transform:\s*translateX\(4%\);\s*\}\s*\}/.test(css));
    check('konten login tetap di atas lapisan cahaya (z-index 1)',
      css.includes('.auth-view > * { position: relative; z-index: 1; }'));

    // --- (6) Reduced motion mematikan semua yang baru ---
    const rm = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g) || [];
    const rmAll = rm.join('\n');
    check('reduced-motion: authDrift dimatikan', rmAll.includes('.auth-view::before { animation: none; }'));
    check('reduced-motion: transisi kartu/bar/segmen dimatikan',
      rmAll.includes('.card, .offer-card, .bar > i, .energy-segs i { transition: none; }'));
    check('reduced-motion: animasi lama tetap dimatikan (page/modal/toast)',
      rmAll.includes('.page > *, .modal-card, .toast'));
  } finally {
    stop();
  }

  console.log(`[motion-dom] ${passed} lolos, ${failed} gagal`);
  if (failed) process.exitCode = 1;
}

main();
