// Parlementer — tes DOM latar ambient v5.7.3 (poles Lane 8): latar belakang
// aplikasi bernyawa pelan (mesh gradient CSS murni, tanpa JS, tanpa ubah
// aturan main). Referensi: motion-background skill
// (claudepluginhub.com/skills/iart-ai-motion-design-skills/motion-background).
// Membuktikan (server sungguhan + CSS yang disajikan):
//   (1) VERSI: /api/world melaporkan 5.7.3;
//   (2) /css/style.css memuat keyframes ambient-drift + aturan body yang
//       memakai 3 lapis radial-gradient (emas/teal/navy) di atas --bg;
//   (3) Loop tanpa sambungan: keyframe 0% dan 100% identik;
//   (4) Kontras terjaga: semua alpha cahaya ≤ 0,10;
//   (5) Aksesibilitas: blok prefers-reduced-motion mematikan animasi body.
// Jalankan: node test/ambient-bg-dom.js  (atau: npm run test:ambient-bg)
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3476;
const DB_PATH = '/tmp/parlementer-ambient-bg-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;
const EXPECTED_VERSION = '5.7.3';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// Ambil isi blok @keyframes ambient-drift (kurung seimbang).
function keyframesBlock(css) {
  const start = css.indexOf('@keyframes ambient-drift');
  if (start < 0) return null;
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth === 0) return css.slice(open + 1, i); }
  }
  return null;
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[ambient-bg-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'ambient-bg-dom-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  try {
    await sleep(1200);

    // --- (1) Versi.
    const world = await (await fetch(BASE + '/api/world')).json();
    check('API /api/world: versi 5.7.3', world.version === EXPECTED_VERSION, `version=${world.version}`);

    // --- (2)-(5) CSS yang disajikan server.
    const cssRes = await fetch(BASE + '/css/style.css');
    check('CSS disajikan (200)', cssRes.status === 200, `status=${cssRes.status}`);
    const css = await cssRes.text();

    const bodyRule = css.match(/body\s*\{([\s\S]*?)\n\}/);
    check('body memakai animasi ambient-drift 28 dtk',
      !!bodyRule && /animation:\s*ambient-drift\s+28s/.test(bodyRule[1]),
      bodyRule ? bodyRule[1].slice(0, 120).replace(/\s+/g, ' ') : 'aturan body tidak ketemu');
    const gradients = (bodyRule?.[1].match(/radial-gradient\(/g) || []).length;
    check('body punya 3 lapis radial-gradient (emas/teal/navy)',
      gradients === 3, `lapis=${gradients}`);
    check('body tetap berakhir di warna dasar --bg',
      !!bodyRule && /var\(--bg\)/.test(bodyRule[1]));
    check('lapis cahaya memakai warna palet game (emas 217,164,65 / teal 45,212,191 / navy 38,68,120)',
      !!bodyRule
      && bodyRule[1].includes('217,164,65') && bodyRule[1].includes('45,212,191')
      && bodyRule[1].includes('38,68,120'));

    const kf = keyframesBlock(css);
    check('keyframes ambient-drift ada', kf !== null);
    if (kf) {
      const first = kf.match(/0%\s*,\s*100%\s*\{([^}]*)\}/);
      check('keyframe 0% dan 100% digabung identik (loop tanpa sambungan)',
        !!first, first ? first[1].trim() : kf.slice(0, 120));
      const mid = kf.match(/50%\s*\{([^}]*)\}/);
      check('keyframe 50% bergeser dari posisi awal (ada gerakan)',
        !!mid && !!first && mid[1].trim() !== first[1].trim());
    }

    // Alpha cahaya: ambil semua rgba(...) di dalam aturan body.
    const alphas = [...(bodyRule?.[1].matchAll(/rgba\(\d+,\d+,\d+,([\d.]+)\)/g) || [])]
      .map((m) => parseFloat(m[1]));
    check('semua alpha cahaya ≤ 0,10 (teks tetap kontras)',
      alphas.length === 3 && alphas.every((a) => a <= 0.10),
      `alpha=[${alphas.join(', ')}]`);

    const reduced = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g) || [];
    check('prefers-reduced-motion mematikan animasi body',
      reduced.some((b) => /body\s*\{\s*animation:\s*none/.test(b)),
      `${reduced.length} blok reduced-motion`);
  } finally {
    stop();
  }
  console.log(`\n[ambient-bg-dom] ${passed} lolos, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
