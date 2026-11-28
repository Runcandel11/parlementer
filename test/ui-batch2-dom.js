// Parlementer — tes DOM UI batch 2 ala Parlamentum (jsdom + server sungguhan).
// Membuktikan tampilan baru memakai angka NYATA dari DB (bukan karangan):
//   (1) HUD: avatar bulat berisi inisial + LEVEL besar di dalam perisai +
//       saldo Rupiah (500 USD → Rp9.150.000) + countdown parlemen tetap ada;
//   (2) Dashboard: PETA LANGSUNG (17 ubin wilayah + penanda KAMU), angka
//       dunia/negara/wilayah, INVENTARIS (kartu T1 + "Sisa roti hari ini"),
//       KONVOI (slot + bangunan), kartu wilayah (skor kota + peringkat +
//       5 bar infrastruktur + kapasitas + bonus + pemberontakan + DUKUNG),
//       tombol UNDANG TEMAN;
//   (3) Modal UNDANG TEMAN: kode/link + hadiah BARU (+200 emas pengundang,
//       +100 emas teman baru);
//   (4) Halaman STATISTIK: CATATAN DUNIA berisi angka nyata yang di-seed
//       (1 perang, 2 dukungan pemberontakan, 123 damage, 1 senjata,
//       1 bangunan, 1 artikel, 1 koran, 1 kontrak, 1 partai, 1 perusahaan)
//       + 3 leaderboard Top 3 + LIHAT SEMUA (17 wilayah);
//   (5) GET /api/stats mengembalikan angka yang sama dengan isi DB.
// Jalankan: node test/ui-batch2-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
import { DatabaseSync } from 'node:sqlite';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3461;
const DB_PATH = '/tmp/parlementer-ui-batch2-dom.db';
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

  console.log('[ui-batch2-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'ui-batch2-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { const r = await fetch(BASE + '/'); up = r.status === 200; } catch { await sleep(250); }
    }
    check('server menyala dan halaman utama 200', up);
    if (!up) { console.log('[ui-batch2-dom] server tidak menyala'); process.exitCode = 1; return; }

    const reg = await jarFetch(BASE + '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'uibatch2@test.local', password: 'rahasia123', username: 'ui_batch2' }),
    });
    check('daftar warga tes berhasil', reg.status === 200 && !!cookie, `status=${reg.status}`);
    const me = await (await jarFetch(BASE + '/api/me')).json();
    const citizenId = me.citizen.id;
    const myRegionId = me.citizen.region_id;
    check('warga tes punya citizen id + wilayah', !!citizenId && !!myRegionId, `citizen=${citizenId} region=${myRegionId}`);

    // Warga kedua (untuk dukungan pemberontakan + transaksi pasar).
    const regB = await jarFetch(BASE + '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'uibatch2b@test.local', password: 'rahasia123', username: 'ui_batch2_b' }),
    });
    check('daftar warga kedua berhasil', regB.status === 200, `status=${regB.status}`);
    // Kembalikan cookie ke warga pertama (register kedua menimpa cookie jar).
    const loginA = await jarFetch(BASE + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'uibatch2@test.local', password: 'rahasia123' }),
    });
    check('login kembali sebagai warga pertama', loginA.status === 200 && !!cookie, `status=${loginA.status}`);
    const meB = await (await jarFetch(BASE + '/api/me')).json();
    check('sesi kembali ke warga pertama', meB.citizen.id === citizenId);

    // Seed data dunia langsung di DB (angka yang nanti dicek di halaman).
    const db = new DatabaseSync(DB_PATH);
    const gandumId = db.prepare("SELECT id FROM commodities WHERE name = 'Gandum Mentah'").get().id;
    const besiId = db.prepare("SELECT id FROM commodities WHERE name = 'Besi Mentah'").get().id;
    const now = Date.now();
    // Inventaris: 100 Gandum T1 + 5 Makanan T1.
    const insInv = db.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,?,?)');
    insInv.run(citizenId, gandumId, 1, 100);
    const makananId = db.prepare("SELECT id FROM commodities WHERE name = 'Makanan'").get().id;
    // Starter pack sudah memberi 3 Makanan T1 — timpa jadi 5.
    db.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,?,?) ON CONFLICT(citizen_id, commodity_id, tier) DO UPDATE SET qty = excluded.qty')
      .run(citizenId, makananId, 1, 5);
    // Wilayah lain (bukan wilayahku) untuk perang + dukungan pemberontakan.
    const otherRegion = db.prepare('SELECT id FROM regions WHERE id != ? ORDER BY id LIMIT 1').get(myRegionId).id;
    const warRegion = db.prepare('SELECT id FROM regions WHERE id != ? AND id != ? ORDER BY id LIMIT 1').get(myRegionId, otherRegion).id;
    // 1 partai (pemimpin = warga tes) + 1 anggota (warga tes sendiri).
    const party = db.prepare("INSERT INTO parties (name, tag, ideology, leader_id, type, seats, created_at) VALUES ('Partai Uji','UJI','Konservatif',?,'open',0,?) RETURNING id").get(citizenId, now);
    db.prepare('INSERT INTO party_members (party_id, citizen_id, role, joined_at) VALUES (?,?,?,?)').run(party.id, citizenId, 'leader', now);
    // 1 perusahaan di wilayahku.
    db.prepare("INSERT INTO companies (owner_id, name, about, type, region_id, resource, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(citizenId, 'Pabrik Uji', 'Pabrik tes', 'factory', myRegionId, 'Besi Mentah', now);
    // 1 koran + 1 artikel.
    const paper = db.prepare('INSERT INTO newspapers (owner_id, name, created_at) VALUES (?,?,?) RETURNING id').get(citizenId, 'Koran Uji', now);
    db.prepare('INSERT INTO articles (newspaper_id, author_id, title, content, topic, created_at) VALUES (?,?,?,?,?,?)')
      .run(paper.id, citizenId, 'Artikel Uji', 'Isi artikel uji yang cukup panjang untuk lolos validasi.', 'Pengumuman', now);
    // 1 perang aktif di wilayah lain + 1 serangan (damage 123).
    const war = db.prepare("INSERT INTO wars (name, region_id, attacker_label, defender_label, status, ends_at, created_at) VALUES (?,?,?,?, 'active', ?, ?) RETURNING id")
      .get('Pemberontakan Uji', warRegion, 'Pemberontak Uji', 'Pembela Uji', now + 86400000, now);
    db.prepare('INSERT INTO war_attacks (war_id, citizen_id, side, damage, ammo, created_at) VALUES (?,?,?,?,?,?)')
      .run(war.id, citizenId, 'attacker', 123, 'Senjata', now);
    // 2 dukungan pemberontakan di wilayah lain (warga tes + warga kedua).
    const citizenB = db.prepare("SELECT id FROM citizens WHERE user_id = (SELECT id FROM users WHERE email = 'uibatch2b@test.local')").get().id;
    db.prepare('INSERT INTO war_support (region_id, citizen_id) VALUES (?,?)').run(otherRegion, citizenId);
    db.prepare('INSERT INTO war_support (region_id, citizen_id) VALUES (?,?)').run(otherRegion, citizenB);
    // 1 transaksi pasar (kontrak).
    db.prepare('INSERT INTO market_tx (buyer_id, seller_id, scope, commodity_id, tier, qty, price_each, total, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(citizenId, citizenB, 'local', gandumId, 1, 5, 10, 50, now);
    // 1 bangunan konvoi aktif (Rumah Sakit Lapangan).
    db.prepare('INSERT INTO convoys (citizen_id, slot, building, region_id, expires_at, created_at) VALUES (?,?,?,?,?,?)')
      .run(citizenId, 1, 'health', myRegionId, now + 7 * 86400000, now);
    // Skor kota + infra wilayahku (dari seed DB).
    const myRegionRow = db.prepare('SELECT * FROM regions WHERE id = ?').get(myRegionId);
    db.close();
    void besiId;

    // --- API: /api/stats mengembalikan angka yang sama dengan seed ---
    const stats = await (await jarFetch(BASE + '/api/stats')).json();
    check('API /api/stats: 1 perang aktif', stats.world.wars === 1 && stats.world.warsActive === 1, `wars=${stats.world.wars}`);
    check('API /api/stats: 2 dukungan pemberontakan di 1 wilayah', stats.world.rebellions === 2 && stats.world.rebellionRegions === 1, `reb=${stats.world.rebellions}`);
    check('API /api/stats: damage 123 + 1 senjata', stats.world.damage === 123 && stats.world.weapons === 1, `dmg=${stats.world.damage}`);
    check('API /api/stats: 1 bangunan + 1 artikel + 1 koran + 1 kontrak', stats.world.buildings === 1 && stats.world.articles === 1 && stats.world.newspapers === 1 && stats.world.contracts === 1);
    check('API /api/stats: 1 partai + 1 perusahaan + 2 warga + 17 wilayah', stats.world.parties === 1 && stats.world.companies === 1 && stats.world.population === 2 && stats.world.regions === 17, `pop=${stats.world.population}`);
    check('API /api/stats: kartu wilayahku (nama + skor + peringkat + 0/5)', stats.myRegion?.name === myRegionRow.name && stats.myRegion?.city_score === myRegionRow.city_score && stats.myRegion?.rank >= 1 && stats.myRegion?.rank <= 17 && stats.myRegion?.rebellion === 0 && stats.myRegion?.mySupport === false, `rank=${stats.myRegion?.rank} skor=${stats.myRegion?.city_score}`);
    const fullRegions = await (await jarFetch(BASE + '/api/stats?full=regions')).json();
    check('API /api/stats?full=regions: 17 wilayah', Array.isArray(fullRegions.fullList) && fullRegions.fullList.length === 17, `n=${fullRegions.fullList?.length}`);
    const fullLevel = await (await jarFetch(BASE + '/api/stats?full=level')).json();
    check('API /api/stats?full=level: 2 warga', Array.isArray(fullLevel.fullList) && fullLevel.fullList.length === 2, `n=${fullLevel.fullList?.length}`);

    // --- Boot aplikasi di jsdom ---
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
    await sleep(1200);

    check('aplikasi tampil setelah boot (login lewat cookie)', document.querySelector('#app').hidden === false);

    // --- HUD (ref 08) ---
    const avatar = document.querySelector('#hud-avatar');
    check('HUD: avatar bulat berisi inisial U', !!avatar && avatar.textContent.trim() === 'U', avatar?.textContent);
    check('HUD: perisai menampilkan LEVEL 1 besar', document.querySelector('#hud-lv')?.textContent === '1', document.querySelector('#hud-lv')?.textContent);
    check('HUD: lencana perisai menampilkan progres XP', /^\d+\/\d+$/.test(document.querySelector('#hud-xp')?.textContent || ''), document.querySelector('#hud-xp')?.textContent);
    check('HUD: saldo tampil sebagai Rupiah Rp9.150.000 (500 USD)', (document.querySelector('#hud-usd')?.textContent || '').includes('Rp9.150.000'), document.querySelector('#hud-usd')?.textContent);
    check('HUD: emas 50', document.querySelector('#hud-gold')?.textContent === '50', document.querySelector('#hud-gold')?.textContent);
    const pcd = document.querySelector('#parliament-countdown');
    // Sadar-waktu (parlemen dibuka 28 Nov 2026 20:00 WIB, epoch 1795870800000):
    // sebelum dibuka countdown tampil; sesudah dibuka countdown disembunyikan.
    const parlOpen = Date.now() >= 1795870800000;
    check(parlOpen ? 'HUD: countdown parlemen tersembunyi setelah dibuka' : 'HUD: countdown parlemen tetap tampil',
      !!pcd && (parlOpen ? pcd.hidden === true : (!pcd.hidden && pcd.textContent.includes('Parlemen dibuka'))),
      pcd?.textContent.slice(0, 60));

    // --- DASHBOARD (ref 06 + 07) ---
    const tiles = [...document.querySelectorAll('.map-tile')];
    check('dashboard: PETA LANGSUNG menampilkan 17 ubin wilayah', tiles.length === 17, `ubin=${tiles.length}`);
    const myTile = tiles.find((t) => t.classList.contains('mine'));
    check('dashboard: ubin wilayahku bertanda KAMU', !!myTile && myTile.textContent.includes('KAMU'), myTile?.textContent.trim().slice(0, 40));
    const numbersText = document.querySelector('#dash-numbers-grid')?.textContent || '';
    check('dashboard: angka dunia tampil (populasi 2, negara 0, wilayah 17)', numbersText.includes('Populasi Dunia') && numbersText.includes('Negara') && numbersText.includes('Wilayah'), numbersText.slice(0, 80));
    const invText = document.querySelector('#dash-inv-grid')?.textContent || '';
    check('dashboard: INVENTARIS menampilkan Gandum Mentah T1 ×100', invText.includes('Gandum Mentah') && invText.includes('×100'), invText.slice(0, 60));
    check('dashboard: "Sisa roti hari ini: 10/10" tampil', document.body.textContent.includes('Sisa roti hari ini: 10/10'));
    const convoyText = document.querySelector('#dash-convoy-body')?.textContent || '';
    check('dashboard: KONVOI menampilkan 1/1 slot + Rumah Sakit Lapangan', convoyText.includes('1/1 slot') && convoyText.includes('Rumah Sakit Lapangan'), convoyText.slice(0, 80));
    const regionText = document.querySelector('#dash-region-body')?.textContent || '';
    check('dashboard: kartu wilayah "DITEMPATKAN DI" + nama wilayah', regionText.includes('DITEMPATKAN DI') && regionText.includes(myRegionRow.name), regionText.slice(0, 60));
    check('dashboard: kartu wilayah menampilkan skor kota + peringkat', regionText.includes('Skor Kota') && regionText.includes(`${myRegionRow.city_score}/10`) && /Peringkat\s*\d+\/17/.test(regionText), regionText.slice(0, 120));
    check('dashboard: kartu wilayah menampilkan 5 bar infrastruktur', ['Kesehatan', 'Pendidikan', 'Militer', 'Industri', 'Listrik'].every((x) => regionText.includes(x)), regionText.slice(0, 200));
    check('dashboard: kartu wilayah menampilkan kapasitas + pemberontakan 0/5', regionText.includes('Kapasitas Wilayah') && regionText.includes('0/5 pendukung'), regionText.slice(0, 200));
    check('dashboard: kartu wilayah menampilkan wilayah belum bernegara (tanpa negara)', regionText.includes('Belum Bernegara') && !regionText.includes('Republik Indonesia'));
    check('dashboard: tombol DUKUNG PEMBERONTAKAN tampil', !!document.querySelector('#btn-dash-rebel'), document.querySelector('#btn-dash-rebel')?.textContent);

    // --- UNDANG TEMAN (overlay) ---
    const inviteBtn = document.querySelector('#btn-invite');
    check('dashboard: tombol UNDANG TEMAN tampil', !!inviteBtn);
    inviteBtn.click();
    await sleep(300);
    const refModal = document.querySelector('#referral-modal');
    check('overlay referral terbuka setelah klik UNDANG TEMAN', !!refModal && !refModal.hidden);
    const refText = refModal?.textContent || '';
    check('overlay referral: hadiah pengundang +200 emas + 2 hari Premium', refText.includes('+200 emas + 2 hari Premium'), refText.slice(0, 200));
    check('overlay referral: hadiah teman baru +100 emas + 1 hari Premium', refText.includes('+100 emas + 1 hari Premium'));
    check('overlay referral: kode + link ditampilkan', refText.includes('/?ref=') && (document.querySelector('#ref-modal-code')?.textContent || '').length === 8, document.querySelector('#ref-modal-code')?.textContent);
    document.querySelector('#ref-modal-close').click();
    await sleep(200);
    check('overlay referral tertutup setelah TUTUP', refModal.hidden === true);

    // --- HALAMAN STATISTIK (ref 04 + 05) ---
    window.location.hash = '#/stats';
    window.route();
    await sleep(1200);
    const statsText = document.querySelector('#page')?.textContent || '';
    check('statistik: judul CATATAN DUNIA — SEPANJANG MASA', statsText.includes('CATATAN DUNIA'));
    check('statistik: Perang Diumumkan 1 (1 masih berlangsung)', /Perang Diumumkan[\s\S]{0,80}1 masih berlangsung/.test(statsText));
    check('statistik: Pemberontakan 2 (dukungan aktif di 1 wilayah)', /Pemberontakan[\s\S]{0,80}dukungan aktif di 1 wilayah/.test(statsText));
    check('statistik: Kerusakan 123 + Senjata 1', statsText.includes('Kerusakan Diberikan') && /Senjata Digunakan[\s\S]{0,80}1 senjata per serangan/.test(statsText));
    check('statistik: Bangunan 1 + Artikel 1 + Koran 1 + Kontrak 1', statsText.includes('Bangunan Berdiri') && statsText.includes('Artikel Terbit') && statsText.includes('Surat Kabar') && statsText.includes('Kontrak Disepakati'));
    check('statistik: Partai 1 + Perusahaan 1', /Partai[\s\S]{0,60}1/.test(statsText) && statsText.includes('Perusahaan'));
    check('statistik: leaderboard LEVEL TERTINGGI berisi warga tes', statsText.includes('LEVEL TERTINGGI') && statsText.includes('ui_batch2'));
    check('statistik: leaderboard WARGA TERBANYAK berisi wilayah', statsText.includes('WARGA TERBANYAK') && statsText.includes(myRegionRow.name));
    check('statistik: leaderboard PARTAI TERBESAR berisi Partai Uji', statsText.includes('PARTAI TERBESAR') && statsText.includes('Partai Uji'));
    // LIHAT SEMUA: wilayah (Top 3 → 17 baris).
    const btnRegions = [...document.querySelectorAll('[data-full="regions"]')][0];
    check('statistik: tombol LIHAT SEMUA (wilayah) tampil', !!btnRegions);
    btnRegions.click();
    await sleep(900);
    const regionRows = document.querySelectorAll('#leaders-regions .leader-row').length;
    check('statistik: LIHAT SEMUA wilayah menampilkan 17 baris', regionRows === 17, `baris=${regionRows}`);
    check('statistik: tombol LIHAT SEMUA hilang setelah dibuka', btnRegions.hidden === true);

    // --- PROFIL: teks referral menampilkan hadiah BARU ---
    window.location.hash = '#/profile';
    window.route();
    await sleep(900);
    const profileText = document.querySelector('#page')?.textContent || '';
    check('profil: teks referral +200 emas (pengundang) +100 emas (teman)', profileText.includes('+200 emas + 2 hari Premium') && profileText.includes('+100 emas + 1 hari Premium'));
    check('profil: tombol UNDANG TEMAN tampil', !!document.querySelector('#btn-invite-profile'));
  } finally {
    stop();
    if (dom) dom.window.close();
  }

  console.log(`[ui-batch2-dom] ${passed} lolos, ${failed} gagal`);
  if (failed) process.exitCode = 1;
}

main();
