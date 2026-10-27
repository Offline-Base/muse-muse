/**
 * Pure decisions the build workflow makes. No Node APIs and no I/O, so the workflow function can import this file
 * and unit tests can run it directly.
 */
import type { Brief } from "@/lib/brief/schema";
import type { BuildModel } from "@/lib/sandbox/muse";
import type { Reference } from "@/lib/types";

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

/** Steps that must pass for a build that never fully passed to ship as partial: its main page builds and serves. */
export const PARTIAL_REQUIRED_STEPS = ["typecheck", "build", "start"] as const;

/**
 * live when verify and the judge both passed. Otherwise partial only when typecheck, build and start passed on the
 * last verify and Muse Code wrote BUILD_NOTES.md (the documented limits). Anything else fails and is not deployed.
 */
export function decideOutcome(input: { passed: boolean; steps: VerifyStepResult[]; hasBuildNotes: boolean }): Outcome {
  if (input.passed) return "live";
  const ok = (name: string) => input.steps.some((s) => s.name === name && s.ok);
  if (input.hasBuildNotes && PARTIAL_REQUIRED_STEPS.every(ok)) return "partial";
  return "failed";
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

/** Models the product's gateway tokens may call: the brief's capabilities, minus Glimmer (self-hosted, not the API). */
export function allowedModelsFor(brief: Pick<Brief, "capabilities">): string[] {
  const models = brief.capabilities.map((c) => c.model).filter((m) => m !== "muse-glimmer");
  return [...new Set(models)];
}

const BUILD_MODELS: readonly BuildModel[] = ["muse-spark-1.3", "muse-wonder-1.0"];

function asBuildModel(value: string | null | undefined, fallback: BuildModel): BuildModel {
  return BUILD_MODELS.includes(value as BuildModel) ? (value as BuildModel) : fallback;
}

/** Muse Code's model: the complex build model for briefs marked complex, else the default build model. */
export function pickBuildModel(
  complexity: Brief["complexity"],
  models: { buildModel: string; complexBuildModel: string },
): BuildModel {
  return complexity === "complex"
    ? asBuildModel(models.complexBuildModel, "muse-wonder-1.0")
    : asBuildModel(models.buildModel, "muse-spark-1.3");
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
  product: "product setup",
  fixtures: "fixtures",
  provision: "sandbox setup",
  build: "build",
  preview: "preview",
  verify: "check",
  fix: "fix",
  record: "demo recording",
  deploy: "deploy",
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
