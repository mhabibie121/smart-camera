// "Petugas kebersihan" rekaman ala NVR (overwrite saat penuh).
// Setiap beberapa detik: hitung isi folder rekaman. Kalau melebihi batas
// (atau sisa ruang disk di bawah batas), hapus segmen PALING LAMA dari semua
// kamera sampai cukup. Segmen yang sedang ditulis & segmen yang dikunci tidak dihapus.
//
// Pemakaian: node janitor.js <folder-rekaman> <batasMB> [intervalDetik]
//   Kunci rekaman: buat file "<nama-segmen>.lock" di sebelah segmennya.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || 'recordings');
const LIMIT = Number(process.argv[3] || 300) * 1024 * 1024; // byte
const MIN_FREE = Number(process.env.MIN_FREE_GB || 0) * 1024 ** 3; // sisa ruang disk minimal (opsional)
const EVERY = Number(process.argv[4] || 10) * 1000;

const mb = (b) => (b / 1024 / 1024).toFixed(1) + ' MB';
const time = () => new Date().toLocaleTimeString('id-ID');

function segments() {
  const out = [];
  if (!fs.existsSync(ROOT)) return out;
  for (const cam of fs.readdirSync(ROOT)) {
    const dir = path.join(ROOT, cam);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.mp4')) continue;
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      out.push({ cam, file: f, path: p, size: st.size, mtime: st.mtimeMs, locked: fs.existsSync(p + '.lock') });
    }
  }
  // Paling lama dulu (nama file = waktu mulai segmen)
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.mtime - b.mtime);
}

function diskFree() {
  try { const s = fs.statfsSync(ROOT); return s.bavail * s.bsize; } catch { return Infinity; }
}

function sweep() {
  const segs = segments();
  let total = segs.reduce((n, s) => n + s.size, 0);
  // Segmen terbaru tiap kamera sedang ditulis -> jangan disentuh
  const newest = new Map();
  for (const s of segs) newest.set(s.cam, s.file);
  const free = diskFree();
  const over = () => total > LIMIT || (MIN_FREE && diskFree() < MIN_FREE);
  const deleted = [];
  for (const s of segs) {
    if (!over()) break;
    if (s.locked || newest.get(s.cam) === s.file) continue;
    try {
      fs.unlinkSync(s.path);
      total -= s.size;
      deleted.push(`${s.cam}/${s.file} (${mb(s.size)})`);
    } catch (e) { console.log(`${time()} gagal hapus ${s.file}: ${e.message}`); }
  }
  const perCam = {};
  for (const s of segments()) {
    perCam[s.cam] ??= { n: 0, size: 0, oldest: s.file };
    perCam[s.cam].n++; perCam[s.cam].size += s.size;
  }
  const summary = Object.entries(perCam).map(([c, v]) => `${c}: ${v.n} segmen ${mb(v.size)} sejak ${v.oldest.slice(11, 19)}`).join(' | ');
  console.log(`${time()} terpakai ${mb(total)} / batas ${mb(LIMIT)}${deleted.length ? ` → HAPUS ${deleted.length}: ${deleted.join(', ')}` : ''}  [${summary}]  disk bebas ${Number.isFinite(free) ? (free / 1024 ** 3).toFixed(1) + ' GB' : '?'}`);
}

console.log(`${time()} petugas kebersihan aktif: ${ROOT}, batas ${mb(LIMIT)}, cek tiap ${EVERY / 1000} dtk`);
sweep();
setInterval(sweep, EVERY);
