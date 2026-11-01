// Platform file (Muse Muse platform services). Don't edit: lib/platform/video.ts uses it.
//
// A small MP4 writer for one video track: the boxes a player needs (ftyp, moov with one trak, mdat), the index before
// the data so a page can start playing before the whole file has arrived, H.264 ("avc1") or VP9 ("vp09") samples from
// WebCodecs. Written for Muse Muse from the ISO base media file format (ISO/IEC 14496-12 and 14496-15) and the VP9
// codec binding for ISOBMFF, no packages. readMp4Info reads a file back (duration, size, codec, sample count), for the
// platform's check and for tests. Runs in the browser and in Node.

export interface Mp4Sample {
  data: Uint8Array;
  /** Presentation time in microseconds, from 0. */
  timestampUs: number;
  durationUs: number;
  key: boolean;
}

export interface Mp4Track {
  codec: "avc" | "vp9";
  width: number;
  height: number;
  /** For H.264: the avcC record WebCodecs gives as decoderConfig.description. */
  description?: Uint8Array;
  /** For VP9: profile and level as in the codec string vp09.PP.LL.08. */
  vp9?: { profile: number; level: number };
  samples: Mp4Sample[];
}

/** Ticks a second for the track's times: whole ticks for 24, 25, 30, 50 and 60 frames a second. */
export const MP4_TIMESCALE = 90000;

class Writer {
  private parts: number[] = [];
  u8(n: number) {
    this.parts.push(n & 0xff);
    return this;
  }
  u16(n: number) {
    return this.u8(n >> 8).u8(n);
  }
  u32(n: number) {
    return this.u8(n >>> 24).u8(n >>> 16).u8(n >>> 8).u8(n);
  }
  bytes(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.parts.push(b[i]! & 0xff);
    return this;
  }
  text(s: string) {
    return this.bytes([...s].map((c) => c.charCodeAt(0)));
  }
  zeros(n: number) {
    for (let i = 0; i < n; i++) this.parts.push(0);
    return this;
  }
  get out(): number[] {
    return this.parts;
  }
}

function box(type: string, ...content: Array<number[] | Uint8Array>): number[] {
  const body = content.flatMap((c) => Array.from(c));
  return new Writer().u32(8 + body.length).text(type).bytes(body).out;
}

function fullBox(type: string, version: number, flags: number, ...content: Array<number[] | Uint8Array>): number[] {
  return box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], ...content);
}

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

function matrix(w: Writer) {
  for (const v of MATRIX) w.u32(v);
  return w;
}

function sampleEntry(track: Mp4Track): number[] {
  const w = new Writer()
    .zeros(6)
    .u16(1) // data_reference_index
    .u16(0)
    .u16(0)
    .zeros(12)
    .u16(track.width)
    .u16(track.height)
    .u32(0x00480000)
    .u32(0x00480000)
    .u32(0)
    .u16(1) // frame_count
    .zeros(32) // compressorname
    .u16(0x0018)
    .u16(0xffff);
  if (track.codec === "avc") {
    if (!track.description?.length) throw new Error("H.264 samples need the encoder's avcC description.");
    return box("avc1", w.out, box("avcC", track.description));
  }
  const vp = track.vp9 ?? { profile: 0, level: 31 };
  // vpcC, version 1: profile, level, bit depth 8 with 4:2:0 colocated chroma, BT.709 colours, limited range, no init data.
  const vpcC = fullBox("vpcC", 1, 0, [vp.profile, vp.level, (8 << 4) | (1 << 1) | 0, 1, 1, 1, 0, 0]);
  return box("vp09", w.out, vpcC);
}

function ticks(us: number): number {
  return Math.round((us * MP4_TIMESCALE) / 1_000_000);
}

