# AUDIT PARLEMENTER — Tahap 1 (Master Overhaul)

**Tanggal audit:** 27 November 2026 (siang WIB)
**Repo:** `~/workspace/parlementer-deploy/` — GitHub `Runcandel11/parlementer`, branch `master`
**Commit yang diaudit (baseline):** `99a8cd5` — "Akun admin, referral kode unik, ID pemain PL-xxxxxx, lowongan ADMIN dibayar bahan mentah"
**Live:** https://parlementer.vercel.app (Vercel Hobby + Neon Postgres free tier, serverless, tanpa websocket)
**Sifat audit:** READ-ONLY terhadap kode. Tidak ada file `src/`, `public/`, `test/` yang diubah oleh audit ini; tidak ada commit/push.

> ⚠️ **PERINGATAN TENTANG STATUS WORKING TREE:** saat audit ini berjalan, agen paralel sedang mengerjakan fitur banding + foto profil + layar banned + loading screen **di working tree yang sama, belum di-commit**. Pada akhir audit, `git status` menunjukkan 10 file berubah (belum commit) + 1 file baru:
> `public/css/style.css`, `public/index.html`, `public/js/app.js`, `src/api-admin.js`, `src/api-civic.js`, `src/api-core.js`, `src/app.js`, `src/db.js`, `src/util.js` (modified); `src/api-appeals.js` (baru, untracked).
> Karena itu laporan ini membedakan dua hal:
> - **(BASELINE 99a8cd5)** — apa yang ada di commit yang diaudit;
> - **(WORKING TREE, belum commit)** — apa yang sudah dikerjakan agen paralel saat audit selesai. Temuan yang sudah diperbaiki di working tree ditandai ✅, tapi **belum terverifikasi di commit mana pun dan belum live** sampai di-commit + push (Vercel auto-deploy dari `master`).

**Status tes saat audit (dijalankan terhadap working tree, bukan commit murni):**

| Suite | Hasil | Catatan |
|---|---|---|
| `npm run test:pg` | **18/18 lolos** | pg-mem |
| `npm test` (e2e SQLite) | **122/123 lolos, 1 gagal** | Gagal: "Login akun banned ditolak + pesan alasan — status=200". Ini **perubahan perilaku yang disengaja** oleh agen paralel (login akun banned kini 200 + `banned:true` agar bisa banding), bukan regresi logika game. Ekspektasi tes e2e sudah kedaluwarsa dan harus diperbarui. |
| `npm run test:modal` | **10/10 lolos** | jsdom |
| `test:all` | **tidak selesai** (berhenti di e2e karena `&&`) | `test:modal` dijalankan terpisah: 10/10. |

---

## 1. Inventaris fitur yang SUDAH ADA dan berfungsi

Semua referensi di bawah adalah baseline `99a8cd5`, kecuali ditandai (WORKING TREE).

### 1.1 Auth & sesi
- Daftar email + password + nama warga; email unik, password bcrypt (`src/api-core.js:87-97`, hash `bcrypt.hash(password, 10)` di `:108`).
- Login email + password (`src/api-core.js:143-166`); sesi JWT 30 hari, cookie httpOnly + `SameSite=lax` + `secure` di production (`src/util.js:11-22`).
- Logout (`src/api-core.js`, `POST /api/auth/logout` — hapus cookie; **token tidak dicabut server-side**, lihat §4.7).
- Menu login tampil dulu sebelum game (`public/index.html`, `public/js/app.js:86-110` `boot()`).
- Validasi: email regex (`src/util.js:91-93`), username `^[A-Za-z0-9_]{3,24}$` (`src/util.js:95-97`), password minimal 6 karakter (`src/api-core.js:89`).

### 1.2 Dashboard / warga
- `GET /api/me` (`src/api-core.js:186-221`): level, XP, energi, emas, USD, wilayah, partai, pekerjaan, notifikasi belum dibaca, DM belum dibaca, hari dunia, populasi, perang aktif, UU sedang voting, referral.
- Latihan atribut Kekuatan/Pendidikan/Ekonomi, biaya = level+1 emas (`src/api-core.js:234-244`, `src/game.js:31`).
- Klaim pasokan harian +5 emas +50 USD +2 XP, sekali/hari (`src/api-core.js:223-231`).
- Makan roti T1–T5 → +10–50 energi, batas 10/hari (`src/api-core.js:246-258`, `src/game.js:34-35`).
- Misi harian 3 misi, masing-masing +10 emas (`src/game.js:44-48`, `src/api-core.js:269-300`).
- Kronik 5 babak, 20 tugas, total hadiah 115 emas (`src/game.js:51-107`, `src/api-core.js:302-332`).
- Pencapaian 19 tonggak, total 1.275 emas (`src/game.js:110-128`, `src/api-core.js:334-360`).
- Profil publik + bio (maks 1000 karakter) + ganti nama (`src/api-core.js:374-426`).
- Inventaris (`GET /api/inventory`, `src/api-core.js`).

### 1.3 Pasar lokal & global
- `GET /api/market?scope=local|global` (`src/api-core.js:580-610`): 15 komoditas, penawaran LIMIT 100, riwayat transaksi LIMIT 20, statistik.
- Jual: minimum 10 unit; beli: pajak penghasilan 2% untuk penjual (`src/api-core.js:613-668`, `src/game.js:5` `INCOME_TAX = 0.02`); global memakai emas + pajak impor 2% (`src/game.js:6`).
- Batalkan penawaran, stok kembali (`src/api-core.js:654-668`).
- Pasar mulai 0 penawaran — tanpa bot (seed hanya komoditas/wilayah/lowongan ADMIN).

### 1.4 Valas (FX)
- Cetak 1 emas = 10 USD (`src/api-core.js:690-700`, `src/game.js:4` `MINT_RATE = 10`).
- Penawaran antar warga, berlaku 72 jam, 1 penawaran terbuka per arah (`src/api-core.js:702-770`); ambil penawaran (`/api/fx/take`), batalkan (`/api/fx/cancel`); refund kedaluwarsa di tick (`src/tick.js:128-135`).

### 1.5 Pekerjaan & perusahaan
- 6 lowongan ADMIN, dibayar **bahan mentah** bukan uang (Besi ×44, Minyak ×40, Kayu ×44, Gandum ×38, Kapas ×21, Batu Bara ×39; nilai ~42–48 USD/shift; tanpa pajak; kena kelelahan) — `src/db.js` seed lowongan + `src/api-core.js:493-503`.
- Lowongan perusahaan pemain: gaji tetap / bagi hasil 80–98% dibayar barang (`src/api-core.js:505-527`).
- Shift butuh 100 energi; gaji dasar 4,80 USD/10 energi + bonus Ekonomi; kelelahan ×0,75 / ×0,5 (`src/game.js:15-29`).
- Perusahaan 4 jenis (100/100/250/500 emas), produksi harian masuk inventaris pemilik (`src/api-core.js:532-575`, `src/game.js:131-137`, tick `src/tick.js:56-73`).

### 1.6 Peta & wilayah
- 17 wilayah Indonesia, perjalanan 1 Tiket (`src/api-core.js:770-830`, `src/db.js` seed `REGIONS`).
- Pemberontakan: 50 emas (100 emas untuk ibu kota Jakarta); 5 pendukung menyulut perang 24 jam (`src/api-core.js:800-830`, `src/api-civic.js:225-250`).

### 1.7 Negara, partai, parlemen, pemilu
- Negara tunggal: Republik Indonesia; presiden + 4 menteri; kas negara; pajak (`src/db.js:339-356`, `src/api-civic.js:27-60`). Presiden bisa mengangkat menteri (`src/api-civic.js:50-60`).
- Partai: dirikan butuh Level 10 + 50 emas; gabung langsung / lamaran / tertutup (`src/api-civic.js:63-135`).
- Parlemen 60 kursi, mayoritas 31; usul UU Level 5 + 5 emas; voting 7 hari (`src/api-civic.js:137-175`).
- Pemilu presiden (hak pilih Level 5 + 3 hari jadi warga) & parlemen (kursi proporsional) (`src/api-civic.js:177-224`, `src/tick.js:76-104`); jadwal otomatis via `ensureElections` (`src/tick.js:8-22`).

### 1.8 Perang
- Front aktif, serang dari garis depan: harus di wilayah perang, 10 energi + 1 senjata; Drone ×1,5 kerusakan; kerusakan dasar 20 + 5×Kekuatan (`src/api-civic.js:250-280`, `src/game.js:37-42`).
- Papan skor per perang + log serangan (`src/api-civic.js:229-248`); penutupan perang di tick (`src/tick.js:114-126`).

### 1.9 Pers
- Dirikan koran 5 emas; tulis/baca/komentar artikel; reaksi like/dislike; hitungan views (`src/api-civic.js:283-395`).
- Liga Pers mingguan: skor = 3 × reaksi bersih + penonton unik (`src/api-civic.js:397-409`, `src/game.js` tidak ada — rumus inline di SQL).
- Artikel bisa dibagikan ke chat global sebagai pratinjau (`public/js/app.js:1305-1310`).

