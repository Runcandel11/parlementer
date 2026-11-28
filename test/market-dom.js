// Parlementer — tes DOM pasar (jsdom + server sungguhan).
// Laporan pemain LIO (PL-000026): di pasar tidak terlihat berapa banyak
// tiap komoditas yang dimiliki pemain. Tes ini membuktikan angka "Milikmu"
// tampil di pasar lokal + global dan sesuai isi inventaris:
//   (1) papan pasar: total milik per komoditas (semua tier);
//   (2) kartu penawaran: milik per tier;
//   (3) baris order beli: milik per tier;
//   (4) form jual: label dropdown + baris dinamis per tier;
//   (5) stok 0 tetap tampil sebagai "Milikmu: 0" (tidak disembunyikan).
// Jalankan: node test/market-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
import { DatabaseSync } from 'node:sqlite';
import { testPort, testDbPath } from './test-env.js';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = testPort(3460);
const DB_PATH = testDbPath('/tmp/parlementer-market-dom.db');
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// Cookie jar: node fetch tidak menyimpan cookie sendiri — simpan set-cookie
// dari register dan kirim lagi, supaya boot() di jsdom login.
let cookie = '';
async function jarFetch(url, opts = {}) {
  const full = typeof url === 'string' && url.startsWith('/') ? BASE + url : url;
  const res = await fetch(full, {
    ...opts,
    headers: { ...(opts.headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return res;
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[market-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'market-dom-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;

  try {
    let up = false;
    // Tunggu server siap: 120x250ms = 30 detik (start bisa lambat saat 2 full suite paralel di 1,5 CPU — v5.7.4).
    for (let i = 0; i < 120 && !up; i++) {
      try { const r = await fetch(BASE + '/'); up = r.status === 200; } catch { await sleep(250); }
    }
    check('server menyala dan halaman utama 200', up);
    if (!up) { console.log('[market-dom] server tidak menyala'); process.exitCode = 1; return; }

    const reg = await jarFetch(BASE + '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'marketdom@test.local', password: 'rahasia123', username: 'market_dom' }),
    });
    check('daftar warga tes berhasil', reg.status === 200 && !!cookie, `status=${reg.status}`);
    const me = await (await jarFetch(BASE + '/api/me')).json();
    const citizenId = me.citizen.id;
    check('warga tes punya citizen id', !!citizenId, `citizen=${citizenId}`);

    // Seed inventaris langsung di DB: 100 Gandum Mentah T1 + 5 T2.
    // (Besi Mentah sengaja 0 — untuk membuktikan "Milikmu: 0" tampil.)
    const db = new DatabaseSync(DB_PATH);
    const gandumId = db.prepare("SELECT id FROM commodities WHERE name = 'Gandum Mentah'").get().id;
    const besiId = db.prepare("SELECT id FROM commodities WHERE name = 'Besi Mentah'").get().id;
    const insInv = db.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,?,?)');
    insInv.run(citizenId, gandumId, 1, 100);
    insInv.run(citizenId, gandumId, 2, 5);
    // Satu penawaran Gandum T1 + satu order beli Gandum T2 (milik warga tes
    // sendiri — cukup untuk membuktikan tampilannya di baris/kartu).
    const now = Date.now();
    db.prepare('INSERT INTO market_offers (seller_id, scope, commodity_id, tier, qty, price, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(citizenId, 'local', gandumId, 1, 10, 9, now);
    db.prepare('INSERT INTO market_buy_orders (buyer_id, scope, commodity_id, tier, qty, qty_filled, price, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(citizenId, 'local', gandumId, 2, 10, 0, 9, now);
    db.close();

    // /api/inventory mengembalikan stok yang di-seed (sanity check API).
    const inv = await (await jarFetch(BASE + '/api/inventory')).json();
    const gT1 = inv.items.find((i) => i.commodity_id === gandumId && i.tier === 1)?.qty;
    const gT2 = inv.items.find((i) => i.commodity_id === gandumId && i.tier === 2)?.qty;
    check('API inventaris mengembalikan 100 Gandum T1 + 5 T2', gT1 === 100 && gT2 === 5, `T1=${gT1} T2=${gT2}`);

    const html = await (await fetch(BASE + '/')).text();
    const htmlNoFonts = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>\s*/g, '')
      .replace(/<link[^>]*fonts\.gstatic\.com[^>]*>\s*/g, '');
    dom = new JSDOM(htmlNoFonts, {
      url: BASE + '/',
 // agar fetch relatif & script/style lokal dimuat dari server
      resources: 'usable',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window) { window.fetch = jarFetch; },
    });
    const { window } = dom;
    const { document } = window;
    await new Promise((resolve) => {
      if (document.readyState === 'complete') resolve();
      else window.addEventListener('load', resolve);
      setTimeout(resolve, 5000);
    });
    await sleep(800);

    check('aplikasi tampil setelah boot (login lewat cookie)', document.querySelector('#app').hidden === false);

    // --- PASAR LOKAL ---
    window.location.hash = '#/market';
    window.route();
    await sleep(900);
    const boardText = document.querySelector('.board')?.textContent || '';
    // Baris papan: nama komoditas + "Milikmu: total semua tier".
    const gandumRow = [...document.querySelectorAll('.board-row')].find((r) => r.textContent.includes('Gandum Mentah'));
    const besiRow = [...document.querySelectorAll('.board-row')].find((r) => r.textContent.includes('Besi Mentah'));
    check('papan pasar tampil', !!gandumRow && !!besiRow, `baris=${document.querySelectorAll('.board-row').length}`);
    check('papan: Gandum Mentah menunjukkan Milikmu: 105 (100 T1 + 5 T2)', gandumRow?.textContent.includes('Milikmu: 105'), gandumRow?.textContent.trim().slice(0, 60));
    check('papan: Besi Mentah menunjukkan Milikmu: 0 (stok kosong tetap tampil)', besiRow?.textContent.includes('Milikmu: 0'), besiRow?.textContent.trim().slice(0, 60));
    void boardText;

    // --- (6) v5.7.3 — Kronik 'market': membuka #/market memanggil visit ---
    // (pola yang sama seperti 'map' di ROUTES.map). Panggilan klien
    // fire-and-forget — setelah render + 900 ms, barisnya harus ada di DB.
    {
      const dbM = new DatabaseSync(DB_PATH);
      const mk = dbM.prepare("SELECT 1 AS x FROM chronicle_done WHERE citizen_id = ? AND ckey = 'market'").get(citizenId);
      dbM.close();
      check("Kronik: membuka #/market menandai tugas 'market' selesai (visit klien)", !!mk, mk ? 'tertandai' : 'tidak ada baris');
    }

    // Form jual: label dropdown berisi total milik + baris dinamis per tier.
    const sellOpt = [...document.querySelectorAll('#sell-com option')].find((o) => o.textContent.includes('Gandum Mentah'));
    check('dropdown jual: opsi Gandum berisi Milikmu: 105', sellOpt?.textContent.includes('Milikmu: 105'), sellOpt?.textContent);
    const sellCom = document.querySelector('#sell-com');
    const sellTier = document.querySelector('#sell-tier');
    const sellOwn = () => document.querySelector('#sell-own')?.textContent || '';
    sellCom.value = String(gandumId);
    sellCom.dispatchEvent(new window.Event('change', { bubbles: true }));
    sellTier.value = '1';
    sellTier.dispatchEvent(new window.Event('change', { bubbles: true }));
    check('form jual: Gandum T1 menunjukkan Milikmu: 100', sellOwn().includes('Milikmu: 100'), sellOwn());
    sellTier.value = '2';
    sellTier.dispatchEvent(new window.Event('change', { bubbles: true }));
    check('form jual: ganti tier ke T2 menunjukkan Milikmu: 5', sellOwn().includes('Milikmu: 5'), sellOwn());

    // Order beli (sell-to-order): baris order Gandum T2 menunjukkan milik T2.
    const buyOrderText = document.body.textContent;
    check('order beli: baris order Gandum T2 menunjukkan Milikmu: 5', /Gandum Mentah T2[\s\S]{0,200}Milikmu: 5/.test(buyOrderText));

    // Kartu penawaran: klik baris Gandum → kartu T1 menunjukkan Milikmu: 100.
    gandumRow.click();
    await sleep(500);
    const detail = document.querySelector('#offer-detail')?.textContent || '';
    check('kartu penawaran: Gandum T1 menunjukkan Milikmu: 100', detail.includes('Milikmu: 100'), detail.slice(0, 120));

    // --- PASAR GLOBAL: stok milik yang sama tampil juga di sana ---
    window.location.hash = '#/global';
    window.route();
    await sleep(900);
    const gandumRowG = [...document.querySelectorAll('.board-row')].find((r) => r.textContent.includes('Gandum Mentah'));
    check('pasar global: Gandum Mentah menunjukkan Milikmu: 105', gandumRowG?.textContent.includes('Milikmu: 105'), gandumRowG?.textContent.trim().slice(0, 60));
  } finally {
    stop();
    if (dom) dom.window.close();
  }

  console.log(`[market-dom] ${passed} lolos, ${failed} gagal`);
  if (failed) process.exitCode = 1;
}

main();
