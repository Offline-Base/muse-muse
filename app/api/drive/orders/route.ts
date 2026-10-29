import { requireAdminOrAutomation } from "@/lib/auth";
import { toAdminRow } from "@/lib/drive/logic";
import { listOrders, purgeDriveOrders } from "@/lib/drive/store";
import { route } from "@/lib/http";
import { noStore } from "../shared";

/**
 * GET -> {open, closed}: the admin queue (docs/VIBE_TUNING.md, Feature 6), every open order oldest first and the latest
 * delivered or cancelled ones, each with the actions it allows and the 2-business-day highlight. Admin or automation
 * only. Old buyers' details are purged first, so the queue never shows what should be gone.
 */
export const GET = route(async (req: Request) => {
  await requireAdminOrAutomation(req);
  await purgeDriveOrders();
  const now = new Date();
  const { open, closed } = await listOrders();
  return Response.json(
    { open: open.map((r) => toAdminRow(r, now)), closed: closed.map((r) => toAdminRow(r, now)) },
    { headers: noStore },
  );
});
