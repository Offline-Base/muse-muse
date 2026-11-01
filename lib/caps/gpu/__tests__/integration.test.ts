/**
 * The whole path on an in-memory PGlite migrated with drizzle/, with the real store, the real launch checks (launchJob) and
 * General's real chat backend, and only Lambda, the workflow runtime and the GPU's answer faked. An admin opens a window, a
 * product asks, the window closes and settles. Then "Train on my data" saves a real dataset. No GPU, no model call.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/caps/gpu/__tests__/integration.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
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
    const { eq } = await import("drizzle-orm");
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
});
