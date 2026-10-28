/**
 * The durable build workflows (docs/DESIGN.md section 2). These functions only orchestrate: every side effect lives
 * in a "use step" function in ./build-steps.ts, and long sandbox work is started detached and polled between durable
 * sleeps, so a 20-minute build is many short steps.
 *
 *   buildProduct:  brief -> product -> fixtures + provision -> build -> preview (non-fatal) -> verify/fix loop
 *                  -> outcome -> record (non-fatal) -> deploy -> register -> hibernate -> final status
 *   refineProduct: policy check -> reopen sandbox -> refine-<n>.md -> resume the Muse Code session -> same checks
 *                  and shipping, but only a change that passes every check ships
 *
 * The final status is written after hibernate, so a build only turns terminal (and a refinement can only start) once
 * its sandbox and build tokens are cleaned up.
 *
 * Start them with start() from "workflow/api". Never call them directly.
 */
import { sleep } from "workflow";
import { env } from "@/lib/env";
import {
  briefStep,
  cleanupStep,
  collectVerifyStep,
  createProductStep,
  demoSpecStep,
  emitStep,
  failStep,
  finishDemoStep,
  fixturesStep,
  judgeStep,
  killStep,
  loadBuildStep,
  loadRefineStep,
  pollDeployStep,
  pollMuseStep,
  pollTaskStep,
  previewStep,
  publishOffStep,
  provisionStep,
  refineCheckStep,
  registerStep,
  reopenStep,
  setStatusStep,
  spendPausedStep,
  startDeployStep,
  startMuseStep,
  startTaskStep,
  verifyTimedOutStep,
  writeFixPromptStep,
  type TaskPollResult,
  type VerifyResult,
} from "@/lib/pipeline/build-steps";
import {
  BuildStop,
  decideOutcome,
  failureMessage,
  pollTimedOut,
  SPEND_PAUSED_MESSAGE,
  type JudgeCall,
  type Outcome,
  type VerifyStepResult,
} from "@/lib/pipeline/logic";
import { stepTimeoutMs } from "@/lib/pipeline/steps";
import { MUSE_EXIT, type BuildModel } from "@/lib/sandbox/muse";
import { TERMINAL_STATUSES, type BuildStatus } from "@/lib/types";

export interface BuildProductInput {
  buildId: string;
}

export interface BuildProductResult {
  status: BuildStatus;
}

const MUSE_POLL_MS = 15_000;
const TASK_POLL_MS = 10_000;
const DEPLOY_POLL_MS = 10_000;
/** Muse Code log rounds for a refinement start here, so they never reuse an earlier build's log name. */
const REFINE_ROUND_STRIDE = 10;

function maxFixRounds(): number {
  return Math.min(REFINE_ROUND_STRIDE - 1, Math.floor(env.maxFixRounds));
}

/** Where the workflow is, for failure messages. Plain object, shared by reference with the helpers below. */
interface Track {
  stage: string;
}

interface Ctx {
  buildId: string;
  productId: string;
  sandboxName: string;
  sessionId: string;
  model: BuildModel;
  /** Muse Code log round of this build's first run: 0 for a new product, REFINE_ROUND_STRIDE * n for refinement n. */
  roundBase: number;
}

async function assertSpendOk(): Promise<void> {
  if (await spendPausedStep()) throw new BuildStop(SPEND_PAUSED_MESSAGE);
}

