import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { config, IS_SEA } from './config.js';
import { getAsset as seaGetAsset } from 'node:sea';
import { db, tx, getSetting, setSetting, visibleCameras, canViewCamera, canControlPtz, maxTilesFor, ABSOLUTE_MAX_TILES } from './db.js';
import {
  hashPassword, verifyPassword, requireAuth, requireAdmin, setSessionCookie,
  requireViewer, currentViewer, guestEnabled, guestIpAllowed, sessionRemembered,
  clearSessionCookie, currentUser, makeStreamToken,
  loginBlocked, recordLoginFailure, clearLoginFailures,
} from './auth.js';
import { mediamtxAuthHandler, scheduleSync, startSyncLoop, syncState, pathName, prepareStream, resetPlaybackCheck } from './mediamtx.js';
import { hikConfig, hikListCameras } from './hikcentral.js';
import { startProbeLoop, cameraOnline, probeNow } from './status.js';
import { parseCsv } from './csv.js';
import { ptzCommand, PTZ_OPS, armWatchdog, clearWatchdog } from './ptz.js';
import { readNvr } from './nvr.js';
import { Readable } from 'node:stream';
import { recordSettings, recordStatus, startRecorderLoop, checkRecordPath, sweep } from './recorder.js';
import { exportMp4 } from './mp4export.js';

// ---------- Admin pertama ----------
// Password admin awal: dari installer (data/initial-admin.txt, langsung dihapus setelah dibaca),
// atau ADMIN_PASSWORD, atau acak (ditulis ke data/password-admin.txt supaya bisa dibaca admin).
if (!db.prepare('SELECT 1 FROM users WHERE is_admin = 1').get()) {
  const initFile = path.join(config.dataDir, 'initial-admin.txt');
  let fromInstaller = '';
  try { fromInstaller = fs.readFileSync(initFile, 'utf8').trim(); } catch {}
  const pw = fromInstaller || process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  if (!fromInstaller && !process.env.ADMIN_PASSWORD) {
    try {
      fs.writeFileSync(path.join(config.dataDir, 'password-admin.txt'),
        `Smart Camera - login admin awal\r\nusername: admin\r\npassword: ${pw}\r\n\r\nSegera ganti password setelah login, lalu hapus file ini.\r\n`);
    } catch {}
  }
  db.prepare('INSERT OR REPLACE INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)')
    .run('admin', hashPassword(pw));
  console.log('==============================================');
  console.log(' User admin dibuat.  username: admin');
  console.log(fromInstaller ? ' password: (yang diisi saat instalasi)' : ` password: ${pw}`);
  console.log(' Segera ganti password setelah login!');
  console.log('==============================================');
}
// File password dari installer selalu dihapus, dipakai atau tidak
try { fs.rmSync(path.join(config.dataDir, 'initial-admin.txt'), { force: true }); } catch {}

const app = express();
app.disable('x-powered-by');
// Header keamanan dasar: halaman tidak boleh dimasukkan ke iframe situs lain (clickjacking),
// browser tidak menebak tipe file, dan alamat halaman tidak dibocorkan ke situs lain.
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
if (config.trustProxy) app.set('trust proxy', 1);
app.use(express.json({ limit: '20mb' }));
app.use(express.text({ type: 'text/csv', limit: '2mb' }));

const wrap = (fn) => (req, res, next) => {
  try { fn(req, res, next); } catch (e) { next(e); }
};
const bad = (res, msg) => res.status(400).json({ error: msg });
const HOST_RE = /^[A-Za-z0-9.\-]+$/;

// ---------- Endpoint internal untuk MediaMTX ----------
app.post('/internal/mediamtx-auth', mediamtxAuthHandler);

// ---------- Auth ----------
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));
app.post('/api/login', wrap((req, res) => {
  const ip = req.ip;
  if (loginBlocked(ip)) return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi 10 menit lagi.' });
  const { username, password, remember } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
  // Username tidak ada tetap dicek ke hash palsu, supaya lama prosesnya sama
  // (orang tidak bisa menebak username mana yang terdaftar dari kecepatan jawaban).
  const ok = verifyPassword(String(password || ''), user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    recordLoginFailure(ip);
    return res.status(401).json({ error: 'Username atau password salah' });
  }
  clearLoginFailures(ip);
  // Selalu diingat (180 hari) kecuali klien minta remember=false secara eksplisit
  setSessionCookie(res, user, remember !== false && remember !== 'off' && remember !== '0');
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', requireViewer, (req, res) => {
  const group = req.user.group_id
    ? db.prepare('SELECT name FROM groups WHERE id = ?').get(req.user.group_id) : null;
  res.json({
    id: req.user.id, username: req.user.username, guest: !!req.user.guest,
    // Tamu & user bertanda monitor: tampilan hanya CCTV + playlist
    monitor: !!req.user.guest || (!!req.user.monitor && !req.user.is_admin),
    is_admin: !!req.user.is_admin, group: group?.name || null,
    max_tiles: maxTilesFor(req.user),
    can_ptz: canControlPtz(req.user),
    // Modul rekaman: tombol "Putar ulang" untuk user yang login (bukan tamu)
    record: recordSettings().enabled && !req.user.guest,
    features: { record: config.features.record },
  });
});

// ---------- Tampilan user: state terakhir & View tersimpan ----------
// Preset ("16"), custom ("c3x5"), atau custom dengan kotak gabungan ("g4x4:0.0.2.2,2.2.2.2")
const LAYOUT_RE = /^(\d{1,2}|c\d{1,2}x\d{1,2}|g\d{1,2}x\d{1,2}(:\d{1,2}\.\d{1,2}\.\d{1,2}\.\d{1,2}(,\d{1,2}\.\d{1,2}\.\d{1,2}\.\d{1,2}){0,31})?)$/;

function cleanLayoutAndSlots(b) {
  const layout = String(b.layout || '');
  if (!LAYOUT_RE.test(layout)) throw Object.assign(new Error('Layout tidak valid'), { status: 400 });
  if (!Array.isArray(b.slots) || b.slots.length > 2000) {
    throw Object.assign(new Error('Susunan kamera tidak valid'), { status: 400 });
  }
  const slots = b.slots.map((s) => (Number.isInteger(s) && s > 0 ? s : null));
  return { layout, slots };
}

app.get('/api/me/state', requireViewer, (req, res) => {
  if (req.user.guest) return res.json(null); // tamu: tampilan terakhir disimpan di browser
  const row = db.prepare('SELECT state FROM user_state WHERE user_id = ?').get(req.user.id);
  res.json(row ? JSON.parse(row.state) : null);
});

app.put('/api/me/state', requireAuth, wrap((req, res) => {
  const { layout, slots } = cleanLayoutAndSlots(req.body || {});
  const state = {
    layout, slots,
    page: Math.max(0, Number(req.body.page) || 0),
    viewId: Number(req.body.viewId) || null,
  };
  db.prepare(`INSERT INTO user_state (user_id, state) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET state = excluded.state`).run(req.user.id, JSON.stringify(state));
  res.json({ ok: true });
}));

// View milik sendiri + View yang dibagikan admin (tamu: hanya yang dibagikan)
app.get('/api/views', requireViewer, (req, res) => {
  const rows = req.user.guest
    ? db.prepare(`SELECT v.id, v.name, v.layout, v.slots, v.shared, v.user_id, u.username AS owner
        FROM views v JOIN users u ON u.id = v.user_id WHERE v.shared = 1 ORDER BY v.name`).all()
    : db.prepare(`SELECT v.id, v.name, v.layout, v.slots, v.shared, v.user_id, u.username AS owner
        FROM views v JOIN users u ON u.id = v.user_id WHERE v.user_id = ? OR v.shared = 1
        ORDER BY v.shared DESC, v.name`).all(req.user.id);
  res.json(rows.map(({ user_id, ...v }) => ({
    ...v, shared: !!v.shared, own: !req.user.guest && user_id === req.user.id, slots: JSON.parse(v.slots),
  })));
});

// Admin membagikan / berhenti membagikan View miliknya
app.put('/api/views/:id/share', requireAdmin, (req, res) => {
  const r = db.prepare('UPDATE views SET shared = ? WHERE id = ? AND user_id = ?')
    .run(req.body?.shared ? 1 : 0, Number(req.params.id), req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'View tidak ditemukan' });
  res.json({ ok: true });
});

