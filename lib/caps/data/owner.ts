import { DATA_LIMITS } from "@/lib/caps/data/limits";
import type { DataStore } from "@/lib/caps/data/store";
import { COLLECTION_NAME } from "@/lib/caps/data/types";

/**
 * GET {PLATFORM_URL}/api/products/<slug>/data for the product's builder or an admin (docs/CAPABILITIES.md, section 9),
 * after the route checked who is asking. Live rows only. With no `collection`: every collection with its scope and
 * counts. With a shared `collection`: a page of its items, newest first, `after` for the next page; that is the export.
 * A private collection's items are never shown here, only its counts.
 */
export async function handleOwnerData(req: Request, productId: string, store: DataStore): Promise<Response> {
  const url = new URL(req.url);
  const collection = url.searchParams.get("collection");
  const all = await store.collections(productId, "live");
  const counts = all.map((c) => ({ name: c.collection, scope: c.scope, rows: c.rows, bytes: c.bytes }));
  if (!collection) return Response.json({ collections: counts }, { headers: { "cache-control": "no-store" } });
  if (!COLLECTION_NAME.test(collection)) return Response.json({ error: "That isn't a collection name." }, { status: 400 });
  const scopes = new Set(all.filter((c) => c.collection === collection).map((c) => c.scope));
  if (scopes.size && !scopes.has("shared")) {
    return Response.json({ error: "This collection is private to each person: you can see its counts, not its items." }, { status: 403 });
  }
  const after = url.searchParams.get("after");
  const page = await store.query({
    productId,
    namespace: "live",
    collection,
    scope: "shared",
    ownerKey: null,
    where: null,
    order: "newest",
    limit: DATA_LIMITS.pageMax,
    after: after && after.length <= 200 ? after : null,
  });
  return Response.json({ collection, ...page }, { headers: { "cache-control": "no-store" } });
}
