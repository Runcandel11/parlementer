// Parlementer — aplikasi web (SPA vanilla JS, tema gelap navy-hitam aksen emas).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: d });
const fmtIDR = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');
// Kurs tampilan Rupiah — SATU tempat: 1 USD = Rp18.300. Semua jumlah USD
// (saldo, harga, gaji, kas negara, hadiah) ditampilkan sebagai Rupiah;
// database & API tetap dalam USD (tidak ada migrasi saldo — ekonomi tidak
// berubah). Konversi pulih tepat: nilai USD disimpan REAL, jadi
// fmtRp(rpToUsd(x)) sama dengan nilai Rupiah asal setelah dibulatkan.
const RP_PER_USD = 18300;
const fmtRp = (usd) => fmtIDR(Math.round(Number(usd || 0) * RP_PER_USD));
const rpToUsd = (rp) => Number(rp || 0) / RP_PER_USD;
const fmtTime = (ts) => { const d = toDate(ts); return d ? d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '—'; };
const fmtDate = (ts) => { const d = toDate(ts); return d ? d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'; };
// Normalisasi timestamp ke Date — menerima number MAUPUN string angka
// (driver Postgres mengembalikan BIGINT sebagai string; tanpa Number() di
// sini, new Date("1793...") = Invalid Date — bug 27 Nov 2026). null/kosong/
// bukan-angka → null (ditampilkan '—', bukan "Invalid Date").
const toDate = (ts) => {
  if (ts == null || ts === '') return null;
  const d = new Date(Number(ts));
  return Number.isNaN(d.getTime()) ? null : d;
};
const ago = (ts) => {
  const d = toDate(ts);
  if (!d) return '—';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'baru saja';
  if (s < 3600) return Math.floor(s / 60) + ' mnt lalu';
  if (s < 86400) return Math.floor(s / 3600) + ' jam lalu';
  return Math.floor(s / 86400) + ' hari lalu';
};

let ME = null; // hasil /api/me
let chatTimer = null;
let chatRoom = null; // ruangan chat yang sedang dibuka (untuk refresh saat tab kembali aktif)
let chatSince = 0;

// Avatar bulat: foto (data URL) bila ada, huruf awal nama bila tidak.
const avatarHtml = (avatar, username, size = 40) => avatar
  ? `<img src="${esc(avatar)}" class="avatar-img" style="width:${size}px;height:${size}px" alt="">`
  : `<span class="avatar-initial" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px">${esc((username || '?')[0].toUpperCase())}</span>`;

// Baca file gambar → resize/crop persegi 256×256 lewat canvas → data URL JPEG,
// plus thumbnail 48×48 untuk daftar chat/DM (Tahap 3, §6.3).
// Mengembalikan { avatar, avatarSm } atau null bila file bukan gambar atau
// hasil akhirnya tetap > 500 KB (thumbnail > 25 KB).
async function processAvatarFile(file) {
  if (!file || !file.type.startsWith('image/')) return null;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('gagal membaca gambar'));
      i.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const s = Math.min(img.width, img.height);
    const sx = Math.floor((img.width - s) / 2);
    const sy = Math.floor((img.height - s) / 2);
    ctx.drawImage(img, sx, sy, s, s, 0, 0, 256, 256);
    let avatar = null;
    for (const q of [0.85, 0.6, 0.4]) {
      const dataUrl = canvas.toDataURL('image/jpeg', q);
      // Data URL base64 ≈ 4/3 ukuran biner; 500 KB biner ≈ 682.667 karakter.
      if (dataUrl.length <= 682667) { avatar = dataUrl; break; }
    }
    if (!avatar) return null;
    // Thumbnail 48×48 dari canvas yang sama (25 KB biner ≈ 34.100 karakter).
    const sm = document.createElement('canvas');
    sm.width = 48; sm.height = 48;
    sm.getContext('2d').drawImage(canvas, 0, 0, 48, 48);
    const avatarSm = sm.toDataURL('image/jpeg', 0.8);
    if (avatarSm.length > 34100) return null;
    return { avatar, avatarSm };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.hidden = true; }, 3500);
}

// Sampul artikel: baca file gambar → crop tengah 1200×630 (rasio 40:21,
// seperti gambar pratinjau) lewat canvas → data URL JPEG, plus thumbnail
// 400×210 untuk daftar artikel. Mengembalikan { cover, coverSm } atau null
// bila file bukan gambar atau hasil akhirnya tetap > 500 KB (thumbnail
// > 50 KB). Pola sama seperti processAvatarFile (tangga kualitas JPEG).
async function processCoverFile(file) {
  if (!file || !file.type.startsWith('image/')) return null;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('gagal membaca gambar'));
      i.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 1200; canvas.height = 630;
    const ctx = canvas.getContext('2d');
    const targetRatio = 1200 / 630;
    const imgRatio = img.width / img.height;
    let sw, sh, sx, sy;
    if (imgRatio > targetRatio) { sh = img.height; sw = Math.floor(sh * targetRatio); sx = Math.floor((img.width - sw) / 2); sy = 0; }
    else { sw = img.width; sh = Math.floor(sw / targetRatio); sx = 0; sy = Math.floor((img.height - sh) / 2); }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, 1200, 630);
    let cover = null;
    for (const q of [0.85, 0.6, 0.4]) {
      const dataUrl = canvas.toDataURL('image/jpeg', q);
      // 500 KB biner ≈ 682.667 karakter base64.
      if (dataUrl.length <= 682667) { cover = dataUrl; break; }
    }
    if (!cover) return null;
    // Thumbnail 400×210 dari canvas yang sama (50 KB biner ≈ 68.266 karakter).
    const sm = document.createElement('canvas');
    sm.width = 400; sm.height = 210;
    sm.getContext('2d').drawImage(canvas, 0, 0, 400, 210);
    let coverSm = null;
    for (const q of [0.75, 0.6, 0.45]) {
      const dataUrl = sm.toDataURL('image/jpeg', q);
      if (dataUrl.length <= 68266) { coverSm = dataUrl; break; }
    }
    if (!coverSm) return null;
    return { cover, coverSm };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Gambar di dalam isi artikel: muat dalam lebar maks 1024px (rasio asli
// dipertahankan) → data URL JPEG. Mengembalikan data URL atau null bila
// file bukan gambar atau hasil akhirnya tetap > 300 KB biner
// (≈ 409.600 karakter base64).
async function processInlineImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return null;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('gagal membaca gambar'));
      i.src = url;
    });
    const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const q of [0.85, 0.65, 0.45]) {
      const dataUrl = canvas.toDataURL('image/jpeg', q);
      if (dataUrl.length <= 409600) return dataUrl;
    }
    return null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- SUARA KETUKAN (Tahap 4) ----------
// Ketukan halus disintesis Web Audio API (tanpa file audio, tanpa
// dependensi). AudioContext dibuat malas saat interaksi pertama — browser
// melarang autoplay, jadi suara HANYA muncul dari ketukan pengguna. Bila
// Web Audio tidak tersedia, diam saja (jangan ganggu permainan).
// Preferensi tersimpan di localStorage ('parlementer_sound' = on/off).
const SOUND_KEY = 'parlementer_sound';
function soundEnabled() {
  try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; }
}
function setSoundEnabled(on) {
  try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* abaikan */ }
}
let __audioCtx = null;
function playTap() {
  if (!soundEnabled()) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    __audioCtx = __audioCtx || new AC();
    if (__audioCtx.state === 'suspended') void __audioCtx.resume();
    const t0 = __audioCtx.currentTime;
    const osc = __audioCtx.createOscillator();
    const gain = __audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1400, t0);
    osc.frequency.exponentialRampToValueAtTime(700, t0 + 0.06);
    gain.gain.setValueAtTime(0.06, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
    osc.connect(gain).connect(__audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.08);
  } catch { /* suara gagal: jangan ganggu permainan */ }
}
// Ketukan kedua — "thock" yang sedikit lebih rendah/dalam untuk tombol
// UTAMA/konfirmasi (BELI, KIRIM, SIMPAN, tombol emas). Ketukan halus di
// atas tetap dipakai untuk ketukan biasa. Sama-sama disintesis Web Audio
// (tanpa file audio, tanpa dependensi), hormat 'parlementer_sound', diam
// bila Web Audio tidak tersedia, volume dijaga pelan (≤0.08) agar tidak
// mengganggu. Nada: triangle 340→150 Hz + sub sine 130→70 Hz.
function playThock() {
  if (!soundEnabled()) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    __audioCtx = __audioCtx || new AC();
    if (__audioCtx.state === 'suspended') void __audioCtx.resume();
    const t0 = __audioCtx.currentTime;
    const osc = __audioCtx.createOscillator();
    const gain = __audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(340, t0);
    osc.frequency.exponentialRampToValueAtTime(150, t0 + 0.08);
    gain.gain.setValueAtTime(0.08, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);
    osc.connect(gain).connect(__audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.12);
    const sub = __audioCtx.createOscillator();
    const subGain = __audioCtx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(130, t0);
    sub.frequency.exponentialRampToValueAtTime(70, t0 + 0.09);
    subGain.gain.setValueAtTime(0.05, t0);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
    sub.connect(subGain).connect(__audioCtx.destination);
    sub.start(t0);
    sub.stop(t0 + 0.11);
  } catch { /* suara gagal: jangan ganggu permainan */ }
}
// Navigasi tanpa inline onclick: CSP Tahap 2 (script-src 'self') memblokir
// SEMUA handler inline, sehingga 50 tombol navigasi (TULIS ARTIKEL, Buka
// Parlemen, kartu artikel, dsb.) mati di browser sungguhan — klik tidak
// berbuat apa-apa. Semua navigasi memakai data-goto="#/..." dan didelegasikan
// di sini (berlaku juga untuk konten yang dirender belakangan).
document.addEventListener('click', (e) => {
  const go = e.target?.closest?.('[data-goto]');
  if (go) { location.hash = go.dataset.goto; return; }
  if (e.target?.closest?.('[data-reload]')) location.reload();
});
// Tiap ketukan pada elemen interaktif membunyikan tap — tombol utama /
// konfirmasi (emas, BELI, submit form) memakai thock yang lebih dalam.
document.addEventListener('pointerdown', (e) => {
  const el = e.target?.closest?.('button, a, input, select, textarea, [role="button"], .nav-item');
  if (!el) return;
  if (el.closest('.btn-gold, .btn-buy, [data-buy], button[type="submit"]')) playThock();
  else playTap();
});

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Terjadi kesalahan.');
  return data;
}
const post = (path, body = {}) => api(path, { method: 'POST', body });

// ---------- AUTH ----------
function hideLoading() {
  const l = $('#loading-screen');
  if (l) l.hidden = true;
}

async function boot() {
  try {
    const me = await api('/api/auth/me');
    if (me.citizen) { showApp(); return; }
  } catch { /* belum login */ }
  showAuth();
}

