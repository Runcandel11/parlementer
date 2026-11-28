// Aturan main Parlementer — angka-angka inti (diadaptasi dari mekanik referensi).

// VERSI game (semver; aturan pemilik 27 Nov 2026): update kecil +0.0.1,
// sedang +0.1, besar +1. Versi saat ini v2.1.3 (travel, kecil);
// update sedang v2.2.0 = landing + profil/ADMIN + kartu wilayah abu-abu +
// perbaikan login (bcrypt pindah ke worker). Update kecil v2.2.1 =
// perbaikan upload foto (terima file tanpa tipe MIME + pesan error jujur).
// Update kecil v2.2.2 = Pekerjaan menurut lokasi (default hanya lowongan
// wilayah sendiri; wilayah lain terpisah + tombol LIHAT WILAYAH).
// Update kecil v2.2.3 = perbaikan upload foto ronde 2: gerbang tipe/ekstensi
// dihapus, decode lewat <img> jadi satu-satunya penjaga format (avatar,
// sampul, dan gambar inline artikel).
// Update sedang v2.3.0 = timing emas pasar: buy-order tanpa escrow — pembeli
// baru dipotong saat penjual memenuhi order (sell-to-order), bukan saat
// order dipasang; batal order tanpa refund.
// Update kecil v2.3.1 = rapikan UI atas + ikon: HUD geser ke kanan
// (padding kiri 16px di HP), kolom kiri HUD seragam 38px (36px di HP),
// semua ikon di tengah dengan flex (HUD, drawer, peti, tutup drawer).
// Update sedang v2.5.0 = peta besar ala Parlamentum: peta geografis SVG
// dari REGION_COORDS (wilayah tanpa negara = kaca abu-abu + "?"; warna
// negara deterministik per negara), penanda KAMU, "Cari wilayah...",
// panel bawah POLITIK · NEGARA, zoom; kunjungan ke peta menandai tugas
// kronik 'map' selesai.
// Update BESAR v3.0.0 = sistem kredit skor (saran LIO, tiket #7): semua
// warga mulai 100; laporan chat yang TERBUKTI benar oleh admin menurunkan
// skor penulis pesan −10; skor pulih +1/hari (malas, dari waktu berlalu);
// makin rendah skor makin banyak batasan (pers <80, partai <60, pasar
// <40, chat/DM <20); skor 0 = akun dibanned otomatis (bisa banding,
// unban mengembalikan skor ke 50).
// Update sedang v3.1.0 = batch fitur tiket (saran LIO + Vincent, 28 Nov
// 2026): ubah penawaran pasar; XP shift proporsional + target level
// ratusan; XP ×2 jam 00:00–01:00 WIB; konvoi dibayar bahan (bukan emas);
// minuman energi 0,10 emas/kaleng (+1 energi); tab notifikasi; daftar
// pemain yang diblokir; inventaris lengkap di dashboard; foto profil
// mengikuti aspek asli galeri.
// Update MAYOR v4.0.0 = Tahap 6 master overhaul (28 Nov 2026): sistem
// militer (rekrut unit, perawatan harian, pengali kerusakan perang);
// kepemilikan wilayah (perang yang dimenangkan mengubah pengendali —
// pajak pasar wilayah taklukan mengalir ke panglima perang); rantai
// produksi penuh (semua perusahaan butuh bahan baku); reputasi dagang;
// demografi wilayah; event dunia mingguan.
// Update sedang v4.1.0 = Tahap 7 master overhaul — INTEGRASI (28 Nov 2026):
// satu sumber kebenaran untuk angka yang dipakai di banyak tempat (pajak
// impor dari kolom negara, pajak shift ikut event dunia, jeda latihan,
// klaim harian, durasi pemilu, jeda chat, TTL valas, biaya pemberontakan,
// slot konvoi, hari dunia); misi harian + kronik pindah dari JSON TEXT ke
// tabel relasional; Pendidikan akhirnya punya efek nyata (jeda latihan
// −5% per level); teks janji palsu dihapus (tagline Deluxe, deskripsi
// Ekonomi/Premium); README + docs/ARSITEKTUR.md disinkronkan.
// Update sedang v4.2.0 = Tahap 8 master overhaul — STRESS TEST + QA
// (28 Nov 2026, tahap TERAKHIR overhaul): race ensureElections diperbaiki
// (INSERT atomik + indeks unik parsial — pemilu ganda tidak mungkin lagi);
// views artikel dihitung 1× per warga per artikel per hari (refresh tidak
// lagi menggembungkan skor Liga Pers); skenario tick penuh + alur pemain
// baru dites end-to-end; stress test lokal 50 VU (490 req/dtk, p95 7 ms,
// 0 error) + uji pemulihan SIGKILL (snapshot identik, tick tepat 1 hari).
// Ditampilkan di footer (landing + drawer) dan dikirim API /api/world + /api/me.
// Update sedang v4.3.0 = status online per warga (saran LIO, 28 Nov 2026):
// profil + daftar Level Tertinggi menampilkan "● Online" bila warga aktif
// dalam 5 menit terakhir, atau "Terakhir online X jam Y menit lalu" bila
// offline; ambang 5 menit jadi satu konstanta ONLINE_WINDOW_MS di bawah,
// dipakai juga countOnline() di api-core.js (dulu literal tersendiri).
// Update kecil v4.3.1 = bottom navigation di HP (saran ricky.s888 via
// Threads, 28 Nov 2026): menu utama di bawah layar ala Rival Regions.
export const VERSION = '4.3.1';

// --- Satuan waktu dasar (Tahap 7) ---
// Satu sumber kebenaran untuk "sehari" dalam milidetik — semua konstanta
// durasi di bawah memakai ini, bukan lagi literal 24*60*60*1000 yang
// tersebar di banyak file.
export const DAY_MS = 24 * 60 * 60 * 1000;

// --- Status online per warga (v4.3.0, saran LIO) ---
// Warga dianggap ONLINE bila last_seen_at (disentuh heartbeat /api/me,
// paling cepat 1×/menit) masih dalam jendela ini. Satu-satunya ambang di
// seluruh game — countOnline(), /api/profile, dan /api/stats memakai
// konstanta yang sama, jangan ada literal 5 menit kedua di tempat lain.
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;

// true bila warga aktif dalam ONLINE_WINDOW_MS terakhir. last_seen_at 0 /
// null = belum pernah tercatat → offline.
export function isOnline(lastSeenAt, now = Date.now()) {
  const seen = Number(lastSeenAt || 0);
  return seen > 0 && now - seen < ONLINE_WINDOW_MS;
}

// Format relatif Bahasa Indonesia untuk "terakhir aktif": "baru saja"
// (<10 detik), "45 detik lalu", "3 menit lalu", "2 jam 15 menit lalu",
// "2 jam lalu", "3 hari lalu". null bila belum pernah tercatat (0/null).
export function formatLastSeenId(lastSeenAt, now = Date.now()) {
  const seen = Number(lastSeenAt || 0);
  if (seen <= 0) return null;
  const s = Math.max(0, Math.floor((now - seen) / 1000));
  if (s < 10) return 'baru saja';
  if (s < 60) return s + ' detik lalu';
  if (s < 3600) return Math.floor(s / 60) + ' menit lalu';
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? h + ' jam ' + m + ' menit lalu' : h + ' jam lalu';
  }
  return Math.floor(s / 86400) + ' hari lalu';
}

