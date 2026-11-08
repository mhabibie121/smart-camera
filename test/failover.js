// Eksperimen failover: kamera dipantau lewat IP (jalur radio). Kalau IP putus
// lebih dari `offlineSec`, stream dipindah ke P2P (SN) lewat tunnel dh-p2p.
// Kalau IP hidup lagi dan stabil selama `onlineSec`, stream dikembalikan ke IP.
//
// Data failover hanya disimpan di memori (hilang kalau server tes ditutup),
// supaya login kamera tidak tersimpan di file.
import net from 'node:net';
import { startTunnel, stopTunnel, getTunnel } from './p2p-manager.js';

const CHECK_MS = 5000;
const cams = new Map(); // name -> failover entry

const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');

function ipUrl(c, subtype) {
  const auth = c.user ? `${encodeURIComponent(c.user)}:${encodeURIComponent(c.pass)}@` : '';
  return `rtsp://${auth}${c.ip}:${c.port}/cam/realmonitor?channel=${c.channel}&subtype=${subtype}`;
}

function pathBody(source, timeout) {
  return {
    source, sourceOnDemand: true, sourceOnDemandStartTimeout: timeout,
    sourceOnDemandCloseAfter: '10s', rtspTransport: 'tcp',
  };
}

// Cek jalur IP: bisa konek TCP ke port RTSP dalam 3 dtk?
function probe(c) {
  if (c.simulateDown) return Promise.resolve(false);
  return new Promise((resolve) => {
    const s = net.connect({ host: c.ip, port: c.port, timeout: 3000 });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

function event(c, text) {
  const line = `${new Date().toLocaleTimeString('id-ID')}  ${text}`;
  c.events.push(line);
  if (c.events.length > 50) c.events.shift();
  console.log(`[failover] ${c.name}: ${text}`);
}

async function pointToIp(c, mtxApi) {
  for (const [q, sub] of [['main', 0], ['sub', 1]]) {
    const name = `${c.name}_${q}`, body = pathBody(ipUrl(c, sub), '10s');
    await mtxApi('POST', `/v3/config/paths/add/${name}`, body)
      .catch(() => mtxApi('PATCH', `/v3/config/paths/patch/${name}`, body));
  }
}

async function switchToP2p(c, mtxApi) {
  c.mode = 'p2p';
  c.modeSince = Date.now();
  event(c, `IP putus ${c.offlineSec} dtk → pindah ke P2P (SN ${c.sn})`);
  // Tunnel mendaftarkan path <nama>_main/_sub ke 127.0.0.1:<port> setelah siap
  await startTunnel({ sn: c.sn, name: c.name, channel: c.channel, user: c.user, pass: c.pass, engine: 'relay' }, mtxApi)
    .catch((e) => event(c, `Gagal menyalakan P2P: ${e.message}`));
}

async function switchToIp(c, mtxApi) {
  await stopTunnel(c.sn, mtxApi, { keepPaths: true });
  await pointToIp(c, mtxApi);
  c.mode = 'ip';
  c.modeSince = Date.now();
  event(c, `IP stabil ${c.onlineSec} dtk → kembali ke IP`);
}

async function tick(c, mtxApi) {
  if (c.busy) return;
  c.busy = true;
  try {
    const ok = await probe(c);
    const now = Date.now();
    if (ok !== c.ipOnline) {
      c.ipOnline = ok;
      c.ipSince = now;
      event(c, ok ? 'IP kamera terjangkau lagi' : `IP kamera tidak terjangkau${c.simulateDown ? ' (simulasi)' : ''}`);
    }
    const heldMs = now - c.ipSince;
    if (c.mode === 'ip' && !ok && heldMs >= c.offlineSec * 1000) await switchToP2p(c, mtxApi);
    else if (c.mode === 'p2p' && ok && heldMs >= c.onlineSec * 1000) await switchToIp(c, mtxApi);
    else if (c.mode === 'p2p') {
      // Tunnel mati sendiri saat masih butuh P2P -> nyalakan lagi
      const t = getTunnel(c.sn);
      if (!t || t.state === 'error') {
        if (!c.retryAt) c.retryAt = now + 10_000;
        if (now >= c.retryAt) {
          c.retryAt = 0;
          event(c, `Tunnel P2P berhenti${t?.message ? ` (${t.message})` : ''}, menyalakan ulang`);
          await switchToP2p(c, mtxApi);
        }
      }
    }
  } finally {
    c.busy = false;
  }
}

function view(c) {
  const t = c.mode === 'p2p' ? getTunnel(c.sn) : null;
  return {
    name: c.name, ip: c.ip, port: c.port, channel: c.channel, sn: c.sn,
    offlineSec: c.offlineSec, onlineSec: c.onlineSec, simulateDown: c.simulateDown,
    mode: c.mode, modeSince: c.modeSince, ipOnline: c.ipOnline, ipSince: c.ipSince,
    tunnel: t ? { state: t.state, message: t.message } : null,
    events: c.events.slice(-15),
  };
}

export function listFailover() {
  return [...cams.values()].map(view);
}

export async function addFailover(b, mtxApi) {
  const c = {
    name: slug(b.name), ip: String(b.ip || '').trim(), port: Number(b.port) || 554,
    channel: Math.max(1, Number(b.channel) || 1), user: String(b.user || ''), pass: String(b.pass || ''),
    sn: String(b.sn || '').trim().toUpperCase(),
    offlineSec: Math.max(10, Number(b.offlineSec) || 60), onlineSec: Math.max(10, Number(b.onlineSec) || 60),
    mode: 'ip', modeSince: Date.now(), ipOnline: null, ipSince: Date.now(), simulateDown: false, events: [],
  };
  if (!c.name) throw new Error('Nama tidak valid');
  if (!/^[A-Za-z0-9.-]+$/.test(c.ip)) throw new Error('IP tidak valid');
  if (!/^[A-Z0-9]{8,32}$/.test(c.sn)) throw new Error('SN tidak valid (8–32 huruf/angka)');
  if ([...cams.values()].some((x) => x.sn === c.sn && x.name !== c.name)) {
    throw new Error('SN ini sudah dipakai kamera failover lain (1 tunnel per SN)');
  }
  await removeFailover(c.name, mtxApi);
  cams.set(c.name, c);
  await pointToIp(c, mtxApi);
  event(c, `Dipantau: IP ${c.ip}:${c.port} ch${c.channel}, cadangan SN ${c.sn}`);
  c.timer = setInterval(() => tick(c, mtxApi), CHECK_MS);
  tick(c, mtxApi);
  return view(c);
}

export async function removeFailover(name, mtxApi) {
  const c = cams.get(slug(name));
  if (!c) return false;
  clearInterval(c.timer);
  cams.delete(c.name);
  await stopTunnel(c.sn, mtxApi, { keepPaths: true });
  for (const q of ['main', 'sub']) await mtxApi('DELETE', `/v3/config/paths/delete/${c.name}_${q}`).catch(() => {});
  return true;
}

// Simulasi radio putus: probe dianggap gagal walau IP sebenarnya hidup
export function simulate(name, down) {
  const c = cams.get(slug(name));
  if (!c) throw new Error('Kamera failover tidak ada');
  c.simulateDown = !!down;
  event(c, down ? 'Simulasi radio PUTUS dimulai' : 'Simulasi radio putus dihentikan');
  return view(c);
}
