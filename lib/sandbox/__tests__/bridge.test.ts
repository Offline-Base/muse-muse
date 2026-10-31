/**
 * Unit tests for the session bridge's core (lib/sandbox/bridge/bridge.mjs), driven with a fake `muse serve` host, an
 * in-memory file system and a clock that moves one poll per tick. One test replays the Oct 30 spike's real stream
 * (fixtures/msp-goal-steer.jsonl) through it.
 *   npx tsx --test lib/sandbox/__tests__/bridge.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  commandProblem,
  configProblem,
  EXIT,
  firstTurnInput,
  INTERRUPT_WAIT_MS,
  MAX_IMAGE_BYTES,
  QUIET_MS,
  runBridge,
  serveArgs,
  SETTLE_MS,
  type BridgeConnection,
  type BridgeFrame,
  type BridgeFs,
  type BridgeLimits,
} from "@/lib/sandbox/bridge/bridge.mjs";
import type { BridgeConfig, BridgeLogRecord, MuseCommand, MuseCommandEnvelope } from "@/lib/sandbox/bridge-protocol";

const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";
const LOG = "/vercel/musemuse/logs/muse-r0.msp.jsonl";
const MAILBOX = "/vercel/musemuse/mailbox/r0";
const BRIEF = "# Bird Finder\n\nBuild the bird finder the brief describes.";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function config(over: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    workspace: "/vercel/app",
    sessionId: SESSION,
    model: "muse-wonder-1.0",
    reasoningEffort: "high",
    promptFile: "/vercel/app/brief.md",
    images: ["/vercel/app/inspo/bird.png", "/vercel/app/inspo/gone.png"],
    goal: null,
    settings: [],
    disableRequestUserInput: true,
    logPath: LOG,
    mailboxDir: MAILBOX,
    maxModelSteps: 200,
    idleExitMs: 60_000,
    ...over,
  };
}

/** Files in memory, keyed by absolute path. */
class MemoryFs implements BridgeFs {
  files = new Map<string, string | Buffer>([
    ["/vercel/app/brief.md", BRIEF],
    ["/vercel/app/inspo/bird.png", PNG],
  ]);
  append(file: string, text: string) {
    this.files.set(file, `${String(this.files.get(file) ?? "")}${text}`);
  }
  private get(file: string): string | Buffer {
    const f = this.files.get(file);
    if (f === undefined) throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
    return f;
  }
  async readText(file: string) {
    return String(this.get(file));
  }
  async readBytes(file: string) {
    const f = this.get(file);
    return typeof f === "string" ? Buffer.from(f) : f;
  }
  async list(dir: string) {
    return [...this.files.keys()].filter((f) => path.dirname(f) === dir).map((f) => path.basename(f));
  }
  async move(from: string, to: string) {
    this.files.set(to, this.get(from));
    this.files.delete(from);
  }
  async mkdirp() {}
  records(): BridgeLogRecord[] {
    return String(this.files.get(LOG) ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as BridgeLogRecord);
  }
  /** Drops a command into the mailbox, as sendMuseCommand does. */
  send(id: string, command: MuseCommand | Record<string, unknown>, second = 1) {
    const at = new Date(Date.UTC(2026, 9, 31, 0, 0, second)).toISOString();
    const envelope = { id, at, by: "owner", command } as MuseCommandEnvelope;
    this.files.set(`${MAILBOX}/${at}-${id}.json`, JSON.stringify(envelope));
  }
}

const rejected = (message: string, code: number, kind: string) => Object.assign(new Error(message), { code, kind });

