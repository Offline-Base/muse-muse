import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { backoffMs, createAgent, shouldShutDown, stopWindowsBox } from "../agent.mjs";
import { loadConfig } from "../lib/config.mjs";
import { isMainModule } from "../lib/main.mjs";
import { memoryLogger } from "./helpers.mjs";

const LAB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const KINDS = ["ios_sim", "android_emu", "desktop_mac", "glasses_sim"];

function harness({ claims = [], env = {}, platform = "darwin", execute, shutdownReplies = [], sleepMoves = false } = {}) {
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
    sleep: (ms) =>
      new Promise((resolve) => {
        if (sleepMoves) clock += ms;
        setImmediate(resolve);
      }),
    shutdownBox: async () => {
      shutdowns.push(clock);
      const reply = shutdownReplies.shift() ?? true;
      if (reply instanceof Error) throw reply;
      return reply;
    },
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

  test("the Mac never stops itself when claims fail either", async () => {
    const { agent, shutdowns, advance } = harness({ claims: [new Error("down")] });
    advance(24 * 60 * 60_000);
    await agent.tick();
    assert.equal(shutdowns.length, 0);
  });

  test("a platform that keeps failing doesn't keep the box running", async () => {
    const down = () => Object.assign(new Error("claim answered 404"), { status: 404 });
    const { agent, shutdowns, advance } = harness({ platform: "win32", claims: [down(), down()] });
    assert.equal(await agent.tick(), 5000);
    assert.equal(shutdowns.length, 0);
    advance(20 * 60_000);
    assert.equal(await agent.tick(), 0);
    assert.equal(shutdowns.length, 1);
  });

  test("a failing platform doesn't stop the box under a running job", async () => {
    const { agent, shutdowns, advance } = harness({
      platform: "win32",
      claims: [{ id: "j", kind: "desktop_windows" }, new Error("down")],
      execute: () => new Promise(() => {}),
    });
    await agent.tick();
    advance(60 * 60_000);
    await agent.tick();
    assert.equal(shutdowns.length, 0);
  });

  test("a shutdown that fails keeps the agent up and tries again in a minute", async () => {
    const { agent, shutdowns, advance } = harness({ platform: "win32", shutdownReplies: [false, new Error("no privilege"), true] });
    advance(20 * 60_000);
    assert.equal(await agent.tick(), 10_000, "still polling");
    assert.equal(shutdowns.length, 1);
    advance(59_000);
    await agent.tick();
    assert.equal(shutdowns.length, 1, "not yet");
    advance(1000);
    assert.equal(await agent.tick(), 10_000, "a shutdown that throws has failed too");
    assert.equal(shutdowns.length, 2);
    advance(60_000);
    assert.equal(await agent.tick(), 0);
    assert.equal(shutdowns.length, 3);
  });

  test("run() keeps going past a failed shutdown and ends after one that works", { timeout: 5000 }, async () => {
    const { agent, shutdowns } = harness({ platform: "win32", shutdownReplies: [false, true], sleepMoves: true });
    await agent.run();
    assert.equal(shutdowns.length, 2);
    assert.equal(shutdowns[1] - shutdowns[0] >= 60_000, true);
  });

  test("stopWindowsBox only says yes when the command worked", async () => {
    const replying = (reply) => async () => reply;
    assert.equal(await stopWindowsBox({ exec: replying({ code: 0, timedOut: false }) }), true);
    assert.equal(await stopWindowsBox({ exec: replying({ code: 5, timedOut: false }) }), false);
    assert.equal(await stopWindowsBox({ exec: replying({ code: -1, timedOut: true }) }), false);
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

// Every real box runs the agent through a link: the LaunchAgent and the SSM document use `current/...`, and Windows uses a
// junction. Node resolves links in import.meta.url but not in argv[1], so this has to be tested the way it really runs.
describe("run through the current link", () => {
  function linkedBox() {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-link-"));
    mkdirSync(path.join(dir, "releases"));
    symlinkSync(LAB_DIR, path.join(dir, "releases", "0.1.0"));
    symlinkSync(path.join(dir, "releases", "0.1.0"), path.join(dir, "current"));
    return dir;
  }

  test("the agent starts and asks for work", { timeout: 30_000 }, async () => {
    const dir = linkedBox();
    const claims = [];
    let claimed;
    const firstClaim = new Promise((resolve) => (claimed = resolve));
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        claims.push(req.url);
        claimed();
        res.statusCode = 204;
        res.end();
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const tokenFile = path.join(dir, "token");
    writeFileSync(tokenFile, "lab-token-link-abcdefghijkl");
    const root = path.join(dir, "root");
    const agent = spawn(process.execPath, [path.join(dir, "current", "agent.mjs")], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MUSE_LAB_LANE: "mac",
        MUSE_LAB_ROOT: root,
        MUSE_LAB_PLATFORM: `http://127.0.0.1:${server.address().port}`,
        MUSE_LAB_ALLOW_INSECURE: "1",
        MUSE_LAB_TOKEN_FILE: tokenFile,
        MUSE_LAB_KINDS: "desktop_mac",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    agent.stdout.on("data", (c) => (output += c));
    agent.stderr.on("data", (c) => (output += c));
    const closed = new Promise((resolve) => agent.once("close", resolve));
    try {
      const first = await Promise.race([firstClaim.then(() => "claimed"), closed.then((code) => `exited ${code}`)]);
      assert.equal(first, "claimed", `the agent said:\n${output}`);
      assert.deepEqual(claims, ["/api/native/agent/claim"]);
      assert.equal(readFileSync(path.join(root, "data", "agent.pid"), "utf8"), String(agent.pid));
      agent.kill("SIGTERM");
      assert.equal(await closed, 0);
      assert.ok(!existsSync(path.join(root, "data", "agent.pid")), "a clean exit takes its pid file with it");
    } finally {
      agent.kill("SIGKILL");
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the control script answers", { timeout: 30_000 }, () => {
    const dir = linkedBox();
    try {
      const script = path.join(dir, "current", "control.mjs");
      const refused = spawnSync(process.execPath, [script, "bogus"], { encoding: "utf8" });
      assert.equal(refused.status, 2);
      assert.match(refused.stderr, /usage/);
      const status = spawnSync(process.execPath, [script, "status"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME, MUSE_LAB_ROOT: dir },
      });
      assert.equal(status.status, 0, status.stderr);
      assert.equal(JSON.parse(status.stdout).current, "0.1.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the compositor answers", () => {
    const dir = linkedBox();
    try {
      const reply = spawnSync(process.execPath, [path.join(dir, "current", "compose.mjs")], { encoding: "utf8" });
      assert.equal(reply.status, 2);
      assert.match(reply.stderr, /usage/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("isMainModule compares real paths and takes a missing script as no", () => {
    const dir = linkedBox();
    try {
      const url = new URL("../agent.mjs", import.meta.url).href;
      assert.equal(isMainModule(url, path.join(dir, "current", "agent.mjs")), true);
      assert.equal(isMainModule(url, path.join(LAB_DIR, "agent.mjs")), true);
      assert.equal(isMainModule(url, path.join(dir, "current", "control.mjs")), false);
      assert.equal(isMainModule(url, path.join(dir, "none.mjs")), false);
      assert.equal(isMainModule(url, undefined), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
