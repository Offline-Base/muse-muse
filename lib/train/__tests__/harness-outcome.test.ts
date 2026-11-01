/**
 *   npx tsx --test lib/train/__tests__/harness-outcome.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { harnessOutcome } from "@/lib/train/harness-outcome";

const line = (body: object) => JSON.stringify(body);

describe("harnessOutcome", () => {
  it("is a success only with a done", () => {
    assert.equal(harnessOutcome([line({ type: "progress", step: 1 }), line({ type: "done", metrics: {} })]).status, "succeeded");
  });

  it("keeps the runner's error on a failed run", () => {
    assert.deepEqual(harnessOutcome([line({ type: "failed", error: "CUDA out of memory" }), line({ type: "log", text: "end" })]), { status: "failed", reason: "CUDA out of memory" });
  });

  it("calls a run with no done or failed a failure, even with evals", () => {
    const outcome = harnessOutcome([line({ type: "eval", index: 0 }), line({ type: "heartbeat" })]);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.reason, /no done/);
    assert.equal(harnessOutcome([]).status, "failed");
  });
});