// Status lengkap satu warga untuk API + UI: flag online + label siap
// tampil ("Online" / "Terakhir online 2 jam lalu" /
// "Belum pernah terlihat online"). last_seen_at mentah tetap dikirim
// terpisah oleh endpoint (untuk hitung mundur/ketelitian di klien).
export function onlineStatus(lastSeenAt, now = Date.now()) {
  const online = isOnline(lastSeenAt, now);
  const rel = formatLastSeenId(lastSeenAt, now);
  return {
    online,
    last_seen_label: online ? 'Online' : (rel ? 'Terakhir online ' + rel : 'Belum pernah terlihat online'),
  };
}

// --- Sistem kredit skor (v3.0.0, saran LIO tiket #7) ---
// Semua warga mulai 100. Laporan chat yang terbukti benar menurunkan skor
// penulis pesan yang dilaporkan. Pulih +1/hari secara malas (settle di
// loadCitizen, pola yang sama seperti regen energi). Skor 0 = banned
// otomatis; unban mengembalikan skor ke 50 (kesempatan kedua).
export const CREDIT_START_SCORE = 100;
export const CREDIT_MAX_SCORE = 100;
export const CREDIT_RECOVERY_PER_DAY = 1;
export const CREDIT_DAY_MS = DAY_MS;
export const CREDIT_DEDUCTION_PROVEN_REPORT = 10;
export const CREDIT_UNBAN_RESET_SCORE = 50;
// Batasan bertingkat — skor minimal untuk tiap aksi (dipakai middleware
// requireCredit di util.js; server yang menegakkan, UI hanya menampilkan).
export const CREDIT_MIN_FOR = { press: 80, party: 60, market: 40, chat: 20 };
export const CREDIT_RESTRICTION_LABELS = {
  press: 'Membuat koran / menerbitkan artikel',
  party: 'Mendirikan partai / mencalonkan di pemilu',
  market: 'Jual-beli di pasar',
  chat: 'Mengirim chat / DM',
};
// Tier tampilan: batas bawah (inklusif) → label + warna + daftar batasan
// yang sedang berlaku di tier itu (kumulatif dari tier di atasnya).
export const CREDIT_TIERS = [
  { min: 80, key: 'baik', label: 'Baik', color: '#3fb950', restrictions: [] },
  { min: 60, key: 'waspada', label: 'Waspada', color: '#d29922', restrictions: ['press'] },
  { min: 40, key: 'terbatas', label: 'Terbatas', color: '#f0883e', restrictions: ['press', 'party'] },
  { min: 20, key: 'diawasi', label: 'Diawasi', color: '#f85149', restrictions: ['press', 'party', 'market'] },
  { min: 1, key: 'kritis', label: 'Kritis', color: '#da3633', restrictions: ['press', 'party', 'market', 'chat'] },
  { min: 0, key: 'banned', label: 'Dibanned', color: '#da3633', restrictions: ['press', 'party', 'market', 'chat'] },
];
export function creditTierFor(score) {
  const s = Math.max(0, Math.min(CREDIT_MAX_SCORE, Number(score ?? CREDIT_START_SCORE)));
  return CREDIT_TIERS.find((t) => s >= t.min) || CREDIT_TIERS[CREDIT_TIERS.length - 1];
}
// Satu objek untuk API (/api/me, profil): skor + tier + batasan yang
// berlaku + skor minimal tiap aksi (supaya UI tidak mengulang angka).
export function creditInfo(score) {
  const tier = creditTierFor(score);
  return {
    score: Math.max(0, Math.min(CREDIT_MAX_SCORE, Number(score ?? CREDIT_START_SCORE))),
    tier: tier.key, label: tier.label, color: tier.color,
    restrictions: tier.restrictions.map((key) => ({ key, label: CREDIT_RESTRICTION_LABELS[key], min: CREDIT_MIN_FOR[key] })),
    minFor: { ...CREDIT_MIN_FOR },
  };
}

export const WA_TOPUP_URL = 'https://wa.me/6285220743283';
export const MINT_RATE = 10; // 1 emas dicetak jadi 10 USD
export const INCOME_TAX = 0.02;
export const IMPORT_TAX = 0.02; // tarif impor BILA pembeli tidak bernegara;
// warga bernegara memakai tarif impor negaranya (country.tax_import,
// baca lewat getImportTaxRate di api-civic.js — Tahap 7).
export const MIN_OFFER_QTY = 10;
// Penawaran valas kedaluwarsa setelah 72 jam (Tahap 7: dulu literal di
// api-core.js; satu konstanta supaya TTL tidak berbeda di dua tempat).
export const FX_OFFER_TTL_MS = 72 * DAY_MS;

// XP: naik level butuh level*100 XP (level 1 -> 100 XP, level 2 -> 200 XP,
// dst. — RATUSAN, bukan puluhan; permintaan LIO tiket #22, 28 Nov 2026).
// Skala lama level*5 (5/10/15...) dikali 20; semua sumber XP ikut dikali
// 20 supaya kecepatan naik level TIDAK berubah (level N tetap butuh
// level*5 giliran penuh). Migrasi v14 mengalikan XP tersimpan pemain lama
// ×20 agar progres mereka tidak hilang.
export function xpForLevel(level) { return level * 100; }

export function xpGainForShift() { return 20; }

// XP shift PROPORSIONAL dengan energi yang dipakai (tiket #22): shift
// 50 energi -> 10 XP, shift 1 energi -> minimal 1 XP (tetap nambah, bukan
// 0). Pembulatan floor, konsisten dengan hadiah shift. Jam ganda
// 00:00–01:00 WIB (tiket #21): XP shift ×2.
export function isDoubleXpHour(now = Date.now()) {
  const wibHour = (new Date(now).getUTCHours() + 7) % 24;
  return wibHour === 0;
}
export function xpGainForShiftEnergy(usedEnergy, now = Date.now()) {
  const base = Math.max(1, Math.floor(xpGainForShift() * usedEnergy / 100));
  return isDoubleXpHour(now) ? base * 2 : base;
}

// Kelelahan menurunkan hasil kerja: mulai 10.000 (×0,75), 15.000 (×0,5).
// Berlaku untuk gaji USD maupun upah bahan mentah.
export function fatigueMult(fatigue) {
  if (fatigue >= 15000) return 0.5;
  if (fatigue >= 10000) return 0.75;
  return 1;
}

// Kursi lowongan ADMIN: TIDAK TERBATAS jumlah pekerjanya (perintah
// pemilik 27 Nov 2026 — lowongan ADMIN ada di semua 17 wilayah tanpa
// batas pekerja). Diwujudkan sebagai angka kursi yang sangat besar
// (1.000.000) + pengecualian kursi di apply/quit + tampilan "Tanpa batas
// kursi" di UI — bukan kursi tak hingga di skema, supaya CHECK
// seats_taken <= seats tetap berlaku dan statistik kursi tidak meledak
// (GET /api/jobs mengecualikan kursi ADMIN dari jumlah kursi kosong).
export const ADMIN_JOB_SEATS = 1000000;

