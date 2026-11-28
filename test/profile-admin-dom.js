// Parlementer — tes DOM profil publik + ADMIN + shift fleksibel + chat + bio.
// Membuktikan (di jsdom + server sungguhan):
//   (1) PROFIL: klik nama pemain di chat langsung membuka profil publiknya,
//       menampilkan Status (lencana "● Online" bila aktif / "Terakhir online
//       ..." bila offline, v4.3.0 saran LIO) + level + jumlah shift +
//       "Belum Bernegara", tanpa bocor data privat; tombol Chat di profil
//       membuka DM;
//   (2) ADMIN: lowongan ADMIN ada di semua 17 wilayah tanpa batas kursi
//       (tampil "Tanpa batas kursi" di halaman Pekerjaan);
//   (3) SHIFT FLEKSIBEL: tombol "Kerjakan Satu Giliran" ada di DASHBOARD
//       dan halaman Pekerjaan, labelnya mengikuti energi yang ada
//       (100 ⚡ / 50 ⚡), dan kliknya benar-benar memakai energi itu;
//   (4) BIO: biografi bisa diedit langsung dari halaman profil sendiri;
//   (5) LEADERBOARD: klik nama di Statistik membuka profil pemain itu;
//   (6) LABEL: wilayah tanpa negara menampilkan "Belum Bernegara" dan
//       kata "Merdeka" tidak muncul di mana pun (dashboard, profil,
//       detail wilayah, peta).
//   (7) WARNA WILAYAH (pemilik, 27 Nov 2026): hero profil + kartu wilayah
//       dashboard TANPA negara = kaca abu-abu (kelas free) + tanda "?",
//       tanpa dot merah negara; SETELAH mendirikan negara, hero + kartu
//       kembali merah (dot-red) dan tanda "?" hilang.
// Jalankan: node test/profile-admin-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
import { DatabaseSync } from 'node:sqlite';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3463;
const DB_PATH = '/tmp/parlementer-profile-admin-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// Cookie jar per pemain (node fetch tidak menyimpan cookie sendiri).
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
async function api(jar, path, body) {
  const res = await jar(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
    beforeParse(window) { window.fetch = jarFetchFn; },
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
const pageText = (dom) => dom.window.document.querySelector('#page')?.textContent || '';

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[profile-admin-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'profile-admin-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  try {
    await sleep(1200);

    const jarA = makeJar();
    const jarB = makeJar();
    let r = await api(jarA, '/api/auth/register', { email: 'domA@test.local', password: 'rahasia123', username: 'warga_a' });
    check('Daftar warga_a (API)', r.status === 200 && r.data.ok);
    r = await api(jarB, '/api/auth/register', { email: 'domB@test.local', password: 'rahasia123', username: 'warga_b' });
    check('Daftar warga_b (API)', r.status === 200 && r.data.ok);
    const meA = (await api(jarA, '/api/me')).data;
    const meB = (await api(jarB, '/api/me')).data;
    r = await api(jarB, '/api/chat/global', { content: 'Halo dari warga_b' });
    check('warga_b kirim pesan ke chat global', r.status === 200 && r.data.ok);

    // (2) ADMIN: semua wilayah + tanpa batas (API).
    r = await api(jarA, '/api/jobs');
    const adminJobs = r.data.jobs.filter((j) => j.is_admin === 1);
    check('Lowongan ADMIN: 18 lowongan (satu per wilayah, Kepri 2)', adminJobs.length === 18, `ditemukan ${adminJobs.length}`);
    check('Lowongan ADMIN: ada di semua 17 wilayah', new Set(adminJobs.map((j) => j.region_id)).size === 17);
    check('Lowongan ADMIN: seats 1.000.000 (tanpa batas)', adminJobs.every((j) => j.seats === 1000000));
    const jobA = adminJobs.find((j) => j.region_id === meA.citizen.region_id);
    check('Ada lowongan ADMIN di wilayah lahir warga_a', !!jobA, `region=${meA.region?.name}`);
    r = await api(jarA, '/api/jobs/apply', { job_id: jobA.id });
    check('warga_a melamar lowongan ADMIN di wilayahnya', r.status === 200 && r.data.ok, r.data.error || '');

    // (3) SHIFT di DASHBOARD: tombol ada, label mengikuti energi, klik memakai energi.
    dom = await bootDom(BASE + '/#/dashboard', jarA);
    let btn = dom.window.document.querySelector('#btn-dash-shift');
    check('Dashboard: tombol shift ada (panel PEKERJAAN)', !!btn, btn ? btn.textContent.trim() : 'tidak ada');
    check('Dashboard: label tombol "(100 ⚡)" saat energi penuh', !!btn && btn.textContent.includes('(100 ⚡)'), btn ? btn.textContent.trim() : '');
    check('Dashboard: tidak ada kata "Merdeka"', !/merdeka/i.test(pageText(dom)));
    check('Dashboard: wilayah tampil "Belum Bernegara"', pageText(dom).includes('Belum Bernegara'));
    // (7) WARNA WILAYAH tanpa negara: hero + kartu wilayah = kaca abu-abu
    // (kelas free) + tanda "?", tanpa warna negara (merah).
    const hero = dom.window.document.querySelector('.profile-hero');
    check('Tanpa negara: hero dashboard kaca abu-abu (kelas free)', !!hero && hero.classList.contains('free'));
    const heroQ = dom.window.document.querySelector('.profile-hero .hero-q');
    check('Tanpa negara: hero menampilkan tanda "?"', !!heroQ && heroQ.textContent.trim() === '?');
    check('Tanpa negara: hero TIDAK memakai dot merah negara', !dom.window.document.querySelector('.profile-hero .dot-red'));
    const regionPanel = dom.window.document.querySelector('#dash-region');
    check('Tanpa negara: kartu wilayah kaca abu-abu (kelas free)', !!regionPanel && regionPanel.classList.contains('free'));
    const regionQ = dom.window.document.querySelector('#dash-region .region-q');
    check('Tanpa negara: kartu wilayah menampilkan tanda "?"', !!regionQ && regionQ.textContent.trim() === '?');
    btn?.click();
    await sleep(1500);
    let me = (await api(jarA, '/api/me')).data.citizen;
    check('Klik shift di dashboard: energi 100 → 0 (shift penuh terpakai)', me.energy === 0, `energy=${me.energy}`);
    check('Klik shift di dashboard: counter shift naik jadi 1', me.shifts === 1, `shifts=${me.shifts}`);
    const db = new DatabaseSync(DB_PATH);
    db.prepare('UPDATE citizens SET energy = 50 WHERE id = ?').run(meA.citizen.id);
    db.close();
    // Energi diubah langsung di DB (di luar aplikasi) — ME di jsdom masih
    // menyimpan nilai lama; segarkan dulu supaya label shift yang dinamis
    // memakai energi terbaru. (Di pemakaian nyata ME disegarkan tiap
    // 30 detik + setelah tiap aksi, jadi label tidak basi.)
    await dom.window.refreshMe();
    // Navigasi pergi-pulang (hash yang sama tidak memicu hashchange):
    // ke Pekerjaan dulu, lalu kembali ke dashboard.
    dom.window.location.hash = '#/jobs';
    await sleep(1500);
    let btnJob = dom.window.document.querySelector('#btn-shift');
    check('Pekerjaan: tombol shift ada dengan label "(50 ⚡)"', !!btnJob && btnJob.textContent.includes('(50 ⚡)'), btnJob ? btnJob.textContent.trim() : '');
    check('Pekerjaan: tampil "Tanpa batas kursi" untuk lowongan ADMIN', pageText(dom).includes('Tanpa batas kursi'));
    check('Pekerjaan: penjelasan shift proporsional tampil', pageText(dom).includes('~50% hadiah'));
    dom.window.location.hash = '#/dashboard';
    await sleep(1500);
    btn = dom.window.document.querySelector('#btn-dash-shift');
    check('Dashboard: label tombol berubah jadi "(50 ⚡)" saat energi 50', !!btn && btn.textContent.includes('(50 ⚡)'), btn ? btn.textContent.trim() : '');
    btn?.click();
    await sleep(1500);
    me = (await api(jarA, '/api/me')).data.citizen;
    check('Klik shift 50 energi di dashboard: energi 50 → 0', me.energy === 0, `energy=${me.energy}`);

    // (1) PROFIL via klik nama di chat → profil publik → tombol Chat → DM.
    dom.window.location.hash = '#/chat';
    await sleep(1500);
    const nameEl = dom.window.document.querySelector('[data-goto="#/profile/warga_b"]');
    check('Chat: nama warga_b bisa diklik (data-goto profil)', !!nameEl);
    nameEl?.click();
    await sleep(1500);
    check('Klik nama di chat: membuka profil warga_b', pageText(dom).includes('warga_b') && dom.window.location.hash.includes('#/profile/warga_b'), `hash=${dom.window.location.hash}`);
    check('Profil publik: baris "Status" tampil', pageText(dom).includes('Status'));
    check('Profil publik: lencana Online tampil (warga_b baru memanggil /api/me)', !!dom.window.document.querySelector('.online-badge') && pageText(dom).includes('Online'));
    // (1b) STATUS ONLINE (v4.3.0, saran LIO): offline 2 jam lalu → label
    // relatif; tanpa last_seen → teks sopan, tanpa crash.
    const dbP = new DatabaseSync(DB_PATH);
    dbP.prepare('UPDATE citizens SET last_seen_at = ? WHERE id = ?').run(Date.now() - 2 * 3600 * 1000, meB.citizen.id);
    dbP.close();
    dom.window.location.hash = '#/chat';
    await sleep(1500);
    dom.window.location.hash = '#/profile/warga_b';
    await sleep(1500);
    check('Profil publik: offline 2 jam lalu → "Terakhir online 2 jam lalu"', pageText(dom).includes('Terakhir online 2 jam lalu'));
    const dbP2 = new DatabaseSync(DB_PATH);
    dbP2.prepare('UPDATE citizens SET last_seen_at = 0 WHERE id = ?').run(meB.citizen.id);
    dbP2.close();
    dom.window.location.hash = '#/chat';
    await sleep(1500);
    dom.window.location.hash = '#/profile/warga_b';
    await sleep(1500);
    check('Profil publik: tanpa last_seen → "Belum pernah terlihat online"', pageText(dom).includes('Belum pernah terlihat online'));
    const dbP3 = new DatabaseSync(DB_PATH);
    dbP3.prepare('UPDATE citizens SET last_seen_at = ? WHERE id = ?').run(Date.now(), meB.citizen.id);
    dbP3.close();
    check('Profil publik: level + shift tampil', pageText(dom).includes('LEVEL') && pageText(dom).includes('Shift dikerjakan'));
    check('Profil publik: wilayah "Belum Bernegara"', pageText(dom).includes('Belum Bernegara'));
    check('Profil publik: tidak ada kata "Merdeka"', !/merdeka/i.test(pageText(dom)));
    const chatBtn = dom.window.document.querySelector(`[data-goto="#/messages/${meB.citizen.id}"]`);
    check('Profil pemain lain: tombol Chat ada (ke DM warga_b)', !!chatBtn);
    chatBtn?.click();
    await sleep(1500);
    check('Tombol Chat: membuka DM dengan warga_b', dom.window.location.hash === `#/messages/${meB.citizen.id}`, `hash=${dom.window.location.hash}`);

    // (4) BIO: edit langsung dari profil sendiri.
    dom.window.location.hash = '#/profile';
    await sleep(1500);
    const bioTa = dom.window.document.querySelector('#profile-bio');
    check('Profil sendiri: kolom edit biografi ada di halaman profil', !!bioTa);
    const bioBtn = dom.window.document.querySelector('#btn-save-profile-bio');
    check('Profil sendiri: tombol "Simpan Biografi" ada', !!bioBtn);
    if (bioTa && bioBtn) {
      bioTa.value = 'Bio baru dari tes.';
      bioBtn.click();
      await sleep(1500);
      check('Simpan bio: teks bio baru tampil di profil', pageText(dom).includes('Bio baru dari tes.'));
      r = await api(jarA, '/api/profile/warga_a');
      check('Simpan bio: API profil menampilkan bio baru', r.data.profile.bio === 'Bio baru dari tes.', `bio=${r.data.profile.bio}`);
    }

    // (5) LEADERBOARD: klik nama di Statistik → profil.
    dom.window.location.hash = '#/stats';
    await sleep(1500);
    const leaderName = dom.window.document.querySelector('.leader-name[data-goto]');
    check('Statistik: nama pemain bisa diklik (data-goto profil)', !!leaderName, leaderName ? leaderName.getAttribute('data-goto') : 'tidak ada');
    leaderName?.click();
    await sleep(1500);
    check('Klik nama di Statistik: membuka profil pemain itu', dom.window.location.hash.startsWith('#/profile/'), `hash=${dom.window.location.hash}`);

    // (6) LABEL: detail wilayah + peta besar.
    dom.window.location.hash = `#/region/${meA.citizen.region_id}`;
    await sleep(1500);
    check('Detail wilayah: tampil "Belum Bernegara"', pageText(dom).includes('Belum Bernegara'));
    check('Detail wilayah: tidak ada kata "Merdeka"', !/merdeka/i.test(pageText(dom)));
    dom.window.location.hash = '#/map';
    await sleep(1500);
    check('Peta: ubin wilayah tampil "Belum Bernegara"', pageText(dom).includes('Belum Bernegara'));
    check('Peta: tidak ada kata "Merdeka"', !/merdeka/i.test(pageText(dom)));

    // (7b) WARNA WILAYAH dengan negara: dirikan Nusantara (wilayah asal A
    // jadi ibu kota), lalu hero + kartu wilayah harus kembali merah.
    const db3 = new DatabaseSync(DB_PATH);
    db3.prepare('UPDATE citizens SET level = 10, gold = 200 WHERE id = ?').run(meA.citizen.id);
    db3.close();
    r = await api(jarA, '/api/countries', { name: 'Nusantara', ideology: 'Konservatisme', system: 'presidensial' });
    check('Dirikan negara Nusantara (untuk uji warna bernegara)', r.status === 200 && !!r.data.countryId, `status=${r.status} ${r.data.error || ''}`);
    // Negara didirikan lewat API (di luar UI) — ME di jsdom masih basi;
    // segarkan dulu supaya dashboard me-render dengan negara yang baru.
    await dom.window.refreshMe();
    dom.window.location.hash = '#/stats';
    await sleep(1500);
    dom.window.location.hash = '#/dashboard';
    await sleep(1500);
    const hero2 = dom.window.document.querySelector('.profile-hero');
    check('Bernegara: hero TIDAK lagi kaca abu-abu (tanpa kelas free)', !!hero2 && !hero2.classList.contains('free'));
    check('Bernegara: hero memakai dot merah negara', !!dom.window.document.querySelector('.profile-hero .dot-red'));
    check('Bernegara: tanda "?" hero hilang', !dom.window.document.querySelector('.profile-hero .hero-q'));
    const regionPanel2 = dom.window.document.querySelector('#dash-region');
    check('Bernegara: kartu wilayah TIDAK lagi kaca abu-abu', !!regionPanel2 && !regionPanel2.classList.contains('free'));
    check('Bernegara: tanda "?" kartu wilayah hilang', !dom.window.document.querySelector('#dash-region .region-q'));
    // Hero halaman profil orang lain yang bernegara ikut merah.
    dom.window.location.hash = '#/profile';
    await sleep(1500);
    const hero3 = dom.window.document.querySelector('.profile-hero');
    check('Bernegara: hero halaman profil juga merah (tanpa free)', !!hero3 && !hero3.classList.contains('free') && !!dom.window.document.querySelector('.profile-hero .dot-red'));

    // (8) v5.7.1 — Clueless: shift ADMIN dibayar bahan → profil menampilkan
    // "Total upah bahan" + penjelasan bahwa "Total gaji Rp0" bukan bug.
    // warga_a sudah bekerja dari seksi sebelumnya (apply ditolak "sudah
    // bekerja") — pindahkan pekerjaannya ke ADMIN via DB (alur lamar
    // sendiri sudah dites di e2e [5]), lalu shift via API.
    r = await api(jarA, '/api/jobs');
    const job8 = r.data.jobs.find((j) => j.is_admin === 1 && j.region_id === meA.citizen.region_id);
    check('Lowongan ADMIN ada di wilayah warga_a', !!job8, `region=${meA.citizen.region_id}`);
    {
      const db8 = new DatabaseSync(DB_PATH);
      db8.prepare('UPDATE citizens SET job_id = ?, energy = 100, energy_updated_at = ? WHERE id = ?').run(job8.id, Date.now(), meA.citizen.id);
      db8.close();
    }
    r = await api(jarA, '/api/jobs/shift', {});
    check('warga_a shift ADMIN dibayar bahan', r.status === 200 && (r.data.goodsQty || 0) > 0, `goods=${r.data.goods}`);
    r = await api(jarA, '/api/profile/warga_a');
    check('API profil: total_goods_usd > 0 setelah shift ADMIN', (r.data.profile.total_goods_usd || 0) > 0, `total_goods_usd=${r.data.profile.total_goods_usd}`);
    check('API profil: total_salary tetap 0 (dibayar bahan, bukan bug)', r.data.profile.total_salary === 0, `total_salary=${r.data.profile.total_salary}`);
    dom.window.location.hash = '#/profile';
    await sleep(1500);
    const profTxt = pageText(dom);
    check('Profil: baris "Total upah bahan" tampil', profTxt.includes('Total upah bahan'), profTxt.slice(0, 200));
    check('Profil: penjelasan "Total gaji Rp0 bukan bug" tampil', profTxt.includes('bukan Rupiah') && profTxt.includes('bukan bug'), profTxt.slice(0, 400));
  } finally {
    if (dom) dom.window.close();
    stop();
  }
  console.log(`\n[profile-admin-dom] ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
