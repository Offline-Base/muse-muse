/**
 * The Prove it stage's steps (docs/PRODUCT_OUTPUTS.md). They run after the build is final, in a throwaway copy of its
 * sandbox. Nothing here touches the build's status or the product, so no failure here can reach Live.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { addBuildCost, emit } from "@/lib/events";
import { failureMessage } from "@/lib/pipeline/logic";
import { charge } from "@/lib/pipeline/build-steps";
import { publicActions, skillName } from "@/lib/outputs/generate";
import { OUTPUT_LABEL } from "@/lib/outputs/labels";
import { PROVE_SCENE_SOURCE } from "@/lib/outputs/assets-source";
import {
  describeResult,
  generatedFilesFor,
  judgeSkillTest,
  NIGHTLY_MODEL,
  parseProveResults,
  planChecks,
  PROVE_MODEL,
  PROVED_OUTPUTS,
  sceneFor,
  skillScene,
  skillTestCall,
  skillTestFacts,
  skillTestPrompt,
  SKILL_TEST_MAX_STEPS,
  SKILL_TEST_RESERVE_USD,
  studioSpecFor,
  videoCaption,
  type ProveCall,
  type ProvedOutput,
  type ProveRunSpec,
} from "@/lib/outputs/prove";
import { parseManifest } from "@/lib/format";
import type { ProveOrigin } from "@/lib/pipeline/prove-types";
import * as sandbox from "@/lib/sandbox/builder";
import { newSessionId } from "@/lib/sandbox/muse";
import { DEMO_RECORDING_DIR, PRODUCT_DIR } from "@/lib/sandbox/paths";
import { publicHost } from "@/lib/sandbox/policy";
import { PROVE_CHECKS_ARGV, proveCheckFiles, PROVE_CONFIG, PROVE_DIR, proveConfigFile, proveRecordScript, PROVE_SKILL_DIR, PROVE_SPEC, proveSpecFile } from "@/lib/sandbox/prove-tasks";
import { platformSpendToday } from "@/lib/usage";
import type { BuildModel } from "@/lib/sandbox/muse";
import type { ProveEventBody } from "@/lib/types";

/** What each step needs, passed along by the workflow. */
export interface ProveCtx {
  buildId: string;
  productId: string;
  runId: string;
  origin: ProveOrigin;
  /** The throwaway copy. */
  copy: string;
  slug: string;
  name: string;
  liveUrl: string;
  site: string;
  capUsd: number;
  model: BuildModel;
  /** Nightly re-checks record no video. */
  record: boolean;
  /** When the run started, ISO. The product's usage since then is what its calls cost. */
  since: string;
}

/** What a step has said about an output so far. A later event must repeat it. */
export type ProveSummary = Pick<ProveEventBody, "state" | "title" | "detail">;

const say = (ctx: Pick<ProveCtx, "buildId" | "runId" | "origin">, item: ProveEventBody["item"], body: Pick<ProveEventBody, "state" | "title"> & Partial<ProveEventBody>) =>
  emit(ctx.buildId, { type: "prove", runId: ctx.runId, origin: ctx.origin, item, ...body });

/**
 * Says a run is coming, before the build's final status, so the room's stream stays open for it. It writes one event and
 * has no retries: the workflow goes on to Live whatever happens here. Null when there is nothing to prove, such as a local
 * run with no live link.
 */
export async function provePlanStep(buildId: string): Promise<string | null> {
  "use step";
  const [row] = await db()
    .select({ liveUrl: schema.products.liveUrl })
    .from(schema.builds)
    .innerJoin(schema.products, eq(schema.builds.productId, schema.products.id))
    .where(eq(schema.builds.id, buildId))
    .limit(1);
  if (!row?.liveUrl) return null;
  const runId = randomUUID();
  await say({ buildId, runId, origin: "ship" }, "stage", { state: "planned", title: "Testing what this product comes with" });
  return runId;
}
provePlanStep.maxRetries = 0;

/** Says the run ended early, without a copy to clean up. Never throws. */
export async function proveAbandonStep(ctx: Pick<ProveCtx, "buildId" | "runId" | "origin">, message: string): Promise<void> {
  "use step";
  await say(ctx, "stage", { state: "failed", title: "Prove it didn't finish", detail: message.slice(0, 500) }).catch((err) => console.error("[prove] abandon", err));
}
proveAbandonStep.maxRetries = 1;

async function spendPaused(): Promise<boolean> {
  return (await platformSpendToday()) >= env.dailySpendCapUsd;
}

