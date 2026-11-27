# Fitur: Jumlah Pemain Online + Lencana Pengumuman

Dikerjakan 2026-11-27 malam WIB (satu commit dengan notifikasi manual admin —
lihat di bawah mengapa tidak ada kode baru untuk pengumuman).

## 1. Notifikasi manual admin — SUDAH ADA, tidak dibangun ulang

Jalur pengumuman manual sudah lengkap dan live sejak Tahap 4 (commit 6854e3b,
terverifikasi live 15:41 WIB):

- Backend: `POST /api/admin/announcements` (judul maks 120, isi maks 5000,
  hanya `is_admin=1`, tercatat di `admin_actions`), `GET`
  `/api/admin/announcements`, hapus (`src/api-admin.js:430-457`).
- Pemain: `GET /api/announcements` + tandai dibaca (`src/api-core.js:616-640`),
  tampil di Notifikasi → "APA YANG BARU", modal saat login bila belum dibaca,
  dan Buku Panduan → Riwayat Update dengan nomor otomatis Update #N.
- UI admin: Panel Admin → tab 📣 Pengumuman → form Judul + Isi + tombol
  TERBITKAN PENGUMUMAN (`public/js/app.js`, `renderAdminAnnouncements`).
- Update #1 (Tahap 4) dan #2 (Tahap 5) terbit lewat jalur ini (seed
  `src/db.js:1256-1266`); pengumuman baru otomatis jadi Update #3, #4, dst.
  Tanpa deploy/update game — baris DB dibaca langsung.
- Tes e2e [22i] sudah menutupinya (buat/hapus, nomor #3, baca/unread, 403
  untuk pemain biasa).

Yang DITAMBAH di commit ini (perbaikan kecil yang terkait): lencana 🔔 di
header kini ikut menghitung pengumuman yang belum dibaca (dulu hanya tabel
`notifications`, jadi pengumuman baru tidak menyalakan lencana), dan tombol
"Tandai Semua Dibaca" di halaman Notifikasi kini juga menandai semua
pengumuman dibaca (`POST /api/announcements/read { all: true }`).

## 2. Jumlah pemain online — BARU

Tanpa websocket (arsitektur game memakai polling): warga dianggap **online
bila memanggil `GET /api/me` dalam 5 menit terakhir**. Dashboard mem-poll
`/api/me` tiap 30 detik, jadi jendela 5 menit memberi toleransi beberapa
poll yang terlewat. Bila tidak ada aktivitas tercatat, tampil 0 (tanpa
data palsu).

### Backend

- `src/db.js`: kolom baru `citizens.last_seen_at BIGINT NOT NULL DEFAULT 0`
  (di `CREATE TABLE` + migrasi idempotent `migrateOnlineColumns`, pola yang
  sama seperti `migrateTahap5Columns`); `SCHEMA_VERSION` 6 → **7**.
  Indeks `idx_citizens_last_seen` dibuat DI DALAM migrasi (setelah
  `ADD COLUMN`), bukan di `schema()`: `schema()` jalan sebelum migrasi, dan
  database lama (Neon v6) belum punya kolom ini — indeks di `schema()` akan
  menggagalkan `initDb` dengan error Postgres 42703 saat deploy.
- `src/api-core.js`: `countOnline()` — `COUNT(*)` warga dengan
  `last_seen_at` segar + `u.is_banned = 0`. Heartbeat di `GET /api/me`:
  `UPDATE citizens SET last_seen_at` paling cepat 1×/menit/pemain,
  dilewati untuk akun banned (mereka tidak bisa memakai game, jadi keluar
  dari hitungan paling lambat 5 menit setelah di-ban), dibungkus
  try/catch agar gagal heartbeat tidak menggagalkan dashboard.
  `onlineCount` ditambahkan ke respons `/api/me` (segar) dan `/api/world`
  (ikut cache 30 detik Tahap 5 — masih segar untuk jendela 5 menit).

### Frontend (`public/js/app.js`)

- Dashboard: subjudul kini `Hari X · Populasi dunia: Y warga · 🟢 Z online`
  (tooltip: "Pemain aktif dalam 5 menit terakhir") — dibedakan jelas dari
  total populasi.
- Halaman Statistik: sel baru "🟢 Online Sekarang" + sub "aktif 5 menit
  terakhir" (dari `/api/world`).

### Tes

- e2e [22k] (12 cek baru): heartbeat memperbarui `last_seen_at`, throttle
  60 detik, hitungan 1 → 2, pemain basi 10 menit tidak terhitung, pemain
  banned tidak terhitung, `/api/world` memuat `onlineCount` (polling
  sampai respons segar karena cache 30 detik), lencana 🔔 naik/turun
  dengan pengumuman.
- pg-test: kolom `last_seen_at` ada (default 0) + bisa ditulis.
- pg-verify (Postgres 16 sungguhan): migrasi v6→v7 — hapus kolom +
  `initDb` menambahkannya kembali; penanda versi = 7.

## Hasil tes (lokal, 2026-11-27)

| Suite | Hasil |
|---|---|
| `test:pg` (pg-mem) | 35/35 |
| `npm test` (e2e SQLite) | 438/438 |
| `test:modal` (jsdom) | 118/118 |
| `test:pg-verify` (Postgres 16 lokal) | 41/41 |
| `test:conc` (Postgres 16 lokal) | 33/33 |
| `test:ssl` | 6/6 |
| **Total** | **671/671** |

Catatan: `test:conc` dan `test:pg-verify` butuh Postgres lokal di
127.0.0.1:5432 (role/database `parlementer_test`); di VM ini service
PostgreSQL 16 sempat dimatikan dan dinyalakan lagi untuk menjalankannya.
