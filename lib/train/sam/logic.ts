// U2 SHIM of U1's lib/train/sam/logic.ts (tg-sam-core owns it). Only the four functions the routes call, with the
// signatures U2 assumed. On merge, take U1's file and drop this one; if U1's signatures differ, adapt the routes.
import { SAM_TUNE_LIMITS, type SamReportIn, type SamRunView } from "@/lib/train/sam/types";

/** A sentence saying what is wrong with the object's word, or null when it is fine. */
export function wordProblem(word: string): string | null {
  return SAM_TUNE_LIMITS.wordRe.test(word) ? null : "The name has to be one word of 2 to 24 lowercase letters.";
}

/** A sentence saying what is wrong with the generic word, or null when it is fine. */
export function genericProblem(generic: string): string | null {
  return SAM_TUNE_LIMITS.genericRe.test(generic) ? null : "The everyday word has to be 2 to 24 lowercase letters or spaces.";
}

/** Minutes on the board and the run's whole Meta cost in USD (what it spent so far plus what is left to spend). */
export function planFor(run: Pick<SamRunView, "data" | "costUsd" | "photos" | "distractors">): { minutes: number; costUsd: number } {
  return { minutes: run.data === "builtin-muse" ? 30 : 40, costUsd: run.costUsd };
}

/** Schema check of what the board posts to /done. */
export function validateReportIn(input: unknown): { ok: true; report: SamReportIn } | { ok: false; problem: string } {
  if (!input || typeof input !== "object" || (input as { version?: unknown }).version !== 1) {
    return { ok: false, problem: "report.version has to be 1" };
  }
  return { ok: true, report: input as SamReportIn };
}
