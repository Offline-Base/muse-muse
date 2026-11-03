/**
 * Pure decisions the build workflow makes. No Node APIs and no I/O, so the workflow function can import this file
 * and unit tests can run it directly.
 */
import type { Brief } from "@/lib/brief/schema";
import type { BuildModel } from "@/lib/sandbox/muse";
import type { Reference } from "@/lib/types";
import { defaultModel, SPARK_STANDIN, withoutRetiredSpark } from "@/lib/meta/spark";
import { AGENT_MARKER, isToolId, PERSONAL_TOOL_IDS, toolMarker } from "@/lib/tools/ids";
import { briefCaps } from "@/lib/caps/brief-fields";
import { connectBlock } from "@/lib/caps/connect/brief";
import { hardwareBlock } from "@/lib/caps/hardware/brief";
import { BOARD_TOOLS_MARKER, DRIVE_TOOLS_MARKER } from "@/lib/caps/hardware/limits";
import { LIVE_CAPTION_MODEL, liveBlock } from "@/lib/caps/live/brief";
import { FLEET_BRIEF_MODEL, fleetAllowedModels } from "@/lib/caps/fleet/marker";
import { gpuAllowedModels } from "@/lib/caps/gpu/marker";
import { edgeAllowedModels } from "@/lib/edge/models";
import { capMarker } from "@/lib/caps/ids";
import { env } from "@/lib/env";
import { AGENT_LONG_MARKER, CONTRIBUTOR_RUNTIME_MARKER, liveTokenDailyBudgetFor } from "@/lib/gateway/policy";
import { isLongRunBrief, pickedRecipes } from "@/lib/recipes/registry";

/** BriefSchema caps slugs at 40 characters. */
export const SLUG_MAX = 40;

/** Lowercase letters, digits and single dashes, at most SLUG_MAX long. Falls back to "product". */
export function normalizeSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return slug || "product";
}

/** n = 1 is the base slug. n >= 2 appends -n, trimming the base so the result still fits SLUG_MAX. */
export function slugWithSuffix(base: string, n: number): string {
  const clean = normalizeSlug(base);
  if (n <= 1) return clean;
  const suffix = `-${n}`;
  const head = clean.slice(0, SLUG_MAX - suffix.length).replace(/-+$/g, "") || "product";
  return `${head}${suffix}`;
}

/** The first of base, base-2, base-3, ... that isn't taken. */
export function nextFreeSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; n < 10_000; n++) {
    const candidate = slugWithSuffix(base, n);
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`No free slug for ${base}`);
}

export type Outcome = "live" | "partial" | "failed";

export interface VerifyStepResult {
  name: string;
  ok: boolean;
}

/** Steps that must pass for a new build that never fully passed to ship as partial: it builds, serves and runs its flow. */
export const PARTIAL_REQUIRED_STEPS = ["typecheck", "build", "start", "console", "smoke"] as const;

/** The judge's decision on the last checked round. `blocking` failures (copying, Meta branding, no result) never ship. */
export interface JudgeCall {
  pass: boolean;
  blocking: boolean;
  /** FULL_BUILDS: the requirements still not met, each with its id. Set only when there are some. */
  unmet?: string[];
  /**
   * The polish round's no-worse gate (polishNoWorse in lib/polish/logic.ts): the judge model's own call before code
   * failed it for unmet requirements, and each requirement's state. Set only on a polish whose live version already
   * fails some requirements.
   */
  ownPass?: boolean;
  requirements?: Array<{ id: string; state: string }>;
}

/**
 * live when verify and the judge both passed. A refinement ships only then; otherwise the live version stays. A new
 * build ships as partial only when typecheck, build, start, console and smoke passed on the last verify and the judge
 * failed it for a reason that isn't blocking. Anything else fails and is not deployed.
 */
