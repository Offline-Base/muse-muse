import { test } from "node:test";
import assert from "node:assert/strict";
import { holdRun, parseRunId, releaseRun, RUN_LIMITS, runLimitsFor, settleRun, type RunCounters } from "@/lib/gateway/runs";

const NOW = new Date("2026-10-31T12:34:56.000Z");
const HOUR = new Date("2026-10-31T12:00:00.000Z");
const RUN = "run_12345678";
const KEYS = { turns: `run-turns:tok:${RUN}`, calls: `run-calls:tok:${RUN}`, usd: `run-usd:tok:${RUN}` };

/** The rate_limits counters: reserve only within the limit, adjust never below zero, per key and window. */
function counters() {
  const values = new Map<string, number>();
  const at = (key: string, window: Date) => `${key}@${window.toISOString()}`;
  const deps: RunCounters = {
    reserveCounter: async (key, window, amount, limit) => {
      const total = (values.get(at(key, window)) ?? 0) + amount;
      if (total > limit) return null;
      values.set(at(key, window), total);
      return total;
    },
    adjustCounter: async (key, window, delta) => {
      values.set(at(key, window), Math.max(0, (values.get(at(key, window)) ?? 0) + delta));
    },
    counterValue: async (key, window) => values.get(at(key, window)) ?? 0,
  };
  return { deps, value: (key: string, window = HOUR) => values.get(at(key, window)) ?? 0 };
}

const hold = (deps: RunCounters, opts: { toolCalls?: number; usd?: number | ((toolCalls: number) => number); turns?: number } = {}, limits = RUN_LIMITS.build, now = NOW) =>
  holdRun(deps, { tokenId: "tok", runId: RUN, limits, now, ...opts });

async function messageOf(res: Response) {
  const body = (await res.json()) as { error: { code: string; message: string; type: string } };
  return { status: res.status, shouldRetry: res.headers.get("x-should-retry"), ...body.error };
}

test("parseRunId takes 8 to 64 letters, digits, dashes and underscores", () => {
  assert.equal(parseRunId("abc_DEF-1"), "abc_DEF-1");
  assert.equal(parseRunId("x".repeat(64)), "x".repeat(64));
  for (const bad of [null, "", "short", "x".repeat(65), "has space 123", "semi;colon1", "../../etc/x", "line\nbreak1"]) {
    assert.equal(parseRunId(bad), null, String(bad));
  }
});

test("limits: builds 6 turns, 8 calls, $0.40; live agents 10, 12, $0.75; other live tokens none", () => {
  assert.deepEqual(RUN_LIMITS.build, { turns: 6, toolCalls: 8, usd: 0.4 });
  assert.deepEqual(RUN_LIMITS.liveAgent, { turns: 10, toolCalls: 12, usd: 0.75 });
  assert.equal(runLimitsFor({ scope: "build", allowedModels: [] }), RUN_LIMITS.build);
  assert.equal(runLimitsFor({ scope: "build", allowedModels: ["agent"] }), RUN_LIMITS.build);
  assert.equal(runLimitsFor({ scope: "live", allowedModels: ["agent"] }), RUN_LIMITS.liveAgent);
  assert.equal(runLimitsFor({ scope: "live", allowedModels: ["muse-wonder-1.0"] }), null);
});

test("a hold reserves a turn, the tool calls and the dollars, keyed by token and run", async () => {
  const c = counters();
  const held = await hold(c.deps, { toolCalls: 2, usd: 0.1 });
  assert.ok(held.ok);
  assert.equal(held.toolCalls, 2);
  assert.equal(c.value(KEYS.turns), 1);
  assert.equal(c.value(KEYS.calls), 2);
  assert.equal(c.value(KEYS.usd), 100_000, "dollars are held in micro-dollars");
});

