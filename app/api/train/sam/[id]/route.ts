import { AuthError, requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, isUuid, route } from "@/lib/http";
import { publicRun } from "@/lib/train/sam/route-helpers";
import { getRunView } from "@/lib/train/sam/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET -> {run}. Admins or automation get the whole view (photos, look-alikes, stage, queue, board last seen, costs).
 * Anyone else gets {run: SamPublicRun} only when an admin marked the finished run shown: the report and the total cost,
 * with no photos, worker name or caps. Otherwise 404, the same answer as an unknown id. Off with SAM_TUNE: 404.
 */
export const GET = route(async (req: Request, { params }: Ctx) => {
  if (!env.samTune) return errorJson(404, "not_found");
  const { id } = await params;
  if (!isUuid(id)) return errorJson(404, "not_found");
  let admin = false;
  try {
    await requireAdminOrAutomation(req);
    admin = true;
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
  }
  const view = await getRunView(id);
  if (!view) return errorJson(404, "not_found");
  if (admin) return Response.json({ run: view });
  const shown = publicRun(view);
  if (!shown) return errorJson(404, "not_found");
  return Response.json({ run: shown }, { headers: { "cache-control": "no-store" } });
});
