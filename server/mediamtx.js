// Integrasi MediaMTX:
//  1. Sinkronisasi path kamera lewat API MediaMTX (tidak perlu edit mediamtx.yml
//     tiap tambah kamera). Diulang berkala supaya kalau MediaMTX restart,
//     path-nya otomatis dipasang lagi.
//  2. Handler authHTTP: MediaMTX menanyakan ke sini setiap ada yang mau
//     menonton stream. Di sinilah hak akses grup ditegakkan.
import { config } from './config.js';
import { db, getSetting, canViewCamera } from './db.js';
import { userFromToken, guestIpAllowed } from './auth.js';
import { hikPreviewUrl } from './hikcentral.js';
import { recordSettings } from './recorder.js';

const PATH_RE = /^cam(\d+)_(main|sub)$/;
const SUBTYPE = { main: 0, sub: 1 };

export function pathName(cameraId, quality) {
  return `cam${cameraId}_${quality}`;
}

// Substream dari URL main: ganti subtype=0 jadi subtype=1 (format Dahua).
// Kalau URL tidak punya subtype, main dan sub memakai URL yang sama.
export function deriveSubUrl(main) {
  return /([?&])subtype=0\b/.test(main) ? main.replace(/([?&])subtype=0\b/, '$1subtype=1') : main;
}

// URL tanpa user:pass diberi login default kamera dari pengaturan
function withDefaultLogin(url) {
  try {
    const u = new URL(url);
    if (u.username) return url;
    const user = getSetting('default_cam_user', '');
    if (!user) return url;
    u.username = encodeURIComponent(user);
    u.password = encodeURIComponent(getSetting('default_cam_pass', ''));
    return u.href;
  } catch {
    return url;
  }
}

export function rtspUrl(cam, quality) {
  if (cam.rtsp_main) {
    const url = quality === 'main' ? cam.rtsp_main : (cam.rtsp_sub || deriveSubUrl(cam.rtsp_main));
    return withDefaultLogin(url);
  }
  const user = cam.username ?? getSetting('default_cam_user', '');
  const pass = cam.password ?? getSetting('default_cam_pass', '');
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
  return `rtsp://${auth}${cam.ip}:${cam.port}/cam/realmonitor?channel=${cam.channel}&subtype=${SUBTYPE[quality]}`;
}

// ---------- Kamera HikCentral ----------
// URL-nya berisi token sementara, jadi tidak disimpan di database. URL terbaru
// disimpan di memori dan dipasang ke MediaMTX tepat sebelum stream diputar.
const HIK_PLACEHOLDER = 'rtsp://127.0.0.1:1/hikcentral-url-belum-diminta';
const hikUrls = new Map();     // pathName -> { url, at }
const hikInflight = new Map(); // pathName -> Promise

// Dipanggil browser sebelum mulai memutar. Untuk kamera biasa tidak melakukan apa-apa.
export async function prepareStream(cam, quality) {
  if (!cam.hik_code) return;
  const name = pathName(cam.id, quality);
  if (hikInflight.has(name)) return hikInflight.get(name);

  const job = (async () => {
    // Sedang tayang (ada penonton lain) = URL lama masih dipakai, jangan diganggu
    const live = await api('GET', `/v3/paths/get/${name}`).catch(() => null);
    if (live?.ready) return;
    const recent = hikUrls.get(name);
    if (recent && Date.now() - recent.at < 15_000) return; // baru saja diminta

    const url = await hikPreviewUrl(cam.hik_code, quality);
    hikUrls.set(name, { url, at: Date.now() });
    await api('PATCH', `/v3/config/paths/patch/${name}`, { source: url });
    // Beri waktu MediaMTX memuat ulang path; kalau browser langsung meminta video
    // saat path masih dimuat ulang, MediaMTX menjawab 400.
    await new Promise((r) => setTimeout(r, 800));
  })();
  hikInflight.set(name, job);
  try { await job; } finally { hikInflight.delete(name); }
}

