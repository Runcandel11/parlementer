# TAHAP 3 — UI/UX (AUDIT §7 + temuan verifikasi live 27 Nov 2026)

Tanggal: 2026-11-27. Basis: commit 450a48e (Tahap 2, sudah live + terverifikasi).
Aturan game TIDAK berubah: tanpa bot, pasar mulai 0, lowongan ADMIN dibayar
bahan mentah, harga toko rupiah + WhatsApp, admin hanya Khalid. Perilaku
login-banned, banding, avatar, hadiah, rate limit, dan referral dari Tahap 2
TIDAK diubah — kecuali yang disebut eksplisit di bawah (avatar_sm, teks Premium).

## 1. Bonus konvoi kini DITERAPKAN (BUG-7 — keputusan: implementasi, bukan hapus teks)

Janji di `CONVOY_BUILDINGS` sebelumnya hanya teks tanpa efek mekanik.
Sekarang keempat bangunan aktif memberi bonus nyata (kedaluwarsa 7 hari tetap):

| Bangunan | Bonus | Tempat diterapkan |
|---|---|---|
| Rumah Sakit Lapangan | Pemulihan energi harian 100 → **110** | `src/tick.js` (reset harian) + batas makan di `POST /api/eat` |
| Sekolah Keliling | Latihan **10% lebih murah** (min. 1 emas) | `POST /api/train` + `/api/me` (`trainCosts`) |
| Gudang Industri | Produksi perusahaan **+10%** (dibulatkan) | `src/tick.js` (produksi harian) |
| Pos Militer | Kerusakan perang **+10%** (dibulatkan) | `POST /api/wars/:id/attack` |

- Helper baru `convoyBuildings(citizenId, t?)` di `src/db.js` (Set jenis
  bangunan aktif; `t` opsional untuk pemakaian di dalam transaksi).
- Helper di `src/game.js`: `trainCostDiscounted`, `productionWithBonus`,
  `warDamageWithBonus`, konstanta `ENERGY_DAILY_HEALTH` (110) +
  `ENERGY_CAP_PREMIUM` (120).
- `/api/me` kini mengirim `energyCap` (100 / 110 / 120) dan `trainCosts`
  `{strength, strategy, charisma}` supaya dashboard menampilkan angka yang
  sama dengan yang dibebankan server. HUD (`renderHUD`), bar energi
  dashboard, dan tombol LATIH memakai nilai server tersebut.
- Catatan: reset harian 110 TIDAK melebihi batas makan Premium 120 — warga
  Premium tetap bisa makan sampai 120.

## 2. Teks Premium jujur (BUG-7)

`PREMIUM_PERKS` lama menjanjikan "Mode otomatis, lebih banyak roti, latihan
lebih cepat" — tidak ada yang diimplementasikan. Teks baru (via
`GET /api/shop` → `perks`):

> "Batas energi 120 (bukan 100), slot konvoi keempat, dan namamu berwarna
> Premium di chat."

Itulah tiga perk Premium yang memang ada di kode (batas energi 120, +1 slot
konvoi, nama berwarna di chat).

## 3. Peringatan SSL di log cold start — DIHILANGKAN (tanpa ubah DATABASE_URL)

- Penyebab: `pg-connection-string` 2.14.1 menulis `process.emitWarning`
  (deprecation) ke stderr setiap kali URL mengandung `sslmode=prefer` /
  `require` / `verify-ca`; Vercel mengklasifikasikan stderr sebagai Error.
  Peringatan muncul saat koneksi pertama di-parse (bukan saat Pool dibuat).
- Perilaku TLS hari ini: `sslmode=require` diperlakukan sebagai verify-full
  (`config.ssl` = `{}` kosong → Node TLS default `rejectUnauthorized: true`,
  sertifikat server tetap diverifikasi — koneksi Neon yang berhasil
  membuktikannya).
- Perbaikan (`src/db.js`, `buildPgPoolConfig`): bila URL mengandung
  `sslmode`, buang parameter itu dan ganti dengan `ssl: { rejectUnauthorized:
  true }` eksplisit — perilaku TLS IDENTIK, peringatan hilang. `DATABASE_URL`
  tidak diubah (hanya salinan string untuk Pool); URL tanpa `sslmode`
  (Postgres lokal untuk tes) tidak disentuh.
- Tes baru `test/ssl-warning.mjs` (`npm run test:ssl`, 6 cek): kontrol pg
  mentah + `sslmode=require` memicu peringatan; config hasil sanitize tidak
  memicu peringatan; `ssl` tetap aktif + verifikasi; URL lokal tak berubah;
  parameter lain di sekitar `sslmode` dipertahankan.
- Verifikasi live (log Vercel setelah deploy) masih harus dicek parent lewat
  browser — tes lokal hanya membuktikan tidak ada lagi `process.emitWarning`
  dari jalur ini.

