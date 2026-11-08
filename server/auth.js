import crypto from 'node:crypto';
import { config } from './config.js';
import { db, getSetting } from './db.js';

// ---------- Password ----------
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [algo, saltHex, hashHex] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// ---------- Token bertanda tangan (HMAC) ----------
function hmac(data) {
  return crypto.createHmac('sha256', config.secret).update(data).digest('base64url');
}

export function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(body)}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = hmac(body);
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

// Ambil user dari token & pastikan sesi belum dicabut
// (session_version naik saat password diganti / user diubah admin).
export function userFromToken(token, type) {
  const p = verifyToken(token);
  if (!p || p.t !== type) return null;
  // Token stream milik tamu: berlaku selama mode tamu masih aktif
  if (p.guest) return guestEnabled() ? guestUser() : null;
  const user = db.prepare(
    'SELECT id, username, is_admin, group_id, session_version, monitor FROM users WHERE id = ?'
  ).get(p.uid);
  if (!user || user.session_version !== p.v) return null;
  return user;
}

// "Ingat saya di perangkat ini": sesi panjang untuk PC / TV monitor.
// Tetap dicabut kalau user klik Keluar, password diganti, atau user diubah/dihapus admin.
export const REMEMBER_DAYS = 180;
const sessionMs = (remember) => (remember ? REMEMBER_DAYS * 24 : config.sessionHours) * 3600_000;

export function makeSessionToken(user, remember = false) {
  return signToken({
    t: 'session', uid: user.id, v: user.session_version, ...(remember ? { r: 1 } : {}),
    exp: Date.now() + sessionMs(remember),
  });
}

// Sesi yang sedang dipakai dibuat dengan "Ingat saya"?
export function sessionRemembered(req) {
  return !!verifyToken(parseCookies(req.headers.cookie)[COOKIE])?.r;
}

export function makeStreamToken(user) {
  const exp = Date.now() + config.streamTokenMinutes * 60_000;
  if (user.guest) return { token: signToken({ t: 'stream', uid: 0, v: 0, guest: 1, exp }), exp };
  return { token: signToken({ t: 'stream', uid: user.id, v: user.session_version, exp }), exp };
}

// ---------- Cookie & middleware ----------
const COOKIE = 'cctv_sid';

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setSessionCookie(res, user, remember = false) {
  res.cookie(COOKIE, makeSessionToken(user, remember), {
    httpOnly: true, sameSite: 'lax', secure: config.secureCookie,
    maxAge: sessionMs(remember), path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

export function currentUser(req) {
  return userFromToken(parseCookies(req.headers.cookie)[COOKIE], 'session');
}

export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Belum login' });
  req.user = user;
  next();
}

// ---------- Mode tamu (tampilan monitoring tanpa login) ----------
// Diatur admin di Pengaturan: guest_enabled, guest_group_id (kamera yang boleh dilihat),
// guest_ips (opsional: hanya IP / subnet tertentu, mis. PC monitor ruang kontrol).
export function guestEnabled() {
  return getSetting('guest_enabled', '0') === '1';
}

export function guestUser() {
  const gid = Number(getSetting('guest_group_id', '')) || null;
  return { id: 0, username: 'Tamu', is_admin: 0, group_id: gid, session_version: 0, guest: true };
}

const normIp = (ip) => String(ip || '').replace(/^::ffff:/, '').trim();
const ipToInt = (ip) => ip.split('.').reduce((n, p) => (n << 8) + (Number(p) & 255), 0) >>> 0;

// Daftar boleh: "10.3.8.0/24, 10.3.4.20, 192.168.1." (kosong = semua IP)
export function guestIpAllowed(ip) {
  const list = getSetting('guest_ips', '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  if (!list.length) return true;
  ip = normIp(ip);
  if (ip === '::1') ip = '127.0.0.1';
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  return list.some((rule) => {
    if (rule.includes('/')) {
      const [base, bits] = rule.split('/');
      const n = Number(bits);
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(base) || !(n >= 0 && n <= 32)) return false;
      const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
      return (ipToInt(ip) & mask) === (ipToInt(base) & mask);
    }
    return rule.endsWith('.') ? ip.startsWith(rule) : ip === rule;
  });
}

// User yang login, atau tamu kalau mode tamu aktif & IP-nya diizinkan
export function currentViewer(req) {
  const user = currentUser(req);
  if (user) return user;
  if (guestEnabled() && guestIpAllowed(req.socket.remoteAddress)) return guestUser();
  return null;
}

export function requireViewer(req, res, next) {
  const user = currentViewer(req);
  if (!user) return res.status(401).json({ error: 'Belum login' });
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Khusus admin' });
    next();
  });
}

// ---------- Pembatas percobaan login ----------
const failures = new Map(); // ip -> { count, until }
const MAX_FAIL = 10;
const WINDOW_MS = 10 * 60_000;

export function loginBlocked(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (f.until < Date.now()) { failures.delete(ip); return false; }
  return f.count >= MAX_FAIL;
}

export function recordLoginFailure(ip) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) failures.set(ip, { count: 1, until: Date.now() + WINDOW_MS });
  else f.count++;
}

export function clearLoginFailures(ip) {
  failures.delete(ip);
}