// Gaji shift: 100 energi = 1 shift penuh.
// Gaji dasar per 10 energi 4,80 USD + bonus Ekonomi (0,30 USD per level Ekonomi per 10 energi).
// Contoh referensi: shift penuh ~48 USD sebelum pajak.
// taxRate bisa di-override tarif UU yang berlaku (country.tax_income / 100);
// default = INCOME_TAX (2%) bila pemanggil tidak memberi tarif.
export function shiftSalary(baseSalary, economyAttr, fatigue, taxRate = INCOME_TAX) {
  const mult = fatigueMult(fatigue);
  const gross = baseSalary * (1 + 0.03 * economyAttr) * mult;
  return { gross, net: gross * (1 - taxRate), tax: gross * taxRate };
}

// Latihan: biaya = level atribut saat ini + 1 emas.
export function trainCost(level) { return level + 1; }

// Latihan: jeda (cooldown) per atribut — makin tinggi level, makin lama.
// Jeda = 2 menit × level atribut BARU (setelah naik 1): LV 1 → 2 mnt,
// LV 5 → 10 mnt, LV 10 → 20 mnt. Satu konstanta supaya gampang diubah.
// Jeda dihitung PER ATRIBUT: melatih Kekuatan tidak mengunci Pendidikan /
// Ekonomi. Ditegakkan di server (POST /api/train), UI hanya menampilkan.
// PENDIDIKAN (Tahap 7): tiap level Pendidikan mempercepat SEMUA latihan —
// jeda −5% per level Pendidikan (maks −50%). Sebelum Tahap 7 deskripsi
// "Pelatihan lebih cepat" di UI adalah janji kosong: attr_edu tidak dipakai
// di mekanik apa pun. Sekarang efeknya nyata dan satu-satunya sumbernya
// fungsi ini (dipakai handler /api/train + tampilan /api/me).
export const TRAIN_COOLDOWN_MIN_PER_LEVEL = 2;
export const TRAIN_COOLDOWN_DISCOUNT_PER_EDU = 0.05;
export const TRAIN_COOLDOWN_DISCOUNT_MAX = 0.5;
export function trainCooldownMs(newLevel, eduLevel = 0) {
  const base = TRAIN_COOLDOWN_MIN_PER_LEVEL * 60 * 1000 * Math.max(0, newLevel);
  const discount = Math.min(TRAIN_COOLDOWN_DISCOUNT_MAX, TRAIN_COOLDOWN_DISCOUNT_PER_EDU * Math.max(0, eduLevel));
  return Math.round(base * (1 - discount));
}
// Format sisa jeda untuk pesan error + UI: "7 mnt" / "45 dtk".
export function formatCooldownMs(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 60) return `${Math.ceil(s / 60)} mnt`;
  return `${s} dtk`;
}

// --- Perjalanan: waktu tempuh antar wilayah (27 Nov 2026) ---
// Bepergian bukan lagi instan — perjalanan butuh waktu berdasar jarak
// antar ibu kota wilayah. Koordinat di bawah adalah ibu kota provinsi
// (data publik), dipakai menghitung jarak haversine.
// Waktu tempuh (menit) = 2 menit dasar + 1 menit per 100 km, minimal 2,
// maksimal 30. Acuan (saran Vincent, tiket #8): Kepri → Jakarta ±830 km
// = 10 menit. Jakarta → Jawa Barat ±116 km = 3 menit; terjauh (Jakarta →
// Papua ±3.750 km) dipangkas ke 30 menit agar tetap bisa dimainkan.
export const REGION_COORDS = {
  'Kepulauan Riau': [0.92, 104.45],
  'Jakarta': [-6.21, 106.85],
  'Jawa Barat': [-6.91, 107.61],
  'Jawa Tengah': [-6.97, 110.42],
  'Jawa Timur': [-7.26, 112.75],
  'Sumatera Utara': [3.59, 98.67],
  'Sumatera Barat': [-0.95, 100.35],
  'Sumatera Selatan': [-2.99, 104.76],
  'Kalimantan Barat': [-0.03, 109.32],
  'Kalimantan Timur': [-0.50, 117.15],
  'Kalimantan Selatan': [-3.32, 114.59],
  'Sulawesi Selatan': [-5.15, 119.43],
  'Sulawesi Utara': [1.47, 124.85],
  'Bali': [-8.67, 115.22],
  'Nusa Tenggara Barat': [-8.58, 116.12],
  'Nusa Tenggara Timur': [-10.18, 123.58],
  'Papua': [-2.53, 140.72],
};
function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b[0] - a[0]) * Math.PI / 180;
  const dLon = (b[1] - a[1]) * Math.PI / 180;
  const la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export function travelMinutesFor(fromName, toName) {
  const a = REGION_COORDS[fromName], b = REGION_COORDS[toName];
  if (!a || !b) return 10; // fallback bila koordinat belum ada
  return Math.min(30, Math.max(2, Math.round(2 + haversineKm(a, b) / 100)));
}
// Jeda pindah kewarganegaraan: 7 hari sejak pindah terakhir (anti-lompat
// pemilu/unifikasi — tanpa jeda, warga bisa pindah, memilih, lalu pindah
// lagi). Pindah pertama bebas (home_changed_at = 0 = belum pernah pindah).
export const MOVE_COOLDOWN_MS = 7 * DAY_MS;

// Makan: Makanan T1..T5 memberi 10/20/30/40/50 energi. Batas harian 10 unit.
export function foodEnergy(tier) { return tier * 10; }

// Kerusakan perang: dasar 20 + 5 per level Kekuatan; Drone x1.5.
export function warDamage(strength, ammo) {
  let d = 20 + 5 * strength;
  if (ammo === 'Drone') d = Math.round(d * 1.5);
  return d;
}

// Pemberontakan (Tahap 7): biaya emas untuk memulai pemberontakan di satu
// wilayah — 50 emas, 100 bila wilayahnya ibu kota (Jakarta). Dulu literal
// inline di api-core.js; satu konstanta supaya biaya yang ditampilkan di UI
// tidak bisa berbeda dari yang dipotong server.
export const REBEL_COST = 50;
export const REBEL_COST_CAPITAL = 100;
export const REBEL_CAPITAL_NAME = 'Jakarta';
// Perang pemberontakan berlangsung 24 jam (ends_at saat perang dibuat).
export const WAR_DURATION_MS = DAY_MS;

// --- Klaim harian (Tahap 7) ---
// Satu sumber kebenaran untuk hadiah pasokan harian — dulu literal 5/50/40
// di handler klaim (api-core.js) sementara README menulis +2 XP yang sudah
// usang sejak rescale XP ×20. Bonus ideologi/anggaran (+2 emas) BUKAN bagian
// dari konstanta ini — itu bonus di atas klaim dasar.
export const DAILY_CLAIM = { gold: 5, usd: 50, xp: 40 };

// --- Misi harian (masing-masing +10 emas saat diklaim) ---
export const DAILY_MISSIONS = [
  { key: 'energy', label: 'Habiskan 500 energi', target: 500, reward: 10 },
  { key: 'bread', label: 'Makan jatah roti harian (10)', target: 10, reward: 10 },
  { key: 'chat', label: 'Tulis 5 pesan obrolan', target: 5, reward: 10 },
];

