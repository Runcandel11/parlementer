# TAHAP 5 — Pemerintahan & Diplomasi (satu negara) + 3 bug laporan Khalid

Tanggal: 2026-11-27. Commit: (diisi saat commit). Status: selesai, semua suite hijau.
Cakupan audit §7 yang dikerjakan: UU yang disahkan kini punya efek mekanis,
wewenang menteri, anggaran negara, pemakzulan, dan diplomasi antar organisasi.
**Multi-country tetap DITUNDA** (keputusan Khalid: sampai populasi pemain stabil)
— tidak ada sistem multi-negara di tahap ini.

## 1. Yang diubah — pemerintahan

**UU berjenis (`LAW_KINDS`, src/game.js + src/api-civic.js + src/tick.js §4):**
- `tax_income` (1–5%): mengubah `country.tax_income` — pajak penghasilan yang
  dipotong dari penjualan pasar. Sebelum Tahap 5, UU yang lolos tidak mengubah
  apa pun (BUG-9 audit). Default tetap 2%.
- `admin_pay` (80–120%): mengubah `country.admin_pay_mult` — pengali upah
  barang lowongan ADMIN (mis. 44× Besi → 52× pada 120%).
- `travel` (1–2 Tiket): mengubah `country.travel_tickets` — biaya perjalanan.
- `general`: tanpa efek angka (tetap bisa diusulkan/ditandai jelas).
- Usulan UU: Menteri Ekonomi gratis, warga lain bayar 5 emas. Efek diterapkan
  tick saat UU lolos (`effect_applied=1`), dengan teks efek di notifikasi.
- Halaman Parlemen menampilkan panel "ATURAN YANG BERLAKU SAAT INI" (pajak,
  upah ADMIN, tiket perjalanan, anggaran aktif, mobilisasi) + form UU dengan
  pemilih jenis dan input nilai dinamis.

**Anggaran negara (Menteri Ekonomi):** usulkan anggaran 50–500 emas
(`claim` = klaim harian +2 emas, `train` = latihan 10% lebih murah,
`war` = +10% kerusakan perang), voting parlemen 3 hari, bila lolos kas
negara dipotong dan anggaran aktif 7 hari. Satu anggaran voting dalam satu
waktu. Penutupan di tick.js §4b (kas tidak cukup → gagal + notifikasi).

**Wewenang menteri (src/api-civic.js):**
- Menteri Pertahanan — Mobilisasi: 100 emas kas negara, +10% kerusakan
  perang 24 jam, notifikasi ke semua warga.
- Menteri Dalam Negeri — Hari libur: 50 emas kas negara, +20 energi untuk
  SEMUA warga (dibatasi per warga oleh rumus cap energi), cooldown 24 jam.
- Menteri Luar Negeri — memediasi pakta antar organisasi (lihat §2).
- Menteri Ekonomi — mengusulkan anggaran + mengusulkan UU gratis.

**Pemakzulan (tick.js §4c):** anggota parlemen mengusulkan, voting 3 hari,
bila lolos presiden dicopot (`president_id = NULL`) sampai pemilu berikutnya.
Presiden tidak bisa memakzulkan dirinya sendiri. Satu pemakzulan aktif
dalam satu waktu.

**Halaman Negara:** menampilkan % upah ADMIN, jumlah Tiket perjalanan,
tarif pajak dinamis, panel "WEWENANG MENTERI" (status anggaran/mobilisasi +
tombol aksi sesuai jabatan). Kas negara (treasury ledger) kini menampilkan
tanda minus dengan benar untuk pengeluaran.

## 2. Yang diubah — diplomasi (antar organisasi, bukan antar negara)

**Pakta antar organisasi (src/api-civic.js):**
- `trade` (Perjanjian Dagang): pajak penghasilan antar anggota kedua
  organisasi dipotong 50% (mis. pajak 4% → 2%).
