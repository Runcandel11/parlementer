// API kewargaan Parlementer: negara, partai, parlemen, pemilu, perang, pers, chat, DM.
import { sql, one, run, tx, forUpdate, convoyBuildings, getParliamentOpensAt, getWorldDay, missionValue, setMissionValue, markChronicleDone } from './db.js';
import { authRequired, citizenRequired, loadCitizen, todayStr, parseImageDataUrl, requireCredit, fmtRp } from './util.js';
import { warDamage, warDamageWithBonus, unitDamageMult, worldEventFor, MILITARY_UNITS, CHRONICLE, LAW_KINDS, BUDGET_KINDS, BUDGET_VOTE_DAYS, MOBILIZE_COST_GOLD, MOBILIZE_DURATION_MS, MOBILIZE_DAMAGE_MULT, HOLIDAY_COST_GOLD, HOLIDAY_ENERGY, HOLIDAY_COOLDOWN_MS, PACT_KINDS, DEFENSE_PACT_DAMAGE_MULT, BUDGET_WAR_DAMAGE_MULT, PARLIAMENT_OPENS_AT_DEFAULT, PARLIAMENT_MAJORITY, WAR_MOTION_VOTE_DAYS, NAME_MOTION_VOTE_DAYS, PARLIAMENT_PETITION_PER_REGION, COUNTRY_NAME_PLACEHOLDER, COUNTRY_NAME_MIN, COUNTRY_NAME_MAX, MOTION_COST_GOLD, WAR_ATTACK_ENERGY_MIN, WAR_ATTACK_ENERGY_MAX, WAR_HOME_BONUS_MULT, WAR_DURATION_MS, parliamentCountdownText, COUNTRY_IDEOLOGIES, GOVERNMENT_SYSTEMS, ideologyDef, systemDef, COUNTRY_FORM_MIN_LEVEL, COUNTRY_FORM_COST_GOLD, COUNTRY_JOIN_MIN_LEVEL, COUNTRY_JOIN_VOTE_DAYS, COUNTRY_JOIN_MIN_YES, PRESIDENT_ELECTION_DELAY_DAYS, CREDIT_MIN_FOR, IMPORT_TAX, DAY_MS, ELECTION_VOTE_MS, ELECTION_VOTE_MIN_AGE_MS, CHAT_COOLDOWN_MS, CHAT_COUNT_WINDOW_MS, CHAT_COUNT_MIN_WORDS } from './game.js';

// Ruang chat publik yang selalu ada. Ruang wilayah (region_<id>) bersifat
// dinamis — divalidasi terpisah di validateRoom (hanya wilayah sendiri).
const CHAT_ROOMS = ['global', 'indonesia'];

// Kirim notifikasi ke satu warga (dipakai juga oleh sistem banding).
export async function notify(citizenId, category, title, content = '') {
  await run('INSERT INTO notifications (citizen_id, category, title, content, created_at) VALUES (?,?,?,?,?) RETURNING id',
    [citizenId, category, title, content, Date.now()]);
}

// Kirim notifikasi ke SEMUA warga (pengumuman negara: mobilisasi, hari
// libur, hasil pemakzulan). Satu INSERT ... SELECT — atomik.
export async function notifyAll(category, title, content = '') {
  await run('INSERT INTO notifications (citizen_id, category, title, content, created_at) SELECT id, ?, ?, ?, ? FROM citizens',
    [category, title, content, Date.now()]);
}

// Kekuatan militer warga (Tahap 6): jumlah (qty × power) semua unitnya.
// Dipakai api-civic (serang + detail perang) dan api-core (/api/me,
// profil). Tanpa unit = 0. t = handle tx (opsional) — tanpa t memakai
// koneksi biasa; ini hanya baca, tidak perlu kunci baris.
export async function militaryPowerOf(citizenId, t) {
  const rows = t
    ? await t.sql('SELECT unit_type, qty FROM military_units WHERE citizen_id = ?', [citizenId])
    : await sql('SELECT unit_type, qty FROM military_units WHERE citizen_id = ?', [citizenId]);
  return rows.reduce((s, r) => s + (MILITARY_UNITS[r.unit_type]?.power || 0) * (r.qty || 0), 0);
}
export async function militaryUnitsOf(citizenId, t) {
  const rows = t
    ? await t.sql('SELECT unit_type, qty FROM military_units WHERE citizen_id = ? AND qty > 0 ORDER BY unit_type', [citizenId])
    : await sql('SELECT unit_type, qty FROM military_units WHERE citizen_id = ? AND qty > 0 ORDER BY unit_type', [citizenId]);
  return rows;
}

// --- Helper bersama Tahap 5 (dipakai juga api-core.js + tick.js) ---
// REDESAIN DUNIA (27 Nov 2026): TIDAK ADA lagi satu negara global (dulu
// country id=1). Setiap warga punya negara lewat wilayahnya
// (regions.country_id; NULL = wilayah merdeka / tidak bernegara).
// getMyCountry(t, citizen) = satu-satunya cara mengambil "negara saya":
// null bila wilayahnya merdeka. KEWARGANEGARAAN mengikuti home_region_id
// (wilayah asal) — BUKAN lokasi saat ini: bepergian (travel = kunjungan)
// tidak memindahkan kewarganegaraan; hanya aksi "Pindah Kewarganegaraan"
// yang mengubah home_region_id (lihat POST /api/regions/move).
export async function getMyCountry(t, citizen) {
  if (!citizen?.home_region_id) return null;
  const reg = await t.one('SELECT country_id FROM regions WHERE id = ?', [citizen.home_region_id]);
  if (!reg?.country_id) return null;
  return (await t.one('SELECT * FROM country WHERE id = ?', [reg.country_id])) || null;
}
// Nama negara untuk DITAMPILKAN (v5.7.0): negara tanpa nama (NULL)
// dirender 'Belum Dinamai' di semua tempat. nameUnset menandai negara
// yang namanya belum ditetapkan parlemen.
export function countryDisplayName(c) {
  return c?.name || COUNTRY_NAME_PLACEHOLDER;
}
// Ringkasan negara untuk respons API (tanpa kolom internal).
export function countrySummary(c) {
  if (!c) return null;
  return {
    id: c.id, name: countryDisplayName(c), nameUnset: !c.name, ideology: c.ideology, system: c.system,
    capital: c.capital, founded: c.founded, president_id: c.president_id,
    tax_income: Number(c.tax_income), tax_production: Number(c.tax_production),
    tax_import: Number(c.tax_import), tax_export: Number(c.tax_export),
    treasury: Number(c.treasury), treasury_usd: Number(c.treasury_usd),
    admin_pay_mult: Number(c.admin_pay_mult), travel_tickets: Number(c.travel_tickets),
  };
}
// Tarif pajak penghasilan yang berlaku untuk warga negara ini, sebagai
// pecahan (0.02). Tanpa negara = 0% (tidak ada negara = tidak ada pajak).
// Liberalisme: −1 poin dari tarif (minimal 0%).
export function getIncomeTaxRate(t, country, day = null) {
  const base = Number(country?.tax_income) || 0;
  const delta = ideologyDef(country?.ideology).taxDelta;
  let rate = Math.max(0, base + delta) / 100;
  // Event dunia (Tahap 6): minggu Pasar Bergairah -> pajak −1 poin.
  // day = null (pemanggil lama / tes tanpa hari) = tanpa efek event.
  if (day && worldEventFor(day).key === 'booming') rate = Math.max(0, rate - 0.01);
  return rate;
}
// Tarif pajak impor yang berlaku untuk pembeli ini (pecahan). Warga
// bernegara memakai tarif impor NEGARANYA (country.tax_import — bisa diubah
// parlemen lewat UU jenis 'tax_import', 1–5%, seperti pajak penghasilan);
// tanpa negara = IMPORT_TAX (2%, tarif default). Sebelum Tahap 7 kolom
// tax_import tidak pernah dibaca: pasar global selalu memakai konstanta
// IMPORT_TAX meski negara pembeli menetapkan tarif lain (data mati yang
// juga ditampilkan di halaman Negara — angka di UI tidak berlaku di pasar).
export function getImportTaxRate(t, country) {
  if (!country) return IMPORT_TAX;
  const v = Number(country.tax_import);
  return Number.isFinite(v) ? v / 100 : IMPORT_TAX;
}
// Pengali upah lowongan ADMIN untuk warga negara ini. Sosialisme: ×1.1
// (dikalikan di atas admin_pay_mult hasil UU — keduanya berlaku).
export function getAdminPayMult(t, country) {
  const base = Number(country?.admin_pay_mult) || 1;
  return base * ideologyDef(country?.ideology).adminPayMult;
}
// Tiket perjalanan yang dibutuhkan warga negara ini. Tanpa negara = 1.
export function getTravelTickets(t, country) {
  return Number(country?.travel_tickets) || 1;
}
// Gate parlemen: sebelum 28 Nov 2026 20:00 WIB fitur parlemen (UU, anggaran, pemakzulan)
// terkunci. Mengembalikan { open, opensAt } — opensAt dari db_meta.
export async function parliamentStatus() {
  const opensAt = await getParliamentOpensAt();
  return { open: Date.now() >= opensAt, opensAt };
}
export function parliamentLockedError(opensAt) {
  return `Parlemen baru dibuka ${new Date(opensAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })} — ${parliamentCountdownText(Date.now(), opensAt)} lagi.`;
}
// Anggaran yang sedang berlaku (kind) atau null bila tidak ada/kedaluwarsa.
export function budgetActive(country, now = Date.now()) {
  if (!country || !country.budget_kind) return null;
  if (Number(country.budget_until) <= now) return null;
  return country.budget_kind;
}
// Jabatan menteri seorang warga ('economy'|'foreign'|'home'|'defense') atau null.
export function ministerRole(country, citizenId) {
  if (!country || !citizenId) return null;
  if (country.minister_economy === citizenId) return 'economy';
  if (country.minister_foreign === citizenId) return 'foreign';
  if (country.minister_home === citizenId) return 'home';
  if (country.minister_defense === citizenId) return 'defense';
  return null;
}
export async function isMpCitizen(citizen) {
  if (!citizen?.party_id || !citizen?.home_region_id) return false;
  // Kursi parlemen dihitung PER NEGARA (party_seats): anggota partai hanya
  // anggota parlemen bila partainya punya kursi di parlemen NEGARANYA
  // (kewarganegaraan = wilayah asal).
  const row = await one(
    `SELECT ps.seats FROM party_seats ps JOIN regions r ON r.country_id = ps.country_id
     WHERE ps.party_id = ? AND r.id = ? AND ps.seats > 0`,
    [citizen.party_id, citizen.home_region_id]);
  return !!row;
}
// Apakah ada perjanjian dagang AKTIF antara organisasi pembeli & penjual?
// Bila ya, pajak penghasilan transaksi mereka dipotong setengah.
export async function hasTradePact(t, buyerId, sellerId) {
  if (!buyerId || !sellerId || buyerId === sellerId) return false;
  const [a, b] = await Promise.all([
    t.one('SELECT org_id FROM org_members WHERE citizen_id = ?', [buyerId]),
    t.one('SELECT org_id FROM org_members WHERE citizen_id = ?', [sellerId]),
  ]);
  if (!a || !b || a.org_id === b.org_id) return false;
  const lo = Math.min(a.org_id, b.org_id), hi = Math.max(a.org_id, b.org_id);
  const pact = await t.one("SELECT id FROM org_pacts WHERE org_a_id = ? AND org_b_id = ? AND kind = 'trade' AND status = 'active'", [lo, hi]);
  return !!pact;
}
// Apakah warga ini anggota organisasi yang punya pakta pertahanan AKTIF?
export async function hasDefensePact(t, citizenId) {
  const mine = await t.one('SELECT org_id FROM org_members WHERE citizen_id = ?', [citizenId]);
  if (!mine) return false;
  const pact = await t.one("SELECT id FROM org_pacts WHERE kind = 'defense' AND status = 'active' AND (org_a_id = ? OR org_b_id = ?)", [mine.org_id, mine.org_id]);
  return !!pact;
}
// --- Aliansi antar-negara + perang antar-negara (v5.7.0) ---
// Dua negara bersekutu bila ada baris country_alliances 'active' di
// antara keduanya (pasangan disimpan terurut a < b).
export async function areAllied(t, aId, bId) {
  if (!aId || !bId || aId === bId) return false;
  const lo = Math.min(aId, bId), hi = Math.max(aId, bId);
  const row = await t.one("SELECT id FROM country_alliances WHERE country_a_id = ? AND country_b_id = ? AND status = 'active'", [lo, hi]);
  return !!row;
}

// Validasi target perang antar-negara (v5.7.0) — dipakai deklarasi
// langsung (Kemenhan) + mosi perang + penutupan mosi di tick.js.
// Melempar Error(status 400) bila target tidak sah.
export async function checkWarTarget(t, attackerCountry, region) {
  if (!attackerCountry) throw Object.assign(new Error('Negaramu tidak ditemukan.'), { status: 400 });
  if (!region) throw Object.assign(new Error('Wilayah tidak ditemukan.'), { status: 404 });
  if (!region.country_id) throw Object.assign(new Error(`${region.name} masih merdeka — perang antar-negara hanya bisa menyerang wilayah bernegara.`), { status: 400 });
  if (Number(region.country_id) === Number(attackerCountry.id)) throw Object.assign(new Error('Tidak bisa menyerang wilayah negaramu sendiri.'), { status: 400 });
  if (region.occupied_by) throw Object.assign(new Error(`${region.name} sedang dijajah — bebaskan dulu lewat pemberontakan.`), { status: 400 });
  const targetCountry = await t.one('SELECT * FROM country WHERE id = ?', [region.country_id]);
  if (!targetCountry) throw Object.assign(new Error('Negara pemilik wilayah tidak ditemukan.'), { status: 400 });
  if (await areAllied(t, attackerCountry.id, targetCountry.id)) throw Object.assign(new Error(`${countryDisplayName(targetCountry)} adalah sekutu negaramu — negara aliansi tidak bisa diserang.`), { status: 400 });
  const active = await t.one("SELECT id FROM wars WHERE region_id = ? AND status = 'active'", [region.id]);
  if (active) throw Object.assign(new Error('Sudah ada perang aktif di wilayah ini.'), { status: 400 });
  return targetCountry;
}

