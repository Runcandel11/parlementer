// Vercel Serverless Function — adapter untuk aplikasi Express Parlementer.
// Vercel menjalankan file ini sekali per request; tidak ada proses yang jalan
// terus, jadi di sini TIDAK ada listen() dan TIDAK ada setInterval:
//   - init DB (schema + seed + pemilu) jalan sekali per cold start
//     lewat ensureReady() — promise-nya di-cache (src/app.js).
//   - tick harian tetap jalan lewat maybeTick() di setiap request /api/
//     (middleware di src/app.js) + klaim atomik di src/tick.js.
// Static file di public/ dilayani langsung oleh Vercel (bukan oleh fungsi ini).
import { app, ensureReady } from '../src/app.js';

export default async function handler(req, res) {
  await ensureReady();
  // Tunggu respons Express benar-benar selesai dikirim sebelum fungsi selesai.
  // Kalau hanya `return app(req, res)`, runtime bisa membekukan fungsi saat
  // promise resolve padahal handler async di dalam route belum selesai.
  await new Promise((resolve, reject) => {
    res.once('finish', resolve);
    res.once('close', resolve);
    try {
      app(req, res);
    } catch (err) {
      reject(err);
    }
  });
}