/**
 * Checks there is something to prove, makes the copy and puts in what the run needs. Null, with a line saying why, when
 * the run can't go ahead. No retries, since a retry would make a second copy.
 */
export async function proveOpenStep(input: { buildId: string; runId: string; origin: ProveOrigin }): Promise<ProveCtx | null> {
  "use step";
  const { buildId, runId, origin } = input;
  const skip = async (why: string) => {
    await say({ buildId, runId, origin }, "stage", { state: "skipped", title: "Prove it didn't run", detail: why });
    return null;
  };
  if (!env.proveIt) return skip("Prove it is off.");
  const [row] = await db()
    .select({
      productId: schema.products.id,
      slug: schema.products.slug,
      name: schema.products.name,
      tagline: schema.products.tagline,
      status: schema.products.status,
      liveUrl: schema.products.liveUrl,
      manifest: schema.products.manifest,
      sandboxName: schema.products.sandboxName,
    })
    .from(schema.builds)
    .innerJoin(schema.products, eq(schema.builds.productId, schema.products.id))
    .where(eq(schema.builds.id, buildId))
    .limit(1);
  if (!row) return skip("This build has no product.");
  if ((row.status !== "live" && row.status !== "partial") || !row.liveUrl) return skip("The product isn't live.");
  if (!row.sandboxName) return skip("The product has no sandbox.");
  const manifest = parseManifest(row.manifest);
  if (!publicActions(manifest).length) return skip("This product has no actions to call, so it has no MCP tools, CLI or skill.");
  if (await spendPaused()) return skip("The platform's spending cap for today has been reached.");
  const liveHost = publicHost(row.liveUrl);
  if (!liveHost || !row.liveUrl.startsWith("https://")) return skip("The product's live link can't be reached from a sandbox.");

  const site = env.platformUrl;
  const platformHost = publicHost(site);
  if (!platformHost) return skip("This site isn't public, so a sandbox can't reach its MCP server.");
  const { sandboxName: copy } = await sandbox.forkForProve(row.sandboxName, { liveHost, platformHost });
  try {
    const product = { slug: row.slug, name: row.name, tagline: row.tagline, liveUrl: row.liveUrl, manifest };
    const spec = planChecks({
      product,
      origin: site,
      dir: PROVE_DIR,
      capUsd: env.proveItCapUsd,
      estimatedCostPerRunUsd: manifest?.estimatedCostPerRunUsd ?? 0,
      fetchable: !env.provePutFiles,
    });
    await sandbox.writeProveFiles(copy, [...proveCheckFiles(spec), ...(spec.downloads ? [] : generatedFilesFor(product, site, PROVE_DIR))]);
    const ctx: ProveCtx = {
      buildId,
      productId: row.productId,
      runId,
      origin,
      copy,
      slug: row.slug,
      name: row.name,
      liveUrl: row.liveUrl,
      site,
      capUsd: env.proveItCapUsd,
      model: origin === "nightly" ? NIGHTLY_MODEL : PROVE_MODEL,
      record: origin !== "nightly",
      since: new Date().toISOString(),
    };
    await say(ctx, "stage", { state: "running", title: "Testing what this product comes with" });
    for (const output of PROVED_OUTPUTS) await say(ctx, output, { state: "planned", title: `${OUTPUT_LABEL[output]}: waiting` });
    await say(ctx, "chatgpt", { state: "skipped", title: "ChatGPT: not tested here", detail: "It uses the same MCP server. Only a person with a ChatGPT account can test it." });
    return ctx;
  } catch (err) {
    // The workflow has no name for the copy yet, so nothing else would delete it.
    await sandbox.deleteProveCopy(copy).catch((e: unknown) => console.warn(`[prove] delete ${copy}: ${String(e)}`));
    throw err;
  }
}
proveOpenStep.maxRetries = 0;

export async function proveStartChecksStep(ctx: ProveCtx): Promise<string> {
  "use step";
  for (const output of PROVED_OUTPUTS) {
    if (output !== "skill") await say(ctx, output, { state: "running", title: `${OUTPUT_LABEL[output]}: testing it now` });
  }
  const { cmdId } = await sandbox.startProveCommand(ctx.copy, { tag: "prove-checks", cwd: PROVE_DIR, argv: PROVE_CHECKS_ARGV });
  return cmdId;
}

/** What the product's actions have cost since the run started: every call a run makes goes through the gateway. */
async function actionSpendUsd(ctx: Pick<ProveCtx, "productId" | "since">): Promise<number> {
  const [row] = await db()
    .select({ total: sql<number>`coalesce(sum(${schema.usage.costUsd}), 0)::float8` })
    .from(schema.usage)
    .where(and(eq(schema.usage.productId, ctx.productId), eq(schema.usage.source, "gateway"), gte(schema.usage.at, new Date(ctx.since))));
  return Number(row?.total ?? 0);
}