/** One `muse exec` run, polled every 15 s until it ends or hits its cap (then it's killed). */
async function runMuse(
  ctx: Ctx,
  run: { promptFile: string; images: string[]; round: number; capMs: number },
): Promise<{ timedOut: boolean; exitCode: number | null }> {
  const cmd = await startMuseStep({
    sandboxName: ctx.sandboxName,
    sessionId: ctx.sessionId,
    promptFile: run.promptFile,
    images: run.images,
    model: ctx.model,
    round: ctx.roundBase + run.round,
  });
  const startedAt = Date.now();
  let offset = 0;
  let usageRecorded = false;
  let announced: string[] = [];
  let childrenIncluded: boolean | null = null;
  const poll = () =>
    pollMuseStep({
      buildId: ctx.buildId,
      productId: ctx.productId,
      sandboxName: ctx.sandboxName,
      run: cmd,
      offset,
      round: run.round,
      usageRecorded,
      announced,
      childrenIncluded,
    });
  for (let polls = 1; ; polls++) {
    await sleep(MUSE_POLL_MS);
    const read = await poll();
    offset = read.offset;
    usageRecorded = read.usageRecorded;
    announced = read.announced ?? announced;
    childrenIncluded = read.childrenIncluded ?? childrenIncluded;
    if (read.done) return { timedOut: false, exitCode: read.exitCode };
    if (pollTimedOut({ startedAt, now: Date.now(), capMs: run.capMs, intervalMs: MUSE_POLL_MS, polls })) {
      await killStep(ctx.sandboxName, cmd.cmdId);
      // One last read, so whatever the run wrote on its way out (its usage, if it got that far) is shown and charged.
      try {
        await poll();
      } catch {
        // The run is stopped either way.
      }
      await emitStep(ctx.buildId, {
        type: "log",
        text: `Muse Code was stopped after ${Math.round(run.capMs / 60_000)} minutes.`,
      });
      return { timedOut: true, exitCode: null };
    }
  }
}

/** The verify or demo task (lib/sandbox/tasks.ts), polled until done or the cap (then it's killed). */
async function runTask(
  sandboxName: string,
  task: "verify" | "demo",
  capMs: number,
): Promise<TaskPollResult & { timedOut: boolean }> {
  const cmdId = await startTaskStep(sandboxName, task);
  const startedAt = Date.now();
  for (let polls = 1; ; polls++) {
    await sleep(TASK_POLL_MS);
    const poll = await pollTaskStep(sandboxName, cmdId);
    if (poll.done) return { ...poll, timedOut: false };
    if (pollTimedOut({ startedAt, now: Date.now(), capMs, intervalMs: TASK_POLL_MS, polls })) {
      await killStep(sandboxName, cmdId);
      return { done: false, exitCode: null, outputTail: "", timedOut: true };
    }
  }
}

async function runVerify(ctx: Ctx, round: number): Promise<VerifyResult> {
  const capMs = stepTimeoutMs("verify");
  const task = await runTask(ctx.sandboxName, "verify", capMs);
  if (task.timedOut) return verifyTimedOutStep({ buildId: ctx.buildId, round, minutes: Math.round(capMs / 60_000) });
  return collectVerifyStep({
    buildId: ctx.buildId,
    sandboxName: ctx.sandboxName,
    round,
    exitCode: task.exitCode,
    outputTail: task.outputTail,
  });
}

/** The judge's call. A judge that can't run counts as a failed, non-blocking check, so the fix loop handles it. */
async function judge(ctx: Ctx, round: number, screenshots: VerifyResult["screenshots"]): Promise<JudgeCall> {
  try {
    return await judgeStep({ buildId: ctx.buildId, productId: ctx.productId, round, screenshots });
  } catch (err) {
    const verdict = {
      pass: false,
      blocking: false,
      reasons: ["The screenshot judge could not run, so this round counts as not passed.", failureMessage("judge", err)],
      mismatches: [] as string[],
    };
    await emitStep(ctx.buildId, { type: "judge", round, verdict });
    return { pass: false, blocking: false };
  }
}

interface Checks {
  passed: boolean;
  steps: VerifyStepResult[];
  fixes: number;
  /** The judge's call on the last round, or null when that round's verify failed. */
  judge: JudgeCall | null;
}

/**
 * Verify, then judge if verify passed. On failure, resume the same Muse Code session with fix-<n>.md (and the
 * screenshots the judge saw, when it ran) and check again, up to MAX_FIX_ROUNDS. Returns the last result.
 */
