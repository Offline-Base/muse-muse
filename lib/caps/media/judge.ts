import type { Brief } from "@/lib/brief/schema";
import { mediaBlock, mediaPartsOf } from "@/lib/caps/media/brief";

/** The judge's note for media made in the browser (docs/CAPABILITIES.md, section 14). */
export function mediaJudgeNote(brief: Brief): string {
  const parts = mediaPartsOf(mediaBlock(brief));
  const counts = parts.includes("samTiling")
    ? " Counts on a test photo come from at most 4 tiles, so a crowded photo may show an \"at least\" count."
    : "";
  return `Video and audio made in the browser may look and sound plain in this test. Judge whether each result is there and usable from what shows, not its polish.${counts}`;
}
