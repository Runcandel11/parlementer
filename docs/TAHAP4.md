# TAHAP 4 — Pasar/Ekonomi (AUDIT §7 + 7 tambahan Khalid, 27 Nov 2026)

Tanggal: 2026-11-27. Basis: commit 9403ea7 (Tahap 3, sudah live + terverifikasi).
Aturan game TIDAK berubah: 100% online tanpa bot, pasar mulai dari 0
penawaran, lowongan ADMIN dibayar bahan mentah (bukan uang), harga toko
rupiah + WhatsApp, admin hanya Khalid, referral referrer +100 emas + 2 hari
premium / pemain baru +50 emas + 1 hari premium. Perilaku Tahap 2–3 TIDAK
diubah — kecuali yang disebut eksplisit di bawah (rumus batas energi,
isi energi admin, teks deskripsi panel Buku).

## 1. Grafik harga per komoditas (audit §7.1)

- `GET /api/market/prices?scope&commodity_id&days` (maks 30 hari):
  agregasi dari `market_tx` — rata-rata tertimbang volume, min, maks,
  volume, jumlah transaksi per hari. Tanpa dependensi baru.
- Halaman Pasar: panel "📈 GRAFIK HARGA — 14 HARI" (pilih komoditas,
  batang CSS + statistik hari terakhir). Pasar kosong → pesan jujur
  "Belum ada transaksi" (bukan grafik palsu).

## 2. Order beli / order book (audit §7.2)

- Tabel baru `market_buy_orders` (buyer, scope, komoditas, tier, qty,
  qty_filled, harga, CHECK qty>0, harga>0, 0≤qty_filled≤qty).
- `POST /api/market/buy-order`: dana pembeli dikunci (escrow) di dalam
  transaksi; harga minimum 10 unit (sama seperti penawaran jual).
- `POST /api/market/sell-to-order`: penjual menjual langsung ke order
  beli; penjual menerima 98% (pajak 2% → kas negara, lihat §3), pembeli
  tidak ditagih lagi. Order terisi penuh → dihapus dari order book
  (seperti penawaran pasar yang habis dibeli).
- `POST /api/market/buy-order/cancel`: sisa escrow yang belum terisi
  kembali ke pembeli.
- `GET /api/market` kini juga mengembalikan `buyOrders` (terbuka, harga
  tertinggi dulu) + `myBuyOrders`. Tidak ada auto-matching: penjual
  memilih sendiri order yang diisi — disengaja, supaya pasar tetap
  permainan pemain, bukan bot.
- Race ditutup seperti pola Tahap 2: baris order dikunci
  `SELECT ... FOR UPDATE` + guarded UPDATE `qty_filled + q <= qty`
  (tes konkurensi §6 membuktikan tepat 1 penjual menang).

## 3. Pajak → kas negara (BUG-8) + halaman kas (audit §7.3)

- Pajak 2% dari SETIAP penjualan pasar (lokal USD maupun global emas)
  kini benar-benar masuk kas negara — sebelumnya menguap. Pembeli global
  dikenai pajak penjual 2% + pajak impor 2% (total 4%, sesuai aturan lama).
- Tabel baru `treasury_tx` (kind, currency, amount, note, created_at) +
  kolom `country.treasury_usd`; tiap pajak menulis baris buku kas dalam
  transaksi yang sama dengan penjualannya (tidak bisa pajak masuk tapi
  penjualan gagal, atau sebaliknya).
- Halaman Negara: panel KAS NEGARA menampilkan saldo + "📒 ARUS KAS
  (20 TERAKHIR)"; kas masih 0 → pesan jujur, bukan angka palsu.
- `GET /api/country` kini mengembalikan `treasuryTx` (20 terakhir).

## 4. Rantai produksi: Pabrik butuh bahan mentah (audit §7.4)

- `FACTORY_INPUT`: Pabrik mengolah **2× Besi Mentah → 1× Bahan Bangunan**,
  maks 10 unit/hari (bukan semua 7 bahan sekaligus — satu rantai sederhana
  dulu, sesuai audit).
- Tick harian: produksi hanya sebanyak bahan yang ada
  (`min(amount, floor(besi/2))`); bila besi 0 → produksi 0 + notifikasi
  "Pabrik kekurangan bahan" berisi angka yang dibutuhkan. Bahan dikonsumsi
  lewat guarded UPDATE di dalam transaksi tick (tidak bisa negatif).

