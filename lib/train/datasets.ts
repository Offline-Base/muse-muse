/**
 * Training datasets Muse Wonder (DATASET_MODEL) writes from a task description (docs/TRAINING.md "Datasets"). The route
 * saves the writer on the dataset (writer_model) as it creates it; datasets made before Oct 29, 2026 have none and were
 * written by Muse Spark 1.3. makeDataset is the durable workflow and its steps are below it, in this file.
 *
 *   makeDataset: prompts in batches of 25 (structured output, de-duplicated, each batch leaning to other styles)
 *                -> answers in chunks of 12, 6 at a time, each saved as soon as Meta answers it and moved onto the
 *                   dataset when the chunk ends (up to 2 chunks Meta never answered are left out)
 *                -> 10% held out for eval (at least 8, at most 40), keeping near-duplicates of an eval prompt out of
 *                   train, and the dataset turns "ready"
 *
 * Every Meta call is recorded with recordUsage (source "platform") and added to the dataset's cost as soon as it
 * returns. Each model step checks the platform's daily spend cap first and stops the dataset once it is reached. A
 * dataset keeps what it already paid for: when something goes wrong late (the spend cap, the database, Meta), the
 * examples answered so far become a smaller ready dataset with a note saying why, once there are at least 16, and only
 * fewer than that fails it. Answers go straight into the row, so a retried step never asks for an answer it already
 * has, and the event log keeps only the prompts and counts.
 *
 * Start it with start() from "workflow/api" (app/api/train/datasets). Never call it directly.
 */
import { FatalError, RetryableError } from "workflow";
import { z } from "zod";
import { textPart } from "@/lib/brief/media";
import { cleanStrings, noEmDashes } from "@/lib/brief/normalize";
import { respondStructured, StructuredOutputError, type StructuredResult } from "@/lib/brief/structured";
import { metaPlatform } from "@/lib/meta/platform";
import { modelLabel } from "@/lib/format";
import { fromResponsesUsage } from "@/lib/meta/pricing";
import { spendPaused } from "@/lib/quota";
import { DATASET_MIN_EXAMPLES, datasetSystemPrompt, dedupePrompts } from "@/lib/train/logic";
import { addDatasetCost, answerProgress, failDataset, finishDataset, flushAnswers, getDataset, stageAnswer } from "@/lib/train/store";
import type { DatasetStatus } from "@/lib/train/types";
import type { ModelUsage } from "@/lib/types";
import { recordUsage } from "@/lib/usage";

/**
 * The model that writes the prompts and the reference answers of a new dataset, saved on it as its writer_model. Muse
 * Spark 1.3 wrote every dataset before Oct 29, 2026 and is never used for new ones.
 */
export const DATASET_MODEL = "muse-wonder-1.0";
const WRITER = modelLabel(DATASET_MODEL);

/** Prompts asked for in one structured call. */
export const PROMPT_BATCH = 25;
/** Batches allowed past the ones the count needs, for batches that de-duplication thins out. */
const EXTRA_PROMPT_BATCHES = 4;
/** The latest prompts shown to the writer as ones not to repeat, each cut to AVOID_CHARS. */
const AVOID_SHOWN = 40;
const AVOID_CHARS = 140;
/** Prompts from earlier batches of the same styles shown on top of those, the likeliest to be written again. */
const AVOID_SAME_STYLES = 40;
/** A prompt longer than this is dropped rather than cut, since a cut message reads as broken. */
const PROMPT_MAX = 1500;

/**
 * Prompts one answer step answers, ANSWER_CONCURRENCY at a time: two rounds of calls, well under a minute as a rule,
 * even though a Muse Wonder call takes 1.4 to 2 times as long as a Muse Spark 1.3 one did.
 */
