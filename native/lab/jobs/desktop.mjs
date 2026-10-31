// desktop_mac and desktop_windows: unpacks the app, runs it with --muse-selftest, and turns the frames it captured into a
// recording. The Electron shell writes selftest.json, frames/ and stills/ to the folder it's given (native/shell-desktop/
// src/selftest.js). It opens the URL in its muse-product.json, so a lab template gets that file rewritten for the job. On
// a Mac the signature is checked too, and Gatekeeper's answer is recorded: it rejects an ad hoc app, which is expected.
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LabError } from "../lib/errors.mjs";
import {
  codesignAdHoc,
  codesignVerify,
  desktopSelftest,
  dittoExtract,
  ffconcatFromFrames,
  framesToMp4Args,
  plutilRaw,
  spctlAssess,
  swVersion,
  tarExtract,
} from "../lib/commands.mjs";
import { CROP } from "../lib/pixels.mjs";
import { evaluateCheck } from "../lib/rules.mjs";
import { composeInto, keepShot, must } from "./common.mjs";
import { findAppBundle } from "./simulator.mjs";

/** The shell gives a page 45 s to load before it starts capturing, and it needs time to write its report. */
const STARTUP_SLACK_MS = 75_000;
const FRAME_FILE = /\.(jpe?g|png)$/i;
const EXE_SKIP = /(uninstall|crashpad|squirrel|elevate|notification_helper)/i;
const PRODUCT_CONFIG = "muse-product.json";

/**
 * The frames to play. The shell names them in order and writes them only when the page paints, so a frame's time is when
 * its file was written.
 *
 * @param {string} dir the selftest folder
 * @returns {Promise<{ file: string, t: number }[]>}
 */
export async function listFrames(dir) {
  const folder = path.join(dir, "frames");
  const names = (await readdir(folder).catch(() => [])).filter((name) => FRAME_FILE.test(name)).sort();
  const frames = await Promise.all(
    names.map(async (name) => {
      const file = path.join(folder, name);
      return { file, t: (await stat(file)).mtimeMs };
    }),
  );
  const first = Math.min(...frames.map((frame) => frame.t));
  return frames.map((frame) => ({ file: frame.file, t: Math.round(frame.t - first) }));
}

/** The stills, in order. */
export async function listStills(dir) {
  const folder = path.join(dir, "stills");
  const names = await readdir(folder).catch(() => []);
  return names
    .filter((name) => FRAME_FILE.test(name))
    .sort()
    .map((name) => path.join(folder, name));
}

/** Points a lab template at the job's URL. A product app keeps the one it was packaged with. */
export async function pointAppAt(configFile, url, productName) {
  const current = await readFile(configFile, "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  if (!current) throw new LabError("install_failed", "The app has no product settings to point at this product.");
  await writeFile(configFile, JSON.stringify({ ...current, url, name: productName || current.name }));
}

/** The exe to run from an unpacked Windows app: the named one, or the first that isn't a helper. */
export async function findExe(dir, exeName = null) {
  const entries = await readdir(dir, { withFileTypes: true });
  const exes = entries.filter((e) => e.isFile() && /\.exe$/i.test(e.name)).map((e) => e.name);
  const chosen = exeName ? exes.find((e) => e.toLowerCase() === exeName.toLowerCase()) : exes.find((e) => !EXE_SKIP.test(e));
  if (chosen) return path.join(dir, chosen);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "locales" || entry.name === "resources") continue;
    const inner = await findExe(path.join(dir, entry.name), exeName);
    if (inner) return inner;
  }
  return null;
}

async function macExecutable(ctx, appBundle) {
  const plist = path.join(appBundle, "Contents", "Info.plist");
  const reply = await ctx.exec(plutilRaw(plist, "CFBundleExecutable"), { timeoutMs: 15_000 });
  const name = String(reply.stdout).trim();
  if (reply.code !== 0 || !name || name.includes("/")) throw new LabError("install_failed", "The Mac app has no program to run.");
  return path.join(appBundle, "Contents", "MacOS", name);
}

async function framesToRecording(ctx, dir, endMs) {
  const frames = await listFrames(dir);
  if (frames.length === 0) return null;
  const script = ffconcatFromFrames(frames, endMs);
  if (!script) return null;
  const listFile = path.join(ctx.dir, "frames.ffconcat");
  await writeFile(listFile, script);
  const recording = path.join(ctx.dir, "recording.mp4");
  const reply = await ctx.exec(framesToMp4Args(ctx.ffmpeg.path, listFile, recording), { timeoutMs: 120_000 });
  if (reply.code !== 0) {
    ctx.logLine(`frames to mp4 failed: ${String(reply.stderr).slice(-400)}`);
    return null;
  }
  return recording;
}

