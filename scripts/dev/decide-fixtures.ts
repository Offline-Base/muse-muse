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
 * server starts: two processes on one PGlite folder would corrupt it.
 *
 * With DEMO_CERT_SHA256 set (the fingerprint scripts/dev/decide-demo-gpu.ts prints), it also adds a live demo of the
 * trained model: a running glimmer-serve job whose demo server is that stand-in on 127.0.0.1:8443, so the Try it live
 * box decides through the real route (docs/DECISION_MODELS.md, D7). Run the dev server with any GATEWAY_TOKEN_PEPPER;
 * the stand-in takes any serving key. Every input is written by rules
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
  // A trained job saved its adapter (and decide.json) on the region's model cache, as the GPU reports it; score only saved none.
  const saved: Record<string, string> = scoreOnly ? {} : { cache_used: "yes", adapter_dir: `/lambda/nfs/muse-muse-cache-us-east-1/models/${job.id}`, decide_json: "yes" };
  await recordEvent(job.id, { type: "done", summary, metrics: { mode: "decide", epochs: 2, score_only: scoreOnly ? 1 : 0, too_long: 0, ...saved } });
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

/** A running glimmer-serve job of the trained model, serving on the local stand-in GPU (decide-demo-gpu.ts). */
async function liveDemo(adapterJobId: string, certSha256: string): Promise<string> {
  const serve = await createJob({
    recipe: "glimmer-serve",
    title: "Live demo: Ticket router LoRA",
    params: { adapterJobId, minutes: 30 },
    instanceType: "gpu_1x_a100_sxm4",
    region: "us-east-1",
    priceCentsPerHour: 199,
    maxMinutes: 45,
    maxUsd: 1.53,
  });
  await db()
    .update(schema.trainingJobs)
    .set({
      status: "running",
      launchedAt: minutesAgo(8),
      firstHeartbeatAt: minutesAgo(6),
      lastHeartbeatAt: minutesAgo(0),
      tokenHash: "local-demo-token-hash",
      instanceIp: "127.0.0.1",
      serveEndpoint: { ip: "127.0.0.1", port: 8443, certSha256, startedAt: minutesAgo(1).toISOString() },
    })
    .where(eq(schema.trainingJobs.id, serve.id));
  return serve.id;
}

const cert = process.env.DEMO_CERT_SHA256?.trim();
const demo = cert ? await liveDemo(lora, cert) : null;
console.log(JSON.stringify({ dataset: dataset.id, lora, baseOnly, ...(demo ? { demo } : {}) }));
