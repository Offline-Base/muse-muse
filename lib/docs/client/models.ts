import { contributorSwitchOn, withoutRetiredSpark } from "@/lib/meta/spark";

/**
 * The models the docs demos offer, per endpoint kind (docs/DOCS_MIRROR.md, "Proxy" > Models). Labels spell out the
 * version and the mode so a reader always knows which tier a demo runs on. Muse Spark 1.3 itself is never offered:
 * the proxy runs it as Muse Spark 1.3 Contributor, so the menu says so up front.
 */

export type ModelKind = "text" | "vision" | "image" | "sam" | "voice";
export type ModelMode = "standard" | "contributor";

export interface DocsModel {
  id: string;
  label: string;
  mode: ModelMode;
  /** A few words for the menu: the mode and what it's for. */
  hint: string;
}

/** What text demos run on by default. */
export const DEFAULT_TEXT_MODEL = "muse-spark-1.3-contributor";

const TEXT_MODELS: readonly DocsModel[] = [
  { id: "muse-spark-1.3-contributor", label: "Muse Spark 1.3 Contributor", mode: "contributor", hint: "Contributor mode, lowest price" },
  { id: "muse-spark-1.2", label: "Muse Spark 1.2", mode: "standard", hint: "Standard mode" },
  { id: "muse-wonder-1.0", label: "Muse Wonder 1.0", mode: "standard", hint: "Standard mode, most capable" },
  { id: "muse-spark-1.2-contributor", label: "Muse Spark 1.2 Contributor", mode: "contributor", hint: "Contributor mode" },
  { id: "muse-spark-1.1", label: "Muse Spark 1.1", mode: "standard", hint: "Standard mode, the first version" },
];

/** BUILDS_ON_CONTRIBUTOR: the menus don't offer Muse Wonder, and the proxy serves anything naming it on Contributor. */
const OFFERED_TEXT_MODELS = TEXT_MODELS.filter((m) => !(m.id === "muse-wonder-1.0" && contributorSwitchOn()));

export const DOCS_MODELS: Record<ModelKind, readonly DocsModel[]> = {
  text: OFFERED_TEXT_MODELS,
  // Every Muse Spark version and Muse Wonder take images, video and PDFs (the Models page).
  vision: OFFERED_TEXT_MODELS,
  image: [{ id: "muse-image-1.0", label: "Muse Image 1.0", mode: "standard", hint: "$0.01 per image" }],
  sam: [{ id: "sam-3.1", label: "SAM 3.1", mode: "standard", hint: "Billed per image or video frame" }],
  voice: [
    { id: "muse-voice-transcribe-1.0", label: "Muse Voice Transcribe 1.0", mode: "standard", hint: "$0.18 per audio hour" },
  ],
};

export const DEFAULT_MODEL: Record<ModelKind, string> = {
  text: DEFAULT_TEXT_MODEL,
  vision: DEFAULT_TEXT_MODEL,
  image: "muse-image-1.0",
  sam: "sam-3.1",
  voice: "muse-voice-transcribe-1.0",
};

const ALL_MODELS = new Map<string, DocsModel>(
  Object.values(DOCS_MODELS)
    .flat()
    .map((m) => [m.id, m]),
);

/** The model the proxy actually calls: muse-spark-1.3 runs as muse-spark-1.3-contributor, the rest as they are. */
export function runsAs(model: string): string {
  return withoutRetiredSpark(model);
}

/** True when what is sent may be used to train Meta's models (pricing-rate-limits, "Contributor mode"). */
export function isContributor(model: string | null | undefined): boolean {
  return !!model && runsAs(model).endsWith("-contributor");
}

/** "Muse Spark 1.3 Contributor" for a known id; unknown ids are shown as they are. */
export function docsModelLabel(model: string): string {
  if (model === "muse-spark-1.3") return "Muse Spark 1.3";
  return ALL_MODELS.get(model)?.label ?? model;
}

/** The menu for a kind, in menu order, optionally limited to `allow` (which keeps its own order out of it). */
export function modelsFor(kind: ModelKind, allow?: readonly string[]): DocsModel[] {
  const list = DOCS_MODELS[kind] ?? [];
  if (!allow?.length) return [...list];
  const allowed = new Set(allow.map(runsAs));
  return list.filter((m) => allowed.has(m.id));
}

/** Which menu a model belongs to, or null for ids the docs don't offer. */
export function kindOfModel(model: string): ModelKind | null {
  const id = runsAs(model);
  if (TEXT_MODELS.some((m) => m.id === id)) return "text";
  for (const kind of ["image", "sam", "voice"] as const) {
    if (DOCS_MODELS[kind].some((m) => m.id === id)) return kind;
  }
  return null;
}

/** Reasoning effort levels (reasoning page). "none" is left out: Muse Wonder and Muse Spark reject it. */
export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: readonly Effort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export const EFFORT_LABELS: Record<Effort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** The efforts a model accepts. "max" is Muse Wonder's and Muse Spark 1.3's, not the Contributor variant's. */
export function effortsFor(model: string): Effort[] {
  const id = runsAs(model);
  const max = id === "muse-wonder-1.0" || id === "muse-spark-1.3";
  return EFFORTS.filter((e) => e !== "max" || max);
}

/**
 * The effort to send for a model: the one picked, or the highest the model takes when it doesn't take that one (max
 * picked on Muse Wonder, then a switch to a Contributor model). Matches what EffortSelect shows.
 */
export function fitEffort(model: string, effort: Effort | null | undefined): Effort | null {
  if (!effort) return null;
  const allowed = effortsFor(model);
  return allowed.includes(effort) ? effort : allowed[allowed.length - 1];
}
