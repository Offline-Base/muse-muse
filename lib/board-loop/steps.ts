/**
 * The board loop's one step: a tick, with the real things behind it. See ./tick.ts. Everything stays inside the step, so the
 * workflow's own bundle, which allows no Node modules, never keeps what it imports.
 */
import { loopBoard } from "@/lib/board-loop/boards";
import { recordClipHere } from "@/lib/board-loop/clip";
import { getLoop, saveLoop } from "@/lib/board-loop/store";
import { tickLoop, type TickResult } from "@/lib/board-loop/tick";
import { localFilesFor } from "@/lib/train/local-files-server";
import { getJob } from "@/lib/train/store";

export async function tickStep(loopId: string): Promise<TickResult> {
  "use step";
  return tickLoop(loopId, {
    load: getLoop,
    save: saveLoop,
    board: loopBoard,
    async job(id) {
      const job = await getJob(id);
      return job ? { status: job.status, costUsd: job.costUsd, judgeCostUsd: job.evalSummary?.judgeCostUsd ?? 0, error: job.error } : null;
    },
    localFiles: localFilesFor,
    recordClip: (row) => recordClipHere(row),
    now: () => new Date(),
  });
}
