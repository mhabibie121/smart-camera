// Cek kamera online/offline dengan koneksi TCP ke port RTSP-nya.
// Ringan: tidak menarik video sama sekali.
import net from 'node:net';
import { config } from './config.js';
import { db } from './db.js';

const status = new Map(); // cameraId -> { online, checkedAt }
const CONCURRENCY = 25;
const TIMEOUT_MS = 3000;

function probe(ip, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(TIMEOUT_MS, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

async function probeAll() {
  const cams = db.prepare('SELECT id, ip, port FROM cameras WHERE enabled = 1').all();
  const ids = new Set(cams.map((c) => c.id));
  for (const id of status.keys()) if (!ids.has(id)) status.delete(id);

  let i = 0;
  const worker = async () => {
    while (i < cams.length) {
      const c = cams[i++];
      status.set(c.id, { online: await probe(c.ip, c.port), checkedAt: Date.now() });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

let running = false;
export async function probeNow() {
  if (running) return;
  running = true;
  try { await probeAll(); } finally { running = false; }
}

export function startProbeLoop() {
  probeNow();
  setInterval(probeNow, config.probeIntervalSec * 1000).unref();
}

export function cameraOnline(id) {
  const s = status.get(id);
  return s ? s.online : null; // null = belum dicek
}
