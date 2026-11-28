// Parlementer — tes DOM v5.7.4: usulan parlemen hanya MP + jadwal pemilu tampil.
// Membuktikan di UI (bukan cuma API):
//   (1) Halaman Negara (#/country): baris "Pemilu Berikutnya" menampilkan
//       pemilu parlemen pertama yang sebenarnya terjadwal (bukan
//       "Belum ada jadwal") + tautan ke halaman Pemilu;
//   (2) Halaman Parlemen (#/parliament): panel usulan UU/mosi perang/mosi
//       nama menampilkan petunjuk "hanya anggota parlemen", dan kartu
//       "Pemilu Berikutnya" menampilkan tanggal pemilu;
//   (3) Halaman Pemilu (#/elections): panel PETISI PEMBUKA PEMILU tampil
//       untuk pemilu parlemen terjadwal (progres 0/5 per wilayah) +
//       tombol DUKUNG PEMBUKAAN PEMILU; klik tombol → progres jadi 1/5.
// Jalankan: node test/mp-elections-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
import { DatabaseSync } from 'node:sqlite';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3476;
const DB_PATH = '/tmp/parlementer-mp-elections-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;

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
async function api(jar, path, body, method) {
  const res = await jar(path, body === undefined && !method ? undefined : { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
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
    beforeParse(window) {
      window.fetch = jarFetchFn;
      window.URL.createObjectURL = () => 'blob:stub';
      window.URL.revokeObjectURL = () => {};
      window.confirm = () => true;
      window.Image = class {
        constructor() { this.width = 800; this.height = 600; this._src = ''; }
        set src(v) { this._src = v; setTimeout(() => { if (typeof this.onload === 'function') this.onload(); }, 0); }
        get src() { return this._src; }
      };
    },
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

  console.log('[mp-elections-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'mp-elections-dom-test-secret', ADMIN_BOOTSTRAP_CODE: 'mp-elections-dom-bootstrap' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { const r = await fetch(BASE + '/api/world'); up = r.ok; } catch { await sleep(250); }
    }
    check('server menyala dan /api/world merespons', up);
    if (!up) { process.exitCode = 1; return; }
    const world = await (await fetch(BASE + '/api/world')).json();
    check('API /api/world: versi 5.7.4', world.version === '5.7.4', `version=${world.version}`);

    const jarF = makeJar();
    let r = await api(jarF, '/api/auth/register', { email: 'pendiri-mp@test.local', password: 'rahasia123', username: 'pendiri_mp' });
    check('Daftar pendiri_mp (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    const founderId = (await api(jarF, '/api/me', undefined, 'GET')).data.citizen.id;
    {
      const db = new DatabaseSync(DB_PATH);
      // Level 10 + emas untuk mendirikan negara; umur 4 hari supaya bisa
      // mendukung petisi (syarat Level 5 + 3 hari). Parlemen dibuka.
      db.prepare('UPDATE citizens SET level = 10, gold = 500, created_at = ? WHERE id = ?').run(Date.now() - 4 * 86400000, founderId);
      db.prepare("UPDATE db_meta SET value = ? WHERE key = 'parliament_opens_at'").run(String(Date.now() - 1000));
      db.close();
    }
    r = await api(jarF, '/api/countries', { name: 'Negara MP', ideology: 'Konservatisme', system: 'presidensial' });
    check('pendiri_mp mendirikan negara (API)', r.status === 200 && !!r.data.countryId, `status=${r.status}`);

    // --- (1) Halaman Negara: Pemilu Berikutnya ---
    dom = await bootDom(BASE + '/#/country', jarF);
    let { window } = dom;
    let document = window.document;
    let txt = () => document.querySelector('#page')?.textContent || '';
    check('Negara: baris "Pemilu Berikutnya" tampil', txt().includes('Pemilu Berikutnya'));
    check('Negara: pemilu parlemen pertama tampil (Parlemen — tanggal)', txt().includes('Parlemen —'), txt().slice(0, 300));
    check('Negara: tautan "Lihat halaman Pemilu" tampil', !!document.querySelector('a[href="#/elections"]'));
    dom.window.close();

    // --- (2) Halaman Parlemen: petunjuk MP-only + kartu pemilu ---
    dom = await bootDom(BASE + '/#/parliament', jarF);
    window = dom.window;
    document = window.document;
    txt = () => document.querySelector('#page')?.textContent || '';
    check('Parlemen: petunjuk usulan UU hanya MP tampil', txt().includes('Hanya anggota parlemen (Level 5)'));
    check('Parlemen: petunjuk mosi perang hanya MP tampil', txt().includes('Hanya anggota parlemen yang bisa mengusulkan.'));
    check('Parlemen: petunjuk mosi nama hanya MP tampil', txt().includes('hanya anggota parlemen yang bisa mengusulkan nama'));
    check('Parlemen: kartu "Pemilu Berikutnya" tampil', txt().includes('Pemilu Berikutnya'));
    check('Parlemen: kartu pemilu menyebut Parlemen', txt().includes('Parlemen · terjadwal') || txt().includes('Parlemen · sedang berlangsung'), txt().slice(0, 300));
    dom.window.close();

    // --- (3) Halaman Pemilu: panel petisi + tombol Dukung ---
    dom = await bootDom(BASE + '/#/elections', jarF);
    window = dom.window;
    document = window.document;
    txt = () => document.querySelector('#page')?.textContent || '';
    check('Pemilu: panel PETISI PEMBUKA PEMILU tampil', txt().includes('PETISI PEMBUKA PEMILU'));
    check('Pemilu: progres petisi wilayah tampil 0/5', txt().includes('0/5'), txt().slice(0, 300));
    const supportBtn = document.querySelector('[data-petition]');
    check('Pemilu: tombol DUKUNG PEMBUKAAN PEMILU tampil', !!supportBtn);
    supportBtn.click();
    await sleep(1500);
    check('Setelah Dukung: progres petisi jadi 1/5', txt().includes('1/5'), txt().slice(0, 300));
    check('Setelah Dukung: tampil "Kamu sudah mendukung petisi ini"', txt().includes('Kamu sudah mendukung petisi ini'));
    dom.window.close();
    dom = null;
  } finally {
    if (dom) dom.window.close();
    stop();
  }
  console.log(`\n[mp-elections-dom] SELESAI: ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[mp-elections-dom] ERROR:', e); process.exit(1); });
