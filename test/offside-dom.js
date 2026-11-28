// Parlementer — tes DOM perbaikan offside teks + tampilan roti Premium (v4.5.0).
// Membuktikan (di jsdom + server sungguhan, lebar visual default jsdom):
//   (1) Buku → Riwayat Update: span tanggal punya flex-shrink:0 (tidak
//       meluber/terpotong di tepi kanan);
//   (2) Notifikasi: span "Dibaca" punya white-space:nowrap + flex-shrink:0
//       (tidak terlipat jadi "Dib/aca");
//   (3) Banner countdown parlemen: tanggal dipisah ke baris kedua (<br>)
//       + "2 Des 2026" tetap tampil;
//   (4) Dashboard warga Premium: "Sisa roti hari ini …/25" (bukan /10);
//   (5) Halaman Pekerjaan: tombol #btn-autowork ada untuk warga Premium
//       yang sudah bekerja; warga non-Premium hanya melihat catatan
//       "khusus Premium".
// Jalankan: node test/offside-dom.js  (atau: npm run test:offside)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3472;
const DB_PATH = '/tmp/parlementer-offside-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;
const EXPECTED_VERSION = '5.7.1';

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

  console.log('[offside-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'offside-dom-test-secret', ADMIN_BOOTSTRAP_CODE: 'offside-dom-code' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  try {
    await sleep(1200);

    const world = await (await fetch(BASE + '/api/world')).json();
    check('API /api/world: versi 5.7.1', world.version === EXPECTED_VERSION, `version=${world.version}`);

    // --- Warga Premium (P) + admin untuk grant premium.
    const jarP = makeJar();
    const rp = await api(jarP, '/api/auth/register', { email: 'domOffP@test.local', password: 'rahasia123', username: 'warga_offp' });
    check('Daftar warga_offp (Premium, API)', rp.status === 200 && rp.data.ok);
    const meP = await api(jarP, '/api/me');
    const pUserId = meP.data.user.id;
    const jarA = makeJar();
    const ra = await api(jarA, '/api/auth/register', { email: 'admin_off@test.local', password: 'rahasia123', username: 'admin_off', admin_code: 'offside-dom-code' });
    check('Daftar admin_off (API)', ra.status === 200 && ra.data.ok);
    const prem = await api(jarA, '/api/admin/premium', { user_id: pUserId, months: 1 });
    check('Admin memberi Premium 1 bulan ke warga_offp', prem.status === 200, `status=${prem.status} ${prem.data.error || ''}`);
    const meP2 = await api(jarP, '/api/me');
    check('/api/me: warga_offp Premium + breadLimit 25', meP2.data.citizen.isPremium && meP2.data.citizen.breadLimit === 25, `breadLimit=${meP2.data.citizen.breadLimit}`);

    // Tandai satu pengumuman sebagai dibaca (untuk cek "Dibaca").
    const anns = await api(jarP, '/api/announcements');
    const seeded = (anns.data.announcements || [])[0];
    check('Ada pengumuman untuk ditandai dibaca', !!seeded, `n=${anns.data.announcements?.length}`);
    const rd = await api(jarP, '/api/announcements/read', { id: seeded?.id });
    check('Tandai pengumuman dibaca (API)', rd.status === 200, `status=${rd.status}`);

    // --- (3) Banner countdown: tanggal di baris kedua.
    dom = await bootDom(BASE + '/#/dashboard', jarP);
    const pcd = dom.window.document.querySelector('#parliament-countdown');
    check('Banner countdown parlemen ada', !!pcd);
    check('Countdown: tanggal dipisah ke baris kedua (<br>)', (pcd?.innerHTML || '').includes('<br>'), (pcd?.innerHTML || '').slice(0, 160));
    check('Countdown: tetap menyebut "28 Nov 2026"', (pcd?.textContent || '').includes('28 Nov 2026'), (pcd?.textContent || '').slice(0, 120));

    // --- (4) Dashboard Premium: jatah roti /25.
    const foodHead = [...dom.window.document.querySelectorAll('#page .stat-head')].find((el) => el.textContent.includes('Sisa roti hari ini'));
    check('Dashboard: kartu MAKANAN menampilkan sisa roti', !!foodHead, foodHead?.textContent.trim());
    check('Dashboard Premium: sisa roti memakai /25', (foodHead?.textContent || '').includes('/25'), foodHead?.textContent.trim());
    dom.window.close(); dom = null;

    // --- (1) Buku → Riwayat Update: tanggal tidak meluber.
    dom = await bootDom(BASE + '/#/book', jarP);
    const dateSpans = [...dom.window.document.querySelectorAll('#page .v.small.muted')]
      .filter((el) => (el.getAttribute('style') || '').includes('white-space:nowrap'));
    check('Buku: ada span tanggal Riwayat Update (nowrap)', dateSpans.length >= 1, `ditemukan ${dateSpans.length}`);
    check('Buku: span tanggal punya flex-shrink:0', dateSpans.length >= 1 && dateSpans.every((el) => (el.getAttribute('style') || '').includes('flex-shrink:0')),
      dateSpans[0]?.getAttribute('style') || '');
    dom.window.close(); dom = null;

    // --- (2) Notifikasi: label "Dibaca" tidak terlipat.
    dom = await bootDom(BASE + '/#/notifications', jarP);
    const readSpan = [...dom.window.document.querySelectorAll('#page .v.small')]
      .find((el) => el.textContent.trim() === 'Dibaca');
    check('Notifikasi: label "Dibaca" tampil', !!readSpan);
    const readStyle = readSpan?.getAttribute('style') || '';
    check('Notifikasi: span "Dibaca" punya white-space:nowrap + flex-shrink:0',
      readStyle.includes('white-space:nowrap') && readStyle.includes('flex-shrink:0'), readStyle);
    dom.window.close(); dom = null;

    // --- (5) Halaman Pekerjaan: toggle auto-kerja.
    // Premium + bekerja → tombol ada.
    const meP3 = await api(jarP, '/api/me');
    const jobsP = (await api(jarP, '/api/jobs')).data.jobs || [];
    const jobP = jobsP.find((j) => j.region_id === meP3.data.citizen.region_id && j.is_admin === 1)
      || jobsP.find((j) => j.region_id === meP3.data.citizen.region_id);
    check('Ada lowongan di wilayah warga_offp', !!jobP);
    const ap = await api(jarP, '/api/jobs/apply', { job_id: jobP.id });
    check('warga_offp melamar pekerjaan (API)', ap.status === 200 && ap.data.ok, `status=${ap.status} ${ap.data.error || ''}`);
    dom = await bootDom(BASE + '/#/jobs', jarP);
    const btnAw = dom.window.document.querySelector('#btn-autowork');
    check('Pekerjaan (Premium + bekerja): tombol #btn-autowork ada', !!btnAw, btnAw?.textContent.trim());
    check('Pekerjaan (Premium): tombol menawarkan NYALAKAN', (btnAw?.textContent || '').includes('NYALAKAN'));
    dom.window.close(); dom = null;

    // Non-Premium → hanya catatan "khusus Premium", tanpa tombol.
    // (Catatan tampil di panel PEKERJAANMU — warga ini juga melamar dulu.)
    const jarN = makeJar();
    const rn = await api(jarN, '/api/auth/register', { email: 'domOffN@test.local', password: 'rahasia123', username: 'warga_offn' });
    check('Daftar warga_offn (non-Premium, API)', rn.status === 200 && rn.data.ok);
    const meN = await api(jarN, '/api/me');
    const jobsN = (await api(jarN, '/api/jobs')).data.jobs || [];
    const jobN = jobsN.find((j) => j.region_id === meN.data.citizen.region_id && j.is_admin === 1)
      || jobsN.find((j) => j.region_id === meN.data.citizen.region_id);
    const an = await api(jarN, '/api/jobs/apply', { job_id: jobN.id });
    check('warga_offn melamar pekerjaan (API)', an.status === 200 && an.data.ok, `status=${an.status} ${an.data.error || ''}`);
    dom = await bootDom(BASE + '/#/jobs', jarN);
    check('Pekerjaan (non-Premium): TIDAK ada tombol #btn-autowork', !dom.window.document.querySelector('#btn-autowork'));
    check('Pekerjaan (non-Premium): catatan "khusus Premium" tampil', pageText(dom).includes('khusus Premium'), pageText(dom).slice(0, 200));
  } finally {
    if (dom) dom.window.close();
    stop();
  }
  console.log(`\n[offside-dom] ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