export const ANSWER_CHUNK = 12;
export const ANSWER_CONCURRENCY = 6;
/** An answer longer than this is dropped rather than cut, so the tuned model never learns to stop mid-sentence. */
const ANSWER_MAX = 4000;
/**
 * Muse Wonder bills its reasoning as output, so the cap is the answer plus room to reason: an answer is about 350 words
 * (about 500 tokens) and never more than ANSWER_MAX characters (about 1,000 tokens), which leaves about 3,000 tokens of
 * reasoning, twice what Muse Spark 1.3 reasoned for on a story at effort low (hub-steps.ts). A call that runs out
 * comes back "incomplete" and is dropped after it was billed, so the room matters more than the cap. Only the tokens
 * used are paid for.
 */
const ANSWER_MAX_OUTPUT_TOKENS = 4000;
/**
 * One answer call waits this long, and the SDK tries it once more, so a prompt takes at most about 3 minutes. Muse
 * Spark 1.3 answered in about 4 s (docs/TRAINING.md "Datasets"), and Muse Wonder's 1.4 to 2 times that is well inside.
 */
const ANSWER_TIMEOUT_MS = 90_000;
const ANSWER_MAX_RETRIES = 1;

/**
 * How an answer step stays well inside its function's time limit (800 s at most): past startByMs it starts no new
 * prompt (the rest go to the next step), so it ends within startByMs plus one call's 3 minutes plus its database
 * writes. A database write that fails is tried again after each wait in saveRetryMs before the step gives up, so a
 * short outage never throws away an answer already paid for. Tests shorten them.
 */
export const ANSWER_STEP_TIMING = { startByMs: 120_000, saveRetryMs: [2_000, 10_000, 30_000, 60_000] };

/** Chunks Meta never answered (after the step's retries) that are left out before the dataset stops. */
const SKIPPABLE_CHUNKS = 2;

const DB_RETRY_AFTER = "30s";
const PAUSED = "The platform's daily spend cap is reached, so the dataset stopped.";
const NO_ANSWERS = `${WRITER} answered none of this chunk's prompts.`;
const UNANSWERED = `${WRITER} answered none of the prompts in ${SKIPPABLE_CHUNKS + 1} chunks, so the dataset stopped.`;

/**
 * Styles the batches lean toward in turn, so they don't all read alike. A dataset that needs fewer batches than there
 * are styles gives each batch several, so even a 20-example dataset covers them all (stylesFor).
 */
const STYLES = [
  "short, casual messages typed quickly, a few with typos or no punctuation",
  "detailed requests that give background, constraints and what was already tried",
  "beginners who don't know the right terms yet",
  "experienced people asking about edge cases and tradeoffs",
  "concrete situations with real specifics: names, numbers, snippets or quotes",
  "requests for a particular format, length or tone",
  "unusual but realistic cases at the edges of the task",
  "people who are stressed, in a hurry or frustrated",
];

const PROMPT_WRITER = [
  "You write prompts for fine-tuning a model: the messages real people would send to an assistant that does the task you are given.",
  "Rules:",
  "- Each prompt is one complete message from a user, in their own words, as they would type it. No numbering, labels, surrounding quotes or answers.",
  "- Make every prompt different from the others and from the ones already written: different goals, situations, levels of expertise, lengths (one line to a short paragraph) and tones. Include the concrete details a real person would give (names, numbers, snippets, constraints).",
  "- Stay inside the task. Nothing harmful, hateful or sexual, and no real person's private details.",
  "- Keep each prompt under 150 words.",
  "- Don't use em dashes.",
  'Return JSON: {"prompts": ["...", "..."]}.',
].join("\n");

const PromptBatchSchema = z.object({ prompts: z.array(z.string().min(1)).min(1).max(PROMPT_BATCH * 2) });

export interface MakeDatasetInput {
  datasetId: string;
}

export interface MakeDatasetResult {
  status: DatasetStatus;
}

// ---------------------------------------------------------------------------------------------------------------
// Workflow

/** The runtime wraps a step error that used up its retries with this prefix. */
const RETRIES_EXHAUSTED = /^Step "[^"]*" failed after \d+ retr(?:y|ies): /;

