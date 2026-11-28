// Daily tick Parlementer: dunia maju 1 hari tiap tengah malam.
// Dipanggil otomatis saat ada request (cek tanggal) + interval 10 menit.
// Aman di Render free (tanpa cron eksternal): tick jalan saat ada yang membuka game.
import { sql, one, run, getParliamentOpensAt } from './db.js';
import { fmtRp } from './util.js';
import { DAILY_PRODUCTION, PRODUCTION_INPUT, MILITARY_UNITS, worldEventFor, worldEventEndsDay, RETENTION, productionWithBonus, BUDGET_KINDS, BUDGET_DURATION_MS, lawEffectText, COUNTRY_IDEOLOGIES, GOVERNMENT_SYSTEMS, systemDef, COUNTRY_JOIN_MIN_YES, DAY_MS, ELECTION_VOTE_MS, PRESIDENT_ELECTION_DELAY_DAYS, PARLIAMENT_ELECTION_CYCLE_DAYS } from './game.js';

function todayStr(d = new Date()) { return d.toISOString().slice(0, 10); }

// Jadwalkan pemilu PER NEGARA (redesain dunia — dulu satu pasang pemilu
// global). Dijalankan tiap tick + saat server siap (app.js ensureReady).
// - Presiden: pemilu otomatis tiap 7 hari HANYA untuk sistem presidensial /
//   parlementer. Imperial/diktator TIDAK punya pemilu otomatis — pemilu
//   pengisi kekosongan dijadwalkan sekali bila jabatan presiden kosong.
// - Parlemen: tiap 30 hari; pemilu pertama paling cepat saat parlemen
//   dibuka (2 Des 2026 — dari db_meta, bukan hardcode tanggal).
// Negara baru sudah membawa jadwal pemilu pertamanya dari pendirian
// (POST /api/countries) — fungsi ini hanya mengisi bila belum ada.
//
// (Tahap 8) INSERT ATOMIK: dulu SELECT lalu INSERT — dua panggilan
// bersamaan (cold start serverless ganda, ensureReady + tick di request
// yang sama) bisa sama-sama melihat "belum ada" lalu sama-sama INSERT,
// menghasilkan pemilu ganda per negara+tipe. Sekarang satu statement
// INSERT ... SELECT ... WHERE NOT EXISTS, dan indeks unik parsial
// idx_elections_one_active (migrateStage8Columns) menolak duplikat sebagai
// pengaman terakhir — pelanggaran unik (23505 / UNIQUE constraint) ditelan,
// error lain tetap dilempar.
export async function ensureElections() {
  const now = Date.now();
  const parOpensAt = await getParliamentOpensAt();
  const countries = await sql('SELECT * FROM country');
  const insertElection = async (country, type, opens) => {
    try {
      await run(`INSERT INTO elections (type, status, opens_at, closes_at, country_id, created_at)
        SELECT ?, 'scheduled', ?, ?, ?, ? WHERE NOT EXISTS
        (SELECT 1 FROM elections WHERE country_id = ? AND type = ? AND status IN ('scheduled','open'))`,
        [type, opens, opens + ELECTION_VOTE_MS, country.id, now, country.id, type]);
    } catch (e) {
      if (/23505|UNIQUE constraint/i.test(e.message || '') || e.code === '23505') return;
      throw e;
    }
  };
  for (const country of countries) {
    const pres = await one("SELECT * FROM elections WHERE country_id = ? AND type = 'president' AND status IN ('scheduled','open') ORDER BY opens_at ASC", [country.id]);
    const needsPresident = systemDef(country.system).autoPresidentElection || !country.president_id;
    if (!pres && needsPresident) {
      await insertElection(country, 'president', now + PRESIDENT_ELECTION_DELAY_DAYS * DAY_MS);
    }
    const parl = await one("SELECT * FROM elections WHERE country_id = ? AND type = 'parliament' AND status IN ('scheduled','open') ORDER BY opens_at ASC", [country.id]);
    if (!parl) {
      await insertElection(country, 'parliament', Math.max(parOpensAt, now + PARLIAMENT_ELECTION_CYCLE_DAYS * DAY_MS));
    }
  }
}

