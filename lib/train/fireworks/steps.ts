/**
 * The fireworksTrain workflow's steps ("use step"). Resource names come from the job's id (fwNames), so a step that runs
 * again finds what it made. A cost the job reports above $0 ends it at once: the plan said $0 for training.
 */
import { platformApi, FireworksError, liveQuote } from "@/lib/train/fireworks/api";
import { evalAnswersUsd } from "@/lib/train/fireworks/cost";
import { FW_BASE_MODEL, FW_EVAL_MAX_TOKENS, moneyUsd } from "@/lib/train/fireworks/quote";
import { batchJsonl, fwNames, parseBatchOutput, trainJsonl } from "@/lib/train/fireworks/rows";
import { studentSystem } from "@/lib/train/hub-cards";
import { datasetSystemPrompt, unjudgedSummary } from "@/lib/train/logic";
import { datasetPage, finishJob, getDataset, getJob, recordEvalEvent, recordEvent, setEvalSummary, setJobCost, setStatus } from "@/lib/train/store";
import type { EvalExample, TrainExample } from "@/lib/train/types";

const ROWS_MAX = 1000;
const EVALS_READ = 200;
const DONE = "JOB_STATE_COMPLETED";
const ENDED_BADLY = new Set(["JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED", "JOB_STATE_EARLY_STOPPED", "JOB_STATE_DELETING", "JOB_STATE_DELETING_CLEANING_UP"]);

export type FwEnding = { action: "end"; status: "failed" | "stopped"; reason: string };
const fail = (reason: string): FwEnding => ({ action: "end", status: "failed", reason });
const said = (err: unknown) => (err instanceof FireworksError ? err.message : "Fireworks couldn't be reached.");

async function loaded(jobId: string) {
  const job = await getJob(jobId);
  if (!job) throw new Error("no such job");
  const datasetId = String(job.params?.datasetId ?? "");
  const dataset = await getDataset(datasetId);
  if (!dataset) throw new Error("no such dataset");
  return { job, dataset, datasetId, system: studentSystem(dataset.title, datasetSystemPrompt(dataset.task)), names: fwNames(jobId) };
}

/** Checks the cost once more, uploads the rows and creates the job. Ends it, deleted, when the job itself quotes above $0. */
export async function fwCreateStep(jobId: string): Promise<{ action: "go"; maxMinutes: number } | FwEnding> {
  "use step";
  const { job, datasetId, system, names } = await loaded(jobId);
  if (job.stopRequested) return { action: "end", status: "stopped", reason: "Stopped before training." };
  const api = platformApi();
  const quote = await liveQuote(api);
  if (!quote.ok) return fail(quote.reason);
  const page = await datasetPage(datasetId, "train", 0, ROWS_MAX);
  const { jsonl, count } = trainJsonl((page?.items ?? []) as TrainExample[], system);
  if (count < 3) return fail("Too few examples fit Fireworks' format.");
  await setStatus(jobId, "launching", { message: "Sending the examples to Fireworks." });
  try {
    const account = await api.account();
    await api.uploadDataset(names.trainDataset, jsonl);
    const made = await api.createSftJob(names.job, {
      baseModel: FW_BASE_MODEL,
      dataset: `accounts/${account}/datasets/${names.trainDataset}`,
      outputModel: `accounts/${account}/models/${names.model}`,
      displayName: `Muse Muse ${jobId.slice(0, 8)}`,
      epochs: Number(job.params?.epochs) || 1,
      loraRank: Number(job.params?.loraRank),
      learningRate: Number(job.params?.learningRate),
      maxContextLength: 4096,
    });
    const quoted = moneyUsd(made.estimatedCost);
    if (quoted !== null && quoted > 0) {
      await api.deleteSftJob(names.job);
      return fail(`Fireworks quoted this job at $${quoted.toFixed(2)}, not the $0 its pages state, so it was deleted before it trained.`);
    }
  } catch (err) {
    return fail(said(err));
  }
  await setStatus(jobId, "running", { message: "Fireworks has the job.", set: { launchedAt: new Date() } });
  return { action: "go", maxMinutes: job.maxMinutes };
}
fwCreateStep.maxRetries = 3;

/** One look at the training job, by polling: a protected Preview can't take callbacks. */
export async function fwCheckStep(jobId: string, lastPercent: number): Promise<{ action: "wait"; percent: number } | { action: "trained" } | FwEnding> {
  "use step";
  const job = await getJob(jobId);
  const names = fwNames(jobId);
  const api = platformApi();
  if (!job || job.stopRequested) {
    await api.deleteSftJob(names.job);
    return { action: "end", status: "stopped", reason: "Stopped, and removed from Fireworks." };
  }
  const remote = await api.getSftJob(names.job);
  const quoted = moneyUsd(remote.estimatedCost);
  if (quoted !== null && quoted > 0) {
    await api.deleteSftJob(names.job);
    return fail(`Fireworks quoted this job at $${quoted.toFixed(2)} while it ran, so it was deleted.`);
  }
  if (remote.state === DONE) return { action: "trained" };
  if (remote.state && ENDED_BADLY.has(remote.state)) return fail("Fireworks ended the training without finishing it.");
  const percent = Number(remote.jobProgress?.percent) || 0;
  if (percent !== lastPercent) await recordEvent(jobId, { type: "log", text: `Fireworks: ${percent}% trained.` });
  return { action: "wait", percent };
}
fwCheckStep.maxRetries = 3;

/** Past the time limit: removes the job from Fireworks. */
export async function fwAbandonStep(jobId: string): Promise<void> {
  "use step";
  await platformApi().deleteSftJob(fwNames(jobId).job);
}
fwAbandonStep.maxRetries = 5;

