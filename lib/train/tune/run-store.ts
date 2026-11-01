/**
 * A run's training job and what the run keeps besides its dataset (docs/TRAINING.md "Fine-tune like a build"), for the
 * tuneRun workflow's steps, Start training and the room (re-exported from ./store.ts). No import from components/, so
 * the workflow bundle builds; no migration: the job is found by params.datasetId, the rest is in rate_limits.
 */
import { and, desc, eq, gte, like, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { ADAPTER_RECIPE, type TrainJobRow } from "@/lib/train/logic";
import { jobListColumns } from "@/lib/train/store";
import { runMarks, type RunMarks } from "@/lib/train/tune/marks";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const jobs = schema.trainingJobs;

/**
 * The newest Muse Glimmer LoRA job trained on this dataset, without the hub state's small files, or null. A dry run
 * (dryRun 1) fakes its answers, so its scores say nothing about the model and it never counts as the run's job. Nor
 * does a job that failed before any GPU launched (no instance id, no launch time): launchJob writes the row first and
 * fails it when two starts race or its workflow can't start, and the sweep fails one left queued. That job never
 * trained, so the run has no job and Start training (or the workflow's next try) launches again.
 */
export async function latestTuneJob(datasetId: string): Promise<TrainJobRow | null> {
  if (!UUID_RE.test(datasetId)) return null;
  const notDry = sql`(case when ${jobs.params}->>'dryRun' ~ '^[0-9]+([.][0-9]+)?$' then (${jobs.params}->>'dryRun')::numeric else 0 end) < 1`;
  const ranOrOpen = sql`not (${jobs.status} = 'failed' and ${jobs.instanceId} is null and ${jobs.launchedAt} is null)`;
  const [row] = await db()
    .select(jobListColumns)
    .from(jobs)
    .where(and(eq(jobs.recipe, ADAPTER_RECIPE), sql`${jobs.params}->>'datasetId' = ${datasetId}`, notDry, ranOrOpen))
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(1);
  return (row as TrainJobRow | undefined) ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// What a run keeps besides its dataset and its job (docs/TRAINING.md "Fine-tune like a build", "Starting training"),
// in rate_limits rows, so there is still no migration:
//   tune-run:<id>:<state>        the tuneRun workflow's heartbeat: one row a try while it checks or waits, with the
//                                waiting reason as the state. The hourly cleanup drops rows over an hour old.
//   tune-run-end:<id>:<code>     why the workflow ended without a job (a failed check, a refused launch, two hours of
//                                waiting), kept under a window that never starts, like the native downloads count.
//   tune-run-stopped:<id>        the run was stopped before training: nothing launches for it any more.
//   tune-settings:<id>:steps     the training steps the run was started with (Advanced), as the count.
//   tune-launch:<id>             the one launch claim, held for a 5-minute window and the next, so two launchers (the
//                                workflow and Start training) never both start a job for one run.
//   tune-product:<id>:<productId>:<buildId or "none">
//                                the product a run trains a model for (B: the build room's "Its own model", or unit
//                                11's "Train on my data"), and the build it was planned from. Wave 3's 0025 adds
//                                training_jobs.product_id and fills it from these rows: the job is the run's
//                                (latestTuneJob), so product_id = the productId here for params->>'datasetId' = <id>.

/** A window that never starts: the hourly prune only drops windows that started over an hour ago. */
export const TUNE_KEEP_WINDOW = new Date("2100-01-01T00:00:00.000Z");
/** How long a launch claim holds: its window and the next. A launch takes a minute or two at most. */
export const TUNE_LAUNCH_CLAIM_MS = 5 * 60_000;

const limits = schema.rateLimits;
const heartbeatKey = (id: string, state: string) => `tune-run:${id}:${state}`;
const endKey = (id: string, code: string) => `tune-run-end:${id}:${code}`;
const stoppedKey = (id: string) => `tune-run-stopped:${id}`;
const stepsKey = (id: string) => `tune-settings:${id}:steps`;
const claimKey = (id: string) => `tune-launch:${id}`;
const productPrefix = (id: string) => `tune-product:${id}:`;

/** A code that fits a key: lowercase letters, digits and underscores, at most 40 of them; anything else is "refused". */
export function markCode(code: string): string {
  return /^[a-z0-9_]{1,40}$/.test(code) ? code : "refused";
}

/**
 * Notes that the run's workflow (or Start training) is in `state` now: the heartbeat. One row a try, at the moment of
 * the try, so the newest says the latest reason even when two come within a minute; a try is every 5 minutes at most.
 */
export async function recordRunHeartbeat(datasetId: string, state: string, now: Date = new Date()): Promise<void> {
  if (!UUID_RE.test(datasetId)) return;
  await db().insert(limits).values({ key: heartbeatKey(datasetId, markCode(state)), windowStart: now, count: 1 }).onConflictDoNothing();
}

/** Notes why the run's workflow ended without a job. A later end replaces it. */
export async function recordRunEnded(datasetId: string, code: string): Promise<void> {
  if (!UUID_RE.test(datasetId)) return;
  await clearRunEnded(datasetId);
  await db().insert(limits).values({ key: endKey(datasetId, markCode(code)), windowStart: TUNE_KEEP_WINDOW, count: 1 }).onConflictDoNothing();
}

/** Forgets why the run ended, when Start training begins again. */
export async function clearRunEnded(datasetId: string): Promise<void> {
  if (!UUID_RE.test(datasetId)) return;
  await db().delete(limits).where(and(like(limits.key, `tune-run-end:${datasetId}:%`), eq(limits.windowStart, TUNE_KEEP_WINDOW)));
}

/** Stops the run before training: no job launches for it from now on. */
export async function markRunStopped(datasetId: string): Promise<void> {
  if (!UUID_RE.test(datasetId)) return;
  await db().insert(limits).values({ key: stoppedKey(datasetId), windowStart: TUNE_KEEP_WINDOW, count: 1 }).onConflictDoNothing();
}

/** Keeps the training steps the run was started with. */
export async function saveRunSteps(datasetId: string, steps: number): Promise<void> {
  if (!UUID_RE.test(datasetId)) return;
  const count = Math.max(1, Math.floor(steps));
  await db()
    .insert(limits)
    .values({ key: stepsKey(datasetId), windowStart: TUNE_KEEP_WINDOW, count })
    .onConflictDoUpdate({ target: [limits.key, limits.windowStart], set: { count } });
}

/** One rate_limits row of a run's marks. */
export interface RunMarkRow {
  key: string;
  windowStart: Date;
  count: number;
}

/** Everything a run keeps in rate_limits (see above), in one read. Heartbeats older than an hour are left out. */
export async function readRunMarkRows(datasetId: string, now: Date = new Date()): Promise<RunMarkRow[]> {
  if (!UUID_RE.test(datasetId)) return [];
  const hourAgo = new Date(now.getTime() - 60 * 60_000);
  return db()
    .select({ key: limits.key, windowStart: limits.windowStart, count: limits.count })
    .from(limits)
    .where(
      or(
        and(like(limits.key, `tune-run:${datasetId}:%`), gte(limits.windowStart, hourAgo), lt(limits.windowStart, TUNE_KEEP_WINDOW)),
        and(
          or(like(limits.key, `tune-run-end:${datasetId}:%`), eq(limits.key, stoppedKey(datasetId)), eq(limits.key, stepsKey(datasetId))),
          eq(limits.windowStart, TUNE_KEEP_WINDOW),
        ),
      ),
    );
}

/** The run's marks, read and put together (runMarks in view.ts). */
export async function readRunMarks(datasetId: string, now: Date = new Date()): Promise<RunMarks> {
  return runMarks(datasetId, await readRunMarkRows(datasetId, now));
}

/**
 * Takes the run's one launch claim, or answers null while another launcher holds it. One statement, as takeDemoSlot's:
 * the upsert locks the window's row, so two launchers can't both take it. A claim a crashed launcher never gave back
 * stops counting within two windows.
 */
export async function takeLaunchClaim(datasetId: string, now: Date = new Date()): Promise<Date | null> {
  if (!UUID_RE.test(datasetId)) return null;
  const key = claimKey(datasetId);
  const window = new Date(Math.floor(now.getTime() / TUNE_LAUNCH_CLAIM_MS) * TUNE_LAUNCH_CLAIM_MS);
  const previous = new Date(window.getTime() - TUNE_LAUNCH_CLAIM_MS);
  const held = sql`coalesce((select p.count from rate_limits p where p.key = ${key} and p.window_start = ${previous.toISOString()}::timestamptz), 0)`;
  const rows = await db()
    .insert(limits)
    .select(sql`select ${key}, ${window.toISOString()}::timestamptz, 1 where ${held} < 1`)
    .onConflictDoUpdate({
      target: [limits.key, limits.windowStart],
      set: { count: sql`${limits.count} + 1` },
      setWhere: sql`${limits.count} + ${held} < 1`,
    })
    .returning({ count: limits.count });
  return rows.length ? window : null;
}

/** Gives back a claim takeLaunchClaim handed out for this window. */
export async function releaseLaunchClaim(datasetId: string, window: Date): Promise<void> {
  if (!UUID_RE.test(datasetId)) return;
  await db()
    .update(limits)
    .set({ count: sql`greatest(${limits.count} - 1, 0)` })
    .where(and(eq(limits.key, claimKey(datasetId)), eq(limits.windowStart, window)));
}

/** The product a run is for, and the build it was planned from (null when it wasn't planned from one). */
export interface RunProduct {
  productId: string;
  buildId: string | null;
}

/**
 * Keeps the product (and build) a run trains a model for, until wave 3's 0025 has training_jobs.product_id (see the
 * keys above). A later call replaces it. Ids that aren't uuids keep nothing.
 */
export async function saveRunProduct(datasetId: string, productId: string, buildId: string | null = null): Promise<void> {
  if (!UUID_RE.test(datasetId) || !UUID_RE.test(productId) || (buildId !== null && !UUID_RE.test(buildId))) return;
  const key = `${productPrefix(datasetId)}${productId.toLowerCase()}:${buildId ? buildId.toLowerCase() : "none"}`;
  await db().delete(limits).where(and(like(limits.key, `${productPrefix(datasetId)}%`), eq(limits.windowStart, TUNE_KEEP_WINDOW)));
  await db().insert(limits).values({ key, windowStart: TUNE_KEEP_WINDOW, count: 1 }).onConflictDoNothing();
}

/** The product a run is for (saveRunProduct), or null. */
export async function readRunProduct(datasetId: string): Promise<RunProduct | null> {
  if (!UUID_RE.test(datasetId)) return null;
  const [row] = await db()
    .select({ key: limits.key })
    .from(limits)
    .where(and(like(limits.key, `${productPrefix(datasetId)}%`), eq(limits.windowStart, TUNE_KEEP_WINDOW)))
    .limit(1);
  if (!row) return null;
  const [productId, buildId] = row.key.slice(productPrefix(datasetId).length).split(":");
  if (!productId || !UUID_RE.test(productId)) return null;
  return { productId, buildId: buildId && UUID_RE.test(buildId) ? buildId : null };
}

/** The runs (dataset ids) kept for a product, for unit 11's ownModelFor until 0025: each one's job is latestTuneJob(id). */
export async function runsOfProduct(productId: string): Promise<string[]> {
  if (!UUID_RE.test(productId)) return [];
  const rows = await db()
    .select({ key: limits.key })
    .from(limits)
    .where(and(like(limits.key, `tune-product:%:${productId.toLowerCase()}:%`), eq(limits.windowStart, TUNE_KEEP_WINDOW)));
  return rows.map((r) => r.key.split(":")[1]!).filter((id) => UUID_RE.test(id));
}