app.post('/api/views', requireAuth, wrap((req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return bad(res, 'Nama view wajib diisi');
  const { layout, slots } = cleanLayoutAndSlots(req.body);
  // Nama sama = timpa view lama
  db.prepare(`INSERT INTO views (user_id, name, layout, slots) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, name) DO UPDATE SET layout = excluded.layout, slots = excluded.slots,
      updated_at = CURRENT_TIMESTAMP`).run(req.user.id, name, layout, JSON.stringify(slots));
  const v = db.prepare('SELECT id FROM views WHERE user_id = ? AND name = ?').get(req.user.id, name);
  res.json({ id: v.id });
}));

app.delete('/api/views/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM views WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/me/password', requireAuth, wrap((req, res) => {
  const { current, next: nextPw } = req.body || {};
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(current || ''), row.password_hash)) return bad(res, 'Password lama salah');
  if (String(nextPw || '').length < 6) return bad(res, 'Password baru minimal 6 karakter');
  db.prepare('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?')
    .run(hashPassword(nextPw), req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  setSessionCookie(res, user, sessionRemembered(req)); // pertahankan pilihan "Ingat saya"
  res.json({ ok: true });
}));

// ---------- Viewer ----------
app.get('/api/cameras', requireViewer, (req, res) => {
  res.json(visibleCameras(req.user).map((c) => ({
    ...c,
    online: cameraOnline(c.id),
    main: pathName(c.id, 'main'),
    sub: pathName(c.id, 'sub'),
  })));
});

// Dipanggil player sebelum memutar. Kamera HikCentral butuh URL baru tiap kali.
app.post('/api/prepare/:path', requireViewer, async (req, res) => {
  const m = /^cam(\d+)_(main|sub)$/.exec(req.params.path);
  if (!m) return res.status(400).json({ error: 'Path tidak valid' });
  const cam = db.prepare('SELECT * FROM cameras WHERE id = ? AND enabled = 1').get(Number(m[1]));
  if (!cam || !canViewCamera(req.user, cam.id)) return res.status(403).json({ error: 'Tidak punya akses' });
  try {
    await prepareStream(cam, m[2]);
    res.json({ ok: true });
  } catch (e) {
    console.warn(`[hikcentral] ${cam.name}: ${e.message}`);
    res.status(502).json({ error: e.message });
  }
});

// Kontrol PTZ: { op, action: 'start'|'stop', speed, preset }
const ptzLast = new Map(); // cameraId -> { user, at } (siapa terakhir menggerakkan)
app.post('/api/ptz/:id', requireAuth, async (req, res) => {
  const cam = db.prepare('SELECT * FROM cameras WHERE id = ? AND enabled = 1').get(Number(req.params.id));
  if (!cam || !canViewCamera(req.user, cam.id)) return res.status(403).json({ error: 'Tidak punya akses' });
  if (!cam.ptz) return res.status(400).json({ error: 'Kamera ini bukan PTZ' });
  if (!canControlPtz(req.user)) return res.status(403).json({ error: 'Grup Anda tidak diizinkan mengontrol PTZ' });
  const b = req.body || {};
  if (!PTZ_OPS.includes(b.op)) return res.status(400).json({ error: 'Perintah PTZ tidak dikenal' });
  const action = b.action === 'stop' ? 'stop' : 'start';
  try {
    await ptzCommand(cam, { op: b.op, action, speed: b.speed, preset: b.preset });
    if (action === 'start' && b.op !== 'preset') armWatchdog(cam, b.op); else clearWatchdog(cam.id);
    const prev = ptzLast.get(cam.id);
    if (action === 'start' && (!prev || prev.user !== req.user.username || Date.now() - prev.at > 60_000)) {
      console.log(`[ptz] ${req.user.username} menggerakkan "${cam.name}" (${b.op}${b.op === 'preset' ? ' ' + b.preset : ''})`);
    }
    if (action === 'start') ptzLast.set(cam.id, { user: req.user.username, at: Date.now() });
    res.json({ ok: true });
  } catch (e) {
    console.warn(`[ptz] ${cam.name}: ${e.message}`);
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/stream-token', requireViewer, (req, res) => {
  res.json({ ...makeStreamToken(req.user), webrtcUrl: config.webrtcUrl, webrtcPort: config.webrtcPort });
});

// ---------- Admin: kamera ----------
const httpErr = (msg) => Object.assign(new Error(msg), { status: 400 });

// Validasi URL RTSP. Kembalikan URL apa adanya (tanpa diubah) kalau valid.
function cleanRtspUrl(raw, label) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { throw httpErr(`${label} bukan URL yang valid`); }
  if (!['rtsp:', 'rtsps:'].includes(u.protocol)) throw httpErr(`${label} harus diawali rtsp://`);
  if (!u.hostname) throw httpErr(`${label} tidak punya alamat IP/host`);
  return s;
}

// Sembunyikan password di URL sebelum dikirim ke browser admin
function maskUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.href;
  } catch { return url; }
}

// Kalau admin menyimpan URL yang password-nya masih "***", pakai password lama
function unmaskUrl(url, previous) {
  if (!url || !previous) return url;
  try {
    const u = new URL(url), p = new URL(previous);
    if (u.password === '***' && u.username === p.username && u.hostname === p.hostname) {
      u.password = p.password;
      return u.href;
    }
  } catch {}
  return url;
}

