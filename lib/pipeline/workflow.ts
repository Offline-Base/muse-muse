/**
 * The durable build workflows (docs/DESIGN.md section 2). These functions only orchestrate: every side effect lives
 * in a "use step" function in ./build-steps.ts, and long sandbox work is started detached and polled between durable
 * sleeps, so a 20-minute build is many short steps.
 *
 *   buildProduct:  brief -> product -> fixtures + provision -> build -> preview (non-fatal) -> verify/fix loop
 *                  -> outcome -> record (non-fatal) -> deploy -> register -> hibernate -> final status, with the
 *                  plan card's picture (PLAN_ART, non-fatal) made beside everything after the brief
 *   refineProduct: policy check -> reopen sandbox -> refine-<n>.md -> resume the Muse Code session -> same checks
 *                  and shipping, but only a change that passes every check ships
 *
 * The final status is written after hibernate, so a build only turns terminal (and a refinement can only start) once
 * its sandbox and build tokens are cleaned up.
 *
 * A Stop from the build's owner (POST /api/builds/{id}/control) ends either one at the Muse Code poll that sees it: no
 * checks or fix rounds after it, the same cleanup, and a failed status that says "Stopped by you".
 *
 * With PROVE_IT on, a shipped build then starts the separate Prove it workflow (lib/pipeline/prove.ts). It starts after
 * the final status is written, and nothing it does can change that status.
 *
 * Start them with start() from "workflow/api". Never call them directly.
 */
import { sleep } from "workflow";
import { capsShipping } from "@/lib/caps/ship";
import { env } from "@/lib/env";
import {
  briefStep,
  capsShipStep,
  chainReadStep,
  chainReopenStep,
  chainSaveStep,
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
  liveCheckStep,
  loadBuildStep,
  loadRefineStep,
  milestoneStep,
  museRoundStep,
  pollDeployStep,
  pollMuseStep,
  pollTaskStep,
  previewStep,
  publishOffStep,
  saveUnpublishedVersionStep,
  provisionStep,
  refineCheckStep,
  registerStep,
  reopenStep,
  setStatusStep,
  spendPausedStep,
  startDeployStep,
  startMuseStep,
  startTaskStep,
  startTaskWithEnvStep,
  verifyTimedOutStep,
  writeFixPromptStep,
  writeMilestonePromptStep,
  type MusePollResult,
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
import { planArtStep } from "@/lib/pipeline/plan-art-step";
import { restoreFilesStep, restoreOutcomeStep } from "@/lib/pipeline/restore-steps";
import { packageProductStep } from "@/lib/pipeline/package-step";
import { startProveStep } from "@/lib/pipeline/prove-start";
import { provePlanStep } from "@/lib/pipeline/prove-steps";
import { chainChecksNeedSession, chainEndLine, chainNext, type ChainPosition } from "@/lib/chain/plan";
import { capWithinWall, fullChecksReserveMs, fullRoundCap, JUDGE_RESERVE_MS, stepTimeoutMs, type RoundPlan } from "@/lib/pipeline/steps";
import { MUSE_EXIT, REFINE_ROUND_STRIDE, type BuildModel } from "@/lib/sandbox/muse";
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
/**
 * PLAN_ART: the longest a build that shipped waits at its end for the plan card's picture, so the room hears it while
 * its stream is open. The picture has had the whole build to land, and its own time box is about a minute.
 */
const PLAN_ART_GRACE_MS = 15_000;
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
  /**
   * The engine's round plan (docs/CAPABILITIES.md, section 8), set only when ENGINE_ROUND_SCALING or milestones are on.
   * Without it every round runs on today's caps (STEPS) and no wall applies.
   */
  plan?: RoundPlan;
  /** When the workflow started, for the plan's wall. In a chain, when this session started. */
  startedAt?: number;
  /** CHAINED_BUILDS: where the chain is. */
  chain?: ChainPosition;
}

/** What the build room says when a round that hit its cap goes on to the checks (ENGINE_CHECK_ON_TIMEOUT). */
const CHAIN_LOG_ROUND = "Muse Code was stopped at its time limit. The next session finishes this milestone.";
const CHECKING_AFTER_CAP = "Muse Code was stopped at its time limit. Checking what it built.";