### 1.10 Chat, DM, organisasi, kontrak, konvoi
- Chat tab Global / Indonesia / Negara + Ruang Sidang + chat per front perang + chat partai (`src/api-civic.js:412-500`, `public/js/app.js:1330-1420`). Avatar + nama + tag partai + ikon premium + jam; pratinjau artikel; laporkan (4 alasan) & blokir (`src/api-civic.js:440-460`).
- Anti-spam chat: jeda 5 detik (`src/api-civic.js:482-483`).
- DM 1-lawan-1, daftar percakapan + belum dibaca (`src/api-civic.js:503-545`).
- Organisasi: dirikan 100 emas, gabung/keluar, 2 tipe (Keamanan / Kerja Sama) (`src/api-civic.js:549-592`).
- Kontrak: halaman riwayat transaksi pasar (`public/js/app.js:1192-1205` — **bukan sistem kontrak tersendiri**; hanya membaca `recentTx` dari `/api/market`).
- Konvoi: 4 jenis bangunan, 10 emas, berdiri 7 hari lalu roboh; slot dari level + premium (`src/api-core.js:833-861`, `src/game.js:151-156`). **Bonus bangunan tidak pernah diterapkan** (lihat §3 BUG-7).

### 1.11 Notifikasi
- `GET /api/notifications` LIMIT 50, tandai dibaca (`src/api-core.js:363-372`); lonceng di header; notifikasi untuk sistem/politik/perang/ekonomi/admin/referral (`src/api-civic.js`, `src/api-core.js`, `src/tick.js`).

### 1.12 Toko
- Harga rupiah, semua tombol → WhatsApp https://wa.me/6285220743283 (`src/game.js:139-150`, `src/api-core.js`, `public/js/app.js:1440-1470`). Premium 1/3/6/12 bln Rp5.000/15.000/25.000/45.000; Paket Pemula Rp15.000, Deluxe Rp50.000, Ultimate Rp100.000. Top-up manual (tidak ada pembayaran in-app).

### 1.13 Admin, referral, ID pemain
- Admin otomatis hanya untuk `koboijuniorkhalid@gmail.com` (`src/db.js:14`, `src/api-core.js:109`, migrasi `src/db.js:723`); tanpa endpoint promosi admin.
- Panel Admin: daftar pemain + cari (nama/email/ID `PL-xxxxxx`), ban (alasan wajib)/unban, beri premium 1/3/6/12 bln, emas, USD, barang T1–T5, isi energi; semua tercatat di `admin_actions` (`src/api-admin.js:52-202`).
- Login akun banned ditolak (baseline) — lihat perubahan working tree di §1.14.
- Referral: kode unik 8 karakter (tanpa 0/O/1/I/l); pemilik +100 emas + 2 hari premium; pendaftar +50 emas + 1 hari premium; kode tidak valid diabaikan (`src/api-core.js:100-140`, `src/db.js:17-32`).
- ID publik `PL-000001` dari id database (`src/util.js:58-60`), tampil di Profil + panel Admin.

### 1.14 Banding & foto profil — STATUS (WORKING TREE, belum commit)
- **Banding (backend) ADA di working tree, belum ter-commit dan belum live:** `src/api-appeals.js` (baru, 207 baris) — `POST /api/appeals` (hanya akun banned, 10–2000 karakter, 1 banding aktif per akun), `GET /api/appeals/mine`, `GET /api/appeals/:id`, `POST /api/appeals/:id/message` (thread dua arah, maks 1000 karakter), `GET /api/admin/appeals`, `POST /api/admin/appeals/:id/message`, `POST /api/admin/appeals/:id/decide` (accept → unban + log `admin_actions`; reject → boleh ajukan baru). Otorisasi: pemilik atau admin (`src/api-appeals.js:86-91, 122-128`). Tabel `appeals` + `appeal_messages` di `src/db.js` (working tree). **Sudah di-wire:** `registerAppeals(app)` di `src/app.js:13,45-65` (working tree).
- **Penjaga akun banned (middleware) ADA di working tree:** `src/app.js:45-65` — semua `/api/` diblokir 403 untuk akun banned **kecuali** `/auth/*`, `/api/me`, `/api/appeals*`, `/api/admin/appeals*`, `/api/world`. Login akun banned kini mengembalikan 200 + `banned:true` + sesi (agar bisa banding) — `src/api-core.js:155-166` (working tree). **Ini menutup celah kritis baseline** (lihat §4.2). Harga: 1 query DB tambahan (`SELECT is_banned`) di **setiap** request `/api/`.
- **Admin tidak bisa di-ban:** guard atomik `WHERE id = ? AND is_admin = 0` + `r.changes` check (`src/api-admin.js`, working tree) + migrasi mencabut ban akun admin (`src/db.js`, working tree).
- **Foto profil ADA di working tree:** `POST /api/profile/avatar` + `POST /api/profile/avatar/delete` (`src/api-core.js:407-440` working tree) — data URL JPEG/PNG/WebP valid, magic bytes dicek, maks 100 KB, hanya akun sendiri (`req.userId`, tanpa parameter target). Client resize/crop 256×256 via canvas (`public/js/app.js`, working tree, fungsi `processAvatarFile`). Avatar tampil di profil, chat, DM, daftar admin (kolom `users.avatar`, `src/db.js` working tree).
- **Layar loading ADA di working tree:** `#loading-screen` di `public/index.html` + `hideLoading()` di `public/js/app.js` (working tree) — menggantikan layar gelap ~15 detik saat cold start.
- **Layar banned full-screen ADA di working tree:** class `banned` di `#app` menyembunyikan HUD (`public/js/app.js` + `public/css/style.css`, working tree) + halaman banding `renderBannedPage()`.
- **Yang BELUM selesai dari tugas agen paralel saat audit berakhir:** belum di-commit/push (jadi belum live); tes e2e belum diperbarui untuk perilaku login-banned yang baru (1 gagal, lihat atas); belum ada tes untuk appeals/avatar.

---

## 2. Gap analysis vs 15 bagian master prompt

Skala: ✅ ada & berfungsi · ◐ sebagian / kosmetik / tidak diterapkan mekaniknya · ❌ belum ada sama sekali.

### 2.1 UI/UX — ◐
- Ada: SPA vanilla 1.603 baris (`public/js/app.js`), hash router, tema gelap navy+emas (`public/css/style.css` 226 baris), halaman login dulu, empty state, toast, modal laporan (sudah diperbaiki, tes 10/10).
- Sebagian: layar gelap ~15 detik saat cold start (loading screen baru di working tree, belum live); header mobile terpotong (perbaikan di tugas agen paralel, belum terverifikasi); tidak ada skeleton/loading state per halaman; tidak ada mode terang; tidak ada i18n (Indonesia saja — sesuai target); tidak ada aksesibilitas (aria minim); tidak ada PWA/offline.
- Belum: tutorial interaktif (hanya teks di Kronik + Buku Panduan), pengaturan tampilan, riwayat aktivitas pemain.

### 2.2 Marketplace / ekonomi — ◐
- Ada: pasar lokal (USD) + global (emas), 15 komoditas, pajak 2%, FX mint + penawaran antar warga, kontrak = riwayat transaksi.
- Sebagian: **tidak ada grafik harga / riwayat harga per komoditas** (hanya `best` + 20 transaksi terakhir); tidak ada order book depth; tidak ada harga referensi dinamis (harga sepenuhnya ditentukan penjual; `ref_usd`/`ref_gold` di `commodities` hanya dipakai untuk valuasi upah, bukan anchor pasar); tidak ada biaya listing; tidak ada pasar saham/obligasi; tidak ada lelang.
- Belum: sistem penawaran beli (buy order) di pasar barang — hanya FX yang punya penawaran dua arah; tidak ada pajak yang masuk kas negara (lihat §3 BUG-8); tidak ada bank/pinjaman/bunga; tidak ada asuransi; tidak ada perdagangan antar perusahaan (B2B).

### 2.3 Negara — ◐
- Ada: 1 negara (Republik Indonesia), 17 region, presiden + 4 menteri, kas negara (kolom ada), pajak (kolom ada).
- Sebagian: kas negara & tarif pajak **tidak pernah berubah** — kolom `treasury`, `tax_income`, `tax_production`, `tax_import`, `tax_export` (`src/db.js:345-350`) hanya ditulis saat seed; tidak ada pemasukan/pengeluaran negara.
- Belum: **multi-negara sama sekali** — hanya 1 negara; tidak ada pembuatan negara baru, tidak ada kedaulatan region, tidak ada ibu kota yang bisa pindah, tidak ada konstitusi/ideologi yang berpengaruh mekanik.

### 2.4 Pemerintahan / politik — ◐
- Ada: partai, parlemen 60 kursi, UU + voting 7 hari, pemilu presiden & parlemen, pengangkatan menteri.
- Sebagian: **UU yang disahkan tidak berpengaruh apa-apa** — status jadi `executed` (`src/tick.js:108`) tanpa efek mekanik; presiden tidak punya kekuasaan selain mengangkat menteri; menteri tidak punya wewenang (tidak ada aksi menteri); tidak ada pemakzulan / mosi tidak percaya; tidak ada kabinet/anggaran.
- Belum: sistem hukum/pengadilan, pajak yang bisa diubah presiden/parlemen (tarif hardcode di `src/game.js:5-6`), kebijakan publik yang mengubah angka game.

### 2.5 Diplomasi — ❌
- Belum ada sama sekali: tidak ada hubungan antar negara (hanya 1 negara), tidak ada traktat, aliansi formal, embargo, perjanjian dagang, utusan/duta, atau voting internasional. Yang ada dan mirip hanya **Organisasi** (aliansi antar warga/negara, `src/api-civic.js:549-592`) — itu aliansi pemain, bukan diplomasi antar negara.

