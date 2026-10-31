/**
 * Runs lib/sandbox/builder.ts's Muse Code calls with the sandbox faked: startMuse on exec (today's runner, then under
 * MUSE_FULL with the platform's config) and on the session bridge, the fallback to exec when the bridge can't start,
 * sendMuseCommand on both engines, and pollMuse on a bridge log.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/sandbox/__tests__/builder-muse.scenario.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { BRIDGE_SCRIPT, bridgeConfigPath, type BridgeConfig, type MuseCommandEnvelope } from "@/lib/sandbox/bridge-protocol";
import { BRIDGE_SOURCE } from "@/lib/sandbox/bridge-source";
import { HOOKS_DIR, MUSE_FULL_MARKER, NOTES_DIR } from "@/lib/sandbox/muse-config";
import { condenseMuseLines, highlightsFrom } from "@/lib/sandbox/muse-log";

const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";
const BUILD = "3f2a9c1e-77b0-4d2e-9f00-0123456789ab";
/** What startMuse's start check looks for in a new bridge's log: Muse Code took the prompt. */
const PROBE = '"kind":"bridge","event":"turn"';

/** Files the fake sandbox holds, every command it ran, and what each answers. */
let files: Record<string, string> = {};
let commands: Array<{ script: string; detached: boolean; sudo?: boolean }> = [];
let answer: (script: string) => { exitCode?: number; stdout?: string } = () => ({});
let kills: string[] = [];
let commandAlive = true;

class NotFound extends Error {
  response = { status: 404 };
}

const fakeSandbox = {
  name: "product-bird-finder-3f2a9c1e",
  status: "running",
  expiresAt: undefined,
  tags: { app: "musemuse", role: "product", product: "p1" },
  update: async () => {},
  writeFiles: async (batch: Array<{ path: string; content: string | Buffer }>) => {
    for (const f of batch) files[f.path] = String(f.content);
  },
  readFileToBuffer: async ({ path }: { path: string }) => (path in files ? Buffer.from(files[path]!) : null),
  runCommand: async (opts: { cmd: string; args: string[]; detached?: boolean; sudo?: boolean }) => {
    const script = opts.args[0] === "-c" ? opts.args[1]! : opts.args[0]!;
    commands.push({ script, detached: Boolean(opts.detached), sudo: opts.sudo });
    if (opts.detached) return { cmdId: `cmd-${commands.length}` };
    const res = answer(script);
    return { exitCode: res.exitCode ?? 0, stdout: async () => res.stdout ?? "", stderr: async () => "" };
  },
  getCommand: async (cmdId: string) => ({
    cmdId,
    exitCode: null,
    kill: async (signal: string) => {
      kills.push(signal);
      commandAlive = false;
    },
    // A command that runs until it is killed. AbortSignal.timeout's timer is unref'd, so hold the event loop open.
    wait: ({ signal }: { signal: AbortSignal }) => {
      if (!commandAlive) return Promise.resolve({ exitCode: 143 });
      const keepAlive = setTimeout(() => {}, 30_000);
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(signal.reason);
        }),
      );
    },
  }),
};

const canMock = typeof (mock as { module?: unknown }).module === "function";
let builder: typeof import("../builder");

const ENV = ["MUSE_ENGINE", "MUSE_FULL", "MUSE_AGENT_CAPACITY", "PLATFORM_URL", "GATEWAY_TOKEN_PEPPER", "MODEL_API_KEY", "VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

before(async () => {
  if (!canMock) return;
  mock.module("@vercel/sandbox", {
    namedExports: {
      APIError: NotFound,
      Sandbox: { get: async () => fakeSandbox },
    },
  });
  mock.module(new URL("../../storage.ts", import.meta.url).href, {
    namedExports: { putFile: async () => "https://blob/x", fetchBytes: async () => Buffer.alloc(0) },
  });
  builder = await import("../builder");
});

after(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  files = {};
  commands = [];
  kills = [];
  commandAlive = true;
  answer = (script) => (script.includes(PROBE) ? { stdout: "turn\n" } : {});
  for (const k of ENV) delete process.env[k];
  process.env.MODEL_API_KEY = "test-model-key";
  process.env.GATEWAY_TOKEN_PEPPER = "test-pepper";
});

const start = (over: Partial<Parameters<typeof builder.startMuse>[0]> = {}) =>
  builder.startMuse({
    sandboxName: fakeSandbox.name,
    sessionId: SESSION,
    promptFile: "brief.md",
    images: ["inspo/bird.png"],
    model: "muse-wonder-1.0",
    maxModelSteps: 200,
    round: 0,
    ...over,
  });

