/**
 * Runs proveProduct as a plain function with every step faked and sleep() instant, to check the orchestration: the order
 * of the stage, what a video is made of, its caps, and that the copy is always deleted and nothing escapes.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/pipeline/__tests__/prove.scenario.test.ts
 */
import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";
import type { proveProduct as ProveProduct } from "../prove";

const canMock = typeof (mock as { module?: unknown }).module === "function";

interface Scenario {
  openThrows?: boolean;
  openNull?: boolean;
  noRecord?: boolean;
  checksRunForever?: boolean;
  passed?: string[];
  skillFileOk?: boolean;
  skillStartsNull?: boolean;
  skillOk?: boolean;
  skillRunsForever?: boolean;
  overCap?: boolean;
  recording?: string | null;
  checksThrow?: boolean;
  closeThrows?: boolean;
}

let scenario: Scenario = {};
let calls: Array<{ step: string; args: unknown[] }> = [];

const ctx = { buildId: "b1", runId: "r1", origin: "ship", copy: "prove-x-product", record: true };
const record = (step: string, args: unknown[]) => calls.push({ step, args });
const named = (step: string) => calls.filter((c) => c.step === step);
const order = () => calls.map((c) => c.step).filter((s) => s !== "pollTaskStep" && s !== "provePollSkillStep");

const fakeSteps = {
  proveOpenStep: async (...args: unknown[]) => {
    record("proveOpenStep", args);
    if (scenario.openThrows) throw new Error("no source sandbox");
    return scenario.openNull ? null : { ...ctx, record: !scenario.noRecord };
  },
  proveAbandonStep: async (...args: unknown[]) => record("proveAbandonStep", args),
  proveStartChecksStep: async (...args: unknown[]) => {
    record("proveStartChecksStep", args);
    if (scenario.checksThrow) throw new Error("the copy went away");
    return "checks-cmd";
  },
  proveCollectChecksStep: async (...args: unknown[]) => {
    record("proveCollectChecksStep", args);
    return {
      summaries: { mcp: { state: "done", title: "MCP" } },
      passed: scenario.passed ?? ["mcp", "cli", "claude_plugin"],
      resultsHash: "hash",
      skillCall: { name: "tidy", args: {} },
      skillFileOk: scenario.skillFileOk ?? true,
    };
  },
  proveStartSkillStep: async (...args: unknown[]) => {
    record("proveStartSkillStep", args);
    return scenario.skillStartsNull ? null : { cmdId: "skill-cmd", logPath: "/log", command: "muse exec", action: "tidy", startedAt: 0 };
  },
  provePollSkillStep: async (...args: unknown[]) => {
    record("provePollSkillStep", args);
    const done = !scenario.skillRunsForever && !scenario.overCap;
    return { done, exitCode: done ? 0 : null, offset: 1, finalText: "It worked.", announced: [], childrenIncluded: null, museUsd: 0.1, overCap: Boolean(scenario.overCap) };
  },
  proveFinishSkillStep: async (...args: unknown[]) => {
    record("proveFinishSkillStep", args);
    const ok = scenario.skillOk ?? true;
    return { ok, summary: { state: ok ? "done" : "failed", title: "Skill" }, lines: ["bash: curl"] };
  },
  proveStartRecordStep: async (...args: unknown[]) => {
    record("proveStartRecordStep", args);
    return scenario.recording === undefined ? "record-cmd" : scenario.recording;
  },
  proveFinishRecordStep: async (...args: unknown[]) => record("proveFinishRecordStep", args),
  proveCloseStep: async (...args: unknown[]) => {
    record("proveCloseStep", args);
    if (scenario.closeThrows) throw new Error("no database");
  },
  proveFailStep: async (...args: unknown[]) => record("proveFailStep", args),
};

