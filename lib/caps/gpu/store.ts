import { and, desc, eq, gte, inArray, isNull, lte, gt, sql } from "drizzle-orm";
import type { GlimmerWindow } from "@/lib/caps/gpu/types";
import { db, schema } from "@/lib/db/client";
import { ADAPTER_RECIPE, type TrainJobRow } from "@/lib/train/logic";
import { latestTuneJob, runsOfProduct } from "@/lib/train/tune/run-store";

const windows = schema.glimmerWindows;
const jobs = schema.trainingJobs;

const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** The open demo window, or null. */
export async function openGlimmerWindow(now: Date): Promise<GlimmerWindow | null> {
  const [row] = await db()
    .select()
    .from(windows)
    .where(and(eq(windows.status, "open"), lte(windows.startsAt, now), gt(windows.endsAt, now)))
    .limit(1);
  return row ?? null;
}

/**
 * What today's (UTC) windows hold against GPU_GLIMMER_DAILY_USD: a settled window's real cost, any other's whole cap. A
 * window that never got a GPU holds nothing. At most one is open (the unique index), so two opens can't both pass this.
 */
export async function glimmerReservedToday(now: Date): Promise<number> {
  const [row] = await db()
    .select({ total: sql<number>`coalesce(sum(coalesce(${windows.costUsd}, ${windows.capUsd})), 0)` })
    .from(windows)
    .where(and(gte(windows.createdAt, startOfUtcDay(now)), sql`${windows.status} <> 'failed'`));
  return Number(row?.total ?? 0);
}

/** Saves a new open window, or null when one is already open. */
export async function insertGlimmerWindow(input: Pick<GlimmerWindow, "startsAt" | "endsAt" | "createdBy" | "capUsd" | "adapterJobId" | "sparkOpen" | "reservationId">): Promise<GlimmerWindow | null> {
  const [row] = await db().insert(windows).values(input).onConflictDoNothing().returning();
  return row ?? null;
}

export async function getGlimmerWindow(id: string): Promise<GlimmerWindow | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const [row] = await db().select().from(windows).where(eq(windows.id, id)).limit(1);
  return row ?? null;
}

export async function listGlimmerWindows(limit = 20): Promise<GlimmerWindow[]> {
  return db().select().from(windows).orderBy(desc(windows.createdAt)).limit(limit);
}

export async function unsettledGlimmerWindows(): Promise<GlimmerWindow[]> {
  return db().select().from(windows).where(inArray(windows.status, ["open", "closing"])).limit(50);
}

export async function attachServeJob(id: string, serveJobId: string): Promise<void> {
  await db().update(windows).set({ serveJobId }).where(eq(windows.id, id));
}

/** Moves a window on, only from a state still unsettled, and returns it, or null when something else already did. */
export async function moveGlimmerWindow(id: string, patch: Partial<Pick<GlimmerWindow, "status" | "costUsd">>): Promise<GlimmerWindow | null> {
  const [row] = await db()
    .update(windows)
    .set(patch)
    .where(and(eq(windows.id, id), inArray(windows.status, ["open", "closing"])))
    .returning();
  return row ?? null;
}

/**
 * training_jobs.product_id from a product's runs (General's tune-product rows, lib/train/tune/run-store.ts): the job of each
 * run, where it isn't filled yet. A run's job is found by its dataset, so this works however the job was started.
 */
export async function fillProductIds(productId: string): Promise<void> {
  const runs = await runsOfProduct(productId);
  for (const runId of runs.slice(0, 20)) {
    const job = await latestTuneJob(runId);
    if (job) await db().update(jobs).set({ productId }).where(and(eq(jobs.id, job.id), isNull(jobs.productId)));
  }
}

/** A product's real Muse Glimmer LoRA jobs that finished, newest first. */
export async function productAdapterJobs(productId: string, limit = 20): Promise<Array<Pick<TrainJobRow, "id" | "title" | "params" | "evalSummary" | "status" | "recipe"> & { createdAt: Date }>> {
  return db()
    .select({ id: jobs.id, title: jobs.title, params: jobs.params, evalSummary: jobs.evalSummary, status: jobs.status, recipe: jobs.recipe, createdAt: jobs.createdAt })
    .from(jobs)
    .where(and(eq(jobs.productId, productId), eq(jobs.recipe, ADAPTER_RECIPE), eq(jobs.status, "succeeded")))
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(limit);
}

export async function setJobProduct(jobId: string, productId: string): Promise<void> {
  await db().update(jobs).set({ productId }).where(eq(jobs.id, jobId));
}

/** A person's owner rows in a product's chosen collections, live only, oldest first. Never shared, visitor or user rows. */
export async function ownerRowsOf(productId: string, collections: readonly string[], limit: number): Promise<Array<{ collection: string; data: unknown }>> {
  const rows = schema.productRows;
  return db()
    .select({ collection: rows.collection, data: rows.data })
    .from(rows)
    .where(and(eq(rows.productId, productId), eq(rows.namespace, "live"), eq(rows.scope, "owner"), inArray(rows.collection, [...collections]), isNull(rows.deletedAt)))
    .orderBy(rows.seq)
    .limit(limit);
}
