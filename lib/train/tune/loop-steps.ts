/**
 * The tuneLoop workflow's steps ("use step", docs/TRAINING.md "Tuning loop"). Each takes and returns small plain values
 * and is safe to run again: a round's datasets have fixed ids, and the launch holds the round's one launch claim.
 */
import { RetryableError } from "workflow";
import { start } from "workflow/api";
import { testModel } from "@/lib/env";
import { SPARK_STANDIN } from "@/lib/meta/spark";
import { limitCeilings } from "@/lib/train/gate";
import { DATASET_MODEL, makeDataset } from "@/lib/train/datasets";
import { ADAPTER_RECIPE, runEstimate, type TrainJobRow } from "@/lib/train/logic";
import { recipeById } from "@/lib/train/recipes";
import { attachDatasetRun, createDataset, failDataset, getDataset, getJob } from "@/lib/train/store";
import { focusTask, mergeRows, nextMove, roundBudget, roundScore, roundSteps, weakPrompts, type LoopSpec, type LoopStopCode, type NewRow } from "@/lib/train/tune/loop";
import { allRows, createRoundDataset, jobJudgements, loopSpent, readLoop, recordLoopEnded, roundDatasetId, writerDatasetId, type LoopRecord } from "@/lib/train/tune/loop-store";
import { launchForRun } from "@/lib/train/tune/run-launch";
import { latestTuneJob, readRunMarks, saveRunBase } from "@/lib/train/tune/run-store";
import { maxStepsFor } from "@/lib/train/tune/settings";
import { isTrainTerminal, type EvalExample, type TrainExample } from "@/lib/train/types";
import { newVersionPlan } from "@/lib/train/versions";

const DB_RETRY_AFTER = "30s";
/** After a job ends, how long a judge that never saved a summary is waited for. */
const JUDGE_WAIT_MS = 30 * 60_000;

async function fromDb<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw new RetryableError(`The database did not answer: ${err instanceof Error ? err.message : String(err)}`, { retryAfter: DB_RETRY_AFTER });
  }
}

async function mustLoop(loopId: string): Promise<LoopRecord> {
  const loop = await fromDb(() => readLoop(loopId));
  if (!loop) throw new Error("The tuning loop is gone.");
  return loop;
}

/** The estimated minutes of a round's job at this many steps on the source's GPU. */
function estimateMinutes(job: TrainJobRow, steps: number): number {
  const { baseScale, baseBytes } = (job.params ?? {}) as Record<string, string | number | undefined>;
  const params = { maxSteps: steps, ...(Number(baseScale) > 0 ? { baseScale, baseBytes } : {}) };
  return runEstimate(ADAPTER_RECIPE, params, job.instanceType, true)?.minutes ?? job.maxMinutes;
}

/** How many training steps a round gets on `train` rows. */
function stepsFor(job: TrainJobRow, sourceTrain: number, train: number, maxMinutes: number): number {
  const sourceSteps = Number(job.params?.maxSteps) > 0 ? Number(job.params!.maxSteps) : 120;
  const scale = Number(job.params?.baseScale);
  const bytes = Number(job.params?.baseBytes);
  const base = scale > 0 ? { repo: "", revision: "", scale, bytes } : undefined;
  return roundSteps(sourceSteps, sourceTrain, train, maxStepsFor({ recipe: "glimmer-lora", gpu: job.instanceType, maxMinutes, ...(base ? { base } : {}) }));
}

/** The source's job: the settings every round copies. */
async function sourceJob(spec: LoopSpec): Promise<TrainJobRow> {
  const job = await fromDb(() => getJob(spec.sourceJobId));
  if (!job) throw new Error("The loop's first job is gone.");
  return job;
}

export type NextStep = { kind: "go" } | { kind: "stop"; code: LoopStopCode };

/**
 * Judges what the round before `round` came to and decides. To go, it saves the writer's dataset, aimed at the last
 * round's weak prompts, and starts it. This is the only place a round's money starts.
 */