## 4. Warning migrasi CHECK — DIHILANGKAN

- Penyebab: `migrateChecks()` jalan DI LUAR transaksi ber-advisory-lock
  `initDb`, jadi dua cold start bersamaan bisa sama-sama lolos cek-eksistensi
  lalu `ALTER` — yang kalah mendapat `42P07` ("constraint already exists")
  dan menulis warning `[db] CHECK ...`.
- Perbaikan (`src/db.js`): cek eksistensi lewat join `pg_class` (aman skema)
  + `42P07` (atau pesan "already exists") ditelan diam-diam sebagai hasil
  idempotent yang diharapkan; warning hanya untuk kegagalan lain (mis. data
  lama melanggar CHECK).
- Tes baru di `test/pg-verify.mjs` bagian [6]: hapus constraint, jalankan
  `initDb()` 3× paralel, assert tanpa warning `[db] CHECK` dan constraint
  terpasang kembali tepat 1.

## 5. BUG-12 — judul chat perang

`GARIS DEPAN: JAKARTA → JAKARTA` (region_name dua kali). Sekarang memakai
`attacker_label` → `defender_label` dari `/api/wars/:id`
("PEMBERONTAK JAKARTA → REPUBLIK INDONESIA"). Bukan lubang XSS: subLabel
sudah di-escape saat render.

## 6. BUG-11 — filter blokir di SQL

`GET /api/chat/:room` dulu mengambil `LIMIT 100` lalu menyaring yang
diblokir di JS — 100 pesan terblokir bisa menghabiskan limit dan
menenggelamkan pesan valid. Sekarang disaring DI SQL:
`AND m.citizen_id NOT IN (SELECT blocked_id FROM blocked WHERE blocker_id =
?)`. Satu query, satu parameter tambahan; query blokir terpisah dihapus.

## 7. Avatar kecil untuk chat/DM (§6.3)

- Kolom baru `users.avatar_sm` (skema + migrasi pg/sqlite).
- Browser mengirim thumbnail 48×48 (≤ 25 KB) bersama avatar 256×256;
  server memvalidasi keduanya dengan parser yang sama (JPEG/PNG/WebP +
  magic bytes). Upload tanpa `avatar_sm` tetap diterima (kompatibel
  mundur); hapus avatar membersihkan keduanya.
- `GET /api/chat/:room` dan DM kini memilih `u.avatar_sm AS avatar` —
  field respons tetap `avatar`, frontend tidak berubah. Satu polling chat
  100 pesan tidak lagi mengunduh ~13 MB.
- Foto lama (avatar_sm NULL) menampilkan fallback inisial di chat sampai
  diunggah ulang — dicatat, bukan bug. Profil dan daftar pemain admin
  tetap memakai avatar penuh.

## 8. Konfirmasi aksi destruktif

`confirm()` berbahasa Indonesia dengan konsekuensi, mengikuti pola yang
sudah ada (hapus avatar, ban admin, hadiah massal): keluar partai, keluar
organisasi, bongkar konvoi (bonus hilang, 10 emas tidak kembali), batalkan
penawaran pasar, batalkan penawaran valas.

## 9. Skeleton loading + aksesibilitas (§7)

- `route()` menampilkan skeleton shimmer (`.skel`, `role="status"`,
  hormat `prefers-reduced-motion`) menggantikan "Memuat…" polos.
- Setelah halaman termuat, fokus pindah ke judul `<h2 tabindex="-1">`
  (pembaca layar tahu halaman berganti; polling chat tidak memanggil
  `route()`, jadi fokus tidak dicuri saat mengetik). `h2[tabindex="-1"]`
  tanpa cincin fokus visual — bukan elemen interaktif dan tidak ada di
  urutan Tab.
- Modal laporkan: `role="dialog" aria-modal="true" aria-labelledby`;
  toast `role="status"`; aria-label di `#chat-text`, `#appeal-reply`,
  `#energy-chat`, `#drawer-close`; Escape kini juga menutup drawer.
- Perbaikan layout yang ketahuan saat verifikasi visual: timestamp
  ("baru saja") di baris notifikasi/aktivitas terpotong di HP karena
  `.kv .v` menyusut sampai 24px — ditambah `white-space:nowrap;
  flex-shrink:0` pada kolom waktu (juga di halaman Notifikasi yang punya
  pola sama).

## 10. Halaman "Aktivitas Saya" (§7)

- `GET /api/activity` (baru): 50 transaksi pasar terakhir (join nama
  komoditas + arah beli/jual; mata uang mengikuti pasar: global = emas,
  lokal = USD) + 50 notifikasi/aktivitas terakhir. `fx_history` tidak
  punya tautan warga, jadi riwayat FX tidak tampil.
