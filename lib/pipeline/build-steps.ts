/**
 * The build workflow's steps ("use step"). Each one takes and returns small plain values, finishes in well under a
 * few minutes, and is safe to run again on retry. Retries follow the STEPS table in ./steps.ts; steps that start
 * detached work (Muse Code, verify, demo) never retry, so a retry can't start the same work twice.
 *
 * Plaintext gateway tokens are minted inside the step that hands them to the sandbox or to Vercel, so they never
 * appear in a step's return value (step results are persisted in the workflow's event log).
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lte, notInArray, sql } from "drizzle-orm";
import { FatalError, getStepMetadata } from "workflow";
import type { Brief } from "@/lib/brief/schema";
import { checkChange } from "@/lib/brief/policy";
import { goalObjective, renderBuildPrompt, renderFixPrompt, renderRefinePrompt } from "@/lib/brief/render";
import { StructuredOutputError } from "@/lib/brief/structured";
import { prepareFixtures, writeBrief, type PreparedFixture } from "@/lib/brief/write";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { addBuildCost, emit, setBuildStatus } from "@/lib/events";
import { buildTokenBudgetFor, liveTokenDailyBudgetFor } from "@/lib/gateway/policy";
import { mintToken, revokeLiveTokensExcept, revokeTokens } from "@/lib/gateway/tokens";
import { judgeBuild, pickScreenshots } from "@/lib/judge";
import { rebuildTargetFor } from "@/lib/pipeline/catalog";
import {
  allowedModelsFor,
  museImagePaths,
  nextFreeSlug,
  normalizeSlug,
  pickBuildModel,
  refineBuildModel,
  SLUG_MAX,
  type JudgeCall,
} from "@/lib/pipeline/logic";
import { modelLabel } from "@/lib/format";
import { stepRetries } from "@/lib/pipeline/steps";
import { pollDeploy, projectNameFor, startDeployFromSandbox, type DeployPoll } from "@/lib/publish/vercel";
import * as sandbox from "@/lib/sandbox/builder";
import type { MuseEngine } from "@/lib/sandbox/bridge-protocol";
import type { BridgeCondenseState } from "@/lib/sandbox/msp-log";
import type { BuildModel } from "@/lib/sandbox/muse";
import { ownersLabel } from "@/lib/sandbox/muse-log";
import {
  TERMINAL_STATUSES,
  type BuildEventBody,
  type BuildStatus,
  type JudgeVerdict,
  type ModelUsage,
  type ProductStatus,
  type Reference,
  type Screenshot,
  type VerifySummary,
} from "@/lib/types";
import { platformSpendToday, recordUsage, type UsageContext } from "@/lib/usage";

/** Muse Code's step budget per run. */
const MAX_MODEL_STEPS = 200;
const BUILD_TOKEN_TTL_HOURS = 6;

// ---------------------------------------------------------------------------------------------------------------
// Helpers (not steps)

async function loadBuild(buildId: string) {
  const [build] = await db().select().from(schema.builds).where(eq(schema.builds.id, buildId)).limit(1);
  if (!build) throw new FatalError(`Build ${buildId} was not found.`);
  return build;
}

async function loadInspiration(inspirationId: string) {
  const [row] = await db()
    .select()
    .from(schema.inspirations)
    .where(eq(schema.inspirations.id, inspirationId))
    .limit(1);
  if (!row) throw new FatalError("The muse for this build was not found.");
  return row;
}

async function loadProduct(productId: string) {
  const [row] = await db().select().from(schema.products).where(eq(schema.products.id, productId)).limit(1);
  if (!row) throw new FatalError("The product for this build was not found.");
  return row;
}

function requireBrief(build: { brief: Brief | null }): Brief {
  if (!build.brief) throw new FatalError("This build has no brief yet.");
  return build.brief;
}

function attempt(): number {
  try {
    return getStepMetadata().attempt;
  } catch {
    return 1;
  }
}

/**
 * On a retry, drops usage rows an earlier attempt of the same step already wrote: same build, source, endpoint,
 * model and token counts within the last hour. A fresh model call never repeats exact counts, so this only catches
 * replays of the same result (for example the same Muse run's usage read twice).
 */
async function unrecorded(ctx: UsageContext, items: ModelUsage[]): Promise<ModelUsage[]> {
  if (attempt() <= 1 || !ctx.buildId) return items;
  const since = new Date(Date.now() - 3_600_000);
  const out: ModelUsage[] = [];
  for (const u of items) {
    const [hit] = await db()
      .select({ id: schema.usage.id })
      .from(schema.usage)
      .where(
        and(
          eq(schema.usage.buildId, ctx.buildId),
          eq(schema.usage.source, ctx.source),
          eq(schema.usage.endpoint, ctx.endpoint),
          eq(schema.usage.model, u.model),
          eq(schema.usage.inputTokens, Math.round(u.inputTokens)),
          eq(schema.usage.cachedInputTokens, Math.round(u.cachedInputTokens)),
          eq(schema.usage.outputTokens, Math.round(u.outputTokens)),
          eq(schema.usage.images, u.images ?? 0),
          eq(schema.usage.videoFrames, u.videoFrames ?? 0),
          gte(schema.usage.at, since),
        ),
      )
      .limit(1);
    if (!hit) out.push(u);
  }
  return out;
}

/** Records usage rows and adds their cost to the build, once per result even when the step retries. */
async function charge(ctx: UsageContext & { buildId: string }, usage: ModelUsage[], what: string): Promise<void> {
  const items = await unrecorded(ctx, usage);
  if (!items.length) return;
  await recordUsage(ctx, items);
  await addBuildCost(
    ctx.buildId,
    items.reduce((sum, u) => sum + (u.costUsd || 0), 0),
    what,
  );
}

