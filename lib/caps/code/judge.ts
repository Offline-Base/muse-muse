import type { Brief } from "@/lib/brief/schema";
import { codeBlock } from "@/lib/caps/code/brief";

/** The judge's note for a product that runs code (docs/CAPABILITIES.md, section 15). */
export function codeJudgeNote(brief: Brief): string {
  const block = codeBlock(brief);
  if (!block) return "";
  const parts = ["This product runs code. Judge whether the program's output shows next to the code that made it."];
  if (block.browse) parts.push("Pages opened in this test are samples, so their words won't match the address typed. Judge whether the product shows the page's title and text, not what they say.");
  return parts.join(" ");
}
