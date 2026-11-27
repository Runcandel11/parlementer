# Rombak UI — Gaya Parlamentum

Referensi: 3 screenshot dashboard Parlamentum dari Khalid
(`~/workspace/user/files/63744_28_vdv5.jpg`, `63745_29_o2eg.jpg`,
`63746_30_grbl.jpg`). Sistem desain: dark navy + gold + teal.
**Hanya tampilan — tidak ada mekanik, nama, atau branding yang berubah
(tetap PARLEMENTER).** Semua fungsi yang ada (suara ketukan, animasi,
polling chat, pengumuman) tetap jalan.

## Yang berubah

- **Header (semua halaman):** hamburger + tombol peti pasokan harian di
  bawahnya (kolom kiri). Peti berdenyut emas + badge "1" bila pasokan hari
  ini belum diambil; mati + redup bila sudah diambil. Peti memanggil
  `POST /api/claim` yang sama dengan tombol AMBIL PASOKAN lama
  (`claimDaily()` di `public/js/app.js`) — tombol lama di Dashboard
  dihapus karena digantikan peti. Perisai tengah kini menampilkan angka
  XP emas lebih besar (24px desktop).
- **Banner UU (semua halaman):** bila ada undang-undang yang sedang
  divoting, muncul satu baris di bawah header:
  "N undang-undang sedang dibahas · sisa 1j 15mnt" (sisa = deadline
  voting terdekat dari `ME.votingLaws`). Ketuk → halaman Parlemen.
  Tersembunyi bila tidak ada UU yang divoting.
- **Dashboard — hero profil:** banner gradien merah gelap + nama kapital
  putih besar, titik merah + "Republik Indonesia", pin + wilayah.
  Partai/pekerjaan tetap tampil sebagai baris di bawahnya.
- **Dashboard — blok stat besar:** LEVEL (angka emas + bar XP),
  ENERGI (angka putih besar + bar teal), KELELAHAN (bar + tanda ambang
  10.000 ×0.75 / 15.000 ×0.5), MAKANAN (kartu T1–T5), DOMPET
  (emas + USD + tautan TOP-UP ke Toko).
- **MAKANAN:** kartu T1–T5 (⚡10/20/30/40/50) di Dashboard dan
  Inventaris; ketuk kartu = makan (`POST /api/eat`, sama seperti tombol
  MAKAN lama). Kartu kosong (×0) tampil redup dan tidak bisa diketik.
- **KRONIKMU (Dashboard):** judul emas + progres total (mis. 0/20),
  bar tersegmen (satu segmen per tugas), kutipan serif dengan border
  emas kiri, "TUGASMU" + judul tugas aktif + petunjuknya, dua tombol
  "BACA BABAK INI LAGI" (→ halaman KRONIKMU) / "LEWATI PELATIHAN
  (TANPA HADIAH)", dan daftar 5 babak yang bisa dibuka-tutup (Babak I
  terbuka saat awal).
- **Halaman KRONIKMU:** tiap babak kini punya kutipan, bar tersegmen,
  dan daftar tugas dengan titik (emas = selesai, menyala = aktif).
- **Halaman Profil:** hero merah yang sama di atas berkas warga.
- **Popover (ketuk blok ENERGI / KELELAHAN):** kartu tengah, tutup
  lewat ✕ / klik backdrop / Escape.

## Yang SENGAJA tidak disalin mentah dari referensi

Angka-angka di screenshot Parlamentum yang bukan mekanik Parlementer
**tidak** dipakai — yang tampil adalah angka game yang sebenarnya:

- Popover energi menampilkan **+2 / mnt** (regen Parlementer,
  `ENERGY_REGEN_PER_MIN`), bukan "+1.58/mnt" dengan bonus "Kesehatan
  kota +35%" / "Ideologi konservatif +25%" — kedua bonus itu tidak ada
  di Parlementer. Baris "Energi maksimum" memakai `energyCap`
  dari server (100 + 5×(level−1) + 20 Premium + 10 RS Lapangan);
  bila ada bonus batas, ditampilkan sebagai satu baris gabungan
  "Bonus batas (Premium / RS Lapangan)".