function showAuth() {
  hideLoading();
  $('#app').hidden = true;
  $('#auth-view').hidden = false;
  $('#tab-login').onclick = () => switchAuthTab('login');
  $('#tab-register').onclick = () => switchAuthTab('register');
  // Link referral ?ref=CODE: isi otomatis field kode dan buka tab DAFTAR.
  const refParam = new URLSearchParams(location.search).get('ref');
  if (refParam) {
    const refInput = $('#form-register input[name="ref"]');
    if (refInput) refInput.value = refParam.trim().toUpperCase().slice(0, 8);
    switchAuthTab('register');
  }
  $('#form-login').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = $('#login-error');
    err.hidden = true;
    try {
      await post('/api/auth/login', { email: f.email.value.trim(), password: f.password.value });
      showApp();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
  $('#form-register').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = $('#register-error');
    err.hidden = true;
    try {
      await post('/api/auth/register', {
        email: f.email.value.trim(), password: f.password.value,
        username: f.username.value.trim(), ref: f.ref.value.trim() || undefined,
        admin_code: f.admin_code.value.trim() || undefined,
      });
      toast('Selamat datang! Dunia ini masih terpecah — dirikan negaramu sendiri.');
      showApp();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
}
function switchAuthTab(which) {
  $('#tab-login').classList.toggle('active', which === 'login');
  $('#tab-register').classList.toggle('active', which === 'register');
  $('#form-login').hidden = which !== 'login';
  $('#form-register').hidden = which !== 'register';
}

async function logout() {
  await post('/api/auth/logout');
  location.hash = '';
  location.reload();
}

// Link Discord resmi game — dipakai di menu drawer (KOMUNITAS) dan panel
// komunitas dashboard. Selalu target _blank (tab baru), bukan di dalam game.
const DISCORD_URL = 'https://discord.gg/JX7DWX3pF';

// ---------- SHELL ----------
const NAV = [
  { group: 'BERANDA', items: [
    ['dashboard', 'Dashboard', '▦'], ['profile', 'Profil', '👤'],
    ['achievements', 'Pencapaian', '🏆'],
    ['inventory', 'Inventaris', '📦'], ['convoy', 'Konvoi', '🚚'],
    ['activity', 'Aktivitas Saya', '📋'],
  ]},
  { group: 'DUNIA', items: [
    ['map', 'Peta', '🗺'], ['regions', 'Wilayah', '📍'],
    ['country', 'Negara', '🏛'], ['stats', 'Statistik', '📊'],
  ]},
  { group: 'EKONOMI', items: [
    ['market', 'Pasar', '🏪'], ['global', 'Pasar Global', '🌐'], ['fx', 'Valas', '⇄'],
    ['jobs', 'Pekerjaan', '💼'], ['companies', 'Perusahaan', '🏭'], ['contracts', 'Kontrak', '📜'],
  ]},
  { group: 'KOMUNITAS', items: [
    ['press', 'Pers', '📰'], ['newspaper', 'Dirikan Koran', '✏️'],
    ['messages', 'Pesan', '✉️'], ['chat', 'Obrolan', '💬'],
    ['discord', 'Discord', '🎮', DISCORD_URL],
  ]},
  { group: 'POLITIK', items: [
    ['parties', 'Partai', '🚩'], ['parliament', 'Parlemen', '🏛'],
    ['elections', 'Pemilu', '🗳'], ['orgs', 'Organisasi', '🤝'],
  ]},
  { group: 'PERANG', items: [
    ['war', 'Perang Tanah Air', '🛡️'], ['war-world', 'Perang Dunia', '🔥'],
  ]},
  { group: 'BANTUAN', items: [
    ['help', 'Meja Bantuan', '🎧'], ['contact', 'Kontak', '✉️'],
    ['book', 'Buku', '📖'], ['shop', 'Toko', '💎'],
  ]},
];

function buildNav() {
  const adminGroup = ME?.citizen?.is_admin ? `
    <div class="nav-group">ADMIN</div>
    <div class="nav-grid"><button class="nav-item" data-route="admin" type="button"><span class="ico">🛡️</span>Panel Admin</button></div>` : '';
  $('#drawer-nav').innerHTML = NAV.map((g) => `
    <div class="nav-group">${g.group}</div>
    <div class="nav-grid">${g.items.map(([slug, label, ico, href]) => href ? `
      <a class="nav-item" href="${href}" target="_blank" rel="noopener noreferrer">
        <span class="ico">${ico}</span>${label}
      </a>` : `
      <button class="nav-item" data-route="${slug}" type="button">
        <span class="ico">${ico}</span>${label}
      </button>`).join('')}</div>`).join('') + adminGroup + `
    <div class="nav-group">AKUN</div>
    <div class="nav-grid">
      <button class="nav-item" data-route="settings" type="button"><span class="ico">⚙️</span>Pengaturan</button>
      <button class="nav-item" id="nav-logout" type="button"><span class="ico">🚪</span>Keluar</button>
    </div>
    <div id="drawer-war"></div>`;
  $$('#drawer-nav .nav-item[data-route]').forEach((b) => {
    b.onclick = () => { closeDrawer(); location.hash = '#/' + b.dataset.route; };
  });
  $('#nav-logout').onclick = logout;
  updateWarBanner();
}

// Banner perang di bawah menu (gaya Parlamentum): HANYA bila /api/me
// melaporkan perang aktif untuk pemain ini (ME.activeWars) — tidak pernah
// dikarang. Diperbarui tiap refreshMe supaya muncul/hilang mengikuti data.
function updateWarBanner() {
  const slot = $('#drawer-war');
  if (!slot) return;
  const wars = ME?.activeWars || [];
  if (!wars.length) { slot.innerHTML = ''; return; }
  const w = wars[0];
  const total = (Number(w.score_a) || 0) + (Number(w.score_d) || 0);
  const pct = total ? Math.round((Number(w.score_a) || 0) / total * 100) : 50;
  slot.innerHTML = `<button class="war-banner" type="button" data-goto="#/war">
    <span class="war-ico">⚔️</span>
    <span class="war-txt">
      <span class="war-title">Negaramu sedang berperang</span>
      <span class="war-sub">${esc(w.name)} · ${esc(w.region_name || '')} — ${fmt(w.score_a)} vs ${fmt(w.score_d)}</span>
      <span class="bar red"><i style="width:${pct}%"></i></span>
    </span>
  </button>`;
  slot.querySelector('.war-banner').onclick = () => { closeDrawer(); location.hash = '#/war'; };
}

function openDrawer() { $('#drawer').classList.add('open'); $('#drawer-overlay').classList.add('open'); }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawer-overlay').classList.remove('open'); }

// Pasokan harian (rombak UI): peti di HUD menggantikan tombol AMBIL PASOKAN
// lama — POST /api/claim, lalu segarkan HUD + halaman.
async function claimDaily() {
  try { const r = await post('/api/claim'); toast(`Pasokan diterima: +${r.reward.gold} emas, +${fmtRp(r.reward.usd)}, +${r.reward.xp} XP.`); await refreshMe(); route(); }
  catch (e) { toast(e.message); }
}

async function showApp() {
  hideLoading();
  $('#auth-view').hidden = true;
  $('#app').hidden = false;
  await refreshMe(); // dulu, supaya buildNav tahu apakah warga ini admin
  buildNav();
  $('#btn-menu').onclick = openDrawer;
  $('#drawer-close').onclick = closeDrawer;
  $('#drawer-overlay').onclick = closeDrawer;
  $('#btn-chat').onclick = () => { location.hash = '#/chat'; };
  $('#energy-chat').onclick = () => { location.hash = '#/chat'; };
  $('#btn-notif').onclick = () => { location.hash = '#/notifications'; };
  $('#btn-settings').onclick = () => { location.hash = '#/settings'; };
  // Peti pasokan harian (rombak UI): sama dengan tombol AMBIL PASOKAN
  // lama — POST /api/claim, lalu segarkan HUD + halaman.
  $('#btn-crate').onclick = claimDaily;
  window.addEventListener('hashchange', route);
  route();
  maybeShowAnnouncement();
  // Polling hemat (Tahap 5 — lag): saat tab tidak aktif, jangan membebani
  // server dengan polling /api/me tiap 30 detik + chat tiap 5 detik.
  // Saat tab kembali aktif, langsung refresh sekali (listener di bawah).
  setInterval(() => { if (!document.hidden) refreshMe(); }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    refreshMe();
    if (chatRoom) renderChatRoom(chatRoom);
  });
}

async function refreshMe() {
  try {
    ME = await api('/api/me');
    // Akun dibanned di tengah sesi: alihkan ke halaman banned.
    if (ME.user?.is_banned && location.hash !== '#/banned') location.hash = '#/banned';
    renderHUD();
  } catch { /* sesi habis */ }
}

function renderHUD() {
  if (!ME) return;
  const c = ME.citizen;
  $('#hud-name').textContent = c.username + (c.isPremium ? ' ◆' : '');
  $('#hud-region').textContent = (ME.region?.name || '') + ' · ' + (ME.region?.country_name || ME.country?.name || 'Wilayah Merdeka');
  $('#hud-usd').textContent = fmtRp(c.usd);
  $('#hud-gold').textContent = fmt(c.gold);
  $('#hud-xp').textContent = c.xp + '/' + ME.xpNext;
  $('#hud-lv').textContent = c.level;
  const segs = $('#energy-segs');
  // Batas energi tidak selalu 100 (Tahap 3): Premium 120, Rumah Sakit
  // Lapangan 110 — /api/me mengirim energyCap; default 100 untuk keamanan.
  const cap = c.energyCap || 100;
  const filled = Math.round((c.energy / cap) * 10);
  segs.innerHTML = Array.from({ length: 10 }, (_, i) => `<i class="${i < filled ? 'on' : ''}"></i>`).join('');
  $('#energy-num').textContent = c.energy + '/' + cap;
  const badge = (id, n) => { const el = $(id); el.hidden = !n; el.textContent = n > 99 ? '99+' : n; };
  badge('#badge-notif', ME.unread);
  badge('#badge-chat', ME.unreadDm);
  badge('#badge-chat2', ME.unreadDm);
  // Banner UU (rombak UI): jumlah UU yang sedang divoting + sisa waktu
  // voting terdekat. Tersembunyi bila tidak ada UU yang divoting.
  const banner = $('#law-banner');
  if (banner) {
    const laws = ME.votingLaws || [];
    if (laws.length) {
      const ends = laws.map((l) => Number(l.ends_at) || 0).filter((x) => x > 0);
      const nearest = ends.length ? Math.min(...ends) : 0;
      banner.hidden = false;
      banner.innerHTML = `<b>${laws.length} undang-undang sedang dibahas</b> · sisa ${fmtRemaining(nearest ? nearest - Date.now() : 0)}`;
    } else banner.hidden = true;
  }
  // Countdown parlemen (redesain dunia): tampil di ATAS sampai parlemen
  // dibuka 2 Des 2026. Diperbarui tiap refresh /api/me (30 detik).
  const pcd = $('#parliament-countdown');
  if (pcd) {
    if (ME.parliamentOpen) pcd.hidden = true;
    else {
      pcd.hidden = false;
      pcd.innerHTML = `<b>🏛️ Parlemen dibuka ${fmtCountdown(Number(ME.parliamentOpensAt) - Date.now())} lagi</b> · 2 Des 2026`;
    }
  }
  // Tombol peti pasokan harian (rombak UI): di bawah hamburger; berdenyut
  // emas + badge 1 bila pasokan hari ini belum diambil.
  const crate = $('#btn-crate');
  if (crate) {
    const canClaim = c.last_claim_date !== new Date().toISOString().slice(0, 10);
    crate.disabled = !canClaim;
    crate.classList.toggle('ready', canClaim);
    crate.classList.toggle('claimed', !canClaim);
    const cb = $('#badge-crate');
    if (cb) cb.hidden = !canClaim;
  }
  // Banner perang di bawah menu mengikuti data perang terbaru (/api/me).
  updateWarBanner();
}

// Sisa waktu sampai akhir voting UU, gaya "1j 15mnt" / "45 mnt".
const fmtRemaining = (ms) => {
  if (ms == null || ms <= 0) return 'segera berakhir';
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + ' mnt';
  return Math.floor(m / 60) + 'j ' + (m % 60) + ' mnt';
};

// Sisa waktu sampai parlemen dibuka, gaya "4 hari 11 jam 30 mnt".
const fmtCountdown = (ms) => {
  if (ms == null || ms <= 0) return 'sebentar lagi';
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d} hari ${h} jam ${mm} mnt`;
  if (h > 0) return `${h} jam ${mm} mnt`;
  return `${mm} mnt`;
};

// Sisa jeda latihan, gaya "7 mnt" / "45 dtk" (bulat ke atas supaya tombol
// tidak bilang "0 dtk" selagi masih jeda).
const fmtCooldown = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 60) return Math.ceil(s / 60) + ' mnt';
  return s + ' dtk';
};

// ---------- POPOVER PENJELASAN (rombak UI) ----------
// Kartu penjelasan tengah layar (energi / kelelahan) — menutup lewat tombol
// ✕, klik backdrop, atau Escape. Isinya angka game yang sebenarnya
// (regen +2/mnt, ambang kelelahan 10.000/15.000), bukan angka referensi.
function showPopover(title, big, bodyHtml) {
  const root = $('#popover-root');
  root.innerHTML = `<div class="popover-backdrop" id="popover-backdrop">
    <div class="popover-card" role="dialog" aria-label="${esc(title)}">
      <button class="popover-close" id="popover-close" type="button" aria-label="Tutup">✕</button>
      <h3>${esc(title)}</h3>
      <div class="popover-big">${big}</div>
      ${bodyHtml}
    </div></div>`;
  $('#popover-close').onclick = closePopover;
  $('#popover-backdrop').addEventListener('click', (e) => { if (e.target.id === 'popover-backdrop') closePopover(); });
}
function closePopover() { const root = $('#popover-root'); if (root) root.innerHTML = ''; }
function showEnergyPopover() {
  const c = ME.citizen;
  const cap = c.energyCap || 100;
  const base = 100 + 5 * (Math.max(1, c.level) - 1);
  const bonus = cap - base;
  showPopover('REGENERASI ENERGI', '+2 / mnt', `
    <div class="pop-rows">
      <div class="pop-row"><span>Dasar</span><span class="v">+2 / mnt</span></div>
      <div class="pop-row"><span>Energi maksimum</span><span class="v">${cap}</span></div>
      ${bonus > 0 ? `<div class="pop-row"><span>Bonus batas (Premium / RS Lapangan)</span><span class="v teal">+${bonus}</span></div>` : ''}
      <div class="pop-row"><span>Energi sekarang</span><span class="v">${c.energy} / ${cap}</span></div>
    </div>
    <p class="pop-note">${c.energy >= cap ? 'Penuh — gunakan untuk bekerja.' : 'Pulih otomatis +2/menit sampai batas maksimum, termasuk saat kamu offline.'} Energi maksimum ${cap}, ditambah 5 per level.</p>`);
}
function showFatiguePopover() {
  const c = ME.citizen;
  const fatigue = c.fatigue || 0;
  const spent = c.energy_spent_today || 0;
  const tier = fatigue >= 15000 ? 2 : fatigue >= 10000 ? 1 : 0;
  const mult = tier === 2 ? '0.5' : tier === 1 ? '0.75' : '1';
  showPopover('KELELAHAN', `Hari ini ${fmt(spent)} energi dipakai bekerja`, `
    <div class="pop-rows">
      <div class="pop-row ${tier === 0 ? 'current' : ''}"><span>Kelelahan 0–10.000</span><span class="v">×1</span></div>
      <div class="pop-row ${tier === 1 ? 'current' : ''}"><span>Kelelahan 10.000–15.000</span><span class="v gold">×0.75</span></div>
      <div class="pop-row ${tier === 2 ? 'current' : ''}"><span>Kelelahan 15.000+</span><span class="v red">×0.5</span></div>
    </div>
    <p class="pop-note">Kelelahanmu sekarang ${fmt(fatigue)} — hasil kerja ×${mult}. Energi yang kamu pakai bekerja dihitung per hari; kelelahan berkurang 2.000 tiap pergantian hari. Upah mengikuti hasil produksi; XP tidak berubah.</p>`);
}

// ---------- ROUTER ----------
const ROUTES = {};
// ID publik pemain: PL- + nomor urut 6 digit (mis. PL-000001).
const pubId = (id) => 'PL-' + String(id).padStart(6, '0');
function route() {
  clearInterval(chatTimer); chatTimer = null; chatRoom = null; chatSince = 0;
  clearChatRetry(); chatNewCount = 0;
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [slug, arg] = hash.split('/');
  // Akun banned: tampilkan pesan banned, bukan dashboard/game.
  // Layar banned bersih full-screen: HUD (header saldo/level, tombol chat,
  // lonceng, gear, bottom bar energi) disembunyikan lewat class 'banned'
  // di #app — lihat CSS. Di halaman ini pemain bisa mengajukan banding
  // dan membalas thread bandingnya.
  if (ME?.user?.is_banned) {
    $('#app').classList.add('banned');
    renderBannedPage();
    return;
  }
  $('#app').classList.remove('banned');
  $$('#drawer-nav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.route === slug));
  const fn = ROUTES[slug] || ROUTES.dashboard;
  // Skeleton loading (Tahap 3, §7): ganti "Memuat…" polos dengan shimmer
  // supaya perpindahan halaman terasa instan, bukan kosong.
  $('#page').innerHTML = `<div role="status" aria-label="Memuat halaman">
    <div class="skel skel-h"></div>
    <div class="skel skel-p"></div><div class="skel skel-p"></div>
    <div class="skel skel-p" style="width:60%"></div></div>`;
  fn(arg).then(() => {
    // Aksesibilitas (Tahap 3, §7): setelah halaman termuat, fokus ke judul
    // halaman supaya pembaca layar tahu halaman sudah berganti. Chat poll
    // tidak memanggil route(), jadi fokus tidak dicuri saat mengetik.
    const h = $('#page h2');
    if (h) h.focus({ preventScroll: true });
  }).catch((e) => {
    $('#page').innerHTML = `<div class="panel"><h3>Terjadi kesalahan</h3><p class="muted">${esc(e.message)}</p>
      <button class="btn-gold" data-reload="1">Muat Ulang</button></div>`;
  });
}
// ---------- HALAMAN BANNED + BANDING ----------
async function renderBannedPage() {
  const u = ME.user;
  $('#page').innerHTML = page('⛔ AKUN DIBANNED', '', `
  <div class="panel"><div class="empty"><div class="big-ico">⛔</div>
  <h3>Akun ini dibanned</h3>
  <p class="muted">Alasan: ${esc(u.banned_reason || 'tidak dicantumkan')}</p>
  <p class="muted">Akunmu tidak bisa masuk ke game sampai admin mencabut ban ini. Kamu bisa mengajukan banding — admin akan meninjaunya dan membalas di halaman ini juga.</p>
  <div class="row" style="justify-content:center">
    <button class="btn-gold" id="btn-appeal" type="button">📝 AJUKAN BANDING</button>
    <button class="btn-danger" id="btn-banned-logout" type="button">KELUAR</button>
  </div></div></div>
  <div id="appeal-area"></div>`);
  $('#btn-banned-logout').onclick = logout;
  $('#btn-appeal').onclick = () => showAppealForm();
  let appeals = [];
  try { const d = await api('/api/appeals/mine'); appeals = d.appeals || []; }
  catch { /* sesi habis — form banding akan menampilkan error saat kirim */ }
  renderAppealArea(appeals);
}

function renderAppealArea(appeals) {
  const area = $('#appeal-area');
  if (!area) return;
  const active = appeals.find((a) => a.status === 'menunggu');
  const last = appeals[0];
  if (active) {
    area.innerHTML = `<div class="panel"><h3>📝 BANDINGMU — MENUNGGU DITINJAU</h3>
      <p class="muted small">Diajukan ${fmtDate(active.created_at)} · Alasan ban: ${esc(active.ban_reason || '—')}</p>
      <div>${active.messages.map((m) => `
        <div class="msg"><div class="msg-avatar">${m.sender_role === 'admin' ? '🛡' : esc((ME.citizen.username || '?')[0].toUpperCase())}</div>
        <div class="msg-body"><div class="msg-head"><span class="msg-name">${m.sender_role === 'admin' ? 'Admin' : esc(ME.citizen.username)}</span><span class="msg-time">${fmtTime(m.created_at)}</span></div>
        <div class="msg-bubble">${esc(m.text)}</div></div></div>`).join('')}</div>
      <div class="chat-input"><input id="appeal-reply" aria-label="Tulis balasan untuk admin" placeholder="Tulis balasan untuk admin..." maxlength="1000" autocomplete="off">
      <button class="btn-gold" id="btn-appeal-reply" type="button">KIRIM</button></div></div>`;
    const send = async () => {
      const input = $('#appeal-reply');
      const text = input.value.trim();
      if (!text) return;
      try { await post('/api/appeals/' + active.id + '/message', { text }); toast('Balasan terkirim.'); renderBannedPage(); }
      catch (e) { toast(e.message); }
    };
    $('#btn-appeal-reply').onclick = send;
    $('#appeal-reply').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    return;
  }
  if (last && last.status === 'diterima') {
    area.innerHTML = `<div class="panel"><div class="empty"><div class="big-ico">✅</div>
      <h3>Bandingmu DITERIMA</h3><p class="muted">Admin mencabut ban akunmu. Kamu bisa masuk ke game lagi.</p>
      <button class="btn-gold" id="btn-appeal-enter" type="button">MASUK KE GAME</button></div></div>`;
    $('#btn-appeal-enter').onclick = async () => { await refreshMe(); location.hash = '#/dashboard'; route(); };
    return;
  }
  if (last && last.status === 'ditolak') {
    area.innerHTML = `<div class="panel"><h3>❌ BANDING DITOLAK</h3>
      <p class="muted">Admin menolak bandingmu (${fmtDate(last.decided_at)}). Kamu boleh mengajukan banding baru dengan penjelasan yang lebih lengkap — tekan AJUKAN BANDING di atas.</p></div>`;
  }
  // Tidak ada banding aktif → tombol AJUKAN BANDING di atas membuka form.
}

function showAppealForm() {
  const area = $('#appeal-area');
  if (!area) return;
  area.innerHTML = `<div class="panel"><h3>📝 AJUKAN BANDING</h3>
    <p class="muted small">Jelaskan kenapa ban ini seharusnya dicabut. Admin akan membalasmu di halaman ini juga.</p>
    <label>ALASAN / PENJELASAN (minimal 10 karakter)<textarea id="appeal-text" rows="4" maxlength="2000" placeholder="Contoh: Saya tidak pernah memakai cheat..."></textarea></label>
    <div class="row"><button class="btn-gold" id="btn-appeal-submit" type="button">KIRIM BANDING</button></div></div>`;
  $('#btn-appeal-submit').onclick = async () => {
    const text = $('#appeal-text').value.trim();
    try {
      await post('/api/appeals', { text });
      toast('Banding terkirim. Admin akan meninjaunya.');
      renderBannedPage();
    } catch (e) { toast(e.message); }
  };
}

const page = (title, sub, body) => `
  <h2 tabindex="-1">${title}</h2>
  ${sub ? `<p class="page-sub">${sub}</p>` : ''}
  ${body}`;

const emptyState = (ico, title, sub) => `
  <div class="panel"><div class="empty"><div class="big-ico">${ico}</div>
  <h3>${title}</h3><p class="muted">${sub}</p></div></div>`;

// Kutipan pembuka tiap babak KRONIKMU + petunjuk tugas Babak I (teks tampilan
// saja — bukan mekanik; angka hadiah/syarat tetap dari server).
const CHRONICLE_QUOTES = {
  1: 'Tak ada yang mulai dari nol. Setiap hari negara memberi setiap warga sedikit emas, sedikit uang, dan sedikit pengalaman.',
  2: 'Warga yang aktif dikenal di mana-mana — di pasar, di jalan, dan di obrolan.',
  3: 'Uang tidak tidur. Bangun usahamu selagi yang lain masih bermimpi.',
  4: 'Negara ini milik mereka yang mau bersuara — di parlemen, bukan di pinggir jalan.',
  5: 'Sejarah ditulis oleh mereka yang berani maju ke garis depan.',
};
const TASK_HINTS = {
  claim: 'Tekan peti yang bersinar di tab kecil di bawah header, kiri atas. Peti terisi sekali sehari.',
  job: 'Buka halaman Pekerjaan dari menu dan ambil lowongan yang tersedia di wilayahmu.',
  shift: 'Kerjakan satu giliran di pekerjaanmu — butuh 100 energi.',
  train: 'Latih satu atribut di bawah ini — biayanya beberapa emas.',
  eat: 'Ketuk salah satu kartu MAKANAN di bawah untuk mengisi energi.',
  map: 'Buka Peta Dunia dari menu dan lihat wilayah-wilayah yang ada.',
  market: 'Buka Pasar Lokal dari menu dan lihat-lihat barang yang dijual.',
  country: 'Buka halaman Negara dari menu.',
};
const ROMAN = ['I', 'II', 'III', 'IV', 'V'];

// ---------- DASHBOARD ----------
// Render progresif (perbaikan lag dashboard): kerangka dari data ME (hero,
// level, energi, kelelahan, dompet, latihan) tampil LANGSUNG tanpa menunggu
// fetch — tiga panel yang butuh API (misi, kronik, makanan) diisi begitu
// masing-masing selesai, bukan menunggu semuanya. Sebelumnya seluruh
// halaman menunggu Promise.all 3 endpoint, jadi satu endpoint yang lambat
// (cold start / CPU server sibuk, mis. bcrypt saat pemain lain login)
// menahan semua konten di balik skeleton kosong. Pengukuran lokal: tiap
// endpoint ~2–4 ms hangat (dashboard Promise.all ~15 ms) — jadi lambatnya
// di live bukan query-nya, melainkan stall server + render all-or-nothing;
// perbaikan ini menghilangkan bagian render-nya.
ROUTES.dashboard = async () => {
  const c = ME.citizen;
  const cap = c.energyCap || 100;
  const fatigue = c.fatigue || 0;
  const fatigueMultNow = fatigue >= 15000 ? '0.5' : fatigue >= 10000 ? '0.75' : '1';
  let kronikHidden = false;
  try { kronikHidden = localStorage.getItem('parlementer_kronik_hide') === '1'; } catch { /* abaikan */ }
  $('#page').innerHTML = page('DASHBOARD', `Hari ${ME.world.day} · Populasi dunia: ${fmt(ME.population)} warga · <span title="Pemain aktif dalam 5 menit terakhir">🟢 ${fmt(ME.onlineCount ?? 0)} online</span>`, `
  ${ME.activeWars.length ? `<div class="panel"><h3>⚔️ SEDANG TERJADI</h3>
    ${ME.activeWars.map((w) => `<div class="kv"><span class="k">${esc(w.name)}</span><span class="v">${fmt(w.score_a)} vs ${fmt(w.score_d)}</span></div>`).join('')}
    <button class="btn-gold btn-sm" data-goto="#/war">Lihat Perang</button></div>` : ''}
  ${ME.votingLaws.length ? `<div class="panel"><h3>🏛 UU SEDANG DIVOTING</h3>
    ${ME.votingLaws.map((l) => `<div class="kv"><span class="k">${esc(l.title)}</span><span class="v">${l.yes} Ya / ${l.abstain} / ${l.no} Tidak</span></div>`).join('')}
    <button class="btn-gold btn-sm" data-goto="#/parliament">Buka Parlemen</button></div>` : ''}
  <div class="panel">
    <div class="profile-hero">
      <a class="profile-hero-name" data-goto="#/profile" title="Lihat profilmu">${esc(c.username)}</a>
      <div class="profile-hero-sub">
        <span><span class="dot-red">■</span> ${esc(ME.region?.country_name || ME.country?.name || 'Wilayah Merdeka')}</span>
        <span><span class="muted">📍</span> ${esc(ME.region?.name || '')}</span>
      </div>
    </div>
    <div class="kv"><span class="k">Partai</span><span class="v">${ME.party ? esc(ME.party.name) + ' [' + esc(ME.party.tag) + ']' : 'Belum berpartai'}</span></div>
    <div class="kv"><span class="k">Pekerjaan</span><span class="v">${ME.job ? esc(ME.job.title) : 'Belum bekerja'}</span></div>
    <div class="stat-block">
      <div class="stat-head"><span class="lbl">📈 LEVEL</span><span><span class="muted">${c.xp} / ${ME.xpNext} XP</span> <span class="big-num gold">${c.level}</span></span></div>
      <div class="bar gold thick"><i style="width:${Math.min(100, c.xp / ME.xpNext * 100)}%"></i></div>
    </div>
    <button class="stat-block stat-block-btn" type="button" data-popover="energy" aria-label="Lihat rincian regenerasi energi">
      <span class="stat-head"><span class="lbl">⚡ ENERGI</span><span class="big-num">${c.energy}<small>/${cap}</small></span></span>
      <span class="bar thick"><i style="width:${Math.min(100, c.energy / cap * 100)}%"></i></span>
      <span class="teal-text">${c.energy >= cap ? 'Penuh — gunakan untuk bekerja' : 'Makan roti untuk mengisi energi.'}</span>
    </button>
    <button class="stat-block stat-block-btn" type="button" data-popover="fatigue" aria-label="Lihat rincian kelelahan">
      <span class="stat-head"><span class="lbl">🔋 KELELAHAN</span><span class="muted">hari ini ${c.energy_spent_today || 0}</span></span>
      <span class="fatigue-bar"><span class="bar thick"><i style="width:${Math.min(100, fatigue / 15000 * 100)}%"></i></span><span class="fatigue-tick" style="left:66.7%"></span></span>
      <span class="fatigue-marks"><span>10.000 ×0.75</span><span>15.000 ×0.5</span></span>
      <span class="muted">Hasil ×${fatigueMultNow} · mulai 10.000: ×0.75</span>
    </button>
    <div class="stat-block">
      <div class="stat-head"><span class="lbl">🌾 MAKANAN</span><span class="muted">Sisa roti hari ini ${10 - (c.bread_today || 0)}/10</span></div>
      <div class="food-grid" id="dash-food" style="margin-top:10px"><p class="muted small">Memuat…</p></div>
      <p class="muted small" style="margin-top:8px">Ketuk kartu untuk makan. Batas 10 roti per hari.</p>
    </div>
    <div class="stat-block">
      <div class="stat-head"><span class="lbl">👛 DOMPET</span><button class="btn-text gold" type="button" data-goto="#/shop">TOP-UP ›</button></div>
      <div class="kv"><span class="k">Emas</span><span class="v gold-text">◈ ${fmt(c.gold)}</span></div>
      <div class="kv"><span class="k">Rupiah</span><span class="v">${fmtRp(c.usd)}</span></div>
    </div>
  </div>
  <div class="panel">
    <h3>💪 LATIHAN</h3>
    ${[['str', 'strength', 'Kekuatan', c.attr_str, 'Kerusakan perang'], ['edu', 'strategy', 'Pendidikan', c.attr_edu, 'Pelatihan lebih cepat'], ['eco', 'charisma', 'Ekonomi', c.attr_eco, 'Hasil produksi lebih banyak']].map(([k, serverKey, label, lv, desc]) => {
      // Jeda latihan (2 menit × level): tombol nonaktif + hitung mundur
      // selagi atribut ini jeda; atribut lain tetap bisa dilatih.
      const cd = c.trainCooldowns?.[serverKey];
      const cooling = cd && cd.remainingMs > 0;
      return `<div class="kv"><span class="k">${label} · LV ${lv}<br><small class="muted">${desc}</small></span>
      <span class="v"><button class="btn-gold btn-sm" data-train="${k}" ${cooling ? 'disabled' : ''}>${cooling ? `Latih lagi dalam ${fmtCooldown(cd.remainingMs)}` : `LATIH · ${c.trainCosts?.[serverKey] ?? lv + 1} emas`}</button></span></div>`;
    }).join('')}
  </div>
  <div class="panel" id="dash-missions">
    <h3>🎯 MISI HARIAN <span class="muted small">· masing-masing +10 emas</span></h3>
    <p class="muted">Memuat…</p>
  </div>
  ${kronikHidden ? '' : `<div class="panel" id="kronik-card">
    <div class="panel-head"><h3>📖 KRONIKMU</h3></div>
    <p class="muted">Memuat…</p>
  </div>`}
  <div class="panel"><h3>🤝 KOMUNITAS</h3>
    <p class="muted">Ngobrol dengan pemain lain, tanya jawab, dan kabar update game — gabung server Discord Parlementer.</p>
    <a class="btn-gold" href="${DISCORD_URL}" target="_blank" rel="noopener noreferrer">🎮 Gabung Discord Parlementer</a>
  </div>`);
  // Handler kerangka (data ME, langsung aktif): latihan + popover.
  $$('[data-train]').forEach((b) => b.onclick = async () => {
    try { await post('/api/train', { attr: b.dataset.train }); toast('Latihan selesai! Atribut naik 1 level.'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
  // Blok ENERGI / KELELAHAN: ketuk = popover rincian.
  $$('[data-popover]').forEach((b) => b.onclick = () => {
    if (b.dataset.popover === 'energy') showEnergyPopover();
    else showFatiguePopover();
  });
  // Tiga panel API diisi paralel, masing-masing begitu selesai — gagal satu
  // tidak menggagalkan yang lain (allSettled + pesan gagal per panel).
  const eatMeal = async (tier) => {
    try { const r = await post('/api/eat', { tier }); toast(`Energi +${r.gained} (sekarang ${r.energy}/${ME.citizen.energyCap || 100}).`); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  };
  const fillMissions = api('/api/missions').then((m) => {
    const el = $('#dash-missions');
    if (!el) return;
    el.innerHTML = `<h3>🎯 MISI HARIAN <span class="muted small">· masing-masing +10 emas</span></h3>` + m.missions.map((mi) => `
      <div class="kv"><span class="k">${esc(mi.label)}</span>
      <span class="v">${mi.progress}/${mi.target} ${mi.claimed ? '✓ Diklaim' : mi.progress >= mi.target ? `<button class="btn-gold btn-sm" data-mission="${mi.key}">KLAIM +10 🪙</button>` : ''}</span></div>
      <div class="bar" style="margin:4px 0 10px"><i style="width:${Math.min(100, mi.progress / mi.target * 100)}%"></i></div>`).join('');
    $$('#dash-missions [data-mission]').forEach((b) => b.onclick = async () => {
      try { await post('/api/missions/claim', { key: b.dataset.mission }); toast('Hadiah misi diterima: +10 emas.'); await refreshMe(); route(); }
      catch (e) { toast(e.message); }
    });
  }).catch(() => { const el = $('#dash-missions'); if (el) el.innerHTML = `<h3>🎯 MISI HARIAN</h3><p class="muted">Gagal memuat misi. <button class="btn-text gold" type="button" data-reload="1">Muat Ulang</button></p>`; });
  const fillChronicle = kronikHidden ? Promise.resolve() : api('/api/chronicle').then((ch) => {
    const el = $('#kronik-card');
    if (!el) return;
    const ch1 = ch.chapters[0];
    const totalDone = ch.chapters.reduce((s, x) => s + x.done, 0);
    const totalTasks = ch.chapters.reduce((s, x) => s + x.total, 0);
    const firstTodo = ch1.tasks.find((t) => !t.done);
    el.innerHTML = `
    <div class="panel-head"><h3>📖 KRONIKMU</h3><span class="chip">${totalDone}/${totalTasks}</span></div>
    <p class="kronik-sub">Babak I · ${esc(ch1.title)}</p>
    <div class="seg-bar" role="img" aria-label="Progres ${totalDone} dari ${totalTasks} tugas">${Array.from({ length: totalTasks }, (_, i) => `<i class="${i < totalDone ? 'on' : ''}"></i>`).join('')}</div>
    <div class="quote">${esc(CHRONICLE_QUOTES[1])}</div>
    <p class="lbl-gold">TUGASMU</p>
    <h4 class="task-big">${firstTodo ? esc(firstTodo.label) : 'Semua tugas Babak I selesai!'}</h4>
    <p class="muted">${firstTodo ? esc(TASK_HINTS[firstTodo.key] || '') : 'Klaim hadiah babakmu di bawah.'}</p>
    <div class="kronik-actions">
      <button class="btn-text gold" type="button" data-goto="#/chronicle">📖 BACA BABAK INI LAGI</button>
      <button class="btn-text" type="button" id="btn-kronik-hide">LEWATI PELATIHAN (TANPA HADIAH)</button>
    </div>
    ${ch.chapters.map((cc, idx) => `
    <div>
      <button class="chapter-head" type="button" data-chapter="${cc.chapter}" aria-expanded="${idx === 0 ? 'true' : 'false'}">
        <span class="chapter-num">${ROMAN[idx] || cc.chapter}</span><span>${esc(cc.title)}</span>
        <span class="chip">${cc.done}/${cc.total}</span>
        <span class="chev">${idx === 0 ? '▲' : '▼'}</span>
      </button>
      <div class="chapter-body" ${idx === 0 ? '' : 'hidden'}>
        ${cc.tasks.map((t) => `<div class="task-row ${t.done ? 'done' : ''} ${!t.done && cc.chapter === 1 && firstTodo && t.key === firstTodo.key ? 'active' : ''}"><span class="task-dot"></span><span>${esc(t.label)}</span></div>`).join('')}
        ${cc.done === cc.total && !cc.claimed ? `<button class="btn-gold btn-sm" data-chronicle="${cc.chapter}">KLAIM +${cc.reward} EMAS</button>` : cc.claimed ? '<p class="teal-text small">✓ Hadiah sudah diklaim.</p>' : ''}
      </div>
    </div>`).join('')}`;
    $$('#kronik-card [data-chronicle]').forEach((b) => b.onclick = async () => {
      try { await post('/api/chronicle/claim', { chapter: Number(b.dataset.chronicle) }); toast('Hadiah babak diterima!'); await refreshMe(); route(); }
      catch (e) { toast(e.message); }
    });
    // Daftar babak KRONIKMU: ketuk judul babak = buka/tutup daftar tugasnya.
    $$('#kronik-card [data-chapter]').forEach((b) => b.onclick = () => {
      const body = b.nextElementSibling;
      const open = body.hidden;
      body.hidden = !open;
      b.setAttribute('aria-expanded', String(open));
      const chev = b.querySelector('.chev');
      if (chev) chev.textContent = open ? '▲' : '▼';
    });
    // LEWATI hanya menyembunyikan kartu dari Dashboard (preferensi lokal) —
    // tidak ada mekanisme hangus hadiah di server; hadiah babak tetap bisa
    // diklaim di halaman KRONIKMU.
    $('#btn-kronik-hide')?.addEventListener('click', () => {
      try { localStorage.setItem('parlementer_kronik_hide', '1'); } catch { /* abaikan */ }
      toast('Kartu KRONIKMU disembunyikan dari Dashboard — babak dan hadiahnya tetap ada di halaman KRONIKMU.');
      route();
    });
  }).catch(() => { const el = $('#kronik-card'); if (el) el.innerHTML = `<div class="panel-head"><h3>📖 KRONIKMU</h3></div><p class="muted">Gagal memuat kronik. <button class="btn-text gold" type="button" data-reload="1">Muat Ulang</button></p>`; });
  const fillInventory = api('/api/inventory').then((inv) => {
    const el = $('#dash-food');
    if (!el) return;
    const foods = inv.items.filter((i) => i.name === 'Makanan');
    const foodQty = (t) => foods.find((f) => f.tier === t)?.qty || 0;
    el.innerHTML = [1, 2, 3, 4, 5].map((t) => {
      const q = foodQty(t);
      return `<button class="food-card ${q ? '' : 'empty'}" type="button" data-eat="${t}" ${q ? '' : 'disabled'} aria-label="Makan Makanan T${t}, tambah ${t * 10} energi">
      <span class="tier">T${t}</span><span class="val">⚡${t * 10}</span><span class="qty">×${q}</span>${q ? '<span class="eat">MAKAN</span>' : ''}</button>`;
    }).join('');
    // Kartu MAKANAN: ketuk kartu = makan (sama seperti tombol MAKAN di Inventaris).
    $$('#dash-food [data-eat]').forEach((b) => b.onclick = () => eatMeal(Number(b.dataset.eat)));
  }).catch(() => { const el = $('#dash-food'); if (el) el.innerHTML = `<p class="muted">Gagal memuat makanan.</p>`; });
  await Promise.allSettled([fillMissions, fillChronicle, fillInventory]);
};

ROUTES.chronicle = async () => {
  const ch = await api('/api/chronicle');
  $('#page').innerHTML = page('KRONIKMU', 'Ikuti babak demi babak, kumpulkan hadiah emas.', ch.chapters.map((c, idx) => `
    <div class="panel">
      <div class="panel-head"><h3>📖 Babak ${ROMAN[idx] || c.chapter} — ${esc(c.title)}</h3><span class="chip">${c.done}/${c.total} · +${c.reward} emas</span></div>
      <div class="quote">${esc(CHRONICLE_QUOTES[c.chapter] || '')}</div>
      <div class="seg-bar" role="img" aria-label="Progres ${c.done} dari ${c.total} tugas">${Array.from({ length: c.total }, (_, i) => `<i class="${i < c.done ? 'on' : ''}"></i>`).join('')}</div>
      ${c.tasks.map((t) => `<div class="task-row ${t.done ? 'done' : ''}"><span class="task-dot"></span><span>${esc(t.label)}</span></div>`).join('')}
      ${c.done === c.total && !c.claimed ? `<button class="btn-gold" data-chronicle="${c.chapter}">KLAIM +${c.reward} EMAS</button>` : c.claimed ? '<p class="teal-text small">✓ Hadiah sudah diklaim.</p>' : ''}
    </div>`).join(''));
  $$('[data-chronicle]').forEach((b) => b.onclick = async () => {
    try { await post('/api/chronicle/claim', { chapter: Number(b.dataset.chronicle) }); toast('Hadiah babak diterima!'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
};

// ---------- INVENTARIS ----------
ROUTES.inventory = async () => {
  const inv = await api('/api/inventory');
  const foods = inv.items.filter((i) => i.name === 'Makanan');
  const foodQty = (t) => foods.find((f) => f.tier === t)?.qty || 0;
  $('#page').innerHTML = page('INVENTARIS', `${inv.totalQty} unit · ${inv.items.length} jenis barang · nilai pasar ±${fmtRp(inv.marketValue)}`, `
  <div class="panel"><h3>🍞 MAKANAN</h3>
    <p class="muted small">Sisa roti hari ini: ${10 - ME.citizen.bread_today}/10 · Ketuk kartu untuk makan.</p>
    <div class="food-grid" style="margin-top:10px">${[1, 2, 3, 4, 5].map((t) => {
      const q = foodQty(t);
      return `<button class="food-card ${q ? '' : 'empty'}" type="button" data-eat="${t}" ${q ? '' : 'disabled'} aria-label="Makan Makanan T${t}, tambah ${t * 10} energi">
        <span class="tier">T${t}</span><span class="val">⚡${t * 10}</span><span class="qty">×${q}</span>${q ? '<span class="eat">MAKAN</span>' : ''}</button>`;
    }).join('')}</div>
    ${foods.length ? '' : '<p class="muted" style="margin-top:8px">Tidak ada roti. Beli di Pasar.</p>'}
  </div>
  <div class="panel"><h3>📦 SEMUA BARANG</h3>
    ${inv.items.length ? `<table class="table"><tr><th>Barang</th><th>Tingkat</th><th>Jumlah</th><th>Nilai</th></tr>
    ${inv.items.map((i) => `<tr><td>${esc(i.name)}</td><td>T${i.tier}</td><td>×${i.qty}</td><td>${fmtRp(i.qty * i.ref_usd)}</td></tr>`).join('')}</table>`
      : '<p class="muted">Inventaris kosong.</p>'}
  </div>`);
  $$('[data-eat]').forEach((b) => b.onclick = async () => {
    try { const r = await post('/api/eat', { tier: Number(b.dataset.eat) }); toast(`Energi +${r.gained} (sekarang ${r.energy}/${ME.citizen.energyCap || 100}).`); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
};

// ---------- KONVOI ----------
ROUTES.convoy = async () => {
  const cv = await api('/api/convoy');
  $('#page').innerHTML = page('KONVOI', `${cv.used}/${cv.slots} slot terpakai · tiap bangunan berdiri 7 hari lalu roboh`, `
  <div class="panel"><h3>🏗️ BANGUN KONVOI</h3>
    <p class="muted small">Satu bangunan per jenis dalam satu waktu. Biaya 10 emas. Slot tambahan di Level 25 / 50 / 100 dan Premium.</p>
    ${cv.buildings.map((b) => `
      <div class="kv"><span class="k">${esc(b.name)}<br><small class="muted">${esc(b.desc)}</small></span>
      <span class="v">${cv.convoys.some((x) => x.building === b.type) ? '✓ Dibangun' : `<button class="btn-gold btn-sm" data-build="${b.type}">BANGUN · 10 emas</button>`}</span></div>`).join('')}
  </div>
  <div class="panel"><h3>🚚 KONVOIMU</h3>
    ${cv.convoys.length ? cv.convoys.map((x) => {
      const def = cv.buildings.find((b) => b.type === x.building);
      return `<div class="kv"><span class="k">${esc(def?.name || x.building)}<br><small class="muted">Berakhir ${fmtDate(x.expires_at)}</small></span>
      <span class="v"><button class="btn-danger btn-sm" data-demolish="${x.id}">Bongkar</button></span></div>`;
    }).join('') : '<p class="muted">Belum ada bangunan. Konvoi berjalan kosong.</p>'}
  </div>`);
  $$('[data-build]').forEach((b) => b.onclick = async () => {
    try { await post('/api/convoy/build', { building: b.dataset.build }); toast('Bangunan konvoi didirikan.'); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-demolish]').forEach((b) => b.onclick = async () => {
    // Tahap 3: bongkar konvoi itu destruktif (bonus hilang, 10 emas tidak
    // kembali) — minta konfirmasi dulu.
    if (!confirm('Bongkar bangunan konvoi ini? Bonusnya hilang dan 10 emas yang sudah dibayar tidak kembali.')) return;
    try { await post('/api/convoy/demolish', { id: Number(b.dataset.demolish) }); toast('Bangunan dibongkar.'); route(); }
    catch (e) { toast(e.message); }
  });
};

// ---------- PENCAPAIAN ----------
ROUTES.achievements = async () => {
  const a = await api('/api/achievements');
  const cats = [...new Set(a.achievements.map((x) => x.cat))];
  $('#page').innerHTML = page('PENCAPAIAN', `Total hadiah yang masih bisa diraih: ${fmt(a.totalGold)} emas`, cats.map((cat) => `
    <div class="panel"><h3>🏆 ${esc(cat)}</h3>
    ${a.achievements.filter((x) => x.cat === cat).map((x) => `
      <div class="kv"><span class="k">${x.claimed ? '✓' : x.ready ? '★' : '○'} ${esc(x.label)}<br><small class="muted">Hadiah +${x.reward} emas</small></span>
      <span class="v">${x.progress}/${x.target} ${x.ready ? `<button class="btn-gold btn-sm" data-ach="${x.key}">KLAIM</button>` : x.claimed ? 'Diklaim' : ''}</span></div>
      <div class="bar" style="margin:4px 0 10px"><i style="width:${Math.min(100, x.progress / x.target * 100)}%"></i></div>`).join('')}
    </div>`).join(''));
  $$('[data-ach]').forEach((b) => b.onclick = async () => {
    try { const r = await post('/api/achievements/claim', { key: b.dataset.ach }); toast(`Pencapaian diklaim: +${r.reward} emas!`); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
};

// ---------- NOTIFIKASI ----------
ROUTES.notifications = async () => {
  const [n, ann] = await Promise.all([api('/api/notifications'), api('/api/announcements')]);
  $('#page').innerHTML = page('NOTIFIKASI', '', `
  <div class="panel"><h3>📣 APA YANG BARU</h3>
    ${ann.announcements.length ? ann.announcements.map((a) => `
      <div class="${a.read ? '' : 'announce-unread'}" style="margin-bottom:14px">
        <div class="kv"><span class="k"><span class="chip">Update #${a.num}</span> <b>${esc(a.title)}</b><br><small class="muted">${fmtDate(a.created_at)}</small></span>
        <span class="v small">${a.read ? '<span class="muted">Dibaca</span>' : `<button class="btn-gold btn-sm" data-ann-read="${a.id}">Tandai Dibaca</button>`}</span></div>
        <p class="announce-body">${esc(a.body)}</p>
      </div>`).join('')
      : '<p class="muted">Belum ada pengumuman.</p>'}
  </div>
  <div class="panel">
    <div class="panel-head"><h3>🔔 Pusat Notifikasi</h3><button class="btn-ghost btn-sm" id="btn-read-all">Tandai Semua Dibaca</button></div>
    ${n.notifications.length ? n.notifications.map((x) => `
      <div class="kv"><span class="k"><span class="chip">${esc(x.category)}</span> <b>${esc(x.title)}</b><br><small class="muted">${esc(x.content)}</small></span>
      <span class="v small muted" style="white-space:nowrap;flex-shrink:0">${ago(x.created_at)}</span></div>`).join('')
      : '<p class="muted">Belum ada notifikasi.</p>'}
  </div>`);
  $$('[data-ann-read]').forEach((b) => b.onclick = async () => {
    try { await post('/api/announcements/read', { id: Number(b.dataset.annRead) }); route(); }
    catch (e) { toast(e.message); }
  });
  // "Tandai Semua Dibaca" juga menandai semua pengumuman dibaca — lencana
  // 🔔 menghitung keduanya, jadi keduanya harus bisa dibersihkan di sini.
  $('#btn-read-all').onclick = async () => { await post('/api/notifications/read'); await post('/api/announcements/read', { all: true }); await refreshMe(); route(); };
};

// ---------- AKTIVITAS SAYA (Tahap 3, §7) ----------
// Riwayat transaksi pasar + aktivitas/pemberitahuan warga (50 terbaru).
ROUTES.activity = async () => {
  const a = await api('/api/activity');
  // Uang transaksi per baris mengikuti mata uang ruangannya (global = emas,
  // lokal = Rupiah) — nilai API tetap USD, diformat di sini.
  const txMoney = (t, v) => t.scope === 'global' ? fmt(v, 2) + ' emas' : fmtRp(v);
  $('#page').innerHTML = page('AKTIVITAS SAYA', 'Transaksi pasar dan aktivitas terakhirmu (50 terbaru)', `
  <div class="panel"><h3>🛒 TRANSAKSI PASAR</h3>
    ${a.transactions.length ? a.transactions.map((t) => `
      <div class="kv"><span class="k">${t.direction === 'beli' ? '🛍️ BELI' : '💰 JUAL'} ${esc(t.commodity_name)} · T${t.tier} ×${t.qty}<br>
        <small class="muted">${txMoney(t, t.price_each)}/unit · ${esc(t.scope === 'global' ? 'Pasar Global' : 'Pasar Lokal')}</small></span>
      <span class="v" style="flex-shrink:0">${t.direction === 'beli' ? '−' : '+'}${txMoney(t, t.total)}<br><small class="muted" style="white-space:nowrap">${ago(t.created_at)}</small></span></div>`).join('')
      : emptyState('🛒', 'Belum ada transaksi', 'Jual beli di Pasar atau Pasar Global akan tercatat di sini.')}
  </div>
  <div class="panel"><h3>🔔 AKTIVITAS &amp; PEMBERITAHUAN</h3>
    ${a.events.length ? a.events.map((x) => `
      <div class="kv"><span class="k"><span class="chip">${esc(x.category)}</span> <b>${esc(x.title)}</b><br><small class="muted">${esc(x.content)}</small></span>
      <span class="v small muted" style="white-space:nowrap;flex-shrink:0">${ago(x.created_at)}</span></div>`).join('')
      : '<p class="muted">Belum ada aktivitas.</p>'}
  </div>`);
};

// ---------- PROFIL ----------
ROUTES.profile = async (username) => {
  const name = username || ME.citizen.username;
  const p = await api('/api/profile/' + encodeURIComponent(name));
  const pr = p.profile;
  $('#page').innerHTML = page('BERKAS WARGA', '', `
  <div class="profile-hero">
    <div class="profile-hero-name">${esc(pr.username)}${pr.isPremium ? ' ◆' : ''}</div>
    <div class="profile-hero-sub">
      <span><span class="dot-red">■</span> ${esc(pr.country_name || 'Wilayah Merdeka')}</span>
      <span><span class="muted">📍</span> ${esc(pr.region_name)}</span>
    </div>
  </div>
  <div class="panel">
    <div class="panel-head"><h3>👤 IDENTITAS</h3><span class="chip">LEVEL ${pr.level}</span></div>
    <div class="profile-avatar-row">
      <span id="profile-avatar">${avatarHtml(pr.avatar, pr.username, 144)}</span>
      ${pr.user_id === ME.citizen.user_id ? `
      <div>
        <input type="file" id="avatar-file" accept="image/*" hidden>
        <button class="btn-gold btn-sm" id="btn-avatar-change" type="button">📷 Ubah Foto</button>
        ${pr.avatar ? `<button class="btn-ghost btn-sm" id="btn-avatar-delete" type="button">🗑 Hapus Foto</button>` : ''}
        <div id="avatar-preview" style="margin-top:8px"></div>
        <p class="muted small">Foto di-crop persegi &amp; diperkecil jadi 256×256 (maks 500 KB).</p>
      </div>` : ''}
    </div>
    <div class="kv"><span class="k">ID Pemain</span><span class="v"><b>${esc(pr.publicId)}</b></span></div>
    <div class="kv"><span class="k">Kewarganegaraan</span><span class="v">${esc(pr.country_name || 'Wilayah Merdeka')}</span></div>
    <div class="kv"><span class="k">Daerah asal</span><span class="v">${esc(pr.region_name)}</span></div>
    <div class="kv"><span class="k">Partai</span><span class="v">${pr.party ? esc(pr.party.name) + ' [' + esc(pr.party.tag) + ']' : '—'}</span></div>
    <div class="kv"><span class="k">Bergabung</span><span class="v">${fmtDate(pr.created_at)}</span></div>
    ${pr.bio ? `<p style="margin-top:10px">${esc(pr.bio)}</p>` : ''}
  </div>
  ${pr.referral ? `<div class="panel"><h3>🔗 KODE REFERRAL</h3>
    <div class="kv"><span class="k">Kode referralmu</span><span class="v"><b>${esc(pr.referral.code)}</b> <button class="btn-gold btn-sm" id="btn-copy-ref" type="button">Salin</button></span></div>
    <div class="kv"><span class="k">Link ajakan</span><span class="v small">${esc(location.origin + '/?ref=' + pr.referral.code)}</span></div>
    <div class="kv"><span class="k">Orang yang memakai kodemu</span><span class="v">${pr.referral.uses} orang</span></div>
    <div class="kv"><span class="k">Emas dari referral</span><span class="v gold-text">+${fmt(pr.referral.goldEarned)} emas</span></div>
    <p class="muted small">Setiap warga baru yang memakai kodemu memberimu +100 emas + 2 hari Premium — dan dia mendapat +50 emas + 1 hari Premium.</p>
  </div>` : ''}
  <div class="panel"><h3>📊 ATRIBUT</h3>
    <div class="kv"><span class="k">Kekuatan</span><span class="v">${pr.attr_str}</span></div>
    <div class="kv"><span class="k">Pendidikan</span><span class="v">${pr.attr_edu}</span></div>
    <div class="kv"><span class="k">Ekonomi</span><span class="v">${pr.attr_eco}</span></div>
  </div>
  <div class="panel"><h3>⚔️ CATATAN MEDAN PERANG</h3>
    <div class="kv"><span class="k">Total kerusakan</span><span class="v">${fmt(pr.total_damage)}</span></div>
    <div class="kv"><span class="k">Serangan</span><span class="v">${pr.attacks}</span></div>
    <div class="kv"><span class="k">Serangan garis depan</span><span class="v">${pr.frontline_attacks}</span></div>
  </div>
  <div class="panel"><h3>💼 CATATAN KERJA</h3>
    <div class="kv"><span class="k">Shift dikerjakan</span><span class="v">${pr.shifts}</span></div>
    <div class="kv"><span class="k">Total gaji</span><span class="v">${fmtRp(pr.total_salary)}</span></div>
    <div class="kv"><span class="k">Perusahaan dikelola</span><span class="v">${pr.companies.length}</span></div>
  </div>
  ${pr.companies.length ? `<div class="panel"><h3>🏭 PERUSAHAAN</h3>${pr.companies.map((c) => `<div class="kv"><span class="k">${esc(c.name)}</span><span class="v">${esc(c.type)}</span></div>`).join('')}</div>` : ''}
  ${pr.articles.length ? `<div class="panel"><h3>📰 ARTIKEL TERBARU</h3>${pr.articles.map((a) => `<div class="kv"><span class="k">${esc(a.title)}</span><span class="v small muted">${fmtDate(a.created_at)}</span></div>`).join('')}</div>` : ''}
  ${pr.user_id === ME.citizen.user_id ? `<button class="btn-ghost" data-goto="#/settings">✏️ Edit Profil</button>` : ''}`);
  const copyBtn = $('#btn-copy-ref');
  if (copyBtn && pr.referral) {
    copyBtn.onclick = async () => {
      const link = location.origin + '/?ref=' + pr.referral.code;
      try { await navigator.clipboard.writeText(link); toast('Link referral disalin!'); }
      catch {
        const ta = document.createElement('textarea');
        ta.value = link; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); toast('Link referral disalin!'); } catch { toast(link); }
        document.body.removeChild(ta);
      }
    };
  }

  // ---------- FOTO PROFIL (hanya profil sendiri) ----------
  // Penentu "profil sendiri" = ID warga (user_id), BUKAN username — nama
  // tampil selalu huruf besar lewat CSS (.profile-hero-name uppercase),
  // jadi perbandingan nama rawan salah bila nama diketik/dibuka dengan
  // huruf berbeda; ID tidak pernah salah eja dan tidak berubah saat rename.
  if (pr.user_id === ME.citizen.user_id) {
    let pendingAvatar = null;
    let pendingAvatarSm = null;
    const fileInput = $('#avatar-file');
    $('#btn-avatar-change').onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      const processed = await processAvatarFile(f);
      if (!processed) {
        toast('Gambar tidak valid atau terlalu besar (maks 500 KB setelah di-resize).');
        fileInput.value = '';
        return;
      }
      pendingAvatar = processed.avatar;
      pendingAvatarSm = processed.avatarSm;
      $('#avatar-preview').innerHTML = `
        <img src="${esc(pendingAvatar)}" class="avatar-img" style="width:144px;height:144px" alt="Pratinjau foto profil">
        <div class="row" style="margin-top:8px">
          <button class="btn-gold btn-sm" id="btn-avatar-save" type="button">Simpan Foto</button>
          <button class="btn-ghost btn-sm" id="btn-avatar-cancel" type="button">Batal</button>
        </div>`;
      $('#btn-avatar-save').onclick = async () => {
        try { await post('/api/profile/avatar', { avatar: pendingAvatar, avatar_sm: pendingAvatarSm }); toast('Foto profil disimpan.'); await refreshMe(); route(); }
        catch (e) { toast(e.message); }
      };
      $('#btn-avatar-cancel').onclick = () => { pendingAvatar = null; pendingAvatarSm = null; fileInput.value = ''; $('#avatar-preview').innerHTML = ''; };
    };
    const delBtn = $('#btn-avatar-delete');
    if (delBtn) delBtn.onclick = async () => {
      if (!confirm('Hapus foto profil dan kembali ke avatar default?')) return;
      try { await post('/api/profile/avatar/delete'); toast('Foto profil dihapus.'); await refreshMe(); route(); }
      catch (e) { toast(e.message); }
    };
  }
};

// ---------- PENGATURAN ----------
ROUTES.settings = async () => {
  const c = ME.citizen;
  $('#page').innerHTML = page('PENGATURAN', '', `
  <div class="panel"><h3>📝 IDENTITAS</h3>
    <label>BIOGRAFI (maks 1000 karakter)<textarea id="set-bio" rows="3">${esc(c.bio || '')}</textarea></label>
    <button class="btn-gold" id="btn-save-bio">Simpan Biografi</button>
  </div>
  <div class="panel"><h3>✏️ GANTI NAMA WARGA</h3>
    <p class="muted small">Biaya 50 emas. Nama 3–24 karakter (huruf, angka, underscore).</p>
    <div class="row"><input id="set-name" placeholder="Nama baru" style="flex:2"><button class="btn-gold" id="btn-rename">Ganti (50 emas)</button></div>
  </div>
  <div class="panel"><h3>🔊 SUARA</h3>
    <p class="muted small">Suara ketukan halus setiap kali menekan tombol. Preferensi tersimpan di perangkat ini.</p>
    <button class="btn-gold" id="btn-sound-toggle">${soundEnabled() ? '🔊 Suara: NYALA — ketuk untuk mematikan' : '🔇 Suara: MATI — ketuk untuk menyalakan'}</button>
  </div>
  <div class="panel"><h3>👤 AKUN</h3>
    <div class="kv"><span class="k">ID Pemain</span><span class="v"><b>${esc(pubId(ME.user.id))}</b></span></div>
    <div class="kv"><span class="k">Email</span><span class="v">${esc(c.email)}</span></div>
    <div class="kv"><span class="k">Nama warga</span><span class="v">${esc(c.username)}</span></div>
    <div class="kv"><span class="k">Premium</span><span class="v">${c.isPremium ? 'Aktif sampai ' + fmtDate(c.premium_until) : 'Tidak aktif'}</span></div>
    <button class="btn-danger" id="btn-logout" style="margin-top:12px">KELUAR</button>
  </div>`);
  $('#btn-save-bio').onclick = async () => {
    try { await post('/api/profile/bio', { bio: $('#set-bio').value }); toast('Biografi disimpan.'); }
    catch (e) { toast(e.message); }
  };
  $('#btn-sound-toggle').onclick = () => {
    const on = !soundEnabled();
    setSoundEnabled(on);
    $('#btn-sound-toggle').textContent = on ? '🔊 Suara: NYALA — ketuk untuk mematikan' : '🔇 Suara: MATI — ketuk untuk menyalakan';
    if (on) playTap();
    toast(on ? 'Suara ketukan dinyalakan.' : 'Suara ketukan dimatikan.');
  };
  $('#btn-rename').onclick = async () => {
    try { await post('/api/profile/rename', { name: $('#set-name').value.trim() }); toast('Nama berhasil diganti.'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  };
  $('#btn-logout').onclick = logout;
};

// ---------- PANEL ADMIN ----------
ROUTES.admin = async (q) => {
  if (q === 'appeals') return renderAdminAppeals();
  if (q && q.startsWith('appeal-')) return renderAdminAppealDetail(Number(q.slice(7)));
  if (q === 'gift-all') return renderAdminGiftAll();
  if (q === 'announcements') return renderAdminAnnouncements();
  if (q === 'flags') return renderAdminFlags();
  if (q === 'inbox' || (q && q.startsWith('inbox?'))) {
    const params = new URLSearchParams((q.split('?')[1] || ''));
    return renderAdminInbox(params.get('status') || '');
  }
  const query = q ? decodeURIComponent(q) : '';
  const [list, logs, appeals, status] = await Promise.all([
    api('/api/admin/players' + (query ? '?q=' + encodeURIComponent(query) : '')),
    api('/api/admin/actions'),
    api('/api/admin/appeals'),
    api('/api/admin/status'),
  ]);
  const pendingAppeals = appeals.appeals.filter((a) => a.status === 'menunggu').length;
  $('#page').innerHTML = page('🛡️ PANEL ADMIN', 'Hanya akun admin yang bisa melihat halaman ini.', `
  <div class="tabs">
    <button class="tab active">👥 Pemain</button>
    <button class="tab" data-goto="#/admin/appeals">📬 Banding${pendingAppeals ? ` <span class="chip">${pendingAppeals} menunggu</span>` : ''}</button>
    <button class="tab" data-goto="#/admin/gift-all">🎁 Hadiah Massal</button>
    <button class="tab" data-goto="#/admin/inbox">📥 Laporan &amp; Saran</button>
    <button class="tab" data-goto="#/admin/announcements">📣 Pengumuman</button>
    <button class="tab" data-goto="#/admin/flags">🚩 Tanda Pasar</button>
  </div>
  <div class="panel"><h3>🔍 CARI PEMAIN</h3>
    <p class="muted small">Jalan darurat admin (kode bootstrap): <b>${status?.bootstrapActive ? 'AKTIF — registrasi dengan kode yang benar bisa membuat admin' : 'TIDAK AKTIF — tidak ada jalan membuat admin lewat registrasi (aman)'}</b></p>
    <div class="row"><input id="adm-q" placeholder="Nama / email / ID (cth: PL-000001)" value="${esc(query)}" style="flex:2">
    <button class="btn-gold" id="adm-search">Cari</button>
    ${query ? '<button class="btn-ghost" id="adm-reset">Reset</button>' : ''}</div>
    <p class="muted small">${list.players.length} pemain ditemukan.</p>
  </div>
  ${list.players.map((p) => `
  <div class="panel" data-player="${p.id}">
    <div class="panel-head"><h3>${avatarHtml(p.avatar, p.username, 48)} 👤 ${esc(p.username)} ${p.isPremium ? '◆' : ''}</h3>
      <span class="chip">${p.is_banned ? '⛔ BANNED' : p.is_admin ? '🛡️ ADMIN' : 'WARGA'}</span></div>
    <div class="kv"><span class="k">ID Pemain</span><span class="v"><b>${esc(p.publicId)}</b></span></div>
    <div class="kv"><span class="k">Email</span><span class="v">${esc(p.email)}</span></div>
    <div class="kv"><span class="k">Level</span><span class="v">${p.level}</span></div>
    <div class="kv"><span class="k">Emas / Rupiah</span><span class="v">${fmt(p.gold)} emas · ${fmtRp(p.usd)}</span></div>
    <div class="kv"><span class="k">Premium</span><span class="v">${p.isPremium ? 'Aktif sampai ' + fmtDate(p.premium_until) : 'Tidak aktif'}</span></div>
    ${p.is_banned ? `<div class="kv"><span class="k">Alasan ban</span><span class="v">${esc(p.banned_reason || '')}</span></div>` : ''}
    <div class="kv"><span class="k">Bergabung</span><span class="v">${fmtDate(p.created_at)}</span></div>
    <p class="muted small" style="margin-top:10px">🎁 <b>Hadiah tunggal</b> — pilih jenis dulu: <b>Hadiah</b> (gratis) atau <b>Pembelian</b> (top-up WhatsApp yang dipenuhi admin). Notifikasi ke pemain mengikuti pilihan ini.</p>
    <div class="row">
      <label class="small muted" style="flex:1">JENIS PEMBERIAN
        <select class="adm-kind" style="width:100%">
          <option value="hadiah">🎁 Hadiah</option>
          <option value="pembelian">🛒 Pembelian (top-up dipenuhi)</option>
        </select>
      </label>
    </div>
    <div class="row" style="margin-top:10px">
      <select class="adm-premium" style="flex:1"><option value="1">Premium 1 bln</option><option value="3">Premium 3 bln</option><option value="6">Premium 6 bln</option><option value="12">Premium 12 bln</option></select>
      <button class="btn-gold btn-sm" data-act="premium">Beri Premium</button>
    </div>
    <div class="row">
      <input class="adm-gold" type="number" min="1" placeholder="Jumlah emas" style="flex:1">
      <button class="btn-gold btn-sm" data-act="gold">+ Emas</button>
      <input class="adm-usd" type="number" min="1" placeholder="Jumlah (Rp)" style="flex:1">
      <button class="btn-gold btn-sm" data-act="usd">+ Rupiah</button>
    </div>
    <div class="row">
      <select class="adm-item" style="flex:1"><option>Makanan</option><option>Senjata</option><option>Tiket</option><option>Gandum Mentah</option><option>Besi Mentah</option><option>Minyak Mentah</option><option>Kapas Mentah</option><option>Kayu</option><option>Batu Bara</option><option>Tembaga Mentah</option></select>
      <select class="adm-tier"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select>
      <input class="adm-qty" type="number" min="1" value="10" style="width:80px">
      <button class="btn-gold btn-sm" data-act="item">Beri Barang</button>
      <button class="btn-gold btn-sm" data-act="energy">⚡ Isi Energi</button>
    </div>
    <div class="row">
      ${p.is_banned
        ? `<button class="btn-gold btn-sm" data-act="unban">✅ Cabut Ban</button>`
        : `<input class="adm-reason" placeholder="Alasan ban (wajib)" style="flex:2">
           <button class="btn-danger btn-sm" data-act="ban">⛔ Ban</button>`}
    </div>
  </div>`).join('') || emptyState('👥', 'Tidak ada pemain', 'Coba kata kunci lain.')}
  <div class="panel"><h3>📋 LOG ADMIN</h3>
    ${logs.actions.length ? logs.actions.map((a) => `<div class="kv"><span class="k"><b>${esc(a.admin_name)}</b> → ${esc(a.target_name)}<br><small class="muted">${esc(a.action)} · ${esc(a.detail)}</small></span><span class="v small muted">${ago(a.created_at)}</span></div>`).join('')
      : '<p class="muted">Belum ada aksi admin yang tercatat.</p>'}
  </div>`);
  $('#adm-search').onclick = () => { const v = $('#adm-q').value.trim(); location.hash = v ? '#/admin/' + encodeURIComponent(v) : '#/admin'; };
  const resetBtn = $('#adm-reset');
  if (resetBtn) resetBtn.onclick = () => { location.hash = '#/admin'; };
  $$('#page [data-player]').forEach((panel) => {
    const uid = Number(panel.dataset.player);
    const kind = () => panel.querySelector('.adm-kind').value;
    const runAct = async (path, body) => {
      try { await post(path, body); toast('Aksi admin berhasil.'); await refreshMe(); route(); }
      catch (e) { toast(e.message); }
    };
    panel.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = async () => {
        const act = btn.dataset.act;
        if (act === 'premium') return runAct('/api/admin/premium', { user_id: uid, months: Number(panel.querySelector('.adm-premium').value), kind: kind() });
        if (act === 'gold') return runAct('/api/admin/gold', { user_id: uid, amount: Number(panel.querySelector('.adm-gold').value), kind: kind() });
        if (act === 'usd') return runAct('/api/admin/usd', { user_id: uid, amount: rpToUsd(Number(panel.querySelector('.adm-usd').value)), kind: kind() });
        if (act === 'item') return runAct('/api/admin/item', {
          user_id: uid, commodity: panel.querySelector('.adm-item').value,
          tier: Number(panel.querySelector('.adm-tier').value), qty: Number(panel.querySelector('.adm-qty').value), kind: kind(),
        });
        if (act === 'energy') return runAct('/api/admin/energy', { user_id: uid, kind: kind() });
        if (act === 'unban') return runAct('/api/admin/unban', { user_id: uid });
        if (act === 'ban') {
          const reason = panel.querySelector('.adm-reason').value.trim();
          if (!reason) { toast('Alasan ban wajib diisi.'); return; }
          if (!confirm(`Ban pemain ini? Alasan: ${reason}`)) return;
          return runAct('/api/admin/ban', { user_id: uid, reason });
        }
      };
    });
  });
};

// ---------- PANEL ADMIN: TAB BANDING ----------
async function renderAdminAnnouncements() {
  const data = await api('/api/admin/announcements');
  $('#page').innerHTML = page('🛡️ PANEL ADMIN', 'Pengumuman update untuk semua pemain.', `
  <div class="tabs">
    <button class="tab" data-goto="#/admin">👥 Pemain</button>
    <button class="tab active">📣 Pengumuman</button>
    <button class="tab" data-goto="#/admin/flags">🚩 Tanda Pasar</button>
  </div>
  <div class="panel"><h3>📣 BUAT PENGUMUMAN BARU</h3>
    <p class="muted small">Pengumuman tampil di Notifikasi pemain, sebagai modal saat login (bila belum dibaca), dan di arsip Buku Panduan → Riwayat Update. Nomor update terisi otomatis sesuai urutan terbit.</p>
    <label>JUDUL<input id="ann-title" placeholder="cth: Update Pasar & Perbaikan Bug"></label>
    <label>ISI (apa yang di-update + bug apa yang di-fix)<textarea id="ann-body" rows="6" placeholder="Tulis ringkasan update di sini..."></textarea></label>
    <button class="btn-gold" id="btn-ann-create">TERBITKAN PENGUMUMAN</button>
  </div>
  <div class="panel"><h3>📜 PENGUMUMAN TERBIT</h3>
    ${data.announcements.length ? data.announcements.map((a) => `
      <div class="kv"><span class="k"><b>${esc(a.title)}</b><br><small class="muted">${fmtDate(a.created_at)}</small></span>
      <span class="v"><button class="btn-danger btn-sm" data-ann-del="${a.id}">Hapus</button></span></div>
      <p class="announce-body muted small" style="margin-bottom:10px">${esc(a.body)}</p>`).join('')
      : '<p class="muted">Belum ada pengumuman.</p>'}
  </div>`);
  $('#btn-ann-create').onclick = async () => {
    try { await post('/api/admin/announcements', { title: $('#ann-title').value.trim(), body: $('#ann-body').value.trim() }); toast('Pengumuman diterbitkan.'); route(); }
    catch (e) { toast(e.message); }
  };
  $$('[data-ann-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('Hapus pengumuman ini? Pemain tidak lagi melihatnya di Notifikasi/Buku.')) return;
    try { await post(`/api/admin/announcements/${b.dataset.annDel}/delete`); toast('Pengumuman dihapus.'); route(); }
    catch (e) { toast(e.message); }
  });
}

async function renderAdminFlags() {
  const data = await api('/api/admin/market-flags');
  $('#page').innerHTML = page('🛡️ PANEL ADMIN', 'Tanda pasar: heuristik harga di luar batas wajar + pola perdagangan bolak-balik. Hanya log untuk ditinjau — bukan bukti pelanggaran otomatis.', `
  <div class="tabs">
    <button class="tab" data-goto="#/admin">👥 Pemain</button>
    <button class="tab" data-goto="#/admin/announcements">📣 Pengumuman</button>
    <button class="tab active">🚩 Tanda Pasar</button>
  </div>
  <div class="panel"><h3>🚩 TANDA PASAR</h3>
    ${data.flags.length ? data.flags.map((f) => `<div class="kv"><span class="k"><span class="chip">${esc(f.kind)}</span> ${esc(f.detail)}<br><small class="muted">${esc(f.buyer_name || '')}${f.buyer_name && f.seller_name ? ' ↔ ' : ''}${esc(f.seller_name || '')}${f.commodity_name ? ' · ' + esc(f.commodity_name) : ''} · ${ago(f.created_at)}</small></span></div>`).join('')
      : '<p class="muted">Belum ada tanda pasar.</p>'}
  </div>`);
}

async function renderAdminAppeals() {
  const data = await api('/api/admin/appeals');
  const pending = data.appeals.filter((a) => a.status === 'menunggu').length;
  $('#page').innerHTML = page('🛡️ PANEL ADMIN', 'Banding dari pemain yang di-ban.', `
  <div class="tabs">
    <button class="tab" data-goto="#/admin">👥 Pemain</button>
    <button class="tab active">📬 Banding${pending ? ` <span class="chip">${pending} menunggu</span>` : ''}</button>
    <button class="tab" data-goto="#/admin/gift-all">🎁 Hadiah Massal</button>
    <button class="tab" data-goto="#/admin/inbox">📥 Laporan &amp; Saran</button>
  </div>
  ${data.appeals.length ? data.appeals.map((a) => `
  <div class="panel" style="cursor:pointer" data-goto="#/admin/appeal-${a.id}">
    <div class="panel-head"><h3>👤 ${esc(a.username)} · ${esc(a.publicId)}</h3>
      <span class="chip">${a.status === 'menunggu' ? '⏳ MENUNGGU' : a.status === 'diterima' ? '✅ DITERIMA' : '❌ DITOLAK'}</span></div>
    <div class="kv"><span class="k">Alasan ban</span><span class="v">${esc(a.ban_reason || '—')}</span></div>
    <div class="kv"><span class="k">Isi banding</span><span class="v">${esc(a.text.length > 120 ? a.text.slice(0, 120) + '…' : a.text)}</span></div>
    <div class="kv"><span class="k">Pesan</span><span class="v">${a.messages_count} pesan</span></div>
    <div class="kv"><span class="k">Diajukan</span><span class="v">${fmtDate(a.created_at)}</span></div>
  </div>`).join('') : emptyState('📬', 'Belum ada banding', 'Banding dari pemain yang di-ban akan muncul di sini.')}`);
}

async function renderAdminAppealDetail(id) {
  const d = await api('/api/appeals/' + id);
  const a = d.appeal;
  $('#page').innerHTML = page('📬 BANDING #' + a.id, `${esc(a.user.username)} · ${esc(a.user.publicId)} · Alasan ban: ${esc(a.ban_reason || '—')}`, `
  <button class="btn-ghost btn-sm" data-goto="#/admin/appeals">← Semua Banding</button>
  <div class="panel"><h3>ISI BANDING</h3><p>${esc(a.text)}</p>
    <p class="muted small">Diajukan ${fmtDate(a.created_at)} · Status: <b>${a.status === 'menunggu' ? 'MENUNGGU' : a.status === 'diterima' ? 'DITERIMA' : 'DITOLAK'}</b>${a.decided_at ? ' · diputuskan ' + fmtDate(a.decided_at) : ''}</p></div>
  <div class="panel"><h3>💬 PERCAKAPAN</h3>
    ${a.messages.map((m) => `
      <div class="msg"><div class="msg-avatar">${m.sender_role === 'admin' ? '🛡' : esc((a.user.username || '?')[0].toUpperCase())}</div>
      <div class="msg-body"><div class="msg-head"><span class="msg-name">${m.sender_role === 'admin' ? 'Admin' : esc(a.user.username)}</span><span class="msg-time">${fmtTime(m.created_at)}</span></div>
      <div class="msg-bubble">${esc(m.text)}</div></div></div>`).join('')}
    ${a.status === 'menunggu' ? `
    <div class="chat-input"><input id="adm-appeal-reply" placeholder="Tulis balasan untuk pemain..." maxlength="1000" autocomplete="off">
    <button class="btn-gold" id="btn-adm-appeal-reply" type="button">KIRIM</button></div>
    <div class="row" style="margin-top:12px">
      <button class="btn-gold" id="btn-appeal-accept" type="button">✅ Cabut Ban — Terima Banding</button>
      <button class="btn-danger" id="btn-appeal-reject" type="button">❌ Tolak Banding</button>
    </div>` : ''}
  </div>`);
  if (a.status === 'menunggu') {
    const send = async () => {
      const v = $('#adm-appeal-reply').value.trim();
      if (!v) return;
      try { await post('/api/admin/appeals/' + a.id + '/message', { text: v }); toast('Balasan terkirim.'); route(); }
      catch (e) { toast(e.message); }
    };
    $('#btn-adm-appeal-reply').onclick = send;
    $('#adm-appeal-reply').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    $('#btn-appeal-accept').onclick = async () => {
      if (!confirm('Terima banding ini dan cabut ban pemain?')) return;
      try { await post('/api/admin/appeals/' + a.id + '/decide', { decision: 'accept' }); toast('Banding diterima — ban dicabut.'); route(); }
      catch (e) { toast(e.message); }
    };
    $('#btn-appeal-reject').onclick = async () => {
      if (!confirm('Tolak banding ini? Pemain masih bisa mengajukan banding baru.')) return;
      try { await post('/api/admin/appeals/' + a.id + '/decide', { decision: 'reject' }); toast('Banding ditolak.'); route(); }
      catch (e) { toast(e.message); }
    };
  }
}

// ---------- PANEL ADMIN: TAB HADIAH MASSAL ----------
async function renderAdminGiftAll() {
  const [list, appeals] = await Promise.all([api('/api/admin/players'), api('/api/admin/appeals')]);
  const pending = appeals.appeals.filter((a) => a.status === 'menunggu').length;
  const recipients = list.players.filter((p) => !p.is_banned);
  $('#page').innerHTML = page('🛡️ PANEL ADMIN', 'Hadiah untuk semua pemain sekaligus.', `
  <div class="tabs">
    <button class="tab" data-goto="#/admin">👥 Pemain</button>
    <button class="tab" data-goto="#/admin/appeals">📬 Banding${pending ? ` <span class="chip">${pending} menunggu</span>` : ''}</button>
    <button class="tab active">🎁 Hadiah Massal</button>
    <button class="tab" data-goto="#/admin/inbox">📥 Laporan &amp; Saran</button>
  </div>
  <div class="panel"><h3>🎁 HADIAH UNTUK SEMUA PEMAIN</h3>
    <p class="muted small">Hadiah dikirim ke <b>${recipients.length} pemain</b> yang tidak di-ban (dari ${list.players.length} pemain total). Akun yang di-ban tidak menerima apa-apa. Semua penerima mendapat notifikasi "Hadiah dari admin".</p>
    <label>JENIS HADIAH<select id="ga-kind">
      <option value="gold">🪙 Emas</option><option value="usd">💵 Rupiah</option>
      <option value="item">📦 Barang</option><option value="premium">💎 Hari Premium</option>
      <option value="energy">⚡ Isi Energi Penuh</option>
    </select></label>
    <div id="ga-item-row" class="row" hidden>
      <select id="ga-commodity" style="flex:2"><option>Makanan</option><option>Senjata</option><option>Tiket</option><option>Gandum Mentah</option><option>Besi Mentah</option><option>Minyak Mentah</option><option>Kapas Mentah</option><option>Kayu</option><option>Batu Bara</option><option>Tembaga Mentah</option></select>
      <select id="ga-tier"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select>
    </div>
    <div id="ga-amount-wrap"><label id="ga-amount-label">JUMLAH EMAS<input id="ga-amount" type="number" min="1" value="50"></label></div>
    <label>PESAN OPSIONAL (tampil di notifikasi)<input id="ga-message" maxlength="200" placeholder="cth: Terima kasih sudah bermain!"></label>
    <button class="btn-gold" id="btn-gift-all">🎁 KIRIM KE ${recipients.length} PEMAIN</button>
  </div>`);
  const kindSel = $('#ga-kind');
  const syncKind = () => {
    const k = kindSel.value;
    $('#ga-item-row').hidden = k !== 'item';
    $('#ga-amount-wrap').style.display = k === 'energy' ? 'none' : '';
    $('#ga-amount-label').firstChild.textContent = k === 'gold' ? 'JUMLAH EMAS' : k === 'usd' ? 'JUMLAH RUPIAH' : k === 'item' ? 'JUMLAH BARANG' : k === 'premium' ? 'HARI PREMIUM' : 'JUMLAH';
  };
  kindSel.onchange = syncKind;
  syncKind();
  $('#btn-gift-all').onclick = async () => {
    const k = kindSel.value;
    const body = { kind: k, amount: Number($('#ga-amount').value) || 0, message: $('#ga-message').value.trim() };
    if (k === 'item') { body.commodity = $('#ga-commodity').value; body.tier = Number($('#ga-tier').value); }
    const label = k === 'gold' ? `${body.amount} emas` : k === 'usd' ? `${fmtRp(body.amount)}` : k === 'item' ? `${body.amount}× ${body.commodity} T${body.tier}` : k === 'premium' ? `Premium ${body.amount} hari` : 'isi energi penuh';
    if (!confirm(`Kirim hadiah ${label} ke ${recipients.length} pemain?`)) return;
    // Hadiah Rupiah: yang diketik admin adalah Rupiah — konversi ke USD
    // (satuan server) sebelum dikirim; presisi penuh, pulih tepat saat
    // ditampilkan lagi sebagai Rupiah.
    if (k === 'usd') body.amount = rpToUsd(body.amount);
    try {
      const r = await post('/api/admin/gift-all', body);
      toast(`Hadiah massal terkirim ke ${r.recipients} pemain.`);
      route();
    } catch (e) { toast(e.message); }
  };
}

// ---------- PANEL ADMIN: TAB LAPORAN & SARAN (INBOX) ----------
async function renderAdminInbox(statusFilter) {
  const [tickets, reports, appeals] = await Promise.all([
    api('/api/admin/tickets' + (statusFilter ? '?status=' + statusFilter : '')),
    api('/api/admin/reports'),
    api('/api/admin/appeals'),
  ]);
  const pending = appeals.appeals.filter((a) => a.status === 'menunggu').length;
  const statusChip = (s) => s === 'baru' ? '🆕 BARU' : s === 'dibaca' ? '👁 DIBACA' : '✅ SELESAI';
  $('#page').innerHTML = page('🛡️ PANEL ADMIN', 'Saran & laporan bug dari pemain, plus laporan chat.', `
  <div class="tabs">
    <button class="tab" data-goto="#/admin">👥 Pemain</button>
    <button class="tab" data-goto="#/admin/appeals">📬 Banding${pending ? ` <span class="chip">${pending} menunggu</span>` : ''}</button>
    <button class="tab" data-goto="#/admin/gift-all">🎁 Hadiah Massal</button>
    <button class="tab active">📥 Laporan &amp; Saran</button>
  </div>
  <div class="panel"><h3>🎧 TIKET MEJA BANTUAN</h3>
    <div class="tabs">
      ${['', 'baru', 'dibaca', 'selesai'].map((s) => `<button class="tab ${statusFilter === s || (!statusFilter && s === '') ? 'active' : ''}" data-goto="#/admin/inbox${s ? '?status=' + s : ''}">${s === '' ? 'SEMUA' : s.toUpperCase()}</button>`).join('')}
    </div>
    ${tickets.tickets.length ? tickets.tickets.map((t) => `
    <div class="panel" data-ticket="${t.id}">
      <div class="panel-head"><h3>${t.type === 'Laporan bug' ? '🐛' : '💡'} ${esc(t.type)} · ${esc(t.topic)}</h3><span class="chip">${statusChip(t.status)}</span></div>
      <div class="kv"><span class="k">Dari</span><span class="v">${esc(t.username)} · ${esc(t.publicId)} · ${esc(t.email)}</span></div>
      <div class="kv"><span class="k">Tanggal</span><span class="v">${fmtDate(t.created_at)}</span></div>
      <p style="margin-top:8px">${esc(t.details)}</p>
      <div class="row" style="margin-top:10px">
        ${t.status !== 'dibaca' ? `<button class="btn-ghost btn-sm" data-tact="dibaca" type="button">👁 Tandai Dibaca</button>` : ''}
        ${t.status !== 'selesai' ? `<button class="btn-gold btn-sm" data-tact="selesai" type="button">✅ Selesai</button>` : ''}
      </div>
      <div class="chat-input" style="margin-top:10px"><input class="t-reply" placeholder="Tulis balasan untuk pemain..." maxlength="1000" autocomplete="off">
      <button class="btn-gold" data-tact="balas" type="button">KIRIM BALASAN</button></div>
    </div>`).join('') : '<p class="muted">Belum ada tiket.</p>'}
  </div>
  <div class="panel"><h3>🚩 LAPORAN CHAT</h3>
    ${reports.reports.length ? reports.reports.map((r) => `
    <div class="kv" style="align-items:flex-start">
      <span class="k" style="max-width:70%;overflow-wrap:break-word">
        <b>${esc(r.reporter_name)}</b> melaporkan <b>${esc(r.author_name || '—')}</b> · ${esc(r.reason)}<br>
        <span class="small">"${esc(r.message_content || '(pesan tidak ditemukan)')}"</span>
        ${r.details ? `<br><small class="muted">${esc(r.details)}</small>` : ''}
        <br><small class="muted">${fmtDate(r.created_at)}</small>
      </span>
      <span class="v">${r.status === 'open'
        ? `<button class="btn-gold btn-sm" data-report="${r.id}" type="button">👁 Tandai Ditinjau</button>`
        : '<span class="chip">✅ DITINJAU</span>'}</span>
    </div>`).join('') : '<p class="muted">Belum ada laporan chat.</p>'}
  </div>`);
  $$('#page [data-ticket]').forEach((panel) => {
    const tid = Number(panel.dataset.ticket);
    panel.querySelectorAll('[data-tact]').forEach((btn) => {
      btn.onclick = async () => {
        const act = btn.dataset.tact;
        try {
          if (act === 'balas') {
            const text = panel.querySelector('.t-reply').value.trim();
            if (!text) { toast('Tulis balasan dulu.'); return; }
            await post('/api/admin/tickets/' + tid + '/reply', { text });
            toast('Balasan terkirim ke pemain.');
          } else {
            await post('/api/admin/tickets/' + tid + '/status', { status: act });
            toast('Status tiket diubah.');
          }
          route();
        } catch (e) { toast(e.message); }
      };
    });
  });
  $$('[data-report]').forEach((b) => b.onclick = async () => {
    try { await post('/api/admin/reports/' + b.dataset.report + '/review'); toast('Laporan ditandai sudah ditinjau.'); route(); }
    catch (e) { toast(e.message); }
  });
}

// Bilah energi bawah menyembunyikan diri saat pengguna scroll ke bawah,
// supaya harga/tombol yang sedang dibaca tidak tertutup bar; muncul lagi
// saat scroll ke atas atau saat sudah di dekat atas halaman.
let lastScrollY = window.scrollY || 0;
window.addEventListener('scroll', () => {
  const y = window.scrollY || 0;
  const bar = document.getElementById('energy-bar');
  if (bar) bar.classList.toggle('energy-hidden', y > lastScrollY && y > 120);
  lastScrollY = y;
}, { passive: true });

boot();

// ---------- PASAR ----------
// Ikon tiap komoditas (tampilan saja) untuk papan pasar gaya Parlamentum.
const COMMODITY_ICONS = {
  'Makanan': '🍞', 'Senjata': '🔫', 'Tiket': '🎫', 'Kapal': '🚢', 'Drone': '🛸',
  'Gandum Mentah': '🌾', 'Besi Mentah': '🔩', 'Minyak Mentah': '🛢️',
  'Kapas Mentah': '☁️', 'Kayu': '🪵', 'Batu Bara': '🪨', 'Tembaga Mentah': '🔶',
  'Bahan Bangunan': '🧱', 'Bahan Bakar': '⛽', 'Elektronik': '🔌',
};
const comIcon = (name) => COMMODITY_ICONS[name] || '📦';

function marketPage(scope) {
  return async () => {
    // Stok milik pemain (LIO, PL-000026): /api/inventory dimuat PARALEL
    // dengan pasar (Promise.all) supaya tidak menambah loading berurutan.
    // Bila inventaris gagal dimuat, pasar tetap tampil (stok dianggap 0).
    const [data, inv] = await Promise.all([
      api('/api/market?scope=' + scope),
      api('/api/inventory').catch(() => ({ items: [] })),
    ]);
    // Peta stok milik pemain: per komoditas+tier + total per komoditas
    // (semua tier). Angka 0 tetap ditampilkan — pemain harus tahu bila
    // ia tidak punya barang itu.
    const owned = new Map();
    const ownedTotal = new Map();
    for (const it of inv.items || []) {
      owned.set(it.commodity_id + ':' + it.tier, it.qty);
      ownedTotal.set(it.commodity_id, (ownedTotal.get(it.commodity_id) || 0) + it.qty);
    }
    const own = (cid, tier) => owned.get(cid + ':' + tier) || 0;
    const ownTotal = (cid) => ownedTotal.get(cid) || 0;
    // Mata uang pasar: global = emas, lokal = Rupiah (nilai API tetap USD).
    // money() memformat satu nilai dalam mata uang pasar ini; harga yang
    // diketik pemain (Rp di pasar lokal) dikonversi ke USD sebelum dikirim.
    const money = (v) => scope === 'global' ? fmt(v, 2) + ' emas' : fmtRp(v);
    const curLabel = scope === 'global' ? 'emas' : 'Rp';
    const priceInputUsd = (input) => scope === 'global' ? Number(input.value) : rpToUsd(Number(input.value));
    $('#page').innerHTML = page(scope === 'global' ? 'PASAR GLOBAL' : 'PASAR',
      scope === 'global' ? 'Perdagangan antarnegara dalam EMAS · pajak impor 2%' : 'Pasar lokal — barang diperdagangkan dalam Rupiah', `
    <div class="stat-grid">
      <div class="stat-cell"><div class="stat-label">📋 Penawaran Terbuka</div><div class="stat-num">${fmt(data.stats.offers)}</div><div class="stat-sub">di 15 komoditas</div></div>
      <div class="stat-cell"><div class="stat-label">📈 Transaksi · 24J</div><div class="stat-num">${fmt(data.stats.tx)}</div><div class="stat-sub">${fmt(data.stats.units)} unit berpindah tangan</div></div>
      <div class="stat-cell"><div class="stat-label">💰 Omzet · 24J</div><div class="stat-num gold">${money(data.stats.turnover)}</div><div class="stat-sub">24 jam terakhir</div></div>
      <div class="stat-cell"><div class="stat-label">🏆 Paling Laris</div><div class="stat-num gold" style="font-size:24px">${data.recentTx[0] ? esc(data.recentTx[0].commodity_name) : '—'}</div><div class="stat-sub">transaksi terakhir</div></div>
    </div>
    <div class="tabs">
      <button class="tab ${scope === 'local' ? 'active' : ''}" data-goto="#/market">Pasar Lokal</button>
      <button class="tab ${scope === 'global' ? 'active' : ''}" data-goto="#/global">Pasar Global</button>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>📊 PAPAN PASAR</h3></div>
      <div class="board">
        <div class="board-head"><span>Komoditas</span><span>Harga Terbaik</span><span>Penawaran</span><span></span></div>
        ${data.commodities.map((c) => `<button type="button" class="board-row" data-com="${c.id}">
          <span class="board-com"><span class="com-icon">${comIcon(c.name)}</span><span class="board-name-wrap"><span class="board-name">${esc(c.name)}</span><span class="board-own">Milikmu: ${fmt(ownTotal(c.id))}</span></span></span>
          <span class="board-price">${c.best != null ? fmt(c.best, 2) : '—'}</span>
          <span class="board-count">${c.offers}</span>
          <span class="board-chev">›</span></button>`).join('')}
      </div>
    </div>
    <div class="panel" id="offer-detail"><h3>📋 PENAWARAN</h3><p class="muted">Pilih komoditas di atas untuk melihat penawaran.</p></div>
    <div class="panel"><h3>📈 GRAFIK HARGA — 14 HARI</h3>
      <p class="muted small">Harga rata-rata harian dari transaksi nyata antar pemain.</p>
      <label>KOMODITAS<select id="chart-com">${data.commodities.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <div id="price-chart" style="margin-top:10px"><p class="muted">Memuat grafik…</p></div>
    </div>
    <div class="panel"><h3>🛒 ORDER BELI</h3>
      <p class="muted small">Pembeli memasang harga yang mereka mau. Punya barangnya? Jual langsung ke order mereka — dana pembeli sudah dikunci, jadi kamu pasti dibayar (dikurangi pajak penghasilan sesuai UU yang berlaku ke kas negara).</p>
      ${data.buyOrders.length ? data.buyOrders.map((o) => `<div class="kv"><span class="k">🧑 ${esc(o.buyer)} · ${esc(o.commodity_name)} T${o.tier} · butuh ${o.qty - o.qty_filled}/${o.qty}<br><small class="muted">${money(o.price)}/unit · Milikmu: ${fmt(own(o.commodity_id, o.tier))}</small></span>
        <span class="v"><input type="number" value="${Math.min(o.qty - o.qty_filled, 10)}" min="1" max="${o.qty - o.qty_filled}" style="width:70px" id="qo-${o.id}">
        <button class="btn-gold btn-sm" data-sell-order="${o.id}">JUAL</button></span></div>`).join('')
        : '<p class="muted">Belum ada order beli. Jadilah pembeli pertama!</p>'}
    </div>
    <div class="panel"><h3>📥 PASANG ORDER BELI</h3>
      <label>KOMODITAS<select id="buy-com">${data.commodities.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <div class="row">
        <label>TINGKAT<select id="buy-tier"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select></label>
        <label>JUMLAH (min 10)<input id="buy-qty" type="number" value="10" min="10"></label>
        <label>HARGA / UNIT (${curLabel})<input id="buy-price" type="number" step="0.01" placeholder="cth: ${scope === 'global' ? '9.00' : '164.700'}"></label>
      </div>
      <p class="muted small">Dana sebesar harga × jumlah langsung dikunci dari saldomu (escrow). Bila order dibatalkan, sisa dana kembali utuh.</p>
      <button class="btn-gold" id="btn-buy-order">PASANG ORDER BELI</button>
    </div>
    <div class="panel"><h3>🧾 ORDER BELIKU</h3>
      ${data.myBuyOrders.length ? data.myBuyOrders.map((o) => `<div class="kv"><span class="k">${esc(o.commodity_name)} T${o.tier} · ${o.qty_filled}/${o.qty} terpenuhi · ${money(o.price)}</span>
        <span class="v"><button class="btn-danger btn-sm" data-cancel-order="${o.id}">Batalkan</button></span></div>`).join('')
        : '<p class="muted">Belum ada order beli aktif.</p>'}
    </div>
    <div class="panel"><h3>💰 JUAL BARANG</h3>
      <label>KOMODITAS<select id="sell-com">${data.commodities.map((c) => `<option value="${c.id}">${esc(c.name)} — Milikmu: ${fmt(ownTotal(c.id))}</option>`).join('')}</select></label>
      <div class="row">
        <label>TINGKAT<select id="sell-tier"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select></label>
        <label>JUMLAH (min 10)<input id="sell-qty" type="number" value="10" min="10"></label>
        <label>HARGA / UNIT (${curLabel})<input id="sell-price" type="number" step="0.01" placeholder="cth: ${scope === 'global' ? '10.80' : '197.640'}"></label>
      </div>
      <p class="muted small" id="sell-own"></p>
      <p class="muted small">Pajak penghasilan ${data.taxRate ?? 2}% dipotong saat barang terjual dan masuk kas negara (lihat halaman Negara). Contoh: jual ${money(10)} → diterima ${money(10 * (1 - (data.taxRate ?? 2) / 100))}.</p>
      <button class="btn-gold" id="btn-sell">PAJANG PENAWARAN</button>
    </div>
    <div class="panel"><h3>🧾 PENAWARANKU</h3>
      ${data.mine.length ? data.mine.map((o) => `<div class="kv"><span class="k">${esc(o.commodity_name)} T${o.tier} ×${o.qty} · ${money(o.price)}</span>
        <span class="v"><button class="btn-danger btn-sm" data-cancel="${o.id}">Batalkan</button></span></div>`).join('')
        : '<p class="muted">Belum ada penawaran aktif.</p>'}
    </div>
    <div class="panel"><h3>🕒 TRANSAKSI TERAKHIR</h3>
      ${data.recentTx.length ? data.recentTx.map((t) => `<div class="kv"><span class="k">${esc(t.commodity_name)} T${t.tier} ×${t.qty}</span><span class="v">${money(t.total)} · ${ago(t.created_at)}</span></div>`).join('')
        : '<p class="muted">Belum ada transaksi.</p>'}
    </div>`);
    $$('[data-com]').forEach((b) => b.onclick = async () => {
      $$('.board-row').forEach((r) => r.classList.remove('sel'));
      b.classList.add('sel');
      const cid = Number(b.dataset.com);
      const offers = data.offers.filter((o) => o.commodity_id === cid);
      const com = data.commodities.find((c) => c.id === cid);
      // Penawaran sudah diurutkan termurah dulu oleh API — lencana TERBAIK
      // untuk penawaran termurah tiap tingkat. Harga besar = harga per unit
      // YANG DIBAYAR pembeli: pasar global +2% pajak impor (IMPORT_TAX),
      // pasar lokal tanpa pajak impor. Tidak ada klaim perjanjian dagang —
      // pakta dagang di Parlementer hanya memotong pajak penghasilan penjual.
      const IMPORT_TAX = 0.02;
      const seenTier = new Set();
      $('#offer-detail').innerHTML = `<h3>📋 ${esc(com.name)} — PENAWARAN</h3>
        ${offers.length ? `<p class="muted small">100 penawaran termurah tiap barang dan tingkat</p>` : ''}` + (offers.length ? offers.map((o) => {
        const isBest = !seenTier.has(o.tier); seenTier.add(o.tier);
        const unit = scope === 'global' ? o.price * (1 + IMPORT_TAX) : o.price;
        const sellerTag = o.seller_org ? `<span class="org-tag">[${esc(o.seller_org)}]</span> ` : '';
        return `
        <div class="offer-card">
          <div class="offer-top">
            <span class="com-icon">${comIcon(com.name)}</span>
            <div class="offer-mid">
              <div class="offer-title">${esc(com.name)} <span class="tier">T${o.tier}</span> × ${fmt(o.qty)}</div>
              <div class="offer-own">Milikmu: ${fmt(own(com.id, o.tier))}</div>
              ${isBest ? '<span class="badge-best">TERBAIK</span>' : ''}
              <div class="offer-seller"><span class="avatar-initial" style="width:20px;height:20px;font-size:11px">${esc((o.seller[0] || '?').toUpperCase())}</span> ${sellerTag}${esc(o.seller)}</div>
            </div>
            <div class="offer-price">
              <div class="big">${scope === 'global' ? fmt(unit, 2) + ' <small>g</small>' : fmtRp(unit)}</div>
              <div class="detail">${money(o.price)}/unit${scope === 'global' ? ` · +pajak impor 2%<span class="tax">+${money(o.price * IMPORT_TAX)} pajak/unit</span>` : ''}</div>
            </div>
          </div>
          <div class="offer-actions">
            <input type="number" value="1" min="1" max="${o.qty}" id="q-${o.id}" aria-label="Jumlah beli">
            <button class="btn-ghost btn-sm" type="button" data-max="${o.id}">MAKS</button>
            <button class="btn-buy" type="button" data-buy="${o.id}">BELI</button>
          </div>
        </div>`;
      }).join('')
        : '<p class="muted">Belum ada penawaran untuk komoditas ini.</p>');
      $$('[data-max]').forEach((mb) => mb.onclick = () => {
        const input = $('#q-' + mb.dataset.max);
        if (input) input.value = input.max;
      });
      $$('[data-buy]').forEach((bb) => bb.onclick = async () => {
        const qty = Number($('#q-' + bb.dataset.buy)?.value || 1);
        try { const r = await post('/api/market/buy', { offer_id: Number(bb.dataset.buy), qty });
          toast(`Membeli ${qty}× ${com.name} seharga ${r.currency === 'gold' ? fmt(r.total, 2) + ' emas' : fmtRp(r.total)}.`);
          await refreshMe(); route(); }
        catch (e) { toast(e.message); }
      });
    });
    // Grafik harga (Tahap 4): batang harian dari /api/market/prices.
    async function renderPriceChart(commodityId) {
      const el = $('#price-chart');
      const com = data.commodities.find((c) => c.id === commodityId);
      let prices;
      try { prices = await api(`/api/market/prices?scope=${scope}&commodity_id=${commodityId}&days=14`); }
      catch (e) { el.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
      const days = prices.days;
      if (!days.length) {
        el.innerHTML = `<p class="muted">Belum ada transaksi ${esc(com?.name || '')} dalam 14 hari terakhir — grafik muncul setelah ada yang berdagang.</p>`;
        return;
      }
      const max = Math.max(...days.map((d) => d.max));
      const min = Math.min(...days.map((d) => d.min));
      const span = (max - min) || 1;
      const last = days[days.length - 1];
      el.innerHTML = `
        <div class="price-chart">${days.map((d) => {
          const h = Math.max(4, Math.round(((d.avg - min) / span) * 100));
          return `<div class="bar-col" title="${d.date}: rata-rata ${money(d.avg)} · ${d.tx} transaksi"><i style="height:${h}%"></i><span>${d.date.slice(5)}</span></div>`;
        }).join('')}</div>
        <p class="muted small" style="margin-top:8px">Terakhir (${last.date}): rata-rata ${money(last.avg)} · tertinggi ${money(last.max)} · terendah ${money(last.min)} · ${fmt(last.volume)} unit · ${last.tx} transaksi.</p>`;
    }
    const chartDefault = data.recentTx[0]?.commodity_id || data.commodities[0]?.id;
    if (chartDefault) {
      $('#chart-com').value = String(chartDefault);
      $('#chart-com').onchange = () => renderPriceChart(Number($('#chart-com').value));
      renderPriceChart(chartDefault);
    }
    $$('[data-sell-order]').forEach((b) => b.onclick = async () => {
      const qty = Number($('#qo-' + b.dataset.sellOrder)?.value || 1);
      try {
        const r = await post('/api/market/sell-to-order', { order_id: Number(b.dataset.sellOrder), qty });
        toast(`Terjual ${qty} unit (diterima ${r.currency === 'gold' ? fmt(r.sellerReceives, 2) + ' emas' : fmtRp(r.sellerReceives)} setelah pajak).`);
        await refreshMe(); route();
      } catch (e) { toast(e.message); }
    });
    $('#btn-buy-order').onclick = async () => {
      try {
        await post('/api/market/buy-order', { scope, commodity_id: Number($('#buy-com').value), tier: Number($('#buy-tier').value), qty: Number($('#buy-qty').value), price: priceInputUsd($('#buy-price')) });
        toast('Order beli dipasang — dana dikunci.');
        await refreshMe(); route();
      } catch (e) { toast(e.message); }
    };
    $$('[data-cancel-order]').forEach((b) => b.onclick = async () => {
      // Tahap 3: batal itu destruktif (order hilang; dana sisa kembali).
      if (!confirm('Batalkan order beli ini? Sisa dana yang dikunci kembali ke saldomu.')) return;
      try {
        const r = await post('/api/market/buy-order/cancel', { order_id: Number(b.dataset.cancelOrder) });
        toast(`Order dibatalkan, ${r.currency === 'gold' ? fmt(r.refund, 2) + ' emas' : fmtRp(r.refund)} kembali.`);
        route();
      } catch (e) { toast(e.message); }
    });
    // Stok milik pemain untuk komoditas+tier yang dipilih di form jual —
    // diperbarui tiap dropdown berubah (stok per tier bisa berbeda).
    const updateSellOwn = () => {
      const el = $('#sell-own');
      if (el) el.textContent = `Milikmu: ${fmt(own(Number($('#sell-com').value), Number($('#sell-tier').value)))} (T${$('#sell-tier').value}) — bisa dijual bila ≥ 10.`;
    };
    $('#sell-com').onchange = updateSellOwn;
    $('#sell-tier').onchange = updateSellOwn;
    updateSellOwn();
    $('#btn-sell').onclick = async () => {
      try {
        await post('/api/market/sell', { scope, commodity_id: Number($('#sell-com').value), tier: Number($('#sell-tier').value), qty: Number($('#sell-qty').value), price: priceInputUsd($('#sell-price')) });
        toast('Penawaran dipajang di pasar.');
        await refreshMe(); route();
      } catch (e) { toast(e.message); }
    };
    $$('[data-cancel]').forEach((b) => b.onclick = async () => {
      // Tahap 3: membatalkan penawaran itu destruktif (barang keluar dari
      // pasar; penawaran harus dipasang ulang bila berubah pikiran).
      if (!confirm('Batalkan penawaran ini? Barang kembali ke inventaris dan penawaran harus dipasang ulang bila berubah pikiran.')) return;
      try { await post('/api/market/cancel', { offer_id: Number(b.dataset.cancel) }); toast('Penawaran dibatalkan, barang kembali ke inventaris.'); route(); }
      catch (e) { toast(e.message); }
    });
  };
}
ROUTES.market = marketPage('local');
ROUTES.global = marketPage('global');

// ---------- VALAS ----------
ROUTES.fx = async () => {
  const fx = await api('/api/fx');
  const chart = fx.history.length ? fx.history : [];
  const maxP = Math.max(...chart.map((h) => h.price), 25);
  const minP = Math.min(...chart.map((h) => h.price), 19);
  const points = chart.map((h, i) => {
    const x = chart.length === 1 ? 50 : (i / (chart.length - 1)) * 100;
    const y = 100 - ((h.price - minP) / (maxP - minP || 1)) * 100;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  $('#page').innerHTML = page('VALAS — RUPIAH ⇄ EMAS', 'Perdagangkan emas terhadap Rupiah. Valas tidak dipungut pajak.', `
  <div class="stat-grid">
    <div class="stat-cell"><div class="stat-label">⬇️ Jual Terbaik</div><div class="stat-num gold">${fx.bestSell != null ? fmtRp(fx.bestSell) : '—'}</div><div class="stat-sub">${fx.sellCount} penawaran menjual emas</div></div>
    <div class="stat-cell"><div class="stat-label">⬆️ Beli Terbaik</div><div class="stat-num" style="color:var(--teal)">${fx.bestBuy != null ? fmtRp(fx.bestBuy) : '—'}</div><div class="stat-sub">${fx.buyCount} penawaran membeli emas</div></div>
    <div class="stat-cell"><div class="stat-label">⚖️ Selisih</div><div class="stat-num">${fx.spread != null ? fmtRp(fx.spread) : '—'}</div><div class="stat-sub">dari kurs tengah</div></div>
    <div class="stat-cell"><div class="stat-label">💎 Kurs Cetak</div><div class="stat-num">${fmtRp(10)}</div><div class="stat-sub">Patokan: 1 emas = ${fmtRp(10)}</div></div>
  </div>
  <div class="panel"><h3>📈 PENJUALAN EMAS — VWAP</h3>
    ${chart.length ? `<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:140px;background:#0a0f1c;border-radius:8px">
      <polyline points="${points}" fill="none" stroke="#d9a441" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>
      <p class="muted small">Terakhir ${fmtRp(chart[chart.length - 1].price)} /emas · ${chart.length} transaksi tercatat</p>`
      : '<p class="muted">Belum ada perdagangan emas. Grafik muncul setelah ada transaksi.</p>'}
    <p class="muted small" style="margin-top:8px">Harga pasar emas adalah ${fmtRp(10)} — jangan beli emas di atas ${fmtRp(10)}, karena pemerintah mencetak emas resmi dengan harga itu. Perdagangan pemain bersifat sukarela dan berisiko.</p>
  </div>
  <div class="panel"><h3>🏛️ CETAK RUPIAH</h3>
    <p class="muted small">Tukar emasmu menjadi Rupiah dengan kurs resmi 1 emas = ${fmtRp(10)}.</p>
    <div class="row"><input id="mint-gold" type="number" value="1" min="1" placeholder="Jumlah emas"><button class="btn-gold" id="btn-mint">CETAK</button></div>
  </div>
  <div class="panel"><h3>📝 PASANG PENAWARAN EMAS</h3>
    <p class="muted small">Berlaku 72 jam. 1 penawaran terbuka per arah. Dana dikunci sampai penawaran diambil/dibatalkan.</p>
    <div class="row">
      <label>ARAH<select id="fx-dir"><option value="sell">Jual Emas (terima Rupiah)</option><option value="buy">Beli Emas (bayar Rupiah)</option></select></label>
      <label>HARGA / EMAS (Rp)<input id="fx-price" type="number" step="0.01" placeholder="cth: 378.810"></label>
      <label>JUMLAH EMAS<input id="fx-qty" type="number" step="0.01" placeholder="cth: 10"></label>
    </div>
    <button class="btn-gold" id="btn-fx-offer">PASANG PENAWARAN</button>
  </div>
  <div class="panel"><h3>📋 PENAWARAN JUAL EMAS</h3>
    ${fx.sells.length ? fx.sells.map((o) => `<div class="kv"><span class="k">${esc(o.citizen_name)} · ${fmtRp(o.price)} /emas · sisa ${fmt(o.qty_gold - o.qty_filled, 2)} emas</span>
      <span class="v"><input type="number" step="0.01" value="1" min="0.01" style="width:70px" id="fq-${o.id}"><button class="btn-gold btn-sm" data-take="${o.id}">AMBIL</button></span></div>`).join('')
      : '<p class="muted">Tidak ada penawaran jual.</p>'}
  </div>
  <div class="panel"><h3>📋 PENAWARAN BELI EMAS</h3>
    ${fx.buys.length ? fx.buys.map((o) => `<div class="kv"><span class="k">${esc(o.citizen_name)} · ${fmtRp(o.price)} /emas · sisa ${fmt(o.qty_gold - o.qty_filled, 2)} emas</span>
      <span class="v"><input type="number" step="0.01" value="1" min="0.01" style="width:70px" id="fq-${o.id}"><button class="btn-gold btn-sm" data-take="${o.id}">JUAL KE DIA</button></span></div>`).join('')
      : '<p class="muted">Tidak ada penawaran beli.</p>'}
  </div>
  ${fx.mine.length ? `<div class="panel"><h3>🧾 PENAWARANKU</h3>${fx.mine.map((o) => `<div class="kv"><span class="k">${o.direction === 'sell' ? 'Jual' : 'Beli'} · ${fmtRp(o.price)} · ${fmt(o.qty_gold - o.qty_filled, 2)}/${fmt(o.qty_gold, 2)} emas</span>
    <span class="v"><button class="btn-danger btn-sm" data-fx-cancel="${o.id}">Batalkan</button></span></div>`).join('')}</div>` : ''}`);
  $('#btn-mint').onclick = async () => {
    try { const r = await post('/api/fx/mint', { gold: Number($('#mint-gold').value) }); toast(`Dicetak ${fmtRp(r.usd)}.`); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  };
  $('#btn-fx-offer').onclick = async () => {
    try { await post('/api/fx/offer', { direction: $('#fx-dir').value, price: rpToUsd(Number($('#fx-price').value)), qty_gold: Number($('#fx-qty').value) }); toast('Penawaran valas dipasang (72 jam).'); route(); }
    catch (e) { toast(e.message); }
  };
  $$('[data-take]').forEach((b) => b.onclick = async () => {
    try { const r = await post('/api/fx/take', { offer_id: Number(b.dataset.take), qty: Number($('#fq-' + b.dataset.take).value) });
      toast(`Transaksi valas selesai: ${fmt(r.gold, 2)} emas / ${fmtRp(r.usd)}.`); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-fx-cancel]').forEach((b) => b.onclick = async () => {
    // Tahap 3: membatalkan penawaran valas itu destruktif (penawaran harus
    // dipasang ulang bila berubah pikiran).
    if (!confirm('Batalkan penawaran valas ini? Dana dikembalikan dan penawaran harus dipasang ulang bila berubah pikiran.')) return;
    try { await post('/api/fx/cancel', { offer_id: Number(b.dataset.fxCancel) }); toast('Penawaran dibatalkan, dana dikembalikan.'); route(); }
    catch (e) { toast(e.message); }
  });
};

// Label upah lowongan: ADMIN dibayar bahan mentah, perusahaan bayar Rupiah
// (nilai server USD) / bagi hasil.
// Untuk lowongan ADMIN, pakai effectiveQty (jumlah setelah pengali UU upah
// ADMIN yang berlaku) bila ada — sama dengan yang diterima saat shift.
const payLabel = (j) => j.salary_type === 'goods'
  ? `${fmt(j.effectiveQty ?? j.pay_qty)}× ${j.resource} / shift`
  : `${fmtRp(j.salary)} / shift`;

// ---------- PEKERJAAN ----------
ROUTES.jobs = async () => {
  const data = await api('/api/jobs');
  const myJob = ME.job ? (data.jobs.find((j) => j.id === ME.job.id) || ME.job) : null;
  $('#page').innerHTML = page('KANTOR KETENAGAKERJAAN', 'Lowongan resmi ADMIN tersedia sebagai modal awal. Perusahaan warga juga bisa membuka lowongan.', `
  <div class="stat-grid">
    <div class="stat-cell"><div class="stat-label">📋 Lowongan Terbuka</div><div class="stat-num">${fmt(data.jobs.length)}</div><div class="stat-sub">di seluruh negeri</div></div>
    <div class="stat-cell"><div class="stat-label">💺 Kursi Kosong</div><div class="stat-num">${fmt(data.stats.seats || 0)}</div><div class="stat-sub">siap diisi</div></div>
    <div class="stat-cell"><div class="stat-label">💰 Nilai Terbaik</div><div class="stat-num gold">${fmt(data.stats.best || 0)}</div><div class="stat-sub">nilai setara / shift</div></div>
    <div class="stat-cell"><div class="stat-label">🧑‍💼 Posisi Saat Ini</div><div class="stat-num" style="font-size:20px">${myJob ? esc(myJob.title) : 'Belum bekerja'}</div><div class="stat-sub">${myJob ? esc(myJob.company_name || 'ADMIN') : 'Lamar lowongan di bawah'}</div></div>
  </div>
  ${myJob ? `<div class="panel"><h3>💼 PEKERJAANMU</h3>
    <div class="kv"><span class="k">${esc(myJob.title)} · ${esc(myJob.company_name || 'ADMIN')}</span><span class="v">${payLabel(myJob)}</span></div>
    <p class="muted small">Satu giliran memakai 100 energi. ${myJob.salary_type === 'goods' ? 'Lowongan ADMIN dibayar bahan mentah, tanpa pajak.' : myJob.salary_type === 'share' ? 'Dibayar dalam bentuk barang (bagi hasil).' : 'Gaji dipotong pajak penghasilan (tarif sesuai UU yang berlaku).'}</p>
    <div class="row"><button class="btn-gold" id="btn-shift">KERJAKAN SATU GILIRAN (100 ⚡)</button>
    <button class="btn-ghost" id="btn-quit">Berhenti Kerja</button></div></div>` : ''}
  <div class="panel"><h3>📋 PAPAN LOWONGAN</h3>
    ${data.adminPayMult && data.adminPayMult !== 1 ? `<p class="muted small">Upah ADMIN saat ini ${Math.round(data.adminPayMult * 100)}% dari upah dasar (UU yang berlaku).</p>` : ''}
    ${data.jobs.length ? data.jobs.map((j) => `
      <div class="card">
        <h4>${esc(j.title)} ${j.is_admin ? '<span class="chip">ADMIN</span>' : ''}</h4>
        <p class="muted small">${esc(j.company_name || 'Pemerintah')} · ${esc(j.region_name)} · Level ${j.level_min}+ · ${j.workers}/${j.seats} kursi</p>
        <p class="small">${esc(j.description || '')}</p>
        <div class="kv"><span class="k">${j.salary_type === 'goods' ? 'Upah (bahan mentah)' : j.salary_type === 'share' ? 'Bagi hasil' : 'Gaji tetap'}</span><span class="v gold-text">${payLabel(j)}</span></div>
        ${j.salary_type === 'goods' ? `<p class="muted small">Setara ~${fmtRp(j.salary)} / shift · jual bahannya di pasar untuk uang.</p>` : ''}
        <button class="btn-gold btn-sm" data-apply="${j.id}" ${ME.citizen.job_id === j.id ? 'disabled' : ''}>${ME.citizen.job_id === j.id ? '✓ Pekerjaanmu' : 'LAMAR'}</button>
      </div>`).join('') : emptyState('💼', 'Belum ada lowongan', 'Lowongan ADMIN dan perusahaan warga akan muncul di sini.')}
  </div>`);
  $('#btn-shift')?.addEventListener('click', async () => {
    try { const r = await post('/api/jobs/shift');
      toast(r.goods ? `Shift selesai! ${r.note}` : `Shift selesai! Gaji bersih ${fmtRp(r.net)} (pajak ${fmtRp(r.tax)}).`);
      await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
  $('#btn-quit')?.addEventListener('click', async () => {
    try { await post('/api/jobs/quit'); toast('Kamu berhenti bekerja.'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-apply]').forEach((b) => b.onclick = async () => {
    try { await post('/api/jobs/apply', { job_id: Number(b.dataset.apply) }); toast('Lamaran diterima! Kamu resmi bekerja.'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
};

// ---------- PERUSAHAAN ----------
ROUTES.companies = async () => {
  const data = await api('/api/companies');
  $('#page').innerHTML = page('INDUSTRI', 'Dirikan perusahaan, produksi setiap hari, buka lowongan untuk warga lain.', `
  <div class="panel"><h3>➕ DIRIKAN PERUSAHAAN</h3>
    <div class="grid2">
      ${data.types.map((t) => `
        <div class="card ${''}">
          <h4>${esc(t.name)}</h4>
          <p class="muted small">${esc(t.desc)}</p>
          <p class="price-big gold-text">${fmt(t.cost)} <small style="font-size:14px">emas</small></p>
          <p class="muted small">Di wilayahmu saat ini: ${esc(ME.region?.name || '')}</p>
          <button class="btn-gold btn-sm" data-found="${t.type}">DIRIKAN</button>
        </div>`).join('')}
    </div>
    <div id="found-form"></div>
  </div>
  <div class="panel"><h3>🏭 PERUSAHAANKU</h3>
    ${data.mine.length ? data.mine.map((c) => `
      <div class="card"><h4>${esc(c.name)}</h4>
      <p class="muted small">${esc(c.type)} · ${esc(c.region_name)} · ${c.employees} karyawan${c.resource ? ' · Produksi: ' + esc(c.resource) : ''}</p>
      <div class="row"><input placeholder="Judul lowongan baru" id="job-title-${c.id}"><input placeholder="Gaji (Rp)" type="number" id="job-salary-${c.id}" style="max-width:120px">
      <button class="btn-gold btn-sm" data-newjob="${c.id}">BUKA LOWONGAN</button></div></div>`).join('')
      : '<p class="muted">Kamu belum punya perusahaan.</p>'}
  </div>
  <div class="panel"><h3>🌍 SEMUA PERUSAHAAN</h3>
    ${data.companies.length ? data.companies.map((c) => `
      <div class="kv"><span class="k">${esc(c.name)}<br><small class="muted">${esc(c.owner_name)} · ${esc(c.region_name)} · ${c.employees} karyawan</small></span>
      <span class="v">${esc(c.type)}</span></div>`).join('')
      : '<p class="muted">Belum ada perusahaan. Jadilah yang pertama!</p>'}
  </div>`);
  $$('[data-found]').forEach((b) => b.onclick = () => {
    const t = data.types.find((x) => x.type === b.dataset.found);
    $('#found-form').innerHTML = `
      <div class="card selected" style="margin-top:12px"><h4>${esc(t.name)} — ${fmt(t.cost)} emas</h4>
      <label>NAMA (OPSIONAL)<input id="f-name" placeholder="${esc(t.name)} ${esc(ME.citizen.username)}"></label>
      ${t.type === 'resource' ? `<label>APA YANG DIBUAT<select id="f-resource">${data.resources.map((r) => `<option>${r}</option>`).join('')}</select></label>` : ''}
      <label>TENTANG (OPSIONAL)<input id="f-about" placeholder="Ceritakan perusahaanmu..."></label>
      <button class="btn-gold" id="f-submit">DIRIKAN BARU</button></div>`;
    $('#f-submit').onclick = async () => {
      try {
        await post('/api/companies', { type: t.type, name: $('#f-name').value.trim() || undefined, about: $('#f-about').value.trim(), resource: $('#f-resource')?.value });
        toast('Perusahaan didirikan! Produksi dimulai besok.');
        await refreshMe(); route();
      } catch (e) { toast(e.message); }
    };
  });
  $$('[data-newjob]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.newjob;
    try {
      await post(`/api/companies/${id}/job`, { title: $('#job-title-' + id).value.trim(), salary: rpToUsd(Number($('#job-salary-' + id).value)), salary_type: 'fixed', seats: 4 });
      toast('Lowongan dibuka.');
      route();
    } catch (e) { toast(e.message); }
  });
};

// ---------- PETA & WILAYAH ----------
ROUTES.map = async () => {
  const data = await api('/api/regions');
  $('#page').innerHTML = page('PETA DUNIA', '17 wilayah merdeka. Klik wilayah untuk detail dan bepergian.', `
  <div class="panel"><h3>🔍 CARI WILAYAH</h3>
    <input id="region-search" placeholder="Cari wilayah...">
  </div>
  <div id="region-list">
  ${data.regions.map((r) => `
    <div class="card region-card" data-name="${esc(r.name.toLowerCase())}">
      <div class="panel-head"><h4>${esc(r.name)}</h4><span class="chip">${esc(r.type)} · Skor ${r.city_score}/10</span></div>
      <p class="muted small">${r.population} warga · ${r.companies} perusahaan · Pemberontakan ${r.rebellion}/5${r.resource_bonus ? ' · Bonus: ' + esc(r.resource_bonus) : ''}</p>
      <p class="muted small">${r.country_name ? '🏳️ ' + esc(r.country_name) : '🕊️ Wilayah Merdeka'}</p>
      <div class="row"><button class="btn-gold btn-sm" data-goto="#/regions/${r.id}">Lihat Wilayah</button>
      ${r.id === data.mine ? '<span class="chip teal">📍 KAMU DI SINI</span>' : `<button class="btn-ghost btn-sm" data-travel="${r.id}">Bepergian (1 🎫)</button>`}</div>
    </div>`).join('')}
  </div>`);
  $('#region-search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    $('.region-card').forEach((el) => { el.style.display = el.dataset.name.includes(q) ? '' : 'none'; });
  });
  $$('[data-travel]').forEach((b) => b.onclick = async () => {
    try { const r = await post('/api/regions/travel', { region_id: Number(b.dataset.travel) }); toast(`Kamu sekarang di ${r.region}.`); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
};

ROUTES.regions = async (id) => {
  if (id) {
    const d = await api('/api/regions/' + id);
    const r = d.region;
    $('#page').innerHTML = page(esc(r.name).toUpperCase(), `${esc(r.type)} · ${r.country_name ? esc(r.country_name) : 'Wilayah Merdeka'}`, `
    <div class="stat-grid">
      <div class="stat-cell"><div class="stat-label">🏙️ Skor Kota</div><div class="stat-num">${r.city_score}<span style="font-size:18px;color:var(--muted)">/10</span></div></div>
      <div class="stat-cell"><div class="stat-label">👥 Warga</div><div class="stat-num">${fmt(r.population)}</div></div>
      <div class="stat-cell"><div class="stat-label">🏭 Perusahaan</div><div class="stat-num">${fmt(r.companies)}</div></div>
      <div class="stat-cell"><div class="stat-label">🔥 Pemberontakan</div><div class="stat-num">${r.rebellion}/5</div><div class="stat-sub">${r.resource_bonus ? 'Bonus: ' + esc(r.resource_bonus) : ''}</div></div>
    </div>
    <div class="panel"><h3>🏙️ KOTA</h3>
      <div class="kv"><span class="k">Kesehatan</span><span class="v">${r.health}/10</span></div>
      <div class="kv"><span class="k">Pendidikan</span><span class="v">${r.education}/10</span></div>
      <div class="kv"><span class="k">Militer</span><span class="v">${r.military}/10</span></div>
      <div class="kv"><span class="k">Industri</span><span class="v">${r.industry}/10</span></div>
      <div class="kv"><span class="k">Listrik</span><span class="v">${r.electricity}/10</span></div>
      <div class="kv"><span class="k">Kapasitas wilayah</span><span class="v">${r.capacity}% ${d.home ? '· Ini wilayah asalmu' : ''}</span></div>
    </div>
    <div class="panel"><h3>⚖️ POLITIK</h3>
      <div class="kv"><span class="k">Negara</span><span class="v">${r.country_name ? esc(r.country_name) : 'Wilayah Merdeka'}</span></div>
      <div class="kv"><span class="k">Pajak penghasilan</span><span class="v">${d.taxIncome ?? 0}%${r.country_name ? '' : ' · wilayah merdeka tidak memungut pajak'}</span></div>
      <div class="kv"><span class="k">Pajak produksi</span><span class="v">1%</span></div>
      <div class="kv"><span class="k">Pajak impor / ekspor</span><span class="v">2% / 2%</span></div>
      <div class="kv"><span class="k">Perbatasan</span><span class="v">Terbuka</span></div>
    </div>
    <div class="panel"><h3>✈️ PERJALANAN</h3>
      ${d.mine ? '<p class="muted">Kamu di sini.</p>' : `<button class="btn-gold" id="btn-travel">PINDAH KE SINI (${d.travelTickets || 1} 🎫)</button>`}
    </div>
    <div class="panel"><h3>🔥 PEMBERONTAKAN</h3>
      <p class="muted small">5 warga berbeda harus mendukung untuk menyulut perang pemberontakan di wilayah ini. Dukunganmu hangus (tidak kembali).</p>
      ${d.war ? `<p>⚔️ Perang aktif: <b>${esc(d.war.name)}</b> — ${fmt(d.war.score_a)} vs ${fmt(d.war.score_d)}</p>
        <button class="btn-gold" data-goto="#/war/${d.war.id}">Buka Front Perang</button>`
        : `<p>Dukungan saat ini: <b>${r.rebellion}/5</b></p>
        <button class="btn-gold" id="btn-rebel" ${d.mySupport ? 'disabled' : ''}>${d.mySupport ? '✓ Sudah Mendukung' : 'DUKUNG PEMBERONTAKAN · 50 emas hangus'}</button>`}
    </div>`);
    $('#btn-travel')?.addEventListener('click', async () => {
      try { const res = await post('/api/regions/travel', { region_id: r.id }); toast(`Kamu sekarang di ${res.region}.`); await refreshMe(); route(); }
      catch (e) { toast(e.message); }
    });
    $('#btn-rebel')?.addEventListener('click', async () => {
      try { const res = await post('/api/regions/rebel', { region_id: r.id });
        toast(res.warStarted ? 'PERANG MELETUS! Pemberontakan dimulai!' : `Dukungan tercatat (${res.supporters}/5).`);
        route(); }
      catch (e) { toast(e.message); }
    });
    return;
  }
  return ROUTES.map();
};

// ---------- NEGARA ----------
// Dua keadaan (redesain dunia 27 Nov 2026): bernegara (tampilkan negaraku
// + ideologi/sistem + wewenang presiden) atau wilayah merdeka (daftar semua
// negara + form dirikan negara + usulan unifikasi untuk wilayahku).
ROUTES.country = async () => {
  const d = await api('/api/country');
  const c = d.countryFull;
  const rules = d.formationRules || { minLevel: 10, costGold: 100, joinMinLevel: 5, joinVoteDays: 3, joinMinYes: 3 };
  const ideLabel = (id) => (d.ideologies || []).find((x) => x.id === id) || { id, label: id, desc: '' };
  const sysLabel = (id) => (d.systems || []).find((x) => x.id === id) || { id, label: id, desc: '' };
  const myCountryRow = c ? d.countries.find((x) => x.id === c.id) : null;
  const title = c ? esc(c.name).toUpperCase() : 'BELUM BERNEGARA';
  const sub = c
    ? `${sysLabel(c.system).label} · ${ideLabel(c.ideology).label} · Ibu kota ${esc(c.capital)}`
    : 'Dunia masih terpecah — wilayahmu merdeka. Dirikan negaramu sendiri atau gabung lewat unifikasi.';
  const body = c ? `
  <div class="stat-grid">
    <div class="stat-cell"><div class="stat-label">👥 Warga</div><div class="stat-num">${fmt(myCountryRow?.citizen_count ?? 0)}</div></div>
    <div class="stat-cell"><div class="stat-label">🗺️ Wilayah</div><div class="stat-num">${fmt(d.memberRegions.length)}</div></div>
    <div class="stat-cell"><div class="stat-label">🌍 Negara di Dunia</div><div class="stat-num">${fmt(d.countries.length)}</div></div>
    <div class="stat-cell"><div class="stat-label">💰 Kas Negara</div><div class="stat-num">${fmt(c.treasury)}</div><div class="stat-sub">emas</div></div>
  </div>
  <div class="panel"><h3>🏳️ IDENTITAS NEGARA</h3>
    <div class="kv"><span class="k">Ideologi</span><span class="v">${esc(ideLabel(c.ideology).label)}</span></div>
    <p class="muted small">${esc(ideLabel(c.ideology).desc)}</p>
    <div class="kv"><span class="k">Sistem pemerintahan</span><span class="v">${esc(sysLabel(c.system).label)}</span></div>
    <p class="muted small">${esc(sysLabel(c.system).desc)}</p>
    <div class="kv"><span class="k">Ibu kota</span><span class="v">${esc(c.capital)}</span></div>
    <div class="kv"><span class="k">Didirikan</span><span class="v">${esc(c.founded)}</span></div>
    <div class="kv"><span class="k">Wilayah anggota</span><span class="v">${d.memberRegions.map((r) => esc(r.name)).join(', ') || '—'}</span></div>
  </div>
  <div class="panel"><h3>👑 PEMERINTAHAN</h3>
    <div class="kv"><span class="k">${esc(d.presidentTitle)}</span><span class="v">${esc(d.president)}</span></div>
    <div class="kv"><span class="k">Menteri Ekonomi</span><span class="v">${esc(d.ministers.economy)}</span></div>
    <div class="kv"><span class="k">Menteri Luar Negeri</span><span class="v">${esc(d.ministers.foreign)}</span></div>
    <div class="kv"><span class="k">Menteri Dalam Negeri</span><span class="v">${esc(d.ministers.home)}</span></div>
    <div class="kv"><span class="k">Menteri Pertahanan</span><span class="v">${esc(d.ministers.defense)}</span></div>
    ${d.isPresident ? `
    <h3 style="margin-top:12px">⚖️ WEWENANG PRESIDEN</h3>
    <label>IDEOLOGI NEGARA<select id="country-ideology">
      ${d.ideologies.map((x) => `<option value="${esc(x.id)}" ${x.id === c.ideology ? 'selected' : ''}>${esc(x.label)} — ${esc(x.desc)}</option>`).join('')}
    </select></label>
    <button class="btn-gold btn-sm" id="btn-set-ideology">UBAH IDEOLOGI</button>
    <label style="margin-top:10px">SISTEM PEMERINTAHAN<select id="country-system">
      ${d.systems.map((x) => `<option value="${esc(x.id)}" ${x.id === c.system ? 'selected' : ''}>${esc(x.label)} — ${esc(x.desc)}</option>`).join('')}
    </select></label>
    <button class="btn-gold btn-sm" id="btn-set-system">UBAH SISTEM</button>
    ${c.system === 'diktator' ? `
    <label style="margin-top:10px">PAJAK PENGHASILAN (1–5%)<input id="country-tax" type="number" value="${c.tax_income}" min="1" max="5"></label>
    <button class="btn-gold btn-sm" id="btn-set-tax">UBAH PAJAK</button>
    <p class="muted small">Sebagai Diktator, kamu bisa mengubah pajak langsung tanpa parlemen.</p>` : '<p class="muted small">Pajak diubah lewat UU parlemen (atau pindah ke sistem Diktator untuk mengubah langsung).</p>'}
    <p class="muted small">Ideologi &amp; sistem juga bisa diubah lewat UU yang disahkan parlemen.</p>` : ''}
  </div>
  <div class="panel"><h3>💰 KAS NEGARA</h3>
    <div class="kv"><span class="k">Kas negara</span><span class="v gold-text">${fmt(c.treasury)} emas</span></div>
    <div class="kv"><span class="k">Kas negara (Rupiah)</span><span class="v gold-text">${fmtRp(c.treasury_usd || 0)}</span></div>
    <div class="kv"><span class="k">Pajak penghasilan</span><span class="v">${c.tax_income}%</span></div>
    <div class="kv"><span class="k">Upah lowongan ADMIN</span><span class="v">${Math.round((c.admin_pay_mult || 1) * 100)}% dari upah dasar</span></div>
    <div class="kv"><span class="k">Biaya perjalanan</span><span class="v">${c.travel_tickets || 1} Tiket</span></div>
    <div class="kv"><span class="k">Pajak produksi</span><span class="v">${c.tax_production}%</span></div>
    <div class="kv"><span class="k">Pajak impor / ekspor</span><span class="v">${c.tax_import}% / ${c.tax_export}%</span></div>
    <p class="muted small">Pajak dikelola parlemen. Gaji menteri 113 emas/hari (dicetak permainan). Pajak pasar ${c.tax_income}% masuk ke kas ini.</p>
    ${d.treasuryTx?.length ? `<h3 style="margin-top:12px">📒 ARUS KAS (20 TERAKHIR)</h3>
      ${d.treasuryTx.map((t) => `<div class="kv"><span class="k">${esc(t.note || t.kind)}<br><small class="muted">${ago(t.created_at)}</small></span>
      <span class="v">${t.amount >= 0 ? '+' : ''}${t.currency === 'gold' ? fmt(t.amount, 2) + ' emas' : fmtRp(t.amount)}</span></div>`).join('')}`
      : '<p class="muted small" style="margin-top:8px">Belum ada pemasukan pajak — kas negara masih 0 sampai ada yang berdagang.</p>'}
  </div>
  <div class="panel"><h3>⚖️ WEWENANG MENTERI</h3>
    ${d.activeBudget ? `<div class="kv"><span class="k">Anggaran aktif</span><span class="v">${{ claim: 'Pasokan +2 Emas', train: 'Latihan −10%', war: 'Dana Perang +10%' }[d.activeBudget.kind] || d.activeBudget.kind} · sampai ${fmtDate(d.activeBudget.until)}</span></div>` : '<p class="muted small">Tidak ada anggaran aktif.</p>'}
    ${d.mobilizationUntil > Date.now() ? `<div class="kv"><span class="k">Mobilisasi</span><span class="v">aktif sampai ${fmtDate(d.mobilizationUntil)} · +10% kerusakan perang</span></div>` : ''}
    ${d.myMinisterRole === 'economy' ? `
      <label>JENIS ANGGARAN<select id="budget-kind">
        <option value="claim">Pasokan Harian +2 Emas</option>
        <option value="train">Latihan 10% Lebih Murah</option>
        <option value="war">Dana Perang (+10% Kerusakan)</option>
      </select></label>
      <label>JUMLAH (50–500 EMAS DARI KAS NEGARA)<input id="budget-amount" type="number" value="100" min="50" max="500"></label>
      <p class="muted small">Diisulkan Menteri Ekonomi · voting parlemen 3 hari · efek 7 hari bila lolos.</p>
      <button class="btn-gold" id="btn-budget">USULKAN ANGGARAN</button>` : ''}
    ${d.myMinisterRole === 'defense' ? `
      <p class="muted small">Mobilisasi: 100 emas kas negara · kerusakan perang semua warga +10% selama 24 jam.</p>
      <button class="btn-gold" id="btn-mobilize" ${d.mobilizationUntil > Date.now() ? 'disabled' : ''}>${d.mobilizationUntil > Date.now() ? 'MOBILISASI AKTIF' : 'MOBILISASI PERTAHANAN'}</button>` : ''}
    ${d.myMinisterRole === 'home' ? `
      <p class="muted small">Hari libur: 50 emas kas negara · semua warga +20 energi · sekali per 24 jam.</p>
      <button class="btn-gold" id="btn-holiday">TETAPKAN HARI LIBUR</button>` : ''}
    ${!d.myMinisterRole ? '<p class="muted small">Kamu bukan menteri. Wewenang ini hanya untuk Menteri Ekonomi, Pertahanan, dan Dalam Negeri.</p>' : ''}
  </div>
  ${d.wars.length ? `<div class="panel"><h3>⚔️ PERANG AKTIF</h3>${d.wars.map((w) => `<div class="kv"><span class="k">${esc(w.name)}</span><span class="v">${fmt(w.score_a)} vs ${fmt(w.score_d)}</span></div>`).join('')}</div>` : ''}` : `
  <div class="panel"><h3>🕊️ WILAYAHMU MERDEKA</h3>
    <p>Kamu tinggal di <b>${esc(d.myRegion?.name || '')}</b> — wilayah ini belum bernegara. Kamu bisa mendirikan negara sendiri (wilayahmu jadi ibu kota) atau mengusulkan wilayahmu bergabung dengan negara yang sudah ada.</p>
    <div class="kv"><span class="k">Wilayahmu</span><span class="v">${esc(d.myRegion?.name || '')} · ${esc(d.myRegion?.type || '')}</span></div>
    <div class="kv"><span class="k">Levelmu</span><span class="v">${ME.citizen.level} (butuh Level ${rules.minLevel} untuk mendirikan negara)</span></div>
    <div class="kv"><span class="k">Emasmu</span><span class="v">${fmt(ME.citizen.gold)} (butuh ${rules.costGold} emas)</span></div>
  </div>
  ${d.countries.length ? `<div class="panel"><h3>🏳️ NEGARA-NEGARA YANG ADA</h3>
    ${d.countries.map((n) => `<div class="card"><div class="panel-head"><h4>${esc(n.name)}</h4><span class="chip">${esc(ideLabel(n.ideology).label)} · ${esc(sysLabel(n.system).label)}</span></div>
      <p class="muted small">Ibu kota ${esc(n.capital)} · ${n.region_count} wilayah · ${n.citizen_count} warga · ${esc(n.president_title)}: ${esc(n.president_name || 'Kosong')}</p>
      <button class="btn-gold btn-sm" data-join-country="${n.id}">USULKAN ${esc(d.myRegion?.name || 'WILAYAHMU')} BERGABUNG</button></div>`).join('')}
    <p class="muted small">Unifikasi: usulanmu divoting warga wilayahmu selama ${rules.joinVoteDays} hari. Lolos bila YA &gt; TIDAK dan YA minimal ${rules.joinMinYes} suara.</p>
  </div>` : '<div class="panel"><h3>🏳️ NEGARA-NEGARA YANG ADA</h3><p class="muted">Belum ada negara sama sekali. Jadilah pendiri negara pertama!</p></div>'}
  ${d.openJoins.length ? `<div class="panel"><h3>🗳️ USULAN UNIFIKASI UNTUK WILAYAHMU</h3>
    ${d.openJoins.map((j) => {
      const myVote = d.myJoinVotes[j.id];
      return `<div class="card"><h4>Bergabung dengan ${esc(j.country_name)}</h4>
      <p class="muted small">Berakhir ${fmtDate(j.ends_at)} · Ya ${j.yes} · Tidak ${j.no}</p>
      ${myVote ? `<p class="teal-text small">✓ Kamu memilih: ${myVote === 'yes' ? 'Ya' : 'Tidak'}</p>`
        : `<div class="row"><button class="btn-gold btn-sm" data-jvote="${j.id}|yes">YA</button><button class="btn-danger btn-sm" data-jvote="${j.id}|no">TIDAK</button></div>`}</div>`;
    }).join('')}
  </div>` : ''}
  <div class="panel"><h3>🏴 DIRIKAN NEGARA</h3>
    <p class="muted small">Syarat: Level ${rules.minLevel} + ${rules.costGold} emas. Wilayahmu (${esc(d.myRegion?.name || '')}) jadi ibu kota + wilayah pertama. Pendiri BUKAN otomatis presiden — presiden dipilih lewat pemilu (calon lewat kepala partai). Pemilu presiden pertama 7 hari setelah didirikan; pemilu parlemen paling cepat saat parlemen dibuka (2 Des 2026).</p>
    <label>NAMA NEGARA<input id="country-name" placeholder="cth: Federasi Nusantara"></label>
    <label>IDEOLOGI<select id="country-ideology-new">
      ${d.ideologies.map((x) => `<option value="${esc(x.id)}">${esc(x.label)} — ${esc(x.desc)}</option>`).join('')}
    </select></label>
    <label>SISTEM PEMERINTAHAN<select id="country-system-new">
      ${d.systems.map((x) => `<option value="${esc(x.id)}">${esc(x.label)} — ${esc(x.desc)}</option>`).join('')}
    </select></label>
    <button class="btn-gold" id="btn-found-country">DIRIKAN NEGARA · ${rules.costGold} EMAS</button>
  </div>`;
  // page() mengembalikan <h2> judul + sub + body — judul/sub dihitung di
  // atas supaya kedua keadaan (bernegara / merdeka) memakai pola yang sama.
  $('#page').innerHTML = page(title, sub, body);
  $('#btn-budget')?.addEventListener('click', async () => {
    try { await post('/api/country/budget', { kind: $('#budget-kind').value, amount: Number($('#budget-amount').value) }); toast('Anggaran diusulkan! Voting parlemen 3 hari.'); route(); }
    catch (e) { toast(e.message); }
  });
  $('#btn-mobilize')?.addEventListener('click', async () => {
    if (!confirm('Mobilisasi pertahanan? 100 emas dari kas negara. Kerusakan perang semua warga +10% selama 24 jam.')) return;
    try { await post('/api/country/mobilize', {}); toast('Negara dimobilisasi!'); route(); }
    catch (e) { toast(e.message); }
  });
  $('#btn-holiday')?.addEventListener('click', async () => {
    if (!confirm('Tetapkan hari libur? 50 emas dari kas negara. Semua warga +20 energi.')) return;
    try { await post('/api/country/holiday', {}); toast('Hari libur ditetapkan!'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
  $('#btn-set-ideology')?.addEventListener('click', async () => {
    if (!confirm('Ubah ideologi negara? Efeknya langsung berlaku.')) return;
    try { await post('/api/country/ideology', { ideology: $('#country-ideology').value }); toast('Ideologi negara diubah.'); route(); }
    catch (e) { toast(e.message); }
  });
  $('#btn-set-system')?.addEventListener('click', async () => {
    if (!confirm('Ubah sistem pemerintahan? Cara presiden dipilih bisa berubah.')) return;
    try { await post('/api/country/system', { system: $('#country-system').value }); toast('Sistem pemerintahan diubah.'); route(); }
    catch (e) { toast(e.message); }
  });
  $('#btn-set-tax')?.addEventListener('click', async () => {
    try { await post('/api/country/tax', { tax: Number($('#country-tax').value) }); toast('Pajak diubah.'); route(); }
    catch (e) { toast(e.message); }
  });
  $('#btn-found-country')?.addEventListener('click', async () => {
    if (!confirm(`Dirikan negara baru dengan ibu kota ${d.myRegion?.name || ''}? Biaya ${rules.costGold} emas.`)) return;
    try {
      await post('/api/countries', { name: $('#country-name').value.trim(), ideology: $('#country-ideology-new').value, system: $('#country-system-new').value });
      toast('Negaramu berdiri!'); await refreshMe(); route();
    } catch (e) { toast(e.message); }
  });
  $$('[data-join-country]').forEach((b) => b.onclick = async () => {
    try { await post(`/api/countries/${b.dataset.joinCountry}/join`); toast('Usulan unifikasi dibuat! Voting warga wilayahmu 3 hari.'); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-jvote]').forEach((b) => b.onclick = async () => {
    const [id, vote] = b.dataset.jvote.split('|');
    try { await post(`/api/countries/joins/${id}/vote`, { vote }); toast('Suaramu tercatat.'); route(); }
    catch (e) { toast(e.message); }
  });
};

// ---------- STATISTIK ----------
ROUTES.stats = async () => {
  const [world, regions, press] = await Promise.all([api('/api/world'), api('/api/regions'), api('/api/press/stats')]);
  const fx = await api('/api/fx');
  $('#page').innerHTML = page('STATISTIK', 'Angka nyata dari dunia — tanpa data palsu.', `
  <div class="stat-grid">
    <div class="stat-cell"><div class="stat-label">👥 Populasi Dunia</div><div class="stat-num">${fmt(world.population)}</div><div class="stat-sub">Hari ${world.day}</div></div>
    <div class="stat-cell"><div class="stat-label">🟢 Online Sekarang</div><div class="stat-num">${fmt(world.onlineCount ?? 0)}</div><div class="stat-sub">aktif 5 menit terakhir</div></div>
    <div class="stat-cell"><div class="stat-label">🗺️ Wilayah</div><div class="stat-num">${fmt(world.regions)}</div><div class="stat-sub">${fmt(world.countries)} negara</div></div>
    <div class="stat-cell"><div class="stat-label">📰 Artikel / 7 hari</div><div class="stat-num">${fmt(press.articles7d)}</div><div class="stat-sub">dari ${fmt(press.journalists7d)} jurnalis</div></div>
    <div class="stat-cell"><div class="stat-label">👁️ Dibaca / 7 hari</div><div class="stat-num">${fmt(press.reads7d)}</div><div class="stat-sub">${fmt(press.reactions7d)} reaksi</div></div>
  </div>
  <div class="panel"><h3>📊 WILAYAH TERPADAT</h3>
    ${[...regions.regions].sort((a, b) => b.population - a.population).slice(0, 8).map((r) => `
      <div class="kv"><span class="k">${esc(r.name)}</span><span class="v">${fmt(r.population)} warga · skor ${r.city_score}/10</span></div>`).join('')}
  </div>
  <div class="panel"><h3>💱 VALAS</h3>
    <div class="kv"><span class="k">Kurs cetak</span><span class="v">1 emas = ${fmtRp(10)}</span></div>
    <div class="kv"><span class="k">Jual terbaik</span><span class="v">${fx.bestSell != null ? fmtRp(fx.bestSell) : '—'}</span></div>
    <div class="kv"><span class="k">Beli terbaik</span><span class="v">${fx.bestBuy != null ? fmtRp(fx.bestBuy) : '—'}</span></div>
    <div class="kv"><span class="k">Transaksi 24 jam</span><span class="v">${fmt(fx.stats.tx)} · ${fmt(fx.stats.volume, 2)} emas</span></div>
  </div>`);
};

// ---------- KONTRAK ----------
ROUTES.contracts = async () => {
  const local = await api('/api/market?scope=local');
  const glob = await api('/api/market?scope=global');
  const all = [...local.recentTx.map((t) => ({ ...t, scope: 'Lokal' })), ...glob.recentTx.map((t) => ({ ...t, scope: 'Global' }))]
    .sort((a, b) => b.created_at - a.created_at);
  $('#page').innerHTML = page('KONTRAK', 'Catatan perdagangan yang sudah terjadi — kontrak dagang antar warga.', `
  <div class="panel"><h3>📜 KONTRAK PERDAGANGAN</h3>
    <p class="muted small">Setiap pembelian di pasar tercatat sebagai kontrak dagang. Kontrak baru dibuat otomatis saat ada transaksi.</p>
    ${all.length ? all.map((t) => `<div class="kv"><span class="k">${esc(t.commodity_name)} T${t.tier} ×${t.qty} <span class="chip">${t.scope}</span></span>
      <span class="v">${t.scope === 'Global' ? fmt(t.total, 2) + ' emas' : fmtRp(t.total)} · ${ago(t.created_at)}</span></div>`).join('')
      : emptyState('📜', 'Belum ada kontrak', 'Pasar masih kosong. Jadilah yang pertama berdagang!')}
  </div>`);
};

// ---------- PARTAI ----------
ROUTES.parties = async () => {
  const data = await api('/api/parties');
  $('#page').innerHTML = page('PARTAI-PARTAI', 'Bergabunglah dengan salah satu partai — atau dirikan partaimu sendiri dan bawa ke parlemen.', `
  <div class="panel"><h3>🚩 PARTAIMU</h3>
    ${data.mine ? `
      <div class="kv"><span class="k">${esc(data.mine.name)} [${esc(data.mine.tag)}]</span><span class="v">${esc(data.mine.ideology)} · ${data.mine.seats} kursi</span></div>
      <p class="muted small">Ketua: ${esc(data.mine.leader_name)}</p>
      ${data.pending.length ? `<h3 style="margin-top:12px">📥 LAMARAN MASUK</h3>
        ${data.pending.map((p) => `<div class="kv"><span class="k">${esc(p.username)}</span><span class="v"><button class="btn-gold btn-sm" data-approve="${p.citizen_id}">Setujui</button></span></div>`).join('')}` : ''}
      <button class="btn-ghost btn-sm" data-leave="${data.mine.id}" style="margin-top:10px">Keluar dari Partai</button>`
    : `<div class="empty"><div class="big-ico">🚩</div><h3>BELUM PUNYA PARTAI</h3>
      <p class="muted">Bergabunglah dengan salah satu partai di sini — atau dirikan partaimu sendiri dan bawa ke parlemen.</p></div>
      <div class="row"><span class="chip red">Level 10 — kamu level ${ME.citizen.level}</span><span class="chip teal">50 emas — kamu punya ${fmt(ME.citizen.gold)}</span></div>
      <button class="btn-gold big" id="btn-new-party" style="margin-top:12px">+ DIRIKAN PARTAI</button>
      <div id="party-form"></div>`}
  </div>
  <div class="panel"><h3>🗺️ PETA KEKUATAN</h3>
    ${data.parties.length ? data.parties.map((p) => `
      <div class="card"><div class="panel-head"><h4>${esc(p.name)} [${esc(p.tag)}]</h4><span class="chip">${p.seats} kursi</span></div>
      <p class="muted small">Ketua: ${esc(p.leader_name)} · ${esc(p.ideology)} · ${p.members} anggota · ${p.type === 'open' ? 'Terbuka' : p.type === 'application' ? 'Lewat Lamaran' : 'Tertutup'}</p>
      ${!data.mine ? `<button class="btn-gold btn-sm" data-join="${p.id}">${p.type === 'application' ? 'KIRIM LAMARAN' : 'GABUNG'}</button>` : ''}</div>`).join('')
      : '<p class="muted">Belum ada partai. Jadilah pendiri pertama!</p>'}
  </div>
  <div class="panel"><h3>🏛️ POLITIK NEGARA</h3>
    ${ME.country ? `
    <div class="kv"><span class="k">Negaramu</span><span class="v">${esc(ME.country.name)}</span></div>
    <div class="kv"><span class="k">Sistem</span><span class="v">${esc(ME.country.system)}</span></div>
    <div class="kv"><span class="k">Ideologi</span><span class="v">${esc(ME.country.ideology)}</span></div>
    <div class="kv"><span class="k">Parlemen</span><span class="v">60 kursi</span></div>
    <div class="kv"><span class="k">Pemilu</span><span class="v">Lihat di halaman Pemilu</span></div>`
    : `<p class="muted">Kamu belum bernegara — kursimu di parlemen baru ada setelah wilayahmu bergabung dengan sebuah negara.</p>
    <button class="btn-gold btn-sm" data-goto="#/country">Buka Halaman Negara</button>`}
  </div>`);
  $('#btn-new-party')?.addEventListener('click', () => {
    $('#party-form').innerHTML = `
      <div class="card selected" style="margin-top:12px"><h4>DIRIKAN PARTAI — Level 10 + 50 emas</h4>
      <label>NAMA PARTAI<input id="p-name" placeholder="cth: Partai Adil"></label>
      <label>SINGKATAN (2–6 huruf kapital)<input id="p-tag" placeholder="cth: ADIL"></label>
      <label>IDEOLOGI<select id="p-ideology"><option>Konservatif</option><option>Progresif</option><option>Sosialis</option></select></label>
      <label>JENIS<select id="p-type"><option value="open">Terbuka — gabung langsung</option><option value="application">Lewat Lamaran</option><option value="closed">Tertutup</option></select></label>
      <button class="btn-gold" id="p-submit">DIRIKAN PARTAI</button></div>`;
    $('#p-submit').onclick = async () => {
      try {
        await post('/api/parties', { name: $('#p-name').value.trim(), tag: $('#p-tag').value.trim().toUpperCase(), ideology: $('#p-ideology').value, type: $('#p-type').value });
        toast('Partai didirikan!'); await refreshMe(); route();
      } catch (e) { toast(e.message); }
    };
  });
  $$('[data-join]').forEach((b) => b.onclick = async () => {
    try { const r = await post(`/api/parties/${b.dataset.join}/join`); toast(r.role === 'pending' ? 'Lamaran dikirim. Menunggu persetujuan ketua.' : 'Kamu resmi bergabung dengan partai!'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-approve]').forEach((b) => b.onclick = async () => {
    try { await post(`/api/parties/${data.mine.id}/approve`, { citizen_id: Number(b.dataset.approve) }); toast('Lamaran disetujui.'); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-leave]').forEach((b) => b.onclick = async () => {
    // Tahap 3: keluar partai itu destruktif (kehilangan jabatan/kursi partai
    // bila ada) — minta konfirmasi dulu.
    if (!confirm('Keluar dari partai ini? Kamu kehilangan keanggotaan dan jabatan di partai bila ada.')) return;
    try { await post(`/api/parties/${b.dataset.leave}/leave`); toast('Kamu keluar dari partai.'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
};

// ---------- PARLEMEN ----------
ROUTES.parliament = async () => {
  const d = await api('/api/parliament');
  // Parlemen TERKUNCI sampai dibuka 2 Des 2026 (redesain dunia): tampilkan
  // countdown + penjelasan, bukan daftar UU kosong.
  if (!d.parliamentOpen) {
    $('#page').innerHTML = page('PARLEMEN', 'Parlemen belum dibuka.', `
    <div class="panel"><div class="empty"><div class="big-ico">🏛️</div>
    <h3>PARLEMEN DIBUKA ${fmtCountdown(Number(d.parliamentOpensAt) - Date.now()).toUpperCase()} LAGI</h3>
    <p class="muted">Parlemen dibuka <b>2 Desember 2026</b>. Sampai saat itu, UU, anggaran, dan pemakzulan terkunci — tapi kamu sudah bisa mendirikan negara, membentuk partai, dan bersiap untuk pemilu parlemen pertama.</p>
    <div class="row" style="justify-content:center"><button class="btn-gold" data-goto="#/country">Lihat Negaramu</button><button class="btn-ghost" data-goto="#/parties">Lihat Partai</button></div></div></div>`);
    return;
  }
  const seatColors = ['#3b82f6', '#f59e0b', '#ef4444', '#10b981', '#a855f7', '#ec4899', '#14b8a6', '#eab308'];
  const dots = [];
  for (let i = 0; i < d.totalSeats; i++) {
    dots.push(`<span class="seat-dot" style="background:${i < d.filledSeats ? seatColors[i % seatColors.length] : '#26324a'}"></span>`);
  }
  const LAW_KIND_LABEL = { tax_income: 'Pajak Penghasilan', admin_pay: 'Upah ADMIN', travel: 'Biaya Perjalanan', ideology: 'Ideologi Negara', system: 'Sistem Pemerintahan', general: 'UU Umum' };
  const BUDGET_LABEL = { claim: 'Pasokan Harian +2 Emas', train: 'Latihan 10% Lebih Murah', war: 'Dana Perang (+10% Kerusakan)' };
  const eff = d.effects || { taxIncome: 2, adminPayMult: 1, travelTickets: 1, budgetKind: null, budgetUntil: 0, mobilizationUntil: 0 };
  const countryName = d.country ? esc(d.country.name) : 'Belum bernegara';
  $('#page').innerHTML = page('PARLEMEN', `${countryName} · 60 kursi · Mayoritas 31`, `
  <div class="tabs">
    <button class="tab active">🏛️ Dewan</button>
    <button class="tab" data-goto="#/country">💼 Kabinet</button>
    <button class="tab" data-goto="#/chat/parliament">💬 Ruang Sidang</button>
  </div>
  <div class="stat-grid">
    <div class="stat-cell"><div class="stat-label">🏛️ Negaramu</div><div class="stat-num" style="font-size:20px">${countryName}</div></div>
    <div class="stat-cell"><div class="stat-label">👑 ${d.country ? esc(d.country.system === 'imperial' ? 'Kaisar' : d.country.system === 'diktator' ? 'Diktator' : 'Presiden') : 'Presiden'}</div><div class="stat-num" style="font-size:20px">Lihat Negara</div></div>
    <div class="stat-cell"><div class="stat-label">💺 Kursi Terisi</div><div class="stat-num gold">${d.filledSeats}<span style="font-size:18px;color:var(--muted)">/60</span></div><div class="stat-sub">${d.filledSeats >= 60 ? 'parlemen penuh' : 'kursi kosong menunggu pemilu'}</div></div>
    <div class="stat-cell"><div class="stat-label">🗳️ Pemilu</div><div class="stat-num" style="font-size:20px">Lihat Pemilu</div></div>
  </div>
  <div class="panel"><h3>🏛️ DEWAN <span class="muted small">${d.filledSeats} dari 60 kursi terisi</span></h3>
    <div class="seat-chart">${dots.join('')}</div>
    <p style="text-align:center" class="gold-text">◆ MAYORITAS ${d.majority}</p>
    <p class="muted small" style="text-align:center">${d.isMp ? 'Kamu anggota parlemen — kamu bisa memilih UU.' : 'Partaimu belum punya kursi. Menangkan pemilu parlemen untuk masuk dewan.'}</p>
  </div>
  <div class="panel"><h3>📏 ATURAN YANG BERLAKU SAAT INI</h3>
    <div class="kv"><span class="k">Pajak penghasilan</span><span class="v">${eff.taxIncome}%</span></div>
    <div class="kv"><span class="k">Upah lowongan ADMIN</span><span class="v">${Math.round(eff.adminPayMult * 100)}% dari upah dasar</span></div>
    <div class="kv"><span class="k">Biaya perjalanan</span><span class="v">${eff.travelTickets} Tiket</span></div>
    ${eff.budgetKind ? `<div class="kv"><span class="k">Anggaran aktif</span><span class="v">${BUDGET_LABEL[eff.budgetKind] || eff.budgetKind} · sampai ${fmtDate(eff.budgetUntil)}</span></div>` : '<p class="muted small">Tidak ada anggaran aktif.</p>'}
    ${eff.mobilizationUntil > Date.now() ? `<div class="kv"><span class="k">Mobilisasi</span><span class="v">aktif sampai ${fmtDate(eff.mobilizationUntil)} · +10% kerusakan perang</span></div>` : ''}
    <p class="muted small">Angka-angka ini diubah oleh UU yang disahkan parlemen — bukan angka tetap.</p>
  </div>
  <div class="panel"><h3>📜 USULKAN UNDANG-UNDANG</h3>
    <p class="muted small">Butuh Level 5 · biaya notaris 5 emas (gratis untuk Menteri Ekonomi) · voting 7 hari.</p>
    <label>JUDUL UU<input id="law-title" placeholder="cth: Ambang batas parlemen 3%"></label>
    <label>ISI UU<textarea id="law-content" rows="3" placeholder="Tulis isi undang-undang..."></textarea></label>
    <label>JENIS UU<select id="law-kind">
      <option value="general">UU Umum (tanpa efek angka)</option>
      <option value="tax_income">Ubah Pajak Penghasilan (1–5%)</option>
      <option value="admin_pay">Ubah Upah Lowongan ADMIN (80–120%)</option>
      <option value="travel">Ubah Biaya Perjalanan (1–2 Tiket)</option>
      <option value="ideology">Ubah Ideologi Negara (0–3)</option>
      <option value="system">Ubah Sistem Pemerintahan (0–3)</option>
    </select></label>
    <label id="law-value-wrap" style="display:none">NILAI BARU<input id="law-value" type="number" placeholder="cth: 4"></label>
    <p class="muted small" id="law-hint">UU umum: pernyataan/aturan tanpa mengubah angka game.</p>
    <button class="btn-gold" id="btn-law">USULKAN UU</button>
  </div>
  <div class="panel"><h3>🗳️ UU SEDANG DIVOTING &amp; TERBARU</h3>
    ${d.laws.length ? d.laws.map((l) => {
      const total = l.yes + l.abstain + l.no;
      const myVote = d.myVotes[l.id];
      const valTxt = l.value == null ? '' : l.kind === 'travel' ? ` → ${l.value} Tiket`
        : l.kind === 'ideology' ? ` → ${['Konservatisme', 'Sosialisme', 'Liberalisme', 'Nasionalisme'][Math.round(l.value)] || l.value}`
        : l.kind === 'system' ? ` → ${['Presidensial', 'Parlementer', 'Imperial', 'Diktator'][Math.round(l.value)] || l.value}`
        : ` → ${l.value}%`;
      return `<div class="card"><h4>${esc(l.title)}</h4>
      <p class="muted small">Pengusul: ${esc(l.proposer_name)} · ${esc(l.status)} ${l.status === 'voting' ? '· berakhir ' + fmtDate(l.ends_at) : ''}</p>
      <p class="small">${esc(l.content)}</p>
      <p class="muted small">Jenis: ${LAW_KIND_LABEL[l.kind] || 'UU Umum'}${valTxt}${l.status === 'executed' ? (l.effect_applied ? ' · efek diterapkan ✓' : ' · tanpa efek angka') : ''}</p>
      <div class="kv"><span class="k">Ya ${l.yes} · Abstain ${l.abstain} · Tidak ${l.no}</span><span class="v">${total ? Math.round(l.yes / total * 100) : 0}% Ya</span></div>
      ${l.status === 'voting' ? (myVote ? `<p class="teal-text small">✓ Kamu memilih: ${myVote === 'yes' ? 'Ya' : myVote === 'abstain' ? 'Abstain' : 'Tidak'}</p>`
        : `<div class="row"><button class="btn-gold btn-sm" data-vote="${l.id}|yes">YA</button><button class="btn-ghost btn-sm" data-vote="${l.id}|abstain">ABSTAIN</button><button class="btn-danger btn-sm" data-vote="${l.id}|no">TIDAK</button></div>`) : ''}
      </div>`;
    }).join('') : '<p class="muted">Belum ada undang-undang. Jadilah pengusul pertama!</p>'}
  </div>
  <div class="panel"><h3>💰 ANGGARAN NEGARA</h3>
    <p class="muted small">Diisulkan Menteri Ekonomi · voting parlemen 3 hari · dibayar kas negara · efek 7 hari.</p>
    ${d.budgets?.length ? d.budgets.map((b) => {
      const myVote = d.myBudgetVotes[b.id];
      return `<div class="card"><h4>${BUDGET_LABEL[b.kind] || esc(b.kind)}</h4>
      <p class="muted small">Pengusul: ${esc(b.proposer_name)} · ${b.amount} emas · ${esc(b.status)} ${b.status === 'voting' ? '· berakhir ' + fmtDate(b.ends_at) : ''}</p>
      <div class="kv"><span class="k">Ya ${b.yes} · Tidak ${b.no}</span></div>
      ${b.status === 'voting' ? (myVote ? `<p class="teal-text small">✓ Kamu memilih: ${myVote === 'yes' ? 'Ya' : 'Tidak'}</p>`
        : `<div class="row"><button class="btn-gold btn-sm" data-bvote="${b.id}|yes">YA</button><button class="btn-danger btn-sm" data-bvote="${b.id}|no">TIDAK</button></div>`) : ''}
      </div>`;
    }).join('') : '<p class="muted">Belum ada anggaran yang diusulkan.</p>'}
  </div>
  <div class="panel"><h3>⚖️ PEMAKZULAN PRESIDEN</h3>
    <p class="muted small">Hanya anggota parlemen · voting 3 hari · bila lolos, presiden dicopot sampai pemilu berikutnya.</p>
    ${d.isMp ? `<button class="btn-danger btn-sm" id="btn-impeach">USULKAN PEMAKZULAN</button>` : '<p class="muted small">Kamu bukan anggota parlemen.</p>'}
    ${d.impeachments?.length ? d.impeachments.map((im) => {
      const myVote = d.myImpeachVotes[im.id];
      return `<div class="card" style="margin-top:10px"><h4>Pemakzulan ${esc(im.president_name)}</h4>
      <p class="muted small">Pengusul: ${esc(im.proposer_name)} · ${esc(im.status)} ${im.status === 'voting' ? '· berakhir ' + fmtDate(im.ends_at) : ''}</p>
      <div class="kv"><span class="k">Ya ${im.yes} · Tidak ${im.no}</span></div>
      ${im.status === 'voting' ? (myVote ? `<p class="teal-text small">✓ Kamu memilih: ${myVote === 'yes' ? 'Ya' : 'Tidak'}</p>`
        : `<div class="row"><button class="btn-gold btn-sm" data-ivote="${im.id}|yes">YA</button><button class="btn-danger btn-sm" data-ivote="${im.id}|no">TIDAK</button></div>`) : ''}
      </div>`;
    }).join('') : ''}
  </div>`);
  const lawHints = {
    general: 'UU umum: pernyataan/aturan tanpa mengubah angka game.',
    tax_income: `Tarif pajak penghasilan baru 1–5% (saat ini ${eff.taxIncome}%).`,
    admin_pay: `Upah lowongan ADMIN baru 80–120% dari upah dasar (saat ini ${Math.round(eff.adminPayMult * 100)}%).`,
    travel: `Tiket per perjalanan: 1 atau 2 (saat ini ${eff.travelTickets}).`,
    ideology: 'Ideologi baru (angka): 0=Konservatisme, 1=Sosialisme, 2=Liberalisme, 3=Nasionalisme.',
    system: 'Sistem baru (angka): 0=Presidensial, 1=Parlementer, 2=Imperial, 3=Diktator.',
  };
  $('#law-kind').onchange = () => {
    const k = $('#law-kind').value;
    $('#law-value-wrap').style.display = k === 'general' ? 'none' : '';
    $('#law-hint').textContent = lawHints[k];
  };
  $('#btn-law').onclick = async () => {
    try {
      const kind = $('#law-kind').value;
      const value = kind === 'general' ? undefined : Number($('#law-value').value);
      await post('/api/parliament/law', { title: $('#law-title').value.trim(), content: $('#law-content').value.trim(), kind, value });
      toast('UU diusulkan! Voting dibuka 7 hari.'); route();
    }
    catch (e) { toast(e.message); }
  };
  $$('[data-vote]').forEach((b) => b.onclick = async () => {
    const [id, vote] = b.dataset.vote.split('|');
    try { await post('/api/parliament/vote', { law_id: Number(id), vote }); toast('Suaramu tercatat.'); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-bvote]').forEach((b) => b.onclick = async () => {
    const [id, vote] = b.dataset.bvote.split('|');
    try { await post(`/api/country/budget/${id}/vote`, { vote }); toast('Suaramu tercatat.'); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-ivote]').forEach((b) => b.onclick = async () => {
    const [id, vote] = b.dataset.ivote.split('|');
    try { await post(`/api/parliament/impeach/${id}/vote`, { vote }); toast('Suaramu tercatat.'); route(); }
    catch (e) { toast(e.message); }
  });
  $('#btn-impeach')?.addEventListener('click', async () => {
    if (!confirm('Usulkan pemakzulan presiden? Voting parlemen dibuka 3 hari. Bila lolos, presiden dicopot.')) return;
    try { await post('/api/parliament/impeach', {}); toast('Pemakzulan diusulkan!'); route(); }
    catch (e) { toast(e.message); }
  });
};

// ---------- PEMILU ----------
ROUTES.elections = async () => {
  const [d, parties] = await Promise.all([api('/api/elections'), api('/api/parties')]);
  const myParty = parties.mine || null;
  const isLeader = !!(myParty && myParty.leader_id === ME.citizen.id);
  const countryName = d.country ? esc(d.country.name) : 'Belum bernegara';
  $('#page').innerHTML = page('PEMILU', 'Warga Level 5 yang sudah 3 hari menjadi warga bisa memilih.', `
  <div class="panel"><h3>🇮🇩 NEGARAMU — ${countryName.toUpperCase()}</h3>
    ${d.country ? `
    <div class="kv"><span class="k">Sistem</span><span class="v"><span class="chip">${esc(d.country.system.toUpperCase())}</span></span></div>
    <div class="kv"><span class="k">Ideologi</span><span class="v">${esc(d.country.ideology)}</span></div>
    ${d.country.system === 'parlementer' ? '<p class="muted small">Di sistem Parlementer, presiden dipilih hanya oleh anggota parlemen.</p>' : ''}
    ${['imperial', 'diktator'].includes(d.country.system) ? '<p class="muted small">Sistem ini tidak punya pemilu presiden otomatis — presiden menjabat sampai dimakzulkan.</p>' : ''}` : '<p class="muted">Kamu belum bernegara — tidak ada pemilu untukmu. Dirikan negara atau gabung lewat unifikasi dulu.</p>'}
    <div class="kv"><span class="k">Warga</span><span class="v">${fmt(ME.population)}</span></div>
    <div class="kv"><span class="k">Hak pilih</span><span class="v ${d.canVote ? 'teal-text' : 'red-text'}">${d.canVote ? 'Kamu bisa memilih ✓' : 'mulai level 5'}</span></div>
    <div class="kv"><span class="k">Parlemen</span><span class="v">60 kursi</span></div>
    <div class="kv"><span class="k">Presiden</span><span class="v">Lihat di halaman Negara</span></div>
  </div>
  ${d.elections.length ? d.elections.map((e) => `
    <div class="panel"><h3>🗳️ PEMILU ${e.type === 'president' ? 'PRESIDEN' : 'PARLEMEN'} — ${esc(e.status.toUpperCase())}</h3>
      <p class="muted small">Dibuka ${fmtDate(e.opens_at)} · Ditutup ${fmtDate(e.closes_at)}${e.winner ? ' · Pemenang: ' + esc(e.winner) : ''}</p>
      ${e.candidates.length ? e.candidates.map((c) => `
        <div class="kv"><span class="k">🧑 ${esc(c.username)} ${c.party_name ? '[' + esc(c.party_tag) + ']' : ''}</span>
        <span class="v">${c.votes} suara ${e.status === 'open' && !e.myVote ? `<button class="btn-gold btn-sm" data-evote="${e.id}|${c.citizen_id}">PILIH</button>` : ''}</span></div>`).join('')
        : '<p class="muted">Belum ada kandidat.</p>'}
      ${e.status === 'open' && e.type === 'president' ? (isLeader ? `
        <label style="margin-top:10px">NOMINASIKAN CALON PRESIDEN (KEPALA PARTAI)<select id="nominate-${e.id}">
          ${(parties.members || []).map((m) => `<option value="${m.citizen_id}">${esc(m.username)}${m.role === 'leader' ? ' (ketua)' : ''}</option>`).join('')}
        </select></label>
        <button class="btn-gold btn-sm" data-nominate="${e.id}">NOMINASIKAN</button>
        <p class="muted small">Calon presiden harus lewat partai — kepala partai yang menominasikan (satu kandidat per partai).</p>`
        : '<p class="muted small">Calon presiden dicalonkan oleh kepala partai — bukan daftar sendiri.</p>') : ''}
      ${e.status === 'open' && e.type === 'parliament' ? (isLeader ? `
        <button class="btn-ghost btn-sm" data-register-party="${e.id}">DAFTARKAN PARTAIKU KE PEMILU PARLEMEN</button>`
        : '<p class="muted small">Partai didaftarkan ke pemilu parlemen oleh ketuanya.</p>') : ''}
      ${e.myVote ? '<p class="teal-text small">✓ Kamu sudah memilih di pemilu ini.</p>' : ''}
    </div>`).join('') : emptyState('🗳️', 'Tidak ada pemilu', 'Pemilu presiden berikutnya dijadwalkan otomatis.')}
  `);
  $$('[data-evote]').forEach((b) => b.onclick = async () => {
    const [eid, cid] = b.dataset.evote.split('|');
    try { await post(`/api/elections/${eid}/vote`, { candidate_id: Number(cid) }); toast('Suaramu tercatat!'); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-nominate]').forEach((b) => b.onclick = async () => {
    const eid = b.dataset.nominate;
    const sel = $('#nominate-' + eid);
    try { await post(`/api/elections/${eid}/nominate`, { citizen_id: Number(sel.value) }); toast('Calon dinominasikan!'); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-register-party]').forEach((b) => b.onclick = async () => {
    try { await post(`/api/elections/${b.dataset.registerParty}/register-party`); toast('Partaimu terdaftar di pemilu parlemen!'); route(); }
    catch (e) { toast(e.message); }
  });
};

// ---------- PERANG ----------
ROUTES.war = async (id) => {
  if (id) {
    const d = await api('/api/wars/' + id);
    const w = d.war;
    const total = w.score_a + w.score_d;
    $('#page').innerHTML = page(esc(w.name).toUpperCase(), `Garis depan: ${esc(w.region_name)} · ${w.status === 'active' ? 'Berlangsung' : 'Berakhir'}`, `
    <div class="stat-grid">
      <div class="stat-cell"><div class="stat-label">🔥 Penyerang</div><div class="stat-num">${fmt(w.score_a)}</div><div class="stat-sub">${total ? Math.round(w.score_a / total * 100) : 0}%</div></div>
      <div class="stat-cell"><div class="stat-label">🛡️ Pembela</div><div class="stat-num">${fmt(w.score_d)}</div><div class="stat-sub">${total ? Math.round(w.score_d / total * 100) : 0}%</div></div>
      <div class="stat-cell"><div class="stat-label">⚔️ Serangan</div><div class="stat-num">${fmt(d.totals.attacks)}</div><div class="stat-sub">total kerusakan ${fmt(d.totals.damage)}</div></div>
      <div class="stat-cell"><div class="stat-label">⏰ Berakhir</div><div class="stat-num" style="font-size:20px">${fmtDate(w.ends_at)}</div><div class="stat-sub">${w.status === 'active' ? 'masih berlangsung' : 'pemenang: ' + esc(w.winner)}</div></div>
    </div>
    <div class="panel"><h3>⚔️ KOMANDO SERANGAN</h3>
      ${w.status !== 'active' ? '<p class="muted">Perang sudah berakhir.</p>'
        : !d.atFront ? `<p class="red-text"><b>TIDAK DI GARIS DEPAN</b> — Kamu harus berada di ${esc(w.region_name)} untuk menyerang.</p>
          <button class="btn-gold" data-goto="#/regions/${w.region_id}">TERBANG KE SANA →</button>`
        : `<p class="muted small">Energi ${ME.citizen.energy}/100 · Senjata di inventaris dipakai sebagai amunisi (1 senjata per serangan).</p>
          ${d.bonuses?.length ? `<p class="muted small">Bonus aktif: ${d.bonuses.map(esc).join(' · ')}</p>` : ''}
          <div class="row">
            <button class="btn-gold" data-attack="attacker|Senjata">SERANG SEBAGAI PENYERANG 🔥</button>
            <button class="btn-ghost" data-attack="defender|Senjata">BELAH SEBAGAI PEMBELA 🛡️</button>
          </div>
          <button class="btn-ghost btn-sm" data-attack="attacker|Drone" style="margin-top:8px">Serang dengan Drone (kerusakan ×1,5)</button>`}
    </div>
    <div class="panel"><h3>🏆 PEJUANG TERATAS</h3>
      ${d.fighters.length ? d.fighters.map((f, i) => `
        <div class="kv"><span class="k">#${i + 1} ${esc(f.username)} ${f.side === 'attacker' ? '🔥' : '🛡️'}</span>
        <span class="v">${fmt(f.damage)} kerusakan · ${f.attacks} serangan</span></div>`).join('')
        : '<p class="muted">Belum ada yang bertempur di front ini.</p>'}
    </div>
    <div class="panel"><h3>📜 UMPAN FRONT</h3>
      ${d.feed.length ? d.feed.map((a) => `<div class="kv"><span class="k">${esc(a.username)} ${a.side === 'attacker' ? '🔥 menyerang' : '🛡️ bertahan'} · ${a.ammo}</span>
        <span class="v">${fmt(a.damage)} dmg · ${ago(a.created_at)}</span></div>`).join('')
        : '<p class="muted">Belum ada serangan.</p>'}
    </div>
    <button class="btn-gold" data-goto="#/chat/war_${w.id}">💬 Buka Obrolan Perang</button>`);
    $$('[data-attack]').forEach((b) => b.onclick = async () => {
      const [side, ammo] = b.dataset.attack.split('|');
      try { const r = await post(`/api/wars/${w.id}/attack`, { side, ammo }); toast(`Seranganmu menimbulkan ${r.damage} kerusakan!${r.bonuses?.length ? ' (' + r.bonuses.join(', ') + ')' : ''}`); await refreshMe(); route(); }
      catch (e) { toast(e.message); }
    });
    return;
  }
  const data = await api('/api/wars');
  const active = data.wars.filter((w) => w.status === 'active');
  const ended = data.wars.filter((w) => w.status !== 'active');
  $('#page').innerHTML = page('PERANG TANAH AIR', 'Front pemberontakan di wilayah-wilayah merdeka.', `
  ${active.length ? active.map((w) => `
    <div class="card"><h4>🔥 ${esc(w.name)}</h4>
    <p class="muted small">${esc(w.region_name)} · ${esc(w.attacker_label)} vs ${esc(w.defender_label)} · berakhir ${fmtDate(w.ends_at)}</p>
    <div class="kv"><span class="k">Skor</span><span class="v">${fmt(w.score_a)} vs ${fmt(w.score_d)}</span></div>
    <button class="btn-gold btn-sm" data-goto="#/war/${w.id}">BUKA FRONT</button></div>`).join('')
    : emptyState('🛡️', 'Tidak ada perang aktif', 'Perang dimulai saat 5 warga mendukung pemberontakan di sebuah wilayah (lihat Peta → wilayah → Dukung Pemberontakan).')}
  ${ended.length ? `<div class="panel"><h3>📜 PERANG BERAKHIR</h3>${ended.map((w) => `<div class="kv"><span class="k">${esc(w.name)}</span><span class="v">${fmt(w.score_a)} vs ${fmt(w.score_d)} · ${esc(w.winner)}</span></div>`).join('')}</div>` : ''}`);
};

ROUTES['war-world'] = async () => {
  const data = await api('/api/wars');
  $('#page').innerHTML = page('PERANG DUNIA', 'Front perang di seluruh dunia.', `
  ${data.wars.length ? data.wars.map((w) => `
    <div class="card"><h4>${w.status === 'active' ? '🔥' : '🏳️'} ${esc(w.name)}</h4>
    <p class="muted small">${esc(w.region_name)} · ${fmt(w.score_a)} vs ${fmt(w.score_d)}</p>
    <button class="btn-gold btn-sm" data-goto="#/war/${w.id}">BUKA FRONT</button></div>`).join('')
    : emptyState('🌍', 'Belum ada perang dunia', 'Dunia masih damai. Pemberontakan dimulai dari wilayah (Peta).')}`);
};

// ---------- PERS ----------
// ---------- GAMBAR ARTIKEL ----------
// Isi artikel dirender AMAN: seluruh isi di-escape dulu (tag HTML/script
// apa pun jadi teks biasa), baru penanda gambar [gambar:<data URL>] yang
// cocok pola ketat (hanya JPEG/PNG/WebP base64) diganti <img>. Penanda
// yang tidak cocok pola — mis. [gambar:javascript:...] atau SVG — tetap
// jadi teks biasa, tidak pernah jadi elemen. Server memvalidasi ulang
// setiap penanda saat artikel diterbitkan, jadi <img> di sini hanya bisa
// berasal dari data URL gambar yang sudah lolos validasi server.
function renderArticleContent(content) {
  const re = /\[gambar:(data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+)\]/g;
  return esc(content).replace(re, (m, url) => `<img src="${esc(url)}" class="article-img" alt="Gambar artikel" loading="lazy">`);
}
// Thumbnail sampul di daftar artikel (cover_sm, maks 50 KB) — kosong bila
// artikel lama tanpa sampul.
const articleThumbHtml = (coverSm) => coverSm
  ? `<img src="${esc(coverSm)}" class="article-thumb" alt="Sampul artikel">`
  : '';

ROUTES.press = async () => {
  const [stats, list] = await Promise.all([api('/api/press/stats'), api('/api/press/articles?sort=new')]);
  const top = list.articles[0];
  $('#page').innerHTML = page('PERS', 'Berita ditulis warga, untuk warga.', `
  <div class="stat-grid">
    <div class="stat-cell"><div class="stat-label">📰 Artikel · 7H</div><div class="stat-num">${fmt(stats.articles7d)}</div><div class="stat-sub">dari ${fmt(stats.journalists7d)} jurnalis</div></div>
    <div class="stat-cell"><div class="stat-label">👁️ Dibaca · 7H</div><div class="stat-num">${fmt(stats.reads7d)}</div><div class="stat-sub">${fmt(stats.reactions7d)} reaksi</div></div>
    <div class="stat-cell"><div class="stat-label">🏛️ Surat Kabar</div><div class="stat-num">${fmt(stats.newspapers)}</div><div class="stat-sub">terbit minggu ini</div></div>
    <div class="stat-cell"><div class="stat-label">💬 Komentar</div><div class="stat-num">${fmt(stats.comments7d)}</div><div class="stat-sub">dalam 7 hari terakhir</div></div>
  </div>
  <div class="row" style="margin-bottom:12px">
    <button class="btn-gold" data-goto="#/press/new">✏️ TULIS ARTIKEL</button>
    <button class="btn-ghost" data-goto="#/newspaper">📰 Dirikan Koran (5 emas)</button>
    <button class="btn-ghost" data-goto="#/press/league">🏆 Liga Pers</button>
  </div>
  <div class="tabs">
    <button class="tab active">Terbaru</button>
    <button class="tab" data-sort="top_day">Teratas Hari Ini</button>
    <button class="tab" data-sort="top_week">Teratas Minggu Ini</button>
    <button class="tab" data-sort="top_month">Teratas Bulan Ini</button>
  </div>
  ${top ? `
  <div class="card" style="padding:0;overflow:hidden;cursor:pointer" data-goto="#/press/${top.id}">
    ${top.cover_sm ? `<img src="${esc(top.cover_sm)}" class="article-cover-hero" alt="Sampul artikel">` : ''}
    <div style="background:linear-gradient(135deg,#1a2c4d,#0d1526);padding:26px 16px 14px">
      <span class="chip">🔥 SEDANG RAMAI</span>
      <h3 style="font-size:24px;margin-top:8px">${esc(top.title)}</h3>
      <p class="muted small">📰 ${esc(top.newspaper_name)} · ${fmtDate(top.created_at)}</p>
      <p class="small">👁️ ${fmt(top.views)} &nbsp; 👍 ${top.likes} &nbsp; 👎 ${top.dislikes} &nbsp; 💬 ${top.comments}</p>
    </div>
  </div>` : ''}
  <div class="panel"><h3>🔥 JUGA SEDANG TREN</h3>
    ${list.articles.slice(1).length ? list.articles.slice(1).map((a, i) => `
      <div class="kv" style="cursor:pointer" data-goto="#/press/${a.id}">${articleThumbHtml(a.cover_sm)}<span class="k" style="flex:1"><b style="color:var(--gold)">${i + 2}</b> &nbsp;${esc(a.title)}<br><small class="muted">📰 ${esc(a.newspaper_name)} · ${fmtDate(a.created_at)}</small></span>
      <span class="v small">👁️ ${fmt(a.views)} 👍 ${a.likes}</span></div>`).join('')
      : '<p class="muted">Belum ada artikel. Jadilah jurnalis pertama!</p>'}
  </div>
  <div class="panel"><h3>📰 SEMUA ARTIKEL</h3><div id="all-articles">
    ${list.articles.length ? list.articles.map((a) => `
      <div class="kv" style="cursor:pointer" data-goto="#/press/${a.id}">${articleThumbHtml(a.cover_sm)}<span class="k" style="flex:1">${esc(a.title)}<br><small class="muted">${esc(a.newspaper_name)} · ${esc(a.topic)} · ${fmtDate(a.created_at)}</small></span>
      <span class="v small">👁️ ${fmt(a.views)}</span></div>`).join('') : '<p class="muted">Belum ada artikel.</p>'}
  </div></div>`);
  $$('[data-sort]').forEach((b) => b.onclick = async () => {
    const list2 = await api('/api/press/articles?sort=' + b.dataset.sort);
    $$('.tabs .tab').forEach((t) => t.classList.remove('active'));
    b.classList.add('active');
    $('#all-articles').innerHTML = list2.articles.length ? list2.articles.map((a) => `
      <div class="kv" style="cursor:pointer" data-goto="#/press/${a.id}">${articleThumbHtml(a.cover_sm)}<span class="k" style="flex:1">${esc(a.title)}<br><small class="muted">${esc(a.newspaper_name)} · ${esc(a.topic)} · ${fmtDate(a.created_at)}</small></span>
      <span class="v small">👁️ ${fmt(a.views)} 👍 ${a.likes}</span></div>`).join('') : '<p class="muted">Belum ada artikel.</p>';
  });
};

ROUTES['press/new'] = async () => {
  const mine = await api('/api/press/newspapers/mine');
  let pendingCover = null;
  let pendingCoverSm = null;
  $('#page').innerHTML = page('TULIS ARTIKEL', '', `
  ${mine.newspapers.length ? `
  <div class="panel"><h3>✏️ Artikel Baru</h3>
    <label>KORAN<select id="art-paper">${mine.newspapers.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join('')}</select></label>
    <label>TOPIK<select id="art-topic"><option>Perang</option><option>Ekonomi</option><option>Politik</option><option>Diplomasi</option><option>Panduan</option><option>Pengumuman</option></select></label>
    <label>JUDUL<input id="art-title" placeholder="Judul artikel..."></label>
    <label>SAMPUL <span class="muted small">(opsional, maks 500 KB)</span>
      <span class="row" style="margin-top:6px">
        <input type="file" id="art-cover-file" accept="image/*" hidden>
        <button class="btn-ghost btn-sm" id="btn-art-cover" type="button">🖼️ Tambah Sampul</button>
        <button class="btn-ghost btn-sm" id="btn-art-cover-del" type="button" hidden>🗑 Hapus Sampul</button>
      </span>
      <span id="art-cover-preview" style="display:block;margin-top:8px"></span>
    </label>
    <label>ISI<textarea id="art-content" rows="10" placeholder="Tulis beritamu di sini..."></textarea></label>
    <div class="row" style="margin-bottom:10px">
      <input type="file" id="art-inline-file" accept="image/*" hidden>
      <button class="btn-ghost btn-sm" id="btn-art-inline" type="button">🖼️ Sisipkan Gambar di Isi</button>
      <span class="muted small">maks 3 gambar, masing-masing maks 300 KB</span>
    </div>
    <button class="btn-gold" id="btn-publish">TERBITKAN</button>
  </div>` : emptyState('📰', 'Kamu belum punya koran', 'Dirikan koran dulu (5 emas) sebelum menulis artikel.')}
  ${!mine.newspapers.length ? `<button class="btn-gold" data-goto="#/newspaper">Dirikan Koran (5 emas)</button>` : ''}`);
  const coverInput = $('#art-cover-file');
  $('#btn-art-cover')?.addEventListener('click', () => coverInput.click());
  $('#btn-art-cover-del')?.addEventListener('click', () => {
    pendingCover = null; pendingCoverSm = null; coverInput.value = '';
    $('#art-cover-preview').innerHTML = '';
    $('#btn-art-cover-del').hidden = true;
  });
  coverInput?.addEventListener('change', async () => {
    const processed = await processCoverFile(coverInput.files[0]);
    if (!processed) { toast('Sampul harus gambar yang valid dan ukurannya maksimal 500 KB.'); coverInput.value = ''; return; }
    pendingCover = processed.cover;
    pendingCoverSm = processed.coverSm;
    $('#art-cover-preview').innerHTML = `<img src="${esc(pendingCoverSm)}" class="article-cover" alt="Pratinjau sampul">`;
    $('#btn-art-cover-del').hidden = false;
  });
  const inlineInput = $('#art-inline-file');
  $('#btn-art-inline')?.addEventListener('click', () => inlineInput.click());
  inlineInput?.addEventListener('change', async () => {
    const ta = $('#art-content');
    const existing = (ta.value.match(/\[gambar:/g) || []).length;
    if (existing >= 3) { toast('Maksimal 3 gambar di dalam isi artikel.'); inlineInput.value = ''; return; }
    const dataUrl = await processInlineImageFile(inlineInput.files[0]);
    if (!dataUrl) { toast('Gambar harus valid dan ukurannya maksimal 300 KB.'); inlineInput.value = ''; return; }
    const marker = `[gambar:${dataUrl}]`;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, start) + (start > 0 && !/\s$/.test(ta.value.slice(0, start)) ? '\n' : '') + marker + '\n' + ta.value.slice(end);
    ta.focus();
    inlineInput.value = '';
    toast('Gambar disisipkan di isi artikel.');
  });
  $('#btn-publish')?.addEventListener('click', async () => {
    try {
      const r = await post('/api/press/articles', { newspaper_id: Number($('#art-paper').value), title: $('#art-title').value.trim(), content: $('#art-content').value.trim(), topic: $('#art-topic').value, cover: pendingCover, cover_sm: pendingCoverSm });
      toast('Artikel diterbitkan!'); location.hash = '#/press/' + r.articleId;
    } catch (e) { toast(e.message); }
  });
};


// Artikel detail — dipanggil lewat route khusus di bawah (press/:id)
async function renderArticle(id) {
  const d = await api('/api/press/articles/' + id);
  const a = d.article;
  $('#page').innerHTML = page(esc(a.title).toUpperCase(), `📰 ${esc(a.newspaper_name)} · ${fmtDate(a.created_at)} · oleh ${esc(a.author_name)}`, `
  <div class="panel">
    ${a.cover ? `<img src="${esc(a.cover)}" class="article-cover" alt="Sampul artikel">` : ''}
    <div class="article-body" style="white-space:pre-wrap">${renderArticleContent(a.content)}</div>
    <div class="row" style="margin-top:14px">
      <button class="btn-ghost" id="btn-like">👍 Suka (${a.likes})</button>
      <button class="btn-ghost" id="btn-dislike">👎 Tidak Suka (${a.dislikes})</button>
      <button class="btn-ghost" id="btn-share">🔗 Bagikan ke Obrolan</button>
    </div>
    <p class="muted small" style="margin-top:8px">👁️ ${fmt(a.views)} dibaca · ${esc(a.topic)}</p>
  </div>
  <div class="panel"><h3>💬 KOMENTAR (${d.comments.length})</h3>
    ${d.comments.length ? d.comments.map((c) => `<div class="kv"><span class="k"><b>${esc(c.username)}</b><br>${esc(c.content)}</span><span class="v small muted">${ago(c.created_at)}</span></div>`).join('')
      : '<p class="muted">Belum ada komentar.</p>'}
    <div class="row" style="margin-top:10px"><input id="comment-text" placeholder="Tulis komentar..."><button class="btn-gold" id="btn-comment">KIRIM</button></div>
  </div>
  ${d.others.length ? `<div class="panel"><h3>📰 LAINNYA DARI ${esc(a.newspaper_name)}</h3>
    ${d.others.map((o) => `<div class="kv" style="cursor:pointer" data-goto="#/press/${o.id}">${articleThumbHtml(o.cover_sm)}<span class="k" style="flex:1">${esc(o.title)}</span><span class="v small">👁️ ${fmt(o.views)}</span></div>`).join('')}</div>` : ''}`);
  const react = async (reaction) => {
    try { await post(`/api/press/articles/${a.id}/react`, { reaction }); route(); }
    catch (e) { toast(e.message); }
  };
  $('#btn-like').onclick = () => react('like');
  $('#btn-dislike').onclick = () => react('dislike');
  $('#btn-share').onclick = async () => {
    try { await post('/api/chat/global', { content: 'Baca artikel ini: ' + a.title, article_id: a.id }); toast('Artikel dibagikan ke Obrolan Global.'); }
    catch (e) { toast(e.message); }
  };
  $('#btn-comment').onclick = async () => {
    try { await post(`/api/press/articles/${a.id}/comment`, { content: $('#comment-text').value.trim() }); route(); }
    catch (e) { toast(e.message); }
  };
}

// ---------- LIGA PERS ----------
ROUTES['press/league'] = async () => {
  const l = await api('/api/press/league');
  $('#page').innerHTML = page('LIGA PERS', 'Skor = 3 × reaksi bersih + penonton unik. Pemenang mingguan: koran 500 emas, jurnalis 250 emas.', `
  <div class="panel"><h3>🏆 PAPAN ATAS KORAN</h3>
    ${l.papers.length ? l.papers.map((p, i) => `<div class="kv"><span class="k">#${i + 1} ${esc(p.name)}</span><span class="v">${fmt(p.score)} poin</span></div>`).join('')
      : '<p class="muted">Belum ada koran yang berlaga.</p>'}
  </div>
  <div class="panel"><h3>✍️ PAPAN ATAS JURNALIS</h3>
    ${l.journalists.length ? l.journalists.map((j, i) => `<div class="kv"><span class="k">#${i + 1} ${esc(j.username)}</span><span class="v">${fmt(j.score)} poin</span></div>`).join('')
      : '<p class="muted">Belum ada jurnalis yang berlaga.</p>'}
  </div>`);
};

// ---------- DIRIKAN KORAN ----------
ROUTES.newspaper = async () => {
  const mine = await api('/api/press/newspapers/mine');
  $('#page').innerHTML = page('DIRIKAN KORAN', 'Mendirikan koran butuh 5 emas.', `
  <div class="panel"><h3>📰 Koran Baru</h3>
    <label>NAMA KORAN<input id="np-name" placeholder="cth: Kabar Rakyat"></label>
    <button class="btn-gold" id="btn-np">DIRIKAN KORAN (5 emas)</button>
  </div>
  <div class="panel"><h3>📰 KORANKU</h3>
    ${mine.newspapers.length ? mine.newspapers.map((n) => `<div class="kv"><span class="k">${esc(n.name)}</span><span class="v small muted">${fmtDate(n.created_at)} <button class="btn-danger btn-sm" type="button" data-dissolve="${n.id}">Bubarkan</button></span></div>`).join('')
      : '<p class="muted">Belum punya koran.</p>'}
  </div>`);
  $('#btn-np').onclick = async () => {
    // Anti double-submit (laporan pemain Vincent): tombol nonaktif +
    // status loading selama request berjalan — tidak bisa diketuk 2×.
    const btn = $('#btn-np');
    if (btn.disabled) return;
    btn.disabled = true;
    const oldLabel = btn.textContent;
    btn.textContent = 'MENDIRIKAN…';
    try { await post('/api/press/newspaper', { name: $('#np-name').value.trim() }); toast('Koran didirikan! Sekarang kamu bisa menulis artikel.'); await refreshMe(); route(); }
    catch (e) { toast(e.message); btn.disabled = false; btn.textContent = oldLabel; }
  };
  $$('[data-dissolve]').forEach((b) => b.onclick = async () => {
    if (!window.confirm('Bubarkan koran ini? Semua artikel di koran ini ikut terhapus.')) return;
    if (b.disabled) return;
    b.disabled = true;
    const oldLabel = b.textContent;
    b.textContent = 'Membubarkan…';
    try { await api('/api/press/newspapers/' + b.dataset.dissolve, { method: 'DELETE' }); toast('Koran dibubarkan.'); route(); }
    catch (e) { toast(e.message); b.disabled = false; b.textContent = oldLabel; }
  });
};

// ---------- CHAT ----------
const CHAT_TABS = [['global', 'GLOBAL'], ['indonesia', 'INDONESIA'], ['wilayah', 'WILAYAH']];
// Status auto-scroll chat (Perbaikan 1 — laporan Orang_solo): auto-scroll
// ke bawah HANYA bila pengguna sudah di dekat bawah (atau saat muat awal).
// Bila sedang membaca pesan lama ke atas, posisi dipertahankan dan tombol
// "pesan baru" muncul — tidak lagi dipaksa lompat ke bawah tiap polling.
const CHAT_NEAR_BOTTOM_PX = 80;
let chatNewCount = 0; // pesan baru yang masuk selagi pengguna membaca ke atas
let chatRetryMs = 0; // backoff retry saat load gagal (0 = belum pernah gagal)
let chatRetryTimer = null; // timer retry tertunda (satu saja yang boleh hidup)
let chatLoading = false; // pengaman: jangan tumpuk fetch (polling + retry)
function chatNearBottom() {
  const el = $('#chat-list');
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= CHAT_NEAR_BOTTOM_PX;
}
function hideChatNewPill() {
  const pill = $('#chat-new-pill');
  if (pill) pill.hidden = true;
  chatNewCount = 0;
}
function showChatNewPill() {
  const pill = $('#chat-new-pill');
  if (!pill) return;
  pill.hidden = false;
  pill.textContent = `↓ ${chatNewCount} pesan baru`;
}
function hideChatStatus() {
  const st = $('#chat-status');
  if (st) st.hidden = true;
}
function showChatStatus(msg) {
  const st = $('#chat-status');
  if (!st) return;
  st.hidden = false;
  st.innerHTML = `⚠️ ${esc(msg)} <button class="btn-text gold" type="button" id="chat-retry">Coba lagi</button>`;
  const btn = $('#chat-retry');
  if (btn) btn.onclick = () => { chatRetryMs = 0; hideChatStatus(); renderChatRoom(chatRoom); };
}
function clearChatRetry() {
  if (chatRetryTimer) { clearTimeout(chatRetryTimer); chatRetryTimer = null; }
  chatRetryMs = 0;
}
async function renderChatRoom(room) {
  if (chatLoading) return;
  const list = $('#chat-list');
  if (!list) return;
  chatLoading = true;
  const isFirstLoad = !chatSince;
  // Ukur posisi SEBELUM pesan baru ditambahkan (scrollHeight membesar
  // setelah append, jadi pengukuran sesudahnya selalu "di bawah").
  const wasNearBottom = isFirstLoad || chatNearBottom();
  try {
    const data = await api('/api/chat/' + room + (chatSince ? '?since=' + chatSince : ''));
    if (!chatSince) list.innerHTML = '';
    if (!data.messages.length && !chatSince) {
      list.innerHTML = `<div class="empty"><div class="big-ico">💬</div><h3>Belum ada pesan</h3><p class="muted">Jadilah yang pertama menulis di ruangan ini.</p></div>`;
    }
    for (const m of data.messages) {
      const div = document.createElement('div');
      div.className = 'msg';
      div.innerHTML = `
      <div class="msg-avatar">${avatarHtml(m.avatar, m.username, 48)}</div>
      <div class="msg-body">
        <div class="msg-head">
          <span class="msg-name ${m.isPremium ? 'premium-name' : ''}">${esc(m.username)}${m.isPremium ? ' ◆' : ''}</span>
          ${m.party_tag ? `<span class="msg-tag">[${esc(m.party_tag)}]</span>` : ''}
          <span class="msg-time">${fmtTime(m.created_at)}</span>
        </div>
        <div class="msg-bubble">${esc(m.content)}
          ${m.article_id ? `<a class="article-preview" href="#/press/${m.article_id}">
            <div class="ap-tag">📰 ARTIKEL</div><div class="ap-title">${esc(m.article_title || 'Artikel')}</div>
            <div class="ap-meta">👍 ${m.article_likes || 0} · 💬 ${m.article_comments || 0} komentar</div></a>` : ''}
        </div>
        <div class="msg-actions">
          <button data-report="${m.id}" type="button">🚩 Laporkan</button>
          <button data-block="${m.citizen_id}" type="button">🚫 Blokir</button>
        </div>
      </div>`;
      list.appendChild(div);
      chatSince = Math.max(chatSince, m.created_at);
    }
    $$('[data-report]').forEach((b) => b.onclick = () => openReport(Number(b.dataset.report)));
    $$('[data-block]').forEach((b) => b.onclick = async () => {
      try { await post('/api/chat/block', { citizen_id: Number(b.dataset.block) }); toast('Warga diblokir. Pesannya tidak akan terlihat lagi.'); route(); }
      catch (e) { toast(e.message); }
    });
    // Scroll: muat awal / sudah di bawah → lompat ke bawah; sedang baca ke
    // atas → tahan posisi dan tampilkan penanda pesan baru.
    if (wasNearBottom) {
      list.scrollTop = list.scrollHeight;
      hideChatNewPill();
    } else if (data.messages.length) {
      chatNewCount += data.messages.length;
      showChatNewPill();
    }
    // Load berhasil: sembunyikan status error dan reset backoff.
    hideChatStatus();
    clearChatRetry();
  } catch (e) {
    // Gagal load (server dingin / jaringan putus): JANGAN diam-diam
    // menampilkan data basi — tampilkan status error yang jelas dan
    // jadwalkan retry dengan backoff (2 dtk → 4 → 8 → maks 15 dtk).
    // Polling 5 detik tetap berjalan sebagai pengaman kedua.
    showChatStatus('Gagal memuat chat: ' + (e.message || 'koneksi bermasalah') + ' Mencoba lagi…');
    if (!chatRetryTimer) {
      chatRetryMs = chatRetryMs ? Math.min(chatRetryMs * 2, 15000) : 2000;
      chatRetryTimer = setTimeout(() => {
        chatRetryTimer = null;
        if (chatRoom === room) renderChatRoom(room);
      }, chatRetryMs);
    }
  } finally {
    chatLoading = false;
  }
}

ROUTES.chat = async (sub) => {
  // BUG (laporan pemain Vincent): pill aktif tab chat tidak ikut pindah —
  // isi sudah ke INDONESIA tapi highlight tetap di GLOBAL. Penyebab: `room`
  // baru diubah dari `sub` SETELAH tab dirender, jadi tab selalu dihitung
  // dari room='global'. Satu sumber kebenaran: ruangan + judul + sublabel
  // diturunkan dari `sub` DI AWAL, sebelum tab/judul/isi dirender. Judul
  // mengikuti roomTitle() server (OBROLAN GLOBAL/INDONESIA/WILAYAH, RUANG
  // SIDANG, PERTEMPURAN). Ruang 'negara' dihapus (redesain dunia) —
  // diganti 'wilayah' (region_<id wilayah sendiri>).
  let room = 'global';
  let title = 'OBROLAN GLOBAL';
  let subLabel = 'Kirim pesan ke dunia...';
  if (sub === 'indonesia') { room = 'indonesia'; title = 'OBROLAN INDONESIA'; subLabel = 'Kirim pesan ke seluruh Indonesia...'; }
  else if (sub === 'wilayah') { room = 'region_' + ME.region.id; title = 'OBROLAN WILAYAH'; subLabel = 'Kirim pesan ke warga ' + (ME.region?.name || 'wilayahmu') + '...'; }
  else if (sub === 'parliament') { room = 'parliament'; title = 'RUANG SIDANG'; subLabel = 'Hanya anggota parlemen, menteri, dan presiden yang bisa menulis.'; }
  else if (sub && sub.startsWith('war_')) {
    room = sub;
    title = 'PERTEMPURAN';
    const warId = sub.slice(4);
    try {
      const w = await api('/api/wars/' + warId);
      // BUG-12 (Tahap 3): judul lama memakai region_name dua kali
      // ("JAKARTA → JAKARTA"). Pakai label penyerang/pembela perang.
      subLabel = `GARIS DEPAN: ${(w.war.attacker_label || 'Penyerang').toUpperCase()} → ${(w.war.defender_label || 'Pembela').toUpperCase()}`;
    } catch { subLabel = 'Obrolan front perang'; }
  }
  $('#page').innerHTML = page('', '', `
  <div class="chat-tabs">
    ${CHAT_TABS.map(([r, label]) => `<button class="tab ${room === r || (r === 'wilayah' && room.startsWith('region_')) ? 'active' : ''}" data-goto="#/chat${r === 'global' ? '' : '/' + r}">${label}</button>`).join('')}
  </div>
  <h2 class="chat-title">${title}${room.startsWith('war_') ? '<span class="chat-live">● LANGSUNG</span>' : ''}</h2>
  <p class="page-sub">${esc(subLabel)}</p>
  <div id="chat-status" class="chat-status" hidden></div>
  <div id="chat-list" style="max-height:55vh;overflow-y:auto"></div>
  <button id="chat-new-pill" class="chat-new-pill" type="button" hidden>↓ pesan baru</button>
  <div class="chat-input">
    <input id="chat-text" aria-label="Tulis pesan chat" placeholder="${esc(subLabel)}" maxlength="500" autocomplete="off">
    <button class="btn-gold" id="btn-send">KIRIM</button>
  </div>
  <p class="muted small" style="margin-top:8px">Pesan minimal 3 kata dan jeda 30 detik dihitung untuk misi harian. Chat dimulai kosong — hanya pesan pemain asli.</p>`);
  const send = async () => {
    const input = $('#chat-text');
    const text = input.value.trim();
    if (!text) return;
    try { await post('/api/chat/' + room, { content: text }); input.value = ''; await renderChatRoom(room); }
    catch (e) { toast(e.message); }
  };
  $('#btn-send').onclick = send;
  $('#chat-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  // Tombol "pesan baru": lompat ke bawah dan sembunyikan penanda.
  const pill = $('#chat-new-pill');
  if (pill) pill.onclick = () => { const l = $('#chat-list'); if (l) l.scrollTop = l.scrollHeight; hideChatNewPill(); };
  // Pengguna scroll manual ke bawah → penanda tidak lagi diperlukan.
  const listEl = $('#chat-list');
  if (listEl) listEl.addEventListener('scroll', () => { if (chatNearBottom()) hideChatNewPill(); });
  chatSince = 0;
  chatRoom = room;
  await renderChatRoom(room);
  // Polling hemat (Tahap 5 — lag): lewati polling saat tab tidak aktif.
  chatTimer = setInterval(() => { if (!document.hidden) renderChatRoom(room); }, 5000);
};

// ---------- PESAN (DM) ----------
ROUTES.messages = async (otherId) => {
  if (otherId) {
    const d = await api('/api/dms/' + otherId);
    const convs = await api('/api/dms');
    const other = convs.conversations.find((c) => c.other_id === Number(otherId));
    $('#page').innerHTML = page('PESAN — ' + esc(other?.other_name || '').toUpperCase(), '', `
    <div id="dm-list" style="max-height:55vh;overflow-y:auto">
      ${d.messages.length ? d.messages.map((m) => `
        <div class="msg"><div class="msg-avatar">${avatarHtml(m.from_avatar, m.from_name, 48)}</div>
        <div class="msg-body"><div class="msg-head"><span class="msg-name">${esc(m.from_name)}</span><span class="msg-time">${fmtTime(m.created_at)}</span></div>
        <div class="msg-bubble">${esc(m.content)}</div></div></div>`).join('')
        : '<p class="muted">Belum ada pesan. Mulai percakapan!</p>'}
    </div>
    <div class="chat-input"><input id="dm-text" placeholder="Tulis pesan..." maxlength="500"><button class="btn-gold" id="btn-dm-send">KIRIM</button></div>
    <button class="btn-ghost btn-sm" data-goto="#/messages" style="margin-top:10px">← Semua Percakapan</button>`);
    const send = async () => {
      const v = $('#dm-text').value.trim();
      if (!v) return;
      try { await post('/api/dms/' + otherId, { content: v }); route(); }
      catch (e) { toast(e.message); }
    };
    $('#btn-dm-send').onclick = send;
    $('#dm-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    return;
  }
  const d = await api('/api/dms');
  $('#page').innerHTML = page('PESAN', 'Percakapan pribadi dengan warga lain.', `
  <div class="panel"><h3>✉️ PERCAKAPAN</h3>
    ${d.conversations.length ? d.conversations.map((c) => `
      <div class="kv" style="cursor:pointer" data-goto="#/messages/${c.other_id}">
        <span class="k"><b>${esc(c.other_name)}</b>${c.unread ? ` <span class="badge" style="position:static">${c.unread}</span>` : ''}<br><small class="muted">${esc(c.last)}</small></span>
        <span class="v small muted">${ago(c.at)}</span></div>`).join('')
      : emptyState('✉️', 'Belum ada percakapan', 'Kirim pesan ke warga lain dari halaman profil mereka.')}
  </div>`);
};

// ---------- ORGANISASI ----------
ROUTES.orgs = async () => {
  const data = await api('/api/orgs');
  $('#page').innerHTML = page('ORGANISASI', 'Aliansi antar negara dan warga — keamanan atau kerja sama.', `
  <div class="tabs">
    <button class="tab active">SEMUA <span class="chip">${data.organizations.length}</span></button>
    <button class="tab" data-filter="Keamanan">🛡️ KEAMANAN</button>
    <button class="tab" data-filter="Kerja Sama">🤝 KERJA SAMA</button>
  </div>
  <div class="panel"><h3>➕ DIRIKAN ORGANISASI — 100 emas</h3>
    <div class="row">
      <input id="org-name" placeholder="Nama organisasi">
      <input id="org-tag" placeholder="Singkatan (2–6 huruf)" style="max-width:160px">
      <select id="org-type" style="max-width:160px"><option>Kerja Sama</option><option>Keamanan</option></select>
      <button class="btn-gold" id="btn-org">DIRIKAN</button>
    </div>
  </div>
  <div class="panel"><h3>🤝 PAKTA ANTAR ORGANISASI</h3>
    <p class="muted small">Perjanjian Dagang: pajak penghasilan antar anggota kedua organisasi dipotong 50%. Pakta Pertahanan: anggota kedua organisasi +10% kerusakan perang. Pakta harus disetujui ketua kedua organisasi dan bisa dibubarkan kapan saja.</p>
    ${data.pacts?.length ? data.pacts.map((p) => {
      const label = p.kind === 'trade' ? 'Perjanjian Dagang' : 'Pakta Pertahanan';
      const amLeader = p.org_a_leader_id === ME.citizen.id || p.org_b_leader_id === ME.citizen.id;
      return `<div class="card"><h4>${label}</h4>
      <p class="muted small">${esc(p.org_a_name)} ↔ ${esc(p.org_b_name)} · ${p.status === 'active' ? 'AKTIF' : 'menunggu persetujuan'}</p>
      ${p.status === 'pending' && amLeader ? `<div class="row"><button class="btn-gold btn-sm" data-pact-accept="${p.id}">SETUJUI</button><button class="btn-danger btn-sm" data-pact-reject="${p.id}">TOLAK</button></div>` : ''}
      ${p.status === 'active' && amLeader ? `<button class="btn-ghost btn-sm" data-pact-dissolve="${p.id}">Bubarkan Pakta</button>` : ''}
      </div>`;
    }).join('') : '<p class="muted">Belum ada pakta.</p>'}
    ${(() => {
      const myLedOrg = data.organizations.find((o) => o.id === data.myOrgId && o.leader_name === ME.citizen.username);
      const canPropose = myLedOrg || data.myMinisterRole === 'foreign';
      if (!canPropose) return '<p class="muted small">Hanya ketua organisasi atau Menteri Luar Negeri yang bisa mengusulkan pakta.</p>';
      const fromOrg = myLedOrg || data.organizations[0];
      if (!fromOrg) return '<p class="muted small">Belum ada organisasi.</p>';
      const targets = data.organizations.filter((o) => o.id !== fromOrg.id);
      if (!targets.length) return '<p class="muted small">Butuh minimal dua organisasi untuk berpakta.</p>';
      return `<div class="card" style="margin-top:10px"><h4>USULKAN PAKTA — dari ${esc(fromOrg.name)}</h4>
      <label>ORGANISASI TUJUAN<select id="pact-target">${targets.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select></label>
      <label>JENIS PAKTA<select id="pact-kind"><option value="trade">Perjanjian Dagang (pajak antar anggota −50%)</option><option value="defense">Pakta Pertahanan (+10% kerusakan perang)</option></select></label>
      <button class="btn-gold" id="btn-pact" data-from="${fromOrg.id}">USULKAN PAKTA</button></div>`;
    })()}
  </div>
  <div class="panel" id="org-list"><h3>🏛️ SEMUA ORGANISASI</h3>
    ${data.organizations.length ? data.organizations.map((o) => `
      <div class="card"><h4>${esc(o.name)} <span class="chip">${esc(o.tag)}</span></h4>
      <p class="muted small">${o.type === 'Keamanan' ? '🛡️ KEAMANAN' : '🤝 KERJA SAMA'} · Demokratis · 👥 ${o.members} anggota · 👑 ${esc(o.leader_name)}</p>
      ${data.myOrgId === o.id ? '<span class="chip teal">✓ Anggotamu</span> <button class="btn-ghost btn-sm" data-org-leave="' + o.id + '">Keluar</button>'
        : data.myOrgId ? '<span class="muted small">Kamu sudah di organisasi lain.</span>'
        : `<button class="btn-gold btn-sm" data-org-join="${o.id}">GABUNG</button>`}
      </div>`).join('') : emptyState('🤝', 'Belum ada organisasi', 'Dunia masih baru. Dirikan organisasi pertama!')}
  </div>`);
  $('#btn-org').onclick = async () => {
    try { await post('/api/orgs', { name: $('#org-name').value.trim(), tag: $('#org-tag').value.trim().toUpperCase(), type: $('#org-type').value }); toast('Organisasi didirikan!'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  };
  $$('[data-org-join]').forEach((b) => b.onclick = async () => {
    try { await post(`/api/orgs/${b.dataset.orgJoin}/join`); toast('Kamu bergabung dengan organisasi.'); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-org-leave]').forEach((b) => b.onclick = async () => {
    // Tahap 3: keluar organisasi itu destruktif — minta konfirmasi dulu.
    if (!confirm('Keluar dari organisasi ini?')) return;
    try { await post(`/api/orgs/${b.dataset.orgLeave}/leave`); toast('Kamu keluar dari organisasi.'); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-pact-accept]').forEach((b) => b.onclick = async () => {
    try { await post(`/api/orgs/pacts/${b.dataset.pactAccept}/accept`, {}); toast('Pakta disetujui — kini aktif!'); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-pact-reject]').forEach((b) => b.onclick = async () => {
    if (!confirm('Tolak usulan pakta ini?')) return;
    try { await post(`/api/orgs/pacts/${b.dataset.pactReject}/reject`, {}); toast('Usulan pakta ditolak.'); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-pact-dissolve]').forEach((b) => b.onclick = async () => {
    if (!confirm('Bubarkan pakta ini? Bonusnya langsung hilang untuk kedua organisasi.')) return;
    try { await post(`/api/orgs/pacts/${b.dataset.pactDissolve}/dissolve`, {}); toast('Pakta dibubarkan.'); route(); }
    catch (e) { toast(e.message); }
  });
  $('#btn-pact')?.addEventListener('click', async () => {
    try {
      const from = Number($('#btn-pact').dataset.from);
      await post(`/api/orgs/${from}/pact`, { target_org_id: Number($('#pact-target').value), kind: $('#pact-kind').value });
      toast('Usulan pakta dikirim ke ketua organisasi tujuan.'); route();
    } catch (e) { toast(e.message); }
  });
  $$('[data-filter]').forEach((b) => b.onclick = () => {
    $$('#org-list .card').forEach((card) => {
      card.style.display = card.textContent.includes(b.dataset.filter === 'Keamanan' ? 'KEAMANAN' : 'KERJA SAMA') ? '' : 'none';
    });
    $$('[data-filter]').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
  });
};

// ---------- TOKO ----------
ROUTES.shop = async () => {
  const s = await api('/api/shop');
  // Pesan WhatsApp menyertakan nama warga + ID publik pemain yang login,
  // supaya admin tahu siapa yang harus diberi paketnya. Bila data pemain
  // entah bagaimana tidak tersedia, pesan tetap terkirim tanpa nama.
  const who = (ME?.user?.username && ME?.user?.publicId)
    ? `. Nama warga: ${ME.user.username} (ID: ${ME.user.publicId})`
    : '';
  const wa = (label) => s.waUrl + '?text=' + encodeURIComponent('Halo, saya mau top-up Parlementer: ' + label + who);
  $('#page').innerHTML = page('TOKO PERBENDAHARAAN', 'Top-up diproses manual via WhatsApp. Semua paket bisa dihadiahkan.', `
  ${s.packages.map((p) => `
  <div class="panel" style="overflow:hidden">
    ${p.best ? '<div class="shop-banner">★ PALING DIMINATI</div>' : ''}
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div style="min-width:0"><h3 style="font-size:24px">${esc(p.name)}</h3><p class="muted" style="font-style:italic">${esc(p.tagline)}</p></div>
      <span class="chip teal">${esc(p.save)}</span>
    </div>
    <div class="kv"><span class="k">💎 Premium ${p.premiumMonths} bulan</span></div>
    <div class="kv"><span class="k">🪙 ${fmt(p.gold)} emas</span></div>
    <p class="price-big">${fmtIDR(p.price)}</p>
    <p><span class="was-price">${fmtIDR(p.was)}</span> <span class="teal-text">hemat ${fmtIDR(p.was - p.price)}</span></p>
    <div class="row"><a class="btn-gold" style="flex:1;text-align:center;text-decoration:none" href="${wa(p.name + ' ' + fmtIDR(p.price))}" target="_blank" rel="noopener">🎁 &nbsp; AMBIL PAKETNYA</a></div>
  </div>`).join('')}
  <div class="panel" style="border-color:#3b2f6b">
    <h3 style="color:#c4b5fd">💎 AULA PARA PATRON — PREMIUM</h3>
    <p>${esc(s.perks)} Setiap paket ditambahkan ke sisa waktumu.</p>
    ${s.premium.map((p) => `
      <div class="card"><div class="panel-head"><h4>${p.months} BULAN</h4><span class="price-big" style="font-size:28px">${fmtIDR(p.price)}</span></div>
      <p class="muted small">${fmtIDR(p.perMonth)}/bulan</p>
      <a class="btn-gold" style="display:block;text-align:center;text-decoration:none" href="${wa('Premium ' + p.months + ' bulan ' + fmtIDR(p.price))}" target="_blank" rel="noopener">AMBIL PREMIUM</a></div>`).join('')}
  </div>`);
};

// ---------- MEJA BANTUAN / KONTAK / BUKU ----------
ROUTES.help = async () => {
  $('#page').innerHTML = page('MEJA BANTUAN', 'Laporkan bug atau sampaikan ide langsung ke pengembang.', `
  <div class="panel"><h3>🎧 Kirim Laporan / Saran</h3>
    <label>JENIS<select id="h-type"><option>Laporan bug</option><option>Saran</option></select></label>
    <label>TOPIK<select id="h-topic"><option>Ekonomi &amp; Pasar</option><option>Perang &amp; Militer</option><option>Politik &amp; Undang-undang</option><option>Peta &amp; Perjalanan</option><option>Akun &amp; Profil</option><option>Banding hukuman</option><option>Antarmuka &amp; Desain</option><option>Hal lain</option></select></label>
    <label>JELASKAN<textarea id="h-details" rows="5" placeholder="Jelaskan bug atau idemu sedetail mungkin..."></textarea></label>
    <button class="btn-gold" id="btn-help">KIRIM</button>
  </div>`);
  $('#btn-help').onclick = async () => {
    try { await post('/api/support', { type: $('#h-type').value, topic: $('#h-topic').value, details: $('#h-details').value.trim() }); toast('Terima kasih! Laporanmu sudah terkirim.'); route(); }
    catch (e) { toast(e.message); }
  };
};

ROUTES.contact = async () => {
  $('#page').innerHTML = page('KONTAK', '', `
  <div class="panel"><h3>📱 TOP-UP &amp; BANTUAN</h3>
    <p>Top-up Premium dan paket emas diproses manual via WhatsApp:</p>
    <p style="margin:12px 0"><a class="btn-gold" style="text-decoration:none" href="https://wa.me/6285220743283" target="_blank" rel="noopener">💬 Chat WhatsApp — 6285220743283</a></p>
    <p class="muted small">Sebutkan nama wargamu dan paket yang diinginkan. Pembayaran dikonfirmasi manual oleh admin.</p>
  </div>
  <div class="panel"><h3>📖 PERATURAN SINGKAT</h3>
    <p class="small">1) Satu akun per orang. 2) Bermain adil — tanpa bot/skrip/makro. 3) Hormati pemain lain. 4) Politik &amp; perang adalah fiksi. 5) Laporkan pelanggaran lewat tombol Laporkan. 6) Pelanggaran bisa berujung hukuman &amp; rekam jejak.</p>
  </div>`);
};

ROUTES.book = async () => {
  let ann = { announcements: [] };
  try { ann = await api('/api/announcements'); } catch { /* panduan tetap tampil walau pengumuman gagal dimuat */ }
  $('#page').innerHTML = page('BUKU PANDUAN', 'Cara bermain Parlementer.', `
  <div class="panel"><h3>🎯 ALUR INTI</h3>
    <p>1) Habiskan energi untuk bekerja (shift) atau berperang.<br>
    2) Makan roti + ambil pasokan harian.<br>
    3) Naik level lewat XP dari shift, perang, misi, dan pasokan.<br>
    4) Gabung partai / perusahaan / negara — lalu kuasai dunia.</p></div>
  <div class="panel"><h3>💰 EKONOMI</h3>
    <p>Pasar lokal memakai Rupiah, Pasar Global memakai emas. Pajak penghasilan saat menjual sesuai UU yang berlaku (lihat halaman Parlemen). Valas: 1 emas dicetak jadi ${fmtRp(10)}. Mata uang tidak bisa ditukar langsung — harus lewat emas.</p></div>
  <div class="panel"><h3>🏛️ POLITIK</h3>
    <p>Dirikan partai (Level 10 + 50 emas). Menangkan pemilu parlemen untuk merebut 60 kursi (mayoritas 31). Presiden dipilih warga Level 5+ yang sudah 3 hari menjadi warga.</p></div>
  <div class="panel"><h3>⚔️ PERANG</h3>
    <p>Dukung pemberontakan di wilayah (50 emas; 100 emas untuk ibu kota). 5 pendukung menyulut perang. Serang dari garis depan: harus berada di wilayah perang, butuh 10 energi + 1 senjata.</p></div>
  <div class="panel"><h3>📰 PERS</h3>
    <p>Dirikan koran (5 emas), tulis artikel, kumpulkan pembaca dan reaksi. Skor liga = 3 × reaksi bersih + penonton unik.</p></div>
  <div class="panel"><h3>📜 RIWAYAT UPDATE</h3>
    <p class="muted small">Semua pengumuman update, dari yang terbaru ke yang terlama. Nomor urut mengikuti urutan terbit (Update #1 = pengumuman pertama).</p>
    ${ann.announcements.length ? ann.announcements.map((a) => `
      <div style="margin-bottom:16px">
        <div class="kv"><span class="k"><span class="chip">Update #${a.num}</span> <b>${esc(a.title)}</b></span>
        <span class="v small muted" style="white-space:nowrap">${fmtDate(a.created_at)}</span></div>
        <p class="announce-body">${esc(a.body)}</p>
      </div>`).join('')
      : '<p class="muted">Belum ada pengumuman.</p>'}
  </div>`);
};

// ---------- MODAL LAPOR ----------
let reportMessageId = null;
let reportReason = null;
function openReport(messageId) {
  reportMessageId = messageId;
  reportReason = null;
  $$('#report-reasons button').forEach((b) => b.classList.remove('selected'));
  $('#report-details').value = '';
  $('#report-modal').hidden = false;
}
$$('#report-reasons button').forEach((b) => b.onclick = () => {
  $$('#report-reasons button').forEach((x) => x.classList.remove('selected'));
  b.classList.add('selected');
  reportReason = b.dataset.reason;
});
$('#report-cancel').onclick = () => { $('#report-modal').hidden = true; };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#report-modal').hidden) $('#report-modal').hidden = true;
  // Tahap 3: drawer juga bisa ditutup dengan Escape (sebelumnya hanya modal).
  if (e.key === 'Escape' && $('#drawer').classList.contains('open')) closeDrawer();
  // Rombak UI: popover penjelasan (energi / kelelahan) juga ditutup Escape.
  if (e.key === 'Escape' && $('#popover-root')?.children.length) closePopover();
});
$('#report-submit').onclick = async () => {
  if (!reportReason) { toast('Pilih alasan laporan dulu.'); return; }
  try {
    await post('/api/chat/report', { message_id: reportMessageId, reason: reportReason, details: $('#report-details').value.trim() });
    $('#report-modal').hidden = true;
    toast('Laporan dikirim ke moderator.');
  } catch (e) { toast(e.message); }
};
$('#report-modal').addEventListener('click', (e) => { if (e.target.id === 'report-modal') e.target.hidden = true; });

// ---------- MODAL PENGUMUMAN UPDATE ("Apa yang Baru", Tahap 4) ----------
// Sekali per sesi login: bila ada pengumuman yang belum dibaca, tampilkan
// yang terbaru sebagai modal. "SUDAH DIBACA" menandai dibaca di server;
// "NANTI" hanya menutup (muncul lagi di sesi berikut). Akun banned tidak
// mendapat modal ini.
let __announceShown = false;
async function maybeShowAnnouncement() {
  if (__announceShown || ME?.user?.is_banned) return;
  __announceShown = true;
  let data;
  try { data = await api('/api/announcements'); } catch { return; }
  const unread = (data.announcements || []).filter((a) => !a.read);
  if (!unread.length) return;
  const a = unread[0]; // terbaru dulu (server mengurutkan DESC)
  $('#announce-modal-sub').textContent = `Update #${a.num} · ${fmtDate(a.created_at)} — ${a.title}`;
  $('#announce-modal-body').textContent = a.body;
  $('#announce-modal').hidden = false;
  $('#announce-modal-read').onclick = async () => {
    try { await post('/api/announcements/read', { id: a.id }); } catch { /* abaikan */ }
    $('#announce-modal').hidden = true;
    await refreshMe();
  };
  $('#announce-modal-later').onclick = () => { $('#announce-modal').hidden = true; };
  $('#announce-modal').addEventListener('click', (e) => { if (e.target.id === 'announce-modal') e.target.hidden = true; }, { once: true });
}

// ---------- ROUTE KHUSUS: press/:id & chat sub-room ----------
const _route = route;
route = function () {
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [slug, arg] = hash.split('/');
  if (slug === 'press' && arg && !isNaN(Number(arg))) { renderArticle(Number(arg)).catch((e) => { $('#page').innerHTML = `<div class="panel"><p>${esc(e.message)}</p></div>`; }); return; }
  if (slug === 'press' && arg === 'league') { ROUTES['press/league'](); return; }
  if (slug === 'press' && arg === 'new') { ROUTES['press/new'](); return; }
  if (slug === 'chat' && arg && !CHAT_TABS.some(([r]) => r === arg) && arg !== 'parliament' && !arg.startsWith('war_')) { location.hash = '#/chat'; return; }
  _route();
};
