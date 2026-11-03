/**
 * Judging a fine-tuning job's eval items (docs/TRAINING.md "Judging"): Muse Wonder (JUDGE_MODEL) scores the base and the
 * tuned model's answers to each held-out prompt from 1 to 10 against the dataset writer's reference answer. The judge is
 * saved on the job (judge_model) as judging starts; jobs judged before Oct 29, 2026 have none and were judged by Muse
 * Spark 1.3. The training workflow (lib/train/workflow.ts) runs these steps only after the job's instance is terminated
 * and only for a job that succeeded, so judging never keeps a GPU billing, and a failure here never changes the job's
 * status.
 *
 * The judge sees the two answers blind, as A and B, with the base model's first on even indexes and second on odd ones,
 * so neither its labels nor its position favors one model. Each verdict is logged as a "judgement" event, which also
 * makes judgeStep safe to run again: an item already judged isn't sent to Meta twice. How judging ended is saved on the
 * job as its eval summary, including when it was skipped or judged nothing (unjudgedSummary, with the reason), so the
 * job page never has to read it from the log, which the job's runner can write to.
 *
 * With TUNE_GENERAL_CHECKS on at launch, a job also sends the fixed general-ability and safety checks as eval items
 * (lib/train/general-checks.ts). The plan sets them apart, each with its own task line for the judge, judgeStep scores
 * them like any item, and the summary keeps them beside the task's result (EvalSummary.general and .safety). A job
 * without them is judged exactly as before.
 */
import { modelLabel } from "@/lib/format";
import { spendPaused } from "@/lib/quota";
import { checkTask, splitCheckIndexes, type CheckSet } from "@/lib/train/general-checks";
import {
  summarizeJudgements,
  unjudgedSummary,
  withCheckSummaries,
  type JudgedChecks,
  type JudgedItem,
} from "@/lib/train/logic";
import {
  getDataset,
  getEvalItem,
  getJob,
  getJudgement,
  listEvalIndexes,
  recordEvent,
  setEvalSummary,
  setJudgeModel,
} from "@/lib/train/store";
import type { EvalSummary } from "@/lib/train/types";
import { defaultModel } from "@/lib/meta/spark";
import { fromDb, judgePair } from "@/lib/train/judge-pair";

/**
 * The model that judges a job's eval items, saved on the job as its judge_model when judging starts. Muse Spark 1.3
 * judged every job before Oct 29, 2026 and is never used for new judging.
 */
export const JUDGE_MODEL = defaultModel();

/** A general check set to judge: its eval indexes and the task line the judge sees for it (checkTask). */
export interface CheckPlan {
  indexes: number[];
  task: string;
}