/** The cap for a kind of round: the plan's when there is one, else today's. */
function capFor(ctx: Ctx, kind: "build" | "fix" | "verify"): number {
  const plan = ctx.plan;
  if (!plan) return stepTimeoutMs(kind);
  return kind === "build" ? plan.buildMs : kind === "fix" ? plan.fixMs : plan.verifyMs;
}

/** A round's cap inside the plan's wall, or null when too little is left. Today's cap when there is no plan. */
function capInWall(ctx: Ctx, capMs: number, reserveMs: number): number | null {
  return capWithinWall({ capMs, startedAt: ctx.startedAt ?? Date.now(), now: Date.now(), wallMs: ctx.plan?.wallMs ?? null, reserveMs });
}

async function assertSpendOk(): Promise<void> {
  if (await spendPausedStep()) throw new BuildStop(SPEND_PAUSED_MESSAGE);
}

/** How a build ends when its owner presses Stop: failed, with this message, after the usual cleanup. */
function stoppedByOwner(kind: "build" | "refine"): BuildStop {
  return new BuildStop(kind === "refine" ? "Stopped by you. The live version was kept." : "Stopped by you.");
}

/** How one Muse Code run ended. `stopped` means its owner pressed Stop, which ends the build whatever else happened. */
interface MuseRunEnd {
  timedOut: boolean;
  stopped: boolean;
  exitCode: number | null;
}

/**
 * One `muse exec` run, polled every 15 s until it ends, hits its cap or its owner presses Stop (the last two kill a run
 * still going). While steering is on and it runs, the build row names its round, so the owner's controls can reach it.
 * The workflow's environment is fixed when it starts, so a replay takes the same steps.
 */
async function runMuse(
  ctx: Ctx,
  run: { promptFile: string; images: string[]; round: number; capMs: number },
): Promise<MuseRunEnd> {
  const round = ctx.roundBase + run.round;
  const cmd = await startMuseStep({
    sandboxName: ctx.sandboxName,
    sessionId: ctx.sessionId,
    promptFile: run.promptFile,
    images: run.images,
    model: ctx.model,
    round,
    buildId: ctx.buildId,
    // A scaled round asks for its own session time (lib/sandbox/builder.ts startMuse). Today's rounds don't pass it.
    ...(ctx.plan ? { capMs: run.capMs } : {}),
  });
  if (env.steeringEnabled) await museRoundStep(ctx.buildId, round);
  const startedAt = Date.now();
  let offset = 0;
  let usageRecorded = false;
  let announced: string[] = [];
  let childrenIncluded: boolean | null = null;
  // The session bridge's condenser state (serve rounds only), so an item's update replaces its line instead of repeating it.
  let bridgeState: MusePollResult["bridgeState"];
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
      ...(bridgeState ? { bridgeState } : {}),
    });
  for (let polls = 1; ; polls++) {
    await sleep(MUSE_POLL_MS);
    const read = await poll();
    offset = read.offset;
    usageRecorded = read.usageRecorded;
    announced = read.announced ?? announced;
    childrenIncluded = read.childrenIncluded ?? childrenIncluded;
    bridgeState = read.bridgeState ?? bridgeState;
    // The owner pressed Stop (POST /api/builds/{id}/control). The session was told to end too, so a run that hasn't
    // ended yet is killed, and nothing more runs after this poll.
    if (read.stopRequested) {
      if (!read.done) await endRun(ctx, cmd.cmdId, poll);
      return { timedOut: false, stopped: true, exitCode: read.exitCode };
    }
    if (read.done) return { timedOut: false, stopped: false, exitCode: read.exitCode };
    if (pollTimedOut({ startedAt, now: Date.now(), capMs: run.capMs, intervalMs: MUSE_POLL_MS, polls })) {
      const stopped = await endRun(ctx, cmd.cmdId, poll);
      await emitStep(ctx.buildId, {
        type: "log",
        text: `Muse Code was stopped after ${Math.round(run.capMs / 60_000)} minutes.`,
      });
      return { timedOut: true, stopped, exitCode: null };
    }
  }
}

