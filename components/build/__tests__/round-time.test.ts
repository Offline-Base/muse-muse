/**
 * The room's honest time and round words (audit issues 7 and 8, Nov 3): the whole build's time limit as the round plan
 * recorded it, and round titles by what each round was for, so a milestone round never reads as a fix round.
 *   npx tsx --test components/build/__tests__/round-time.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { elapsedText, timeLimitText } from "@/components/build/BuildDetails";
import { roundTitle } from "@/components/build/steps";
import { roundPlanTimeLimit } from "@/lib/engine/milestones";

describe("the time limit", () => {
  it("comes from the round plan's wall, and a chain shows none: its wall is one session's", () => {
    assert.equal(roundPlanTimeLimit({ wallMinutes: 150 }), 150);
    assert.equal(roundPlanTimeLimit({ wallMinutes: 90, chain: { maxHours: 6, session: 1 } }), null);
    assert.equal(roundPlanTimeLimit({}), null);
    assert.equal(roundPlanTimeLimit(null), null);
  });

  it("says the whole build's limit, and nothing when none was recorded", () => {
    assert.equal(timeLimitText(150), "Up to 150 minutes, start to live");
    assert.equal(timeLimitText(null), null);
    assert.equal(timeLimitText(undefined), null);
  });

  it("shows the limit beside the elapsed time only while the build runs", () => {
    assert.equal(elapsedText(12 * 60_000, 150, false), "12 m of up to 150 min");
    assert.equal(elapsedText(89 * 60_000, 150, true), "1 h 29 m");
    assert.equal(elapsedText(12 * 60_000, null, false), "12 m");
  });
});

describe("round titles", () => {
  const done = { live: false, failed: false, isRefine: false };
  it("names a milestone round as a milestone, and numbers fix rounds by their own count", () => {
    assert.equal(roundTitle({ round: 1, stage: { kind: "milestone", n: 2 } }, done), "Muse Code built milestone 2");
    assert.equal(roundTitle({ round: 1, stage: { kind: "milestone", n: 2 } }, { ...done, live: true }), "Muse Code is building milestone 2");
    assert.equal(roundTitle({ round: 2, stage: { kind: "fix", n: 1 } }, done), "Fix round 1");
    assert.equal(roundTitle({ round: 2, stage: { kind: "fix", n: 1 } }, { ...done, failed: true }), "Fix round 1 didn't finish");
  });

  it("calls a look round a build round, and keeps the old words for a round no status described", () => {
    assert.equal(roundTitle({ round: 1, stage: { kind: "build" } }, done), "Muse Code built it");
    assert.equal(roundTitle({ round: 0, stage: { kind: "build" } }, { ...done, isRefine: true }), "Muse Code made the change");
    assert.equal(roundTitle({ round: 3 }, done), "Fix round 3");
  });
});
