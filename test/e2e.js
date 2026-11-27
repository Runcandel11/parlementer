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
  r = await A.post('/api/regions/move', { region_id: jakarta.id });
  check('Pindah kewarganegaraan ke Jakarta berhasil (sedang di sana)', r.status === 200 && r.data.region === 'Jakarta', `status=${r.status} ${r.data.error || ''}`);
  const meA9b = (await A.get('/api/me')).data;
  check('Kewarganegaraan kini Jakarta', meA9b.citizen.home_region_id === jakarta.id, `home=${meA9b.homeRegion?.name}`);
  check('Negara mengikuti kewarganegaraan baru (Jakarta merdeka → tanpa negara)', meA9b.country === null, JSON.stringify(meA9b.country));
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
  r = await A.post('/api/regions/move', { region_id: jakarta.id });
  check('Pindah ke wilayah yang tidak didiami ditolak (400)', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  // Pindah saat transit ditolak: mulai perjalanan ke Jakarta, coba pindah
  // sebelum tiba. Tiket awal A (3) sudah habis dipakai 3 perjalanan
  // sebelumnya — tambah 1 Tiket lewat DB tes agar perjalanan uji ini bisa
  // dimulai.
  const db9t = new DatabaseSync(DB_PATH);
  const tiketId9 = db9t.prepare("SELECT id FROM commodities WHERE name = 'Tiket'").get().id;
  db9t.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,1) ON CONFLICT (citizen_id, commodity_id, tier) DO UPDATE SET qty = qty + 1').run(meA9b.citizen.id, tiketId9);
  db9t.close();
  r = await A.post('/api/regions/travel', { region_id: jakarta.id });
  check('A bepergian lagi ke Jakarta (untuk uji pindah saat transit)', r.status === 200, `status=${r.status}`);
  r = await A.post('/api/regions/move', { region_id: jakarta.id });
  check('Pindah kewarganegaraan saat transit ditolak (400)', r.status === 400, `status=${r.status} ${r.data.error || ''}`);
  const db9d = new DatabaseSync(DB_PATH);
  db9d.prepare('UPDATE citizens SET travel_arrives_at = ? WHERE id = ?').run(Date.now() - 1000, meA9b.citizen.id);
  db9d.close();
  r = await A.get('/api/me');
  check('A tiba di Jakarta; kewarganegaraan tetap wilayah asal (bukan Jakarta)', r.data.region.name === 'Jakarta' && r.data.citizen.home_region_id === homeBefore, `region=${r.data.region.name} home=${r.data.homeRegion?.name}`);

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

  console.log('\n[25] Jeda latihan (cooldown 2 menit × level atribut baru)');
  // Pakai A (tanpa daftar baru — pendaftaran di akhir suite kena
  // rate-limit 429): A belum pernah melatih Pendidikan/Ekonomi, jadi
  // keduanya tanpa jeda. Seksi ini terakhir, jadi perubahan emas/XP A
  // tidak memengaruhi asersi lain.
  r = await A.get('/api/me');
  const cdA0 = r.data.citizen.trainCooldowns || {};
  check('/api/me: trainCooldowns Pendidikan & Ekonomi 0 sebelum dilatih', cdA0.strategy?.remainingMs === 0 && cdA0.charisma?.remainingMs === 0, JSON.stringify(cdA0));
  r = await A.post('/api/train', { attr: 'edu' });
  check('A latih Pendidikan → LV 1 (biaya 1 emas, jeda 2 mnt)', r.status === 200 && r.data.cost === 1 && r.data.level === 1 && r.data.cooldownMs === 120000, `status=${r.status} cooldownMs=${r.data.cooldownMs} ${r.data.error || ''}`);
  r = await A.post('/api/train', { attr: 'edu' });
  check('Latih Pendidikan 2× beruntun ditolak 400 (masih jeda)', r.status === 400 && /jeda/i.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);
  check('Pesan 400 menyebut sisa waktu (mnt/dtk)', /mnt|dtk/.test(r.data.error || ''), r.data.error || '');
  r = await A.get('/api/me');
  const cdA = r.data.citizen.trainCooldowns || {};
  check('/api/me: trainCooldowns.strategy sisa > 0 dan ≤ 2 mnt', cdA.strategy?.remainingMs > 0 && cdA.strategy.remainingMs <= 120000, JSON.stringify(cdA.strategy));
  check('/api/me: trainCooldowns.charisma masih 0 (belum dilatih)', cdA.charisma?.remainingMs === 0, JSON.stringify(cdA));
  r = await A.post('/api/train', { attr: 'eco' });
  check('Atribut lain (Ekonomi) tetap bisa dilatih saat Pendidikan jeda', r.status === 200 && r.data.level === 1 && r.data.cooldownMs === 120000, `status=${r.status} ${r.data.error || ''}`);
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
  check('Foto hero profil tampil 144px (dulu 96px)', jsText.includes('avatarHtml(pr.avatar, pr.username, 144)'));
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
  const dbL = new DatabaseSync(DB_PATH);
  dbL.prepare('UPDATE citizens SET energy = 50 WHERE id = ?').run(meL.citizen.id);
  dbL.close();
  r = await L.post('/api/jobs/shift');
  const expect50 = Math.floor(baseQty * 0.5);
  const got50 = r.data.goods ? Number(String(r.data.goods).split('×')[0]) : -1;
  check(`Shift 50 energi: dibayar ~50% (${expect50}× ${jobL.resource})`, r.status === 200 && got50 >= expect50 - 1 && got50 <= expect50 + 1, `goods=${r.data.goods} energyUsed=${r.data.energyUsed}`);
  check('Respons shift 50 energi: energyUsed 50, energyPct 50', r.data.energyUsed === 50 && r.data.energyPct === 50, `energyUsed=${r.data.energyUsed} energyPct=${r.data.energyPct}`);
  const dbL2 = new DatabaseSync(DB_PATH);
  dbL2.prepare('UPDATE citizens SET energy = 1 WHERE id = ?').run(meL.citizen.id);
  dbL2.close();
  r = await L.post('/api/jobs/shift');
  const got1 = r.data.goods ? Number(String(r.data.goods).split('×')[0]) : -1;
  check('Shift 1 energi: dibayar ~1% (maks 1 unit, bukan penuh)', r.status === 200 && got1 <= 1, `goods=${r.data.goods}`);
  check('Respons shift 1 energi: energyUsed 1, energyPct 1', r.data.energyUsed === 1 && r.data.energyPct === 1, `energyUsed=${r.data.energyUsed}`);
  const dbL3 = new DatabaseSync(DB_PATH);
  dbL3.prepare('UPDATE citizens SET energy = 0 WHERE id = ?').run(meL.citizen.id);
  dbL3.close();
  r = await L.post('/api/jobs/shift');
  check('Shift dengan energi 0 ditolak (400)', r.status === 400, `status=${r.status}`);
  const meL2 = (await L.get('/api/me')).data.citizen;
  check('Shift sebagian: XP tetap 0 (XP hanya untuk shift penuh)', meL2.xp === 0, `xp=${meL2.xp}`);
  check('Shift sebagian: counter shift tetap naik (2 giliran)', meL2.shifts === 2, `shifts=${meL2.shifts}`);
  const dbL4 = new DatabaseSync(DB_PATH);
  const chronL = dbL4.prepare('SELECT chronicle_done FROM citizens WHERE id = ?').get(meL.citizen.id).chronicle_done;
  dbL4.close();
  check('Shift sebagian TIDAK menyelesaikan tugas Kronik shift (anti-exploit)', !JSON.parse(chronL).includes('shift'), `chronicle_done=${chronL}`);

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

  stop();
  console.log(`\n[e2e] SELESAI: ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[e2e] ERROR:', e); process.exit(1); });
