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
export function shiftSalary(baseSalary, economyAttr, fatigue) {
  const mult = fatigueMult(fatigue);
  const gross = baseSalary * (1 + 0.03 * economyAttr) * mult;
  return { gross, net: gross * (1 - INCOME_TAX), tax: gross * INCOME_TAX };
}

// Latihan: biaya = level atribut saat ini + 1 emas.
export function trainCost(level) { return level + 1; }

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
      { key: 'fx', label: 'Cetak USD dari emas / pasang penawaran valas' },
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

// --- Bonus bangunan konvoi (Tahap 3 — BUG-7: janji kini DITERAPKAN) ---
// Sebelum Tahap 3, CONVOY_BUILDINGS hanya teks di toko/konvoi tanpa efek
// mekanik. Sekarang tiap bangunan aktif memberi bonus nyata (lihat tick.js,
// api-core.js latih/makan, api-civic.js serang):
export const ENERGY_DAILY = 100;        // pemulihan energi harian dasar
export const ENERGY_DAILY_HEALTH = 110; // Rumah Sakit Lapangan: +10%
export const ENERGY_CAP_PREMIUM = 120;  // batas energi Premium
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