export function decideOutcome(input: {
  kind: "build" | "refine";
  passed: boolean;
  steps: VerifyStepResult[];
  judge: JudgeCall | null;
}): Outcome {
  if (input.passed) return "live";
  if (input.kind === "refine") return "failed";
  if (!input.judge || input.judge.pass || input.judge.blocking) return "failed";
  const ok = (name: string) => input.steps.some((s) => s.name === name && s.ok);
  return PARTIAL_REQUIRED_STEPS.every(ok) ? "partial" : "failed";
}

/**
 * Milestone states after a check (1-based milestone numbers). The milestone just checked takes the result. A pass also
 * settles every earlier milestone still marked failed, since each check covers every milestone before it: on Nov 3 an
 * agent build's plan kept milestone 1 as "failed" after its final check passed 8 of 8. Returns the states to write and
 * the milestones still failed after this check.
 */
export function settleMilestones(input: { failed: readonly number[]; checked: number; passed: boolean }): {
  states: Array<{ index: number; state: "passed" | "failed" }>;
  failed: number[];
} {
  if (!input.passed) return { states: [{ index: input.checked, state: "failed" }], failed: [...new Set([...input.failed, input.checked])].sort((a, b) => a - b) };
  const earlier = [...new Set(input.failed)].filter((n) => n < input.checked).sort((a, b) => a - b);
  return {
    states: [...earlier.map((index) => ({ index, state: "passed" as const })), { index: input.checked, state: "passed" }],
    failed: [...new Set(input.failed)].filter((n) => n > input.checked).sort((a, b) => a - b),
  };
}

/** How many polls fit in a time cap. At least one, so a tiny cap still checks once. */
export function pollLimit(capMs: number, intervalMs: number): number {
  return Math.max(1, Math.ceil(capMs / intervalMs));
}

/**
 * Whether a poll loop has run out of time. The workflow clock (Date.now() inside a workflow) advances with recorded
 * events, so the poll count is a backstop that ends the loop even if the clock lags.
 */
export function pollTimedOut(input: {
  startedAt: number;
  now: number;
  capMs: number;
  intervalMs: number;
  polls: number;
}): boolean {
  return input.now - input.startedAt >= input.capMs || input.polls >= pollLimit(input.capMs, input.intervalMs);
}

/**
 * What the product's gateway tokens may call: the brief's capabilities, minus Glimmer (self-hosted, not the API).
 * muse-gadget stays in: it's what lets the token use the gateway's /gadget route (lib/gateway/gadget.ts). An agent's
 * brief adds the agent marker and one marker per tool it picked (docs/AGENT_TOOLS.md). Then a `cap:<id>` marker for each
 * cap block the brief has, after the models and the agent markers (docs/CAPABILITIES.md, 2.3), so a brief with none
 * gives today's list. A recipe adds the models it always calls, and a long-run recipe adds the long marker, which never
 * brings the agent marker: those products have no catalog tools.
 */
export function allowedModelsFor(brief: Pick<Brief, "capabilities" | "agent" | "recipes" | "targets">): string[] {
  const models = brief.capabilities.map((c) => c.model).filter((m) => m !== "muse-glimmer" && m !== FLEET_BRIEF_MODEL);
  const tools = brief.agent ? brief.agent.tools.map((t) => t.id).filter(isToolId).map(toolMarker) : [];
  // Wave 3, unit 7 (docs/CAPABILITIES.md, 13a): captions need the voice model, even if the writer left it out of capabilities.
  const live = liveBlock(brief)?.captions ? [LIVE_CAPTION_MODEL] : [];
  // Wave 3, unit 11: Muse Wonder and the `glimmer` marker while the shared Glimmer endpoint is on. None with it off.
  const gpu = gpuAllowedModels(brief);
  // The Jetson fleet (docs/CAPABILITIES.md, 17b): only the `fleet` marker while FLEET_PRODUCTS is on. None with it off.
  const fleet = fleetAllowedModels(brief);
  // Wave 3, unit 13: board tools have their own marker, so they bring no camera or microphone. None with them off.
  const board = hardwareBlock(brief)?.boardTools ? [BOARD_TOOLS_MARKER] : [];
  // The drive tools have their own marker too (docs/DRIVE_EXPORT.md, "From a product"). None with them off.
  const drive = hardwareBlock(brief)?.driveExport ? [DRIVE_TOOLS_MARKER] : [];
  const recipeModels = pickedRecipes(brief).flatMap((r) => r.models ?? []);
  const long = isLongRunBrief(brief) ? [AGENT_LONG_MARKER] : [];
  return [...new Set<string>([...models, ...edgeAllowedModels(brief), ...recipeModels, ...live, ...gpu, ...fleet, ...board, ...drive, ...(brief.agent ? [AGENT_MARKER] : []), ...long, ...tools]), ...briefCaps(brief).map(capMarker)];
}

