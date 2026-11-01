/**
 * The reads a run's room needs that lib/train/store.ts doesn't have (docs/TRAINING.md "Fine-tune like a build"): the
 * training job made from a run's dataset, that job's eval items and judgements, and the run put together (loadTuneRun).
 * A run is its dataset row, and its job is found by params.datasetId, so there is no migration.
 */
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { ADAPTER_RECIPE, EVALS_MAX, type TrainJobRow } from "@/lib/train/logic";
import { datasetProgress, getDataset, jobListColumns } from "@/lib/train/store";
import type { TuneRunView } from "@/lib/train/tune/types";
import { tuneRunView } from "@/lib/train/tune/view";
import type { TrainEventView } from "@/lib/train/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const jobs = schema.trainingJobs;
const events = schema.trainingEvents;

/** The newest Muse Glimmer LoRA job trained on this dataset, without the hub state's small files, or null. */
export async function latestTuneJob(datasetId: string): Promise<TrainJobRow | null> {
  if (!UUID_RE.test(datasetId)) return null;
  const [row] = await db()
    .select(jobListColumns)
    .from(jobs)
    .where(and(eq(jobs.recipe, ADAPTER_RECIPE), sql`${jobs.params}->>'datasetId' = ${datasetId}`))
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(1);
  return (row as TrainJobRow | undefined) ?? null;
}

/** A job's eval items and judgements, oldest first: EVALS_MAX of each, with room for a judgement logged twice. */
export async function tuneEvalEvents(jobId: string): Promise<TrainEventView[]> {
  if (!UUID_RE.test(jobId)) return [];
  const rows = await db()
    .select()
    .from(events)
    .where(and(eq(events.jobId, jobId), or(eq(events.type, "eval"), eq(events.type, "judgement"))))
    .orderBy(asc(events.id))
    .limit(EVALS_MAX * 4);
  return rows.map((r) => ({ id: r.id, type: r.type, payload: r.payload, at: r.at.toISOString() }));
}

/**
 * A run as its room shows it, or null when the id names no dataset. Reads the dataset, how many examples it holds
 * while it's being written, its newest training job and that job's eval items.
 */
export async function loadTuneRun(id: string, now: Date, ceilings: { maxMinutes: number; maxUsd: number }): Promise<TuneRunView | null> {
  const dataset = await getDataset(id);
  if (!dataset) return null;
  const [written, job] = await Promise.all([
    dataset.status === "generating" ? datasetProgress(id) : Promise.resolve(null),
    latestTuneJob(id),
  ]);
  const events = job ? await tuneEvalEvents(job.id) : [];
  return tuneRunView({ dataset, written, job, events }, now, ceilings);
}
