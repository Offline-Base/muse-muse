import { start } from "workflow/api";
import { guestAccount, isCrossSite, requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, isUuid, readJson, route } from "@/lib/http";
import { IMPORT_MAX_BYTES, parseImportBundle } from "@/lib/promote/bundle";
import { claimPublish, endPublish, importedProduct, importObstacle, importProduct, type ImportResult } from "@/lib/promote/store";
import { publishImportedProduct } from "@/lib/promote/workflow";

// Saving a bundle is one batch of a few statements, and the publish runs in its own workflow.
export const maxDuration = 60;

const noStore = { "cache-control": "no-store" };

/** The 409 for a slug another product has or an id already in use. */
function refused(result: Extract<ImportResult, { status: "slug_taken" | "ids_taken" }>): Response {
  return result.status === "slug_taken"
    ? errorJson(409, "slug_taken", { slug: result.slug })
    : errorJson(409, "ids_taken", { ids: result.ids });
}

/**
 * POST {product, builds, events, inspiration, refineInspirations?} -> 201 {productId, slug, status: "imported",
 * publishing, runId?} or 200 {productId, slug, status: "already", publishing: false}. Admins or automation only, never
 * from another site (403 cross_site). Imports a product built on a local run (scripts/promote-local.ts sends it): the
 * rows keep their ids, belong to the guest account every live build belongs to under OPEN_ACCESS=guest (never to a
 * user the bundle names), and are saved in one batch, with the product live and no link yet. Usage rows are never
 * imported, and the builds never count against the guest's daily builds. Then the publishImportedProduct workflow
 * deploys the product's sandbox the way a live build does, once the route has claimed the publish (claimPublish).
 * `publishing` is false when that workflow couldn't be started; the rows are saved either way. The same product again
 * changes nothing ("already").
 *
 * ?check=1 checks the bundle the same way, the parser and every 409 included, and writes nothing: 200 {productId,
 * slug, status: "ready"} when it would be imported, or status "already". The script asks this before it uploads any
 * file, so a bundle this site refuses leaves nothing in its store.
 *
 * ?republish=1 also publishes again a product imported here that is live with no link of its own, once its last
 * publish has ended (it failed, couldn't start, or started over half an hour ago and never said how it ended): 200
 * {status: "already", publishing: true, runId}, with the latest build and sandbox this site has for it, whatever the
 * bundle says now. 409 publish_running while one is still going, so two deploys never revoke each other's live tokens.
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
  const query = new URL(req.url).searchParams;
  const parsed = parseImportBundle(await readJson(req, IMPORT_MAX_BYTES));
  if (!parsed.ok) return errorJson(400, parsed.error, { field: parsed.field });
  const bundle = parsed.value;

  if (query.get("check") === "1") {
    const found = await importObstacle(bundle);
    if (found?.status === "slug_taken" || found?.status === "ids_taken") return refused(found);
    return Response.json({ productId: bundle.product.id, slug: bundle.product.slug, status: found ? "already" : "ready" }, { headers: noStore });
  }

  const owner = await guestAccount();
  const saved = await importProduct(bundle, owner.id);
  if (saved.status === "slug_taken" || saved.status === "ids_taken") return refused(saved);
  const imported = saved.status === "imported";
  const answer = (publishing: boolean, runId?: string) =>
    Response.json(
      { productId: saved.productId, slug: saved.slug, status: saved.status, publishing, ...(runId ? { runId } : {}) },
      { status: imported ? 201 : 200, headers: noStore },
    );
  if (!imported && query.get("republish") !== "1") return answer(false);

  const claim = await claimPublish(saved.productId, { again: !imported });
  if (!claim.claimed) {
    // A product this request just imported is only running when a ?republish=1 at the same moment claimed it first,
    // so it is publishing all the same.
    if (claim.running && !imported) return errorJson(409, "publish_running");
    return answer(claim.running);
  }
  const { buildId, sandboxName } = claim;
  try {
    const run = await start(publishImportedProduct, [{ productId: saved.productId, buildId, sandboxName }]);
    return answer(true, run.runId);
  } catch (err) {
    console.error("[import-product] start", err);
    // Ends the claim, so ?republish=1 can try again at once.
    await endPublish(buildId, "It could not be started.").catch((e) => console.error("[import-product] end", e));
    return answer(false);
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
