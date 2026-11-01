import { refuseCrossSite, requireBoardOwner } from "@/lib/caps/hardware/admin";
import { boardRegistryOn } from "@/lib/caps/hardware/flags";
import { linkBoard, ownsBoard, productBySlug, unlinkBoard } from "@/lib/caps/hardware/store";
import { errorJson, HttpError, readJson, route } from "@/lib/http";

// Links one of a person's boards to one of their products (docs/CAPABILITIES.md, section 19). Admins only for now
// (decision 16), and an admin is no exception to ownership here: the gateway only honors a link when the board's owner is
// the product's owner, so someone else's product can't be linked at all.
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownProduct(slug: string, userId: string) {
  const product = await productBySlug(slug);
  if (!product) throw new HttpError(404, "not_found");
  if (product.ownerId !== userId) throw new HttpError(403, "not_your_product");
  return product;
}

/** POST {boardId, visitors} -> {ok}: this product reaches this board. `visitors` is off unless it is exactly true. */
export const POST = route(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  if (!boardRegistryOn()) return errorJson(404, "not_found");
  refuseCrossSite(req);
  const user = await requireBoardOwner();
  const product = await ownProduct((await params).slug, user.id);
  const body = await readJson(req, 4 * 1024);
  if (typeof body.boardId !== "string" || !UUID.test(body.boardId) || !(await ownsBoard(body.boardId, user.id))) return errorJson(404, "board_not_found");
  await linkBoard(product.id, body.boardId, body.visitors === true);
  return Response.json({ ok: true });
});

/** DELETE -> {ok}: this product reaches no board. */
export const DELETE = route(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  if (!boardRegistryOn()) return errorJson(404, "not_found");
  refuseCrossSite(req);
  const user = await requireBoardOwner();
  const product = await ownProduct((await params).slug, user.id);
  await unlinkBoard(product.id);
  return Response.json({ ok: true });
});
