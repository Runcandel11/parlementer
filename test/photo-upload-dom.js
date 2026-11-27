// Parlementer — tes DOM upload foto (avatar + sampul artikel).
// Membuktikan (di jsdom + server sungguhan):
//   (1) REGRESI KASUS KHALID (28 Nov 2026): foto JPEG 120 KB yang dipilih
//       lewat picker Android dengan file.type KOSONG tetap diterima —
//       processAvatarFile/processCoverFile tidak lagi menolak hanya karena
//       file.type bukan image/*, selama ekstensi namanya .jpg/.jpeg/.png/
//       .webp (decode lewat <img> tetap jadi penjaga akhir);
//   (2) PESAN ERROR JUJUR: file bukan gambar / tidak bisa di-decode → pesan
//       format ("Format foto tidak didukung atau file rusak..."), BUKAN
//       tuduhan ukuran; hasil resize tetap > 500 KB → pesan ukuran
//       ("Foto terlalu besar (maks 500 KB setelah diperkecil).");
//   (3) UJI TINGKAT UI: di halaman profil sendiri, memilih file .txt
//       menampilkan toast pesan format; memilih .jpg tanpa tipe MIME
//       menampilkan pratinjau foto.
// Stub: jsdom tidak bisa decode gambar sungguhan, jadi window.Image +
// canvas di-stub di beforeParse (onload palsu 800×600; toDataURL palsu
// pendek, atau raksasa bila window.__stubDataUrlBig).
// Jalankan: node test/photo-upload-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3464;
const DB_PATH = '/tmp/parlementer-photo-upload-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;

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
    .replace(/<link[^>]*fonts\.gstatic\.com[^>]*>\s*/g, '');
  const dom = new JSDOM(htmlNoFonts, {
    url,
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = jarFetchFn;
      // --- Stub Image + canvas (jsdom tidak decode gambar) ---
      window.__stubImageFail = false;
      window.__stubDataUrlBig = false;
      window.URL.createObjectURL = () => 'blob:stub';
      window.URL.revokeObjectURL = () => {};
      window.Image = class {
        constructor() { this.width = 800; this.height = 600; this._src = ''; }
        set src(v) {
          this._src = v;
          setTimeout(() => {
            if (window.__stubImageFail) { if (typeof this.onerror === 'function') this.onerror(new Error('stub gagal baca')); }
            else if (typeof this.onload === 'function') this.onload();
          }, 0);
        }
        get src() { return this._src; }
      };
      window.HTMLCanvasElement.prototype.getContext = function () {
        return { drawImage() {} };
      };
      window.HTMLCanvasElement.prototype.toDataURL = function () {
        if (window.__stubDataUrlBig) return 'data:image/jpeg;base64,' + 'x'.repeat(700000);
        return 'data:image/jpeg;base64,' + 'x'.repeat(100);
      };
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
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[photo-upload-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'photo-upload-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  try {
    await sleep(1200);

    const jarA = makeJar();
    let r = await api(jarA, '/api/auth/register', { email: 'domFoto@test.local', password: 'rahasia123', username: 'warga_foto' });
    check('Daftar warga_foto (API)', r.status === 200 && r.data.ok);

    dom = await bootDom(BASE + '/#/dashboard', jarA);
    const { window } = dom;
    const { document } = window;
    const mkFile = (name, type) => new window.File(['isi-palsu'], name, { type });
    const hasResult = (res, key) => res && typeof res[key] === 'string' && res[key].startsWith('data:image/jpeg;base64,');

    // --- (1) Gerbang file: tipe kosong + ekstensi dikenal = diterima ---
    check('looksLikeImageFile: tipe kosong + .jpg = gambar', window.looksLikeImageFile(mkFile('logo.jpg', '')) === true);
    check('looksLikeImageFile: tipe kosong + .JPEG (kapital) = gambar', window.looksLikeImageFile(mkFile('FOTO.JPEG', '')) === true);
    check('looksLikeImageFile: tipe octet-stream + .png = gambar', window.looksLikeImageFile(mkFile('foto.png', 'application/octet-stream')) === true);
    check('looksLikeImageFile: tipe image/webp = gambar', window.looksLikeImageFile(mkFile('foto', 'image/webp')) === true);
    check('looksLikeImageFile: tipe kosong + .txt = bukan gambar', window.looksLikeImageFile(mkFile('catatan.txt', '')) === false);
    check('looksLikeImageFile: tipe kosong + tanpa ekstensi = bukan gambar', window.looksLikeImageFile(mkFile('foto', '')) === false);
    check('looksLikeImageFile: null = bukan gambar', window.looksLikeImageFile(null) === false);

    // --- (1) Avatar: kasus Khalid — JPEG tanpa tipe MIME diterima ---
    let res = await window.processAvatarFile(mkFile('logo.jpg', ''));
    check('Avatar: file .jpg tanpa tipe MIME DITERIMA (kasus 120 KB)', hasResult(res, 'avatar') && hasResult(res, 'avatarSm'), JSON.stringify(res)?.slice(0, 60));
    res = await window.processAvatarFile(mkFile('foto.png', 'application/octet-stream'));
    check('Avatar: file .png tipe octet-stream DITERIMA', hasResult(res, 'avatar') && hasResult(res, 'avatarSm'));
    res = await window.processAvatarFile(mkFile('foto.jpg', 'image/jpeg'));
    check('Avatar: file image/jpeg normal tetap DITERIMA', hasResult(res, 'avatar') && hasResult(res, 'avatarSm'));

    // --- (2) Avatar: penyebab gagal dibedakan ---
    res = await window.processAvatarFile(mkFile('catatan.txt', ''));
    check('Avatar: file .txt tanpa tipe → error format (bukan size)', res && res.error === 'format', JSON.stringify(res));
    res = await window.processAvatarFile(mkFile('dokumen.pdf', 'application/pdf'));
    check('Avatar: file .pdf → error format', res && res.error === 'format');
    window.__stubImageFail = true;
    res = await window.processAvatarFile(mkFile('rusak.jpg', 'image/jpeg'));
    check('Avatar: gambar gagal di-decode → error format (bukan size)', res && res.error === 'format', JSON.stringify(res));
    window.__stubImageFail = false;
    window.__stubDataUrlBig = true;
    res = await window.processAvatarFile(mkFile('besar.jpg', 'image/jpeg'));
    check('Avatar: hasil resize tetap > 500 KB → error size', res && res.error === 'size', JSON.stringify(res));
    window.__stubDataUrlBig = false;

    // --- (1)+(2) Sampul: pola sama seperti avatar ---
    res = await window.processCoverFile(mkFile('sampul.jpeg', ''));
    check('Sampul: file .jpeg tanpa tipe MIME DITERIMA', hasResult(res, 'cover') && hasResult(res, 'coverSm'), JSON.stringify(res)?.slice(0, 60));
    res = await window.processCoverFile(mkFile('dokumen.pdf', ''));
    check('Sampul: file .pdf tanpa tipe → error format', res && res.error === 'format');
    window.__stubDataUrlBig = true;
    res = await window.processCoverFile(mkFile('besar.jpg', 'image/jpeg'));
    check('Sampul: hasil resize tetap > 500 KB → error size', res && res.error === 'size', JSON.stringify(res));
    window.__stubDataUrlBig = false;

    // --- (2) Pesan error: jujur + berbeda per penyebab ---
    check('Pesan format: sebut JPG/PNG/WebP, tanpa tuduh ukuran',
      window.imageErrorMessage('format') === 'Format foto tidak didukung atau file rusak. Pakai JPG, PNG, atau WebP.',
      window.imageErrorMessage('format'));
    check('Pesan size: sebut batas 500 KB setelah diperkecil',
      window.imageErrorMessage('size') === 'Foto terlalu besar (maks 500 KB setelah diperkecil).',
      window.imageErrorMessage('size'));
    check('Pesan size ≠ pesan format', window.imageErrorMessage('size') !== window.imageErrorMessage('format'));

    // --- (3) Uji tingkat UI: halaman profil sendiri ---
    dom = await bootDom(BASE + '/#/profile/warga_foto', jarA);
    const doc2 = dom.window.document;
    // Tunggu input avatar muncul (profil sendiri).
    let input = null;
    for (let i = 0; i < 20 && !input; i++) { input = doc2.querySelector('#avatar-file'); if (!input) await sleep(300); }
    check('Profil sendiri: input #avatar-file ada', !!input);
    if (input) {
      const setFiles = (file) => {
        // jsdom tidak punya DataTransfer — timpa properti files langsung.
        Object.defineProperty(input, 'files', { value: [file], configurable: true });
        input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      };
      // File buruk → toast pesan format.
      setFiles(new dom.window.File(['x'], 'catatan.txt', { type: '' }));
      await sleep(700);
      const toastTxt = doc2.querySelector('#toast')?.textContent || '';
      check('UI: file .txt → toast pesan FORMAT (bukan tuduh ukuran)',
        toastTxt === 'Format foto tidak didukung atau file rusak. Pakai JPG, PNG, atau WebP.', toastTxt);
      // File bagus tanpa tipe MIME → pratinjau muncul.
      setFiles(new dom.window.File(['x'], 'logo.jpg', { type: '' }));
      await sleep(700);
      check('UI: file .jpg tanpa tipe MIME → pratinjau foto muncul',
        !!doc2.querySelector('#avatar-preview img'), doc2.querySelector('#avatar-preview')?.innerHTML?.slice(0, 80) || '(kosong)');
    }
  } finally {
    if (dom) dom.window.close();
    stop();
  }

  console.log(`\n[photo-upload-dom] ${passed} lolos, ${failed} gagal.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
