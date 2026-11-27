// Aturan main Parlementer — angka-angka inti (diadaptasi dari mekanik referensi).
export const WA_TOPUP_URL = 'https://wa.me/6285220743283';
export const MINT_RATE = 10; // 1 emas dicetak jadi 10 USD
export const INCOME_TAX = 0.02;
export const IMPORT_TAX = 0.02;
export const MIN_OFFER_QTY = 10;

// XP: naik level butuh level*5 XP (level 1 -> 5 XP, level 2 -> 10 XP, dst.)
export function xpForLevel(level) { return level * 5; }

export function xpGainForShift() { return 1; }

// Kelelahan menurunkan hasil kerja: mulai 10.000 (×0,75), 15.000 (×0,5).
// Berlaku untuk gaji USD maupun upah bahan mentah.
export function fatigueMult(fatigue) {
  if (fatigue >= 15000) return 0.5;
  if (fatigue >= 10000) return 0.75;
  return 1;
}

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
export const TRAIN_COOLDOWN_MIN_PER_LEVEL = 2;
export function trainCooldownMs(newLevel) { return TRAIN_COOLDOWN_MIN_PER_LEVEL * 60 * 1000 * Math.max(0, newLevel); }
// Format sisa jeda untuk pesan error + UI: "7 mnt" / "45 dtk".
export function formatCooldownMs(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 60) return `${Math.ceil(s / 60)} mnt`;
  return `${s} dtk`;
}

// Makan: Makanan T1..T5 memberi 10/20/30/40/50 energi. Batas harian 10 unit.
export function foodEnergy(tier) { return tier * 10; }

// Kerusakan perang: dasar 20 + 5 per level Kekuatan; Drone x1.5.
export function warDamage(strength, ammo) {
  let d = 20 + 5 * strength;
  if (ammo === 'Drone') d = Math.round(d * 1.5);
  return d;
}

// --- Misi harian (masing-masing +10 emas saat diklaim) ---
export const DAILY_MISSIONS = [
  { key: 'energy', label: 'Habiskan 500 energi', target: 500, reward: 10 },
  { key: 'bread', label: 'Makan jatah roti harian (10)', target: 10, reward: 10 },
  { key: 'chat', label: 'Tulis 5 pesan obrolan', target: 5, reward: 10 },
];

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

// --- Toko (harga rupiah, top-up manual via WhatsApp) ---
export const SHOP_PACKAGES = [
  { id: 'pemula', name: 'PAKET PEMULA', tagline: 'Langkah pertama ke lingkaran dalam.', price: 15000, was: 17000, save: 'HEMAT 12%', premiumMonths: 1, gold: 1000 },
  { id: 'deluxe', name: 'PAKET DELUXE', tagline: 'Satu musim keistimewaan dan peti perang yang serius.', price: 50000, was: 58000, save: 'HEMAT 14%', premiumMonths: 6, gold: 5000, best: true },
  { id: 'ultimate', name: 'PAKET ULTIMATE', tagline: 'Setahun penuh di puncak — tingkat negarawan.', price: 100000, was: 125000, save: 'HEMAT 20%', premiumMonths: 12, gold: 20000 },
];
export const SHOP_PREMIUM = [
  { months: 1, price: 5000, perMonth: 5000 },
  { months: 3, price: 15000, perMonth: 5000 },
  { months: 6, price: 25000, perMonth: 4167 },
  { months: 12, price: 45000, perMonth: 3750 },
];
export const PREMIUM_PERKS = 'Batas energi 120 (bukan 100), slot konvoi keempat, dan namamu berwarna Premium di chat.';

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
export const CONVOY_BUILDINGS = [
  { type: 'health', name: 'Rumah Sakit Lapangan', desc: '+10% pemulihan energi harian' },
  { type: 'education', name: 'Sekolah Keliling', desc: 'Latihan 10% lebih murah' },
  { type: 'industry', name: 'Gudang Industri', desc: '+10% produksi perusahaan' },
  { type: 'military', name: 'Pos Militer', desc: '+10% kerusakan perang' },
];

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
export const BUDGET_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
export const BUDGET_VOTE_DAYS = 3;

// --- Mobilisasi & hari libur (Tahap 5) — wewenang menteri ---
// Mobilisasi (Menteri Pertahanan): 100 emas kas negara, kerusakan perang
// semua warga +10% selama 24 jam. Hari libur (Menteri Dalam Negeri):
// 50 emas kas negara, semua warga +20 energi (maks batas masing-masing),
// sekali per 24 jam.
export const MOBILIZE_COST_GOLD = 100;
export const MOBILIZE_DURATION_MS = 24 * 60 * 60 * 1000;
export const MOBILIZE_DAMAGE_MULT = 1.1;
export const HOLIDAY_COST_GOLD = 50;
export const HOLIDAY_ENERGY = 20;
export const HOLIDAY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

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
