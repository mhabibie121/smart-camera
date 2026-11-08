import { api, $, $$, esc, toast, logout, confirmBox, promptBox } from './common.js';
import { WhepPlayer } from './whep.js';
import {
  PRESETS, MAX_SIDE, layoutDef, layoutParts, makeLayoutId, overlaps,
  tileCount, layoutLabel, clampLayout, layoutIcon,
} from './layouts.js';

const NO_LOC = 'Tanpa lokasi';
const local = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('cctv.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cctv.' + k, JSON.stringify(v)); } catch {} },
};

const state = {
  me: null,
  maxTiles: 36,
  cameras: [],          // kamera yang diizinkan
  camById: new Map(),
  views: [],
  // Ruang kerja: layout + daftar kamera per kotak (bisa lebih dari 1 halaman)
  layout: '16',
  slots: [],            // [cameraId | null]
  page: 0,
  viewId: null,
  selected: 0,          // index kotak terpilih di halaman ini
  maximized: null,      // index slot global yang sedang dibesarkan
};

const STATE_TEXT = {
  connecting: 'Menghubungkan...',
  error: 'Terputus, mencoba lagi...',
  denied: 'Tidak punya akses',
};

// ================= Ruang kerja =================
const perPage = () => tileCount(state.layout);
const pageCount = () => Math.max(1, Math.ceil(lastUsedIndex() / perPage()));
function lastUsedIndex() {
  for (let i = state.slots.length - 1; i >= 0; i--) if (state.slots[i]) return i + 1;
  return 0;
}

function defaultSlots() {
  return state.cameras.map((c) => c.id);
}

// Buang kamera yang (sudah) tidak diizinkan, tanpa menggeser posisi kamera lain
function sanitizeSlots(slots) {
  const seen = new Set();
  return (slots || []).map((id) => {
    if (!state.camById.has(id) || seen.has(id)) return null;
    seen.add(id);
    return id;
  });
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const slots = state.slots.slice(0, lastUsedIndex());
    const s = { layout: state.layout, slots, page: state.page, viewId: state.viewId };
    // Tamu: tampilan terakhir disimpan di browser ini saja
    if (state.me?.guest) return local.set('guestState', s);
    api('PUT', '/api/me/state', s).catch(() => {});
  }, 800);
}

function setLayout(id) {
  const firstIndex = state.page * perPage();
  state.layout = clampLayout(id, state.maxTiles);
  state.page = Math.min(Math.floor(firstIndex / perPage()), pageCount() - 1);
  state.selected = 0;
  state.maximized = null;
  render();
  saveState();
}

function setPage(p) {
  state.page = Math.max(0, Math.min(p, pageCount() - 1));
  state.selected = 0;
  state.maximized = null;
  render();
  saveState();
}

function putCamera(slotIndex, camId) {
  // Kalau kamera sudah ada di kotak lain, tukar posisinya
  const existing = state.slots.indexOf(camId);
  while (state.slots.length <= slotIndex) state.slots.push(null);
  if (existing >= 0 && existing !== slotIndex) state.slots[existing] = state.slots[slotIndex];
  state.slots[slotIndex] = camId;
  markCustom();
  render();
  saveState();
}

function swapSlots(a, b) {
  while (state.slots.length <= Math.max(a, b)) state.slots.push(null);
  [state.slots[a], state.slots[b]] = [state.slots[b], state.slots[a]];
  markCustom();
  render();
  saveState();
}

function clearSlot(i) {
  state.slots[i] = null;
  if (state.maximized === i) state.maximized = null;
  markCustom();
  render();
  saveState();
}

function loadWorkspace({ layout, slots, page = 0, viewId = null }) {
  state.layout = clampLayout(layout || '16', state.maxTiles);
  state.slots = sanitizeSlots(slots);
  state.viewId = viewId;
  state.selected = 0;
  state.maximized = null;
  state.page = Math.min(page, pageCount() - 1);
  render();
  saveState();
}

// Setelah diubah manual, nama view ditandai "(diubah)"
function markCustom() {
  if (state.viewId) $('#viewName').dataset.modified = '1';
  renderViewName();
}