test("the run stops at its model turns, in plain words, without a retry", async () => {
  const c = counters();
  for (let i = 0; i < 6; i++) assert.ok((await hold(c.deps)).ok, `turn ${i + 1}`);
  const over = await hold(c.deps);
  assert.ok(!over.ok);
  const err = await messageOf(over.response);
  assert.equal(err.status, 429);
  assert.equal(err.code, "run_limit");
  assert.equal(err.type, "rate_limit_error");
  assert.equal(err.shouldRetry, "false");
  assert.match(err.message, /limit of 6 model turns/);
  assert.equal(c.value(KEYS.turns), 6);
});

test("fewer tool calls left than asked for: holds what's left so the turn can still run", async () => {
  const c = counters();
  assert.ok((await hold(c.deps, { toolCalls: 7 })).ok);
  const held = await hold(c.deps, { toolCalls: 2 });
  assert.ok(held.ok);
  assert.equal(held.toolCalls, 1);
  assert.equal(held.hold.toolCalls, 1);
  assert.equal(c.value(KEYS.calls), 8);
});

test("no tool calls left: refused, and the turn it took is given back", async () => {
  const c = counters();
  assert.ok((await hold(c.deps, { toolCalls: 8 })).ok);
  const over = await hold(c.deps, { toolCalls: 1 });
  assert.ok(!over.ok);
  const err = await messageOf(over.response);
  assert.equal(err.code, "run_limit");
  assert.match(err.message, /none of its 8 built-in tool calls left, counting calls still running/);
  assert.match(err.message, /Wait for them to finish, send the next turn without built-in tools/);
  assert.equal(c.value(KEYS.turns), 1);
  assert.equal(c.value(KEYS.calls), 8);
  assert.ok((await hold(c.deps)).ok, "a turn with no built-in tools still runs");
});

test("over the dollars: refused, and the turn and calls it took are given back", async () => {
  const c = counters();
  assert.ok((await hold(c.deps, { usd: 0.3 })).ok);
  const over = await hold(c.deps, { toolCalls: 2, usd: 0.11 });
  assert.ok(!over.ok);
  const err = await messageOf(over.response);
  assert.equal(err.code, "run_limit");
  assert.match(err.message, /\$0\.40 limit/);
  assert.equal(c.value(KEYS.turns), 1);
  assert.equal(c.value(KEYS.calls), 0);
  assert.equal(c.value(KEYS.usd), 300_000);
  assert.ok((await hold(c.deps, { usd: 0.1 })).ok, "exactly at the limit fits");
});

test("the dollars held can depend on the tool calls held", async () => {
  const c = counters();
  assert.ok((await hold(c.deps, { toolCalls: 7 })).ok);
  const held = await hold(c.deps, { toolCalls: 2, usd: (calls) => calls * 0.1 });
  assert.ok(held.ok);
  assert.equal(held.toolCalls, 1);
  assert.equal(c.value(KEYS.usd), 100_000);
});

test("dollars too short for every tool call: holds as many as they cover and gives the other calls back", async () => {
  const c = counters();
  assert.ok((await hold(c.deps, { usd: 0.3 })).ok);
  const held = await hold(c.deps, { toolCalls: 8, usd: (calls) => 0.02 + calls * 0.01 });
  assert.ok(held.ok);
  assert.equal(held.toolCalls, 8, "0.10 fits exactly");
  await releaseRun(c.deps, held.hold);

  const fewer = await hold(c.deps, { toolCalls: 8, usd: (calls) => 0.05 + calls * 0.01 });
  assert.ok(fewer.ok);
  assert.equal(fewer.toolCalls, 5);
  assert.equal(fewer.hold.toolCalls, 5);
  assert.equal(fewer.hold.micros, 100_000);
  assert.equal(c.value(KEYS.calls), 5);
  assert.equal(c.value(KEYS.usd), 400_000);

  await releaseRun(c.deps, fewer.hold);
  assert.equal(c.value(KEYS.calls), 0, "the hold knows the calls it kept");
  assert.equal(c.value(KEYS.usd), 300_000);
});

