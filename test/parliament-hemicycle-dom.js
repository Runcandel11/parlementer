// Parlementer — tes DOM diagram hemicycle parlemen v5.7.3 (jsdom + server sungguhan).
// Membuktikan di UI (bukan cuma API):
//   (1) Halaman #/parliament menampilkan diagram hemicycle SVG: 60 titik
//       (1 titik = 1 kursi), diwarnai PER PARTAI sesuai party_seats
//       (partai kursi terbanyak = warna pertama), bukan palet bergilir;
//   (2) Garis mayoritas (31) + legenda partai ("Nama — N kursi") tampil;
//   (3) Kursi kosong abu-abu + chip "Kosong — N kursi" saat parlemen
//       belum penuh;
//   (4) Fungsi murni renderHemicycle: 60 kursi selalu (baris 8+13+17+22),
//       warna blok partai berurutan, aman saat partySeats kosong.
// Referensi ide: https://flourish.studio/blog/how-to-make-parliament-chart/
// dan https://www.chartload.com/charts/parliament-chart/
// Jalankan: node test/parliament-hemicycle-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
import { DatabaseSync } from 'node:sqlite';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3471;
const DB_PATH = '/tmp/parlementer-hemicycle-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;
const EXPECTED_VERSION = '5.7.3';

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

