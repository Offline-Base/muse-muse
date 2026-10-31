/**
 * The Prove it steps that deal with money, on a real Postgres (PGlite): what a run charges and when, what counts toward
 * its cap, and the total a build may spend across runs. The sandbox is faked. Nothing reaches a sandbox or Meta.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/pipeline/__tests__/prove-steps.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/lib/db/schema";
import type * as ProveSteps from "../prove-steps";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (relative: string) => new URL(relative, import.meta.url).href;

const obj = { type: "object" };
const manifest = {
  name: "Tip",
  slug: "tip",
  tagline: "Tips",
  inspiration: "x",
  models: [{ id: "muse-wonder-1.0", usedFor: "x" }],
  actions: [{ name: "go", description: "Goes.", input: obj, output: obj, example: { a: 1 } }],
  fixtures: [],
  limits: [],
  estimatedCostPerRunUsd: 0.001,
};

let forks: string[] = [];
let deleted: string[] = [];
let written: Array<{ path: string; content: unknown }> = [];
let sandboxFiles: Record<string, string> = {};

describe("Prove it's money", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let steps: typeof ProveSteps;
  let buildId: string;
  let productId: string;
  let inspirationId: string;
  const since = new Date(Date.now() - 60_000).toISOString();

  const ctx = (over: Partial<ProveSteps.ProveCtx> = {}): ProveSteps.ProveCtx => ({
    buildId,
    productId,
    runId: "run-1",
    origin: "ship",
    copy: "prove-x",
    slug: "tip",
    name: "Tip",
    liveUrl: "https://tip.vercel.app",
    site: "https://site.vercel.app",
    capUsd: 1.5,
    model: "muse-wonder-1.0",
    record: true,
    since,
    ...over,
  });

  const spend = (source: "gateway" | "tools" | "muse_code" | "platform", costUsd: number, more: { endpoint?: string; buildId?: string; at?: Date } = {}) =>
    database.insert(schema.usage).values({ source, productId, costUsd, endpoint: more.endpoint ?? "responses", buildId: more.buildId, at: more.at ?? new Date() });

  const buildCost = async () => (await database.select({ c: schema.builds.costUsd }).from(schema.builds).where(eq(schema.builds.id, buildId)))[0]!.c;
  const events = async (type = "prove") => (await database.select().from(schema.buildEvents).where(eq(schema.buildEvents.buildId, buildId)).orderBy(schema.buildEvents.id)).map((e) => e.payload as unknown as Record<string, unknown>).filter((e) => e.type === type);
  const stageLine = async () => (await events()).filter((e) => e.item === "stage").at(-1)!;

  before(async () => {
    process.env.PRODUCT_OUTPUTS = "1";
    process.env.PROVE_IT = "1";
    process.env.PROVE_IT_CAP_USD = "1.5";
    process.env.PLATFORM_URL = "https://site.vercel.app";
    client = new PGlite();
    database = drizzle({ client, schema });
    await migrate(database, { migrationsFolder: join(import.meta.dirname, "../../../drizzle") });
    mock.module(at("../../db/client.ts"), { namedExports: { db: () => database, schema } });
    mock.module(at("../build-steps.ts"), { namedExports: { charge: async () => undefined } });
    mock.module(at("../../sandbox/builder.ts"), {
      namedExports: {
        forkForProve: async (name: string) => {
          forks.push(name);
          return { sandboxName: "prove-x" };
        },
        deleteProveCopy: async (name: string) => void deleted.push(name),
        writeProveFiles: async (_copy: string, files: Array<{ path: string; content: unknown }>) => void written.push(...files),
        readSandboxText: async (_copy: string, path: string) => sandboxFiles[path] ?? null,
        startProveCommand: async () => ({ cmdId: "cmd" }),
        startSkillTest: async () => {
          throw new Error("the skill test must not start");
        },
      },
    });
    steps = await import("../prove-steps");
  });

  after(async () => {
    await client.close();
  });

  beforeEach(async () => {
    forks = [];
    deleted = [];
    written = [];
    sandboxFiles = {};
    await client.exec(`truncate users cascade`);
    const [user] = await database.insert(schema.users).values({ email: `${randomUUID()}@example.com` }).returning();
    const [inspiration] = await database.insert(schema.inspirations).values({ userId: user!.id }).returning();
    inspirationId = inspiration!.id;
    const [row] = await database
      .insert(schema.products)
      .values({ slug: "tip", name: "Tip", tagline: "Tips", ownerId: user!.id, status: "live", liveUrl: "https://tip.vercel.app", sandboxName: "product-tip", manifest: manifest as never })
      .returning();
    productId = row!.id;
    const [build] = await database.insert(schema.builds).values({ inspirationId, productId, userId: user!.id, status: "live" }).returning();
    buildId = build!.id;
  });

  describe("charging", () => {
    it("closing charges the product's model and tool calls once, and says the run's whole cost", async () => {
      await spend("gateway", 0.3);
      await spend("tools", 0.2);
      await spend("muse_code", 0.1, { endpoint: "muse exec prove", buildId });
      await steps.proveCloseStep(ctx());
      assert.ok(Math.abs((await buildCost()) - 0.5) < 1e-6, String(await buildCost()));
      const stage = await stageLine();
      assert.equal(stage.state, "done");
      assert.ok(Math.abs((stage.costUsd as number) - 0.6) < 1e-6);
      assert.deepEqual(deleted, ["prove-x"]);
    });

    it("a run that failed still charges what it spent and says so", async () => {
      await spend("gateway", 0.3);
      await spend("tools", 0.2);
      await spend("muse_code", 0.1, { endpoint: "muse exec prove", buildId });
      await steps.proveFailStep(ctx(), new Error("the copy went away"));
      assert.ok(Math.abs((await buildCost()) - 0.5) < 1e-6, String(await buildCost()));
      const stage = await stageLine();
      assert.equal(stage.state, "failed");
      assert.ok(Math.abs((stage.costUsd as number) - 0.6) < 1e-6);
      assert.deepEqual(deleted, ["prove-x"]);
      assert.equal((await events("cost")).length, 1);
    });

    it("doesn't count usage from before the run or another product's", async () => {
      await spend("gateway", 5, { at: new Date(Date.now() - 3_600_000) });
      await spend("platform", 7);
      await steps.proveCloseStep(ctx());
      assert.equal(await buildCost(), 0);
      assert.equal((await events("cost")).length, 0);
    });

    it("still ends the run when the database won't take the charge", async () => {
      const failing = ctx({ productId: "not-a-uuid" });
      await steps.proveFailStep(failing, new Error("boom"));
      assert.deepEqual(deleted, ["prove-x"]);
      assert.equal((await stageLine()).state, "failed");
    });
  });

  describe("the cap during the checks", () => {
    it("is over once the product's calls reach what's left", async () => {
      assert.equal(await steps.proveChecksOverCapStep(ctx()), false);
      await spend("gateway", 1);
      assert.equal(await steps.proveChecksOverCapStep(ctx()), false);
      await spend("tools", 0.5);
      assert.equal(await steps.proveChecksOverCapStep(ctx()), true);
    });

    it("says the budget stopped the checks, and doesn't blame the skill file", async () => {
      sandboxFiles["/vercel/musemuse/prove/results.json"] = JSON.stringify({ startedAt: "x", finishedAt: null, outputs: { mcp: { ok: false, steps: [], facts: { listed: [], called: [] } } } });
      sandboxFiles["/vercel/musemuse/prove/spec.json"] = JSON.stringify({ calls: [] });
      const end = await steps.proveCollectChecksStep(ctx(), "budget");
      assert.equal(end.summaries.mcp!.state, "failed");
      assert.equal(end.summaries.mcp!.detail, "The checks reached this run's budget and were stopped.");
      assert.equal(end.summaries.claude_plugin!.detail, "The checks reached this run's budget and were stopped.");
      assert.equal(end.stopped, "budget");
      assert.equal(await steps.proveStartSkillStep(ctx(), end), null);
      const skill = (await events()).filter((e) => e.item === "skill").at(-1)!;
      assert.equal(skill.state, "skipped");
      assert.equal(skill.detail, "The checks reached this run's budget and were stopped.");
    });

    it("says when time stopped them", async () => {
      const end = await steps.proveCollectChecksStep(ctx(), "time");
      assert.equal(end.summaries.cli!.detail, "The checks ran out of time.");
    });
  });

  describe("the total a build may spend", () => {
    const earlier = (runId: string, costUsd: number, state = "done") =>
      database.insert(schema.buildEvents).values({ buildId, type: "prove", payload: { type: "prove", runId, origin: "ship", item: "stage", state, title: "x", costUsd } as never });
    const input = (origin: "ship" | "nightly" = "nightly") => ({ buildId, runId: "run-now", origin });

    it("gives the first run the whole cap", async () => {
      const opened = await steps.proveOpenStep(input("ship"));
      assert.equal(opened?.capUsd, 1.5);
      assert.deepEqual(forks, ["product-tip"]);
    });

    it("gives a later run only what earlier runs left, failed ones too", async () => {
      await earlier("r1", 0.4);
      await earlier("r2", 0.3, "failed");
      const opened = await steps.proveOpenStep(input());
      assert.ok(Math.abs(opened!.capUsd - 0.8) < 1e-6);
    });

    it("doesn't start a run, or copy anything, once the build's cap is used", async () => {
      await earlier("r1", 1.5);
      assert.equal(await steps.proveOpenStep(input()), null);
      assert.deepEqual(forks, []);
      const stage = await stageLine();
      assert.equal(stage.state, "skipped");
      assert.match(String(stage.detail), /budget/);
    });

    it("doesn't count another build's runs", async () => {
      const [other] = await database.insert(schema.builds).values({ inspirationId, productId, userId: (await database.select().from(schema.users))[0]!.id, status: "live" }).returning();
      await database.insert(schema.buildEvents).values({ buildId: other!.id, type: "prove", payload: { type: "prove", runId: "o", origin: "ship", item: "stage", state: "done", title: "x", costUsd: 9 } as never });
      assert.equal((await steps.proveOpenStep(input()))?.capUsd, 1.5);
    });

    it("calls only read-only actions on a nightly run", async () => {
      await steps.proveOpenStep(input("nightly"));
      const spec = JSON.parse(String(written.find((f) => f.path.endsWith("spec.json"))!.content)) as { calls: unknown[]; notCalled: Array<{ name: string }> };
      assert.deepEqual(spec.calls, []);
      assert.deepEqual(spec.notCalled.map((n) => n.name), ["go"]);
      written = [];
      await steps.proveOpenStep(input("ship"));
      const ship = JSON.parse(String(written.find((f) => f.path.endsWith("spec.json"))!.content)) as { calls: Array<{ name: string }> };
      assert.deepEqual(ship.calls.map((c) => c.name), ["go"]);
    });
  });
});
