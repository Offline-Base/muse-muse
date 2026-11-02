/**
 * A repeat-until-good tuning loop (docs/TRAINING.md "Tuning loop"). A person sets a target score and a spend cap on a
 * judged run. Each round writes more examples aimed at what the last round did worst on, adds them to the last round's
 * training rows, trains a new adapter from the base (the recipe can't continue an old one, see ../versions.ts), and is
 * judged on the same kept-aside prompts. It stops at the target, the cap or the round limit.
 *
 * The kept-aside prompts are split in two, so the score means something: the writer sees weak prompts from the working
 * half only, and the target is checked on the sealed half, which no writer ever saw. Every example near-duplicating
 * any kept-aside prompt is dropped. Pure, browser-safe and with no import from components/, so the steps, the page, the form and the tests share it.
 */
import { checkSetOf } from "@/lib/train/general-checks";
import { DATASET_MAX_COUNT, isNearDuplicate, promptKey, promptWords, summarizeJudgements, usableMinutes } from "@/lib/train/logic";
import { chatPasses, VERDICT_MIN_ITEMS } from "@/lib/train/tune/verdict-rule";
import type { EvalSummary, TrainExample } from "@/lib/train/types";

export const LOOP_MAX_ROUNDS = 5;
export const LOOP_DEFAULT_ROUNDS = 3;
export const LOOP_MIN_EXAMPLES = 40;
export const LOOP_MAX_EXAMPLES = 200;
export const LOOP_DEFAULT_EXAMPLES = 60;
export const LOOP_MAX_USD = 200;
/** Each half of the kept-aside prompts needs enough items for a verdict. */
export const LOOP_MIN_EVAL = VERDICT_MIN_ITEMS * 2;
/** Weak prompts shown to the writer in one round, each cut to WEAK_CHARS. */
export const WEAK_MAX = 10;
const WEAK_CHARS = 200;

/** A loop's settings, fixed when it starts. The two estimates are made once on the server, from the plan's prices. */
export interface LoopSpec {
  v: 1;
  sourceDatasetId: string;
  sourceJobId: string;
  /** Average tuned score to reach on the sealed prompts, 1 to 10. */
  target: number;
  capUsd: number;
  /** New rounds at most, the run it starts from not counted. */
  maxRounds: number;
  /** Examples each round writes. */
  examples: number;
  metaHighUsd: number;
  scoreHighUsd: number;
  callerId: string;
  startedAt: string;
}

export type LoopStopCode =
  | "target_reached"
  | "cap"
  | "round_limit"
  | "stopped"
  | "round_failed"
  | "not_scored"
  | "data_failed"
  | "no_new_rows"
  | "check_failed"
  | "no_gpu"
  | "refused"
  | "start_failed"
  | "error";

const STOP_TEXT: Record<LoopStopCode, string> = {
  target_reached: "It reached the target on the sealed prompts and clearly beat the base.",
  cap: "The next step wouldn't fit inside the spend cap, so nothing more was started.",
  round_limit: "It used all its rounds without reaching the target.",
  stopped: "A person stopped it.",
  round_failed: "A round's training failed or was stopped, so the loop ended rather than spend more.",
  not_scored: "A round couldn't be scored on enough prompts, so the loop couldn't tell whether it improved.",
  data_failed: "Writing a round's examples failed.",
  no_new_rows: "Every new example was too close to a kept-aside prompt or an existing example, so there was nothing new to train on.",
  check_failed: "A round's examples didn't pass the examples check, so training didn't start.",
  no_gpu: "It waited 2 hours to start a round's training and couldn't.",
  refused: "The platform refused to start a round's training.",
  start_failed: "The loop's workflow couldn't start, so nothing was spent.",
  error: "The loop stopped on an unexpected error. Nothing more will be started.",
};

export function stopText(code: string): string {
  return STOP_TEXT[code as LoopStopCode] ?? STOP_TEXT.error;
}

/**
 * Sealed: index 2, 3, 6, 7, and so on. Not simply the odd ones: judge.ts shows the base first on even indexes, so a split
 * on odd and even would always show the sealed half with the tuned answer first. Pairs keep both orders in each half.
 */
export function isSealed(index: number): boolean {
  return Math.floor(index / 2) % 2 === 1;
}

export interface LoopJudgement {
  index: number;
  baseScore: number;
  tunedScore: number;
  better: "base" | "tuned" | "tie";
}

