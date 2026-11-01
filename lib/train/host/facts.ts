/** What a tuned job's record says about hosting it. Pure: the routes read the job and pass it in. */
import { BASE_MODEL_PARAM, familyOfRepo, isSparkOpenDerivative, LAB_MERGE_BASE, LAB_MERGE_BASE_REVISION, licenseDuties } from "@/lib/train/base";
import { COMMIT_RE } from "@/lib/train/bases";
import { ADAPTER_RECIPE, adapterProblem, CHAT_MODE, jobMode, type DoneMetrics, type TrainJobRow } from "@/lib/train/logic";
import { evalVerdict } from "@/lib/train/tune/verdict";
import type { HostFacts } from "@/lib/train/host/types";

export const BASE_REVISION_PARAM = "baseRevision";

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * The weights to load the adapter onto outside the lab. A plain Glimmer adapter gets none: the job records only its 4-bit
 * training copy's commit, and an unpinned base could change under it.
 */
function servingBase(job: Pick<TrainJobRow, "params">, metrics: DoneMetrics | null, sparkOpen: boolean): HostFacts["servingBase"] {
  if (sparkOpen) return { repo: LAB_MERGE_BASE, revision: LAB_MERGE_BASE_REVISION };
  const asked = text(job.params?.[BASE_MODEL_PARAM]) ?? text(metrics?.base_model);
  if (!asked || !familyOfRepo(asked)?.startsWith("llama")) return null;
  const revision = text(job.params?.[BASE_REVISION_PARAM]);
  return revision && COMMIT_RE.test(revision) ? { repo: asked, revision } : null;
}

/** Why it can't be hosted at all, or null. Only a real chat model that passed: decision models answer one letter. */
function hostProblem(job: Pick<TrainJobRow, "recipe" | "status" | "params" | "evalSummary">, sparkOpen: boolean): string | null {
  if (job.recipe !== ADAPTER_RECIPE || job.status !== "succeeded") return "Only a finished tuned model can be hosted.";
  if (Number(job.params?.dryRun) >= 1) return "A dry run's adapter is a stand-in, so it can't be hosted.";
  if (jobMode(job.params) !== CHAT_MODE) return "Decision models aren't chat models, so these endpoints can't serve them.";
  if (!job.evalSummary) return "This model hasn't been judged yet, so it hasn't passed.";
  return evalVerdict(job.evalSummary, sparkOpen).passed ? null : "This model didn't pass its judging, so it can't be hosted.";
}

export function hostFacts(job: TrainJobRow, metrics: DoneMetrics | null): HostFacts {
  const sparkOpen = isSparkOpenDerivative({ params: job.params, metrics });
  const asked = text(job.params?.[BASE_MODEL_PARAM]) ?? text(metrics?.base_model);
  const rank = Number(job.params?.loraRank);
  const hub = job.hub;
  return {
    adapterJobId: job.id,
    family: familyOfRepo(asked) ?? "glimmer",
    sparkOpen,
    rank: Number.isFinite(rank) && rank > 0 ? rank : null,
    hubRepo: text(hub?.modelRepo),
    hubCommit: hub?.status === "published" ? text(hub.modelCommit) : null,
    servingBase: servingBase(job, metrics, sparkOpen),
    lambdaProblem: adapterProblem(job, metrics),
    duties: licenseDuties({ params: job.params, metrics }),
    problem: hostProblem(job, sparkOpen),
  };
}