/** What judgePlanStep hands the workflow. `checks` only for a job that sent general checks beside its task items. */
export interface JudgePlan {
  indexes: number[];
  task: string | null;
  checks?: Partial<Record<CheckSet, CheckPlan>>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------------------------------------------
// Steps

/**
 * What to judge: the indexes of the job's eval items, and the task of its dataset (params.datasetId) when it has one.
 * Nothing when it has no eval items or a summary already, and nothing when MODEL_API_KEY isn't set or the platform's
 * daily spend cap is reached: then it saves an unjudged summary that says why, and logs it. Otherwise it saves
 * JUDGE_MODEL as the job's judge_model before it logs that judging started. When the job sent general checks
 * (indexes from lib/train/general-checks.ts) beside its task items, `indexes` holds only the task items and `checks`
 * the rest, each set with its task line; a job without them gets no `checks`, and the plan is exactly as before.
 */
export async function judgePlanStep(jobId: string): Promise<JudgePlan> {
  "use step";
  const none = { indexes: [], task: null };
  const all = await fromDb(() => listEvalIndexes(jobId));
  if (!all.length) return none;
  const job = await fromDb(() => getJob(jobId));
  if (!job || job.evalSummary) return none;
  const skip = !process.env.MODEL_API_KEY
    ? "MODEL_API_KEY isn't set"
    : (await fromDb(() => spendPaused()))
      ? "the platform's daily spend cap is reached"
      : null;
  if (skip) {
    const note = `Judging skipped: ${skip}.`;
    await fromDb(() => setEvalSummary(jobId, unjudgedSummary(note)));
    await fromDb(() => recordEvent(jobId, { type: "log", text: note }));
    return none;
  }
  const datasetId = typeof job.params?.datasetId === "string" ? job.params.datasetId : null;
  const dataset = datasetId ? await fromDb(() => getDataset(datasetId)) : null;
  // Checks are set apart only beside task items, so a job that sent none of them is judged as before.
  const split = splitCheckIndexes(all);
  const hasChecks = split.task.length > 0 && split.general.length + split.safety.length > 0;
  const indexes = hasChecks ? split.task : all;
  const checks: Partial<Record<CheckSet, CheckPlan>> = {};
  for (const set of ["general", "safety"] as const) {
    if (hasChecks && split[set].length) checks[set] = { indexes: split[set], task: checkTask(set) };
  }
  const n = indexes.length;
  const also = hasChecks ? `, ${plural(split.general.length, "general check")} and ${plural(split.safety.length, "safety check")}` : "";
  await fromDb(() => setJudgeModel(jobId, JUDGE_MODEL));
  await fromDb(() => recordEvent(jobId, { type: "log", text: `${modelLabel(JUDGE_MODEL)} is judging ${plural(n, "eval item")}${also}.` }));
  return hasChecks ? { indexes, task: dataset?.task ?? null, checks } : { indexes, task: dataset?.task ?? null };
}
judgePlanStep.maxRetries = 3;

/**
 * Judges one eval item: JUDGE_MODEL scores the base and the tuned answer against the reference, blind. Records the
 * usage, then logs the verdict as a "judgement" event, and returns it with what it cost. An item that already has a
 * judgement (an earlier attempt logged it) is returned as it is, at no cost; a missing item is null.
 */
export async function judgeStep(jobId: string, index: number, task: string | null): Promise<JudgedItem | null> {
  "use step";
  const done = await fromDb(() => getJudgement(jobId, index));
  if (done) return { baseScore: done.baseScore, tunedScore: done.tunedScore, better: done.better, costUsd: 0 };
  const item = await fromDb(() => getEvalItem(jobId, index));
  if (!item) return null;

  const v = await judgePair({ model: JUDGE_MODEL, task, index, prompt: item.prompt, reference: item.reference, base: item.base, tuned: item.tuned });
  await fromDb(() => recordEvent(jobId, { type: "judgement", index, baseScore: v.baseScore, tunedScore: v.tunedScore, better: v.better, note: v.note }));
  return { baseScore: v.baseScore, tunedScore: v.tunedScore, better: v.better, costUsd: v.costUsd };
}

judgeStep.maxRetries = 2;

/** The log's sentence for one judged check set. */
function checkLine(label: string, c: NonNullable<EvalSummary["general"]>): string {
  if (!c.items) return ` ${label}: none of the ${c.asked} could be judged.`;
  return (
    ` ${label}: judged ${c.items} of ${c.asked}, the tuned model better on ${c.tunedWins}, the base model on ${c.baseWins}, ` +
    `${c.ties} tied, average ${c.avgTunedScore} tuned, ${c.avgBaseScore} base.`
  );
}

/**
 * Writes the job's eval summary from the judged items and logs it. When none could be judged it saves an unjudged
 * summary that says so, logs that and returns null. `checks`, only for a job that sent general checks, go beside the
 * task's numbers (withCheckSummaries) and into the log line. Never touches the job's status.
 */
export async function saveEvalSummaryStep(
  jobId: string,
  items: JudgedItem[],
  asked: number,
  checks?: { general?: JudgedChecks; safety?: JudgedChecks },
): Promise<EvalSummary | null> {
  "use step";
  if (!items.length) {
    const note = `Judging failed: none of the ${asked} eval items could be judged.`;
    await fromDb(() => setEvalSummary(jobId, unjudgedSummary(note)));
    await fromDb(() => recordEvent(jobId, { type: "log", text: note }));
    return null;
  }
  const s = checks ? withCheckSummaries(summarizeJudgements(items), checks) : summarizeJudgements(items);
  await fromDb(() => setEvalSummary(jobId, s));
  const text =
    `Judged ${s.items} of ${asked} eval items: the tuned model was better on ${s.tunedWins}, the base model on ` +
    `${s.baseWins}, and ${s.ties} tied. Average score ${s.avgTunedScore} tuned, ${s.avgBaseScore} base.` +
    (s.general ? checkLine("General checks", s.general) : "") +
    (s.safety ? checkLine("Safety checks", s.safety) : "") +
    ` Judging cost $${s.judgeCostUsd.toFixed(4)}.`;
  await fromDb(() => recordEvent(jobId, { type: "log", text }));
  return s;
}
saveEvalSummaryStep.maxRetries = 20;
