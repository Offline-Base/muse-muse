/**
 * The worker routes' gate: 404 with SAM_TUNE off, 401 without the board's secret (or with no hash set), and the run's
 * own job token on top for the id routes. The store is faked; no database.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/sam/__tests__/worker-auth.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it, mock } from "node:test";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const SECRET = "made-up-board-secret-for-tests";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "a".repeat(64);

describe("the SAM tune worker gate", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let auth: typeof import("../worker-auth");
  const saved = { tune: process.env.SAM_TUNE, sha: process.env.SAM_WORKER_TOKEN_SHA256 };

  before(async () => {
    mock.module(new URL("../store.ts", import.meta.url).href, {
      namedExports: { runForToken: async (id: string, token: unknown) => (id === RUN_ID && token === TOKEN ? { id } : null) },
    });
    auth = await import("../worker-auth");
  });
  after(() => {
    for (const [k, v] of [["SAM_TUNE", saved.tune], ["SAM_WORKER_TOKEN_SHA256", saved.sha]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const req = (secret?: string, headers: Record<string, string> = {}) =>
    new Request("http://localhost/api/train/sam/worker/next", { method: "POST", headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...headers } });
  const status = async (fn: () => unknown) => {
    try {
      await fn();
      return 200;
    } catch (err) {
      return (err as { status?: number }).status ?? 500;
    }
  };

  it("is a 404 with SAM_TUNE off, even with the right secret", async () => {
    delete process.env.SAM_TUNE;
    process.env.SAM_WORKER_TOKEN_SHA256 = createHash("sha256").update(SECRET).digest("hex");
    assert.equal(await status(() => auth.requireWorker(req(SECRET))), 404);
    assert.equal(await status(() => auth.requireRunToken(req(SECRET), RUN_ID, TOKEN)), 404);
  });

  it("is a 401 with no hash set, no secret or a wrong one", async () => {
    process.env.SAM_TUNE = "1";
    delete process.env.SAM_WORKER_TOKEN_SHA256;
    assert.equal(await status(() => auth.requireWorker(req(SECRET))), 401);
    process.env.SAM_WORKER_TOKEN_SHA256 = "not-hex";
    assert.equal(await status(() => auth.requireWorker(req(SECRET))), 401);
    process.env.SAM_WORKER_TOKEN_SHA256 = createHash("sha256").update(SECRET).digest("hex").toUpperCase();
    assert.equal(await status(() => auth.requireWorker(req())), 401);
    assert.equal(await status(() => auth.requireWorker(req("wrong"))), 401);
    assert.equal(await status(() => auth.requireWorker(req(SECRET))), 200, "the hash is read in either case");
  });

  it("needs the run's own job token, from the body or the header", async () => {
    process.env.SAM_TUNE = "1";
    process.env.SAM_WORKER_TOKEN_SHA256 = createHash("sha256").update(SECRET).digest("hex");
    assert.equal(await status(() => auth.requireRunToken(req(SECRET), RUN_ID, TOKEN)), 200);
    assert.equal(await status(() => auth.requireRunToken(req(SECRET, { [auth.JOB_TOKEN_HEADER]: TOKEN }), RUN_ID)), 200);
    assert.equal(await status(() => auth.requireRunToken(req(SECRET), RUN_ID, "b".repeat(64))), 404);
    assert.equal(await status(() => auth.requireRunToken(req(SECRET), RUN_ID)), 404);
    assert.equal(await status(() => auth.requireRunToken(req("wrong"), RUN_ID, TOKEN)), 401);
  });
});