export interface RoundScore {
  /** All that judging's items, on both halves. */
  all: EvalSummary;
  /** The half the target is checked on. */
  sealed: EvalSummary;
  /** Enough sealed items, chatPasses on them, and the sealed average at the target. */
  reached: boolean;
}

/**
 * A round's score from its job's judgements. The general checks (TUNE_GENERAL_CHECKS, lib/train/general-checks.ts) are
 * left out of both halves: the target is about the task, and their indexes would otherwise land in the sealed half.
 */
export function roundScore(judgements: readonly LoopJudgement[], target: number): RoundScore {
  const items = (list: readonly LoopJudgement[]) => list.map((j) => ({ baseScore: j.baseScore, tunedScore: j.tunedScore, better: j.better, costUsd: 0 }));
  const task = judgements.filter((j) => checkSetOf(j.index) === null);
  const sealed = summarizeJudgements(items(task.filter((j) => isSealed(j.index))));
  return { all: summarizeJudgements(items(task)), sealed, reached: chatPasses(sealed) && sealed.avgTunedScore >= target };
}

/**
 * The working half's prompts to write more for, worst first: below the target or not won by the tuned model, or else the
 * lowest scoring, so a round always has something to aim at. A sealed prompt is never returned. `prompts` is the source
 * dataset's own kept-aside list, never the job's eval events, which the GPU's runner writes.
 */
export function weakPrompts(judgements: readonly LoopJudgement[], prompts: readonly string[], target: number): string[] {
  const working = judgements.filter((j) => !isSealed(j.index) && typeof prompts[j.index] === "string" && prompts[j.index]!.trim());
  const worst = [...working].sort((a, b) => a.tunedScore - b.tunedScore || a.index - b.index);
  const weak = worst.filter((j) => j.tunedScore < target || j.better !== "tuned");
  return (weak.length ? weak : worst).slice(0, WEAK_MAX).map((j) => prompts[j.index]!.trim().slice(0, WEAK_CHARS));
}

/** The writer's task for a round: the source's task as it stands, and what to aim at. */
export function focusTask(task: string, weak: readonly string[]): string {
  return `${task.trim()}\n\nFor this batch: a checker found the model weakest on messages like these. Write new messages that need the same skills, in different situations with different details. Never reuse or reword them. Answer every message as the task above says, and don't mention this note.\n${weak.map((p) => `- ${p.replace(/\s+/g, " ")}`).join("\n")}`;
}

export interface NewRow {
  prompt: string;
  answer: string;
}

/**
 * The round's training rows: the last round's, then the new ones under the source's system message. A new row is dropped
 * when it repeats a training prompt or nears any kept-aside prompt, sealed or not. Over the dataset's limit, the oldest
 * go first, so a round always trains on what it just wrote. `added` is how many new rows made it in.
 */
export function mergeRows(previous: readonly TrainExample[], fresh: readonly NewRow[], keptAside: readonly string[], system: string, maxRows = DATASET_MAX_COUNT - keptAside.length): { train: TrainExample[]; added: number } {
  const aside = keptAside.map(promptWords);
  const seen = new Set(previous.map((e) => promptKey(e.messages?.find((m) => m.role === "user")?.content ?? "")));
  const added: TrainExample[] = [];
  for (const row of fresh) {
    const key = promptKey(row.prompt);
    if (!key || !row.answer.trim() || seen.has(key)) continue;
    const words = promptWords(row.prompt);
    if (aside.some((a) => isNearDuplicate(a, words))) continue;
    seen.add(key);
    added.push({ messages: [{ role: "system", content: system }, { role: "user", content: row.prompt }, { role: "assistant", content: row.answer }] });
  }
  const kept = added.slice(0, Math.max(0, maxRows));
  const room = Math.max(0, maxRows - kept.length);
  return { train: [...previous.slice(Math.max(0, previous.length - room)), ...kept], added: kept.length };
}

/** Steps that give each round the same passes over its data as the source had, within the most the GPU's time allows. */
export function roundSteps(sourceSteps: number, sourceTrain: number, train: number, most: number): number {
  const scaled = sourceTrain > 0 ? Math.ceil((sourceSteps * train) / sourceTrain) : sourceSteps;
  return Math.min(Math.max(sourceSteps, scaled), Math.max(sourceSteps, most));
}

export interface BudgetInput {
  capUsd: number;
  /** Spent by finished rounds. */
  spentUsd: number;
  /** This round's writing: the high estimate before it runs, what it cost after. */
  writerUsd: number;
  scoreHighUsd: number;
  /** The platform's ceiling on one job. */
  ceilingUsd: number;
  maxMinutes: number;
  priceCentsPerHour: number;
  estimateMinutes: number;
}

