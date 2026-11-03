import { env } from "@/lib/env";
import { errorJson, isUuid, readJson, route } from "@/lib/http";
import { validateReportIn } from "@/lib/train/sam/logic";
import { foreignReportUrl, imageLicenseProblem, reportBytes, SAM_TUNE_LIMITS, withServerCaptions } from "@/lib/train/sam/route-helpers";
import { finish, getRunView } from "@/lib/train/sam/store";
import { requireRunToken, requireWorker } from "@/lib/train/sam/worker-auth";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST {jobToken, report: SamReportIn} -> {status}: the board's numbers. The report is schema-checked (logic.ts
 * validateReportIn), held to 64 KB, and may link only files this run uploaded. The board sends no verdict: the store
 * writes the verdict and caveats from the numbers, so a leaked worker secret can't post an approving sentence. Status
 * done. Its words have to be the run's, every picture has to pass the license rule (route-helpers imageLicenseProblem),
 * and the captions are the server's own. 401 wrong secret or token, 413 too_large, 400 bad_report {message}, 409 not_running, 404 SAM_TUNE off.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.samTune) return errorJson(404, "not_found");
  await requireWorker(req);
  const { id } = await params;
  if (!isUuid(id)) return errorJson(404, "not_found");
  const body = await readJson(req, SAM_TUNE_LIMITS.reportMaxBytes + 1024);
  await requireRunToken(req, id, typeof body.jobToken === "string" ? body.jobToken : "");
  if (reportBytes(body.report) > SAM_TUNE_LIMITS.reportMaxBytes) return errorJson(413, "too_large");
  const checked = validateReportIn(body.report);
  if (!checked.ok) return errorJson(400, "bad_report", { message: checked.problem });
  const foreign = foreignReportUrl(checked.report, id);
  if (foreign !== null) return errorJson(400, "bad_report", { message: "The report may link only files this run uploaded." });
  const view = await getRunView(id);
  if (!view || (view.status !== "claimed" && view.status !== "running")) return errorJson(409, "not_running");
  // The numbers have to be about this run's own words: a report for another word can't be filed under this one.
  if (checked.report.word !== view.word || checked.report.generic !== view.generic) {
    return errorJson(400, "bad_report", { message: "The report's word and generic word have to be this run's." });
  }
  const licenseProblem = imageLicenseProblem(checked.report.images ?? [], view.data);
  if (licenseProblem) return errorJson(400, "bad_report", { message: licenseProblem });
  const report = { ...checked.report, images: withServerCaptions(checked.report.images ?? [], view.word, view.generic) };
  const run = await finish(id, report);
  if (!run) return errorJson(409, "not_running");
  return Response.json({ status: run.status });
});
