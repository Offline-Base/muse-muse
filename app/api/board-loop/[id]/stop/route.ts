import { requireAdminOrAutomation } from "@/lib/auth";
import { loopBoard, tryBoard } from "@/lib/board-loop/boards";
import { BoardOfflineError } from "@/lib/board-loop/driver";
import { getLoop, requestStop, saveLoop } from "@/lib/board-loop/store";
import { tickLoop } from "@/lib/board-loop/tick";
import { env } from "@/lib/env";
import { errorJson, route } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

export const maxDuration = 60;

/**
 * POST -> 202: closes the try page and stops the board here and now, not on the workflow's next tick: that run ends at its
 * hard stop, and a board left serving after it must still stop. Only the stop branch of a tick can run, so the rest is unused.
 * A tick that was mid-stage may save over this, and the next one stops again. Admins or automation only.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.boardLoop) return errorJson(404, "not_found");
  await requireAdminOrAutomation(req);
  const row = await getLoop((await params).id);
  if (!row) return errorJson(404, "not_found");
  await requestStop(row.id);
  await tickLoop(row.id, {
    load: getLoop,
    save: saveLoop,
    // Never starts a simulated board just to stop it: one that's gone is already stopped.
    async board(target) {
      if (target !== "simulated") return loopBoard(target);
      const board = await tryBoard(target);
      if (!board) throw new BoardOfflineError("The simulated board isn't running.");
      return board;
    },
    job: async () => null,
    localFiles: async () => null,
    recordClip: async () => ({ skipped: "Stopped." }),
    now: () => new Date(),
  });
  return Response.json({ stopping: true }, { status: 202 });
});
