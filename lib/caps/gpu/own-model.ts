import { isSparkOpenDerivative, verdictFor } from "@/lib/caps/gpu/general";
import { fillProductIds, productAdapterJobs } from "@/lib/caps/gpu/store";
import type { OwnModel } from "@/lib/caps/gpu/types";
import { adapterProblem, CHAT_MODE, DECIDE_MODE, jobMode, trainChannelOf } from "@/lib/train/logic";
import { getAdapterSource, getDecisionModel } from "@/lib/train/store";

export interface OwnModelDeps {
  fill(productId: string): Promise<void>;
  jobs: typeof productAdapterJobs;
  source: typeof getAdapterSource;
  decisionModel: typeof getDecisionModel;
}

const STORE: OwnModelDeps = { fill: fillProductIds, jobs: productAdapterJobs, source: getAdapterSource, decisionModel: getDecisionModel };

/**
 * The contract's ownModelFor: a product's own chat model, the newest job trained for it that General's evalVerdict passes
 * and whose adapter can still be served: a real run on the model cache (adapterProblem), and trained on r30b, since serve
 * jobs now load r30b and a plain Glimmer adapter would load without error and answer as a model nobody evaluated. Reading
 * only, apart from filling training_jobs.product_id from the run's record. Null when nothing qualifies.
 *
 * A decision model isn't a chat model, so it's never this: see ownDecisionModelFor. A product calls one through
 * {GATEWAY_URL}/decide by its id.
 */
export async function ownModelFor(productId: string, _now: Date = new Date(), deps: OwnModelDeps = STORE): Promise<OwnModel | null> {
  await deps.fill(productId);
  for (const job of await deps.jobs(productId)) {
    if (await qualifiesAsOwnModel(job, deps)) return { adapterJobId: job.id, trainChannel: trainChannelOf(job.params) };
  }
  return null;
}

/** The filters ownModelFor applies to each of a product's jobs. */
async function qualifiesAsOwnModel(job: Awaited<ReturnType<OwnModelDeps["jobs"]>>[number], deps: OwnModelDeps): Promise<boolean> {
  if (jobMode(job.params) !== CHAT_MODE || !job.evalSummary) return false;
  const source = await deps.source(job.id);
  if (!source || adapterProblem(source.job, source.metrics)) return false;
  const sparkOpen = isSparkOpenDerivative({ params: source.job.params, metrics: source.metrics });
  return Boolean(sparkOpen && verdictFor(job.evalSummary, sparkOpen).passed);
}

/**
 * Whether a job is one of this product's own chat models, newest or not: a newer model passing doesn't make an earlier one
 * somebody else's. For a drive export already going. A new export still goes through ownModelFor.
 */
export async function isOwnModelJob(productId: string, jobId: string, deps: OwnModelDeps = STORE): Promise<boolean> {
  await deps.fill(productId);
  const wanted = jobId.toLowerCase();
  const job = (await deps.jobs(productId)).find((j) => j.id.toLowerCase() === wanted);
  return job ? qualifiesAsOwnModel(job, deps) : false;
}

const sameNames = (a: readonly string[], b: readonly string[]) => {
  const fold = (list: readonly string[]) => list.map((s) => s.trim().toLowerCase()).sort().join("\n");
  return fold(a) === fold(b);
};

/**
 * What "Train on my data" reuses for a decision request: the newest of the product's decide-mode jobs on the same question
 * and labels that can be served as a decision model, was trained on r30b, and passes General's verdict. Null otherwise.
 */
export async function ownDecisionModelFor(productId: string, ask: { question: string; labels: readonly string[] }, deps: OwnModelDeps = STORE): Promise<{ adapterJobId: string } | null> {
  await deps.fill(productId);
  for (const job of await deps.jobs(productId)) {
    if (jobMode(job.params) !== DECIDE_MODE || !job.evalSummary) continue;
    const model = await deps.decisionModel(job.id);
    if (!model || model.question.trim() !== ask.question.trim() || !sameNames(model.labels.map((l) => l.name), ask.labels)) continue;
    const source = await deps.source(job.id);
    const sparkOpen = isSparkOpenDerivative({ params: source?.job.params, metrics: source?.metrics });
    if (!sparkOpen || !verdictFor(job.evalSummary, sparkOpen).passed) continue;
    return { adapterJobId: job.id };
  }
  return null;
}
