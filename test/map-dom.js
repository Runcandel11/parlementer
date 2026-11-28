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
//   (5) ZOOM KAMERA (v5.7.5): tombol + memakai transform scale(1/1.5/2.2)
//       (bukan lebar SVG lagi); zoom ≥1.5 memberi kelas .map-zoomed.
//   (6) WARNA NEGARA: setelah 2 wilayah diberi negara (lewat DB),
//       keduanya kehilangan kelas free + "?" dan memakai warna negara
//       deterministik (#d43d2a untuk negara id 1), label nama negara
//       tampil; 15 wilayah lain tetap abu-abu + "?".
//   (8) KAMERA (v5.7.5): roda mouse zoom, drag = pan (translate),
//       pinch 2 jari = zoom, klik tepat setelah drag diabaikan.
//   (9) RUTE PERJALANAN (v5.7.5): saat warga sedang bepergian, peta
//       menampilkan garis rute (.map-route) + cincin tujuan + hitung
//       mundur yang berdetak tiap detik sampai "sebentar lagi".
//   (10) WORLD DOMINION (v5.7.5, referensi Khalid 28 Nov 18:15 WIB):
//       peta full-bleed (panel tanpa krom, laut gelap #070b14), kontrol
//       overlay (cari kiri atas, zoom+slider+Reset+Lokasi saya kanan
//       atas, panel Lapisan Peta kiri bawah), lapisan Politik/Populasi/
//       Perang bisa dihidup-matikan, wilayah berperang aktif berdenyut
//       merah + lencana ⚔️, tombol Lokasi saya menerbangkan kamera ke
//       wilayah pemain (zoom 2×, marker di tengah).
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
    // Render peta butuh 2 fetch API — tunggu sampai SVG ada (bukan sleep
    // tetap; di mesin lambat/berbagi CPU 1800ms bootDom belum cukup).
    for (let i = 0; i < 30 && !document.querySelector('#big-map'); i++) await sleep(200);
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
    check('Peta: kolom Cari wilayah ada (placeholder)', document.querySelector('#map-search')?.getAttribute('placeholder') === '🔍 Cari wilayah...');
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

    // --- (5) ZOOM KAMERA (v5.7.5): tombol + memakai transform scale ---
    check('Zoom: transform awal kosong/skala 1', !svg.style.transform || svg.style.transform.includes('scale(1)'), `transform=${svg.style.transform}`);
    document.querySelector('#map-zoom-in')?.click();
    await sleep(200);
    check('Zoom: klik + → transform scale(1.5)', svg.style.transform.includes('scale(1.5)'), `transform=${svg.style.transform}`);
    document.querySelector('#map-zoom-in')?.click();
    await sleep(200);
    check('Zoom: klik + lagi → transform scale(2.2)', svg.style.transform.includes('scale(2.2)'), `transform=${svg.style.transform}`);
    check('Zoom: label membesar di zoom ≥1.5 (.map-zoomed)', !!document.querySelector('#big-map-wrap.map-zoomed'));
    document.querySelector('#map-zoom-reset')?.click();
    await sleep(200);
    check('Zoom: reset → transform scale(1)', svg.style.transform.includes('scale(1)'), `transform=${svg.style.transform}`);
    check('Zoom: reset menghapus .map-zoomed', !document.querySelector('#big-map-wrap.map-zoomed'));

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

    // --- (8) KAMERA (v5.7.5): roda mouse, drag pan, pinch, klik-setelah-drag ---
    const wrap = document.querySelector('#big-map-wrap');
    // CATATAN: seksi (6) me-reload halaman — referensi `svg` lama sudah
    // terlepas dari DOM; ambil ulang elemen yang sedang tampil.
    const svgNow = document.querySelector('#big-map');
    check('Kamera: SVG peta segar (bukan referensi lama)', !!svgNow);
    check('Kamera: .big-map-wrap ada', !!wrap);
    check('Kamera: vignette overlay ada', !!document.querySelector('.map-vignette'));
    const css = fs.readFileSync(ROOT + 'public/css/style.css', 'utf8');
    check('Kamera: CSS punya @keyframes youPulse (denyut KAMU)', css.includes('@keyframes youPulse'));
    check('Kamera: CSS punya @keyframes routeMarch (rute berjalan)', css.includes('@keyframes routeMarch'));
    check('Kamera: CSS .map-you-ring memakai animasi youPulse', /\.map-you-ring\s*\{[^}]*animation:\s*youPulse/.test(css));
    const firePtr = (type, x, y, id) => {
      const ev = new window.Event(type, { bubbles: true, cancelable: true });
      ev.clientX = x; ev.clientY = y; ev.pointerId = id;
      wrap.dispatchEvent(ev);
    };
    if (wrap) {
      // (a) roda mouse ke atas = zoom naik
      const wheel = new window.Event('wheel', { bubbles: true, cancelable: true });
      wheel.deltaY = -100; wheel.clientX = 100; wheel.clientY = 60;
      wrap.dispatchEvent(wheel);
      await sleep(200);
      check('Kamera: roda ke atas → zoom naik scale(1.25)', svgNow.style.transform.includes('scale(1.25)'), `transform=${svgNow.style.transform}`);
      document.querySelector('#map-zoom-reset')?.click();
      await sleep(200);
      // (b) drag = pan (translate), zoom 1.5 dulu supaya geser tidak ter-clamp 0
      document.querySelector('#map-zoom-in')?.click();
      await sleep(200);
      firePtr('pointerdown', 260, 130, 1);
      firePtr('pointermove', 200, 100, 1);
      firePtr('pointerup', 200, 100, 1);
      await sleep(200);
      check('Kamera: drag menggeser peta translate(-60px, -30px)', svgNow.style.transform.includes('translate(-60px, -30px)'), `transform=${svgNow.style.transform}`);
      document.querySelector('#map-zoom-reset')?.click();
      await sleep(200);
      // (c) pinch 2 jari: jarak 100 → 120 = zoom ×1.2
      firePtr('pointerdown', 200, 100, 1);
      firePtr('pointerdown', 300, 100, 2);
      firePtr('pointermove', 190, 100, 1);
      firePtr('pointermove', 310, 100, 2);
      firePtr('pointerup', 190, 100, 1);
      firePtr('pointerup', 310, 100, 2);
      await sleep(200);
      check('Kamera: pinch → zoom scale(1.2)', svgNow.style.transform.includes('scale(1.2)'), `transform=${svgNow.style.transform}`);
      document.querySelector('#map-zoom-reset')?.click();
      await sleep(200);
      // (d) klik tepat setelah drag diabaikan; klik bersih setelahnya jalan
      firePtr('pointerdown', 260, 130, 1);
      firePtr('pointermove', 200, 100, 1);
      firePtr('pointerup', 200, 100, 1);
      const jktPoly2 = document.querySelector('.map-region-g[data-name="jakarta"] .map-region');
      jktPoly2.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await sleep(200);
      check('Kamera: klik setelah drag diabaikan (Jakarta tidak .selected)', !document.querySelector('.map-region-g[data-name="jakarta"].selected'));
      await sleep(350);
      jktPoly2.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await sleep(1500);
      check('Kamera: klik bersih setelah jeda memilih Jakarta', !!document.querySelector('.map-region-g[data-name="jakarta"].selected'));
    }

    // --- (9) RUTE PERJALANAN (v5.7.5): garis rute + hitung mundur berdetak ---
    const db2 = new DatabaseSync(DB_PATH);
    db2.prepare("UPDATE citizens SET travel_to_region_id = (SELECT id FROM regions WHERE name = 'Jakarta'), travel_arrives_at = ? WHERE user_id = (SELECT id FROM users WHERE username = 'warga_peta')").run(Date.now() + 8000);
    db2.close();
    // ME di-cache di klien (route() tidak me-refresh) — segarkan dulu
    // supaya travel yang baru ditulis ke DB terbaca halaman peta.
    check('Rute: refreshMe tersedia (ME segar)', typeof window.refreshMe === 'function');
    if (typeof window.refreshMe === 'function') await window.refreshMe();
    window.location.hash = '#/dashboard';
    await sleep(1500);
    window.location.hash = '#/map';
    await sleep(1800);
    check('Rute: garis rute (.map-route) tampil', !!document.querySelector('.map-route'));
    check('Rute: cincin tujuan (.map-dest-ring) tampil', !!document.querySelector('.map-dest-ring'));
    const destLabel = document.querySelector('.map-dest-label')?.textContent || '';
    check('Rute: label tujuan JAKARTA tampil', destLabel.includes('JAKARTA'), destLabel);
    check('Rute: banner transit + hitung mundur ada', !!document.querySelector('#map-transit-countdown'));
    const travelChip = document.querySelector('#map-travel-countdown');
    check('Rute: chip hitung mundur ada + "0 mnt"', !!travelChip && (travelChip.textContent || '').includes('0 mnt'), travelChip?.textContent || '');
    await sleep(7000);
    check('Rute: hitung mundur berdetak jadi "sebentar lagi" saat tiba', (document.querySelector('#map-travel-countdown')?.textContent || '').includes('sebentar lagi'), document.querySelector('#map-travel-countdown')?.textContent || '');

    // --- (10) WORLD DOMINION (v5.7.5): overlay + lapisan + Lokasi saya ---
    const wrap10 = document.querySelector('#big-map-wrap');
    const svg10 = document.querySelector('#big-map');
    check('WD: kontrol cari ada di overlay kiri atas', !!document.querySelector('.map-overlay-tl #map-search'));
    check('WD: slider + Lokasi saya ada di overlay kanan atas', !!document.querySelector('.map-overlay-tr #map-zoom-slider') && !!document.querySelector('.map-overlay-tr #map-locate-me'));
    check('WD: panel Lapisan Peta ada di kiri bawah', !!document.querySelector('.map-overlay-bl #map-layer-politics') && !!document.querySelector('.map-overlay-bl #map-layer-pop') && !!document.querySelector('.map-overlay-bl #map-layer-war'));
    check('WD: CSS punya @keyframes warPulse', css.includes('@keyframes warPulse'));
    check('WD: CSS panel peta full-bleed (margin -14px)', css.includes('margin-left: -14px'));
    check('WD: CSS laut gelap (#070b14)', css.includes('.map-ocean { fill: #070b14; }'));
    check('WD: 17 teks populasi (.map-pop) ada di DOM', document.querySelectorAll('.map-pop').length === 17, `n=${document.querySelectorAll('.map-pop').length}`);
    // Lapisan: default Politik + Perang aktif, Populasi mati.
    check('WD: lapisan Politik aktif default', !!wrap10?.classList.contains('map-layer-politics') && !!document.querySelector('#map-layer-politics.active'));
    check('WD: lapisan Perang aktif default', !!wrap10?.classList.contains('map-layer-war') && !!document.querySelector('#map-layer-war.active'));
    check('WD: lapisan Populasi mati default', !wrap10?.classList.contains('map-layer-pop') && !document.querySelector('#map-layer-pop.active'));
    document.querySelector('#map-layer-pop')?.click();
    await sleep(200);
    check('WD: klik Populasi → lapisan aktif', !!wrap10?.classList.contains('map-layer-pop') && !!document.querySelector('#map-layer-pop.active'));
    document.querySelector('#map-layer-politics')?.click();
    await sleep(200);
    check('WD: klik Politik → lapisan mati', !wrap10?.classList.contains('map-layer-politics') && !document.querySelector('#map-layer-politics.active'));
    document.querySelector('#map-layer-politics')?.click();
    await sleep(200);
    check('WD: klik Politik lagi → lapisan aktif kembali', !!wrap10?.classList.contains('map-layer-politics'));
    // Slider zoom → scale(2).
    const slider = document.querySelector('#map-zoom-slider');
    check('WD: slider zoom ada', !!slider);
    if (slider) {
      slider.value = '2';
      slider.dispatchEvent(new window.Event('input', { bubbles: true }));
      await sleep(200);
      check('WD: slider ke 2 → transform scale(2)', (svg10.style.transform || '').includes('scale(2)'), `transform=${svg10.style.transform}`);
      document.querySelector('#map-zoom-reset')?.click();
      await sleep(200);
    }
    // Lokasi saya: kamera terbang ke wilayah pemain (zoom 2×, marker tengah).
    const myRegion10 = regions.find((x) => x.id === mineId);
    check('WD: wilayah pemain diketahui (untuk Lokasi saya)', !!myRegion10?.coords, JSON.stringify(myRegion10?.coords));
    document.querySelector('#map-locate-me')?.click();
    await sleep(300);
    {
      const t = svg10.style.transform || '';
      const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(t);
      // Hitung harapan dari rumus yang sama dengan app.js (MAP_PROJ:
      // lon 94–142, lat -11–6; fallback wadah 800×300).
      const mx = ((myRegion10.coords[1] - 94) / 48) * 1000;
      const my = ((6 - myRegion10.coords[0]) / 17) * 360;
      const px = (mx * 800) / 1000;
      const py = (my * 800) / 1000;
      const expTx = Math.min(0, Math.max(-800, 400 - px * 2));
      const expTy = Math.min(0, Math.max(-276, 150 - py * 2));
      const ok = !!m && m[3] === '2' && Math.abs(parseFloat(m[1]) - expTx) < 1.5 && Math.abs(parseFloat(m[2]) - expTy) < 1.5;
      check('WD: Lokasi saya → zoom 2× + marker di tengah', ok, `transform=${t} harapan=translate(${expTx.toFixed(1)}px, ${expTy.toFixed(1)}px) scale(2)`);
    }
    document.querySelector('#map-zoom-reset')?.click();
    await sleep(200);
    // Perang: buat 1 perang aktif di Jakarta lewat DB → grup Jakarta .map-war.
    const db3 = new DatabaseSync(DB_PATH);
    db3.prepare("INSERT INTO wars (name, region_id, attacker_label, status, ends_at, created_at) VALUES ('Perang Tes', (SELECT id FROM regions WHERE name = 'Jakarta'), 'Penyerang Tes', 'active', ?, ?)").run(Date.now() + 3600000, Date.now());
    db3.close();
    window.location.hash = '#/dashboard';
    await sleep(1500);
    window.location.hash = '#/map';
    await sleep(1800);
    const jktWar = document.querySelector('.map-region-g[data-name="jakarta"].map-war');
    check('WD: wilayah berperang aktif (Jakarta) bertanda .map-war', !!jktWar);
    check('WD: lencana ⚔️ ada di grup Jakarta', !!jktWar?.querySelector('.map-war-badge'));
    document.querySelector('#map-layer-war')?.click();
    await sleep(200);
    check('WD: klik Perang → lapisan mati', !document.querySelector('#big-map-wrap')?.classList.contains('map-layer-war'));
    document.querySelector('#map-layer-war')?.click();
    await sleep(200);
    check('WD: klik Perang lagi → lapisan aktif kembali', !!document.querySelector('#big-map-wrap')?.classList.contains('map-layer-war'));
  } finally {
    if (dom) dom.window.close();
    stop();
  }

  console.log(`\n[map-dom] ${passed} lolos, ${failed} gagal.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
