import type { Brief } from "@/lib/brief/schema";
import { codeBlock } from "@/lib/caps/code/brief";

/** The judge's note for a product that runs code (docs/CAPABILITIES.md, section 15). */
export function codeJudgeNote(brief: Brief): string {
  const block = codeBlock(brief);
  if (!block) return "";
  const parts = ["This product runs code. Judge whether the program's output shows next to the code that made it."];
  if (block.museCode) {
    parts.push(
      "It runs Muse Code tasks. Judge whether the run screen shows the steps, the files changed, the final answer and the cost, with a Stop button and a download, and the line saying the task is sent to Meta. A run that says it made nothing didn't work, whatever its status says. Runs shown before the real one may be a recorded sample.",
    );
  }
  if (block.browse) parts.push("Pages opened in this test are samples, so their words won't match the address typed. Judge whether the product shows the page's title and text, not what they say.");
  return parts.join(" ");
}
