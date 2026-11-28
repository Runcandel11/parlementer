// Parlementer — tes DOM share link + notifikasi v4.6.1: tombol Bagikan Link
// di top bar + halaman #/share + pusat notifikasi di atas + chip SISTEM +
// deteksi HEIC di klien.
// Membuktikan (di jsdom + server sungguhan):
//   (1) #btn-share ada di .hud-actions TEPAT setelah #btn-ads (urutan:
//       chat, lonceng, iklan, share, gear), data-goto="#/share",
//       aria-label "Bagikan Link", berisi glyph 🔗;
//   (2) Dashboard punya panel #dash-share ("BAGIKAN LINK");
//   (3) Klik #btn-share → #/share menampilkan link pribadi (/s/<kode
//       10 karakter>), tombol salin, statistik hari ini (klik/emas/sisa
//       kuota), dan aturan "1 IP = 1 klik terhitung per hari";
//   (4) Halaman Notifikasi: panel "Pusat Notifikasi" muncul SEBELUM
//       panel "APA YANG BARU" (tidak perlu scroll ke bawah), dan
//       notifikasi SISTEM dibedakan dengan chip teal "⚙️ SISTEM"
//       (bukan chip kategori polos);
//   (5) Deteksi HEIC klien: isHeicFile mengenali MIME image/heic,
//       ekstensi .heic, dan magic bytes ftyp+heic — tapi TIDAK menandai
//       JPEG biasa sebagai HEIC; imageErrorMessage('heic') memberi
//       pesan HEIC dengan jalan keluar (ubah ke JPG); processAvatarFile
//       menolak file HEIC dengan error 'heic' sebelum decode.
// Jalankan: node test/share-dom.js  (atau: npm run test:share)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3474;
const DB_PATH = '/tmp/parlementer-share-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;
const EXPECTED_VERSION = '5.2.0';

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

  console.log('[share-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'share-dom-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  try {
    await sleep(1200);

    const world = await (await fetch(BASE + '/api/world')).json();
    check('API /api/world: versi 5.2.0', world.version === EXPECTED_VERSION, `version=${world.version}`);

    // --- Warga baru, boot dashboard.
    const jar = makeJar();
    const r = await api(jar, '/api/auth/register', { email: 'domShare@test.local', password: 'rahasia123', username: 'warga_share' });
    check('Daftar warga_share (API)', r.status === 200 && r.data.ok);
    dom = await bootDom(BASE + '/#/dashboard', jar);
    const doc = dom.window.document;
    const hud = doc.querySelector('header.hud');
    check('Header HUD ada', !!hud);

    // --- (1) Tombol Bagikan Link di top bar, di samping tombol iklan.
    const btnShare = hud?.querySelector('#btn-share');
    check('Top bar: tombol #btn-share ada', !!btnShare);
    check('Top bar: #btn-share di dalam .hud-actions',
      !!btnShare?.closest('.hud-actions'));
    check('Top bar: #btn-share menuju #/share', btnShare?.dataset.goto === '#/share', `data-goto=${btnShare?.dataset.goto}`);
    check('Top bar: #btn-share punya aria-label "Bagikan Link"',
      btnShare?.getAttribute('aria-label') === 'Bagikan Link', btnShare?.getAttribute('aria-label') || '');
    check('Top bar: #btn-share berisi glyph 🔗',
      (btnShare?.textContent || '').includes('🔗'), btnShare?.textContent.trim());
    check('Top bar: #btn-share memakai gaya .hud-icon (sejajar tombol lain)',
      btnShare?.classList.contains('hud-icon') === true);
    const actionsOrder = [...(hud?.querySelectorAll('.hud-actions .hud-icon') || [])].map((el) => el.id);
    check('Top bar: urutan aksi chat, lonceng, iklan, share, gear',
      actionsOrder.join(',') === 'btn-chat,btn-notif,btn-ads,btn-share,btn-settings', `aksi=${actionsOrder.join(',')}`);

    // --- (2) Panel Bagikan Link di dashboard.
    check('Dashboard: panel #dash-share ada',
      !!doc.querySelector('#dash-share'));
    check('Dashboard: panel #dash-share menyebut +10 emas per klik unik',
      (doc.querySelector('#dash-share')?.textContent || '').includes('+10 emas'));

    // --- (3) Klik #btn-share → #/share.
    btnShare.click();
    await sleep(900);
    check('Klik #btn-share: hash pindah ke #/share',
      dom.window.location.hash === '#/share', `hash=${dom.window.location.hash}`);
    check('Halaman #/share: menampilkan "LINK PRIBADIMU"',
      pageText(dom).includes('LINK PRIBADIMU'), pageText(dom).slice(0, 200));
    const shareUrl = doc.querySelector('#share-url')?.value || '';
    check('Halaman #/share: input link berisi /s/<kode 10 karakter>',
      /\/s\/[a-hj-km-np-z2-9]{10}$/.test(shareUrl), shareUrl);
    check('Halaman #/share: tombol salin ada',
      !!doc.querySelector('#btn-copy-share'));
    check('Halaman #/share: statistik hari ini (klik/emas/sisa kuota)',
      pageText(dom).includes('STATISTIK HARI INI') && pageText(dom).includes('Sisa kuota hari ini'));
    check('Halaman #/share: aturan "1 IP = 1 klik terhitung per hari"',
      pageText(dom).includes('1 IP = 1 klik terhitung per hari'));

    // --- (4) Notifikasi: pusat di atas, SISTEM dibedakan.
    dom.window.location.hash = '#/notifications';
    await sleep(900);
    const notifHtml = doc.querySelector('#page')?.innerHTML || '';
    const pusatIdx = notifHtml.indexOf('Pusat Notifikasi');
    const baruIdx = notifHtml.indexOf('APA YANG BARU');
    check('Notifikasi: "Pusat Notifikasi" muncul SEBELUM "APA YANG BARU"',
      pusatIdx !== -1 && baruIdx !== -1 && pusatIdx < baruIdx, `pusat=${pusatIdx} baru=${baruIdx}`);
    check('Notifikasi: notifikasi SISTEM punya chip teal "⚙️ SISTEM"',
      notifHtml.includes('⚙️ SISTEM') && notifHtml.includes('chip teal'), notifHtml.slice(0, 400));
    check('Notifikasi: panel pengumuman diberi label "Pengumuman update game"',
      notifHtml.includes('Pengumuman update game'));

    // --- (5) Deteksi HEIC di klien (fungsi global app.js).
    const win = dom.window;
    check('Klien: isHeicFile tersedia', typeof win.isHeicFile === 'function');
    const heicByType = new win.File(['x'], 'foto', { type: 'image/heic' });
    check('HEIC: MIME image/heic dikenali', (await win.isHeicFile(heicByType)) === true);
    const heicByName = new win.File(['x'], 'FOTO.HEIC', { type: '' });
    check('HEIC: ekstensi .heic dikenali', (await win.isHeicFile(heicByName)) === true);
    const heicBytes = new win.File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99])], 'foto', { type: '' });
    check('HEIC: magic bytes ftyp+heic dikenali', (await win.isHeicFile(heicBytes)) === true);
    const jpegFile = new win.File(['x'], 'foto.jpg', { type: 'image/jpeg' });
    check('HEIC: JPEG biasa TIDAK ditandai HEIC', (await win.isHeicFile(jpegFile)) === false);
    check('HEIC: pesan error memberi jalan keluar (ubah ke JPG)',
      (win.imageErrorMessage('heic') || '').includes('HEIC') && (win.imageErrorMessage('heic') || '').includes('JPG'));
    const heicResult = await win.processAvatarFile(heicByType);
    check('HEIC: processAvatarFile menolak HEIC dengan error heic',
      heicResult?.error === 'heic', JSON.stringify(heicResult));
  } finally {
    if (dom) dom.window.close();
    stop();
  }
  console.log(`\n[share-dom] ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
