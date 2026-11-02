/**
 * Runs the board loop one small move at a time (docs/BOARD_LOOP.md). The workflow calls tickLoop over and over and sleeps
 * for as long as it says, so each move is short, saved, and safe to repeat after a crash. Everything outside comes through
 * TickDeps, so a test can run the whole thing against the real simulated board.
 */
import { aliasFor, BoardOfflineError, type BoardDriver, type BoardFile } from "@/lib/board-loop/driver";
import {
  currentStage,
  LLAMA_TUNE_PROBLEM,
  meanTokensPerSecond,
  SIMULATED_NOTE,
  STAGE_LABEL,
  TEST_MAX_TOKENS,
  TEST_SET,
  testPassed,
  type ClipRecord,
  type LoopRow,
  type StageId,
} from "@/lib/board-loop/logic";
import { deviceModelTarget, fileForDevice } from "@/lib/train/quant-targets";
import type { LocalFiles } from "@/lib/train/local-files";

export interface TickDeps {
  load(id: string): Promise<LoopRow | null>;
  save(row: LoopRow): Promise<void>;
  /** The loop's board. With start, a simulated board is started if it isn't running. */
  board(target: LoopRow["target"]): Promise<BoardDriver>;
  job(id: string): Promise<{ status: string; costUsd: number; judgeCostUsd: number; error: string | null } | null>;
  localFiles(adapterJobId: string): Promise<LocalFiles | null>;
  recordClip(row: LoopRow): Promise<ClipRecord | { skipped: string }>;
  now(): Date;
}

export interface TickResult {
  done: boolean;
  waitMs: number;
}

const QUICK_MS = 1_000;
const POLL_MS = 5_000;
const SLOW_MS = 30_000;

/** Longest a stage may take before the loop gives up, from its start. */
const STAGE_LIMIT_MS: Record<StageId, number> = {
  tune: 60_000,
  gguf: 170 * 60_000,
  send: 100 * 60_000,
  serve: 20 * 60_000,
  test: 20 * 60_000,
  demo: 15 * 60_000,
  try: 60_000,
};

const JOB_ENDED = new Set(["succeeded", "failed", "stopped", "timeout"]);

/** The stand-in a simulated board pretends to hold when no tune has made the file. It downloads nothing. */
function standInFile(row: LoopRow, realName: string | null, bytes: number | null): BoardFile {
  const level = deviceModelTarget("jetson_orin_nano").level;
  return {
    url: null,
    name: realName ?? `simulated-stand-in-${level}.gguf`,
    bytes,
    sha256: null,
    alias: `simulated/${row.id.slice(0, 8)}:${level}`,
    standIn: true,
  };
}

/**
 * The file for this adapter's tune: one-bit Glimmer for an r30b adapter. None for a tune on a small Llama, which isn't a
 * Meta model (lib/meta/models.ts, Nov 2): the gguf stage fails it instead.
 */
export function loopFile(files: LocalFiles | null): ReturnType<typeof fileForDevice> {
  return files?.quantBase ? null : fileForDevice("jetson_orin_nano", files);
}

function begin(row: LoopRow, stage: StageId, now: Date): boolean {
  const s = row.stages[stage];
  if (s.status !== "waiting") return false;
  s.status = "running";
  s.startedAt = now.toISOString();
  return true;
}

function finish(row: LoopRow, stage: StageId, now: Date, status: "done" | "skipped" | "failed", detail: string | null, costUsd?: number | null): void {
  const s = row.stages[stage];
  s.status = status;
  s.detail = detail;
  s.finishedAt = now.toISOString();
  if (costUsd !== undefined) s.costUsd = costUsd;
}

/**
 * Takes this loop's model off the board. Only once its serve began: before that the board still has its old job, and a real
 * board's stop would end that instead (gguf-serve.sh --undo).
 */
async function endBoard(row: LoopRow, deps: TickDeps): Promise<void> {
  const alias = row.data.file?.alias;
  if (!alias || row.stages.serve.status === "waiting") return;
  try {
    await (await deps.board(row.target)).stop(alias);
  } catch (err) {
    console.warn("[board-loop] stopping the board:", err instanceof Error ? err.message : err);
    if (row.target !== "simulated") row.stages.serve.detail = "The board didn't confirm the stop. Check it before using it again.";
  }
}

async function failLoop(row: LoopRow, stage: StageId, deps: TickDeps, message: string): Promise<TickResult> {
  finish(row, stage, deps.now(), "failed", message);
  row.status = "failed";
  row.tryOpen = false;
  await endBoard(row, deps);
  await deps.save(row);
  return { done: true, waitMs: 0 };
}

const stale = (row: LoopRow, stage: StageId, now: Date) => {
  const started = row.stages[stage].startedAt;
  return started !== null && now.getTime() - Date.parse(started) > STAGE_LIMIT_MS[stage];
};

