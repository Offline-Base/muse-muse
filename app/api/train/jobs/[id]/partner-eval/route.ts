import { start } from "workflow/api";
import { requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, readJson, route } from "@/lib/http";
import { isPartnerProvider } from "@/lib/train/partner/logic";
import { partnerEvalJob } from "@/lib/train/partner/workflow";
import { getJob, listPartnerEvals } from "@/lib/train/store";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET -> {results}: the job's partner evals, oldest first. POST {provider?, again?} -> 202 {runId}: starts one for a job
 * that has already been judged (lib/train/partner/workflow.ts). Admins or automation only; 404 with PARTNER_EVALS off,
 * before anything is read. The plan step checks the rest (HOST_TUNED, the hosting checks, the budget, one at a time) and
 * records why when it doesn't go, so the job's log and its run room say it.
 */
export const GET = route(async (req: Request, { params }: Ctx) => {
  if (!env.partnerEvalProvider) return errorJson(404, "not_found");
  await requireAdminOrAutomation(req);
  const { id } = await params;
  if (!(await getJob(id))) return errorJson(404, "not_found");
  return Response.json({ results: await listPartnerEvals(id) }, { headers: { "cache-control": "no-store" } });
});

export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.partnerEvalProvider) return errorJson(404, "not_found");
  await requireAdminOrAutomation(req);
  const { id } = await params;
  const body = req.headers.get("content-length") === "0" ? {} : await readJson(req).catch(() => ({}) as Record<string, unknown>);
  if (body.provider !== undefined && !isPartnerProvider(body.provider)) return errorJson(400, "invalid_arguments", { reason: "provider is baseten or modal." });
  const job = await getJob(id);
  if (!job) return errorJson(404, "not_found");
  if (job.status !== "succeeded") return errorJson(409, "not_finished", { reason: "Only a job that succeeded and was judged can be evaluated on a partner." });
  const { runId } = await start(partnerEvalJob, [{ jobId: id, ...(isPartnerProvider(body.provider) ? { provider: body.provider } : {}), ...(body.again === true ? { again: true } : {}) }]);
  return Response.json({ runId }, { status: 202 });
});
