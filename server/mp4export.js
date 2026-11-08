// Ekspor rekaman ke MP4 STANDAR (bukan fragmented), tanpa encode ulang.
//
// Server playback MediaMTX mengirim fMP4 (moov kosong + moof/mdat) dan berhenti di
// celah rekaman pertama. Modul ini:
//   1) mengambil setiap bagian rekaman yang bersambung (URL /get per bagian),
//   2) membaca fragmen secara streaming (hemat memori, cocok untuk file besar),
//   3) menyalin data video/audio apa adanya ke satu file,
//   4) menulis tabel sampel (stts/stsz/co64/stss/ctts) + durasi yang benar di moov.
// Hasilnya bisa diputar & digeser di Windows Media Player, Foto, VLC, HP, dll.
// Celah antar bagian dilewati (video langsung bersambung ke bagian berikutnya).
import fs from 'node:fs';
import { Readable } from 'node:stream';

// ---------- pembuat box ----------
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
function box(type, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'latin1'), body]);
}
const fullbox = (type, version, flags, ...parts) => box(type, Buffer.from([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);

// ---------- pembaca box ----------
function* children(buf, start, end) {
  let o = start;
  while (o + 8 <= end) {
    let size = buf.readUInt32BE(o), hdr = 8;
    const type = buf.toString('latin1', o + 4, o + 8);
    if (size === 1) { size = Number(buf.readBigUInt64BE(o + 8)); hdr = 16; }
    if (size === 0) size = end - o;
    if (size < hdr || o + size > end) return;
    yield { type, o, size, hdr, body: o + hdr, end: o + size };
    o += size;
  }
}
const child = (buf, b, type) => { for (const c of children(buf, b.body, b.end)) if (c.type === type) return c; return null; };
const fullBody = (b) => b.body + 4; // lewati version+flags

// moov dari MediaMTX: info trak + default sampel (trex)
function parseInit(buf) {
  const moov = { type: 'moov', o: 0, body: 8, end: buf.length };
  const tracks = new Map();
  for (const t of children(buf, moov.body, moov.end)) {
    if (t.type !== 'trak') continue;
    const tkhd = child(buf, t, 'tkhd');
    const ver = buf[tkhd.body];
    const id = buf.readUInt32BE(tkhd.body + 4 + (ver ? 16 : 8));
    const mdia = child(buf, t, 'mdia');
    const mdhd = child(buf, mdia, 'mdhd');
    const mv = buf[mdhd.body];
    const timescale = buf.readUInt32BE(mdhd.body + 4 + (mv ? 16 : 8));
    const hdlr = child(buf, mdia, 'hdlr');
    const handler = buf.toString('latin1', hdlr.body + 8, hdlr.body + 12);
    const minf = child(buf, mdia, 'minf');
    const stbl = child(buf, minf, 'stbl');
    const stsd = child(buf, stbl, 'stsd');
    const minfOther = [...children(buf, minf.body, minf.end)].filter((c) => c.type !== 'stbl').map((c) => buf.subarray(c.o, c.end));
    tracks.set(id, {
      id, timescale, handler,
      tkhd: Buffer.from(buf.subarray(tkhd.o, tkhd.end)),
      mdhd: Buffer.from(buf.subarray(mdhd.o, mdhd.end)),
      hdlr: Buffer.from(buf.subarray(hdlr.o, hdlr.end)),
      minfOther: minfOther.map((b) => Buffer.from(b)),
      stsd: Buffer.from(buf.subarray(stsd.o, stsd.end)),
      trex: { dur: 0, size: 0, flags: 0 },
    });
  }
  const mvex = [...children(buf, moov.body, moov.end)].find((c) => c.type === 'mvex');
  if (mvex) {
    for (const c of children(buf, mvex.body, mvex.end)) {
      if (c.type !== 'trex') continue;
      const p = fullBody(c), id = buf.readUInt32BE(p);
      const t = tracks.get(id);
      if (t) t.trex = { dur: buf.readUInt32BE(p + 8), size: buf.readUInt32BE(p + 12), flags: buf.readUInt32BE(p + 16) };
    }
  }
  return tracks;
}

// moof: daftar sampel dengan posisi absolut (di dalam stream bagian ini)
function parseMoof(buf, absStart, tracks) {
  const moof = { body: 8, end: buf.length };
  const out = [];
  for (const traf of children(buf, moof.body, moof.end)) {
    if (traf.type !== 'traf') continue;
    const tfhd = child(buf, traf, 'tfhd');
    const tf = buf.readUInt32BE(tfhd.body) & 0xffffff;
    let p = tfhd.body + 4;
    const id = buf.readUInt32BE(p); p += 4;
    const t = tracks.get(id);
    if (!t) continue;
    let base = absStart, dDur = t.trex.dur, dSize = t.trex.size, dFlags = t.trex.flags;
    if (tf & 0x01) { base = Number(buf.readBigUInt64BE(p)); p += 8; } // base_data_offset (posisi di stream)
    if (tf & 0x02) p += 4;
    if (tf & 0x08) { dDur = buf.readUInt32BE(p); p += 4; }
    if (tf & 0x10) { dSize = buf.readUInt32BE(p); p += 4; }
    if (tf & 0x20) { dFlags = buf.readUInt32BE(p); p += 4; }
    let next = base; // trun tanpa data_offset: lanjut dari akhir trun sebelumnya
    for (const trun of children(buf, traf.body, traf.end)) {
      if (trun.type !== 'trun') continue;
      const ver = buf[trun.body];
      const fl = buf.readUInt32BE(trun.body) & 0xffffff;
      let q = trun.body + 4;
      const n = buf.readUInt32BE(q); q += 4;
      let pos = next;
      if (fl & 0x01) { pos = base + buf.readInt32BE(q); q += 4; }
      let firstFlags = null;
      if (fl & 0x04) { firstFlags = buf.readUInt32BE(q); q += 4; }
      for (let i = 0; i < n; i++) {
        let dur = dDur, size = dSize, flags = i === 0 && firstFlags !== null ? firstFlags : dFlags, cto = 0;
        if (fl & 0x100) { dur = buf.readUInt32BE(q); q += 4; }
        if (fl & 0x200) { size = buf.readUInt32BE(q); q += 4; }
        if (fl & 0x400) { flags = buf.readUInt32BE(q); q += 4; }
        if (fl & 0x800) { cto = ver ? buf.readInt32BE(q) : buf.readUInt32BE(q); q += 4; }
        out.push({ track: id, dur, size, cto, sync: !(flags & 0x10000), abs: pos });
        pos += size;
      }
      next = pos;
    }
  }
  return out;
}

// ---------- susun moov akhir ----------
function runLength(values) {
  const runs = [];
  for (const v of values) {
    const last = runs[runs.length - 1];
    if (last && last[1] === v) last[0]++; else runs.push([1, v]);
  }
  return runs;
}

// Tulis durasi ke box penuh (offset dihitung dari awal box: 8 byte header + 4 byte version/flags)
//   tkhd v0: creation@12 modif@16 track_ID@20 reserved@24 duration@28 | v1: duration@36 (64-bit)
//   mdhd v0: creation@12 modif@16 timescale@20 duration@24           | v1: duration@32 (64-bit)
function setDuration(full, offV0, offV1, value) {
  const b = Buffer.from(full);
  if (b[8]) b.writeBigUInt64BE(BigInt(Math.round(value)), offV1);
  else b.writeUInt32BE(Math.min(0xffffffff, Math.round(value)), offV0);
  return b;
}

function buildMoov(tracks, samplesByTrack) {
  const MOVIE_TS = 1000;
  let movieDur = 0;
  const traks = [];
  for (const [id, t] of tracks) {
    const s = samplesByTrack.get(id) || [];
    if (!s.length) continue;
    const mediaDur = s.reduce((n, x) => n + x.dur, 0);
    const dur = (mediaDur / t.timescale) * MOVIE_TS;
    movieDur = Math.max(movieDur, dur);
    const stts = runLength(s.map((x) => x.dur));
    const hasCto = s.some((x) => x.cto !== 0);
    const syncs = s.map((x, i) => (x.sync ? i + 1 : 0)).filter(Boolean);
    const stbl = box('stbl',
      t.stsd,
      fullbox('stts', 0, 0, u32(stts.length), ...stts.flatMap(([n, d]) => [u32(n), u32(d)])),
      ...(hasCto ? [fullbox('ctts', 1, 0, u32(s.length), ...s.flatMap((x) => [u32(1), u32(x.cto)]))] : []),
      ...(t.handler === 'vide' && syncs.length < s.length ? [fullbox('stss', 0, 0, u32(syncs.length), ...syncs.map(u32))] : []),
      fullbox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)),
      fullbox('stsz', 0, 0, u32(0), u32(s.length), ...s.map((x) => u32(x.size))),
      fullbox('co64', 0, 0, u32(s.length), ...s.map((x) => u64(x.off))),
    );
    const tkhd = setDuration(t.tkhd, 28, 36, dur);       // skala film
    const mdhd = setDuration(t.mdhd, 24, 32, mediaDur);  // skala media
    traks.push(box('trak', tkhd, box('mdia', mdhd, t.hdlr, box('minf', ...t.minfOther, stbl))));
  }
  const mvhd = fullbox('mvhd', 0, 0,
    u32(0), u32(0), u32(MOVIE_TS), u32(Math.round(movieDur)),
    u32(0x00010000), Buffer.from([1, 0]), Buffer.alloc(10),
    u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000),
    Buffer.alloc(24), u32(Math.max(...tracks.keys()) + 1));
  return { moov: box('moov', mvhd, ...traks), durationSec: movieDur / MOVIE_TS };
}