async function checkAndFix(ctx: Ctx, track: Track): Promise<Checks> {
  const rounds = maxFixRounds();
  for (let fix = 0; ; ) {
    const round = fix;
    track.stage = "verify";
    await setStatusStep(ctx.buildId, "verifying", { step: "verify" });
    const verify = await runVerify(ctx, round);
    const judged = verify.passed ? await judge(ctx, round, verify.screenshots) : null;
    const passed = verify.passed && judged?.pass === true;
    if (passed || fix >= rounds) return { passed, steps: verify.steps, fixes: fix, judge: judged };

    fix += 1;
    track.stage = "fix";
    await setStatusStep(ctx.buildId, "fixing", {
      step: "fix",
      fixRounds: fix,
      message: `Fix round ${fix} of ${rounds}`,
    });
    const prompt = await writeFixPromptStep({
      buildId: ctx.buildId,
      sandboxName: ctx.sandboxName,
      fix,
      verifiedRound: round,
    });
    await assertSpendOk();
    // A fix run that hits its cap is still checked: it may have fixed enough before it was stopped.
    await runMuse(ctx, { promptFile: prompt.promptFile, images: prompt.images, round: fix, capMs: stepTimeoutMs("fix") });
  }
}

/**
 * Records the demo (non-fatal), deploys, and registers what shipped. Returns the live URL, or null when publishing is
 * off (no VERCEL_TOKEN, or a local run), in which case the product is registered without one.
 */
async function ship(
  ctx: Ctx,
  track: Track,
  product: { name: string; tagline: string; outcome: Exclude<Outcome, "failed"> },
): Promise<string | null> {
  track.stage = "record";
  await setStatusStep(ctx.buildId, "recording", { step: "record" });
  let demoVideoUrl: string | null = null;
  let demoPosterUrl: string | null = null;
  try {
    // Demo Studio reads its cards and the window's URL from this spec, so it goes in before the run starts.
    await demoSpecStep({
      buildId: ctx.buildId,
      productId: ctx.productId,
      sandboxName: ctx.sandboxName,
      title: product.name,
      tagline: product.tagline,
    });
    const demo = await runTask(ctx.sandboxName, "demo", stepTimeoutMs("record"));
    if (demo.timedOut) {
      await emitStep(ctx.buildId, { type: "log", text: "The demo recording ran too long and was skipped." });
    } else {
      const video = await finishDemoStep({
        buildId: ctx.buildId,
        sandboxName: ctx.sandboxName,
        title: product.name,
        subtitle: product.tagline,
      });
      demoVideoUrl = video.videoUrl;
      demoPosterUrl = video.posterUrl;
      if (!demoVideoUrl) await emitStep(ctx.buildId, { type: "log", text: "The demo run did not pass, so no video was published." });
    }
  } catch (err) {
    await emitStep(ctx.buildId, {
      type: "log",
      text: `The demo recording was skipped. ${failureMessage("record", err)}`,
    });
  }

  track.stage = "deploy";
  const publishOff = await publishOffStep();
  if (publishOff) {
    await emitStep(ctx.buildId, {
      type: "log",
      text: `Publishing is off for this run (${publishOff}), so the product didn't get its own link. The preview, checks and demo above ran for real.`,
    });
    track.stage = "register";
    await setStatusStep(ctx.buildId, "deploying", { step: "register" });
    await registerStep({
      buildId: ctx.buildId,
      productId: ctx.productId,
      sandboxName: ctx.sandboxName,
      sessionId: ctx.sessionId,
      projectId: null,
      liveUrl: null,
      liveTokenId: null,
      demoVideoUrl,
      demoPosterUrl,
      status: product.outcome,
    });
    return null;
  }
  await setStatusStep(ctx.buildId, "deploying", { step: "deploy" });
  const deploy = await startDeployStep({
    buildId: ctx.buildId,
    productId: ctx.productId,
    sandboxName: ctx.sandboxName,
  });
  const capMs = stepTimeoutMs("deploy");
  const startedAt = Date.now();
  let liveUrl: string | null = null;
  for (let polls = 1; !liveUrl; polls++) {
    await sleep(DEPLOY_POLL_MS);
    const poll = await pollDeployStep(deploy.deploymentId);
    if (poll.state === "READY") liveUrl = poll.url;
    else if (poll.state === "ERROR" || poll.state === "CANCELED") {
      throw new BuildStop(
        `Vercel could not deploy the product (${poll.state.toLowerCase()}). ${poll.errorMessage ?? ""}`.trim(),
      );
    } else if (pollTimedOut({ startedAt, now: Date.now(), capMs, intervalMs: DEPLOY_POLL_MS, polls })) {
      throw new BuildStop(`The deployment did not finish within ${Math.round(capMs / 60_000)} minutes.`);
    }
  }
  await emitStep(ctx.buildId, { type: "deploy", url: liveUrl });

  track.stage = "register";
  await setStatusStep(ctx.buildId, "deploying", { step: "register" });
  await registerStep({
    buildId: ctx.buildId,
    productId: ctx.productId,
    sandboxName: ctx.sandboxName,
    sessionId: ctx.sessionId,
    projectId: deploy.projectId,
    liveUrl,
    liveTokenId: deploy.liveTokenId,
    demoVideoUrl,
    demoPosterUrl,
    status: product.outcome,
  });
  return liveUrl;
}