/** The finished MP4 file. Samples must be in decode order, which for these encoders is presentation order. */
export function muxMp4(track: Mp4Track): Uint8Array {
  const samples = track.samples;
  if (!samples.length) throw new Error("A video needs at least one frame.");
  if (!samples[0]!.key) throw new Error("A video must start with a key frame.");
  const starts = samples.map((s) => ticks(s.timestampUs));
  const ends = samples.map((s, i) => (i + 1 < samples.length ? starts[i + 1]! : ticks(s.timestampUs + s.durationUs)));
  const deltas = samples.map((_, i) => Math.max(1, ends[i]! - starts[i]!));
  const mediaDuration = deltas.reduce((a, b) => a + b, 0);
  const movieDuration = Math.round((mediaDuration / MP4_TIMESCALE) * 1000);

  const stts: Array<[number, number]> = [];
  for (const d of deltas) {
    const last = stts.at(-1);
    if (last && last[1] === d) last[0]++;
    else stts.push([1, d]);
  }
  const sttsBody = new Writer().u32(stts.length);
  for (const [count, delta] of stts) sttsBody.u32(count).u32(delta);
  const keys = samples.flatMap((s, i) => (s.key ? [i + 1] : []));
  const stssBody = new Writer().u32(keys.length);
  for (const k of keys) stssBody.u32(k);
  const stszBody = new Writer().u32(0).u32(samples.length);
  for (const s of samples) stszBody.u32(s.data.length);

  const ftyp = box("ftyp", new Writer().text("isom").u32(0x200).text("isomiso2").text(track.codec === "avc" ? "avc1" : "vp09").text("mp41").out);

  const moovFor = (dataOffset: number) => {
    const stbl = box(
      "stbl",
      fullBox("stsd", 0, 0, new Writer().u32(1).out, sampleEntry(track)),
      fullBox("stts", 0, 0, sttsBody.out),
      ...(keys.length === samples.length ? [] : [fullBox("stss", 0, 0, stssBody.out)]),
      fullBox("stsc", 0, 0, new Writer().u32(1).u32(1).u32(samples.length).u32(1).out),
      fullBox("stsz", 0, 0, stszBody.out),
      fullBox("stco", 0, 0, new Writer().u32(1).u32(dataOffset).out),
    );
    const minf = box(
      "minf",
      fullBox("vmhd", 0, 1, new Writer().zeros(8).out),
      box("dinf", fullBox("dref", 0, 0, new Writer().u32(1).out, fullBox("url ", 0, 1))),
      stbl,
    );
    const mdia = box(
      "mdia",
      fullBox("mdhd", 0, 0, new Writer().u32(0).u32(0).u32(MP4_TIMESCALE).u32(mediaDuration).u16(0x55c4).u16(0).out),
      fullBox("hdlr", 0, 0, new Writer().u32(0).text("vide").zeros(12).text("VideoHandler").u8(0).out),
      minf,
    );
    const tkhd = fullBox(
      "tkhd",
      0,
      3,
      matrix(new Writer().u32(0).u32(0).u32(1).u32(0).u32(movieDuration).zeros(8).u16(0).u16(0).u16(0).u16(0))
        .u32(track.width * 0x10000)
        .u32(track.height * 0x10000).out,
    );
    const mvhd = fullBox("mvhd", 0, 0, matrix(new Writer().u32(0).u32(0).u32(1000).u32(movieDuration).u32(0x00010000).u16(0x0100).zeros(10)).zeros(24).u32(2).out);
    return box("moov", mvhd, box("trak", tkhd, mdia));
  };
  // The index comes first, so the data starts after ftyp, moov and mdat's own header. moov's size doesn't depend on
  // the offset's value, so one measuring pass is enough.
  const moovSize = moovFor(0).length;
  const moov = moovFor(ftyp.length + moovSize + 8);
  const dataBytes = samples.reduce((n, s) => n + s.data.length, 0);
  const out = new Uint8Array(ftyp.length + moov.length + 8 + dataBytes);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  let at = ftyp.length + moov.length;
  new DataView(out.buffer).setUint32(at, 8 + dataBytes);
  out.set([0x6d, 0x64, 0x61, 0x74], at + 4); // "mdat"
  at += 8;
  for (const s of samples) {
    out.set(s.data, at);
    at += s.data.length;
  }
  return out;
}