function desiredPaths() {
  const cams = db.prepare('SELECT * FROM cameras WHERE enabled = 1').all();
  const rec = recordSettings();
  const out = new Map();
  for (const cam of cams) {
    for (const q of ['main', 'sub']) {
      const name = pathName(cam.id, q);
      // Direkam = modul aktif + kamera dicentang + kualitas ini yang dipilih (HikCentral belum didukung)
      const recording = rec.enabled && !!cam.record && !cam.hik_code && (cam.record_quality || 'main') === q;
      out.set(name, {
        // null = kamera HikCentral: pertahankan URL yang sedang terpasang
        source: cam.hik_code ? (hikUrls.get(name)?.url ?? null) : rtspUrl(cam, q),
        // Ditarik terus kalau direkam; selain itu hanya saat ada yang nonton
        sourceOnDemand: !recording,
        sourceOnDemandStartTimeout: cam.hik_code ? '20s' : '10s',
        sourceOnDemandCloseAfter: '15s',  // putus 15 detik setelah penonton terakhir pergi
        rtspTransport: 'tcp',             // TCP lebih stabil untuk Dahua
        // Rekaman "raw" (tanpa encode ulang), fMP4 per segmen. Penghapusan diatur recorder.js
        record: recording,
        recordPath: `${rec.root.replace(/\\/g, '/')}/%path/%Y-%m-%d_%H-%M-%S-%f`,
        recordFormat: 'fmp4',
        recordPartDuration: '1s',
        recordSegmentDuration: `${rec.segmentMin}m`,
        recordDeleteAfter: '0s',
      });
    }
  }
  return out;
}

// Durasi ala MediaMTX ("1m", "1m0s", "1h30m0s", "90s") -> detik, supaya perbandingan tidak salah
// (kalau salah, path direkam akan di-PATCH tiap sync dan rekamannya terpotong-potong).
function durSec(v) {
  let s = 0;
  for (const [, n, u] of String(v || '').matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s)/g)) {
    s += Number(n) * ({ h: 3600, m: 60, s: 1, ms: 0.001 })[u];
  }
  return Math.round(s * 1000) / 1000;
}

// Server playback MediaMTX (untuk putar ulang) harus aktif & tidak lewat authHTTP
// (aksesnya hanya dari server aplikasi, yang sudah mengecek izin user).
// Pengaturan global MediaMTX yang harus cocok dengan aplikasi (dicek sekali, diperbaiki kalau beda):
//  - authHTTPAddress harus menunjuk ke port web aplikasi ini (port bisa 80, 8080, 3000... pilihan installer)
//  - server playback aktif & tidak lewat authHTTP (kalau modul rekaman aktif)
let playbackChecked = false;
async function ensurePlayback() {
  if (playbackChecked) return;
  const g = await api('GET', '/v3/config/global/get');
  const patch = {};
  const authUrl = `http://127.0.0.1:${config.port}/internal/mediamtx-auth`;
  if (g.authMethod === 'http' && g.authHTTPAddress !== authUrl) patch.authHTTPAddress = authUrl;
  if (recordSettings().enabled) {
    const addr = new URL(config.mediamtxPlayback).host;
    const exclude = g.authHTTPExclude || [];
    if (!g.playback || g.playbackAddress !== addr) Object.assign(patch, { playback: true, playbackAddress: addr });
    if (g.authMethod === 'http' && !exclude.some((e) => e.action === 'playback')) {
      patch.authHTTPExclude = [...exclude, { action: 'playback' }];
    }
  }
  if (Object.keys(patch).length) {
    await api('PATCH', '/v3/config/global/patch', patch);
    console.log(`[mediamtx] pengaturan disesuaikan: ${Object.keys(patch).join(', ')}`);
  }
  playbackChecked = true;
}

