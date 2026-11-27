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
    window.eval("ME = { user: { id: 1, username: 'warga_tes', publicId: 'PL-000099', is_banned: false }, citizen: { id: 1, username: 'warga_tes', energy: 100, gold: 500, usd: 500, xp: 0, level: 5 }, region: { name: 'Jakarta' }, xpNext: 10, unread: 0, unreadDm: 0 }");
    window.api = async (path) => {
      if (path === '/api/parliament') return {
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
    check('Parlemen: UU pajak tampil dengan jenis + efek diterapkan', parlText.includes('UU Pajak 4 Persen') && parlText.includes('efek diterapkan'));
    // Jenis UU mengubah tampilan input nilai (umum: sembunyi; pajak: tampil).
    lawKind.value = 'tax_income';
    lawKind.dispatchEvent(new window.Event('change', { bubbles: true }));
    check('Parlemen: pilih jenis pajak menampilkan input NILAI BARU', document.querySelector('#law-value-wrap').style.display !== 'none');
    lawKind.value = 'general';
    lawKind.dispatchEvent(new window.Event('change', { bubbles: true }));
    check('Parlemen: pilih UU umum menyembunyikan input nilai', document.querySelector('#law-value-wrap').style.display === 'none');

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

    dom.window.close();
  } finally {
    stop();
  }

  console.log(`[modal-dom] ${passed} lolos, ${failed} gagal`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
