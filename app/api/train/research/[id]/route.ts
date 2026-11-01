import { requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, route } from "@/lib/http";
import { getResearch } from "@/lib/train/research/store";
import { toResearchView } from "@/lib/train/research/view";

/** GET -> {research}. Admins or automation, 404 with TUNE_RESEARCH off or an unknown id. */
export const GET = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireAdminOrAutomation(req);
  if (!env.tuneResearch) return errorJson(404, "not_found");
  const row = await getResearch((await ctx.params).id);
  if (!row) return errorJson(404, "not_found");
  return Response.json({ research: toResearchView(row) });
});
