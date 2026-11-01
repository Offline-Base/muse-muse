// glasses_sim: a glasses product in the glasses shell on the iPhone Simulator, with Meta's mock glasses. The shell gets the
// mock camera feed and photo in its Documents folder, then launch arguments start the autopilot, which presses through the
// product and writes checkpoints to Documents/autopilot.jsonl. The result is informational and never blocks shipping.
// Not a deep link: `simctl openurl` stops at a system "Open in Muse Lab?" dialog, which nobody is there to answer.
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { LabError } from "../lib/errors.mjs";
import {
  h265FeedArgs,
  simctlLaunchAutopilot,
  simctlScreenshot,
  simctlTerminate,
} from "../lib/commands.mjs";
import { CROP } from "../lib/pixels.mjs";
import { autopilotFinished, evaluateGlasses, GLASSES_LOAD_MS, GLASSES_RESULT_MS, parseAutopilot } from "../lib/rules.mjs";
import { MAX_CLIP_SECONDS } from "../compose.mjs";
import { composeInto, keepShot, must, waitFor } from "./common.mjs";
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

/** Where the shell's mock glasses read their media from, in its Documents folder (src/glasses/mock.js in the shell). */
export const MOCK_FEED = "mock-feed.mov";
export const MOCK_PHOTO = "mock-photo.jpg";
export const MOCK_QUESTION = "mock-question.wav";
const AUTOPILOT_LOG = "autopilot.jsonl";
const SHOT_EVERY_MS = 12_000;
/** The clip keeps the end of the run, up to its limit. */
const AFTER_RESULT_MS = 3_000;

async function placeMedia(ctx, documents) {
  const { media } = ctx.input;
  const inDocuments = (name) => path.join(documents, name);
  const photo = await ctx.download(media.photo);
  await copyFile(photo, inDocuments(MOCK_PHOTO));
  if (media.feed) {
    await copyFile(await ctx.download(media.feed), inDocuments(MOCK_FEED));
  } else {
    await must(ctx, "internal", "The lab couldn't make the mock camera feed.", h265FeedArgs(ctx.ffmpeg.path, photo, inDocuments(MOCK_FEED)), {
      timeoutMs: 120_000,
    });
  }
  if (media.question) await copyFile(await ctx.download(media.question), inDocuments(MOCK_QUESTION));
}

export async function runGlassesSim(ctx) {
  const { input } = ctx;
  const files = [];
  const warnings = [];
  const jobStart = ctx.now();

  ctx.setPhase("boot");
  const { udid, device } = await ensureSimulator(ctx, { glasses: true });
  await installShell(ctx, udid);
  const bundleId = input.app.bundleId;
  await grantPermissions(ctx, udid, bundleId);
  const documents = await documentsDir(ctx, udid, bundleId);
  await clearLeftovers(documents, [AUTOPILOT_LOG, MOCK_FEED, MOCK_PHOTO, MOCK_QUESTION]);
  ctx.setPhase("media");
  await placeMedia(ctx, documents);

  const readEvents = () =>
    readFile(path.join(documents, AUTOPILOT_LOG), "utf8")
      .then(parseAutopilot)
      .catch(() => []);

  ctx.setPhase("record");
  const recording = path.join(ctx.dir, "recording.mp4");
  const recorder = await startRecording(ctx, udid, recording);

  const launch = await ctx.exec(simctlLaunchAutopilot(udid, bundleId, { url: input.target.url }), { timeoutMs: LAUNCH_TIMEOUT_MS });
  const launched = launch.code === 0;
  if (!launched) logLaunchFailure(ctx, launch);
  // The load limit is the page's, so it doesn't count however long the app took to open.
  const launchedAtMs = ctx.now();

  ctx.setPhase("autopilot");
  const end = Math.min(launchedAtMs + GLASSES_LOAD_MS + GLASSES_RESULT_MS, Math.max(launchedAtMs + 30_000, jobStart + input.limitSeconds * 1000 - 60_000));
  let screen = null;
  let shotIndex = 0;
  let nextShot = ctx.now() + SHOT_EVERY_MS;
  let events = [];
  let finished = false;
  const takeShot = async () => {
    shotIndex = shotIndex >= input.shots ? input.shots : shotIndex + 1;
    const png = path.join(ctx.dir, `shot-${shotIndex}.png`);
    await ctx.exec(simctlScreenshot(udid, png), { timeoutMs: 15_000 });
    const name = `shot-${shotIndex}.jpg`;
    const kept = files.findIndex((f) => f.name === name);
    if (kept >= 0) files.splice(kept, 1);
    screen = (await keepShot(ctx, png, shotIndex, CROP.ios, files)) ?? screen;
  };
  while (launched && ctx.now() < end) {
    ctx.throwIfAborted();
    events = await readEvents();
    if (autopilotFinished(events)) {
      finished = true;
      break;
    }
    if (ctx.now() >= nextShot && shotIndex < input.shots - 1) {
      await takeShot();
      nextShot = ctx.now() + SHOT_EVERY_MS;
    }
    await ctx.sleep(1000);
  }
  await ctx.sleep(finished ? AFTER_RESULT_MS : 0);
  if (launched) await takeShot();
  const video = await stopRecording(recorder, recording);
  events = await readEvents();

  const running = launched ? await appRunning(ctx, udid, bundleId) : false;
  await ctx.exec(simctlTerminate(udid, bundleId), { timeoutMs: 15_000 });
  await resetStatusBar(ctx, udid);

  if (!launched && launch.spawnError) throw new LabError("tool_missing", "xcrun isn't installed.");
  const evaluation = evaluateGlasses({
    launched,
    crashed: launched && !running && !finished,
    timedOut: launched && !finished,
    launchedAtMs,
    events,
  });

  ctx.setPhase("compose");
  const captionBurned = await composeInto(ctx, { recording: video, form: "phone", device, files, warnings, keepLastSeconds: MAX_CLIP_SECONDS });
  return { evaluation, device, files, warnings, captionBurned, facts: { events, screen, launched, running } };
}
