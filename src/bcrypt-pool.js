// Pool worker_threads untuk bcrypt — hashing & verifikasi password TIDAK
// boleh jalan di thread utama. bcryptjs murni JavaScript: satu hash cost 10
// menahan event loop ~100+ ms (diukur di VM dev: interval 10 ms hanya jalan
// 2x selama satu hash), jadi login/daftar yang berbarengan membuat semua
// request pemain lain ikut ketahan ("kadang lemot", Nov 2026).
// Pool: 2 worker, antrean FIFO, bcryptjs yang sama (format hash $2a$ tidak
// berubah — hash lama di DB tetap bisa diverifikasi, tanpa reset password).
// Worker dibuat malas (lazy) saat auth pertama dipakai, dan di-unref agar
// tidak menahan proses tes/serverless. Bila worker gagal dibuat (mis.
// lingkungan yang membatasi worker_threads), jatuh kembali ke bcryptjs di
// thread utama (perilaku lama) agar login/register tidak pernah mati karena
// worker. Escape hatch ops: BCRYPT_POOL_OFF=1 memaksa fallback.
import bcrypt from 'bcryptjs';
import { Worker } from 'node:worker_threads';

const POOL_SIZE = 2;
const TASK_TIMEOUT_MS = 30_000;

let mode = null; // 'worker' | 'fallback'
let workers = []; // { worker, busy, taskId }
let nextId = 1;
const pending = new Map(); // id -> { task, resolve, reject, timer }
const queue = []; // { task, resolve, reject, timer }

function createWorker() {
  const worker = new Worker(new URL('./bcrypt-worker.js', import.meta.url));
  worker.unref(); // jangan menahan proses bila hanya worker yang tersisa
  const entry = { worker, busy: false, taskId: 0 };
  worker.on('message', (msg) => {
    const item = pending.get(msg.id);
    if (!item) return;
    pending.delete(msg.id);
    clearTimeout(item.timer);
    entry.busy = false;
    entry.taskId = 0;
    if (msg.ok) item.resolve(msg.result);
    else item.reject(new Error(msg.error || 'bcrypt worker gagal'));
    dispatch();
  });
  worker.on('error', (err) => {
    console.error('[bcrypt-pool] worker error, diganti:', err?.message || err);
    replaceWorker(entry);
  });
  worker.on('exit', (code) => {
    if (code !== 0) {
      console.error('[bcrypt-pool] worker keluar dengan kode', code, '— diganti');
      replaceWorker(entry);
    }
  });
  return entry;
}

function replaceWorker(entry) {
  const idx = workers.indexOf(entry);
  if (idx === -1) return;
  // Tugas yang sedang jalan di worker ini kembali ke antrean (hash/compare
  // idempotent, jadi aman dijalankan ulang).
  if (entry.taskId) {
    const item = pending.get(entry.taskId);
    if (item) {
      pending.delete(entry.taskId);
      clearTimeout(item.timer);
      item.task.id = 0;
      queue.unshift(item);
    }
  }
  try { entry.worker.terminate(); } catch { /* abaikan */ }
  workers[idx] = createWorker();
  dispatch();
}

function dispatch() {
  if (mode !== 'worker') return;
  while (queue.length) {
    const entry = workers.find((w) => !w.busy);
    if (!entry) return;
    const item = queue.shift();
    item.task.id = nextId++;
    entry.busy = true;
    entry.taskId = item.task.id;
    item.timer = setTimeout(() => {
      // Worker macet: ganti worker, tolak tugas (route mengembalikan 500
      // lewat wrapper error — lebih baik daripada menggantung selamanya).
      pending.delete(item.task.id);
      replaceWorker(entry);
      item.reject(new Error('bcrypt timeout'));
    }, TASK_TIMEOUT_MS);
    pending.set(item.task.id, item);
    entry.worker.postMessage(item.task);
  }
}

function ensurePool() {
  if (mode) return mode === 'worker';
  if (process.env.BCRYPT_POOL_OFF === '1') {
    mode = 'fallback';
    return false;
  }
  try {
    workers = Array.from({ length: POOL_SIZE }, () => createWorker());
    mode = 'worker';
    return true;
  } catch (e) {
    console.error('[bcrypt-pool] worker tidak bisa dibuat, fallback ke thread utama:', e?.message || e);
    mode = 'fallback';
    return false;
  }
}

function runTask(task) {
  if (ensurePool()) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject, timer: null });
      dispatch();
    });
  }
  // Fallback: bcryptjs di thread utama (perilaku lama).
  if (task.op === 'hash') return bcrypt.hash(task.password, 10);
  return bcrypt.compare(task.password, task.hash);
}

export function hashPassword(password) {
  return runTask({ op: 'hash', password, hash: null, id: 0 });
}

export function verifyPassword(password, hash) {
  return runTask({ op: 'compare', password, hash, id: 0 });
}
