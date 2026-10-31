// android_emu: installs the APK on the emulator, which stays booted between jobs, then records, opens it, takes
// screenshots and reads the health report from logcat.
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { LabError } from "../lib/errors.mjs";
import {
  adbAmStart,
  adbBootCompleted,
  adbDevices,
  adbForceStop,
  adbInstall,
  adbLogcatClear,
  adbLogcatCrash,
  adbLogcatDump,
  adbPidof,
  adbPrepareCommands,
  adbProp,
  adbPull,
  adbRemove,
  adbResolveActivity,
  adbScreencap,
  adbScreenrecord,
  adbStopRecording,
  adbUninstall,
  emulatorListed,
  emulatorStart,
  EMULATOR_SERIAL,
  filterLogcat,
  logcatShowsCrash,
  parseAmStart,
  parseResolvedActivity,
  selftestFromLogcat,
} from "../lib/commands.mjs";
import { CROP, isBlankScreen } from "../lib/pixels.mjs";
import { evaluateCheck } from "../lib/rules.mjs";
import { screenshotStats } from "../lib/tools.mjs";
import { AFTER_READY_MS, composeInto, keepShot, must, platformReport, recordUntilDone, reportWaitMs, shotsAfterReady, waitFor } from "./common.mjs";

const BOOT_TIMEOUT_MS = 180_000;
const SERIAL = EMULATOR_SERIAL;
/** screenrecord allows at most 180 s. The lab stops it sooner, so this only has to outlast the wait for a slow page. */
const RECORD_LIMIT_SECONDS = 170;
/** How much longer an app with no health report gets to draw something, once its `recordSeconds` are nearly up. */
const NO_REPORT_DRAW_MS = 30_000;

/** The emulator, started if it isn't running. It's left running for the next job. */
export async function ensureEmulator(ctx) {
  const listed = await ctx.exec(adbDevices(), { timeoutMs: 20_000 });
  if (listed.spawnError) throw new LabError("tool_missing", "adb isn't installed.");
  if (!emulatorListed(String(listed.stdout), SERIAL)) {
    const logFile = path.join(ctx.config.dataDir, "emulator.log");
    const emulator = ctx.startProc(emulatorStart(ctx.config.android.avd), { detach: true, logFile });
    const up = await waitFor(
      ctx,
      async () => {
        if (emulator.exited) throw new LabError("emulator_failed", "The Android emulator stopped while it was starting.");
        const devices = await ctx.exec(adbDevices(), { timeoutMs: 20_000 });
        return emulatorListed(String(devices.stdout), SERIAL);
      },
      { timeoutMs: BOOT_TIMEOUT_MS, everyMs: 3000 },
    );
    if (!up) throw new LabError("emulator_failed", "The Android emulator didn't start in 3 minutes.");
  }
  const booted = await waitFor(
    ctx,
    async () => String((await ctx.exec(adbBootCompleted(SERIAL), { timeoutMs: 15_000 })).stdout).trim() === "1",
    { timeoutMs: BOOT_TIMEOUT_MS, everyMs: 3000 },
  );
  if (!booted) throw new LabError("emulator_failed", "The Android emulator didn't finish booting in 3 minutes.");
  for (const command of adbPrepareCommands(SERIAL)) await ctx.exec(command, { timeoutMs: 15_000 });
}

async function deviceFacts(ctx) {
  const release = await ctx.exec(adbProp(SERIAL, "ro.build.version.release"), { timeoutMs: 15_000 });
  return { name: ctx.input.device.name ?? ctx.config.android.deviceLabel, os: String(release.stdout).trim() };
}

/** Is the screen showing something? For an app that can't report, the pixels are the only sign that its page has loaded. */
async function screenDrawn(ctx) {
  const png = path.join(ctx.dir, "probe.png");
  await ctx.exec(adbScreencap(SERIAL), { timeoutMs: 15_000, stdoutFile: png });
  const stats = await screenshotStats(ctx.ffmpeg.path, png, CROP.android, { exec: ctx.exec, signal: ctx.signal });
  return isBlankScreen(stats, null) === false;
}

