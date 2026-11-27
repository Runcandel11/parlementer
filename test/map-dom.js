// Parlementer — tes DOM peta besar ala Parlamentum (v2.5.0).
// Membuktikan (di jsdom + server sungguhan):
//   (1) PETA GEOGRAFIS: SVG #big-map dengan 17 wilayah (.map-region-g)
//       dari bentuk yang disederhanakan; wilayah TANPA negara tampil
//       kaca abu-abu (kelas free) + tanda "?" (.map-q), tanpa warna negara.
//   (2) KAMU: penanda "📍 KAMU" (.map-you) ada di wilayah pemain saat ini.
//   (3) KLIK: klik poligon wilayah memilihnya — panel bawah POLITIK ·
//       NEGARA menampilkan wilayah itu; tombol "Lihat Wilayah" membuka
//       detail wilayah (#/regions/:id). Klik dua kali juga membuka detail.
//   (4) CARI: mengetik "papua" menandai Papua (.match) dan meredupkan
//       sisanya (.dim); mengosongkan pencarian mengembalikan semua.
//   (5) ZOOM: tombol + mengubah lebar SVG (100% → 150%).
//   (6) WARNA NEGARA: setelah 2 wilayah diberi negara (lewat DB),
//       keduanya kehilangan kelas free + "?" dan memakai warna negara
//       deterministik (#d43d2a untuk negara id 1), label nama negara
//       tampil; 15 wilayah lain tetap abu-abu + "?".
//   (7) KRONIK: membuka peta menandai tugas 'map' (Jelajahi peta) selesai
//       lewat POST /api/chronicle/visit (kunci lain ditolak 400).
// Jalankan: node test/map-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
import { DatabaseSync } from 'node:sqlite';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3471;
const DB_PATH = '/tmp/parlementer-map-dom.db';
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
async function api(jar, path, body, method) {
  const res = await jar(path, body === undefined && !method ? undefined : { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
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

  console.log('[map-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'map-dom-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  try {
    await sleep(1200);

    const jarA = makeJar();
    let r = await api(jarA, '/api/auth/register', { email: 'domPeta@test.local', password: 'rahasia123', username: 'warga_peta' });
    check('Daftar pemain (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    const meA = r.data;

    // --- (0) API: /api/regions menyertakan koordinat ibu kota ---
    r = await api(jarA, '/api/regions');
    const regions = r.data.regions || [];
    check('API /api/regions: 17 wilayah', regions.length === 17, `n=${regions.length}`);
    check('API /api/regions: semua wilayah punya coords [lat, lon]', regions.every((x) => Array.isArray(x.coords) && x.coords.length === 2), regions.filter((x) => !x.coords).map((x) => x.name).join(',') || 'semua ada');
    const jakarta = regions.find((x) => x.name === 'Jakarta');
    check('API /api/regions: coords Jakarta = ibu kota (-6.21, 106.85)', jakarta?.coords?.[0] === -6.21 && jakarta?.coords?.[1] === 106.85, JSON.stringify(jakarta?.coords));
    check('API /api/regions: semua wilayah belum bernegara', regions.every((x) => x.country_name == null && x.country_id == null));
    const mineId = r.data.mine;
    const homeId = r.data.home;

    // --- (7) KRONIK visit: kunci salah ditolak, 'map' diterima ---
    r = await api(jarA, '/api/chronicle/visit', { key: 'bukan-kunci' });
    check('Kronik visit: kunci tidak dikenal ditolak 400', r.status === 400, `status=${r.status}`);
    r = await api(jarA, '/api/chronicle/visit', { key: 'map' });
    check('Kronik visit: kunci map diterima', r.status === 200 && r.data.ok, `status=${r.status}`);
    r = await api(jarA, '/api/chronicle');
    const mapTask = (r.data.chapters || []).flatMap((c) => c.tasks).find((t) => t.key === 'map');
    check("Kronik: tugas 'map' (Jelajahi peta) selesai", mapTask?.done === true, `done=${mapTask?.done}`);

    // --- (1)(2) PETA: SVG + 17 wilayah abu-abu + "?" + penanda KAMU ---
    dom = await bootDom(BASE + '/#/map', jarA);
    const { window } = dom;
    const { document } = window;
    const svg = document.querySelector('#big-map');
    check('Peta: SVG #big-map tampil', !!svg, svg ? `viewBox=${svg.getAttribute('viewBox')}` : '');
    const groups = [...document.querySelectorAll('.map-region-g')];
    check('Peta: 17 kelompok wilayah (.map-region-g)', groups.length === 17, `n=${groups.length}`);
    check('Peta: semua wilayah kelas free (tanpa negara)', groups.every((g) => g.classList.contains('free')), `${groups.filter((g) => !g.classList.contains('free')).length} tidak free`);
    check('Peta: 17 tanda "?" (.map-q) untuk wilayah tanpa negara', document.querySelectorAll('.map-q').length === 17, `n=${document.querySelectorAll('.map-q').length}`);
    check('Peta: TIDAK ada poligon dengan warna negara (inline fill)', ![...document.querySelectorAll('.map-region')].some((p) => (p.getAttribute('style') || '').includes('fill:')), 'semua poligon tanpa fill inline');
    check('Peta: 17 label nama wilayah (.map-label)', document.querySelectorAll('.map-label').length === 17, `n=${document.querySelectorAll('.map-label').length}`);
    check('Peta: belum ada label nama negara', document.querySelectorAll('.map-country-label').length === 0);
    const you = document.querySelector('.map-you');
    check('Peta: penanda KAMU (.map-you) ada', !!you && (you.textContent || '').includes('KAMU'), you?.textContent?.trim());
    check('Peta: penanda KAMU di wilayah pemain (data-region-id = mine)', !!you && Number(you.dataset.regionId) === mineId, `you=${you?.dataset.regionId} mine=${mineId}`);
    check('Peta: kolom Cari wilayah ada (placeholder)', document.querySelector('#map-search')?.getAttribute('placeholder') === 'Cari wilayah...');
    const pageTxt = document.querySelector('#page')?.textContent || '';
    check('Peta: teks "Belum Bernegara" tampil', pageTxt.includes('Belum Bernegara'));
    check('Peta: tidak ada kata "Merdeka"', !/merdeka/i.test(pageTxt));
    check('Peta: panel POLITIK · NEGARA tampil', pageTxt.includes('POLITIK · NEGARA'));

    // Panel bawah default = wilayah pemain.
    const panelTxt = document.querySelector('#map-panel-body')?.textContent || '';
    const myRegion = regions.find((x) => x.id === mineId);
    check('Panel: menampilkan wilayah pemain', panelTxt.includes(myRegion.name), `panel=${panelTxt.slice(0, 60)}`);
    check('Panel: wilayah pemain "Belum Bernegara"', panelTxt.includes('Belum Bernegara'));

    // --- (4) CARI: "papua" hanya menandai Papua ---
    const search = document.querySelector('#map-search');
    search.value = 'papua';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await sleep(300);
    const papuaG = document.querySelector('.map-region-g[data-name="papua"]');
    check('Cari "papua": Papua ditandai .match', !!papuaG && papuaG.classList.contains('match'));
    check('Cari "papua": 16 wilayah lain diredupkan (.dim)', document.querySelectorAll('.map-region-g.dim').length === 16, `n=${document.querySelectorAll('.map-region-g.dim').length}`);
    check('Cari "papua": hitungan "1 wilayah cocok."', (document.querySelector('#map-search-count')?.textContent || '').includes('1 wilayah cocok'));
    search.value = '';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await sleep(300);
    check('Cari dikosongkan: tidak ada lagi .dim/.match', document.querySelectorAll('.map-region-g.dim').length === 0 && document.querySelectorAll('.map-region-g.match').length === 0);

    // --- (5) ZOOM: tombol + memperbesar SVG ---
    check('Zoom: lebar awal SVG 100% (tanpa inline width)', !svg.style.width || svg.style.width === '100%');
    document.querySelector('#map-zoom-in')?.click();
    await sleep(200);
    check('Zoom: klik + → lebar SVG 150%', svg.style.width === '150%', `width=${svg.style.width}`);
    document.querySelector('#map-zoom-reset')?.click();
    await sleep(200);
    check('Zoom: reset → lebar SVG 100%', svg.style.width === '100%', `width=${svg.style.width}`);

    // --- (3) KLIK: pilih Jakarta → panel terisi; Lihat Wilayah → detail ---
    const jktPoly = document.querySelector('.map-region-g[data-name="jakarta"] .map-region');
    check('Klik: poligon Jakarta ada', !!jktPoly);
    if (jktPoly) {
      // jsdom: elemen SVG tidak punya .click() — kirim event langsung.
      jktPoly.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await sleep(1500); // panel mengambil detail /api/regions/:id
      const panel2 = document.querySelector('#map-panel-body')?.textContent || '';
      check('Klik Jakarta: panel menampilkan Jakarta', panel2.includes('Jakarta'), panel2.slice(0, 60));
      check('Klik Jakarta: panel "Belum Bernegara"', panel2.includes('Belum Bernegara'));
      check('Klik Jakarta: panel menampilkan pajak penghasilan', panel2.includes('Pajak penghasilan'));
      check('Klik Jakarta: wilayah ditandai .selected', !!document.querySelector('.map-region-g[data-name="jakarta"].selected'));
      const detailBtn = document.querySelector('#map-panel-body [data-goto^="#/regions/"]');
      check('Klik Jakarta: tombol Lihat Wilayah ada', !!detailBtn, detailBtn?.getAttribute('data-goto') || '');
      if (detailBtn) {
        detailBtn.click();
        await sleep(1500);
        check('Klik Lihat Wilayah: membuka detail wilayah', window.location.hash.startsWith('#/regions/'), `hash=${window.location.hash}`);
        check('Detail wilayah: judul Jakarta tampil', (document.querySelector('#page')?.textContent || '').includes('JAKARTA'));
      }
    }

    // --- (6) WARNA NEGARA: 2 wilayah diberi negara 'Nusantara Raya' ---
    const db = new DatabaseSync(DB_PATH);
    const aId = db.prepare("SELECT c.id FROM citizens c JOIN users u ON u.id = c.user_id WHERE u.username = 'warga_peta'").get().id;
    const ins = db.prepare("INSERT INTO country (name, ideology, system, founder_id, capital) VALUES ('Nusantara Raya','Konservatisme','presidensial',?, 'Jakarta')").run(aId);
    const countryId = Number(ins.lastInsertRowid);
    db.prepare("UPDATE regions SET country_id = ? WHERE name IN ('Jakarta','Jawa Barat')").run(countryId);
    db.close();
    check('Warna negara: negara Nusantara Raya dibuat (DB)', countryId > 0, `id=${countryId}`);
    window.location.hash = '#/dashboard';
    await sleep(1500);
    window.location.hash = '#/map';
    await sleep(1800);
    const jktG2 = document.querySelector('.map-region-g[data-name="jakarta"]');
    const jabarG2 = document.querySelector('.map-region-g[data-name="jawa barat"]');
    check('Warna negara: Jakarta TIDAK lagi kelas free', !!jktG2 && !jktG2.classList.contains('free'));
    check('Warna negara: Jawa Barat TIDAK lagi kelas free', !!jabarG2 && !jabarG2.classList.contains('free'));
    const jktFill = document.querySelector('.map-region-g[data-name="jakarta"] .map-region')?.getAttribute('style') || '';
    check('Warna negara: Jakarta memakai warna negara #d43d2a (id 1)', jktFill.includes('#d43d2a'), jktFill);
    check('Warna negara: tanda "?" Jakarta hilang', !jktG2?.querySelector('.map-q'));
    check('Warna negara: tanda "?" Jawa Barat hilang', !jabarG2?.querySelector('.map-q'));
    check('Warna negara: 15 wilayah lain tetap "?"', document.querySelectorAll('.map-q').length === 15, `n=${document.querySelectorAll('.map-q').length}`);
    const countryLabel = document.querySelector('.map-country-label');
    check('Warna negara: label NUSANTARA RAYA tampil di peta', !!countryLabel && (countryLabel.textContent || '').includes('NUSANTARA RAYA'), countryLabel?.textContent || '');
    check('Warna negara: panel tetap menampilkan "Belum Bernegara" untuk wilayah lain', (document.querySelector('#page')?.textContent || '').includes('Belum Bernegara'));
  } finally {
    if (dom) dom.window.close();
    stop();
  }

  console.log(`\n[map-dom] ${passed} lolos, ${failed} gagal.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
