import { start } from "workflow/api";
import { requireAdminOrAutomation } from "@/lib/auth";
import { judgedProblem } from "@/lib/board-loop/logic";
import { insertLoop, saveLoop, setLoopRun } from "@/lib/board-loop/store";
import { boardLoop } from "@/lib/board-loop/workflow";
import { env } from "@/lib/env";
import { errorJson, readJson, route } from "@/lib/http";
import { POST as startQuantize } from "@/app/api/train/jobs/[id]/quantize/route";
import { localFilesFor } from "@/lib/train/local-files-server";
import { getJob } from "@/lib/train/store";
import { loopFile } from "@/lib/board-loop/tick";

export const maxDuration = 60;

/**
 * POST {adapterJobId} -> 202 {id}: the one start action on a judged model (docs/BOARD_LOOP.md). Admins or automation only. 404
 * with BOARD_LOOP off, 409 not_judged or board_busy. A real board with no file yet starts a local files job through the
 * quantize route itself, so it gets every check and cap a GPU job gets. A simulated board never starts a GPU.
 */
export const POST = route(async (req: Request) => {
  if (!env.boardLoop) return errorJson(404, "not_found");
  const user = await requireAdminOrAutomation(req);
  const { adapterJobId } = await readJson(req);
  if (typeof adapterJobId !== "string") return errorJson(400, "adapterJobId");
  const job = await getJob(adapterJobId);
  const problem = judgedProblem(job);
  if (problem) return errorJson(409, "not_judged", { message: problem });

  const target = env.boardLoopTarget;
  const row = await insertLoop({ adapterJobId, target, title: job!.title, quantJobId: null, createdBy: user.openAccess ? null : user.id });
  if (!row) return errorJson(409, "board_busy", { message: "This board already has a loop going. Stop it first." });

  if (target !== "simulated" && !loopFile(await localFilesFor(adapterJobId))) {
    const res = await startQuantize(
      new Request(new URL(`/api/train/jobs/${adapterJobId}/quantize`, req.url), { method: "POST", headers: req.headers }),
      { params: Promise.resolve({ id: adapterJobId }) },
    );
    if (res.status !== 202) {
      const reply = (await res.clone().json().catch(() => null)) as { message?: string; error?: string } | null;
      row.stages.gguf = { ...row.stages.gguf, status: "failed", detail: reply?.message ?? reply?.error ?? "The local files job didn't start.", finishedAt: new Date().toISOString() };
      row.status = "failed";
      await saveLoop(row);
      return res;
    }
    const { quantJobId } = (await res.json()) as { quantJobId: string };
    row.data.quantJobId = quantJobId;
    await saveLoop(row);
  }

  try {
    const { runId } = await start(boardLoop, [{ loopId: row.id }]);
    await setLoopRun(row.id, runId);
  } catch (err) {
    // Left as running, this row would hold the board's one slot with nothing driving it.
    row.stages.tune = { ...row.stages.tune, status: "failed", detail: "The run didn't start.", finishedAt: new Date().toISOString() };
    row.status = "failed";
    await saveLoop(row);
    throw err;
  }
  return Response.json({ id: row.id }, { status: 202, headers: { "cache-control": "no-store" } });
});
