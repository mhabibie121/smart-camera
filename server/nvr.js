// Baca daftar channel dari NVR / XVR Dahua lewat HTTP API-nya:
//   - nama channel   : configManager.cgi?action=getConfig&name=ChannelTitle
//   - status kamera  : LogicDeviceManager.cgi?action=getCameraState  (tidak semua model punya)
//   - info perangkat : magicBox.cgi?action=getDeviceType / getSerialNo
// Nomor channel di API Dahua mulai dari 0; di RTSP mulai dari 1.
import { dahuaRequest } from './ptz.js';

// "table.ChannelTitle[3].Name=Dermaga" -> Map(3 -> { Name: 'Dermaga' })
function parseTable(body, prefix) {
  const rows = new Map();
  for (const line of String(body).split(/\r?\n/)) {
    const m = new RegExp(`^${prefix}\\[(\\d+)\\]\\.([\\w.]+)=(.*)$`).exec(line.trim());
    if (!m) continue;
    const i = Number(m[1]);
    if (!rows.has(i)) rows.set(i, {});
    rows.get(i)[m[2]] = m[3].trim();
  }
  return rows;
}

const value = (body, key) => {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(String(body));
  return m ? m[1].trim() : '';
};

export async function readNvr({ host, port = 80, user, pass }) {
  const t = { host, port, user, pass };

  // Ini juga sekaligus mengecek login; kalau gagal langsung lempar error yang jelas.
  const titles = parseTable(
    await dahuaRequest(t, '/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle'),
    'table\\.ChannelTitle',
  );
  if (!titles.size) throw new Error('NVR tidak mengirim daftar channel (bukan perangkat Dahua, atau firmware tidak mendukung)');

  const [type, serial] = await Promise.all([
    dahuaRequest(t, '/cgi-bin/magicBox.cgi?action=getDeviceType').then((b) => value(b, 'type')).catch(() => ''),
    dahuaRequest(t, '/cgi-bin/magicBox.cgi?action=getSerialNo').then((b) => value(b, 'sn')).catch(() => ''),
  ]);

  // Kamera yang terpasang di tiap channel: IP, model, SN (opsional; tidak semua model punya)
  const devices = new Map(); // index channel -> { ip, model, sn, enabled }
  try {
    const rows = parseTable(await dahuaRequest(t, '/cgi-bin/LogicDeviceManager.cgi?action=getCameraAll'), 'camera');
    for (const r of rows.values()) {
      if (r.UniqueChannel === undefined) continue;
      const ip = r['DeviceInfo.Address'] || '';
      devices.set(Number(r.UniqueChannel), {
        ip: ip && ip !== '0.0.0.0' ? ip : '',
        model: r['DeviceInfo.DeviceType'] || '',
        sn: r['DeviceInfo.SerialNo'] || '',
        enabled: r.Enable !== 'false' && r['DeviceInfo.Enable'] !== 'false',
      });
    }
  } catch {}

  const channels = [...titles.entries()].sort((a, b) => a[0] - b[0]).map(([i, r]) => {
    const d = devices.get(i) || {};
    // Channel tanpa kamera terpasang (kosong / dimatikan)
    const empty = devices.size > 0 && (!d.ip || d.enabled === false);
    return {
      channel: i + 1,
      name: (r.Name || '').trim() || `Channel ${i + 1}`,
      cam_ip: empty ? '' : d.ip || '',
      model: empty ? '' : d.model || '',
      sn: d.sn || '',
      empty,
      // Kamera PTZ Dahua bermodel "SD..." (speed dome)
      ptz: /^(DH-|DHI-)?SD/i.test(d.model || ''),
    };
  });
  return { type, serial, channels };
}