### 2.6 Militer — ◐
- Ada: perang pemberontakan, serangan garis depan, Drone ×1,5, papan skor, wilayah bisa direbut (status perang berakhir → pemenang ditentukan, `src/tick.js:114-126`).
- Sebagian: tidak ada unit militer (infanteri/tank/dll. — hanya "Senjata" generik + Drone sebagai amunisi); tidak ada pertahanan wilayah (selain skor bertahan); tidak ada logistik/pasokan perang; tidak ada pangkat/komando; kerusakan hanya dari atribut Kekuatan; **wilayah yang "direbut" pemberontak tidak mengubah kepemilikan region** (tidak ada kolom pemilik region; perang berakhir begitu saja tanpa perubahan peta/kendali).
- Belum: angkatan bersenjata negara, anggaran militer, aliansi militer yang berpengaruh, mata-mata/sabotase.

### 2.7 Industri / produksi — ◐
- Ada: 4 jenis perusahaan, produksi harian otomatis ke inventaris (`src/tick.js:56-73`), 7 bahan mentah (`src/game.js:134`).
- Sebagian: **produksi muncul dari ketiadaan** — tidak ada konsumsi bahan baku/input; Pabrik (factory) menghasilkan "Bahan Bangunan" tanpa input; tidak ada rantai produksi (mentah → olahan → barang jadi) meski nama jenisnya menyiratkan itu; tidak ada kualitas/efisiensi; tidak ada karyawan yang memengaruhi output (lowongan perusahaan hanya sumber gaji, bukan tenaga produksi).
- Belum: riset/teknologi, otomasi, energi/listrik sebagai input, polusi, pabrik yang bisa diserang/direbut.

### 2.8 Sosial / populasi — ◐
- Ada: profil + bio, DM, chat, blokir, organisasi, referral, pencapaian, leaderboard tidak langsung (Liga Pers, papan perang).
- Sebagian: populasi hanya hitungan warga (`SELECT COUNT(*) FROM citizens`); tidak ada demografi (umur, pekerjaan populasi, migrasi); tidak ada kebahagiaan/kesehatan/pendidikan populasi; tidak ada keluarga/pernikahan; tidak ada sistem reputasi/karma.
- Belum: event sosial, pernikahan, media sosial dalam game selain pers, sistem mentor.

### 2.9 Berita / media — ◐
- Ada: koran, artikel, komentar, reaksi, views, Liga Pers, pratinjau artikel di chat.
- Sebagian: tidak ada berita sistem/otomatis (semua artikel dari pemain; saat 0 pemain aktif = 0 berita); tidak ada kurasi trending (hanya sort `top_day/week/month`); tidak ada sensor/moderasi artikel oleh admin (laporan chat ada, laporan artikel tidak); views bisa dinaikkan sendiri dengan refresh (lihat §3 BUG-5).
- Belum: kantor berita negara, langganan koran, iklan, radio/TV.

### 2.10 Notifikasi — ◐
- Ada: notifikasi in-app per kategori + lonceng + belum dibaca (`src/api-core.js:363-372`).
- Sebagian: **polling, bukan real-time** — `refreshMe()` tiap 30 detik (`public/js/app.js:213`) + tiap aksi; tidak ada push/email; tidak ada preferensi notifikasi (semua kategori selalu masuk); tidak ada pengelompokan.
- Belum: notifikasi real-time (tidak mungkin tanpa websocket di stack ini — lihat §7), digest harian, notifikasi untuk semua event penting (mis. perang dimulai di wilayahmu tidak ada notifikasi khusus).

### 2.11 Security / anti-cheat — ❌/◐ (lihat §4 — ini bagian terlemah)
- Ada: bcrypt, JWT httpOnly, rate limit auth 30/menit/IP, validasi server-side dasar, otorisasi admin, audit log admin, anti-spam chat 5 detik.
- Belum: verifikasi email, deteksi multi-account, deteksi bot/otomasi, proteksi race condition ekonomi, CSRF token, security headers, pencabutan sesi, moderasi laporan (laporan masuk tapi tidak ada yang bisa membacanya — lihat §3 BUG-4), audit log aksi gameplay.

### 2.12 Database / backend — ◐
- Ada: dual Postgres/SQLite, `?`→`$n`, transaksi `tx()`, migrasi idempotent + advisory lock, seed statis, pool max 3.
- Sebagian: hanya 4 index; banyak FK hilang; tanpa CHECK constraint; tanpa retensi data; `tx()` tanpa row locking.
- Belum: backup/restore, observabilitas (log terstruktur, metrik), migrasi berbasis versi (semua migrasi inline di `initDb`), read replica, cache.

### 2.13 Performance — ◐
- Ada: LIMIT di semua list, `since` untuk chat incremental, payload kecil per route (kecuali avatar — lihat §6).
- Sebagian: cold start ~15 detik; `/api/me` ~10 query berurutan tiap 30 detik per pemain aktif; chat polling 5 detik dengan 3 subquery per baris.
- Belum: caching, CDN untuk aset, kompresi respons, pagination berkursor, debouncing.

### 2.14 Testing — ◐
- Ada: e2e 123 cek, pg 18 cek, modal 10 cek; Postgres 16 sungguhan 16/16 untuk migrasi (laporan README, tidak ada di repo sebagai skrip — skripnya di `/tmp/verify-admin-migration.mjs`, **tidak tersimpan di repo**).
- Belum: tes untuk perang/pemilu/partai/pers/organisasi/konvoi/FX-accept (hanya happy path inti yang dites); **tanpa tes konkurensi sama sekali** (semua race condition di §4 lolos dari tes karena SQLite men-serialize tulis); tanpa tes beban; tanpa tes frontend selain modal; tanpa CI.

### 2.15 (Bagian ke-15 master prompt: integrasi & "dunia hidup") — ◐
- Ada: daily tick yang memajukan dunia (energi, produksi, pemilu, UU, perang, refund FX, konvoi kedaluwarsa).
- Sebagian: dunia hanya "hidup" bila ada request masuk (tick dipicu `maybeTick()` per request API, `src/app.js:40`); tanpa pemain = dunia beku; tidak ada event dunia acak, bencana, atau NPC; ekonomi sepenuhnya digerakkan pemain (benar sesuai aturan "tanpa bot", tapi berarti dunia kosong saat sepi).

---

## 3. Bug yang ditemukan

### BUG-1 [KRITIS] — Ban hanya ditegakkan di client pada baseline
- **Bukti:** baseline `99a8cd5` tidak punya middleware penjaga banned. `citizenRequired` (`src/util.js:80-85`) hanya memuat warga, tidak memeriksa `is_banned`. Frontend mengalihkan ke `#/banned` (`public/js/app.js:175-176,208-210`) — itu hanya JavaScript di browser.
- **Reproduksi (baseline):** login sebagai warga, admin ban warga itu, warga tetap bisa `POST /api/claim`, `/api/market/buy`, `/api/chat/global` dengan cookie sesi yang masih hidup (hanya login *baru* yang ditolak 403).
- **Status:** ✅ **diperbaiki di working tree** (middleware `src/app.js:45-65`, belum commit/live).

### BUG-2 [TINGGI] — Race condition ekonomi: oversell & saldo negatif (Postgres)
- **Bukti:** `POST /api/market/buy` (`src/api-core.js:613-637`) membaca penawaran + saldo pembeli/penjual lalu meng-update di dalam `tx()` **tanpa `SELECT ... FOR UPDATE` dan tanpa `WHERE qty >= ?`**. Dua pembelian bersamaan atas penawaran yang sama bisa sama-sama lolos cek `offer.qty < q`, lalu `qty` jadi negatif, pembeli sama-sama dapat barang, penjual dibayar dua kali.
- Pola check-then-update yang sama (tanpa guard atomik) ada di: klaim harian (`src/api-core.js:223-231` — cek `last_claim_date` dari `req.citizen` yang dimuat sebelum handler, lalu `UPDATE` tanpa `WHERE last_claim_date <> ?` → klaim ganda bersamaan), latih (`:234-244`), shift (`:480-527` — cek `energy < 100` lalu kurangi 100 → energi bisa negatif), lamar kerja/kursi (`:461-470` — cek `seats_taken >= seats` lalu `+1`, **tanpa transaksi sama sekali** → kursi bisa overbook + 3 update bisa gagal sebagian), klaim misi/kronik/pencapaian (`:269-360` — klaim pencapaian bersamaan: yang kedua menabrak `UNIQUE(citizen_id, akey)` → 500, lihat BUG-3), cetak FX (`:690-700`), anti-spam chat (`src/api-civic.js:482-491`).
- **Reproduksi:** dua request `POST /api/market/buy` paralel (mis. `Promise.all` dua fetch) untuk penawaran qty 10 dengan qty 10 masing-masing, di Postgres. Di SQLite tidak tereproduksi (tulis di-serialize) — itulah sebabnya tes e2e tidak menangkapnya.
- **Perbaikan:** `SELECT ... FOR UPDATE` di dalam `tx()`, atau `UPDATE ... WHERE qty >= ? AND changes = 1` (atomic claim, seperti pola yang sudah dipakai tick untuk `last_tick_date` di `src/tick.js:52`).

### BUG-3 [SEDANG] — Klaim pencapaian bersamaan → 500
- **Bukti:** `src/api-core.js:349-360` — cek `already`, lalu `INSERT INTO achievements` + `UPDATE citizens SET gold = gold + ?` tanpa transaksi. Dua klaim bersamaan: keduanya lolos cek, satu `INSERT` gagal `UNIQUE` → error handler 500. Emas tidak ganda (INSERT gagal dulu), tapi pengguna melihat error 500.
- **Perbaikan:** bungkus dalam `tx()` + `INSERT ... ON CONFLICT DO NOTHING` (atau tangkap error unique).

