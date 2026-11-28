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
- Satu-satunya pengecualian: **18 lowongan resmi ADMIN** (satu per wilayah,
  Kepulauan Riau 2) di Pekerjaan sebagai modal awal pemain baru.
  **Lowongan ADMIN dibayar BAHAN MENTAH, bukan uang**
  (jenis bahan sesuai pekerjaannya — Besi/Minyak/Kayu/Gandum/Kapas/Batu Bara
  Mentah; jumlah per shift nilainya ≈ gaji lama ~48 USD). Pekerjaan dari
  perusahaan pemain tetap dibayar seperti semula (USD tetap / bagi hasil).
- Paket awal warga baru: **50 emas, 500 USD, 3 Makanan / 3 Senjata / 3 Tiket T1**.

## Fitur

- **Auth:** daftar (email + password + nama warga) & masuk (email + password).
  Email unik, password di-hash bcrypt (maks 72 karakter), sesi 7 hari via
  cookie httpOnly. Token bisa dicabut server-side (`token_version` — naik
  saat logout). Menu login tampil dulu sebelum masuk game. Tombol keluar di
  Pengaturan.
- **Dashboard:** level, XP, energi (batas 100 + 5×(level−1), +20 Premium,
  +10 RS Lapangan; pulih +2/menit), emas + USD, latihan atribut
  (Kekuatan / Pendidikan / Ekonomi — Pendidikan mempercepat latihan:
  jeda −5% per level, maks −50%; Ekonomi menaikkan gaji shift +3%/level),
  kerja shift, klaim pasokan harian (+5 emas, +50 USD, +40 XP),
  misi harian, Kronik 5 babak, pencapaian (19 tonggak, total 1.275 emas).
- **Peta besar:** peta geografis Indonesia (SVG, klik wilayah → panel
  politik/negara, cari wilayah, zoom); wilayah tanpa negara = kaca abu-abu
  + "?". **Peta:** 17 wilayah Indonesia, perjalanan butuh waktu
  (2 menit + 1 menit per 100 km, maks 30 menit; Kepri → Jakarta 10 menit),
  pindah kewarganegaraan gratis (jeda 7 hari), pemberontakan
  (50 emas; 100 emas untuk ibu kota Jakarta — 5 pendukung menyulut perang 24 jam).
- **Pasar lokal (USD) + Pasar Global (emas):** 16 komoditas, pajak
  penghasilan 2% (parlemen bisa mengubah 1–5% lewat UU; minggu Pasar
  Bergairah −1 poin), pajak impor = tarif negara pembeli (1–5% lewat UU;
  tanpa negara 2%), penawaran minimum 10 unit, ubah penawaran sendiri.
- **Valas:** cetak 1 emas = 10 USD + penawaran antar warga (berlaku 72 jam,
  1 penawaran terbuka per arah).
- **Pekerjaan:** lowongan ADMIN (dibayar bahan mentah, lihat di atas) +
  lowongan perusahaan pemain (tetap / bagi hasil). Menu Pekerjaan default
  hanya lowongan wilayah pemain saat ini. Satu tekan tombol kerja memakai
  SEMUA energi sekaligus (shift berturut-turut sampai habis).
- **Perusahaan:** 4 jenis — Pabrik Sumber Daya 100 emas, Pabrik 100 emas,
  Industri Ringan 250 emas, Industri Berat 500 emas; produksi harian masuk
  inventaris pemilik; rantai produksi penuh (tiap jenis butuh bahan baku —
  pemilik mengisi STOK perusahaan dulu lewat ISI BAHAN, bukan lagi diam-diam
  dari inventaris; stok habis → produksi & bonus shift berhenti + pemilik &
  pekerja diberi tahu); bonus ~1/10 produksi tiap shift; bisa diedit + pasang
  foto (maks 500 KB); upah lowongan bisa diedit pemilik (1–1000 USD/shift).
