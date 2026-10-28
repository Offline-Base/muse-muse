/**
 * Training datasets Muse Spark 1.3 writes from a task description (docs/TRAINING.md "Datasets"). makeDataset is the
 * durable workflow and its steps are below it, in this file.
 *
 *   makeDataset: prompts in batches of 25 (structured output, de-duplicated, each batch leaning to other styles)
 *                -> answers in chunks of 24, 6 at a time, appended to the dataset as they come (up to 2 chunks Meta
 *                   never answered are left out)
 *                -> 10% held out for eval (at least 8, at most 40), and the dataset turns "ready"
 *
 * Every Meta call is recorded with recordUsage (source "platform") and added to the dataset's cost. Each model step
 * checks the platform's daily spend cap first and stops the dataset once it is reached. Answers go straight into the
 * row, appended only at the offset the workflow expects, so a retried step never adds a chunk twice and the event log
 * keeps only the prompts and counts.
 *
 * Start it with start() from "workflow/api" (app/api/train/datasets). Never call it directly.
 */
import { FatalError, RetryableError } from "workflow";
import { z } from "zod";
import { textPart } from "@/lib/brief/media";
import { cleanStrings, noEmDashes } from "@/lib/brief/normalize";
import { respondStructured, StructuredOutputError, type StructuredResult } from "@/lib/brief/structured";
import { metaPlatform } from "@/lib/meta/platform";
import { fromResponsesUsage } from "@/lib/meta/pricing";
import { spendPaused } from "@/lib/quota";
import { DATASET_MIN_EXAMPLES, datasetSystemPrompt, dedupePrompts } from "@/lib/train/logic";
import { addDatasetCost, appendTrainExamples, datasetProgress, failDataset, finishDataset, getDataset } from "@/lib/train/store";
import type { DatasetStatus, TrainExample } from "@/lib/train/types";
import type { ModelUsage } from "@/lib/types";
import { recordUsage } from "@/lib/usage";

/** The model that writes the prompts and the reference answers. */
export const DATASET_MODEL = "muse-spark-1.3";

/** Prompts asked for in one structured call. */
export const PROMPT_BATCH = 25;
/** Batches allowed past the ones the count needs, for batches that de-duplication thins out. */
const EXTRA_PROMPT_BATCHES = 4;
/** The latest prompts shown to the writer as ones not to repeat, each cut to AVOID_CHARS. */
const AVOID_SHOWN = 40;
const AVOID_CHARS = 140;
/** A prompt longer than this is dropped rather than cut, since a cut message reads as broken. */
const PROMPT_MAX = 1500;

/** Prompts one answer step answers, ANSWER_CONCURRENCY at a time: about a minute of calls. */
export const ANSWER_CHUNK = 24;
export const ANSWER_CONCURRENCY = 6;
/** An answer longer than this is dropped rather than cut, so the tuned model never learns to stop mid-sentence. */
const ANSWER_MAX = 4000;
/** Reasoning counts against it too; about 350 words of answer need well under half. */
const ANSWER_MAX_OUTPUT_TOKENS = 3000;
const ANSWER_TIMEOUT_MS = 90_000;

/** Chunks Meta never answered (after the step's retries) that are left out before the dataset fails. */
const SKIPPABLE_CHUNKS = 2;