### BUG-4 [SEDANG] — Laporan konten masuk ke "lubang hitam": tidak ada yang bisa membacanya
- **Bukti:** `POST /api/chat/report` (`src/api-civic.js:440-448`) menulis ke `chat_reports` (status default `'open'`). Tidak ada route `GET` apa pun yang membaca `chat_reports` (grep: hanya INSERT). Panel Admin (`src/api-admin.js:52-202`) hanya menampilkan pemain + `admin_actions`. Tidak ada antrian moderasi.
- **Dampak:** tombol "Laporkan" memberi kesan moderasi, tapi tidak ada manusia/sistem yang menindaklanjuti.

### BUG-5 [SEDANG] — Views artikel bisa digelembungkan sendiri
- **Bukti:** `GET /api/press/articles/:id` (`src/api-civic.js:322`) melakukan `UPDATE articles SET views = views + 1` **di setiap pembukaan**, tanpa dedup per pembaca/waktu. Skor Liga Pers memakai views (`src/api-civic.js:399-403`).
- **Reproduksi:** buka artikel sendiri berulang kali (refresh) → views naik → skor liga naik → hadiah liga 500 emas koran + 250 emas jurnalis bisa dimanipulasi.

### BUG-6 [SEDANG] — Blokir ganda → 500
- **Bukti:** `POST /api/chat/block` (`src/api-civic.js:450-458`) melakukan `INSERT INTO blocked` tanpa `ON CONFLICT`. Tabel punya `UNIQUE(blocker_id, blocked_id)` (`src/db.js:482-486`). Blokir warga yang sama dua kali → error unique → 500.
- **Reproduksi:** klik "Blokir" dua kali pada warga yang sama.

### BUG-7 [SEDANG] — Bonus bangunan konvoi tidak pernah diterapkan (fitur kosmetik)
- **Bukti:** `CONVOY_BUILDINGS` (`src/game.js:151-156`) menjanjikan "+10% pemulihan energi harian", "Latihan 10% lebih murah", "+10% produksi perusahaan", "+10% kerusakan perang". Grep seluruh `src/`: `convoys` hanya dibaca di `GET /api/convoy`, dihapus saat kedaluwarsa di `src/tick.js:138`, dan tidak pernah dibaca di tick/shift/train/war. Pemain membayar 10 emas untuk bangunan tanpa efek.
- Sama untuk teks premium `PREMIUM_PERKS` (`src/game.js:150`): "Mode otomatis, lebih banyak roti, latihan lebih cepat" — **tidak ada yang diimplementasikan**. Yang benar-benar diterapkan premium: batas energi 120 (`src/api-core.js:254`), +1 slot konvoi (`:835`), nama berwarna di chat. Teks toko menyesatkan.

### BUG-8 [SEDANG] — Pajak 2% menguap; kas negara selamanya 0
- **Bukti:** `POST /api/market/buy` (`src/api-core.js:627`) — penjual terima 98%, 2% tidak dikirim ke mana pun. Kolom `country.treasury` (`src/db.js:345`) hanya ditulis saat seed (`src/db.js:768`); grep `treasury` di `src/` tidak menemukan pembacaan/penulisan lain. Presiden tidak punya uang negara untuk dibelanjakan; tarif pajak di `country` tidak dipakai (tarif hardcode `INCOME_TAX` di `src/game.js:5`).

### BUG-9 [SEDANG] — UU yang disahkan tidak berpengaruh
- **Bukti:** tick hanya mengubah status jadi `executed` (`src/tick.js:108`); tidak ada kode yang membaca isi UU atau mengubah angka game berdasarkan UU. Parlemen + voting UU adalah teater: biaya 5 emas untuk mengusulkan, tanpa dampak.

### BUG-10 [SEDANG] — Wilayah yang direbut pemberontak tidak berubah pemilik
- **Bukti:** penutupan perang (`src/tick.js:114-126`) hanya menulis `status='ended', winner=...` + notifikasi. Tidak ada kolom pemilik di `regions` (`src/db.js:248-261`); peta/kendali wilayah tidak berubah. "Perang wilayah" tidak memindahkan wilayah apa pun.

### BUG-11 [RENDAH] — Pesan warga yang diblokir bisa menghabiskan jatah LIMIT 100
- **Bukti:** `GET /api/chat/:room` (`src/api-civic.js:418-437`) mengambil `LIMIT 100` **lalu** memfilter `blockedSet` di JavaScript. Bila 100 pesan terakhir didominasi warga yang diblokir, pengguna melihat sedikit/kosong pesan padahal ada pesan lain yang lebih lama.
- **Perbaikan:** filter di SQL (`AND m.citizen_id NOT IN (...)`) atau ambil lebih banyak lalu potong.

### BUG-12 [RENDAH] — Judul chat perang menampilkan nama region dua kali
- **Bukti:** `public/js/app.js:1615` — `GARIS DEPAN: ${w.war.region_name.toUpperCase()} → ${w.war.region_name.toUpperCase()}` (region yang sama di kedua sisi; seharusnya penyerang → bertahan). Juga satu-satunya interpolasi data tanpa `esc()` yang ditemukan di frontend — datanya dari seed (risiko XSS rendah, tapi tetap inkonsisten).

### BUG-13 [RENDAH] — Pemenang pemilu seri ditentukan sembarangan
- **Bukti:** `src/tick.js:67` — `ORDER BY votes DESC LIMIT 1` tanpa tiebreak. Dua kandidat seri → pemenang tergantung urutan baca database (tidak deterministik).

### BUG-14 [RENDAH] — `ensureElections` bisa membuat pemilu ganda
- **Bukti:** `src/tick.js:8-22` — cek `SELECT` lalu `INSERT` tanpa lock/transaksi. Dua cold start Vercel bersamaan (atau dua request pertama setelah deploy) bisa sama-sama melihat "belum ada pemilu" dan sama-sama insert → dua pemilu presiden `scheduled` bersamaan. Ini race yang sama dengan yang diperbaiki untuk `initDb` di commit `64237d9` (advisory lock), tapi tidak diterapkan di sini. Dipanggil di `ensureReady()` (`src/app.js`) **dan** di akhir tick (`src/tick.js:104`).

### BUG-15 [RENDAH] — Tick harian bukan satu transaksi: crash di tengah tick = hari setengah jalan
- **Bukti:** `runDailyTick` (`src/tick.js:37-150`) menjalankan ~7 langkah sebagai statement terpisah tanpa `tx()` pembungkus. Klaim atomik `last_tick_date` (`:52`) mencegah tick ganda, tapi bila proses crash setelah langkah 1–2 (energi pulih + produksi), langkah 3–7 (pemilu/UU/perang/refund) terlewat hari itu sementara `last_tick_date` sudah maju — komentar di `:46-50` mengakui tick "terlewat", tapi tidak mengakui **sebagian langkah sudah terlanjur jalan**.
- **Perbaikan:** bungkus seluruh tick dalam satu `tx()` (Postgres) — atau terima sebagai risiko yang didokumentasikan.

### BUG-16 [RENDAH] — Serangan perang menulis `missions` dua kali dari data basi
- **Bukti:** `src/api-civic.js:276-278` — `UPDATE citizens SET missions = missions WHERE id = ?` (no-op, komentar "jaga konsistensi") lalu `UPDATE ... missions = ?` dengan JSON yang di-parse dari `c` yang dimuat **sebelum** `tx()` serangan. Nilai `energy_spent_today` yang dipakai juga dari `c` basi. Dua serangan bersamaan bisa saling menimpa progres misi harian.

### BUG-17 [RENDAH] — Jual di pasar tidak atomik: barang bisa hilang
- **Bukti:** `POST /api/market/sell` (`src/api-core.js:640-652`) — `takeItem()` (SELECT lalu UPDATE/DELETE, `src/api-core.js:56-62`, di luar transaksi) lalu `INSERT INTO market_offers`. Bila INSERT gagal (mis. DB error), barang sudah terambil dari inventaris dan tidak kembali. Pola yang sama di FX offer create (`src/api-core.js:711-712`: kurangi emas/USD lalu INSERT penawaran, tanpa `tx()`).

### BUG-18 [RENDAH] — Chat room bebas: siapa pun bisa membuat room tersembunyi
- **Bukti:** `POST /api/chat/:room` (`src/api-civic.js:461-494`) tidak memvalidasi `room` terhadap daftar yang dikenal. Hanya `parliament`/`war_*`/`party_*` yang dijaga; string lain apa pun diterima sebagai room dan tersimpan. `GET /api/chat/:room` juga tidak memvalidasi. Dampak kecil (room hanya terlihat bila tahu namanya), tapi ini kanal komunikasi tak termoderasi di luar tab yang dikenal.

---

## 4. Masalah keamanan