function cleanCamera(b, existing = {}) {
  const cam = {
    name: String(b.name ?? existing.name ?? '').trim(),
    location: String(b.location ?? existing.location ?? '').trim(),
    enabled: b.enabled === undefined ? (existing.enabled ?? 1) : (b.enabled ? 1 : 0),
    ptz: b.ptz === undefined ? (existing.ptz ?? 0) : (b.ptz && b.ptz !== '0' ? 1 : 0),
    http_port: Number(b.http_port || existing.http_port || 80),
  };
  if (!(cam.http_port > 0 && cam.http_port < 65536)) throw httpErr('Port HTTP tidak valid');
  if (!cam.name) throw httpErr('Nama kamera wajib diisi');

  // ---- Mode HikCentral (URL diminta otomatis lewat OpenAPI) ----
  const hik = b.hik_code === undefined ? existing.hik_code : String(b.hik_code || '').trim();
  if (hik) {
    let host = '';
    try { host = new URL(hikConfig().host.includes('://') ? hikConfig().host : `https://${hikConfig().host}`).hostname; } catch {}
    return Object.assign(cam, {
      hik_code: hik, rtsp_main: null, rtsp_sub: null, username: null, password: null,
      ip: host || 'hikcentral', port: 554, channel: 1,
    });
  }
  cam.hik_code = null;

  // undefined = tidak diubah, '' = kembali ke mode Dahua
  const main =b.rtsp_main === undefined ? existing.rtsp_main : unmaskUrl(b.rtsp_main, existing.rtsp_main);
  if (main) {
    // ---- Mode URL RTSP ----
    cam.rtsp_main = cleanRtspUrl(main, 'URL main stream');
    const sub = b.rtsp_sub === undefined ? existing.rtsp_sub : unmaskUrl(b.rtsp_sub, existing.rtsp_sub);
    cam.rtsp_sub = cleanRtspUrl(sub, 'URL substream');
    const u = new URL(cam.rtsp_main);
    cam.ip = u.hostname;
    cam.port = Number(u.port) || 554;
    cam.channel = Number(u.searchParams.get('channel')) || 1;
    cam.username = null;
    cam.password = null;
    return cam;
  }

  // ---- Mode Dahua (IP + channel) ----
  Object.assign(cam, {
    rtsp_main: null,
    rtsp_sub: null,
    ip: String(b.ip ?? (existing.rtsp_main ? '' : existing.ip) ?? '').trim(),
    port: Number(b.port || existing.port || 554),
    channel: Number(b.channel || existing.channel || 1),
    // '' atau null = pakai default. undefined = tidak diubah.
    username: b.username === undefined ? existing.username ?? null : (String(b.username).trim() || null),
    password: b.password === undefined ? existing.password ?? null : (b.password === '' ? null : String(b.password)),
  });
  if (!HOST_RE.test(cam.ip)) throw httpErr(`IP tidak valid: ${cam.ip || '(kosong)'}`);
  if (!(cam.port > 0 && cam.port < 65536)) throw httpErr('Port tidak valid');
  if (!(cam.channel >= 1 && cam.channel <= 256)) throw httpErr('Channel tidak valid');
  return cam;
}

function cameraForAdmin(c) {
  const { password, ...rest } = c;
  return {
    ...rest,
    rtsp_main: maskUrl(c.rtsp_main),
    rtsp_sub: maskUrl(c.rtsp_sub),
    has_password: password !== null,
    online: cameraOnline(c.id),
  };
}

const CAM_COLS = ['name', 'location', 'ip', 'port', 'channel', 'username', 'password', 'enabled', 'rtsp_main', 'rtsp_sub', 'hik_code', 'ptz', 'http_port'];
const camValues = (c) => CAM_COLS.map((k) => c[k] ?? null);

function insertCamera(c) {
  return Number(db.prepare(`INSERT INTO cameras (${CAM_COLS.join(', ')}) VALUES (${CAM_COLS.map(() => '?').join(', ')})`)
    .run(...camValues(c)).lastInsertRowid);
}

function updateCamera(id, c) {
  db.prepare(`UPDATE cameras SET ${CAM_COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...camValues(c), id);
}

// Pesan yang jelas kalau kamera Dahua dobel
function friendlyDbError(e) {
  if (/UNIQUE/i.test(e.message) && /hik_code/.test(e.message)) return httpErr('Kamera HikCentral dengan kode ini sudah ada');
  if (/UNIQUE/i.test(e.message)) return httpErr('Kamera dengan IP, port, dan channel yang sama sudah ada');
  return e;
}

app.get('/api/admin/cameras', requireAdmin, (req, res) => {
  const cams = db.prepare('SELECT * FROM cameras ORDER BY location, name').all();
  const groups = db.prepare('SELECT camera_id, group_id FROM group_cameras').all();
  const byCam = new Map();
  for (const g of groups) (byCam.get(g.camera_id) || byCam.set(g.camera_id, []).get(g.camera_id)).push(g.group_id);
  res.json(cams.map((c) => ({ ...cameraForAdmin(c), group_ids: byCam.get(c.id) || [] })));
});

app.post('/api/admin/cameras', requireAdmin, wrap((req, res) => {
  const c = cleanCamera(req.body || {});
  let id;
  try { id = insertCamera(c); } catch (e) { throw friendlyDbError(e); }
  scheduleSync(); probeNow();
  res.json({ id });
}));

app.put('/api/admin/cameras/:id', requireAdmin, wrap((req, res) => {
  const existing = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Kamera tidak ditemukan' });
  const c = cleanCamera(req.body || {}, existing);
  try { updateCamera(existing.id, c); } catch (e) { throw friendlyDbError(e); }
  scheduleSync(); probeNow();
  res.json({ ok: true });
}));

app.delete('/api/admin/cameras/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM cameras WHERE id = ?').run(req.params.id);
  scheduleSync();
  res.json({ ok: true });
});

// Aksi untuk banyak kamera sekaligus (checkbox di tabel)
app.post('/api/admin/cameras/bulk', requireAdmin, wrap((req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter((n) => n > 0);
  if (!ids.length) return bad(res, 'Belum ada kamera yang dipilih');
  const action = req.body.action;
  const n = tx(() => {
    let count = 0;
    for (const id of ids) {
      if (action === 'delete') count += Number(db.prepare('DELETE FROM cameras WHERE id = ?').run(id).changes);
      else if (action === 'enable' || action === 'disable') {
        count += Number(db.prepare('UPDATE cameras SET enabled = ? WHERE id = ?').run(action === 'enable' ? 1 : 0, id).changes);
      } else throw httpErr('Aksi tidak dikenal');
    }
    return count;
  });
  scheduleSync();
  res.json({ ok: true, count: n });
}));

// ---------- Backup & restore ----------
const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  // Cegah "formula injection": sel yang diawali = + - @ dibaca Excel sebagai rumus.
  // Diberi tanda ' di depan; tanda ini dibuang lagi saat Import CSV.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
// Waktu lokal untuk nama file, mis. 20261107-231502
const stamp = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
function cameraGroupNames() {
  const map = new Map();
  for (const r of db.prepare('SELECT gc.camera_id, g.name FROM group_cameras gc JOIN groups g ON g.id = gc.group_id ORDER BY g.name').all()) {
    (map.get(r.camera_id) || map.set(r.camera_id, []).get(r.camera_id)).push(r.name);
  }
  return map;
}

function buildBackup(parts) {
  const out = { app: 'cctv-backup', version: 1, created_at: new Date().toISOString() };
  if (parts.includes('cameras')) {
    const groupsOf = cameraGroupNames();
    out.cameras = db.prepare('SELECT * FROM cameras ORDER BY location, name').all()
      .map(({ id, ...c }) => ({ ...c, groups: groupsOf.get(id) || [] }));
    out.groups = db.prepare('SELECT name, max_tiles, can_ptz FROM groups ORDER BY name').all();
  }
  if (parts.includes('users')) {
    out.groups ??= db.prepare('SELECT name, max_tiles, can_ptz FROM groups ORDER BY name').all();
    out.users = db.prepare(`SELECT u.username, u.password_hash, u.is_admin, u.can_ptz, u.monitor, g.name AS group_name, u.created_at
      FROM users u LEFT JOIN groups g ON g.id = u.group_id ORDER BY u.username`).all();
  }
  return out;
}

// Backup JSON: ?parts=cameras,users (default keduanya)
app.get('/api/admin/backup', requireAdmin, (req, res) => {
  const parts = String(req.query.parts || 'cameras,users').split(',');
  const name = parts.length === 1 ? parts[0] : 'lengkap';
  res.setHeader('Content-Disposition', `attachment; filename="backup-cctv-${name}-${stamp()}.json"`);
  res.json(buildBackup(parts));
});

// Backup kamera dalam CSV (bisa dibuka di Excel dan di-import lagi lewat Import CSV)
app.get('/api/admin/backup/cameras.csv', requireAdmin, (req, res) => {
  const groupsOf = cameraGroupNames();
  const head = ['nama', 'lokasi', 'ip', 'port', 'channel', 'username', 'password', 'rtsp', 'rtsp_sub', 'hik_code', 'ptz', 'http_port', 'aktif', 'grup'];
  const rows = db.prepare('SELECT * FROM cameras ORDER BY location, name').all().map((c) => [
    c.name, c.location, c.rtsp_main || c.hik_code ? '' : c.ip, c.rtsp_main || c.hik_code ? '' : c.port,
    c.rtsp_main || c.hik_code ? '' : c.channel, c.username, c.password, c.rtsp_main, c.rtsp_sub, c.hik_code,
    c.ptz ? 1 : 0, c.http_port, c.enabled ? 1 : 0, (groupsOf.get(c.id) || []).join('|'),
  ].map(csvCell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="backup-cctv-kamera-${stamp()}.csv"`);
  res.send('\ufeff' + [head.join(','), ...rows].join('\r\n'));
});