## 5. Batas harga wajar + deteksi wash trading (audit §7.5)

- Batas harga: median harga transaksi 14 hari terakhir (komoditas+tier
  yang sama, butuh ≥3 transaksi pembanding); harga di luar 0,25×–4× median
  ditolak (400) saat pasang jual maupun pasang order beli. Pasar yang masih
  kosong tidak dibatasi.
- Wash trading: ≥3 transaksi antara pasangan pembeli↔penjual yang sama
  dalam 24 jam (dua arah) → dicatat di tabel baru `market_flags`
  (kind `wash_trade` / `price_band`, detail, nama pemain + komoditas).
- Ini HEURISTIK + LOG SAJA — bukan bukti pelanggaran dan bukan auto-ban.
  Admin meninjau lewat tab baru "🚩 Tanda Pasar" (`GET /api/admin/market-flags`,
  100 terakhir).
- Bug yang ditemukan saat testing: `flagMarket` punya 7 placeholder `?`
  untuk 6 nilai → semua penolakan band + semua flag wash-trade melempar 500
  (14 tes e2e gagal). Diperbaiki (6 placeholder); e2e kembali 329/329.

## 6. Retensi data (audit §5.6)

- Tick harian, langkah 8: chat >90 hari, notifikasi TERBACA >30 hari,
  `market_tx`/`fx_history`/`war_attacks` >180 hari dihapus (jumlah
  di-log). Yang TIDAK PERNAH dihapus: notifikasi BELUM dibaca, buku kas
  (`treasury_tx`), dan pengumuman (lihat §9).

## 7. Perbaikan badge level perisai HUD "3/5" (laporan Khalid, screenshot HP)

- Penyebab (terbukti lewat eksperimen Playwright): bentuk perisai dibuat
  dengan `clip-path` + `border` 2px pada elemen yang sama — border
  persegi terpotong poligon sehingga hanya segitiga ujung + sisi yang
  tersisa (ujung atas tampak datar), dan badge level yang menggantung di
  `bottom: -9px` ikut terpotong clip-path (tampil seperti kipas emas).
- Perbaikan (`public/css/style.css`): bentuk dipindah ke `::before`
  (emas) + `::after` (isi gradien) yang masing-masing ber-clip-path;
  elemennya sendiri tanpa clip-path/border sehingga teks + badge tampil
  utuh. Font XP dikecilkan sedikit sebagai pengaman (desktop 22→20px,
  HP 18→16px) untuk nilai lebar di masa depan ("47/50").
- Verifikasi: Playwright 390×844 (skrip `/tmp/hud-shield-shot.mjs`) —
  perisai berujung penuh, "3/5" utuh, badge "1" lingkaran penuh; desktop
  1280×800 terukur normal (perisai 52×58 di x=12 y=8). Dashboard HP
  juga terverifikasi utuh setelah modal pengumuman ditutup.

## 8. Polish UI/UX + suara ketukan (permintaan Khalid)

- Animasi ringan: fade/slide halaman (`.page > *`), pop modal, toast
  slide-in; tombol ditekan mengecil (`:active scale(.96)`); hover jelas
  di desktop (`@media (hover: hover)`); `:focus-visible` outline emas;
  `prefers-reduced-motion` mematikan semua animasi. Identitas/warna dasar
  dan logika game TIDAK berubah. Spacing HP dirapikan (`.panel` 12→14px;
  `.shop-banner` disesuaikan −12→−14px supaya tetap sejajar).
- Suara ketukan: Web Audio API, disintesis (osilator segitiga 1400→700 Hz,
  0,06 detik, gain 0,06 — pelan), tanpa file audio dan tanpa dependensi
  baru. Dipicu `pointerdown` pada elemen interaktif saja (tidak ada
  autoplay). Tombol mute/unmute di Pengaturan ("🔊 SUARA"), preferensi
  disimpan di `localStorage` (`parlementer_sound`) dan bertahan.
- Bug yang ditemukan saat verifikasi: `.modal-card` tanpa `max-height` —
  modal pengumuman Update #1 yang panjang membuat tombol NANTI/SUDAH
  DIBACA jatuh di bawah layar HP 390×844 dan tidak bisa dijangkau.
  Diperbaiki: `max-height: calc(100vh - 32px); overflow-y: auto;`
  (berlaku untuk semua modal, termasuk LAPORKAN KONTEN).