/** How a run ended. Written as the build's status only after cleanup. */
interface Ending {
  status: Outcome;
  message: string;
}

/** From the checks to the outcome: decide live, partial or failed, then ship or stop. */
async function finish(
  ctx: Ctx,
  track: Track,
  kind: "build" | "refine",
  product: { name: string; tagline: string },
  checks: Checks,
  failedMessage: string,
): Promise<Ending> {
  const outcome = decideOutcome({ kind, passed: checks.passed, steps: checks.steps, judge: checks.judge });
  if (outcome === "failed") throw new BuildStop(failedMessage);
  const liveUrl = await ship(ctx, track, { ...product, outcome });
  return {
    status: outcome,
    message: !liveUrl
      ? `Finished as ${outcome} without publishing to its own link.`
      : outcome === "live"
        ? `Live at ${liveUrl}`
        : `Shipped as partial at ${liveUrl}. It runs and passes its tests, but the screenshot judge found parts of the brief it doesn't do yet.`,
  };
}

/** The preview is only for watching, so a page that doesn't answer yet goes on to the checks, which can fix it. */
async function preview(ctx: Ctx): Promise<void> {
  try {
    await previewStep(ctx.buildId, ctx.sandboxName);
  } catch (err) {
    await emitStep(ctx.buildId, {
      type: "log",
      text: `The preview did not start, so the checks run without it. ${failureMessage("preview", err)}`,
    });
  }
}

/** cleanupStep catches its own errors. This also covers the step itself failing, so the run still ends. */
async function cleanup(input: { buildId: string; productId: string | null; sandboxName: string | null }): Promise<void> {
  try {
    await cleanupStep(input);
  } catch {
    // The sandbox times out on its own, and build tokens expire.
  }
}

/** Writes the final status. A failed refinement passes productId null, so the live product is left alone. */
async function end(buildId: string, productId: string | null, ending: Ending): Promise<BuildProductResult> {
  if (ending.status === "failed") await failStep({ buildId, productId, message: ending.message });
  else await setStatusStep(buildId, ending.status, { step: null, message: ending.message });
  return { status: ending.status };
}