// Restore dari file backup JSON. Sifatnya MENGGABUNG: data yang ada di backup
// ditambahkan / diperbarui, data yang tidak ada di backup tidak dihapus.
// Sebelum restore, salinan data sekarang disimpan otomatis di folder data/backup.
app.post('/api/admin/restore', requireAdmin, wrap((req, res) => {
  const b = req.body?.backup;
  const parts = Array.isArray(req.body?.parts) ? req.body.parts : ['cameras', 'users'];
  if (!b || b.app !== 'cctv-backup') return bad(res, 'File ini bukan backup CCTV yang valid');

  const dir = path.join(config.dataDir, 'backup');
  fs.mkdirSync(dir, { recursive: true });
  const safety = path.join(dir, `sebelum-restore-${stamp()}.json`);
  fs.writeFileSync(safety, JSON.stringify(buildBackup(['cameras', 'users']), null, 1));

  const result = { groups: 0, cameras_added: 0, cameras_updated: 0, users_added: 0, users_updated: 0, errors: [] };
  tx(() => {
    const groupId = (name) => {
      if (!name) return null;
      db.prepare('INSERT OR IGNORE INTO groups (name) VALUES (?)').run(name);
      return db.prepare('SELECT id FROM groups WHERE name = ?').get(name).id;
    };
    for (const g of b.groups || []) {
      if (!g?.name) continue;
      const exists = db.prepare('SELECT 1 FROM groups WHERE name = ?').get(g.name);
      const id = groupId(g.name);
      db.prepare('UPDATE groups SET max_tiles = ?, can_ptz = ? WHERE id = ?').run(g.max_tiles ?? null, g.can_ptz ? 1 : 0, id);
      if (!exists) result.groups++;
    }
    if (parts.includes('cameras')) {
      for (const c of b.cameras || []) {
        try {
          const found = c.hik_code ? db.prepare('SELECT id FROM cameras WHERE hik_code = ?').get(c.hik_code)
            : c.rtsp_main ? db.prepare('SELECT id FROM cameras WHERE rtsp_main = ?').get(c.rtsp_main)
            : db.prepare('SELECT id FROM cameras WHERE ip = ? AND port = ? AND channel = ? AND rtsp_main IS NULL AND hik_code IS NULL')
              .get(c.ip, c.port, c.channel);
          const row = Object.fromEntries(CAM_COLS.map((k) => [k, c[k] ?? null]));
          row.enabled = c.enabled ? 1 : 0; row.ptz = c.ptz ? 1 : 0; row.http_port = c.http_port || 80;
          row.port = c.port || 554; row.channel = c.channel || 1; row.location = c.location || '';
          if (!row.name || !row.ip) throw new Error('nama/ip kosong');
          let id;
          if (found) { id = found.id; updateCamera(id, row); result.cameras_updated++; }
          else { id = insertCamera(row); result.cameras_added++; }
          for (const gname of c.groups || []) {
            db.prepare('INSERT OR IGNORE INTO group_cameras (group_id, camera_id) VALUES (?, ?)').run(groupId(gname), id);
          }
        } catch (e) { result.errors.push(`Kamera "${c?.name || '?'}": ${e.message}`); }
      }
    }
    if (parts.includes('users')) {
      for (const u of b.users || []) {
        try {
          if (!/^[A-Za-z0-9._-]{3,32}$/.test(u?.username || '') || !u.password_hash) throw new Error('data tidak lengkap');
          const gid = groupId(u.group_name);
          const found = db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(u.username);
          if (found) {
            // Sesi hanya direset kalau password-nya memang berubah
            // (supaya admin yang sedang restore tidak ikut ter-logout).
            const pwChanged = found.password_hash !== u.password_hash ? 1 : 0;
            db.prepare(`UPDATE users SET password_hash = ?, is_admin = ?, can_ptz = ?, monitor = ?, group_id = ?,
              session_version = session_version + ? WHERE id = ?`)
              .run(u.password_hash, u.is_admin ? 1 : 0, u.can_ptz ? 1 : 0, u.monitor ? 1 : 0, gid, pwChanged, found.id);
            result.users_updated++;
          } else {
            db.prepare('INSERT INTO users (username, password_hash, is_admin, can_ptz, monitor, group_id) VALUES (?, ?, ?, ?, ?, ?)')
              .run(u.username, u.password_hash, u.is_admin ? 1 : 0, u.can_ptz ? 1 : 0, u.monitor ? 1 : 0, gid);
            result.users_added++;
          }
        } catch (e) { result.errors.push(`User "${u?.username || '?'}": ${e.message}`); }
      }
      // Jangan sampai tidak ada admin sama sekali
      if (!db.prepare('SELECT 1 FROM users WHERE is_admin = 1').get()) throw httpErr('Restore dibatalkan: hasilnya tidak ada admin');
    }
  });
  scheduleSync(); probeNow();
  console.log(`[backup] restore oleh ${req.user.username}; salinan sebelum restore: ${safety}`);
  res.json({ ok: true, ...result });
}));