const runner = (name: string) => files[`/vercel/musemuse/run/${name}.sh`] ?? "";

describe("startMuse", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  it("runs muse exec by default, with today's runner when MUSE_FULL is off", async () => {
    const run = await start({ buildId: BUILD, goal: "Build it." });
    assert.deepEqual(run, { cmdId: "cmd-1", logPath: "/vercel/musemuse/logs/muse-r0.jsonl", engine: "exec", buildMcp: false });
    const script = runner("muse-r0");
    assert.match(script, /^cmd=\('muse' 'exec' '--json' '--yolo' '--session-id' '0f8fad5b-d9cb-469f-a165-70867728950e' '--prompt-file' 'brief\.md'/m);
    assert.match(script, /\[ -f 'inspo\/bird\.png' \] && cmd\+=\(--image 'inspo\/bird\.png'\)/);
    assert.ok(!script.includes("--config") && !script.includes("skills enable") && !script.includes("MUSEMUSE_BUILD_MCP_TOKEN"));
    assert.deepEqual(Object.keys(files).sort(), [
      "/vercel/musemuse/run/by-id/cmd-1",
      "/vercel/musemuse/run/muse-r0.cmd",
      "/vercel/musemuse/run/muse-r0.engine",
      "/vercel/musemuse/run/muse-r0.sh",
    ]);
    assert.equal(files["/vercel/musemuse/run/muse-r0.engine"], "exec");
    assert.deepEqual(
      commands.map((c) => c.detached),
      [true],
      "no setup commands",
    );
  });

  it("gives exec the platform's settings, hooks and build MCP under MUSE_FULL", async () => {
    process.env.MUSE_FULL = "1";
    process.env.MUSE_AGENT_CAPACITY = "8";
    process.env.PLATFORM_URL = "https://musemuse.example";
    const run = await start({ buildId: BUILD });
    assert.equal(run.engine, "exec");
    assert.equal(run.buildMcp, true);
    // Whatever the agent left at those paths goes first, then the platform's own versions.
    assert.match(commands[0]!.script, /^rm -rf -- '\/vercel\/app\/\.muse\/hooks\.json' '\/vercel\/app\/\.mcp\.json' /);
    assert.match(commands[0]!.script, /for p in \.muse\/ \.mcp\.json; do grep -qxF -- "\$p" '\/vercel\/app\/\.git\/info\/exclude'/);
    for (const name of ["guard.mjs", "notes.mjs", "stop-gate.mjs", "log.mjs"]) assert.ok(files[`${HOOKS_DIR}/${name}`], name);
    assert.deepEqual(Object.keys(JSON.parse(files["/vercel/app/.muse/hooks.json"]!).hooks).slice(0, 4), ["PreToolUse", "PostToolUse", "PostToolBatch", "Stop"]);
    const mcp = JSON.parse(files["/vercel/app/.mcp.json"]!);
    assert.equal(mcp.mcpServers.musemuse.url, "https://musemuse.example/api/build-mcp");
    assert.equal(mcp.mcpServers.musemuse.headers.Authorization, "Bearer ${MUSEMUSE_BUILD_MCP_TOKEN}");
    assert.equal(files[`${NOTES_DIR}/.session`], `${SESSION}\n`);
    assert.ok(files[MUSE_FULL_MARKER], "the sandbox remembers that it has the platform's config");
    const script = runner("muse-r0");
    assert.match(script, /^export MUSEMUSE_BUILD_MCP_TOKEN='mm_build_mcp\.3f2a9c1e-77b0-4d2e-9f00-0123456789ab\.[0-9a-f]{64}'$/m);
    assert.ok(script.includes("cmd+=('--config' 'agents.execution_capacity=8' '--config' 'runtime_capabilities={\"plugin:tbh-reminders:reminder:skill-reminder\""));
    assert.ok(script.includes("muse skills enable bundled:workflow-authoring --scope built-in --json >/dev/null 2>&1 || true"));
  });

  it("takes the platform's config away again on a start without MUSE_FULL, in a sandbox that had it", async () => {
    process.env.MUSE_FULL = "1";
    process.env.PLATFORM_URL = "https://musemuse.example";
    await start({ buildId: BUILD });
    delete process.env.MUSE_FULL;
    commands = [];
    answer = (script) => {
      if (script.includes("skills disable")) delete files[MUSE_FULL_MARKER];
      return {};
    };
    const run = await start({ round: 1, buildId: BUILD });
    assert.equal(run.buildMcp, false);
    const clear = commands.find((c) => c.script.includes("skills disable"));
    assert.ok(clear, "the config is cleared first");
    assert.match(clear.script, /^rm -rf -- '\/vercel\/app\/\.muse\/hooks\.json' '\/vercel\/app\/\.mcp\.json' '\/vercel\/musemuse\/hooks\/guard\.mjs' /);
    assert.match(clear.script, /^PATH="\$HOME\/\.local\/bin:\$PATH" muse skills disable bundled:workflow-authoring --scope built-in --json /m);
    assert.match(clear.script, /^rm -f -- '\/vercel\/musemuse\/run\/muse-full'$/m);
    assert.equal(spawnSync("bash", ["-n", "-c", clear.script]).status, 0);
    const script = runner("muse-r1");
    assert.ok(!script.includes("--config") && !script.includes("skills enable") && !script.includes("MUSEMUSE_BUILD_MCP_TOKEN"), "the round runs as it would without the flag");
    // Cleared once: a later start runs nothing extra.
    commands = [];
    await start({ round: 2 });
    assert.deepEqual(
      commands.map((c) => c.detached),
      [true],
    );
  });

  it("leaves the build MCP out when the sandbox can't reach the platform", async () => {
    process.env.MUSE_FULL = "1";
    process.env.PLATFORM_URL = "http://localhost:3000";
    const run = await start({ buildId: BUILD });
    assert.equal(run.buildMcp, false);
    assert.ok(commands[0]!.script.includes("'/vercel/app/.mcp.json'"), ".mcp.json is removed");
    assert.equal(files["/vercel/app/.mcp.json"], undefined);
    assert.ok(!runner("muse-r0").includes("MUSEMUSE_BUILD_MCP_TOKEN"));
  });

  it("starts the session bridge on serve: the SDK once, then the bridge with its config", async () => {
    process.env.MUSE_ENGINE = "serve";
    const run = await start({ round: 2, promptFile: "fix-2.md", images: [".muse-fix/round-2-1.png"], goal: "  Build Bird Finder.  ", buildId: BUILD });
    assert.deepEqual(run, { cmdId: "cmd-2", logPath: "/vercel/musemuse/logs/muse-r2.msp.jsonl", engine: "serve", buildMcp: false });
    const prepare = commands[0]!.script;
    assert.match(prepare, /^set -e$/m);
    assert.match(prepare, /rm -rf '\/vercel\/musemuse\/mailbox\/r2'/);
    assert.match(prepare, /version === "1\.4\.14"/);
    assert.match(prepare, /npm install --no-audit --no-fund --loglevel=error --no-save '@muse-code\/sdk@1\.4\.14'$/);
    assert.equal(files[BRIDGE_SCRIPT], BRIDGE_SOURCE);
    const config = JSON.parse(files[bridgeConfigPath(2)]!) as BridgeConfig;
    assert.deepEqual(config, {
      workspace: "/vercel/app",
      sessionId: SESSION,
      model: "muse-wonder-1.0",
      reasoningEffort: "high",
      promptFile: "/vercel/app/fix-2.md",
      images: ["/vercel/app/.muse-fix/round-2-1.png"],
      goal: "Build Bird Finder.",
      // muse serve has no --disable-web-tools, so web search goes off with its setting, with or without MUSE_FULL.
      settings: ['tools.web_search.mode="off"'],
      disableRequestUserInput: true,
      logPath: "/vercel/musemuse/logs/muse-r2.msp.jsonl",
      mailboxDir: "/vercel/musemuse/mailbox/r2",
      maxModelSteps: 200,
      idleExitMs: 120_000,
    });
    assert.match(runner("muse-r2"), /^cmd=\('node' '\/vercel\/musemuse\/bridge\/bridge\.mjs' '\/vercel\/musemuse\/bridge\/config-r2\.json'\)$/m);
    assert.match(runner("muse-r2"), /> '\/vercel\/musemuse\/logs\/muse-r2\.msp\.err' 2>&1 < \/dev\/null &$/m);
    assert.equal(files["/vercel/musemuse/run/muse-r2.engine"], "serve");
    assert.equal(files["/vercel/musemuse/run/by-id/cmd-2"], "/vercel/musemuse/logs/muse-r2.msp.jsonl");
  });

  it("gives the bridge the settings under MUSE_FULL", async () => {
    process.env.MUSE_ENGINE = "serve";
    process.env.MUSE_FULL = "1";
    await start();
    const config = JSON.parse(files[bridgeConfigPath(0)]!) as BridgeConfig;
    assert.equal(config.settings[0], 'tools.web_search.mode="off"');
    assert.equal(config.settings[1], "agents.execution_capacity=6");
    assert.equal(config.settings.length, 4);
    assert.match(runner("muse-r0"), /^muse skills enable bundled:workflow-authoring/m);
  });

  it("runs the round on exec, saying so, when the bridge can't install its SDK", async () => {
    process.env.MUSE_ENGINE = "serve";
    answer = (script) => (script.includes("npm install") ? { exitCode: 1 } : {});
    const run = await start();
    assert.equal(run.engine, "exec");
    assert.equal(run.notice, "The session bridge couldn't install its SDK, so this round runs on muse exec.");
    assert.equal(run.logPath, "/vercel/musemuse/logs/muse-r0.jsonl");
    assert.equal(files["/vercel/musemuse/run/muse-r0.engine"], "exec");
    assert.equal(files[BRIDGE_SCRIPT], undefined);
  });

  it("runs the round on exec, saying why, when the bridge exits 2 at start", async () => {
    process.env.MUSE_ENGINE = "serve";
    const exit = { t: 1, kind: "bridge", event: "exit", exitCode: 2, goal: null, reason: "host did not start: muse serve exited with code 2" };
    answer = (script) => (script.includes(PROBE) ? { stdout: `exit ${JSON.stringify(exit)}\n` } : {});
    const run = await start();
    assert.equal(run.engine, "exec");
    assert.equal(run.notice, "The session bridge didn't start (host did not start: muse serve exited with code 2), so this round runs on muse exec.");
    assert.equal(files["/vercel/musemuse/run/muse-r0.engine"], "exec");
    assert.deepEqual(
      commands.filter((c) => c.detached).map((c) => c.script),
      ["/vercel/musemuse/run/muse-r0.sh", "/vercel/musemuse/run/muse-r0.sh"],
      "the bridge, then exec under the same name",
    );
  });

  it("runs the round on exec when the bridge ends before Muse Code takes the prompt, whatever its code", async () => {
    process.env.MUSE_ENGINE = "serve";
    const exit = { t: 1, kind: "bridge", event: "exit", exitCode: 1, goal: null, reason: "Muse Code didn't take the prompt (busy writing)" };
    answer = (script) => (script.includes(PROBE) ? { stdout: `exit ${JSON.stringify(exit)}\n` } : {});
    const run = await start();
    assert.equal(run.engine, "exec");
    assert.equal(run.notice, "The session bridge didn't start (Muse Code didn't take the prompt (busy writing)), so this round runs on muse exec.");
    // The check waits for the prompt to be taken, not just for the session to open.
    const probe = commands.find((c) => c.script.includes(PROBE))!.script;
    assert.ok(!probe.includes('"event":"session"'));
    assert.match(probe, /for i in \$\(seq 1 90\); do/);
  });

  it("runs only valid bash in the sandbox", async () => {
    process.env.MUSE_ENGINE = "serve";
    process.env.MUSE_FULL = "1";
    process.env.PLATFORM_URL = "https://musemuse.example";
    await start({ buildId: BUILD });
    const scripts = [...commands.filter((c) => !c.detached).map((c) => c.script), runner("muse-r0")];
    assert.equal(scripts.length, 4, "config, SDK, start check and runner");
    for (const script of scripts) {
      const res = spawnSync("bash", ["-n", "-c", script], { encoding: "utf8" });
      assert.equal(res.status, 0, `${res.stderr}\n${script}`);
    }
  });

  it("reads a new bridge's log in an order that can't miss the turn record", async () => {
    process.env.MUSE_ENGINE = "serve";
    await start();
    const probe = commands.find((c) => c.script.includes(PROBE))!.script;
    const dir = mkdtempSync(path.join(tmpdir(), "musemuse-probe-"));
    try {
      const log = path.join(dir, "muse-r0.msp.jsonl");
      const exitFile = path.join(dir, "muse-r0.msp.err.exit");
      // The same check, once, on files of its own.
      const local = probe
        .replaceAll("/vercel/musemuse/logs/muse-r0.msp.err.exit", exitFile)
        .replaceAll("/vercel/musemuse/logs/muse-r0.msp.jsonl", log)
        .replace("seq 1 90", "seq 1 1")
        .replace("sleep 0.5", "true");
      const check = () => spawnSync("bash", ["-c", local], { encoding: "utf8" }).stdout.trim();
      assert.equal(check(), "waiting");
      const exit = JSON.stringify({ t: 2, kind: "bridge", event: "exit", exitCode: 1, goal: null, reason: "failed: x" });
      writeFileSync(log, `${JSON.stringify({ t: 1, kind: "bridge", event: "turn", reason: "prompt" })}\n${exit}\n`);
      writeFileSync(exitFile, "1\n");
      assert.equal(check(), "turn", "a round that took the prompt and ended at once stays on serve");
      writeFileSync(log, `${exit}\n`);
      assert.equal(check(), `exit ${exit}`);
      writeFileSync(log, "");
      writeFileSync(exitFile, "137\n");
      assert.equal(check(), "ended 137");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a bridge that took the prompt, even one that finished at once, or that is still starting", async () => {
    process.env.MUSE_ENGINE = "serve";
    // A turn record before the exit record reads as "turn": the check looks for it first.
    for (const stdout of ["turn\n", "waiting\n"]) {
      files = {};
      answer = (script) => (script.includes(PROBE) ? { stdout } : {});
      assert.equal((await start()).engine, "serve", stdout);
    }
  });
});

const envelope = (command: MuseCommandEnvelope["command"], id = "c1"): MuseCommandEnvelope => ({ id, at: "2026-10-31T00:00:01.000Z", by: "owner", command });

/** What a dropFile command wrote: the folder, the final name and the content, decoded. */
function dropped() {
  const script = commands.find((c) => c.script.includes("base64 -d"))?.script ?? "";
  const m = /^mkdir -p '([^']+)' && printf '%s' '([^']+)' \| base64 -d > '([^']+)' && mv -f '([^']+)' '([^']+)'$/.exec(script);
  assert.ok(m, script);
  return { dir: m[1]!, content: Buffer.from(m[2]!, "base64").toString("utf8"), tmp: m[3]!, from: m[4]!, to: m[5]! };
}

