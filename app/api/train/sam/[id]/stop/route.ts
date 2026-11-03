import { requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, isUuid, route } from "@/lib/http";
import { getRunView, requestStop } from "@/lib/train/sam/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST -> {run}: Stop. A draft or queued run stops at once; a claimed or running one is marked, and the board stops at
 * its next progress call ({stop: true}) and reports through /fail. Admins or automation. 404 unknown or SAM_TUNE off,
 * 409 already_ended.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.samTune) return errorJson(404, "not_found");
  await requireAdminOrAutomation(req);
  const { id } = await params;
  if (!isUuid(id)) return errorJson(404, "not_found");
  const run = await requestStop(id);
  if (run) return Response.json({ run });
  return (await getRunView(id)) ? errorJson(409, "already_ended") : errorJson(404, "not_found");
});
