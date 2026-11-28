// Parlementer — tes end-to-end (SQLite lokal, DB sekali pakai di /tmp).
// Alur: daftar → login → klaim → latih → lamar kerja → shift → pasar (jual/beli)
// → makan → valas → perjalanan → chat → lapor → aturan (partai level 10, min. penawaran).
// Jalankan: npm test   (atau: node test/e2e.js)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ONLINE_WINDOW_MS, isOnline, formatLastSeenId, onlineStatus } from '../src/game.js';

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
  constructor() { this.cookie = ''; this.extraHeaders = {}; }
  async req(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...this.extraHeaders, ...(this.cookie ? { Cookie: this.cookie } : {}) },
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
  patch(p, b) { return this.req('PATCH', p, b || {}); }
  delete(p) { return this.req('DELETE', p); }
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
      env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'e2e-test-secret', ADMIN_BOOTSTRAP_CODE: 'e2e-bootstrap-code', ADINPLAY_PROPERTY_ID: 'e2e-test-property', ADSENSE_BANNER_SLOT: 'e2e-test-banner-slot', AUTO_WORK_INTERVAL_MS: '500' },
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
  check('Wilayah awal adalah salah satu wilayah yang ada (acak, bukan hardcode)', (await A.get('/api/regions')).data.regions.some((x) => x.id === me0.region_id), `region=${r.data.region.name} (id ${me0.region_id})`);
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
  check('Klaim berhasil: +5 emas, +50 USD, +40 XP', r.status === 200 && r.data.reward.gold === 5 && r.data.reward.usd === 50 && r.data.reward.xp === 40);
  r = await A.post('/api/claim');
  check('Klaim kedua di hari yang sama ditolak', r.status === 400);
  r = await A.get('/api/me');
  check('Saldo setelah klaim: 55 emas, 550 USD, XP 40', r.data.citizen.gold === 55 && r.data.citizen.usd === 550 && r.data.citizen.xp === 40);

  console.log('\n[4] Latihan atribut');
  r = await A.post('/api/train', { attr: 'str' });
  check('Latih Kekuatan berhasil (biaya 1 emas)', r.status === 200 && r.data.cost === 1 && r.data.level === 1);
  r = await A.get('/api/me');
  check('Emas 54, Kekuatan 1, XP 60', r.data.citizen.gold === 54 && r.data.citizen.attr_str === 1 && r.data.citizen.xp === 60);

  console.log('\n[5] Pekerjaan ADMIN (dibayar bahan mentah) & shift');
  r = await A.get('/api/jobs');
  const adminJobs = r.data.jobs.filter((j) => j.is_admin === 1);
  check('Ada 18 lowongan ADMIN (satu per wilayah, Kepri 2)', adminJobs.length === 18, `ditemukan ${adminJobs.length}`);
  check('Lowongan ADMIN ada di semua 17 wilayah',
    new Set(adminJobs.map((j) => j.region_id)).size === 17,
    `wilayah=${[...new Set(adminJobs.map((j) => j.region_id))].length}`);
  check('Semua lowongan ADMIN tanpa batas kursi (seats 1.000.000)',
    adminJobs.every((j) => j.seats === 1000000), `seats=${[...new Set(adminJobs.map((j) => j.seats))].join(',')}`);
  check('Semua lowongan ADMIN dibayar bahan mentah (bukan USD)',
    adminJobs.every((j) => j.salary_type === 'goods' && j.resource && j.pay_qty > 0),
    adminJobs.map((j) => `${j.title}:${j.resource}×${j.pay_qty}`).join(', '));
  check('Nilai setara terbaik ADMIN 48 USD', r.data.stats.best === 48, `best=${r.data.stats.best}`);
  const job = adminJobs.find((j) => j.title === 'Pekerja Gudang Pelabuhan');
  check('Lowongan "Pekerja Gudang Pelabuhan" ada (44× Besi Mentah, Kepulauan Riau)', !!job && job.resource === 'Besi Mentah' && job.pay_qty === 44);
  // Melamar mensyaratkan warga berada di wilayah lowongan — sejak Tahap 5
  // wilayah lahir acak, jadi A bepergian dulu bila belum di sana.
  const meA5 = await A.get('/api/me');
  if (meA5.data.citizen.region_id !== job.region_id) {
    r = await A.post('/api/regions/travel', { region_id: job.region_id });
    check('A bepergian ke wilayah lowongan (biaya 1 Tiket)', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
    // Waktu tempuh (27 Nov 2026): perjalanan belum tiba — paksa tiba
    // dengan memundurkan jam tiba di DB, lalu /api/me menyelesaikan
    // kedatangan. Lamaran mensyaratkan warga BERADA di wilayah lowongan.
    const db5 = new DatabaseSync(DB_PATH);
    db5.prepare('UPDATE citizens SET travel_arrives_at = ? WHERE id = ?').run(Date.now() - 1000, meA5.data.citizen.id);
    db5.close();
    r = await A.get('/api/me');
    check('A tiba di wilayah lowongan setelah waktu tempuh', r.data.citizen.region_id === job.region_id, `region=${r.data.region?.name}`);
  }
  r = await A.post('/api/jobs/apply', { job_id: job.id });
  check('Lamar pekerjaan berhasil', r.status === 200 && r.data.ok);
  r = await A.post('/api/jobs/shift');
  // Tahap 6: hari 1 = minggu Panen Raya — upah ADMIN +20%, jadi bayaran
  // = effectiveQty (52), bukan pay_qty dasar (44). effectiveQty dari
  // /api/jobs adalah angka yang sama dengan yang dibayarkan shift.
  check(`Shift selesai: dibayar ${job.effectiveQty}× Besi Mentah (panen +20%)`, r.status === 200 && r.data.goods === `${job.effectiveQty}× Besi Mentah`, `goods=${r.data.goods}`);
  // Conversion tracking (v5.3.0): shift pertama A menandai firstShift=true.
  check('Shift pertama A: firstShift=true (pemicu event mulai_bermain)', r.data.firstShift === true, `firstShift=${r.data.firstShift}`);
  r = await A.get('/api/me');
  check('Energi 0 setelah shift, USD tetap 550 (tanpa gaji uang)', r.data.citizen.energy === 0 && eq(r.data.citizen.usd, 550), `energi=${r.data.citizen.energy} usd=${r.data.citizen.usd}`);
  r = await A.get('/api/inventory');
  const besi = r.data.items.find((i) => i.name === 'Besi Mentah');
  check(`Inventaris: ${job.effectiveQty}× Besi Mentah T1 dari shift`, besi && besi.qty === job.effectiveQty && besi.tier === 1, `besi=${besi?.qty}`);
  // Shift kedua A (energi diisi ulang lewat DB): firstShift=false — event
  // 'mulai_bermain' tidak fire lagi. (Besi + XP ekstra dari shift ini
  // tidak dipakai cek lain; A tetap Level 1.)
  {
    const db5c = new DatabaseSync(DB_PATH);
    db5c.prepare('UPDATE citizens SET energy = ?, energy_updated_at = ? WHERE id = ?').run(100, Date.now(), meA5.data.citizen.id);
    db5c.close();
  }
  r = await A.post('/api/jobs/shift');
  check('Shift kedua A: firstShift=false', r.status === 200 && r.data.firstShift === false, `status=${r.status} firstShift=${r.data.firstShift}`);

  console.log('\n[6] Pasar — mulai kosong (tanpa bot)');
  r = await A.get('/api/market?scope=local');
  check('Pasar lokal: 0 penawaran', r.data.stats.offers === 0, `offers=${r.data.stats.offers}`);
  check('16 komoditas terdaftar (15 + Minuman Energi v3.1.0)', r.data.commodities.length === 16);
  r = await A.get('/api/market?scope=global');
  check('Pasar Global: 0 penawaran', r.data.stats.offers === 0);
  const makanan = r.data.commodities.find((c) => c.name === 'Makanan');

  console.log('\n[6b] Redesain dunia — dunia terpecah, dirikan negara (Nusantara)');
  // Dunia baru TANPA negara: 0 negara, semua wilayah merdeka, parlemen
  // terkunci sampai 2 Des 2026 (countdown di HUD).
  r = await A.get('/api/world');
  check('Dunia baru: 0 negara', r.data.countries === 0, `countries=${r.data.countries}`);
  r = await A.get('/api/regions');
  check('Semua 17 wilayah merdeka (tanpa negara)', r.data.regions.every((x) => x.country_name == null && x.country_id == null), JSON.stringify(r.data.regions.map((x) => x.country_name)));
  r = await A.get('/api/country');
  check('A belum bernegara (country null)', r.data.country === null, JSON.stringify(r.data.country));
  check('Halaman Negara menampilkan aturan pembentukan (Level 10 + 100 emas)', r.data.formationRules?.minLevel === 10 && r.data.formationRules?.costGold === 100, JSON.stringify(r.data.formationRules));
  check('Halaman Negara menampilkan 4 ideologi + 4 sistem pemerintahan', (r.data.ideologies || []).length === 4 && (r.data.systems || []).length === 4, `ideologi=${(r.data.ideologies || []).length} sistem=${(r.data.systems || []).length}`);
  r = await A.get('/api/parliament');
  check('Parlemen terkunci (belum 2 Des 2026)', r.data.parliamentOpen === false && r.data.parliamentOpensAt === 1796144400000, `open=${r.data.parliamentOpen} opensAt=${r.data.parliamentOpensAt}`);
  check('Tanpa negara: pajak 0%, upah ×1, perjalanan 1 tiket', r.data.effects?.taxIncome === 0 && r.data.effects?.adminPayMult === 1 && r.data.effects?.travelTickets === 1, JSON.stringify(r.data.effects));
  r = await A.post('/api/parliament/law', { title: 'UU Tes Terkunci', content: 'Isi undang-undang tes.', kind: 'general' });
  check('Usul UU sebelum parlemen dibuka ditolak 403', r.status === 403, `status=${r.status}`);
  r = await A.post('/api/country/budget', { kind: 'claim', amount: 100 });
  check('Usul anggaran sebelum parlemen dibuka ditolak 403', r.status === 403, `status=${r.status}`);
  // Negatif pembentukan negara (A Level 1, emas ~54).
  r = await A.post('/api/countries', { name: 'Nusantara', ideology: 'Konservatisme', system: 'presidensial' });
  check('Dirikan negara di Level 1 ditolak (butuh Level 10)', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  const db6b = new DatabaseSync(DB_PATH);
  const meA6b = (await A.get('/api/me')).data.citizen;
  const goldA6b = meA6b.gold;
  // Ibu kota Nusantara = wilayah ASAL A (home_region_id) — dicatat untuk
  // [22]/[22d]/[28] yang dulu hardcode region 1 sebagai ibu kota.
  const nusantaraCapitalId = meA6b.home_region_id;
  // Ibu kota = wilayah ASAL A (home_region_id) — pendirian negara
  // mengikuti kewarganegaraan, bukan lokasi kunjungan saat ini.
  const regionA6b = (await A.get('/api/me')).data.homeRegion.name;
  db6b.prepare('UPDATE citizens SET level = 10 WHERE id = ?').run(meA6b.id);
  r = await A.post('/api/countries', { name: 'Nusantara', ideology: 'Konservatisme', system: 'presidensial' });
  check('Dirikan negara dengan emas <100 ditolak', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  db6b.prepare('UPDATE citizens SET gold = 200 WHERE id = ?').run(meA6b.id);
  r = await A.post('/api/countries', { name: 'Nu', ideology: 'Konservatisme', system: 'presidensial' });
  check('Nama negara <3 karakter ditolak', r.status === 400, `status=${r.status}`);
  r = await A.post('/api/countries', { name: 'Nusantara', ideology: 'Anarkisme', system: 'presidensial' });
  check('Ideologi tidak dikenal ditolak', r.status === 400, `status=${r.status}`);
  r = await A.post('/api/countries', { name: 'Nusantara', ideology: 'Konservatisme', system: 'monarki' });
  check('Sistem tidak dikenal ditolak', r.status === 400, `status=${r.status}`);
  r = await A.post('/api/countries', { name: 'Nusantara', ideology: 'Konservatisme', system: 'presidensial' });
  check('A mendirikan Nusantara (Level 10 + 100 emas)', r.status === 200 && !!r.data.countryId, `status=${r.status} ${r.data.error || ''}`);
  const nusantaraId = r.data.countryId;
  check('Emas A berkurang 100 (200 → 100)', (await A.get('/api/me')).data.citizen.gold === 100);
  r = await A.post('/api/countries', { name: 'Negara Kedua', ideology: 'Konservatisme', system: 'presidensial' });
  check('Wilayah sudah bernegara tidak bisa mendirikan negara lagi', r.status === 400, `status=${r.status}`);
  r = await A.get('/api/country');
  check('A kini warga Nusantara', r.data.country?.name === 'Nusantara', JSON.stringify(r.data.country));
  check('Ibu kota = wilayah asal A', r.data.country?.capital === regionA6b, `capital=${r.data.country?.capital} wilayah=${regionA6b}`);
  r = await A.get('/api/countries');
  check('Dunia kini 1 negara', (r.data.countries || []).length === 1, `countries=${(r.data.countries || []).length}`);
  r = await A.get('/api/regions');
  const capRegion = r.data.regions.find((x) => x.name === regionA6b);
  check('Wilayah ibu kota bernegara, 16 wilayah lain tetap merdeka', capRegion?.country_name === 'Nusantara' && r.data.regions.filter((x) => x.country_name == null).length === 16, `merdeka=${r.data.regions.filter((x) => x.country_name == null).length}`);
  // Pemilu pertama terjadwal otomatis (DB): presiden +7 hari, parlemen
  // paling cepat 2 Des 2026.
  const elPres = db6b.prepare("SELECT * FROM elections WHERE country_id = ? AND type = 'president' AND status = 'scheduled'").get(nusantaraId);
  const elParl = db6b.prepare("SELECT * FROM elections WHERE country_id = ? AND type = 'parliament' AND status = 'scheduled'").get(nusantaraId);
  check('Pemilu presiden terjadwal +7 hari', !!elPres && Math.abs(elPres.opens_at - (Date.now() + 7 * 86400000)) < 60000, `opens_at=${elPres?.opens_at}`);
  check('Pemilu parlemen terjadwal paling cepat 2 Des 2026', !!elParl && elParl.opens_at >= 1796144400000, `opens_at=${elParl?.opens_at}`);
  check('Negara baru: presiden kosong (dipilih lewat pemilu)', db6b.prepare('SELECT president_id FROM country WHERE id = ?').get(nusantaraId).president_id === null);
  // Kembalikan Level + emas A seperti sebelum [6b] agar [8]/[11] tidak
  // berubah (Level 1, emas awal).
  db6b.prepare('UPDATE citizens SET level = 1, gold = ? WHERE id = ?').run(goldA6b, meA6b.id);
  db6b.close();

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
  // Redesain dunia: B lahir di wilayah acak (merdeka, pajak 0%) — pindah
  // B ke wilayah asal A (Nusantara) agar pajak penjual 2% berlaku di bawah
  // ini. Pajak mengikuti KEWARGANEGARAAN (home_region_id), jadi keduanya
  // disetel; pasar sendiri tidak dibatasi wilayah.
  const db7 = new DatabaseSync(DB_PATH);
  const regionA7 = (await A.get('/api/me')).data.citizen.home_region_id;
  db7.prepare('UPDATE citizens SET region_id = ?, home_region_id = ? WHERE id = ?').run(regionA7, regionA7, meB.data.citizen.id);
  db7.close();
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

  console.log('\n[9] Peta & perjalanan (kunjungan + waktu tempuh, 27 Nov 2026)');
  r = await A.get('/api/regions');
  check('17 wilayah terdaftar', r.data.regions.length === 17, `jumlah=${r.data.regions.length}`);
  const jakarta = r.data.regions.find((x) => x.name === 'Jakarta');
  check('Daftar wilayah mencantumkan waktu tempuh dari lokasi saat ini', r.data.regions.every((x) => typeof x.travelMinutes === 'number' && x.travelMinutes >= 0), `contoh Jakarta=${jakarta.travelMinutes} mnt`);
  check('Kepri → Jakarta ±10 menit (jarak ±830 km)', jakarta.travelMinutes >= 8 && jakarta.travelMinutes <= 12, `Jakarta dari Kepri=${jakarta.travelMinutes} mnt`);
  const homeBefore = (await A.get('/api/me')).data.citizen.home_region_id;
  const tiketBefore9 = (await A.get('/api/inventory')).data.items.find((i) => i.name === 'Tiket')?.qty ?? 0;
  r = await A.post('/api/regions/travel', { region_id: jakarta.id });
  check('Perjalanan ke Jakarta dimulai (1 Tiket, ada waktu tempuh)', r.status === 200 && r.data.region === 'Jakarta' && r.data.inTransit === true && r.data.travelMinutes > 0 && r.data.arrivesAt > Date.now(), `status=${r.status} ${JSON.stringify(r.data)}`);
  r = await A.get('/api/me');
  check('Masih transit: lokasi BELUM berubah + status perjalanan ada', r.data.region.name !== 'Jakarta' && !!r.data.travel && r.data.travel.toRegionName === 'Jakarta' && r.data.travel.remainingMs > 0, `region=${r.data.region.name} travel=${JSON.stringify(r.data.travel)}`);
  check('Kewarganegaraan TIDAK berubah selama perjalanan (bug LIO)', r.data.citizen.home_region_id === homeBefore, `home=${r.data.homeRegion?.name}`);
  check('Negara tetap Nusantara selama kunjungan (pajak/voting ikut asal)', r.data.country?.name === 'Nusantara', JSON.stringify(r.data.country));
  r = await A.post('/api/regions/travel', { region_id: jakarta.id });
  check('Bepergian lagi saat transit ditolak (400)', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  // Paksa tiba: mundurkan jam tiba di DB, lalu /api/me menyelesaikan
  // kedatangan (penyelesaian malas — tanpa cron/tick).
  const db9 = new DatabaseSync(DB_PATH);
  db9.prepare('UPDATE citizens SET travel_arrives_at = ? WHERE id = ?').run(Date.now() - 1000, (await A.get('/api/me')).data.citizen.id);
  db9.close();
  r = await A.get('/api/me');
  check('Setelah waktu habis: lokasi kini Jakarta, transit selesai', r.data.region.name === 'Jakarta' && !r.data.travel, `region=${r.data.region.name} travel=${JSON.stringify(r.data.travel)}`);
  check('Kewarganegaraan tetap wilayah asal setelah tiba', r.data.citizen.home_region_id === homeBefore, `home=${r.data.homeRegion?.name}`);
  check('Negara tetap Nusantara setelah tiba di Jakarta', r.data.country?.name === 'Nusantara', JSON.stringify(r.data.country));
  r = await A.get('/api/inventory');
  const tiket = r.data.items.find((i) => i.name === 'Tiket');
  // A mungkin sudah memakai 1 Tiket di [5] (bepergian ke wilayah lowongan
  // karena lahir acak) — jadi yang dicek adalah pengurangan 1, bukan angka mutlak.
  check('Sisa Tiket T1 berkurang 1 setelah perjalanan', tiket && tiket.qty === tiketBefore9 - 1, `tiket=${tiket?.qty} (sebelum ${tiketBefore9})`);
  r = await A.post('/api/regions/travel', { region_id: jakarta.id });
  check('Bepergian ke wilayah sendiri ditolak (400)', r.status === 400, `status=${r.status}`);

  console.log('\n[9b] Pindah kewarganegaraan (aksi terpisah dari travel)');
  // A kini di Jakarta (tiba di [9]); kewarganegaraan masih wilayah asal
  // (ibu kota Nusantara). Pindah ke Jakarta — harus berhasil karena A
  // sedang berada di sana.
  // LAHIR ACAK (Tahap 5): bila wilayah asal A kebetulan Jakarta, Jakarta
  // sudah menjadi kewarganegaraannya — tujuan pindah diganti Jawa Barat
  // (wilayah merdeka lain); A dipindah ke sana lewat DB tes supaya tidak
  // menghabiskan Tiket ekstra (jatah 3 Tiket sudah pas untuk alur normal).
  let dest9b = jakarta;
  if (homeBefore === jakarta.id) {
    const regs9b = (await A.get('/api/regions')).data.regions;
    dest9b = regs9b.find((x) => x.name === 'Jawa Barat');
    const meA9bPre = (await A.get('/api/me')).data;
    const db9x = new DatabaseSync(DB_PATH);
    db9x.prepare('UPDATE citizens SET region_id = ? WHERE id = ?').run(dest9b.id, meA9bPre.citizen.id);
    db9x.close();
    check('A lahir di Jakarta — tujuan pindah dialihkan ke Jawa Barat', !!dest9b, `dest=${dest9b?.name}`);
  }
  r = await A.post('/api/regions/move', { region_id: dest9b.id });
  check(`Pindah kewarganegaraan ke ${dest9b.name} berhasil (sedang di sana)`, r.status === 200 && r.data.region === dest9b.name, `status=${r.status} ${r.data.error || ''}`);
  const meA9b = (await A.get('/api/me')).data;
  check(`Kewarganegaraan kini ${dest9b.name}`, meA9b.citizen.home_region_id === dest9b.id, `home=${meA9b.homeRegion?.name}`);
  check(`Negara mengikuti kewarganegaraan baru (${dest9b.name} merdeka → tanpa negara)`, meA9b.country === null, JSON.stringify(meA9b.country));
  // Pindah lagi langsung ditolak — tapi A harus berada di wilayah tujuan
  // dulu; bepergian kembali ke wilayah asal lama lalu coba pindah:
  r = await A.post('/api/regions/travel', { region_id: homeBefore });
  check('A bepergian kembali ke wilayah asal lama', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  const db9b = new DatabaseSync(DB_PATH);
  db9b.prepare('UPDATE citizens SET travel_arrives_at = ? WHERE id = ?').run(Date.now() - 1000, meA9b.citizen.id);
  db9b.close();
  await A.get('/api/me'); // selesaikan kedatangan
  r = await A.post('/api/regions/move', { region_id: homeBefore });
  check('Pindah lagi sebelum 7 hari ditolak (400, jeda)', r.status === 400 && /hari/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  // Mundurkan jam pindah 8 hari → pindah berhasil, negara kembali Nusantara.
  const db9c = new DatabaseSync(DB_PATH);
  db9c.prepare('UPDATE citizens SET home_changed_at = ? WHERE id = ?').run(Date.now() - 8 * 24 * 60 * 60 * 1000, meA9b.citizen.id);
  db9c.close();
  r = await A.post('/api/regions/move', { region_id: homeBefore });
  check('Setelah 7 hari: pindah kembali ke wilayah asal berhasil', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  const meA9c = (await A.get('/api/me')).data;
  check('Kewarganegaraan kembali wilayah asal; negara kembali Nusantara', meA9c.citizen.home_region_id === homeBefore && meA9c.country?.name === 'Nusantara', `home=${meA9c.homeRegion?.name} country=${meA9c.country?.name}`);
  // Pindah ke wilayah yang TIDAK sedang didiami ditolak:
  r = await A.post('/api/regions/move', { region_id: dest9b.id });
  check('Pindah ke wilayah yang tidak didiami ditolak (400)', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  // Pindah saat transit ditolak: mulai perjalanan ke tujuan pindah, coba
  // pindah sebelum tiba. Tiket awal A (3) sudah habis dipakai 3 perjalanan
  // sebelumnya — tambah 1 Tiket lewat DB tes agar perjalanan uji ini bisa
  // dimulai.
  const db9t = new DatabaseSync(DB_PATH);
  const tiketId9 = db9t.prepare("SELECT id FROM commodities WHERE name = 'Tiket'").get().id;
  db9t.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,1) ON CONFLICT (citizen_id, commodity_id, tier) DO UPDATE SET qty = qty + 1').run(meA9b.citizen.id, tiketId9);
  db9t.close();
  r = await A.post('/api/regions/travel', { region_id: dest9b.id });
  check(`A bepergian lagi ke ${dest9b.name} (untuk uji pindah saat transit)`, r.status === 200, `status=${r.status}`);
  r = await A.post('/api/regions/move', { region_id: dest9b.id });
  check('Pindah kewarganegaraan saat transit ditolak (400)', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  const db9d = new DatabaseSync(DB_PATH);
  db9d.prepare('UPDATE citizens SET travel_arrives_at = ? WHERE id = ?').run(Date.now() - 1000, meA9b.citizen.id);
  db9d.close();
  r = await A.get('/api/me');
  check(`A tiba di ${dest9b.name}; kewarganegaraan tetap wilayah asal (bukan ${dest9b.name})`, r.data.region.name === dest9b.name && r.data.citizen.home_region_id === homeBefore, `region=${r.data.region.name} home=${r.data.homeRegion?.name}`);

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
  // Perbaikan 4 (laporan Khalid): muat awal HARUS mengembalikan 100 pesan
  // TERBARU, bukan 100 tertua. Isi room wilayah A (region_<id> — room
  // 'negara' dihapus pada redesain dunia) dengan 120 pesan, lalu muat awal
  // harus berisi pesan #21..#120 (terbaru), dan polling dengan
  // since=pesan terakhir tidak mengembalikan duplikat.
  const wilayahA10 = (await A.get('/api/me')).data.citizen.region_id;
  const roomA10 = 'region_' + wilayahA10;
  const dbNew = new DatabaseSync(DB_PATH);
  const chatBase2 = Date.now() - 60000;
  const insMsg = dbNew.prepare('INSERT INTO chat_messages (citizen_id, room, content, created_at) VALUES (?,?,?,?)');
  for (let i = 1; i <= 120; i++) insMsg.run(meA.data.citizen.id, roomA10, 'pesan #' + i, chatBase2 + i * 1000);
  dbNew.close();
  r = await A.get('/api/chat/' + roomA10);
  check('Muat awal chat = 100 pesan TERBARU (bukan tertua)', r.data.messages.length === 100 && r.data.messages[0].content === 'pesan #21' && r.data.messages[99].content === 'pesan #120', `n=${r.data.messages.length} pertama=${r.data.messages[0]?.content} terakhir=${r.data.messages[99]?.content}`);
  check('Muat awal terurut kronologis (lama → baru)', r.data.messages.every((m, i, arr) => i === 0 || m.created_at >= arr[i - 1].created_at));
  const lastSeen = r.data.messages[99].created_at;
  r = await A.get('/api/chat/' + roomA10 + '?since=' + lastSeen);
  check('Polling dengan since=terakhir tidak mengembalikan duplikat (0 pesan)', r.data.messages.length === 0, `n=${r.data.messages.length}`);
  const dbNew2 = new DatabaseSync(DB_PATH);
  dbNew2.prepare('INSERT INTO chat_messages (citizen_id, room, content, created_at) VALUES (?,?,?,?)')
    .run(meA.data.citizen.id, roomA10, 'pesan #121', lastSeen + 1000);
  dbNew2.close();
  r = await A.get('/api/chat/' + roomA10 + '?since=' + lastSeen);
  check('Polling mengembalikan hanya pesan yang benar-benar baru (#121)', r.data.messages.length === 1 && r.data.messages[0].content === 'pesan #121', `n=${r.data.messages.length}`);

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
  check('A di Jakarta (kunjungan): tetap warga Nusantara (kewarganegaraan ikut asal, bukan lokasi)', r.data.country?.name === 'Nusantara' && (r.data.countries || []).length === 1, JSON.stringify(r.data.countries));

  console.log('\n[12] Daily tick — dunia maju 1 hari');
  // A masih login, energi 10 setelah makan. Mundurkan tanggal tick ke kemarin lewat DB tes.
  const dbTick = new DatabaseSync(DB_PATH);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  dbTick.prepare('UPDATE world SET last_tick_date = ? WHERE id = 1').run(yesterday);
  dbTick.close();
  await A.get('/api/me'); // request ini memicu maybeTick (async, tanpa await di middleware)
  // Tick dicek maksimal 1×/60 detik per instance (Tahap 5 — lag), jadi
  // tunggu sampai hari berubah (polling, maks ~66 detik) daripada sleep
  // tetap. Polling ini juga memicu maybeTick lewat middleware /api/.
  let day = 0;
  for (let i = 0; i < 33; i++) {
    await sleep(2000);
    r = await A.get('/api/world');
    day = r.data.day;
    if (day === 2) break;
  }
  check('Tick berjalan: hari dunia 1 → 2', day === 2, `day=${day}`);
  r = await A.get('/api/me');
  // Pulih penuh ke CAP level (100 di Level 1; 105 bila A naik ke Level 2
  // karena shift di jam ganda 00:00–01:00 WIB memberi XP ×2 — v3.1.0).
  check('Energi pulih penuh (ke cap level) setelah tick', r.data.citizen.energy === r.data.citizen.energyCap, `energi=${r.data.citizen.energy} cap=${r.data.citizen.energyCap}`);
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

  // Naik ke Level 3 lewat jalur normal: klaim (+40 XP) + 13 latih (str×5,
  // edu×5, eco×3 = 260 XP, biaya total 36 emas) = 300 XP = Level 3
  // (100 + 200). Skala XP v3.1.0 (×20 dari 2/1 XP): kecepatan naik level
  // tidak berubah — Level 3 tetap butuh klaim + 13 latih.
  // setelah klaim 55, setelah latih 19, setelah bonus referral cair 119.
  // Jeda latihan: reset langsung di DB (pola yang sama seperti forceTick /
  // mundurkan tanggal di bawah) supaya helper levelTo3 bisa latih
  // beruntun tanpa menunggu jeda 2 menit × level.
  async function resetTrainCooldown(client) {
    const me = await client.get('/api/me');
    const dbR = new DatabaseSync(DB_PATH);
    dbR.prepare('UPDATE citizens SET train_str_at = 0, train_edu_at = 0, train_eco_at = 0 WHERE id = ?').run(me.data.citizen.id);
    dbR.close();
  }

  async function levelTo3(client) {
    let r = await client.post('/api/claim');
    if (r.status !== 200) return r;
    for (const a of ['str', 'str', 'str', 'str', 'str', 'edu', 'edu', 'edu', 'edu', 'edu', 'eco', 'eco', 'eco']) {
      await resetTrainCooldown(client);
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
  check('Pendaftar Level 3: 119 emas (19 + 100 bonus referral)', r.data.citizen.gold === 119, `emas=${r.data.citizen.gold}`);
  check('Pendaftar Level 3: premium aktif 1 hari', r.data.citizen.isPremium && r.data.citizen.premium_until > nowMs && r.data.citizen.premium_until <= nowMs + 86400000 + 60000, `until=${r.data.citizen.premium_until}`);
  r = await R.get('/api/me');
  check('Referrer: 250 emas (50 + 200 bonus)', r.data.citizen.gold === 250, `emas=${r.data.citizen.gold}`);
  check('Referrer: premium aktif ~2 hari', r.data.citizen.isPremium && r.data.citizen.premium_until > nowMs + 86400000 && r.data.citizen.premium_until <= nowMs + 2 * 86400000 + 60000);
  check('Referrer: 1 pemakai kode, +200 emas referral cair', r.data.referral.uses === 1 && r.data.referral.goldEarned === 200);

  r = await X.post('/api/auth/register', { email: 'ref3@test.local', password: 'rahasia123', username: 'pendaftar_dua', ref: refCode.toLowerCase() });
  check('Kode referral huruf kecil tetap berlaku', r.status === 200 && r.data.ok);
  r = await X.get('/api/me');
  check('Pendaftar kedua: 50 emas, tanpa premium', r.data.citizen.gold === 50 && !r.data.citizen.isPremium);
  r = await R.get('/api/me');
  check('Referrer: 2 pemakai kode, bonus cair masih 200', r.data.referral.uses === 2 && r.data.referral.goldEarned === 200);
  r = await levelTo3(X);
  check('Pendaftar kedua naik ke Level 3', r.status === 200, r.data.error || '');
  r = await R.get('/api/me');
  check('Referrer: 2 pemakai kode, +400 emas referral cair', r.data.referral.uses === 2 && r.data.referral.goldEarned === 400);
  check('Referrer: 450 emas (50 + 400 bonus)', r.data.citizen.gold === 450, `emas=${r.data.citizen.gold}`);

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
  // (skipped): R tetap 1000 emas cair, pendaftar itu tetap 19 emas.
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
  check('Referrer: 6 pemakai kode, 1000 emas referral cair (5 bonus maks/hari)', r.data.referral.uses === 6 && r.data.referral.goldEarned === 1000, `uses=${r.data.referral.uses} earned=${r.data.referral.goldEarned}`);
  check('Referrer: 1050 emas (50 + 1000 bonus)', r.data.citizen.gold === 1050, `emas=${r.data.citizen.gold}`);
  r = await caps[3].get('/api/me');
  check('Pendaftar cap ke-6 (bonus tertunda): 19 emas, tanpa premium', r.data.citizen.gold === 19 && !r.data.citizen.isPremium, `emas=${r.data.citizen.gold}`);
  r = await caps[2].get('/api/me');
  check('Pendaftar cap ke-5 (bonus cair): 119 emas + premium', r.data.citizen.gold === 119 && r.data.citizen.isPremium, `emas=${r.data.citizen.gold}`);

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
  check('Profil sendiri: kode + 6 pemakai + 1000 emas referral', r.data.profile.referral && r.data.profile.referral.uses === 6 && r.data.profile.referral.goldEarned === 1000 && r.data.profile.referral.code === refCode);
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
  // Batas foto profil 500 KB (dinaikkan dari 100 KB, permintaan ADMIN):
  // 200 KB diterima, di atas 500 KB ditolak.
  const midBuf = Buffer.alloc(200 * 1024, 0);
  midBuf[0] = 0xFF; midBuf[1] = 0xD8; midBuf[2] = 0xFF;
  r = await A.post('/api/profile/avatar', { avatar: 'data:image/jpeg;base64,' + midBuf.toString('base64') });
  check('Avatar 200 KB diterima (di bawah batas 500 KB)', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  const bigBuf = Buffer.alloc(501 * 1024, 0);
  bigBuf[0] = 0xFF; bigBuf[1] = 0xD8; bigBuf[2] = 0xFF;
  const bigJpeg = 'data:image/jpeg;base64,' + bigBuf.toString('base64');
  r = await A.post('/api/profile/avatar', { avatar: bigJpeg });
  check('Avatar > 500 KB ditolak (400)', r.status === 400, r.data.error || '');
  // Kembalikan avatar A ke TINY_JPEG — tes 200 KB di atas mengubah avatar
  // A, dan asersi berikutnya mengharapkan avatar A = TINY_JPEG.
  r = await A.post('/api/profile/avatar', { avatar: TINY_JPEG, avatar_sm: TINY_JPEG_SM });
  check('Avatar A dikembalikan ke JPEG kecil', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
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
  // Lookup profil case-insensitive (Masalah 1): nama tampil huruf kapital
  // semua di UI, jadi tautan #/profile/NAMA-KAPITAL harus tetap ketemu
  // walau yang tersimpan huruf kecil. Sebelum perbaikan, lookup ini 404.
  r = await A.get('/api/profile/WARGA_SATU');
  check('Profil ditemukan walau nama diketik huruf kapital (WARGA_SATU)', r.status === 200 && r.data.profile.username === 'warga_satu', `status=${r.status}`);
  r = await A.get('/api/profile/Warga_Satu');
  check('Profil ditemukan walau nama diketik campur huruf (Warga_Satu)', r.status === 200 && r.data.profile.username === 'warga_satu', `status=${r.status}`);
  r = await A.get('/api/profile/tidak_ada_nama_ini');
  check('Profil yang memang tidak ada tetap 404', r.status === 404, `status=${r.status}`);
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
  const nBuyUsd = r.data.notifications.find((n) => n.title === 'Pembelian diterima' && (n.content || '').includes('Rp457.500 diterima dari pembelian'));
  check('Notifikasi pembelian Rupiah ("Rp457.500 diterima dari pembelian")', !!nBuyUsd, nBuyUsd?.content || '');
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
  // Hadiah massal Rupiah (konversi Rp→USD): admin mengetik Rp9.150 yang
  // dikirim sebagai 0,5 USD (pecahan) — JANGAN dibulatkan ke bawah, kalau
  // tidak hadiahnya jadi 0 dan ditolak. Notifikasi menampilkan Rupiah.
  const beforeUsdR = (await R.get('/api/me')).data.citizen.usd;
  r = await ADM.post('/api/admin/gift-all', { kind: 'usd', amount: 0.5, message: 'Bonus Rupiah!' });
  check('Hadiah massal Rp9.150 (0,5 USD) terkirim, tidak terpotong jadi 0', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  r = await R.get('/api/me');
  check('R menerima +0,5 USD dari hadiah massal Rupiah', eq(r.data.citizen.usd, beforeUsdR + 0.5), `usd=${r.data.citizen.usd} sebelum=${beforeUsdR}`);
  r = await R.get('/api/notifications');
  const nMassRp = r.data.notifications.find((n) => n.title === 'Hadiah dari admin' && (n.content || '').includes('Rp9.150'));
  check('Notifikasi hadiah massal Rupiah: "+Rp9.150"', !!nMassRp, nMassRp?.content || '');
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

  console.log('\n[17b] Hadiah massal: hitung penerima di atas 100 pemain');
  // Bug Khalid 28 Nov 2026: panel Hadiah Massal menampilkan "99 dari 100"
  // padahal populasi 216 — GET /api/admin/players LIMIT 100 tanpa COUNT,
  // jadi angka tampilan hanya menghitung 100 pemain pertama. Server
  // gift-all sendiri sudah benar (tanpa LIMIT); yang diperbaiki hanya
  // angka total/eligible di respons + tampilan panel.
  r = await ADM.get('/api/admin/players');
  check('GET /api/admin/players membawa total + eligible', typeof r.data.total === 'number' && typeof r.data.eligible === 'number', `total=${r.data.total} eligible=${r.data.eligible}`);
  const totalBefore = r.data.total;
  const eligBefore = r.data.eligible;
  check('Total = jumlah pemain saat masih di bawah 100', r.data.total === r.data.players.length, `total=${r.data.total} len=${r.data.players.length}`);
  // Daftarkan 100 pemain lagi → total melewati 100, daftar tetap terpotong.
  // Batas daftar 20/IP/24 jam — sebar 100 pemain ke 5 IP berbeda lewat
  // X-Forwarded-For (pola yang sama seperti [23b]/[28]/[5b]).
  let bulkOk = 0;
  for (let i = 1; i <= 100; i++) {
    const C = new Client();
    C.extraHeaders = { 'X-Forwarded-For': `127.0.0.${101 + Math.floor((i - 1) / 20)}` };
    const rr = await C.post('/api/auth/register', { email: `bulk${i}@test.local`, password: 'rahasia123', username: `pemain_bulk${i}` });
    if (rr.status === 200 && rr.data.ok) bulkOk++;
  }
  check('100 pemain bulk terdaftar', bulkOk === 100, `terdaftar=${bulkOk}`);
  r = await ADM.get('/api/admin/players');
  check('Daftar pemain tetap dibatasi 100 baris', r.data.players.length === 100, `len=${r.data.players.length}`);
  check('Total menghitung semua pemain (bukan 100)', r.data.total === totalBefore + 100, `total=${r.data.total} sebelum=${totalBefore}`);
  check('Eligible menghitung semua yang tidak di-ban', r.data.eligible === eligBefore + 100, `eligible=${r.data.eligible} sebelum=${eligBefore}`);
  // Ban satu pemain bulk → eligible turun 1, total tetap.
  const bulkOne = r.data.players.find((p) => p.username === 'pemain_bulk1');
  check('Pemain bulk1 ada di daftar 100 pertama', !!bulkOne, bulkOne?.username || '');
  r = await ADM.post('/api/admin/ban', { user_id: bulkOne.id, reason: 'Tes hitung penerima' });
  check('Admin: ban pemain bulk1', r.status === 200 && r.data.ok, `status=${r.status}`);
  r = await ADM.get('/api/admin/players');
  check('Total tetap setelah ban', r.data.total === totalBefore + 100, `total=${r.data.total}`);
  check('Eligible turun 1 setelah ban', r.data.eligible === eligBefore + 99, `eligible=${r.data.eligible}`);
  r = await ADM.post('/api/admin/unban', { user_id: bulkOne.id });
  check('Admin: unban pemain bulk1 kembali', r.status === 200 && r.data.ok);
  // Filter pencarian ikut dihitung: total/eligible mengikuti filter q.
  r = await ADM.get('/api/admin/players?q=pemain_bulk');
  check('Pencarian bulk: total 100 pemain bulk', r.data.total === 100, `total=${r.data.total}`);
  check('Pencarian bulk: eligible 100 (tidak ada yang di-ban)', r.data.eligible === 100, `eligible=${r.data.eligible}`);

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
  r = await ADM.post('/api/admin/reports/' + repId + '/review', { verdict: 'not_proven' });
  check('Admin menandai laporan ditinjau (putusan tidak terbukti)', r.status === 200 && r.data.status === 'reviewed' && r.data.verdict === 'not_proven');
  r = await ADM.get('/api/admin/reports');
  check('Laporan tampil sebagai sudah ditinjau', r.data.reports.find((x) => x.id === repId)?.status === 'reviewed' && r.data.reports.find((x) => x.id === repId)?.verdict === 'not_proven');
  r = await ADM.post('/api/admin/reports/' + repId + '/review', { verdict: 'proven' });
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
  // Tahap 6: Industri Ringan kini butuh 1× Gandum Mentah per 1× Makanan —
  // beri bahan supaya produksi 8→9 (+10% Gudang Industri) tetap jalan.
  // v4.6.0: bahan produksi diambil dari STOK perusahaan, bukan inventaris
  // pemilik — isi stok lewat endpoint baru (bahan pindah inventaris → stok).
  const gandumCv = dbCv.prepare("SELECT id FROM commodities WHERE name = 'Gandum Mentah'").get();
  dbCv.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,?)').run(aId, gandumCv.id, 20);
  const cvCompanyId = dbCv.prepare("SELECT id FROM companies WHERE owner_id = ? AND name = 'Perusahaan Tes'").get(aId)?.id;
  r = await A.post(`/api/companies/${cvCompanyId}/stock`, { commodity: 'Gandum Mentah', qty: 20 });
  check('Stok perusahaan: 20 Gandum masuk stok', r.status === 200 && r.data.stock?.[0]?.qty === 20, `status=${r.status} ${r.data.error || ''}`);
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
  await resetTrainCooldown(A);
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
  // Redesain dunia: C/D lahir di wilayah acak (merdeka, pajak 0%) —
  // pindah keduanya ke wilayah Nusantara (region 1, ibu kota) agar pajak
  // penjual 2% + kas negara bisa dicek di [22c]/[22d] di bawah ini.
  // Pajak mengikuti kewarganegaraan (home_region_id), jadi keduanya disetel.
  db4.prepare('UPDATE citizens SET region_id = ?, home_region_id = ? WHERE id IN (?,?)').run(nusantaraCapitalId, nusantaraCapitalId, cId, dId);
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

  console.log('  [22c] Order beli tanpa escrow + pajak ke kas negara');
  const usdC0 = (await C.get('/api/me')).data.citizen.usd;
  check('C mulai dengan 500 USD', usdC0 === 500, `usd=${usdC0}`);
  r = await C.post('/api/market/buy-order', { scope: 'local', commodity_id: besiId, tier: 1, qty: 10, price: 9 });
  check('Order beli 10× Besi @9 dipasang', r.status === 200 && !!r.data.orderId, `status=${r.status} ${r.data.error || ''}`);
  const buyOrderId = r.data.orderId;
  check('Pasang order TIDAK memotong saldo (tetap 500 USD)', (await C.get('/api/me')).data.citizen.usd === 500);
  r = await C.get('/api/market?scope=local');
  const listedOrder = (r.data.buyOrders || []).find((o) => o.id === buyOrderId);
  check('Order beli tampil di order book', !!listedOrder && listedOrder.buyer === 'tahap4_c' && listedOrder.qty - listedOrder.qty_filled === 10);
  const treasury0 = (await C.get('/api/country')).data.country.treasury_usd;
  setInv(dId, besiId, 20);
  const usdD0 = (await D.get('/api/me')).data.citizen.usd;
  r = await D.post('/api/market/sell-to-order', { order_id: buyOrderId, qty: 6 });
  check('Jual 6 unit ke order beli berhasil', r.status === 200 && r.data.sellerReceives === 52.92, `status=${r.status} ${JSON.stringify(r.data)}`);
  check('Pembeli dipotong 54 USD saat barang dibeli (500 → 446)', eq((await C.get('/api/me')).data.citizen.usd, 446));
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
  check('Batal order: tanpa refund, saldo tetap 446', r.status === 200 && eq(r.data.refund, 0) && (await C.get('/api/me')).data.citizen.usd === 446, `status=${r.status} ${JSON.stringify(r.data)}`);

  // Pembeli dipotong SAAT barang dibeli: bila saldo habis saat dipenuhi,
  // jual gagal 400 dan tidak ada yang berubah.
  r = await C.post('/api/market/buy-order', { scope: 'local', commodity_id: besiId, tier: 1, qty: 10, price: 9 });
  check('Order beli baru dipasang (saldo tetap 446)', r.status === 200 && !!r.data.orderId && (await C.get('/api/me')).data.citizen.usd === 446, `status=${r.status} ${r.data.error || ''}`);
  const buyOrderId2 = r.data.orderId;
  const usdD1 = (await D.get('/api/me')).data.citizen.usd;
  const besiD1 = invQty(dId, besiId);
  db4.prepare('UPDATE citizens SET usd = ? WHERE id = ?').run(50, cId);
  r = await D.post('/api/market/sell-to-order', { order_id: buyOrderId2, qty: 10 });
  check('Jual ke order yang pembelinya kehabisan saldo ditolak (400)', r.status === 400 && /Saldo pembeli tidak cukup/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  check('Gagal jual: saldo penjual utuh', eq((await D.get('/api/me')).data.citizen.usd, usdD1));
  check('Gagal jual: barang penjual utuh', invQty(dId, besiId) === besiD1, `besi=${invQty(dId, besiId)}`);
  check('Gagal jual: saldo pembeli tetap 50', (await C.get('/api/me')).data.citizen.usd === 50);
  r = await C.get('/api/market?scope=local');
  const myOrder2 = (r.data.myBuyOrders || []).find((o) => o.id === buyOrderId2);
  check('Gagal jual: order tetap 0/10', !!myOrder2 && myOrder2.qty_filled === 0, JSON.stringify(myOrder2));
  db4.prepare('UPDATE citizens SET usd = ? WHERE id = ?').run(446, cId);
  r = await C.post('/api/market/buy-order/cancel', { order_id: buyOrderId2 });
  check('Batal order kedua berhasil', r.status === 200, `status=${r.status}`);

  console.log('  [22d] Pajak pasar biasa masuk kas negara (BUG-8)');
  // Redesain dunia: A di Jakarta (merdeka) — pindah A ke wilayah Nusantara
  // (region 1, sama seperti B sejak [7]) agar kas negara bisa dibaca.
  const db22d = new DatabaseSync(DB_PATH);
  db22d.prepare("UPDATE citizens SET region_id = ?, home_region_id = ? WHERE id IN (SELECT c.id FROM citizens c JOIN users u ON u.id = c.user_id WHERE u.username IN ('warga_satu','warga_dua'))").run(nusantaraCapitalId, nusantaraCapitalId);
  db22d.close();
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
  const pabrikTesId = r.data.companyId;
  const stockQty = (companyId, commodityId) => db4.prepare('SELECT qty FROM company_stock WHERE company_id = ? AND commodity_id = ?').get(companyId, commodityId)?.qty || 0;
  setInv(cId, besiId, 25);
  // v4.6.0: produksi mengambil dari STOK perusahaan — isi stok dulu.
  r = await C.post(`/api/companies/${pabrikTesId}/stock`, { commodity: 'Besi Mentah', qty: 25 });
  check('Stok Pabrik Tes: 25 Besi masuk stok', r.status === 200 && r.data.stock?.[0]?.qty === 25, `status=${r.status} ${r.data.error || ''}`);
  await forceTick(C);
  check('Tick 1: 20 Besi → 10 Bahan Bangunan (stok Besi 25 → 5)', invQty(cId, bahanId) === 10 && stockQty(pabrikTesId, besiId) === 5, `bahan=${invQty(cId, bahanId)} stokBesi=${stockQty(pabrikTesId, besiId)}`);
  await forceTick(C);
  check('Tick 2: 4 Besi → 2 Bahan Bangunan (stok Besi 5 → 1, total 12)', invQty(cId, bahanId) === 12 && stockQty(pabrikTesId, besiId) === 1, `bahan=${invQty(cId, bahanId)} stokBesi=${stockQty(pabrikTesId, besiId)}`);
  await forceTick(C);
  check('Tick 3: Besi 1 → produksi 0 (tetap 12)', invQty(cId, bahanId) === 12 && stockQty(pabrikTesId, besiId) === 1);
  r = await C.get('/api/notifications');
  check('Pabrik kekurangan bahan: notifikasi dikirim', (r.data.notifications || []).some((n) => n.title === 'Pabrik Tes kekurangan bahan'));

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
  check('Pengumuman baru = Update #3 (terbaru dulu; #2 sudah ter-seed Tahap 5)', !!newest && newest.num === 3 && newest.title === 'Update Tes E2E', JSON.stringify(newest));
  check('Unread naik lagi (pengumuman baru belum dibaca)', r.data.unreadCount === unread0, `unread=${r.data.unreadCount}`);
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

  console.log('  [22k] Jumlah pemain online + lencana pengumuman');
  const dbO = new DatabaseSync(DB_PATH);
  const idA = dbO.prepare("SELECT c.id AS cid, c.user_id AS uid FROM citizens c JOIN users u ON u.id = c.user_id WHERE u.username = 'warga_satu'").get();
  const idB = dbO.prepare("SELECT c.id AS cid, c.user_id AS uid FROM citizens c JOIN users u ON u.id = c.user_id WHERE u.username = 'warga_dua'").get();
  // Lencana 🔔: pengumuman belum dibaca ikut terhitung (dulu hanya notifikasi).
  const unreadBefore = (await C.get('/api/me')).data.unread;
  r = await ADM.post('/api/admin/announcements', { title: 'Update Tes Online', body: 'Isi tes online.' });
  check('Admin membuat pengumuman tes online', r.status === 200 && !!r.data.id, `status=${r.status}`);
  const annOnlineId = r.data.id;
  r = await C.get('/api/me');
  check('Badge 🔔 naik 1 untuk pengumuman belum dibaca', r.data.unread === unreadBefore + 1, `unread ${unreadBefore} → ${r.data.unread}`);
  r = await C.post('/api/announcements/read', { id: annOnlineId });
  check('Tandai pengumuman dibaca (tes online)', r.status === 200);
  r = await C.get('/api/me');
  check('Badge 🔔 kembali setelah pengumuman dibaca', r.data.unread === unreadBefore, `unread=${r.data.unread}`);
  r = await ADM.post(`/api/admin/announcements/${annOnlineId}/delete`);
  check('Hapus pengumuman tes online', r.status === 200);
  // Heartbeat: GET /api/me memperbarui last_seen_at (throttle 60 detik).
  dbO.prepare('UPDATE citizens SET last_seen_at = 0').run();
  r = await A.get('/api/me');
  const seen1 = dbO.prepare('SELECT last_seen_at FROM citizens WHERE id = ?').get(idA.cid).last_seen_at;
  check('GET /api/me memperbarui last_seen_at', seen1 > Date.now() - 5000, `last_seen_at=${seen1}`);
  r = await A.get('/api/me');
  const seen2 = dbO.prepare('SELECT last_seen_at FROM citizens WHERE id = ?').get(idA.cid).last_seen_at;
  check('Heartbeat di-throttle 60 detik (tidak ditulis ulang)', seen2 === seen1, `${seen1} → ${seen2}`);
  r = await A.get('/api/me');
  check('Online = 1 (hanya A yang aktif)', r.data.onlineCount === 1, `online=${r.data.onlineCount}`);
  r = await B.get('/api/me');
  r = await A.get('/api/me');
  check('Online = 2 setelah B memanggil /api/me', r.data.onlineCount === 2, `online=${r.data.onlineCount}`);
  dbO.prepare('UPDATE citizens SET last_seen_at = ? WHERE id = ?').run(Date.now() - 10 * 60 * 1000, idB.cid);
  r = await A.get('/api/me');
  check('Pemain basi 10 menit tidak terhitung online', r.data.onlineCount === 1, `online=${r.data.onlineCount}`);
  dbO.prepare('UPDATE citizens SET last_seen_at = ? WHERE id = ?').run(Date.now(), idB.cid);
  dbO.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').run(idB.uid);
  r = await A.get('/api/me');
  check('Pemain banned tidak terhitung online', r.data.onlineCount === 1, `online=${r.data.onlineCount}`);
  dbO.prepare('UPDATE users SET is_banned = 0 WHERE id = ?').run(idB.uid);
  // /api/world (sekali saja — respons di-cache 30 detik).
  dbO.prepare('UPDATE citizens SET last_seen_at = 0').run();
  await A.get('/api/me');
  // /api/world di-cache 30 detik (Tahap 5 — lag): respons bisa basi
  // (populasi/online dari sebelum nol-kan). Polling sampai populasinya
  // cocok dengan DB (= respons segar), maks ~36 detik.
  const expectedPop = dbO.prepare('SELECT COUNT(*) AS n FROM citizens').get().n;
  let w = null;
  for (let i = 0; i < 12; i++) {
    w = (await A.get('/api/world')).data;
    if (w.population === expectedPop) break;
    await sleep(3000);
  }
  check('/api/world memuat onlineCount (respons segar)', w.onlineCount === 1 && w.population === expectedPop, `online=${w.onlineCount} populasi=${w.population}`);
  dbO.close();

  console.log('  [22r] Status online per warga (v4.3.0, saran LIO)');
  // Unit: formatter relatif Indonesia + ambang 5 menit (langsung dari src/game.js).
  const nowU = Date.now();
  check('formatLastSeenId: <10 detik = "baru saja"', formatLastSeenId(nowU - 5000, nowU) === 'baru saja');
  check('formatLastSeenId: 45 detik lalu', formatLastSeenId(nowU - 45000, nowU) === '45 detik lalu');
  check('formatLastSeenId: 3 menit lalu', formatLastSeenId(nowU - 3 * 60 * 1000, nowU) === '3 menit lalu');
  check('formatLastSeenId: 2 jam 15 menit lalu', formatLastSeenId(nowU - (2 * 3600 + 15 * 60) * 1000, nowU) === '2 jam 15 menit lalu');
  check('formatLastSeenId: 2 jam lalu (menit 0)', formatLastSeenId(nowU - 2 * 3600 * 1000, nowU) === '2 jam lalu');
  check('formatLastSeenId: 3 hari lalu', formatLastSeenId(nowU - 3 * 86400 * 1000, nowU) === '3 hari lalu');
  check('formatLastSeenId: tanpa last_seen = null', formatLastSeenId(0, nowU) === null && formatLastSeenId(null, nowU) === null);
  check('isOnline: aktif 2 menit lalu = online', isOnline(nowU - 2 * 60 * 1000, nowU) === true);
  check('isOnline: tepat di ambang 5 menit masih online', isOnline(nowU - ONLINE_WINDOW_MS + 1000, nowU) === true);
  check('isOnline: 6 menit lalu = offline', isOnline(nowU - 6 * 60 * 1000, nowU) === false);
  check('isOnline: tanpa last_seen = offline', isOnline(0, nowU) === false);
  check('onlineStatus: online → label "Online"', onlineStatus(nowU - 60000, nowU).online === true && onlineStatus(nowU - 60000, nowU).last_seen_label === 'Online');
  check('onlineStatus: offline 2 jam → label lengkap', onlineStatus(nowU - 2 * 3600 * 1000, nowU).online === false && onlineStatus(nowU - 2 * 3600 * 1000, nowU).last_seen_label === 'Terakhir online 2 jam lalu');
  check('onlineStatus: tanpa last_seen → label sopan', onlineStatus(0, nowU).online === false && onlineStatus(0, nowU).last_seen_label === 'Belum pernah terlihat online');
  // API: /api/profile membawa online + last_seen_label (idA dari blok [22k] di atas).
  const dbP = new DatabaseSync(DB_PATH);
  dbP.prepare('UPDATE citizens SET last_seen_at = ? WHERE id = ?').run(Date.now() - 2 * 60 * 1000, idA.cid);
  r = await A.get('/api/profile/warga_satu');
  check('Profil: aktif 2 menit lalu → online + label "Online"', r.data.profile.online === true && r.data.profile.last_seen_label === 'Online', `online=${r.data.profile.online} label=${r.data.profile.last_seen_label}`);
  dbP.prepare('UPDATE citizens SET last_seen_at = ? WHERE id = ?').run(Date.now() - 2 * 3600 * 1000, idA.cid);
  r = await A.get('/api/profile/warga_satu');
  check('Profil: terakhir aktif 2 jam lalu → offline + label "Terakhir online 2 jam lalu"', r.data.profile.online === false && r.data.profile.last_seen_label === 'Terakhir online 2 jam lalu', `label=${r.data.profile.last_seen_label}`);
  dbP.prepare('UPDATE citizens SET last_seen_at = 0 WHERE id = ?').run(idA.cid);
  r = await A.get('/api/profile/warga_satu');
  check('Profil: tanpa last_seen → offline, tidak crash, label sopan', r.status === 200 && r.data.profile.online === false && r.data.profile.last_seen_label === 'Belum pernah terlihat online', `label=${r.data.profile.last_seen_label}`);
  // API: /api/stats — Level Tertinggi + LIHAT SEMUA membawa status online.
  r = await A.get('/api/stats');
  check('Statistik Level Tertinggi: tiap baris membawa online + label', Array.isArray(r.data.topLevel) && r.data.topLevel.every((x) => typeof x.online === 'boolean' && typeof x.last_seen_label === 'string'));
  r = await A.get('/api/stats?full=level');
  const fullA = (r.data.fullList || []).find((x) => x.username === 'warga_satu');
  check('Statistik LIHAT SEMUA: baris warga_satu membawa online + label', !!fullA && fullA.online === false && fullA.last_seen_label === 'Belum pernah terlihat online', `online=${fullA?.online} label=${fullA?.last_seen_label}`);
  // Pulihkan last_seen A supaya tes berikutnya tidak melihat warga basi.
  dbP.prepare('UPDATE citizens SET last_seen_at = ? WHERE id = ?').run(Date.now(), idA.cid);
  dbP.close();

  console.log('  [22l] Perusahaan v2.4.0 — bonus shift, edit, foto');
  const dbCo = new DatabaseSync(DB_PATH);
  const GO = new Client();
  const HO = new Client();
  const IO = new Client();
  // Batas registrasi 20/IP/24 jam sudah habis dipakai 20 pendaftaran
  // sebelumnya dalam suite ini — 3 akun ini memakai IP berbeda lewat
  // X-Forwarded-For (pola yang sama seperti [23b]/[28]/[5b]).
  GO.extraHeaders = { 'X-Forwarded-For': '127.0.0.11' };
  HO.extraHeaders = { 'X-Forwarded-For': '127.0.0.12' };
  IO.extraHeaders = { 'X-Forwarded-For': '127.0.0.13' };
  r = await GO.post('/api/auth/register', { email: 'perusahaan_g@test.local', password: 'rahasia123', username: 'perusahaan_g' });
  check('Perusahaan: pemilik G mendaftar', r.status === 200 && r.data.ok);
  r = await HO.post('/api/auth/register', { email: 'perusahaan_h@test.local', password: 'rahasia123', username: 'perusahaan_h' });
  check('Perusahaan: pekerja H mendaftar', r.status === 200 && r.data.ok);
  r = await IO.post('/api/auth/register', { email: 'perusahaan_i@test.local', password: 'rahasia123', username: 'perusahaan_i' });
  check('Perusahaan: pekerja I mendaftar', r.status === 200 && r.data.ok);
  const meG = (await GO.get('/api/me')).data;
  const meH = (await HO.get('/api/me')).data;
  const meI = (await IO.get('/api/me')).data;
  const gId = meG.citizen.id; const hId = meH.citizen.id; const iId = meI.citizen.id;
  const gRegion = meG.citizen.region_id;
  // Semua di wilayah yang sama supaya bisa melamar (aturan v2.2.2).
  dbCo.prepare('UPDATE citizens SET region_id = ?, home_region_id = ? WHERE id IN (?,?,?)').run(gRegion, gRegion, hId, iId);
  // Emas untuk mendirikan 3 perusahaan (100 + 250 + 100).
  dbCo.prepare('UPDATE citizens SET gold = 1000 WHERE id = ?').run(gId);
  const setInvL = (citizenId, commodityId, qty) => dbCo.prepare(
    'INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,?) ON CONFLICT (citizen_id, commodity_id, tier) DO UPDATE SET qty = ?')
    .run(citizenId, commodityId, qty, qty);
  const invQtyL = (citizenId, commodityId) => {
    const row = dbCo.prepare('SELECT qty FROM inventory WHERE citizen_id = ? AND commodity_id = ? AND tier = 1').get(citizenId, commodityId);
    return row ? row.qty : 0;
  };
  // v4.6.0: baca isi stok bahan perusahaan (company_stock).
  const stockQtyL = (companyId, commodityId) => {
    const row = dbCo.prepare('SELECT qty FROM company_stock WHERE company_id = ? AND commodity_id = ?').get(companyId, commodityId);
    return row ? row.qty : 0;
  };
  const setEnergyL = (citizenId, energy) => dbCo.prepare('UPDATE citizens SET energy = ?, energy_updated_at = ? WHERE id = ?').run(energy, Date.now(), citizenId);
  const jobIdFor = (companyId) => dbCo.prepare('SELECT id FROM jobs WHERE company_id = ? ORDER BY id LIMIT 1').get(companyId)?.id;
  // JPEG mungil yang valid (magic bytes FF D8 FF) untuk tes foto.
  const tinyJpeg = 'data:image/jpeg;base64,' + Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9]).toString('base64');
  // (a) Bonus shift — perusahaan resource (2× Besi Mentah per shift penuh).
  r = await GO.post('/api/companies', { type: 'resource', name: 'Tambang Tes', resource: 'Besi Mentah' });
  check('Tambang didirikan (100 emas)', r.status === 200 && !!r.data.companyId, `status=${r.status} ${r.data.error || ''}`);
  const tambangId = r.data.companyId;
  r = await HO.post('/api/jobs/apply', { job_id: jobIdFor(tambangId) });
  check('HO melamar ke Tambang Tes', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  const besiBefore = invQtyL(gId, besiId);
  r = await HO.post('/api/jobs/shift');
  check('Shift penuh HO: respons companyBonus 2× Besi Mentah', r.status === 200 && r.data.companyBonus?.qty === 2 && r.data.companyBonus?.product === 'Besi Mentah', JSON.stringify(r.data.companyBonus));
  check('Pemilik GO: inventaris +2 Besi Mentah dari shift HO', invQtyL(gId, besiId) === besiBefore + 2, `besi=${invQtyL(gId, besiId)}`);
  r = await GO.get('/api/notifications');
  check('Pemilik GO: notifikasi Bonus shift karyawan', (r.data.notifications || []).some((n) => n.title === 'Bonus shift karyawan'));
  r = await GO.get('/api/companies');
  const tambang = (r.data.companies || []).find((x) => x.id === tambangId);
  check('GET /api/companies: bonus_text + bonus_given Tambang', tambang?.bonus_text?.includes('Besi Mentah') && tambang?.bonus_text?.includes('per shift penuh') && tambang?.bonus_given === 2, JSON.stringify({ t: tambang?.bonus_text, g: tambang?.bonus_given }));
  // (b) Akumulasi — Industri Ringan (0,8× Makanan per shift penuh).
  r = await GO.post('/api/companies', { type: 'light', name: 'Dapur Tes' });
  check('Dapur didirikan (250 emas)', r.status === 200 && !!r.data.companyId, `status=${r.status} ${r.data.error || ''}`);
  const dapurId = r.data.companyId;
  r = await IO.post('/api/jobs/apply', { job_id: jobIdFor(dapurId) });
  check('IO melamar ke Dapur Tes', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  // Tahap 6: bonus shift Dapur kini butuh 1× Gandum Mentah per unit Makanan.
  const gandumId = dbCo.prepare("SELECT id FROM commodities WHERE name = 'Gandum Mentah'").get().id;
  setInvL(gId, gandumId, 10);
  // v4.6.0: bonus shift mengambil bahan dari STOK perusahaan — isi stok dulu.
  r = await GO.post(`/api/companies/${dapurId}/stock`, { commodity: 'Gandum Mentah', qty: 10 });
  check('Stok Dapur: 10 Gandum masuk stok', r.status === 200 && r.data.stock?.[0]?.qty === 10, `status=${r.status} ${r.data.error || ''}`);
  const makananBefore = invQtyL(gId, makananId);
  r = await IO.post('/api/jobs/shift');
  check('Shift 1 Dapur: belum genap 1 unit (0,8 terakumulasi)', r.status === 200 && (r.data.companyBonus === null || r.data.companyBonus?.qty === 0), JSON.stringify(r.data.companyBonus));
  check('Pemilik GO: Makanan belum bertambah setelah 1 shift', invQtyL(gId, makananId) === makananBefore, `makanan=${invQtyL(gId, makananId)}`);
  setEnergyL(iId, 100);
  r = await IO.post('/api/jobs/shift');
  check('Shift 2 Dapur: 1× Makanan masuk (akumulasi 1,6)', r.status === 200 && r.data.companyBonus?.qty === 1 && r.data.companyBonus?.product === 'Makanan', JSON.stringify(r.data.companyBonus));
  check('Pemilik GO: inventaris +1 Makanan', invQtyL(gId, makananId) === makananBefore + 1, `makanan=${invQtyL(gId, makananId)}`);
  check('Dapur: 1 Gandum terpakai dari stok untuk 1 Makanan bonus (v4.6.0)', stockQtyL(dapurId, gandumId) === 9, `stokGandum=${stockQtyL(dapurId, gandumId)}`);
  // (c) Pabrik — bonus butuh 2× Besi Mentah per unit; bila habis, tertahan.
  r = await GO.post('/api/companies', { type: 'factory', name: 'Pabrik Bonus' });
  check('Pabrik Bonus didirikan (100 emas)', r.status === 200 && !!r.data.companyId, `status=${r.status} ${r.data.error || ''}`);
  const pabrikId = r.data.companyId;
  r = await HO.post('/api/jobs/apply', { job_id: jobIdFor(pabrikId) });
  check('HO pindah kerja ke Pabrik Bonus', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  setInvL(gId, besiId, 10);
  // v4.6.0: isi stok Pabrik dulu (bonus shift mengambil dari stok).
  r = await GO.post(`/api/companies/${pabrikId}/stock`, { commodity: 'Besi Mentah', qty: 10 });
  check('Stok Pabrik: 10 Besi masuk stok', r.status === 200 && r.data.stock?.[0]?.qty === 10, `status=${r.status} ${r.data.error || ''}`);
  const bahanBefore = invQtyL(gId, bahanId);
  setEnergyL(hId, 100);
  r = await HO.post('/api/jobs/shift');
  check('Shift Pabrik: bonus 1× Bahan Bangunan', r.status === 200 && r.data.companyBonus?.qty === 1 && r.data.companyBonus?.product === 'Bahan Bangunan', JSON.stringify(r.data.companyBonus));
  check('Pabrik: 2 Besi terpakai dari stok, +1 Bahan Bangunan', stockQtyL(pabrikId, besiId) === 8 && invQtyL(gId, bahanId) === bahanBefore + 1, `stokBesi=${stockQtyL(pabrikId, besiId)} bahan=${invQtyL(gId, bahanId)}`);
  // v4.6.0: stok yang menentukan kekurangan — set stok Besi ke 1 (kurang dari 2 yang dibutuhkan).
  dbCo.prepare('UPDATE company_stock SET qty = 1 WHERE company_id = ? AND commodity_id = ?').run(pabrikId, besiId);
  setEnergyL(hId, 100);
  r = await HO.post('/api/jobs/shift');
  check('Shift Pabrik tanpa Besi: bonus 0 + shortage', r.status === 200 && r.data.companyBonus?.qty === 0 && r.data.companyBonus?.shortage === true, JSON.stringify(r.data.companyBonus));
  check('Pabrik tanpa Besi: stok Besi tetap 1, Bahan tidak bertambah', stockQtyL(pabrikId, besiId) === 1 && invQtyL(gId, bahanId) === bahanBefore + 1, `stokBesi=${stockQtyL(pabrikId, besiId)} bahan=${invQtyL(gId, bahanId)}`);
  r = await GO.get('/api/notifications');
  check('Pemilik GO: notifikasi Bonus shift tertunda', (r.data.notifications || []).some((n) => n.title === 'Bonus shift tertunda'));
  // (d) Edit perusahaan — hanya pemilik.
  r = await GO.patch(`/api/companies/${tambangId}`, { name: 'Tambang Baru', about: 'Tambang keren', resource: 'Kapas Mentah' });
  check('Pemilik edit nama/tentang/resource', r.status === 200 && r.data.company?.name === 'Tambang Baru' && r.data.company?.about === 'Tambang keren' && r.data.company?.resource === 'Kapas Mentah', `status=${r.status} ${JSON.stringify(r.data.company)}`);
  r = await HO.patch(`/api/companies/${tambangId}`, { name: 'Coba Curi' });
  check('Bukan pemilik edit → 403', r.status === 403, `status=${r.status}`);
  r = await GO.patch(`/api/companies/${tambangId}`, { resource: 'Emas' });
  check('Edit resource tidak valid → 400', r.status === 400, `status=${r.status}`);
  r = await GO.patch('/api/companies/999999', { name: 'Tidak Ada' });
  check('Edit perusahaan tidak ada → 404', r.status === 404, `status=${r.status}`);
  r = await GO.patch(`/api/companies/${tambangId}`, {});
  check('Edit tanpa perubahan → 400', r.status === 400, `status=${r.status}`);
  // (e) Foto perusahaan — 500 KB, hanya pemilik.
  r = await GO.post(`/api/companies/${tambangId}/photo`, { photo: tinyJpeg, photo_sm: tinyJpeg });
  check('Pemilik pasang foto (JPEG mungil valid)', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await GO.get('/api/companies');
  const tambangFoto = (r.data.companies || []).find((x) => x.id === tambangId);
  check('GET /api/companies: foto tersimpan sebagai data URL', typeof tambangFoto?.photo === 'string' && tambangFoto.photo.startsWith('data:image/jpeg;base64,'));
  r = await HO.post(`/api/companies/${tambangId}/photo`, { photo: tinyJpeg });
  check('Bukan pemilik pasang foto → 403', r.status === 403, `status=${r.status}`);
  r = await GO.post(`/api/companies/${tambangId}/photo`, { photo: 'data:image/jpeg;base64,' + 'A'.repeat(700000) });
  check('Foto > 500 KB ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await GO.post(`/api/companies/${tambangId}/photo`, { photo: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' });
  check('Foto SVG ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await GO.post('/api/companies/999999/photo', { photo: tinyJpeg });
  check('Foto perusahaan tidak ada → 404', r.status === 404, `status=${r.status}`);
  dbCo.close();

  console.log('\n[28] Redesain dunia — unifikasi, nominasi capres, ideologi/sistem (dijalankan SEBELUM [23] karena [23] butuh parlemen terbuka + negara 1)');
  const db28 = new DatabaseSync(DB_PATH);
  console.log('  [28a] Unifikasi wilayah (gabung Nusantara)');
  const G = new Client();
  G.extraHeaders = { 'X-Forwarded-For': '127.0.0.3' };
  r = await G.post('/api/auth/register', { email: 'gabung@test.local', password: 'rahasia123', username: 'warga_gabung' });
  check('G mendaftar (IP berbeda, lewati batas 20/IP)', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  // Usulan unifikasi mengikuti wilayah ASAL (home_region_id) pengusul.
  let gRegionId = (await G.get('/api/me')).data.citizen.home_region_id;
  const gCitizenId = (await G.get('/api/me')).data.citizen.id;
  if (gRegionId === nusantaraCapitalId) { gRegionId = [3, 4, 5].find((x) => x !== nusantaraCapitalId); db28.prepare('UPDATE citizens SET region_id = ?, home_region_id = ? WHERE id = ?').run(gRegionId, gRegionId, gCitizenId); }
  db28.prepare('UPDATE citizens SET level = 5 WHERE id = ?').run(gCitizenId);
  r = await G.post('/api/countries/1/join', {});
  check('G (Level 5, wilayah merdeka) mengusulkan wilayahnya gabung Nusantara', r.status === 200 && !!r.data.joinId, `status=${r.status} ${r.data.error || ''}`);
  const joinId = r.data.joinId;
  r = await G.post('/api/countries/1/join', {});
  check('Usulan unifikasi kedua dari wilayah yang sama ditolak (400)', r.status === 400, `status=${r.status}`);
  // Pindahkan C/D/E ke wilayah G agar bisa memilih (kewarganegaraan =
  // home_region_id yang menentukan hak pilih); F dipindah menjauh agar
  // tes 403 "bukan warga wilayah" deterministik.
  db28.prepare('UPDATE citizens SET region_id = ?, home_region_id = ? WHERE id IN (?,?,?)').run(gRegionId, gRegionId, cId, dId, eId);
  const fAwayRegion = gRegionId === 5 ? 6 : 5;
  db28.prepare('UPDATE citizens SET region_id = ?, home_region_id = ? WHERE id = ?').run(fAwayRegion, fAwayRegion, fId);
  r = await C.post(`/api/countries/joins/${joinId}/vote`, { vote: 'yes' });
  check('C (warga wilayah G) memilih YA', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await D.post(`/api/countries/joins/${joinId}/vote`, { vote: 'yes' });
  check('D memilih YA', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await E.post(`/api/countries/joins/${joinId}/vote`, { vote: 'no' });
  check('E memilih TIDAK', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await C.post(`/api/countries/joins/${joinId}/vote`, { vote: 'yes' });
  check('Suara ganda ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await F.post(`/api/countries/joins/${joinId}/vote`, { vote: 'yes' });
  check('Bukan warga wilayah tidak bisa memilih (403)', r.status === 403, `status=${r.status}`);
  // Pengunjung tidak bisa memilih: pindahkan C ke wilayah G secara FISIK
  // (region_id) tapi kewarganegaraannya tetap di tempat lain — voting
  // harus tetap ditolak 403.
  db28.prepare('UPDATE citizens SET region_id = ?, home_region_id = ? WHERE id = ?').run(gRegionId, fAwayRegion, cId);
  r = await C.post(`/api/countries/joins/${joinId}/vote`, { vote: 'yes' });
  check('Pengunjung wilayah (bukan warga) tidak bisa memilih (403)', r.status === 403, `status=${r.status}`);
  // Kembalikan kewarganegaraan C ke wilayah G agar [28b]/[28c] tidak berubah.
  db28.prepare('UPDATE citizens SET region_id = ?, home_region_id = ? WHERE id = ?').run(gRegionId, gRegionId, cId);
  db28.prepare('UPDATE country_joins SET ends_at = ? WHERE id = ?').run(Date.now() - 1000, joinId);
  await forceTick(G);
  const joinRow = db28.prepare('SELECT status, yes, no FROM country_joins WHERE id = ?').get(joinId);
  check('Unifikasi lolos (3 YA incl. pengusul vs 1 TIDAK, minimal 3 YA)', joinRow.status === 'passed' && joinRow.yes === 3 && joinRow.no === 1, JSON.stringify(joinRow));
  check('Wilayah G kini bagian Nusantara', db28.prepare('SELECT country_id FROM regions WHERE id = ?').get(gRegionId).country_id === nusantaraId, `country_id=${db28.prepare('SELECT country_id FROM regions WHERE id = ?').get(gRegionId).country_id}`);
  // Nama negara duplikat (tak peka huruf) — H di wilayah merdeka lain.
  const H = new Client();
  H.extraHeaders = { 'X-Forwarded-For': '127.0.0.4' };
  r = await H.post('/api/auth/register', { email: 'duplikat@test.local', password: 'rahasia123', username: 'warga_duplikat' });
  check('H mendaftar (IP berbeda)', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  // Pendirian negara mengikuti wilayah ASAL (home_region_id) H.
  let hRegionId = (await H.get('/api/me')).data.citizen.home_region_id;
  const hCitizenId = (await H.get('/api/me')).data.citizen.id;
  if (db28.prepare('SELECT country_id FROM regions WHERE id = ?').get(hRegionId).country_id) {
    hRegionId = [4, 5, 6, 7].find((x) => x !== gRegionId && x !== nusantaraCapitalId);
    db28.prepare('UPDATE citizens SET region_id = ?, home_region_id = ? WHERE id = ?').run(hRegionId, hRegionId, hCitizenId);
  }
  db28.prepare('UPDATE citizens SET level = 10, gold = 200 WHERE id = ?').run(hCitizenId);
  r = await H.post('/api/countries', { name: 'Nusantara', ideology: 'Konservatisme', system: 'presidensial' });
  check('Nama negara duplikat ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await H.post('/api/countries', { name: 'NUSANTARA', ideology: 'Konservatisme', system: 'presidensial' });
  check('Nama negara duplikat beda huruf besar/kecil ditolak (400)', r.status === 400, `status=${r.status}`);

  console.log('  [28b] Nominasi capres lewat kepala partai + pemilu presiden');
  db28.prepare("INSERT INTO parties (name, tag, ideology, leader_id, type, seats, created_at) VALUES ('Partai Nusantara','NUSA','Konservatif',?,'open',0,?)").run(1, Date.now());
  const party1Id = db28.prepare("SELECT id FROM parties WHERE tag = 'NUSA'").get().id;
  db28.prepare("INSERT INTO parties (name, tag, ideology, leader_id, type, seats, created_at) VALUES ('Partai Muda','MUDA','Progresif',?,'open',0,?)").run(cId, Date.now());
  const party2Id = db28.prepare("SELECT id FROM parties WHERE tag = 'MUDA'").get().id;
  db28.prepare('UPDATE citizens SET party_id = ? WHERE id = ?').run(party1Id, 1);
  db28.prepare('UPDATE citizens SET party_id = ? WHERE id = ?').run(party1Id, 2);
  db28.prepare('UPDATE citizens SET party_id = ? WHERE id = ?').run(party2Id, cId);
  db28.prepare('UPDATE citizens SET party_id = ? WHERE id = ?').run(party2Id, dId);
  db28.prepare('INSERT INTO party_members (party_id, citizen_id, role, joined_at) VALUES (?,?,?,?)').run(party1Id, 1, 'leader', Date.now());
  db28.prepare('INSERT INTO party_members (party_id, citizen_id, role, joined_at) VALUES (?,?,?,?)').run(party1Id, 2, 'member', Date.now());
  db28.prepare('INSERT INTO party_members (party_id, citizen_id, role, joined_at) VALUES (?,?,?,?)').run(party2Id, cId, 'leader', Date.now());
  db28.prepare('INSERT INTO party_members (party_id, citizen_id, role, joined_at) VALUES (?,?,?,?)').run(party2Id, dId, 'member', Date.now());
  db28.prepare('UPDATE citizens SET level = 5, created_at = ? WHERE id IN (1,2,?,?,?,?)').run(Date.now() - 4 * 86400000, cId, dId, eId, fId);
  const presEl = db28.prepare("SELECT id FROM elections WHERE country_id = ? AND type = 'president' AND status = 'scheduled'").get(nusantaraId);
  db28.prepare("UPDATE elections SET status = 'open', opens_at = ?, closes_at = ? WHERE id = ?").run(Date.now() - 3600000, Date.now() + 3600000, presEl.id);
  r = await A.post(`/api/elections/${presEl.id}/register`, {});
  check('Endpoint lama /register sudah tidak ada (404)', r.status === 404, `status=${r.status}`);
  r = await C.post(`/api/elections/${presEl.id}/nominate`, { citizen_id: 2 });
  check('Bukan ketua partai penominasi ditolak (C nominasi B)', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  r = await A.post(`/api/elections/${presEl.id}/nominate`, { citizen_id: cId });
  check('Ketua menominasikan non-anggota ditolak', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  r = await A.post(`/api/elections/${presEl.id}/nominate`, { citizen_id: 2 });
  check('Ketua Partai Nusantara menominasikan B', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await A.post(`/api/elections/${presEl.id}/nominate`, { citizen_id: 1 });
  check('Satu partai satu calon (nominasi kedua ditolak)', r.status === 400, `status=${r.status}`);
  r = await C.post(`/api/elections/${presEl.id}/nominate`, { citizen_id: cId });
  check('Ketua partai boleh menominasikan dirinya sendiri', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await A.post(`/api/elections/${presEl.id}/vote`, { candidate_id: 2 });
  check('A memilih B', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await C.post(`/api/elections/${presEl.id}/vote`, { candidate_id: 2 });
  check('C memilih B', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await D.post(`/api/elections/${presEl.id}/vote`, { candidate_id: 2 });
  check('D memilih B', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  db28.prepare('UPDATE elections SET closes_at = ? WHERE id = ?').run(Date.now() - 1000, presEl.id);
  await forceTick(A);
  check('B terpilih jadi presiden Nusantara (3 suara vs 0)', db28.prepare('SELECT president_id FROM country WHERE id = ?').get(nusantaraId).president_id === 2, `president=${db28.prepare('SELECT president_id FROM country WHERE id = ?').get(nusantaraId).president_id}`);

  console.log('  [28c] Pemilu parlemen + kursi per negara');
  const parEl = db28.prepare("SELECT id FROM elections WHERE country_id = ? AND type = 'parliament' AND status = 'scheduled'").get(nusantaraId);
  db28.prepare("UPDATE elections SET status = 'open', opens_at = ?, closes_at = ? WHERE id = ?").run(Date.now() - 3600000, Date.now() + 3600000, parEl.id);
  r = await A.post(`/api/elections/${parEl.id}/register-party`, {});
  check('Partai Nusantara terdaftar di pemilu parlemen', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await C.post(`/api/elections/${parEl.id}/register-party`, {});
  check('Partai Muda terdaftar di pemilu parlemen', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await A.post(`/api/elections/${parEl.id}/register-party`, {});
  check('Pendaftaran partai ganda ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await A.post(`/api/elections/${parEl.id}/vote`, { candidate_id: 1 });
  check('A memilih Partai Nusantara', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await C.post(`/api/elections/${parEl.id}/vote`, { candidate_id: cId });
  check('C memilih Partai Muda', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await D.post(`/api/elections/${parEl.id}/vote`, { candidate_id: 1 });
  check('D memilih Partai Nusantara', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  db28.prepare('UPDATE elections SET closes_at = ? WHERE id = ?').run(Date.now() - 1000, parEl.id);
  await forceTick(A);
  const seats1 = db28.prepare('SELECT seats FROM party_seats WHERE party_id = ? AND country_id = ?').get(party1Id, nusantaraId);
  const seats2 = db28.prepare('SELECT seats FROM party_seats WHERE party_id = ? AND country_id = ?').get(party2Id, nusantaraId);
  check('Partai Nusantara dapat 40 kursi (2/3 suara)', seats1?.seats === 40, `kursi=${seats1?.seats}`);
  check('Partai Muda dapat 20 kursi (1/3 suara)', seats2?.seats === 20, `kursi=${seats2?.seats}`);
  // Regresi bug live 27 Nov 2026: GET /api/parties 500 di Postgres begitu
  // ada partai (ORDER BY "seats" ambigu: p.* sudah membawa parties.seats
  // + alias subquery `seats`). SQLite diam-diam memilih salah satunya,
  // jadi hanya tertangkap di Postgres — lihat pg-verify [11].
  r = await C.get('/api/parties');
  const pNusaC = (r.data.parties || []).find((p) => p.tag === 'NUSA');
  const pMudaC = (r.data.parties || []).find((p) => p.tag === 'MUDA');
  check('GET /api/parties sebagai warga Nusantara (C): 200, NUSA 40 kursi, MUDA 20 kursi, mine MUDA 20',
    r.status === 200 && pNusaC?.seats === 40 && pMudaC?.seats === 20 && r.data.mine?.tag === 'MUDA' && r.data.mine?.seats === 20,
    `status=${r.status} NUSA=${pNusaC?.seats} MUDA=${pMudaC?.seats} mine=${r.data.mine?.tag}/${r.data.mine?.seats}`);
  r = await A.get('/api/parties');
  const pNusaA = (r.data.parties || []).find((p) => p.tag === 'NUSA');
  check('GET /api/parties sebagai ketua NUSA (A, di Nusantara): mine NUSA 40 kursi',
    r.status === 200 && pNusaA?.seats === 40 && r.data.mine?.tag === 'NUSA' && r.data.mine?.seats === 40,
    `status=${r.status} mine=${r.data.mine?.tag}/${r.data.mine?.seats}`);
  r = await H.get('/api/parties');
  const pNusaH = (r.data.parties || []).find((p) => p.tag === 'NUSA');
  const pMudaH = (r.data.parties || []).find((p) => p.tag === 'MUDA');
  check('GET /api/parties sebagai warga wilayah merdeka tanpa partai (H): 200, semua partai 0 kursi, mine null',
    r.status === 200 && pNusaH?.seats === 0 && pMudaH?.seats === 0 && r.data.mine === null,
    `status=${r.status} NUSA=${pNusaH?.seats} MUDA=${pMudaH?.seats} mine=${JSON.stringify(r.data.mine)}`);

  console.log('  [28d] Ideologi (klaim +7 Sosialisme) + sistem + pajak diktator');
  db28.prepare("UPDATE citizens SET last_claim_date = '' WHERE id = ?").run(eId);
  r = await E.post('/api/claim', {});
  check('Klaim Konservatisme: +5 emas', r.status === 200 && r.data.reward.gold === 5, JSON.stringify(r.data));
  r = await B.post('/api/country/ideology', { ideology: 'Sosialisme' });
  check('Presiden B mengubah ideologi → Sosialisme', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await A.post('/api/country/ideology', { ideology: 'Liberalisme' });
  check('Bukan presiden tidak bisa mengubah ideologi (403)', r.status === 403, `status=${r.status}`);
  db28.prepare('UPDATE citizens SET region_id = ?, home_region_id = ? WHERE id = ?').run(nusantaraCapitalId, nusantaraCapitalId, fId);
  r = await F.post('/api/claim', {});
  check('Klaim Sosialisme: +7 emas (5+2)', r.status === 200 && r.data.reward.gold === 7, JSON.stringify(r.data));
  r = await B.post('/api/country/ideology', { ideology: 'Konservatisme' });
  check('Ideologi dikembalikan ke Konservatisme (untuk [23])', r.status === 200 && db28.prepare('SELECT ideology FROM country WHERE id = ?').get(nusantaraId).ideology === 'Konservatisme', `ideologi=${db28.prepare('SELECT ideology FROM country WHERE id = ?').get(nusantaraId).ideology}`);
  r = await B.post('/api/country/system', { system: 'parlementer' });
  check('Presiden mengubah sistem → parlementer', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  // Pemilu presiden di sistem parlementer: hanya MP yang boleh memilih.
  // (Tahap 8) Pemilu aktif hanya boleh 1 per (negara, tipe) — indeks unik
  // idx_elections_one_active menolak pemilu kedua. Dulu baris ini INSERT
  // pemilu 'open' baru padahal pemilu 'scheduled' dari boot masih ada
  // (duplikat diam-diam — itulah race yang diperbaiki Tahap 8). Sekarang
  // hapus dulu jadwal aktif lama, baru sisipkan pemilu 'open' untuk uji ini.
  db28.prepare("DELETE FROM elections WHERE country_id = ? AND type = 'president' AND status IN ('scheduled','open')").run(nusantaraId);
  db28.prepare("INSERT INTO elections (type, status, opens_at, closes_at, country_id, created_at) VALUES ('president','open',?,?,?,?)").run(Date.now() - 1000, Date.now() + 3600000, nusantaraId, Date.now());
  const presEl2 = db28.prepare("SELECT id FROM elections WHERE country_id = ? AND type = 'president' AND status = 'open' ORDER BY id DESC LIMIT 1").get(nusantaraId).id;
  db28.prepare('INSERT INTO election_candidates (election_id, citizen_id, party_id, votes) VALUES (?,?,?,0)').run(presEl2, 2, party1Id);
  r = await C.post(`/api/elections/${presEl2}/vote`, { candidate_id: 2 });
  check('C (MP Partai Muda) boleh memilih presiden di sistem parlementer', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await E.post(`/api/elections/${presEl2}/vote`, { candidate_id: 2 });
  check('E (bukan MP) tidak bisa memilih presiden di sistem parlementer (403)', r.status === 403, `status=${r.status} ${r.data.error || ''}`);
  db28.prepare("UPDATE elections SET status = 'closed' WHERE id = ?").run(presEl2);
  r = await B.post('/api/country/system', { system: 'diktator' });
  check('Sistem → diktator', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await B.post('/api/country/tax', { tax: 3 });
  check('Diktator mengatur pajak penghasilan 3%', r.status === 200 && db28.prepare('SELECT tax_income FROM country WHERE id = ?').get(nusantaraId).tax_income === 3, `tax=${db28.prepare('SELECT tax_income FROM country WHERE id = ?').get(nusantaraId).tax_income}`);
  r = await B.post('/api/country/tax', { tax: 9 });
  check('Pajak 9% ditolak (batas 1–5)', r.status === 400, `status=${r.status}`);
  r = await B.post('/api/country/system', { system: 'presidensial' });
  check('Sistem kembali presidensial', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  db28.prepare('UPDATE country SET tax_income = 2 WHERE id = ?').run(nusantaraId);
  check('Pajak dikembalikan 2% (untuk [23])', db28.prepare('SELECT tax_income FROM country WHERE id = ?').get(nusantaraId).tax_income === 2);

  console.log('  [28e] Buka parlemen (gate) untuk [23]');
  db28.prepare("UPDATE db_meta SET value = ? WHERE key = 'parliament_opens_at'").run(String(Date.now() - 1000));
  r = await C.get('/api/parliament');
  check('Parlemen kini terbuka', r.data.parliamentOpen === true, `open=${r.data.parliamentOpen}`);
  r = await C.post('/api/parliament/law', { title: 'UU Pembuka Tes', content: 'UU tes setelah parlemen dibuka.', kind: 'general' });
  check('Usul UU setelah parlemen dibuka berhasil (bayar 5 emas)', r.status === 200 && !!r.data.lawId, `status=${r.status} ${r.data.error || ''}`);
  db28.close();

  console.log('\n[23] Tahap 5 — Pemerintahan/Diplomasi + bug region + lag/Invalid Date');
  // Setup bersama: C = anggota parlemen (partai 31 kursi) + Menteri Ekonomi,
  // D = presiden + Menteri Pertahanan, E = Menteri Dalam Negeri,
  // F = Menteri Luar Negeri. Kas negara 1000 emas.
  const db5 = new DatabaseSync(DB_PATH);
  db5.prepare("INSERT INTO parties (name, tag, ideology, leader_id, type, seats, created_at) VALUES ('Partai Tes Lima','PTL','Konservatif',?,'open',31,?)").run(cId, Date.now());
  const party5Id = db5.prepare("SELECT id FROM parties WHERE tag = 'PTL'").get().id;
  // Redesain dunia: kursi parlemen kini di party_seats per negara (bukan
  // kolom parties.seats) — PTL 31 kursi di negara 1; kursi partai [28]
  // dihapus agar hanya PTL yang berkuasa. D/E/F dilepas dari partai [28]
  // agar bukan MP (dibutuhkan [23c]/[23e]). Semua wilayah masuk negara 1
  // agar perjalanan C di [23d] tetap di dalam negara (tiket 2).
  db5.prepare('DELETE FROM party_seats WHERE country_id = 1').run();
  db5.prepare('INSERT INTO party_seats (party_id, country_id, seats) VALUES (?,?,31)').run(party5Id, 1);
  db5.prepare('UPDATE citizens SET party_id = NULL WHERE id IN (?,?,?)').run(dId, eId, fId);
  db5.prepare('DELETE FROM party_members WHERE citizen_id IN (?,?,?)').run(dId, eId, fId);
  db5.prepare('UPDATE regions SET country_id = 1').run();
  db5.prepare('UPDATE citizens SET party_id = ?, level = 5, gold = 500 WHERE id = ?').run(party5Id, cId);
  db5.prepare('INSERT INTO party_members (party_id, citizen_id, role, joined_at) VALUES (?,?,?,?)').run(party5Id, cId, 'leader', Date.now());
  db5.prepare('UPDATE citizens SET level = 5, gold = 500 WHERE id IN (?,?,?)').run(dId, eId, fId);
  db5.prepare('UPDATE country SET treasury = 1000, treasury_usd = 0, president_id = ?, minister_economy = ?, minister_defense = ?, minister_home = ?, minister_foreign = ? WHERE id = 1').run(dId, cId, dId, eId, fId);
  const setEnergy5 = (id, energy) => db5.prepare('UPDATE citizens SET energy = ?, energy_updated_at = ? WHERE id = ?').run(energy, Date.now(), id);
  const country5 = () => db5.prepare('SELECT * FROM country WHERE id = 1').get();
  const setInv5 = (citizenId, commodityId, qty) => db5.prepare(
    'INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,?) ON CONFLICT (citizen_id, commodity_id, tier) DO UPDATE SET qty = ?')
    .run(citizenId, commodityId, qty, qty);
  const invQty5 = (citizenId, commodityId) => {
    const row = db5.prepare('SELECT qty FROM inventory WHERE citizen_id = ? AND commodity_id = ? AND tier = 1').get(citizenId, commodityId);
    return row ? row.qty : 0;
  };

  console.log('  [23a] Pengumuman Update #2 (Tahap 5) ter-seed');
  r = await C.get('/api/announcements');
  const ann2 = (r.data.announcements || []).find((a) => a.num === 2);
  check('Update #2 ter-seed (Tahap 5)', !!ann2 && /UU Kini Berpengaruh/.test(ann2.title), ann2?.title || '');
  check('Update #2 menyebut wilayah acak + Invalid Date + lag', !!ann2 && /acak/.test(ann2.body) && /Invalid Date/.test(ann2.body) && /lebih ringan/.test(ann2.body));

  console.log('  [23b] Wilayah awal acak (bug: semua lahir di Kepulauan Riau)');
  const aRegion0 = (await A.get('/api/me')).data.citizen.region_id;
  const seenRegions = new Set([aRegion0]);
  for (let i = 0; i < 3; i++) {
    const G = new Client();
    // Batas registrasi 20/IP/24 jam sudah habis dipakai 20 pendaftaran
    // sebelumnya dalam suite ini — 3 akun ini memakai IP berbeda lewat
    // X-Forwarded-For (server trust proxy, seperti klien dari IP lain).
    G.extraHeaders = { 'X-Forwarded-For': '127.0.0.2' };
    const rr = await G.post('/api/auth/register', { email: `acak${i}@test.local`, password: 'rahasia123', username: `acak_${i}` });
    check(`Pendaftaran acak ${i + 1} berhasil`, rr.status === 200 && rr.data.ok, `status=${rr.status} ${rr.data.error || ''}`);
    if (rr.status === 200) seenRegions.add((await G.get('/api/me')).data.citizen.region_id);
  }
  const distinctRegions = Number(db5.prepare('SELECT COUNT(DISTINCT region_id) AS n FROM citizens').get().n);
  check('Wilayah awal tersebar ke >1 wilayah (bukan semua region 1)', distinctRegions > 1, `distinct=${distinctRegions}`);
  const regionIds5 = (await A.get('/api/regions')).data.regions.map((x) => x.id);
  check('Semua wilayah awal valid (ada di daftar wilayah)', [...seenRegions].every((id) => regionIds5.includes(id)), `wilayah: ${[...seenRegions].join(',')}`);
  check('Pemain lama tidak pindah wilayah', (await A.get('/api/me')).data.citizen.region_id === aRegion0, `region A=${aRegion0}`);

  console.log('  [23c] UU berjenis: pajak penghasilan 2% → 4% (BUG-9)');
  r = await D.post('/api/parliament/law', { title: 'UU Umum Tes', content: 'Isi undang-undang umum untuk tes.', kind: 'general' });
  check('D (bukan menteri) mengusulkan UU umum: bayar 5 emas', r.status === 200 && (await D.get('/api/me')).data.citizen.gold === 495, `status=${r.status} emas=${(await D.get('/api/me')).data.citizen.gold}`);
  r = await C.post('/api/parliament/law', { title: 'UU Pajak 4 Persen', content: 'Pajak penghasilan menjadi 4 persen untuk mengisi kas negara.', kind: 'tax_income', value: 9 });
  check('UU pajak nilai 9 ditolak (batas 1–5)', r.status === 400, `status=${r.status}`);
  r = await C.post('/api/parliament/law', { title: 'UU Perjalanan 3', content: 'Perjalanan butuh 3 tiket.', kind: 'travel', value: 3 });
  check('UU perjalanan nilai 3 ditolak (batas 1–2)', r.status === 400, `status=${r.status}`);
  r = await C.post('/api/parliament/law', { title: 'UU Pajak 4 Persen', content: 'Pajak penghasilan menjadi 4 persen untuk mengisi kas negara.', kind: 'tax_income', value: 4 });
  check('C (Menteri Ekonomi) mengusulkan UU pajak 4%: gratis + berhasil', r.status === 200 && !!r.data.lawId && (await C.get('/api/me')).data.citizen.gold === 500, `status=${r.status} ${r.data.error || ''}`);
  const lawId = r.data.lawId;
  r = await C.post('/api/parliament/vote', { law_id: lawId, vote: 'yes' });
  check('C (MP) memilih YA untuk UU pajak', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await D.post('/api/parliament/vote', { law_id: lawId, vote: 'yes' });
  check('D (bukan MP) tidak bisa memilih UU (403)', r.status === 403, `status=${r.status}`);
  db5.prepare('UPDATE laws SET ends_at = ? WHERE id = ?').run(Date.now() - 1000, lawId);
  await forceTick(C);
  check('Tick: UU pajak disahkan + efek diterapkan', db5.prepare("SELECT status, effect_applied FROM laws WHERE id = ?").get(lawId).status === 'executed' && db5.prepare('SELECT effect_applied FROM laws WHERE id = ?').get(lawId).effect_applied === 1);
  check('Tarif pajak negara kini 4%', country5().tax_income === 4, `tax=${country5().tax_income}`);
  r = await C.get('/api/parliament');
  check('Halaman Parlemen menampilkan tarif berlaku 4%', r.data.effects?.taxIncome === 4, `effects=${JSON.stringify(r.data.effects)}`);
  r = await C.get('/api/market?scope=local');
  check('Pasar menampilkan tarif pajak 4%', r.data.taxRate === 4, `taxRate=${r.data.taxRate}`);
  const usdB5 = (await B.get('/api/me')).data.citizen.usd;
  const treasury5a = country5().treasury_usd;
  setInv5(2, makananId, 10);
  r = await B.post('/api/market/sell', { scope: 'local', commodity_id: makananId, tier: 1, qty: 10, price: 9 });
  const offer5 = r.data.offerId;
  check('B pasang jual 10× Makanan @9 (tarif 4%)', r.status === 200 && !!offer5, `status=${r.status}`);
  r = await A.post('/api/market/buy', { offer_id: offer5, qty: 10 });
  check('A membeli: B terima 86,40 USD (90 − pajak 4%)', r.status === 200 && eq(r.data.sellerReceives, 86.4), JSON.stringify(r.data));
  check('Saldo B bertambah 86,40 USD', eq((await B.get('/api/me')).data.citizen.usd, usdB5 + 86.4));
  check('Pajak 3,60 USD masuk kas negara', eq(country5().treasury_usd - treasury5a, 3.6), `delta=${country5().treasury_usd - treasury5a}`);

  console.log('  [23d] UU upah ADMIN + biaya perjalanan');
  db5.prepare('UPDATE country SET admin_pay_mult = 1.2 WHERE id = 1').run();
  const jobs5 = (await C.get('/api/jobs')).data;
  const adminJob = jobs5.jobs.find((j) => j.is_admin);
  check('Lowongan ADMIN menampilkan effectiveQty (pengali 120%)', !!adminJob && adminJob.effectiveQty === Math.max(1, Math.floor(adminJob.pay_qty * 1.2)), `pay=${adminJob?.pay_qty} eff=${adminJob?.effectiveQty}`);
  db5.prepare('UPDATE citizens SET region_id = ? WHERE id = ?').run(adminJob.region_id, cId);
  r = await C.post('/api/jobs/apply', { job_id: adminJob.id });
  check('C melamar lowongan ADMIN', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  setEnergy5(cId, 100);
  r = await C.post('/api/jobs/shift');
  const expectQty = Math.max(1, Math.floor(adminJob.pay_qty * 1.2));
  check(`Shift ADMIN dibayar ${expectQty}× bahan (44 × 1,2)`, r.status === 200 && r.data.goods === `${expectQty}× ${adminJob.resource}`, JSON.stringify(r.data));
  db5.prepare('UPDATE country SET travel_tickets = 2 WHERE id = 1').run();
  const regions5 = (await C.get('/api/regions')).data.regions;
  const myRegion5 = (await C.get('/api/me')).data.citizen.region_id;
  const targetRegion = regions5.find((x) => x.id !== myRegion5);
  r = await C.get(`/api/regions/${targetRegion.id}`);
  check('Halaman wilayah menampilkan biaya perjalanan 2 Tiket', r.data.travelTickets === 2, `travelTickets=${r.data.travelTickets}`);
  const tiket0 = invQty5(cId, (await C.get('/api/market?scope=local')).data.commodities.find((x) => x.name === 'Tiket').id);
  r = await C.post('/api/regions/travel', { region_id: targetRegion.id });
  check('Perjalanan memakai 2 Tiket (3 → 1)', r.status === 200 && invQty5(cId, (await C.get('/api/market?scope=local')).data.commodities.find((x) => x.name === 'Tiket').id) === tiket0 - 2, `tiket ${tiket0} → ${invQty5(cId, (await C.get('/api/market?scope=local')).data.commodities.find((x) => x.name === 'Tiket').id)}`);
  // Waktu tempuh (27 Nov 2026): paksa tiba dulu — kalau tidak, perjalanan
  // kedua ditolak karena masih transit, bukan karena tiket kurang.
  db5.prepare('UPDATE citizens SET travel_arrives_at = ? WHERE id = ?').run(Date.now() - 1000, cId);
  await C.get('/api/me');
  r = await C.post('/api/regions/travel', { region_id: regions5.find((x) => x.id !== targetRegion.id).id });
  check('Perjalanan kedua ditolak: Tiket kurang (butuh 2)', r.status === 400 && /2 Tiket/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);

  console.log('  [23e] Anggaran negara (Menteri Ekonomi)');
  r = await D.post('/api/country/budget', { kind: 'claim', amount: 100 });
  check('D (bukan Menteri Ekonomi) tidak bisa mengusulkan anggaran (403)', r.status === 403, `status=${r.status}`);
  r = await C.post('/api/country/budget', { kind: 'claim', amount: 30 });
  check('Anggaran 30 emas ditolak (batas 50–500)', r.status === 400, `status=${r.status}`);
  r = await C.post('/api/country/budget', { kind: 'claim', amount: 100 });
  check('C mengusulkan anggaran Pasokan +2 Emas (100 emas)', r.status === 200 && !!r.data.budgetId, `status=${r.status} ${r.data.error || ''}`);
  const budgetId = r.data.budgetId;
  r = await C.post('/api/country/budget', { kind: 'train', amount: 100 });
  check('Anggaran kedua saat voting berjalan ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await D.post(`/api/country/budget/${budgetId}/vote`, { vote: 'yes' });
  check('D (bukan MP) tidak bisa memilih anggaran (403)', r.status === 403, `status=${r.status}`);
  r = await C.post(`/api/country/budget/${budgetId}/vote`, { vote: 'yes' });
  check('C (MP) memilih YA untuk anggaran', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  const treasury5b = country5().treasury;
  db5.prepare('UPDATE budgets SET ends_at = ? WHERE id = ?').run(Date.now() - 1000, budgetId);
  await forceTick(C);
  check('Tick: anggaran lolos + kas negara −100 emas', db5.prepare("SELECT status FROM budgets WHERE id = ?").get(budgetId).status === 'passed' && country5().treasury === treasury5b - 100, `treasury ${treasury5b} → ${country5().treasury}`);
  check('Anggaran claim kini aktif 7 hari', country5().budget_kind === 'claim' && country5().budget_until > Date.now());
  r = await D.post('/api/claim');
  check('Klaim harian dengan anggaran claim: +7 emas (5+2)', r.status === 200 && r.data.reward.gold === 7 && r.data.budgetBonus === true, JSON.stringify(r.data));

  console.log('  [23f] Mobilisasi + hari libur (wewenang menteri)');
  const treasury5c = country5().treasury;
  r = await D.post('/api/country/mobilize', {});
  check('D (Menteri Pertahanan) memobilisasi', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  check('Kas negara −100 emas (mobilisasi)', country5().treasury === treasury5c - 100, `treasury=${country5().treasury}`);
  check('Mobilisasi aktif 24 jam', country5().mobilization_until > Date.now());
  r = await D.post('/api/country/mobilize', {});
  check('Mobilisasi kedua saat aktif ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await C.post('/api/country/mobilize', {});
  check('C (bukan Menteri Pertahanan) tidak bisa memobilisasi (403)', r.status === 403, `status=${r.status}`);
  setEnergy5(fId, 50);
  const treasury5d = country5().treasury;
  r = await E.post('/api/country/holiday', {});
  check('E (Menteri Dalam Negeri) menetapkan hari libur', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  check('Kas negara −50 emas (hari libur)', country5().treasury === treasury5d - 50, `treasury=${country5().treasury}`);
  check('Hari libur: F +20 energi (50 → 70)', (await F.get('/api/me')).data.citizen.energy === 70, `energi=${(await F.get('/api/me')).data.citizen.energy}`);
  r = await E.post('/api/country/holiday', {});
  check('Hari libur kedua <24 jam ditolak (400)', r.status === 400, `status=${r.status}`);

  console.log('  [23g] Pemakzulan presiden');
  // D presiden tapi bukan MP — jadikan MP sementara lewat DB agar jalur
  // 400 "tidak bisa memakzulkan diri sendiri" teruji, lalu kembalikan.
  db5.prepare('UPDATE citizens SET party_id = ? WHERE id = ?').run(party5Id, dId);
  db5.prepare('INSERT INTO party_members (party_id, citizen_id, role, joined_at) VALUES (?,?,?,?)').run(party5Id, dId, 'member', Date.now());
  r = await D.post('/api/parliament/impeach', {});
  check('D (presiden) tidak bisa memakzulkan dirinya sendiri (400)', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  db5.prepare('UPDATE citizens SET party_id = NULL WHERE id = ?').run(dId);
  db5.prepare('DELETE FROM party_members WHERE party_id = ? AND citizen_id = ?').run(party5Id, dId);
  r = await C.post('/api/parliament/impeach', {});
  check('C (MP) mengusulkan pemakzulan presiden D', r.status === 200 && !!r.data.impeachmentId, `status=${r.status} ${r.data.error || ''}`);
  const impId = r.data.impeachmentId;
  r = await C.post('/api/parliament/impeach', {});
  check('Pemakzulan kedua saat voting berjalan ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await C.post(`/api/parliament/impeach/${impId}/vote`, { vote: 'yes' });
  check('C memilih YA untuk pemakzulan', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  db5.prepare('UPDATE impeachments SET ends_at = ? WHERE id = ?').run(Date.now() - 1000, impId);
  await forceTick(C);
  check('Tick: pemakzulan lolos + presiden dicopot', db5.prepare("SELECT status FROM impeachments WHERE id = ?").get(impId).status === 'passed' && country5().president_id === null, `president=${country5().president_id}`);
  r = await C.get('/api/country');
  check('Halaman Negara: presiden Kosong', r.data.president === 'Kosong', `president=${r.data.president}`);

  console.log('  [23h] Pakta antar organisasi (diplomasi)');
  r = await C.post('/api/orgs', { name: 'Org Dagang Tes', tag: 'ODT', type: 'Kerja Sama' });
  check('C mendirikan Org Dagang Tes (100 emas)', r.status === 200 && !!r.data.orgId, `status=${r.status} ${r.data.error || ''}`);
  const org1 = r.data.orgId;
  r = await D.post('/api/orgs', { name: 'Org Bela Tes', tag: 'OBT', type: 'Keamanan' });
  check('D mendirikan Org Bela Tes (100 emas)', r.status === 200 && !!r.data.orgId, `status=${r.status} ${r.data.error || ''}`);
  const org2 = r.data.orgId;
  r = await E.post(`/api/orgs/${org1}/pact`, { target_org_id: org2, kind: 'trade' });
  check('E (bukan ketua/menlu) tidak bisa mengusulkan pakta (403)', r.status === 403, `status=${r.status}`);
  r = await C.post(`/api/orgs/${org1}/pact`, { target_org_id: org1, kind: 'trade' });
  check('Pakta dengan organisasi sendiri ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await C.post(`/api/orgs/${org1}/pact`, { target_org_id: org2, kind: 'trade' });
  check('C mengusulkan Perjanjian Dagang ke Org Bela Tes', r.status === 200 && !!r.data.pactId, `status=${r.status} ${r.data.error || ''}`);
  const pactTrade = r.data.pactId;
  r = await C.post(`/api/orgs/${org1}/pact`, { target_org_id: org2, kind: 'trade' });
  check('Usulan pakta sejenis kedua ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await C.post(`/api/orgs/pacts/${pactTrade}/accept`, {});
  check('C (pengusul) tidak bisa menyetujui usulannya sendiri (400)', r.status === 400, `status=${r.status}`);
  r = await D.post(`/api/orgs/pacts/${pactTrade}/accept`, {});
  check('D (ketua Org Bela Tes) menyetujui pakta dagang', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await E.post(`/api/orgs/${org1}/join`, {});
  check('E bergabung Org Dagang Tes', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await F.post(`/api/orgs/${org2}/join`, {});
  check('F bergabung Org Bela Tes', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  const usdF5 = (await F.get('/api/me')).data.citizen.usd;
  setInv5(eId, makananId, 10);
  r = await E.post('/api/market/sell', { scope: 'local', commodity_id: makananId, tier: 1, qty: 10, price: 9 });
  check('E pasang jual 10× Makanan @9 (pakta dagang aktif)', r.status === 200 && !!r.data.offerId, `status=${r.status}`);
  const eOfferId = r.data.offerId;
  r = await E.get('/api/market?scope=local');
  const eOffer = r.data.offers.find((o) => o.id === eOfferId);
  check('Penawaran E membawa tag organisasi [ODT] (kartu penawaran gaya Parlamentum)', !!eOffer && eOffer.seller === 'tahap4_e' && eOffer.seller_org === 'ODT', JSON.stringify(eOffer));
  r = await F.post('/api/market/buy', { offer_id: eOfferId, qty: 10 });
  check('F membeli: E terima 88,20 USD (pajak 4% dipotong 50% → 2%)', r.status === 200 && eq(r.data.sellerReceives, 88.2), JSON.stringify(r.data));
  r = await C.post(`/api/orgs/${org1}/pact`, { target_org_id: org2, kind: 'defense' });
  check('C mengusulkan Pakta Pertahanan', r.status === 200 && !!r.data.pactId, `status=${r.status} ${r.data.error || ''}`);
  const pactDef = r.data.pactId;
  r = await D.post(`/api/orgs/pacts/${pactDef}/reject`, {});
  check('D menolak Pakta Pertahanan', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await C.post(`/api/orgs/${org1}/pact`, { target_org_id: org2, kind: 'defense' });
  const pactDef2 = r.data.pactId;
  r = await D.post(`/api/orgs/pacts/${pactDef2}/accept`, {});
  check('D menyetujui Pakta Pertahanan (usulan kedua)', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  const meF5 = (await F.get('/api/me')).data;
  const senjataId = (await F.get('/api/market?scope=local')).data.commodities.find((x) => x.name === 'Senjata').id;
  db5.prepare("INSERT INTO wars (region_id, name, attacker_label, defender_label, status, score_a, score_d, ends_at, created_at) VALUES (?,?,?,?, 'active', 0, 0, ?, ?)").run(meF5.citizen.region_id, 'Perang Tes Pakta', 'Pemberontak Tes', 'Republik Indonesia', Date.now() + 86400000, Date.now());
  const war5Id = db5.prepare('SELECT id FROM wars ORDER BY id DESC LIMIT 1').get().id;
  setInv5(fId, senjataId, 5);
  setEnergy5(fId, 100);
  r = await F.get(`/api/wars/${war5Id}`);
  check('Halaman perang menampilkan bonus Pakta + Mobilisasi', (r.data.bonuses || []).includes('Pakta Pertahanan +10%') && (r.data.bonuses || []).includes('Mobilisasi +10%'), `bonuses=${JSON.stringify(r.data.bonuses)}`);
  r = await F.post(`/api/wars/${war5Id}/attack`, { side: 'defender', ammo: 'Senjata' });
  check('Serangan F: 20 × 1,1 (mobilisasi) × 1,1 (pakta) = 24 kerusakan', r.status === 200 && r.data.damage === 24 && (r.data.bonuses || []).includes('Pakta Pertahanan +10%'), JSON.stringify(r.data));
  r = await F.post(`/api/orgs/pacts/${pactTrade}/dissolve`, {});
  check('F (bukan ketua) tidak bisa membubarkan pakta (403)', r.status === 403, `status=${r.status}`);
  r = await C.post(`/api/orgs/pacts/${pactTrade}/dissolve`, {});
  check('C (ketua) membubarkan pakta dagang', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await C.get('/api/orgs');
  check('Pakta dagang tidak lagi terdaftar setelah dibubarkan', !(r.data.pacts || []).some((p) => p.id === pactTrade));
  r = await F.post(`/api/orgs/${org2}/pact`, { target_org_id: org1, kind: 'trade' });
  check('F (Menteri Luar Negeri, bukan ketua) bisa memediasi pakta', r.status === 200 && !!r.data.pactId, `status=${r.status} ${r.data.error || ''}`);
  const pactMed = r.data.pactId;
  r = await C.post(`/api/orgs/pacts/${pactMed}/accept`, {});
  check('C (ketua Org Dagang Tes) menyetujui pakta mediasi', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await C.get('/api/orgs');
  check('Pakta mediasi kini aktif', (r.data.pacts || []).some((p) => p.id === pactMed && p.status === 'active'));

  console.log('  [23i] Format waktu chat (Invalid Date) + latensi endpoint');
  r = await A.post('/api/chat/global', { content: 'Pesan waktu tes tiga kata' });
  check('A mengirim pesan chat', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await A.get('/api/chat/global');
  const lastMsg = (r.data.messages || [])[(r.data.messages || []).length - 1];
  check('created_at pesan chat berupa ANGKA (bukan string — akar Invalid Date)', !!lastMsg && typeof lastMsg.created_at === 'number', `typeof=${typeof lastMsg?.created_at} val=${lastMsg?.created_at}`);
  check('created_at pesan chat valid (mendekati sekarang)', !!lastMsg && Math.abs(Date.now() - lastMsg.created_at) < 60000, `created_at=${lastMsg?.created_at}`);
  const tWorld0 = performance.now();
  r = await A.get('/api/world');
  const tWorld1 = performance.now() - tWorld0;
  const tWorld2 = performance.now();
  r = await A.get('/api/world');
  const tWorldCache = performance.now() - tWorld2;
  check('Latensi /api/world < 500ms (lokal hangat)', tWorld1 < 500, `${tWorld1.toFixed(0)}ms`);
  check('Latensi /api/world ke-2 (cache) < 100ms', tWorldCache < 100, `${tWorldCache.toFixed(0)}ms`);
  const tMe0 = performance.now();
  r = await A.get('/api/me');
  const tMe = performance.now() - tMe0;
  check('Latensi /api/me < 500ms (lokal hangat)', tMe < 500, `${tMe.toFixed(0)}ms`);
  const tChat0 = performance.now();
  r = await A.get('/api/chat/global');
  const tChat = performance.now() - tChat0;
  check('Latensi /api/chat/global < 500ms (lokal hangat)', tChat < 500, `${tChat.toFixed(0)}ms`);
  db5.close();

  console.log('\n[24] Bug tulis artikel (CSP memblokir onclick inline)');
  r = await A.get('/api/press/newspapers/mine');
  check('A belum punya koran (daftar kosong)', r.status === 200 && (r.data.newspapers || []).length === 0, JSON.stringify(r.data));
  r = await A.post('/api/press/articles', { newspaper_id: 999, title: 'Judul Artikel Tes', content: 'Isi artikel tes yang cukup panjang.' });
  check('Tulis artikel tanpa koran sendiri ditolak (403)', r.status === 403, `status=${r.status} ${r.data.error || ''}`);
  r = await A.post('/api/press/newspaper', { name: 'KB' });
  check('Nama koran <3 karakter ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await A.post('/api/press/newspaper', { name: 'Kabar Warga Tes' });
  check('A mendirikan koran (5 emas)', r.status === 200 && !!r.data.newspaperId, `status=${r.status} ${r.data.error || ''}`);
  const paperId = r.data.newspaperId;
  r = await A.post('/api/press/articles', { newspaper_id: paperId, title: 'Abcd', content: 'Isi artikel tes yang cukup panjang.' });
  check('Judul 4 karakter ditolak (400)', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  r = await A.post('/api/press/articles', { newspaper_id: paperId, title: 'Judul Artikel Tes', content: 'Terlalu pendek.' });
  check('Isi <20 karakter ditolak (400)', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  r = await A.post('/api/press/articles', { newspaper_id: paperId, title: 'Judul Artikel Tes', content: 'Ini adalah isi artikel tes yang panjangnya lebih dari dua puluh karakter.' });
  check('Artikel valid terbit + mengembalikan articleId', r.status === 200 && !!r.data.articleId, `status=${r.status} ${r.data.error || ''}`);
  const articleId = r.data.articleId;
  r = await B.post('/api/press/articles', { newspaper_id: paperId, title: 'Judul Artikel Tes', content: 'Ini adalah isi artikel tes yang panjangnya lebih dari dua puluh karakter.' });
  check('B tidak bisa menulis di koran A (403)', r.status === 403, `status=${r.status}`);
  r = await A.get('/api/press/articles?sort=new');
  check('Artikel muncul di daftar Pers', (r.data.articles || []).some((a) => a.id === articleId), `n=${(r.data.articles || []).length}`);
  r = await A.get(`/api/press/articles/${articleId}`);
  check('Artikel bisa dibuka: judul + isi cocok', r.status === 200 && r.data.article.title === 'Judul Artikel Tes' && r.data.article.content.startsWith('Ini adalah isi artikel'), `status=${r.status}`);
  check('Artikel dihitung 1x dibaca', r.data.article.views === 1, `views=${r.data.article.views}`);
  r = await B.post(`/api/press/articles/${articleId}/react`, { reaction: 'like' });
  check('B menyukai artikel', r.status === 200 && r.data.reaction === 'like', `status=${r.status}`);
  r = await B.post(`/api/press/articles/${articleId}/comment`, { content: 'Artikel yang bagus sekali!' });
  check('B mengomentari artikel', r.status === 200 && !!r.data.commentId, `status=${r.status}`);
  r = await A.get(`/api/press/articles/${articleId}`);
  check('Suka + komentar tampil di detail artikel', r.data.article.likes === 1 && r.data.comments.length === 1, `likes=${r.data.article.likes} komentar=${r.data.comments.length}`);

  console.log('  [24b] Penjaga duplikat koran + bubarkan koran (bug Vincent)');
  // Isi ulang emas A agar pembuatan koran tambahan tidak gagal karena saldo.
  const meA24 = (await A.get('/api/me')).data;
  const db24 = new DatabaseSync(DB_PATH);
  db24.prepare('UPDATE citizens SET gold = gold + 100 WHERE id = ?').run(meA24.citizen.id);
  db24.close();
  r = await A.post('/api/press/newspaper', { name: 'Kabar Warga Tes' });
  check('Nama koran sama (persis) ditolak (400)', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  r = await A.post('/api/press/newspaper', { name: 'kabar warga tes' });
  check('Nama koran sama (beda huruf besar/kecil) ditolak (400)', r.status === 400, `status=${r.status}`);
  const tNp0 = performance.now();
  r = await A.post('/api/press/newspaper', { name: 'Kabar Kedua Tes' });
  const tNp = performance.now() - tNp0;
  check('Nama koran berbeda BOLEH (pemilik boleh punya >1 koran)', r.status === 200 && !!r.data.newspaperId, `status=${r.status} ${r.data.error || ''}`);
  check('Latensi POST /api/press/newspaper < 500ms (lokal hangat)', tNp < 500, `${tNp.toFixed(0)}ms`);
  const paper2 = r.data.newspaperId;
  // Double-submit bersamaan dengan nama yang sama → tepat satu lolos.
  const [d1, d2] = await Promise.all([
    A.post('/api/press/newspaper', { name: 'Kabar Kilat Tes' }),
    A.post('/api/press/newspaper', { name: 'Kabar Kilat Tes' }),
  ]);
  const okCount = [d1, d2].filter((x) => x.status === 200).length;
  check('Dua request bersamaan nama sama: tepat satu lolos, satu ditolak 400', okCount === 1 && [d1, d2].some((x) => x.status === 400), `status=${d1.status}/${d2.status}`);
  const paper3 = (d1.status === 200 ? d1 : d2).data.newspaperId;
  // Bubarkan: bukan pemilik ditolak; pemilik berhasil; artikel ikut hilang.
  r = await B.delete('/api/press/newspapers/' + paper2);
  check('B bukan pemilik: bubarkan ditolak (404)', r.status === 404, `status=${r.status}`);
  r = await A.post('/api/press/articles', { newspaper_id: paper2, title: 'Artikel Koran Kedua', content: 'Isi artikel koran kedua yang panjangnya lebih dari dua puluh karakter.' });
  check('A menulis artikel di koran kedua', r.status === 200 && !!r.data.articleId, `status=${r.status}`);
  const article2 = r.data.articleId;
  r = await A.delete('/api/press/newspapers/' + paper2);
  check('A (pemilik) membubarkan koran kedua', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await A.get('/api/press/newspapers/mine');
  check('Koran kedua hilang dari daftar koranku (koran pertama tetap ada)', !(r.data.newspapers || []).some((n) => n.id === paper2) && (r.data.newspapers || []).some((n) => n.id === paperId), `n=${(r.data.newspapers || []).length}`);
  r = await A.get(`/api/press/articles/${article2}`);
  check('Artikel koran yang dibubarkan ikut hilang (404)', r.status === 404, `status=${r.status}`);
  r = await A.delete('/api/press/newspapers/' + paper2);
  check('Bubarkan koran yang sudah tidak ada ditolak (404)', r.status === 404, `status=${r.status}`);
  r = await A.get('/api/press/newspapers/mine');
  check('Koran hasil double-submit tetap ada 1 (bukan 0/2)', (r.data.newspapers || []).some((n) => n.id === paper3), `n=${(r.data.newspapers || []).length}`);

  console.log('\n[25] Jeda latihan (cooldown 2 menit × level atribut baru; Tahap 7: Pendidikan −5%/level)');
  // Pakai A (tanpa daftar baru — pendaftaran di akhir suite kena
  // rate-limit 429): A belum pernah melatih Pendidikan/Ekonomi, jadi
  // keduanya tanpa jeda. Seksi ini terakhir, jadi perubahan emas/XP A
  // tidak memengaruhi asersi lain.
  r = await A.get('/api/me');
  const cdA0 = r.data.citizen.trainCooldowns || {};
  check('/api/me: trainCooldowns Pendidikan & Ekonomi 0 sebelum dilatih', cdA0.strategy?.remainingMs === 0 && cdA0.charisma?.remainingMs === 0, JSON.stringify(cdA0));
  r = await A.post('/api/train', { attr: 'edu' });
  check('A latih Pendidikan → LV 1 (biaya 1 emas, jeda 2 mnt −5% Pendidikan = 114000 ms)', r.status === 200 && r.data.cost === 1 && r.data.level === 1 && r.data.cooldownMs === 114000, `status=${r.status} cooldownMs=${r.data.cooldownMs} ${r.data.error || ''}`);
  r = await A.post('/api/train', { attr: 'edu' });
  check('Latih Pendidikan 2× beruntun ditolak 400 (masih jeda)', r.status === 400 && /jeda/i.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  check('Pesan 400 menyebut sisa waktu (mnt/dtk)', /mnt|dtk/.test(r.data.error || ''), r.data.error || '');
  r = await A.get('/api/me');
  const cdA = r.data.citizen.trainCooldowns || {};
  check('/api/me: trainCooldowns.strategy sisa > 0 dan ≤ 2 mnt', cdA.strategy?.remainingMs > 0 && cdA.strategy.remainingMs <= 120000, JSON.stringify(cdA.strategy));
  check('/api/me: trainCooldowns.charisma masih 0 (belum dilatih)', cdA.charisma?.remainingMs === 0, JSON.stringify(cdA));
  r = await A.post('/api/train', { attr: 'eco' });
  check('Atribut lain (Ekonomi) tetap bisa dilatih saat Pendidikan jeda (jeda ikut −5% Pendidikan = 114000 ms)', r.status === 200 && r.data.level === 1 && r.data.cooldownMs === 114000, `status=${r.status} ${r.data.error || ''}`);
  r = await A.post('/api/train', { attr: 'eco' });
  check('Latih Ekonomi 2× beruntun juga ditolak 400', r.status === 400 && /jeda/i.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  r = await A.get('/api/me');
  check('/api/me: strategy & charisma sama-sama jeda', r.data.citizen.trainCooldowns?.strategy?.remainingMs > 0 && r.data.citizen.trainCooldowns?.charisma?.remainingMs > 0, JSON.stringify(r.data.citizen.trainCooldowns));

  console.log('\n[26] Link Discord + ukuran tampilan avatar (Perbaikan 3 & 5)');
  const jsRes = await fetch(BASE + '/js/app.js');
  const jsText = await jsRes.text();
  check('Halaman utama 200 & app.js tersaji', jsRes.status === 200 && jsText.length > 10000, `status=${jsRes.status} len=${jsText.length}`);
  check('app.js memuat link Discord resmi', jsText.includes('https://discord.gg/JX7DWX3pF'));
  check('Link Discord dibuka di tab baru (target _blank)', jsText.includes('target="_blank"'));
  check('Avatar chat/DM tampil 48px (dulu 36px)', jsText.includes('avatarHtml(m.avatar, m.username, 48)') && jsText.includes('avatarHtml(m.from_avatar, m.from_name, 48)'));
  check('Foto hero profil memakai .profile-photo aspek asli (maks 220px, dulu 144px)', jsText.includes('profilePhotoHtml(pr.avatar, pr.username)') && jsText.includes('class="profile-photo"'));
  const cssRes = await fetch(BASE + '/css/style.css');
  const cssText = await cssRes.text();
  check('CSS: wadah avatar chat 48px + gaya status/pesan-baru ada', cssText.includes('.msg-avatar { flex: none; width: 48px; height: 48px;') && cssText.includes('.chat-status') && cssText.includes('.chat-new-pill'));

  console.log('\n[27] Berita: gambar sampul + gambar di isi artikel');
  // TINY_JPEG (seksi [16]) = JPEG valid kecil; TINY_JPEG_SM = thumbnail.
  const imgContent = 'Berita bergambar: isi artikel ini cukup panjang untuk lolos aturan minimal. [gambar:' + TINY_JPEG + ']';
  r = await A.post('/api/press/articles', { newspaper_id: paperId, title: 'Artikel Bergambar Tes', content: imgContent, cover: TINY_JPEG, cover_sm: TINY_JPEG_SM });
  check('Artikel dengan sampul + 1 gambar di isi terbit', r.status === 200 && !!r.data.articleId, `status=${r.status} ${r.data.error || ''}`);
  const coverArticleId = r.data.articleId;
  r = await A.get(`/api/press/articles/${coverArticleId}`);
  check('Detail artikel: sampul + thumbnail tersimpan utuh', r.status === 200 && r.data.article.cover === TINY_JPEG && r.data.article.cover_sm === TINY_JPEG_SM, `cover=${String(r.data.article.cover || '').slice(0, 30)}`);
  check('Detail artikel: isi membawa penanda gambar', r.data.article.content.includes('[gambar:data:image/jpeg;base64,'));
  r = await A.get('/api/press/articles?sort=new');
  const coverRow = (r.data.articles || []).find((a) => a.id === coverArticleId);
  check('Daftar artikel: sampul kecil (cover_sm) tampil', !!coverRow && coverRow.cover_sm === TINY_JPEG_SM, `cover_sm=${String(coverRow?.cover_sm || '').slice(0, 30)}`);
  check('Daftar artikel: TIDAK membawa cover penuh & isi (hemat bandwidth)', !!coverRow && coverRow.cover === undefined && coverRow.content === undefined, `keys=${Object.keys(coverRow || {}).join(',')}`);
  r = await A.get(`/api/press/articles/${articleId}`);
  check('Artikel lama tanpa sampul: cover null (bukan error)', r.status === 200 && r.data.article.cover == null, `cover=${r.data.article.cover}`);
  // Sampul kebesaran: 600 KB (batas 500 KB) → 400.
  const bigCoverBuf = Buffer.alloc(600 * 1024);
  bigCoverBuf[0] = 0xFF; bigCoverBuf[1] = 0xD8; bigCoverBuf[2] = 0xFF;
  r = await A.post('/api/press/articles', { newspaper_id: paperId, title: 'Artikel Sampul Besar', content: 'Isi artikel ini cukup panjang untuk lolos aturan minimal dua puluh karakter.', cover: 'data:image/jpeg;base64,' + bigCoverBuf.toString('base64'), cover_sm: TINY_JPEG_SM });
  check('Sampul 600 KB ditolak 400 (batas 500 KB)', r.status === 400 && /500 KB/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  // Thumbnail kebesaran: 60 KB (batas 50 KB) → 400.
  const bigCoverSmBuf = Buffer.alloc(60 * 1024);
  bigCoverSmBuf[0] = 0xFF; bigCoverSmBuf[1] = 0xD8; bigCoverSmBuf[2] = 0xFF;
  r = await A.post('/api/press/articles', { newspaper_id: paperId, title: 'Artikel Thumb Besar', content: 'Isi artikel ini cukup panjang untuk lolos aturan minimal dua puluh karakter.', cover: TINY_JPEG, cover_sm: 'data:image/jpeg;base64,' + bigCoverSmBuf.toString('base64') });
  check('Thumbnail sampul 60 KB ditolak 400 (batas 50 KB)', r.status === 400 && /50 KB/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  // Gambar di isi: 4 gambar → 400; 3 gambar → 200.
  const threeImgs = 'Teks pembuka yang cukup panjang untuk aturan minimal. ' + ('[gambar:' + TINY_JPEG + '] ').repeat(3);
  const fourImgs = threeImgs + '[gambar:' + TINY_JPEG + ']';
  r = await A.post('/api/press/articles', { newspaper_id: paperId, title: 'Artikel Empat Gambar', content: fourImgs });
  check('4 gambar di isi ditolak 400 (maksimal 3)', r.status === 400 && /Maksimal 3/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  r = await A.post('/api/press/articles', { newspaper_id: paperId, title: 'Artikel Tiga Gambar', content: threeImgs });
  check('3 gambar di isi diterima', r.status === 200 && !!r.data.articleId, `status=${r.status} ${r.data.error || ''}`);
  // Injeksi lewat penanda gambar: javascript: dan SVG ditolak.
  r = await A.post('/api/press/articles', { newspaper_id: paperId, title: 'Artikel Marker Jahat', content: 'Isi artikel ini cukup panjang untuk lolos aturan minimal. [gambar:javascript:alert(1)]' });
  check('Penanda [gambar:javascript:...] ditolak 400', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  r = await A.post('/api/press/articles', { newspaper_id: paperId, title: 'Artikel Sampul SVG', content: 'Isi artikel ini cukup panjang untuk lolos aturan minimal dua puluh karakter.', cover: 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>').toString('base64') });
  check('Sampul SVG ditolak 400 (SVG bisa bawa script)', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  // <script> di isi teks tetap disimpan sebagai teks (client meng-escape
  // saat render — dites di chat-dom); isi total > 1,3 jt karakter ditolak.
  r = await A.post('/api/press/articles', { newspaper_id: paperId, title: 'Artikel Script Teks', content: 'Berita penting hari ini, simak selengkapnya di bawah ini. <script>alert(1)</script> ' + 'x'.repeat(30) });
  check('Tag <script> di isi teks tetap terbit sebagai teks biasa', r.status === 200 && !!r.data.articleId, `status=${r.status} ${r.data.error || ''}`);
  r = await A.post('/api/press/articles', { newspaper_id: paperId, title: 'Artikel Terlalu Panjang', content: 'x'.repeat(1300001) });
  check('Isi > 1,3 jt karakter ditolak 400', r.status === 400, `status=${r.status} ${r.data.error || ''}`);

  console.log('\n[5b] Profil publik, shift fleksibel & ADMIN tanpa batas');
  // Ditempatkan di AKHIR file dengan sengaja: seksi [12]/[14] mengandalkan
  // urutan pendaftaran + jumlah pemain yang tetap (B = user 2, R = user 3,
  // total 12 pemain) — pemain baru di sini tidak boleh menggeser ID itu.
  // Semua pemain di sini baru (J/K/L/M) dan tidak bergantung pada state A.
  const J = new Client();
  const K = new Client();
  const L = new Client();
  const M = new Client();
  // Batas registrasi 20/IP/24 jam sudah habis dipakai 20 pendaftaran
  // sebelumnya dalam suite ini — 4 akun ini memakai IP berbeda lewat
  // X-Forwarded-For (pola yang sama seperti [23b]/[28]).
  J.extraHeaders = { 'X-Forwarded-For': '127.0.0.5' };
  K.extraHeaders = { 'X-Forwarded-For': '127.0.0.6' };
  L.extraHeaders = { 'X-Forwarded-For': '127.0.0.7' };
  M.extraHeaders = { 'X-Forwarded-For': '127.0.0.8' };
  r = await J.post('/api/auth/register', { email: 'wargaJ@test.local', password: 'rahasia123', username: 'warga_j' });
  check('Daftar warga J berhasil', r.status === 200 && r.data.ok);
  r = await K.post('/api/auth/register', { email: 'wargaK@test.local', password: 'rahasia123', username: 'warga_k' });
  check('Daftar warga K berhasil', r.status === 200 && r.data.ok);
  r = await L.post('/api/auth/register', { email: 'wargaL@test.local', password: 'rahasia123', username: 'warga_l' });
  check('Daftar warga L berhasil', r.status === 200 && r.data.ok);
  r = await M.post('/api/auth/register', { email: 'wargaM@test.local', password: 'rahasia123', username: 'warga_m' });
  check('Daftar warga M berhasil', r.status === 200 && r.data.ok);

  // --- Lowongan ADMIN tanpa batas: J + K + M melamar lowongan yang SAMA
  // (ADMIN di wilayah lahir J) — ketiganya diterima, seats_taken tetap 0.
  r = await J.get('/api/jobs');
  const adminJobs5b = r.data.jobs.filter((x) => x.is_admin === 1);
  check('Lowongan ADMIN: 18 lowongan (satu per wilayah, Kepri 2)', adminJobs5b.length === 18, `ditemukan ${adminJobs5b.length}`);
  check('Lowongan ADMIN: ada di semua 17 wilayah', new Set(adminJobs5b.map((x) => x.region_id)).size === 17);
  check('Lowongan ADMIN: seats 1.000.000 (tanpa batas)', adminJobs5b.every((x) => x.seats === 1000000));
  const meJ = (await J.get('/api/me')).data;
  const jobJ = adminJobs5b.find((x) => x.region_id === meJ.citizen.region_id);
  check('Ada lowongan ADMIN di wilayah lahir J', !!jobJ, `region=${meJ.region?.name}`);
  const kId = (await K.get('/api/me')).data.citizen.id;
  const mId = (await M.get('/api/me')).data.citizen.id;
  const db5b = new DatabaseSync(DB_PATH);
  db5b.prepare('UPDATE citizens SET region_id = ? WHERE id = ?').run(meJ.citizen.region_id, kId);
  db5b.prepare('UPDATE citizens SET region_id = ? WHERE id = ?').run(meJ.citizen.region_id, mId);
  db5b.close();
  r = await J.post('/api/jobs/apply', { job_id: jobJ.id });
  check('J melamar lowongan ADMIN di wilayahnya', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  r = await K.post('/api/jobs/apply', { job_id: jobJ.id });
  check('K melamar lowongan ADMIN yang sama dengan J (tanpa batas)', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  r = await M.post('/api/jobs/apply', { job_id: jobJ.id });
  check('M melamar lowongan ADMIN yang sama (pekerja ke-3, tetap diterima)', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  r = await J.get('/api/jobs');
  const jobAfter5b = r.data.jobs.find((x) => x.id === jobJ.id);
  const meJ3 = (await J.get('/api/me')).data.citizen;
  const meK3 = (await K.get('/api/me')).data.citizen;
  const meM3 = (await M.get('/api/me')).data.citizen;
  check('Lowongan ADMIN menampung J+K+M (tanpa batas), seats_taken tetap 0',
    jobAfter5b.workers >= 3 && jobAfter5b.seats_taken === 0 && meJ3.job_id === jobJ.id && meK3.job_id === jobJ.id && meM3.job_id === jobJ.id,
    `workers=${jobAfter5b.workers} seats_taken=${jobAfter5b.seats_taken}`);

  // --- Shift fleksibel: L melamar ADMIN di wilayahnya sendiri.
  const meL = (await L.get('/api/me')).data;
  const jobsL = (await L.get('/api/jobs')).data.jobs;
  const jobL = jobsL.find((x) => x.is_admin === 1 && x.region_id === meL.citizen.region_id);
  check('Ada lowongan ADMIN di wilayah lahir L', !!jobL, `region=${meL.region?.name}`);
  r = await L.post('/api/jobs/apply', { job_id: jobL.id });
  check('L melamar lowongan ADMIN di wilayahnya', r.status === 200 && r.data.ok);
  // effectiveQty = jumlah setelah pengali UU upah ADMIN (bila ada) — pakai
  // itu sebagai dasar ekspektasi supaya tes tidak rapuh terhadap UU.
  const baseQty = jobL.effectiveQty ?? jobL.pay_qty;
  // Tahap 6: minggu Festival Rakyat memberi XP shift +50% — ekspektasi XP
  // dihitung dari event yang sedang berlaku (bukan hardcode 10/20/1/2).
  const festMult = meL.worldEvent?.key === 'festival' ? 1.5 : 1;
  const xp50ok = [Math.round(10 * festMult), Math.round(20 * festMult)];
  const xp1ok = [Math.round(1 * festMult), Math.round(2 * festMult)];
  const dbL = new DatabaseSync(DB_PATH);
  dbL.prepare('UPDATE citizens SET energy = 50 WHERE id = ?').run(meL.citizen.id);
  dbL.close();
  r = await L.post('/api/jobs/shift');
  const expect50 = Math.floor(baseQty * 0.5);
  const got50 = r.data.goods ? Number(String(r.data.goods).split('×')[0]) : -1;
  check(`Shift 50 energi: dibayar ~50% (${expect50}× ${jobL.resource})`, r.status === 200 && got50 >= expect50 - 1 && got50 <= expect50 + 1, `goods=${r.data.goods} energyUsed=${r.data.energyUsed}`);
  check('Respons shift 50 energi: energyUsed 50, energyPct 50', r.data.energyUsed === 50 && r.data.energyPct === 50, `energyUsed=${r.data.energyUsed} energyPct=${r.data.energyPct}`);
  check('Respons shift 50 energi: xpGained 10 (proporsional)', xp50ok.includes(r.data.xpGained), `xpGained=${r.data.xpGained} doubleXp=${r.data.doubleXp} festivalXp=${r.data.festivalXp}`);
  const dbl50 = r.data.doubleXp === true;
  const dbL2 = new DatabaseSync(DB_PATH);
  dbL2.prepare('UPDATE citizens SET energy = 1 WHERE id = ?').run(meL.citizen.id);
  dbL2.close();
  r = await L.post('/api/jobs/shift');
  const got1 = r.data.goods ? Number(String(r.data.goods).split('×')[0]) : -1;
  check('Shift 1 energi: dibayar ~1% (maks 1 unit, bukan penuh)', r.status === 200 && got1 <= 1, `goods=${r.data.goods}`);
  check('Respons shift 1 energi: energyUsed 1, energyPct 1', r.data.energyUsed === 1 && r.data.energyPct === 1, `energyUsed=${r.data.energyUsed}`);
  check('Respons shift 1 energi: xpGained 1 (minimal 1, tetap nambah)', xp1ok.includes(r.data.xpGained), `xpGained=${r.data.xpGained} doubleXp=${r.data.doubleXp} festivalXp=${r.data.festivalXp}`);
  const dbl1 = r.data.doubleXp === true;
  const dbL3 = new DatabaseSync(DB_PATH);
  dbL3.prepare('UPDATE citizens SET energy = 0 WHERE id = ?').run(meL.citizen.id);
  dbL3.close();
  r = await L.post('/api/jobs/shift');
  check('Shift dengan energi 0 ditolak (400)', r.status === 400, `status=${r.status}`);
  const meL2 = (await L.get('/api/me')).data.citizen;
  // XP shift PROPORSIONAL (tiket #22, v3.1.0): 50 energi -> 10 XP, 1 energi
  // -> 1 XP (minimal 1, tetap nambah). Total 11 XP — atau ×2 per shift bila
  // tes jalan di jam ganda 00:00–01:00 WIB (flag doubleXp per respons).
  // Tahap 6: minggu Festival Rakyat mengalikan lagi ×1,5 (festMult).
  const expectXp = (dbl50 ? Math.round(20 * festMult) : Math.round(10 * festMult)) + (dbl1 ? Math.round(2 * festMult) : Math.round(1 * festMult));
  check(`Shift sebagian: XP proporsional total ${expectXp} XP`, meL2.xp === expectXp, `xp=${meL2.xp} dbl50=${dbl50} dbl1=${dbl1}`);
  check('Shift sebagian: counter shift tetap naik (2 giliran)', meL2.shifts === 2, `shifts=${meL2.shifts}`);
  const dbL4 = new DatabaseSync(DB_PATH);
  const chronL = dbL4.prepare('SELECT ckey FROM chronicle_done WHERE citizen_id = ?').all(meL.citizen.id).map((x) => x.ckey);
  dbL4.close();
  check('Shift sebagian TIDAK menyelesaikan tugas Kronik shift (anti-exploit)', !chronL.includes('shift'), `chronicle_done=${JSON.stringify(chronL)}`);

  // --- Profil publik: M baru; J melihat profilnya.
  const meM = (await M.get('/api/me')).data;
  r = await J.get('/api/profile/warga_m');
  check('Profil publik M: level + shifts + terakhir main tampil', r.status === 200 && r.data.profile.level === 1 && r.data.profile.shifts === 0 && typeof r.data.profile.last_seen_at === 'number' && r.data.profile.last_seen_at > 0, `last_seen_at=${r.data.profile.last_seen_at}`);
  check('Profil publik M: citizen_id cocok (target tombol Chat/DM)', r.data.profile.citizen_id === meM.citizen.id, `citizen_id=${r.data.profile.citizen_id}`);
  check('Profil publik TIDAK membocorkan emas/USD/energi/email/kelelahan',
    r.data.profile.gold === undefined && r.data.profile.usd === undefined && r.data.profile.email === undefined && r.data.profile.energy === undefined && r.data.profile.fatigue === undefined && r.data.profile.missions === undefined,
    `gold=${r.data.profile.gold} usd=${r.data.profile.usd}`);
  check('Profil orang lain: referral_code + referral disembunyikan', r.data.profile.referral_code == null && r.data.profile.referral == null, `referral_code=${r.data.profile.referral_code}`);
  r = await M.get('/api/profile/warga_m');
  check('Profil sendiri: referral_code + referral tampil', typeof r.data.profile.referral_code === 'string' && !!r.data.profile.referral, `code=${r.data.profile.referral_code}`);
  r = await M.post('/api/profile/bio', { bio: 'Halo, aku M.' });
  check('Edit bio dari profil berhasil', r.status === 200 && r.data.ok);
  r = await J.get('/api/profile/warga_m');
  check('Bio baru tampil di profil publik', r.data.profile.bio === 'Halo, aku M.', `bio=${r.data.profile.bio}`);
  r = await M.post('/api/profile/bio', { bio: 'x'.repeat(1001) });
  check('Bio > 1000 karakter ditolak (400)', r.status === 400);
  r = await J.get('/api/dms/' + meM.citizen.id);
  check('Buka DM ke M dari profil (citizen_id): 200', r.status === 200, `status=${r.status}`);
  r = await J.post('/api/dms/' + meM.citizen.id, { content: 'Halo M, salam kenal' });
  check('Kirim DM ke M berhasil', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  const meJ2 = (await J.get('/api/me')).data.citizen;
  r = await M.get('/api/dms');
  check('M melihat percakapan dengan J di daftar DM', r.data.conversations.some((cv) => cv.other_id === meJ2.id), `convs=${r.data.conversations.length}`);

  console.log('\n[29] bcrypt di worker — login tidak memblokir request lain');
  // bcryptjs murni JS: satu hash/verify cost 10 menahan event loop ~100+ ms
  // (diukur: interval 10 ms hanya jalan 2x selama satu hash). Sejak v2.2.0
  // hash/compare jalan di pool worker_threads (2 worker), jadi login yang
  // berbarengan tidak boleh menahan /api/world (cache 30 dtk, trivial).
  // Ditempatkan di akhir seperti [5b]: tidak boleh menggeser ID pemain
  // seksi [12]/[14]; akun baru memakai IP berbeda (X-Forwarded-For).
  const W = new Client();
  W.extraHeaders = { 'X-Forwarded-For': '127.0.0.9' };
  r = await W.post('/api/auth/register', { email: 'wargaW@test.local', password: 'rahasia123', username: 'warga_w' });
  check('Daftar warga W berhasil (hash di worker)', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  const dbW = new DatabaseSync(DB_PATH);
  const hashW = dbW.prepare("SELECT pass_hash FROM users WHERE email = 'wargaw@test.local'").get().pass_hash;
  dbW.close();
  check('Format hash tetap bcrypt standar ($2a$10$)', typeof hashW === 'string' && hashW.startsWith('$2a$10$'), `hash=${String(hashW).slice(0, 7)}...`);
  const W2 = new Client();
  W2.extraHeaders = { 'X-Forwarded-For': '127.0.0.9' };
  r = await W2.post('/api/auth/login', { email: 'wargaW@test.local', password: 'rahasia123' });
  check('Login W berhasil (verify di worker)', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  r = await W2.post('/api/auth/login', { email: 'wargaW@test.local', password: 'salah123' });
  check('Login password salah ditolak (400)', r.status === 400, `status=${r.status}`);
  // Hash LAMA (dibuat bcryptjs sebelum worker, fixture) tetap bisa login —
  // pemain lama tidak perlu reset password.
  const V = new Client();
  V.extraHeaders = { 'X-Forwarded-For': '127.0.0.10' };
  r = await V.post('/api/auth/register', { email: 'wargaV@test.local', password: 'rahasia123', username: 'warga_v' });
  check('Daftar warga V berhasil', r.status === 200 && r.data.ok);
  const dbV = new DatabaseSync(DB_PATH);
  dbV.prepare("UPDATE users SET pass_hash = ? WHERE email = 'wargav@test.local'")
    .run('$2a$10$fDDiCJrRF15.XhYPG.0wzOsqa8NZCqy8L.Qzr7MhLOK8/bVF4Fbu.');
  dbV.close();
  r = await V.post('/api/auth/login', { email: 'wargaV@test.local', password: 'rahasia123' });
  check('Hash lama (pre-worker) tetap bisa login', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  // Bukti tidak memblokir: 6 login berbarengan + 6 /api/world di saat yang
  // sama — /api/world harus tetap cepat (maks < 100 ms). Kalibrasi di VM
  // dev: worker 9 ms vs fallback thread-utama 230 ms untuk beban yang sama.
  const t29 = Date.now();
  const logins29 = Array.from({ length: 6 }, () => {
    const c = new Client();
    c.extraHeaders = { 'X-Forwarded-For': '127.0.0.9' };
    return c.post('/api/auth/login', { email: 'wargaW@test.local', password: 'rahasia123' });
  });
  const worlds29 = Array.from({ length: 6 }, async () => {
    const s = Date.now();
    const rr = await fetch(BASE + '/api/world');
    return { ms: Date.now() - s, ok: rr.ok };
  });
  const [loginResults29, worldResults29] = await Promise.all([Promise.all(logins29), Promise.all(worlds29)]);
  const maxWorldMs29 = Math.max(...worldResults29.map((x) => x.ms));
  check('6 login berbarengan semuanya berhasil', loginResults29.every((x) => x.status === 200 && x.data.ok), `status=${loginResults29.map((x) => x.status).join(',')}`);
  check('/api/world tetap cepat saat 6 login berjalan (maks < 100 ms)', worldResults29.every((x) => x.ok) && maxWorldMs29 < 100, `maks=${maxWorldMs29} ms (total ${Date.now() - t29} ms)`);

  console.log('\n[22m] Kredit skor v3.0.0 — laporan terbukti, pulih +1/hari, batasan tier, ban 0');
  const dbK = new DatabaseSync(DB_PATH);
  const KA = new Client(); // penulis pesan (yang dilaporkan)
  const KB = new Client(); // pelapor
  KA.extraHeaders = { 'X-Forwarded-For': '127.0.0.14' };
  KB.extraHeaders = { 'X-Forwarded-For': '127.0.0.15' };
  r = await KA.post('/api/auth/register', { email: 'kredit_a@test.local', password: 'rahasia123', username: 'kredit_a' });
  check('Kredit: penulis KA mendaftar', r.status === 200 && r.data.ok);
  r = await KB.post('/api/auth/register', { email: 'kredit_b@test.local', password: 'rahasia123', username: 'kredit_b' });
  check('Kredit: pelapor KB mendaftar', r.status === 200 && r.data.ok);
  const meKA = (await KA.get('/api/me')).data;
  const meKB = (await KB.get('/api/me')).data;
  const kaId = meKA.citizen.id; const kbId = meKB.citizen.id;
  const kaUserId = meKA.user.id;
  check('Skor awal 100 + tier Baik + tanpa batasan', meKA.citizen.credit_score === 100 && meKA.credit?.tier === 'baik' && meKA.credit?.restrictions.length === 0, `skor=${meKA.citizen.credit_score} tier=${meKA.credit?.tier}`);
  check('Profil publik menampilkan skor kredit 100', (await KB.get('/api/profile/kredit_a')).data.profile.credit_score === 100);
  // (a) Laporan: KA kirim pesan, KB laporkan; tolak lapor diri + lapor admin.
  r = await KA.post('/api/chat/global', { content: 'Pesan kasar dari KA untuk tes kredit' });
  check('KA mengirim pesan global', r.status === 200 && !!r.data.messageId, `status=${r.status} ${r.data.error || ''}`);
  const kaMsgId = r.data.messageId;
  r = await KB.post('/api/chat/report', { message_id: kaMsgId, reason: 'Pelecehan', details: 'tes kredit' });
  check('KB melaporkan pesan KA', r.status === 200 && r.data.ok);
  dbK.prepare('UPDATE citizens SET last_chat_at = 0 WHERE id = ?').run(kbId);
  r = await KB.post('/api/chat/global', { content: 'Pesan KB sendiri' });
  check('KB mengirim pesan sendiri', r.status === 200 && !!r.data.messageId);
  r = await KB.post('/api/chat/report', { message_id: r.data.messageId, reason: 'Spam' });
  check('Laporan terhadap pesan sendiri ditolak (400)', r.status === 400, `status=${r.status}`);
  dbK.prepare('UPDATE citizens SET last_chat_at = 0 WHERE id = ?').run((await ADM.get('/api/me')).data.citizen.id);
  r = await ADM.post('/api/chat/global', { content: 'Pesan admin darurat' });
  check('Admin mengirim pesan global', r.status === 200 && !!r.data.messageId);
  r = await KB.post('/api/chat/report', { message_id: r.data.messageId, reason: 'Spam' });
  check('Laporan terhadap admin ditolak (400)', r.status === 400, `status=${r.status}`);
  // (b) Putusan admin: tanpa verdict 400; proven −10; tidak bisa diputus 2×.
  r = await ADM.get('/api/admin/reports');
  const repK = (r.data.reports || []).find((x) => x.message_id === kaMsgId && x.status === 'open');
  check('Admin melihat laporan KB atas KA (skor penulis 100)', !!repK && repK.author_credit_score === 100, `skor=${repK?.author_credit_score}`);
  r = await ADM.post(`/api/admin/reports/${repK.id}/review`, {});
  check('Putusan tanpa verdict ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await ADM.post(`/api/admin/reports/${repK.id}/review`, { verdict: 'proven' });
  check("Putusan TERBUKTI: skor penulis 100 → 90", r.status === 200 && r.data.newScore === 90 && r.data.banned === false, JSON.stringify(r.data));
  r = await ADM.post(`/api/admin/reports/${repK.id}/review`, { verdict: 'proven' });
  check('Laporan yang sama tidak bisa diputus 2× (400)', r.status === 400, `status=${r.status}`);
  r = await KA.get('/api/me');
  check('KA: skor kini 90 setelah laporan terbukti', r.data.citizen.credit_score === 90, `skor=${r.data.citizen.credit_score}`);
  r = await KA.get('/api/notifications');
  check('KA: notifikasi Skor kredit berkurang', (r.data.notifications || []).some((n) => n.title === 'Skor kredit berkurang'));
  // (c) Pulih +1/hari (malas): jam dimundurkan 2 hari → 90 + 2 = 92.
  dbK.prepare('UPDATE citizens SET credit_updated_at = ? WHERE id = ?').run(Date.now() - 2 * 24 * 60 * 60 * 1000, kaId);
  r = await KA.get('/api/me');
  check('Pulih +1/hari: 90 → 92 setelah 2 hari', r.data.citizen.credit_score === 92, `skor=${r.data.citizen.credit_score}`);
  const setScoreK = (score) => dbK.prepare('UPDATE citizens SET credit_score = ?, credit_updated_at = ? WHERE id = ?').run(score, Date.now(), kaId);
  // (d) Batasan tier — 75: pers dibatasi; 55: partai; 35: pasar; 15: chat/DM.
  setScoreK(75);
  r = await KA.post('/api/press/newspaper', {});
  check('Skor 75: buat koran ditolak (403)', r.status === 403, `status=${r.status}`);
  r = await KA.post('/api/press/articles', {});
  check('Skor 75: terbitkan artikel ditolak (403)', r.status === 403, `status=${r.status}`);
  setScoreK(55);
  r = await KA.post('/api/parties', {});
  check('Skor 55: dirikan partai ditolak (403)', r.status === 403, `status=${r.status}`);
  r = await KA.post('/api/elections/999999/nominate', {});
  check('Skor 55: mencalonkan ditolak (403)', r.status === 403, `status=${r.status}`);
  setScoreK(35);
  r = await KA.post('/api/market/buy', {});
  check('Skor 35: beli di pasar ditolak (403)', r.status === 403, `status=${r.status}`);
  r = await KA.post('/api/market/sell', {});
  check('Skor 35: jual di pasar ditolak (403)', r.status === 403, `status=${r.status}`);
  // Pesan kedua dikirim SELAGI skor masih 35 (≥20, masih boleh chat) —
  // laporannya dipakai untuk menguji ban di skor 10 nanti.
  dbK.prepare('UPDATE citizens SET last_chat_at = 0 WHERE id = ?').run(kaId);
  r = await KA.post('/api/chat/global', { content: 'Pesan kedua KA untuk tes ban' });
  check('KA mengirim pesan kedua (skor 35, masih boleh chat)', r.status === 200 && !!r.data.messageId, `status=${r.status} ${r.data.error || ''}`);
  const kaMsgId2 = r.data.messageId;
  r = await KB.post('/api/chat/report', { message_id: kaMsgId2, reason: 'Ujaran kebencian' });
  check('KB melaporkan pesan kedua KA', r.status === 200 && r.data.ok);
  setScoreK(15);
  r = await KA.post('/api/chat/global', { content: 'tes skor 15' });
  check('Skor 15: kirim chat ditolak (403)', r.status === 403, `status=${r.status}`);
  r = await KA.post('/api/dms/' + kbId, { content: 'tes dm skor 15' });
  check('Skor 15: kirim DM ditolak (403)', r.status === 403, `status=${r.status}`);
  // (e) Skor 0 = ban otomatis; unban pulihkan ke 50.
  setScoreK(10);
  r = await ADM.get('/api/admin/reports');
  const repK2 = (r.data.reports || []).find((x) => x.status === 'open' && x.author_id === kaId);
  check('Laporan kedua masih open', !!repK2, `id=${repK2?.id}`);
  r = await ADM.post(`/api/admin/reports/${repK2.id}/review`, { verdict: 'proven' });
  check('Putusan TERBUKTI kedua: skor 10 → 0 + akun dibanned', r.status === 200 && r.data.newScore === 0 && r.data.banned === true, JSON.stringify(r.data));
  r = await KA.post('/api/auth/login', { email: 'kredit_a@test.local', password: 'rahasia123' });
  check('Login KA yang dibanned: banned=true (bisa buka layar banned + banding)', r.status === 200 && r.data.banned === true, `banned=${r.data.banned}`);
  r = await KA.get('/api/me');
  check('KA yang dibanned: /api/me tetap 200 (layar banned butuh status) + is_banned', r.status === 200 && r.data.user.is_banned === true, `status=${r.status} banned=${r.data.user.is_banned}`);
  r = await KA.post('/api/chat/global', { content: 'tes saat banned' });
  check('KA yang dibanned: API game diblokir (chat 403)', r.status === 403, `status=${r.status}`);
  r = await ADM.post('/api/admin/unban', { user_id: kaUserId });
  check('Admin unban KA', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  r = await KA.get('/api/me');
  check('Setelah unban: skor dipulihkan ke 50', r.data.citizen.credit_score === 50, `skor=${r.data.citizen.credit_score}`);
  dbK.prepare('UPDATE citizens SET last_chat_at = 0 WHERE id = ?').run(kaId);
  r = await KA.post('/api/chat/global', { content: 'Aku kembali setelah unban' });
  check('KA bisa chat lagi setelah unban (skor 50 ≥ 20)', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  // (f) Putusan TIDAK TERBUKTI: skor tidak berubah.
  r = await KB.post('/api/chat/report', { message_id: r.data.messageId, reason: 'Spam' });
  check('KB melaporkan pesan ketiga KA', r.status === 200 && r.data.ok);
  r = await ADM.get('/api/admin/reports');
  const repK3 = (r.data.reports || []).find((x) => x.status === 'open' && x.author_id === kaId);
  r = await ADM.post(`/api/admin/reports/${repK3.id}/review`, { verdict: 'not_proven' });
  check('Putusan TIDAK TERBUKTI: newScore null, tanpa ban', r.status === 200 && r.data.newScore === null && r.data.banned === false, JSON.stringify(r.data));
  r = await KA.get('/api/me');
  check('Skor tetap 50 setelah putusan tidak terbukti', r.data.citizen.credit_score === 50, `skor=${r.data.citizen.credit_score}`);
  // (g) Riwayat skor + daftar pemain admin.
  r = await ADM.get('/api/admin/credit-history/' + kaUserId);
  check('Riwayat skor: 2 pengurangan + 1 pemulihan unban', (r.data.history || []).length === 3
    && r.data.history.some((h) => h.delta === -10 && h.score_after === 90)
    && r.data.history.some((h) => h.delta === -10 && h.score_after === 0)
    && r.data.history.some((h) => h.delta === 50 && h.score_after === 50),
    JSON.stringify((r.data.history || []).map((h) => `${h.delta}→${h.score_after}`)));
  r = await ADM.get('/api/admin/players?q=kredit_a');
  check('Daftar pemain admin menampilkan skor kredit 50', (r.data.players || [])[0]?.credit_score === 50, `skor=${(r.data.players || [])[0]?.credit_score}`);
  console.log('\n[22n] Fitur tiket v3.1.0 — ubah penawaran, XP proporsional/ratusan, jam ganda, konvoi bahan, minuman energi, blokir');
  const dbN = new DatabaseSync(DB_PATH);
  const T1 = new Client(); const T2 = new Client(); const T3 = new Client(); const T4 = new Client(); const T5 = new Client();
  T1.extraHeaders = { 'X-Forwarded-For': '127.0.0.21' };
  T2.extraHeaders = { 'X-Forwarded-For': '127.0.0.22' };
  T3.extraHeaders = { 'X-Forwarded-For': '127.0.0.23' };
  T4.extraHeaders = { 'X-Forwarded-For': '127.0.0.24' };
  T5.extraHeaders = { 'X-Forwarded-For': '127.0.0.25' };
  r = await T1.post('/api/auth/register', { email: 'tiket1@test.local', password: 'rahasia123', username: 'tiket_satu' });
  check('Tiket: T1 mendaftar', r.status === 200 && r.data.ok);
  r = await T2.post('/api/auth/register', { email: 'tiket2@test.local', password: 'rahasia123', username: 'tiket_dua' });
  check('Tiket: T2 mendaftar', r.status === 200 && r.data.ok);
  r = await T3.post('/api/auth/register', { email: 'tiket3@test.local', password: 'rahasia123', username: 'tiket_tiga' });
  check('Tiket: T3 mendaftar', r.status === 200 && r.data.ok);
  r = await T4.post('/api/auth/register', { email: 'tiket4@test.local', password: 'rahasia123', username: 'tiket_empat' });
  check('Tiket: T4 mendaftar', r.status === 200 && r.data.ok);
  r = await T5.post('/api/auth/register', { email: 'tiket5@test.local', password: 'rahasia123', username: 'tiket_lima' });
  check('Tiket: T5 mendaftar', r.status === 200 && r.data.ok);
  const meT1 = (await T1.get('/api/me')).data;
  const meT2 = (await T2.get('/api/me')).data;
  const meT3 = (await T3.get('/api/me')).data;
  const meT4 = (await T4.get('/api/me')).data;
  const comIdN = (name) => dbN.prepare('SELECT id FROM commodities WHERE name = ?').get(name)?.id;
  const besiN = comIdN('Besi Mentah');
  const gandumN = comIdN('Gandum Mentah');
  const invQtyN = (citizenId, commodityId) => dbN.prepare('SELECT qty FROM inventory WHERE citizen_id = ? AND commodity_id = ? AND tier = 1').get(citizenId, commodityId)?.qty || 0;

  // --- (a) #23 Ubah penawaran pasar.
  dbN.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,?)').run(meT1.citizen.id, besiN, 20);
  r = await T1.post('/api/market/sell', { scope: 'local', commodity_id: besiN, tier: 1, qty: 10, price: 9 });
  check('T1 pasang penawaran jual 10× Besi @9', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await T1.get('/api/market?scope=local');
  const offerN = (r.data.mine || []).find((o) => o.commodity_id === besiN);
  check('Penawaran T1 tampil di Penawaranku', !!offerN, JSON.stringify((r.data.mine || []).map((o) => o.id)));
  r = await T1.patch('/api/market/offers/' + offerN.id, { qty: 15 });
  check('Ubah penawaran: jumlah 10 → 15 (tambah 5 dari inventaris)', r.status === 200 && r.data.offer.qty === 15, `status=${r.status} qty=${r.data.offer?.qty} ${r.data.error || ''}`);
  check('Inventaris Besi berkurang 20 → 5', invQtyN(meT1.citizen.id, besiN) === 5, `besi=${invQtyN(meT1.citizen.id, besiN)}`);
  r = await T1.patch('/api/market/offers/' + offerN.id, { qty: 8 });
  check('Ubah penawaran di bawah min 10 ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await T1.patch('/api/market/offers/' + offerN.id, { qty: 12 });
  check('Ubah penawaran: jumlah 15 → 12 (3 kembali ke inventaris)', r.status === 200 && r.data.offer.qty === 12, `qty=${r.data.offer?.qty}`);
  check('Inventaris Besi kembali 5 → 8', invQtyN(meT1.citizen.id, besiN) === 8, `besi=${invQtyN(meT1.citizen.id, besiN)}`);
  r = await T1.patch('/api/market/offers/' + offerN.id, { price: 10 });
  check('Ubah harga penawaran 9 → 10', r.status === 200 && eq(r.data.offer.price, 10), `price=${r.data.offer?.price}`);
  r = await T2.patch('/api/market/offers/' + offerN.id, { qty: 11 });
  check('Ubah penawaran orang lain ditolak (404)', r.status === 404, `status=${r.status}`);
  r = await T1.patch('/api/market/offers/999999', { qty: 11 });
  check('Ubah penawaran yang tidak ada ditolak (404)', r.status === 404, `status=${r.status}`);
  r = await T2.post('/api/market/buy-order', { scope: 'local', commodity_id: besiN, tier: 1, qty: 10, price: 9 });
  check('T2 pasang order beli 10× Besi @9 (tanpa escrow v2.3.0)', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  r = await T2.get('/api/market?scope=local');
  const orderN = (r.data.myBuyOrders || []).find((o) => o.commodity_id === besiN);
  check('Order beli T2 tampil di Order Beliku', !!orderN);
  r = await T2.patch('/api/market/buy-orders/' + orderN.id, { qty: 20, price: 10 });
  check('Ubah order beli: 10 → 20 @10', r.status === 200 && r.data.order.qty === 20 && eq(r.data.order.price, 10), `qty=${r.data.order?.qty} price=${r.data.order?.price}`);
  r = await T2.patch('/api/market/buy-orders/' + orderN.id, { qty: 5 });
  check('Ubah order beli di bawah min 10 ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await T1.patch('/api/market/buy-orders/' + orderN.id, { qty: 12 });
  check('Ubah order beli orang lain ditolak (404)', r.status === 404, `status=${r.status}`);

  // --- (b) #22 Threshold XP ratusan + XP shift proporsional.
  check('Threshold baru: Level 1 butuh 100 XP (dulu 5)', meT3.citizen.level === 1 && meT3.citizen.xp === 0 && meT3.xpNext === 100, `level=${meT3.citizen.level} xp=${meT3.citizen.xp} xpNext=${meT3.xpNext}`);
  r = await T3.post('/api/claim');
  check('T3 klaim: +40 XP', r.status === 200 && r.data.reward.xp === 40);
  r = await T3.post('/api/train', { attr: 'str' });
  check('T3 latih: +20 XP', r.status === 200);
  r = await T3.get('/api/me');
  check('60 XP masih Level 1 di skala ratusan (skala lama: sudah Level 4+)', r.data.citizen.level === 1 && r.data.citizen.xp === 60 && r.data.xpNext === 100, `level=${r.data.citizen.level} xp=${r.data.citizen.xp}`);
  const jobsT3 = (await T3.get('/api/jobs')).data.jobs;
  const jobT3 = jobsT3.find((x) => x.is_admin === 1 && x.region_id === meT3.citizen.region_id);
  check('Ada lowongan ADMIN di wilayah T3', !!jobT3);
  r = await T3.post('/api/jobs/apply', { job_id: jobT3.id });
  check('T3 melamar ADMIN', r.status === 200 && r.data.ok);
  dbN.prepare('UPDATE citizens SET energy = 50 WHERE id = ?').run(meT3.citizen.id);
  const wibHour = (new Date().getUTCHours() + 7) % 24;
  const expectDouble = wibHour === 0;
  // Tahap 6: minggu Festival Rakyat memberi XP shift +50%.
  const festN = meT3.worldEvent?.key === 'festival' ? 1.5 : 1;
  const expectShiftXp = Math.round((expectDouble ? 20 : 10) * festN);
  r = await T3.post('/api/jobs/shift');
  check(`Shift 50 energi: xpGained ${expectShiftXp} (proporsional, ${expectDouble ? 'jam ganda ×2' : 'di luar jam ganda'}${festN > 1 ? ' + festival ×1,5' : ''})`, r.status === 200 && r.data.xpGained === expectShiftXp, `xpGained=${r.data.xpGained} doubleXp=${r.data.doubleXp} festivalXp=${r.data.festivalXp} jamWIB=${wibHour}`);
  check('Flag doubleXp shift cocok dengan jam WIB sekarang', r.data.doubleXp === expectDouble, `doubleXp=${r.data.doubleXp} jamWIB=${wibHour}`);
  r = await T3.get('/api/me');
  check(`XP T3 total 60 + shift = ${60 + expectShiftXp}`, r.data.citizen.xp === 60 + expectShiftXp, `xp=${r.data.citizen.xp}`);

  // --- (c) #20 Konvoi dibayar bahan, bukan emas.
  r = await T4.get('/api/convoy');
  const healthB = (r.data.buildings || []).find((b) => b.type === 'health');
  check('Resep RS Lapangan: 20 Gandum + 30 Besi (ditampilkan di API)', !!healthB && healthB.cost.length === 2
    && healthB.cost.some((c) => c.name === 'Gandum Mentah' && c.qty === 20)
    && healthB.cost.some((c) => c.name === 'Besi Mentah' && c.qty === 30),
    JSON.stringify(healthB?.cost));
  check('Resep menampilkan jumlah yang dimiliki (0/20, 0/30)', !!healthB && healthB.cost.every((c) => c.owned === 0));
  r = await T4.post('/api/convoy/build', { building: 'health' });
  check('Bangun konvoi tanpa bahan ditolak 400 + pesan jelas', r.status === 400 && /Bahan tidak cukup/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  dbN.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,?)').run(meT4.citizen.id, gandumN, 20);
  dbN.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,?)').run(meT4.citizen.id, besiN, 30);
  r = await T4.post('/api/convoy/build', { building: 'health' });
  check('Bangun RS Lapangan dengan bahan cukup berhasil', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  r = await T4.get('/api/me');
  check('Emas T4 tetap 50 (konvoi tidak lagi pakai emas)', r.data.citizen.gold === 50, `emas=${r.data.citizen.gold}`);
  check('Bahan terpotong habis: Gandum 0, Besi 0', invQtyN(meT4.citizen.id, gandumN) === 0 && invQtyN(meT4.citizen.id, besiN) === 0,
    `gandum=${invQtyN(meT4.citizen.id, gandumN)} besi=${invQtyN(meT4.citizen.id, besiN)}`);
  r = await T4.get('/api/convoy');
  check('Konvoi RS Lapangan terdaftar di /api/convoy', (r.data.convoys || []).some((c) => c.building === 'health'));
  r = await T4.post('/api/convoy/build', { building: 'health' });
  check('Bangun jenis yang sama 2× ditolak (400)', r.status === 400, `status=${r.status}`);

  // --- (d) #17 Minuman Energi: beli 0,10 emas, minum +1, cap energi.
  r = await T4.post('/api/shop/energy-drink', { qty: 0 });
  check('Beli 0 kaleng ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await T4.post('/api/shop/energy-drink', { qty: 101 });
  check('Beli 101 kaleng ditolak (400, maks 100)', r.status === 400, `status=${r.status}`);
  r = await T4.post('/api/shop/energy-drink', { qty: 10 });
  check('Beli 10 kaleng: bayar 1 emas (10 × 0,10)', r.status === 200 && r.data.qty === 10 && eq(r.data.cost, 1), `cost=${r.data.cost} ${r.data.error || ''}`);
  r = await T4.get('/api/me');
  check('Emas T4 50 → 49 setelah beli minuman', r.data.citizen.gold === 49, `emas=${r.data.citizen.gold}`);
  r = await T4.get('/api/inventory');
  const drinkItem = (r.data.items || []).find((i) => i.name === 'Minuman Energi');
  check('Inventaris lengkap: 10× Minuman Energi tercatat', !!drinkItem && drinkItem.qty === 10, `qty=${drinkItem?.qty}`);
  check('Inventaris lengkap: barang awal (Makanan, Senjata, Tiket) tetap ada', ['Makanan', 'Senjata', 'Tiket'].every((n) => (r.data.items || []).some((i) => i.name === n)));
  // Cap energi T4 = 110 (100 + 10 RS Lapangan yang baru dibangun) — bukan
  // 100. Set energy_updated_at = sekarang supaya regen malas tidak
  // menambah energi sebelum request minum.
  dbN.prepare('UPDATE citizens SET energy = 109, energy_updated_at = ? WHERE id = ?').run(Date.now(), meT4.citizen.id);
  r = await T4.post('/api/inventory/drink', { qty: 5 });
  check('Minum 5 kaleng di energi 109: hanya +1 (cap 110), sisa 9 kaleng', r.status === 200 && r.data.gained === 1 && r.data.energy === 110 && r.data.remaining === 9,
    `gained=${r.data.gained} energy=${r.data.energy} remaining=${r.data.remaining}`);
  r = await T4.post('/api/inventory/drink', { qty: 1 });
  check('Minum saat energi penuh ditolak (400)', r.status === 400, `status=${r.status}`);
  dbN.prepare('UPDATE citizens SET energy = 50, energy_updated_at = ? WHERE id = ?').run(Date.now(), (await T5.get('/api/me')).data.citizen.id);
  r = await T5.post('/api/inventory/drink', { qty: 1 });
  check('Minum tanpa kaleng ditolak (400)', r.status === 400 && /Tidak ada Minuman Energi/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);

  // --- (e) #14 Daftar blokir + buka blokir.
  r = await T1.post('/api/chat/block', { citizen_id: meT2.citizen.id });
  check('T1 memblokir T2', r.status === 200 && r.data.ok);
  r = await T1.post('/api/chat/block', { citizen_id: meT2.citizen.id });
  check('Blokir 2× tetap 200 (idempotent)', r.status === 200);
  r = await T1.post('/api/chat/block', { citizen_id: meT1.citizen.id });
  check('Blokir diri sendiri ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await T1.get('/api/chat/blocked');
  check('Daftar blokir T1 berisi T2 (nama + id)', (r.data.blocked || []).some((b) => b.citizen_id === meT2.citizen.id && b.username === 'tiket_dua'),
    JSON.stringify(r.data.blocked));
  r = await T1.post('/api/chat/unblock', { citizen_id: meT2.citizen.id });
  check('T1 membuka blokir T2', r.status === 200 && r.data.ok);
  r = await T1.get('/api/chat/blocked');
  check('Daftar blokir kosong setelah buka blokir', (r.data.blocked || []).length === 0, `n=${(r.data.blocked || []).length}`);
  console.log('\n[22o] Tahap 6 v4.0.0 — militer, kepemilikan wilayah, rantai produksi, reputasi, demografi, event dunia');
  const dbS6 = new DatabaseSync(DB_PATH);
  const M1 = new Client(); const M2 = new Client(); const M3 = new Client(); const M4 = new Client();
  const M5 = new Client(); const M6 = new Client(); const M7 = new Client(); const M8 = new Client();
  M1.extraHeaders = { 'X-Forwarded-For': '127.0.0.31' };
  M2.extraHeaders = { 'X-Forwarded-For': '127.0.0.32' };
  M3.extraHeaders = { 'X-Forwarded-For': '127.0.0.33' };
  M4.extraHeaders = { 'X-Forwarded-For': '127.0.0.34' };
  M5.extraHeaders = { 'X-Forwarded-For': '127.0.0.35' };
  M6.extraHeaders = { 'X-Forwarded-For': '127.0.0.36' };
  M7.extraHeaders = { 'X-Forwarded-For': '127.0.0.37' };
  M8.extraHeaders = { 'X-Forwarded-For': '127.0.0.38' };
  for (const [i, C] of [[1, M1], [2, M2], [3, M3], [4, M4], [5, M5], [6, M6], [7, M7], [8, M8]]) {
    r = await C.post('/api/auth/register', { email: `tahap6m${i}@test.local`, password: 'rahasia123', username: `tahap6_m${i}` });
    check(`Tahap 6: M${i} mendaftar`, r.status === 200 && r.data.ok, `status=${r.status}`);
  }
  const meM1 = (await M1.get('/api/me')).data;
  const meM2 = (await M2.get('/api/me')).data;
  const meM3o = (await M3.get('/api/me')).data;
  const meM4 = (await M4.get('/api/me')).data;
  const meM5 = (await M5.get('/api/me')).data;
  const meM6 = (await M6.get('/api/me')).data;
  const meM7 = (await M7.get('/api/me')).data;
  const meM8 = (await M8.get('/api/me')).data;
  const m1Id = meM1.citizen.id; const m2Id = meM2.citizen.id; const m3Id = meM3o.citizen.id; const m4Id = meM4.citizen.id;
  const m5Id = meM5.citizen.id; const m6Id = meM6.citizen.id; const m7Id = meM7.citizen.id; const m8Id = meM8.citizen.id;
  const comIdO = (name) => dbS6.prepare('SELECT id FROM commodities WHERE name = ?').get(name)?.id;
  const senjataO = comIdO('Senjata'); const droneO = comIdO('Drone'); const bahanO = comIdO('Bahan Bangunan');
  const besiO = comIdO('Besi Mentah'); const gandumO = comIdO('Gandum Mentah'); const minyakO = comIdO('Minyak Mentah');
  const invQtyO = (citizenId, commodityId) => dbS6.prepare('SELECT qty FROM inventory WHERE citizen_id = ? AND commodity_id = ? AND tier = 1').get(citizenId, commodityId)?.qty || 0;
  const setInvO = (citizenId, commodityId, qty) => dbS6.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,?) ON CONFLICT (citizen_id, commodity_id, tier) DO UPDATE SET qty = ?').run(citizenId, commodityId, qty, qty);
  // v4.6.0: baca isi stok bahan perusahaan (company_stock).
  const stockQtyO = (companyId, commodityId) => dbS6.prepare('SELECT qty FROM company_stock WHERE company_id = ? AND commodity_id = ?').get(companyId, commodityId)?.qty || 0;
  const setEnergyO = (citizenId, energy) => dbS6.prepare('UPDATE citizens SET energy = ?, energy_updated_at = ? WHERE id = ?').run(energy, Date.now(), citizenId);
  const setDayO = (day) => dbS6.prepare('UPDATE world SET day = ? WHERE id = 1').run(day);
  const unitsO = (citizenId) => dbS6.prepare('SELECT unit_type, qty FROM military_units WHERE citizen_id = ?').all(citizenId);
  const regionA = meM5.citizen.region_id;
  // Wilayah B harus berbeda dari A (registrasi acak bisa sama).
  const regionB = regionA === meM6.citizen.region_id ? (regionA % 17) + 1 : meM6.citizen.region_id;
  dbS6.prepare('UPDATE citizens SET region_id = ?, home_region_id = ? WHERE id = ?').run(regionB, regionB, m6Id);
  // Wilayah aman untuk M1: dibebaskan PAKSA via DB (seksi lama memaksa
  // semua 17 wilayah ke negara 1 lewat DB langsung, jadi tidak ada wilayah
  // yang benar-benar bebas) — supaya serangan (b)/(f) tidak kena bonus
  // lingkungan (mobilisasi, anggaran perang, ideologi) dari negara itu.
  const safeRegionO = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].find((x) => x !== regionA && x !== regionB);
  dbS6.prepare("UPDATE regions SET country_id = NULL, controller = 'bebas', controller_id = NULL WHERE id = ?").run(safeRegionO);
  dbS6.prepare('UPDATE citizens SET region_id = ?, home_region_id = ? WHERE id = ?').run(safeRegionO, safeRegionO, m1Id);

  // --- (a) Militer: rekrut / bubarkan / batas / biaya.
  setInvO(m1Id, senjataO, 100); setInvO(m1Id, droneO, 50); setInvO(m1Id, bahanO, 50);
  r = await M1.get('/api/military');
  check('GET /api/military: awal kosong, cap 60 (Lv 1 = 50+10), 3 jenis unit', r.status === 200 && r.data.power === 0 && r.data.mult === 1 && r.data.cap === 60 && Object.keys(r.data.defs || {}).length === 3, JSON.stringify({ power: r.data.power, cap: r.data.cap }));
  r = await M1.get('/api/me');
  check('GET /api/me: military.cap = 50+10×level (kartu dashboard tidak lagi undefined)', r.status === 200 && r.data.military && r.data.military.cap === 50 + 10 * r.data.citizen.level, JSON.stringify({ cap: r.data.military?.cap, level: r.data.citizen?.level }));
  r = await M1.post('/api/military/recruit', { type: 'kavaleri', qty: 1 });
  check('Rekrut jenis tak dikenal ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await M1.post('/api/military/recruit', { type: 'infantry', qty: 0 });
  check('Rekrut 0 unit ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await M1.post('/api/military/recruit', { type: 'infantry', qty: 51 });
  check('Rekrut 51 unit ditolak (400, maks 50)', r.status === 400, `status=${r.status}`);
  r = await M1.post('/api/military/recruit', { type: 'infantry', qty: 10 });
  check('Rekrut 10 Infanteri: kekuatan 20, pengali 1,10, perawatan 10', r.status === 200 && r.data.power === 20 && r.data.mult === 1.1 && r.data.upkeep === 10 && r.data.count === 10, JSON.stringify({ power: r.data.power, mult: r.data.mult }));
  check('Rekrut 10 Infanteri: 10 Senjata + 50 USD terpotong', invQtyO(m1Id, senjataO) === 90 && (await M1.get('/api/me')).data.citizen.usd === 450, `senjata=${invQtyO(m1Id, senjataO)}`);
  r = await M1.post('/api/military/recruit', { type: 'drone', qty: 10 });
  check('Rekrut 10 Drone: kekuatan 70, pengali 1,35, perawatan 30', r.status === 200 && r.data.power === 70 && r.data.mult === 1.35 && r.data.upkeep === 30, JSON.stringify({ power: r.data.power, mult: r.data.mult }));
  r = await M1.post('/api/military/recruit', { type: 'heavy', qty: 2 });
  check('Rekrut 2 Kendaraan Berat: kekuatan 94, pengali 1,47', r.status === 200 && r.data.power === 94 && r.data.mult === 1.47, JSON.stringify({ power: r.data.power, mult: r.data.mult }));
  check('Rekrut Kendaraan Berat: 4 Bahan Bangunan + 40 USD terpotong', invQtyO(m1Id, bahanO) === 46, `bahan=${invQtyO(m1Id, bahanO)}`);
  r = await M1.post('/api/military/recruit', { type: 'infantry', qty: 50 });
  check('Rekrut melewati batas 60 unit ditolak (400)', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  r = await M1.post('/api/military/recruit', { type: 'infantry', qty: 38 });
  check('Rekrut sampai batas persis 60 unit berhasil, pengali mentok 1,5', r.status === 200 && r.data.count === 60 && r.data.mult === 1.5, JSON.stringify({ count: r.data.count, mult: r.data.mult }));
  r = await M1.post('/api/military/recruit', { type: 'infantry', qty: 1 });
  check('Rekrut di atas batas ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await M1.post('/api/military/disband', { type: 'drone', qty: 3 });
  check('Bubarkan 3 Drone: kekuatan 155, tetap ×1,5', r.status === 200 && r.data.power === 155 && r.data.mult === 1.5 && r.data.count === 57, JSON.stringify({ power: r.data.power, count: r.data.count }));
  r = await M1.post('/api/military/disband', { type: 'drone', qty: 99 });
  check('Bubarkan melebihi yang dimiliki ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await M1.post('/api/military/disband', { type: 'infantry', qty: 48 });
  check('Bubarkan 48 Infanteri: kekuatan 59, pengali 1,30', r.status === 200 && r.data.power === 59 && r.data.mult === 1.3, JSON.stringify({ power: r.data.power, mult: r.data.mult }));
  r = await M1.post('/api/military/disband', { type: 'drone', qty: 7 });
  r = await M1.post('/api/military/disband', { type: 'heavy', qty: 2 });
  check('Bubarkan semua: kekuatan 0, pengali 1', r.status === 200 && r.data.power === 0 && r.data.mult === 1 && r.data.count === 0, JSON.stringify(r.data));

  // --- (b) Serangan perang memakai pengali militer.
  setDayO(1); // minggu Panen Raya — bukan Darurat Militer, supaya pengali murni dari unit
  const warO = dbS6.prepare("INSERT INTO wars (name, region_id, attacker_label, defender_label, score_a, score_d, status, winner, ends_at, created_at) VALUES (?,?,?,?,0,0,'active','',?,?)")
    .run('Perang Tahap 6', safeRegionO, 'Pemberontak Tahap 6', 'Pembela Tahap 6', Date.now() + 7 * 86400000, Date.now());
  const warOId = Number(warO.lastInsertRowid);
  setInvO(m1Id, senjataO, 10); setEnergyO(m1Id, 100);
  r = await M1.post(`/api/wars/${warOId}/attack`, { side: 'defender', ammo: 'Senjata' });
  check('Serang tanpa unit: kerusakan dasar 20, tanpa bonus pasukan', r.status === 200 && r.data.damage === 20 && !(r.data.bonuses || []).some((b) => b.startsWith('Pasukan')), `damage=${r.data.damage} bonuses=${JSON.stringify(r.data.bonuses)}`);
  setInvO(m1Id, senjataO, 10); // serangan di atas memakai 1 Senjata — isi lagi 10 untuk rekrut
  r = await M1.post('/api/military/recruit', { type: 'infantry', qty: 10 });
  check('Rekrut 10 Infanteri lagi untuk perang', r.status === 200 && r.data.power === 20);
  setEnergyO(m1Id, 100); setInvO(m1Id, senjataO, 5); // amunisi untuk serangan
  r = await M1.post(`/api/wars/${warOId}/attack`, { side: 'defender', ammo: 'Senjata' });
  check('Serang dengan 10 Infanteri: kerusakan 20 → 22 (×1,10) + label Pasukan', r.status === 200 && r.data.damage === 22 && (r.data.bonuses || []).includes('Pasukan +10%'), `damage=${r.data.damage} bonuses=${JSON.stringify(r.data.bonuses)}`);
  r = await M1.get('/api/wars/' + warOId);
  check('Detail perang: militaryPower 20, militaryMult 1,1', r.data.militaryPower === 20 && r.data.militaryMult === 1.1, JSON.stringify({ p: r.data.militaryPower, m: r.data.militaryMult }));
  await M1.post('/api/military/disband', { type: 'infantry', qty: 10 });

  // --- (c) SATU tick: penutupan perang (kepemilikan) + perawatan + produksi.
  // M2: 5 Infanteri + 5 Drone (perawatan 15 USD/hari) tapi saldo hanya 5 USD
  // -> Drone (termahal) desersi, Infanteri bertahan, saldo habis.
  setInvO(m2Id, senjataO, 5); setInvO(m2Id, droneO, 5);
  r = await M2.post('/api/military/recruit', { type: 'infantry', qty: 5 });
  check('M2 merekrut 5 Infanteri', r.status === 200 && r.data.power === 10);
  r = await M2.post('/api/military/recruit', { type: 'drone', qty: 5 });
  check('M2 merekrut 5 Drone', r.status === 200 && r.data.power === 35);
  dbS6.prepare('UPDATE citizens SET usd = 5 WHERE id = ?').run(m2Id);
  // M3: Industri Ringan + 5 Gandum -> produksi 5 Makanan (butuh 8, bahan 5).
  dbS6.prepare('UPDATE citizens SET gold = 1000 WHERE id = ?').run(m3Id);
  r = await M3.post('/api/companies', { type: 'light', name: 'Dapur Enam' });
  check('M3 mendirikan Industri Ringan', r.status === 200 && !!r.data.companyId, `status=${r.status}`);
  const dapurEnamId = r.data.companyId;
  setInvO(m3Id, gandumO, 5);
  // v4.6.0: produksi mengambil dari STOK perusahaan — isi stok dulu.
  r = await M3.post(`/api/companies/${dapurEnamId}/stock`, { commodity: 'Gandum Mentah', qty: 5 });
  check('M3 mengisi stok Dapur Enam: 5 Gandum', r.status === 200 && r.data.stock?.[0]?.qty === 5, `status=${r.status} ${r.data.error || ''}`);
  const makananM3Before = invQtyO(m3Id, comIdO('Makanan'));
  // M4: Industri Berat + 2 Besi + 2 Minyak -> produksi 2 Drone (butuh 3+3).
  dbS6.prepare('UPDATE citizens SET gold = 1000 WHERE id = ?').run(m4Id);
  r = await M4.post('/api/companies', { type: 'heavy', name: 'Berat Enam' });
  check('M4 mendirikan Industri Berat', r.status === 200 && !!r.data.companyId, `status=${r.status}`);
  const beratEnamId = r.data.companyId;
  setInvO(m4Id, besiO, 2); setInvO(m4Id, minyakO, 2);
  r = await M4.post(`/api/companies/${beratEnamId}/stock`, { commodity: 'Besi Mentah', qty: 2 });
  check('M4 mengisi stok Berat Enam: 2 Besi', r.status === 200 && r.data.stock?.[0]?.qty === 2, `status=${r.status} ${r.data.error || ''}`);
  r = await M4.post(`/api/companies/${beratEnamId}/stock`, { commodity: 'Minyak Mentah', qty: 2 });
  check('M4 mengisi stok Berat Enam: 2 Minyak', r.status === 200 && r.data.stock?.[0]?.qty === 2, `status=${r.status} ${r.data.error || ''}`);
  const droneM4Before = invQtyO(m4Id, droneO);
  // Perang A (penyerang menang): panglima = M1 (kerusakan terbanyak 60 vs 40).
  const warA = dbS6.prepare("INSERT INTO wars (name, region_id, attacker_label, defender_label, score_a, score_d, status, winner, ends_at, created_at) VALUES (?,?,?,?,?,?,'active','',?,?)")
    .run('Perang Rebut A', regionA, 'Pemberontak A', 'Pembela A', 100, 10, Date.now() - 1000, Date.now());
  const warAId = Number(warA.lastInsertRowid);
  dbS6.prepare('INSERT INTO war_attacks (war_id, citizen_id, side, damage, ammo, created_at) VALUES (?,?,?,?,?,?)').run(warAId, m1Id, 'attacker', 60, 'Senjata', Date.now());
  dbS6.prepare('INSERT INTO war_attacks (war_id, citizen_id, side, damage, ammo, created_at) VALUES (?,?,?,?,?,?)').run(warAId, m2Id, 'attacker', 40, 'Senjata', Date.now());
  dbS6.prepare('INSERT INTO war_attacks (war_id, citizen_id, side, damage, ammo, created_at) VALUES (?,?,?,?,?,?)').run(warAId, m6Id, 'defender', 5, 'Senjata', Date.now());
  // Perang B (pembela menang): wilayah B sudah dikuasai pemberontak -> dibebaskan.
  dbS6.prepare("UPDATE regions SET controller = 'pemberontak', controller_id = ? WHERE id = ?").run(m1Id, regionB);
  const warB = dbS6.prepare("INSERT INTO wars (name, region_id, attacker_label, defender_label, score_a, score_d, status, winner, ends_at, created_at) VALUES (?,?,?,?,?,?,'active','',?,?)")
    .run('Perang Rebut B', regionB, 'Pemberontak B', 'Pembela B', 10, 100, Date.now() - 1000, Date.now());
  const warBId = Number(warB.lastInsertRowid);
  dbS6.prepare('INSERT INTO war_attacks (war_id, citizen_id, side, damage, ammo, created_at) VALUES (?,?,?,?,?,?)').run(warBId, m1Id, 'attacker', 10, 'Senjata', Date.now());
  dbS6.prepare('INSERT INTO war_attacks (war_id, citizen_id, side, damage, ammo, created_at) VALUES (?,?,?,?,?,?)').run(warBId, m6Id, 'defender', 50, 'Senjata', Date.now());
  // Paksa tick (pola [12]): mundurkan tanggal, picu, polling sampai hari 2.
  const ydayO = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  dbS6.prepare('UPDATE world SET last_tick_date = ? WHERE id = 1').run(ydayO);
  await M1.get('/api/me');
  let dayO = 0;
  for (let i = 0; i < 33; i++) {
    await sleep(2000);
    r = await M1.get('/api/world');
    dayO = r.data.day;
    if (dayO === 2) break;
  }
  check('Tick Tahap 6 berjalan: hari 1 → 2', dayO === 2, `day=${dayO}`);
  // Tick berjalan async: hari naik di langkah 8, perawatan (langkah 9)
  // + pengumuman event (langkah 10) menyusul — tunggu sampai desersi M2
  // terlihat di DB sebelum memeriksa keadaan pasca-tick.
  for (let i = 0; i < 20; i++) {
    const droneLeft = dbS6.prepare("SELECT COUNT(*) AS n FROM military_units WHERE citizen_id = ? AND unit_type = 'drone'").get(m2Id).n;
    const usdLeft = dbS6.prepare('SELECT usd FROM citizens WHERE id = ?').get(m2Id).usd;
    if (droneLeft === 0 && usdLeft === 0) break;
    await sleep(500);
  }
  const warARow = dbS6.prepare('SELECT status, winner FROM wars WHERE id = ?').get(warAId);
  check('Perang A ditutup: penyerang menang', warARow.status === 'ended' && warARow.winner === 'attacker', JSON.stringify(warARow));
  const regA = dbS6.prepare('SELECT controller, controller_id, country_id FROM regions WHERE id = ?').get(regionA);
  check('Wilayah A dikuasai pemberontak oleh M1 (panglima, kerusakan terbanyak)', regA.controller === 'pemberontak' && regA.controller_id === m1Id && regA.country_id === null, JSON.stringify(regA));
  r = await M1.get('/api/regions/' + regionA);
  check('Detail wilayah A: controller_name = tahap6_m1', r.data.region?.controller_name === 'tahap6_m1', `controller_name=${r.data.region?.controller_name}`);
  r = await M1.get('/api/regions');
  const listA = (r.data.regions || []).find((x) => x.id === regionA);
  check('Daftar wilayah: A bertanda pemberontak + nama panglima', listA?.controller === 'pemberontak' && listA?.controller_name === 'tahap6_m1');
  const warBRow = dbS6.prepare('SELECT status, winner FROM wars WHERE id = ?').get(warBId);
  check('Perang B ditutup: pembela menang', warBRow.status === 'ended' && warBRow.winner === 'defender', JSON.stringify(warBRow));
  const regB = dbS6.prepare('SELECT controller, controller_id FROM regions WHERE id = ?').get(regionB);
  check('Wilayah B dibebaskan (bebas, tanpa penguasa)', regB.controller === 'bebas' && regB.controller_id === null, JSON.stringify(regB));
  r = await M1.get('/api/notifications');
  check('M1 diberitahu: Kamu menguasai wilayah A', (r.data.notifications || []).some((n) => n.title && n.title.startsWith('Kamu menguasai')), JSON.stringify((r.data.notifications || []).map((n) => n.title)));
  const m2Units = unitsO(m2Id);
  check('Perawatan: Drone M2 desersi (saldo kurang), Infanteri bertahan', m2Units.some((u) => u.unit_type === 'infantry' && u.qty === 5) && !m2Units.some((u) => u.unit_type === 'drone'), JSON.stringify(m2Units));
  check('Perawatan: saldo M2 habis (5 → 0)', dbS6.prepare('SELECT usd FROM citizens WHERE id = ?').get(m2Id).usd === 0, `usd=${dbS6.prepare('SELECT usd FROM citizens WHERE id = ?').get(m2Id).usd}`);
  r = await M2.get('/api/notifications');
  check('M2 diberitahu: Pasukanmu desersi', (r.data.notifications || []).some((n) => n.title === 'Pasukanmu desersi'));
  check('Produksi Ringan: 5 Gandum -> 5 Makanan (bahan membatasi)', invQtyO(m3Id, comIdO('Makanan')) === makananM3Before + 5 && stockQtyO(dapurEnamId, gandumO) === 0, `makanan=${invQtyO(m3Id, comIdO('Makanan'))} stokGandum=${stockQtyO(dapurEnamId, gandumO)}`);
  check('Produksi Berat: 2 Besi + 2 Minyak -> 2 Drone (bahan membatasi)', invQtyO(m4Id, droneO) === droneM4Before + 2 && stockQtyO(beratEnamId, besiO) === 0 && stockQtyO(beratEnamId, minyakO) === 0, `drone=${invQtyO(m4Id, droneO)} stokBesi=${stockQtyO(beratEnamId, besiO)} stokMinyak=${stockQtyO(beratEnamId, minyakO)}`);
  r = await M1.get('/api/military');
  check('GET /api/military top: M2 teratas (kekuatan 10, sisa Infanteri)', (r.data.top || [])[0]?.username === 'tahap6_m2' && (r.data.top || [])[0]?.power === 10, JSON.stringify(r.data.top));

  // --- (d) Reputasi dagang: transaksi selesai + tier.
  setInvO(m5Id, besiO, 30);
  r = await M5.post('/api/market/sell', { scope: 'local', commodity_id: besiO, tier: 1, qty: 10, price: 9 });
  check('M5 pasang penawaran 10× Besi @9', r.status === 200 && !!r.data.offerId, `status=${r.status}`);
  const offerO1 = r.data.offerId;
  r = await M6.post('/api/market/buy', { offer_id: offerO1, qty: 10 });
  check('M6 membeli penawaran M5', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  check('Reputasi: penjual + pembeli masing-masing +1 transaksi', dbS6.prepare('SELECT trades_completed FROM citizens WHERE id = ?').get(m5Id).trades_completed === 1 && dbS6.prepare('SELECT trades_completed FROM citizens WHERE id = ?').get(m6Id).trades_completed === 1, `m5=${dbS6.prepare('SELECT trades_completed FROM citizens WHERE id = ?').get(m5Id).trades_completed} m6=${dbS6.prepare('SELECT trades_completed FROM citizens WHERE id = ?').get(m6Id).trades_completed}`);
  r = await M5.get('/api/profile/tahap6_m5');
  check('Profil M5: reputasi Pedagang Baru, 1 transaksi', r.data.profile?.trade_reputation === 'Pedagang Baru' && r.data.profile?.trades_completed === 1, JSON.stringify({ rep: r.data.profile?.trade_reputation, n: r.data.profile?.trades_completed }));
  r = await M5.post('/api/market/sell', { scope: 'local', commodity_id: besiO, tier: 1, qty: 10, price: 9 });
  const offerO2 = r.data.offerId;
  r = await M5.get('/api/market?scope=local');
  const offerRowO = (r.data.offers || []).find((o) => o.id === offerO2);
  check('Pasar: penawaran M5 menampilkan reputasi penjual', offerRowO?.seller_reputation === 'Pedagang Baru', `rep=${offerRowO?.seller_reputation}`);
  dbS6.prepare('UPDATE citizens SET trades_completed = 49 WHERE id = ?').run(m5Id);
  r = await M6.post('/api/market/buy', { offer_id: offerO2, qty: 10 });
  check('M6 membeli penawaran kedua M5', r.status === 200 && r.data.ok);
  r = await M5.get('/api/profile/tahap6_m5');
  check('Reputasi: 50 transaksi -> Pedagang Terpercaya', r.data.profile?.trade_reputation === 'Pedagang Terpercaya' && r.data.profile?.trades_completed === 50, JSON.stringify({ rep: r.data.profile?.trade_reputation, n: r.data.profile?.trades_completed }));
  r = await M6.post('/api/market/buy-order', { scope: 'local', commodity_id: besiO, tier: 1, qty: 10, price: 9 });
  check('M6 pasang order beli 10× Besi @9', r.status === 200 && !!r.data.orderId, `status=${r.status}`);
  r = await M5.post('/api/market/sell-to-order', { order_id: r.data.orderId, qty: 10 });
  check('M5 menjual ke order beli M6', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  check('Reputasi: jual ke order beli juga +1 untuk keduanya', dbS6.prepare('SELECT trades_completed FROM citizens WHERE id = ?').get(m5Id).trades_completed === 51 && dbS6.prepare('SELECT trades_completed FROM citizens WHERE id = ?').get(m6Id).trades_completed === 3, `m5=${dbS6.prepare('SELECT trades_completed FROM citizens WHERE id = ?').get(m5Id).trades_completed} m6=${dbS6.prepare('SELECT trades_completed FROM citizens WHERE id = ?').get(m6Id).trades_completed}`);

  // --- (e) Demografi wilayah.
  r = await M1.get('/api/regions/' + regionA);
  const demoO = r.data.demographics || {};
  check('Demografi wilayah A: total = pemula+aktif+veteran, rata-rata ada', typeof demoO.total === 'number' && demoO.total >= 1 && (demoO.pemula + demoO.aktif + demoO.veteran) === demoO.total && typeof demoO.avgLevel === 'number', JSON.stringify(demoO));
  const expPowerO = dbS6.prepare('SELECT COALESCE(SUM(mu.qty * CASE mu.unit_type WHEN \'infantry\' THEN 2 WHEN \'drone\' THEN 5 WHEN \'heavy\' THEN 12 ELSE 0 END), 0) AS p FROM military_units mu JOIN citizens c ON c.id = mu.citizen_id WHERE c.home_region_id = ?').get(regionA).p;
  check('Demografi: regionPower cocok dengan hitungan DB', r.data.regionPower === expPowerO, `api=${r.data.regionPower} db=${expPowerO}`);

  // --- (f) Event dunia mingguan: rotasi + efek masing-masing.
  setDayO(1);
  r = await M1.get('/api/me');
  check('Event hari 1: Panen Raya (upah ADMIN +20%)', r.data.worldEvent?.key === 'panen' && r.data.worldEvent?.name === 'Panen Raya', JSON.stringify(r.data.worldEvent));
  r = await M1.get('/api/world');
  check('/api/world ikut membawa event minggu ini', r.data.event?.key === 'panen', JSON.stringify(r.data.event));
  // Panen: upah ADMIN +20% — bandingkan effectiveQty vs pay_qty dasar.
  const jobsRespO = (await M1.get('/api/jobs')).data;
  const jobsM1 = jobsRespO.jobs;
  const adminJobO = jobsM1.find((x) => x.is_admin === 1 && x.region_id === safeRegionO);
  check('Panen: effectiveQty ADMIN = pay_qty × pengali UU ×1,2', !!adminJobO && adminJobO.effectiveQty === Math.max(1, Math.floor((adminJobO.pay_qty || 0) * (jobsRespO.adminPayMult || 1) * 1.2)), JSON.stringify({ pay: adminJobO?.pay_qty, eff: adminJobO?.effectiveQty, mult: jobsRespO.adminPayMult }));
  r = await M1.post('/api/jobs/apply', { job_id: adminJobO.id });
  check('M1 melamar ADMIN (panen)', r.status === 200 && r.data.ok, `status=${r.status}`);
  setEnergyO(m1Id, 100);
  dbS6.prepare('UPDATE citizens SET fatigue = 0, energy_spent_today = 0 WHERE id = ?').run(m1Id);
  r = await M1.post('/api/jobs/shift');
  const gotPanen = r.data.goods ? Number(String(r.data.goods).split('×')[0]) : -1;
  check('Panen: shift penuh dibayar effectiveQty (×1,2)', r.status === 200 && gotPanen === adminJobO.effectiveQty, `goods=${r.data.goods} eff=${adminJobO.effectiveQty}`);
  // Festival: XP shift +50%.
  setDayO(8);
  r = await M1.get('/api/me');
  check('Event hari 8: Festival Rakyat (XP shift +50%)', r.data.worldEvent?.key === 'festival', JSON.stringify(r.data.worldEvent));
  setEnergyO(m1Id, 100);
  dbS6.prepare('UPDATE citizens SET fatigue = 0, energy_spent_today = 0 WHERE id = ?').run(m1Id);
  const xpBeforeO = (await M1.get('/api/me')).data.citizen.xp;
  const dblFest = (new Date().getUTCHours() + 7) % 24 === 0;
  r = await M1.post('/api/jobs/shift');
  const expectFestXp = Math.round(20 * (dblFest ? 2 : 1) * 1.5);
  check(`Festival: shift penuh XP ${expectFestXp} (+50%)`, r.status === 200 && r.data.xpGained === expectFestXp && r.data.festivalXp === true, `xpGained=${r.data.xpGained} festivalXp=${r.data.festivalXp}`);
  check('Festival: XP warga bertambah sesuai', (await M1.get('/api/me')).data.citizen.xp === xpBeforeO + expectFestXp);
  // Badai: perjalanan +5 menit.
  setDayO(15);
  r = await M1.get('/api/me');
  check('Event hari 15: Badai Besar (perjalanan +5 mnt)', r.data.worldEvent?.key === 'badai', JSON.stringify(r.data.worldEvent));
  setDayO(1);
  const regsBase = (await M1.get('/api/regions')).data.regions;
  const targetO = regsBase.find((x) => x.id !== safeRegionO && x.id !== meM7.citizen.region_id);
  const baseMinO = targetO.travelMinutes;
  // Basis M7 sendiri: jarak dihitung dari wilayah masing-masing.
  const baseM7O = (await M7.get('/api/regions')).data.regions.find((x) => x.id === targetO.id).travelMinutes;
  setDayO(15);
  const regsStorm = (await M1.get('/api/regions')).data.regions;
  const stormMinO = regsStorm.find((x) => x.id === targetO.id).travelMinutes;
  check('Badai: travelMinutes di daftar wilayah +5', stormMinO === baseMinO + 5, `dasar=${baseMinO} badai=${stormMinO}`);
  r = await M7.post('/api/regions/travel', { region_id: targetO.id });
  check('Badai: POST travel ikut +5 menit', r.status === 200 && r.data.travelMinutes === baseM7O + 5, `minutes=${r.data.travelMinutes} dasar=${baseM7O}`);
  // Wabah: biaya latihan +2 emas.
  setDayO(22);
  r = await M8.get('/api/me');
  check('Event hari 22: Wabah Melanda (latihan +2 emas)', r.data.worldEvent?.key === 'wabah', JSON.stringify(r.data.worldEvent));
  check('Wabah: trainCosts.strength 1 → 3', r.data.citizen.trainCosts?.strength === 3, JSON.stringify(r.data.citizen.trainCosts));
  r = await M8.post('/api/train', { attr: 'str' });
  check('Wabah: latih str potong 3 emas (bukan 1)', r.status === 200 && r.data.cost === 3 && (await M8.get('/api/me')).data.citizen.gold === 47, `cost=${r.data.cost} ${r.data.error || ''}`);
  // Booming: pajak −1 poin — butuh negara (dirikan dulu, M6 Level 10).
  setDayO(29);
  r = await M6.get('/api/me');
  check('Event hari 29: Pasar Bergairah (pajak −1 poin)', r.data.worldEvent?.key === 'booming', JSON.stringify(r.data.worldEvent));
  // Ibu kota negara baru: wilayah lain yang dibebaskan paksa (alasan sama
  // seperti safeRegionO — semua wilayah dipaksa ke negara 1 oleh seksi lama).
  const freeRegionO = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].find((x) => x !== regionA && x !== regionB && x !== safeRegionO);
  dbS6.prepare("UPDATE regions SET country_id = NULL, controller = 'bebas', controller_id = NULL WHERE id = ?").run(freeRegionO);
  dbS6.prepare('UPDATE citizens SET region_id = ?, home_region_id = ?, level = 10, gold = 500 WHERE id = ?').run(freeRegionO, freeRegionO, m6Id);
  r = await M6.post('/api/countries', { name: 'Nusantara Enam', ideology: 'Konservatisme', system: 'presidensial' });
  check('M6 mendirikan negara Nusantara Enam (Lv 10)', r.status === 200 && !!r.data.countryId, `status=${r.status} ${r.data.error || ''}`);
  const nusOId = r.data.countryId;
  check('Negara baru: wilayah ibu kota controller=negara', dbS6.prepare('SELECT controller, controller_id FROM regions WHERE id = ?').get(freeRegionO).controller === 'negara' && dbS6.prepare('SELECT controller_id FROM regions WHERE id = ?').get(freeRegionO).controller_id === nusOId);
  r = await M6.get('/api/market?scope=local');
  check('Booming: tarif pajak pasar 2% → 1%', r.data.taxRate === 1, `taxRate=${r.data.taxRate}`);
  setDayO(1);
  r = await M6.get('/api/market?scope=local');
  check('Di luar booming: tarif pajak kembali 2%', r.data.taxRate === 2, `taxRate=${r.data.taxRate}`);
  // Darurat: kerusakan perang +10%.
  setDayO(36);
  r = await M1.get('/api/me');
  check('Event hari 36: Darurat Militer (kerusakan +10%)', r.data.worldEvent?.key === 'darurat', JSON.stringify(r.data.worldEvent));
  setEnergyO(m1Id, 100); setInvO(m1Id, senjataO, 5);
  r = await M1.post(`/api/wars/${warOId}/attack`, { side: 'defender', ammo: 'Senjata' });
  check('Darurat: serangan 20 → 22 (+10%) + label', r.status === 200 && r.data.damage === 22 && (r.data.bonuses || []).includes('Darurat Militer +10%'), `damage=${r.data.damage} bonuses=${JSON.stringify(r.data.bonuses)}`);
  // Rotasi: hari 43 kembali ke Panen Raya.
  setDayO(43);
  r = await M1.get('/api/me');
  check('Event hari 43: kembali Panen Raya (rotasi 6 minggu)', r.data.worldEvent?.key === 'panen', JSON.stringify(r.data.worldEvent));

  // --- (g) Pajak penjual di wilayah taklukan mengalir ke panglima perang.
  setDayO(1); // panen — tarif normal 2%, bukan minggu booming
  // M5: kewarganegaraan di ibu kota Nusantara Enam (pajak 2%), lokasi di wilayah A (taklukan M1).
  dbS6.prepare('UPDATE citizens SET home_region_id = ?, region_id = ? WHERE id = ?').run(freeRegionO, regionA, m5Id);
  setInvO(m5Id, besiO, 10);
  const m5UsdBefore = dbS6.prepare('SELECT usd FROM citizens WHERE id = ?').get(m5Id).usd;
  const m1UsdBefore = dbS6.prepare('SELECT usd FROM citizens WHERE id = ?').get(m1Id).usd;
  const treasuryBefore = dbS6.prepare('SELECT treasury_usd FROM country WHERE id = ?').get(nusOId).treasury_usd;
  r = await M5.post('/api/market/sell', { scope: 'local', commodity_id: besiO, tier: 1, qty: 10, price: 10 });
  check('M5 pasang penawaran 10× Besi @10 (dari wilayah taklukan)', r.status === 200 && !!r.data.offerId, `status=${r.status}`);
  r = await M6.post('/api/market/buy', { offer_id: r.data.offerId, qty: 10 });
  check('M6 membeli penawaran M5', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  const m1UsdAfter = dbS6.prepare('SELECT usd FROM citizens WHERE id = ?').get(m1Id).usd;
  const treasuryAfter = dbS6.prepare('SELECT treasury_usd FROM country WHERE id = ?').get(nusOId).treasury_usd;
  check('Pajak 2 USD (2% dari 100) mengalir ke panglima M1, bukan kas negara', m1UsdAfter === m1UsdBefore + 2 && treasuryAfter === treasuryBefore, `m1 usd ${m1UsdBefore} → ${m1UsdAfter}, kas ${treasuryBefore} → ${treasuryAfter}`);
  check('Penjual M5 menerima 98 USD (100 − pajak 2%)', dbS6.prepare('SELECT usd FROM citizens WHERE id = ?').get(m5Id).usd === m5UsdBefore + 98, `usd ${m5UsdBefore} → ${dbS6.prepare('SELECT usd FROM citizens WHERE id = ?').get(m5Id).usd}`);
  r = await M1.get('/api/notifications');
  check('M1 diberitahu: Pajak wilayah taklukan', (r.data.notifications || []).some((n) => n.title === 'Pajak wilayah taklukan'));

  // --- (h) /api/me: militer + event + reputasi; profil: militer.
  r = await M1.get('/api/me');
  check('/api/me: military + worldEvent + tradeReputation ada', !!r.data.military && !!r.data.worldEvent && !!r.data.tradeReputation && r.data.military.power === 0, JSON.stringify({ mil: !!r.data.military, ev: r.data.worldEvent?.key, rep: r.data.tradeReputation?.label }));
  r = await M1.get('/api/profile/tahap6_m2');
  check('Profil M2: military_power 10 + reputasi tampil', r.data.profile?.military_power === 10 && typeof r.data.profile?.trade_reputation === 'string', JSON.stringify({ pow: r.data.profile?.military_power, rep: r.data.profile?.trade_reputation }));
  r = await M1.get('/api/companies');
  const dapurO = (r.data.companies || []).find((x) => x.name === 'Dapur Enam');
  check('GET /api/companies: input_text Dapur (1× Gandum Mentah per unit)', dapurO?.input_text?.includes('Gandum Mentah'), `input_text=${dapurO?.input_text}`);
  const typesO = r.data.types || [];
  check('GET /api/companies: types membawa input_text tiap jenis', typesO.length === 4 && typesO.every((t) => typeof t.input_text === 'string' && t.input_text.length > 0), JSON.stringify(typesO.map((t) => t.input_text)));
  console.log('\n[22p] Tahap 7 v4.1.0 — integrasi: pajak impor negara, pajak shift ikut event, jeda latih Pendidikan, misi/kronik relasional');
  setDayO(1); // minggu Panen Raya — tarif normal, bukan booming
  // --- (a) Pajak impor = tarif NEGARA PEMBELI (dulu selalu konstanta 2%).
  dbS6.prepare('UPDATE country SET tax_import = 5 WHERE id = ?').run(nusOId);
  const m6GoldBefore = dbS6.prepare('SELECT gold FROM citizens WHERE id = ?').get(m6Id).gold;
  const m5GoldBefore = dbS6.prepare('SELECT gold FROM citizens WHERE id = ?').get(m5Id).gold;
  const treasGoldBefore = dbS6.prepare('SELECT treasury FROM country WHERE id = ?').get(nusOId).treasury;
  setInvO(m5Id, besiO, 10);
  r = await M5.post('/api/market/sell', { scope: 'global', commodity_id: besiO, tier: 1, qty: 10, price: 10 });
  check('M5 pasang penawaran global 10× Besi @10 emas', r.status === 200 && !!r.data.offerId, `status=${r.status} ${r.data.error || ''}`);
  const offer7a = r.data.offerId;
  r = await M6.post('/api/market/buy', { offer_id: offer7a, qty: 10 });
  check('M6 beli global: total 105 emas (100 + pajak impor negara 5%)', r.status === 200 && r.data.total === 105, `status=${r.status} total=${r.data.total} ${r.data.error || ''}`);
  check('M6 beli global: penjual terima 98 emas (100 − pajak penghasilan 2%)', r.data.sellerReceives === 98, `sellerReceives=${r.data.sellerReceives}`);
  check('M6 beli global: saldo M6 −105, M5 +98', dbS6.prepare('SELECT gold FROM citizens WHERE id = ?').get(m6Id).gold === m6GoldBefore - 105 && dbS6.prepare('SELECT gold FROM citizens WHERE id = ?').get(m5Id).gold === m5GoldBefore + 98, `m6=${dbS6.prepare('SELECT gold FROM citizens WHERE id = ?').get(m6Id).gold} m5=${dbS6.prepare('SELECT gold FROM citizens WHERE id = ?').get(m5Id).gold}`);
  check('M6 beli global: kas negara +5 emas pajak impor', dbS6.prepare('SELECT treasury FROM country WHERE id = ?').get(nusOId).treasury === treasGoldBefore + 5, `treasury=${dbS6.prepare('SELECT treasury FROM country WHERE id = ?').get(nusOId).treasury}`);
  dbS6.prepare('UPDATE country SET tax_import = 2 WHERE id = ?').run(nusOId);
  // --- (b) Pajak shift ikut event Pasar Bergairah (−1 poin), seperti pajak pasar.
  // v5.0.0: lowongan tetap HARUS milik perusahaan (gaji dibayar pemilik) —
  // fixture ini dulu company_id NULL (gaji dicetak); kini ditempel ke
  // Dapur Enam (milik M3) dan saldo M3 dipastikan cukup untuk 2 shift.
  const dapur7Id = dbS6.prepare("SELECT id FROM companies WHERE name = 'Dapur Enam'").get().id;
  dbS6.prepare('UPDATE citizens SET usd = 10000 WHERE id = (SELECT owner_id FROM companies WHERE id = ?)').run(dapur7Id);
  const job7 = dbS6.prepare("INSERT INTO jobs (company_id, is_admin, title, salary, salary_type, resource, pay_qty, level_min, tier, seats, seats_taken, region_id, description, created_at) VALUES (?,0,'Pekerja Uji Shift',48,'fixed','',0,1,1,10,0,?, 'uji Tahap 7', ?)").run(dapur7Id, safeRegionO, Date.now());
  const job7Id = Number(job7.lastInsertRowid);
  dbS6.prepare('UPDATE citizens SET region_id = ?, home_region_id = ? WHERE id = ?').run(safeRegionO, freeRegionO, m2Id);
  r = await M2.post('/api/jobs/apply', { job_id: job7Id });
  check('M2 melamar Pekerja Uji Shift (gaji 48 USD)', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  setEnergyO(m2Id, 100); setDayO(29); // booming
  r = await M2.post('/api/jobs/shift');
  check('Shift saat booming: pajak 0,48 (1% dari gaji 48)', r.status === 200 && r.data.tax === 0.48 && r.data.gross === 48, `status=${r.status} tax=${r.data.tax} gross=${r.data.gross} ${r.data.error || ''}`);
  setEnergyO(m2Id, 100); setDayO(1);
  r = await M2.post('/api/jobs/shift');
  check('Shift di luar booming: pajak kembali 0,96 (2% dari gaji 48)', r.status === 200 && r.data.tax === 0.96 && r.data.gross === 48, `status=${r.status} tax=${r.data.tax} gross=${r.data.gross} ${r.data.error || ''}`);
  // --- (c) Pembeli tanpa negara: pajak impor fallback 2% (konstanta), kas tidak bertambah.
  dbS6.prepare('UPDATE citizens SET home_region_id = ?, gold = 500 WHERE id = ?').run(safeRegionO, m2Id);
  setInvO(m5Id, besiO, 10);
  r = await M5.post('/api/market/sell', { scope: 'global', commodity_id: besiO, tier: 1, qty: 10, price: 10 });
  check('M5 pasang penawaran global kedua 10× Besi @10 emas', r.status === 200 && !!r.data.offerId, `status=${r.status}`);
  r = await M2.post('/api/market/buy', { offer_id: r.data.offerId, qty: 10 });
  check('M2 tanpa negara beli global: total 102 emas (fallback 2%)', r.status === 200 && r.data.total === 102 && dbS6.prepare('SELECT gold FROM citizens WHERE id = ?').get(m2Id).gold === 398, `status=${r.status} total=${r.data.total} ${r.data.error || ''}`);
  check('M2 tanpa negara: kas negara TIDAK bertambah (pajak impor tanpa negara)', dbS6.prepare('SELECT treasury FROM country WHERE id = ?').get(nusOId).treasury === treasGoldBefore + 5, `treasury=${dbS6.prepare('SELECT treasury FROM country WHERE id = ?').get(nusOId).treasury}`);
  // --- (d) Pendidikan mempercepat latihan: jeda −5% per level (maks −50%).
  r = await M8.post('/api/train', { attr: 'edu' });
  check('M8 latih Pendidikan → LV 1, jeda 114000 ms (2 mnt −5%)', r.status === 200 && r.data.level === 1 && r.data.cooldownMs === 114000, `status=${r.status} cooldownMs=${r.data.cooldownMs} ${r.data.error || ''}`);
  r = await M8.post('/api/train', { attr: 'eco' });
  check('M8 latih Ekonomi (Pendidikan LV 1): jeda ikut 114000 ms', r.status === 200 && r.data.level === 1 && r.data.cooldownMs === 114000, `status=${r.status} cooldownMs=${r.data.cooldownMs} ${r.data.error || ''}`);
  r = await M8.get('/api/me');
  check('/api/me M8: trainCooldowns.strategy sisa ≤ 114000 ms (bukan 120000)', (r.data.citizen.trainCooldowns?.strategy?.remainingMs || 0) > 0 && r.data.citizen.trainCooldowns.strategy.remainingMs <= 114000, JSON.stringify(r.data.citizen.trainCooldowns?.strategy));
  // --- (e) Misi/kronik relasional: progres chat, klaim ganda ditolak.
  for (let i = 0; i < 5; i++) {
    dbS6.prepare('UPDATE citizens SET last_chat_at = 0 WHERE id = ?').run(m3Id);
    r = await M3.post('/api/chat/global', { content: 'halo semua apa kabar hari ini' });
    check(`M3 kirim pesan chat ${i + 1}/5`, r.status === 200 && !!r.data.messageId, `status=${r.status} ${r.data.error || ''}`);
  }
  r = await M3.get('/api/missions');
  const chatM = (r.data.missions || []).find((m) => m.key === 'chat');
  check('Misi chat: 5 pesan cepat hanya terhitung 1 (jeda 30 dtk, tabel relasional)', chatM?.progress === 1 && chatM?.claimed === false, JSON.stringify(chatM));
  dbS6.prepare('UPDATE citizens SET energy_spent_today = 500 WHERE id = ?').run(m3Id);
  r = await M3.post('/api/missions/claim', { key: 'energy' });
  check('M3 klaim misi energi (500/500) → +10 emas', r.status === 200 && r.data.reward === 10, `status=${r.status} ${r.data.error || ''}`);
  r = await M3.post('/api/missions/claim', { key: 'energy' });
  check('Klaim misi yang sama 2× ditolak 400 (tabel mission_claims)', r.status === 400, `status=${r.status}`);
  r = await M3.get('/api/missions');
  check('GET /api/missions: misi energi tercentang sudah diklaim', (r.data.missions || []).find((m) => m.key === 'energy')?.claimed === true, JSON.stringify(r.data.missions));
  for (const k of ['claim', 'job', 'shift', 'train', 'eat', 'map', 'market', 'country']) {
    dbS6.prepare('INSERT OR IGNORE INTO chronicle_done (citizen_id, ckey, done_at) VALUES (?,?,?)').run(m3Id, k, Date.now());
  }
  r = await M3.post('/api/chronicle/claim', { chapter: 1 });
  check('M3 klaim Kronik babak 1 (8/8 tugas) → +10 emas', r.status === 200 && r.data.reward === 10, `status=${r.status} ${r.data.error || ''}`);
  r = await M3.post('/api/chronicle/claim', { chapter: 1 });
  check('Klaim Kronik babak yang sama 2× ditolak 400 (tabel chronicle_claims)', r.status === 400, `status=${r.status}`);
  r = await M3.get('/api/chronicle');
  const ch1 = (r.data.chapters || []).find((c) => c.chapter === 1);
  check('GET /api/chronicle: babak 1 done 8/8 + sudah diklaim', ch1?.done === 8 && ch1?.total === 8 && ch1?.claimed === true, JSON.stringify(ch1));
  console.log('\n[22q] Tahap 8 v4.2.0 — stress test + QA: race pemilu, views artikel, skenario tick penuh, alur pemain baru');
  // --- (a) Race ensureElections: 12× paralel harus tanpa pemilu ganda.
  const race = await new Promise((resolve) => {
    const p = spawn('node', ['test/race-ensure-elections.mjs'], { cwd: ROOT, env: { ...process.env, DATABASE_PATH: DB_PATH } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
  check('Race ensureElections 12× paralel: tanpa pemilu ganda (maks 1/tipe, parlemen ada)', race.code === 0, race.out.trim().slice(0, 200));
  // --- (b) Views artikel: 1× per warga per artikel per hari.
  const myPapers = (await A.get('/api/press/newspapers/mine')).data.newspapers || [];
  const paperQ = myPapers[0]?.id;
  r = await A.post('/api/press/articles', { newspaper_id: paperQ, title: 'Artikel Uji Tahap 8', content: 'Isi artikel uji Tahap 8 yang panjangnya lebih dari dua puluh karakter.' });
  check('A menerbitkan artikel uji Tahap 8', r.status === 200 && !!r.data.articleId, `status=${r.status} ${r.data.error || ''}`);
  const articleQ = r.data.articleId;
  for (let i = 0; i < 3; i++) { r = await A.get(`/api/press/articles/${articleQ}`); }
  check('A membaca artikel sendiri 3× (refresh): views tetap 1', r.status === 200 && r.data.article.views === 1, `views=${r.data.article.views}`);
  for (let i = 0; i < 2; i++) { r = await B.get(`/api/press/articles/${articleQ}`); }
  check('B membaca artikel 2×: views naik 1 lagi (total 2, bukan 5)', r.status === 200 && r.data.article.views === 2, `views=${r.data.article.views}`);
  const viewRows = dbS6.prepare('SELECT COUNT(*) AS n FROM article_views WHERE article_id = ?').get(articleQ);
  check('Tabel article_views: tepat 2 baris unik (A + B, 1 hari)', Number(viewRows.n) === 2, `n=${viewRows.n}`);
  // --- (c) Skenario "hari tick" penuh: pemilu + perang + UU + anggaran tutup bersamaan.
  const meAQ = (await A.get('/api/me')).data.citizen;
  const meBQ = (await B.get('/api/me')).data.citizen;
  const nusQ = dbS6.prepare('SELECT id, treasury, tax_income FROM country ORDER BY id ASC LIMIT 1').get();
  const regionQ = dbS6.prepare('SELECT id FROM regions WHERE country_id = ? LIMIT 1').get(nusQ.id);
  const nowQ = Date.now();
  // (Tahap 8) Pemilu aktif hanya boleh 1 per (negara, tipe) — hapus dulu
  // jadwal aktif lama (bisa ada sisa dari seksi [28b]/[28c]), baru sisipkan
  // pemilu 'open' yang akan ditutup tick ini.
  dbS6.prepare("DELETE FROM elections WHERE country_id = ? AND type = 'president' AND status IN ('scheduled','open')").run(nusQ.id);
  const eidQ = dbS6.prepare("INSERT INTO elections (type, status, opens_at, closes_at, country_id, created_at) VALUES ('president','open',?,?,?,?)").run(nowQ - 10000, nowQ - 1000, nusQ.id, nowQ).lastInsertRowid;
  dbS6.prepare('INSERT INTO election_candidates (election_id, citizen_id, party_id, votes) VALUES (?,?,NULL,?)').run(eidQ, meAQ.id, 5);
  dbS6.prepare('INSERT INTO election_candidates (election_id, citizen_id, party_id, votes) VALUES (?,?,NULL,?)').run(eidQ, meBQ.id, 3);
  const widQ = dbS6.prepare("INSERT INTO wars (name, region_id, attacker_label, defender_label, score_a, score_d, status, ends_at, created_at) VALUES ('Perang Uji Tahap 8',?, 'Pemberontak','Nusantara',100,40,'active',?,?)").run(regionQ.id, nowQ - 1000, nowQ).lastInsertRowid;
  dbS6.prepare("INSERT INTO war_attacks (war_id, citizen_id, side, damage, ammo, created_at) VALUES (?,?,'attacker',50,'Senjata',?)").run(widQ, meAQ.id, nowQ);
  const lawQ = dbS6.prepare("INSERT INTO laws (proposer_id, title, content, kind, value, status, yes, no, ends_at, country_id, created_at) VALUES (?,'UU Uji Tahap 8','Isi undang-undang uji.','tax_income',3,'voting',5,1,?,?,?)").run(meAQ.id, nowQ - 1000, nusQ.id, nowQ).lastInsertRowid;
  const treasuryBeforeQ = Number(nusQ.treasury);
  const bidQ = dbS6.prepare("INSERT INTO budgets (proposer_id, kind, amount, status, yes, no, ends_at, country_id, created_at) VALUES (?,'claim',50,'voting',5,1,?,?,?)").run(meAQ.id, nowQ - 1000, nusQ.id, nowQ).lastInsertRowid;
  const yesterdayQ = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  dbS6.prepare('UPDATE world SET last_tick_date = ? WHERE id = 1').run(yesterdayQ);
  await A.get('/api/me'); // picu maybeTick
  let dayQ = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    r = await A.get('/api/world');
    dayQ = r.data.day;
    if (dayQ === 2) break;
  }
  check('Tick penuh: hari dunia 1 → 2 (tepat 1 hari, bukan 2×)', dayQ === 2, `day=${dayQ}`);
  const elQ = dbS6.prepare('SELECT status, winner_id FROM elections WHERE id = ?').get(eidQ);
  check('Pemilu presiden ditutup dalam tick: pemenang A (5 vs 3 suara)', elQ.status === 'closed' && Number(elQ.winner_id) === meAQ.id, JSON.stringify(elQ));
  const presQ = dbS6.prepare('SELECT president_id FROM country WHERE id = ?').get(nusQ.id);
  check('Presiden negara kini A', Number(presQ.president_id) === meAQ.id, `president_id=${presQ.president_id}`);
  const warQ = dbS6.prepare('SELECT status, winner FROM wars WHERE id = ?').get(widQ);
  check('Perang ditutup dalam tick: penyerang menang (100 vs 40)', warQ.status === 'ended' && warQ.winner === 'attacker', JSON.stringify(warQ));
  const regQ = dbS6.prepare('SELECT country_id, controller, controller_id FROM regions WHERE id = ?').get(regionQ.id);
  check('Wilayah lepas dari negara → dikuasai pemberontak (panglima perang = A)', regQ.country_id === null && regQ.controller === 'pemberontak' && Number(regQ.controller_id) === meAQ.id, JSON.stringify(regQ));
  const lawRowQ = dbS6.prepare('SELECT status, effect_applied FROM laws WHERE id = ?').get(lawQ);
  const taxQ = dbS6.prepare('SELECT tax_income FROM country WHERE id = ?').get(nusQ.id);
  check('UU pajak disahkan dalam tick: efek diterapkan, pajak 4% → 3%', lawRowQ.status === 'executed' && Number(lawRowQ.effect_applied) === 1 && Number(taxQ.tax_income) === 3, `status=${lawRowQ.status} pajak=${taxQ.tax_income}`);
  const budQ = dbS6.prepare('SELECT status FROM budgets WHERE id = ?').get(bidQ);
  const treasuryAfterQ = Number(dbS6.prepare('SELECT treasury FROM country WHERE id = ?').get(nusQ.id).treasury);
  const budExpected = treasuryBeforeQ >= 50 ? 'passed' : 'failed';
  check(`Anggaran ditutup dalam tick: ${budExpected} (kas ${treasuryBeforeQ} emas)`, budQ.status === budExpected, `status=${budQ.status} kas ${treasuryBeforeQ}→${treasuryAfterQ}`);
  if (budExpected === 'passed') check('Kas negara berkurang tepat 50 emas (anggaran)', treasuryAfterQ === treasuryBeforeQ - 50, `${treasuryBeforeQ}→${treasuryAfterQ}`);
  await sleep(2000);
  r = await A.get('/api/world');
  check('Hari tetap 2 setelah tick (tidak ada tick ganda)', r.data.day === 2, `day=${r.data.day}`);
  // --- (d) Alur pemain baru end-to-end (definisi selesai AUDIT Tahap 8):
  // daftar → klaim → lamar ADMIN → shift → jual → beli → chat.
  const NW = new Client();
  // Batas registrasi 20/IP/24 jam sudah habis dipakai pendaftaran seksi
  // sebelumnya — pakai IP berbeda via X-Forwarded-For (pola [28]/[23b]).
  NW.extraHeaders = { 'X-Forwarded-For': '127.0.0.21' };
  r = await NW.post('/api/auth/register', { email: 'warga8@test.local', password: 'rahasia123', username: 'warga_delapan' });
  check('Pemain baru NW mendaftar', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  const meN = (await NW.get('/api/me')).data.citizen;
  r = await NW.post('/api/claim', {});
  check('NW klaim pasokan harian (+5 emas/+50 USD/+40 XP)', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  const jobsN = (await NW.get('/api/jobs')).data.jobs.filter((j) => j.is_admin === 1 && j.region_id === meN.region_id);
  check('Lowongan ADMIN ada di wilayah lahir NW', jobsN.length >= 1, `n=${jobsN.length}`);
  r = await NW.post('/api/jobs/apply', { job_id: jobsN[0].id });
  check('NW melamar pekerjaan ADMIN', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  r = await NW.post('/api/jobs/shift', {});
  check('NW shift penuh (100 energi) dibayar bahan mentah', r.status === 200 && !!r.data.goods, `status=${r.status} goods=${r.data.goods}`);
  const invN = (await NW.get('/api/inventory')).data.items;
  const matN = invN.find((i) => i.qty >= 10 && i.tier === 1 && i.name !== 'Tiket');
  check('NW punya bahan hasil shift ≥10 unit untuk dijual', !!matN, JSON.stringify(invN.map((i) => `${i.name}×${i.qty}`)));
  const marketN = (await NW.get('/api/market?scope=local')).data;
  const comN = marketN.commodities.find((c) => c.name === matN.name);
  // Harga wajar (Tahap 4): bila ≥3 transaksi 14 hari terakhir, harga harus
  // 0,25×–4× median — jadi pakai median transaksi itu sendiri (fallback:
  // harga referensi bila pasar masih sepi).
  const fairPrice = (commodityId, scope, fallback) => {
    const txs = dbS6.prepare('SELECT price_each FROM market_tx WHERE commodity_id = ? AND scope = ? AND created_at > ? ORDER BY created_at DESC LIMIT 20').all(commodityId, scope, Date.now() - 14 * 86400000).map((x) => Number(x.price_each)).sort((a, b) => a - b);
    return txs.length >= 3 ? txs[Math.floor(txs.length / 2)] : fallback;
  };
  const priceN = fairPrice(comN.id, 'local', Math.max(1, Math.round(Number(comN.ref_usd) || 1)));
  r = await NW.post('/api/market/sell', { scope: 'local', commodity_id: comN.id, tier: 1, qty: 10, price: priceN });
  check(`NW memasang penawaran jual 10× ${matN.name} @ ${priceN}`, r.status === 200 && !!r.data.offerId, `status=${r.status} ${r.data.error || ''}`);
  const marketB = (await B.get('/api/market?scope=global')).data;
  const invB = (await B.get('/api/inventory')).data.items;
  let matB = invB.find((i) => i.qty >= 10 && i.tier === 1 && i.name !== 'Tiket');
  if (!matB) {
    // B kehabisan stok ≥10 (dipakai seksi sebelumnya) — isi ulang 20× Gandum
    // Mentah lewat DB agar skenario beli tetap berjalan.
    const gandumB = marketB.commodities.find((c) => c.name === 'Gandum Mentah');
    dbS6.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,20) ON CONFLICT (citizen_id, commodity_id, tier) DO UPDATE SET qty = qty + 20').run(meBQ.id, gandumB.id);
    matB = { name: 'Gandum Mentah' };
  }
  const comB = marketB.commodities.find((c) => c.name === matB.name);
  const priceB = fairPrice(comB.id, 'global', Math.max(0.01, Number(comB.ref_gold) || 0.01));
  r = await B.post('/api/market/sell', { scope: 'global', commodity_id: comB.id, tier: 1, qty: 10, price: priceB });
  check(`B memasang penawaran global 10× ${matB.name}`, r.status === 200 && !!r.data.offerId, `status=${r.status} ${r.data.error || ''}`);
  const offerB = r.data.offerId;
  const invNBefore = (await NW.get('/api/inventory')).data.items.find((i) => i.name === matB.name)?.qty || 0;
  r = await NW.post('/api/market/buy', { offer_id: offerB, qty: 10 });
  check(`NW membeli 10× ${matB.name} dari penawaran B`, r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  const invNAfter = (await NW.get('/api/inventory')).data.items.find((i) => i.name === matB.name)?.qty || 0;
  check('Barang beli masuk inventaris NW (+10)', invNAfter === invNBefore + 10, `${invNBefore}→${invNAfter}`);
  r = await NW.post('/api/chat/global', { content: 'Halo, aku warga baru! Senang bergabung.' });
  check('NW mengirim pesan chat global', r.status === 200 && !!r.data.messageId, `status=${r.status} ${r.data.error || ''}`);

  console.log('\n[30] Iklan berhadiah AdinPlay (v4.4.0) — token satu kali pakai, tanpa cap harian');
  // Server e2e di-boot dengan ADINPLAY_PROPERTY_ID test (lihat startServer).
  r = await A.get('/api/me');
  const adsMe = r.data.ads || {};
  check('Iklan aktif di /api/me (enabled + hadiah 30 emas)', adsMe.enabled === true && adsMe.rewardGold === 30, JSON.stringify(adsMe));
  const adsId = r.data.citizen.id;
  const gold0 = r.data.citizen.gold;
  r = await A.post('/api/ads/start');
  check('POST /api/ads/start memberi token 64 hex + berlaku 5 menit', r.status === 200 && typeof r.data.token === 'string' && r.data.token.length === 64 && r.data.expiresAt > Date.now() && r.data.expiresAt - Date.now() <= 5 * 60 * 1000, `status=${r.status}`);
  const tok1 = r.data.token;
  r = await A.post('/api/ads/reward', { token: tok1 });
  check('Reward pertama: +30 emas', r.status === 200 && r.data.reward?.gold === 30, `status=${r.status} ${r.data.error || ''}`);
  r = await A.get('/api/me');
  check('Saldo emas naik 30', r.data.citizen.gold === gold0 + 30, `${gold0}→${r.data.citizen.gold}`);
  r = await A.post('/api/ads/reward', { token: tok1 });
  check('Token yang sama dipakai 2× ditolak', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  r = await A.post('/api/ads/reward', { token: 'token-palsu' });
  check('Token palsu ditolak', r.status === 400, `status=${r.status}`);
  r = await A.post('/api/ads/reward', {});
  check('Reward tanpa token ditolak', r.status === 400, `status=${r.status}`);
  // Token milik pemain lain tidak bisa dipakai A.
  r = await B.post('/api/ads/start');
  const tokB = r.data.token;
  r = await A.post('/api/ads/reward', { token: tokB });
  check('Token milik pemain lain ditolak', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  // Jeda minimum 30 detik: grant kedua langsung setelah yang pertama ditolak.
  r = await A.post('/api/ads/start');
  const tok2 = r.data.token;
  r = await A.post('/api/ads/reward', { token: tok2 });
  check('Grant kedua dalam 30 detik ditolak (jeda minimum anti-skrip)', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  // Token kedaluwarsa: mundurkan expires_at lewat DB, lalu coba reward.
  r = await A.post('/api/ads/start');
  const tok3 = r.data.token;
  {
    const dbAds = new DatabaseSync(DB_PATH);
    dbAds.prepare('UPDATE ad_tokens SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, tok3);
    dbAds.close();
  }
  r = await A.post('/api/ads/reward', { token: tok3 });
  check('Token kedaluwarsa ditolak', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  // Tanpa cap harian: grant ke-2..ke-7 tetap berhasil — jeda minimum
  // dilewati dengan memundurkan granted_at di ad_rewards (simulasi waktu).
  {
    const dbAds = new DatabaseSync(DB_PATH);
    let okCount = 0;
    for (let i = 0; i < 6; i++) {
      const st = await A.post('/api/ads/start');
      dbAds.prepare('UPDATE ad_rewards SET granted_at = 0 WHERE citizen_id = ?').run(adsId);
      const rw = await A.post('/api/ads/reward', { token: st.data.token });
      if (rw.status === 200 && rw.data.reward?.gold === 30) okCount++;
      else { check(`Grant tanpa cap #${i + 2} berhasil`, false, `status=${rw.status} ${rw.data.error || ''}`); break; }
    }
    check('Grant ke-2 sampai ke-7 (lebih dari 5/hari) tetap berhasil — tanpa cap harian', okCount === 6, `berhasil ${okCount}/6`);
    const n = dbAds.prepare('SELECT COUNT(*) AS n FROM ad_rewards WHERE citizen_id = ?').get(adsId);
    check('Tabel audit ad_rewards mencatat semua grant (7 baris)', Number(n.n) === 7, `n=${n.n}`);
    dbAds.close();
  }

  console.log('\n[31] v4.5.0 — roti Premium (bug cap + jatah 25) + kerja otomatis 24 jam');
  const dbAW = new DatabaseSync(DB_PATH);
  const setEnergyW = (id, energy) => dbAW.prepare('UPDATE citizens SET energy = ?, energy_updated_at = ? WHERE id = ?').run(energy, Date.now(), id);
  // --- (A) Warga Premium baru + pekerjaan ADMIN di wilayahnya.
  // Registrasi dari 127.0.0.1 sudah tepat 20 (batas anti multi-akun) —
  // AW + V2 memakai IP berbeda lewat X-Forwarded-For (pola [23b]/[28]).
  const AW = new Client();
  AW.extraHeaders = { 'X-Forwarded-For': '127.0.0.31' };
  r = await AW.post('/api/auth/register', { email: 'warga_aw@test.local', password: 'rahasia123', username: 'warga_aw' });
  check('Warga AW terdaftar', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  let meW = (await AW.get('/api/me')).data;
  const wUserId = meW.user.id;
  const wId = meW.citizen.id;
  dbAW.prepare('UPDATE users SET premium_until = ? WHERE id = ?').run(Date.now() + 86400000, wUserId);
  r = await AW.get('/api/me');
  check('AW Premium: cap energi 120 (100 + 20)', r.data.citizen.energyCap === 120, `cap=${r.data.citizen.energyCap}`);
  check('/api/me: breadLimit Premium = 25', r.data.citizen.breadLimit === 25, `breadLimit=${r.data.citizen.breadLimit}`);
  const jobsW = (await AW.get('/api/jobs')).data.jobs || [];
  const jobW = jobsW.find((j) => j.region_id === meW.citizen.region_id && j.is_admin === 1)
    || jobsW.find((j) => j.region_id === meW.citizen.region_id);
  check('Ada lowongan di wilayah AW', !!jobW, `jobs=${jobsW.length}`);
  r = await AW.post('/api/jobs/apply', { job_id: jobW.id });
  check('AW melamar pekerjaan', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  // --- (A1) Bug roti Premium: makan di cap non-Premium (100) harus naik.
  await ADM.post('/api/admin/item', { user_id: wUserId, commodity: 'Makanan', tier: 1, qty: 40 });
  setEnergyW(wId, 100);
  r = await AW.post('/api/eat', { tier: 1 });
  check('Premium makan T1 di energi 100 → 110 (dulu mentok 100, roti hilang)', r.status === 200 && r.data.energy === 110 && r.data.gained === 10, `status=${r.status} energy=${r.data.energy} gained=${r.data.gained} ${r.data.error || ''}`);
  // --- (A2) Minum juga memakai cap Premium: 119 → 120.
  r = await AW.post('/api/shop/energy-drink', { qty: 2 });
  check('AW beli 2 kaleng minuman energi', r.status === 200 && r.data.qty === 2, `status=${r.status} ${r.data.error || ''}`);
  setEnergyW(wId, 119);
  r = await AW.post('/api/inventory/drink', { qty: 1 });
  check('Premium minum di energi 119 → 120 (gained 1, bukan 0)', r.status === 200 && r.data.energy === 120 && r.data.gained === 1, `status=${r.status} gained=${r.data.gained} energy=${r.data.energy} ${r.data.error || ''}`);
  // --- (B) Jatah roti Premium 25/hari; misi 'bread' tetap 10.
  dbAW.prepare('UPDATE citizens SET bread_today = 0 WHERE id = ?').run(wId);
  let eatOk = 0;
  for (let i = 0; i < 25; i++) { const er = await AW.post('/api/eat', { tier: 1 }); if (er.status === 200) eatOk++; }
  check('Premium makan 25 roti: semua lolos', eatOk === 25, `lolos ${eatOk}/25`);
  r = await AW.post('/api/eat', { tier: 1 });
  check('Roti ke-26 Premium ditolak (400, menyebut 25)', r.status === 400 && /\(25\)/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  r = await AW.get('/api/missions');
  check("Misi harian 'bread' tetap target 10 (bukan 25)", (r.data.missions || []).find((m) => m.key === 'bread')?.target === 10, JSON.stringify((r.data.missions || []).find((m) => m.key === 'bread')));
  // --- (B2) Non-Premium tetap 10/hari + breadLimit 10.
  const V2 = new Client();
  V2.extraHeaders = { 'X-Forwarded-For': '127.0.0.32' };
  r = await V2.post('/api/auth/register', { email: 'warga_v2@test.local', password: 'rahasia123', username: 'warga_v2' });
  check('Warga V2 (non-Premium) terdaftar', r.status === 200 && r.data.ok);
  const meV2 = (await V2.get('/api/me')).data;
  check('/api/me: breadLimit non-Premium = 10', meV2.citizen.breadLimit === 10, `breadLimit=${meV2.citizen.breadLimit}`);
  await ADM.post('/api/admin/item', { user_id: meV2.user.id, commodity: 'Makanan', tier: 1, qty: 15 });
  let eatOk2 = 0;
  for (let i = 0; i < 10; i++) { const er = await V2.post('/api/eat', { tier: 1 }); if (er.status === 200) eatOk2++; }
  check('Non-Premium makan 10 roti: semua lolos', eatOk2 === 10, `lolos ${eatOk2}/10`);
  r = await V2.post('/api/eat', { tier: 1 });
  check('Roti ke-11 non-Premium ditolak (400, menyebut 10)', r.status === 400 && /\(10\)/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  // --- (D) Kerja otomatis.
  r = await V2.post('/api/jobs/auto-work', { on: true });
  check('Non-Premium menyalakan auto-kerja → 403', r.status === 403, `status=${r.status}`);
  r = await AW.post('/api/jobs/auto-work', { on: true });
  check('Premium menyalakan auto-kerja (24 jam)', r.status === 200 && r.data.autoWork?.active === true, `status=${r.status} ${r.data.error || ''}`);
  // Pemicu runner: tunggu > interval (500 ms, env e2e) + GET /api/me,
  // lalu beri runner waktu jalan (fire-and-forget dari middleware).
  const triggerAutoWork = async () => { await sleep(700); await AW.get('/api/me'); await sleep(1200); };
  setEnergyW(wId, 100);
  const invBefore = (await AW.get('/api/inventory')).data.items.find((i) => i.name === jobW.resource)?.qty || 0;
  await triggerAutoWork();
  meW = (await AW.get('/api/me')).data;
  check('Auto-kerja: 1 shift jalan sendiri (energi 100 → 0, shifts=1)', meW.citizen.energy === 0 && meW.autoWork?.shifts === 1, `energi=${meW.citizen.energy} shifts=${meW.autoWork?.shifts}`);
  const invAfter = (await AW.get('/api/inventory')).data.items.find((i) => i.name === jobW.resource)?.qty || 0;
  check('Auto-kerja: bayaran shift masuk inventaris', invAfter > invBefore, `${invBefore} → ${invAfter}`);
  // Jeda kelelahan: fatigue 10.000 → dijeda, tidak ada shift baru.
  dbAW.prepare('UPDATE citizens SET fatigue = 10000 WHERE id = ?').run(wId);
  setEnergyW(wId, 100);
  await triggerAutoWork();
  meW = (await AW.get('/api/me')).data;
  check('Kelelahan 10.000: auto-kerja DIJEDA, shift tidak jalan', meW.autoWork?.paused === true && meW.autoWork?.shifts === 1 && meW.citizen.energy === 100, `paused=${meW.autoWork?.paused} shifts=${meW.autoWork?.shifts} energi=${meW.citizen.energy}`);
  // Pulih: fatigue 0 + energi 100 → lanjut, shifts=2.
  dbAW.prepare('UPDATE citizens SET fatigue = 0 WHERE id = ?').run(wId);
  setEnergyW(wId, 100);
  await triggerAutoWork();
  meW = (await AW.get('/api/me')).data;
  check('Kelelahan pulih: auto-kerja lanjut (shifts=2, tidak dijeda)', meW.autoWork?.paused === false && meW.autoWork?.shifts === 2, `paused=${meW.autoWork?.paused} shifts=${meW.autoWork?.shifts}`);
  // Kedaluwarsa: until di masa lalu → mati + notifikasi ringkasan.
  dbAW.prepare('UPDATE citizens SET auto_work_until = ? WHERE id = ?').run(Date.now() - 1000, wId);
  await triggerAutoWork();
  meW = (await AW.get('/api/me')).data;
  check('Masa 24 jam habis: auto-kerja mati', meW.autoWork?.active === false, `active=${meW.autoWork?.active}`);
  const notifs = (await AW.get('/api/notifications')).data.notifications || [];
  check('Notifikasi ringkasan "Kerja otomatis selesai" terkirim', notifs.some((n) => n.title === 'Kerja otomatis selesai'), `notif=${notifs.map((n) => n.title).slice(0, 5).join('|')}`);
  // Toggle off + quit mematikan.
  r = await AW.post('/api/jobs/auto-work', { on: true });
  check('Nyalakan lagi untuk tes mati', r.status === 200 && r.data.autoWork?.active === true);
  r = await AW.post('/api/jobs/auto-work', { on: false });
  check('Matikan via toggle → tidak aktif', r.status === 200 && r.data.autoWork?.active === false, `status=${r.status}`);
  r = await AW.post('/api/jobs/auto-work', { on: true });
  check('Nyalakan lagi untuk tes quit', r.status === 200 && r.data.autoWork?.active === true);
  r = await AW.post('/api/jobs/quit');
  check('Keluar pekerjaan berhasil', r.status === 200 && r.data.ok);
  meW = (await AW.get('/api/me')).data;
  check('Quit mematikan auto-kerja', meW.autoWork?.active === false && !meW.citizen.job_id, `active=${meW.autoWork?.active} job=${meW.citizen.job_id}`);
  dbAW.close();

  console.log('\n[32] v4.5.2 — hotfix bug shift: citizen id vs user id (LIO + Kenzz)');
  // Akar masalah: performShift dulu memanggil loadCitizen(citizenId)
  // padahal loadCitizen memakai `WHERE c.user_id = ?`. Selama
  // citizens.id == users.id tidak terlihat; begitu bergeser, shift memuat
  // WARGA YANG SALAH (yang user_id-nya = citizen id pemanggil) — bila
  // warga salah itu tidak bekerja, error "Kamu belum punya pekerjaan"
  // padahal pemanggil SUDAH bekerja (panel PEKERJAANMU benar karena
  // /api/me memakai user id — bukti Kenzz: panel menampilkan KERJA - PT
  // BESI JABAR Rp900.000.039/shift, tapi tombol KERJAKAN SATU GILIRAN
  // melempar error itu). Regresi: dua warga baru; citizen id Q digeser
  // menjadi user id P (P tidak bekerja) — sebelum perbaikan, shift Q
  // melempar error itu; sesudahnya shift Q berhasil, shift P (tanpa
  // pekerjaan) tetap 400 dengan benar.
  const SH1 = new Client();
  const SH2 = new Client();
  // IP berbeda lewat X-Forwarded-For (pola [23b]/[28]/[31]): limit
  // pendaftaran per IP sudah habis untuk 127.0.0.1 di titik ini.
  SH1.extraHeaders = { 'X-Forwarded-For': '127.0.0.41' };
  SH2.extraHeaders = { 'X-Forwarded-For': '127.0.0.42' };
  r = await SH1.post('/api/auth/register', { email: 'shift_p@test.local', password: 'rahasia123', username: 'shift_p' });
  check('Warga P (tanpa pekerjaan) terdaftar', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || JSON.stringify(r.data).slice(0, 200)}`);
  r = await SH2.post('/api/auth/register', { email: 'shift_q@test.local', password: 'rahasia123', username: 'shift_q' });
  check('Warga Q terdaftar', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || JSON.stringify(r.data).slice(0, 200)}`);
  const meP = (await SH1.get('/api/me')).data;
  const meQ = (await SH2.get('/api/me')).data;
  // Q melamar lowongan ADMIN di wilayahnya (pola [23d]: set region via DB).
  const jobsSH = (await SH2.get('/api/jobs')).data;
  const adminSH = jobsSH.jobs.find((j) => j.is_admin);
  check('Lowongan ADMIN ada untuk Q', !!adminSH);
  const dbSH = new DatabaseSync(DB_PATH);
  // Geser PK citizens yang dirujuk baris anak (inventory, notifikasi,
  // dsb.) — matikan FK di koneksi tes ini saja supaya UPDATE id lolos;
  // baris anak yang yatim tidak dipakai tes ini (P/Q warga baru).
  dbSH.exec('PRAGMA foreign_keys = OFF');
  dbSH.prepare('UPDATE citizens SET region_id = ? WHERE id = ?').run(adminSH.region_id, meQ.citizen.id);
  r = await SH2.post('/api/jobs/apply', { job_id: adminSH.id });
  check('Q melamar lowongan ADMIN', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  // Geser id: citizen P dipindah dulu (membebaskan id-nya), lalu citizen Q
  // dijadikan = user id P. Setelah ini Q.citizen.id == P.user_id, dan P
  // tidak bekerja — persis kondisi live LIO/Kenzz.
  dbSH.prepare('UPDATE citizens SET id = 900000 WHERE id = ?').run(meP.citizen.id);
  dbSH.prepare('UPDATE citizens SET id = ? WHERE id = ?').run(meP.user.id, meQ.citizen.id);
  dbSH.close();
  // Q: panel menampilkan pekerjaan (sumber benar), shift harus berhasil.
  const meQ2 = (await SH2.get('/api/me')).data;
  check('Panel Q tetap menampilkan pekerjaannya setelah geser id', !!meQ2.job && meQ2.job.id === adminSH.id, `job=${meQ2.job?.title}`);
  r = await SH2.post('/api/jobs/shift');
  check('Q yang SUDAH bekerja bisa shift (200, bukan "belum punya pekerjaan")', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  // P: memang belum bekerja — error tetap muncul dengan benar.
  r = await SH1.post('/api/jobs/shift');
  check('P yang belum bekerja tetap ditolak 400 "belum punya pekerjaan"', r.status === 400 && /belum punya pekerjaan/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);

  console.log('\n[33] v4.6.0 — share link harian + stok/upah perusahaan + multi-shift + minum sekaligus + donasi + HEIC');
  const S1 = new Client(); const S2 = new Client(); const S3 = new Client(); const S4 = new Client();
  S1.extraHeaders = { 'X-Forwarded-For': '127.0.0.51' };
  S2.extraHeaders = { 'X-Forwarded-For': '127.0.0.52' };
  S3.extraHeaders = { 'X-Forwarded-For': '127.0.0.53' };
  S4.extraHeaders = { 'X-Forwarded-For': '127.0.0.54' };
  r = await S1.post('/api/auth/register', { email: 'share_s1@test.local', password: 'rahasia123', username: 'share_s1' });
  check('S1 (pemilik link) terdaftar', r.status === 200 && r.data.ok, `status=${r.status}`);
  r = await S2.post('/api/auth/register', { email: 'share_s2@test.local', password: 'rahasia123', username: 'share_s2' });
  check('S2 terdaftar', r.status === 200 && r.data.ok);
  r = await S3.post('/api/auth/register', { email: 'share_s3@test.local', password: 'rahasia123', username: 'share_s3' });
  check('S3 (pemilik perusahaan) terdaftar', r.status === 200 && r.data.ok);
  r = await S4.post('/api/auth/register', { email: 'share_s4@test.local', password: 'rahasia123', username: 'share_s4' });
  check('S4 terdaftar', r.status === 200 && r.data.ok);
  const dbS33 = new DatabaseSync(DB_PATH);

  // --- (a) Share link: kode + klik publik + anti-fraud 1 IP/hari + cap 200.
  const meS1 = (await S1.get('/api/me')).data;
  const goldS1Before = meS1.citizen.gold;
  r = await S1.get('/api/share');
  check('GET /api/share: kode 10 karakter (tanpa 0/O/1/l)', r.status === 200 && /^[a-hj-km-np-z2-9]{10}$/.test(r.data.code || ''), `code=${r.data.code}`);
  check('GET /api/share: perClick 10, cap 200/hari (= 20 klik)', r.data.perClick === 10 && r.data.today?.cap === 200 && r.data.maxClicksPerDay === 20, JSON.stringify(r.data.today));
  const shareCode = r.data.code;
  const clickAs = async (ip) => fetch(BASE + '/s/' + shareCode, { headers: { 'X-Forwarded-For': ip }, redirect: 'manual' });
  await clickAs('203.0.113.1');
  let goldNow = (await S1.get('/api/me')).data.citizen.gold;
  check('Klik publik IP baru: pemilik +10 emas', goldNow === goldS1Before + 10, `gold=${goldNow} (sebelum ${goldS1Before})`);
  await clickAs('203.0.113.1');
  goldNow = (await S1.get('/api/me')).data.citizen.gold;
  check('Klik kedua IP yang sama di hari yang sama: tidak ada emas tambahan', goldNow === goldS1Before + 10, `gold=${goldNow}`);
  await clickAs('203.0.113.2');
  goldNow = (await S1.get('/api/me')).data.citizen.gold;
  check('Klik IP berbeda: +10 lagi', goldNow === goldS1Before + 20, `gold=${goldNow}`);
  await S1.get('/s/' + shareCode);
  goldNow = (await S1.get('/api/me')).data.citizen.gold;
  check('Klik sendiri (login sebagai pemilik): tidak dihitung', goldNow === goldS1Before + 20, `gold=${goldNow}`);
  const badClick = await fetch(BASE + '/s/kode-salah-123', { redirect: 'manual' });
  check('Kode share salah → 404', badClick.status === 404, `status=${badClick.status}`);
  r = await S1.get('/api/share');
  check('Statistik share hari ini: 2 klik, 20 emas, sisa 180', r.data.today?.clicks === 2 && r.data.today?.gold === 20 && r.data.today?.remaining === 180, JSON.stringify(r.data.today));
  for (let i = 3; i <= 20; i++) await clickAs('203.0.113.' + i);
  goldNow = (await S1.get('/api/me')).data.citizen.gold;
  check('20 klik unik: total 200 emas (cap harian tercapai)', goldNow === goldS1Before + 200, `gold=${goldNow}`);
  await clickAs('203.0.113.99');
  goldNow = (await S1.get('/api/me')).data.citizen.gold;
  check('Klik ke-21 (kuota habis): tidak ada emas tambahan', goldNow === goldS1Before + 200, `gold=${goldNow}`);
  r = await ADM.get('/api/admin/share');
  const s1Row = (r.data.rows || []).find((x) => x.username === 'share_s1');
  check('Admin: statistik share menampilkan S1 (20 klik, 200 emas hari ini)', r.status === 200 && s1Row?.clicksToday === 20 && s1Row?.goldToday === 200 && s1Row?.goldTotal === 200, `status=${r.status} ${JSON.stringify(s1Row)}`);
  r = await S1.get('/api/admin/share');
  check('Bukan admin: /api/admin/share → 403', r.status === 403, `status=${r.status}`);
  const clickRows = dbS33.prepare('SELECT COUNT(*) AS n, SUM(gold_given) AS g FROM share_clicks WHERE owner_id = ?').get(meS1.citizen.id);
  check('Audit share_clicks: 21 klik tercatat (20 terhitung + 1 di luar kuota), total emas 200', Number(clickRows.n) === 21 && Number(clickRows.g) === 200, `n=${clickRows.n} gold=${clickRows.g}`);

  // --- (b) Multi-shift: 140 energi → 2 shift dalam satu tekan.
  const meS2 = (await S2.get('/api/me')).data;
  dbS33.prepare('UPDATE citizens SET level = 9, energy = 140, energy_updated_at = ? WHERE id = ?').run(Date.now(), meS2.citizen.id);
  const jobsS2 = (await S2.get('/api/jobs')).data;
  const adminS2 = jobsS2.jobs.find((j) => j.is_admin);
  dbS33.prepare('UPDATE citizens SET region_id = ? WHERE id = ?').run(adminS2.region_id, meS2.citizen.id);
  r = await S2.post('/api/jobs/apply', { job_id: adminS2.id });
  check('S2 melamar lowongan ADMIN', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await S2.post('/api/jobs/shift');
  check('Multi-shift: 140 energi → 2 shift, energyUsed 140', r.status === 200 && r.data.shifts === 2 && r.data.energyUsed === 140, `status=${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  check('Multi-shift: energyPct 70 (rata-rata fraksi shift penuh)', r.data.energyPct === 70, `energyPct=${r.data.energyPct}`);
  check('Multi-shift: energi habis (0)', (await S2.get('/api/me')).data.citizen.energy === 0);
  // --- (b2) Minum sekaligus: satu tekan sampai energi penuh.
  r = await S2.post('/api/shop/energy-drink', { qty: 100 });
  check('S2 beli 100 kaleng', r.status === 200 && r.data.qty === 100, `status=${r.status} ${r.data.error || ''}`);
  r = await S2.post('/api/shop/energy-drink', { qty: 100 });
  check('S2 beli 100 kaleng lagi (total 200)', r.status === 200 && r.data.qty === 100, `status=${r.status}`);
  r = await S2.post('/api/inventory/drink', {});
  check('Minum sekaligus: energi 0 → 140 (cap Level 9), sisa 60 kaleng', r.status === 200 && r.data.energy === 140 && r.data.gained === 140 && r.data.remaining === 60, `status=${r.status} ${JSON.stringify(r.data)}`);
  r = await S2.post('/api/inventory/drink', {});
  check('Minum saat energi penuh → 400 tanpa kaleng terpotong', r.status === 400 && r.data.error, `status=${r.status} ${r.data.error || ''}`);
  dbS33.prepare('UPDATE citizens SET energy = 139 WHERE id = ?').run(meS2.citizen.id);
  r = await S2.post('/api/inventory/drink', { qty: 1 });
  check('Minum qty=1 eksplisit: energi 139 → 140, sisa 59 kaleng', r.status === 200 && r.data.energy === 140 && r.data.remaining === 59, `status=${r.status} ${JSON.stringify(r.data)}`);

  // --- (c) Stok + upah perusahaan.
  const meS3 = (await S3.get('/api/me')).data;
  dbS33.prepare('UPDATE citizens SET gold = 1000 WHERE id = ?').run(meS3.citizen.id);
  r = await S3.post('/api/companies', { type: 'factory', name: 'Pabrik 33' });
  check('S3 mendirikan Pabrik (100 emas)', r.status === 200 && !!r.data.companyId, `status=${r.status} ${r.data.error || ''}`);
  const pabrik33Id = r.data.companyId;
  r = await S3.post('/api/companies', { type: 'resource', name: 'Tambang 33', resource: 'Besi Mentah' });
  check('S3 mendirikan Tambang (100 emas)', r.status === 200 && !!r.data.companyId, `status=${r.status} ${r.data.error || ''}`);
  const tambang33Id = r.data.companyId;
  const besi33 = dbS33.prepare("SELECT id FROM commodities WHERE name = 'Besi Mentah'").get().id;
  dbS33.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,?) ON CONFLICT (citizen_id, commodity_id, tier) DO UPDATE SET qty = ?').run(meS3.citizen.id, besi33, 30, 30);
  r = await S3.post(`/api/companies/${pabrik33Id}/stock`, { commodity: 'Besi Mentah', qty: 10 });
  check('Pemilik isi stok Pabrik: 10 Besi', r.status === 200 && r.data.stock?.[0]?.qty === 10, `status=${r.status} ${r.data.error || ''}`);
  r = await S3.get('/api/companies');
  const pabrik33 = (r.data.companies || []).find((x) => x.id === pabrik33Id);
  check('GET /api/companies: stok + inputs Pabrik terlihat', pabrik33?.stock?.[0]?.commodity === 'Besi Mentah' && pabrik33?.stock?.[0]?.qty === 10 && pabrik33?.inputs?.includes('Besi Mentah'), JSON.stringify({ stock: pabrik33?.stock, inputs: pabrik33?.inputs }));
  r = await S4.post(`/api/companies/${pabrik33Id}/stock`, { commodity: 'Besi Mentah', qty: 1 });
  check('Bukan pemilik isi stok → 403', r.status === 403, `status=${r.status}`);
  r = await S3.post(`/api/companies/${pabrik33Id}/stock`, { commodity: 'Gandum Mentah', qty: 1 });
  check('Stok bahan yang bukan input Pabrik → 400', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  r = await S3.post(`/api/companies/${pabrik33Id}/stock`, { commodity: 'Besi Mentah', qty: 999 });
  check('Stok melebihi inventaris → 400', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  r = await S3.post(`/api/companies/${tambang33Id}/stock`, { commodity: 'Besi Mentah', qty: 1 });
  check('Tambang (tanpa input) isi stok → 400', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  r = await S3.post(`/api/companies/${pabrik33Id}/job`, { title: 'Operator 33', salary: 100, salary_type: 'fixed', seats: 4 });
  check('S3 membuka lowongan di Pabrik', r.status === 200 && !!r.data.jobId, `status=${r.status} ${r.data.error || ''}`);
  const job33Id = r.data.jobId;
  r = await S3.patch(`/api/jobs/${job33Id}`, { salary: 500 });
  check('Pemilik edit upah → 200 (500 USD)', r.status === 200 && Number(r.data.job?.salary) === 500, `status=${r.status} ${JSON.stringify(r.data.job)}`);
  r = await S4.patch(`/api/jobs/${job33Id}`, { salary: 600 });
  check('Bukan pemilik edit upah → 403', r.status === 403, `status=${r.status}`);
  r = await S3.patch(`/api/jobs/${job33Id}`, { salary: 0 });
  check('Upah 0 → 400', r.status === 400, `status=${r.status}`);
  r = await S3.patch(`/api/jobs/${job33Id}`, { salary: 1001 });
  check('Upah 1001 (> saldo pemilik 500) → 400', r.status === 400, `status=${r.status}`);
  r = await S3.patch(`/api/jobs/${adminS2.id}`, { salary: 500 });
  check('Upah lowongan ADMIN → 403', r.status === 403, `status=${r.status}`);

  // --- (d) Donasi ke kas negara — S5 mendirikan negara dulu (A kehilangan
  // negaranya di tes Tahap 6: wilayahnya direbut pemberontak).
  const S5 = new Client();
  S5.extraHeaders = { 'X-Forwarded-For': '127.0.0.55' };
  r = await S5.post('/api/auth/register', { email: 'share_s5@test.local', password: 'rahasia123', username: 'share_s5' });
  check('S5 terdaftar', r.status === 200 && r.data.ok);
  const meS5 = (await S5.get('/api/me')).data;
  // Wilayah merdeka BUKAN wilayah asal S1 (supaya S1 tetap tanpa negara
  // untuk cek penolakan di bawah — kewarganegaraan mengikuti home region).
  const freeRegion = dbS33.prepare('SELECT id FROM regions WHERE country_id IS NULL AND id != ? ORDER BY id LIMIT 1').get(meS1.citizen.home_region_id);
  dbS33.prepare('UPDATE citizens SET level = 10, gold = 1000, region_id = ?, home_region_id = ? WHERE id = ?').run(freeRegion.id, freeRegion.id, meS5.citizen.id);
  r = await S5.post('/api/countries', { name: 'Negara 33', ideology: 'Konservatisme', system: 'presidensial' });
  check('S5 mendirikan negara (Level 10 + 100 emas)', r.status === 200 && !!r.data.countryId, `status=${r.status} ${r.data.error || ''}`);
  const ctryS5 = (await S5.get('/api/country')).data;
  check('S5 bernegara untuk tes donasi', !!ctryS5.country, `country=${ctryS5.country?.name}`);
  const treasBefore = ctryS5.country.treasury;
  const treasUsdBefore = ctryS5.country.treasury_usd;
  r = await S5.post('/api/country/donate', { type: 'gold', amount: 10 });
  check('Donasi 10 emas: kas negara +10', r.status === 200 && r.data.treasury === treasBefore + 10, `status=${r.status} ${JSON.stringify(r.data)}`);
  r = await S5.post('/api/country/donate', { type: 'gold', amount: 0 });
  check('Donasi 0 emas → 400', r.status === 400, `status=${r.status}`);
  r = await S5.post('/api/country/donate', { type: 'gold', amount: 99999999 });
  check('Donasi melebihi saldo emas → 400', r.status === 400, `status=${r.status}`);
  r = await S5.post('/api/country/donate', { type: 'usd', amount: 183 });
  check('Donasi 183 USD: kas Rupiah +183', r.status === 200 && Math.abs(r.data.treasury_usd - (treasUsdBefore + 183)) < 0.01, `status=${r.status} ${JSON.stringify(r.data)}`);
  const besiA = dbS33.prepare("SELECT id FROM commodities WHERE name = 'Besi Mentah'").get().id;
  const besiRef = dbS33.prepare('SELECT ref_usd FROM commodities WHERE id = ?').get(besiA).ref_usd;
  dbS33.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,?) ON CONFLICT (citizen_id, commodity_id, tier) DO UPDATE SET qty = qty + ?').run(meS5.citizen.id, besiA, 5, 5);
  r = await S5.post('/api/country/donate', { type: 'item', commodity: 'Besi Mentah', qty: 2 });
  check('Donasi 2× Besi: kas Rupiah + nilai acuan', r.status === 200 && Math.abs(r.data.amount - 2 * besiRef) < 0.01, `status=${r.status} ${JSON.stringify(r.data)}`);
  r = await S5.get('/api/country');
  check('Arus kas menampilkan 3 sumbangan', (r.data.treasuryTx || []).filter((t) => t.kind === 'sumbangan').length >= 3, `n=${(r.data.treasuryTx || []).filter((t) => t.kind === 'sumbangan').length}`);
  r = await S5.post('/api/country/donate', { type: 'item', commodity: 'Besi Mentah', qty: 999 });
  check('Donasi bahan melebihi inventaris → 400', r.status === 400, `status=${r.status}`);
  r = await S5.post('/api/country/donate', { type: 'nonsense', amount: 1 });
  check('Jenis donasi tidak dikenal → 400', r.status === 400, `status=${r.status}`);
  // Tanpa negara: S1 lahir di wilayah Nusantara — pindahkan dulu ke
  // wilayah merdeka (kewarganegaraan mengikuti home region).
  const freeForS1 = dbS33.prepare('SELECT id FROM regions WHERE country_id IS NULL ORDER BY id LIMIT 1').get();
  dbS33.prepare('UPDATE citizens SET region_id = ?, home_region_id = ? WHERE id = ?').run(freeForS1.id, freeForS1.id, meS1.citizen.id);
  r = await S1.post('/api/country/donate', { type: 'gold', amount: 1 });
  check('Tanpa negara: donasi ditolak 400', r.status === 400, `status=${r.status} ${r.data.error || ''}`);

  // --- (e) HEIC: foto profil HEIC ditolak dengan pesan khusus.
  const heicB64 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00]).toString('base64');
  r = await S1.post('/api/profile/avatar', { avatar: 'data:image/heic;base64,' + heicB64 });
  check('Avatar HEIC ditolak 400 dengan pesan HEIC (bukan format generik)', r.status === 400 && /HEIC/.test(r.data.error || '') && /JPG/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  const tinyJpeg33 = 'data:image/jpeg;base64,' + Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9]).toString('base64');
  r = await S1.post('/api/profile/avatar', { avatar: tinyJpeg33 });
  check('Avatar JPEG mungil tetap diterima (hanya HEIC yang ditolak)', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  dbS33.close();

  console.log('\n[34] v5.0.0 — rework upah perusahaan: gaji dari pemilik + bagi-hasil dari uang pemilik + ADMIN tak tersentuh');
  const G1 = new Client(); const G2 = new Client(); const G3 = new Client(); const G4 = new Client();
  G1.extraHeaders = { 'X-Forwarded-For': '127.0.0.61' };
  G2.extraHeaders = { 'X-Forwarded-For': '127.0.0.62' };
  G3.extraHeaders = { 'X-Forwarded-For': '127.0.0.63' };
  G4.extraHeaders = { 'X-Forwarded-For': '127.0.0.64' };
  r = await G1.post('/api/auth/register', { email: 'wage_t1@test.local', password: 'rahasia123', username: 'wage_t1' });
  check('G1 (pemilik perusahaan) terdaftar', r.status === 200 && r.data.ok, `status=${r.status}`);
  r = await G2.post('/api/auth/register', { email: 'wage_t2@test.local', password: 'rahasia123', username: 'wage_t2' });
  check('G2 (pekerja tetap) terdaftar', r.status === 200 && r.data.ok);
  r = await G3.post('/api/auth/register', { email: 'wage_t3@test.local', password: 'rahasia123', username: 'wage_t3' });
  check('G3 (pekerja bagi hasil) terdaftar', r.status === 200 && r.data.ok);
  r = await G4.post('/api/auth/register', { email: 'wage_t4@test.local', password: 'rahasia123', username: 'wage_t4' });
  check('G4 (pekerja ADMIN) terdaftar', r.status === 200 && r.data.ok);
  const dbS34 = new DatabaseSync(DB_PATH);
  const meG1 = (await G1.get('/api/me')).data;
  // G1: Level 10 + 1000 emas + 10000 USD, pindah ke wilayah merdeka, dirikan
  // negara (supaya pajak gaji pekerja bisa dicek masuk kas negara).
  const free34 = dbS34.prepare('SELECT id FROM regions WHERE country_id IS NULL ORDER BY id LIMIT 1').get();
  dbS34.prepare('UPDATE citizens SET level = 10, gold = 1000, usd = 10000, region_id = ?, home_region_id = ? WHERE id = ?').run(free34.id, free34.id, meG1.citizen.id);
  r = await G1.post('/api/countries', { name: 'Negara 34', ideology: 'Konservatisme', system: 'presidensial' });
  check('G1 mendirikan negara (untuk tes pajak gaji)', r.status === 200 && !!r.data.countryId, `status=${r.status} ${r.data.error || ''}`);
  const capital34 = free34.id;
  r = await G1.post('/api/companies', { type: 'resource', name: 'Tambang 34', resource: 'Besi Mentah' });
  check('G1 mendirikan Tambang (100 emas)', r.status === 200 && !!r.data.companyId, `status=${r.status} ${r.data.error || ''}`);
  const tambang34Id = r.data.companyId;

  // --- (a) Buat lowongan: gaji > saldo pemilik ditolak (bukan cap tetap).
  r = await G1.post(`/api/companies/${tambang34Id}/job`, { title: 'Operator Mahal', salary: 15000, salary_type: 'fixed', seats: 4 });
  check('Buka lowongan gaji 15000 (> saldo 10000) → 400', r.status === 400 && /maksimal/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  r = await G1.post(`/api/companies/${tambang34Id}/job`, { title: 'Operator 34', salary: 100, salary_type: 'fixed', seats: 4 });
  check('Buka lowongan gaji 100 (≤ saldo) → 200', r.status === 200 && !!r.data.jobId, `status=${r.status} ${r.data.error || ''}`);
  const jobFixed34 = r.data.jobId;
  r = await G1.post(`/api/companies/${tambang34Id}/job`, { title: 'Bagi Hasil 34', salary: 100, salary_type: 'share', seats: 4 });
  check('Buka lowongan bagi hasil gaji 100 → 200', r.status === 200 && !!r.data.jobId, `status=${r.status} ${r.data.error || ''}`);
  const jobShare34 = r.data.jobId;
  r = await G1.post(`/api/companies/${tambang34Id}/job`, { title: 'Bagi Hasil Mahal', salary: 15000, salary_type: 'share', seats: 4 });
  check('Buka lowongan bagi hasil 15000 (> saldo) → 400', r.status === 400, `status=${r.status}`);

  // --- (b) Edit upah: > saldo ditolak; di atas cap lama (1000) tapi ≤ saldo DIIZINKAN.
  r = await G1.patch(`/api/jobs/${jobFixed34}`, { salary: 15000 });
  check('Edit upah 15000 (> saldo) → 400', r.status === 400, `status=${r.status}`);
  dbS34.prepare('UPDATE citizens SET usd = 20000 WHERE id = ?').run(meG1.citizen.id);
  r = await G1.patch(`/api/jobs/${jobFixed34}`, { salary: 1500 });
  check('Edit upah 1500 (> cap lama 1000, ≤ saldo 20000) → 200: cap tetap HILANG', r.status === 200 && Number(r.data.job?.salary) === 1500, `status=${r.status} ${JSON.stringify(r.data.job)}`);
  r = await G1.patch(`/api/jobs/${jobFixed34}`, { salary: 100 });
  check('Edit upah kembali 100 (untuk tes shift)', r.status === 200 && Number(r.data.job?.salary) === 100, `status=${r.status}`);
  dbS34.prepare('UPDATE citizens SET usd = 10000 WHERE id = ?').run(meG1.citizen.id);

  // Tarif pajak dari event dunia saat ini (hari 1 = Panen Raya → 2%;
  // bila minggu booming, −1 poin) — dihitung, bukan di-hardcode.
  const world34 = (await G1.get('/api/world')).data;
  const taxRate34 = 0.02 - (world34.event?.key === 'booming' ? 0.01 : 0);
  const expTax34 = Math.round(100 * taxRate34 * 100) / 100;
  const expNet34 = Math.round((100 - expTax34) * 100) / 100;

  // --- (c) Shift fixed: gaji dipotong pemilik (gross), pekerja terima net,
  // pajak ke kas negara, pemilik dapat bonus material (+2 Besi).
  const meG2 = (await G2.get('/api/me')).data;
  dbS34.prepare('UPDATE citizens SET region_id = ?, home_region_id = ? WHERE id = ?').run(capital34, capital34, meG2.citizen.id);
  r = await G2.post('/api/jobs/apply', { job_id: jobFixed34 });
  check('G2 melamar lowongan tetap Tambang 34', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  const t1UsdB = (await G1.get('/api/me')).data.citizen.usd;
  const t2UsdB = (await G2.get('/api/me')).data.citizen.usd;
  const treasB = (await G1.get('/api/country')).data.country.treasury_usd;
  r = await G2.post('/api/jobs/shift');
  check('G2 shift penuh di perusahaan: 200', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  check('Shift fixed: gross 100 = net + pajak', r.data.gross === 100 && Math.abs(r.data.net + r.data.tax - 100) < 0.01 && Math.abs(r.data.tax - expTax34) < 0.01, `gross=${r.data.gross} net=${r.data.net} tax=${r.data.tax} (ekspektasi pajak ${expTax34})`);
  const t1UsdA = (await G1.get('/api/me')).data.citizen.usd;
  const t2UsdA = (await G2.get('/api/me')).data.citizen.usd;
  const treasA = (await G1.get('/api/country')).data.country.treasury_usd;
  check('Pemilik dipotong GROSS 100 (bukan cetak)', Math.abs(t1UsdA - (t1UsdB - 100)) < 0.01, `pemilik ${t1UsdB} -> ${t1UsdA}`);
  check('Pekerja terima NET (bukan gross)', Math.abs(t2UsdA - (t2UsdB + expNet34)) < 0.01, `pekerja ${t2UsdB} -> ${t2UsdA} (net ${expNet34})`);
  check('Pajak masuk kas negara pekerja', Math.abs(treasA - (treasB + expTax34)) < 0.01, `kas ${treasB} -> ${treasA}`);
  check('Pemilik dapat bonus material +2 Besi Mentah', r.data.companyBonus?.qty === 2 && r.data.companyBonus?.product === 'Besi Mentah', JSON.stringify(r.data.companyBonus));
  check('Catatan shift: gaji dibayar dari uang pemilik', /dibayar dari uang pemilik/.test(r.data.note || ''), r.data.note);
  const besiId34 = dbS34.prepare("SELECT id FROM commodities WHERE name = 'Besi Mentah'").get().id;
  const besiT1a = dbS34.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM inventory WHERE citizen_id = ? AND commodity_id = ?').get(meG1.citizen.id, besiId34).q;
  check('Bonus material benar-benar di inventaris PEMILIK', Number(besiT1a) >= 2, `qty=${besiT1a}`);

  // --- (d) Pemilik tidak mampu bayar: shift gagal rapi, tidak ada yang berubah.
  dbS34.prepare('UPDATE citizens SET usd = 50, energy = 100 WHERE id = ?').run(meG1.citizen.id);
  dbS34.prepare('UPDATE citizens SET energy = 100 WHERE id = ?').run(meG2.citizen.id);
  const t2UsdBeforeFail = (await G2.get('/api/me')).data.citizen.usd;
  r = await G2.post('/api/jobs/shift');
  check('Pemilik saldo 50 < gaji 100: shift → 400 "tidak mampu membayar"', r.status === 400 && /tidak mampu membayar/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  const t2AfterFail = (await G2.get('/api/me')).data.citizen;
  const t1AfterFail = (await G1.get('/api/me')).data.citizen;
  check('Shift gagal: USD pekerja + energi pekerja + USD pemilik TIDAK berubah', Math.abs(t2AfterFail.usd - t2UsdBeforeFail) < 0.01 && t2AfterFail.energy === 100 && Math.abs(t1AfterFail.usd - 50) < 0.01, `pekerja usd=${t2AfterFail.usd} energi=${t2AfterFail.energy} pemilik usd=${t1AfterFail.usd}`);
  dbS34.prepare('UPDATE citizens SET usd = 10000 WHERE id = ?').run(meG1.citizen.id);

  // --- (e) Pemilik bekerja di perusahaannya sendiri: net nol, bonus tetap jalan.
  r = await G1.post('/api/jobs/apply', { job_id: jobFixed34 });
  check('G1 (pemilik) melamar lowongan sendiri', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  const t1UsdB2 = (await G1.get('/api/me')).data.citizen.usd;
  r = await G1.post('/api/jobs/shift');
  check('Pemilik shift di perusahaan sendiri: 200, net 0, pajak 0', r.status === 200 && r.data.net === 0 && r.data.tax === 0, `status=${r.status} net=${r.data.net} tax=${r.data.tax} ${r.data.error || ''}`);
  const t1UsdA2 = (await G1.get('/api/me')).data.citizen.usd;
  check('Pemilik kerja sendiri: USD TIDAK berubah (tidak ada transfer)', Math.abs(t1UsdA2 - t1UsdB2) < 0.01, `pemilik ${t1UsdB2} -> ${t1UsdA2}`);
  check('Pemilik kerja sendiri: bonus material +2 Besi tetap jalan', r.data.companyBonus?.qty === 2 && r.data.companyBonus?.product === 'Besi Mentah', JSON.stringify(r.data.companyBonus));
  check('Catatan shift pemilik: "perusahaan sendiri"', /perusahaan sendiri/.test(r.data.note || ''), r.data.note);

  // --- (f) Shift bagi hasil: pekerja dapat barang, pemilik membayar nilainya.
  const meG3 = (await G3.get('/api/me')).data;
  dbS34.prepare('UPDATE citizens SET region_id = ?, home_region_id = ? WHERE id = ?').run(capital34, capital34, meG3.citizen.id);
  r = await G3.post('/api/jobs/apply', { job_id: jobShare34 });
  check('G3 melamar lowongan bagi hasil Tambang 34', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  const besiRef34 = dbS34.prepare("SELECT ref_usd FROM commodities WHERE name = 'Besi Mentah'").get().ref_usd;
  const expShareUnits = Math.floor(100 * 0.9 / besiRef34);
  const expShareCost = Math.round(expShareUnits * besiRef34 * 100) / 100;
  const t1UsdB3 = (await G1.get('/api/me')).data.citizen.usd;
  const t3UsdB = (await G3.get('/api/me')).data.citizen.usd;
  r = await G3.post('/api/jobs/shift');
  check('G3 shift bagi hasil: 200', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  check('Bagi hasil: pekerja dapat barang (90% × gaji / harga acuan)', r.data.goodsQty === expShareUnits && r.data.goodsName === 'Besi Mentah', `goods=${r.data.goodsQty}×${r.data.goodsName} (ekspektasi ${expShareUnits})`);
  const t1UsdA3 = (await G1.get('/api/me')).data.citizen.usd;
  const t3UsdA = (await G3.get('/api/me')).data.citizen.usd;
  check('Bagi hasil: pemilik membayar nilai barang (bukan cetak)', Math.abs(t1UsdA3 - (t1UsdB3 - expShareCost)) < 0.01, `pemilik ${t1UsdB3} -> ${t1UsdA3} (biaya ${expShareCost})`);
  check('Bagi hasil: USD pekerja TIDAK berubah', Math.abs(t3UsdA - t3UsdB) < 0.01, `pekerja ${t3UsdB} -> ${t3UsdA}`);
  const besiT3 = dbS34.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM inventory WHERE citizen_id = ? AND commodity_id = ?').get(meG3.citizen.id, besiId34).q;
  check('Bagi hasil: barang benar-benar di inventaris PEKERJA', Number(besiT3) === expShareUnits, `qty=${besiT3}`);
  check('Bagi hasil: pemilik juga dapat bonus +2 Besi', r.data.companyBonus?.qty === 2 && r.data.companyBonus?.product === 'Besi Mentah', JSON.stringify(r.data.companyBonus));

  // --- (f2) Bagi hasil saat pemilik tidak mampu bayar nilai barangnya.
  dbS34.prepare('UPDATE citizens SET usd = 1 WHERE id = ?').run(meG1.citizen.id);
  dbS34.prepare('UPDATE citizens SET energy = 100 WHERE id = ?').run(meG3.citizen.id);
  r = await G3.post('/api/jobs/shift');
  check('Bagi hasil, pemilik saldo 1: shift → 400 "tidak mampu membayar"', r.status === 400 && /tidak mampu membayar/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  const t3AfterFail2 = (await G3.get('/api/me')).data.citizen;
  check('Bagi hasil gagal: energi pekerja tetap 100, tidak ada barang', t3AfterFail2.energy === 100, `energi=${t3AfterFail2.energy}`);
  dbS34.prepare('UPDATE citizens SET usd = 10000 WHERE id = ?').run(meG1.citizen.id);

  // --- (f3) Bagi hasil Pabrik: tanpa stok bahan → gagal; dengan stok 12 Besi
  // → 5× Bahan Bangunan (90/17,85) dari 10 Besi + bonus 1× dari 2 Besi sisa.
  r = await G1.post('/api/companies', { type: 'factory', name: 'Pabrik 34', resource: 'Bahan Bangunan' });
  check('G1 mendirikan Pabrik (100 emas)', r.status === 200 && !!r.data.companyId, `status=${r.status} ${r.data.error || ''}`);
  const pabrik34Id = r.data.companyId;
  r = await G1.post(`/api/companies/${pabrik34Id}/job`, { title: 'Bagi Hasil Pabrik 34', salary: 100, salary_type: 'share', seats: 4 });
  check('Buka lowongan bagi hasil Pabrik', r.status === 200 && !!r.data.jobId, `status=${r.status} ${r.data.error || ''}`);
  const jobShareFab34 = r.data.jobId;
  r = await G3.post('/api/jobs/apply', { job_id: jobShareFab34 });
  check('G3 pindah ke lowongan bagi hasil Pabrik', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await G3.post('/api/jobs/shift');
  check('Bagi hasil Pabrik tanpa stok: shift → 400 "kehabisan bahan"', r.status === 400 && /kehabisan bahan/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  dbS34.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,?) ON CONFLICT (citizen_id, commodity_id, tier) DO UPDATE SET qty = qty + ?').run(meG1.citizen.id, besiId34, 10, 10);
  r = await G1.post(`/api/companies/${pabrik34Id}/stock`, { commodity: 'Besi Mentah', qty: 12 });
  check('Pemilik isi stok Pabrik: 12 Besi', r.status === 200 && r.data.stock?.[0]?.qty === 12, `status=${r.status} ${r.data.error || ''}`);
  const bbRef34 = dbS34.prepare("SELECT ref_usd FROM commodities WHERE name = 'Bahan Bangunan'").get().ref_usd;
  const expFabUnits = Math.min(Math.floor(100 * 0.9 / bbRef34), Math.floor(12 / 2));
  const expFabCost = Math.round(expFabUnits * bbRef34 * 100) / 100;
  const t1UsdB4 = (await G1.get('/api/me')).data.citizen.usd;
  r = await G3.post('/api/jobs/shift');
  check('Bagi hasil Pabrik dengan stok: 200', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  check('Bagi hasil Pabrik: unit dibatasi stok (5, bukan 40+)', r.data.goodsQty === expFabUnits && r.data.goodsName === 'Bahan Bangunan', `goods=${r.data.goodsQty}×${r.data.goodsName} (ekspektasi ${expFabUnits})`);
  const t1UsdA4 = (await G1.get('/api/me')).data.citizen.usd;
  check('Bagi hasil Pabrik: pemilik membayar nilai barang', Math.abs(t1UsdA4 - (t1UsdB4 - expFabCost)) < 0.01, `pemilik ${t1UsdB4} -> ${t1UsdA4} (biaya ${expFabCost})`);
  check('Bagi hasil Pabrik: bonus 1× Bahan Bangunan dari sisa stok', r.data.companyBonus?.qty === 1 && r.data.companyBonus?.product === 'Bahan Bangunan', JSON.stringify(r.data.companyBonus));
  const fabStock = (await G1.get('/api/companies')).data.companies.find((x) => x.id === pabrik34Id);
  check('Stok Pabrik habis setelah shift (10 dipakai barang + 2 dipakai bonus)', ((fabStock?.stock || []).find((s) => s.commodity === 'Besi Mentah')?.qty || 0) === 0, JSON.stringify(fabStock?.stock));

  // --- (g) Lowongan ADMIN tidak terpengaruh aturan upah perusahaan.
  const meG4 = (await G4.get('/api/me')).data;
  const jobsT4 = (await G4.get('/api/jobs')).data;
  const adminT4 = jobsT4.jobs.find((j) => j.is_admin);
  dbS34.prepare('UPDATE citizens SET region_id = ? WHERE id = ?').run(adminT4.region_id, meG4.citizen.id);
  r = await G4.post('/api/jobs/apply', { job_id: adminT4.id });
  check('G4 melamar lowongan ADMIN', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  const t4UsdB = (await G4.get('/api/me')).data.citizen.usd;
  r = await G4.post('/api/jobs/shift');
  check('Shift ADMIN tetap dibayar BAHAN MENTAH (bukan USD pemilik)', r.status === 200 && (r.data.goodsQty || 0) > 0, `status=${r.status} goods=${r.data.goodsQty} ${r.data.error || ''}`);
  const t4UsdA = (await G4.get('/api/me')).data.citizen.usd;
  check('Shift ADMIN: USD pekerja TIDAK berubah', Math.abs(t4UsdA - t4UsdB) < 0.01, `pekerja ${t4UsdB} -> ${t4UsdA}`);
  dbS34.close();

  console.log('\n[35] v5.0.1 — Bagikan artikel ke chat + lowongan duplikat ditolak (laporan Vincent)');
  const H1 = new Client(); const H2 = new Client();
  H1.extraHeaders = { 'X-Forwarded-For': '127.0.0.71' };
  H2.extraHeaders = { 'X-Forwarded-For': '127.0.0.72' };
  r = await H1.post('/api/auth/register', { email: 'h1@test.local', password: 'rahasia123', username: 'h_satu' });
  check('H1 terdaftar', r.status === 200 && r.data.ok, `status=${r.status}`);
  r = await H2.post('/api/auth/register', { email: 'h2@test.local', password: 'rahasia123', username: 'h_dua' });
  check('H2 terdaftar', r.status === 200 && r.data.ok, `status=${r.status}`);
  const dbS35 = new DatabaseSync(DB_PATH);
  const meH1 = (await H1.get('/api/me')).data.citizen;
  const meH2 = (await H2.get('/api/me')).data.citizen;
  dbS35.prepare('UPDATE citizens SET gold = 1000, usd = 10000 WHERE id = ?').run(meH1.id);
  // H2 tinggal di wilayah H1 supaya bisa melamar lowongan perusahaan H1.
  dbS35.prepare('UPDATE citizens SET region_id = ?, home_region_id = ? WHERE id = ?').run(meH1.region_id, meH1.region_id, meH2.id);
  r = await H1.post('/api/press/newspaper', { name: 'Koran H1' });
  check('H1 mendirikan koran', r.status === 200 && !!r.data.newspaperId, `status=${r.status} ${r.data.error || ''}`);
  const npH = r.data.newspaperId;
  r = await H1.post('/api/press/articles', { newspaper_id: npH, title: 'Berita H1 Penting', content: 'Isi artikel H1 yang cukup panjang untuk lolos validasi minimal dua puluh karakter.', topic: 'Pengumuman' });
  check('H1 menerbitkan artikel', r.status === 200 && !!r.data.articleId, `status=${r.status} ${r.data.error || ''}`);
  const artH = r.data.articleId;
  r = await H1.post('/api/chat/global', { content: 'Baca artikel ini: Berita H1 Penting', article_id: artH });
  check('Bagikan artikel ke Global: 200', r.status === 200 && !!r.data.messageId, `status=${r.status} ${r.data.error || ''}`);
  r = await H1.get('/api/chat/global');
  const sharedH = (r.data.messages || []).find((m) => m.article_id === artH);
  check('Pesan share ada di Global + pratinjau (article_id + judul)', !!sharedH && sharedH.article_title === 'Berita H1 Penting', sharedH ? `judul=${sharedH.article_title}` : 'pesan tidak ditemukan');
  r = await H1.post('/api/chat/global', { content: 'Baca artikel ini: Berita H1 Penting', article_id: artH });
  check('Bagikan lagi <5 detik: 400 cooldown', r.status === 400 && /Tunggu sebentar/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  r = await H1.post('/api/chat/global', { content: 'Baca artikel ini: Hantu', article_id: 999999 });
  check('Bagikan artikel tak ada: 400 "Artikel tidak ditemukan." (bukan diam-diam tanpa pratinjau)', r.status === 400 && /Artikel tidak ditemukan/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  r = await H1.post('/api/companies', { type: 'resource', name: 'PT H1', resource: 'Besi Mentah' });
  check('H1 mendirikan perusahaan', r.status === 200 && !!r.data.companyId, `status=${r.status} ${r.data.error || ''}`);
  const coH = r.data.companyId;
  r = await H1.post(`/api/companies/${coH}/job`, { title: 'Kerja', salary: 100, salary_type: 'fixed', seats: 4 });
  check('Buka lowongan Kerja $100', r.status === 200 && !!r.data.jobId, `status=${r.status} ${r.data.error || ''}`);
  const jobH1 = r.data.jobId;
  r = await H1.post(`/api/companies/${coH}/job`, { title: 'Kerja', salary: 100, salary_type: 'fixed', seats: 4 });
  check('Buka lowongan identik: 400 sudah terbuka', r.status === 400 && /sudah terbuka/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  r = await H1.post(`/api/companies/${coH}/job`, { title: 'Kerja', salary: 150, salary_type: 'fixed', seats: 4 });
  check('Buka lowongan judul sama gaji beda: 200', r.status === 200 && !!r.data.jobId, `status=${r.status} ${r.data.error || ''}`);
  const jobH2 = r.data.jobId;
  r = await H1.patch(`/api/jobs/${jobH2}`, { salary: 100 });
  check('Edit upah jadi duplikat lowongan terbuka: 400', r.status === 400 && /sama dengan/.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  r = await H1.patch(`/api/jobs/${jobH2}`, { salary: 120 });
  check('Edit upah jadi 120 (tidak duplikat): 200', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  r = await H2.post('/api/jobs/apply', { job_id: jobH1 });
  check('H2 melamar lowongan pertama (pemegang tidak boleh hilang saat dedup)', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
  const jobsAfter = (await H1.get('/api/jobs')).data.jobs || [];
  check('Lowongan pertama tetap ada setelah H2 melamar', jobsAfter.some((j) => j.id === jobH1), `jobH1=${jobH1}`);
  dbS35.close();

  console.log('\n[36] v5.2.0 — Tutorial awal: overlay pemain baru, skip, simpan server');
  const tut = new Client();
  // IP berbeda (seperti H1/H2 di [35]): registrasi dibatasi per IP —
  // tanpa ini, pendaftaran ke-40+ dari 127.0.0.1 kena 429.
  tut.extraHeaders = { 'X-Forwarded-For': '127.0.0.73' };
  r = await tut.post('/api/auth/register', { email: 'tut1@test.local', password: 'rahasia123', username: 'tut_satu' });
  check('tut terdaftar', r.status === 200 && r.data.ok, `status=${r.status}`);
  const meTut = (await tut.get('/api/me')).data.citizen;
  check('Warga baru: /api/me tutorial_done = 0', meTut?.tutorial_done === 0, `tutorial_done=${meTut?.tutorial_done}`);
  r = await tut.post('/api/tutorial/done', { via: 'skip' });
  check('POST /api/tutorial/done (skip): 200', r.status === 200 && r.data.ok, `status=${r.status} ${r.data.error || ''}`);
  const meTut2 = (await tut.get('/api/me')).data.citizen;
  check('Sesudah skip: /api/me tutorial_done = 1', meTut2?.tutorial_done === 1, `tutorial_done=${meTut2?.tutorial_done}`);
  r = await tut.post('/api/tutorial/done', { via: 'complete' });
  check('POST /api/tutorial/done kedua: 200 (idempotent)', r.status === 200 && r.data.ok, `status=${r.status}`);
  const tutAnon = new Client();
  r = await tutAnon.post('/api/tutorial/done', {});
  check('POST /api/tutorial/done tanpa login: 401', r.status === 401, `status=${r.status}`);

  console.log('\n[37] v5.3.0 — Banner iklan AdSense berhadiah (+15, maks 10/hari, lihat 10 detik)');
  // Server e2e di-boot dengan ADSENSE_BANNER_SLOT test (lihat startServer).
  r = await A.get('/api/me');
  const bannerMe = r.data.ads?.banner || {};
  check('Banner aktif di /api/me (enabled + slot + hadiah 15 + cap 10 + view 10 dtk)',
    bannerMe.enabled === true && bannerMe.slot === 'e2e-test-banner-slot' && bannerMe.rewardGold === 15 && bannerMe.dailyCap === 10 && bannerMe.viewMs === 10000, JSON.stringify(bannerMe));
  const goldB0 = r.data.citizen.gold;
  r = await A.post('/api/ads/banner/start');
  check('POST /api/ads/banner/start memberi token 64 hex + remainingToday 10',
    r.status === 200 && typeof r.data.token === 'string' && r.data.token.length === 64 && r.data.remainingToday === 10,
    `status=${r.status} remaining=${r.data.remainingToday}`);
  const btok1 = r.data.token;
  // Klaim langsung (belum 10 detik terlihat) ditolak.
  r = await A.post('/api/ads/banner/reward', { token: btok1 });
  check('Klaim banner sebelum 10 detik ditolak', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  // Mundurkan expires_at 11 detik (simulasi banner terlihat 11 detik) +
  // mundurkan granted_at (jeda 30 detik sejak grant terakhir di [30]).
  {
    const dbB = new DatabaseSync(DB_PATH);
    dbB.prepare('UPDATE ad_tokens SET expires_at = expires_at - 11000 WHERE token = ?').run(btok1);
    dbB.prepare('UPDATE ad_rewards SET granted_at = ? WHERE citizen_id = ?').run(Date.now() - 60000, adsId);
    dbB.close();
  }
  r = await A.post('/api/ads/banner/reward', { token: btok1 });
  check('Klaim banner setelah 10 detik: +15 emas, sisa 9× hari ini',
    r.status === 200 && r.data.reward?.gold === 15 && r.data.remainingToday === 9, `status=${r.status} ${r.data.error || ''}`);
  r = await A.get('/api/me');
  check('Saldo emas naik 15 (banner)', r.data.citizen.gold === goldB0 + 15, `${goldB0}→${r.data.citizen.gold}`);
  // Token dipakai 2× ditolak.
  r = await A.post('/api/ads/banner/reward', { token: btok1 });
  check('Token banner dipakai 2× ditolak', r.status === 400, `status=${r.status}`);
  // Token video tidak bisa ditukar hadiah banner, dan sebaliknya.
  r = await A.post('/api/ads/start');
  const vtok = r.data.token;
  r = await A.post('/api/ads/banner/reward', { token: vtok });
  check('Token video di endpoint banner ditolak', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  r = await A.post('/api/ads/banner/start');
  const btok2 = r.data.token;
  r = await A.post('/api/ads/reward', { token: btok2 });
  check('Token banner di endpoint video ditolak', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  // Batas harian: grant ke-2..ke-10 berhasil, ke-11 ditolak (jeda 30 detik
  // dilewati dengan memundurkan granted_at; waktu lihat dilewati dengan
  // memundurkan expires_at token 11 detik).
  {
    const dbB = new DatabaseSync(DB_PATH);
    let okCount = 0;
    for (let i = 0; i < 9; i++) {
      const st = await A.post('/api/ads/banner/start');
      dbB.prepare('UPDATE ad_rewards SET granted_at = ? WHERE citizen_id = ?').run(Date.now() - 60000, adsId);
      dbB.prepare('UPDATE ad_tokens SET expires_at = expires_at - 11000 WHERE token = ?').run(st.data.token);
      const rw = await A.post('/api/ads/banner/reward', { token: st.data.token });
      if (rw.status === 200 && rw.data.reward?.gold === 15) okCount++;
      else { check(`Grant banner #${i + 2} berhasil`, false, `status=${rw.status} ${rw.data.error || ''}`); break; }
    }
    check('Grant banner ke-2 sampai ke-10 berhasil (cap 10/hari)', okCount === 9, `berhasil ${okCount}/9`);
    // Grant ke-11 (di luar cap) ditolak meski jeda + waktu lihat dilewati.
    const st11 = await A.post('/api/ads/banner/start');
    dbB.prepare('UPDATE ad_rewards SET granted_at = ? WHERE citizen_id = ?').run(Date.now() - 60000, adsId);
    dbB.prepare('UPDATE ad_tokens SET expires_at = expires_at - 11000 WHERE token = ?').run(st11.data.token);
    const rw11 = await A.post('/api/ads/banner/reward', { token: st11.data.token });
    check('Grant banner ke-11 ditolak (batas harian 10×/hari)', rw11.status === 400, `status=${rw11.status} ${rw11.data.error || ''}`);
    const nB = dbB.prepare("SELECT COUNT(*) AS n FROM ad_rewards WHERE citizen_id = ? AND kind = 'banner'").get(adsId);
    check('Tabel audit mencatat 10 grant banner (kind=banner)', Number(nB.n) === 10, `n=${nB.n}`);
    const nV = dbB.prepare("SELECT COUNT(*) AS n FROM ad_rewards WHERE citizen_id = ? AND kind = 'video'").get(adsId);
    check('Grant video tetap tercatat kind=video (7 baris dari [30])', Number(nV.n) === 7, `n=${nV.n}`);
    dbB.close();
  }

  console.log('\n[38] v5.5.0 — Lupa Password: minta → ACC admin → masuk sekali pakai → password baru');
  // Pemain baru WR (IP sendiri lewat X-Forwarded-For — registrasi dibatasi
  // 20/IP/24 jam, pola [23b]/[28]).
  const WR = new Client();
  WR.extraHeaders = { 'X-Forwarded-For': '127.0.0.201' };
  r = await WR.post('/api/auth/register', { email: 'lupa@test.local', password: 'lama12345', username: 'warga_lupa' });
  check('WR mendaftar (lupa@test.local)', r.status === 200 && r.data.ok, `status=${r.status}`);
  const wrId = r.data.user?.id;
  r = await WR.post('/api/auth/login', { email: 'lupa@test.local', password: 'lama12345' });
  check('WR login dengan password lama berhasil', r.status === 200 && r.data.ok);
  // Email TIDAK terdaftar: balasan generik, tanpa baris di DB (tidak bocor).
  const anon = new Client();
  r = await anon.post('/api/auth/forgot-password', { email: 'tidakada@test.local' });
  check('Forgot email tak dikenal: 200 + pesan generik', r.status === 200 && typeof r.data.message === 'string' && r.data.message.length > 0, `status=${r.status}`);
  const genericMsg = r.data.message;
  // Minta reset (dengan keterangan) → pesan generik yang SAMA persis.
  r = await WR.post('/api/auth/forgot-password', { email: 'lupa@test.local', note: 'warga_lupa, lahir di Kepulauan Riau' });
  check('Forgot email terdaftar: pesan generik identik (tidak bocor)', r.status === 200 && r.data.message === genericMsg, `status=${r.status}`);
  // Minta 2× (masih aktif) → tetap generik, TIDAK duplikat baris.
  r = await WR.post('/api/auth/forgot-password', { email: 'lupa@test.local' });
  check('Forgot duplikat saat aktif: tetap generik', r.status === 200 && r.data.message === genericMsg);
  {
    const dbW = new DatabaseSync(DB_PATH);
    const n = dbW.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?').get(wrId);
    check('Satu baris permintaan aktif (tidak duplikat)', Number(n.n) === 1, `n=${n.n}`);
    dbW.close();
  }
  r = await anon.get('/api/auth/forgot-password/status?email=lupa@test.local');
  check('Status sebelum ACC: approved=false', r.status === 200 && r.data.approved === false, JSON.stringify(r.data));
  r = await anon.post('/api/auth/reset-login', { email: 'lupa@test.local' });
  check('Reset-login sebelum ACC ditolak (400)', r.status === 400, `status=${r.status}`);
  // Admin melihat permintaan di kotak masuk (digabung ke tiket).
  r = await ADM.get('/api/admin/tickets');
  const prRow = (r.data.tickets || []).find((t) => t.kind === 'password_reset' && t.username === 'warga_lupa');
  check('Permintaan muncul di kotak masuk admin (kind password_reset, status baru)', !!prRow && prRow.status === 'baru' && prRow.resetStatus === 'menunggu', prRow ? `id=${prRow.id} status=${prRow.status}` : 'tidak ketemu');
  r = await ADM.get('/api/admin/password-resets');
  check('Admin: daftar permintaan reset berisi 1 pending', r.status === 200 && r.data.requests?.length === 1 && r.data.requests[0].status === 'pending', `n=${r.data.requests?.length}`);
  const prId = r.data.requests[0].id;
  r = await B.post(`/api/admin/password-resets/${prId}/decide`, { decision: 'accept' });
  check('Non-admin: putuskan reset ditolak 403', r.status === 403, `status=${r.status}`);
  r = await ADM.post(`/api/admin/password-resets/${prId}/decide`, { decision: 'mungkin' });
  check('Admin: keputusan tidak valid ditolak 400', r.status === 400, `status=${r.status}`);
  // Admin TOLAK dulu → status tetap false, reset-login tetap 400.
  r = await ADM.post(`/api/admin/password-resets/${prId}/decide`, { decision: 'reject' });
  check('Admin TOLAK permintaan', r.status === 200 && r.data.status === 'rejected', `status=${r.status}`);
  r = await anon.get('/api/auth/forgot-password/status?email=lupa@test.local');
  check('Status setelah TOLAK: approved=false', r.data.approved === false);
  r = await anon.post('/api/auth/reset-login', { email: 'lupa@test.local' });
  check('Reset-login setelah TOLAK ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await ADM.post(`/api/admin/password-resets/${prId}/decide`, { decision: 'accept' });
  check('Putusan ganda pada permintaan yang sudah diputus ditolak (400)', r.status === 400, `status=${r.status}`);
  // Minta lagi (permintaan lama sudah diputus → boleh baris baru) → ACC.
  r = await WR.post('/api/auth/forgot-password', { email: 'lupa@test.local' });
  check('Minta lagi setelah ditolak: 200 generik', r.status === 200 && r.data.message === genericMsg);
  r = await ADM.get('/api/admin/password-resets');
  const prId2 = r.data.requests.find((x) => x.status === 'pending')?.id;
  check('Permintaan kedua tercatat pending', !!prId2, `id=${prId2}`);
  r = await ADM.post(`/api/admin/password-resets/${prId2}/decide`, { decision: 'accept' });
  check('Admin ACC permintaan kedua', r.status === 200 && r.data.status === 'approved', `status=${r.status}`);
  r = await anon.get('/api/auth/forgot-password/status?email=lupa@test.local');
  check('Status setelah ACC: approved=true', r.data.approved === true, JSON.stringify(r.data));
  r = await anon.post('/api/auth/reset-login', { email: 'salah@test.local' });
  check('Reset-login email lain ditolak (400)', r.status === 400, `status=${r.status}`);
  // Masuk sekali pakai (klien baru, tanpa sesi lama).
  const WR2 = new Client();
  r = await WR2.post('/api/auth/reset-login', { email: 'lupa@test.local' });
  check('Reset-login setelah ACC: 200 + mustChangePassword', r.status === 200 && r.data.mustChangePassword === true, `status=${r.status}`);
  r = await WR2.get('/api/auth/me');
  check('Sesi reset-login: /api/auth/me pw_reset_required=true', r.data.user?.pw_reset_required === true, JSON.stringify(r.data.user));
  // Token sekali pakai: klik kedua gagal.
  r = await anon.post('/api/auth/reset-login', { email: 'lupa@test.local' });
  check('Reset-login kedua (token sudah dipakai) ditolak (400)', r.status === 400, `status=${r.status}`);
  // Atur password baru: validasi dulu, lalu berhasil.
  r = await WR2.post('/api/auth/reset-password', { password: 'baru12345', password_confirm: 'beda12345' });
  check('Reset password konfirmasi beda ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await WR2.post('/api/auth/reset-password', { password: 'abc' });
  check('Reset password terlalu pendek ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await WR2.post('/api/auth/reset-password', { password: 'baru12345', password_confirm: 'baru12345' });
  check('Reset password baru berhasil', r.status === 200 && r.data.ok, `status=${r.status}`);
  r = await WR2.get('/api/auth/me');
  check('Setelah reset: pw_reset_required=false', r.data.user?.pw_reset_required === false, JSON.stringify(r.data.user));
  r = await WR2.post('/api/auth/reset-password', { password: 'lagi12345' });
  check('Reset password tanpa flag reset ditolak (400)', r.status === 400, `status=${r.status}`);
  // Login lama gagal, login baru berhasil.
  const WR3 = new Client();
  r = await WR3.post('/api/auth/login', { email: 'lupa@test.local', password: 'lama12345' });
  check('Login password LAMA setelah reset ditolak (400)', r.status === 400, `status=${r.status}`);
  r = await WR3.post('/api/auth/login', { email: 'lupa@test.local', password: 'baru12345' });
  check('Login password BARU setelah reset berhasil', r.status === 200 && r.data.ok, `status=${r.status}`);
  // Kedaluwarsa: permintaan ketiga di-ACC lalu expires_at dimundurkan.
  r = await WR.post('/api/auth/forgot-password', { email: 'lupa@test.local' });
  check('Permintaan ketiga: 200 generik', r.status === 200 && r.data.message === genericMsg);
  r = await ADM.get('/api/admin/password-resets');
  const prId3 = r.data.requests.find((x) => x.status === 'pending')?.id;
  r = await ADM.post(`/api/admin/password-resets/${prId3}/decide`, { decision: 'accept' });
  check('Admin ACC permintaan ketiga', r.status === 200 && r.data.status === 'approved');
  {
    const dbW = new DatabaseSync(DB_PATH);
    dbW.prepare("UPDATE password_resets SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, prId3);
    dbW.close();
  }
  r = await anon.get('/api/auth/forgot-password/status?email=lupa@test.local');
  check('Status setelah kedaluwarsa: approved=false', r.data.approved === false, JSON.stringify(r.data));
  r = await anon.post('/api/auth/reset-login', { email: 'lupa@test.local' });
  check('Reset-login setelah kedaluwarsa ditolak (400)', r.status === 400, `status=${r.status}`);
  // Jejak audit di admin_actions: 2 ACC + 1 TOLAK.
  {
    const dbW = new DatabaseSync(DB_PATH);
    const acc = dbW.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'password_reset_accept'").get();
    const rej = dbW.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'password_reset_reject'").get();
    check('Log admin: 2 accept tercatat', Number(acc.n) === 2, `n=${acc.n}`);
    check('Log admin: 1 reject tercatat', Number(rej.n) === 1, `n=${rej.n}`);
    dbW.close();
  }

  setDayO(1);

  dbS6.close();

  dbN.close();

  stop();
  console.log(`\n[e2e] SELESAI: ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[e2e] ERROR:', e); process.exit(1); });
