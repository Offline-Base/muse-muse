/**
 * The board loop's durable run (docs/BOARD_LOOP.md): tick, sleep for what the tick said, until the loop ends. Once the try
 * page is open it only watches for Stop, slowly. The hard stop bounds it; the board goes on serving until someone
 * presses Stop, and the try page reads the board itself, so nothing depends on this run being alive.
 */
import { sleep } from "workflow";
import { tickStep } from "@/lib/board-loop/steps";

const HARD_STOP_MS = 12 * 3_600_000;

export async function boardLoop(input: { loopId: string }): Promise<void> {
  "use workflow";
  const started = Date.now();
  while (Date.now() - started < HARD_STOP_MS) {
    const { done, waitMs } = await tickStep(input.loopId);
    if (done) return;
    if (waitMs > 0) await sleep(waitMs);
  }
}