/**
 * Kills a run that hasn't ended, reads what it wrote on its way out, and takes its round off the build row. Returns
 * whether the owner pressed Stop meanwhile, which the round's update reads too, so a Stop sent at the cap still counts.
 */
async function endRun(ctx: Ctx, cmdId: string, poll: () => Promise<MusePollResult>): Promise<boolean> {
  await killStep(ctx.sandboxName, cmdId);
  let stopped = false;
  // One last read, so whatever the run wrote on its way out (its usage, if it got that far) is shown and charged.
  try {
    stopped = (await poll()).stopRequested === true;
  } catch {
    // The run is stopped either way.
  }
  return (env.steeringEnabled && (await museRoundStep(ctx.buildId, null))) || stopped;
}

/** The verify or demo task (lib/sandbox/tasks.ts), polled until done or the cap (then it's killed). */
async function runTask(
  sandboxName: string,
  task: "verify" | "demo",
  capMs: number,
  taskEnv?: Record<string, string>,
): Promise<TaskPollResult & { timedOut: boolean }> {
  const cmdId = taskEnv ? await startTaskWithEnvStep(sandboxName, task, taskEnv) : await startTaskStep(sandboxName, task);
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

/**
 * A new build's verify on the last round runs the screen checks (judgeShot's and the final screen's) in warn mode:
 * they log what they find instead of failing, so the judge decides, and a build only they would stop can still ship
 * as partial. Earlier rounds keep them strict, so what they find goes into the next fix round. A refinement keeps
 * them strict to the end, since it ships only when every check passes.
 */
const LAST_ROUND_VERIFY_ENV = { MUSEMUSE_SCREEN_CHECK: "warn" };

async function runVerify(ctx: Ctx, round: number, lastRound: boolean): Promise<VerifyResult> {
  const capMs = capFor(ctx, "verify");
  // A chain's verify has longer than verify.mjs's usual 25 minutes for the requirements, inside the plan's cap.
  const chainEnv = ctx.chain ? { MUSEMUSE_REQUIREMENTS_MS: String(Math.max(60_000, capMs - 5 * 60_000)) } : null;
  const taskEnv = lastRound || chainEnv ? { ...(lastRound ? LAST_ROUND_VERIFY_ENV : {}), ...chainEnv } : undefined;
  const task = await runTask(ctx.sandboxName, "verify", capMs, taskEnv);
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
 *
 * `offset` is the Muse Code round the checks start after: 0, or the last milestone's round, so fix rounds number from
 * milestones + fix and logs never share a round. Milestones plus fixes stay under REFINE_ROUND_STRIDE. With a round
 * plan, a fix round that wouldn't fit before the build's wall isn't started, and the verify before it counts as the last.
 */
async function checkAndFix(ctx: Ctx, track: Track, kind: "build" | "refine", offset = 0): Promise<Checks> {
  // A chain's rounds run past the stride on purpose (docs/CHAINED_BUILDS.md). startMuse keeps an earlier round's log.
  const rounds = ctx.chain ? maxFixRounds() : Math.min(maxFixRounds(), REFINE_ROUND_STRIDE - 1 - offset);
  for (let fix = 0; ; ) {
    const round = offset + fix;
    track.stage = "verify";
    await setStatusStep(ctx.buildId, "verifying", { step: "verify" });
    const verifyMs = capFor(ctx, "verify");
    // Room for this verify and its judge, a fix round, and the verify and judge after it.
    const roomForFix = !ctx.plan || capInWall(ctx, capFor(ctx, "fix"), 2 * (verifyMs + JUDGE_RESERVE_MS)) !== null;
    const last = fix >= rounds || !roomForFix;
    const verify = await runVerify(ctx, round, kind === "build" && last);
    const judged = verify.passed ? await judge(ctx, round, verify.screenshots) : null;
    const passed = verify.passed && judged?.pass === true;
    if (passed || fix >= rounds) return { passed, steps: verify.steps, fixes: fix, judge: judged };
    // The verify and judge above may have used the margin: a fix round that no longer fits before the wall, with its
    // own verify and judge after it, isn't started. Without a plan this is today's fix cap.
    const fixCap = roomForFix ? capInWall(ctx, capFor(ctx, "fix"), verifyMs + JUDGE_RESERVE_MS) : null;
    if (fixCap === null) {
      await emitStep(ctx.buildId, { type: "log", text: "The build is near its time limit, so no more fix rounds run." });
      return { passed, steps: verify.steps, fixes: fix, judge: judged };
    }

    // A chain's total holds here too: no fix round once it's spent.
    if (ctx.chain && ctx.plan?.chain && (await chainReadStep(ctx.buildId)).costUsd >= ctx.plan.chain.totalUsd) {
      await emitStep(ctx.buildId, { type: "log", text: `The chain reached its $${ctx.plan.chain.totalUsd} spending cap, so no more fix rounds run.` });
      return { passed, steps: verify.steps, fixes: fix, judge: judged };
    }

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
    // A fix run that hits its cap is still checked: it may have fixed enough before it was stopped. One its owner
    // stopped is not, and no fix round comes after it.
    const fixed = await runMuse(ctx, { promptFile: prompt.promptFile, images: prompt.images, round: offset + fix, capMs: fixCap });
    if (fixed.stopped) throw stoppedByOwner(kind);
  }
}

/**
 * Milestone builds (ENGINE_MILESTONES, docs/CAPABILITIES.md section 8). Round 0 built milestone 1. For each milestone
 * after it: a strict verify with no judge, then milestone-<n>.md (with that verify's failures, if any) in the same
 * session as round n - 1. A milestone that wouldn't fit before the build's wall is skipped, and the checks run on what
 * was built. Returns the Muse Code round of the last milestone that ran, where the fix rounds start from.
 */
async function runMilestones(ctx: Ctx, track: Track, list: Array<{ title: string }>): Promise<number> {
  const of = list.length;
  const verifyMs = capFor(ctx, "verify");
  for (let n = 2; n <= of; n++) {
    track.stage = "verify";
    await setStatusStep(ctx.buildId, "verifying", { step: "verify", message: `Checking milestone ${n - 1} of ${of}` });
    const verify = await runVerify(ctx, n - 2, false);
    await milestoneStep(ctx.buildId, { index: n - 1, of, title: list[n - 2]!.title, state: verify.passed ? "passed" : "failed" });
    const cap = ctx.plan?.full
      ? fullRoundCap({ plan: ctx.plan, startedAt: ctx.startedAt ?? Date.now(), now: Date.now(), milestonesLeft: of - n + 1 })
      : capInWall(ctx, capFor(ctx, "build"), 2 * verifyMs);
    if (cap === null) {
      for (let k = n; k <= of; k++) await milestoneStep(ctx.buildId, { index: k, of, title: list[k - 1]!.title, state: "skipped" });
      await emitStep(ctx.buildId, {
        type: "log",
        text: `The build is near its time limit, so milestone ${n} of ${of} and any after it were skipped. The checks run on what was built.`,
      });
      return n - 2;
    }
    const prompt = await writeMilestonePromptStep({ buildId: ctx.buildId, sandboxName: ctx.sandboxName, index: n, of, verifiedRound: n - 2 });
    await assertSpendOk();
    track.stage = "build";
    await setStatusStep(ctx.buildId, "building", { step: "build", message: `Milestone ${n} of ${of}` });
    await milestoneStep(ctx.buildId, { index: n, of, title: list[n - 1]!.title, state: "building" });
    const run = await runMuse(ctx, { promptFile: prompt.promptFile, images: [], round: n - 1, capMs: cap });
    if (run.stopped) throw stoppedByOwner("build");
    if (run.timedOut) await emitStep(ctx.buildId, { type: "log", text: CHECKING_AFTER_CAP });
  }
  return of - 1;
}

/** Saves this session in the repo and starts the next, on the same sandbox. The owner's Stop still holds between them. */
async function rotateSession(ctx: Ctx): Promise<void> {
  const position = ctx.chain!;
  await chainSaveStep({ buildId: ctx.buildId, sandboxName: ctx.sandboxName, session: position.session });
  const { costUsd, stopRequested } = await chainReadStep(ctx.buildId);
  if (stopRequested) throw stoppedByOwner("build");
  const session = position.session + 1;
  const { sessionId } = await chainReopenStep({ buildId: ctx.buildId, productId: ctx.productId, sandboxName: ctx.sandboxName, session });
  const now = Date.now();
  ctx.sessionId = sessionId;
  ctx.startedAt = now;
  ctx.chain = { ...position, session, sessionStartedAt: now, sessionStartUsd: costUsd };
}

/**
 * CHAINED_BUILDS (docs/CHAINED_BUILDS.md). Like runMilestones, but a milestone that won't fit in this session starts the
 * next one instead of being skipped, and only the chain's own limits end it early. Round numbers keep counting up across
 * sessions. Returns the round of the last milestone that ran.
 */
async function runChain(ctx: Ctx, track: Track, list: Array<{ title: string }>): Promise<number> {
  const of = list.length;
  const plan = ctx.plan!;
  const limits = plan.chain!;
  let fresh: number | undefined;
  for (let n = 2; n <= of; n++) {
    track.stage = "verify";
    await setStatusStep(ctx.buildId, "verifying", { step: "verify", message: `Checking milestone ${n - 1} of ${of}` });
    const verify = await runVerify(ctx, n - 2, false);
    await milestoneStep(ctx.buildId, { index: n - 1, of, title: list[n - 2]!.title, state: verify.passed ? "passed" : "failed" });
    let read = await chainReadStep(ctx.buildId);
    if (read.stopRequested) throw stoppedByOwner("build");
    let next = chainNext({ limits, position: ctx.chain!, costUsd: read.costUsd, verifyMs: plan.verifyMs, now: Date.now() });
    if (next.action === "rotate") {
      await rotateSession(ctx);
      fresh = ctx.chain!.session;
      read = await chainReadStep(ctx.buildId);
      next = chainNext({ limits, position: ctx.chain!, costUsd: read.costUsd, verifyMs: plan.verifyMs, now: Date.now() });
    }
    if (next.action !== "round") {
      for (let k = n; k <= of; k++) await milestoneStep(ctx.buildId, { index: k, of, title: list[k - 1]!.title, state: "skipped" });
      await emitStep(ctx.buildId, { type: "log", text: chainEndLine(next.action === "end" ? next.reason : "sessions", limits, n, of) });
      return n - 2;
    }
    const prompt = await writeMilestonePromptStep({ buildId: ctx.buildId, sandboxName: ctx.sandboxName, index: n, of, verifiedRound: n - 2, ...(fresh ? { newSession: fresh } : {}) });
    fresh = undefined;
    await assertSpendOk();
    track.stage = "build";
    await setStatusStep(ctx.buildId, "building", { step: "build", message: `Milestone ${n} of ${of}, session ${ctx.chain!.session}` });
    await milestoneStep(ctx.buildId, { index: n, of, title: list[n - 1]!.title, state: "building" });
    const run = await runMuse(ctx, { promptFile: prompt.promptFile, images: [], round: n - 1, capMs: next.capMs });
    if (run.stopped) throw stoppedByOwner("build");
    if (run.timedOut) await emitStep(ctx.buildId, { type: "log", text: CHAIN_LOG_ROUND });
  }
  // The checks and fix rounds get a session with room for them.
  if (chainChecksNeedSession({ limits, position: ctx.chain!, reserveMs: fullChecksReserveMs(plan), now: Date.now() })) await rotateSession(ctx);
  return of - 1;
}

/** What shipped: the live URL (null when publishing is off), the outcome registered, and why the live check failed. */
interface Shipped {
  liveUrl: string | null;
  outcome: Exclude<Outcome, "failed">;
  /** Set when ENGINE_LIVE_SMOKE's check of the live link failed, which ships the product as partial. */
  liveFailure: string | null;
}

/**
 * Records the demo (non-fatal), deploys, and registers what shipped. Returns the live URL, or null when publishing is
 * off (no VERCEL_TOKEN, or a local run), in which case the product is registered without one.
 */
async function ship(
  ctx: Ctx,
  track: Track,
  product: { name: string; tagline: string; outcome: Exclude<Outcome, "failed">; restoredFrom?: string },
): Promise<Shipped> {
  let demoVideoUrl: string | null = null;
  let demoPosterUrl: string | null = null;
  // A restore ships code that already shipped, and keeps the demo it has.
  if (!product.restoredFrom) {
  track.stage = "record";
  await setStatusStep(ctx.buildId, "recording", { step: "record" });
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
  }

  track.stage = "deploy";
  const publishOff = await publishOffStep();
  if (publishOff) {
    await emitStep(ctx.buildId, {
      type: "log",
      text: `Publishing is off for this run (${publishOff}), so the product didn't get its own link. The preview, checks and demo above ran for real.`,
    });
    await saveUnpublishedVersionStep({ buildId: ctx.buildId, productId: ctx.productId, sandboxName: ctx.sandboxName, restoredFrom: product.restoredFrom ?? null });
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
    return { liveUrl: null, outcome: product.outcome, liveFailure: null };
  }
  await setStatusStep(ctx.buildId, "deploying", { step: "deploy" });
  const deploy = await startDeployStep({
    buildId: ctx.buildId,
    productId: ctx.productId,
    sandboxName: ctx.sandboxName,
    restoredFrom: product.restoredFrom ?? null,
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

  // The live check (ENGINE_LIVE_SMOKE): the live link and its routes answer, with no model call. A product that passed
  // on the build machine but not on its link ships as partial, so its page says so.
  let outcome = product.outcome;
  let liveFailure: string | null = null;
  if (env.engineLiveSmoke) {
    track.stage = "live_check";
    const check = await liveCheckStep({ buildId: ctx.buildId, sandboxName: ctx.sandboxName, url: liveUrl });
    if (!check.ok) {
      liveFailure = check.reason ?? "it did not answer";
      outcome = "partial";
    }
  }

  // ---------- Wave 3, unit 14 (docs/CAPABILITIES.md, section 20): what a cap makes from the live link ----------
  // Only when an enabled cap has a step after deploy, so with every flag off the workflow runs no extra step.
  if (capsShipping(env.enabledCaps)) await capsShipStep({ buildId: ctx.buildId, productId: ctx.productId, sandboxName: ctx.sandboxName, liveUrl });
  // ---------- end Wave 3, unit 14 ----------

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
    status: outcome,
  });
  // Phone and desktop downloads, from the live link. With no packager snapshot the workflow runs no extra step.
  if (env.packagerSnapshotId) await packageProductStep({ buildId: ctx.buildId, productId: ctx.productId, liveUrl });
  return { liveUrl, outcome, liveFailure };
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
  const decided = decideOutcome({ kind, passed: checks.passed, steps: checks.steps, judge: checks.judge });
  // FULL_BUILDS: the final word names every requirement still not met.
  const unmet = checks.judge?.unmet?.length ? ` Not met: ${checks.judge.unmet.join(" ")}` : "";
  if (decided === "failed") throw new BuildStop(`${failedMessage}${unmet}`);
  const { liveUrl, outcome, liveFailure } = await ship(ctx, track, { ...product, outcome: decided });
  return {
    status: outcome,
    message: !liveUrl
      ? `Finished as ${outcome} without publishing to its own link.${unmet}`
      : liveFailure
        ? `Shipped as partial at ${liveUrl}. It passed on the build machine, but failed on its live link: ${liveFailure}`
        : outcome === "live"
          ? `Live at ${liveUrl}`
          : `Shipped as partial at ${liveUrl}. It runs and passes its tests, but the screenshot judge found parts of the brief it doesn't do yet.${unmet}`,
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

/**
 * Says a Prove it run is coming, when one is. This comes before the final status, so the room's stream stays open for it,
 * and it can only ever cost one database write: anything going wrong here means no run.
 */
async function planProof(buildId: string, ending: Ending): Promise<string | null> {
  if (!env.proveIt || (ending.status !== "live" && ending.status !== "partial")) return null;
  try {
    return await provePlanStep(buildId);
  } catch {
    return null;
  }
}

/** Starts the run planProof announced. The build is already final, so a failure here changes nothing. */
async function startProof(buildId: string, runId: string | null): Promise<void> {
  if (!runId) return;
  try {
    await startProveStep({ buildId, runId });
  } catch {
    // The step says so itself when it can.
  }
}

export async function buildProduct(input: BuildProductInput): Promise<BuildProductResult> {
  "use workflow";
  const { buildId } = input;
  const startedAt = Date.now();
  const track: Track = { stage: "start" };
  let productId: string | null = null;
  let sandboxName: string | null = null;
  let ending: Ending;
  let art: Promise<unknown> | null = null;
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
    // The plan card's own picture, beside every step from here on. It gives up within about a minute and never throws,
    // so it can't hold up or fail the build. Waited for briefly before a shipped build's final status (PLAN_ART_GRACE_MS).
    if (env.planArt) art = planArtStep(buildId).catch(() => null);

    track.stage = "product";
    const product = await createProductStep(buildId);
    productId = product.productId;

    track.stage = "provision";
    await setStatusStep(buildId, "provisioning", { step: "provision" });
    const fixtures = await fixturesStep(buildId);
    const box = await provisionStep({ buildId, productId, slug: product.slug, fixtures });
    sandboxName = box.sandboxName;
    const ctx: Ctx = {
      buildId,
      productId,
      sandboxName,
      sessionId: box.sessionId,
      model: brief.model,
      roundBase: 0,
      ...(brief.plan ? { plan: brief.plan, startedAt } : {}),
      ...(brief.plan?.chain ? { chain: { session: 1, chainStartedAt: startedAt, sessionStartedAt: startedAt, sessionStartUsd: 0 } } : {}),
    };
    const milestones = brief.plan?.milestones ?? [];

    track.stage = "build";
    await setStatusStep(buildId, "building", { step: "build" });
    await assertSpendOk();
    if (milestones.length > 1) await milestoneStep(buildId, { index: 1, of: milestones.length, title: milestones[0]!.title, state: "building" });
    const firstCap = (ctx.plan?.full && !ctx.chain ? fullRoundCap({ plan: ctx.plan, startedAt, now: Date.now(), milestonesLeft: Math.max(1, milestones.length) }) : null) ?? capFor(ctx, "build");
    const built = await runMuse(ctx, { promptFile: "brief.md", images: box.images, round: 0, capMs: firstCap });
    if (built.stopped) throw stoppedByOwner("build");
    if (built.timedOut) {
      // A first round stopped at its cap is checked like a fix round (ENGINE_CHECK_ON_TIMEOUT): it may have built enough.
      if (!env.engineCheckOnTimeout && !ctx.plan?.full) throw new BuildStop(`Muse Code ran past its ${Math.round(firstCap / 60_000)}-minute limit and was stopped.`);
      await emitStep(buildId, { type: "log", text: CHECKING_AFTER_CAP });
    } else {
      if (built.exitCode === MUSE_EXIT.usage) throw new BuildStop("Muse Code refused its command line, so nothing was built.");
      if (built.exitCode !== MUSE_EXIT.completed) {
        await emitStep(buildId, { type: "log", text: "Muse Code ended with an error. Checking what it wrote." });
      }
    }
    const offset = milestones.length > 1 ? await (ctx.chain ? runChain(ctx, track, milestones) : runMilestones(ctx, track, milestones)) : 0;

    track.stage = "preview";
    await setStatusStep(buildId, "previewing", { step: "preview" });
    await preview(ctx);

    const checks = await checkAndFix(ctx, track, "build", offset);
    if (milestones.length > 1) {
      // The last milestone that ran is decided by the checks and fix rounds after it.
      const ran = offset + 1;
      await milestoneStep(buildId, { index: ran, of: milestones.length, title: milestones[ran - 1]!.title, state: checks.passed ? "passed" : "failed" });
    }
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
  // Bounded, so a picture that hangs (or a step that never runs) can't hold the end. A failed build doesn't wait at all:
  // its cleanup and failure come first, and a picture that lands after them is still in the log on the next load.
  if (art && ending.status !== "failed") await Promise.race([art, sleep(PLAN_ART_GRACE_MS)]);
  if (productId || sandboxName) await cleanup({ buildId, productId, sandboxName });
  const proof = await planProof(buildId, ending);
  const result = await end(buildId, productId, ending);
  await startProof(buildId, proof);
  return result;
}

export async function refineProduct(input: BuildProductInput): Promise<BuildProductResult> {
  "use workflow";
  const { buildId } = input;
  const startedAt = Date.now();
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
      ...(refine.plan ? { plan: refine.plan, startedAt } : {}),
    };

    track.stage = "build";
    await setStatusStep(buildId, "building", { step: "build" });
    await assertSpendOk();
    const firstCap = capFor(ctx, "build");
    const built = await runMuse(ctx, {
      promptFile: reopened.promptFile,
      images: reopened.images,
      round: 0,
      capMs: firstCap,
    });
    if (built.stopped) throw stoppedByOwner("refine");
    // A change stopped at its cap stops here even with ENGINE_CHECK_ON_TIMEOUT: the judge checks the product's brief,
    // not the change, so a half-made change could pass and replace the live version. The live version is kept.
    if (built.timedOut) {
      throw new BuildStop(`Muse Code ran past its ${Math.round(firstCap / 60_000)}-minute limit and was stopped. The live version was kept.`);
    } else if (built.exitCode === MUSE_EXIT.usage) {
      throw new BuildStop("Muse Code refused its command line. The live version was kept.");
    }

    track.stage = "preview";
    await setStatusStep(buildId, "previewing", { step: "preview" });
    await preview(ctx);

    const checks = await checkAndFix(ctx, track, "refine");
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
  const proof = await planProof(buildId, ending);
  const result = await end(buildId, null, ending);
  await startProof(buildId, proof);
  return result;
}

/**
 * Brings back an earlier version as a new build on top of the history (docs/VERSIONS.md): its saved files go in the
 * sandbox, then deploy with a fresh token. No Muse Code and no judge, so no Meta spend: this code already shipped. A
 * restore that fails puts the live version's files back, so the next change doesn't build on the wrong code.
 */
export async function restoreProduct(input: BuildProductInput & { fromBuildId: string }): Promise<BuildProductResult> {
  "use workflow";
  const { buildId, fromBuildId } = input;
  const track: Track = { stage: "start" };
  let productId: string | null = null;
  let sandboxName: string | null = null;
  let filesChanged = false;
  let ending: Ending;
  try {
    const head = await loadBuildStep(buildId);
    if (TERMINAL_STATUSES.includes(head.status)) return { status: head.status };
    track.stage = "provision";
    await setStatusStep(buildId, "provisioning", { step: "provision" });
    const refine = await loadRefineStep(buildId);
    productId = refine.productId;
    sandboxName = refine.sandboxName;
    await reopenStep({ buildId, productId, sandboxName, refineIndex: refine.refineIndex });
    const ctx: Ctx = { buildId, productId, sandboxName, sessionId: refine.sessionId, model: refine.model, roundBase: refine.refineIndex * REFINE_ROUND_STRIDE };
    filesChanged = true;
    await restoreFilesStep({ buildId, productId, sandboxName, fromBuildId });
    track.stage = "deploy";
    const outcome = await restoreOutcomeStep(fromBuildId);
    const { liveUrl, outcome: shipped, liveFailure } = await ship(ctx, track, { name: refine.name, tagline: refine.tagline, outcome, restoredFrom: fromBuildId });
    ending = {
      status: shipped,
      message: !liveUrl ? `Restored as ${shipped} without publishing to its own link.` : liveFailure ? `Restored as partial at ${liveUrl}, but it failed on its live link: ${liveFailure}` : `Restored and live at ${liveUrl}`,
    };
  } catch (err) {
    ending = { status: "failed", message: `${failureMessage(track.stage, err)} The live version was kept.` };
    if (filesChanged && productId && sandboxName) {
      try {
        await restoreFilesStep({ buildId, productId, sandboxName, fromBuildId: null });
      } catch {
        // Nothing saved to go back to: the next change starts from the restored files.
      }
    }
  }
  if (sandboxName) await cleanup({ buildId, productId, sandboxName });
  return end(buildId, null, ending);
}
