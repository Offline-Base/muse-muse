import { requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, route } from "@/lib/http";
import { platformApi } from "@/lib/train/fireworks/api";
import { fwNames } from "@/lib/train/fireworks/rows";
import { removeFromFireworks } from "@/lib/train/fireworks/steps";
import { getJob } from "@/lib/train/store";
import { isTrainTerminal } from "@/lib/train/types";

type Ctx = { params: Promise<{ jobId: string }> };

async function fireworksJob(req: Request, ctx: Ctx) {
  await requireAdminOrAutomation(req);
  if (!env.fireworksTune) return null;
  const job = await getJob((await ctx.params).jobId);
  return job?.params?.trainer === "fireworks" ? job : null;
}

/** GET -> {files}: an adapter's file names on Fireworks, what can be exported. Admins or automation. Signed addresses stay on the server. */
export const GET = route(async (req: Request, ctx: Ctx) => {
  const job = await fireworksJob(req, ctx);
  if (!job) return errorJson(404, "not_found");
  try {
    return Response.json({ files: await platformApi().modelFiles(fwNames(job.id).model) });
  } catch {
    return errorJson(502, "fireworks_refused");
  }
});

/** DELETE -> removes everything of an ended job from Fireworks: its job, adapter, rows and batch jobs. 409 while it runs. */
export const DELETE = route(async (req: Request, ctx: Ctx) => {
  const job = await fireworksJob(req, ctx);
  if (!job) return errorJson(404, "not_found");
  if (!isTrainTerminal(job.status)) return errorJson(409, "still_running");
  const problems = await removeFromFireworks(job.id, true);
  return problems.length ? errorJson(502, "fireworks_refused", { problems }) : Response.json({ removed: true });
});
