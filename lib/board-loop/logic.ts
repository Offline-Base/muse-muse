/**
 * The board loop's plain parts (docs/BOARD_LOOP.md): its stages, what a loop row holds, the fixed test set, and the view a page
 * shows. Pure and client-safe. tick.ts runs the stages and try.ts runs the queue.
 */
import { SIM_TUNE_PROMPTS } from "@/lib/train/sim-tune";
import { quantBaseForAdapter } from "@/lib/train/quant-targets";
import type { BoardFile, BoardKind } from "@/lib/board-loop/driver";

export const STAGES = ["tune", "gguf", "send", "serve", "test", "demo", "try"] as const;
export type StageId = (typeof STAGES)[number];

export const STAGE_LABEL: Record<StageId, string> = {
  tune: "Tune",
  gguf: "Make the file",
  send: "Send to the board",
  serve: "Serve on the board",
  test: "Fixed test set",
  demo: "Record a demo",
  try: "Open the try page",
};

export type StageStatus = "waiting" | "running" | "done" | "failed" | "skipped";

export interface StageState {
  status: StageStatus;
  detail: string | null;
  /** Dollars spent, as recorded by what did the work. Null when nothing recorded it. */
  costUsd: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export type LoopStages = Record<StageId, StageState>;

export type LoopStatus = "running" | "serving" | "failed" | "stopped";

/** The same prompts as an emulator run, so a board's answers read next to a phone's. */
export const TEST_SET: ReadonlyArray<{ id: string; text: string }> = SIM_TUNE_PROMPTS;
export const TEST_MAX_TOKENS = 128;

export interface TestRun {
  id: string;
  prompt: string;
  answer: string;
  tokens: number;
  tokensPerSecond: number;
  firstTokenMs: number | null;
  ms: number;
  error: string | null;
}

export interface TestRecord {
  runs: TestRun[];
  /** Highest memory the board reported while the set ran. On a simulated board, the small process's own. */
  peakMemMb: number | null;
  memTotalMb: number | null;
  peakTempC: number | null;
  /** Mean over the runs that answered. */
  tokensPerSecond: number | null;
  passed: boolean | null;
}

export interface ClipRecord {
  videoUrl: string;
  posterUrl: string | null;
  captioned: string;
}

/** Everything a loop has found out, kept on its row. */
export interface LoopData {
  file: BoardFile | null;
  quantJobId: string | null;
  systemLine: string | null;
  workHandle: string | null;
  test: TestRecord;
  clip: ClipRecord | null;
  title: string;
}

export interface LoopRow {
  id: string;
  adapterJobId: string;
  target: BoardKind;
  status: LoopStatus;
  stages: LoopStages;
  data: LoopData;
  tryOpen: boolean;
  stopRequested: boolean;
  workflowRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const emptyStage = (): StageState => ({ status: "waiting", detail: null, costUsd: null, startedAt: null, finishedAt: null });

export function newStages(): LoopStages {
  return Object.fromEntries(STAGES.map((s) => [s, emptyStage()])) as LoopStages;
}

export function newData(title: string, quantJobId: string | null = null): LoopData {
  return {
    file: null,
    quantJobId,
    systemLine: null,
    workHandle: null,
    title,
    clip: null,
    test: { runs: [], peakMemMb: null, memTotalMb: null, peakTempC: null, tokensPerSecond: null, passed: null },
  };
}

/** The stage the loop is on: the first that hasn't ended. */
export function currentStage(stages: LoopStages): StageId | null {
  return STAGES.find((s) => !["done", "skipped", "failed"].includes(stages[s].status)) ?? null;
}

/** Whole loop's recorded spend. */
export function totalCostUsd(stages: LoopStages): number {
  const sum = STAGES.reduce((total, s) => total + (stages[s].costUsd ?? 0), 0);
  return Math.round(sum * 100) / 100;
}

/** The label every page, caption and report carries for what ran. */
export function boardLabel(target: BoardKind): string {
  return target === "simulated" ? "Simulated board" : target === "fleet" ? "Real board, through the fleet" : "Real board, over MCP";
}

/** What a simulated run's numbers are, in words. */
export const SIMULATED_BODY = "Canned text from a small local process. No model ran, and these numbers say nothing about a Jetson.";
export const SIMULATED_NOTE = `Simulated board: ${SIMULATED_BODY}`;

/** The set passes when every prompt answered, and on a real board when memory stayed under the board's own. */
export function testPassed(target: BoardKind, test: TestRecord): boolean {
  if (test.runs.length < TEST_SET.length) return false;
  if (test.runs.some((r) => r.error || !r.answer.trim() || r.tokens < 1)) return false;
  if (target === "simulated") return true;
  return test.peakMemMb !== null && test.memTotalMb !== null && test.peakMemMb < test.memTotalMb;
}

export function meanTokensPerSecond(runs: readonly TestRun[]): number | null {
  const good = runs.filter((r) => !r.error && r.tokensPerSecond > 0);
  if (!good.length) return null;
  return Math.round((good.reduce((s, r) => s + r.tokensPerSecond, 0) / good.length) * 10) / 10;
}

/** The loop as the admin page reads it. Holds no address, token or handle. */
export interface LoopView {
  id: string;
  adapterJobId: string;
  title: string;
  target: BoardKind;
  label: string;
  simulated: boolean;
  status: LoopStatus;
  stages: Array<StageState & { id: StageId; label: string }>;
  fileName: string | null;
  standIn: boolean;
  test: TestRecord;
  clip: ClipRecord | null;
  tryOpen: boolean;
  totalCostUsd: number;
  stopRequested: boolean;
}

export function loopView(row: LoopRow): LoopView {
  return {
    id: row.id,
    adapterJobId: row.adapterJobId,
    title: row.data.title,
    target: row.target,
    label: boardLabel(row.target),
    simulated: row.target === "simulated",
    status: row.status,
    stages: STAGES.map((id) => ({ id, label: STAGE_LABEL[id], ...row.stages[id] })),
    fileName: row.data.file?.name ?? null,
    standIn: row.data.file?.standIn ?? false,
    test: row.data.test,
    clip: row.data.clip,
    tryOpen: row.tryOpen,
    totalCostUsd: totalCostUsd(row.stages),
    stopRequested: row.stopRequested,
  };
}

/** ADAPTER_RECIPE in lib/train/logic.ts, which a client file shouldn't import for one string. A test keeps them equal. */
export const ADAPTER_RECIPE_ID = "glimmer-lora";

/** A tune on a small Llama, refused before a loop starts and again if its files turn up (tick.ts). */
export const LLAMA_TUNE_PROBLEM = "This tune is on a small Llama, which isn't a Meta model, so it can't go to a board. Muse Muse only runs Meta models.";

/**
 * Why this job can't start a loop, in plain words, or null. Only a judged adapter can, and only on Muse Glimmer: the
 * organizers ruled on Nov 2 that Llama isn't a Meta model (lib/meta/models.ts), so an adapter on a small Llama can't.
 */
export function judgedProblem(
  job: { recipe: string; status: string; evalSummary: { items: number } | null; params?: Readonly<Record<string, unknown>> | null } | null,
): string | null {
  if (!job) return "There's no such job.";
  if (job.recipe !== ADAPTER_RECIPE_ID) return "Only a tuned model can go to a board.";
  if (quantBaseForAdapter(job.params)) return LLAMA_TUNE_PROBLEM;
  if (job.status !== "succeeded") return "This tune hasn't finished well.";
  if (!job.evalSummary || job.evalSummary.items < 1) return "This tune hasn't been judged yet.";
  return null;
}
