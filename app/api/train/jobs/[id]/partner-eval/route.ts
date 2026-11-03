import { start } from "workflow/api";
import { requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, readJson, route } from "@/lib/http";
import { partnerDeps } from "@/lib/train/partner/deps";
import { partnerChoice } from "@/lib/train/partner/logic";
import { partnerOffers } from "@/lib/train/partner/offers";
import { partnerEvalJob } from "@/lib/train/partner/workflow";
import { getJob, listPartnerEvals } from "@/lib/train/store";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET -> {results, offers}: the job's partner evals, oldest first, and per partner whether it can go, why not, and the
 * most it would cost (lib/train/partner/offers.ts). POST {provider?, providers?, again?} -> 202 {runId, providers}:
 * starts one partner, or several in turn (`providers`: "all" or a list), for a job that has already been judged
 * (lib/train/partner/workflow.ts). Admins or automation only; 404 with PARTNER_EVALS off, before anything is read. The
 * plan step checks the rest (HOST_TUNED, the hosting checks, the budget, one at a time) and records why when one doesn't
 * go, so the job's log and its run room say it.
 */
export const GET = route(async (req: Request, { params }: Ctx) => {
  if (!env.partnerEvalProvider) return errorJson(404, "not_found");
  await requireAdminOrAutomation(req);
  const { id } = await params;
  if (!(await getJob(id))) return errorJson(404, "not_found");
  const [results, offers] = await Promise.all([listPartnerEvals(id), partnerOffers(id, partnerDeps()).catch(() => null)]);
  return Response.json({ results, offers }, { headers: { "cache-control": "no-store" } });
});

export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.partnerEvalProvider) return errorJson(404, "not_found");
  await requireAdminOrAutomation(req);
  const { id } = await params;
  const body = req.headers.get("content-length") === "0" ? {} : await readJson(req).catch(() => ({}) as Record<string, unknown>);
  const choice = partnerChoice(body, env.partnerEvalProviders);
  if (!choice.ok) return errorJson(400, "invalid_arguments", { reason: choice.reason });
  const job = await getJob(id);
  if (!job) return errorJson(404, "not_found");
  if (job.status !== "succeeded") return errorJson(409, "not_finished", { reason: "Only a job that succeeded and was judged can be evaluated on a partner." });
  const [first, ...rest] = choice.providers;
  const { runId } = await start(partnerEvalJob, [{ jobId: id, provider: first, ...(rest.length ? { providers: choice.providers } : {}), ...(body.again === true ? { again: true } : {}) }]);
  return Response.json({ runId, providers: choice.providers }, { status: 202 });
});
