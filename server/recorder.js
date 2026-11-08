// Modul rekaman (opsional, mirip NVR):
//  - MediaMTX merekam kamera terpilih secara "raw" (tanpa encode ulang) ke
//    <folder>/cam<ID>_<main|sub>/<YYYY-MM-DD_HH-MM-SS-ffffff>.mp4 (fMP4 per segmen)
//  - "Petugas kebersihan" di sini menghapus segmen PALING LAMA kalau sisa ruang
//    hardisk di bawah batas (overwrite seperti NVR) dan/atau lebih tua dari X hari.
//  - Segmen yang beririsan dengan rekaman terkunci tidak pernah dihapus.
// Kunci disimpan di database (file .lock di folder rekaman membuat daftar playback MediaMTX error).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db, getSetting } from './db.js';

const DIR_RE = /^cam(\d+)_(main|sub)$/;
const FILE_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d+)\.mp4$/;

export function recordSettings() {
  return {
    available: config.features.record,
    enabled: config.features.record && getSetting('record_enabled', '0') === '1',
    root: getSetting('record_path', '') || path.join(config.dataDir, 'recordings'),
    minFreeGb: Number(getSetting('record_min_free_gb', '20')) || 0,
    maxDays: Number(getSetting('record_max_days', '0')) || 0,
    segmentMin: Math.min(60, Math.max(1, Number(getSetting('record_segment_min', '15')) || 15)),
  };
}

// Waktu mulai segmen dari nama file (waktu lokal server)
function segStart(file) {
  const m = FILE_RE.exec(file);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], Math.floor(+m[7].padEnd(6, '0').slice(0, 6) / 1000));
}

function listSegments(root) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    const m = DIR_RE.exec(d);
    if (!m) continue;
    const dir = path.join(root, d);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    const segs = [];
    for (const f of files) {
      const start = segStart(f);
      if (!start) continue;
      try {
        const st = fs.statSync(path.join(dir, f));
        segs.push({ path: path.join(dir, f), file: f, cam: Number(m[1]), quality: m[2], start, end: new Date(st.mtimeMs), size: st.size });
      } catch {}
    }
    segs.sort((a, b) => a.start - b.start);
    // Segmen terakhir tiap kamera sedang ditulis -> jangan disentuh
    if (segs.length) segs[segs.length - 1].active = true;
    out.push(...segs);
  }
  return out;
}

export function diskInfo(root) {
  try {
    fs.mkdirSync(root, { recursive: true });
    const s = fs.statfsSync(root);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return { total: 0, free: 0 };
  }
}

function lockedRanges() {
  const map = new Map();
  for (const l of db.prepare('SELECT camera_id, start_at, end_at FROM record_locks').all()) {
    (map.get(l.camera_id) || map.set(l.camera_id, []).get(l.camera_id))
      .push([new Date(l.start_at).getTime(), new Date(l.end_at).getTime()]);
  }
  return map;
}

const fmtGb = (b) => (b / 1024 ** 3).toFixed(1) + ' GB';

export function sweep() {
  const s = recordSettings();
  if (!s.enabled) return { deleted: 0 };
  const segs = listSegments(s.root);
  const locks = lockedRanges();
  const isLocked = (g) => (locks.get(g.cam) || []).some(([a, b]) => g.start.getTime() < b && g.end.getTime() > a);
  const deletable = segs.filter((g) => !g.active && !isLocked(g)).sort((a, b) => a.start - b.start);
  let deleted = 0, freed = 0;
  const remove = (g) => {
    try { fs.unlinkSync(g.path); deleted++; freed += g.size; return true; } catch { return false; }
  };

  // 1) Lebih tua dari batas hari
  if (s.maxDays > 0) {
    const limit = Date.now() - s.maxDays * 86400_000;
    for (const g of deletable) if (g.end.getTime() < limit && remove(g)) g.gone = true;
  }
  // 2) Hardisk hampir penuh -> hapus yang paling lama sampai sisa ruang cukup (overwrite)
  if (s.minFreeGb > 0) {
    const need = s.minFreeGb * 1024 ** 3;
    let free = diskInfo(s.root).free;
    for (const g of deletable) {
      if (free >= need) break;
      if (g.gone) continue;
      if (remove(g)) { g.gone = true; free += g.size; }
    }
  }
  if (deleted) console.log(`[rekaman] ${deleted} segmen lama dihapus (${fmtGb(freed)} dibebaskan)`);
  return { deleted, freed };
}

// Ringkasan untuk halaman admin
export function recordStatus() {
  const s = recordSettings();
  const segs = listSegments(s.root);
  const per = new Map();
  for (const g of segs) {
    const key = `${g.cam}_${g.quality}`;
    const p = per.get(key) || { cam: g.cam, quality: g.quality, count: 0, size: 0, oldest: g.start, newest: g.end };
    p.count++; p.size += g.size;
    if (g.start < p.oldest) p.oldest = g.start;
    if (g.end > p.newest) p.newest = g.end;
    per.set(key, p);
  }
  const used = segs.reduce((n, g) => n + g.size, 0);
  const oldest = segs.length ? new Date(Math.min(...segs.map((g) => g.start.getTime()))) : null;
  // "Masih merekam" = segmen terakhir diperbarui belum lama
  const staleMs = 3 * 60_000;
  return {
    settings: s,
    disk: diskInfo(s.root),
    used,
    oldest,
    cameras: [...per.values()].map((p) => ({ ...p, active: Date.now() - p.newest.getTime() < staleMs })),
  };
}

export function startRecorderLoop() {
  const run = () => { try { sweep(); } catch (e) { console.warn('[rekaman] petugas kebersihan gagal:', e.message); } };
  setTimeout(run, 10_000).unref();
  setInterval(run, 60_000).unref();
}

// Folder rekaman: harus bisa ditulis
export function checkRecordPath(p) {
  const dir = path.resolve(p);
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.tes-tulis-${process.pid}`);
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
  return dir;
}
