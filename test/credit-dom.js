// Parlementer — tes DOM sistem kredit skor (v3.0.0, saran LIO tiket #7).
// Membuktikan (di jsdom + server sungguhan):
//   (1) DASHBOARD: panel #dash-credit menampilkan skor 100/100 + tier
//       "Baik" + "Tidak ada batasan" untuk warga baru.
//   (2) PROFIL: halaman profil menampilkan "Skor Kredit" 100/100.
//   (3) TIER: setelah skor diset 75 (DB), dashboard menampilkan tier
//       "Waspada" + batasan "Membuat koran / menerbitkan artikel".
//   (4) ADMIN INBOX: laporan chat menampilkan skor penulis + dua tombol
//       putusan (TERBUKTI −10 / TIDAK TERBUKTI); klik TERBUKTI menurunkan
//       skor penulis 75 → 65 (dicek lewat API).
//   (5) ADMIN PEMAIN: daftar pemain menampilkan "65/100" + tombol
//       "Riwayat" yang membuka riwayat perubahan skor.
// Jalankan: node test/credit-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
import { DatabaseSync } from 'node:sqlite';
import { testPort, testDbPath } from './test-env.js';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = testPort(3472);
const DB_PATH = testDbPath('/tmp/parlementer-credit-dom.db');
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
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[credit-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'credit-dom-test-secret', ADMIN_BOOTSTRAP_CODE: 'credit-dom-bootstrap' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  try {
    await sleep(1200);

    const jarA = makeJar(); // penulis pesan
    const jarB = makeJar(); // pelapor
    const jarADM = makeJar(); // admin
    let r = await api(jarA, '/api/auth/register', { email: 'kreditdom_a@test.local', password: 'rahasia123', username: 'warga_kredit_a' });
    check('Daftar pemain A (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    r = await api(jarB, '/api/auth/register', { email: 'kreditdom_b@test.local', password: 'rahasia123', username: 'warga_kredit_b' });
    check('Daftar pemain B (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    r = await api(jarADM, '/api/auth/register', { email: 'kreditdom_admin@test.local', password: 'rahasia123', username: 'admin_kredit', admin_code: 'credit-dom-bootstrap' });
    check('Daftar admin (kode bootstrap)', r.status === 200 && r.data.ok, `status=${r.status}`);
    r = await api(jarADM, '/api/me');
    check('Akun bootstrap menjadi admin', r.data.user.is_admin === true, `is_admin=${r.data.user.is_admin}`);
    const aUserId = (await api(jarA, '/api/me')).data.user.id;

    // --- (1) DASHBOARD: panel skor 100/100 + Baik ---
    dom = await bootDom(BASE + '/#/dashboard', jarA);
    let creditPanel = dom.window.document.querySelector('#dash-credit');
    check('Dashboard: panel #dash-credit tampil', !!creditPanel);
    check('Dashboard: skor 100/100 + tier Baik', !!creditPanel && (creditPanel.textContent || '').includes('100/100') && (creditPanel.textContent || '').includes('Baik'), creditPanel?.textContent?.trim().slice(0, 80));
    check('Dashboard: tanpa batasan', !!creditPanel && (creditPanel.textContent || '').includes('Tidak ada batasan'));
    dom.window.close(); dom = null;

    // --- (2) PROFIL: skor kredit tampil ---
    dom = await bootDom(BASE + '/#/profile/warga_kredit_a', jarA);
    const profileTxt = dom.window.document.querySelector('#page')?.textContent || '';
    check('Profil: "Skor Kredit" tampil', profileTxt.includes('Skor Kredit'), profileTxt.slice(0, 120));
    check('Profil: skor 100/100 tampil', profileTxt.includes('100/100'));
    dom.window.close(); dom = null;

    // --- (3) TIER: skor 75 → Waspada + batasan pers ---
    const db = new DatabaseSync(DB_PATH);
    const aCitizenId = db.prepare("SELECT c.id FROM citizens c JOIN users u ON u.id = c.user_id WHERE u.username = 'warga_kredit_a'").get().id;
    db.prepare('UPDATE citizens SET credit_score = 75, credit_updated_at = ? WHERE id = ?').run(Date.now(), aCitizenId);
    db.close();
    dom = await bootDom(BASE + '/#/dashboard', jarA);
    creditPanel = dom.window.document.querySelector('#dash-credit');
    check('Dashboard skor 75: tier Waspada', !!creditPanel && (creditPanel.textContent || '').includes('Waspada'), creditPanel?.textContent?.trim().slice(0, 80));
    check('Dashboard skor 75: batasan pers ditampilkan', !!creditPanel && (creditPanel.textContent || '').includes('Membuat koran'));
    dom.window.close(); dom = null;

    // --- (4) ADMIN INBOX: putusan TERBUKTI menurunkan skor 75 → 65 ---
    r = await api(jarA, '/api/chat/global', { content: 'Pesan kasar A untuk tes DOM kredit' });
    check('A mengirim pesan global (API)', r.status === 200 && !!r.data.messageId, `status=${r.status}`);
    const msgId = r.data.messageId;
    r = await api(jarB, '/api/chat/report', { message_id: msgId, reason: 'Pelecehan', details: 'tes DOM' });
    check('B melaporkan pesan A (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    dom = await bootDom(BASE + '/#/admin/inbox', jarADM);
    const { window } = dom;
    const { document } = window;
    const provenBtn = document.querySelector('[data-report][data-verdict="proven"]');
    const notProvenBtn = document.querySelector('[data-report][data-verdict="not_proven"]');
    check('Inbox admin: tombol TERBUKTI (−10) ada', !!provenBtn, provenBtn?.textContent?.trim());
    check('Inbox admin: tombol TIDAK TERBUKTI ada', !!notProvenBtn);
    const inboxTxt = document.querySelector('#page')?.textContent || '';
    check('Inbox admin: skor penulis (75) ditampilkan', inboxTxt.includes('Skor penulis') && inboxTxt.includes('75'));
    if (provenBtn) {
      provenBtn.click();
      await sleep(1500);
      const meAfter = await api(jarA, '/api/me');
      check('Klik TERBUKTI: skor A 75 → 65', meAfter.data.citizen.credit_score === 65, `skor=${meAfter.data.citizen.credit_score}`);
    }
    dom.window.close(); dom = null;

    // --- (5) ADMIN PEMAIN: skor + riwayat ---
    dom = await bootDom(BASE + '/#/admin', jarADM);
    const adminTxt = dom.window.document.querySelector('#page')?.textContent || '';
    check('Panel admin: "Skor Kredit" tampil di kartu pemain', adminTxt.includes('Skor Kredit'));
    check('Panel admin: skor A 65/100 tampil', adminTxt.includes('65/100'));
    const histBtn = [...dom.window.document.querySelectorAll('[data-act="credit-history"]')].find((b) => {
      const panel = b.closest('[data-player]');
      return panel && Number(panel.dataset.player) === aUserId;
    });
    check('Panel admin: tombol Riwayat skor ada di kartu A', !!histBtn);
    if (histBtn) {
      histBtn.click();
      await sleep(1500);
      const box = histBtn.closest('[data-player]')?.querySelector('.credit-history-box');
      const boxTxt = box?.textContent || '';
      check('Riwayat skor: pengurangan −10 tercatat', boxTxt.includes('−10') || boxTxt.includes('-10'), boxTxt.slice(0, 120));
      check('Riwayat skor: skor setelah 65 tercatat', boxTxt.includes('65'));
    }
    dom.window.close(); dom = null;
  } finally {
    if (dom) dom.window.close();
    stop();
  }

  console.log(`\n[credit-dom] ${passed} lolos, ${failed} gagal.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
