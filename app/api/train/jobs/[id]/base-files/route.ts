import { errorJson, route } from "@/lib/http";
import { gatedBaseFiles } from "@/lib/train/base-check";
import { getJob } from "@/lib/train/store";
import { requireJobToken } from "../../../shared";

type Ctx = { params: Promise<{ id: string }> };

export const maxDuration = 60;

/**
 * POST (the job's token) -> 200 {files}: a gated base's files for this job's GPU, from the base the platform checked and
 * wrote into the job's params, never from the request. Links are short-lived; HF_TOKEN stays here.
 */
export const POST = route(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireJobToken(req, id);
  const job = await getJob(id);
  if (!job) return errorJson(404, "not_found");
  const repo = job.params?.baseModel;
  const revision = job.params?.baseRevision;
  if (Number(job.params?.baseGated) !== 1 || typeof repo !== "string" || typeof revision !== "string") return errorJson(400, "This job's base isn't gated.");
  const files = await gatedBaseFiles(repo, revision);
  if (!files) return errorJson(502, "Hugging Face wouldn't list that gated model's files. Accept its license and check HF_TOKEN.");
  return Response.json({ files });
});
