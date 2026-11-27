// Parlementer — aplikasi web (SPA vanilla JS, tema gelap navy-hitam aksen emas).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: d });
const fmtUSD = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const fmtIDR = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
const fmtDate = (ts) => new Date(ts).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
const ago = (ts) => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'baru saja';
  if (s < 3600) return Math.floor(s / 60) + ' mnt lalu';
  if (s < 86400) return Math.floor(s / 3600) + ' jam lalu';
  return Math.floor(s / 86400) + ' hari lalu';
};

let ME = null; // hasil /api/me
let chatTimer = null;
let chatSince = 0;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.hidden = true; }, 3500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Terjadi kesalahan.');
  return data;
}
const post = (path, body = {}) => api(path, { method: 'POST', body });

// ---------- AUTH ----------
async function boot() {
  try {
    const me = await api('/api/auth/me');
    if (me.citizen) { showApp(); return; }
  } catch { /* belum login */ }
  showAuth();
}

function showAuth() {
  $('#app').hidden = true;
  $('#auth-view').hidden = false;
  $('#tab-login').onclick = () => switchAuthTab('login');
  $('#tab-register').onclick = () => switchAuthTab('register');
  $('#form-login').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = $('#login-error');
    err.hidden = true;
    try {
      await post('/api/auth/login', { email: f.email.value.trim(), password: f.password.value });
      showApp();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
  $('#form-register').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = $('#register-error');
    err.hidden = true;
    try {
      await post('/api/auth/register', {
        email: f.email.value.trim(), password: f.password.value,
        username: f.username.value.trim(), ref: f.ref.value.trim() || undefined,
      });
      toast('Selamat datang! Kamu sekarang warga Republik Indonesia.');
      showApp();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
}
function switchAuthTab(which) {
  $('#tab-login').classList.toggle('active', which === 'login');
  $('#tab-register').classList.toggle('active', which === 'register');
  $('#form-login').hidden = which !== 'login';
  $('#form-register').hidden = which !== 'register';
}

async function logout() {
  await post('/api/auth/logout');
  location.hash = '';
  location.reload();
}

// ---------- SHELL ----------
const NAV = [
  { group: 'BERANDA', items: [
    ['dashboard', 'Dashboard', '▦'], ['achievements', 'Pencapaian', '🏆'],
    ['inventory', 'Inventaris', '📦'], ['convoy', 'Konvoi', '🚚'],
  ]},
  { group: 'DUNIA', items: [
    ['map', 'Peta', '🗺'], ['regions', 'Wilayah', '📍'],
    ['country', 'Negara', '🏛'], ['stats', 'Statistik', '📊'],
  ]},
  { group: 'EKONOMI', items: [
    ['market', 'Pasar', '🏪'], ['global', 'Pasar Global', '🌐'], ['fx', 'Valas', '⇄'],
    ['jobs', 'Pekerjaan', '💼'], ['companies', 'Perusahaan', '🏭'], ['contracts', 'Kontrak', '📜'],
  ]},
  { group: 'KOMUNITAS', items: [
    ['press', 'Pers', '📰'], ['newspaper', 'Dirikan Koran', '✏️'],
    ['messages', 'Pesan', '✉️'], ['chat', 'Obrolan', '💬'],
  ]},
  { group: 'POLITIK', items: [
    ['parties', 'Partai', '🚩'], ['parliament', 'Parlemen', '🏛'],
    ['elections', 'Pemilu', '🗳'], ['orgs', 'Organisasi', '🤝'],
  ]},
  { group: 'PERANG', items: [
    ['war', 'Perang Tanah Air', '🛡️'], ['war-world', 'Perang Dunia', '🔥'],
  ]},
  { group: 'BANTUAN', items: [
    ['help', 'Meja Bantuan', '🎧'], ['contact', 'Kontak', '✉️'],
    ['book', 'Buku', '📖'], ['shop', 'Toko', '💎'],
  ]},
];

function buildNav() {
  $('#drawer-nav').innerHTML = NAV.map((g) => `
    <div class="nav-group">${g.group}</div>
    ${g.items.map(([slug, label, ico]) => `
      <button class="nav-item" data-route="${slug}" type="button">
        <span class="ico">${ico}</span>${label}
      </button>`).join('')}`).join('') + `
    <div class="nav-group">AKUN</div>
    <button class="nav-item" data-route="settings" type="button"><span class="ico">⚙️</span>Pengaturan</button>
    <button class="nav-item" id="nav-logout" type="button"><span class="ico">🚪</span>Keluar</button>`;
  $$('#drawer-nav .nav-item[data-route]').forEach((b) => {
    b.onclick = () => { closeDrawer(); location.hash = '#/' + b.dataset.route; };
  });
  $('#nav-logout').onclick = logout;
}

function openDrawer() { $('#drawer').classList.add('open'); $('#drawer-overlay').classList.add('open'); }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawer-overlay').classList.remove('open'); }

async function showApp() {
  $('#auth-view').hidden = true;
  $('#app').hidden = false;
  buildNav();
  $('#btn-menu').onclick = openDrawer;
  $('#drawer-close').onclick = closeDrawer;
  $('#drawer-overlay').onclick = closeDrawer;
  $('#btn-chat').onclick = () => { location.hash = '#/chat'; };
  $('#energy-chat').onclick = () => { location.hash = '#/chat'; };
  $('#btn-notif').onclick = () => { location.hash = '#/notifications'; };
  $('#btn-settings').onclick = () => { location.hash = '#/settings'; };
  await refreshMe();
  window.addEventListener('hashchange', route);
  route();
  setInterval(refreshMe, 30000);
}

async function refreshMe() {
  try {
    ME = await api('/api/me');
    renderHUD();
  } catch { /* sesi habis */ }
}

function renderHUD() {
  if (!ME) return;
  const c = ME.citizen;
  $('#hud-name').textContent = c.username + (c.isPremium ? ' ◆' : '');
  $('#hud-region').textContent = (ME.region?.name || '') + ' · Republik Indonesia';
  $('#hud-usd').textContent = fmtUSD(c.usd);
  $('#hud-gold').textContent = fmt(c.gold);
  $('#hud-xp').textContent = c.xp + '/' + ME.xpNext;
  $('#hud-lv').textContent = c.level;
  const segs = $('#energy-segs');
  const filled = Math.round(c.energy / 10);
  segs.innerHTML = Array.from({ length: 10 }, (_, i) => `<i class="${i < filled ? 'on' : ''}"></i>`).join('');
  $('#energy-num').textContent = c.energy + '/100';
  const badge = (id, n) => { const el = $(id); el.hidden = !n; el.textContent = n > 99 ? '99+' : n; };
  badge('#badge-notif', ME.unread);
  badge('#badge-chat', ME.unreadDm);
  badge('#badge-chat2', ME.unreadDm);
}

// ---------- ROUTER ----------
const ROUTES = {};
function route() {
  clearInterval(chatTimer); chatTimer = null; chatSince = 0;
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [slug, arg] = hash.split('/');
  $$('#drawer-nav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.route === slug));
  const fn = ROUTES[slug] || ROUTES.dashboard;
  $('#page').innerHTML = '<div class="panel"><p class="muted">Memuat…</p></div>';
  fn(arg).catch((e) => {
    $('#page').innerHTML = `<div class="panel"><h3>Terjadi kesalahan</h3><p class="muted">${esc(e.message)}</p>
      <button class="btn-gold" onclick="location.reload()">Muat Ulang</button></div>`;
  });
}
const page = (title, sub, body) => `
  <h2>${title}</h2>
  ${sub ? `<p class="page-sub">${sub}</p>` : ''}
  ${body}`;

const emptyState = (ico, title, sub) => `
  <div class="panel"><div class="empty"><div class="big-ico">${ico}</div>
  <h3>${title}</h3><p class="muted">${sub}</p></div></div>`;

// ---------- DASHBOARD ----------
ROUTES.dashboard = async () => {
  const [m, ch] = await Promise.all([api('/api/missions'), api('/api/chronicle')]);
  const c = ME.citizen;
  const canClaim = c.last_claim_date !== new Date().toISOString().slice(0, 10);
  const ch1 = ch.chapters[0];
  $('#page').innerHTML = page('DASHBOARD', `Hari ${ME.world.day} · Populasi dunia: ${fmt(ME.population)} warga`, `
  ${ME.activeWars.length ? `<div class="panel"><h3>⚔️ SEDANG TERJADI</h3>
    ${ME.activeWars.map((w) => `<div class="kv"><span class="k">${esc(w.name)}</span><span class="v">${fmt(w.score_a)} vs ${fmt(w.score_d)}</span></div>`).join('')}
    <button class="btn-gold btn-sm" onclick="location.hash='#/war'">Lihat Perang</button></div>` : ''}
  ${ME.votingLaws.length ? `<div class="panel"><h3>🏛 UU SEDANG DIVOTING</h3>
    ${ME.votingLaws.map((l) => `<div class="kv"><span class="k">${esc(l.title)}</span><span class="v">${l.yes} Ya / ${l.abstain} / ${l.no} Tidak</span></div>`).join('')}
    <button class="btn-gold btn-sm" onclick="location.hash='#/parliament'">Buka Parlemen</button></div>` : ''}
  <div class="panel">
    <div class="panel-head"><h3>👤 ${esc(c.username)}</h3><span class="chip">${c.isPremium ? '◆ PREMIUM' : 'WARGA'}</span></div>
    <div class="kv"><span class="k">Negara</span><span class="v">🇮🇩 Republik Indonesia</span></div>
    <div class="kv"><span class="k">Berada di</span><span class="v">${esc(ME.region?.name || '')}</span></div>
    <div class="kv"><span class="k">Partai</span><span class="v">${ME.party ? esc(ME.party.name) + ' [' + esc(ME.party.tag) + ']' : 'Belum berpartai'}</span></div>
    <div class="kv"><span class="k">Pekerjaan</span><span class="v">${ME.job ? esc(ME.job.title) : 'Belum bekerja'}</span></div>
    <div class="kv"><span class="k">Level</span><span class="v">${c.level} · ${c.xp}/${ME.xpNext} XP</span></div>
    <div class="bar gold" style="margin:6px 0 12px"><i style="width:${Math.min(100, c.xp / ME.xpNext * 100)}%"></i></div>
    <div class="kv"><span class="k">⚡ Energi</span><span class="v">${c.energy}/100</span></div>
    <div class="bar" style="margin:6px 0 12px"><i style="width:${c.energy}%"></i></div>
    <p class="muted small">${c.energy >= 100 ? 'Penuh — gunakan untuk bekerja' : 'Makan roti untuk mengisi energi.'}</p>
    <div class="row" style="margin-top:12px">
      <button class="btn-gold" id="btn-claim" ${canClaim ? '' : 'disabled'}>${canClaim ? '🎁 AMBIL PASOKAN HARIAN' : '✓ Pasokan hari ini diambil'}</button>
      <button class="btn-ghost" onclick="location.hash='#/inventory'">🍞 Makan Roti</button>
    </div>
  </div>
  <div class="panel">
    <h3>💪 LATIHAN</h3>
    ${[['str', 'Kekuatan', c.attr_str, 'Kerusakan perang'], ['edu', 'Pendidikan', c.attr_edu, 'Pelatihan lebih cepat'], ['eco', 'Ekonomi', c.attr_eco, 'Hasil produksi lebih banyak']].map(([k, label, lv, desc]) => `
      <div class="kv"><span class="k">${label} · LV ${lv}<br><small class="muted">${desc}</small></span>
      <span class="v"><button class="btn-gold btn-sm" data-train="${k}">LATIH · ${lv + 1} emas</button></span></div>`).join('')}
  </div>
  <div class="panel">
    <h3>🎯 MISI HARIAN <span class="muted small">· masing-masing +10 emas</span></h3>
    ${m.missions.map((mi) => `
      <div class="kv"><span class="k">${esc(mi.label)}</span>
      <span class="v">${mi.progress}/${mi.target} ${mi.claimed ? '✓ Diklaim' : mi.progress >= mi.target ? `<button class="btn-gold btn-sm" data-mission="${mi.key}">KLAIM +10 🪙</button>` : ''}</span></div>
      <div class="bar" style="margin:4px 0 10px"><i style="width:${Math.min(100, mi.progress / mi.target * 100)}%"></i></div>`).join('')}
  </div>
  <div class="panel">
    <div class="panel-head"><h3>📖 KRONIKMU — Babak I "${esc(ch1.title)}"</h3><span class="chip">${ch1.done}/${ch1.total}</span></div>
    ${ch1.tasks.map((t) => `<div class="kv"><span class="k">${t.done ? '✓' : '○'} ${esc(t.label)}</span></div>`).join('')}
    <div class="row" style="margin-top:10px">
      <button class="btn-ghost" onclick="location.hash='#/chronicle'">Lihat Semua Babak</button>
      ${ch1.done === ch1.total && !ch1.claimed ? `<button class="btn-gold" data-chronicle="1">KLAIM +${ch1.reward} EMAS</button>` : ''}
    </div>
  </div>`);
  $('#btn-claim')?.addEventListener('click', async () => {
    try { const r = await post('/api/claim'); toast(`Pasokan diterima: +${r.reward.gold} emas, +${r.reward.usd} USD, +${r.reward.xp} XP.`); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-train]').forEach((b) => b.onclick = async () => {
    try { await post('/api/train', { attr: b.dataset.train }); toast('Latihan selesai! Atribut naik 1 level.'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-mission]').forEach((b) => b.onclick = async () => {
    try { await post('/api/missions/claim', { key: b.dataset.mission }); toast('Hadiah misi diterima: +10 emas.'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-chronicle]').forEach((b) => b.onclick = async () => {
    try { await post('/api/chronicle/claim', { chapter: Number(b.dataset.chronicle) }); toast('Hadiah babak diterima!'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
};

ROUTES.chronicle = async () => {
  const ch = await api('/api/chronicle');
  $('#page').innerHTML = page('KRONIKMU', 'Ikuti babak demi babak, kumpulkan hadiah emas.', ch.chapters.map((c) => `
    <div class="panel">
      <div class="panel-head"><h3>Babak ${c.chapter} — ${esc(c.title)}</h3><span class="chip">${c.done}/${c.total} · +${c.reward} emas</span></div>
      ${c.tasks.map((t) => `<div class="kv"><span class="k">${t.done ? '✓' : '○'} ${esc(t.label)}</span></div>`).join('')}
      ${c.done === c.total && !c.claimed ? `<button class="btn-gold" data-chronicle="${c.chapter}">KLAIM +${c.reward} EMAS</button>` : c.claimed ? '<p class="teal-text small">✓ Hadiah sudah diklaim.</p>' : ''}
    </div>`).join(''));
  $$('[data-chronicle]').forEach((b) => b.onclick = async () => {
    try { await post('/api/chronicle/claim', { chapter: Number(b.dataset.chronicle) }); toast('Hadiah babak diterima!'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
};

// ---------- INVENTARIS ----------
ROUTES.inventory = async () => {
  const inv = await api('/api/inventory');
  const foods = inv.items.filter((i) => i.name === 'Makanan');
  $('#page').innerHTML = page('INVENTARIS', `${inv.totalQty} unit · ${inv.items.length} jenis barang · nilai pasar ±${fmtUSD(inv.marketValue)} USD`, `
  <div class="panel"><h3>🍞 MAKANAN</h3>
    <p class="muted small">Sisa roti hari ini: ${10 - ME.citizen.bread_today}/10 · T1 +10 ⚡, T2 +20, T3 +30, T4 +40, T5 +50</p>
    ${foods.length ? foods.map((f) => `<div class="kv"><span class="k">Makanan T${f.tier} ×${f.qty}</span>
      <span class="v"><button class="btn-gold btn-sm" data-eat="${f.tier}">MAKAN +${f.tier * 10} ⚡</button></span></div>`).join('')
      : '<p class="muted">Tidak ada roti. Beli di Pasar.</p>'}
  </div>
  <div class="panel"><h3>📦 SEMUA BARANG</h3>
    ${inv.items.length ? `<table class="table"><tr><th>Barang</th><th>Tingkat</th><th>Jumlah</th><th>Nilai</th></tr>
    ${inv.items.map((i) => `<tr><td>${esc(i.name)}</td><td>T${i.tier}</td><td>×${i.qty}</td><td>${fmtUSD(i.qty * i.ref_usd)} USD</td></tr>`).join('')}</table>`
      : '<p class="muted">Inventaris kosong.</p>'}
  </div>`);
  $$('[data-eat]').forEach((b) => b.onclick = async () => {
    try { const r = await post('/api/eat', { tier: Number(b.dataset.eat) }); toast(`Energi +${r.gained} (sekarang ${r.energy}/100).`); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
};

// ---------- KONVOI ----------
ROUTES.convoy = async () => {
  const cv = await api('/api/convoy');
  $('#page').innerHTML = page('KONVOI', `${cv.used}/${cv.slots} slot terpakai · tiap bangunan berdiri 7 hari lalu roboh`, `
  <div class="panel"><h3>🏗️ BANGUN KONVOI</h3>
    <p class="muted small">Satu bangunan per jenis dalam satu waktu. Biaya 10 emas. Slot tambahan di Level 25 / 50 / 100 dan Premium.</p>
    ${cv.buildings.map((b) => `
      <div class="kv"><span class="k">${esc(b.name)}<br><small class="muted">${esc(b.desc)}</small></span>
      <span class="v">${cv.convoys.some((x) => x.building === b.type) ? '✓ Dibangun' : `<button class="btn-gold btn-sm" data-build="${b.type}">BANGUN · 10 emas</button>`}</span></div>`).join('')}
  </div>
  <div class="panel"><h3>🚚 KONVOIMU</h3>
    ${cv.convoys.length ? cv.convoys.map((x) => {
      const def = cv.buildings.find((b) => b.type === x.building);
      return `<div class="kv"><span class="k">${esc(def?.name || x.building)}<br><small class="muted">Berakhir ${fmtDate(x.expires_at)}</small></span>
      <span class="v"><button class="btn-danger btn-sm" data-demolish="${x.id}">Bongkar</button></span></div>`;
    }).join('') : '<p class="muted">Belum ada bangunan. Konvoi berjalan kosong.</p>'}
  </div>`);
  $$('[data-build]').forEach((b) => b.onclick = async () => {
    try { await post('/api/convoy/build', { building: b.dataset.build }); toast('Bangunan konvoi didirikan.'); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-demolish]').forEach((b) => b.onclick = async () => {
    try { await post('/api/convoy/demolish', { id: Number(b.dataset.demolish) }); toast('Bangunan dibongkar.'); route(); }
    catch (e) { toast(e.message); }
  });
};

// ---------- PENCAPAIAN ----------
ROUTES.achievements = async () => {
  const a = await api('/api/achievements');
  const cats = [...new Set(a.achievements.map((x) => x.cat))];
  $('#page').innerHTML = page('PENCAPAIAN', `Total hadiah yang masih bisa diraih: ${fmt(a.totalGold)} emas`, cats.map((cat) => `
    <div class="panel"><h3>🏆 ${esc(cat)}</h3>
    ${a.achievements.filter((x) => x.cat === cat).map((x) => `
      <div class="kv"><span class="k">${x.claimed ? '✓' : x.ready ? '★' : '○'} ${esc(x.label)}<br><small class="muted">Hadiah +${x.reward} emas</small></span>
      <span class="v">${x.progress}/${x.target} ${x.ready ? `<button class="btn-gold btn-sm" data-ach="${x.key}">KLAIM</button>` : x.claimed ? 'Diklaim' : ''}</span></div>
      <div class="bar" style="margin:4px 0 10px"><i style="width:${Math.min(100, x.progress / x.target * 100)}%"></i></div>`).join('')}
    </div>`).join(''));
  $$('[data-ach]').forEach((b) => b.onclick = async () => {
    try { const r = await post('/api/achievements/claim', { key: b.dataset.ach }); toast(`Pencapaian diklaim: +${r.reward} emas!`); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
};

// ---------- NOTIFIKASI ----------
ROUTES.notifications = async () => {
  const n = await api('/api/notifications');
  $('#page').innerHTML = page('NOTIFIKASI', '', `
  <div class="panel">
    <div class="panel-head"><h3>🔔 Pusat Notifikasi</h3><button class="btn-ghost btn-sm" id="btn-read-all">Tandai Semua Dibaca</button></div>
    ${n.notifications.length ? n.notifications.map((x) => `
      <div class="kv"><span class="k"><span class="chip">${esc(x.category)}</span> <b>${esc(x.title)}</b><br><small class="muted">${esc(x.content)}</small></span>
      <span class="v small muted">${ago(x.created_at)}</span></div>`).join('')
      : '<p class="muted">Belum ada notifikasi.</p>'}
  </div>`);
  $('#btn-read-all').onclick = async () => { await post('/api/notifications/read'); await refreshMe(); route(); };
};

// ---------- PROFIL ----------
ROUTES.profile = async (username) => {
  const name = username || ME.citizen.username;
  const p = await api('/api/profile/' + encodeURIComponent(name));
  const pr = p.profile;
  $('#page').innerHTML = page('BERKAS WARGA', '', `
  <div class="panel">
    <div class="panel-head"><h3>👤 ${esc(pr.username)} ${pr.isPremium ? '◆' : ''}</h3><span class="chip">LEVEL ${pr.level}</span></div>
    <div class="kv"><span class="k">Kewarganegaraan</span><span class="v">Republik Indonesia</span></div>
    <div class="kv"><span class="k">Daerah asal</span><span class="v">${esc(pr.region_name)}</span></div>
    <div class="kv"><span class="k">Partai</span><span class="v">${pr.party ? esc(pr.party.name) + ' [' + esc(pr.party.tag) + ']' : '—'}</span></div>
    <div class="kv"><span class="k">Bergabung</span><span class="v">${fmtDate(pr.created_at)}</span></div>
    ${pr.bio ? `<p style="margin-top:10px">${esc(pr.bio)}</p>` : ''}
  </div>
  <div class="panel"><h3>📊 ATRIBUT</h3>
    <div class="kv"><span class="k">Kekuatan</span><span class="v">${pr.attr_str}</span></div>
    <div class="kv"><span class="k">Pendidikan</span><span class="v">${pr.attr_edu}</span></div>
    <div class="kv"><span class="k">Ekonomi</span><span class="v">${pr.attr_eco}</span></div>
  </div>
  <div class="panel"><h3>⚔️ CATATAN MEDAN PERANG</h3>
    <div class="kv"><span class="k">Total kerusakan</span><span class="v">${fmt(pr.total_damage)}</span></div>
    <div class="kv"><span class="k">Serangan</span><span class="v">${pr.attacks}</span></div>
    <div class="kv"><span class="k">Serangan garis depan</span><span class="v">${pr.frontline_attacks}</span></div>
  </div>
  <div class="panel"><h3>💼 CATATAN KERJA</h3>
    <div class="kv"><span class="k">Shift dikerjakan</span><span class="v">${pr.shifts}</span></div>
    <div class="kv"><span class="k">Total gaji</span><span class="v">${fmtUSD(pr.total_salary)} USD</span></div>
    <div class="kv"><span class="k">Perusahaan dikelola</span><span class="v">${pr.companies.length}</span></div>
  </div>
  ${pr.companies.length ? `<div class="panel"><h3>🏭 PERUSAHAAN</h3>${pr.companies.map((c) => `<div class="kv"><span class="k">${esc(c.name)}</span><span class="v">${esc(c.type)}</span></div>`).join('')}</div>` : ''}
  ${pr.articles.length ? `<div class="panel"><h3>📰 ARTIKEL TERBARU</h3>${pr.articles.map((a) => `<div class="kv"><span class="k">${esc(a.title)}</span><span class="v small muted">${fmtDate(a.created_at)}</span></div>`).join('')}</div>` : ''}
  ${pr.username === ME.citizen.username ? `<button class="btn-ghost" onclick="location.hash='#/settings'">✏️ Edit Profil</button>` : ''}`);
};

// ---------- PENGATURAN ----------
ROUTES.settings = async () => {
  const c = ME.citizen;
  $('#page').innerHTML = page('PENGATURAN', '', `
  <div class="panel"><h3>📝 IDENTITAS</h3>
    <label>BIOGRAFI (maks 1000 karakter)<textarea id="set-bio" rows="3">${esc(c.bio || '')}</textarea></label>
    <button class="btn-gold" id="btn-save-bio">Simpan Biografi</button>
  </div>
  <div class="panel"><h3>✏️ GANTI NAMA WARGA</h3>
    <p class="muted small">Biaya 50 emas. Nama 3–24 karakter (huruf, angka, underscore).</p>
    <div class="row"><input id="set-name" placeholder="Nama baru" style="flex:2"><button class="btn-gold" id="btn-rename">Ganti (50 emas)</button></div>
  </div>
  <div class="panel"><h3>👤 AKUN</h3>
    <div class="kv"><span class="k">Email</span><span class="v">${esc(c.email)}</span></div>
    <div class="kv"><span class="k">Nama warga</span><span class="v">${esc(c.username)}</span></div>
    <div class="kv"><span class="k">Premium</span><span class="v">${c.isPremium ? 'Aktif sampai ' + fmtDate(c.premium_until) : 'Tidak aktif'}</span></div>
    <button class="btn-danger" id="btn-logout" style="margin-top:12px">KELUAR</button>
  </div>`);
  $('#btn-save-bio').onclick = async () => {
    try { await post('/api/profile/bio', { bio: $('#set-bio').value }); toast('Biografi disimpan.'); }
    catch (e) { toast(e.message); }
  };
  $('#btn-rename').onclick = async () => {
    try { await post('/api/profile/rename', { name: $('#set-name').value.trim() }); toast('Nama berhasil diganti.'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  };
  $('#btn-logout').onclick = logout;
};

boot();

// ---------- PASAR ----------
function marketPage(scope) {
  return async () => {
    const data = await api('/api/market?scope=' + scope);
    const cur = scope === 'global' ? 'emas' : 'USD';
    $('#page').innerHTML = page(scope === 'global' ? 'PASAR GLOBAL' : 'PASAR',
      scope === 'global' ? 'Perdagangan antarnegara dalam EMAS · pajak impor 2%' : 'Republik Indonesia — barang diperdagangkan dalam USD', `
    <div class="stat-grid">
      <div class="stat-cell"><div class="stat-label">📋 Penawaran Terbuka</div><div class="stat-num">${fmt(data.stats.offers)}</div><div class="stat-sub">di 15 komoditas</div></div>
      <div class="stat-cell"><div class="stat-label">📈 Transaksi · 24J</div><div class="stat-num">${fmt(data.stats.tx)}</div><div class="stat-sub">${fmt(data.stats.units)} unit berpindah tangan</div></div>
      <div class="stat-cell"><div class="stat-label">💰 Omzet · 24J</div><div class="stat-num gold">${fmt(data.stats.turnover)}</div><div class="stat-sub">${cur}</div></div>
      <div class="stat-cell"><div class="stat-label">🏆 Paling Laris</div><div class="stat-num gold" style="font-size:24px">${data.recentTx[0] ? esc(data.recentTx[0].commodity_name) : '—'}</div><div class="stat-sub">transaksi terakhir</div></div>
    </div>
    <div class="tabs">
      <button class="tab ${scope === 'local' ? 'active' : ''}" onclick="location.hash='#/market'">Pasar Lokal</button>
      <button class="tab ${scope === 'global' ? 'active' : ''}" onclick="location.hash='#/global'">Pasar Global</button>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>📊 PAPAN PASAR — SEMUA KOMODITAS</h3></div>
      <table class="table"><tr><th>Komoditas</th><th>Harga Terbaik</th><th>Penawaran</th><th></th></tr>
      ${data.commodities.map((c) => `<tr>
        <td><b>${esc(c.name)}</b><br><small class="muted">${esc(c.category)}</small></td>
        <td class="gold-text"><b>${c.best != null ? fmt(c.best, 2) : '—'}</b></td>
        <td>${c.offers}</td>
        <td><button class="btn-gold btn-sm" data-com="${c.id}">Lihat</button></td></tr>`).join('')}
      </table>
    </div>
    <div class="panel" id="offer-detail"><h3>📋 PENAWARAN</h3><p class="muted">Pilih komoditas di atas untuk melihat penawaran.</p></div>
    <div class="panel"><h3>💰 JUAL BARANG</h3>
      <label>KOMODITAS<select id="sell-com">${data.commodities.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <div class="row">
        <label>TINGKAT<select id="sell-tier"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select></label>
        <label>JUMLAH (min 10)<input id="sell-qty" type="number" value="10" min="10"></label>
        <label>HARGA / UNIT (${cur})<input id="sell-price" type="number" step="0.01" placeholder="cth: 10.80"></label>
      </div>
      <p class="muted small">Pajak penghasilan 2% dipotong saat barang terjual. Contoh: jual 10,00 → diterima 9,80.</p>
      <button class="btn-gold" id="btn-sell">PAJANG PENAWARAN</button>
    </div>
    <div class="panel"><h3>🧾 PENAWARANKU</h3>
      ${data.mine.length ? data.mine.map((o) => `<div class="kv"><span class="k">${esc(o.commodity_name)} T${o.tier} ×${o.qty} · ${fmt(o.price, 2)} ${cur}</span>
        <span class="v"><button class="btn-danger btn-sm" data-cancel="${o.id}">Batalkan</button></span></div>`).join('')
        : '<p class="muted">Belum ada penawaran aktif.</p>'}
    </div>
    <div class="panel"><h3>🕒 TRANSAKSI TERAKHIR</h3>
      ${data.recentTx.length ? data.recentTx.map((t) => `<div class="kv"><span class="k">${esc(t.commodity_name)} T${t.tier} ×${t.qty}</span><span class="v">${fmt(t.total, 2)} ${cur} · ${ago(t.created_at)}</span></div>`).join('')
        : '<p class="muted">Belum ada transaksi.</p>'}
    </div>`);
    $$('[data-com]').forEach((b) => b.onclick = async () => {
      const cid = Number(b.dataset.com);
      const offers = data.offers.filter((o) => o.commodity_id === cid);
      const com = data.commodities.find((c) => c.id === cid);
      $('#offer-detail').innerHTML = `<h3>📋 ${esc(com.name)} — PENAWARAN</h3>` + (offers.length ? offers.map((o) => `
        <div class="kv"><span class="k">🧑 ${esc(o.seller)} · T${o.tier} ×${o.qty}<br><small class="muted">${fmt(o.price, 2)} ${cur}/unit</small></span>
        <span class="v"><input type="number" value="1" min="1" max="${o.qty}" style="width:70px" id="q-${o.id}">
        <button class="btn-gold btn-sm" data-buy="${o.id}">BELI</button></span></div>`).join('')
        : '<p class="muted">Belum ada penawaran untuk komoditas ini.</p>');
      $$('[data-buy]').forEach((bb) => bb.onclick = async () => {
        const qty = Number($('#q-' + bb.dataset.buy)?.value || 1);
        try { const r = await post('/api/market/buy', { offer_id: Number(bb.dataset.buy), qty });
          toast(`Membeli ${qty}× ${com.name} seharga ${fmt(r.total, 2)} ${r.currency === 'gold' ? 'emas' : 'USD'}.`);
          await refreshMe(); route(); }
        catch (e) { toast(e.message); }
      });
    });
    $('#btn-sell').onclick = async () => {
      try {
        await post('/api/market/sell', { scope, commodity_id: Number($('#sell-com').value), tier: Number($('#sell-tier').value), qty: Number($('#sell-qty').value), price: Number($('#sell-price').value) });
        toast('Penawaran dipajang di pasar.');
        await refreshMe(); route();
      } catch (e) { toast(e.message); }
    };
    $$('[data-cancel]').forEach((b) => b.onclick = async () => {
      try { await post('/api/market/cancel', { offer_id: Number(b.dataset.cancel) }); toast('Penawaran dibatalkan, barang kembali ke inventaris.'); route(); }
      catch (e) { toast(e.message); }
    });
  };
}
ROUTES.market = marketPage('local');
ROUTES.global = marketPage('global');

// ---------- VALAS ----------
ROUTES.fx = async () => {
  const fx = await api('/api/fx');
  const chart = fx.history.length ? fx.history : [];
  const maxP = Math.max(...chart.map((h) => h.price), 25);
  const minP = Math.min(...chart.map((h) => h.price), 19);
  const points = chart.map((h, i) => {
    const x = chart.length === 1 ? 50 : (i / (chart.length - 1)) * 100;
    const y = 100 - ((h.price - minP) / (maxP - minP || 1)) * 100;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  $('#page').innerHTML = page('VALAS — USD ⇄ EMAS', 'Perdagangkan emas terhadap dolar. Valas tidak dipungut pajak.', `
  <div class="stat-grid">
    <div class="stat-cell"><div class="stat-label">⬇️ Jual Terbaik</div><div class="stat-num gold">${fx.bestSell != null ? fmt(fx.bestSell, 2) : '—'}</div><div class="stat-sub">${fx.sellCount} penawaran menjual emas</div></div>
    <div class="stat-cell"><div class="stat-label">⬆️ Beli Terbaik</div><div class="stat-num" style="color:var(--teal)">${fx.bestBuy != null ? fmt(fx.bestBuy, 2) : '—'}</div><div class="stat-sub">${fx.buyCount} penawaran membeli emas</div></div>
    <div class="stat-cell"><div class="stat-label">⚖️ Selisih</div><div class="stat-num">${fx.spread != null ? fmt(fx.spread, 2) : '—'}</div><div class="stat-sub">dari kurs tengah</div></div>
    <div class="stat-cell"><div class="stat-label">💎 Kurs Cetak</div><div class="stat-num">10.00</div><div class="stat-sub">Patokan: 1 emas = 10 USD</div></div>
  </div>
  <div class="panel"><h3>📈 PENJUALAN EMAS — VWAP</h3>
    ${chart.length ? `<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:140px;background:#0a0f1c;border-radius:8px">
      <polyline points="${points}" fill="none" stroke="#d9a441" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>
      <p class="muted small">Terakhir ${fmt(chart[chart.length - 1].price, 2)} USD/emas · ${chart.length} transaksi tercatat</p>`
      : '<p class="muted">Belum ada perdagangan emas. Grafik muncul setelah ada transaksi.</p>'}
    <p class="muted small" style="margin-top:8px">Harga pasar emas adalah 10 USD — jangan beli emas di atas 10,00, karena pemerintah mencetak emas resmi dengan harga itu. Perdagangan pemain bersifat sukarela dan berisiko.</p>
  </div>
  <div class="panel"><h3>🏛️ CETAK USD</h3>
    <p class="muted small">Tukar emasmu menjadi USD dengan kurs resmi 1 emas = 10 USD.</p>
    <div class="row"><input id="mint-gold" type="number" value="1" min="1" placeholder="Jumlah emas"><button class="btn-gold" id="btn-mint">CETAK</button></div>
  </div>
  <div class="panel"><h3>📝 PASANG PENAWARAN EMAS</h3>
    <p class="muted small">Berlaku 72 jam. 1 penawaran terbuka per arah. Dana dikunci sampai penawaran diambil/dibatalkan.</p>
    <div class="row">
      <label>ARAH<select id="fx-dir"><option value="sell">Jual Emas (terima USD)</option><option value="buy">Beli Emas (bayar USD)</option></select></label>
      <label>HARGA / EMAS (USD)<input id="fx-price" type="number" step="0.01" placeholder="cth: 20.70"></label>
      <label>JUMLAH EMAS<input id="fx-qty" type="number" step="0.01" placeholder="cth: 10"></label>
    </div>
    <button class="btn-gold" id="btn-fx-offer">PASANG PENAWARAN</button>
  </div>
  <div class="panel"><h3>📋 PENAWARAN JUAL EMAS</h3>
    ${fx.sells.length ? fx.sells.map((o) => `<div class="kv"><span class="k">${esc(o.citizen_name)} · ${fmt(o.price, 2)} USD/emas · sisa ${fmt(o.qty_gold - o.qty_filled, 2)} emas</span>
      <span class="v"><input type="number" step="0.01" value="1" min="0.01" style="width:70px" id="fq-${o.id}"><button class="btn-gold btn-sm" data-take="${o.id}">AMBIL</button></span></div>`).join('')
      : '<p class="muted">Tidak ada penawaran jual.</p>'}
  </div>
  <div class="panel"><h3>📋 PENAWARAN BELI EMAS</h3>
    ${fx.buys.length ? fx.buys.map((o) => `<div class="kv"><span class="k">${esc(o.citizen_name)} · ${fmt(o.price, 2)} USD/emas · sisa ${fmt(o.qty_gold - o.qty_filled, 2)} emas</span>
      <span class="v"><input type="number" step="0.01" value="1" min="0.01" style="width:70px" id="fq-${o.id}"><button class="btn-gold btn-sm" data-take="${o.id}">JUAL KE DIA</button></span></div>`).join('')
      : '<p class="muted">Tidak ada penawaran beli.</p>'}
  </div>
  ${fx.mine.length ? `<div class="panel"><h3>🧾 PENAWARANKU</h3>${fx.mine.map((o) => `<div class="kv"><span class="k">${o.direction === 'sell' ? 'Jual' : 'Beli'} · ${fmt(o.price, 2)} USD · ${fmt(o.qty_gold - o.qty_filled, 2)}/${fmt(o.qty_gold, 2)} emas</span>
    <span class="v"><button class="btn-danger btn-sm" data-fx-cancel="${o.id}">Batalkan</button></span></div>`).join('')}</div>` : ''}`);
  $('#btn-mint').onclick = async () => {
    try { const r = await post('/api/fx/mint', { gold: Number($('#mint-gold').value) }); toast(`Dicetak ${fmtUSD(r.usd)} USD.`); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  };
  $('#btn-fx-offer').onclick = async () => {
    try { await post('/api/fx/offer', { direction: $('#fx-dir').value, price: Number($('#fx-price').value), qty_gold: Number($('#fx-qty').value) }); toast('Penawaran valas dipasang (72 jam).'); route(); }
    catch (e) { toast(e.message); }
  };
  $$('[data-take]').forEach((b) => b.onclick = async () => {
    try { const r = await post('/api/fx/take', { offer_id: Number(b.dataset.take), qty: Number($('#fq-' + b.dataset.take).value) });
      toast(`Transaksi valas selesai: ${fmt(r.gold, 2)} emas / ${fmtUSD(r.usd)} USD.`); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-fx-cancel]').forEach((b) => b.onclick = async () => {
    try { await post('/api/fx/cancel', { offer_id: Number(b.dataset.fxCancel) }); toast('Penawaran dibatalkan, dana dikembalikan.'); route(); }
    catch (e) { toast(e.message); }
  });
};

// ---------- PEKERJAAN ----------
ROUTES.jobs = async () => {
  const data = await api('/api/jobs');
  const myJob = ME.job;
  $('#page').innerHTML = page('KANTOR KETENAGAKERJAAN', 'Lowongan resmi ADMIN tersedia sebagai modal awal. Perusahaan warga juga bisa membuka lowongan.', `
  <div class="stat-grid">
    <div class="stat-cell"><div class="stat-label">📋 Lowongan Terbuka</div><div class="stat-num">${fmt(data.jobs.length)}</div><div class="stat-sub">di seluruh negeri</div></div>
    <div class="stat-cell"><div class="stat-label">💺 Kursi Kosong</div><div class="stat-num">${fmt(data.stats.seats || 0)}</div><div class="stat-sub">siap diisi</div></div>
    <div class="stat-cell"><div class="stat-label">💰 Gaji Terbaik</div><div class="stat-num gold">${fmt(data.stats.best || 0)}</div><div class="stat-sub">USD / shift</div></div>
    <div class="stat-cell"><div class="stat-label">🧑‍💼 Posisi Saat Ini</div><div class="stat-num" style="font-size:20px">${myJob ? esc(myJob.title) : 'Belum bekerja'}</div><div class="stat-sub">${myJob ? esc(myJob.company_name || 'ADMIN') : 'Lamar lowongan di bawah'}</div></div>
  </div>
  ${myJob ? `<div class="panel"><h3>💼 PEKERJAANMU</h3>
    <div class="kv"><span class="k">${esc(myJob.title)} · ${esc(myJob.company_name || 'ADMIN')}</span><span class="v">${fmt(myJob.salary)} USD/shift</span></div>
    <p class="muted small">Satu giliran memakai 100 energi. Gaji dipotong pajak penghasilan 2%.</p>
    <div class="row"><button class="btn-gold" id="btn-shift">KERJAKAN SATU GILIRAN (100 ⚡)</button>
    <button class="btn-ghost" id="btn-quit">Berhenti Kerja</button></div></div>` : ''}
  <div class="panel"><h3>📋 PAPAN LOWONGAN</h3>
    ${data.jobs.length ? data.jobs.map((j) => `
      <div class="card">
        <h4>${esc(j.title)} ${j.is_admin ? '<span class="chip">ADMIN</span>' : ''}</h4>
        <p class="muted small">${esc(j.company_name || 'Pemerintah')} · ${esc(j.region_name)} · Level ${j.level_min}+ · ${j.workers}/${j.seats} kursi</p>
        <p class="small">${esc(j.description || '')}</p>
        <div class="kv"><span class="k">${j.salary_type === 'share' ? 'Bagi hasil' : 'Gaji tetap'}</span><span class="v gold-text">${fmt(j.salary)} USD / shift</span></div>
        <button class="btn-gold btn-sm" data-apply="${j.id}" ${ME.citizen.job_id === j.id ? 'disabled' : ''}>${ME.citizen.job_id === j.id ? '✓ Pekerjaanmu' : 'LAMAR'}</button>
      </div>`).join('') : emptyState('💼', 'Belum ada lowongan', 'Lowongan ADMIN dan perusahaan warga akan muncul di sini.')}
  </div>`);
  $('#btn-shift')?.addEventListener('click', async () => {
    try { const r = await post('/api/jobs/shift');
      toast(r.goods ? `Shift selesai! ${r.note}` : `Shift selesai! Gaji bersih ${fmtUSD(r.net)} USD (pajak ${fmtUSD(r.tax)}).`);
      await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
  $('#btn-quit')?.addEventListener('click', async () => {
    try { await post('/api/jobs/quit'); toast('Kamu berhenti bekerja.'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-apply]').forEach((b) => b.onclick = async () => {
    try { await post('/api/jobs/apply', { job_id: Number(b.dataset.apply) }); toast('Lamaran diterima! Kamu resmi bekerja.'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
};

// ---------- PERUSAHAAN ----------
ROUTES.companies = async () => {
  const data = await api('/api/companies');
  $('#page').innerHTML = page('INDUSTRI', 'Dirikan perusahaan, produksi setiap hari, buka lowongan untuk warga lain.', `
  <div class="panel"><h3>➕ DIRIKAN PERUSAHAAN</h3>
    <div class="grid2">
      ${data.types.map((t) => `
        <div class="card ${''}">
          <h4>${esc(t.name)}</h4>
          <p class="muted small">${esc(t.desc)}</p>
          <p class="price-big gold-text">${fmt(t.cost)} <small style="font-size:14px">emas</small></p>
          <p class="muted small">Di wilayahmu saat ini: ${esc(ME.region?.name || '')}</p>
          <button class="btn-gold btn-sm" data-found="${t.type}">DIRIKAN</button>
        </div>`).join('')}
    </div>
    <div id="found-form"></div>
  </div>
  <div class="panel"><h3>🏭 PERUSAHAANKU</h3>
    ${data.mine.length ? data.mine.map((c) => `
      <div class="card"><h4>${esc(c.name)}</h4>
      <p class="muted small">${esc(c.type)} · ${esc(c.region_name)} · ${c.employees} karyawan${c.resource ? ' · Produksi: ' + esc(c.resource) : ''}</p>
      <div class="row"><input placeholder="Judul lowongan baru" id="job-title-${c.id}"><input placeholder="Gaji USD" type="number" id="job-salary-${c.id}" style="max-width:120px">
      <button class="btn-gold btn-sm" data-newjob="${c.id}">BUKA LOWONGAN</button></div></div>`).join('')
      : '<p class="muted">Kamu belum punya perusahaan.</p>'}
  </div>
  <div class="panel"><h3>🌍 SEMUA PERUSAHAAN</h3>
    ${data.companies.length ? data.companies.map((c) => `
      <div class="kv"><span class="k">${esc(c.name)}<br><small class="muted">${esc(c.owner_name)} · ${esc(c.region_name)} · ${c.employees} karyawan</small></span>
      <span class="v">${esc(c.type)}</span></div>`).join('')
      : '<p class="muted">Belum ada perusahaan. Jadilah yang pertama!</p>'}
  </div>`);
  $$('[data-found]').forEach((b) => b.onclick = () => {
    const t = data.types.find((x) => x.type === b.dataset.found);
    $('#found-form').innerHTML = `
      <div class="card selected" style="margin-top:12px"><h4>${esc(t.name)} — ${fmt(t.cost)} emas</h4>
      <label>NAMA (OPSIONAL)<input id="f-name" placeholder="${esc(t.name)} ${esc(ME.citizen.username)}"></label>
      ${t.type === 'resource' ? `<label>APA YANG DIBUAT<select id="f-resource">${data.resources.map((r) => `<option>${r}</option>`).join('')}</select></label>` : ''}
      <label>TENTANG (OPSIONAL)<input id="f-about" placeholder="Ceritakan perusahaanmu..."></label>
      <button class="btn-gold" id="f-submit">DIRIKAN BARU</button></div>`;
    $('#f-submit').onclick = async () => {
      try {
        await post('/api/companies', { type: t.type, name: $('#f-name').value.trim() || undefined, about: $('#f-about').value.trim(), resource: $('#f-resource')?.value });
        toast('Perusahaan didirikan! Produksi dimulai besok.');
        await refreshMe(); route();
      } catch (e) { toast(e.message); }
    };
  });
  $$('[data-newjob]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.newjob;
    try {
      await post(`/api/companies/${id}/job`, { title: $('#job-title-' + id).value.trim(), salary: Number($('#job-salary-' + id).value), salary_type: 'fixed', seats: 4 });
      toast('Lowongan dibuka.');
      route();
    } catch (e) { toast(e.message); }
  });
};

// ---------- PETA & WILAYAH ----------
ROUTES.map = async () => {
  const data = await api('/api/regions');
  $('#page').innerHTML = page('PETA DUNIA', 'Republik Indonesia — 17 wilayah. Klik wilayah untuk detail dan bepergian.', `
  <div class="panel"><h3>🔍 CARI WILAYAH</h3>
    <input id="region-search" placeholder="Cari wilayah..." oninput="window.__filterRegions(this.value)">
  </div>
  <div id="region-list">
  ${data.regions.map((r) => `
    <div class="card region-card" data-name="${esc(r.name.toLowerCase())}">
      <div class="panel-head"><h4>${esc(r.name)}</h4><span class="chip">${esc(r.type)} · Skor ${r.city_score}/10</span></div>
      <p class="muted small">${r.population} warga · ${r.companies} perusahaan · Pemberontakan ${r.rebellion}/5${r.resource_bonus ? ' · Bonus: ' + esc(r.resource_bonus) : ''}</p>
      <div class="row"><button class="btn-gold btn-sm" onclick="location.hash='#/regions/${r.id}'">Lihat Wilayah</button>
      ${r.id === data.mine ? '<span class="chip teal">📍 KAMU DI SINI</span>' : `<button class="btn-ghost btn-sm" data-travel="${r.id}">Bepergian (1 🎫)</button>`}</div>
    </div>`).join('')}
  </div>`);
  window.__filterRegions = (q) => {
    $$('.region-card').forEach((el) => { el.style.display = el.dataset.name.includes(q.toLowerCase()) ? '' : 'none'; });
  };
  $$('[data-travel]').forEach((b) => b.onclick = async () => {
    try { const r = await post('/api/regions/travel', { region_id: Number(b.dataset.travel) }); toast(`Kamu sekarang di ${r.region}.`); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
};

ROUTES.regions = async (id) => {
  if (id) {
    const d = await api('/api/regions/' + id);
    const r = d.region;
    $('#page').innerHTML = page(esc(r.name).toUpperCase(), `${esc(r.type)} · Republik Indonesia`, `
    <div class="stat-grid">
      <div class="stat-cell"><div class="stat-label">🏙️ Skor Kota</div><div class="stat-num">${r.city_score}<span style="font-size:18px;color:var(--muted)">/10</span></div></div>
      <div class="stat-cell"><div class="stat-label">👥 Warga</div><div class="stat-num">${fmt(r.population)}</div></div>
      <div class="stat-cell"><div class="stat-label">🏭 Perusahaan</div><div class="stat-num">${fmt(r.companies)}</div></div>
      <div class="stat-cell"><div class="stat-label">🔥 Pemberontakan</div><div class="stat-num">${r.rebellion}/5</div><div class="stat-sub">${r.resource_bonus ? 'Bonus: ' + esc(r.resource_bonus) : ''}</div></div>
    </div>
    <div class="panel"><h3>🏙️ KOTA</h3>
      <div class="kv"><span class="k">Kesehatan</span><span class="v">${r.health}/10</span></div>
      <div class="kv"><span class="k">Pendidikan</span><span class="v">${r.education}/10</span></div>
      <div class="kv"><span class="k">Militer</span><span class="v">${r.military}/10</span></div>
      <div class="kv"><span class="k">Industri</span><span class="v">${r.industry}/10</span></div>
      <div class="kv"><span class="k">Listrik</span><span class="v">${r.electricity}/10</span></div>
      <div class="kv"><span class="k">Kapasitas wilayah</span><span class="v">${r.capacity}% ${d.home ? '· Ini wilayah asalmu' : ''}</span></div>
    </div>
    <div class="panel"><h3>⚖️ POLITIK</h3>
      <div class="kv"><span class="k">Pajak penghasilan</span><span class="v">2%</span></div>
      <div class="kv"><span class="k">Pajak produksi</span><span class="v">1%</span></div>
      <div class="kv"><span class="k">Pajak impor / ekspor</span><span class="v">2% / 2%</span></div>
      <div class="kv"><span class="k">Perbatasan</span><span class="v">Terbuka</span></div>
    </div>
    <div class="panel"><h3>✈️ PERJALANAN</h3>
      ${d.mine ? '<p class="muted">Kamu di sini.</p>' : `<button class="btn-gold" id="btn-travel">PINDAH KE SINI (1 🎫)</button>`}
    </div>
    <div class="panel"><h3>🔥 PEMBERONTAKAN</h3>
      <p class="muted small">5 warga berbeda harus mendukung untuk menyulut perang pemberontakan di wilayah ini. Dukunganmu hangus (tidak kembali).</p>
      ${d.war ? `<p>⚔️ Perang aktif: <b>${esc(d.war.name)}</b> — ${fmt(d.war.score_a)} vs ${fmt(d.war.score_d)}</p>
        <button class="btn-gold" onclick="location.hash='#/war/${d.war.id}'">Buka Front Perang</button>`
        : `<p>Dukungan saat ini: <b>${r.rebellion}/5</b></p>
        <button class="btn-gold" id="btn-rebel" ${d.mySupport ? 'disabled' : ''}>${d.mySupport ? '✓ Sudah Mendukung' : 'DUKUNG PEMBERONTAKAN · 50 emas hangus'}</button>`}
    </div>`);
    $('#btn-travel')?.addEventListener('click', async () => {
      try { const res = await post('/api/regions/travel', { region_id: r.id }); toast(`Kamu sekarang di ${res.region}.`); await refreshMe(); route(); }
      catch (e) { toast(e.message); }
    });
    $('#btn-rebel')?.addEventListener('click', async () => {
      try { const res = await post('/api/regions/rebel', { region_id: r.id });
        toast(res.warStarted ? 'PERANG MELETUS! Pemberontakan dimulai!' : `Dukungan tercatat (${res.supporters}/5).`);
        route(); }
      catch (e) { toast(e.message); }
    });
    return;
  }
  return ROUTES.map();
};

// ---------- NEGARA ----------
ROUTES.country = async () => {
  const d = await api('/api/country');
  const c = d.country;
  $('#page').innerHTML = page('REPUBLIK INDONESIA', 'Demokrasi · Konservatisme (+25% pemulihan) · Ibu kota Jakarta', `
  <div class="stat-grid">
    <div class="stat-cell"><div class="stat-label">👥 Warga</div><div class="stat-num">${fmt(d.citizens)}</div></div>
    <div class="stat-cell"><div class="stat-label">🗺️ Wilayah</div><div class="stat-num">${fmt(d.regions)}</div></div>
    <div class="stat-cell"><div class="stat-label">🚩 Partai</div><div class="stat-num">${fmt(d.parties)}</div></div>
    <div class="stat-cell"><div class="stat-label">🏛️ Kursi Parlemen</div><div class="stat-num">${d.seats}<span style="font-size:18px;color:var(--muted)">/60</span></div></div>
  </div>
  <div class="panel"><h3>👑 PEMERINTAHAN</h3>
    <div class="kv"><span class="k">Presiden</span><span class="v">${esc(d.president)}</span></div>
    <div class="kv"><span class="k">Menteri Ekonomi</span><span class="v">${esc(d.ministers.economy)}</span></div>
    <div class="kv"><span class="k">Menteri Luar Negeri</span><span class="v">${esc(d.ministers.foreign)}</span></div>
    <div class="kv"><span class="k">Menteri Dalam Negeri</span><span class="v">${esc(d.ministers.home)}</span></div>
    <div class="kv"><span class="k">Menteri Pertahanan</span><span class="v">${esc(d.ministers.defense)}</span></div>
  </div>
  <div class="panel"><h3>💰 KAS NEGARA</h3>
    <div class="kv"><span class="k">Kas negara</span><span class="v gold-text">${fmt(c.treasury)} emas</span></div>
    <div class="kv"><span class="k">Pajak penghasilan</span><span class="v">${c.tax_income}%</span></div>
    <div class="kv"><span class="k">Pajak produksi</span><span class="v">${c.tax_production}%</span></div>
    <div class="kv"><span class="k">Pajak impor / ekspor</span><span class="v">${c.tax_import}% / ${c.tax_export}%</span></div>
    <p class="muted small">Pajak dikelola parlemen. Gaji menteri 113 emas/hari (dicetak permainan).</p>
  </div>
  <div class="panel"><h3>🔥 PEMBERONTAKAN IBU KOTA</h3>
    <p class="muted small">Dukungan ibu kota: ${d.capitalRebellion}/5 · Dukung: 100 emas hangus.</p>
    <button class="btn-gold btn-sm" onclick="location.hash='#/regions/2'">Buka Jakarta</button>
  </div>
  ${d.wars.length ? `<div class="panel"><h3>⚔️ PERANG AKTIF</h3>${d.wars.map((w) => `<div class="kv"><span class="k">${esc(w.name)}</span><span class="v">${fmt(w.score_a)} vs ${fmt(w.score_d)}</span></div>`).join('')}</div>` : ''}`);
};

// ---------- STATISTIK ----------
ROUTES.stats = async () => {
  const [world, regions, press] = await Promise.all([api('/api/world'), api('/api/regions'), api('/api/press/stats')]);
  const fx = await api('/api/fx');
  $('#page').innerHTML = page('STATISTIK', 'Angka nyata dari dunia — tanpa data palsu.', `
  <div class="stat-grid">
    <div class="stat-cell"><div class="stat-label">👥 Populasi Dunia</div><div class="stat-num">${fmt(world.population)}</div><div class="stat-sub">Hari ${world.day}</div></div>
    <div class="stat-cell"><div class="stat-label">🗺️ Wilayah</div><div class="stat-num">${fmt(world.regions)}</div><div class="stat-sub">1 negara merdeka</div></div>
    <div class="stat-cell"><div class="stat-label">📰 Artikel / 7 hari</div><div class="stat-num">${fmt(press.articles7d)}</div><div class="stat-sub">dari ${fmt(press.journalists7d)} jurnalis</div></div>
    <div class="stat-cell"><div class="stat-label">👁️ Dibaca / 7 hari</div><div class="stat-num">${fmt(press.reads7d)}</div><div class="stat-sub">${fmt(press.reactions7d)} reaksi</div></div>
  </div>
  <div class="panel"><h3>📊 WILAYAH TERPADAT</h3>
    ${[...regions.regions].sort((a, b) => b.population - a.population).slice(0, 8).map((r) => `
      <div class="kv"><span class="k">${esc(r.name)}</span><span class="v">${fmt(r.population)} warga · skor ${r.city_score}/10</span></div>`).join('')}
  </div>
  <div class="panel"><h3>💱 VALAS</h3>
    <div class="kv"><span class="k">Kurs cetak</span><span class="v">1 emas = 10 USD</span></div>
    <div class="kv"><span class="k">Jual terbaik</span><span class="v">${fx.bestSell != null ? fmt(fx.bestSell, 2) : '—'} USD</span></div>
    <div class="kv"><span class="k">Beli terbaik</span><span class="v">${fx.bestBuy != null ? fmt(fx.bestBuy, 2) : '—'} USD</span></div>
    <div class="kv"><span class="k">Transaksi 24 jam</span><span class="v">${fmt(fx.stats.tx)} · ${fmt(fx.stats.volume, 2)} emas</span></div>
  </div>`);
};

// ---------- KONTRAK ----------
ROUTES.contracts = async () => {
  const local = await api('/api/market?scope=local');
  const glob = await api('/api/market?scope=global');
  const all = [...local.recentTx.map((t) => ({ ...t, scope: 'Lokal' })), ...glob.recentTx.map((t) => ({ ...t, scope: 'Global' }))]
    .sort((a, b) => b.created_at - a.created_at);
  $('#page').innerHTML = page('KONTRAK', 'Catatan perdagangan yang sudah terjadi — kontrak dagang antar warga.', `
  <div class="panel"><h3>📜 KONTRAK PERDAGANGAN</h3>
    <p class="muted small">Setiap pembelian di pasar tercatat sebagai kontrak dagang. Kontrak baru dibuat otomatis saat ada transaksi.</p>
    ${all.length ? all.map((t) => `<div class="kv"><span class="k">${esc(t.commodity_name)} T${t.tier} ×${t.qty} <span class="chip">${t.scope}</span></span>
      <span class="v">${fmt(t.total, 2)} ${t.scope === 'Global' ? 'emas' : 'USD'} · ${ago(t.created_at)}</span></div>`).join('')
      : emptyState('📜', 'Belum ada kontrak', 'Pasar masih kosong. Jadilah yang pertama berdagang!')}
  </div>`);
};

// ---------- PARTAI ----------
ROUTES.parties = async () => {
  const data = await api('/api/parties');
  $('#page').innerHTML = page('PARTAI-PARTAI REPUBLIK INDONESIA', 'Bergabunglah dengan salah satu partai — atau dirikan partaimu sendiri dan bawa ke parlemen.', `
  <div class="panel"><h3>🚩 PARTAIMU</h3>
    ${data.mine ? `
      <div class="kv"><span class="k">${esc(data.mine.name)} [${esc(data.mine.tag)}]</span><span class="v">${esc(data.mine.ideology)} · ${data.mine.seats} kursi</span></div>
      <p class="muted small">Ketua: ${esc(data.mine.leader_name)}</p>
      ${data.pending.length ? `<h3 style="margin-top:12px">📥 LAMARAN MASUK</h3>
        ${data.pending.map((p) => `<div class="kv"><span class="k">${esc(p.username)}</span><span class="v"><button class="btn-gold btn-sm" data-approve="${p.citizen_id}">Setujui</button></span></div>`).join('')}` : ''}
      <button class="btn-ghost btn-sm" data-leave="${data.mine.id}" style="margin-top:10px">Keluar dari Partai</button>`
    : `<div class="empty"><div class="big-ico">🚩</div><h3>BELUM PUNYA PARTAI</h3>
      <p class="muted">Bergabunglah dengan salah satu partai di sini — atau dirikan partaimu sendiri dan bawa ke parlemen.</p></div>
      <div class="row"><span class="chip red">Level 10 — kamu level ${ME.citizen.level}</span><span class="chip teal">50 emas — kamu punya ${fmt(ME.citizen.gold)}</span></div>
      <button class="btn-gold big" id="btn-new-party" style="margin-top:12px">+ DIRIKAN PARTAI</button>
      <div id="party-form"></div>`}
  </div>
  <div class="panel"><h3>🗺️ PETA KEKUATAN</h3>
    ${data.parties.length ? data.parties.map((p) => `
      <div class="card"><div class="panel-head"><h4>${esc(p.name)} [${esc(p.tag)}]</h4><span class="chip">${p.seats} kursi</span></div>
      <p class="muted small">Ketua: ${esc(p.leader_name)} · ${esc(p.ideology)} · ${p.members} anggota · ${p.type === 'open' ? 'Terbuka' : p.type === 'application' ? 'Lewat Lamaran' : 'Tertutup'}</p>
      ${!data.mine ? `<button class="btn-gold btn-sm" data-join="${p.id}">${p.type === 'application' ? 'KIRIM LAMARAN' : 'GABUNG'}</button>` : ''}</div>`).join('')
      : '<p class="muted">Belum ada partai. Jadilah pendiri pertama!</p>'}
  </div>
  <div class="panel"><h3>🏛️ POLITIK NEGARA</h3>
    <div class="kv"><span class="k">Rezim</span><span class="v">Demokrasi</span></div>
    <div class="kv"><span class="k">Presiden</span><span class="v">Lihat di halaman Negara</span></div>
    <div class="kv"><span class="k">Parlemen</span><span class="v">60 kursi</span></div>
    <div class="kv"><span class="k">Pemilu</span><span class="v">Lihat di halaman Pemilu</span></div>
  </div>`);
  $('#btn-new-party')?.addEventListener('click', () => {
    $('#party-form').innerHTML = `
      <div class="card selected" style="margin-top:12px"><h4>DIRIKAN PARTAI — Level 10 + 50 emas</h4>
      <label>NAMA PARTAI<input id="p-name" placeholder="cth: Partai Adil"></label>
      <label>SINGKATAN (2–6 huruf kapital)<input id="p-tag" placeholder="cth: ADIL"></label>
      <label>IDEOLOGI<select id="p-ideology"><option>Konservatif</option><option>Progresif</option><option>Sosialis</option></select></label>
      <label>JENIS<select id="p-type"><option value="open">Terbuka — gabung langsung</option><option value="application">Lewat Lamaran</option><option value="closed">Tertutup</option></select></label>
      <button class="btn-gold" id="p-submit">DIRIKAN PARTAI</button></div>`;
    $('#p-submit').onclick = async () => {
      try {
        await post('/api/parties', { name: $('#p-name').value.trim(), tag: $('#p-tag').value.trim().toUpperCase(), ideology: $('#p-ideology').value, type: $('#p-type').value });
        toast('Partai didirikan!'); await refreshMe(); route();
      } catch (e) { toast(e.message); }
    };
  });
  $$('[data-join]').forEach((b) => b.onclick = async () => {
    try { const r = await post(`/api/parties/${b.dataset.join}/join`); toast(r.role === 'pending' ? 'Lamaran dikirim. Menunggu persetujuan ketua.' : 'Kamu resmi bergabung dengan partai!'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-approve]').forEach((b) => b.onclick = async () => {
    try { await post(`/api/parties/${data.mine.id}/approve`, { citizen_id: Number(b.dataset.approve) }); toast('Lamaran disetujui.'); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-leave]').forEach((b) => b.onclick = async () => {
    try { await post(`/api/parties/${b.dataset.leave}/leave`); toast('Kamu keluar dari partai.'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  });
};

// ---------- PARLEMEN ----------
ROUTES.parliament = async () => {
  const d = await api('/api/parliament');
  const seatColors = ['#3b82f6', '#f59e0b', '#ef4444', '#10b981', '#a855f7', '#ec4899', '#14b8a6', '#eab308'];
  const dots = [];
  for (let i = 0; i < d.totalSeats; i++) {
    dots.push(`<span class="seat-dot" style="background:${i < d.filledSeats ? seatColors[i % seatColors.length] : '#26324a'}"></span>`);
  }
  $('#page').innerHTML = page('PARLEMEN', 'Demokrasi · 60 kursi · Mayoritas 31', `
  <div class="tabs">
    <button class="tab active">🏛️ Dewan</button>
    <button class="tab" onclick="location.hash='#/country'">💼 Kabinet</button>
    <button class="tab" onclick="location.hash='#/chat/parliament'">💬 Ruang Sidang</button>
  </div>
  <div class="stat-grid">
    <div class="stat-cell"><div class="stat-label">🏛️ Rezim</div><div class="stat-num" style="font-size:24px">Demokrasi</div></div>
    <div class="stat-cell"><div class="stat-label">👑 Presiden</div><div class="stat-num" style="font-size:20px">Lihat Negara</div></div>
    <div class="stat-cell"><div class="stat-label">💺 Kursi Terisi</div><div class="stat-num gold">${d.filledSeats}<span style="font-size:18px;color:var(--muted)">/60</span></div><div class="stat-sub">${d.filledSeats >= 60 ? 'parlemen penuh' : 'kursi kosong menunggu pemilu'}</div></div>
    <div class="stat-cell"><div class="stat-label">🗳️ Pemilu</div><div class="stat-num" style="font-size:20px">Lihat Pemilu</div></div>
  </div>
  <div class="panel"><h3>🏛️ DEWAN <span class="muted small">${d.filledSeats} dari 60 kursi terisi</span></h3>
    <div class="seat-chart">${dots.join('')}</div>
    <p style="text-align:center" class="gold-text">◆ MAYORITAS ${d.majority}</p>
    <p class="muted small" style="text-align:center">${d.isMp ? 'Kamu anggota parlemen — kamu bisa memilih UU.' : 'Partaimu belum punya kursi. Menangkan pemilu parlemen untuk masuk dewan.'}</p>
  </div>
  <div class="panel"><h3>📜 USULKAN UNDANG-UNDANG</h3>
    <p class="muted small">Butuh Level 5 · biaya notaris 5 emas · voting 7 hari.</p>
    <label>JUDUL UU<input id="law-title" placeholder="cth: Ambang batas parlemen 3%"></label>
    <label>ISI UU<textarea id="law-content" rows="3" placeholder="Tulis isi undang-undang..."></textarea></label>
    <button class="btn-gold" id="btn-law">USULKAN UU</button>
  </div>
  <div class="panel"><h3>🗳️ UU SEDANG DIVOTING &amp; TERBARU</h3>
    ${d.laws.length ? d.laws.map((l) => {
      const total = l.yes + l.abstain + l.no;
      const myVote = d.myVotes[l.id];
      return `<div class="card"><h4>${esc(l.title)}</h4>
      <p class="muted small">Pengusul: ${esc(l.proposer_name)} · ${esc(l.status)} ${l.status === 'voting' ? '· berakhir ' + fmtDate(l.ends_at) : ''}</p>
      <p class="small">${esc(l.content)}</p>
      <div class="kv"><span class="k">Ya ${l.yes} · Abstain ${l.abstain} · Tidak ${l.no}</span><span class="v">${total ? Math.round(l.yes / total * 100) : 0}% Ya</span></div>
      ${l.status === 'voting' ? (myVote ? `<p class="teal-text small">✓ Kamu memilih: ${myVote === 'yes' ? 'Ya' : myVote === 'abstain' ? 'Abstain' : 'Tidak'}</p>`
        : `<div class="row"><button class="btn-gold btn-sm" data-vote="${l.id}|yes">YA</button><button class="btn-ghost btn-sm" data-vote="${l.id}|abstain">ABSTAIN</button><button class="btn-danger btn-sm" data-vote="${l.id}|no">TIDAK</button></div>`) : ''}
      </div>`;
    }).join('') : '<p class="muted">Belum ada undang-undang. Jadilah pengusul pertama!</p>'}
  </div>`);
  $('#btn-law').onclick = async () => {
    try { await post('/api/parliament/law', { title: $('#law-title').value.trim(), content: $('#law-content').value.trim() }); toast('UU diusulkan! Voting dibuka 7 hari.'); route(); }
    catch (e) { toast(e.message); }
  };
  $$('[data-vote]').forEach((b) => b.onclick = async () => {
    const [id, vote] = b.dataset.vote.split('|');
    try { await post('/api/parliament/vote', { law_id: Number(id), vote }); toast('Suaramu tercatat.'); route(); }
    catch (e) { toast(e.message); }
  });
};

// ---------- PEMILU ----------
ROUTES.elections = async () => {
  const d = await api('/api/elections');
  $('#page').innerHTML = page('PEMILU', 'Warga Level 5 yang sudah 3 hari menjadi warga bisa memilih.', `
  <div class="panel"><h3>🇮🇩 NEGARAMU — REPUBLIK INDONESIA</h3>
    <div class="kv"><span class="k">Rezim</span><span class="v"><span class="chip">DEMOKRASI</span></span></div>
    <div class="kv"><span class="k">Warga</span><span class="v">${fmt(ME.population)}</span></div>
    <div class="kv"><span class="k">Hak pilih</span><span class="v ${d.canVote ? 'teal-text' : 'red-text'}">${d.canVote ? 'Kamu bisa memilih ✓' : 'mulai level 5'}</span></div>
    <div class="kv"><span class="k">Parlemen</span><span class="v">60 kursi</span></div>
    <div class="kv"><span class="k">Presiden</span><span class="v">Lihat di halaman Negara</span></div>
  </div>
  ${d.elections.length ? d.elections.map((e) => `
    <div class="panel"><h3>🗳️ PEMILU ${e.type === 'president' ? 'PRESIDEN' : 'PARLEMEN'} — ${esc(e.status.toUpperCase())}</h3>
      <p class="muted small">Dibuka ${fmtDate(e.opens_at)} · Ditutup ${fmtDate(e.closes_at)}${e.winner ? ' · Pemenang: ' + esc(e.winner) : ''}</p>
      ${e.candidates.length ? e.candidates.map((c) => `
        <div class="kv"><span class="k">🧑 ${esc(c.username)} ${c.party_name ? '[' + esc(c.party_tag) + ']' : ''}</span>
        <span class="v">${c.votes} suara ${e.status === 'open' && !e.myVote ? `<button class="btn-gold btn-sm" data-evote="${e.id}|${c.citizen_id}">PILIH</button>` : ''}</span></div>`).join('')
        : '<p class="muted">Belum ada kandidat.</p>'}
      ${e.status === 'open' && e.type === 'president' ? `<button class="btn-ghost btn-sm" data-register="${e.id}">Daftarkan Diriku (Ketua Partai)</button>` : ''}
      ${e.myVote ? '<p class="teal-text small">✓ Kamu sudah memilih di pemilu ini.</p>' : ''}
    </div>`).join('') : emptyState('🗳️', 'Tidak ada pemilu', 'Pemilu presiden berikutnya dijadwalkan otomatis.')}
  `);
  $$('[data-evote]').forEach((b) => b.onclick = async () => {
    const [eid, cid] = b.dataset.evote.split('|');
    try { await post(`/api/elections/${eid}/vote`, { candidate_id: Number(cid) }); toast('Suaramu tercatat!'); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-register]').forEach((b) => b.onclick = async () => {
    try { await post(`/api/elections/${b.dataset.register}/register`); toast('Kamu terdaftar sebagai kandidat presiden!'); route(); }
    catch (e) { toast(e.message); }
  });
};

// ---------- PERANG ----------
ROUTES.war = async (id) => {
  if (id) {
    const d = await api('/api/wars/' + id);
    const w = d.war;
    const total = w.score_a + w.score_d;
    $('#page').innerHTML = page(esc(w.name).toUpperCase(), `Garis depan: ${esc(w.region_name)} · ${w.status === 'active' ? 'Berlangsung' : 'Berakhir'}`, `
    <div class="stat-grid">
      <div class="stat-cell"><div class="stat-label">🔥 Penyerang</div><div class="stat-num">${fmt(w.score_a)}</div><div class="stat-sub">${total ? Math.round(w.score_a / total * 100) : 0}%</div></div>
      <div class="stat-cell"><div class="stat-label">🛡️ Pembela</div><div class="stat-num">${fmt(w.score_d)}</div><div class="stat-sub">${total ? Math.round(w.score_d / total * 100) : 0}%</div></div>
      <div class="stat-cell"><div class="stat-label">⚔️ Serangan</div><div class="stat-num">${fmt(d.totals.attacks)}</div><div class="stat-sub">total kerusakan ${fmt(d.totals.damage)}</div></div>
      <div class="stat-cell"><div class="stat-label">⏰ Berakhir</div><div class="stat-num" style="font-size:20px">${fmtDate(w.ends_at)}</div><div class="stat-sub">${w.status === 'active' ? 'masih berlangsung' : 'pemenang: ' + esc(w.winner)}</div></div>
    </div>
    <div class="panel"><h3>⚔️ KOMANDO SERANGAN</h3>
      ${w.status !== 'active' ? '<p class="muted">Perang sudah berakhir.</p>'
        : !d.atFront ? `<p class="red-text"><b>TIDAK DI GARIS DEPAN</b> — Kamu harus berada di ${esc(w.region_name)} untuk menyerang.</p>
          <button class="btn-gold" onclick="location.hash='#/regions/${w.region_id}'">TERBANG KE SANA →</button>`
        : `<p class="muted small">Energi ${ME.citizen.energy}/100 · Senjata di inventaris dipakai sebagai amunisi (1 senjata per serangan).</p>
          <div class="row">
            <button class="btn-gold" data-attack="attacker|Senjata">SERANG SEBAGAI PENYERANG 🔥</button>
            <button class="btn-ghost" data-attack="defender|Senjata">BELAH SEBAGAI PEMBELA 🛡️</button>
          </div>
          <button class="btn-ghost btn-sm" data-attack="attacker|Drone" style="margin-top:8px">Serang dengan Drone (kerusakan ×1,5)</button>`}
    </div>
    <div class="panel"><h3>🏆 PEJUANG TERATAS</h3>
      ${d.fighters.length ? d.fighters.map((f, i) => `
        <div class="kv"><span class="k">#${i + 1} ${esc(f.username)} ${f.side === 'attacker' ? '🔥' : '🛡️'}</span>
        <span class="v">${fmt(f.damage)} kerusakan · ${f.attacks} serangan</span></div>`).join('')
        : '<p class="muted">Belum ada yang bertempur di front ini.</p>'}
    </div>
    <div class="panel"><h3>📜 UMPAN FRONT</h3>
      ${d.feed.length ? d.feed.map((a) => `<div class="kv"><span class="k">${esc(a.username)} ${a.side === 'attacker' ? '🔥 menyerang' : '🛡️ bertahan'} · ${a.ammo}</span>
        <span class="v">${fmt(a.damage)} dmg · ${ago(a.created_at)}</span></div>`).join('')
        : '<p class="muted">Belum ada serangan.</p>'}
    </div>
    <button class="btn-gold" onclick="location.hash='#/chat/war_${w.id}'">💬 Buka Obrolan Perang</button>`);
    $$('[data-attack]').forEach((b) => b.onclick = async () => {
      const [side, ammo] = b.dataset.attack.split('|');
      try { const r = await post(`/api/wars/${w.id}/attack`, { side, ammo }); toast(`Seranganmu menimbulkan ${r.damage} kerusakan!`); await refreshMe(); route(); }
      catch (e) { toast(e.message); }
    });
    return;
  }
  const data = await api('/api/wars');
  const active = data.wars.filter((w) => w.status === 'active');
  const ended = data.wars.filter((w) => w.status !== 'active');
  $('#page').innerHTML = page('PERANG TANAH AIR', 'Front pemberontakan di wilayah Republik Indonesia.', `
  ${active.length ? active.map((w) => `
    <div class="card"><h4>🔥 ${esc(w.name)}</h4>
    <p class="muted small">${esc(w.region_name)} · ${esc(w.attacker_label)} vs ${esc(w.defender_label)} · berakhir ${fmtDate(w.ends_at)}</p>
    <div class="kv"><span class="k">Skor</span><span class="v">${fmt(w.score_a)} vs ${fmt(w.score_d)}</span></div>
    <button class="btn-gold btn-sm" onclick="location.hash='#/war/${w.id}'">BUKA FRONT</button></div>`).join('')
    : emptyState('🛡️', 'Tidak ada perang aktif', 'Perang dimulai saat 5 warga mendukung pemberontakan di sebuah wilayah (lihat Peta → wilayah → Dukung Pemberontakan).')}
  ${ended.length ? `<div class="panel"><h3>📜 PERANG BERAKHIR</h3>${ended.map((w) => `<div class="kv"><span class="k">${esc(w.name)}</span><span class="v">${fmt(w.score_a)} vs ${fmt(w.score_d)} · ${esc(w.winner)}</span></div>`).join('')}</div>` : ''}`);
};

ROUTES['war-world'] = async () => {
  const data = await api('/api/wars');
  $('#page').innerHTML = page('PERANG DUNIA', 'Front perang di seluruh dunia.', `
  ${data.wars.length ? data.wars.map((w) => `
    <div class="card"><h4>${w.status === 'active' ? '🔥' : '🏳️'} ${esc(w.name)}</h4>
    <p class="muted small">${esc(w.region_name)} · ${fmt(w.score_a)} vs ${fmt(w.score_d)}</p>
    <button class="btn-gold btn-sm" onclick="location.hash='#/war/${w.id}'">BUKA FRONT</button></div>`).join('')
    : emptyState('🌍', 'Belum ada perang dunia', 'Dunia masih damai. Pemberontakan dimulai dari wilayah (Peta).')}`);
};

// ---------- PERS ----------
ROUTES.press = async () => {
  const [stats, list] = await Promise.all([api('/api/press/stats'), api('/api/press/articles?sort=new')]);
  const top = list.articles[0];
  $('#page').innerHTML = page('PERS', 'Berita ditulis warga, untuk warga.', `
  <div class="stat-grid">
    <div class="stat-cell"><div class="stat-label">📰 Artikel · 7H</div><div class="stat-num">${fmt(stats.articles7d)}</div><div class="stat-sub">dari ${fmt(stats.journalists7d)} jurnalis</div></div>
    <div class="stat-cell"><div class="stat-label">👁️ Dibaca · 7H</div><div class="stat-num">${fmt(stats.reads7d)}</div><div class="stat-sub">${fmt(stats.reactions7d)} reaksi</div></div>
    <div class="stat-cell"><div class="stat-label">🏛️ Surat Kabar</div><div class="stat-num">${fmt(stats.newspapers)}</div><div class="stat-sub">terbit minggu ini</div></div>
    <div class="stat-cell"><div class="stat-label">💬 Komentar</div><div class="stat-num">${fmt(stats.comments7d)}</div><div class="stat-sub">dalam 7 hari terakhir</div></div>
  </div>
  <div class="row" style="margin-bottom:12px">
    <button class="btn-gold" onclick="location.hash='#/press/new'">✏️ TULIS ARTIKEL</button>
    <button class="btn-ghost" onclick="location.hash='#/newspaper'">📰 Dirikan Koran (5 emas)</button>
    <button class="btn-ghost" onclick="location.hash='#/press/league'">🏆 Liga Pers</button>
  </div>
  <div class="tabs">
    <button class="tab active">Terbaru</button>
    <button class="tab" data-sort="top_day">Teratas Hari Ini</button>
    <button class="tab" data-sort="top_week">Teratas Minggu Ini</button>
    <button class="tab" data-sort="top_month">Teratas Bulan Ini</button>
  </div>
  ${top ? `
  <div class="card" style="padding:0;overflow:hidden;cursor:pointer" onclick="location.hash='#/press/${top.id}'">
    <div style="background:linear-gradient(135deg,#1a2c4d,#0d1526);padding:26px 16px 14px">
      <span class="chip">🔥 SEDANG RAMAI</span>
      <h3 style="font-size:24px;margin-top:8px">${esc(top.title)}</h3>
      <p class="muted small">📰 ${esc(top.newspaper_name)} · ${fmtDate(top.created_at)}</p>
      <p class="small">👁️ ${fmt(top.views)} &nbsp; 👍 ${top.likes} &nbsp; 👎 ${top.dislikes} &nbsp; 💬 ${top.comments}</p>
    </div>
  </div>` : ''}
  <div class="panel"><h3>🔥 JUGA SEDANG TREN</h3>
    ${list.articles.slice(1).length ? list.articles.slice(1).map((a, i) => `
      <div class="kv" style="cursor:pointer" onclick="location.hash='#/press/${a.id}'"><span class="k"><b style="color:var(--gold)">${i + 2}</b> &nbsp;${esc(a.title)}<br><small class="muted">📰 ${esc(a.newspaper_name)} · ${fmtDate(a.created_at)}</small></span>
      <span class="v small">👁️ ${fmt(a.views)} 👍 ${a.likes}</span></div>`).join('')
      : '<p class="muted">Belum ada artikel. Jadilah jurnalis pertama!</p>'}
  </div>
  <div class="panel"><h3>📰 SEMUA ARTIKEL</h3><div id="all-articles">
    ${list.articles.length ? list.articles.map((a) => `
      <div class="kv" style="cursor:pointer" onclick="location.hash='#/press/${a.id}'"><span class="k">${esc(a.title)}<br><small class="muted">${esc(a.newspaper_name)} · ${esc(a.topic)} · ${fmtDate(a.created_at)}</small></span>
      <span class="v small">👁️ ${fmt(a.views)}</span></div>`).join('') : '<p class="muted">Belum ada artikel.</p>'}
  </div></div>`);
  $$('[data-sort]').forEach((b) => b.onclick = async () => {
    const list2 = await api('/api/press/articles?sort=' + b.dataset.sort);
    $$('.tabs .tab').forEach((t) => t.classList.remove('active'));
    b.classList.add('active');
    $('#all-articles').innerHTML = list2.articles.length ? list2.articles.map((a) => `
      <div class="kv" style="cursor:pointer" onclick="location.hash='#/press/${a.id}'"><span class="k">${esc(a.title)}<br><small class="muted">${esc(a.newspaper_name)} · ${esc(a.topic)} · ${fmtDate(a.created_at)}</small></span>
      <span class="v small">👁️ ${fmt(a.views)} 👍 ${a.likes}</span></div>`).join('') : '<p class="muted">Belum ada artikel.</p>';
  });
};

ROUTES['press/new'] = async () => {
  const mine = await api('/api/press/newspapers/mine');
  $('#page').innerHTML = page('TULIS ARTIKEL', '', `
  ${mine.newspapers.length ? `
  <div class="panel"><h3>✏️ Artikel Baru</h3>
    <label>KORAN<select id="art-paper">${mine.newspapers.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join('')}</select></label>
    <label>TOPIK<select id="art-topic"><option>Perang</option><option>Ekonomi</option><option>Politik</option><option>Diplomasi</option><option>Panduan</option><option>Pengumuman</option></select></label>
    <label>JUDUL<input id="art-title" placeholder="Judul artikel..."></label>
    <label>ISI<textarea id="art-content" rows="10" placeholder="Tulis beritamu di sini..."></textarea></label>
    <button class="btn-gold" id="btn-publish">TERBITKAN</button>
  </div>` : emptyState('📰', 'Kamu belum punya koran', 'Dirikan koran dulu (5 emas) sebelum menulis artikel.')}
  ${!mine.newspapers.length ? `<button class="btn-gold" onclick="location.hash='#/newspaper'">Dirikan Koran (5 emas)</button>` : ''}`);
  $('#btn-publish')?.addEventListener('click', async () => {
    try {
      const r = await post('/api/press/articles', { newspaper_id: Number($('#art-paper').value), title: $('#art-title').value.trim(), content: $('#art-content').value.trim(), topic: $('#art-topic').value });
      toast('Artikel diterbitkan!'); location.hash = '#/press/' + r.articleId;
    } catch (e) { toast(e.message); }
  });
};


// Artikel detail — dipanggil lewat route khusus di bawah (press/:id)
async function renderArticle(id) {
  const d = await api('/api/press/articles/' + id);
  const a = d.article;
  $('#page').innerHTML = page(esc(a.title).toUpperCase(), `📰 ${esc(a.newspaper_name)} · ${fmtDate(a.created_at)} · oleh ${esc(a.author_name)}`, `
  <div class="panel">
    <p style="white-space:pre-wrap">${esc(a.content)}</p>
    <div class="row" style="margin-top:14px">
      <button class="btn-ghost" id="btn-like">👍 Suka (${a.likes})</button>
      <button class="btn-ghost" id="btn-dislike">👎 Tidak Suka (${a.dislikes})</button>
      <button class="btn-ghost" id="btn-share">🔗 Bagikan ke Obrolan</button>
    </div>
    <p class="muted small" style="margin-top:8px">👁️ ${fmt(a.views)} dibaca · ${esc(a.topic)}</p>
  </div>
  <div class="panel"><h3>💬 KOMENTAR (${d.comments.length})</h3>
    ${d.comments.length ? d.comments.map((c) => `<div class="kv"><span class="k"><b>${esc(c.username)}</b><br>${esc(c.content)}</span><span class="v small muted">${ago(c.created_at)}</span></div>`).join('')
      : '<p class="muted">Belum ada komentar.</p>'}
    <div class="row" style="margin-top:10px"><input id="comment-text" placeholder="Tulis komentar..."><button class="btn-gold" id="btn-comment">KIRIM</button></div>
  </div>
  ${d.others.length ? `<div class="panel"><h3>📰 LAINNYA DARI ${esc(a.newspaper_name)}</h3>
    ${d.others.map((o) => `<div class="kv" style="cursor:pointer" onclick="location.hash='#/press/${o.id}'"><span class="k">${esc(o.title)}</span><span class="v small">👁️ ${fmt(o.views)}</span></div>`).join('')}</div>` : ''}`);
  const react = async (reaction) => {
    try { await post(`/api/press/articles/${a.id}/react`, { reaction }); route(); }
    catch (e) { toast(e.message); }
  };
  $('#btn-like').onclick = () => react('like');
  $('#btn-dislike').onclick = () => react('dislike');
  $('#btn-share').onclick = async () => {
    try { await post('/api/chat/global', { content: 'Baca artikel ini: ' + a.title, article_id: a.id }); toast('Artikel dibagikan ke Obrolan Global.'); }
    catch (e) { toast(e.message); }
  };
  $('#btn-comment').onclick = async () => {
    try { await post(`/api/press/articles/${a.id}/comment`, { content: $('#comment-text').value.trim() }); route(); }
    catch (e) { toast(e.message); }
  };
}

// ---------- LIGA PERS ----------
ROUTES['press/league'] = async () => {
  const l = await api('/api/press/league');
  $('#page').innerHTML = page('LIGA PERS', 'Skor = 3 × reaksi bersih + penonton unik. Pemenang mingguan: koran 500 emas, jurnalis 250 emas.', `
  <div class="panel"><h3>🏆 PAPAN ATAS KORAN</h3>
    ${l.papers.length ? l.papers.map((p, i) => `<div class="kv"><span class="k">#${i + 1} ${esc(p.name)}</span><span class="v">${fmt(p.score)} poin</span></div>`).join('')
      : '<p class="muted">Belum ada koran yang berlaga.</p>'}
  </div>
  <div class="panel"><h3>✍️ PAPAN ATAS JURNALIS</h3>
    ${l.journalists.length ? l.journalists.map((j, i) => `<div class="kv"><span class="k">#${i + 1} ${esc(j.username)}</span><span class="v">${fmt(j.score)} poin</span></div>`).join('')
      : '<p class="muted">Belum ada jurnalis yang berlaga.</p>'}
  </div>`);
};

// ---------- DIRIKAN KORAN ----------
ROUTES.newspaper = async () => {
  const mine = await api('/api/press/newspapers/mine');
  $('#page').innerHTML = page('DIRIKAN KORAN', 'Mendirikan koran butuh 5 emas.', `
  <div class="panel"><h3>📰 Koran Baru</h3>
    <label>NAMA KORAN<input id="np-name" placeholder="cth: Kabar Rakyat"></label>
    <button class="btn-gold" id="btn-np">DIRIKAN KORAN (5 emas)</button>
  </div>
  <div class="panel"><h3>📰 KORANKU</h3>
    ${mine.newspapers.length ? mine.newspapers.map((n) => `<div class="kv"><span class="k">${esc(n.name)}</span><span class="v small muted">${fmtDate(n.created_at)}</span></div>`).join('')
      : '<p class="muted">Belum punya koran.</p>'}
  </div>`);
  $('#btn-np').onclick = async () => {
    try { await post('/api/press/newspaper', { name: $('#np-name').value.trim() }); toast('Koran didirikan! Sekarang kamu bisa menulis artikel.'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  };
};

// ---------- CHAT ----------
const CHAT_TABS = [['global', 'GLOBAL'], ['indonesia', 'INDONESIA'], ['negara', 'NEGARA']];
async function renderChatRoom(room) {
  const data = await api('/api/chat/' + room + (chatSince ? '?since=' + chatSince : ''));
  const list = $('#chat-list');
  if (!list) return;
  if (!chatSince) list.innerHTML = '';
  if (!data.messages.length && !chatSince) {
    list.innerHTML = `<div class="empty"><div class="big-ico">💬</div><h3>Belum ada pesan</h3><p class="muted">Jadilah yang pertama menulis di ruangan ini.</p></div>`;
  }
  for (const m of data.messages) {
    const div = document.createElement('div');
    div.className = 'msg';
    div.innerHTML = `
      <div class="msg-avatar">${esc(m.username[0].toUpperCase())}</div>
      <div class="msg-body">
        <div class="msg-head">
          <span class="msg-name ${m.isPremium ? 'premium-name' : ''}">${esc(m.username)}${m.isPremium ? ' ◆' : ''}</span>
          ${m.party_tag ? `<span class="msg-tag">[${esc(m.party_tag)}]</span>` : ''}
          <span class="msg-time">${fmtTime(m.created_at)}</span>
        </div>
        <div class="msg-bubble">${esc(m.content)}
          ${m.article_id ? `<a class="article-preview" href="#/press/${m.article_id}">
            <div class="ap-tag">📰 ARTIKEL</div><div class="ap-title">${esc(m.article_title || 'Artikel')}</div>
            <div class="ap-meta">👍 ${m.article_likes || 0} · 💬 ${m.article_comments || 0} komentar</div></a>` : ''}
        </div>
        <div class="msg-actions">
          <button data-report="${m.id}" type="button">🚩 Laporkan</button>
          <button data-block="${m.citizen_id}" type="button">🚫 Blokir</button>
        </div>
      </div>`;
    list.appendChild(div);
    chatSince = Math.max(chatSince, m.created_at);
  }
  $$('[data-report]').forEach((b) => b.onclick = () => openReport(Number(b.dataset.report)));
  $$('[data-block]').forEach((b) => b.onclick = async () => {
    try { await post('/api/chat/block', { citizen_id: Number(b.dataset.block) }); toast('Warga diblokir. Pesannya tidak akan terlihat lagi.'); route(); }
    catch (e) { toast(e.message); }
  });
  const listEl = $('#chat-list');
  if (listEl) listEl.scrollTop = listEl.scrollHeight;
}

ROUTES.chat = async (sub) => {
  let room = 'global';
  let title = 'OBROLAN GLOBAL';
  let subLabel = 'Kirim pesan ke dunia...';
  if (sub === 'parliament') { room = 'parliament'; title = 'RUANG SIDANG'; subLabel = 'Hanya anggota parlemen, menteri, dan presiden yang bisa menulis.'; }
  else if (sub && sub.startsWith('war_')) {
    room = sub;
    title = 'PERTEMPURAN';
    const warId = sub.slice(4);
    try {
      const w = await api('/api/wars/' + warId);
      subLabel = `GARIS DEPAN: ${w.war.region_name.toUpperCase()} → ${w.war.region_name.toUpperCase()}`;
    } catch { subLabel = 'Obrolan front perang'; }
  }
  $('#page').innerHTML = page('', '', `
  <div class="chat-tabs">
    ${CHAT_TABS.map(([r, label]) => `<button class="tab ${room === r ? 'active' : ''}" onclick="location.hash='#/chat${r === 'global' ? '' : '/' + r}'">${label}</button>`).join('')}
  </div>
  <h2 class="chat-title">${title}${room.startsWith('war_') ? '<span class="chat-live">● LANGSUNG</span>' : ''}</h2>
  <p class="page-sub">${esc(subLabel)}</p>
  <div id="chat-list" style="max-height:55vh;overflow-y:auto"></div>
  <div class="chat-input">
    <input id="chat-text" placeholder="Kirim pesan ke dunia..." maxlength="500" autocomplete="off">
    <button class="btn-gold" id="btn-send">KIRIM</button>
  </div>
  <p class="muted small" style="margin-top:8px">Pesan minimal 3 kata dan jeda 30 detik dihitung untuk misi harian. Chat dimulai kosong — hanya pesan pemain asli.</p>`);
  // Tab ruangan negara/indonesia memakai room yang sama dengan prefix
  if (sub === 'indonesia' || sub === 'negara') { room = sub; }
  const send = async () => {
    const input = $('#chat-text');
    const text = input.value.trim();
    if (!text) return;
    try { await post('/api/chat/' + room, { content: text }); input.value = ''; await renderChatRoom(room); }
    catch (e) { toast(e.message); }
  };
  $('#btn-send').onclick = send;
  $('#chat-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  chatSince = 0;
  await renderChatRoom(room);
  chatTimer = setInterval(() => renderChatRoom(room), 5000);
};

// ---------- PESAN (DM) ----------
ROUTES.messages = async (otherId) => {
  if (otherId) {
    const d = await api('/api/dms/' + otherId);
    const convs = await api('/api/dms');
    const other = convs.conversations.find((c) => c.other_id === Number(otherId));
    $('#page').innerHTML = page('PESAN — ' + esc(other?.other_name || '').toUpperCase(), '', `
    <div id="dm-list" style="max-height:55vh;overflow-y:auto">
      ${d.messages.length ? d.messages.map((m) => `
        <div class="msg"><div class="msg-avatar">${esc(m.from_name[0].toUpperCase())}</div>
        <div class="msg-body"><div class="msg-head"><span class="msg-name">${esc(m.from_name)}</span><span class="msg-time">${fmtTime(m.created_at)}</span></div>
        <div class="msg-bubble">${esc(m.content)}</div></div></div>`).join('')
        : '<p class="muted">Belum ada pesan. Mulai percakapan!</p>'}
    </div>
    <div class="chat-input"><input id="dm-text" placeholder="Tulis pesan..." maxlength="500"><button class="btn-gold" id="btn-dm-send">KIRIM</button></div>
    <button class="btn-ghost btn-sm" onclick="location.hash='#/messages'" style="margin-top:10px">← Semua Percakapan</button>`);
    const send = async () => {
      const v = $('#dm-text').value.trim();
      if (!v) return;
      try { await post('/api/dms/' + otherId, { content: v }); route(); }
      catch (e) { toast(e.message); }
    };
    $('#btn-dm-send').onclick = send;
    $('#dm-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    return;
  }
  const d = await api('/api/dms');
  $('#page').innerHTML = page('PESAN', 'Percakapan pribadi dengan warga lain.', `
  <div class="panel"><h3>✉️ PERCAKAPAN</h3>
    ${d.conversations.length ? d.conversations.map((c) => `
      <div class="kv" style="cursor:pointer" onclick="location.hash='#/messages/${c.other_id}'">
        <span class="k"><b>${esc(c.other_name)}</b>${c.unread ? ` <span class="badge" style="position:static">${c.unread}</span>` : ''}<br><small class="muted">${esc(c.last)}</small></span>
        <span class="v small muted">${ago(c.at)}</span></div>`).join('')
      : emptyState('✉️', 'Belum ada percakapan', 'Kirim pesan ke warga lain dari halaman profil mereka.')}
  </div>`);
};

// ---------- ORGANISASI ----------
ROUTES.orgs = async () => {
  const data = await api('/api/orgs');
  $('#page').innerHTML = page('ORGANISASI', 'Aliansi antar negara dan warga — keamanan atau kerja sama.', `
  <div class="tabs">
    <button class="tab active">SEMUA <span class="chip">${data.organizations.length}</span></button>
    <button class="tab" data-filter="Keamanan">🛡️ KEAMANAN</button>
    <button class="tab" data-filter="Kerja Sama">🤝 KERJA SAMA</button>
  </div>
  <div class="panel"><h3>➕ DIRIKAN ORGANISASI — 100 emas</h3>
    <div class="row">
      <input id="org-name" placeholder="Nama organisasi">
      <input id="org-tag" placeholder="Singkatan (2–6 huruf)" style="max-width:160px">
      <select id="org-type" style="max-width:160px"><option>Kerja Sama</option><option>Keamanan</option></select>
      <button class="btn-gold" id="btn-org">DIRIKAN</button>
    </div>
  </div>
  <div class="panel" id="org-list"><h3>🏛️ SEMUA ORGANISASI</h3>
    ${data.organizations.length ? data.organizations.map((o) => `
      <div class="card"><h4>${esc(o.name)} <span class="chip">${esc(o.tag)}</span></h4>
      <p class="muted small">${o.type === 'Keamanan' ? '🛡️ KEAMANAN' : '🤝 KERJA SAMA'} · Demokratis · 👥 ${o.members} anggota · 👑 ${esc(o.leader_name)}</p>
      ${data.myOrgId === o.id ? '<span class="chip teal">✓ Anggotamu</span> <button class="btn-ghost btn-sm" data-org-leave="' + o.id + '">Keluar</button>'
        : data.myOrgId ? '<span class="muted small">Kamu sudah di organisasi lain.</span>'
        : `<button class="btn-gold btn-sm" data-org-join="${o.id}">GABUNG</button>`}
      </div>`).join('') : emptyState('🤝', 'Belum ada organisasi', 'Dunia masih baru. Dirikan organisasi pertama!')}
  </div>`);
  $('#btn-org').onclick = async () => {
    try { await post('/api/orgs', { name: $('#org-name').value.trim(), tag: $('#org-tag').value.trim().toUpperCase(), type: $('#org-type').value }); toast('Organisasi didirikan!'); await refreshMe(); route(); }
    catch (e) { toast(e.message); }
  };
  $$('[data-org-join]').forEach((b) => b.onclick = async () => {
    try { await post(`/api/orgs/${b.dataset.orgJoin}/join`); toast('Kamu bergabung dengan organisasi.'); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-org-leave]').forEach((b) => b.onclick = async () => {
    try { await post(`/api/orgs/${b.dataset.orgLeave}/leave`); toast('Kamu keluar dari organisasi.'); route(); }
    catch (e) { toast(e.message); }
  });
  $$('[data-filter]').forEach((b) => b.onclick = () => {
    $$('#org-list .card').forEach((card) => {
      card.style.display = card.textContent.includes(b.dataset.filter === 'Keamanan' ? 'KEAMANAN' : 'KERJA SAMA') ? '' : 'none';
    });
    $$('[data-filter]').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
  });
};

// ---------- TOKO ----------
ROUTES.shop = async () => {
  const s = await api('/api/shop');
  const wa = (label) => s.waUrl + '?text=' + encodeURIComponent('Halo, saya mau top-up Parlementer: ' + label);
  $('#page').innerHTML = page('TOKO PERBENDAHARAAN', 'Top-up diproses manual via WhatsApp. Semua paket bisa dihadiahkan.', `
  ${s.packages.map((p) => `
  <div class="panel" style="padding-top:0;overflow:hidden">
    ${p.best ? '<div class="shop-banner">★ PALING DIMINATI</div>' : ''}
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div><h3 style="font-size:24px">${esc(p.name)}</h3><p class="muted" style="font-style:italic">${esc(p.tagline)}</p></div>
      <span class="chip teal">${esc(p.save)}</span>
    </div>
    <div class="kv"><span class="k">💎 Premium ${p.premiumMonths} bulan</span></div>
    <div class="kv"><span class="k">🪙 ${fmt(p.gold)} emas</span></div>
    <p class="price-big">${fmtIDR(p.price)}</p>
    <p><span class="was-price">${fmtIDR(p.was)}</span> <span class="teal-text">hemat ${fmtIDR(p.was - p.price)}</span></p>
    <div class="row"><a class="btn-gold" style="flex:1;text-align:center;text-decoration:none" href="${wa(p.name + ' ' + fmtIDR(p.price))}" target="_blank" rel="noopener">🎁 &nbsp; AMBIL PAKETNYA</a></div>
  </div>`).join('')}
  <div class="panel" style="border-color:#3b2f6b">
    <h3 style="color:#c4b5fd">💎 AULA PARA PATRON — PREMIUM</h3>
    <p>${esc(s.perks)} Setiap paket ditambahkan ke sisa waktumu.</p>
    ${s.premium.map((p) => `
      <div class="card"><div class="panel-head"><h4>${p.months} BULAN</h4><span class="price-big" style="font-size:28px">${fmtIDR(p.price)}</span></div>
      <p class="muted small">${fmtIDR(p.perMonth)}/bulan</p>
      <a class="btn-gold" style="display:block;text-align:center;text-decoration:none" href="${wa('Premium ' + p.months + ' bulan ' + fmtIDR(p.price))}" target="_blank" rel="noopener">AMBIL PREMIUM</a></div>`).join('')}
  </div>`);
};

// ---------- MEJA BANTUAN / KONTAK / BUKU ----------
ROUTES.help = async () => {
  $('#page').innerHTML = page('MEJA BANTUAN', 'Laporkan bug atau sampaikan ide langsung ke pengembang.', `
  <div class="panel"><h3>🎧 Kirim Laporan / Saran</h3>
    <label>JENIS<select id="h-type"><option>Laporan bug</option><option>Saran</option></select></label>
    <label>TOPIK<select id="h-topic"><option>Ekonomi &amp; Pasar</option><option>Perang &amp; Militer</option><option>Politik &amp; Undang-undang</option><option>Peta &amp; Perjalanan</option><option>Akun &amp; Profil</option><option>Banding hukuman</option><option>Antarmuka &amp; Desain</option><option>Hal lain</option></select></label>
    <label>JELASKAN<textarea id="h-details" rows="5" placeholder="Jelaskan bug atau idemu sedetail mungkin..."></textarea></label>
    <button class="btn-gold" id="btn-help">KIRIM</button>
  </div>`);
  $('#btn-help').onclick = async () => {
    try { await post('/api/support', { type: $('#h-type').value, topic: $('#h-topic').value, details: $('#h-details').value.trim() }); toast('Terima kasih! Laporanmu sudah terkirim.'); route(); }
    catch (e) { toast(e.message); }
  };
};

ROUTES.contact = async () => {
  $('#page').innerHTML = page('KONTAK', '', `
  <div class="panel"><h3>📱 TOP-UP &amp; BANTUAN</h3>
    <p>Top-up Premium dan paket emas diproses manual via WhatsApp:</p>
    <p style="margin:12px 0"><a class="btn-gold" style="text-decoration:none" href="https://wa.me/6285220743283" target="_blank" rel="noopener">💬 Chat WhatsApp — 6285220743283</a></p>
    <p class="muted small">Sebutkan nama wargamu dan paket yang diinginkan. Pembayaran dikonfirmasi manual oleh admin.</p>
  </div>
  <div class="panel"><h3>📖 PERATURAN SINGKAT</h3>
    <p class="small">1) Satu akun per orang. 2) Bermain adil — tanpa bot/skrip/makro. 3) Hormati pemain lain. 4) Politik &amp; perang adalah fiksi. 5) Laporkan pelanggaran lewat tombol Laporkan. 6) Pelanggaran bisa berujung hukuman &amp; rekam jejak.</p>
  </div>`);
};

ROUTES.book = async () => {
  $('#page').innerHTML = page('BUKU PANDUAN', 'Cara bermain Parlementer.', `
  <div class="panel"><h3>🎯 ALUR INTI</h3>
    <p>1) Habiskan energi untuk bekerja (shift) atau berperang.<br>
    2) Makan roti + ambil pasokan harian.<br>
    3) Naik level lewat XP dari shift, perang, misi, dan pasokan.<br>
    4) Gabung partai / perusahaan / negara — lalu kuasai dunia.</p></div>
  <div class="panel"><h3>💰 EKONOMI</h3>
    <p>Pasar lokal memakai USD, Pasar Global memakai emas. Pajak penghasilan 2% saat menjual. Valas: 1 emas dicetak jadi 10 USD. Mata uang tidak bisa ditukar langsung — harus lewat emas.</p></div>
  <div class="panel"><h3>🏛️ POLITIK</h3>
    <p>Dirikan partai (Level 10 + 50 emas). Menangkan pemilu parlemen untuk merebut 60 kursi (mayoritas 31). Presiden dipilih warga Level 5+ yang sudah 3 hari menjadi warga.</p></div>
  <div class="panel"><h3>⚔️ PERANG</h3>
    <p>Dukung pemberontakan di wilayah (50 emas; 100 emas untuk ibu kota). 5 pendukung menyulut perang. Serang dari garis depan: harus berada di wilayah perang, butuh 10 energi + 1 senjata.</p></div>
  <div class="panel"><h3>📰 PERS</h3>
    <p>Dirikan koran (5 emas), tulis artikel, kumpulkan pembaca dan reaksi. Skor liga = 3 × reaksi bersih + penonton unik.</p></div>`);
};

// ---------- MODAL LAPOR ----------
let reportMessageId = null;
let reportReason = null;
function openReport(messageId) {
  reportMessageId = messageId;
  reportReason = null;
  $$('#report-reasons button').forEach((b) => b.classList.remove('selected'));
  $('#report-details').value = '';
  $('#report-modal').hidden = false;
}
$$('#report-reasons button').forEach((b) => b.onclick = () => {
  $$('#report-reasons button').forEach((x) => x.classList.remove('selected'));
  b.classList.add('selected');
  reportReason = b.dataset.reason;
});
$('#report-cancel').onclick = () => { $('#report-modal').hidden = true; };
$('#report-submit').onclick = async () => {
  if (!reportReason) { toast('Pilih alasan laporan dulu.'); return; }
  try {
    await post('/api/chat/report', { message_id: reportMessageId, reason: reportReason, details: $('#report-details').value.trim() });
    $('#report-modal').hidden = true;
    toast('Laporan dikirim ke moderator.');
  } catch (e) { toast(e.message); }
};
$('#report-modal').addEventListener('click', (e) => { if (e.target.id === 'report-modal') e.target.hidden = true; });

// ---------- ROUTE KHUSUS: press/:id & chat sub-room ----------
const _route = route;
route = function () {
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [slug, arg] = hash.split('/');
  if (slug === 'press' && arg && !isNaN(Number(arg))) { renderArticle(Number(arg)).catch((e) => { $('#page').innerHTML = `<div class="panel"><p>${esc(e.message)}</p></div>`; }); return; }
  if (slug === 'press' && arg === 'league') { ROUTES['press/league'](); return; }
  if (slug === 'press' && arg === 'new') { ROUTES['press/new'](); return; }
  if (slug === 'chat' && arg && !CHAT_TABS.some(([r]) => r === arg) && arg !== 'parliament' && !arg.startsWith('war_')) { location.hash = '#/chat'; return; }
  _route();
};
