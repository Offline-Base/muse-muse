/**
 * The whole path on an in-memory PGlite migrated with drizzle/, with the real store, the real launch checks (launchJob) and
 * General's real chat backend, and only Lambda, the workflow runtime and the GPU's answer faked. An admin opens a window, a
 * product asks, the window closes and settles. Then "Train on my data" saves a real dataset. No GPU, no model call.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/caps/gpu/__tests__/integration.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { eq, sql } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (path: string) => new URL(path, import.meta.url).href;
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;

const R30B = "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit";
const GPU = { name: "gpu_1x_a100_sxm4", description: "1x A100 SXM4 (40 GB)", priceCentsPerHour: 129, gpus: 1, regionsWithCapacity: ["us-east-1"] };
const savedEnv = { ...process.env };

class FakeFatal extends Error {}
class FakeRetryable extends Error {}

describe("a demo window, end to end", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let gpuDeps: typeof import("../deps");
  let handler: typeof import("../handler");
  let windows: typeof import("../windows");
  let store: typeof import("@/lib/train/store");
  let serving: typeof import("@/lib/train/glimmer-serving");
  let trainDeps: typeof import("../train-deps");
  let train: typeof import("../train");
  let runStore: typeof import("@/lib/train/tune/run-store");
  let ownModel: typeof import("../own-model");
  let tokens: typeof import("@/lib/gateway/tokens");
  const started: string[] = [];
  let adminId = "";
  let productId = "";
  let adapterId = "";

  before(async () => {
    Object.assign(process.env, {
      GPU_GLIMMER_SHARED: "1",
      GPU_TRAIN_ON_DATA: "1",
      TUNE_COMPOSER: "1",
      PLATFORM_URL: "https://muse.example.com",
      LAMBDA_API_KEY: "test-value-not-a-key",
      CRON_SECRET: "test-cron",
      VERCEL_ENV: "production",
      GATEWAY_TOKEN_PEPPER: "test-pepper-not-a-secret",
      ADMIN_EMAILS: "owner@example.com",
      TRAIN_MAX_ACTIVE: "1",
      TRAIN_DAILY_USD: "20",
      TRAIN_JOB_MAX_USD: "5",
      TRAIN_JOB_MAX_MINUTES: "120",
    });
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    // launchJob's store batches its writes, which Neon's driver offers and PGlite's doesn't.
    (testDb as unknown as { batch: (q: PromiseLike<unknown>[]) => Promise<unknown[]> }).batch = async (queries) => {
      const results: unknown[] = [];
      for (const q of queries) results.push(await q);
      return results;
    };
    await migrate(testDb, { migrationsFolder: new URL("../../../../drizzle", import.meta.url).pathname });
    mock.module(at("../../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    const realLambda = await import("@/lib/train/lambda");
    mock.module("workflow", { namedExports: { FatalError: FakeFatal, RetryableError: FakeRetryable, sleep: async () => {} } });
    mock.module("workflow/api", {
      namedExports: {
        start: async (fn: { name: string }) => {
          started.push(fn.name);
          return { runId: `wrun-${started.length}` };
        },
      },
    });
    mock.module(at("../../../train/lambda.ts"), { namedExports: { ...realLambda, listInstanceTypes: async () => [GPU], cacheRegions: async () => ["us-east-1"] } });
    mock.module(at("../../../train/workflow.ts"), { namedExports: { trainJob: async function trainJob() {} } });
    mock.module(at("../../../train/datasets.ts"), { namedExports: { DATASET_MODEL: "muse-wonder-1.0", makeDataset: async function makeDataset() {} } });

    gpuDeps = await import("../deps");
    handler = await import("../handler");
    windows = await import("../windows");
    store = await import("@/lib/train/store");
    serving = await import("@/lib/train/glimmer-serving");
    trainDeps = await import("../train-deps");
    train = await import("../train");
    runStore = await import("@/lib/train/tune/run-store");
    ownModel = await import("../own-model");
    tokens = await import("@/lib/gateway/tokens");

    const [admin] = await testDb.insert(realSchema.users).values({ email: "owner@example.com", isAdmin: true }).returning();
    adminId = admin!.id;
    const [product] = await testDb.insert(realSchema.products).values({ slug: "corner", name: "Corner Bakery", ownerId: adminId, status: "live" }).returning();
    productId = product!.id;
    const [job] = await testDb
      .insert(realSchema.trainingJobs)
      .values({
        recipe: "glimmer-lora",
        title: "Bakery helper",
        status: "succeeded",
        params: { datasetId: "00000000-0000-4000-8000-000000000042", baseModel: R30B },
        instanceType: GPU.name,
        region: "us-east-1",
        priceCentsPerHour: 129,
        maxMinutes: 90,
        maxUsd: 5,
        instanceName: "made-up",
        terminatedAt: new Date(),
        evalSummary: { items: 20, tunedWins: 16, baseWins: 3, ties: 1, avgTunedScore: 8.5, avgBaseScore: 3.1 } as never,
      })
      .returning();
    adapterId = job!.id;
    await store.recordEvent(adapterId, { type: "done", metrics: { cache_used: "yes", adapter_dir: `/cache/models/${adapterId}`, base_model: R30B } } as never);
    await store.recordSweepOk();
  });

  after(async () => {
    mock.restoreAll();
    process.env = savedEnv;
    await client?.close();
  });

  const ask = (token: string, model = "muse-glimmer") =>
    new Request("https://muse.example.com/api/gateway/glimmer/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Do you have made-up nut-free cupcakes?" }] }),
    });

  it("runs from opening to settling", async () => {
    const { token } = await tokens.mintToken({ productId, scope: "live", allowedModels: ["muse-wonder-1.0", "glimmer"], dailyBudgetUsd: 1 });
    const sent: Array<Record<string, unknown>> = [];
    const backends = serving.chatWindowBackends({
      target: store.liveChatServeTarget,
      takeSlot: (id) => store.takeDemoSlot(id),
      releaseSlot: store.releaseDemoSlot,
      keyFor: () => "made-up-key",
      ask: async (_t, _k, body) => {
        sent.push(body);
        return { text: "Yes, on Tuesdays.", finish: "stop", usage: { input: 9, output: 4 }, ms: 50 } as never;
      },
    });
    const deps = { ...gpuDeps.glimmerDeps(), backend: backends };
    const code = async (r: Response) => ((await r.clone().json()) as { error?: { code: string } }).error?.code;

    // No window: closed, whichever model is asked for.
    assert.equal(await code(await handler.handleGlimmerChat(ask(token), deps)), "glimmer_closed");

    // An admin opens one, through the lab's real checks.
    const opened = await windows.openWindow({ adapterJobId: adapterId, minutes: 10 }, { userId: adminId }, gpuDeps.windowDeps());
    assert.ok(opened.ok, JSON.stringify(opened));
    const serveJobId = opened.window.serveJobId!;
    const serveJob = await store.getJob(serveJobId);
    assert.equal(serveJob!.recipe, "glimmer-serve");
    assert.equal(serveJob!.maxUsd, opened.window.capUsd, "the job can't spend past the reservation");
    assert.equal(opened.window.sparkOpen, true);
    assert.ok(started.includes("trainJob"));
    const [reservation] = await testDb.select().from(realSchema.usage);
    assert.equal(reservation!.source, "glimmer");
    assert.equal(reservation!.costUsd, opened.window.capUsd);

    // Booting.
    const starting = await handler.handleGlimmerChat(ask(token), deps);
    assert.equal(await code(starting), "glimmer_starting");
    assert.ok(((await starting.json()) as { retryAfterSeconds: number }).retryAfterSeconds > 0);

    // Live: the row a GPU's "serving" callback leaves.
    await testDb
      .update(realSchema.trainingJobs)
      .set({ status: "running", tokenHash: "made-up-hash", instanceId: "i-made-up", launchedAt: new Date(), instanceIp: "203.0.113.7", serveEndpoint: { ip: "203.0.113.7", port: 8443, certSha256: "a".repeat(64), startedAt: new Date().toISOString() } })
      .where(eq(realSchema.trainingJobs.id, serveJobId));

    const base = await handler.handleGlimmerChat(ask(token), deps);
    assert.equal(base.status, 200, await base.clone().text());
    const reply = (await base.json()) as { choices: Array<{ message: { content: string } }>; note: string };
    assert.equal(reply.choices[0]!.message.content, "Yes, on Tuesdays.");
    assert.match(reply.note, /Built with Muse Spark Open/);
    assert.equal(sent[0]!.model, "muse-glimmer");
    assert.equal(sent[0]!.temperature, 1);
    assert.equal(sent[0]!.top_p, 0.95);
    assert.equal(sent[0]!.top_k, 64);
    assert.ok(!JSON.stringify(reply).includes("203.0.113.7"));

    // Own: not linked to this product yet, then linked through its run's record.
    const notYet = await handler.handleGlimmerChat(ask(token, "own"), deps);
    assert.equal(await code(notYet), "own_model_not_ready");
    await runStore.saveRunProduct("00000000-0000-4000-8000-000000000042", productId, null);
    assert.equal((await ownModel.ownModelFor(productId))?.adapterJobId, adapterId);
    const own = await handler.handleGlimmerChat(ask(token, "own"), deps);
    assert.equal(own.status, 200, await own.clone().text());
    assert.equal(sent[1]!.model, adapterId);

    // The units are rows at $0.
    const rows = await testDb.select().from(realSchema.usage).where(eq(realSchema.usage.endpoint, handler.GLIMMER_ENDPOINT));
    assert.deepEqual(rows.map((r) => [r.model, r.units, r.costUsd]).sort(), [["muse-glimmer", 1, 0], ["muse-glimmer-own", 1, 0]]);

    // Closing: products lose it at once, and the GPU is asked to stop.
    const closing = await windows.closeWindow(opened.window.id, gpuDeps.windowDeps());
    assert.equal(closing?.status, "closing");
    assert.equal((await store.getJob(serveJobId))!.stopRequested, true);
    assert.equal(await code(await handler.handleGlimmerChat(ask(token), deps)), "glimmer_closed");

    // The GPU is down: the sweep settles at what it cost.
    await testDb.update(realSchema.trainingJobs).set({ status: "stopped", costUsd: 0.42, terminatedAt: new Date() }).where(eq(realSchema.trainingJobs.id, serveJobId));
    assert.equal(await windows.sweepWindows(new Date(), gpuDeps.windowDeps()), 1);
    const [settled] = await testDb.select().from(realSchema.glimmerWindows);
    assert.equal(settled!.status, "closed");
    assert.ok(Math.abs(settled!.costUsd! - 0.42) < 0.001);
    const [spend] = await testDb.select().from(realSchema.usage).where(eq(realSchema.usage.id, settled!.reservationId!));
    assert.ok(Math.abs(spend!.costUsd - 0.42) < 0.001);
  });

  it("trains on the owner's rows only, into a dataset tuneRun can use, and runs one at a time", async () => {
    const row = (scope: string, i: number, ownerKey: string | null) => ({ productId, namespace: "live", collection: "faq", scope: scope as never, ownerKey, docId: `${scope}-${i}`, data: { prompt: `${scope} question alpha${i} bravo${i * 3} charlie${i * 5} delta${i * 7} echo${i * 11}?`, answer: `Made-up answer ${i}.` }, bytes: 50 });
    await testDb.insert(realSchema.productRows).values([
      ...Array.from({ length: 40 }, (_, i) => row("owner", i, "k")),
      ...Array.from({ length: 10 }, (_, i) => row("shared", i, null)),
      ...Array.from({ length: 10 }, (_, i) => row("visitor", i, "v")),
    ]);
    const deps = { ...trainDeps.trainDeps(), user: async () => ({ id: adminId, email: "owner@example.com", isAdmin: true }), ownModel: async () => null };
    const post = () => new Request("https://muse.example.com/api/products/corner/train", { method: "POST", body: JSON.stringify({ collections: ["faq"], confirm: true }) });
    const res = await train.handleProductTrain(post(), "corner", deps);
    assert.equal(res.status, 201, await res.clone().text());
    const body = (await res.json()) as { runId: string; rows: number; kind: string; href: string };
    assert.equal(body.rows, 40, "owner rows, not the shared or visitor ones");
    assert.equal(body.href, `/fine-tuning/runs/${body.runId}`);
    const dataset = await store.getDataset(body.runId);
    assert.equal(dataset!.status, "ready");
    assert.equal(dataset!.writerModel, "person");
    assert.equal(dataset!.trainCount + dataset!.evalCount, 40);
    assert.ok(dataset!.evalCount >= 8);
    const page = await testDb.select({ train: realSchema.trainingDatasets.train, eval: realSchema.trainingDatasets.eval }).from(realSchema.trainingDatasets);
    assert.ok(!JSON.stringify(page).includes("shared question"));
    assert.ok(!JSON.stringify(page).includes("visitor question"));
    assert.ok(started.includes("tuneRun"));
    assert.ok((await runStore.runsOfProduct(productId)).includes(body.runId), "the run knows its product");

    // The product's one run today is taken.
    const again = await train.handleProductTrain(post(), "corner", deps);
    assert.equal(again.status, 429, await again.clone().text());
    assert.equal(await store.getDataset(((await again.json()) as { runId?: string }).runId ?? "00000000-0000-4000-8000-000000000000"), null);
  });

  /** Everything a person who isn't an admin can read of the Lab, as the pages read it. */
  const publicReads = async (datasetId: string, jobId?: string) => ({
    list: (await store.listReadyDatasets(200)).filter((d) => d.id === datasetId),
    one: await store.getReadyDataset(datasetId),
    results: jobId ? (await store.listResultJobs(200)).filter((j) => j.id === jobId) : [],
    result: jobId ? await store.getResultJob(jobId) : null,
    events: jobId ? await store.listResultEvents(jobId) : [],
  });
  const NOTHING = { list: [], one: null, results: [], result: null, events: [] };

  const EVAL_SUMMARY = { items: 20, tunedWins: 16, baseWins: 3, ties: 1, avgTunedScore: 8.5, avgBaseScore: 3.1 };

  /** A finished, judged job on a dataset, with a made-up private row in its eval items. */
  async function finishedJob(datasetId: string, over: Record<string, unknown> = {}): Promise<string> {
    const [job] = await testDb
      .insert(realSchema.trainingJobs)
      .values({ recipe: "glimmer-lora", title: "Private model", status: "succeeded", params: { datasetId, baseModel: R30B }, instanceType: GPU.name, region: "us-east-1", priceCentsPerHour: 129, maxMinutes: 90, maxUsd: 5, instanceName: "made-up", terminatedAt: new Date(), evalSummary: EVAL_SUMMARY as never, ...over } as never)
      .returning();
    await store.recordEvent(job!.id, { type: "eval", index: 0, prompt: "PRIVATE made-up prompt", reference: "PRIVATE made-up answer", base: "b", tuned: "t" } as never);
    await store.recordEvent(job!.id, { type: "judgement", index: 0, baseScore: 1, tunedScore: 9, better: "tuned", note: "PRIVATE note" } as never);
    return job!.id;
  }

  it("keeps owner rows off every public read, and lets the lab's own list still show", async () => {
    // A signed-in builder who isn't an admin, on their own product.
    const [maker] = await testDb.insert(realSchema.users).values({ email: "maker@example.com" }).returning();
    const [product] = await testDb.insert(realSchema.products).values({ slug: "clinic", name: "Made-up Clinic Notes", ownerId: maker!.id, status: "live" }).returning();
    const row = (i: number) => ({ productId: product!.id, namespace: "live", collection: "notes", scope: "owner" as never, ownerKey: "k", docId: `n-${i}`, data: { prompt: `PRIVATE patient alpha${i} bravo${i * 3} charlie${i * 5} delta${i * 7}?`, answer: `PRIVATE answer ${i}.` }, bytes: 50 });
    await testDb.insert(realSchema.productRows).values(Array.from({ length: 40 }, (_, i) => row(i)));
    const deps = { ...trainDeps.trainDeps(), user: async () => ({ id: maker!.id, email: "maker@example.com", isAdmin: false }), ownModel: async () => null };
    const res = await train.handleProductTrain(new Request("https://muse.example.com/x", { method: "POST", body: JSON.stringify({ collections: ["notes"], confirm: true }) }), "clinic", deps);
    assert.equal(res.status, 201, await res.clone().text());
    const { runId } = (await res.json()) as { runId: string };

    const head = await store.getDataset(runId);
    assert.equal(head!.status, "ready");
    assert.equal(head!.productId, product!.id);
    assert.deepEqual(await publicReads(runId), NOTHING);

    // Its job, once judged, is off the results too, while an ordinary job stays on them.
    const jobId = await finishedJob(runId);
    assert.deepEqual(await publicReads(runId, jobId), NOTHING);
    const ordinary = await store.createDataset({ title: "Ordinary", task: "t", requested: 20, writerModel: "muse-wonder-1.0" });
    const ordinaryJob = await finishedJob(ordinary.id);
    assert.ok((await store.getResultJob(ordinaryJob)) !== null, "a lab job still shows");
    assert.equal((await store.listResultEvents(ordinaryJob)).length, 2);

    // The owner still sees it on /models, and the store links it at once.
    const ownRows = await import("../own-rows");
    assert.ok((await ownRows.ownModelsOf(maker!.id)).rows.some((r) => r.jobId === jobId));
    const stranger = await testDb.insert(realSchema.users).values({ email: "stranger@example.com" }).returning();
    assert.deepEqual((await ownRows.ownModelsOf(stranger[0]!.id)).rows, []);

    // Before deleting: the model is the product's own.
    await store.recordEvent(jobId, { type: "done", metrics: { cache_used: "yes", adapter_dir: `/cache/models/${jobId}`, base_model: R30B } } as never);
    assert.equal((await ownModel.ownModelFor(product!.id))?.adapterJobId, jobId);

    // Deleted when asked: the rows, the eval items and the model's use. The row stays, so it never turns public.
    const { forgetProductTraining, gpuProductOff } = await import("../forget");
    assert.equal(await forgetProductTraining(product!.id), 1);
    const [emptied] = await testDb.select().from(realSchema.trainingDatasets).where(eq(realSchema.trainingDatasets.id, runId));
    assert.ok(!JSON.stringify(emptied).includes("PRIVATE"));
    assert.deepEqual(emptied!.train, []);
    assert.deepEqual(emptied!.eval, []);
    assert.equal(emptied!.productId, product!.id);
    const kept = await testDb.select().from(realSchema.trainingEvents).where(eq(realSchema.trainingEvents.jobId, jobId));
    assert.ok(!JSON.stringify(kept).includes("PRIVATE"));
    assert.equal(await ownModel.ownModelFor(product!.id), null);
    assert.deepEqual(await publicReads(runId, jobId), NOTHING);
    assert.ok(!(await ownRows.ownModelsOf(maker!.id)).rows.some((r) => r.jobId === jobId), "and it's off /models");

    // Takedown does the same; a product an admin only turned off keeps its data.
    const other = await store.createDataset({ title: "Other", task: "t", requested: 20, writerModel: "person", productId: product!.id });
    await gpuProductOff(product!.id);
    assert.equal((await store.getDataset(other.id))!.status, "generating", "only turned off: kept");
    await testDb.update(realSchema.products).set({ takenDownAt: new Date() }).where(eq(realSchema.products.id, product!.id));
    await gpuProductOff(product!.id);
    assert.equal((await store.getDataset(other.id))!.status, "failed", "taken down: gone");
  });

  it("runs a person's chat dataset through tuneRun's real check and launch, and the job stays private", async () => {
    const { checkExamples, launchForRun } = await import("@/lib/train/tune/run-launch");
    const [maker] = await testDb.insert(realSchema.users).values({ email: "chat-maker@example.com" }).returning();
    const [product] = await testDb.insert(realSchema.products).values({ slug: "chat-maker", name: "Chat Maker", ownerId: maker!.id, status: "live" }).returning();
    const rows = Array.from({ length: 40 }, (_, i) => ({ prompt: `Made-up question alpha${i} bravo${i * 3} charlie${i * 5}?`, answer: `Made-up answer ${i}.` }));
    const { id } = await trainDeps.trainDeps().saveChatDataset({ title: "Chat Maker: its own model", task: "Answer like the examples.", rows, createdBy: maker!.id, productId: product!.id });
    assert.equal((await checkExamples(id)).ok, true);

    await testDb.update(realSchema.trainingJobs).set({ status: "succeeded", terminatedAt: new Date() }).where(sql`${realSchema.trainingJobs.status} not in ('succeeded', 'failed', 'stopped')`);
    const launched = await launchForRun({ datasetId: id, callerId: maker!.id, steps: 100 });
    assert.equal(launched.kind, "launched", JSON.stringify(launched));
    if (launched.kind !== "launched") return;
    const job = await store.getJob(launched.jobId);
    assert.equal(job!.params?.datasetId, id);
    assert.equal(Number(job!.params?.publish), 0, "never published");
    await testDb.update(realSchema.trainingJobs).set({ status: "succeeded", terminatedAt: new Date(), evalSummary: EVAL_SUMMARY as never }).where(eq(realSchema.trainingJobs.id, launched.jobId));
    assert.deepEqual(await publicReads(id, launched.jobId), NOTHING);
    await store.requestStop(launched.jobId);
  });

  it("trains a decision model on the real store: private, reused on the same question, and callable by its own product only", async () => {
    const [maker] = await testDb.insert(realSchema.users).values({ email: "decide-maker@example.com" }).returning();
    const [product] = await testDb.insert(realSchema.products).values({ slug: "desk", name: "Help Desk", ownerId: maker!.id, status: "live" }).returning();
    const labels = ["approve", "deny"];
    const row = (i: number) => ({ productId: product!.id, namespace: "live", collection: "tickets", scope: "owner" as never, ownerKey: "k", docId: `t-${i}`, data: { input: `PRIVATE made-up ticket ${i} about topic ${i * 7}`, label: labels[i % 2]! }, bytes: 50 });
    await testDb.insert(realSchema.productRows).values(Array.from({ length: 60 }, (_, i) => row(i)));
    await testDb.update(realSchema.trainingJobs).set({ status: "succeeded", terminatedAt: new Date() }).where(sql`${realSchema.trainingJobs.status} not in ('succeeded', 'failed', 'stopped')`);
    const deps = { ...trainDeps.trainDeps(), user: async () => ({ id: maker!.id, email: "decide-maker@example.com", isAdmin: false }) };
    const question = "Should this made-up ticket be approved?";
    const post = () => new Request("https://muse.example.com/x", { method: "POST", body: JSON.stringify({ collections: ["tickets"], confirm: true, decision: { question, labels } }) });
    const res = await train.handleProductTrain(post(), "desk", deps);
    assert.equal(res.status, 201, await res.clone().text());
    const body = (await res.json()) as { runId: string; jobId: string; kind: string };
    assert.equal(body.kind, "decision");
    const job = await store.getJob(body.jobId);
    assert.equal(job!.productId, product!.id, "set at once");
    assert.equal(job!.params?.mode, "decide");
    assert.equal((await store.getDataset(body.runId))!.productId, product!.id);
    assert.deepEqual(await publicReads(body.runId, body.jobId), NOTHING);
    await store.requestStop(body.jobId);

    // Finished and passing: the same question reuses it, with no GPU, and it's still not public.
    const summary = { kind: "decision", items: 60, base: { accuracy: { right: 30, total: 60, rate: 0.5, low: 0.4, high: 0.6 }, T: 1, calibrated: false }, tuned: { accuracy: { right: 57, total: 60, rate: 0.95, low: 0.88, high: 0.98 }, T: 1, calibrated: true } };
    await testDb.update(realSchema.trainingJobs).set({ status: "succeeded", terminatedAt: new Date(), evalSummary: summary as never, params: { ...job!.params, baseModel: R30B } }).where(eq(realSchema.trainingJobs.id, body.jobId));
    const verdict = (await import("@/lib/caps/gpu/general")).verdictFor(summary as never, true);
    if (verdict.passed) {
      const jobsBefore = (await testDb.select().from(realSchema.trainingJobs)).length;
      const reused = await train.handleProductTrain(post(), "desk", deps);
      assert.equal(reused.status, 200, await reused.clone().text());
      assert.equal(((await reused.json()) as { adapterJobId: string }).adapterJobId, body.jobId);
      assert.equal((await testDb.select().from(realSchema.trainingJobs)).length, jobsBefore);
    } else {
      assert.fail(`the made-up summary should pass: ${verdict.words}`);
    }

    // Its product may call it through /decide. Another product gets the same 404 as an unknown model.
    const model = await store.getDecisionModel(body.jobId);
    assert.equal(model!.public, false);
    assert.equal(model!.productId, product!.id);
    const { handleDecide } = await import("@/lib/gateway/decide");
    const decideDeps = (productId: string) => ({
      findToken: async () => ({ id: "t", productId, scope: "live", allowedModels: ["muse-decide"], dailyBudgetUsd: 1, buildId: null }) as never,
      productStatus: async () => "live" as const,
      hitRateLimits: async () => ({}),
      findModel: store.getDecisionModel,
      backend: async () => null,
      recordUsage: async () => {},
    });
    const ask = () => new Request("https://muse.example.com/api/gateway/decide", { method: "POST", headers: { authorization: "Bearer x" }, body: JSON.stringify({ state: "A made-up ticket", model: body.jobId }) });
    assert.equal((await handleDecide(ask(), decideDeps(product!.id))).status, 503, "its product gets past the check, to a closed window");
    assert.equal((await handleDecide(ask(), decideDeps(productId))).status, 404);
  });

  it("shares a Try it live GPU on the real store, and settles at what that job cost", async () => {
    await testDb.update(realSchema.trainingJobs).set({ status: "succeeded", terminatedAt: new Date() }).where(sql`${realSchema.trainingJobs.status} not in ('succeeded', 'failed', 'stopped')`);
    const wd = gpuDeps.windowDeps();
    // The room's Try it live: a serve job for this adapter, already up.
    const [demo] = await testDb
      .insert(realSchema.trainingJobs)
      .values({ recipe: "glimmer-serve", title: "Try it live", status: "running", params: { adapterJobId: adapterId }, instanceType: GPU.name, region: "us-east-1", priceCentsPerHour: 129, maxMinutes: 30, maxUsd: 2, instanceName: "made-up-demo", instanceId: "i-demo", launchedAt: new Date(), tokenHash: "made-up", instanceIp: "203.0.113.8", serveEndpoint: { ip: "203.0.113.8", port: 8443, certSha256: "b".repeat(64), startedAt: new Date().toISOString() } } as never)
      .returning();
    const opened = await windows.openWindow({ adapterJobId: adapterId, minutes: 10 }, { userId: adminId }, wd);
    assert.ok(opened.ok, JSON.stringify(opened));
    assert.equal(opened.window.serveJobId, demo!.id, "the same GPU, no second one");
    assert.equal((await testDb.select().from(realSchema.trainingJobs).where(eq(realSchema.trainingJobs.recipe, "glimmer-serve"))).filter((j) => !j.terminatedAt).length, 1);

    // Closing stops the room's demo too: one GPU, and that's the side that saves money.
    const closing = await windows.closeWindow(opened.window.id, wd);
    assert.equal(closing?.status, "closing");
    assert.equal((await store.getJob(demo!.id))!.stopRequested, true);
    await testDb.update(realSchema.trainingJobs).set({ status: "stopped", costUsd: 0.2, terminatedAt: new Date() }).where(eq(realSchema.trainingJobs.id, demo!.id));
    assert.equal(await windows.sweepWindows(new Date(), wd), 1);
    const [settled] = await testDb.select().from(realSchema.glimmerWindows).where(eq(realSchema.glimmerWindows.id, opened.window.id));
    assert.ok(Math.abs(settled!.costUsd! - 0.2) < 0.001);
  });

  it("finds the serve job a crash left unattached", async () => {
    const wd = gpuDeps.windowDeps();
    const [serve] = await testDb
      .insert(realSchema.trainingJobs)
      .values({ recipe: "glimmer-serve", title: "Orphan", status: "running", params: { adapterJobId: adapterId }, instanceType: GPU.name, region: "us-east-1", priceCentsPerHour: 129, maxMinutes: 30, maxUsd: 2, instanceName: "made-up-orphan", instanceId: "i-orphan", launchedAt: new Date() } as never)
      .returning();
    assert.equal(await wd.serveJobOf(adapterId), serve!.id);
    await testDb.update(realSchema.trainingJobs).set({ status: "stopped", terminatedAt: new Date() }).where(eq(realSchema.trainingJobs.id, serve!.id));
    assert.equal(await wd.serveJobOf(adapterId), null);
  });
});