export interface ProveChecksEnd {
  summaries: Partial<Record<ProvedOutput, ProveSummary>>;
  /** Which outputs passed, so only those get a video. */
  passed: ProvedOutput[];
  /** Hash of results.json, which the skill test's Muse Code could reach, so its scenes are known to be what ran. */
  resultsHash: string | null;
  skillCall: ProveCall | null;
  /** Whether the skill file itself came down and reads right. */
  skillFileOk: boolean;
}

/** Reads what the checks did and says so for each output. */
export async function proveCollectChecksStep(ctx: ProveCtx, timedOut: boolean): Promise<ProveChecksEnd> {
  "use step";
  const text = await sandbox.readSandboxText(ctx.copy, `${PROVE_DIR}/results.json`);
  const results = parseProveResults(text);
  const specText = await sandbox.readSandboxText(ctx.copy, `${PROVE_DIR}/spec.json`);
  const spec = specText ? (JSON.parse(specText) as ProveRunSpec) : null;
  const summaries: ProveChecksEnd["summaries"] = {};
  const passed: ProvedOutput[] = [];
  for (const output of ["mcp", "cli", "claude_plugin"] as const) {
    const result = results?.outputs[output];
    const said = describeResult(output, result);
    const final = timedOut && !result?.ok ? { ...said, state: "failed" as const, detail: "The checks ran out of time." } : said;
    summaries[output] = { state: final.state, title: final.title, ...(final.detail ? { detail: final.detail } : {}) };
    if (final.state === "done") passed.push(output);
    await say(ctx, output, final);
  }
  const skill = results?.outputs.skill;
  return {
    summaries,
    passed,
    resultsHash: text ? createHash("sha256").update(text).digest("hex") : null,
    skillCall: spec ? skillTestCall(spec, results?.outputs.mcp) : null,
    skillFileOk: skill?.ok === true,
  };
}

/** What's left under the cap, by what's been recorded. */
async function leftUsd(ctx: ProveCtx, museUsd: number): Promise<number> {
  return ctx.capUsd - museUsd - (await actionSpendUsd(ctx));
}

export interface SkillRun {
  cmdId: string;
  logPath: string;
  command: string;
  action: string;
  startedAt: number;
}

/** Starts the skill test, or says why it won't run: no call worked, the skill file is wrong, or the money isn't there. */
export async function proveStartSkillStep(ctx: ProveCtx, checks: Pick<ProveChecksEnd, "skillCall" | "skillFileOk">): Promise<SkillRun | null> {
  "use step";
  const skip = async (state: ProveEventBody["state"], title: string, detail: string) => {
    await say(ctx, "skill", { state, title, detail });
    return null;
  };
  if (!checks.skillFileOk) return skip("failed", "Skill file: didn't work", "The skill file didn't download or doesn't read right, so Muse Code didn't try it.");
  if (!checks.skillCall) return skip("skipped", "Skill file: downloaded, not used", "No action had a call that worked, so Muse Code had nothing to run with it.");
  const reserve = SKILL_TEST_RESERVE_USD[ctx.model] ?? SKILL_TEST_RESERVE_USD["muse-wonder-1.0"];
  if ((await leftUsd(ctx, 0)) < reserve) return skip("skipped", "Skill file: downloaded, not used", "Running Muse Code would go over this build's Prove it budget.");
  if (await spendPaused()) return skip("skipped", "Skill file: downloaded, not used", "The platform's spending cap for today has been reached.");
  const skill = skillName(ctx.slug);
  const skillText = await sandbox.readSandboxText(ctx.copy, `${PROVE_DIR}/SKILL.md`);
  if (!skillText) return skip("failed", "Skill file: didn't work", "The downloaded skill file went missing.");
  await sandbox.writeProveFiles(ctx.copy, [
    { path: `${PROVE_SKILL_DIR}/.agents/skills/${skill}/SKILL.md`, content: skillText },
    { path: `${PROVE_SKILL_DIR}/prompt.md`, content: skillTestPrompt({ skill, action: checks.skillCall.name, args: checks.skillCall.args }) },
  ]);
  await say(ctx, "skill", { state: "running", title: "Skill file: Muse Code is using it" });
  const run = await sandbox.startSkillTest({ sandboxName: ctx.copy, cwd: PROVE_SKILL_DIR, model: ctx.model, maxModelSteps: SKILL_TEST_MAX_STEPS, sessionId: newSessionId() });
  return { ...run, action: checks.skillCall.name, startedAt: Date.now() };
}
proveStartSkillStep.maxRetries = 1;

