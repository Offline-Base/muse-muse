/**
 * Drives GET /api/builds/[buildId]/events with the database faked: framing, resume from Last-Event-ID, and closing
 * once the build is terminal and drained. Needs --experimental-test-module-mocks (skips without it).
 */
import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import type { BuildEvent } from "@/lib/types";

const BUILD_ID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
let status = "building";
let log: BuildEvent[] = [];
const asked: number[] = [];
let proveChecks = 0;
let proveRunningFor = 0;

const fakeDb = () => ({
  select: () => ({
    from: () => ({
      where: () => ({ limit: async () => (status ? [{ status }] : []) }),
    }),
  }),
});

const canMock = typeof (mock as { module?: unknown }).module === "function";
let GET: (req: Request, ctx: { params: Promise<{ buildId: string }> }) => Promise<Response>;

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += decoder.decode(value);
  }
}

describe("build events SSE route", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module(new URL("../../db/client.ts", import.meta.url).href, {
      namedExports: { db: fakeDb, schema: { builds: { id: "id", status: "status" } } },
    });
    mock.module(new URL("../../events.ts", import.meta.url).href, {
      namedExports: {
        eventsAfter: async (_buildId: string, after: number, limit: number) => {
          asked.push(after);
          return log.filter((e) => e.id > after).slice(0, limit);
        },
        // Says a Prove it run is going for this many asks.
        proveStillRunning: async () => ++proveChecks <= proveRunningFor,
      },
    });
    ({ GET } = await import(new URL("../../../app/api/builds/[buildId]/events/route.ts", import.meta.url).href));
  });

  it("404s unknown and malformed ids", async () => {
    status = "";
    const res = await GET(new Request("http://x/events"), { params: Promise.resolve({ buildId: BUILD_ID }) });
    assert.equal(res.status, 404);
    const bad = await GET(new Request("http://x/events"), { params: Promise.resolve({ buildId: "nope" }) });
    assert.equal(bad.status, 404);
  });

  it("streams events after Last-Event-ID and closes once the build is terminal and drained", async () => {
    status = "verifying";
    log = [
      { id: 5, at: "t", type: "log", text: "old" },
      { id: 6, at: "t", type: "verify", round: 0, summary: { passed: true, steps: [], failureOutput: "" }, screenshots: [] },
      { id: 7, at: "t", type: "status", status: "live" },
      { id: 8, at: "t", type: "log", text: "after the end\nsecond line" },
    ];
    asked.length = 0;
    const res = await GET(new Request("http://x/events?after=1", { headers: { "last-event-id": "5" } }), {
      params: Promise.resolve({ buildId: BUILD_ID }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
    const startedAt = Date.now();
    const body = await readAll(res);
    const elapsed = Date.now() - startedAt;
    assert.equal(asked[0], 5, "Last-Event-ID wins over ?after=");
    const messages = body.split("\n\n").filter((m) => m.startsWith("id: "));
    assert.deepEqual(
      messages.map((m) => m.split("\n")[0]),
      ["id: 6", "id: 7", "id: 8"],
    );
    for (const m of messages) {
      const lines = m.split("\n");
      assert.equal(lines[1], "event: build");
      assert.equal(lines.length, 3);
      const event = JSON.parse(lines[2]!.slice("data: ".length)) as BuildEvent;
      assert.equal(`id: ${event.id}`, lines[0]);
    }
    assert.ok(body.startsWith("retry: 3000\n\n"));
    assert.ok(elapsed >= 1_900 && elapsed < 6_000, `closed after ${elapsed} ms`);
  });

  it("leaves a plan picture out of the stream with PLAN_ART off, and passes it on with it on", async () => {
    const run = async () => {
      status = "live";
      log = [
        { id: 3, at: "t", type: "plan_art", url: "https://blob.example/fixtures/b/plan-art.jpg" },
        { id: 4, at: "t", type: "log", text: "after the picture" },
      ];
      asked.length = 0;
      const res = await GET(new Request("http://x/events?after=2"), { params: Promise.resolve({ buildId: BUILD_ID }) });
      const body = await readAll(res);
      return { ids: body.split("\n\n").filter((m) => m.startsWith("id: ")).map((m) => m.split("\n")[0]), asked: [...asked] };
    };
    delete process.env.PLAN_ART;
    const off = await run();
    assert.deepEqual(off.ids, ["id: 4"]);
    assert.ok(!off.asked.slice(1).includes(2), "the cursor moves past the skipped event");
    process.env.PLAN_ART = "1";
    try {
      assert.deepEqual((await run()).ids, ["id: 3", "id: 4"]);
    } finally {
      delete process.env.PLAN_ART;
    }
  });

  it("never asks about Prove it with the flag off", async () => {
    status = "live";
    log = [];
    proveChecks = 0;
    proveRunningFor = 5;
    const res = await GET(new Request("http://x/events"), { params: Promise.resolve({ buildId: BUILD_ID }) });
    await readAll(res);
    assert.equal(proveChecks, 0);
  });

  it("stays open past the build's end while a Prove it run is going, then closes", async () => {
    process.env.PRODUCT_OUTPUTS = "1";
    process.env.PROVE_IT = "1";
    try {
      status = "live";
      log = [];
      proveChecks = 0;
      proveRunningFor = 1;
      const startedAt = Date.now();
      const res = await GET(new Request("http://x/events"), { params: Promise.resolve({ buildId: BUILD_ID }) });
      await readAll(res);
      assert.equal(proveChecks, 2);
      // The first ask comes once it's drained, about 2 s in, and the next one 5 s later.
      assert.ok(Date.now() - startedAt >= 6_500, `closed after ${Date.now() - startedAt} ms`);
    } finally {
      delete process.env.PRODUCT_OUTPUTS;
      delete process.env.PROVE_IT;
    }
  });

  it("closes soon for a viewer who joins after the build ended", async () => {
    status = "failed";
    log = [{ id: 9, at: "t", type: "error", message: "boom" }];
    const res = await GET(new Request("http://x/events?after=9"), { params: Promise.resolve({ buildId: BUILD_ID }) });
    const startedAt = Date.now();
    const body = await readAll(res);
    assert.ok(Date.now() - startedAt < 4_000);
    assert.ok(!body.includes("id: "));
  });
});
