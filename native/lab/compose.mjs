#!/usr/bin/env node
// The compositor: puts a screen recording inside a generic device frame on the Meta-blue backdrop, at 1920x1080 with an
// honest caption, and takes a poster from the result. Under 25 s and about 12 MB, per docs/NATIVE_LAB.md.
//
//   node compose.mjs --recording in.mp4 --form phone --caption "On an Android emulator" --note "..." --out dir
//
// Writes <out>/clip.mp4 and <out>/poster.jpg. Captions use ffmpeg's drawtext filter with the vendored Inter. The Homebrew
// `ffmpeg` formula doesn't have drawtext, so setup/mac.sh also installs `ffmpeg-full`. A Mac with only the plain formula
// draws the caption with lib/caption.jxa instead. A box with neither still gets a clip, marked captionBurned: false, and
// the platform shows the caption as text beside it.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CANVAS, CAPTION, layoutFor, renderFrameLayer } from "./lib/frames.mjs";
import { run } from "./lib/proc.mjs";
import { findFfmpeg, probeVideo } from "./lib/tools.mjs";

export const MAX_CLIP_SECONDS = 25;
const FPS = 30;
const POSTER_NEAR_END = 0.85;
const ENCODE_TIMEOUT_MS = 180_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT = path.join(HERE, "assets", "Inter-SemiBold.ttf");
const CAPTION_JXA = path.join(HERE, "lib", "caption.jxa");
const TO_709 = "out_color_matrix=bt709:out_range=tv";
const TAG_709 = "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";

