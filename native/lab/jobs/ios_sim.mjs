// ios_sim: opens a product in the lab shell on the iPhone Simulator. The shell build is shared, so the product's URL goes
// in as a launch argument. The health report can come back three ways, since a release build's console.log may not reach
// the system log: Documents/selftest.json, the MUSE_SELFTEST log line, or what the shell posted to the platform.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { selftestFromLogcat, simctlLaunch, simctlLogShow, simctlScreenshot, simctlTerminate } from "../lib/commands.mjs";
import { CROP } from "../lib/pixels.mjs";
import { evaluateCheck } from "../lib/rules.mjs";
import { composeInto, keepShot, platformReport, recordUntilDone, reportWaitMs, shotsAfterReady, waitFor } from "./common.mjs";
import {
  appRunning,
  clearLeftovers,
  documentsDir,
  ensureSimulator,
  grantPermissions,
  installShell,
  LAUNCH_TIMEOUT_MS,
  logLaunchFailure,
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
  // The platform first, since reading the system log can take many seconds and the report's arrival times the screenshots.
  const posted = await platformReport(ctx, launchedAtMs);
  if (posted) return posted;
  const logged = await ctx.exec(simctlLogShow(udid), { timeoutMs: 20_000 });
  const fromLog = logged.code === 0 ? selftestFromLogcat(String(logged.stdout)) : null;
  return fromLog && Date.parse(fromLog.at) >= launchedAtMs ? fromLog : null;
}

export async function runIosSim(ctx) {
  const { input } = ctx;
  const files = [];
  const warnings = [];
  const jobStart = ctx.now();

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

  const launch = await ctx.exec(simctlLaunch(udid, bundleId, { url: input.target.url, selftest: input.selftest }), { timeoutMs: LAUNCH_TIMEOUT_MS });
  const launched = launch.code === 0;
  if (!launched) logLaunchFailure(ctx, launch);

  // The shell reports once, after the page has loaded and scrolled, or at its watchdog. On a slow page that's long after a
  // fixed recording would have ended, and screenshots taken before it see the shell's spinner and read as blank.
  ctx.setPhase("report");
  const report = launched ? await waitFor(ctx, () => readReport(ctx, udid, documents, started), { timeoutMs: reportWaitMs(ctx, ctx.now(), jobStart), everyMs: 1000 }) : null;
  const ready = ctx.now();
  let screen = null;
  await shotsAfterReady(ctx, ready, async (number) => {
    const png = path.join(ctx.dir, `shot-${number}.png`);
    await ctx.exec(simctlScreenshot(udid, png), { timeoutMs: 15_000 });
    screen = (await keepShot(ctx, png, number, CROP.ios, files)) ?? screen;
  });
  await recordUntilDone(ctx, started, ready);
  const video = await stopRecording(recorder, recording);

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
  // The end of the recording is what's worth showing: the page and its scroll, not the wait for them.
  const captionBurned = await composeInto(ctx, { recording: video, form: "phone", device, files, warnings, keepLastSeconds: input.recordSeconds });
  return { evaluation, device, files, warnings, captionBurned, facts: { report, screen, launched, running } };
}
