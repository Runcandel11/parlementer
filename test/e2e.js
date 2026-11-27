// Parlementer — tes end-to-end (SQLite lokal, DB sekali pakai di /tmp).
// Alur: daftar → login → klaim → latih → lamar kerja → shift → pasar (jual/beli)
// → makan → valas → perjalanan → chat → lapor → aturan (partai level 10, min. penawaran).
// Jalankan: npm test   (atau: node test/e2e.js)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3456;
const DB_PATH = '/tmp/parlementer-e2e.db';
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(a, b, eps = 0.001) { return Math.abs(a - b) < eps; }

class Client {
  constructor() { this.cookie = ''; }
  async req(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = { _raw: text }; }
    return { status: res.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b || {}); }
}

async function main() {
  try { fs.unlinkSync(DB_PATH); } catch {}
  try { fs.unlinkSync(DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(DB_PATH + '-shm'); } catch {}

  console.log('[e2e] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'e2e-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  process.on('exit', stop);

  // Tunggu server siap.
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(500);
    try { const r = await fetch(BASE + '/api/world'); ready = r.ok; } catch {}
  }
  check('Server menyala & /api/world merespons', ready);
  if (!ready) { console.log(serverLog); process.exit(1); }

  const A = new Client();
  const B = new Client();

  console.log('\n[1] Auth — daftar & login (email + password)');
  let r = await A.post('/api/auth/register', { email: 'warga1@test.local', password: 'rahasia123', username: 'warga_satu' });
  check('Daftar warga A berhasil (201)', r.status === 200 && r.data.ok, `status=${r.status}`);
  check('Cookie sesi diterima setelah daftar', !!A.cookie);
  r = await A.post('/api/auth/register', { email: 'warga1@test.local', password: 'rahasia123', username: 'warga_dua' });
  check('Email duplikat ditolak (400)', r.status === 400, r.data.error || '');
  r = await A.post('/api/auth/register', { email: 'bukan-email', password: 'rahasia123', username: 'warga_tiga' });
  check('Format email tidak valid ditolak (400)', r.status === 400);
  r = await A.post('/api/auth/register', { email: 'warga3@test.local', password: 'abc', username: 'warga_tiga' });
  check('Password < 6 karakter ditolak (400)', r.status === 400);
  const A2 = new Client();
  r = await A2.post('/api/auth/login', { email: 'warga1@test.local', password: 'salah123' });
  check('Login password salah ditolak (400)', r.status === 400);
  r = await A2.post('/api/auth/login', { email: 'warga1@test.local', password: 'rahasia123' });
  check('Login email+password berhasil', r.status === 200 && r.data.ok);
  A.cookie = A2.cookie;

  console.log('\n[2] Dashboard warga baru');
  r = await A.get('/api/me');
  const me0 = r.data.citizen;
  check('Level 1, XP 0, energi 100', me0.level === 1 && me0.xp === 0 && me0.energy === 100, `level=${me0.level} xp=${me0.xp} energi=${me0.energy}`);
  check('Paket awal: 50 emas, 500 USD', me0.gold === 50 && me0.usd === 500, `emas=${me0.gold} usd=${me0.usd}`);
  check('Wilayah awal Kepulauan Riau', r.data.region.name === 'Kepulauan Riau');
  check('Populasi dunia = 1 (tanpa bot)', r.data.population === 1, `populasi=${r.data.population}`);
  check('Tidak ada perang aktif', r.data.activeWars.length === 0);
  check('Tidak ada UU sedang divoting', r.data.votingLaws.length === 0);
  r = await A.get('/api/inventory');
  const inv = r.data.items;
  check('Inventaris awal: 3 Makanan, 3 Senjata, 3 Tiket T1',
    inv.length === 3 && inv.every((i) => i.qty === 3 && i.tier === 1),
    inv.map((i) => `${i.name}×${i.qty}`).join(', '));

  console.log('\n[3] Klaim pasokan harian');
  r = await A.post('/api/claim');
  check('Klaim berhasil: +5 emas, +50 USD, +2 XP', r.status === 200 && r.data.reward.gold === 5 && r.data.reward.usd === 50 && r.data.reward.xp === 2);
  r = await A.post('/api/claim');
  check('Klaim kedua di hari yang sama ditolak', r.status === 400);
  r = await A.get('/api/me');
  check('Saldo setelah klaim: 55 emas, 550 USD, XP 2', r.data.citizen.gold === 55 && r.data.citizen.usd === 550 && r.data.citizen.xp === 2);

  console.log('\n[4] Latihan atribut');
  r = await A.post('/api/train', { attr: 'str' });
  check('Latih Kekuatan berhasil (biaya 1 emas)', r.status === 200 && r.data.cost === 1 && r.data.level === 1);
  r = await A.get('/api/me');
  check('Emas 54, Kekuatan 1, XP 3', r.data.citizen.gold === 54 && r.data.citizen.attr_str === 1 && r.data.citizen.xp === 3);

  console.log('\n[5] Pekerjaan ADMIN & shift');
  r = await A.get('/api/jobs');
  const adminJobs = r.data.jobs.filter((j) => j.is_admin === 1);
  check('Ada 6 lowongan ADMIN', adminJobs.length === 6, `ditemukan ${adminJobs.length}`);
  check('Gaji terbaik ADMIN 48 USD', r.data.stats.best === 48, `best=${r.data.stats.best}`);
  const job = adminJobs.find((j) => j.title === 'Pekerja Gudang Pelabuhan');
  check('Lowongan "Pekerja Gudang Pelabuhan" ada (48 USD, Kepulauan Riau)', !!job && job.salary === 48);
  r = await A.post('/api/jobs/apply', { job_id: job.id });
  check('Lamar pekerjaan berhasil', r.status === 200 && r.data.ok);
  r = await A.post('/api/jobs/shift');
  check('Shift selesai: bruto 48, bersih 47,04 (pajak 2%)', r.status === 200 && r.data.gross === 48 && eq(r.data.net, 47.04), `gross=${r.data.gross} net=${r.data.net}`);
  r = await A.get('/api/me');
  check('Energi 0 setelah shift, USD 597,04', r.data.citizen.energy === 0 && eq(r.data.citizen.usd, 597.04), `energi=${r.data.citizen.energy} usd=${r.data.citizen.usd}`);

  console.log('\n[6] Pasar — mulai kosong (tanpa bot)');
  r = await A.get('/api/market?scope=local');
  check('Pasar lokal: 0 penawaran', r.data.stats.offers === 0, `offers=${r.data.stats.offers}`);
  check('15 komoditas terdaftar', r.data.commodities.length === 15);
  r = await A.get('/api/market?scope=global');
  check('Pasar Global: 0 penawaran', r.data.stats.offers === 0);
  const makanan = r.data.commodities.find((c) => c.name === 'Makanan');

  console.log('\n[7] Pasar — aturan & transaksi jual/beli');
  r = await A.post('/api/market/sell', { scope: 'local', commodity_id: makanan.id, tier: 1, qty: 3, price: 9 });
  check('Jual < 10 unit ditolak (minimum penawaran)', r.status === 400, r.data.error || '');
  // Daftarkan penjual B, beri stok lewat DB tes (setup tes, bukan jalur produksi).
  r = await B.post('/api/auth/register', { email: 'warga2@test.local', password: 'rahasia123', username: 'warga_dua' });
  check('Daftar warga B berhasil', r.status === 200);
  const meB = await B.get('/api/auth/me');
  const db = new DatabaseSync(DB_PATH);
  const comRow = db.prepare('SELECT id FROM commodities WHERE name = ?').get('Makanan');
  db.prepare('UPDATE inventory SET qty = qty + 17 WHERE citizen_id = ? AND commodity_id = ? AND tier = 1').run(meB.data.citizen.id, comRow.id);
  db.close();
  r = await B.post('/api/market/sell', { scope: 'local', commodity_id: makanan.id, tier: 1, qty: 10, price: 9 });
  check('B memasang penawaran jual 10× Makanan @ 9 USD', r.status === 200 && !!r.data.offerId, `offerId=${r.data.offerId}`);
  const offerId = r.data.offerId;
  r = await A.get('/api/market?scope=local');
  check('Pasar lokal kini 1 penawaran', r.data.stats.offers === 1);
  r = await A.post('/api/market/buy', { offer_id: offerId, qty: 5 });
  check('A membeli 5 unit: bayar 45 USD', r.status === 200 && eq(r.data.total, 45), `total=${r.data.total}`);
  check('Penjual terima 44,10 USD (setelah pajak 2%)', eq(r.data.sellerReceives, 44.1), `diterima=${r.data.sellerReceives}`);
  r = await A.get('/api/me');
  check('Saldo A: 552,04 USD', eq(r.data.citizen.usd, 552.04), `usd=${r.data.citizen.usd}`);
  r = await B.get('/api/me');
  check('Saldo B: 544,10 USD', eq(r.data.citizen.usd, 544.1), `usd=${r.data.citizen.usd}`);
  r = await A.get('/api/market?scope=local');
  check('Sisa penawaran B: 5 unit', r.data.offers.length === 1 && r.data.offers[0].qty === 5);
  r = await B.post('/api/market/cancel', { offer_id: offerId });
  check('B membatalkan penawaran, stok kembali', r.status === 200);
  r = await A.get('/api/market?scope=local');
  check('Pasar kembali 0 penawaran', r.data.stats.offers === 0);

  console.log('\n[8] Makan roti & Valas');
  r = await A.post('/api/eat', { tier: 1 });
  check('Makan 1 Makanan T1: energi 0 → 10', r.status === 200 && r.data.energy === 10, `energi=${r.data.energy}`);
  r = await A.get('/api/fx');
  check('Valas: kurs cetak 1 emas = 10 USD, 0 penawaran warga', r.data.mint === 10 && r.data.sellCount === 0 && r.data.buyCount === 0);
  r = await A.post('/api/fx/mint', { gold: 1 });
  check('Cetak 1 emas → +10 USD', r.status === 200 && r.data.usd === 10);
  r = await A.get('/api/me');
  check('Emas 53, USD 562,04', r.data.citizen.gold === 53 && eq(r.data.citizen.usd, 562.04), `emas=${r.data.citizen.gold} usd=${r.data.citizen.usd}`);

  console.log('\n[9] Peta & perjalanan');
  r = await A.get('/api/regions');
  check('17 wilayah terdaftar', r.data.regions.length === 17, `jumlah=${r.data.regions.length}`);
  const jakarta = r.data.regions.find((x) => x.name === 'Jakarta');
  r = await A.post('/api/regions/travel', { region_id: jakarta.id });
  check('Perjalanan ke Jakarta berhasil (1 Tiket)', r.status === 200 && r.data.region === 'Jakarta');
  r = await A.get('/api/me');
  check('Lokasi kini Jakarta', r.data.region.name === 'Jakarta');
  r = await A.get('/api/inventory');
  const tiket = r.data.items.find((i) => i.name === 'Tiket');
  check('Sisa Tiket T1: 2', tiket && tiket.qty === 2, `tiket=${tiket?.qty}`);

  console.log('\n[10] Obrolan Global & laporan');
  r = await A.get('/api/chat/global');
  check('Obrolan Global mulai kosong', r.data.messages.length === 0);
  r = await A.post('/api/chat/global', { content: 'Halo dunia Parlementer ini tes' });
  check('A mengirim pesan global', r.status === 200 && !!r.data.messageId, `messageId=${r.data.messageId}`);
  const msgId = r.data.messageId;
  await sleep(6000); // anti-spam chat 5 detik
  r = await B.get('/api/chat/global');
  check('B membaca 1 pesan dari A', r.data.messages.length === 1 && r.data.messages[0].content === 'Halo dunia Parlementer ini tes');
  check('Pesan membawa nama pengguna warga_satu', r.data.messages[0].username === 'warga_satu');
  r = await B.post('/api/chat/global', { content: 'Selamat datang di Parlementer kawan' });
  check('B membalas pesan global', r.status === 200);
  await sleep(6000);
  r = await A.get('/api/chat/global');
  check('A membaca 2 pesan', r.data.messages.length === 2);
  const bMsg = r.data.messages.find((m) => m.username === 'warga_dua');
  r = await A.post('/api/chat/report', { message_id: bMsg.id, reason: 'Spam', details: 'tes laporan' });
  check('A melaporkan pesan B (alasan Spam)', r.status === 200 && r.data.ok);
  r = await A.post('/api/chat/block', { citizen_id: meB.data.citizen.id });
  check('A memblokir B', r.status === 200 && r.data.ok);
  r = await A.get('/api/chat/global');
  check('Setelah diblokir, A tidak lagi melihat pesan B', r.data.messages.every((m) => m.username !== 'warga_dua'));
  r = await A.post('/api/chat/unblock', { citizen_id: meB.data.citizen.id });
  check('A membuka blokir B', r.status === 200);

  console.log('\n[11] Aturan dunia: partai, perang, pers, toko');
  r = await A.post('/api/parties', { name: 'Partai Tes', tag: 'TES', ideology: 'Progresif', type: 'open' });
  check('Dirikan partai di Level 1 ditolak (butuh Level 10)', r.status === 400, r.data.error || '');
  r = await A.get('/api/parties');
  check('0 partai di dunia', r.data.parties.length === 0);
  r = await A.get('/api/wars');
  check('0 perang di dunia', r.data.wars.length === 0);
  r = await A.get('/api/press/stats');
  check('Pers: 0 artikel, 0 koran, 0 jurnalis', r.data.articles7d === 0 && r.data.newspapers === 0, JSON.stringify(r.data));
  r = await A.get('/api/shop');
  check('Toko: Premium 1 bln Rp5.000', r.data.premium?.[0]?.price === 5000 && r.data.premium[0].months === 1, JSON.stringify(r.data.premium?.[0]));
  check('Toko: Paket Ultimate Rp100.000', r.data.packages?.find((p) => p.name.toUpperCase().includes('ULTIMATE'))?.price === 100000);
  check('Semua top-up mengarah ke WhatsApp Khalid', r.data.waUrl === 'https://wa.me/6285220743283', r.data.waUrl || '');
  r = await A.get('/api/elections');
  check('Pemilu terdaftar (dijadwalkan otomatis)', Array.isArray(r.data.elections));
  r = await A.get('/api/country');
  check('Negara: Republik Indonesia', r.data.country?.name === 'Republik Indonesia' || r.data.name === 'Republik Indonesia');

  console.log('\n[12] Daily tick — dunia maju 1 hari');
  // A masih login, energi 10 setelah makan. Mundurkan tanggal tick ke kemarin lewat DB tes.
  const dbTick = new DatabaseSync(DB_PATH);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  dbTick.prepare('UPDATE world SET last_tick_date = ? WHERE id = 1').run(yesterday);
  dbTick.close();
  await A.get('/api/me'); // request ini memicu maybeTick (async, tanpa await di middleware)
  await sleep(1500); // beri waktu tick selesai
  r = await A.get('/api/world');
  check('Tick berjalan: hari dunia 1 → 2', r.data.day === 2, `day=${r.data.day}`);
  r = await A.get('/api/me');
  check('Energi pulih ke 100 setelah tick', r.data.citizen.energy === 100, `energi=${r.data.citizen.energy}`);
  check('Populasi tetap 2 (A + B)', r.data.population === 2);

  console.log('\n[13] Frontend & logout');
  const html = await fetch(BASE + '/').then((x) => x.text());
  check('Halaman utama memuat (judul Parlementer)', html.includes('Parlementer'));
  check('Halaman login ada (form MASUK/DAFTAR)', html.includes('MASUK') && html.includes('DAFTAR'));
  r = await A.post('/api/auth/logout');
  check('Logout berhasil', r.status === 200);
  r = await A.get('/api/auth/me');
  check('Setelah logout, /api/auth/me ditolak (401)', r.status === 401);

  stop();
  console.log(`\n[e2e] SELESAI: ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[e2e] ERROR:', e); process.exit(1); });
