import { isSparkOpenDerivative, verdictFor } from "@/lib/caps/gpu/general";
import { fillProductIds, productAdapterJobs } from "@/lib/caps/gpu/store";
import type { OwnModel } from "@/lib/caps/gpu/types";
import { adapterProblem, CHAT_MODE, jobMode, trainChannelOf } from "@/lib/train/logic";
import { getAdapterSource } from "@/lib/train/store";

export interface OwnModelDeps {
  fill(productId: string): Promise<void>;
  jobs: typeof productAdapterJobs;
  source: typeof getAdapterSource;
}

const STORE: OwnModelDeps = { fill: fillProductIds, jobs: productAdapterJobs, source: getAdapterSource };

/**
 * The contract's ownModelFor: a product's own chat model, the newest job trained for it that General's evalVerdict passes
 * and whose adapter can still be served: a real run on the model cache (adapterProblem), and trained on r30b, since serve
 * jobs now load r30b and a plain Glimmer adapter would load without error and answer as a model nobody evaluated. Reading
 * only, apart from filling training_jobs.product_id from the run's record. Null when nothing qualifies.
 *
 * A decision model isn't a chat model, so it's never this: a product calls one through {GATEWAY_URL}/decide by its id.
 */
export async function ownModelFor(productId: string, _now: Date = new Date(), deps: OwnModelDeps = STORE): Promise<OwnModel | null> {
  await deps.fill(productId);
  for (const job of await deps.jobs(productId)) {
    if (jobMode(job.params) !== CHAT_MODE || !job.evalSummary) continue;
    const source = await deps.source(job.id);
    if (!source || adapterProblem(source.job, source.metrics)) continue;
    const sparkOpen = isSparkOpenDerivative({ params: source.job.params, metrics: source.metrics });
    if (!sparkOpen || !verdictFor(job.evalSummary, sparkOpen).passed) continue;
    return { adapterJobId: job.id, trainChannel: trainChannelOf(job.params) };
  }
  return null;
}
