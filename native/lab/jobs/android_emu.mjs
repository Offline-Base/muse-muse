// android_emu: installs the APK on the emulator, which stays booted between jobs, then records, opens it, takes
// screenshots and reads the health report from logcat.
import { readFile, writeFile } from "node:fs/promises";
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
import { CROP } from "../lib/pixels.mjs";
import { evaluateCheck } from "../lib/rules.mjs";
import { runProbeOnce } from "./android_probe.mjs";
import { composeInto, keepShot, must, platformReport, reportWaitMs, shotSchedule, waitFor } from "./common.mjs";

const BOOT_TIMEOUT_MS = 180_000;
const SERIAL = EMULATOR_SERIAL;

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

export async function runAndroidEmu(ctx) {
  const { input } = ctx;
  const { app } = input;
  const pkg = app.packageName;
  const files = [];
  const warnings = [];
  const jobStartedMs = ctx.now();

  ctx.setPhase("download");
  const apk = await ctx.download(app);

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
  const probeNote = await runProbeOnce(ctx, { serial: SERIAL, component, pkg, jobStartedMs });
  await ctx.exec(adbLogcatClear(SERIAL), { timeoutMs: 15_000 });

  ctx.setPhase("record");
  const remote = `/sdcard/mm-${ctx.job.id}.mp4`;
  const limit = input.recordSeconds + 2;
  const recorder = ctx.startProc(adbScreenrecord(SERIAL, remote, limit));
  await ctx.sleep(500);
  const started = ctx.now();

  const amReply = await ctx.exec(adbAmStart(SERIAL, component, { url: input.target.url, selftest: input.selftest, variant: app.variant }), {
    timeoutMs: 60_000,
  });
  const am = parseAmStart(String(amReply.stdout));
  const launched = amReply.code === 0 && am.ok;
  if (!launched) ctx.logLine(`am start: ${String(amReply.stdout).slice(-300)} ${String(amReply.stderr).slice(-200)}`);

  let screen = null;
  for (const [i, at] of shotSchedule(input.shots, input.recordSeconds).entries()) {
    await ctx.sleep(Math.max(0, started + at - ctx.now()));
    ctx.throwIfAborted();
    const png = path.join(ctx.dir, `shot-${i + 1}.png`);
    await ctx.exec(adbScreencap(SERIAL), { timeoutMs: 15_000, stdoutFile: png });
    screen = (await keepShot(ctx, png, i + 1, CROP.android, files)) ?? screen;
  }
  await ctx.sleep(Math.max(0, started + input.recordSeconds * 1000 - ctx.now()));
  await ctx.exec(adbStopRecording(SERIAL), { timeoutMs: 15_000 });
  await recorder.stop(8000);
  // screenrecord needs a moment to finish the file after it's told to stop.
  await ctx.sleep(1000);
  const recording = path.join(ctx.dir, "recording.mp4");
  const pulled = await ctx.exec(adbPull(SERIAL, remote, recording), { timeoutMs: 60_000 });
  await ctx.exec(adbRemove(SERIAL, remote), { timeoutMs: 15_000 });

  ctx.setPhase("report");
  const expectReport = app.variant === "lab";
  const report = expectReport && launched
    ? await waitFor(
        ctx,
        async () => selftestFromLogcat(String((await ctx.exec(adbLogcatDump(SERIAL), { timeoutMs: 20_000 })).stdout)) ?? (await platformReport(ctx, started)),
        { timeoutMs: reportWaitMs(ctx, started), everyMs: 1000 },
      )
    : null;

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
  if (probeNote) evaluation.checks.push(probeNote);

  ctx.setPhase("compose");
  const captionBurned = await composeInto(ctx, {
    recording: pulled.code === 0 ? recording : null,
    form: "phone",
    device,
    files,
    warnings,
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
