// The iPhone Simulator parts ios_sim and glasses_sim share: finding it, booting it, installing the shell and reading what
// the shell wrote into its own Documents folder.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { LabError } from "../lib/errors.mjs";
import {
  findSimulator,
  iosRuntimeOfMajor,
  iosVersionOf,
  newestIosRuntime,
  pickIphoneType,
  simctlBoot,
  simctlContainer,
  simctlCreate,
  simctlDeviceTypes,
  simctlInstall,
  simctlList,
  simctlPrivacyGrant,
  simctlRecordVideo,
  simctlRunning,
  simctlRuntimes,
  simctlStatusBar,
  simctlStatusBarClear,
  simulatorAppRunning,
  tarGzExtract,
} from "../lib/commands.mjs";
import { must, waitFor } from "./common.mjs";

const BOOT_TIMEOUT_MS = 180_000;
/** The first install on a just-booted runtime ran past 120 s on the Mac box on Nov 1. */
const INSTALL_TIMEOUT_MS = 240_000;
/** Meta's mock glasses reach ready on iOS 18.4, and answer no_eligible_device on iOS 26.5 with the same build. */
const GLASSES_IOS_MAJOR = 18;
const GLASSES_IPHONE_TYPE = "iPhone 16";
const RECORDER_READY_MS = 5_000;
/** The system's install notices are still going around just after an install, and a launch into them can stall. */
const AFTER_INSTALL_MS = 5_000;
/** A first launch on a busy Mac has run past 45 s, which reads as an app that didn't open. */
export const LAUNCH_TIMEOUT_MS = 120_000;
const PRIVACY_SERVICES = ["camera", "microphone", "photos"];

/** The lab's simulator, made if it isn't there yet, and booted. */
export async function ensureSimulator(ctx, { glasses = false } = {}) {
  // Always the lab's own. A job's device name is only for the caption, or each new name would add a simulator to the box.
  const name = glasses ? ctx.config.ios.glassesSimulator : ctx.config.ios.simulator;
  const fail = "The iPhone simulator didn't start.";
  const listed = await must(ctx, "simulator_failed", fail, simctlList(), { timeoutMs: 30_000 });
  let found = findSimulator(String(listed.stdout), name);
  if (!found) {
    const runtimes = await must(ctx, "simulator_failed", fail, simctlRuntimes(), { timeoutMs: 30_000 });
    const runtime = glasses ? iosRuntimeOfMajor(String(runtimes.stdout), GLASSES_IOS_MAJOR) : newestIosRuntime(String(runtimes.stdout));
    const types = await must(ctx, "simulator_failed", fail, simctlDeviceTypes(), { timeoutMs: 30_000 });
    const deviceType = pickIphoneType(String(types.stdout), glasses ? GLASSES_IPHONE_TYPE : ctx.config.ios.deviceType);
    if (!runtime || !deviceType) {
      throw new LabError("simulator_failed", glasses ? `This Mac has no iOS ${GLASSES_IOS_MAJOR} simulator runtime, which the mock glasses need.` : "This Mac has no iOS simulator runtime.");
    }
    const created = await must(ctx, "simulator_failed", fail, simctlCreate(name, deviceType, runtime.identifier), { timeoutMs: 60_000 });
    found = { udid: String(created.stdout).trim(), runtime: runtime.identifier };
  }
  await must(ctx, "simulator_failed", fail, simctlBoot(found.udid), { timeoutMs: BOOT_TIMEOUT_MS });
  await ctx.exec(simctlStatusBar(found.udid), { timeoutMs: 15_000 });
  // The lab's own simulator name means nothing to a viewer, so the caption only names a device the job asked for.
  return { udid: found.udid, device: { name: ctx.input.device.name ?? "", os: iosVersionOf(found.runtime) } };
}