// --- Chat (Tahap 7) ---
// Jeda antar pesan 5 detik (anti-spam, ditegakkan server); progres misi
// chat hanya dihitung untuk pesan ≥3 kata dan paling cepat 30 detik sekali
// (supaya spam pesan pendek tidak menyelesaikan misi).
export const CHAT_COOLDOWN_MS = 5000;
export const CHAT_COUNT_WINDOW_MS = 30000;
export const CHAT_COUNT_MIN_WORDS = 3;

// --- Kronik (tutorial) — 5 babak, 20 tugas ---
export const CHRONICLE = [
  {
    chapter: 1, title: 'Roti dan Kerja', reward: 10,
    tasks: [
      { key: 'claim', label: 'Ambil pasokan harian' },
      { key: 'job', label: 'Dapatkan pekerjaan' },
      { key: 'shift', label: 'Kerjakan satu giliran' },
      { key: 'train', label: 'Latih satu atribut' },
      { key: 'eat', label: 'Isi ulang energi dengan roti' },
      { key: 'map', label: 'Jelajahi peta' },
      { key: 'market', label: 'Lihat pasar' },
      { key: 'country', label: 'Kunjungi halaman negara' },
    ],
  },
  {
    chapter: 2, title: 'Warga Aktif', reward: 25,
    tasks: [
      { key: 'travel', label: 'Bepergian ke wilayah lain' },
      { key: 'buy', label: 'Beli sesuatu di pasar' },
      { key: 'sell', label: 'Pasang penawaran jual' },
      { key: 'chat5', label: 'Tulis 5 pesan obrolan' },
    ],
  },
  {
    chapter: 3, title: 'Pebisnis Muda', reward: 25,
    tasks: [
      { key: 'company', label: 'Dirikan perusahaan' },
      { key: 'fx', label: 'Cetak Rupiah dari emas / pasang penawaran valas' },
      { key: 'level5', label: 'Capai Level 5' },
      { key: 'party', label: 'Gabung atau dirikan partai' },
    ],
  },
  {
    chapter: 4, title: 'Politisi', reward: 25,
    tasks: [
      { key: 'law', label: 'Usulkan undang-undang' },
      { key: 'vote', label: 'Ikut memilih dalam pemilu / voting UU' },
    ],
  },
  {
    chapter: 5, title: 'Pejuang', reward: 30,
    tasks: [
      { key: 'attack', label: 'Serang di garis depan perang' },
      { key: 'article', label: 'Tulis satu artikel pers' },
    ],
  },
];

// --- Pencapaian (hadiah emas saat diklaim) ---
export const ACHIEVEMENTS = [
  { key: 'level_5', cat: 'LEVEL', label: 'Capai Level 5', target: 5, reward: 10 },
  { key: 'level_10', cat: 'LEVEL', label: 'Capai Level 10', target: 10, reward: 25 },
  { key: 'level_20', cat: 'LEVEL', label: 'Capai Level 20', target: 20, reward: 50 },
  { key: 'level_35', cat: 'LEVEL', label: 'Capai Level 35', target: 35, reward: 100 },
  { key: 'level_50', cat: 'LEVEL', label: 'Capai Level 50', target: 50, reward: 250 },
  { key: 'attack_1', cat: 'SERANGAN GARIS DEPAN', label: '1 serangan garis depan', target: 1, reward: 10 },
  { key: 'attack_25', cat: 'SERANGAN GARIS DEPAN', label: '25 serangan garis depan', target: 25, reward: 25 },
  { key: 'attack_100', cat: 'SERANGAN GARIS DEPAN', label: '100 serangan garis depan', target: 100, reward: 50 },
  { key: 'attack_500', cat: 'SERANGAN GARIS DEPAN', label: '500 serangan garis depan', target: 500, reward: 100 },
  { key: 'attack_2000', cat: 'SERANGAN GARIS DEPAN', label: '2000 serangan garis depan', target: 2000, reward: 250 },
  { key: 'law_1', cat: 'UNDANG-UNDANG DIUSULKAN', label: 'Usulkan 1 undang-undang', target: 1, reward: 10 },
  { key: 'law_10', cat: 'UNDANG-UNDANG DIUSULKAN', label: 'Usulkan 10 undang-undang', target: 10, reward: 25 },
  { key: 'law_50', cat: 'UNDANG-UNDANG DIUSULKAN', label: 'Usulkan 50 undang-undang', target: 50, reward: 100 },
  { key: 'recruit_1', cat: 'REKRUTAN SAH', label: '1 rekrutan mencapai Level 5', target: 1, reward: 10 },
  { key: 'recruit_5', cat: 'REKRUTAN SAH', label: '5 rekrutan mencapai Level 5', target: 5, reward: 25 },
  { key: 'recruit_25', cat: 'REKRUTAN SAH', label: '25 rekrutan mencapai Level 5', target: 25, reward: 100 },
  { key: 'buy_1', cat: 'PEMBELIAN DILAKUKAN', label: '1 pembelian di pasar', target: 1, reward: 10 },
  { key: 'buy_25', cat: 'PEMBELIAN DILAKUKAN', label: '25 pembelian di pasar', target: 25, reward: 25 },
  { key: 'buy_250', cat: 'PEMBELIAN DILAKUKAN', label: '250 pembelian di pasar', target: 250, reward: 100 },
];

export function achievementProgress(citizen, key) {
  if (key.startsWith('level_')) return citizen.level;
  if (key.startsWith('attack_')) return citizen.frontline_attacks;
  if (key.startsWith('law_')) return citizen.laws_proposed;
  if (key.startsWith('recruit_')) return citizen.recruits;
  if (key.startsWith('buy_')) return citizen.purchases;
  return 0;
}

// --- Perusahaan ---
export const COMPANY_TYPES = [
  { type: 'resource', name: 'Pabrik Sumber Daya', cost: 100, desc: 'Menghasilkan bahan mentah setiap hari.' },
  { type: 'factory', name: 'Pabrik', cost: 100, desc: 'Mengolah bahan mentah menjadi komponen.' },
  { type: 'light', name: 'Industri Ringan', cost: 250, desc: 'Memproduksi barang konsumsi setiap hari.' },
  { type: 'heavy', name: 'Industri Berat', cost: 500, desc: 'Memproduksi kapal, drone, dan alat berat.' },
];
export const RESOURCE_PRODUCTS = ['Gandum Mentah', 'Besi Mentah', 'Minyak Mentah', 'Kapas Mentah', 'Kayu', 'Batu Bara', 'Tembaga Mentah'];
// Produksi harian per perusahaan (unit), sebelum bonus wilayah.
export const DAILY_PRODUCTION = { resource: 20, factory: 10, light: 8, heavy: 3 };
// Bonus shift karyawan (v2.4.0): tiap shift penuh menambah ~1/10 produksi
// harian ke inventaris pemilik — dihitung dalam persepuluh unit (kolom
// companies.bonus_credit) supaya produk bernilai tinggi (Drone, 3/hari)
// tetap adil: 1 Drone butuh ~4 shift penuh, bukan 0 atau 1 utuh.
// Angka per shift penuh (unit): resource 2, factory 1, light 0,8, heavy 0,3.
export const SHIFT_BONUS_DIVISOR = 10;
export function companyProduct(co) {
  if (co.type === 'factory') return 'Bahan Bangunan';
  if (co.type === 'light') return 'Makanan';
  if (co.type === 'heavy') return 'Drone';
  return co.resource || '';
}
export function shiftBonusText(co) {
  const per = (DAILY_PRODUCTION[co.type] || 0) / SHIFT_BONUS_DIVISOR;
  const s = Number.isInteger(per) ? String(per) : per.toFixed(1).replace('.', ',');
  return `${s}× ${companyProduct(co)} per shift penuh`;
}