// Import CSV. Kolom: nama, lokasi, ip, port, channel, username, password, rtsp, rtsp_sub, grup
//  - Isi "rtsp" (URL lengkap) untuk mode URL RTSP; kalau kosong pakai mode Dahua (ip + channel).
//  - Grup boleh lebih dari satu dipisah "|".
//  - Kamera yang sudah ada (ip+port+channel sama, atau URL rtsp sama) di-update, bukan diduplikasi.
app.post('/api/admin/cameras/import', requireAdmin, wrap((req, res) => {
  const rows = parseCsv(typeof req.body === 'string' ? req.body : req.body?.csv || '');
  if (!rows.length) return bad(res, 'CSV kosong atau tidak ada baris data');
  const pick = (r, ...keys) => {
    for (const k of keys) {
      if (r[k] === undefined || r[k] === '') continue;
      return String(r[k]).replace(/^'(?=[=+\-@\t\r])/, ''); // lihat csvCell (backup CSV)
    }
  };

  const result = { added: 0, updated: 0, errors: [] };
  tx(() => {
    rows.forEach((r, i) => {
      try {
        const input = {
          name: pick(r, 'nama', 'name'),
          location: pick(r, 'lokasi', 'location') ?? '',
          ip: pick(r, 'ip', 'ip address', 'alamat ip'),
          port: pick(r, 'port'),
          channel: pick(r, 'channel', 'ch'),
          username: pick(r, 'username', 'user'),
          password: pick(r, 'password', 'pass'),
          rtsp_main: pick(r, 'rtsp', 'rtsp_main', 'url', 'url rtsp') ?? '',
          rtsp_sub: pick(r, 'rtsp_sub', 'url sub') ?? '',
          http_port: pick(r, 'http_port', 'port http'),
          hik_code: pick(r, 'hik_code', 'kode hikcentral') ?? '',
        };
        const ptzRaw = pick(r, 'ptz');
        if (ptzRaw !== undefined && ptzRaw !== '') input.ptz = /^(1|ya|y|yes|true)$/i.test(String(ptzRaw).trim());
        const c = cleanCamera(input);
        const found = c.hik_code
          ? db.prepare('SELECT * FROM cameras WHERE hik_code = ?').get(c.hik_code)
          : c.rtsp_main
          ? db.prepare('SELECT * FROM cameras WHERE rtsp_main = ?').get(c.rtsp_main)
          : db.prepare('SELECT * FROM cameras WHERE ip = ? AND port = ? AND channel = ? AND rtsp_main IS NULL')
            .get(c.ip, c.port, c.channel);
        let id;
        if (found) {
          // Login kosong di CSV = jangan hapus login yang sudah tersimpan
          if (!c.rtsp_main) {
            c.username = c.username ?? found.username;
            c.password = c.password ?? found.password;
          }
          c.enabled = found.enabled;
          if (input.ptz === undefined) c.ptz = found.ptz;
          if (!input.http_port) c.http_port = found.http_port;
          updateCamera(found.id, c);
          id = found.id; result.updated++;
        } else {
          id = insertCamera(c);
          result.added++;
        }
        const groups = (pick(r, 'grup', 'group') || '').split('|').map((s) => s.trim()).filter(Boolean);
        for (const g of groups) {
          db.prepare('INSERT OR IGNORE INTO groups (name) VALUES (?)').run(g);
          const gid = db.prepare('SELECT id FROM groups WHERE name = ?').get(g).id;
          db.prepare('INSERT OR IGNORE INTO group_cameras (group_id, camera_id) VALUES (?, ?)').run(gid, id);
        }
      } catch (e) {
        result.errors.push(`Baris ${i + 2}: ${e.message}`);
      }
    });
  });
  scheduleSync(); probeNow();
  res.json(result);
}));

// ---------- Admin: grup ----------
app.get('/api/admin/groups', requireAdmin, (req, res) => {
  const groups = db.prepare(`SELECT g.id, g.name, g.max_tiles, g.can_ptz,
      (SELECT COUNT(*) FROM group_cameras WHERE group_id = g.id) AS camera_count,
      (SELECT COUNT(*) FROM users WHERE group_id = g.id) AS user_count
    FROM groups g ORDER BY g.name`).all();
  const links = db.prepare('SELECT group_id, camera_id FROM group_cameras').all();
  for (const g of groups) g.camera_ids = links.filter((l) => l.group_id === g.id).map((l) => l.camera_id);
  res.json(groups);
});

function saveGroup(id, b) {
  const name = String(b.name || '').trim();
  if (!name) throw Object.assign(new Error('Nama grup wajib diisi'), { status: 400 });
  const maxTiles = b.max_tiles ? Math.min(ABSOLUTE_MAX_TILES, Math.max(1, Number(b.max_tiles) || 0)) : null;
  return tx(() => {
    if (id) {
      db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, id);
      if (b.max_tiles !== undefined) db.prepare('UPDATE groups SET max_tiles = ? WHERE id = ?').run(maxTiles, id);
      if (b.can_ptz !== undefined) db.prepare('UPDATE groups SET can_ptz = ? WHERE id = ?').run(b.can_ptz ? 1 : 0, id);
    } else {
      id = Number(db.prepare('INSERT INTO groups (name, max_tiles, can_ptz) VALUES (?, ?, ?)').run(name, maxTiles, b.can_ptz ? 1 : 0).lastInsertRowid);
    }
    if (Array.isArray(b.camera_ids)) {
      db.prepare('DELETE FROM group_cameras WHERE group_id = ?').run(id);
      const ins = db.prepare('INSERT OR IGNORE INTO group_cameras (group_id, camera_id) SELECT ?, id FROM cameras WHERE id = ?');
      for (const cid of b.camera_ids) ins.run(id, Number(cid));
    }
    return id;
  });
}