### 4.1 [KRITIS] Admin bisa direbut siapa saja: email admin publik + tanpa verifikasi email
- **Bukti:** `ADMIN_EMAIL = 'koboijuniorkhalid@gmail.com'` tertulis di `src/db.js:14` — repo GitHub `Runcandel11/parlementer` adalah **publik**, jadi alamat ini bisa dibaca siapa saja. Registrasi memberi `is_admin = 1` hanya dari pencocokan email (`src/api-core.js:109`: `email.toLowerCase() === ADMIN_EMAIL ? 1 : 0`), dan **tidak ada verifikasi email di mana pun** (tidak ada kode verifikasi, token, atau pengiriman email).
- **Dampak:** siapa pun yang mendaftar dengan email itu **sebelum Khalid mendaftar** langsung menjadi admin: bisa ban semua pemain, memberi diri sendiri emas/USD/premium tanpa batas (`MAX_GRANT = 1000000` per aksi, `src/api-admin.js:12` — dan bisa diulang tanpa batas), membaca daftar pemain + email semua warga.
- **Status saat audit:** Khalid **belum mendaftar** (warga #1 belum ada). Ini jendela serangan yang sedang terbuka.
- **Perbaikan segera (Tahap 2, sebelum apa pun):** (a) Khalid daftar **sekarang juga** dengan email itu; (b) setelah itu, cabut logika admin-berbasis-email — ganti dengan: verifikasi email (kode ke Gmail) + tandai admin hanya lewat perintah pemilik (mis. secret bootstrap satu kali via env var, lalu hapus); atau minimal tambahkan verifikasi kepemilikan email sebelum `is_admin` aktif. Jangan mengandalkan "email ini rahasia" — email ini sudah ada di repo publik dan di banyak tempat lain.

### 4.2 [KRITIS di baseline] Ban tidak ditegakkan server-side — ✅ diperbaiki di working tree
- Lihat BUG-1. Baseline: banned user dengan sesi hidup bisa memakai semua API game. Working tree menambahkan middleware (`src/app.js:45-65`) + login banned 200 dengan `banned:true`. **Tapi:** perbaikan ini belum commit/live, dan tes e2e belum diperbarui (1 gagal). Sampai push, situs live masih memakai baseline yang rentan.

### 4.3 [TINGGI] Tidak ada verifikasi email → multi-account & farming referral tanpa batas
- **Bukti:** registrasi hanya cek format + duplikasi (`src/api-core.js:87-97`). Tidak ada deteksi perangkat/IP/akun ganda; tidak ada CAPTCHA.
- **Dampak:** satu orang bisa membuat akun tak terbatas dengan email sekali pakai. Setiap akun baru dengan kode referral memberi pemilik kode **+100 emas + 2 hari premium tanpa batas** (README menyatakan "tanpa batas" sebagai fitur). Farming: buat 10 akun palsu → +1.000 emas + 20 hari premium untuk akun utama, tanpa biaya. Akun palsu juga bisa dipakai untuk: mengisi kursi pemilu, voting UU (butuh Level 5 — bisa dicapai), mendukung pemberontakan (5 akun = 1 perang), menaikkan views/likes artikel sendiri, dan wash trading di pasar (jual-beli antar akun sendiri untuk memanipulasi `recentTx`/harga).
- **Perbaikan:** verifikasi email (paling efektif), batas referral per hari/minggu, syarat level minimum sebelum bonus referral cair, deteksi pola (IP + fingerprint sederhana, tanpa menyimpan data sensitif berlebih).

### 4.4 [TINGGI] Race condition ekonomi (lihat BUG-2)
- Semua transaksi check-then-update tanpa row lock. Di Postgres (Neon live) ini nyata; di SQLite (tes) tidak terlihat. Selain oversell pasar, pola yang sama memungkinkan: klaim ganda, shift ganda (energi negatif), overbook kursi lowongan, spam chat melewati jeda 5 detik (dua POST bersamaan sama-sama membaca `last_chat_at` lama).
- **Perbaikan:** `SELECT ... FOR UPDATE` dalam `tx()` untuk semua baca-saldo/stok, atau `UPDATE ... WHERE <kondisi>` + cek `changes`.

### 4.5 [SEDANG] JWT 30 hari tanpa pencabutan; logout hanya hapus cookie
- **Bukti:** `signToken` (`src/util.js:11-13`) `expiresIn: '30d'`; tidak ada daftar token dicabut; `POST /api/auth/logout` hanya menghapus cookie. Token yang bocor (mis. dari log, XSS di masa depan, atau perangkat bersama) berlaku 30 hari penuh. Ban kini menghentikan pemakaian token (middleware working tree), tapi token akun yang tidak di-ban tetap berlaku setelah "logout".
- **Perbaikan:** persingkat masa berlaku (mis. 7 hari) + refresh token, atau simpan `token_version` per user yang dinaikkan saat logout/ganti password/ban.

### 4.6 [SEDANG] `JWT_SECRET` fallback ke secret dev yang diketahui publik
- **Bukti:** `src/util.js:5-8` — bila `JWT_SECRET` tidak disetel, pakai `'secret dev'` dan hanya `console.warn`. Bila env var di Vercel tidak sengaja terhapus/typo, **semua token bisa dipalsukan siapa saja** (secret-nya ada di repo publik).
- **Perbaikan:** gagalkan startup bila `NODE_ENV=production` dan `JWT_SECRET` kosong (fail-closed), jangan fallback.

### 4.7 [SEDANG] Rate limiting hampir tidak ada
- **Bukti:** satu-satunya rate limit adalah auth 30 req/menit/IP, in-memory `Map` per instance (`src/app.js:27-38`). Di serverless, tiap instance punya Map sendiri dan Map hilang saat cold start — limit efektifnya longgar dan tidak konsisten antar instance. Tidak ada limit untuk: chat (selain jeda 5 detik per akun — bisa diakali multi-akun), market buy/sell, admin grant, support ticket, registrasi, ganti avatar, laporan.
- **Perbaikan:** rate limit per akun + per IP di database (atau Upstash Redis free tier) untuk aksi sensitif; minimal untuk registrasi dan admin.

### 4.8 [SEDANG] Tidak ada CSRF token; perlindungan hanya SameSite=Lax
- **Bukti:** cookie `sameSite: 'lax'` (`src/util.js:17`). `SameSite=Lax` memblokir cookie pada POST lintas situs — itu perlindungan utama saat ini dan umumnya cukup untuk form POST. Tapi: tidak ada pengecekan `Origin`/`Referer`, dan ada fallback `Authorization: Bearer` (`src/util.js:28-31`) yang tidak terikat cookie. Risiko saat ini rendah (tidak ada endpoint GET yang mengubah state — verifikasi: semua aksi mutasi memakai POST; `GET /api/regions/travel`? Tidak — travel adalah POST. `GET /api/notifications/read`? Itu POST. OK), tapi tetap tidak ada pertahanan berlapis.
- **Perbaikan:** tambahkan token CSRF untuk aksi POST sensitif, atau minimal validasi header `Origin` untuk POST dari browser.

### 4.9 [SEDANG] Tidak ada security headers
- **Bukti:** hanya `app.disable('x-powered-by')` (`src/app.js:18`). Tidak ada `helmet`, `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security`. Tidak ada CORS yang dikonfigurasi (default Express: tidak ada header CORS — aman secara default karena same-origin, tapi tidak eksplisit).
- **Perbaikan:** pasang `helmet` (atau header manual) — murah dan tanpa dependensi berat.

### 4.10 [RENDAH] Error handler bisa membocorkan pesan internal
- **Bukti:** `src/app.js:96-100` — `res.status(err.status || 500).json({ error: err.message })`. Pesan error dari driver database (mis. detail constraint Postgres) bisa sampai ke client. Belum ditemukan kebocoran nyata, tapi tidak ada sanitasi.
- **Perbaikan:** untuk 500, kembalikan pesan generik; log detail di server saja.

### 4.11 [RENDAH] Password: minimal 6, tanpa maksimal; bcrypt truncate 72 byte
- **Bukti:** `src/api-core.js:89` hanya cek `length < 6`. `bcryptjs` diam-diam memotong password >72 byte — dua password berbeda yang 72 byte pertamanya sama akan dianggap sama. Risiko praktis kecil, tapi batas maksimal (mis. 128 karakter) + pesan yang jelas sebaiknya ada.
- **Perbaikan:** tolak password >72 byte (atau >128 karakter) dengan pesan eksplisit.

### 4.12 [RENDAH] Validasi kepemilikan aset — secara umum BAIK, dengan catatan
- Yang dicek benar: batal pasar hanya oleh penjual (`src/api-core.js:654-656` `seller_id = ?`), demolish konvoi hanya pemilik (`:859`), balas banding hanya pemilik/admin (`src/api-appeals.js:86-91`), hapus/ubah avatar hanya diri sendiri (tanpa parameter target), admin grant hanya admin (`adminOnly`, `src/api-admin.js:14-18`).
- Yang belum dicek: `POST /api/chat/:room` tidak memvalidasi room (BUG-18); `GET /api/profile/:username` mengembalikan `pass_hash: undefined` (`src/api-core.js:386` — `JSON.stringify` membuang `undefined`, jadi tidak bocor, tapi pola `...u` menyebarkan seluruh baris user dan rapuh: satu perubahan di masa depan bisa membocorkan hash).
- **Perbaikan:** jangan pernah `SELECT *` lalu spread baris user ke respons; pilih kolom eksplisit.

### 4.13 [RENDAH] SQL injection — TIDAK ditemukan; semua query berparameter
- Semua query memakai placeholder `?` + parameter (`src/db.js:96-115` `toPg()` menerjemahkan ke `$n`). Interpolasi `${...}` di string SQL hanya untuk nilai dari whitelist internal: kolom atribut latih (`src/api-core.js:238-239`, dari enum `['str','edu','eco']`), kolom menteri (`src/api-civic.js:56`, dari map 4 kunci), kolom vote UU (`:173`, dari enum yes/abstain/no), kolom skor perang (`:273`, dari enum attacker/defender), `ORDER BY` lowongan (`src/api-core.js:452`, dari enum sort) dan artikel (`src/api-civic.js:296-300`, dari enum sort). Tidak ada input pengguna mentah yang masuk ke SQL. **Tetap aman — tapi rapuh:** satu `ORDER BY ${req.query.sort}` di masa depan tanpa whitelist langsung menjadi SQL injection. Sebaiknya ada linter/test yang menegaskan pola ini.

### 4.14 [RENDAH] XSS — secara umum AMAN, satu titik tidak konsisten
- Frontend memakai `esc()` di hampir semua interpolasi data pengguna (nama, bio, judul artikel, isi chat, komentar). Satu titik tanpa `esc()`: judul chat perang (`public/js/app.js:1615`, data dari seed — risiko rendah). Avatar dirender sebagai `<img src="${esc(avatar)}">` (working tree) — data URL divalidasi server (magic bytes + ≤100 KB), jadi tidak bisa menyelundupkan `javascript:`.
- **Catatan:** tidak ada CSP (lihat §4.9) — bila satu titik XSS lolos di masa depan, tidak ada pertahanan kedua.

### 4.15 [RENDAH] Tidak ada audit log untuk aksi gameplay
- Hanya aksi admin yang dicatat (`admin_actions`, `src/api-admin.js:21-24`). Tidak ada log untuk: transaksi pasar besar, perang, pemilu, pemberian referral, perubahan negara. Bila terjadi sengketa ("emas saya hilang"), tidak ada jejak untuk ditelusuri selain `market_tx` (hanya jual-beli pasar).
- **Perbaikan:** tabel `audit_log` generik untuk aksi ekonomi/politik bernilai besar (tahap 2–3).

---

## 5. Masalah database

### 5.1 Index yang hilang (hanya 4 index di seluruh skema)
- **Bukti:** `src/db.js:552-555` — hanya `idx_market_offers(scope, commodity_id)`, `idx_chat_room(room, created_at)`, `idx_articles_created(created_at)`, `idx_notif_citizen(citizen_id, created_at)`.
- **Yang sering di-query tanpa index:** `market_offers.seller_id` (halaman "penawaranku", batal), `chat_messages.citizen_id` (riwayat per warga), `notifications.is_read` (hitung belum dibaca di setiap `/api/me`), `dms.from_id/to_id` (daftar percakapan), `inventory.citizen_id` (hampir semua aksi ekonomi), `fx_offers.citizen_id + expires_at` (tick + halaman FX), `war_attacks.war_id`, `articles.author_id/newspaper_id`, `market_tx.buyer_id/seller_id`, `elections.status`, `laws.status + ends_at`, `appeals.user_id + status` (working tree — `SELECT ... WHERE user_id = ? AND status = 'menunggu'` di setiap pengajuan banding).
- **Dampak saat ini:** kecil (populasi 1–2 warga). **Dampak saat tumbuh:** `/api/me` + chat + pasar akan melakukan full scan di tabel yang tumbuh tanpa batas (lihat §5.4). Neon free tier (0,25 GB RAM) akan terasa lebih dulu.
- **Perbaikan (Tahap 2):** tambahkan index untuk kolom di atas — murah, idempotent (`CREATE INDEX IF NOT EXISTS`), tanpa downtime.

### 5.2 Konsistensi: kolom duplikatif & tipe data
- `citizens.gold`/`usd` bertipe `REAL` (`src/db.js:205-206`) — saldo uang memakai floating point. `0.1 + 0.2`-style error sudah terlihat di tes (perbandingan memakai epsilon, `test/e2e.js:21` `eq(a,b)`). Pada skala besar, pembulatan sen bisa bergeser. **Perbaikan:** simpan uang sebagai integer sen (atau `NUMERIC(12,2)` di Postgres).
- `citizens` menyimpan JSON sebagai TEXT (`missions`, `chronicle_done`, `chronicle_claimed`, `src/db.js:230-232`) — tidak bisa di-query/di-index; setiap baca/tulis butuh parse/stringify di aplikasi (dan rawan race, lihat BUG-16).
- `users.avatar` TEXT tanpa batas di skema (batas 100 KB hanya di aplikasi, `src/api-core.js` working tree).
- Duplikasi yang disengaja tapi rapuh: `citizens.region_id` + `home_region_id` (OK), `wars.score_a/score_d` vs `war_attacks` (agregat bisa desync bila satu update gagal — keduanya ditulis dalam `tx()` yang sama di serangan, jadi relatif aman).
- Tidak ada kolom `updated_at` di tabel mana pun — sulit melacak perubahan terakhir.

### 5.3 Query N+1 & subquery per baris
- **Chat:** `GET /api/chat/:room` (`src/api-civic.js:421-430`) menjalankan **3 correlated subquery per baris pesan** (hitung komentar, judul artikel, likes artikel) — 100 pesan = 300 subquery tambahan, tiap 5 detik per pemain yang membuka chat.
- **`/api/me`:** ~10 query berurutan (`src/api-core.js:187-203`) — region, partai, pekerjaan, 2× hitung belum dibaca, world, populasi, perang aktif, UU voting, referral. Bisa digabung jadi 2–3 query (JOIN + agregat).
- **Banding:** `GET /api/appeals/mine` (`src/api-appeals.js:80-87`) memanggil `loadAppeal()` per banding (1 query banding + 1 query pesan + 1 query user per item).
- **Tick:** loop perusahaan (`src/tick.js:60-73`) — 3–4 query per perusahaan; loop perang → notifikasi per pejuang; loop FX kedaluwarsa → 2 query per penawaran. Aman di skala kecil, tapi tick berjalan di request pengguna (bukan background) — lihat §6.

### 5.4 Constraint yang kurang
- **Tidak ada `CHECK`:** `gold`/`usd`/`qty`/`energy` bisa negatif (tidak ada `CHECK (gold >= 0)`); `price` bisa 0/negatif? — dicek di aplikasi (`price > 0`, `src/api-core.js:643`) tapi tidak di DB. Bila satu race lolos (BUG-2), DB tidak menolak nilai mustahil.
- **FK hilang di banyak tabel:** `market_tx.buyer_id/seller_id` (tanpa REFERENCES), `admin_actions.admin_id/target_id`, `elections.winner_id`, `country.president_id` + 4 menteri, `jobs.company_id/region_id`, `fx_history` (tanpa FK sama sekali), `appeals.decided_by` (tanpa FK). SQLite: `PRAGMA foreign_keys = ON` (`src/db.js:84`) — tapi hanya untuk koneksi tunggal itu; Postgres: FK yang ada ditegakkan, yang tidak ada tidak.
- **UNIQUE yang ada sudah bagus:** `users.email/username`, `inventory(citizen, commodity, tier)`, `law_votes`, `election_votes`, `election_candidates`, `article_reactions`, `war_support`, `party_members`, `org_members`, `blocked`, `achievements`, `referral_code`. Ini yang menyelamatkan dari voting ganda & dukungan perang ganda — tapi tanpa `ON CONFLICT` handling, pelanggaran berubah jadi 500 (BUG-3, BUG-6).

### 5.5 Migrasi idempotent — BAGUS, dengan catatan
- `initDb` memakai satu transaksi + `pg_advisory_xact_lock` (`src/db.js:620-640`), migrasi `INTEGER`→`BIGINT` idempotent, `migrateUserColumns` + migrasi lowongan ADMIN idempotent, `cleanupOrphanTypes` untuk tipe komposit yatim. Terverifikasi di Postgres 16 sungguhan 16/16 (laporan README; skrip verifikasi di `/tmp`, **tidak ada di repo** — sebaiknya dipindah ke `test/` agar bisa diulang).
- **Catatan:** daftar `TABLE_NAMES` (`src/db.js:652`) harus dijaga manual — agen paralel sudah menambah `appeals`/`appeal_messages` ke sana (working tree). Bila tabel baru ditambah tanpa memperbarui daftar ini, cleanup tipe bisa salah sasaran.
- **Catatan 2:** `CREATE TABLE IF NOT EXISTS` + `GENERATED BY DEFAULT AS IDENTITY` gagal di pg-mem pada run kedua (terdokumentasi di `test/pg-test.js:20-24`) — idempotensi `initDb` 2× **tidak bisa dites di pg-mem**, hanya di Postgres sungguhan.

### 5.6 Pertumbuhan tanpa retensi
- Tidak ada penghapusan/pengarsipan untuk: `chat_messages`, `market_tx`, `fx_history`, `notifications`, `war_attacks`, `admin_actions`, `chat_reports`. Semua tumbuh tanpa batas; Neon free tier 10 GB akan habis oleh chat + notifikasi bila game ramai. Tidak ada pekerjaan pembersihan selain konvoi kedaluwarsa + refund FX.
- **Perbaikan:** retensi (mis. chat >90 hari diarsip/dihapus, notifikasi dibaca >30 hari dihapus) + `VACUUM`/monitoring ukuran tabel.

---

## 6. Masalah performance

### 6.1 Cold start serverless (~15 detik layar gelap)
- **Bukti:** `ensureReady()` (`src/app.js:74-90`) menjalankan `initDb()` + `ensureElections()` pada request pertama setiap cold start; `initDb` melakukan puluhan statement DDL + seed + migrasi ke Neon (Singapura) dari fungsi Vercel. Pengguna melihat layar gelap ~15 detik (dilaporkan 2026-11-27). Loading screen sudah ditambahkan di working tree (`public/index.html`, belum live) — itu menutupi gejala, bukan mempercepat cold start.
- **Perbaikan nyata:** kurangi kerja `initDb` saat sudah termigrasi (cek versi skema dulu, lewati migrasi bila sudah terkini); pertimbangkan `minInstances` (tidak ada di Hobby); terima cold start sebagai batas paket gratis dan komunikasikan lewat loading screen.

### 6.2 Polling (tanpa websocket — batas arsitektur)
- Chat: `setInterval(renderChatRoom, 5000)` (`public/js/app.js:1535`) — tiap 5 detik `GET /api/chat/:room` (LIMIT 100 + 3 subquery/baris). 20 pemain membuka chat = 240 request/menit hanya untuk chat, masing-masing memicu `maybeTick()` + (working tree) 1 query `is_banned` tambahan.
- Dashboard: `setInterval(refreshMe, 30000)` (`public/js/app.js:213`) — tiap 30 detik `GET /api/me` (~10 query). Plus `refreshMe()` di hampir setiap aksi pengguna.
- `maybeTick()` dipanggil di **setiap** request `/api/` (`src/app.js:40`) — tiap request membayar 1 `SELECT` world + (bila tanggal berubah) satu tick penuh. Di serverless, `ticking` flag (`src/tick.js:144-150`) hanya berlaku per instance — antar instance, perlindungannya hanya klaim atomik `last_tick_date`.
- **Perbaikan:** naikkan interval chat saat tab tidak aktif (`document.visibilitychange`), kirim `since` yang benar (sudah ada — bagus), gabungkan `/api/me` + notifikasi dalam satu request (sudah satu request, tapi 10 query di dalamnya), cache `world`/`regions` di memori dengan TTL pendek.

### 6.3 Payload avatar bisa membengkak
- **Bukti (working tree):** `GET /api/chat/:room` memilih `u.avatar` untuk setiap pesan (`src/api-civic.js` working tree). Avatar adalah data URL base64 ≤100 KB biner (~136 KB teks). 100 pesan × 136 KB = **~13 MB per poll chat** bila semua pengirim punya foto profil. Halaman yang sama di-poll tiap 5 detik.
- **Perbaikan:** jangan kirim data URL avatar di list chat — kirim thumbnail terpisah (mis. simpan 2 ukuran: 256×256 untuk profil, 48×48 untuk chat), atau kirim avatar hanya bila berubah (hash + cache client), atau batasi avatar chat ke 32×32 (~5–10 KB).

### 6.4 Pool Postgres kecil & tanpa batas waktu query
- **Bukti:** `max: 3` per instance (`src/db.js:59`), `connectionTimeoutMillis: 10000`, tanpa `statement_timeout`. Di Vercel, tiap instance serverless punya pool sendiri — 10 instance bersamaan = 30 koneksi ke Neon free tier (batas koneksi Neon free: kecil; pooled connection string dipakai, tapi tetap ada batas). Tidak ada query yang lambat saat ini, tapi tidak ada pengaman bila satu query berat (mis. agregat Liga Pers tanpa index) menahan koneksi.
- **Perbaikan:** tambah `statement_timeout: 10000` di pool; pantau koneksi Neon; pertimbangkan PgBouncer (Neon sudah menyediakan pooled endpoint — pastikan yang dipakai adalah yang pooled).

### 6.5 Render berulang & frontend monolit
- `public/js/app.js` 1.603 baris tanpa build step: setiap ganti halaman me-render ulang seluruh `#page` via `innerHTML` (termasuk chat yang me-render ulang daftar tiap poll — `renderChatRoom` meng-append, tapi `route()` me-render ulang penuh). Tidak ada virtualisasi daftar (chat 100 pesan, pasar 100 penawaran — masih OK di skala ini).
- Google Fonts dimuat dari CDN (`public/index.html`) — gagal/tidak ada internet = fallback font; tes modal sengaja membuangnya (`test/modal-dom.js`).
- Tidak ada kompresi respons (tidak ada `compression` middleware) dan tidak ada cache header untuk aset statis (Vercel memberi cache default untuk `public/`, tapi tidak dikonfigurasi eksplisit).

---

## 7. Rencana bertahap Tahap 2–8

**Prinsip:** jangan bangun ulang dari nol; pertahankan semua fitur/akun/data; jangan ada tombol/fitur palsu; semua fitur harus berfungsi + terhubung database. Urutan di bawah mengutamakan: keamanan dulu, lalu kebenaran data, lalu pengalaman, lalu kedalaman.

### Tahap 2 — Perbaikan bug + keamanan (prioritas tertinggi; estimasi 1–2 minggu kerja agen)
**Ruang lingkup:**
1. **Tutup celah admin (4.1) — HARI INI, sebelum apa pun:** Khalid daftar dengan `koboijuniorkhalid@gmail.com`; lalu hapus pemberian admin berbasis email, ganti dengan verifikasi email + bootstrap sekali pakai (env var) yang dihapus setelah dipakai.
2. Commit + push pekerjaan agen paralel (banding, foto profil, penjaga banned, loading screen, layar banned) + perbarui tes e2e untuk perilaku login-banned baru (200 + `banned:true`) + tambah tes appeals/avatar/banned-guard.
3. Perbaiki semua race condition ekonomi (BUG-2): `SELECT ... FOR UPDATE` dalam `tx()` untuk market buy, klaim, shift, latih, lamar kerja (jadikan transaksional), FX; `UPDATE ... WHERE` + cek `changes` sebagai pertahanan kedua; tambah **tes konkurensi** (dua request paralel) untuk market buy + klaim — tes ini harus jalan di Postgres (pg-mem tidak cukup; SQLite men-serialize).
4. `JWT_SECRET` wajib di production (fail-closed, §4.6); persingkat JWT ke 7 hari + pencabutan via `token_version` (§4.5).
5. Rate limit untuk registrasi + aksi sensitif (per akun + per IP, disimpan di DB agar konsisten antar instance serverless).
6. Security headers (helmet atau manual); pesan error generik untuk 500 (§4.9–4.10); batas password maksimal (§4.11).
7. Index yang hilang (§5.1) + `CHECK (gold >= 0)` dkk. + `ON CONFLICT DO NOTHING` untuk blokir & klaim pencapaian (BUG-3, BUG-6).
8. Antrian moderasi: route admin untuk membaca + menindak `chat_reports` (BUG-4) — minimal daftar laporan + aksi (hapus pesan / ban).
9. Verifikasi email (paling lambat di tahap ini) — ini juga menutup farming referral (§4.3); sambil menunggu, batasi bonus referral (mis. maks 5/hari per pemilik kode + bonus cair setelah pendaftar mencapai Level 3).
10. Pindahkan skrip verifikasi Postgres (`/tmp/verify-admin-migration.mjs`) ke `test/` agar migrasi bisa diuji ulang.
**Dependensi:** butuh Khalid daftar dulu (langkah 1). Butuh akses Neon/Vercel untuk verifikasi.
**Catatan kejujuran:** semua langkah di atas **realistis di paket gratis**. Verifikasi email butuh layanan kirim email gratis (mis. Resend free tier 100 email/hari, atau Gmail SMTP) — jangan bangun server SMTP sendiri. Rate limit berbasis DB menambah 1 query per request — dapat diterima.

### Tahap 3 — UI/UX (estimasi 1 minggu)
**Ruang lingkup:** verifikasi perbaikan header mobile + loading screen (dari agen paralel) di HP portrait sungguhan; skeleton loading per halaman; perbaiki judul chat perang (BUG-12); filter blokir di SQL (BUG-11); kurangi payload avatar di chat (§6.3); tambah konfirmasi untuk aksi destruktif (keluar partai, bongkar konvoi, batal penawaran); perbaikan aksesibilitas dasar (label, fokus); halaman "Aktivitas saya" (riwayat transaksi + aksi); hapus teks menyesatkan premium/konvoi (BUG-7) **atau** implementasikan bonusnya (pilih salah satu — jangan biarkan teks palsu).
**Dependensi:** Tahap 2 selesai (terutama commit pekerjaan paralel).
**Catatan kejujuran:** tanpa framework build, perubahan UI tetap manual di 1 file JS besar — pertimbangkan memecah `public/js/app.js` per halaman sebelum menambah fitur UI besar, kalau tidak file akan melewati 2.500+ baris dan sulit dirawat.

### Tahap 4 — Market + ekonomi (estimasi 1–2 minggu)
**Ruang lingkup:** grafik harga per komoditas (dari `market_tx` — data sudah ada, tinggal agregasi harian); order book (penawaran beli di pasar barang, bukan hanya FX); pajak masuk kas negara (BUG-8) + halaman kas negara yang menampilkan pemasukan/pengeluaran; terapkan bonus konvoi yang dijanjikan **atau** hapus janjinya (BUG-7); rantai produksi sederhana (Pabrik butuh bahan mentah sebagai input — tanpa ini, "industri" hanya pencetak barang gratis); batas harga wajar / deteksi wash trading dasar (akun yang sama IP + pola bolak-balik — hati-hati privasi, cukup heuristik sederhana + log); retensi data (arsip chat/transaksi lama, §5.6).
**Dependensi:** Tahap 2 (race condition + index) — grafik harga di atas pasar yang bisa di-oversell adalah grafik yang salah.
**Catatan kejujuran:** ekonomi yang dalam butuh **pemain** — dengan populasi 1–2 orang, grafik harga dan order book akan kosong. Fitur ini baru terasa setelah ada komunitas. Jangan over-invest sebelum ada pemain. Rantai produksi penuh (mentah → olahan → jadi) adalah desain besar — buat sebagai 1 rantai dulu (mis. Besi Mentah → Bahan Bangunan), bukan 7 sekaligus.

### Tahap 5 — Pemerintahan + diplomasi (estimasi 1–2 minggu)
**Ruang lingkup:** beri efek mekanik pada UU yang disahkan (BUG-9) — mulai dari 3 jenis UU yang efeknya jelas: ubah tarif pajak (ganti hardcode `INCOME_TAX`), ubah gaji ADMIN, ubah biaya perjalanan; beri wewenang menteri (ekonomi: usul anggaran; pertahanan: lihat info perang; luar negeri: — lihat diplomasi); pemakzulan/mosi tidak percaya; **diplomasi: JANGAN multi-negara dulu** — sebagai gantinya, perkuat Organisasi menjadi aliansi yang berpengaruh (perjanjian dagang antar anggota: potongan pajak internal; pakta pertahanan: bantuan skor perang).
**Dependensi:** Tahap 4 (kas negara harus ada pemasukan dulu sebelum bisa dibelanjakan).
**Catatan kejujuran:** **multi-negara adalah keputusan desain besar, bukan fitur tambahan.** Saat ini: 1 negara, 17 region, semua seed/kode mengasumsikan `country.id = 1` (`src/api-civic.js`, `src/tick.js` — `WHERE id = 1` di mana-mana). Menambah negara kedua berarti: migrasi skema (region → negara), ulang logika pemilu/parlemen/perang per negara, dan memecah dunia yang sekarang utuh. Itu pekerjaan setara membangun ulang setengah game. **Rekomendasi jujur:** tunda multi-negara sampai populasi stabil di atas ~50 pemain aktif dan Tahap 2–4 selesai. Diplomasi antar organisasi adalah jalan tengah yang realistis di stack ini.

### Tahap 6 — Militer + industri + sosial (estimasi 2 minggu)
**Ruang lingkup:** kepemilikan region (BUG-10) — perang yang dimenangkan mengubah pengendali region (tambah kolom `regions.controller` + efek: pajak region masuk ke pihak pengendali); unit militer sederhana (3 jenis: Infanteri/Senjata, Drone, Kendaraan Berat — dari komoditas yang sudah ada); rantai produksi tahap 1 (lihat Tahap 4); sosial: reputasi pemain (dari laporan + transaksi sukses), demografi region sederhana (populasi per region dari jumlah warga di sana — data sudah ada), event dunia acak mingguan (mis. "panen raya: harga Gandum turun" — diumumkan lewat pers/notifikasi; ini satu-satunya "bot" yang diizinkan: event sistem, bukan warga palsu).
**Dependensi:** Tahap 4 (kas negara + rantai produksi) dan Tahap 5 (efek UU).
**Catatan kejujuran:** militer yang dalam (logistik, garis pasokan, peta taktis) **tidak realistis** di arsitektur request-response + polling 5 detik. Yang realistis: perang berbasis skor + wilayah (seperti sekarang) dengan tambahan kepemilikan dan unit. Jangan janjikan RTS.

### Tahap 7 — Integrasi (estimasi 1 minggu)
**Ruang lingkup:** audit silang semua sistem: pastikan setiap angka yang tampil di UI berasal dari satu sumber kebenaran (tidak ada konstanta ganda — mis. tarif pajak di `game.js` vs `country`); hapus semua teks/fitur palsu yang tersisa (sweep: cari janji di UI yang tidak ada kodenya — pola BUG-7); sinkronkan dokumentasi README dengan perilaku nyata (termasuk perilaku login-banned baru); migrasi `missions`/`chronicle_*` dari JSON TEXT ke tabel relasional bila sempat (mengurangi race BUG-16); satu `docs/ARSITEKTUR.md` yang mencatat keputusan (1 negara, polling, tick per request) agar agen berikutnya tidak mengulang asumsi yang salah.
**Dependensi:** Tahap 2–6.

### Tahap 8 — Stress test + QA (estimasi 1 minggu)
**Ruang lingkup:** tes beban ringan (k6 atau skrip Node): 50 pemain bersamaan membuka chat + `/api/me` + 1 transaksi/detik — ukur latensi p95 + koneksi Neon + cold start; tes konkurensi ekonomi (BUG-2) di Postgres sungguhan; uji skenario "hari tick" penuh (pemilu tutup + perang tutup + UU tutup bersamaan); uji pemulihan (Vercel redeploy di tengah tick); perbaiki semua temuan; **definisi selesai:** e2e + pg + modal + tes konkurensi hijau, tanpa 500 di log Vercel selama 48 jam, dan 1 pemain baru bisa daftar → klaim → shift → jual/beli → chat tanpa hambatan.
**Dependensi:** semua tahap sebelumnya.
**Catatan kejujuran:** **stress test sungguhan (ratusan pemain bersamaan) tidak realistis di paket gratis** — Vercel Hobby membatasi durasi fungsi 60 detik & konkurensi, Neon free membatasi koneksi & RAM 0,25 GB. Target yang jujur: **20–50 pemain bersamaan** masih nyaman; di atas itu butuh paket berbayar (Vercel Pro + Neon Scale) atau pindah ke server selalu-nyala (Render/VPS). "Real-time" (notifikasi instan, chat tanpa delay) **tidak mungkin** tanpa websocket — polling 5 detik adalah batas arsitektur serverless; bila Khalid menginginkan real-time sejati, arsitektur harus pindah dari Vercel Serverless ke server persistent (Render free bisa, tapi tidur setelah 15 menit; VPS berbayar adalah jawaban jujur untuk real-time).

---

## Lampiran — Apa yang TIDAK realistis di paket gratis ini (ringkasan jujur)

1. **Websocket / real-time sejati** — tidak ada di Vercel Serverless. Polling 5 detik adalah batasnya. Pindah ke server persistent bila real-time wajib.
2. **Ratusan pemain bersamaan** — Neon free (0,25 GB RAM, koneksi terbatas) + pool max 3/instance + fungsi 60 detik. Target realistis: puluhan pemain bersamaan.
3. **Multi-negara penuh** — keputusan desain besar; menunda sampai komunitas terbentuk adalah pilihan yang benar, bukan penundaan malas.
4. **Cold start 0 detik** — init DB + migrasi di cold start akan selalu butuh detik. Loading screen adalah penutup yang tepat; `minInstances` berbayar adalah obat yang sebenarnya.
5. **Anti-cheat sempurna** — tanpa verifikasi email + deteksi perangkat, multi-account selalu mungkin. Verifikasi email (gratis via Resend/Gmail SMTP) adalah langkah pertama yang paling murah dan paling efektif.
6. **Ekonomi yang dalam tanpa pemain** — pasar, grafik harga, dan diplomasi butuh populasi. Prioritaskan mendatangkan pemain (Khalid daftar + undang teman + referral) sebelum membangun kedalaman ekonomi tingkat lanjut.

---

## Lampiran — Daftar route API (inventaris lengkap, baseline + working tree)

**Auth:** `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/world` (publik).
**Warga:** `GET /api/me`, `POST /api/claim`, `POST /api/train`, `POST /api/eat`, `GET /api/missions`, `POST /api/missions/claim`, `GET /api/chronicle`, `POST /api/chronicle/claim`, `GET /api/achievements`, `POST /api/achievements/claim`, `GET /api/inventory`, `GET /api/notifications`, `POST /api/notifications/read`, `GET /api/profile/:username`, `POST /api/profile/bio`, `POST /api/profile/rename`, `POST /api/profile/avatar` + `POST /api/profile/avatar/delete` (working tree).
**Ekonomi:** `GET /api/jobs`, `POST /api/jobs/apply|quit|shift`, `GET /api/companies`, `POST /api/companies`, `POST /api/companies/:id/job`, `GET /api/market`, `POST /api/market/sell|buy|cancel`, `GET /api/fx`, `POST /api/fx/mint|offer|take|cancel`, `GET /api/convoy`, `POST /api/convoy/build|demolish`, `GET /api/regions`, `GET /api/regions/:id`, `POST /api/regions/travel|rebel`, `GET /api/shop`.
**Sipil:** `GET /api/country`, `POST /api/country/appoint`, `GET /api/parties`, `POST /api/parties`, `POST /api/parties/:id/join|leave|approve`, `GET /api/parliament`, `POST /api/parliament/law`, `POST /api/parliament/vote`, `GET /api/elections`, `POST /api/elections/:id/register|vote`, `GET /api/wars`, `GET /api/wars/:id`, `POST /api/wars/:id/attack`, `GET /api/press/stats`, `GET /api/press/articles`, `GET /api/press/articles/:id`, `POST /api/press/articles`, `POST /api/press/articles/:id/react|comment`, `GET /api/press/newspapers/mine`, `POST /api/press/newspaper`, `GET /api/press/league`, `GET /api/chat/:room`, `POST /api/chat/:room`, `POST /api/chat/report|block|unblock`, `GET /api/dms`, `GET /api/dms/:citizenId`, `POST /api/dms/:citizenId`, `GET /api/orgs`, `POST /api/orgs`, `POST /api/orgs/:id/join|leave`, `POST /api/support`.
**Admin:** `GET /api/admin/players`, `GET /api/admin/actions`, `POST /api/admin/ban|unban|premium|gold|usd|item|energy`.
**Banding (working tree):** `POST /api/appeals`, `GET /api/appeals/mine`, `GET /api/appeals/:id`, `POST /api/appeals/:id/message`, `GET /api/admin/appeals`, `POST /api/admin/appeals/:id/message`, `POST /api/admin/appeals/:id/decide`.

**Skema DB (35 tabel):** users, admin_actions, appeals*, appeal_messages*, citizens, regions, commodities, inventory, market_offers, market_tx, fx_offers, fx_history, jobs, companies, country, parties, party_members, laws, law_votes, elections, election_candidates, election_votes, wars, war_attacks, war_support, newspapers, articles, article_reactions, article_comments, chat_messages, chat_reports, blocked, notifications, dms, achievements, convoys, organizations, org_members, support_tickets, world. (* = working tree, belum commit.)