// ================= Player (dipakai ulang saat kotak dipindah) =================
// key "camId:quality" -> { el, player }
let tiles = new Map();

function makeTile(cam, quality) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.draggable = !document.body.classList.contains('monitor-mode');
  el.innerHTML = `<video autoplay muted playsinline></video>
    <div class="label"><span class="dot"></span><span class="name"></span><span class="q"></span></div>
    <button class="close" title="Tutup kamera">✕</button>
    <div class="state">${STATE_TEXT.connecting}</div>`;
  $('.name', el).textContent = cam.name;
  $('.q', el).textContent = quality === 'main' ? 'HD' : '';
  const player = new WhepPlayer($('video', el), quality === 'main' ? cam.main : cam.sub, (s, msg) => {
    el.classList.toggle('playing', s === 'playing');
    $('.state', el).textContent = msg || STATE_TEXT[s] || '';
  });
  player.start();
  return { el, player };
}

function emptyTile() {
  const el = document.createElement('div');
  el.className = 'tile empty';
  el.innerHTML = '<div class="state">Seret kamera ke sini</div>';
  return el;
}

function stopAllTiles() {
  for (const t of tiles.values()) t.player.stop();
  tiles = new Map();
}

// ================= Render grid =================
function render() {
  if (document.hidden) { stopAllTiles(); return; }
  const grid = $('#grid');
  const def = state.maximized !== null ? layoutDef('1') : layoutDef(state.layout);
  grid.style.gridTemplateColumns = `repeat(${def.cols}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${def.rows}, minmax(0, 1fr))`;

  const base = state.page * perPage();
  const indexes = state.maximized !== null
    ? [state.maximized]
    : def.cells.map((_, i) => base + i);

  const old = tiles;
  const next = new Map();
  const children = [];

  indexes.forEach((slotIndex, i) => {
    const cell = def.cells[i];
    const cam = state.camById.get(state.slots[slotIndex]);
    let el;
    if (cam) {
      // Kotak yang dibesarkan atau layout 1 = main stream (HD), lainnya substream
      const quality = state.maximized !== null || def.cells.length === 1 ? 'main' : 'sub';
      const key = `${cam.id}:${quality}`;
      let t = old.get(key);
      if (t) old.delete(key); else t = makeTile(cam, quality);
      next.set(key, t);
      el = t.el;
      $('.label .dot', el).className = `dot ${dotClass(cam)}`;
    } else {
      el = emptyTile();
    }
    el.dataset.slot = slotIndex;
    el.dataset.pos = i;
    el.style.gridColumn = `${cell.c + 1} / span ${cell.w}`;
    el.style.gridRow = `${cell.r + 1} / span ${cell.h}`;
    el.classList.toggle('selected', i === state.selected && state.maximized === null);
    el.classList.toggle('maximized', state.maximized !== null);
    children.push(el);
  });

  for (const t of old.values()) t.player.stop();
  tiles = next;
  grid.replaceChildren(...children);
  // Elemen video yang dipindah perlu diputar ulang
  $$('video', grid).forEach((v) => v.paused && v.srcObject && v.play().catch(() => {}));

  renderToolbar();
  renderTree();
  updatePtz();
}

function renderToolbar() {
  $('#pageInfo').textContent = `${state.page + 1}/${pageCount()}`;
  $('.bottombar .pager').classList.toggle('single', pageCount() <= 1);
  $('#prev').disabled = state.page === 0 || state.maximized !== null;
  $('#next').disabled = state.page >= pageCount() - 1 || state.maximized !== null;
  $('#layouts').innerHTML = PRESETS.filter((p) => tileCount(p) <= state.maxTiles).map((p) => `
    <button data-layout="${p}" class="${p === state.layout ? 'active' : ''}" title="${p} kotak">
      ${layoutIcon(p)}<span>${p}</span></button>`).join('') +
    (PRESETS.includes(state.layout) ? '' :
      `<button class="active" data-layout="${state.layout}" title="Custom">${layoutIcon(state.layout)}<span>${layoutLabel(state.layout)}</span></button>`);
  renderViewName();
}

