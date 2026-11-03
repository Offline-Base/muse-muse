/**
 * packageProductStep after a build ships: packages with the packager, says why in one room line without it, and is
 * quiet for a web product.
 *   npx tsx --experimental-test-module-mocks --test lib/pipeline/__tests__/package-step.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

let row: { brief: unknown; slug: string; name: string } | undefined;
const emitted: Array<{ buildId: string; body: Record<string, unknown> }> = [];
const runs: Array<Record<string, unknown>> = [];

const query = { from: () => query, innerJoin: () => query, where: () => query, limit: async () => (row ? [row] : []) };
mock.module("@/lib/db/client", { namedExports: { db: () => ({ select: () => query }), schema: { builds: {}, products: {} } } });
mock.module("@/lib/events", { namedExports: { emit: async (buildId: string, body: Record<string, unknown>) => void emitted.push({ buildId, body }) } });
mock.module("@/lib/native/package-run", {
  namedExports: {
    packageKinds: (targets: string[]) => [...(targets.includes("phone") ? ["android"] : []), ...(targets.includes("desktop") ? ["mac", "windows"] : [])],
    runPackaging: async (input: Record<string, unknown>) => void runs.push(input),
  },
});

let step: (input: { buildId: string; productId: string; liveUrl: string }) => Promise<void>;
const saved = process.env.PACKAGER_SNAPSHOT_ID;

before(async () => {
  ({ packageProductStep: step } = await import("@/lib/pipeline/package-step"));
});
after(() => {
  if (saved === undefined) delete process.env.PACKAGER_SNAPSHOT_ID;
  else process.env.PACKAGER_SNAPSHOT_ID = saved;
  mock.restoreAll();
});
beforeEach(() => {
  emitted.length = 0;
  runs.length = 0;
  delete process.env.PACKAGER_SNAPSHOT_ID;
});

const brief = (...ids: string[]) => ({ targets: ids.map((id) => ({ id, why: "A test." })) });
const input = { buildId: "b1", productId: "p1", liveUrl: "https://musemuse-aisle.vercel.app" };

describe("packageProductStep", () => {
  it("with no packager, writes one skipped line with the reason and packages nothing", async () => {
    row = { brief: brief("web", "phone", "desktop"), slug: "aisle", name: "Aisle" };
    await step(input);
    assert.equal(runs.length, 0);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].buildId, "b1");
    assert.equal(emitted[0].body.type, "native");
    assert.equal(emitted[0].body.state, "skipped");
    assert.equal(emitted[0].body.title, "The Android, Mac and Windows apps weren't made");
    assert.match(String(emitted[0].body.detail), /Not made for this build: the app packager isn't set up on this site\./);
  });

  it("with the packager, runs it and adds no skipped line", async () => {
    process.env.PACKAGER_SNAPSHOT_ID = "snap_test";
    row = { brief: brief("web", "phone"), slug: "aisle", name: "Aisle" };
    await step(input);
    assert.equal(emitted.length, 0);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].url, input.liveUrl);
    assert.deepEqual(runs[0].targets, ["web", "phone"]);
  });

  it("says nothing for a brief with no phone or desktop", async () => {
    row = { brief: brief("web", "vr"), slug: "lantern", name: "Lantern" };
    await step(input);
    assert.deepEqual([emitted.length, runs.length], [0, 0]);
  });
});
