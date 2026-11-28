// Parlementer — tes DOM manajemen partai v5.6.0 (jsdom + server sungguhan).
// Membuktikan di UI (bukan cuma API):
//   (1) Daftar partai: tiap kartu punya tombol LIHAT DETAIL + panel
//       PARTAIMU punya tautan ke detail;
//   (2) Halaman detail partai (#/parties/<id>): tampil nama/ideologi/ketua
//       + daftar member dengan jabatan (Ketua/Anggota/Sekretaris);
//   (3) Ketua bisa menyetujui lamaran dari halaman detail (tombol Setujui);
//   (4) Ketua bisa mengangkat anggota jadi Sekretaris lalu mencopotnya
//       (tombol berubah Angkat ↔ Copot, label jabatan berubah);
//   (5) Ketua bisa menolak lamaran dari halaman detail (tombol Tolak).
//   (6) v5.7.4 — Ketua bisa mengeluarkan anggota (tombol Keluarkan) dan
//       membubarkan partai (tombol Bubarkan Partai); anggota biasa tidak
//       melihat kedua tombol itu.
// Jalankan: node test/party-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
import { DatabaseSync } from 'node:sqlite';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3471;
const DB_PATH = '/tmp/parlementer-party-dom.db';
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
      window.confirm = () => true;
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

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[party-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'party-dom-test-secret', ADMIN_BOOTSTRAP_CODE: 'party-dom-bootstrap' },
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
    check('API /api/world: versi 5.7.4', world.version === '5.7.4', `version=${world.version}`);

    const jarL = makeJar(); const jarM = makeJar(); const jarA = makeJar();
    let r = await api(jarL, '/api/auth/register', { email: 'ketua-dom@test.local', password: 'rahasia123', username: 'ketua_dom' });
    check('Daftar ketua_dom (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    r = await api(jarM, '/api/auth/register', { email: 'anggota-dom@test.local', password: 'rahasia123', username: 'anggota_dom' });
    check('Daftar anggota_dom (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    r = await api(jarA, '/api/auth/register', { email: 'pelamar-dom@test.local', password: 'rahasia123', username: 'pelamar_dom' });
    check('Daftar pelamar_dom (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    const leaderId = (await api(jarL, '/api/me', undefined, 'GET')).data.citizen.id;
    const memberId = (await api(jarM, '/api/me', undefined, 'GET')).data.citizen.id;
    {
      const db = new DatabaseSync(DB_PATH);
      db.prepare('UPDATE citizens SET level = 10, gold = 200 WHERE id = ?').run(leaderId);
      db.close();
    }
    r = await api(jarL, '/api/parties', { name: 'Partai DOM', tag: 'DOM', ideology: 'Progresif', type: 'application' });
    check('Ketua dirikan partai DOM (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    const partyId = r.data.partyId;
    r = await api(jarM, `/api/parties/${partyId}/join`, {});
    check('anggota_dom lamar (API, pending)', r.status === 200 && r.data.role === 'pending', `status=${r.status}`);

    // --- (1) Daftar partai: tombol LIHAT DETAIL + tautan PARTAIMU ---
    dom = await bootDom(BASE + '/#/parties', jarL);
    const { window } = dom;
    const { document } = window;
    const txt = () => document.querySelector('#page')?.textContent || '';
    check('Daftar partai: judul PARTAI-PARTAI tampil', txt().includes('PARTAI-PARTAI'));
    check('Daftar partai: kartu Partai DOM tampil', txt().includes('Partai DOM'));
    check('Daftar partai: tombol LIHAT DETAIL tampil', !!document.querySelector('[data-goto="#/parties/' + partyId + '"]'));
    check('Daftar partai: panel PARTAIMU punya tautan detail', !!document.querySelector('[data-goto="#/parties/' + partyId + '"]'));

    // --- (2) Halaman detail: isi + daftar member + lamaran masuk ---
    document.querySelector('[data-goto="#/parties/' + partyId + '"]').click();
    await sleep(900);
    check('Klik LIHAT DETAIL: hash #/parties/<id>', window.location.hash === '#/parties/' + partyId, window.location.hash);
    check('Detail: nama partai + ideologi tampil', txt().includes('Partai DOM') && txt().includes('Progresif'));
    check('Detail: daftar member tampil dengan jabatan Ketua', txt().includes('DAFTAR MEMBER') && txt().includes('ketua_dom') && txt().includes('Ketua'));
    check('Detail: lamaran masuk tampil (anggota_dom + Setujui/Tolak)',
      txt().includes('LAMARAN MASUK') && txt().includes('anggota_dom')
      && !!document.querySelector('[data-approve="' + memberId + '"]')
      && !!document.querySelector('[data-reject="' + memberId + '"]'));

    // --- (3) Setujui lamaran dari halaman detail ---
    document.querySelector('[data-approve="' + memberId + '"]').click();
    await sleep(900);
    check('Setelah Setujui: anggota_dom jadi member (label Anggota)', txt().includes('anggota_dom') && txt().includes('Anggota'), txt().slice(0, 200));
    check('Setelah Setujui: panel lamaran menampilkan "Tidak ada lamaran menunggu"', txt().includes('Tidak ada lamaran menunggu'));

    // --- (4) Angkat jadi Sekretaris lalu copot ---
    const appointBtn = document.querySelector('[data-appoint="' + memberId + '"]');
    check('Detail: tombol "Angkat jadi Sekretaris" tampil untuk anggota', !!appointBtn);
    appointBtn.click();
    await sleep(900);
    check('Setelah angkat: label jabatan jadi Sekretaris', txt().includes('Sekretaris'), txt().slice(0, 200));
    const removeBtn = document.querySelector('[data-remove-sec="' + memberId + '"]');
    check('Setelah angkat: tombol "Copot Sekretaris" tampil', !!removeBtn);
    removeBtn.click();
    await sleep(900);
    check('Setelah copot: label kembali Anggota', txt().includes('anggota_dom') && txt().includes('Anggota'));

    // --- (5) Tolak lamaran dari halaman detail ---
    r = await api(jarA, `/api/parties/${partyId}/join`, {});
    check('pelamar_dom lamar (API, pending)', r.status === 200 && r.data.role === 'pending', `status=${r.status}`);
    document.querySelector('[data-goto="#/parties"]').click();
    await sleep(900);
    document.querySelector('[data-goto="#/parties/' + partyId + '"]').click();
    await sleep(900);
    const applicantId = (await api(jarA, '/api/me', undefined, 'GET')).data.citizen.id;
    check('Detail: lamaran pelamar_dom tampil lagi', txt().includes('pelamar_dom') && !!document.querySelector('[data-reject="' + applicantId + '"]'));
    document.querySelector('[data-reject="' + applicantId + '"]').click();
    await sleep(900);
    check('Setelah Tolak: panel lamaran menampilkan "Tidak ada lamaran menunggu"', txt().includes('Tidak ada lamaran menunggu'));

    // --- (6) v5.7.4 — Keluarkan anggota + bubarkan partai ---
    // Anggota biasa tidak melihat tombol Keluarkan / Bubarkan Partai.
    const domM = await bootDom(BASE + '/#/parties/' + partyId, jarM);
    const docM = domM.window.document;
    check('Anggota biasa TIDAK melihat tombol Keluarkan', !docM.querySelector('[data-kick]'));
    check('Anggota biasa TIDAK melihat tombol Bubarkan Partai', !docM.querySelector('#btn-dissolve-party'));
    domM.window.close();
    // Ketua melihat tombol Keluarkan untuk anggota + tombol Bubarkan.
    const kickBtn = document.querySelector('[data-kick="' + memberId + '"]');
    check('Detail: tombol "Keluarkan" tampil untuk anggota (ketua)', !!kickBtn);
    check('Detail: tombol "Bubarkan Partai" tampil untuk ketua', !!document.querySelector('#btn-dissolve-party'));
    kickBtn.click();
    await sleep(900);
    check('Setelah Keluarkan: anggota_dom hilang dari daftar member', !txt().includes('anggota_dom'));
    check('Setelah Keluarkan: daftar member tinggal ketua', txt().includes('DAFTAR MEMBER (1)'));
    // Bubarkan partai dari halaman detail → kembali ke daftar partai.
    document.querySelector('#btn-dissolve-party').click();
    await sleep(900);
    check('Setelah Bubarkan: kembali ke daftar partai (#/parties)', window.location.hash === '#/parties', window.location.hash);
    check('Setelah Bubarkan: Partai DOM hilang dari daftar', !txt().includes('Partai DOM'));
  } finally {
    if (dom) dom.window.close();
    stop();
  }
  console.log(`\n[party-dom] SELESAI: ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[party-dom] ERROR:', e); process.exit(1); });
