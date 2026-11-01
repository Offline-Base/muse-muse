/**
 * Fills a fresh local PGlite database with a made-up decision dataset and two decide jobs on it, one trained and one
 * score only, each scored by scoreDecisionStep as after a real run, so the decision pages can be looked at with no
 * GPU and no keys (docs/DECISION_MODELS.md "The results page"):
 *
 *   DATABASE_URL=pglite:.data/decide npx tsx scripts/migrate.ts
 *   DATABASE_URL=pglite:.data/decide npx tsx scripts/dev/decide-fixtures.ts
 *   DATABASE_URL=pglite:.data/decide OPEN_ACCESS=admin ADMIN_EMAILS=local-admin npx next dev -H localhost -p 3013
 *
 * Then open /fine-tuning, and the ids it prints under /fine-tuning/ and /fine-tuning/datasets/. Run it before the dev
 * server starts: two processes on one PGlite folder would corrupt it. Every input is written by rules
 * (lib/train/__tests__/decision-fixture.ts) and every score is made up by rule (components/train/__tests__/
 * decision-fixture.ts): nothing ran a model, nothing called Lambda, Meta or the Hub, and nothing is anyone's data.
 */
import { eq } from "drizzle-orm";
import { ticketDecision, type TicketDecision } from "@/components/train/__tests__/decision-fixture";
import { db, localDbDir, schema } from "@/lib/db/client";
import { scoreDecisionStep } from "@/lib/train/decide-steps";
import { createDecisionDataset, createJob, recordDecideEvent, recordEvent } from "@/lib/train/store";

if (!localDbDir(process.env.DATABASE_URL ?? "")) throw new Error("Set DATABASE_URL to pglite:<folder>.");

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

/** A glimmer-lora decide job on `datasetId` that ran, sent `t`'s scores, succeeded and was shut down. */
async function decideJob(t: TicketDecision, datasetId: string, title: string, scoreOnly: boolean): Promise<string> {
  const params = { datasetId, mode: "decide", epochs: 2, learningRate: 0.0002, loraRank: 16, scoreOnly: scoreOnly ? 1 : 0, dryRun: 0, publish: 0 };
  const job = await createJob({
    recipe: "glimmer-lora",
    title,
    params,
    instanceType: "gpu_1x_a100_sxm4",
    region: "us-east-1",
    priceCentsPerHour: 199,
    maxMinutes: 150,
    maxUsd: 14,
  });
  await recordEvent(job.id, { type: "status", status: "running", message: "The GPU booted and loaded the model." });
  for (const part of ["dev", "test"] as const) {
    for (let i = 0; i < t.sent[part].length; i += 100) {
      await recordDecideEvent(job.id, { type: "decide", part, items: t.sent[part].slice(i, i + 100) });
    }
  }
  const summary = scoreOnly
    ? "Score only: base Muse Glimmer 30B scored 192 decision items, and nothing trained."
    : "Decide mode: LoRA r=16 on Muse Glimmer 30B, 336 renderings in 11 steps, final loss 0.42, 192 decision items scored before and after training.";
  await recordEvent(job.id, { type: "done", summary, metrics: { mode: "decide", epochs: 2, score_only: scoreOnly ? 1 : 0, too_long: 0 } });
  await db()
    .update(schema.trainingJobs)
    .set({
      status: "succeeded",
      summary,
      costUsd: scoreOnly ? 0.7 : 0.83,
      launchedAt: minutesAgo(scoreOnly ? 30 : 40),
      firstHeartbeatAt: minutesAgo(scoreOnly ? 26 : 36),
      lastHeartbeatAt: minutesAgo(scoreOnly ? 10 : 15),
      finishedAt: minutesAgo(scoreOnly ? 9 : 14),
      terminatedAt: minutesAgo(scoreOnly ? 9 : 14),
    })
    .where(eq(schema.trainingJobs.id, job.id));
  const scored = await scoreDecisionStep(job.id);
  if (scored.saved !== "summary") throw new Error(`Scoring saved ${scored.saved} for ${title}.`);
  return job.id;
}

const trained = ticketDecision();
const dataset = await createDecisionDataset({ title: trained.title, spec: trained.spec, rows: trained.rows });
const lora = await decideJob(trained, dataset.id, "Ticket router LoRA", false);
const baseOnly = await decideJob(ticketDecision(undefined, { tuned: false }), dataset.id, "Ticket router, base only", true);
console.log(JSON.stringify({ dataset: dataset.id, lora, baseOnly }));
