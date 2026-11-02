/**
 * The tuning loop's rules, pure: which prompts are sealed, what the writer may see, the merge, the budget and when it
 * stops. All data is made up.
 *
 *   npx tsx --test lib/train/tune/__tests__/loop.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { focusTask, isSealed, loopSettings, mergeRows, nextMove, roundBudget, roundScore, roundSteps, stopText, weakPrompts, type LoopJudgement } from "@/lib/train/tune/loop";
import type { TrainExample } from "@/lib/train/types";

const j = (index: number, tunedScore: number, baseScore = 3, better: LoopJudgement["better"] = tunedScore > baseScore ? "tuned" : "base"): LoopJudgement => ({ index, baseScore, tunedScore, better });
const row = (prompt: string): TrainExample => ({ messages: [{ role: "system", content: "s" }, { role: "user", content: prompt }, { role: "assistant", content: "a" }] });
const sealedIndexes = Array.from({ length: 24 }, (_, i) => i).filter(isSealed);

describe("sealed prompts", () => {
  it("holds half out, with both of the judge's orders in it", () => {
    assert.equal(sealedIndexes.length, 12);
    assert.ok(sealedIndexes.some((i) => i % 2 === 0));
    assert.ok(sealedIndexes.some((i) => i % 2 === 1));
  });

  it("never shows a sealed prompt to the writer, even when it is the worst", () => {
    const prompts = Array.from({ length: 16 }, (_, i) => `prompt ${i}`);
    const judged = prompts.map((_, i) => j(i, isSealed(i) ? 1 : 7));
    const weak = weakPrompts(judged, prompts, 8);
    assert.ok(weak.length > 0);
    for (const p of weak) assert.equal(isSealed(Number(p.split(" ")[1])), false);
  });

  it("aims worst first, and at the lowest when nothing is below the target", () => {
    const prompts = ["p0", "p1", "p2", "p3", "p4"];
    assert.deepEqual(weakPrompts([j(0, 6), j(1, 4), j(4, 9)], prompts, 8), ["p1", "p0"]);
    assert.deepEqual(weakPrompts([j(0, 9), j(1, 8)], prompts, 8), ["p1", "p0"]);
  });

  it("takes prompts from the source's list, so an index with no prompt there is skipped", () => {
    assert.deepEqual(weakPrompts([j(0, 2), j(9, 1)], ["p0"], 8), ["p0"]);
  });
});

describe("score", () => {
  it("reaches the target only on the sealed half, and only when it clearly beats the base", () => {
    const eight = (tuned: number, base = 3) => Array.from({ length: 16 }, (_, i) => j(i, isSealed(i) ? tuned : 2, base));
    assert.equal(roundScore(eight(9), 8).reached, true);
    assert.equal(roundScore(eight(7), 8).reached, false);
    assert.equal(roundScore(eight(8.5, 8), 8).reached, false, "a base that is as good means tuning did nothing");
    assert.equal(roundScore(Array.from({ length: 16 }, (_, i) => j(i, isSealed(i) ? 2 : 10)), 8).reached, false, "a high working half doesn't count");
    assert.equal(roundScore(Array.from({ length: 12 }, (_, i) => j(i, 9)), 8).reached, false, "6 sealed are too few");
  });

  it("leaves the general checks (TUNE_GENERAL_CHECKS) out of both halves", () => {
    const task = Array.from({ length: 12 }, (_, i) => j(i, 9));
    // 40 checks, half of whose indexes isSealed would call sealed, all scoring high.
    const checks = [...Array.from({ length: 20 }, (_, i) => j(9000 + i, 10)), ...Array.from({ length: 20 }, (_, i) => j(9500 + i, 10))];
    const score = roundScore([...task, ...checks], 8);
    assert.equal(score.reached, false, "6 sealed task items are still too few");
    assert.equal(score.all.items, 12);
    assert.equal(score.sealed.items, 6);
    assert.deepEqual(roundScore([...task, ...checks], 8), roundScore(task, 8));
  });
});

describe("merge", () => {
  it("keeps the old rows, adds new ones, and never lets a kept-aside prompt in", () => {
    const aside = "how do I keep sourdough starter alive during a long summer vacation away";
    const { train, added } = mergeRows(
      [row("old one")],
      [
        { prompt: "a completely new question about rye", answer: "x" },
        { prompt: aside, answer: "x" },
        { prompt: "How do I keep sourdough starter alive during a long summer vacation away?", answer: "x" },
        { prompt: "Old one!", answer: "x" },
        { prompt: "blank answer", answer: " " },
      ],
      [aside],
      "sys",
    );
    assert.equal(added, 1);
    assert.deepEqual(train.map((t) => t.messages[1]!.content), ["old one", "a completely new question about rye"]);
    assert.equal(train[1]!.messages[0]!.content, "sys");
  });

  it("drops the oldest over the limit, never the new rows", () => {
    const { train, added } = mergeRows([row("a"), row("b"), row("c")], [{ prompt: "d", answer: "x" }, { prompt: "e", answer: "x" }], [], "s", 3);
    assert.equal(added, 2);
    assert.deepEqual(train.map((t) => t.messages[1]!.content), ["c", "d", "e"]);
  });

  it("keeps the task whole in the writer's task", () => {
    const t = focusTask("Answer bakery questions.", ["p\n1"]);
    assert.ok(t.startsWith("Answer bakery questions."));
    assert.ok(t.endsWith("- p 1"));
  });
});

describe("steps", () => {
  it("scales with the data, up to what the time allows, and never below the source's", () => {
    assert.equal(roundSteps(120, 180, 360, 2000), 240);
    assert.equal(roundSteps(120, 180, 360, 200), 200);
    assert.equal(roundSteps(120, 180, 90, 2000), 120);
    assert.equal(roundSteps(120, 180, 360, 50), 120);
  });
});

describe("budget", () => {
  const base = { spentUsd: 0, writerUsd: 1, scoreHighUsd: 0.5, ceilingUsd: 5, maxMinutes: 90, priceCentsPerHour: 129, estimateMinutes: 45 };
  it("gives the job what the cap leaves, under the job ceiling", () => {
    assert.deepEqual(roundBudget({ ...base, capUsd: 4 }), { gpuUsd: 2.5, fits: true });
    assert.deepEqual(roundBudget({ ...base, capUsd: 100 }), { gpuUsd: 5, fits: true });
  });
  it("doesn't fit when the estimate can't run on what's left", () => {
    assert.equal(roundBudget({ ...base, capUsd: 2 }).fits, false);
    assert.equal(roundBudget({ ...base, capUsd: 1 }).fits, false);
    assert.equal(roundBudget({ ...base, capUsd: 4, spentUsd: 3 }).gpuUsd, 0);
  });
});

describe("next move", () => {
  const good = roundScore(Array.from({ length: 16 }, (_, i) => j(i, 9)), 8);
  const low = roundScore(Array.from({ length: 16 }, (_, i) => j(i, 5)), 8);
  const m = { stopped: false, finished: 1, maxRounds: 3, jobStatus: "succeeded" as string | null, score: low, weakCount: 3, fits: true };
  const code = (over: Partial<typeof m>) => {
    const r = nextMove({ ...m, ...over });
    return r.kind === "stop" ? r.code : "go";
  };
  it("goes only when nothing stops it", () => assert.equal(code({}), "go"));
  it("stops at the target, before the round limit and the cap", () => assert.equal(code({ score: good, finished: 3, fits: false }), "target_reached"));
  it("stops at the round limit", () => assert.equal(code({ finished: 3 }), "round_limit"));
  it("stops at the cap", () => assert.equal(code({ fits: false }), "cap"));
  it("stops when a person did, whatever else", () => assert.equal(code({ stopped: true, score: good }), "stopped"));
  it("never spends after a failed or unscored round", () => {
    assert.equal(code({ jobStatus: "failed" }), "round_failed");
    assert.equal(code({ jobStatus: null }), "round_failed");
    assert.equal(code({ score: roundScore([], 8) }), "not_scored");
  });
  it("has words for every ending, with no em dash", () => {
    for (const c of ["target_reached", "cap", "round_limit", "stopped", "round_failed", "not_scored", "data_failed", "no_new_rows", "check_failed", "no_gpu", "refused", "start_failed", "error", "unknown"]) {
      assert.ok(stopText(c).length > 0);
      assert.ok(!stopText(c).includes("—"));
    }
  });
});

describe("settings", () => {
  it("takes good settings with defaults, and refuses bad ones", () => {
    assert.deepEqual(loopSettings({ targetScore: 8, maxUsd: 10 }), { ok: true, target: 8, capUsd: 10, maxRounds: 3, examples: 60 });
    for (const bad of [{ maxUsd: 10 }, { targetScore: 11, maxUsd: 10 }, { targetScore: 8 }, { targetScore: 8, maxUsd: 0 }, { targetScore: 8, maxUsd: 500 }, { targetScore: 8, maxUsd: 5, maxRounds: 6 }, { targetScore: 8, maxUsd: 5, examples: 10 }]) {
      assert.equal(loopSettings(bad).ok, false);
    }
  });
});
