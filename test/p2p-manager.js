// Eksperimen: sambung ke perangkat Dahua lewat P2P cloud (berdasarkan SN), memakai
// dh-p2p (test/p2p/dhp2p, salinan yang dibatasi ke 127.0.0.1).
// Setiap SN = satu proses Python yang membuka RTSP lokal di 127.0.0.1:<port>.
// Setelah tunnel siap, path MediaMTX <nama>_main / <nama>_sub diarahkan ke sana.
//
// Batasan dari dh-p2p: hanya 1 koneksi RTSP sekaligus per tunnel, dan masih
// eksperimen (bisa putus / crash). Jangan dipakai untuk produksi.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.P2P_PYTHON || path.join(DIR, 'p2p', 'venv', 'Scripts', 'python.exe');
const SCRIPT = path.join(DIR, 'p2p', 'dhp2p', 'main.py');
// Versi Rust (hasil compile test/p2p/rust): mendukung mode relay & banyak koneksi, tapi tanpa login perangkat
// Pakai build dengan PR #32 (perbaikan ACK / paket dobel di relay) kalau ada
const RUST = process.env.P2P_RUST || [
  path.join(DIR, 'p2p', 'rust-pr32', 'target', 'release', 'dh-p2p.exe'),
  path.join(DIR, 'p2p', 'rust', 'target', 'release', 'dh-p2p.exe'),
].find((p) => fs.existsSync(p));
// engine: 'relay' (Rust lewat server relay Dahua, paling berhasil), 'direct' (Rust langsung), 'python'
const ENGINES = ['relay', 'direct', 'python'];
const FIRST_PORT = 1554;

const tunnels = new Map(); // sn -> tunnel

// Port lokal yang benar-benar kosong (dicek ke sistem, bukan hanya daftar tunnel)
const portFree = (p) => new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(false))
    .once('listening', () => s.close(() => resolve(true))).listen(p, '127.0.0.1');
});
async function freePort() {
  const used = new Set([...tunnels.values()].map((t) => t.port));
  for (let p = FIRST_PORT; p < FIRST_PORT + 200; p++) if (!used.has(p) && await portFree(p)) return p;
  throw new Error('Tidak ada port lokal kosong untuk tunnel');
}

function publicView(t) {
  return {
    sn: t.sn, name: t.name, channel: t.channel, port: t.port, state: t.state, type: t.type, engine: t.engine,
    message: t.message, started: t.started, log: t.log.slice(-25),
  };
}

export function listTunnels() {
  return [...tunnels.values()].map(publicView);
}

export function getTunnel(sn) {
  const t = tunnels.get(String(sn || '').toUpperCase());
  return t ? publicView(t) : null;
}

// Tunnel yang sudah tidak dipakai: hentikan proses + hapus path MediaMTX.
// keepPaths: path dibiarkan (dipakai failover, yang mengarahkan path kembali ke IP sendiri).
export async function stopTunnel(sn, mtxApi, { keepPaths = false } = {}) {
  const t = tunnels.get(sn);
  if (!t) return false;
  t.stopping = true;
  t.proc?.kill();
  tunnels.delete(sn);
  if (!keepPaths) {
    for (const q of ['main', 'sub']) await mtxApi('DELETE', `/v3/config/paths/delete/${t.name}_${q}`).catch(() => {});
  }
  return true;
}

/**
 * Mulai tunnel P2P.
 * opts: { sn, user, pass, channel, name, type: 'auto' | 0 | 1 }
 * mtxApi(method, path, body) = fungsi pemanggil API MediaMTX.
 */