/**
 * Gabungkan beberapa URL /get (fMP4) menjadi satu MP4 standar di outPath.
 * Mengembalikan { durationSec, parts, samples }.
 */
export async function exportMp4(urls, outPath, { signal } = {}) {
  const fd = fs.openSync(outPath, 'w');
  let pos = 0;
  const write = (b) => { fs.writeSync(fd, b, 0, b.length, pos); pos += b.length; };
  try {
    write(box('ftyp', Buffer.from('isom', 'latin1'), u32(512), Buffer.from('isomiso2mp41', 'latin1')));
    const mdatStart = pos;
    write(Buffer.alloc(16)); // header mdat 64-bit, diisi di akhir
    let tracks = null, parts = 0;
    const samplesByTrack = new Map();

    for (const url of urls) {
      const res = await fetch(url, { signal });
      if (res.status === 404) continue; // bagian ini sudah tertimpa
      if (!res.ok) throw new Error(`Playback MediaMTX ${res.status}`);
      parts++;
      let pending = Buffer.alloc(0), streamPos = 0, mdatLeft = 0, moofSamples = [];
      const feed = (chunk) => {
        let c = chunk;
        while (c.length) {
          if (mdatLeft > 0) {
            const n = Math.min(mdatLeft, c.length);
            write(c.subarray(0, n)); mdatLeft -= n; streamPos += n; c = c.subarray(n);
            continue;
          }
          pending = pending.length ? Buffer.concat([pending, c]) : c;
          c = Buffer.alloc(0);
          while (pending.length >= 8 && mdatLeft === 0) {
            let size = pending.readUInt32BE(0), hdr = 8;
            const type = pending.toString('latin1', 4, 8);
            if (size === 1) { if (pending.length < 16) break; size = Number(pending.readBigUInt64BE(8)); hdr = 16; }
            if (type === 'mdat') {
              const payloadStart = streamPos + hdr;
              for (const s of moofSamples) {
                s.off = pos + (s.abs - payloadStart);
                (samplesByTrack.get(s.track) || samplesByTrack.set(s.track, []).get(s.track)).push(s);
              }
              moofSamples = [];
              streamPos += hdr; pending = pending.subarray(hdr);
              mdatLeft = size === 0 ? Infinity : size - hdr;
              const n = Math.min(mdatLeft, pending.length);
              write(pending.subarray(0, n)); mdatLeft -= n; streamPos += n; pending = pending.subarray(n);
              continue;
            }
            if (size === 0 || pending.length < size) break;
            const b = Buffer.from(pending.subarray(0, size));
            if (type === 'moov') {
              const init = parseInit(b);
              if (!tracks) tracks = init;
              else for (const [id, t] of init) if (tracks.has(id)) tracks.get(id).trex = t.trex;
            } else if (type === 'moof' && tracks) {
              moofSamples = parseMoof(b, streamPos, tracks);
            }
            streamPos += size; pending = pending.subarray(size);
          }
        }
      };
      for await (const chunk of Readable.fromWeb(res.body)) feed(chunk);
    }

    const total = [...samplesByTrack.values()].reduce((n, s) => n + s.length, 0);
    if (!tracks || !total) throw Object.assign(new Error('Tidak ada rekaman di rentang waktu ini'), { status: 404 });
    // isi header mdat (64-bit)
    const mdatSize = pos - mdatStart;
    const hdr = Buffer.concat([u32(1), Buffer.from('mdat', 'latin1'), u64(mdatSize)]);
    fs.writeSync(fd, hdr, 0, 16, mdatStart);
    const { moov, durationSec } = buildMoov(tracks, samplesByTrack);
    write(moov);
    return { durationSec, parts, samples: total };
  } finally {
    fs.closeSync(fd);
  }
}