function renderViewName() {
  const v = state.views.find((x) => x.id === state.viewId);
  const el = $('#viewName');
  el.textContent = v ? `View: ${v.name}${el.dataset.modified ? ' (diubah)' : ''}` : '';
  if (!v) delete el.dataset.modified;
}

const dotClass = (c) => (c.online === true ? 'on' : c.online === false ? 'off' : '');

// ================= Sidebar: pohon kamera =================
function renderTree() {
  const q = $('#search').value.trim().toLowerCase();
  const collapsed = new Set(local.get('collapsed', []));
  const onScreen = new Set();
  const base = state.page * perPage();
  for (let i = 0; i < perPage(); i++) if (state.slots[base + i]) onScreen.add(state.slots[base + i]);

  const byLoc = new Map();
  for (const c of state.cameras) {
    if (q && !c.name.toLowerCase().includes(q) && !(c.location || '').toLowerCase().includes(q)) continue;
    const l = c.location || NO_LOC;
    (byLoc.get(l) || byLoc.set(l, []).get(l)).push(c);
  }

  let html = '';
  for (const [loc, cams] of byLoc) {
    const open = q || !collapsed.has(loc);
    const online = cams.filter((c) => c.online === true).length;
    html += `<div class="folder ${open ? 'open' : ''}" data-loc="${esc(loc)}">
      <div class="folder-head" title="Klik: buka/tutup · Double-click: tampilkan semua kamera di folder ini">
        <span class="caret">▸</span><span class="fname">${esc(loc)}</span>
        <span class="fcount">${online}/${cams.length}</span>
      </div>
      <div class="folder-items">${cams.map((c) => `
        <div class="item ${onScreen.has(c.id) ? 'on-screen' : ''}" draggable="true" data-id="${c.id}"
             title="Seret ke kotak, atau klik untuk memasang di kotak terpilih">
          <span class="dot ${dotClass(c)}"></span><span class="iname">${esc(c.name)}</span>${c.ptz ? '<span class="ptz-tag" title="Kamera PTZ">PTZ</span>' : ''}
        </div>`).join('')}
      </div>
    </div>`;
  }
  $('#camTree').innerHTML = html || '<div class="empty-msg">Tidak ada kamera</div>';
  const online = state.cameras.filter((c) => c.online === true).length;
  $('#count').textContent = `${state.cameras.length} kamera · ${online} online`;
}

$('#camTree').addEventListener('click', (e) => {
  const head = e.target.closest('.folder-head');
  if (head) {
    const loc = head.parentElement.dataset.loc;
    const collapsed = new Set(local.get('collapsed', []));
    collapsed.has(loc) ? collapsed.delete(loc) : collapsed.add(loc);
    local.set('collapsed', [...collapsed]);
    head.parentElement.classList.toggle('open');
    return;
  }
  const item = e.target.closest('.item');
  if (item) {
    const camId = Number(item.dataset.id);
    // Pasang di kotak terpilih; kalau kotak terpilih sudah terisi, cari kotak kosong di halaman ini
    const base = state.page * perPage();
    let target = base + state.selected;
    if (state.slots[target]) {
      for (let i = 0; i < perPage(); i++) if (!state.slots[base + i]) { target = base + i; break; }
    }
    state.maximized = null;
    putCamera(target, camId);
    state.selected = Math.min(target - base + 1, perPage() - 1);
    render();
  }
});

$('#camTree').addEventListener('dblclick', (e) => {
  const head = e.target.closest('.folder-head');
  if (!head) return;
  const loc = head.parentElement.dataset.loc;
  const ids = state.cameras.filter((c) => (c.location || NO_LOC) === loc).map((c) => c.id);
  loadWorkspace({ layout: state.layout, slots: ids });
  toast(`Menampilkan ${ids.length} kamera ${loc}`);
});

$('#camTree').addEventListener('dragstart', (e) => {
  const item = e.target.closest('.item');
  if (!item) return;
  e.dataTransfer.setData('application/x-cam', item.dataset.id);
  e.dataTransfer.effectAllowed = 'copyMove';
});

