// API Admin Parlementer — hanya untuk akun admin.
// Semua route di sini WAJIB lewat adminOnly: sesi login + is_admin = 1,
// selain itu 403. Tidak ada endpoint promosi admin: satu-satunya cara jadi
// admin adalah mendaftar dengan kode bootstrap ADMIN_BOOTSTRAP_CODE yang
// benar (lihat api-core.js), atau migrasi initDb yang menjaga akun admin
// Khalid yang sudah ada (koboijuniorkhalid@gmail.com).
import { sql, one, run, tx, forUpdate, convoyBuildings } from './db.js';
import { authRequired, publicId, bootstrapActive, fmtRp, creditScoreSettled, todayStr } from './util.js';
import { checkRateLimit } from './rate-limit.js';
import { energyCapFor, CREDIT_DEDUCTION_PROVEN_REPORT, CREDIT_UNBAN_RESET_SCORE, SHARE_GOLD_PER_CLICK } from './game.js';

const PREMIUM_MONTHS = [1, 3, 6, 12];
const DAY_MS = 24 * 60 * 60 * 1000;
const GRANT_ITEMS = ['Makanan', 'Senjata', 'Tiket',
  'Gandum Mentah', 'Besi Mentah', 'Minyak Mentah', 'Kapas Mentah', 'Kayu', 'Batu Bara', 'Tembaga Mentah'];
const MAX_GRANT = 1000000;

// Jenis pemberian tunggal: 'hadiah' (default) atau 'pembelian'.
// Alur yang benar: pemain beli emas/premium di Toko resmi (bayar via
// WhatsApp) → admin memenuhi pembelian itu manual lewat form grant.
// Karena itu notifikasi + log admin WAJIB membedakan keduanya: pembelian
// TIDAK BOLEH berbunyi "hadiah".
function grantKind(body) {
  return body?.kind === 'pembelian' ? 'pembelian' : 'hadiah';
}

export async function adminOnly(req, res, next) {
  const u = await one('SELECT is_admin FROM users WHERE id = ?', [req.userId]);
  if (!u || !u.is_admin) return res.status(403).json({ error: 'Hanya admin yang bisa mengakses ini.' });
  next();
}

async function logAction(t, adminId, targetId, action, detail) {
  await t.run('INSERT INTO admin_actions (admin_id, target_id, action, detail, created_at) VALUES (?,?,?,?,?) RETURNING id',
    [adminId, targetId, action, detail, Date.now()]);
}

async function notifyCitizen(t, citizenId, title, content) {
  await t.run('INSERT INTO notifications (citizen_id, category, title, content, created_at) VALUES (?,?,?,?,?) RETURNING id',
    [citizenId, 'ADMIN', title, content, Date.now()]);
}

async function addItemTx(t, citizenId, commodityId, tier, qty) {
  const row = await t.one('SELECT * FROM inventory WHERE citizen_id = ? AND commodity_id = ? AND tier = ?',
    [citizenId, commodityId, tier]);
  if (row) await t.run('UPDATE inventory SET qty = qty + ? WHERE id = ?', [qty, row.id]);
  else await t.run('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,?,?) RETURNING id',
    [citizenId, commodityId, tier, qty]);
}

function parseTargetId(q) {
  if (!q) return null;
  const s = String(q).trim().toUpperCase();
  const m = s.match(/^PL-?(\d{1,6})$/);
  if (m) return Number(m[1]);
  if (/^\d+$/.test(s)) return Number(s);
  return null;
}