/**
 * True when a live product can't use Contributor under BUILDS_ON_CONTRIBUTOR: anything with a person's own connected accounts
 * or personal tools, since Meta's terms (6.2) bar personal information on Contributor and Meta may train on it. That
 * means personalOffUnderSwitch below, a person's board, and a gadget's camera and microphone. Those last two stay on Muse Wonder
 * (keepsWonderUnderSwitch, lib/gateway/policy.ts). Public web search, public APIs and a product's own chat follow the flag.
 */
export function runtimeStaysOffContributor(brief: Pick<Brief, "capabilities" | "agent">): boolean {
  const hardware = hardwareBlock(brief);
  return personalOffUnderSwitch(brief) || Boolean(hardware?.boardTools) || brief.capabilities.some((c) => c.model === "muse-gadget");
}

/** True when BUILDS_ON_CONTRIBUTOR has nothing for it to run on, so it isn't built: an agent's personal tools or owner connection, the owner's keys and sends through connect, a person's drive. */
export function personalOffUnderSwitch(brief: Pick<Brief, "capabilities" | "agent">): boolean {
  const personalTools = brief.agent ? brief.agent.connections === "owner" || brief.agent.tools.some((t) => (PERSONAL_TOOL_IDS as readonly string[]).includes(t.id)) : false;
  const connect = connectBlock(brief);
  return personalTools || Boolean(connect && (connect.keys.length || connect.sends.length)) || Boolean(hardwareBlock(brief)?.driveExport);
}

/**
 * The marker a live token gets: only with the flag on, a brief to check, nothing personal in it, and a product whose own
 * code shows the notice (an older snapshot's, or one a build rewrote, doesn't, so its calls are refused unless it's one of the exceptions).
 */
export function contributorRuntimeMarkers(brief: Pick<Brief, "capabilities" | "agent"> | null, flagOn: boolean, showsNotice: boolean): string[] {
  return flagOn && showsNotice && brief && !runtimeStaysOffContributor(brief) ? [CONTRIBUTOR_RUNTIME_MARKER] : [];
}

/** BUILDS_ON_CONTRIBUTOR: why a new product holding something personal isn't built. It could never run. */
export const PERSONAL_OFF_MESSAGE =
  "Muse Muse can't build this right now. It uses a person's own accounts or personal tools, and the model Muse Muse runs on for now can't be used with personal information.";

/** A live product's daily budget: AGENT_LONG_DAILY_USD for a long-run recipe, since one full run costs dollars, otherwise as its estimate says. */
export function liveDailyBudgetFor(brief: Pick<Brief, "estimatedCostPerRunUsd" | "recipes"> | null | undefined): number {
  return isLongRunBrief(brief) ? env.agentLongDailyUsd : liveTokenDailyBudgetFor(brief?.estimatedCostPerRunUsd);
}

const BUILD_MODELS: readonly BuildModel[] = ["muse-wonder-1.0", SPARK_STANDIN];

/** A build model, or the fallback. Muse Spark 1.3 is never used: it becomes Spark 1.3 Contributor (lib/meta/spark.ts). */
function asBuildModel(value: string | null | undefined, fallback: BuildModel): BuildModel {
  const model = value ? withoutRetiredSpark(value) : value;
  return BUILD_MODELS.includes(model as BuildModel) ? (model as BuildModel) : fallback;
}

/**
 * Muse Code's model: the complex build model for briefs marked complex, else the default build model. A value that
 * isn't a build model falls back to Muse Wonder, the default for both.
 */
