/**
 * What a tuning loop keeps (docs/TRAINING.md "Tuning loop"). No migration: its settings, ending and stop are rate_limits
 * rows under the window that never starts, as a run's marks are (./run-store.ts), and its rounds' datasets have fixed ids
 * made from the loop's (loopUuid), so each round's job is latestTuneJob(the dataset).
 *   tune-loop:<id>:spec:<source dataset>:<settings as base64url JSON>
 *   tune-loop-end:<id>:<code>
 *   tune-loop-stop:<id>
 *   tune-loop-open:<source dataset>   held from start to end: one running loop on a run, so a double click can't spend twice
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, like, or } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { TUNE_KEEP_WINDOW, latestTuneJob, markCode, markRunStopped } from "@/lib/train/tune/run-store";
import { roundScore, stopText, weakPrompts, type LoopJudgement, type LoopRoundView, type LoopSpec, type LoopView } from "@/lib/train/tune/loop";
import { datasetPage, failDataset, getDataset, getJob, requestStop } from "@/lib/train/store";
import { isTrainTerminal, type EvalExample, type TrainExample } from "@/lib/train/types";

/** A fixed uuid for a loop's dataset, so a step that runs twice finds the row it made. */
export function loopUuid(loopId: string, part: string): string {
  const h = createHash("sha256").update(`tune-loop:${loopId}:${part}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** The dataset Muse Wonder writes a round's new examples into. */
export const writerDatasetId = (loopId: string, round: number) => loopUuid(loopId, `writer:${round}`);
/** The dataset a round trains on: the last round's rows and the new ones, with the source's kept-aside prompts. */
export const roundDatasetId = (loopId: string, round: number) => loopUuid(loopId, `round:${round}`);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const limits = schema.rateLimits;
const events = schema.trainingEvents;
const openKey = (source: string) => `tune-loop-open:${source}`;
const specPrefix = (id: string) => `tune-loop:${id}:spec:`;
const encode = (spec: LoopSpec) => Buffer.from(JSON.stringify(spec)).toString("base64url");

function decode(key: string): { id: string; spec: LoopSpec } | null {
  const m = /^tune-loop:([^:]+):spec:[^:]+:([A-Za-z0-9_-]+)$/.exec(key);
  if (!m) return null;
  try {
    return { id: m[1]!, spec: JSON.parse(Buffer.from(m[2]!, "base64url").toString()) as LoopSpec };
  } catch {
    return null;
  }
}

/** Starts a loop's record, or null while another loop runs on this source. */
export async function createLoop(spec: LoopSpec): Promise<string | null> {
  const claimed = await db().insert(limits).values({ key: openKey(spec.sourceDatasetId), windowStart: TUNE_KEEP_WINDOW, count: 1 }).onConflictDoNothing().returning({ key: limits.key });
  if (!claimed.length) return null;
  const id = randomUUID();
  await db().insert(limits).values({ key: `${specPrefix(id)}${spec.sourceDatasetId}:${encode(spec)}`, windowStart: TUNE_KEEP_WINDOW, count: 1 });
  return id;
}

export interface LoopRecord {
  id: string;
  spec: LoopSpec;
  stopped: boolean;
  ended: string | null;
}

export async function readLoop(id: string): Promise<LoopRecord | null> {
  if (!UUID_RE.test(id)) return null;
  const rows = await db()
    .select({ key: limits.key })
    .from(limits)
    .where(and(or(like(limits.key, `${specPrefix(id)}%`), like(limits.key, `tune-loop-end:${id}:%`), eq(limits.key, `tune-loop-stop:${id}`)), eq(limits.windowStart, TUNE_KEEP_WINDOW)));
  const spec = rows.map((r) => decode(r.key)).find(Boolean)?.spec;
  if (!spec) return null;
  const ended = rows.find((r) => r.key.startsWith(`tune-loop-end:${id}:`))?.key.slice(`tune-loop-end:${id}:`.length) ?? null;
  return { id, spec, stopped: rows.some((r) => r.key === `tune-loop-stop:${id}`), ended };
}

/** The loops started from a run, oldest first. */
export async function loopsOfRun(sourceDatasetId: string): Promise<LoopRecord[]> {
  if (!UUID_RE.test(sourceDatasetId)) return [];
  const rows = await db()
    .select({ key: limits.key })
    .from(limits)
    .where(and(like(limits.key, `tune-loop:%:spec:${sourceDatasetId}:%`), eq(limits.windowStart, TUNE_KEEP_WINDOW)));
  const found = await Promise.all(rows.map((r) => decode(r.key)).filter((d): d is NonNullable<typeof d> => Boolean(d)).map((d) => readLoop(d.id)));
  return found.filter((l): l is LoopRecord => Boolean(l)).sort((a, b) => a.spec.startedAt.localeCompare(b.spec.startedAt));
}

/** The first ending stands, so "stopped" isn't replaced by what the workflow saw next. Frees the run for a new loop. */
export async function recordLoopEnded(loop: Pick<LoopRecord, "id" | "spec">, code: string): Promise<void> {
  const [already] = await db().select({ key: limits.key }).from(limits).where(and(like(limits.key, `tune-loop-end:${loop.id}:%`), eq(limits.windowStart, TUNE_KEEP_WINDOW))).limit(1);
  if (!already) await db().insert(limits).values({ key: `tune-loop-end:${loop.id}:${markCode(code)}`, windowStart: TUNE_KEEP_WINDOW, count: 1 }).onConflictDoNothing();
  await db().delete(limits).where(and(eq(limits.key, openKey(loop.spec.sourceDatasetId)), eq(limits.windowStart, TUNE_KEEP_WINDOW)));
}

/**
 * Stops a loop for good: its mark, every round's run marked stopped ahead of time (launchForRun never launches for one,
 * even a round whose dataset doesn't exist yet), a writer in progress failed (its steps stop paying), and a job in
 * progress asked to stop. Ends the loop at once, so a workflow that died can't hold the run. Pressing it again is the same.
 */
export async function stopLoop(loop: LoopRecord): Promise<void> {
  await db().insert(limits).values({ key: `tune-loop-stop:${loop.id}`, windowStart: TUNE_KEEP_WINDOW, count: 1 }).onConflictDoNothing();
  for (let round = 1; round <= loop.spec.maxRounds; round++) {
    const datasetId = roundDatasetId(loop.id, round);
    await markRunStopped(datasetId);
    await failDataset(writerDatasetId(loop.id, round), "The tuning loop was stopped.");
    const job = await latestTuneJob(datasetId);
    if (job && !isTrainTerminal(job.status)) await requestStop(job.id);
  }
  await recordLoopEnded(loop, "stopped");
}

/** A job's judgements, the first per index, from the platform's own "judgement" events. */
export async function jobJudgements(jobId: string): Promise<LoopJudgement[]> {
  if (!UUID_RE.test(jobId)) return [];
  const rows = await db().select({ payload: events.payload }).from(events).where(and(eq(events.jobId, jobId), eq(events.type, "judgement"))).orderBy(asc(events.id)).limit(400);
  const out = new Map<number, LoopJudgement>();
  for (const { payload } of rows) {
    const p = payload as { index?: unknown; baseScore?: unknown; tunedScore?: unknown; better?: unknown } | null;
    if (!p || !Number.isInteger(p.index) || out.has(p.index as number)) continue;
    const better = p.better === "tuned" || p.better === "base" ? p.better : "tie";
    out.set(p.index as number, { index: p.index as number, baseScore: Number(p.baseScore) || 0, tunedScore: Number(p.tunedScore) || 0, better });
  }
  return [...out.values()].sort((a, b) => a.index - b.index);
}

/** Every row of one part of a dataset. */
export async function allRows<T extends TrainExample | EvalExample>(datasetId: string, part: "train" | "eval"): Promise<T[]> {
  const page = await datasetPage(datasetId, part, 0, 2000);
  return (page?.items ?? []) as T[];
}

/**
 * A round's dataset, ready at once and written only here. The source's title and task, unchanged: the title is the
 * tuned model's training line, the task is what the judge reads and what the Hub's person's-rows check reads, so a
 * change to either would make rounds incomparable or weaken that check. Safe to run twice.
 */
export async function createRoundDataset(input: {
  id: string;
  title: string;
  task: string;
  train: TrainExample[];
  eval: EvalExample[];
  writerModel: string | null;
  createdBy: string | null;
}): Promise<void> {
  await db()
    .insert(schema.trainingDatasets)
    .values({
      id: input.id,
      title: input.title,
      task: input.task,
      status: "ready",
      requested: input.train.length + input.eval.length,
      train: input.train,
      eval: input.eval,
      trainCount: input.train.length,
      evalCount: input.eval.length,
      writerModel: input.writerModel,
      createdBy: input.createdBy,
      finishedAt: new Date(),
    })
    .onConflictDoNothing();
}

const roundMoney = (n: number) => Math.round(n * 1e6) / 1e6;

/** A finished or running round's cost so far: writing, the GPU and judging. Nothing for a round not started. */
export async function roundCost(loopId: string, round: number): Promise<number> {
  const [writer, job] = await Promise.all([getDataset(writerDatasetId(loopId, round)), latestTuneJob(roundDatasetId(loopId, round))]);
  return roundMoney((writer?.costUsd ?? 0) + (job?.costUsd ?? 0) + (Number(job?.evalSummary?.judgeCostUsd) || 0));
}

/** What rounds 1 to `through` have cost. */
export async function loopSpent(loopId: string, through: number): Promise<number> {
  const costs = await Promise.all(Array.from({ length: Math.max(0, through) }, (_, i) => roundCost(loopId, i + 1)));
  return roundMoney(costs.reduce((a, b) => a + b, 0));
}

/** A loop and every round so far, for its page and GET /api/train/loops/{id}. */
export async function loadLoopView(id: string): Promise<LoopView | null> {
  const loop = await readLoop(id);
  if (!loop) return null;
  const { spec } = loop;
  const source = await getDataset(spec.sourceDatasetId);
  if (!source) return null;
  const prompts = (await allRows<EvalExample>(spec.sourceDatasetId, "eval")).map((e) => e.prompt);
  const pick = (s: ReturnType<typeof roundScore>["all"]) => ({ items: s.items, tunedWins: s.tunedWins, baseWins: s.baseWins, avgBaseScore: s.avgBaseScore, avgTunedScore: s.avgTunedScore });
  const rounds: LoopRoundView[] = [];
  let lastJudgements: LoopJudgement[] = [];
  for (let round = 0; round <= spec.maxRounds; round++) {
    const datasetId = round === 0 ? spec.sourceDatasetId : roundDatasetId(id, round);
    const writer = round === 0 ? null : await getDataset(writerDatasetId(id, round));
    const dataset = await getDataset(datasetId);
    if (round > 0 && !writer) break;
    // Round 0 is the job the loop started from, even if someone trains another version on that dataset later.
    const job = round === 0 ? await getJob(spec.sourceJobId) : await latestTuneJob(datasetId);
    const judgements = job ? await jobJudgements(job.id) : [];
    const score = judgements.length ? roundScore(judgements, spec.target) : null;
    const previous = round > 1 ? await getDataset(roundDatasetId(id, round - 1)) : round === 1 ? source : null;
    const weak = round === 0 ? [] : weakPrompts(lastJudgements, prompts, spec.target);
    const stage: LoopRoundView["stage"] =
      job?.status === "failed" || job?.status === "stopped" || (writer?.status === "failed" && !dataset)
        ? "failed"
        : job
          ? job.status !== "succeeded"
            ? "training"
            : job.evalSummary
              ? "done"
              : "scoring"
          : dataset
            ? "checking"
            : "writing";
    rounds.push({
      round,
      stage,
      datasetId,
      jobId: job?.id ?? null,
      jobStatus: job?.status ?? null,
      added: dataset && previous ? Math.max(0, dataset.trainCount - previous.trainCount) : null,
      trainCount: dataset?.trainCount ?? null,
      weak,
      sealed: score ? pick(score.sealed) : null,
      all: score ? pick(score.all) : null,
      reached: score?.reached ?? false,
      costUsd: round === 0 ? 0 : await roundCost(id, round),
    });
    lastJudgements = judgements;
  }
  return {
    id,
    title: source.title,
    spec,
    running: !loop.ended,
    stopCode: loop.ended,
    stopText: loop.ended ? stopText(loop.ended) : null,
    spentUsd: roundMoney(rounds.reduce((a, r) => a + r.costUsd, 0)),
    rounds,
  };
}