// --- Toko (harga rupiah, top-up manual via WhatsApp) ---
export const SHOP_PACKAGES = [
  { id: 'pemula', name: 'PAKET PEMULA', tagline: 'Langkah pertama ke lingkaran dalam.', price: 15000, was: 17000, save: 'HEMAT 12%', premiumMonths: 1, gold: 1000 },
  { id: 'deluxe', name: 'PAKET DELUXE', tagline: 'Satu musim keistimewaan dengan emas berlimpah.', price: 50000, was: 58000, save: 'HEMAT 14%', premiumMonths: 6, gold: 5000, best: true },
  { id: 'ultimate', name: 'PAKET ULTIMATE', tagline: 'Setahun penuh di puncak — tingkat negarawan.', price: 100000, was: 125000, save: 'HEMAT 20%', premiumMonths: 12, gold: 20000 },
];
export const SHOP_PREMIUM = [
  { months: 1, price: 5000, perMonth: 5000 },
  { months: 3, price: 15000, perMonth: 5000 },
  { months: 6, price: 25000, perMonth: 4167 },
  { months: 12, price: 45000, perMonth: 3750 },
];
export const PREMIUM_PERKS = 'Batas energi +20, +1 slot konvoi, dan namamu berwarna Premium di chat.';

// --- Batas energi & regen (Tahap 4) ---
// Batas dasar naik 5 per level: 100 + 5×(level−1). Bonus lama tetap
// menumpuk di atasnya: Premium +20, Rumah Sakit Lapangan +10.
// Dulu (Tahap 3) batas di-hardcode 100/110/120 — kini satu rumus ini
// satu-satunya sumber kebenaran (dipakai /api/me, eat, tick, regen).
export function energyCapFor(level, isPremium, hasHealth) {
  return 100 + 5 * (Math.max(1, level) - 1) + (isPremium ? 20 : 0) + (hasHealth ? 10 : 0);
}
// Regen energi: +2 tiap 1 menit, dihitung malas (lazy) dari waktu berlalu
// saat data warga dibaca — pemain offline pun pulih saat kembali.
export const ENERGY_REGEN_PER_MIN = 2;
export const ENERGY_REGEN_MS = 60 * 1000;

// --- Rantai produksi tahap 1 (Tahap 4) ---
// Pabrik tidak lagi mencetak Bahan Bangunan gratis: tiap 1 unit Bahan
// Bangunan butuh 2× Besi Mentah dari inventaris pemilik. Bila bahan kurang,
// produksi hari itu hanya sebanyak yang bahannya cukup (bisa 0).
export const FACTORY_INPUT = { commodity: 'Besi Mentah', perUnit: 2 };

// Rantai produksi penuh (Tahap 6): SEMUA jenis perusahaan kini butuh bahan
// baku — bukan cuma Pabrik. Satu peta, satu sumber kebenaran untuk tick
// harian (tick.js) DAN bonus shift (api-core.js), supaya angka keduanya
// tidak pernah berbeda:
//   resource (Pabrik Sumber Daya): menambang — tanpa input.
//   factory (Pabrik): 2× Besi Mentah per 1× Bahan Bangunan.
//   light (Industri Ringan): 1× Gandum Mentah per 1× Makanan.
//   heavy (Industri Berat): 1× Besi Mentah + 1× Minyak Mentah per 1× Drone.
// FACTORY_INPUT di atas dipertahankan sebagai alias lama (dipakai tes lama).
export const PRODUCTION_INPUT = {
  resource: [],
  factory: [{ commodity: 'Besi Mentah', perUnit: 2 }],
  light: [{ commodity: 'Gandum Mentah', perUnit: 1 }],
  heavy: [{ commodity: 'Besi Mentah', perUnit: 1 }, { commodity: 'Minyak Mentah', perUnit: 1 }],
};
export function productionInputsFor(type) { return PRODUCTION_INPUT[type] || []; }
export function productionInputText(type) {
  const inputs = productionInputsFor(type);
  if (!inputs.length) return 'Tanpa bahan baku — menambang langsung dari wilayah.';
  return 'Butuh: ' + inputs.map((i) => `${i.perUnit}× ${i.commodity}`).join(' + ') + ' per unit.';
}

// --- Militer (Tahap 6) ---
// Unit militer direkrut warga dengan komoditas + USD, dirawat harian dari
// USD, dan memperkuat serangan perang. Angka dipilih supaya militer terasa
// tapi tidak mendominasi: kekuatan total 100 memberi pengali maksimal ×1,5
// (setara bonus konvoi + anggaran + mobilisasi + pakta + nasionalisme
// sekaligus — tapi butuh 50 Infanteri atau 20 Drone, bukan gratis).
export const MILITARY_UNITS = {
  infantry: { type: 'infantry', name: 'Infanteri', commodity: 'Senjata', commodityQty: 1, usd: 5, power: 2, upkeep: 1, desc: 'Pasukan darat — murah, mudah direkrut massal.' },
  drone: { type: 'drone', name: 'Drone Perang', commodity: 'Drone', commodityQty: 1, usd: 10, power: 5, upkeep: 2, desc: 'Serangan udara presisi — kerusakan +50% dari Senjata.' },
  heavy: { type: 'heavy', name: 'Kendaraan Berat', commodity: 'Bahan Bangunan', commodityQty: 2, usd: 20, power: 12, upkeep: 5, desc: 'Tank dan kendaraan lapis baja — kekuatan terbesar per unit.' },
};
// Batas pasukan: 50 + 10 per level (Level 1 = 60 unit, Level 10 = 150).
// Tanpa batas, pemain kaya bisa menumpuk ribuan unit dan pengali perang
// pecah — batas ini yang menjaga ×1,5 tetap maksimal.
export const UNIT_CAP_BASE = 50;
export const UNIT_CAP_PER_LEVEL = 10;
export function unitCapFor(level) { return UNIT_CAP_BASE + UNIT_CAP_PER_LEVEL * Math.max(1, level); }
// Kekuatan total = jumlah (qty × power) semua unit. Pengali kerusakan =
// 1 + min(kekuatan, 100) / 200 — kekuatan 20 → ×1,10; 100 → ×1,50 (maks).
export function militaryPowerFor(units) {
  return (units || []).reduce((s, u) => s + (MILITARY_UNITS[u.type || u.unit_type]?.power || 0) * (u.qty || 0), 0);
}
export function unitDamageMult(power) { return 1 + Math.min(Math.max(0, power || 0), 100) / 200; }
export function unitUpkeepFor(units) {
  return (units || []).reduce((s, u) => s + (MILITARY_UNITS[u.type || u.unit_type]?.upkeep || 0) * (u.qty || 0), 0);
}
export function unitCountFor(units) {
  return (units || []).reduce((s, u) => s + (u.qty || 0), 0);
}

