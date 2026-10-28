import { requireAdminOrAutomation } from "@/lib/auth";
import { errorJson, route } from "@/lib/http";
import { toJobView } from "@/lib/train/logic";
import { getJob, listEvents } from "@/lib/train/store";

type Ctx = { params: Promise<{ id: string }> };

/** GET -> {job, events: TrainEventView[]}, oldest event first. ?after=<event id> returns only newer events. Admins only. */
export const GET = route(async (req: Request, { params }: Ctx) => {
  await requireAdminOrAutomation(req);
  const { id } = await params;
  const job = await getJob(id);
  if (!job) return errorJson(404, "not_found");
  const after = Number(new URL(req.url).searchParams.get("after") ?? 0);
  const events = await listEvents(id, Number.isFinite(after) && after > 0 ? Math.floor(after) : 0);
  return Response.json({ job: toJobView(job, new Date()), events });
});
