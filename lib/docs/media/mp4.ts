/**
 * Reads an MP4 or MOV header (ISO base media boxes) in plain TypeScript: the video track's codec, displayed size,
 * frame rate and frame count. SAM 3.1 numbers its output by source frame and bills per frame, and it takes only H.264,
 * H.265 and MPEG-4 video, so the demos read this before sending a clip and use it to line overlays up with playback.
 */

export interface Mp4Info {
  /** The video sample entry's four-character code: avc1, avc3, hvc1, hev1, mp4v, vp09, av01... */
  codec: string | null;
  /** Displayed size, after the track's rotation. */
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  durationSec: number;
  frames: number;
  fps: number;
  hasAudio: boolean;
  /** The index (moov) comes before the media (mdat), so nothing needs remuxing (sam/segmenting, MP4 faststart). */
  faststart: boolean;
}

interface Box {
  type: string;
  start: number;
  /** Where the box's contents begin, after its header. */
  body: number;
  end: number;
}

function boxes(v: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = v.getUint32(at);
    const type = String.fromCharCode(v.getUint8(at + 4), v.getUint8(at + 5), v.getUint8(at + 6), v.getUint8(at + 7));
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > end) break;
      size = Number(v.getBigUint64(at + 8));
      body = at + 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < body - at || at + size > end) break; // truncated: keep what we have
    out.push({ type, start: at, body, end: at + size });
    at += size;
  }
  return out;
}

const child = (v: DataView, parent: Box, type: string) => boxes(v, parent.body, parent.end).find((b) => b.type === type);

function fullBoxTimes(v: DataView, box: Box): { timescale: number; duration: number } {
  const version = v.getUint8(box.body);
  if (version === 1) {
    return { timescale: v.getUint32(box.body + 20), duration: Number(v.getBigUint64(box.body + 24)) };
  }
  return { timescale: v.getUint32(box.body + 12), duration: v.getUint32(box.body + 16) };
}

function rotationOf(v: DataView, tkhd: Box): Mp4Info["rotation"] {
  const version = v.getUint8(tkhd.body);
  const matrix = tkhd.body + (version === 1 ? 44 : 32) + 8; // past the times, track id, reserved, layer, group, volume
  const a = v.getInt32(matrix);
  const b = v.getInt32(matrix + 4);
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  const r = ((deg % 360) + 360) % 360;
  return r === 90 || r === 180 || r === 270 ? r : 0;
}

/** Parses the header, or returns null when the bytes aren't an MP4/MOV with a video track. */
export function parseMp4(bytes: Uint8Array): Mp4Info | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = boxes(v, 0, bytes.length);
  const moov = top.find((b) => b.type === "moov");
  if (!moov) return null;
  const mdat = top.find((b) => b.type === "mdat");
  let video: Omit<Mp4Info, "hasAudio" | "faststart"> | null = null;
  let hasAudio = false;
  try {
    for (const trak of boxes(v, moov.body, moov.end).filter((b) => b.type === "trak")) {
      const mdia = child(v, trak, "mdia");
      const hdlr = mdia && child(v, mdia, "hdlr");
      if (!mdia || !hdlr) continue;
      const handler = String.fromCharCode(...bytes.subarray(hdlr.body + 8, hdlr.body + 12));
      if (handler === "soun") hasAudio = true;
      if (handler !== "vide" || video) continue;
      const mdhd = child(v, mdia, "mdhd");
      const minf = child(v, mdia, "minf");
      const stbl = minf && child(v, minf, "stbl");
      const tkhd = child(v, trak, "tkhd");
      if (!mdhd || !stbl || !tkhd) continue;
      const { timescale, duration } = fullBoxTimes(v, mdhd);
      const stsd = child(v, stbl, "stsd");
      let codec: string | null = null;
      let width = 0;
      let height = 0;
      if (stsd && v.getUint32(stsd.body + 4) > 0) {
        const entry = stsd.body + 8;
        codec = String.fromCharCode(...bytes.subarray(entry + 4, entry + 8));
        width = v.getUint16(entry + 32);
        height = v.getUint16(entry + 34);
      }
      // Frame count and rate come from the sample table: the media duration can run a frame or two long when the
      // encoder delays B-frames, so dividing by it would read 24 fps as 23.8.
      let frames = 0;
      let commonDelta = 0;
      let commonCount = 0;
      const stts = child(v, stbl, "stts");
      if (stts) {
        const count = v.getUint32(stts.body + 4);
        for (let i = 0; i < count; i++) {
          const n = v.getUint32(stts.body + 8 + i * 8);
          const delta = v.getUint32(stts.body + 12 + i * 8);
          frames += n;
          if (n > commonCount) [commonCount, commonDelta] = [n, delta];
        }
      }
      const rotation = rotationOf(v, tkhd);
      const fps = timescale && commonDelta ? Math.round((timescale / commonDelta) * 1000) / 1000 : 0;
      const durationSec = fps && frames ? frames / fps : timescale ? duration / timescale : 0;
      if (rotation === 90 || rotation === 270) [width, height] = [height, width];
      video = { codec, width, height, rotation, durationSec, frames, fps };
    }
  } catch {
    return null; // a box pointed past the end of the file
  }
  if (!video) return null;
  return { ...video, hasAudio, faststart: !mdat || moov.start < mdat.start };
}

/** Codecs SAM 3.1 takes (sam/segmenting, Limits): H.264, H.265 and MPEG-4 in MP4 or MOV. */
export function samAcceptsCodec(codec: string | null): boolean {
  return codec === null || ["avc1", "avc3", "hvc1", "hev1", "mp4v"].includes(codec);
}

export function codecLabel(codec: string | null): string {
  if (!codec) return "unknown codec";
  if (codec.startsWith("avc")) return "H.264";
  if (codec === "hvc1" || codec === "hev1") return "H.265";
  if (codec === "mp4v") return "MPEG-4";
  if (codec === "vp09") return "VP9";
  if (codec === "av01") return "AV1";
  return codec;
}