- `defense` (Pakta Pertahanan): anggota kedua organisasi +10% kerusakan
  perang (ditampilkan sebagai label bonus di halaman perang + toast serangan).
- Alur: ketua organisasi (atau Menteri Luar Negeri sebagai mediator)
  mengusulkan → ketua organisasi satunya menyetujui/menolak → ketua salah
  satu bisa membubarkan kapan saja. Pasangan disimpan terurut (lo/hi) agar
  usulan dua arah dianggap satu pasangan. Penolakan/pembubaran menghapus
  baris (riwayat ada di notifikasi).
- Bonus perang kini bertumpuk dan diberi label: anggaran perang, mobilisasi,
  pakta pertahanan (masing-masing ×1,1, dibulatkan).
- Halaman Organisasi menampilkan panel "PAKTA ANTAR ORGANISASI" (daftar
  aktif/pending + tombol setujui/tolak/bubarkan + form usulan).

## 3. Bug laporan Khalid (satu commit dengan Tahap 5)

### 3a. Semua pemain baru lahir di Kepulauan Riau
- Penyebab: registrasi hardcode `region_id = 1` / `home_region_id = 1`, dan
  region id 1 = Kepulauan Riau. Kolom juga punya `DEFAULT 1`.
- Perbaikan: registrasi memilih region acak (`ORDER BY RANDOM() LIMIT 1`)
  dari tabel regions; `DEFAULT 1` dihapus dari CREATE TABLE + migrasi pg
  menghapus default di DB live. **Pemain lama TIDAK dipindah** (termasuk Khalid).
- Tes: 20 akun yang terdaftar di suite tersebar ke 11 wilayah berbeda;
  wilayah pemain lama tidak berubah.

### 3b. "Invalid Date" di semua pesan chat
- Akar masalah: node-postgres mengembalikan BIGINT sebagai **string**; jadi
  `new Date("1793...")` = Invalid Date di live Neon. SQLite lokal
  mengembalikan number, sehingga tes lokal tidak pernah melihat bug ini.
- Perbaikan: (a) `src/db.js` `ensurePool()` memasang parser int8
  (`pg.types.setTypeParser(20, v => parseInt(v, 10))`) sebelum `new pg.Pool`;
  (b) `public/js/app.js` helper `toDate()` + `fmtTime`/`fmtDate`/`ago`
  memaksa `Number()` dan mengembalikan '—' untuk null/tidak valid (bukan
  "Invalid Date").
- Verifikasi: pg-verify §8 membaca `created_at` lewat pool aplikasi dan
  memastikan `typeof === 'number'`; modal-dom §14 memanggil `fmtTime`/`ago`
  dengan timestamp STRING; screenshot Playwright 390×844 halaman chat
  menampilkan jam "09.08" yang valid, tanpa "Invalid Date".

### 3c. Lag ("Ngeleg banget gamenya")
- Penyelidikan: kode game cepat secara lokal (lihat §5). Live lambat karena
  **cold start Vercel + koneksi Neon**, bukan beban pemain (9 pemain).
- Perbaikan berisiko rendah yang diterapkan: (a) polling `/api/me` (30 dtk)
  dan chat (5 dtk) **dilewati saat tab tidak aktif** (`document.hidden`) +
  refresh langsung saat tab kembali aktif; (b) `/api/world` di-cache 30 detik
  di memori per instance (3 query hemat per panggilan hangat; data per pemain
  TIDAK di-cache); (c) parser int8 (di atas) menghilangkan satu mode gagal.
- **Sengaja TIDAK dilakukan:** throttle `maybeTick` 60 detik — akan merusak
  `forceTick` di tes e2e §22f/g dan mengubah kontrak timing tick harian.
- **Tidak ada perubahan paket/hosting berbayar.** Lihat §6 untuk rekomendasi.

## 4. Bug yang ketemu & diperbaiki selama pengujian Tahap 5

