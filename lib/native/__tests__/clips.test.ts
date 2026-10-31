/**
 * Clips an owner uploads: POST and DELETE /api/products/<slug>/clips, on a real Postgres (an in-memory PGlite with the repo's
 * migrations). Who may act, the folder a presigned URL is held to, the limit, and that the route is gone with every flag off.
 * Auth and the Blob API are faked; the presigning itself is @vercel/blob's own.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/native/__tests__/clips.test.ts
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { CLIP_ACCEPT, CLIP_MAX_BYTES, clipFailureMessage } from "@/components/product/OwnerClips";
import * as realSchema from "@/lib/db/schema";
import type { ProductClip } from "@/lib/types";

const canMock = typeof (mock as { module?: unknown }).module === "function";
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;
type User = { id: string; email: string; isAdmin: boolean; openAccess?: boolean };

const OWNER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000009";
const INSPIRATION = "00000000-0000-4000-8000-000000000002";
const PRODUCT = "10000000-0000-4000-8000-000000000001";
const OFF = "10000000-0000-4000-8000-000000000002";
const BLOB_HOST = "https://teststore.public.blob.vercel-storage.com";
const FOLDER = `clips/${PRODUCT}/`;
const FILE = `${BLOB_HOST}/${FOLDER}abc-quest.mp4`;

let client: import("@electric-sql/pglite").PGlite;
let testDb: TestDb;
let routes: typeof import("../../../app/api/products/[slug]/clips/route");
let clips: typeof import("../clips");
let user: User | null;
let deleted: string[];
let issued: Array<Record<string, unknown>>;
const savedEnv = { ...process.env };

class FakeAuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}

const ctx = (slug = "quest-app") => ({ params: Promise.resolve({ slug }) });
const json = (method: string, body: unknown) =>
  new Request("https://muse.example/api/products/quest-app/clips", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const presign = (pathname: unknown) => ({ type: "blob.generate-presigned-url", payload: { pathname, multipart: true, clientPayload: null } });

async function stored(id = PRODUCT): Promise<ProductClip[]> {
  const [row] = await testDb.select({ c: realSchema.products.extraClips }).from(realSchema.products).where(eq(realSchema.products.id, id));
  return row!.c;
}

describe("product clips", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
    await testDb.insert(realSchema.users).values([
      { id: OWNER, email: "owner@example.com" },
      { id: OTHER, email: "other@example.com" },
    ]);
    await testDb.insert(realSchema.inspirations).values({ id: INSPIRATION, userId: OWNER, note: "A note." });
    const blob = await import("@vercel/blob");
    mock.module("@vercel/blob", {
      namedExports: {
        ...blob,
        del: async (url: string) => void deleted.push(url),
        issueSignedToken: async (opts: Record<string, unknown>) => {
          issued.push(opts);
          const scope = { storeId: "teststore", pathname: opts.pathname, operations: opts.operations, validUntil: opts.validUntil, allowedContentTypes: opts.allowedContentTypes, maximumSizeInBytes: opts.maximumSizeInBytes };
          return { delegationToken: `${Buffer.from(JSON.stringify(scope)).toString("base64url")}.sig`, clientSigningToken: "test-signing-key", validUntil: opts.validUntil };
        },
      },
    });
    mock.module(new URL("../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    mock.module(new URL("../../auth.ts", import.meta.url).href, {
      namedExports: {
        AuthError: FakeAuthError,
        requireUser: async () => {
          if (!user) throw new FakeAuthError("signed_out", 401);
          return user;
        },
        canActAsOwner: (u: User | null, ownerId: string | null) => Boolean(u && (u.isAdmin || (!u.openAccess && u.id === ownerId))),
      },
    });
    routes = await import(new URL("../../../app/api/products/[slug]/clips/route.ts", import.meta.url).href);
    clips = await import("../clips");
  });

  after(async () => {
    mock.restoreAll();
    process.env = savedEnv;
    await client.close();
  });

  beforeEach(async () => {
    process.env.VR_ENABLED = "1";
    process.env.BLOB_STORE_ID = "store_teststore";
    process.env.VERCEL = "1";
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.BLOB_WEBHOOK_PUBLIC_KEY;
    user = { id: OWNER, email: "owner@example.com", isAdmin: false };
    deleted = [];
    issued = [];
    await testDb.delete(realSchema.rateLimits);
    await testDb.delete(realSchema.products);
    await testDb.insert(realSchema.products).values([
      { id: PRODUCT, slug: "quest-app", name: "Quest App", ownerId: OWNER, inspirationId: INSPIRATION, status: "live" },
      { id: OFF, slug: "turned-off", name: "Off", ownerId: OWNER, inspirationId: INSPIRATION, status: "disabled" },
    ]);
  });

  it("isn't there with every flag off", async () => {
    delete process.env.VR_ENABLED;
    delete process.env.NATIVE_TARGETS;
    delete process.env.GLASSES_ENABLED;
    delete process.env.AGENTS_ENABLED;
    assert.equal((await routes.POST(json("POST", { url: FILE, caption: "Filmed on a Quest" }), ctx())).status, 404);
    assert.equal((await routes.DELETE(json("DELETE", { url: FILE }), ctx())).status, 404);
    assert.deepEqual(await stored(), []);
  });

  it("is only for the owner or an admin of a shipped product", async () => {
    const add = () => routes.POST(json("POST", { url: FILE, caption: "Filmed on a Quest" }), ctx());
    user = null;
    assert.equal((await add()).status, 401);
    user = { id: OTHER, email: "other@example.com", isAdmin: false };
    assert.equal((await add()).status, 403);
    // The guest everyone shares on the live site owns nothing, even a product with its id on it.
    user = { id: OWNER, email: "guest@example.com", isAdmin: false, openAccess: true };
    assert.equal((await add()).status, 403);
    assert.deepEqual(await stored(), []);
    user = { id: OTHER, email: "admin@example.com", isAdmin: true };
    assert.equal((await add()).status, 200);
    assert.equal((await routes.POST(json("POST", { url: FILE, caption: "A clip" }), ctx("turned-off"))).status, 404);
    assert.equal((await routes.POST(json("POST", { url: FILE, caption: "A clip" }), ctx("NOT A SLUG"))).status, 404);
  });

  it("presigns only inside this product's folder, with a clip's limits", async () => {
    const pathname = `${FOLDER}0b6f2a8e-quest.mp4`;
    const res = await routes.POST(json("POST", presign(pathname)), ctx());
    assert.equal(res.status, 200);
    const body = (await res.json()) as { type: string; presignedUrlPayload: { params: Record<string, string> } };
    assert.equal(body.type, "blob.generate-presigned-url");
    assert.equal(issued.length, 1);
    assert.equal(issued[0]!.pathname, pathname);
    assert.deepEqual(issued[0]!.operations, ["put"]);
    assert.deepEqual(issued[0]!.allowedContentTypes, ["video/mp4", "video/quicktime", "video/webm"]);
    assert.equal(issued[0]!.maximumSizeInBytes, 500 * 1024 * 1024);

    issued = [];
    for (const bad of [`clips/${OFF}/a.mp4`, "inspo/a.mp4", FOLDER, `${FOLDER}../${OFF}/a.mp4`, `${FOLDER}a//b.mp4`, `native/shells/1/a.apk`]) {
      assert.equal((await routes.POST(json("POST", presign(bad)), ctx())).status, 400, bad);
    }
    assert.equal(issued.length, 0);
  });

  it("limits how many uploads a person starts in an hour", async () => {
    const pathname = `${FOLDER}a.mp4`;
    for (let i = 0; i < 30; i++) assert.equal((await routes.POST(json("POST", presign(pathname)), ctx())).status, 200);
    const res = await routes.POST(json("POST", presign(pathname)), ctx());
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: "upload_limit" });
  });

  it("says when Blob can't issue uploads", async () => {
    delete process.env.BLOB_STORE_ID;
    const res = await routes.POST(json("POST", presign(`${FOLDER}a.mp4`)), ctx());
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "uploads_unavailable" });
  });

  it("adds a clip from this product's folder, with a tidied caption it requires", async () => {
    const res = await routes.POST(json("POST", { url: FILE, caption: "  Filmed on a\n Meta Quest 3 " }), ctx());
    assert.equal(res.status, 200);
    const [clip] = await stored();
    assert.equal(clip!.url, FILE);
    assert.equal(clip!.caption, "Filmed on a Meta Quest 3");
    assert.equal(clip!.posterUrl, null);
    assert.ok(Date.parse(clip!.addedAt));

    for (const caption of ["", "   ", 7, null, "x".repeat(301)]) {
      assert.equal((await routes.POST(json("POST", { url: FILE, caption }), ctx())).status, 400);
    }
    for (const url of [`https://evil.example/${FOLDER}a.mp4`, `${BLOB_HOST}/clips/${OFF}/a.mp4`, `${BLOB_HOST}/inspo/a.mp4`, `http://teststore.public.blob.vercel-storage.com/${FOLDER}a.mp4`, `${BLOB_HOST}/${FOLDER}%2e%2e/%2e%2e/a.mp4`, "javascript:alert(1)", 7]) {
      assert.equal((await routes.POST(json("POST", { url, caption: "A clip" }), ctx())).status, 400, String(url));
    }
    assert.equal((await stored()).length, 1);
  });

  it("stops at the limit, even with uploads landing together", async () => {
    const results = await Promise.all(Array.from({ length: 14 }, (_, i) => clips.addClip(PRODUCT, { url: `${FILE}${i}`, posterUrl: null, caption: "A clip", addedAt: new Date().toISOString() })));
    assert.equal(results.filter(Boolean).length, 12);
    assert.equal((await stored()).length, 12);
    assert.equal((await routes.POST(json("POST", { url: FILE, caption: "One more" }), ctx())).status, 409);
  });

  it("removes a clip and its file, and leaves the others", async () => {
    await routes.POST(json("POST", { url: FILE, caption: "First" }), ctx());
    await routes.POST(json("POST", { url: `${FILE}2`, caption: "Second" }), ctx());
    assert.equal((await routes.DELETE(json("DELETE", { url: FILE }), ctx())).status, 200);
    assert.deepEqual((await stored()).map((c) => c.caption), ["Second"]);
    assert.deepEqual(deleted, [FILE]);
    assert.equal((await routes.DELETE(json("DELETE", { url: FILE }), ctx())).status, 404);
    assert.equal((await routes.DELETE(json("DELETE", { url: `${BLOB_HOST}/inspo/a.mp4` }), ctx())).status, 400);
    assert.equal((await routes.DELETE(json("DELETE", { url: `${FILE}2` }), ctx())).status, 200);
    assert.deepEqual(await stored(), []);
  });

  it("keeps the page's limits in step with the server's", () => {
    assert.deepEqual(CLIP_ACCEPT.split(","), [...clips.CLIP_CONTENT_TYPES]);
    assert.equal(CLIP_MAX_BYTES, clips.MAX_CLIP_BYTES);
  });

  it("tells the person what went wrong, in words they can use", () => {
    assert.match(clipFailureMessage(429, "upload_limit"), /too many uploads/);
    assert.match(clipFailureMessage(503, "uploads_unavailable"), /aren't set up/);
    assert.match(clipFailureMessage(403, "forbidden"), /owner/);
    assert.equal(clipFailureMessage(409, "Remove one first."), "Remove one first.");
    assert.match(clipFailureMessage(500, "boom"), /didn't go through/);
  });
});