- Popover kelelahan memakai nilai `fatigue` dan `energy_spent_today`
  warga yang sebenarnya; tier 0–10.000 ×1 / 10.000–15.000 ×0.75 /
  15.000+ ×0.5 sesuai `fatigueMult()`. Catatan soal pemulihan
  (-2.000/hari, reset harian) sesuai `tick.js`.
- Tombol "LEWATI PELATIHAN (TANPA HADIAH)" **hanya menyembunyikan
  kartu KRONIKMU dari Dashboard** (preferensi `localStorage`
  `parlementer_kronik_hide`) — di server tidak ada mekanisme hangus
  hadiah, jadi hadiah babak tetap bisa diklaim di halaman KRONIKMU.
  Toast saat ditekan menjelaskan hal ini.
- Kutipan tiap babak + petunjuk tugas Babak I adalah teks tampilan
  baru di `app.js` (`CHRONICLE_QUOTES`, `TASK_HINTS`); isi dan hadiah
  babak tetap dari server (`/api/chronicle`).

## Pengumuman Update #2

Teks seed Update #2 (`ANNOUNCEMENT_TAHAP5_BODY` di `src/db.js`)
ditambah satu seksi "TAMPILAN BARU" berisi satu baris soal rombak UI
ini.

**Catatan jujur:** Update #2 live sudah ter-seed SEBELUM baris ini
ditambahkan (sama seperti baris artikel dan baris perbaikan lock di
Tahap 5) — pemain live melihat Update #2 versi awal tanpa baris
tampilan ini. Teks seed yang baru hanya berlaku untuk database baru.
Tidak ada migrasi yang mengubah pengumuman yang sudah terbit.

## Tes

| Suite | Hasil |
|---|---|
| e2e | 426/426 |
| modal-dom | **118/118** (baseline 84 → **+34**, §16 baru: rombak UI) |
| pg (pg-mem) | 33/33 |
| pg-verify (Postgres 16) | 40/40 |
| pg-concurrency | 33/33 |
| ssl-warning | 6/6 |
| **TOTAL** | **656/656** (baseline 622 → **+34**) |

§16 (`test/modal-dom.js`) menguji: peti + banner UU di HUD (aktif/mati
sesuai `last_claim_date`), hero profil, blok LEVEL/ENERGI/KELELAHAN/
MAKANAN/DOMPET, grid 5 kartu makanan, kartu KRONIKMU (seg-bar 20,
kutipan, TUGASMU, 2 tombol, 5 babak buka-tutup), popover energi
(+2/mnt, batas 100) dan kelelahan (tier ×1/×0.75/×0.5) + tutup via
backdrop/Escape, klik kartu T1 → `POST /api/eat`, `claimDaily()` →
`POST /api/claim` + toast, LEWATI → kartu hilang + tersimpan lokal,
halaman KRONIKMU/Profil/Inventaris, serta cek statis CSS/app.js
(tidak ada `#btn-claim` lagi, tidak ada `onclick` inline baru).

## Verifikasi visual (Playwright 390×844)

Skrip: `/tmp/ui-revamp-shot.mjs` (server SQLite sekali pakai, 1 UU
divoting, akun baru dengan 3× Makanan T1). Semua cek lolos.

- `/tmp/ui-revamp-shots/01-dashboard-atas.png` — HUD (peti + badge 1,
  perisai 0/5), banner "1 UNDANG-UNDANG SEDANG DIBAHAS · sisa 1j 14 mnt",
  hero profil, LEVEL, ENERGI.
- `/tmp/ui-revamp-shots/02-dashboard-kronikmu.png` — kartu KRONIKMU,
  tugas aktif, 5 babak.
- `/tmp/ui-revamp-shots/03-popover-energi.png` — popover +2 / mnt.
- `/tmp/ui-revamp-shots/04-popover-kelelahan.png` — popover tier
  kelelahan.
- `/tmp/ui-revamp-shots/05-profil.png` — hero profil di Berkas Warga.
- `/tmp/ui-revamp-shots/06-kronikmu.png` — halaman KRONIKMU.
- `/tmp/ui-revamp-shots/07-inventaris.png` — grid MAKANAN T1–T5.

Catatan dari screenshot: banner UU membungkus 2 baris di lebar 390px
("1 UNDANG-UNDANG SEDANG DIBAHAS · sisa / 1j 14 mnt") — masih terbaca
penuh, bukan bug.
