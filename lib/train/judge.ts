/**
 * Judging a fine-tuning job's eval items (docs/TRAINING.md "Judging"): Muse Spark 1.3 scores the base and the tuned
 * model's answers to each held-out prompt from 1 to 10 against Muse Spark 1.3's reference answer. The training
 * workflow (lib/train/workflow.ts) runs these steps only after the job's instance is terminated and only for a job that
 * succeeded, so judging never keeps a GPU billing, and a failure here never changes the job's status.
 *
 * The judge sees the two answers blind, as A and B, with the base model's first on even indexes and second on odd ones,
 * so neither its labels nor its position favors one model. Each verdict is logged as a "judgement" event, which also
 * makes judgeStep safe to run again: an item already judged isn't sent to Meta twice. How judging ended is saved on the
 * job as its eval summary, including when it was skipped or judged nothing (unjudgedSummary, with the reason), so the
 * job page never has to read it from the log, which the job's runner can write to.
 */
import { FatalError, RetryableError } from "workflow";
import { z } from "zod";
import { textPart } from "@/lib/brief/media";
import { cleanStrings } from "@/lib/brief/normalize";
import { respondStructured, StructuredOutputError, type StructuredResult } from "@/lib/brief/structured";
import { spendPaused } from "@/lib/quota";
import { betterOf, judgeScore, summarizeJudgements, unjudgedSummary, type JudgedItem } from "@/lib/train/logic";
import { getDataset, getEvalItem, getJob, getJudgement, listEvalIndexes, recordEvent, setEvalSummary } from "@/lib/train/store";
import type { EvalSummary } from "@/lib/train/types";
import type { ModelUsage } from "@/lib/types";
import { recordUsage } from "@/lib/usage";

/** The model that judges. */
export const JUDGE_MODEL = "muse-spark-1.3";

/** The note is cut to this many words. */
const NOTE_WORDS = 30;
const DB_RETRY_AFTER = "30s";

const JUDGE_INSTRUCTIONS = [
  "You judge two answers to the same user message, from a model before and after fine-tuning, in a random order. A reference answer is given: a good answer, not the only good one.",
  "Score each answer from 1 to 10 for how well it serves the user under the task: correct, on task, specific, clear and the right length. Use the reference to check facts and what a full answer covers; an answer can differ from it and still score high.",
  "Don't reward length. Mark down answers that are wrong, off task, repetitive, cut off, padded or in another language than the user's.",
  'better is "A", "B", or "tie" when they are equally good.',
  'note is under 30 words on what separates them. Don\'t call them A or B: say what the better one does, such as "Names the right setting and gives steps; the other is vague."',
  "Don't use em dashes.",
].join("\n");

/** Field order puts the reasoning before the scores. */
const VerdictSchema = z.object({
  note: z.string().min(1),
  scoreA: z.number().int().min(1).max(10),
  scoreB: z.number().int().min(1).max(10),
  better: z.enum(["A", "B", "tie"]),
});
type Verdict = z.infer<typeof VerdictSchema>;

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

/** Trims, drops em dashes, clamps the scores to 1 to 10 and cuts the note to 30 words, before zod sees the reply. */
function normalizeVerdict(raw: unknown): unknown {
  const v = cleanStrings(raw) as Record<string, unknown> | null;
  if (!v || typeof v !== "object") return v;
  const score = (x: unknown) => (typeof x === "number" ? judgeScore(x) : x);
  const note = typeof v.note === "string" ? v.note.split(/\s+/).filter(Boolean).slice(0, NOTE_WORDS).join(" ") : v.note;
  return { ...v, note, scoreA: score(v.scoreA), scoreB: score(v.scoreB) };
}

/** The judge's user message. The task comes from the job's dataset when it has one. */
function judgeRequest(input: { task: string | null; prompt: string; reference: string; a: string; b: string }): string {
  const parts = [
    ...(input.task ? [`Task:\n${input.task}`] : []),
    `User message:\n${input.prompt}`,
    `Reference answer:\n${input.reference || "(none)"}`,
    `Answer A:\n${input.a || "(empty)"}`,
    `Answer B:\n${input.b || "(empty)"}`,
  ];
  return parts.join("\n\n");
}

function recordJudgeUsage(usage: ModelUsage[]): Promise<void> {
  return fromDb(() => recordUsage({ source: "platform", endpoint: "responses" }, usage));
}

const usd = (usage: ModelUsage[]) => Math.round(usage.reduce((s, u) => s + (u.costUsd || 0), 0) * 1e6) / 1e6;

// ---------------------------------------------------------------------------------------------------------------
// Steps

/**
 * What to judge: the indexes of the job's eval items, and the task of its dataset (params.datasetId) when it has one.
 * Nothing when it has no eval items or a summary already, and nothing when MODEL_API_KEY isn't set or the platform's
 * daily spend cap is reached: then it saves an unjudged summary that says why, and logs it.
 */