// ================= Interaksi grid =================
const grid = $('#grid');

grid.addEventListener('click', (e) => {
  if (e.target.closest('.close')) {
    clearSlot(Number(e.target.closest('.tile').dataset.slot));
    return;
  }
  const tile = e.target.closest('.tile');
  if (!tile || state.maximized !== null) return;
  state.selected = Number(tile.dataset.pos);
  $$('.tile', grid).forEach((t) => t.classList.toggle('selected', t === tile));
});

grid.addEventListener('dblclick', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile || tile.classList.contains('empty') || e.target.closest('.close')) return;
  const slot = Number(tile.dataset.slot);
  state.maximized = state.maximized === null ? slot : null;
  render();
});

grid.addEventListener('dragstart', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile || tile.classList.contains('empty') || state.maximized !== null) return e.preventDefault();
  e.dataTransfer.setData('application/x-slot', tile.dataset.slot);
  e.dataTransfer.effectAllowed = 'move';
});

grid.addEventListener('dragover', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile || state.maximized !== null) return;
  e.preventDefault();
  $$('.tile.drop', grid).forEach((t) => t !== tile && t.classList.remove('drop'));
  tile.classList.add('drop');
});

grid.addEventListener('dragleave', (e) => {
  const tile = e.target.closest('.tile');
  if (tile && !tile.contains(e.relatedTarget)) tile.classList.remove('drop');
});

grid.addEventListener('drop', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile) return;
  e.preventDefault();
  tile.classList.remove('drop');
  const target = Number(tile.dataset.slot);
  const cam = e.dataTransfer.getData('application/x-cam');
  const from = e.dataTransfer.getData('application/x-slot');
  state.selected = Number(tile.dataset.pos);
  if (cam) putCamera(target, Number(cam));
  else if (from !== '' && Number(from) !== target) swapSlots(Number(from), target);
});

// ================= Toolbar =================
$('#layouts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-layout]');
  if (b) setLayout(b.dataset.layout);
});
$('#prev').addEventListener('click', () => setPage(state.page - 1));
$('#next').addEventListener('click', () => setPage(state.page + 1));

$('#fillAll').addEventListener('click', () => {
  loadWorkspace({ layout: state.layout, slots: defaultSlots() });
});
$('#clearAll').addEventListener('click', async () => {
  if (!(await confirmBox('Semua kamera di layar akan dikeluarkan dari kotaknya.', { title: 'Kosongkan semua kotak?', ok: 'Kosongkan', danger: true }))) return;
  loadWorkspace({ layout: state.layout, slots: [] });
});

// Layar penuh: grid + toolbar bawah
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('#stage').requestFullscreen?.().catch(() => toast('Browser menolak layar penuh', true));
}
$('#fullscreen').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  $('#fullscreen').classList.toggle('active', !!document.fullscreenElement);
});

// ================= Kontrol PTZ (panel sidebar, seperti SmartPSS) =================
// Mengontrol kamera di kotak terpilih (atau yang sedang dibesarkan).
// Tahan tombol = kamera bergerak, lepas = berhenti.
const ptz = { cam: null, active: null };

function ptzTargetCam() {
  const slot = state.maximized !== null ? state.maximized : state.page * perPage() + state.selected;
  return state.camById.get(state.slots[slot]) || null;
}

function updatePtz() {
  const panel = $('#ptzPanel');
  if (!state.me?.can_ptz || !state.cameras.some((c) => c.ptz)) { panel.hidden = true; return; }
  panel.hidden = false;
  const cam = ptzTargetCam();
  if (ptz.cam && cam?.id !== ptz.cam.id) ptzStop();
  ptz.cam = cam?.ptz ? cam : null;
  panel.classList.toggle('disabled', !ptz.cam);
  $('#ptzCam').textContent = ptz.cam ? ptz.cam.name : '';
  $('#ptzMsg').textContent = ptz.cam ? '' : (cam ? 'Kamera terpilih bukan PTZ' : 'Pilih kotak kamera PTZ');
}

