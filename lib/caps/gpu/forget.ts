import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { TRAIN_TERMINAL } from "@/lib/train/types";

/**
 * Removes what "Train on my data" kept for a product (decisions 12 and 13), when its owner asks or it's taken down: the rows
 * in its private datasets, their jobs' eval items and judgements, which quote those rows, and each job's summary, so
 * ownModelFor and /decide stop using the model. A job still running is asked to stop. The dataset's row stays, emptied, with
 * its product_id, so its jobs stay off the public Lab pages for good. The adapter a GPU wrote stays on the lab's cache
 * filesystem, reachable by nothing here (docs/CAPABILITIES.md, 17a).
 *
 * Imports only the database, since lib/caps/cleanup.ts is in the build steps' bundle.
 */
export async function forgetProductTraining(productId: string): Promise<number> {
  const datasets = schema.trainingDatasets;
  const jobs = schema.trainingJobs;
  const events = schema.trainingEvents;
  const mine = await db().select({ id: datasets.id }).from(datasets).where(eq(datasets.productId, productId));
  if (!mine.length) return 0;
  const ids = mine.map((d) => d.id);
  const trained = sql`${jobs.params}->>'datasetId' in (select d.id::text from training_datasets d where d.product_id = ${productId})`;
  await db().update(jobs).set({ stopRequested: true }).where(and(trained, notInArray(jobs.status, [...TRAIN_TERMINAL])));
  const jobIds = (await db().select({ id: jobs.id }).from(jobs).where(trained)).map((j) => j.id);
  if (jobIds.length) {
    await db().delete(events).where(and(inArray(events.jobId, jobIds), inArray(events.type, ["eval", "judgement"])));
    await db().update(jobs).set({ evalSummary: null }).where(inArray(jobs.id, jobIds));
  }
  await db()
    .update(datasets)
    .set({ title: "Deleted", task: "Deleted", status: "failed", error: "Deleted by its owner, or when its product was taken down.", train: [], eval: [], trainCount: 0, evalCount: 0, decision: null, decisionRows: {} })
    .where(inArray(datasets.id, ids));
  return ids.length;
}

/** A taken-down product's training data goes. One an admin only turned off keeps it. Only while training on data is on. */
export async function gpuProductOff(productId: string): Promise<void> {
  const [row] = await db().select({ takenDownAt: schema.products.takenDownAt }).from(schema.products).where(eq(schema.products.id, productId)).limit(1);
  if (row?.takenDownAt && env.gpuTrainOnData) await forgetProductTraining(productId);
}