function countFill(document, color) {
  return [...document.querySelectorAll('circle.hemi-dot')].filter((c) => (c.getAttribute('fill') || '').toLowerCase() === color).length;
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[parliament-hemicycle-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'hemicycle-dom-test-secret', ADMIN_BOOTSTRAP_CODE: 'hemicycle-dom-bootstrap' },
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
    check('API /api/world: versi ' + EXPECTED_VERSION, world.version === EXPECTED_VERSION, `version=${world.version}`);

    const jarA = makeJar(); const jarB = makeJar();
    let r = await api(jarA, '/api/auth/register', { email: 'hemi-a@test.local', password: 'rahasia123', username: 'hemi_a' });
    check('Daftar hemi_a (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    r = await api(jarB, '/api/auth/register', { email: 'hemi-b@test.local', password: 'rahasia123', username: 'hemi_b' });
    check('Daftar hemi_b (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    const meA = (await api(jarA, '/api/me', undefined, 'GET')).data;
    const citizenA = meA.citizen.id;
    const homeRegion = meA.citizen.home_region_id;
    const citizenB = (await api(jarB, '/api/me', undefined, 'GET')).data.citizen.id;
    let countryId;
    let party1Id; let party2Id;
    {
      const db = new DatabaseSync(DB_PATH);
      db.prepare('UPDATE citizens SET level = 10, gold = 500 WHERE id IN (?, ?)').run(citizenA, citizenB);
      countryId = Number(db.prepare("INSERT INTO country (name, founder_id) VALUES ('Nusantara Tes', ?) RETURNING id").get(citizenA).id);
      db.prepare('UPDATE regions SET country_id = ? WHERE id = ?').run(countryId, homeRegion);
      db.prepare("UPDATE db_meta SET value = ? WHERE key = 'parliament_opens_at'").run(String(Date.now() - 1000));
      db.close();
    }
    check('Negara seed + parlemen dibuka (DB)', !!countryId && !!homeRegion, `country=${countryId} region=${homeRegion}`);
    r = await api(jarA, '/api/parties', { name: 'Partai Biru', tag: 'BRU', ideology: 'Konservatif', type: 'application' });
    check('hemi_a dirikan Partai Biru (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    party1Id = r.data.partyId;
    r = await api(jarB, '/api/parties', { name: 'Partai Kuning', tag: 'KNG', ideology: 'Progresif', type: 'application' });
    check('hemi_b dirikan Partai Kuning (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    party2Id = r.data.partyId;
    {
      const db = new DatabaseSync(DB_PATH);
      db.prepare('INSERT INTO party_seats (party_id, country_id, seats) VALUES (?,?,?)').run(party1Id, countryId, 40);
      db.prepare('INSERT INTO party_seats (party_id, country_id, seats) VALUES (?,?,?)').run(party2Id, countryId, 20);
      db.close();
    }
    r = await api(jarA, '/api/parliament', undefined, 'GET');
    check('API /api/parliament: partySeats Biru 40 + Kuning 20, terisi 60',
      r.status === 200 && Array.isArray(r.data.partySeats) && r.data.partySeats.length === 2
      && r.data.partySeats[0].name === 'Partai Biru' && r.data.partySeats[0].seats === 40
      && r.data.partySeats[1].name === 'Partai Kuning' && r.data.partySeats[1].seats === 20
      && r.data.filledSeats === 60, `partySeats=${JSON.stringify(r.data.partySeats)} filled=${r.data.filledSeats}`);

    // --- (1–2) Hemicycle penuh 60 kursi, warna per partai + mayoritas + legenda ---
    dom = await bootDom(BASE + '/#/parliament', jarA);
    const { window } = dom;
    const { document } = window;
    const txt = () => document.querySelector('#page')?.textContent || '';
    check('Parlemen: judul PARLEMEN tampil', txt().includes('PARLEMEN'));
    check('Hemicycle: SVG tampil', !!document.querySelector('svg.hemi-svg'));
    const dots = document.querySelectorAll('circle.hemi-dot');
    check('Hemicycle: tepat 60 titik kursi', dots.length === 60, `titik=${dots.length}`);
    check('Hemicycle: Partai Biru 40 titik biru (#3b82f6)', countFill(document, '#3b82f6') === 40, `biru=${countFill(document, '#3b82f6')}`);
    check('Hemicycle: Partai Kuning 20 titik kuning (#f59e0b)', countFill(document, '#f59e0b') === 20, `kuning=${countFill(document, '#f59e0b')}`);
    check('Hemicycle: tidak ada kursi kosong saat penuh', countFill(document, '#26324a') === 0, `kosong=${countFill(document, '#26324a')}`);
    check('Hemicycle: garis mayoritas tampil', !!document.querySelector('line.hemi-majority'));
    check('Hemicycle: legenda "Partai Biru — 40 kursi" tampil', txt().includes('Partai Biru — 40 kursi'));
    check('Hemicycle: legenda "Partai Kuning — 20 kursi" tampil', txt().includes('Partai Kuning — 20 kursi'));
    check('Hemicycle: teks MAYORITAS 31 tetap tampil', txt().includes('MAYORITAS 31'));
    check('Hemicycle: tiap titik punya delay animasi stagger (--d)', [...dots].every((c) => (c.getAttribute('style') || '').includes('--d:')), `contoh=${dots[5]?.getAttribute('style')}`);
    check('Hemicycle: tidak ada chip Kosong saat penuh', !txt().includes('Kosong —'));

    // --- (3) Parlemen belum penuh: 15 kursi terisi, 45 kosong ---
    {
      const db = new DatabaseSync(DB_PATH);
      db.prepare('UPDATE party_seats SET seats = ? WHERE party_id = ? AND country_id = ?').run(15, party1Id, countryId);
      db.prepare('DELETE FROM party_seats WHERE party_id = ? AND country_id = ?').run(party2Id, countryId);
      db.close();
    }
    window.eval('route()');
    await sleep(900);
    check('Hemicycle belum penuh: tetap 60 titik', document.querySelectorAll('circle.hemi-dot').length === 60);
    check('Hemicycle belum penuh: 15 titik biru', countFill(document, '#3b82f6') === 15, `biru=${countFill(document, '#3b82f6')}`);
    check('Hemicycle belum penuh: 45 titik kosong abu-abu', countFill(document, '#26324a') === 45, `kosong=${countFill(document, '#26324a')}`);
    check('Hemicycle belum penuh: chip "Kosong — 45 kursi" tampil', txt().includes('Kosong — 45 kursi'));
    check('Hemicycle belum penuh: legenda Partai Biru 15 kursi', txt().includes('Partai Biru — 15 kursi'));

    // --- (4) Fungsi murni renderHemicycle (tanpa server) ---
    const html0 = window.eval("renderHemicycle([], 60, 0, 31)");
    const tmp = new JSDOM(`<body>${html0}</body>`);
    const tdoc = tmp.window.document;
    check('renderHemicycle([],60,0,31): 60 titik, semua kosong',
      tdoc.querySelectorAll('circle.hemi-dot').length === 60
      && [...tdoc.querySelectorAll('circle.hemi-dot')].every((c) => c.getAttribute('fill') === '#26324a'));
    check('renderHemicycle([],60,0,31): chip Kosong 60 + garis mayoritas',
      tdoc.body.textContent.includes('Kosong — 60 kursi') && !!tdoc.querySelector('line.hemi-majority'));
    const rows = window.eval('hemicycleRowCounts(60, [58, 88, 118, 148])');
    check('hemicycleRowCounts(60): baris 8+13+17+22 = 60', JSON.stringify(rows) === '[8,13,17,22]', `rows=${JSON.stringify(rows)}`);
    const html1 = window.eval("renderHemicycle([{name:'P',seats:31}], 60, 31, 31)");
    const tmp1 = new JSDOM(`<body>${html1}</body>`);
    const blue1 = [...tmp1.window.document.querySelectorAll('circle.hemi-dot')].filter((c) => c.getAttribute('fill') === '#3b82f6').length;
    const gray1 = [...tmp1.window.document.querySelectorAll('circle.hemi-dot')].filter((c) => c.getAttribute('fill') === '#26324a').length;
    check('renderHemicycle 31 kursi: 31 biru + 29 kosong', blue1 === 31 && gray1 === 29, `biru=${blue1} kosong=${gray1}`);
  } finally {
    if (dom) { try { dom.window.close(); } catch {} }
    stop();
    await sleep(500);
  }

  console.log(`\n[parliament-hemicycle-dom] ${passed} lolos, ${failed} gagal`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
