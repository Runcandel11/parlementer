# Parlementer — Simulasi Geopolitik Online (Standalone)

Game web simulasi geopolitik multiplayer — warga, ekonomi, politik, perang, dan pers
dalam satu dunia bersama. Dibangun dengan desain dan tulisan sendiri (terinspirasi
genre-nya, bukan salinan situs mana pun).

**Stack:** Node.js 22 + Express + SQLite (lokal) / Postgres (production).
Satu akun = satu warga. Satu dunia dipakai semua pemain.

## Aturan dunia (penting)

- **100% tanpa bot.** Tidak ada nama random, warga/penjual/jurnalis/partai/pejuang
  palsu. Semua daftar mulai KOSONG (pasar 0 penawaran, 0 partai, 0 artikel,
  0 perang) dan hanya terisi oleh aksi pemain asli.
- Satu-satunya pengecualian: **6 lowongan resmi ADMIN** di Pekerjaan sebagai
  modal awal pemain baru.
- Paket awal warga baru: **50 emas, 500 USD, 3 Makanan / 3 Senjata / 3 Tiket T1**.

## Fitur

- **Auth:** daftar (email + password + nama warga) & masuk (email + password).
  Email unik, password di-hash bcrypt, sesi 30 hari via cookie httpOnly.
  Menu login tampil dulu sebelum masuk game. Tombol keluar di Pengaturan.
- **Dashboard:** level, XP, energi 100, emas + USD, latihan atribut
  (Kekuatan / Pendidikan / Ekonomi), kerja shift, klaim pasokan harian,
  misi harian, Kronik 5 babak, pencapaian (19 tonggak, total 1.275 emas).
- **Peta:** 17 wilayah Indonesia, perjalanan (1 Tiket), pemberontakan
  (50 emas; 100 emas untuk ibu kota Jakarta — 5 pendukung menyulut perang 24 jam).
- **Pasar lokal (USD) + Pasar Global (emas):** 15 komoditas, pajak penghasilan 2%,
  penawaran minimum 10 unit.
- **Valas:** cetak 1 emas = 10 USD + penawaran antar warga (berlaku 72 jam,
  1 penawaran terbuka per arah).
- **Pekerjaan:** lowongan ADMIN + lowongan perusahaan pemain (tetap / bagi hasil).
- **Perusahaan:** 4 jenis — Pabrik Sumber Daya 100 emas, Pabrik 100 emas,
  Industri Ringan 250 emas, Industri Berat 500 emas; produksi harian masuk
  inventaris pemilik.
- **Negara:** Republik Indonesia — presiden, 4 menteri, kas negara, pajak.
- **Partai:** dirikan butuh Level 10 + 50 emas; gabung langsung / lamaran / tertutup.
- **Parlemen:** 60 kursi, mayoritas 31, usul UU (Level 5 + 5 emas), voting 7 hari.
- **Pemilu:** presiden (hak pilih Level 5 + 3 hari jadi warga) & parlemen
  (kursi dibagi proporsional).
- **Perang:** front aktif, serang dari garis depan (harus di wilayah perang,
  10 energi + 1 senjata; Drone ×1,5 kerusakan).
- **Pers:** dirikan koran 5 emas, tulis/baca/komentar artikel, reaksi, Liga Pers.
- **Obrolan:** tab Global / Indonesia / Negara (+ Ruang Sidang & chat per front
  perang), avatar + nama + tag partai + ikon premium + jam kirim, pratinjau
  tautan artikel, laporkan (Pelecehan / Ujaran kebencian / Spam / Lainnya) &
  blokir. Chat mulai kosong.
- **Pesan pribadi (DM), Organisasi, Kontrak, Konvoi, Notifikasi, Profil.**
- **Toko:** harga rupiah — Premium 1 bln Rp5.000, 3 bln Rp15.000, 6 bln Rp25.000,
  12 bln Rp45.000; Paket Pemula Rp15.000, Deluxe Rp50.000, Ultimate Rp100.000.
  Semua tombol beli mengarah ke WhatsApp https://wa.me/6285220743283
  (top-up manual via WA).
- **Daily tick:** dunia maju 1 hari tiap tengah malam (pasokan harian, produksi
  perusahaan, progres perang/voting/pemilu, refund valas kedaluwarsa, konvoi
  kedaluwarsa). Berjalan otomatis saat ada yang membuka game + interval 10 menit
  — tanpa cron eksternal, jadi aman di Render free.

## Menjalankan lokal

```bash
npm install
npm start          # http://localhost:3000
```

Variabel environment (lihat `.env.example`):

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `PORT` | `3000` | Port server |
| `DATABASE_URL` | — | Connection string Postgres (bila disetel, Postgres dipakai) |
| `DATABASE_PATH` | `./data/parlementer.db` | File SQLite lokal (dipakai bila `DATABASE_URL` kosong) |
| `JWT_SECRET` | secret dev | **Wajib diganti di production** (string acak panjang) |

