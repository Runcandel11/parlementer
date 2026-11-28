// Parlementer — tes DOM Pekerjaan menurut lokasi pemain.
// Membuktikan (di jsdom + server sungguhan):
//   (1) REGRESI KELUHAN PEMILIK (27 Nov 2026): halaman Pekerjaan dulu
//       menampilkan SEMUA pabrik/lowongan dari SEMUA wilayah, dan klik
//       lowongan wilayah lain berujung error 400 "tidak berada di wilayah
//       ini" — pola yang kemungkinan juga penyebab spam 400 yang sama
//       tiap ~30-60 detik di log server. Sekarang halaman default HANYA
//       menampilkan lowongan di WILAYAH pemain saat ini;
//   (2) LOWONGAN WILAYAH LAIN dipisah jelas: tersembunyi di balik tombol
//       "Tampilkan lowongan wilayah lain (N)"; setelah dibuka, kartunya
//       TIDAK punya tombol LAMAR — tombolnya "✈️ LIHAT WILAYAH" yang
//       mengarah ke detail wilayah (di sana ada tombol travel), jadi tidak
//       ada lagi klik yang berujung 400 membingungkan;
//   (3) ATURAN SERVER TIDAK BERUBAH: POST /api/jobs/apply lintas wilayah
//       tetap ditolak 400 (validasi terakhir di server tetap ada).
//   (4) LAMAR lowongan ADMIN di wilayah sendiri tetap berhasil lewat UI.
//   (5) v5.0.1 (laporan Vincent, Discord #bugs 28 Nov 2026): lowongan
//       perusahaan yang identik (perusahaan + judul + gaji + wilayah +
//       syarat sama) digabung jadi SATU kartu dengan kursi gabungan —
//       bukan 3 kartu kembar seperti 9 lowongan "Kerja" $100.000 kenzz
//       setelah di-clamp rollback v5.0.0.
// Jalankan: node test/jobs-region-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import pkg from 'jsdom';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3465;
const DB_PATH = '/tmp/parlementer-jobs-region-dom.db';
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
    .replace(/<link[^>]*fonts\.gstatic\.com[^>]*>/g, '');
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

  console.log('[jobs-region-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'jobs-region-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  try {
    await sleep(1200);

    const jar = makeJar();
    let r = await api(jar, '/api/auth/register', { email: 'domJob@test.local', password: 'rahasia123', username: 'warga_job' });
    check('Daftar warga_job (API)', r.status === 200 && r.data.ok);
    const me = (await api(jar, '/api/me')).data;
    const myRegionId = me.citizen.region_id;
    check('Pemain punya wilayah lahir', !!myRegionId && !!me.region?.name, `region=${me.region?.name}`);

    r = await api(jar, '/api/jobs');
    const allJobs = r.data.jobs;
    const localJobs = allJobs.filter((j) => j.region_id === myRegionId);
    const otherJobs = allJobs.filter((j) => j.region_id !== myRegionId);
    const adminLocal = localJobs.find((j) => j.is_admin === 1);
    check('Ada lowongan ADMIN di wilayah pemain', !!adminLocal, `lokal=${localJobs.length} lain=${otherJobs.length}`);
    check('Ada lowongan di wilayah lain (untuk dipisah)', otherJobs.length > 0, `lain=${otherJobs.length}`);

    // (3) Aturan server tidak berubah: lamar lintas wilayah tetap 400.
    const otherJob = otherJobs[0];
    r = await api(jar, '/api/jobs/apply', { job_id: otherJob.id });
    check('Server: lamar lintas wilayah TETAP ditolak 400', r.status === 400 && /wilayah/i.test(r.data.error || ''), `status=${r.status} ${r.data.error || ''}`);

    // --- DOM: halaman Pekerjaan ---
    dom = await bootDom(BASE + '/#/jobs', jar);
    const { document } = dom.window;

    // (1) Default: hanya lowongan wilayah sendiri yang tampil.
    const localCards = document.querySelectorAll('#jobs-local-list [data-job-region]');
    const localApply = document.querySelectorAll('#jobs-local-list [data-apply]');
    check('Default: daftar lokal berisi lowongan wilayah sendiri saja',
      localCards.length === localJobs.length && [...localCards].every((c) => Number(c.dataset.jobRegion) === myRegionId),
      `kartu lokal=${localCards.length} harapan=${localJobs.length}`);
    check('Default: kartu lokal punya tombol LAMAR', localApply.length > 0, `tombol LAMAR lokal=${localApply.length}`);
    check('Panel lokal berjudul DI WILAYAHMU + nama wilayah', pageText(dom).includes('DI WILAYAHMU') && pageText(dom).toUpperCase().includes(me.region.name.toUpperCase()));
    check('Statistik: jumlah lowongan wilayah sendiri tampil', pageText(dom).includes('Lowongan di Wilayahmu'));
    check('Halaman tidak lagi berjudul PAPAN LOWONGAN (daftar campur)', !pageText(dom).includes('PAPAN LOWONGAN'));

    // (6) v5.7.5 — kartu lowongan beranimasi + meter keterisian kursi.
    const jobCards = [...document.querySelectorAll('#jobs-local-list .job-card')];
    check('v5.7.5: tiap kartu lokal punya kelas job-card + indeks stagger --i',
      jobCards.length === localCards.length && jobCards.every((c, i) => c.style.getPropertyValue('--i') === String(i)),
      `job-card=${jobCards.length} harapan=${localCards.length}`);
    const adminCard = jobCards.find((c) => c.textContent.includes('ADMIN'));
    check('v5.7.5: kartu ADMIN tanpa batas kursi → tanpa meter kursi',
      !!adminCard && !adminCard.querySelector('.seat-bar'), adminCard ? 'kartu ADMIN ketemu' : 'kartu ADMIN tidak ketemu');
    const css = fs.readFileSync(ROOT + 'public/css/style.css', 'utf8');
    check('v5.7.5: CSS punya keyframes jobCardIn + stagger 50ms + hover lift',
      css.includes('@keyframes jobCardIn') && css.includes('calc(var(--i, 0) * 50ms)') && css.includes('.job-card:hover'));
    check('v5.7.5: CSS menghormati prefers-reduced-motion untuk kartu lowongan',
      css.includes('@media (prefers-reduced-motion: reduce) { .job-card { animation: none;'));

    // (2) Wilayah lain: tersembunyi di balik tombol, tanpa tombol LAMAR.
    const otherList = document.querySelector('#jobs-other-list');
    const toggleBtn = document.querySelector('#btn-jobs-other');
    check('Wilayah lain: daftar tersembunyi secara default', !!otherList && otherList.hidden === true);
    check('Wilayah lain: tombol tampilkan ada + menyebut jumlah', !!toggleBtn && toggleBtn.textContent.includes(`(${otherJobs.length})`), toggleBtn ? toggleBtn.textContent.trim() : 'tidak ada');
    const otherApply = document.querySelectorAll('#jobs-other-list [data-apply]');
    check('Wilayah lain: TIDAK ADA tombol LAMAR (tidak bisa 400)', otherApply.length === 0, `tombol LAMAR lain=${otherApply.length}`);
    const otherGo = document.querySelectorAll('#jobs-other-list [data-goto^="#/regions/"]');
    check('Wilayah lain: tiap kartu punya tombol LIHAT WILAYAH', otherGo.length === otherJobs.length, `tombol wilayah=${otherGo.length} harapan=${otherJobs.length}`);
    check('Wilayah lain: kartu menandai perlu travel', pageText(dom).includes('harus berada di sana untuk melamar'));

    // Buka daftar wilayah lain, lalu klik LIHAT WILAYAH pada satu kartu.
    toggleBtn?.click();
    await sleep(800);
    check('Klik tombol tampilkan: daftar wilayah lain muncul', otherList.hidden === false);
    check('Klik tombol tampilkan: label berubah jadi Sembunyikan', toggleBtn.textContent.includes('Sembunyikan'));
    const goBtn = document.querySelector('#jobs-other-list [data-goto^="#/regions/"]');
    const targetHash = goBtn?.getAttribute('data-goto');
    goBtn?.click();
    await sleep(1500);
    check('Klik LIHAT WILAYAH: pindah ke detail wilayah itu', dom.window.location.hash === targetHash, `hash=${dom.window.location.hash} harapan=${targetHash}`);
    check('Detail wilayah: tombol travel BEPERGIAN KE SINI ada', !!document.querySelector('#btn-travel'), pageText(dom).slice(0, 80));

    // (4) Kembali ke Pekerjaan, LAMAR lowongan ADMIN wilayah sendiri via UI.
    dom.window.location.hash = '#/jobs';
    await sleep(1500);
    const applyBtn = document.querySelector(`#jobs-local-list [data-apply="${adminLocal.id}"]`);
    check('Lokal: tombol LAMAR lowongan ADMIN wilayah sendiri ada', !!applyBtn);
    applyBtn?.click();
    await sleep(1500);
    const meAfter = (await api(jar, '/api/me')).data.citizen;
    check('Klik LAMAR lokal: lamaran diterima (job_id terisi)', meAfter.job_id === adminLocal.id, `job_id=${meAfter.job_id} harapan=${adminLocal.id}`);
    check('Setelah melamar: panel PEKERJAANMU tampil', pageText(dom).includes('PEKERJAANMU'));

    // (5) v5.0.1 — pengelompokan lowongan identik: seed 3 lowongan
    // perusahaan yang identik di wilayah sendiri → tampil sebagai SATU
    // kartu dengan kursi gabungan (bukan 3 kartu kembar).
    const dbJ = new DatabaseSync(DB_PATH);
    const meCitizenId = meAfter.id;
    dbJ.prepare(`INSERT INTO companies (id, owner_id, name, about, type, region_id, resource, created_at)
      VALUES (9001, ?, 'PT Kembar', '', 'resource', ?, 'Besi Mentah', 0)`).run(meCitizenId, myRegionId);
    for (let i = 0; i < 3; i++) {
      dbJ.prepare(`INSERT INTO jobs (id, company_id, is_admin, title, salary, salary_type, resource, pay_qty, level_min, tier, seats, seats_taken, region_id, description, created_at)
        VALUES (?, 9001, 0, 'Kerja', 100, 'fixed', '', 0, 1, 1, 4, 0, ?, 'uji grup v5.0.1', 0)`).run(9002 + i, myRegionId);
    }
    // v5.7.5 — meter kursi: 1 perusahaan + 1 lowongan 4 kursi, lalu 2 warga
    // lain melamar → meter harus terisi 2/4 = 50%.
    dbJ.prepare(`INSERT INTO companies (id, owner_id, name, about, type, region_id, resource, created_at)
      VALUES (9006, ?, 'PT Meter', '', 'resource', ?, 'Besi Mentah', 0)`).run(meCitizenId, myRegionId);
    dbJ.prepare(`INSERT INTO jobs (id, company_id, is_admin, title, salary, salary_type, resource, pay_qty, level_min, tier, seats, seats_taken, region_id, description, created_at)
      VALUES (9005, 9006, 0, 'Kerja Uji', 100, 'fixed', '', 0, 1, 1, 4, 0, ?, 'uji meter kursi v5.7.5', 0)`).run(myRegionId);
    dbJ.close();
    // Dua warga baru: pindahkan ke wilayah pemain (registrasi acak wilayah)
    // lalu lamar 'Kerja Uji' supaya kursinya terisi 2/4.
    for (let n = 2; n <= 3; n++) {
      const jarN = makeJar();
      const regN = await api(jarN, '/api/auth/register', { email: `domJob${n}@test.local`, password: 'rahasia123', username: `warga_job${n}` });
      check(`v5.7.5: daftar warga_job${n} (API)`, regN.status === 200 && regN.data.ok);
      const meN = (await api(jarN, '/api/me')).data.citizen;
      const dbN = new DatabaseSync(DB_PATH);
      dbN.prepare('UPDATE citizens SET region_id = ?, home_region_id = ? WHERE id = ?').run(myRegionId, myRegionId, meN.id);
      dbN.close();
      const applyN = await api(jarN, '/api/jobs/apply', { job_id: 9005 });
      check(`v5.7.5: warga_job${n} melamar 'Kerja Uji'`, applyN.status === 200 && applyN.data.ok, `status=${applyN.status} ${applyN.data.error || ''}`);
    }
    dom.window.route();
    await sleep(1500);
    const localCardsAfter = document.querySelectorAll('#jobs-local-list [data-job-region]');
    const twinCards = [...localCardsAfter].filter((el) => el.textContent.includes('Kerja') && el.textContent.includes('PT Kembar'));
    check('Lowongan identik: 3 lowongan "Kerja" tampil sebagai 1 kartu', twinCards.length === 1, `kartu kembar=${twinCards.length}`);
    const twin = twinCards[0];
    check('Kartu gabungan: menandai 3 lowongan digabung', !!twin && twin.getAttribute('data-group-size') === '3' && twin.textContent.includes('3 lowongan serupa digabung'), twin ? `group-size=${twin.getAttribute('data-group-size')}` : 'tidak ada kartu');
    check('Kartu gabungan: kursi dijumlahkan (0/12 kursi)', !!twin && /0\/12 kursi/.test(twin.textContent), twin ? twin.textContent.slice(0, 120) : 'tidak ada kartu');
    const twinApply = twin?.querySelector('[data-apply]');
    check('Kartu gabungan: tetap punya tombol LAMAR (ke lowongan berkursi kosong)', !!twinApply && ['9002', '9003', '9004'].includes(twinApply.getAttribute('data-apply')), twinApply?.getAttribute('data-apply') || 'tidak ada tombol');
    // v5.7.5 — meter kursi: kartu gabungan 0/12 → isi 0%; 'Kerja Uji' 2/4 → 50%.
    const twinFill = twin?.querySelector('.seat-fill');
    check('v5.7.5: meter kursi kartu gabungan (0/12) terisi 0%', !!twinFill && twinFill.style.width === '0%', twinFill ? `width=${twinFill.style.width}` : 'tidak ada meter');
    const meterCards = [...localCardsAfter].filter((el) => el.textContent.includes('Kerja Uji'));
    check("v5.7.5: kartu 'Kerja Uji' tampil sebagai 1 kartu", meterCards.length === 1, `kartu meter=${meterCards.length}`);
    const meter = meterCards[0];
    check("v5.7.5: kartu 'Kerja Uji' menulis 2/4 kursi", !!meter && /2\/4 kursi/.test(meter.textContent), meter ? meter.textContent.slice(0, 120) : 'tidak ada kartu');
    const meterFill = meter?.querySelector('.seat-fill');
    check("v5.7.5: meter kursi 'Kerja Uji' terisi 50%", !!meterFill && meterFill.style.width === '50%', meterFill ? `width=${meterFill.style.width}` : 'tidak ada meter');
    check("v5.7.5: meter kursi punya label aksesibel", !!meter?.querySelector('.seat-bar')?.getAttribute('aria-label')?.includes('2 dari 4 kursi terisi'), meter?.querySelector('.seat-bar')?.getAttribute('aria-label') || 'tidak ada label');
    const statsText = pageText(dom);
    check('Statistik: jumlah lowongan wilayah memakai hitungan grup', /Lowongan di Wilayahmu/.test(statsText), statsText.slice(0, 120));
  } finally {
    if (dom) dom.window.close();
    stop();
  }
  console.log(`\n[jobs-region-dom] ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