// --- Reputasi dagang (Tahap 6) ---
// Tiap transaksi pasar yang SELESAI (beli penawaran / jual ke order beli)
// menambah 1 hitungan untuk pembeli DAN penjual. Tier murni prestise +
// informasi (bukan diskon — emas/USD/harga yang berjalan TIDAK diubah).
export const TRADE_REPUTATION_TIERS = [
  { min: 0, label: 'Pedagang Baru' },
  { min: 10, label: 'Pedagang Aktif' },
  { min: 50, label: 'Pedagang Terpercaya' },
  { min: 150, label: 'Saudagar Besar' },
];
export function tradeReputation(count) {
  const c = Math.max(0, count || 0);
  let cur = TRADE_REPUTATION_TIERS[0];
  let next = null;
  for (const t of TRADE_REPUTATION_TIERS) {
    if (c >= t.min) cur = t;
    else { next = t; break; }
  }
  return { label: cur.label, count: c, nextMin: next?.min ?? null, nextLabel: next?.label ?? null };
}

// --- Event dunia mingguan (Tahap 6) ---
// Satu event berlaku satu minggu dunia (7 hari), bergilir deterministik
// dari nomor hari — tidak ada acak server, tidak ada "bot" yang bermain.
// Efeknya kecil dan sementara (±10–50%), tidak mengubah harga dasar,
// emas, atau USD yang berjalan. Diumumkan lewat notifikasi saat minggu
// berganti + tampil di dashboard dan /api/world.
export const WORLD_EVENTS = [
  { key: 'panen', name: 'Panen Raya', icon: '🌾', effect: 'Upah bahan ADMIN +20%', desc: 'Hasil panen melimpah di seluruh wilayah — upah bahan mentah ADMIN naik 20% minggu ini.' },
  { key: 'festival', name: 'Festival Rakyat', icon: '🎉', effect: 'XP shift +50%', desc: 'Festival rakyat semarak — setiap giliran kerja memberi XP 50% lebih banyak minggu ini.' },
  { key: 'badai', name: 'Badai Besar', icon: '⛈️', effect: 'Perjalanan +5 menit', desc: 'Badai besar melanda kepulauan — semua perjalanan lebih lama 5 menit minggu ini.' },
  { key: 'wabah', name: 'Wabah Melanda', icon: '🤒', effect: 'Biaya latihan +2 emas', desc: 'Wabah melanda — pelatih menaikkan biaya latihan 2 emas minggu ini.' },
  { key: 'booming', name: 'Pasar Bergairah', icon: '📈', effect: 'Pajak penghasilan −1 poin', desc: 'Pasar sedang bergairah — pajak penghasilan turun 1 poin minggu ini.' },
  { key: 'darurat', name: 'Darurat Militer', icon: '⚠️', effect: 'Kerusakan perang +10%', desc: 'Darurat militer diberlakukan — semua serangan perang 10% lebih kuat minggu ini.' },
];
export function worldEventFor(day) {
  const d = Math.max(1, Number(day) || 1);
  return WORLD_EVENTS[Math.floor((d - 1) / 7) % WORLD_EVENTS.length];
}
export function worldEventEndsDay(day) {
  const d = Math.max(1, Number(day) || 1);
  return (Math.floor((d - 1) / 7) + 1) * 7;
}

// --- Batas harga wajar (Tahap 4) ---
// Harga jual/order beli ditolak bila di luar 0,25×–4× median harga transaksi
// 14 hari terakhir (butuh ≥3 transaksi sebagai pembanding; pasar yang masih
// kosong tidak dibatasi). Penolakan dicatat di market_flags (bukan ban).
export const PRICE_BAND = { minMult: 0.25, maxMult: 4, minTx: 3, days: 14 };
// Wash trading: ≥3 transaksi bolak-balik antara pasangan pembeli↔penjual
// yang sama dalam 24 jam → dicatat di market_flags (log saja, bukan ban).
export const WASH_TRADE = { minTx: 3, hours: 24 };

// --- Retensi data (Tahap 4, audit §5.6) ---
// Dijalankan tiap tick harian. Notifikasi yang belum dibaca TIDAK dihapus;
// riwayat kas negara (treasury_tx) + pengumuman disimpan selamanya.
export const RETENTION = { chatDays: 90, notifReadDays: 30, txDays: 180 };

// --- Bonus bangunan konvoi (Tahap 3 — BUG-7: janji kini DITERAPKAN) ---
// Sebelum Tahap 3, CONVOY_BUILDINGS hanya teks di toko/konvoi tanpa efek
// mekanik. Sekarang tiap bangunan aktif memberi bonus nyata (lihat tick.js,
// api-core.js latih/makan, api-civic.js serang):
export const ENERGY_DAILY = 100;        // pemulihan energi harian dasar (level 1, tanpa bonus)
// Sekolah Keliling: latihan 10% lebih murah (minimal 1 emas).
export function trainCostDiscounted(cost) { return Math.max(1, Math.floor(cost * 0.9)); }
// Gudang Industri: produksi perusahaan +10% (dibulatkan).
export function productionWithBonus(amount) { return Math.round(amount * 1.1); }
// Pos Militer: kerusakan perang +10% (dibulatkan).
export function warDamageWithBonus(damage) { return Math.round(damage * 1.1); }

// --- Bangunan konvoi ---
// Biaya BANGUN: BAHAN MENTAH dari inventaris pembangun (tiket #20 LIO,
// 28 Nov 2026) — bukan lagi 10 emas. Resep dipilih mengikuti contoh
// pemain (RS Lapangan: 20 Gandum + 30 Besi) dan seimbang dengan upah
// ADMIN (1 shift ≈ 38–44 bahan): 1–2 shift cukup untuk 1 bangunan.
export const CONVOY_BUILDINGS = [
  { type: 'health', name: 'Rumah Sakit Lapangan', desc: '+10% pemulihan energi harian', cost: [{ name: 'Gandum Mentah', qty: 20 }, { name: 'Besi Mentah', qty: 30 }] },
  { type: 'education', name: 'Sekolah Keliling', desc: 'Latihan 10% lebih murah', cost: [{ name: 'Kayu', qty: 20 }, { name: 'Kapas Mentah', qty: 20 }] },
  { type: 'industry', name: 'Gudang Industri', desc: '+10% produksi perusahaan', cost: [{ name: 'Besi Mentah', qty: 30 }, { name: 'Batu Bara', qty: 20 }] },
  { type: 'military', name: 'Pos Militer', desc: '+10% kerusakan perang', cost: [{ name: 'Besi Mentah', qty: 30 }, { name: 'Minyak Mentah', qty: 10 }] },
];