async function notify(citizenId, category, title, content = '') {
  await run('INSERT INTO notifications (citizen_id, category, title, content, created_at) VALUES (?,?,?,?,?) RETURNING id',
    [citizenId, category, title, content, Date.now()]);
}

async function notifyAll(category, title, content = '') {
  await run('INSERT INTO notifications (citizen_id, category, title, content, created_at) SELECT id, ?, ?, ?, ? FROM citizens',
    [category, title, content, Date.now()]);
}

// Terapkan efek UU yang disahkan ke baris country MILIKNYA (Tahap 5,
// BUG-9 + redesain dunia). kind 'general' tidak mengubah angka apa pun.
// effect_applied = 1 menandai UU sudah diterapkan (idempotent bila tick
// diulang). UU tanpa country_id (arsip era negara tunggal) dilewati.
async function applyLawEffect(law) {
  const kind = law.kind || 'general';
  if (!law.country_id) { await run('UPDATE laws SET effect_applied = 1 WHERE id = ?', [law.id]); return; }
  if (kind === 'tax_income') {
    await run('UPDATE country SET tax_income = ? WHERE id = ?', [Number(law.value), law.country_id]);
  } else if (kind === 'tax_import') {
    // (Tahap 7) UU pajak impor: tarif impor negara berubah 1–5%. Sebelumnya
    // jenis UU ini tidak ada — kolom tax_import tidak bisa diubah dan pasar
    // global mengabaikannya (selalu 2%). Sekarang tarifnya benar-benar
    // berlaku lewat getImportTaxRate.
    await run('UPDATE country SET tax_import = ? WHERE id = ?', [Number(law.value), law.country_id]);
  } else if (kind === 'admin_pay') {
    await run('UPDATE country SET admin_pay_mult = ? WHERE id = ?', [Number(law.value) / 100, law.country_id]);
  } else if (kind === 'travel') {
    await run('UPDATE country SET travel_tickets = ? WHERE id = ?', [Number(law.value), law.country_id]);
  } else if (kind === 'ideology') {
    const ide = COUNTRY_IDEOLOGIES[Math.round(Number(law.value))];
    if (ide) await run('UPDATE country SET ideology = ? WHERE id = ?', [ide.id, law.country_id]);
  } else if (kind === 'system') {
    const sys = GOVERNMENT_SYSTEMS[Math.round(Number(law.value))];
    if (sys) await run('UPDATE country SET system = ? WHERE id = ?', [sys.id, law.country_id]);
  }
  await run('UPDATE laws SET effect_applied = 1 WHERE id = ?', [law.id]);
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

  // 1) Warga: energi pulih penuh ke BATAS masing-masing (Tahap 4:
  // 100 + 5×(level−1), +20 Premium, +10 RS Lapangan — satu rumus
  // energyCapFor, bukan lagi hardcode 100/110/120), jatah harian reset,
  // kelelahan pulih sebagian. Jam regen ikut diperbarui ke sekarang.
  await run(`UPDATE citizens SET
    energy = 100 + 5 * (CASE WHEN level > 1 THEN level - 1 ELSE 0 END)
      + CASE WHEN (SELECT premium_until FROM users WHERE users.id = citizens.user_id) > ? THEN 20 ELSE 0 END
      + CASE WHEN EXISTS (SELECT 1 FROM convoys WHERE citizen_id = citizens.id AND building = 'health' AND expires_at > ?) THEN 10 ELSE 0 END,
    energy_updated_at = ?,
    bread_today = 0, energy_spent_today = 0,
    chat_today = 0, fatigue = CASE WHEN fatigue > 2000 THEN fatigue - 2000 ELSE 0 END`,
    [now, now, now]);
  // (Tahap 7) Reset misi harian: dulu `missions = '{}'` di UPDATE di atas
  // (kolom JSON sudah dihapus) — sekarang hapus baris progres + klaim misi
  // dari tabel relasional. Kronik TIDAK direset (progres tutorial permanen).
  await run('DELETE FROM mission_progress');
  await run('DELETE FROM mission_claims');

  // 2) Produksi perusahaan -> inventaris pemilik.
  const industryOwners = new Set((await sql(
    "SELECT citizen_id FROM convoys WHERE building = 'industry' AND expires_at > ?", [now]))
    .map((r) => r.citizen_id));
  const companies = await sql('SELECT * FROM companies');
  for (const co of companies) {
    const baseAmount = DAILY_PRODUCTION[co.type] || 0;
    // Bonus konvoi (Tahap 3, BUG-7): Gudang Industri aktif -> produksi +10%.
    const amount = industryOwners.has(co.owner_id) ? productionWithBonus(baseAmount) : baseAmount;
    let commodity = co.resource || '';
    if (co.type === 'factory') commodity = 'Bahan Bangunan';
    if (co.type === 'light') commodity = 'Makanan';
    if (co.type === 'heavy') commodity = 'Drone';
    if (!commodity || amount <= 0) continue;
    // Tahap 6 — rantai produksi penuh: SEMUA jenis perusahaan butuh bahan
    // baku (PRODUCTION_INPUT di game.js — satu sumber kebenaran dengan
    // bonus shift). Bila bahan kurang, produksi hanya sebanyak bahannya
    // cukup (bisa 0 + notifikasi).
    let produce = amount;
    const inputs = PRODUCTION_INPUT[co.type] || [];
    const usedInputs = [];
    for (const input of inputs) {
      const inputRow = await one('SELECT id FROM commodities WHERE name = ?', [input.commodity]);
      const stock = inputRow ? await one('SELECT * FROM inventory WHERE citizen_id = ? AND commodity_id = ? AND tier = 1', [co.owner_id, inputRow.id]) : null;
      const have = stock?.qty || 0;
      produce = Math.min(produce, Math.floor(have / input.perUnit));
      usedInputs.push({ input, stock, have });
    }
    if (inputs.length && produce <= 0) {
      await notify(co.owner_id, 'EKONOMI', `${co.name} kekurangan bahan`,
        `${co.name} tidak berproduksi hari ini: butuh ${inputs.map((i) => `${amount * i.perUnit}× ${i.commodity}`).join(' + ')} (punya ${inputs.map((i, idx) => `${usedInputs[idx].have}× ${i.commodity}`).join(', ')}).`);
      continue;
    }
    for (const { input, stock } of usedInputs) {
      const used = produce * input.perUnit;
      if (used <= 0) continue;
      const took = await run('UPDATE inventory SET qty = qty - ? WHERE id = ? AND qty >= ?', [used, stock.id, used]);
      if (!took.changes) { produce = 0; break; } // stok berubah bersamaan — lewati hari ini
    }
    if (produce <= 0) continue;
    const com = await one('SELECT id FROM commodities WHERE name = ?', [commodity]);
    if (!com) continue;
    const inv = await one('SELECT * FROM inventory WHERE citizen_id = ? AND commodity_id = ? AND tier = 1', [co.owner_id, com.id]);
    if (inv) await run('UPDATE inventory SET qty = qty + ? WHERE id = ?', [produce, inv.id]);
    else await run('INSERT INTO inventory (citizen_id, commodity_id, tier, qty) VALUES (?,?,1,?) RETURNING id', [co.owner_id, com.id, produce]);
    await notify(co.owner_id, 'EKONOMI', 'Produksi perusahaan',
      inputs.length
        ? `${co.name} mengolah ${usedInputs.map(({ input }) => `${produce * input.perUnit}× ${input.commodity}`).join(' + ')} menjadi ${produce}× ${commodity} hari ini.`
        : `${co.name} memproduksi ${produce}× ${commodity} hari ini.`);
  }

  // 3) Pemilu: buka yang sudah waktunya, tutup & selesaikan yang berakhir.
  await run("UPDATE elections SET status = 'open' WHERE status = 'scheduled' AND opens_at <= ?", [now]);
  const closing = await sql("SELECT * FROM elections WHERE status = 'open' AND closes_at <= ?", [now]);
  for (const e of closing) {
    // Pemilu tanpa negara (arsip era negara tunggal) ditutup tanpa efek.
    if (!e.country_id) { await run("UPDATE elections SET status = 'closed' WHERE id = ?", [e.id]); continue; }
    const country = await one('SELECT * FROM country WHERE id = ?', [e.country_id]);
    if (!country) { await run("UPDATE elections SET status = 'closed' WHERE id = ?", [e.id]); continue; }
    // Seri suara: pemenang = suara terbanyak, lalu citizen_id terkecil
    // (deterministik — perbaikan audit BUG-13).
    const top = await sql('SELECT * FROM election_candidates WHERE election_id = ? ORDER BY votes DESC, citizen_id ASC LIMIT 1', [e.id]);
    if (e.type === 'president') {
      if (top.length && top[0].votes > 0) {
        await run('UPDATE elections SET status = ?, winner_id = ? WHERE id = ?', ['closed', top[0].citizen_id, e.id]);
        await run('UPDATE country SET president_id = ? WHERE id = ?', [top[0].citizen_id, country.id]);
        await notify(top[0].citizen_id, 'POLITIK', `Kamu terpilih jadi ${systemDef(country.system).presidentTitle}!`, `Selamat! Kamu memenangkan pemilu ${systemDef(country.system).presidentTitle.toLowerCase()} ${country.name}.`);
      } else {
        await run("UPDATE elections SET status = 'closed' WHERE id = ?", [e.id]);
      }
    } else {
      // Parlemen: kursi dibagi proporsional dari suara per partai, disimpan
      // PER NEGARA di party_seats (redesain dunia — bukan lagi kolom
      // parties.seats yang satu angka untuk semua negara).
      const cands = await sql('SELECT * FROM election_candidates WHERE election_id = ?', [e.id]);
      const total = cands.reduce((s, c) => s + c.votes, 0);
      await run('DELETE FROM party_seats WHERE country_id = ?', [country.id]);
      if (total > 0) {
        let assigned = 0;
        const seatsByParty = new Map();
        for (const cand of cands) {
          if (!cand.party_id) continue;
          const seats = Math.round((cand.votes / total) * 60);
          seatsByParty.set(cand.party_id, (seatsByParty.get(cand.party_id) || 0) + seats);
          assigned += seats;
        }
        // Koreksi pembulatan ke 60 kursi pada partai terbesar.
        if (assigned !== 60 && seatsByParty.size) {
          const biggest = [...cands].sort((a, b) => b.votes - a.votes).find((c) => c.party_id);
          if (biggest) seatsByParty.set(biggest.party_id, Math.max(0, (seatsByParty.get(biggest.party_id) || 0) + (60 - assigned)));
        }
        for (const [partyId, seats] of seatsByParty) {
          await run('INSERT INTO party_seats (party_id, country_id, seats) VALUES (?,?,?) RETURNING party_id', [partyId, country.id, seats]);
        }
      }
      await run("UPDATE elections SET status = 'closed' WHERE id = ?", [e.id]);
    }
  }
  await ensureElections();

  // 4) UU: tutup voting yang berakhir. (Tahap 5, BUG-9): UU yang lolos
  // kini benar-benar MENGUBAH angka negara (applyLawEffect) — bukan lagi
  // sekadar ganti status jadi 'executed'. UU umum tidak mengubah angka.
  const laws = await sql("SELECT * FROM laws WHERE status = 'voting' AND ends_at <= ?", [now]);
  for (const law of laws) {
    if (law.yes > law.no) {
      await run("UPDATE laws SET status = 'executed' WHERE id = ?", [law.id]);
      await applyLawEffect(law);
      await notify(law.proposer_id, 'POLITIK', 'UU-mu disahkan', `"${law.title}" lolos voting dan mulai berlaku. ${lawEffectText(law.kind || 'general', law.value)}`);
    } else {
      await run("UPDATE laws SET status = 'failed' WHERE id = ?", [law.id]);
      await notify(law.proposer_id, 'POLITIK', 'UU-mu gagal', `"${law.title}" tidak lolos voting.`);
    }
  }

  // 4b) Anggaran (Tahap 5): tutup voting yang berakhir. Lolos = potong
  // biaya dari kas negara (bila kas kurang, anggaran gagal dengan
  // pemberitahuan) + efek berlaku 7 hari (country.budget_kind/until).
  // Anggaran baru menggantikan anggaran yang sedang berlaku.
  const budgets = await sql("SELECT * FROM budgets WHERE status = 'voting' AND ends_at <= ?", [now]);
  for (const b of budgets) {
    // Anggaran tanpa negara (arsip era negara tunggal) ditutup gagal.
    if (!b.country_id) { await run("UPDATE budgets SET status = 'failed' WHERE id = ?", [b.id]); continue; }
    if (b.yes > b.no) {
      const country = await one('SELECT * FROM country WHERE id = ?', [b.country_id]);
      if (!country) { await run("UPDATE budgets SET status = 'failed' WHERE id = ?", [b.id]); continue; }
      if (Number(country.treasury) < b.amount) {
        await run("UPDATE budgets SET status = 'failed' WHERE id = ?", [b.id]);
        await notify(b.proposer_id, 'POLITIK', 'Anggaran gagal dicairkan', `"${BUDGET_KINDS[b.kind]?.label || b.kind}" lolos voting, tetapi kas ${country.name} tidak cukup (${b.amount} emas dibutuhkan).`);
      } else {
        await run('UPDATE country SET treasury = treasury - ?, budget_kind = ?, budget_until = ? WHERE id = ?',
          [b.amount, b.kind, now + BUDGET_DURATION_MS, country.id]);
        await run("INSERT INTO treasury_tx (kind, currency, amount, note, country_id, created_at) VALUES ('anggaran','gold',?,?,?,?) RETURNING id",
          [-b.amount, `Anggaran disahkan: ${BUDGET_KINDS[b.kind]?.label || b.kind} (7 hari)`, country.id, now]);
        await run("UPDATE budgets SET status = 'passed' WHERE id = ?", [b.id]);
        await notify(b.proposer_id, 'POLITIK', 'Anggaran disahkan', `"${BUDGET_KINDS[b.kind]?.label || b.kind}" lolos voting (${b.amount} emas dari kas ${country.name}) dan berlaku 7 hari.`);
      }
    } else {
      await run("UPDATE budgets SET status = 'failed' WHERE id = ?", [b.id]);
      await notify(b.proposer_id, 'POLITIK', 'Anggaran gagal', `"${BUDGET_KINDS[b.kind]?.label || b.kind}" tidak lolos voting.`);
    }
  }

  // 4c) Pemakzulan (Tahap 5): tutup voting yang berakhir. Lolos = presiden
  // dicopot (president_id = NULL) sampai pemilu berikutnya; semua warga
  // diberitahu. Gagal = presiden tetap menjabat.
  const impeachments = await sql("SELECT * FROM impeachments WHERE status = 'voting' AND ends_at <= ?", [now]);
  for (const imp of impeachments) {
    if (!imp.country_id) { await run("UPDATE impeachments SET status = 'failed' WHERE id = ?", [imp.id]); continue; }
    const impCountry = await one('SELECT * FROM country WHERE id = ?', [imp.country_id]);
    const title = impCountry ? systemDef(impCountry.system).presidentTitle : 'Presiden';
    if (imp.yes > imp.no) {
      await run("UPDATE impeachments SET status = 'passed' WHERE id = ?", [imp.id]);
      await run('UPDATE country SET president_id = NULL WHERE id = ? AND president_id = ?', [imp.country_id, imp.president_id]);
      await notify(imp.president_id, 'POLITIK', 'Kamu dimakzulkan', `Parlemen meloloskan pemakzulan — kamu tidak lagi menjadi ${title}.`);
      await notifyAll('POLITIK', `${title} dimakzulkan`, `Parlemen meloloskan pemakzulan. Jabatan ${title.toLowerCase()} kosong sampai pemilu berikutnya.`);
    } else {
      await run("UPDATE impeachments SET status = 'failed' WHERE id = ?", [imp.id]);
      await notify(imp.president_id, 'POLITIK', 'Pemakzulan gagal', `Parlemen menolak pemakzulan terhadapmu — kamu tetap menjadi ${title}.`);
    }
  }

  // 4d) Unifikasi wilayah (redesain dunia): tutup voting yang berakhir.
  // Lolos bila YA > TIDAK dan YA minimal 3 — wilayah bergabung ke negara
  // tujuan (hanya bila wilayahnya masih merdeka saat ditutup). Gagal bila
  // tidak memenuhi syarat. Warga wilayah itu diberitahu hasilnya.
  const joins = await sql("SELECT * FROM country_joins WHERE status = 'voting' AND ends_at <= ?", [now]);
  for (const j of joins) {
    const country = await one('SELECT * FROM country WHERE id = ?', [j.country_id]);
    const region = await one('SELECT * FROM regions WHERE id = ?', [j.region_id]);
    const passed = country && region && !region.country_id && j.yes > j.no && j.yes >= COUNTRY_JOIN_MIN_YES;
    if (passed) {
      await run("UPDATE country_joins SET status = 'passed' WHERE id = ?", [j.id]);
      await run("UPDATE regions SET country_id = ?, controller = 'negara', controller_id = ? WHERE id = ? AND country_id IS NULL", [j.country_id, j.country_id, j.region_id]);
      // Notifikasi ke WARGA wilayah itu (kewarganegaraan = home_region_id),
      // bukan sekadar yang sedang berada di sana.
      await run('INSERT INTO notifications (citizen_id, category, title, content, created_at) SELECT id, ?, ?, ?, ? FROM citizens WHERE home_region_id = ?',
        ['POLITIK', `${region.name} bergabung dengan ${country.name}`, `Voting unifikasi lolos (${j.yes} YA vs ${j.no} TIDAK). ${region.name} kini bagian dari ${country.name}.`, now, j.region_id]);
      await notify(j.proposer_id, 'POLITIK', 'Unifikasi berhasil', `${region.name} resmi bergabung dengan ${country.name}.`);
    } else {
      await run("UPDATE country_joins SET status = 'failed' WHERE id = ?", [j.id]);
      await notify(j.proposer_id, 'POLITIK', 'Unifikasi gagal', `Voting unifikasi ${region?.name || 'wilayahmu'} ke ${country?.name || 'negara tujuan'} tidak lolos (${j.yes} YA vs ${j.no} TIDAK${j.yes < COUNTRY_JOIN_MIN_YES ? ` — butuh minimal ${COUNTRY_JOIN_MIN_YES} suara YA` : ''}).`);
    }
  }

  // 5) Perang: tutup yang berakhir, tentukan pemenang — dan UBAH
  // KEPEMILIKAN WILAYAH (Tahap 6, BUG-10): perang yang dimenangkan
  // benar-benar mengubah pengendali wilayah.
  //   - Penyerang menang: wilayah lepas dari negaranya (country_id NULL)
  //     dan dikuasai panglima perang — penyerang dengan kerusakan terbanyak
  //     (seri = citizen_id terkecil). controller='pemberontak'.
  //   - Pembela menang di wilayah yang dikuasai pemberontak: wilayah
  //     dibebaskan (controller='bebas'). Pembela menang di wilayah
  //     bernegara: tidak ada perubahan (negara mempertahankannya).
  const wars = await sql("SELECT * FROM wars WHERE status = 'active' AND ends_at <= ?", [now]);
  for (const w of wars) {
    const winner = w.score_a > w.score_d ? 'attacker' : 'defender';
    await run("UPDATE wars SET status = 'ended', winner = ? WHERE id = ?", [winner, w.id]);
    const fighters = await sql('SELECT DISTINCT citizen_id FROM war_attacks WHERE war_id = ?', [w.id]);
    for (const f of fighters) {
      await notify(f.citizen_id, 'PERANG', `Perang ${w.name} berakhir`,
        winner === 'attacker' ? 'Pemberontak memenangkan wilayah ini.' : `${w.defender_label || 'Pembela'} berhasil mempertahankan wilayah ini.`);
    }
    const region = await one('SELECT * FROM regions WHERE id = ?', [w.region_id]);
    if (!region) continue;
    if (winner === 'attacker') {
      const top = await sql("SELECT citizen_id, SUM(damage) AS dmg FROM war_attacks WHERE war_id = ? AND side = 'attacker' GROUP BY citizen_id ORDER BY dmg DESC, citizen_id ASC LIMIT 1", [w.id]);
      const warlordId = top[0]?.citizen_id || null;
      const warlord = warlordId ? await one('SELECT u.username FROM citizens c JOIN users u ON u.id = c.user_id WHERE c.id = ?', [warlordId]) : null;
      await run("UPDATE regions SET country_id = NULL, controller = 'pemberontak', controller_id = ? WHERE id = ?", [warlordId, w.region_id]);
      // Beritahu warga wilayah itu (kewarganegaraan = home_region_id).
      await run('INSERT INTO notifications (citizen_id, category, title, content, created_at) SELECT id, ?, ?, ?, ? FROM citizens WHERE home_region_id = ?',
        ['PERANG', `${region.name} jatuh ke tangan pemberontak`, warlord ? `${warlord.username} kini menguasai ${region.name} setelah memenangkan perang. Pajak pasar wilayah ini kini mengalir kepadanya.` : `${region.name} kini dikuasai pemberontak.`, now, w.region_id]);
      if (warlordId) await notify(warlordId, 'PERANG', `Kamu menguasai ${region.name}`, `Kamu menjadi panglima perang ${region.name} — pajak pasar wilayah ini kini mengalir kepadamu selama kamu berkuasa.`);
    } else if (region.controller === 'pemberontak') {
      await run("UPDATE regions SET controller = 'bebas', controller_id = NULL WHERE id = ?", [w.region_id]);
      await run('INSERT INTO notifications (citizen_id, category, title, content, created_at) SELECT id, ?, ?, ?, ? FROM citizens WHERE home_region_id = ?',
        ['PERANG', `${region.name} dibebaskan`, `Pembela berhasil merebut kembali ${region.name} dari pemberontak — wilayah ini kembali bebas.`, now, w.region_id]);
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

  // 8) Retensi data (Tahap 4, audit §5.6): hapus data lama yang tumbuh
  // tanpa batas — chat >90 hari, notifikasi TERBACA >30 hari, transaksi
  // pasar/valas + serangan perang >180 hari. Notifikasi yang belum dibaca,
  // buku kas negara (treasury_tx) dan pengumuman TIDAK dihapus.
  const pruned = {};
  pruned.chat = (await run('DELETE FROM chat_messages WHERE created_at < ?', [now - RETENTION.chatDays * 86400000])).changes;
  pruned.notifications = (await run('DELETE FROM notifications WHERE is_read = 1 AND created_at < ?', [now - RETENTION.notifReadDays * 86400000])).changes;
  pruned.market_tx = (await run('DELETE FROM market_tx WHERE created_at < ?', [now - RETENTION.txDays * 86400000])).changes;
  pruned.fx_history = (await run('DELETE FROM fx_history WHERE created_at < ?', [now - RETENTION.txDays * 86400000])).changes;
  pruned.war_attacks = (await run('DELETE FROM war_attacks WHERE created_at < ?', [now - RETENTION.txDays * 86400000])).changes;
  console.log(`[tick] retensi: ${JSON.stringify(pruned)}`);

  await run('UPDATE world SET day = day + 1, last_tick_date = ? WHERE id = 1', [today]);
  const after = await one('SELECT * FROM world WHERE id = 1');
  console.log(`[tick] Hari ${after.day} — ${today}`);

  // 9) Perawatan militer (Tahap 6): tiap unit menelan USD harian. Bila
  // saldo pemilik kurang, unit termahal desersi dulu (dihapus) sampai
  // biayanya cukup — saldo tidak pernah dibuat negatif. Pemilik diberi
  // tahu bila ada desersi.
  const unitHolders = await sql('SELECT citizen_id, unit_type, qty FROM military_units WHERE qty > 0');
  const byCitizen = new Map();
  for (const u of unitHolders) {
    const list = byCitizen.get(u.citizen_id) || [];
    list.push(u);
    byCitizen.set(u.citizen_id, list);
  }
  for (const [citizenId, units] of byCitizen) {
    const upkeep = units.reduce((s, u) => s + (MILITARY_UNITS[u.unit_type]?.upkeep || 0) * u.qty, 0);
    if (upkeep <= 0) continue;
    const owner = await one('SELECT usd FROM citizens WHERE id = ?', [citizenId]);
    if (!owner) continue;
    const balance = Number(owner.usd) || 0;
    let due = upkeep;
    if (balance >= due) {
      await run('UPDATE citizens SET usd = usd - ? WHERE id = ?', [due, citizenId]);
      continue;
    }
    // Desersi: hapus unit dengan perawatan tertinggi dulu, sampai biaya
    // sisa terjangkau saldo — atau semua unit bila saldo 0.
    const sorted = [...units].sort((a, b) => (MILITARY_UNITS[b.unit_type]?.upkeep || 0) - (MILITARY_UNITS[a.unit_type]?.upkeep || 0));
    const deserted = [];
    for (const u of sorted) {
      if (balance >= due) break;
      deserted.push(`${u.qty}× ${MILITARY_UNITS[u.unit_type]?.name || u.unit_type}`);
      await run('DELETE FROM military_units WHERE citizen_id = ? AND unit_type = ?', [citizenId, u.unit_type]);
      due -= (MILITARY_UNITS[u.unit_type]?.upkeep || 0) * u.qty;
    }
    if (due > 0) await run('UPDATE citizens SET usd = usd - ? WHERE id = ? AND usd >= ?', [due, citizenId, due]);
    await notify(citizenId, 'PERANG', 'Pasukanmu desersi', `Kamu tidak mampu membayar perawatan ${fmtRp(upkeep)}/hari (saldo ${fmtRp(balance)}) — desersi: ${deserted.join(', ')}.`);
  }

  // 10) Event dunia mingguan (Tahap 6): bila minggu berganti, umumkan
  // event baru ke SEMUA warga (notifikasi SISTEM) — satu-satunya "bot"
  // yang diizinkan: pengumuman sistem, bukan warga palsu.
  const oldEvent = worldEventFor(world.day);
  const newEvent = worldEventFor(after.day);
  if (oldEvent.key !== newEvent.key) {
    await notifyAll('SISTEM', `${newEvent.icon} Event Dunia: ${newEvent.name}`,
      `${newEvent.desc} Berlaku sampai hari ${worldEventEndsDay(after.day)}.`);
  }
  return { ticked: true, day: after.day };
}

let ticking = false;
export async function maybeTick() {
  if (ticking) return;
  ticking = true;
  try { await runDailyTick(); } catch (e) { console.error('[tick] gagal:', e.message); }
  finally { ticking = false; }
}