async function api(method, p, body) {
  const res = await fetch(config.mediamtxApi + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${p} -> ${res.status} ${text}`);
  }
  return res.status === 200 ? res.json().catch(() => null) : null;
}

async function listConfiguredPaths() {
  const items = [];
  for (let page = 0; ; page++) {
    const r = await api('GET', `/v3/config/paths/list?itemsPerPage=1000&page=${page}`);
    items.push(...(r?.items || []));
    if (!r || page + 1 >= (r.pageCount || 1)) break;
  }
  return new Map(items.map((p) => [p.name, p]));
}

export const syncState = { ok: false, lastSync: null, lastError: null, pathCount: 0 };
let syncing = null;
let pending = false;

async function doSync() {
  const desired = desiredPaths();
  const existing = await listConfiguredPaths();
  let changes = 0;

  for (const [name] of existing) {
    if (PATH_RE.test(name) && !desired.has(name)) {
      await api('DELETE', `/v3/config/paths/delete/${name}`);
      changes++;
    }
  }
  for (const [name, conf] of desired) {
    const cur = existing.get(name);
    if (conf.source === null) conf.source = cur?.source || HIK_PLACEHOLDER;
    if (!cur) {
      await api('POST', `/v3/config/paths/add/${name}`, conf);
      changes++;
    } else if (cur.source !== conf.source || cur.sourceOnDemand !== conf.sourceOnDemand ||
               cur.rtspTransport !== conf.rtspTransport ||
               cur.sourceOnDemandStartTimeout !== conf.sourceOnDemandStartTimeout ||
               cur.record !== conf.record || (conf.record && (cur.recordPath !== conf.recordPath ||
               durSec(cur.recordSegmentDuration) !== durSec(conf.recordSegmentDuration) ||
               cur.recordFormat !== conf.recordFormat))) {
      await api('PATCH', `/v3/config/paths/patch/${name}`, conf);
      changes++;
    }
  }
  await ensurePlayback().catch((e) => console.warn('[mediamtx] gagal mengaktifkan playback:', e.message));
  Object.assign(syncState, {
    ok: true, lastSync: new Date().toISOString(), lastError: null, pathCount: desired.size,
  });
  if (changes) console.log(`[mediamtx] sync: ${changes} perubahan, total ${desired.size} path`);
}

// Panggil setelah ada perubahan kamera/pengaturan. Aman dipanggil berkali-kali.
export function resetPlaybackCheck() { playbackChecked = false; }

export function scheduleSync() {
  if (syncing) { pending = true; return syncing; }
  syncing = doSync()
    .catch((e) => {
      if (syncState.ok || syncState.lastError !== e.message) {
        console.warn('[mediamtx] sync gagal:', e.message);
      }
      Object.assign(syncState, { ok: false, lastError: e.message });
    })
    .finally(() => {
      syncing = null;
      if (pending) { pending = false; scheduleSync(); }
    });
  return syncing;
}

export function startSyncLoop() {
  scheduleSync();
  setInterval(scheduleSync, config.syncIntervalSec * 1000).unref();
}

// ---------- authHTTP ----------
// Body dari MediaMTX: { user, password, token, ip, action, path, protocol, id, query }
function extractToken(b) {
  if (b.token) return b.token;
  if (b.query) {
    const t = new URLSearchParams(b.query).get('token');
    if (t) return t;
  }
  return b.password || '';
}

export function mediamtxAuthHandler(req, res) {
  // Endpoint ini hanya untuk MediaMTX di server yang sama.
  const ip = req.socket.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.sendStatus(403);

  const b = req.body || {};
  const deny = (why) => {
    if (b.action === 'read') console.log(`[auth] tolak ${b.path} dari ${b.ip}: ${why}`);
    return res.sendStatus(401);
  };

  if (b.action !== 'read') return deny('aksi ' + b.action);
  const m = PATH_RE.exec(b.path || '');
  if (!m) return deny('path tidak dikenal');

  const user = userFromToken(extractToken(b), 'stream');
  if (!user) return deny('token tidak valid / kedaluwarsa');
  if (user.guest && !guestIpAllowed(b.ip)) return deny('tamu dari IP yang tidak diizinkan');
  if (!canViewCamera(user, Number(m[1]))) return deny(`user ${user.username} tidak punya akses`);

  res.sendStatus(200);
}
