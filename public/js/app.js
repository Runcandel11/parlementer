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

// Jam ganda XP (tiket #21, v3.1.0): 00:00–01:00 WIB shift memberi XP ×2.
// Server memakai aturan yang sama (isDoubleXpHour di src/game.js — jam UTC
// + 7); di sini dihitung dari zona Asia/Jakarta supaya chip tampil tepat
// walau jam perangkat pemain melenceng dari WIB.
function wibHourNow() {
  try {
    const h = Number(new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: 'numeric', hour12: false }).format(new Date()));
    return h === 24 ? 0 : h; // beberapa implementasi Intl menulis tengah malam sebagai 24
  } catch { return new Date().getHours(); }
}
function isDoubleXpNow() { return wibHourNow() === 0; }
function doubleXpChip() { return isDoubleXpNow() ? `<p class="small" style="color:#ffd700">🌙 <b>JAM GANDA XP ×2</b> — sekarang (00:00–01:00 WIB)! Shift apa pun memberi XP dua kali lipat.</p>` : ''; }

// Blok toggle kerja otomatis 24 jam (v4.5.0, Premium): tampil di panel
// PEKERJAANMU bila sudah bekerja. Non-Premium hanya melihat catatan
// bahwa fitur ini khusus Premium.
function autoWorkBlock() {
  const aw = ME.autoWork || { active: false, until: 0, shifts: 0, paused: false, lastAt: 0 };
  if (!ME.citizen.isPremium) return `<p class="muted small">🤖 Kerja otomatis 24 jam (jalan walau aplikasi ditutup) khusus Premium — shift berjalan otomatis di server selama 24 jam.</p>`;
  const status = !aw.active ? 'Mati — nyalakan untuk kerja otomatis 24 jam.'
    : aw.paused ? `Aktif, DIJEDA — kelelahan ≥ 10.000, lanjut otomatis saat pulih di bawah 10.000. ${aw.shifts} shift otomatis sejauh ini.`
    : `Aktif · sisa ${fmtRemaining(aw.until - Date.now())} · ${aw.shifts} shift otomatis · shift jalan tiap energi penuh (100).`;
  return `<div class="kv"><span class="k">🤖 Kerja otomatis 24 jam</span><span class="v">${aw.active ? (aw.paused ? 'DIJEDA' : 'AKTIF') : 'MATI'}</span></div>
  <p class="muted small">${status}</p>
  <div class="row"><button class="btn-gold btn-sm" id="btn-autowork" type="button">${aw.active ? 'MATIKAN KERJA OTOMATIS' : 'NYALAKAN KERJA OTOMATIS (24 JAM)'}</button></div>`;
}

// Foto profil: tampil BESAR dengan aspek asli (tiket #11 LIO, v3.1.0) —
// bukan lingkaran kecil yang memotong foto. Avatar lama (kotak 256×256)
// tetap tampil normal sebagai kotak. Bila belum ada foto, inisial 144px.
function profilePhotoHtml(avatar, username) {
  return avatar
    ? `<img src="${esc(avatar)}" class="profile-photo" alt="Foto profil ${esc(username || '')}">`
    : `<span class="avatar-initial" style="width:144px;height:144px;font-size:65px">${esc((username || '?')[0].toUpperCase())}</span>`;
}

// Foto: TIDAK ada gerbang tipe/ekstensi di depan — picker Android sering
// memberi file.type kosong DAN nama tanpa ekstensi yang dikenali (tanpa
// ekstensi, .gif, .jfif, dsb.) padahal isinya JPEG valid yang bisa dibaca
// browser (kasus 28 Nov 2026: JPG < 500 KB ditolak pesan format, ronde 2).
// Satu-satunya penjaga format adalah decode lewat <img> di dalam tiap
// process*File: berhasil decode → lanjut resize; gagal decode → 'format'.
// File yang benar-benar tidak bisa di-decode browser (mis. HEIC berlabel
// .jpg) tetap ditolak — itu batasan browser, bukan bug alur ini.

// Pesan error upload foto — dibedakan per penyebab supaya tidak lagi menuduh
// ukuran padahal masalahnya format.
const IMAGE_ERROR_FORMAT = 'Format foto tidak didukung atau file rusak. Pakai JPG, PNG, atau WebP.';
const IMAGE_ERROR_SIZE = 'Foto terlalu besar (maks 500 KB setelah diperkecil).';
// (v4.6.0, penyelidikan bug foto LIO): file HEIC dari galeri HP tidak bisa
// di-decode browser (Chrome Android tidak mendukung HEIC di <img>) — pesan
// ini memberi jalan keluar konkret, bukan tuduhan format generik. Teks
// yang sama dipakai server (src/util.js, HEIC_ERROR_MESSAGE) — jaga agar
// keduanya selaras bila diubah.
const IMAGE_ERROR_HEIC = 'Foto ini berformat HEIC (dari galeri HP) — browser tidak bisa membacanya. Ubah ke JPG dulu (di galeri: bagikan → simpan sebagai JPG, atau ubah pengaturan kamera ke "Paling Kompatibel"), lalu upload lagi.';
function imageErrorMessage(err) {
  if (err === 'size') return IMAGE_ERROR_SIZE;
  if (err === 'heic') return IMAGE_ERROR_HEIC;
  return IMAGE_ERROR_FORMAT;
}

// Deteksi HEIC/HEIF SEBELUM decode (v4.6.0, penyelidikan bug foto LIO):
// browser gagal decode HEIC lewat <img> tanpa memberi tahu alasannya,
// jadi kenali dulu dari tiga sinyal — tipe MIME, ekstensi nama, dan magic
// bytes kotak ftyp (....ftyp + brand heic/heix/hevc/heim/heis/heif/mif1/
// msf1). Mengembalikan true bila HEIC. File tanpa sinyal apa pun (mis.
// JPEG dengan tipe kosong — kasus ronde 2) TETAP lanjut ke decode seperti
// biasa; deteksi ini hanya menangkap HEIC, bukan mengembalikan gerbang
// tipe/ekstensi yang sudah dihapus.
async function isHeicFile(file) {
  if (!file) return false;
  const type = String(file.type || '').toLowerCase();
  if (type === 'image/heic' || type === 'image/heif') return true;
  const name = String(file.name || '').toLowerCase();
  if (name.endsWith('.heic') || name.endsWith('.heif')) return true;
  try {
    const buf = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (buf.length < 12) return false;
    const ascii = (a, b) => String.fromCharCode(...buf.slice(a, b));
    if (ascii(4, 8) !== 'ftyp') return false;
    return ['heic', 'heix', 'hevc', 'heim', 'heis', 'heif', 'mif1', 'msf1'].includes(ascii(8, 12));
  } catch {
    return false;
  }
}