export async function startTunnel(opts, mtxApi) {
  const sn = String(opts.sn || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{8,32}$/.test(sn)) throw new Error('SN tidak valid (8–32 huruf/angka)');
  const name = String(opts.name || `p2p-${sn.slice(-6)}`).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
  if (!name) throw new Error('Nama tidak valid');
  const channel = Math.max(1, Number(opts.channel) || 1);
  const engine = ENGINES.includes(opts.engine) ? opts.engine : 'relay';
  if (engine === 'python' && (!fs.existsSync(PYTHON) || !fs.existsSync(SCRIPT))) throw new Error('dh-p2p Python belum terpasang di test\\p2p (venv / dhp2p)');
  if (engine !== 'python' && !(RUST && fs.existsSync(RUST))) throw new Error('dh-p2p versi Rust belum di-compile (test\\p2p\\rust)');

  if (tunnels.has(sn)) await stopTunnel(sn, mtxApi);
  const t = {
    sn, name, channel, user: String(opts.user || ''), pass: String(opts.pass || ''),
    port: await freePort(), state: 'connecting', message: 'Menghubungi cloud Dahua…',
    engine,
    type: opts.type === 1 || opts.type === '1' ? 1 : 0,
    auto: opts.type === undefined || opts.type === 'auto',
    log: [], started: new Date().toISOString(),
  };
  tunnels.set(sn, t);
  launch(t, mtxApi);
  return publicView(t);
}

