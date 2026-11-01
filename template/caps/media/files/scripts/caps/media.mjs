// Platform file (Muse Muse platform services). Don't edit. verify's caps step runs it through scripts/caps-check.mjs.
//
// The fixed checks for media made in the browser. Which parts the product has comes from brief.md's "- Media parts:"
// line. For each part:
//   video   the smoke test saw the made <video> play with a duration over 0 (tests/caps/media.ts, expectVideoPlays),
//           and the saved file is an MP4 whose own index says the same (or a WebM from the recorder fallback)
//   music   the saved MIDI file starts with MThd and holds at least one note, read here from its bytes
//   speech  the smoke test saw speak() make audio, with the open model or the browser's own voice
//   tiles   the smoke test saw findAll run on 2 to 4 tiles and merge without adding boxes (the merge itself is proven by
//           the platform's unit tests; the build only records counts)
// and for every product with media:
//   notices public/notices/media.txt is there and the product links to it
//   no-cdn  nothing in the product loads a model, wasm or script from another site
//
// What these rest on: video and music read the files the test saved, which a product test could replace with others it
// made; speech and tiles read the smoke test's record, which a product test could write itself. brief.md's parts line
// could be edited by the product, which would only drop checks. Media makes no gateway calls of its own beyond SAM's.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const PARTS = ["speech", "video", "music", "samTiling"];
const TILES_SMOKE = 4;

const REMOTE = [
  /\b(?:huggingface\.co|hf\.co|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|skypack\.dev|unpkg\.org|ffmpegwasm|tfhub\.dev|storage\.googleapis\.com)\b/i,
  /["'`]https?:\/\/[^"'`\s]+\.(?:onnx|wasm|bin|mjs|js|tflite|gguf|safetensors)(?:\?[^"'`\s]*)?["'`]/i,
];
const SOURCE = /\.(?:ts|tsx|js|jsx|mjs|css|html)$/;

function walk(dir, base) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name.startsWith(".")) return [];
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, base) : SOURCE.test(e.name) ? [path.relative(base, full).split(path.sep).join("/")] : [];
  });
}

const read = (file) => {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
};

/** The parts brief.md lists, in plan order. */
export function briefParts(root) {
  const text = read(path.join(root, "brief.md"))?.toString("utf8") ?? "";
  const line = text.match(/^- Media parts: (.+)$/m)?.[1] ?? "";
  const named = line.split(",").map((s) => s.trim());
  return PARTS.filter((p) => named.includes(p));
}

/** An MP4's duration in ms, its video codec and sample count, from its own boxes. Null when it isn't an MP4. */
export function mp4Info(bytes) {
  const type = (at) => bytes.toString("latin1", at + 4, at + 8);
  const kids = (start, end) => {
    const out = [];
    for (let at = start; at + 8 <= end; ) {
      const size = bytes.readUInt32BE(at);
      if (size < 8 || at + size > end) break;
      out.push({ type: type(at), start: at, end: at + size });
      at += size;
    }
    return out;
  };
  const top = kids(0, bytes.length);
  const moov = top.find((b) => b.type === "moov");
  if (!top.some((b) => b.type === "ftyp") || !moov) return null;
  const at = (parent, names) => {
    let cur = parent;
    for (const n of names) {
      cur = kids(cur.start + 8, cur.end).find((b) => b.type === n);
      if (!cur) return null;
    }
    return cur;
  };
  const mvhd = at(moov, ["mvhd"]);
  if (!mvhd) return null;
  const v1 = bytes[mvhd.start + 8] === 1;
  const timescale = bytes.readUInt32BE(mvhd.start + (v1 ? 28 : 20));
  const duration = v1 ? Number(bytes.readBigUInt64BE(mvhd.start + 32)) : bytes.readUInt32BE(mvhd.start + 24);
  let codec = null;
  let samples = 0;
  for (const trak of kids(moov.start + 8, moov.end).filter((b) => b.type === "trak")) {
    const stbl = at(trak, ["mdia", "minf", "stbl"]);
    const stsd = stbl && kids(stbl.start + 8, stbl.end).find((b) => b.type === "stsd");
    if (stsd) codec = type(stsd.start + 16);
    const stsz = stbl && kids(stbl.start + 8, stbl.end).find((b) => b.type === "stsz");
    if (stsz) samples = bytes.readUInt32BE(stsz.start + 16);
    if (codec) break;
  }
  return { durationMs: timescale ? Math.round((duration / timescale) * 1000) : 0, codec, samples };
}

