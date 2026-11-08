// Server kecil untuk halaman tes:
//  - menyajikan test/web/index.html di http://localhost:8090
//  - meneruskan /api/* ke API MediaMTX (127.0.0.1:9997), supaya API tetap
//    tertutup dari luar tapi halaman bisa dibuka dari komputer lain juga.
//  - /p2p/* : eksperimen sambung lewat P2P Dahua (SN). Hanya dari PC ini (localhost).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTunnel, stopTunnel, listTunnels, stopAll } from './p2p-manager.js';
import { listFailover, addFailover, removeFailover, simulate } from './failover.js';

const PORT = Number(process.env.PORT || 8090);
const API = process.env.MEDIAMTX_API || 'http://127.0.0.1:9997';
const page = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web', 'index.html');

async function mtxApi(method, p, body) {
  const r = await fetch(API + p, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`MediaMTX ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : null;
}

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return {}; }
}

http.createServer(async (req, res) => {
  if (req.url.startsWith('/p2p/')) {
    if (!isLocal(req)) return json(res, 403, { error: 'Fitur P2P hanya bisa dipakai dari PC ini (localhost)' });
    try {
      if (req.method === 'GET' && req.url === '/p2p/list') return json(res, 200, listTunnels());
      if (req.method === 'POST' && req.url === '/p2p/start') return json(res, 200, await startTunnel(await readBody(req), mtxApi));
      if (req.method === 'POST' && req.url === '/p2p/stop') {
        const b = await readBody(req);
        return json(res, 200, { ok: await stopTunnel(String(b.sn || '').toUpperCase(), mtxApi) });
      }
      return json(res, 404, { error: 'tidak ada' });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (req.url.startsWith('/failover/')) {
    if (!isLocal(req)) return json(res, 403, { error: 'Fitur failover hanya bisa dipakai dari PC ini (localhost)' });
    try {
      if (req.method === 'GET' && req.url === '/failover/list') return json(res, 200, listFailover());
      const b = await readBody(req);
      if (req.method === 'POST' && req.url === '/failover/add') return json(res, 200, await addFailover(b, mtxApi));
      if (req.method === 'POST' && req.url === '/failover/remove') return json(res, 200, { ok: await removeFailover(b.name, mtxApi) });
      if (req.method === 'POST' && req.url === '/failover/simulate') return json(res, 200, simulate(b.name, b.down));
      return json(res, 404, { error: 'tidak ada' });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (req.url.startsWith('/api/')) {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const r = await fetch(API + req.url.slice(4), {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: ['GET', 'HEAD', 'DELETE'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'text/plain' });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'API MediaMTX (port 9997) tidak bisa dihubungi. Pastikan MediaMTX dijalankan dengan ' +
          'config tes (jalankan-tes.bat), bukan dibuka langsung dari zip/WinRAR.',
      }));
    }
    return;
  }
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(page).pipe(res);
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, () => console.log(`Halaman tes: http://localhost:${PORT}`));

// Tutup semua tunnel P2P saat server dimatikan
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => { stopAll(); process.exit(0); });
process.on('exit', stopAll);
