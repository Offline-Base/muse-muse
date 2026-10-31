/**
 * Pure decisions the build workflow makes. No Node APIs and no I/O, so the workflow function can import this file
 * and unit tests can run it directly.
 */
import type { Brief } from "@/lib/brief/schema";
import type { BuildModel } from "@/lib/sandbox/muse";
import type { Reference } from "@/lib/types";
import { SPARK_STANDIN, withoutRetiredSpark } from "@/lib/meta/spark";
import { AGENT_MARKER, isToolId, toolMarker } from "@/lib/tools/ids";
import { briefCaps } from "@/lib/caps/brief-fields";
import { capMarker } from "@/lib/caps/ids";

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
 * gives today's list.
 */
export function allowedModelsFor(brief: Pick<Brief, "capabilities" | "agent">): string[] {
  const models = brief.capabilities.map((c) => c.model).filter((m) => m !== "muse-glimmer");
  const tools = brief.agent ? brief.agent.tools.map((t) => t.id).filter(isToolId).map(toolMarker) : [];
  return [...new Set<string>([...models, ...(brief.agent ? [AGENT_MARKER] : []), ...tools]), ...briefCaps(brief).map(capMarker)];
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
    ? asBuildModel(models.complexBuildModel, "muse-wonder-1.0")
    : asBuildModel(models.buildModel, "muse-wonder-1.0");
}

/**
 * The model a refinement resumes Muse Code on: the one the product was built with, never the current default, since
 * a session's reasoning records belong to its model. A product built on Muse Spark 1.3 (and every product built before
 * the platform recorded the model) resumes on Spark 1.3 Contributor, since Spark 1.3 itself is never used.
 */
export function refineBuildModel(previous: string | null | undefined): BuildModel {
  return asBuildModel(previous, SPARK_STANDIN);
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
