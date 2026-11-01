import type { Brief } from "@/lib/brief/schema";
import { dataBlock } from "@/lib/caps/data/brief";

/** The judge's note for a product that saves data (docs/CAPABILITIES.md, section 9). */
export function dataJudgeNote(brief: Brief): string {
  const block = dataBlock(brief);
  if (!block) return "";
  const shared = block.collections.some((c) => c.scope === "shared");
  return shared
    ? "This product saves data. The screenshot captioned 'Second browser' shows what another person sees after a reload. Fail it if an item the brief says is shared is missing there, or if an item the brief keeps private shows there."
    : "This product saves data. The screenshot captioned 'Second browser' shows another browser after a reload. Fail it if an item the brief keeps private to one person shows there.";
}