## Tes

```bash
npm test          # e2e HTTP di SQLite (DB sekali pakai): 74 pemeriksaan
npm run test:pg   # jalur Postgres via pg-mem: 18 pemeriksaan
npm run test:all  # keduanya
```

Hasil terakhir (27 Nov 2026): **e2e 74/74 lolos, pg-test 18/18 lolos.**
Alur e2e: daftar → login → klaim (+5 emas/+50 USD/+2 XP) → latih → lamar kerja
ADMIN → shift (bruto 48, bersih 47,04 setelah pajak 2%) → pasar (jual/beli,
pajak 2%) → makan → valas (cetak 1 emas = 10 USD) → perjalanan (1 Tiket) →
chat + lapor + blokir → aturan dunia (partai Level 10, pasar 0) → daily tick
(hari 1 → 2, energi pulih 100) → logout.

**Catatan jujur soal tes Postgres:** jalur Postgres diverifikasi lewat pg-mem
(emulator), BUKAN Postgres sungguhan — tidak ada server Postgres di mesin ini.
Dua batasan pg-mem 2.8.1 ditemukan dan didokumentasikan di `test/pg-test.js`:
(1) `kolom INTEGER - $param` dihitung terbalik (bug emulator; SQL aplikasi
benar di Postgres sungguhan — pola yang sama lolos di tes e2e SQLite);
(2) ROLLBACK tidak berfungsi di emulator, jadi pemeriksaan rollback dilewati
dan harus diverifikasi di Postgres sungguhan saat deploy pertama.

## Deploy GRATIS — Vercel (Hobby, tanpa kartu) ← cara utama saat ini

Aplikasi sudah diadaptasi untuk Vercel Serverless Function (`api/index.js` +
`vercel.json`; Express app dipisah ke `src/app.js` supaya `node server.js`
tetap jalan normal). Paket **Hobby gratis, tanpa kartu**.

1. Buka https://vercel.com → **Sign Up** (bisa pakai akun GitHub `Runcandel11`).
2. **Add New → Project** → **Import** repo GitHub `Runcandel11/parlementer`
   (branch `master`). Framework Preset: **Other** (otomatis terdeteksi Node).
   Build Command & Output Directory biarkan default (Vercel memakai
   `npm install`; tidak ada langkah build).
3. Di **Environment Variables**, tambahkan:
   - `DATABASE_URL` = connection string Postgres Neon (wajib — Vercel tidak
     punya disk persisten; tanpa ini server mengembalikan error 500 yang jelas)
   - `JWT_SECRET` = string acak panjang (hasilkan sendiri, mis. `openssl rand -hex 32`)
   - `NODE_ENV` = `production`
4. Klik **Deploy**. Tunggu build selesai (±1–3 menit).
5. Buka URL yang diberikan Vercel (mis. `https://parlementer.vercel.app`).
   Daftar akun pertama — kamu jadi warga pertama (populasi 1).

Catatan Vercel:
- **Serverless, tanpa proses jalan terus:** tidak ada `listen()`/`setInterval`
  di fungsi — tick harian jalan otomatis tiap ada request API (`maybeTick`
  + klaim atomik di `src/tick.js`, jadi dua instance tidak bisa menjalankan
  tick yang sama). File statis `public/` dilayani langsung oleh Vercel.
- Pool Postgres dibatasi `max: 3` per instance agar aman untuk Neon free tier.
- Fungsi `api/index.js` memakai `maxDuration: 60` detik (maksimum paket Hobby).
- Cold start pertama butuh beberapa detik (init DB + seed ke Neon).
- Verifikasi setelah deploy: sama seperti langkah 4 di bawah (login → 50 emas/
  500 USD → 6 lowongan ADMIN → pasar 0 penawaran → klaim → 55 emas/550 USD).

## Deploy GRATIS — alternatif: Render + Neon

Target: **Render free tier** (web service) + **Postgres gratis di Neon**
(alternatif: Supabase free tier). Render free **tidak punya disk persisten**,
jadi database HARUS Postgres eksternal — jangan pakai SQLite di Render.
**Catatan (27 Nov 2026): Render mewajibkan kartu tersimpan sebelum deploy
meski paket Free $0/bulan (hanya otorisasi sementara $1) — itu alasan
pindah ke Vercel. Konfigurasi Render (`Dockerfile`, `render.yaml`) tetap
disimpan di repo sebagai alternatif.**

### 1. Siapkan kode di GitHub

1. Buat repository baru di GitHub (gratis), mis. `parlementer`.
2. Upload seluruh isi folder ini ke repo itu (`git push`).
   Jangan commit file `.env` atau folder `data/` (sudah ada di `.gitignore`).

