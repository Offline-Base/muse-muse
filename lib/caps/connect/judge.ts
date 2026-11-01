import type { Brief } from "@/lib/brief/schema";
import { connectBuildBlock } from "@/lib/caps/connect/brief";

/** The judge's note for a product that reaches outside services (docs/CAPABILITIES.md, section 11). */
export function connectJudgeNote(brief: Brief): string {
  const block = connectBuildBlock(brief);
  if (!block) return "";
  const notes: string[] = [];
  if (block.publicApis.length) notes.push("Outside facts in this test (weather, articles, books, earthquakes) are recorded samples from those APIs. Judge that the product shows them clearly with their credit line, not whether they are current.");
  if (block.keys.length) notes.push("A key the owner saved must never show on any screen. Fail it if one does.");
  if (block.sends.length) {
    notes.push(
      "Messages, payments and posts in this test are samples. A card that says 'Sent (sample)' is the product working. Before anything is sent, the owner must see a confirmation card with the whole message on it, and nothing may send until the owner presses Confirm on that card. Fail it if a message goes out with no card first, if the card leaves part of the message out, or if the product confirms by itself.",
    );
  }
  return notes.join(" ");
}
