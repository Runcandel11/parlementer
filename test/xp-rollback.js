// Parlementer — tes rollback inflasi XP (insiden 28 Nov 2026, v4.3.4).
// AKAR MASALAH: migrateXpScale (UPDATE citizens SET xp = xp * 20) dipanggil
// tanpa penjaga di rantai migrasi — ikut jalan di SETIAP kenaikan
// SCHEMA_VERSION (skema 14, 15, 16, 17), total ×20^4 = ×160.000.
// ATURAN AKHIR (perintah pemilik 28 Nov 2026 08:41 WIB): pemain yang
// terkena inflasi TIDAK dikembalikan ke level awal — mereka berakhir di
// Level 10 (lantai), kecuali level legit-nya sudah >= 10. XP akhir = XP
// legit hasil inverse (÷8000 + notifikasi "Naik Level!"). Pemain yang
// TIDAK terinflasi TIDAK disentuh dan TIDAK dinaikkan ke 10.
// Memverifikasi (pg-mem):
//   [1] rollback membawa pemain terinflasi ke Level 10 (lantai) dengan XP
//       legit (kasus eksak Vrix + kasus kaskade Dieckmann + residu XP legit);
//   [2] pemain legit >= 10 yang terinflasi tetap di level legit-nya;
//   [3] warga yang TIDAK terinflasi (legit / pemain baru / veteran level
//       tinggi) TIDAK berubah;
//   [4] payout referral TIDAK dibatalkan — hanya dihitung berapa yang
//       terpicu oleh inflasi;
//   [5] klaim achievement level <= 10 dipertahankan, level > 10 yang
//       diklaim palsu dikembalikan;
//   [6] idempotensi: rollback kedua kali = no-op (penanda db_meta).
// CATATAN: dua kenaikan SCHEMA_VERSION berurutan TIDAK BISA diuji di
// pg-mem (emulator gagal pada CREATE TABLE kedua — lihat test/pg-test.js
// batasan #3). Regresi "bump versi tidak mengalikan XP" diuji di
// Postgres sungguhan: test/pg-verify.mjs §18.
// Jalankan: npm run test:xp-rollback
process.env.PG_MEM_TEST = '1';
process.env.JWT_SECRET = 'xp-rollback-test-secret';