export function pickBuildModel(
  complexity: Brief["complexity"],
  models: { buildModel: string; complexBuildModel: string },
): BuildModel {
  return complexity === "complex"
    ? asBuildModel(models.complexBuildModel, defaultModel())
    : asBuildModel(models.buildModel, defaultModel());
}

/**
 * The model a refinement resumes Muse Code on: the one the product was built with, never the current default, since
 * a session's reasoning records belong to its model. A product built on Muse Spark 1.3 (and every product built before
 * the platform recorded the model) resumes on Spark 1.3 Contributor, since Spark 1.3 itself is never used.
 */
export function refineBuildModel(previous: string | null | undefined): BuildModel {
  return asBuildModel(previous, SPARK_STANDIN);
}

/**
 * The model and session of a change. With buildTestModel() on, a change to a product whose session ran on another model
 * moves to Contributor in a new session, since a session's reasoning records belong to its model and can't carry over.
 * The new session has no memory of the product, so its prompt tells it to read the code first.
 */
export function refineRoute(sessionModel: string | null | undefined, test: string | null, override: BuildModel | null = null): { model: BuildModel; freshSession: boolean } {
  const model = refineBuildModel(sessionModel);
  // A per-build override (the polish round, lib/polish/logic.ts) wins over the switch for this one change. A session on
  // another model can't carry over, so it starts fresh.
  if (override) return { model: override, freshSession: model !== override };
  if (test !== SPARK_STANDIN || model === SPARK_STANDIN) return { model, freshSession: false };
  return { model: SPARK_STANDIN, freshSession: true };
}

/** Paths inside the product (inspo/<file>) of the image references, for `muse exec --image`. */
export function museImagePaths(references: Pick<Reference, "kind" | "fileName">[]): string[] {
  return references.filter((r) => r.kind === "image").map((r) => `inspo/${r.fileName}`);
}

/** Thrown by the workflow itself to stop a build with a message meant for the user. */
export class BuildStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildStop";
  }
}

export const SPEND_PAUSED_MESSAGE =
  "Muse Muse reached today's spending cap, so new builds are paused until tomorrow (UTC).";

const STAGE_LABELS: Record<string, string> = {
  start: "setup",
  brief: "brief",
  policy: "request check",
  product: "product setup",
  fixtures: "fixtures",
  provision: "sandbox setup",
  build: "build",
  preview: "preview",
  verify: "check",
  judge: "judge",
  fix: "fix",
  record: "demo recording",
  deploy: "deploy",
  live_check: "live check",
  register: "register",
  hibernate: "hibernate",
};

function plain(text: string): string {
  return text
    .replace(/\s*[\u2014\u2013]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The runtime wraps a step error that used up its retries in a FatalError with this prefix. */
const RETRIES_EXHAUSTED = /^Step "[^"]*" failed after \d+ retr(?:y|ies): /;

/**
 * A plain message for a build that stopped. Errors the pipeline raised on purpose (BuildStop, or a FatalError thrown
 * by a step) keep their message. Anything else, including a step that ran out of retries, names the stage and the
 * first line of the error.
 */
export function failureMessage(stage: string, err: unknown): string {
  // Duck-typed: errors hydrated inside the workflow sandbox may come from another realm's Error.
  const e = typeof err === "object" && err !== null ? (err as { name?: unknown; message?: unknown }) : null;
  const name = typeof e?.name === "string" ? e.name : "";
  const raw = typeof e?.message === "string" ? e.message : typeof err === "string" ? err : "Unknown error";
  const exhausted = RETRIES_EXHAUSTED.test(raw);
  const inner = raw.replace(RETRIES_EXHAUSTED, "");
  const firstLine = plain(inner.split("\n")[0] ?? "").slice(0, 300);
  if (!exhausted && (name === "BuildStop" || name === "FatalError")) return firstLine || "The build stopped.";
  const label = STAGE_LABELS[stage] ?? stage;
  return firstLine ? `The ${label} step failed: ${firstLine}` : `The ${label} step failed.`;
}
