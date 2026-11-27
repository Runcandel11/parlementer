// Vercel Serverless Function — adapter untuk aplikasi Express Parlementer.
// Vercel menjalankan file ini sekali per request; tidak ada proses yang jalan
// terus, jadi di sini TIDAK ada listen() dan TIDAK ada setInterval:
//   - init DB (schema + seed + pemilu) jalan sekali per cold start
//     lewat ensureReady() — promise-nya di-cache (src/app.js).
//   - tick harian tetap jalan lewat maybeTick() di setiap request /api/
//     (middleware di src/app.js) + klaim atomik di src/tick.js.
// Static file di public/ dilayani langsung oleh Vercel (bukan oleh fungsi ini).
//
// Handler-nya tinggal re-export dari src/app.js (satu sumber): Vercel
// mendeteksi file bernama `app` yang mengimpor express sebagai entry
// aplikasi, jadi ada kemungkinan Vercel memuat src/app.js langsung sebagai
// entry, bukan file ini — kedua jalur harus valid dan berperilaku sama.
export { default } from '../src/app.js';
