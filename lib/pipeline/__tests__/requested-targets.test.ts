/**
 * What a person picks, from the routes through the build row to the writer, on PGlite with the repo's migrations, with auth
 * faked, the workflow's start() recorded and nothing reaching Meta, Vercel or a sandbox: POST /api/inspirations and
 * /api/rebuilds, the refusal for a target whose flag is off, briefStep, the files a phone product's sandbox gets, a
 * refinement keeping the picks and tool samples, and an agent's samples being written once.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/pipeline/__tests__/requested-targets.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import type { Brief } from "@/lib/brief/schema";
import * as realSchema from "@/lib/db/schema";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;
const ORIGIN = "https://muse.example.com";
const FLAGS = ["NATIVE_TARGETS", "VR_ENABLED", "GLASSES_ENABLED", "AGENTS_ENABLED", "COMPOSIO_PERSONAL_ENABLED"];

type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema> & {
  batch: (queries: PromiseLike<unknown>[]) => Promise<unknown[]>;
};

let client: import("@electric-sql/pglite").PGlite;
let testDb: TestDb;
let userId: string;
let starts = 0;
let writeInputs: Array<{ requestedTargets?: unknown }> = [];
let provisions: Array<Record<string, unknown>> = [];
let reopens: Array<Record<string, unknown>> = [];
let toolFixtureCalls = 0;
let toolFixturesImpl: () => Promise<unknown> = async () => ({ fixtures: { SAMPLE: [{ a: 1 }] }, usage: [] });

let inspirations: (req: Request) => Promise<Response>;
let rebuilds: (req: Request) => Promise<Response>;
let steps: typeof import("../build-steps");
let records: typeof import("../records");
let firstRebuildId: string;

const post = (path: string, body: unknown) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) });

async function buildRow(buildId: string) {
  const [row] = await testDb.select().from(realSchema.builds).where(eq(realSchema.builds.id, buildId));
  return row!;
}

async function setBrief(buildId: string, brief: Brief, productId?: string) {
  await testDb.update(realSchema.builds).set({ brief, ...(productId ? { productId } : {}) }).where(eq(realSchema.builds.id, buildId));
}

describe("requested targets", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    process.env.GATEWAY_TOKEN_PEPPER = "pepper-for-tests";
    process.env.PLATFORM_URL = ORIGIN;
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    const local: TestDb = Object.assign(drizzle({ client, schema: realSchema }), {
      batch: async (queries: PromiseLike<unknown>[]) => {
        const results: unknown[] = [];
        for (const q of queries) results.push(await q);
        return results;
      },
    });
    await migrate(local, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
    testDb = local;
    userId = randomUUID();
    await testDb.insert(realSchema.users).values({ id: userId, email: "maker@example.com" });

    mock.module(at("../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    const realAuth = (await import(at("../../auth.ts"))) as typeof import("../../auth");
    const viewer = { id: userId, email: "maker@example.com", isAdmin: true };
    mock.module(at("../../auth.ts"), { namedExports: { ...realAuth, requireUser: async () => viewer, requireAdminOrAutomation: async () => viewer } });
    const realQuota = (await import(at("../../quota.ts"))) as typeof import("../../quota");
    mock.module(at("../../quota.ts"), { namedExports: { ...realQuota, checkBuildAllowed: async () => ({ ok: true }), buildSetupRefusal: () => null, spendPaused: async () => false } });
    mock.module("workflow/api", {
      namedExports: {
        start: async () => {
          starts++;
          return { runId: `run-${starts}` };
        },
      },
    });
    mock.module(at("../workflow.ts"), { namedExports: { buildProduct: async () => null, refineProduct: async () => null } });
    mock.module(at("../../brief/write.ts"), {
      namedExports: {
        prepareFixtures: async () => ({ fixtures: [], usage: [], costUsd: 0 }),
        writeBrief: async (input: { requestedTargets?: unknown }) => {
          writeInputs.push(input);
          return { brief: BRIEF, transcripts: [], usage: [], costUsd: 0 };
        },
      },
    });
    mock.module(at("../../tools/fixtures.ts"), {
      namedExports: {
        prepareToolFixtures: async () => {
          toolFixtureCalls++;
          return toolFixturesImpl();
        },
      },
    });
    const realBuilder = (await import(at("../../sandbox/builder.ts"))) as Record<string, unknown>;
    mock.module(at("../../sandbox/builder.ts"), {
      namedExports: {
        ...realBuilder,
        provisionSandbox: async (input: Record<string, unknown>) => {
          provisions.push(input);
          return { sandboxName: "sandbox-1" };
        },
        reopenSandbox: async (input: Record<string, unknown>) => void reopens.push(input),
        writeProductFile: async () => undefined,
      },
    });

    ({ POST: inspirations } = await import("@/app/api/inspirations/route"));
    ({ POST: rebuilds } = await import("@/app/api/rebuilds/route"));
    steps = await import(at("../build-steps.ts"));
    records = await import(at("../records.ts"));
    const { catalogItems, itemId } = await import("@/lib/pipeline/catalog");
    firstRebuildId = itemId(catalogItems()[0]!);
  });

  after(async () => {
    await client.close();
    for (const f of ["GATEWAY_TOKEN_PEPPER", "PLATFORM_URL"]) delete process.env[f];
  });

  beforeEach(() => {
    for (const f of FLAGS) delete process.env[f];
    writeInputs = [];
    provisions = [];
    reopens = [];
    toolFixtureCalls = 0;
    toolFixturesImpl = async () => ({ fixtures: { SAMPLE: [{ a: 1 }] }, usage: [] });
  });

  describe("POST /api/inspirations", () => {
    it("with every flag off, ignores targets and stores nothing", async () => {
      const res = await inspirations(post("/api/inspirations", { note: "A timer.", references: [], targets: ["phone", "toaster"] }));
      assert.equal(res.status, 201);
      const { buildId } = (await res.json()) as { buildId: string };
      assert.equal((await buildRow(buildId)).requestedTargets, null);
    });

    it("stores what was picked, in order", async () => {
      process.env.NATIVE_TARGETS = "phone,desktop";
      const res = await inspirations(post("/api/inspirations", { note: "A timer.", references: [], targets: ["desktop", "web"] }));
      assert.equal(res.status, 201);
      const { buildId } = (await res.json()) as { buildId: string };
      assert.deepEqual((await buildRow(buildId)).requestedTargets, ["web", "desktop"]);
    });

    it("stores nothing when nothing was picked", async () => {
      process.env.NATIVE_TARGETS = "phone";
      const a = await inspirations(post("/api/inspirations", { note: "A timer.", references: [] }));
      const b = await inspirations(post("/api/inspirations", { note: "A timer.", references: [], targets: [] }));
      for (const res of [a, b]) assert.equal((await buildRow(((await res.json()) as { buildId: string }).buildId)).requestedTargets, null);
    });

    it("refuses a target whose flag is off, before anything starts", async () => {
      process.env.NATIVE_TARGETS = "phone";
      const before = starts;
      for (const targets of [["vr"], ["agent"], ["toaster"], "phone"]) {
        const res = await inspirations(post("/api/inspirations", { note: "A timer.", references: [], targets }));
        assert.equal(res.status, 400);
      }
      assert.equal(starts, before);
    });
  });

  describe("POST /api/rebuilds", () => {
    it("carries targets for a showcase batch", async () => {
      process.env.VR_ENABLED = "1";
      const res = await rebuilds(post("/api/rebuilds", { ids: [firstRebuildId], targets: ["vr"] }));
      assert.equal(res.status, 200);
      const { started } = (await res.json()) as { started: Array<{ buildId: string }> };
      assert.deepEqual((await buildRow(started[0]!.buildId)).requestedTargets, ["vr"]);
    });

    it("refuses a target whose flag is off, and ignores them all with every flag off", async () => {
      process.env.VR_ENABLED = "1";
      assert.equal((await rebuilds(post("/api/rebuilds", { ids: [firstRebuildId], targets: ["phone"] }))).status, 400);
      delete process.env.VR_ENABLED;
      const res = await rebuilds(post("/api/rebuilds", { ids: [firstRebuildId], targets: ["phone"] }));
      assert.equal(res.status, 200);
      const { started } = (await res.json()) as { started: Array<{ buildId: string }> };
      assert.equal((await buildRow(started[0]!.buildId)).requestedTargets, null);
    });
  });

  it("briefStep gives the writer what was picked", async () => {
    process.env.NATIVE_TARGETS = "phone";
    const { buildId } = await records.insertBuild({ userId, note: "x", references: [], rebuildOf: null, requestedTargets: ["web", "phone"] });
    await steps.briefStep(buildId);
    assert.deepEqual(writeInputs[0]?.requestedTargets, ["web", "phone"]);
  });

  async function product(brief: Brief, requestedTargets?: Brief["targets"]) {
    const { buildId } = await records.insertBuild({ userId, note: "x", references: [], rebuildOf: null, requestedTargets: requestedTargets?.map((t) => t.id) });
    await setBrief(buildId, brief);
    const productId = randomUUID();
    await testDb.insert(realSchema.products).values({
      id: productId,
      slug: `p-${productId.slice(0, 8)}`,
      name: "P",
      tagline: "T",
      ownerId: userId,
      status: "live",
      sandboxName: "sandbox-1",
      museSessionId: randomUUID(),
    });
    await testDb.update(realSchema.builds).set({ productId, status: "live" }).where(eq(realSchema.builds.id, buildId));
    return { buildId, productId };
  }

  describe("the sandbox's extra files", () => {
    it("aren't asked for on a web-only brief, not even as an empty list", async () => {
      const { buildId, productId } = await product(BRIEF);
      await steps.provisionStep({ buildId, productId, slug: "p", fixtures: [] });
      assert.ok(!("extraFiles" in provisions[0]!));
    });

    it("carry the bridge, manifest, icons and skill on a phone brief", async () => {
      const { buildId, productId } = await product({ ...BRIEF, targets: [{ id: "web", why: "w" }, { id: "phone", why: "p" }] });
      await steps.provisionStep({ buildId, productId, slug: "p", fixtures: [] });
      const paths = (provisions[0]!.extraFiles as Array<{ path: string }>).map((f) => f.path);
      for (const want of ["lib/native/bridge.ts", "app/manifest.ts", "app/icon.tsx", "app/apple-icon.tsx", ".agents/skills/muse-native/SKILL.md"]) assert.ok(paths.includes(want), want);
      assert.match(String(provisions[0]!.promptMarkdown), /## Where it runs/);
    });
  });

  describe("a refinement", () => {
    const phone: Brief = { ...BRIEF, targets: [{ id: "web", why: "w" }, { id: "phone", why: "p" }] };

    it("keeps the first build's picks", async () => {
      const { productId } = await product(phone, phone.targets);
      const refine = await records.insertRefineBuild({ userId, productId, rebuildOf: null, message: "Dark mode", references: [] });
      assert.deepEqual((await buildRow(refine!.buildId)).requestedTargets, ["web", "phone"]);
    });

    it("has none when the first build had none", async () => {
      const { productId } = await product(BRIEF);
      const refine = await records.insertRefineBuild({ userId, productId, rebuildOf: null, message: "Dark mode", references: [] });
      assert.equal((await buildRow(refine!.buildId)).requestedTargets, null);
    });

    it("keeps the brief, the tool samples and the prompt's target line", async () => {
      const { buildId, productId } = await product(phone);
      await testDb.update(realSchema.builds).set({ toolFixtures: { SAMPLE: [{ a: 1 }] } }).where(eq(realSchema.builds.id, buildId));
      const refine = await records.insertRefineBuild({ userId, productId, rebuildOf: null, message: "Dark mode", references: [] });
      const ctx = await steps.loadRefineStep(refine!.buildId);
      const row = await buildRow(refine!.buildId);
      assert.deepEqual(row.brief?.targets, phone.targets);
      assert.deepEqual(row.toolFixtures, { SAMPLE: [{ a: 1 }] });
      await steps.reopenStep({ buildId: refine!.buildId, productId, sandboxName: ctx.sandboxName, refineIndex: ctx.refineIndex });
      const paths = (reopens[0]!.extraFiles as Array<{ path: string }>).map((f) => f.path);
      assert.ok(paths.includes("lib/native/bridge.ts"));
    });

    it("asks for no extra files on a web-only product", async () => {
      const { productId } = await product(BRIEF);
      const refine = await records.insertRefineBuild({ userId, productId, rebuildOf: null, message: "Dark mode", references: [] });
      const ctx = await steps.loadRefineStep(refine!.buildId);
      await steps.reopenStep({ buildId: refine!.buildId, productId, sandboxName: ctx.sandboxName, refineIndex: ctx.refineIndex });
      assert.ok(!("extraFiles" in reopens[0]!));
    });
  });

  describe("an agent's tool samples", () => {
    const agent: Brief = {
      ...BRIEF,
      targets: [{ id: "web", why: "w" }, { id: "agent", why: "a" }],
      agent: { task: "Find papers.", tools: [{ id: "scholar", need: "n", why: "w" }], connections: "none", stepsPerRun: 3 },
    };

    it("aren't written for a product that isn't an agent", async () => {
      const { buildId } = await product(BRIEF);
      await steps.fixturesStep(buildId);
      assert.equal(toolFixtureCalls, 0);
      assert.equal((await buildRow(buildId)).toolFixtures, null);
    });

    it("are saved on the build, and a retry doesn't pay for them twice", async () => {
      const { buildId } = await product(agent);
      await steps.fixturesStep(buildId);
      assert.deepEqual((await buildRow(buildId)).toolFixtures, { SAMPLE: [{ a: 1 }] });
      await steps.fixturesStep(buildId);
      assert.equal(toolFixtureCalls, 1);
    });

    it("failing costs nothing but realism: the step still returns its fixtures", async () => {
      toolFixturesImpl = async () => {
        throw new Error("Meta is down");
      };
      const { buildId } = await product(agent);
      assert.deepEqual(await steps.fixturesStep(buildId), []);
      assert.equal((await buildRow(buildId)).toolFixtures, null);
    });
  });
});
