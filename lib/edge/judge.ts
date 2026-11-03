/**
 * What the screenshot judge and the requirement checks need to know about an edge product's board (edge-honest unit,
 * Nov 3). The Nov 3 target audit found a cold-room watcher whose "Board Mode" screen showed a cloud-labeled answer under
 * an "Office board preview" heading, and whose board-backup requirement was marked met on that answer. These are kept
 * here, beside the drills, for lib/prompts/judge.ts and lib/full to use; neither is wired there by this unit.
 * EDGE_BOARD_STATUS_JUDGE_NOTE can go in on its own. EDGE_BOARD_REQUIREMENT_JUDGE_NOTE goes in only with the requirement
 * test it points to: boardBackupDrilled() for each requirement isBoardRequirement() picks.
 *
 * Pure and env-free.
 */
import type { DrillRow } from "@/lib/edge/drills";

/**
 * A note for the screenshot judge of an edge product, after EDGE_JUDGE_NOTE. In the test no board is connected, so the
 * honest "Not connected to a board" line is the product working; a board screen that shows a cloud answer is not. Safe to
 * wire on its own: every edge product now shows that line (the muse-edge skill), and without this note the judge may read
 * it as error copy on a working screen.
 */
export const EDGE_BOARD_STATUS_JUDGE_NOTE =
  'The product shows a board status line. No board is connected in this test, so "Not connected to a board" (or "Checking for a board" before the check comes back) is the truth and the product working, and so is a board screen that says it isn\'t connected and that the cloud model wasn\'t asked. Fail it when a screen, tab or mode that says it shows the board (Board, Board mode, Offline preview, On the Jetson) shows an answer labeled "Answered in the cloud" or "Seen in the cloud", or when any screen says a board answered or is connected while its status line says "Not connected to a board".';

/**
 * The part of the note about board requirements. Wire it only together with the drill-backed requirement test: it tells
 * the judge to go by that test, so each requirement isBoardRequirement() picks must get boardBackupDrilled()'s result
 * (lib/full/requirements, requirementTestsText). Alone it would leave such a requirement with "no test ran for it".
 */
export const EDGE_BOARD_REQUIREMENT_JUDGE_NOTE =
  "A requirement about the board backup, or about answering when the cloud is cut, is never proven by an answer labeled in the cloud, so never cite one as its evidence. The simulated outage drills check that backup, and their result comes to you as that requirement's test: go by it.";

/** Both parts, for a judge that has the drill-backed requirement test wired. */
export const EDGE_BOARD_JUDGE_NOTE = `${EDGE_BOARD_STATUS_JUDGE_NOTE} ${EDGE_BOARD_REQUIREMENT_JUDGE_NOTE}`;

/** True for a requirement about the board backup: what the screenshots can't show and the drills check. */
export function isBoardRequirement(text: string): boolean {
  return /\b(edge board|on the board|board backup|backup (model|answer)|jetson|offline|cloud (is |was )?(cut|down|out|unreachable)|without the cloud|when the cloud)\b/i.test(text);
}

/**
 * Whether the build's drills proved the board backup, as far as a simulation can: every drill passed, and both fallback
 * drills ran for the main answer (1 and 2) or the look (12 and 13). False with no drills. This is the machine check a
 * board requirement can rest on instead of a screenshot; it says nothing about a real board.
 */
export function boardBackupDrilled(drills: readonly DrillRow[] | null | undefined): boolean {
  if (!drills?.length || !drills.every((d) => d.ok)) return false;
  const ran = (ids: number[]) => ids.every((id) => drills.some((d) => d.id === id));
  return ran([1, 2]) || ran([12, 13]);
}