1. **INSERT pemakzulan salah jumlah nilai** (`api-civic.js`): `VALUES
   (?,?,?,'voting',?,?)` untuk 5 kolom → 500 di semua usulan pemakzulan.
   Diperbaiki jadi `(?,?,'voting',?,?)`.
2. **INSERT lowongan default perusahaan tertukar** (`api-core.js`, dua tempat:
   `POST /api/companies` dan `POST /api/companies/:id/job`): `seats_taken`
   terisi `region_id` warga dan `region_id` terisi 0. Tersembunyi selama
   semua pendiri perusahaan lahir di region 1 (`seats_taken=1 ≤ seats=1`
   lolos CHECK); setelah wilayah lahir acak, pendiri di region > 1 langsung
   gagal CHECK `seats_taken <= seats` (500). Diperbaiki: `seats_taken=0`,
   `region_id` = wilayah pemilik, `seats` = jumlah yang diminta (di
   endpoint `:id/job`, jumlah kursi yang diminta sebelumnya diabaikan).
   Catatan data live: perusahaan yang didirikan sebelum perbaikan ini punya
   lowongan default dengan `seats_taken=1` (terlihat penuh) + `region_id=0`;
   tidak bisa dibedakan dengan aman dari lowongan 1 kursi yang memang sudah
   terisi, jadi **tidak ada migrasi data** — perusahaan baru sudah benar.
3. **Urutan tabel skema** (`db.js`): `org_pacts` didefinisikan sebelum
   `organizations` — SQLite membolehkan FK ke tabel yang belum ada, pg/pg-mem
   menolak. Tabel dipindah ke setelah `org_members`.
4. **Race usulan pakta paralel** (`api-civic.js`): INSERT tanpa pelindung →
   yang kalah 500. Kini `ON CONFLICT DO NOTHING` + 400 (pola yang sama
   dengan vote UU/anggaran/pemakzulan).
5. **Komentar `//` di dalam template literal skema SQL** (`db.js`): membuat
   server gagal start (SQLite "near /: syntax error"). Diubah ke komentar
   SQL `--`.

## 5. Hasil tes — semua hijau

