// Parlementer — tes DOM Tahap 6 v4.0.0 (jsdom + server sungguhan).
// Membuktikan di UI (bukan cuma API):
//   (1) Dashboard: panel EVENT DUNIA (nama + efek minggu ini) dan panel
//       MILITER (kekuatan, pasukan, perawatan);
//   (2) #/military: kartu rekrut 3 jenis unit + tombol REKRUT (klik
//       merekrut di server, kekuatan naik) + BUBARKAN 1 + top 5;
//   (3) Detail wilayah: baris "Penguasa wilayah" + panel DEMOGRAFI;
//   (4) Profil publik: baris Reputasi Dagang + Kekuatan Militer;
//   (5) Perusahaan: input_text rantai produksi di kartu jenis ("Butuh: ...");
//   (6) Pasar: kartu penawaran menampilkan ⭐ reputasi penjual.
// Jalankan: node test/stage6-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
import { DatabaseSync } from 'node:sqlite';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3469;
const DB_PATH = '/tmp/parlementer-stage6-dom.db';
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
      window.confirm = () => true;
      window.URL.createObjectURL = () => 'blob:stub';
      window.URL.revokeObjectURL = () => {};
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

  console.log('[stage6-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'stage6-dom-test-secret' },
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
    check('API /api/world: versi 5.7.1', world.version === '5.7.1', `version=${world.version}`);

    const jarA = makeJar();
    const jarB = makeJar();
    let r = await api(jarA, '/api/auth/register', { email: 'domEnam@test.local', password: 'rahasia123', username: 'warga_enam' });
    check('Daftar warga_enam (API)', r.status === 200 && r.data.ok);
    r = await api(jarB, '/api/auth/register', { email: 'domEnam2@test.local', password: 'rahasia123', username: 'warga_enam_dua' });
    check('Daftar warga_enam_dua (API)', r.status === 200 && r.data.ok);
    const meA = (await api(jarA, '/api/me', undefined, 'GET')).data;
    const meB = (await api(jarB, '/api/me', undefined, 'GET')).data;
    const eventName = meA.worldEvent?.name || '';

    // Beri barang: A punya Senjata 50 + Drone 10 (bisa rekrut lewat UI);
    // B sudah 50 transaksi (reputasi Terpercaya) untuk cek profil.
    const db = new DatabaseSync(DB_PATH);
    const comId = (name) => db.prepare('SELECT id FROM commodities WHERE name = ?').get(name)?.id;
    const senjataId = comId('Senjata');
    const droneId = comId('Drone');
    const besiId = comId('Besi Mentah');
    db.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,?) ON CONFLICT (citizen_id, commodity_id, tier) DO UPDATE SET qty = excluded.qty').run(meA.citizen.id, senjataId, 50);
    db.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,?) ON CONFLICT (citizen_id, commodity_id, tier) DO UPDATE SET qty = excluded.qty').run(meA.citizen.id, droneId, 10);
    db.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,?) ON CONFLICT (citizen_id, commodity_id, tier) DO UPDATE SET qty = excluded.qty').run(meA.citizen.id, besiId, 30);
    db.prepare('UPDATE citizens SET trades_completed = 50 WHERE id = ?').run(meB.citizen.id);
    db.close();

    // --- (1) Dashboard: panel event + militer ---
    dom = await bootDom(BASE + '/#/dashboard', jarA);
    let { window } = dom;
    let { document } = window;
    const dashEvent = document.querySelector('#dash-event');
    check('Dashboard: panel event dunia ada', !!dashEvent, dashEvent?.textContent?.slice(0, 80) || '');
    check(`Dashboard: panel event menyebut "${eventName}"`, !!eventName && (dashEvent?.textContent || '').toLowerCase().includes(eventName.toLowerCase()), dashEvent?.textContent?.slice(0, 80) || '');
    const dashMil = document.querySelector('#dash-military');
    check('Dashboard: panel militer ada', !!dashMil, dashMil?.textContent?.slice(0, 80) || '');
    check('Dashboard: panel militer menyebut kekuatan/pasukan', /Kekuatan|Pasukan/.test(dashMil?.textContent || ''));

    // --- (2) Halaman militer: rekrut lewat UI ---
    await goto(dom, '#/military');
    let pageText = document.querySelector('#page')?.textContent || '';
    check('Militer: judul + REKRUT PASUKAN tampil', pageText.includes('MILITER') && pageText.includes('REKRUT PASUKAN'));
    check('Militer: 3 jenis unit tampil', pageText.includes('Infanteri') && pageText.includes('Drone Perang') && pageText.includes('Kendaraan Berat'), pageText.slice(0, 200));
    check('Militer: perawatan harian dijelaskan', pageText.includes('Perawatan') && pageText.includes('Rupiah per hari'));
    const qtyInput = document.querySelector('#recruit-qty-infantry');
    const recruitBtn = document.querySelector('[data-recruit="infantry"]');
    check('Militer: input jumlah + tombol REKRUT Infanteri ada', !!qtyInput && !!recruitBtn);
    if (qtyInput && recruitBtn) {
      qtyInput.value = '5';
      recruitBtn.click();
      await sleep(1800);
      pageText = document.querySelector('#page')?.textContent || '';
      const milAfter = (await api(jarA, '/api/military', undefined, 'GET')).data;
      check('Militer UI: rekrut 5 Infanteri lewat tombol (server: kekuatan 10)', milAfter.power === 10 && milAfter.count === 5, `power=${milAfter.power} count=${milAfter.count}`);
      check('Militer UI: setelah rekrut tampil "5 unit" + tombol BUBARKAN 1', pageText.includes('5 unit') && !!document.querySelector('[data-disband="infantry"]'), pageText.slice(0, 300));
      const disbandBtn = document.querySelector('[data-disband="infantry"]');
      if (disbandBtn) {
        disbandBtn.click();
        await sleep(1800);
        const milAfter2 = (await api(jarA, '/api/military', undefined, 'GET')).data;
        check('Militer UI: bubarkan 1 lewat tombol (server: kekuatan 8)', milAfter2.power === 8 && milAfter2.count === 4, `power=${milAfter2.power} count=${milAfter2.count}`);
      }
      check('Militer UI: top 5 menampilkan warga_enam', (document.querySelector('#page')?.textContent || '').includes('warga_enam'));
    }

    // --- (3) Detail wilayah: penguasa + demografi ---
    await goto(dom, '#/regions/' + meA.citizen.region_id);
    pageText = document.querySelector('#page')?.textContent || '';
    check('Wilayah: baris "Penguasa wilayah" tampil', pageText.includes('Penguasa wilayah'), pageText.slice(0, 300));
    check('Wilayah: panel DEMOGRAFI tampil', pageText.includes('DEMOGRAFI'), pageText.slice(0, 300));
    check('Wilayah: demografi menampilkan warga + rata-rata level', /Total warga|Rata-rata level/.test(pageText));

    // --- (4) Profil publik: reputasi + kekuatan militer ---
    await goto(dom, '#/profile/warga_enam_dua');
    pageText = document.querySelector('#page')?.textContent || '';
    check('Profil: baris Reputasi Dagang tampil', pageText.includes('Reputasi Dagang'), pageText.slice(0, 300));
    check('Profil: reputasi B "Pedagang Terpercaya" + 50 transaksi', pageText.includes('Pedagang Terpercaya') && pageText.includes('50 transaksi'), pageText.slice(0, 300));
    check('Profil: baris Kekuatan Militer tampil', pageText.includes('Kekuatan Militer'), pageText.slice(0, 300));

    // --- (5) Perusahaan: input_text rantai produksi ---
    await goto(dom, '#/companies');
    pageText = document.querySelector('#page')?.textContent || '';
    check('Perusahaan: kartu jenis menyebut bahan baku (Butuh: 2× Besi Mentah)', pageText.includes('Butuh: 2× Besi Mentah'), pageText.slice(0, 400));
    check('Perusahaan: jenis tanpa input menjelaskan "Tanpa bahan baku"', pageText.includes('Tanpa bahan baku'), pageText.slice(0, 400));

    // --- (6) Pasar: reputasi penjual di kartu penawaran ---
    r = await api(jarA, '/api/market/sell', { scope: 'local', commodity_id: besiId, tier: 1, qty: 10, price: 9 });
    check('Pasar: A pasang penawaran 10× Besi @9 (API)', r.status === 200 && !!r.data.offerId, `status=${r.status}`);
    await goto(dom, '#/market');
    pageText = document.querySelector('#page')?.textContent || '';
    const besiRow = document.querySelector(`[data-com="${besiId}"]`);
    check('Pasar: baris Besi Mentah di papan pasar ada', !!besiRow);
    if (besiRow) {
      besiRow.click();
      await sleep(800);
      const detailText = document.querySelector('#offer-detail')?.textContent || '';
      check('Pasar: kartu penawaran menampilkan ⭐ Pedagang Baru (reputasi A)', detailText.includes('⭐ Pedagang Baru'), detailText.slice(0, 300));
    }
  } catch (e) {
    failed++;
    console.log('  ✗ stage6-dom crash: ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : e));
  } finally {
    if (dom) { try { dom.window.close(); } catch {} }
    stop();
  }
  console.log(`\n[stage6-dom] SELESAI: ${passed} lolos, ${failed} gagal`);
  process.exitCode = failed ? 1 : 0;
}

main();
