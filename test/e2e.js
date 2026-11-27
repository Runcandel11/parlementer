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
  let server = null;
  let serverLog = '';
  async function startServer() {
    server = spawn('node', ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'e2e-test-secret' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (d) => { serverLog += d; });
    server.stderr.on('data', (d) => { serverLog += d; });
    // Tunggu server siap.
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      await sleep(500);
      try { const r = await fetch(BASE + '/api/world'); ready = r.ok; } catch {}
    }
    return ready;
  }
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  process.on('exit', stop);

  const ready = await startServer();
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

  console.log('\n[5] Pekerjaan ADMIN (dibayar bahan mentah) & shift');
  r = await A.get('/api/jobs');
  const adminJobs = r.data.jobs.filter((j) => j.is_admin === 1);
  check('Ada 6 lowongan ADMIN', adminJobs.length === 6, `ditemukan ${adminJobs.length}`);
  check('Semua lowongan ADMIN dibayar bahan mentah (bukan USD)',
    adminJobs.every((j) => j.salary_type === 'goods' && j.resource && j.pay_qty > 0),
    adminJobs.map((j) => `${j.title}:${j.resource}×${j.pay_qty}`).join(', '));
  check('Nilai setara terbaik ADMIN 48 USD', r.data.stats.best === 48, `best=${r.data.stats.best}`);
  const job = adminJobs.find((j) => j.title === 'Pekerja Gudang Pelabuhan');
  check('Lowongan "Pekerja Gudang Pelabuhan" ada (44× Besi Mentah, Kepulauan Riau)', !!job && job.resource === 'Besi Mentah' && job.pay_qty === 44);
  r = await A.post('/api/jobs/apply', { job_id: job.id });
  check('Lamar pekerjaan berhasil', r.status === 200 && r.data.ok);
  r = await A.post('/api/jobs/shift');
  check('Shift selesai: dibayar 44× Besi Mentah (setara ~48,40 USD)', r.status === 200 && r.data.goods === '44× Besi Mentah', `goods=${r.data.goods}`);
  r = await A.get('/api/me');
  check('Energi 0 setelah shift, USD tetap 550 (tanpa gaji uang)', r.data.citizen.energy === 0 && eq(r.data.citizen.usd, 550), `energi=${r.data.citizen.energy} usd=${r.data.citizen.usd}`);
  r = await A.get('/api/inventory');
  const besi = r.data.items.find((i) => i.name === 'Besi Mentah');
  check('Inventaris: 44× Besi Mentah T1 dari shift', besi && besi.qty === 44 && besi.tier === 1, `besi=${besi?.qty}`);

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
  check('Saldo A: 505 USD (550 − 45)', eq(r.data.citizen.usd, 505), `usd=${r.data.citizen.usd}`);
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
  check('Emas 53, USD 515', r.data.citizen.gold === 53 && eq(r.data.citizen.usd, 515), `emas=${r.data.citizen.gold} usd=${r.data.citizen.usd}`);

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

  console.log('\n[14] Referral kode unik, akun admin, ID pemain, ban');
  const R = new Client();
  const N = new Client();
  const X = new Client();
  const Y = new Client();
  const ADM = new Client();

  r = await R.post('/api/auth/register', { email: 'ref1@test.local', password: 'rahasia123', username: 'referrer_satu' });
  check('Referrer mendaftar', r.status === 200 && r.data.ok);
  r = await R.get('/api/me');
  const refCode = r.data.referral?.code;
  check('Kode referral 8 karakter tanpa ambiguitas (tanpa 0/O/1/I/l/L)', typeof refCode === 'string' && /^[A-HJKMNP-Z2-9]{8}$/.test(refCode), `kode=${refCode}`);
  check('Referral awal: 0 pemakai, 0 emas', r.data.referral.uses === 0 && r.data.referral.goldEarned === 0);
  check('ID publik referrer PL-000003', r.data.user.publicId === 'PL-000003', r.data.user.publicId || '');

  r = await N.post('/api/auth/register', { email: 'ref2@test.local', password: 'rahasia123', username: 'pendaftar_satu', ref: refCode });
  check('Pendaftar dengan kode referral berhasil', r.status === 200 && r.data.ok);
  r = await N.get('/api/me');
  const nowMs = Date.now();
  check('Pendaftar baru: 100 emas (50 awal + 50 bonus)', r.data.citizen.gold === 100, `emas=${r.data.citizen.gold}`);
  check('Pendaftar baru: premium aktif 1 hari', r.data.citizen.isPremium && r.data.citizen.premium_until > nowMs && r.data.citizen.premium_until <= nowMs + 86400000 + 60000, `until=${r.data.citizen.premium_until}`);
  r = await R.get('/api/me');
  check('Referrer: 150 emas (50 + 100 bonus)', r.data.citizen.gold === 150, `emas=${r.data.citizen.gold}`);
  check('Referrer: premium aktif ~2 hari', r.data.citizen.isPremium && r.data.citizen.premium_until > nowMs + 86400000 && r.data.citizen.premium_until <= nowMs + 2 * 86400000 + 60000);
  check('Referrer: 1 pemakai kode, +100 emas referral', r.data.referral.uses === 1 && r.data.referral.goldEarned === 100);

  r = await X.post('/api/auth/register', { email: 'ref3@test.local', password: 'rahasia123', username: 'pendaftar_dua', ref: refCode.toLowerCase() });
  check('Kode referral huruf kecil tetap berlaku', r.status === 200 && r.data.ok);
  r = await X.get('/api/me');
  check('Pendaftar kedua: 100 emas + premium 1 hari', r.data.citizen.gold === 100 && r.data.citizen.isPremium);
  r = await R.get('/api/me');
  check('Referrer: 2 pemakai kode, +200 emas referral', r.data.referral.uses === 2 && r.data.referral.goldEarned === 200);

  r = await Y.post('/api/auth/register', { email: 'ref4@test.local', password: 'rahasia123', username: 'pendaftar_tiga', ref: 'ZZZZZZZZ' });
  check('Kode referral tidak valid: registrasi tetap jalan', r.status === 200 && r.data.ok);
  r = await Y.get('/api/me');
  check('Tanpa kode valid: 50 emas, tanpa premium', r.data.citizen.gold === 50 && !r.data.citizen.isPremium);
  r = await R.get('/api/me');
  check('Referrer tetap 2 pemakai kode', r.data.referral.uses === 2);

  r = await ADM.post('/api/auth/register', { email: 'koboijuniorkhalid@gmail.com', password: 'rahasia123', username: 'khalid_admin' });
  check('Admin mendaftar dengan email khusus', r.status === 200 && r.data.ok);
  r = await ADM.get('/api/me');
  check('Akun email khusus otomatis jadi admin', r.data.user.is_admin === true);
  check('ID publik admin PL-000007', r.data.user.publicId === 'PL-000007', r.data.user.publicId || '');
  r = await B.get('/api/me');
  check('Warga biasa bukan admin', r.data.user.is_admin === false);
  check('ID publik B PL-000002', r.data.user.publicId === 'PL-000002');

  r = await B.get('/api/admin/players');
  check('Non-admin: GET /api/admin/players ditolak 403', r.status === 403);
  r = await B.post('/api/admin/gold', { user_id: 1, amount: 10 });
  check('Non-admin: POST /api/admin/gold ditolak 403', r.status === 403);
  r = await B.post('/api/admin/ban', { user_id: 1, reason: 'tes' });
  check('Non-admin: POST /api/admin/ban ditolak 403', r.status === 403);

  r = await ADM.get('/api/admin/players');
  check('Admin: daftar pemain tampil (7 pemain)', r.status === 200 && r.data.players.length === 7, `jumlah=${r.data.players?.length}`);
  check('Daftar pemain menampilkan ID publik PL-000002', r.data.players.some((p) => p.publicId === 'PL-000002' && p.username === 'warga_dua'));
  r = await ADM.post('/api/admin/gold', { user_id: 2, amount: 25 });
  check('Admin: beri +25 emas ke B', r.status === 200 && r.data.ok);
  r = await B.get('/api/me');
  check('Emas B: 50 → 75', r.data.citizen.gold === 75, `emas=${r.data.citizen.gold}`);
  r = await ADM.post('/api/admin/premium', { user_id: 2, months: 3 });
  check('Admin: beri Premium 3 bulan ke B', r.status === 200 && r.data.ok);
  r = await B.get('/api/me');
  check('Premium B aktif ~90 hari', r.data.citizen.isPremium && r.data.citizen.premium_until > Date.now() + 89 * 86400000);
  r = await ADM.post('/api/admin/energy', { user_id: 2 });
  check('Admin: isi energi B sampai penuh (120, premium)', r.status === 200 && r.data.energy === 120);
  r = await B.get('/api/me');
  check('Energi B kini 120', r.data.citizen.energy === 120);
  r = await ADM.post('/api/admin/item', { user_id: 2, commodity: 'Tiket', tier: 1, qty: 5 });
  check('Admin: beri 5× Tiket T1 ke B', r.status === 200 && r.data.ok);
  r = await B.get('/api/inventory');
  const tiketB = r.data.items.find((i) => i.name === 'Tiket');
  check('Tiket T1 B: 3 → 8', tiketB && tiketB.qty === 8, `tiket=${tiketB?.qty}`);
  r = await ADM.get('/api/admin/actions');
  const acts = r.data.actions.map((a) => a.action);
  check('Log admin mencatat grant emas/premium/energi/barang', ['gold', 'premium', 'energy', 'item'].every((a) => acts.includes(a)), acts.join(','));

  r = await ADM.post('/api/admin/ban', { user_id: 2 });
  check('Ban tanpa alasan ditolak (400)', r.status === 400);
  r = await ADM.post('/api/admin/ban', { user_id: 7, reason: 'tes' });
  check('Admin tidak bisa membanned akun admin', r.status === 400);
  r = await ADM.post('/api/admin/ban', { user_id: 2, reason: 'Tes banned' });
  check('Admin: ban B dengan alasan', r.status === 200 && r.data.ok);
  const B2 = new Client();
  r = await B2.post('/api/auth/login', { email: 'warga2@test.local', password: 'rahasia123' });
  check('Login akun banned: sesi masuk tapi ditandai banned (agar bisa banding)', r.status === 200 && r.data.banned === true && (r.data.banned_reason || '').includes('Tes banned'), `status=${r.status} banned=${r.data.banned}`);
  r = await B.get('/api/me');
  check('/api/me mengembalikan status banned', r.data.user.is_banned === true && r.data.user.banned_reason === 'Tes banned');
  r = await B2.post('/api/claim');
  check('Akun banned tidak bisa klaim pasokan (403)', r.status === 403, r.data.error || '');
  r = await B2.post('/api/chat/global', { content: 'Saya dibanned tes' });
  check('Akun banned tidak bisa chat (403)', r.status === 403, r.data.error || '');
  r = await B2.post('/api/auth/login', { email: 'warga2@test.local', password: 'salah123' });
  check('Login akun banned dengan password salah tetap ditolak (400)', r.status === 400);
  r = await ADM.post('/api/admin/unban', { user_id: 2 });
  check('Admin: unban B', r.status === 200 && r.data.ok);
  r = await B2.post('/api/auth/login', { email: 'warga2@test.local', password: 'rahasia123' });
  check('Login B pulih setelah unban', r.status === 200 && r.data.ok);
  r = await ADM.get('/api/admin/actions');
  check('Log admin mencatat ban + unban', r.data.actions.some((a) => a.action === 'ban') && r.data.actions.some((a) => a.action === 'unban'));

  r = await R.get('/api/profile/referrer_satu');
  check('Profil menampilkan ID publik PL-000003', r.data.profile.publicId === 'PL-000003');
  check('Profil sendiri: kode + 2 pemakai + 200 emas referral', r.data.profile.referral && r.data.profile.referral.uses === 2 && r.data.profile.referral.goldEarned === 200 && r.data.profile.referral.code === refCode);
  r = await B.get('/api/profile/referrer_satu');
  check('Profil orang lain: statistik referral tidak ditampilkan', r.data.profile.referral === null);
  const html2 = await fetch(BASE + '/').then((x) => x.text());
  check('Form daftar punya field Kode Referral', html2.includes('KODE REFERAL'));

  console.log('\n[15] Sistem banding (appeal) + pengaman admin');
  r = await ADM.post('/api/admin/ban', { user_id: 2, reason: 'Cheat terdeteksi' });
  check('Admin: ban B lagi (alasan Cheat terdeteksi)', r.status === 200 && r.data.ok);
  const B3 = new Client();
  r = await B3.post('/api/auth/login', { email: 'warga2@test.local', password: 'rahasia123' });
  check('B banned bisa login (sesi banding)', r.status === 200 && r.data.banned === true);
  r = await B3.post('/api/appeals', { text: 'pendek' });
  check('Banding < 10 karakter ditolak (400)', r.status === 400);
  r = await B3.post('/api/appeals', { text: 'Saya tidak memakai cheat, tolong tinjau kembali akun saya.' });
  check('B mengajukan banding', r.status === 200 && !!r.data.appealId, `appealId=${r.data.appealId}`);
  const appealId = r.data.appealId;
  r = await B3.post('/api/appeals', { text: 'Banding kedua padahal masih menunggu.' });
  check('Banding kedua saat masih aktif ditolak (400)', r.status === 400);
  r = await B3.get('/api/appeals/mine');
  check('B melihat 1 banding menunggu + thread berisi pesannya', r.data.appeals.length === 1 && r.data.appeals[0].status === 'menunggu' && r.data.appeals[0].messages.length === 1, `n=${r.data.appeals?.length}`);
  r = await R.get('/api/appeals/' + appealId);
  check('Pemain lain tidak bisa melihat banding orang lain (403)', r.status === 403);
  r = await B3.post('/api/appeals/' + appealId + '/message', { text: 'Tambahan bukti: saya main sendiri.' });
  check('B membalas di thread bandingnya', r.status === 200 && r.data.ok);
  r = await ADM.get('/api/admin/appeals');
  check('Admin melihat daftar banding (1, menunggu)', r.status === 200 && r.data.appeals.length === 1 && r.data.appeals[0].status === 'menunggu', `n=${r.data.appeals?.length}`);
  r = await ADM.post('/api/admin/appeals/' + appealId + '/message', { text: 'Kami tinjau dulu ya.' });
  check('Admin membalas banding', r.status === 200 && r.data.ok);
  r = await B3.get('/api/appeals/mine');
  check('Thread kini 3 pesan (banding + balasan B + balasan admin)', r.data.appeals[0].messages.length === 3, `n=${r.data.appeals[0].messages?.length}`);
  r = await R.post('/api/admin/appeals/' + appealId + '/message', { text: 'bukan admin' });
  check('Non-admin tidak bisa membalas banding (403)', r.status === 403);
  r = await ADM.post('/api/admin/appeals/' + appealId + '/decide', { decision: 'reject' });
  check('Admin menolak banding', r.status === 200 && r.data.status === 'ditolak');
  r = await B3.post('/api/appeals/' + appealId + '/message', { text: 'balasan setelah ditolak' });
  check('Balasan setelah banding diputuskan ditolak (400)', r.status === 400);
  r = await B3.post('/api/appeals', { text: 'Saya ajukan banding baru dengan bukti lengkap.' });
  check('Setelah ditolak, pemain bisa banding lagi', r.status === 200 && !!r.data.appealId);
  const appealId2 = r.data.appealId;
  r = await ADM.post('/api/admin/appeals/' + appealId2 + '/decide', { decision: 'accept' });
  check('Admin menerima banding kedua → ban dicabut', r.status === 200 && r.data.status === 'diterima');
  r = await B3.get('/api/me');
  check('B tidak lagi banned setelah banding diterima', r.data.user.is_banned === false);
  const B4 = new Client();
  r = await B4.post('/api/auth/login', { email: 'warga2@test.local', password: 'rahasia123' });
  check('B bisa login normal lagi setelah unban', r.status === 200 && r.data.ok && !r.data.banned);
  r = await B4.post('/api/claim');
  check('B bisa klaim pasokan lagi setelah unban', r.status === 200 && r.data.ok);

  // Pengaman admin: tandai admin banned langsung di DB, restart server
  // (initDb jalan di boot) — migrasi harus mencabut ban admin itu.
  const dbBan = new DatabaseSync(DB_PATH);
  dbBan.prepare('UPDATE users SET is_banned = 1, banned_reason = ? WHERE id = ?').run('tes migrasi', 7);
  dbBan.close();
  stop();
  await sleep(500);
  const upAgain = await startServer();
  check('Server restart setelah migrasi ban admin', upAgain);
  r = await ADM.get('/api/me');
  check('Migrasi mencabut ban akun admin (is_banned=false)', r.data.user.is_banned === false, `is_banned=${r.data.user?.is_banned}`);
  r = await ADM.post('/api/admin/ban', { user_id: 7, reason: 'coba ban admin' });
  check('Endpoint ban tetap menolak admin (400)', r.status === 400);

  console.log('\n[16] Foto profil (avatar)');
  // A logout di [13], jadi login lagi dulu.
  r = await A.post('/api/auth/login', { email: 'warga1@test.local', password: 'rahasia123' });
  check('A login lagi setelah logout di [13]', r.status === 200 && r.data.ok);
  const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwH/2Q==';
  r = await A.post('/api/profile/avatar', { avatar: TINY_JPEG });
  check('Upload avatar JPEG kecil berhasil', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  r = await A.get('/api/profile/warga_satu');
  check('Profil menampilkan avatar yang diupload', r.data.profile.avatar === TINY_JPEG);
  r = await A.get('/api/me');
  check('/api/me membawa avatar', r.data.user.avatar === TINY_JPEG);
  r = await A.post('/api/chat/global', { content: 'Pesan dengan avatar baru tes' });
  check('A kirim pesan chat (untuk cek avatar)', r.status === 200);
  await sleep(6000); // anti-spam chat 5 detik
  r = await B.get('/api/chat/global');
  const withAvatar = r.data.messages.find((m) => m.username === 'warga_satu' && m.content === 'Pesan dengan avatar baru tes');
  check('Pesan chat membawa avatar pengirim', !!withAvatar && withAvatar.avatar === TINY_JPEG);
  r = await ADM.get('/api/admin/players');
  const aPlayer = r.data.players.find((p) => p.username === 'warga_satu');
  check('Daftar pemain admin menampilkan avatar', !!aPlayer && aPlayer.avatar === TINY_JPEG);
  const bigBuf = Buffer.alloc(101 * 1024, 0);
  bigBuf[0] = 0xFF; bigBuf[1] = 0xD8; bigBuf[2] = 0xFF;
  const bigJpeg = 'data:image/jpeg;base64,' + bigBuf.toString('base64');
  r = await A.post('/api/profile/avatar', { avatar: bigJpeg });
  check('Avatar > 100 KB ditolak (400)', r.status === 400, r.data.error || '');
  r = await A.post('/api/profile/avatar', { avatar: 'data:text/plain;base64,SGVsbG8=' });
  check('Bukan gambar ditolak (400)', r.status === 400);
  r = await A.post('/api/profile/avatar', { avatar: 'bukan-data-url' });
  check('Data URL tidak valid ditolak (400)', r.status === 400);
  r = await B.post('/api/profile/avatar', { avatar: TINY_JPEG });
  check('B upload avatar sendiri berhasil', r.status === 200 && r.data.ok);
  r = await A.get('/api/profile/warga_satu');
  check('Avatar A tetap milik A (tidak tertimpa B)', r.data.profile.avatar === TINY_JPEG);
  r = await B.get('/api/profile/warga_dua');
  check('Avatar B kini terisi', r.data.profile.avatar === TINY_JPEG);
  r = await A.post('/api/profile/avatar/delete');
  check('Hapus avatar berhasil', r.status === 200 && r.data.ok);
  r = await A.get('/api/profile/warga_satu');
  check('Profil A kembali tanpa avatar', !r.data.profile.avatar);

  console.log('\n[17] Jenis HADIAH vs PEMBELIAN + hadiah massal + bahan mentah');
  r = await ADM.post('/api/admin/gold', { user_id: 3, amount: 100, kind: 'hadiah' });
  check('Admin: beri 100 emas (hadiah)', r.status === 200 && r.data.ok);
  r = await R.get('/api/notifications');
  const nGift = r.data.notifications.find((n) => n.title === 'Hadiah dari admin' && (n.content || '').includes('+100 emas'));
  check('Notifikasi hadiah emas: "Hadiah dari admin"', !!nGift, nGift?.content || '');
  r = await ADM.post('/api/admin/gold', { user_id: 3, amount: 100, kind: 'pembelian' });
  check('Admin: beri 100 emas (pembelian)', r.status === 200 && r.data.ok);
  r = await R.get('/api/notifications');
  const nBuy = r.data.notifications.find((n) => n.title === 'Pembelian diterima' && (n.content || '').includes('100 emas diterima dari pembelian'));
  check('Notifikasi pembelian emas: "Pembelian diterima"', !!nBuy, nBuy?.content || '');
  check('Notifikasi pembelian tidak mengandung kata hadiah', !!nBuy && !/hadiah/i.test(nBuy.title + ' ' + nBuy.content));
  r = await ADM.post('/api/admin/usd', { user_id: 3, amount: 25, kind: 'pembelian' });
  check('Admin: beri 25 USD (pembelian)', r.status === 200 && r.data.ok);
  r = await R.get('/api/notifications');
  const nBuyUsd = r.data.notifications.find((n) => n.title === 'Pembelian diterima' && (n.content || '').includes('25 USD diterima dari pembelian'));
  check('Notifikasi pembelian USD', !!nBuyUsd);
  r = await ADM.post('/api/admin/item', { user_id: 3, commodity: 'Senjata', tier: 1, qty: 5, kind: 'pembelian' });
  check('Admin: beri 5× Senjata T1 (pembelian)', r.status === 200 && r.data.ok);
  r = await R.get('/api/notifications');
  const nBuyItem = r.data.notifications.find((n) => n.title === 'Pembelian diterima' && (n.content || '').includes('5× Senjata T1 diterima dari pembelian'));
  check('Notifikasi pembelian barang: "5× Senjata T1 diterima dari pembelian"', !!nBuyItem);
  r = await R.get('/api/inventory');
  const senjataR = r.data.items.find((i) => i.name === 'Senjata');
  check('Inventaris R: Senjata 3 → 8', senjataR && senjataR.qty === 8, `senjata=${senjataR?.qty}`);
  r = await ADM.post('/api/admin/premium', { user_id: 3, months: 1, kind: 'pembelian' });
  check('Admin: beri Premium 1 bulan (pembelian)', r.status === 200 && r.data.ok);
  r = await R.get('/api/notifications');
  const nBuyPrem = r.data.notifications.find((n) => n.title === 'Pembelian diterima' && (n.content || '').includes('Premium 1 bulan diterima dari pembelian'));
  check('Notifikasi pembelian premium', !!nBuyPrem);
  r = await ADM.post('/api/admin/energy', { user_id: 3, kind: 'pembelian' });
  check('Admin: isi energi (pembelian)', r.status === 200 && r.data.ok);
  r = await R.get('/api/notifications');
  const nBuyEn = r.data.notifications.find((n) => n.title === 'Pembelian diterima' && (n.content || '').includes('Energi diisi penuh'));
  check('Notifikasi pembelian energi', !!nBuyEn);
  r = await ADM.get('/api/admin/actions');
  const logBuy = r.data.actions.find((a) => a.action === 'gold' && (a.detail || '').includes('(pembelian)'));
  check('Log admin mencatat jenis pembelian', !!logBuy, logBuy?.detail || '');
  const logGift = r.data.actions.find((a) => a.action === 'gold' && (a.detail || '').includes('(hadiah)'));
  check('Log admin mencatat jenis hadiah', !!logGift, logGift?.detail || '');
  r = await ADM.post('/api/admin/item', { user_id: 3, commodity: 'Besi Mentah', tier: 1, qty: 10, kind: 'hadiah' });
  check('Admin: beri 10× Besi Mentah T1 (bahan mentah)', r.status === 200 && r.data.ok, r.data.error || '');
  r = await R.get('/api/inventory');
  const besiR = r.data.items.find((i) => i.name === 'Besi Mentah');
  check('Inventaris R: 10× Besi Mentah T1', besiR && besiR.qty === 10 && besiR.tier === 1, `besi=${besiR?.qty}`);
  r = await ADM.post('/api/admin/item', { user_id: 3, commodity: 'Barang Palsu', tier: 1, qty: 5 });
  check('Barang tidak dikenal ditolak (400)', r.status === 400);
  r = await ADM.post('/api/admin/ban', { user_id: 6, reason: 'Tes hadiah massal' });
  check('Admin: ban Y untuk tes hadiah massal', r.status === 200 && r.data.ok);
  const beforeR = (await R.get('/api/me')).data.citizen.gold;
  const beforeY = (await Y.get('/api/me')).data.citizen.gold;
  r = await ADM.post('/api/admin/gift-all', { kind: 'gold', amount: 50, message: 'Terima kasih sudah bermain!' });
  check('Hadiah massal +50 emas terkirim (6 penerima)', r.status === 200 && r.data.ok && r.data.recipients === 6, `recipients=${r.data.recipients}`);
  r = await R.get('/api/me');
  check('R menerima +50 emas dari hadiah massal', r.data.citizen.gold === beforeR + 50, `emas=${r.data.citizen.gold} sebelum=${beforeR}`);
  r = await Y.get('/api/me');
  check('Y yang di-ban TIDAK menerima hadiah massal', r.data.citizen.gold === beforeY, `emas=${r.data.citizen.gold} sebelum=${beforeY}`);
  r = await R.get('/api/notifications');
  const nMass = r.data.notifications.find((n) => n.title === 'Hadiah dari admin' && (n.content || '').includes('+50 emas'));
  check('Notifikasi hadiah massal: "Hadiah dari admin"', !!nMass);
  r = await ADM.get('/api/admin/actions');
  check('Log admin mencatat hadiah massal', r.data.actions.some((a) => a.action === 'gift_all'));
  r = await ADM.post('/api/admin/gift-all', { kind: 'item', commodity: 'Kayu', tier: 1, amount: 5 });
  check('Hadiah massal 5× Kayu T1 terkirim', r.status === 200 && r.data.ok);
  r = await R.get('/api/inventory');
  const kayuR = r.data.items.find((i) => i.name === 'Kayu');
  check('Inventaris R: 5× Kayu T1 dari hadiah massal', kayuR && kayuR.qty === 5, `kayu=${kayuR?.qty}`);
  r = await ADM.post('/api/admin/gift-all', { kind: 'gold', amount: 0 });
  check('Hadiah massal jumlah 0 ditolak (400)', r.status === 400);
  r = await ADM.post('/api/admin/gift-all', { kind: 'gold', amount: 1000001 });
  check('Hadiah massal di atas maks ditolak (400)', r.status === 400);
  r = await B.post('/api/admin/gift-all', { kind: 'gold', amount: 50 });
  check('Non-admin tidak bisa hadiah massal (403)', r.status === 403);
  r = await ADM.post('/api/admin/unban', { user_id: 6 });
  check('Admin: unban Y kembali', r.status === 200 && r.data.ok);

  console.log('\n[18] Inbox admin: tiket Meja Bantuan + laporan chat');
  r = await A.post('/api/support', { type: 'Saran', topic: 'Ekonomi & Pasar', details: 'Saran tes inbox admin ini cukup panjang.' });
  check('A mengirim tiket saran ke Meja Bantuan', r.status === 200 && r.data.ok, r.data.error || '');
  r = await B.get('/api/admin/tickets');
  check('Pemain biasa tidak bisa membuka daftar tiket (403)', r.status === 403);
  r = await ADM.get('/api/admin/tickets');
  const ticket = r.data.tickets.find((t) => t.username === 'warga_satu' && t.type === 'Saran');
  check('Admin melihat tiket A (status baru, info pemain)', r.status === 200 && !!ticket && ticket.status === 'baru' && ticket.publicId === 'PL-000001', `status=${ticket?.status} id=${ticket?.publicId}`);
  const ticketId = ticket.id;
  r = await ADM.post('/api/admin/tickets/' + ticketId + '/reply', { text: 'Terima kasih, saranmu kami tampung.' });
  check('Admin membalas tiket', r.status === 200 && r.data.ok);
  r = await A.get('/api/notifications');
  const nReply = r.data.notifications.find((n) => n.title === 'Balasan dari Admin' && (n.content || '').includes('Terima kasih, saranmu kami tampung.'));
  check('A mendapat notifikasi "Balasan dari Admin"', !!nReply, nReply?.content || '');
  r = await ADM.get('/api/admin/tickets?status=dibaca');
  check('Tiket berubah jadi dibaca setelah dibalas', r.data.tickets.some((t) => t.id === ticketId), `n=${r.data.tickets?.length}`);
  r = await ADM.post('/api/admin/tickets/' + ticketId + '/status', { status: 'selesai' });
  check('Admin menandai tiket selesai', r.status === 200 && r.data.status === 'selesai');
  r = await ADM.get('/api/admin/tickets?status=selesai');
  check('Tiket tampil di filter selesai', r.data.tickets.some((t) => t.id === ticketId));
  r = await ADM.post('/api/admin/tickets/' + ticketId + '/status', { status: 'ngawur' });
  check('Status tiket tidak valid ditolak (400)', r.status === 400);
  r = await ADM.post('/api/admin/tickets/99999/reply', { text: 'tes' });
  check('Balas tiket tidak ada ditolak (404)', r.status === 404);
  await sleep(6000); // anti-spam chat 5 detik (pesan terakhir A di [16])
  r = await B.get('/api/chat/global');
  const aMsg = r.data.messages.find((m) => m.username === 'warga_satu' && m.content === 'Pesan dengan avatar baru tes');
  check('B menemukan pesan A untuk dilaporkan', !!aMsg);
  r = await B.post('/api/chat/report', { message_id: aMsg.id, reason: 'Spam', details: 'tes laporan inbox' });
  check('B melaporkan pesan A', r.status === 200 && r.data.ok);
  r = await ADM.get('/api/admin/reports');
  const rep = r.data.reports.find((x) => x.message_content === 'Pesan dengan avatar baru tes' && x.reporter_name === 'warga_dua');
  check('Admin melihat laporan chat (pesan + pelapor + alasan)', r.status === 200 && !!rep && rep.reason === 'Spam', `reason=${rep?.reason}`);
  const repId = rep.id;
  r = await ADM.post('/api/admin/reports/' + repId + '/review');
  check('Admin menandai laporan ditinjau', r.status === 200 && r.data.status === 'reviewed');
  r = await ADM.get('/api/admin/reports');
  check('Laporan tampil sebagai sudah ditinjau', r.data.reports.find((x) => x.id === repId)?.status === 'reviewed');
  r = await ADM.post('/api/admin/reports/' + repId + '/review');
  check('Laporan yang sudah ditinjau tidak bisa ditinjau lagi (400)', r.status === 400);
  r = await B.get('/api/admin/reports');
  check('Pemain biasa tidak bisa membuka daftar laporan (403)', r.status === 403);

  console.log('\n[19] Toko: endpoint shop + data paket');
  r = await A.get('/api/shop');
  check('GET /api/shop 200 (butuh login)', r.status === 200 && Array.isArray(r.data.packages));
  check('Toko punya 3 paket + 4 pilihan premium', r.data.packages?.length === 3 && r.data.premium?.length === 4);
  const deluxe = r.data.packages.find((p) => p.id === 'deluxe');
  check('Paket Deluxe: best, Rp50.000, HEMAT 14%', deluxe?.best === true && deluxe?.price === 50000 && deluxe?.save === 'HEMAT 14%');
  check('waUrl top-up mengarah ke nomor admin', (r.data.waUrl || '').startsWith('https://wa.me/6285220743283'));

  stop();
  console.log(`\n[e2e] SELESAI: ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[e2e] ERROR:', e); process.exit(1); });