| Suite | Hasil | Keterangan |
|---|---|---|
| e2e (`npm test`) | **412/412** | baseline 329 → +83 (§23 Tahap 5: 70+ cek; §5/§9 disesuaikan wilayah acak) |
| modal-dom | **71/71** | baseline 56 → +15 (§14: parlemen, orgs, fmtTime/ago string) |
| pg (pg-mem) | **28/28** | — |
| pg-verify (Postgres 16) | **34/34** | baseline 25 → +9 (§8: tabel/kolom/CHECK Tahap 5, Update #2, tanpa default region, parser int8) |
| pg-concurrency | **33/33** | baseline 24 → +9 (§7 pakta race, §8 vote anggaran race) |
| ssl-warning | **6/6** | — |
| **TOTAL** | **584/584** | baseline 468 → **+116** |

Tambahan di luar suite:
- **Screenshot Playwright 390×844** halaman chat global: jam "09.08" tampil
  benar, tidak ada "Invalid Date" (modal pengumuman Update #2 ditutup dulu
  lewat NANTI agar yang difoto adalah chat).
- **Latensi lokal setelah perbaikan** (SQLite, server sekali pakai):
  cold register 191,8 ms; warm `/api/world` median 2,5 ms; `/api/me` 3,5 ms;
  `/api/chat/global` 2,2 ms; `/api/regions` 2,8 ms; 10× paralel `/api/me`
  18,8 ms total. Sama cepatnya dengan baseline sebelum perbaikan (kode sudah
  cepat; perbaikan Tahap 5 mengurangi VOLUME request + mode gagal, bukan ms lokal).

### Dampak wilayah acak pada tes lama (bukan bug — tes menyesuaikan aturan baru)
- e2e §5: A bepergian dulu ke wilayah lowongan sebelum melamar (melamar
  mensyaratkan warga di wilayah itu). §9: cek Tiket dibuat relatif
  (sebelum−1) karena A mungkin sudah memakai 1 Tiket di §5.
- pg-concurrency §3: hal yang sama (bepergian ke wilayah lowongan).
- e2e §23b: 3 pendaftaran tambahan memakai IP berbeda via `X-Forwarded-For`
  karena jatah 20/IP/24 jam sudah habis dipakai 20 pendaftaran sebelumnya
  dalam suite (server `trust proxy`, seperti klien dari IP lain).

## 6. Stress test + lag live — temuan & rekomendasi (bukan perubahan kode)

Tes beban terpisah (detail mentah: `/tmp/loadtest/result-*.json`):
- **Lokal 20 VU / 60 detik:** 35.298 request, 588 req/detik, **0 error**.
  Endpoint game p95 ~16–23 ms (`/api/me` p50 3,1 ms, p95 20 ms;
  `market_list` p50 3,5 ms, p95 23,2 ms). Register p50 2,6 detik dan login
  p50 1,4 detik — itu bcrypt (CPU-bound, wajar).
- **Lokal 50 VU:** 37.685 request, 627 req/detik — hanya 20 VU dapat sesi
  karena limiter per-IP (daftar 20/hari/IP, login 30/menit/IP), bukan server.
- **Live 20 VU (read-only):** `/api/world` median **3,65 detik** (p95 4,6 dtk,
  maks 5,1 dtk); halaman utama p50 0,3 dtk, **p95 9,2 dtk + 1 timeout 15 dtk**.
  Beban cuma 9 req/detik, pemain asli cuma 9 orang → **lag BUKAN karena ramai**.
- **Penyebab paling mungkin:** cold start Vercel (Hobby) + koneksi Neon
  (free tier: compute bisa suspend saat idle, lalu bangun beberapa detik;
  pool aplikasi cuma maks 3 koneksi/instance).

**Endpoint pooled Neon — BELUM bisa dipastikan dari VM ini.** `DATABASE_URL`
  hanya tersimpan di env var Vercel; Vercel MCP di VM ini tidak terhubung dan
  tidak ada salinan URL di repo (sesuai desain — jangan pernah menyimpannya
  di repo). **Yang harus dicek Khalid (30 detik, tanpa ubah paket):**
  Vercel Dashboard → proyek parlementer → Settings → Environment Variables →
  buka `DATABASE_URL` → lihat hostname: mengandung `-pooler`
  (`ep-xxx-pooler.ap-southeast-1.aws.neon.tech`) = **sudah pooled**; tanpa
  `-pooler` = **direct**. Kalau masih direct, ganti ke endpoint pooled Neon
  (PgBouncer, **gratis**, password/database sama, tanpa ubah paket) — itu
  mengurangi churn koneksi dari banyak instance serverless. Saya TIDAK mengubah
  env var Vercel sendiri.
- Catatan jujur: pooled membantu churn koneksi, **bukan** bangunnya compute
  Neon yang suspend. Bila setelah pooled masih lag saat idle, barulah
  pertimbangkan yang berbayar (rekomendasi saja, bukan dilakukan):
  matikan scale-to-zero Neon / compute lebih besar, atau Vercel Pro (cold
  start lebih jarang). Opsional lain yang gratis: pastikan region fungsi
  Vercel dekat dengan Neon ap-southeast-1 (Singapura) — cek di
  Settings → Functions → Region.
- **Log bootstrap:** peringatan `[security] PERINGATAN: ADMIN_BOOTSTRAP_CODE
  tidak diset` kini hanya muncul sekali saat startup di luar production
  (di production "tidak diset" adalah kondisi aman yang diinginkan) — tidak
  lagi membanjiri log di hampir semua pemanggilan API. Kondisi amannya tetap:
  tidak ada jalan darurat membuat admin lewat registrasi tanpa kode.

## 7. Pengumuman Update #2 (ter-seed otomatis)

Judul: "UU Kini Berpengaruh, Menteri Punya Wewenang & Pakta Organisasi".
Isi: ringkasan §1–§3 di atas (UU berjenis, anggaran, wewenang menteri,
pemakzulan, pakta) + perbaikan wilayah acak, Invalid Date, dan lag.
Tampil di notifikasi + "RIWAYAT UPDATE" di Buku sebagai Update #2.

## 8. File yang diubah (13)

- `src/game.js` — `LAW_KINDS`, `BUDGET_KINDS`, biaya/durasi mobilisasi &
  hari libur, `PACT_KINDS`, pengali pakta/anggaran, `shiftSalary(taxRate)`.
- `src/db.js` — kolom country/laws Tahap 5, tabel `budgets`,
  `budget_votes`, `impeachments`, `impeachment_votes`, `org_pacts`;
  seed Update #2; hapus default region 1 + migrasi; parser int8;
  urutan tabel `org_pacts`.
- `src/util.js` — warning bootstrap hanya saat startup (non-production).
- `src/tick.js` — §4 UU (terapkan efek), §4b anggaran, §4c pemakzulan.
- `src/api-core.js` — pajak pasar dinamis + pakta dagang, upah ADMIN
  ×pengali, klaim +2 emas saat anggaran claim, biaya perjalanan dinamis,
  region awal acak, cache `/api/world` 30 dtk, perbaikan INSERT lowongan
  perusahaan (bug §4.2).
- `src/api-civic.js` — endpoint anggaran/mobilisasi/hari libur/pemakzulan/
  pakta + `GET /api/parliament` & `/api/country` & `/api/orgs` diperkaya
  efek/pakta; perbaikan INSERT pemakzulan + race pakta.
- `src/api-admin.js` — `GET /api/admin/status` (boolean bootstrap saja).
- `public/js/app.js` — panel aturan berlaku + form UU berjenis, panel
  wewenang menteri, panel pakta, pajak dinamis (pasar/lowongan/wilayah/buku),
  bonus perang, `toDate()` + format waktu tahan string, polling dilewati
  saat tab tersembunyi, status bootstrap di admin. (`public/css/style.css`
  tidak berubah di Tahap 5 — rombak visual menyusul sebagai commit terpisah.)
- `test/e2e.js` — §23 Tahap 5 + penyesuaian §2/§5/§9/§22i (wilayah acak,
  Update #2).
- `test/modal-dom.js` — §14 (parlemen, pakta, format waktu string).
- `test/pg-verify.mjs` — §8 (skema Tahap 5, Update #2, parser int8).
- `test/pg-concurrency.mjs` — §7 (pakta race), §8 (vote anggaran race),
  §9 (invariant; dulu §7), penyesuaian §3 (wilayah acak).
- `docs/TAHAP5.md` — dokumen ini.

## 9. Catatan jujur / yang masih butuh Khalid

- Grafik harga 14 hari + order book tetap kosong sampai pemain berdagang
  (dari Tahap 4 — bukan regresi).
- Deteksi wash-trade / price-band tetap heuristik + log saja, tanpa auto-ban.
- **Cek endpoint pooled Neon** (lihat §6) — butuh akses dashboard Vercel
  Khalid; saya tidak mengubah env var sendiri.
- Foto profil lama tetap tampil inisial sampai diunggah ulang (`avatar_sm`
  NULL) — bukan bug (dari Tahap 3).
- Perusahaan di live yang didirikan sebelum perbaikan §4.2 punya lowongan
  default yang terlihat penuh (`seats_taken=1`, `region_id=0`) — tidak ada
  migrasi data yang aman (lihat §4.2).
- Verifikasi live (browser task) masih perlu dijalankan setelah deploy ini,
  seperti tahap-tahap sebelumnya, sebelum Tahap 6 dimulai.