export async function loopNextStep(loopId: string, round: number): Promise<NextStep> {
  "use step";
  const loop = await mustLoop(loopId);
  const { spec } = loop;
  const finish = async (code: LoopStopCode): Promise<NextStep> => {
    await fromDb(() => recordLoopEnded(loop, code));
    return { kind: "stop", code };
  };
  if (loop.ended) return { kind: "stop", code: loop.ended as LoopStopCode };

  const writerId = writerDatasetId(loopId, round);
  const written = await fromDb(() => getDataset(writerId));
  if (written) return { kind: "go" }; // An earlier try of this step got this far.

  const lastDataset = round === 1 ? spec.sourceDatasetId : roundDatasetId(loopId, round - 1);
  // Round 1 reads the job the loop started from, even if someone trained another version on that dataset since.
  const lastJob = await fromDb(() => (round === 1 ? getJob(spec.sourceJobId) : latestTuneJob(lastDataset)));
  const judgements = lastJob ? await fromDb(() => jobJudgements(lastJob.id)) : [];
  const keptAside = await fromDb(() => allRows<EvalExample>(spec.sourceDatasetId, "eval"));
  const weak = weakPrompts(judgements, keptAside.map((e) => e.prompt), spec.target);
  const [source, job, spent] = await Promise.all([fromDb(() => getDataset(spec.sourceDatasetId)), sourceJob(spec), fromDb(() => loopSpent(loopId, round - 1))]);
  if (!source) return finish("error");
  const ceilings = limitCeilings();
  const maxMinutes = Math.min(job.maxMinutes, ceilings.maxMinutes);
  const last = await fromDb(() => getDataset(lastDataset));
  const steps = stepsFor(job, source.trainCount, (last?.trainCount ?? 0) + spec.examples, maxMinutes);
  const { fits } = roundBudget({ capUsd: spec.capUsd, spentUsd: spent, writerUsd: spec.metaHighUsd, scoreHighUsd: spec.scoreHighUsd, ceilingUsd: ceilings.maxUsd, maxMinutes, priceCentsPerHour: job.priceCentsPerHour, estimateMinutes: estimateMinutes(job, steps) });
  const move = nextMove({ stopped: loop.stopped, finished: round - 1, maxRounds: spec.maxRounds, jobStatus: lastJob?.status ?? null, score: roundScore(judgements, spec.target), weakCount: weak.length, fits });
  if (move.kind === "stop") return finish(move.code);

  const writerModel = testModel() ?? (source.writerModel === SPARK_STANDIN ? SPARK_STANDIN : DATASET_MODEL);
  await fromDb(() => createDataset({ id: writerId, title: `${source.title} (loop round ${round} extra examples)`, task: focusTask(source.task, weak), requested: spec.examples, writerModel, createdBy: spec.callerId }));
  try {
    const { runId } = await start(makeDataset, [{ datasetId: writerId }]);
    await attachDatasetRun(writerId, runId).catch((err) => console.error("[train/tune] loop attach", err));
  } catch (err) {
    console.error("[train/tune] loop writer", err);
    await failDataset(writerId, "The dataset's workflow could not start, so nothing was written.").catch(() => undefined);
    return finish("data_failed");
  }
  return { kind: "go" };
}
loopNextStep.maxRetries = 5;

export type WriterState = { kind: "writing" } | { kind: "ready" } | { kind: "stop"; code: LoopStopCode };

/**
 * Where the round's writing stands, stopping it as soon as it costs more than the cap leaves for it: what the cap holds
 * for the round less the judging estimate and what the job needs.
 */
