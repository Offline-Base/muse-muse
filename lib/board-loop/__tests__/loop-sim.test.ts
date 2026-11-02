/**
 * The whole board loop against the real simulated board: scripts/sim-board.mjs runs as a real process, and the real fleet driver
 * talks to it over HTTP. Only the rows are in memory, and the clip recorder is faked here (a browser and ffmpeg belong to the
 * run in docs/BUILD_LOG.md). No model, no GPU, no database.
 *
 *   npx tsx --test lib/board-loop/__tests__/loop-sim.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import type { BoardDriver } from "@/lib/board-loop/driver";
import { boardLabel, currentStage, judgedProblem, loopView, newData, newStages, SIMULATED_NOTE, TEST_SET, type LoopRow } from "@/lib/board-loop/logic";
import { clipCaption, clipScene } from "@/lib/board-loop/clip";
import { runningSimBoard, startSimBoard, stopSimBoard } from "@/lib/board-loop/sim";
import { loopFile, tickLoop, type TickDeps } from "@/lib/board-loop/tick";
import { joinQueue, pollTurn, TRY_LIMITS, type Turn, type TryDeps, type TryStore } from "@/lib/board-loop/try";
import { BASE_MODEL_PARAM } from "@/lib/train/base";
import type { LocalFiles } from "@/lib/train/local-files";
import { ADAPTER_RECIPE } from "@/lib/train/logic";

let clock = new Date("2026-11-01T18:00:00Z");
const now = () => clock;

function makeRow(id = "11111111-1111-4111-8111-111111111111"): LoopRow {
  return { id, adapterJobId: "22222222-2222-4222-8222-222222222222", target: "simulated", status: "running", stages: newStages(), data: newData("Made-up tutor"), tryOpen: false, stopRequested: false, workflowRunId: null, createdAt: clock, updatedAt: clock };
}

function tickDeps(row: LoopRow, over: Partial<TickDeps> = {}): TickDeps {
  return {
    load: async () => row,
    save: async () => {},
    board: () => startSimBoard(),
    job: async () => ({ status: "succeeded", costUsd: 1.25, judgeCostUsd: 0.05, error: null }),
    localFiles: async () => null,
    recordClip: async (r) => ({ videoUrl: "/clip.mp4", posterUrl: null, captioned: clipCaption(r) }),
    now,
    ...over,
  };
}

async function runUntil(row: LoopRow, deps: TickDeps, until: (r: LoopRow) => boolean, maxTicks = 80): Promise<void> {
  for (let i = 0; i < maxTicks && !until(row); i++) {
    const { done, waitMs } = await tickLoop(row.id, deps);
    if (done) return;
    if (waitMs > 0) await new Promise((r) => setTimeout(r, Math.min(waitMs, 150)));
  }
}

function memoryTryStore(loop: LoopRow) {
  const turns = new Map<string, Turn>();
  const counters = new Map<string, number>();
  let n = 0;
  const store: TryStore = {
    loop: async (id) => (id === loop.id ? loop : null),
    openTurn: async (_l, v) => [...turns.values()].find((t) => t.visitor === v && (t.status === "queued" || t.status === "running")) ?? null,
    addTurn: async (loopId, visitor, prompt) => {
      const t: Turn = { id: `t${++n}`, loopId, visitor, prompt, status: "queued", answer: null, tokens: null, tokensPerSecond: null, ms: null, error: null, lastSeenAt: clock, startedAt: null, createdAt: new Date(clock.getTime() + n) };
      turns.set(t.id, t);
      return t;
    },
    turn: async (id) => turns.get(id) ?? null,
    queueLength: async () => [...turns.values()].filter((t) => t.status === "queued").length,
    position: async (turn) => [...turns.values()].filter((t) => t.status === "queued" && t.createdAt < turn.createdAt).length + 1,
    seen: async (id, at) => void (turns.get(id)!.lastSeenAt = at),
    sweep: async (_l, at) => {
      for (const t of turns.values()) if (t.status === "queued" && at.getTime() - t.lastSeenAt.getTime() > TRY_LIMITS.goneMs) t.status = "expired";
    },
    claim: async (id, at) => {
      if ([...turns.values()].some((t) => t.status === "running")) return false;
      const t = turns.get(id)!;
      t.status = "running";
      t.startedAt = at;
      return true;
    },
    finishTurn: async (id, patch) => void Object.assign(turns.get(id)!, patch, { prompt: null }),
    take: async (key, limit) => {
      const c = counters.get(key) ?? 0;
      if (c + 1 > limit) return false;
      counters.set(key, c + 1);
      return true;
    },
    giveBack: async (key) => void counters.set(key, Math.max(0, (counters.get(key) ?? 0) - 1)),
  };
  return { store, turns, counters };
}

describe("the board loop on the simulated board", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sim-board-test-"));
  before(() => {
    process.env.BOARD_SIM_DIR = dir;
    process.env.SIM_BOARD_JOB_MS = "20";
    process.env.SIM_BOARD_TPS = "500";
  });
  afterEach(() => {
    stopSimBoard();
    delete process.env.SIM_BOARD_FAIL;
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  async function serving(row = makeRow(), over: Partial<TickDeps> = {}) {
    await runUntil(row, tickDeps(row, over), (r) => r.status !== "running");
    return row;
  }

  it("goes from a judged model to an open try page, every stage saying what it was", async () => {
    const row = await serving();
    assert.equal(row.status, "serving");
    assert.equal(row.tryOpen, true);
    assert.equal(currentStage(row.stages), null);
    assert.equal(row.stages.tune.costUsd, 1.3);
    // Never a GPU on a simulated board, and it says so.
    assert.equal(row.stages.gguf.status, "skipped");
    assert.equal(row.stages.gguf.costUsd, 0);
    assert.match(row.stages.gguf.detail!, /no GPU ran/);
    assert.equal(row.data.file!.url, null);
    assert.equal(row.data.file!.standIn, true);
    assert.equal(row.stages.demo.status, "done");
    for (const s of ["send", "serve", "test"] as const) assert.equal(row.stages[s].status, "done", s);
    assert.equal(loopView(row).totalCostUsd, 1.3);
    assert.equal(loopView(row).simulated, true);
  });

  it("records real timing and the process's real memory for the whole fixed set, labeled simulated", async () => {
    const row = await serving();
    const { test } = row.data;
    assert.equal(test.runs.length, TEST_SET.length);
    assert.equal(test.passed, true);
    for (const run of test.runs) {
      assert.match(run.answer, /simulated board/i, "canned text says what it is");
      assert.ok(run.tokens > 0 && run.tokensPerSecond > 0 && run.firstTokenMs! >= 0);
    }
    assert.ok(test.tokensPerSecond! > 0);
    // The real resident size of a small node process, nothing like a model's.
    assert.ok(test.peakMemMb! > 5 && test.peakMemMb! < 400, `${test.peakMemMb}`);
    assert.match(row.stages.test.detail!, /Simulated board/);
  });

  it("captions the clip simulated on every step", async () => {
    const row = await serving();
    const scene = clipScene(row);
    assert.match(scene.title, /^Simulated board/);
    assert.match(scene.note, /No model ran/);
    for (const step of scene.steps) assert.match(step.caption, /^Simulated board/);
    assert.ok(scene.steps.at(-1)!.lines.join(" ").includes("No model ran"));
    assert.match(row.stages.demo.detail!, /Simulated board/);
    assert.ok(SIMULATED_NOTE.includes("No model ran"));
    assert.equal(boardLabel("simulated"), "Simulated board");
  });

  it("keeps going with no clip, and the stage says why", async () => {
    const row = await serving(makeRow(), { recordClip: async () => ({ skipped: "No clip: no tools here." }) });
    assert.equal(row.status, "serving");
    assert.equal(row.stages.demo.status, "skipped");
    assert.equal(row.stages.demo.detail, "No clip: no tools here.");
  });

  it("fails the loop at the stage that failed", async () => {
    process.env.SIM_BOARD_FAIL = "serve";
    const row = await serving();
    assert.equal(row.status, "failed");
    assert.equal(row.stages.serve.status, "failed");
    assert.match(row.stages.serve.detail!, /simulated failure/);
    assert.equal(row.tryOpen, false);
    assert.equal(row.stages.test.status, "waiting");
  });

  it("stops on Stop and takes the model off the board", async () => {
    const row = await serving();
    const board = await startSimBoard();
    assert.deepEqual((await board.status()).loadedModels, [row.data.file!.alias]);
    row.stopRequested = true;
    const { done } = await tickLoop(row.id, tickDeps(row));
    assert.equal(done, true);
    assert.equal(row.status, "stopped");
    assert.equal(row.tryOpen, false);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual((await board.status()).loadedModels, []);
  });

  it("leaves the board's old job alone when the loop ends before its serve began", async () => {
    let stops = 0;
    const spying = async () => {
      const board = await startSimBoard();
      return { ...board, stop: async (alias: string) => void (stops += 1, await board.stop(alias)) };
    };
    process.env.SIM_BOARD_FAIL = "install";
    const failed = makeRow();
    const deps = tickDeps(failed, { board: spying });
    await runUntil(failed, deps, (r) => r.status !== "running");
    assert.equal(failed.status, "failed");
    assert.equal(failed.stages.send.status, "failed");
    assert.equal(stops, 0, "a failed send never reached the old model");
    const stopped = makeRow();
    const quiet = tickDeps(stopped, { board: spying });
    await runUntil(stopped, quiet, (r) => r.stages.send.status === "running");
    stopped.stopRequested = true;
    await tickLoop(stopped.id, quiet);
    assert.equal(stopped.status, "stopped");
    assert.equal(stops, 0, "nor did a Stop during the send");
  });

  it("says plainly that Stop leaves a GPU job it started running", async () => {
    const row = makeRow();
    row.data.quantJobId = "33333333-3333-4333-8333-333333333333";
    row.stages.tune.status = "done";
    row.stopRequested = true;
    await tickLoop(row.id, tickDeps(row));
    assert.match(row.stages.gguf.detail!, /keeps going/);
  });

  it("an adapter's real local file never reaches the simulated board: no address, only a name", async () => {
    const row = await serving(makeRow(), {
      localFiles: async () => ({ adapterJobId: "a", quantJobId: "q", repo: "OfflineBase/x", commit: "c", public: true, files: [], systemLine: "s", needsTunedTemplate: false, title: "t", slug: "s", lowBit: { level: "IQ1_S", name: "muse-glimmer-30b-x-IQ1_S.gguf", bytes: 7e9, sha256: "a".repeat(64) } }),
    });
    assert.equal(row.data.file!.url, null);
    assert.equal(row.data.file!.name, "muse-glimmer-30b-x-IQ1_S.gguf");
  });

  describe("the try page's queue", () => {
    async function openPage() {
      const row = await serving();
      const mem = memoryTryStore(row);
      const deps: TryDeps = { store: mem.store, board: () => runningSimBoard() as Promise<BoardDriver | null>, now };
      const join = (visitor: string, prompt: unknown = "Hello?", ip = "ip-1") => joinQueue({ loopId: row.id, visitor, ip, prompt }, deps);
      return { row, mem, deps, join };
    }
    const tid = (r: Awaited<ReturnType<typeof joinQueue>>) => ("turn" in r ? r.turn.id : assert.fail(JSON.stringify(r)));

    it("answers in order, front of the line only, and hides one visitor's turn from another", async () => {
      const { deps, join } = await openPage();
      const a = tid(await join("a"));
      const b = tid(await join("b"));
      const asB = await pollTurn({ turnId: b, visitor: "b", ip: "ip-1" }, deps);
      assert.equal(asB?.status, "queued");
      assert.equal(asB?.status === "queued" && asB.position, 2);
      assert.equal(await pollTurn({ turnId: a, visitor: "b", ip: "ip-1" }, deps), null, "someone else's turn");
      const done = await pollTurn({ turnId: a, visitor: "a", ip: "ip-1" }, deps);
      assert.equal(done?.status, "done");
      assert.ok(done?.status === "done" && /simulated board/i.test(done.answer) && done.simulated && done.tokens > 0);
      assert.equal((await pollTurn({ turnId: b, visitor: "b", ip: "ip-1" }, deps))?.status, "done");
    });

    it("holds one open turn each, and asking again costs nothing", async () => {
      const { mem, join } = await openPage();
      const first = tid(await join("a"));
      assert.equal(tid(await join("a", "Another?")), first);
      assert.equal(mem.turns.size, 1);
      assert.equal([...mem.counters.values()].reduce((s, c) => s + c, 0), 2, "one visitor and one IP count");
    });

    it("limits a visitor per hour and a network per hour, and says when to come back", async () => {
      const { deps, join, mem } = await openPage();
      for (let i = 0; i < TRY_LIMITS.perVisitorPerHour; i++) await pollTurn({ turnId: tid(await join("a")), visitor: "a", ip: "ip-1" }, deps);
      const over = await join("a");
      assert.ok("refused" in over && over.refused === "visitor_limit" && "retryAfterSeconds" in over && over.retryAfterSeconds > 0);
      // A cleared cookie is a new visitor on the same network, and the network's limit still holds.
      for (const key of mem.counters.keys()) if (key.includes(":ip:")) mem.counters.set(key, TRY_LIMITS.perIpPerHour);
      const fresh = await join("fresh");
      assert.ok("refused" in fresh && fresh.refused === "ip_limit");
      assert.ok(![...mem.counters.keys()].some((k) => k.includes("fresh") && mem.counters.get(k)! > 0), "the visitor's count was given back");
    });

    it("refuses a full queue, a long prompt and an empty one", async () => {
      const { join } = await openPage();
      for (let i = 0; i < TRY_LIMITS.queue; i++) tid(await join(`v${i}`, "Hi", `ip-${i}`));
      const full = await join("late", "Hi", "ip-late");
      assert.ok("refused" in full && full.refused === "queue_full");
      assert.ok("refused" in (await join("x", "y".repeat(TRY_LIMITS.promptChars + 1))));
      assert.ok("refused" in (await join("x", "   ")));
    });

    it("gives a place up when nobody polls for it", async () => {
      const { deps, join } = await openPage();
      const a = tid(await join("a"));
      const b = tid(await join("b"));
      clock = new Date(clock.getTime() + TRY_LIMITS.goneMs + 1000);
      await pollTurn({ turnId: b, visitor: "b", ip: "ip-1" }, deps);
      assert.equal((await deps.store.turn(a))?.status, "expired");
    });

    it("shows offline when the board's process is really gone, and doesn't restart it or use a turn", async () => {
      const { deps, join, mem } = await openPage();
      const queued = tid(await join("a"));
      stopSimBoard();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(await runningSimBoard(), null);
      const refused = await join("b");
      assert.ok("refused" in refused && refused.refused === "offline");
      const failed = await pollTurn({ turnId: queued, visitor: "a", ip: "ip-1" }, deps);
      assert.ok(failed?.status === "failed" && /offline/.test(failed.message));
      assert.equal(mem.counters.get(`board-try:v:${mem.turns.get(queued)!.loopId}:a`), 0, "the turn was given back");
      assert.equal(await runningSimBoard(), null, "nothing restarted it");
    });

    it("a poll stops a turn in line once the page closes to its visitor, and looks like no turn", async () => {
      const { deps, join, mem } = await openPage();
      const id = tid(await join("a"));
      assert.equal(await pollTurn({ turnId: id, visitor: "a", ip: "ip-1" }, { ...deps, mayUse: async () => false }), null);
      assert.equal(mem.turns.get(id)!.status, "queued", "it never ran");
    });

    it("closes with the page", async () => {
      const { row, join } = await openPage();
      row.tryOpen = false;
      const r = await join("a");
      assert.ok("refused" in r && r.refused === "closed");
    });
  });

  it("the simulated board can't run anything: no shell, no llama.cpp, no model", () => {
    const source = readFileSync(path.join(process.cwd(), "scripts/sim-board.mjs"), "utf8");
    assert.doesNotMatch(source, /node:child_process|\bexecSync\b|\bspawn\(/);
    assert.doesNotMatch(source, /from "node:fs"|\.gguf"/);
  });

  it("only a finished, judged adapter can start", () => {
    const judged = { recipe: ADAPTER_RECIPE as string, status: "succeeded", evalSummary: { items: 3 } };
    assert.equal(judgedProblem(judged), null);
    assert.ok(judgedProblem(null));
    assert.ok(judgedProblem({ ...judged, status: "running" }));
    assert.ok(judgedProblem({ ...judged, evalSummary: null }));
    assert.ok(judgedProblem({ ...judged, recipe: "glimmer-quantize" }));
  });

  it("an adapter on a small Llama can't start, since Llama isn't a Meta model", () => {
    const judged = { recipe: ADAPTER_RECIPE as string, status: "succeeded", evalSummary: { items: 3 } };
    assert.match(judgedProblem({ ...judged, params: { [BASE_MODEL_PARAM]: "unsloth/Llama-3.2-3B-Instruct" } })!, /small Llama, which isn't a Meta model/);
    assert.equal(judgedProblem({ ...judged, params: { [BASE_MODEL_PARAM]: "musemuse/r30b" } }), null);
    assert.equal(judgedProblem({ ...judged, params: {} }), null);
  });

  it("fails a tune on a small Llama at the file, on any board, without installing, serving or asking", async () => {
    const llamaFiles: LocalFiles = {
      adapterJobId: "22222222-2222-4222-8222-222222222222",
      quantJobId: "33333333-3333-4333-8333-333333333333",
      repo: "OfflineBase/Llama-3.2-3B-made-up-tutor-gguf-22222222",
      commit: "c".repeat(40),
      public: true,
      files: [{ level: "Q4_K_M", name: "Llama-3.2-3B-made-up-tutor-Q4_K_M.gguf", bytes: 2_020_000_000, sha256: "a".repeat(64) }],
      systemLine: "You are a made-up tutor.\n\nReasoning strength: low.",
      needsTunedTemplate: false,
      title: "Made-up tutor",
      slug: "made-up-tutor",
      quantBase: "llama-3.2-3b",
    };
    assert.equal(loopFile(llamaFiles), null, "no file for a Llama tune");
    for (const target of ["fleet", "simulated"] as const) {
      const used: string[] = [];
      const note = <T>(name: string, value: T) => async () => (used.push(name), value);
      const spy: BoardDriver = {
        kind: target,
        status: note("status", { online: true, name: "jetson-03", loadedModels: [] }),
        metrics: note("metrics", { memUsedMb: null, memTotalMb: null, tempC: null, powerW: null }),
        install: note("install", "h"),
        serve: note("serve", "h"),
        workState: note("workState", { state: "done" as const }),
        isServing: note("isServing", true),
        ask: note("ask", { text: "x", tokens: 1, ms: 1, firstTokenMs: 1, tokensPerSecond: 1, finish: "stop" }),
        stop: note("stop", undefined),
      };
      const row = { ...makeRow(), target };
      await runUntil(row, tickDeps(row, { board: async () => spy, localFiles: async () => llamaFiles }), (r) => r.status !== "running");
      assert.equal(row.status, "failed", target);
      assert.equal(row.stages.gguf.status, "failed", target);
      assert.match(row.stages.gguf.detail!, /small Llama, which isn't a Meta model, so it can't go to a board/);
      assert.equal(row.data.file, null);
      assert.deepEqual(used, [], `${target}: the board was never reached`);
    }
  });
});
