// API militer Parlementer (Tahap 6, v4.0.0): rekrut / bubarkan unit militer.
// Unit dibeli dengan komoditas + USD, dirawat harian dari USD (tick.js —
// bila saldo kurang, unit termahal desersi), dan memperkuat serangan perang
// lewat pengali kerusakan (game.js unitDamageMult, maks ×1,5).
import { sql, one, tx, forUpdate } from './db.js';
import { authRequired, citizenRequired, fmtRp } from './util.js';
import { militaryPowerOf, militaryUnitsOf } from './api-civic.js';
import {
  MILITARY_UNITS, unitCapFor, militaryPowerFor, unitDamageMult,
  unitUpkeepFor, unitCountFor,
} from './game.js';

export function registerMilitary(app) {
  const r = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // Ringkasan militerku + 5 kekuatan militer teratas dunia.
  app.get('/api/military', authRequired, citizenRequired, r(async (req, res) => {
    const units = await militaryUnitsOf(req.citizen.id);
    const power = militaryPowerFor(units);
    const all = await sql(
      `SELECT mu.citizen_id, mu.unit_type, mu.qty, u.username FROM military_units mu
       JOIN citizens c ON c.id = mu.citizen_id JOIN users u ON u.id = c.user_id WHERE mu.qty > 0`);
    const byCitizen = new Map();
    for (const row of all) {
      const e = byCitizen.get(row.citizen_id) || { citizen_id: row.citizen_id, username: row.username, units: [] };
      e.units.push({ type: row.unit_type, qty: row.qty });
      byCitizen.set(row.citizen_id, e);
    }
    const top = [...byCitizen.values()]
      .map((e) => ({ citizen_id: e.citizen_id, username: e.username, power: militaryPowerFor(e.units), count: unitCountFor(e.units) }))
      .sort((a, b) => b.power - a.power)
      .slice(0, 5);
    res.json({
      units, power,
      mult: Math.round(unitDamageMult(power) * 100) / 100,
      upkeep: unitUpkeepFor(units),
      count: unitCountFor(units),
      cap: unitCapFor(req.citizen.level),
      defs: MILITARY_UNITS,
      top,
    });
  }));

  // Rekrut unit: bayar komoditas (dari inventaris, tier 1) + USD, atomik.
  // Batas pasukan 50 + 10×level (unitCapFor) — tanpa batas, pengali perang
  // bisa pecah. Jumlah 1–50 per perekrutan.
  app.post('/api/military/recruit', authRequired, citizenRequired, r(async (req, res) => {
    const { type, qty } = req.body || {};
    const def = MILITARY_UNITS[type];
    if (!def) return res.status(400).json({ error: 'Jenis unit tidak dikenal.' });
    const q = Math.floor(Number(qty) || 0);
    if (q < 1 || q > 50) return res.status(400).json({ error: 'Jumlah 1–50 unit per perekrutan.' });
    const result = await tx(async (t) => {
      const locked = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      const cap = unitCapFor(locked.level);
      const haveRows = await t.sql('SELECT COALESCE(SUM(qty),0) AS n FROM military_units WHERE citizen_id = ?', [locked.id]);
      const current = Number(haveRows[0]?.n || 0);
      if (current + q > cap) throw Object.assign(new Error(`Batas pasukanmu ${cap} unit (punya ${current}). Naik level untuk menambah batas.`), { status: 400 });
      const costUsd = def.usd * q;
      const needCom = def.commodityQty * q;
      const com = await t.one('SELECT id FROM commodities WHERE name = ?', [def.commodity]);
      if (!com) throw Object.assign(new Error('Komoditas unit tidak tersedia.'), { status: 500 });
      const stock = await t.one(forUpdate('SELECT * FROM inventory WHERE citizen_id = ? AND commodity_id = ? AND tier = 1'), [locked.id, com.id]);
      if (!stock || stock.qty < needCom) throw Object.assign(new Error(`Butuh ${needCom}× ${def.commodity} di inventaris (punya ${stock?.qty || 0}).`), { status: 400 });
      const took = await t.run('UPDATE inventory SET qty = qty - ? WHERE id = ? AND qty >= ?', [needCom, stock.id, needCom]);
      if (!took.changes) throw Object.assign(new Error(`Butuh ${needCom}× ${def.commodity} di inventaris.`), { status: 400 });
      const paid = await t.run('UPDATE citizens SET usd = usd - ? WHERE id = ? AND usd >= ?', [costUsd, locked.id, costUsd]);
      if (!paid.changes) throw Object.assign(new Error(`Butuh ${fmtRp(costUsd)} untuk merekrut ${q}× ${def.name}.`), { status: 400 });
      await t.run(
        'INSERT INTO military_units (citizen_id, unit_type, qty, created_at) VALUES (?,?,?,?) ON CONFLICT (citizen_id, unit_type) DO UPDATE SET qty = military_units.qty + excluded.qty',
        [locked.id, type, q, Date.now()]);
      return { costUsd, commodity: def.commodity, commodityQty: needCom };
    });
    const units = await militaryUnitsOf(req.citizen.id);
    const power = militaryPowerFor(units);
    res.json({
      ok: true, ...result, units, power,
      mult: Math.round(unitDamageMult(power) * 100) / 100,
      upkeep: unitUpkeepFor(units),
      count: unitCountFor(units),
      cap: unitCapFor(req.citizen.level),
    });
  }));

  // Bubarkan unit (tanpa pengembalian dana/barang — keputusan permanen).
  app.post('/api/military/disband', authRequired, citizenRequired, r(async (req, res) => {
    const { type, qty } = req.body || {};
    const def = MILITARY_UNITS[type];
    if (!def) return res.status(400).json({ error: 'Jenis unit tidak dikenal.' });
    const q = Math.floor(Number(qty) || 0);
    if (q < 1) return res.status(400).json({ error: 'Jumlah minimal 1 unit.' });
    await tx(async (t) => {
      const row = await t.one(forUpdate('SELECT * FROM military_units WHERE citizen_id = ? AND unit_type = ?'), [req.citizen.id, type]);
      if (!row || row.qty < q) throw Object.assign(new Error(`Kamu hanya punya ${row?.qty || 0}× ${def.name}.`), { status: 400 });
      if (row.qty === q) await t.run('DELETE FROM military_units WHERE id = ?', [row.id]);
      else await t.run('UPDATE military_units SET qty = qty - ? WHERE id = ? AND qty >= ?', [q, row.id, q]);
    });
    const units = await militaryUnitsOf(req.citizen.id);
    const power = militaryPowerFor(units);
    res.json({
      ok: true, units, power,
      mult: Math.round(unitDamageMult(power) * 100) / 100,
      upkeep: unitUpkeepFor(units),
      count: unitCountFor(units),
      cap: unitCapFor(req.citizen.level),
    });
  }));
}