const ptzSpeed = () => Number($('#ptzSpeed').value);
const ptzSend = (cam, body) => api('POST', `/api/ptz/${cam.id}`, { speed: ptzSpeed(), ...body });

function ptzStop() {
  if (!ptz.active) return;
  const { cam, op } = ptz.active;
  ptz.active = null;
  ptzSend(cam, { op, action: 'stop' }).catch(() => {});
  for (const b of document.querySelectorAll('#ptzPanel .pressed')) b.classList.remove('pressed');
}

$('#ptzPanel').addEventListener('pointerdown', (e) => {
  const b = e.target.closest('[data-op]');
  if (!b || !ptz.cam) return;
  e.preventDefault();
  ptzStop();
  ptz.active = { cam: ptz.cam, op: b.dataset.op };
  b.classList.add('pressed');
  try { b.setPointerCapture(e.pointerId); } catch {}
  ptzSend(ptz.cam, { op: b.dataset.op, action: 'start' }).catch((ex) => {
    toast(ex.message, true);
    ptz.active = null;
    b.classList.remove('pressed');
  });
});
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) $('#ptzPanel').addEventListener(ev, ptzStop);
window.addEventListener('blur', ptzStop);

$('#ptzGo').addEventListener('click', () => {
  if (!ptz.cam) return;
  const preset = Number($('#ptzPreset').value) || 1;
  ptzSend(ptz.cam, { op: 'preset', action: 'start', preset })
    .then(() => toast(`${ptz.cam.name}: ke preset ${preset}`)).catch((ex) => toast(ex.message, true));
});
$('#ptzSpeed').value = local.get('ptzSpeed', 4);
$('#ptzSpeed').addEventListener('change', () => local.set('ptzSpeed', ptzSpeed()));
$('#ptzHead').addEventListener('click', () => {
  $('#ptzPanel').classList.toggle('collapsed');
  local.set('ptzCollapsed', $('#ptzPanel').classList.contains('collapsed'));
});
$('#ptzPanel').classList.toggle('collapsed', local.get('ptzCollapsed', false));
// Ganti kotak terpilih = ganti kamera yang dikontrol
$('#grid').addEventListener('click', () => updatePtz());

// ================= Custom layout =================
// Pratinjau grid bisa di-drag untuk menggabungkan kotak (seperti SmartPSS).
// Klik kotak gabungan untuk memisahkannya lagi.
const dlg = { rows: 3, cols: 3, merges: [], drag: null };

function dlgCount() {
  return layoutDef(makeLayoutId(dlg.rows, dlg.cols, dlg.merges)).cells.length;
}

// Perbesar persegi seleksi supaya tidak memotong kotak gabungan yang sudah ada
function expandToMerges(rect) {
  let r = { ...rect }, changed = true;
  while (changed) {
    changed = false;
    for (const m of dlg.merges) {
      if (!overlaps(r, m)) continue;
      const c1 = Math.min(r.c, m.c), r1 = Math.min(r.r, m.r);
      const c2 = Math.max(r.c + r.w, m.c + m.w), r2 = Math.max(r.r + r.h, m.r + m.h);
      if (c1 !== r.c || r1 !== r.r || c2 !== r.c + r.w || r2 !== r.r + r.h) {
        r = { c: c1, r: r1, w: c2 - c1, h: r2 - r1 };
        changed = true;
      }
    }
  }
  return r;
}

function dragRect() {
  const { a, b } = dlg.drag;
  return expandToMerges({
    c: Math.min(a.c, b.c), r: Math.min(a.r, b.r),
    w: Math.abs(a.c - b.c) + 1, h: Math.abs(a.r - b.r) + 1,
  });
}

