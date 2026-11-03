/**
 * listShippedProducts' filters on a real schema (PGlite): the gallery's published-only read leaves out a product with no
 * live link, before the limit, and the Make page's read takes only the slugs it asks for. A gallery read leaves out the
 * hidden products and puts the first-shown ones first (lib/gallery/hidden.ts). getBuildRoom drops a taken-down product.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/gallery/__tests__/shipped.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";

const canMock = typeof (mock as { module?: unknown }).module === "function";
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;

describe("listShippedProducts", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let queries: typeof import("../../queries");

  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
    mock.module(new URL("../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    queries = await import("../../queries");
    const [user] = await testDb.insert(realSchema.users).values({ email: `${randomUUID()}@example.com` }).returning();
    const [muse] = await testDb.insert(realSchema.inspirations).values({ userId: user!.id }).returning();
    const at = (min: number) => new Date(Date.UTC(2026, 10, 2, 12, min));
    // Newest first: two unpublished ones on top, so a filter after the limit would come back short.
    const rows: Array<{ slug: string; status: "live" | "partial" | "failed"; liveUrl: string | null; min: number }> = [
      { slug: "no-link", status: "live", liveUrl: null, min: 9 },
      { slug: "empty-link", status: "partial", liveUrl: "", min: 8 },
      { slug: "failed-one", status: "failed", liveUrl: "https://musemuse-failed-one.vercel.app", min: 7 },
      { slug: "published-partial", status: "partial", liveUrl: "https://musemuse-published-partial.vercel.app", min: 6 },
      { slug: "published-live", status: "live", liveUrl: "https://musemuse-published-live.vercel.app", min: 5 },
    ];
    for (const r of rows) {
      await testDb.insert(realSchema.products).values({ slug: r.slug, name: r.slug, ownerId: user!.id, inspirationId: muse!.id, status: r.status, liveUrl: r.liveUrl, updatedAt: at(r.min) });
    }
  });
  after(() => client.close());

  it("lists every shipped product with no filter, as the dashboard reads it", async () => {
    assert.deepEqual((await queries.listShippedProducts()).map((p) => p.slug), ["no-link", "empty-link", "published-partial", "published-live"]);
  });

  it("leaves out a product with no link before the limit when asked for published ones", async () => {
    assert.deepEqual((await queries.listShippedProducts(2, { published: true })).map((p) => p.slug), ["published-partial", "published-live"]);
  });

  it("takes only the slugs asked for, and nothing for an empty list", async () => {
    assert.deepEqual((await queries.listShippedProducts(6, { published: true, slugs: ["published-live", "no-link", "failed-one"] })).map((p) => p.slug), ["published-live"]);
    assert.deepEqual(await queries.listShippedProducts(6, { slugs: [] }), []);
  });

  it("gives a build room no product once that product is taken down, since its page is a 404", async () => {
    const [user] = await testDb.insert(realSchema.users).values({ email: `${randomUUID()}@example.com` }).returning();
    const [muse] = await testDb.insert(realSchema.inspirations).values({ userId: user!.id }).returning();
    const room = async (slug: string, takenDownAt: Date | null) => {
      const [p] = await testDb.insert(realSchema.products).values({ slug, name: slug, ownerId: user!.id, inspirationId: muse!.id, status: "live", liveUrl: `https://musemuse-${slug}.vercel.app`, takenDownAt }).returning();
      const [b] = await testDb.insert(realSchema.builds).values({ inspirationId: muse!.id, userId: user!.id, productId: p!.id }).returning();
      return queries.getBuildRoom(b!.id);
    };
    assert.equal((await room("still-up", null))?.product?.slug, "still-up");
    const down = await room("taken-down", new Date(Date.UTC(2026, 10, 1)));
    assert.ok(down, "the room itself still opens");
    assert.equal(down!.product, null);
  });

  it("leaves hidden products out of a gallery read and puts the first ones first, both before the limit", async () => {
    const { GALLERY_FIRST, HIDDEN_FROM_GALLERY } = await import("../hidden");
    const [user] = await testDb.insert(realSchema.users).values({ email: `${randomUUID()}@example.com` }).returning();
    const [muse] = await testDb.insert(realSchema.inspirations).values({ userId: user!.id }).returning();
    const first = GALLERY_FIRST[0]!;
    const hidden = HIDDEN_FROM_GALLERY[0]!;
    // The first-shown product is the oldest of all, and the hidden one the newest.
    const rows = [
      { slug: first, at: new Date(Date.UTC(2026, 9, 1)) },
      { slug: "plain-gallery-one", at: new Date(Date.UTC(2026, 11, 1)) },
      { slug: hidden, at: new Date(Date.UTC(2026, 11, 2)) },
    ];
    for (const r of rows) {
      await testDb.insert(realSchema.products).values({ slug: r.slug, name: r.slug, ownerId: user!.id, inspirationId: muse!.id, status: "live", liveUrl: `https://musemuse-${r.slug}.vercel.app`, updatedAt: r.at });
    }
    const slugs = rows.map((r) => r.slug);
    assert.deepEqual((await queries.listShippedProducts(6, { published: true, gallery: true, slugs })).map((p) => p.slug), [first, "plain-gallery-one"]);
    assert.deepEqual((await queries.listShippedProducts(1, { published: true, gallery: true })).map((p) => p.slug), [first], "first even though it's the oldest");
    const gallery = (await queries.listShippedProducts(60, { published: true, gallery: true })).map((p) => p.slug);
    assert.ok(!gallery.includes(hidden));
    assert.deepEqual(gallery.slice(0, 2), [first, "plain-gallery-one"]);
    // Without the gallery switch, as the dashboard and gadgets pages read, it's still there, newest first.
    assert.deepEqual((await queries.listShippedProducts(6, { published: true, slugs })).map((p) => p.slug), [hidden, "plain-gallery-one", first]);
  });
});
