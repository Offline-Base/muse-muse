import { isCrossSite, requireAdminOrAutomation } from "@/lib/auth";
import { refundIfCardPaid } from "@/lib/drive/checkout";
import { parseAdminChange, toAdminRow } from "@/lib/drive/logic";
import { adminMove, getOrder } from "@/lib/drive/store";
import { errorJson, readJson, route } from "@/lib/http";
import { noStore } from "../../../shared";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST {status: "invoiced" | "paid" | "cancelled" | "shipped" | "delivered", invoiceRef?, amountText?, carrier?,
 * tracking?, note?} -> {order}: the admin queue's actions (docs/VIBE_TUNING.md, Feature 6). Invoiced needs the invoice
 * reference and the amount as the invoice states it, Shipped the carrier and tracking number. Each is checked against
 * the allowed moves (lib/drive/logic.ts), so flashing and checked only ever come from the bench. A card order is paid
 * on Stripe, never invoiced or marked paid here, and cancelling one that was paid refunds the card (refundIfCardPaid). Admin or automation
 * only, and not from another site (403 cross_site). 400 with a sentence and its `field`, 404 not_found, 409
 * bad_transition with {status} for a move the order's status doesn't allow.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (isCrossSite(req.headers)) return errorJson(403, "cross_site");
  await requireAdminOrAutomation(req);
  const { id } = await params;
  const parsed = parseAdminChange(await readJson(req, 8 * 1024));
  if (!parsed.ok) return errorJson(400, parsed.error, { field: parsed.field });
  const before = await getOrder(id);
  if (!before) return errorJson(404, "not_found");
  if (before.payment === "card" && (parsed.value.to === "invoiced" || parsed.value.to === "paid")) {
    return errorJson(409, "bad_transition", { status: before.status });
  }
  const done = await adminMove(before.id, parsed.value);
  const moved = done ? await refundIfCardPaid(done) : null;
  if (!moved) {
    const now = await getOrder(before.id);
    return errorJson(409, "bad_transition", { status: now?.status ?? before.status });
  }
  return Response.json({ order: toAdminRow(moved, new Date()) }, { headers: noStore });
});
