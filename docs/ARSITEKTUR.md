# ARSITEKTUR.md — Parlementer

Dokumen ini mencatat keputusan arsitektur + aturan sumber-tunggal (single
source of truth) supaya agen berikutnya tidak mengulang asumsi yang salah.
Ditulis di Tahap 7 (v4.1.0, 28 Nov 2026). Perilaku game yang lengkap ada di
`README.md`; audit tahap overhaul ada di `AUDIT.md`.

## 1. Gambaran sistem

- **Stack:** Node.js 22 + Express. **Dua database:** SQLite (lokal/pengembangan
  + tes) dan Postgres (production, VPS). Satu adapter di `src/db.js` yang
  menormalkan perbedaan (placeholder `?` vs `$1`, `INSERT OR IGNORE` vs
  `ON CONFLICT DO NOTHING`, `strftime` vs `EXTRACT`).
- **Deploy LIVE:** VPS Ubuntu (parlementer.my.id) — Node + Postgres lokal,
  systemd service `parlementer`, nginx reverse proxy, HTTPS Let's Encrypt.
  Setiap push ke `master` ditarik otomatis oleh cron auto-pull di VPS
  (tiap 3 menit: `git pull --ff-only` → `npm install` bila `package.json`
  berubah → restart service). **Jangan sentuh VPS langsung dari VM agen —
  SSH keluar diblokir runtime; deploy lewat push.**
- **Vercel** (parlementer.vercel.app) hanya redirector 308 ke parlementer.my.id.
- **Polling, bukan real-time:** tidak ada websocket. Klien mem-poll
  `/api/me` + `/api/world` (interval 5 detik untuk chat). Tick harian
  berjalan per-request (lazy, saat ada yang membuka game) + interval
  10 menit di server — tanpa cron eksternal.
- **Satu dunia, satu akun = satu warga.** ID warga `PL-000001` dst.

## 2. Keputusan dunia (jangan diubah tanpa perintah pemilik)

- **100% pemain asli, tanpa bot.** Semua daftar mulai KOSONG (pasar 0
  penawaran, 0 partai, 0 artikel, 0 perang). Satu-satunya pengecualian:
  18 lowongan ADMIN di Pekerjaan sebagai modal awal, **dibayar bahan
  mentah, bukan uang**.
- **Tidak ada negara awal.** Dunia mulai terpecah: 17 wilayah independen.
  Negara didirikan pemain (Level 10 + 100 emas); pendiri BUKAN otomatis
  presiden (dipilih pemilu). **Parlemen dibuka 28 November 2026 20:00 WIB** (kunci
  `parliament_opens_at` di `db_meta`; konstanta di `game.js` hanya seed awal).
- **Kewarganegaraan mengikuti wilayah asal** (`citizens.home_region_id`),
  lokasi saat ini di `citizens.region_id`. Travel butuh waktu
  (2 menit + 1 menit per 100 km, maks 30 menit) dan diselesaikan secara
  lazy saat `loadCitizen` — tanpa cron/tick.
- **Mata uang ganda:** USD (ekonomi dalam game) + emas (mata uang keras).
  Tampilan rupiah (Rp, kurs 18.300/USD) hanya konversi tampilan — DB tetap
  menyimpan USD.
- **Toko resmi** (Premium + paket) dibayar via WhatsApp pemilik; admin
  memenuhi pembelian manual lewat panel grant. Admin TIDAK punya toko
  sendiri. Notifikasi membedakan **PEMBELIAN** dari **HADIAH**.
- **Energi:** pulih +2/menit (lazy dari waktu berlalu, jadi pemain offline
  ikut pulih). Batas = `energyCapFor(level, premium, convoy)`:
  `100 + 5×(level−1) + 20 Premium + 10 RS Lapangan`.
- **Klaim harian:** `DAILY_CLAIM` = +5 emas, +50 USD, +40 XP.
- **Referral:** pengundang +200 emas + 2 hari premium; pendaftar +100 emas
  + 1 hari premium; cair saat pendaftar mencapai Level 3; maks 5/hari.
- **Kredit skor:** mulai 100; laporan chat TERBUKTI benar oleh admin → −10;
  pulih +1/hari; batasan bertingkat 80/60/40/20; skor 0 = banned otomatis
  (bisa banding; unban mengembalikan skor ke 50).
- **Militer:** 3 unit (Infanteri / Drone Perang / Kendaraan Berat); batas
  pasukan 50 + 10×level; pengali kerusakan perang 1 + min(power,100)/200
  (maks ×1,5); perawatan harian di tick.
- **Partai (v5.6.0 + v5.7.2):** halaman detail `#/parties/<id>` menampilkan isi +
  daftar member dengan jabatan (publik — nama warga sudah tampil di chat /
  peringkat / daftar partai). Role: ketua (`leader`) | sekretaris
  (`secretary`) | anggota (`member`) | lamaran (`pending`). Hanya ketua
  yang bisa mengangkat/mencopot sekretaris; sekretaris membantu
  menyetujui/menolak lamaran sama seperti ketua. **v5.7.2 — ketua bisa
  mengeluarkan anggota (`POST /api/parties/:id/kick`, tombol "Keluarkan" di
  daftar member) dan membubarkan partai (`POST /api/parties/:id/dissolve`,
  tombol merah "Bubarkan Partai")** — keduanya server-enforced, ketua
  saja; ketua tidak bisa kick dirinya sendiri. **Kick:** anggota kehilangan
  `party_id`; kursi parlemen partai TIDAK berubah (party_seats adalah
  alokasi per partai, dihitung ulang tiap pemilu ditutup) — status anggota
  parlemen yang di-kick hilang otomatis karena `isMpCitizen()` mensyaratkan
  party_id yang punya kursi; pencalonan presiden yang sudah berjalan TIDAK
  dibatalkan (dinilai saat nominasi; suara yang sudah masuk tetap sah).
  **Dissolve (atomik):** baris partai + seluruh `party_members` (termasuk
  lamaran pending) + `party_seats` partai itu dihapus; semua mantan anggota
  jadi tidak berpartai dan diberi notifikasi; **kursi parlemen partai ikut
  hilang sampai pemilu parlemen berikutnya**. **Dissolve DITOLAK (400) bila
  partai punya kandidat di pemilu yang sedang berjalan (`status='open'`)**
  — suara yang sudah masuk tidak boleh hangus, dan tick penutup pemilu
  parlemen akan mengalokasikan kursi ke partai yang sudah tidak ada (FK
  `party_seats → parties`). "Serahkan kepemimpinan" BELUM ADA — susulan.
  Semua hak dicek di server (`partyCanManage` + cek `leader_id`), bukan
  cuma di client. Lamaran pending hanya terlihat oleh ketua/sekretaris
  partai itu. Kolom `party_members.role` tidak punya CHECK constraint,
  jadi role `secretary` tidak butuh migrasi skema.
