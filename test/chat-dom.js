// Parlementer — tes DOM chat (jsdom + server sungguhan).
// Perbaikan 1 & 4 (laporan Orang_solo + Khalid):
//   (1) auto-scroll hanya bila sudah di dekat bawah; sedang baca pesan lama
//       ke atas → posisi dipertahankan + tombol "pesan baru" muncul;
//       posisi di bawah → tetap lompat ke bawah.
//   (2) gagal load menampilkan status error yang jelas + retry backoff
//       (bukan diam-diam menampilkan data basi).
//   (3) muat awal memuat pesan TERBARU (server, dites di e2e) — di sini
//       dites sisi DOM: muat awal scroll ke bawah + avatar chat 48px.
// Jalankan: node test/chat-dom.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pkg from 'jsdom';
import { DatabaseSync } from 'node:sqlite';
const { JSDOM } = pkg;

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 3459;
const DB_PATH = '/tmp/parlementer-chat-dom.db';
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// Cookie jar: node fetch tidak menyimpan cookie sendiri — simpan set-cookie
// dari register/login dan kirim lagi, supaya boot() di jsdom login.
// Node fetch juga tidak bisa mem-parse URL relatif ('/api/...') — resolve
// dulu ke absolut terhadap BASE (di browser ini dilakukan otomatis).
let cookie = '';
async function jarFetch(url, opts = {}) {
  const full = typeof url === 'string' && url.startsWith('/') ? BASE + url : url;
  const res = await fetch(full, {
    ...opts,
    headers: { ...(opts.headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return res;
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }

  console.log('[chat-dom] Menyalakan server di port ' + PORT + ' ...');
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB_PATH, JWT_SECRET: 'chat-dom-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { server.kill('SIGTERM'); } catch {} };
  let dom = null;

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { const r = await fetch(BASE + '/'); up = r.status === 200; } catch { await sleep(250); }
    }
    check('server menyala dan halaman utama 200', up);
    if (!up) { console.log('[chat-dom] server tidak menyala'); process.exitCode = 1; return; }

    // Daftar 1 warga (cookie jar) — dipakai boot() di jsdom + posting pesan.
    const reg = await jarFetch(BASE + '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'chatdom@test.local', password: 'rahasia123', username: 'chat_dom' }),
    });
    check('daftar warga tes berhasil', reg.status === 200 && !!cookie, `status=${reg.status}`);
    const me = await (await jarFetch(BASE + '/api/me')).json();
    const citizenId = me.citizen.id;
    const userId = me.user.id;
    check('warga tes punya citizen + user id', !!citizenId && !!userId, `citizen=${citizenId} user=${userId}`);

    const html = await (await fetch(BASE + '/')).text();
    const htmlNoFonts = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>\s*/g, '')
      .replace(/<link[^>]*fonts\.gstatic\.com[^>]*>\s*/g, '');
    dom = new JSDOM(htmlNoFonts, {
      url: BASE + '/',
 // agar fetch relatif & script/style lokal dimuat dari server
      resources: 'usable',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window) { window.fetch = jarFetch; },
    });
    const { window } = dom;
    const { document } = window;
    await new Promise((resolve) => {
      if (document.readyState === 'complete') resolve();
      else window.addEventListener('load', resolve);
      setTimeout(resolve, 5000);
    });
    await sleep(800);

    check('aplikasi tampil setelah boot (login lewat cookie)', document.querySelector('#app').hidden === false);
    check('fungsi renderChatRoom tersedia di window', typeof window.renderChatRoom === 'function');

    // Buka halaman chat (masih kosong).
    window.location.hash = '#/chat';
    window.route();
    await sleep(800);
    const list0 = document.querySelector('#chat-list');
    check('halaman chat tampil (daftar + status + tombol pesan baru)', !!list0 && !!document.querySelector('#chat-status') && !!document.querySelector('#chat-new-pill'));
    check('status error tersembunyi saat load berhasil', document.querySelector('#chat-status').hidden === true);
    check('tombol pesan baru tersembunyi saat tidak ada pesan baru', document.querySelector('#chat-new-pill').hidden === true);

    // jsdom tidak punya layout (scrollHeight selalu 0) — palsukan metrik
    // scroll supaya perilaku auto-scroll bisa diuji secara deterministik.
    const list = document.querySelector('#chat-list');
    let st = 0;
    Object.defineProperty(list, 'scrollHeight', { get: () => 3000, configurable: true });
    Object.defineProperty(list, 'clientHeight', { get: () => 500, configurable: true });
    Object.defineProperty(list, 'scrollTop', { get: () => st, set: (v) => { st = v; }, configurable: true });

    const db = new DatabaseSync(DB_PATH);
    const ins = db.prepare('INSERT INTO chat_messages (citizen_id, room, content, created_at) VALUES (?,?,?,?)');
    // 30 pesan awal (chatSince masih 0 → render berikutnya = muat awal).
    const base = Date.now() - 30000;
    for (let i = 1; i <= 30; i++) ins.run(citizenId, 'global', 'pesan awal #' + i, base + i * 1000);

    // [A] Muat awal: 30 pesan terbaru tampil + scroll ke bawah.
    await window.renderChatRoom('global');
    check('muat awal menampilkan 30 pesan', document.querySelectorAll('#chat-list .msg').length === 30, `n=${document.querySelectorAll('#chat-list .msg').length}`);
    check('muat awal scroll ke bawah', st === 3000, `scrollTop=${st}`);

    // [B] Sedang baca ke atas + 2 pesan baru → posisi tetap, penanda muncul.
    st = 100;
    const nowA = Date.now() + 1000;
    ins.run(citizenId, 'global', 'pesan baru A1', nowA);
    ins.run(citizenId, 'global', 'pesan baru A2', nowA + 1000);
    await window.renderChatRoom('global');
    check('baca ke atas: posisi scroll dipertahankan (tidak lompat ke bawah)', st === 100, `scrollTop=${st}`);
    const pill = document.querySelector('#chat-new-pill');
    check('baca ke atas: tombol pesan baru muncul', pill.hidden === false, `hidden=${pill.hidden}`);
    check('tombol pesan baru menyebut jumlah (2 pesan baru)', /2 pesan baru/.test(pill.textContent), pill.textContent);
    check('pesan baru tetap ditambahkan ke daftar (32 pesan)', document.querySelectorAll('#chat-list .msg').length === 32);
    // Klik tombol → lompat ke bawah + penanda hilang.
    pill.click();
    check('klik tombol pesan baru: lompat ke bawah', st === 3000, `scrollTop=${st}`);
    check('klik tombol pesan baru: penanda hilang', pill.hidden === true);

    // [C] Posisi di bawah + 1 pesan baru → tetap scroll ke bawah.
    st = 2450; // 3000 - 2450 - 500 = 50px dari bawah (≤ ambang 80px)
    ins.run(citizenId, 'global', 'pesan baru B1', Date.now() + 3000);
    await window.renderChatRoom('global');
    check('di bawah: pesan baru membuat scroll ke bawah', st === 3000, `scrollTop=${st}`);
    check('di bawah: tombol pesan baru tidak muncul', pill.hidden === true);
    check('total pesan kini 33', document.querySelectorAll('#chat-list .msg').length === 33);

    // [D] Gagal load → status error jelas + retry backoff 2 detik.
    const scheduled = [];
    const origSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms, ...args) => {
      const id = origSetTimeout(fn, ms, ...args);
      scheduled.push({ fn, ms, id });
      return id;
    };
    const realFetch = window.fetch;
    window.fetch = async () => { throw new Error('koneksi putus (simulasi)'); };
    await window.renderChatRoom('global');
    const statusEl = document.querySelector('#chat-status');
    check('gagal load: status error tampil', statusEl.hidden === false, `hidden=${statusEl.hidden}`);
    check('status error menyebut gagal memuat chat', /Gagal memuat chat/.test(statusEl.textContent), statusEl.textContent.slice(0, 80));
    check('status error punya tombol Coba lagi', !!document.querySelector('#chat-retry'));
    const retry = scheduled.find((s) => s.ms === 2000);
    check('retry dijadwalkan dengan backoff awal 2 detik', !!retry, `jadwal=${scheduled.map((s) => s.ms).join(',')}`);
    // Batalkan timer asli (supaya tidak mengganggu), lalu jalankan callback
    // retry secara manual setelah fetch dipulihkan → status hilang.
    if (retry) window.clearTimeout(retry.id);
    window.setTimeout = origSetTimeout;
    window.fetch = realFetch;
    if (retry) { retry.fn(); await sleep(600); }
    check('setelah retry berhasil: status error hilang', document.querySelector('#chat-status').hidden === true);

    // [E] Avatar chat tampil 48px (Perbaikan 5).
    const TINY_JPEG_SM = 'data:image/jpeg;base64,' + Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9]).toString('base64');
    db.prepare('UPDATE users SET avatar_sm = ? WHERE id = ?').run(TINY_JPEG_SM, userId);
    db.close();
    window.route(); // render ulang chat (muat awal) dengan avatar terisi
    await sleep(800);
    const avatarImg = document.querySelector('#chat-list .msg-avatar img');
    check('pesan chat memakai foto avatar (img)', !!avatarImg);
    check('avatar chat tampil 48×48px', !!avatarImg && avatarImg.style.width === '48px' && avatarImg.style.height === '48px', avatarImg ? `${avatarImg.style.width}×${avatarImg.style.height}` : 'tidak ada img');

    // [F] Berita: sampul + gambar di isi (Orang_solo).
    const npRes = await jarFetch(BASE + '/api/press/newspaper', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Kabar ChatDom' }),
    });
    const npJson = await npRes.json();
    check('dirikan koran untuk tes gambar artikel', npRes.status === 200 && !!npJson.newspaperId, `status=${npRes.status} ${npJson.error || ''}`);
    const artRes = await jarFetch(BASE + '/api/press/articles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        newspaper_id: npJson.newspaperId, title: 'Artikel Gambar ChatDom',
        content: 'Isi artikel bergambar yang cukup panjang untuk aturan minimal. [gambar:' + TINY_JPEG_SM + ']',
        cover: TINY_JPEG_SM, cover_sm: TINY_JPEG_SM,
      }),
    });
    const artJson = await artRes.json();
    check('terbitkan artikel bergambar (sampul + 1 gambar isi)', artRes.status === 200 && !!artJson.articleId, `status=${artRes.status} ${artJson.error || ''}`);
    window.location.hash = '#/press/' + artJson.articleId;
    window.route();
    await sleep(800);
    const coverImg = document.querySelector('.article-cover');
    check('halaman artikel: sampul penuh tampil', !!coverImg && (coverImg.getAttribute('src') || '').startsWith('data:image/jpeg'), coverImg ? coverImg.getAttribute('src').slice(0, 30) : 'tidak ada img');
    const bodyImg = document.querySelector('.article-img');
    check('halaman artikel: gambar di isi dirender sebagai <img>', !!bodyImg && (bodyImg.getAttribute('src') || '').startsWith('data:image/jpeg'), bodyImg ? bodyImg.getAttribute('src').slice(0, 30) : 'tidak ada img');
    window.location.hash = '#/press';
    window.route();
    await sleep(800);
    const listThumb = document.querySelector('.article-thumb');
    check('daftar artikel: thumbnail sampul tampil', !!listThumb && (listThumb.getAttribute('src') || '').startsWith('data:image/jpeg'));
    // Render isi: <script> + penanda jahat jadi teks biasa (bukan elemen).
    const evil = window.renderArticleContent('teks <script>alert(1)</script> [gambar:javascript:alert(2)]');
    check('render isi: <script> di-escape (tidak ada tag script)', !evil.includes('<script>') && evil.includes('&lt;script&gt;'), evil.slice(0, 80));
    check('render isi: penanda javascript: tidak jadi <img>', !evil.includes('<img'), evil.slice(0, 80));
    const good = window.renderArticleContent('teks [gambar:' + TINY_JPEG_SM + '] akhir');
    check('render isi: penanda valid jadi <img> data URL', good.includes('<img src="data:image/jpeg;base64,') && good.includes('class="article-img"'), good.slice(0, 80));
    // Editor: kontrol sampul + sisipkan gambar ada.
    window.location.hash = '#/press/new';
    window.route();
    await sleep(600);
    check('editor artikel: input sampul + tombol sisipkan gambar tampil', !!document.querySelector('#art-cover-file') && !!document.querySelector('#btn-art-inline'));

    // [G] Redesain dunia: tab WILAYAH (bukan NEGARA) + room region_<id>.
    window.location.hash = '#/chat';
    window.route();
    await sleep(800);
    const tabLabels = [...document.querySelectorAll('.chat-tabs .tab')].map((t) => t.textContent.trim());
    check('tab chat: WILAYAH tampil (ganti NEGARA)', tabLabels.includes('WILAYAH'), tabLabels.join(','));
    check('tab chat: NEGARA sudah tidak ada', !tabLabels.includes('NEGARA'), tabLabels.join(','));
    const dbG = new DatabaseSync(DB_PATH);
    const myRegionId = me.citizen.region_id;
    const myRoom = 'region_' + myRegionId;
    dbG.prepare('INSERT INTO chat_messages (citizen_id, room, content, created_at) VALUES (?,?,?,?)').run(citizenId, myRoom, 'pesan wilayah satu', Date.now() - 1000);
    dbG.prepare('INSERT INTO chat_messages (citizen_id, room, content, created_at) VALUES (?,?,?,?)').run(citizenId, myRoom, 'pesan wilayah dua', Date.now());
    dbG.close();
    // Navigasi via hash SAJA (tanpa window.route() langsung — hashchange
    // sudah memicu route; memanggil route() dua kali bersamaan membuat
    // renderChatRoom pertama menempel di #chat-list yang sudah ditimpa
    // eksekusi kedua sehingga daftar tampak kosong).
    window.location.hash = '#/chat/wilayah';
    await sleep(1200);
    if (!document.querySelectorAll('#chat-list .msg').length) {
      await window.renderChatRoom(myRoom);
      await sleep(500);
    }
    const wilayahTitle = document.querySelector('.chat-title')?.textContent || '';
    check('halaman chat wilayah: judul OBROLAN WILAYAH', /OBROLAN WILAYAH/.test(wilayahTitle), wilayahTitle);
    const wilayahMsgs = [...document.querySelectorAll('#chat-list .msg')].map((m) => m.textContent);
    check('room wilayah sendiri menampilkan pesannya', wilayahMsgs.some((t) => t.includes('pesan wilayah satu')) && wilayahMsgs.some((t) => t.includes('pesan wilayah dua')), `n=${wilayahMsgs.length}`);
    const activeTab = document.querySelector('.chat-tabs .tab.active')?.textContent.trim();
    check('tab WILAYAH aktif di room wilayah', activeTab === 'WILAYAH', `aktif=${activeTab}`);
    const regionsG = await (await jarFetch(BASE + '/api/regions')).json();
    const otherRegion = (regionsG.regions || []).find((x) => x.id !== myRegionId);
    const getOther = await jarFetch(BASE + '/api/chat/region_' + otherRegion.id);
    check('baca room wilayah orang lain ditolak (404)', getOther.status === 404, `status=${getOther.status}`);
    const postOther = await jarFetch(BASE + '/api/chat/region_' + otherRegion.id, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'pesan ke wilayah orang lain tes' }),
    });
    check('kirim ke room wilayah orang lain ditolak (404)', postOther.status === 404, `status=${postOther.status}`);
    const getNegara = await jarFetch(BASE + '/api/chat/negara');
    check("room 'negara' lama ditolak (404)", getNegara.status === 404, `status=${getNegara.status}`);

    dom.window.close();
    console.log(`\n[chat-dom] SELESAI: ${passed} lolos, ${failed} gagal`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    try { dom?.window.close(); } catch {}
    stop();
  }
}

main().catch((e) => { console.error('[chat-dom] ERROR:', e); process.exit(1); });
