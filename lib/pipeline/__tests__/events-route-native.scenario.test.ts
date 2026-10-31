/**
 * GET /api/builds/[buildId]/events for a finished build whose native run is still going: the stream stays open until the
 * run settles, and closes as it always has when there's no run. The database is faked. Needs
 * --experimental-test-module-mocks (skips without it).
 */
import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import type { BuildEvent } from "@/lib/types";

const BUILD_ID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4c";
let log: BuildEvent[] = [];
let asks = 0;
let activeFor = 0;

const fakeDb = () => ({
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status: "live" }] }) }) }),
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

describe("build events SSE route with a native run", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module(new URL("../../db/client.ts", import.meta.url).href, { namedExports: { db: fakeDb, schema: { builds: { id: "id", status: "status" } } } });
    mock.module(new URL("../../events.ts", import.meta.url).href, {
      namedExports: { eventsAfter: async (_buildId: string, after: number, limit: number) => log.filter((e) => e.id > after).slice(0, limit) },
    });
    mock.module(new URL("../../native/active.ts", import.meta.url).href, {
      namedExports: {
        nativeActive: async () => {
          asks++;
          return asks <= activeFor;
        },
      },
    });
    ({ GET } = await import(new URL("../../../app/api/builds/[buildId]/events/route.ts", import.meta.url).href));
  });

  it("closes a finished build's stream after the drain when no run is going, asking once", async () => {
    asks = 0;
    activeFor = 0;
    log = [{ id: 1, at: "2026-10-31T12:00:00.000Z", type: "status", status: "live" } as BuildEvent];
    const res = await GET(new Request(`http://x/events`), { params: Promise.resolve({ buildId: BUILD_ID }) });
    const text = await readAll(res);
    assert.match(text, /id: 1\n/);
    assert.equal(asks, 1);
  });

  it("keeps it open while a run is going, delivers what the run adds, and closes when it settles", { timeout: 30_000 }, async () => {
    asks = 0;
    activeFor = 1;
    log = [{ id: 1, at: "2026-10-31T12:00:00.000Z", type: "status", status: "live" } as BuildEvent];
    const started = Date.now();
    const reading = readAll(await GET(new Request(`http://x/events`), { params: Promise.resolve({ buildId: BUILD_ID }) }));
    // The route asks once the drain is over, about 2 s in, and every 5th poll after that. Add an event once it has asked.
    while (asks < 1) await new Promise((r) => setTimeout(r, 50));
    log = [...log, { id: 2, at: "2026-10-31T12:00:05.000Z", type: "native", runId: "r", origin: "ship", item: "package:android", target: "phone", state: "done", title: "Packaged" } as BuildEvent];
    const text = await reading;
    assert.match(text, /id: 2\n/, "the run's event arrived after the build had ended");
    assert.ok(asks >= 2, "it asked again before closing");
    assert.ok(Date.now() - started > 2_500);
  });
});
