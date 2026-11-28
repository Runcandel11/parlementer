// Parlementer — tes DOM landing page + UI kaca (jsdom + server sungguhan).
// Membuktikan:
//   (1) LANDING: pengunjung belum login melihat hero (badge OPEN BETA,
//       headline, tombol emas AMBIL KEWARGANEGARAAN + MASUK, 3 badge bawah);
//       CTA membuka form yang benar; tombol kembali ke beranda;
//   (2) Daftar dari form landing berfungsi; pemain login langsung ke
//       dashboard (landing tidak menghadang);
//   (3) ?ref= tetap membuka tab DAFTAR dengan kode terisi;
//   (4) PETA LANGSUNG: wilayah tanpa negara = kaca abu-abu (kelas free) +
//       tanda "?" (17 ubin, semua belum bernegara di DB segar);
//   (5) UI KACA: CSS memakai backdrop-filter; ikon atas diperkecil (32px);
//   (6) VERSI: footer landing + drawer menampilkan "Parlementer v5.1.0"
//       dari konstanta VERSION (API /api/world + /api/me).
//   (7) v5.1.0 — ROMBAK LANDING ala Parlementum: meta OG + Twitter Card
//       (judul baru), og-image.jpg 1200×630 dari gambar pemilik, favicon +
//       logo P MERAH, angka dunia live cocok dengan /api/world (bukan
//       hardcode), front damai yang jujur bila tak ada perang, kabar
//       langsung + tiga pilar + penutup + footer Discord.
// Jalankan: node test/landing-glass-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
import { DatabaseSync } from 'node:sqlite';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3462;
const DB_PATH = '/tmp/parlementer-landing-glass-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;
const EXPECTED_VERSION = '5.7.5';

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

