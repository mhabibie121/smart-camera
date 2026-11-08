// Kontrol PTZ (pan / tilt / zoom / focus / preset).
//  - Dahua: HTTP API kamera  /cgi-bin/ptz.cgi  (Digest auth, fallback Basic)
//  - HikCentral: OpenAPI  /api/video/v1/ptzs/controlling
// Browser tidak pernah bicara langsung ke kamera; password kamera tetap di server.
import crypto from 'node:crypto';
import http from 'node:http';
import { getSetting } from './db.js';
import { hikRequest } from './hikcentral.js';

// op -> [kode Dahua, perintah HikCentral]
const OPS = {
  up: ['Up', 'UP'], down: ['Down', 'DOWN'], left: ['Left', 'LEFT'], right: ['Right', 'RIGHT'],
  upleft: ['LeftUp', 'LEFT_UP'], upright: ['RightUp', 'RIGHT_UP'],
  downleft: ['LeftDown', 'LEFT_DOWN'], downright: ['RightDown', 'RIGHT_DOWN'],
  zoomin: ['ZoomTele', 'ZOOM_IN'], zoomout: ['ZoomWide', 'ZOOM_OUT'],
  focusnear: ['FocusNear', 'FOCUS_NEAR'], focusfar: ['FocusFar', 'FOCUS_FAR'],
  irisopen: ['IrisLarge', 'IRIS_ENLARGE'], irisclose: ['IrisSmall', 'IRIS_REDUCE'],
  preset: ['GotoPreset', 'GOTO_PRESET'],
};
export const PTZ_OPS = Object.keys(OPS);
const DIAGONAL = new Set(['upleft', 'upright', 'downleft', 'downright']);

// Login & alamat HTTP kamera
function target(cam) {
  let host = cam.ip, user = cam.username, pass = cam.password, channel = cam.channel || 1;
  if (cam.rtsp_main) {
    try {
      const u = new URL(cam.rtsp_main);
      host = u.hostname;
      if (u.username) { user = decodeURIComponent(u.username); pass = decodeURIComponent(u.password); }
      channel = Number(u.searchParams.get('channel')) || channel;
    } catch {}
  }
  return {
    host,
    port: cam.http_port || 80,
    channel,
    user: user ?? getSetting('default_cam_user', ''),
    pass: pass ?? getSetting('default_cam_pass', ''),
  };
}

function rawGet(t, path, authHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      // agent:false + Connection: close = koneksi baru tiap perintah.
      // Banyak kamera Dahua macet kalau koneksi keep-alive dipakai ulang.
      method: 'GET', hostname: t.host, port: t.port, path, timeout: 4000, agent: false,
      headers: { connection: 'close', ...(authHeader ? { authorization: authHeader } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('Kamera tidak merespons (timeout)')));
    req.on('error', reject);
    req.end();
  });
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function digestHeader(t, path, challenge) {
  const p = {};
  for (const m of challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) p[m[1]] = m[2] ?? m[3];
  const ha1 = md5(`${t.user}:${p.realm}:${t.pass}`);
  const ha2 = md5(`GET:${path}`);
  const parts = [`username="${t.user}"`, `realm="${p.realm}"`, `nonce="${p.nonce}"`, `uri="${path}"`];
  if (p.qop) {
    const cnonce = crypto.randomBytes(8).toString('hex'), nc = '00000001';
    parts.push(`qop=auth`, `nc=${nc}`, `cnonce="${cnonce}"`,
      `response="${md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:auth:${ha2}`)}"`);
  } else {
    parts.push(`response="${md5(`${ha1}:${p.nonce}:${ha2}`)}"`);
  }
  if (p.opaque) parts.push(`opaque="${p.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

// GET ke HTTP API Dahua (kamera / NVR) dengan login Digest (fallback Basic).
// t = { host, port, user, pass }. Mengembalikan isi jawaban (teks).
export async function dahuaRequest(t, path) {
  let r = await rawGet(t, path);
  if (r.status === 401) {
    const ch = String(r.headers['www-authenticate'] || '');
    const auth = /^digest/i.test(ch)
      ? digestHeader(t, path, ch)
      : `Basic ${Buffer.from(`${t.user}:${t.pass}`).toString('base64')}`;
    r = await rawGet(t, path, auth);
  }
  if (r.status === 401) throw new Error('Login ditolak (username/password salah, atau akun sedang terkunci)');
  if (r.status >= 400) throw Object.assign(new Error(`Perangkat menolak perintah (HTTP ${r.status})`), { status: r.status });
  return r.body;
}

async function dahuaGet(t, path) {
  const body = await dahuaRequest(t, path);
  if (!/OK/i.test(body)) throw new Error(`Kamera: ${body.trim().slice(0, 100) || 'jawaban tidak dikenal'}`);
}

// Perintah ke satu kamera dikirim berurutan (antre), supaya "stop" tidak
// mendahului "start" dan kamera tidak dibanjiri koneksi bersamaan.
const queues = new Map(); // cameraId -> Promise
export function ptzCommand(cam, cmd) {
  const prev = queues.get(cam.id) || Promise.resolve();
  const job = prev.catch(() => {}).then(() => sendPtz(cam, cmd));
  queues.set(cam.id, job);
  job.finally(() => { if (queues.get(cam.id) === job) queues.delete(cam.id); }).catch(() => {});
  return job;
}

// action: 'start' | 'stop'; speed 1..8; preset 1..255
async function sendPtz(cam, { op, action, speed = 4, preset = 1 }) {
  const map = OPS[op];
  if (!map) throw new Error('Perintah PTZ tidak dikenal');
  speed = Math.min(8, Math.max(1, Number(speed) || 4));
  preset = Math.min(255, Math.max(1, Number(preset) || 1));

  if (cam.hik_code) {
    await hikRequest('/api/video/v1/ptzs/controlling', {
      cameraIndexCode: cam.hik_code,
      action: op === 'preset' ? 0 : (action === 'stop' ? 1 : 0),
      command: map[1],
      speed: Math.round(speed * 12.5),
      ...(op === 'preset' ? { presetIndex: preset } : {}),
    });
    return;
  }

  const t = target(cam);
  let args;
  if (op === 'preset') { action = 'start'; args = [0, preset, 0]; }
  else if (DIAGONAL.has(op)) args = [speed, speed, 0];
  else args = [0, speed, 0];
  const path = `/cgi-bin/ptz.cgi?action=${action === 'stop' ? 'stop' : 'start'}&channel=${t.channel}`
    + `&code=${map[0]}&arg1=${args[0]}&arg2=${args[1]}&arg3=${args[2]}`;
  await dahuaGet(t, path);
}

// Pengaman: kalau tombol "lepas" tidak pernah sampai (koneksi putus),
// kamera dihentikan otomatis setelah beberapa detik.
const watchdogs = new Map(); // cameraId -> timeout
export function armWatchdog(cam, op) {
  clearWatchdog(cam.id);
  watchdogs.set(cam.id, setTimeout(() => {
    watchdogs.delete(cam.id);
    ptzCommand(cam, { op, action: 'stop' }).catch(() => {});
  }, 15_000));
}
export function clearWatchdog(id) {
  clearTimeout(watchdogs.get(id));
  watchdogs.delete(id);
}
