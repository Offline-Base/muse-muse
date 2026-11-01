import type { Brief } from "@/lib/brief/schema";
import { jobsBlock } from "@/lib/caps/jobs/brief";

/** The judge's note for a product with background jobs (docs/CAPABILITIES.md, section 12). */
export function jobsJudgeNote(brief: Brief): string {
  const block = jobsBlock(brief);
  if (!block) return "";
  const notes = ["A background job ran during this test. Its result should show on a screen, such as 'Last digest'."];
  if (block.webhooks.length) notes.push("A sample payload from another service started a job, and what it led to should show too.");
  notes.push("Fail it if the product says it has already emailed, posted or paid for something by itself: a job only drafts those, and the owner confirms them.");
  return notes.join(" ");
}