### 2. Buat database Postgres gratis di Neon

1. Buka https://neon.tech — klik **Sign Up** (bisa pakai akun Google).
2. Buat project baru (nama bebas, mis. `parlementer`), region pilih yang
   terdekat (Singapore).
3. Setelah project jadi, buka **Dashboard → Connection Details**.
4. Salin **connection string** (bentuknya seperti ini):
   `postgres://user:password@ep-xxx.ap-southeast-1.aws.neon.tech/parlementer?sslmode=require`
5. Simpan string ini — ini `DATABASE_URL`-mu.

> Alternatif Supabase: https://supabase.com → New Project (free tier) →
> Settings → Database → Connection string (URI). Pakai port 5432 + password
> database yang kamu buat saat membuat project.

### 3. Deploy web service gratis di Render

1. Buka https://render.com — klik **Sign Up** (bisa pakai akun GitHub/Google).
2. Dashboard → **New + → Web Service** → hubungkan repo GitHub `parlementer`.
3. Isi form:
   - **Name:** `parlementer`
   - **Region:** Singapore
   - **Branch:** `main`
   - **Runtime:** Node
   - **Build Command:** `npm ci --omit=dev`
   - **Start Command:** `node server.js`
   - **Instance Type:** **Free**
4. Di bagian **Environment Variables**, tambahkan:
   - `DATABASE_URL` = connection string dari Neon (langkah 2)
   - `JWT_SECRET` = string acak panjang (klik **Generate** di Render)
   - `NODE_ENV` = `production`
5. Klik **Create Web Service**. Tunggu build selesai (±2–5 menit).
6. Buka URL yang diberikan Render (mis. `https://parlementer.onrender.com`).
   Daftar akun pertama — kamu jadi warga pertama (populasi 1).

> Atau pakai Blueprint: repo ini sudah berisi `render.yaml`. Di Render:
> **New + → Blueprint** → pilih repo → isi `DATABASE_URL` secara manual
> (ditandai `sync: false` di `render.yaml`) → Deploy.

### 4. Verifikasi setelah deploy

1. Buka URL game → halaman login muncul.
2. Daftar dengan email + password → dashboard menampilkan 50 emas, 500 USD.
3. Cek Pekerjaan: 6 lowongan ADMIN terlihat; cek Pasar: 0 penawaran.
4. Klaim pasokan harian → emas jadi 55, USD 550.

### Catatan Render free tier

- **Tidur setelah 15 menit tidak ada trafik** — kunjungan pertama setelah
  tidur butuh ~30–60 detik untuk bangun (normal di free tier).
- **750 jam/bulan gratis** — cukup untuk 1 service jalan terus.
- Tidak ada disk persisten — semua data penting ada di Postgres (Neon),
  jadi aman meski service restart/tidur.
- Neon free tier: 0,25 GB RAM, 10 GB penyimpanan, 1 project — cukup untuk
  awal. Supabase free tier: 500 MB database.

## Struktur proyek

```
server.js            # Launcher server biasa: ensureReady() + listen (Render/lokal)
src/
  app.js             # Express app + ensureReady() (dipakai server.js & api/index.js)
  db.js              # Adapter DB (Postgres via DATABASE_URL / SQLite lokal)
  util.js            # JWT cookie, auth middleware, validasi
  game.js            # Aturan main (gaji, pajak, XP, kronik, toko, dll.)
  api-core.js        # Auth, dashboard, kerja, pasar, valas, peta, toko
  api-civic.js       # Negara, partai, parlemen, pemilu, perang, pers, chat
  tick.js            # Daily tick + jadwal pemilu otomatis (+ klaim atomik)
api/
  index.js           # Vercel Serverless Function (adapter Express, tanpa listen)
vercel.json          # Routing Vercel: /api/* + SPA fallback -> api/index.js
public/
  index.html         # Halaman login + shell aplikasi
  css/style.css      # Tema gelap navy-hitam + aksen emas
  js/app.js          # SPA frontend (semua halaman)
test/
  e2e.js             # Tes end-to-end HTTP (SQLite)
  pg-test.js         # Tes jalur Postgres (pg-mem)
render.yaml          # Blueprint Render (free tier)
Dockerfile           # Alternatif deploy container
.env.example         # Contoh variabel environment
```

## Status

Siap deploy ke **Vercel (Hobby gratis, tanpa kartu)** atau Render.
**Belum di-deploy ke mana pun** — butuh akun gratis Vercel yang dibuat
pemilik (langkah di atas) + `DATABASE_URL` Neon yang sudah ada. Setelah
deploy pertama, verifikasi ulang: daftar → shift → jual/beli → chat di URL
production, dan cek ROLLBACK transaksi di Postgres sungguhan (lihat catatan
tes di atas).
