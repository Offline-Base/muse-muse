import { requireAdminOrAutomation } from "@/lib/auth";
import { loopView } from "@/lib/board-loop/logic";
import { getLoop } from "@/lib/board-loop/store";
import { env } from "@/lib/env";
import { errorJson, route } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET -> the loop's stages, costs, test record and clip. Admins or automation only. */
export const GET = route(async (req: Request, { params }: Ctx) => {
  if (!env.boardLoop) return errorJson(404, "not_found");
  await requireAdminOrAutomation(req);
  const row = await getLoop((await params).id);
  if (!row) return errorJson(404, "not_found");
  return Response.json(loopView(row), { headers: { "cache-control": "no-store" } });
});
