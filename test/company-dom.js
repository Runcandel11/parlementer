// Parlementer — tes DOM batch perusahaan (v2.4.0).
// Membuktikan (di jsdom + server sungguhan):
//   (1) PENJELASAN CARA KERJA: panel "CARA KERJA PERUSAHAAN" tampil di
//       halaman perusahaan — produksi harian, bonus shift karyawan (~1/10
//       produksi harian per shift penuh), gaji dibayar sistem (bukan
//       dipotong pemilik), kebutuhan Besi Mentah untuk Pabrik.
//   (2) EDIT: tombol EDIT hanya ada di kartu perusahaan MILIK SENDIRI
//       (pemain lain tidak melihatnya); edit lewat UI mengubah nama di
//       server; form edit perusahaan resource memuat pilihan bahan.
//   (3) FOTO: foto perusahaan tampil BESAR (img.company-photo) di kartu
//       milik sendiri + thumbnail (img.company-photo-sm) di daftar semua
//       perusahaan; upload lewat UI (processCoverFile) menyimpan foto ke
//       server.
//   (4) BONUS: teks bonus shift tampil di kartu ("2× Besi Mentah per shift
//       penuh" untuk resource; "0,8× Makanan per shift penuh" untuk light).
// Stub: jsdom tidak bisa decode gambar sungguhan, jadi window.Image +
// canvas di-stub di beforeParse (onload palsu 800×600). Berbeda dengan
// photo-upload-dom, toDataURL di sini mengembalikan JPEG mungil yang
// BENAR-BENAR valid (magic bytes FF D8 FF) supaya server menerimanya
// saat foto diunggah lewat UI.
// Jalankan: node test/company-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
import { DatabaseSync } from 'node:sqlite';
import { testPort, testDbPath } from './test-env.js';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = testPort(3468);
const DB_PATH = testDbPath('/tmp/parlementer-company-dom.db');
const BASE = `http://127.0.0.1:${PORT}`;