describe("sendMuseCommand", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  it("names a bridge's mailbox file <at>-<id>.json and writes it whole, through a dot-file", async () => {
    files["/vercel/musemuse/run/muse-r3.engine"] = "serve";
    files["/vercel/musemuse/run/muse-r3.cmd"] = "cmd-bridge";
    const e = envelope({ type: "steer", text: "Make the map bigger, it's hard to read." });
    await builder.sendMuseCommand({ sandboxName: fakeSandbox.name, round: 3, envelope: e });
    const d = dropped();
    assert.equal(d.dir, "/vercel/musemuse/mailbox/r3");
    assert.equal(d.to, "/vercel/musemuse/mailbox/r3/2026-10-31T00:00:01.000Z-c1.json");
    assert.equal(d.tmp, "/vercel/musemuse/mailbox/r3/.2026-10-31T00:00:01.000Z-c1.json.tmp");
    assert.equal(d.from, d.tmp);
    assert.deepEqual(JSON.parse(d.content), e);
    assert.equal(builder.mailboxFileName({ ...e, at: "2026-10-31T00:00:01Z" }), "2026-10-31T00:00:01.000Z-c1.json", "times are written one way, so names sort");
  });

  it("refuses an envelope it can't name, a sandbox that isn't running, and a round that has finished", async () => {
    files["/vercel/musemuse/run/muse-r0.engine"] = "serve";
    await assert.rejects(builder.sendMuseCommand({ sandboxName: fakeSandbox.name, round: 0, envelope: envelope({ type: "interrupt" }, "../x") }), /command id/);
    await assert.rejects(builder.sendMuseCommand({ sandboxName: fakeSandbox.name, round: 0, envelope: { ...envelope({ type: "interrupt" }), at: "soon" } }), /ISO time/);
    fakeSandbox.status = "stopped";
    try {
      await assert.rejects(builder.sendMuseCommand({ sandboxName: fakeSandbox.name, round: 0, envelope: envelope({ type: "interrupt" }) }), /isn't running/);
    } finally {
      fakeSandbox.status = "running";
    }
    // No command recorded for the round: it ended, or never started.
    await assert.rejects(builder.sendMuseCommand({ sandboxName: fakeSandbox.name, round: 0, envelope: envelope({ type: "steer", text: "x" }) }), /has finished/);
    assert.equal(commands.length, 0);
  });

  it("on exec, leaves notes for the notes hook, stops the run on interrupt, and refuses the rest", async () => {
    process.env.MUSE_FULL = "1";
    files["/vercel/musemuse/run/muse-r1.engine"] = "exec";
    files["/vercel/musemuse/run/muse-r1.cmd"] = "cmd-exec";
    await builder.sendMuseCommand({ sandboxName: fakeSandbox.name, round: 1, envelope: envelope({ type: "queue", text: "Then add a footer." }) });
    const d = dropped();
    assert.equal(d.to, `${NOTES_DIR}/2026-10-31T00:00:01.000Z-c1.json`);
    assert.deepEqual(JSON.parse(d.content), { id: "c1", at: "2026-10-31T00:00:01.000Z", by: "owner", kind: "queue", text: "Then add a footer." });
    await assert.rejects(
      builder.sendMuseCommand({ sandboxName: fakeSandbox.name, round: 1, envelope: envelope({ type: "goal", action: "pause" }) }),
      /muse exec, which can't take a goal command/,
    );
    await builder.sendMuseCommand({ sandboxName: fakeSandbox.name, round: 1, envelope: envelope({ type: "end", reason: "time" }) });
    assert.deepEqual(kills, ["SIGTERM"]);
    delete process.env.MUSE_FULL;
    await assert.rejects(builder.sendMuseCommand({ sandboxName: fakeSandbox.name, round: 1, envelope: envelope({ type: "steer", text: "x" }) }), /only with MUSE_FULL/);
    assert.equal(commands.filter((c) => c.script.includes("base64 -d")).length, 1, "only the note was written");
  });
});