// Slot konvoi (Tahap 7): 1 slot dasar + 1 per ambang level (25/50/100) +
// 1 bila Premium aktif. Dulu rumus yang sama ditulis 3× di api-core.js
// (GET + POST /api/convoy) — sekarang satu fungsi, dipakai server di
// kedua endpoint. Premium memberi +1 slot (bukan "slot keempat" seperti
// yang dulu tertulis di teks toko — teksnya ikut diperbaiki).
export const CONVOY_SLOT_LEVELS = [25, 50, 100];
export function convoySlotsFor(citizen) {
  const levelSlots = CONVOY_SLOT_LEVELS.filter((lv) => (citizen?.level || 0) >= lv).length;
  const premiumSlot = (citizen?.premium_until || 0) > Date.now() ? 1 : 0;
  return 1 + levelSlots + premiumSlot;
}

// --- Minuman energi (tiket #17 LIO, 28 Nov 2026) ---
// Kaleng minuman energi: dibeli di Inventaris seharga 0,10 emas/kaleng,
// sekali minum +1 energi (dibatasi cap energi pemain).
export const ENERGY_DRINK_NAME = 'Minuman Energi';
export const ENERGY_DRINK_PRICE_GOLD = 0.10;
export const ENERGY_DRINK_ENERGY = 1;