app.post('/api/admin/groups', requireAdmin, wrap((req, res) => res.json({ id: saveGroup(null, req.body || {}) })));
app.put('/api/admin/groups/:id', requireAdmin, wrap((req, res) => {
  saveGroup(Number(req.params.id), req.body || {});
  res.json({ ok: true });
}));
app.delete('/api/admin/groups/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Admin: user ----------
app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT u.id, u.username, u.is_admin, u.can_ptz, u.monitor, u.group_id, g.name AS group_name, u.created_at
    FROM users u LEFT JOIN groups g ON g.id = u.group_id ORDER BY u.username`).all());
});

app.post('/api/admin/users', requireAdmin, wrap((req, res) => {
  const { username, password, is_admin, group_id, can_ptz, monitor } = req.body || {};
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(name)) return bad(res, 'Username 3-32 karakter: huruf, angka, titik, minus, underscore');
  if (String(password || '').length < 6) return bad(res, 'Password minimal 6 karakter');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) return bad(res, 'Username sudah dipakai');
  const r = db.prepare('INSERT INTO users (username, password_hash, is_admin, group_id, can_ptz, monitor) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, hashPassword(password), is_admin ? 1 : 0, group_id ? Number(group_id) : null, can_ptz ? 1 : 0, monitor ? 1 : 0);
  res.json({ id: Number(r.lastInsertRowid) });
}));

app.put('/api/admin/users/:id', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
  const { password, is_admin, group_id, can_ptz, monitor } = req.body || {};
  const makeAdmin = is_admin === undefined ? user.is_admin : (is_admin ? 1 : 0);
  if (user.is_admin && !makeAdmin &&
      db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n <= 1) {
    return bad(res, 'Minimal harus ada satu admin');
  }
  if (password && String(password).length < 6) return bad(res, 'Password minimal 6 karakter');
  db.prepare('UPDATE users SET is_admin = ?, group_id = ? WHERE id = ?')
    .run(makeAdmin, group_id === undefined ? user.group_id : (group_id ? Number(group_id) : null), id);
  if (can_ptz !== undefined) db.prepare('UPDATE users SET can_ptz = ? WHERE id = ?').run(can_ptz ? 1 : 0, id);
  if (monitor !== undefined) db.prepare('UPDATE users SET monitor = ? WHERE id = ?').run(monitor ? 1 : 0, id);
  if (password) {
    db.prepare('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?')
      .run(hashPassword(password), id);
  }
  res.json({ ok: true });
}));

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return bad(res, 'Tidak bisa menghapus akun sendiri');
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- Admin: pengaturan ----------
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({
    default_cam_user: getSetting('default_cam_user', ''),
    has_default_cam_pass: getSetting('default_cam_pass', '') !== '',
    default_max_tiles: Number(getSetting('default_max_tiles', '36')) || 36,
    hik_host: getSetting('hik_host', ''),
    hik_app_key: getSetting('hik_app_key', ''),
    has_hik_app_secret: getSetting('hik_app_secret', '') !== '',
    hik_insecure: getSetting('hik_insecure', '1') === '1',
    guest_enabled: getSetting('guest_enabled', '0') === '1',
    guest_group_id: Number(getSetting('guest_group_id', '')) || null,
    guest_ips: getSetting('guest_ips', ''),
    mediamtx: syncState,
  });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (b.default_cam_user !== undefined) setSetting('default_cam_user', String(b.default_cam_user).trim());
  if (b.default_cam_pass) setSetting('default_cam_pass', String(b.default_cam_pass));
  if (b.hik_host !== undefined) setSetting('hik_host', String(b.hik_host).trim());
  if (b.hik_app_key !== undefined) setSetting('hik_app_key', String(b.hik_app_key).trim());
  if (b.hik_app_secret) setSetting('hik_app_secret', String(b.hik_app_secret));
  if (b.hik_insecure !== undefined) setSetting('hik_insecure', b.hik_insecure ? '1' : '0');
  if (b.guest_enabled !== undefined) setSetting('guest_enabled', b.guest_enabled ? '1' : '0');
  if (b.guest_group_id !== undefined) setSetting('guest_group_id', b.guest_group_id ? String(Number(b.guest_group_id)) : '');
  if (b.guest_ips !== undefined) {
    const ips = String(b.guest_ips).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    const bad = ips.find((s) => !/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^(\d{1,3}\.){1,3}$/.test(s));
    if (bad) return res.status(400).json({ error: `Format IP tidak dikenal: ${bad}` });
    setSetting('guest_ips', ips.join(', '));
  }
  if (b.default_max_tiles !== undefined) {
    const n = Math.min(ABSOLUTE_MAX_TILES, Math.max(1, Number(b.default_max_tiles) || 36));
    setSetting('default_max_tiles', String(n));
  }
  scheduleSync();
  res.json({ ok: true });
});

// ---------- Admin: HikCentral ----------
// Daftar kamera di HikCentral + tanda mana yang sudah di-import
app.get('/api/admin/hik/cameras', requireAdmin, async (req, res) => {
  try {
    const list = await hikListCameras();
    const imported = new Set(db.prepare('SELECT hik_code FROM cameras WHERE hik_code IS NOT NULL').all().map((r) => r.hik_code));
    res.json(list.map((c) => ({ ...c, imported: imported.has(c.code) })));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/admin/hik/import', requireAdmin, wrap((req, res) => {
  const { cameras = [], location = '', group_id = null } = req.body || {};
  if (!Array.isArray(cameras) || !cameras.length) return bad(res, 'Pilih minimal satu kamera');
  const result = { added: 0, skipped: 0 };
  tx(() => {
    for (const c of cameras) {
      const code = String(c.code || '').trim();
      if (!code || db.prepare('SELECT 1 FROM cameras WHERE hik_code = ?').get(code)) { result.skipped++; continue; }
      const cam = cleanCamera({ name: String(c.name || code), location, hik_code: code });
      const id = insertCamera(cam);
      if (group_id) db.prepare('INSERT OR IGNORE INTO group_cameras (group_id, camera_id) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM groups WHERE id = ?)')
        .run(Number(group_id), id, Number(group_id));
      result.added++;
    }
  });
  scheduleSync(); probeNow();
  res.json(result);
}));

// ---------- Admin: tambah NVR (baca semua channel sekaligus) ----------
function nvrLogin(b) {
  const ip = String(b.ip || '').trim();
  if (!HOST_RE.test(ip)) throw httpErr(`IP NVR tidak valid: ${ip || '(kosong)'}`);
  const http_port = Number(b.http_port || 80), rtsp_port = Number(b.rtsp_port || 554);
  if (!(http_port > 0 && http_port < 65536) || !(rtsp_port > 0 && rtsp_port < 65536)) throw httpErr('Port tidak valid');
  // Login kosong = pakai login default kamera dari Pengaturan
  const username = String(b.username || '').trim() || null;
  const password = b.password ? String(b.password) : null;
  return {
    ip, http_port, rtsp_port, username, password,
    user: username ?? getSetting('default_cam_user', ''),
    pass: password ?? getSetting('default_cam_pass', ''),
  };
}

app.post('/api/admin/nvr/scan', requireAdmin, async (req, res) => {
  try {
    const n = nvrLogin(req.body || {});
    const info = await readNvr({ host: n.ip, port: n.http_port, user: n.user, pass: n.pass });
    const existing = new Map(db.prepare(
      'SELECT channel, name FROM cameras WHERE ip = ? AND port = ? AND rtsp_main IS NULL AND hik_code IS NULL',
    ).all(n.ip, n.rtsp_port).map((r) => [r.channel, r.name]));
    res.json({
      ...info,
      channels: info.channels.map((c) => ({ ...c, registered: existing.has(c.channel), registered_name: existing.get(c.channel) || null })),
    });
  } catch (e) {
    const msg = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|timeout/i.test(e.message)
      ? `NVR tidak bisa dihubungi di port HTTP ${req.body?.http_port || 80} (${e.message})` : e.message;
    res.status(e.status === 400 ? 400 : 502).json({ error: msg });
  }
});

app.post('/api/admin/nvr/import', requireAdmin, wrap((req, res) => {
  const b = req.body || {};
  const n = nvrLogin(b);
  const list = Array.isArray(b.channels) ? b.channels : [];
  if (!list.length) return bad(res, 'Pilih minimal satu channel');
  const groupId = b.group_id ? Number(b.group_id) : null;
  const result = { added: 0, updated: 0, skipped: 0 };
  tx(() => {
    for (const ch of list) {
      const channel = Number(ch.channel);
      const name = String(ch.name || '').trim() || `Channel ${channel}`;
      const found = db.prepare('SELECT * FROM cameras WHERE ip = ? AND port = ? AND channel = ? AND rtsp_main IS NULL AND hik_code IS NULL')
        .get(n.ip, n.rtsp_port, channel);
      let id;
      if (found) {
        if (!b.update_existing) { result.skipped++; continue; }
        const c = cleanCamera({ name, location: b.location ?? found.location, ptz: ch.ptz ?? found.ptz }, found);
        updateCamera(found.id, c);
        id = found.id;
        result.updated++;
      } else {
        const c = cleanCamera({
          name, location: String(b.location || '').trim(), ip: n.ip, port: n.rtsp_port, channel,
          username: n.username ?? '', password: n.password ?? '', ptz: !!ch.ptz, http_port: n.http_port,
        });
        id = insertCamera(c);
        result.added++;
      }
      if (groupId) {
        db.prepare('INSERT OR IGNORE INTO group_cameras (group_id, camera_id) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM groups WHERE id = ?)')
          .run(groupId, id, groupId);
      }
    }
  });
  scheduleSync(); probeNow();
  console.log(`[nvr] ${req.user.username} import dari NVR ${n.ip}: +${result.added}, diperbarui ${result.updated}, dilewati ${result.skipped}`);
  res.json(result);
}));

// ---------- Modul rekaman ----------
const recordOn = (req, res, next) => (recordSettings().enabled ? next()
  : res.status(404).json({ error: 'Modul rekaman tidak aktif' }));

// Admin: pengaturan + status + daftar kamera
const recordInstalled = (req, res, next) => (config.features.record ? next()
  : res.status(404).json({ error: 'Modul rekaman tidak terpasang' }));
app.get('/api/admin/record', requireAdmin, recordInstalled, (req, res) => {
  const st = recordStatus();
  const per = new Map(st.cameras.map((c) => [`${c.cam}_${c.quality}`, c]));
  const cams = db.prepare('SELECT id, name, location, enabled, record, record_quality, hik_code FROM cameras ORDER BY location, name').all();
  res.json({
    settings: st.settings, disk: st.disk, used: st.used, oldest: st.oldest,
    cameras: cams.map((c) => {
      const s = per.get(`${c.id}_${c.record_quality || 'main'}`);
      return {
        id: c.id, name: c.name, location: c.location, enabled: !!c.enabled,
        record: !!c.record, quality: c.record_quality || 'main', supported: !c.hik_code,
        size: s?.size || 0, oldest: s?.oldest || null, active: !!s?.active,
      };
    }),
  });
});

app.put('/api/admin/record', requireAdmin, recordInstalled, wrap((req, res) => {
  const b = req.body || {};
  if (b.record_path !== undefined) {
    const p = String(b.record_path || '').trim();
    if (p) {
      if (!path.isAbsolute(p)) return bad(res, 'Folder rekaman harus alamat lengkap, mis. D:\\CCTV-Rekaman');
      try { setSetting('record_path', checkRecordPath(p)); } catch (e) { return bad(res, `Folder tidak bisa ditulis: ${e.message}`); }
    } else setSetting('record_path', '');
  }
  const num = (k, min, max) => {
    if (b[k] === undefined) return;
    const n = Number(b[k]);
    if (!Number.isFinite(n) || n < min || n > max) throw Object.assign(new Error(`Nilai ${k} harus ${min}–${max}`), { status: 400 });
    setSetting(k, String(Math.round(n)));
  };
  num('record_min_free_gb', 0, 100000);
  num('record_max_days', 0, 3650);
  num('record_segment_min', 1, 60);
  if (b.record_enabled !== undefined) setSetting('record_enabled', b.record_enabled ? '1' : '0');
  resetPlaybackCheck();
  scheduleSync();
  res.json({ ok: true });
}));

// Admin: centang kamera yang direkam (bisa banyak sekaligus)
app.put('/api/admin/record/cameras', requireAdmin, recordInstalled, wrap((req, res) => {
  const b = req.body || {};
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => n > 0);
  if (!ids.length) return bad(res, 'Belum ada kamera yang dipilih');
  if (b.quality !== undefined && !['main', 'sub'].includes(b.quality)) return bad(res, 'Kualitas harus main atau sub');
  tx(() => {
    for (const id of ids) {
      if (b.record !== undefined) db.prepare('UPDATE cameras SET record = ? WHERE id = ?').run(b.record ? 1 : 0, id);
      if (b.quality !== undefined) db.prepare('UPDATE cameras SET record_quality = ? WHERE id = ?').run(b.quality, id);
    }
  });
  scheduleSync();
  res.json({ ok: true });
}));

app.post('/api/admin/record/sweep', requireAdmin, recordOn, (req, res) => res.json(sweep()));

// ---- Putar ulang (user login; izin grup tetap berlaku) ----
function playbackCamera(req, res) {
  const id = Number(req.query.cam);
  const q = req.query.q === 'sub' ? 'sub' : 'main';
  if (!id || !canViewCamera(req.user, id)) { res.status(403).json({ error: 'Tidak punya akses ke kamera ini' }); return null; }
  return { id, q, path: pathName(id, q) };
}

// Kamera yang boleh dilihat user + punya rekaman
app.get('/api/playback/cameras', requireAuth, recordOn, (req, res) => {
  const st = recordStatus();
  const rec = new Map();
  for (const c of st.cameras) (rec.get(c.cam) || rec.set(c.cam, []).get(c.cam)).push(c.quality);
  res.json(visibleCameras(req.user).filter((c) => rec.has(c.id))
    .map((c) => ({ ...c, qualities: rec.get(c.id) })));
});

// Rentang waktu yang tersedia (dari MediaMTX) + kunci
app.get('/api/playback/list', requireAuth, recordOn, async (req, res) => {
  const cam = playbackCamera(req, res);
  if (!cam) return;
  try {
    const r = await fetch(`${config.mediamtxPlayback}/list?path=${cam.path}`, { signal: AbortSignal.timeout(8000) });
    const ranges = r.ok ? (await r.json()).map((x) => ({ start: x.start, duration: x.duration })) : [];
    const locks = db.prepare('SELECT id, start_at, end_at, note, created_by FROM record_locks WHERE camera_id = ? ORDER BY start_at').all(cam.id);
    res.json({ ranges, locks });
  } catch (e) {
    res.status(502).json({ error: 'Server playback MediaMTX tidak bisa dihubungi: ' + e.message });
  }
});

// Video rekaman (fMP4). ?download=1 -> file unduhan
app.get('/api/playback/get', requireAuth, recordOn, async (req, res) => {
  const cam = playbackCamera(req, res);
  if (!cam) return;
  const start = new Date(String(req.query.start || ''));
  const duration = Math.min(3600, Math.max(1, Number(req.query.duration) || 60));
  if (Number.isNaN(start.getTime())) return bad(res, 'Waktu mulai tidak valid');
  if (req.query.download) return exportDownload(req, res, cam, start, duration);
  const url = `${config.mediamtxPlayback}/get?path=${cam.path}&start=${encodeURIComponent(start.toISOString())}&duration=${duration}&format=fmp4`;
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  try {
    let r = await fetch(url, { signal: ac.signal });
    // Jatuh tepat di batas awal rentang (selisih < 1 md) -> coba lagi sedikit lebih maju
    if (r.status === 404) {
      const retry = url.replace(/start=[^&]+/, `start=${encodeURIComponent(new Date(start.getTime() + 2).toISOString())}`);
      r = await fetch(retry, { signal: ac.signal });
    }
    if (!r.ok) return res.status(r.status === 404 ? 404 : 502).json({ error: r.status === 404 ? 'Tidak ada rekaman di waktu ini' : `Playback error ${r.status}` });
    res.setHeader('Content-Type', 'video/mp4');
    if (req.query.download) {
      const p = (n) => String(n).padStart(2, '0');
      const t = `${start.getFullYear()}${p(start.getMonth() + 1)}${p(start.getDate())}-${p(start.getHours())}${p(start.getMinutes())}${p(start.getSeconds())}`;
      const name = db.prepare('SELECT name FROM cameras WHERE id = ?').get(cam.id)?.name || `kamera${cam.id}`;
      res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^A-Za-z0-9 ._-]+/g, '_')}_${t}.mp4"`);
      console.log(`[rekaman] ${req.user.username} mengunduh ${name} ${start.toISOString()} (${duration} dtk)`);
    }
    Readable.fromWeb(r.body).on('error', () => {}).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: 'Server playback tidak bisa dihubungi: ' + e.message });
  }
});

