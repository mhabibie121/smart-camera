import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';

// Saat jalan sebagai cctv.exe (hasil compile), folder kerja = folder exe-nya.
export const IS_SEA = isSea();
const ROOT = IS_SEA
  ? path.dirname(process.execPath)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Baca .env di folder aplikasi (pengganti flag --env-file)
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Secret untuk tanda tangan cookie/token. Kalau tidak di-set di .env,
// dibuat otomatis sekali dan disimpan di data/secret.
function loadSecret() {
  if (process.env.SECRET) return process.env.SECRET;
  const file = path.join(DATA_DIR, 'secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

export const config = {
  root: ROOT,
  dataDir: DATA_DIR,
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 3000),
  // Modul opsional. RECORD_MODULE=0 (dipilih saat instalasi) = fitur rekaman disembunyikan total.
  features: { record: process.env.RECORD_MODULE !== '0' },
  dbPath: path.join(DATA_DIR, 'cctv.db'),
  // Server playback MediaMTX (memutar ulang rekaman), hanya di PC server
  mediamtxPlayback: (process.env.MEDIAMTX_PLAYBACK || 'http://127.0.0.1:9996').replace(/\/+$/, ''),
  secret: loadSecret(),
  // API MediaMTX (hanya bisa diakses dari server sendiri)
  mediamtxApi: (process.env.MEDIAMTX_API || 'http://127.0.0.1:9997').replace(/\/$/, ''),
  // URL WebRTC MediaMTX yang dipakai browser. Kosong = otomatis
  // pakai hostname yang sama dengan web, port 8889.
  webrtcUrl: (process.env.WEBRTC_PUBLIC_URL || '').replace(/\/$/, ''),
  webrtcPort: Number(process.env.WEBRTC_PORT || 8889),
  sessionHours: Number(process.env.SESSION_HOURS || 12),
  streamTokenMinutes: 15,
  // Cek kamera online/offline (TCP ke port RTSP)
  probeIntervalSec: Number(process.env.PROBE_INTERVAL_SEC || 60),
  syncIntervalSec: 30,
  // true kalau web di belakang HTTPS reverse proxy (nginx)
  secureCookie: process.env.SECURE_COOKIE === 'true',
  trustProxy: process.env.TRUST_PROXY === 'true',
};
