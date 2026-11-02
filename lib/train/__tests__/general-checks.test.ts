/**
 * The general checks' fixed sets and helpers (lib/train/general-checks.ts) and the summary they add
 * (withCheckSummaries in lib/train/logic.ts). Pure: nothing calls a model, a GPU or a database.
 *
 *   npx tsx --test lib/train/__tests__/general-checks.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkNumber,
  checkPrompts,
  checkSetOf,
  checkTask,
  GENERAL_BASE,
  GENERAL_CHECKS,
  launchChecks,
  SAFETY_BASE,
  SAFETY_CHECKS,
  splitCheckIndexes,
} from "../general-checks";
import { summarizeJudgements, withCheckSummaries } from "../logic";

describe("general checks", () => {
  it("has about 20 prompts a set, each with a reference, none twice, and no em dashes", () => {
    for (const set of [GENERAL_CHECKS, SAFETY_CHECKS]) {
      assert.equal(set.length, 20);
      for (const c of set) {
        assert.ok(c.prompt.trim() && c.reference.trim(), c.prompt);
        assert.ok(c.prompt.length <= 3500 && c.reference.length <= 3500, "fits an eval callback's text cap");
      }
    }
    const all = checkPrompts();
    assert.equal(new Set(all.map((c) => c.prompt)).size, all.length);
    const text = JSON.stringify(all) + checkTask("general") + checkTask("safety");
    assert.ok(!text.includes("\u2014"), "no em dashes");
  });

  it("numbers each set above any held-out prompt, within the events route's 9999", () => {
    const all = checkPrompts();
    assert.deepEqual(
      all.map((c) => c.index),
      [...GENERAL_CHECKS.map((_, i) => GENERAL_BASE + i), ...SAFETY_CHECKS.map((_, i) => SAFETY_BASE + i)],
    );
    assert.ok(all.every((c) => c.index > 120 && c.index <= 9999));
    assert.equal(checkSetOf(0), null);
    assert.equal(checkSetOf(99), null);
    assert.equal(checkSetOf(GENERAL_BASE), "general");
    assert.equal(checkSetOf(GENERAL_BASE + GENERAL_CHECKS.length), null, "past the general set");
    assert.equal(checkSetOf(SAFETY_BASE + 3), "safety");
    assert.equal(checkSetOf(9000.5), null);
    assert.equal(checkNumber(GENERAL_BASE), 1);
    assert.equal(checkNumber(SAFETY_BASE + 19), 20);
    assert.equal(checkNumber(4), 0);
  });

  it("adds checks to a launch only when on, for a glimmer-lora chat job", () => {
    assert.equal(launchChecks("glimmer-lora", { datasetId: "x" }, false), undefined);
    assert.equal(launchChecks("glimmer-lora", { datasetId: "x" }, true)?.length, 40);
    assert.equal(launchChecks("glimmer-lora", { datasetId: "x", mode: "chat" }, true)?.length, 40);
    assert.equal(launchChecks("glimmer-lora", { datasetId: "x", mode: " Decide " }, true), undefined);
    assert.equal(launchChecks("glimmer-serve", {}, true), undefined);
    assert.equal(launchChecks("rl-grpo", {}, true), undefined);
  });

  it("splits a job's eval indexes into the task's and each set's", () => {
    assert.deepEqual(splitCheckIndexes([0, 1, 2]), { task: [0, 1, 2], general: [], safety: [] });
    assert.deepEqual(splitCheckIndexes([0, 1, 9000, 9001, 9500, 9999]), { task: [0, 1, 9999], general: [9000, 9001], safety: [9500] });
  });
});

describe("withCheckSummaries", () => {
  const task = summarizeJudgements([
    { baseScore: 4, tunedScore: 8, better: "tuned", costUsd: 0.002 },
    { baseScore: 5, tunedScore: 5, better: "tie", costUsd: 0.001 },
  ]);

  it("keeps the task's numbers, adds each set's, and sums the cost", () => {
    const out = withCheckSummaries(task, {
      general: { items: [{ baseScore: 8, tunedScore: 6, better: "base", costUsd: 0.0015 }], asked: 2 },
      safety: { items: [{ baseScore: 9, tunedScore: 9, better: "tie", costUsd: 0.0005 }], asked: 1 },
    });
    assert.deepEqual({ ...out, general: undefined, safety: undefined, judgeCostUsd: task.judgeCostUsd }, { ...task, general: undefined, safety: undefined });
    assert.equal(out.judgeCostUsd, 0.005);
    assert.deepEqual(out.general, { items: 1, asked: 2, tunedWins: 0, baseWins: 1, ties: 0, avgBaseScore: 8, avgTunedScore: 6, judgeCostUsd: 0.0015 });
    assert.deepEqual(out.safety, { items: 1, asked: 1, tunedWins: 0, baseWins: 0, ties: 1, avgBaseScore: 9, avgTunedScore: 9, judgeCostUsd: 0.0005 });
    assert.ok(!("general" in task), "the task's summary isn't changed in place");
  });

  it("leaves out a set that wasn't asked", () => {
    const out = withCheckSummaries(task, { general: { items: [], asked: 0 } });
    assert.deepEqual(out, task);
  });
});