## 9. Pengumuman update "Apa yang Baru" + Riwayat Update di Buku

- Backend: tabel `announcements` (id, title, body, created_at, created_by)
  + `announcement_reads` (announcement_id, citizen_id, read_at, UNIQUE).
  Endpoint admin: `GET /api/admin/announcements`,
  `POST /api/admin/announcements` (judul ≤120, isi ≤5000 karakter),
  `POST /api/admin/announcements/:id/delete` (menghapus jejak baca juga).
  Endpoint pemain: `GET /api/announcements` (terbaru dulu, nomor stabil
  `num` = posisi dalam urutan `created_at` ASC, flag `read`, `unreadCount`)
  + `POST /api/announcements/read` (`{id}` atau `{all:true}`).
  Semua di belakang middleware admin + rate limit yang sudah ada (Tahap 2).
- UI: bagian "📣 APA YANG BARU" di halaman Notifikasi (chip Update #N +
  tombol Tandai Dibaca); saat login dan ada yang belum dibaca, tampil
  modal sekali per sesi (NANTI menutup saja, SUDAH DIBACA menandai +
  refresh). Teks Bahasa Indonesia, rapi di HP.
- Buku Panduan: panel baru "📜 RIWAYAT UPDATE" — SEMUA pengumuman,
  terbaru dulu, tiap entri bernomor urut terbit (Update #1 = yang pertama).
- Pengumuman pertama (Update #1, ter-seed lewat migrasi — hanya bila tabel
  kosong): "Pasar Lebih Dalam, Energi Pulih Otomatis & Tampilan Baru",
  berisi ringkasan Tahap 4 ini (pasar, perisai, polish + suara, pengumuman,
  energi, hadiah barang tanpa batas).

## 10. Energi pulih otomatis +2/menit (permintaan Khalid)

- `applyEnergyRegen` di `src/util.js`, dipanggil di `loadCitizen` (setiap
  pembacaan data pemain): +2/menit dari `energy_updated_at`, berhenti di
  batas maksimum pemain; sisa menit pecahan dipertahankan (timestamp maju
  per menit penuh). Baris lama dengan `energy_updated_at = 0` diperlakukan
  sebagai "baru saja" (tanpa windfall). Guarded UPDATE + baca ulang bila
  kalah race (pola Tahap 2). Gagal regen tidak pernah merusak pembacaan.
- Karena dihitung dari waktu berlalu, pemain OFFLINE tetap pulih saat
  kembali. Biaya energi tidak berubah (shift 100, perang 10, dsb.),
  klaim harian dan makan roti tidak berubah.
- UI: bar energi memakai angka server (`/api/me`), dashboard menulis
  "⚡ Pulih otomatis +2/menit sampai batas {cap} (naik 5 tiap level)."

## 11. Batas energi naik per level (permintaan Khalid)

- Satu sumber kebenaran: `energyCapFor(level, isPremium, hasHealth)` di
  `src/game.js` = **100 + 5 × (level − 1) + 20 Premium + 10 RS Lapangan**.
  Level 1 → 100, level 2 → 105, level 3 → 110, dst. Konstanta hardcode
  Tahap 3 (`ENERGY_CAP_PREMIUM` 120, `ENERGY_DAILY_HEALTH` 110) DIHAPUS
  beserta semua pemakaiannya — tidak ada lagi 100/110/120 yang di-hardcode
  di `src/` (hanya disebut di komentar sebagai sejarah).
- Dipakai di: `/api/me` (energyCap), `/api/eat`, reset harian tick,
  regen (`applyEnergyRegen`), isi energi admin (`/api/admin/energy` +
  gift-all energi — sebelumnya juga hardcode 100/120, kini per pemain).
- UI: bar energi langsung menampilkan batas baru saat pemain naik level
  (nilai dari `/api/me`, tanpa refresh manual).

## 12. Hadiah barang tanpa batas jumlah (permintaan Khalid)

- Grant tunggal (`POST /api/admin/item`) + hadiah massal
  (`POST /api/admin/gift-all`, kind `item`): batas atas 10.000 DICABUT.
  Syarat tersisa: bilangan bulat positif yang valid (0, negatif, dan
  pecahan tetap ditolak 400). Validasi nama barang tetap dipertahankan.
- Batas emas/USD (maks 1.000.000) dan Premium (maks 365 hari) TIDAK
  berubah. Form admin tidak menyebut angka 10.000 di mana pun (hanya
  `min="1"`), jadi tidak ada teks form yang perlu diubah.
- Tercatat di pengumuman Update #1.

## Hasil tes (semua hijau)

| Suite | Tahap 3 | Tahap 4 | Baru |
|---|---|---|---|
| e2e (`npm test`) | 253/253 | **329/329** | +76 (§22: grafik, band, order beli, pajak, wash, pabrik, retensi, regen, cap, pengumuman, hadiah) |
| modal-dom (`test:modal`) | 46/46 | **56/56** | +10 (§11 Buku, §12 toggle suara, §13 modal pengumuman) |
| pg-mem (`test:pg`) | 28/28 | **28/28** | — |
| pg-verify (`test:pg-verify`) | 19/19 | **25/25** | +6 (§7: 5 tabel, 2 kolom, 4 CHECK, seed Update #1, migrasi kolom) |
| pg-concurrency (`test:conc`) | 18/18 | **24/24** | +6 (§6: dua penjual berebut 1 order beli; invarian jadi §7) |
| ssl (`test:ssl`) | 6/6 | **6/6** | — |
| **Total** | **370** | **468** | **+98** |

Catatan tes: e2e §12 ("energi pulih ke 100 setelah tick") dan §20
(RS Lapangan 110) tetap lolos di bawah rumus cap baru. Tes §22 memakai
4 pemain baru (tahap4_c/d/e/f) + tick yang dipaksa seperti pola lama.

## File yang diubah

- `src/game.js` — `energyCapFor`, `ENERGY_REGEN_*`, `FACTORY_INPUT`,
  `PRICE_BAND`, `WASH_TRADE`, `RETENTION`; hapus konstanta cap hardcode.
- `src/db.js` — 5 tabel baru, 2 kolom baru (+ migrasi), 4 CHECK order
  beli, 6 index baru, seed pengumuman Update #1.
- `src/util.js` — `applyEnergyRegen` (lazy regen di `loadCitizen`).
- `src/tick.js` — reset energi pakai rumus cap, produksi Pabrik butuh
  Besi, langkah 8 retensi.
- `src/api-core.js` — grafik harga, order beli (pasang/jual/batal),
  pajak → kas negara, batas harga, wash-trade, hapus order terisi penuh.
- `src/api-civic.js` — `GET /api/country` mengembalikan `treasuryTx`.
- `src/api-admin.js` — endpoint pengumuman + tanda pasar, hadiah barang
  tanpa batas, isi energi pakai `energyCapFor`.
- `public/css/style.css` — perisai HUD, polish (animasi/hover/active/
  fokus), grafik harga, pengumuman, `max-height` modal-card.
- `public/index.html` — modal pengumuman `#announce-modal`, tooltip
  energi "+2/menit".
- `public/js/app.js` — suara ketukan + toggle, modal pengumuman, Notifikasi
  "Apa yang Baru", Buku "Riwayat Update", grafik + order beli di Pasar,
  buku kas di Negara, tab admin Pengumuman/Tanda Pasar, teks energi.
- `test/e2e.js`, `test/modal-dom.js`, `test/pg-verify.mjs`,
  `test/pg-concurrency.mjs` — tes baru (lihat tabel di atas).
- `docs/TAHAP4.md` — dokumen ini.

## Catatan jujur / batasan

- Grafik harga dan order book akan KOSONG sampai ada pemain yang benar-benar
  berdagang — dengan 1–2 pemain, fitur ini hampir tidak terlihat. Itu
  sesuai catatan audit: jangan over-invest sebelum ada pemain.
- Wash-trade dan batas harga adalah heuristik + log, bukan bukti
  pelanggaran; tidak ada auto-ban dan tidak ada auto-matching order.
- Retensi tidak menghapus notifikasi yang belum dibaca, buku kas, dan
  pengumuman — arsip update di Buku bersifat permanen.
- Foto profil lama tetap tampil inisial di chat sampai diunggah ulang
  (`avatar_sm` NULL) — bukan bug (catatan Tahap 3, masih berlaku).
- Verifikasi live via browser (deploy Vercel + Runtime Logs) adalah tugas
  agen utama setelah push — subagent ini tidak memakai browser langsung.
