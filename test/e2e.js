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
      env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'e2e-test-secret', ADMIN_BOOTSTRAP_CODE: 'e2e-bootstrap-code' },
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
  // BUG-11 (Tahap 3): filter blokir DI SQL — 100 pesan B yang lebih lama
  // tidak boleh menghabiskan LIMIT 100 dan menenggelamkan pesan A.
  // Dipakai room 'indonesia' (bukan global) supaya pesan lama ini tidak
  // mengotori pembacaan chat global di bagian tes berikutnya.
  const dbChat = new DatabaseSync(DB_PATH);
  const meA = await A.get('/api/auth/me');
  const chatBase = Date.now() - 100000;
  dbChat.prepare('INSERT INTO chat_messages (citizen_id, room, content, created_at) VALUES (?,?,?,?)')
    .run(meB.data.citizen.id, 'indonesia', 'pesan B di indonesia', chatBase);
  for (let i = 0; i < 100; i++) {
    dbChat.prepare('INSERT INTO chat_messages (citizen_id, room, content, created_at) VALUES (?,?,?,?)')
      .run(meB.data.citizen.id, 'indonesia', 'pesan lama B #' + i, chatBase - 1000 + i);
  }
  dbChat.prepare('INSERT INTO chat_messages (citizen_id, room, content, created_at) VALUES (?,?,?,?)')
    .run(meA.data.citizen.id, 'indonesia', 'pesan A di indonesia', chatBase + 5000);
  dbChat.close();
  r = await A.get('/api/chat/indonesia');
  check('Blokir di SQL: 100 pesan B tidak menenggelamkan pesan A (A tetap terlihat)', r.data.messages.length === 1 && r.data.messages[0].username === 'warga_satu', `n=${r.data.messages.length}`);
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
  const NOADM = new Client();

  // Naik ke Level 3 lewat jalur normal: klaim (+2 XP) + 13 latih (str×5,
  // edu×5, eco×3 = 13 XP, biaya total 36 emas). Pendaftar mulai 50 emas,
  // setelah klaim 55, setelah latih 19, setelah bonus referral cair 69.
  async function levelTo3(client) {
    let r = await client.post('/api/claim');
    if (r.status !== 200) return r;
    for (const a of ['str', 'str', 'str', 'str', 'str', 'edu', 'edu', 'edu', 'edu', 'edu', 'eco', 'eco', 'eco']) {
      r = await client.post('/api/train', { attr: a });
      if (r.status !== 200) return r;
    }
    return r;
  }

  r = await R.post('/api/auth/register', { email: 'ref1@test.local', password: 'rahasia123', username: 'referrer_satu' });
  check('Referrer mendaftar', r.status === 200 && r.data.ok);
  r = await R.get('/api/me');
  const refCode = r.data.referral?.code;
  check('Kode referral 8 karakter tanpa ambiguitas (tanpa 0/O/1/I/l/L)', typeof refCode === 'string' && /^[A-HJKMNP-Z2-9]{8}$/.test(refCode), `kode=${refCode}`);
  check('Referral awal: 0 pemakai, 0 emas', r.data.referral.uses === 0 && r.data.referral.goldEarned === 0);
  check('ID publik referrer PL-000003', r.data.user.publicId === 'PL-000003', r.data.user.publicId || '');

  // Bonus referral TIDAK cair saat daftar (Tahap 2): pendaftar mulai 50 emas
  // tanpa premium; bonus cair saat ia mencapai Level 3.
  r = await N.post('/api/auth/register', { email: 'ref2@test.local', password: 'rahasia123', username: 'pendaftar_satu', ref: refCode });
  check('Pendaftar dengan kode referral berhasil', r.status === 200 && r.data.ok);
  r = await N.get('/api/me');
  check('Pendaftar baru: 50 emas (tanpa bonus langsung)', r.data.citizen.gold === 50, `emas=${r.data.citizen.gold}`);
  check('Pendaftar baru: belum premium sebelum Level 3', !r.data.citizen.isPremium);
  r = await R.get('/api/me');
  check('Referrer: belum dapat bonus sebelum pendaftar Level 3 (50 emas, 0 cair)', r.data.citizen.gold === 50 && r.data.referral.goldEarned === 0 && r.data.referral.uses === 1, `emas=${r.data.citizen.gold} earned=${r.data.referral.goldEarned}`);
  r = await levelTo3(N);
  check('Pendaftar naik ke Level 3 (klaim + 13 latih)', r.status === 200, r.data.error || '');
  r = await N.get('/api/me');
  const nowMs = Date.now();
  check('Pendaftar Level 3: 69 emas (19 + 50 bonus referral)', r.data.citizen.gold === 69, `emas=${r.data.citizen.gold}`);
  check('Pendaftar Level 3: premium aktif 1 hari', r.data.citizen.isPremium && r.data.citizen.premium_until > nowMs && r.data.citizen.premium_until <= nowMs + 86400000 + 60000, `until=${r.data.citizen.premium_until}`);
  r = await R.get('/api/me');
  check('Referrer: 150 emas (50 + 100 bonus)', r.data.citizen.gold === 150, `emas=${r.data.citizen.gold}`);
  check('Referrer: premium aktif ~2 hari', r.data.citizen.isPremium && r.data.citizen.premium_until > nowMs + 86400000 && r.data.citizen.premium_until <= nowMs + 2 * 86400000 + 60000);
  check('Referrer: 1 pemakai kode, +100 emas referral cair', r.data.referral.uses === 1 && r.data.referral.goldEarned === 100);

  r = await X.post('/api/auth/register', { email: 'ref3@test.local', password: 'rahasia123', username: 'pendaftar_dua', ref: refCode.toLowerCase() });
  check('Kode referral huruf kecil tetap berlaku', r.status === 200 && r.data.ok);
  r = await X.get('/api/me');
  check('Pendaftar kedua: 50 emas, tanpa premium', r.data.citizen.gold === 50 && !r.data.citizen.isPremium);
  r = await R.get('/api/me');
  check('Referrer: 2 pemakai kode, bonus cair masih 100', r.data.referral.uses === 2 && r.data.referral.goldEarned === 100);
  r = await levelTo3(X);
  check('Pendaftar kedua naik ke Level 3', r.status === 200, r.data.error || '');
  r = await R.get('/api/me');
  check('Referrer: 2 pemakai kode, +200 emas referral cair', r.data.referral.uses === 2 && r.data.referral.goldEarned === 200);
  check('Referrer: 250 emas (50 + 200 bonus)', r.data.citizen.gold === 250, `emas=${r.data.citizen.gold}`);

  r = await Y.post('/api/auth/register', { email: 'ref4@test.local', password: 'rahasia123', username: 'pendaftar_tiga', ref: 'ZZZZZZZZ' });
  check('Kode referral tidak valid: registrasi tetap jalan', r.status === 200 && r.data.ok);
  r = await Y.get('/api/me');
  check('Tanpa kode valid: 50 emas, tanpa premium', r.data.citizen.gold === 50 && !r.data.citizen.isPremium);
  r = await R.get('/api/me');
  check('Referrer tetap 2 pemakai kode', r.data.referral.uses === 2);

  // --- Pencabutan pemberian admin berbasis email (27 Nov 2026) ---
  // Khalid sudah menjadi admin; registrasi dengan email admin TANPA kode
  // bootstrap tidak lagi menjadi admin. Satu-satunya jalan darurat: kode
  // bootstrap (env ADMIN_BOOTSTRAP_CODE — di tes ini 'e2e-bootstrap-code').
  r = await NOADM.post('/api/auth/register', { email: 'koboijuniorkhalid@gmail.com', password: 'rahasia123', username: 'khalid_tanpa_kode' });
  check('Daftar dengan email admin TANPA kode bootstrap berhasil (sebagai warga)', r.status === 200 && r.data.ok);
  r = await NOADM.get('/api/me');
  check('Email admin tanpa kode bootstrap TIDAK jadi admin', r.data.user.is_admin === false);
  check('ID publik warga email admin PL-000007', r.data.user.publicId === 'PL-000007', r.data.user.publicId || '');
  r = await NOADM.post('/api/auth/register', { email: 'salah@test.local', password: 'rahasia123', username: 'kode_salah', admin_code: 'kode-yang-salah' });
  check('Kode bootstrap salah ditolak (400)', r.status === 400, r.data.error || '');
  r = await ADM.post('/api/auth/register', { email: 'admin@parlementer.local', password: 'rahasia123', username: 'admin_darurat', admin_code: 'e2e-bootstrap-code' });
  check('Admin darurat mendaftar dengan kode bootstrap yang benar', r.status === 200 && r.data.ok);
  r = await ADM.get('/api/me');
  check('Akun dengan kode bootstrap benar menjadi admin', r.data.user.is_admin === true);
  check('ID publik admin PL-000008', r.data.user.publicId === 'PL-000008', r.data.user.publicId || '');
  r = await B.get('/api/me');
  check('Warga biasa bukan admin', r.data.user.is_admin === false);
  check('ID publik B PL-000002', r.data.user.publicId === 'PL-000002');

  // --- Batas referral: maks 5 bonus terbayar/hari/pemilik kode ---
  // R sudah menerima 2 bonus (N, X). Tiga pendaftar lagi naik Level 3 →
  // bonus ke-3, 4, 5 cair. Pendaftar ke-6 naik Level 3 → bonus DITUNDA
  // (skipped): R tetap 500 emas cair, pendaftar itu tetap 19 emas.
  const caps = [];
  for (let i = 1; i <= 4; i++) {
    const P = new Client();
    caps.push(P);
    r = await P.post('/api/auth/register', { email: `cap${i}@test.local`, password: 'rahasia123', username: `pendaftar_cap${i}`, ref: refCode });
    check(`Pendaftar cap ${i} mendaftar dengan kode referral`, r.status === 200 && r.data.ok);
    r = await levelTo3(P);
    check(`Pendaftar cap ${i} naik ke Level 3`, r.status === 200, r.data.error || '');
  }
  r = await R.get('/api/me');
  check('Referrer: 6 pemakai kode, 500 emas referral cair (5 bonus maks/hari)', r.data.referral.uses === 6 && r.data.referral.goldEarned === 500, `uses=${r.data.referral.uses} earned=${r.data.referral.goldEarned}`);
  check('Referrer: 550 emas (50 + 500 bonus)', r.data.citizen.gold === 550, `emas=${r.data.citizen.gold}`);
  r = await caps[3].get('/api/me');
  check('Pendaftar cap ke-6 (bonus tertunda): 19 emas, tanpa premium', r.data.citizen.gold === 19 && !r.data.citizen.isPremium, `emas=${r.data.citizen.gold}`);
  r = await caps[2].get('/api/me');
  check('Pendaftar cap ke-5 (bonus cair): 69 emas + premium', r.data.citizen.gold === 69 && r.data.citizen.isPremium, `emas=${r.data.citizen.gold}`);

  r = await B.get('/api/admin/players');
  check('Non-admin: GET /api/admin/players ditolak 403', r.status === 403);
  r = await B.post('/api/admin/gold', { user_id: 1, amount: 10 });
  check('Non-admin: POST /api/admin/gold ditolak 403', r.status === 403);
  r = await B.post('/api/admin/ban', { user_id: 1, reason: 'tes' });
  check('Non-admin: POST /api/admin/ban ditolak 403', r.status === 403);

  r = await ADM.get('/api/admin/players');
  check('Admin: daftar pemain tampil (12 pemain)', r.status === 200 && r.data.players.length === 12, `jumlah=${r.data.players?.length}`);
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
  r = await ADM.post('/api/admin/ban', { user_id: 8, reason: 'tes' });
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
  check('Profil sendiri: kode + 6 pemakai + 500 emas referral', r.data.profile.referral && r.data.profile.referral.uses === 6 && r.data.profile.referral.goldEarned === 500 && r.data.profile.referral.code === refCode);
  r = await B.get('/api/profile/referrer_satu');
  check('Profil orang lain: statistik referral tidak ditampilkan', r.data.profile.referral === null);
  const html2 = await fetch(BASE + '/').then((x) => x.text());
  check('Form daftar punya field Kode Referral', html2.includes('KODE REFERAL'));
  check('Form daftar punya field Kode Admin (bootstrap)', html2.includes('KODE ADMIN'));

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
  dbBan.prepare('UPDATE users SET is_banned = 1, banned_reason = ? WHERE id = ?').run('tes migrasi', 8);
  dbBan.close();
  stop();
  await sleep(500);
  const upAgain = await startServer();
  check('Server restart setelah migrasi ban admin', upAgain);
  r = await ADM.get('/api/me');
  check('Migrasi mencabut ban akun admin (is_banned=false)', r.data.user.is_banned === false, `is_banned=${r.data.user?.is_banned}`);
  r = await ADM.post('/api/admin/ban', { user_id: 8, reason: 'coba ban admin' });
  check('Endpoint ban tetap menolak admin (400)', r.status === 400);

  console.log('\n[16] Foto profil (avatar)');
  // A logout di [13], jadi login lagi dulu.
  r = await A.post('/api/auth/login', { email: 'warga1@test.local', password: 'rahasia123' });
  check('A login lagi setelah logout di [13]', r.status === 200 && r.data.ok);
  const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwH/2Q==';
  // Thumbnail 48×48 untuk chat/DM (Tahap 3, §6.3) — JPEG minimal yang valid
  // (magic bytes FF D8 FF), sengaja berbeda dari TINY_JPEG supaya tes bisa
  // membedakan avatar penuh vs avatar kecil.
  const TINY_JPEG_SM = 'data:image/jpeg;base64,' + Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9]).toString('base64');
  r = await A.post('/api/profile/avatar', { avatar: TINY_JPEG, avatar_sm: TINY_JPEG_SM });
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
  // Perubahan perilaku yang disengaja (Tahap 3, §6.3): chat kini mengirim
  // avatar_sm (48×48), bukan avatar penuh — payload polling jauh lebih kecil.
  check('Pesan chat membawa avatar KECIL pengirim (avatar_sm)', !!withAvatar && withAvatar.avatar === TINY_JPEG_SM, `avatar=${(withAvatar?.avatar || '').slice(0, 40)}`);
  const bigSmBuf = Buffer.alloc(26 * 1024, 0);
  bigSmBuf[0] = 0xFF; bigSmBuf[1] = 0xD8; bigSmBuf[2] = 0xFF;
  r = await A.post('/api/profile/avatar', { avatar: TINY_JPEG, avatar_sm: 'data:image/jpeg;base64,' + bigSmBuf.toString('base64') });
  check('Thumbnail avatar > 25 KB ditolak (400)', r.status === 400, r.data.error || '');
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
  // Hapus avatar juga membersihkan avatar_sm (Tahap 3, §6.3).
  const dbAv = new DatabaseSync(DB_PATH);
  const avRow = dbAv.prepare('SELECT avatar, avatar_sm FROM users WHERE username = ?').get('warga_satu');
  dbAv.close();
  check('Hapus avatar juga menghapus avatar_sm di DB', !avRow.avatar && !avRow.avatar_sm);

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
  check('Hadiah massal +50 emas terkirim (11 penerima)', r.status === 200 && r.data.ok && r.data.recipients === 11, `recipients=${r.data.recipients}`);
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

  console.log('\n[20] Bonus konvoi (Tahap 3, BUG-7)');
  // A: 4 bangunan konvoi aktif (langsung via DB — slot Level 1 hanya 1,
  // jadi endpoint build tidak bisa dipakai untuk menguji keempat bonus
  // sekaligus). Perusahaan ringan milik A (produksi dasar 8× Makanan/hari).
  const meA20 = await A.get('/api/me');
  const aId = meA20.data.citizen.id;
  const aRegion = meA20.data.region.id;
  const dbCv = new DatabaseSync(DB_PATH);
  const convoyExp = Date.now() + 7 * 86400000;
  for (const [i, b] of ['health', 'education', 'industry', 'military'].entries()) {
    dbCv.prepare('INSERT INTO convoys (citizen_id, slot, building, region_id, expires_at, created_at) VALUES (?,?,?,?,?,?)')
      .run(aId, i + 1, b, aRegion, convoyExp, Date.now());
  }
  dbCv.prepare("INSERT INTO companies (owner_id, name, about, type, region_id, resource, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(aId, 'Perusahaan Tes', '', 'light', aRegion, '', Date.now());
  const beforeFood = (await A.get('/api/inventory')).data.items.find((x) => x.name === 'Makanan');
  const beforeFoodQty = beforeFood ? beforeFood.qty : 0;
  // Picu tick harian lagi (mundurkan tanggal seperti [12]).
  const yesterday2 = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  dbCv.prepare('UPDATE world SET last_tick_date = ? WHERE id = 1').run(yesterday2);
  dbCv.close();
  await A.get('/api/me'); // request ini memicu maybeTick (async)
  await sleep(1500);
  r = await A.get('/api/me');
  check('Rumah Sakit Lapangan: energi pulih ke 110 setelah tick', r.data.citizen.energy === 110, `energi=${r.data.citizen.energy}`);
  check('/api/me: energyCap 110 dengan Rumah Sakit Lapangan', r.data.citizen.energyCap === 110, `cap=${r.data.citizen.energyCap}`);
  check('/api/me: trainCosts.strength diskon 10% (2 → 1 emas)', r.data.citizen.trainCosts?.strength === 1, JSON.stringify(r.data.citizen.trainCosts));
  r = await A.get('/api/inventory');
  const afterFood = r.data.items.find((x) => x.name === 'Makanan');
  check('Gudang Industri: produksi Makanan 8 → 9 (+10%)', afterFood && afterFood.qty === beforeFoodQty + 9, `sebelum=${beforeFoodQty} sesudah=${afterFood?.qty}`);
  const goldBeforeTrain = (await A.get('/api/me')).data.citizen.gold;
  r = await A.post('/api/train', { attr: 'str' });
  check('Sekolah Keliling: latih str hanya potong 1 emas (bukan 2)', r.status === 200 && r.data.cost === 1 && (await A.get('/api/me')).data.citizen.gold === goldBeforeTrain - 1, `status=${r.status} cost=${r.data.cost} ${r.data.error || ''}`);
  // Pos Militer: perang di Jakarta (wilayah A) + serangan pembela.
  // Kekuatan A kini 2 (latih [4] + latih di atas) → dasar 20+5×2=30 → +10% = 33.
  const dbWar = new DatabaseSync(DB_PATH);
  const warIns = dbWar.prepare("INSERT INTO wars (name, region_id, attacker_label, defender_label, score_a, score_d, status, winner, ends_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run('Perang Tes Jakarta', aRegion, 'Pemberontak Jakarta', 'Republik Indonesia', 0, 0, 'active', '', Date.now() + 7 * 86400000, Date.now());
  const warId = Number(warIns.lastInsertRowid);
  dbWar.close();
  r = await A.get('/api/wars/' + warId);
  check('Perang membawa label penyerang/pembela (BUG-12)', r.data.war.attacker_label === 'Pemberontak Jakarta' && r.data.war.defender_label === 'Republik Indonesia', JSON.stringify(r.data.war));
  r = await A.post(`/api/wars/${warId}/attack`, { side: 'defender', ammo: 'Senjata' });
  check('Pos Militer: kerusakan perang 30 → 33 (+10%)', r.status === 200 && r.data.damage === 33, `damage=${r.data.damage} ${r.data.error || ''}`);

  console.log('\n[22] Tahap 4 — Pasar/Ekonomi, energi, pengumuman, hadiah barang');
  // Helper: paksa tick harian (mundurkan tanggal seperti [12]).
  const forceTick = async (client) => {
    const dbF = new DatabaseSync(DB_PATH);
    const yd = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    dbF.prepare('UPDATE world SET last_tick_date = ? WHERE id = 1').run(yd);
    dbF.close();
    await client.get('/api/me');
    await sleep(1500);
  };
  const C = new Client();
  const D = new Client();
  const E = new Client();
  const F = new Client();
  r = await C.post('/api/auth/register', { email: 'tahap4c@test.local', password: 'rahasia123', username: 'tahap4_c' });
  check('Tahap 4: C mendaftar', r.status === 200 && r.data.ok);
  r = await D.post('/api/auth/register', { email: 'tahap4d@test.local', password: 'rahasia123', username: 'tahap4_d' });
  check('Tahap 4: D mendaftar', r.status === 200 && r.data.ok);
  r = await E.post('/api/auth/register', { email: 'tahap4e@test.local', password: 'rahasia123', username: 'tahap4_e' });
  check('Tahap 4: E mendaftar', r.status === 200 && r.data.ok);
  r = await F.post('/api/auth/register', { email: 'tahap4f@test.local', password: 'rahasia123', username: 'tahap4_f' });
  check('Tahap 4: F mendaftar', r.status === 200 && r.data.ok);
  const meC = (await C.get('/api/me')).data;
  const meD = (await D.get('/api/me')).data;
  const meE = (await E.get('/api/me')).data;
  const meF = (await F.get('/api/me')).data;
  const cId = meC.citizen.id; const dId = meD.citizen.id;
  const eId = meE.citizen.id; const fId = meF.citizen.id;
  const cUserId = meC.user.id;
  const market0 = await C.get('/api/market?scope=local');
  const besiId = market0.data.commodities.find((x) => x.name === 'Besi Mentah').id;
  const makananId = market0.data.commodities.find((x) => x.name === 'Makanan').id;
  const db4 = new DatabaseSync(DB_PATH);
  const setInv = (citizenId, commodityId, qty) => db4.prepare(
    'INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,?) ON CONFLICT (citizen_id, commodity_id, tier) DO UPDATE SET qty = ?')
    .run(citizenId, commodityId, qty, qty);
  const invQty = (citizenId, commodityId) => {
    const row = db4.prepare('SELECT qty FROM inventory WHERE citizen_id = ? AND commodity_id = ? AND tier = 1').get(citizenId, commodityId);
    return row ? row.qty : 0;
  };

  console.log('  [22a] Grafik harga');
  const nowMs4 = Date.now();
  for (const [i, ts] of [nowMs4, nowMs4 - 3600000, nowMs4 - 86400000].entries()) {
    db4.prepare('INSERT INTO market_tx (buyer_id, seller_id, scope, commodity_id, tier, qty, price_each, total, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(cId, dId, 'local', besiId, 1, 10, 10, 100, ts);
  }
  r = await C.get(`/api/market/prices?commodity_id=${besiId}&days=14`);
  const todayStr = new Date(nowMs4).toISOString().slice(0, 10);
  const todayBucket = (r.data.days || []).find((d) => d.date === todayStr);
  check('Grafik harga: 2 hari terisi (hari ini + kemarin)', r.status === 200 && r.data.days.length === 2, `days=${r.data.days?.length}`);
  check('Grafik harga hari ini: 2 transaksi, 20 unit, rata-rata 10', !!todayBucket && todayBucket.tx === 2 && todayBucket.volume === 20 && todayBucket.avg === 10, JSON.stringify(todayBucket));
  r = await C.get('/api/market/prices?days=14');
  check('Grafik harga tanpa commodity_id ditolak (400)', r.status === 400);

  console.log('  [22b] Batas harga wajar');
  setInv(cId, besiId, 20);
  r = await C.post('/api/market/sell', { scope: 'local', commodity_id: besiId, tier: 1, qty: 10, price: 100 });
  check('Jual @100 ditolak: di luar batas wajar (median 10)', r.status === 400 && /batas wajar/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  const bandFlags = db4.prepare("SELECT COUNT(*) AS n FROM market_flags WHERE kind = 'price_band'").get();
  check('Penolakan harga dicatat di market_flags', Number(bandFlags.n) >= 1, `n=${bandFlags.n}`);
  r = await C.post('/api/market/sell', { scope: 'local', commodity_id: besiId, tier: 1, qty: 10, price: 10 });
  check('Jual @10 (dalam batas) berhasil', r.status === 200 && !!r.data.offerId, `status=${r.status} ${r.data.error || ''}`);
  r = await C.post('/api/market/buy-order', { scope: 'local', commodity_id: besiId, tier: 1, qty: 10, price: 100 });
  check('Order beli @100 ditolak (batas wajar)', r.status === 400);

  console.log('  [22c] Order beli + escrow + pajak ke kas negara');
  const usdC0 = (await C.get('/api/me')).data.citizen.usd;
  check('C mulai dengan 500 USD', usdC0 === 500, `usd=${usdC0}`);
  r = await C.post('/api/market/buy-order', { scope: 'local', commodity_id: besiId, tier: 1, qty: 10, price: 9 });
  check('Order beli 10× Besi @9 dipasang', r.status === 200 && !!r.data.orderId, `status=${r.status} ${r.data.error || ''}`);
  const buyOrderId = r.data.orderId;
  check('Escrow: 90 USD dikunci (500 → 410)', (await C.get('/api/me')).data.citizen.usd === 410);
  r = await C.get('/api/market?scope=local');
  const listedOrder = (r.data.buyOrders || []).find((o) => o.id === buyOrderId);
  check('Order beli tampil di order book', !!listedOrder && listedOrder.buyer === 'tahap4_c' && listedOrder.qty - listedOrder.qty_filled === 10);
  const treasury0 = (await C.get('/api/country')).data.country.treasury_usd;
  setInv(dId, besiId, 20);
  const usdD0 = (await D.get('/api/me')).data.citizen.usd;
  r = await D.post('/api/market/sell-to-order', { order_id: buyOrderId, qty: 6 });
  check('Jual 6 unit ke order beli berhasil', r.status === 200 && r.data.sellerReceives === 52.92, `status=${r.status} ${JSON.stringify(r.data)}`);
  check('Penjual terima 52,92 USD (54 − pajak 2%)', eq((await D.get('/api/me')).data.citizen.usd, usdD0 + 52.92));
  check('Pembeli terima 6× Besi (10 → 16)', invQty(cId, besiId) === 16, `besi=${invQty(cId, besiId)}`);
  r = await C.get('/api/market?scope=local');
  const myOrder = (r.data.myBuyOrders || []).find((o) => o.id === buyOrderId);
  check('Order terisi 6/10', !!myOrder && myOrder.qty_filled === 6, JSON.stringify(myOrder));
  const treasury1 = (await C.get('/api/country')).data.country.treasury_usd;
  check('Pajak 1,08 USD masuk kas negara', eq(treasury1 - treasury0, 1.08), `delta=${treasury1 - treasury0}`);
  const ledger = (await C.get('/api/country')).data.treasuryTx || [];
  check('Buku kas mencatat pajak 1,08 USD', ledger.some((t) => t.currency === 'usd' && eq(t.amount, 1.08)));
  r = await D.post('/api/market/sell-to-order', { order_id: buyOrderId, qty: 5 });
  check('Jual melebihi sisa order (4) ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await C.post('/api/market/sell-to-order', { order_id: buyOrderId, qty: 1 });
  check('Jual ke order beli sendiri ditolak (400)', r.status === 400);
  r = await C.post('/api/market/buy-order/cancel', { order_id: buyOrderId });
  check('Batal order: sisa escrow 36 USD kembali (410 → 446)', r.status === 200 && eq(r.data.refund, 36) && (await C.get('/api/me')).data.citizen.usd === 446, `status=${r.status} ${JSON.stringify(r.data)}`);

  console.log('  [22d] Pajak pasar biasa masuk kas negara (BUG-8)');
  const treasury2 = (await A.get('/api/country')).data.country.treasury_usd;
  const usdA0 = (await A.get('/api/me')).data.citizen.usd;
  const usdB0 = (await B.get('/api/me')).data.citizen.usd;
  setInv(2, makananId, 10);
  r = await B.post('/api/market/sell', { scope: 'local', commodity_id: makananId, tier: 1, qty: 10, price: 9 });
  check('B pasang jual 10× Makanan @9', r.status === 200 && !!r.data.offerId, `status=${r.status}`);
  r = await A.post('/api/market/buy', { offer_id: r.data.offerId, qty: 10 });
  check('A membeli 10× Makanan', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  check('A bayar 90 USD', eq((await A.get('/api/me')).data.citizen.usd, usdA0 - 90));
  check('B terima 88,20 USD (90 − pajak 2%)', eq((await B.get('/api/me')).data.citizen.usd, usdB0 + 88.2));
  const treasury3 = (await A.get('/api/country')).data.country.treasury_usd;
  check('Pajak 1,80 USD masuk kas negara', eq(treasury3 - treasury2, 1.8), `delta=${treasury3 - treasury2}`);

  console.log('  [22e] Deteksi wash trading');
  setInv(fId, besiId, 40);
  for (let i = 0; i < 3; i++) {
    const sell = await F.post('/api/market/sell', { scope: 'local', commodity_id: besiId, tier: 1, qty: 10, price: 10 });
    check(`Wash ${i + 1}/3: F pasang jual`, sell.status === 200, `status=${sell.status}`);
    const buy = await E.post('/api/market/buy', { offer_id: sell.data.offerId, qty: 10 });
    check(`Wash ${i + 1}/3: E membeli`, buy.status === 200, `status=${buy.status}`);
    const flags = db4.prepare("SELECT COUNT(*) AS n FROM market_flags WHERE kind = 'wash_trade' AND buyer_id = ? AND seller_id = ?").get(eId, fId);
    if (i < 2) check(`Wash: belum ditandai setelah ${i + 1} transaksi`, Number(flags.n) === 0, `n=${flags.n}`);
    else check('Wash: ditandai setelah 3 transaksi bolak-balik', Number(flags.n) >= 1, `n=${flags.n}`);
  }

  console.log('  [22f] Rantai produksi Pabrik (Besi Mentah → Bahan Bangunan)');
  db4.prepare('UPDATE citizens SET gold = 200 WHERE id = ?').run(cId);
  r = await C.post('/api/companies', { type: 'factory', name: 'Pabrik Tes' });
  check('Pabrik didirikan (100 emas)', r.status === 200 && !!r.data.companyId, `status=${r.status} ${r.data.error || ''}`);
  const bahanId = market0.data.commodities.find((x) => x.name === 'Bahan Bangunan').id;
  setInv(cId, besiId, 25);
  await forceTick(C);
  check('Tick 1: 20 Besi → 10 Bahan Bangunan (Besi 25 → 5)', invQty(cId, bahanId) === 10 && invQty(cId, besiId) === 5, `bahan=${invQty(cId, bahanId)} besi=${invQty(cId, besiId)}`);
  await forceTick(C);
  check('Tick 2: 4 Besi → 2 Bahan Bangunan (Besi 5 → 1, total 12)', invQty(cId, bahanId) === 12 && invQty(cId, besiId) === 1, `bahan=${invQty(cId, bahanId)} besi=${invQty(cId, besiId)}`);
  await forceTick(C);
  check('Tick 3: Besi 1 → produksi 0 (tetap 12)', invQty(cId, bahanId) === 12 && invQty(cId, besiId) === 1);
  r = await C.get('/api/notifications');
  check('Pabrik kekurangan bahan: notifikasi dikirim', (r.data.notifications || []).some((n) => n.title === 'Pabrik kekurangan bahan'));

  console.log('  [22g] Retensi data');
  const old = Date.now() - 200 * 86400000;
  db4.prepare("INSERT INTO chat_messages (room, citizen_id, content, created_at) VALUES ('global',?,?,?)").run(aId, 'Pesan lama 100 hari', Date.now() - 100 * 86400000);
  db4.prepare("INSERT INTO chat_messages (room, citizen_id, content, created_at) VALUES ('global',?,?,?)").run(aId, 'Pesan baru 1 hari', Date.now() - 86400000);
  db4.prepare('INSERT INTO notifications (citizen_id, category, title, content, is_read, created_at) VALUES (?,?,?,?,?,?)').run(aId, 'SISTEM', 'Notif lama dibaca', '', 1, Date.now() - 40 * 86400000);
  db4.prepare('INSERT INTO notifications (citizen_id, category, title, content, is_read, created_at) VALUES (?,?,?,?,?,?)').run(aId, 'SISTEM', 'Notif lama belum dibaca', '', 0, Date.now() - 40 * 86400000);
  db4.prepare('INSERT INTO notifications (citizen_id, category, title, content, is_read, created_at) VALUES (?,?,?,?,?,?)').run(aId, 'SISTEM', 'Notif baru dibaca', '', 1, Date.now() - 86400000);
  db4.prepare('INSERT INTO market_tx (buyer_id, seller_id, scope, commodity_id, tier, qty, price_each, total, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(aId, 2, 'local', besiId, 1, 5, 10, 50, old);
  db4.prepare('INSERT INTO market_tx (buyer_id, seller_id, scope, commodity_id, tier, qty, price_each, total, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(aId, 2, 'local', besiId, 1, 5, 10, 50, Date.now() - 86400000);
  db4.prepare('INSERT INTO fx_history (price, volume, created_at) VALUES (?,?,?)').run(10, 5, old);
  db4.prepare('INSERT INTO war_attacks (war_id, citizen_id, side, damage, ammo, created_at) VALUES (?,?,?,?,?,?)').run(warId, aId, 'defender', 10, 'Senjata', old);
  await forceTick(A);
  const cnt = (table, cond) => Number(db4.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${cond}`).get().n);
  check('Retensi: chat >90 hari dihapus, yang baru tetap', cnt('chat_messages', "content = 'Pesan lama 100 hari'") === 0 && cnt('chat_messages', "content = 'Pesan baru 1 hari'") === 1);
  check('Retensi: notifikasi terbaca >30 hari dihapus', cnt('notifications', "title = 'Notif lama dibaca'") === 0 && cnt('notifications', "title = 'Notif baru dibaca'") === 1);
  check('Retensi: notifikasi BELUM dibaca dipertahankan', cnt('notifications', "title = 'Notif lama belum dibaca'") === 1);
  check('Retensi: market_tx + fx_history + war_attacks >180 hari dihapus', cnt('market_tx', `created_at = ${old}`) === 0 && cnt('fx_history', `created_at = ${old}`) === 0 && cnt('war_attacks', `created_at = ${old}`) === 0);
  db4.close();

  console.log('  [22h] Regen energi + batas per level');
  const dbE = new DatabaseSync(DB_PATH);
  const setEnergy = (energy, updatedAt) => dbE.prepare('UPDATE citizens SET energy = ?, energy_updated_at = ? WHERE id = ?').run(energy, updatedAt, dId);
  setEnergy(50, Date.now() - 10 * 60000);
  r = await D.get('/api/me');
  check('Regen: 50 + 10 menit × 2 = 70', r.data.citizen.energy === 70, `energi=${r.data.citizen.energy}`);
  setEnergy(99, Date.now() - 10 * 60000);
  r = await D.get('/api/me');
  check('Regen berhenti di cap 100 (bukan 119)', r.data.citizen.energy === 100, `energi=${r.data.citizen.energy}`);
  setEnergy(0, Date.now() - 5 * 3600000);
  r = await D.get('/api/me');
  check('Regen offline 5 jam: tetap cap 100 (bukan 600)', r.data.citizen.energy === 100, `energi=${r.data.citizen.energy}`);
  setEnergy(50, Date.now() + 60000);
  r = await D.get('/api/me');
  check('Regen: jam di masa depan tidak menambah energi', r.data.citizen.energy === 50, `energi=${r.data.citizen.energy}`);
  dbE.prepare('UPDATE citizens SET level = 3 WHERE id = ?').run(dId);
  r = await D.get('/api/me');
  check('Cap level 3 = 110 (100 + 5×2)', r.data.citizen.energyCap === 110, `cap=${r.data.citizen.energyCap}`);
  dbE.prepare('UPDATE users SET premium_until = ? WHERE id = ?').run(Date.now() + 86400000, meD.user.id);
  r = await D.get('/api/me');
  check('Cap level 3 + Premium = 130 (+20)', r.data.citizen.energyCap === 130, `cap=${r.data.citizen.energyCap}`);
  dbE.prepare('INSERT INTO convoys (citizen_id, slot, building, region_id, expires_at, created_at) VALUES (?,?,?,?,?,?)')
    .run(dId, 1, 'health', 1, Date.now() + 7 * 86400000, Date.now());
  r = await D.get('/api/me');
  check('Cap level 3 + Premium + RS Lapangan = 140 (+10)', r.data.citizen.energyCap === 140, `cap=${r.data.citizen.energyCap}`);
  dbE.prepare("DELETE FROM convoys WHERE citizen_id = ? AND building = 'health'").run(dId);
  dbE.prepare('UPDATE citizens SET level = 1 WHERE id = ?').run(dId);
  dbE.prepare('UPDATE users SET premium_until = 0 WHERE id = ?').run(meD.user.id);
  r = await D.get('/api/me');
  check('Cap kembali 100 setelah bonus dicabut', r.data.citizen.energyCap === 100, `cap=${r.data.citizen.energyCap}`);
  dbE.close();

  console.log('  [22i] Pengumuman update (Apa yang Baru)');
  r = await C.get('/api/announcements');
  const seeded = (r.data.announcements || []).find((a) => a.num === 1);
  check('Pengumuman Update #1 ter-seed (Tahap 4)', r.status === 200 && !!seeded && /Pasar Lebih Dalam/.test(seeded.title), `n=${r.data.announcements?.length}`);
  check('Update #1 berisi regen + cap level + perisai + suara', !!seeded && /\+2/.test(seeded.body) && /perisai/i.test(seeded.body) && /ketukan/i.test(seeded.body));
  const unread0 = r.data.unreadCount;
  check('Pengumuman belum dibaca terhitung', unread0 >= 1, `unread=${unread0}`);
  r = await C.post('/api/announcements/read', { id: seeded.id });
  check('Tandai dibaca berhasil', r.status === 200);
  r = await C.get('/api/announcements');
  check('Unread berkurang 1 setelah dibaca', r.data.unreadCount === unread0 - 1, `unread=${r.data.unreadCount}`);
  r = await C.post('/api/announcements/read', { id: 999999 });
  check('Tandai dibaca id tidak ada → 404', r.status === 404);
  r = await C.post('/api/announcements/read', {});
  check('Tandai dibaca tanpa id → 400', r.status === 400);
  r = await C.post('/api/admin/announcements', { title: 'X', body: 'Y' });
  check('Pemain biasa tidak bisa membuat pengumuman (403)', r.status === 403);
  r = await ADM.post('/api/admin/announcements', { title: 'Update Tes E2E', body: 'Isi tes.' });
  check('Admin membuat pengumuman', r.status === 200 && !!r.data.id, `status=${r.status} ${r.data.error || ''}`);
  const annTestId = r.data.id;
  r = await C.get('/api/announcements');
  const newest = (r.data.announcements || [])[0];
  check('Pengumuman baru = Update #2 (terbaru dulu)', !!newest && newest.num === 2 && newest.title === 'Update Tes E2E', JSON.stringify(newest));
  check('Unread naik lagi (pengumuman baru belum dibaca)', r.data.unreadCount === 1, `unread=${r.data.unreadCount}`);
  r = await ADM.post('/api/admin/announcements', { title: '', body: 'X' });
  check('Pengumuman tanpa judul ditolak (400)', r.status === 400);
  r = await ADM.post(`/api/admin/announcements/${annTestId}/delete`);
  check('Admin menghapus pengumuman', r.status === 200);
  r = await ADM.post(`/api/admin/announcements/${annTestId}/delete`);
  check('Hapus pengumuman yang sama lagi → 404', r.status === 404);
  r = await ADM.get('/api/admin/market-flags');
  check('Admin melihat tanda pasar (price_band + wash_trade)', r.status === 200 && (r.data.flags || []).some((f) => f.kind === 'price_band') && (r.data.flags || []).some((f) => f.kind === 'wash_trade'), `flags=${(r.data.flags || []).length}`);
  r = await C.get('/api/admin/market-flags');
  check('Pemain biasa tidak bisa melihat tanda pasar (403)', r.status === 403);

  console.log('  [22j] Hadiah barang tanpa batas jumlah');
  const besiC0 = (await C.get('/api/inventory')).data.items.find((x) => x.name === 'Besi Mentah')?.qty || 0;
  r = await ADM.post('/api/admin/item', { user_id: cUserId, commodity: 'Besi Mentah', tier: 1, qty: 50000 });
  check('Grant 50.000× Besi Mentah lolos (tanpa batas)', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  const besiC1 = (await C.get('/api/inventory')).data.items.find((x) => x.name === 'Besi Mentah')?.qty || 0;
  check('Inventaris C bertambah 50.000 Besi', besiC1 === besiC0 + 50000, `${besiC0} → ${besiC1}`);
  r = await ADM.post('/api/admin/item', { user_id: cUserId, commodity: 'Besi Mentah', tier: 1, qty: 0 });
  check('Grant barang 0 tetap ditolak (400)', r.status === 400);
  r = await ADM.post('/api/admin/item', { user_id: cUserId, commodity: 'Besi Mentah', tier: 1, qty: -5 });
  check('Grant barang negatif tetap ditolak (400)', r.status === 400);
  r = await ADM.post('/api/admin/item', { user_id: cUserId, commodity: 'Besi Mentah', tier: 1, qty: 10.5 });
  check('Grant barang pecahan tetap ditolak (400)', r.status === 400);
  r = await ADM.post('/api/admin/gift-all', { kind: 'item', commodity: 'Kayu', tier: 1, amount: 50000 });
  check('Gift-all 50.000× Kayu lolos (tanpa batas)', r.status === 200 && r.data.recipients >= 1, `status=${r.status} ${r.data.error || ''}`);
  const kayuC = (await C.get('/api/inventory')).data.items.find((x) => x.name === 'Kayu')?.qty || 0;
  check('C menerima 50.000× Kayu dari gift-all', kayuC === 50000, `kayu=${kayuC}`);
  r = await ADM.post('/api/admin/gift-all', { kind: 'item', commodity: 'Kayu', tier: 1, amount: 0 });
  check('Gift-all barang 0 tetap ditolak (400)', r.status === 400);
  r = await ADM.post('/api/admin/gold', { user_id: cUserId, amount: 1000001 });
  check('Batas emas 1.000.000 TIDAK berubah (400)', r.status === 400);

  stop();
  console.log(`\n[e2e] SELESAI: ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[e2e] ERROR:', e); process.exit(1); });