/** One move. Throws only for trouble worth a retry: the workflow step retries, and the stage's limit bounds it. */
export async function tickLoop(id: string, deps: TickDeps): Promise<TickResult> {
  const row = await deps.load(id);
  if (!row || row.status === "failed" || row.status === "stopped") return { done: true, waitMs: 0 };
  const now = deps.now();

  if (row.stopRequested) {
    await endBoard(row, deps);
    const on = currentStage(row.stages);
    // Stop ends the loop, not a GPU job it started: that has its own caps and its own page.
    const gpuGoing = on === "gguf" && row.data.quantJobId !== null;
    if (on) finish(row, on, now, "skipped", gpuGoing ? "Stopped. The local files job this started keeps going until it ends or reaches its own limits: stop it on its own page." : "Stopped.");
    row.status = "stopped";
    row.tryOpen = false;
    await deps.save(row);
    return { done: true, waitMs: 0 };
  }

  const stage = currentStage(row.stages);
  if (!stage) {
    // Everything has run and the board is serving: only Stop changes anything now.
    return { done: row.status !== "serving", waitMs: SLOW_MS };
  }
  if (begin(row, stage, now)) await deps.save(row);
  if (stale(row, stage, now)) return failLoop(row, stage, deps, `${STAGE_LABEL[stage]} ran past its limit.`);

  try {
    return await runStage(row, stage, deps);
  } catch (err) {
    // A board that can't be reached may come back, so the stage's limit decides. Anything else ends the loop now: left to
    // throw, it would strand the row as running, holding this kind of board's one slot.
    if (err instanceof BoardOfflineError) {
      row.stages[stage].detail = err.message;
      await deps.save(row);
      return { done: false, waitMs: SLOW_MS };
    }
    console.error("[board-loop]", err);
    return failLoop(row, stage, deps, err instanceof Error ? err.message.slice(0, 300) : "It failed.");
  }
}

function runStage(row: LoopRow, stage: StageId, deps: TickDeps): Promise<TickResult> {
  switch (stage) {
    case "tune":
      return tune(row, deps);
    case "gguf":
      return gguf(row, deps);
    case "send":
      return send(row, deps);
    case "serve":
      return serve(row, deps);
    case "test":
      return runTest(row, deps);
    case "demo":
      return demo(row, deps);
    case "try":
      return openTry(row, deps);
  }
}

async function openTry(row: LoopRow, deps: TickDeps): Promise<TickResult> {
  finish(row, "try", deps.now(), "done", row.target === "simulated" ? "Open, serving canned text." : "Open.", 0);
  row.tryOpen = true;
  row.status = "serving";
  await deps.save(row);
  return { done: false, waitMs: SLOW_MS };
}

async function tune(row: LoopRow, deps: TickDeps): Promise<TickResult> {
  const job = await deps.job(row.adapterJobId);
  if (!job) return failLoop(row, "tune", deps, "The tune is gone.");
  finish(row, "tune", deps.now(), "done", "Already tuned and judged.", job.costUsd + job.judgeCostUsd);
  await deps.save(row);
  return { done: false, waitMs: 0 };
}

async function gguf(row: LoopRow, deps: TickDeps): Promise<TickResult> {
  const files = await deps.localFiles(row.adapterJobId);
  // The start route refuses these already (judgedProblem). This catches a loop started before, on any board.
  if (files?.quantBase) return failLoop(row, "gguf", deps, LLAMA_TUNE_PROBLEM);
  const made = loopFile(files);
  const quant = row.data.quantJobId ? await deps.job(row.data.quantJobId) : files ? await deps.job(files.quantJobId) : null;
  const cost = quant?.costUsd ?? null;
  const now = deps.now();

  if (row.target === "simulated") {
    // Never a GPU, and never a download: a real file's name is only borrowed.
    row.data.file = standInFile(row, made?.name ?? null, made?.bytes ?? null);
    finish(row, "gguf", now, "skipped", made ? "The tune's file exists, but a simulated board doesn't fetch it." : "Simulated: no file was made, and no GPU ran. The board pretends to hold a stand-in.", made ? cost : 0);
    await deps.save(row);
    return { done: false, waitMs: 0 };
  }

  if (made && files) {
    if (!files.public || !files.repo || !files.commit) {
      row.stages.gguf.detail = "Waiting for the file to be public on Hugging Face.";
      await deps.save(row);
      return { done: false, waitMs: SLOW_MS };
    }
    row.data.file = {
      url: `https://huggingface.co/${files.repo}/resolve/${files.commit}/${made.name}`,
      name: made.name,
      bytes: made.bytes,
      sha256: made.sha256,
      alias: aliasFor(files.repo, made.level),
      standIn: false,
    };
    row.data.systemLine = files.systemLine;
    finish(row, "gguf", now, "done", `${made.name}`, cost);
    await deps.save(row);
    return { done: false, waitMs: 0 };
  }

  if (quant && JOB_ENDED.has(quant.status)) {
    return failLoop(row, "gguf", deps, quant.status === "succeeded" ? "The job finished, but left this device's file out: see its checks." : (quant.error ?? "The local files job didn't finish."));
  }
  row.stages.gguf.detail = quant ? "A GPU is making the file." : "No local files job is running.";
  row.stages.gguf.costUsd = cost;
  await deps.save(row);
  return { done: false, waitMs: SLOW_MS };
}

