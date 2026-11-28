// Parlementer — tes DOM conversion tracking Google Ads (v5.3.0).
// Membuktikan (di jsdom + server sungguhan):
//   (1) HTML: tag gtag.js (AW-18546219743) + gtag('config') + event
//       conversion "Tayangan halaman" (send_to AW-18546219743/
//       _HfVCK6Mg8EdEN-1w4tF) ada di <head>, SETELAH script AdSense
//       (AdSense tidak rusak/tergeser);
//   (2) dataLayer di halaman yang di-boot berisi config + event conversion
//       page-view (snippet inline jalan saat load);
//   (3) event conversion 'Pendaftaran' (send_to AW-18546219743/
//       qsZPCIw7.8AdEN-1w4tF, value 1.0, currency IDR — snippet PERSIS
//       dari Google, action dibuat pemilik 28 Nov 14:36 WIB) fire TEPAT
//       SEKALI saat registrasi via form berhasil (mock gtag), dan event
//       'sign_up' polos TIDAK dipakai; login biasa TIDAK memicu apa pun;
//   (4) 'mulai_bermain' fire TEPAT SEKALI saat shift PERTAMA selesai
//       (mock gtag), dan TIDAK fire lagi di shift kedua (server
//       firstShift=false).
// Jalankan: node test/conversion-dom.js  (atau: npm run test:conversion)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
import { DatabaseSync } from 'node:sqlite';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3473;
const DB_PATH = '/tmp/parlementer-conversion-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;
const EXPECTED_VERSION = '5.7.2';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

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
// dataLayer berisi objek Arguments — normalisasi ke array biasa.
function dataLayerEntries(dom) {
  const dl = dom.window.dataLayer || [];
  return Array.from(dl).map((e) => Array.from(e));
}
function countCalls(calls, name) {
  return calls.filter((c) => c[0] === 'event' && c[1] === name).length;
}
// Event conversion 'Pendaftaran' (snippet persis Google).
function countPendaftaran(calls) {
  return calls.filter((c) => c[0] === 'event' && c[1] === 'conversion' && c[2]?.send_to === 'AW-18546219743/qsZPCIw7.8AdEN-1w4tF').length;
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[conversion-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'conversion-dom-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  let dom2 = null;
  try {
    await sleep(1200);
    const world = await (await fetch(BASE + '/api/world')).json();
    check('API /api/world: versi 5.7.2', world.version === EXPECTED_VERSION, `version=${world.version}`);

    // (1) Tag Google di HTML statis.
    const html = await (await fetch(BASE + '/')).text();
    check("gtag: script gtag.js AW-18546219743 ada di <head>", html.includes('https://www.googletagmanager.com/gtag/js?id=AW-18546219743'));
    check("gtag: gtag('config', 'AW-18546219743') ada", html.includes("gtag('config', 'AW-18546219743')"));
    check("gtag: event conversion 'Tayangan halaman' send_to benar", html.includes("gtag('event', 'conversion', {'send_to': 'AW-18546219743/_HfVCK6Mg8EdEN-1w4tF'})"));
    check('gtag: tag Google SETELAH script AdSense (AdSense tidak rusak)',
      html.indexOf('googletagmanager.com/gtag/js') > html.indexOf('pagead2.googlesyndication.com'));
    check('AdSense: script verifikasi masih ada di <head>', html.includes('pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-2013457230013617'));

    // (2) dataLayer setelah boot: config + conversion page-view.
    const jar = makeJar();
    dom = await bootDom(BASE + '/', jar);
    const dl = dataLayerEntries(dom);
    check('dataLayer: gtag config AW-18546219743 tercatat', dl.some((e) => e[0] === 'config' && e[1] === 'AW-18546219743'), JSON.stringify(dl.map((e) => e.slice(0, 2))));
    check("dataLayer: event conversion 'Tayangan halaman' tercatat saat load",
      dl.some((e) => e[0] === 'event' && e[1] === 'conversion' && e[2]?.send_to === 'AW-18546219743/_HfVCK6Mg8EdEN-1w4tF'),
      JSON.stringify(dl.filter((e) => e[1] === 'conversion')));

    // (3) 'Pendaftaran' — mock gtag, lalu daftar via FORM (bukan API).
    const calls = [];
    dom.window.gtag = (...a) => calls.push([...a]);
    const { document } = dom.window;
    document.querySelector('#landing-register')?.click();
    await sleep(500);
    check('Form daftar tampil setelah klik AMBIL KEWARGANEGARAAN', document.querySelector('#form-register')?.hidden === false);
    document.querySelector('#form-register input[name="email"]').value = 'conv@test.local';
    document.querySelector('#form-register input[name="password"]').value = 'rahasia123';
    document.querySelector('#form-register input[name="username"]').value = 'warga_conv';
    document.querySelector('#form-register').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(1800);
    check('Registrasi via form berhasil (masuk dashboard)', document.querySelector('#app')?.hidden === false);
    check("Event conversion 'Pendaftaran' fire tepat 1× saat registrasi berhasil", countPendaftaran(calls) === 1, `calls=${JSON.stringify(calls)}`);
    check("Event conversion 'Pendaftaran' membawa value 1.0 + currency IDR",
      calls.some((c) => c[0] === 'event' && c[1] === 'conversion' && c[2]?.send_to === 'AW-18546219743/qsZPCIw7.8AdEN-1w4tF' && c[2]?.value === 1.0 && c[2]?.currency === 'IDR'),
      `calls=${JSON.stringify(calls)}`);
    check("Event 'sign_up' polos TIDAK dipakai untuk Pendaftaran", countCalls(calls, 'sign_up') === 0, `calls=${JSON.stringify(calls)}`);

    // (3b) Login biasa TIDAK memicu conversion 'Pendaftaran'.
    const jar2 = makeJar();
    dom2 = await bootDom(BASE + '/', jar2);
    const calls2 = [];
    dom2.window.gtag = (...a) => calls2.push([...a]);
    const doc2 = dom2.window.document;
    doc2.querySelector('#landing-login')?.click();
    await sleep(500);
    doc2.querySelector('#form-login input[name="email"]').value = 'conv@test.local';
    doc2.querySelector('#form-login input[name="password"]').value = 'rahasia123';
    doc2.querySelector('#form-login').dispatchEvent(new dom2.window.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(1800);
    check('Login via form berhasil (masuk dashboard)', doc2.querySelector('#app')?.hidden === false);
    check("Login biasa TIDAK memicu conversion 'Pendaftaran'", countPendaftaran(calls2) === 0, `calls=${JSON.stringify(calls2)}`);

    // (4) 'mulai_bermain' — lamar lowongan ADMIN di wilayah warga, lalu shift.
    const me = await api(jar, '/api/me');
    const myRegion = me.data.citizen?.region_id;
    const jobs = await api(jar, '/api/jobs');
    const adminJob = (jobs.data.jobs || []).find((j) => j.is_admin === 1 && j.region_id === myRegion);
    check('Lowongan ADMIN tersedia di wilayah warga', !!adminJob, `region=${myRegion} admin=${(jobs.data.jobs || []).filter((j) => j.is_admin === 1).length}`);
    const ap = await api(jar, '/api/jobs/apply', { job_id: adminJob.id });
    check('Lamar lowongan ADMIN berhasil', ap.status === 200, `status=${ap.status} ${ap.data.error || ''}`);

    // Boot Ulang dashboard (ME segar, sudah punya pekerjaan), mock gtag.
    // (Boot ulang diperlukan: ME di DOM lama masih job=null dari sebelum
    // melamar — route() tidak me-refresh ME saat pindah hash.)
    if (dom) { dom.window.close(); dom = null; }
    const calls3 = [];
    dom = await bootDom(BASE + '/#/dashboard', jar);
    dom.window.gtag = (...a) => calls3.push([...a]);
    const shiftBtn = dom.window.document.querySelector('#btn-dash-shift');
    check('Dashboard: tombol shift ada (sudah punya pekerjaan)', !!shiftBtn);
    shiftBtn?.click();
    await sleep(1800);
    check("Event 'mulai_bermain' fire tepat 1× saat shift pertama selesai", countCalls(calls3, 'mulai_bermain') === 1, `calls=${JSON.stringify(calls3)}`);

    // Shift kedua (energi diisi ulang lewat DB + boot ulang agar ME segar)
    // TIDAK memicu lagi.
    {
      const db = new DatabaseSync(DB_PATH);
      db.prepare('UPDATE citizens SET energy = ?, energy_updated_at = ? WHERE id = ?').run(100, Date.now(), me.data.citizen.id);
      db.close();
    }
    dom.window.close();
    dom = await bootDom(BASE + '/#/dashboard', jar);
    dom.window.gtag = (...a) => calls3.push([...a]);
    dom.window.document.querySelector('#btn-dash-shift')?.click();
    await sleep(1800);
    check("Shift kedua TIDAK memicu 'mulai_bermain' lagi (tetap 1×)", countCalls(calls3, 'mulai_bermain') === 1, `calls=${JSON.stringify(calls3)}`);
  } finally {
    if (dom) dom.window.close();
    if (dom2) dom2.window.close();
    stop();
  }
  console.log(`\n[conversion-dom] ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
