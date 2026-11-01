/**
 * The lifetime GPU limits' arithmetic (lib/train/gpu-budget.ts). Pure, so no database. launch.test.ts runs them through
 * launchJob against a real Postgres.
 *
 *   npx tsx --test lib/train/__tests__/gpu-budget.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startErrorText } from "@/components/train/format";
import { budgetPassed, budgetRefusalText, gpuBudget, holdToBudget, jobHoldUsd, type GpuSpendRow } from "@/lib/train/gpu-budget";

const now = new Date("2026-11-01T12:00:00Z");
const row = (over: Partial<GpuSpendRow> = {}): GpuSpendRow => ({ status: "succeeded", priceCentsPerHour: 120, maxUsd: 5, launchedAt: new Date("2026-11-01T10:00:00Z"), terminatedAt: new Date("2026-11-01T11:00:00Z"), costUsd: 1.2, createdBy: "a", ...over });
const limits = { userUsd: 100, totalUsd: 3000 };

describe("jobHoldUsd", () => {
  it("a job that ended and shut down holds what it cost", () => {
    assert.equal(jobHoldUsd(row(), now), 1.2);
  });
  it("a job that never launched holds nothing once it has ended", () => {
    assert.equal(jobHoldUsd(row({ status: "failed", launchedAt: null, terminatedAt: null, costUsd: 0 }), now), 0);
  });
  it("an unfinished job holds its whole limit, even before it launches", () => {
    assert.equal(jobHoldUsd(row({ status: "queued", launchedAt: null, terminatedAt: null, costUsd: 0 }), now), 5);
  });
  it("an unfinished job past its limit holds what it has run up", () => {
    assert.equal(jobHoldUsd(row({ status: "running", terminatedAt: null, maxUsd: 1 }), now), 2.4);
  });
  it("an ended job with its GPU not confirmed down keeps counting", () => {
    assert.equal(jobHoldUsd(row({ status: "failed", terminatedAt: null, costUsd: 0 }), now), 2.4);
  });
});

describe("gpuBudget", () => {
  it("adds a person's jobs for them and everyone's for the total", () => {
    const b = gpuBudget([row(), row({ createdBy: "b" }), row({ createdBy: null })], "a", limits, now);
    assert.equal(b.userUsedUsd, 1.2);
    assert.equal(b.totalUsedUsd, 3.6);
    assert.equal(b.userLeftUsd, 98.8);
    assert.equal(b.totalLeftUsd, 2996.4);
    assert.equal(b.scope, "user");
  });
  it("what's left rounds down to cents and stops at 0", () => {
    assert.equal(gpuBudget([row({ costUsd: 99.995 })], "a", limits, now).userLeftUsd, 0);
    assert.equal(gpuBudget([row({ costUsd: 150 })], "a", limits, now).userLeftUsd, 0);
    assert.equal(gpuBudget([row({ costUsd: 99.994 })], "a", limits, now).userLeftUsd, 0);
    assert.equal(gpuBudget([row({ costUsd: 99.98 })], "a", limits, now).userLeftUsd, 0.02);
  });
  it("the smaller limit is the one that counts", () => {
    const b = gpuBudget([row({ createdBy: "b", costUsd: 2950 })], "a", limits, now);
    assert.equal(b.leftUsd, 50);
    assert.equal(b.scope, "total");
    assert.match(budgetRefusalText(b), /The platform has \$50\.00 left of its \$3,000 GPU budget/);
  });
  it("passing either limit counts, and reaching one exactly doesn't", () => {
    assert.equal(budgetPassed(gpuBudget([row({ costUsd: 100 })], "a", limits, now)), false);
    assert.equal(budgetPassed(gpuBudget([row({ costUsd: 100.01 })], "a", limits, now)), true);
    assert.equal(budgetPassed(gpuBudget([row({ createdBy: "b", costUsd: 3000.01 })], "a", limits, now)), true);
  });
});

describe("holdToBudget", () => {
  const left = (usd: number) => gpuBudget([row({ costUsd: 100 - usd })], "a", limits, now);
  it("leaves the limit alone when it fits", () => {
    assert.deepEqual(holdToBudget(5, left(50)), { maxUsd: 5, held: false });
  });
  it("brings it down to what's left", () => {
    assert.deepEqual(holdToBudget(5, left(3.5)), { maxUsd: 3.5, held: true });
  });
  it("refuses under the smallest limit a job can have", () => {
    assert.equal(holdToBudget(5, left(0.05)), null);
  });
});

describe("the New job card", () => {
  it("shows the route's sentence", () => {
    assert.equal(startErrorText(429, { error: "gpu_limit", reason: "You have $1.00 left." }, { maxActive: 1, dailyUsd: 20 }), "You have $1.00 left.");
  });
});
