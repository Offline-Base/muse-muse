import { desc, eq } from "drizzle-orm";
import { isSparkOpenDerivative, verdictFor } from "@/lib/caps/gpu/general";
import { fillProductIds, openGlimmerWindow } from "@/lib/caps/gpu/store";
import { db, schema } from "@/lib/db/client";
import { ADAPTER_RECIPE, DECIDE_MODE, jobMode } from "@/lib/train/logic";

/** One row of "Your own models" on /models. Status words only: no address, token or live call. */
export interface OwnModelRowView {
  jobId: string;
  title: string;
  product: string;
  kind: "Chat" | "Decision";
  verdict: string;
  passed: boolean;
  serving: boolean;
  sparkOpen: boolean;
}

export interface OwnModelsView {
  rows: OwnModelRowView[];
  /** Paired inference devices. Unit 13's `devices` table isn't here yet, so none. */
  devices: Array<{ name: string; status: string }>;
}

/** A signed-in person's own models: jobs trained for products they own, newest first. Reads the database, never a GPU. */
export async function ownModelsOf(userId: string, now: Date = new Date()): Promise<OwnModelsView> {
  const products = schema.products;
  const jobs = schema.trainingJobs;
  const mine = await db().select({ id: products.id }).from(products).where(eq(products.ownerId, userId)).orderBy(desc(products.createdAt)).limit(10);
  await Promise.all(mine.map((p) => fillProductIds(p.id)));
  const rows = await db()
    .select({ id: jobs.id, title: jobs.title, params: jobs.params, evalSummary: jobs.evalSummary, recipe: jobs.recipe, status: jobs.status, product: products.name })
    .from(jobs)
    .innerJoin(products, eq(products.id, jobs.productId))
    .where(eq(products.ownerId, userId))
    .orderBy(desc(jobs.createdAt))
    .limit(20);
  const window = await openGlimmerWindow(now);
  return {
    devices: [],
    rows: rows
      .filter((r) => r.recipe === ADAPTER_RECIPE && !(Number(r.params?.dryRun) >= 1))
      .map((r) => {
        const sparkOpen = isSparkOpenDerivative({ params: r.params });
        const verdict = r.evalSummary ? verdictFor(r.evalSummary, sparkOpen) : { passed: false, words: r.status === "succeeded" ? "Not scored yet." : "Still training, or it didn't finish." };
        return {
          jobId: r.id,
          title: r.title,
          product: r.product,
          kind: jobMode(r.params) === DECIDE_MODE ? "Decision" : "Chat",
          verdict: verdict.words,
          passed: verdict.passed,
          serving: window?.adapterJobId === r.id,
          sparkOpen,
        };
      }),
  };
}