- **Negara:** TIDAK ADA negara awal — dunia mulai terpecah, warga mendirikan
  negara (Level 10 + 100 emas; pendiri bukan otomatis presiden). Ideologi
  (Konservatisme/Sosialisme/Liberalisme/Nasionalisme) + sistem pemerintahan
  (Presidensial/Parlementer/Imperial/Diktator) berefek nyata (pajak, upah,
  klaim, kerusakan perang). Unifikasi wilayah lewat voting warga wilayah itu.
  Warga bisa menyumbang emas / Rupiah / bahan ke kas negaranya sendiri
  (tercatat di arus kas).
- **Partai:** dirikan butuh Level 10 + 50 emas; gabung langsung / lamaran / tertutup.
- **Parlemen:** dibuka **2 Desember 2026** (sebelumnya terkunci); 60 kursi,
  mayoritas 31, usul UU (Level 5 + 5 emas), voting 7 hari. UU bisa mengubah
  pajak penghasilan, pajak impor, upah ADMIN, biaya perjalanan,
  ideologi, dan sistem pemerintahan.
- **Pemilu:** presiden (hak pilih Level 5 + 3 hari jadi warga; calon hanya
  lewat nominasi ketua partai) & parlemen (kursi dibagi proporsional).
- **Perang + Militer:** front aktif, serang dari garis depan (harus di
  wilayah perang, 10 energi + 1 senjata). Rekrut 3 unit — Infanteri,
  Drone Perang, Kendaraan Berat — yang menaikkan pengali kerusakan perang
  (maks ×1,5) + perawatan harian; wilayah yang kalah perang berpindah
  pengendali (pajaknya mengalir ke panglima perang).
- **Pers:** dirikan koran 5 emas, tulis/baca/komentar artikel, reaksi, Liga Pers.
- **Obrolan:** tab Global / Indonesia / Wilayah (+ Ruang Sidang & chat per front
  perang), avatar + nama + tag partai + ikon premium + jam kirim, pratinjau
  tautan artikel, laporkan (Pelecehan / Ujaran kebencian / Spam / Lainnya) &
  blokir, daftar pemain yang diblokir. Chat mulai kosong.
- **Kredit skor:** semua warga mulai 100; laporan chat yang TERBUKTI benar
  oleh admin menurunkan skor penulis −10; pulih +1/hari; makin rendah makin
  banyak batasan (pers <80, partai <60, pasar <40, chat/DM <20); skor 0 =
  akun banned otomatis (bisa banding; unban mengembalikan skor ke 50).
- **Event dunia mingguan** (rotasi 6 minggu, deterministik): Panen Raya,
  Festival Rakyat, Badai Besar, Wabah Melanda, Pasar Bergairah, Darurat
  Militer — masing-masing mengubah angka game (upah, XP, pajak, biaya
  latih, kerusakan, waktu travel).
- **Reputasi dagang + demografi:** tiap transaksi pasar selesai +1 reputasi
  (pembeli & penjual; tier Pedagang Baru → Saudagar Besar); halaman wilayah
  menampilkan demografi + kekuatan militer wilayah.
- **Minuman energi:** 0,10 emas/kaleng, +1 energi (beli + minum di Inventaris;
  satu tekan minum sekaligus sampai energi penuh, sisa kaleng tetap di inventaris).
- **Konvoi:** bangun dengan BAHAN MENTAH (bukan emas) — RS Lapangan, Sekolah
  Keliling, Gudang Industri, Pos Militer — masing-masing memberi bonus nyata.
- **Tiket (Laporan & Saran):** pemain mengirim saran/laporan dari dalam game;
  admin membalas dari panel Admin; saran yang dipakai dihadiahi 50 emas.
