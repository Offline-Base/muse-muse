/**
 * A tuned model's versions (/models/[id]): the judged Muse Glimmer LoRA jobs trained on the same dataset, and what
 * "Train a new version" starts from. Each version is its own job and its own Hugging Face repo, and no column links them
 * but the dataset, so there is no migration. A new version trains a new adapter from the base: the recipe has no way to
 * continue an old adapter (PeftModel loads them for inference only), and nothing has proved that it would work on the
 * GPU. Pure, so the pages, the form and the tests share it.
 */
import type { TunedModelView } from "@/components/models/catalog";
import type { ResultView } from "@/components/train/results";
import { ADAPTER_RECIPE, MODE_PARAM, CHAT_MODE } from "@/lib/train/logic";
import type { RecipeParamField } from "@/lib/train/types";

/** Never carried to a new version: one job's own story, and switches that would stop it being a real run. */
const NOT_CARRIED = new Set(["why", "dryRun", "scoreOnly"]);

/** What a new version starts with. Only an admin's pages ever hold it, and POST /api/train/jobs checks it all again. */
export interface NewVersionPlan {
  fromJobId: string;
  recipe: typeof ADAPTER_RECIPE;
  title: string;
  params: Record<string, string | number>;
  instanceType: string;
  maxMinutes: number;
  maxUsd: number;
}

/**
 * The same settings as `job`, or null when it can't have a new version from here: another recipe's job, a dry run, one
 * with no dataset, or one made for a product (a product's model is its owner's, and a job started here wouldn't be tied
 * to the product). Only the recipe's own fields are copied. Publish stays off unless the source was published that way:
 * the recipe's default is on, so leaving it out would turn it on.
 */
export function newVersionPlan(
  job: {
    id: string;
    recipe: string;
    title: string;
    params: Record<string, string | number> | null;
    instanceType: string;
    maxMinutes: number;
    maxUsd: number;
    productId: string | null;
  },
  fields: readonly Pick<RecipeParamField, "key" | "modes">[],
): NewVersionPlan | null {
  const source = job.params ?? {};
  if (job.recipe !== ADAPTER_RECIPE || job.productId) return null;
  if (typeof source.datasetId !== "string" || !source.datasetId) return null;
  if (Number(source.dryRun) >= 1) return null;
  const mode = typeof source[MODE_PARAM] === "string" ? String(source[MODE_PARAM]) : CHAT_MODE;
  const params: Record<string, string | number> = {};
  for (const { key, modes } of fields) {
    if (NOT_CARRIED.has(key) || (modes && !modes.includes(mode))) continue;
    if (key === "publish") {
      params.publish = Number(source.publish) === 1 ? 1 : 0;
      continue;
    }
    const v = source[key];
    if (typeof v === "string" || typeof v === "number") params[key] = v;
  }
  return {
    fromJobId: job.id,
    recipe: ADAPTER_RECIPE,
    title: job.title,
    params,
    instanceType: job.instanceType,
    maxMinutes: job.maxMinutes,
    maxUsd: job.maxUsd,
  };
}

/** One version as the model's page lists it. */
export interface ModelVersionView extends TunedModelView {
  /** Counted from the first judged version on the dataset. */
  number: number;
  finishedAt: string;
  costUsd: number;
  settings: ResultView["settings"];
  score: string;
  /** The adapter's files on the Hub, once public. */
  filesUrl: string | null;
  datasetUrl: string | null;
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** How a version did, in a few words: wins on a chat model, how often it was right on a decision model. */
function scoreText(r: ResultView): string {
  const tuned = r.decision?.tuned;
  if (r.decision && tuned) return `Right on ${percent(tuned.accuracy.rate)}, base ${percent(r.decision.base.accuracy.rate)}`;
  return `Tuned won ${r.summary.tunedWins} of ${r.summary.items}`;
}

/** The versions, newest first as given, numbered from the oldest. A result with no matching row in `tuned` is left out. */
export function modelVersionViews(results: readonly ResultView[], tuned: readonly TunedModelView[]): ModelVersionView[] {
  const byId = new Map(tuned.map((t) => [t.id, t] as const));
  return results.flatMap((r, i) => {
    const t = byId.get(r.id);
    if (!t) return [];
    return [
      {
        ...t,
        number: results.length - i,
        finishedAt: r.finishedAt,
        costUsd: r.costUsd,
        settings: r.settings,
        score: scoreText(r),
        filesUrl: t.hubUrl ? `${t.hubUrl.replace(/\/+$/, "")}/tree/main` : null,
        datasetUrl: r.hub?.datasetUrl ?? null,
      },
    ];
  });
}
