// Daily tick Parlementer: dunia maju 1 hari tiap tengah malam.
// Dipanggil otomatis saat ada request (cek tanggal) + interval 10 menit.
// Aman di Render free (tanpa cron eksternal): tick jalan saat ada yang membuka game.
import { sql, one, run } from './db.js';
import { DAILY_PRODUCTION } from './game.js';

function todayStr(d = new Date()) { return d.toISOString().slice(0, 10); }

export async function ensureElections() {
  const now = Date.now();
  const pres = await one("SELECT * FROM elections WHERE type = 'president' AND status IN ('scheduled','open') ORDER BY opens_at ASC");
  if (!pres) {
    const opens = now + 7 * 24 * 60 * 60 * 1000;
    await run("INSERT INTO elections (type, status, opens_at, closes_at, created_at) VALUES ('president','scheduled',?,?,?) RETURNING id",
      [opens, opens + 3 * 24 * 60 * 60 * 1000, now]);
  }
  const parl = await one("SELECT * FROM elections WHERE type = 'parliament' AND status IN ('scheduled','open') ORDER BY opens_at ASC");
  if (!parl) {
    const opens = now + 30 * 24 * 60 * 60 * 1000;
    await run("INSERT INTO elections (type, status, opens_at, closes_at, created_at) VALUES ('parliament','scheduled',?,?,?) RETURNING id",
      [opens, opens + 3 * 24 * 60 * 60 * 1000, now]);
  }
}

async function notify(citizenId, category, title, content = '') {
  await run('INSERT INTO notifications (citizen_id, category, title, content, created_at) VALUES (?,?,?,?,?) RETURNING id',
    [citizenId, category, title, content, Date.now()]);
}

