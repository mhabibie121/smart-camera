// Halaman putar ulang rekaman (modul rekaman), mirip SmartPSS:
//  - timeline dengan zoom (24 jam / 6 jam / 1 jam / 15 menit) + geser
//  - daftar rekaman (jam mulai – jam selesai) per hari
//  - ekspor MP4 dari jam X sampai jam Y (dipecah per 1 jam kalau panjang)
//  - lompat ±10 detik / ±1 menit
// Video diambil per potongan (maks 30 menit) lewat /api/playback/get dan otomatis lanjut.
import { api, $, $$, esc, toast, confirmBox, promptBox } from './common.js';

const CHUNK = 1800;       // detik per potongan video yang diputar
const EXPORT_MAX = 3600;  // detik per file ekspor (batas server)
const DAY = 86400_000;
const state = {
  me: null, cams: [], cam: null, quality: 'main', day: null,
  ranges: [], locks: [], clipStart: null,
  span: 86400, viewStart: null, // jendela timeline (detik, Date)
};

const pad = (n) => String(n).padStart(2, '0');
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const fmtFull = (d) => d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'medium' });
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} jam ${m} mnt` : m ? `${m} mnt ${s % 60} dtk` : `${s} dtk`;
};

// ---------- Kamera ----------
function renderCams() {
  const q = $('#pbSearch').value.trim().toLowerCase();
  const list = state.cams.filter((c) => !q || [c.name, c.location].some((v) => (v || '').toLowerCase().includes(q)));
  $('#pbCams').innerHTML = list.map((c) => `
    <div class="pb-cam ${state.cam?.id === c.id ? 'active' : ''}" data-id="${c.id}">
      <span class="iname">${esc(c.name)}</span><span class="muted small">${esc(c.location || '')}</span>
    </div>`).join('') || '<div class="muted small">Belum ada kamera yang punya rekaman dan bisa kamu lihat.</div>';
}

$('#pbCams').addEventListener('click', (e) => {
  const el = e.target.closest('.pb-cam');
  if (!el) return;
  const cam = state.cams.find((c) => c.id === Number(el.dataset.id));
  state.cam = cam;
  state.quality = cam.qualities.includes(state.quality) ? state.quality : cam.qualities[0];
  renderCams();
  loadRanges();
});
$('#pbSearch').addEventListener('input', renderCams);

function renderQuality() {
  const qs = state.cam?.qualities || [];
  $('#pbQuality').innerHTML = qs.length > 1 ? qs.map((q) =>
    `<button data-q="${q}" class="${q === state.quality ? 'active' : ''}">${q === 'main' ? 'Main (HD)' : 'Sub'}</button>`).join('') : '';
}
$('#pbQuality').addEventListener('click', (e) => {
  if (!e.target.dataset.q) return;
  state.quality = e.target.dataset.q;
  loadRanges();
});

// ---------- Tanggal & jendela timeline ----------
function setDay(d, keepView = false) {
  state.day = dayStart(d);
  $('#pbDateText').textContent = state.day.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  if (!$('#pbCal').hidden) renderCal();
  if (!keepView) setView(state.span, state.span >= 86400 ? state.day : new Date(d.getTime() - (state.span * 1000) / 2));
  renderList();
}
// ---------- Kalender (titik = tanggal yang punya rekaman, seperti SmartPSS) ----------
const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
let calMonth = null; // Date: tanggal 1 bulan yang ditampilkan

// Set "YYYY-MM-DD" untuk semua hari yang tersentuh rekaman
function recordedDays() {
  const days = new Set();
  for (const r of state.ranges) {
    for (let d = dayStart(r.start); d < r.end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      days.add(dateInput(d));
    }
  }
  return days;
}

function renderCal() {
  const days = recordedDays();
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  $('#pbCalTitle').textContent = `${MONTHS[m]} ${y}`;
  const first = new Date(y, m, 1);
  const startOffset = (first.getDay() + 6) % 7; // minggu dimulai Senin
  const cells = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'].map((d) => `<span class="pb-cal-dow">${d}</span>`);
  const today = dateInput(new Date()), sel = dateInput(state.day);
  for (let i = 0; i < 42; i++) {
    const d = new Date(y, m, 1 - startOffset + i);
    const key = dateInput(d);
    const cls = ['pb-cal-day', d.getMonth() !== m && 'other', days.has(key) && 'has', key === sel && 'sel', key === today && 'today']
      .filter(Boolean).join(' ');
    cells.push(`<button class="${cls}" data-date="${key}" title="${days.has(key) ? 'Ada rekaman' : 'Tidak ada rekaman'}"><span>${d.getDate()}</span></button>`);
  }
  $('#pbCalGrid').innerHTML = cells.join('');
  const sorted = [...days].sort();
  $('#pbCalInfo').textContent = sorted.length
    ? `● Ada rekaman: ${new Date(sorted[0] + 'T00:00').toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })} – ${new Date(sorted[sorted.length - 1] + 'T00:00').toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })} · ${sorted.length} hari`
    : state.cam ? 'Kamera ini belum punya rekaman.' : 'Pilih kamera dulu.';
}

$('#pbDateBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const cal = $('#pbCal');
  cal.hidden = !cal.hidden;
  if (!cal.hidden) { calMonth = new Date(state.day.getFullYear(), state.day.getMonth(), 1); renderCal(); }
});
$('#pbCalPrev').addEventListener('click', () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1); renderCal(); });
$('#pbCalNext').addEventListener('click', () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1); renderCal(); });
$('#pbCalGrid').addEventListener('click', (e) => {
  const key = e.target.closest('[data-date]')?.dataset.date;
  if (!key) return;
  $('#pbCal').hidden = true;
  setDay(new Date(key + 'T00:00'));
});
$('#pbCal').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => { $('#pbCal').hidden = true; });
$('#pbPrevDay').addEventListener('click', () => setDay(new Date(state.day.getTime() - DAY)));
$('#pbNextDay').addEventListener('click', () => setDay(new Date(state.day.getTime() + DAY)));

// Jendela timeline dibatasi di dalam hari terpilih
function setView(span, start) {
  state.span = span;
  const d0 = state.day.getTime(), max = d0 + DAY - span * 1000;
  state.viewStart = new Date(Math.min(Math.max(start.getTime(), d0), max));
  $$('#pbZoom button').forEach((b) => b.classList.toggle('active', Number(b.dataset.span) === span));
  renderTimeline();
}

function zoomTo(span, center) {
  const c = center || currentTime() || new Date(state.viewStart.getTime() + (state.span * 1000) / 2);
  setView(span, new Date(c.getTime() - (span * 1000) / 2));
}
$('#pbZoom').addEventListener('click', (e) => { if (e.target.dataset.span) zoomTo(Number(e.target.dataset.span)); });
$('#pbPanLeft').addEventListener('click', () => setView(state.span, new Date(state.viewStart.getTime() - (state.span * 1000) / 2)));
$('#pbPanRight').addEventListener('click', () => setView(state.span, new Date(state.viewStart.getTime() + (state.span * 1000) / 2)));
// Scroll di timeline = zoom masuk/keluar di posisi kursor
const SPANS = [86400, 21600, 3600, 900];
$('#pbTimeline').addEventListener('wheel', (e) => {
  e.preventDefault();
  const i = SPANS.indexOf(state.span);
  const next = SPANS[Math.min(SPANS.length - 1, Math.max(0, i + (e.deltaY < 0 ? 1 : -1)))];
  if (next !== state.span) zoomTo(next, timeAt(e));
}, { passive: false });

// ---------- Rentang rekaman ----------
async function loadRanges() {
  if (!state.cam) return;
  $('#pbCamName').textContent = state.cam.name;
  renderQuality();
  try {
    const r = await api('GET', `/api/playback/list?cam=${state.cam.id}&q=${state.quality}`);
    state.ranges = r.ranges.map((x) => {
      // Waktu dari server sampai mikrodetik; Date memotong ke milidetik -> geser 1 md supaya tidak
      // meminta sedikit SEBELUM awal rekaman (server menjawab "tidak ada rekaman").
      const raw = new Date(x.start).getTime();
      return { start: new Date(raw + 1), end: new Date(raw + x.duration * 1000) };
    });
    state.locks = r.locks.map((l) => ({ ...l, start: new Date(l.start_at), end: new Date(l.end_at) }));
  } catch (ex) {
    state.ranges = []; state.locks = [];
    toast(ex.message, true);
  }
  // Belum ada rekaman di hari terpilih -> pindah ke hari rekaman terbaru
  const last = state.ranges[state.ranges.length - 1];
  if (last && !state.ranges.some((r) => r.end > state.day && r.start < new Date(state.day.getTime() + DAY))) setDay(last.end);
  else { renderTimeline(); renderList(); }
  if (!$('#pbCal').hidden) renderCal();
  $('#pbMsg').textContent = state.ranges.length ? 'Klik di timeline atau di daftar rekaman untuk memutar.' : 'Kamera ini belum punya rekaman.';
  $('#pbMsg').hidden = false;
}

// Rekaman pada hari terpilih (dipotong di batas hari)
function dayRanges() {
  const d0 = state.day.getTime(), d1 = d0 + DAY;
  return state.ranges.filter((r) => r.end.getTime() > d0 && r.start.getTime() < d1)
    .map((r) => ({ start: new Date(Math.max(r.start.getTime(), d0)), end: new Date(Math.min(r.end.getTime(), d1)) }));
}

function renderList() {
  if (!state.cam) return;
  const list = dayRanges();
  const total = list.reduce((n, r) => n + (r.end - r.start), 0);
  $('#pbListInfo').textContent = list.length ? `${list.length} bagian · ${fmtDur(total)}` : '';
  $('#pbList').innerHTML = list.map((r, i) => `
    <div class="pb-item" data-i="${i}" title="Klik untuk memutar">
      <span class="pb-item-time">${fmtTime(r.start)} – ${fmtTime(r.end)}</span>
      <span class="muted small">${fmtDur(r.end - r.start)}</span>
    </div>`).join('') || '<div class="muted small">Tidak ada rekaman di tanggal ini.</div>';
  state.listRanges = list;
}
$('#pbList').addEventListener('click', (e) => {
  const el = e.target.closest('.pb-item');
  if (!el) return;
  const r = state.listRanges[Number(el.dataset.i)];
  playAt(r.start);
  // Isi ekspor dengan rentang ini & fokuskan timeline ke situ
  $('#pbExFrom').value = fmtTime(r.start);
  $('#pbExTo').value = fmtTime(r.end);
  updateExportBtn();
  const len = (r.end - r.start) / 1000;
  const span = SPANS.slice().reverse().find((s) => s >= len * 1.2) || 86400;
  setView(span, new Date(r.start.getTime() - ((span * 1000) - (r.end - r.start)) / 2));
});

function renderTimeline() {
  if (!state.viewStart) return;
  const v0 = state.viewStart.getTime(), spanMs = state.span * 1000, v1 = v0 + spanMs;
  const pct = (t) => ((Math.min(Math.max(t, v0), v1) - v0) / spanMs) * 100;
  const bar = (r, cls, title) => {
    if (r.end.getTime() <= v0 || r.start.getTime() >= v1) return '';
    const l = pct(r.start.getTime()), w = Math.max(0.3, pct(r.end.getTime()) - l);
    return `<div class="${cls}" style="left:${l}%;width:${w}%" title="${esc(title)}"></div>`;
  };
  $('#pbRanges').innerHTML =
    state.ranges.map((r) => bar(r, 'pb-r', `${fmtTime(r.start)} – ${fmtTime(r.end)}`)).join('') +
    state.locks.map((l) => bar(l, 'pb-l', `Dikunci ${fmtTime(l.start)} – ${fmtTime(l.end)}${l.note ? ': ' + l.note : ''} (${l.created_by || ''})`)).join('');
  // Label jam menyesuaikan skala
  const step = { 86400: 7200, 21600: 1800, 3600: 300, 900: 60 }[state.span] * 1000;
  const first = Math.ceil(v0 / step) * step;
  const labels = [];
  for (let t = first; t <= v1; t += step) {
    const d = new Date(t);
    labels.push(`<span style="left:${pct(t)}%">${state.span <= 3600 ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : pad(d.getHours())}</span>`);
  }
  $('#pbHours').innerHTML = labels.join('');
  $('#pbWindow').textContent = state.span >= 86400 ? 'satu hari penuh' : `${fmtTime(state.viewStart)} – ${fmtTime(new Date(v1))}`;
  $('#pbPanLeft').disabled = state.span >= 86400 || v0 <= state.day.getTime();
  $('#pbPanRight').disabled = state.span >= 86400 || v1 >= state.day.getTime() + DAY;
  updateMarker();
}

function timeAt(e) {
  const box = $('#pbTimeline').getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
  return new Date(state.viewStart.getTime() + f * state.span * 1000);
}
$('#pbTimeline').addEventListener('mousemove', (e) => {
  const t = timeAt(e), h = $('#pbHover');
  h.hidden = false;
  h.textContent = fmtTime(t);
  h.style.left = `${((t - state.viewStart) / (state.span * 1000)) * 100}%`;
});
$('#pbTimeline').addEventListener('mouseleave', () => { $('#pbHover').hidden = true; });
$('#pbTimeline').addEventListener('click', (e) => playAt(timeAt(e)));

// ---------- Putar ----------
// Rentang yang bisa diputar mulai dari t. Sisa < 1,5 dtk di ujung rentang dianggap habis
// (durasi rentang dari MediaMTX sedikit melebihi data aslinya) -> pakai rentang berikutnya.
const MIN_LEFT = 1500;
function rangeFor(t) {
  return state.ranges.find((r) => t >= r.start && r.end - t >= MIN_LEFT)
    || state.ranges.find((r) => r.start > t && r.end - r.start >= 500); // jatuh di celah -> rekaman berikutnya
}

const v = $('#pbVideo');

function playAt(t) {
  if (!state.cam) return toast('Pilih kamera dulu', true);
  const r = rangeFor(t);
  if (!r) return toast('Tidak ada rekaman setelah waktu ini', true);
  const start = t < r.start ? r.start : t;
  const dur = Math.max(1, Math.min(CHUNK, Math.floor((r.end - start) / 1000)));
  state.clipStart = start;
  state.clipDur = dur;
  state.clipEnd = new Date(start.getTime() + dur * 1000);
  state.advancing = false;
  state.lastProgress = { t: -1, at: Date.now() };
  v.src = `/api/playback/get?cam=${state.cam.id}&q=${state.quality}&start=${encodeURIComponent(start.toISOString())}&duration=${dur}`;
  v.playbackRate = Number($('#pbSpeed .active').dataset.speed);
  v.play().catch(() => {});
  $('#pbMsg').hidden = true;
  $('#pbLock').disabled = false;
  updateExportBtn();
  if (start < state.day || start >= new Date(state.day.getTime() + DAY)) setDay(start);
  else if (start < state.viewStart || start > new Date(state.viewStart.getTime() + state.span * 1000)) zoomTo(state.span, start);
}

const currentTime = () => (state.clipStart ? new Date(state.clipStart.getTime() + v.currentTime * 1000) : null);

function updateMarker() {
  const t = currentTime(), m = $('#pbMarker');
  const v1 = state.viewStart && new Date(state.viewStart.getTime() + state.span * 1000);
  if (!t || !v1 || t < state.viewStart || t >= v1) { m.hidden = true; return; }
  m.hidden = false;
  m.style.left = `${((t - state.viewStart) / (state.span * 1000)) * 100}%`;
}

v.addEventListener('timeupdate', () => {
  const t = currentTime();
  $('#pbClock').textContent = t ? fmtFull(t) : '';
  updateMarker();
  // Zoom kecil: timeline ikut berjalan supaya penanda tetap terlihat
  if (t && state.span < 86400 && t > new Date(state.viewStart.getTime() + state.span * 1000 * 0.9)) zoomTo(state.span, t);
});
// Potongan selesai -> lanjut otomatis (juga melompati celah ke rekaman berikutnya)
// ---- Lanjut otomatis & lompati celah ----
// Bagian rekaman habis -> putar bagian berikutnya. Kalau ada celah, langsung dilewati.
// Tidak bergantung pada event "ended" (sering tidak muncul untuk video yang di-stream).
function goNext() {
  if (state.advancing || !state.clipEnd) return;
  state.advancing = true;
  const after = new Date(state.clipEnd.getTime() + 1);
  const next = rangeFor(after);
  if (!next) {
    v.pause();
    showNote('■ Rekaman habis');
    return;
  }
  const gap = next.start - after;
  if (gap > 1500) showNote(`⏭ Celah ${fmtDur(gap)} dilewati`);
  playAt(after < next.start ? next.start : after);
}

let noteTimer;
function showNote(text) {
  const n = $('#pbNote');
  n.textContent = text;
  n.hidden = false;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { n.hidden = true; }, 2500);
}

v.addEventListener('ended', goNext);
// Hampir di ujung potongan -> lanjut (sedikit lebih awal supaya tidak ada jeda)
v.addEventListener('timeupdate', () => {
  if (state.clipDur && v.currentTime >= state.clipDur - 0.3) goNext();
});
// Penjaga: video tidak maju 4 detik padahal sedang diputar
setInterval(() => {
  if (!state.clipStart || v.paused || state.advancing) return;
  const p = state.lastProgress;
  if (v.currentTime !== p.t) { state.lastProgress = { t: v.currentTime, at: Date.now() }; return; }
  if (Date.now() - p.at < 4000) return;
  state.lastProgress = { t: v.currentTime, at: Date.now() };
  // Di ujung potongan (data bagian ini memang habis) -> bagian berikutnya; di tengah -> sambung ulang di posisi ini
  if (v.currentTime >= state.clipDur - 3) goNext();
  else playAt(new Date(currentTime().getTime() + 1000));
}, 1000);
v.addEventListener('error', () => {
  // Potongan gagal dimuat saat lanjut otomatis (mis. sisa rentang ternyata kosong) -> bagian berikutnya
  if (v.error?.code !== 4 && state.clipEnd && !state.errorSkip) {
    state.errorSkip = true;
    state.advancing = false;
    state.clipEnd = new Date(Math.max(state.clipEnd.getTime(), state.clipStart.getTime() + MIN_LEFT));
    setTimeout(() => { state.errorSkip = false; }, 3000);
    return goNext();
  }
  $('#pbMsg').hidden = false;
  $('#pbMsg').textContent = v.error?.code === 4
    ? 'Video tidak bisa diputar: format tidak didukung browser ini (mis. H.265 di PC lama) atau rekaman di jam ini tidak ada. Coba klik bagian lain di timeline, pakai Chrome/Edge terbaru, atau ekspor lalu buka di VLC.'
    : 'Rekaman gagal dimuat.';
});

$('#pbSpeed').addEventListener('click', (e) => {
  const s = e.target.dataset.speed;
  if (!s) return;
  $$('#pbSpeed button').forEach((b) => b.classList.toggle('active', b === e.target));
  v.playbackRate = Number(s);
});

// Lompat: di dalam potongan yang sudah dimuat cukup geser; di luar itu muat ulang
$('#pbJump').addEventListener('click', (e) => {
  const d = Number(e.target.dataset.jump);
  const t = currentTime();
  if (!d || !t) return;
  const target = v.currentTime + d;
  const loaded = v.seekable.length ? v.seekable.end(v.seekable.length - 1) : 0;
  if (target >= 0 && target <= loaded) v.currentTime = target;
  else playAt(new Date(t.getTime() + d * 1000));
});

// ---------- Ekspor jam X sampai jam Y ----------
// "7:5" / "07:05" / "07:05:30" / "070530" -> "07:05:30" (24 jam); null kalau tidak valid
function parseClock(s) {
  s = String(s || '').trim().replace(/[.\s]/g, ':');
  if (/^\d{4,6}$/.test(s)) s = s.match(/\d{2}/g).join(':');
  const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
  if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] || 0) > 59) return null;
  return `${pad(+m[1])}:${pad(+m[2])}:${pad(+(m[3] || 0))}`;
}
function exportRange() {
  const f = parseClock($('#pbExFrom').value), t = parseClock($('#pbExTo').value);
  if (!f || !t) return null;
  const from = new Date(`${dateInput(state.day)}T${f}`);
  let to = new Date(`${dateInput(state.day)}T${t}`);
  if (to <= from) to = new Date(to.getTime() + DAY); // lewat tengah malam
  return { from, to };
}
// Rapikan isian jam saat keluar dari kolom
for (const id of ['#pbExFrom', '#pbExTo']) {
  $(id).addEventListener('blur', (e) => {
    const c = parseClock(e.target.value);
    e.target.classList.toggle('invalid', !!e.target.value && !c);
    if (c) e.target.value = c;
    updateExportBtn();
  });
}
// "⌖ ambil": isi jam mulai / jam selesai dari posisi video yang sedang diputar
function takePosition(which) {
  const t = currentTime();
  if (!t) return toast('Putar rekaman dulu, lalu klik ⌖ ambil di posisi yang diinginkan', true);
  const el = which === 'from' ? $('#pbExFrom') : $('#pbExTo');
  el.value = fmtTime(t);
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 700);
  toast(`Jam ${which === 'from' ? 'mulai' : 'selesai'} ekspor: ${fmtTime(t)}`);
  const r = exportRange();
  if (r) $('#pbExport').title = `Ekspor ${fmtTime(r.from)} – ${fmtTime(r.to)} (${fmtDur(r.to - r.from)})`;
}
$('#pbExFromNow').addEventListener('click', () => takePosition('from'));
$('#pbExToNow').addEventListener('click', () => takePosition('to'));
const updateExportBtn = () => {
  const r = state.cam && exportRange();
  $('#pbExport').disabled = !r;
  $('#pbExInfo').textContent = r ? fmtDur(r.to - r.from) : '';
};
$('#pbExFrom').addEventListener('input', updateExportBtn);
$('#pbExTo').addEventListener('input', updateExportBtn);
$('#pbExport').addEventListener('click', async () => {
  const r = exportRange();
  if (!r) return toast('Isi jam mulai dan jam selesai', true);
  const total = (r.to - r.from) / 1000;
  if (total > 6 * 3600) return toast('Maksimal 6 jam sekali ekspor', true);
  const parts = [];
  for (let s = r.from.getTime(); s < r.to.getTime(); s += EXPORT_MAX * 1000) {
    parts.push({ start: new Date(s), dur: Math.min(EXPORT_MAX, Math.round((r.to.getTime() - s) / 1000)) });
  }
  if (parts.length > 1 && !(await confirmBox(`Rentang ${fmtDur(total * 1000)} akan diekspor menjadi ${parts.length} file (maksimal 1 jam per file).`, { title: 'Ekspor beberapa file?', ok: 'Ekspor' }))) return;
  toast(`Menyiapkan ekspor ${fmtTime(r.from)} – ${fmtTime(r.to)}${parts.length > 1 ? ` (${parts.length} file)` : ''}. Bagian yang kosong dilewati.`);
  for (const p of parts) {
    const a = document.createElement('a');
    a.href = `/api/playback/get?cam=${state.cam.id}&q=${state.quality}&start=${encodeURIComponent(p.start.toISOString())}&duration=${p.dur}&download=1`;
    a.click();
    await new Promise((ok) => setTimeout(ok, 1200)); // beri jeda supaya browser tidak memblokir unduhan beruntun
  }
});

// Kunci: pakai rentang ekspor kalau diisi, kalau tidak 5 menit dari posisi sekarang
$('#pbLock').addEventListener('click', async () => {
  const r = exportRange() || (currentTime() && { from: currentTime(), to: new Date(currentTime().getTime() + 5 * 60_000) });
  if (!r) return;
  const note = await promptBox(`Rekaman ${fmtTime(r.from)} – ${fmtTime(r.to)} tidak akan ikut terhapus otomatis.`, { title: 'Kunci rekaman', placeholder: 'Keterangan, mis. nomor kejadian', ok: 'Kunci' });
  if (note === null) return;
  try {
    await api('POST', '/api/playback/locks', { cam: state.cam.id, start: r.from.toISOString(), end: r.to.toISOString(), note });
    toast('Rekaman dikunci');
    loadRanges();
  } catch (ex) { toast(ex.message, true); }
});

// ---------- Mulai ----------
state.me = await api('GET', '/api/me');
$('#userInfo').textContent = state.me.username;
$('#pbLock').hidden = !state.me.is_admin;
setDay(new Date());
try {
  state.cams = await api('GET', '/api/playback/cameras');
} catch (ex) {
  state.cams = [];
  toast(ex.message, true);
}
renderCams();
const first = new URLSearchParams(location.search).get('cam');
if (first) $(`.pb-cam[data-id="${Number(first)}"]`)?.click();
