import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { errorJson, isUuid, readJson, route } from "@/lib/http";

const STATUSES = ["open", "closed", "dismissed"] as const;

/**
 * POST {status: "closed" | "dismissed" | "open"} -> 200 {ok, id, status}. An admin closes a report (it was acted on),
 * dismisses it, or opens it again (TRUST_REPORTS). 404 with the flag off or for an unknown report.
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  if (!env.trustReports) return errorJson(404, "not_found");
  const admin = await requireAdmin();
  const { id } = await params;
  if (!isUuid(id)) return errorJson(404, "not_found");
  const status = (await readJson(req, 1024)).status;
  if (!STATUSES.includes(status as (typeof STATUSES)[number])) return errorJson(400, `status must be one of ${STATUSES.join(", ")}.`);
  const open = status === "open";
  const [row] = await db()
    .update(schema.abuseReports)
    .set({ status: status as (typeof STATUSES)[number], handledBy: open ? null : admin.id, handledAt: open ? null : new Date() })
    .where(eq(schema.abuseReports.id, id))
    .returning({ id: schema.abuseReports.id, status: schema.abuseReports.status });
  if (!row) return errorJson(404, "not_found");
  return Response.json({ ok: true, ...row });
});
