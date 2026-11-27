// Entry worker thread untuk bcrypt (dipakai src/bcrypt-pool.js).
// Satu-satunya tugas: hashSync / compareSync bcryptjs di luar thread utama.
// Format hash $2a$ sama dengan yang dipakai selama ini — hash lama di DB
// tetap valid tanpa reset password.
import bcrypt from 'bcryptjs';
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (task) => {
  try {
    let result;
    if (task.op === 'hash') result = bcrypt.hashSync(task.password, 10);
    else if (task.op === 'compare') result = bcrypt.compareSync(task.password, task.hash);
    else throw new Error('op bcrypt tidak dikenal: ' + task.op);
    parentPort.postMessage({ id: task.id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id: task.id, ok: false, error: String((e && e.message) || e) });
  }
});