test("dollars too short for even one tool call: refused, and everything it took is given back", async () => {
  const c = counters();
  assert.ok((await hold(c.deps, { usd: 0.35 })).ok);
  const over = await hold(c.deps, { toolCalls: 8, usd: (calls) => 0.05 + calls * 0.01 });
  assert.ok(!over.ok);
  const err = await messageOf(over.response);
  assert.equal(err.code, "run_limit");
  assert.match(err.message, /\$0\.40 limit/);
  assert.match(err.message, /without built-in tools/);
  assert.equal(c.value(KEYS.turns), 1);
  assert.equal(c.value(KEYS.calls), 0);
  assert.equal(c.value(KEYS.usd), 350_000);
});

test("settling replaces the hold with what the call used; the turn stays spent", async () => {
  const c = counters();
  const held = await hold(c.deps, { toolCalls: 2, usd: 0.2 });
  assert.ok(held.ok);
  await settleRun(c.deps, held.hold, { toolCalls: 1, usd: 0.05 });
  assert.equal(c.value(KEYS.turns), 1);
  assert.equal(c.value(KEYS.calls), 1);
  assert.equal(c.value(KEYS.usd), 50_000);
  // Meta ran more than was held: the counters show what it did.
  const more = await hold(c.deps, { toolCalls: 1, usd: 0.01 });
  assert.ok(more.ok);
  await settleRun(c.deps, more.hold, { toolCalls: 3, usd: 0.02 });
  assert.equal(c.value(KEYS.calls), 4);
  assert.equal(c.value(KEYS.usd), 70_000);
});

test("a reply that was cut off keeps the tool calls it held, since it may have run them", async () => {
  const c = counters();
  const held = await hold(c.deps, { toolCalls: 2, usd: 0.2 });
  assert.ok(held.ok);
  await settleRun(c.deps, held.hold, { toolCalls: null, usd: 0.01 });
  assert.equal(c.value(KEYS.calls), 2);
  assert.equal(c.value(KEYS.usd), 10_000);
});

test("releasing gives the whole hold back, for a call Meta never ran", async () => {
  const c = counters();
  const held = await hold(c.deps, { toolCalls: 2, usd: 0.2 });
  assert.ok(held.ok);
  await releaseRun(c.deps, held.hold);
  for (const key of Object.values(KEYS)) assert.equal(c.value(key), 0, key);
});

test("one-hour windows: a run's counters don't reach into the next hour, and settling uses the hold's window", async () => {
  const c = counters();
  const held = await hold(c.deps, { toolCalls: 1, usd: 0.1 });
  assert.ok(held.ok);
  const nextHour = new Date("2026-10-31T13:00:01.000Z");
  const later = await hold(c.deps, {}, RUN_LIMITS.build, nextHour);
  assert.ok(later.ok);
  assert.equal(c.value(KEYS.turns, new Date("2026-10-31T13:00:00.000Z")), 1);
  await settleRun(c.deps, held.hold, { toolCalls: 0, usd: 0 });
  assert.equal(c.value(KEYS.calls), 0, "settled in the window it was held in");
});

test("tool calls alone can be held with no turn, for the tool gateway", async () => {
  const c = counters();
  const held = await hold(c.deps, { turns: 0, toolCalls: 1, usd: 0.01 });
  assert.ok(held.ok);
  assert.equal(c.value(KEYS.turns), 0);
  assert.equal(c.value(KEYS.calls), 1);
});

test("two runs and two tokens never share counters", async () => {
  const c = counters();
  assert.ok((await holdRun(c.deps, { tokenId: "tok", runId: RUN, limits: RUN_LIMITS.build, now: NOW })).ok);
  assert.ok((await holdRun(c.deps, { tokenId: "tok", runId: "run_other_1", limits: RUN_LIMITS.build, now: NOW })).ok);
  assert.ok((await holdRun(c.deps, { tokenId: "other", runId: RUN, limits: RUN_LIMITS.build, now: NOW })).ok);
  assert.equal(c.value(KEYS.turns), 1);
  assert.equal(c.value(`run-turns:tok:run_other_1`), 1);
  assert.equal(c.value(`run-turns:other:${RUN}`), 1);
});
