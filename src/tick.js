// Daily tick Parlementer: dunia maju 1 hari tiap tengah malam.
// Dipanggil otomatis saat ada request (cek tanggal) + interval 10 menit.
// Aman di Render free (tanpa cron eksternal): tick jalan saat ada yang membuka game.
import { sql, one, run, getParliamentOpensAt } from './db.js';
import { declareCountryWar } from './api-civic.js';
import { fmtRp } from './util.js';
import { DAILY_PRODUCTION, PRODUCTION_INPUT, MILITARY_UNITS, worldEventFor, worldEventEndsDay, RETENTION, productionWithBonus, BUDGET_KINDS, BUDGET_DURATION_MS, lawEffectText, COUNTRY_IDEOLOGIES, GOVERNMENT_SYSTEMS, systemDef, COUNTRY_JOIN_MIN_YES, DAY_MS, ELECTION_VOTE_MS, PRESIDENT_ELECTION_DELAY_DAYS, PARLIAMENT_ELECTION_CYCLE_DAYS, PARLIAMENT_PETITION_PER_REGION, PARLIAMENT_MAJORITY, COUNTRY_NAME_PLACEHOLDER } from './game.js';

function todayStr(d = new Date()) { return d.toISOString().slice(0, 10); }

// Jadwalkan pemilu PER NEGARA (redesain dunia — dulu satu pasang pemilu
// global). Dijalankan tiap tick + saat server siap (app.js ensureReady).
// - Presiden: pemilu otomatis tiap 7 hari HANYA untuk sistem presidensial /
//   parlementer. Imperial/diktator TIDAK punya pemilu otomatis — pemilu
//   pengisi kekosongan dijadwalkan sekali bila jabatan presiden kosong.
// - Parlemen: pemilu PERTAMA paling cepat saat parlemen dibuka
//   (28 Nov 2026 20:00 WIB — dari db_meta, bukan hardcode tanggal):
//   opens_at = max(parOpensAt, now). Siklus 30 hari HANYA untuk pemilu
//   parlemen BERIKUTNYA (setelah satu pemilu parlemen negara itu berstatus
//   closed) — v5.7.4 (aturan pemilik 28 Nov 2026: "kenapa pemilu belum
//   dimulai?"). Negara baru sudah membawa jadwal pemilu pertamanya dari
//   pendirian (POST /api/countries) — fungsi ini hanya mengisi bila belum ada.
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
      // v5.7.4: pemilu parlemen PERTAMA (belum pernah ada yang closed)
      // dibuka langsung saat parlemen buka; siklus 30 hari hanya untuk
      // pemilu BERIKUTNYA (setelah satu pemilu parlemen selesai/closed).
      // Petisi ≥5/wilayah TETAP menjadi gate pembukaan (tick §3) — jadwal
      // yang dimajukan tidak melonggarkan petisi.
      const hadClosed = await one("SELECT id FROM elections WHERE country_id = ? AND type = 'parliament' AND status = 'closed' LIMIT 1", [country.id]);
      const opens = hadClosed ? now + PARLIAMENT_ELECTION_CYCLE_DAYS * DAY_MS : Math.max(parOpensAt, now);
      await insertElection(country, 'parliament', opens);
    }
  }
}