export interface Mp4Info {
  brand: string;
  durationMs: number;
  width: number;
  height: number;
  codec: string | null;
  samples: number;
  keyFrames: number | null;
  /** True when every sample sits inside the file. */
  complete: boolean;
}

/** Reads an MP4's top boxes and its first video track. Null for a file that isn't MP4. */
export function readMp4Info(bytes: Uint8Array): Mp4Info | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = (at: number) => String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
  const children = (start: number, end: number): Array<{ type: string; start: number; end: number }> => {
    const out = [];
    for (let at = start; at + 8 <= end; ) {
      let size = view.getUint32(at);
      if (size === 1 && at + 16 <= end) size = Number(view.getBigUint64(at + 8));
      if (size < 8 || at + size > end) break;
      out.push({ type: type(at), start: at, end: at + size });
      at += size;
    }
    return out;
  };
  const top = children(0, bytes.length);
  const ftyp = top.find((b) => b.type === "ftyp");
  const moov = top.find((b) => b.type === "moov");
  if (!ftyp || !moov) return null;
  const find = (parent: { start: number; end: number }, path: string[], header = 8): { start: number; end: number } | null => {
    let cur: { start: number; end: number } | null = parent;
    let skip = header;
    for (const name of path) {
      const inner: { type: string; start: number; end: number } | undefined = children(cur!.start + skip, cur!.end).find((b) => b.type === name);
      if (!inner) return null;
      cur = inner;
      skip = name === "stsd" ? 16 : 8;
    }
    return cur;
  };
  const mvhd = find(moov, ["mvhd"]);
  if (!mvhd) return null;
  const v1 = bytes[mvhd.start + 8] === 1;
  const timescale = view.getUint32(mvhd.start + (v1 ? 28 : 20));
  const duration = v1 ? Number(view.getBigUint64(mvhd.start + 32)) : view.getUint32(mvhd.start + 24);
  let width = 0;
  let height = 0;
  let codec: string | null = null;
  let count = 0;
  let keyFrames: number | null = null;
  let complete = false;
  for (const trak of children(moov.start + 8, moov.end).filter((b) => b.type === "trak")) {
    const hdlr = find(trak, ["mdia", "hdlr"]);
    if (!hdlr || type(hdlr.start + 8 + 4) !== "vide") continue;
    const tkhd = find(trak, ["tkhd"]);
    if (tkhd) {
      const tv1 = bytes[tkhd.start + 8] === 1;
      const base = tkhd.start + (tv1 ? 96 : 84);
      width = Math.round(view.getUint32(base) / 0x10000);
      height = Math.round(view.getUint32(base + 4) / 0x10000);
    }
    const stsd = find(trak, ["mdia", "minf", "stbl", "stsd"]);
    if (stsd && stsd.start + 24 <= stsd.end) codec = type(stsd.start + 16);
    const stsz = find(trak, ["mdia", "minf", "stbl", "stsz"]);
    const sizes: number[] = [];
    if (stsz) {
      const fixed = view.getUint32(stsz.start + 12);
      count = view.getUint32(stsz.start + 16);
      for (let i = 0; i < count; i++) sizes.push(fixed || view.getUint32(stsz.start + 20 + i * 4));
    }
    const stss = find(trak, ["mdia", "minf", "stbl", "stss"]);
    keyFrames = stss ? view.getUint32(stss.start + 12) : count;
    const stco = find(trak, ["mdia", "minf", "stbl", "stco"]);
    const stsc = find(trak, ["mdia", "minf", "stbl", "stsc"]);
    if (stco && stsc && view.getUint32(stco.start + 12) === 1 && view.getUint32(stsc.start + 12) === 1) {
      const offset = view.getUint32(stco.start + 16);
      complete = offset + sizes.reduce((a, b) => a + b, 0) <= bytes.length;
    }
    break;
  }
  return {
    brand: type(ftyp.start + 4),
    durationMs: timescale ? Math.round((duration / timescale) * 1000) : 0,
    width,
    height,
    codec,
    samples: count,
    keyFrames,
    complete,
  };
}
