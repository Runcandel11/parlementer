// Parlementer — tes konkurensi di Postgres 16 sungguhan (Tahap 2).
// pg-mem/SQLite men-serialize tulis sehingga tidak bisa menangkap race
// ekonomi; tes ini memakai Postgres 16 lokal + HTTP paralel sungguhan:
//   (1) dua pembeli berebut 1 penawaran pasar — tepat 1 berhasil,
//   (2) dua klaim harian paralel — tepat 1 berhasil,
//   (3) dua shift paralel — tepat 1 berhasil,
//   (4) dua klaim pencapaian paralel — tepat 1 berhasil (ON CONFLICT),
//   (6) dua penjual berebut 1 order beli — tepat 1 berhasil,
//   (7) dua usulan pakta paralel pasangan+jenis sama — tepat 1 berhasil,
//   (8) dua vote anggaran paralel oleh MP yang sama — tepat 1 terhitung.
//   (9) dua latih paralel atribut yang sama — tepat 1 berhasil (jeda
//       latihan 2 menit × level: yang kedua membaca train_*_at baru).
// Di akhir: tidak ada saldo/energi/stok negatif di mana pun.
// Perlu Postgres 16 lokal + role/db tes (lihat test/pg-verify.mjs).
// Jalankan: npm run test:conc   (atau: node test/pg-concurrency.mjs)
// BUKAN bagian dari test:all — butuh server Postgres lokal.
import { spawn } from 'node:child_process';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL
  || 'postgres://parlementer_test:parlementer_test@127.0.0.1:5432/parlementer_test';
const PORT = 3458;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(a, b, eps = 0.001) { return Math.abs(a - b) < eps; }

class Client {
  constructor() { this.cookie = ''; }
  async req(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { data = {}; }
    return { status: res.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b || {}); }
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
  // Reset bersih: hapus semua tabel + tipe, server akan initDb sendiri.
  const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  for (const t of tables.rows) await pool.query(`DROP TABLE IF EXISTS "${t.tablename}" CASCADE`);
  const types = await pool.query("SELECT typname FROM pg_type WHERE typtype = 'c' AND typnamespace = 'public'::regnamespace");
  for (const t of types.rows) await pool.query(`DROP TYPE IF EXISTS "${t.typname}" CASCADE`);