export async function buildProduct(input: BuildProductInput): Promise<BuildProductResult> {
  "use workflow";
  const { buildId } = input;
  const track: Track = { stage: "start" };
  let productId: string | null = null;
  let sandboxName: string | null = null;
  let ending: Ending;
  try {
    const head = await loadBuildStep(buildId);
    if (TERMINAL_STATUSES.includes(head.status)) return { status: head.status };
    if (head.kind !== "build") throw new BuildStop("This build is a refinement, not a new product.");
    await assertSpendOk();

    track.stage = "brief";
    await setStatusStep(buildId, "briefing", { step: "brief" });
    const brief = await briefStep(buildId);
    if (brief.verdict === "no") {
      const message = brief.refusal?.trim() || "Muse Muse can't build this one.";
      await setStatusStep(buildId, "refused", { message, error: message });
      return { status: "refused" };
    }

    track.stage = "product";
    const product = await createProductStep(buildId);
    productId = product.productId;

    track.stage = "provision";
    await setStatusStep(buildId, "provisioning", { step: "provision" });
    const fixtures = await fixturesStep(buildId);
    const box = await provisionStep({ buildId, productId, slug: product.slug, fixtures });
    sandboxName = box.sandboxName;
    const ctx: Ctx = { buildId, productId, sandboxName, sessionId: box.sessionId, model: brief.model, roundBase: 0 };

    track.stage = "build";
    await setStatusStep(buildId, "building", { step: "build" });
    await assertSpendOk();
    const built = await runMuse(ctx, { promptFile: "brief.md", images: box.images, round: 0, capMs: stepTimeoutMs("build") });
    if (built.timedOut) throw new BuildStop("Muse Code ran past its 20-minute limit and was stopped.");
    if (built.exitCode === MUSE_EXIT.usage) throw new BuildStop("Muse Code refused its command line, so nothing was built.");
    if (built.exitCode !== MUSE_EXIT.completed) {
      await emitStep(buildId, { type: "log", text: "Muse Code ended with an error. Checking what it wrote." });
    }

    track.stage = "preview";
    await setStatusStep(buildId, "previewing", { step: "preview" });
    await preview(ctx);

    const checks = await checkAndFix(ctx, track);
    track.stage = "verify";
    ending = await finish(
      ctx,
      track,
      "build",
      brief,
      checks,
      `The product did not pass its checks after ${checks.fixes} fix ${checks.fixes === 1 ? "round" : "rounds"}, so it was not deployed.`,
    );
  } catch (err) {
    ending = { status: "failed", message: failureMessage(track.stage, err) };
  }
  if (productId || sandboxName) await cleanup({ buildId, productId, sandboxName });
  return await end(buildId, productId, ending);
}

export async function refineProduct(input: BuildProductInput): Promise<BuildProductResult> {
  "use workflow";
  const { buildId } = input;
  const track: Track = { stage: "start" };
  let productId: string | null = null;
  let sandboxName: string | null = null;
  let ending: Ending;
  try {
    const head = await loadBuildStep(buildId);
    if (TERMINAL_STATUSES.includes(head.status)) return { status: head.status };
    if (head.kind !== "refine") throw new BuildStop("This build is a new product, not a refinement.");
    await assertSpendOk();

    // A change request never passes through the brief writer, so it gets the same refusal policy here, before
    // anything resumes or spends on Muse Code.
    track.stage = "policy";
    await setStatusStep(buildId, "briefing", { step: "brief" });
    const check = await refineCheckStep(buildId);
    if (check.refusal) {
      const message = `${check.refusal} The live version was kept.`;
      await setStatusStep(buildId, "refused", { message, error: message });
      return { status: "refused" };
    }

    track.stage = "provision";
    await setStatusStep(buildId, "provisioning", { step: "provision" });
    const refine = await loadRefineStep(buildId);
    productId = refine.productId;
    sandboxName = refine.sandboxName;
    const reopened = await reopenStep({ buildId, productId, sandboxName, refineIndex: refine.refineIndex });
    const ctx: Ctx = {
      buildId,
      productId,
      sandboxName,
      sessionId: refine.sessionId,
      model: refine.model,
      roundBase: refine.refineIndex * REFINE_ROUND_STRIDE,
    };

    track.stage = "build";
    await setStatusStep(buildId, "building", { step: "build" });
    await assertSpendOk();
    const built = await runMuse(ctx, {
      promptFile: reopened.promptFile,
      images: reopened.images,
      round: 0,
      capMs: stepTimeoutMs("build"),
    });
    if (built.timedOut) throw new BuildStop("Muse Code ran past its 20-minute limit and was stopped. The live version was kept.");
    if (built.exitCode === MUSE_EXIT.usage) throw new BuildStop("Muse Code refused its command line. The live version was kept.");

    track.stage = "preview";
    await setStatusStep(buildId, "previewing", { step: "preview" });
    await preview(ctx);

    const checks = await checkAndFix(ctx, track);
    track.stage = "verify";
    ending = await finish(
      ctx,
      track,
      "refine",
      refine,
      checks,
      "The change did not pass its checks, so it was not deployed. The live version was kept.",
    );
  } catch (err) {
    ending = { status: "failed", message: failureMessage(track.stage, err) };
  }
  if (sandboxName) await cleanup({ buildId, productId, sandboxName });
  return await end(buildId, null, ending);
}
