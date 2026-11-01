import type { Brief } from "@/lib/brief/schema";

/** The judge's note for a game on an engine (docs/CAPABILITIES.md, section 20). */
export function gamesJudgeNote(_brief: Brief): string {
  return "Game screenshots come from software rendering, so plain lighting and jagged edges are expected. Judge whether the game is there and playable from what shows, not its graphics quality.";
}
