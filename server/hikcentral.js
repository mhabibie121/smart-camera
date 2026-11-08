// Klien OpenAPI HikCentral (Artemis).
// Dipakai untuk:
//  - mengambil URL RTSP baru (previewURLs). URL dari HikCentral berisi token
//    sementara yang cepat kedaluwarsa, jadi harus diminta ulang tiap mau ditonton.
//  - mengambil daftar kamera untuk di-import.
//
// Tanda tangan request (HMAC-SHA256 dengan AppSecret) mengikuti dokumentasi Artemis:
//   METHOD \n Accept \n [Content-MD5 \n] Content-Type \n [Date \n] header-x-ca-* \n path
import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { getSetting } from './db.js';

export function hikConfig() {
  return {
    host: getSetting('hik_host', '').trim().replace(/\/+$/, ''),   // mis. https://hcp.contoh.go.id:443
    appKey: getSetting('hik_app_key', '').trim(),
    appSecret: getSetting('hik_app_secret', ''),
    insecure: getSetting('hik_insecure', '1') === '1',             // izinkan sertifikat self-signed
  };
}

export const hikConfigured = () => {
  const c = hikConfig();
  return !!(c.host && c.appKey && c.appSecret);
};

function sign(method, path, headers, secret) {
  const signedKeys = Object.keys(headers)
    .filter((k) => k.startsWith('x-ca-') && k !== 'x-ca-signature' && k !== 'x-ca-signature-headers')
    .sort();
  const lines = [method, headers.accept];
  if (headers['content-md5']) lines.push(headers['content-md5']);
  lines.push(headers['content-type']);
  if (headers.date) lines.push(headers.date);
  for (const k of signedKeys) lines.push(`${k}:${headers[k]}`);
  lines.push(path);
  const stringToSign = lines.join('\n');
  return {
    signature: crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64'),
    signedKeys,
  };
}

export async function hikRequest(apiPath, body) {
  const cfg = hikConfig();
  if (!cfg.host || !cfg.appKey || !cfg.appSecret) {
    throw new Error('HikCentral belum diatur (alamat server, AppKey, AppSecret) di Pengaturan');
  }
  const base = new URL(cfg.host.includes('://') ? cfg.host : `https://${cfg.host}`);
  const path = `/artemis${apiPath}`;
  const payload = JSON.stringify(body || {});
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json;charset=UTF-8',
    'x-ca-key': cfg.appKey,
    'x-ca-nonce': crypto.randomUUID(),
    'x-ca-timestamp': String(Date.now()),
  };
  const { signature, signedKeys } = sign('POST', path, headers, cfg.appSecret);
  headers['x-ca-signature-headers'] = signedKeys.join(',');
  headers['x-ca-signature'] = signature;
  headers['content-length'] = Buffer.byteLength(payload);

  const lib = base.protocol === 'http:' ? http : https;
  const text = await new Promise((resolve, reject) => {
    const req = lib.request({
      method: 'POST',
      hostname: base.hostname,
      port: base.port || (base.protocol === 'http:' ? 80 : 443),
      path,
      headers,
      rejectUnauthorized: !cfg.insecure,
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`HikCentral HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        else resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('HikCentral tidak menjawab (timeout 8 detik)')));
    req.on('error', reject);
    req.end(payload);
  });

  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Jawaban HikCentral bukan JSON: ${text.slice(0, 200)}`); }
  if (String(json.code) !== '0') throw new Error(`HikCentral menolak: [${json.code}] ${json.msg || ''}`.trim());
  return json.data;
}

// URL RTSP baru untuk satu kamera. quality: 'main' | 'sub'
export async function hikPreviewUrl(cameraIndexCode, quality) {
  const data = await hikRequest('/api/video/v1/cameras/previewURLs', {
    cameraIndexCode,
    streamType: quality === 'main' ? 0 : 1,
    protocol: 'rtsp',
    transmode: 1, // TCP
  });
  if (!data?.url) throw new Error('HikCentral tidak memberi URL');
  return data.url;
}

// Daftar kamera (semua halaman)
export async function hikListCameras() {
  const out = [];
  for (let pageNo = 1; pageNo <= 50; pageNo++) {
    const data = await hikRequest('/api/resource/v1/cameras', { pageNo, pageSize: 500 });
    const list = data?.list || [];
    out.push(...list.map((c) => ({
      code: c.cameraIndexCode,
      name: c.cameraName || c.cameraIndexCode,
      online: c.status === 1 || c.status === '1' ? true : c.status === undefined ? null : false,
    })));
    if (!list.length || out.length >= (data.total || 0)) break;
  }
  return out;
}