// JPEG mungil yang valid (magic bytes FF D8 FF) — dipakai sebagai hasil
// canvas stub DAN sebagai foto yang dikirim lewat API.
const TINY_JPEG = 'data:image/jpeg;base64,' + Buffer.from([
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
]).toString('base64');

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
      // --- Stub Image + canvas (jsdom tidak decode gambar) ---
      window.__lastObjectURLFile = null;
      window.URL.createObjectURL = (file) => { window.__lastObjectURLFile = file; return 'blob:stub'; };
      window.URL.revokeObjectURL = () => {};
      window.Image = class {
        constructor() { this.width = 800; this.height = 600; this._src = ''; }
        set src(v) {
          this._src = v;
          setTimeout(() => { if (typeof this.onload === 'function') this.onload(); }, 0);
        }
        get src() { return this._src; }
      };
      window.HTMLCanvasElement.prototype.getContext = function () {
        return { drawImage() {} };
      };
      // Kembalikan JPEG mungil yang VALID supaya server menerimanya.
      window.HTMLCanvasElement.prototype.toDataURL = function () { return TINY_JPEG; };
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

  console.log('[company-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'company-dom-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  let domB = null;
  try {
    await sleep(1200);

    const jarA = makeJar();
    const jarB = makeJar();
    let r = await api(jarA, '/api/auth/register', { email: 'domPerusahaan@test.local', password: 'rahasia123', username: 'warga_perusahaan' });
    check('Daftar pemilik (API)', r.status === 200 && r.data.ok);
    r = await api(jarB, '/api/auth/register', { email: 'domLain@test.local', password: 'rahasia123', username: 'warga_lain' });
    check('Daftar pemain lain (API)', r.status === 200 && r.data.ok);
    // Emas untuk mendirikan resource (100) + light (250).
    const db = new DatabaseSync(DB_PATH);
    const aId = db.prepare("SELECT c.id FROM citizens c JOIN users u ON u.id = c.user_id WHERE u.username = 'warga_perusahaan'").get().id;
    db.prepare('UPDATE citizens SET gold = 500 WHERE id = ?').run(aId);
    db.close();
    r = await api(jarA, '/api/companies', { type: 'resource', name: 'Tambang Dom', resource: 'Besi Mentah' });
    check('Pemilik mendirikan Tambang Dom (API)', r.status === 200 && !!r.data.companyId, `status=${r.status}`);
    const tambangId = r.data.companyId;
    r = await api(jarA, '/api/companies', { type: 'light', name: 'Dapur Dom' });
    check('Pemilik mendirikan Dapur Dom (API)', r.status === 200 && !!r.data.companyId, `status=${r.status}`);
    const dapurId = r.data.companyId;

    // --- (1) Penjelasan + (2) tombol edit + (4) teks bonus (sebagai pemilik) ---
    dom = await bootDom(BASE + '/#/companies', jarA);
    const { window } = dom;
    const { document } = window;
    const pageTxt = document.querySelector('#page')?.textContent || '';
    check('Penjelasan: panel CARA KERJA PERUSAHAAN tampil', pageTxt.includes('CARA KERJA PERUSAHAAN'));
    check('Penjelasan: sebut produksi harian', pageTxt.includes('Produksi harian'));
    check('Penjelasan: sebut bonus shift ~1/10 produksi harian', pageTxt.includes('1/10 produksi harian'));
    check('Penjelasan: gaji DIPOTONG dari uang pemilik, bukan dicetak sistem', pageTxt.includes('DIPOTONG dari uangmu') && pageTxt.includes('bukan dicetak sistem'));
    check('Penjelasan: Pabrik butuh 2× Besi Mentah', pageTxt.includes('2× Besi Mentah'));
    check('Pemilik: tombol EDIT ada di perusahaannya', !!document.querySelector('[data-editco]'));
    check('Pemilik: tombol PASANG FOTO ada di perusahaannya', !!document.querySelector('[data-photoco]'));
    check('Bonus: kartu Tambang menampilkan 2× Besi Mentah per shift penuh', pageTxt.includes('2× Besi Mentah per shift penuh'));
    check('Bonus: kartu Dapur menampilkan 0,8× Makanan per shift penuh', pageTxt.includes('0,8× Makanan per shift penuh'));

    // --- (2) Pemain lain: tidak ada tombol edit/foto; melihat perusahaan di daftar ---
    domB = await bootDom(BASE + '/#/companies', jarB);
    const docB = domB.window.document;
    const pageTxtB = docB.querySelector('#page')?.textContent || '';
    check('Pemain lain: TIDAK ada tombol EDIT', !docB.querySelector('[data-editco]'));
    check('Pemain lain: TIDAK ada tombol PASANG FOTO', !docB.querySelector('[data-photoco]'));
    check('Pemain lain: melihat Tambang Dom di SEMUA PERUSAHAAN', pageTxtB.includes('Tambang Dom'));

    // --- (3) Foto via API: tampil besar + thumbnail ---
    r = await api(jarA, `/api/companies/${tambangId}/photo`, { photo: TINY_JPEG, photo_sm: TINY_JPEG });
    check('Pemilik pasang foto Tambang via API', r.status === 200, `status=${r.status}`);
    dom.window.close(); dom = null;
    dom = await bootDom(BASE + '/#/companies', jarA);
    const doc2 = dom.window.document;
    const bigImg = doc2.querySelector('img.company-photo');
    check('Foto: tampil BESAR (img.company-photo) di kartu milik sendiri', !!bigImg && (bigImg.getAttribute('src') || '').startsWith('data:image/jpeg;base64,'), bigImg?.getAttribute('src')?.slice(0, 40) || '(tidak ada)');
    domB.window.close(); domB = null;
    domB = await bootDom(BASE + '/#/companies', jarB);
    const thumb = domB.window.document.querySelector('img.company-photo-sm');
    check('Foto: thumbnail (img.company-photo-sm) di daftar semua perusahaan', !!thumb && (thumb.getAttribute('src') || '').startsWith('data:image/jpeg;base64,'));

    // --- (3) Foto via UI: upload ke Dapur lewat input file ---
    const doc3 = dom.window.document;
    const input = doc3.querySelector('#co-photo-' + dapurId);
    check('UI foto: input file Dapur ada', !!input);
    if (input) {
      Object.defineProperty(input, 'files', { value: [new dom.window.File(['isi-palsu'], 'foto.jpg', { type: '' })], configurable: true });
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      await sleep(1200);
      const cos = (await api(jarA, '/api/companies')).data.companies || [];
      const dapur = cos.find((x) => x.id === dapurId);
      check('UI foto: foto Dapur tersimpan di server setelah upload', typeof dapur?.photo === 'string' && dapur.photo.startsWith('data:image/jpeg;base64,'), (dapur?.photo || '').slice(0, 40));
    }

    // --- (2) Edit via UI: ubah nama Tambang ---
    const doc4 = dom.window.document;
    const editBtn = doc4.querySelector(`[data-editco="${tambangId}"]`);
    check('UI edit: tombol EDIT Tambang bisa diklik', !!editBtn);
    if (editBtn) {
      editBtn.click();
      await sleep(500);
      const nameInput = doc4.querySelector('#co-name-' + tambangId);
      const resSelect = doc4.querySelector('#co-resource-' + tambangId);
      check('UI edit: form edit muncul (input nama)', !!nameInput);
      check('UI edit: form perusahaan resource memuat pilihan bahan', !!resSelect);
      if (nameInput) {
        nameInput.value = 'Tambang Dom Baru';
        doc4.querySelector('#co-save-' + tambangId)?.click();
        await sleep(1200);
        const cos = (await api(jarA, '/api/companies')).data.companies || [];
        check('UI edit: nama tersimpan di server', cos.find((x) => x.id === tambangId)?.name === 'Tambang Dom Baru', cos.find((x) => x.id === tambangId)?.name);
      }
    }
  } finally {
    if (dom) dom.window.close();
    if (domB) domB.window.close();
    stop();
  }

  console.log(`\n[company-dom] ${passed} lolos, ${failed} gagal.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
