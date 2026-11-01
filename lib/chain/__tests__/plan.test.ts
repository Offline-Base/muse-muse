/** npx tsx --test lib/chain/__tests__/plan.test.ts */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fullMilestones, requirementsFile, type Requirement } from "@/lib/full/requirements";
import { chainChecksNeedSession, chainEndLine, chainNext, chainSessionBudgetUsd, chainSessionPreface, chainStateFile, CHAIN_CHECKS_RESERVE_USD, CHAIN_MIN_ROUND_MS, CHAIN_ROUND_MAX_MS, type ChainLimits, type ChainPosition } from "@/lib/chain/plan";
import { chainRoundPlan } from "@/lib/pipeline/steps";

const MIN = 60_000;
const limits: ChainLimits = { sessionMs: 85 * MIN, sessionUsd: 15, totalUsd: 60, maxSessions: 12, maxMs: 24 * 60 * MIN };
const at = 1_000_000_000;
const start: ChainPosition = { session: 1, chainStartedAt: at, sessionStartedAt: at, sessionStartUsd: 0 };
const next = (over: { costUsd?: number; now?: number; position?: Partial<ChainPosition>; limits?: Partial<ChainLimits> } = {}) =>
  chainNext({ limits: { ...limits, ...over.limits }, position: { ...start, ...over.position }, costUsd: over.costUsd ?? 0, verifyMs: 25 * MIN, now: over.now ?? at });

describe("chainNext", () => {
  it("runs a round inside the session, leaving room for its verify", () => {
    assert.deepEqual(next(), { action: "round", capMs: CHAIN_ROUND_MAX_MS });
    assert.deepEqual(next({ now: at + 30 * MIN }), { action: "round", capMs: 30 * MIN });
  });

  it("starts a new session rather than a round too short to do anything, so the 90-minute wall is passed", () => {
    assert.deepEqual(next({ now: at + 50 * MIN }), { action: "rotate" });
    const later = next({ now: at + 300 * MIN, position: { session: 4, sessionStartedAt: at + 299 * MIN } });
    assert.equal(later.action, "round");
    assert.ok(CHAIN_MIN_ROUND_MS < 60 * MIN);
  });

  it("starts a new session once this one has spent its share", () => {
    assert.deepEqual(next({ costUsd: 15 }), { action: "rotate" });
    assert.equal(next({ costUsd: 15, position: { sessionStartUsd: 5 } }).action, "round");
  });

  it("ends at the total, keeping the checks' reserve, before anything else", () => {
    assert.deepEqual(next({ costUsd: 60 - CHAIN_CHECKS_RESERVE_USD }), { action: "end", reason: "budget" });
    assert.equal(next({ costUsd: 56 }).action, "rotate");
    assert.deepEqual(next({ costUsd: 58, now: at + 9999 * MIN }), { action: "end", reason: "budget" });
  });

  it("ends at the time limit and at the last session", () => {
    assert.deepEqual(next({ now: at + 24 * 60 * MIN }), { action: "end", reason: "time" });
    assert.deepEqual(next({ now: at + 80 * MIN, position: { session: 12 } }), { action: "end", reason: "sessions" });
  });
});

describe("the rest of the chain's rules", () => {
  it("a session's token never holds more than the total has left", () => {
    assert.equal(chainSessionBudgetUsd(limits, 0), 15);
    assert.equal(chainSessionBudgetUsd(limits, 50), 10);
    assert.equal(chainSessionBudgetUsd(limits, 70), 0);
  });

  it("the final checks get a session only when they need one and one is allowed", () => {
    const need = (now: number, session = 1) => chainChecksNeedSession({ limits, position: { ...start, session }, reserveMs: 70 * MIN, now });
    assert.equal(need(at), false);
    assert.equal(need(at + 20 * MIN), true);
    assert.equal(need(at + 20 * MIN, 12), false);
  });

  it("names why it ended, and what a new session must read", () => {
    assert.match(chainEndLine("budget", limits, 9, 20), /\$60 spending cap.*milestone 9 of 20/);
    assert.match(chainEndLine("time", limits, 9, 20), /24-hour limit/);
    assert.match(chainSessionPreface(3), /session 3.*no memory/);
    assert.match(chainSessionPreface(3), /brief\.md, CHAIN_STATE\.md, BUILD_NOTES\.md/);
    assert.match(chainStateFile({ session: 2, milestones: [{ title: "R1 to R4", state: "passed" }], costUsd: 12.5, totalUsd: 60 }), /Session 2 just ended.*\$12\.50 of the \$60[\s\S]*1\. R1 to R4: passed/);
  });

  it("a round and its verify fit in a session on any size of brief", () => {
    for (const requirements of [25, 60, 200]) {
      const plan = chainRoundPlan({ requirements }, [], limits);
      assert.ok(plan.buildMs + plan.verifyMs <= limits.sessionMs);
      assert.ok(plan.verifyMs <= 45 * MIN);
      assert.equal(plan.wallMs, limits.sessionMs);
    }
  });
});

describe("a chained brief's milestones", () => {
  const list = Array.from({ length: 100 }, (_, i): Requirement => ({ id: `R${i + 1}`, text: `thing ${i + 1}`, kind: "asked", words: "", savesData: false, canDo: true, cantDoWhy: null }));

  it("go past a full build's 6, with no requirement left out", () => {
    assert.equal(fullMilestones({ requirements: list }).length, 6);
    const chained = fullMilestones({ requirements: list, chained: true });
    assert.equal(chained.length, 25);
    assert.deepEqual(chained.flatMap((m) => m.requirementIds), list.map((r) => r.id));
    assert.equal(JSON.parse(requirementsFile({ requirements: list, chained: true }, 2)).requirements.length, 8);
  });
});
