/**
 * The tuning loop against a real Postgres (an in-memory PGlite with the repo's migrations): its record in rate_limits,
 * one loop a run, the round's dataset, and stop reaching a round that doesn't exist yet. The workflow runs as a plain
 * function over faked steps. Nothing here reaches Neon, Lambda or Meta. All data is made up.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/tune/__tests__/loop-flow.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";
import type { LoopSpec } from "@/lib/train/tune/loop";

const canMock = typeof (mock as { module?: unknown }).module === "function";
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema> & { batch: (q: PromiseLike<unknown>[]) => Promise<unknown[]> };
const at = (rel: string) => new URL(rel, import.meta.url).href;

let client: import("@electric-sql/pglite").PGlite;
let store: typeof import("@/lib/train/store");
let loops: typeof import("@/lib/train/tune/loop-store");
let runStore: typeof import("@/lib/train/tune/run-store");
let wf: typeof import("@/lib/train/tune/loop-run");

/** What the faked steps answer, and the order they ran in. */
let script: { next: unknown[]; writer: unknown[]; merge: unknown; check: unknown; launch: unknown[]; ended: unknown[] };
let calls: string[] = [];
const take = (list: unknown[]) => (list.length > 1 ? list.shift() : list[0]);

const spec = (source: string): LoopSpec => ({ v: 1, sourceDatasetId: source, sourceJobId: "00000000-0000-4000-8000-000000000001", target: 8, capUsd: 10, maxRounds: 2, examples: 40, metaHighUsd: 1, scoreHighUsd: 0.2, callerId: "made-up-caller", startedAt: "2026-11-01T00:00:00.000Z" });

describe("tuning loop", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    const testDb: TestDb = Object.assign(drizzle({ client, schema: realSchema }), {
      batch: async (queries: PromiseLike<unknown>[]) => {
        const results: unknown[] = [];
        for (const q of queries) results.push(await q);
        return results;
      },
    });
    await migrate(testDb, { migrationsFolder: new URL("../../../../drizzle", import.meta.url).pathname });
    mock.module(at("../../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    mock.module("workflow", { namedExports: { sleep: async () => { calls.push("sleep"); }, FatalError: class extends Error {}, RetryableError: class extends Error {} } });
    mock.module(at("../loop-steps.ts"), {
      namedExports: {
        loopNextStep: async () => (calls.push("next"), take(script.next)),
        loopWriterStep: async () => (calls.push("writer"), take(script.writer)),
        loopMergeStep: async () => (calls.push("merge"), script.merge),
        loopLaunchStep: async () => (calls.push("launch"), take(script.launch)),
        loopJobEndedStep: async () => (calls.push("job"), take(script.ended)),
        loopEndStep: async (_: string, code: string) => { calls.push(`end:${code}`); },
      },
    });
    mock.module(at("../run-steps.ts"), { namedExports: { checkExamplesStep: async () => (calls.push("check"), script.check) } });
    store = await import("@/lib/train/store");
    loops = await import("@/lib/train/tune/loop-store");
    runStore = await import("@/lib/train/tune/run-store");
    wf = await import("@/lib/train/tune/loop-run");
  });

  after(async () => {
    mock.restoreAll();
    await client?.close();
  });

  const newSource = async () => (await store.createDataset({ title: "a made-up helper", task: "Answer made-up questions.", requested: 40, writerModel: "muse-wonder-1.0" })).id;

  it("keeps its settings and allows one running loop a run, until it ends", async () => {
    const source = await newSource();
    const id = await loops.createLoop(spec(source));
    assert.ok(id);
    assert.deepEqual((await loops.readLoop(id))?.spec, spec(source));
    assert.equal(await loops.createLoop(spec(source)), null);
    const loop = (await loops.readLoop(id))!;
    await loops.recordLoopEnded(loop, "round_limit");
    await loops.recordLoopEnded(loop, "error");
    assert.equal((await loops.readLoop(id))?.ended, "round_limit", "the first ending stands");
    const again = await loops.createLoop(spec(source));
    assert.ok(again);
    assert.deepEqual((await loops.loopsOfRun(source)).map((l) => l.id).sort(), [id, again].sort());
  });

  it("makes a round's dataset once, ready, with the source's title and kept-aside prompts", async () => {
    const source = await newSource();
    const id = loops.roundDatasetId(source, 1);
    const row = { messages: [{ role: "user" as const, content: "q" }] };
    const input = { id, title: "a made-up helper", task: "Answer made-up questions.", train: [row, row], eval: [{ prompt: "p", reference: "r" }], writerModel: "muse-wonder-1.0", createdBy: null };
    await loops.createRoundDataset(input);
    await loops.createRoundDataset({ ...input, title: "changed" });
    const d = await store.getDataset(id);
    assert.equal(d?.status, "ready");
    assert.equal(d?.title, "a made-up helper");
    assert.equal(d?.trainCount, 2);
    assert.equal(d?.evalCount, 1);
    assert.deepEqual(await loops.allRows(id, "eval"), [{ prompt: "p", reference: "r" }]);
  });

  it("stop blocks every round ahead of time, ends a writer in progress and frees the run", async () => {
    const source = await newSource();
    const id = (await loops.createLoop(spec(source)))!;
    const writer = await store.createDataset({ id: loops.writerDatasetId(id, 1), title: "extra", task: "t", requested: 40, writerModel: "muse-wonder-1.0" });
    await loops.stopLoop((await loops.readLoop(id))!);
    assert.equal((await store.getDataset(writer.id))?.status, "failed");
    for (const round of [1, 2]) assert.equal((await runStore.readRunMarks(loops.roundDatasetId(id, round))).stopped, true);
    assert.equal((await loops.readLoop(id))?.ended, "stopped");
    assert.ok(await loops.createLoop(spec(source)));
  });

  it("runs a round through to the next decision, and ends where the decision says", async () => {
    calls = [];
    script = {
      next: [{ kind: "go" }, { kind: "stop", code: "target_reached" }],
      writer: [{ kind: "writing" }, { kind: "ready" }],
      merge: { ok: true, datasetId: "d" },
      check: { ok: true, train: 20, eval: 16 },
      launch: [{ kind: "wait" }, { kind: "launched", jobId: "j" }],
      ended: [false, true],
    };
    assert.deepEqual(await wf.tuneLoop({ loopId: "l" }), { status: "target_reached" });
    assert.deepEqual(calls, ["next", "writer", "sleep", "writer", "merge", "check", "launch", "sleep", "launch", "job", "sleep", "job", "next"]);
  });

  it("spends nothing past a failed check, and records why", async () => {
    calls = [];
    script = { next: [{ kind: "go" }], writer: [{ kind: "ready" }], merge: { ok: true, datasetId: "d" }, check: { ok: false, code: "content" }, launch: [], ended: [] };
    assert.deepEqual(await wf.tuneLoop({ loopId: "l" }), { status: "check_failed" });
    assert.ok(!calls.includes("launch"));
    assert.equal(calls.at(-1), "end:check_failed");
  });
});