describe("transcript highlights", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  it("read a session bridge log's tool calls as they read an exec log's", () => {
    // The Oct 30 spike's stream, as the bridge logs it.
    const spike = readFileSync(path.join(import.meta.dirname, "fixtures/msp-goal-steer.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const records = spike.flatMap((o) => (o.note ? [{ t: o.t, kind: "note", ...(o.note as Record<string, unknown>) }] : []));
    const dir = mkdtempSync(path.join(tmpdir(), "musemuse-highlights-"));
    try {
      writeFileSync(path.join(dir, "muse-r0.msp.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
      // As exportTranscript runs it: a file of its own, with the log folder as its argument.
      const filter = path.join(dir, "highlights.cjs");
      writeFileSync(filter, builder.HIGHLIGHTS_FILTER);
      const res = spawnSync("node", [filter, dir], { encoding: "utf8" });
      assert.equal(res.status, 0, res.stderr);
      const highlights = highlightsFrom(condenseMuseLines(res.stdout.split("\n")).lines);
      // The shell tool answers in JSON, so its first line is "{", as it is in exec's highlights.
      assert.deepEqual(highlights.slice(0, 5), ["5 tool calls, 2 edits touching 2 files", "{", "Edited `steer.txt`", "Edited `goal.txt`", "{"]);
      assert.match(highlights[5]!, /^\{"goal":\{"created_at_ms":1793416199449/);
      assert.equal(highlights.length, 6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pollMuse on the session bridge", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  it("reads the bridge's log with its condenser and is done at the exit record, charging from the session log", async () => {
    const log = [
      { t: 1, kind: "bridge", event: "started", sessionId: SESSION },
      { t: 2, kind: "bridge", event: "session", sessionId: SESSION, reason: "started" },
      { t: 3, kind: "bridge", event: "exit", exitCode: 0, finalText: "Done. Bird Finder works.", goal: null, reason: "completed" },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n")
      .concat("\n");
    answer = (script) => {
      if (script.includes("tail -c +1 '/vercel/musemuse/logs/muse-r0.msp.jsonl'")) return { stdout: Buffer.from(log).toString("base64") };
      return {};
    };
    const poll = await builder.pollMuse({ sandboxName: fakeSandbox.name, cmdId: "cmd-2", logPath: "/vercel/musemuse/logs/muse-r0.msp.jsonl", offset: 0, announced: ["reminder:skill"] });
    assert.equal(poll.done, true);
    assert.equal(poll.exitCode, 0);
    assert.equal(poll.offset, Buffer.byteLength(log));
    assert.equal(poll.finalText, "Done. Bird Finder works.");
    assert.deepEqual(poll.usage, []);
    assert.equal(poll.childrenIncluded, null);
    assert.deepEqual(poll.bridgeState?.announced, ["reminder:skill"], "what was announced carries over");
    assert.ok(commands.some((c) => c.script.includes("node -e") && c.script.includes("muse-r0.msp.jsonl")), "the session log is read for charging");
  });
});