/** Brief spend, with voice memo transcription recorded under its own endpoint. */
async function chargeBrief(buildId: string, usage: ModelUsage[]): Promise<void> {
  const voice = usage.filter((u) => u.model === "muse-voice-transcribe-1.0");
  const rest = usage.filter((u) => u.model !== "muse-voice-transcribe-1.0");
  if (voice.length) await charge({ source: "platform", endpoint: "asr/transcribe", buildId }, voice, "Voice memo");
  await charge({ source: "platform", endpoint: "responses", buildId }, rest, "Brief");
}

/**
 * What a run's prompt says about the session around it: the goal the session bridge sets from Done means, notes the
 * build's owner can send while it runs, and the playbook for subagents and workflows, which only test builds on the
 * session bridge or MUSE_FULL get. All off for plain `muse exec`, which keeps today's prompts.
 */
function sessionNotes(): { goalSet: boolean; ownerNotes: boolean; playbook: boolean } {
  return {
    goalSet: env.museEngine === "serve",
    ownerNotes: env.steeringEnabled,
    playbook: env.museFull || env.museEngine === "serve",
  };
}

/**
 * Whether the build's owner pressed Stop (POST /api/builds/{id}/control), read in the same statement that sets the
 * build's running Muse Code round when `set` is given: the route marks a stop only while a round is set, so an update
 * that takes the round off the row always sees a stop that landed before it.
 */
async function ownerStopped(buildId: string, set?: { museRound: number | null }): Promise<boolean> {
  const cols = { stopRequested: schema.builds.stopRequested };
  const where = eq(schema.builds.id, buildId);
  const [row] = set
    ? await db().update(schema.builds).set(set).where(where).returning(cols)
    : await db().select(cols).from(schema.builds).where(where).limit(1);
  return row?.stopRequested === true;
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; i++) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Bookkeeping steps

export interface BuildHead {
  kind: "build" | "refine";
  status: BuildStatus;
  productId: string | null;
}

export async function loadBuildStep(buildId: string): Promise<BuildHead> {
  "use step";
  const build = await loadBuild(buildId);
  return { kind: build.kind, status: build.status, productId: build.productId };
}

/** Moves the build to a status. `error` also saves the message as the build's error (refusals). */
export async function setStatusStep(
  buildId: string,
  status: BuildStatus,
  opts: { step?: string | null; message?: string; fixRounds?: number; error?: string } = {},
): Promise<void> {
  "use step";
  await setBuildStatus(buildId, status, {
    step: opts.step,
    message: opts.message,
    set: {
      ...(opts.fixRounds !== undefined ? { fixRounds: opts.fixRounds } : {}),
      ...(opts.error !== undefined ? { error: opts.error } : {}),
    },
  });
}

export async function emitStep(buildId: string, body: BuildEventBody): Promise<void> {
  "use step";
  await emit(buildId, body);
}

/** True when today's platform-wide spend is at or over DAILY_SPEND_CAP_USD. */
export async function spendPausedStep(): Promise<boolean> {
  "use step";
  return (await platformSpendToday()) >= env.dailySpendCapUsd;
}

/**
 * Marks the build failed with a plain message. A product that never shipped is marked failed too, and all its tokens
 * are revoked (a deploy that failed may have minted a live token).
 */
export async function failStep(input: { buildId: string; productId: string | null; message: string }): Promise<void> {
  "use step";
  await setBuildStatus(input.buildId, "failed", { message: input.message, set: { error: input.message } });
  await emit(input.buildId, { type: "error", message: input.message });
  if (input.productId) {
    const unshipped = await db()
      .update(schema.products)
      .set({ status: "failed", updatedAt: new Date() })
      .where(and(eq(schema.products.id, input.productId), eq(schema.products.status, "building")))
      .returning({ id: schema.products.id });
    if (unshipped.length) await revokeTokens(input.productId);
  }
}

/** Always runs last: stops the sandbox and revokes the build tokens. Never throws, so it can't mask the outcome. */
export async function cleanupStep(input: {
  buildId: string;
  productId: string | null;
  sandboxName: string | null;
}): Promise<void> {
  "use step";
  if (input.productId) {
    await revokeTokens(input.productId, "build").catch((err) => console.error("[cleanup] revoke", err));
  }
  if (input.sandboxName) {
    try {
      await sandbox.hibernate(input.sandboxName);
    } catch (err) {
      console.error("[cleanup] hibernate", err);
      await emit(input.buildId, { type: "log", text: "The sandbox did not stop cleanly. It will time out on its own." }).catch(
        () => undefined,
      );
    }
  }
}
cleanupStep.maxRetries = stepRetries("hibernate");

// ---------------------------------------------------------------------------------------------------------------
// Brief and product

export interface BriefSummary {
  verdict: Brief["verdict"];
  refusal: string | null;
  name: string;
  tagline: string;
  model: BuildModel;
}

function summarize(brief: Brief): BriefSummary {
  return {
    verdict: brief.verdict,
    refusal: brief.refusal,
    name: brief.name,
    tagline: brief.tagline,
    model: pickBuildModel(brief.complexity, { buildModel: env.buildModel, complexBuildModel: env.complexBuildModel }),
  };
}

