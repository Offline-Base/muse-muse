import type { Brief } from "@/lib/brief/schema";
import { connectBlock } from "@/lib/caps/connect/brief";

/** The judge's note for a product that reaches outside services (docs/CAPABILITIES.md, section 11). */
export function connectJudgeNote(brief: Brief): string {
  const block = connectBlock(brief);
  if (!block) return "";
  const notes: string[] = [];
  if (block.publicApis.length) notes.push("Outside facts in this test (weather, articles, books, earthquakes) are recorded samples from those APIs. Judge that the product shows them clearly with their credit line, not whether they are current.");
  if (block.keys.length) notes.push("A key the owner saved must never show on any screen. Fail it if one does.");
  if (block.sends.length) notes.push("Messages, payments and posts in this test are samples. A card that says 'Sent (sample)' is the product working.");
  return notes.join(" ");
}