- Rute `#/activity` + entri NAV di grup BERANDA, dua panel (TRANSAKSI
  PASAR, AKTIVITAS & PEMBERITAHUAN) dengan empty state.

## 11. Verifikasi visual HP (Playwright, 390×844, server lokal + DB temp)

- Layar loading: bersih (logo ◆, PARLEMENTER, spinner, MEMUAT...).
- Header dua baris: baris 1 menu + XP + USD/emas + chat/lonceng/pengaturan,
  baris 2 nama + wilayah — tidak ada yang terpotong.
- Dashboard: energi 100/100, tombol LATIH · 1 EMAS, bar energi bawah.
- Halaman Aktivitas Saya + drawer (entri AKTIVITAS SAYA di BERANDA).
- Screenshot sementara di `/tmp/tahap3-shot/` (dihapus setelah dicek);
  skrip sementara `test/shot-tahap3.tmp.mjs` juga dihapus — tidak ikut
  commit.

## Pengujian

| Suite | Hasil |
|---|---|
| `npm run test:pg` | 28/28 |
| `npm test` (e2e) | 253/253 (239 lama + 14 baru) |
| `npm run test:modal` | 46/46 (28 lama + 18 baru) |
| `npm run test:pg-verify` | 19/19 (17 lama + 2 baru) |
| `npm run test:conc` | 18/18 |
| `npm run test:ssl` (baru) | 6/6 |

Tes baru e2e [20] bonus konvoi (energi 110, produksi 8→9, latih 2→1 emas,
kerusakan 30→33), [21] aktivitas + teks Premium, [10] BUG-11 (100 pesan
terblokir tidak menenggelamkan pesan A, room 'indonesia' supaya tidak
mengotori chat global), [16] avatar_sm. Tes baru modal-dom [8] skeleton +
fokus (spy `HTMLElement.prototype.focus` — jsdom tidak mengimplementasikan
fokus dokumen, `h.focus()` no-op di sana) + HUD energyCap + a11y,
[9] halaman Aktivitas + NAV, [10] judul perang + konfirmasi bongkar konvoi
(tolak/setuju).

**Satu tes lama diubah karena perubahan perilaku yang disengaja:**
`[16] "Pesan chat membawa avatar pengirim"` kini mengharapkan `avatar_sm`
(bukan avatar penuh) — sesuai §6.3 di atas.

**Koreksi saat menulis tes:** warga baru mulai `attr_str = 0` (bukan 1),
jadi biaya latih dasar pertama 1 emas; ekspektasi awal tes (kekuatan 2,
kerusakan 39) diperbaiki ke angka benar (kekuatan 1 → latih 1 emas,
kerusakan 30 → 33). Kode produksi tidak berubah karena ini. Bug nyata yang
ketahuan dari kegagalan tes: `/api/activity` sempat memilih `c.icon` yang
tidak ada di tabel commodities (500) — diperbaiki sebelum commit.

## File yang diubah

- `src/db.js` — `buildPgPoolConfig`, `migrateChecks`, `avatar_sm`,
  `convoyBuildings`
- `src/game.js` — `PREMIUM_PERKS`, helper bonus konvoi
- `src/tick.js` — energi 110 + produksi +10%
- `src/api-core.js` — latih/makan diskon & cap, `/api/me` (energyCap +
  trainCosts), avatar_sm, `GET /api/activity`
- `src/api-civic.js` — chat filter SQL + avatar_sm, DM avatar_sm, bonus
  militer
- `public/js/app.js` — BUG-12, 5 konfirmasi, skeleton + fokus, HUD/dashboard
  energyCap + trainCosts, halaman Aktivitas + NAV, avatar_sm, a11y,
  timestamp nowrap
- `public/index.html` — role dialog/toast, aria-label tombol
- `public/css/style.css` — `.skel` shimmer, `h2:focus` tanpa outline
- `package.json` — skrip `test:ssl`
- `test/e2e.js`, `test/modal-dom.js`, `test/pg-verify.mjs` — tes baru
- `test/ssl-warning.mjs` — baru

## Masih butuh Khalid / parent

- **Verifikasi live setelah deploy:** cek log Vercel di cold start
  berikutnya — peringatan deprecation SSL dan warning CHECK harus hilang;
  dan cek tampilan di HP sungguhan (screenshot Playwright di atas memakai
  server lokal + Chromium headless, bukan HP fisik).
- Foto profil lama di chat menampilkan inisial sampai diunggah ulang
  (avatar_sm NULL) — bukan bug; Khalid bisa unggah ulang bila mau
  thumbnail di chat.
- Tahap 4 (pasar/ekonomi) sudah diotorisasi — mulai setelah Tahap 3 live.