/** A `muse serve` stand-in: one foreground turn at a time, a queue behind it, and the session it was asked to open. */
class FakeHost implements BridgeConnection {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  running: string | null = null;
  queue: string[] = [];
  turns = 0;
  /** The id the next turn gets; the replay test sets the spike's own. */
  nextTurnId: string | null = null;
  sessionExists = false;
  closed = false;
  fail: Record<string, Error> = {};
  /** Fails the next call to the method once, then answers as usual. */
  failOnce: Record<string, Error> = {};
  /** Methods the host never answers. */
  hang = new Set<string>();
  /** Durable events the push stream lost, which view/page still serves. */
  pages: BridgeFrame[] = [];
  /** How the last turn ended, as session/read reports it. */
  lastTurn: Record<string, unknown> | undefined;
  private ids = 0;
  private onNote?: (frame: BridgeFrame) => void;
  private onRequest?: (frame: BridgeFrame) => Promise<Record<string, unknown>>;
  private resolveExit!: (e: { code: number | null; signal: string | null }) => void;
  exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => (this.resolveExit = resolve));

  mint() {
    return `cmd-${++this.ids}`;
  }
  onNotification(handler: (frame: BridgeFrame) => void) {
    this.onNote = handler;
  }
  onServerRequest(handler: (frame: BridgeFrame) => Promise<Record<string, unknown>>) {
    this.onRequest = handler;
  }
  async close() {
    this.closed = true;
  }
  emit(method: string, params: Record<string, unknown> = {}) {
    this.onNote?.({ method, params: { sessionId: SESSION, ...params } });
  }
  /** Delivers a recorded frame as it is. */
  replay(frame: BridgeFrame) {
    this.onNote?.(frame);
  }
  serverRequest(method: string, params: Record<string, unknown>) {
    return this.onRequest?.({ method, params });
  }
  die(code: number) {
    this.resolveExit({ code, signal: null });
  }
  private newTurn() {
    const id = this.nextTurnId ?? `turn-${++this.turns}`;
    this.nextTurnId = null;
    return id;
  }
  /**
   * Ends the running turn, and starts the next queued one, as the host does. With `lost`, the turn/completed never
   * arrives: the stream reports a hole there instead (`dropped`).
   */
  complete(terminal = "completed", extra: Record<string, unknown> = {}, lost?: { after: string; at: string; next: string }) {
    const id = this.running;
    this.running = null;
    this.lastTurn = { turnId: id, terminal, ...extra };
    if (lost) this.dropped("turn/completed", { turnId: id, terminal, ...extra }, lost);
    else this.emit("turn/completed", { turnId: id, terminal, ...extra });
    const next = this.queue.shift();
    if (next) {
      this.running = next;
      this.emit("turn/started", { turnId: next, commandId: next });
    }
  }
  /** A durable event at cursor `at` that push delivery loses: view/page has it, and a view/gap names the hole. */
  dropped(method: string, params: Record<string, unknown>, gap: { after: string; at: string; next: string }) {
    this.pages.push({ method, params: { sessionId: SESSION, ...params, viewCursor: gap.at, sourceRange: { start: 1, end: 1 } } });
    this.emit("view/gap", { after: gap.after, next: gap.next });
  }
  /** A turn Muse Code starts on its own, as a goal does. */
  wake() {
    this.running = this.newTurn();
    this.emit("turn/started", { turnId: this.running, commandId: this.running });
  }
  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ method, params });
    if (this.fail[method]) throw this.fail[method];
    const once = this.failOnce[method];
    if (once) {
      delete this.failOnce[method];
      throw once;
    }
    if (this.hang.has(method)) return new Promise(() => {});
    switch (method) {
      case "session/resume":
        if (!this.sessionExists) throw rejected(`no session ${String(params.sessionId)}`, -32011, "notFound");
        return { session: { sessionId: SESSION, activeTurnId: null, modelId: "muse-wonder-1.0" } };
      case "session/start":
        this.sessionExists = true;
        return { session: { sessionId: SESSION, activeTurnId: null, modelId: "muse-wonder-1.0" }, viewCursor: "v4:x:1" };
      case "turn/start": {
        if (!this.running) {
          const id = this.newTurn();
          this.running = id;
          queueMicrotask(() => this.emit("turn/started", { turnId: id, commandId: id }));
          return { commandId: params.commandId, turnId: id, disposition: "started", startedNewTurn: true, status: "accepted" };
        }
        if (params.ifBusy === "steer") return { commandId: params.commandId, turnId: this.running, disposition: "steered", startedNewTurn: false, status: "accepted" };
        const id = this.newTurn();
        this.queue.push(id);
        return { commandId: params.commandId, turnId: id, disposition: "queued", startedNewTurn: false, status: "accepted" };
      }
      case "turn/steer":
        if (params.expectedTurnId !== this.running) throw rejected("that turn isn't running", -32030, "commandRejected");
        return { commandId: params.commandId, turnId: this.running, status: "accepted" };
      case "view/page": {
        const from = this.pages.findIndex((e) => (e.params as Record<string, unknown>).viewCursor === params.cursor);
        return { events: this.pages.slice(from + 1), nextCursor: null };
      }
      case "session/read":
        return {
          session: { sessionId: SESSION, status: this.running ? "running" : "idle", activeTurnId: this.running },
          ...(this.lastTurn ? { lastTurn: this.lastTurn } : {}),
          pendingRequests: [],
          viewCursor: "v:head",
        };
      default:
        return { commandId: params.commandId, status: "accepted" };
    }
  }
  methods() {
    return this.calls.map((c) => c.method);
  }
  last(method: string) {
    return [...this.calls].reverse().find((c) => c.method === method)?.params;
  }
}

/** A clock that moves one poll per sleep and runs `script[tick]` after each, so a test reads as a timeline. */
function timeline(script: Record<number, () => unknown>) {
  const start = 1_793_416_000_000;
  let now = start;
  let tick = 0;
  return {
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
        tick += 1;
        if (tick > 2000) throw new Error("the bridge never exited");
        await script[tick]?.();
      },
    },
    /** Seconds since the start, for "it waited this long" checks. */
    elapsed: () => (now - start) / 1000,
    tick: () => tick,
  };
}

async function run(
  opts: {
    host?: FakeHost;
    fs?: MemoryFs;
    config?: Partial<BridgeConfig>;
    script?: Record<number, () => unknown>;
    signal?: AbortSignal;
    limits?: Partial<BridgeLimits>;
  } = {},
) {
  const host = opts.host ?? new FakeHost();
  const fs = opts.fs ?? new MemoryFs();
  const time = timeline(opts.script ?? {});
  const connected: string[][] = [];
  const code = await runBridge({
    config: config(opts.config),
    fs,
    clock: time.clock,
    connect: async (args) => {
      connected.push(args);
      return host;
    },
    signal: opts.signal,
    limits: opts.limits,
  });
  const records = fs.records();
  return { code, host, fs, records, exit: records[records.length - 1]!, time, connected };
}

function bridgeEvents(records: BridgeLogRecord[]) {
  return records.filter((r) => r.kind === "bridge").map((r) => (r.kind === "bridge" ? `${r.event}${r.reason ? `: ${r.reason}` : ""}` : ""));
}

function commands(records: BridgeLogRecord[]) {
  return records.filter((r) => r.kind === "command").map((r) => (r.kind === "command" ? { id: r.id, ok: r.ok, error: r.error } : null));
}

