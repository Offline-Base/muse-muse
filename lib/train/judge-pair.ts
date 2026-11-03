/**
 * One blind verdict on a base and a tuned answer (judgePair), and the helpers it needs. A plain module, not a workflow
 * file: lib/train/judge.ts's judgeStep and the partner eval (lib/train/partner) call it inside step bodies. Kept out of
 * judge.ts because an exported non-step function there stays in the workflow bundle with everything it imports (the
 * model client, the usage table, the database), which failed the production build on Nov 3.
 */
import { FatalError, RetryableError } from "workflow";
import { z } from "zod";
import { textPart } from "@/lib/brief/media";
import { cleanStrings } from "@/lib/brief/normalize";
import { respondStructured, StructuredOutputError, type StructuredResult } from "@/lib/brief/structured";
import { betterOf, judgeScore, type JudgedItem } from "@/lib/train/logic";
import type { ModelUsage } from "@/lib/types";
import { recordUsage } from "@/lib/usage";

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
export async function fromDb<T>(call: () => Promise<T>): Promise<T> {
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

/**
 * One blind verdict on a base and a tuned answer, with what it cost, its usage recorded. Not a step: judgeStep uses it,
 * and so does the partner eval (lib/train/partner), with the job's own judge so the two compare. The index decides the
 * order, base first on even ones, as for a job's own items.
 */
export async function judgePair(input: { model: string; task: string | null; index: number; prompt: string; reference: string; base: string; tuned: string }): Promise<JudgedItem & { note: string }> {
  const baseFirst = input.index % 2 === 0;
  let result: StructuredResult<Verdict>;
  try {
    result = await respondStructured({
      model: input.model,
      instructions: JUDGE_INSTRUCTIONS,
      content: [
        textPart(
          judgeRequest({
            task: input.task,
            prompt: input.prompt,
            reference: input.reference,
            a: baseFirst ? input.base : input.tuned,
            b: baseFirst ? input.tuned : input.base,
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
  return { baseScore, tunedScore, better: betterOf(baseScore, tunedScore, said), costUsd: usd(result.usage), note: v.note };
}
