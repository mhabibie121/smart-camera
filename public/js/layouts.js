// Definisi layout grid. Setiap layout = { cols, rows, cells: [{ c, r, w, h }] }
// c/r = kolom/baris awal (mulai 0), w/h = lebar/tinggi dalam satuan kotak.
//
// Format id layout:
//   "1", "4", "6", "8", "9", "16", ...   preset
//   "c3x5"                               custom 3 baris × 5 kolom
//   "g4x4:0.0.2.2,2.2.2.2"               custom dengan kotak gabungan
//                                        (setiap gabungan = kolom.baris.lebar.tinggi)

function uniform(cols, rows) {
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push({ c, r, w: 1, h: 1 });
  return { cols, rows, cells };
}

// Grid rows×cols dengan beberapa kotak gabungan; sisanya kotak 1×1.
// Urutan kotak: berdasarkan posisi kiri-atasnya (baris dulu, lalu kolom).
function withMerges(cols, rows, merges) {
  const taken = Array.from({ length: rows }, () => Array(cols).fill(false));
  const cells = [];
  for (const m of merges) {
    cells.push({ ...m });
    for (let r = m.r; r < m.r + m.h; r++) for (let c = m.c; c < m.c + m.w; c++) taken[r][c] = true;
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (!taken[r][c]) cells.push({ c, r, w: 1, h: 1 });
  cells.sort((a, b) => a.r - b.r || a.c - b.c);
  return { cols, rows, cells };
}

export const PRESETS = ['1', '4', '6', '8', '9', '16', '25', '36', '64'];
export const MAX_SIDE = 8;

function parseMerged(id) {
  const m = /^g(\d+)x(\d+)(?::(.*))?$/.exec(id);
  if (!m) return null;
  const rows = Math.min(MAX_SIDE, Number(m[1])), cols = Math.min(MAX_SIDE, Number(m[2]));
  const merges = [];
  for (const part of (m[3] || '').split(',').filter(Boolean)) {
    const [c, r, w, h] = part.split('.').map(Number);
    // Abaikan gabungan yang keluar batas atau bertabrakan
    if (![c, r, w, h].every(Number.isInteger) || w < 1 || h < 1 || c + w > cols || r + h > rows) continue;
    if (merges.some((x) => overlaps(x, { c, r, w, h }))) continue;
    merges.push({ c, r, w, h });
  }
  return { rows, cols, merges };
}

export function overlaps(a, b) {
  return a.c < b.c + b.w && b.c < a.c + a.w && a.r < b.r + b.h && b.r < a.r + a.h;
}

export function layoutDef(id) {
  const merged = parseMerged(id);
  if (merged) return withMerges(merged.cols, merged.rows, merged.merges);
  const custom = /^c(\d+)x(\d+)$/.exec(id);
  if (custom) return uniform(Number(custom[2]), Number(custom[1])); // c<rows>x<cols>
  switch (id) {
    case '6': return withMerges(3, 3, [{ c: 0, r: 0, w: 2, h: 2 }]);
    case '8': return withMerges(4, 4, [{ c: 0, r: 0, w: 3, h: 3 }]);
    default: {
      const n = Math.round(Math.sqrt(Number(id) || 1));
      return uniform(n, n);
    }
  }
}

// Kebalikan dari layoutDef: rows, cols, dan daftar gabungan dari layout apa pun
export function layoutParts(id) {
  const d = layoutDef(id);
  return { rows: d.rows, cols: d.cols, merges: d.cells.filter((x) => x.w > 1 || x.h > 1) };
}

// Bentuk id paling ringkas untuk rows×cols + gabungan
export function makeLayoutId(rows, cols, merges) {
  if (!merges.length) {
    return rows === cols && PRESETS.includes(String(rows * cols)) ? String(rows * cols) : `c${rows}x${cols}`;
  }
  const id = `g${rows}x${cols}:` + [...merges].sort((a, b) => a.r - b.r || a.c - b.c)
    .map((m) => `${m.c}.${m.r}.${m.w}.${m.h}`).join(',');
  // Kalau sama persis dengan preset 6 / 8, pakai preset-nya
  if (id === 'g3x3:0.0.2.2') return '6';
  if (id === 'g4x4:0.0.3.3') return '8';
  return id;
}

export const tileCount = (id) => layoutDef(id).cells.length;

export function layoutLabel(id) {
  const g = /^g(\d+)x(\d+)/.exec(id);
  if (g) return `${tileCount(id)}`;
  const custom = /^c(\d+)x(\d+)$/.exec(id);
  return custom ? `${custom[1]}×${custom[2]}` : id;
}

// Layout terbesar yang masih <= batas
export function clampLayout(id, max) {
  if (tileCount(id) <= max) return id;
  return [...PRESETS].reverse().find((p) => tileCount(p) <= max) || '1';
}

// Gambar mini layout (untuk tombol & dialog)
export function layoutIcon(id, size = 18) {
  const d = layoutDef(id);
  const cw = size / d.cols, ch = size / d.rows;
  const rects = d.cells.map((x) =>
    `<rect x="${x.c * cw + 0.75}" y="${x.r * ch + 0.75}" width="${x.w * cw - 1.5}" height="${x.h * ch - 1.5}" rx="0.5"/>`
  ).join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="currentColor" aria-hidden="true">${rects}</svg>`;
}