/** A path as a value inside a filter graph, on any platform: forward slashes, with : and ' escaped. */
export function filterPath(p) {
  return String(p)
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

/** One drawtext filter. The words come from a file with expansion off, so none of them can act as filter syntax. */
export function drawtextFilter({ textFile, font, size, y, alpha }) {
  return [
    `drawtext=fontfile='${filterPath(font)}'`,
    `textfile='${filterPath(textFile)}'`,
    "expansion=none",
    `fontsize=${size}`,
    `fontcolor=white@${alpha}`,
    "x=(w-text_w)/2",
    `y=${y}`,
  ].join(":");
}

/**
 * The ffmpeg arguments for the clip. Inputs are the recording, the raw frame layer and, for a caption drawn outside
 * ffmpeg, its PNG.
 *
 * @param {object} p
 * @param {string} p.ffmpeg
 * @param {string} p.recording
 * @param {string} p.frameLayer raw RGBA at CANVAS size
 * @param {{ x: number, y: number, w: number, h: number }} p.screen
 * @param {string} p.out
 * @param {number} [p.maxSeconds]
 * @param {{ textFile: string, font: string, size: number, y: number, alpha: number }[]} [p.drawtext]
 * @param {string | null} [p.captionPng]
 */
export function composeArgs({ ffmpeg, recording, frameLayer, screen, out, maxSeconds = MAX_CLIP_SECONDS, drawtext = [], captionPng = null }) {
  const graph = [
    `color=c=black:s=${CANVAS.w}x${CANVAS.h}:r=${FPS},format=gbrp[base]`,
    `[0:v]fps=${FPS},scale=${screen.w}:${screen.h}:flags=lanczos,setsar=1,format=gbrp[rec]`,
    `[base][rec]overlay=${screen.x}:${screen.y}:shortest=1:format=gbrp[placed]`,
    `[placed][1:v]overlay=0:0:format=gbrp[framed]`,
  ];
  let last = "framed";
  if (captionPng) {
    graph.push(`[${last}][2:v]overlay=0:0:format=gbrp[captioned]`);
    last = "captioned";
  }
  const filters = [...drawtext.map(drawtextFilter), `scale=${TO_709}`, "format=yuv420p", TAG_709];
  graph.push(`[${last}]${filters.join(",")}[out]`);
  return [
    ffmpeg,
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-t",
    String(maxSeconds),
    "-i",
    recording,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s",
    `${CANVAS.w}x${CANVAS.h}`,
    "-i",
    frameLayer,
    ...(captionPng ? ["-i", captionPng] : []),
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[out]",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "26",
    "-maxrate",
    "3500k",
    "-bufsize",
    "7000k",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    "-movflags",
    "+faststart",
    out,
  ];
}

/** The poster: one frame near the end of the clip, when the page has settled. */
export function posterArgs({ ffmpeg, clip, seconds, out }) {
  const at = Math.max(0, (seconds ?? 0) * POSTER_NEAR_END);
  return [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", at.toFixed(2), "-i", clip, "-frames:v", "1", "-q:v", "3", out];
}

/** The two caption lines, positioned. */
export function captionLines(caption, note) {
  const lines = [{ text: caption, y: CAPTION.titleY, size: CAPTION.titleSize, alpha: 1 }];
  if (note) lines.push({ text: note, y: CAPTION.noteY, size: CAPTION.noteSize, alpha: 0.82 });
  return lines;
}

async function captionLayer({ ffmpegInfo, caption, note, workDir, exec, signal, platform }) {
  const lines = captionLines(caption, note);
  if (ffmpegInfo.drawtext && existsSync(FONT)) {
    const drawtext = [];
    for (const [i, line] of lines.entries()) {
      const textFile = path.join(workDir, `caption-${i}.txt`);
      await writeFile(textFile, line.text);
      drawtext.push({ textFile, font: FONT, size: line.size, y: line.y, alpha: line.alpha });
    }
    return { drawtext, captionPng: null, burned: true };
  }
  if (platform === "darwin") {
    const specFile = path.join(workDir, "caption.json");
    const captionPng = path.join(workDir, "caption.png");
    await writeFile(specFile, JSON.stringify({ width: CANVAS.w, height: CANVAS.h, lines }));
    const reply = await exec(["osascript", "-l", "JavaScript", CAPTION_JXA, specFile, captionPng], { timeoutMs: 20_000, signal });
    if (reply.code === 0 && existsSync(captionPng)) return { drawtext: [], captionPng, burned: true };
  }
  return { drawtext: [], captionPng: null, burned: false };
}

/**
 * @param {object} p
 * @param {string} p.recording
 * @param {string} p.outDir
 * @param {"phone" | "desktop"} p.form
 * @param {string} p.caption
 * @param {string} [p.note]
 * @param {string} [p.ffmpeg] an ffmpeg to use, otherwise the best one found
 * @param {AbortSignal} [p.signal]
 * @param {typeof run} [p.exec]
 * @param {string} [p.platform]
 * @returns {Promise<{ clip: string, poster: string | null, seconds: number | null, captionBurned: boolean }>}
 */
export async function composeClip({ recording, outDir, form, caption, note = "", ffmpeg, signal, exec = run, platform = process.platform }) {
  const ffmpegInfo = await findFfmpeg({ configured: ffmpeg, exec, platform });
  if (!ffmpegInfo) throw new Error("ffmpeg isn't installed.");
  const source = await probeVideo(ffmpegInfo.path, recording, { exec, signal });
  if (!source) throw new Error("The recording can't be read.");

  await mkdir(outDir, { recursive: true });
  const workDir = await mkdtemp(path.join(outDir, ".compose-"));
  try {
    const layout = layoutFor(form, source.width, source.height);
    const frameLayer = path.join(workDir, "frame.rgba");
    await writeFile(frameLayer, renderFrameLayer(layout));
    const { drawtext, captionPng, burned } = await captionLayer({ ffmpegInfo, caption, note, workDir, exec, signal, platform });

    const clip = path.join(outDir, "clip.mp4");
    const args = composeArgs({ ffmpeg: ffmpegInfo.path, recording, frameLayer, screen: layout.screen, out: clip, drawtext, captionPng });
    const encoded = await exec(args, { timeoutMs: ENCODE_TIMEOUT_MS, signal });
    if (encoded.code !== 0) throw new Error(`ffmpeg couldn't make the clip: ${String(encoded.stderr).slice(-400)}`);

    const seconds = source.seconds === null ? null : Math.min(source.seconds, MAX_CLIP_SECONDS);
    const posterOut = path.join(outDir, "poster.jpg");
    const posterReply = await exec(posterArgs({ ffmpeg: ffmpegInfo.path, clip, seconds, out: posterOut }), { timeoutMs: 30_000, signal });
    return { clip, poster: posterReply.code === 0 ? posterOut : null, seconds, captionBurned: burned };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { values } = parseArgs({
    options: {
      recording: { type: "string" },
      form: { type: "string", default: "phone" },
      caption: { type: "string", default: "" },
      note: { type: "string", default: "" },
      out: { type: "string" },
      ffmpeg: { type: "string" },
    },
  });
  if (!values.recording || !values.out) {
    process.stderr.write("usage: compose.mjs --recording in.mp4 --form phone|desktop --caption text [--note text] --out dir\n");
    process.exit(2);
  }
  const summary = await composeClip({
    recording: values.recording,
    outDir: values.out,
    form: values.form === "desktop" ? "desktop" : "phone",
    caption: values.caption,
    note: values.note,
    ffmpeg: values.ffmpeg,
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