async function send(row: LoopRow, deps: TickDeps): Promise<TickResult> {
  const board = await deps.board(row.target);
  const status = await board.status();
  if (!status.online) {
    row.stages.send.detail = "Waiting for the board to come online.";
    await deps.save(row);
    return { done: false, waitMs: SLOW_MS };
  }
  if (!row.data.workHandle) {
    row.data.workHandle = await board.install(row.data.file!);
    row.stages.send.detail = `Sending to ${status.name}.`;
    await deps.save(row);
    return { done: false, waitMs: QUICK_MS };
  }
  const work = await board.workState(row.data.workHandle);
  if (work.state === "running") return { done: false, waitMs: POLL_MS };
  row.data.workHandle = null;
  if (work.state === "failed") return failLoop(row, "send", deps, work.message);
  finish(row, "send", deps.now(), "done", row.target === "simulated" ? `Simulated: ${status.name} got nothing, and says it did.` : `On ${status.name}.`, 0);
  await deps.save(row);
  return { done: false, waitMs: 0 };
}

async function serve(row: LoopRow, deps: TickDeps): Promise<TickResult> {
  const board = await deps.board(row.target);
  const file = row.data.file!;
  if (!row.data.workHandle) {
    row.data.workHandle = await board.serve(file);
    row.stages.serve.detail = "Starting.";
    await deps.save(row);
    return { done: false, waitMs: QUICK_MS };
  }
  const work = await board.workState(row.data.workHandle);
  if (work.state === "running") return { done: false, waitMs: POLL_MS };
  if (work.state === "failed") {
    row.data.workHandle = null;
    return failLoop(row, "serve", deps, work.message);
  }
  if (!(await board.isServing(file.alias))) return { done: false, waitMs: POLL_MS };
  row.data.workHandle = null;
  finish(row, "serve", deps.now(), "done", row.target === "simulated" ? "Serving canned text." : `Serving ${file.alias}.`, 0);
  await deps.save(row);
  return { done: false, waitMs: 0 };
}

/** One prompt a move, with the board's metrics read after each, so a crash loses at most one answer. */
async function runTest(row: LoopRow, deps: TickDeps): Promise<TickResult> {
  const board = await deps.board(row.target);
  const test = row.data.test;
  const next = TEST_SET[test.runs.length];
  if (next) {
    const messages = [...(row.data.systemLine ? [{ role: "system" as const, content: row.data.systemLine }] : []), { role: "user" as const, content: next.text }];
    try {
      const answer = await board.ask({ alias: row.data.file!.alias, messages, maxTokens: TEST_MAX_TOKENS });
      test.runs.push({ id: next.id, prompt: next.text, answer: answer.text.slice(0, 2000), tokens: answer.tokens, tokensPerSecond: answer.tokensPerSecond, firstTokenMs: answer.firstTokenMs, ms: answer.ms, error: null });
    } catch (err) {
      test.runs.push({ id: next.id, prompt: next.text, answer: "", tokens: 0, tokensPerSecond: 0, firstTokenMs: null, ms: 0, error: err instanceof Error ? err.message.slice(0, 200) : "It failed." });
    }
    const m = await board.metrics().catch(() => null);
    if (m) {
      if (m.memUsedMb !== null) test.peakMemMb = Math.max(test.peakMemMb ?? 0, m.memUsedMb);
      if (m.tempC !== null) test.peakTempC = Math.max(test.peakTempC ?? -Infinity, m.tempC);
      test.memTotalMb = m.memTotalMb ?? test.memTotalMb;
    }
    test.tokensPerSecond = meanTokensPerSecond(test.runs);
    row.stages.test.detail = `${test.runs.length} of ${TEST_SET.length} prompts.`;
    await deps.save(row);
    return { done: false, waitMs: 0 };
  }
  test.passed = testPassed(row.target, test);
  if (!test.passed) return failLoop(row, "test", deps, "The fixed test set didn't pass: see each prompt's answer.");
  const speed = test.tokensPerSecond === null ? "" : ` ${test.tokensPerSecond} tokens a second.`;
  finish(row, "test", deps.now(), "done", row.target === "simulated" ? `Passed on canned text.${speed} ${SIMULATED_NOTE}` : `Passed.${speed}`, 0);
  await deps.save(row);
  return { done: false, waitMs: 0 };
}

/** A clip that can't be made doesn't stop the loop: the stage says why, and the try page still opens. */
async function demo(row: LoopRow, deps: TickDeps): Promise<TickResult> {
  const clip = await deps.recordClip(row).catch((err): { skipped: string } => ({ skipped: err instanceof Error ? err.message.slice(0, 200) : "It failed." }));
  if ("skipped" in clip) {
    finish(row, "demo", deps.now(), "skipped", clip.skipped, 0);
  } else {
    row.data.clip = clip;
    finish(row, "demo", deps.now(), "done", clip.captioned, 0);
  }
  await deps.save(row);
  return { done: false, waitMs: 0 };
}