export async function loopWriterStep(loopId: string, round: number): Promise<WriterState> {
  "use step";
  const loop = await mustLoop(loopId);
  const { spec } = loop;
  if (loop.ended) return { kind: "stop", code: loop.ended as LoopStopCode };
  const writerId = writerDatasetId(loopId, round);
  const writer = await fromDb(() => getDataset(writerId));
  const stop = async (code: LoopStopCode): Promise<WriterState> => {
    await fromDb(() => recordLoopEnded(loop, code));
    return { kind: "stop", code };
  };
  if (!writer || writer.status === "failed") return stop("data_failed");
  const job = await sourceJob(spec);
  const ceilings = limitCeilings();
  const maxMinutes = Math.min(job.maxMinutes, ceilings.maxMinutes);
  const spent = await fromDb(() => loopSpent(loopId, round - 1));
  const sourceSteps = Number(job.params?.maxSteps) > 0 ? Number(job.params!.maxSteps) : 120;
  const { fits } = roundBudget({ capUsd: spec.capUsd, spentUsd: spent, writerUsd: writer.costUsd, scoreHighUsd: spec.scoreHighUsd, ceilingUsd: ceilings.maxUsd, maxMinutes, priceCentsPerHour: job.priceCentsPerHour, estimateMinutes: estimateMinutes(job, sourceSteps) });
  if (!fits) {
    await fromDb(() => failDataset(writerId, "The tuning loop's spend cap was reached while writing."));
    return stop("cap");
  }
  return writer.status === "ready" ? { kind: "ready" } : { kind: "writing" };
}
loopWriterStep.maxRetries = 20;

/**
 * Makes the round's dataset: the last round's training rows and the new ones under the source's system message, with the
 * source's kept-aside prompts unchanged and in order, so eval indexes mean the same prompt on every round. The new
 * dataset's own held-out rows join training (they were never kept aside for this model).
 */
export async function loopMergeStep(loopId: string, round: number): Promise<{ ok: true; datasetId: string } | { ok: false; code: LoopStopCode }> {
  "use step";
  const loop = await mustLoop(loopId);
  const { spec } = loop;
  const datasetId = roundDatasetId(loopId, round);
  if (await fromDb(() => getDataset(datasetId))) return { ok: true, datasetId };
  const writerId = writerDatasetId(loopId, round);
  const lastId = round === 1 ? spec.sourceDatasetId : roundDatasetId(loopId, round - 1);
  const [source, writer, previous, keptAside, sourceTrain, writerTrain, writerEval, marks] = await fromDb(() =>
    Promise.all([
      getDataset(spec.sourceDatasetId),
      getDataset(writerId),
      allRows<TrainExample>(lastId, "train"),
      allRows<EvalExample>(spec.sourceDatasetId, "eval"),
      allRows<TrainExample>(spec.sourceDatasetId, "train"),
      allRows<TrainExample>(writerId, "train"),
      allRows<EvalExample>(writerId, "eval"),
      readRunMarks(spec.sourceDatasetId),
    ]),
  );
  if (!source || !writer) return stopMerge(loop, "error");
  const fresh: NewRow[] = [
    ...writerTrain.map((e) => ({ prompt: e.messages.find((m) => m.role === "user")?.content ?? "", answer: e.messages.find((m) => m.role === "assistant")?.content ?? "" })),
    ...writerEval.map((e) => ({ prompt: e.prompt, answer: e.reference })),
  ];
  const system = sourceTrain[0]?.messages.find((m) => m.role === "system")?.content ?? "";
  const merged = mergeRows(previous, fresh, keptAside.map((e) => e.prompt), system);
  if (!merged.added) return stopMerge(loop, "no_new_rows");
  // A Contributor writer's rows keep their restrictions in whatever they join (keepDatasetPrivate on the Hub).
  const writerModel = source.writerModel === SPARK_STANDIN || writer.writerModel === SPARK_STANDIN ? SPARK_STANDIN : writer.writerModel;
  // The base first: a round that lost it would train on another model.
  await fromDb(() => saveRunBase(datasetId, marks.base ?? null));
  await fromDb(() => createRoundDataset({ id: datasetId, title: source.title, task: source.task, train: merged.train, eval: keptAside, writerModel, createdBy: spec.callerId }));
  return { ok: true, datasetId };
}
loopMergeStep.maxRetries = 5;