export async function runDailyTick() {
  const world = await one('SELECT * FROM world WHERE id = 1');
  const today = todayStr();
  if (!world || world.last_tick_date === today) return { ticked: false, day: world?.day || 1 };
  // Klaim hari ini secara atomik SEBELUM mengerjakan apa pun: di serverless
  // beberapa instance bisa menerima request bersamaan dan menjalankan tick
  // yang sama — tanpa klaim ini, hari bisa maju 2× dan produksi/notifikasi
  // bisa terduplikasi. Yang gagal klaim langsung berhenti.
  // Catatan: bila proses crash di tengah tick setelah klaim, tick hari itu
  // terlewat (aman — tidak ada duplikasi; tick berikutnya jalan besok).
  const claimed = await run('UPDATE world SET last_tick_date = ? WHERE id = 1 AND last_tick_date <> ?', [today, today]);
  if (claimed.changes === 0) return { ticked: false, day: world.day };
  const now = Date.now();

  // 1) Warga: energi pulih, jatah harian reset, kelelahan pulih sebagian.
  await run(`UPDATE citizens SET energy = 100, bread_today = 0, energy_spent_today = 0,
    chat_today = 0, fatigue = CASE WHEN fatigue > 2000 THEN fatigue - 2000 ELSE 0 END, missions = '{}'`);

  // 2) Produksi perusahaan -> inventaris pemilik.
  const companies = await sql('SELECT * FROM companies');
  for (const co of companies) {
    const amount = DAILY_PRODUCTION[co.type] || 0;
    let commodity = co.resource || '';
    if (co.type === 'factory') commodity = 'Bahan Bangunan';
    if (co.type === 'light') commodity = 'Makanan';
    if (co.type === 'heavy') commodity = 'Drone';
    if (!commodity || amount <= 0) continue;
    const com = await one('SELECT id FROM commodities WHERE name = ?', [commodity]);
    if (!com) continue;
    const inv = await one('SELECT * FROM inventory WHERE citizen_id = ? AND commodity_id = ? AND tier = 1', [co.owner_id, com.id]);
    if (inv) await run('UPDATE inventory SET qty = qty + ? WHERE id = ?', [amount, inv.id]);
    else await run('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,?) RETURNING id', [co.owner_id, com.id, amount]);
    await notify(co.owner_id, 'EKONOMI', 'Produksi perusahaan', `${co.name} memproduksi ${amount}× ${commodity} hari ini.`);
  }

  // 3) Pemilu: buka yang sudah waktunya, tutup & selesaikan yang berakhir.
  await run("UPDATE elections SET status = 'open' WHERE status = 'scheduled' AND opens_at <= ?", [now]);
  const closing = await sql("SELECT * FROM elections WHERE status = 'open' AND closes_at <= ?", [now]);
  for (const e of closing) {
    const top = await sql('SELECT * FROM election_candidates WHERE election_id = ? ORDER BY votes DESC LIMIT 1', [e.id]);
    if (e.type === 'president') {
      if (top.length && top[0].votes > 0) {
        await run('UPDATE elections SET status = ?, winner_id = ? WHERE id = ?', ['closed', top[0].citizen_id, e.id]);
        await run('UPDATE country SET president_id = ? WHERE id = 1', [top[0].citizen_id]);
        await notify(top[0].citizen_id, 'POLITIK', 'Kamu terpilih jadi Presiden!', 'Selamat! Kamu memenangkan pemilu presiden Republik Indonesia.');
      } else {
        await run("UPDATE elections SET status = 'closed' WHERE id = ?", [e.id]);
      }
    } else {
      // Parlemen: kursi dibagi proporsional dari suara per partai.
      const cands = await sql('SELECT * FROM election_candidates WHERE election_id = ?', [e.id]);
      const total = cands.reduce((s, c) => s + c.votes, 0);
      await run('UPDATE parties SET seats = 0');
      if (total > 0) {
        let assigned = 0;
        for (const cand of cands) {
          const seats = Math.round((cand.votes / total) * 60);
          assigned += seats;
          if (cand.party_id) await run('UPDATE parties SET seats = ? WHERE id = ?', [seats, cand.party_id]);
        }
        // Koreksi pembulatan ke 60 kursi pada partai terbesar.
        if (assigned !== 60 && cands.length) {
          const biggest = [...cands].sort((a, b) => b.votes - a.votes)[0];
          if (biggest.party_id) {
            const cur = await one('SELECT seats FROM parties WHERE id = ?', [biggest.party_id]);
            await run('UPDATE parties SET seats = ? WHERE id = ?', [Math.max(0, cur.seats + (60 - assigned)), biggest.party_id]);
          }
        }
      }
      await run("UPDATE elections SET status = 'closed' WHERE id = ?", [e.id]);
    }
  }
  await ensureElections();

  // 4) UU: tutup voting yang berakhir.
  const laws = await sql("SELECT * FROM laws WHERE status = 'voting' AND ends_at <= ?", [now]);
  for (const law of laws) {
    if (law.yes > law.no) {
      await run("UPDATE laws SET status = 'executed' WHERE id = ?", [law.id]);
      await notify(law.proposer_id, 'POLITIK', 'UU-mu disahkan', `"${law.title}" lolos voting dan mulai berlaku.`);
    } else {
      await run("UPDATE laws SET status = 'failed' WHERE id = ?", [law.id]);
      await notify(law.proposer_id, 'POLITIK', 'UU-mu gagal', `"${law.title}" tidak lolos voting.`);
    }
  }

  // 5) Perang: tutup yang berakhir, tentukan pemenang.
  const wars = await sql("SELECT * FROM wars WHERE status = 'active' AND ends_at <= ?", [now]);
  for (const w of wars) {
    const winner = w.score_a > w.score_d ? 'attacker' : 'defender';
    await run("UPDATE wars SET status = 'ended', winner = ? WHERE id = ?", [winner, w.id]);
    const fighters = await sql('SELECT DISTINCT citizen_id FROM war_attacks WHERE war_id = ?', [w.id]);
    for (const f of fighters) {
      await notify(f.citizen_id, 'PERANG', `Perang ${w.name} berakhir`,
        winner === 'attacker' ? 'Pemberontak memenangkan wilayah ini.' : 'Republik Indonesia berhasil mempertahankan wilayah ini.');
    }
  }

  // 6) Penawaran valas kedaluwarsa -> kembalikan dana yang dikunci.
  const expired = await sql('SELECT * FROM fx_offers WHERE expires_at <= ?', [now]);
  for (const o of expired) {
    const remaining = o.qty_gold - o.qty_filled;
    if (o.direction === 'sell') await run('UPDATE citizens SET gold = gold + ? WHERE id = ?', [remaining, o.citizen_id]);
    else await run('UPDATE citizens SET usd = usd + ? WHERE id = ?', [o.price * remaining, o.citizen_id]);
    await run('DELETE FROM fx_offers WHERE id = ?', [o.id]);
  }

  // 7) Konvoi kedaluwarsa (7 hari) roboh.
  await run('DELETE FROM convoys WHERE expires_at <= ?', [now]);

  await run('UPDATE world SET day = day + 1, last_tick_date = ? WHERE id = 1', [today]);
  const after = await one('SELECT * FROM world WHERE id = 1');
  console.log(`[tick] Hari ${after.day} — ${today}`);
  return { ticked: true, day: after.day };
}

let ticking = false;
export async function maybeTick() {
  if (ticking) return;
  ticking = true;
  try { await runDailyTick(); } catch (e) { console.error('[tick] gagal:', e.message); }
  finally { ticking = false; }
}