// Baca file gambar → resize mengikuti aspek asli (sisi terpanjang 256px)
// lewat canvas → data URL JPEG, plus thumbnail 48px untuk daftar chat/DM
// (Tahap 3, §6.3; aspek dipertahankan sejak v3.1.0, tiket #11).
// Mengembalikan { avatar, avatarSm } atau { error: 'format' | 'size' }:
// 'format' = bukan gambar / tidak bisa dibaca browser, 'size' = hasil
// resize tetap > 500 KB (thumbnail > 25 KB).
async function processAvatarFile(file) {
  if (!file) return { error: 'format' };
  // (v4.6.0): HEIC dikenali dulu — decode <img> akan gagal tanpa alasan.
  if (await isHeicFile(file)) return { error: 'heic' };
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('gagal membaca gambar'));
      i.src = url;
    });
    // Foto profil mengikuti ASPEK ASLI galeri (tiket #11 LIO, v3.1.0):
    // diperkecil sampai sisi terpanjang 256px TANPA crop persegi —
    // sebelumnya foto dipotong jadi kotak 256×256 di tengah, jadi foto
    // vertikal/horizontal terpotong dan terlihat kecil/burem.
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 256 / Math.max(img.width, img.height));
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    let avatar = null;
    for (const q of [0.85, 0.6, 0.4]) {
      const dataUrl = canvas.toDataURL('image/jpeg', q);
      // Data URL base64 ≈ 4/3 ukuran biner; 500 KB biner ≈ 682.667 karakter.
      if (dataUrl.length <= 682667) { avatar = dataUrl; break; }
    }
    if (!avatar) return { error: 'size' };
    // Thumbnail 48px (sisi terpanjang) dari canvas yang sama, aspek ikut.
    const sm = document.createElement('canvas');
    const smScale = Math.min(1, 48 / Math.max(canvas.width, canvas.height));
    sm.width = Math.max(1, Math.round(canvas.width * smScale));
    sm.height = Math.max(1, Math.round(canvas.height * smScale));
    sm.getContext('2d').drawImage(canvas, 0, 0, sm.width, sm.height);
    const avatarSm = sm.toDataURL('image/jpeg', 0.8);
    if (avatarSm.length > 34100) return { error: 'size' };
    return { avatar, avatarSm };
  } catch {
    return { error: 'format' };
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
// 400×210 untuk daftar artikel. Mengembalikan { cover, coverSm } atau
// { error: 'format' | 'size' } (sama seperti processAvatarFile).
async function processCoverFile(file) {
  if (!file) return { error: 'format' };
  // (v4.6.0): HEIC dikenali dulu — decode <img> akan gagal tanpa alasan.
  if (await isHeicFile(file)) return { error: 'heic' };
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
    if (!cover) return { error: 'size' };
    // Thumbnail 400×210 dari canvas yang sama (50 KB biner ≈ 68.266 karakter).
    const sm = document.createElement('canvas');
    sm.width = 400; sm.height = 210;
    sm.getContext('2d').drawImage(canvas, 0, 0, 400, 210);
    let coverSm = null;
    for (const q of [0.75, 0.6, 0.45]) {
      const dataUrl = sm.toDataURL('image/jpeg', q);
      if (dataUrl.length <= 68266) { coverSm = dataUrl; break; }
    }
    if (!coverSm) return { error: 'size' };
    return { cover, coverSm };
  } catch {
    return { error: 'format' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Gambar di dalam isi artikel: muat dalam lebar maks 1024px (rasio asli
// dipertahankan) → data URL JPEG. Mengembalikan data URL atau null bila
// file bukan gambar atau hasil akhirnya tetap > 300 KB biner
// (≈ 409.600 karakter base64).
async function processInlineImageFile(file) {
  if (!file) return null;
  // (v4.6.0): HEIC dikenali dulu — decode <img> akan gagal tanpa alasan.
  if (await isHeicFile(file)) return null;
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
const patch = (path, body = {}) => api(path, { method: 'PATCH', body });

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

// Versi game (dari konstanta VERSION di src/game.js, dikirim /api/world +
// /api/me): tampil kecil di footer landing + drawer. Tanpa versi dari
// server, tampil "Parlementer" saja — jangan karang angka versi.
function setVersion(v) {
  if (!v) return;
  const label = 'Parlementer v' + v;
  const lv = $('#landing-version');
  if (lv) lv.textContent = label;
  const fv = $('#landing-footer-version');
  if (fv) fv.textContent = label;
  const dv = $('#drawer-version');
  if (dv) dv.textContent = label;
}

// Landing page: tampil untuk pengunjung belum login; form login/daftar
// muncul setelah ketuk CTA (atau langsung bila ?ref= ada).
function showLanding() {
  $('#landing-hero').hidden = false;
  const lp = $('#landing-page');
  if (lp) lp.hidden = false;
  $('#auth-card-wrap').hidden = true;
  $('#auth-view').classList.add('landing');
}
function showAuthForm(which) {
  $('#landing-hero').hidden = true;
  const lp = $('#landing-page');
  if (lp) lp.hidden = true;
  $('#auth-card-wrap').hidden = false;
  $('#auth-view').classList.remove('landing');
  switchAuthTab(which);
}

// Landing v5.1.0: isi angka + kabar dunia LIVE dari /api/world (data nyata).
// Dipanggil sekali saat showAuth (publik, tanpa login). Bila API gagal,
// angka tetap "—" dan kabar menampilkan keadaan kosong yang jujur.
function renderLandingWorld(w) {
  if (!w) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('ls-population', fmt(w.population));
  set('ls-countries', fmt(w.countries));
  set('ls-regions-owned', fmt(w.regionsOwned));
  set('ls-regions-total', fmt(w.regions));
  set('ls-fronts', fmt(w.activeFronts));
  set('ls-tx', fmt(w.tx24h));
  // Front live: perang aktif paling sengit, atau keadaan damai yang jujur.
  const body = document.getElementById('landing-front-body');
  const peace = document.getElementById('landing-front-peace');
  if (w.front) {
    if (body) body.hidden = false;
    if (peace) peace.hidden = true;
    set('lf-type', w.front.type || 'PEMBERONTAKAN');
    const total = (w.front.scoreA || 0) + (w.front.scoreD || 0);
    const defPct = total > 0 ? Math.round((w.front.scoreD / total) * 100) : 50;
    set('lf-region', (w.front.region || '').toUpperCase());
    set('lf-attacker', w.front.attacker || '—');
    set('lf-defender', w.front.defender || '—');
    set('lf-score-a', fmt(w.front.scoreA));
    set('lf-score-d', fmt(w.front.scoreD));
    const bar = document.getElementById('lf-bar');
    if (bar) bar.style.width = (100 - defPct) + '%'; // bar merah = pangsa penyerang
    set('lf-note', defPct >= 50 ? `Pihak bertahan menahan · ${defPct}%` : `Pihak penyerang unggul · ${100 - defPct}%`);
    const endsMs = (w.front.endsAt || 0) - Date.now();
    set('lf-ends', endsMs > 0 ? 'BERAKHIR DALAM ' + fmtCountdown(endsMs).toUpperCase() : 'SEGERA BERAKHIR');
  } else {
    if (body) body.hidden = true;
    if (peace) peace.hidden = false;
  }
  // Kabar langsung: peristiwa nyata terbaru (maks 6).
  const list = document.getElementById('landing-feed-list');
  const empty = document.getElementById('landing-feed-empty');
  if (list) {
    list.innerHTML = (w.feed || []).map((f) => `<li><span class="landing-feed-icon">${esc(f.icon || '•')}</span><span class="landing-feed-text">${esc(f.text || '')}</span><span class="landing-feed-time">${ago(f.at)}</span></li>`).join('');
    if (empty) empty.hidden = (w.feed || []).length > 0;
  }
  // Jam kabar langsung (UTC, ala Parlementum).
  const clock = document.getElementById('landing-feed-clock');
  if (clock) { const d = new Date(); clock.textContent = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ' UTC'; }
  // Kutipan pilar: transaksi terakhir + jumlah perang (data nyata).
  if (w.lastTrade) set('landing-trade-quote', `“${fmt(w.lastTrade.qty)}× ${String(w.lastTrade.commodity || '').toUpperCase()} TERJUAL DI PASAR.”`);
  set('landing-war-quote', (w.warsTotal || 0) > 0 ? `“${fmt(w.warsTotal)} PERANG SUDAH TERJADI DI DUNIA INI.”` : '“BELUM ADA PERANG YANG PERNAH TERJADI.”');
}

function showAuth() {
  hideLoading();
  $('#app').hidden = true;
  $('#auth-view').hidden = false;
  $('#tab-login').onclick = () => switchAuthTab('login');
  $('#tab-register').onclick = () => switchAuthTab('register');
  $('#landing-register').onclick = () => showAuthForm('register');
  $('#landing-login').onclick = () => showAuthForm('login');
  // CTA seksi landing v5.1.0 (peta/front/penutup butuh login → buka daftar).
  const goRegister = () => showAuthForm('register');
  const goLogin = () => showAuthForm('login');
  const wire = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  wire('landing-world-btn', goRegister);
  wire('landing-front-all', goRegister);
  wire('landing-closing-register', goRegister);
  wire('landing-closing-login', goLogin);
  $('#auth-back').onclick = showLanding;
  // Versi game + angka/kabar dunia untuk landing (endpoint publik, tanpa login).
  api('/api/world').then((w) => { setVersion(w.version); renderLandingWorld(w); }).catch(() => {});
  // Link referral ?ref=CODE: isi otomatis field kode dan buka tab DAFTAR.
  const refParam = new URLSearchParams(location.search).get('ref');
  if (refParam) {
    const refInput = $('#form-register input[name="ref"]');
    if (refInput) refInput.value = refParam.trim().toUpperCase().slice(0, 8);
    showAuthForm('register');
  } else {
    showLanding();
  }
  $('#form-login').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const err = $('#login-error');
    err.hidden = true;
    try {
      await post('/api/auth/login', { email: String(fd.get('email') || '').trim(), password: String(fd.get('password') || '') });
      showApp();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
  $('#form-register').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const err = $('#register-error');
    err.hidden = true;
    try {
      await post('/api/auth/register', {
        email: String(fd.get('email') || '').trim(), password: String(fd.get('password') || ''),
        username: String(fd.get('username') || '').trim(), ref: String(fd.get('ref') || '').trim() || undefined,
        admin_code: String(fd.get('admin_code') || '').trim() || undefined,
      });
      toast('Selamat datang! Dunia ini masih terpecah — dirikan negaramu sendiri.');
      // Konversi Google Ads (v5.3.0): 'Pendaftaran' (send_to
      // AW-18546219743/qsZPCIw7.8AdEN-1w4tF) HANYA saat registrasi baru
      // berhasil — login biasa tidak memanggil ini. BUKAN event 'sign_up'
      // polos: action-nya sudah dibuat pemilik dan punya label sendiri.
      firePendaftaranConversion();
      showApp();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
  // Lupa Password (v5.5.0): tanpa layanan email — pemain minta reset,
  // cek status persetujuan admin, lalu masuk sekali pakai.
  $('#link-forgot').onclick = () => switchAuthTab('forgot');
  $('#link-back-login').onclick = () => switchAuthTab('login');
  const forgotEmail = () => String(new FormData($('#form-forgot')).get('email') || '').trim();
  $('#form-forgot').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#forgot-error'); const info = $('#forgot-info');
    err.hidden = true; info.hidden = true;
    try {
      const d = await post('/api/auth/forgot-password', { email: forgotEmail(), note: String(new FormData($('#form-forgot')).get('note') || '').trim() || undefined });
      info.textContent = d.message || 'Permintaan dicatat.';
      info.hidden = false;
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
  $('#btn-forgot-check').onclick = async () => {
    const err = $('#forgot-error'); const info = $('#forgot-info'); const btn = $('#btn-reset-login');
    err.hidden = true; info.hidden = true; btn.hidden = true;
    const email = forgotEmail();
    if (!email) { err.textContent = 'Isi email akunmu dulu.'; err.hidden = false; return; }
    try {
      const d = await api('/api/auth/forgot-password/status?email=' + encodeURIComponent(email));
      if (d.approved) {
        info.textContent = 'Admin sudah menyetujui! Ketuk tombol di bawah untuk masuk dan buat password baru. Tombol ini sekali pakai dan berlaku 3 hari.';
        info.hidden = false; btn.hidden = false;
      } else {
        info.textContent = 'Belum disetujui admin, atau belum ada permintaan untuk email ini. Cek lagi nanti.';
        info.hidden = false;
      }
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
  $('#btn-reset-login').onclick = async () => {
    const err = $('#forgot-error');
    err.hidden = true;
    try {
      await post('/api/auth/reset-login', { email: forgotEmail() });
      await showApp();
      location.hash = '#/reset-password';
      route();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
}
function switchAuthTab(which) {
  $('#tab-login').classList.toggle('active', which === 'login');
  $('#tab-register').classList.toggle('active', which === 'register');
  $('#form-login').hidden = which !== 'login';
  $('#form-register').hidden = which !== 'register';
  $('#form-forgot').hidden = which !== 'forgot';
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
    ['ads', 'Nonton Iklan', '🎬'], ['share', 'Bagikan Link', '🔗'],
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
    ['military', 'Militer', '⚔️'], ['war', 'Perang Tanah Air', '🛡️'], ['war-world', 'Perang Dunia', '🔥'],
  ]},
  { group: 'BANTUAN', items: [
    ['help', 'Meja Bantuan', '🎧'], ['contact', 'Kontak', '✉️'],
    ['book', 'Buku', '📖'], ['shop', 'Toko', '💎'],
  ]},
];

// Bottom navigation HP (saran pemain ricky.s888 via Threads, 27 Nov 2026):
// menu utama di bawah layar ala Rival Regions, menggantikan keharusan
// membuka drawer geser kiri. 5 tab utama + tombol Menu yang membuka drawer
// yang sudah ada untuk semua bagian lain. [slug, label, ikon]
const BOTTOM_NAV = [
  ['dashboard', 'Dashboard', '▦'],
  ['jobs', 'Pekerjaan', '💼'],
  ['market', 'Pasar', '🏪'],
  ['chat', 'Obrolan', '💬'],
  ['profile', 'Profil', '👤'],
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
  // Bottom navigation HP: 5 tab utama + tombol Menu (buka drawer).
  const bn = $('#bottom-nav');
  if (bn) {
    bn.innerHTML = BOTTOM_NAV.map(([slug, label, ico]) => `
      <button class="bottom-nav-item" data-route="${slug}" type="button" aria-label="${label}">
        <span class="bn-ico" aria-hidden="true">${ico}</span><span class="bn-label">${label}</span>
      </button>`).join('') + `
      <button class="bottom-nav-item" id="bottom-nav-menu" type="button" aria-label="Menu">
        <span class="bn-ico" aria-hidden="true">☰</span><span class="bn-label">Menu</span>
      </button>`;
    $$('#bottom-nav .bottom-nav-item[data-route]').forEach((b) => {
      b.onclick = () => { location.hash = '#/' + b.dataset.route; };
    });
    $('#bottom-nav-menu').onclick = openDrawer;
  }
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
  maybeShowTutorial();
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
  // Versi game di footer drawer (dari /api/me → konstanta VERSION).
  setVersion(ME.version);
  const c = ME.citizen;
  $('#hud-name').textContent = c.username + (c.isPremium ? ' ◆' : '');
  $('#hud-region').textContent = (ME.region?.name || '') + ' · ' + (ME.region?.country_name || ME.country?.name || 'Belum Bernegara');
  $('#hud-usd').textContent = fmtRp(c.usd);
  $('#hud-gold').textContent = fmt(c.gold);
  // Perisai HUD (UI batch 2): angka BESAR di dalam perisai = LEVEL warga;
  // lencana kecil di bawahnya = progres XP. Avatar bulat di kiri (kolom
  // .hud-side): foto profil bila ada, huruf awal bila tidak.
  $('#hud-lv').textContent = c.level;
  $('#hud-xp').textContent = c.xp + '/' + ME.xpNext;
  const av = $('#hud-avatar');
  if (av) av.innerHTML = avatarHtml(ME.user?.avatar, c.username, 44);
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
      // (v4.5.0, perbaikan offside): tanggal dipisah ke baris kedua —
      // dulu "· 2" menggantung di ujung baris pertama saat countdown
      // melipat di layar HP sempit.
      pcd.innerHTML = `<b>🏛️ Parlemen dibuka ${fmtCountdown(Number(ME.parliamentOpensAt) - Date.now())} lagi</b><br><span class="muted small">2 Des 2026</span>`;
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

// ---------- MODAL UNDANG TEMAN (UI batch 2) ----------
// Popup referral di dashboard + profil: kode/link (salin + WhatsApp) +
// penjelasan hadiah kedua sisi (pengundang +200 emas + 2 hari Premium;
// teman baru +100 emas + 1 hari Premium, cair saat Level 3).
function openReferralModal(code) {
  const refCode = code || ME?.referral?.code || '';
  const link = location.origin + '/?ref=' + refCode;
  $('#ref-modal-code').textContent = refCode || '—';
  $('#ref-modal-link').textContent = link;
  const m = $('#referral-modal');
  m.hidden = false;
  const close = () => { m.hidden = true; };
  $('#ref-modal-close').onclick = close;
  m.onclick = (e) => { if (e.target === m) close(); };
  $('#ref-modal-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast('Link referral disalin!'); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = link; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Link referral disalin!'); } catch { toast(link); }
      document.body.removeChild(ta);
    }
  };
  $('#ref-modal-wa').onclick = () => {
    const text = `Ayo main Parlementer bareng aku! Game simulasi negara online — kerja, dagang, bikin partai, sampai jadi presiden. 100% pemain asli, tanpa bot. Daftar lewat link ini: ${link}`;
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
  };
}

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
  let [slug, arg] = hash.split('/');
  // Lupa Password (v5.5.0): akun yang wajib ganti password dipaksa ke
  // halaman #/reset-password — bahkan saat banned (ganti password tidak
  // membuka akses main; ban tetap berlaku sampai dicabut admin/banding).
  if (ME?.user?.pw_reset_required && slug !== 'reset-password') slug = 'reset-password';
  // Akun banned: tampilkan pesan banned, bukan dashboard/game.
  // Layar banned bersih full-screen: HUD (header saldo/level, tombol chat,
  // lonceng, gear, bottom bar energi) disembunyikan lewat class 'banned'
  // di #app — lihat CSS. Di halaman ini pemain bisa mengajukan banding
  // dan membalas thread bandingnya.
  if (ME?.user?.is_banned && slug !== 'reset-password') {
    $('#app').classList.add('banned');
    renderBannedPage();
    return;
  }
  $('#app').classList.remove('banned');
  $$('#drawer-nav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.route === slug));
  // Bottom navigation HP: tab aktif mengikuti route yang sama.
  $$('#bottom-nav .bottom-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.route === slug));
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
    // Tutorial awal (v5.2.0): cek tiap pindah halaman — pemain baru yang
    // masuk lewat deep link (bukan dashboard) tetap melihat tutorial
    // begitu sampai di dashboard; di halaman lain tidak dibajak.
    maybeShowTutorial();
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
  const adsCfg = ME.ads || { enabled: false, propertyId: '', rewardGold: 30 };
  const fatigueMultNow = fatigue >= 15000 ? '0.5' : fatigue >= 10000 ? '0.75' : '1';
  // Negara di hero: warna/bendera negara HANYA ada kalau wilayah sudah
  // punya negara — tanpa negara, hero jadi kaca abu-abu + "?" (aturan
  // warna wilayah, pemilik 27 Nov 2026).
  const heroCountry = ME.region?.country_name || ME.country?.name || '';
  let kronikHidden = false;
  try { kronikHidden = localStorage.getItem('parlementer_kronik_hide') === '1'; } catch { /* abaikan */ }
  $('#page').innerHTML = page('DASHBOARD', `Hari ${ME.world.day} · Populasi dunia: ${fmt(ME.population)} warga · <span title="Pemain aktif dalam 5 menit terakhir">🟢 ${fmt(ME.onlineCount ?? 0)} online</span>`, `
  ${ME.activeWars.length ? `<div class="panel"><h3>⚔️ SEDANG TERJADI</h3>
    ${ME.activeWars.map((w) => `<div class="kv"><span class="k">${esc(w.name)}</span><span class="v">${fmt(w.score_a)} vs ${fmt(w.score_d)}</span></div>`).join('')}
    <button class="btn-gold btn-sm" data-goto="#/war">Lihat Perang</button></div>` : ''}
  ${ME.votingLaws.length ? `<div class="panel"><h3>🏛 UU SEDANG DIVOTING</h3>
    ${ME.votingLaws.map((l) => `<div class="kv"><span class="k">${esc(l.title)}</span><span class="v">${l.yes} Ya / ${l.abstain} / ${l.no} Tidak</span></div>`).join('')}
    <button class="btn-gold btn-sm" data-goto="#/parliament">Buka Parlemen</button></div>` : ''}
  ${ME.worldEvent ? `<div class="panel" id="dash-event"><h3>${esc(ME.worldEvent.icon)} EVENT DUNIA: ${esc(ME.worldEvent.name).toUpperCase()}</h3>
    <p class="muted small">${esc(ME.worldEvent.desc)}</p>
    <div class="kv"><span class="k">Efek minggu ini</span><span class="v gold-text">${esc(ME.worldEvent.effect)}</span></div></div>` : ''}
  ${ME.military ? `<div class="panel" id="dash-military">
    <div class="panel-head"><h3>⚔️ MILITER</h3><button class="btn-text gold" type="button" data-goto="#/military">KELOLA ›</button></div>
    <div class="kv"><span class="k">Kekuatan</span><span class="v">${ME.military.power} · Kerusakan perang ×${ME.military.mult}</span></div>
    <div class="kv"><span class="k">Pasukan</span><span class="v">${ME.military.count}/${ME.military.cap} unit · Perawatan ${fmtRp(ME.military.upkeep)}/hari</span></div></div>` : ''}
  <div class="panel">
    <div class="profile-hero ${heroCountry ? '' : 'free'}">
      ${heroCountry ? '' : '<span class="hero-q" aria-hidden="true">?</span>'}
      <a class="profile-hero-name" data-goto="#/profile" title="Lihat profilmu">${esc(c.username)}</a>
      <div class="profile-hero-sub">
        ${heroCountry ? `<span><span class="dot-red">■</span> ${esc(heroCountry)}</span>` : '<span><span class="dot-free">?</span> Belum Bernegara</span>'}
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
      <div class="stat-head"><span class="lbl">🌾 MAKANAN</span><span class="muted">Sisa roti hari ini ${(c.breadLimit || 10) - (c.bread_today || 0)}/${c.breadLimit || 10}</span></div>
      <div class="food-grid" id="dash-food" style="margin-top:10px"><p class="muted small">Memuat…</p></div>
      <p class="muted small" style="margin-top:8px">Ketuk kartu untuk makan. Batas ${c.breadLimit || 10} roti per hari.</p>
    </div>
    <div class="stat-block">
      <div class="stat-head"><span class="lbl">👛 DOMPET</span><button class="btn-text gold" type="button" data-goto="#/shop">TOP-UP ›</button></div>
      <div class="kv"><span class="k">Emas</span><span class="v gold-text">◈ ${fmt(c.gold)}</span></div>
      <div class="kv"><span class="k">Rupiah</span><span class="v">${fmtRp(c.usd)}</span></div>
    </div>
  </div>
  ${ME.credit ? `<div class="panel" id="dash-credit">
    <div class="panel-head"><h3>⭐ SKOR KREDIT</h3><span class="chip" style="color:${ME.credit.color}"><b>${ME.credit.score}/100 · ${esc(ME.credit.label)}</b></span></div>
    <p class="muted small">Skor turun −10 tiap ada laporan tentangmu yang terbukti benar. Pulih +1 setiap hari.</p>
    ${ME.credit.restrictions.length
      ? `<p class="small" style="color:#f85149">⛔ Saat ini dibatasi: ${ME.credit.restrictions.map((x) => `${esc(x.label)} (butuh ${x.min})`).join(' · ')}</p>`
      : '<p class="small" style="color:#3fb950">✅ Tidak ada batasan — semua fitur terbuka.</p>'}
    <p class="muted small">Batasan: pers &lt;80 · partai &lt;60 · pasar &lt;40 · chat &lt;20 · skor 0 = banned.</p>
  </div>` : ''}
  ${ME.job ? `<div class="panel" id="dash-shift">
    <div class="panel-head"><h3>💼 PEKERJAAN</h3><button class="btn-text gold" type="button" data-goto="#/jobs">LIHAT ›</button></div>
    <div class="kv"><span class="k">${esc(ME.job.title)} · ${esc(ME.job.company_name || 'ADMIN')}</span><span class="v gold-text">${payLabel(ME.job)}</span></div>
    <p class="muted small">Satu tekan memakai SEMUA energimu sekaligus — shift demi shift sampai habis.</p>
    ${doubleXpChip()}
    <button class="btn-gold" id="btn-dash-shift" type="button" ${c.energy <= 0 ? 'disabled' : ''}>KERJAKAN SEMUA ENERGI (${c.energy} ⚡)</button>
  </div>` : ''}
  <div class="panel" id="dash-ads">
    <div class="panel-head"><h3>🎬 NONTON IKLAN</h3><button class="btn-text gold" type="button" data-goto="#/ads">BUKA ›</button></div>
    ${adsCfg.enabled
      ? `<p class="muted small">Tonton iklan sampai selesai, dapat +${adsCfg.rewardGold} emas per iklan — tanpa batas harian.</p>
    <button class="btn-gold" type="button" data-goto="#/ads">▶ TONTON IKLAN (+${adsCfg.rewardGold} EMAS)</button>`
      : `<p class="muted small">Segera hadir — menu nonton iklan sedang disiapkan, menunggu aktivasi dari admin.</p>
    <button class="btn-gold" type="button" data-goto="#/ads">LIHAT MENU ›</button>`}
    ${adsCfg.banner?.enabled ? `<p class="muted small">📺 Atau lihat banner iklan: +${adsCfg.banner.rewardGold} emas per tampilan (maks ${adsCfg.banner.dailyCap}×/hari).</p>` : ''}
  </div>
  <div class="panel" id="dash-share">
    <div class="panel-head"><h3>🔗 BAGIKAN LINK</h3><button class="btn-text gold" type="button" data-goto="#/share">BUKA ›</button></div>
    <p class="muted small">Bagikan link pribadimu ke siapa pun — tiap klik unik dapat +10 emas (maks 200 emas/hari). Tanpa perlu login untuk yang mengklik.</p>
    <button class="btn-gold" type="button" data-goto="#/share">SALIN LINK ›</button>
  </div>
  <div class="panel" id="dash-map">
    <div class="panel-head"><h3>🗺️ PETA LANGSUNG</h3><button class="btn-text gold" type="button" data-goto="#/map">BUKA PETA ›</button></div>
    <div class="map-tiles" id="dash-map-tiles"><p class="muted small">Memuat…</p></div>
  </div>
  <div class="panel" id="dash-numbers">
    <h3>🌍 DUNIA HARI INI</h3>
    <div class="stat-grid" id="dash-numbers-grid"><div class="stat-cell"><div class="stat-label">Memuat…</div><div class="stat-num">—</div></div></div>
  </div>
  <div class="panel" id="dash-region">
    <h3>📍 WILAYAHKU</h3>
    <div id="dash-region-body"><p class="muted small">Memuat…</p></div>
  </div>
  <div class="panel" id="dash-inv">
    <h3>📦 INVENTARIS</h3>
    <div class="inv-grid" id="dash-inv-grid"><p class="muted small">Memuat…</p></div>
    <p class="muted small" style="margin-top:8px">Sisa roti hari ini: ${(c.breadLimit || 10) - (c.bread_today || 0)}/${c.breadLimit || 10} · <button class="btn-text gold" type="button" data-goto="#/inventory" style="padding:0">Lihat Semua ›</button></p>
  </div>
  <div class="panel" id="dash-convoy">
    <div class="panel-head"><h3>🚚 KONVOI</h3><button class="btn-text gold" type="button" data-goto="#/convoy">KELOLA ›</button></div>
    <div id="dash-convoy-body"><p class="muted small">Memuat…</p></div>
  </div>
  <div class="panel">
    <h3>💪 LATIHAN</h3>
    ${[['str', 'strength', 'Kekuatan', c.attr_str, 'Kerusakan perang'], ['edu', 'strategy', 'Pendidikan', c.attr_edu, 'Latihan lebih cepat (−5% jeda/level, maks −50%)'], ['eco', 'charisma', 'Ekonomi', c.attr_eco, 'Gaji shift lebih besar (+3%/level)']].map(([k, serverKey, label, lv, desc]) => {
      // Jeda latihan (2 menit × level, dikurangi Pendidikan): tombol
      // nonaktif + hitung mundur selagi atribut ini jeda; atribut lain
      // tetap bisa dilatih.
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
    <p class="muted" style="margin-top:12px">Ajak temanmu jadi warga — kamu dapat +200 emas + 2 hari Premium saat dia mencapai Level 3.</p>
    <button class="btn-gold" id="btn-invite" type="button">👥 UNDANG TEMAN</button>
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
  // Tombol UNDANG TEMAN (UI batch 2): buka popup referral.
  $('#btn-invite')?.addEventListener('click', () => openReferralModal());
  // Tombol SHIFT di dashboard (permintaan LIO): kerja tanpa masuk halaman
  // Pekerjaan dulu — handler sama dengan halaman Pekerjaan (doShift).
  $('#btn-dash-shift')?.addEventListener('click', doShift);
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
    // INVENTARIS (tiket #18 LIO, v3.1.0): SEMUA barang + jumlahnya di panel
    // dashboard (dulu hanya kartu T1 maks 6 — senjata/roti/bahan lain
    // tidak kelihatan). Daftar lengkap tetap ada di #/inventory.
    const invEl = $('#dash-inv-grid');
    if (invEl) {
      invEl.innerHTML = inv.items.length ? inv.items.map((i) => `<div class="inv-card"><div class="nm">${esc(i.name)}</div><div class="qty">×${i.qty}</div><div class="muted small">T${i.tier}</div></div>`).join('') : '<p class="muted">Inventaris kosong.</p>';
    }
  }).catch(() => { const el = $('#dash-food'); if (el) el.innerHTML = `<p class="muted">Gagal memuat makanan.</p>`; });
  // Panel UI batch 2 (angka dunia + kartu wilayah + PETA LANGSUNG + konvoi):
  // masing-masing diisi paralel; gagal satu tidak menggagalkan yang lain.
  const fillStats = api('/api/stats').then((s) => {
    const g = $('#dash-numbers-grid');
    if (g) {
      const w = s.world;
      g.innerHTML = `
      <div class="stat-cell"><div class="stat-label">👥 Populasi Dunia</div><div class="stat-num">${fmt(w.population)}</div><div class="stat-sub">Hari ${ME.world.day}</div></div>
      <div class="stat-cell"><div class="stat-label">🏳️ Negara</div><div class="stat-num">${fmt(w.countries)}</div><div class="stat-sub">${fmt(w.freeRegions)} wilayah belum bernegara</div></div>
      <div class="stat-cell"><div class="stat-label">🗺️ Wilayah</div><div class="stat-num">${fmt(w.regions)}</div><div class="stat-sub">${fmt(s.myRegion.population)} warga di wilayahku</div></div>
      <div class="stat-cell"><div class="stat-label">🟢 Online</div><div class="stat-num">${fmt(ME.onlineCount ?? 0)}</div><div class="stat-sub">aktif 5 menit terakhir</div></div>`;
    }
    const rb = $('#dash-region-body');
    if (rb) {
      const r = s.myRegion;
      // Aturan warna wilayah (pemilik, 27 Nov 2026): kartu wilayah tanpa
      // negara = kaca abu-abu + "?" — sama seperti ubin PETA LANGSUNG.
      document.querySelector('#dash-region')?.classList.toggle('free', !r.country_name);
      const infra = [['Kesehatan', r.health], ['Pendidikan', r.education], ['Militer', r.military], ['Industri', r.industry], ['Listrik', r.electricity]];
      const cost = r.name === 'Jakarta' ? 100 : 50;
      rb.innerHTML = `
      ${r.country_name ? '' : '<span class="region-q" aria-hidden="true">?</span>'}
      <p class="lbl-gold" style="margin:0">DITEMPATKAN DI</p>
      <h4 style="font-size:22px">${esc(r.name)}</h4>
      ${ME.travel ? `<p class="teal-text small">✈️ Dalam perjalanan ke ${esc(ME.travel.toRegionName)} — tiba ${fmtCountdown(ME.travel.remainingMs)} lagi.</p>` : ''}
      <p class="muted">${r.country_name ? '🏳️ ' + esc(r.country_name) : '🕊️ Belum Bernegara'}</p>
      <div class="kv"><span class="k">Skor Kota</span><span class="v"><span class="region-score">${r.city_score}<small>/10</small></span></span></div>
      <div class="kv"><span class="k">Peringkat</span><span class="v">${r.rank}/17 wilayah</span></div>
      ${infra.map(([label, v]) => `<div class="infra-row"><span class="lbl">${label}</span><span class="bar"><i style="width:${Math.min(100, (Number(v) / 10) * 100)}%"></i></span><span class="val">${v}</span></div>`).join('')}
      <div class="kv"><span class="k">Kapasitas Wilayah</span><span class="v">${r.capacity}% ${Number(r.capacity) >= 100 ? 'SEHAT' : ''}</span></div>
      ${r.resource_bonus ? `<div class="kv"><span class="k">Bonus Perintis</span><span class="v"><span class="chip teal">${esc(r.resource_bonus)}</span></span></div>` : ''}
      <div class="kv"><span class="k">Pemberontakan</span><span class="v">${r.rebellion}/5 pendukung</span></div>
      ${r.warActive ? '<p class="red-text small">⚔️ Perang sedang berlangsung di wilayah ini.</p>'
        : r.mySupport ? '<p class="teal-text small">✓ Kamu sudah mendukung pemberontakan di sini.</p>'
        : `<button class="btn-gold btn-sm" id="btn-dash-rebel" type="button">DUKUNG PEMBERONTAKAN · ${cost} emas hangus</button>`}`;
      $('#btn-dash-rebel')?.addEventListener('click', async () => {
        try { const res = await post('/api/regions/rebel', { region_id: r.id });
          toast(res.warStarted ? 'PERANG MELETUS! Pemberontakan dimulai!' : `Dukungan tercatat (${res.supporters}/5).`);
          await refreshMe(); route(); }
        catch (e) { toast(e.message); }
      });
    }
  }).catch(() => {
    const g = $('#dash-numbers-grid'); if (g) g.innerHTML = '<div class="stat-cell"><div class="stat-label">Gagal memuat</div><div class="stat-num">—</div></div>';
    const rb = $('#dash-region-body'); if (rb) rb.innerHTML = '<p class="muted">Gagal memuat kartu wilayah.</p>';
  });
  const fillMap = api('/api/regions').then((d) => {
    const el = $('#dash-map-tiles');
    if (!el) return;
    // Aturan peta (pemilik, 27 Nov 2026): wilayah yang BELUM jadi bagian
    // negara mana pun tampil sebagai KACA ABU-ABU dengan tanda "?" — bukan
    // warna negara (merah). Berlaku di ubin PETA LANGSUNG ini; peta besar
    // menyusul di batch lain.
    el.innerHTML = d.regions.map((r) => `
      <button class="map-tile ${r.id === d.mine ? 'mine' : ''} ${r.country_name ? '' : 'free'}" type="button" data-goto="#/regions/${r.id}" title="${esc(r.name)} — ${r.population} warga">
        ${r.country_name ? '' : '<span class="mt-q" aria-hidden="true">?</span>'}
        <span class="mt-name">${esc(r.name)}</span>
        <span class="mt-sub"><span class="mt-dot ${r.country_name ? '' : 'free'}"></span>${r.id === d.mine ? '<span class="you">📍 KAMU</span>' : esc(r.country_name || 'Belum Bernegara')}</span>
      </button>`).join('');
  }).catch(() => { const el = $('#dash-map-tiles'); if (el) el.innerHTML = '<p class="muted">Gagal memuat peta.</p>'; });
  const fillConvoy = api('/api/convoy').then((cv) => {
    const el = $('#dash-convoy-body');
    if (!el) return;
    el.innerHTML = `<div class="kv"><span class="k">Slot terpakai</span><span class="v">${cv.used}/${cv.slots} slot</span></div>` +
      (cv.convoys.length ? cv.convoys.map((x) => {
        const def = cv.buildings.find((b) => b.type === x.building);
        return `<div class="kv"><span class="k">${esc(def?.name || x.building)}</span><span class="v small muted">Berakhir ${fmtDate(x.expires_at)}</span></div>`;
      }).join('') : '<p class="muted">Belum ada bangunan. Konvoi berjalan kosong.</p>');
  }).catch(() => { const el = $('#dash-convoy-body'); if (el) el.innerHTML = '<p class="muted">Gagal memuat konvoi.</p>'; });
  await Promise.allSettled([fillMissions, fillChronicle, fillInventory, fillStats, fillMap, fillConvoy]);
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
    <p class="muted small">Sisa roti hari ini: ${(ME.citizen.breadLimit || 10) - ME.citizen.bread_today}/${ME.citizen.breadLimit || 10} · Ketuk kartu untuk makan.</p>
    <div class="food-grid" style="margin-top:10px">${[1, 2, 3, 4, 5].map((t) => {
      const q = foodQty(t);
      return `<button class="food-card ${q ? '' : 'empty'}" type="button" data-eat="${t}" ${q ? '' : 'disabled'} aria-label="Makan Makanan T${t}, tambah ${t * 10} energi">
        <span class="tier">T${t}</span><span class="val">⚡${t * 10}</span><span class="qty">×${q}</span>${q ? '<span class="eat">MAKAN</span>' : ''}</button>`;
    }).join('')}</div>
    ${foods.length ? '' : '<p class="muted" style="margin-top:8px">Tidak ada roti. Beli di Pasar.</p>'}
  </div>
  <div class="panel"><h3>🥤 MINUMAN ENERGI</h3>
    <p class="muted small">Sekali tekan minum sampai energi penuh (atau sampai kaleng habis) — bukan satu kaleng per tekan. Harga 0,10 emas/kaleng — beli di sini, langsung masuk inventaris.</p>
    <div class="kv"><span class="k">Kaleng yang kamu punya</span><span class="v"><b>×${(inv.items.find((i) => i.name === 'Minuman Energi' && i.tier === 1)?.qty || 0)}</b></span></div>
    <div class="kv"><span class="k">Energi sekarang</span><span class="v">${ME.citizen.energy}/${ME.citizen.energyCap || 100} ⚡</span></div>
    <div class="row">
      <label>JUMLAH BELI<input id="drink-buy-qty" type="number" value="10" min="1" max="100"></label>
      <button class="btn-gold" id="btn-drink-buy" type="button">BELI · 0,10 emas/kaleng</button>
      <button class="btn-gold" id="btn-drink" type="button" ${(inv.items.find((i) => i.name === 'Minuman Energi' && i.tier === 1)?.qty || 0) ? '' : 'disabled'}>MINUM SAMPAI PENUH</button>
    </div>
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
  $('#btn-drink-buy').onclick = async () => {
    try { const r = await post('/api/shop/energy-drink', { qty: Number($('#drink-buy-qty').value || 1) }); toast(`Membeli ${r.qty} kaleng Minuman Energi seharga ${r.cost} emas.`); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  };
  $('#btn-drink').onclick = async () => {
    try { const r = await post('/api/inventory/drink', {}); toast(`Energi +${r.gained} (sekarang ${r.energy}/${r.cap}). Sisa kaleng: ${r.remaining}.`); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  };
};

// ---------- KONVOI ----------
ROUTES.convoy = async () => {
  const cv = await api('/api/convoy');
  $('#page').innerHTML = page('KONVOI', `${cv.used}/${cv.slots} slot terpakai · tiap bangunan berdiri 7 hari lalu roboh`, `
  <div class="panel"><h3>🏗️ BANGUN KONVOI</h3>
    <p class="muted small">Satu bangunan per jenis dalam satu waktu. Biaya dibayar BAHAN MENTAH dari inventarismu (bukan emas lagi). Slot tambahan di Level 25 / 50 / 100 dan Premium.</p>
    ${cv.buildings.map((b) => {
      const recipe = (b.cost || []).map((it) => `${esc(it.name)} ${it.owned ?? 0}/${it.qty}`).join(' + ');
      const afford = (b.cost || []).every((it) => (it.owned ?? 0) >= it.qty);
      return `
      <div class="kv"><span class="k">${esc(b.name)}<br><small class="muted">${esc(b.desc)}</small><br><small class="${afford ? '' : 'muted'}" style="${afford ? 'color:#3fb950' : ''}">🧱 ${recipe}</small></span>
      <span class="v">${cv.convoys.some((x) => x.building === b.type) ? '✓ Dibangun' : `<button class="btn-gold btn-sm" data-build="${b.type}" ${afford ? '' : 'disabled'}>BANGUN</button>`}</span></div>`;
    }).join('')}
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
    // Tahap 3: bongkar konvoi itu destruktif (bonus hilang, bahan yang
    // sudah dibayar tidak kembali) — minta konfirmasi dulu.
    if (!confirm('Bongkar bangunan konvoi ini? Bonusnya hilang dan bahan yang sudah dibayar tidak kembali.')) return;
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
// Tab notifikasi (tiket #16 Vincent, v3.1.0): Terbaru | Sistem | Pasar —
// supaya tidak perlu scroll jauh. Pemetaan kategori: Pasar = EKONOMI
// (bonus perusahaan, pasar); Sistem = sisanya (SISTEM, ADMIN, POLITIK,
// PERANG, DIPLOMASI, SOSIAL). Tab aktif disimpan di memori selama sesi.
let notifTab = 'terbaru';
const NOTIF_TABS = [
  { key: 'terbaru', label: 'Terbaru', match: () => true },
  { key: 'sistem', label: 'Sistem', match: (x) => x.category !== 'EKONOMI' },
  { key: 'pasar', label: 'Pasar', match: (x) => x.category === 'EKONOMI' },
];
ROUTES.notifications = async () => {
  const [n, ann] = await Promise.all([api('/api/notifications'), api('/api/announcements')]);
  const renderNotifList = () => {
    const tab = NOTIF_TABS.find((t) => t.key === notifTab) || NOTIF_TABS[0];
    const list = n.notifications.filter(tab.match);
    const box = $('#notif-list');
    if (box) box.innerHTML = list.length ? list.map((x) => `
      <div class="kv"><span class="k">${x.category === 'SISTEM'
        ? '<span class="chip teal">⚙️ SISTEM</span>'
        : `<span class="chip">${esc(x.category)}</span>`} <b>${esc(x.title)}</b><br><small class="muted">${esc(x.content)}</small></span>
      <span class="v small muted" style="white-space:nowrap;flex-shrink:0">${ago(x.created_at)}</span></div>`).join('')
      : '<p class="muted">Belum ada notifikasi di tab ini.</p>';
    $$('#notif-tabs [data-ntab]').forEach((b) => b.classList.toggle('active', b.dataset.ntab === tab.key));
  };
  $('#page').innerHTML = page('NOTIFIKASI', '', `
  <div class="panel">
    <div class="panel-head"><h3>🔔 Pusat Notifikasi</h3><button class="btn-ghost btn-sm" id="btn-read-all">Tandai Semua Dibaca</button></div>
    <div class="tabs" id="notif-tabs">${NOTIF_TABS.map((t) => `<button class="tab ${t.key === notifTab ? 'active' : ''}" type="button" data-ntab="${t.key}">${t.label} (${n.notifications.filter(t.match).length})</button>`).join('')}</div>
    <div id="notif-list"></div>
  </div>
  <div class="panel" id="notif-announcements">
    <div class="panel-head"><h3>📣 APA YANG BARU</h3><span class="chip">Pengumuman update game</span></div>
    <p class="muted small">Ini PENGUMUMAN resmi update game dari admin — berbeda dari notifikasi pribadimu di atas (yang bertanda ⚙️ SISTEM itu pesan sistem untukmu, bukan pengumuman).</p>
    ${ann.announcements.length ? ann.announcements.map((a) => `
      <div class="${a.read ? '' : 'announce-unread'}" style="margin-bottom:14px">
        <div class="kv"><span class="k"><span class="chip">Update #${a.num}</span> <b>${esc(a.title)}</b><br><small class="muted">${fmtDate(a.created_at)}</small></span>
        <span class="v small" style="white-space:nowrap;flex-shrink:0">${a.read ? '<span class="muted">Dibaca</span>' : `<button class="btn-gold btn-sm" data-ann-read="${a.id}">Tandai Dibaca</button>`}</span></div>
        <p class="announce-body">${esc(a.body)}</p>
      </div>`).join('')
      : '<p class="muted">Belum ada pengumuman.</p>'}
  </div>`);
  renderNotifList();
  $$('#notif-tabs [data-ntab]').forEach((b) => b.onclick = () => { notifTab = b.dataset.ntab; renderNotifList(); });
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
  <div class="profile-hero ${pr.country_name ? '' : 'free'}">
    ${pr.country_name ? '' : '<span class="hero-q" aria-hidden="true">?</span>'}
    <div class="profile-hero-name">${esc(pr.username)}${pr.isPremium ? ' ◆' : ''}</div>
    <div class="profile-hero-sub">
      ${pr.country_name ? `<span><span class="dot-red">■</span> ${esc(pr.country_name)}</span>` : '<span><span class="dot-free">?</span> Belum Bernegara</span>'}
      <span><span class="muted">📍</span> ${esc(pr.region_name)}</span>
    </div>
  </div>
  <div class="panel">
    <div class="panel-head"><h3>👤 IDENTITAS</h3><span class="chip">LEVEL ${pr.level}</span></div>
    <div class="profile-avatar-row">
      <span id="profile-avatar">${profilePhotoHtml(pr.avatar, pr.username)}</span>
      ${pr.user_id === ME.citizen.user_id ? `
      <div>
        <input type="file" id="avatar-file" accept="image/*" hidden>
        <button class="btn-gold btn-sm" id="btn-avatar-change" type="button">📷 Ubah Foto</button>
        ${pr.avatar ? `<button class="btn-ghost btn-sm" id="btn-avatar-delete" type="button">🗑 Hapus Foto</button>` : ''}
        <div id="avatar-preview" style="margin-top:8px"></div>
        <p class="muted small">Foto menyesuaikan ukuran aslinya (sisi terpanjang maks 256px, maks 500 KB).</p>
      </div>` : ''}
    </div>
    <div class="kv"><span class="k">ID Pemain</span><span class="v"><b>${esc(pr.publicId)}</b></span></div>
    <div class="kv"><span class="k">Kewarganegaraan</span><span class="v">${esc(pr.country_name || 'Belum Bernegara')}</span></div>
    <div class="kv"><span class="k">Daerah asal</span><span class="v">${esc(pr.region_name)}</span></div>
    <div class="kv"><span class="k">Partai</span><span class="v">${pr.party ? esc(pr.party.name) + ' [' + esc(pr.party.tag) + ']' : '—'}</span></div>
    <div class="kv"><span class="k">Bergabung</span><span class="v">${fmtDate(pr.created_at)}</span></div>
    <div class="kv"><span class="k">Status</span><span class="v">${pr.online ? '<span class="online-badge">● Online</span>' : esc(pr.last_seen_label || (pr.last_seen_at ? 'Terakhir online ' + ago(pr.last_seen_at) : 'Belum pernah terlihat online'))}</span></div>
    <div class="kv"><span class="k">Skor Kredit</span><span class="v"><b style="color:${pr.credit?.color || '#3fb950'}">${pr.credit_score ?? 100}/100 · ${esc(pr.credit?.label || 'Baik')}</b></span></div>
    <div class="kv"><span class="k">Reputasi Dagang</span><span class="v"><b>${esc(pr.trade_reputation || 'Pedagang Baru')}</b> · ${fmt(pr.trades_completed || 0)} transaksi selesai</span></div>
    <div class="kv"><span class="k">Kekuatan Militer</span><span class="v">⚔️ ${pr.military_power ?? 0}</span></div>
    ${pr.bio ? `<p style="margin-top:10px">${esc(pr.bio)}</p>` : ''}
    ${pr.user_id === ME.citizen.user_id ? `<div style="margin-top:12px">
      <label class="small muted">BIOGRAFI (maks 1000 karakter)</label>
      <textarea id="profile-bio" rows="3" style="width:100%;margin-top:4px">${esc(pr.bio || '')}</textarea>
      <button class="btn-gold btn-sm" id="btn-save-profile-bio" type="button" style="margin-top:6px">Simpan Biografi</button>
    </div>` : ''}
  </div>
  ${pr.user_id !== ME.citizen.user_id ? `<button class="btn-gold" data-goto="#/messages/${pr.citizen_id}" type="button" style="margin-bottom:12px">💬 Chat dengan ${esc(pr.username)}</button>` : ''}
  ${pr.referral ? `<div class="panel"><h3>🔗 KODE REFERRAL</h3>
    <div class="kv"><span class="k">Kode referralmu</span><span class="v"><b>${esc(pr.referral.code)}</b> <button class="btn-gold btn-sm" id="btn-copy-ref" type="button">Salin</button></span></div>
    <div class="kv"><span class="k">Link ajakan</span><span class="v small">${esc(location.origin + '/?ref=' + pr.referral.code)}</span></div>
    <div class="kv"><span class="k">Orang yang memakai kodemu</span><span class="v">${pr.referral.uses} orang</span></div>
    <div class="kv"><span class="k">Emas dari referral</span><span class="v gold-text">+${fmt(pr.referral.goldEarned)} emas</span></div>
    <p class="muted small">Setiap warga baru yang memakai kodemu memberimu +200 emas + 2 hari Premium — dan dia mendapat +100 emas + 1 hari Premium.</p>
    <button class="btn-gold btn-sm" id="btn-invite-profile" type="button" style="margin-top:8px">👥 UNDANG TEMAN</button>
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
  // Tombol UNDANG TEMAN di panel referral profil (UI batch 2).
  const inviteBtn = $('#btn-invite-profile');
  if (inviteBtn && pr.referral) inviteBtn.onclick = () => openReferralModal(pr.referral.code);

  // Edit BIO langsung dari profil sendiri (saran Vincent, tiket #9) —
  // tanpa lewat Pengaturan. Simpan lalu muat ulang halaman profil.
  const bioSaveBtn = $('#btn-save-profile-bio');
  if (bioSaveBtn) bioSaveBtn.onclick = async () => {
    try { await post('/api/profile/bio', { bio: $('#profile-bio').value }); toast('Biografi disimpan.'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  };

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
      if (!processed || processed.error) {
        toast(imageErrorMessage(processed?.error));
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
// ---------- BUAT PASSWORD BARU (Lupa Password, v5.5.0) ----------
// Halaman ini HANYA untuk akun yang masuk lewat persetujuan reset
// (pw_reset_required = 1) — route() memaksa akun itu ke sini sampai
// password baru disimpan. Endpoint menolak bila flag tidak menyala.
ROUTES['reset-password'] = async () => {
  $('#page').innerHTML = page('🔑 BUAT PASSWORD BARU', 'Akunmu masuk lewat persetujuan reset password. Atur password barumu di sini — setelah ini kamu langsung bisa main.', `
  <div class="panel" style="max-width:520px;margin:0 auto">
    <form id="form-reset-password" class="auth-form">
      <label>PASSWORD BARU<input type="password" name="password" placeholder="Minimal 6 karakter" required minlength="6" autocomplete="new-password"></label>
      <label>ULANGI PASSWORD BARU<input type="password" name="password_confirm" placeholder="Ketik ulang password barumu" required minlength="6" autocomplete="new-password"></label>
      <div id="reset-error" class="auth-error" hidden></div>
      <button class="btn-gold big" type="submit">SIMPAN PASSWORD BARU</button>
      <button class="btn-text" id="btn-reset-logout" type="button">Bukan akunmu? Keluar</button>
    </form>
  </div>`);
  $('#form-reset-password').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const err = $('#reset-error');
    err.hidden = true;
    try {
      await post('/api/auth/reset-password', { password: String(fd.get('password') || ''), password_confirm: String(fd.get('password_confirm') || '') });
      toast('Password baru disimpan. Selamat datang kembali!');
      await refreshMe();
      location.hash = '#/dashboard';
      route();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
  $('#btn-reset-logout').onclick = logout;
};

ROUTES.settings = async () => {
  const c = ME.citizen;
  const blocked = await api('/api/chat/blocked').catch(() => ({ blocked: [] }));
  $('#page').innerHTML = page('PENGATURAN', '', `
  <div class="panel"><h3>📝 IDENTITAS</h3>
    <label>BIOGRAFI (maks 1000 karakter)<textarea id="set-bio" rows="3">${esc(c.bio || '')}</textarea></label>
    <button class="btn-gold" id="btn-save-bio">Simpan Biografi</button>
  </div>
  <div class="panel"><h3>🚫 PEMAIN YANG DIBLOKIR</h3>
    <p class="muted small">Pesan chat dari pemain di bawah ini tidak terlihat lagi. Ketuk "Buka Blokir" bila berubah pikiran.</p>
    ${blocked.blocked.length ? blocked.blocked.map((b) => `<div class="kv"><span class="k">${avatarHtml(b.avatar, b.username, 32)} ${esc(b.username)}</span>
      <span class="v"><button class="btn-ghost btn-sm" data-unblock="${b.citizen_id}" type="button">Buka Blokir</button></span></div>`).join('')
      : '<p class="muted">Belum ada pemain yang diblokir.</p>'}
  </div>
  <div class="panel"><h3>✏️ GANTI NAMA WARGA</h3>
    <p class="muted small">Biaya 50 emas. Nama 3–24 karakter (huruf, angka, underscore).</p>
    <div class="row"><input id="set-name" placeholder="Nama baru" style="flex:2"><button class="btn-gold" id="btn-rename">Ganti (50 emas)</button></div>
  </div>
  <div class="panel"><h3>🔊 SUARA</h3>
    <p class="muted small">Suara ketukan halus setiap kali menekan tombol. Preferensi tersimpan di perangkat ini.</p>
    <button class="btn-gold" id="btn-sound-toggle">${soundEnabled() ? '🔊 Suara: NYALA — ketuk untuk mematikan' : '🔇 Suara: MATI — ketuk untuk menyalakan'}</button>
  </div>
  <div class="panel"><h3>🎓 TUTORIAL AWAL</h3>
    <p class="muted small">Putar ulang tur pengenalan game untuk pemain baru.</p>
    <button class="btn-gold" type="button" data-replay-tutorial>▶ LIHAT TUTORIAL LAGI</button>
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
  $$('[data-unblock]').forEach((b) => b.onclick = async () => {
    try { await post('/api/chat/unblock', { citizen_id: Number(b.dataset.unblock) }); toast('Blokir dibuka.'); route(); }
    catch (e) { toast(e.message); }
  });
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
  $$('[data-replay-tutorial]').forEach((b) => { b.onclick = () => showTutorial(); });
};

// ---------- PANEL ADMIN ----------
ROUTES.admin = async (q) => {
  if (q === 'appeals') return renderAdminAppeals();
  if (q && q.startsWith('appeal-')) return renderAdminAppealDetail(Number(q.slice(7)));
  if (q === 'gift-all') return renderAdminGiftAll();
  if (q === 'announcements') return renderAdminAnnouncements();
  if (q === 'flags') return renderAdminFlags();
  if (q === 'share') return renderAdminShare();
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
    <button class="tab" data-goto="#/admin/share">🔗 Share Link</button>
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
    <div class="kv"><span class="k">Skor Kredit</span><span class="v"><b>${p.credit_score ?? 100}/100</b> <button class="btn-ghost btn-sm" data-act="credit-history" type="button">📉 Riwayat</button></span></div>
    <div class="credit-history-box"></div>
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
        if (act === 'credit-history') {
          const box = panel.querySelector('.credit-history-box');
          try {
            const d = await api('/api/admin/credit-history/' + uid);
            box.innerHTML = d.history.length
              ? `<p class="small" style="margin-top:8px"><b>📉 Riwayat skor kredit (skor kini ${d.credit_score})</b></p>` + d.history.map((h) => `<div class="kv"><span class="k">${esc(h.reason)}</span><span class="v">${h.delta > 0 ? '+' : ''}${h.delta} → ${h.score_after} · <small class="muted">${fmtDate(h.created_at)}</small></span></div>`).join('')
              : '<p class="muted small" style="margin-top:8px">Belum ada perubahan skor kredit.</p>';
          } catch (e) { toast(e.message); }
          return;
        }
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

// ---------- PANEL ADMIN: STATISTIK SHARE LINK (v4.6.0) ----------
// Read-only: siapa membagikan link, berapa klik terhitung, berapa emas
// didapat (hari ini + total). Data dari tabel klik yang SAMA dengan
// fitur share (GET /api/admin/share) — bukan hitungan terpisah.
async function renderAdminShare() {
  const data = await api('/api/admin/share');
  $('#page').innerHTML = page('🛡️ PANEL ADMIN', 'Statistik share link harian — read-only.', `
  <div class="tabs">
    <button class="tab" data-goto="#/admin">👥 Pemain</button>
    <button class="tab" data-goto="#/admin/appeals">📬 Banding</button>
    <button class="tab" data-goto="#/admin/gift-all">🎁 Hadiah Massal</button>
    <button class="tab" data-goto="#/admin/inbox">📥 Laporan &amp; Saran</button>
    <button class="tab" data-goto="#/admin/announcements">📣 Pengumuman</button>
    <button class="tab" data-goto="#/admin/flags">🚩 Tanda Pasar</button>
    <button class="tab active">🔗 Share Link</button>
  </div>
  <div class="panel"><h3>🔗 STATISTIK SHARE LINK (HARI INI ${esc(data.day)})</h3>
    <p class="muted small">Klik terhitung = klik unik (1 IP = 1 klik/hari/link) yang memberi +${fmt(data.perClick)} emas. Klik duplikat-IP / di luar kuota tetap tercatat di audit, tapi tidak menambah emas.</p>
    <div class="kv"><span class="k">Pemain yang membagikan</span><span class="v">${fmt(data.summary.players)}</span></div>
    <div class="kv"><span class="k">Klik terhitung hari ini</span><span class="v">${fmt(data.summary.clicksToday)}</span></div>
    <div class="kv"><span class="k">Emas dari share hari ini</span><span class="v gold-text">${fmt(data.summary.goldToday)} emas</span></div>
    <div class="kv"><span class="k">Klik terhitung (total)</span><span class="v">${fmt(data.summary.clicksTotal)}</span></div>
    <div class="kv"><span class="k">Emas dari share (total)</span><span class="v gold-text">${fmt(data.summary.goldTotal)} emas</span></div>
  </div>
  <div class="panel"><h3>📊 PER PEMAIN (URUT EMAS TERBANYAK)</h3>
    ${data.rows.length ? data.rows.map((r) => `
      <div class="kv"><span class="k">${esc(r.username)} <small class="muted">${esc(r.publicId)}</small><br><small class="muted">Hari ini: ${fmt(r.clicksToday)} klik · ${fmt(r.goldToday)} emas</small></span>
      <span class="v">Total: ${fmt(r.clicksTotal)} klik · <b class="gold-text">${fmt(r.goldTotal)} emas</b></span></div>`).join('')
      : '<p class="muted">Belum ada yang membagikan link.</p>'}
  </div>`);
}

// ---------- PANEL ADMIN: TAB BANDING ----------
async function renderAdminAnnouncements() {
  const data = await api('/api/admin/announcements');
  $('#page').innerHTML = page('🛡️ PANEL ADMIN', 'Pengumuman update untuk semua pemain.', `
  <div class="tabs">
    <button class="tab" data-goto="#/admin">👥 Pemain</button>
    <button class="tab active">📣 Pengumuman</button>
    <button class="tab" data-goto="#/admin/flags">🚩 Tanda Pasar</button>
    <button class="tab" data-goto="#/admin/share">🔗 Share Link</button>
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
  // Jumlah penerima/total dari COUNT server, BUKAN panjang daftar yang
  // terpotong LIMIT 100 (bug Khalid 28 Nov 2026: panel menampilkan
  // "99 dari 100" padahal populasi 216). Fallback ke panjang daftar bila
  // server lama belum mengirim total/eligible.
  const totalPlayers = typeof list.total === 'number' ? list.total : list.players.length;
  const recipientCount = typeof list.eligible === 'number' ? list.eligible : recipients.length;
  $('#page').innerHTML = page('🛡️ PANEL ADMIN', 'Hadiah untuk semua pemain sekaligus.', `
  <div class="tabs">
    <button class="tab" data-goto="#/admin">👥 Pemain</button>
    <button class="tab" data-goto="#/admin/appeals">📬 Banding${pending ? ` <span class="chip">${pending} menunggu</span>` : ''}</button>
    <button class="tab active">🎁 Hadiah Massal</button>
    <button class="tab" data-goto="#/admin/inbox">📥 Laporan &amp; Saran</button>
  </div>
  <div class="panel"><h3>🎁 HADIAH UNTUK SEMUA PEMAIN</h3>
    <p class="muted small">Hadiah dikirim ke <b>${recipientCount} pemain</b> yang tidak di-ban (dari ${totalPlayers} pemain total). Akun yang di-ban tidak menerima apa-apa. Semua penerima mendapat notifikasi "Hadiah dari admin".</p>
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
    <button class="btn-gold" id="btn-gift-all">🎁 KIRIM KE ${recipientCount} PEMAIN</button>
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
    if (!confirm(`Kirim hadiah ${label} ke ${recipientCount} pemain?`)) return;
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
  // Lupa Password (v5.5.0): permintaan reset ikut tampil di kotak masuk
  // ini (kind 'password_reset') — admin ACC/TOLAK dari sini. Pastikan
  // identitas peminta sebelum ACC: cocokkan nama warga + keterangan,
  // atau konfirmasi lewat WhatsApp/Discord bila ragu.
  const pendingResets = tickets.tickets.filter((t) => t.kind === 'password_reset' && t.resetStatus === 'menunggu').length;
  const resetChip = (s) => s === 'menunggu' ? '🆕 MENUNGGU' : s === 'disetujui' ? '✅ DISETUJUI' : s === 'ditolak' ? '❌ DITOLAK' : s === 'dipakai' ? '🔑 SUDAH DIPAKAI' : '⏰ KEDALUWARSA';
  const ticketCard = (t) => {
    if (t.kind === 'password_reset') return `
    <div class="panel" data-reset="${t.resetId}">
      <div class="panel-head"><h3>🔑 ${esc(t.type)} · ${esc(t.topic)}</h3><span class="chip">${resetChip(t.resetStatus)}</span></div>
      <div class="kv"><span class="k">Dari</span><span class="v">${esc(t.username)} · ${esc(t.publicId)} · ${esc(t.email)}</span></div>
      <div class="kv"><span class="k">Tanggal</span><span class="v">${fmtDate(t.created_at)}</span></div>
      <p style="margin-top:8px">${esc(t.details)}</p>
      <p class="muted small">Permintaan kedaluwarsa ${fmtDate(t.expires_at)} bila belum diputus. Sekali ACC, pemain bisa masuk sekali pakai dalam 3 hari — pastikan dulu ini memang akunnya.</p>
      ${t.resetStatus === 'menunggu' ? `<div class="row" style="margin-top:10px">
        <button class="btn-gold btn-sm" data-reset-decide="accept" type="button">✅ ACC — SETUJUI RESET</button>
        <button class="btn-danger btn-sm" data-reset-decide="reject" type="button">❌ TOLAK</button>
      </div>` : ''}
    </div>`;
    return `
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
    </div>`;
  };
  $('#page').innerHTML = page('🛡️ PANEL ADMIN', 'Saran & laporan bug dari pemain, plus laporan chat.', `
  <div class="tabs">
    <button class="tab" data-goto="#/admin">👥 Pemain</button>
    <button class="tab" data-goto="#/admin/appeals">📬 Banding${pending ? ` <span class="chip">${pending} menunggu</span>` : ''}</button>
    <button class="tab" data-goto="#/admin/gift-all">🎁 Hadiah Massal</button>
    <button class="tab active">📥 Laporan &amp; Saran</button>
  </div>
  <div class="panel"><h3>🎧 TIKET MEJA BANTUAN${pendingResets ? ` <span class="chip">${pendingResets} reset menunggu</span>` : ''}</h3>
    <div class="tabs">
      ${['', 'baru', 'dibaca', 'selesai'].map((s) => `<button class="tab ${statusFilter === s || (!statusFilter && s === '') ? 'active' : ''}" data-goto="#/admin/inbox${s ? '?status=' + s : ''}">${s === '' ? 'SEMUA' : s.toUpperCase()}</button>`).join('')}
    </div>
    ${tickets.tickets.length ? tickets.tickets.map(ticketCard).join('') : '<p class="muted">Belum ada tiket.</p>'}
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
        ? `<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
             <span class="small muted">Skor penulis: <b>${r.author_credit_score ?? '?'}</b></span>
             <button class="btn-gold btn-sm" data-report="${r.id}" data-verdict="proven" type="button">✅ TERBUKTI (−10)</button>
             <button class="btn-ghost btn-sm" data-report="${r.id}" data-verdict="not_proven" type="button">❌ TIDAK TERBUKTI</button>
           </div>`
        : `<span class="chip">✅ DITINJAU${r.verdict === 'proven' ? ' · TERBUKTI' : r.verdict === 'not_proven' ? ' · TIDAK TERBUKTI' : ''}</span>`}</span>
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
  // Lupa Password (v5.5.0): tombol ACC/TOLAK pada kartu permintaan reset.
  $$('#page [data-reset-decide]').forEach((btn) => {
    btn.onclick = async () => {
      const panel = btn.closest('[data-reset]');
      const rid = Number(panel.dataset.reset);
      try {
        await post('/api/admin/password-resets/' + rid + '/decide', { decision: btn.dataset.resetDecide });
        toast(btn.dataset.resetDecide === 'accept' ? 'Reset password disetujui — pemain bisa masuk sekali pakai.' : 'Permintaan reset password ditolak.');
        route();
      } catch (e) { toast(e.message); }
    };
  });
  $$('[data-report]').forEach((b) => b.onclick = async () => {
    try {
      const res = await post('/api/admin/reports/' + b.dataset.report + '/review', { verdict: b.dataset.verdict });
      if (b.dataset.verdict === 'proven') {
        toast(res.banned ? 'Laporan TERBUKTI — skor penulis mencapai 0, akun dibanned.' : `Laporan TERBUKTI — skor penulis kini ${res.newScore}.`);
      } else toast('Laporan ditandai TIDAK TERBUKTI — skor tidak berubah.');
      route();
    }
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
      <div class="stat-cell"><div class="stat-label">📋 Penawaran Terbuka</div><div class="stat-num">${fmt(data.stats.offers)}</div><div class="stat-sub">di ${data.commodities.length} komoditas</div></div>
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
      <p class="muted small">Pembeli memasang harga yang mereka mau. Punya barangnya? Jual langsung ke order mereka — pembeli membayar saat order dipenuhi (dikurangi pajak penghasilan sesuai UU yang berlaku ke kas negara).</p>
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
      <p class="muted small">Saldo baru dipotong saat ada penjual yang memenuhi order ini. Bila order dibatalkan, tidak ada dana yang berpindah.</p>
      <button class="btn-gold" id="btn-buy-order">PASANG ORDER BELI</button>
    </div>
    <div class="panel"><h3>🧾 ORDER BELIKU</h3>
      ${data.myBuyOrders.length ? data.myBuyOrders.map((o) => `<div class="kv"><span class="k">${esc(o.commodity_name)} T${o.tier} · ${o.qty_filled}/${o.qty} terpenuhi · ${money(o.price)}</span>
        <span class="v"><button class="btn-ghost btn-sm" data-edit-order="${o.id}">✏️ Ubah</button> <button class="btn-danger btn-sm" data-cancel-order="${o.id}">Batalkan</button></span></div>
        <div class="edit-box" id="edit-order-${o.id}" hidden></div>`).join('')
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
        <span class="v"><button class="btn-ghost btn-sm" data-edit-offer="${o.id}">✏️ Ubah</button> <button class="btn-danger btn-sm" data-cancel="${o.id}">Batalkan</button></span></div>
        <div class="edit-box" id="edit-offer-${o.id}" hidden></div>`).join('')
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
              <div class="offer-seller"><span class="avatar-initial" style="width:20px;height:20px;font-size:11px">${esc((o.seller[0] || '?').toUpperCase())}</span> ${sellerTag}${esc(o.seller)}${o.seller_reputation ? ` · <span class="muted small">⭐ ${esc(o.seller_reputation)}</span>` : ''}</div>
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
        toast('Order beli dipasang.');
        await refreshMe(); route();
      } catch (e) { toast(e.message); }
    };
    $$('[data-cancel-order]').forEach((b) => b.onclick = async () => {
      // Batal itu destruktif (order hilang).
      if (!confirm('Batalkan order beli ini?')) return;
      try {
        await post('/api/market/buy-order/cancel', { order_id: Number(b.dataset.cancelOrder) });
        toast('Order dibatalkan.');
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
    // UBAH PENAWARAN / ORDER BELI (tiket #23 LIO, v3.1.0): form inline di
    // bawah baris — ubah jumlah (tambah bahan tanpa batalkan dulu) dan/atau
    // harga, lalu simpan. Jumlah penawaran naik -> selisih diambil dari
    // inventaris; turun -> selisih kembali ke inventaris.
    const openEditBox = (box, currentQty, currentPrice, onSave) => {
      box.hidden = false;
      box.innerHTML = `<div class="row" style="margin-top:6px">
        <label>JUMLAH (min 10)<input type="number" class="edit-qty" value="${currentQty}" min="10"></label>
        <label>HARGA / UNIT (${curLabel})<input type="number" class="edit-price" step="0.01" value="${currentPrice}"></label>
        <span style="display:flex;gap:6px;align-items:flex-end"><button class="btn-gold btn-sm edit-save" type="button">Simpan</button>
        <button class="btn-ghost btn-sm edit-cancel" type="button">Batal</button></span></div>`;
      box.querySelector('.edit-cancel').onclick = () => { box.hidden = true; box.innerHTML = ''; };
      box.querySelector('.edit-save').onclick = async () => {
        try {
          await onSave(Number(box.querySelector('.edit-qty').value), priceInputUsd(box.querySelector('.edit-price')));
          toast('Penawaran diubah.');
          await refreshMe(); route();
        } catch (e) { toast(e.message); }
      };
    };
    $$('[data-edit-offer]').forEach((b) => b.onclick = () => {
      const o = data.mine.find((x) => x.id === Number(b.dataset.editOffer));
      if (!o) return;
      // Harga tersimpan dalam mata uang ruangannya (lokal = USD, tampil
      // Rupiah; global = emas) — isi form dengan nilai TAMPIL, bukan USD
      // mentah, supaya konsisten dengan form jual (priceInputUsd).
      const displayPrice = scope === 'global' ? o.price : Math.round(o.price * RP_PER_USD);
      openEditBox($('#edit-offer-' + o.id), o.qty, displayPrice, (qty, price) => patch('/api/market/offers/' + o.id, { qty, price }));
    });
    $$('[data-edit-order]').forEach((b) => b.onclick = () => {
      const o = data.myBuyOrders.find((x) => x.id === Number(b.dataset.editOrder));
      if (!o) return;
      const displayPrice = scope === 'global' ? o.price : Math.round(o.price * RP_PER_USD);
      openEditBox($('#edit-order-' + o.id), o.qty, displayPrice, (qty, price) => patch('/api/market/buy-orders/' + o.id, { qty, price }));
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

// Shift dari mana saja (halaman Pekerjaan + dashboard): satu handler yang
// sama — POST /api/jobs/shift lalu segarkan data + halaman. Pesan toast
// memakai note server (sudah berisi info energi + hadiah bila shift
// sebagian); gaji tetap hanya perlu net/pajak.
async function doShift() {
  try {
    const r = await post('/api/jobs/shift');
    // Konversi Google Ads (v5.3.0): 'mulai_bermain' tepat sekali, saat
    // shift PERTAMA selesai (server menandai firstShift).
    if (r.firstShift) fireConversionEvent('mulai_bermain');
    const xpNote = r.xpGained ? ` +${r.xpGained} XP${r.doubleXp ? ' (×2 jam ganda!)' : ''}` : '';
    toast(r.goods ? `Shift selesai! ${r.note}${xpNote}` : `Shift selesai!${r.note ? ' ' + r.note : ''} Gaji bersih ${fmtRp(r.net)} (pajak ${fmtRp(r.tax)}).${xpNote}`);
    await refreshMe(); route();
  } catch (e) { toast(e.message); }
}

// ---------- PEKERJAAN ----------
ROUTES.jobs = async () => {
  const data = await api('/api/jobs');
  const myJob = ME.job ? (data.jobs.find((j) => j.id === ME.job.id) || ME.job) : null;
  // Pisahkan lowongan menurut lokasi pemain (28 Nov 2026): yang tampil
  // default HANYA yang ada di wilayah pemain saat ini. Lowongan wilayah
  // lain disembunyikan di balik tombol (bukan daftar panjang semua pabrik)
  // dan TIDAK punya tombol LAMAR — tombolnya mengarah ke detail wilayah
  // (di sana ada tombol travel), jadi tidak ada lagi klik yang berujung
  // error 400 "tidak berada di wilayah ini".
  const myRegionId = ME.citizen.region_id;
  const myRegionName = ME.region?.name || '';
  // Gabungkan lowongan IDENTIK menjadi satu kartu (v5.0.1, laporan
  // Vincent): satu perusahaan yang membuka banyak lowongan dengan judul +
  // gaji + jenis + wilayah + syarat sama (mis. 9 duplikat "Kerja" sisa
  // exploit gaji yang sudah di-clamp $100rb) tampil sebagai kartu-kartu
  // kembar yang membingungkan. Satu grup = satu kartu dengan kursi
  // gabungan; tombol LAMAR memakai lowongan pertama yang masih punya kursi
  // kosong. Tanpa duplikat, pengelompokan ini identitas (1 baris = 1 kartu).
  const groupJobs = (list) => {
    const groups = [];
    const byKey = new Map();
    for (const j of list) {
      const key = [j.company_id ?? '', j.title, j.salary, j.salary_type, j.region_id, j.level_min, j.tier, j.is_admin ? 1 : 0].join('|');
      let g = byKey.get(key);
      if (!g) { g = { job: j, rows: [], seats: 0, workers: 0 }; byKey.set(key, g); groups.push(g); }
      g.rows.push(j);
      g.seats += j.is_admin ? 0 : (j.seats || 0);
      g.workers += j.workers || 0;
    }
    return groups;
  };
  const localJobs = groupJobs(data.jobs.filter((j) => j.region_id === myRegionId));
  const otherJobs = groupJobs(data.jobs.filter((j) => j.region_id !== myRegionId));
  const jobCard = (g, local) => {
    const j = g.job;
    const inGroup = ME.citizen.job_id && g.rows.some((r) => r.id === ME.citizen.job_id);
    const applyRow = g.rows.find((r) => r.is_admin || (r.seats_taken || 0) < (r.seats || 0));
    return `
      <div class="card" data-job-region="${j.region_id}" data-group-size="${g.rows.length}">
        <h4>${esc(j.title)} ${j.is_admin ? '<span class="chip">ADMIN</span>' : ''}</h4>
        <p class="muted small">${esc(j.company_name || 'Pemerintah')} · ${esc(j.region_name)} · Level ${j.level_min}+ · ${j.is_admin ? 'Tanpa batas kursi' : `${g.workers}/${g.seats} kursi`}</p>
        ${g.rows.length > 1 ? `<p class="muted small">📋 ${g.rows.length} lowongan serupa digabung — kursi dijumlahkan.</p>` : ''}
        <p class="small">${esc(j.description || '')}</p>
        <div class="kv"><span class="k">${j.salary_type === 'goods' ? 'Upah (bahan mentah)' : j.salary_type === 'share' ? 'Bagi hasil' : 'Gaji tetap'}</span><span class="v gold-text">${payLabel(j)}</span></div>
        ${j.salary_type === 'goods' ? `<p class="muted small">Setara ~${fmtRp(j.salary)} / shift · jual bahannya di pasar untuk uang.</p>` : ''}
        ${local
          ? inGroup
            ? `<button class="btn-gold btn-sm" disabled>✓ Pekerjaanmu</button>`
            : applyRow
              ? `<button class="btn-gold btn-sm" data-apply="${applyRow.id}">LAMAR</button>`
              : `<button class="btn-gold btn-sm" disabled>Penuh</button>`
          : `<p class="muted small">📍 Di ${esc(j.region_name)} — kamu harus berada di sana untuk melamar.</p>
        <button class="btn-gold btn-sm" data-goto="#/regions/${j.region_id}">✈️ LIHAT WILAYAH</button>`}
      </div>`;
  };
  $('#page').innerHTML = page('KANTOR KETENAGAKERJAAN', 'Lowongan resmi ADMIN tersedia sebagai modal awal. Perusahaan warga juga bisa membuka lowongan.', `
  <div class="stat-grid">
    <div class="stat-cell"><div class="stat-label">📋 Lowongan di Wilayahmu</div><div class="stat-num">${fmt(localJobs.length)}</div><div class="stat-sub">di ${esc(myRegionName)} · ${fmt(localJobs.length + otherJobs.length)} di seluruh negeri (lowongan serupa digabung)</div></div>
    <div class="stat-cell"><div class="stat-label">💺 Kursi Kosong</div><div class="stat-num">${fmt(data.stats.seats || 0)}</div><div class="stat-sub">siap diisi</div></div>
    <div class="stat-cell"><div class="stat-label">💰 Nilai Terbaik</div><div class="stat-num gold">${fmt(data.stats.best || 0)}</div><div class="stat-sub">nilai setara / shift</div></div>
    <div class="stat-cell"><div class="stat-label">🧑‍💼 Posisi Saat Ini</div><div class="stat-num" style="font-size:20px">${myJob ? esc(myJob.title) : 'Belum bekerja'}</div><div class="stat-sub">${myJob ? esc(myJob.company_name || 'ADMIN') : 'Lamar lowongan di bawah'}</div></div>
  </div>
  ${myJob ? `<div class="panel"><h3>💼 PEKERJAANMU</h3>
    <div class="kv"><span class="k">${esc(myJob.title)} · ${esc(myJob.company_name || 'ADMIN')}</span><span class="v">${payLabel(myJob)}</span></div>
    <p class="muted small">Satu tekan memakai SEMUA energimu sekaligus — shift demi shift sampai habis (140 energi → shift 100 + shift 40 dalam satu aksi). Hadiah DAN XP sebanding dengan energi yang dipakai (50 energi → ~50% hadiah + 10 XP; 1 energi pun tetap dapat 1 XP). ${myJob.salary_type === 'goods' ? 'Lowongan ADMIN dibayar bahan mentah, tanpa pajak.' : myJob.salary_type === 'share' ? 'Dibayar dalam bentuk barang (bagi hasil).' : 'Gaji dipotong pajak penghasilan (tarif sesuai UU yang berlaku).'}</p>
    ${doubleXpChip()}
    <div class="row"><button class="btn-gold" id="btn-shift" ${ME.citizen.energy <= 0 ? 'disabled' : ''}>KERJAKAN SEMUA ENERGI (${ME.citizen.energy} ⚡)</button>
    <button class="btn-ghost" id="btn-quit">Berhenti Kerja</button></div>
    ${autoWorkBlock()}</div>` : `${doubleXpChip()}`}
  <div class="panel"><h3>📍 DI WILAYAHMU${myRegionName ? ' — ' + esc(myRegionName.toUpperCase()) : ''}</h3>
    ${data.adminPayMult && data.adminPayMult !== 1 ? `<p class="muted small">Upah ADMIN saat ini ${Math.round(data.adminPayMult * 100)}% dari upah dasar (UU yang berlaku).</p>` : ''}
    ${localJobs.length ? `<div id="jobs-local-list">${localJobs.map((j) => jobCard(j, true)).join('')}</div>` : emptyState('💼', 'Belum ada lowongan di wilayahmu', 'Lowongan ADMIN dan perusahaan warga akan muncul di sini.')}
  </div>
  <div class="panel"><h3>🌍 WILAYAH LAIN</h3>
    <p class="muted small">Lowongan di luar wilayahmu — kamu harus bepergian dulu ke wilayah itu sebelum bisa melamar.</p>
    <button class="btn-ghost btn-sm" id="btn-jobs-other" type="button">🌍 Tampilkan lowongan wilayah lain (${fmt(otherJobs.length)})</button>
    <div id="jobs-other-list" hidden>${otherJobs.map((j) => jobCard(j, false)).join('')}</div>
  </div>`);
  $('#btn-shift')?.addEventListener('click', doShift);
  $('#btn-autowork')?.addEventListener('click', async () => {
    const aw = ME.autoWork || { active: false };
    try {
      const r = await post('/api/jobs/auto-work', { on: !aw.active });
      toast(r.autoWork?.active ? 'Kerja otomatis aktif 24 jam — shift jalan walau aplikasi ditutup.' : 'Kerja otomatis dimatikan.');
      await refreshMe(); route();
    } catch (e) { toast(e.message); }
  });
  $('#btn-quit')?.addEventListener('click', async () => {
    try { await post('/api/jobs/quit'); toast('Kamu berhenti bekerja.'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
  $('#btn-jobs-other')?.addEventListener('click', () => {
    const list = $('#jobs-other-list');
    const show = list.hidden;
    list.hidden = !show;
    $('#btn-jobs-other').textContent = show ? `🔽 Sembunyikan lowongan wilayah lain (${fmt(otherJobs.length)})` : `🌍 Tampilkan lowongan wilayah lain (${fmt(otherJobs.length)})`;
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
  <div class="panel"><h3>📖 CARA KERJA PERUSAHAAN</h3>
    <p class="small">• <b>Produksi harian:</b> setiap perusahaan menghasilkan produk setiap hari (otomatis saat pergantian hari) dan langsung masuk inventaris pemilik.</p>
    <p class="small">• <b>Karyawan:</b> setiap shift karyawan menambah produk ke inventaris pemilik — sekitar 1/10 produksi harian per shift penuh. Produk kecil langsung masuk; produk besar seperti Drone terakumulasi beberapa shift.</p>
    <p class="small">• <b>Gaji:</b> gaji karyawan <b>DIPOTONG dari uangmu</b> (Rupiah) tiap shift — bukan dicetak sistem. Gaji maksimal = uang yang sedang kamu pegang; bila uangmu tidak cukup, shift karyawan gagal dan mereka tidak digaji. Gantinya, tiap shift karyawan menambah produk ke inventarismu (bonus shift di atas). Pemilik yang bekerja di perusahaannya sendiri tidak digaji (net nol).</p>
    <p class="small">• <b>Bahan baku:</b> semua perusahaan (kecuali Pabrik Sumber Daya) butuh bahan baku dari <b>STOK perusahaan</b> — pemilik mengisi stok dulu lewat ISI BAHAN di kartu perusahaannya (bahan pindah dari inventaris ke stok). Pabrik: 2× Besi Mentah per Bahan Bangunan; Industri Ringan: 1× Gandum Mentah per Makanan; Industri Berat: 1× Besi Mentah + 1× Minyak Mentah per Drone. Produksi maupun bonus shift berhenti bila stok habis (pemilik &amp; pekerja diberi tahu).</p>
    <p class="small">• <b>Milikmu:</b> pemilik bisa mengubah nama, tentang, dan bahan yang diproduksi, serta memasang foto perusahaan.</p>
  </div>
  <div class="panel"><h3>➕ DIRIKAN PERUSAHAAN</h3>
    <div class="grid2">
      ${data.types.map((t) => `
        <div class="card ${''}">
          <h4>${esc(t.name)}</h4>
          <p class="muted small">${esc(t.desc)}</p>
          <p class="muted small">${esc(t.input_text || '')}</p>
          <p class="price-big gold-text">${fmt(t.cost)} <small style="font-size:14px">emas</small></p>
          <p class="muted small">Di wilayahmu saat ini: ${esc(ME.region?.name || '')}</p>
          <button class="btn-gold btn-sm" data-found="${t.type}">DIRIKAN</button>
        </div>`).join('')}
    </div>
    <div id="found-form"></div>
  </div>
  <div class="panel"><h3>🏭 PERUSAHAANKU</h3>
    ${data.mine.length ? data.mine.map((c) => `
      <div class="card">
      ${c.photo ? `<img src="${esc(c.photo)}" class="company-photo" alt="Foto ${esc(c.name)}">` : ''}
      <h4>${esc(c.name)}</h4>
      <p class="muted small">${esc(c.type)} · ${esc(c.region_name)} · ${c.employees} karyawan${c.resource ? ' · Produksi: ' + esc(c.resource) : ''}</p>
      ${c.about ? `<p class="small">${esc(c.about)}</p>` : ''}
      <p class="muted small">🎁 Bonus shift: ${esc(c.bonus_text || '')} · Total dari karyawan: ${fmt(c.bonus_given || 0)} unit</p>
      <p class="muted small">🧱 ${esc(c.input_text || '')}</p>
      <p class="muted small">📦 Stok bahan: ${c.stock?.length ? c.stock.map((s) => `${fmt(s.qty)}× ${esc(s.commodity)}`).join(', ') : 'KOSONG — isi dulu supaya produksi &amp; bonus shift jalan.'}</p>
      ${c.inputs?.length ? `<div class="row"><select id="stock-commodity-${c.id}">${c.inputs.map((i) => `<option>${esc(i)}</option>`).join('')}</select><input placeholder="Jumlah" type="number" min="1" value="10" id="stock-qty-${c.id}" style="max-width:100px"><button class="btn-gold btn-sm" data-stockco="${c.id}">📦 ISI BAHAN</button></div>
      <p class="muted small">Bahan diambil dari inventarismu ke stok perusahaan.</p>` : ''}
      ${c.jobs?.length ? `<div style="margin-top:8px"><p class="muted small">💼 Lowonganmu (edit upah — maks ${fmtRp(ME.citizen?.usd || 0)}, sesuai uangmu sekarang):</p>${c.jobs.map((j) => `
        <div class="row"><span class="small" style="flex:1">${esc(j.title)} · ${fmt(j.workers || 0)} pekerja · sekarang ${fmtRp(j.salary)}</span>
        <input placeholder="Upah baru (Rp)" type="number" min="1" id="wage-${j.id}" style="max-width:130px">
        <button class="btn-gold btn-sm" data-wagejob="${j.id}">SIMPAN UPAH</button></div>`).join('')}</div>` : ''}
      <div class="row"><input placeholder="Judul lowongan baru" id="job-title-${c.id}"><input placeholder="Gaji (Rp)" type="number" id="job-salary-${c.id}" style="max-width:120px">
      <button class="btn-gold btn-sm" data-newjob="${c.id}">BUKA LOWONGAN</button></div>
      <p class="muted small">Gaji maksimal ${fmtRp(ME.citizen?.usd || 0)} — sesuai uang yang sedang kamu pegang.</p>
      <div class="row" style="margin-top:8px"><button class="btn-gold btn-sm" data-editco="${c.id}">✏️ EDIT</button>
      <button class="btn-gold btn-sm" data-photoco="${c.id}">📷 PASANG FOTO</button>
      <input type="file" accept="image/*" id="co-photo-${c.id}" hidden></div>
      <div id="co-edit-${c.id}"></div></div>`).join('')
      : '<p class="muted">Kamu belum punya perusahaan.</p>'}
  </div>
  <div class="panel"><h3>🌍 SEMUA PERUSAHAAN</h3>
    ${data.companies.length ? data.companies.map((c) => `
      <div class="kv"><span class="k">${c.photo_sm ? `<img src="${esc(c.photo_sm)}" class="company-photo-sm" alt="">` : ''}${esc(c.name)}<br><small class="muted">${esc(c.owner_name)} · ${esc(c.region_name)} · ${c.employees} karyawan</small></span>
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
  // Isi stok bahan perusahaan (v4.6.0): hanya pemilik — tombol hanya
  // dirender di kartu PERUSAHAANKU sendiri, server memverifikasi (403).
  $$('[data-stockco]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.stockco;
    try {
      const r = await post(`/api/companies/${id}/stock`, { commodity: $('#stock-commodity-' + id).value, qty: Number($('#stock-qty-' + id).value) });
      toast(`Stok diisi: ${r.stock.map((s) => `${fmt(s.qty)}× ${s.commodity}`).join(', ')}.`);
      route();
    } catch (e) { toast(e.message); }
  });
  // Edit upah lowongan perusahaan (v4.6.0): hanya pemilik perusahaan —
  // server memverifikasi (403 bila bukan pemilik / lowongan ADMIN).
  $$('[data-wagejob]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.wagejob;
    const rp = Number($('#wage-' + id).value);
    if (!rp || rp <= 0) { toast('Isi upah baru (Rp) dulu.'); return; }
    try {
      await api(`/api/jobs/${id}`, { method: 'PATCH', body: { salary: rpToUsd(rp) } });
      toast('Upah diperbarui.');
      route();
    } catch (e) { toast(e.message); }
  });
  // Edit perusahaan (v2.4.0): hanya pemilik — tombol hanya dirender di
  // kartu PERUSAHAANKU sendiri, server tetap memverifikasi (403).
  $$('[data-editco]').forEach((b) => b.onclick = () => {
    const c = data.mine.find((x) => x.id === Number(b.dataset.editco));
    if (!c) return;
    $('#co-edit-' + c.id).innerHTML = `
      <div class="card selected" style="margin-top:12px"><h4>✏️ EDIT ${esc(c.name)}</h4>
      <label>NAMA<input id="co-name-${c.id}" value="${esc(c.name)}" maxlength="60"></label>
      <label>TENTANG<input id="co-about-${c.id}" value="${esc(c.about || '')}" maxlength="200"></label>
      ${c.type === 'resource' ? `<label>APA YANG DIBUAT<select id="co-resource-${c.id}">${data.resources.map((r) => `<option ${r === c.resource ? 'selected' : ''}>${r}</option>`).join('')}</select></label>` : ''}
      <button class="btn-gold" id="co-save-${c.id}">SIMPAN PERUBAHAN</button></div>`;
    $('#co-save-' + c.id).onclick = async () => {
      try {
        await api(`/api/companies/${c.id}`, { method: 'PATCH', body: { name: $('#co-name-' + c.id).value.trim(), about: $('#co-about-' + c.id).value.trim(), resource: $('#co-resource-' + c.id)?.value } });
        toast('Perusahaan diperbarui.');
        await refreshMe(); route();
      } catch (e) { toast(e.message); }
    };
  });
  // Foto perusahaan (v2.4.0): pola yang sama seperti sampul artikel —
  // processCoverFile (1200×630, maks 500 KB) lalu POST data URL.
  $$('[data-photoco]').forEach((b) => b.onclick = () => $('#co-photo-' + b.dataset.photoco).click());
  $$('[id^="co-photo-"]').forEach((inp) => inp.addEventListener('change', async () => {
    const id = inp.id.replace('co-photo-', '');
    const processed = await processCoverFile(inp.files[0]);
    if (!processed || processed.error) { toast(imageErrorMessage(processed?.error)); inp.value = ''; return; }
    try {
      await post(`/api/companies/${id}/photo`, { photo: processed.cover, photo_sm: processed.coverSm });
      toast('Foto perusahaan dipasang.');
      route();
    } catch (e) { toast(e.message); inp.value = ''; }
  }));
};

// ---------- PETA & WILAYAH ----------
// ---------- PETA BESAR (v2.5.0) ----------
// Bentuk wilayah yang disederhanakan (garis bujur, lintang) — cukup untuk
// dikenali sebagai Indonesia: Sumatra diagonal, Jawa memanjang, Kalimantan
// besar, Sulawesi, Papua. Diproyeksikan equirectangular ke viewBox SVG
// 1000×360 (lon 94–142, lat 6 s.d. −11).
const MAP_PROJ = { lonMin: 94, lonMax: 142, latMax: 6, latMin: -11, w: 1000, h: 360 };
const mapX = (lon) => ((lon - MAP_PROJ.lonMin) / (MAP_PROJ.lonMax - MAP_PROJ.lonMin)) * MAP_PROJ.w;
const mapY = (lat) => ((MAP_PROJ.latMax - lat) / (MAP_PROJ.latMax - MAP_PROJ.latMin)) * MAP_PROJ.h;
const MAP_SHAPES = {
  'Sumatera Utara': { poly: [[97.8, 1.3], [98.0, 3.0], [98.6, 4.3], [99.6, 4.5], [100.4, 3.6], [100.3, 2.2], [99.6, 1.1], [98.6, 0.9]] },
  'Sumatera Barat': { poly: [[99.6, 0.4], [100.6, 0.4], [101.3, -0.8], [101.2, -2.0], [100.3, -3.0], [99.7, -2.2], [99.5, -0.8]] },
  'Sumatera Selatan': { poly: [[102.7, -1.0], [104.0, -1.3], [105.5, -2.2], [106.2, -3.2], [105.5, -4.3], [104.2, -4.4], [103.0, -3.5], [102.5, -2.0]] },
  'Kepulauan Riau': { poly: [[104.0, 0.5], [104.6, 0.6], [105.0, 1.0], [104.8, 1.4], [104.2, 1.3], [103.9, 0.9]], sats: [[103.6, 0.2, 0.14], [105.3, 0.9, 0.12]] },
  'Jakarta': { poly: [[106.65, -6.05], [106.95, -6.05], [107.0, -6.3], [106.7, -6.35]] },
  'Jawa Barat': { poly: [[105.6, -6.3], [106.5, -6.1], [107.8, -6.0], [108.5, -6.7], [108.3, -7.5], [107.0, -7.9], [105.9, -7.5], [105.5, -6.9]] },
  'Jawa Tengah': { poly: [[108.5, -6.7], [109.8, -6.4], [111.2, -6.8], [111.4, -7.5], [110.6, -8.1], [109.3, -8.0], [108.6, -7.4]] },
  'Jawa Timur': { poly: [[111.4, -6.9], [112.6, -6.7], [113.8, -7.0], [114.5, -7.6], [114.3, -8.2], [112.8, -8.3], [111.6, -7.7]], extra: [[112.6, -6.9], [113.5, -6.85], [114.1, -7.05], [113.6, -7.3], [112.8, -7.2]] },
  'Bali': { poly: [[114.4, -8.2], [115.2, -8.1], [115.7, -8.3], [115.6, -8.8], [114.9, -8.8], [114.4, -8.5]] },
  'Nusa Tenggara Barat': { poly: [[115.9, -8.3], [116.8, -8.3], [117.5, -8.5], [118.5, -8.4], [119.3, -8.7], [119.0, -9.1], [117.0, -9.0], [116.0, -8.8]] },
  'Nusa Tenggara Timur': { poly: [[119.3, -8.6], [120.5, -8.5], [122.0, -8.4], [123.0, -8.7], [122.5, -9.2], [120.0, -9.2], [119.2, -8.9]], extra: [[123.6, -9.2], [124.6, -9.4], [125.6, -9.8], [125.3, -10.4], [124.3, -10.4], [123.7, -9.9]] },
  'Kalimantan Barat': { poly: [[108.8, 1.5], [109.9, 2.3], [111.0, 1.2], [110.9, -0.5], [110.2, -2.0], [109.3, -2.9], [108.7, -1.8], [108.6, 0.2]] },
  'Kalimantan Selatan': { poly: [[114.3, -1.9], [115.4, -2.1], [116.4, -2.9], [116.2, -3.9], [115.2, -4.1], [114.4, -3.4], [114.2, -2.6]] },
  'Kalimantan Timur': { poly: [[114.6, -0.8], [115.6, -0.3], [116.8, 0.3], [117.9, 1.2], [118.1, 2.6], [117.4, 4.2], [116.2, 3.4], [115.2, 2.2], [114.6, 0.8], [114.4, -0.2]] },
  'Sulawesi Selatan': { poly: [[119.2, -2.9], [120.3, -3.2], [121.1, -4.2], [120.8, -5.2], [120.2, -6.0], [119.4, -5.9], [119.1, -4.4], [119.0, -3.5]] },
  'Sulawesi Utara': { poly: [[120.4, 0.3], [121.5, 0.6], [122.8, 0.9], [124.0, 1.3], [124.9, 1.5], [124.6, 0.7], [123.5, 0.4], [122.0, 0.2], [120.8, -0.1]] },
  'Papua': { poly: [[131.0, -0.9], [133.5, -1.2], [136.0, -1.6], [138.5, -2.0], [141.0, -2.7], [140.8, -4.2], [139.5, -5.5], [137.5, -7.0], [135.5, -8.2], [134.0, -7.2], [132.5, -5.5], [131.2, -3.5], [130.9, -1.8]] },
};
// Daratan sekitar (latar, tidak interaktif): Semenanjung Malaya, Borneo
// utara, Papua Nugini, Mindanao selatan.
const MAP_BG_LAND = [
  [[99.5, 6.5], [101.0, 6.0], [102.5, 4.5], [103.8, 2.5], [104.3, 1.5], [103.5, 1.3], [102.0, 2.0], [100.5, 3.5], [99.8, 5.0]],
  [[109.0, 1.2], [111.0, 2.0], [113.0, 3.2], [115.0, 4.5], [116.5, 6.5], [117.6, 6.2], [116.5, 4.8], [115.0, 3.5], [113.0, 2.2], [111.0, 1.4]],
  [[141.0, -2.7], [143.0, -3.0], [145.0, -4.2], [146.0, -6.0], [144.0, -8.0], [142.0, -8.5], [141.0, -6.0]],
  [[124.5, 5.8], [126.0, 5.9], [126.5, 4.6], [125.2, 4.2], [124.3, 5.0]],
];
// Warna negara (deterministik dari id negara — bendera ditentukan parlemen
// nanti, jadi warna saja yang membedakan negara di peta).
const COUNTRY_COLORS = ['#d43d2a', '#2e8b57', '#2f6fb2', '#8e44ad', '#c96a12', '#0f766e', '#b8860b', '#6d28d9'];
const countryColor = (id) => COUNTRY_COLORS[((Number(id) || 1) - 1) % COUNTRY_COLORS.length];
// Label wilayah kecil digeser supaya tidak menumpuk poligon tetangga.
const MAP_LABEL_DY = { 'Jakarta': -16, 'Bali': 15, 'Kepulauan Riau': -15, 'Nusa Tenggara Barat': 12 };
// Wilayah kecil (Jakarta, Bali, Kepri) dapat lingkaran klik tak terlihat
// supaya tetap mudah diketuk di HP.
const MAP_SMALL = new Set(['Jakarta', 'Bali', 'Kepulauan Riau']);

ROUTES.map = async () => {
  const data = await api('/api/regions');
  // Tandai tugas kronik 'map' (Jelajahi peta) — gagal diam-diam bila sesi habis.
  post('/api/chronicle/visit', { key: 'map' }).catch(() => {});
  // Banner transit (27 Nov 2026): selama bepergian, tombol travel di
  // semua kartu nonaktif — warga tiba saat waktunya habis.
  const transitBanner = ME.travel ? `<div class="panel"><p class="teal-text" style="margin:0">✈️ Dalam perjalanan ke <b>${esc(ME.travel.toRegionName)}</b> — tiba dalam ${fmtCountdown(ME.travel.remainingMs)} lagi.</p></div>` : '';
  const byId = new Map(data.regions.map((r) => [r.id, r]));
  const freeCount = data.regions.filter((r) => !r.country_name).length;
  const pts = (poly) => poly.map(([lo, la]) => `${mapX(lo).toFixed(1)},${mapY(la).toFixed(1)}`).join(' ');
  const centroid = (poly) => {
    const s = poly.reduce(([ax, ay], [lo, la]) => [ax + mapX(lo), ay + mapY(la)], [0, 0]);
    return [s[0] / poly.length, s[1] / poly.length];
  };
  // Label nama negara (satu per negara, di tengah wilayah-wilayahnya).
  const countryGroups = new Map();
  data.regions.forEach((r) => {
    if (!r.country_id) return;
    const g = countryGroups.get(r.country_id) || { name: r.country_name, pts: [] };
    const shape = MAP_SHAPES[r.name];
    if (shape) g.pts.push(centroid(shape.poly));
    countryGroups.set(r.country_id, g);
  });
  const countryLabels = [...countryGroups.values()].map((g) => {
    const [cx, cy] = [g.pts.reduce((s, p) => s + p[0], 0) / g.pts.length, g.pts.reduce((s, p) => s + p[1], 0) / g.pts.length];
    return `<text class="map-country-label" x="${cx.toFixed(1)}" y="${cy.toFixed(1)}">${esc(g.name.toUpperCase())}</text>`;
  }).join('');
  const mine = byId.get(data.mine);
  const mineXY = mine?.coords ? [mapX(mine.coords[1]), mapY(mine.coords[0])] : null;
  $('#page').innerHTML = page('PETA DUNIA', `${freeCount} wilayah belum bernegara · klik wilayah untuk memilih, klik dua kali untuk detail.`, `
  ${transitBanner}
  <div class="panel"><h3>🔍 CARI WILAYAH</h3>
    <input id="map-search" placeholder="Cari wilayah..." autocomplete="off">
    <p class="muted small" id="map-search-count" style="margin:6px 0 0"></p>
  </div>
  <div class="panel big-map-panel">
    <div class="map-zoom">
      <button class="btn-ghost btn-sm" id="map-zoom-out" type="button" aria-label="Perkecil peta">−</button>
      <button class="btn-ghost btn-sm" id="map-zoom-in" type="button" aria-label="Perbesar peta">+</button>
      <button class="btn-ghost btn-sm" id="map-zoom-reset" type="button" aria-label="Reset zoom">⟲</button>
    </div>
    <div class="big-map-wrap" id="big-map-wrap">
      <svg id="big-map" viewBox="0 0 1000 360" role="img" aria-label="Peta dunia Parlementer — 17 wilayah Indonesia">
        <rect class="map-ocean" x="0" y="0" width="1000" height="360"></rect>
        ${MAP_BG_LAND.map((poly) => `<polygon class="map-bg-land" points="${pts(poly)}"></polygon>`).join('')}
        <text class="map-sea" x="${mapX(112)}" y="${mapY(4.8)}">LAUT CINA SELATAN</text>
        <text class="map-sea" x="${mapX(111)}" y="${mapY(-5.0)}">LAUT JAWA</text>
        <text class="map-sea" x="${mapX(103)}" y="${mapY(-8.8)}">SAMUDRA HINDIA</text>
        ${data.regions.map((r) => {
          const shape = MAP_SHAPES[r.name];
          const free = !r.country_name;
          const [cx, cy] = r.coords ? [mapX(r.coords[1]), mapY(r.coords[0])] : (shape ? centroid(shape.poly) : [500, 180]);
          const [qx, qy] = shape ? centroid(shape.poly) : [cx, cy];
          const ly = cy + (MAP_LABEL_DY[r.name] || 0);
          const poly = shape
            ? `<polygon class="map-region" data-region-id="${r.id}" points="${pts(shape.poly)}" ${free ? '' : `style="fill:${countryColor(r.country_id)}"`} tabindex="0" role="button" aria-label="${esc(r.name)} — ${esc(r.country_name || 'Belum Bernegara')}"><title>${esc(r.name)} — ${r.population} warga · ${esc(r.country_name || 'Belum Bernegara')}</title></polygon>
            ${shape.extra ? `<polygon class="map-region" data-region-id="${r.id}" points="${pts(shape.extra)}" ${free ? '' : `style="fill:${countryColor(r.country_id)}"`} tabindex="0" role="button" aria-label="${esc(r.name)} — ${esc(r.country_name || 'Belum Bernegara')}"></polygon>` : ''}
            ${(shape.sats || []).map(([lo, la, rad]) => `<circle class="map-region map-sat" data-region-id="${r.id}" cx="${mapX(lo).toFixed(1)}" cy="${mapY(la).toFixed(1)}" r="${(rad * MAP_PROJ.w / (MAP_PROJ.lonMax - MAP_PROJ.lonMin)).toFixed(1)}" ${free ? '' : `style="fill:${countryColor(r.country_id)}"`}></circle>`).join('')}`
            : `<circle class="map-region" data-region-id="${r.id}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="10" ${free ? '' : `style="fill:${countryColor(r.country_id)}"`} tabindex="0" role="button" aria-label="${esc(r.name)}"><title>${esc(r.name)}</title></circle>`;
          return `<g class="map-region-g ${free ? 'free' : 'owned'}" data-region-id="${r.id}" data-name="${esc(r.name.toLowerCase())}">
            ${poly}
            ${free ? `<text class="map-q" x="${qx.toFixed(1)}" y="${(qy + 7).toFixed(1)}">?</text>` : ''}
            <text class="map-label" x="${cx.toFixed(1)}" y="${ly.toFixed(1)}">${esc(r.name.toUpperCase())}</text>
            ${MAP_SMALL.has(r.name) ? `<circle class="map-hit" data-region-id="${r.id}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="16"></circle>` : ''}
          </g>`;
        }).join('')}
        ${countryLabels}
        ${mineXY ? `<g class="map-you" data-region-id="${data.mine}"><circle class="map-you-ring" cx="${mineXY[0].toFixed(1)}" cy="${mineXY[1].toFixed(1)}" r="15"></circle><circle class="map-you-dot" cx="${mineXY[0].toFixed(1)}" cy="${mineXY[1].toFixed(1)}" r="7"></circle><text class="map-you-label" x="${mineXY[0].toFixed(1)}" y="${(mineXY[1] - 22).toFixed(1)}">📍 KAMU</text></g>` : ''}
      </svg>
    </div>
    <p class="muted small" style="margin:8px 0 0">Wilayah abu-abu + "?" = belum bernegara. Warna = negara pemiliknya.</p>
  </div>
  <div class="panel" id="map-panel"><h3>📖 POLITIK · NEGARA</h3><div id="map-panel-body"><p class="muted small">Memuat…</p></div></div>`);
  // --- Panel bawah: ringkasan wilayah yang dipilih ---
  let selectedId = data.mine;
  const panelHtml = (r, d) => `
      <div class="panel-head"><h4>${esc(r.name)}</h4><span class="chip">${esc(r.type)} · Skor ${r.city_score}/10</span></div>
      <p class="muted small">${r.population} warga · ${r.companies} perusahaan · Pemberontakan ${r.rebellion}/5${r.resource_bonus ? ' · Bonus: ' + esc(r.resource_bonus) : ''}</p>
      <p class="muted small">${r.country_name ? '🏳️ ' + esc(r.country_name) : '🕊️ Belum Bernegara'}</p>
      <div class="kv"><span class="k">Pajak penghasilan</span><span class="v">${d ? `${d.taxIncome ?? 0}%` : '…'}</span></div>
      ${d?.war ? `<p class="red-text small">⚔️ Perang aktif: <b>${esc(d.war.name)}</b></p>` : ''}
      <div class="row">
        <button class="btn-gold btn-sm" data-goto="#/regions/${r.id}">Lihat Wilayah</button>
        ${r.id === data.home ? '<span class="chip gold">🏠 KEWARGANEGARAAN</span>' : ''}
        ${r.id === data.mine ? '<span class="chip teal">📍 KAMU DI SINI</span>'
          : ME.travel ? '<span class="chip">✈️ Dalam perjalanan</span>'
          : `<button class="btn-ghost btn-sm" data-travel="${r.id}">Bepergian (~${r.travelMinutes} mnt · ${data.travelTickets || 1} 🎫)</button>`}
      </div>`;
  const selectRegion = async (id) => {
    selectedId = id;
    $$('.map-region-g').forEach((el) => el.classList.toggle('selected', Number(el.dataset.regionId) === id));
    const r = byId.get(id);
    const body = $('#map-panel-body');
    if (!r || !body) return;
    body.innerHTML = panelHtml(r, null);
    try {
      const d = await api('/api/regions/' + id);
      if (selectedId !== id || !document.body.contains(body)) return; // pilihan sudah berpindah
      body.innerHTML = panelHtml(r, d);
    } catch { /* panel dasar tetap tampil */ }
  };
  // Klik = pilih (panel terisi); klik dua kali = langsung buka detail.
  const onPick = (e) => {
    const g = e.target.closest('[data-region-id]');
    if (!g) return;
    selectRegion(Number(g.dataset.regionId));
  };
  $('#big-map').addEventListener('click', onPick);
  $('#big-map').addEventListener('dblclick', (e) => {
    const g = e.target.closest('[data-region-id]');
    if (g) location.hash = '#/regions/' + g.dataset.regionId;
  });
  $('#big-map').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset?.regionId) {
      e.preventDefault();
      selectRegion(Number(e.target.dataset.regionId));
    }
  });
  // Delegasi tombol travel di panel (panel di-render ulang tiap pilihan).
  $('#map-panel-body').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-travel]');
    if (!b) return;
    try {
      const res = await post('/api/regions/travel', { region_id: Number(b.dataset.travel) });
      toast(`Dalam perjalanan ke ${res.region} — tiba dalam ~${res.travelMinutes} menit.`);
      await refreshMe(); route();
    } catch (err) { toast(err.message); }
  });
  // Cari wilayah: yang cocok diberi garis emas, sisanya diredupkan.
  $('#map-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    let n = 0;
    $$('.map-region-g').forEach((el) => {
      const match = !q || el.dataset.name.includes(q);
      el.classList.toggle('match', !!q && match);
      el.classList.toggle('dim', !!q && !match);
      if (match) n++;
    });
    $('#map-search-count').textContent = q ? `${n} wilayah cocok.` : '';
  });
  $('#map-search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const matches = $$('.map-region-g.match');
    if (matches.length === 1) selectRegion(Number(matches[0].dataset.regionId));
  });
  // Zoom: lebar SVG 100% → 150% → 220% (wadah bisa di-scroll di HP).
  const zoomLevels = [100, 150, 220];
  let zoomIdx = 0;
  const svg = $('#big-map');
  const applyZoom = () => { svg.style.width = zoomLevels[zoomIdx] + '%'; };
  $('#map-zoom-in').onclick = () => { zoomIdx = Math.min(zoomLevels.length - 1, zoomIdx + 1); applyZoom(); };
  $('#map-zoom-out').onclick = () => { zoomIdx = Math.max(0, zoomIdx - 1); applyZoom(); };
  $('#map-zoom-reset').onclick = () => { zoomIdx = 0; applyZoom(); };
  await selectRegion(selectedId);
};

ROUTES.regions = async (id) => {
  if (id) {
    const d = await api('/api/regions/' + id);
    const r = d.region;
    $('#page').innerHTML = page(esc(r.name).toUpperCase(), `${esc(r.type)} · ${r.country_name ? esc(r.country_name) : 'Belum Bernegara'}`, `
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
      <div class="kv"><span class="k">Negara</span><span class="v">${r.country_name ? esc(r.country_name) : 'Belum Bernegara'}</span></div>
      <div class="kv"><span class="k">Penguasa wilayah</span><span class="v">${r.controller === 'pemberontak' ? `⚔️ Panglima Perang: ${esc(r.controller_name || '—')}` : r.controller === 'negara' ? esc(r.country_name || '—') : 'Bebas — tidak ada yang menguasai'}</span></div>
      ${r.controller === 'pemberontak' ? '<p class="muted small">Wilayah ini dikuasai pemberontak — pajak pasarnya mengalir ke panglima perang, bukan ke kas negara.</p>' : ''}
      <div class="kv"><span class="k">Pajak penghasilan</span><span class="v">${d.taxIncome ?? 0}%${r.country_name ? '' : ' · wilayah yang belum bernegara tidak memungut pajak'}</span></div>
      <div class="kv"><span class="k">Pajak produksi</span><span class="v">1%</span></div>
      <div class="kv"><span class="k">Pajak impor / ekspor</span><span class="v">2% / 2%</span></div>
      <div class="kv"><span class="k">Perbatasan</span><span class="v">Terbuka</span></div>
    </div>
    <div class="panel"><h3>👥 DEMOGRAFI</h3>
      <div class="kv"><span class="k">Total warga (domisili)</span><span class="v">${fmt(d.demographics?.total ?? 0)}</span></div>
      <div class="kv"><span class="k">Pemula (Lv 1–4)</span><span class="v">${fmt(d.demographics?.pemula ?? 0)}</span></div>
      <div class="kv"><span class="k">Aktif (Lv 5–9)</span><span class="v">${fmt(d.demographics?.aktif ?? 0)}</span></div>
      <div class="kv"><span class="k">Veteran (Lv 10+)</span><span class="v">${fmt(d.demographics?.veteran ?? 0)}</span></div>
      <div class="kv"><span class="k">Level rata-rata</span><span class="v">${d.demographics?.avgLevel ?? 0}</span></div>
      <div class="kv"><span class="k">⚔️ Kekuatan militer warga</span><span class="v">${fmt(d.regionPower ?? 0)}</span></div>
    </div>
    <div class="panel"><h3>✈️ PERJALANAN</h3>
      ${d.worldEvent?.key === 'badai' ? '<p class="muted small">⛈️ Badai Besar: semua perjalanan +5 menit minggu ini.</p>' : ''}
      ${d.mine
        ? `<p class="muted">Kamu di sini.</p>${d.home
          ? '<p class="teal-text small">🏠 Ini wilayah kewarganegaraanmu.</p>'
          : `<button class="btn-gold" id="btn-move">PINDAH KEWARGANEGARAAN KE SINI</button><p class="muted small">Kewarganegaraanmu pindah ke ${esc(r.name)} — negara, pajak, dan hak memilihmu mengikuti wilayah ini. Bisa pindah lagi setelah 7 hari. Gratis.</p>`}`
        : ME.travel && ME.travel.toRegionId === r.id
          ? `<p class="teal-text">✈️ Dalam perjalanan ke sini — tiba dalam ${fmtCountdown(ME.travel.remainingMs)} lagi.</p>`
          : ME.travel
            ? `<p class="muted">✈️ Kamu sedang dalam perjalanan ke ${esc(ME.travel.toRegionName)} — tiba dalam ${fmtCountdown(ME.travel.remainingMs)} lagi.</p>`
            : `<button class="btn-gold" id="btn-travel">BEPERGIAN KE SINI (~${d.travelMinutes} mnt · ${d.travelTickets || 1} 🎫)</button><p class="muted small">Bepergian hanya kunjungan — kewarganegaraanmu tetap di wilayah asal.</p>`}
    </div>
    <div class="panel"><h3>🔥 PEMBERONTAKAN</h3>
      <p class="muted small">5 warga berbeda harus mendukung untuk menyulut perang pemberontakan di wilayah ini. Dukunganmu hangus (tidak kembali).</p>
      ${d.war ? `<p>⚔️ Perang aktif: <b>${esc(d.war.name)}</b> — ${fmt(d.war.score_a)} vs ${fmt(d.war.score_d)}</p>
        <button class="btn-gold" data-goto="#/war/${d.war.id}">Buka Front Perang</button>`
        : `<p>Dukungan saat ini: <b>${r.rebellion}/5</b></p>
        <button class="btn-gold" id="btn-rebel" ${d.mySupport ? 'disabled' : ''}>${d.mySupport ? '✓ Sudah Mendukung' : 'DUKUNG PEMBERONTAKAN · 50 emas hangus'}</button>`}
    </div>`);
    $('#btn-travel')?.addEventListener('click', async () => {
      try { const res = await post('/api/regions/travel', { region_id: r.id }); toast(`Dalam perjalanan ke ${res.region} — tiba dalam ~${res.travelMinutes} menit.`); await refreshMe(); route(); }
      catch (e) { toast(e.message); }
    });
    $('#btn-move')?.addEventListener('click', async () => {
      if (!confirm(`Pindah kewarganegaraan ke ${r.name}? Negara, pajak, dan hak memilihmu akan mengikuti wilayah ini. Bisa pindah lagi setelah 7 hari.`)) return;
      try { const res = await post('/api/regions/move', { region_id: r.id }); toast(`Kewarganegaraanmu kini ${res.region}.`); await refreshMe(); route(); }
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
    : 'Dunia masih terpecah — wilayahmu belum bernegara. Dirikan negaramu sendiri atau gabung lewat unifikasi.';
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
  <div class="panel"><h3>🎁 SUMBANG KE KAS NEGARA</h3>
    <p class="muted small">Sumbanganmu masuk kas negaramu dan tercatat di ARUS KAS di atas. Tidak ada hadiah balik — ini murni sumbangan untuk negaramu.</p>
    <div class="row"><input id="donate-gold" type="number" min="1" placeholder="Jumlah emas" style="flex:1"><button class="btn-gold btn-sm" id="btn-donate-gold">SUMBANG EMAS</button></div>
    <div class="row"><input id="donate-rp" type="number" min="1" placeholder="Jumlah (Rp)" style="flex:1"><button class="btn-gold btn-sm" id="btn-donate-rp">SUMBANG RUPIAH</button></div>
    ${d.myDonateItems?.length ? `<div class="row"><select id="donate-commodity">${d.myDonateItems.map((i) => `<option value="${esc(i.name)}">${esc(i.name)} (punya ${fmt(i.qty)})</option>`).join('')}</select><input id="donate-qty" type="number" min="1" value="1" style="max-width:90px"><button class="btn-gold btn-sm" id="btn-donate-item">SUMBANG BAHAN</button></div>
    <p class="muted small">Bahan disumbangkan dari inventarismu (tier 1) — dicatat di kas negara setara nilai acuannya.</p>`
      : '<p class="muted small">Kamu tidak punya bahan tier 1 di inventaris untuk disumbangkan.</p>'}
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
  <div class="panel"><h3>🕊️ WILAYAHMU BELUM BERNEGARA</h3>
    <p>Wilayah kewarganegaraanmu adalah <b>${esc(d.myRegion?.name || '')}</b> — wilayah ini belum bernegara. Kamu bisa mendirikan negara sendiri (wilayahmu jadi ibu kota) atau mengusulkan wilayahmu bergabung dengan negara yang sudah ada.</p>
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
  // Sumbang ke kas negara (v4.6.0, saran LIO): emas / Rupiah / bahan.
  $('#btn-donate-gold')?.addEventListener('click', async () => {
    try { const r = await post('/api/country/donate', { type: 'gold', amount: Number($('#donate-gold').value) }); toast(`Sumbangan ${fmt(r.amount)} emas diterima. Kas negara kini ${fmt(r.treasury)} emas.`); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
  $('#btn-donate-rp')?.addEventListener('click', async () => {
    try { const r = await post('/api/country/donate', { type: 'usd', amount: rpToUsd(Number($('#donate-rp').value)) }); toast(`Sumbangan ${fmtRp(r.amount)} diterima.`); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
  $('#btn-donate-item')?.addEventListener('click', async () => {
    try { const r = await post('/api/country/donate', { type: 'item', commodity: $('#donate-commodity').value, qty: Number($('#donate-qty').value) }); toast(`Sumbangan ${r.qty}× ${r.commodity} diterima (setara ${fmtRp(r.amount)}).`); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
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
  const [stats, fx] = await Promise.all([api('/api/stats'), api('/api/fx')]);
  const w = stats.world;
  const cell = (label, num, sub) => `<div class="stat-cell"><div class="stat-label">${label}</div><div class="stat-num">${num}</div><div class="stat-sub">${sub}</div></div>`;
  const emptyRows = '<p class="muted">Belum ada data.</p>';
  const levelRows = (rows) => rows.length ? rows.map((x, i) => `
    <div class="leader-row"><span class="leader-rank">${i + 1}</span>
      <div class="leader-main"><div class="leader-name" data-goto="#/profile/${encodeURIComponent(x.username)}" style="cursor:pointer" title="Lihat profil ${esc(x.username)}">${esc(x.username)}</div><div class="leader-sub">${esc(x.region_name)}${x.country_name ? ' · ' + esc(x.country_name) : ' · Belum Bernegara'}${x.online ? ' · <span class="online-badge">● Online</span>' : (x.last_seen_at ? ' · Terakhir online ' + ago(x.last_seen_at) : '')}</div>
      <div class="bar leader-bar"><i style="width:${Math.round((Number(x.level) / (Number(rows[0]?.level) || 1)) * 100)}%"></i></div></div>
      <span class="leader-val">LV ${x.level} <small>${fmt(x.xp)} XP</small></span></div>`).join('') : emptyRows;
  const regionRows = (rows) => rows.length ? rows.map((x, i) => `
    <div class="leader-row"><span class="leader-rank">${i + 1}</span>
      <div class="leader-main"><div class="leader-name">${esc(x.name)}</div><div class="leader-sub">${esc(x.country_name || 'Belum Bernegara')} · ${esc(x.type)}</div>
      <div class="bar leader-bar"><i style="width:${Math.round((Number(x.citizens) / (Number(rows[0]?.citizens) || 1)) * 100)}%"></i></div></div>
      <span class="leader-val">${fmt(x.citizens)} <small>warga</small></span></div>`).join('') : emptyRows;
  const partyRows = (rows) => rows.length ? rows.map((x, i) => `
    <div class="leader-row"><span class="leader-rank">${i + 1}</span>
      <div class="leader-main"><div class="leader-name">${esc(x.name)} <span class="party-tag">[${esc(x.tag)}]</span></div><div class="leader-sub">${fmt(x.members)} anggota</div>
      <div class="bar leader-bar"><i style="width:${Math.round((Number(x.members) / (Number(rows[0]?.members) || 1)) * 100)}%"></i></div></div>
      <span class="leader-val">${fmt(x.members)} <small>anggota</small></span></div>`).join('') : emptyRows;
  $('#page').innerHTML = page('STATISTIK', 'Angka nyata dari dunia — tanpa data palsu.', `
  <div class="panel"><h3>📜 CATATAN DUNIA — SEPANJANG MASA</h3>
    <div class="stat-grid">
      ${cell('⚔️ Perang Diumumkan', fmt(w.wars), `${fmt(w.warsActive)} masih berlangsung`)}
      ${cell('🔥 Pemberontakan', fmt(w.rebellions), `dukungan aktif di ${fmt(w.rebellionRegions)} wilayah`)}
      ${cell('💥 Kerusakan Diberikan', fmt(w.damage), 'total damage perang')}
      ${cell('🔫 Senjata Digunakan', fmt(w.weapons), '1 senjata per serangan')}
      ${cell('🏗️ Bangunan Berdiri', fmt(w.buildings), 'konvoi aktif')}
      ${cell('📰 Artikel Terbit', fmt(w.articles), `dari ${fmt(w.newspapers)} surat kabar`)}
      ${cell('🗞️ Surat Kabar', fmt(w.newspapers), 'koran terdaftar')}
      ${cell('🤝 Kontrak Disepakati', fmt(w.contracts), 'transaksi pasar')}
    </div>
    <div class="stat-grid" style="margin-top:12px">
      ${cell('🚩 Partai', fmt(w.parties), 'partai terdaftar')}
      ${cell('🏭 Perusahaan', fmt(w.companies), 'perusahaan aktif')}
    </div>
    <p class="muted small" style="margin-top:10px">Populasi dunia ${fmt(w.population)} warga · ${fmt(w.regions)} wilayah · ${fmt(w.countries)} negara · ${fmt(w.freeRegions)} wilayah belum bernegara.</p>
  </div>
  <div class="panel"><h3>🏆 PEMIMPIN TIAP DAFTAR — LEVEL TERTINGGI</h3>
    <div id="leaders-level">${levelRows(stats.topLevel)}</div>
    <button class="btn-text gold" type="button" data-full="level">LIHAT SEMUA ›</button>
  </div>
  <div class="panel"><h3>👥 PEMIMPIN TIAP DAFTAR — WARGA TERBANYAK</h3>
    <div id="leaders-regions">${regionRows(stats.topRegions)}</div>
    <button class="btn-text gold" type="button" data-full="regions">LIHAT SEMUA ›</button>
  </div>
  <div class="panel"><h3>🚩 PEMIMPIN TIAP DAFTAR — PARTAI TERBESAR</h3>
    <div id="leaders-parties">${partyRows(stats.topParties)}</div>
    <button class="btn-text gold" type="button" data-full="parties">LIHAT SEMUA ›</button>
  </div>
  <div class="panel"><h3>💱 VALAS</h3>
    <div class="kv"><span class="k">Kurs cetak</span><span class="v">1 emas = ${fmtRp(10)}</span></div>
    <div class="kv"><span class="k">Jual terbaik</span><span class="v">${fx.bestSell != null ? fmtRp(fx.bestSell) : '—'}</span></div>
    <div class="kv"><span class="k">Beli terbaik</span><span class="v">${fx.bestBuy != null ? fmtRp(fx.bestBuy) : '—'}</span></div>
    <div class="kv"><span class="k">Transaksi 24 jam</span><span class="v">${fmt(fx.stats.tx)} · ${fmt(fx.stats.volume, 2)} emas</span></div>
  </div>`);
  $$('[data-full]').forEach((b) => b.onclick = async () => {
    const kind = b.dataset.full;
    b.disabled = true; b.textContent = 'Memuat…';
    try {
      const d = await api('/api/stats?full=' + kind);
      const el = $('#leaders-' + kind);
      if (!el || !d.fullList) return;
      el.innerHTML = kind === 'level' ? levelRows(d.fullList) : kind === 'regions' ? regionRows(d.fullList) : partyRows(d.fullList);
      b.hidden = true;
    } catch (e) { toast(e.message); b.disabled = false; b.textContent = 'LIHAT SEMUA ›'; }
  });
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
          <p class="muted small">⚔️ Kekuatan militermu: ${d.militaryPower ?? 0} (kerusakan ×${d.militaryMult ?? 1}) — <a data-goto="#/military" style="cursor:pointer" class="gold-text">rekrut pasukan</a>.</p>
          <div class="row">
            <button class="btn-gold" data-attack="attacker|Senjata">SERANG SEBAGAI PENYERANG 🔥</button>
            <button class="btn-ghost" data-attack="defender|Senjata">BELAH SEBAGAI PEMBELA 🛡️</button>
          </div>
          <button class="btn-ghost btn-sm" data-attack="attacker|Drone" style="margin-top:8px">Serang dengan Drone (kerusakan ×1,5)</button>`}
    </div>
    <div class="panel"><h3>🏆 PEJUANG TERATAS</h3>
      ${d.fighters.length ? d.fighters.map((f, i) => `
        <div class="kv"><span class="k">#${i + 1} <span data-goto="#/profile/${encodeURIComponent(f.username)}" style="cursor:pointer" title="Lihat profil ${esc(f.username)}">${esc(f.username)}</span> ${f.side === 'attacker' ? '🔥' : '🛡️'}</span>
        <span class="v">${fmt(f.damage)} kerusakan · ${f.attacks} serangan</span></div>`).join('')
        : '<p class="muted">Belum ada yang bertempur di front ini.</p>'}
    </div>
    <div class="panel"><h3>📜 UMPAN FRONT</h3>
      ${d.feed.length ? d.feed.map((a) => `<div class="kv"><span class="k"><span data-goto="#/profile/${encodeURIComponent(a.username)}" style="cursor:pointer" title="Lihat profil ${esc(a.username)}">${esc(a.username)}</span> ${a.side === 'attacker' ? '🔥 menyerang' : '🛡️ bertahan'} · ${a.ammo}</span>
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
  $('#page').innerHTML = page('PERANG TANAH AIR', 'Front pemberontakan di wilayah-wilayah yang belum bernegara.', `
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

// ---------- MILITER (Tahap 6, v4.0.0) ----------
// Rekrut unit (komoditas + USD), bubarkan, lihat kekuatan + perawatan.
// Kekuatan memperkuat serangan perang (pengali ×1,00–1,50, maks di 100).
ROUTES.military = async () => {
  const d = await api('/api/military');
  const defs = Object.values(d.defs || {});
  const owned = Object.fromEntries((d.units || []).map((u) => [u.unit_type, u.qty]));
  $('#page').innerHTML = page('MILITER', 'Pasukanmu memperkuat setiap serangan perang — dan menelan biaya perawatan setiap hari.', `
  <div class="stat-grid">
    <div class="stat-cell"><div class="stat-label">⚔️ Kekuatan</div><div class="stat-num">${fmt(d.power)}</div><div class="stat-sub">kerusakan perang ×${d.mult}</div></div>
    <div class="stat-cell"><div class="stat-label">🪖 Pasukan</div><div class="stat-num">${fmt(d.count)}<span style="font-size:18px;color:var(--muted)">/${fmt(d.cap)}</span></div><div class="stat-sub">batas naik 10 per level</div></div>
    <div class="stat-cell"><div class="stat-label">💰 Perawatan</div><div class="stat-num">${fmtRp(d.upkeep)}</div><div class="stat-sub">Rupiah per hari</div></div>
    <div class="stat-cell"><div class="stat-label">🏆 Kekuatan Teratas</div><div class="stat-num" style="font-size:20px">${d.top?.[0] ? esc(d.top[0].username) : '—'}</div><div class="stat-sub">${d.top?.[0] ? fmt(d.top[0].power) + ' kekuatan' : 'belum ada pasukan'}</div></div>
  </div>
  <div class="panel"><h3>🪖 REKRUT PASUKAN</h3>
    <p class="muted small">Bayar komoditas dari inventaris + Rupiah. Perawatan harian dipotong tiap pergantian hari — bila saldo kurang, unit termahal desersi dulu.</p>
    ${defs.map((u) => `
    <div class="card"><h4>${esc(u.name)}</h4>
      <p class="muted small">${esc(u.desc)}</p>
      <div class="kv"><span class="k">Kekuatan per unit</span><span class="v">${u.power}</span></div>
      <div class="kv"><span class="k">Biaya rekrut</span><span class="v">${u.commodityQty}× ${esc(u.commodity)} + ${fmtRp(u.usd)}</span></div>
      <div class="kv"><span class="k">Perawatan</span><span class="v">${fmtRp(u.upkeep)}/hari</span></div>
      <div class="kv"><span class="k">Milikmu</span><span class="v">${fmt(owned[u.type] || 0)} unit</span></div>
      <div class="row"><input type="number" id="recruit-qty-${u.type}" value="1" min="1" max="50" style="max-width:90px" aria-label="Jumlah ${esc(u.name)}">
      <button class="btn-gold btn-sm" data-recruit="${u.type}">REKRUT</button>
      ${owned[u.type] ? `<button class="btn-ghost btn-sm" data-disband="${u.type}">BUBARKAN 1</button>` : ''}</div>
    </div>`).join('')}
  </div>
  <div class="panel"><h3>🏆 KEKUATAN MILITER TERATAS</h3>
    ${d.top?.length ? d.top.map((t, i) => `<div class="kv"><span class="k">#${i + 1} <span data-goto="#/profile/${encodeURIComponent(t.username)}" style="cursor:pointer" title="Lihat profil ${esc(t.username)}">${esc(t.username)}</span></span><span class="v">${fmt(t.power)} kekuatan · ${fmt(t.count)} unit</span></div>`).join('')
      : '<p class="muted">Belum ada yang merekrut pasukan.</p>'}
  </div>`);
  $$('[data-recruit]').forEach((b) => b.onclick = async () => {
    const qty = Number($('#recruit-qty-' + b.dataset.recruit)?.value || 1);
    try { const r = await post('/api/military/recruit', { type: b.dataset.recruit, qty }); toast(`Direkrut ${qty}× ${d.defs[b.dataset.recruit].name} — kekuatanmu kini ${r.power} (×${r.mult}).`); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-disband]').forEach((b) => b.onclick = async () => {
    if (!confirm('Bubarkan 1 unit ini? Tidak ada pengembalian dana/barang.')) return;
    try { await post('/api/military/disband', { type: b.dataset.disband, qty: 1 }); toast('1 unit dibubarkan.'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
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
    if (!processed || processed.error) { toast(imageErrorMessage(processed?.error)); coverInput.value = ''; return; }
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
      <button class="btn-ghost" id="btn-share-article">🔗 Bagikan ke Obrolan</button>
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
  // v5.0.1 (laporan Vincent): ID tombol ini DULU 'btn-share' — sama dengan
  // tombol 🔗 di HUD (share link, data-goto="#/share"). $('#btn-share')
  // mengikat handler ke tombol HUD (yang pertama di DOM), sehingga tombol
  // artikel MATI TOTAL (diklik tidak terjadi apa-apa — itulah yang dialami
  // Vincent) dan klik tombol HUD malah mem-post share + balapan navigasi
  // '#/share' vs '#/chat'. ID artikel kini 'btn-share-article' (unik).
  $('#btn-share-article').onclick = async () => {
    try {
      await post('/api/chat/global', { content: 'Baca artikel ini: ' + a.title, article_id: a.id });
      // v5.0.1 (laporan Vincent): bagikan lalu TINGGAL di halaman artikel
      // dengan toast saja membuat pemain tidak melihat hasilnya — ia membuka
      // chat sendiri dan tidak menemukan pesannya (apalagi bila kena
      // cooldown 5 detik, yang hanya muncul sebagai toast sesaat). Setelah
      // berhasil, langsung arahkan ke Obrolan Global supaya pesan +
      // pratinjau artikelnya langsung terlihat. Gagal → toast berisi
      // alasan sebenarnya (mis. cooldown), tetap di halaman artikel.
      location.hash = '#/chat';
    }
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
    ${l.journalists.length ? l.journalists.map((j, i) => `<div class="kv"><span class="k">#${i + 1} <span data-goto="#/profile/${encodeURIComponent(j.username)}" style="cursor:pointer" title="Lihat profil ${esc(j.username)}">${esc(j.username)}</span></span><span class="v">${fmt(j.score)} poin</span></div>`).join('')
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
// Jejak baca chat (v5.4.0, ala Parlementum): tandai ruangan sudah dibaca
// supaya lencana jumlah pesan belum dibaca di tab hilang. Fire-and-forget
// (gagal diam-diam — bukan fitur kritis); throttle 10 detik per ruangan
// supaya polling 5 detik tidak membanjiri server dengan POST.
const chatReadMarkAt = {};
function chatTabKeyFor(room) {
  if (room === 'global') return 'global';
  if (room === 'indonesia') return 'indonesia';
  if (room && room.startsWith('region_')) return 'wilayah';
  return null;
}
async function markChatRead(room, force) {
  const key = chatTabKeyFor(room);
  if (!key) return;
  const now = Date.now();
  // Throttle 10 detik untuk mark dari polling/scroll — tapi mark saat ruangan
  // BARU dibuka (force) selalu lolos: itulah yang menghapus lencana tab.
  if (!force && now - (chatReadMarkAt[room] || 0) < 10000) return;
  chatReadMarkAt[room] = now;
  try {
    await post('/api/chat/read', { room });
    // Hapus lencana tab ruangan ini secara optimistis (tanpa menunggu
    // render ulang) — warga sudah membaca ruangan ini.
    document.querySelector(`.chat-tabs .tab[data-room="${key}"] .chat-count`)?.remove();
  } catch {}
}
async function renderChatRoom(room) {
  if (chatLoading) return false;
  const list = $('#chat-list');
  if (!list) return false;
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
          <span class="msg-name ${m.isPremium ? 'premium-name' : ''}" data-goto="#/profile/${encodeURIComponent(m.username)}" style="cursor:pointer" title="Lihat profil ${esc(m.username)}">${esc(m.username)}${m.isPremium ? ' ◆' : ''}</span>
          ${m.party_tag ? `<span class="msg-tag">[${esc(m.party_tag)}]</span>` : ''}
          <span class="msg-time">${fmtTime(m.created_at)}</span>
        </div>
        <div class="msg-row">
          <div class="msg-bubble">${esc(m.content)}
            ${m.article_id ? `<a class="article-preview" href="#/press/${m.article_id}">
              <div class="ap-tag">📰 ARTIKEL</div><div class="ap-title">${esc(m.article_title || 'Artikel')}</div>
              <div class="ap-meta">${m.article_source ? esc(m.article_source) + ' · ' : ''}👍 ${m.article_likes || 0} · 💬 ${m.article_comments || 0} komentar</div></a>` : ''}
          </div>
          <div class="msg-actions">
            <button data-report="${m.id}" type="button" title="Laporkan pesan" aria-label="Laporkan pesan">🚩</button>
            <button data-block="${m.citizen_id}" type="button" title="Blokir warga" aria-label="Blokir warga">🚫</button>
          </div>
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
    // Pesan baru terlihat di bawah (auto-scroll) → tandai sudah dibaca.
    if (!isFirstLoad && wasNearBottom && data.messages.length) markChatRead(room);
    // Load berhasil: sembunyikan status error dan reset backoff.
    hideChatStatus();
    clearChatRetry();
    return true;
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
    return false;
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
  // Kolom chat ala Parlementum (v5.4.0): chat bukan lagi halaman penuh 1
  // layar — isinya dibungkus .chat-column (kolom sempit di tengah, panel
  // berbingkai). Lencana pesan belum dibaca diambil dulu supaya tab langsung
  // tampil dengan jumlahnya; gagal diam-diam (tab tetap tampil tanpa angka).
  let chatUnread = { global: 0, indonesia: 0, wilayah: 0 };
  try { const u = await api('/api/chat/unread'); if (u.unread) chatUnread = u.unread; } catch {}
  $('#page').innerHTML = page('', '', `
  <div class="chat-column">
  <div class="chat-tabs">
    ${CHAT_TABS.map(([r, label]) => {
      const n = chatUnread[r] || 0;
      const badge = n > 0 ? `<span class="chat-count">${n > 99 ? '+99' : n}</span>` : '';
      return `<button class="tab chat-tab ${room === r || (r === 'wilayah' && room.startsWith('region_')) ? 'active' : ''}" data-room="${r}" data-goto="#/chat${r === 'global' ? '' : '/' + r}">${label}${badge}</button>`;
    }).join('')}
  </div>
  <h2 class="chat-title">${title}${room.startsWith('war_') ? '<span class="chat-live">● LANGSUNG</span>' : ''}</h2>
  <p class="page-sub">${esc(subLabel)}</p>
  <div id="chat-status" class="chat-status" hidden></div>
  <div id="chat-list" class="chat-list"></div>
  <button id="chat-new-pill" class="chat-new-pill" type="button" hidden>↓ pesan baru</button>
  <div class="chat-input">
    <input id="chat-text" aria-label="Tulis pesan chat" placeholder="${esc(subLabel)}" maxlength="500" autocomplete="off">
    <button class="btn-gold" id="btn-send">KIRIM</button>
  </div>
  <p class="muted small" style="margin-top:8px">Pesan minimal 3 kata dan jeda 30 detik dihitung untuk misi harian. Chat dimulai kosong — hanya pesan pemain asli.</p>
  </div>`);
  const send = async () => {
    const input = $('#chat-text');
    const text = input.value.trim();
    if (!text) return;
    try { await post('/api/chat/' + room, { content: text }); input.value = ''; await renderChatRoom(room); }
    catch (e) { toast(e.message); }
  };
  $('#btn-send').onclick = send;
  $('#chat-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  // Tombol "pesan baru": lompat ke bawah, sembunyikan penanda, tandai dibaca.
  const pill = $('#chat-new-pill');
  if (pill) pill.onclick = () => { const l = $('#chat-list'); if (l) l.scrollTop = l.scrollHeight; hideChatNewPill(); markChatRead(room); };
  // Pengguna scroll manual ke bawah → penanda tidak lagi diperlukan + tandai dibaca.
  const listEl = $('#chat-list');
  if (listEl) listEl.addEventListener('scroll', () => { if (chatNearBottom()) { hideChatNewPill(); markChatRead(room); } });
  chatSince = 0;
  chatRoom = room;
  const chatOk = await renderChatRoom(room);
  // Muat awal berhasil → ruangan ini sudah dibaca (lencana hilang).
  // Force: mark pembukaan ruangan tidak boleh kalah oleh throttle 10 detik
  // dari mark sebelumnya (mis. baru saja membuka ruangan yang sama).
  if (chatOk) markChatRead(room, true);
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
    <div class="chat-column">
    <div id="dm-list" class="chat-list dm-list">
      ${d.messages.length ? d.messages.map((m) => `
        <div class="msg"><div class="msg-avatar">${avatarHtml(m.from_avatar, m.from_name, 48)}</div>
        <div class="msg-body"><div class="msg-head"><span class="msg-name" data-goto="#/profile/${encodeURIComponent(m.from_name)}" style="cursor:pointer" title="Lihat profil ${esc(m.from_name)}">${esc(m.from_name)}</span><span class="msg-time">${fmtTime(m.created_at)}</span></div>
        <div class="msg-bubble">${esc(m.content)}</div></div></div>`).join('')
        : '<p class="muted">Belum ada pesan. Mulai percakapan!</p>'}
    </div>
    <div class="chat-input"><input id="dm-text" placeholder="Tulis pesan..." maxlength="500"><button class="btn-gold" id="btn-dm-send">KIRIM</button></div>
    <button class="btn-ghost btn-sm" data-goto="#/messages" style="margin-top:10px">← Semua Percakapan</button>
    </div>`);
    // Bug DM (tiket LIO #47): pesan menumpuk di atas karena daftar tidak
    // pernah di-scroll ke bawah saat dibuka. Turunkan ke pesan terbaru —
    // pengiriman pesan baru me-render ulang lewat route(), jadi ikut tercakup.
    const dmList = $('#dm-list');
    if (dmList) dmList.scrollTop = dmList.scrollHeight;
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

// ---------- KONVERSI GOOGLE ADS (v5.3.0) ----------
// 'Pendaftaran' — cuplikan event PERSIS dari Google (action dibuat pemilik
// 28 Nov 14:36 WIB, web Google Ads, manual + page load, hitung "Satu",
// nilai sama per konversi, atribusi berbasis data). Fire TEPAT SATU KALI
// saat registrasi baru berhasil; login biasa TIDAK memanggil ini. Label
// send_to JANGAN diubah-ubah. Guard: jangan crash bila pustaka Google
// diblokir (ad-block / offline) — gtag tidak ada = lewati diam-diam.
function firePendaftaranConversion() {
  try {
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'conversion', {
        'send_to': 'AW-18546219743/qsZPCIw7.8AdEN-1w4tF',
        'value': 1.0,
        'currency': 'IDR',
      });
    }
  } catch (e) { /* abaikan — konversi opsional, game tetap jalan */ }
}
// Event konversi game (tanpa send_to — action-nya belum dibuat pemilik di
// aplikasi Google Ads): 'mulai_bermain' saat shift pertama selesai. Guard
// sama seperti di atas. TIDAK ada send_to di sini: action "Mulai Bermain"
// belum dibuat pemilik (dibuat dengan nama event yang sama, baru dipetakan
// ke campaign).
function fireConversionEvent(name) {
  try { if (typeof window.gtag === 'function') window.gtag('event', name); } catch (e) { /* abaikan — konversi opsional, game tetap jalan */ }
}

// ---------- IKLAN BERHADIAH (AdinPlay, v4.4.0) ----------
// Library aiptag dimuat dinamis HANYA bila property ID terisi — dengan ID
// kosong tidak ada skrip pihak ketiga yang dimuat sama sekali, dan menu
// menampilkan "segera hadir" tanpa iklan atau hadiah palsu. Callback
// AIP_REWARDEDGRANTED = iklan selesai → hadiah diminta ke server dengan
// token tontonan; callback itu sendiri TIDAK memberi hadiah (server yang
// memvalidasi token satu kali pakai).
let adinplayLoad = null;
function loadAdinPlay(propertyId) {
  if (adinplayLoad) return adinplayLoad;
  adinplayLoad = new Promise((resolve) => {
    window.aiptag = window.aiptag || {};
    window.aiptag.cmd = window.aiptag.cmd || [];
    window.aiptag.cmd.display = window.aiptag.cmd.display || [];
    window.aiptag.cmd.player = window.aiptag.cmd.player || [];
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://api.adinplay.com/libs/aiptag/pub/' + encodeURIComponent(propertyId) + '/tag.min.js';
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
  return adinplayLoad;
}

async function watchRewardedAd(ads) {
  const btn = $('#btn-watch-ad');
  const status = $('#ad-status');
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Meminta token tontonan…';
  let start;
  try { start = await post('/api/ads/start'); }
  catch (e) { toast(e.message); if (btn) btn.disabled = false; if (status) status.textContent = ''; return; }
  if (status) status.textContent = 'Memuat pemutar iklan…';
  const ok = await loadAdinPlay(ads.propertyId);
  if (!ok) {
    toast('Pemutar iklan gagal dimuat. Periksa koneksimu lalu coba lagi.');
    if (btn) btn.disabled = false; if (status) status.textContent = '';
    return;
  }
  if (status) status.textContent = 'Iklan diputar — tonton sampai selesai untuk mendapat hadiah.';
  // Player dibuat sekali per pemuatan halaman; pemutaran berikutnya memakai
  // player yang sama (token baru tetap diminta tiap kali menonton).
  window.aiptag.cmd.player.push(function() {
    if (!window.aiptag.adplayer) {
      window.aiptag.adplayer = new window.aipPlayer({
        AD_WIDTH: 960,
        AD_HEIGHT: 540,
        AD_DISPLAY: 'center',
        PREROLL_ELEM: function() { return document.getElementById('ad-player-slot'); },
        AIP_REWARDEDGRANTED: async function() {
          try {
            const r = await post('/api/ads/reward', { token: start.token });
            toast(`Hadiah diterima: +${r.reward.gold} emas!`);
            await refreshMe(); route();
          } catch (e) { toast(e.message); if (btn) btn.disabled = false; }
        },
        AIP_REWARDEDNOTGRANTED: function() {
          toast('Iklan tidak selesai ditonton — tidak ada hadiah.');
          if (btn) btn.disabled = false;
          if (status) status.textContent = '';
        },
      });
    }
    // startRewardedAd memakai placement berhadiah default milik properti
    // ini (diatur di dashboard AdinPlay) — tanpa argumen.
    window.aiptag.adplayer.startRewardedAd();
  });
}

// ---------- BANNER IKLAN ADSENSE BERHADIAH (v5.3.0) ----------
// Slot banner AdSense: <ins class="adsbygoogle" data-ad-client="ca-pub-..."
// data-ad-slot="..."> — slot ID dari /api/me (env ADSENSE_BANNER_SLOT),
// client ID dibaca dari tag <script> adsbygoogle yang sudah ada di
// <head> (satu sumber kebenaran — jangan hardcode di sini).
// Hadiah HANYA untuk MELIHAT banner: klaim aktif bila banner TERISI iklan
// (data-ad-status="filled") DAN sudah terlihat 10 detik. Banner kosong
// (situs belum disetujui Google) = tidak ada token, tidak ada hadiah.
// Klik iklan TIDAK PERNAH dilacak atau diberi hadiah.
function adsenseClientId() {
  const s = document.querySelector('script[src*="adsbygoogle.js?client="]');
  if (!s) return '';
  try { return new URL(s.src).searchParams.get('client') || ''; } catch { return ''; }
}

async function viewBannerAd(banner) {
  const status = $('#banner-status');
  const btn = $('#btn-claim-banner');
  const slot = document.querySelector('#ad-banner-slot ins.adsbygoogle');
  if (!slot) return;
  if (status) status.textContent = 'Memuat banner iklan…';
  // Minta AdSense mengisi slot (pustaka sudah dimuat dari <head>, v5.2.0).
  try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) { /* pustaka gagal dimuat — poll tetap jalan, lalu tampil pesan belum ada iklan */ }
  // Poll status pengisian: 'filled' = ada iklan, 'unfilled' = kosong.
  const t0 = Date.now();
  let filled = false;
  while (Date.now() - t0 < 20000) {
    const st = slot.getAttribute('data-ad-status');
    if (st === 'filled') { filled = true; break; }
    if (st === 'unfilled') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!filled) {
    if (status) status.textContent = 'Banner belum menampilkan iklan — situs masih menunggu persetujuan Google AdSense. Coba lagi nanti.';
    return;
  }
  // Banner terisi: minta token, lalu hitung mundur 10 detik terlihat.
  let start;
  try { start = await post('/api/ads/banner/start'); }
  catch (e) { toast(e.message); if (status) status.textContent = ''; return; }
  if (start.remainingToday <= 0) {
    if (status) status.textContent = `Batas harian banner tercapai (${banner.dailyCap}×/hari). Kembali besok.`;
    return;
  }
  const viewMs = start.viewMs || banner.viewMs || 10000;
  let left = Math.ceil(viewMs / 1000);
  if (status) status.textContent = `Banner terlihat — hadiah bisa diklaim dalam ${left} detik…`;
  const timer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(timer);
      if (status) status.textContent = `Banner sudah terlihat 10 detik — klaim +${banner.rewardGold} emas! Sisa hari ini: ${start.remainingToday}×.`;
      if (btn) btn.disabled = false;
    } else if (status) status.textContent = `Banner terlihat — hadiah bisa diklaim dalam ${left} detik…`;
  }, 1000);
  if (btn) btn.onclick = async () => {
    btn.disabled = true;
    try {
      const r = await post('/api/ads/banner/reward', { token: start.token });
      toast(`Hadiah banner diterima: +${r.reward.gold} emas!`);
      await refreshMe(); route();
    } catch (e) { toast(e.message); if (status) status.textContent = ''; btn.disabled = false; }
  };
}

ROUTES.ads = async () => {
  const ads = ME.ads || { enabled: false, propertyId: '', rewardGold: 30 };
  const banner = ads.banner || { enabled: false, slot: '', rewardGold: 15, dailyCap: 10, viewMs: 10000 };
  const clientId = adsenseClientId();
  const videoPanel = ads.enabled
    ? `<h3>🎬 TONTON IKLAN, DAPAT EMAS</h3>
  <p class="muted small">Iklan diputar oleh AdinPlay. Hadiah masuk begitu iklan selesai ditonton. Menutup iklan sebelum selesai = tidak ada hadiah.</p>
  <div id="ad-player-slot"><p class="muted small">Pemutar iklan siap. Tekan tombol di bawah untuk memutar iklan.</p></div>
  <div class="row"><button class="btn-gold" id="btn-watch-ad" type="button">▶ TONTON IKLAN (+${ads.rewardGold} EMAS)</button></div>
  <p class="muted small" id="ad-status"></p>`
    : `<h3>🎬 TONTON IKLAN, DAPAT EMAS</h3>
  <p class="muted small">Segera hadir — menunggu aktivasi dari admin. Begitu aktif, tiap iklan yang kamu tonton sampai selesai memberi +${ads.rewardGold} emas, tanpa batas harian.</p>`;
  // Banner (v5.3.0): panel selalu tampil — bila slot belum dikonfigurasi,
  // tampilkan placeholder yang jujur (bukan slot kosong yang membingungkan).
  const bannerPanel = !banner.enabled
    ? `<h3>📺 LIHAT BANNER IKLAN</h3>
  <p class="muted small">Lihat banner iklan, dapat +${banner.rewardGold} emas per tampilan — maks ${banner.dailyCap}×/hari (${banner.rewardGold * banner.dailyCap} emas/hari).</p>
  <div class="ad-banner-slot"><p class="muted small">Banner iklan belum tersedia — slot AdSense belum dikonfigurasi. Begitu slot diisi dan Google menyetujui situs, banner tampil di sini.</p></div>`
    : `<h3>📺 LIHAT BANNER IKLAN</h3>
  <p class="muted small">Lihat banner iklan, dapat +${banner.rewardGold} emas per tampilan — maks ${banner.dailyCap}×/hari. Hadiah hanya untuk MELIHAT banner (bukan untuk klik iklan). Banner harus terlihat minimal 10 detik sebelum hadiah bisa diklaim.</p>
  <div class="ad-banner-slot" id="ad-banner-slot"><ins class="adsbygoogle" style="display:block" data-ad-client="${esc(clientId)}" data-ad-slot="${esc(banner.slot)}" data-ad-format="auto" data-full-width-responsive="true"></ins></div>
  <div class="row"><button class="btn-gold" id="btn-claim-banner" type="button" disabled>KLAIM +${banner.rewardGold} EMAS</button></div>
  <p class="muted small" id="banner-status"></p>`;
  $('#page').innerHTML = page('🎬 NONTON IKLAN', `Tonton video dapat +${ads.rewardGold} emas · Lihat banner dapat +${banner.rewardGold} emas.`, `
  <div class="panel">${videoPanel}</div>
  <div class="panel">${bannerPanel}</div>`);
  if (ads.enabled) $('#btn-watch-ad').onclick = () => watchRewardedAd(ads);
  if (banner.enabled && clientId) viewBannerAd(banner);
  else if (banner.enabled && !clientId) {
    const st = $('#banner-status');
    if (st) st.textContent = 'Pustaka AdSense tidak ditemukan di halaman — banner tidak bisa dimuat.';
  }
};

// ---------- BAGIKAN LINK (v4.6.0) ----------
// Link share pribadi: tiap klik unik (1 IP = 1 klik per hari per link)
// memberi +10 emas ke pemilik, maks 200 emas/hari. Link untuk publik —
// yang mengklik tidak perlu login/akun.
ROUTES.share = async () => {
  const d = await api('/api/share');
  const url = location.origin + '/s/' + d.code;
  const t = d.today || { clicks: 0, gold: 0, remaining: 200, cap: 200 };
  const tot = d.total || { clicks: 0, gold: 0 };
  $('#page').innerHTML = page('🔗 BAGIKAN LINK', 'Bagikan linkmu — tiap klik unik dapat emas.', `
  <div class="panel"><h3>🔗 LINK PRIBADIMU</h3>
    <p class="muted small">Siapa pun bisa mengklik link ini TANPA login — kliknya tetap terhitung untukmu.</p>
    <div class="row"><input id="share-url" value="${esc(url)}" readonly style="flex:1"><button class="btn-gold" id="btn-copy-share" type="button">📋 SALIN LINK</button></div>
    <p class="muted small" id="share-copy-note"></p>
  </div>
  <div class="panel"><h3>📊 STATISTIK HARI INI</h3>
    <div class="kv"><span class="k">Klik terhitung hari ini</span><span class="v"><b>${fmt(t.clicks)}</b> / ${fmt(d.maxClicksPerDay || 20)}</span></div>
    <div class="kv"><span class="k">Emas didapat hari ini</span><span class="v gold-text"><b>${fmt(t.gold)} emas</b></span></div>
    <div class="kv"><span class="k">Sisa kuota hari ini</span><span class="v"><b>${fmt(t.remaining)} emas</b> (maks ${fmt(t.cap || 200)}/hari)</span></div>
    <div class="kv"><span class="k">Total sepanjang waktu</span><span class="v">${fmt(tot.clicks)} klik · ${fmt(tot.gold)} emas</span></div>
  </div>
  <div class="panel"><h3>📖 ATURAN</h3>
    <p class="small">• Tiap klik unik = <b>+${fmt(d.perClick || 10)} emas</b> untukmu.</p>
    <p class="small">• <b>1 IP = 1 klik terhitung per hari</b> untuk link yang sama — klik kedua dari IP yang sama di hari yang sama tidak dihitung lagi.</p>
    <p class="small">• Maksimal <b>${fmt(t.cap || 200)} emas/hari</b> (=${fmt(d.maxClicksPerDay || 20)} klik unik/hari). Kuota reset tiap hari.</p>
    <p class="small">• Klik dari kamu sendiri tidak dihitung. Berbeda dengan referral: ini hadiah klik, bukan hadiah pendaftaran (referral tetap cair saat rekrutan mencapai Level 3).</p>
  </div>`);
  $('#btn-copy-share').onclick = async () => {
    const input = $('#share-url');
    try {
      await navigator.clipboard.writeText(input.value);
      $('#share-copy-note').textContent = 'Link disalin! Bagikan ke teman-temanmu.';
    } catch {
      input.select();
      $('#share-copy-note').textContent = 'Salin manual: link sudah dipilih, tekan Ctrl+C.';
    }
  };
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
  <div class="panel"><h3>🎓 TUTORIAL AWAL</h3>
    <p class="muted small">Tur singkat pengenalan game untuk pemain baru. Bisa diputar ulang kapan saja — tidak mengubah progresmu.</p>
    <button class="btn-gold" type="button" data-replay-tutorial>▶ LIHAT TUTORIAL LAGI</button>
  </div>
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
        <span class="v small muted" style="white-space:nowrap;flex-shrink:0">${fmtDate(a.created_at)}</span></div>
        <p class="announce-body">${esc(a.body)}</p>
      </div>`).join('')
      : '<p class="muted">Belum ada pengumuman.</p>'}
  </div>`);
  $$('[data-replay-tutorial]').forEach((b) => { b.onclick = () => showTutorial(); });
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
  // Tutorial awal lebih dulu (v5.2.0): bila overlay tutorial sedang
  // terbuka, pengumuman tidak menumpuk di atasnya — muncul lagi di sesi
  // berikut karena belum ditandai dibaca.
  if (!$('#tutorial-modal')?.hidden) return;
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

// ---------- TUTORIAL AWAL (overlay pemain baru, v5.2.0) ----------
// Muncul OTOMATIS saat login pertama setelah registrasi — HANYA bila
// citizens.tutorial_done = 0 (warga lama di-backfill 1 saat migrasi, jadi
// tidak pernah melihatnya). Tur 7 langkah tentang loop inti game; tiap
// langkah mengarahkan halaman ke konteksnya (modal tetap di atas, di luar
// #page). "Lewati" SELALU terlihat; selesai ATAU lewati sama-sama menutup
// permanen (POST /api/tutorial/done, tersimpan di server — login di
// perangkat lain tetap tidak melihatnya). Overlay TIDAK memaksa 20 tugas
// Kronik — hanya memperkenalkan awal permainan dan mengarahkan ke Kronik.
// Bisa diputar ulang dari Buku Panduan / Pengaturan ("Lihat Tutorial Lagi").
const TUTORIAL_STEPS = [
  { title: 'Selamat datang di Parlementer!', text: 'Kamu warga baru di dunia yang dijalankan para pemain — bukan bot. Tur singkat ini mengenalkan alur inti game. Bisa dilewati kapan saja dengan tombol Lewati.', route: '#/dashboard' },
  { title: 'Energi adalah bahan bakarmu', text: 'Bar energi di bawah pulih +2 per menit. Bekerja, berlatih, dan berperang memakai energi. Habis? Makan roti atau ambil pasokan harian.', route: '#/dashboard' },
  { title: 'Ambil pasokan harianmu', text: 'Ketuk 📦 di atas setiap hari: +5 emas, +Rp915.000, +40 XP. Roti mengisi energi — jatah harianmu ada di dashboard.', route: '#/dashboard' },
  { title: 'Cari pekerjaan, kerjakan shift', text: 'Di halaman Pekerjaan ada lowongan ADMIN (dibayar bahan mentah) dan perusahaan pemain (dibayar Rupiah dari uang pemilik). Satu shift = gaji + XP.', route: '#/jobs' },
  { title: 'Jual beli di pasar', text: 'Pasar Lokal memakai Rupiah, Pasar Global memakai emas. Jual hasil kerjamu, beli bahan, pantau harga — semua harga ditentukan pemain.', route: '#/market' },
  { title: 'Kronikmu: misi berbabak', text: 'Ikuti 5 babak Kronik — selesaikan tugasnya, klaim hadiah emas. Kronik ada di dashboard dan halaman KRONIKMU. Tidak wajib diselesaikan sekarang.', route: '#/chronicle' },
  { title: 'Naik level, gabung partai, dirikan negara', text: 'Naik level lewat XP. Gabung partai, dirikan perusahaan, dan saat Level 10 kamu bisa mendirikan negaramu sendiri. Selamat bermain!', route: '#/profile' },
];
let tutorialStep = 0;
let __tutorialShown = false;
function renderTutorialStep() {
  const step = TUTORIAL_STEPS[tutorialStep];
  const last = tutorialStep === TUTORIAL_STEPS.length - 1;
  $('#tutorial-title').textContent = step.title;
  $('#tutorial-step-label').textContent = `Langkah ${tutorialStep + 1} dari ${TUTORIAL_STEPS.length} · Tutorial Awal`;
  $('#tutorial-text').textContent = step.text;
  $('#tutorial-next').textContent = last ? 'MULAI BERMAIN' : 'Lanjut';
  $('#tutorial-dots').innerHTML = TUTORIAL_STEPS.map((_, i) => `<span class="tutorial-dot${i === tutorialStep ? ' active' : ''}${i < tutorialStep ? ' done' : ''}"></span>`).join('');
  // Arahkan halaman ke konteks langkah (modal tetap di atas, di luar #page).
  if (step.route && location.hash !== step.route) location.hash = step.route;
}
function showTutorial() {
  tutorialStep = 0;
  renderTutorialStep();
  $('#tutorial-modal').hidden = false;
  // Bila modal pengumuman sempat terbuka, tutup — tutorial lebih dulu;
  // pengumuman yang belum dibaca muncul lagi di sesi berikut.
  const am = $('#announce-modal'); if (am) am.hidden = true;
}
async function finishTutorial(via) {
  try { await post('/api/tutorial/done', { via }); } catch { /* tutup tetap jalan walau server gagal */ }
  if (ME?.citizen) ME.citizen.tutorial_done = 1;
  $('#tutorial-modal').hidden = true;
}
function maybeShowTutorial() {
  if (__tutorialShown || ME?.user?.is_banned) return;
  if (!ME?.citizen || ME.citizen.tutorial_done) return;
  // Hanya muncul otomatis di dashboard (tempat login pertama mendarat) —
  // jangan membajak pemain yang sedang bekerja di halaman lain (mis.
  // mengunggah foto perusahaan): route() memanggil lagi tiap pindah
  // halaman, jadi tutorial tetap muncul begitu ia sampai di dashboard.
  const h = location.hash || '#/dashboard';
  if (h !== '#/dashboard' && h !== '#/' && h !== '') return;
  __tutorialShown = true;
  showTutorial();
}
$('#tutorial-next').onclick = () => {
  if (tutorialStep < TUTORIAL_STEPS.length - 1) { tutorialStep++; renderTutorialStep(); }
  else finishTutorial('complete');
};
$('#tutorial-skip').onclick = () => finishTutorial('skip');

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