/**
 * What the round's job may spend: what the cap leaves after writing and the high estimate for judging, as the job's hard
 * dollar limit, whole cents down, and whether the estimated run fits in that. A job can't pass this limit, and the writer
 * is checked as it goes, so only the judging estimate could carry a loop past its cap.
 */
export function roundBudget(i: BudgetInput): { gpuUsd: number; fits: boolean } {
  const left = i.capUsd - i.spentUsd - i.writerUsd - i.scoreHighUsd;
  const gpuUsd = Math.floor(Math.min(i.ceilingUsd, left) * 100 + 1e-6) / 100;
  if (!(gpuUsd > 0)) return { gpuUsd: 0, fits: false };
  return { gpuUsd, fits: usableMinutes({ maxMinutes: i.maxMinutes, maxUsd: gpuUsd }, i.priceCentsPerHour) >= i.estimateMinutes };
}

/** What comes after a finished round, in order: only `go` can spend anything. */
export function nextMove(i: {
  stopped: boolean;
  /** The round just finished: 0 for the source run. */
  finished: number;
  maxRounds: number;
  jobStatus: string | null;
  score: RoundScore;
  weakCount: number;
  fits: boolean;
}): { kind: "go" } | { kind: "stop"; code: LoopStopCode } {
  const stop = (code: LoopStopCode) => ({ kind: "stop" as const, code });
  if (i.stopped || i.jobStatus === "stopped") return stop("stopped");
  if (i.jobStatus !== "succeeded") return stop("round_failed");
  if (i.score.sealed.items < VERDICT_MIN_ITEMS) return stop("not_scored");
  if (i.score.reached) return stop("target_reached");
  if (i.finished >= i.maxRounds) return stop("round_limit");
  if (!i.weakCount) return stop("not_scored");
  return i.fits ? { kind: "go" } : stop("cap");
}

/** One round as the loop's page shows it. Round 0 is the run the loop started from, whose cost isn't counted. */
export interface LoopRoundView {
  round: number;
  stage: "writing" | "checking" | "training" | "scoring" | "done" | "failed";
  datasetId: string | null;
  jobId: string | null;
  jobStatus: string | null;
  /** New examples that made it into training, and the training rows in all. */
  added: number | null;
  trainCount: number | null;
  /** The prompts this round's writer was told to aim at. */
  weak: string[];
  sealed: Pick<EvalSummary, "items" | "tunedWins" | "baseWins" | "avgBaseScore" | "avgTunedScore"> | null;
  all: Pick<EvalSummary, "items" | "tunedWins" | "baseWins" | "avgBaseScore" | "avgTunedScore"> | null;
  reached: boolean;
  costUsd: number;
}

export interface LoopView {
  id: string;
  title: string;
  spec: LoopSpec;
  running: boolean;
  stopCode: string | null;
  stopText: string | null;
  spentUsd: number;
  rounds: LoopRoundView[];
}

/** Reads a request body's loop settings, or the 400's sentence. */
export function loopSettings(body: Record<string, unknown>): { ok: true; target: number; capUsd: number; maxRounds: number; examples: number } | { ok: false; error: string } {
  const { targetScore: target, maxUsd: capUsd, maxRounds = LOOP_DEFAULT_ROUNDS, examples = LOOP_DEFAULT_EXAMPLES } = body;
  if (typeof target !== "number" || !Number.isFinite(target) || target < 1 || target > 10) return { ok: false, error: "The target score must be a number from 1 to 10." };
  if (typeof capUsd !== "number" || !Number.isFinite(capUsd) || capUsd <= 0 || capUsd > LOOP_MAX_USD) return { ok: false, error: `The spend cap must be above $0 and at most $${LOOP_MAX_USD}.` };
  if (typeof maxRounds !== "number" || !Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > LOOP_MAX_ROUNDS) return { ok: false, error: `Rounds must be a whole number from 1 to ${LOOP_MAX_ROUNDS}.` };
  if (typeof examples !== "number" || !Number.isInteger(examples) || examples < LOOP_MIN_EXAMPLES || examples > LOOP_MAX_EXAMPLES) return { ok: false, error: `Examples a round must be a whole number from ${LOOP_MIN_EXAMPLES} to ${LOOP_MAX_EXAMPLES}.` };
  return { ok: true, target, capUsd, maxRounds, examples };
}
