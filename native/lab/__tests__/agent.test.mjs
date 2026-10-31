import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { backoffMs, createAgent, shouldShutDown } from "../agent.mjs";
import { loadConfig } from "../lib/config.mjs";
import { memoryLogger } from "./helpers.mjs";

const KINDS = ["ios_sim", "android_emu", "desktop_mac", "glasses_sim"];

function harness({ claims = [], env = {}, platform = "darwin", execute } = {}) {
  const config = loadConfig({ env, platform });
  let clock = 1_000_000;
  const claimed = [];
  const shutdowns = [];
  const states = [];
  const jobs = [];
  const agent = createAgent({
    config,
    log: memoryLogger(),
    api: {
      claim: async (body) => {
        claimed.push(body);
        const next = claims.shift();
        if (next instanceof Error) throw next;
        return next ?? null;
      },
    },
    probe: async () => ({ kinds: KINDS, tools: { ffmpeg: { ok: true } } }),
    execute: execute ?? (async (job) => jobs.push(job)),
    now: () => clock,
    // A real turn of the event loop, or run()'s loop would starve everything else in the test.
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    shutdownBox: async () => shutdowns.push(clock),
    writeState: async (state) => states.push(state),
  });
  return { agent, config, claimed, shutdowns, states, jobs, advance: (ms) => (clock += ms) };
}

describe("backoffMs", () => {
  test("doubles and stops at a minute", () => {
    assert.equal(backoffMs(1), 5000);
    assert.equal(backoffMs(2), 10_000);
    assert.equal(backoffMs(20), 60_000);
  });
  test("honors a longer Retry-After, within reason", () => {
    assert.equal(backoffMs(1, 30_000), 30_000);
    assert.equal(backoffMs(1, 3_600_000), 300_000);
  });
});

describe("shouldShutDown", () => {
  const base = { idleMinutes: 20, lastBusyAt: 0, running: 0 };
  test("after 20 idle minutes, not before", () => {
    assert.equal(shouldShutDown({ ...base, now: 19 * 60_000 }), false);
    assert.equal(shouldShutDown({ ...base, now: 20 * 60_000 }), true);
  });
  test("never with a job running or when it's off", () => {
    assert.equal(shouldShutDown({ ...base, now: 60 * 60_000, running: 1 }), false);
    assert.equal(shouldShutDown({ ...base, now: 60 * 60_000, idleMinutes: 0 }), false);
  });
});

describe("the claim loop", () => {
  test("offers its capabilities and long-polls for 10 s", async () => {
    const { agent, claimed, config } = harness();
    const wait = await agent.tick();
    assert.deepEqual(claimed[0].kinds, KINDS);
    assert.equal(claimed[0].lane, "mac");
    assert.equal(claimed[0].waitSeconds, 10);
    assert.equal(claimed[0].version, config.version);
    assert.equal(wait, 10_000);
  });

  test("a job claimed runs at once, and the next claim comes straight after", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const started = [];
    const { agent, claimed } = harness({
      claims: [{ id: "j1", kind: "ios_sim" }],
      execute: async (job) => {
        started.push(job.id);
        await gate;
      },
    });
    assert.equal(await agent.tick(), 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ["j1"]);
    assert.ok(agent.running.has("j1"));

    await agent.tick();
    assert.deepEqual(claimed[1].kinds, [], "one slot, so it only pings");
    assert.equal(claimed[1].waitSeconds, 0);
    assert.deepEqual(claimed[1].running, ["j1"]);

    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(agent.running.size, 0);
  });

  test("two slots run two resources, never the same one", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const { agent, claimed } = harness({
      env: { MUSE_LAB_SLOTS: "2" },
      claims: [{ id: "j1", kind: "ios_sim" }],
      execute: () => gate,
    });
    await agent.tick();
    await agent.tick();
    assert.deepEqual(claimed[1].kinds, ["android_emu", "desktop_mac"]);
    release();
  });

  test("backs off when the platform's down, then recovers", async () => {
    const { agent } = harness({ claims: [new Error("down"), new Error("down"), null] });
    assert.equal(await agent.tick(), 5000);
    assert.equal(await agent.tick(), 10_000);
    assert.equal(await agent.tick(), 10_000);
  });

  test("a crashing job doesn't take the agent down", async () => {
    const { agent } = harness({
      claims: [{ id: "j1", kind: "ios_sim" }],
      execute: async () => {
        throw new Error("boom");
      },
    });
    await agent.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(agent.running.size, 0);
    assert.equal(await agent.tick(), 10_000);
  });

  test("writes its state for the status action", async () => {
    const { agent, states } = harness();
    await agent.tick();
    assert.equal(states[0].lane, "mac");
    assert.deepEqual(states[0].running, []);
  });
});

describe("the idle stop", () => {
  test("Windows stops itself after 20 idle minutes", async () => {
    const { agent, shutdowns, advance } = harness({ platform: "win32" });
    await agent.tick();
    assert.equal(shutdowns.length, 0);
    advance(20 * 60_000);
    await agent.tick();
    assert.equal(shutdowns.length, 1);
  });

  test("a job resets the clock", async () => {
    const { agent, shutdowns, advance } = harness({ platform: "win32", claims: [null, { id: "j", kind: "desktop_windows" }] });
    advance(19 * 60_000);
    await agent.tick();
    await agent.tick();
    await new Promise((resolve) => setImmediate(resolve));
    advance(19 * 60_000);
    await agent.tick();
    assert.equal(shutdowns.length, 0);
  });

  test("the Mac never stops itself", async () => {
    const { agent, shutdowns, advance } = harness();
    advance(24 * 60 * 60_000);
    await agent.tick();
    assert.equal(shutdowns.length, 0);
  });
});

describe("stopping", () => {
  test("run() ends on stop() and waits for running jobs", async () => {
    const order = [];
    let seenStop;
    const { agent } = harness({
      claims: [{ id: "j1", kind: "ios_sim" }],
      execute: async (_job, { stopSignal }) => {
        seenStop = stopSignal;
        await new Promise((resolve) => stopSignal.addEventListener("abort", resolve));
        order.push("job done");
      },
    });
    const running = agent.run().then(() => order.push("agent done"));
    while (!seenStop) await new Promise((resolve) => setImmediate(resolve));
    agent.stop();
    await running;
    assert.deepEqual(order, ["job done", "agent done"]);
  });
});
