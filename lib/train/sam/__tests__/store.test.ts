/**
 * SAM tune runs on an in-memory PGlite migrated with drizzle/ (0033): the claim the database holds under a race, a lost
 * lease, Stop, the upload caps, and a report from a wrong token. Blob is faked; no board, no model, no spend.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/sam/__tests__/store.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";
import { SAM_TUNE_LIMITS } from "@/lib/train/sam/types";
import { nov3Report } from "./nov3";

const canMock = typeof (mock as { module?: unknown }).module === "function";
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;

describe("SAM tune runs", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let store: typeof import("../store");
  let saved = 0;
  const board = { workerId: "jetson-03", freeMemMb: 6000, freeDiskMb: 1000 };

  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../../drizzle", import.meta.url).pathname });
    mock.module(new URL("../../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    mock.module(new URL("../../../storage.ts", import.meta.url).href, {
      namedExports: { putFile: async (prefix: string, path: string) => `https://blob.example/${prefix}/${path}-${++saved}` },
    });
    store = await import("../store");
  });
  after(() => client?.close());
  beforeEach(async () => {
    await testDb.delete(realSchema.samTuneRuns);
  });

  const queued = async (word = "muse") => {
    const made = await store.createRun({ word, generic: "plush toy", data: "builtin-muse", createdBy: null, seed: 20261103 });
    assert.ok(made.ok);
    assert.equal(made.run.status, "draft");
    assert.equal(await store.queueRun(made.run.id), true);
    return made.run.id;
  };

  it("refuses a bad name, and keeps the built-in photos to muse", async () => {
    assert.equal((await store.createRun({ word: "Muse", generic: "plush toy", data: "builtin-muse", createdBy: null })).ok, false);
    assert.equal((await store.createRun({ word: "bear", generic: "plush toy", data: "builtin-muse", createdBy: null })).ok, false);
    assert.equal((await store.createRun({ word: "bear", generic: "plush toy", data: "uploads", createdBy: null })).ok, true);
  });

  it("hands a run to one board when two poll at once, and the next only after it ends", async () => {
    const first = await queued();
    const second = await queued();
    assert.equal((await store.getRunView(second))!.queueAhead, 1);
    const claims = await Promise.all([store.claimNext(board), store.claimNext({ ...board, workerId: "jetson-02" })]);
    const won = claims.filter((c) => c !== null);
    assert.equal(won.length, 1);
    assert.equal(won[0]!.id, first);
    assert.match(won[0]!.jobToken, /^[0-9a-f]{64}$/);
    assert.equal(await store.claimNext(board), null, "one run claimed or running at a time");
    assert.equal((await store.getRunView(second))!.queueAhead, 1, "the one going is ahead");
    const row = (await store.getRun(first))!;
    assert.notEqual(row.jobTokenHash, won[0]!.jobToken, "only the hash is stored");
    assert.equal(await store.fail(first, won[0]!.jobToken, "out of memory"), "failed");
    const next = await store.claimNext(board);
    assert.equal(next?.id, second);
    assert.ok((await store.getRunView(second))!.boardSeenAt);
  });

  it("won't hand a run to a board short of memory or disk", async () => {
    await queued();
    assert.equal(await store.claimNext({ ...board, freeMemMb: 5000 }), null);
    assert.equal(await store.claimNext({ ...board, freeDiskMb: 200 }), null);
    assert.ok(await store.claimNext(board));
  });

  it("fails a run whose board stopped answering, and progress extends the lease", async () => {
    const id = await queued();
    const t0 = new Date("2026-11-04T04:00:00Z");
    const claim = (await store.claimNext(board, t0))!;
    const t1 = new Date(t0.getTime() + SAM_TUNE_LIMITS.leaseMs - 1000);
    assert.deepEqual(await store.progress(id, claim.jobToken, { stage: "training", step: 10, steps: 1000, line: "loss 4.4" }, t1), { stop: false });
    const t2 = new Date(t0.getTime() + SAM_TUNE_LIMITS.leaseMs + 1000);
    assert.equal(await store.expireLeases(t2), 0, "progress moved the lease on");
    const view = (await store.getRunView(id))!;
    assert.equal(view.status, "running");
    assert.deepEqual({ ...view.stage, at: undefined }, { stage: "training", step: 10, steps: 1000, line: "loss 4.4", at: undefined });
    const t3 = new Date(t1.getTime() + SAM_TUNE_LIMITS.leaseMs + 1000);
    assert.equal(await store.claimNext(board, t3), null);
    const row = (await store.getRun(id))!;
    assert.equal(row.status, "failed");
    assert.equal(row.error, store.LEASE_LOST);
    assert.equal(await store.progress(id, claim.jobToken, { stage: "training" }, t3), null, "the old token is dead");
  });

  it("stops a queued run at once, and tells a running board to stop", async () => {
    const waiting = await queued();
    const going = await queued();
    await testDb.update(realSchema.samTuneRuns).set({ createdAt: new Date(0) }).where((await import("drizzle-orm")).eq(realSchema.samTuneRuns.id, going));
    const claim = (await store.claimNext(board))!;
    assert.equal(claim.id, going);
    assert.equal(await store.requestStop(waiting), "stopped");
    assert.equal(await store.requestStop(going), "claimed");
    assert.deepEqual(await store.progress(going, claim.jobToken, { stage: "training" }), { stop: true });
    assert.equal(await store.fail(going, claim.jobToken, "stopped as asked"), "stopped");
    assert.equal(await store.requestStop(going), null, "already over");
  });

  it("refuses a done report from a wrong token, and writes the verdict itself", async () => {
    const id = await queued();
    const claim = (await store.claimNext(board))!;
    const wrong = "f".repeat(64);
    const scores = await store.saveUpload(id, claim.jobToken, "scores.json", "application/json", new TextEncoder().encode("{}"));
    const perImage = await store.saveUpload(id, claim.jobToken, "per_image.json", "application/json", new TextEncoder().encode("{}"));
    assert.ok(scores.ok && perImage.ok);
    const body = { ...nov3Report({ apFrom: 0.05, files: { scores: scores.url, perImage: perImage.url } }), verdict: { code: "better", text: "Tells muse apart from all toys" } };
    assert.deepEqual(await store.finish(id, wrong, body), { ok: false, status: 404, error: "not_found" });
    assert.equal((await store.getRun(id))!.status, "claimed");
    const done = await store.finish(id, claim.jobToken, body);
    assert.ok(done.ok);
    assert.equal(done.report.verdict.code, "mixed");
    const view = (await store.getRunView(id))!;
    assert.equal(view.status, "done");
    assert.equal(view.report!.verdict.code, "mixed");
    assert.equal((await store.finish(id, claim.jobToken, body)).ok, false, "the token is cleared once done");
    assert.equal(view.shown, false);
    assert.equal(await store.markShown(id, true), true);
    assert.equal((await store.getRunView(id))!.shown, true);
  });

  it("holds the upload caps: type, name, size and files a run", async () => {
    const id = await queued();
    const claim = (await store.claimNext(board))!;
    const jpg = new Uint8Array(1000);
    assert.equal((await store.saveUpload(id, "f".repeat(64), "sbs1.jpg", "image/jpeg", jpg)).ok, false);
    assert.deepEqual(await store.saveUpload(id, claim.jobToken, "sbs1.png", "image/png", jpg), { ok: false, status: 415, error: "type" });
    assert.deepEqual(await store.saveUpload(id, claim.jobToken, "../x.jpg", "image/jpeg", jpg), { ok: false, status: 400, error: "name" });
    assert.deepEqual(await store.saveUpload(id, claim.jobToken, "big.jpg", "image/jpeg", new Uint8Array(SAM_TUNE_LIMITS.uploadMaxBytes + 1)), { ok: false, status: 413, error: "size" });
    for (let i = 0; i < SAM_TUNE_LIMITS.uploadsMax; i++) {
      const got = await store.saveUpload(id, claim.jobToken, `sbs${i}.jpg`, "image/jpeg", jpg);
      assert.ok(got.ok && got.url.includes(`samtune/${id}/report/`), JSON.stringify(got));
    }
    assert.deepEqual(await store.saveUpload(id, claim.jobToken, "one-more.jpg", "image/jpeg", jpg), { ok: false, status: 429, error: "too_many_files" });
    assert.equal((await store.getRun(id))!.uploads.length, SAM_TUNE_LIMITS.uploadsMax);
  });
});
