# CCTV Live View

Live view 200+ kamera Dahua lewat browser, tanpa SmartPSS dan tanpa batas 64 channel.
Hak akses diatur **per grup** dan dicek di server, jadi kamera yang tidak dicentang
untuk grup tersebut benar-benar tidak bisa diputar.

Sistem ini khusus live view. Recording tetap di NVR.

```
Kamera Dahua ──RTSP──▶ MediaMTX ──WebRTC──▶ Browser
                          │
                          └─ "user ini boleh nonton kamera X?" ─▶ Backend Node.js
                                                                  (login, grup, daftar kamera)
```

- **Grid** (4/9/16/25) memakai **substream** (`subtype=1`) supaya ringan. Layout 1 dan
  tampilan layar penuh memakai **main stream** (`subtype=0`).
- **On-demand**: MediaMTX baru menarik stream dari kamera saat ada yang menonton, dan
  hanya 1 koneksi per kamera walaupun penontonnya banyak.
- Status online/offline dicek tiap 60 detik lewat koneksi TCP ke port RTSP kamera.

## Pengaturan kamera Dahua (penting)

Atur di web kamera (atau massal lewat ConfigTool), pada **Main Stream dan Sub Stream**:

| Pengaturan | Nilai |
|---|---|
| Encode mode | **H.264** (H.265 tidak didukung WebRTC di sebagian besar browser) |
| Smart Codec / H.264+ | **Off** |
| Sub stream resolusi | D1 / 640x480 / 720p, bitrate 512–1024 kbps |
| I-frame interval | sama dengan FPS (mis. FPS 15 → I-frame 15) supaya video cepat muncul |

## Menjalankan di Windows

1. Taruh `mediamtx.exe` (dari `mediamtx_vX.X.X_windows_amd64.zip`) di folder `bin\`.
2. Klik dua kali **`jalankan.bat`**. Script ini membuka web di jendela *CCTV Web* dan
   MediaMTX di jendela *CCTV MediaMTX*, lalu membuka http://localhost:3000.
3. Saat pertama kali jalan, password admin tertulis di jendela *CCTV Web*.

Untuk berhenti, tutup kedua jendela itu. Jangan jalankan bersamaan dengan MediaMTX tes
(`test\jalankan-tes.bat`), karena port-nya sama.

Supaya PC lain di kantor bisa membuka web ini, izinkan port berikut di Windows Firewall:
3000/tcp, 8889/tcp, dan 8189/udp.

## Menjalankan untuk percobaan (manual)

Butuh **Node.js 22.13+** dan **MediaMTX** (https://github.com/bluenviron/mediamtx/releases).

```bash
npm install
npm start
```

Login admin dicetak di log saat pertama kali jalan. Lalu di terminal lain jalankan MediaMTX:

```bash
mediamtx mediamtx/mediamtx.yml
```

Buka http://localhost:3000.

## Langkah awal di web

1. **Pengaturan**: isi username/password default kamera (kalau semua kamera sama).
2. **Kamera**: import CSV (lihat `contoh-kamera.csv`) atau tambah manual.
3. **Grup & Akses**: buat grup (mis. *Operasional*), centang kamera yang boleh dilihat.
4. **User**: buat user, pilih grupnya. Admin otomatis bisa melihat semua kamera.

Format CSV: `nama, lokasi, ip, port, channel, username, password, grup`. Yang wajib hanya
`nama` dan `ip`. Grup boleh lebih dari satu, dipisah `|`. Bisa langsung *Save As CSV* dari Excel.

## Deploy di Debian

```bash
# 1. Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs

# 2. User & folder
sudo useradd --system --home /opt/cctv --shell /usr/sbin/nologin cctv
sudo mkdir -p /opt/cctv /opt/mediamtx
# salin isi project ke /opt/cctv (tanpa node_modules dan data), lalu:
cd /opt/cctv && sudo npm install --omit=dev
sudo mkdir -p data && sudo chown -R cctv:cctv /opt/cctv/data

# 3. MediaMTX (ganti VERSI dengan rilis terbaru)
VERSI=v1.x.x
curl -L -o /tmp/mediamtx.tar.gz \
  https://github.com/bluenviron/mediamtx/releases/download/$VERSI/mediamtx_${VERSI}_linux_amd64.tar.gz
sudo tar -xzf /tmp/mediamtx.tar.gz -C /opt/mediamtx mediamtx

# 4. Service
sudo cp deploy/cctv-web.service deploy/mediamtx.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cctv-web mediamtx
sudo journalctl -u cctv-web -n 30   # lihat password admin awal
```

Port yang perlu dibuka ke jaringan user:

| Port | Untuk |
|---|---|
| 3000/tcp | Web (atau 80/443 kalau lewat nginx) |
| 8889/tcp | Signaling WebRTC |
| 8189/udp | Video WebRTC |

Port 9997 (API MediaMTX) cukup localhost, **jangan** dibuka.

Server juga harus bisa menjangkau semua IP kamera di port 554.

### Kapasitas

MediaMTX tidak melakukan transcode, jadi beban CPU kecil. Yang perlu dihitung adalah bandwidth:

- Substream sekitar 0,5–1 Mbps per kamera. 20 user × 25 kamera ≈ 250–500 Mbps keluar dari server (kasus terburuk).
- Main stream sekitar 2–4 Mbps per kamera.

Pakai NIC gigabit di server.

## Lupa password admin

```bash
npm run reset-admin            # password acak
npm run reset-admin -- RahasiaBaru123
```
