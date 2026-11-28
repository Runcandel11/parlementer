// Parlementer — tes DOM ringkasan analitik Panel Admin (v5.7.5, Lane 15).
// Membuktikan (di jsdom + server sungguhan):
//   (1) API: GET /api/admin/overview (admin) mengembalikan total pemain,
//       baru hari ini, banned, premium aktif, total emas/Rupiah beredar,
//       dan pemain per wilayah yang jumlahnya sama dengan total pemain;
//   (2) PANEL ADMIN: halaman #/admin menampilkan panel #admin-overview
//       dengan 6 kartu KPI (Total Pemain, Baru Hari Ini, Premium Aktif,
//       Banned, Total Emas Beredar, Total Rupiah Beredar) + grafik batang
//       "Pemain per wilayah" (17 baris, batang teramai lebar 100%);
//   (3) NON-ADMIN: warga biasa membuka #/admin tidak melihat ringkasan.
// Jalankan: flock /tmp/parl-test.lock node test/admin-overview-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3477;
const DB_PATH = '/tmp/parlementer-admin-overview-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;
const EXPECTED_VERSION = '5.7.5';

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

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[admin-overview-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'admin-overview-dom-test-secret', ADMIN_BOOTSTRAP_CODE: 'admin-overview-dom-bootstrap' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  try {
    await sleep(1200);

    const jarA = makeJar();
    const jarB = makeJar();
    const jarADM = makeJar();
    let r = await api(jarA, '/api/auth/register', { email: 'ov_a@test.local', password: 'rahasia123', username: 'warga_ov_a' });
    check('Daftar pemain A (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    r = await api(jarB, '/api/auth/register', { email: 'ov_b@test.local', password: 'rahasia123', username: 'warga_ov_b' });
    check('Daftar pemain B (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    r = await api(jarADM, '/api/auth/register', { email: 'ov_admin@test.local', password: 'rahasia123', username: 'admin_ov', admin_code: 'admin-overview-dom-bootstrap' });
    check('Daftar admin (kode bootstrap)', r.status === 200 && r.data.ok, `status=${r.status}`);
    r = await api(jarADM, '/api/me');
    check('Akun bootstrap menjadi admin', r.data.user.is_admin === true, `is_admin=${r.data.user.is_admin}`);

    r = await api(jarADM, '/api/world');
    check('API /api/world: versi 5.7.5', r.data.version === EXPECTED_VERSION, `version=${r.data.version}`);

    // --- (1) API overview ---
    r = await api(jarADM, '/api/admin/overview');
    const ov = r.data;
    check('Overview: total 3 pemain, 3 baru hari ini, 0 banned', r.status === 200 && ov.totalPlayers === 3 && ov.newToday === 3 && ov.banned === 0, `total=${ov.totalPlayers} baru=${ov.newToday} banned=${ov.banned}`);
    check('Overview: premium aktif 0', ov.premiumActive === 0, `premium=${ov.premiumActive}`);
    check('Overview: total emas 150 (3 × 50 awal)', ov.totalGold === 150, `emas=${ov.totalGold}`);
    check('Overview: total Rupiah >= 0', ov.totalUsd >= 0, `usd=${ov.totalUsd}`);
    check('Overview: 17 wilayah, jumlah pemain per wilayah = 3', Array.isArray(ov.byRegion) && ov.byRegion.length === 17 && ov.byRegion.reduce((s, x) => s + x.players, 0) === 3, `wilayah=${ov.byRegion?.length}`);

    // --- (2) DOM panel admin ---
    dom = await bootDom(BASE + '/#/admin', jarADM);
    const doc = dom.window.document;
    const panel = doc.querySelector('#admin-overview');
    check('Panel admin: #admin-overview tampil', !!panel);
    const panelTxt = panel?.textContent || '';
    for (const label of ['Total Pemain', 'Baru Hari Ini', 'Premium Aktif', 'Banned', 'Total Emas Beredar', 'Total Rupiah Beredar']) {
      check(`Ringkasan: kartu KPI "${label}" tampil`, panelTxt.includes(label));
    }
    const kpis = panel ? [...panel.querySelectorAll('[data-kpi]')] : [];
    check('Ringkasan: 6 kartu KPI', kpis.length === 6, `kpi=${kpis.length}`);
    const totalKpi = panel?.querySelector('[data-kpi="total"]');
    check('Ringkasan: Total Pemain bernilai 3', totalKpi && totalKpi.textContent.trim() === '3', totalKpi?.textContent?.trim());
    const rows = panel ? [...panel.querySelectorAll('.region-bar-row')] : [];
    check('Ringkasan: 17 baris wilayah tampil', rows.length === 17, `baris=${rows.length}`);
    const widths = rows.map((row) => row.querySelector('.bar > i')?.style?.width || '');
    check('Ringkasan: batang wilayah teramai lebar 100%', widths.includes('100%'), widths.join(','));
    const shownSum = rows.reduce((s, row) => s + (Number((row.querySelector('.region-bar-head b')?.textContent || '0').replace(/\D/g, '')) || 0), 0);
    check('Ringkasan: jumlah pemain di batang = 3', shownSum === 3, `jumlah=${shownSum}`);
    dom.window.close(); dom = null;

    // --- (3) NON-ADMIN tidak melihat ringkasan ---
    dom = await bootDom(BASE + '/#/admin', jarA);
    check('Non-admin: #admin-overview tidak tampil', !dom.window.document.querySelector('#admin-overview'));
    dom.window.close(); dom = null;
  } finally {
    if (dom) dom.window.close();
    stop();
  }

  console.log(`\n[admin-overview-dom] ${passed} lolos, ${failed} gagal.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