/** The first .app in an unpacked shell build, at its top level or one folder down. */
export async function findAppBundle(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const here = entries.find((e) => e.isDirectory() && e.name.endsWith(".app"));
  if (here) return path.join(dir, here.name);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "__MACOSX") continue;
    const inner = await findAppBundle(path.join(dir, entry.name));
    if (inner) return inner;
  }
  return null;
}

/** Installs the shell only when its build changed. The same build serves every product. */
export async function installShell(ctx, udid) {
  const { app } = ctx.input;
  const stateFile = path.join(ctx.config.dataDir, "installed-shells.json");
  const state = await readFile(stateFile, "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => ({}));
  const key = `${udid}:${app.bundleId}`;
  const installed = await ctx.exec(simctlContainer(udid, app.bundleId, "app"), { timeoutMs: 20_000 });
  if (state[key] === app.sha256 && installed.code === 0) return;

  ctx.setPhase("download");
  const tarball = await ctx.download(app);
  const unpacked = path.join(ctx.dir, "shell");
  await mkdir(unpacked, { recursive: true });
  await must(ctx, "install_failed", "The shell build couldn't be unpacked.", tarGzExtract(tarball, unpacked), { timeoutMs: 120_000 });
  const bundle = await findAppBundle(unpacked);
  if (!bundle) throw new LabError("install_failed", "The shell build has no app in it.");

  ctx.setPhase("install");
  await must(ctx, "install_failed", "The shell wouldn't install on the simulator.", simctlInstall(udid, bundle), { timeoutMs: INSTALL_TIMEOUT_MS });
  state[key] = app.sha256;
  await writeFile(`${stateFile}.tmp`, JSON.stringify(state));
  await rename(`${stateFile}.tmp`, stateFile);
  await ctx.sleep(AFTER_INSTALL_MS);
}

/** Why simctl launch didn't work, for the job's log. */
export function logLaunchFailure(ctx, launch) {
  ctx.logLine(`simctl launch ${launch.timedOut ? "timed out" : `exited with ${launch.code}`}: ${String(launch.stderr).slice(-400)}`);
}

/** So nothing stops to ask for permission during a recording. */
export async function grantPermissions(ctx, udid, bundleId) {
  for (const service of PRIVACY_SERVICES) await ctx.exec(simctlPrivacyGrant(udid, service, bundleId), { timeoutMs: 15_000 });
}

/** The app's Documents folder on the simulator. */
export async function documentsDir(ctx, udid, bundleId) {
  const reply = await ctx.exec(simctlContainer(udid, bundleId), { timeoutMs: 20_000 });
  if (reply.code !== 0) throw new LabError("simulator_failed", "The lab couldn't find the app's data folder.");
  return path.join(String(reply.stdout).trim(), "Documents");
}

/** Clears what an earlier job left, so a stale report can't pass this one. */
export async function clearLeftovers(documents, names) {
  await mkdir(documents, { recursive: true });
  await Promise.all(names.map((name) => rm(path.join(documents, name), { force: true, recursive: true })));
}

/** Starts the screen recording and waits until it's really going. */
export async function startRecording(ctx, udid, file) {
  const recorder = ctx.startProc(simctlRecordVideo(udid, file));
  await waitFor(ctx, () => recorder.exited || /recording started/i.test(recorder.output()), { timeoutMs: RECORDER_READY_MS, everyMs: 100 });
  return recorder;
}

/** Stops it with SIGINT so the file gets finished, and returns the file if it's there. */
export async function stopRecording(recorder, file) {
  await recorder.stop();
  return existsSync(file) ? file : null;
}

export async function appRunning(ctx, udid, bundleId) {
  const reply = await ctx.exec(simctlRunning(udid), { timeoutMs: 15_000 });
  return reply.code === 0 ? simulatorAppRunning(String(reply.stdout), bundleId) : true;
}

export async function resetStatusBar(ctx, udid) {
  await ctx.exec(simctlStatusBarClear(udid), { timeoutMs: 15_000 });
}