export interface SkillPoll {
  done: boolean;
  exitCode: number | null;
  offset: number;
  finalText: string | null;
  announced: string[];
  childrenIncluded: boolean | null;
  /** Spent so far on this run, by its session log. */
  museUsd: number;
  /** True when what's been spent has reached the cap, and the run must be stopped. */
  overCap: boolean;
}

/** Reads the skill test's progress and charges what it reports, once. It isn't shown as a round in the room. */
export async function provePollSkillStep(
  ctx: ProveCtx,
  run: Pick<SkillRun, "cmdId" | "logPath">,
  state: { offset: number; announced: string[]; childrenIncluded: boolean | null },
): Promise<SkillPoll> {
  "use step";
  const poll = await sandbox.pollMuse({
    sandboxName: ctx.copy,
    cmdId: run.cmdId,
    logPath: run.logPath,
    offset: state.offset,
    announced: state.announced,
    childrenIncluded: state.childrenIncluded,
    engine: "exec",
  });
  const usageCtx = { source: "muse_code" as const, endpoint: "muse exec prove", buildId: ctx.buildId, productId: ctx.productId };
  if (poll.usage.length) await charge(usageCtx, poll.usage, "Prove it: skill test");
  const fromLog = poll.session?.unreported.usage ?? [];
  if (fromLog.length) await charge(usageCtx, fromLog, "Prove it: skill test");
  const childrenIncluded = poll.childrenIncluded ?? state.childrenIncluded ?? null;
  const children = childrenIncluded === true ? undefined : poll.session?.children;
  if (children?.usage.length) await charge({ ...usageCtx, endpoint: "muse exec prove children" }, children.usage, "Prove it: skill test helpers");
  const museUsd = await sandbox.museRunSpendUsd(ctx.copy, run.logPath).catch(() => 0);
  return {
    done: poll.done,
    exitCode: poll.exitCode,
    offset: poll.offset,
    finalText: poll.finalText,
    announced: poll.announced ?? state.announced,
    childrenIncluded,
    museUsd,
    overCap: !poll.done && (await leftUsd(ctx, museUsd)) <= 0,
  };
}
provePollSkillStep.maxRetries = 2;

/** Judges the skill test from its log and what it saved, and says so. Returns whether it passed. */
export async function proveFinishSkillStep(
  ctx: ProveCtx,
  run: Pick<SkillRun, "logPath" | "action">,
  end: { exitCode: number | null; timedOut: boolean },
): Promise<{ summary: ProveSummary; ok: boolean; lines: string[] }> {
  "use step";
  const log = (await sandbox.readSandboxText(ctx.copy, run.logPath)) ?? "";
  const facts = skillTestFacts(log, { skill: skillName(ctx.slug), action: run.action, liveHost: publicHost(ctx.liveUrl) ?? "" });
  const reply = await sandbox.readSandboxText(ctx.copy, `${PROVE_SKILL_DIR}/reply.json`);
  const judged = judgeSkillTest({ exitCode: end.exitCode, timedOut: end.timedOut, readSkill: facts.readSkill, calledAction: facts.calledAction, reply, action: run.action });
  const summary: ProveSummary = judged.ok
    ? { state: "done", title: `Skill file: Muse Code used it to run ${run.action}` }
    : { state: "failed", title: "Skill file: Muse Code couldn't use it", detail: judged.problem };
  await say(ctx, "skill", { ...summary, checks: judged.checks });
  return { summary, ok: judged.ok, lines: facts.lines };
}

