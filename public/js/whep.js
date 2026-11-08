// Pemutar WebRTC (WHEP) minimal untuk MediaMTX, dengan reconnect otomatis.
let tokenCache = null;

async function getStreamInfo() {
  if (tokenCache && tokenCache.exp - Date.now() > 60_000) return tokenCache;
  const res = await fetch('/api/stream-token');
  if (res.status === 401) { location.href = '/login'; throw new Error('Sesi habis'); }
  tokenCache = await res.json();
  return tokenCache;
}

function baseUrl(info) {
  if (info.webrtcUrl) return info.webrtcUrl;
  return `${location.protocol}//${location.hostname}:${info.webrtcPort}`;
}

function waitIceGathering(pc, timeoutMs) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
    });
  });
}

export class WhepPlayer {
  /**
   * @param {HTMLVideoElement} video
   * @param {string} path  nama path MediaMTX, mis. "cam12_sub"
   * @param {(state: 'connecting'|'playing'|'error'|'denied', msg?: string) => void} onState
   */
  constructor(video, path, onState = () => {}) {
    this.video = video;
    this.path = path;
    this.onState = onState;
    this.pc = null;
    this.sessionUrl = null;
    this.stopped = false;
    this.retryTimer = null;
    this.retryDelay = 2000;
  }

  start() {
    this.stopped = false;
    this.connect();
    return this;
  }

  async connect() {
    if (this.stopped) return;
    this.cleanupPc();
    this.onState('connecting');
    try {
      const info = await getStreamInfo();

      // Siapkan sumber stream (kamera HikCentral perlu URL baru tiap kali)
      const prep = await fetch(`/api/prepare/${this.path}`, { method: 'POST' });
      if (this.stopped) return;
      if (prep.status === 401) { location.href = '/login'; return; }
      if (prep.status === 403) { this.onState('denied', 'Tidak punya akses'); return; }
      if (!prep.ok) {
        const j = await prep.json().catch(() => ({}));
        throw new Error(j.error || `Gagal menyiapkan stream (${prep.status})`);
      }

      const pc = new RTCPeerConnection({ iceServers: [] });
      this.pc = pc;
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.ontrack = (e) => {
        this.video.srcObject = e.streams[0] || new MediaStream([e.track]);
      };
      pc.onconnectionstatechange = () => {
        if (pc !== this.pc) return;
        if (pc.connectionState === 'connected') {
          this.retryDelay = 2000;
          this.onState('playing');
        } else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
          this.scheduleRetry('Koneksi terputus');
        }
      };

      await pc.setLocalDescription(await pc.createOffer());
      await waitIceGathering(pc, 1500);
      if (this.stopped || pc !== this.pc) return;

      const url = `${baseUrl(info)}/${this.path}/whep?token=${encodeURIComponent(info.token)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp', Authorization: `Bearer ${info.token}` },
        body: pc.localDescription.sdp,
      });
      if (res.status === 401 || res.status === 403) {
        tokenCache = null;
        this.onState('denied', 'Tidak punya akses');
        this.cleanupPc();
        return;
      }
      if (res.status !== 201) {
        const body = await res.text().catch(() => '');
        let detail = body;
        try { detail = JSON.parse(body).error || body; } catch {}
        if (/codec/i.test(detail)) {
          // Biasanya kamera H.265: browser tidak bisa memutar lewat WebRTC
          this.onState('denied', 'Codec tidak didukung browser (kemungkinan H.265)');
          this.cleanupPc();
          return;
        }
        throw new Error(res.status === 404 ? 'Kamera tidak tersedia / tidak bisa ditarik'
          : `Server ${res.status}${detail ? ': ' + detail.slice(0, 120) : ''}`);
      }
      const loc = res.headers.get('Location');
      this.sessionUrl = loc ? new URL(loc, url).href : null;
      this.token = info.token;
      await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
    } catch (e) {
      this.scheduleRetry(e.message || 'Gagal terhubung');
    }
  }

  scheduleRetry(msg) {
    if (this.stopped || this.retryTimer) return;
    this.onState('error', msg);
    this.cleanupPc();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
  }

  cleanupPc() {
    if (this.sessionUrl) {
      fetch(this.sessionUrl, {
        method: 'DELETE',
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      }).catch(() => {});
      this.sessionUrl = null;
    }
    if (this.pc) {
      const pc = this.pc;
      this.pc = null;
      pc.ontrack = pc.onconnectionstatechange = null;
      pc.close();
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.cleanupPc();
    this.video.srcObject = null;
  }
}
