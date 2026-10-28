import { gpuName, hubHref } from "@/components/train/format";
import type { ReadyDatasetRow, ResultJobRow } from "@/lib/train/store";
import type { DatasetView, EvalSummary, LiveDemoView, PublicHubLinks, RecipeView } from "@/lib/train/types";

/**
 * The Lab results: what anyone may see of fine-tuning at /fine-tuning (docs/TRAINING.md "Lab results"). Judged jobs and
 * ready datasets, mapped field by field from what the store's Lab reads select, so nothing else can reach those pages:
 * no instance id, IP, region, limits, log, error, artifact or dataset note. Pure functions only, like format.ts.
 */

/** The model glimmer-lora tunes, as the results name it in full. */
export const GLIMMER_NAME = "Muse Glimmer 30B";

/** Job params the results show, in order, with the label used when the recipe has no field for one. Nothing else. */
export const RESULT_SETTINGS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "maxSteps", label: "Training steps" },
  { key: "loraRank", label: "LoRA rank" },
  { key: "learningRate", label: "Learning rate" },
  { key: "studentPrompt", label: "Student prompt" },
];

export interface ResultSetting {
  key: string;
  label: string;
  value: string;
}

/** A judged job as the Lab results show it. */
export interface ResultView {
  id: string;
  title: string;
  /** The recipe id, such as "glimmer-lora". */
  recipe: string;
  recipeTitle: string;
  /** The model that was tuned: "Muse Glimmer 30B". */
  model: string;
  gpu: string;
  /** GPU time from launch to shutdown, every started minute counted, as Lambda bills it. */
  gpuMinutes: number;
  /** The GPU's final cost. */
  costUsd: number;
  finishedAt: string;
  summary: EvalSummary;
  settings: ResultSetting[];
  /** The dataset param, for a link when that dataset is ready. */
  datasetId: string | null;
  /** The model and dataset repos on the Hugging Face Hub, once the job is published there and they are public. */
  hub: PublicHubLinks | null;
}

/** True for a job run with dryRun on: it fakes its answers, so its verdicts mean nothing. */
export function isDryRun(params: Record<string, unknown> | null | undefined): boolean {
  const v = Number(params?.dryRun);
  return Number.isFinite(v) && v >= 1;
}

/** The store's Lab rule again: succeeded, the GPU shut down, judged, and not a dry run. */
export function hasResults(row: Pick<ResultJobRow, "status" | "terminatedAt" | "evalSummary" | "params">): boolean {
  return (
    row.status === "succeeded" &&
    Boolean(row.terminatedAt) &&
    Number(row.evalSummary?.items) > 0 &&
    !isDryRun(row.params)
  );
}

/** The allowed params that are set, labelled from the recipe's fields when it has them. */
export function resultSettings(
  params: Record<string, string | number> | null | undefined,
  recipe: Pick<RecipeView, "params"> | null,
): ResultSetting[] {
  const out: ResultSetting[] = [];
  for (const { key, label } of RESULT_SETTINGS) {
    const v = params?.[key];
    if ((typeof v !== "string" && typeof v !== "number") || String(v).trim() === "") continue;
    out.push({ key, label: recipe?.params.find((f) => f.key === key)?.label ?? label, value: String(v).trim() });
  }
  return out;
}

/** The eval summary's numbers only, so nothing else saved with it is passed on. */
function summaryOf(s: EvalSummary): EvalSummary {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    items: n(s.items),
    tunedWins: n(s.tunedWins),
    baseWins: n(s.baseWins),
    ties: n(s.ties),
    avgBaseScore: n(s.avgBaseScore),
    avgTunedScore: n(s.avgTunedScore),
    judgeCostUsd: n(s.judgeCostUsd),
  };
}

/**
 * The Hub links of a published job, from the store's hubLinks (only the status and the two URLs), each an https link
 * (hubHref). Null unless it is published with a model link.
 */
export function publicHubLinks(links: ResultJobRow["hubLinks"]): PublicHubLinks | null {
  if (!links || links.status !== "published") return null;
  const modelUrl = hubHref(links.modelUrl);
  return modelUrl ? { modelUrl, datasetUrl: hubHref(links.datasetUrl) } : null;
}

/** A judged job for the Lab results, or null when it has none to show (hasResults). */
export function toResultView(row: ResultJobRow, recipe: Pick<RecipeView, "title" | "gpus" | "params"> | null): ResultView | null {
  if (!hasResults(row) || !row.evalSummary || !row.terminatedAt) return null;
  const start = (row.launchedAt ?? row.createdAt).getTime();
  const end = row.terminatedAt.getTime();
  const datasetKey = recipe?.params.find((f) => f.kind === "dataset")?.key ?? "datasetId";
  const dataset = row.params?.[datasetKey];
  return {
    id: row.id,
    title: row.title,
    recipe: row.recipe,
    recipeTitle: recipe?.title ?? row.recipe,
    model: row.recipe === "glimmer-lora" ? GLIMMER_NAME : (recipe?.title ?? row.recipe),
    gpu: gpuName(recipe, row.instanceType),
    gpuMinutes: Math.max(0, Math.ceil((end - start) / 60_000)),
    costUsd: row.costUsd,
    finishedAt: (row.finishedAt ?? row.terminatedAt).toISOString(),
    summary: summaryOf(row.evalSummary),
    settings: resultSettings(row.params, recipe),
    datasetId: typeof dataset === "string" ? dataset : null,
    hub: publicHubLinks(row.hubLinks),
  };
}

/** A ready dataset for the Lab results, in the shape DatasetDetail and the tables take, with no note. */
export function toReadyDatasetView(row: ReadyDatasetRow): DatasetView {
  return {
    id: row.id,
    title: row.title,
    task: row.task,
    status: row.status,
    requested: row.requested,
    trainCount: row.trainCount,
    evalCount: row.evalCount,
    costUsd: row.costUsd,
    error: null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

/**
 * A live demo as the public result page hands it to the browser: whether it is starting or live, its minutes and when
 * it is expected to stop. Never the serve job's id, and never anything about its GPU (IP, key or certificate).
 */
export interface PublicLiveDemo {
  state: "starting" | "live";
  minutes: number;
  endsAt: string | null;
}

/** getLiveDemo's answer mapped field by field for the public page, or null when there is no demo. */
export function toPublicLiveDemo(v: LiveDemoView | null | undefined): PublicLiveDemo | null {
  if (!v || (v.state !== "starting" && v.state !== "live")) return null;
  return {
    state: v.state,
    minutes: Number.isFinite(v.minutes) ? v.minutes : 0,
    endsAt: typeof v.endsAt === "string" ? v.endsAt : null,
  };
}

/** "42 min". */
export function minutesText(minutes: number): string {
  return `${Math.max(0, Math.round(minutes))} min`;
}
