// Parlementer — tes DOM Customer Service v5.7.4 (jsdom + server sungguhan).
// Membuktikan di UI (bukan cuma API):
//   (1) Tombol CS mengambang ada di tepi kanan-tengah layar (fixed,
//       right: 0, top: 50%) dan TIDAK muncul di layar login/landing
//       (#app tersembunyi sebelum login).
//   (2) Klik tombol → panel chat terbuka; kirim pesan → muncul di panel.
//   (3) Balasan agen CS muncul di panel pemain + dot belum-dibaca muncul
//       sebelum panel dibuka, hilang setelah panel dibuka.
//   (4) Panel admin #/admin/cs menampilkan daftar thread + detail +
//       balas; akun agen CS (bukan admin) bisa membuka CS tapi tidak bisa
//       melihat daftar pemain.
// Jalankan: node test/cs-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
import { DatabaseSync } from 'node:sqlite';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3476;
const DB_PATH = '/tmp/parlementer-cs-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;
const EXPECTED_VERSION = '5.7.4';

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
        set src(v) {
          this._src = v;
          setTimeout(() => { if (typeof this.onload === 'function') this.onload(); }, 0);
        }
        get src() { return this._src; }
      };
      window.HTMLCanvasElement.prototype.getContext = function () {
        return { drawImage() {} };
      };
      window.HTMLCanvasElement.prototype.toDataURL = function () {
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

async function goto(dom, hash) {
  dom.window.location.hash = hash;
  dom.window.route();
  await sleep(1300);
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[cs-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'cs-dom-test-secret', ADMIN_BOOTSTRAP_CODE: 'cs-dom-bootstrap' },
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
    check('API /api/world: versi 5.7.4', world.version === EXPECTED_VERSION, `version=${world.version}`);

    const jarA = makeJar();
    const jarADM = makeJar();
    const jarCSA = makeJar();
    let r = await api(jarA, '/api/auth/register', { email: 'csdom@test.local', password: 'rahasia123', username: 'cs_dom' });
    check('Daftar pemain cs_dom (API)', r.status === 200 && r.data.ok);
    r = await api(jarADM, '/api/auth/register', { email: 'admin@csdom.local', password: 'rahasia123', username: 'cs_admin', admin_code: 'cs-dom-bootstrap' });
    check('Daftar admin darurat (API)', r.status === 200 && r.data.ok);
    // Respons register TIDAK membawa is_admin — verifikasi lewat /api/me.
    const meADM = (await api(jarADM, '/api/me', undefined, 'GET')).data;
    check('Admin darurat: /api/me mengirim is_admin', meADM.user.is_admin === true, `is_admin=${meADM.user.is_admin}`);
    r = await api(jarCSA, '/api/auth/register', { email: 'csagent@csdom.local', password: 'rahasia123', username: 'cs_agent_dom' });
    check('Daftar akun agen CS (API)', r.status === 200 && r.data.ok);
    const meCSA0 = (await api(jarCSA, '/api/me', undefined, 'GET')).data;
    {
      const db = new DatabaseSync(DB_PATH);
      db.prepare('UPDATE users SET is_cs_agent = 1 WHERE id = ?').run(meCSA0.user.id);
      db.close();
    }
    // Ambil ulang SETELAH UPDATE — /api/me yang diambil sebelum UPDATE
    // tentu masih membawa nilai lama.
    const meCSA = (await api(jarCSA, '/api/me', undefined, 'GET')).data;
    const meA = (await api(jarA, '/api/me', undefined, 'GET')).data;
    check('Agen CS: /api/me mengirim is_cs_agent', meCSA.user.is_cs_agent === true, `is_cs_agent=${meCSA.user.is_cs_agent}`);

    // --- (1) Tombol mengambang: posisi + hanya setelah login ---
    const css = await (await fetch(BASE + '/css/style.css')).text();
    check('CSS: .cs-float fixed di kanan-tengah (right: 0, top: 50%)',
      css.includes('.cs-float') && css.includes('position: fixed; right: 0; top: 50%'));
    check('CSS: panel CS menghormati prefers-reduced-motion',
      css.includes('prefers-reduced-motion') && css.includes('.cs-float'));
    dom = await bootDom(BASE + '/', fetch);
    let { window } = dom;
    let { document } = window;
    check('Tamu (belum login): #app tersembunyi → tombol CS tidak terlihat',
      document.querySelector('#app')?.hidden === true);
    dom.window.close(); dom = null;

    // --- (2) Pemain: buka panel + kirim pesan ---
    dom = await bootDom(BASE + '/#/dashboard', jarA);
    ({ window } = dom);
    ({ document } = window);
    check('Pemain login: #app tampil', document.querySelector('#app')?.hidden === false);
    const btnCs = document.querySelector('#btn-cs');
    check('Tombol CS mengambang ada (#btn-cs.cs-float)', !!btnCs && btnCs.classList.contains('cs-float'));
    check('Panel CS awalnya tersembunyi', document.querySelector('#cs-panel')?.hidden === true);
    btnCs.click();
    await sleep(1300);
    check('Klik tombol CS → panel terbuka', document.querySelector('#cs-panel')?.hidden === false);
    check('Panel kosong: teks jujur "Belum ada percakapan"',
      (document.querySelector('#cs-list')?.textContent || '').includes('Belum ada percakapan'));
    const input = document.querySelector('#cs-text');
    input.value = 'Halo CS, pasar saya error.';
    document.querySelector('#btn-cs-send').click();
    await sleep(1300);
    const listText = document.querySelector('#cs-list')?.textContent || '';
    check('Pesan pemain muncul di panel', listText.includes('Halo CS, pasar saya error.'), listText.slice(0, 120));
    check('Status: menunggu balasan customer service',
      (document.querySelector('#cs-status')?.textContent || '').includes('Menunggu balasan customer service'));

    // --- (3) Balasan agen CS + dot belum-dibaca ---
    // Tutup panel dulu supaya polling 5 detik tidak menandai balasan
    // sudah dibaca sebelum dot diperiksa.
    document.querySelector('#cs-close').click();
    await sleep(300);
    check('Panel tertutup sebelum balasan dicek', document.querySelector('#cs-panel')?.hidden === true);
    r = await api(jarCSA, '/api/admin/cs', undefined, 'GET');
    const threadId = r.data.threads?.[0]?.id;
    check('Agen CS melihat thread pemain di daftar admin', !!threadId, `threads=${r.data.threads?.length}`);
    r = await api(jarCSA, '/api/admin/cs/' + threadId + '/reply', { body: 'Halo! Sudah kami cek, coba muat ulang halaman Pasar.' });
    check('Agen CS balas dari API', r.status === 200 && r.data.sender === 'agent', `status=${r.status}`);
    await window.updateCsBadge();
    await sleep(300);
    check('Dot belum-dibaca muncul di tombol CS', document.querySelector('#badge-cs')?.hidden === false);
    // Buka panel lagi → balasan dimuat + ditandai dibaca.
    document.querySelector('#btn-cs').click();
    await sleep(1300);
    const listText2 = document.querySelector('#cs-list')?.textContent || '';
    check('Balasan agen CS muncul di panel pemain', listText2.includes('Sudah kami cek'), listText2.slice(0, 200));
    check('Label balasan: "Customer Service"', listText2.includes('Customer Service'));
    check('Status berubah: Customer Service sudah membalas',
      (document.querySelector('#cs-status')?.textContent || '').includes('sudah membalas'));
    await window.updateCsBadge();
    await sleep(300);
    check('Dot hilang setelah panel dibuka (sudah dibaca)', document.querySelector('#badge-cs')?.hidden === true);
    document.querySelector('#cs-close').click();
    await sleep(300);
    check('Tombol ✕ menutup panel', document.querySelector('#cs-panel')?.hidden === true);
    dom.window.close(); dom = null;

    // --- (4) Panel admin: daftar + detail + balas ---
    dom = await bootDom(BASE + '/#/admin/cs', jarADM);
    ({ window } = dom);
    ({ document } = window);
    await sleep(500);
    const adminPage = document.querySelector('#page')?.textContent || '';
    check('Admin #/admin/cs: judul CUSTOMER SERVICE', adminPage.includes('CUSTOMER SERVICE'));
    check('Admin: daftar thread menampilkan pemain cs_dom', adminPage.includes('cs_dom'));
    check('Admin: tab Customer Service ada di panel admin', adminPage.includes('Customer Service'));
    const openBtn = document.querySelector('[data-goto^="#/admin/cs-"]');
    check('Admin: tombol BUKA PERCAKAPAN ada', !!openBtn);
    openBtn.click();
    await sleep(1500);
    const detailPage = document.querySelector('#page')?.textContent || '';
    check('Admin detail: percakapan tampil (pesan pemain + balasan CS)',
      detailPage.includes('Halo CS, pasar saya error.') && detailPage.includes('Sudah kami cek'));
    check('Admin detail: kolom balasan ada', !!document.querySelector('#cs-admin-text'));
    check('Admin detail: tombol Tutup Thread ada (admin saja)', !!document.querySelector('#btn-cs-close'));
    const adminInput = document.querySelector('#cs-admin-text');
    adminInput.value = 'Balasan admin dari panel.';
    document.querySelector('#btn-cs-admin-send').click();
    await sleep(1500);
    const detailPage2 = document.querySelector('#page')?.textContent || '';
    check('Admin: balasan terkirim + tampil di detail', detailPage2.includes('Balasan admin dari panel.'));
    dom.window.close(); dom = null;

    // --- (5) Agen CS (bukan admin): bisa CS, tidak bisa daftar pemain ---
    dom = await bootDom(BASE + '/#/admin/cs', jarCSA);
    ({ window } = dom);
    ({ document } = window);
    await sleep(500);
    const csPage = document.querySelector('#page')?.textContent || '';
    check('Agen CS: #/admin/cs terbuka (daftar thread)', csPage.includes('CUSTOMER SERVICE') && csPage.includes('cs_dom'));
    check('Agen CS: tidak ada tab Pemain di halamannya', !csPage.includes('👥 Pemain'));
    await goto(dom, '#/admin');
    await sleep(500);
    check('Agen CS: #/admin polos diarahkan ke #/admin/cs',
      dom.window.location.hash === '#/admin/cs', `hash=${dom.window.location.hash}`);
    r = await api(jarCSA, '/api/admin/players', undefined, 'GET');
    check('Agen CS: /api/admin/players tetap 403 (API)', r.status === 403, `status=${r.status}`);
  } finally {
    if (dom) dom.window.close();
    stop();
  }
  console.log(`\n[cs-dom] SELESAI: ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[cs-dom] ERROR:', e); process.exit(1); });