function renderLayoutDialog() {
  const f = $('#layoutForm');
  const def = layoutDef(makeLayoutId(dlg.rows, dlg.cols, dlg.merges));
  const prev = $('#layoutPreview');
  prev.style.gridTemplateColumns = `repeat(${dlg.cols}, 1fr)`;
  prev.style.gridTemplateRows = `repeat(${dlg.rows}, 1fr)`;
  prev.innerHTML = def.cells.map((x) => `
    <div class="pcell ${x.w > 1 || x.h > 1 ? 'merged' : ''}" data-c="${x.c}" data-r="${x.r}"
      style="grid-column:${x.c + 1} / span ${x.w}; grid-row:${x.r + 1} / span ${x.h}"
      title="${x.w > 1 || x.h > 1 ? 'Klik untuk memisahkan' : 'Seret ke kotak lain untuk menggabungkan'}"></div>`).join('');
  if (dlg.drag) {
    const s = dragRect();
    const sel = document.createElement('div');
    sel.className = 'psel';
    sel.style.gridColumn = `${s.c + 1} / span ${s.w}`;
    sel.style.gridRow = `${s.r + 1} / span ${s.h}`;
    prev.appendChild(sel);
  }
  const n = dlgCount();
  const over = n > state.maxTiles;
  prev.classList.toggle('over', over);
  $('#layoutHint').textContent = over
    ? `${n} kotak melebihi batas akunmu (${state.maxTiles}).`
    : `${n} kotak · batas akunmu ${state.maxTiles} · seret di grid untuk menggabungkan kotak, klik kotak gabungan untuk memisahkan`;
  f.querySelector('button.primary').disabled = over;
  f.rows.value = dlg.rows;
  f.cols.value = dlg.cols;
}

function cellAt(e) {
  const prev = $('#layoutPreview');
  const box = prev.getBoundingClientRect();
  const c = Math.floor(((e.clientX - box.left) / box.width) * dlg.cols);
  const r = Math.floor(((e.clientY - box.top) / box.height) * dlg.rows);
  return { c: Math.max(0, Math.min(dlg.cols - 1, c)), r: Math.max(0, Math.min(dlg.rows - 1, r)) };
}

$('#layoutPreview').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  try { $('#layoutPreview').setPointerCapture(e.pointerId); } catch {}
  const p = cellAt(e);
  dlg.drag = { a: p, b: p, moved: false };
  renderLayoutDialog();
});

$('#layoutPreview').addEventListener('pointermove', (e) => {
  if (!dlg.drag) return;
  const p = cellAt(e);
  if (p.c === dlg.drag.b.c && p.r === dlg.drag.b.r) return;
  dlg.drag.b = p;
  dlg.drag.moved = true;
  renderLayoutDialog();
});

$('#layoutPreview').addEventListener('pointerup', () => {
  if (!dlg.drag) return;
  const rect = dragRect();
  const single = rect.w === 1 && rect.h === 1;
  if (!dlg.drag.moved || single) {
    // Klik: pisahkan gabungan di posisi itu
    const p = dlg.drag.a;
    dlg.merges = dlg.merges.filter((m) => !overlaps(m, { c: p.c, r: p.r, w: 1, h: 1 }));
  } else {
    // Drag: gabungkan area terpilih (gabungan lama di dalamnya dilebur)
    dlg.merges = dlg.merges.filter((m) => !overlaps(m, rect));
    dlg.merges.push(rect);
  }
  dlg.drag = null;
  renderLayoutDialog();
});

$('#layoutPreview').addEventListener('pointercancel', () => { dlg.drag = null; renderLayoutDialog(); });

function setDialogLayout(id) {
  const p = layoutParts(id);
  Object.assign(dlg, { rows: p.rows, cols: p.cols, merges: p.merges, drag: null });
  $$('#presetList [data-layout]').forEach((b) => b.classList.toggle('active', b.dataset.layout === id));
  renderLayoutDialog();
}

$('#customLayout').addEventListener('click', () => {
  $('#presetList').innerHTML = PRESETS.filter((p) => tileCount(p) <= state.maxTiles).map((p) => `
    <button type="button" data-layout="${p}">
      ${layoutIcon(p, 28)}<span>${p}</span></button>`).join('');
  setDialogLayout(state.layout);
  $('#layoutDialog').showModal();
});

