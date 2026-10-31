import { start } from "workflow/api";
import { guestAccount, isCrossSite, requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, isUuid, readJson, route } from "@/lib/http";
import { IMPORT_MAX_BYTES, parseImportBundle } from "@/lib/promote/bundle";
import { importedProduct, importProduct } from "@/lib/promote/store";
import { publishImportedProduct } from "@/lib/promote/workflow";

// Saving a bundle is one batch of a few statements, and the publish runs in its own workflow.
export const maxDuration = 60;

const noStore = { "cache-control": "no-store" };

/**
 * POST {product, builds, events, inspiration, refineInspirations?} -> 201 {productId, slug, status: "imported",
 * publishing, runId?} or 200 {productId, slug, status: "already", publishing: false}. Admins or automation only, never
 * from another site (403 cross_site). Imports a product built on a local run (scripts/promote-local.ts sends it): the
 * rows keep their ids, belong to the guest account every live build belongs to under OPEN_ACCESS=guest (never to a
 * user the bundle names), and are saved in one batch, with the product live and no link yet. Usage rows are never
 * imported. Then the publishImportedProduct workflow deploys the product's sandbox the way a live build does.
 * `publishing` is false when that workflow couldn't be started; the rows are saved either way. The same product again
 * changes nothing ("already").
 *
 * 400 {error, field} for a bundle the strict parser refuses (lib/promote/bundle.ts), 409 slug_taken {slug} when
 * another product has the slug, 409 ids_taken {ids} when a build or muse id is already used, 413 body_too_large, and
 * 503 publish_off {reason} while products aren't published from this site (env.publishOffReason): an import would
 * call the gateway of this site, so it has to be one products can reach.
 */
export const POST = route(async (req: Request) => {
  if (isCrossSite(req.headers)) return errorJson(403, "cross_site");
  await requireAdminOrAutomation(req);
  const off = env.publishOffReason;
  if (off) return errorJson(503, "publish_off", { reason: off });
  const parsed = parseImportBundle(await readJson(req, IMPORT_MAX_BYTES));
  if (!parsed.ok) return errorJson(400, parsed.error, { field: parsed.field });
  const bundle = parsed.value;

  const owner = await guestAccount();
  const saved = await importProduct(bundle, owner.id);
  if (saved.status === "slug_taken") return errorJson(409, "slug_taken", { slug: saved.slug });
  if (saved.status === "ids_taken") return errorJson(409, "ids_taken", { ids: saved.ids });
  const reply = { productId: saved.productId, slug: saved.slug };
  if (saved.status === "already") {
    return Response.json({ ...reply, status: "already", publishing: false }, { headers: noStore });
  }
  const { id: productId, latestBuildId: buildId, sandboxName } = bundle.product;
  try {
    const run = await start(publishImportedProduct, [{ productId, buildId, sandboxName }]);
    return Response.json({ ...reply, status: "imported", publishing: true, runId: run.runId }, { status: 201, headers: noStore });
  } catch (err) {
    console.error("[import-product] start", err);
    return Response.json({ ...reply, status: "imported", publishing: false }, { status: 201, headers: noStore });
  }
});

/**
 * GET ?productId=<uuid> -> {productId, slug, status, liveUrl, latestBuildId}: where a product stands, for the script
 * waiting on an imported product's link. Admins or automation only. 400 without a product id, 404 not_found.
 */
export const GET = route(async (req: Request) => {
  await requireAdminOrAutomation(req);
  const productId = new URL(req.url).searchParams.get("productId");
  if (!isUuid(productId)) return errorJson(400, "Pass productId, a product's id.");
  const product = await importedProduct(productId);
  if (!product) return errorJson(404, "not_found");
  return Response.json(product, { headers: noStore });
});
