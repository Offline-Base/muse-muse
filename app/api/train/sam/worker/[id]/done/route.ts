import { env } from "@/lib/env";
import { errorJson, isUuid, readJson, route } from "@/lib/http";
import { foreignReportUrl, reportBytes, SAM_TUNE_LIMITS } from "@/lib/train/sam/route-helpers";
import { finish } from "@/lib/train/sam/store";
import type { SamReportIn } from "@/lib/train/sam/types";
import { requireRunToken, requireWorker } from "@/lib/train/sam/worker-auth";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST {jobToken, report: SamReportIn} -> {status}: the board's numbers. Held to 64 KB, and every link has to be one of
 * this run's own report/ uploads. The store (lib/train/sam/store.ts finish) checks the rest against the run with
 * logic.ts validateReportIn: the run's word, generic word, seed and board, the counts, the license and credit of every
 * picture. It rebuilds the report field by field, writes the captions, the verdict and the caveats itself, and marks
 * the run done. The board sends no sentence a visitor reads, so a leaked worker secret can't post an approving one.
 * 401 wrong secret, 404 wrong job token or SAM_TUNE off, 413 too_large, 400 bad_report {message}.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.samTune) return errorJson(404, "not_found");
  requireWorker(req);
  const { id } = await params;
  if (!isUuid(id)) return errorJson(404, "not_found");
  const body = await readJson(req, SAM_TUNE_LIMITS.reportMaxBytes + 1024);
  const jobToken = typeof body.jobToken === "string" ? body.jobToken : "";
  await requireRunToken(req, id, jobToken);
  const bytes = reportBytes(body.report);
  if (bytes > SAM_TUNE_LIMITS.reportMaxBytes) return errorJson(413, "too_large");
  if (!body.report || typeof body.report !== "object") return errorJson(400, "bad_report", { message: "report" });
  if (foreignReportUrl(body.report as SamReportIn, id) !== null) {
    return errorJson(400, "bad_report", { message: "The report may link only files this run uploaded." });
  }
  const done = await finish(id, jobToken, body.report, bytes);
  if (!done.ok) return done.status === 404 ? errorJson(409, "not_running") : errorJson(done.status, "bad_report", { message: done.error });
  return Response.json({ status: "done" });
});