// --- Redesain dunia (27 Nov 2026): tanpa negara awal + parlemen 2 Des ---
// Dunia mulai TERPECAH: semua wilayah merdeka (tidak bernegara). Warga yang
// membentuk negara; wilayah bisa bergabung (unifikasi) lewat voting warga
// wilayah itu. Parlemen sebagai fitur dibuka 2 Desember 2026 00:00 WIB —
// tanggal buka disimpan di db_meta ('parliament_opens_at') supaya bisa
// diubah admin tanpa deploy; konstanta ini hanya nilai SEED-nya.
export const PARLIAMENT_OPENS_AT_DEFAULT = Date.parse('2026-12-02T00:00:00+07:00');
export function parliamentOpen(now = Date.now(), opensAt = PARLIAMENT_OPENS_AT_DEFAULT) { return now >= opensAt; }
// Format sisa waktu sampai parlemen dibuka, gaya "4 hari 11 jam 30 mnt".
export function parliamentCountdownText(now = Date.now(), opensAt = PARLIAMENT_OPENS_AT_DEFAULT) {
  const ms = Math.max(0, opensAt - now);
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d} hari ${h} jam ${mm} mnt`;
  if (h > 0) return `${h} jam ${mm} mnt`;
  return `${mm} mnt`;
}

// --- Ideologi negara (dipilih presiden ATAU lewat UU jenis 'ideology') ---
// Efeknya NYATA (bukan teks): klaim harian, upah ADMIN, pajak, kerusakan
// perang. Konservatisme netral (baseline). Daftar ini satu-satunya sumber
// kebenaran — dipakai server (pajak/upah/klaim/perang) + halaman Negara.
export const COUNTRY_IDEOLOGIES = [
  { id: 'Konservatisme', label: 'Konservatisme', desc: 'Netral — tanpa efek angka.', claimBonus: 0, adminPayMult: 1, taxDelta: 0, warDamageMult: 1 },
  { id: 'Sosialisme', label: 'Sosialisme', desc: 'Pasokan harian +2 emas; upah lowongan ADMIN +10%.', claimBonus: 2, adminPayMult: 1.1, taxDelta: 0, warDamageMult: 1 },
  { id: 'Liberalisme', label: 'Liberalisme', desc: 'Pajak penghasilan −1 poin (minimal 0%).', claimBonus: 0, adminPayMult: 1, taxDelta: -1, warDamageMult: 1 },
  { id: 'Nasionalisme', label: 'Nasionalisme', desc: 'Kerusakan perang +10% untuk semua warga negara.', claimBonus: 0, adminPayMult: 1, taxDelta: 0, warDamageMult: 1.1 },
];
export function ideologyDef(id) {
  return COUNTRY_IDEOLOGIES.find((x) => x.id === id) || COUNTRY_IDEOLOGIES[0];
}

// --- Sistem pemerintahan (dipilih presiden ATAU lewat UU jenis 'system') ---
// Efeknya TATA KELOLA (bukan sekadar label):
// - presidensial: presiden dipilih seluruh warga negara; mengangkat menteri.
// - parlementer: presiden dipilih HANYA oleh anggota parlemen.
// - imperial: presiden bergelar Kaisar; TIDAK ada pemilu presiden otomatis —
//   menjabat sampai dimakzulkan (bila kosong, pemilu pengisi kekosongan
//   dijadwalkan sekali).
// - diktator: presiden bergelar Diktator; tanpa pemilu otomatis; presiden
//   bisa mengubah pajak penghasilan langsung 1–5% tanpa parlemen.
export const GOVERNMENT_SYSTEMS = [
  { id: 'presidensial', label: 'Presidensial', desc: 'Presiden dipilih seluruh warga negara; mengangkat menteri.', presidentTitle: 'Presiden', autoPresidentElection: true },
  { id: 'parlementer', label: 'Parlementer', desc: 'Presiden dipilih hanya oleh anggota parlemen.', presidentTitle: 'Presiden', autoPresidentElection: true },
  { id: 'imperial', label: 'Imperial', desc: 'Presiden bergelar Kaisar; tanpa pemilu otomatis — menjabat sampai dimakzulkan.', presidentTitle: 'Kaisar', autoPresidentElection: false },
  { id: 'diktator', label: 'Diktator', desc: 'Presiden bergelar Diktator; tanpa pemilu otomatis; presiden bisa mengubah pajak langsung (1–5%).', presidentTitle: 'Diktator', autoPresidentElection: false },
];
export function systemDef(id) {
  return GOVERNMENT_SYSTEMS.find((x) => x.id === id) || GOVERNMENT_SYSTEMS[0];
}

// --- Mendirikan negara + unifikasi wilayah ---
// Pendiri: Level 10 + 100 emas; wilayah pendiri harus merdeka (belum
// bernegara) dan menjadi ibu kota + wilayah pertama. Unifikasi: warga
// wilayah merdeka (Level 5) mengusulkan wilayahnya bergabung ke sebuah
// negara; warga wilayah itu voting 3 hari; lolos bila YA > TIDAK dan YA
// minimal 3 (supaya satu orang tidak bisa menyeret satu wilayah).
export const COUNTRY_FORM_MIN_LEVEL = 10;
export const COUNTRY_FORM_COST_GOLD = 100;
export const COUNTRY_JOIN_MIN_LEVEL = 5;
export const COUNTRY_JOIN_VOTE_DAYS = 3;
export const COUNTRY_JOIN_MIN_YES = 3;
// Jadwal pemilu pertama sebuah negara baru: presiden 7 hari setelah
// didirikan; parlemen paling cepat saat parlemen dibuka (2 Des 2026),
// atau 3 hari setelah didirikan bila negara itu baru dibentuk sesudahnya.
export const PRESIDENT_ELECTION_DELAY_DAYS = 7;
export const PARLIAMENT_ELECTION_DELAY_DAYS = 3;
// Pemilu (Tahap 7): masa pemungutan suara 3 hari — dulu literal
// `3 * 24 * 60 * 60 * 1000` di 6 tempat (pendirian negara + tick
// ensureElections). Syarat usia warga untuk memilih juga 3 hari, tapi itu
// aturan BERBEDA (bukan durasi pemilu) — konstanta terpisah supaya
// mengubah satu tidak ikut mengubah yang lain.
export const ELECTION_VOTE_DAYS = 3;
export const ELECTION_VOTE_MS = ELECTION_VOTE_DAYS * DAY_MS;
export const ELECTION_VOTE_MIN_AGE_DAYS = 3;
export const ELECTION_VOTE_MIN_AGE_MS = ELECTION_VOTE_MIN_AGE_DAYS * DAY_MS;
// Pemilu parlemen berulang tiap 30 hari (siklusnya, bukan masa voting).
export const PARLIAMENT_ELECTION_CYCLE_DAYS = 30;

// --- Undang-undang bermuatan mekanik (Tahap 5 — BUG-9) ---
// Sebelum Tahap 5, UU yang disahkan hanya berubah status jadi 'executed'
// tanpa efek apa pun (teater). Sekarang tiap UU punya JENIS + NILAI, dan
// saat lolos voting, tick menerapkan efeknya ke baris country (satu-satunya
// sumber kebenaran tarif/angka negara — bukan hardcode di game.js).
// 'general' = UU umum tanpa efek mekanik (tetap boleh diusulkan; UI wajib
// jujur menyebutnya tidak mengubah angka game).
// value disimpan apa adanya di laws.value; validasi rentang di api-civic.js.
export const LAW_KINDS = {
  tax_income: { label: 'Ubah Pajak Penghasilan', hint: 'Tarif baru 1–5% (saat ini lihat halaman Negara). Berlaku untuk penjualan pasar + gaji.', min: 1, max: 5 },
  // (Tahap 7) Pajak impor bisa diubah parlemen — sebelumnya jenis UU ini
  // tidak ada, jadi kolom tax_import tidak bisa diubah dan pasar global
  // mengabaikannya. Efeknya: harga beli pasar global + tarif impor negara
  // pembeli; pajaknya masuk kas negara pembeli.
  tax_import: { label: 'Ubah Pajak Impor', hint: 'Tarif baru 1–5% (saat ini lihat halaman Negara). Berlaku untuk pembelian di pasar global.', min: 1, max: 5 },
  admin_pay: { label: 'Ubah Upah Lowongan ADMIN', hint: 'Upah baru 80–120% dari upah dasar (100% = normal). Berlaku untuk semua lowongan ADMIN.', min: 80, max: 120 },
  travel: { label: 'Ubah Biaya Perjalanan', hint: 'Tiket yang dibutuhkan per perjalanan: 1 atau 2.', min: 1, max: 2 },
  // Redesain dunia: ideologi/sistem bisa diubah parlemen lewat UU (nilai =
  // indeks daftar: ideologi 0=Konservatisme, 1=Sosialisme, 2=Liberalisme,
  // 3=Nasionalisme; sistem 0=Presidensial, 1=Parlementer, 2=Imperial,
  // 3=Diktator) ATAU langsung oleh presiden (lihat /api/country/ideology
  // dan /api/country/system). Presiden tetap bisa mengubah langsung walau
  // UU jenis ini juga tersedia — sesuai perintah pemilik.
  ideology: { label: 'Ubah Ideologi Negara', hint: 'Ideologi baru (angka): 0=Konservatisme, 1=Sosialisme, 2=Liberalisme, 3=Nasionalisme.', min: 0, max: 3 },
  system: { label: 'Ubah Sistem Pemerintahan', hint: 'Sistem baru (angka): 0=Presidensial, 1=Parlementer, 2=Imperial, 3=Diktator.', min: 0, max: 3 },
  general: { label: 'UU Umum (tanpa efek angka)', hint: 'Pernyataan/aturan umum — tidak mengubah angka game.', min: null, max: null },
};
// Kalimat efek untuk notifikasi + arsip UU (dipakai tick saat UU disahkan).
export function lawEffectText(kind, value) {
  if (kind === 'tax_income') return `Pajak penghasilan kini ${value}%.`;
  if (kind === 'tax_import') return `Pajak impor kini ${value}%.`;
  if (kind === 'admin_pay') return `Upah lowongan ADMIN kini ${value}% dari upah dasar.`;
  if (kind === 'travel') return `Perjalanan kini butuh ${value} Tiket.`;
  if (kind === 'ideology') return `Ideologi negara kini ${COUNTRY_IDEOLOGIES[Math.round(Number(value))]?.label || value}.`;
  if (kind === 'system') return `Sistem pemerintahan kini ${GOVERNMENT_SYSTEMS[Math.round(Number(value))]?.label || value}.`;
  return 'UU umum — tidak mengubah angka game.';
}

// --- Anggaran negara (Tahap 5) — wewenang Menteri Ekonomi ---
// Menteri Ekonomi mengusulkan anggaran; parlemen voting 3 hari; bila lolos,
// biayanya dipotong dari kas negara dan efeknya berlaku 7 hari. Satu
// anggaran aktif dalam satu waktu (yang baru menggantikan yang lama).
export const BUDGET_KINDS = {
  claim: { label: 'Pasokan Harian +2 Emas', desc: 'Klaim harian memberi +2 emas tambahan (7 emas) selama 7 hari.', min: 50, max: 500 },
  train: { label: 'Latihan 10% Lebih Murah', desc: 'Biaya latihan semua warga 10% lebih murah selama 7 hari.', min: 50, max: 500 },
  war: { label: 'Dana Perang (+10% Kerusakan)', desc: 'Serangan garis depan semua warga +10% kerusakan selama 7 hari.', min: 50, max: 500 },
};
export const BUDGET_DURATION_MS = 7 * DAY_MS;
export const BUDGET_VOTE_DAYS = 3;

// --- Mobilisasi & hari libur (Tahap 5) — wewenang menteri ---
// Mobilisasi (Menteri Pertahanan): 100 emas kas negara, kerusakan perang
// semua warga +10% selama 24 jam. Hari libur (Menteri Dalam Negeri):
// 50 emas kas negara, semua warga +20 energi (maks batas masing-masing),
// sekali per 24 jam.
export const MOBILIZE_COST_GOLD = 100;
export const MOBILIZE_DURATION_MS = DAY_MS;
export const MOBILIZE_DAMAGE_MULT = 1.1;
export const HOLIDAY_COST_GOLD = 50;
export const HOLIDAY_ENERGY = 20;
export const HOLIDAY_COOLDOWN_MS = DAY_MS;

// --- Pakta antar organisasi (Tahap 5 — diplomasi tanpa multi-negara) ---
// Dua organisasi bisa mengikat pakta (harus disetujui ketua kedua belah
// pihak). Perjanjian dagang: pajak penghasilan jual-beli antar anggota
// kedua organisasi dipotong setengah. Pakta pertahanan: anggota kedua
// organisasi mendapat +10% kerusakan perang.
export const PACT_KINDS = {
  trade: { label: 'Perjanjian Dagang', desc: 'Pajak penghasilan antar anggota kedua organisasi dipotong 50%.' },
  defense: { label: 'Pakta Pertahanan', desc: 'Anggota kedua organisasi +10% kerusakan perang.' },
};
export const TRADE_PACT_TAX_MULT = 0.5;
export const DEFENSE_PACT_DAMAGE_MULT = 1.1;
export const BUDGET_WAR_DAMAGE_MULT = 1.1;
