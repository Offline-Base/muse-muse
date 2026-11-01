// Finds the tools a box has, and what it can therefore run. ffmpeg comes first because the Homebrew `ffmpeg` formula has
// no drawtext filter, so captions need `ffmpeg-full` or, on a Mac without it, lib/caption.jxa (see compose.mjs).
import { existsSync } from "node:fs";
import path from "node:path";
import { run } from "./proc.mjs";
import { GRAY_WIDTH, screenStats } from "./pixels.mjs";
import { grayArgs, shotToJpegArgs } from "./commands.mjs";

/** Most capable first. */
export function ffmpegCandidates({ configured = null, platform = process.platform } = {}) {
  const list = [];
  if (configured) list.push(configured);
  if (platform === "darwin") list.push("/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg");
  if (platform === "win32") list.push("C:\\MuseLab\\tools\\ffmpeg\\bin\\ffmpeg.exe");
  list.push("ffmpeg");
  return list;
}

/** ffprobe beside this ffmpeg. */
export function ffprobeFor(ffmpeg) {
  const dir = path.dirname(ffmpeg);
  const ext = path.extname(ffmpeg);
  return dir === "." ? "ffprobe" : path.join(dir, `ffprobe${ext}`);
}

/**
 * The first ffmpeg with drawtext, or failing that the first that runs at all.
 * @returns {Promise<{ path: string, drawtext: boolean } | null>}
 */
export async function findFfmpeg({ configured = null, exec = run, platform = process.platform } = {}) {
  let fallback = null;
  for (const candidate of ffmpegCandidates({ configured, platform })) {
    if (path.isAbsolute(candidate) && !existsSync(candidate)) continue;
    const reply = await exec([candidate, "-hide_banner", "-filters"], { timeoutMs: 15_000 });
    if (reply.code !== 0) continue;
    if (/\bdrawtext\b/.test(String(reply.stdout))) return { path: candidate, drawtext: true };
    fallback ??= { path: candidate, drawtext: false };
  }
  return fallback;
}

/** Width, height and seconds of a recording. */
export async function probeVideo(ffmpeg, file, { exec = run, signal } = {}) {
  const reply = await exec(
    [ffprobeFor(ffmpeg), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file],
    { timeoutMs: 20_000, signal },
  );
  if (reply.code !== 0) return null;
  try {
    const data = JSON.parse(String(reply.stdout));
    const stream = data.streams?.[0];
    const seconds = Number(data.format?.duration);
    if (!stream?.width || !stream?.height) return null;
    return { width: stream.width, height: stream.height, seconds: Number.isFinite(seconds) ? seconds : null };
  } catch {
    return null;
  }
}

/** A screenshot's stats for pixels.mjs, or null if ffmpeg couldn't read it. */
export async function screenshotStats(ffmpeg, png, crop, { exec = run, signal } = {}) {
  const size = await probeVideo(ffmpeg, png, { exec, signal });
  if (!size) return null;
  const height = Math.max(2, Math.round(((size.height / size.width) * GRAY_WIDTH) / 2) * 2);
  const reply = await exec(grayArgs(ffmpeg, png, GRAY_WIDTH), { timeoutMs: 20_000, signal, binary: true });
  if (reply.code !== 0 || reply.stdout.length < GRAY_WIDTH * 2) return null;
  const rows = Math.min(height, Math.floor(reply.stdout.length / GRAY_WIDTH));
  return screenStats(reply.stdout, GRAY_WIDTH, rows, crop);
}

/** A screenshot as a JPEG. Throws nothing: false means it didn't work. */
export async function screenshotToJpeg(ffmpeg, png, jpg, { exec = run, signal } = {}) {
  const reply = await exec(shotToJpegArgs(ffmpeg, png, jpg), { timeoutMs: 20_000, signal });
  return reply.code === 0;
}

/**
 * What this box can run, for the claim call and the status action.
 *
 * @param {object} config see lib/config.mjs
 * @returns {Promise<{ kinds: string[], tools: object }>}
 */
export async function probeCapabilities(config, { exec = run } = {}) {
  const tools = {};
  const kinds = [];
  const ffmpeg = await findFfmpeg({ configured: config.ffmpeg, exec });
  tools.ffmpeg = ffmpeg ? { ok: true, drawtext: ffmpeg.drawtext } : { ok: false };
  if (config.lane === "windows") {
    if (ffmpeg) kinds.push("desktop_windows");
    return { kinds: filterKinds(kinds, config), tools };
  }
  const simctl = await exec(["xcrun", "simctl", "help"], { timeoutMs: 20_000 });
  tools.simctl = { ok: simctl.code === 0 };
  if (simctl.code === 0 && ffmpeg) kinds.push("ios_sim", "glasses_sim");
  const adb = await exec(["adb", "version"], { timeoutMs: 20_000 });
  const emulator = await exec(["emulator", "-list-avds"], { timeoutMs: 20_000 });
  const hasAvd = emulator.code === 0 && String(emulator.stdout).split(/\r?\n/).includes(config.android.avd);
  tools.android = { adb: adb.code === 0, emulator: emulator.code === 0, avd: hasAvd };
  if (adb.code === 0 && hasAvd && ffmpeg) kinds.push("android_emu");
  const llama = Boolean(config.android.llamaServer && existsSync(config.android.llamaServer));
  tools.android.llamaServer = llama;
  if (adb.code === 0 && hasAvd && ffmpeg && llama) kinds.push("gguf_emu");
  if (ffmpeg) kinds.push("desktop_mac");
  return { kinds: filterKinds(kinds, config), tools };
}

function filterKinds(kinds, config) {
  return config.kinds ? kinds.filter((kind) => config.kinds.includes(kind)) : kinds;
}