- **Pesan pribadi (DM), Organisasi, Kontrak, Notifikasi, Profil.**
- **Akun Admin:** hanya akun Khalid (`koboijuniorkhalid@gmail.com`, sudah
  terdaftar sebagai admin sejak 27 Nov 2026). Pemberian admin berbasis email
  DICABUT 27 Nov 2026 — registrasi baru dengan email apa pun tidak lagi jadi
  admin. Satu-satunya jalan darurat membuat admin: daftar dengan kode
  bootstrap `ADMIN_BOOTSTRAP_CODE` (env var, lihat di bawah). Panel Admin:
  daftar pemain (cari nama/email/ID), Ban/Unban (wajib alasan; akun banned
  tetap bisa login untuk mengajukan banding), beri Premium 1/3/6/12 bulan,
  Emas, USD, Barang (T1–T5), isi Energi, hadiah massal — semua aksi tercatat
  di log admin (`admin_actions`). Aksi admin dibatasi 120 POST/jam per admin.
- **Referral:** setiap pemain punya kode unik 8 karakter (tanpa 0/O/1/I/l);
  daftar dengan kode valid → bonus **cair saat pendaftar mencapai Level 3**:
  pemilik kode **+200 emas + 2 hari premium**, pendaftar baru **+100 emas +
  1 hari premium** (premium diperpanjang dari yang masih aktif). Maks **5
  bonus terbayar per hari per pemilik kode** (anti farming multi-akun;
  bonus ke-6+ hari itu ditunda). Form daftar ada field Kode Referral + link
  share `?ref=CODE`. Profil menampilkan kode, link share, jumlah pemakai, dan
  total emas referral yang sudah cair.
- **Bagikan Link (harian):** setiap pemain punya link pribadi stabil
  `/s/<kode>` (tombol 🔗 di top bar, di samping tombol iklan). Siapa pun bisa
  mengklik TANPA login; tiap klik unik memberi pemilik **+10 emas**, anti-fraud
  **1 IP = 1 klik terhitung per hari per link**, maks **200 emas/hari**
  (= 20 klik unik). Klik + emas tercatat untuk audit; panel Admin menampilkan
  statistik share per pemain (klik & emas hari ini + total). Sistem ini
  TERPISAH dari referral (yang cair saat pendaftar Level 3).
- **Notifikasi:** pusat notifikasi di ATAS halaman (sebelum pengumuman
  "APA YANG BARU"); notifikasi sistem ditandai chip teal ⚙️ SISTEM agar
  terbedakan dari pengumuman update game.
- **ID pemain:** setiap pemain punya ID publik `PL-000001` dst. (dari id
  database), tampil di Profil dan panel Admin.
- **Toko:** harga rupiah — Premium 1 bln Rp5.000, 3 bln Rp15.000, 6 bln Rp25.000,
  12 bln Rp45.000; Paket Pemula Rp15.000, Deluxe Rp50.000, Ultimate Rp100.000.
  Semua tombol beli mengarah ke WhatsApp https://wa.me/6285220743283
  (top-up manual via WA).
- **Daily tick:** dunia maju 1 hari tiap tengah malam (pasokan harian, produksi
  perusahaan, progres perang/voting/pemilu, refund valas kedaluwarsa, konvoi
  kedaluwarsa, reset misi harian, perawatan militer). Berjalan otomatis saat
  ada yang membuka game + interval 10 menit — tanpa cron eksternal, jadi
  aman di Render free. Di VPS, service `parlementer` jalan terus (systemd)
  dan tick berkala tetap jalan lewat interval yang sama.

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
| `JWT_SECRET` | secret dev | **Wajib di production** — server MENOLAK start bila tidak disetel atau masih secret dev (string acak panjang, mis. `openssl rand -hex 32`) |
| `ADMIN_BOOTSTRAP_CODE` | — | Kode darurat membuat admin lewat registrasi (field "KODE ADMIN" di form daftar). Bila kosong, registrasi tidak bisa membuat admin. Isi di Vercel → Settings → Environment Variables. Jaga kerahasiaannya seperti password. |

## Tes