describe("the bridge's round", () => {
  it("starts the session under the build's id, sends the prompt with its images, sets the goal, and exits 0 when it's done", async () => {
    const objective = "Build Bird Finder. The goal is complete only when npm run verify exits 0.";
    const host = new FakeHost();
    const { code, records, exit, connected } = await run({
      host,
      config: { goal: objective, settings: ["agents.execution_capacity=6"] },
      script: {
        2: () => {
          host.emit("item/completed", { item: { itemId: "m1", kind: "agentMessage", messagePhase: "commentary", text: "Reading the brief first." } });
          host.emit("session/tokenUsage", { promptTokens: 1000, totalTokens: 1100, turnId: host.running });
        },
        5: () => {
          host.emit("item/completed", { item: { itemId: "m2", kind: "agentMessage", messagePhase: "finalAnswer", text: "Done. Bird Finder works." } });
          host.emit("session/goalChanged", { goal: { objective, status: "complete", percentComplete: 100 } });
          host.complete("completed");
        },
      },
    });
    assert.equal(code, EXIT.completed, JSON.stringify(exit));
    assert.deepEqual(connected, [["serve", "--disable-sandbox", "--trust-workspace", "--disable-request-user-input", "--model", "muse-wonder-1.0", "-c", "agents.execution_capacity=6"]]);
    assert.deepEqual(host.methods(), ["session/resume", "session/start", "session/setReasoningEffort", "turn/start", "goal/set"]);
    assert.equal(host.calls[0]!.params.sessionId, SESSION);
    assert.deepEqual(
      { ...host.calls[1]!.params, commandId: "x" },
      { commandId: "x", sessionId: SESSION, workspaceRoot: "/vercel/app", approvalMode: "allowAll", modelId: "muse-wonder-1.0" },
    );
    const start = host.last("turn/start")!;
    assert.equal(start.ifBusy, "queue");
    assert.equal(start.reasoningEffort, "high");
    // The missing image is skipped, as `muse exec --image` skips one.
    assert.deepEqual(start.input, [
      { type: "text", text: BRIEF },
      { type: "image", mediaType: "image/png", base64Data: PNG.toString("base64") },
    ]);
    assert.equal(host.last("goal/set")!.objective, objective);
    assert.deepEqual(bridgeEvents(records), ["started", "session: started", "turn: prompt", "exit: completed"]);
    assert.deepEqual(exit, {
      t: exit.t,
      kind: "bridge",
      event: "exit",
      exitCode: 0,
      finalText: "Done. Bird Finder works.",
      goal: { objective, status: "complete", percentComplete: 100 },
      reason: "completed",
    });
    assert.ok(host.closed, "the host is closed before the exit record");
    assert.ok(records.some((r) => r.kind === "note" && r.method === "session/tokenUsage"), "every notification is logged");
    assert.ok(records.some((r) => r.kind === "call" && r.method === "goal/set" && r.ok));
  });

  it("waits while the goal is still open, for the turn Muse Code starts for it", async () => {
    const objective = "Make it work.";
    let exitedEarly = false;
    const host = new FakeHost();
    const fs = new MemoryFs();
    const { code, time } = await run({
      host,
      fs,
      config: { goal: objective },
      script: {
        1: () => {
          host.emit("session/goalChanged", { goal: { objective, status: "active", percentComplete: 40 } });
          host.complete("completed");
        },
        // Well past the settle time: an open goal keeps the bridge waiting.
        10: () => {
          exitedEarly = fs.records().some((r) => r.kind === "bridge" && r.event === "exit");
          host.wake();
        },
        12: () => {
          host.emit("session/goalChanged", { goal: { objective, status: "complete", percentComplete: 100 } });
          host.complete("completed");
        },
      },
    });
    assert.equal(exitedEarly, false);
    assert.equal(code, EXIT.completed);
    assert.ok(time.tick() >= 12 + SETTLE_MS / 1000, "exits after the goal's own turn");
    assert.deepEqual(host.methods().filter((m) => m === "turn/start"), ["turn/start"], "the bridge started only the first turn");
  });

  it("resumes a session that exists, and sets its approval mode for a build nobody watches", async () => {
    const host = new FakeHost();
    host.sessionExists = true;
    const { code, records } = await run({ host, script: { 1: () => host.complete() } });
    assert.equal(code, EXIT.completed);
    assert.deepEqual(host.methods().slice(0, 3), ["session/resume", "session/setApprovalMode", "session/setReasoningEffort"]);
    assert.equal(host.last("session/resume")!.excludeItems, true);
    assert.equal(host.last("session/setApprovalMode")!.mode, "allowAll");
    assert.ok(bridgeEvents(records).includes("session: resumed"));
  });
});