$('#layoutForm').addEventListener('input', (e) => {
  if (e.target.name !== 'rows' && e.target.name !== 'cols') return;
  const rows = Math.max(1, Math.min(MAX_SIDE, Number(e.target.form.rows.value) || 1));
  const cols = Math.max(1, Math.min(MAX_SIDE, Number(e.target.form.cols.value) || 1));
  if (rows === dlg.rows && cols === dlg.cols) return;
  dlg.rows = rows;
  dlg.cols = cols;
  // Buang gabungan yang keluar dari grid baru
  dlg.merges = dlg.merges.filter((m) => m.c + m.w <= cols && m.r + m.h <= rows);
  renderLayoutDialog();
});

// Preset di kiri: tampilkan di pratinjau dulu (bisa digabung-gabung lagi), lalu OK
$('#presetList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-layout]');
  if (b) setDialogLayout(b.dataset.layout);
});

$('#layoutForm').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'ok') return;
  if (dlgCount() > state.maxTiles) { e.preventDefault(); return; }
  setLayout(makeLayoutId(dlg.rows, dlg.cols, dlg.merges));
});

// ================= View tersimpan =================
async function loadViews() {
  state.views = await api('GET', '/api/views');
  renderViews();
}

function renderViews() {
  const empty = state.me?.guest
    ? 'Belum ada View yang dibagikan admin.'
    : 'Belum ada. Atur kamera lalu klik "+ Simpan".';
  $('#viewsList').innerHTML = state.views.map((v) => `
    <div class="view-item ${v.id === state.viewId ? 'active' : ''}" data-id="${v.id}"
         title="${v.own ? 'Klik untuk membuka' : `Dibagikan oleh ${esc(v.owner)}. Klik untuk membuka`}">
      ${layoutIcon(v.layout, 14)}<span class="vname">${esc(v.name)}</span>
      ${!v.own && v.shared ? '<span class="vtag">Bersama</span>' : ''}
      ${v.own && state.me?.is_admin ? `<button class="vshare ${v.shared ? 'on' : ''}" data-share="${v.id}"
          title="${v.shared ? 'Dibagikan ke semua user & tampilan tamu. Klik untuk berhenti membagikan' : 'Bagikan ke semua user & tampilan tamu'}">${v.shared ? '● Dibagikan' : '○ Bagikan'}</button>` : ''}
      ${v.own ? `<button class="vdel" data-del="${v.id}" title="Hapus view">✕</button>` : ''}
    </div>`).join('') || `<div class="muted small">${empty}</div>`;
  renderViewName();
}

$('#viewsList').addEventListener('click', async (e) => {
  const share = e.target.dataset.share;
  if (share) {
    const sv = state.views.find((x) => x.id === Number(share));
    try {
      await api('PUT', `/api/views/${share}/share`, { shared: !sv.shared });
      toast(sv.shared ? `View "${sv.name}" tidak dibagikan lagi` : `View "${sv.name}" dibagikan ke semua user & tampilan tamu`);
      await loadViews();
    } catch (ex) { toast(ex.message, true); }
    return;
  }
  const del = e.target.dataset.del;
  if (del) {
    const v = state.views.find((x) => x.id === Number(del));
    if (!(await confirmBox(`View "${v.name}" akan dihapus.`, { title: 'Hapus view?', ok: 'Hapus', danger: true }))) return;
    await api('DELETE', `/api/views/${del}`);
    if (state.viewId === v.id) state.viewId = null;
    await loadViews();
    saveState();
    return;
  }
  const item = e.target.closest('.view-item');
  if (!item) return;
  const v = state.views.find((x) => x.id === Number(item.dataset.id));
  delete $('#viewName').dataset.modified;
  loadWorkspace({ layout: v.layout, slots: v.slots, viewId: v.id });
  renderViews();
});

$('#saveView').addEventListener('click', async () => {
  if (state.me.guest) {
    if (await confirmBox('Menyimpan View butuh login.', { title: 'Masuk dulu', ok: 'Masuk' })) location.href = '/login';
    return;
  }
  const current = state.views.find((x) => x.id === state.viewId && x.own);
  const name = await promptBox('Nama yang sama akan menimpa View lama.', { title: 'Simpan view', value: current?.name || '', placeholder: 'mis. Pantauan dermaga' });
  if (!name?.trim()) return;
  try {
    const r = await api('POST', '/api/views', {
      name, layout: state.layout, slots: state.slots.slice(0, lastUsedIndex()),
    });
    state.viewId = r.id;
    delete $('#viewName').dataset.modified;
    await loadViews();
    saveState();
    toast(`View "${name.trim()}" disimpan`);
  } catch (ex) { toast(ex.message, true); }
});