const DB_RETRY_AFTER = "30s";
const PAUSED = "The platform's daily spend cap is reached, so the dataset stopped.";
const NO_ANSWERS = "Muse Spark 1.3 answered none of this chunk's prompts.";

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
  try {
    const head = await loadDatasetStep(datasetId);
    if (!head) return { status: "failed" };
    if (head.status !== "generating") return { status: head.status };

    const prompts: string[] = [];
    const batches = Math.ceil(head.requested / PROMPT_BATCH);
    const maxBatches = batches + EXTRA_PROMPT_BATCHES;
    for (let batch = 0; prompts.length < head.requested && batch < maxBatches; batch++) {
      const want = Math.min(PROMPT_BATCH, head.requested - prompts.length);
      const avoid = prompts.slice(-AVOID_SHOWN).map((p) => p.slice(0, AVOID_CHARS));
      const written = await promptBatchStep({ datasetId, task: head.task, want, batch, batches, avoid });
      prompts.push(...dedupePrompts(prompts, written.prompts, head.requested - prompts.length));
    }
    if (prompts.length < DATASET_MIN_EXAMPLES) {
      throw new Error(`Muse Spark 1.3 wrote only ${prompts.length} different prompts, and a dataset needs ${DATASET_MIN_EXAMPLES}.`);
    }

    const system = datasetSystemPrompt(head.task);
    let saved = 0;
    let skipped = 0;
    for (let i = 0; i < prompts.length; i += ANSWER_CHUNK) {
      try {
        const chunk = await answerChunkStep({ datasetId, system, offset: saved, prompts: prompts.slice(i, i + ANSWER_CHUNK) });
        saved += chunk.saved;
      } catch (err) {
        // A chunk Meta never answered is left out, a couple of times. Anything else (the spend cap, a dataset that
        // stopped generating) ends the run.
        if (errorReason(err) !== NO_ANSWERS || ++skipped > SKIPPABLE_CHUNKS) throw err;
      }
    }
    if (saved < DATASET_MIN_EXAMPLES) {
      throw new Error(`Only ${saved} prompts got a usable answer, and a dataset needs ${DATASET_MIN_EXAMPLES}.`);
    }
    return { status: await finishDatasetStep(datasetId, saved) };
  } catch (err) {
    try {
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

/** Records Meta usage for the platform and adds its cost to the dataset. */
async function charge(datasetId: string, usage: ModelUsage[]): Promise<void> {
  if (!usage.length) return;
  const usd = usage.reduce((sum, u) => sum + (u.costUsd || 0), 0);
  await fromDb(async () => {
    await recordUsage({ source: "platform", endpoint: "responses" }, usage);
    await addDatasetCost(datasetId, usd);
  });
}

/** Runs `fn` over `items`, at most `limit` at once, keeping their order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * The styles batch `batch` leans toward when the dataset needs `batches` batches: one each in turn when there are at
 * least as many batches as styles, otherwise an even share of them, so every style is in the dataset.
 */
export function stylesFor(batch: number, batches: number): string[] {
  const per = Math.ceil(STYLES.length / Math.max(1, Math.min(STYLES.length, batches)));
  return Array.from({ length: per }, (_, i) => STYLES[(batch * per + i) % STYLES.length]!);
}

/** The writer's user message: the task, how many to write, this batch's styles, and the latest ones not to repeat. */
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
      { timeout: ANSWER_TIMEOUT_MS },
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
 * Asks Muse Spark 1.3 for `want` realistic user prompts for the task with structured output, and charges the call to
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
 * Answers a chunk of prompts with Muse Spark 1.3, 6 at a time, charges the calls to the dataset and appends the
 * answered ones as training examples at `offset` (the examples the dataset already holds). A prompt whose answer
 * failed is skipped. When the dataset already holds more than `offset`, an earlier attempt of this step saved the
 * chunk, and nothing is asked again. Returns how many examples the chunk added.
 */
export async function answerChunkStep(input: {
  datasetId: string;
  system: string;
  offset: number;
  prompts: string[];
}): Promise<{ saved: number }> {
  "use step";
  const held = await fromDb(() => datasetProgress(input.datasetId));
  if (held === null) throw new FatalError("The dataset is no longer generating.");
  if (held > input.offset) return { saved: held - input.offset };
  if (held < input.offset) throw new FatalError(`The dataset holds ${held} examples where ${input.offset} were expected.`);
  if (await fromDb(() => spendPaused())) throw new FatalError(PAUSED);

  const results = await mapLimit(input.prompts, ANSWER_CONCURRENCY, (prompt) => answerOne(input.system, prompt));
  await charge(input.datasetId, results.flatMap((r) => r.usage));
  const examples: TrainExample[] = [];
  results.forEach((r, i) => {
    if (!r.answer) return;
    examples.push({
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.prompts[i]! },
        { role: "assistant", content: r.answer },
      ],
    });
  });
  if (!examples.length) throw new RetryableError(NO_ANSWERS, { retryAfter: DB_RETRY_AFTER });
  const length = await fromDb(() => appendTrainExamples(input.datasetId, input.offset, examples));
  if (length === null) throw new FatalError("The dataset is no longer generating.");
  return { saved: length - input.offset };
}
answerChunkStep.maxRetries = 3;

/** Holds out the eval items and turns the dataset "ready" (finishDataset). Safe to run again. */
export async function finishDatasetStep(datasetId: string, count: number): Promise<DatasetStatus> {
  "use step";
  const row = await fromDb(() => finishDataset(datasetId, count));
  if (row) return row.status;
  // An earlier attempt finished it, or it holds another count, which only a bug could cause.
  const now = await fromDb(() => getDataset(datasetId));
  if (now && now.status !== "generating") return now.status;
  throw new FatalError(`The dataset doesn't hold the ${count} examples its answers added up to.`);
}
finishDatasetStep.maxRetries = 20;

/** Fails a dataset that is still generating, with a plain reason. Database errors are retried for about 10 minutes. */
export async function failDatasetStep(datasetId: string, reason: string): Promise<void> {
  "use step";
  await fromDb(() => failDataset(datasetId, reason));
}
failDatasetStep.maxRetries = 20;
