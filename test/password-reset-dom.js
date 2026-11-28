// Parlementer — tes DOM fitur Lupa Password v5.5.0 (jsdom + server sungguhan).
// Membuktikan di UI (bukan cuma API):
//   (1) Layar login menampilkan link "Lupa Password?" + form lupa password
//       (tersembunyi sampai link diketuk);
//   (2) Kirim permintaan (email tak dikenal maupun terdaftar) menampilkan
//       pesan generik yang sama — tidak membocorkan keberadaan akun;
//   (3) Cek status sebelum ACC: tombol sekali pakai tetap tersembunyi;
//   (4) Setelah admin ACC di kotak masuk, cek status menampilkan tombol
//       "Masuk & Buat Password Baru";
//   (5) Tombol itu membawa pemain ke halaman #/reset-password;
//   (6) Form password baru: konfirmasi beda ditolak, yang cocok disimpan
//       dan pemain mendarat di dashboard; login password lama gagal,
//       password baru berhasil (API).
// Jalankan: node test/password-reset-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3470;
const DB_PATH = '/tmp/parlementer-password-reset-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;

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
  const res = await jar(path, body === undefined && !method ? undefined : { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
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
      window.URL.createObjectURL = () => 'blob:stub';
      window.URL.revokeObjectURL = () => {};
      window.Image = class {
        constructor() { this.width = 800; this.height = 600; this._src = ''; }
        set src(v) { this._src = v; setTimeout(() => { if (typeof this.onload === 'function') this.onload(); }, 0); }
        get src() { return this._src; }
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

function submitForm(window, form) {
  // jsdom punya requestSubmit tapi hanya stub ("Not implemented") — kirim
  // event submit langsung; handler onsubmit tetap terpanggil.
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[password-reset-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'pwreset-dom-test-secret', ADMIN_BOOTSTRAP_CODE: 'pwreset-dom-bootstrap' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { const r = await fetch(BASE + '/api/world'); up = r.ok; } catch { await sleep(250); }
    }
    check('server menyala dan /api/world merespons', up);
    if (!up) { process.exitCode = 1; return; }
    const world = await (await fetch(BASE + '/api/world')).json();
    check('API /api/world: versi 5.7.0', world.version === '5.7.0', `version=${world.version}`);

    const jarPlayer = makeJar();
    const jarAdmin = makeJar();
    // Jar DOM terpisah TANPA sesi: jarPlayer sudah login (terdaftar di
    // atas), jadi boot dengan jar itu akan langsung masuk aplikasi dan
    // layar login tidak pernah tampil.
    const jarDom = makeJar();
    let r = await api(jarPlayer, '/api/auth/register', { email: 'lupa-dom@test.local', password: 'lama12345', username: 'warga_lupa_dom' });
    check('Daftar warga_lupa_dom (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    r = await api(jarAdmin, '/api/auth/register', { email: 'admin-dom@test.local', password: 'rahasia123', username: 'admin_dom', admin_code: 'pwreset-dom-bootstrap' });
    check('Daftar admin_dom dengan kode bootstrap (API)', r.status === 200 && r.data.ok, `status=${r.status}`);

    // --- (1) Layar login: link + form lupa password ---
    dom = await bootDom(BASE + '/', jarDom);
    const { window } = dom;
    const { document } = window;
    // Boot tanpa sesi → showAuth → landing; buka form MASUK.
    document.querySelector('#landing-login')?.click();
    await sleep(300);
    check('Layar login: link "Lupa Password?" tampil', !!document.querySelector('#link-forgot'));
    check('Layar login: form lupa password tersembunyi awalnya', document.querySelector('#form-forgot')?.hidden === true);
    document.querySelector('#link-forgot').click();
    await sleep(300);
    check('Klik link: form lupa password tampil, form login sembunyi', document.querySelector('#form-forgot')?.hidden === false && document.querySelector('#form-login')?.hidden === true);

    // --- (2) Permintaan: pesan generik identik untuk email tak dikenal & terdaftar ---
    const forgotForm = document.querySelector('#form-forgot');
    const setForgotEmail = (v) => { forgotForm.querySelector('input[name="email"]').value = v; };
    setForgotEmail('tidakada@test.local');
    submitForm(window, forgotForm);
    await sleep(800);
    const info1 = document.querySelector('#forgot-info');
    check('Forgot email tak dikenal: pesan info tampil (generik)', info1?.hidden === false && (info1?.textContent || '').length > 0, info1?.textContent?.slice(0, 60) || '');
    const msgUnknown = info1?.textContent || '';
    setForgotEmail('lupa-dom@test.local');
    forgotForm.querySelector('input[name="note"]').value = 'warga_lupa_dom';
    submitForm(window, forgotForm);
    await sleep(800);
    const info2 = document.querySelector('#forgot-info');
    check('Forgot email terdaftar: pesan info tampil', info2?.hidden === false && (info2?.textContent || '').length > 0);
    check('Pesan generik identik (tidak bocor mana yang terdaftar)', (info2?.textContent || '') === msgUnknown);

    // --- (3) Cek status sebelum ACC: tombol sekali pakai tetap sembunyi ---
    document.querySelector('#btn-forgot-check').click();
    await sleep(800);
    check('Cek status sebelum ACC: tombol sekali pakai tetap tersembunyi', document.querySelector('#btn-reset-login')?.hidden === true);
    check('Cek status sebelum ACC: info "belum disetujui" tampil', (document.querySelector('#forgot-info')?.textContent || '').includes('Belum disetujui'));

    // --- (4) Admin ACC dari kotak masuk → cek status menampilkan tombol ---
    r = await api(jarAdmin, '/api/admin/password-resets', undefined, 'GET');
    const prId = r.data.requests?.find((x) => x.status === 'pending')?.id;
    check('Admin: permintaan terlihat di daftar reset', !!prId, `id=${prId}`);
    r = await api(jarAdmin, '/api/admin/tickets', undefined, 'GET');
    const inInbox = (r.data.tickets || []).some((t) => t.kind === 'password_reset' && t.username === 'warga_lupa_dom');
    check('Admin: permintaan muncul di kotak masuk tiket', inInbox);
    r = await api(jarAdmin, `/api/admin/password-resets/${prId}/decide`, { decision: 'accept' });
    check('Admin ACC permintaan (API)', r.status === 200 && r.data.status === 'approved', `status=${r.status}`);
    document.querySelector('#btn-forgot-check').click();
    await sleep(800);
    check('Cek status setelah ACC: tombol sekali pakai TAMPIL', document.querySelector('#btn-reset-login')?.hidden === false);

    // --- (5) Tombol sekali pakai → halaman buat password baru ---
    document.querySelector('#btn-reset-login').click();
    await sleep(2500);
    check('Setelah klik tombol: hash #/reset-password', window.location.hash === '#/reset-password', window.location.hash);
    check('Halaman reset: form password baru tampil', !!document.querySelector('#form-reset-password'));

    // --- (6) Form password baru: validasi + simpan + dashboard ---
    const resetForm = document.querySelector('#form-reset-password');
    resetForm.querySelector('input[name="password"]').value = 'baru12345';
    resetForm.querySelector('input[name="password_confirm"]').value = 'beda12345';
    submitForm(window, resetForm);
    await sleep(800);
    check('Konfirmasi beda: error tampil', document.querySelector('#reset-error')?.hidden === false);
    resetForm.querySelector('input[name="password"]').value = 'baru12345';
    resetForm.querySelector('input[name="password_confirm"]').value = 'baru12345';
    submitForm(window, resetForm);
    await sleep(2000);
    check('Password cocok: pindah ke dashboard', window.location.hash === '#/dashboard', window.location.hash);
    check('Dashboard termuat setelah reset', (document.querySelector('#page')?.textContent || '').length > 50);
    // Login lama gagal, login baru berhasil (API, jar baru tanpa sesi).
    const jarCheck = makeJar();
    r = await api(jarCheck, '/api/auth/login', { email: 'lupa-dom@test.local', password: 'lama12345' });
    check('Login password LAMA setelah reset ditolak (API)', r.status === 400, `status=${r.status}`);
    r = await api(jarCheck, '/api/auth/login', { email: 'lupa-dom@test.local', password: 'baru12345' });
    check('Login password BARU setelah reset berhasil (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
  } catch (e) {
    console.error('[password-reset-dom] ERROR:', e);
    process.exitCode = 1;
  } finally {
    if (dom) dom.window.close();
    stop();
  }
  console.log(`\n[password-reset-dom] SELESAI: ${passed} lolos, ${failed} gagal`);
  process.exitCode = failed ? 1 : process.exitCode || 0;
}

main();