describe("the Prove it workflow", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let proveProduct: typeof ProveProduct;
  const input = { buildId: "b1", runId: "r1", origin: "ship" as const };
  // A poll past its cap needs a clock that has moved on, so each one is a minute later.
  let clock = 0;
  const realNow = Date.now;

  before(async () => {
    mock.module(new URL("../prove-steps.ts", import.meta.url).href, { namedExports: fakeSteps });
    mock.module(new URL("../build-steps.ts", import.meta.url).href, {
      namedExports: {
        pollTaskStep: async (...args: unknown[]) => {
          record("pollTaskStep", args);
          return { done: !(scenario.checksRunForever && args[1] === "checks-cmd"), exitCode: 0, outputTail: "" };
        },
        killStep: async (...args: unknown[]) => record("killStep", args),
      },
    });
    mock.module("workflow", { namedExports: { sleep: async () => undefined } });
    ({ proveProduct } = await import("../prove"));
  });

  beforeEach(() => {
    calls = [];
    clock = realNow();
    Date.now = () => (clock += 60_000);
  });

  it("checks, uses the skill, records what passed, then closes", async () => {
    scenario = {};
    assert.deepEqual(await proveProduct(input), { ran: true });
    assert.deepEqual(order(), [
      "proveOpenStep",
      "proveStartChecksStep",
      "proveCollectChecksStep",
      "proveStartSkillStep",
      "proveFinishSkillStep",
      "proveStartRecordStep",
      "proveFinishRecordStep",
      "proveCloseStep",
    ]);
    const recorded = named("proveStartRecordStep")[0]!.args[1] as { passed: string[]; resultsHash: string; skill: unknown };
    assert.deepEqual(recorded.passed, ["mcp", "cli", "claude_plugin", "skill"]);
    assert.equal(recorded.resultsHash, "hash");
    assert.ok(recorded.skill);
  });

  it("leaves out of the video what didn't pass", async () => {
    scenario = { passed: ["mcp"], skillOk: false };
    await proveProduct(input);
    assert.deepEqual((named("proveStartRecordStep")[0]!.args[1] as { passed: string[] }).passed, ["mcp"]);
  });

  it("records nothing on a nightly run, or when nothing passed", async () => {
    scenario = { noRecord: true };
    assert.deepEqual(await proveProduct(input), { ran: true });
    assert.equal(named("proveStartRecordStep").length, 0);
    calls = [];
    scenario = { passed: [], skillStartsNull: true };
    assert.deepEqual(await proveProduct(input), { ran: true });
    assert.equal(named("proveStartRecordStep").length, 0);
    assert.equal(named("proveCloseStep").length, 1);
  });

  it("goes on with no video when recording can't start", async () => {
    scenario = { recording: null };
    assert.deepEqual(await proveProduct(input), { ran: true });
    assert.equal(named("proveFinishRecordStep").length, 0);
    assert.equal(named("proveCloseStep").length, 1);
  });

  it("stops checks that run past their cap and says so", async () => {
    scenario = { checksRunForever: true };
    assert.deepEqual(await proveProduct(input), { ran: true });
    assert.deepEqual(named("killStep")[0]!.args, [ctx.copy, "checks-cmd"]);
    assert.equal(named("proveCollectChecksStep")[0]!.args[1], true);
  });

  it("stops a skill test past its time cap, charges what it wrote and calls it timed out", async () => {
    scenario = { skillRunsForever: true };
    assert.deepEqual(await proveProduct(input), { ran: true });
    assert.deepEqual(named("killStep")[0]!.args, [ctx.copy, "skill-cmd"]);
    assert.equal((named("proveFinishSkillStep")[0]!.args[2] as { timedOut: boolean }).timedOut, true);
    assert.equal(named("provePollSkillStep").length >= 2, true);
  });

  it("stops a skill test as soon as it reaches the cap", async () => {
    scenario = { overCap: true };
    assert.deepEqual(await proveProduct(input), { ran: true });
    assert.equal(named("provePollSkillStep").length, 2);
    assert.equal(named("killStep").length, 1);
    assert.equal((named("proveFinishSkillStep")[0]!.args[2] as { timedOut: boolean }).timedOut, true);
  });

  it("says so and returns when the copy can't be made, with nothing to clean up", async () => {
    scenario = { openThrows: true };
    assert.deepEqual(await proveProduct(input), { ran: false });
    assert.equal(named("proveAbandonStep").length, 1);
    assert.equal(named("proveFailStep").length, 0);
  });

  it("does nothing more when there is nothing to prove", async () => {
    scenario = { openNull: true };
    assert.deepEqual(await proveProduct(input), { ran: false });
    assert.deepEqual(order(), ["proveOpenStep"]);
  });

  it("always cleans up, and never throws, when a step fails", async () => {
    scenario = { checksThrow: true };
    assert.deepEqual(await proveProduct(input), { ran: false });
    assert.equal(named("proveFailStep").length, 1);
    assert.equal(named("proveCloseStep").length, 0);
    calls = [];
    scenario = { closeThrows: true };
    assert.deepEqual(await proveProduct(input), { ran: false });
    assert.equal(named("proveFailStep").length, 1);
  });
});
