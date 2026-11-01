import type { Brief } from "@/lib/brief/schema";
import { GLIMMER_CANNED_USAGE, GLIMMER_CLOSED_USAGE, usesSharedGlimmer } from "@/lib/caps/gpu/marker";

/** The judge's note for a product on the shared endpoint (section 17). Empty otherwise, so the instructions are today's. */
export function gpuJudgeNote(brief: Partial<Brief>): string {
  return usesSharedGlimmer(brief as Brief) ? "Glimmer's answers in this test are samples, so don't judge their words. Check that an answer shows, and that the product says when Muse Wonder answered instead." : "";
}

/** What the judge is told about these lines when no cap's fixed checks come before them. They decide nothing. */
export const GPU_PROOF_FRAME = "What the platform recorded about this build's calls to Muse Glimmer. These only say a call was made, so check the screenshots for what it showed:";

/**
 * The gateway's own record of a build's Glimmer calls, for the judge. Not a fixed check: nothing in verify reads it, and a
 * call being made doesn't prove the product showed the answer or the note. So it says what was recorded, never "passed".
 */
export function gpuProofLines(counts: Record<string, number>): string[] {
  const seen = (n: number | undefined) => ((n ?? 0) > 0 ? "yes" : "no");
  return [
    `- gateway record, not a check of the screen: the test got a sample Glimmer reply: ${seen(counts[GLIMMER_CANNED_USAGE])}`,
    `- gateway record, not a check of the screen: the test tried a closed window: ${seen(counts[GLIMMER_CLOSED_USAGE])}`,
  ];
}