export async function judgePlanStep(jobId: string): Promise<{ indexes: number[]; task: string | null }> {
  "use step";
  const none = { indexes: [], task: null };
  const indexes = await fromDb(() => listEvalIndexes(jobId));
  if (!indexes.length) return none;
  const job = await fromDb(() => getJob(jobId));
  if (!job || job.evalSummary) return none;
  const skip = !process.env.MODEL_API_KEY
    ? "MODEL_API_KEY isn't set"
    : (await fromDb(() => spendPaused()))
      ? "the platform's daily spend cap is reached"
      : null;
  if (skip) {
    const note = `Judging skipped: ${skip}.`;
    await fromDb(() => setEvalSummary(jobId, unjudgedSummary(note)));
    await fromDb(() => recordEvent(jobId, { type: "log", text: note }));
    return none;
  }
  const datasetId = typeof job.params?.datasetId === "string" ? job.params.datasetId : null;
  const dataset = datasetId ? await fromDb(() => getDataset(datasetId)) : null;
  const n = indexes.length;
  await fromDb(() => recordEvent(jobId, { type: "log", text: `Muse Spark 1.3 is judging ${n} eval item${n === 1 ? "" : "s"}.` }));
  return { indexes, task: dataset?.task ?? null };
}
judgePlanStep.maxRetries = 3;

/**
 * Judges one eval item: Muse Spark 1.3 scores the base and the tuned answer against the reference, blind. Records the
 * usage, then logs the verdict as a "judgement" event, and returns it with what it cost. An item that already has a
 * judgement (an earlier attempt logged it) is returned as it is, at no cost; a missing item is null.
 */
export async function judgeStep(jobId: string, index: number, task: string | null): Promise<JudgedItem | null> {
  "use step";
  const done = await fromDb(() => getJudgement(jobId, index));
  if (done) return { baseScore: done.baseScore, tunedScore: done.tunedScore, better: done.better, costUsd: 0 };
  const item = await fromDb(() => getEvalItem(jobId, index));
  if (!item) return null;

  const baseFirst = index % 2 === 0;
  let result: StructuredResult<Verdict>;
  try {
    result = await respondStructured({
      model: JUDGE_MODEL,
      instructions: JUDGE_INSTRUCTIONS,
      content: [
        textPart(
          judgeRequest({
            task,
            prompt: item.prompt,
            reference: item.reference,
            a: baseFirst ? item.base : item.tuned,
            b: baseFirst ? item.tuned : item.base,
          }),
        ),
      ],
      schema: VerdictSchema,
      schemaName: "eval_verdict",
      effort: "low",
      normalize: normalizeVerdict,
    });
  } catch (err) {
    if (err instanceof StructuredOutputError) {
      // Both attempts were billed. Another try would most likely fail the same way.
      await recordJudgeUsage(err.usage);
      throw new FatalError(err.message);
    }
    throw err;
  }
  await recordJudgeUsage(result.usage);

  const v = result.data;
  const baseScore = judgeScore(baseFirst ? v.scoreA : v.scoreB);
  const tunedScore = judgeScore(baseFirst ? v.scoreB : v.scoreA);
  const said = v.better === "tie" ? "tie" : (v.better === "A") === baseFirst ? "base" : "tuned";
  const better = betterOf(baseScore, tunedScore, said);
  await fromDb(() => recordEvent(jobId, { type: "judgement", index, baseScore, tunedScore, better, note: v.note }));
  return { baseScore, tunedScore, better, costUsd: usd(result.usage) };
}
judgeStep.maxRetries = 2;

/**
 * Writes the job's eval summary from the judged items and logs it. When none could be judged it saves an unjudged
 * summary that says so, logs that and returns null. Never touches the job's status.
 */
export async function saveEvalSummaryStep(jobId: string, items: JudgedItem[], asked: number): Promise<EvalSummary | null> {
  "use step";
  if (!items.length) {
    const note = `Judging failed: none of the ${asked} eval items could be judged.`;
    await fromDb(() => setEvalSummary(jobId, unjudgedSummary(note)));
    await fromDb(() => recordEvent(jobId, { type: "log", text: note }));
    return null;
  }
  const s = summarizeJudgements(items);
  await fromDb(() => setEvalSummary(jobId, s));
  const text =
    `Judged ${s.items} of ${asked} eval items: the tuned model was better on ${s.tunedWins}, the base model on ` +
    `${s.baseWins}, and ${s.ties} tied. Average score ${s.avgTunedScore} tuned, ${s.avgBaseScore} base. ` +
    `Judging cost $${s.judgeCostUsd.toFixed(4)}.`;
  await fromDb(() => recordEvent(jobId, { type: "log", text }));
  return s;
}
saveEvalSummaryStep.maxRetries = 20;