// Deklarasi perang antar-negara (v5.7.0) — dipakai endpoint langsung
// (Kemenhan) + penutupan mosi perang di tick.js. t = handle query
// (tx di endpoint, { one, sql, run } di tick). Validasi penuh; melempar
// Error(status 400) bila tidak valid. Mengembalikan id perang.
// Aturan: penyerang = negara pemanggil; target = wilayah milik negara
// LAIN yang belum dijajah, tanpa perang aktif, dan bukan sekutu.
export async function declareCountryWar(t, attackerCountry, region) {
  const targetCountry = await checkWarTarget(t, attackerCountry, region);
  const aName = countryDisplayName(attackerCountry);
  const dName = countryDisplayName(targetCountry);
  const ins = await t.run(
    `INSERT INTO wars (name, region_id, attacker_label, defender_label, kind, attacker_country_id, defender_country_id, ends_at, created_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
    [`Perang ${region.name}`, region.id, aName, dName, 'country_war', attackerCountry.id, targetCountry.id, Date.now() + WAR_DURATION_MS, Date.now()]);
  return ins.id;
}

// Pengali kerusakan perang dari bonus Tahap 5 (anggaran perang, mobilisasi,
// pakta pertahanan) + ideologi Nasionalisme (+10%) + label bonus yang
// diterapkan (untuk ditampilkan). country = null (wilayah merdeka) berarti
// hanya pakta pertahanan yang bisa berlaku.
export async function warDamageBonus(t, citizenId, country) {
  const now = Date.now();
  let mult = 1;
  const labels = [];
  if (budgetActive(country, now) === 'war') { mult *= BUDGET_WAR_DAMAGE_MULT; labels.push('Dana Perang +10%'); }
  if (Number(country?.mobilization_until) > now) { mult *= MOBILIZE_DAMAGE_MULT; labels.push('Mobilisasi +10%'); }
  if (await hasDefensePact(t, citizenId)) { mult *= DEFENSE_PACT_DAMAGE_MULT; labels.push('Pakta Pertahanan +10%'); }
  if (country && ideologyDef(country.ideology).warDamageMult > 1) { mult *= ideologyDef(country.ideology).warDamageMult; labels.push('Nasionalisme +10%'); }
  // Event dunia (Tahap 6): minggu Darurat Militer -> kerusakan +10%.
  const wday = await getWorldDay(t);
  if (worldEventFor(wday).key === 'darurat') { mult *= 1.1; labels.push('Darurat Militer +10%'); }
  return { mult, labels };
}

export function registerCivic(app) {
  const r = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  async function chronicleDone(citizen, key) {
    await markChronicleDone(citizen.id, key);
  }
  function partyTag(citizen) { return citizen.party_tag || null; }

  // ---------- NEGARA ----------
  // Halaman Negara: dua keadaan.
  // 1) Pemanggil BERWARGA NEGARA: tampilkan negaranya (ideologi + efek,
  //    sistem + efek, presiden bergelar sesuai sistem, menteri, kas, wilayah
  //    anggota, aturan pembentukan negara).
  // 2) Pemanggil di wilayah MERDEKA: country = null + daftar semua negara
  //    yang ada + aturan pembentukan negara + usulan unifikasi yang terbuka
  //    untuk wilayahnya.
  app.get('/api/country', authRequired, citizenRequired, r(async (req, res) => {
    const country = await getMyCountry({ one }, req.citizen);
    // myRegion di sini = wilayah ASAL (kewarganegaraan): usulan unifikasi
    // yang terbuka untukmu adalah usulan untuk wilayah asalmu.
    const myRegion = await one("SELECT r.*, CASE WHEN r.country_id IS NULL THEN NULL ELSE COALESCE(c.name, 'Belum Dinamai') END AS country_name FROM regions r LEFT JOIN country c ON c.id = r.country_id WHERE r.id = ?", [req.citizen.home_region_id]);
    const countries = await sql(
      `SELECT c.*, (SELECT COUNT(*) FROM regions WHERE country_id = c.id) AS region_count,
        (SELECT COUNT(*) FROM citizens ci JOIN regions r ON r.id = ci.home_region_id WHERE r.country_id = c.id) AS citizen_count,
        (SELECT u.username FROM citizens pc JOIN users u ON u.id = pc.user_id WHERE pc.id = c.president_id) AS president_name
       FROM country c ORDER BY c.id ASC`);
    const president = country?.president_id
      ? await one('SELECT u.username FROM citizens c JOIN users u ON u.id = c.user_id WHERE c.id = ?', [country.president_id]) : null;
    const ministers = {};
    if (country) {
      for (const [key, col] of [['economy', 'minister_economy'], ['foreign', 'minister_foreign'], ['home', 'minister_home'], ['defense', 'minister_defense']]) {
        const id = country[col];
        ministers[key] = id ? (await one('SELECT u.username FROM citizens c JOIN users u ON u.id = c.user_id WHERE c.id = ?', [id]))?.username || 'Kosong' : 'Kosong';
      }
    }
    const memberRegions = country ? await sql('SELECT id, name, type FROM regions WHERE country_id = ? ORDER BY name', [country.id]) : [];
    const wars = country
      ? await sql("SELECT w.*, r.name AS region_name FROM wars w JOIN regions r ON r.id = w.region_id WHERE w.status = 'active' AND r.country_id = ?", [country.id])
      : await sql("SELECT w.*, r.name AS region_name FROM wars w JOIN regions r ON r.id = w.region_id WHERE w.status = 'active'");
    const treasuryTx = country
      ? await sql('SELECT * FROM treasury_tx WHERE country_id = ? ORDER BY created_at DESC LIMIT 20', [country.id])
      : [];
    // Usulan unifikasi yang terbuka untuk wilayah pemanggil (bila merdeka).
    const openJoins = myRegion?.country_id ? [] : await sql(
      `SELECT j.*, COALESCE(c.name, 'Belum Dinamai') AS country_name FROM country_joins j JOIN country c ON c.id = j.country_id
       WHERE j.region_id = ? AND j.status = 'voting' AND j.ends_at > ? ORDER BY j.created_at DESC`,
      [req.citizen.home_region_id, Date.now()]);
    const myJoinVotes = openJoins.length
      ? await sql('SELECT join_id, vote FROM country_join_votes WHERE citizen_id = ? AND join_id IN (' + openJoins.map(() => '?').join(',') + ')', [req.citizen.id, ...openJoins.map((j) => j.id)])
      : [];
    const par = await parliamentStatus();
    // Pemilu berikutnya (v5.7.5): satu sumber jadwal — baris scheduled/open
    // paling awal dari tabel elections negara pemanggil (dipakai halaman
    // Negara "Pemilu Berikutnya" + halaman Parlemen; halaman Pemilu sudah
    // menampilkan opens_at tiap pemilu + panel petisi).
    const nextElection = country ? await one(
      "SELECT id, type, status, opens_at FROM elections WHERE country_id = ? AND status IN ('scheduled','open') ORDER BY opens_at ASC LIMIT 1",
      [country.id]) : null;
    // Barang yang bisa disumbangkan (v4.6.0): inventaris tier 1 pemanggil
    // (nama + jumlah) — dipakai dropdown sumbangan bahan di halaman Negara.
    const myDonateItems = await sql(
      `SELECT c.name, i.qty FROM inventory i JOIN commodities c ON c.id = i.commodity_id
       WHERE i.citizen_id = ? AND i.tier = 1 AND i.qty > 0 ORDER BY c.name`,
      [req.citizen.id]);
    // Aliansi negara pemanggil (v5.7.0) — untuk halaman Negara.
    const alliances = country ? await sql(
      `SELECT a.id, a.status, a.proposer_id,
        CASE WHEN a.country_a_id = ? THEN b.name ELSE aa.name END AS other_name,
        CASE WHEN a.country_a_id = ? THEN a.country_b_id ELSE a.country_a_id END AS other_id
       FROM country_alliances a
       LEFT JOIN country aa ON aa.id = a.country_a_id
       LEFT JOIN country b ON b.id = a.country_b_id
       WHERE a.country_a_id = ? OR a.country_b_id = ? ORDER BY a.created_at DESC`,
      [country.id, country.id, country.id, country.id]) : [];
    res.json({
      country: countrySummary(country),
      countryFull: country ? { ...country, name: countryDisplayName(country), nameUnset: !country.name } : null,
      myRegion: myRegion ? { id: myRegion.id, name: myRegion.name, type: myRegion.type, country_id: myRegion.country_id, country_name: myRegion.country_name } : null,
      countries: countries.map((c) => ({ ...countrySummary(c), region_count: Number(c.region_count), citizen_count: Number(c.citizen_count), president_name: c.president_name || 'Kosong', president_title: systemDef(c.system).presidentTitle })),
      president: president?.username || 'Kosong',
      presidentTitle: country ? systemDef(country.system).presidentTitle : 'Presiden',
      ministers, memberRegions, wars, treasuryTx, openJoins,
      alliances: alliances.map((a) => ({ id: a.id, otherId: a.other_id, otherName: a.other_name || COUNTRY_NAME_PLACEHOLDER, status: a.status, outgoing: a.proposer_id === req.citizen.id })),
      myDonateItems: myDonateItems.map((i) => ({ name: i.name, qty: Number(i.qty) })),
      myJoinVotes: Object.fromEntries(myJoinVotes.map((v) => [v.join_id, v.vote])),
      // Tahap 5: jabatan pemanggil + status wewenang menteri (untuk UI).
      myMinisterRole: ministerRole(country, req.citizen.id),
      isPresident: !!country && country.president_id === req.citizen.id,
      activeBudget: country && budgetActive(country) ? { kind: budgetActive(country), until: Number(country.budget_until) } : null,
      mobilizationUntil: Number(country?.mobilization_until) || 0,
      holidayAt: Number(country?.holiday_at) || 0,
      parliamentOpen: par.open, parliamentOpensAt: par.opensAt,
      nextElection: nextElection ? { id: nextElection.id, type: nextElection.type, status: nextElection.status, opensAt: Number(nextElection.opens_at) } : null,
      // Aturan pembentukan negara + unifikasi (ditampilkan di halaman
      // Negara — pemilik yang menetapkan, bisa diubah).
      formationRules: {
        minLevel: COUNTRY_FORM_MIN_LEVEL, costGold: COUNTRY_FORM_COST_GOLD,
        joinMinLevel: COUNTRY_JOIN_MIN_LEVEL, joinVoteDays: COUNTRY_JOIN_VOTE_DAYS, joinMinYes: COUNTRY_JOIN_MIN_YES,
      },
      ideologies: COUNTRY_IDEOLOGIES,
      systems: GOVERNMENT_SYSTEMS,
    });
  }));

  // Daftar publik semua negara (dipakai halaman Negara + statistik).
  app.get('/api/countries', authRequired, citizenRequired, r(async (req, res) => {
    const rows = await sql(
      `SELECT c.*, (SELECT COUNT(*) FROM regions WHERE country_id = c.id) AS region_count,
        (SELECT COUNT(*) FROM citizens ci JOIN regions r ON r.id = ci.home_region_id WHERE r.country_id = c.id) AS citizen_count,
        (SELECT u.username FROM citizens pc JOIN users u ON u.id = pc.user_id WHERE pc.id = c.president_id) AS president_name
       FROM country c ORDER BY c.id ASC`);
    res.json({ countries: rows.map((c) => ({ ...countrySummary(c), region_count: Number(c.region_count), citizen_count: Number(c.citizen_count), president_name: c.president_name || 'Kosong', president_title: systemDef(c.system).presidentTitle })) });
  }));

  // ---------- ALIANSI ANTAR-NEGARA (v5.7.0) ----------
  // Dua negara bersekutu tidak bisa saling serang (lihat declareCountryWar).
  // Presiden mengusulkan ke negara lain; presiden negara target menerima
  // atau menolak; presiden salah satu pihak bisa membubarkan kapan saja.
  app.get('/api/alliances', authRequired, citizenRequired, r(async (req, res) => {
    const country = await getMyCountry({ one }, req.citizen);
    if (!country) return res.json({ alliances: [] });
    const rows = await sql(
      `SELECT a.*, CASE WHEN a.country_a_id = ? THEN b.name ELSE aa.name END AS other_name,
        CASE WHEN a.country_a_id = ? THEN a.country_b_id ELSE a.country_a_id END AS other_id
       FROM country_alliances a
       LEFT JOIN country aa ON aa.id = a.country_a_id
       LEFT JOIN country b ON b.id = a.country_b_id
       WHERE a.country_a_id = ? OR a.country_b_id = ? ORDER BY a.created_at DESC`,
      [country.id, country.id, country.id, country.id]);
    res.json({ alliances: rows.map((a) => ({ id: a.id, otherId: a.other_id, otherName: a.other_name || COUNTRY_NAME_PLACEHOLDER, status: a.status, outgoing: a.proposer_id === req.citizen.id })) });
  }));

  app.post('/api/countries/:id/ally', authRequired, citizenRequired, r(async (req, res) => {
    const target = await one('SELECT * FROM country WHERE id = ?', [req.params.id]);
    if (!target) return res.status(404).json({ error: 'Negara tidak ditemukan.' });
    const myCountry = await getMyCountry({ one }, req.citizen);
    if (!myCountry) return res.status(400).json({ error: 'Kamu belum bernegara.' });
    if (myCountry.president_id !== req.citizen.id) return res.status(403).json({ error: 'Hanya presiden yang bisa mengusulkan aliansi.' });
    if (Number(target.id) === Number(myCountry.id)) return res.status(400).json({ error: 'Tidak bisa bersekutu dengan negaramu sendiri.' });
    const lo = Math.min(myCountry.id, target.id), hi = Math.max(myCountry.id, target.id);
    const existing = await one('SELECT id, status FROM country_alliances WHERE country_a_id = ? AND country_b_id = ?', [lo, hi]);
    if (existing) return res.status(400).json({ error: existing.status === 'active' ? 'Kedua negara sudah bersekutu.' : 'Sudah ada usulan aliansi yang menunggu jawaban.' });
    const ins = await run("INSERT INTO country_alliances (country_a_id, country_b_id, proposer_id, status, created_at) VALUES (?,?,?, 'pending', ?) RETURNING id",
      [lo, hi, req.citizen.id, Date.now()]);
    if (target.president_id) await notify(target.president_id, 'DIPLOMASI', 'Usulan aliansi baru', `${countryDisplayName(myCountry)} mengusulkan aliansi dengan ${countryDisplayName(target)}. Terima atau tolak di halaman Negara.`);
    res.json({ ok: true, allianceId: ins.id });
  }));

  app.post('/api/alliances/:id/respond', authRequired, citizenRequired, r(async (req, res) => {
    const { accept } = req.body || {};
    const row = await one('SELECT * FROM country_alliances WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Usulan aliansi tidak ditemukan.' });
    if (row.status !== 'pending') return res.status(400).json({ error: 'Usulan ini sudah dijawab.' });
    const myCountry = await getMyCountry({ one }, req.citizen);
    if (!myCountry || myCountry.president_id !== req.citizen.id) return res.status(403).json({ error: 'Hanya presiden yang bisa menjawab usulan aliansi.' });
    if (myCountry.id !== row.country_a_id && myCountry.id !== row.country_b_id) return res.status(403).json({ error: 'Usulan ini bukan untuk negaramu.' });
    if (row.proposer_id === req.citizen.id) return res.status(400).json({ error: 'Pengusul tidak bisa menjawab usulannya sendiri.' });
    if (accept === true || accept === 'true') {
      await run("UPDATE country_alliances SET status = 'active' WHERE id = ?", [row.id]);
      const other = await one('SELECT * FROM country WHERE id = ?', [myCountry.id === row.country_a_id ? row.country_b_id : row.country_a_id]);
      await notify(row.proposer_id, 'DIPLOMASI', 'Aliansi disetujui', `${countryDisplayName(myCountry)} menyetujui aliansi dengan ${countryDisplayName(other)}. Kedua negara kini tidak bisa saling serang.`);
      res.json({ ok: true, status: 'active' });
    } else {
      await run('DELETE FROM country_alliances WHERE id = ?', [row.id]);
      res.json({ ok: true, status: 'rejected' });
    }
  }));

  app.post('/api/alliances/:id/dissolve', authRequired, citizenRequired, r(async (req, res) => {
    const row = await one('SELECT * FROM country_alliances WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Aliansi tidak ditemukan.' });
    const myCountry = await getMyCountry({ one }, req.citizen);
    if (!myCountry || myCountry.president_id !== req.citizen.id) return res.status(403).json({ error: 'Hanya presiden yang bisa membubarkan aliansi.' });
    if (myCountry.id !== row.country_a_id && myCountry.id !== row.country_b_id) return res.status(403).json({ error: 'Aliansi ini bukan milik negaramu.' });
    await run('DELETE FROM country_alliances WHERE id = ?', [row.id]);
    const otherId = myCountry.id === row.country_a_id ? row.country_b_id : row.country_a_id;
    const other = await one('SELECT president_id FROM country WHERE id = ?', [otherId]);
    if (other?.president_id) await notify(other.president_id, 'DIPLOMASI', 'Aliansi dibubarkan', `${countryDisplayName(myCountry)} membubarkan aliansi dengan negaramu.`);
    res.json({ ok: true });
  }));

  // ---------- MENDIRIKAN NEGARA ----------
  // Aturan (dipilih agen — pemilik tidak menentukan, bisa diubah):
  // Level 10 + 100 emas; wilayah pemanggil harus MERDEKA (belum bernegara)
  // dan menjadi ibu kota + wilayah pertama. NAMA TIDAK DIPILIH pendiri
  // (v5.7.0) — negara baru dibuat tanpa nama (NULL, tampil 'Belum
  // Dinamai') dan namanya DITENTUKAN parlemen lewat mosi. Ideologi +
  // sistem dipilih saat mendirikan. Pendiri BUKAN otomatis presiden —
  // presiden dipilih lewat pemilu (nominasi kepala partai). Pemilu pertama
  // dijadwalkan otomatis: presiden 7 hari setelah didirikan; parlemen
  // paling cepat saat parlemen dibuka (28 Nov 2026 20:00 WIB) atau langsung
  // saat didirikan (bila didirikan sesudah parlemen dibuka) — v5.7.5.
  app.post('/api/countries', authRequired, citizenRequired, r(async (req, res) => {
    const { ideology, system } = req.body || {};
    const c = req.citizen;
    if (c.level < COUNTRY_FORM_MIN_LEVEL) return res.status(400).json({ error: `Mendirikan negara butuh Level ${COUNTRY_FORM_MIN_LEVEL}.` });
    const ide = COUNTRY_IDEOLOGIES.find((x) => x.id === ideology);
    if (!ide) return res.status(400).json({ error: 'Ideologi tidak dikenal.' });
    const sys = GOVERNMENT_SYSTEMS.find((x) => x.id === system);
    if (!sys) return res.status(400).json({ error: 'Sistem pemerintahan tidak dikenal.' });
    // Negara hanya bisa didirikan di wilayah ASAL (home_region_id) yang
    // masih merdeka — warga yang sedang berkunjung di wilayah lain tidak
    // bisa mendirikan negara di sana.
    const myRegion = await one('SELECT * FROM regions WHERE id = ?', [c.home_region_id]);
    if (!myRegion) return res.status(400).json({ error: 'Wilayah asalmu tidak ditemukan.' });
    if (myRegion.country_id) return res.status(400).json({ error: 'Wilayah asalmu sudah bernegara. Pindah kewarganegaraan ke wilayah yang belum bernegara dulu untuk mendirikan negara.' });
    const now = Date.now();
    const countryId = await tx(async (t) => {
      await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [c.id]);
      const reg = await t.one(forUpdate('SELECT * FROM regions WHERE id = ?'), [c.home_region_id]);
      if (reg.country_id) throw Object.assign(new Error('Wilayah asalmu baru saja bergabung dengan negara lain.'), { status: 400 });
      const ins = await t.run(
        'INSERT INTO country (name, ideology, system, founder_id, capital, founded, treasury, treasury_usd, tax_income, tax_production, tax_import, tax_export) VALUES (NULL,?,?,?,?,?,0,0,2,1,2,2) RETURNING id',
        [ide.id, sys.id, c.id, reg.name, new Date(now).toISOString().slice(0, 10)]);
      const upd = await t.run('UPDATE citizens SET gold = gold - ? WHERE id = ? AND gold >= ?', [COUNTRY_FORM_COST_GOLD, c.id, COUNTRY_FORM_COST_GOLD]);
      if (!upd.changes) throw Object.assign(new Error(`Mendirikan negara butuh ${COUNTRY_FORM_COST_GOLD} emas.`), { status: 400 });
      await t.run("UPDATE regions SET country_id = ?, controller = 'negara', controller_id = ? WHERE id = ?", [ins.id, ins.id, reg.id]);
      // Jadwalkan pemilu pertama negara ini. Presiden +7 hari (by design).
      // Parlemen pertama v5.7.5: langsung max(parOpensAt, now) — bukan
      // +3 hari lagi — supaya pemilu parlemen pertama bisa dibuka begitu
      // parlemen buka + petisi terpenuhi (aturan pemilik 28 Nov 2026).
      const presOpens = now + PRESIDENT_ELECTION_DELAY_DAYS * DAY_MS;
      await t.run("INSERT INTO elections (type, status, opens_at, closes_at, country_id, created_at) VALUES ('president','scheduled',?,?,?,?) RETURNING id",
        [presOpens, presOpens + ELECTION_VOTE_MS, ins.id, now]);
      const parOpens = Math.max(await getParliamentOpensAt(), now);
      await t.run("INSERT INTO elections (type, status, opens_at, closes_at, country_id, created_at) VALUES ('parliament','scheduled',?,?,?,?) RETURNING id",
        [parOpens, parOpens + ELECTION_VOTE_MS, ins.id, now]);
      return ins.id;
    });
    await chronicleDone(c, 'country');
    await notify(c.id, 'POLITIK', 'Negara baru berdiri!', `Kamu mendirikan negara baru (${ide.label}, ${sys.label}) dengan ibu kota ${myRegion.name}. Negara ini belum bernama — parlemen yang akan menetapkan namanya. Pemilu presiden pertama dibuka ${new Date(now + PRESIDENT_ELECTION_DELAY_DAYS * DAY_MS).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}.`);
    res.json({ ok: true, countryId });
  }));

  // ---------- UNIFIKASI WILAYAH ----------
  // Warga wilayah MERDEKA (Level 5) mengusulkan wilayahnya bergabung ke
  // sebuah negara. Warga wilayah itu voting 3 hari; lolos bila YA > TIDAK
  // dan YA minimal 3 (supaya satu orang tidak bisa menyeret satu wilayah).
  // Pengusul otomatis memilih YA. Tidak ada mekanisme pemisahan diri
  // (secession) — belum diminta pemilik.
  app.post('/api/countries/:id/join', authRequired, citizenRequired, r(async (req, res) => {
    const target = await one('SELECT * FROM country WHERE id = ?', [req.params.id]);
    if (!target) return res.status(404).json({ error: 'Negara tidak ditemukan.' });
    const c = req.citizen;
    if (c.level < COUNTRY_JOIN_MIN_LEVEL) return res.status(400).json({ error: `Mengusulkan unifikasi butuh Level ${COUNTRY_JOIN_MIN_LEVEL}.` });
    // Yang bergabung adalah wilayah ASAL pengusul (kewarganegaraannya) —
    // harus masih merdeka.
    const myRegion = await one('SELECT * FROM regions WHERE id = ?', [c.home_region_id]);
    if (!myRegion) return res.status(400).json({ error: 'Wilayah asalmu tidak ditemukan.' });
    if (myRegion.country_id) return res.status(400).json({ error: 'Wilayah asalmu sudah bernegara — unifikasi hanya untuk wilayah yang belum bernegara.' });
    const existing = await one("SELECT id FROM country_joins WHERE region_id = ? AND status = 'voting' AND ends_at > ?", [myRegion.id, Date.now()]);
    if (existing) return res.status(400).json({ error: 'Sudah ada usulan unifikasi yang sedang divoting untuk wilayah asalmu.' });
    const now = Date.now();
    const joinId = await tx(async (t) => {
      const reg = await t.one(forUpdate('SELECT * FROM regions WHERE id = ?'), [c.home_region_id]);
      if (reg.country_id) throw Object.assign(new Error('Wilayah asalmu baru saja bergabung dengan negara lain.'), { status: 400 });
      const dup = await t.one("SELECT id FROM country_joins WHERE region_id = ? AND status = 'voting' AND ends_at > ?", [reg.id, now]);
      if (dup) throw Object.assign(new Error('Sudah ada usulan unifikasi yang sedang divoting untuk wilayah asalmu.'), { status: 400 });
      const j = await t.run(
        "INSERT INTO country_joins (country_id, region_id, proposer_id, yes, no, status, ends_at, created_at) VALUES (?,?,?,1,0,'voting',?,?) RETURNING id",
        [target.id, reg.id, c.id, now + COUNTRY_JOIN_VOTE_DAYS * DAY_MS, now]);
      await t.run('INSERT INTO country_join_votes (join_id, citizen_id, vote) VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING join_id', [j.id, c.id, 'yes']);
      return j.id;
    });
    res.json({ ok: true, joinId });
  }));

  // Usulan unifikasi yang terbuka untuk wilayah pemanggil.
  app.get('/api/countries/joins', authRequired, citizenRequired, r(async (req, res) => {
    const rows = await sql(
      `SELECT j.*, COALESCE(c.name, 'Belum Dinamai') AS country_name, r.name AS region_name FROM country_joins j
       JOIN country c ON c.id = j.country_id JOIN regions r ON r.id = j.region_id
       WHERE j.region_id = ? AND j.status = 'voting' AND j.ends_at > ? ORDER BY j.created_at DESC`,
      [req.citizen.home_region_id, Date.now()]);
    const myVotes = rows.length
      ? await sql('SELECT join_id, vote FROM country_join_votes WHERE citizen_id = ? AND join_id IN (' + rows.map(() => '?').join(',') + ')', [req.citizen.id, ...rows.map((j) => j.id)])
      : [];
    res.json({ joins: rows, myVotes: Object.fromEntries(myVotes.map((v) => [v.join_id, v.vote])) });
  }));

  // Voting unifikasi: hanya warga WILAYAH yang diusulkan yang boleh memilih
  // (bukan warga negara tujuan). Satu suara per warga.
  app.post('/api/countries/joins/:id/vote', authRequired, citizenRequired, r(async (req, res) => {
    const { vote } = req.body || {};
    if (!['yes', 'no'].includes(vote)) return res.status(400).json({ error: 'Pilihan suara tidak dikenal.' });
    const j = await one("SELECT * FROM country_joins WHERE id = ? AND status = 'voting' AND ends_at > ?", [req.params.id, Date.now()]);
    if (!j) return res.status(404).json({ error: 'Usulan unifikasi tidak ditemukan / voting sudah ditutup.' });
    if (req.citizen.home_region_id !== j.region_id) return res.status(403).json({ error: 'Hanya warga wilayah yang diusulkan yang bisa memilih.' });
    const col = vote === 'yes' ? 'yes' : 'no';
    await tx(async (t) => {
      const ins = await t.run('INSERT INTO country_join_votes (join_id, citizen_id, vote) VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING join_id', [j.id, req.citizen.id, vote]);
      if (!ins.changes) throw Object.assign(new Error('Kamu sudah memilih untuk usulan ini.'), { status: 400 });
      await t.run(`UPDATE country_joins SET ${col} = ${col} + 1 WHERE id = ?`, [j.id]);
    });
    res.json({ ok: true });
  }));

  // ---------- IDEOLOGI / SISTEM / PAJAK (wewenang presiden) ----------
  // Ideologi + sistem bisa diubah DUA cara (sesuai perintah pemilik):
  // langsung oleh presiden (di sini) ATAU lewat UU jenis 'ideology' /
  // 'system' yang disahkan parlemen (lihat tick.js applyLawEffect).
  app.post('/api/country/ideology', authRequired, citizenRequired, r(async (req, res) => {
    const { ideology } = req.body || {};
    const country = await getMyCountry({ one }, req.citizen);
    if (!country) return res.status(400).json({ error: 'Kamu belum bernegara.' });
    if (country.president_id !== req.citizen.id) return res.status(403).json({ error: 'Hanya Presiden yang bisa mengubah ideologi negara.' });
    const ide = COUNTRY_IDEOLOGIES.find((x) => x.id === ideology);
    if (!ide) return res.status(400).json({ error: 'Ideologi tidak dikenal.' });
    await run('UPDATE country SET ideology = ? WHERE id = ?', [ide.id, country.id]);
    await notifyAll('POLITIK', `Ideologi ${countryDisplayName(country)} berubah`, `Presiden mengubah ideologi ${countryDisplayName(country)} menjadi ${ide.label}. ${ide.desc}`);
    res.json({ ok: true, ideology: ide.id });
  }));

  app.post('/api/country/system', authRequired, citizenRequired, r(async (req, res) => {
    const { system } = req.body || {};
    const country = await getMyCountry({ one }, req.citizen);
    if (!country) return res.status(400).json({ error: 'Kamu belum bernegara.' });
    if (country.president_id !== req.citizen.id) return res.status(403).json({ error: 'Hanya Presiden yang bisa mengubah sistem pemerintahan.' });
    const sys = GOVERNMENT_SYSTEMS.find((x) => x.id === system);
    if (!sys) return res.status(400).json({ error: 'Sistem pemerintahan tidak dikenal.' });
    await run('UPDATE country SET system = ? WHERE id = ?', [sys.id, country.id]);
    await notifyAll('POLITIK', `Sistem ${countryDisplayName(country)} berubah`, `Presiden mengubah sistem pemerintahan ${countryDisplayName(country)} menjadi ${sys.label}. ${sys.desc}`);
    res.json({ ok: true, system: sys.id });
  }));

  // Pajak langsung presiden — HANYA sistem diktator (1–5%). Sistem lain
  // mengubah pajak lewat UU (jenis 'tax_income') yang disahkan parlemen.
  app.post('/api/country/tax', authRequired, citizenRequired, r(async (req, res) => {
    const { tax } = req.body || {};
    const country = await getMyCountry({ one }, req.citizen);
    if (!country) return res.status(400).json({ error: 'Kamu belum bernegara.' });
    if (country.president_id !== req.citizen.id) return res.status(403).json({ error: 'Hanya Presiden yang bisa mengubah pajak.' });
    if (country.system !== 'diktator') return res.status(400).json({ error: 'Pajak langsung hanya bisa diubah presiden di sistem Diktator. Sistem lain memakai UU parlemen.' });
    const t = Number(tax);
    if (!Number.isFinite(t) || t < 1 || t > 5) return res.status(400).json({ error: 'Pajak penghasilan 1–5%.' });
    await run('UPDATE country SET tax_income = ? WHERE id = ?', [t, country.id]);
    res.json({ ok: true, tax_income: t });
  }));

  app.post('/api/country/appoint', authRequired, citizenRequired, r(async (req, res) => {
    const { role, citizen_id } = req.body || {};
    const country = await getMyCountry({ one }, req.citizen);
    if (!country) return res.status(400).json({ error: 'Kamu belum bernegara.' });
    if (country.president_id !== req.citizen.id) return res.status(403).json({ error: 'Hanya Presiden yang bisa mengangkat menteri.' });
    const col = { economy: 'minister_economy', foreign: 'minister_foreign', home: 'minister_home', defense: 'minister_defense' }[role];
    if (!col) return res.status(400).json({ error: 'Jabatan tidak dikenal.' });
    const target = await one('SELECT id FROM citizens WHERE id = ?', [citizen_id]);
    if (!target) return res.status(404).json({ error: 'Warga tidak ditemukan.' });
    await run(`UPDATE country SET ${col} = ? WHERE id = ?`, [citizen_id, country.id]);
    await notify(citizen_id, 'POLITIK', 'Kamu diangkat jadi menteri', `Presiden ${countryDisplayName(country)} mengangkatmu sebagai menteri (${role}).`);
    res.json({ ok: true });
  }));

  // ---------- ANGGARAN NEGARA ---------- (Tahap 5 — Menteri Ekonomi)
  // Menteri Ekonomi mengusulkan anggaran; parlemen voting 3 hari; bila
  // lolos, biaya dipotong dari kas negara saat tick menutup voting dan
  // efeknya berlaku 7 hari (lihat tick.js §4b). Satu voting anggaran aktif
  // dalam satu waktu. Anggaran yang sedang berlaku boleh diganti oleh
  // anggaran baru yang lolos.
  app.post('/api/country/budget', authRequired, citizenRequired, r(async (req, res) => {
    const { kind, amount } = req.body || {};
    // Anggaran adalah fitur parlemen — terkunci sampai parlemen dibuka.
    const par = await parliamentStatus();
    if (!par.open) return res.status(403).json({ error: parliamentLockedError(par.opensAt) });
    const country = await getMyCountry({ one }, req.citizen);
    if (!country) return res.status(400).json({ error: 'Kamu belum bernegara.' });
    if (ministerRole(country, req.citizen.id) !== 'economy') return res.status(403).json({ error: 'Hanya Menteri Ekonomi yang bisa mengusulkan anggaran.' });
    // v5.7.5 (aturan pemilik 28 Nov 2026, audit pengusulan): anggaran
    // divoting parlemen, jadi pengusulnya pun harus anggota parlemen —
    // Menteri Ekonomi yang bukan MP tidak bisa mengusulkan (presiden bisa
    // mengangkat MP jadi Menteri Ekonomi bila ingin mengusulkan anggaran).
    if (!await isMpCitizen(req.citizen)) return res.status(403).json({ error: 'Hanya anggota parlemen yang bisa mengusulkan anggaran. Partaimu belum punya kursi.' });
    if (!BUDGET_KINDS[kind]) return res.status(400).json({ error: 'Jenis anggaran tidak dikenal.' });
    const amt = Math.floor(Number(amount));
    if (!Number.isFinite(amt) || amt < 50 || amt > 500) return res.status(400).json({ error: 'Jumlah anggaran 50–500 emas.' });
    const active = await one("SELECT id FROM budgets WHERE country_id = ? AND status = 'voting' AND ends_at > ?", [country.id, Date.now()]);
    if (active) return res.status(400).json({ error: 'Sudah ada anggaran yang sedang divoting.' });
    const b = await run('INSERT INTO budgets (proposer_id, kind, amount, status, ends_at, country_id, created_at) VALUES (?,?,?,\'voting\',?,?,?) RETURNING id',
      [req.citizen.id, kind, amt, Date.now() + BUDGET_VOTE_DAYS * DAY_MS, country.id, Date.now()]);
    res.json({ ok: true, budgetId: b.id });
  }));

  app.post('/api/country/budget/:id/vote', authRequired, citizenRequired, r(async (req, res) => {
    const { vote } = req.body || {};
    if (!['yes', 'no'].includes(vote)) return res.status(400).json({ error: 'Pilihan suara tidak dikenal.' });
    const par = await parliamentStatus();
    if (!par.open) return res.status(403).json({ error: parliamentLockedError(par.opensAt) });
    if (!await isMpCitizen(req.citizen)) return res.status(403).json({ error: 'Hanya anggota parlemen yang bisa memilih anggaran.' });
    const b = await one("SELECT * FROM budgets WHERE id = ? AND status = 'voting' AND ends_at > ?", [req.params.id, Date.now()]);
    if (!b) return res.status(404).json({ error: 'Anggaran tidak ditemukan / voting sudah ditutup.' });
    const myCountry = await getMyCountry({ one }, req.citizen);
    if (!myCountry || b.country_id !== myCountry.id) return res.status(403).json({ error: 'Anggaran ini bukan dari negaramu.' });
    const col = vote === 'yes' ? 'yes' : 'no';
    await tx(async (t) => {
      const ins = await t.run('INSERT INTO budget_votes (budget_id, citizen_id, vote) VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING budget_id', [b.id, req.citizen.id, vote]);
      if (!ins.changes) throw Object.assign(new Error('Kamu sudah memilih untuk anggaran ini.'), { status: 400 });
      await t.run(`UPDATE budgets SET ${col} = ${col} + 1 WHERE id = ?`, [b.id]);
    });
    res.json({ ok: true });
  }));

  // ---------- MOBILISASI & HARI LIBUR ---------- (Tahap 5 — wewenang menteri)
  // Mobilisasi (Menteri Pertahanan): 100 emas kas negara, kerusakan perang
  // semua warga +10% selama 24 jam. Hari libur (Menteri Dalam Negeri):
  // 50 emas kas negara, semua warga +20 energi (maks batas masing-masing),
  // sekali per 24 jam. Biaya dipotong atomik dari kas negara; bila kas
  // kurang, aksi ditolak.
  app.post('/api/country/mobilize', authRequired, citizenRequired, r(async (req, res) => {
    const country = await getMyCountry({ one }, req.citizen);
    if (!country) return res.status(400).json({ error: 'Kamu belum bernegara.' });
    if (ministerRole(country, req.citizen.id) !== 'defense') return res.status(403).json({ error: 'Hanya Menteri Pertahanan yang bisa memobilisasi.' });
    if (Number(country.mobilization_until) > Date.now()) return res.status(400).json({ error: 'Mobilisasi sudah aktif.' });
    await tx(async (t) => {
      const locked = await t.one(forUpdate('SELECT * FROM country WHERE id = ?'), [country.id]);
      if (Number(locked.treasury) < MOBILIZE_COST_GOLD) throw Object.assign(new Error(`Mobilisasi butuh ${MOBILIZE_COST_GOLD} emas dari kas negara.`), { status: 400 });
      if (Number(locked.mobilization_until) > Date.now()) throw Object.assign(new Error('Mobilisasi sudah aktif.'), { status: 400 });
      await t.run('UPDATE country SET treasury = treasury - ?, mobilization_until = ? WHERE id = ?', [MOBILIZE_COST_GOLD, Date.now() + MOBILIZE_DURATION_MS, country.id]);
      await t.run("INSERT INTO treasury_tx (kind, currency, amount, note, country_id, created_at) VALUES ('anggaran','gold',?,?,?,?) RETURNING id",
        [-MOBILIZE_COST_GOLD, 'Mobilisasi pertahanan (+10% kerusakan perang 24 jam)', country.id, Date.now()]);
    });
    await notifyAll('POLITIK', 'Mobilisasi pertahanan', `Menteri Pertahanan ${countryDisplayName(country)} memobilisasi negara: kerusakan perang semua warga +10% selama 24 jam.`);
    res.json({ ok: true });
  }));

  app.post('/api/country/holiday', authRequired, citizenRequired, r(async (req, res) => {
    const country = await getMyCountry({ one }, req.citizen);
    if (!country) return res.status(400).json({ error: 'Kamu belum bernegara.' });
    if (ministerRole(country, req.citizen.id) !== 'home') return res.status(403).json({ error: 'Hanya Menteri Dalam Negeri yang bisa menetapkan hari libur.' });
    if (Date.now() - Number(country.holiday_at) < HOLIDAY_COOLDOWN_MS) return res.status(400).json({ error: 'Hari libur baru bisa ditetapkan lagi setelah 24 jam.' });
    await tx(async (t) => {
      const locked = await t.one(forUpdate('SELECT * FROM country WHERE id = ?'), [country.id]);
      if (Number(locked.treasury) < HOLIDAY_COST_GOLD) throw Object.assign(new Error(`Hari libur butuh ${HOLIDAY_COST_GOLD} emas dari kas negara.`), { status: 400 });
      if (Date.now() - Number(locked.holiday_at) < HOLIDAY_COOLDOWN_MS) throw Object.assign(new Error('Hari libur baru bisa ditetapkan lagi setelah 24 jam.'), { status: 400 });
      await t.run('UPDATE country SET treasury = treasury - ?, holiday_at = ? WHERE id = ?', [HOLIDAY_COST_GOLD, Date.now(), country.id]);
      await t.run("INSERT INTO treasury_tx (kind, currency, amount, note, country_id, created_at) VALUES ('anggaran','gold',?,?,?,?) RETURNING id",
        [-HOLIDAY_COST_GOLD, 'Hari libur nasional (+20 energi semua warga)', country.id, Date.now()]);
      // +20 energi untuk semua warga, dibatasi batas maksimum masing-masing
      // (rumus yang sama dengan tick harian: 100 + 5×(level−1), +20 Premium,
      // +10 RS Lapangan). Satu UPDATE seragam dengan CASE — atomik.
      const cap = `100 + 5 * (CASE WHEN level > 1 THEN level - 1 ELSE 0 END)
        + CASE WHEN (SELECT premium_until FROM users WHERE users.id = citizens.user_id) > ? THEN 20 ELSE 0 END
        + CASE WHEN EXISTS (SELECT 1 FROM convoys WHERE citizen_id = citizens.id AND building = 'health' AND expires_at > ?) THEN 10 ELSE 0 END`;
      // Placeholder: energi+? (1) + cap dipakai 2× (2+2) + energi+? (1) = 6.
      const now = Date.now();
      await t.run(`UPDATE citizens SET energy = CASE WHEN energy + ? > (${cap}) THEN (${cap}) ELSE energy + ? END`,
        [HOLIDAY_ENERGY, now, now, now, now, HOLIDAY_ENERGY]);
    });
    await notifyAll('POLITIK', 'Hari libur nasional', 'Menteri Dalam Negeri menetapkan hari libur: semua warga mendapat +20 energi.');
    res.json({ ok: true });
  }));

  // ---------- SUMBANG KE KAS NEGARA (v4.6.0, saran LIO) ----------
  // Warga menyumbang ke kas NEGARANYA SENDIRI (kewarganegaraan mengikuti
  // home_region_id — getMyCountry; tanpa negara → 400). Tiga bentuk:
  //   gold: emas langsung → country.treasury.
  //   usd: Rupiah (klien mengirim USD hasil konversi Rp; server menerima
  //     USD) → country.treasury_usd.
  //   item: bahan/barang dari inventaris (tier 1) — dikonversi ke nilai
  //     USD acuan (ref_usd) lalu masuk treasury_usd; kas negara tidak
  //     menyimpan inventaris barang, jadi konversi adalah pencatatannya
  //     (nama + jumlah barang TERCATAT di note ledger).
  // Semua atomik (kunci baris warga + negara); jumlah > 0 dan saldo/bahan
  // harus cukup. Setiap sumbangan TERCATAT di treasury_tx (kind
  // 'sumbangan', amount positif) — terlihat di panel ARUS KAS halaman
  // Negara. Tidak ada batas jumlah; tidak ada hadiah balik (bukan
  // pembelian — jangan samakan dengan toko/grant admin).
  app.post('/api/country/donate', authRequired, citizenRequired, r(async (req, res) => {
    const { type, amount, commodity, qty } = req.body || {};
    if (!['gold', 'usd', 'item'].includes(type)) return res.status(400).json({ error: 'Jenis sumbangan tidak dikenal (emas, Rupiah, atau bahan).' });
    const country = await getMyCountry({ one }, req.citizen);
    if (!country) return res.status(400).json({ error: 'Kamu belum bernegara — sumbangan hanya untuk kas negaramu.' });
    const out = await tx(async (t) => {
      const locked = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      const lockedCountry = await t.one(forUpdate('SELECT * FROM country WHERE id = ?'), [country.id]);
      if (!lockedCountry) throw Object.assign(new Error('Negaramu tidak ditemukan.'), { status: 400 });
      const username = locked.username;
      if (type === 'gold') {
        const n = Number(amount);
        if (!Number.isFinite(n) || n <= 0) throw Object.assign(new Error('Jumlah emas harus lebih dari 0.'), { status: 400 });
        const upd = await t.run('UPDATE citizens SET gold = gold - ? WHERE id = ? AND gold >= ?', [n, locked.id, n]);
        if (!upd.changes) throw Object.assign(new Error(`Emasmu tidak cukup (punya ${Math.floor(locked.gold)}).`), { status: 400 });
        await t.run('UPDATE country SET treasury = treasury + ? WHERE id = ?', [n, country.id]);
        await t.run("INSERT INTO treasury_tx (kind, currency, amount, note, country_id, created_at) VALUES ('sumbangan','gold',?,?,?,?) RETURNING id",
          [n, `Sumbangan ${username}: +${n} emas`, country.id, Date.now()]);
        return { type, amount: n, treasury: Number(lockedCountry.treasury) + n, treasury_usd: Number(lockedCountry.treasury_usd) };
      }
      if (type === 'usd') {
        const n = Number(amount);
        if (!Number.isFinite(n) || n <= 0) throw Object.assign(new Error('Jumlah Rupiah harus lebih dari 0.'), { status: 400 });
        const upd = await t.run('UPDATE citizens SET usd = usd - ? WHERE id = ? AND usd >= ?', [n, locked.id, n]);
        if (!upd.changes) throw Object.assign(new Error('Saldomu tidak cukup.'), { status: 400 });
        await t.run('UPDATE country SET treasury_usd = treasury_usd + ? WHERE id = ?', [n, country.id]);
        await t.run("INSERT INTO treasury_tx (kind, currency, amount, note, country_id, created_at) VALUES ('sumbangan','usd',?,?,?,?) RETURNING id",
          [n, `Sumbangan ${username}: +${fmtRp(n)}`, country.id, Date.now()]);
        return { type, amount: n, treasury: Number(lockedCountry.treasury), treasury_usd: Number(lockedCountry.treasury_usd) + n };
      }
      // item: bahan dari inventaris → nilai USD acuan → kas Rupiah.
      const q = Number(qty);
      if (!Number.isInteger(q) || q <= 0) throw Object.assign(new Error('Jumlah bahan harus bilangan bulat lebih dari 0.'), { status: 400 });
      const com = await t.one('SELECT * FROM commodities WHERE name = ?', [String(commodity || '')]);
      if (!com) throw Object.assign(new Error('Bahan tidak dikenal.'), { status: 400 });
      const row = await t.one(forUpdate('SELECT * FROM inventory WHERE citizen_id = ? AND commodity_id = ? AND tier = 1'), [locked.id, com.id]);
      if (!row || row.qty < q) throw Object.assign(new Error(`Kamu tidak punya ${q}× ${com.name} di inventaris.`), { status: 400 });
      if (row.qty === q) await t.run('DELETE FROM inventory WHERE id = ?', [row.id]);
      else await t.run('UPDATE inventory SET qty = qty - ? WHERE id = ?', [q, row.id]);
      const value = Math.round(q * Number(com.ref_usd) * 100) / 100;
      await t.run('UPDATE country SET treasury_usd = treasury_usd + ? WHERE id = ?', [value, country.id]);
      await t.run("INSERT INTO treasury_tx (kind, currency, amount, note, country_id, created_at) VALUES ('sumbangan','usd',?,?,?,?) RETURNING id",
        [value, `Sumbangan ${username}: ${q}× ${com.name} (setara ${fmtRp(value)})`, country.id, Date.now()]);
      return { type, amount: value, commodity: com.name, qty: q, treasury: Number(lockedCountry.treasury), treasury_usd: Number(lockedCountry.treasury_usd) + value };
    });
    res.json({ ok: true, ...out });
  }));

  // ---------- PARTAI ----------
  app.get('/api/parties', authRequired, citizenRequired, r(async (req, res) => {
    // Kursi dihitung PER NEGARA (party_seats) — angka yang ditampilkan
    // adalah kursi partai di parlemen NEGARA pemanggil (0 bila pemanggil
    // di wilayah merdeka / partainya tak punya kursi di negaranya).
    // PENTING (bug live 27 Nov 2026): JANGAN SELECT p.* di sini. Kolom
    // lama parties.seats ikut terambil, sehingga alias subquery `seats`
    // berduplikasi — ORDER BY seats jadi ambigu dan Postgres menolak
    // query ("ORDER BY \"seats\" is ambiguous", 500) begitu ada ≥1 partai.
    // SQLite diam-diam memilih salah satunya, jadi tes e2e tidak menangkap
    // ini. Kolom diambil eksplisit (tanpa parties.seats) agar `seats` di
    // respons SELALU kursi per negara pemanggil.
    const myCountry = await getMyCountry({ one }, req.citizen);
    const countryId = myCountry?.id || -1;
    const rows = await sql(
      `SELECT p.id, p.name, p.tag, p.ideology, p.leader_id, p.type, p.created_at,
        u.username AS leader_name,
        (SELECT COUNT(*) FROM party_members WHERE party_id = p.id) AS members,
        COALESCE((SELECT seats FROM party_seats WHERE party_id = p.id AND country_id = ?), 0) AS seats
       FROM parties p JOIN citizens c ON c.id = p.leader_id JOIN users u ON u.id = c.user_id
       ORDER BY seats DESC, members DESC`,
      [countryId]);
    const mine = req.citizen.party_id
      ? await one(
        `SELECT p.id, p.name, p.tag, p.ideology, p.leader_id, p.type, p.created_at,
          u.username AS leader_name,
          COALESCE((SELECT seats FROM party_seats WHERE party_id = p.id AND country_id = ?), 0) AS seats
         FROM parties p JOIN citizens c ON c.id = p.leader_id JOIN users u ON u.id = c.user_id WHERE p.id = ?`,
        [countryId, req.citizen.party_id])
      : null;
    const pending = mine ? await sql(
      `SELECT pm.*, u.username FROM party_members pm JOIN citizens c ON c.id = pm.citizen_id JOIN users u ON u.id = c.user_id
       WHERE pm.party_id = ? AND pm.role = 'pending'`, [mine.id]) : [];
    // Anggota partaiku (leader + secretary + member) — dipakai halaman
    // Pemilu untuk nominasi calon presiden oleh kepala partai (redesain
    // dunia) dan halaman detail partai (v5.6.0).
    const members = mine ? await sql(
      `SELECT pm.citizen_id, pm.role, u.username FROM party_members pm JOIN citizens c ON c.id = pm.citizen_id JOIN users u ON u.id = c.user_id
       WHERE pm.party_id = ? AND pm.role IN ('leader','secretary','member') ORDER BY u.username`, [mine.id]) : [];
    res.json({ parties: rows, mine, pending, members });
  }));

  // ---------- MANAJEMEN PARTAI (v5.6.0) ----------
  // Role di party_members: 'leader' (ketua) | 'secretary' (sekretaris) |
  // 'member' (anggota) | 'pending' (lamaran menunggu). Kolom role tidak
  // punya CHECK constraint, jadi 'secretary' tidak butuh migrasi skema.
  async function partyRoleOf(partyId, citizenId) {
    const m = await one('SELECT role FROM party_members WHERE party_id = ? AND citizen_id = ?', [partyId, citizenId]);
    return m?.role || null;
  }
  // Ketua atau sekretaris boleh mengurus lamaran (setujui/tolak).
  async function partyCanManage(party, citizenId) {
    if (party.leader_id === citizenId) return true;
    return (await partyRoleOf(party.id, citizenId)) === 'secretary';
  }

  // Detail partai: isi + daftar member (publik — nama warga sudah tampil
  // di chat, peringkat, dan daftar partai; pola privasi yang sama). Lamaran
  // pending hanya terlihat oleh ketua/sekretaris partai itu.
  app.get('/api/parties/:id', authRequired, citizenRequired, r(async (req, res) => {
    const p = await one(
      `SELECT p.id, p.name, p.tag, p.ideology, p.leader_id, p.type, p.created_at,
        u.username AS leader_name,
        (SELECT COUNT(*) FROM party_members WHERE party_id = p.id) AS members
       FROM parties p JOIN citizens c ON c.id = p.leader_id JOIN users u ON u.id = c.user_id WHERE p.id = ?`,
      [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Partai tidak ditemukan.' });
    const myCountry = await getMyCountry({ one }, req.citizen);
    const seatsRow = await one('SELECT seats FROM party_seats WHERE party_id = ? AND country_id = ?', [p.id, myCountry?.id || -1]);
    const members = await sql(
      `SELECT pm.citizen_id, pm.role, pm.joined_at, u.username FROM party_members pm
       JOIN citizens c ON c.id = pm.citizen_id JOIN users u ON u.id = c.user_id
       WHERE pm.party_id = ? AND pm.role IN ('leader','secretary','member')
       ORDER BY CASE pm.role WHEN 'leader' THEN 0 WHEN 'secretary' THEN 1 ELSE 2 END, u.username`,
      [p.id]);
    const myRole = await partyRoleOf(p.id, req.citizen.id);
    const pending = (myRole === 'leader' || myRole === 'secretary') ? await sql(
      `SELECT pm.citizen_id, pm.joined_at, u.username FROM party_members pm
       JOIN citizens c ON c.id = pm.citizen_id JOIN users u ON u.id = c.user_id
       WHERE pm.party_id = ? AND pm.role = 'pending' ORDER BY pm.joined_at`,
      [p.id]) : [];
    res.json({ party: { ...p, seats: Number(seatsRow?.seats) || 0 }, members, pending, myRole });
  }));

  // Angkat/copot sekretaris — HANYA ketua. Target harus anggota biasa
  // (angkat) atau sekretaris (copot) dari partai ini.
  app.post('/api/parties/:id/secretary', authRequired, citizenRequired, r(async (req, res) => {
    const p = await one('SELECT * FROM parties WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Partai tidak ditemukan.' });
    if (p.leader_id !== req.citizen.id) return res.status(403).json({ error: 'Hanya ketua partai yang bisa mengangkat/mencopot sekretaris.' });
    const { citizen_id, action } = req.body || {};
    if (!['appoint', 'remove'].includes(action)) return res.status(400).json({ error: 'Aksi tidak dikenal.' });
    if (Number(citizen_id) === p.leader_id) return res.status(400).json({ error: 'Ketua tidak bisa diangkat jadi sekretaris.' });
    const m = await one('SELECT * FROM party_members WHERE party_id = ? AND citizen_id = ?', [p.id, citizen_id]);
    if (!m) return res.status(404).json({ error: 'Warga itu bukan anggota partai ini.' });
    if (action === 'appoint') {
      if (m.role !== 'member') return res.status(400).json({ error: 'Hanya anggota biasa yang bisa diangkat jadi sekretaris.' });
      await run("UPDATE party_members SET role = 'secretary' WHERE party_id = ? AND citizen_id = ?", [p.id, citizen_id]);
      await notify(citizen_id, 'PARTAI', 'Kamu diangkat jadi Sekretaris', `Ketua mengangkatmu jadi sekretaris partai ${p.name}. Kamu kini bisa membantu menyetujui lamaran gabung.`);
    } else {
      if (m.role !== 'secretary') return res.status(400).json({ error: 'Warga itu bukan sekretaris partai ini.' });
      await run("UPDATE party_members SET role = 'member' WHERE party_id = ? AND citizen_id = ?", [p.id, citizen_id]);
      await notify(citizen_id, 'PARTAI', 'Jabatan Sekretaris dicopot', `Ketua mencopot jabatan sekretarismu di partai ${p.name}.`);
    }
    res.json({ ok: true, role: action === 'appoint' ? 'secretary' : 'member' });
  }));

  app.post('/api/parties', authRequired, citizenRequired, requireCredit(CREDIT_MIN_FOR.party, 'mendirikan partai'),  r(async (req, res) => {
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
    if (!p) return res.status(404).json({ error: 'Partai tidak ditemukan.' });
    // v5.6.0: sekretaris boleh menyetujui lamaran sama seperti ketua.
    if (!(await partyCanManage(p, req.citizen.id))) return res.status(403).json({ error: 'Hanya ketua atau sekretaris partai yang bisa menyetujui lamaran.' });
    const { citizen_id } = req.body || {};
    const m = await one("SELECT * FROM party_members WHERE party_id = ? AND citizen_id = ? AND role = 'pending'", [p.id, citizen_id]);
    if (!m) return res.status(404).json({ error: 'Lamaran tidak ditemukan.' });
    await run("UPDATE party_members SET role = 'member' WHERE party_id = ? AND citizen_id = ?", [p.id, citizen_id]);
    await run('UPDATE citizens SET party_id = ? WHERE id = ?', [p.id, citizen_id]);
    await notify(citizen_id, 'PARTAI', 'Lamaranmu disetujui', `Kamu resmi bergabung dengan partai ${p.name}.`);
    res.json({ ok: true });
  }));

  // Tolak lamaran (v5.6.0) — ketua atau sekretaris; baris pending dihapus
  // sehingga pelamar bisa melamar lagi bila mau.
  app.post('/api/parties/:id/reject', authRequired, citizenRequired, r(async (req, res) => {
    const p = await one('SELECT * FROM parties WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Partai tidak ditemukan.' });
    if (!(await partyCanManage(p, req.citizen.id))) return res.status(403).json({ error: 'Hanya ketua atau sekretaris partai yang bisa menolak lamaran.' });
    const { citizen_id } = req.body || {};
    const m = await one("SELECT * FROM party_members WHERE party_id = ? AND citizen_id = ? AND role = 'pending'", [p.id, citizen_id]);
    if (!m) return res.status(404).json({ error: 'Lamaran tidak ditemukan.' });
    await run('DELETE FROM party_members WHERE party_id = ? AND citizen_id = ?', [p.id, citizen_id]);
    await notify(citizen_id, 'PARTAI', 'Lamaranmu ditolak', `Lamaranmu ke partai ${p.name} ditolak.`);
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

  // Mengeluarkan anggota (v5.7.2) — HANYA ketua (server-enforced).
  // Ketua tidak bisa mengeluarkan dirinya sendiri (pakai dissolve untuk
  // itu — leave ketua tetap ditolak). Lamaran pending BUKAN anggota:
  // pakai reject untuk menolak pelamar.
  app.post('/api/parties/:id/kick', authRequired, citizenRequired, r(async (req, res) => {
    const p = await one('SELECT * FROM parties WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Partai tidak ditemukan.' });
    if (p.leader_id !== req.citizen.id) return res.status(403).json({ error: 'Hanya ketua partai yang bisa mengeluarkan anggota.' });
    const { citizen_id } = req.body || {};
    if (Number(citizen_id) === p.leader_id) return res.status(400).json({ error: 'Ketua tidak bisa mengeluarkan dirinya sendiri. Bubarkan partai atau serahkan kepemimpinan dulu.' });
    const m = await one("SELECT * FROM party_members WHERE party_id = ? AND citizen_id = ? AND role IN ('leader','secretary','member')", [p.id, citizen_id]);
    if (!m) return res.status(404).json({ error: 'Warga itu bukan anggota partai ini.' });
    await tx(async (t) => {
      await t.run('DELETE FROM party_members WHERE party_id = ? AND citizen_id = ?', [p.id, citizen_id]);
      await t.run('UPDATE citizens SET party_id = NULL WHERE id = ? AND party_id = ?', [citizen_id, p.id]);
    });
    // Kursi parlemen TIDAK berubah: party_seats adalah alokasi PER PARTAI
    // (dihitung ulang tiap pemilu parlemen ditutup, tick.js) — bukan per
    // anggota. Status anggota parlemen yang di-kick ikut hilang otomatis
    // karena isMpCitizen() mensyaratkan party_id yang punya kursi.
    // Pencalonan presiden yang sudah berjalan TIDAK dibatalkan: pencalonan
    // dinilai saat nominasi (calon harus anggota saat itu) dan suara yang
    // sudah masuk tetap sah — lihat docs/ARSITEKTUR.md.
    await notify(citizen_id, 'PARTAI', 'Kamu dikeluarkan dari partai', `Ketua mengeluarkanmu dari partai ${p.name}. Kamu kini tidak berpartai.`);
    res.json({ ok: true });
  }));

  // Membubarkan partai (v5.7.2) — HANYA ketua (server-enforced).
  // Atomik: baris partai + seluruh keanggotaan + lamaran pending +
  // party_seats partai itu dihapus; semua (mantan) anggota jadi tidak
  // berpartai. Kursi parlemen partai ikut HILANG sampai pemilu parlemen
  // berikutnya (party_seats dihitung ulang tiap pemilu ditutup).
  // DITOLAK bila partai punya kandidat di pemilu yang sedang BERJALAN
  // ('open'): suara yang sudah masuk tidak boleh hangus, dan tick
  // penutup pemilu parlemen akan mengalokasikan kursi ke partai yang
  // sudah tidak ada (FK party_seats → parties). Tunggu pemilu selesai
  // dulu — pencalonan hanya ada di pemilu 'open', jadi penolakan ini
  // tidak pernah mengunci partai selamanya.
  app.post('/api/parties/:id/dissolve', authRequired, citizenRequired, r(async (req, res) => {
    const p = await one('SELECT * FROM parties WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Partai tidak ditemukan.' });
    if (p.leader_id !== req.citizen.id) return res.status(403).json({ error: 'Hanya ketua partai yang bisa membubarkan partai.' });
    const active = await one(
      `SELECT ec.election_id FROM election_candidates ec JOIN elections e ON e.id = ec.election_id
       WHERE ec.party_id = ? AND e.status = 'open' LIMIT 1`, [p.id]);
    if (active) return res.status(400).json({ error: 'Partai ini sedang punya kandidat di pemilu yang sedang berjalan. Tunggu pemilu selesai dulu sebelum membubarkan partai.' });
    const memberIds = await tx(async (t) => {
      const members = await t.sql('SELECT citizen_id FROM party_members WHERE party_id = ?', [p.id]);
      await t.run('DELETE FROM party_members WHERE party_id = ?', [p.id]);
      await t.run('DELETE FROM party_seats WHERE party_id = ?', [p.id]);
      await t.run('UPDATE citizens SET party_id = NULL WHERE party_id = ?', [p.id]);
      await t.run('DELETE FROM parties WHERE id = ?', [p.id]);
      return members.map((m) => m.citizen_id);
    });
    for (const id of memberIds) {
      if (id === req.citizen.id) continue;
      await notify(id, 'PARTAI', 'Partaimu dibubarkan', `Ketua membubarkan partai ${p.name}. Kamu kini tidak berpartai; kursi parlemen partai ini ikut hilang.`);
    }
    res.json({ ok: true });
  }));

  // ---------- PARLEMEN ----------
  // Parlemen dibuka 28 Nov 2026 20:00 WIB (lihat parliamentStatus). Sebelum dibuka:
  // parliamentOpen=false + parliamentOpensAt — frontend menampilkan
  // countdown + mengunci fitur (POST law/vote/impeach/budget menolak 403).
  // Setelah dibuka: UU/anggaran/pemakzulan HANYA milik negara pemanggil.
  app.get('/api/parliament', authRequired, citizenRequired, r(async (req, res) => {
    const c = req.citizen;
    const par = await parliamentStatus();
    const country = await getMyCountry({ one }, c);
    const countryId = country?.id || -1;
    const seats = await one('SELECT COALESCE(SUM(seats),0) AS n FROM party_seats WHERE country_id = ?', [countryId]);
    const isMp = await isMpCitizen(c);
    // Pemilu berikutnya (v5.7.5): sumber yang sama dengan /api/country.
    const nextElectionRow = country ? await one(
      "SELECT id, type, status, opens_at FROM elections WHERE country_id = ? AND status IN ('scheduled','open') ORDER BY opens_at ASC LIMIT 1",
      [country.id]) : null;
    const nextElection = nextElectionRow ? { id: nextElectionRow.id, type: nextElectionRow.type, status: nextElectionRow.status, opensAt: Number(nextElectionRow.opens_at) } : null;
    const laws = await sql(
      `SELECT l.*, u.username AS proposer_name FROM laws l
       JOIN citizens cc ON cc.id = l.proposer_id JOIN users u ON u.id = cc.user_id
       WHERE l.country_id = ? ORDER BY l.created_at DESC LIMIT 20`,
      [countryId]);
    const myVotes = await sql('SELECT law_id, vote FROM law_votes WHERE citizen_id = ?', [c.id]);
    // Anggaran (Tahap 5): voting + arsip, lengkap dengan suaraku.
    const budgets = await sql(
      `SELECT b.*, u.username AS proposer_name FROM budgets b
       JOIN citizens cc ON cc.id = b.proposer_id JOIN users u ON u.id = cc.user_id
       WHERE b.country_id = ? ORDER BY b.created_at DESC LIMIT 10`,
      [countryId]);
    const myBudgetVotes = await sql('SELECT budget_id, vote FROM budget_votes WHERE citizen_id = ?', [c.id]);
    // Pemakzulan (Tahap 5): voting + arsip.
    const impeachments = await sql(
      `SELECT i.*, u.username AS proposer_name, pu.username AS president_name FROM impeachments i
       JOIN citizens cc ON cc.id = i.proposer_id JOIN users u ON u.id = cc.user_id
       JOIN citizens pc ON pc.id = i.president_id JOIN users pu ON pu.id = pc.user_id
       WHERE i.country_id = ? ORDER BY i.created_at DESC LIMIT 10`,
      [countryId]);
    const myImpeachVotes = await sql('SELECT impeachment_id, vote FROM impeachment_votes WHERE citizen_id = ?', [c.id]);
    // Mosi perang + mosi nama (v5.7.0): voting + arsip.
    const warMotions = await sql(
      `SELECT m.*, u.username AS proposer_name, r.name AS region_name, COALESCE(c2.name, ?) AS target_name FROM war_motions m
       JOIN citizens cc ON cc.id = m.proposer_id JOIN users u ON u.id = cc.user_id
       JOIN regions r ON r.id = m.region_id LEFT JOIN country c2 ON c2.id = m.target_country_id
       WHERE m.country_id = ? ORDER BY m.created_at DESC LIMIT 10`,
      [COUNTRY_NAME_PLACEHOLDER, countryId]);
    const myWarMotionVotes = await sql('SELECT motion_id, vote FROM war_motion_votes WHERE citizen_id = ?', [c.id]);
    const nameMotions = await sql(
      `SELECT m.*, u.username AS proposer_name FROM name_motions m
       JOIN citizens cc ON cc.id = m.proposer_id JOIN users u ON u.id = cc.user_id
       WHERE m.country_id = ? ORDER BY m.created_at DESC LIMIT 10`,
      [countryId]);
    const myNameMotionVotes = await sql('SELECT motion_id, vote FROM name_motion_votes WHERE citizen_id = ?', [c.id]);
    // Aturan yang berlaku saat ini (Tahap 5): angka negara hasil UU yang
    // sudah disahkan — satu-satunya sumber kebenaran tarif/angka. Tanpa
    // negara: pajak 0%, upah ×1, perjalanan 1 tiket.
    res.json({
      totalSeats: 60, filledSeats: Number(seats.n), majority: 31, isMp,
      parliamentOpen: par.open, parliamentOpensAt: par.opensAt,
      nextElection,
      country: countrySummary(country),
      laws, myVotes: Object.fromEntries(myVotes.map((v) => [v.law_id, v.vote])),
      budgets, myBudgetVotes: Object.fromEntries(myBudgetVotes.map((v) => [v.budget_id, v.vote])),
      impeachments, myImpeachVotes: Object.fromEntries(myImpeachVotes.map((v) => [v.impeachment_id, v.vote])),
      warMotions, myWarMotionVotes: Object.fromEntries(myWarMotionVotes.map((v) => [v.motion_id, v.vote])),
      nameMotions, myNameMotionVotes: Object.fromEntries(myNameMotionVotes.map((v) => [v.motion_id, v.vote])),
      effects: {
        taxIncome: country ? Number(country.tax_income) : 0, adminPayMult: country ? Number(country.admin_pay_mult) : 1,
        travelTickets: country ? Number(country.travel_tickets) : 1,
        budgetKind: budgetActive(country), budgetUntil: Number(country?.budget_until) || 0,
        mobilizationUntil: Number(country?.mobilization_until) || 0,
      },
    });
  }));

  app.post('/api/parliament/law', authRequired, citizenRequired, r(async (req, res) => {
    const { title, content, kind, value } = req.body || {};
    const c = req.citizen;
    // Parlemen terkunci sampai dibuka (28 Nov 2026 20:00 WIB).
    const par = await parliamentStatus();
    if (!par.open) return res.status(403).json({ error: parliamentLockedError(par.opensAt) });
    const country = await getMyCountry({ one }, c);
    if (!country) return res.status(400).json({ error: 'Kamu belum bernegara — dirikan negara atau gabung lewat unifikasi dulu.' });
    // v5.7.5 (aturan pemilik 28 Nov 2026): HANYA anggota parlemen yang
    // bisa mengusulkan UU — warga biasa (Level 5+) tidak lagi bisa.
    if (!await isMpCitizen(c)) return res.status(403).json({ error: 'Hanya anggota parlemen yang bisa mengusulkan UU. Partaimu belum punya kursi.' });
    if (c.level < 5) return res.status(400).json({ error: 'Mengusulkan UU butuh Level 5.' });
    if (!title || title.length < 5 || title.length > 120) return res.status(400).json({ error: 'Judul UU 5–120 karakter.' });
    if (!content || content.length < 10) return res.status(400).json({ error: 'Isi UU minimal 10 karakter.' });
    // Jenis UU (Tahap 5, BUG-9): 'general' = UU umum tanpa efek angka;
    // jenis lain wajib punya nilai dalam rentang yang diizinkan. Jenis
    // 'ideology'/'system' (redesain dunia): nilai = indeks daftar
    // (ideologi 0–3, sistem 0–3).
    const lawKind = LAW_KINDS[kind] ? kind : 'general';
    let lawValue = null;
    if (lawKind !== 'general') {
      lawValue = Number(value);
      const def = LAW_KINDS[lawKind];
      if (!Number.isFinite(lawValue) || lawValue < def.min || lawValue > def.max
        || (['travel', 'ideology', 'system'].includes(lawKind) && !Number.isInteger(lawValue))) {
        return res.status(400).json({ error: `${def.label}: nilai ${def.min}–${def.max}.` });
      }
    }
    // Menteri Ekonomi mengusulkan UU gratis (wewenang jabatan) — warga lain
    // membayar biaya notaris 5 emas seperti sebelumnya.
    const free = ministerRole(country, c.id) === 'economy';
    // Atomik: kunci baris warga + potong 5 emas bersyarat di dalam tx.
    const lawId = await tx(async (t) => {
      await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [c.id]);
      const law = await t.run(
        'INSERT INTO laws (proposer_id, title, content, kind, value, status, ends_at, country_id, created_at) VALUES (?,?,?,?,?,\'voting\',?,?,?) RETURNING id',
        [c.id, title, content, lawKind, lawValue, Date.now() + 7 * DAY_MS, country.id, Date.now()]);
      if (free) {
        await t.run('UPDATE citizens SET laws_proposed = laws_proposed + 1 WHERE id = ?', [c.id]);
      } else {
        const upd = await t.run('UPDATE citizens SET gold = gold - 5, laws_proposed = laws_proposed + 1 WHERE id = ? AND gold >= 5', [c.id]);
        if (!upd.changes) throw Object.assign(new Error('Biaya notaris pengusulan UU: 5 emas.'), { status: 400 });
      }
      return law.id;
    });
    await chronicleDone(c, 'law');
    res.json({ ok: true, lawId });
  }));

  app.post('/api/parliament/vote', authRequired, citizenRequired, r(async (req, res) => {
    const { law_id, vote } = req.body || {};
    if (!['yes', 'abstain', 'no'].includes(vote)) return res.status(400).json({ error: 'Pilihan suara tidak dikenal.' });
    const par = await parliamentStatus();
    if (!par.open) return res.status(403).json({ error: parliamentLockedError(par.opensAt) });
    const c = req.citizen;
    if (!await isMpCitizen(c)) return res.status(403).json({ error: 'Hanya anggota parlemen yang bisa memilih. Partaimu belum punya kursi.' });
    const law = await one("SELECT * FROM laws WHERE id = ? AND status = 'voting' AND ends_at > ?", [law_id, Date.now()]);
    if (!law) return res.status(404).json({ error: 'UU tidak ditemukan / voting sudah ditutup.' });
    const myCountry = await getMyCountry({ one }, c);
    if (!myCountry || law.country_id !== myCountry.id) return res.status(403).json({ error: 'UU ini bukan dari negaramu.' });
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

  // ---------- MOSI PERANG + MOSI NAMA (v5.7.0) ----------
  // Mosi perang: usulan menyerang wilayah negara lain. Voting 3 hari,
  // hanya anggota parlemen; lolos bila YA >= 31 (mayoritas 60 kursi) —
  // lalu perang antar-negara dideklarasikan (tick menutup mosi; target
  // divalidasi ulang saat itu). Satu mosi perang aktif per negara.
  // Biaya 5 emas flat (tidak ada jabatan yang gratis).
  app.post('/api/parliament/war-motion', authRequired, citizenRequired, r(async (req, res) => {
    const { region_id } = req.body || {};
    const par = await parliamentStatus();
    if (!par.open) return res.status(403).json({ error: parliamentLockedError(par.opensAt) });
    const c = req.citizen;
    const country = await getMyCountry({ one }, c);
    if (!country) return res.status(400).json({ error: 'Kamu belum bernegara — dirikan negara atau gabung lewat unifikasi dulu.' });
    // v5.7.5 (aturan pemilik 28 Nov 2026): HANYA anggota parlemen yang
    // bisa mengusulkan mosi perang.
    if (!await isMpCitizen(c)) return res.status(403).json({ error: 'Hanya anggota parlemen yang bisa mengusulkan mosi perang. Partaimu belum punya kursi.' });
    if (c.level < 5) return res.status(400).json({ error: 'Mengusulkan mosi perang butuh Level 5.' });
    const region = await one('SELECT * FROM regions WHERE id = ?', [region_id]);
    if (!region) return res.status(404).json({ error: 'Wilayah tidak ditemukan.' });
    const existing = await one("SELECT id FROM war_motions WHERE country_id = ? AND status = 'voting'", [country.id]);
    if (existing) return res.status(400).json({ error: 'Negaramu sudah punya mosi perang yang sedang divoting.' });
    try {
      await checkWarTarget({ one, sql, run }, country, region);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    const motionId = await tx(async (t) => {
      await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [c.id]);
      const again = await t.one("SELECT id FROM war_motions WHERE country_id = ? AND status = 'voting'", [country.id]);
      if (again) throw Object.assign(new Error('Negaramu sudah punya mosi perang yang sedang divoting.'), { status: 400 });
      const upd = await t.run(`UPDATE citizens SET gold = gold - ${MOTION_COST_GOLD} WHERE id = ? AND gold >= ${MOTION_COST_GOLD}`, [c.id]);
      if (!upd.changes) throw Object.assign(new Error(`Biaya pengusulan mosi perang: ${MOTION_COST_GOLD} emas.`), { status: 400 });
      const ins = await t.run(
        'INSERT INTO war_motions (proposer_id, country_id, target_country_id, region_id, status, ends_at, created_at) VALUES (?,?,?,?,\'voting\',?,?) RETURNING id',
        [c.id, country.id, region.country_id, region.id, Date.now() + WAR_MOTION_VOTE_DAYS * DAY_MS, Date.now()]);
      return ins.id;
    });
    res.json({ ok: true, motionId });
  }));

  app.post('/api/parliament/war-motion/:id/vote', authRequired, citizenRequired, r(async (req, res) => {
    const { vote } = req.body || {};
    if (!['yes', 'no'].includes(vote)) return res.status(400).json({ error: 'Pilihan suara tidak dikenal (ya/tidak).' });
    const par = await parliamentStatus();
    if (!par.open) return res.status(403).json({ error: parliamentLockedError(par.opensAt) });
    const c = req.citizen;
    if (!await isMpCitizen(c)) return res.status(403).json({ error: 'Hanya anggota parlemen yang bisa memilih. Partaimu belum punya kursi.' });
    const m = await one("SELECT * FROM war_motions WHERE id = ? AND status = 'voting' AND ends_at > ?", [req.params.id, Date.now()]);
    if (!m) return res.status(404).json({ error: 'Mosi perang tidak ditemukan / voting sudah ditutup.' });
    const myCountry = await getMyCountry({ one }, c);
    if (!myCountry || m.country_id !== myCountry.id) return res.status(403).json({ error: 'Mosi ini bukan dari negaramu.' });
    const col = vote === 'yes' ? 'yes' : 'no';
    await tx(async (t) => {
      const ins = await t.run('INSERT INTO war_motion_votes (motion_id, citizen_id, vote) VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING motion_id', [m.id, c.id, vote]);
      if (!ins.changes) throw Object.assign(new Error('Kamu sudah memilih untuk mosi ini.'), { status: 400 });
      await t.run(`UPDATE war_motions SET ${col} = ${col} + 1 WHERE id = ?`, [m.id]);
    });
    res.json({ ok: true });
  }));

  // Mosi penetapan nama negara: nama DITENTUKAN parlemen (bukan pendiri).
  // Voting 7 hari, hanya anggota parlemen; lolos bila YA >= 31 — lalu
  // country.name diisi (tick menutup mosi; keunikan dicek ulang saat itu).
  // Satu mosi nama aktif per negara. Biaya 5 emas, gratis untuk Menteri
  // Ekonomi (cermin biaya UU).
  app.post('/api/parliament/name', authRequired, citizenRequired, r(async (req, res) => {
    const { name } = req.body || {};
    const par = await parliamentStatus();
    if (!par.open) return res.status(403).json({ error: parliamentLockedError(par.opensAt) });
    const c = req.citizen;
    const country = await getMyCountry({ one }, c);
    if (!country) return res.status(400).json({ error: 'Kamu belum bernegara — dirikan negara atau gabung lewat unifikasi dulu.' });
    // v5.7.5 (aturan pemilik 28 Nov 2026): HANYA anggota parlemen yang
    // bisa mengusulkan nama negara.
    if (!await isMpCitizen(c)) return res.status(403).json({ error: 'Hanya anggota parlemen yang bisa mengusulkan nama negara. Partaimu belum punya kursi.' });
    if (c.level < 5) return res.status(400).json({ error: 'Mengusulkan nama negara butuh Level 5.' });
    const cleanName = String(name || '').trim();
    if (!cleanName || cleanName.length < COUNTRY_NAME_MIN || cleanName.length > COUNTRY_NAME_MAX) return res.status(400).json({ error: `Nama negara ${COUNTRY_NAME_MIN}–${COUNTRY_NAME_MAX} karakter.` });
    const taken = await one('SELECT id FROM country WHERE LOWER(name) = LOWER(?)', [cleanName]);
    if (taken) return res.status(400).json({ error: 'Nama negara sudah dipakai.' });
    const existing = await one("SELECT id FROM name_motions WHERE country_id = ? AND status = 'voting'", [country.id]);
    if (existing) return res.status(400).json({ error: 'Negaramu sudah punya mosi nama yang sedang divoting.' });
    const free = ministerRole(country, c.id) === 'economy';
    const motionId = await tx(async (t) => {
      await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [c.id]);
      const again = await t.one("SELECT id FROM name_motions WHERE country_id = ? AND status = 'voting'", [country.id]);
      if (again) throw Object.assign(new Error('Negaramu sudah punya mosi nama yang sedang divoting.'), { status: 400 });
      const dup = await t.one('SELECT id FROM country WHERE LOWER(name) = LOWER(?)', [cleanName]);
      if (dup) throw Object.assign(new Error('Nama negara sudah dipakai.'), { status: 400 });
      if (!free) {
        const upd = await t.run(`UPDATE citizens SET gold = gold - ${MOTION_COST_GOLD} WHERE id = ? AND gold >= ${MOTION_COST_GOLD}`, [c.id]);
        if (!upd.changes) throw Object.assign(new Error(`Biaya pengusulan mosi nama: ${MOTION_COST_GOLD} emas.`), { status: 400 });
      }
      const ins = await t.run(
        'INSERT INTO name_motions (proposer_id, country_id, name, status, ends_at, created_at) VALUES (?,?,?,\'voting\',?,?) RETURNING id',
        [c.id, country.id, cleanName, Date.now() + NAME_MOTION_VOTE_DAYS * DAY_MS, Date.now()]);
      return ins.id;
    });
    res.json({ ok: true, motionId });
  }));

  app.post('/api/parliament/name/:id/vote', authRequired, citizenRequired, r(async (req, res) => {
    const { vote } = req.body || {};
    if (!['yes', 'no'].includes(vote)) return res.status(400).json({ error: 'Pilihan suara tidak dikenal (ya/tidak).' });
    const par = await parliamentStatus();
    if (!par.open) return res.status(403).json({ error: parliamentLockedError(par.opensAt) });
    const c = req.citizen;
    if (!await isMpCitizen(c)) return res.status(403).json({ error: 'Hanya anggota parlemen yang bisa memilih. Partaimu belum punya kursi.' });
    const m = await one("SELECT * FROM name_motions WHERE id = ? AND status = 'voting' AND ends_at > ?", [req.params.id, Date.now()]);
    if (!m) return res.status(404).json({ error: 'Mosi nama tidak ditemukan / voting sudah ditutup.' });
    const myCountry = await getMyCountry({ one }, c);
    if (!myCountry || m.country_id !== myCountry.id) return res.status(403).json({ error: 'Mosi ini bukan dari negaramu.' });
    const col = vote === 'yes' ? 'yes' : 'no';
    await tx(async (t) => {
      const ins = await t.run('INSERT INTO name_motion_votes (motion_id, citizen_id, vote) VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING motion_id', [m.id, c.id, vote]);
      if (!ins.changes) throw Object.assign(new Error('Kamu sudah memilih untuk mosi ini.'), { status: 400 });
      await t.run(`UPDATE name_motions SET ${col} = ${col} + 1 WHERE id = ?`, [m.id]);
    });
    res.json({ ok: true });
  }));

  // ---------- PEMAKZULAN ---------- (Tahap 5)
  // Anggota parlemen mengusulkan pemakzulan presiden; voting 3 hari;
  // bila lolos, presiden dicopot (president_id = NULL) sampai pemilu
  // berikutnya — penutupannya di tick.js §4c. Satu pemakzulan aktif
  // dalam satu waktu. Presiden tidak bisa memakzulkan dirinya sendiri.
  app.post('/api/parliament/impeach', authRequired, citizenRequired, r(async (req, res) => {
    const par = await parliamentStatus();
    if (!par.open) return res.status(403).json({ error: parliamentLockedError(par.opensAt) });
    if (!await isMpCitizen(req.citizen)) return res.status(403).json({ error: 'Hanya anggota parlemen yang bisa mengusulkan pemakzulan.' });
    const country = await getMyCountry({ one }, req.citizen);
    if (!country) return res.status(400).json({ error: 'Kamu belum bernegara.' });
    if (!country.president_id) return res.status(400).json({ error: 'Tidak ada presiden yang menjabat.' });
    if (country.president_id === req.citizen.id) return res.status(400).json({ error: 'Presiden tidak bisa memakzulkan dirinya sendiri.' });
    const active = await one("SELECT id FROM impeachments WHERE country_id = ? AND status = 'voting' AND ends_at > ?", [country.id, Date.now()]);
    if (active) return res.status(400).json({ error: 'Sudah ada pemakzulan yang sedang divoting.' });
    const imp = await run('INSERT INTO impeachments (president_id, proposer_id, status, ends_at, country_id, created_at) VALUES (?,?,\'voting\',?,?,?) RETURNING id',
      [country.president_id, req.citizen.id, Date.now() + BUDGET_VOTE_DAYS * DAY_MS, country.id, Date.now()]);
    res.json({ ok: true, impeachmentId: imp.id });
  }));

  app.post('/api/parliament/impeach/:id/vote', authRequired, citizenRequired, r(async (req, res) => {
    const { vote } = req.body || {};
    if (!['yes', 'no'].includes(vote)) return res.status(400).json({ error: 'Pilihan suara tidak dikenal.' });
    const par = await parliamentStatus();
    if (!par.open) return res.status(403).json({ error: parliamentLockedError(par.opensAt) });
    if (!await isMpCitizen(req.citizen)) return res.status(403).json({ error: 'Hanya anggota parlemen yang bisa memilih pemakzulan.' });
    const imp = await one("SELECT * FROM impeachments WHERE id = ? AND status = 'voting' AND ends_at > ?", [req.params.id, Date.now()]);
    if (!imp) return res.status(404).json({ error: 'Pemakzulan tidak ditemukan / voting sudah ditutup.' });
    const myCountry = await getMyCountry({ one }, req.citizen);
    if (!myCountry || imp.country_id !== myCountry.id) return res.status(403).json({ error: 'Pemakzulan ini bukan dari negaramu.' });
    const col = vote === 'yes' ? 'yes' : 'no';
    await tx(async (t) => {
      const ins = await t.run('INSERT INTO impeachment_votes (impeachment_id, citizen_id, vote) VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING impeachment_id', [imp.id, req.citizen.id, vote]);
      if (!ins.changes) throw Object.assign(new Error('Kamu sudah memilih untuk pemakzulan ini.'), { status: 400 });
      await t.run(`UPDATE impeachments SET ${col} = ${col} + 1 WHERE id = ?`, [imp.id]);
    });
    res.json({ ok: true });
  }));

  // ---------- PEMILU ----------
  // Pemilu per NEGARA (redesain dunia): warga hanya melihat + memilih di
  // pemilu negaranya sendiri. Parlemen dipilih rakyat (vote Level 5 + 3
  // hari jadi warga); presiden dipilih rakyat — KECUALI di sistem
  // Parlementer, presiden dipilih hanya oleh anggota parlemen.
  app.get('/api/elections', authRequired, citizenRequired, r(async (req, res) => {
    const myCountry = await getMyCountry({ one }, req.citizen);
    const current = myCountry
      ? await sql('SELECT * FROM elections WHERE country_id = ? ORDER BY created_at DESC LIMIT 5', [myCountry.id])
      : [];
    const out = [];
    for (const e of current) {
      const cands = await sql(
        `SELECT ec.*, u.username, p.name AS party_name, p.tag AS party_tag FROM election_candidates ec
         JOIN citizens c ON c.id = ec.citizen_id JOIN users u ON u.id = c.user_id
         LEFT JOIN parties p ON p.id = ec.party_id WHERE ec.election_id = ? ORDER BY ec.votes DESC`,
        [e.id]);
      const myVote = await one('SELECT * FROM election_votes WHERE election_id = ? AND citizen_id = ?', [e.id, req.citizen.id]);
      const winner = e.winner_id ? await one('SELECT u.username FROM citizens c JOIN users u ON u.id = c.user_id WHERE c.id = ?', [e.winner_id]) : null;
      // Pemilu parlemen (v5.7.0): warga memilih PARTAI — daftar partai
      // peserta + perolehan suaranya (satu baris per partai terdaftar).
      let parties = null;
      if (e.type === 'parliament') {
        parties = await sql(
          `SELECT p.id, p.name, p.tag, COALESCE(SUM(ec.votes), 0) AS votes
           FROM election_candidates ec JOIN parties p ON p.id = ec.party_id
           WHERE ec.election_id = ? GROUP BY p.id, p.name, p.tag ORDER BY votes DESC, p.name ASC`, [e.id]);
      }
      out.push({ ...e, candidates: cands, parties, myVote: myVote || null, winner: winner?.username || null });
    }
    const canVote = req.citizen.level >= 5 && (Date.now() - req.citizen.created_at) >= ELECTION_VOTE_MIN_AGE_MS;
    res.json({ elections: out, canVote, country: countrySummary(myCountry) });
  }));

  // Nominasi calon presiden — ATURAN PEMILIK: calon HARUS lewat partai,
  // kepala partai yang menominasikan (TIDAK ada daftar sendiri). Kepala
  // partai boleh menominasikan dirinya sendiri ATAU anggota partainya
  // (mekanismenya nominasi oleh kepala, bukan pendaftaran oleh anggota).
  // Satu kandidat per partai per pemilu. Calon harus warga negara yang sama.
  app.post('/api/elections/:id/nominate', authRequired, citizenRequired, requireCredit(CREDIT_MIN_FOR.party, 'mencalonkan di pemilu'),  r(async (req, res) => {
    const { citizen_id } = req.body || {};
    const e = await one("SELECT * FROM elections WHERE id = ? AND status = 'open' AND type = 'president'", [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Pemilu presiden yang sedang dibuka tidak ditemukan.' });
    const c = req.citizen;
    if (!c.party_id) return res.status(400).json({ error: 'Hanya kepala partai yang bisa menominasikan calon presiden.' });
    const party = await one('SELECT * FROM parties WHERE id = ?', [c.party_id]);
    if (!party || party.leader_id !== c.id) return res.status(400).json({ error: 'Hanya kepala partai yang bisa menominasikan calon presiden.' });
    const nominee = await one('SELECT * FROM citizens WHERE id = ?', [citizen_id]);
    if (!nominee) return res.status(404).json({ error: 'Calon tidak ditemukan.' });
    if (nominee.party_id !== party.id) return res.status(400).json({ error: 'Calon harus anggota partaimu.' });
    const nomineeCountry = await getMyCountry({ one }, nominee);
    const myCountry = await getMyCountry({ one }, c);
    if (!myCountry || !nomineeCountry || nomineeCountry.id !== myCountry.id) return res.status(400).json({ error: 'Calon harus warga negara yang sama.' });
    if (e.country_id !== myCountry.id) return res.status(400).json({ error: 'Pemilu ini bukan dari negaramu.' });
    const existingParty = await one('SELECT * FROM election_candidates WHERE election_id = ? AND party_id = ?', [e.id, party.id]);
    if (existingParty) return res.status(400).json({ error: 'Partaimu sudah mencalonkan seseorang di pemilu ini.' });
    const existing = await one('SELECT * FROM election_candidates WHERE election_id = ? AND citizen_id = ?', [e.id, nominee.id]);
    if (existing) return res.status(400).json({ error: 'Calon sudah terdaftar di pemilu ini.' });
    await run('INSERT INTO election_candidates (election_id, citizen_id, party_id, votes) VALUES (?,?,?,0) RETURNING election_id', [e.id, nominee.id, party.id]);
    await notify(nominee.id, 'POLITIK', 'Kamu dicalonkan jadi presiden', `${party.name} menominasikanmu sebagai calon presiden ${myCountry.name}.`);
    res.json({ ok: true });
  }));

  // Daftarkan partai sebagai peserta pemilu parlemen (sebelumnya tidak ada
  // jalur pendaftaran sama sekali — partai tidak pernah bisa menang kursi
  // lewat pemilu). Satu partai = satu baris kandidat; suara untuk partai
  // dihitung dari baris ini, kursi dibagi tick saat pemilu ditutup.
  app.post('/api/elections/:id/register-party', authRequired, citizenRequired, requireCredit(CREDIT_MIN_FOR.party, 'mendaftarkan partai ke pemilu'),  r(async (req, res) => {
    const e = await one("SELECT * FROM elections WHERE id = ? AND status = 'open' AND type = 'parliament'", [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Pemilu parlemen yang sedang dibuka tidak ditemukan.' });
    const c = req.citizen;
    if (!c.party_id) return res.status(400).json({ error: 'Hanya kepala partai yang bisa mendaftarkan partainya.' });
    const party = await one('SELECT * FROM parties WHERE id = ?', [c.party_id]);
    if (!party || party.leader_id !== c.id) return res.status(400).json({ error: 'Hanya kepala partai yang bisa mendaftarkan partainya.' });
    const myCountry = await getMyCountry({ one }, c);
    if (!myCountry || e.country_id !== myCountry.id) return res.status(400).json({ error: 'Pemilu ini bukan dari negaramu.' });
    const existing = await one('SELECT * FROM election_candidates WHERE election_id = ? AND party_id = ?', [e.id, party.id]);
    if (existing) return res.status(400).json({ error: 'Partaimu sudah terdaftar di pemilu ini.' });
    // Baris kandidat parlemen memakai citizen_id = kepala partai sebagai
    // penanda (suara dihitung per partai, bukan per orang).
    await run('INSERT INTO election_candidates (election_id, citizen_id, party_id, votes) VALUES (?,?,?,0) RETURNING election_id', [e.id, c.id, party.id]);
    res.json({ ok: true });
  }));

  app.post('/api/elections/:id/vote', authRequired, citizenRequired, r(async (req, res) => {
    const { candidate_id, party_id } = req.body || {};
    const e = await one("SELECT * FROM elections WHERE id = ? AND status = 'open'", [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Pemilu yang sedang dibuka tidak ditemukan.' });
    const c = req.citizen;
    if (c.level < 5) return res.status(400).json({ error: 'Hak pilih mulai Level 5.' });
    if (Date.now() - c.created_at < ELECTION_VOTE_MIN_AGE_MS) return res.status(400).json({ error: 'Warga baru bisa memilih setelah 3 hari menjadi warga.' });
    const myCountry = await getMyCountry({ one }, c);
    if (!myCountry || e.country_id !== myCountry.id) return res.status(403).json({ error: 'Pemilu ini bukan dari negaramu.' });
    // Sistem Parlementer: pemilu presiden hanya dipilih anggota parlemen.
    if (e.type === 'president' && myCountry.system === 'parlementer' && !await isMpCitizen(c)) {
      return res.status(403).json({ error: 'Di sistem Parlementer, presiden dipilih hanya oleh anggota parlemen.' });
    }
    // Pemilu PARLEMEN (v5.7.0): warga memilih PARTAI langsung, bukan
    // kandidat — suara disimpan per partai (party_id), candidate_id NULL.
    // Vote kandidat (candidate_id tanpa party_id) di pemilu parlemen
    // DITOLAK. Kursi dihitung tick dari suara partai (60 kursi proporsional).
    if (e.type === 'parliament') {
      if (!party_id) return res.status(400).json({ error: 'Di pemilu parlemen, kamu memilih partai — bukan kandidat.' });
      const reg = await one('SELECT * FROM election_candidates WHERE election_id = ? AND party_id = ?', [e.id, party_id]);
      if (!reg) return res.status(404).json({ error: 'Partai ini tidak terdaftar di pemilu ini.' });
      await tx(async (t) => {
        const ins = await t.run('INSERT INTO election_votes (election_id, citizen_id, candidate_id, party_id) VALUES (?,?,NULL,?) ON CONFLICT DO NOTHING RETURNING election_id', [e.id, c.id, party_id]);
        if (!ins.changes) throw Object.assign(new Error('Kamu sudah memilih di pemilu ini.'), { status: 400 });
        await t.run('UPDATE election_candidates SET votes = votes + 1 WHERE election_id = ? AND party_id = ?', [e.id, party_id]);
      });
      await chronicleDone(c, 'vote');
      return res.json({ ok: true });
    }
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

  // ---------- PETISI PEMBUKA PEMILU PARLEMEN (v5.7.0, Tugas 6) ----------
  // Pemilu parlemen HANYA dibuka bila MASING-MASING wilayah di negara itu
  // punya minimal 5 warga pendukung (PARLIAMENT_PETITION_PER_REGION).
  // Syarat mendukung = syarat memilih (Level >= 5 + usia akun >= 3 hari).
  // Petisi berlaku per siklus pemilu — pemilu baru butuh petisi baru.
  app.get('/api/elections/:id/petition', authRequired, citizenRequired, r(async (req, res) => {
    const e = await one('SELECT * FROM elections WHERE id = ?', [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Pemilu tidak ditemukan.' });
    if (e.type !== 'parliament') return res.status(400).json({ error: 'Petisi hanya berlaku untuk pemilu parlemen.' });
    const myCountry = await getMyCountry({ one }, req.citizen);
    if (!myCountry || e.country_id !== myCountry.id) return res.status(403).json({ error: 'Pemilu ini bukan dari negaramu.' });
    const regions = await sql('SELECT id, name FROM regions WHERE country_id = ? ORDER BY name ASC', [e.country_id]);
    const out = [];
    let allMet = regions.length > 0;
    for (const r of regions) {
      const row = await one(
        `SELECT COUNT(*) AS n FROM election_petitions ep JOIN citizens c ON c.id = ep.citizen_id AND c.home_region_id = ep.region_id
         WHERE ep.election_id = ? AND ep.region_id = ?`, [e.id, r.id]);
      const count = row?.n || 0;
      const met = count >= PARLIAMENT_PETITION_PER_REGION;
      if (!met) allMet = false;
      out.push({ regionId: r.id, name: r.name, count, needed: PARLIAMENT_PETITION_PER_REGION, met });
    }
    const mine = await one('SELECT region_id FROM election_petitions WHERE election_id = ? AND citizen_id = ?', [e.id, req.citizen.id]);
    res.json({ election: { id: e.id, status: e.status, opensAt: e.opens_at }, regions: out, allMet, myRegionId: mine?.region_id || null });
  }));

  app.post('/api/elections/:id/petition', authRequired, citizenRequired, r(async (req, res) => {
    const e = await one('SELECT * FROM elections WHERE id = ?', [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Pemilu tidak ditemukan.' });
    if (e.type !== 'parliament') return res.status(400).json({ error: 'Petisi hanya berlaku untuk pemilu parlemen.' });
    if (e.status !== 'scheduled') return res.status(400).json({ error: e.status === 'open' ? 'Pemilu parlemen ini sudah dibuka — petisi tidak lagi diperlukan.' : 'Pemilu ini sudah ditutup.' });
    const c = req.citizen;
    if (c.level < 5) return res.status(400).json({ error: 'Mendukung petisi butuh Level 5 (sama seperti hak pilih).' });
    if (Date.now() - c.created_at < ELECTION_VOTE_MIN_AGE_MS) return res.status(400).json({ error: 'Warga baru bisa mendukung petisi setelah 3 hari menjadi warga.' });
    const myCountry = await getMyCountry({ one }, c);
    if (!myCountry || e.country_id !== myCountry.id) return res.status(403).json({ error: 'Pemilu ini bukan dari negaramu.' });
    const region = await one('SELECT id, name FROM regions WHERE id = ? AND country_id = ?', [c.home_region_id, myCountry.id]);
    if (!region) return res.status(400).json({ error: 'Wilayah asalmu bukan bagian dari negaramu.' });
    const ins = await run('INSERT INTO election_petitions (election_id, region_id, citizen_id, created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING RETURNING election_id',
      [e.id, region.id, c.id, Date.now()]);
    if (!ins.changes) return res.status(400).json({ error: 'Kamu sudah mendukung petisi pemilu ini.' });
    const row = await one(
      `SELECT COUNT(*) AS n FROM election_petitions ep JOIN citizens c2 ON c2.id = ep.citizen_id AND c2.home_region_id = ep.region_id
       WHERE ep.election_id = ? AND ep.region_id = ?`, [e.id, region.id]);
    const count = row?.n || 0;
    res.json({ ok: true, regionId: region.id, regionName: region.name, count, needed: PARLIAMENT_PETITION_PER_REGION, met: count >= PARLIAMENT_PETITION_PER_REGION });
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
    // Bonus Tahap 5 yang sedang berlaku untuk pemanggil (untuk ditampilkan
    // jujur di halaman perang: anggaran perang / mobilisasi / pakta /
    // ideologi Nasionalisme). Tanpa negara, hanya pakta yang bisa berlaku.
    const country = await getMyCountry({ one }, req.citizen);
    const bonus = await warDamageBonus({ one }, req.citizen.id, country);
    // Kekuatan militer (Tahap 6): unit yang direkrut memperkuat serangan —
    // pengali ×1,00–1,50 dari total kekuatan (maks 100). Ditampilkan di
    // halaman perang supaya pemain tahu bonusnya sebelum menyerang.
    const myPower = await militaryPowerOf(req.citizen.id);
    const milMult = unitDamageMult(myPower);
    if (myPower > 0) bonus.labels.push(`Pasukan +${Math.round((milMult - 1) * 100)}%`);
    // Amunisi + energi pemanggil (v5.7.0): halaman perang menampilkan
    // stok per tier + energi supaya pemain bisa memilih tier & energi
    // serangan. homeBonus = bertarung di wilayah asal (+15% damage).
    const myAmmo = await sql(
      `SELECT cm.name AS ammo, i.tier, i.qty FROM inventory i JOIN commodities cm ON cm.id = i.commodity_id
       WHERE i.citizen_id = ? AND cm.name IN ('Senjata','Drone') ORDER BY cm.name, i.tier ASC`, [req.citizen.id]);
    const me = await one('SELECT energy FROM citizens WHERE id = ?', [req.citizen.id]);
    res.json({ war, fighters, feed, totals, atFront, myRegion: req.citizen.region_id, bonuses: bonus.labels, militaryPower: myPower, militaryMult: Math.round(milMult * 100) / 100, mobilizationActive: Number(country?.mobilization_until) > Date.now(), budgetWarActive: budgetActive(country) === 'war', myAmmo, myEnergy: me?.energy ?? 0, homeBonus: req.citizen.home_region_id === war.region_id, energyMin: WAR_ATTACK_ENERGY_MIN, energyMax: WAR_ATTACK_ENERGY_MAX });
  }));

  // ---------- PERANG ANTAR-NEGARA (v5.7.0) ----------
  // Deklarasi perang HANYA oleh Menteri Pertahanan (Kemenhan) — jalur
  // kedua adalah mosi parlemen (lihat /api/parliament/war-motion).
  // Perang berlangsung 24 jam memakai mesin perang yang sama dengan
  // pemberontakan; bila penyerang menang, wilayah target DIJAJAH
  // (occupied_by = negara penyerang; lihat tick.js §5).
  app.post('/api/wars/declare', authRequired, citizenRequired, r(async (req, res) => {
    const { region_id } = req.body || {};
    const country = await getMyCountry({ one }, req.citizen);
    if (!country) return res.status(400).json({ error: 'Kamu belum bernegara — perang antar-negara hanya bisa dideklarasikan oleh sebuah negara.' });
    if (ministerRole(country, req.citizen.id) !== 'defense') return res.status(403).json({ error: 'Hanya Menteri Pertahanan (Kemenhan) yang bisa mendeklarasikan perang — atau lewat mosi parlemen.' });
    const region = await one('SELECT * FROM regions WHERE id = ?', [region_id]);
    if (!region) return res.status(404).json({ error: 'Wilayah tidak ditemukan.' });
    let warId;
    try {
      warId = await tx(async (t) => {
        const reg = await t.one(forUpdate('SELECT * FROM regions WHERE id = ?'), [region.id]);
        return declareCountryWar(t, country, reg);
      });
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    const target = await one('SELECT * FROM country WHERE id = ?', [region.country_id]);
    await notifyAll('PERANG', `Perang dideklarasikan`, `${countryDisplayName(country)} mendeklarasikan perang terhadap ${countryDisplayName(target)} atas wilayah ${region.name}.`);
    res.json({ ok: true, warId });
  }));

  app.post('/api/wars/:id/attack', authRequired, citizenRequired, r(async (req, res) => {
    const { side, ammo, tier, energy } = req.body || {};
    const war = await one("SELECT * FROM wars WHERE id = ? AND status = 'active'", [req.params.id]);
    if (!war) return res.status(404).json({ error: 'Tidak ada perang aktif di sini.' });
    if (!['attacker', 'defender'].includes(side)) return res.status(400).json({ error: 'Pilih pihak: penyerang atau pembela.' });
    const c = await loadCitizen(req.userId);
    if (c.region_id !== war.region_id) return res.status(400).json({ error: 'Kamu harus berada di wilayah perang untuk menyerang dari garis depan.' });
    const useAmmo = ammo === 'Drone' ? 'Drone' : 'Senjata';
    // Rumus damage BARU (v5.7.0, Tugas 5): tier senjata yang dikonsumsi
    // (1–5, default 1) + energi yang dipilih penyerang (10–50, default 10)
    // + jenis senjata + Kekuatan + bonus wilayah asal (+15%). Tier dan
    // energi divalidasi server; tier yang dikonsumsi HARUS persis tier
    // yang dipilih (dulu selalu tier terendah).
    const useTier = tier === undefined || tier === null ? 1 : Number(tier);
    if (!Number.isInteger(useTier) || useTier < 1 || useTier > 5) return res.status(400).json({ error: 'Tier senjata harus 1–5.' });
    const useEnergy = energy === undefined || energy === null ? WAR_ATTACK_ENERGY_MIN : Number(energy);
    if (!Number.isInteger(useEnergy) || useEnergy < WAR_ATTACK_ENERGY_MIN || useEnergy > WAR_ATTACK_ENERGY_MAX) return res.status(400).json({ error: `Energi serangan harus ${WAR_ATTACK_ENERGY_MIN}–${WAR_ATTACK_ENERGY_MAX}.` });
    const com = await one('SELECT id FROM commodities WHERE name = ?', [useAmmo]);
    const home = c.home_region_id === war.region_id;
    const baseDamage = warDamage(c.attr_str, useAmmo, useTier, useEnergy, home);
    let damage = baseDamage;
    // Bonus konvoi (Tahap 3, BUG-7): Pos Militer aktif -> kerusakan +10%.
    const buildings = await convoyBuildings(c.id);
    if (buildings.has('military')) damage = warDamageWithBonus(damage);
    // Bonus Tahap 5: anggaran perang, mobilisasi, pakta pertahanan,
    // ideologi Nasionalisme. Dihitung SEBELUM tx (hanya baca; nilai dipakai
    // di dalam tx apa adanya).
    const country = await getMyCountry({ one }, c);
    const bonus = await warDamageBonus({ one }, c.id, country);
    const appliedBonuses = [];
    if (buildings.has('military')) appliedBonuses.push('Pos Militer +10%');
    appliedBonuses.push(...bonus.labels);
    if (home) appliedBonuses.push(`Wilayah asal +${Math.round((WAR_HOME_BONUS_MULT - 1) * 100)}%`);
    damage = Math.round(damage * bonus.mult);
    // Kekuatan militer (Tahap 6): unit yang direkrut memperkuat serangan —
    // pengali ×1,00–1,50 dari total kekuatan (maks 100). Dihitung SEBELUM
    // tx (hanya baca; nilai dipakai di dalam tx apa adanya).
    const myPower = await militaryPowerOf(c.id);
    const milMult = unitDamageMult(myPower);
    if (myPower > 0) appliedBonuses.push(`Pasukan +${Math.round((milMult - 1) * 100)}%`);
    damage = Math.round(damage * milMult);
    // Atomik: kunci baris warga, baca amunisi segar di dalam tx, potong
    // energi + amunisi + catat serangan + update skor + progres misi — semua
    // dari nilai yang dikunci (dulu misi dihitung dari objek basi di luar tx).
    await tx(async (t) => {
      const locked = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [c.id]);
      if (locked.energy < useEnergy) throw Object.assign(new Error(`Butuh ${useEnergy} energi untuk menyerang.`), { status: 400 });
      const hasAmmo = await t.one(forUpdate('SELECT * FROM inventory WHERE citizen_id = ? AND commodity_id = ? AND tier = ? AND qty > 0'), [locked.id, com.id, useTier]);
      if (!hasAmmo) throw Object.assign(new Error(`Tidak ada ${useAmmo} tier ${useTier} di inventaris.`), { status: 400 });
      const upd = await t.run('UPDATE citizens SET energy = energy - ?, energy_spent_today = energy_spent_today + ?, total_damage = total_damage + ?, attacks = attacks + 1, frontline_attacks = frontline_attacks + 1 WHERE id = ? AND energy >= ?',
        [useEnergy, useEnergy, damage, locked.id, useEnergy]);
      if (!upd.changes) throw Object.assign(new Error(`Butuh ${useEnergy} energi untuk menyerang.`), { status: 400 });
      if (hasAmmo.qty === 1) await t.run('DELETE FROM inventory WHERE id = ?', [hasAmmo.id]);
      else await t.run('UPDATE inventory SET qty = qty - 1 WHERE id = ?', [hasAmmo.id]);
      await t.run('INSERT INTO war_attacks (war_id, citizen_id, side, damage, ammo, created_at) VALUES (?,?,?,?,?,?) RETURNING id',
        [war.id, locked.id, side, damage, useAmmo, Date.now()]);
      const col = side === 'attacker' ? 'score_a' : 'score_d';
      await t.run(`UPDATE wars SET ${col} = ${col} + ? WHERE id = ?`, [damage, war.id]);
      // (Tahap 7) Progres misi 'energy' TIDAK lagi ditulis ke JSON missions —
      // tulis itu mati: GET/klaim misi membaca energy_spent_today, yang
      // sudah ditambah di UPDATE di atas. Kolom JSON-nya sudah dihapus.
    });
    await chronicleDone(c, 'attack');
    res.json({ ok: true, damage, bonuses: appliedBonuses, breakdown: { base: baseDamage, tier: useTier, tierMult: Math.round((1 + 0.15 * (useTier - 1)) * 100) / 100, energy: useEnergy, energyMult: Math.round((1 + 0.02 * (useEnergy - WAR_ATTACK_ENERGY_MIN)) * 100) / 100, ammo: useAmmo, home, homeMult: home ? WAR_HOME_BONUS_MULT : 1 }, energyUsed: useEnergy, tierUsed: useTier });
  }));

  // ---------- PERS ----------
  // Batas gambar artikel (laporan Orang_solo 2026-11-27 — artikel belum
  // bisa pakai gambar/sampul). Pola sama seperti foto profil (data URL,
  // browser me-resize dulu, server memvalidasi magic bytes):
  // - Sampul: maks 500 KB biner (sama seperti avatar), thumbnail daftar
  //   maks 50 KB — daftar 30 artikel tidak boleh mengunduh 30 × 500 KB.
  // - Gambar di isi: maks 3 per artikel, masing-masing maks 300 KB biner,
  //   disisipkan sebagai penanda [gambar:<data URL>] di dalam isi.
  // - Isi total maks 1.300.000 karakter (≈ 20.000 teks + 3 × ~410.000
  //   karakter base64 gambar) supaya database tidak membengkak.
  const ARTICLE_COVER_MAX_BYTES = 500 * 1024;
  const ARTICLE_COVER_SM_MAX_BYTES = 50 * 1024;
  const ARTICLE_IMAGE_MAX_BYTES = 300 * 1024;
  const ARTICLE_IMAGE_MAX_COUNT = 3;
  const ARTICLE_CONTENT_MAX_CHARS = 1300000;
  // Penanda gambar di isi — HANYA data URL JPEG/PNG/WebP base64 yang lolos
  // regex ini. Penanda lain (mis. [gambar:javascript:...] atau SVG) tidak
  // cocok pola dan ditolak mentah-mentah oleh validateArticleImages di
  // bawah; render client juga hanya mengganti penanda yang cocok pola ini.
  const ARTICLE_IMAGE_MARKER_RE = /\[gambar:(data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+)\]/g;
  function validateArticleImages(content) {
    const markers = [...content.matchAll(ARTICLE_IMAGE_MARKER_RE)];
    if (markers.length > ARTICLE_IMAGE_MAX_COUNT) {
      return { error: `Maksimal ${ARTICLE_IMAGE_MAX_COUNT} gambar di dalam isi artikel.` };
    }
    for (const m of markers) {
      if (!parseImageDataUrl(m[1], ARTICLE_IMAGE_MAX_BYTES)) {
        return { error: 'Gambar di dalam isi artikel harus JPEG/PNG/WebP yang valid dan maksimal 300 KB.' };
      }
    }
    const textOnly = content.replace(ARTICLE_IMAGE_MARKER_RE, '');
    if (/\[gambar:/i.test(textOnly)) {
      return { error: 'Penanda gambar tidak valid — sisipkan gambar lewat tombol "Sisipkan Gambar".' };
    }
    return { ok: true, textOnly };
  }

  app.get('/api/press/stats', authRequired, citizenRequired, r(async (req, res) => {
    const since7 = Date.now() - 7 * DAY_MS;
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
    if (sort === 'top_day') { where += ' AND a.created_at > ?'; params.push(Date.now() - DAY_MS); }
    if (sort === 'top_week') { where += ' AND a.created_at > ?'; params.push(Date.now() - 7 * DAY_MS); }
    if (sort === 'top_month') { where += ' AND a.created_at > ?'; params.push(Date.now() - 30 * DAY_MS); }
    // Daftar artikel: JANGAN kembalikan content dan cover penuh — isi bisa
    // membawa gambar base64 (sampai ~1,3 jt karakter) dan sampul sampai
    // 500 KB; 30 artikel × itu bisa belasan MB per request. Daftar hanya
    // butuh ringkasan + thumbnail sampul (cover_sm, maks 50 KB).
    const rows = await sql(
      `SELECT a.id, a.newspaper_id, a.author_id, a.title, a.topic, a.views, a.likes, a.dislikes,
        a.created_at, a.cover_sm, u.username AS author_name, n.name AS newspaper_name,
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
    // (Tahap 8) Views dihitung 1× per warga per artikel per hari (UTC):
    // dulu SETIAP buka artikel menaikkan views +1, jadi refresh berulang
    // menggembungkan views — dan skor Liga Pers memakai views, sehingga
    // peringkat bisa dimanipulasi. Sekarang baris jejak (article_views,
    // PRIMARY KEY rangkap) dicoba dimasukkan dulu; views hanya naik bila
    // barisnya baru (ON CONFLICT DO NOTHING). Artikel lama tetap membawa
    // hitungan views lamanya (tidak bisa direkonstruksi siapa membacanya).
    const today = new Date().toISOString().slice(0, 10);
    const seen = await run('INSERT INTO article_views (article_id, citizen_id, day) VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING article_id',
      [a.id, req.citizen.id, today]);
    let views = a.views;
    if (seen.changes) {
      await run('UPDATE articles SET views = views + 1 WHERE id = ?', [a.id]);
      views = a.views + 1;
    }
    const comments = await sql(
      `SELECT ac.*, u.username FROM article_comments ac JOIN citizens c ON c.id = ac.citizen_id JOIN users u ON u.id = c.user_id
       WHERE ac.article_id = ? ORDER BY ac.created_at ASC`, [a.id]);
    const myReaction = await one('SELECT reaction FROM article_reactions WHERE article_id = ? AND citizen_id = ?', [a.id, req.citizen.id]);
    const others = await sql(
      `SELECT a2.id, a2.title, a2.created_at, a2.likes, a2.views, a2.cover_sm FROM articles a2 WHERE a2.newspaper_id = ? AND a2.id != ? ORDER BY a2.created_at DESC LIMIT 5`,
      [a.newspaper_id, a.id]);
    res.json({ article: { ...a, views }, comments, myReaction: myReaction?.reaction || null, others });
  }));

  app.get('/api/press/newspapers/mine', authRequired, citizenRequired, r(async (req, res) => {
    const rows = await sql('SELECT * FROM newspapers WHERE owner_id = ? ORDER BY created_at DESC', [req.citizen.id]);
    res.json({ newspapers: rows });
  }));

  app.post('/api/press/newspaper', authRequired, citizenRequired, requireCredit(CREDIT_MIN_FOR.press, 'membuat koran'),  r(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name || name.length < 3 || name.length > 50) return res.status(400).json({ error: 'Nama koran 3–50 karakter.' });
    // Atomik: kunci baris warga + potong 5 emas bersyarat di dalam tx.
    // Penjaga duplikat (laporan pemain Vincent — ketuk 2× saat lag jadi 2
    // koran): pemilik yang sama tidak boleh punya 2 koran bernama sama
    // (perbandingan tak peka huruf besar/kecil). Dicek DI DALAM tx setelah
    // kunci baris warga, jadi dua request bersamaan pun hanya satu yang
    // lolos — yang kedua melihat koran pertama dan ditolak 400. Pemilik
    // BOLEH punya beberapa koran dengan nama berbeda (tulis artikel memakai
    // <select> koran), jadi yang dicegah hanya nama yang sama.
    const newspaperId = await tx(async (t) => {
      await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [req.citizen.id]);
      const dup = await t.one('SELECT id FROM newspapers WHERE owner_id = ? AND LOWER(name) = LOWER(?)', [req.citizen.id, name]);
      if (dup) throw Object.assign(new Error('Kamu sudah punya koran bernama itu.'), { status: 400 });
      const n = await t.run('INSERT INTO newspapers (owner_id, name, created_at) VALUES (?,?,?) RETURNING id', [req.citizen.id, name, Date.now()]);
      const upd = await t.run('UPDATE citizens SET gold = gold - 5 WHERE id = ? AND gold >= 5', [req.citizen.id]);
      if (!upd.changes) throw Object.assign(new Error('Mendirikan koran butuh 5 emas.'), { status: 400 });
      return n.id;
    });
    res.json({ ok: true, newspaperId });
  }));

  // Bubarkan koran sendiri (untuk koran ganda akibat bug double-submit —
  // mis. Vincent). Atomik: koran + seluruh artikel + reaksi/komentarnya
  // dihapus sekaligus. Hanya pemilik yang boleh membubarkan.
  app.delete('/api/press/newspapers/:id', authRequired, citizenRequired, r(async (req, res) => {
    await tx(async (t) => {
      const np = await t.one(forUpdate('SELECT * FROM newspapers WHERE id = ? AND owner_id = ?'), [req.params.id, req.citizen.id]);
      if (!np) throw Object.assign(new Error('Koran tidak ditemukan atau bukan milikmu.'), { status: 404 });
      await t.run('DELETE FROM article_reactions WHERE article_id IN (SELECT id FROM articles WHERE newspaper_id = ?)', [np.id]);
      await t.run('DELETE FROM article_comments WHERE article_id IN (SELECT id FROM articles WHERE newspaper_id = ?)', [np.id]);
      await t.run('DELETE FROM articles WHERE newspaper_id = ?', [np.id]);
      await t.run('DELETE FROM newspapers WHERE id = ?', [np.id]);
    });
    res.json({ ok: true });
  }));

  app.post('/api/press/articles', authRequired, citizenRequired, requireCredit(CREDIT_MIN_FOR.press, 'menerbitkan artikel'),  r(async (req, res) => {
    const { newspaper_id, title, content, topic, cover, cover_sm } = req.body || {};
    const np = await one('SELECT * FROM newspapers WHERE id = ? AND owner_id = ?', [newspaper_id, req.citizen.id]);
    if (!np) return res.status(403).json({ error: 'Kamu hanya bisa menulis di koranmu sendiri.' });
    if (!title || title.length < 5 || title.length > 120) return res.status(400).json({ error: 'Judul 5–120 karakter.' });
    if (typeof content !== 'string' || content.length > ARTICLE_CONTENT_MAX_CHARS) return res.status(400).json({ error: 'Isi artikel terlalu panjang.' });
    const imgCheck = validateArticleImages(content);
    if (imgCheck.error) return res.status(400).json({ error: imgCheck.error });
    if (!imgCheck.textOnly || imgCheck.textOnly.trim().length < 20) return res.status(400).json({ error: 'Isi artikel minimal 20 karakter.' });
    // Sampul opsional: bila dikirim harus gambar valid (JPEG/PNG/WebP) dan
    // dalam batas — sampul penuh maks 500 KB, thumbnail maks 50 KB.
    let coverUrl = null;
    let coverSmUrl = null;
    if (cover !== undefined && cover !== null && cover !== '') {
      const parsed = parseImageDataUrl(cover, ARTICLE_COVER_MAX_BYTES);
      if (!parsed) return res.status(400).json({ error: 'Sampul harus gambar JPEG/PNG/WebP yang valid dan ukurannya maksimal 500 KB.' });
      coverUrl = parsed.dataUrl;
    }
    if (cover_sm !== undefined && cover_sm !== null && cover_sm !== '') {
      const parsedSm = parseImageDataUrl(cover_sm, ARTICLE_COVER_SM_MAX_BYTES);
      if (!parsedSm) return res.status(400).json({ error: 'Thumbnail sampul harus gambar JPEG/PNG/WebP yang valid dan ukurannya maksimal 50 KB.' });
      coverSmUrl = parsedSm.dataUrl;
    }
    const topics = ['Perang', 'Ekonomi', 'Politik', 'Diplomasi', 'Panduan', 'Pengumuman'];
    const a = await run(
      'INSERT INTO articles (newspaper_id, author_id, title, content, cover, cover_sm, topic, created_at) VALUES (?,?,?,?,?,?,?,?) RETURNING id',
      [np.id, req.citizen.id, title, content, coverUrl, coverSmUrl, topics.includes(topic) ? topic : 'Pengumuman', Date.now()]);
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
    const since = Date.now() - 7 * DAY_MS;
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
  // Ruang 'negara' DIHAPUS (redesain dunia — tidak ada lagi satu negara):
  // diganti ruang WILAYAH (region_<id>) — tiap wilayah punya obrolan
  // sendiri, hanya warga wilayah itu yang bisa membaca + menulis.
  function roomTitle(room) {
    if (room === 'global') return 'OBROLAN GLOBAL';
    if (room === 'indonesia') return 'OBROLAN INDONESIA';
    if (room.startsWith('region_')) return 'OBROLAN WILAYAH';
    if (room === 'parliament') return 'RUANG SIDANG';
    if (room.startsWith('war_')) return 'PERTEMPURAN';
    if (room.startsWith('party_')) return 'OBROLAN PARTAI';
    return 'OBROLAN';
  }
  // Validasi ruang: global/indonesia bebas; region_<id> hanya wilayah
  // sendiri; parliament hanya bila parlemen sudah dibuka; war_<id> harus
  // perang yang ada; party_<id> hanya partai sendiri. Ruang lain → 404.
  async function validateRoom(room, citizen) {
    if (room === 'global' || room === 'indonesia') return null;
    if (room.startsWith('region_')) {
      const id = Number(room.slice(7));
      if (!Number.isInteger(id) || id !== citizen.region_id) return 'Kamu hanya bisa masuk obrolan wilayahmu sendiri.';
      const reg = await one('SELECT id FROM regions WHERE id = ?', [id]);
      if (!reg) return 'Wilayah tidak ditemukan.';
      return null;
    }
    if (room === 'parliament') {
      const par = await parliamentStatus();
      if (!par.open) return parliamentLockedError(par.opensAt);
      return null;
    }
    if (room.startsWith('war_')) {
      const war = await one('SELECT id FROM wars WHERE id = ?', [room.slice(4)]);
      if (!war) return 'Front perang tidak ditemukan.';
      return null;
    }
    if (room.startsWith('party_')) {
      if (citizen.party_id !== Number(room.slice(6))) return 'Kamu bukan anggota partai ini.';
      return null;
    }
    return 'Ruang tidak dikenal.';
  }

  // Daftar pemain yang diblokir (tiket #14 Vincent, v3.1.0): menu di
  // Pengaturan menampilkan semua yang diblokir + tombol buka blokir.
  // HARUS terdaftar SEBELUM GET /api/chat/:room di bawah — Express
  // mencocokkan rute berurutan, dan ':room' akan menelan 'blocked'
  // sebagai nama ruang (→ 404 "Ruang tidak dikenal").
  app.get('/api/chat/blocked', authRequired, citizenRequired, r(async (req, res) => {
    const rows = await sql(
      `SELECT b.blocked_id AS citizen_id, u.username, u.avatar FROM blocked b
       JOIN citizens c ON c.id = b.blocked_id JOIN users u ON u.id = c.user_id
       WHERE b.blocker_id = ? ORDER BY u.username`,
      [req.citizen.id]);
    res.json({ blocked: rows });
  }));

  // Lencana pesan belum dibaca di tab chat (v5.4.0, ala Parlementum):
  // jumlah pesan di tiap ruangan tab (global / indonesia / wilayah sendiri)
  // yang lebih baru dari terakhir dibaca warga — tanpa pesan sendiri dan
  // tanpa pesan dari warga yang diblokir (sama seperti filter daftar chat).
  // Tanpa baris chat_read = belum pernah dibaca → semua pesan dihitung.
  // HARUS terdaftar SEBELUM GET /api/chat/:room (alasan sama seperti
  // /api/chat/blocked di atas).
  app.get('/api/chat/unread', authRequired, citizenRequired, r(async (req, res) => {
    const rooms = [
      ['global', 'global'],
      ['indonesia', 'indonesia'],
      ['region_' + req.citizen.region_id, 'wilayah'],
    ];
    const reads = await sql('SELECT room, last_read_at FROM chat_read WHERE citizen_id = ?', [req.citizen.id]);
    const lastRead = Object.fromEntries(reads.map((x) => [x.room, Number(x.last_read_at) || 0]));
    const unread = {};
    for (const [room, key] of rooms) {
      const row = await one(
        `SELECT COUNT(*) AS n FROM chat_messages m WHERE m.room = ? AND m.created_at > ? AND m.citizen_id <> ?
         AND m.citizen_id NOT IN (SELECT blocked_id FROM blocked WHERE blocker_id = ?)`,
        [room, lastRead[room] || 0, req.citizen.id, req.citizen.id]);
      unread[key] = Number(row?.n || 0);
    }
    res.json({ unread });
  }));

  // Tandai ruangan sudah dibaca (v5.4.0): dipanggil client saat membuka
  // ruangan / saat pesan baru terlihat di bawah. Hanya tiga ruangan tab —
  // ruangan sidang/perang bukan tab dan tidak punya lencana.
  app.post('/api/chat/read', authRequired, citizenRequired, r(async (req, res) => {
    const room = String(req.body?.room || '');
    const allowed = ['global', 'indonesia', 'region_' + req.citizen.region_id];
    if (!allowed.includes(room)) return res.status(400).json({ error: 'Ruangan tidak dikenal.' });
    const now = Date.now();
    await run(`INSERT INTO chat_read (citizen_id, room, last_read_at) VALUES (?,?,?)
      ON CONFLICT (citizen_id, room) DO UPDATE SET last_read_at = excluded.last_read_at`,
      [req.citizen.id, room, now]);
    res.json({ ok: true, room, last_read_at: now });
  }));

  app.get('/api/chat/:room', authRequired, citizenRequired, r(async (req, res) => {
    const room = req.params.room;
    const roomErr = await validateRoom(room, req.citizen);
    if (roomErr) return res.status(404).json({ error: roomErr });
    const since = Number(req.query.since || 0);
    // BUG-11 (Tahap 3): pesan dari warga yang diblokir disaring DI SQL,
    // bukan di JS setelah LIMIT 100 — sebelumnya daftar 100 pesan bisa
    // terisi pesan terblokir dan pesan valid terpotong. Satu query, satu
    // parameter tambahan (id warga peminta).
    // §6.3: avatar yang dikirim adalah avatar_sm (48×48, ≤ 25 KB), bukan
    // avatar penuh — satu polling chat 100 pesan tidak lagi mengunduh
    // ~13 MB. Field respons tetap 'avatar'; frontend tidak berubah.
    // Perbaikan 4 (laporan Khalid): muat awal (since=0) HARUS mengembalikan
    // 100 pesan TERBARU. Sebelumnya ORDER BY created_at ASC LIMIT 100
    // mengembalikan 100 pesan TERTUA ruangan — pemain selalu melihat chat
    // lama, lalu polling menumpuk batch lama berikutnya (chatSince naik
    // perlahan dari pesan tertua), jadi chat terasa "stuck" di pesan lama.
    // Polling (since>0) tetap mengambil pesan yang benar-benar baru.
    const cols = `SELECT m.*, u.username, u.avatar_sm AS avatar, u.premium_until, p.tag AS party_tag,
        (SELECT COUNT(*) FROM article_comments WHERE article_id = m.article_id) AS article_comments,
        (SELECT title FROM articles WHERE id = m.article_id) AS article_title,
        (SELECT likes FROM articles WHERE id = m.article_id) AS article_likes,
        (SELECT np.name FROM articles a JOIN newspapers np ON np.id = a.newspaper_id WHERE a.id = m.article_id) AS article_source,
        (SELECT name FROM parties WHERE id = m.party_id) AS party_name,
        (SELECT tag FROM parties WHERE id = m.party_id) AS party_tag_shared,
        (SELECT type FROM parties WHERE id = m.party_id) AS party_type,
        (SELECT COUNT(*) FROM party_members WHERE party_id = m.party_id AND role != 'pending') AS party_members
       FROM chat_messages m JOIN citizens c ON c.id = m.citizen_id JOIN users u ON u.id = c.user_id
       LEFT JOIN parties p ON p.id = c.party_id`;
    const blocked = `AND m.citizen_id NOT IN (SELECT blocked_id FROM blocked WHERE blocker_id = ?)`;
    let rows;
    if (since > 0) {
      rows = await sql(
        `${cols} WHERE m.room = ? AND m.created_at > ? ${blocked}
         ORDER BY m.created_at ASC LIMIT 100`,
        [room, since, req.citizen.id]);
    } else {
      rows = await sql(
        `${cols} WHERE m.room = ? ${blocked}
         ORDER BY m.created_at DESC LIMIT 100`,
        [room, req.citizen.id]);
      rows.reverse(); // tampil tetap kronologis (lama → baru)
    }
    res.json({ room, title: roomTitle(room), messages: rows.map((m) => ({ ...m, isPremium: m.premium_until > Date.now() })) });
  }));

  app.post('/api/chat/report', authRequired, citizenRequired, r(async (req, res) => {
    const { message_id, reason, details } = req.body || {};
    if (!['Pelecehan', 'Ujaran kebencian', 'Spam', 'Lainnya'].includes(reason)) return res.status(400).json({ error: 'Alasan laporan tidak dikenal.' });
    const msg = await one(
      `SELECT cm.id, cm.citizen_id, u.is_admin FROM chat_messages cm
       JOIN citizens c ON c.id = cm.citizen_id JOIN users u ON u.id = c.user_id WHERE cm.id = ?`,
      [message_id]);
    if (!msg) return res.status(404).json({ error: 'Pesan tidak ditemukan.' });
    // Kredit skor (v3.0.0): laporan terhadap diri sendiri dan terhadap
    // admin DITOLAK — skor admin tidak pernah turun, dan pemain tidak bisa
    // menjatuhkan skornya sendiri.
    if (msg.citizen_id === req.citizen.id) return res.status(400).json({ error: 'Tidak bisa melaporkan pesan sendiri.' });
    if (msg.is_admin) return res.status(400).json({ error: 'Tidak bisa melaporkan admin.' });
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

  app.post('/api/chat/:room', authRequired, citizenRequired, requireCredit(CREDIT_MIN_FOR.chat, 'mengirim pesan chat'),  r(async (req, res) => {
    const room = req.params.room;
    const roomErr = await validateRoom(room, req.citizen);
    if (roomErr) return res.status(404).json({ error: roomErr });
    const { content, article_id, party_id } = req.body || {};
    const text = (content || '').trim();
    if (!text || text.length > 500) return res.status(400).json({ error: 'Pesan 1–500 karakter.' });
    const c = req.citizen;
    // Ruang sidang: hanya anggota parlemen / menteri / presiden NEGARANYA.
    if (room === 'parliament') {
      const country = await getMyCountry({ one }, c);
      const isOfficial = await isMpCitizen(c)
        || (country && [country.president_id, country.minister_economy, country.minister_foreign, country.minister_home, country.minister_defense].includes(c.id));
      if (!isOfficial) return res.status(403).json({ error: 'Ruang Sidang hanya untuk anggota parlemen, menteri, dan presiden.' });
    }
    // Anti-spam atomik: kunci baris warga, cek jeda 5 detik dari nilai segar,
    // lalu simpan pesan + update last_chat_at di dalam tx yang sama.
    const { msgId, counted } = await tx(async (t) => {
      // v5.0.1: validasi artikel DULU sebelum cooldown — artikel yang
      // tidak ada adalah request yang salah apa pun jedanya; pemain harus
      // mendapat "Artikel tidak ditemukan.", bukan "Tunggu sebentar...".
      let articleId = null;
      if (article_id) {
        const a = await t.one('SELECT id FROM articles WHERE id = ?', [article_id]);
        // v5.0.1 (laporan Vincent): article_id yang tidak ketemu JANGAN
        // diam-diam dibuang jadi null — pesan terkirim tanpa pratinjau dan
        // pemain mengira bagikannya gagal. Gagalkan dengan 400 yang jelas.
        if (!a) throw Object.assign(new Error('Artikel tidak ditemukan.'), { status: 400 });
        articleId = a.id;
      }
      // v5.7.1 (Clueless): kartu ajakan partai di obrolan — pola yang sama
      // seperti article_id: party_id yang tidak ada digagalkan 400, bukan
      // diam-diam dibuang (pesan tanpa kartu = ajakan kosong seperti yang
      // membingungkan RudraSyailendra).
      let partyId = null;
      if (party_id) {
        const p = await t.one('SELECT id FROM parties WHERE id = ?', [party_id]);
        if (!p) throw Object.assign(new Error('Partai tidak ditemukan.'), { status: 400 });
        partyId = p.id;
      }
      const locked = await t.one(forUpdate('SELECT * FROM citizens WHERE id = ?'), [c.id]);
      if (Date.now() - (locked.last_chat_at || 0) < CHAT_COOLDOWN_MS) throw Object.assign(new Error('Tunggu sebentar sebelum mengirim pesan lagi.'), { status: 400 });
      const msg = await t.run('INSERT INTO chat_messages (room, citizen_id, content, article_id, party_id, created_at) VALUES (?,?,?,?,?,?) RETURNING id',
        [room, c.id, text, articleId, partyId, Date.now()]);
      await t.run('UPDATE citizens SET last_chat_at = ?, chat_today = chat_today + 1 WHERE id = ?', [Date.now(), c.id]);
      // Misi harian: minimal 3 kata, jeda 30 detik sejak pesan terakhir yang dihitung.
      // (Tahap 7) Progres + penanda waktu terakhir dihitung kini baris di
      // mission_progress ('chat' / 'last_chat_counted') — bukan lagi kunci
      // di JSON missions; dua pesan paralel tidak bisa saling menimpa.
      const words = text.split(/\s+/).filter(Boolean).length;
      const lastCounted = await missionValue(t, c.id, 'last_chat_counted');
      let counted = false;
      if (words >= CHAT_COUNT_MIN_WORDS && Date.now() - lastCounted >= CHAT_COUNT_WINDOW_MS) {
        const chat = await missionValue(t, c.id, 'chat');
        await setMissionValue(t, c.id, 'chat', Math.min(5, chat + 1));
        await setMissionValue(t, c.id, 'last_chat_counted', Date.now());
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
      `SELECT d.*, u.username AS from_name, u.avatar_sm AS from_avatar FROM dms d JOIN citizens c ON c.id = d.from_id JOIN users u ON u.id = c.user_id
       WHERE (d.from_id = ? AND d.to_id = ?) OR (d.from_id = ? AND d.to_id = ?) ORDER BY d.created_at ASC LIMIT 100`,
      [req.citizen.id, other, other, req.citizen.id]);
    await run('UPDATE dms SET is_read = 1 WHERE from_id = ? AND to_id = ?', [other, req.citizen.id]);
    res.json({ messages: rows });
  }));

  app.post('/api/dms/:citizenId', authRequired, citizenRequired, requireCredit(CREDIT_MIN_FOR.chat, 'mengirim DM'),  r(async (req, res) => {
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
    // Pakta (Tahap 5): semua pakta aktif (publik) + pakta pending yang
    // melibatkan organisasiku (agar ketuaku bisa menyetujui/menolak).
    const myOrgId = mine?.org_id || -1;
    const pacts = await sql(
      `SELECT p.*, oa.name AS org_a_name, ob.name AS org_b_name, oa.leader_id AS org_a_leader_id, ob.leader_id AS org_b_leader_id
       FROM org_pacts p JOIN organizations oa ON oa.id = p.org_a_id JOIN organizations ob ON ob.id = p.org_b_id
       WHERE p.status = 'active' OR p.org_a_id = ? OR p.org_b_id = ? ORDER BY p.created_at DESC`,
      [myOrgId, myOrgId]);
    const country = await getMyCountry({ one }, req.citizen);
    res.json({ organizations: rows, myOrgId: mine?.org_id || null, pacts, myMinisterRole: ministerRole(country, req.citizen.id) });
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

  // ---------- PAKTA ANTAR ORGANISASI ---------- (Tahap 5 — diplomasi)
  // Dua organisasi mengikat pakta (dagang: pajak antar anggota dipotong
  // 50%; pertahanan: anggota +10% kerusakan perang). Pasangan disimpan
  // terurut (org_a_id < org_b_id) agar UNIQUE(org_a_id, org_b_id, kind)
  // bekerja dua arah. Mengusulkan: ketua organisasi pengusul ATAU Menteri
  // Luar Negeri (sebagai mediator). Menyetujui: ketua organisasi satunya
  // (bila pengusul adalah ketua salah satu organisasi); bila pengusulnya
  // Menteri Luar Negeri, ketua salah satu organisasi boleh menyetujui.
  async function pactOrgs(pact) {
    const [a, b] = await Promise.all([
      one('SELECT * FROM organizations WHERE id = ?', [pact.org_a_id]),
      one('SELECT * FROM organizations WHERE id = ?', [pact.org_b_id]),
    ]);
    return [a, b];
  }
  // Ketua organisasi mana (a/b) yang diwakili pemanggil, atau null.
  function pactMyOrg(a, b, citizenId) {
    if (a.leader_id === citizenId) return a.id;
    if (b.leader_id === citizenId) return b.id;
    return null;
  }
  // Organisasi mana (a/b) yang diwakili pengusul pakta, atau null bila
  // pengusul bukan ketua salah satu organisasi (mis. Menteri Luar Negeri).
  function pactProposerOrg(a, b, proposerId) {
    if (a.leader_id === proposerId) return a.id;
    if (b.leader_id === proposerId) return b.id;
    return null;
  }

  app.post('/api/orgs/:id/pact', authRequired, citizenRequired, r(async (req, res) => {
    const { target_org_id, kind } = req.body || {};
    if (!PACT_KINDS[kind]) return res.status(400).json({ error: 'Jenis pakta tidak dikenal.' });
    const o = await one('SELECT * FROM organizations WHERE id = ?', [req.params.id]);
    if (!o) return res.status(404).json({ error: 'Organisasi tidak ditemukan.' });
    const target = await one('SELECT * FROM organizations WHERE id = ?', [target_org_id]);
    if (!target) return res.status(404).json({ error: 'Organisasi tujuan tidak ditemukan.' });
    if (o.id === target.id) return res.status(400).json({ error: 'Tidak bisa berpakta dengan organisasi sendiri.' });
    const country = await getMyCountry({ one }, req.citizen);
    const isLeader = o.leader_id === req.citizen.id;
    const isForeignMinister = ministerRole(country, req.citizen.id) === 'foreign';
    if (!isLeader && !isForeignMinister) return res.status(403).json({ error: 'Hanya ketua organisasi atau Menteri Luar Negeri yang bisa mengusulkan pakta.' });
    const lo = Math.min(o.id, target.id), hi = Math.max(o.id, target.id);
    const existing = await one("SELECT id, status FROM org_pacts WHERE org_a_id = ? AND org_b_id = ? AND kind = ? AND status IN ('pending','active')", [lo, hi, kind]);
    if (existing) return res.status(400).json({ error: existing.status === 'active' ? 'Pakta sejenis sudah aktif antara kedua organisasi ini.' : 'Usulan pakta sejenis masih menunggu persetujuan.' });
    const pact = await tx(async (t) => {
      // ON CONFLICT DO NOTHING: dua usulan paralel untuk pasangan+jenis
      // yang sama — yang kalah dapat 400, bukan 500 (pola vote UU).
      // (Tolak/bubarkan menghapus baris, jadi UNIQUE tidak pernah
      // menghalangi usulan baru setelah pakta dibubarkan.)
      const ins = await t.run('INSERT INTO org_pacts (org_a_id, org_b_id, kind, status, proposer_id, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id',
        [lo, hi, kind, 'pending', req.citizen.id, Date.now()]);
      if (!ins.changes) throw Object.assign(new Error('Pakta sejenis baru saja diusulkan antara kedua organisasi ini.'), { status: 400 });
      return ins;
    });
    await notify(target.leader_id, 'DIPLOMASI', 'Usulan pakta baru', `${o.name} mengusulkan ${PACT_KINDS[kind].label} dengan ${target.name}. Setujui atau tolak di halaman Organisasi.`);
    res.json({ ok: true, pactId: pact.id });
  }));

  app.post('/api/orgs/pacts/:id/accept', authRequired, citizenRequired, r(async (req, res) => {
    const pact = await one("SELECT * FROM org_pacts WHERE id = ? AND status = 'pending'", [req.params.id]);
    if (!pact) return res.status(404).json({ error: 'Usulan pakta tidak ditemukan.' });
    const [a, b] = await pactOrgs(pact);
    const myOrg = pactMyOrg(a, b, req.citizen.id);
    if (!myOrg) return res.status(403).json({ error: 'Hanya ketua salah satu organisasi yang bisa menerima pakta.' });
    const proposerOrg = pactProposerOrg(a, b, pact.proposer_id);
    if (proposerOrg && proposerOrg === myOrg) return res.status(400).json({ error: 'Kamu yang mengusulkan — ketua organisasi satunya yang harus menyetujui.' });
    await run("UPDATE org_pacts SET status = 'active' WHERE id = ?", [pact.id]);
    const otherLeader = myOrg === a.id ? b.leader_id : a.leader_id;
    await notify(otherLeader, 'DIPLOMASI', 'Pakta disetujui', `${PACT_KINDS[pact.kind].label} antara ${a.name} dan ${b.name} kini aktif.`);
    res.json({ ok: true });
  }));

  app.post('/api/orgs/pacts/:id/reject', authRequired, citizenRequired, r(async (req, res) => {
    const pact = await one("SELECT * FROM org_pacts WHERE id = ? AND status = 'pending'", [req.params.id]);
    if (!pact) return res.status(404).json({ error: 'Usulan pakta tidak ditemukan.' });
    const [a, b] = await pactOrgs(pact);
    const myOrg = pactMyOrg(a, b, req.citizen.id);
    if (!myOrg) return res.status(403).json({ error: 'Hanya ketua salah satu organisasi yang bisa menolak pakta.' });
    const proposerOrg = pactProposerOrg(a, b, pact.proposer_id);
    if (proposerOrg && proposerOrg === myOrg) return res.status(400).json({ error: 'Kamu yang mengusulkan — ketua organisasi satunya yang memutuskan.' });
    await run('DELETE FROM org_pacts WHERE id = ?', [pact.id]);
    await notify(pact.proposer_id, 'DIPLOMASI', 'Usulan pakta ditolak', `Usulan ${PACT_KINDS[pact.kind].label} antara ${a.name} dan ${b.name} ditolak.`);
    res.json({ ok: true });
  }));

  app.post('/api/orgs/pacts/:id/dissolve', authRequired, citizenRequired, r(async (req, res) => {
    const pact = await one("SELECT * FROM org_pacts WHERE id = ? AND status = 'active'", [req.params.id]);
    if (!pact) return res.status(404).json({ error: 'Pakta aktif tidak ditemukan.' });
    const [a, b] = await pactOrgs(pact);
    if (a.leader_id !== req.citizen.id && b.leader_id !== req.citizen.id) return res.status(403).json({ error: 'Hanya ketua salah satu organisasi yang bisa membubarkan pakta.' });
    await run('DELETE FROM org_pacts WHERE id = ?', [pact.id]);
    const otherLeader = a.leader_id === req.citizen.id ? b.leader_id : a.leader_id;
    await notify(otherLeader, 'DIPLOMASI', 'Pakta dibubarkan', `${PACT_KINDS[pact.kind].label} antara ${a.name} dan ${b.name} telah dibubarkan.`);
    res.json({ ok: true });
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
