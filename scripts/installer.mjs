// Membuat installer Windows: dist/Setup-Smart-Camera-<versi>.exe
// Butuh: Inno Setup 6 (ISCC.exe) dan hasil "npm run build" di folder release/.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const candidates = [
  process.env.ISCC,
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
  'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
].filter(Boolean);
const iscc = candidates.find((p) => fs.existsSync(p));
if (!iscc) {
  console.error('Inno Setup 6 (ISCC.exe) tidak ditemukan. Pasang dari https://jrsoftware.org atau isi variabel ISCC.');
  process.exit(1);
}
for (const f of ['cctv.exe', 'mediamtx.exe', 'mediamtx.yml', 'THIRD-PARTY-NOTICES.txt']) {
  if (!fs.existsSync(path.join(ROOT, 'release', f))) {
    console.error(`release/${f} belum ada. Jalankan "npm run build" dulu.`);
    process.exit(1);
  }
}
console.log(`> Membuat installer Smart Camera ${version}`);
const r = spawnSync(iscc, ['/Q', `/DAppVersion=${version}`, path.join(ROOT, 'installer', 'SmartCamera.iss')], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status || 1);
const out = path.join(ROOT, 'dist', `Setup-Smart-Camera-${version}.exe`);
console.log(`\nSelesai: ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1024 / 1024).toFixed(0)} MB)`);
