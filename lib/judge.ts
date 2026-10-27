import type { Brief } from "@/lib/brief/schema";
import type { JudgeVerdict, ModelUsage, Reference, Screenshot } from "@/lib/types";

/**
 * CONTRACT (owned by the brief agent).
 *
 * Prompt 4 in docs/PROMPTS.md: Muse Spark 1.3 sees the brief, the image inspo and the screenshots, and returns
 * { pass, reasons, mismatches } as structured output. Only image references are shown to the judge; other kinds are
 * described from the brief. With no screenshots it fails with a reason instead of calling the model.
 */
export async function judgeBuild(input: {
  brief: Brief;
  references: Reference[];
  screenshots: Screenshot[];
}): Promise<{ verdict: JudgeVerdict; usage: ModelUsage[]; costUsd: number }> {
  void input;
  throw new Error("judgeBuild: not implemented");
}