- **Event dunia mingguan:** rotasi 6 minggu deterministik dari nomor hari
  dunia (`worldEventFor(day)`): Panen Raya, Festival Rakyat, Badai Besar,
  Wabah Melanda, Pasar Bergairah, Darurat Militer.
- **Versioning:** kecil +0.0.1, sedang +0.1, besar +1. Konstanta `VERSION`
  di `src/game.js`; dikirim lewat `/api/world` + `/api/me`; footer
  menampilkan "Parlementer vX.Y.Z". Setiap update (yang diumumkan pemilik)
  masuk Pemberitahuan + Buku Panduan sebagai riwayat bernomor.

## 3. Register sumber-tunggal (Tahap 7)

Semua angka yang dipakai lebih dari satu sistem **harus** berasal dari
satu tempat. Bila menemukan duplikasi, pindahkan ke sini:

| Angka | Sumber tunggal | Dipakai oleh |
|---|---|---|
| Durasi 1 hari | `DAY_MS` (`game.js`) | klaim, FX TTL, cooldown, pemilu, perang, holiday |
| Klaim harian | `DAILY_CLAIM` (`game.js`) | handler klaim, README |
| Pajak penghasilan | `getIncomeTaxRate(t, country)` (`api-civic.js`) | shift, pasar, region, country summary |
| Pajak impor | `getImportTaxRate(t, country)` (`api-civic.js`) | beli pasar global, kas negara |
| Batas energi | `energyCapFor(level, premium, convoy)` (`util.js`) | regen, dashboard, `/api/me` |
| Hari dunia | `getWorldDay(t?)` (`db.js`) | semua handler yang butuh event dunia |
| Jeda latihan | `trainCooldownMs(newLevel, eduLevel)` (`game.js`) | handler latih, `/api/me` |
| Jendela voting pemilu | `ELECTION_VOTE_MS` (`game.js`) | pemilu, tick |
| Usia warga minimum untuk memilih | `ELECTION_VOTE_MIN_AGE_MS` (`game.js`) | pemilu (aturan BERBEDA dari jendela voting — jangan digabung) |
| TTL penawaran valas | `FX_OFFER_TTL_MS` (`game.js`) | valas |
| Biaya pemberontakan | `REBEL_COST` / `REBEL_COST_CAPITAL` (`game.js`) | pemberontakan |
| Durasi perang | `WAR_DURATION_MS` (`game.js`) | perang |
| Cooldown chat | `CHAT_COOLDOWN_MS`, `CHAT_COUNT_WINDOW_MS`, `CHAT_COUNT_MIN_WORDS` (`game.js`) | chat, misi harian |
| Slot konvoi | `convoySlotsFor(citizen)` (`game.js`) | GET + POST `/api/convoy` |
| UU yang tersedia | `LAW_KINDS` (`game.js`) | usul UU, `lawEffectText`, tick |
| Harga pasar acuan | `COMMODITIES` + `checkPriceBand` (`game.js`) | pasar lokal/global, chart |
| Hadiah klik share link | `SHARE_GOLD_PER_CLICK` = 10, `SHARE_MAX_GOLD_PER_DAY` = 200, `SHARE_MAX_CLICKS_PER_DAY` = 20 (`game.js`) | klik `/s/:code`, GET `/api/share`, GET `/api/admin/share`, tes |
| Hadiah banner AdSense | `BANNER_REWARD_GOLD` = 15, `BANNER_DAILY_CAP` = 10/hari, `BANNER_VIEW_MS` = 10 detik, `ADSENSE_BANNER_SLOT` (env, `game.js`) | POST `/api/ads/banner/start` + `/reward`, halaman #/ads, tes e2e [37] + ads-dom |
| Upah perusahaan maks | TIDAK ADA batas tetap (v5.0.0) — gaji maksimal = USD yang sedang dipegang pemilik perusahaan; gaji dipotong dari pemilik saat shift; bila pemilik tak mampu bayar, shift gagal (`performShift`, `api-core.js`) | POST `/api/companies/:id/job`, PATCH `/api/jobs/:id`, POST `/api/jobs/shift`, UI edit upah + panel CARA KERJA |
| Shift maks per tekan | `SHIFT_MAX_PER_CALL` = 10 (`game.js`) | POST `/api/jobs/shift` (multi-shift) |
| Pesan error HEIC | `HEIC_ERROR_MESSAGE` (`util.js`) + `IMAGE_ERROR_HEIC` (`app.js`) — jaga selaras | endpoint foto profil/perusahaan, klien `isHeicFile` |

## 4. Duplikasi yang DITERIMA (jangan "diperbaiki" sembarangan)

- **Rumus batas energi di SQL tick harian** (`src/tick.js`, reset harian)
  masih menulis `100 + 5*(level-1) + 20 premium + 10 health` secara inline
  karena SQL tidak bisa memanggil helper JS `energyCapFor`. **Jaga agar
  keduanya sinkron** setiap kali rumus batas energi berubah. Jalur regen
  (`applyEnergyRegen`) sudah memakai `energyCapFor` — itu sumber tunggalnya
  di sisi JS.
- **Kolom `country.tax_production` / `tax_export`** hanya tampil di UI
  ("Pajak impor / ekspor") dan TIDAK punya jalur kode. Sengaja dibiarkan:
  menambahkan UU untuk keduanya tanpa perintah pemilik akan menciptakan
  janji palsu. Bila pemilik memintanya, buat UU + jalur pajaknya bersamaan.
- **Pajak penghasilan vs pajak impor:** dua fungsi terpisah karena sumber
  tarifnya berbeda (UU `tax` vs UU `tax_import`, masing-masing min 1 /
  maks 5, dengan fallback berbeda: tanpa negara pajak penghasilan 0%,
  pajak impor 2%).

## 5. Skema database

- `SCHEMA_VERSION` saat ini **27** (`src/db.js`). Migrasi berurutan
  (`migrateStageNColumns`) — jangan pernah menulis ulang `CREATE TABLE`
  tanpa jalur migrasi; data live harus ikut naik versi.
- **Pelajaran insiden 28 Nov 2026 (v4.6.0 crash-loop, server down 11:11–11:27 WIB):**
  indeks yang merujuk kolom hasil migrasi JANGAN dibuat di `schema()` —
  `schema()` jalan SEBELUM migrasi, jadi di DB lama indeksnya gagal
  (Postgres 42703) dan `initDb` crash sebelum server nyala. Buat indeks
  seperti itu di fungsi migrasi, SETELAH `ADD COLUMN` (pola
  `migrateShareColumns` v4.6.1).
