import { requireAdmin } from "@/lib/auth";
import { boardRegistryOn } from "@/lib/caps/hardware/flags";
import { registerBoard, type RegisterRefusal } from "@/lib/caps/hardware/registry";
import { listBoards, ownProducts } from "@/lib/caps/hardware/store";
import { errorJson, readJson, route } from "@/lib/http";

// The board registry (docs/CAPABILITIES.md, section 19). Admins only for now (decision 16). A reply never holds a board's
// address or token. The check that a new board answers takes up to 15 seconds.
export const runtime = "nodejs";
export const maxDuration = 30;

const STATUS: Record<RegisterRefusal, number> = {
  invalid_name: 400,
  invalid_token: 400,
  unsafe_address: 400,
  board_unreachable: 502,
  not_a_board: 422,
  too_many_boards: 429,
  key_missing: 503,
};

/** GET -> {boards, products}: the admin's own boards, and their products to link one to. */
export const GET = route(async () => {
  if (!boardRegistryOn()) return errorJson(404, "not_found");
  const user = await requireAdmin();
  const [boards, products] = await Promise.all([listBoards(user.id), ownProducts(user.id)]);
  return Response.json({ boards, products });
});

/** POST {name, mcpUrl, token} -> 201 {id}: registers a muse-device board once it answers describe_device. */
export const POST = route(async (req: Request) => {
  if (!boardRegistryOn()) return errorJson(404, "not_found");
  const user = await requireAdmin();
  const body = await readJson(req, 8 * 1024);
  const result = await registerBoard({ name: body.name, mcpUrl: body.mcpUrl, token: body.token }, user.id);
  if (!result.ok) return errorJson(STATUS[result.error], result.error);
  return Response.json({ id: result.id }, { status: 201 });
});