describe("the bridge's commands", () => {
  it("steers the running turn by its id", async () => {
    const fs = new MemoryFs();
    const host = new FakeHost();
    const { code, records } = await run({
      host,
      fs,
      script: {
        1: () => fs.send("c1", { type: "steer", text: "Make the map bigger." }),
        3: () => host.complete(),
      },
    });
    assert.equal(code, EXIT.completed);
    assert.deepEqual(host.last("turn/steer"), {
      commandId: host.last("turn/steer")!.commandId,
      sessionId: SESSION,
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "Make the map bigger." }],
      reasoningEffort: "high",
    });
    assert.deepEqual(commands(records), [{ id: "c1", ok: true, error: undefined }]);
    assert.ok([...fs.files.keys()].some((f) => f.startsWith(`${MAILBOX}/done/`) && f.endsWith("-c1.json")), "applied files move to done/");
    assert.ok(![...fs.files.keys()].some((f) => path.dirname(f) === MAILBOX), "nothing is left to apply");
  });

  it("starts a turn with the note when nothing is running", async () => {
    const fs = new MemoryFs();
    const host = new FakeHost();
    const { code } = await run({
      host,
      fs,
      script: {
        1: () => host.complete(),
        2: () => fs.send("c2", { type: "steer", text: "Also add a dark mode." }),
        4: () => host.complete(),
      },
    });
    assert.equal(code, EXIT.completed);
    assert.equal(host.methods().includes("turn/steer"), false);
    const starts = host.calls.filter((c) => c.method === "turn/start");
    assert.deepEqual(
      starts.map((c) => c.params.ifBusy),
      ["queue", "steer"],
    );
    assert.deepEqual(starts[1]!.params.input, [{ type: "text", text: "Also add a dark mode." }]);
  });

  it("starts a turn when the turn it meant to steer ended first", async () => {
    const fs = new MemoryFs();
    const host = new FakeHost();
    host.fail["turn/steer"] = rejected("that turn isn't running", -32030, "commandRejected");
    await run({ host, fs, script: { 1: () => fs.send("c3", { type: "steer", text: "One more thing." }), 2: () => host.complete(), 4: () => host.complete() } });
    assert.deepEqual(
      host.calls.filter((c) => c.method === "turn/start" || c.method === "turn/steer").map((c) => `${c.method} ${String(c.params.ifBusy ?? c.params.expectedTurnId)}`),
      ["turn/start queue", "turn/steer turn-1", "turn/start steer"],
    );
  });

  it("queues a note for after the turn, and stays for the queued turn", async () => {
    const fs = new MemoryFs();
    const host = new FakeHost();
    const { code, records } = await run({
      host,
      fs,
      script: {
        1: () => fs.send("c4", { type: "queue", text: "Then write the README." }),
        3: () => host.complete(),
        6: () => host.complete(),
      },
    });
    assert.equal(code, EXIT.completed);
    assert.deepEqual(
      host.calls.filter((c) => c.method === "turn/start").map((c) => c.params.ifBusy),
      ["queue", "queue"],
    );
    assert.equal(host.queue.length, 0);
    const completed = records.filter((r) => r.kind === "note" && r.method === "turn/completed");
    assert.equal(completed.length, 2, "both turns ran before the bridge exited");
  });

  it("stops the turn on interrupt and stays open for a note, then exits 1 when none comes", async () => {
    const fs = new MemoryFs();
    const host = new FakeHost();
    const { code, records, exit, time } = await run({
      host,
      fs,
      config: { idleExitMs: 30_000 },
      script: {
        1: () => fs.send("c5", { type: "interrupt" }),
        2: () => host.complete("cancelled"),
      },
    });
    assert.equal(code, EXIT.failed);
    assert.equal(host.last("turn/interrupt")!.turnId, "turn-1");
    assert.ok(bridgeEvents(records).includes("idle: interrupted"));
    assert.equal(exit.kind === "bridge" && exit.reason, "interrupted");
    assert.ok(time.elapsed() >= 2 + 30, `waited the idle time, left after ${time.elapsed()} s`);
  });

  it("answers an interrupt with nothing running as a failed command", async () => {
    const fs = new MemoryFs();
    const host = new FakeHost();
    const { records } = await run({ host, fs, script: { 1: () => host.complete(), 2: () => fs.send("c6", { type: "interrupt" }) } });
    assert.deepEqual(commands(records), [{ id: "c6", ok: false, error: "nothing is running" }]);
    assert.equal(host.methods().includes("turn/interrupt"), false);
  });

  it("ends the round on end: stops the turn, closes the host, and applies nothing after it", async () => {
    const fs = new MemoryFs();
    const host = new FakeHost();
    const { code, exit, records } = await run({
      host,
      fs,
      script: {
        1: () => {
          fs.send("c7", { type: "end", reason: "time cap" }, 1);
          fs.send("c8", { type: "steer", text: "too late" }, 2);
        },
        2: () => host.complete("cancelled"),
      },
    });
    assert.equal(code, EXIT.failed);
    assert.equal(exit.kind === "bridge" && exit.reason, "time cap");
    assert.ok(host.closed);
    assert.equal(host.methods().includes("turn/steer"), false);
    assert.deepEqual(
      commands(records).map((c) => c?.id),
      ["c7"],
    );
  });

  it("ends at once with the last turn's code when nothing is running", async () => {
    const fs = new MemoryFs();
    const host = new FakeHost();
    const { code, exit, time } = await run({ host, fs, config: { goal: "g" }, script: { 1: () => {
      host.emit("session/goalChanged", { goal: { objective: "g", status: "active", percentComplete: 10 } });
      host.complete();
    }, 2: () => fs.send("c9", { type: "end" }) } });
    assert.equal(code, EXIT.completed);
    assert.equal(exit.kind === "bridge" && exit.reason, "ended");
    assert.ok(time.elapsed() < 10, "doesn't wait out the open goal");
  });

  it("maps goal, answer, workflow and subagent commands onto their protocol calls", async () => {
    const fs = new MemoryFs();
    const host = new FakeHost();
    const { code, records } = await run({
      host,
      fs,
      script: {
        1: () => {
          host.emit("item/started", { item: { itemId: "w1", kind: "workflow", status: "inProgress", workflowRunId: "wf-run-7" } });
          host.emit("item/started", { item: { itemId: "s1", kind: "subagent", status: "inProgress", childSessionId: "child-session-1", subagentId: "sub-42" } });
          fs.send("g1", { type: "goal", action: "edit", objective: "  A smaller goal.  " }, 1);
          fs.send("g2", { type: "goal", action: "pause" }, 2);
          fs.send("a1", { type: "answer", userInputId: "q-1", answers: [{ questionId: "color", selectedLabel: "Blue" }] }, 3);
          fs.send("w1", { type: "workflow", action: "pause" }, 4);
          fs.send("w2", { type: "workflow", action: "cancel", workflowId: "wf-other" }, 5);
          fs.send("s1", { type: "subagent", action: "message", childSessionId: "child-session-1", text: "Check the footer too." }, 6);
          fs.send("s2", { type: "subagent", action: "stop", childSessionId: "child-session-1" }, 7);
        },
        3: () => {
          host.emit("item/completed", { item: { itemId: "w1", kind: "workflow", status: "completed", workflowRunId: "wf-run-7" } });
          host.emit("item/completed", { item: { itemId: "s1", kind: "subagent", status: "cancelled", childSessionId: "child-session-1", subagentId: "sub-42" } });
          host.complete();
        },
      },
    });
    assert.equal(code, EXIT.completed);
    const call = (method: string) => {
      const p = { ...host.last(method)! };
      delete p.commandId;
      return p;
    };
    assert.deepEqual(call("goal/edit"), { sessionId: SESSION, objective: "A smaller goal." });
    assert.deepEqual(call("goal/pause"), { sessionId: SESSION });
    assert.deepEqual(call("userInput/answer"), { sessionId: SESSION, userInputId: "q-1", answers: [{ questionId: "color", selectedLabel: "Blue" }] });
    assert.deepEqual(call("workflow/pause"), { sessionId: SESSION, workflowRunId: "wf-run-7" });
    assert.deepEqual(call("workflow/cancel"), { sessionId: SESSION, workflowRunId: "wf-other" });
    assert.deepEqual(call("subagent/sendMessage"), { sessionId: SESSION, subagentId: "sub-42", body: "Check the footer too." });
    assert.deepEqual(call("subagent/stop"), { sessionId: SESSION, subagentId: "sub-42", reason: "Stopped by the build's owner." });
    assert.ok(commands(records).every((c) => c?.ok), JSON.stringify(commands(records)));
    for (const c of host.calls) assert.ok(typeof c.params.commandId === "string", `${c.method} carries a command id`);
  });

  it("refuses a workflow command when no workflow runs", async () => {
    const fs = new MemoryFs();
    const host = new FakeHost();
    const { records } = await run({ host, fs, script: { 1: () => fs.send("w3", { type: "workflow", action: "resume" }), 2: () => host.complete() } });
    assert.deepEqual(commands(records), [{ id: "w3", ok: false, error: "no workflow is running" }]);
  });

  it("logs and skips a mailbox file that isn't a command, and applies a command id once", async () => {
    const fs = new MemoryFs();
    const host = new FakeHost();
    const { records } = await run({
      host,
      fs,
      script: {
        1: () => {
          fs.files.set(`${MAILBOX}/2026-10-31T00:00:00.000Z-bad.json`, "{not json");
          fs.send("good", { type: "steer", text: "Bigger buttons." }, 1);
          fs.files.set(`${MAILBOX}/2026-10-31T00:00:02.000Z-noid.json`, JSON.stringify({ at: "x", by: "owner", command: { type: "interrupt" } }));
          fs.send("odd", { type: "dance" }, 3);
          fs.send("empty", { type: "steer", text: "  " }, 4);
          fs.files.set(`${MAILBOX}/.2026-10-31T00:00:05.000Z-tmp.json`, "{");
        },
        // The same command delivered again under another name.
        2: () => fs.send("good", { type: "steer", text: "Bigger buttons." }, 9),
        4: () => host.complete(),
      },
    });
    const seen = commands(records);
    assert.equal(seen.length, 5);
    assert.deepEqual(seen[0]?.id, "2026-10-31T00:00:00.000Z-bad.json");
    assert.equal(seen[0]?.ok, false);
    assert.match(String(seen[0]?.error), /isn't a command/);
    assert.deepEqual(seen.slice(1), [
      { id: "good", ok: true, error: undefined },
      { id: "2026-10-31T00:00:02.000Z-noid.json", ok: false, error: "the envelope has no id" },
      { id: "odd", ok: false, error: "unknown command type" },
      { id: "empty", ok: false, error: "a steer needs text" },
    ]);
    assert.equal(host.calls.filter((c) => c.method === "turn/steer").length, 1, "the repeat isn't applied");
    assert.equal([...fs.files.keys()].filter((f) => f.startsWith(`${MAILBOX}/done/`)).length, 6);
    assert.ok(fs.files.has(`${MAILBOX}/.2026-10-31T00:00:05.000Z-tmp.json`), "a file still being written is left alone");
  });

  it("answers an approval with an allow choice, once", async () => {
    const host = new FakeHost();
    const approval = {
      approvalId: "ap-1",
      currentRequirementId: { approvalId: "ap-1", sourceIndex: 0 },
      availableChoices: [
        { choiceId: "no", decision: "denied", label: "Reject", scope: "once" },
        { choiceId: "once", decision: "approved", label: "Allow once", scope: "once" },
        { choiceId: "always", decision: "approvedForSession", label: "Allow for this session", scope: "session" },
      ],
    };
    let receipt: unknown;
    await run({
      host,
      script: {
        1: async () => {
          receipt = await host.serverRequest("approval/request", approval);
          host.emit("approval/requested", approval);
        },
        2: () => host.complete(),
      },
    });
    assert.deepEqual(receipt, {});
    const decisions = host.calls.filter((c) => c.method === "approval/decide");
    assert.equal(decisions.length, 1);
    assert.deepEqual({ ...decisions[0]!.params, commandId: "x" }, { commandId: "x", sessionId: SESSION, approvalId: "ap-1", choiceId: "always", requirementId: approval.currentRequirementId });
  });
});

