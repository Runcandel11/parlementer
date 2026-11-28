// Parlementer — kerja otomatis Premium 24 jam (v4.5.0, "jalan walau ditutup").
// Runner server-side: shift berjalan otomatis walau aplikasi pemain
// ditutup. Dipanggil berkala — tiap 10 menit dari server.js DAN di setiap
// request /api/ (src/app.js) — tapi di-throttle internal (paling sering
// 1× per AUTO_WORK_INTERVAL_MS, default 5 menit) supaya tidak membebani
// tiap request. Aman dipanggil paralel: flag in-process + kunci baris
// warga (FOR UPDATE di performShift) membuat dua runner berurutan —
// yang kedua membaca energi yang sudah dipakai dan melewati warga itu.
//
// Aturan (lihat konstanta di game.js):
//  - hanya shift PENUH: energi harus >= 100 (AUTO_WORK_MIN_ENERGY).
//    Energi di bawah itu dibiarkan regen dulu (+2/mnt).
//  - JEDA saat kelelahan >= 10.000 (AUTO_WORK_FATIGUE_PAUSE): tidak
//    pernah bekerja dengan hasil terpotong ×0,75/×0,5. Jeda berakhir
//    otomatis saat kelelahan pulih di bawah 10.000.
//  - BERHENTI (sekali, + notifikasi SISTEM) bila: 24 jam habis, Premium
//    habis, atau pekerjaan hilang/berubah (quit/apply sudah mematikan
//    langsung; runner menangani kasus yang terlewat, mis. lowongan
//    dihapus admin).
import { sql, one, run } from './db.js';
import { loadCitizen } from './util.js';
import { notify } from './api-civic.js';
import { shiftRunner } from './api-core.js';
import {
  AUTO_WORK_MIN_ENERGY, AUTO_WORK_FATIGUE_PAUSE, AUTO_WORK_INTERVAL_MS,
} from './game.js';

let lastRunAt = 0;
let running = false;

// Matikan kerja otomatis + beri tahu pemain sekali (alasan berbeda-beda).
async function stopAutoWork(c, reason, title) {
  const shifts = c.auto_work_shifts || 0;
  await run('UPDATE citizens SET auto_work_until = 0, auto_work_started_at = 0, auto_work_paused = 0 WHERE id = ?', [c.id]);
  await notify(c.id, 'SISTEM', title, `${reason} Total ${shifts} shift otomatis sudah dijalankan. Nyalakan lagi dari panel PEKERJAANMU bila mau.`);
}

export async function maybeAutoWork(force = false) {
  const now = Date.now();
  if (running) return { ran: false, reason: 'busy' };
  if (!force && now - lastRunAt < AUTO_WORK_INTERVAL_MS) return { ran: false, reason: 'throttled' };
  running = true;
  lastRunAt = now;
  try {
    if (typeof shiftRunner.performShift !== 'function') return { ran: false, reason: 'not-ready' };
    // Kandidat: semua warga yang auto-work-nya pernah dinyalakan
    // (until > 0) — yang sudah kedaluwarsa ikut terambil supaya sempat
    // dimatikan + diberi notifikasi ringkasan, bukan diam-diam mati.
    const cands = await sql('SELECT id FROM citizens WHERE auto_work_until > 0');
    let shifted = 0, paused = 0, stopped = 0, skipped = 0;
    for (const row of cands) {
      try {
        const uid = await one('SELECT user_id FROM citizens WHERE id = ?', [row.id]);
        if (!uid) continue;
        // loadCitizen menerapkan regen energi malas + menyelesaikan
        // perjalanan — jadi energi yang dibaca sudah termasuk pulihan
        // selama pemain offline.
        const c = await loadCitizen(uid.user_id);
        if (!c) continue;
        // 1) Masa aktif habis -> matikan + ringkasan.
        if ((c.auto_work_until || 0) <= now) {
          await stopAutoWork(c, 'Masa kerja otomatis 24 jam sudah habis.', 'Kerja otomatis selesai');
          stopped++;
          continue;
        }
        // 2) Premium habis -> matikan.
        if ((c.premium_until || 0) <= now) {
          await stopAutoWork(c, 'Premium kamu sudah habis.', 'Kerja otomatis berhenti');
          stopped++;
          continue;
        }
        // 3) Pekerjaan hilang (lowongan dihapus / sudah keluar) -> matikan.
        if (!c.job_id) {
          await stopAutoWork(c, 'Kamu sedang tidak bekerja.', 'Kerja otomatis berhenti');
          stopped++;
          continue;
        }
        const job = await one('SELECT id FROM jobs WHERE id = ?', [c.job_id]);
        if (!job) {
          await stopAutoWork(c, 'Lowongan pekerjaanmu sudah tidak ada.', 'Kerja otomatis berhenti');
          stopped++;
          continue;
        }
        // 4) Kelelahan >= 10.000 -> JEDA (bukan berhenti): tidak bekerja
        // dengan hasil terpotong. Beri tahu sekali saat mulai dijeda.
        if ((c.fatigue || 0) >= AUTO_WORK_FATIGUE_PAUSE) {
          if (!c.auto_work_paused) {
            await run('UPDATE citizens SET auto_work_paused = 1 WHERE id = ?', [c.id]);
            await notify(c.id, 'SISTEM', 'Kerja otomatis dijeda',
              `Kelelahanmu sudah ${c.fatigue} (batas 10.000) — shift otomatis dijeda supaya hasilmu tidak terpotong. Lanjut otomatis saat kelelahan pulih di bawah 10.000.`);
          }
          paused++;
          continue;
        }
        // Pulih dari jeda: bersihkan penanda, lanjut diam-diam.
        if (c.auto_work_paused) {
          await run('UPDATE citizens SET auto_work_paused = 0 WHERE id = ?', [c.id]);
        }
        // 5) Energi belum penuh -> tunggu regen (tidak ada shift parsial
        // otomatis).
        if ((c.energy || 0) < AUTO_WORK_MIN_ENERGY) { skipped++; continue; }
        // 6) Jalankan SATU shift penuh — rumus sama persis dengan shift
        // manual (performShift). Kunci baris warga di dalamnya membuat
        // dua runner paralel tidak bisa menghabiskan energi yang sama.
        await shiftRunner.performShift(c.id);
        await run('UPDATE citizens SET auto_work_shifts = auto_work_shifts + 1, auto_work_last_at = ? WHERE id = ?', [now, c.id]);
        shifted++;
      } catch (e) {
        console.error('[auto-work] gagal memproses warga', row.id, e.message);
      }
    }
    return { ran: true, shifted, paused, stopped, skipped };
  } finally {
    running = false;
  }
}