/** The first line of an error, for the dataset's error. Duck-typed, since errors in the workflow sandbox may come from another realm. */
function errorReason(err: unknown): string {
  const e = typeof err === "object" && err !== null ? (err as { message?: unknown }) : null;
  const raw = typeof e?.message === "string" ? e.message : typeof err === "string" ? err : "";
  const line = (raw.replace(RETRIES_EXHAUSTED, "").split("\n")[0] ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  return line || "The dataset could not be written.";
}

export async function makeDataset(input: MakeDatasetInput): Promise<MakeDatasetResult> {
  "use workflow";
  const { datasetId } = input;
  // Set once answers start: from then on the dataset is finished with what it holds rather than failed.
  let answering: { system: string; requested: number } | null = null;
  try {
    const head = await loadDatasetStep(datasetId);
    if (!head) return { status: "failed" };
    if (head.status !== "generating") return { status: head.status };

    const prompts: string[] = [];
    // The prompts each batch added, so a batch is also shown what earlier batches of its styles wrote.
    const byBatch: string[][] = [];
    const batches = Math.ceil(head.requested / PROMPT_BATCH);
    const maxBatches = batches + EXTRA_PROMPT_BATCHES;
    for (let batch = 0; prompts.length < head.requested && batch < maxBatches; batch++) {
      const want = Math.min(PROMPT_BATCH, head.requested - prompts.length);
      const avoid = avoidList(byBatch, batch, batches);
      let written: { prompts: string[] };
      try {
        written = await promptBatchStep({ datasetId, task: head.task, want, batch, batches, avoid });
      } catch (err) {
        // A late batch that failed leaves enough prompts to go on with. The spend cap stops answers too, so it ends here.
        if (prompts.length < DATASET_MIN_EXAMPLES || errorReason(err) === PAUSED) throw err;
        break;
      }
      const added = dedupePrompts(prompts, written.prompts, head.requested - prompts.length);
      prompts.push(...added);
      byBatch[batch] = added;
    }
    if (prompts.length < DATASET_MIN_EXAMPLES) {
      throw new Error(`${WRITER} wrote only ${prompts.length} different prompts, and a dataset needs ${DATASET_MIN_EXAMPLES}.`);
    }

    const system = datasetSystemPrompt(head.task);
    answering = { system, requested: head.requested };
    let saved = 0;
    let skipped = 0;
    let stopped: string | null = null;
    for (let i = 0; i < prompts.length; ) {
      const chunk = prompts.slice(i, i + ANSWER_CHUNK);
      try {
        const answered = await answerChunkStep({ datasetId, system, offset: saved, prompts: chunk });
        saved += answered.saved;
        // Prompts a step had no time to start go to the next one. It always starts some, so this ends.
        i += Math.max(1, Math.min(chunk.length, answered.done));
      } catch (err) {
        // A chunk Meta never answered is left out, a couple of times. Anything else (the spend cap, the database, a
        // dataset that stopped generating) stops the answers, and the dataset keeps what it holds.
        const reason = errorReason(err);
        if (reason === NO_ANSWERS && ++skipped <= SKIPPABLE_CHUNKS) {
          i += chunk.length;
          continue;
        }
        stopped = reason === NO_ANSWERS ? UNANSWERED : reason;
        break;
      }
    }
    return { status: await finishDatasetStep(datasetId, { ...answering, stopped }) };
  } catch (err) {
    try {
      // Only the finish step itself can fail here once answers started. Try it once more before giving up.
      if (answering) return { status: await finishDatasetStep(datasetId, { ...answering, stopped: errorReason(err) }) };
      await failDatasetStep(datasetId, errorReason(err));
    } catch {
      // The database stayed down. The dataset stays "generating", which no job can use, and nothing bills for it.
    }
    return { status: "failed" };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers (not steps)

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A database call whose failure is retried after 30 s rather than 1 s. */
async function fromDb<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw new RetryableError(`The database did not answer: ${message(err)}`, { retryAfter: DB_RETRY_AFTER });
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A database write that follows a paid Meta call: tried again in the step after each of ANSWER_STEP_TIMING.saveRetryMs
 * (about 100 s in all), and only then retried as the step's own error, so a short outage never makes a step ask and pay
 * again.
 */
async function persist<T>(call: () => Promise<T>): Promise<T> {
  for (const ms of ANSWER_STEP_TIMING.saveRetryMs) {
    try {
      return await call();
    } catch (err) {
      console.error("[train/datasets] save", message(err));
      await wait(ms);
    }
  }
  return fromDb(call);
}

/** Records Meta usage for the platform and adds its cost to the dataset, each write on its own so neither counts twice. */
async function charge(datasetId: string, usage: ModelUsage[]): Promise<void> {
  if (!usage.length) return;
  const usd = usage.reduce((sum, u) => sum + (u.costUsd || 0), 0);
  await persist(() => recordUsage({ source: "platform", endpoint: "responses" }, usage));
  await persist(() => addDatasetCost(datasetId, usd));
}

/**
 * Runs `fn` over `items`, at most `limit` at once, keeping their order. Past `stopBy` (a Date.now() time) a worker that
 * has already run once takes nothing new, so what it left is a tail of `items`; the result covers only the head that ran.
 * Once one call throws, no worker takes a new item, and the error is thrown once the calls already started are done.
 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>, stopBy = Infinity): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  let failed = false;
  const worker = async () => {
    let ran = false;
    while (!failed && next < items.length && (!ran || Date.now() < stopBy)) {
      const i = next++;
      ran = true;
      try {
        out[i] = await fn(items[i]!);
      } catch (err) {
        // The others finish what they started and take nothing new.
        failed = true;
        throw err;
      }
    }
  };
  // Every worker settles before the error is thrown, so nothing the step started outlives it.
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
  const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failure) throw failure.reason;
  return out.slice(0, next);
}

/**
 * The styles batch `batch` leans toward when the dataset needs `batches` batches: one each in turn when there are at
 * least as many batches as styles, otherwise an even share of them, so every style is in the dataset.
 */
export function stylesFor(batch: number, batches: number): string[] {
  const per = Math.ceil(STYLES.length / Math.max(1, Math.min(STYLES.length, batches)));
  return Array.from({ length: per }, (_, i) => STYLES[(batch * per + i) % STYLES.length]!);
}

/**
 * The prompts shown to the writer of `batch` as ones not to repeat, each cut to AVOID_CHARS: the latest AVOID_SHOWN,
 * after up to AVOID_SAME_STYLES more from the earlier batches that leaned to the same styles (stylesFor), newest batch
 * first. Those are the likeliest to come back as close variants, which de-duplication can't catch and which would
 * leak between train and eval. `byBatch` holds the prompts each batch added.
 */
export function avoidList(byBatch: string[][], batch: number, batches: number): string[] {
  const latest = byBatch.flat().slice(-AVOID_SHOWN);
  const shown = new Set(latest);
  const styles = stylesFor(batch, batches).join("\n");
  const same: string[] = [];
  for (let b = batch - 1; b >= 0 && same.length < AVOID_SAME_STYLES; b--) {
    if (stylesFor(b, batches).join("\n") !== styles) continue;
    for (const p of byBatch[b] ?? []) {
      if (same.length >= AVOID_SAME_STYLES) break;
      if (shown.has(p)) continue;
      shown.add(p);
      same.push(p);
    }
  }
  return [...same, ...latest].map((p) => p.slice(0, AVOID_CHARS));
}

/** The writer's user message: the task, how many to write, this batch's styles, and the prompts not to repeat. */
function promptRequest(input: PromptBatchInput): string {
  const styles = stylesFor(input.batch, input.batches ?? STYLES.length);
  const lean =
    styles.length === 1
      ? `This batch leans toward ${styles[0]}, but still mix lengths and tones.`
      : `Spread this batch across these kinds of message, a few of each, and mix lengths and tones:\n${styles.map((x) => `- ${x}`).join("\n")}`;
  const parts = [`Task:\n${input.task}`, `Write ${input.want} new prompts. ${lean}`];
  if (input.avoid.length) {
    parts.push(`Already written, so don't repeat these or write close variants:\n${input.avoid.map((p) => `- ${p}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * One prompt answered with the task's system prompt, or a null answer when the call failed, ran out of tokens, came
 * back empty or ran past ANSWER_MAX. The usage of a call that answered is kept either way.
 */
async function answerOne(system: string, prompt: string): Promise<{ answer: string | null; usage: ModelUsage[] }> {
  try {
    const res = await metaPlatform().responses.create(
      {
        model: DATASET_MODEL,
        instructions: system,
        input: prompt,
        reasoning: { effort: "low" },
        max_output_tokens: ANSWER_MAX_OUTPUT_TOKENS,
      },
      { timeout: ANSWER_TIMEOUT_MS, maxRetries: ANSWER_MAX_RETRIES },
    );
    const usage = [fromResponsesUsage(DATASET_MODEL, res.usage)];
    const text = noEmDashes((res.output_text ?? "").trim()).trim();
    const ok = res.status !== "incomplete" && text.length > 0 && text.length <= ANSWER_MAX;
    return { answer: ok ? text : null, usage };
  } catch (err) {
    console.error("[train/datasets] answer", message(err));
    return { answer: null, usage: [] };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Steps

/** The dataset's task and size, or null when it is gone. */
export async function loadDatasetStep(
  datasetId: string,
): Promise<{ status: DatasetStatus; task: string; requested: number } | null> {
  "use step";
  const row = await fromDb(() => getDataset(datasetId));
  return row ? { status: row.status, task: row.task, requested: row.requested } : null;
}

export interface PromptBatchInput {
  datasetId: string;
  task: string;
  /** How many to ask for, at most PROMPT_BATCH. */
  want: number;
  /** Which batch this is, from 0. Picks its styles. */
  batch: number;
  /** How many batches the count needs (extra batches for de-duplication don't count). Fewer than 8 spreads the styles. */
  batches?: number;
  /** The latest prompts already written, cut short, for the writer not to repeat. */
  avoid: string[];
}

/**
 * Asks DATASET_MODEL for `want` realistic user prompts for the task with structured output, and charges the call to
 * the dataset. Prompts over 1,500 characters are dropped; the workflow de-duplicates the rest. Stops the dataset
 * (FatalError) once the platform's daily spend cap is reached.
 */
export async function promptBatchStep(input: PromptBatchInput): Promise<{ prompts: string[] }> {
  "use step";
  if (await fromDb(() => spendPaused())) throw new FatalError(PAUSED);
  let result: StructuredResult<z.infer<typeof PromptBatchSchema>>;
  try {
    result = await respondStructured({
      model: DATASET_MODEL,
      instructions: PROMPT_WRITER,
      content: [textPart(promptRequest(input))],
      schema: PromptBatchSchema,
      schemaName: "training_prompts",
      effort: "low",
      normalize: (raw) => cleanStrings(raw),
    });
  } catch (err) {
    // Both attempts were billed even though neither matched the schema.
    if (err instanceof StructuredOutputError) await charge(input.datasetId, err.usage);
    throw err;
  }
  await charge(input.datasetId, result.usage);
  return { prompts: result.data.prompts.filter((p) => p.length > 0 && p.length <= PROMPT_MAX) };
}
promptBatchStep.maxRetries = 2;

/**
 * Answers a chunk of prompts with DATASET_MODEL, 6 at a time. Each call is charged to the dataset as it returns, and
 * each usable answer is saved at once (stageAnswer); at the end the chunk's answers move onto the dataset after the
 * `offset` examples it already holds (flushAnswers). A prompt whose answer failed is skipped. A retried step asks only
 * the prompts no earlier attempt saved, and when the dataset already holds more than `offset`, an earlier attempt
 * finished the chunk and nothing is asked again. Past ANSWER_STEP_TIMING.startByMs it starts no new prompt. Returns how
 * many examples the chunk added, and `done`, how many of its prompts (from the start) were dealt with; the workflow
 * hands the rest to the next step.
 */
export async function answerChunkStep(input: {
  datasetId: string;
  system: string;
  offset: number;
  prompts: string[];
}): Promise<{ saved: number; done: number }> {
  "use step";
  const stopBy = Date.now() + ANSWER_STEP_TIMING.startByMs;
  const progress = await fromDb(() => answerProgress(input.datasetId));
  if (!progress) throw new FatalError("The dataset is no longer generating.");
  if (progress.held > input.offset) return { saved: progress.held - input.offset, done: input.prompts.length };
  if (progress.held < input.offset) {
    throw new FatalError(`The dataset holds ${progress.held} examples where ${input.offset} were expected.`);
  }
  const staged = new Set(progress.staged);
  if (input.prompts.some((p) => !staged.has(p)) && (await fromDb(() => spendPaused()))) throw new FatalError(PAUSED);

  let billed = false;
  const ran = await mapLimit(
    input.prompts,
    ANSWER_CONCURRENCY,
    async (prompt) => {
      if (staged.has(prompt)) return;
      const r = await answerOne(input.system, prompt);
      if (r.usage.length) billed = true;
      await charge(input.datasetId, r.usage);
      if (!r.answer) return;
      const ok = await persist(() => stageAnswer(input.datasetId, { prompt, reference: r.answer! }));
      if (!ok) throw new FatalError("The dataset is no longer generating.");
    },
    stopBy,
  );
  const length = await persist(() => flushAnswers(input.datasetId, input.system));
  if (length === null) throw new FatalError("The dataset is no longer generating.");
  const saved = length - input.offset;
  const done = ran.length;
  if (saved <= 0 && done >= input.prompts.length) {
    // Answers Meta billed and that were still unusable would most likely come back the same, so they aren't asked
    // again. Calls that all failed cost nothing, so the step tries them again.
    if (billed) throw new FatalError(NO_ANSWERS);
    throw new RetryableError(NO_ANSWERS, { retryAfter: DB_RETRY_AFTER });
  }
  return { saved: Math.max(0, saved), done };
}
answerChunkStep.maxRetries = 3;

/** The reason a dataset stopped early, as one sentence ending in a full stop. */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * Ends the answers: moves any answers still saved for a chunk onto the dataset, counts what it holds and turns it
 * "ready" (finishDataset holds out the eval items). With at least 16 examples it is ready even when `stopped` says the
 * answers ended early, with a note that says why; with fewer it fails, with that reason. Safe to run again.
 */
export async function finishDatasetStep(
  datasetId: string,
  input: { system: string; requested: number; stopped: string | null },
): Promise<DatasetStatus> {
  "use step";
  const held = await fromDb(() => flushAnswers(datasetId, input.system));
  if (held === null) {
    // An earlier attempt finished it, or it stopped generating some other way.
    const now = await fromDb(() => getDataset(datasetId));
    return now?.status ?? "failed";
  }
  if (held < DATASET_MIN_EXAMPLES) {
    const reason = input.stopped ?? `Only ${held} prompts got a usable answer, and a dataset needs ${DATASET_MIN_EXAMPLES}.`;
    await fromDb(() => failDataset(datasetId, reason));
    return "failed";
  }
  const note = input.stopped
    ? `Stopped early, once ${held} of the ${input.requested} examples asked for were answered. ${sentence(input.stopped)}`
    : null;
  const row = await fromDb(() => finishDataset(datasetId, held, note));
  if (row) return row.status;
  const now = await fromDb(() => getDataset(datasetId));
  if (now && now.status !== "generating") return now.status;
  throw new FatalError(`The dataset doesn't hold the ${held} examples it counted.`);
}
finishDatasetStep.maxRetries = 20;

/** Fails a dataset that is still generating, with a plain reason. Database errors are retried for about 10 minutes. */
export async function failDatasetStep(datasetId: string, reason: string): Promise<void> {
  "use step";
  await fromDb(() => failDataset(datasetId, reason));
}
failDatasetStep.maxRetries = 20;