```bash
npm test            # e2e HTTP di SQLite (DB sekali pakai): 1046 pemeriksaan
npm run test:pg     # jalur Postgres via pg-mem: 46 pemeriksaan
npm run test:modal  # DOM modal laporan (jsdom): 155 pemeriksaan
npm run test:all    # pg + e2e + modal + chat-dom
npm run test:pg-verify # migrasi initDb di Postgres 16 sungguhan: 178 pemeriksaan
npm run test:conc    # balapan HTTP (pasar/klaim/shift/pencapaian/blokir) di Postgres 16: 38 pemeriksaan
npm run test:stage7-dom # DOM integrasi Tahap 7 (jsdom): 28 pemeriksaan
npm run test:load    # stress test lokal (20 + 50 VU): hasil mentah docs/loadtest-2026-11-28.json
npm run test:recovery # uji pemulihan (SIGKILL di tengah burst): 13 pemeriksaan
# Suite DOM lain: test:chat-dom (43), test:market-dom (14),
# test:ui-batch2 (53), test:landing-glass (40), test:photo-upload (32),
# test:profile-admin (52), test:ssl (6), test:jobs-region (22),
# test:ui-icons (18), test:company-dom (25), test:map-dom (47),
# test:credit-dom (22), test:ticket-dom (56), test:stage6-dom (27),
# test:bottom-nav (29), test:ads (20), test:offside (24),
# test:topbar (31), test:share (28), test:xp-rollback (49).
# Total seluruh suite: 2129 pemeriksaan (+ 13 uji pemulihan).
```

Hasil terakhir (28 Nov 2026, v4.6.0): **e2e 1046/1046 lolos,
pg-test 46/46 lolos, modal 155/155 lolos, pg-verify 178/178 lolos,
pg-concurrency 38/38 lolos, stage7-dom 28/28 lolos, share-dom 28/28 lolos** — dan semua suite
DOM lain hijau (lihat daftar di atas). Catatan: e2e pernah sekali
menghitung 907/907 (satu check kondisional yang kadang tereksekusi,
0 gagal di 7 run berturut-turut) — flake jumlah, bukan kegagalan.
Alur e2e: daftar → login → klaim (+5 emas/+50 USD/+40 XP) → latih → lamar
kerja ADMIN → shift (**dibayar 44× Besi Mentah**, setara ~48,40 USD; USD tidak
berubah) → pasar (jual/beli, pajak 2%) → makan → valas (cetak 1 emas = 10 USD)
→ perjalanan (1 Tiket) → chat + lapor + blokir → aturan dunia (partai Level 10,
pasar 0) → daily tick (hari 1 → 2, energi pulih 100) → logout → **referral
(bonus cair di Level 3, maks 5/hari) + admin bootstrap (email admin tanpa kode
TIDAK jadi admin; kode bootstrap benar jadi admin)** → ban (login akun banned
tetap bisa, ditandai `banned:true`, untuk banding) + banding (ajukan/balas/
terima/tolak) + avatar + hadiah/pembelian + hadiah massal + inbox admin.

**Verifikasi Postgres sungguhan (27 Nov 2026, Tahap 2):** `test/pg-verify.mjs`
menguji `initDb` di Postgres 16 lokal — idempotent (2× + 3× paralel),
perbaikan state lama (kolom timestamp INTEGER → BIGINT, tipe komposit yatim,
kolom `token_version`), 12 CHECK saldo/qty terpasang + ditegakkan, dan
JWT_SECRET fail-closed di production. `test/pg-concurrency.mjs` menguji
balapan HTTP paralel di Postgres 16: dua pembeli berebut 1 penawaran (tepat 1
berhasil), dua klaim (tepat 1), dua shift (tepat 1), dua klaim pencapaian
(tepat 1), dua blokir (keduanya 200, 1 baris) + invarian tanpa saldo negatif.
Kedua skrip butuh Postgres 16 lokal + role/db `parlementer_test` (lihat
header masing-masing skrip) dan BUKAN bagian dari `test:all`.

