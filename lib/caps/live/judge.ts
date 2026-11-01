import type { Brief } from "@/lib/brief/schema";
import { liveBlock } from "@/lib/caps/live/brief";

/** The judge's note for live captions and updates (docs/CAPABILITIES.md, section 13). */
export function liveJudgeNote(brief: Brief): string {
  const live = liveBlock(brief);
  if (!live) return "";
  return [
    live.captions ? "Captions came from a sample recording, so their words have nothing to do with the product's subject, and they may read a little rough." : "",
    live.updates ? "The screenshot captioned 'Second browser live' was taken without a reload." : "",
  ]
    .filter(Boolean)
    .join(" ");
}