/** Writes the brief with the brief model (env.briefModel) and saves it. A retry after the brief was saved reuses it. */
export async function briefStep(buildId: string): Promise<BriefSummary> {
  "use step";
  const build = await loadBuild(buildId);
  if (build.brief) return summarize(build.brief);
  const inspiration = await loadInspiration(build.inspirationId);
  const result = await writeBrief({
    note: inspiration.note,
    references: inspiration.references,
    rebuildOf: rebuildTargetFor(build.rebuildOf),
  }).catch(async (err: unknown) => {
    // A brief that failed both attempts still cost something. Record it before the step retries.
    if (err instanceof StructuredOutputError) await chargeBrief(buildId, err.usage);
    throw err;
  });
  await chargeBrief(buildId, result.usage);
  const summary = summarize(result.brief);
  await db()
    .update(schema.builds)
    .set({ brief: result.brief, buildModel: summary.model })
    .where(eq(schema.builds.id, buildId));
  for (const t of result.transcripts) {
    await emit(buildId, { type: "log", text: `Voice memo ${t.index + 1}: ${t.text}` });
  }
  await emit(buildId, { type: "brief", brief: result.brief });
  return summary;
}
briefStep.maxRetries = stepRetries("brief");

export interface ProductRef {
  productId: string;
  slug: string;
}

/**
 * Creates the product row (status building) with a unique slug from the brief and links the build to it. Idempotent:
 * a retry returns the product an earlier attempt created.
 */
