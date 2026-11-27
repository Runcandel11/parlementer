// Parlementer — tes DOM rapikan UI atas + ikon (v2.3.1).
// Membuktikan, dari file yang benar-benar disajikan server:
//   (1) HUD digeser sedikit ke kanan di HP (≤560px): padding kiri 16px
//       (sebelumnya 8px), supaya avatar + tombol menu tidak mepet atau
//       terpotong tepi layar; konten halaman ikut 14px dari tepi;
//   (2) Kolom kiri HUD seragam: avatar, tombol menu, peti pasokan sama
//       besar — 38px (36px di HP) — supaya kolomnya lurus, tidak bergerigi;
//   (3) SEMUA ikon di tengah dengan flex (bukan teks mentah yang duduk
//       miring): .hud-icon, .crate-btn, .drawer-close, .nav-item .ico,
//       .stat-head .lbl .ico — ukuran kotak ikon konsisten;
//   (4) Struktur HUD utuh di HTML: avatar + menu + peti + 3 tombol aksi
//       (chat, lonceng, gear) dengan urutan yang benar.
// Catatan jujur: jsdom tidak menghitung layout sungguhan (tidak ada
// getBoundingClientRect yang bermakna), jadi "tidak terpotong di 375–
// 430px" dibuktikan lewat nilai CSS-nya: padding kiri ≥ 12px, lebar
// kolom seragam, dan tombol aksi tetap 32px (tidak membesar sampai
// meluber). Periksa visual akhir tetap di HP pemilik.
// Jalankan: node test/ui-icons-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3466;
const DB_PATH = '/tmp/parlementer-ui-icons-dom.db';
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

  console.log('[ui-icons-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'ui-icons-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { const r = await fetch(BASE + '/'); up = r.status === 200; } catch { await sleep(250); }
    }
    check('server menyala dan halaman utama 200', up);
    if (!up) { console.log('[ui-icons-dom] server tidak menyala'); process.exitCode = 1; return; }

    const cssRes = await fetch(BASE + '/css/style.css');
    const css = await cssRes.text();
    check('CSS utama disajikan (200)', cssRes.status === 200 && css.length > 10000, `bytes=${css.length}`);

    // --- (1) HUD geser ke kanan di HP ---
    check('HUD HP: padding kiri 16px (geser kanan dari 8px)', css.includes('padding: 8px 12px 8px 16px;'));
    check('halaman HP: padding sisi 14px (sejajar HUD)', css.includes('padding: 12px 14px 180px;'));

    // --- (2) Kolom kiri HUD seragam ---
    check('kolom kiri seragam desktop: avatar/menu/peti 38px',
      css.includes('.hud-side .hud-icon, .hud-side .crate-btn { width: 38px; height: 38px;'));
    check('kolom kiri seragam HP: avatar/menu/peti 36px',
      css.includes('.hud-side .hud-icon, .hud-side .crate-btn { width: 36px; height: 36px;'));
    check('kolom kiri: item rata tengah (align-items center)',
      /\.hud-side\s*\{[^}]*align-items:\s*center/.test(css));

    // --- (3) Semua ikon di tengah dengan flex + kotak konsisten ---
    check('.hud-icon: glyph di tengah (inline-flex + center + line-height 1)',
      /\.hud-icon\s*\{[^}]*display:\s*inline-flex[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*line-height:\s*1/.test(css));
    check('.crate-btn: glyph di tengah + line-height 1',
      /\.crate-btn\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center[^}]*line-height:\s*1/.test(css));
    check('.drawer-close: glyph di tengah (flex + center)',
      /\.drawer-close\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center[^}]*justify-content:\s*center/.test(css));
    check('.nav-item .ico: kotak 26px + glyph di tengah (inline-flex)',
      /\.nav-item\s+\.ico\s*\{[^}]*width:\s*26px[^}]*height:\s*26px[^}]*display:\s*inline-flex/.test(css));
    check('.stat-head .lbl .ico: kotak 20px + glyph di tengah',
      /\.stat-head\s+\.lbl\s+\.ico\s*\{[^}]*display:\s*inline-flex[^}]*width:\s*20px[^}]*height:\s*20px/.test(css));
    check('tombol aksi HP tetap 32px (tidak meluber di layar sempit)',
      css.includes('.hud-icon { width: 32px; height: 32px; font-size: 15px; }'));
    check('lencana notifikasi tetap di sudut tombol (bukan menutupi ikon)',
      css.includes('.badge { position: absolute; top: -6px; right: -6px;'));

    // --- (4) Struktur HUD di HTML ---
    const htmlRes = await fetch(BASE + '/');
    const html = await htmlRes.text();
    dom = new JSDOM(html);
    const document = dom.window.document;
    check('HTML memakai stylesheet /css/style.css',
      !!document.querySelector('link[href="/css/style.css"]'));
    const hud = document.querySelector('header.hud');
    const side = hud?.querySelector('.hud-side');
    const sideIds = side ? [...side.children].map((el) => el.id) : [];
    check('HUD: kolom kiri berisi avatar, menu, peti — urut',
      sideIds.join(',') === 'hud-avatar,btn-menu,btn-crate', `urutan=${sideIds.join(',')}`);
    const actions = [...(hud?.querySelectorAll('.hud-actions .hud-icon') || [])].map((el) => el.id);
    check('HUD: 3 tombol aksi (chat, lonceng, gear)',
      actions.join(',') === 'btn-chat,btn-notif,btn-settings', `aksi=${actions.join(',')}`);
    const icons = [...(hud?.querySelectorAll('.hud-icon') || [])];
    check('HUD: semua tombol ikon berisi glyph (tidak kosong)',
      icons.length === 4 && icons.every((el) => el.textContent.trim().length > 0), `tombol=${icons.length}`);
  } finally {
    stop();
    if (dom) dom.window.close();
  }

  console.log(`[ui-icons-dom] ${passed} lolos, ${failed} gagal`);
  if (failed) process.exitCode = 1;
}

main();