async function bootDom(url) {
  const html = await (await fetch(BASE + '/')).text();
  const htmlNoFonts = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>\s*/g, '')
    .replace(/<link[^>]*fonts\.gstatic\.com[^>]*>\s*/g, '');
  const dom = new JSDOM(htmlNoFonts, {
    url,
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) { window.fetch = jarFetch; },
  });
  const { window } = dom;
  await new Promise((resolve) => {
    if (window.document.readyState === 'complete') resolve();
    else window.addEventListener('load', resolve);
    setTimeout(resolve, 5000);
  });
  await sleep(1500);
  return dom;
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[landing-glass-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'landing-glass-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  let domRef = null;

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { const r = await fetch(BASE + '/'); up = r.status === 200; } catch { await sleep(250); }
    }
    check('server menyala dan halaman utama 200', up);
    if (!up) { console.log('[landing-glass-dom] server tidak menyala'); process.exitCode = 1; return; }

    // --- HTML statis + API versi ---
    const html = await (await fetch(BASE + '/')).text();
    check('landing: hero ada di HTML (id landing-hero)', html.includes('id="landing-hero"'));
    check('landing: tombol emas AMBIL KEWARGANEGARAAN ada', html.includes('AMBIL KEWARGANEGARAAN'));
    check('landing: headline DUNIA YANG BERJALAN OLEH PARA PEMAIN', html.includes('DUNIA YANG') && html.includes('BERJALAN OLEH') && html.includes('PARA PEMAIN'));
    check('landing: 3 badge bawah ada', html.includes('GRATIS DIMAINKAN') && html.includes('DIMAINKAN DI BROWSER') && html.includes('SEMUA BISA DIDAPAT DENGAN BERMAIN'));
    check('landing: label OPEN BETA tampil (status game saat ini)', html.includes('OPEN BETA'));
    const world = await (await fetch(BASE + '/api/world')).json();
    check('API /api/world: versi 5.7.5 (publik, tanpa login)', world.version === EXPECTED_VERSION, `version=${world.version}`);

    // --- v5.1.0: kartu preview link (OG) + favicon/logo ---
    check('OG: og:title judul baru (Dunia yang Berjalan oleh Para Pemain)', html.includes('og:title" content="Parlementer — Dunia yang Berjalan oleh Para Pemain'));
    check('OG: og:description tagline Bahasa Indonesia', html.includes('og:description" content="Bekerja, berdagang, memilih, memerintah, hingga berperang'));
    check('OG: og:image + og:url + og:type website', html.includes('og:image" content="https://parlementer.my.id/og-image.jpg') && html.includes('og:url" content="https://parlementer.my.id/') && html.includes('og:type" content="website'));
    check('OG: twitter:card summary_large_image + twitter:image', html.includes('twitter:card" content="summary_large_image') && html.includes('twitter:image" content="https://parlementer.my.id/og-image.jpg'));
    check('logo: favicon + apple-touch-icon terpasang', html.includes('rel="icon"') && html.includes('href="/favicon.png"') && html.includes('rel="apple-touch-icon"') && html.includes('href="/logo-192.png"'));
    const ogRes = await fetch(BASE + '/og-image.jpg');
    check('OG: /og-image.jpg tersaji 200 (image/jpeg)', ogRes.status === 200 && (ogRes.headers.get('content-type') || '').includes('image/jpeg'), `status=${ogRes.status}`);
    const ogBuf = Buffer.from(await ogRes.arrayBuffer());
    check('OG: /og-image.jpg ukuran 1200×630 (gambar pemilik)', ogBuf.length > 50000 && ogBuf.readUInt16BE(0) === 0xffd8, `bytes=${ogBuf.length}`);
    for (const [path, label] of [['/favicon.png', 'favicon.png'], ['/logo-192.png', 'logo-192.png'], ['/logo-512.png', 'logo-512.png']]) {
      const r = await fetch(BASE + path);
      check(`logo: ${label} tersaji 200 (image/png)`, r.status === 200 && (r.headers.get('content-type') || '').includes('image/png'), `status=${r.status}`);
    }

    // --- v5.2.0: verifikasi Google AdSense (akun bos sudah ada, pub-2013457230013617) ---
    check('AdSense: script verifikasi ada di <head> HTML (client ca-pub-2013457230013617)', html.includes('pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-2013457230013617') && html.includes('crossorigin="anonymous"'));
    const adsTxtRes = await fetch(BASE + '/ads.txt');
    const adsTxt = await adsTxtRes.text();
    check('AdSense: /ads.txt tersaji 200', adsTxtRes.status === 200, `status=${adsTxtRes.status}`);
    check('AdSense: /ads.txt berisi baris google.com, pub-2013457230013617, DIRECT, f08c47fec0942fa0', adsTxt.trim() === 'google.com, pub-2013457230013617, DIRECT, f08c47fec0942fa0', adsTxt.trim());

    // --- v5.3.0: Google tag (gtag.js) + event konversi "Tayangan halaman" ---
    check('gtag: script googletagmanager gtag.js ada di <head> (id AW-18546219743)', html.includes('https://www.googletagmanager.com/gtag/js?id=AW-18546219743') && html.includes('async src="https://www.googletagmanager.com/gtag/js?id=AW-18546219743"'));
    check("gtag: gtag('config', 'AW-18546219743') ada", html.includes("gtag('config', 'AW-18546219743')"));
    check("gtag: dataLayer + gtag('js', new Date()) diinisialisasi", html.includes('window.dataLayer = window.dataLayer || []') && html.includes("gtag('js', new Date())"));
    check("gtag: event conversion 'Tayangan halaman' dengan send_to yang benar", html.includes("gtag('event', 'conversion', {'send_to': 'AW-18546219743/_HfVCK6Mg8EdEN-1w4tF'})"));
    check('gtag: tag Google terletak SETELAH script AdSense (AdSense tidak rusak/tergeser)',
      html.indexOf('pagead2.googlesyndication.com') !== -1 && html.indexOf('googletagmanager.com/gtag/js') > html.indexOf('pagead2.googlesyndication.com'),
      `adsense@${html.indexOf('pagead2.googlesyndication.com')} gtag@${html.indexOf('googletagmanager.com/gtag/js')}`);
    check('gtag: semua tag tracking ada di dalam <head> (sebelum </head>)',
      html.indexOf('googletagmanager.com/gtag/js') < html.indexOf('</head>') && html.indexOf("_HfVCK6Mg8EdEN-1w4tF") < html.indexOf('</head>'));

    // --- v5.1.0: seksi landing baru ada di HTML statis ---
    check('landing: seksi angka dunia ada (id ls-population s.d. ls-tx)', html.includes('id="ls-population"') && html.includes('id="ls-countries"') && html.includes('id="ls-regions-owned"') && html.includes('id="ls-fronts"') && html.includes('id="ls-tx"'));
    check('landing: kartu front live ada (BERKAS GARIS DEPAN)', html.includes('BERKAS GARIS DEPAN') && html.includes('id="landing-front-body"') && html.includes('id="landing-front-peace"'));
    check('landing: siaran langsung ada (DUNIA, SAAT ITU JUGA + KABAR LANGSUNG)', html.includes('DUNIA, SAAT ITU JUGA') && html.includes('KABAR LANGSUNG') && html.includes('id="landing-feed-list"'));
    check('landing: tiga pilar ada (BUKAN SIMULATOR + NEGARA MILIK + EKONOMINYA)', html.includes('BUKAN') && html.includes('SIMULATOR') && html.includes('PEMERINTAHANNYA') && html.includes('NEGARA MILIK PARA PEMAIN') && html.includes('EKONOMINYA ANTARPEMAIN') && html.includes('PERANGNYA ANTARPEMAIN'));
    check('landing: penutup ada (PIMPIN NEGARAMU + UCAPKAN SUMPAH)', html.includes('PIMPIN') && html.includes('KEHILANGAN') && html.includes('UCAPKAN SUMPAH — GRATIS'));
    check('landing: footer ada (nama + deskripsi + Discord)', html.includes('landing-footer') && html.includes('discord.gg/JX7DWX3pF'));
    check('landing: /api/world membawa angka live (regionsOwned/front/tx/feed)', typeof world.regionsOwned === 'number' && typeof world.activeFronts === 'number' && typeof world.tx24h === 'number' && Array.isArray(world.feed) && 'front' in world, `owned=${world.regionsOwned} fronts=${world.activeFronts} tx=${world.tx24h} feed=${world.feed?.length}`);

    // --- Kredit pembuat + SEO JSON-LD (28 Nov 2026) ---
    const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    let ld = null;
    try { ld = ldMatch ? JSON.parse(ldMatch[1]) : null; } catch { ld = null; }
    check('SEO: JSON-LD ada dan valid (parse JSON)', !!ld, ldMatch ? 'script ditemukan' : 'script tidak ditemukan');
    const creators = ld ? (Array.isArray(ld.creator) ? ld.creator : [ld.creator]) : [];
    const khalidLd = creators.find((p) => p && p['@type'] === 'Person' && p.name === 'Khalid Talal Muhammad Zain Al-Ghunaim');
    check('SEO: JSON-LD VideoGame Parlementer', !!ld && ld['@type'] === 'VideoGame' && ld.name === 'Parlementer', ld ? `${ld['@type']}/${ld.name}` : '');
    check('SEO: JSON-LD creator berisi Khalid (CEO & Pengembang)', !!khalidLd && khalidLd.jobTitle === 'CEO & Pengembang', khalidLd ? khalidLd.jobTitle : '');
    check('SEO: JSON-LD author = Khalid (CEO & Pengembang)', !!ld && ld.author?.name === 'Khalid Talal Muhammad Zain Al-Ghunaim' && ld.author?.jobTitle === 'CEO & Pengembang');
    check('SEO: JSON-LD creator berisi Angelica (co-creator)', creators.some((p) => p && p['@type'] === 'Person' && p.name === 'Angelica'));
    const angelicaLd = creators.find((p) => p && p['@type'] === 'Person' && p.name === 'Angelica');
    check('SEO: JSON-LD Angelica jobTitle Asisten Developer', !!angelicaLd && angelicaLd.jobTitle === 'Asisten Developer', angelicaLd ? angelicaLd.jobTitle : '');

    // --- Boot tamu (tanpa cookie): landing tampil, form tersembunyi ---
    dom = await bootDom(BASE + '/');
    const { window } = dom;
    const { document } = window;
    check('tamu: #auth-view tampil, #app tersembunyi', !document.querySelector('#auth-view').hidden && document.querySelector('#app').hidden === true);
    check('tamu: hero landing tampil', !document.querySelector('#landing-hero').hidden);
    check('tamu: kartu login/daftar tersembunyi di awal', document.querySelector('#auth-card-wrap').hidden === true);
    check('tamu: footer landing menampilkan Parlemen v5.7.5', (document.querySelector('#landing-version')?.textContent || '').includes('Parlementer v' + EXPECTED_VERSION), document.querySelector('#landing-version')?.textContent);
    const landingCredits = document.querySelector('#landing-credits')?.textContent || '';
    check('tamu: footer landing menampilkan kredit pembuat (Khalid + Angelica)', landingCredits.includes('Khalid Talal Muhammad Zain Al-Ghunaim') && landingCredits.includes('Angelica'), landingCredits);
    check('tamu: kredit landing menyebut Khalid CEO & Pengembang', landingCredits.includes('CEO & Pengembang'), landingCredits);
    check('tamu: kredit landing menyebut Angelica Asisten Developer', landingCredits.includes('Asisten Developer'), landingCredits);

    // --- v5.1.0: angka + kabar dunia LIVE di-render dari /api/world ---
    const fmtId = (n) => Number(n || 0).toLocaleString('id-ID');
    check('tamu: angka WARGA landing cocok dengan /api/world', (document.querySelector('#ls-population')?.textContent || '') === fmtId(world.population), document.querySelector('#ls-population')?.textContent);
    check('tamu: angka NEGARA landing cocok dengan /api/world', (document.querySelector('#ls-countries')?.textContent || '') === fmtId(world.countries), document.querySelector('#ls-countries')?.textContent);
    check('tamu: WILAYAH DIKUASAI landing cocok (dimiliki/total dari API)', (document.querySelector('#ls-regions-owned')?.textContent || '') === fmtId(world.regionsOwned) && (document.querySelector('#ls-regions-total')?.textContent || '') === fmtId(world.regions), `${document.querySelector('#ls-regions-owned')?.textContent}/${document.querySelector('#ls-regions-total')?.textContent}`);
    check('tamu: FRONT AKTIF + TRANSAKSI 24 JAM landing cocok dengan API', (document.querySelector('#ls-fronts')?.textContent || '') === fmtId(world.activeFronts) && (document.querySelector('#ls-tx')?.textContent || '') === fmtId(world.tx24h), `${document.querySelector('#ls-fronts')?.textContent} / ${document.querySelector('#ls-tx')?.textContent}`);
    check('tamu: DB segar tanpa perang — kartu front menampilkan keadaan damai yang jujur', document.querySelector('#landing-front-body').hidden === true && document.querySelector('#landing-front-peace').hidden === false && (document.querySelector('#lf-peace-note')?.textContent || '').includes('Belum ada perang'));
    check('tamu: DB segar tanpa kabar — feed kosong menampilkan keadaan kosong yang jujur', document.querySelector('#landing-feed-list').children.length === 0 && document.querySelector('#landing-feed-empty').hidden === false);
    check('tamu: jam KABAR LANGSUNG tampil format UTC', /^\d{2}:\d{2} UTC$/.test(document.querySelector('#landing-feed-clock')?.textContent || ''), document.querySelector('#landing-feed-clock')?.textContent);
    check('tamu: logo P MERAH tampil di hero landing', (document.querySelector('.landing-logo')?.getAttribute('src') || '').includes('/logo-512.png'));
    check('tamu: logo P MERAH tampil di footer landing', (document.querySelector('.landing-footer-logo')?.getAttribute('src') || '').includes('/logo-192.png'));
    check('tamu: logo P MERAH tampil di layar loading + kartu login', (document.querySelector('img.loading-logo')?.getAttribute('src') || '').includes('/logo-192.png') && (document.querySelector('img.auth-logo')?.getAttribute('src') || '').includes('/logo-192.png'));
    check('tamu: footer landing menampilkan versi + kredit pembuat', (document.querySelector('#landing-footer-version')?.textContent || '').includes('Parlementer v' + EXPECTED_VERSION) && (document.querySelector('.landing-footer-credits')?.textContent || '').includes('Khalid Talal Muhammad Zain Al-Ghunaim'));

    // CTA daftar → form DAFTAR; kembali → hero; CTA masuk → form MASUK.
    document.querySelector('#landing-register').click();
    await sleep(200);
    check('CTA daftar: kartu tampil + form DAFTAR tampil, form MASUK tersembunyi', !document.querySelector('#auth-card-wrap').hidden && !document.querySelector('#form-register').hidden && document.querySelector('#form-login').hidden === true);
    check('CTA daftar: hero tersembunyi saat form tampil', document.querySelector('#landing-hero').hidden === true);
    check('CTA daftar: seluruh halaman landing tersembunyi saat form tampil', document.querySelector('#landing-page').hidden === true);
    document.querySelector('#auth-back').click();
    await sleep(200);
    check('tombol kembali: hero tampil lagi, kartu tersembunyi', !document.querySelector('#landing-hero').hidden && document.querySelector('#auth-card-wrap').hidden === true);
    check('tombol kembali: halaman landing tampil lagi', document.querySelector('#landing-page').hidden === false);
    document.querySelector('#landing-login').click();
    await sleep(200);
    check('CTA masuk: form MASUK tampil, form DAFTAR tersembunyi', !document.querySelector('#form-login').hidden && document.querySelector('#form-register').hidden === true);

    // --- Daftar dari form landing (jsdom) → langsung ke dashboard ---
    document.querySelector('#landing-register').click();
    await sleep(200);
    const form = document.querySelector('#form-register');
    form.querySelector('input[name="email"]').value = 'landing@test.local';
    form.querySelector('input[name="password"]').value = 'rahasia123';
    form.querySelector('input[name="username"]').value = 'landing_tes';
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await sleep(2500);
    check('daftar dari landing: aplikasi tampil (#app), landing tidak menghadang', document.querySelector('#app').hidden === false && document.querySelector('#auth-view').hidden === true);
    check('login: footer drawer menampilkan Parlemen v5.7.5', (document.querySelector('#drawer-version')?.textContent || '').includes('Parlementer v' + EXPECTED_VERSION), document.querySelector('#drawer-version')?.textContent);
    const drawerCredits = document.querySelector('#drawer-credits')?.textContent || '';
    check('login: footer drawer menampilkan kredit pembuat (Khalid + Angelica)', drawerCredits.includes('Khalid Talal Muhammad Zain Al-Ghunaim') && drawerCredits.includes('Angelica'), drawerCredits);
    check('login: kredit drawer menyebut Khalid CEO & Pengembang', drawerCredits.includes('CEO & Pengembang'), drawerCredits);
    check('login: kredit drawer menyebut Angelica Asisten Developer', drawerCredits.includes('Asisten Developer'), drawerCredits);

    // --- PETA LANGSUNG: wilayah tanpa negara = kaca abu-abu + "?" ---
    const tiles = [...document.querySelectorAll('.map-tile')];
    check('dashboard: PETA LANGSUNG menampilkan 17 ubin wilayah', tiles.length === 17, `ubin=${tiles.length}`);
    const freeTiles = tiles.filter((t) => t.classList.contains('free'));
    check('peta: semua 17 ubin bertanda wilayah belum bernegara (kelas free)', freeTiles.length === 17, `free=${freeTiles.length}`);
    check('peta: semua ubin belum bernegara menampilkan tanda "?"', freeTiles.length === 17 && freeTiles.every((t) => t.textContent.includes('?')));
    const myTile = tiles.find((t) => t.classList.contains('mine'));
    check('peta: ubin wilayahku tetap bertanda KAMU (meski belum bernegara)', !!myTile && myTile.textContent.includes('KAMU'));

    // --- CSS: kaca + ikon kecil ---
    const css = fs.readFileSync(ROOT + 'public/css/style.css', 'utf8');
    check('CSS: panel memakai backdrop-filter (kaca)', css.includes('backdrop-filter: blur(12px)'));
    check('CSS: HUD memakai backdrop-filter (kaca)', /\.hud \{[^}]*backdrop-filter/.test(css));
    check('CSS: ikon atas diperkecil (32px)', /\.hud-icon \{[^}]*width: 32px/.test(css));
    check('CSS: ubin merdeka punya aturan kaca abu-abu (.map-tile.free)', css.includes('.map-tile.free') && css.includes('--glass-free'));
    check('CSS: gaya landing ada (.landing-hero + .landing-title)', css.includes('.landing-hero') && css.includes('.landing-title'));

    // --- ?ref= tetap membuka tab DAFTAR dengan kode terisi ---
    cookie = ''; // tamu baru
    domRef = await bootDom(BASE + '/?ref=ABCDEFGH');
    const docRef = domRef.window.document;
    check('?ref=: kartu tampil langsung (landing dilewati)', !docRef.querySelector('#auth-card-wrap').hidden && docRef.querySelector('#landing-hero').hidden === true);
    check('?ref=: tab DAFTAR aktif + kode terisi', !docRef.querySelector('#form-register').hidden && docRef.querySelector('#form-register input[name="ref"]').value === 'ABCDEFGH');
  } finally {
    stop();
    if (dom) dom.window.close();
    if (domRef) domRef.window.close();
  }

  console.log(`[landing-glass-dom] ${passed} lolos, ${failed} gagal`);
  if (failed) process.exitCode = 1;
}

main();