- **Pelajaran insiden 28 Nov 2026 (share 500 di live, v4.6.1):** JANGAN
  pernah menulis `? IS NULL OR kolom = ?` dengan parameter yang bisa NULL
  di Postgres — Postgres 18 tidak bisa menentukan tipe `$2` (error 42P18)
  dan query gagal di SETIAP request; SQLite (tes e2e) dinamis sehingga
  tes lokal lolos. Pakai dua cabang query (dengan/tanpa filter) atau cast
  eksplisit. Regresi: `test/pg-verify.mjs` section [24] (GET /api/share di
  Postgres sungguhan, termasuk statistik total/day NULL).
- **Upah perusahaan v5.0.0 (28 Nov 2026):** TIDAK ADA batas tetap gaji —
  gaji maksimal = USD yang sedang dipegang pemilik perusahaan; gaji
  dipotong dari pemilik saat shift (fixed: gross; bagi hasil: nilai barang
  × harga acuan, unit dibatasi stok bahan); bila pemilik tak mampu bayar,
  shift gagal dan tx rollback (tidak ada pencetakan). Pemilik yang bekerja
  di perusahaannya sendiri tidak digaji (net nol) tapi tetap dapat bonus
  material. Rollback exploit (skema 23, `migrateWageRollback`, penanda
  `wage_rollback_2026_11_28`): warga dengan total_salary > $100.000
  (batas sah 2 hari ≈ $56rb) ditarik kelebihannya dari USD (sisa $100rb;
  clamp 0 bila sudah dibelanjakan); lowongan perusahaan di-clamp ke saldo
  pemilik SETELAH clawback; ADMIN tidak disentuh; emas tidak disentuh.
- **Dedup lowongan v5.0.1 (28 Nov 2026, laporan Vincent):** 9 lowongan
  "Kerja" identik kenzz (setelah di-clamp v5.0.0 ke $100.000) tampil sebagai
  kartu-kartu kembar — daftar pekerjaan me-render 1 kartu per baris tanpa
  pengelompokan. Perbaikan 3 lapis: (1) klien mengelompokkan lowongan
  identik (perusahaan + judul + gaji + jenis + wilayah + level + tier)
  jadi 1 kartu dengan kursi gabungan; (2) penjaga duplikat di POST
  `/api/companies/:id/job` dan PATCH `/api/jobs/:id` — lowongan identik
  yang masih terbuka → 400; (3) migrasi `migrateJobDedup` (skema 24,
  penanda `job_dedup_2026_11_28`, HARUS setelah `migrateWageRollback`
  karena gaji baru identik setelah di-clamp): per grup identik sisakan 1 —
  penyintas = yang sedang dipegang warga, lalu seats_taken tertinggi, lalu
  id terkecil; HANYA hapus baris seats_taken = 0 DAN tidak dipegang warga;
  lowongan ADMIN dikecualikan; 1 notifikasi per pemilik terdampak.
  Pelajaran: migrasi pembersih yang bergantung pada hasil migrasi lain
  harus diurutkan eksplisit di rantai initDb, dan baris yang "hidup"
  (dipegang pemain) tidak pernah dihapus — hanya baris kosong.
- **Share artikel ke chat v5.0.1 (28 Nov 2026, laporan Vincent):** tombol
  "Bagikan ke Obrolan" dulu hanya menampilkan toast dan tetap di halaman
  artikel — pemain harus membuka chat sendiri dan tidak menemukan pesannya
  (apalagi bila bagikannya gagal 400 karena cooldown 5 detik, yang
  umpan-baliknya hanya toast sesaat). Sekarang: setelah berhasil langsung
  `location.hash = '#/chat'` (pesan + pratinjau langsung terlihat);
  article_id yang tidak ketemu → 400 "Artikel tidak ditemukan." (dulu
  diam-diam jadi null — pesan tanpa pratinjau); validasi artikel dicek
  SEBELUM cooldown supaya error yang benar yang tampil.
- **Landing + OG + logo v5.1.0 (28 Nov 2026, perintah pemilik):** kartu
  preview link memakai gambar pemilik (og-image.jpg 1200×630, tanpa
  generate ulang) + meta OG/Twitter Card; landing dirombak ala Parlementum
  (hero, angka dunia live, kartu front live, siaran langsung, tiga pilar,
  penutup, footer + Discord) dengan label OPEN BETA; logo P MERAH sebagai
  favicon + logo landing/header + layar loading + kartu login.
  ATURAN KERAS — angka dan peristiwa landing HANYA dari data nyata:
  `/api/world` diperluas dengan field nyata dari DB (`regionsOwned`,
  `activeFronts`, `warsTotal`, `tx24h`, `front` = perang aktif paling
  sengit dengan skor + endsAt, `feed` = maks 6 peristiwa nyata terbaru
  dari perang/pemilu/transaksi/artikel, `lastTrade`); bila tidak ada
  front/kabar, tampilkan keadaan damai/kosong yang jujur — JANGAN karang
  angka atau peristiwa. Warna front: merah = penyerang, emas = bertahan.
  Pelajaran: `renderLandingWorld(w)` HARUS membaca seluruh field dari
  parameter `w` yang sama yang di-render ke DOM — field yang diambil
  dari `/api/world` lain (mis. front di-render dari `w.front` tapi
  persentase dari field lain) mudah tertinggal saat API berubah.
- **Tutorial awal + AdSense v5.2.0 (28 Nov 2026, perintah pemilik):**
  overlay 7 langkah untuk pemain baru (`citizens.tutorial_done`, skema 25,
  backfill warga lama = 1; `POST /api/tutorial/done` idempotent) — muncul
  otomatis HANYA di dashboard saat login pertama; tombol Lewati selalu ada;
  selesai/lewati menutup permanen (tersimpan di server); replay dari Buku
  Panduan/Pengaturan; overlay TIDAK memaksa 20 tugas Kronik, hanya
  mengarahkan ke sana. Pelajaran: jangan biarkan overlay menavigasi paksa
  (`location.hash` di langkah 1) saat pemain masuk lewat deep link —
  `maybeShowTutorial()` dijaga ke rute dashboard dan dipanggil ulang dari
  `route()`, jadi pemain yang sedang bekerja di halaman lain tidak dibajak.
  AdSense: script verifikasi `ca-pub-2013457230013617` di `<head>`
  (public/index.html) + `public/ads.txt` (satu baris, `google.com,
  pub-2013457230013617, DIRECT, f08c47fec0942fa0`) — dicek landing-glass-dom.
