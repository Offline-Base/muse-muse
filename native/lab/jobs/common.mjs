// What the runners share: the job context, waiting, screenshots, and turning a recording into a clip.
import { mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { LabError } from "../lib/errors.mjs";
import { screenshotStats, screenshotToJpeg } from "../lib/tools.mjs";
import { captionFor, noteFor } from "../lib/caption.mjs";

export const CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".mp4": "video/mp4",
  ".json": "application/json",
  ".txt": "text/plain",
};

export function contentTypeOf(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * The plan for when screenshots are taken, in ms from the start of the recording: spread out, with the last at the end.
 *
 * @param {number} shots
 * @param {number} recordSeconds
 */
export function shotSchedule(shots, recordSeconds) {
  const total = recordSeconds * 1000;
  return Array.from({ length: shots }, (_, i) => Math.round((total * (i + 1)) / shots) - (i + 1 === shots ? 500 : 0));
}

/** Calls `check` until it returns something truthy or time runs out. Returns that value, or null. */
export async function waitFor(ctx, check, { timeoutMs, everyMs = 500 }) {
  const end = ctx.now() + timeoutMs;
  for (;;) {
    ctx.throwIfAborted();
    const value = await check();
    if (value) return value;
    if (ctx.now() >= end) return null;
    await ctx.sleep(Math.min(everyMs, Math.max(0, end - ctx.now())));
  }
}

/**
 * When the lab stops waiting for a phone's health report, in ms after launch. The shell reports after the page loads and
 * scrolls, or at 60 s if it never does (SELFTEST_WATCHDOG_MS in ProductScreen.js), so this leaves that report time to arrive.
 */
export const REPORT_BY_MS = 70_000;

/** How much longer to wait for the health report, at least a last few seconds even if the recording ran long. */
export function reportWaitMs(ctx, startedMs) {
  return Math.max(5_000, startedMs + REPORT_BY_MS - ctx.now());
}

/**
 * The report the shell posted to the platform, if it's from this launch. A retry keeps its job id and its selftest token,
 * so the platform's copy can be the last attempt's. The shell runs on this box, so `at` is on the same clock.
 */
export async function platformReport(ctx, sinceMs) {
  const report = await ctx.fetchSelftest();
  return report && Date.parse(report.at) >= sinceMs ? report : null;
}

/** A tool that must work. Anything else ends the job as a lab problem, with its stderr in the job's log only. */
export async function must(ctx, code, message, argv, opts) {
  const reply = await ctx.exec(argv, opts);
  ctx.throwIfAborted();
  if (reply.spawnError) throw new LabError("tool_missing", `${argv[0]} isn't installed.`);
  if (reply.code !== 0 || reply.timedOut) {
    ctx.logLine(`${argv.slice(0, 3).join(" ")} exited with ${reply.code}: ${String(reply.stderr).slice(-400)}`);
    throw new LabError(code, message);
  }
  return reply;
}

/**
 * Keeps a screenshot as a JPEG for the build room, and returns its pixel stats for the blank check.
 *
 * @param {object} ctx
 * @param {string} png
 * @param {number} index one-based
 * @param {{ top?: number, bottom?: number }} crop
 * @param {object[]} files where the JPEG is added
 */
export async function keepShot(ctx, png, index, crop, files) {
  if (!existsSync(png) || statSync(png).size === 0) return null;
  const name = `shot-${index}.jpg`;
  const jpg = path.join(ctx.dir, name);
  const made = await screenshotToJpeg(ctx.ffmpeg.path, png, jpg, { exec: ctx.exec, signal: ctx.signal });
  if (made) files.push({ path: jpg, name, role: "shot" });
  return screenshotStats(ctx.ffmpeg.path, png, crop, { exec: ctx.exec, signal: ctx.signal });
}

/**
 * The recording in its frame, with its caption and poster. A clip that can't be made is a warning, not a failed check:
 * the product isn't to blame.
 *
 * @param {object} ctx
 * @param {{ recording: string | null, form: "phone" | "desktop", device: object, files: object[], warnings: string[] }} p
 * @returns {Promise<boolean>} whether the caption is burned in
 */
export async function composeInto(ctx, { recording, form, device, files, warnings }) {
  if (!recording || !existsSync(recording) || statSync(recording).size === 0) {
    warnings.push("There's no clip: the screen recording didn't come out.");
    return false;
  }
  const caption = captionFor(ctx.job.kind, device);
  const outDir = path.join(ctx.dir, "composed");
  await mkdir(outDir, { recursive: true });
  try {
    const composed = await ctx.compose({
      recording,
      outDir,
      form,
      caption,
      note: noteFor(ctx.job.kind),
      ffmpeg: ctx.ffmpeg.path,
      signal: ctx.signal,
    });
    files.push({ path: composed.clip, name: "clip.mp4", role: "clip", caption });
    if (composed.poster) files.push({ path: composed.poster, name: "poster.jpg", role: "poster", caption });
    return composed.captionBurned === true;
  } catch (err) {
    ctx.throwIfAborted();
    ctx.logLine(`compose failed: ${err?.message ?? err}`);
    warnings.push("There's no clip: the lab couldn't compose the recording.");
    return false;
  }
}
