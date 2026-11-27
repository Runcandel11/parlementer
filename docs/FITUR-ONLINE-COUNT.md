# Fitur: Jumlah Pemain Online + perbaikan kecil badge pengumuman

Disiapkan 2026-11-27 17:15 WIB (riset proaktif) untuk agen Tahap 6 — dikerjakan
SETELAH migrasi VPS selesai, bukan sebelum. Permintaan Khalid 2026-11-27
17:05 WIB: "tambahkan juga berapa player yang online sekarang".

## Status pengecekan

- Jumlah pemain online: SUDAH DIIMPLEMENTASI — commit fitur online (SCHEMA_VERSION 7): kolom `citizens.last_seen_at`, heartbeat di `GET /api/me` (throttle 60 dtk), `onlineCount` di `/api/me` + `/api/world`, tampil di dashboard + halaman Statistik, jendela **5 menit** (bukan 2 menit — sesuai arahan pemilik saat penugasan), banned tidak terhitung. Tes e2e [22k].
- Pengumuman manual admin: SUDAH ADA dan live sejak Tahap 4 (commit
  6854e3b, terverifikasi live 15:41 WIB) — JANGAN dibangun ulang. Lihat
  catatan di bawah. Perbaikan kecil yang ikut dikerjakan di commit fitur
  online: lencana 🔔 kini ikut menghitung pengumuman belum dibaca, dan
  tombol "Tandai Semua Dibaca" di halaman Notifikasi juga menandai semua
  pengumuman dibaca (sebelumnya lencana tidak menyala untuk pengumuman
  dan tombol itu tidak membersihkannya).

## Desain jumlah online (jujur: polling, bukan socket)

Arsitektur game memakai polling, bukan websocket: client memanggil
`/api/me` tiap 30 detik (`public/js/app.js:300`, `refreshMe`, skip bila tab
tersembunyi) dan chat tiap 5 detik (`:2405`). Jadi "online" didefinisikan
sebagai **aktif dalam 2 menit terakhir** — tulis label itu di UI
("🟢 X pemain online"), jangan klaim real-time.

### 1. Migrasi (idempotent, pola yang sama seperti migrasi lain)

`src/db.js`: `ALTER TABLE citizens ADD COLUMN IF NOT EXISTS last_seen_at
BIGINT NOT NULL DEFAULT 0` (+ index bila perlu). Kolom ini tidak ada
sekarang — `citizens` sudah punya `last_chat_at` (`src/db.js:295`) tapi itu
hanya terisi saat chat, bukan heartbeat.

### 2. Heartbeat: sentuh di GET /api/me

`src/api-core.js:347` (`GET /api/me`, sudah memuat baris citizen `c`).
Setelah load, bila `Date.now() - c.last_seen_at > 60000`, jalankan
`UPDATE citizens SET last_seen_at = ? WHERE id = ?`. Throttle 60 detik =
maks 1 write/menit/pemain — murah di Postgres lokal VPS; jangan sentuh di
polling chat 5 detik (terlalu cerewet).

### 3. Hitung + tampilkan

- Di `GET /api/world` (dashboard sudah memanggilnya,
  `public/js/app.js:1847`) atau `/api/me`, tambahkan
  `onlineCount = SELECT COUNT(*) FROM citizens WHERE last_seen_at >
  Date.now() - 120000`.
- Tampilkan di HUD/dashboard dekat energi/level, mis. "🟢 12 online".
- Pemain banned otomatis keluar dari hitungan setelah 2 menit (mereka
  tidak bisa memanggil `/api/me` — login ditolak / layar banned).

### 4. Tes yang harus lolos

- e2e: `/api/me` memperbarui `last_seen_at` (throttle 60 dtk dihormati);
  count mencakup pemain segar, mengecualikan yang `last_seen_at`-nya
  > 2 menit lalu; banned tidak terhitung.
- UI: angka tampil di dashboard; label "online" menjelaskan jendela
  2 menit.

## Perbaikan kecil: badge 🔔 tidak menyala untuk pengumuman

`GET /api/me` (`src/api-core.js:352-353,394`): `ME.unread` hanya menghitung
tabel `notifications`. Pengumuman yang belum dibaca TIDAK masuk badge —
pemain tetap melihatnya lewat modal saat login
(`maybeShowAnnouncement`, `public/js/app.js:2673`) dan halaman Notifikasi.
Perbaikan satu query: tambahkan jumlah pengumuman belum dibaca
(`NOT EXISTS` di `announcement_reads` untuk citizen ini) ke `unread`.

## Catatan: pengumuman manual admin SUDAH ADA — jangan dibangun ulang

- Endpoint: `POST /api/admin/announcements` (`src/api-admin.js:434`),
  `GET /api/admin/announcements` (`:430`), hapus (`:446`). Judul maks
  120 karakter, isi maks 5000, tercatat di log admin.
- UI admin: Panel Admin → tab 📣 Pengumuman
  (`renderAdminAnnouncements`, `public/js/app.js:1108-1134`, route
  `#/admin/announcements` di `:995`).
- Pemain melihatnya di: Notifikasi → "APA YANG BARU" (`:794-813`),
  modal saat login bila belum dibaca, dan Buku Panduan → Riwayat Update
  dengan nomor otomatis (Update #N, `src/api-core.js:610-633`).
- Tanpa deploy/update game — baris DB dibaca langsung. Sudah live sejak
  Tahap 4; Update #1 (Tahap 4) dan #2 (Tahap 5) sudah terbit lewat jalur
  ini (`src/db.js:1256-1266`).
- Belum diuji klik langsung di situs live oleh peneliti ini — verifikasi
  klik (terbitkan pengumuman tes → cek modal pemain) diserahkan ke
  delivery/agen Tahap 6.