describe("the bridge's limits and endings", () => {
  it("stops the turn at the step cap and exits 1, as exec does at its cap", async () => {
    const host = new FakeHost();
    const { code, exit } = await run({
      host,
      config: { maxModelSteps: 3 },
      script: {
        1: () => {
          for (let i = 0; i < 3; i++) host.emit("session/tokenUsage", { promptTokens: 100, totalTokens: 110 });
        },
        2: () => host.complete("cancelled"),
      },
    });
    assert.equal(code, EXIT.failed);
    assert.equal(host.last("turn/interrupt")!.turnId, "turn-1");
    assert.equal(exit.kind === "bridge" && exit.reason, "step cap of 3 model steps");
  });

  it("exits at the cap even when the stopped turn never reports its end", async () => {
    const host = new FakeHost();
    const { code, time } = await run({
      host,
      config: { maxModelSteps: 1 },
      script: { 1: () => host.emit("session/tokenUsage", {}) },
    });
    assert.equal(code, EXIT.failed);
    assert.ok(time.elapsed() >= INTERRUPT_WAIT_MS / 1000 && time.elapsed() < INTERRUPT_WAIT_MS / 1000 + 5);
  });

  it("exits 1 when the host dies mid-turn", async () => {
    const host = new FakeHost();
    const { code, exit } = await run({ host, script: { 2: () => host.die(3) } });
    assert.equal(code, EXIT.failed);
    assert.equal(exit.kind === "bridge" && exit.reason, "host exited with code 3");
  });

  it("exits 1 with the turn's error when it failed", async () => {
    const host = new FakeHost();
    const { code, exit } = await run({
      host,
      script: { 1: () => host.complete("failed", { error: { kind: "modelError", message: "API error 403: blocked", retryable: false } }) },
    });
    assert.equal(code, EXIT.failed);
    assert.equal(exit.kind === "bridge" && exit.reason, "failed: API error 403: blocked");
  });

  it("stops when told to, with the exit record", async () => {
    const host = new FakeHost();
    const stop = new AbortController();
    const { code, exit } = await run({ host, signal: stop.signal, script: { 1: () => stop.abort(), 2: () => host.complete("cancelled") } });
    assert.equal(code, EXIT.failed);
    assert.equal(exit.kind === "bridge" && exit.reason, "stopped");
    assert.equal(host.last("turn/interrupt")!.turnId, "turn-1");
  });

  it("always ends the log with the exit record, whatever goes wrong", async () => {
    // A config it can't run.
    const bad = new MemoryFs();
    const badCode = await runBridge({ config: { ...config(), sessionId: "nope" }, fs: bad, clock: timeline({}).clock, connect: async () => new FakeHost() });
    assert.equal(badCode, EXIT.usage);
    assert.deepEqual(bad.records().map((r) => (r.kind === "bridge" ? `${r.event} ${r.exitCode ?? ""} ${r.reason ?? ""}`.trim() : r.kind)), ["exit 2 config: sessionId isn't a UUID"]);

    // A host that doesn't start.
    const noHost = new MemoryFs();
    const noHostCode = await runBridge({
      config: config(),
      fs: noHost,
      clock: timeline({}).clock,
      connect: async () => {
        throw new Error("spawn muse ENOENT");
      },
    });
    assert.equal(noHostCode, EXIT.usage);
    assert.deepEqual(bridgeEvents(noHost.records()), ["started", "exit: host did not start: spawn muse ENOENT"]);

    // A prompt that isn't there.
    const noPrompt = await run({ config: { promptFile: "/vercel/app/fix-9.md" } });
    assert.equal(noPrompt.code, EXIT.usage);
    assert.match(noPrompt.exit.kind === "bridge" ? String(noPrompt.exit.reason) : "", /^config: can't read the prompt/);
    assert.deepEqual(noPrompt.connected, [], "nothing was started");

    // A session that can't be opened either way. The host is up, so it is no command-line refusal (exit 2).
    const host = new FakeHost();
    host.fail["session/start"] = rejected("session_id_conflict", -32030, "commandRejected");
    const noSession = await run({ host });
    assert.equal(noSession.code, EXIT.failed);
    assert.match(noSession.exit.kind === "bridge" ? String(noSession.exit.reason) : "", /couldn't open the session \(no session .*; session_id_conflict\)/);
    assert.ok(host.closed);

    // A prompt the host won't take.
    const refusing = new FakeHost();
    refusing.fail["turn/start"] = rejected("invalid params", -32602, "invalidParams");
    const refused = await run({ host: refusing });
    assert.equal(refused.code, EXIT.failed);

    // Something the bridge never expected.
    const crashing = await run({
      script: {
        1: () => {
          throw new Error("disk full");
        },
      },
    });
    assert.equal(crashing.code, EXIT.failed);
    assert.equal(crashing.exit.kind === "bridge" && crashing.exit.reason, "bridge error: disk full");
    for (const r of [noPrompt, noSession, refused, crashing]) {
      assert.equal(r.records.filter((x) => x.kind === "bridge" && x.event === "exit").length, 1);
      assert.equal(r.exit.kind === "bridge" && r.exit.event, "exit");
    }
  });

  it("replays the Oct 30 spike's stream to the same ending: the goal complete and the final answer", async () => {
    const lines = readFileSync(path.join(import.meta.dirname, "fixtures/msp-goal-steer.jsonl"), "utf8").trim().split("\n");
    const notes = lines.map((l) => JSON.parse(l) as { note?: { method: string; params: Record<string, unknown> } }).flatMap((o) => (o.note ? [o.note] : []));
    const turnId = "01a18fef-7d18-7000-8e07-b15f13c15afc";
    const sessionId = "01a18fef-7c76-73e1-b8e5-35e7c25ebd8b";
    const host = new FakeHost();
    host.nextTurnId = turnId;
    const fs = new MemoryFs();
    const time = timeline({
      1: () => {
        for (const n of notes) host.replay({ method: n.method, params: n.params });
      },
    });
    const code = await runBridge({ config: config({ sessionId, images: [] }), fs, clock: time.clock, connect: async () => host });
    const records = fs.records();
    const exit = records[records.length - 1]!;
    assert.equal(code, EXIT.completed);
    assert.ok(exit.kind === "bridge" && exit.finalText?.startsWith("Done. Ran `sleep 8`, then created:"));
    assert.deepEqual(exit.kind === "bridge" && exit.goal, {
      objective: "Using the shell, run sleep 8, then create the file goal.txt containing OK. The goal is complete when goal.txt exists and contains OK.",
      status: "complete",
      percentComplete: 100,
    });
    assert.equal(records.filter((r) => r.kind === "note").length, notes.length + 1, "each frame is logged, with the fake's own turn/started");
  });
});

describe("the bridge's start", () => {
  const turnRecords = (records: BridgeLogRecord[]) => records.filter((r) => r.kind === "bridge" && r.event === "turn");

  it("ends with 1 and no turn record when Muse Code won't take the prompt after the session opened", async () => {
    const host = new FakeHost();
    host.fail["turn/start"] = rejected("invalid params", -32602, "invalidParams");
    const { code, records } = await run({ host });
    assert.equal(code, EXIT.failed);
    // No turn record: startMuse reads that as a start that didn't happen and runs the round on exec.
    assert.deepEqual(bridgeEvents(records), ["started", "session: started", "exit: Muse Code didn't take the prompt (invalid params)"]);
    assert.equal(host.methods().filter((m) => m === "turn/start").length, 1, "a refusal that admitted something isn't sent again");
    assert.ok(host.closed);
  });

  it("gives up on a start that runs out of time, without sending what comes after", async () => {
    const host = new FakeHost();
    host.hang.add("session/resume");
    const began = performance.now();
    const { code, exit, records } = await run({ host, limits: { startMs: 50 } });
    assert.equal(code, EXIT.failed);
    assert.match(exit.kind === "bridge" ? String(exit.reason) : "", /^couldn't open the session \(no answer in \d+ ms; out of time\)$/);
    assert.deepEqual(host.methods(), ["session/resume"], "session/start isn't sent once the start's time is up");
    assert.ok(host.closed);
    assert.deepEqual(turnRecords(records), []);
    assert.ok(performance.now() - began < 2000);
  });

  it("gives up on a host that never answers its handshake", async () => {
    const fs = new MemoryFs();
    const code = await runBridge({ config: config(), fs, clock: timeline({}).clock, connect: () => new Promise(() => {}), limits: { startMs: 50 } });
    assert.equal(code, EXIT.usage);
    const exit = fs.records().at(-1);
    assert.match(exit?.kind === "bridge" ? String(exit.reason) : "", /^host did not start: no answer in \d+ ms$/);
  });

  it("sends a command again, under the same id, when the host turned it away unseen", async () => {
    const host = new FakeHost();
    host.failOnce["turn/start"] = rejected("busy writing", -32031, "backpressured");
    const { code, records } = await run({ host, limits: { retryMs: 1 }, script: { 1: () => host.complete() } });
    assert.equal(code, EXIT.completed);
    const starts = host.calls.filter((c) => c.method === "turn/start");
    assert.equal(starts.length, 2);
    assert.equal(starts[0]!.params.commandId, starts[1]!.params.commandId);
    assert.equal(turnRecords(records).length, 1);
  });

  it("stops while the host is still starting, with its exit record", async () => {
    const stop = new AbortController();
    stop.abort();
    const fs = new MemoryFs();
    const code = await runBridge({
      config: config(),
      fs,
      clock: timeline({}).clock,
      connect: () => new Promise(() => {}),
      signal: stop.signal,
      limits: { startMs: 50 },
    });
    assert.equal(code, EXIT.failed);
    assert.deepEqual(bridgeEvents(fs.records()), ["started", "exit: stopped"]);
  });

  it("closes a host that came up after it was told to stop, and opens no session", async () => {
    const stop = new AbortController();
    stop.abort();
    const host = new FakeHost();
    const { code, records } = await run({ host, signal: stop.signal });
    assert.equal(code, EXIT.failed);
    assert.deepEqual(bridgeEvents(records), ["started", "exit: stopped"]);
    assert.deepEqual(host.methods(), []);
    assert.ok(host.closed);
  });
});

describe("the bridge's background work", () => {
  const workflow = (revision: number, status: string, extra: Record<string, unknown> = {}) => ({
    item: { itemId: "w1", kind: "workflow", status, workflowRunId: "wf-1", revision, ...extra },
  });
  const subagent = (revision: number, controlStatus: string) => ({
    item: { itemId: "s1", kind: "subagent", status: "inProgress", controlStatus, childSessionId: "child-1", subagentId: "sub-1", revision },
  });

  it("waits for a workflow still running after its turn, and for the turn its end wakes", async () => {
    const fs = new MemoryFs();
    const host = new FakeHost();
    let exitedEarly = true;
    const { code, records, time } = await run({
      host,
      fs,
      script: {
        1: () => {
          host.emit("item/started", workflow(1, "inProgress"));
          host.complete();
        },
        // Half a minute on, the workflow finishes and Muse Code starts a turn to hand over its result.
        31: () => {
          exitedEarly = fs.records().some((r) => r.kind === "bridge" && r.event === "exit");
          host.emit("item/completed", workflow(2, "completed"));
          host.wake();
        },
        33: () => host.complete(),
      },
    });
    assert.equal(exitedEarly, false, "the bridge stayed while the workflow ran");
    assert.equal(code, EXIT.completed);
    assert.ok(time.tick() >= 33 + SETTLE_MS / 1000, `left at tick ${time.tick()}`);
    assert.equal(records.filter((r) => r.kind === "note" && r.method === "turn/completed").length, 2, "the wake turn ran before the bridge left");
    assert.ok(bridgeEvents(records).includes("idle: background work"));
  });

  it("waits for a subagent that is still running, but not for one whose result is ready", async () => {
    const host = new FakeHost();
    const { code, time } = await run({
      host,
      script: {
        1: () => {
          host.emit("item/started", subagent(1, "running"));
          host.complete();
        },
        20: () => host.emit("item/updated", subagent(2, "resultReady")),
      },
    });
    assert.equal(code, EXIT.completed);
    assert.ok(time.elapsed() >= 20 + SETTLE_MS / 1000 && time.elapsed() < 20 + SETTLE_MS / 1000 + 3, `left after ${time.elapsed()} s`);
  });

  it("stays for a paused workflow until the idle time runs out", async () => {
    const host = new FakeHost();
    const { code, exit, records, time } = await run({
      host,
      config: { idleExitMs: 30_000 },
      script: {
        1: () => {
          host.emit("item/started", workflow(1, "inProgress"));
          host.complete();
        },
        5: () => host.emit("item/updated", workflow(2, "inProgress", { paused: true })),
      },
    });
    assert.equal(code, EXIT.completed);
    assert.equal(exit.kind === "bridge" && exit.reason, "a workflow stayed paused");
    assert.ok(time.elapsed() >= 5 + 30, `left after ${time.elapsed()} s`);
    assert.deepEqual(
      bridgeEvents(records).filter((e) => e.startsWith("idle")),
      ["idle: background work", "idle: workflow paused"],
    );
  });

  it("keeps a finished workflow finished when an older copy of it comes late", async () => {
    const host = new FakeHost();
    const { code, time } = await run({
      host,
      script: {
        1: () => {
          host.emit("item/started", workflow(1, "inProgress"));
          host.emit("item/completed", workflow(3, "completed"));
          host.emit("item/updated", workflow(2, "inProgress"));
          host.complete();
        },
      },
    });
    assert.equal(code, EXIT.completed);
    assert.ok(time.elapsed() < 10, `left after ${time.elapsed()} s`);
  });

  it("ends as stopped when the owner ends the round while a workflow still works", async () => {
    const fs = new MemoryFs();
    const host = new FakeHost();
    const { code, exit } = await run({
      host,
      fs,
      script: {
        1: () => {
          host.emit("item/started", workflow(1, "inProgress"));
          host.complete();
        },
        3: () => fs.send("e1", { type: "end", reason: "the owner ended it" }),
      },
    });
    assert.equal(code, EXIT.failed);
    assert.equal(exit.kind === "bridge" && exit.reason, "the owner ended it");
    assert.ok(host.closed);
  });
});

describe("the bridge's stream", () => {
  it("pages in what a view/gap says was dropped, and ends the turn whose turn/completed was in it", async () => {
    const host = new FakeHost();
    const { code, records, exit, time } = await run({
      host,
      script: {
        2: () => {
          host.emit("item/completed", { item: { itemId: "m1", kind: "agentMessage", messagePhase: "finalAnswer", text: "Done." } });
          host.complete("completed", {}, { after: "v:7", at: "v:8", next: "v:9" });
        },
        // The same durable event again, as a stream that overlaps a filled gap could bring it.
        3: () => host.replay({ method: "turn/completed", params: { sessionId: SESSION, turnId: "turn-1", terminal: "completed", viewCursor: "v:8", sourceRange: { start: 1, end: 1 } } }),
      },
    });
    assert.equal(code, EXIT.completed, JSON.stringify(exit));
    assert.equal(exit.kind === "bridge" && exit.reason, "completed");
    assert.equal(exit.kind === "bridge" && exit.finalText, "Done.");
    assert.ok(time.elapsed() < 2 + SETTLE_MS / 1000 + 3, `left after ${time.elapsed()} s`);
    assert.deepEqual(host.last("view/page"), { sessionId: SESSION, cursor: "v:7", limit: 200 });
    assert.equal(records.filter((r) => r.kind === "note" && r.method === "turn/completed").length, 1, "the dropped event is logged once");
    const page = records.find((r) => r.kind === "call" && r.method === "view/page");
    assert.deepEqual(page?.kind === "call" && page.result, { events: 1, nextCursor: null }, "a page is logged in short");
  });

  it("asks the host how the session stands when the hole can't be paged in", async () => {
    const host = new FakeHost();
    host.fail["view/page"] = rejected("no such cursor", -32011, "notFound");
    const { code, exit } = await run({
      host,
      script: { 2: () => host.complete("failed", { error: { kind: "modelError", message: "API error 500" } }, { after: "v:7", at: "v:8", next: "v:9" }) },
    });
    assert.equal(code, EXIT.failed);
    assert.equal(exit.kind === "bridge" && exit.reason, "failed: API error 500");
    assert.deepEqual(host.last("session/read"), { sessionId: SESSION });
  });

  it("follows a turn whose turn/started was dropped, instead of leaving while it runs", async () => {
    const host = new FakeHost();
    const { code, records, time } = await run({
      host,
      script: {
        2: () => {
          host.complete();
          // Muse Code starts a turn of its own right away, and its turn/started is lost.
          host.running = "turn-2";
          host.dropped("turn/started", { turnId: "turn-2", commandId: "turn-2" }, { after: "v:1", at: "v:2", next: "v:3" });
        },
        10: () => host.complete(),
      },
    });
    assert.equal(code, EXIT.completed);
    assert.ok(time.tick() >= 10 + SETTLE_MS / 1000, `left at tick ${time.tick()}`);
    assert.equal(records.filter((r) => r.kind === "note" && r.method === "turn/completed").length, 2);
  });

  it("checks a turn that has gone quiet for a minute, and ends it when the host says it ended", async () => {
    const host = new FakeHost();
    const { code, time } = await run({
      host,
      script: {
        // The turn ends, and nothing about it reaches the bridge: no turn/completed and no view/gap.
        1: () => {
          host.lastTurn = { turnId: host.running, terminal: "completed" };
          host.running = null;
        },
      },
    });
    assert.equal(code, EXIT.completed);
    assert.ok(time.elapsed() >= QUIET_MS / 1000 && time.elapsed() < QUIET_MS / 1000 + SETTLE_MS / 1000 + 3, `left after ${time.elapsed()} s`);
    assert.equal(host.methods().filter((m) => m === "session/read").length, 1);
  });

  it("keeps the newest goal when an older change comes late", async () => {
    const objective = "Make it work.";
    const host = new FakeHost();
    const { code, exit, time } = await run({
      host,
      config: { goal: objective },
      script: {
        1: () => {
          host.emit("session/goalChanged", { goal: { objective, status: "complete", percentComplete: 100, updatedAtMs: 200 } });
          host.emit("session/goalChanged", { goal: { objective, status: "active", percentComplete: 40, updatedAtMs: 100 } });
          host.complete();
        },
      },
    });
    assert.equal(code, EXIT.completed);
    assert.deepEqual(exit.kind === "bridge" && exit.goal, { objective, status: "complete", percentComplete: 100 });
    assert.ok(time.elapsed() < 10, "doesn't wait out a goal that is already complete");
  });
});

describe("the bridge's checks", () => {
  it("builds the host's command line from the config", () => {
    assert.deepEqual(serveArgs(config({ disableRequestUserInput: false, model: "muse-spark-1.3-contributor", settings: ["a.b=1", 'c={"d":true}'] })), [
      "serve",
      "--disable-sandbox",
      "--trust-workspace",
      "--model",
      "muse-spark-1.3-contributor",
      "-c",
      "a.b=1",
      "-c",
      'c={"d":true}',
    ]);
  });

  it("refuses configs and commands it can't apply", () => {
    assert.equal(configProblem(config()), null);
    assert.equal(configProblem(null), "the config isn't a JSON object");
    assert.equal(configProblem({ ...config(), logPath: "" }), "logPath is missing");
    assert.equal(configProblem({ ...config(), settings: ["no equals"] }), "settings must be key=value strings");
    assert.equal(configProblem({ ...config(), settings: ['tools.web_search.mode="off"', "agents.execution_capacity=6"] }), null);
    assert.equal(configProblem({ ...config(), maxModelSteps: 0 }), "maxModelSteps must be a positive whole number");
    assert.equal(configProblem({ ...config(), goal: 3 }), "goal must be text or null");
    assert.equal(commandProblem({ type: "goal", action: "set", objective: " " }), "the goal needs an objective");
    assert.equal(commandProblem({ type: "goal", action: "resume" }), null);
    assert.equal(commandProblem({ type: "answer", userInputId: "q", answers: [] }), "an answer needs one entry per question");
    assert.equal(commandProblem({ type: "subagent", action: "message", childSessionId: "c" }), "a message needs text");
    assert.equal(commandProblem({ type: "subagent", action: "interrupt", childSessionId: "c" }), null);
    assert.equal(commandProblem({ type: "end" }), null);
  });

  it("leaves out images it can't attach, and says which", async () => {
    const fs = new MemoryFs();
    fs.files.set("/vercel/app/inspo/huge.png", Buffer.alloc(MAX_IMAGE_BYTES + 1));
    fs.files.set("/vercel/app/inspo/notes.heic", Buffer.from("heic"));
    fs.files.set("/vercel/app/inspo/photo.JPG", Buffer.from("jpg"));
    const { input, left } = await firstTurnInput(
      config({ images: ["inspo/bird.png", "inspo/huge.png", "inspo/notes.heic", "inspo/photo.JPG", "inspo/gone.png"] }),
      fs,
    );
    assert.deepEqual(
      input.map((p) => p.mediaType ?? p.type),
      ["text", "image/png", "image/jpeg"],
    );
    assert.deepEqual(left, ["huge.png (too big to attach)", "notes.heic (not an image type Muse Code takes)"]);
  });
});
