// Build cctv.exe (Windows) / cctv (Linux) dengan Node.js Single Executable Application.
//   npm run build
// Hasil: folder release/ berisi exe + MediaMTX + config, siap di-copy.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const RELEASE = path.join(ROOT, 'release');
const isWin = process.platform === 'win32';
const exeName = isWin ? 'cctv.exe' : 'cctv';
const mtxName = isWin ? 'mediamtx.exe' : 'mediamtx';

const step = (msg) => console.log(`\n> ${msg}`);

fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(RELEASE, { recursive: true });

// 1. Gabungkan semua kode server jadi satu file
step('Menggabungkan kode server (esbuild)');
await build({
  entryPoints: [path.join(ROOT, 'server/main.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(BUILD, 'server.cjs'),
  logLevel: 'warning',
  logOverride: { 'empty-import-meta': 'silent' }, // import.meta hanya dipakai di mode non-exe
});

// 2. Daftarkan semua file web (public/) sebagai aset di dalam exe
step('Mengemas file web');
const assets = {};
(function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full);
    else assets[path.relative(ROOT, full).split(path.sep).join('/')] = full;
  }
})(path.join(ROOT, 'public'));
console.log(`  ${Object.keys(assets).length} file`);

const seaConfig = {
  main: path.join(BUILD, 'server.cjs'),
  output: path.join(BUILD, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
  assets,
};
fs.writeFileSync(path.join(BUILD, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));

// 3. Buat blob SEA
step('Membuat blob aplikasi');
execFileSync(process.execPath, ['--experimental-sea-config', path.join(BUILD, 'sea-config.json')], { stdio: 'inherit' });

// 4. Salin node.exe lalu suntikkan blob
step(`Membuat ${exeName}`);
const exePath = path.join(RELEASE, exeName);
fs.rmSync(exePath, { force: true });
fs.copyFileSync(process.execPath, exePath);
const postject = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
execFileSync(process.execPath, [
  postject, exePath, 'NODE_SEA_BLOB', path.join(BUILD, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
], { stdio: 'inherit' });

// 5. Lengkapi folder release
step('Menyalin MediaMTX & config');
const mtxSrc = path.join(ROOT, 'bin', mtxName);
if (fs.existsSync(mtxSrc)) fs.copyFileSync(mtxSrc, path.join(RELEASE, mtxName));
else console.warn(`  [!] ${path.join('bin', mtxName)} tidak ada, salin MediaMTX ke release/ secara manual`);
fs.copyFileSync(path.join(ROOT, 'mediamtx', 'mediamtx.yml'), path.join(RELEASE, 'mediamtx.yml'));
fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(RELEASE, '.env.example'));
fs.copyFileSync(path.join(ROOT, 'contoh-kamera.csv'), path.join(RELEASE, 'contoh-kamera.csv'));
if (isWin) fs.copyFileSync(path.join(ROOT, 'scripts', 'release-jalankan.bat'), path.join(RELEASE, 'jalankan.bat'));

// 6. Lisensi pihak ketiga (wajib ikut dibagikan: Node.js, MediaMTX, paket npm yang dibundel)
step('Menyusun THIRD-PARTY-NOTICES.txt');
{
  const parts = [];
  const add = (title, file) => {
    try { parts.push(`${'='.repeat(78)}\n${title}\n${'='.repeat(78)}\n\n${fs.readFileSync(file, 'utf8').trim()}\n`); }
    catch { console.warn(`  [!] lisensi ${title} tidak ditemukan (${file})`); }
  };
  add('Node.js (runtime di dalam cctv.exe)', path.join(path.dirname(process.execPath), 'LICENSE'));
  add('MediaMTX (mediamtx.exe)', path.join(ROOT, 'test', 'mediamtx', 'LICENSE'));
  // Semua paket npm produksi yang ikut dibundel esbuild
  const seen = new Set();
  const walk = (dir) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies || {})) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const d = path.join(ROOT, 'node_modules', dep);
      if (!fs.existsSync(d)) continue;
      const p = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));
      const lic = fs.readdirSync(d).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
      if (lic) add(`${p.name} ${p.version} (${p.license || 'lihat teks'})`, path.join(d, lic));
      else parts.push(`${'='.repeat(78)}\n${p.name} ${p.version}\n${'='.repeat(78)}\n\nLisensi: ${p.license || '-'}\n`);
      walk(d);
    }
  };
  walk(ROOT);
  fs.writeFileSync(path.join(RELEASE, 'THIRD-PARTY-NOTICES.txt'),
    `Smart Camera memakai komponen pihak ketiga berikut. Teks lisensinya disertakan sesuai ketentuan masing-masing.\n\n${parts.join('\n')}`);
  console.log(`  ${parts.length} komponen`);
}

const size = (fs.statSync(exePath).size / 1024 / 1024).toFixed(0);
console.log(`\nSelesai: ${path.relative(ROOT, exePath)} (${size} MB)`);
console.log('Folder release/ siap di-copy ke PC/server lain.');