function launch(t, mtxApi) {
  let exe, args;
  if (t.engine === 'python') {
    exe = PYTHON;
    args = ['-u', '-E', '-s', SCRIPT, t.sn];
    if (t.type > 0) args.push('-t', String(t.type), '-u', t.user);
  } else {
    exe = RUST;
    args = ['-p', `127.0.0.1:${t.port}:554`, t.sn];
    if (t.engine === 'relay') args.unshift('--relay');
  }
  t.state = 'connecting';
  t.message = t.type > 0 ? 'Menghubungi cloud Dahua (dengan login perangkat)…' : 'Menghubungi cloud Dahua…';
  const proc = spawn(exe, args, {
    cwd: path.dirname(exe === PYTHON ? SCRIPT : RUST),
    // Password lewat env, bukan argumen (supaya tidak terlihat di daftar proses)
    env: { ...process.env, P2P_PORT: String(t.port), P2P_PASSWORD: t.pass },
    windowsHide: true,
  });
  t.proc = proc;
  let needAuth = false;

  const onLine = (line) => {
    // Jangan simpan baris berisi password / kunci
    // Jangan simpan baris login (password, hash Digest RTSP, kunci cloud)
    if (!line.trim() || /password|DevAuth|X-WSSE|PasswordDigest|Authorization:/i.test(line)) return;
    // Versi Rust mencetak setiap paket (heartbeat dll.) -> jangan penuhi log
    if (/^(PTCPPacket|---|###|>>> |<<< |Raw \[)/.test(line.trim())) return;
    if (/requires authentication/i.test(line) && t.engine !== 'python') {
      t.message = 'Perangkat mewajibkan login untuk kanal P2P. Versi Rust belum mendukung login: coba mesin "Python (pakai login)".';
    }
    if (/AddrInUse|10048/.test(line)) t.message = `Port lokal ${t.port} sedang dipakai program lain`;
    else if (/panicked at/.test(line) && t.state === 'connecting' && !/mewajibkan/.test(t.message)) {
      t.message = 'Proses berhenti (lihat log)';
    } else if (/^Error response: (.*)/.test(line.trim()) || /Error response/.test(line)) {
      t.message = 'Ditolak cloud/perangkat: ' + line.trim();
    }
    t.log.push(line.length > 200 ? line.slice(0, 200) + '…' : line);
    if (t.log.length > 300) t.log.splice(0, t.log.length - 300);
    if (/requires authentication/i.test(line)) needAuth = true;
    if (/Ready to connect/.test(line) && t.state !== 'ready') onReady(t, mtxApi);
    if (/^Error:/.test(line)) {
      t.message = /Not Found/i.test(line)
        ? 'SN tidak ditemukan di cloud Dahua: cek SN-nya, dan pastikan P2P di perangkat aktif & statusnya "Online"'
        : /Forbidden|403/.test(line) ? 'Ditolak perangkat: username/password salah, atau pilih "Pakai login"'
        : line;
    }
    if (/Timeout occurred/i.test(line)) t.message = 'Perangkat tidak menjawab lewat P2P (butuh mode relay, belum didukung versi Python)';
  };
  let buf = '';
  const feed = (d) => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    lines.forEach(onLine);
  };
  proc.stdout.on('data', feed);
  proc.stderr.on('data', feed);
  proc.on('error', (e) => { t.state = 'error'; t.message = 'Gagal menjalankan Python: ' + e.message; });

  // Batas waktu. Versi Python dh-p2p bisa menunggu selamanya kalau perangkat diam,
  // jadi setelah 45 dtk prosesnya dihentikan dengan pesan sesuai langkah terakhir.
  const watchdog = setTimeout(() => {
    if (t.proc !== proc || t.state !== 'connecting') return;
    const all = t.log.join('\n');
    if (!/<<< /.test(all)) {
      t.message = 'Tidak ada jawaban dari cloud Dahua. Jaringan mungkin memblokir UDP 8800.';
    } else if (/relay\/start|<SID>/.test(all)) {
      t.message = 'Cloud & relay Dahua menjawab, tapi PERANGKAT tidak membalas permintaan kanal P2P. '
        + 'Biasanya: perangkat hanya bisa lewat mode relay (versi Rust), login perangkat salah, atau P2P perangkat sedang offline.';
    } else {
      t.message = 'Cloud Dahua menjawab, tapi proses berhenti di tengah jalan. Lihat log.';
    }
    t.timedOut = true;
    proc.kill();
  }, 45_000);

  proc.on('exit', (code) => {
    clearTimeout(watchdog);
    if (t.stopping || t.proc !== proc) return;
    // Perangkat minta login saat membuat kanal P2P -> ulang otomatis dengan -t 1
    if (needAuth && t.auto && t.type === 0 && t.user && t.engine === 'python') {
      t.type = 1;
      t.log.push('--- perangkat minta login, mencoba ulang dengan login perangkat ---');
      return launch(t, mtxApi);
    }
    t.state = 'error';
    if (t.timedOut) return;
    if (t.message.startsWith('Menghubungi')) {
      const last = [...t.log].reverse().find((l) => /error|Error|Traceback|Exception|404|403/.test(l));
      t.message = last ? `Proses berhenti: ${last}` : `Proses berhenti (kode ${code})`;
    }
    if (needAuth && !t.user) t.message = 'Perangkat minta login: isi username & password perangkat';
  });
}

async function onReady(t, mtxApi) {
  t.state = 'ready';
  t.message = `Tersambung. RTSP lokal: 127.0.0.1:${t.port}`;
  const auth = t.user ? `${encodeURIComponent(t.user)}:${encodeURIComponent(t.pass)}@` : '';
  for (const [q, sub] of [['main', 0], ['sub', 1]]) {
    const body = {
      source: `rtsp://${auth}127.0.0.1:${t.port}/cam/realmonitor?channel=${t.channel}&subtype=${sub}`,
      sourceOnDemand: true,
      // Lewat cloud lebih lambat dari LAN
      sourceOnDemandStartTimeout: '30s',
      sourceOnDemandCloseAfter: '10s',
      rtspTransport: 'tcp',
    };
    const name = `${t.name}_${q}`;
    await mtxApi('POST', `/v3/config/paths/add/${name}`, body)
      .catch(() => mtxApi('PATCH', `/v3/config/paths/patch/${name}`, body))
      .catch((e) => { t.message = 'Tunnel siap, tapi gagal daftar ke MediaMTX: ' + e.message; });
  }
}

export function stopAll() {
  for (const t of tunnels.values()) { t.stopping = true; t.proc?.kill(); }
}