// Unduhan: semua bagian rekaman di rentang [start, start+duration] digabung jadi MP4 standar
// (celah dilewati), supaya bisa diputar & digeser di pemutar mana pun.
async function exportDownload(req, res, cam, start, duration) {
  const end = new Date(start.getTime() + duration * 1000);
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  let tmp;
  try {
    const lr = await fetch(`${config.mediamtxPlayback}/list?path=${cam.path}`, { signal: AbortSignal.timeout(8000) });
    const ranges = lr.ok ? await lr.json() : [];
    // Potong tiap rentang rekaman ke jendela yang diminta
    const parts = [];
    for (const r of ranges) {
      // Waktu mulai dari MediaMTX sampai mikrodetik; Date memotongnya ke milidetik sehingga bisa jatuh
      // sedikit SEBELUM awal rekaman (MediaMTX menjawab 404). Geser 1 md ke dalam rentang.
      const a = new Date(new Date(r.start).getTime() + 1), b = new Date(new Date(r.start).getTime() + r.duration * 1000 - 1);
      const s = a > start ? a : start, e = b < end ? b : end;
      const secs = (e - s) / 1000;
      if (secs >= 0.5) parts.push({ s, secs });
    }
    if (!parts.length) return res.status(404).json({ error: 'Tidak ada rekaman di rentang waktu ini' });
    const dir = path.join(config.dataDir, 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    tmp = path.join(dir, `ekspor-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`);
    const urls = parts.map((p) => `${config.mediamtxPlayback}/get?path=${cam.path}&start=${encodeURIComponent(p.s.toISOString())}&duration=${p.secs.toFixed(3)}&format=fmp4`);
    const info = await exportMp4(urls, tmp, { signal: ac.signal });

    const pad = (n) => String(n).padStart(2, '0');
    const t = `${start.getFullYear()}${pad(start.getMonth() + 1)}${pad(start.getDate())}-${pad(start.getHours())}${pad(start.getMinutes())}${pad(start.getSeconds())}`;
    const name = db.prepare('SELECT name FROM cameras WHERE id = ?').get(cam.id)?.name || `kamera${cam.id}`;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', fs.statSync(tmp).size);
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^A-Za-z0-9 ._-]+/g, '_')}_${t}.mp4"`);
    res.setHeader('X-Export-Parts', String(parts.length));
    console.log(`[rekaman] ${req.user.username} mengunduh ${name} ${start.toISOString()} (${duration} dtk diminta, `
      + `${Math.round(info.durationSec)} dtk ada, ${parts.length} bagian${parts.length > 1 ? ', celah dilewati' : ''})`);
    const file = tmp;
    tmp = null;
    fs.createReadStream(file).on('close', () => fs.rm(file, { force: true }, () => {})).pipe(res);
  } catch (e) {
    if (!res.headersSent) {
      res.status(e.status === 404 ? 404 : 502).json({ error: e.status === 404 ? e.message : 'Ekspor gagal: ' + e.message });
    }
  } finally {
    if (tmp) fs.rm(tmp, { force: true }, () => {});
  }
}