/** Note-on events with a velocity over 0 in a MIDI file, or -1 when it isn't MIDI. */
export function midiNoteCount(bytes) {
  if (bytes.length < 14 || bytes.toString("latin1", 0, 4) !== "MThd") return -1;
  let at = 8 + bytes.readUInt32BE(4);
  let notes = 0;
  while (at + 8 <= bytes.length && bytes.toString("latin1", at, at + 4) === "MTrk") {
    const end = Math.min(bytes.length, at + 8 + bytes.readUInt32BE(at + 4));
    let p = at + 8;
    let status = 0;
    const varLen = () => {
      let v = 0;
      for (let i = 0; i < 4 && p < end; i++) {
        const b = bytes[p++];
        v = (v << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      return v;
    };
    while (p < end) {
      varLen();
      if (bytes[p] & 0x80) status = bytes[p++];
      if (status === 0xff) {
        p++;
        const len = varLen();
        p += len;
        status = 0;
      } else if (status === 0xf0 || status === 0xf7) {
        const len = varLen();
        p += len;
        status = 0;
      } else if (status) {
        const kind = status & 0xf0;
        const one = kind === 0xc0 || kind === 0xd0;
        if (kind === 0x90 && !one && bytes[p + 1] > 0) notes++;
        p += one ? 1 : 2;
      } else break;
    }
    at = end;
  }
  return notes;
}

const recorded = (record, id) => (record?.checks ?? []).find((c) => c?.id === id);

function fromRecord(record, id, missing) {
  const seen = recorded(record, id);
  return { id, ok: seen?.ok === true, detail: seen ? String(seen.detail ?? "").slice(0, 200) : missing };
}

export async function check({ record, root }) {
  const parts = briefParts(root);
  const checks = [];
  if (!parts.length) checks.push({ id: "parts", ok: false, detail: "brief.md has no \"- Media parts:\" line naming speech, video, music or samTiling" });
  const dir = path.join(root, "test-results", "caps", "media");
  if (parts.includes("video")) {
    const seen = fromRecord(record, "video", "The smoke test didn't run expectVideoPlays from tests/caps/media.ts");
    const mp4 = read(path.join(dir, "video.mp4"));
    const webm = read(path.join(dir, "video.webm"));
    const info = mp4 ? mp4Info(mp4) : null;
    const file = mp4
      ? info && info.durationMs > 0 && info.samples > 0
        ? { ok: true, detail: `${info.codec ?? "video"} MP4, ${(info.durationMs / 1000).toFixed(1)} seconds, ${info.samples} frames` }
        : { ok: false, detail: "The saved video.mp4 isn't a playable MP4 with frames" }
      : webm && webm.length > 4 && webm.readUInt32BE(0) === 0x1a45dfa3
        ? { ok: true, detail: "a WebM from the recorder fallback, checked by the test only" }
        : { ok: false, detail: "The smoke test saved no video file" };
    checks.push({ id: "video", ok: seen.ok && file.ok, detail: `${seen.detail}; file: ${file.detail}` });
  }
  if (parts.includes("music")) {
    const seen = fromRecord(record, "music", "The smoke test didn't run expectMidi from tests/caps/media.ts");
    const mid = read(path.join(dir, "tune.mid"));
    const notes = mid ? midiNoteCount(mid) : -2;
    const ok = seen.ok && notes > 0;
    checks.push({ id: "music", ok, detail: notes === -2 ? "The smoke test saved no MIDI file" : notes < 0 ? "The saved tune.mid doesn't start with MThd" : notes === 0 ? "The saved MIDI file has no notes" : `${seen.detail}; the file has ${notes} notes` });
  }
  if (parts.includes("speech")) checks.push(fromRecord(record, "speech", "The smoke test didn't run expectSpeech from tests/caps/media.ts"));
  if (parts.includes("samTiling")) {
    const seen = recorded(record, "tiles");
    const n = (k) => Number(String(seen?.detail ?? "").match(new RegExp(`\\b${k}=(\\d+)`))?.[1] ?? NaN);
    const tiles = n("tiles");
    const raw = n("raw");
    const merged = n("merged");
    const ok = seen?.ok === true && tiles >= 2 && tiles <= TILES_SMOKE && merged <= raw;
    checks.push({
      id: "tiles",
      ok,
      detail: !seen
        ? "The smoke test didn't run expectTiles from tests/caps/media.ts"
        : tiles > TILES_SMOKE
          ? `The smoke test ran ${tiles} SAM tiles; at most ${TILES_SMOKE} are allowed`
          : `${tiles} tiles, ${raw} boxes found, ${merged} after merging`,
    });
  }
  if (parts.length) {
    const sources = ["app", "components", "lib", "public"].flatMap((d) => walk(path.join(root, d), root)).filter((f) => !f.startsWith("lib/platform/"));
    const text = (f) => read(path.join(root, f))?.toString("utf8") ?? "";
    const remote = sources.filter((f) => REMOTE.some((re) => re.test(text(f))));
    checks.push({ id: "no-cdn", ok: !remote.length, detail: remote.length ? `${remote.slice(0, 3).join(", ")} load${remote.length === 1 ? "s" : ""} a model or script from another site` : "Nothing loads a model or script from another site" });
    const has = existsSync(path.join(root, "public/notices/media.txt"));
    const linked = sources.some((f) => !f.startsWith("public/") && text(f).includes("/notices/media.txt"));
    checks.push({ id: "notices", ok: has && linked, detail: !has ? "public/notices/media.txt is missing" : linked ? "The open source notices are linked" : "Link \"Open source notices\" to /notices/media.txt from the page" });
  }
  return checks;
}