// Petisi pembuka pemilu parlemen (v5.7.0, Tugas 6): terpenuhi bila
// MASING-MASING wilayah negara itu punya >= PARLIAMENT_PETITION_PER_REGION
// pendukung. Dukungan dihitung dari election_petitions; pendukung yang
// sudah pindah kewarganegaraan tidak lagi dihitung (JOIN home_region_id).
// CATATAN: wilayah yang total warganya < 5 tidak akan pernah memenuhi
// petisi — pemilu parlemen negara itu tidak bisa dibuka sampai wilayah
// tersebut punya cukup warga (aturan pemilik).
export async function parliamentPetitionMet(election) {
  if (!election?.country_id) return false;
  const regions = await sql('SELECT id FROM regions WHERE country_id = ?', [election.country_id]);
  if (!regions.length) return false;
  for (const r of regions) {
    const row = await one(
      `SELECT COUNT(*) AS n FROM election_petitions ep JOIN citizens c ON c.id = ep.citizen_id AND c.home_region_id = ep.region_id
       WHERE ep.election_id = ? AND ep.region_id = ?`, [election.id, r.id]);
    if ((row?.n || 0) < PARLIAMENT_PETITION_PER_REGION) return false;
  }
  return true;
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
    // (v4.6.0, saran LIO): bahan diambil dari STOK PERUSAHAAN
    // (company_stock — diisi pemilik lewat halaman Industri), BUKAN LAGI
    // diam-diam dari inventaris pemilik.
    let produce = amount;
    const inputs = PRODUCTION_INPUT[co.type] || [];
    const usedInputs = [];
    for (const input of inputs) {
      const inputRow = await one('SELECT id FROM commodities WHERE name = ?', [input.commodity]);
      const stock = inputRow ? await one('SELECT * FROM company_stock WHERE company_id = ? AND commodity_id = ?', [co.id, inputRow.id]) : null;
      const have = stock?.qty || 0;
      produce = Math.min(produce, Math.floor(have / input.perUnit));
      usedInputs.push({ input, stock, have });
    }
    if (inputs.length && produce <= 0) {
      await notify(co.owner_id, 'EKONOMI', `${co.name} kekurangan bahan`,
        `${co.name} tidak berproduksi hari ini: stok bahan habis (butuh ${inputs.map((i) => `${amount * i.perUnit}× ${i.commodity}`).join(' + ')}; stok sekarang ${inputs.map((i, idx) => `${usedInputs[idx].have}× ${i.commodity}`).join(', ')}). Isi stok dari halaman Industri → PERUSAHAANKU → ISI BAHAN.`);
      continue;
    }
    for (const { input, stock } of usedInputs) {
      const used = produce * input.perUnit;
      if (used <= 0) continue;
      if (!stock) { produce = 0; break; } // stok hilang bersamaan — lewati hari ini
      const took = await run('UPDATE company_stock SET qty = qty - ? WHERE id = ? AND qty >= ?', [used, stock.id, used]);
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
  // Parlemen (v5.7.0, Tugas 6): pemilu parlemen HANYA dibuka bila petisi
  // terpenuhi di SEMUA wilayah negara itu DAN parlemen sudah buka
  // (28 Nov 2026 20:00 WIB). Pemilu presiden TIDAK kena gate ini.
  const parOpensAt = await getParliamentOpensAt();
  const due = await sql("SELECT * FROM elections WHERE status = 'scheduled' AND opens_at <= ?", [now]);
  for (const e of due) {
    if (e.type === 'parliament' && e.country_id) {
      if (now < parOpensAt) continue;
      if (!(await parliamentPetitionMet(e))) continue;
    }
    await run("UPDATE elections SET status = 'open' WHERE id = ?", [e.id]);
  }
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
        await notify(top[0].citizen_id, 'POLITIK', `Kamu terpilih jadi ${systemDef(country.system).presidentTitle}!`, `Selamat! Kamu memenangkan pemilu ${systemDef(country.system).presidentTitle.toLowerCase()} ${country.name || COUNTRY_NAME_PLACEHOLDER}.`);
      } else {
        await run("UPDATE elections SET status = 'closed' WHERE id = ?", [e.id]);
      }
    } else {
      // Parlemen: kursi dibagi proporsional dari suara PARTAI langsung
      // (v5.7.0 — warga memilih partai, bukan kandidat), disimpan PER
      // NEGARA di party_seats. Suara lama (candidate_id, era sebelum
      // v5.7.0) tetap dihitung lewat partai kandidatnya supaya pemilu
      // yang sudah berjalan tidak kehilangan suara.
      const votes = await sql(
        `SELECT COALESCE(ev.party_id, ec.party_id) AS party_id, COUNT(*) AS votes
         FROM election_votes ev LEFT JOIN election_candidates ec
           ON ec.election_id = ev.election_id AND ec.citizen_id = ev.candidate_id
         WHERE ev.election_id = ? GROUP BY COALESCE(ev.party_id, ec.party_id)`, [e.id]);
      const total = votes.reduce((s, v) => s + Number(v.votes), 0);
      await run('DELETE FROM party_seats WHERE country_id = ?', [country.id]);
      if (total > 0) {
        let assigned = 0;
        const seatsByParty = new Map();
        for (const v of votes) {
          if (!v.party_id) continue;
          const seats = Math.round((Number(v.votes) / total) * 60);
          seatsByParty.set(v.party_id, (seatsByParty.get(v.party_id) || 0) + seats);
          assigned += seats;
        }
        // Koreksi pembulatan ke 60 kursi pada partai terbesar.
        if (assigned !== 60 && seatsByParty.size) {
          const biggest = [...votes].sort((a, b) => Number(b.votes) - Number(a.votes)).find((v) => v.party_id);
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
        await notify(b.proposer_id, 'POLITIK', 'Anggaran gagal dicairkan', `"${BUDGET_KINDS[b.kind]?.label || b.kind}" lolos voting, tetapi kas ${country.name || COUNTRY_NAME_PLACEHOLDER} tidak cukup (${b.amount} emas dibutuhkan).`);
      } else {
        await run('UPDATE country SET treasury = treasury - ?, budget_kind = ?, budget_until = ? WHERE id = ?',
          [b.amount, b.kind, now + BUDGET_DURATION_MS, country.id]);
        await run("INSERT INTO treasury_tx (kind, currency, amount, note, country_id, created_at) VALUES ('anggaran','gold',?,?,?,?) RETURNING id",
          [-b.amount, `Anggaran disahkan: ${BUDGET_KINDS[b.kind]?.label || b.kind} (7 hari)`, country.id, now]);
        await run("UPDATE budgets SET status = 'passed' WHERE id = ?", [b.id]);
        await notify(b.proposer_id, 'POLITIK', 'Anggaran disahkan', `"${BUDGET_KINDS[b.kind]?.label || b.kind}" lolos voting (${b.amount} emas dari kas ${country.name || COUNTRY_NAME_PLACEHOLDER}) dan berlaku 7 hari.`);
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
        ['POLITIK', `${region.name} bergabung dengan ${country.name || COUNTRY_NAME_PLACEHOLDER}`, `Voting unifikasi lolos (${j.yes} YA vs ${j.no} TIDAK). ${region.name} kini bagian dari ${country.name || COUNTRY_NAME_PLACEHOLDER}.`, now, j.region_id]);
      await notify(j.proposer_id, 'POLITIK', 'Unifikasi berhasil', `${region.name} resmi bergabung dengan ${country.name || COUNTRY_NAME_PLACEHOLDER}.`);
    } else {
      await run("UPDATE country_joins SET status = 'failed' WHERE id = ?", [j.id]);
      await notify(j.proposer_id, 'POLITIK', 'Unifikasi gagal', `Voting unifikasi ${region?.name || 'wilayahmu'} ke ${country?.name || 'negara tujuan'} tidak lolos (${j.yes} YA vs ${j.no} TIDAK${j.yes < COUNTRY_JOIN_MIN_YES ? ` — butuh minimal ${COUNTRY_JOIN_MIN_YES} suara YA` : ''}).`);
    }
  }

  // 4e) Mosi perang (v5.7.0): tutup voting yang berakhir. Lolos bila YA >=
  // 31 (mayoritas 60 kursi) — lalu perang antar-negara dideklarasikan
  // (target divalidasi ulang: bila sudah tidak sah, mosi tetap 'passed'
  // tapi perang tidak jadi — dicatat di notifikasi pengusul).
  const warMotions = await sql("SELECT * FROM war_motions WHERE status = 'voting' AND ends_at <= ?", [now]);
  for (const m of warMotions) {
    const passed = m.yes >= PARLIAMENT_MAJORITY;
    if (passed) {
      await run("UPDATE war_motions SET status = 'passed' WHERE id = ?", [m.id]);
      const country = await one('SELECT * FROM country WHERE id = ?', [m.country_id]);
      const region = await one('SELECT * FROM regions WHERE id = ?', [m.region_id]);
      try {
        await declareCountryWar({ one, sql, run }, country, region);
        await notify(m.proposer_id, 'PERANG', 'Mosi perang lolos', `Parlemen menyetujui perang atas ${region?.name || 'wilayah target'} — perang antar-negara dimulai.`);
      } catch (e) {
        await notify(m.proposer_id, 'PERANG', 'Mosi perang lolos, perang batal', `Parlemen menyetujui perang atas ${region?.name || 'wilayah target'}, tetapi targetnya sudah tidak sah saat penutupan (${e.message}) — perang tidak dideklarasikan.`);
      }
    } else {
      await run("UPDATE war_motions SET status = 'failed' WHERE id = ?", [m.id]);
      await notify(m.proposer_id, 'PERANG', 'Mosi perang gagal', `Mosi perang tidak lolos voting parlemen (${m.yes} YA vs ${m.no} TIDAK — butuh minimal ${PARLIAMENT_MAJORITY} suara YA).`);
    }
  }

  // 4f) Mosi nama negara (v5.7.0): tutup voting yang berakhir. Lolos bila
  // YA >= 31 — lalu country.name diisi (keunikan dicek ulang: bila nama
  // sudah dipakai negara lain, mosi tetap 'passed' tapi nama tidak berubah
  // — dicatat di notifikasi pengusul).
  const nameMotions = await sql("SELECT * FROM name_motions WHERE status = 'voting' AND ends_at <= ?", [now]);
  for (const m of nameMotions) {
    const passed = m.yes >= PARLIAMENT_MAJORITY;
    if (passed) {
      const dup = await one('SELECT id FROM country WHERE LOWER(name) = LOWER(?) AND id <> ?', [m.name, m.country_id]);
      if (dup) {
        await run("UPDATE name_motions SET status = 'failed' WHERE id = ?", [m.id]);
        await notify(m.proposer_id, 'POLITIK', 'Mosi nama gagal diterapkan', `Mosi penetapan nama "${m.name}" lolos voting, tetapi nama itu sudah dipakai negara lain — nama negaramu tidak berubah.`);
      } else {
        await run("UPDATE name_motions SET status = 'passed' WHERE id = ?", [m.id]);
        await run('UPDATE country SET name = ? WHERE id = ?', [m.name, m.country_id]);
        await notify(m.proposer_id, 'POLITIK', 'Negara resmi bernama', `Parlemen menetapkan nama negaramu: ${m.name}.`);
      }
    } else {
      await run("UPDATE name_motions SET status = 'failed' WHERE id = ?", [m.id]);
      await notify(m.proposer_id, 'POLITIK', 'Mosi nama gagal', `Mosi penetapan nama "${m.name}" tidak lolos voting parlemen (${m.yes} YA vs ${m.no} TIDAK — butuh minimal ${PARLIAMENT_MAJORITY} suara YA).`);
    }
  }

  // 5) Perang: tutup yang berakhir, tentukan pemenang — dan UBAH
  // KEPEMILIKAN WILAYAH (Tahap 6, BUG-10): perang yang dimenangkan
  // benar-benar mengubah pengendali wilayah. Hasil tergantung JENIS
  // perang (v5.7.0):
  //   - 'country_war' (negara vs negara): penyerang menang -> wilayah
  //     DIJAJAH (occupied_by = negara penyerang, occupied_from = negara
  //     asal; country_id TETAP negara asal). Pembela menang -> tidak ada
  //     perubahan.
  //   - 'liberation' (pemberontakan di wilayah jajahan): pemberontak
  //     menang -> wilayah DIBEBASKAN (occupied_by/from dibersihkan,
  //     kembali ke negara asal). Pembela (penjajah) menang -> tetap dijajah.
  //   - 'rebellion' (lama): penyerang menang -> wilayah lepas dari
  //     negaranya (country_id NULL) dan dikuasai panglima perang
  //     (controller='pemberontak'); pembela menang di wilayah pemberontak
  //     -> dibebaskan (controller='bebas'); pembela menang di wilayah
  //     bernegara -> tidak ada perubahan.
  const wars = await sql("SELECT * FROM wars WHERE status = 'active' AND ends_at <= ?", [now]);
  for (const w of wars) {
    const winner = w.score_a > w.score_d ? 'attacker' : 'defender';
    await run("UPDATE wars SET status = 'ended', winner = ? WHERE id = ?", [winner, w.id]);
    const attackerWinText = w.kind === 'country_war'
      ? `${w.attacker_label} memenangkan perang atas wilayah ini.`
      : w.kind === 'liberation'
        ? 'Pemberontakan berhasil — wilayah ini dibebaskan dari penjajahan.'
        : 'Pemberontak memenangkan wilayah ini.';
    const fighters = await sql('SELECT DISTINCT citizen_id FROM war_attacks WHERE war_id = ?', [w.id]);
    for (const f of fighters) {
      await notify(f.citizen_id, 'PERANG', `Perang ${w.name} berakhir`,
        winner === 'attacker' ? attackerWinText : `${w.defender_label || 'Pembela'} berhasil mempertahankan wilayah ini.`);
    }
    const region = await one('SELECT * FROM regions WHERE id = ?', [w.region_id]);
    if (!region) continue;
    if (w.kind === 'country_war') {
      if (winner === 'attacker') {
        // Hanya jajah bila wilayahnya masih milik negara bertahan (bukan
        // sudah direbut/dijajah pihak lain sejak perang dimulai).
        if (region.country_id === w.defender_country_id && !region.occupied_by) {
          await run('UPDATE regions SET occupied_by = ?, occupied_from = ? WHERE id = ?', [w.attacker_country_id, w.defender_country_id, w.region_id]);
          const attackerCountry = w.attacker_country_id ? await one('SELECT name FROM country WHERE id = ?', [w.attacker_country_id]) : null;
          const aName = attackerCountry?.name || COUNTRY_NAME_PLACEHOLDER;
          await run('INSERT INTO notifications (citizen_id, category, title, content, created_at) SELECT id, ?, ?, ?, ? FROM citizens WHERE home_region_id = ?',
            ['PERANG', `${region.name} dijajah`, `${aName} merebut ${region.name} — wilayah ini kini dijajah oleh ${aName}. Pajak pasar wilayah ini mengalir ke kas penjajah.`, now, w.region_id]);
        }
      }
      // Pembela menang: tidak ada perubahan.
    } else if (w.kind === 'liberation') {
      if (winner === 'attacker' && region.occupied_by) {
        await run('UPDATE regions SET occupied_by = NULL, occupied_from = NULL WHERE id = ?', [w.region_id]);
        await run('INSERT INTO notifications (citizen_id, category, title, content, created_at) SELECT id, ?, ?, ?, ? FROM citizens WHERE home_region_id = ?',
          ['PERANG', `${region.name} dibebaskan`, `Pemberontakan berhasil — ${region.name} bebas dari penjajahan dan kembali ke negara asalnya.`, now, w.region_id]);
      }
      // Pembela (penjajah) menang: wilayah tetap dijajah.
    } else {
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