export async function runAndroidEmu(ctx) {
  const { input } = ctx;
  const { app } = input;
  const pkg = app.packageName;
  const files = [];
  const warnings = [];
  const jobStart = ctx.now();

  ctx.setPhase("download");
  // adb refuses a file whose name doesn't end in .apk, and the download cache names files by their checksum.
  const apk = path.join(ctx.dir, "app.apk");
  await copyFile(await ctx.download(app), apk);

  ctx.setPhase("boot");
  await ensureEmulator(ctx);
  const device = await deviceFacts(ctx);

  ctx.setPhase("install");
  // For a package an aborted job left behind. Each job installs fresh, so nothing needs clearing after this: `pm clear`
  // would also take back the permissions that `install -g` grants, and a dialog would land on the recording.
  await ctx.exec(adbUninstall(SERIAL, pkg), { timeoutMs: 30_000 });
  await must(ctx, "install_failed", "The APK wouldn't install on the emulator.", adbInstall(SERIAL, apk), { timeoutMs: 120_000 });
  const resolved = await ctx.exec(adbResolveActivity(SERIAL, pkg), { timeoutMs: 15_000 });
  const component = parseResolvedActivity(String(resolved.stdout));
  if (!component) throw new LabError("install_failed", "The APK has no activity to open.");
  await ctx.exec(adbLogcatClear(SERIAL), { timeoutMs: 15_000 });

  ctx.setPhase("record");
  const remote = `/sdcard/mm-${ctx.job.id}.mp4`;
  const recorder = ctx.startProc(adbScreenrecord(SERIAL, remote, RECORD_LIMIT_SECONDS));
  await ctx.sleep(500);
  const started = ctx.now();

  const amReply = await ctx.exec(adbAmStart(SERIAL, component, { url: input.target.url, selftest: input.selftest, variant: app.variant }), {
    timeoutMs: 60_000,
  });
  const am = parseAmStart(String(amReply.stdout));
  const launched = amReply.code === 0 && am.ok;
  if (!launched) ctx.logLine(`am start: ${String(amReply.stdout).slice(-300)} ${String(amReply.stderr).slice(-200)}`);

  // The shell reports once, after the page has loaded and scrolled, or at its watchdog. On a slow page that's long after a
  // fixed recording would have ended, and screenshots taken before it read as blank.
  ctx.setPhase("report");
  const expectReport = app.variant === "lab";
  let report = null;
  if (launched && expectReport) {
    const readReport = async () => selftestFromLogcat(String((await ctx.exec(adbLogcatDump(SERIAL), { timeoutMs: 20_000 })).stdout)) ?? (await platformReport(ctx, started));
    report = await waitFor(ctx, readReport, { timeoutMs: reportWaitMs(ctx, ctx.now(), jobStart), everyMs: 1000 });
  } else if (launched) {
    await ctx.sleep(Math.max(0, started + input.recordSeconds * 1000 - AFTER_READY_MS - ctx.now()));
    await waitFor(ctx, () => screenDrawn(ctx), { timeoutMs: NO_REPORT_DRAW_MS, everyMs: 2000 });
  }
  const ready = ctx.now();
  let screen = null;
  await shotsAfterReady(ctx, ready, async (number) => {
    const png = path.join(ctx.dir, `shot-${number}.png`);
    await ctx.exec(adbScreencap(SERIAL), { timeoutMs: 15_000, stdoutFile: png });
    screen = (await keepShot(ctx, png, number, CROP.android, files)) ?? screen;
  });
  await recordUntilDone(ctx, started, ready);
  await ctx.exec(adbStopRecording(SERIAL), { timeoutMs: 15_000 });
  await recorder.stop(8000);
  // screenrecord needs a moment to finish the file after it's told to stop.
  await ctx.sleep(1000);
  const recording = path.join(ctx.dir, "recording.mp4");
  const pulled = await ctx.exec(adbPull(SERIAL, remote, recording), { timeoutMs: 60_000 });
  await ctx.exec(adbRemove(SERIAL, remote), { timeoutMs: 15_000 });

  const pidReply = await ctx.exec(adbPidof(SERIAL, pkg), { timeoutMs: 15_000 });
  const pid = String(pidReply.stdout).trim().split(/\s+/)[0] || null;
  const crashBuffer = await ctx.exec(adbLogcatCrash(SERIAL), { timeoutMs: 20_000 });
  const crashed = launched && (!pid || logcatShowsCrash(String(crashBuffer.stdout), pkg));
  const dump = await ctx.exec(adbLogcatDump(SERIAL), { timeoutMs: 20_000 });
  const logcat = path.join(ctx.dir, "logcat.txt");
  await writeFile(logcat, ctx.redact(filterLogcat(String(dump.stdout), { pid, pkg })));
  if ((await readFile(logcat)).length > 0) files.push({ path: logcat, name: "logcat.txt", role: "log" });

  await ctx.exec(adbForceStop(SERIAL, pkg), { timeoutMs: 15_000 });
  await ctx.exec(adbUninstall(SERIAL, pkg), { timeoutMs: 30_000 });

  const evaluation = evaluateCheck({
    launched,
    crashed,
    timedOut: expectReport && launched && !report,
    report,
    expectReport,
    screen,
    expectOrigin: input.target.origin,
  });

  ctx.setPhase("compose");
  const captionBurned = await composeInto(ctx, {
    recording: pulled.code === 0 ? recording : null,
    form: "phone",
    device,
    files,
    warnings,
    // The end of the recording is what's worth showing: the page and its scroll, not the wait for them.
    keepLastSeconds: input.recordSeconds,
  });
  return {
    evaluation,
    device,
    files,
    warnings,
    captionBurned,
    facts: { report, screen, launched, startMs: am.totalMs, loadMs: report?.loadMs ?? am.totalMs },
  };
}
