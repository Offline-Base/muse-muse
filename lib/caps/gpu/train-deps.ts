import { and, eq, notExists, sql } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { ownModelFor } from "@/lib/caps/gpu/own-model";
import { ownerRowsOf, setJobProduct } from "@/lib/caps/gpu/store";
import type { TrainDeps } from "@/lib/caps/gpu/train";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { adjustCounter, reserveCounter } from "@/lib/gateway/store";
import { launchJob } from "@/lib/train/launch";
import { datasetSystemPrompt } from "@/lib/train/logic";
import { PERSON_WRITER } from "@/lib/train/models";
import { createDataset, createDecisionDataset, finishDataset, getDataset } from "@/lib/train/store";
import { latestTuneJob, runsOfProduct } from "@/lib/train/tune/run-store";
import { runHref, startTuneRun } from "@/lib/train/tune/start";
import { isTrainTerminal } from "@/lib/train/types";
import type { TrainExample } from "@/lib/train/types";

const datasets = schema.trainingDatasets;

/** The size a dataset says it was asked for, held to the column's 20 to 1000. */
const requested = (n: number) => Math.min(1000, Math.max(20, n));

export function trainDeps(): TrainDeps {
  return {
    on: () => env.gpuTrainOnData,
    tuneOn: () => env.tuneComposer,
    user: requireUser,
    async product(slug) {
      const p = schema.products;
      const [row] = await db().select({ id: p.id, name: p.name, ownerId: p.ownerId, status: p.status, takenDownAt: p.takenDownAt }).from(p).where(eq(p.slug, slug)).limit(1);
      return row ?? null;
    },
    ownModel: ownModelFor,
    async openRun(productId) {
      for (const runId of (await runsOfProduct(productId)).slice(0, 20)) {
        const [dataset, job] = await Promise.all([getDataset(runId), latestTuneJob(runId)]);
        if (dataset?.status === "generating" || (job && !isTrainTerminal(job.status))) return { runId, href: runHref(runId) };
      }
      return null;
    },
    ownerRows: ownerRowsOf,
    async saveChatDataset({ title, task, rows, createdBy }) {
      const dataset = await createDataset({ title, task, requested: requested(rows.length), writerModel: PERSON_WRITER, createdBy });
      const system = datasetSystemPrompt(task);
      const train: TrainExample[] = rows.map((r) => ({
        messages: [
          { role: "system", content: system },
          { role: "user", content: r.prompt },
          { role: "assistant", content: r.answer },
        ],
      }));
      await db().update(datasets).set({ train }).where(eq(datasets.id, dataset.id));
      const done = await finishDataset(dataset.id, rows.length);
      if (!done) throw new Error("The dataset couldn't be finished.");
      return { id: done.id };
    },
    async saveDecisionDataset({ title, checked, createdBy }) {
      const dataset = await createDecisionDataset({ title, spec: checked.spec, rows: checked.rows, createdBy });
      return { id: dataset.id };
    },
    /** Only a dataset nothing has trained on yet: one whose run couldn't start. */
    async removeDataset(id) {
      const jobs = schema.trainingJobs;
      await db()
        .delete(datasets)
        .where(and(eq(datasets.id, id), notExists(db().select({ one: sql`1` }).from(jobs).where(sql`${jobs.params}->>'datasetId' = ${id}`))));
    },
    startRun: ({ datasetId, callerId, productId }) => startTuneRun({ datasetId, callerId, productId }),
    launch: launchJob,
    setJobProduct,
    reserveCounter,
    adjustCounter,
  };
}
