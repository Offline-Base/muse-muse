import type { Brief } from "@/lib/brief/schema";
import type { JudgeVerdict, RebuildTarget, VerifySummary } from "@/lib/types";

/**
 * CONTRACT (owned by the brief agent). Pure functions that render prompts 2, 3 and 5 from docs/PROMPTS.md.
 */

/** brief.md, the prompt file for the first `muse exec`. */
export function renderBuildPrompt(
  brief: Brief,
  opts: {
    /** File names inside inspo/, in reference order. */
    inspoFiles: string[];
    /** File names inside fixtures/ with descriptions. */
    fixtures: Array<{ fileName: string; description: string }>;
    maxModelSteps: number;
    rebuildOf?: RebuildTarget | null;
  },
): string {
  void brief;
  void opts;
  throw new Error("renderBuildPrompt: not implemented");
}

/** fix.md for a fix round, run with --session-id so Muse Code keeps its context. */
export function renderFixPrompt(input: { verify: VerifySummary | null; judge: JudgeVerdict | null; round: number }): string {
  void input;
  throw new Error("renderFixPrompt: not implemented");
}

/** The prompt for a user's follow-up change to a shipped product. */
export function renderRefinePrompt(input: {
  message: string;
  newReferences: Array<{ fileName: string; describes: string }>;
}): string {
  void input;
  throw new Error("renderRefinePrompt: not implemented");
}

/** The brief as readable markdown for the product page's "what it was asked to make". */
export function briefToMarkdown(brief: Brief): string {
  void brief;
  throw new Error("briefToMarkdown: not implemented");
}