- **Banner iklan AdSense berhadiah v5.3.0 (28 Nov 2026, perintah pemilik):**
  opsi "Lihat Banner Iklan" di halaman #/ads, +15 emas per tampilan
  (setengah dari video), maks 10×/hari (= 150 emas/hari). Token flow
  meniru video (`POST /api/ads/banner/start` → `/reward`, token acak
  256-bit, 5 menit, satu kali pakai) dengan kolom `kind` di `ad_tokens` +
  `ad_rewards` (skema 26, default 'video') — token banner TIDAK bisa
  ditukar hadiah video dan sebaliknya (dicek `kind` di kedua handler;
  tanpa ini token banner yang mudah didapat bisa ditukar +30 video).
  Hadiah HANYA untuk MELIHAT: klien hanya minta token bila slot terisi
  iklan (`data-ad-status="filled"`) dan tombol klaim aktif setelah banner
  terlihat 10 detik (ditegakkan server dari waktu terbit token +
  `BANNER_VIEW_MS`); klik iklan tidak pernah dilacak/diberi hadiah
  (mitigasi kebijakan Google incentivized traffic). Slot unit iklan
  (`ADSENSE_BANNER_SLOT`, env) BELUM ADA saat rilis — JANGAN mengarang
  ID; tanpa slot, halaman menampilkan placeholder jujur dan `/start`
  menolak 503 (pola yang sama dengan video saat property ID kosong).
  Banner kosong (situs belum disetujui Google) = tidak ada token/hadiah;
  itu keadaan yang diharapkan, bukan bug.