const { initDb, one, run, tx, migrateXpRollback } = await import('../src/db.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// Simulasi loop level-up addXp (threshold level*100) — dipakai membangun
// state pasca-kaskade yang konsisten dengan model inflasi.
function simulateLevelUp(level, xp) {
  let l = level, x = xp;
  const gained = [];
  while (x >= l * 100) { x -= l * 100; l += 1; gained.push(l); }
  return { level: l, xp: x, gained };
}

const T0 = Date.parse('2026-11-28T01:00:00Z'); // 08:00 WIB 28 Nov 2026 — pagi kaskade
const BEFORE_WINDOW = Date.parse('2026-11-26T01:00:00Z'); // level-up legit sebelum inflasi
const DAY_MS = 86400000;

async function makeCitizen(username, { level, xp, gold = 50, recruits = 0, referredBy = null, premiumUntil = 0, frontlineAttacks = 0 }) {
  const u = await run(
    'INSERT INTO users (email, username, pass_hash, referred_by, premium_until, created_at) VALUES (?,?,?,?,?,?) RETURNING id',
    [`${username}@test.local`, username, 'hash', referredBy, premiumUntil, T0]);
  const c = await run(
    'INSERT INTO citizens (user_id, level, xp, energy, gold, usd, region_id, home_region_id, recruits, frontline_attacks, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id',
    [u.id, level, xp, 100, gold, 500, 1, 1, recruits, frontlineAttacks, T0]);
  return { userId: u.id, citizenId: c.id };
}
async function notifyLevelUp(citizenId, level, at) {
  await run(
    'INSERT INTO notifications (citizen_id, category, title, content, created_at) VALUES (?,?,?,?,?)',
    [citizenId, 'SISTEM', 'Naik Level!', `Selamat! Kamu mencapai Level ${level}.`, at]);
}
async function citizenState(id) {
  return one('SELECT level, xp, gold, recruits FROM citizens WHERE id = ?', [id]);
}

console.log('[xp-rollback] Inisialisasi skema (pg-mem)...');
await initDb();

console.log('\n[1] Membangun skenario insiden');
// Vrix: level 3, XP 1.760.000 (= 11 × 160.000 persis), belum sempat kaskade.
const vrix = await makeCitizen('vrix', { level: 3, xp: 1760000 });
// Dieckmann: level 3, XP 11 sebelum rescale (intended 220) -> terinflasi
// -> klaim +40 -> kaskade. State pasca-kaskade dihitung dari loop addXp.
const dieckCascade = simulateLevelUp(3, 220 * 8000 + 40);
const dieck = await makeCitizen('dieckmann', { level: dieckCascade.level, xp: dieckCascade.xp });
for (const lv of dieckCascade.gained) await notifyLevelUp(dieck.citizenId, lv, T0);
// Warga legit: level 5, XP 250, level-up legit SEBELUM jendela inflasi.
const legit = await makeCitizen('warga_legit', { level: 5, xp: 250 });
await notifyLevelUp(legit.citizenId, 5, BEFORE_WINDOW);
// Pemain baru pasca-inflasi: level 2, XP 150, naik level 2 DI jendela (legit).
const baru = await makeCitizen('pemain_baru', { level: 2, xp: 150 });
await notifyLevelUp(baru.citizenId, 2, T0);
// Residu: terinflasi + 500 XP legit pasca-inflasi, belum kaskade.
// (3, 220) + 500 -> naik 3->4 (300) -> 4->5 (400) -> (5, 20).
const residu = await makeCitizen('warga_residu', { level: 3, xp: 220 * 8000 + 500 });
// Veteran level tinggi yang SAH: level 100, XP 9900 (valid, < 10000),
// tanpa notifikasi di jendela inflasi — TIDAK boleh tersentuh walau
// XP-nya >= 8000 (pembagi rollback tidak boleh memangkas XP legit).
const veteran = await makeCitizen('veteran', { level: 100, xp: 9900 });

// Referral PALSU: pendaftar level 2 XP 1 sebelum rescale (intended 20) ->
// terinflasi 160.000 -> klaim +40 -> kaskade. Level benar 2 (< 3).
const nowMs = Date.now();
const refFalse = await makeCitizen('pengundang_palsu', { level: 5, xp: 100, gold: 500, premiumUntil: nowMs + 2 * DAY_MS - 3600000 });
const newFalseCascade = simulateLevelUp(2, 20 * 8000 + 40);
const newFalse = await makeCitizen('pendaftar_palsu', { level: newFalseCascade.level, xp: newFalseCascade.xp, gold: 300, premiumUntil: nowMs + 1 * DAY_MS - 3600000, referredBy: refFalse.userId });
for (const lv of newFalseCascade.gained) await notifyLevelUp(newFalse.citizenId, lv, T0);
await run(
  "INSERT INTO referral_pending (referrer_id, newcomer_id, status, created_at, paid_at, paid_day) VALUES (?,?,?,?,?,?)",
  [refFalse.userId, newFalse.userId, 'paid', T0, T0, '2026-11-28']);
const refFalsePremBefore = (await one('SELECT premium_until FROM users WHERE id = ?', [refFalse.userId])).premium_until;
const newFalsePremBefore = (await one('SELECT premium_until FROM users WHERE id = ?', [newFalse.userId])).premium_until;

// Referral LEGIT: pendaftar benar-benar level 4, payout dipertahankan.
const refLegit = await makeCitizen('pengundang_legit', { level: 5, xp: 100, gold: 500 });
const newLegit = await makeCitizen('pendaftar_legit', { level: 4, xp: 100, gold: 300, referredBy: refLegit.userId });
await run(
  "INSERT INTO referral_pending (referrer_id, newcomer_id, status, created_at, paid_at, paid_day) VALUES (?,?,?,?,?,?)",
  [refLegit.userId, newLegit.userId, 'paid', T0, T0, '2026-11-28']);

// Referral terpicu inflasi juga (pengundang emasnya tinggal 100 — dulu
// ini kasus "tak-bisa-dikembalikan"; kini payout TIDAK dibatalkan, jadi
// kasus ini sama saja: hanya dihitung sebagai terpicu inflasi).
const refPoor = await makeCitizen('pengundang_miskin', { level: 5, xp: 100, gold: 100 });
const newPoorCascade = simulateLevelUp(2, 20 * 8000 + 40);
const newPoor = await makeCitizen('pendaftar_miskin', { level: newPoorCascade.level, xp: newPoorCascade.xp, gold: 300, referredBy: refPoor.userId });
for (const lv of newPoorCascade.gained) await notifyLevelUp(newPoor.citizenId, lv, T0);
await run(
  "INSERT INTO referral_pending (referrer_id, newcomer_id, status, created_at, paid_at, paid_day) VALUES (?,?,?,?,?,?)",
  [refPoor.userId, newPoor.userId, 'paid', T0, T0, '2026-11-28']);

// Rekrutan PALSU: C mengklaim 1 rekrutan; rekrutan D capai Level 5 lewat
// kaskade (level benar 2). E punya 1 rekrutan LEGIT (F benar-benar level 6).
const cRecruit = await makeCitizen('perekrut_palsu', { level: 5, xp: 100, gold: 100, recruits: 1 });
const dCascade = simulateLevelUp(2, 20 * 8000 + 40);
const dRecruit = await makeCitizen('rekrutan_palsu', { level: dCascade.level, xp: dCascade.xp, referredBy: cRecruit.userId });
for (const lv of dCascade.gained) await notifyLevelUp(dRecruit.citizenId, lv, T0);
const eRecruit = await makeCitizen('perekrut_legit', { level: 5, xp: 100, recruits: 1 });
const fRecruit = await makeCitizen('rekrutan_legit', { level: 6, xp: 100, referredBy: eRecruit.userId });
await notifyLevelUp(fRecruit.citizenId, 5, BEFORE_WINDOW);

// Achievement: G (level legit 3 -> akhir 10) klaim level_10 kini SAH
// dipertahankan; H (level 12) klaim level_10 legit; I (= C) klaim
// recruit_1 dipertahankan (rekrutan kini sah di level >= 10); J klaim
// attack_1 (tak kena inflasi XP) dipertahankan; K klaim level_5 kini SAH
// dipertahankan; L (level legit 12, terinflasi) klaim level_10 sah +
// level_20 PALSU (12 < 20) dikembalikan.
const gCascade = simulateLevelUp(3, 20 * 8000 + 40);
const gAch = await makeCitizen('pencapai_palsu', { level: gCascade.level, xp: gCascade.xp, gold: 100 });
for (const lv of gCascade.gained) await notifyLevelUp(gAch.citizenId, lv, T0);
await run('INSERT INTO achievements (citizen_id, akey, claimed) VALUES (?,?,1)', [gAch.citizenId, 'level_10']);
const hAch = await makeCitizen('pencapai_legit', { level: 12, xp: 100, gold: 100 });
await run('INSERT INTO achievements (citizen_id, akey, claimed) VALUES (?,?,1)', [hAch.citizenId, 'level_10']);
await run('INSERT INTO achievements (citizen_id, akey, claimed) VALUES (?,?,1)', [cRecruit.citizenId, 'recruit_1']);
const jCascade = simulateLevelUp(2, 20 * 8000 + 40);
const jAch = await makeCitizen('penyerang', { level: jCascade.level, xp: jCascade.xp, gold: 100, frontlineAttacks: 1 });
for (const lv of jCascade.gained) await notifyLevelUp(jAch.citizenId, lv, T0);
await run('INSERT INTO achievements (citizen_id, akey, claimed) VALUES (?,?,1)', [jAch.citizenId, 'attack_1']);
const kCascade = simulateLevelUp(2, 20 * 8000 + 40);
const kAch = await makeCitizen('pencapai_miskin', { level: kCascade.level, xp: kCascade.xp, gold: 5 });
for (const lv of kCascade.gained) await notifyLevelUp(kAch.citizenId, lv, T0);
await run('INSERT INTO achievements (citizen_id, akey, claimed) VALUES (?,?,1)', [kAch.citizenId, 'level_5']);
// Pemain legit 12 yang terinflasi: level 12, XP 15 sebelum rescale
// (intended 300) -> terinflasi -> klaim +40 -> kaskade. Akhir tetap 12.
const lCascade = simulateLevelUp(12, 300 * 8000 + 40);
const lAch = await makeCitizen('pemain_duabelas', { level: lCascade.level, xp: lCascade.xp, gold: 200 });
for (const lv of lCascade.gained) await notifyLevelUp(lAch.citizenId, lv, T0);
await run('INSERT INTO achievements (citizen_id, akey, claimed) VALUES (?,?,1)', [lAch.citizenId, 'level_10']);
await run('INSERT INTO achievements (citizen_id, akey, claimed) VALUES (?,?,1)', [lAch.citizenId, 'level_20']);

console.log('\n[2] Menjalankan rollback');
// initDb di atas sudah menjalankan rollback sekali (DB kosong) dan menulis
// penanda. Hapus penanda agar rollback jalan pada data skenario ini —
// simulasi DB versi 17 yang baru naik ke 18.
await run("DELETE FROM db_meta WHERE key = 'xp_rollback_2026_11_28'");
const res1 = await tx(async (t) => migrateXpRollback(t));
check('Rollback jalan (tidak dilewati)', !!res1 && typeof res1.citizensChecked === 'number');
check('Ringkasan: 21 warga dicek', res1.citizensChecked === 21, `dicek=${res1.citizensChecked}`);
check('Ringkasan: 10 warga diubah', res1.citizensChanged === 10, `diubah=${res1.citizensChanged}`);
check('Ringkasan: 11 warga tidak berubah', res1.citizensUnchanged === 11, `tidak-berubah=${res1.citizensUnchanged}`);
check('Ringkasan: 9 warga berakhir di Lv10 (lantai)', res1.flooredTo10 === 9, `lantai10=${res1.flooredTo10}`);
check('Ringkasan: 0 dilewati', res1.skipped.length === 0, JSON.stringify(res1.skipped));
check('Ringkasan: 2 payout referral terpicu inflasi (hanya dihitung)', res1.referralTriggeredByInflation.length === 2, JSON.stringify(res1.referralTriggeredByInflation));
check('Ringkasan: 1 referral dipertahankan', res1.referralKept === 1, `kept=${res1.referralKept}`);
check('Ringkasan: 0 referral tak-dikenal', res1.referralUnknown.length === 0, JSON.stringify(res1.referralUnknown));
check('Ringkasan: 1 achievement dikembalikan (level_20)', res1.achievementsReverted.length === 1, JSON.stringify(res1.achievementsReverted));
check('Ringkasan: 0 achievement tak-bisa-ditarik', res1.achievementsUnrecoverable.length === 0, JSON.stringify(res1.achievementsUnrecoverable));

console.log('\n[3] Level + XP: lantai 10 untuk yang terinflasi');
let s = await citizenState(vrix.citizenId);
check('Vrix: Lv3, 1.760.000 XP -> Lv10, 220 XP', s.level === 10 && s.xp === 220, `Lv${s.level} ${s.xp} XP`);
s = await citizenState(dieck.citizenId);
check('Dieckmann: kaskade -> Lv10, 260 XP', s.level === 10 && s.xp === 260, `Lv${s.level} ${s.xp} XP`);
s = await citizenState(legit.citizenId);
check('Warga legit: Lv5, 250 XP (tidak berubah, TIDAK naik ke 10)', s.level === 5 && s.xp === 250, `Lv${s.level} ${s.xp} XP`);
s = await citizenState(baru.citizenId);
check('Pemain baru: Lv2, 150 XP (tidak berubah, TIDAK naik ke 10)', s.level === 2 && s.xp === 150, `Lv${s.level} ${s.xp} XP`);
s = await citizenState(residu.citizenId);
check('Residu: Lv3 + 500 XP legit -> Lv10, 20 XP', s.level === 10 && s.xp === 20, `Lv${s.level} ${s.xp} XP`);
s = await citizenState(veteran.citizenId);
check('Veteran: Lv100, 9900 XP (tidak berubah walau XP >= 8000)', s.level === 100 && s.xp === 9900, `Lv${s.level} ${s.xp} XP`);
s = await citizenState(newFalse.citizenId);
check('Pendaftar palsu: Lv2 legit -> Lv10, 60 XP', s.level === 10 && s.xp === 60, `Lv${s.level} ${s.xp} XP`);
s = await citizenState(dRecruit.citizenId);
check('Rekrutan palsu: Lv2 legit -> Lv10, 60 XP', s.level === 10 && s.xp === 60, `Lv${s.level} ${s.xp} XP`);
s = await citizenState(lAch.citizenId);
check('Pemain legit 12 yang terinflasi: tetap Lv12, 340 XP (tidak turun ke 10)', s.level === 12 && s.xp === 340, `Lv${s.level} ${s.xp} XP`);

console.log('\n[4] Referral: TIDAK dibatalkan, hanya dihitung');
s = await citizenState(refFalse.citizenId);
check('Pengundang palsu: emas tetap 500', Number(s.gold) === 500, `emas=${s.gold}`);
s = await citizenState(newFalse.citizenId);
check('Pendaftar palsu: emas tetap 300', Number(s.gold) === 300, `emas=${s.gold}`);
let r = await one('SELECT premium_until FROM users WHERE id = ?', [refFalse.userId]);
check('Pengundang palsu: premium tidak berubah', Number(r.premium_until) === refFalsePremBefore, `premium_until=${r.premium_until}`);
r = await one('SELECT premium_until FROM users WHERE id = ?', [newFalse.userId]);
check('Pendaftar palsu: premium tidak berubah', Number(r.premium_until) === newFalsePremBefore, `premium_until=${r.premium_until}`);
r = await one('SELECT status FROM referral_pending WHERE newcomer_id = ?', [newFalse.userId]);
check("Payout terpicu inflasi: status tetap 'paid' (tidak dibatalkan)", r.status === 'paid', `status=${r.status}`);
r = await one('SELECT status FROM referral_pending WHERE newcomer_id = ?', [newLegit.userId]);
check("Payout legit: status tetap 'paid'", r.status === 'paid', `status=${r.status}`);
r = await one('SELECT status FROM referral_pending WHERE newcomer_id = ?', [newPoor.userId]);
check("Payout terpicu inflasi (pengundang miskin): status tetap 'paid'", r.status === 'paid', `status=${r.status}`);
s = await citizenState(refPoor.citizenId);
check('Pengundang miskin: emas tetap 100', Number(s.gold) === 100, `emas=${s.gold}`);

console.log('\n[5] Rekrutan + achievement');
s = await citizenState(cRecruit.citizenId);
check('Perekrut palsu: recruits tetap 1 (tidak dikoreksi)', Number(s.recruits) === 1, `recruits=${s.recruits}`);
s = await citizenState(eRecruit.citizenId);
check('Perekrut legit: recruits tetap 1', Number(s.recruits) === 1, `recruits=${s.recruits}`);
let a = await one('SELECT * FROM achievements WHERE citizen_id = ? AND akey = ?', [gAch.citizenId, 'level_10']);
check('Klaim level_10 (akhir Lv10): dipertahankan', !!a);
s = await citizenState(gAch.citizenId);
check('Pencapai palsu: emas tetap 100 (hadiah tidak ditarik)', Number(s.gold) === 100, `emas=${s.gold}`);
a = await one('SELECT * FROM achievements WHERE citizen_id = ? AND akey = ?', [hAch.citizenId, 'level_10']);
check('Klaim level_10 legit: dipertahankan', !!a);
a = await one('SELECT * FROM achievements WHERE citizen_id = ? AND akey = ?', [cRecruit.citizenId, 'recruit_1']);
check('Klaim recruit_1: dipertahankan', !!a);
s = await citizenState(cRecruit.citizenId);
check('Perekrut palsu: emas tetap 100', Number(s.gold) === 100, `emas=${s.gold}`);
a = await one('SELECT * FROM achievements WHERE citizen_id = ? AND akey = ?', [jAch.citizenId, 'attack_1']);
check('Klaim attack_1: dipertahankan (tak kena inflasi XP)', !!a);
a = await one('SELECT * FROM achievements WHERE citizen_id = ? AND akey = ?', [kAch.citizenId, 'level_5']);
check('Klaim level_5 (akhir Lv10): dipertahankan', !!a);
s = await citizenState(kAch.citizenId);
check('Pencapai miskin: emas tetap 5', Number(s.gold) === 5, `emas=${s.gold}`);
a = await one('SELECT * FROM achievements WHERE citizen_id = ? AND akey = ?', [lAch.citizenId, 'level_10']);
check('Klaim level_10 pemain Lv12: dipertahankan', !!a);
a = await one('SELECT * FROM achievements WHERE citizen_id = ? AND akey = ?', [lAch.citizenId, 'level_20']);
check('Klaim level_20 palsu (Lv12 < 20): baris dicabut', !a);
s = await citizenState(lAch.citizenId);
check('Pemain Lv12: emas 200 -> 150 (hadiah 50 ditarik)', Number(s.gold) === 150, `emas=${s.gold}`);

console.log('\n[6] Notifikasi koreksi + idempotensi');
r = await one("SELECT COUNT(*) AS n FROM notifications WHERE citizen_id = ? AND title = 'Koreksi Level & Hadiah (Bug XP)'", [dieck.citizenId]);
check('Dieckmann menerima 1 notifikasi koreksi', Number(r.n) === 1, `n=${r.n}`);
r = await one("SELECT COUNT(*) AS n FROM notifications WHERE citizen_id = ? AND title = 'Koreksi Level & Hadiah (Bug XP)'", [legit.citizenId]);
check('Warga legit TIDAK menerima notifikasi koreksi', Number(r.n) === 0, `n=${r.n}`);
const marker = await one("SELECT value FROM db_meta WHERE key = 'xp_rollback_2026_11_28'");
check('Penanda db_meta tertulis', !!marker?.value);
const markerJson = JSON.parse(marker?.value || '{}');
check('Penanda berisi ringkasan (10 diubah, 9 di Lv10)', markerJson.citizensChanged === 10 && markerJson.flooredTo10 === 9, `changed=${markerJson.citizensChanged} lantai10=${markerJson.flooredTo10}`);
const res2 = await tx(async (t) => migrateXpRollback(t));
check('Rollback kedua: dilewati (idempotent)', !!res2 && res2.skipped === true);
s = await citizenState(vrix.citizenId);
check('Idempotent: Vrix tetap Lv10, 220 XP', s.level === 10 && s.xp === 220, `Lv${s.level} ${s.xp} XP`);
s = await citizenState(dieck.citizenId);
check('Idempotent: Dieckmann tetap Lv10, 260 XP', s.level === 10 && s.xp === 260, `Lv${s.level} ${s.xp} XP`);

console.log('\n[7] Jalur cepat initDb: XP tidak berubah');
await initDb();
s = await citizenState(vrix.citizenId);
check('initDb ulang: Vrix tetap Lv10, 220 XP', s.level === 10 && s.xp === 220, `Lv${s.level} ${s.xp} XP`);

console.log(`\n[xp-rollback] SELESAI: ${passed} lolos, ${failed} gagal`);
process.exit(failed ? 1 : 0);