async function stopMerge(loop: LoopRecord, code: LoopStopCode): Promise<{ ok: false; code: LoopStopCode }> {
  await fromDb(() => recordLoopEnded(loop, code));
  return { ok: false, code };
}

export type LoopLaunch = { kind: "launched"; jobId: string } | { kind: "wait" } | { kind: "stop"; code: LoopStopCode };

/**
 * One try at training a round: a new adapter from the base, with the source job's settings, publish 0, and a hard dollar
 * limit of what the cap has left, after what writing cost and the judging estimate.
 */
export async function loopLaunchStep(loopId: string, round: number): Promise<LoopLaunch> {
  "use step";
  const loop = await mustLoop(loopId);
  const { spec } = loop;
  const stop = async (code: LoopStopCode): Promise<LoopLaunch> => {
    await fromDb(() => recordLoopEnded(loop, code));
    return { kind: "stop", code };
  };
  if (loop.stopped || loop.ended) return { kind: "stop", code: "stopped" };
  const datasetId = roundDatasetId(loopId, round);
  const [job, source, dataset, writer, spent] = await Promise.all([sourceJob(spec), fromDb(() => getDataset(spec.sourceDatasetId)), fromDb(() => getDataset(datasetId)), fromDb(() => getDataset(writerDatasetId(loopId, round))), fromDb(() => loopSpent(loopId, round - 1))]);
  if (!source || !dataset) return stop("error");
  const ceilings = limitCeilings();
  const maxMinutes = Math.min(job.maxMinutes, ceilings.maxMinutes);
  const steps = stepsFor(job, source.trainCount, dataset.trainCount, maxMinutes);
  const budget = roundBudget({ capUsd: spec.capUsd, spentUsd: spent, writerUsd: writer?.costUsd ?? 0, scoreHighUsd: spec.scoreHighUsd, ceilingUsd: ceilings.maxUsd, maxMinutes, priceCentsPerHour: job.priceCentsPerHour, estimateMinutes: estimateMinutes(job, steps) });
  if (!budget.fits) return stop("cap");
  const plan = newVersionPlan(job, recipeById(ADAPTER_RECIPE)?.params ?? []);
  if (!plan) return stop("refused");
  const r = await launchForRun({
    datasetId,
    callerId: spec.callerId,
    steps,
    job: { params: { ...plan.params, datasetId, maxSteps: steps, publish: 0 }, instanceType: plan.instanceType, maxMinutes, maxUsd: budget.gpuUsd },
  });
  if (r.kind === "launched") return { kind: "launched", jobId: r.jobId };
  if (r.kind === "wait") return { kind: "wait" };
  return stop(r.kind === "stopped" ? "stopped" : "refused");
}
loopLaunchStep.maxRetries = 3;

/** True once the job has ended and judging has ended too, or has had its time. */
export async function loopJobEndedStep(jobId: string): Promise<boolean> {
  "use step";
  const job = await fromDb(() => getJob(jobId));
  if (!job) return true;
  if (!isTrainTerminal(job.status)) return false;
  if (job.status !== "succeeded" || job.evalSummary) return true;
  const ended = job.finishedAt ? job.finishedAt.getTime() : 0;
  return Date.now() - ended > JUDGE_WAIT_MS;
}
loopJobEndedStep.maxRetries = 20;

/** Records how the workflow itself ended, for an ending no step recorded. */
export async function loopEndStep(loopId: string, code: LoopStopCode): Promise<void> {
  "use step";
  const loop = await mustLoop(loopId);
  await fromDb(() => recordLoopEnded(loop, code));
}
loopEndStep.maxRetries = 20;