/**
 * Starts base and tuned on the kept-aside prompts, as two batch jobs: no deployment of ours bills per GPU-second. Skipped,
 * with why, when the plan's scoring limit doesn't cover it.
 */
export async function fwAnswerStartStep(jobId: string): Promise<{ action: "wait" } | { action: "skip"; note: string }> {
  "use step";
  const { job, datasetId, system, names } = await loaded(jobId);
  const ceiling = Number(job.params?.fwEvalMaxUsd) || 0;
  if (Number(job.params?.fwScoring) !== 1) return { action: "skip", note: `Not scored: answering its kept-aside prompts could cost up to $${ceiling.toFixed(2)} on Fireworks, more than this platform allows.` };
  const page = await datasetPage(datasetId, "eval", 0, EVALS_READ);
  const rows = (page?.items ?? []) as EvalExample[];
  if (!rows.length) return { action: "skip", note: "Not scored: it has no kept-aside prompts." };
  const api = platformApi();
  try {
    const account = await api.account();
    await api.uploadDataset(names.evalDataset, batchJsonl(rows, system, FW_EVAL_MAX_TOKENS));
    await api.createBatch(names.baseBatch, FW_BASE_MODEL, names.evalDataset, names.baseOut, FW_EVAL_MAX_TOKENS);
    await api.createBatch(names.tunedBatch, `accounts/${account}/models/${names.model}`, names.evalDataset, names.tunedOut, FW_EVAL_MAX_TOKENS);
  } catch (err) {
    return { action: "skip", note: `Not scored: ${said(err)}` };
  }
  return { action: "wait" };
}
fwAnswerStartStep.maxRetries = 3;

/** One look at both batch jobs. Once both finish: records the answers both gave, for the judge, and what they cost. */
export async function fwAnswerCheckStep(jobId: string): Promise<{ action: "wait" } | { action: "done"; usd: number; note: string | null }> {
  "use step";
  const { job, datasetId, names } = await loaded(jobId);
  const ceiling = Number(job.params?.fwEvalMaxUsd) || 0;
  const api = platformApi();
  const [base, tuned] = await Promise.all([api.getBatch(names.baseBatch), api.getBatch(names.tunedBatch)]);
  if ((base.state && ENDED_BADLY.has(base.state)) || (tuned.state && ENDED_BADLY.has(tuned.state))) {
    // What it billed before it ended isn't reported here, so the whole ceiling counts.
    return { action: "done", usd: ceiling, note: "Not scored: Fireworks didn't finish answering the kept-aside prompts." };
  }
  if (base.state !== DONE || tuned.state !== DONE) return { action: "wait" };
  const [b, t, page] = await Promise.all([api.readDataset(names.baseOut), api.readDataset(names.tunedOut), datasetPage(datasetId, "eval", 0, EVALS_READ)]);
  const baseOut = parseBatchOutput(b);
  const tunedOut = parseBatchOutput(t);
  const rows = (page?.items ?? []) as EvalExample[];
  let recorded = 0;
  for (const [index, row] of rows.entries()) {
    const baseAnswer = baseOut.answers.get(index);
    const tunedAnswer = tunedOut.answers.get(index);
    if (baseAnswer === undefined || tunedAnswer === undefined) continue;
    await recordEvalEvent(jobId, { type: "eval", index, prompt: row.prompt, reference: row.reference, base: baseAnswer, tuned: tunedAnswer });
    recorded += 1;
  }
  const usd = evalAnswersUsd(baseOut.tokens + tunedOut.tokens, Number(job.params?.fwRate), ceiling);
  return { action: "done", usd, note: recorded ? null : "Not scored: neither model's answers could be read from Fireworks' results." };
}
fwAnswerCheckStep.maxRetries = 3;

/** Ends the job with what it cost, and a reason when it can't be scored. */
export async function fwFinishStep(jobId: string, input: { status: "succeeded" | "failed" | "stopped"; reason: string; usd: number; note?: string | null }): Promise<void> {
  "use step";
  await finishJob(jobId, { status: input.status, reason: input.reason, terminatedAt: new Date() });
  // Below 0: answers were abandoned and may have billed, so the job's whole hold counts.
  const job = input.usd < 0 ? await getJob(jobId) : null;
  await setJobCost(jobId, input.usd < 0 ? (job?.maxUsd ?? 0) : input.usd);
  if (input.note) {
    await setEvalSummary(jobId, unjudgedSummary(input.note));
    await recordEvent(jobId, { type: "log", text: input.note });
  }
}
fwFinishStep.maxRetries = 20;

/** Removes the rows and batch jobs from Fireworks. The adapter is kept for export, unless the job didn't succeed. */
export async function fwCleanupStep(jobId: string, succeeded: boolean): Promise<void> {
  "use step";
  await removeFromFireworks(jobId, !succeeded);
}
fwCleanupStep.maxRetries = 3;

/** Everything of this job on Fireworks, with the job and its adapter when `all`. Every delete is tried. */
export async function removeFromFireworks(jobId: string, all: boolean): Promise<string[]> {
  const names = fwNames(jobId);
  const api = platformApi();
  const tries: Array<Promise<void>> = [api.deleteBatch(names.baseBatch), api.deleteBatch(names.tunedBatch), api.deleteDataset(names.trainDataset), api.deleteDataset(names.evalDataset), api.deleteDataset(names.baseOut), api.deleteDataset(names.tunedOut)];
  if (all) tries.push(api.deleteSftJob(names.job), api.deleteModel(names.model));
  const results = await Promise.allSettled(tries);
  return results.flatMap((r) => (r.status === "rejected" ? [said(r.reason)] : []));
}
