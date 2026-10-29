import { serialFor, toBenchOrder } from "@/lib/drive/logic";
import { claimFlashing, getOrder } from "@/lib/drive/store";
import { errorJson, readJson, route } from "@/lib/http";
import { noStore, requireBench } from "../../../shared";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST {serial} -> {order}: the bench starts writing a stick for a paid order, which becomes "flashing" (docs/VIBE_TUNING.md,
 * Feature 6). The serial must be the order's own (serialFor), so one order never gets two. Claiming an order it already
 * claimed is fine, for a run that stopped part way. The bench token, or an admin or automation. 400 another serial, 404
 * not_found, 409 not_claimable with {status} for an order that isn't paid.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  await requireBench(req);
  const { id } = await params;
  const body = await readJson(req, 4 * 1024);
  const before = await getOrder(id);
  if (!before) return errorJson(404, "not_found");
  if (body.serial !== serialFor(before.id)) return errorJson(400, "That isn't this order's serial.", { serial: serialFor(before.id) });
  const claimed = await claimFlashing(before.id, serialFor(before.id));
  if (!claimed) return errorJson(409, "not_claimable", { status: before.status });
  return Response.json({ order: toBenchOrder(claimed) }, { headers: noStore });
});