/** Writes each passing output's scene and starts recording. Null when there is nothing to record. */
export async function proveStartRecordStep(
  ctx: ProveCtx,
  input: {
    passed: ProvedOutput[];
    resultsHash: string | null;
    skill: { lines: string[]; finalText: string | null; command: string; seconds: number } | null;
  },
): Promise<string | null> {
  "use step";
  const text = await sandbox.readSandboxText(ctx.copy, `${PROVE_DIR}/results.json`);
  const hash = text ? createHash("sha256").update(text).digest("hex") : null;
  // Muse Code had the run of this copy during the skill test. A log it changed would not be what really ran.
  if (!hash || hash !== input.resultsHash) {
    await say(ctx, "stage", { state: "running", title: "Testing what this product comes with", detail: "The checks' log changed after they ran, so no video was made from it." });
    return null;
  }
  const results = parseProveResults(text);
  const at = new Date();
  const files: Array<{ path: string; content: string }> = [
    { path: `${PROVE_DIR}/scene.html`, content: PROVE_SCENE_SOURCE },
    { path: `${PRODUCT_DIR}/${PROVE_CONFIG}`, content: proveConfigFile() },
    { path: `${PRODUCT_DIR}/${PROVE_SPEC}`, content: proveSpecFile() },
  ];
  const recorded: ProvedOutput[] = [];
  for (const output of input.passed) {
    const scene =
      output === "skill"
        ? input.skill && skillScene({ name: ctx.name, at, download: results?.outputs.skill, command: input.skill.command, lines: input.skill.lines, seconds: input.skill.seconds, ok: true, finalText: input.skill.finalText })
        : results?.outputs[output] && sceneFor(output, results.outputs[output], { name: ctx.name, at });
    if (!scene) continue;
    recorded.push(output);
    files.push(
      { path: `${PROVE_DIR}/scene-${output}.json`, content: JSON.stringify(scene) },
      {
        path: `${PROVE_DIR}/studio-${output}.json`,
        content: JSON.stringify(
          studioSpecFor(output, { name: ctx.name, origin: ctx.site, slug: ctx.slug, timeline: `${PRODUCT_DIR}/${DEMO_RECORDING_DIR}/timeline.json`, out: `${PROVE_DIR}/video/${output}` }),
        ),
      },
    );
  }
  if (!recorded.length) return null;
  await sandbox.writeProveFiles(ctx.copy, files);
  const { cmdId } = await sandbox.startProveCommand(ctx.copy, { tag: "prove-record", cwd: PRODUCT_DIR, argv: ["bash", "-c", proveRecordScript(recorded)] });
  return cmdId;
}
proveStartRecordStep.maxRetries = 1;

/** Uploads each video that came out and adds it to its output. An output with none keeps its result and just has no video. */
export async function proveFinishRecordStep(ctx: ProveCtx, input: { passed: ProvedOutput[]; summaries: Partial<Record<ProvedOutput, ProveSummary>> }): Promise<void> {
  "use step";
  const at = new Date();
  for (const output of input.passed) {
    const summary = input.summaries[output];
    if (!summary) continue;
    const video = await sandbox
      .uploadProveVideo({ sandboxName: ctx.copy, buildId: ctx.buildId, output, dir: `${PROVE_DIR}/video/${output}` })
      .catch((err: unknown) => {
        console.warn(`[prove] upload ${output}`, err);
        return null;
      });
    if (video?.videoUrl) await say(ctx, output, { ...summary, media: { url: video.videoUrl, posterUrl: video.posterUrl, caption: videoCaption(output, at) } });
  }
}
proveFinishRecordStep.maxRetries = 1;

/** Charges the product calls the run made, deletes the copy and closes the run. */
export async function proveCloseStep(ctx: ProveCtx): Promise<void> {
  "use step";
  let added = 0;
  try {
    added = await actionSpendUsd(ctx);
    if (added > 0) await addBuildCost(ctx.buildId, added, "Prove it: calls to the live product");
  } catch (err) {
    console.error("[prove] charge", err);
  }
  await sandbox.deleteProveCopy(ctx.copy).catch((err: unknown) => console.warn(`[prove] delete ${ctx.copy}: ${String(err)}`));
  const [row] = await db()
    .select({ total: sql<number>`coalesce(sum(${schema.usage.costUsd}), 0)::float8` })
    .from(schema.usage)
    .where(and(eq(schema.usage.buildId, ctx.buildId), eq(schema.usage.source, "muse_code"), sql`${schema.usage.endpoint} like 'muse exec prove%'`, gte(schema.usage.at, new Date(ctx.since))));
  const costUsd = added + Number(row?.total ?? 0);
  await say(ctx, "stage", { state: "done", title: "Tested what this product comes with", costUsd });
}
proveCloseStep.maxRetries = 0;

/** Everything a failed run still owes: the copy gone and a line saying what happened. Never throws. */
export async function proveFailStep(ctx: ProveCtx, err: unknown): Promise<void> {
  "use step";
  await sandbox.deleteProveCopy(ctx.copy).catch((e: unknown) => console.warn(`[prove] delete ${ctx.copy}: ${String(e)}`));
  await say(ctx, "stage", { state: "failed", title: "Prove it didn't finish", detail: failureMessage("prove", err).slice(0, 500) }).catch(() => undefined);
}
proveFailStep.maxRetries = 1;