// Kunci rekaman (bukti kejadian): khusus admin
app.post('/api/playback/locks', requireAdmin, recordOn, wrap((req, res) => {
  const b = req.body || {};
  const id = Number(b.cam);
  const start = new Date(String(b.start || '')), end = new Date(String(b.end || ''));
  if (!db.prepare('SELECT 1 FROM cameras WHERE id = ?').get(id)) return bad(res, 'Kamera tidak ada');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return bad(res, 'Rentang waktu tidak valid');
  const r = db.prepare('INSERT INTO record_locks (camera_id, start_at, end_at, note, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(id, start.toISOString(), end.toISOString(), String(b.note || '').slice(0, 200), req.user.username);
  console.log(`[rekaman] ${req.user.username} mengunci rekaman kamera ${id} ${start.toISOString()} – ${end.toISOString()}`);
  res.json({ id: Number(r.lastInsertRowid) });
}));
app.delete('/api/playback/locks/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM record_locks WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- Halaman ----------
// Saat jalan sebagai cctv.exe, file web ada di dalam exe (aset SEA), bukan di disk.
const pub = path.join(config.root, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json',
};
function sendEmbedded(res, rel) {
  try {
    const buf = Buffer.from(seaGetAsset(`public/${rel}`));
    res.type(MIME[path.extname(rel)] || 'application/octet-stream').send(buf);
    return true;
  } catch {
    return false;
  }
}
const page = (name) => (req, res) => (IS_SEA ? sendEmbedded(res, name) : res.sendFile(path.join(pub, name)));
if (IS_SEA) {
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.includes('..')) return next();
    const rel = req.path.replace(/^\/+/, '');
    if (!rel || !sendEmbedded(res, rel)) next();
  });
}
app.get('/login', page('login.html'));
app.get('/playback', (req, res, next) => {
  const u = currentUser(req);
  if (!u) return res.redirect('/login');
  if (!recordSettings().enabled) return res.redirect('/');
  next();
}, page('playback.html'));
// Halaman utama: user login, atau tamu kalau mode tamu aktif (tampilan monitoring)
app.get('/', (req, res, next) => (currentViewer(req) ? next() : res.redirect('/login')), page('index.html'));
// Info untuk halaman login: tampilkan tombol "Kembali ke tampilan CCTV" kalau tamu boleh lihat
app.get('/api/guest', (req, res) => res.json({ available: guestEnabled() && guestIpAllowed(req.socket.remoteAddress) }));
app.get('/admin', (req, res, next) => {
  const u = currentUser(req);
  if (!u) return res.redirect('/login');
  if (!u.is_admin) return res.redirect('/');
  next();
}, page('admin.html'));
app.use(express.static(pub, { index: false }));

app.use((err, req, res, _next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Terjadi kesalahan di server' });
});

app.listen(config.port, config.host, () => {
  console.log(`[web] jalan di http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  startSyncLoop();
  startProbeLoop();
  startRecorderLoop();
});
