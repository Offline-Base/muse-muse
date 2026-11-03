import { requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, isUuid, readJson, route } from "@/lib/http";
import { getRunView, markShown } from "@/lib/train/sam/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST {shown?: boolean} -> {run}: lets signed-out visitors read a finished run's report (true, the default) or hides
 * it again (false). Admins or automation. Only a done run with a report can be shown: 409 not_done. 404 unknown or
 * SAM_TUNE off.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.samTune) return errorJson(404, "not_found");
  await requireAdminOrAutomation(req);
  const { id } = await params;
  if (!isUuid(id)) return errorJson(404, "not_found");
  // An empty body means show it. Anything else has to be a JSON object.
  const body = (await req.clone().text()).trim() ? await readJson(req, 1024) : {};
  if (body.shown !== undefined && typeof body.shown !== "boolean") return errorJson(400, "bad_request", { message: "shown is true or false." });
  const shown = body.shown !== false;
  const view = await getRunView(id);
  if (!view) return errorJson(404, "not_found");
  if (shown && (view.status !== "done" || !view.report)) return errorJson(409, "not_done");
  const run = await markShown(id, shown);
  return run ? Response.json({ run }) : errorJson(404, "not_found");
});
