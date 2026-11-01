import { requireAdmin } from "@/lib/auth";
import { boardRegistryOn } from "@/lib/caps/hardware/flags";
import { revokeBoard } from "@/lib/caps/hardware/store";
import { errorJson, route } from "@/lib/http";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** DELETE -> {ok}: removes the admin's own board. Its address and token are wiped, and its product links go. */
export const DELETE = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  if (!boardRegistryOn()) return errorJson(404, "not_found");
  const user = await requireAdmin();
  const { id } = await params;
  if (!UUID.test(id) || !(await revokeBoard(id, user.id, new Date()))) return errorJson(404, "not_found");
  return Response.json({ ok: true });
});
