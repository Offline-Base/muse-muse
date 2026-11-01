import type { Brief } from "@/lib/brief/schema";
import { GLIMMER_CANNED_USAGE, GLIMMER_CLOSED_USAGE, usesSharedGlimmer } from "@/lib/caps/gpu/marker";

/** The judge's note for a product on the shared endpoint (section 17). Empty otherwise, so the instructions are today's. */
export function gpuJudgeNote(brief: Partial<Brief>): string {
  return usesSharedGlimmer(brief as Brief) ? "Glimmer's answers in this test are samples, so don't judge their words. Check that an answer shows, and that the product says when Muse Wonder answered instead." : "";
}

/**
 * The gateway's own record of a build's Glimmer calls as fixed-check lines for the judge. GPU has no overlay, so no caps step
 * in verify reads it.
 */
export function gpuProofLines(counts: Record<string, number>): string[] {
  return [
    `- glimmer, reply: ${(counts[GLIMMER_CANNED_USAGE] ?? 0) > 0 ? "passed" : "failed"}`,
    `- glimmer, closed-window: ${(counts[GLIMMER_CLOSED_USAGE] ?? 0) > 0 ? "passed" : "failed"}`,
  ];
}
