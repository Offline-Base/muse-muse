// ios_sim: opens a product in the lab shell on the iPhone Simulator. The shell build is shared, so the product's URL goes
// in as a launch argument. The health report can come back three ways, since a release build's console.log may not reach
// the system log: Documents/selftest.json, the MUSE_SELFTEST log line, or what the shell posted to the platform.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { selftestFromLogcat, simctlLaunch, simctlLogShow, simctlScreenshot, simctlTerminate } from "../lib/commands.mjs";
import { CROP } from "../lib/pixels.mjs";
import { evaluateCheck } from "../lib/rules.mjs";
import { composeInto, keepShot, platformReport, reportWaitMs, shotSchedule, waitFor } from "./common.mjs";
import {
  appRunning,
  clearLeftovers,
  documentsDir,
  ensureSimulator,
  grantPermissions,
  installShell,
  resetStatusBar,
  startRecording,
  stopRecording,
} from "./simulator.mjs";

/**
 * The report from this launch. Its file was cleared before launch. The system log and the platform's copy can both go back
 * further, so those only count if they're dated after it.
 */
async function readReport(ctx, udid, documents, launchedAtMs) {
  const fromFile = await readFile(path.join(documents, "selftest.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  if (fromFile) return fromFile;
  const logged = await ctx.exec(simctlLogShow(udid), { timeoutMs: 20_000 });
  const fromLog = logged.code === 0 ? selftestFromLogcat(String(logged.stdout)) : null;
  if (fromLog && Date.parse(fromLog.at) >= launchedAtMs) return fromLog;
  return platformReport(ctx, launchedAtMs);
}

export async function runIosSim(ctx) {
  const { input } = ctx;
  const files = [];
  const warnings = [];

  ctx.setPhase("boot");
  const { udid, device } = await ensureSimulator(ctx);
  await installShell(ctx, udid);
  const bundleId = input.app.bundleId;
  await grantPermissions(ctx, udid, bundleId);
  const documents = await documentsDir(ctx, udid, bundleId);
  await clearLeftovers(documents, ["selftest.json"]);

  ctx.setPhase("record");
  const recording = path.join(ctx.dir, "recording.mp4");
  const recorder = await startRecording(ctx, udid, recording);
  const started = ctx.now();

  const launch = await ctx.exec(simctlLaunch(udid, bundleId, { url: input.target.url, selftest: input.selftest }), { timeoutMs: 45_000 });
  const launched = launch.code === 0;
  if (!launched) ctx.logLine(`simctl launch exited with ${launch.code}: ${String(launch.stderr).slice(-400)}`);

  let report = null;
  let screen = null;
  const schedule = shotSchedule(input.shots, input.recordSeconds);
  for (const [i, at] of schedule.entries()) {
    await ctx.sleep(Math.max(0, started + at - ctx.now()));
    ctx.throwIfAborted();
    const png = path.join(ctx.dir, `shot-${i + 1}.png`);
    await ctx.exec(simctlScreenshot(udid, png), { timeoutMs: 15_000 });
    screen = (await keepShot(ctx, png, i + 1, CROP.ios, files)) ?? screen;
  }
  await ctx.sleep(Math.max(0, started + input.recordSeconds * 1000 - ctx.now()));
  const video = await stopRecording(recorder, recording);

  ctx.setPhase("report");
  if (launched) report = await waitFor(ctx, () => readReport(ctx, udid, documents, started), { timeoutMs: reportWaitMs(ctx, started), everyMs: 1000 });
  const running = launched ? await appRunning(ctx, udid, bundleId) : false;
  await ctx.exec(simctlTerminate(udid, bundleId), { timeoutMs: 15_000 });
  await resetStatusBar(ctx, udid);

  const evaluation = evaluateCheck({
    launched,
    crashed: launched && !running,
    timedOut: launched && !report,
    report,
    screen,
    expectOrigin: input.target.origin,
  });

  ctx.setPhase("compose");
  const captionBurned = await composeInto(ctx, { recording: video, form: "phone", device, files, warnings });
  return { evaluation, device, files, warnings, captionBurned, facts: { report, screen, launched, running } };
}
