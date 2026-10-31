import { AuthError, requireAdmin } from "@/lib/auth";
import { eq } from "drizzle-orm";
import { capsProductOff, capsWatchProductOff } from "@/lib/caps/cleanup";
import { db, schema } from "@/lib/db/client";
import { setProductStatusBySlug } from "@/lib/gateway/store";

// Admin kill switch. "disabled" makes the gateway answer 403 product_disabled for every token of the product and
// takes its MCP connector offline. "live" or "partial" turns it back on.
export const runtime = "nodejs";

const STATUSES = ["disabled", "live", "partial"] as const;
type SwitchStatus = (typeof STATUSES)[number];

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
  const { slug } = await params;
  let status: unknown;
  try {
    status = ((await req.json()) as { status?: unknown })?.status;
  } catch {
    return Response.json({ error: "The body must be JSON like {\"status\":\"disabled\"}." }, { status: 400 });
  }
  if (!STATUSES.includes(status as SwitchStatus)) {
    return Response.json({ error: `status must be one of ${STATUSES.join(", ")}.` }, { status: 400 });
  }
  const updated = await setProductStatusBySlug(slug, status as SwitchStatus);
  if (!updated) return Response.json({ error: "not_found" }, { status: 404 });
  // Each cap pauses what it runs for the product (docs/CAPABILITIES.md, 2.9). Nothing is registered until a cap is ready.
  if (updated.status === "disabled" && capsWatchProductOff()) {
    const [row] = await db().select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.slug, updated.slug)).limit(1);
    if (row) await capsProductOff(row.id);
  }
  return Response.json({ ok: true, slug: updated.slug, status: updated.status });
}
