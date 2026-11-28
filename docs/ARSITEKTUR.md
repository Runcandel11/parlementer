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
  presiden (dipilih pemilu). **Parlemen dibuka 2 Desember 2026** (kunci
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

- `SCHEMA_VERSION` saat ini **23** (`src/db.js`). Migrasi berurutan
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
