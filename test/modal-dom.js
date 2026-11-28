// Parlementer — tes DOM modal LAPORKAN KONTEN (jsdom + server sungguhan).
// Memastikan: (1) modal tertutup saat halaman pertama dimuat, (2) modal hanya
// terbuka lewat openReport (ikon laporkan pada pesan chat), (3) BATAL, Escape,
// dan klik backdrop semuanya menutup modal.
// Jalankan: node test/modal-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3457;
const DB_PATH = '/tmp/parlementer-modal.db';
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[modal-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'modal-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };

  try {
    // Tunggu server siap.
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { const r = await fetch(BASE + '/'); up = r.status === 200; } catch { await sleep(250); }
    }
    check('server menyala dan halaman utama 200', up);
    if (!up) { console.log('[modal-dom] server tidak menyala'); process.exitCode = 1; return; }

    // Ambil HTML sendiri dan buang link font Google (tidak perlu untuk tes,
    // dan lambat/tidak tersedia di VM) — CSS/JS lokal tetap dimuat dari server.
    const html = await (await fetch(BASE + '/')).text();
    const htmlNoFonts = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>\s*/g, '')
      .replace(/<link[^>]*fonts\.gstatic\.com[^>]*>\s*/g, '');
    const dom = new JSDOM(htmlNoFonts, {
      url: BASE + '/',
 // agar fetch relatif & script/style lokal dimuat dari server
      resources: 'usable',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window) { window.fetch = fetch; },
    });

    const { window } = dom;
    const { document } = window;
    // Beri waktu boot() (fetch /api/auth/me) selesai.
    await new Promise((resolve) => {
      if (document.readyState === 'complete') resolve();
      else window.addEventListener('load', resolve);
      setTimeout(resolve, 5000);
    });
    await sleep(500);

    const modal = document.querySelector('#report-modal');
    const display = () => window.getComputedStyle(modal).display;
    const authView = document.querySelector('#auth-view');
    const appView = document.querySelector('#app');

    // 1) Saat load awal: modal tertutup, form login terlihat.
    check('modal LAPORKAN KONTEN tertutup saat load awal', modal.hidden === true && display() === 'none', `hidden=${modal.hidden} display=${display()}`);
    check('form login terlihat saat load awal', authView.hidden === false && window.getComputedStyle(authView).display !== 'none');
    check('tampilan aplikasi tersembunyi saat belum login', appView.hidden === true && window.getComputedStyle(appView).display === 'none');

    // 2) Modal hanya terbuka lewat openReport (jalur ikon laporkan di pesan chat).
    window.openReport(123);
    check('modal terbuka lewat openReport', modal.hidden === false && display() === 'flex', `display=${display()}`);

    // 3a) Tombol BATAL menutup modal.
    document.querySelector('#report-cancel').click();
    check('tombol BATAL menutup modal', modal.hidden === true && display() === 'none');

    // 3b) Tombol Escape menutup modal.
    window.openReport(123);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('tombol Escape menutup modal', modal.hidden === true && display() === 'none');

    // 3c) Klik backdrop menutup modal.
    window.openReport(123);
    modal.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check('klik backdrop menutup modal', modal.hidden === true && display() === 'none');

    // 3d) Klik di dalam kartu modal TIDAK menutupnya.
    window.openReport(123);
    document.querySelector('.modal-card').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    check('klik di dalam kartu tidak menutup modal', modal.hidden === false && display() === 'flex');
    document.querySelector('#report-cancel').click();

    // 4) Statis: satu-satunya pemanggil openReport adalah tombol laporkan di pesan chat.
    const js = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
    const callers = [...js.matchAll(/openReport\(/g)].length;
    const viaFlag = /data-report.*openReport|openReport\(Number\(b\.dataset\.report\)\)/.test(js);
    check('openReport hanya dipanggil dari tombol laporkan chat', callers === 2 && viaFlag, `${callers} kemunculan openReport(`);

    // 5) Loading screen: ada di HTML (tampil saat cold start) dan disembunyikan
    // setelah boot selesai (form login terlihat).
    const loading = document.querySelector('#loading-screen');
    check('layar loading ada di HTML (logo + Memuat...)',
      !!loading && loading.textContent.includes('PARLEMENTER') && loading.textContent.includes('Memuat...'));
    check('layar loading disembunyikan setelah boot selesai',
      loading.hidden === true && window.getComputedStyle(loading).display === 'none',
      `hidden=${loading.hidden} display=${window.getComputedStyle(loading).display}`);

    // 6) Layar banned menyembunyikan HUD (header, bottom bar energi) dan
    // menampilkan tombol AJUKAN BANDING. Disimulasikan dengan ME banned.
    window.eval('ME = { user: { id: 99, is_banned: true, banned_reason: "cheat" }, citizen: { username: "warga_tes" } }');
    window.eval('route()');
    const appEl = document.querySelector('#app');
    check('mode banned: class "banned" ditambahkan ke #app', appEl.classList.contains('banned'));
    check('mode banned: header HUD disembunyikan',
      window.getComputedStyle(document.querySelector('.hud')).display === 'none',
      `display=${window.getComputedStyle(document.querySelector('.hud')).display}`);
    check('mode banned: bottom bar energi disembunyikan',
      window.getComputedStyle(document.querySelector('.energy-bar')).display === 'none',
      `display=${window.getComputedStyle(document.querySelector('.energy-bar')).display}`);
    check('layar banned menampilkan tombol AJUKAN BANDING', !!document.querySelector('#btn-appeal'));
    check('layar banned menampilkan tombol KELUAR', !!document.querySelector('#btn-banned-logout'));
    // Form banding muncul saat tombol ditekan.
    document.querySelector('#btn-appeal').click();
    await sleep(100);
    check('form banding muncul (textarea + KIRIM BANDING)',
      !!document.querySelector('#appeal-text') && !!document.querySelector('#btn-appeal-submit'));

    // 7) Halaman Toko: link WhatsApp menyertakan nama + ID pemain; banner
    // "★ PALING DIMINATI" tidak terpotong; badge HEMAT tidak melipat;
    // padding bawah halaman cukup untuk bar energi; header HP dua baris;
    // bar energi bersembunyi saat scroll ke bawah.
    window.eval("ME = { user: { id: 1, username: 'warga_tes', publicId: 'PL-000099', is_banned: false }, citizen: { username: 'warga_tes', energy: 100 } }");
    window.api = async (path) => {
      if (path === '/api/shop') return {
        packages: [
          { id: 'pemula', name: 'PAKET PEMULA', tagline: 'Langkah pertama.', price: 15000, was: 17000, save: 'HEMAT 12%', premiumMonths: 1, gold: 1000 },
          { id: 'deluxe', name: 'PAKET DELUXE', tagline: 'Satu musim keistimewaan.', price: 50000, was: 58000, save: 'HEMAT 14%', premiumMonths: 6, gold: 5000, best: true },
          { id: 'ultimate', name: 'PAKET ULTIMATE', tagline: 'Setahun penuh.', price: 100000, was: 125000, save: 'HEMAT 20%', premiumMonths: 12, gold: 20000 },
        ],
        premium: [
          { months: 1, price: 5000, perMonth: 5000 },
          { months: 3, price: 15000, perMonth: 5000 },
          { months: 6, price: 25000, perMonth: 4167 },
          { months: 12, price: 45000, perMonth: 3750 },
        ],
        perks: 'Mode otomatis, lebih banyak roti.',
        waUrl: 'https://wa.me/6285220743283',
      };
      throw new Error('api tak terduga: ' + path);
    };
    window.location.hash = '#/shop';
    window.eval('route()');
    await sleep(300);
    const waLinks = [...document.querySelectorAll('a[href*="wa.me"]')];
    check('halaman Toko menampilkan 7 link WhatsApp (3 paket + 4 premium)', waLinks.length === 7, `${waLinks.length} link`);
    const waOk = waLinks.length > 0 && waLinks.every((a) => {
      const text = decodeURIComponent(a.href.split('text=')[1] || '');
      return text.includes('Nama warga: warga_tes (ID: PL-000099)');
    });
    check('semua link WhatsApp menyertakan nama + ID pemain', waOk, waLinks[0]?.href || '');
    const banner = document.querySelector('.shop-banner');
    check('banner "★ PALING DIMINATI" tampil di kartu Deluxe', !!banner && banner.textContent.includes('PALING DIMINATI'));
    if (banner) {
      const mTop = parseFloat(window.getComputedStyle(banner).marginTop);
      const pTop = parseFloat(window.getComputedStyle(banner.parentElement).paddingTop);
      check('banner tidak terpotong di tepi atas kartu (margin negatif = padding panel)', mTop + pTop >= 0, `marginTop=${mTop} paddingTop=${pTop}`);
    }
    const saveChip = [...document.querySelectorAll('.chip.teal')].find((c) => c.textContent.includes('HEMAT 14%'));
    check('badge "HEMAT 14%" ada dan tidak melipat (white-space nowrap)',
      !!saveChip && window.getComputedStyle(saveChip).whiteSpace === 'nowrap');
    const pagePad = parseFloat(window.getComputedStyle(document.querySelector('#page')).paddingBottom);
    check('padding bawah halaman cukup untuk bar energi (>= 160px)', pagePad >= 160, `paddingBottom=${pagePad}px`);
    const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
    check('header HP dua baris: identitas pindah ke baris penuh (order 5, flex 100%)',
      /\.hud-identity\s*\{[^}]*order:\s*5[^}]*flex:\s*1\s+1\s+100%/.test(css));
    check('bar energi memakai safe-area bawah (tidak menabrak gesture bar HP)',
      css.includes('env(safe-area-inset-bottom'));
    // Perilaku sembunyi saat scroll: simulasikan scrollY.
    const bar = document.querySelector('.energy-bar');
    Object.defineProperty(window, 'scrollY', { value: 500, configurable: true });
    window.dispatchEvent(new window.Event('scroll'));
    check('bar energi bersembunyi saat scroll ke bawah', bar.classList.contains('energy-hidden'));
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    window.dispatchEvent(new window.Event('scroll'));
    check('bar energi muncul lagi saat scroll ke atas', !bar.classList.contains('energy-hidden'));

    // 8) Skeleton loading + fokus judul + HUD batas energi + a11y (Tahap 3, §7).
    // jsdom tidak mengimplementasikan fokus dokumen (h.focus() no-op di
    // sini), jadi fokus diuji lewat spy pada HTMLElement.prototype.focus —
    // yang membuktikan route() memanggil focus() pada judul halaman.
    const focusedEls = [];
    const origFocus = window.HTMLElement.prototype.focus;
    window.HTMLElement.prototype.focus = function (...args) { focusedEls.push(this); return origFocus.apply(this, args); };
    window.api = async (path) => {
      if (path === '/api/activity') return { transactions: [], events: [] };
      throw new Error('api tak terduga: ' + path);
    };
    window.location.hash = '#/activity';
    window.eval('route()');
    // Skeleton tampil SEGERA (sinkron) setelah route(), sebelum handler async selesai.
    const skels = document.querySelectorAll('#page .skel');
    check('skeleton loading tampil saat halaman dimuat', skels.length >= 3, `${skels.length} elemen .skel`);
    check('skeleton punya role status (pembaca layar)', !!document.querySelector('#page [role="status"]'));
    await sleep(300);
    const lastFocused = focusedEls[focusedEls.length - 1];
    check('route() memanggil focus() pada judul halaman setelah dimuat',
      !!lastFocused && lastFocused.tagName === 'H2' && lastFocused.textContent === 'AKTIVITAS SAYA',
      `terakhir fokus: ${lastFocused?.tagName} "${lastFocused?.textContent}"`);
    window.HTMLElement.prototype.focus = origFocus;
    // HUD memakai energyCap dari /api/me (bukan hardcode 100).
    window.eval("ME = { user: { id: 1, username: 'warga_tes', publicId: 'PL-000099', is_banned: false }, citizen: { username: 'warga_tes', energy: 55, energyCap: 110, gold: 0, usd: 0, xp: 0, level: 1 }, region: { name: 'Jakarta' }, xpNext: 10, unread: 0, unreadDm: 0 }");
    window.eval('renderHUD()');
    check('HUD menampilkan batas energi dari server (55/110)', document.querySelector('#energy-num').textContent === '55/110', document.querySelector('#energy-num').textContent);
    // Atribut aksesibilitas (Tahap 3, §7).
    check('modal laporan punya role dialog + aria-modal', modal.getAttribute('role') === 'dialog' && modal.getAttribute('aria-modal') === 'true');
    check('toast punya role status', document.querySelector('#toast').getAttribute('role') === 'status');
    check('tombol tutup drawer punya aria-label', document.querySelector('#drawer-close').getAttribute('aria-label') === 'Tutup menu');
    check('tombol chat bawah punya aria-label', document.querySelector('#energy-chat').getAttribute('aria-label') === 'Buka obrolan');
    // Escape menutup drawer (sebelumnya hanya modal).
    window.eval('openDrawer()');
    check('drawer terbuka lewat openDrawer', document.querySelector('#drawer').classList.contains('open'));
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('tombol Escape menutup drawer', !document.querySelector('#drawer').classList.contains('open'));

    // 9) Halaman "Aktivitas Saya" (Tahap 3, §7): transaksi + peristiwa + NAV.
    window.api = async (path) => {
      if (path === '/api/activity') return {
        transactions: [{ direction: 'beli', commodity_name: 'Makanan', tier: 1, qty: 10, price_each: 9, total: 90, scope: 'local', created_at: Date.now() }],
        events: [{ category: 'SISTEM', title: 'Aktivitas tes', content: 'Peristiwa tes.', created_at: Date.now() }],
      };
      throw new Error('api tak terduga: ' + path);
    };
    window.location.hash = '#/activity';
    window.eval('route()');
    await sleep(300);
    const activityText = document.querySelector('#page').textContent;
    check('halaman Aktivitas Saya menampilkan transaksi BELI Makanan', activityText.includes('BELI') && activityText.includes('Makanan'));
    check('halaman Aktivitas Saya menampilkan peristiwa', activityText.includes('Aktivitas tes'));
    window.eval('buildNav()');
    check('NAV berisi entri "Aktivitas Saya"', [...document.querySelectorAll('#drawer-nav .nav-item')].some((b) => b.textContent.includes('Aktivitas Saya')));

    // 10) Judul chat perang memakai label penyerang/pembela (BUG-12) dan
    // konfirmasi sebelum bongkar konvoi (Tahap 3).
    const apiCalls = [];
    window.api = async (path, opts) => {
      if (path === '/api/wars/1') return { war: { region_name: 'Jakarta', attacker_label: 'Pemberontak Jakarta', defender_label: 'Republik Indonesia' } };
      if (path.startsWith('/api/chat/')) return { room: 'war_1', title: 'PERTEMPURAN', messages: [] };
      if (path === '/api/convoy') return {
        used: 1, slots: 2,
        buildings: [{ type: 'health', name: 'Rumah Sakit Lapangan', desc: '+10% pemulihan energi harian' }],
        convoys: [{ id: 7, building: 'health', expires_at: Date.now() + 86400000 }],
      };
      if (opts?.method === 'POST') { apiCalls.push(path); return { ok: true }; }
      throw new Error('api tak terduga: ' + path);
    };
    window.location.hash = '#/chat/war_1';
    window.eval('route()');
    await sleep(300);
    check('judul chat perang: PEMBERONTAK JAKARTA → REPUBLIK INDONESIA (bukan JAKARTA → JAKARTA)',
      document.querySelector('#page').textContent.includes('GARIS DEPAN: PEMBERONTAK JAKARTA → REPUBLIK INDONESIA'));
    check('input chat punya aria-label', document.querySelector('#chat-text')?.getAttribute('aria-label') === 'Tulis pesan chat');
    // Konfirmasi bongkar konvoi: tolak dulu, lalu setujui.
    window.location.hash = '#/convoy';
    window.eval('route()');
    await sleep(300);
    const demolishBtn = document.querySelector('[data-demolish="7"]');
    check('tombol Bongkar konvoi tampil', !!demolishBtn);
    window.confirm = () => false;
    demolishBtn.click();
    await sleep(100);
    check('konfirmasi ditolak: tidak ada panggilan demolish', !apiCalls.includes('/api/convoy/demolish'), apiCalls.join(','));
    window.confirm = () => true;
    document.querySelector('[data-demolish="7"]').click();
    await sleep(100);
    check('konfirmasi disetujui: demolish dipanggil', apiCalls.includes('/api/convoy/demolish'), apiCalls.join(','));

    // 11) Buku Panduan: panel RIWAYAT UPDATE (Tahap 4) — nomor stabil
    // berdasarkan urutan terbit, tampil terbaru dulu.
    const annMock = [
      { id: 1, num: 1, title: 'Pasar Lebih Dalam, Energi Pulih Otomatis & Tampilan Baru', body: 'Pasar lebih dalam. Energi pulih +2/menit.', created_at: Date.now() - 86400000, read: true },
      { id: 2, num: 2, title: 'Update Tes Kedua', body: 'Isi update kedua.', created_at: Date.now(), read: false },
    ];
    window.api = async (path) => {
      if (path === '/api/announcements') return { announcements: [...annMock].reverse(), unreadCount: 1 };
      throw new Error('api tak terduga: ' + path);
    };
    window.location.hash = '#/book';
    window.eval('route()');
    await sleep(300);
    const bookText = document.querySelector('#page').textContent;
    check('Buku: panel RIWAYAT UPDATE tampil', bookText.includes('RIWAYAT UPDATE'));
    check('Buku: Update #1 (terlama) + Update #2 (terbaru) keduanya tampil', bookText.includes('Update #1') && bookText.includes('Update #2'));
    check('Buku: entri terbaru di atas (judul Update #2 sebelum judul Update #1)', bookText.indexOf('Update Tes Kedua') < bookText.indexOf('Pasar Lebih Dalam'));
    check('Buku: judul Update #1 tampil', bookText.includes('Pasar Lebih Dalam'));

    // 12) Toggle suara di Pengaturan (Tahap 4) tersimpan di localStorage.
    window.localStorage.removeItem('parlementer_sound');
    window.location.hash = '#/settings';
    window.eval('route()');
    await sleep(300);
    const soundBtn = document.querySelector('#btn-sound-toggle');
    check('Pengaturan: tombol suara tampil (awal NYALA)', !!soundBtn && soundBtn.textContent.includes('NYALA'));
    soundBtn.click();
    check('Toggle suara: klik mematikan + tersimpan "off"', window.localStorage.getItem('parlementer_sound') === 'off' && document.querySelector('#btn-sound-toggle').textContent.includes('MATI'));
    document.querySelector('#btn-sound-toggle').click();
    check('Toggle suara: klik lagi menyalakan + tersimpan "on"', window.localStorage.getItem('parlementer_sound') === 'on' && document.querySelector('#btn-sound-toggle').textContent.includes('NYALA'));

    // 13) Modal pengumuman saat login (Tahap 4): tampil sekali bila ada
    // yang belum dibaca; SUDAH DIBACA menandai + menutup, NANTI hanya menutup.
    const annCalls = [];
    window.api = async (path, opts) => {
      if (path === '/api/announcements') return { announcements: [{ id: 3, num: 3, title: 'Update Tes Modal', body: 'Isi modal.', created_at: Date.now(), read: false }], unreadCount: 1 };
      if (path === '/api/announcements/read' && opts?.method === 'POST') { annCalls.push(path); return { ok: true }; }
      if (path === '/api/me') return ME;
      throw new Error('api tak terduga: ' + path);
    };
    window.eval('maybeShowAnnouncement()');
    await sleep(300);
    const annModal = document.querySelector('#announce-modal');
    check('Modal pengumuman tampil saat ada yang belum dibaca', !!annModal && !annModal.hidden);
    check('Modal pengumuman berisi nomor + judul', document.querySelector('#announce-modal-sub').textContent.includes('Update #3') && document.querySelector('#announce-modal-sub').textContent.includes('Update Tes Modal'));
    document.querySelector('#announce-modal-read').click();
    await sleep(300);
    check('SUDAH DIBACA: menandai dibaca + menutup modal', annCalls.includes('/api/announcements/read') && document.querySelector('#announce-modal').hidden);

    // 14) Tahap 5: halaman Parlemen (UU berjenis + panel aturan berlaku),
    // halaman Organisasi (panel pakta), dan format waktu chat dengan
    // timestamp STRING (simulasi BIGINT Postgres → "Invalid Date").
    window.eval("ME = { user: { id: 1, username: 'warga_tes', publicId: 'PL-000099', is_banned: false }, citizen: { id: 1, username: 'warga_tes', energy: 100, gold: 500, usd: 500, xp: 0, level: 5 }, region: { id: 1, name: 'Jakarta' }, xpNext: 10, unread: 0, unreadDm: 0 }");
    window.api = async (path) => {
      if (path === '/api/parliament') return {
        parliamentOpen: true, parliamentOpensAt: Date.now() - 86400000,
        country: { id: 1, name: 'Nusantara', ideology: 'Konservatisme', system: 'presidensial' },
        filledSeats: 31, majority: 31, isMp: true,
        laws: [{ id: 1, title: 'UU Pajak 4 Persen', proposer_name: 'warga_tes', status: 'executed', content: 'Pajak menjadi 4 persen.', kind: 'tax_income', value: 4, effect_applied: 1, yes: 31, abstain: 0, no: 0, ends_at: Date.now() }],
        myVotes: {},
        budgets: [], myBudgetVotes: {},
        impeachments: [], myImpeachVotes: {},
        effects: { taxIncome: 4, adminPayMult: 1.2, travelTickets: 2, budgetKind: null, budgetUntil: 0, mobilizationUntil: 0 },
      };
      throw new Error('api tak terduga: ' + path);
    };
    window.location.hash = '#/parliament';
    window.eval('route()');
    await sleep(300);
    const parlText = document.querySelector('#page').textContent;
    check('Parlemen: panel ATURAN YANG BERLAKU SAAT INI tampil', parlText.includes('ATURAN YANG BERLAKU SAAT INI'));
    check('Parlemen: panel menampilkan pajak 4% + upah 120% + 2 Tiket', parlText.includes('4%') && parlText.includes('120%') && parlText.includes('2 Tiket'));
    const lawKind = document.querySelector('#law-kind');
    check('Parlemen: form UU punya pemilih jenis (tax_income/admin_pay/travel)',
      !!lawKind && [...lawKind.options].some((o) => o.value === 'tax_income') && [...lawKind.options].some((o) => o.value === 'admin_pay') && [...lawKind.options].some((o) => o.value === 'travel'));
    check('Parlemen: form UU punya jenis ideologi + sistem (redesain dunia)',
      !!lawKind && [...lawKind.options].some((o) => o.value === 'ideology') && [...lawKind.options].some((o) => o.value === 'system'));
    check('Parlemen: UU pajak tampil dengan jenis + efek diterapkan', parlText.includes('UU Pajak 4 Persen') && parlText.includes('efek diterapkan'));
    // Jenis UU mengubah tampilan input nilai (umum: sembunyi; pajak: tampil).
    lawKind.value = 'tax_income';
    lawKind.dispatchEvent(new window.Event('change', { bubbles: true }));
    check('Parlemen: pilih jenis pajak menampilkan input NILAI BARU', document.querySelector('#law-value-wrap').style.display !== 'none');
    lawKind.value = 'general';
    lawKind.dispatchEvent(new window.Event('change', { bubbles: true }));
    check('Parlemen: pilih UU umum menyembunyikan input nilai', document.querySelector('#law-value-wrap').style.display === 'none');
    // Parlemen terkunci (redesain dunia): mock parlemen belum dibuka →
    // countdown + penjelasan tampil, tanpa form UU.
    window.api = async (path) => {
      if (path === '/api/parliament') return {
        parliamentOpen: false, parliamentOpensAt: Date.now() + 2 * 86400000,
        country: null, filledSeats: 0, majority: 31, isMp: false,
        laws: [], myVotes: {}, budgets: [], myBudgetVotes: {},
        impeachments: [], myImpeachVotes: {},
        effects: { taxIncome: 0, adminPayMult: 1, travelTickets: 1, budgetKind: null, budgetUntil: 0, mobilizationUntil: 0 },
      };
      throw new Error('api tak terduga: ' + path);
    };
    window.location.hash = '#/parliament';
    window.eval('route()');
    await sleep(300);
    const parlLocked = document.querySelector('#page').textContent;
    check('Parlemen terkunci: countdown + penjelasan tampil (tanpa form UU)', parlLocked.includes('PARLEMEN DIBUKA') && parlLocked.includes('2 Desember 2026') && !document.querySelector('#law-kind'), parlLocked.slice(0, 120));

    window.api = async (path) => {
      if (path === '/api/orgs') return {
        organizations: [
          { id: 1, name: 'Org Satu', tag: 'OS', type: 'Kerja Sama', members: 2, leader_name: 'warga_tes' },
          { id: 2, name: 'Org Dua', tag: 'OD', type: 'Keamanan', members: 1, leader_name: 'warga_dua' },
        ],
        myOrgId: 1,
        pacts: [{ id: 5, kind: 'trade', status: 'active', org_a_name: 'Org Satu', org_b_name: 'Org Dua', org_a_leader_id: 1, org_b_leader_id: 2 }],
        myMinisterRole: null,
      };
      throw new Error('api tak terduga: ' + path);
    };
    window.location.hash = '#/orgs';
    window.eval('route()');
    await sleep(300);
    const orgsText = document.querySelector('#page').textContent;
    check('Organisasi: panel PAKTA ANTAR ORGANISASI tampil', orgsText.includes('PAKTA ANTAR ORGANISASI'));
    check('Organisasi: pakta dagang aktif tampil (Org Satu ↔ Org Dua)', orgsText.includes('Perjanjian Dagang') && orgsText.includes('Org Satu') && orgsText.includes('Org Dua'));
    check('Organisasi: form usulkan pakta punya pemilih jenis (trade/defense)',
      !!document.querySelector('#pact-kind') && [...document.querySelector('#pact-kind').options].some((o) => o.value === 'defense'));
    check('Organisasi: tombol Bubarkan Pakta tampil untuk ketua', !!document.querySelector('[data-pact-dissolve="5"]'));

    // Format waktu: node-postgres mengembalikan BIGINT sebagai STRING —
    // sebelum Tahap 5, new Date('1793...') = Invalid Date di chat.
    const nowStr = String(Date.now());
    const fmtNow = window.eval(`fmtTime('${nowStr}')`);
    check('fmtTime(timestamp STRING) mengembalikan jam valid, bukan Invalid Date', /^\d{1,2}:\d{2}$/.test(fmtNow) || /^\d{2}\.\d{2}$/.test(fmtNow), `fmtTime=${fmtNow}`);
    const agoNow = window.eval(`ago('${nowStr}')`);
    check('ago(timestamp STRING, baru saja) = "baru saja"', agoNow === 'baru saja', `ago=${agoNow}`);
    const hourAgoStr = String(Date.now() - 3600000);
    const agoHour = window.eval(`ago('${hourAgoStr}')`);
    check('ago(timestamp STRING, 1 jam lalu) valid (bukan Invalid Date)', agoHour !== 'Invalid Date' && /jam/.test(agoHour), `ago=${agoHour}`);
    check('fmtTime(null) = "—" (tidak crash)', window.eval('fmtTime(null)') === '—');
    check('fmtTime(timestamp STRING tidak valid) = "—"', window.eval("fmtTime('bukan-tanggal')") === '—');

    // 15) Bug tulis artikel: CSP Tahap 2 (script-src 'self') memblokir SEMUA
    // handler inline, sehingga 50 tombol navigasi mati di browser sungguhan.
    // Perbaikan: tanpa onclick/oninput inline — navigasi via data-goto +
    // delegasi klik dokumen; pencarian wilayah via addEventListener.
    const js2 = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
    check('app.js: tidak ada lagi onclick inline (CSP memblokirnya)', !/onclick="/.test(js2), `${(js2.match(/onclick="/g) || []).length} kemunculan onclick="`);
    check('app.js: tidak ada lagi oninput inline', !/oninput="/.test(js2));
    check('app.js: delegasi klik data-goto ada', js2.includes("closest?.('[data-goto]')"));
    // Perilaku: klik tombol TULIS ARTIKEL (data-goto) mengubah hash.
    window.api = async (path) => {
      if (path === '/api/press/stats') return { articles7d: 0, journalists7d: 0, newspapers: 0, reads7d: 0, reactions7d: 0, comments7d: 0 };
      if (path === '/api/press/articles?sort=new') return { articles: [] };
      throw new Error('api tak terduga: ' + path);
    };
    window.location.hash = '#/press';
    window.eval('route()');
    await sleep(300);
    const writeBtn = document.querySelector('[data-goto="#/press/new"]');
    check('Pers: tombol TULIS ARTIKEL memakai data-goto (bukan onclick)', !!writeBtn && writeBtn.textContent.includes('TULIS ARTIKEL'));
    writeBtn.click();
    await sleep(100);
    check('Klik TULIS ARTIKEL mengubah hash ke #/press/new', window.location.hash === '#/press/new', `hash=${window.location.hash}`);
    // Tanpa koran: halaman jelas mengarahkan ke Dirikan Koran, bukan buntu.
    window.api = async (path) => {
      if (path === '/api/press/newspapers/mine') return { newspapers: [] };
      throw new Error('api tak terduga: ' + path);
    };
    window.eval('route()');
    await sleep(300);
    const pressNewText = document.querySelector('#page').textContent;
    check('Tulis artikel tanpa koran: pesan "belum punya koran" tampil', pressNewText.includes('belum punya koran'));
    const foundBtn = document.querySelector('[data-goto="#/newspaper"]');
    check('Tulis artikel tanpa koran: tombol Dirikan Koran tampil', !!foundBtn);
    foundBtn.click();
    await sleep(100);
    check('Klik Dirikan Koran mengubah hash ke #/newspaper', window.location.hash === '#/newspaper', `hash=${window.location.hash}`);
    // Dengan koran: form tampil + TERBITKAN memanggil API + redirect ke artikel.
    let publishedBody = null;
    window.api = async (path, opts) => {
      if (path === '/api/press/newspapers/mine') return { newspapers: [{ id: 7, name: 'Kabar Tes' }] };
      if (path === '/api/press/articles' && opts?.method === 'POST') { publishedBody = opts.body; return { ok: true, articleId: 9 }; }
      throw new Error('api tak terduga: ' + path);
    };
    window.location.hash = '#/press/new';
    window.eval('route()');
    await sleep(300);
    check('Tulis artikel dengan koran: form tampil (koran + judul + isi)', !!document.querySelector('#art-paper') && !!document.querySelector('#art-title') && !!document.querySelector('#art-content'));
    document.querySelector('#art-title').value = 'Judul Artikel Tes';
    document.querySelector('#art-content').value = 'Isi artikel tes yang panjangnya lebih dari dua puluh karakter.';
    document.querySelector('#btn-publish').click();
    await sleep(300);
    check('TERBITKAN: POST /api/press/articles dipanggil dengan koran+judul+isi',
      !!publishedBody && publishedBody.newspaper_id === 7 && publishedBody.title === 'Judul Artikel Tes', JSON.stringify(publishedBody));
    check('TERBITKAN: redirect ke #/press/9 (articleId)', window.location.hash === '#/press/9', `hash=${window.location.hash}`);
    // Validasi gagal: pesan error tampil sebagai toast (bukan gagal diam-diam).
    window.api = async (path, opts) => {
      if (path === '/api/press/newspapers/mine') return { newspapers: [{ id: 7, name: 'Kabar Tes' }] };
      if (path === '/api/press/articles' && opts?.method === 'POST') throw new Error('Judul 5–120 karakter.');
      throw new Error('api tak terduga: ' + path);
    };
    window.location.hash = '#/press/new';
    window.eval('route()');
    await sleep(300);
    document.querySelector('#art-title').value = 'Abcd';
    document.querySelector('#art-content').value = 'Isi artikel tes yang panjangnya lebih dari dua puluh karakter.';
    document.querySelector('#btn-publish').click();
    await sleep(300);
    const toastEl = document.querySelector('#toast');
    check('Validasi gagal: toast menampilkan pesan error', !toastEl.hidden && toastEl.textContent.includes('Judul 5–120 karakter.'), `toast="${toastEl.textContent}" hidden=${toastEl.hidden}`);
    check('Validasi gagal: tetap di #/press/new (tidak redirect)', window.location.hash === '#/press/new', `hash=${window.location.hash}`);

    // 16) Rombak UI gaya Parlamentum: peti pasokan di HUD, banner UU,
    // hero profil, blok LEVEL/ENERGI/KELELAHAN/MAKANAN/DOMPET, kartu
    // KRONIKMU baru, popover energi/kelelahan. Hanya tampilan — semua
    // angka (regen +2/mnt, ambang 10.000/15.000) dari data game asli.
    const meRevamp = {
      user: { id: 1, username: 'warga_tes', publicId: 'PL-000099', is_banned: false },
      citizen: { id: 1, user_id: 1, username: 'warga_tes', energy: 100, energyCap: 100, gold: 500, usd: 500, xp: 0, level: 1, fatigue: 0, energy_spent_today: 0, bread_today: 0, last_claim_date: '2000-01-01', attr_str: 0, attr_edu: 0, attr_eco: 0, isPremium: false },
      region: { id: 1, name: 'Jakarta' }, party: null, job: null, activeWars: [],
      votingLaws: [
        { id: 1, title: 'UU Tes 1', yes: 1, abstain: 0, no: 0, ends_at: Date.now() + 75 * 60000 + 30000 },
        { id: 2, title: 'UU Tes 2', yes: 0, abstain: 0, no: 0, ends_at: Date.now() + 200 * 60000 },
      ],
      unread: 0, unreadDm: 0, xpNext: 5, world: { day: 3 }, population: 9,
    };
    window.eval('ME = ' + JSON.stringify(meRevamp));
    const revampCalls = [];
    const chronicleMock = { chapters: [
      { chapter: 1, title: 'Roti dan Kerja', reward: 10, done: 0, total: 8, claimed: false, tasks: [
        { key: 'claim', label: 'Ambil pasokan harian', done: false },
        { key: 'job', label: 'Dapatkan pekerjaan', done: false },
        { key: 'shift', label: 'Kerjakan satu giliran', done: false },
        { key: 'train', label: 'Latih satu atribut', done: false },
        { key: 'eat', label: 'Isi ulang energi dengan roti', done: false },
        { key: 'map', label: 'Jelajahi peta', done: false },
        { key: 'market', label: 'Lihat pasar', done: false },
        { key: 'country', label: 'Kunjungi halaman negara', done: false },
      ] },
      { chapter: 2, title: 'Warga Aktif', reward: 25, done: 0, total: 4, claimed: false, tasks: [
        { key: 'travel', label: 'Bepergian ke wilayah lain', done: false },
        { key: 'buy', label: 'Beli sesuatu di pasar', done: false },
        { key: 'sell', label: 'Pasang penawaran jual', done: false },
        { key: 'chat5', label: 'Tulis 5 pesan obrolan', done: false },
      ] },
      { chapter: 3, title: 'Pebisnis Muda', reward: 25, done: 0, total: 4, claimed: false, tasks: [
        { key: 'company', label: 'Dirikan perusahaan', done: false },
        { key: 'fx', label: 'Cetak Rupiah dari emas / pasang penawaran valas', done: false },
        { key: 'level5', label: 'Capai Level 5', done: false },
        { key: 'party', label: 'Gabung atau dirikan partai', done: false },
      ] },
      { chapter: 4, title: 'Politisi', reward: 25, done: 0, total: 2, claimed: false, tasks: [
        { key: 'law', label: 'Usulkan undang-undang', done: false },
        { key: 'vote', label: 'Ikut memilih dalam pemilu / voting UU', done: false },
      ] },
      { chapter: 5, title: 'Pejuang', reward: 30, done: 0, total: 2, claimed: false, tasks: [
        { key: 'attack', label: 'Serang di garis depan perang', done: false },
        { key: 'article', label: 'Tulis satu artikel pers', done: false },
      ] },
    ] };
    window.api = async (path, opts) => {
      if (path === '/api/me') return meRevamp;
      if (path === '/api/missions') return { missions: [
        { key: 'energy', label: 'Habiskan 500 energi', progress: 0, target: 500, claimed: false },
        { key: 'bread', label: 'Makan jatah roti harian (10)', progress: 0, target: 10, claimed: false },
        { key: 'chat', label: 'Tulis 5 pesan obrolan', progress: 0, target: 5, claimed: false },
      ] };
      if (path === '/api/chronicle') return chronicleMock;
      if (path === '/api/inventory') return { items: [{ name: 'Makanan', tier: 1, qty: 3, ref_usd: 9 }], totalQty: 3, marketValue: 27 };
      if (path === '/api/profile/warga_tes') return { profile: { user_id: 1, username: 'warga_tes', isPremium: false, region_name: 'Jakarta', level: 1, avatar: null, publicId: 'PL-000099', party: null, created_at: Date.now(), bio: '', attr_str: 0, attr_edu: 0, attr_eco: 0, total_damage: 0, attacks: 0, frontline_attacks: 0, shifts: 0, total_salary: 0, companies: [], articles: [], referral: null } };
      if (path === '/api/profile/orang_lain') return { profile: { user_id: 2, username: 'orang_lain', isPremium: false, region_name: 'Jakarta', level: 3, avatar: null, publicId: 'PL-000100', party: null, created_at: Date.now(), bio: '', attr_str: 0, attr_edu: 0, attr_eco: 0, total_damage: 0, attacks: 0, frontline_attacks: 0, shifts: 0, total_salary: 0, companies: [], articles: [], referral: null } };
      if (opts?.method === 'POST') {
        revampCalls.push(path);
        if (path === '/api/claim') return { reward: { gold: 5, usd: 50, xp: 2 } };
        if (path === '/api/eat') return { ok: true, gained: 10, energy: 100 };
        return { ok: true };
      }
      throw new Error('api tak terduga: ' + path);
    };
    // HUD: peti + banner UU.
    check('HUD: tombol peti pasokan (#btn-crate) ada di HTML', !!document.querySelector('#btn-crate'));
    check('HUD: banner UU (#law-banner) ada di HTML', !!document.querySelector('#law-banner'));
    window.eval('renderHUD()');
    const lawBanner = document.querySelector('#law-banner');
    check('Banner UU tampil saat ada 2 UU divoting (jumlah + sisa waktu)', !lawBanner.hidden && lawBanner.textContent.includes('2 undang-undang sedang dibahas') && /sisa \d+j \d+ mnt/.test(lawBanner.textContent), lawBanner.textContent);
    const crate = document.querySelector('#btn-crate');
    check('Peti: aktif + berdenyut + badge tampil saat pasokan belum diambil', !crate.disabled && crate.classList.contains('ready') && !document.querySelector('#badge-crate').hidden, `disabled=${crate.disabled} class=${crate.className}`);
    // Pasokan sudah diambil hari ini → peti mati + badge hilang.
    window.eval(`ME.citizen.last_claim_date = '${new Date().toISOString().slice(0, 10)}'`);
    window.eval('renderHUD()');
    check('Peti: mati + badge hilang saat pasokan hari ini sudah diambil', crate.disabled && crate.classList.contains('claimed') && document.querySelector('#badge-crate').hidden);
    window.eval("ME.citizen.last_claim_date = '2000-01-01'");
    window.eval('renderHUD()');
    // Dashboard baru.
    window.location.hash = '#/dashboard';
    window.eval('route()');
    await sleep(300);
    const dashText = document.querySelector('#page').textContent;
    check('Dashboard: hero profil tampil (nama + Belum Bernegara + Jakarta)', !!document.querySelector('.profile-hero-name') && dashText.includes('Belum Bernegara') && dashText.includes('Jakarta'));
    check('Dashboard: blok LEVEL tampil (angka emas + XP)', dashText.includes('LEVEL') && dashText.includes('0 / 5 XP'));
    check('Dashboard: blok ENERGI tampil (100/100 + teks penuh)', dashText.includes('ENERGI') && dashText.includes('100/100') && dashText.includes('Penuh — gunakan untuk bekerja'));
    check('Dashboard: blok KELELAHAN tampil (ambang 10.000/15.000)', dashText.includes('KELELAHAN') && dashText.includes('10.000 ×0.75') && dashText.includes('15.000 ×0.5'));
    const foodCards = document.querySelectorAll('.food-grid .food-card');
    check('Dashboard: grid MAKANAN berisi 5 kartu T1–T5', foodCards.length === 5, `${foodCards.length} kartu`);
    check('Dashboard: kartu T1 ⚡10 ×3 bisa dimakan, T5 kosong & mati', foodCards[0]?.textContent.includes('⚡10') && foodCards[0]?.textContent.includes('×3') && foodCards[4]?.disabled === true, foodCards[0]?.textContent);
    check('Dashboard: blok DOMPET tampil (emas + Rupiah Rp9.150.000, tanpa USD)', dashText.includes('DOMPET') && dashText.includes('Rp9.150.000') && !dashText.includes('USD'));
    // Dashboard progresif (Masalah 2): cangkang (hero + DOMPET) langsung
    // ter-render dari ME sebelum /api/missions dkk. kembali; panel-panel
    // terisi menyusul, masing-masing begitu selesai. Bukti: tahan respons
    // API panel 300 ms, lalu route() — cangkang sudah ada saat panel masih
    // "Memuat…", dan panel terisi setelah API kembali.
    const fastApi = window.api;
    window.api = async (path, opts) => {
      if (path === '/api/missions' || path === '/api/chronicle' || path === '/api/inventory') await sleep(300);
      return fastApi(path, opts);
    };
    window.location.hash = '#/dash';
    window.eval('route()');
    await sleep(50);
    check('Dashboard progresif: cangkang (hero + DOMPET) tampil sebelum API panel kembali', !!document.querySelector('.profile-hero-name') && document.querySelector('#page').textContent.includes('DOMPET'));
    check('Dashboard progresif: panel misi masih "Memuat…" selagi API tertahan', document.querySelector('#dash-missions')?.textContent.includes('Memuat'));
    await sleep(500);
    check('Dashboard progresif: panel misi terisi setelah API kembali', !document.querySelector('#dash-missions')?.textContent.includes('Memuat') && document.querySelector('#dash-missions').textContent.includes('Habiskan 500 energi'));
    window.api = fastApi;
    check('Dashboard: tombol AMBIL PASOKAN lama sudah tidak ada (diganti peti HUD)', !document.querySelector('#btn-claim'));
    // Jeda latihan: tombol atribut yang jeda nonaktif + hitung mundur,
    // atribut lain tetap bisa dilatih. ME di-mock dengan trainCooldowns.
    window.eval(`ME.citizen.trainCooldowns = { strength: { remainingMs: 420000, cooldownMs: 120000, availableAt: Date.now() + 420000 }, strategy: { remainingMs: 0, cooldownMs: 120000, availableAt: null }, charisma: { remainingMs: 0, cooldownMs: 120000, availableAt: null } }`);
    window.location.hash = '#/dashboard';
    window.eval('route()');
    await sleep(300);
    const btnStr = document.querySelector('[data-train="str"]');
    const btnEdu = document.querySelector('[data-train="edu"]');
    const btnEco = document.querySelector('[data-train="eco"]');
    check('Jeda latihan: tombol Kekuatan nonaktif + "Latih lagi dalam 7 mnt"', btnStr?.disabled === true && btnStr.textContent.includes('Latih lagi dalam 7 mnt'), btnStr?.textContent);
    check('Jeda latihan: tombol Pendidikan & Ekonomi tetap aktif (LATIH)', btnEdu?.disabled === false && btnEdu.textContent.includes('LATIH') && btnEco?.disabled === false && btnEco.textContent.includes('LATIH'), `${btnEdu?.textContent} / ${btnEco?.textContent}`);
    window.eval('ME.citizen.trainCooldowns = { strength: { remainingMs: 0, cooldownMs: 120000, availableAt: null }, strategy: { remainingMs: 0, cooldownMs: 120000, availableAt: null }, charisma: { remainingMs: 0, cooldownMs: 120000, availableAt: null } }');
    window.eval('route()');
    await sleep(300);
    check('Jeda latihan: tombol Kekuatan aktif lagi saat jeda 0', document.querySelector('[data-train="str"]')?.disabled === false && document.querySelector('[data-train="str"]').textContent.includes('LATIH'));
    // Kartu KRONIKMU baru.
    const kronik = document.querySelector('#kronik-card');
    check('KRONIKMU: kartu tampil (judul + progres 0/20)', !!kronik && kronik.textContent.includes('KRONIKMU') && kronik.textContent.includes('0/20'));
    check('KRONIKMU: seg-bar 20 segmen (satu per tugas)', kronik.querySelectorAll('.seg-bar i').length === 20, `${kronik.querySelectorAll('.seg-bar i').length} segmen`);
    check('KRONIKMU: kutipan serif + TUGASMU + tugas pertama', kronik.querySelector('.quote')?.textContent.includes('Tak ada yang mulai dari nol') && kronik.textContent.includes('TUGASMU') && kronik.querySelector('.task-big')?.textContent.includes('Ambil pasokan harian'));
    check('KRONIKMU: dua tombol (BACA BABAK INI LAGI / LEWATI PELATIHAN)', kronik.textContent.includes('BACA BABAK INI LAGI') && kronik.textContent.includes('LEWATI PELATIHAN (TANPA HADIAH)'));
    const chapterHeads = kronik.querySelectorAll('.chapter-head');
    check('KRONIKMU: 5 judul babak (I–V) bisa dibuka', chapterHeads.length === 5, `${chapterHeads.length} judul`);
    check('KRONIKMU: Babak I terbuka, Babak II tertutup saat awal', !chapterHeads[0].nextElementSibling.hidden && chapterHeads[1].nextElementSibling.hidden);
    chapterHeads[1].click();
    check('KRONIKMU: klik Babak II membuka daftar tugasnya', !chapterHeads[1].nextElementSibling.hidden && chapterHeads[1].getAttribute('aria-expanded') === 'true');
    // Popover energi: angka asli (+2/mnt, batas 100) — bukan angka referensi.
    document.querySelector('[data-popover="energy"]').click();
    await sleep(100);
    const pop = document.querySelector('.popover-card');
    check('Popover energi tampil (+2 / mnt, Energi maksimum 100)', !!pop && pop.textContent.includes('+2 / mnt') && pop.textContent.includes('Energi maksimum') && pop.textContent.includes('100'));
    document.querySelector('#popover-backdrop').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await sleep(100);
    check('Popover tertutup lewat klik backdrop', !document.querySelector('.popover-card'));
    document.querySelector('[data-popover="fatigue"]').click();
    await sleep(100);
    const popF = document.querySelector('.popover-card');
    check('Popover kelelahan tampil (tier 0–10.000 ×1, 10.000–15.000 ×0.75, 15.000+ ×0.5)', !!popF && popF.textContent.includes('KELELAHAN') && popF.textContent.includes('×0.75') && popF.textContent.includes('×0.5'));
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(100);
    check('Popover tertutup lewat Escape', !document.querySelector('.popover-card'));
    // Makan dari kartu T1 → POST /api/eat.
    document.querySelector('.food-grid .food-card[data-eat="1"]').click();
    await sleep(300);
    check('Kartu T1: klik memanggil POST /api/eat', revampCalls.includes('/api/eat'), revampCalls.join(','));
    // Klaim via claimDaily (handler peti) → POST /api/claim + toast.
    window.eval('claimDaily()');
    await sleep(300);
    check('Peti: claimDaily memanggil POST /api/claim', revampCalls.includes('/api/claim'), revampCalls.join(','));
    check('Peti: toast menampilkan hadiah pasokan', !document.querySelector('#toast').hidden && document.querySelector('#toast').textContent.includes('Pasokan diterima: +5 emas'), document.querySelector('#toast').textContent);
    // LEWATI: sembunyikan kartu (preferensi lokal), hadiah tetap di KRONIKMU.
    document.querySelector('#btn-kronik-hide').click();
    await sleep(300);
    check('LEWATI: kartu KRONIKMU hilang dari Dashboard + tersimpan lokal', !document.querySelector('#kronik-card') && window.localStorage.getItem('parlementer_kronik_hide') === '1');
    // Halaman KRONIKMU: kutipan + seg-bar + daftar tugas per babak.
    window.location.hash = '#/chronicle';
    window.eval('route()');
    await sleep(300);
    const chronText = document.querySelector('#page').textContent;
    check('Halaman KRONIKMU tampil (5 babak + kutipan + tugas)', chronText.includes('Babak I — Roti dan Kerja') && chronText.includes('Babak V — Pejuang') && !!document.querySelector('#page .quote') && chronText.includes('Ambil pasokan harian'));
    // Halaman Profil: hero merah + nama + wilayah.
    window.location.hash = '#/profile';
    window.eval('route()');
    await sleep(300);
    check('Profil: hero tampil (nama + Belum Bernegara + Jakarta)', !!document.querySelector('.profile-hero-name') && document.querySelector('.profile-hero-name').textContent.includes('warga_tes') && document.querySelector('#page').textContent.includes('Belum Bernegara') && document.querySelector('#page').textContent.includes('Jakarta'));
    // Foto profil (Masalah 1): tombol Ubah Foto muncul di profil sendiri
    // (user_id sama dengan ME) dan TIDAK muncul di profil orang lain.
    // Perbandingan memakai user_id, bukan username — nama tampil huruf
    // kapital semua tapi yang tersimpan bisa campur huruf, jadi
    // perbandingan nama rapuh dan pernah menyembunyikan tombol ini.
    check('Profil sendiri: tombol Ubah Foto (#btn-avatar-change) tampil', !!document.querySelector('#btn-avatar-change'));
    window.location.hash = '#/profile/orang_lain';
    window.eval('route()');
    await sleep(300);
    check('Profil orang lain: tombol Ubah Foto TIDAK tampil', !document.querySelector('#btn-avatar-change') && document.querySelector('#page').textContent.includes('orang_lain'));
    // Halaman Inventaris: grid makanan 5 kartu.
    window.location.hash = '#/inventory';
    window.eval('route()');
    await sleep(300);
    check('Inventaris: grid MAKANAN 5 kartu T1–T5', document.querySelectorAll('#page .food-grid .food-card').length === 5, `${document.querySelectorAll('#page .food-grid .food-card').length} kartu`);
    // 17) Bug tab chat (laporan pemain Vincent): pill aktif harus mengikuti
    // ruangan — sebelumnya highlight selalu menempel di GLOBAL karena `room`
    // baru diubah setelah tab dirender. Uji tiap tab: pill + judul + isi.
    window.api = async (path) => {
      const m = path.match(/^\/api\/chat\/(global|indonesia|region_\d+)/);
      if (m) {
        const room = m[1];
        const titles = { global: 'OBROLAN GLOBAL', indonesia: 'OBROLAN INDONESIA', region_1: 'OBROLAN WILAYAH' };
        return { room, title: titles[room], messages: [{ id: 1, citizen_id: 1, username: 'warga_tes', avatar: null, content: `Pesan tes ruangan ${room} tiga kata`, created_at: Date.now(), isPremium: false, party_tag: null, article_id: null }] };
      }
      throw new Error('api tak terduga: ' + path);
    };
    const chatRoomCheck = async (hash, tabLabel, title, roomWord) => {
      window.location.hash = hash;
      window.eval('route()');
      await sleep(300);
      const active = document.querySelector('.chat-tabs .tab.active');
      const h2 = document.querySelector('.chat-title');
      const list = document.querySelector('#chat-list');
      check(`Chat ${hash}: pill aktif = ${tabLabel}`, !!active && active.textContent.trim() === tabLabel, active?.textContent);
      check(`Chat ${hash}: judul = ${title}`, !!h2 && h2.textContent.includes(title), h2?.textContent);
      check(`Chat ${hash}: isi pesan ruangan ${roomWord} tampil`, !!list && list.textContent.includes(`Pesan tes ruangan ${roomWord}`), list?.textContent.slice(0, 80));
    };
    await chatRoomCheck('#/chat', 'GLOBAL', 'OBROLAN GLOBAL', 'global');
    await chatRoomCheck('#/chat/indonesia', 'INDONESIA', 'OBROLAN INDONESIA', 'indonesia');
    await chatRoomCheck('#/chat/wilayah', 'WILAYAH', 'OBROLAN WILAYAH', 'region_1');

    // 18) Bug koran dobel (laporan pemain Vincent): tombol Dirikan Koran
    // nonaktif + loading saat request berjalan; tombol Bubarkan ada untuk
    // koran sendiri dan memanggil DELETE.
    let npResolve;
    const dissolveCalls = [];
    window.api = async (path, opts) => {
      if (path === '/api/press/newspapers/mine') return { newspapers: [] };
      if (path === '/api/press/newspaper' && opts?.method === 'POST') return new Promise((res) => { npResolve = () => res({ ok: true, newspaperId: 8 }); });
      if (path === '/api/me') return meRevamp;
      throw new Error('api tak terduga: ' + path);
    };
    window.location.hash = '#/newspaper';
    window.eval('route()');
    await sleep(300);
    const btnNp = document.querySelector('#btn-np');
    check('Dirikan Koran: tombol tampil', !!btnNp);
    btnNp.click();
    check('Dirikan Koran: tombol nonaktif + teks loading saat request berjalan', btnNp.disabled === true && btnNp.textContent.includes('MENDIRIKAN'), `disabled=${btnNp.disabled} teks=${btnNp.textContent}`);
    btnNp.click();
    check('Dirikan Koran: klik kedua saat loading diabaikan (tetap nonaktif)', btnNp.disabled === true);
    npResolve();
    await sleep(300);
    check('Dirikan Koran: toast sukses tampil setelah request selesai', !document.querySelector('#toast').hidden && document.querySelector('#toast').textContent.includes('Koran didirikan'), document.querySelector('#toast').textContent);
    // Daftar koranku: tombol Bubarkan tampil + memanggil DELETE (konfirmasi disetujui).
    window.confirm = () => true;
    window.api = async (path, opts) => {
      if (path === '/api/press/newspapers/mine') return { newspapers: [{ id: 5, name: 'Kabar Tes', created_at: Date.now() }] };
      if (path === '/api/press/newspapers/5' && opts?.method === 'DELETE') { dissolveCalls.push(path); return { ok: true }; }
      throw new Error('api tak terduga: ' + path);
    };
    window.location.hash = '#/newspaper';
    window.eval('route()');
    await sleep(300);
    const btnDissolve = document.querySelector('[data-dissolve="5"]');
    check('Koran sendiri: tombol Bubarkan tampil', !!btnDissolve && btnDissolve.textContent.includes('Bubarkan'));
    btnDissolve.click();
    await sleep(300);
    check('Bubarkan: DELETE /api/press/newspapers/5 dipanggil', dissolveCalls.includes('/api/press/newspapers/5'), dissolveCalls.join(','));
    check('Bubarkan: toast sukses tampil', !document.querySelector('#toast').hidden && document.querySelector('#toast').textContent.includes('Koran dibubarkan'), document.querySelector('#toast').textContent);

    // 19) Suara ketukan kedua ("thock" untuk tombol utama): playThock ada,
    // lebih rendah dari playTap, dan pointerdown mengarahkannya ke tombol
    // emas/BELI/submit — ketukan biasa tetap memakai playTap.
    const jsSnd = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
    check('Suara: playThock ada + nada lebih rendah (340→150 Hz + sub 130→70)',
      jsSnd.includes('function playThock()') && jsSnd.includes('setValueAtTime(340') && jsSnd.includes('setValueAtTime(130'));
    check('Suara: pointerdown memakai thock untuk .btn-gold/.btn-buy/submit, tap untuk lainnya',
      jsSnd.includes("el.closest('.btn-gold, .btn-buy, [data-buy], button[type=\"submit\"]')") && jsSnd.includes('playThock()') && jsSnd.includes('else playTap()'));
    check('Suara: playThock hormat pengaturan yang sama + diam tanpa Web Audio',
      /function playThock\(\) \{\n  if \(!soundEnabled\(\)\) return;/.test(jsSnd) && jsSnd.includes('if (!AC) return;'));

    // Statis: kelas CSS baru ada; tidak ada onclick inline baru.
    const css2 = fs.readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
    check('CSS: kelas rombak UI ada (law-banner, profile-hero, food-grid, popover, seg-bar, quote)', ['.law-banner', '.profile-hero', '.food-grid', '.popover-backdrop', '.seg-bar', '.quote'].every((c) => css2.includes(c)));
    // Rombak UI gaya Parlamentum (papan pasar + kartu penawaran + menu 2 kolom + banner perang).
    check('CSS: kelas papan pasar/menu baru ada (board-row, offer-card, nav-grid, war-banner)',
      ['.board-row', '.board-price', '.offer-card', '.badge-best', '.btn-buy', '.nav-grid', '.war-banner', '.com-icon'].every((c) => css2.includes(c)));
    const js4 = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
    check('app.js: papan pasar pakai baris + kartu penawaran (TERBAIK, MAKS, pajak impor 2%)',
      js4.includes('board-row') && js4.includes('offer-card') && js4.includes('TERBAIK') && js4.includes('data-max') && js4.includes('pajak impor 2%'));
    check('app.js: banner perang hanya dari data perang (activeWars)', js4.includes('ME?.activeWars') && js4.includes('updateWarBanner'));
    // Open Graph + Twitter Card di halaman utama + gambar preview disajikan.
    const html2 = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    check('index.html: meta Open Graph + Twitter Card ada (og:title/description/image/url, twitter:card)',
      html2.includes('og:title" content="Parlementer — Dunia yang Berjalan oleh Para Pemain') && html2.includes('og:description" content="Bekerja, berdagang, memilih, memerintah, hingga berperang') && html2.includes('og:image" content="https://parlementer.my.id/og-image.jpg') && html2.includes('og:url" content="https://parlementer.my.id/') && html2.includes('twitter:card" content="summary_large_image') && html2.includes('twitter:image" content="https://parlementer.my.id/og-image.jpg'));
    const ogRes = await fetch(BASE + '/og-image.jpg');
    check('gambar preview OG disajikan (GET /og-image.jpg 200, image/jpeg)',
      ogRes.status === 200 && (ogRes.headers.get('content-type') || '').includes('image/jpeg'), `status=${ogRes.status} type=${ogRes.headers.get('content-type')}`);
    // Bug chat: ruangan ditentukan di awal ROUTES.chat; tidak ada lagi
    // pengubahan `room` setelah tab dirender (penyebab pill nyangkut di GLOBAL).
    // Room 'negara' dihapus (redesain dunia) — diganti 'wilayah' (region_<id>).
    check('app.js: ruangan chat ditentukan di awal + tidak ada lagi ubah room setelah render + cabang wilayah ada',
      js4.includes("if (sub === 'indonesia') { room = 'indonesia';") && !js4.includes("if (sub === 'indonesia' || sub === 'negara') { room = sub; }") && js4.includes("else if (sub === 'wilayah') { room = 'region_' + ME.region.id;"));
    // Bug koran dobel: tombol loading + Bubarkan di client, penjaga + DELETE di server.
    check('app.js: tombol Dirikan Koran nonaktif + loading (MENDIRIKAN) + tombol Bubarkan (data-dissolve)',
      js4.includes('MENDIRIKAN…') && js4.includes('data-dissolve') && js4.includes("method: 'DELETE'"));
    const civic = fs.readFileSync(new URL('../src/api-civic.js', import.meta.url), 'utf8');
    check('Server: penjaga koran nama sama (400) + endpoint DELETE bubarkan koran ada',
      civic.includes('Kamu sudah punya koran bernama itu.') && civic.includes("app.delete('/api/press/newspapers/:id'"));
    const js3 = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
    check('app.js: peti dihubungkan ke claimDaily (POST /api/claim)', js3.includes("$('#btn-crate').onclick = claimDaily") && js3.includes("post('/api/claim')"));
    // Cek presisi (bukan substring '#btn-claim'): tombol banner v5.3.0
    // bernama #btn-claim-banner — substring itu bukan tombol klaim lama.
    // Yang dijamin hilang: elemen id="btn-claim" + selector $('#btn-claim').
    check('app.js: tombol klaim lama (#btn-claim) sudah dihapus',
      !js3.includes('id="btn-claim"') && !js3.includes("$('#btn-claim')"));

    dom.window.close();
  } finally {
    stop();
  }

  console.log(`[modal-dom] ${passed} lolos, ${failed} gagal`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
