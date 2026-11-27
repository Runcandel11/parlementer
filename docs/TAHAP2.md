# Tahap 2 — Perbaikan Bug + Keamanan (27 Nov 2026)

Per audit `docs/AUDIT.md` §7. Commit: lihat `git log` (Tahap 2).

## 1. Celah admin — DITUTUP PENUH

- Pemberian admin berbasis email **dicabut** dari registrasi
  (`src/api-core.js`): email apa pun — termasuk
  `koboijuniorkhalid@gmail.com` — yang mendaftar tanpa kode bootstrap
  menjadi warga biasa.
- **Akun admin Khalid yang sudah ada tetap `is_admin=1`**: migrasi
  `initDb` (`migrateUserColumns` di `src/db.js`) yang menandai email itu
  dipertahankan. Migrasi itu hanya bisa menyentuh satu baris dengan email
  tersebut, dan email itu sudah dimiliki Khalid — jadi tidak bisa dipakai
  membuat admin baru.
- Satu-satunya jalan darurat membuat admin: env var
  **`ADMIN_BOOTSTRAP_CODE`**. Registrasi dengan field `admin_code` yang
  cocok (perbandingan timing-safe) menjadi admin; kode salah → 400.
  Bila env var kosong, registrasi tidak bisa membuat admin sama sekali
  (peringatan keras di log server).
  - Cara isi di Vercel: Project Settings → Environment Variables →
    `ADMIN_BOOTSTRAP_CODE` = nilai acak panjang (mis. `openssl rand -hex 32`).
    Redeploy setelah mengisi. Jaga seperti password.

## 2. Race condition ekonomi (BUG-2) — ditutup

Pola baru di semua jalur ekonomi (`src/api-core.js`, `src/api-civic.js`):
`SELECT ... FOR UPDATE` di dalam `tx()` (helper `forUpdate()` di
`src/db.js` — hanya aktif di Postgres sungguhan; pg-mem/SQLite tidak
mendukungnya dan men-serialize tulis) + pertahanan kedua
`UPDATE ... WHERE <syarat>` + cek `changes`. Baris dua warga dikunci
urut id menaik agar tidak deadlock.

- Market buy/sell, klaim harian, shift (3 jenis gaji), latih, lamar/keluar
  kerja, FX mint/offer/take, makan, misi, kronik, pencapaian
  (`INSERT ... ON CONFLICT DO NOTHING`), blokir (`ON CONFLICT DO NOTHING`),
  ganti nama, perusahaan, konvoi, perjalanan, pemberontakan, partai,
  UU/voting, pemilu, serangan perang, koran, organisasi, reaksi artikel.
- Verifikasi: `test/pg-concurrency.mjs` (Postgres 16 sungguhan, HTTP
  paralel) — 18/18: dua pembeli berebut 1 penawaran, dua klaim, dua shift,
  dua klaim pencapaian, dua blokir; semua tepat 1 berhasil + invarian
  tanpa saldo negatif.

## 3. JWT fail-closed + pencabutan sesi

- `NODE_ENV=production` + `JWT_SECRET` kosong/masih secret dev → server
  **menolak start** dengan error jelas (`src/util.js`).
- JWT berlaku **7 hari** (dulu 30), cookie `maxAge` ikut 7 hari.
- `users.token_version` (kolom baru + migrasi): payload JWT membawa `tv`;
  `authRequired` menolak token yang `tv`-nya tidak cocok dengan DB.
  `token_version` naik saat **logout** (semua perangkat). Token lama tanpa
  `tv` dianggap `tv=0` (tetap valid sampai kedaluwarsa).
- Ban **tidak** menaikkan `token_version`: sesi akun banned sengaja
  dibiarkan hidup agar pemain bisa membuka layar banned + banding; semua
  API game diblokir middleware penjaga banned.

## 4. Rate limit berbasis DB (`src/rate-limit.js`, tabel `rate_limits`)

- Registrasi: maks **20/IP/24 jam** (tes e2e mendaftar 13 akun dari
  127.0.0.1 — di bawah batas).
