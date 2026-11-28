// Parlementer — tes DOM ticket batch v5.7.3 (jsdom + server sungguhan).
// Membuktikan di UI (bukan cuma API):
//   (1) Detail partai: nama member bisa diklik -> profil publik; anggota
//       parlemen bertanda 🏛️ (is_mp dari party_seats);
//   (2) Ketua bisa ganti nama + singkatan partai (tombol "Ubah Nama",
//       form + konfirmasi 50 emas); anggota biasa tidak melihat tombolnya;
//   (3) Dashboard saat travel aktif: kartu rute dari -> ke + hitung mundur
//       + progres (bar berjalan tiap detik);
//   (4) Statistik: panel PALING AKTIF (top 10) + LAMA TIDAK AKTIF (>= 7
//       hari); nama partai di leaderboard bisa diklik -> detail partai
//       (tiket #55 LIO — dulu nama partai di leaderboard tidak bisa diklik);
//   (5) Halaman Negara: RINGKASAN ARUS KAS menampilkan nominal pemasukan /
//       pengeluaran / sumbangan (bukan hanya 20 baris arus kas).
// Jalankan: node test/ticket-batch-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
import { DatabaseSync } from 'node:sqlite';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3471;
const DB_PATH = '/tmp/parlementer-ticket-batch-dom.db';
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

  console.log('[ticket-batch-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'ticket-batch-dom-test-secret', ADMIN_BOOTSTRAP_CODE: 'ticket-batch-dom-bootstrap' },
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
    check('API /api/world: versi 5.7.3', world.version === '5.7.3', `version=${world.version}`);

    const jarL = makeJar(); const jarM = makeJar();
    let r = await api(jarL, '/api/auth/register', { email: 'ketua-tb@test.local', password: 'rahasia123', username: 'tiket_pemimpin' });
    check('Daftar tiket_pemimpin (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    r = await api(jarM, '/api/auth/register', { email: 'anggota-tb@test.local', password: 'rahasia123', username: 'tiket_anggota' });
    check('Daftar tiket_anggota (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    r = await api(makeJar(), '/api/auth/register', { email: 'inaktif-tb@test.local', password: 'rahasia123', username: 'lama_tidak_aktif' });
    check('Daftar lama_tidak_aktif (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    const leaderId = (await api(jarL, '/api/me', undefined, 'GET')).data.citizen.id;
    const memberId = (await api(jarM, '/api/me', undefined, 'GET')).data.citizen.id;
    // Warga lama tidak aktif: last_seen 8 hari lalu (tanpa /api/me lagi).
    {
      const db = new DatabaseSync(DB_PATH);
      const row = db.prepare("SELECT c.id AS id FROM citizens c JOIN users u ON u.id = c.user_id WHERE u.username = 'lama_tidak_aktif'").get();
      db.prepare('UPDATE citizens SET last_seen_at = ? WHERE id = ?').run(Date.now() - 8 * 24 * 3600 * 1000, row.id);
      db.close();
    }
    // Ketua dirikan negara (untuk kas negara + kursi) lalu partai.
    let countryId = null;
    {
      const db = new DatabaseSync(DB_PATH);
      const free = db.prepare('SELECT id FROM regions WHERE country_id IS NULL ORDER BY id LIMIT 1').get();
      db.prepare('UPDATE citizens SET level = 10, gold = 1000, region_id = ?, home_region_id = ? WHERE id = ?').run(free.id, free.id, leaderId);
      db.close();
    }
    r = await api(jarL, '/api/countries', { name: 'Negara Tiket', ideology: 'Konservatisme', system: 'presidensial' });
    check('Ketua dirikan Negara Tiket (API)', r.status === 200 && !!r.data.countryId, `status=${r.status} ${r.data.error || ''}`);
    countryId = r.data.countryId;
    r = await api(jarL, '/api/parties', { name: 'Partai Tiket', tag: 'TKT', ideology: 'Progresif', type: 'open' });
    check('Ketua dirikan Partai Tiket (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    const partyId = r.data.partyId;
    r = await api(jarM, `/api/parties/${partyId}/join`, {});
    check('tiket_anggota gabung langsung (API)', r.status === 200 && r.data.role === 'member', `status=${r.status}`);
    {
      const db = new DatabaseSync(DB_PATH);
      db.prepare('INSERT INTO party_seats (party_id, country_id, seats) VALUES (?,?,5)').run(partyId, countryId);
      const inCountry = db.prepare('SELECT id FROM regions WHERE country_id = ? ORDER BY id LIMIT 1').get(countryId);
      db.prepare('UPDATE citizens SET home_region_id = ?, region_id = ? WHERE id = ?').run(inCountry.id, inCountry.id, memberId);
      db.close();
    }
    // Sumbangan ke kas negara (untuk ringkasan): 10 emas + 1 Makanan.
    r = await api(jarL, '/api/country/donate', { type: 'gold', amount: 10 });
    check('Donasi 10 emas (API)', r.status === 200, `status=${r.status}`);
    r = await api(jarL, '/api/country/donate', { type: 'item', commodity: 'Makanan', qty: 1 });
    check('Donasi 1x Makanan (API)', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
    // Travel ketua ke wilayah lain (untuk timer dashboard).
    const meL = (await api(jarL, '/api/me', undefined, 'GET')).data;
    const regions = (await api(jarL, '/api/regions', undefined, 'GET')).data.regions;
    const dest = regions.find((x) => x.id !== meL.citizen.region_id);
    r = await api(jarL, '/api/regions/travel', { region_id: dest.id });
    check('Travel dimulai (API)', r.status === 200 && r.data.inTransit, `status=${r.status} ${JSON.stringify(r.data)}`);
    const meTravel = (await api(jarL, '/api/me', undefined, 'GET')).data.travel;
    check('API /api/me travel membawa rute + total + progres', !!meTravel && meTravel.fromRegionName === meL.region.name && meTravel.toRegionName === dest.name && meTravel.totalMs > 0, JSON.stringify(meTravel));

    // --- (1) Detail partai: member bisa diklik + tanda MP ---
    dom = await bootDom(BASE + '/#/parties/' + partyId, jarL);
    const { window } = dom;
    const { document } = window;
    const txt = () => document.querySelector('#page')?.textContent || '';
    check('Detail: nama ketua bisa diklik (data-goto profil)', !!document.querySelector('[data-goto="#/profile/tiket_pemimpin"]'));
    check('Detail: nama anggota bisa diklik (data-goto profil)', !!document.querySelector('[data-goto="#/profile/tiket_anggota"]'));
    check('Detail: anggota bertanda Anggota Parlemen (kursi 5)', txt().includes('Anggota Parlemen') && txt().includes('5 kursi'), txt().slice(0, 300));

    // Klik nama anggota -> profil publiknya.
    document.querySelector('[data-goto="#/profile/tiket_anggota"]').click();
    await sleep(1200);
    check('Klik nama anggota: hash #/profile/tiket_anggota', window.location.hash === '#/profile/tiket_anggota', window.location.hash);
    check('Profil anggota tampil', txt().includes('tiket_anggota'));

    // --- (2) Rename partai (ketua saja) ---
    window.location.hash = '#/parties/' + partyId;
    await sleep(1200);
    check('Detail: tombol "Ubah Nama Partai" tampil untuk ketua', !!document.querySelector('#btn-rename-party'));
    document.querySelector('#btn-rename-party').click();
    await sleep(500);
    check('Klik Ubah Nama: form rename muncul', !!document.querySelector('#rn-name') && !!document.querySelector('#rn-tag'));
    document.querySelector('#rn-name').value = 'Partai Tiket Baru';
    document.querySelector('#rn-tag').value = 'TKB';
    document.querySelector('#rn-submit').click();
    await sleep(1200);
    const renamed = (await api(jarL, `/api/parties/${partyId}`, undefined, 'GET')).data.party;
    check('Rename via UI: nama + singkatan berubah di server', renamed.name === 'Partai Tiket Baru' && renamed.tag === 'TKB', `nama=${renamed.name} tag=${renamed.tag}`);
    check('Rename via UI: emas ketua berkurang 50', (await api(jarL, '/api/me', undefined, 'GET')).data.citizen.gold === meL.citizen.gold - 50, `emas=${(await api(jarL, '/api/me', undefined, 'GET')).data.citizen.gold} (sebelum ${meL.citizen.gold}, minus 50 rename — donasi 10 sudah terpotong sebelum pengukuran)`);
    check('Setelah rename: halaman menampilkan nama baru', txt().includes('Partai Tiket Baru'));

    // Anggota biasa tidak melihat tombol rename / bubarkan.
    const domM = await bootDom(BASE + '/#/parties/' + partyId, jarM);
    const docM = domM.window.document;
    check('Anggota biasa TIDAK melihat tombol Ubah Nama', !docM.querySelector('#btn-rename-party'));
    check('Anggota biasa TIDAK melihat tombol Bubarkan Partai', !docM.querySelector('#btn-dissolve-party'));
    domM.window.close();

    // --- (3) Dashboard: kartu travel rute + countdown + progres berjalan ---
    const domD = await bootDom(BASE + '/#/dashboard', jarL);
    const docD = domD.window.document;
    const txtD = () => docD.querySelector('#page')?.textContent || '';
    await sleep(1200);
    check('Dashboard: kartu travel menampilkan rute dari -> ke', txtD().includes('Dalam perjalanan') && txtD().includes('→'), txtD().slice(0, 400));
    const cdEl = docD.querySelector('[data-travel-countdown]');
    const prEl = docD.querySelector('[data-travel-progress]');
    check('Dashboard: hitung mundur travel tampil (data-travel-countdown)', !!cdEl && /mnt|tiba/.test(cdEl.textContent || ''), cdEl?.textContent || '');
    check('Dashboard: bar progres travel tampil (data-travel-progress)', !!prEl, prEl ? prEl.getAttribute('style') : '');
    const w0 = prEl ? parseFloat(prEl.style.width || '0') : -1;
    await sleep(3000);
    const w1 = prEl ? parseFloat(prEl.style.width || '0') : -1;
    check('Dashboard: bar progres bergerak tiap detik (ticker hidup)', w1 > w0, `lebar ${w0}% -> ${w1}%`);
    domD.window.close();

    // --- (4) Statistik: panel online + tidak aktif + partai bisa diklik ---
    const domS = await bootDom(BASE + '/#/stats', jarL);
    const docS = domS.window.document;
    const txtS = () => docS.querySelector('#page')?.textContent || '';
    check('Statistik: panel PALING AKTIF tampil', txtS().includes('PALING AKTIF'));
    check('Statistik: panel LAMA TIDAK AKTIF tampil', txtS().includes('LAMA TIDAK AKTIF'));
    check('Statistik: warga baru aktif tampil di PALING AKTIF', (docS.querySelector('#leaders-online')?.textContent || '').includes('tiket_pemimpin'));
    check('Statistik: warga 8 hari lalu tampil di LAMA TIDAK AKTIF', (docS.querySelector('#leaders-inactive')?.textContent || '').includes('lama_tidak_aktif'));
    check('Statistik: nama partai di leaderboard bisa diklik (tiket #55)', !!docS.querySelector('[data-goto="#/parties/' + partyId + '"]'));
    docS.querySelector('[data-goto="#/parties/' + partyId + '"]').click();
    await sleep(1200);
    check('Klik partai di leaderboard: hash #/parties/<id>', domS.window.location.hash === '#/parties/' + partyId, domS.window.location.hash);
    domS.window.close();

    // --- (5) Halaman Negara: ringkasan arus kas + nominal sumbangan ---
    const domC = await bootDom(BASE + '/#/country', jarL);
    const docC = domC.window.document;
    const txtC = () => docC.querySelector('#page')?.textContent || '';
    check('Negara: RINGKASAN ARUS KAS tampil', txtC().includes('RINGKASAN ARUS KAS'));
    check('Negara: ringkasan menampilkan pemasukan emas 10', txtC().includes('Pemasukan emas') && txtC().includes('+10'));
    check('Negara: ringkasan menampilkan nominal sumbangan', txtC().includes('Sumbangan masuk') && txtC().includes('10'));
    domC.window.close();
  } finally {
    if (dom) dom.window.close();
    stop();
  }
  console.log(`\n[ticket-batch-dom] SELESAI: ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[ticket-batch-dom] ERROR:', e); process.exit(1); });
