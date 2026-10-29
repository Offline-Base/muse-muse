import { parseBenchReport, serialFor } from "@/lib/drive/logic";
import { getOrder, reportFlashed } from "@/lib/drive/store";
import { errorJson, readJson, route } from "@/lib/http";
import { noStore, requireBench } from "../../../shared";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST {serial, manifestSha256, result: "PASS" | "FAIL", imageVersion?} -> {status}: the bench's check of the stick it
 * wrote, read back after a replug (docs/VIBE_TUNING.md, Feature 6). PASS makes the order "checked", ready to ship. FAIL
 * puts it back in the queue as "paid", so a stick that failed never ships. Only for an order flashing under its own
 * serial. The bench token, or an admin or automation. 400 bad input, 404 not_found, 409 not_flashing with {status}.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  await requireBench(req);
  const { id } = await params;
  const parsed = parseBenchReport(await readJson(req, 4 * 1024));
  if (!parsed.ok) return errorJson(400, parsed.error, { field: parsed.field });
  const before = await getOrder(id);
  if (!before) return errorJson(404, "not_found");
  if (parsed.value.serial !== serialFor(before.id)) return errorJson(400, "That isn't this order's serial.", { field: "serial" });
  const after = await reportFlashed(before.id, parsed.value);
  if (!after) return errorJson(409, "not_flashing", { status: before.status });
  return Response.json({ status: after.status }, { headers: noStore });
});