- **Conversion tracking Google Ads v5.3.0 (28 Nov 2026, perintah pemilik):**
  Google tag (gtag.js, AW-18546219743) + event conversion "Tayangan
  halaman" (`send_to: AW-18546219743/_HfVCK6Mg8EdEN-1w4tF`) di `<head>`
  public/index.html, tepat setelah script AdSense (async, tidak menghambat
  render). Dua event game: `Pendaftaran` — cuplikan conversion PERSIS dari
  Google (`gtag('event', 'conversion', {'send_to':
  'AW-18546219743/qsZPCIw7.8AdEN-1w4tF', 'value': 1.0, 'currency': 'IDR'})`,
  action dibuat pemilik 28 Nov 14:36 WIB) yang di-fire tepat sekali saat
  registrasi via form berhasil (login biasa TIDAK memicu; BUKAN event
  'sign_up' polos) — dan `mulai_bermain` (tanpa `send_to`, action "Mulai
  Bermain" belum dibuat pemilik) yang di-fire sekali saat shift PERTAMA
  selesai — server menandai lewat kolom `citizens.first_shift_done`,
  skema 27, UPDATE bersyarat + cek changes supaya dua request paralel
  hanya satu yang mendapat `firstShift=true` di respons shift. Keduanya
  dipanggil lewat `firePendaftaranConversion()` / `fireConversionEvent()`
  yang meng-guard `window.gtag` (tidak crash bila pustaka Google
  diblokir). Pemilik masih harus membuat conversion action "Mulai Bermain"
  di aplikasi dengan nama event tersebut, lalu mengatur goal campaign ke
  Pendaftaran.
- **Kolom chat ala Parlementum v5.4.0 (28 Nov 2026, perintah pemilik):**
  chat bukan lagi halaman penuh 1 layar — isinya dibungkus `.chat-column`
  (maks 680px, di tengah, panel berbingkai, padding 16px 14px) mengikuti
  referensi Parlementum (screenshot + docs/parlamentum-ui-reference/):
  tab bergaris bawah (bukan pil) huruf Oswald kapital, nama pengirim emas,
  gelembung gelap + ikon laporkan/blokir di samping gelembung (bukan di
  dalam), tombol KIRIM emas. Perilaku TIDAK berubah: tab Global /
  Indonesia / Wilayah (room 'negara' sudah dihapus sejak redesain dunia —
  brief awal yang menyebut tab Negara sudah kedaluwarsa), avatar 48px,
  pratinjau artikel (kini + nama koran), cooldown kirim 5 detik, modal
  Laporkan Konten, polling 5 detik. Lencana pesan belum dibaca (angka
  nyata, bukan data palsu): tabel baru `chat_read` (citizen_id, room,
  last_read_at, PK rangkap, skema 28 — dibuat di `schema()` saja, tanpa
  migrasi CREATE terpisah karena CREATE kedua pada tabel yang sudah ada
  membuat pg-mem crash, batasan #3 di header test/pg-test.js) +
  `GET /api/chat/unread` (hitung pesan dengan created_at > last_read,
  tanpa pesan sendiri + tanpa pengirim yang diblokir, tampil maks "+99")
  + `POST /api/chat/read` (ruangan diizinkan: global/indonesia/wilayah
  sendiri, UPSERT). Mark-read dipicu saat muat awal ruangan (force —
  lolos throttle 10 detik), saat pesan baru tiba di bawah, saat pill
  "pesan baru" diklik, dan saat scroll manual ke bawah. Dua perbaikan
  serumpun: (a) kartu MILITER dashboard "0/undefined unit" — penyebabnya
  `/api/me` tidak mengirim `cap` (padahal `/api/military` mengirimnya);
  diperbaiki server-side dengan `cap: unitCapFor(level)` = 50+10×level
  di objek military `/api/me`; (b) bug DM tiket LIO #47 — `#dm-list`
  tidak pernah di-scroll; kini `scrollTop = scrollHeight` setelah render
  awal dan setelah kirim (render ulang lewat route()). Dicek chat-dom
  [I]–[L] (kolom, lencana, auto-scroll DM via mock prototype scrollHeight/
  scrollTop jsdom, cap militer), e2e (`/api/me` cap), pg-verify [29]
  (tabel chat_read + UPSERT + FK + idempotensi).
- **Lupa Password v5.5.0 (28 Nov 2026, desain disetujui pemilik):** game
  BELUM punya layanan email — alur sepenuhnya in-app, TANPA kirim email.
  Link "Lupa Password?" di layar login → pemain memasukkan email akun
  (+ catatan opsional) → `POST /api/auth/forgot-password` mencatat
  permintaan (rate limit 10/IP/jam; pesan generik yang SAMA untuk email
  terdaftar maupun tidak, supaya tidak bocor; satu permintaan aktif per
  akun). Permintaan muncul di kotak masuk admin (tiket kind
  `password_reset`, id `pr-<n>`) + `GET /api/admin/password-resets`;
  admin ACC/TOLAK lewat `POST /api/admin/password-resets/:id/decide`
  (hanya pending + belum kedaluwarsa; keputusan dicatat di admin_actions
  `password_reset_accept`/`password_reset_reject` + notifikasi ke pemain).
  Kalau ACC, pemain mengecek di halaman login
  (`GET /api/auth/forgot-password/status?email=` → `{approved}`) dan
  tombol sekali pakai "Masuk & Buat Password Baru" muncul; tombol itu
  memanggil `POST /api/auth/reset-login` yang mengonsumsi permintaan
  secara atomik (conditional UPDATE status → 'used'; pemakaian kedua
  ditolak 400) lalu memberi sesi + `mustChangePassword: true`, dan pemain
  mendarat di halaman `#/reset-password` untuk mengatur password baru
  (`POST /api/auth/reset-password`: min 6 / maks 72 byte, konfirmasi
  harus cocok; `token_version` dinaikkan + cookie diterbitkan ulang agar
  sesi lain mati, sesi ini tetap hidup). Keamanan: tabel
  `password_resets` (id, user_id FK users, token_hash SHA-256 dari 32
  byte acak — nilai mentah TIDAK PERNAH keluar server, status CHECK
  pending/approved/rejected/used, created_at, expires_at, decided_at,
  decided_by, used_at; indeks `idx_password_resets_user`; skema 29,
  migrasi `migratePasswordResetColumns` menambah kolom
  `users.pw_reset_required` — diset 1 saat reset-login, dibersihkan saat
  reset-password; klien memaksa akun ber-flag itu ke `#/reset-password`,
  bahkan saat banned) — pending kedaluwarsa 7 hari, setelah ACC jendela
  login sekali pakai 3 hari (expires_at ditulis ulang saat ACC);
  kedaluwarsa dihitung di query (tanpa sweep). Risiko sisa: admin adalah
  satu-satunya gerbang identitas — siapa pun yang tahu sebuah email bisa
  memicu permintaan; admin HARUS memverifikasi peminta adalah pemilik
  akun (cocokkan nama warga + catatan, atau konfirmasi via WhatsApp/
  Discord) sebelum mengetuk ACC. Dicek e2e [38] (37 check: alur penuh,
  tolak, sekali pakai, kedaluwarsa, audit log), pg-verify [30]
  (migrasi 28→29, konsumsi atomik, FK, CHECK, idempotensi),
  password-reset-dom 23/23 (UI login: link, form, pesan generik,
  cek status, tombol sekali pakai, halaman reset, validasi).
- **Perang antar-negara, pendudukan & pemberontakan, nama negara oleh
  parlemen, pemilu parlemen lewat petisi + vote partai v5.7.0 (28 Nov
  2026, perintah mendesak pemilik):** skema 29→30, migrasi
  `migrateV570Columns` (idempotent, pola ADD COLUMN IF NOT EXISTS /
  PRAGMA seperti migrasi sebelumnya). **Parlemen dibuka 28 Nov 2026
  20:00 WIB** — konstanta `PARLIAMENT_OPENS_AT_DEFAULT` =
  `Date.parse('2026-11-28T20:00:00+07:00')` (epoch 1795870800); migrasi
  meng-update `db_meta.parliament_opens_at` dari nilai lama 2 Des 2026
  ke nilai baru (hanya bila masih bernilai lama). **Perang antar-negara**
  (`wars.kind`: 'rebellion' | 'country_war' | 'liberation', kolom baru
  `attacker_country_id` / `defender_country_id`): hanya bisa dideklarasikan
  Menteri Pertahanan (`POST /api/wars/declare`, role 'defense') atau lewat
  **mosi perang** parlemen (`POST /api/parliament/war-motion`, Level 5 +
  5 emas, satu mosi aktif per negara, voting anggota parlemen 3 hari,
  lolos bila YA ≥ 31 = `PARLIAMENT_MAJORITY`, lalu tick mendeklarasikan
  perang dengan validasi ulang target). **Aliansi** minimal antar-negara
  (`country_alliances`, pasangan terurut a < b + UNIQUE, status
  pending/active): presiden mengusulkan (`POST
  /api/countries/:id/ally`), presiden target menerima/menolak
  (`POST /api/alliances/:id/respond`), salah satu presiden bisa
  membubarkan (`POST /api/alliances/:id/dissolve`); negara sekutu TIDAK
  bisa diserang (`checkWarTarget` menolak 400). **Dijajah:** penyerang
  menang perang antar-negara → wilayah itu `occupied_by` = negara
  penyerang, `occupied_from` = negara asal, `country_id` TETAP negara
  asal; pajak pasar wilayah jajahan mengalir ke kas negara penjajah
  (`paySellerTax` cabang occupied). **Pemberontakan HANYA di wilayah
  jajahan** (`POST /api/regions/rebel` menolak wilayah merdeka /
  bernegara yang damai / sudah dikuasai pemberontak): menang → perang
  kind 'liberation', pembela = negara penjajah; pemberontak menang →
  okupasi dibersihkan, wilayah kembali ke negara asal. **Nama negara
  ditentukan parlemen:** `country.name` boleh NULL (migrasi DROP NOT
  NULL + reset semua nama lama ke NULL — tampilan memakai placeholder
  'Belum Dinamai'); pendirian negara tidak lagi menerima nama; **mosi
  nama** (`POST /api/parliament/name`, Level 5 + 5 emas, nama 3–40
  karakter unik, satu mosi aktif per negara, voting anggota parlemen 7
  hari, lolos bila YA ≥ 31) — bila nama sudah dipakai negara lain saat
  tick menutup, mosi gagal. Perhatian migrasi: `UPDATE country SET
  name = NULL` hanya jalan bila kolom sudah nullable — setelah ALTER
  DROP NOT NULL, flag-nya harus diset true (bug ini sempat lolos: nama
  lama tidak ter-reset di DB yang kolomnya masih NOT NULL; dicek
  pg-verify [31] dengan simulasi kolom NOT NULL). **Rumus damage baru**
  (`warDamage` di game.js): `(20 + 5×Kekuatan) × (1 + 0,15×(tier−1)) ×
  (1 + 0,02×(energi−10)) × (Drone? 1,5 : 1) × (wilayah asal? 1,15 : 1)`,
  dibulatkan — default (tier 1, energi 10, bukan wilayah asal)
  menghasilkan rumus lama persis. Endpoint serang
  (`POST /api/wars/:id/attack`) menerima `tier` 1–5 + `energy` 10–50
  (di luar itu 400), mengonsumsi amunisi tier itu persis + energi yang
  dipilih, bonus wilayah asal bila `home_region_id` = wilayah perang;
  respons menambah `breakdown` + `energyUsed` + `tierUsed`;
  `GET /api/wars/:id` menambah `myAmmo` / `myEnergy` / `homeBonus` /
  `energyMin` / `energyMax`. **Pemilu parlemen: petisi + vote partai**
  (Tugas 6): `election_petitions` (election_id, region_id, citizen_id,
  UNIQUE(election_id, citizen_id) — satu dukungan per warga per pemilu);
  `GET/POST /api/elections/:id/petition` — dukung butuh hak pilih yang
  sama dengan vote (Level 5 + 3 hari jadi warga); tick HANYA membuka
  pemilu parlemen bila `parliamentPetitionMet` — tiap wilayah negara
  itu punya ≥ 5 pendukung yang wilayah asalnya SAAT INI masih wilayah
  itu (dukungan dihitung ulang dari `home_region_id`, bukan dari
  region_id saat mendukung) — dan bila waktunya tiba tapi petisi belum
  lengkap, pemilu tetap 'scheduled'. Pemilu presiden TIDAK kena gate.
  **Vote partai:** `election_votes.party_id` (nullable) +
  `candidate_id` boleh NULL; di pemilu parlemen vote HARUS
  `party_id` (vote kandidat ditolak 400), partai didaftarkan dulu ke
  pemilu (`POST /api/elections/:id/register-party`, hanya ketua partai);
  pemilu presiden tetap vote kandidat. Alokasi kursi tick: agregasi suara
  per partai (`COALESCE(ev.party_id, ec.party_id)` — suara kandidat lama
  tetap dihitung lewat partainya), 60 kursi proporsional + koreksi
  pembulatan ke partai terbesar. **Keputusan yang dicatat:** wilayah
  dengan total warga < 5 TIDAK PERNAH bisa memenuhi petisi (bukan bug —
  konsekuensi aturan pemilik; negara satu wilayah kecil harus merekrut
  dulu). `countryDisplayName(c)` dipakai di semua notifikasi/tampilan
  supaya nama NULL tampil 'Belum Dinamai' — KECUALI `country_name` di
  feed wilayah/daftar (NULL dipertahankan = wilayah merdeka, yang dipakai
  frontend untuk kaca abu-abu/"?" — `CASE WHEN r.country_id IS NULL
  THEN NULL ELSE COALESCE(c.name, 'Belum Dinamai') END`). Dicek e2e
  [40] (perang/aliansi/pendudukan/pemberontakan/mosi nama/mosi
  perang/rumus damage) + [41] (petisi + vote partai + alokasi kursi +
  presiden tanpa gate), pg-verify [31] (migrasi 29→30, reset nama dari
  kolom NOT NULL lama, 6 tabel + 6 kolom baru, DEFAULT kind, UNIQUE
  aliansi/petisi, idempotensi).
- **Pemain baru "Clueless" v5.7.1 (28 Nov 2026, perintah pemilik):**
  pemain baru bingung "harus ngapain dulu" (pola hari itu: Firdan, wony,
  papa_emeritus, Diah, Mubeeanna, RudraSyailendra "Clueless" 17:05 WIB).
  **Checklist awal di ATAS dashboard** (`#dash-starter`): 3 langkah dari
  DATA NYATA — sudah kerja (punya pekerjaan / shifts > 0), sudah punya
  roti (`bread_today` > 0 atau Makanan di inventaris — dicek ulang saat
  inventaris termuat), sudah berpartai — + tombol 📖 CARA MAIN (→
  `#/book`) + baris "Parlemen dibuka malam ini 28 Nov jam 20.00 WIB";
  semua selesai → panel jadi ucapan selamat. **Kartu ajakan partai di
  chat:** `chat_messages.party_id` (nullable; `POST /api/chat/:room`
  menerima `party_id`, yang tidak dikenal ditolak 400 seperti
  `article_id` v5.0.1); `GET /api/chat/:room` mengembalikan
  `party_name` / `party_tag_shared` / `party_type` / `party_members`;
  pesan merender kartu 🚩 PARTAI (nama + tag + jenis + jumlah anggota)
  + tombol GABUNG PARTAI (`POST /api/parties/:id/join`, disembunyikan
  bila sudah jadi anggota partai itu); tombol 🔗 Bagikan ke Obrolan di
  halaman detail partai mem-post ke Global lalu pindah ke `#/chat`.
  **Penjelasan partai ≠ pindah wilayah** di halaman Partai + Peta
  (bepergian = kunjungan, 1 Tiket, ~2–30 menit, kewarganegaraan tetap;
  pindah kewarganegaraan gratis, cooldown 7 hari — aturan travel yang
  sudah ada, tidak ada aturan baru). **FAQ di atas Obrolan Global**
  (`<details open class="chat-faq">`, hanya room global): 3 jawaban
  berulang — cara main langkah pertama, beli roti di Pasar Global, cara
  kerja/shift (termasuk: shift ADMIN dibayar bahan, bukan Rupiah).
  **Total upah bahan:** `citizens.total_goods_usd` (skema 30→31,
  `migrateV571Columns` idempotent) — nilai setara Rupiah dari upah bahan
  (shift ADMIN + bagi hasil) yang TIDAK masuk `total_salary`; dicatat
  atomik di dalam tx shift; profil menampilkan "Total upah bahan
  ~RpX (setara)" + penjelasan bila > 0. **Hasil pengecekan anomali
  "3 shift, Total gaji Rp0": BUKAN bug** — cabang 'goods' di
  `performShift` memang hanya `addItem` bahan + tidak menyentuh
  `usd`/`total_salary` (aturan gaji TIDAK diubah); nilai lama tidak
  bisa di-backfill (tidak ada riwayat shift) — terakumulasi mulai
  v5.7.1. Dicek e2e [42] (shift ADMIN → total_salary 0 +
  total_goods_usd > 0 + tampil di profil; bagikan partai → kartu di
  chat; party_id palsu 400; gabung dari kartu), pg-verify [32] (migrasi
  30→31, 2 kolom baru, default 0, idempotensi), chat-dom [M]/[N]
  (checklist + CARA MAIN + baris parlemen; FAQ; kartu partai + tombol
  gabung; penjelasan Partai/Peta), profile-admin-dom (8) (shift ADMIN →
  profil tampil "Total upah bahan" + penjelasan).
- **Kick + dissolve partai v5.7.2 (28 Nov 2026):** pengumuman #27 sempat
  mengklaim ketua bisa mengeluarkan anggota / membubarkan partai padahal
  belum ada di kode — batch ini membuatnya benar (perintah pemilik
  16:19 WIB). `POST /api/parties/:id/kick` + `POST /api/parties/:id/dissolve`,
  ketua saja (server-enforced, 403 bila bukan ketua); tombol "Keluarkan"
  di daftar member + tombol merah "Bubarkan Partai" di halaman detail
  (ketua saja, pakai konfirmasi). **Kick:** anggota kehilangan `party_id`;
  kursi partai TIDAK berubah (alokasi per partai); status MP yang di-kick
  hilang otomatis lewat `isMpCitizen()`; pencalonan presiden yang sudah
  berjalan TIDAK dibatalkan (dinilai saat nominasi). **Dissolve (atomik):**
  partai + `party_members` + `party_seats` dihapus, semua mantan anggota
  jadi tidak berpartai + notifikasi; kursi parlemen partai hilang sampai
  pemilu berikutnya. **Dissolve DITOLAK bila partai punya kandidat di
  pemilu `status='open'`** (suara tidak boleh hangus; tick penutup pemilu
  parlemen akan mengalokasikan kursi ke partai yang sudah tidak ada —
  FK `party_seats → parties`). "Serahkan kepemimpinan" BELUM ADA.
  Dicek e2e [43] (hak akses kick/dissolve, kick diri/luar/pending 400/404,
  kursi tetap setelah kick, notifikasi, dissolve ditolak saat ada kandidat,
  dissolve: 404 + party_id null + seats/members 0 + notifikasi mantan
  anggota & pelamar) + party-dom (6) (tombol hanya untuk ketua, klik
  Keluarkan → member hilang, klik Bubarkan → kembali ke daftar partai).
- **Kronik yatim `level5` + `market` v5.7.3 (28 Nov 2026, laporan Vincent
  di Discord #bugs):** Vincent level 11 stuck Babak III 3/4 — "Capai
  Level 5" tidak pernah selesai. Akar: dua kunci Kronik TIDAK PUNYA situs
  penanda sama sekali. **`level5`:** ditandai di `addXp` (src/api-core.js)
  saat warga pertama kali melewati level 5 (`level lama < 5 && level baru
  >= 5` — `>=`, bukan `==`, karena satu addXp bisa melompati level) +
  migrasi backfill idempotent `migrateV576ChronicleLevel5` (skema 31→32,
  penanda `chronicle_level5_backfill_2026_11_28`, pola migrateWageRollback)
  yang menandai semua warga level >= 5 yang sudah ada — termasuk Vincent —
  supaya klaim Babak III (+25 emas) lewat tombol klaim normal, TANPA
  hadiah manual. **`market`:** `POST /api/chronicle/visit` kini menerima
  `'market'` juga (kunci tidak dikenal tetap 400); klien memanggil visit
  `{key:'market'}` saat merender `marketPage` (dipakai #/market lokal dan
  #/global) — cerminkan pola `'map'` di `ROUTES.map`. TIDAK ada backfill
  untuk `market` (pemain tinggal buka pasar sekali). **Audit penutup
  (28 Nov 2026, 20/20 kunci punya situs penanda — tidak ada lagi kunci
  yatim):** Babak I — claim api-core:577, job 1320, shift 1410 (hanya shift
  PENUH 100 energi), train 825, eat 865, map visit 998, market visit 998,
  country api-civic:441; Babak II — travel api-core:2532, buy 2105, sell
  2130/2265, chat5 api-civic:2043; Babak III — company 1783, fx 2348/2376,
  level5 api-core:56, party api-civic:847/869; Babak IV — law 1081, vote
  1104/1372/1383; Babak V — attack 1569, article 1749. Dicek e2e [44]
  (baseline false; visit tidak dikenal 400; visit market → done; XP 990 +
  20 latihan melompati level 1→5 → level5 done; klaim Babak III ditolak
  sebelum lengkap; level5 tepat 1×; company/fx/party lewat endpoint asli;
  klaim Babak III +25 emas, 2× ditolak) + pg-verify [33] (migrasi 31→32:
  lv11+lv5 di-backfill, lv4+lv1 tidak, lv7 yang sudah ditandai tidak
  didobel, penanda + ringkasan JSON, idempotensi).
- **Kunci brute-force login v5.7.4 (28 Nov 2026, Lane 14 — Keamanan &
  Anti-Cheat; audit celah):** `POST /api/auth/login` sebelumnya HANYA
  dilindungi batas in-memory 30/menit/IP di `src/app.js` — di serverless
  (Vercel) batas itu per instance, jadi penyerang yang menyebar request
  ke banyak instance + memutar IP bisa menebak password satu akun tanpa
  batas. Kini: 10 kegagalan login / 15 menit PER AKUN (email, lowercase)
  → 429 "Terlalu banyak percobaan login yang gagal. Coba lagi dalam
  15 menit." — dicek SEBELUM verifikasi password, jadi password benar pun
  ditolak selama jendela kunci berjalan; login sukses mereset hitungan.
  Hitungan memakai tabel `rate_limits` yang sudah ada (DB-backed, tanpa
  migrasi skema) lewat helper baru `getRateLimitCount` (peek tanpa
  menambah) + `resetRateLimit` di `src/rate-limit.js`; `checkRateLimit`
  yang sudah ada dipakai untuk menambah hitungan gagal (fail-open bila DB
  error, hasil tetap 400). Email tak dikenal TIDAK dihitung (tidak ada akun
  yang dilindungi; tidak mengisi tabel dengan kunci sampah). Ambang 10/15
  menit mengikuti OWASP Authentication Cheat Sheet ("count failures
  against the account, not the source IP") + NCSC 5–10 percobaan;
  langit-langit NIST SP 800-63B-4 adalah 100. Batas in-memory per IP tetap
  jadi lapis kedua (anti-spraying: satu password ke banyak akun).
  Trade-off yang diterima: akun banned yang terkunci ikut tertunda 15 menit
  sebelum bisa mengajukan banding (banding tidak hilang, hanya tertunda);
  pemulihan normal lewat alur Lupa Password (v5.5.0). Dicek e2e [45]
  (10×400 → ke-11 429; password benar saat terkunci 429; akun lain tetap
  login; 3 gagal → sukses → 9 gagal tetap 400 → ke-11 429).
- **Stok perusahaan + share link (v4.6.0):** `company_stock` (satu baris
  per perusahaan+komoditas, UNIQUE) — produksi harian (tick) + bonus shift
  mengambil bahan dari sini, BUKAN dari inventaris pemilik;
  `share_clicks` (UNIQUE owner+IP+hari) — jejak klik link share, satu
  sumber kebenaran untuk statistik pemilik + admin; `citizens.share_code`
  (unik, NULL sampai warga membuka halaman Bagikan Link).
- **Misi harian + Kronik (Tahap 7): relasional, bukan JSON.**
  `mission_progress` (citizen_id, key, value), `mission_claims`
  (citizen_id, key), `chronicle_done` (citizen_id, ckey),
  `chronicle_claims` (citizen_id, chapter). Masing-masing punya UNIQUE
  (citizen+key/chapter) — klaim ganda ditolak oleh constraint, bukan oleh
  logika aplikasi. Alasan: kolom JSON TEXT lama (`citizens.missions`,
  `chronicle_done`, `chronicle_claimed`) di-read-modify-write tanpa kunci,
  jadi aksi paralel bisa menghilangkan progres (BUG-16). Migrasi v15→v16
  mem-backfill kunci yang masih dipakai (`chat`, `last_chat_counted`,
  `claimed[]`, array kronik) dan membuang kunci mati (`energy`, `bread`
  — progresnya sudah hidup di kolom warga `energy_spent_today` /
  `bread_today`). Misi harian direset tiap hari di tick
  (`DELETE FROM mission_progress/claims`); Kronik permanen (tidak direset).
- **Helper relasional** di `src/db.js`: `missionValue`, `setMissionValue`,
  `missionClaimedKeys`, `insertMissionClaim`, `chronicleDoneKeys`,
  `chronicleClaimedChapters`, `insertChronicleClaim`, `markChronicleDone`
  (mengunci baris warga `FOR UPDATE` dulu, lalu INSERT dalam satu tx).
- **Aturan umum:** setiap klaim/pembayaran/transfer uang-emas-barang
  HARUS atomik (transaksi + `FOR UPDATE` pada baris warga yang berubah).
  Emas pasar hanya berpindah saat barang benar-benar terjual/terbeli
  (bukan di muka). Valas memakai escrow yang berbeda — jangan samakan
  dengan pasar.

## 6. Aturan lintas-sistem (hasil integrasi Tahap 7)

- **Event dunia ↔ pajak:** pajak penghasilan shift DAN pajak pasar sama-sama
  membaca `getIncomeTaxRate(t, country)` dengan hari dunia yang sama —
  minggu Pasar Bergairah (−1 poin) berlaku di keduanya. Jangan ada lagi
  jalur pajak yang memanggil tanpa hari dunia.
- **Pajak impor ↔ negara pembeli:** tarif impor yang dibayar pembeli
  mengikuti negara PEMBELI (bukan penjual), dan bisa diubah parlemen lewat
  UU kind `tax_import` (1–5%). Tanpa negara: 2%.
- **Pendidikan ↔ latihan:** Pendidikan kini berefek nyata — jeda latihan
  −5% per level Pendidikan, maks −50% (`trainCooldownMs`). Deskripsi
  atribut di dashboard harus sesuai efek sebenarnya (Pendidikan =
  "Latihan lebih cepat", Ekonomi = "Gaji shift lebih besar +3%/level").
- **Teks UI harus jujur (aturan BUG-7):** jangan ada teks yang menjanjikan
  fitur yang tidak ada kodenya. Yang diperbaiki di Tahap 7: tagline Deluxe
  ("peti perang" tidak ada), PREMIUM_PERKS (batas energi + slot konvoi
  yang salah), deskripsi Pendidikan/Ekonomi. Bila menambah teks promosi,
  periksa dulu apakah barangnya ada.
- **Statistik ↔ sistem:** angka yang ditampilkan di UI (pajak, batas
  energi, slot konvoi, klaim, TTL) harus dibaca dari sumber tunggal di
  §3 — jangan hardcode angka yang sama di tempat lain.

## 7. Sisa yang diketahui (untuk keputusan pemilik)

- **Verifikasi email belum diimplementasikan** — butuh keputusan layanan
  (Resend vs Gmail SMTP) + akun/API key; JANGAN membuat akun atas nama
  pemilik tanpa persetujuan.
- **Real-time (websocket) tidak mungkin** di arsitektur polling saat ini
  (polling 5 detik adalah batasnya); pindah ke server persistent bila
  real-time sejati wajib.
- **Di atas ~50 pemain bersamaan** butuh paket berbayar (VPS lebih besar /
  Postgres terkelola) — lihat hasil stress test Tahap 8 di bawah.

## 8. Tahap 8 — Stress test + QA (v4.2.0, 28 Nov 2026, tahap TERAKHIR overhaul)

- **`ensureElections` race — SELESAI.** INSERT atomik (`INSERT ...
  SELECT ... WHERE NOT EXISTS`) + indeks unik parsial
  `idx_elections_one_active` (satu pemilu aktif per negara+tipe).
  Migrasi v17 membersihkan duplikat lama (simpan id terkecil). Probe
  `test/race-ensure-elections.mjs` (12× paralel, SQLite + Postgres):
  tanpa duplikat.
- **Views artikel — SELESAI.** Dihitung 1× per warga per artikel per hari
  (tabel `article_views`, PRIMARY KEY rangkap); refresh tidak lagi
  menggembungkan skor Liga Pers. Hitungan lama tidak direkonstruksi.
- **Stress test lokal** (`npm run test:load`, hasil mentah
  `docs/loadtest-2026-11-28.json`): 20 VU → 196 req/dtk, p95 3–4 ms;
  **50 VU → 490 req/dtk, p95 6–7 ms, 0 error** (29.411 request);
  transaksi pasar 1/dtk 60/60 lolos (p95 10–11 ms); cold start 530 ms;
  register 129–320 ms, login 128–209 ms. Titik jenuh TIDAK tercapai di
  50 VU — server lokal masih longgar. Catatan: ini localhost SQLite di
  VM 1,5 CPU; latensi live didominasi jaringan + HP pemain.
- **Recovery test** (`npm run test:recovery`, hasil mentah
  `docs/recovery-2026-11-28.json`): SIGKILL di tengah burst 40 request →
  restart di DB yang sama → snapshot IDENTIK (gold/USD/inventaris/
  penawaran/jumlah baris), tanpa saldo negatif; tick setelah restart
  maju tepat 1 hari; boot ke-3 (migrasi idempotent) tetap konsisten.
  13/13 lolos.
- **Skenario tick penuh** (e2e [22q]): pemilu + perang + UU + anggaran
  yang berakhir bersamaan ditutup konsisten dalam SATU tick (pemenang
  benar, wilayah pindah ke pemberontak, efek UU diterapkan, kas
  berkurang tepat). **Alur pemain baru** end-to-end (daftar → klaim →
  lamar ADMIN → shift → jual → beli → chat) lolos tanpa hambatan.
