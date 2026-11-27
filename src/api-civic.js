// API kewargaan Parlementer: negara, partai, parlemen, pemilu, perang, pers, chat, DM.
import { sql, one, run, tx, forUpdate } from './db.js';
import { authRequired, citizenRequired, loadCitizen, todayStr } from './util.js';
import { warDamage, CHRONICLE } from './game.js';

const CHAT_ROOMS = ['global', 'indonesia', 'negara'];

// Kirim notifikasi ke satu warga (dipakai juga oleh sistem banding).
export async function notify(citizenId, category, title, content = '') {
  await run('INSERT INTO notifications (citizen_id, category, title, content, created_at) VALUES (?,?,?,?,?) RETURNING id',
    [citizenId, category, title, content, Date.now()]);
}

export function registerCivic(app) {
  const r = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  async function chronicleDone(citizen, key) {
    const done = JSON.parse(citizen.chronicle_done || '[]');
    if (!done.includes(key)) {
      done.push(key);
      await run('UPDATE citizens SET chronicle_done = ? WHERE id = ?', [JSON.stringify(done), citizen.id]);
    }
  }
  function partyTag(citizen) { return citizen.party_tag || null; }

  // ---------- NEGARA ----------
  app.get('/api/country', authRequired, citizenRequired, r(async (req, res) => {
    const country = await one('SELECT * FROM country WHERE id = 1');
    const stats = await one('SELECT COUNT(*) AS citizens FROM citizens');
    const parties = await one('SELECT COUNT(*) AS n FROM parties');
    const regions = await one('SELECT COUNT(*) AS n FROM regions');
    const seats = await one('SELECT COALESCE(SUM(seats),0) AS n FROM parties');
    const president = country.president_id
      ? await one('SELECT u.username FROM citizens c JOIN users u ON u.id = c.user_id WHERE c.id = ?', [country.president_id]) : null;
    const ministers = {};
    for (const [key, col] of [['economy', 'minister_economy'], ['foreign', 'minister_foreign'], ['home', 'minister_home'], ['defense', 'minister_defense']]) {
      const id = country[col];
      ministers[key] = id ? (await one('SELECT u.username FROM citizens c JOIN users u ON u.id = c.user_id WHERE c.id = ?', [id]))?.username || 'Kosong' : 'Kosong';
    }
    const capitalSupport = await one("SELECT COUNT(*) AS n FROM war_support WHERE region_id = (SELECT id FROM regions WHERE name = 'Jakarta')");
    const wars = await sql("SELECT w.*, r.name AS region_name FROM wars w JOIN regions r ON r.id = w.region_id WHERE w.status = 'active'");
    res.json({
      country, president: president?.username || 'Kosong', ministers,
      citizens: Number(stats.citizens), parties: Number(parties.n), regions: Number(regions.n),
      seats: Number(seats.n), capitalRebellion: Number(capitalSupport.n), wars,
    });
  }));

  app.post('/api/country/appoint', authRequired, citizenRequired, r(async (req, res) => {
    const { role, citizen_id } = req.body || {};
    const country = await one('SELECT * FROM country WHERE id = 1');
    if (country.president_id !== req.citizen.id) return res.status(403).json({ error: 'Hanya Presiden yang bisa mengangkat menteri.' });
    const col = { economy: 'minister_economy', foreign: 'minister_foreign', home: 'minister_home', defense: 'minister_defense' }[role];
    if (!col) return res.status(400).json({ error: 'Jabatan tidak dikenal.' });
    const target = await one('SELECT id FROM citizens WHERE id = ?', [citizen_id]);
    if (!target) return res.status(404).json({ error: 'Warga tidak ditemukan.' });
    await run(`UPDATE country SET ${col} = ? WHERE id = 1`, [citizen_id]);
    await notify(citizen_id, 'POLITIK', 'Kamu diangkat jadi menteri', `Presiden mengangkatmu sebagai menteri (${role}).`);
    res.json({ ok: true });
  }));

  // ---------- PARTAI ----------
  app.get('/api/parties', authRequired, citizenRequired, r(async (req, res) => {
    const rows = await sql(
      `SELECT p.*, u.username AS leader_name,
        (SELECT COUNT(*) FROM party_members WHERE party_id = p.id) AS members
       FROM parties p JOIN citizens c ON c.id = p.leader_id JOIN users u ON u.id = c.user_id
       ORDER BY p.seats DESC, members DESC`);
    const mine = req.citizen.party_id
      ? await one('SELECT p.*, u.username AS leader_name FROM parties p JOIN citizens c ON c.id = p.leader_id JOIN users u ON u.id = c.user_id WHERE p.id = ?', [req.citizen.party_id])
      : null;
    const pending = mine ? await sql(
      `SELECT pm.*, u.username FROM party_members pm JOIN citizens c ON c.id = pm.citizen_id JOIN users u ON u.id = c.user_id
       WHERE pm.party_id = ? AND pm.role = 'pending'`, [mine.id]) : [];
    res.json({ parties: rows, mine, pending });
  }));

  app.post('/api/parties', authRequired, citizenRequired, r(async (req, res) => {
    const { name, tag, ideology, type } = req.body || {};
    const c = req.citizen;
    if (c.level < 10) return res.status(400).json({ error: 'Mendirikan partai butuh Level 10.' });
    if (!name || name.length < 3 || name.length > 40) return res.status(400).json({ error: 'Nama partai 3–40 karakter.' });
    if (!tag || !/^[A-Z0-9]{2,6}$/.test(tag)) return res.status(400).json({ error: 'Singkatan partai 2–6 huruf kapital/angka.' });
    const taken = await one('SELECT id FROM parties WHERE name = ? OR tag = ?', [name, tag]);
    if (taken) return res.status(400).json({ error: 'Nama atau singkatan partai sudah dipakai.' });
    // Atomik: kunci baris warga + potong 50 emas bersyarat di dalam tx.
    const partyId = await tx(async (t) => {
      await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [c.id]);
      const p = await t.run(
        'INSERT INTO parties (name, tag, ideology, leader_id, type, seats, created_at) VALUES (?,?,?,?,?,0,?) RETURNING id',
        [name, tag, ['Progresif', 'Konservatif', 'Sosialis'].includes(ideology) ? ideology : 'Konservatif', c.id, ['open', 'application', 'closed'].includes(type) ? type : 'open', Date.now()]);
      await t.run('INSERT INTO party_members (party_id, citizen_id, role, joined_at) VALUES (?,?,?,?) RETURNING party_id', [p.id, c.id, 'leader', Date.now()]);
      const upd = await t.run('UPDATE citizens SET gold = gold - 50, party_id = ? WHERE id = ? AND gold >= 50', [p.id, c.id]);
      if (!upd.changes) throw Object.assign(new Error('Mendirikan partai butuh 50 emas.'), { status: 400 });
      return p.id;
    });
    await chronicleDone(c, 'party');
    res.json({ ok: true, partyId });
  }));

  app.post('/api/parties/:id/join', authRequired, citizenRequired, r(async (req, res) => {
    const p = await one('SELECT * FROM parties WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Partai tidak ditemukan.' });
    const c = req.citizen;
    if (c.party_id) return res.status(400).json({ error: 'Kamu sudah berpartai. Keluar dulu dari partaimu.' });
    if (p.type === 'closed') return res.status(400).json({ error: 'Partai ini tertutup, tidak menerima anggota.' });
    const role = p.type === 'application' ? 'pending' : 'member';
    // Atomik: kunci baris warga + cek ulang party_id di dalam tx, lalu
    // INSERT ... ON CONFLICT DO NOTHING — dua join paralel (ke partai yang
    // sama atau berbeda) hanya satu yang berhasil.
    const joined = await tx(async (t) => {
      const locked = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [c.id]);
      if (locked.party_id) throw Object.assign(new Error('Kamu sudah berpartai. Keluar dulu dari partaimu.'), { status: 400 });
      const ins = await t.run('INSERT INTO party_members (party_id, citizen_id, role, joined_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING RETURNING party_id', [p.id, c.id, role, Date.now()]);
      if (!ins.changes) throw Object.assign(new Error('Kamu sudah menjadi anggota partai ini.'), { status: 400 });
      if (role === 'member') await t.run('UPDATE citizens SET party_id = ? WHERE id = ?', [p.id, c.id]);
      return true;
    });
    if (joined) await chronicleDone(c, 'party');
    res.json({ ok: true, role });
  }));

  app.post('/api/parties/:id/approve', authRequired, citizenRequired, r(async (req, res) => {
    const p = await one('SELECT * FROM parties WHERE id = ?', [req.params.id]);
    if (!p || p.leader_id !== req.citizen.id) return res.status(403).json({ error: 'Hanya ketua partai yang bisa menyetujui lamaran.' });
    const { citizen_id } = req.body || {};
    const m = await one("SELECT * FROM party_members WHERE party_id = ? AND citizen_id = ? AND role = 'pending'", [p.id, citizen_id]);
    if (!m) return res.status(404).json({ error: 'Lamaran tidak ditemukan.' });
    await run("UPDATE party_members SET role = 'member' WHERE party_id = ? AND citizen_id = ?", [p.id, citizen_id]);
    await run('UPDATE citizens SET party_id = ? WHERE id = ?', [p.id, citizen_id]);
    res.json({ ok: true });
  }));

  app.post('/api/parties/:id/leave', authRequired, citizenRequired, r(async (req, res) => {
    const p = await one('SELECT * FROM parties WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Partai tidak ditemukan.' });
    if (p.leader_id === req.citizen.id) return res.status(400).json({ error: 'Ketua partai tidak bisa keluar. Bubarkan partai atau serahkan kepemimpinan dulu.' });
    await run('DELETE FROM party_members WHERE party_id = ? AND citizen_id = ?', [p.id, req.citizen.id]);
    await run('UPDATE citizens SET party_id = NULL WHERE id = ?', [req.citizen.id]);
    res.json({ ok: true });
  }));

  // ---------- PARLEMEN ----------
  app.get('/api/parliament', authRequired, citizenRequired, r(async (req, res) => {
    const c = req.citizen;
    const seats = await one('SELECT COALESCE(SUM(seats),0) AS n FROM parties');
    const myParty = c.party_id ? await one('SELECT seats FROM parties WHERE id = ?', [c.party_id]) : null;
    const isMp = !!(myParty && myParty.seats > 0);
    const laws = await sql(
      `SELECT l.*, u.username AS proposer_name FROM laws l
       JOIN citizens cc ON cc.id = l.proposer_id JOIN users u ON u.id = cc.user_id
       ORDER BY l.created_at DESC LIMIT 20`);
    const myVotes = await sql('SELECT law_id, vote FROM law_votes WHERE citizen_id = ?', [c.id]);
    res.json({
      totalSeats: 60, filledSeats: Number(seats.n), majority: 31, isMp,
      laws, myVotes: Object.fromEntries(myVotes.map((v) => [v.law_id, v.vote])),
    });
  }));

  app.post('/api/parliament/law', authRequired, citizenRequired, r(async (req, res) => {
    const { title, content } = req.body || {};
    const c = req.citizen;
    if (c.level < 5) return res.status(400).json({ error: 'Mengusulkan UU butuh Level 5.' });
    if (!title || title.length < 5 || title.length > 120) return res.status(400).json({ error: 'Judul UU 5–120 karakter.' });
    if (!content || content.length < 10) return res.status(400).json({ error: 'Isi UU minimal 10 karakter.' });
    // Atomik: kunci baris warga + potong 5 emas bersyarat di dalam tx.
    const lawId = await tx(async (t) => {
      await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [c.id]);
      const law = await t.run(
        'INSERT INTO laws (proposer_id, title, content, status, ends_at, created_at) VALUES (?,?,?,\'voting\',?,?) RETURNING id',
        [c.id, title, content, Date.now() + 7 * 24 * 60 * 60 * 1000, Date.now()]);
      const upd = await t.run('UPDATE citizens SET gold = gold - 5, laws_proposed = laws_proposed + 1 WHERE id = ? AND gold >= 5', [c.id]);
      if (!upd.changes) throw Object.assign(new Error('Biaya notaris pengusulan UU: 5 emas.'), { status: 400 });
      return law.id;
    });
    await chronicleDone(c, 'law');
    res.json({ ok: true, lawId });
  }));

  app.post('/api/parliament/vote', authRequired, citizenRequired, r(async (req, res) => {
    const { law_id, vote } = req.body || {};
    if (!['yes', 'abstain', 'no'].includes(vote)) return res.status(400).json({ error: 'Pilihan suara tidak dikenal.' });
    const c = req.citizen;
    const myParty = c.party_id ? await one('SELECT seats FROM parties WHERE id = ?', [c.party_id]) : null;
    if (!myParty || myParty.seats <= 0) return res.status(403).json({ error: 'Hanya anggota parlemen yang bisa memilih. Partaimu belum punya kursi.' });
    const law = await one("SELECT * FROM laws WHERE id = ? AND status = 'voting' AND ends_at > ?", [law_id, Date.now()]);
    if (!law) return res.status(404).json({ error: 'UU tidak ditemukan / voting sudah ditutup.' });
    // Atomik: INSERT ... ON CONFLICT DO NOTHING + hitung suara di dalam tx —
    // dua vote paralel hanya satu yang terhitung.
    const col = vote === 'yes' ? 'yes' : vote === 'abstain' ? 'abstain' : 'no';
    await tx(async (t) => {
      const ins = await t.run('INSERT INTO law_votes (law_id, citizen_id, vote) VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING law_id', [law.id, c.id, vote]);
      if (!ins.changes) throw Object.assign(new Error('Kamu sudah memilih untuk UU ini.'), { status: 400 });
      await t.run(`UPDATE laws SET ${col} = ${col} + 1 WHERE id = ?`, [law.id]);
    });
    await chronicleDone(c, 'vote');
    res.json({ ok: true });
  }));

  // ---------- PEMILU ----------
  app.get('/api/elections', authRequired, citizenRequired, r(async (req, res) => {
    const current = await sql('SELECT * FROM elections ORDER BY created_at DESC LIMIT 5');
    const out = [];
    for (const e of current) {
      const cands = await sql(
        `SELECT ec.*, u.username, p.name AS party_name, p.tag AS party_tag FROM election_candidates ec
         JOIN citizens c ON c.id = ec.citizen_id JOIN users u ON u.id = c.user_id
         LEFT JOIN parties p ON p.id = ec.party_id WHERE ec.election_id = ? ORDER BY ec.votes DESC`,
        [e.id]);
      const myVote = await one('SELECT * FROM election_votes WHERE election_id = ? AND citizen_id = ?', [e.id, req.citizen.id]);
      const winner = e.winner_id ? await one('SELECT u.username FROM citizens c JOIN users u ON u.id = c.user_id WHERE c.id = ?', [e.winner_id]) : null;
      out.push({ ...e, candidates: cands, myVote: myVote || null, winner: winner?.username || null });
    }
    const canVote = req.citizen.level >= 5 && (Date.now() - req.citizen.created_at) >= 3 * 24 * 60 * 60 * 1000;
    res.json({ elections: out, canVote });
  }));

  app.post('/api/elections/:id/register', authRequired, citizenRequired, r(async (req, res) => {
    const e = await one("SELECT * FROM elections WHERE id = ? AND status = 'open' AND type = 'president'", [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Pemilu presiden yang sedang dibuka tidak ditemukan.' });
    const c = req.citizen;
    if (!c.party_id) return res.status(400).json({ error: 'Hanya ketua partai yang bisa mencalonkan diri.' });
    const party = await one('SELECT * FROM parties WHERE id = ?', [c.party_id]);
    if (party.leader_id !== c.id) return res.status(400).json({ error: 'Hanya ketua partai yang bisa mencalonkan diri.' });
    const existing = await one('SELECT * FROM election_candidates WHERE election_id = ? AND citizen_id = ?', [e.id, c.id]);
    if (existing) return res.status(400).json({ error: 'Kamu sudah terdaftar sebagai kandidat.' });
    await run('INSERT INTO election_candidates (election_id, citizen_id, party_id, votes) VALUES (?,?,?,0) RETURNING election_id', [e.id, c.id, party.id]);
    res.json({ ok: true });
  }));

  app.post('/api/elections/:id/vote', authRequired, citizenRequired, r(async (req, res) => {
    const { candidate_id } = req.body || {};
    const e = await one("SELECT * FROM elections WHERE id = ? AND status = 'open'", [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Pemilu yang sedang dibuka tidak ditemukan.' });
    const c = req.citizen;
    if (c.level < 5) return res.status(400).json({ error: 'Hak pilih mulai Level 5.' });
    if (Date.now() - c.created_at < 3 * 24 * 60 * 60 * 1000) return res.status(400).json({ error: 'Warga baru bisa memilih setelah 3 hari menjadi warga.' });
    const cand = await one('SELECT * FROM election_candidates WHERE election_id = ? AND citizen_id = ?', [e.id, candidate_id]);
    if (!cand) return res.status(404).json({ error: 'Kandidat tidak ditemukan.' });
    // Atomik: INSERT ... ON CONFLICT DO NOTHING + hitung suara di dalam tx.
    await tx(async (t) => {
      const ins = await t.run('INSERT INTO election_votes (election_id, citizen_id, candidate_id) VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING election_id', [e.id, c.id, candidate_id]);
      if (!ins.changes) throw Object.assign(new Error('Kamu sudah memilih di pemilu ini.'), { status: 400 });
      await t.run('UPDATE election_candidates SET votes = votes + 1 WHERE election_id = ? AND citizen_id = ?', [e.id, candidate_id]);
    });
    await chronicleDone(c, 'vote');
    res.json({ ok: true });
  }));

  // ---------- PERANG ----------
  app.get('/api/wars', authRequired, citizenRequired, r(async (req, res) => {
    const wars = await sql(
      `SELECT w.*, r.name AS region_name FROM wars w JOIN regions r ON r.id = w.region_id ORDER BY w.created_at DESC LIMIT 20`);
    res.json({ wars });
  }));

  app.get('/api/wars/:id', authRequired, citizenRequired, r(async (req, res) => {
    const war = await one(
      `SELECT w.*, r.name AS region_name FROM wars w JOIN regions r ON r.id = w.region_id WHERE w.id = ?`,
      [req.params.id]);
    if (!war) return res.status(404).json({ error: 'Perang tidak ditemukan.' });
    const fighters = await sql(
      `SELECT wa.citizen_id, u.username, wa.side, SUM(wa.damage) AS damage, COUNT(*) AS attacks
       FROM war_attacks wa JOIN citizens c ON c.id = wa.citizen_id JOIN users u ON u.id = c.user_id
       WHERE wa.war_id = ? GROUP BY wa.citizen_id, u.username, wa.side ORDER BY damage DESC LIMIT 20`,
      [war.id]);
    const feed = await sql(
      `SELECT wa.*, u.username FROM war_attacks wa JOIN citizens c ON c.id = wa.citizen_id JOIN users u ON u.id = c.user_id
       WHERE wa.war_id = ? ORDER BY wa.created_at DESC LIMIT 30`,
      [war.id]);
    const totals = await one('SELECT COUNT(*) AS attacks, COALESCE(SUM(damage),0) AS damage FROM war_attacks WHERE war_id = ?', [war.id]);
    const atFront = req.citizen.region_id === war.region_id;
    res.json({ war, fighters, feed, totals, atFront, myRegion: req.citizen.region_id });
  }));

  app.post('/api/wars/:id/attack', authRequired, citizenRequired, r(async (req, res) => {
    const { side, ammo } = req.body || {};
    const war = await one("SELECT * FROM wars WHERE id = ? AND status = 'active'", [req.params.id]);
    if (!war) return res.status(404).json({ error: 'Tidak ada perang aktif di sini.' });
    if (!['attacker', 'defender'].includes(side)) return res.status(400).json({ error: 'Pilih pihak: penyerang atau pembela.' });
    const c = await loadCitizen(req.userId);
    if (c.region_id !== war.region_id) return res.status(400).json({ error: 'Kamu harus berada di wilayah perang untuk menyerang dari garis depan.' });
    const useAmmo = ammo === 'Drone' ? 'Drone' : 'Senjata';
    const com = await one('SELECT id FROM commodities WHERE name = ?', [useAmmo]);
    const damage = warDamage(c.attr_str, useAmmo);
    // Atomik: kunci baris warga, baca amunisi segar di dalam tx, potong
    // energi + amunisi + catat serangan + update skor + progres misi — semua
    // dari nilai yang dikunci (dulu misi dihitung dari objek basi di luar tx).
    await tx(async (t) => {
      const locked = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [c.id]);
      if (locked.energy < 10) throw Object.assign(new Error('Butuh 10 energi untuk menyerang.'), { status: 400 });
      const hasAmmo = await t.one(forUpdate('SELECT * FROM inventory WHERE citizen_id = ? AND commodity_id = ? AND qty > 0 ORDER BY tier ASC'), [locked.id, com.id]);
      if (!hasAmmo) throw Object.assign(new Error(`Tidak ada ${useAmmo} di inventaris.`), { status: 400 });
      const upd = await t.run('UPDATE citizens SET energy = energy - 10, energy_spent_today = energy_spent_today + 10, total_damage = total_damage + ?, attacks = attacks + 1, frontline_attacks = frontline_attacks + 1 WHERE id = ? AND energy >= 10',
        [damage, locked.id]);
      if (!upd.changes) throw Object.assign(new Error('Butuh 10 energi untuk menyerang.'), { status: 400 });
      if (hasAmmo.qty === 1) await t.run('DELETE FROM inventory WHERE id = ?', [hasAmmo.id]);
      else await t.run('UPDATE inventory SET qty = qty - 1 WHERE id = ?', [hasAmmo.id]);
      await t.run('INSERT INTO war_attacks (war_id, citizen_id, side, damage, ammo, created_at) VALUES (?,?,?,?,?,?) RETURNING id',
        [war.id, locked.id, side, damage, useAmmo, Date.now()]);
      const col = side === 'attacker' ? 'score_a' : 'score_d';
      await t.run(`UPDATE wars SET ${col} = ${col} + ? WHERE id = ?`, [damage, war.id]);
      const m = JSON.parse(locked.missions || '{}');
      m.energy = Math.min(500, (locked.energy_spent_today || 0) + 10);
      await t.run('UPDATE citizens SET missions = ? WHERE id = ?', [JSON.stringify(m), locked.id]);
    });
    await chronicleDone(c, 'attack');
    res.json({ ok: true, damage });
  }));

  // ---------- PERS ----------
  app.get('/api/press/stats', authRequired, citizenRequired, r(async (req, res) => {
    const since7 = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const a = await one('SELECT COUNT(*) AS articles, COALESCE(SUM(views),0) AS views, COALESCE(SUM(likes),0) AS likes, COALESCE(SUM(dislikes),0) AS dislikes FROM articles WHERE created_at > ?', [since7]);
    const j = await one('SELECT COUNT(DISTINCT author_id) AS n FROM articles WHERE created_at > ?', [since7]);
    const n = await one('SELECT COUNT(*) AS n FROM newspapers');
    const cm = await one('SELECT COUNT(*) AS n FROM article_comments WHERE created_at > ?', [since7]);
    res.json({
      articles7d: Number(a.articles), reads7d: Number(a.views), reactions7d: Number(a.likes) + Number(a.dislikes),
      journalists7d: Number(j.n), newspapers: Number(n.n), comments7d: Number(cm.n),
    });
  }));

  app.get('/api/press/articles', authRequired, citizenRequired, r(async (req, res) => {
    const { sort = 'new', topic } = req.query;
    let order = 'a.created_at DESC';
    if (sort === 'top_day') order = 'a.likes DESC, a.views DESC';
    if (sort === 'top_week' || sort === 'top_month') order = '(a.likes * 3 + a.views) DESC';
    let where = '1=1';
    const params = [];
    if (topic) { where += ' AND a.topic = ?'; params.push(topic); }
    if (sort === 'top_day') { where += ' AND a.created_at > ?'; params.push(Date.now() - 24 * 60 * 60 * 1000); }
    if (sort === 'top_week') { where += ' AND a.created_at > ?'; params.push(Date.now() - 7 * 24 * 60 * 60 * 1000); }
    if (sort === 'top_month') { where += ' AND a.created_at > ?'; params.push(Date.now() - 30 * 24 * 60 * 60 * 1000); }
    const rows = await sql(
      `SELECT a.*, u.username AS author_name, n.name AS newspaper_name,
        (SELECT COUNT(*) FROM article_comments WHERE article_id = a.id) AS comments
       FROM articles a JOIN users u ON u.id = (SELECT user_id FROM citizens WHERE id = a.author_id)
       JOIN newspapers n ON n.id = a.newspaper_id WHERE ${where} ORDER BY ${order} LIMIT 30`,
      params);
    res.json({ articles: rows });
  }));

  app.get('/api/press/articles/:id', authRequired, citizenRequired, r(async (req, res) => {
    const a = await one(
      `SELECT a.*, u.username AS author_name, n.name AS newspaper_name FROM articles a
       JOIN users u ON u.id = (SELECT user_id FROM citizens WHERE id = a.author_id)
       JOIN newspapers n ON n.id = a.newspaper_id WHERE a.id = ?`,
      [req.params.id]);
    if (!a) return res.status(404).json({ error: 'Artikel tidak ditemukan.' });
    await run('UPDATE articles SET views = views + 1 WHERE id = ?', [a.id]);
    const comments = await sql(
      `SELECT ac.*, u.username FROM article_comments ac JOIN citizens c ON c.id = ac.citizen_id JOIN users u ON u.id = c.user_id
       WHERE ac.article_id = ? ORDER BY ac.created_at ASC`, [a.id]);
    const myReaction = await one('SELECT reaction FROM article_reactions WHERE article_id = ? AND citizen_id = ?', [a.id, req.citizen.id]);
    const others = await sql(
      `SELECT a2.id, a2.title, a2.created_at, a2.likes, a2.views FROM articles a2 WHERE a2.newspaper_id = ? AND a2.id != ? ORDER BY a2.created_at DESC LIMIT 5`,
      [a.newspaper_id, a.id]);
    res.json({ article: { ...a, views: a.views + 1 }, comments, myReaction: myReaction?.reaction || null, others });
  }));

  app.get('/api/press/newspapers/mine', authRequired, citizenRequired, r(async (req, res) => {
    const rows = await sql('SELECT * FROM newspapers WHERE owner_id = ? ORDER BY created_at DESC', [req.citizen.id]);
    res.json({ newspapers: rows });
  }));

  app.post('/api/press/newspaper', authRequired, citizenRequired, r(async (req, res) => {
    const { name } = req.body || {};
    if (!name || name.length < 3 || name.length > 50) return res.status(400).json({ error: 'Nama koran 3–50 karakter.' });
    // Atomik: kunci baris warga + potong 5 emas bersyarat di dalam tx.
    const newspaperId = await tx(async (t) => {
      await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      const n = await t.run('INSERT INTO newspapers (owner_id, name, created_at) VALUES (?,?,?) RETURNING id', [req.citizen.id, name, Date.now()]);
      const upd = await t.run('UPDATE citizens SET gold = gold - 5 WHERE id = ? AND gold >= 5', [req.citizen.id]);
      if (!upd.changes) throw Object.assign(new Error('Mendirikan koran butuh 5 emas.'), { status: 400 });
      return n.id;
    });
    res.json({ ok: true, newspaperId });
  }));

  app.post('/api/press/articles', authRequired, citizenRequired, r(async (req, res) => {
    const { newspaper_id, title, content, topic } = req.body || {};
    const np = await one('SELECT * FROM newspapers WHERE id = ? AND owner_id = ?', [newspaper_id, req.citizen.id]);
    if (!np) return res.status(403).json({ error: 'Kamu hanya bisa menulis di koranmu sendiri.' });
    if (!title || title.length < 5 || title.length > 120) return res.status(400).json({ error: 'Judul 5–120 karakter.' });
    if (!content || content.length < 20) return res.status(400).json({ error: 'Isi artikel minimal 20 karakter.' });
    const topics = ['Perang', 'Ekonomi', 'Politik', 'Diplomasi', 'Panduan', 'Pengumuman'];
    const a = await run(
      'INSERT INTO articles (newspaper_id, author_id, title, content, topic, created_at) VALUES (?,?,?,?,?,?) RETURNING id',
      [np.id, req.citizen.id, title, content, topics.includes(topic) ? topic : 'Pengumuman', Date.now()]);
    await chronicleDone(req.citizen, 'article');
    res.json({ ok: true, articleId: a.id });
  }));

  app.post('/api/press/articles/:id/react', authRequired, citizenRequired, r(async (req, res) => {
    const { reaction } = req.body || {};
    if (!['like', 'dislike'].includes(reaction)) return res.status(400).json({ error: 'Reaksi tidak dikenal.' });
    // Atomik: kunci baris artikel, baca reaksi yang ada di dalam tx, lalu
    // ubah reaksi + penghitung sekaligus — dua klik paralel tidak bisa
    // menggandakan hitungan.
    let result = reaction;
    await tx(async (t) => {
      const a = await t.one(forUpdate('SELECT * FROM articles WHERE id = ?'), [req.params.id]);
      if (!a) throw Object.assign(new Error('Artikel tidak ditemukan.'), { status: 404 });
      const existing = await t.one('SELECT * FROM article_reactions WHERE article_id = ? AND citizen_id = ?', [a.id, req.citizen.id]);
      if (existing?.reaction === reaction) {
        await t.run('DELETE FROM article_reactions WHERE article_id = ? AND citizen_id = ?', [a.id, req.citizen.id]);
        await t.run(`UPDATE articles SET ${reaction === 'like' ? 'likes' : 'dislikes'} = ${reaction === 'like' ? 'likes' : 'dislikes'} - 1 WHERE id = ?`, [a.id]);
        result = null;
        return;
      }
      if (existing) {
        await t.run('UPDATE article_reactions SET reaction = ? WHERE article_id = ? AND citizen_id = ?', [reaction, a.id, req.citizen.id]);
        await t.run(`UPDATE articles SET likes = likes + ?, dislikes = dislikes + ? WHERE id = ?`,
          [reaction === 'like' ? 1 : -1, reaction === 'dislike' ? 1 : -1, a.id]);
      } else {
        await t.run('INSERT INTO article_reactions (article_id, citizen_id, reaction) VALUES (?,?,?) RETURNING article_id', [a.id, req.citizen.id, reaction]);
        await t.run(`UPDATE articles SET ${reaction === 'like' ? 'likes' : 'dislikes'} = ${reaction === 'like' ? 'likes' : 'dislikes'} + 1 WHERE id = ?`, [a.id]);
      }
    });
    res.json({ ok: true, reaction: result });
  }));

  app.post('/api/press/articles/:id/comment', authRequired, citizenRequired, r(async (req, res) => {
    const { content } = req.body || {};
    if (!content || content.trim().length < 1 || content.length > 500) return res.status(400).json({ error: 'Komentar 1–500 karakter.' });
    const a = await one('SELECT id FROM articles WHERE id = ?', [req.params.id]);
    if (!a) return res.status(404).json({ error: 'Artikel tidak ditemukan.' });
    const cm = await run('INSERT INTO article_comments (article_id, citizen_id, content, created_at) VALUES (?,?,?,?) RETURNING id',
      [a.id, req.citizen.id, content.trim(), Date.now()]);
    res.json({ ok: true, commentId: cm.id });
  }));

  app.get('/api/press/league', authRequired, citizenRequired, r(async (req, res) => {
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const papers = await sql(
      `SELECT n.id, n.name, COALESCE(SUM(a.likes - a.dislikes),0) * 3 + COALESCE(SUM(a.views),0) AS score,
        COALESCE(SUM(a.likes),0) AS likes, COALESCE(SUM(a.views),0) AS views
       FROM newspapers n LEFT JOIN articles a ON a.newspaper_id = n.id AND a.created_at > ?
       GROUP BY n.id, n.name ORDER BY score DESC LIMIT 10`, [since]);
    const journalists = await sql(
      `SELECT u.username, COALESCE(SUM(a.likes - a.dislikes),0) * 3 + COALESCE(SUM(a.views),0) AS score
       FROM articles a JOIN citizens c ON c.id = a.author_id JOIN users u ON u.id = c.user_id
       WHERE a.created_at > ? GROUP BY u.username ORDER BY score DESC LIMIT 10`, [since]);
    res.json({ papers, journalists });
  }));

  // ---------- CHAT ----------
  function roomTitle(room) {
    if (room === 'global') return 'OBROLAN GLOBAL';
    if (room === 'indonesia') return 'OBROLAN INDONESIA';
    if (room === 'negara') return 'OBROLAN NEGARA';
    if (room === 'parliament') return 'RUANG SIDANG';
    if (room.startsWith('war_')) return 'PERTEMPURAN';
    if (room.startsWith('party_')) return 'OBROLAN PARTAI';
    return 'OBROLAN';
  }

  app.get('/api/chat/:room', authRequired, citizenRequired, r(async (req, res) => {
    const room = req.params.room;
    const since = Number(req.query.since || 0);
    const blocked = await sql('SELECT blocked_id FROM blocked WHERE blocker_id = ?', [req.citizen.id]);
    const blockedSet = new Set(blocked.map((b) => b.blocked_id));
    const rows = await sql(
      `SELECT m.*, u.username, u.avatar, u.premium_until, p.tag AS party_tag,
        (SELECT COUNT(*) FROM article_comments WHERE article_id = m.article_id) AS article_comments,
        (SELECT title FROM articles WHERE id = m.article_id) AS article_title,
        (SELECT likes FROM articles WHERE id = m.article_id) AS article_likes
       FROM chat_messages m JOIN citizens c ON c.id = m.citizen_id JOIN users u ON u.id = c.user_id
       LEFT JOIN parties p ON p.id = c.party_id
       WHERE m.room = ? AND m.created_at > ? ORDER BY m.created_at ASC LIMIT 100`,
      [room, since]);
    const visible = rows.filter((m) => !blockedSet.has(m.citizen_id));
    res.json({ room, title: roomTitle(room), messages: visible.map((m) => ({ ...m, isPremium: m.premium_until > Date.now() })) });
  }));

  app.post('/api/chat/report', authRequired, citizenRequired, r(async (req, res) => {
    const { message_id, reason, details } = req.body || {};
    if (!['Pelecehan', 'Ujaran kebencian', 'Spam', 'Lainnya'].includes(reason)) return res.status(400).json({ error: 'Alasan laporan tidak dikenal.' });
    const msg = await one('SELECT id FROM chat_messages WHERE id = ?', [message_id]);
    if (!msg) return res.status(404).json({ error: 'Pesan tidak ditemukan.' });
    await run('INSERT INTO chat_reports (reporter_id, message_id, reason, details, created_at) VALUES (?,?,?,?,?) RETURNING id',
      [req.citizen.id, message_id, reason, (details || '').slice(0, 500), Date.now()]);
    res.json({ ok: true });
  }));

  app.post('/api/chat/block', authRequired, citizenRequired, r(async (req, res) => {
    const { citizen_id } = req.body || {};
    if (citizen_id === req.citizen.id) return res.status(400).json({ error: 'Tidak bisa memblokir diri sendiri.' });
    const target = await one('SELECT id FROM citizens WHERE id = ?', [citizen_id]);
    if (!target) return res.status(404).json({ error: 'Warga tidak ditemukan.' });
    // ON CONFLICT DO NOTHING (BUG-6): memblokir dua kali / dua request
    // paralel tidak lagi error 500 — idempotent, selalu 200.
    await run('INSERT INTO blocked (blocker_id, blocked_id) VALUES (?,?) ON CONFLICT DO NOTHING RETURNING blocker_id', [req.citizen.id, citizen_id]);
    res.json({ ok: true });
  }));

  app.post('/api/chat/unblock', authRequired, citizenRequired, r(async (req, res) => {
    const { citizen_id } = req.body || {};
    await run('DELETE FROM blocked WHERE blocker_id = ? AND blocked_id = ?', [req.citizen.id, citizen_id]);
    res.json({ ok: true });
  }));

  app.post('/api/chat/:room', authRequired, citizenRequired, r(async (req, res) => {
    const room = req.params.room;
    const { content, article_id } = req.body || {};
    const text = (content || '').trim();
    if (!text || text.length > 500) return res.status(400).json({ error: 'Pesan 1–500 karakter.' });
    const c = req.citizen;
    // Ruang sidang: hanya anggota parlemen / menteri / presiden.
    if (room === 'parliament') {
      const myParty = c.party_id ? await one('SELECT seats FROM parties WHERE id = ?', [c.party_id]) : null;
      const country = await one('SELECT * FROM country WHERE id = 1');
      const isOfficial = (myParty && myParty.seats > 0)
        || [country.president_id, country.minister_economy, country.minister_foreign, country.minister_home, country.minister_defense].includes(c.id);
      if (!isOfficial) return res.status(403).json({ error: 'Ruang Sidang hanya untuk anggota parlemen, menteri, dan presiden.' });
    }
    if (room.startsWith('war_')) {
      const war = await one('SELECT * FROM wars WHERE id = ?', [room.slice(4)]);
      if (!war) return res.status(404).json({ error: 'Front perang tidak ditemukan.' });
    }
    if (room.startsWith('party_')) {
      if (c.party_id !== Number(room.slice(6))) return res.status(403).json({ error: 'Kamu bukan anggota partai ini.' });
    }
    // Anti-spam atomik: kunci baris warga, cek jeda 5 detik dari nilai segar,
    // lalu simpan pesan + update last_chat_at di dalam tx yang sama.
    const { msgId, counted } = await tx(async (t) => {
      const locked = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [c.id]);
      if (Date.now() - (locked.last_chat_at || 0) < 5000) throw Object.assign(new Error('Tunggu sebentar sebelum mengirim pesan lagi.'), { status: 400 });
      let articleId = null;
      if (article_id) {
        const a = await t.one('SELECT id FROM articles WHERE id = ?', [article_id]);
        if (a) articleId = a.id;
      }
      const msg = await t.run('INSERT INTO chat_messages (room, citizen_id, content, article_id, created_at) VALUES (?,?,?,?,?) RETURNING id',
        [room, c.id, text, articleId, Date.now()]);
      await t.run('UPDATE citizens SET last_chat_at = ?, chat_today = chat_today + 1 WHERE id = ?', [Date.now(), c.id]);
      // Misi harian: minimal 3 kata, jeda 30 detik sejak pesan terakhir yang dihitung.
      const words = text.split(/\s+/).filter(Boolean).length;
      const m = JSON.parse(locked.missions || '{}');
      const lastCounted = m.last_chat_counted || 0;
      let counted = false;
      if (words >= 3 && Date.now() - lastCounted >= 30000) {
        m.chat = Math.min(5, (m.chat || 0) + 1);
        m.last_chat_counted = Date.now();
        await t.run('UPDATE citizens SET missions = ? WHERE id = ?', [JSON.stringify(m), c.id]);
        counted = true;
      }
      return { msgId: msg.id, counted };
    });
    if (counted) await chronicleDone(c, 'chat5');
    res.json({ ok: true, messageId: msgId });
  }));


  // ---------- PESAN PRIBADI (DM) ----------
  app.get('/api/dms', authRequired, citizenRequired, r(async (req, res) => {
    const rows = await sql(
      `SELECT d.*, u.username AS other_name,
        CASE WHEN d.from_id = ? THEN d.to_id ELSE d.from_id END AS other_id
       FROM dms d JOIN citizens c ON c.id = (CASE WHEN d.from_id = ? THEN d.to_id ELSE d.from_id END)
       JOIN users u ON u.id = c.user_id
       WHERE d.from_id = ? OR d.to_id = ? ORDER BY d.created_at DESC LIMIT 100`,
      [req.citizen.id, req.citizen.id, req.citizen.id, req.citizen.id]);
    const convs = new Map();
    for (const d of rows) {
      if (!convs.has(d.other_id)) {
        const unread = await one('SELECT COUNT(*) AS n FROM dms WHERE from_id = ? AND to_id = ? AND is_read = 0', [d.other_id, req.citizen.id]);
        convs.set(d.other_id, { other_id: d.other_id, other_name: d.other_name, last: d.content, at: d.created_at, unread: Number(unread.n) });
      }
    }
    res.json({ conversations: [...convs.values()] });
  }));

  app.get('/api/dms/:citizenId', authRequired, citizenRequired, r(async (req, res) => {
    const other = Number(req.params.citizenId);
    const rows = await sql(
      `SELECT d.*, u.username AS from_name, u.avatar AS from_avatar FROM dms d JOIN citizens c ON c.id = d.from_id JOIN users u ON u.id = c.user_id
       WHERE (d.from_id = ? AND d.to_id = ?) OR (d.from_id = ? AND d.to_id = ?) ORDER BY d.created_at ASC LIMIT 100`,
      [req.citizen.id, other, other, req.citizen.id]);
    await run('UPDATE dms SET is_read = 1 WHERE from_id = ? AND to_id = ?', [other, req.citizen.id]);
    res.json({ messages: rows });
  }));

  app.post('/api/dms/:citizenId', authRequired, citizenRequired, r(async (req, res) => {
    const other = Number(req.params.citizenId);
    const { content } = req.body || {};
    const text = (content || '').trim();
    if (!text || text.length > 500) return res.status(400).json({ error: 'Pesan 1–500 karakter.' });
    const target = await one('SELECT id FROM citizens WHERE id = ?', [other]);
    if (!target) return res.status(404).json({ error: 'Warga tidak ditemukan.' });
    const m = await run('INSERT INTO dms (from_id, to_id, content, created_at) VALUES (?,?,?,?) RETURNING id',
      [req.citizen.id, other, text, Date.now()]);
    await notify(other, 'SOSIAL', 'Pesan baru', `${req.citizen.username} mengirimimu pesan.`);
    res.json({ ok: true, messageId: m.id });
  }));

  // ---------- ORGANISASI ----------
  app.get('/api/orgs', authRequired, citizenRequired, r(async (req, res) => {
    const rows = await sql(
      `SELECT o.*, u.username AS leader_name,
        (SELECT COUNT(*) FROM org_members WHERE org_id = o.id) AS members
       FROM organizations o JOIN citizens c ON c.id = o.leader_id JOIN users u ON u.id = c.user_id
       ORDER BY members DESC`);
    const mine = await one('SELECT org_id FROM org_members WHERE citizen_id = ?', [req.citizen.id]);
    res.json({ organizations: rows, myOrgId: mine?.org_id || null });
  }));

  app.post('/api/orgs', authRequired, citizenRequired, r(async (req, res) => {
    const { name, tag, type } = req.body || {};
    if (!name || name.length < 3 || name.length > 50) return res.status(400).json({ error: 'Nama organisasi 3–50 karakter.' });
    if (!tag || !/^[A-Z0-9]{2,6}$/.test(tag)) return res.status(400).json({ error: 'Singkatan 2–6 huruf kapital/angka.' });
    // Atomik: kunci baris warga + potong 100 emas bersyarat di dalam tx.
    const orgId = await tx(async (t) => {
      await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      const o = await t.run('INSERT INTO organizations (name, tag, type, leader_id, created_at) VALUES (?,?,?,?,?) RETURNING id',
        [name, tag, type === 'Keamanan' ? 'Keamanan' : 'Kerja Sama', req.citizen.id, Date.now()]);
      await t.run('INSERT INTO org_members (org_id, citizen_id, joined_at) VALUES (?,?,?) RETURNING org_id', [o.id, req.citizen.id, Date.now()]);
      const upd = await t.run('UPDATE citizens SET gold = gold - 100 WHERE id = ? AND gold >= 100', [req.citizen.id]);
      if (!upd.changes) throw Object.assign(new Error('Mendirikan organisasi butuh 100 emas.'), { status: 400 });
      return o.id;
    });
    res.json({ ok: true, orgId });
  }));

  app.post('/api/orgs/:id/join', authRequired, citizenRequired, r(async (req, res) => {
    const o = await one('SELECT id FROM organizations WHERE id = ?', [req.params.id]);
    if (!o) return res.status(404).json({ error: 'Organisasi tidak ditemukan.' });
    // Atomik: kunci baris warga + INSERT ... ON CONFLICT DO NOTHING.
    await tx(async (t) => {
      const locked = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      const mine = await t.one('SELECT org_id FROM org_members WHERE citizen_id = ?', [locked.id]);
      if (mine) throw Object.assign(new Error('Kamu sudah bergabung dengan satu organisasi.'), { status: 400 });
      const ins = await t.run('INSERT INTO org_members (org_id, citizen_id, joined_at) VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING org_id', [o.id, locked.id, Date.now()]);
      if (!ins.changes) throw Object.assign(new Error('Kamu sudah bergabung dengan satu organisasi.'), { status: 400 });
    });
    res.json({ ok: true });
  }));

  app.post('/api/orgs/:id/leave', authRequired, citizenRequired, r(async (req, res) => {
    await run('DELETE FROM org_members WHERE org_id = ? AND citizen_id = ?', [req.params.id, req.citizen.id]);
    res.json({ ok: true });
  }));

  // ---------- MEJA BANTUAN ----------
  app.post('/api/support', authRequired, citizenRequired, r(async (req, res) => {
    const { type, topic, details } = req.body || {};
    if (!['Laporan bug', 'Saran'].includes(type)) return res.status(400).json({ error: 'Jenis tidak dikenal.' });
    if (!details || details.trim().length < 10) return res.status(400).json({ error: 'Jelaskan minimal 10 karakter.' });
    await run('INSERT INTO support_tickets (citizen_id, type, topic, details, created_at) VALUES (?,?,?,?,?) RETURNING id',
      [req.citizen.id, type, topic || 'Hal lain', details.trim().slice(0, 2000), Date.now()]);
    res.json({ ok: true });
  }));
}