/** @param {object} ctx @param {"mac" | "windows"} os_ */
async function runDesktop(ctx, os_) {
  const { input } = ctx;
  const { app } = input;
  const files = [];
  const warnings = [];

  ctx.setPhase("download");
  const zip = await ctx.download(app);
  ctx.setPhase("install");
  const unpacked = path.join(ctx.dir, "app");
  await mkdir(unpacked, { recursive: true });
  const unzip = os_ === "mac" ? dittoExtract(zip, unpacked) : tarExtract(zip, unpacked);
  await must(ctx, "install_failed", "The download wouldn't unpack.", unzip, { timeoutMs: 180_000 });

  const facts = { launched: false };
  let device;
  let exe;
  let codesign;
  let gatekeeper;
  if (os_ === "mac") {
    const bundle = await findAppBundle(unpacked);
    if (!bundle) throw new LabError("install_failed", "The download has no Mac app in it.");
    exe = await macExecutable(ctx, bundle);
    if (app.variant === "lab") {
      await pointAppAt(path.join(bundle, "Contents", "Resources", PRODUCT_CONFIG), input.target.url, input.product.name);
      await must(ctx, "install_failed", "The lab couldn't sign the template again.", codesignAdHoc(bundle), { timeoutMs: 120_000 });
    }
    const verify = await ctx.exec(codesignVerify(bundle), { timeoutMs: 60_000 });
    codesign = { ok: verify.code === 0, detail: verify.code === 0 ? "The app's signature is valid." : "The app's signature didn't verify." };
    if (verify.code !== 0) ctx.logLine(`codesign: ${String(verify.stderr).slice(-400)}`);
    const assess = await ctx.exec(spctlAssess(bundle), { timeoutMs: 60_000 });
    gatekeeper = {
      accepted: assess.code === 0,
      detail: assess.code === 0 ? "Gatekeeper accepted the app." : "Gatekeeper rejected the app, as expected without notarization.",
    };
    const version = await ctx.exec(swVersion(), { timeoutMs: 15_000 });
    device = { os: String(version.stdout).trim() };
  } else {
    exe = await findExe(unpacked, app.exeName ?? null);
    if (!exe) throw new LabError("install_failed", "The download has no program to run.");
    if (app.variant === "lab") {
      await pointAppAt(path.join(path.dirname(exe), "resources", PRODUCT_CONFIG), input.target.url, input.product.name);
    }
    device = { os: os.version().replace(/^Microsoft\s+/, "") };
  }

  ctx.setPhase("selftest");
  const selftestDir = path.join(ctx.dir, "selftest");
  await mkdir(selftestDir, { recursive: true });
  const timeoutMs = input.selftestSeconds * 1000 + STARTUP_SLACK_MS;
  const appArgv = desktopSelftest(exe, { dir: selftestDir });
  const ran = await ctx.exec(appArgv, { timeoutMs, windowsHide: false, cwd: path.dirname(exe) });
  ctx.throwIfAborted();
  if (ran.spawnError) ctx.logLine(`The app wouldn't start: ${ran.spawnError}`);
  if (ran.stderr) ctx.logLine(`app stderr: ${String(ran.stderr).slice(-2000)}`);

  const report = await readFile(path.join(selftestDir, "selftest.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  facts.launched = !ran.spawnError && (report !== null || ran.code === 0);

  ctx.setPhase("report");
  let screen = null;
  const stills = await listStills(selftestDir);
  const kept = stills.slice(-input.shots);
  for (const [i, still] of kept.entries()) {
    const form = os_ === "mac" ? CROP.macos : CROP.windows;
    screen = (await keepShot(ctx, still, i + 1, form, files)) ?? screen;
  }

  // The shell exits with 1 whenever its own report isn't ok, so an exit code only means a crash when there's no report.
  const crashed = !report && !ran.spawnError && !ran.timedOut && ran.code !== 0;
  const evaluation = evaluateCheck({
    launched: facts.launched,
    crashed,
    timedOut: ran.timedOut,
    report,
    screen,
    expectOrigin: input.target.origin,
    codesign,
    gatekeeper,
  });

  ctx.setPhase("compose");
  const recording = await framesToRecording(ctx, selftestDir, input.selftestSeconds * 1000);
  const captionBurned = await composeInto(ctx, { recording, form: "desktop", device, files, warnings });
  return {
    evaluation,
    device,
    files,
    warnings,
    captionBurned,
    facts: { report, screen, launched: facts.launched, exitCode: ran.code, gatekeeperAccepted: gatekeeper?.accepted ?? null },
  };
}

export const runDesktopMac = (ctx) => runDesktop(ctx, "mac");
export const runDesktopWindows = (ctx) => runDesktop(ctx, "windows");