export function registerAdmin(app) {
  const r = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  // adminOnly + rate limit aksi admin (maks 120 POST/jam per admin,
  // DB-backed agar konsisten antar instance serverless). GET tidak dibatasi.
  const admin = async (req, res, next) => {
    try {
      await adminOnly(req, res, () => {});
      if (res.headersSent) return; // adminOnly sudah menolak (403)
    } catch (e) { return next(e); }
    if (req.method === 'POST') {
      try {
        const lim = await checkRateLimit('admin-grant:' + req.userId, 120, 60 * 60 * 1000);
        if (!lim.allowed) return res.status(429).json({ error: 'Terlalu banyak aksi admin. Coba lagi nanti.' });
      } catch (e) {
        console.error('[rate-limit] admin gagal:', e.message);
      }
    }
    next();
  };

  // ---------- STATUS ADMIN ---------- (Tahap 5)
  // Apakah jalan darurat bootstrap (ADMIN_BOOTSTRAP_CODE) aktif. Nilai
  // kode TIDAK PERNAH dikirim — hanya boolean. Sebelumnya status ini hanya
  // terlihat lewat peringatan berisik di log server; kini admin melihatnya
  // di Panel Admin.
  app.get('/api/admin/status', authRequired, admin, r(async (req, res) => {
    res.json({ bootstrapActive: bootstrapActive() });
  }));

  // ---------- DAFTAR PEMAIN ----------
  app.get('/api/admin/players', authRequired, admin, r(async (req, res) => {
    const q = (req.query.q || '').trim();
    const params = [];
    let where = '1=1';
    const targetId = parseTargetId(q);
    if (targetId) { where += ' AND u.id = ?'; params.push(targetId); }
    else if (q) { where += ' AND (u.username LIKE ? OR u.email LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
    const rows = await sql(
      `SELECT u.id, u.username, u.email, u.avatar, u.is_admin, u.is_banned, u.banned_reason,
         u.premium_until, u.created_at, c.level, c.gold, c.usd, c.credit_score
       FROM users u JOIN citizens c ON c.user_id = u.id
       WHERE ${where} ORDER BY u.id ASC LIMIT 100`,
      params);
    // Hitung total di atas LIMIT 100 (bug Khalid 28 Nov 2026: panel Hadiah
    // Massal menampilkan "99 dari 100" padahal populasi 216 — daftar
    // terpotong 100 baris, tapi total/eligible harus menghitung SEMUA
    // pemain yang cocok filter). COUNT(*) di Postgres mengembalikan
    // string → Number() seperti di tempat lain.
    const totalRow = await one(
      `SELECT COUNT(*) AS n FROM users u JOIN citizens c ON c.user_id = u.id WHERE ${where}`,
      params);
    const eligRow = await one(
      `SELECT COUNT(*) AS n FROM users u JOIN citizens c ON c.user_id = u.id WHERE ${where} AND u.is_banned = 0`,
      params);
    res.json({
      total: Number(totalRow.n),
      eligible: Number(eligRow.n),
      players: rows.map((p) => ({
        ...p,
        publicId: publicId(p.id),
        isPremium: p.premium_until > Date.now(),
      })),
    });
  }));

  // ---------- STATISTIK SHARE LINK (v4.6.0) ----------
  // Admin HANYA MELIHAT — tidak ada aksi ubah dari statistik ini.
  // Data dari tabel yang SAMA dengan fitur share (share_clicks) dengan
  // definisi yang SAMA: klik terhitung = gold_given > 0; emas = klik × 10
  // (bukan hitung ulang dengan cara berbeda). Urutan: emas total
  // terbanyak dulu (lalu klik total). Pemain yang belum pernah membagikan
  // link (belum ada baris share_clicks) tidak muncul — wajar, karena
  // statistik ini tentang yang membagikan.
  app.get('/api/admin/share', authRequired, admin, r(async (req, res) => {
    const day = todayStr();
    const rows = await sql(
      `SELECT c.id AS citizen_id, u.id AS user_id, u.username,
         SUM(CASE WHEN sc.day = ? AND sc.gold_given > 0 THEN 1 ELSE 0 END) AS clicks_today,
         SUM(CASE WHEN sc.gold_given > 0 THEN 1 ELSE 0 END) AS clicks_total,
         SUM(CASE WHEN sc.day = ? THEN sc.gold_given ELSE 0 END) AS gold_today,
         SUM(sc.gold_given) AS gold_total
       FROM share_clicks sc
       JOIN citizens c ON c.id = sc.owner_id
       JOIN users u ON u.id = c.user_id
       GROUP BY c.id, u.id, u.username
       ORDER BY gold_total DESC, clicks_total DESC, u.username ASC`,
      [day, day]);
    const summary = rows.reduce((s, r) => ({
      players: s.players + 1,
      clicksToday: s.clicksToday + Number(r.clicks_today),
      clicksTotal: s.clicksTotal + Number(r.clicks_total),
      goldToday: s.goldToday + Number(r.gold_today),
      goldTotal: s.goldTotal + Number(r.gold_total),
    }), { players: 0, clicksToday: 0, clicksTotal: 0, goldToday: 0, goldTotal: 0 });
    res.json({
      day,
      perClick: SHARE_GOLD_PER_CLICK,
      summary,
      rows: rows.map((r) => ({
        citizenId: Number(r.citizen_id),
        userId: Number(r.user_id),
        username: r.username,
        publicId: publicId(Number(r.user_id)),
        clicksToday: Number(r.clicks_today),
        clicksTotal: Number(r.clicks_total),
        goldToday: Number(r.gold_today),
        goldTotal: Number(r.gold_total),
      })),
    });
  }));

  // ---------- LOG ADMIN ----------
  app.get('/api/admin/actions', authRequired, admin, r(async (req, res) => {
    const rows = await sql(
      `SELECT a.*, au.username AS admin_name, tu.username AS target_name
       FROM admin_actions a
       JOIN users au ON au.id = a.admin_id
       JOIN users tu ON tu.id = a.target_id
       ORDER BY a.created_at DESC LIMIT 100`);
    res.json({ actions: rows });
  }));

  // ---------- BAN / UNBAN ----------
  app.post('/api/admin/ban', authRequired, admin, r(async (req, res) => {
    const { user_id, reason } = req.body || {};
    const target = await one('SELECT u.*, c.id AS citizen_id FROM users u JOIN citizens c ON c.user_id = u.id WHERE u.id = ?', [Number(user_id)]);
    if (!target) return res.status(404).json({ error: 'Pemain tidak ditemukan.' });
    if (target.is_admin) return res.status(400).json({ error: 'Akun admin tidak bisa dibanned.' });
    if (target.is_banned) return res.status(400).json({ error: 'Pemain ini sudah dibanned.' });
    const cleanReason = (reason || '').trim().slice(0, 200);
    if (!cleanReason) return res.status(400).json({ error: 'Alasan ban wajib diisi.' });
    await tx(async (t) => {
      // Ban atomik: UPDATE hanya berhasil bila target BUKAN admin saat itu
      // juga (WHERE is_admin = 0). Ini menutup celah race antara pengecekan
      // di atas dan UPDATE — mis. flag admin baru saja ditandai migrasi.
      // token_version TIDAK dinaikkan di sini: sesi akun banned memang
      // sengaja dibiarkan hidup agar pemain bisa membuka layar banned +
      // mengajukan banding; semua API game diblokir middleware penjaga
      // banned (lihat src/app.js). Pencabutan sesi lewat token_version
      // hanya terjadi saat logout (lihat api-core.js).
      const r = await t.run(
        'UPDATE users SET is_banned = 1, banned_reason = ?, banned_at = ? WHERE id = ? AND is_admin = 0',
        [cleanReason, Date.now(), target.id]);
      if (!r.changes) throw new Error('Akun admin tidak bisa dibanned.');
      await logAction(t, req.userId, target.id, 'ban', `Ban: ${cleanReason}`);
      await notifyCitizen(t, target.citizen_id, 'Akun dibanned', `Akunmu dibanned oleh admin. Alasan: ${cleanReason}`);
    });
    res.json({ ok: true });
  }));

  app.post('/api/admin/unban', authRequired, admin, r(async (req, res) => {
    const { user_id } = req.body || {};
    const target = await one('SELECT u.*, c.id AS citizen_id FROM users u JOIN citizens c ON c.user_id = u.id WHERE u.id = ?', [Number(user_id)]);
    if (!target) return res.status(404).json({ error: 'Pemain tidak ditemukan.' });
    if (!target.is_banned) return res.status(400).json({ error: 'Pemain ini tidak sedang dibanned.' });
    await tx(async (t) => {
      await t.run("UPDATE users SET is_banned = 0, banned_reason = '', banned_at = 0 WHERE id = ?", [target.id]);
      await logAction(t, req.userId, target.id, 'unban', 'Unban: akses dipulihkan');
      await notifyCitizen(t, target.citizen_id, 'Ban dicabut', 'Admin mencabut ban akunmu. Kamu bisa masuk kembali.');
      // Ban karena skor kredit 0 → skor dikembalikan ke 50 (kesempatan
      // kedua, v3.0.0) supaya pemain tidak langsung bermain dengan skor 0.
      // Ban manual (alasan lain) tidak menyentuh skor.
      if ((target.banned_reason || '').startsWith('Skor kredit')) {
        const now = Date.now();
        await t.run('UPDATE citizens SET credit_score = ?, credit_updated_at = ? WHERE id = ?', [CREDIT_UNBAN_RESET_SCORE, now, target.citizen_id]);
        await t.run('INSERT INTO credit_history (citizen_id, delta, score_after, reason, created_at) VALUES (?,?,?,?,?) RETURNING id',
          [target.citizen_id, CREDIT_UNBAN_RESET_SCORE, CREDIT_UNBAN_RESET_SCORE, 'Unban: skor dipulihkan ke 50 (kesempatan kedua)', now]);
        await logAction(t, req.userId, target.id, 'credit_restore', `Skor kredit dipulihkan ke ${CREDIT_UNBAN_RESET_SCORE} (unban)`);
      }
    });
    res.json({ ok: true });
  }));

  // ---------- BERI PREMIUM ----------
  app.post('/api/admin/premium', authRequired, admin, r(async (req, res) => {
    const { user_id, months } = req.body || {};
    const m = Number(months);
    if (!PREMIUM_MONTHS.includes(m)) return res.status(400).json({ error: 'Durasi premium harus 1, 3, 6, atau 12 bulan.' });
    const target = await one('SELECT u.*, c.id AS citizen_id FROM users u JOIN citizens c ON c.user_id = u.id WHERE u.id = ?', [Number(user_id)]);
    if (!target) return res.status(404).json({ error: 'Pemain tidak ditemukan.' });
    const now = Date.now();
    const until = Math.max(now, target.premium_until || 0) + m * 30 * DAY_MS;
    const kind = grantKind(req.body);
    await tx(async (t) => {
      await t.run('UPDATE users SET premium_until = ? WHERE id = ?', [until, target.id]);
      await logAction(t, req.userId, target.id, 'premium', `Premium ${m} bulan (sampai ${new Date(until).toLocaleDateString('id-ID')}) (${kind})`);
      const note = kind === 'pembelian'
        ? { title: 'Pembelian diterima', content: `Premium ${m} bulan diterima dari pembelian.` }
        : { title: 'Kamu mendapat Premium!', content: `Admin memberimu Premium ${m} bulan. Nikmati keuntungannya!` };
      await notifyCitizen(t, target.citizen_id, note.title, note.content);
    });
    res.json({ ok: true, premium_until: until });
  }));

  // ---------- BERI EMAS / USD ----------
  app.post('/api/admin/gold', authRequired, admin, r(async (req, res) => {
    const { user_id, amount } = req.body || {};
    const amt = Number(amount);
    if (!amt || amt <= 0 || amt > MAX_GRANT || !Number.isFinite(amt)) {
      return res.status(400).json({ error: `Jumlah emas harus 1–${MAX_GRANT}.` });
    }
    const target = await one('SELECT u.*, c.id AS citizen_id FROM users u JOIN citizens c ON c.user_id = u.id WHERE u.id = ?', [Number(user_id)]);
    if (!target) return res.status(404).json({ error: 'Pemain tidak ditemukan.' });
    const kind = grantKind(req.body);
    await tx(async (t) => {
      await t.run('UPDATE citizens SET gold = gold + ? WHERE id = ?', [amt, target.citizen_id]);
      await logAction(t, req.userId, target.id, 'gold', `+${amt} emas (${kind})`);
      const note = kind === 'pembelian'
        ? { title: 'Pembelian diterima', content: `${amt} emas diterima dari pembelian.` }
        : { title: 'Hadiah dari admin', content: `Admin memberimu +${amt} emas.` };
      await notifyCitizen(t, target.citizen_id, note.title, note.content);
    });
    res.json({ ok: true });
  }));

  app.post('/api/admin/usd', authRequired, admin, r(async (req, res) => {
    const { user_id, amount } = req.body || {};
    const amt = Number(amount);
    if (!amt || amt <= 0 || amt > MAX_GRANT || !Number.isFinite(amt)) {
      return res.status(400).json({ error: `Jumlah Rupiah harus ${fmtRp(1)}–${fmtRp(MAX_GRANT)}.` });
    }
    const target = await one('SELECT u.*, c.id AS citizen_id FROM users u JOIN citizens c ON c.user_id = u.id WHERE u.id = ?', [Number(user_id)]);
    if (!target) return res.status(404).json({ error: 'Pemain tidak ditemukan.' });
    const kind = grantKind(req.body);
    await tx(async (t) => {
      await t.run('UPDATE citizens SET usd = usd + ? WHERE id = ?', [amt, target.citizen_id]);
      await logAction(t, req.userId, target.id, 'usd', `+${fmtRp(amt)} (${kind})`);
      const note = kind === 'pembelian'
        ? { title: 'Pembelian diterima', content: `${fmtRp(amt)} diterima dari pembelian.` }
        : { title: 'Hadiah dari admin', content: `Admin memberimu +${fmtRp(amt)}.` };
      await notifyCitizen(t, target.citizen_id, note.title, note.content);
    });
    res.json({ ok: true });
  }));

  // ---------- BERI BARANG (termasuk bahan mentah) ----------
  app.post('/api/admin/item', authRequired, admin, r(async (req, res) => {
    const { user_id, commodity, tier, qty } = req.body || {};
    if (!GRANT_ITEMS.includes(commodity)) return res.status(400).json({ error: 'Barang harus Makanan, Senjata, Tiket, atau bahan mentah (Gandum/Besi/Minyak/Kapas Mentah, Kayu, Batu Bara, Tembaga Mentah).' });
    const t = Math.max(1, Math.min(5, Number(tier) || 1));
    // Tahap 4: hadiah barang TANPA batas jumlah — syarat hanya bilangan
    // bulat positif yang valid (emas/USD tetap maks 1.000.000).
    const qRaw = Number(qty);
    if (!Number.isSafeInteger(qRaw) || qRaw <= 0) return res.status(400).json({ error: 'Jumlah barang harus bilangan bulat lebih dari 0.' });
    const q = qRaw;
    const target = await one('SELECT u.*, c.id AS citizen_id FROM users u JOIN citizens c ON c.user_id = u.id WHERE u.id = ?', [Number(user_id)]);
    if (!target) return res.status(404).json({ error: 'Pemain tidak ditemukan.' });
    const com = await one('SELECT id FROM commodities WHERE name = ?', [commodity]);
    const kind = grantKind(req.body);
    await tx(async (tt) => {
      await addItemTx(tt, target.citizen_id, com.id, t, q);
      await logAction(tt, req.userId, target.id, 'item', `+${q}× ${commodity} T${t} (${kind})`);
      const note = kind === 'pembelian'
        ? { title: 'Pembelian diterima', content: `${q}× ${commodity} T${t} diterima dari pembelian.` }
        : { title: 'Hadiah dari admin', content: `Admin memberimu ${q}× ${commodity} T${t}.` };
      await notifyCitizen(tt, target.citizen_id, note.title, note.content);
    });
    res.json({ ok: true });
  }));

  // ---------- ISI ENERGI ----------
  app.post('/api/admin/energy', authRequired, admin, r(async (req, res) => {
    const { user_id } = req.body || {};
    const target = await one('SELECT u.*, c.id AS citizen_id, c.level FROM users u JOIN citizens c ON c.user_id = u.id WHERE u.id = ?', [Number(user_id)]);
    if (!target) return res.status(404).json({ error: 'Pemain tidak ditemukan.' });
    // Tahap 4: isi sampai batas energi pemain (100 + 5×(level−1), +20
    // Premium, +10 RS Lapangan) — bukan lagi hardcode 100/120.
    const buildings = await convoyBuildings(target.citizen_id);
    const cap = energyCapFor(target.level, target.premium_until > Date.now(), buildings.has('health'));
    const kind = grantKind(req.body);
    await tx(async (t) => {
      await t.run('UPDATE citizens SET energy = ? WHERE id = ?', [cap, target.citizen_id]);
      await logAction(t, req.userId, target.id, 'energy', `Energi diisi penuh (${cap}) (${kind})`);
      const note = kind === 'pembelian'
        ? { title: 'Pembelian diterima', content: `Energi diisi penuh (${cap}) dari pembelian.` }
        : { title: 'Energi diisi admin', content: `Admin mengisi energimu sampai penuh (${cap}).` };
      await notifyCitizen(t, target.citizen_id, note.title, note.content);
    });
    res.json({ ok: true, energy: cap });
  }));

  // ---------- HADIAH MASSAL KE SEMUA PEMAIN ----------
  // POST /api/admin/gift-all { kind: 'gold'|'usd'|'item'|'premium'|'energy', amount, commodity?, tier?, message? }
  // Diterapkan ke SEMUA pemain yang TIDAK di-ban, dalam satu transaksi
  // database (semua berhasil atau semua batal). Tiap pemain dapat notifikasi
  // hadiah; aksi dicatat sekali di log admin. Batas jumlah: emas/USD maks
  // 1.000.000; barang TANPA batas jumlah (Tahap 4); premium 1–365 hari.
  // Notifikasi selalu berbunyi hadiah ("Hadiah dari admin") — karena memang hadiah.
  app.post('/api/admin/gift-all', authRequired, admin, r(async (req, res) => {
    const { kind, amount, commodity, tier, message } = req.body || {};
    if (!['gold', 'usd', 'item', 'premium', 'energy'].includes(kind)) {
      return res.status(400).json({ error: 'Jenis hadiah harus emas, Rupiah, barang, premium, atau isi energi.' });
    }
    // Rupiah dikirim sebagai pecahan USD (rpToUsd di client) — jangan
    // dibulatkan ke bawah, kalau tidak hadiah kehilangan sampai Rp18.299
    // per pemain. Emas tetap bilangan bulat.
    const amt = kind === 'usd' ? Number(amount) || 0 : Math.floor(Number(amount) || 0);
    let t = 1;
    let com = null;
    if (kind === 'gold' || kind === 'usd') {
      if (amt <= 0 || amt > MAX_GRANT) return res.status(400).json({ error: `Jumlah harus 1–${MAX_GRANT}.` });
    } else if (kind === 'item') {
      if (!GRANT_ITEMS.includes(commodity)) return res.status(400).json({ error: 'Barang harus Makanan, Senjata, Tiket, atau bahan mentah.' });
      t = Math.max(1, Math.min(5, Number(tier) || 1));
      // Tahap 4: hadiah barang TANPA batas jumlah — syarat hanya bilangan
      // bulat positif yang valid (emas/USD tetap maks 1.000.000).
      const rawAmt = Number(amount);
      if (!Number.isSafeInteger(rawAmt) || rawAmt <= 0) return res.status(400).json({ error: 'Jumlah barang harus bilangan bulat lebih dari 0.' });
      com = await one('SELECT id FROM commodities WHERE name = ?', [commodity]);
      if (!com) return res.status(400).json({ error: 'Barang tidak ditemukan.' });
    } else if (kind === 'premium') {
      if (amt <= 0 || amt > 365) return res.status(400).json({ error: 'Hari premium harus 1–365.' });
    }
    const msg = String(message || '').trim().slice(0, 200);
    const now = Date.now();
    const recipients = await sql(
      'SELECT u.id AS user_id, u.premium_until, c.id AS citizen_id, c.level FROM users u JOIN citizens c ON c.user_id = u.id WHERE u.is_banned = 0');
    if (!recipients.length) return res.status(400).json({ error: 'Tidak ada pemain yang bisa menerima hadiah.' });
    // Pemilik RS Lapangan (untuk batas energi per pemain, Tahap 4).
    const healthOwners = new Set((await sql("SELECT citizen_id FROM convoys WHERE building = 'health' AND expires_at > ?", [now]))
      .map((x) => x.citizen_id));
    const label = kind === 'gold' ? `+${amt} emas`
      : kind === 'usd' ? `+${fmtRp(amt)}`
      : kind === 'item' ? `+${amt}× ${commodity} T${t}`
      : kind === 'premium' ? `Premium ${amt} hari`
      : 'Isi energi penuh';
    await tx(async (tt) => {
      for (const rc of recipients) {
        if (kind === 'gold') await tt.run('UPDATE citizens SET gold = gold + ? WHERE id = ?', [amt, rc.citizen_id]);
        else if (kind === 'usd') await tt.run('UPDATE citizens SET usd = usd + ? WHERE id = ?', [amt, rc.citizen_id]);
        else if (kind === 'item') await addItemTx(tt, rc.citizen_id, com.id, t, amt);
        else if (kind === 'premium') {
          const until = Math.max(now, rc.premium_until || 0) + amt * DAY_MS;
          await tt.run('UPDATE users SET premium_until = ? WHERE id = ?', [until, rc.user_id]);
        } else {
          // Tahap 4: isi sampai batas energi masing-masing pemain
          // (100 + 5×(level−1), +20 Premium, +10 RS Lapangan).
          const cap = energyCapFor(rc.level, rc.premium_until > now, healthOwners.has(rc.citizen_id));
          await tt.run('UPDATE citizens SET energy = ? WHERE id = ?', [cap, rc.citizen_id]);
        }
        const content = kind === 'energy'
          ? `Admin mengisi energimu sampai penuh.${msg ? ' Pesan admin: ' + msg : ''}`
          : `Admin memberimu ${label}.${msg ? ' Pesan admin: ' + msg : ''}`;
        await notifyCitizen(tt, rc.citizen_id, 'Hadiah dari admin', content);
      }
      await logAction(tt, req.userId, req.userId, 'gift_all',
        `Hadiah massal: ${label} ke ${recipients.length} pemain${msg ? ` — "${msg}"` : ''}`);
    });
    res.json({ ok: true, recipients: recipients.length });
  }));

  // ---------- INBOX ADMIN: TIKET MEJA BANTUAN ----------
  // Form Meja Bantuan sudah menyimpan ke support_tickets, tapi selama ini
  // tidak ada yang membacanya. Di sini admin melihat, mengubah status,
  // dan membalas (balasan dikirim sebagai notifikasi ke pemain).
  // GET /api/admin/tickets?status=baru|dibaca|selesai — terbaru dulu.
  // Lupa Password (v5.5.0): permintaan reset ikut muncul di kotak masuk
  // ini (kind 'password_reset', id string 'pr-<n>') supaya admin melihat
  // dan memutusnya dari satu tempat. Pemetaan status: pending yang belum
  // kedaluwarsa → 'baru'; yang sudah diputus/dipakai/kedaluwarsa →
  // 'selesai'. Tiket biasa tetap kind 'ticket' + id angka seperti dulu.
  app.get('/api/admin/tickets', authRequired, admin, r(async (req, res) => {
    const status = (req.query.status || '').trim();
    const where = ['baru', 'dibaca', 'selesai'].includes(status) ? 'WHERE st.status = ?' : '';
    const params = where ? [status] : [];
    const rows = await sql(
      `SELECT st.*, u.id AS user_id, u.username, u.email
       FROM support_tickets st
       JOIN citizens c ON c.id = st.citizen_id
       JOIN users u ON u.id = c.user_id
       ${where} ORDER BY st.created_at DESC, st.id DESC LIMIT 200`,
      params);
    const tickets = rows.map((t) => ({ ...t, kind: 'ticket', publicId: publicId(t.user_id) }));
    const now = Date.now();
    const resetRows = await sql(
      `SELECT pr.*, u.username, u.email
       FROM password_resets pr JOIN users u ON u.id = pr.user_id
       ORDER BY pr.created_at DESC, pr.id DESC LIMIT 200`);
    const resets = resetRows.map((row) => {
      const expired = (row.status === 'pending' || row.status === 'approved') && Number(row.expires_at) <= now;
      const resetStatus = expired ? 'kedaluwarsa'
        : row.status === 'pending' ? 'menunggu'
        : row.status === 'approved' ? 'disetujui'
        : row.status === 'rejected' ? 'ditolak' : 'dipakai';
      return {
        id: 'pr-' + row.id,
        kind: 'password_reset',
        resetId: row.id,
        resetStatus,
        type: 'Lupa Password',
        topic: 'Reset password — ' + row.username,
        details: row.note ? `Keterangan pemain: "${row.note}"` : 'Pemain lupa password dan meminta reset lewat layar login.',
        status: resetStatus === 'menunggu' ? 'baru' : 'selesai',
        created_at: row.created_at,
        expires_at: row.expires_at,
        decided_at: row.decided_at,
        user_id: row.user_id,
        username: row.username,
        email: row.email,
        publicId: publicId(row.user_id),
      };
    });
    const filtered = status === 'baru' ? resets.filter((x) => x.status === 'baru')
      : status === 'dibaca' ? []
      : status === 'selesai' ? resets.filter((x) => x.status === 'selesai')
      : resets;
    const merged = [...tickets, ...filtered]
      .sort((a, b) => (b.created_at - a.created_at) || (String(b.id).localeCompare(String(a.id))))
      .slice(0, 200);
    res.json({ tickets: merged });
  }));

  // POST /api/admin/tickets/:id/status { status: 'baru'|'dibaca'|'selesai' }
  app.post('/api/admin/tickets/:id/status', authRequired, admin, r(async (req, res) => {
    const id = Number(req.params.id);
    const status = req.body?.status;
    if (!['baru', 'dibaca', 'selesai'].includes(status)) {
      return res.status(400).json({ error: 'Status harus baru, dibaca, atau selesai.' });
    }
    const ticket = await one('SELECT * FROM support_tickets WHERE id = ?', [id]);
    if (!ticket) return res.status(404).json({ error: 'Tiket tidak ditemukan.' });
    const owner = await one('SELECT user_id FROM citizens WHERE id = ?', [ticket.citizen_id]);
    await tx(async (t) => {
      await t.run('UPDATE support_tickets SET status = ? WHERE id = ?', [status, id]);
      if (owner) await logAction(t, req.userId, owner.user_id, 'ticket_status', `Tiket #${id} → ${status}`);
    });
    res.json({ ok: true, status });
  }));

  // POST /api/admin/tickets/:id/reply { text } — balasan sebagai notifikasi
  // ke pemain (judul "Balasan dari Admin"). Tiket yang masih 'baru' otomatis
  // menjadi 'dibaca' setelah dibalas.
  app.post('/api/admin/tickets/:id/reply', authRequired, admin, r(async (req, res) => {
    const id = Number(req.params.id);
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Balasan tidak boleh kosong.' });
    if (text.length > 1000) return res.status(400).json({ error: 'Balasan maksimal 1000 karakter.' });
    const ticket = await one('SELECT * FROM support_tickets WHERE id = ?', [id]);
    if (!ticket) return res.status(404).json({ error: 'Tiket tidak ditemukan.' });
    const owner = await one('SELECT user_id FROM citizens WHERE id = ?', [ticket.citizen_id]);
    await tx(async (t) => {
      await notifyCitizen(t, ticket.citizen_id, 'Balasan dari Admin', text);
      await t.run("UPDATE support_tickets SET status = 'dibaca' WHERE id = ? AND status = 'baru'", [id]);
      if (owner) await logAction(t, req.userId, owner.user_id, 'ticket_reply', `Tiket #${id}: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);
    });
    res.json({ ok: true });
  }));

  // ---------- INBOX ADMIN: LAPORAN CHAT ----------
  // GET /api/admin/reports — laporan chat (chat_reports) terbaru dulu,
  // lengkap dengan isi pesan yang dilaporkan + pelapor + alasan + skor
  // kredit penulis pesan saat ini (untuk putusan admin).
  app.get('/api/admin/reports', authRequired, admin, r(async (req, res) => {
    const rows = await sql(
      `SELECT cr.*, cm.content AS message_content, cm.citizen_id AS author_id, au.username AS author_name,
        cc.credit_score AS author_credit_score,
        ru.username AS reporter_name
       FROM chat_reports cr
       LEFT JOIN chat_messages cm ON cm.id = cr.message_id
       LEFT JOIN citizens cc ON cc.id = cm.citizen_id
       LEFT JOIN users au ON au.id = cc.user_id
       JOIN citizens rc ON rc.id = cr.reporter_id
       JOIN users ru ON ru.id = rc.user_id
       ORDER BY cr.created_at DESC, cr.id DESC LIMIT 200`);
    res.json({ reports: rows });
  }));

  // GET /api/admin/credit-history/:userId — riwayat skor kredit pemain
  // (siapa, berapa, kenapa, kapan), terbaru dulu, maks 50 baris.
  app.get('/api/admin/credit-history/:userId', authRequired, admin, r(async (req, res) => {
    const target = await one('SELECT c.id AS citizen_id, c.credit_score FROM users u JOIN citizens c ON c.user_id = u.id WHERE u.id = ?', [Number(req.params.userId)]);
    if (!target) return res.status(404).json({ error: 'Pemain tidak ditemukan.' });
    const rows = await sql('SELECT * FROM credit_history WHERE citizen_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', [target.citizen_id]);
    res.json({ credit_score: target.credit_score, history: rows });
  }));

  // POST /api/admin/reports/:id/review — putuskan laporan chat (v3.0.0).
  // Body { verdict: 'proven' | 'not_proven' } — WAJIB. 'proven' = laporan
  // TERBUKTI benar: skor kredit penulis pesan yang dilaporkan −10
  // (CREDIT_DEDUCTION_PROVEN_REPORT), dicatat di credit_history + log
  // admin + notifikasi ke penulis. Bila skor mencapai 0, akun otomatis
  // dibanned (mesin ban yang sudah ada; pemain bisa banding). 'not_proven'
  // = tidak terbukti: skor tidak berubah. Satu laporan hanya bisa diputus
  // SEKALI (status open → reviewed) — tidak ada pengurangan ganda.
  app.post('/api/admin/reports/:id/review', authRequired, admin, r(async (req, res) => {
    const id = Number(req.params.id);
    const { verdict } = req.body || {};
    if (verdict !== 'proven' && verdict !== 'not_proven') {
      return res.status(400).json({ error: 'Putusan wajib diisi: terbukti (proven) atau tidak terbukti (not_proven).' });
    }
    const rep = await one('SELECT * FROM chat_reports WHERE id = ?', [id]);
    if (!rep) return res.status(404).json({ error: 'Laporan tidak ditemukan.' });
    if (rep.status !== 'open') return res.status(400).json({ error: 'Laporan ini sudah ditinjau.' });
    const result = await tx(async (t) => {
      // Kunci baris laporan supaya dua admin tidak memutus laporan yang
      // sama bersamaan (pola forUpdate seperti saldo/stok).
      const locked = await t.one(forUpdate('SELECT * FROM chat_reports WHERE id = ?'), [id]);
      if (locked.status !== 'open') throw Object.assign(new Error('Laporan ini sudah ditinjau.'), { status: 400 });
      await t.run("UPDATE chat_reports SET status = 'reviewed', verdict = ? WHERE id = ?", [verdict, id]);
      const reporter = await t.one('SELECT user_id FROM citizens WHERE id = ?', [rep.reporter_id]);
      if (reporter) await logAction(t, req.userId, reporter.user_id, 'report_review', `Laporan chat #${id} diputus: ${verdict === 'proven' ? 'TERBUKTI' : 'TIDAK TERBUKTI'} (${rep.reason})`);
      if (verdict !== 'proven') return { newScore: null, banned: false };
      // Penulis pesan yang dilaporkan (bukan pelapor).
      const msg = await t.one('SELECT citizen_id FROM chat_messages WHERE id = ?', [rep.message_id]);
      if (!msg) return { newScore: null, banned: false };
      const author = await t.one(forUpdate('SELECT c.*, u.is_admin FROM citizens c JOIN users u ON u.id = c.user_id WHERE c.id = ?'), [msg.citizen_id]);
      if (!author || author.is_admin) return { newScore: null, banned: false };
      // Pulihkan dulu skor yang sudah berhak pulih (+1/hari), baru kurangi
      // — supaya pemain tidak dihukum dua kali untuk hari yang sama.
      const now = Date.now();
      const settled = creditScoreSettled(author.credit_score, author.credit_updated_at, author.is_banned, now);
      const newScore = Math.max(0, settled - CREDIT_DEDUCTION_PROVEN_REPORT);
      await t.run('UPDATE citizens SET credit_score = ?, credit_updated_at = ? WHERE id = ?', [newScore, now, author.id]);
      await t.run('INSERT INTO credit_history (citizen_id, delta, score_after, reason, created_at) VALUES (?,?,?,?,?) RETURNING id',
        [author.id, -CREDIT_DEDUCTION_PROVEN_REPORT, newScore, `Laporan chat #${id} terbukti (${rep.reason})`, now]);
      await logAction(t, req.userId, author.user_id, 'credit_deduct', `Skor kredit -${CREDIT_DEDUCTION_PROVEN_REPORT} menjadi ${newScore} (laporan chat #${id} terbukti: ${rep.reason})`);
      if (newScore === 0) {
        // Skor 0 = BAN otomatis (mesin ban yang sudah ada: layar banned +
        // banding tetap bisa dibuka; semua API game diblokir).
        await t.run("UPDATE users SET is_banned = 1, banned_reason = ?, banned_at = ? WHERE id = ? AND is_admin = 0",
          ['Skor kredit mencapai 0 karena laporan terbukti.', now, author.user_id]);
        await notifyCitizen(t, author.id, 'Skor kredit 0 — akun dibanned',
          'Skor kreditmu mencapai 0 karena laporan yang terbukti benar. Akunmu dibanned. Kamu bisa mengajukan banding lewat menu Banding.');
        return { newScore, banned: true };
      }
      await notifyCitizen(t, author.id, 'Skor kredit berkurang',
        `Skor kreditmu -${CREDIT_DEDUCTION_PROVEN_REPORT} menjadi ${newScore} karena laporan yang terbukti benar (${rep.reason}). Skor pulih +1 setiap hari.`);
      return { newScore, banned: false };
    });
    res.json({ ok: true, status: 'reviewed', verdict, ...result });
  }));

  // ---------- PENGUMUMAN UPDATE ("Apa yang Baru", Tahap 4) ----------
  // Hanya admin (middleware `admin`: adminOnly + rate limit 120 POST/jam).
  // Nomor update dihitung pemain dari urutan terbit — admin tidak mengisinya.
  app.get('/api/admin/announcements', authRequired, admin, r(async (req, res) => {
    const rows = await sql('SELECT * FROM announcements ORDER BY created_at DESC, id DESC');
    res.json({ announcements: rows });
  }));
  app.post('/api/admin/announcements', authRequired, admin, r(async (req, res) => {
    const { title, body } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'Judul pengumuman wajib diisi.' });
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'Isi pengumuman wajib diisi.' });
    const a = await tx(async (t) => {
      const ins = await t.run('INSERT INTO announcements (title, body, created_at, created_by) VALUES (?,?,?,?) RETURNING id',
        [String(title).trim().slice(0, 120), String(body).trim().slice(0, 5000), Date.now(), req.userId]);
      await logAction(t, req.userId, req.userId, 'announcement_create', `Pengumuman dibuat: "${String(title).trim().slice(0, 80)}"`);
      return ins;
    });
    res.json({ ok: true, id: a.id });
  }));
  app.post('/api/admin/announcements/:id/delete', authRequired, admin, r(async (req, res) => {
    const id = Number(req.params.id);
    const a = await one('SELECT * FROM announcements WHERE id = ?', [id]);
    if (!a) return res.status(404).json({ error: 'Pengumuman tidak ditemukan.' });
    await tx(async (t) => {
      await t.run('DELETE FROM announcement_reads WHERE announcement_id = ?', [id]);
      await t.run('DELETE FROM announcements WHERE id = ?', [id]);
      await logAction(t, req.userId, req.userId, 'announcement_delete', `Pengumuman dihapus: "${(a.title || '').slice(0, 80)}"`);
    });
    res.json({ ok: true });
  }));

  // ---------- TANDA PASAR (Tahap 4) ----------
  // Daftar heuristik harga di luar batas wajar + pola wash trading, terbaru
  // dulu. Hanya log untuk ditinjau — bukan bukti pelanggaran otomatis.
  app.get('/api/admin/market-flags', authRequired, admin, r(async (req, res) => {
    const rows = await sql(
      `SELECT f.*, c.name AS commodity_name,
         bu.username AS buyer_name, su.username AS seller_name
       FROM market_flags f
       LEFT JOIN commodities c ON c.id = f.commodity_id
       LEFT JOIN citizens bc ON bc.id = f.buyer_id LEFT JOIN users bu ON bu.id = bc.user_id
       LEFT JOIN citizens sc ON sc.id = f.seller_id LEFT JOIN users su ON su.id = sc.user_id
       ORDER BY f.created_at DESC, f.id DESC LIMIT 100`);
    res.json({ flags: rows });
  }));
}