- Aksi admin (POST `/api/admin/*`): maks **120/jam per admin**.
- Limit auth in-memory lama (30/menit/IP) tetap ada.
- Pola: INSERT baris jendela (abaikan bentrok) lalu `tx()` +
  `SELECT ... FOR UPDATE` + update kondisional. Bila DB error, fail-open
  (log saja) agar gangguan DB tidak memblokir semua pemain.

## 5. Security headers + error generik + batas password

- Header di semua respons (`src/app.js`): `X-Content-Type-Options:
  nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, CSP
  (Google Fonts diizinkan; skrip/gaya dari origin sendiri), HSTS di
  production.
- Error 500 ke klien generik ("Terjadi kesalahan server."); detail hanya
  di log server. Pesan 4xx yang disengaja tetap apa adanya.
- Password maksimal **72 byte** (batas pemotongan bcrypt).

## 6. Database

- Index baru (§5.1 audit): `market_offers.seller_id`,
  `chat_messages.citizen_id`, `notifications(citizen_id,is_read)`,
  `dms(from_id,to_id)` + `(to_id,from_id)`, `inventory.citizen_id`,
  `fx_offers(citizen_id,expires_at)` + `expires_at`,
  `war_attacks.war_id`, `articles(author_id)` + `(newspaper_id)`,
  `market_tx(buyer_id)` + `(seller_id)`, `elections.status`,
  `laws(status,ends_at)`, `appeals(user_id,status)`, +
  `referral_pending(newcomer_id,status)` + `(referrer_id,status,paid_day)`.
- `CHECK`: citizens gold/usd/energy >= 0, inventory qty >= 0,
  market_offers qty/price > 0, fx_offers qty_gold/qty_filled >= 0,
  jobs seats_taken 0..seats, wars score_a/score_d >= 0 — inline di skema
  baru + migrasi `migrateChecks()` untuk Postgres yang sudah ada (tiap
  constraint try/catch sendiri; gagal = peringatan, tidak menggagalkan
  `initDb`).

## 7. Farming referral — dibatasi (sementara)

- Bonus referral **baru cair saat pendaftar mencapai Level 3** (tabel
  `referral_pending`: `pending` → `paid`/`skipped`).
- Maks **5 bonus terbayar per hari per pemilik kode**; bonus ke-6+ hari itu
  ditandai `skipped` + pemilik kode diberi notifikasi.
- `goldEarned` di `/api/me` + profil kini menghitung bonus yang sudah
  **cair**, bukan total pemakai kode.
- Verifikasi email penuh (Resend/Gmail SMTP) **DITUNDA** — butuh akun
  layanan baru; jangan buat akun atas nama Khalid. Yang dibutuhkan: akun
  Resend (atau SMTP Gmail) + API key di Vercel — diputuskan di tahap
  berikutnya.

## 8. Antrian moderasi — terverifikasi, tidak diduplikasi

`GET/POST /api/admin/reports` + inbox admin (tiket + laporan chat)
dari commit `e79570d` sudah berfungsi — tercakup tes e2e [18] (239/239).

## Tes

| Suite | Hasil |
| --- | --- |
| `npm test` (e2e) | 239/239 |
| `npm run test:pg` (pg-mem) | 28/28 |
| `npm run test:modal` (jsdom) | 28/28 |
| `npm run test:pg-verify` (Postgres 16) | 17/17 |
| `npm run test:conc` (Postgres 16) | 18/18 |

Perubahan perilaku yang disengaja di tes e2e [14]: pendaftar referral
mulai 50 emas tanpa premium (bonus cair di Level 3); registrasi email
admin tanpa kode bootstrap tidak jadi admin; admin baru dibuat lewat
kode bootstrap; batas 5 bonus/hari diuji dengan 6 pendaftar.

## Yang masih butuh Khalid

1. **(Opsional, darurat saja)** Isi `ADMIN_BOOTSTRAP_CODE` di Vercel
   bila ingin ada jalan darurat membuat admin. Tidak wajib — Khalid
   sudah menjadi admin.
2. **Verifikasi email penuh** (tahap berikut): putuskan layanan
   (Resend / SMTP Gmail) + siapkan akun + API key.
3. Tidak ada yang berubah di sisi pemain: aturan game, harga toko,
   lowongan ADMIN (bahan mentah), dan alur banding/avatar/hadiah sama.
