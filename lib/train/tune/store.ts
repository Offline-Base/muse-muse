/**
 * The reads a run's room needs that lib/train/store.ts doesn't have (docs/TRAINING.md "Fine-tune like a build"): the
 * training job made from a run's dataset, that job's eval items and judgements, and the run put together (loadTuneRun).
 * A run is its dataset row, and its job is found by params.datasetId, so there is no migration.
 */
import { and, asc, eq, or } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { EVALS_MAX } from "@/lib/train/logic";
import { datasetProgress, getDataset, listPartnerEvals } from "@/lib/train/store";
import { latestTuneJob, readRunMarks } from "@/lib/train/tune/run-store";
import type { TuneRunView } from "@/lib/train/tune/types";
import { tuneRunView } from "@/lib/train/tune/view";
import type { TrainEventView } from "@/lib/train/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const events = schema.trainingEvents;

// The run's job and what it keeps in rate_limits, without the room's view, so the tuneRun workflow's steps can read
// them (lib/train/tune/run-store.ts).
export {
  clearRunEnded,
  latestTuneJob,
  markCode,
  markRunStopped,
  readRunMarkRows,
  readRunMarks,
  recordRunEnded,
  recordRunHeartbeat,
  releaseLaunchClaim,
  saveRunSteps,
  takeLaunchClaim,
  TUNE_KEEP_WINDOW,
  TUNE_LAUNCH_CLAIM_MS,
  type RunMarkRow,
} from "@/lib/train/tune/run-store";

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
 * while it's being written, its newest training job and that job's eval items, and its marks (readRunMarks).
 */
export async function loadTuneRun(id: string, now: Date, ceilings: { maxMinutes: number; maxUsd: number }): Promise<TuneRunView | null> {
  const dataset = await getDataset(id);
  if (!dataset) return null;
  const [written, job, marks] = await Promise.all([
    dataset.status === "generating" ? datasetProgress(id) : Promise.resolve(null),
    latestTuneJob(id),
    readRunMarks(id, now),
  ]);
  const [events, partnerEvals] = job ? await Promise.all([tuneEvalEvents(job.id), listPartnerEvals(job.id)]) : [[], []];
  return tuneRunView({ dataset, written, job, events, marks, partnerEvals }, now, ceilings);
}
