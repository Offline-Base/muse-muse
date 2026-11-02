import type { TrainEventBody } from "@/lib/train/types";

/**
 * Stored answers the site doesn't show, by job and eval item. The rows stay in the database, with their scores in the
 * job's totals, so the record holds. Add one when an answer is unsafe to read as advice, and log it in docs/BUILD_LOG.md.
 */
const HIDDEN: ReadonlyArray<{ jobId: string; index: number; answer: "base" | "tuned"; why: string }> = [
  // Base Glimmer, prompt 40 of "Spark teaches Glimmer: brief writer (short prompt)": it told a parent short of infant
  // formula to stretch what they had with water. Hidden Nov 1, 2026, from the owner's audit.
  { jobId: "83d71f74-d84b-40bf-925a-cd36c90b6de5", index: 39, answer: "base", why: "unsafe advice about feeding a baby" },
];

/** The event's payload with any hidden answer replaced by a sentence that says so. */
export function withoutHiddenAnswers(jobId: string, payload: TrainEventBody): TrainEventBody {
  if (payload?.type !== "eval") return payload;
  const hidden = HIDDEN.find((h) => h.jobId === jobId && h.index === payload.index);
  if (!hidden) return payload;
  return { ...payload, [hidden.answer]: `Hidden: this answer gave ${hidden.why}, so it isn't shown here. Its score still counts in this run's totals.` };
}