// ================= Lain-lain =================
let searchTimer;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderTree, 200);
});

$('#toggleSidebar').addEventListener('click', () => {
  local.set('sidebarHidden', $('#sidebar').classList.toggle('hidden'));
});
if (local.get('sidebarHidden', window.innerWidth < 800)) $('#sidebar').classList.add('hidden');

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || $('dialog[open]')) return;
  if (e.key === 'Escape' && state.maximized !== null) { state.maximized = null; render(); }
  else if (e.key === 'ArrowLeft' && state.maximized === null) setPage(state.page - 1);
  else if (e.key === 'ArrowRight' && state.maximized === null) setPage(state.page + 1);
  else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
});

// Tab disembunyikan/diminimize = streaming dijeda, supaya hemat bandwidth
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopAllTiles(); else render();
});

$('#logout').addEventListener('click', logout);
window.addEventListener('pagehide', stopAllTiles);

// ================= Mulai =================
async function loadCameras() {
  state.cameras = await api('GET', '/api/cameras');
  state.camById = new Map(state.cameras.map((c) => [c.id, c]));
}

state.me = await api('GET', '/api/me');
state.maxTiles = state.me.max_tiles || 36;
if (state.me.monitor) {
  // Mode monitor (tamu atau user bertanda monitor): hanya CCTV + playlist.
  // Daftar kamera & tombol disembunyikan lewat CSS. Keluar: Ctrl+Shift+L. Login: buka /login.
  document.body.classList.add('monitor-mode');
  $('#userInfo').textContent = state.me.guest ? '' : state.me.username;
  // Tombol Masuk: tamu langsung ke login; user monitor keluar dulu (ganti akun)
  $('#loginLink').hidden = false;
  $('#loginLink').addEventListener('click', async (e) => {
    if (state.me.guest) return;
    e.preventDefault();
    if (!(await confirmBox(`Akun monitor "${state.me.username}" akan dikeluarkan dari perangkat ini.`, { title: 'Masuk dengan akun lain?', ok: 'Lanjut' }))) return;
    await logout();
  });
  document.addEventListener('keydown', async (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      if (state.me.guest) location.href = '/login';
      else if (await confirmBox('Perangkat ini akan keluar dari akun monitor.', { title: 'Keluar dari tampilan monitor?', ok: 'Keluar', danger: true })) logout();
    }
  });
} else {
  $('#userInfo').textContent = state.me.username + (state.me.group ? ` · ${state.me.group}` : state.me.is_admin ? ' · admin' : '');
}
$('#adminLink').hidden = !state.me.is_admin;
$('#playbackLink').hidden = !state.me.record;

await Promise.all([loadCameras(), loadViews()]);
const saved = state.me.guest ? local.get('guestState', null) : await api('GET', '/api/me/state').catch(() => null);
if (!state.cameras.length) {
  $('#grid').innerHTML = '<div class="empty-msg">Belum ada kamera yang bisa kamu lihat.<br>Hubungi admin untuk minta akses.</div>';
  renderTree();
} else if (saved) {
  loadWorkspace(saved);
} else if (state.views.length) {
  const first = state.views[0];
  loadWorkspace({ layout: first.layout, slots: first.slots, viewId: first.id });
} else {
  loadWorkspace({ layout: clampLayout('16', state.maxTiles), slots: defaultSlots() });
}
renderViews();

// Perbarui status online/offline tiap 60 detik tanpa memutus video
setInterval(async () => {
  try {
    await loadCameras();
    for (const t of $$('.tile[data-slot]', grid)) {
      const cam = state.camById.get(state.slots[Number(t.dataset.slot)]);
      const dot = $('.label .dot', t);
      if (cam && dot) dot.className = `dot ${dotClass(cam)}`;
    }
    renderTree();
  } catch {}
}, 60_000);
