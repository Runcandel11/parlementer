# Sumber Gambar Latar (v5.7.4)

Semua gambar latar diunduh ke repo ini (tidak ada hotlink) dan dipakai
sebagai latar kontekstual per halaman lewat `#page-bg` + banner `.page-hero`
di `public/js/app.js` (peta `PAGE_BG`).

Lisensi: semua gambar di bawah ini berlisensi bebas (domain publik,
CC BY / CC BY-SA, atau foto gratis Vecteezy). Atribusi dicatat di sini;
untuk CC BY / CC BY-SA, atribusi juga berlaku lewat catatan ini.

| File | Isi | Sumber | Lisensi |
|---|---|---|---|
| `city.jpg` (1200×675, 60 KB) | Skyline Jakarta dari Stasiun Gambir | Wikimedia Commons — "View of Jakarta skyline seen from Gambir Station.jpg" — https://commons.wikimedia.org/wiki/File:View_of_Jakarta_skyline_seen_from_Gambir_Station.jpg | CC BY-SA 4.0 |
| `war.jpg` (1200×725, 120 KB) | Reruntuhan Perpustakaan Louvain, 1914 (di-crop dari mount arsip NARA) | Wikimedia Commons — "Havoc of War - Ruins ... Library at Louvain, destroyed by the Germans in 1914 - NARA - 31484269.jpg" (domain publik, NARA) — https://commons.wikimedia.org/wiki/File:Havoc_of_War_-_Ruins_-_France_-_Cities_-_L_-_RUINS_IN_FRANCE._Ruins_of_the_Library_at_louvain,_destroyed_by_the_Germans_in_1914_-_NARA_-_31484269.jpg | Domain publik |
| `market.jpg` (1000×749, 213 KB) | Pasar apung buah-buahan | Wikimedia Commons — "Traditional floating fruits market 01.jpg" — https://commons.wikimedia.org/wiki/File:Traditional_floating_fruits_market_01.jpg | CC BY-SA 4.0 |
| `factory.jpg` (1200×827, 192 KB) | Pekerja pabrik garmen (stempel tanggal di-crop) | Wikimedia Commons — "Garment Factory Workers in Thailand.jpg" — https://commons.wikimedia.org/wiki/File:Garment_Factory_Workers_in_Thailand.jpg | CC BY 2.0 |
| `parliament.jpg` (1200×677, 187 KB) | Ruang sidang Parlemen Eropa, Strasbourg | Wikimedia Commons — "European Parliament Strasbourg Hemicycle - Diliff.jpg" — https://commons.wikimedia.org/wiki/File:European_Parliament_Strasbourg_Hemicycle_-_Diliff.jpg | CC BY-SA 3.0 |
| `map.jpg` (1000×841, 220 KB) | Peta dunia Samuel Dunn, 1794 | Wikimedia Commons — "1794 Samuel Dunn Wall Map of the World in Hemispheres - Geographicus - World2-dunn-1794.jpg" — https://commons.wikimedia.org/wiki/File:1794_Samuel_Dunn_Wall_Map_of_the_World_in_Hemispheres_-_Geographicus_-_World2-dunn-1794.jpg | Domain publik |
| `press.jpg` (1200×806, 156 KB) | Mesin cetak koran Kaleva, 1961 (nomor arsip di-crop) | Wikimedia Commons — "A press in the printing house Kaleva 1961 (JOKAKAL3B-9309).tif" — https://commons.wikimedia.org/wiki/File:A_press_in_the_printing_house_Kaleva_1961_(JOKAKAL3B-9309).tif | CC BY 4.0 |
| `night.jpg` (1200×675, 149 KB) | Dotonbori, Osaka, di malam hari (di-crop ke lanskap) | Wikimedia Commons — "Dotonbori, Osaka, at night, November 2016.jpg" — https://commons.wikimedia.org/wiki/File:Dotonbori,_Osaka,_at_night,_November_2016.jpg | CC BY-SA 4.0 |
| `shop.jpg` (1200×800, 58 KB) | Tumpukan koin emas di atas kayu gelap | Vecteezy (foto gratis) — https://www.vecteezy.com/photo/58075596 (atribusi: Vecteezy) | Lisensi gratis Vecteezy (perlu atribusi) |
| `book.jpg` (1200×900, 141 KB) | Buku-buku tua di rak perpustakaan | Wikimedia Commons — "Old-books-on-the-open-access-shelves. Ataide Municipal Library, Mapusa, Goa, India.jpg" — https://commons.wikimedia.org/wiki/File:Old-books-on-the-open-access-shelves._Ataide_Municipal_Library,_Mapusa,_Goa,_India.jpg | CC BY-SA 4.0 |
| `profile.jpg` (1200×678, 111 KB) | Monas & Jakarta dari udara | Wikimedia Commons — "Monumen Nasional, Jakarta, Indonesia.jpg" — https://commons.wikimedia.org/wiki/File:Monumen_Nasional,_Jakarta,_Indonesia.jpg | CC BY-SA 4.0 |
| `convoy.jpg` (1200×900, 123 KB) | Konvoi truk di jalan pegunungan Manali–Leh | Wikimedia Commons — "Military truck convoy on the Manali-Leh Highway, 1.jpg" — https://commons.wikimedia.org/wiki/File:Military_truck_convoy_on_the_Manali-Leh_Highway,_1.jpg | CC BY-SA 3.0 |

Total: 12 gambar, ~1,7 MB. `market.jpg` dan `map.jpg` sedikit di atas
target 200 KB (213 KB / 220 KB) karena detailnya sangat halus; tiap
halaman hanya memuat SATU gambar (di-cache browser), jadi dampaknya kecil.

## Pemetaan halaman → gambar

Lihat `PAGE_BG` di `public/js/app.js`. Ringkasnya:

- `city.jpg` → dashboard, notifications, activity, stats, admin, share, country, reset-password
- `war.jpg` → war, war-world, military
- `market.jpg` → market, global, fx
- `factory.jpg` → jobs, companies
- `parliament.jpg` → parliament, elections, parties
- `map.jpg` → map, regions
- `press.jpg` → press, press/new, press/league, newspaper
- `night.jpg` → chat, messages
- `shop.jpg` → shop, ads
- `book.jpg` → book, help, chronicle, contact
- `profile.jpg` → profile, settings, achievements, inventory
- `convoy.jpg` → convoy, contracts, orgs