export async function createProductStep(buildId: string): Promise<ProductRef> {
  "use step";
  const build = await loadBuild(buildId);
  if (build.productId) {
    const existing = await loadProduct(build.productId);
    return { productId: existing.id, slug: existing.slug };
  }
  const brief = requireBrief(build);
  const base = normalizeSlug(brief.slug);
  const prefix = base.slice(0, SLUG_MAX - 6);
  for (let tries = 0; tries < 6; tries++) {
    const taken = await db()
      .select({ slug: schema.products.slug })
      .from(schema.products)
      .where(sql`${schema.products.slug} like ${`${prefix}%`}`);
    const slug = nextFreeSlug(
      base,
      taken.map((t) => t.slug),
    );
    const productId = randomUUID();
    try {
      await db().batch([
        db().insert(schema.products).values({
          id: productId,
          slug,
          name: brief.name,
          tagline: brief.tagline,
          ownerId: build.userId,
          inspirationId: build.inspirationId,
          rebuildOf: build.rebuildOf,
          status: "building",
        }),
        db().update(schema.builds).set({ productId }).where(eq(schema.builds.id, buildId)),
      ]);
      return { productId, slug };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error("Could not find a free product slug.");
}
createProductStep.maxRetries = stepRetries("provision");

/** Fixture files for the product's tests. Failure is not fatal: Muse Code makes its own fixtures (AGENTS.md). */
export async function fixturesStep(buildId: string): Promise<PreparedFixture[]> {
  "use step";
  const build = await loadBuild(buildId);
  const inspiration = await loadInspiration(build.inspirationId);
  try {
    const result = await prepareFixtures({
      buildId,
      brief: requireBrief(build),
      references: inspiration.references,
    });
    await charge(
      { source: "platform", endpoint: "images/generations", buildId, productId: build.productId },
      result.usage,
      "Fixtures",
    );
    return result.fixtures;
  } catch (err) {
    if (attempt() <= stepRetries("provision")) throw err;
    console.error("[fixtures]", err);
    await emit(buildId, { type: "log", text: "Fixtures could not be prepared. Muse Code will make its own." });
    return [];
  }
}
fixturesStep.maxRetries = stepRetries("provision");

// ---------------------------------------------------------------------------------------------------------------
// Sandbox

export interface SandboxRef {
  sandboxName: string;
  sessionId: string;
  /** inspo/ paths of the image references, for `muse exec --image`. */
  images: string[];
}

/**
 * Mints the build token and provisions the sandbox in one step, so the plaintext token stays inside it. Also fixes
 * the Muse Code session id (a fresh UUID, reused on retry).
 */
export async function provisionStep(input: {
  buildId: string;
  productId: string;
  slug: string;
  fixtures: PreparedFixture[];
}): Promise<SandboxRef> {
  "use step";
  const build = await loadBuild(input.buildId);
  const brief = requireBrief(build);
  const inspiration = await loadInspiration(build.inspirationId);
  const promptMarkdown = renderBuildPrompt(brief, {
    inspoFiles: inspiration.references.map((r) => r.fileName),
    fixtures: input.fixtures.map((f) => ({ fileName: f.fileName, description: f.description, fromUserSample: f.fromUserSample })),
    maxModelSteps: MAX_MODEL_STEPS,
    rebuildOf: rebuildTargetFor(build.rebuildOf),
    ...sessionNotes(),
  });
  const allowedModels = allowedModelsFor(brief);
  const { token } = await mintToken({
    productId: input.productId,
    scope: "build",
    allowedModels,
    dailyBudgetUsd: buildTokenBudgetFor(),
    ttlHours: BUILD_TOKEN_TTL_HOURS,
  });
  const { sandboxName } = await sandbox.provisionSandbox({
    buildId: input.buildId,
    productId: input.productId,
    slug: input.slug,
    references: inspiration.references,
    fixtures: input.fixtures.map((f) => ({ fileName: f.fileName, url: f.url })),
    promptMarkdown,
    buildToken: token,
    gatewayUrl: env.gatewayUrl,
  });
  const sessionId = build.museSessionId ?? randomUUID();
  await db().batch([
    db().update(schema.builds).set({ sandboxName, museSessionId: sessionId }).where(eq(schema.builds.id, input.buildId)),
    db()
      .update(schema.products)
      .set({ sandboxName, updatedAt: new Date() })
      .where(eq(schema.products.id, input.productId)),
  ]);
  return { sandboxName, sessionId, images: museImagePaths(inspiration.references) };
}
provisionStep.maxRetries = stepRetries("provision");

export interface MuseRun {
  cmdId: string;
  logPath: string;
  /** The engine the round runs on (lib/sandbox/bridge-protocol.ts). Runs started before engines existed are exec. */
  engine?: MuseEngine;
}

/**
 * The build a Muse Code start belongs to, for its goal and its build MCP token: the newest one in this sandbox and
 * session that hasn't finished. Null when it can't be found, and the start goes on without both.
 */
async function startingBuild(sandboxName: string, sessionId: string): Promise<{ id: string; brief: Brief | null } | null> {
  try {
    const [row] = await db()
      .select({ id: schema.builds.id, brief: schema.builds.brief, productId: schema.builds.productId })
      .from(schema.builds)
      .where(
        and(
          eq(schema.builds.sandboxName, sandboxName),
          eq(schema.builds.museSessionId, sessionId),
          notInArray(schema.builds.status, [...TERMINAL_STATUSES]),
        ),
      )
      .orderBy(desc(schema.builds.startedAt))
      .limit(1);
    if (!row) return null;
    return { id: row.id, brief: row.brief ?? (row.productId ? await latestBrief(row.productId) : null) };
  } catch (err) {
    console.warn(`[muse] the build for ${sandboxName} wasn't found: ${String(err)}`);
    return null;
  }
}

/**
 * Starts one Muse Code round, on the engine MUSE_ENGINE names (lib/sandbox/builder.ts startMuse). A serve round gets
 * the brief's goal (goalObjective). Never retried: a retry could start a second run in the same session. When the
 * round runs on another engine than it asked for, or under MUSE_FULL, the build room gets a line saying how it runs.
 */
export async function startMuseStep(input: {
  sandboxName: string;
  sessionId: string;
  promptFile: string;
  images: string[];
  model: BuildModel;
  round: number;
  /** The build, when the workflow has it at hand. Otherwise it is looked up when the round needs it. */
  buildId?: string;
}): Promise<MuseRun> {
  "use step";
  const engine = env.museEngine;
  const full = env.museFull;
  // Today's exec round needs neither the goal nor the build, so it makes no extra query.
  const build = engine === "serve" || full ? await startingBuild(input.sandboxName, input.sessionId) : null;
  const buildId = input.buildId ?? build?.id;
  const started = await sandbox.startMuse({
    sandboxName: input.sandboxName,
    sessionId: input.sessionId,
    promptFile: input.promptFile,
    images: input.images,
    model: input.model,
    round: input.round,
    maxModelSteps: MAX_MODEL_STEPS,
    engine,
    goal: build?.brief ? goalObjective(build.brief) : null,
    ...(buildId ? { buildId } : {}),
  });
  const how = museRunLine(started, full, env.museAgentCapacity);
  if (how && buildId) {
    await emit(buildId, { type: "log", text: how }).catch((err: unknown) => console.warn(`[muse] build room line: ${String(err)}`));
  }
  return { cmdId: started.cmdId, logPath: started.logPath, engine: started.engine };
}
startMuseStep.maxRetries = stepRetries("build");

/**
 * The build room's line on how a round runs: its engine, why it didn't get the one it asked for, and, under MUSE_FULL,
 * what Muse Code has. Null for a plain exec round, which reads as it always has.
 */
export function museRunLine(started: { engine: MuseEngine; notice?: string; buildMcp?: boolean }, full: boolean, capacity: number): string | null {
  const parts: string[] = [];
  if (started.notice) parts.push(started.notice);
  else if (started.engine === "serve") parts.push("Muse Code runs this round on its session host, so its owner can steer it.");
  else if (full) parts.push("Muse Code runs this round with muse exec.");
  if (full) {
    parts.push(`It has ${capacity} agent ${capacity === 1 ? "slot" : "slots"}, every reminder and the platform's hooks${started.buildMcp ? " and build tools" : ""}.`);
  }
  return parts.length ? parts.join(" ") : null;
}

/**
 * Puts the Muse Code round running now on the build row, numbered as its log and mailbox are (bridgePaths), so the
 * owner's controls know where to send, or takes it off with null. Returns whether the owner asked to stop, read in the
 * same update (ownerStopped). Does nothing while steering is off.
 */
export async function museRoundStep(buildId: string, round: number | null): Promise<boolean> {
  "use step";
  if (!env.steeringEnabled) return false;
  return ownerStopped(buildId, { museRound: round });
}
museRoundStep.maxRetries = 2;

export interface MusePollResult {
  done: boolean;
  exitCode: number | null;
  offset: number;
  /** True once some of this run's usage has been recorded. Pass it to the next poll. */
  usageRecorded: boolean;
  /** Helper agents the build room has heard about in this run. Pass it to the next poll. */
  announced?: string[];
  /** run.usage's children_included once a poll has read it, else null. Pass it to the next poll. */
  childrenIncluded?: boolean | null;
  /** The session bridge's condenser state, on a serve round. Pass it to the next poll. */
  bridgeState?: BridgeCondenseState;
  /** True once the build's owner pressed Stop. The workflow then ends the build instead of going on. */
  stopRequested?: boolean;
}

/**
 * Reads new Muse Code output, streams it to the build room, and records the round's usage in whichever poll reads it.
 * Muse Code writes run.usage once per run, near its end, and a poll can read it before the process has exited, so it
 * is not tied to `done`. Each poll reads new bytes only, so every run.usage it reads is charged once, and charge() drops
 * rows a retried attempt already wrote. One `muse exec` can hold more than one run (a workflow's completion comes as a
 * second run).
 *
 * run.usage counts only the main agent (children_included: false). The poll that reports done also reads Muse Code's
 * session log, which has the reminder agents', subagents' and workflow agents' calls too: those are charged under their
 * own endpoint, unless run.usage said it includes them or didn't say (Condensed.childrenIncluded), so they are never
 * charged twice. `childrenIncluded` carries over between polls. The main agent's calls in runs that never wrote
 * run.usage (one stopped at its cap, and every round on the session bridge, which has none) are charged from that log.
 *
 * While steering is on, each poll also reads the owner's Stop, and the poll that reports done takes the run's round
 * off the build row in the same update, so a stop sent just as the run ends is never missed.
 */
export async function pollMuseStep(input: {
  buildId: string;
  productId: string;
  sandboxName: string;
  run: MuseRun;
  offset: number;
  /** The build room's round: 0 for the first run of a build, then the fix number. */
  round: number;
  usageRecorded?: boolean;
  announced?: string[];
  childrenIncluded?: boolean | null;
  bridgeState?: BridgeCondenseState;
}): Promise<MusePollResult> {
  "use step";
  const engine = input.run.engine ?? "exec";
  const poll = await sandbox.pollMuse({
    sandboxName: input.sandboxName,
    cmdId: input.run.cmdId,
    logPath: input.run.logPath,
    offset: input.offset,
    announced: input.announced,
    childrenIncluded: input.childrenIncluded,
    engine,
    bridgeState: input.bridgeState,
  });
  if (poll.lines.length) await emit(input.buildId, { type: "muse", lines: poll.lines, round: input.round });
  const endpoint = engine === "serve" ? "muse serve" : "muse exec";
  const ctx = { source: "muse_code" as const, endpoint, buildId: input.buildId, productId: input.productId };
  const what = input.round === 0 ? "Muse Code build" : `Muse Code round ${input.round}`;
  const fresh = poll.usage.length > 0;
  if (fresh) await charge(ctx, poll.usage, what);
  const fromLog = poll.session?.unreported.usage ?? [];
  if (fromLog.length) await charge(ctx, fromLog, what);
  const childrenIncluded = poll.childrenIncluded ?? input.childrenIncluded ?? null;
  const children = childrenIncluded === true ? undefined : poll.session?.children;
  if (children?.usage.length) {
    await charge({ ...ctx, endpoint: `${endpoint} children` }, children.usage, `${what}: ${ownersLabel(children.owners)}`);
  }
  const stopRequested = env.steeringEnabled ? await ownerStopped(input.buildId, poll.done ? { museRound: null } : undefined) : false;
  return {
    done: poll.done,
    exitCode: poll.exitCode,
    offset: poll.offset,
    usageRecorded: Boolean(input.usageRecorded) || fresh || fromLog.length > 0,
    announced: poll.announced,
    childrenIncluded,
    ...(poll.bridgeState ? { bridgeState: poll.bridgeState } : {}),
    stopRequested,
  };
}
pollMuseStep.maxRetries = 2;

export async function killStep(sandboxName: string, cmdId: string): Promise<void> {
  "use step";
  await sandbox.killCommand(sandboxName, cmdId);
}
killStep.maxRetries = 2;

export async function previewStep(buildId: string, sandboxName: string): Promise<string> {
  "use step";
  const { url } = await sandbox.startPreview(sandboxName);
  await db().update(schema.builds).set({ previewUrl: url }).where(eq(schema.builds.id, buildId));
  await emit(buildId, { type: "preview", url });
  return url;
}
previewStep.maxRetries = stepRetries("preview");

/** Starts the verify or demo task (lib/sandbox/tasks.ts). Never retried, so two runs never overlap. */
export async function startTaskStep(sandboxName: string, task: sandbox.SandboxTask): Promise<string> {
  "use step";
  const { cmdId } = await sandbox.startTask(sandboxName, task);
  return cmdId;
}
startTaskStep.maxRetries = 0;

/** startTaskStep with `env` exported for the task, like MUSEMUSE_SCREEN_CHECK=warn for a new build's last verify. */
export async function startTaskWithEnvStep(sandboxName: string, task: sandbox.SandboxTask, env: Record<string, string>): Promise<string> {
  "use step";
  const { cmdId } = await sandbox.startTask(sandboxName, task, env);
  return cmdId;
}
startTaskWithEnvStep.maxRetries = 0;

export interface TaskPollResult {
  done: boolean;
  exitCode: number | null;
  /** Only filled in once the task is done, to keep the event log small. */
  outputTail: string;
}

export async function pollTaskStep(sandboxName: string, cmdId: string): Promise<TaskPollResult> {
  "use step";
  const poll = await sandbox.pollTask(sandboxName, cmdId);
  return { done: poll.done, exitCode: poll.exitCode, outputTail: poll.done ? poll.outputTail : "" };
}
pollTaskStep.maxRetries = 2;

export interface VerifyResult {
  passed: boolean;
  steps: Array<{ name: string; ok: boolean }>;
  screenshots: Screenshot[];
}

/** Parses verify's summary line, uploads the judge screenshots, and tells the build room. */
export async function collectVerifyStep(input: {
  buildId: string;
  sandboxName: string;
  round: number;
  exitCode: number | null;
  outputTail: string;
}): Promise<VerifyResult> {
  "use step";
  const { summary, screenshots } = await sandbox.collectVerifyResult(input);
  await emit(input.buildId, { type: "verify", round: input.round, summary, screenshots });
  return {
    passed: summary.passed,
    steps: summary.steps.map((s) => ({ name: s.name, ok: s.ok })),
    screenshots,
  };
}
collectVerifyStep.maxRetries = 1;

/** Records a verify run that hit its time cap as a failed check, so the fix round sees why. */
export async function verifyTimedOutStep(input: { buildId: string; round: number; minutes: number }): Promise<VerifyResult> {
  "use step";
  const summary: VerifySummary = {
    passed: false,
    steps: [],
    failureOutput: `npm run verify did not finish within ${input.minutes} minutes and was stopped. Look for a test or server that hangs.`,
  };
  await emit(input.buildId, { type: "verify", round: input.round, summary, screenshots: [] });
  return { passed: false, steps: [], screenshots: [] };
}

/**
 * The references the judge sees, in the order the brief indexes them. A refinement's own muse holds only its new
 * files, so it gets the product's original references first and the new ones after them.
 */
async function judgeReferences(build: { kind: "build" | "refine"; inspirationId: string }, productId: string): Promise<Reference[]> {
  const own = (await loadInspiration(build.inspirationId)).references;
  if (build.kind !== "refine") return own;
  const product = await loadProduct(productId);
  const original = product.inspirationId ? (await loadInspiration(product.inspirationId)).references : [];
  return [...original, ...own];
}

/** The judge model (env.judgeModel) checks the screenshots against the brief and the image inspo. */
export async function judgeStep(input: {
  buildId: string;
  productId: string;
  round: number;
  screenshots: Screenshot[];
}): Promise<JudgeCall> {
  "use step";
  const build = await loadBuild(input.buildId);
  // Refine rows get the product's brief in loadRefineStep. Older ones fall back to the first build's, as deploy does.
  const brief = build.brief ?? (await latestBrief(input.productId));
  if (!brief) throw new FatalError("This build has no brief yet.");
  const ctx: UsageContext & { buildId: string } = {
    source: "platform",
    endpoint: "responses",
    buildId: input.buildId,
    productId: input.productId,
  };
  const what = input.round === 0 ? "Judge" : `Judge round ${input.round}`;
  const result = await judgeBuild({
    brief,
    references: await judgeReferences(build, input.productId),
    screenshots: input.screenshots,
  }).catch(async (err: unknown) => {
    // A judge call that failed both attempts still cost something.
    if (err instanceof StructuredOutputError) await charge(ctx, err.usage, what);
    throw err;
  });
  await charge(ctx, result.usage, what);
  await emit(input.buildId, { type: "judge", round: input.round, verdict: result.verdict });
  return { pass: result.verdict.pass, blocking: result.verdict.blocking };
}
judgeStep.maxRetries = 1;

function isVerifyEvent(p: BuildEventBody): p is Extract<BuildEventBody, { type: "verify" }> {
  return p.type === "verify";
}

function isJudgeEvent(p: BuildEventBody): p is Extract<BuildEventBody, { type: "judge" }> {
  return p.type === "judge";
}

export interface FixPrompt {
  promptFile: string;
  /** The judge's screenshots copied into the product (.muse-fix/), for --image on the fix run. Empty when it didn't run. */
  images: string[];
}

/**
 * Renders fix-<n>.md from the last verify and judge results (read back from the build's events, so they never pass
 * through the workflow log) and writes it into the product. When the judge ran, the screenshots it saw are copied in
 * too, so the resumed Muse Code session gets them as images.
 */
export async function writeFixPromptStep(input: {
  buildId: string;
  sandboxName: string;
  /** The fix number, 1 to MAX_FIX_ROUNDS. */
  fix: number;
  /** The build-room round whose results this fix answers. */
  verifiedRound: number;
}): Promise<FixPrompt> {
  "use step";
  const rows = await db()
    .select({ payload: schema.buildEvents.payload })
    .from(schema.buildEvents)
    .where(and(eq(schema.buildEvents.buildId, input.buildId), inArray(schema.buildEvents.type, ["verify", "judge"])))
    .orderBy(desc(schema.buildEvents.id))
    .limit(20);
  const payloads = rows.map((r) => r.payload);
  const verified = payloads.filter(isVerifyEvent).find((p) => p.round === input.verifiedRound);
  const verify: VerifySummary | null = verified?.summary ?? null;
  const judge: JudgeVerdict | null =
    payloads.filter(isJudgeEvent).find((p) => p.round === input.verifiedRound)?.verdict ?? null;
  // The judge only runs once verify passes, on that verify's screenshots. They help but aren't needed, so a fix round
  // whose screenshots can't be copied goes on without them.
  const judged = judge ? pickScreenshots(verified?.screenshots ?? []) : [];
  const images = judged.length
    ? await sandbox.writeFixScreenshots(input.sandboxName, input.fix, judged).catch((err: unknown) => {
        console.warn(`fix ${input.fix} screenshots for build ${input.buildId}: ${String(err)}`);
        return [];
      })
    : [];
  const promptFile = `fix-${input.fix}.md`;
  await sandbox.writeProductFile(
    input.sandboxName,
    promptFile,
    renderFixPrompt({ verify, judge, round: input.fix, screenshots: images, ...sessionNotes() }),
  );
  return { promptFile, images };
}
writeFixPromptStep.maxRetries = 2;

/**
 * The URL a product's demo shows in its window: the live URL it already has (a refinement), else the one its first
 * deploy will get (lib/publish/vercel.ts names the project), else none, when publishing is off.
 */
function demoUrlFor(product: { slug: string; liveUrl: string | null }, publishOff: string | null): string | null {
  if (product.liveUrl) return product.liveUrl;
  return publishOff ? null : `https://${projectNameFor(product.slug)}.vercel.app`;
}

/**
 * Writes Demo Studio's spec into the sandbox before the demo starts: the product's name and tagline, its models by
 * display name (from the brief, or the manifest when there is none) and the URL from demoUrlFor.
 */
export async function demoSpecStep(input: {
  buildId: string;
  productId: string;
  sandboxName: string;
  title: string;
  tagline: string;
}): Promise<void> {
  "use step";
  const build = await loadBuild(input.buildId);
  const product = await loadProduct(input.productId);
  const brief = build.brief ?? (await latestBrief(input.productId));
  const models = brief ? brief.capabilities.map((c) => c.model) : (product.manifest?.models ?? []).map((m) => m.id);
  await sandbox.writeDemoSpec(input.sandboxName, {
    title: input.title,
    tagline: input.tagline,
    models: [...new Set(models)].map(modelLabel),
    url: demoUrlFor(product, env.publishOffReason),
  });
}
demoSpecStep.maxRetries = 2;

/** Uploads the demo video and its poster, and tells the build room. */
export async function finishDemoStep(input: {
  buildId: string;
  sandboxName: string;
  title: string;
  subtitle: string;
}): Promise<sandbox.DemoVideo> {
  "use step";
  const demo = await sandbox.finishDemo(input);
  if (demo.videoUrl) await emit(input.buildId, { type: "recording", url: demo.videoUrl, posterUrl: demo.posterUrl });
  return demo;
}
finishDemoStep.maxRetries = stepRetries("record");

// ---------------------------------------------------------------------------------------------------------------
// Deploy and register

export interface DeployStart {
  projectId: string;
  deploymentId: string;
  liveTokenId: string;
}

/**
 * Mints the live token and starts the deployment in one step, so the plaintext token only travels to Vercel's env.
 * Saves the project id right away so a retry or a later refinement reuses the project.
 */
/** Why the product won't be published (env.publishOffReason), or null when it will be. */
export async function publishOffStep(): Promise<string | null> {
  "use step";
  return env.publishOffReason;
}

export async function startDeployStep(input: {
  buildId: string;
  productId: string;
  sandboxName: string;
}): Promise<DeployStart> {
  "use step";
  const build = await loadBuild(input.buildId);
  const product = await loadProduct(input.productId);
  const brief = build.brief ?? (await latestBrief(input.productId));
  const live = await mintToken({
    productId: input.productId,
    scope: "live",
    allowedModels: brief ? allowedModelsFor(brief) : await liveModels(input.productId),
    // Room for about 20 runs a day at the brief's estimate (Muse Wonder runs cost more than Spark's did).
    dailyBudgetUsd: liveTokenDailyBudgetFor(brief?.estimatedCostPerRunUsd),
  });
  const started = await startDeployFromSandbox({
    sandboxName: input.sandboxName,
    slug: product.slug,
    productName: product.name,
    env: { GATEWAY_URL: env.gatewayUrl, PRODUCT_TOKEN: live.token },
    projectId: product.vercelProjectId,
  });
  await db()
    .update(schema.products)
    .set({ vercelProjectId: started.projectId, updatedAt: new Date() })
    .where(eq(schema.products.id, input.productId));
  return { projectId: started.projectId, deploymentId: started.deploymentId, liveTokenId: live.id };
}
startDeployStep.maxRetries = stepRetries("deploy");

/** The brief of the product's first build, for refinements (loadRefineStep copies it; older refine rows have none). */
async function latestBrief(productId: string): Promise<Brief | null> {
  const [row] = await db()
    .select({ brief: schema.builds.brief })
    .from(schema.builds)
    .where(and(eq(schema.builds.productId, productId), eq(schema.builds.kind, "build")))
    .orderBy(desc(schema.builds.startedAt))
    .limit(1);
  return row?.brief ?? null;
}

/**
 * Fallback allowlist: whatever the product's current live token allows. Only products from before briefs were stored
 * get here, and those were built on Muse Spark 1.3, so a product with no live token keeps that id. The gateway serves it
 * with Spark 1.3 Contributor (lib/meta/spark.ts), since Spark 1.3 itself is never used.
 */
async function liveModels(productId: string): Promise<string[]> {
  const [row] = await db()
    .select({ allowedModels: schema.gatewayTokens.allowedModels })
    .from(schema.gatewayTokens)
    .where(and(eq(schema.gatewayTokens.productId, productId), eq(schema.gatewayTokens.scope, "live")))
    .orderBy(desc(schema.gatewayTokens.createdAt))
    .limit(1);
  return row?.allowedModels ?? ["muse-spark-1.3"];
}

export async function pollDeployStep(deploymentId: string): Promise<DeployPoll> {
  "use step";
  return pollDeploy(deploymentId);
}
pollDeployStep.maxRetries = 2;

/**
 * Saves what shipped: manifest, live URL, demo, transcript and status. Then revokes the build tokens and every live
 * token except the one the new deployment uses. A product an admin turned off while it built stays "disabled": the
 * gateway refuses its tokens, so the new deployment stays off until an admin turns it back on.
 */
export async function registerStep(input: {
  buildId: string;
  productId: string;
  sandboxName: string;
  sessionId: string;
  /** All three are null when publishing is off (publishOffStep). */
  projectId: string | null;
  liveUrl: string | null;
  liveTokenId: string | null;
  demoVideoUrl: string | null;
  /** Saved with a new demo video, null included, so an older poster never sits on a newer video. */
  demoPosterUrl?: string | null;
  status: "live" | "partial";
}): Promise<void> {
  "use step";
  const manifest = await sandbox.readManifest(input.sandboxName);
  let transcriptUrl: string | null = null;
  try {
    const transcript = await sandbox.exportTranscript({
      sandboxName: input.sandboxName,
      sessionId: input.sessionId,
      buildId: input.buildId,
    });
    transcriptUrl = transcript.url;
    if (transcript.highlights.length) {
      await emit(input.buildId, { type: "log", text: `How it was built:\n${transcript.highlights.slice(0, 20).join("\n")}` });
    }
  } catch (err) {
    console.error("[register] transcript", err);
  }
  const [saved] = await db()
    .update(schema.products)
    .set({
      ...(manifest ? { manifest } : {}),
      ...(input.demoVideoUrl ? { demoVideoUrl: input.demoVideoUrl, demoPosterUrl: input.demoPosterUrl ?? null } : {}),
      ...(transcriptUrl ? { transcriptUrl } : {}),
      liveUrl: input.liveUrl,
      status: sql<ProductStatus>`case when ${schema.products.status} = 'disabled' then 'disabled' else ${input.status} end`,
      latestBuildId: input.buildId,
      sandboxName: input.sandboxName,
      museSessionId: input.sessionId,
      vercelProjectId: input.projectId,
      updatedAt: new Date(),
    })
    .where(eq(schema.products.id, input.productId))
    .returning({ status: schema.products.status });
  if (saved?.status === "disabled") {
    await emit(input.buildId, {
      type: "log",
      text: "An admin turned this product off while it was building, so it stays off until an admin turns it back on.",
    });
  }
  await revokeTokens(input.productId, "build");
  await revokeLiveTokensExcept(input.productId, input.liveTokenId);
}
registerStep.maxRetries = stepRetries("register");

// ---------------------------------------------------------------------------------------------------------------
// Refinements

export interface RefineContext {
  productId: string;
  name: string;
  tagline: string;
  sandboxName: string;
  sessionId: string;
  model: BuildModel;
  /** 1 for the product's first refinement, 2 for the next, and so on. */
  refineIndex: number;
}

/**
 * Checks a change request against the brief writer's refusal policy before anything resumes. Returns the refusal for
 * the person, or null when the change may go ahead. A check that can't get a valid reply throws, so the change never
 * goes through unchecked.
 */
export async function refineCheckStep(buildId: string): Promise<{ refusal: string | null }> {
  "use step";
  const build = await loadBuild(buildId);
  const inspiration = await loadInspiration(build.inspirationId);
  const ctx: UsageContext & { buildId: string } = {
    source: "platform",
    endpoint: "responses",
    buildId,
    productId: build.productId,
  };
  const result = await checkChange({
    message: build.message ?? inspiration.note ?? "",
    references: inspiration.references,
  }).catch(async (err: unknown) => {
    if (err instanceof StructuredOutputError) await charge(ctx, err.usage, "Change check");
    throw err;
  });
  await charge(ctx, result.usage, "Change check");
  return { refusal: result.refusal };
}
refineCheckStep.maxRetries = stepRetries("brief");

/**
 * Loads what a refinement resumes: the product's sandbox, Muse Code session and build model. Also copies the product's
 * brief onto the refine row, so the judge, the product page and the gallery always have one for the shipped build.
 */
export async function loadRefineStep(buildId: string): Promise<RefineContext> {
  "use step";
  const build = await loadBuild(buildId);
  if (build.kind !== "refine" || !build.productId) throw new FatalError("This build is not a refinement.");
  const product = await loadProduct(build.productId);
  if (!product.sandboxName || !product.museSessionId) {
    throw new FatalError("This product has no sandbox or Muse Code session to resume.");
  }
  const [{ n } = { n: 1 }] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.builds)
    .where(
      and(
        eq(schema.builds.productId, product.id),
        eq(schema.builds.kind, "refine"),
        lte(schema.builds.startedAt, build.startedAt),
      ),
    );
  const [previous] = await db()
    .select({ buildModel: schema.builds.buildModel })
    .from(schema.builds)
    .where(and(eq(schema.builds.productId, product.id), eq(schema.builds.kind, "build")))
    .orderBy(desc(schema.builds.startedAt))
    .limit(1);
  // The session resumes on the model that started it, never on today's default: a Spark session never goes to Wonder.
  const model = refineBuildModel(previous?.buildModel);
  const brief = build.brief ?? (await latestBrief(product.id));
  await db()
    .update(schema.builds)
    .set({
      sandboxName: product.sandboxName,
      museSessionId: product.museSessionId,
      buildModel: model,
      ...(brief ? { brief } : {}),
    })
    .where(eq(schema.builds.id, buildId));
  return {
    productId: product.id,
    name: product.name,
    tagline: product.tagline,
    sandboxName: product.sandboxName,
    sessionId: product.museSessionId,
    model,
    refineIndex: Math.max(1, Number(n)),
  };
}

/**
 * Resumes the product's sandbox with a fresh build token (minted here, never returned), copies the new references
 * in, and writes refine-<n>.md. Returns the prompt file and the new image paths for --image.
 */
export async function reopenStep(input: {
  buildId: string;
  productId: string;
  sandboxName: string;
  refineIndex: number;
}): Promise<{ promptFile: string; images: string[] }> {
  "use step";
  const build = await loadBuild(input.buildId);
  const inspiration = await loadInspiration(build.inspirationId);
  const brief = build.brief ?? (await latestBrief(input.productId));
  const allowedModels = brief ? allowedModelsFor(brief) : await liveModels(input.productId);
  const { token } = await mintToken({
    productId: input.productId,
    scope: "build",
    allowedModels,
    dailyBudgetUsd: buildTokenBudgetFor(),
    ttlHours: BUILD_TOKEN_TTL_HOURS,
  });
  const newReferences: Reference[] = inspiration.references;
  await sandbox.reopenSandbox({
    sandboxName: input.sandboxName,
    productId: input.productId,
    buildToken: token,
    gatewayUrl: env.gatewayUrl,
    newReferences,
  });
  const prompt = renderRefinePrompt({
    message: build.message ?? inspiration.note ?? "",
    newReferences: newReferences.map((r) => ({
      fileName: r.fileName,
      describes: `${/^[aeiou]/.test(r.kind) ? "An" : "A"} ${r.kind === "pdf" ? "PDF" : r.kind} the user attached with this change (inspo/${r.fileName}).`,
    })),
    ...sessionNotes(),
  });
  const promptFile = `refine-${input.refineIndex}.md`;
  await sandbox.writeProductFile(input.sandboxName, promptFile, prompt);
  return {
    promptFile,
    images: museImagePaths(newReferences),
  };
}
reopenStep.maxRetries = stepRetries("provision");