**Catatan jujur soal tes Postgres:** jalur Postgres diverifikasi lewat pg-mem
(emulator) untuk `test:pg`, TAPI migrasi `initDb` (termasuk migrasi admin/
referral/lowongan ADMIN) sudah diverifikasi di **Postgres 16 sungguhan**
(lokal, 27 Nov 2026, 16/16 — lihat di atas). Dua batasan pg-mem 2.8.1
ditemukan dan didokumentasikan di `test/pg-test.js`:
(1) `kolom INTEGER - $param` dihitung terbalik (bug emulator; SQL aplikasi
benar di Postgres sungguhan — pola yang sama lolos di tes e2e SQLite);
(2) ROLLBACK tidak berfungsi di emulator, jadi pemeriksaan rollback dilewati
dan harus diverifikasi di Postgres sungguhan saat deploy pertama.

## Deploy LIVE saat ini — VPS (parlementer.my.id)

Game sudah LIVE di **https://parlementer.my.id** (VPS Ubuntu, Node 22 +
Postgres lokal, systemd service `parlementer`, nginx reverse proxy,
HTTPS Let's Encrypt). Deploy otomatis: setiap push ke `master` di GitHub
ditarik otomatis oleh cron auto-pull di VPS (tiap 3 menit: `git pull
--ff-only` → `npm install` bila `package.json` berubah → restart service).
**https://parlementer.vercel.app tetap hidup tapi hanya me-redirect
semuanya ke parlementer.my.id** (bukan lagi tempat game berjalan).

## Deploy GRATIS — Vercel (Hobby, tanpa kartu) ← dulu cara utama, kini hanya redirector

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
3. Cek Pekerjaan: 18 lowongan ADMIN terlihat; cek Pasar: 0 penawaran.
4. Klaim pasokan harian → emas jadi 55, USD 550, +40 XP.

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
server.js            # Launcher server biasa: ensureReady() + listen (VPS/lokal)
src/
  app.js             # Express app + ensureReady() (dipakai server.js & api/index.js)
  db.js              # Adapter DB (Postgres via DATABASE_URL / SQLite lokal)
  util.js            # JWT cookie, auth middleware, validasi
  game.js            # Aturan main (gaji, pajak, XP, kronik, toko, konstanta) — SUMBER TUNGGAL angka
  api-core.js        # Auth, dashboard, kerja, pasar, valas, peta, toko, misi, kronik
  api-civic.js       # Negara, partai, parlemen, pemilu, perang, pers, chat, pajak
  api-admin.js       # Panel admin (grant, tiket, pengumuman, skor kredit)
  api-appeals.js     # Banding akun banned
  api-military.js    # Rekrut/buang unit militer
  tick.js            # Daily tick + jadwal pemilu otomatis (+ klaim atomik)
  bcrypt-pool.js     # Pool worker bcrypt (login cepat)
api/
  index.js           # Vercel Serverless Function (adapter Express, tanpa listen)
vercel.json          # Routing Vercel: /api/* + SPA fallback -> api/index.js
docs/
  AUDIT.md           # Audit Tahap 1 + cakupan Tahap 2–8
  ARSITEKTUR.md      # Keputusan arsitektur + register sumber-tunggal
public/
  index.html         # Halaman login + shell aplikasi
  css/style.css      # Tema gelap navy-hitam + aksen emas
  js/app.js          # SPA frontend (semua halaman)
test/
  e2e.js             # Tes end-to-end HTTP (SQLite)
  pg-test.js         # Tes jalur Postgres (pg-mem)
  pg-verify.mjs      # Tes migrasi initDb di Postgres 16 sungguhan
  pg-concurrency.mjs # Tes balapan HTTP di Postgres 16 sungguhan
  *-dom.js           # Suite DOM per fitur (jsdom): chat, market, map, credit,
                     # ticket, stage6, stage7, dst.
render.yaml          # Blueprint Render (free tier)
Dockerfile           # Alternatif deploy container
.env.example         # Contoh variabel environment
```

## Status

**LIVE di https://parlementer.my.id (v4.2.0, Tahap 8)** — VPS + Postgres
lokal, deploy otomatis tiap push ke `master` (auto-pull 3 menit).
Vercel hanya redirector ke domain utama. Detail arsitektur + keputusan
desain: lihat `docs/ARSITEKTUR.md`. Audit + cakupan tahap overhaul:
lihat `docs/AUDIT.md`.
