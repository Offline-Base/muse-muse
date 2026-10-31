// glasses_sim: a glasses product in the glasses shell on the iPhone Simulator, with Meta's mock glasses. The shell gets the
// mock camera feed and photo in its Documents folder, then a deep link starts the autopilot, which presses through the
// product and writes checkpoints to Documents/autopilot.jsonl. The result is informational and never blocks shipping.
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { LabError } from "../lib/errors.mjs";
import {
  glassesDeepLink,
  h265FeedArgs,
  simctlLaunchAutopilot,
  simctlLaunchPlain,
  simctlOpenUrl,
  simctlScreenshot,
  simctlTerminate,
} from "../lib/commands.mjs";
import { CROP } from "../lib/pixels.mjs";
import { autopilotFinished, evaluateGlasses, GLASSES_LOAD_MS, GLASSES_RESULT_MS, parseAutopilot } from "../lib/rules.mjs";
import { composeInto, keepShot, must, waitFor } from "./common.mjs";
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

/** Where the shell's mock glasses read their media from, in its Documents folder (src/glasses/mock.js in the shell). */
export const MOCK_FEED = "mock-feed.mov";
export const MOCK_PHOTO = "mock-photo.jpg";
export const MOCK_QUESTION = "mock-question.wav";
const AUTOPILOT_LOG = "autopilot.jsonl";
/**
 * A warm app gets this long to take the link before the lab uses launch arguments instead. The first checkpoint only comes
 * once the page has loaded, so this has to be the whole load limit, or a slow page is killed as if the link had failed.
 */
const LINK_WAIT_MS = GLASSES_LOAD_MS;
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

  ctx.setPhase("boot");
  const { udid, device } = await ensureSimulator(ctx);
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
  let launchedAtMs = ctx.now();

  // Warm the app, then send the link. A cold launch with a link isn't supported on an Expo build, and the system may hold
  // a link back to ask for permission, so if the autopilot doesn't start the same request goes in as launch arguments.
  const launch = await ctx.exec(simctlLaunchPlain(udid, bundleId), { timeoutMs: 45_000 });
  let launched = launch.code === 0;
  let usedLaunchArgs = false;
  if (launched) {
    await ctx.sleep(2000);
    await ctx.exec(simctlOpenUrl(udid, glassesDeepLink({ url: input.target.url })), { timeoutMs: 20_000 });
    const answered = await waitFor(ctx, async () => (await readEvents()).length > 0, { timeoutMs: LINK_WAIT_MS, everyMs: 1000 });
    if (!answered) {
      usedLaunchArgs = true;
      ctx.logLine("The deep link didn't start the autopilot, so the lab used launch arguments.");
      // A new launch, so the load limit starts over.
      launchedAtMs = ctx.now();
      const again = await ctx.exec(simctlLaunchAutopilot(udid, bundleId, { url: input.target.url }), { timeoutMs: 45_000 });
      launched = again.code === 0;
    }
  }

  ctx.setPhase("autopilot");
  const limitMs = Math.min(GLASSES_LOAD_MS + GLASSES_RESULT_MS, input.limitSeconds * 1000 - 60_000);
  const end = launchedAtMs + Math.max(30_000, limitMs);
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
  if (usedLaunchArgs) warnings.push("The deep link didn't reach the app, so the lab started it with launch arguments.");

  ctx.setPhase("compose");
  const captionBurned = await composeInto(ctx, { recording: video, form: "phone", device, files, warnings });
  return { evaluation, device, files, warnings, captionBurned, facts: { events, screen, launched, running, usedLaunchArgs } };
}