  console.log('[pg-concurrency] Menyalakan server di port ' + PORT + ' (Postgres 16) ...');
  const server = spawn('node', ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), DATABASE_URL, JWT_SECRET: 'conc-test-secret', ADMIN_BOOTSTRAP_CODE: 'conc-bootstrap' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  process.on('exit', stop);

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(500);
      try { const r = await fetch(BASE + '/api/world'); up = r.ok; } catch {}
    }
    check('Server menyala & /api/world merespons', up);
    if (!up) { console.log(serverLog); process.exitCode = 1; return; }

    async function register(email, username) {
      const c = new Client();
      const r = await c.post('/api/auth/register', { email, password: 'rahasia123', username });
      if (r.status !== 200) throw new Error('register gagal: ' + email + ' ' + JSON.stringify(r.data));
      return c;
    }
    async function citizenIdOf(client) {
      const me = await client.get('/api/auth/me');
      return me.data.citizen.id;
    }
    async function goldUsdOf(client) {
      const me = await client.get('/api/me');
      return { gold: me.data.citizen.gold, usd: me.data.citizen.usd, energy: me.data.citizen.energy };
    }

    console.log('\n[1] Race: dua pembeli berebut 1 penawaran pasar');
    const S = await register('seller@conc.local', 'penjual_race');
    const B1 = await register('buyer1@conc.local', 'pembeli_satu');
    const B2 = await register('buyer2@conc.local', 'pembeli_dua');
    const sId = await citizenIdOf(S);
    // Redesain dunia: S mendirikan negara (Level 10 + 100 emas) agar pajak
    // penjual 2% berlaku — tanpa negara, pajak 0% dan penjual terima 90.
    await pool.query('UPDATE citizens SET level = 10, gold = 200 WHERE id = $1', [sId]);
    const found = await S.post('/api/countries', { name: 'Nusantara', ideology: 'Konservatisme', system: 'presidensial' });
    check('Penjual mendirikan Nusantara (negara pertama)', found.status === 200 && !!found.data.countryId, `status=${found.status} ${found.data.error || ''}`);
    const com = await pool.query("SELECT id FROM commodities WHERE name = 'Makanan'");
    await pool.query(
      'INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES ($1, $2, 1, 20) ON CONFLICT (citizen_id, commodity_id, tier) DO UPDATE SET qty = 20',
      [sId, com.rows[0].id]);
    let r = await S.post('/api/market/sell', { scope: 'local', commodity_id: com.rows[0].id, tier: 1, qty: 10, price: 9 });
    check('Penjual memasang 10× Makanan @ 9 USD', r.status === 200 && !!r.data.offerId, `offerId=${r.data.offerId}`);
    const offerId = r.data.offerId;
    const beforeS = await goldUsdOf(S);
    const beforeB1 = await goldUsdOf(B1);
    const beforeB2 = await goldUsdOf(B2);
    const [buy1, buy2] = await Promise.all([
      B1.post('/api/market/buy', { offer_id: offerId, qty: 10 }),
      B2.post('/api/market/buy', { offer_id: offerId, qty: 10 }),
    ]);
    const wins = [buy1, buy2].filter((x) => x.status === 200).length;
    // Yang kalah: 400 (stok tidak cukup) atau 404 (penawaran sudah dihapus
    // pemenang) — keduanya benar, yang penting tepat 1 berhasil.
    const losses = [buy1, buy2].filter((x) => x.status === 400 || x.status === 404).length;
    check('Tepat 1 pembeli berhasil, 1 ditolak (400/404)', wins === 1 && losses === 1, `status=${buy1.status}/${buy2.status}`);
    const afterS = await goldUsdOf(S);
    const afterB1 = await goldUsdOf(B1);
    const afterB2 = await goldUsdOf(B2);
    const paidTotal = (beforeB1.usd - afterB1.usd) + (beforeB2.usd - afterB2.usd);
    check('Pembeli membayar tepat 90 USD sekali saja', eq(paidTotal, 90), `dibayar=${paidTotal}`);
    check('Penjual menerima tepat 88,20 USD sekali saja', eq(afterS.usd - beforeS.usd, 88.2), `diterima=${afterS.usd - beforeS.usd}`);
    r = await S.get('/api/market?scope=local');
    check('Penawaran habis (0 penawaran)', r.data.stats.offers === 0, `offers=${r.data.stats.offers}`);

    console.log('\n[2] Race: dua klaim harian paralel');
    const K = await register('klaim@conc.local', 'pengklaim_race');
    const [cl1, cl2] = await Promise.all([K.post('/api/claim'), K.post('/api/claim')]);
    const clWins = [cl1, cl2].filter((x) => x.status === 200).length;
    const clLosses = [cl1, cl2].filter((x) => x.status === 400).length;
    check('Tepat 1 klaim berhasil, 1 ditolak (400)', clWins === 1 && clLosses === 1, `status=${cl1.status}/${cl2.status}`);
    const kAfter = await goldUsdOf(K);
    check('Emas naik tepat +5 (50 → 55)', kAfter.gold === 55, `emas=${kAfter.gold}`);

    console.log('\n[3] Race: dua shift paralel');
    const W = await register('shift@conc.local', 'pekerja_race');
    r = await W.get('/api/jobs');
    const job = r.data.jobs.find((j) => j.title === 'Pekerja Gudang Pelabuhan');
    check('Lowongan ADMIN ditemukan', !!job);
    // Melamar mensyaratkan warga di wilayah lowongan — sejak Tahap 5
    // wilayah lahir acak, jadi bepergian dulu bila belum di sana.
    const wMe = await W.get('/api/me');
    if (wMe.data.citizen.region_id !== job.region_id) {
      r = await W.post('/api/regions/travel', { region_id: job.region_id });
      check('Bepergian ke wilayah lowongan (biaya 1 Tiket)', r.status === 200, `status=${r.status}`);
      // Waktu tempuh: paksa tiba (mundurkan jam tiba) lalu /api/me
      // menyelesaikan kedatangan sebelum melamar.
      const wId = await citizenIdOf(W);
      await pool.query('UPDATE citizens SET travel_arrives_at = $1 WHERE id = $2', [Date.now() - 1000, wId]);
      await W.get('/api/me');
    }
    r = await W.post('/api/jobs/apply', { job_id: job.id });
    check('Lamar pekerjaan berhasil', r.status === 200 && r.data.ok);
    const [sh1, sh2] = await Promise.all([W.post('/api/jobs/shift'), W.post('/api/jobs/shift')]);
    const shWins = [sh1, sh2].filter((x) => x.status === 200).length;
    const shLosses = [sh1, sh2].filter((x) => x.status === 400).length;
    check('Tepat 1 shift berhasil, 1 ditolak (400)', shWins === 1 && shLosses === 1, `status=${sh1.status}/${sh2.status}`);
    const wAfter = await goldUsdOf(W);
    check('Energi tepat 0 setelah 1 shift (tidak negatif)', wAfter.energy === 0, `energi=${wAfter.energy}`);
    r = await W.get('/api/inventory');
    const besi = r.data.items.find((i) => i.name === 'Besi Mentah');
    check('Upah tepat 44× Besi Mentah (tidak 88)', besi && besi.qty === 44, `besi=${besi?.qty}`);

    console.log('\n[4] Race: dua klaim pencapaian paralel (ON CONFLICT)');
    const P = await register('ach@conc.local', 'pencapaian_race');
    const pId = await citizenIdOf(P);
    await pool.query('UPDATE citizens SET level = 5 WHERE id = $1', [pId]);
    const [ac1, ac2] = await Promise.all([
      P.post('/api/achievements/claim', { key: 'level_5' }),
      P.post('/api/achievements/claim', { key: 'level_5' }),
    ]);
    const acWins = [ac1, ac2].filter((x) => x.status === 200).length;
    const acLosses = [ac1, ac2].filter((x) => x.status === 400).length;
    check('Tepat 1 klaim pencapaian berhasil, 1 ditolak (400)', acWins === 1 && acLosses === 1, `status=${ac1.status}/${ac2.status}`);
    const pAfter = await goldUsdOf(P);
    check('Hadiah tepat +10 emas sekali (50 → 60)', pAfter.gold === 60, `emas=${pAfter.gold}`);

    console.log('\n[5] Race: dua blokir paralel (idempotent)');
    const A = await register('blokir-a@conc.local', 'pemblokir_race');
    const B = await register('blokir-b@conc.local', 'diblokir_race');
    const bId = await citizenIdOf(B);
    const [bl1, bl2] = await Promise.all([
      A.post('/api/chat/block', { citizen_id: bId }),
      A.post('/api/chat/block', { citizen_id: bId }),
    ]);
    check('Dua blokir paralel keduanya 200 (tanpa 500)', bl1.status === 200 && bl2.status === 200, `status=${bl1.status}/${bl2.status}`);
    const blocked = await pool.query('SELECT COUNT(*) AS n FROM blocked WHERE blocker_id = (SELECT id FROM citizens WHERE user_id = (SELECT id FROM users WHERE username = $1))', ['pemblokir_race']);
    check('Hanya 1 baris blokir tercatat', Number(blocked.rows[0].n) === 1, `n=${blocked.rows[0].n}`);

    console.log('\n[6] Race: dua penjual berebut 1 order beli (Tahap 4)');
    const U = await register('pembeli-order@conc.local', 'pembeli_order');
    const S1 = await register('penjual-order1@conc.local', 'penjual_order_satu');
    const S2 = await register('penjual-order2@conc.local', 'penjual_order_dua');
    const uId = await citizenIdOf(U);
    const s1Id = await citizenIdOf(S1);
    const s2Id = await citizenIdOf(S2);
    const besiCom = await pool.query("SELECT id FROM commodities WHERE name = 'Besi Mentah'");
    const besiCid = besiCom.rows[0].id;
    // Redesain dunia: pindahkan kedua penjual ke wilayah Nusantara agar
    // pajak penjual 2% + kas negara bisa dicek. Pajak mengikuti
    // KEWARGANEGARAAN (home_region_id, 27 Nov 2026), jadi keduanya disetel.
    await pool.query('UPDATE citizens SET region_id = (SELECT id FROM regions WHERE country_id = 1 LIMIT 1), home_region_id = (SELECT id FROM regions WHERE country_id = 1 LIMIT 1) WHERE id IN ($1, $2)', [s1Id, s2Id]);
    for (const sid of [s1Id, s2Id]) {
      await pool.query(
        'INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES ($1, $2, 1, 10) ON CONFLICT (citizen_id, commodity_id, tier) DO UPDATE SET qty = 10',
        [sid, besiCid]);
    }
    r = await U.post('/api/market/buy-order', { scope: 'local', commodity_id: besiCid, tier: 1, qty: 10, price: 9 });
    check('Pembeli memasang order beli 10× Besi @ 9 USD', r.status === 200 && !!r.data.orderId, `orderId=${r.data.orderId} ${JSON.stringify(r.data)}`);
    const orderId = r.data.orderId;
    const treBefore = await pool.query('SELECT treasury_usd FROM country WHERE id = 1');
    const usdS1Before = await goldUsdOf(S1);
    const usdS2Before = await goldUsdOf(S2);
    const [fill1, fill2] = await Promise.all([
      S1.post('/api/market/sell-to-order', { order_id: orderId, qty: 10 }),
      S2.post('/api/market/sell-to-order', { order_id: orderId, qty: 10 }),
    ]);
    const fillWins = [fill1, fill2].filter((x) => x.status === 200).length;
    // Yang kalah: 400 (sisa order habis) atau 404 (order sudah terisi penuh
    // lalu dihapus pemenang) — keduanya benar, yang penting tepat 1 berhasil.
    const fillLosses = [fill1, fill2].filter((x) => x.status === 400 || x.status === 404).length;
    check('Tepat 1 penjual berhasil mengisi order, 1 ditolak (400/404)', fillWins === 1 && fillLosses === 1, `status=${fill1.status}/${fill2.status}`);
    const besiU = await pool.query('SELECT qty FROM inventory WHERE citizen_id = $1 AND commodity_id = $2 AND tier = 1', [uId, besiCid]);
    check('Pembeli menerima tepat 10× Besi sekali saja', Number(besiU.rows[0]?.qty) === 10, `besi=${besiU.rows[0]?.qty}`);
    const usdS1After = await goldUsdOf(S1);
    const usdS2After = await goldUsdOf(S2);
    const paidSellers = (usdS1After.usd - usdS1Before.usd) + (usdS2After.usd - usdS2Before.usd);
    check('Tepat 1 penjual dibayar 88,20 USD (90 − pajak 2%)', eq(paidSellers, 88.2), `dibayar=${paidSellers}`);
    const treAfter = await pool.query('SELECT treasury_usd FROM country WHERE id = 1');
    check('Pajak order beli tepat 1,80 USD masuk kas negara', eq(Number(treAfter.rows[0].treasury_usd) - Number(treBefore.rows[0].treasury_usd), 1.8),
      `delta=${Number(treAfter.rows[0].treasury_usd) - Number(treBefore.rows[0].treasury_usd)}`);
    const orderLeft = await pool.query('SELECT COUNT(*) AS n FROM market_buy_orders WHERE id = $1', [orderId]);
    check('Order beli terisi penuh lalu terhapus', Number(orderLeft.rows[0].n) === 0);

    console.log('\n[7] Race: dua usulan pakta paralel untuk pasangan+jenis yang sama (Tahap 5)');
    const L1 = await register('ketua-org1@conc.local', 'ketua_org_satu');
    const L2 = await register('ketua-org2@conc.local', 'ketua_org_dua');
    const l1Id = await citizenIdOf(L1);
    const l2Id = await citizenIdOf(L2);
    await pool.query('UPDATE citizens SET gold = 500 WHERE id IN ($1, $2)', [l1Id, l2Id]);
    r = await L1.post('/api/orgs', { name: 'Org Race Satu', tag: 'ORS', type: 'Kerja Sama' });
    check('L1 mendirikan org (100 emas)', r.status === 200 && !!r.data.orgId, `status=${r.status}`);
    const orgA = r.data.orgId;
    r = await L2.post('/api/orgs', { name: 'Org Race Dua', tag: 'ORD', type: 'Keamanan' });
    check('L2 mendirikan org (100 emas)', r.status === 200 && !!r.data.orgId, `status=${r.status}`);
    const orgB = r.data.orgId;
    // Dua arah sekaligus (L1: A→B, L2: B→A) — pasangan ternormalisasi sama.
    const [pc1, pc2] = await Promise.all([
      L1.post(`/api/orgs/${orgA}/pact`, { target_org_id: orgB, kind: 'trade' }),
      L2.post(`/api/orgs/${orgB}/pact`, { target_org_id: orgA, kind: 'trade' }),
    ]);
    const pcWins = [pc1, pc2].filter((x) => x.status === 200).length;
    const pcLosses = [pc1, pc2].filter((x) => x.status === 400).length;
    check('Tepat 1 usulan pakta berhasil, 1 ditolak 400 (tanpa 500)', pcWins === 1 && pcLosses === 1, `status=${pc1.status}/${pc2.status}`);
    const pactCount = await pool.query("SELECT COUNT(*) AS n FROM org_pacts WHERE kind = 'trade' AND status = 'pending'");
    check('Tepat 1 baris pakta pending tercatat', Number(pactCount.rows[0].n) === 1, `n=${pactCount.rows[0].n}`);

    console.log('\n[8] Race: dua vote anggaran paralel oleh MP yang sama (Tahap 5)');
    const M = await register('mp-race@conc.local', 'mp_race');
    const mId = await citizenIdOf(M);
    await pool.query("INSERT INTO parties (name, tag, ideology, leader_id, type, seats, created_at) VALUES ('Partai Race','PTR','Konservatif',$1,'open',31,$2)", [mId, Date.now()]);
    const partyRace = await pool.query("SELECT id FROM parties WHERE tag = 'PTR'");
    // Redesain dunia: kursi parlemen kini di party_seats per negara (bukan
    // kolom parties.seats); M harus warga Nusantara; parlemen terkunci
    // sampai 2 Des 2026 — buka untuk tes anggaran ini.
    await pool.query('INSERT INTO party_seats (party_id, country_id, seats) VALUES ($1, 1, 31)', [partyRace.rows[0].id]);
    await pool.query("UPDATE db_meta SET value = $1 WHERE key = 'parliament_opens_at'", [String(Date.now() - 1000)]);
    await pool.query('UPDATE citizens SET party_id = $1, level = 5, gold = 500, region_id = (SELECT id FROM regions WHERE country_id = 1 LIMIT 1), home_region_id = (SELECT id FROM regions WHERE country_id = 1 LIMIT 1) WHERE id = $2', [partyRace.rows[0].id, mId]);
    await pool.query('INSERT INTO party_members (party_id, citizen_id, role, joined_at) VALUES ($1, $2, $3, $4)', [partyRace.rows[0].id, mId, 'leader', Date.now()]);
    await pool.query('UPDATE country SET minister_economy = $1, treasury = 1000 WHERE id = 1', [mId]);
    r = await M.post('/api/country/budget', { kind: 'claim', amount: 100 });
    check('M mengusulkan anggaran (100 emas)', r.status === 200 && !!r.data.budgetId, `status=${r.status}`);
    const budgetRace = r.data.budgetId;
    const [bv1, bv2] = await Promise.all([
      M.post(`/api/country/budget/${budgetRace}/vote`, { vote: 'yes' }),
      M.post(`/api/country/budget/${budgetRace}/vote`, { vote: 'yes' }),
    ]);
    const bvWins = [bv1, bv2].filter((x) => x.status === 200).length;
    const bvLosses = [bv1, bv2].filter((x) => x.status === 400).length;
    check('Tepat 1 vote anggaran berhasil, 1 ditolak 400 (tanpa 500)', bvWins === 1 && bvLosses === 1, `status=${bv1.status}/${bv2.status}`);
    const voteCount = await pool.query('SELECT COUNT(*) AS n FROM budget_votes WHERE budget_id = $1', [budgetRace]);
    check('Tepat 1 baris vote tercatat', Number(voteCount.rows[0].n) === 1, `n=${voteCount.rows[0].n}`);
    const budgetRow = await pool.query('SELECT yes FROM budgets WHERE id = $1', [budgetRace]);
    check('Suara YA anggaran tepat 1', Number(budgetRow.rows[0].yes) === 1, `yes=${budgetRow.rows[0].yes}`);

    console.log('\n[9] Race: dua latih paralel atribut yang sama (jeda latihan)');
    const T = await register('latih-race@conc.local', 'pelatih_race');
    const tId = await citizenIdOf(T);
    const [tr1, tr2] = await Promise.all([
      T.post('/api/train', { attr: 'str' }),
      T.post('/api/train', { attr: 'str' }),
    ]);
    const trWins = [tr1, tr2].filter((x) => x.status === 200).length;
    const trLosses = [tr1, tr2].filter((x) => x.status === 400).length;
    check('Tepat 1 latih berhasil, 1 ditolak 400 (jeda)', trWins === 1 && trLosses === 1, `status=${tr1.status}/${tr2.status}`);
    check('Yang kalah menyebut jeda', /jeda/i.test((tr1.status === 400 ? tr1 : tr2).data.error || ''), (tr1.status === 400 ? tr1 : tr2).data.error || '');
    const tRow = await pool.query('SELECT attr_str, gold FROM citizens WHERE id = $1', [tId]);
    check('Atribut naik tepat 1 level, emas terpotong tepat 1× biaya (1 emas)', Number(tRow.rows[0].attr_str) === 1 && Number(tRow.rows[0].gold) === 49, `attr_str=${tRow.rows[0].attr_str} gold=${tRow.rows[0].gold}`);
    const tCd = await pool.query('SELECT train_str_at FROM citizens WHERE id = $1', [tId]);
    check('train_str_at tercatat (> 0)', Number(tCd.rows[0].train_str_at) > 0, `train_str_at=${tCd.rows[0].train_str_at}`);

    console.log('\n[10] Invarian akhir: tidak ada saldo/stok negatif');
    const neg = await pool.query(
      `SELECT (SELECT COUNT(*) FROM citizens WHERE gold < 0 OR usd < 0 OR energy < 0) AS c1,
              (SELECT COUNT(*) FROM inventory WHERE qty < 0) AS c2,
              (SELECT COUNT(*) FROM market_offers WHERE qty <= 0) AS c3,
              (SELECT COUNT(*) FROM jobs WHERE seats_taken < 0 OR seats_taken > seats) AS c4,
              (SELECT COUNT(*) FROM fx_offers WHERE qty_gold < 0 OR qty_filled < 0) AS c5`);
    const n = neg.rows[0];
    check('0 baris melanggar (citizens/inventory/offers/jobs/fx)', ['c1', 'c2', 'c3', 'c4', 'c5'].every((k) => Number(n[k]) === 0), JSON.stringify(n));
  } finally {
    stop();
    await pool.end();
  }

  console.log(`\n[pg-concurrency] SELESAI: ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[pg-concurrency] ERROR:', e); process.exit(1); });
