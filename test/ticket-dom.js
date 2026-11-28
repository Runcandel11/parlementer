// Parlementer — tes DOM fitur tiket v4.0.0 (jsdom + server sungguhan).
// Membuktikan di UI (bukan cuma API):
//   (1) #22/#18 Dashboard INVENTARIS menampilkan SEMUA barang + jumlahnya
//       (termasuk tier 2 — dulu hanya kartu T1 maks 6);
//   (2) #21 Chip "🌙 JAM GANDA XP ×2" muncul saat 00:00–01:00 WIB dan
//       hilang di luar jam itu (jam WIB di-mock lewat Intl);
//   (3) #11 Foto profil mengikuti aspek asli: foto lebar 400×200 di-resize
//       jadi 256×128 (bukan kotak 256×256), foto tegak 200×400 jadi
//       128×256; hero profil memakai .profile-photo (bukan lingkaran crop);
//   (4) #23 Pasar: tombol Ubah di Penawaranku + Order Beliku, form inline,
//       simpan mengubah jumlah di server;
//   (5) #20 Konvoi: resep bahan + jumlah dimiliki tampil, tombol BANGUN
//       nonaktif bila bahan kurang, aktif + membangun bila cukup;
//   (6) #17 Minuman Energi: panel di inventaris, beli 0,10 emas/kaleng,
//       tombol Minum +1 energi (dibatasi cap);
//   (7) #16 Notifikasi: tab Terbaru | Sistem | Pasar memfilter daftar;
//   (8) #14 Pengaturan: daftar pemain diblokir + tombol Buka Blokir.
// Jalankan: node test/ticket-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
import { DatabaseSync } from 'node:sqlite';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3468;
const DB_PATH = '/tmp/parlementer-ticket-dom.db';
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
      // --- Stub Image + canvas (jsdom tidak decode gambar) ---
      window.__stubImageSize = { width: 800, height: 600 };
      window.__mockWibHour = null;
      window.URL.createObjectURL = () => 'blob:stub';
      window.URL.revokeObjectURL = () => {};
      window.Image = class {
        constructor() { const s = window.__stubImageSize || { width: 800, height: 600 }; this.width = s.width; this.height = s.height; this._src = ''; }
        set src(v) {
          this._src = v;
          setTimeout(() => { if (typeof this.onload === 'function') this.onload(); }, 0);
        }
        get src() { return this._src; }
      };
      window.HTMLCanvasElement.prototype.getContext = function () {
        return { drawImage() {} };
      };
      window.HTMLCanvasElement.prototype.toDataURL = function () {
        return 'data:image/jpeg;base64,' + 'x'.repeat(100);
      };
      // Rekam semua canvas yang dibuat supaya ukuran hasil resize avatar
      // bisa diperiksa (aspek dipertahankan atau tidak).
      window.__canvases = [];
      const origCreate = window.document.createElement.bind(window.document);
      window.document.createElement = function (tag, ...rest) {
        const el = origCreate(tag, ...rest);
        if (String(tag).toLowerCase() === 'canvas') window.__canvases.push(el);
        return el;
      };
      // Mock jam WIB: hanya pemformat jam Asia/Jakarta yang diintersep
      // (dipakai wibHourNow); pemformat tanggal lain tetap asli.
      const RealDTF = window.Intl.DateTimeFormat;
      window.Intl.DateTimeFormat = function (locale, opts) {
        const inst = new RealDTF(locale, opts);
        if (opts && opts.timeZone === 'Asia/Jakarta' && opts.hour === 'numeric') {
          // format di prototipe Intl hanya getter — timpa via defineProperty.
          const realFormat = inst.format.bind(inst);
          Object.defineProperty(inst, 'format', {
            value: (d) => (window.__mockWibHour !== null && window.__mockWibHour !== undefined ? String(window.__mockWibHour) : realFormat(d)),
            configurable: true,
          });
        }
        return inst;
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

async function goto(dom, hash) {
  dom.window.location.hash = hash;
  dom.window.route();
  await sleep(1300);
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[ticket-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'ticket-dom-test-secret' },
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
    check('API /api/world: versi 5.7.5', world.version === '5.7.5', `version=${world.version}`);

    const jarA = makeJar();
    const jarB = makeJar();
    let r = await api(jarA, '/api/auth/register', { email: 'domTiket@test.local', password: 'rahasia123', username: 'warga_tiket' });
    check('Daftar warga_tiket (API)', r.status === 200 && r.data.ok);
    r = await api(jarB, '/api/auth/register', { email: 'domTiket2@test.local', password: 'rahasia123', username: 'warga_tiket_dua' });
    check('Daftar warga_tiket_dua (API)', r.status === 200 && r.data.ok);
    const meA = (await api(jarA, '/api/me', undefined, 'GET')).data;
    const meB = (await api(jarB, '/api/me', undefined, 'GET')).data;

    // Beri barang: Besi 30 + Gandum 20 (T1) + Besi T2 ×3 (pembeda #18:
    // panel lama hanya menampilkan T1, jadi T2 tidak akan kelihatan).
    const db = new DatabaseSync(DB_PATH);
    const comId = (name) => db.prepare('SELECT id FROM commodities WHERE name = ?').get(name)?.id;
    const besiId = comId('Besi Mentah');
    const gandumId = comId('Gandum Mentah');
    db.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,?)').run(meA.citizen.id, besiId, 30);
    db.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,?)').run(meA.citizen.id, gandumId, 20);
    db.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,2,?)').run(meA.citizen.id, besiId, 3);

    // --- (1) #18 Dashboard: inventaris lengkap ---
    dom = await bootDom(BASE + '/#/dashboard', jarA);
    let { window } = dom;
    let { document } = window;
    const gridText = document.querySelector('#dash-inv-grid')?.textContent || '';
    check('Dashboard inventaris: Besi Mentah tampil', gridText.includes('Besi Mentah'), gridText.slice(0, 120));
    check('Dashboard inventaris: Gandum Mentah tampil', gridText.includes('Gandum Mentah'));
    check('Dashboard inventaris: barang awal (Makanan, Senjata, Tiket) tampil', gridText.includes('Makanan') && gridText.includes('Senjata') && gridText.includes('Tiket'));
    check('Dashboard inventaris: tier 2 tampil (bukan hanya T1)', gridText.includes('T2'), gridText.slice(0, 200));

    // --- (2) #21 Chip jam ganda (jam WIB di-mock) ---
    window.__mockWibHour = '0';
    check('Jam ganda: isDoubleXpNow() true saat WIB 00:xx', window.isDoubleXpNow() === true);
    check('Jam ganda: chip berisi "JAM GANDA XP ×2" saat WIB 00:xx', window.doubleXpChip().includes('JAM GANDA XP ×2'));
    await goto(dom, '#/jobs');
    check('Jam ganda: chip tampil di halaman pekerjaan saat WIB 00:xx', (document.querySelector('#page')?.textContent || '').includes('JAM GANDA XP ×2'));
    window.__mockWibHour = '12';
    check('Jam ganda: isDoubleXpNow() false saat WIB 12:xx', window.isDoubleXpNow() === false);
    check('Jam ganda: chip kosong di luar jam ganda', window.doubleXpChip() === '');
    window.route();
    await sleep(1300);
    check('Jam ganda: chip hilang dari halaman pekerjaan di luar jam ganda', !(document.querySelector('#page')?.textContent || '').includes('JAM GANDA XP ×2'));
    window.__mockWibHour = null;
    await goto(dom, '#/dashboard');

    // --- (3) #11 Foto profil mengikuti aspek asli ---
    const mkFile = (name, type) => new window.File(['isi-palsu'], name, { type });
    window.__stubImageSize = { width: 400, height: 200 };
    let before = window.__canvases.length;
    let res = await window.processAvatarFile(mkFile('lebar.jpg', 'image/jpeg'));
    let fresh = window.__canvases.slice(before);
    check('Avatar lebar 400×200 diterima', !!res.avatar && res.avatar.startsWith('data:image/jpeg;base64,'));
    check('Avatar lebar: canvas utama 256×128 (aspek dipertahankan, bukan 256×256)', fresh[0]?.width === 256 && fresh[0]?.height === 128, `canvas=${fresh[0]?.width}×${fresh[0]?.height}`);
    check('Avatar lebar: thumbnail 48×24 (aspek ikut)', fresh[1]?.width === 48 && fresh[1]?.height === 24, `thumb=${fresh[1]?.width}×${fresh[1]?.height}`);
    window.__stubImageSize = { width: 200, height: 400 };
    before = window.__canvases.length;
    res = await window.processAvatarFile(mkFile('tegak.jpg', 'image/jpeg'));
    fresh = window.__canvases.slice(before);
    check('Avatar tegak 200×400 diterima', !!res.avatar);
    check('Avatar tegak: canvas utama 128×256 (aspek dipertahankan)', fresh[0]?.width === 128 && fresh[0]?.height === 256, `canvas=${fresh[0]?.width}×${fresh[0]?.height}`);
    check('Avatar tegak: thumbnail 24×48 (aspek ikut)', fresh[1]?.width === 24 && fresh[1]?.height === 48, `thumb=${fresh[1]?.width}×${fresh[1]?.height}`);
    const photoHtml = window.profilePhotoHtml('data:image/jpeg;base64,xxx', 'warga_tiket');
    check('Hero profil: memakai .profile-photo (bukan lingkaran crop)', photoHtml.includes('class="profile-photo"') && !photoHtml.includes('avatar-img'));
    check('Hero profil tanpa foto: inisial 144px', window.profilePhotoHtml(null, 'warga_tiket').includes('avatar-initial'));

    // --- (4) #23 Pasar: tombol Ubah + form inline ---
    r = await api(jarA, '/api/market/sell', { scope: 'local', commodity_id: besiId, tier: 1, qty: 10, price: 9 });
    check('Pasar: pasang penawaran jual 10× Besi @9 (API)', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
    r = await api(jarA, '/api/market/buy-order', { scope: 'local', commodity_id: besiId, tier: 1, qty: 10, price: 9 });
    check('Pasar: pasang order beli 10× Besi @9 (API)', r.status === 200, `status=${r.status} ${r.data.error || ''}`);
    await goto(dom, '#/market');
    const offerBtn = document.querySelector('[data-edit-offer]');
    const orderBtn = document.querySelector('[data-edit-order]');
    check('Pasar: tombol Ubah ada di Penawaranku', !!offerBtn);
    check('Pasar: tombol Ubah ada di Order Beliku', !!orderBtn);
    offerBtn.click();
    await sleep(300);
    const offerId = offerBtn.dataset.editOffer;
    const editBox = document.querySelector('#edit-offer-' + offerId);
    check('Pasar: klik Ubah membuka form inline penawaran', !!editBox && !editBox.hidden);
    const qtyInput = editBox.querySelector('.edit-qty');
    check('Pasar: form terisi jumlah lama (10)', qtyInput && qtyInput.value === '10', `value=${qtyInput?.value}`);
    qtyInput.value = '15';
    editBox.querySelector('.edit-save').click();
    await sleep(1300);
    r = await api(jarA, '/api/market?scope=local', undefined, 'GET');
    check('Pasar: simpan Ubah → penawaran jadi 15 di server', (r.data.mine || []).some((o) => o.commodity_id === besiId && o.qty === 15), JSON.stringify((r.data.mine || []).map((o) => o.qty)));
    r = await api(jarA, '/api/inventory', undefined, 'GET');
    const besiAfterEdit = (r.data.items || []).find((i) => i.name === 'Besi Mentah' && i.tier === 1);
    check('Pasar: inventaris Besi 30−10−5 = 15 setelah tambah penawaran', besiAfterEdit?.qty === 15, `qty=${besiAfterEdit?.qty}`);
    await goto(dom, '#/market');
    const orderBtn2 = document.querySelector('[data-edit-order]');
    orderBtn2.click();
    await sleep(300);
    const orderId = orderBtn2.dataset.editOrder;
    const editBox2 = document.querySelector('#edit-order-' + orderId);
    check('Pasar: klik Ubah membuka form inline order beli', !!editBox2 && !editBox2.hidden);
    editBox2.querySelector('.edit-qty').value = '20';
    editBox2.querySelector('.edit-save').click();
    await sleep(1300);
    r = await api(jarA, '/api/market?scope=local', undefined, 'GET');
    check('Pasar: simpan Ubah → order beli jadi 20 di server', (r.data.myBuyOrders || []).some((o) => o.commodity_id === besiId && o.qty === 20), JSON.stringify((r.data.myBuyOrders || []).map((o) => o.qty)));

    // --- (5) #20 Konvoi: resep + tombol nonaktif bila bahan kurang ---
    await goto(dom, '#/convoy');
    let convoyText = document.querySelector('#page')?.textContent || '';
    check('Konvoi: resep RS Lapangan tampil (Gandum 20/20)', convoyText.includes('Gandum Mentah 20/20'), convoyText.slice(0, 300));
    check('Konvoi: resep menampilkan Besi dimiliki 15/30', convoyText.includes('Besi Mentah 15/30'));
    const buildBtn = document.querySelector('[data-build="health"]');
    check('Konvoi: tombol BANGUN nonaktif bila Besi kurang (15 < 30)', !!buildBtn && buildBtn.disabled === true, `disabled=${buildBtn?.disabled}`);
    db.prepare('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,?) ON CONFLICT (citizen_id, commodity_id, tier) DO UPDATE SET qty = inventory.qty + excluded.qty').run(meA.citizen.id, besiId, 15);
    await goto(dom, '#/convoy');
    convoyText = document.querySelector('#page')?.textContent || '';
    check('Konvoi: resep menampilkan Besi 30/30 setelah ditambah', convoyText.includes('Besi Mentah 30/30'));
    const buildBtn2 = document.querySelector('[data-build="health"]');
    check('Konvoi: tombol BANGUN aktif bila bahan cukup', !!buildBtn2 && buildBtn2.disabled === false, `disabled=${buildBtn2?.disabled}`);
    buildBtn2.click();
    await sleep(1300);
    r = await api(jarA, '/api/convoy', undefined, 'GET');
    check('Konvoi: RS Lapangan terbangun lewat UI', (r.data.convoys || []).some((c) => c.building === 'health'), JSON.stringify((r.data.convoys || []).map((c) => c.building)));
    r = await api(jarA, '/api/inventory', undefined, 'GET');
    const besiAfterConvoy = (r.data.items || []).find((i) => i.name === 'Besi Mentah' && i.tier === 1);
    const gandumAfterConvoy = (r.data.items || []).find((i) => i.name === 'Gandum Mentah' && i.tier === 1);
    check('Konvoi: bahan terpotong (Besi 0, Gandum 0)', (besiAfterConvoy?.qty || 0) === 0 && (gandumAfterConvoy?.qty || 0) === 0, `besi=${besiAfterConvoy?.qty} gandum=${gandumAfterConvoy?.qty}`);

    // --- (6) #17 Minuman Energi di inventaris ---
    await goto(dom, '#/inventory');
    check('Minuman Energi: panel ada di halaman inventaris', (document.querySelector('#page')?.textContent || '').includes('MINUMAN ENERGI'));
    check('Minuman Energi: harga 0,10 emas/kaleng tertulis', (document.querySelector('#page')?.textContent || '').includes('0,10 emas'));
    document.querySelector('#drink-buy-qty').value = '10';
    document.querySelector('#btn-drink-buy').click();
    await sleep(1300);
    r = await api(jarA, '/api/inventory', undefined, 'GET');
    const drinkAfterBuy = (r.data.items || []).find((i) => i.name === 'Minuman Energi');
    check('Minuman Energi: beli 10 kaleng lewat UI masuk inventaris', drinkAfterBuy?.qty === 10, `qty=${drinkAfterBuy?.qty}`);
    r = await api(jarA, '/api/me', undefined, 'GET');
    check('Minuman Energi: emas 50 → 49 setelah beli 10 kaleng', r.data.citizen.gold === 49, `emas=${r.data.citizen.gold}`);
    db.prepare('UPDATE citizens SET energy = 109, energy_updated_at = ? WHERE id = ?').run(Date.now(), meA.citizen.id);
    await goto(dom, '#/inventory');
    document.querySelector('#btn-drink').click();
    await sleep(1300);
    r = await api(jarA, '/api/me', undefined, 'GET');
    check('Minuman Energi: minum 1 kaleng → energi 109 → 110 (cap +10 RS Lapangan)', r.data.citizen.energy === 110, `energi=${r.data.citizen.energy}`);
    r = await api(jarA, '/api/inventory', undefined, 'GET');
    const drinkAfterDrink = (r.data.items || []).find((i) => i.name === 'Minuman Energi');
    check('Minuman Energi: sisa 9 kaleng setelah minum 1', drinkAfterDrink?.qty === 9, `qty=${drinkAfterDrink?.qty}`);

    // --- (7) #16 Tab notifikasi ---
    db.prepare('INSERT INTO notifications (citizen_id, category, title, content, is_read, created_at) VALUES (?,?,?,?,?,?)')
      .run(meA.citizen.id, 'EKONOMI', 'TiketDom Pasar: harga Besi naik', '', 0, Date.now());
    db.prepare('INSERT INTO notifications (citizen_id, category, title, content, is_read, created_at) VALUES (?,?,?,?,?,?)')
      .run(meA.citizen.id, 'SISTEM', 'TiketDom Sistem: selamat datang', '', 0, Date.now());
    await goto(dom, '#/notifications');
    const notifList = () => document.querySelector('#notif-list')?.textContent || '';
    check('Notifikasi: tab Terbaru menampilkan keduanya', notifList().includes('TiketDom Pasar') && notifList().includes('TiketDom Sistem'));
    check('Notifikasi: ada 3 tab (Terbaru | Sistem | Pasar)', ['terbaru', 'sistem', 'pasar'].every((t) => !!document.querySelector(`[data-ntab="${t}"]`)));
    document.querySelector('[data-ntab="pasar"]').click();
    await sleep(300);
    check('Notifikasi: tab Pasar hanya menampilkan EKONOMI', notifList().includes('TiketDom Pasar') && !notifList().includes('TiketDom Sistem'));
    document.querySelector('[data-ntab="sistem"]').click();
    await sleep(300);
    check('Notifikasi: tab Sistem hanya menampilkan non-EKONOMI', notifList().includes('TiketDom Sistem') && !notifList().includes('TiketDom Pasar'));
    document.querySelector('[data-ntab="terbaru"]').click();
    await sleep(300);
    check('Notifikasi: kembali ke Terbaru menampilkan keduanya', notifList().includes('TiketDom Pasar') && notifList().includes('TiketDom Sistem'));

    // --- (8) #14 Daftar blokir di Pengaturan ---
    r = await api(jarA, '/api/chat/block', { citizen_id: meB.citizen.id });
    check('Blokir: warga_tiket memblokir warga_tiket_dua (API)', r.status === 200 && r.data.ok);
    r = await api(jarA, '/api/chat/blocked', undefined, 'GET');
    check('Blokir: /api/chat/blocked berisi warga_tiket_dua', (r.data.blocked || []).some((b) => b.citizen_id === meB.citizen.id && b.username === 'warga_tiket_dua'), JSON.stringify(r.data.blocked));
    await goto(dom, '#/settings');
    check('Blokir: Pengaturan menampilkan warga_tiket_dua di daftar blokir', (document.querySelector('#page')?.textContent || '').includes('warga_tiket_dua'));
    const unblockBtn = document.querySelector('[data-unblock]');
    check('Blokir: tombol Buka Blokir ada per pemain', !!unblockBtn);
    unblockBtn.click();
    await sleep(1300);
    check('Blokir: setelah Buka Blokir, daftar kosong', (document.querySelector('#page')?.textContent || '').includes('Belum ada pemain yang diblokir'));
    r = await api(jarA, '/api/chat/blocked', undefined, 'GET');
    check('Blokir: /api/chat/blocked kosong setelah buka blokir', (r.data.blocked || []).length === 0);
    db.close();
  } finally {
    if (dom) dom.window.close();
    stop();
  }
  console.log(`\n[ticket-dom] SELESAI: ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[ticket-dom] ERROR:', e); process.exit(1); });
