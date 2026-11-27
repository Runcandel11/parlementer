// Parlementer — tes DOM Tahap 7 v4.1.0 (jsdom + server sungguhan).
// Membuktikan di UI (bukan cuma API):
//   (1) Satu sumber kebenaran (fungsi murni game.js): DAY_MS, durasi
//       pemilu, jeda latih + diskon Pendidikan, slot konvoi, klaim
//       harian, TTL valas, biaya pemberontakan, UU pajak impor, batas
//       energi maksimum;
//   (2) Dashboard: deskripsi atribut JUJUR — Pendidikan "Latihan lebih
//       cepat (−5% jeda/level, maks −50%)", Ekonomi "Gaji shift lebih
//       besar (+3%/level)"; janji lama ("Pelatihan lebih cepat", "Hasil
//       produksi lebih banyak") sudah tidak ada;
//   (3) Toko: tagline Deluxe tanpa "peti perang"; teks Premium jujur
//       ("Batas energi +20, +1 slot konvoi") — bukan "slot konvoi
//       keempat" / "Batas energi 120";
//   (4) API /api/shop + /api/me membawa teks yang sama dengan UI.
// Jalankan: node test/stage7-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3470;
const DB_PATH = '/tmp/parlementer-stage7-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function makeJar() {
  let cookie = '';
  return async (url, opts = {}) => {
    const full = typeof url === 'string' && url.startsWith('/') ? BASE + url : url;
    const res = await fetch(full, {
      ...opts,
      headers: { ...(opts.headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return res;
  };
}
async function api(jar, path, body, method) {
  const res = await jar(path, body === undefined && !method ? undefined : { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function bootDom(url, jarFetchFn) {
  const html = await (await fetch(BASE + '/')).text();
  const htmlNoFonts = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>\s*/g, '')
    .replace(/<link[^>]*fonts\.gstatic\.com[^>]*>\s*/g, '');
  const dom = new JSDOM(htmlNoFonts, {
    url,
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = jarFetchFn;
      window.confirm = () => true;
      window.URL.createObjectURL = () => 'blob:stub';
      window.URL.revokeObjectURL = () => {};
    },
  });
  const { window } = dom;
  await new Promise((resolve) => {
    if (window.document.readyState === 'complete') resolve();
    else window.addEventListener('load', resolve);
    setTimeout(resolve, 5000);
  });
  await sleep(1800);
  return dom;
}

async function goto(dom, hash) {
  dom.window.location.hash = hash;
  dom.window.route();
  await sleep(1300);
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[stage7-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'stage7-dom-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { const r = await fetch(BASE + '/api/world'); up = r.ok; } catch { await sleep(250); }
    }
    check('server menyala dan /api/world merespons', up);
    if (!up) { process.exitCode = 1; return; }
    const world = await (await fetch(BASE + '/api/world')).json();
    check('API /api/world: versi 4.2.0', world.version === '4.2.0', `version=${world.version}`);

    // --- (1) Fungsi murni: satu sumber kebenaran (Tahap 7) ---
    const g = await import('../src/game.js');
    check('DAY_MS = 86400000 (sehari)', g.DAY_MS === 86400000, `DAY_MS=${g.DAY_MS}`);
    check('ELECTION_VOTE_MS = 3 hari; usia minimal memilih juga 3 hari (konstanta terpisah)', g.ELECTION_VOTE_MS === 3 * g.DAY_MS && g.ELECTION_VOTE_MIN_AGE_MS === 3 * g.DAY_MS && g.ELECTION_VOTE_MS === g.ELECTION_VOTE_MIN_AGE_MS, `${g.ELECTION_VOTE_MS}/${g.ELECTION_VOTE_MIN_AGE_MS}`);
    check('trainCooldownMs(1,0)=120000 (2 mnt, tanpa Pendidikan)', g.trainCooldownMs(1, 0) === 120000, `${g.trainCooldownMs(1, 0)}`);
    check('trainCooldownMs(1,1)=114000 (−5% Pendidikan LV 1)', g.trainCooldownMs(1, 1) === 114000, `${g.trainCooldownMs(1, 1)}`);
    check('trainCooldownMs(1,10)=60000 (diskon mentok −50%)', g.trainCooldownMs(1, 10) === 60000, `${g.trainCooldownMs(1, 10)}`);
    check('trainCooldownMs(1,30)=60000 (di atas 10 tetap −50%)', g.trainCooldownMs(1, 30) === 60000, `${g.trainCooldownMs(1, 30)}`);
    check('trainCooldownMs(5,0)=600000 (2 mnt × LV 5)', g.trainCooldownMs(5, 0) === 600000, `${g.trainCooldownMs(5, 0)}`);
    check('convoySlotsFor: LV 1 tanpa Premium = 1 slot', g.convoySlotsFor({ level: 1, premium_until: 0 }) === 1, `${g.convoySlotsFor({ level: 1, premium_until: 0 })}`);
    check('convoySlotsFor: LV 25 = 2 slot; LV 100 + Premium = 5 slot', g.convoySlotsFor({ level: 25, premium_until: 0 }) === 2 && g.convoySlotsFor({ level: 100, premium_until: Date.now() + 60000 }) === 5, `${g.convoySlotsFor({ level: 25, premium_until: 0 })}/${g.convoySlotsFor({ level: 100, premium_until: Date.now() + 60000 })}`);
    check('DAILY_CLAIM = +5 emas / +50 USD / +40 XP', g.DAILY_CLAIM.gold === 5 && g.DAILY_CLAIM.usd === 50 && g.DAILY_CLAIM.xp === 40, JSON.stringify(g.DAILY_CLAIM));
    check('FX_OFFER_TTL_MS = 72 jam', g.FX_OFFER_TTL_MS === 72 * g.DAY_MS, `${g.FX_OFFER_TTL_MS}`);
    check('REBEL_COST 50 / REBEL_COST_CAPITAL 100 (Jakarta)', g.REBEL_COST === 50 && g.REBEL_COST_CAPITAL === 100 && g.REBEL_CAPITAL_NAME === 'Jakarta', `${g.REBEL_COST}/${g.REBEL_COST_CAPITAL}`);
    check('LAW_KINDS.tax_import ada (1–5%) + lawEffectText jujur', g.LAW_KINDS.tax_import?.min === 1 && g.LAW_KINDS.tax_import?.max === 5 && g.lawEffectText('tax_import', 4) === 'Pajak impor kini 4%.', g.lawEffectText('tax_import', 4));
    check('energyCapFor(1,true,true)=130 (100+20 Premium+10 RS)', g.energyCapFor(1, true, true) === 130, `${g.energyCapFor(1, true, true)}`);
    check('SHOP_PACKAGES Deluxe: tanpa "peti perang"', !g.SHOP_PACKAGES.find((p) => p.id === 'deluxe')?.tagline.includes('peti perang'), g.SHOP_PACKAGES.find((p) => p.id === 'deluxe')?.tagline);
    check('PREMIUM_PERKS jujur: "+20" + "+1 slot konvoi", tanpa "keempat"/"120"', g.PREMIUM_PERKS.includes('+1 slot konvoi') && g.PREMIUM_PERKS.includes('Batas energi +20') && !g.PREMIUM_PERKS.includes('keempat') && !g.PREMIUM_PERKS.includes('120'), g.PREMIUM_PERKS);

    // --- (2)+(3) UI: dashboard + toko ---
    const jarA = makeJar();
    let r = await api(jarA, '/api/auth/register', { email: 'domTujuh@test.local', password: 'rahasia123', username: 'warga_tujuh' });
    check('Daftar warga_tujuh (API)', r.status === 200 && r.data.ok, `status=${r.status}`);
    const meA = (await api(jarA, '/api/me', undefined, 'GET')).data;
    check('/api/me: trainCooldowns + trainCosts ada', !!meA.citizen?.trainCooldowns && !!meA.citizen?.trainCosts, JSON.stringify(Object.keys(meA.citizen || {}).filter((k) => k.startsWith('train'))));

    dom = await bootDom(BASE + '/#/dashboard', jarA);
    let { window } = dom;
    let { document } = window;
    const dashText = document.querySelector('#page')?.textContent || document.body.textContent || '';
    check('Dashboard: deskripsi Pendidikan jujur (−5% jeda/level, maks −50%)', dashText.includes('Latihan lebih cepat') && dashText.includes('−5% jeda/level'), dashText.slice(dashText.indexOf('Pendidikan'), dashText.indexOf('Pendidikan') + 120));
    check('Dashboard: deskripsi Ekonomi jujur (gaji shift +3%/level)', dashText.includes('Gaji shift lebih besar (+3%/level)'), dashText.slice(dashText.indexOf('Ekonomi'), dashText.indexOf('Ekonomi') + 120));
    check('Dashboard: janji lama sudah hilang ("Pelatihan lebih cepat" / "Hasil produksi lebih banyak")', !dashText.includes('Pelatihan lebih cepat') && !dashText.includes('Hasil produksi lebih banyak'));

    await goto(dom, '#/shop');
    const shopText = document.querySelector('#page')?.textContent || '';
    check('Toko: tagline Deluxe baru tampil di UI', shopText.includes('Satu musim keistimewaan dengan emas berlimpah'), shopText.slice(0, 300));
    check('Toko: "peti perang" tidak muncul di mana pun di halaman toko', !shopText.includes('peti perang'), shopText.slice(0, 300));
    check('Toko: teks Premium jujur tampil ("Batas energi +20, +1 slot konvoi")', shopText.includes('Batas energi +20') && shopText.includes('+1 slot konvoi'), shopText.slice(shopText.indexOf('Batas energi'), shopText.indexOf('Batas energi') + 120));

    // --- (4) API membawa teks yang sama dengan UI ---
    const shop = (await api(jarA, '/api/shop', undefined, 'GET')).data;
    const deluxeApi = (shop.packages || []).find((p) => p.id === 'deluxe');
    check('API /api/shop: tagline Deluxe = teks UI (tanpa peti perang)', deluxeApi?.tagline === 'Satu musim keistimewaan dengan emas berlimpah.', deluxeApi?.tagline);
    check('API /api/shop: PREMIUM_PERKS = teks UI', (shop.premiumPerks || shop.perks || '') === g.PREMIUM_PERKS || JSON.stringify(shop).includes('Batas energi +20'), JSON.stringify(shop).slice(0, 200));
  } catch (e) {
    failed++;
    console.log('  ✗ stage7-dom crash: ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : e));
  } finally {
    if (dom) { try { dom.window.close(); } catch {} }
    stop();
  }
  console.log(`\n[stage7-dom] SELESAI: ${passed} lolos, ${failed} gagal`);
  process.exitCode = failed ? 1 : 0;
}

main();
