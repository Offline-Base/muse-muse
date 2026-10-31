/**
 * POST and GET /api/admin/import-product end to end on PGlite with the repo's migrations, the real parser, store and
 * guest account, with auth faked (who is asking) and the workflow's start() recorded instead of run. Admins and
 * automation only, never from another site, 503 while publishing is off, the strict parser, every row saved under the
 * guest account with its id, no usage rows, the same product again changing nothing, a slug or id another product has
 * refused, and the publish workflow started with the product, its latest build and its sandbox. Nothing reaches Neon,
 * Vercel, Blob or a sandbox.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/promote/__tests__/import-route.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { asc, eq, inArray } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import type { ImportBundle } from "../bundle";
import { LOCAL, sampleBundle, STORE } from "./fixtures";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;
const ORIGIN = "https://muse.example.com";
const AUTOMATION = "automation-secret-for-tests";
const GUEST_EMAIL = "guest@musemuse.invalid";

type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema> & {
  batch: (queries: PromiseLike<unknown>[]) => Promise<unknown[]>;
};

let client: import("@electric-sql/pglite").PGlite;
let testDb: TestDb;
let postRoute: (req: Request) => Promise<Response>;
let getRoute: (req: Request) => Promise<Response>;

/** Who requireUser says is asking: null when nobody is signed in. */
let viewer: { id: string; email: string; isAdmin: boolean; openAccess?: boolean } | null = null;
let starts: Array<{ workflow: unknown; args: unknown[] }> = [];
let startFails = false;
const savedEnv = { ...process.env };

const publishStub = async () => ({ liveUrl: null });
const guest = { id: "guest-session", email: GUEST_EMAIL, isAdmin: false, openAccess: true };
const admin = { id: randomUUID(), email: "owner@example.com", isAdmin: true };
const bot = { authorization: `Bearer ${AUTOMATION}` };

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/admin/import-product`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function get(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/admin/import-product${query}`, { headers });
}

async function counts() {
  const [products, builds, events, inspirations, usage] = await Promise.all([
    testDb.select().from(realSchema.products),
    testDb.select().from(realSchema.builds),
    testDb.select().from(realSchema.buildEvents),
    testDb.select().from(realSchema.inspirations),
    testDb.select().from(realSchema.usage),
  ]);
  return { products: products.length, builds: builds.length, events: events.length, inspirations: inspirations.length, usage: usage.length };
}

async function guestId(): Promise<string | undefined> {
  const [row] = await testDb.select().from(realSchema.users).where(eq(realSchema.users.email, GUEST_EMAIL));
  return row?.id;
}

describe("import-product route", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    const local: TestDb = Object.assign(drizzle({ client, schema: realSchema }), {
      batch: async (queries: PromiseLike<unknown>[]) => {
        const results: unknown[] = [];
        for (const q of queries) results.push(await q);
        return results;
      },
    });
    await migrate(local, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
    testDb = local;

    mock.module(at("../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    // lib/auth as it is (the same-origin check, AuthError and the guest account included), with the signed-in user
    // the test sets.
    const realAuth = (await import(at("../../auth.ts"))) as typeof import("../../auth");
    const requireUser = async () => {
      if (!viewer) throw new realAuth.AuthError("Sign in to build.", 401);
      return viewer;
    };
    mock.module(at("../../auth.ts"), {
      namedExports: {
        ...realAuth,
        requireUser,
        requireAdminOrAutomation: async (req: Request) => {
          const header = req.headers.get("authorization");
          if (header?.startsWith("Bearer ")) {
            if (header === `Bearer ${AUTOMATION}`) return admin;
            throw new realAuth.AuthError("Admins only.", 403);
          }
          const user = await requireUser();
          if (!user.isAdmin) throw new realAuth.AuthError("Admins only.", 403);
          return user;
        },
      },
    });
    mock.module("workflow/api", {
      namedExports: {
        start: async (workflow: unknown, args: unknown[]) => {
          if (startFails) throw new Error("the workflow queue didn't answer");
          starts.push({ workflow, args });
          return { runId: `run-${starts.length}` };
        },
      },
    });
    // The workflow runs its steps in its own tests (workflow.test.ts); here it only has to be the one started.
    mock.module(at("../workflow.ts"), { namedExports: { publishImportedProduct: publishStub } });
    ({ POST: postRoute, GET: getRoute } = await import(at("../../../app/api/admin/import-product/route.ts")));
  });

  after(async () => {
    mock.restoreAll();
    process.env = savedEnv;
    await client?.close();
  });

  beforeEach(async () => {
    for (const table of [realSchema.buildEvents, realSchema.builds, realSchema.products, realSchema.inspirations]) await testDb.delete(table);
    viewer = null;
    starts = [];
    startFails = false;
    // Test values, not real secrets.
    process.env.VERCEL_TOKEN = "vercel-token-for-tests";
    process.env.PLATFORM_URL = ORIGIN;
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  });

  describe("who may import", () => {
    it("is admins and automation only, and never a request from another site", async () => {
      const bundle = sampleBundle();
      viewer = guest;
      assert.equal((await postRoute(post(bundle))).status, 403, "the guest everyone shares");
      viewer = null;
      assert.equal((await postRoute(post(bundle))).status, 401, "signed out");
      assert.equal((await postRoute(post(bundle, { authorization: "Bearer wrong" }))).status, 403, "a wrong secret");
      const cross = await postRoute(post(bundle, { ...bot, "sec-fetch-site": "cross-site" }));
      assert.equal(cross.status, 403);
      assert.deepEqual(await cross.json(), { error: "cross_site" });
      const elsewhere = await postRoute(post(bundle, { ...bot, origin: "https://evil.example" }));
      assert.equal(elsewhere.status, 403);
      assert.deepEqual(await counts(), { products: 0, builds: 0, events: 0, inspirations: 0, usage: 0 });
      assert.equal(starts.length, 0);
    });

    it("answers 503 with the reason while this site doesn't publish products, after checking who asks", async () => {
      delete process.env.VERCEL_TOKEN;
      viewer = guest;
      assert.equal((await postRoute(post(sampleBundle()))).status, 403);
      const off = await postRoute(post(sampleBundle(), bot));
      assert.equal(off.status, 503);
      assert.deepEqual(await off.json(), { error: "publish_off", reason: "VERCEL_TOKEN isn't set" });
      process.env.VERCEL_TOKEN = "vercel-token-for-tests";
      process.env.PLATFORM_URL = "http://localhost:3000";
      const local = (await (await postRoute(post(sampleBundle(), bot))).json()) as { error: string; reason: string };
      assert.equal(local.error, "publish_off");
      assert.match(local.reason, /local run/);
      assert.equal((await counts()).products, 0);
      assert.equal(starts.length, 0);
    });
  });

  describe("the bundle", () => {
    it("is parsed strictly: no user id, nothing pointing back at the laptop, a live product", async () => {
      const send = async (bundle: unknown) => {
        const res = await postRoute(post(bundle, bot));
        return { status: res.status, json: (await res.json()) as { error: string; field?: string } };
      };
      const owned = JSON.parse(JSON.stringify(sampleBundle()));
      owned.product.ownerId = admin.id;
      assert.deepEqual(await send(owned), { status: 400, json: { error: "product.ownerId isn't something an import takes.", field: "product.ownerId" } });

      const local = JSON.parse(JSON.stringify(sampleBundle()));
      local.product.transcriptUrl = local.product.transcriptUrl.replace(STORE, LOCAL);
      assert.equal((await send(local)).json.field, "product.transcriptUrl");

      const partial = JSON.parse(JSON.stringify(sampleBundle()));
      partial.builds[0].status = "partial";
      assert.equal((await send(partial)).json.error, "The product's latest build is partial, not live.");

      assert.equal((await send("not json")).status, 400);
      const huge = await postRoute(post({ ...sampleBundle(), padding: "x".repeat(4 * 1024 * 1024) }, bot));
      assert.equal(huge.status, 413);
      assert.deepEqual(await counts(), { products: 0, builds: 0, events: 0, inspirations: 0, usage: 0 });
    });
  });

  describe("an import", () => {
    it("saves every row with its id under the guest account, with no usage, and starts publishing", async () => {
      const bundle = sampleBundle();
      viewer = admin;
      const res = await postRoute(post(bundle, { "sec-fetch-site": "same-origin" }));
      assert.equal(res.status, 201);
      assert.deepEqual(await res.json(), { productId: bundle.product.id, slug: "bird-count", status: "imported", publishing: true, runId: "run-1" });

      const owner = await guestId();
      assert.ok(owner, "the guest account exists");
      assert.notEqual(owner, admin.id, "never the admin who asked");
      const [p] = await testDb.select().from(realSchema.products).where(eq(realSchema.products.id, bundle.product.id));
      assert.equal(p!.ownerId, owner);
      assert.equal(p!.status, "live");
      assert.equal(p!.liveUrl, null, "no link until it is published");
      assert.equal(p!.vercelProjectId, null);
      assert.equal(p!.latestBuildId, bundle.product.latestBuildId);
      assert.equal(p!.sandboxName, bundle.product.sandboxName);
      assert.equal(p!.demoVideoUrl, bundle.product.demoVideoUrl);
      assert.deepEqual(p!.manifest, bundle.product.manifest);
      assert.equal(p!.updatedAt.toISOString(), bundle.product.updatedAt);

      const builds = await testDb.select().from(realSchema.builds).orderBy(asc(realSchema.builds.startedAt));
      assert.deepEqual(builds.map((b) => b.id), bundle.builds.map((b) => b.id));
      assert.ok(builds.every((b) => b.userId === owner && b.workflowRunId === null && b.productId === p!.id));
      assert.deepEqual(builds.map((b) => [b.status, b.costUsd, b.startedAt.toISOString()]), bundle.builds.map((b) => [b.status, b.costUsd, b.startedAt]));
      assert.deepEqual(builds[0]!.brief, bundle.builds[0]!.brief);

      const events = await testDb.select().from(realSchema.buildEvents).orderBy(asc(realSchema.buildEvents.id));
      assert.deepEqual(events.map((e) => [e.buildId, e.payload, e.at.toISOString()]), bundle.events.map((e) => [e.buildId, e.payload, e.at]), "in the bundle's order");

      const muses = await testDb
        .select()
        .from(realSchema.inspirations)
        .where(inArray(realSchema.inspirations.id, [bundle.inspiration.id, ...bundle.refineInspirations.map((i) => i.id)]));
      assert.equal(muses.length, 2);
      assert.ok(muses.every((m) => m.userId === owner));
      assert.deepEqual(muses.find((m) => m.id === bundle.inspiration.id)!.references, bundle.inspiration.references);

      assert.equal((await counts()).usage, 0, "usage would count against today's caps");
      assert.equal(starts.length, 1);
      assert.equal(starts[0]!.workflow, publishStub);
      assert.deepEqual(starts[0]!.args, [{ productId: bundle.product.id, buildId: bundle.product.latestBuildId, sandboxName: bundle.product.sandboxName }]);
    });

    it("changes nothing for the same product again, whatever the bundle says now", async () => {
      const bundle = sampleBundle();
      assert.equal((await postRoute(post(bundle, bot))).status, 201);
      const before = await counts();
      const renamed: ImportBundle = { ...bundle, product: { ...bundle.product, name: "Sparrow Count" } };
      const again = await postRoute(post(renamed, bot));
      assert.equal(again.status, 200);
      assert.deepEqual(await again.json(), { productId: bundle.product.id, slug: "bird-count", status: "already", publishing: false });
      assert.deepEqual(await counts(), before);
      const [p] = await testDb.select().from(realSchema.products).where(eq(realSchema.products.id, bundle.product.id));
      assert.equal(p!.name, "Bird Count");
      assert.equal(starts.length, 1, "publishing started once");
    });

    it("answers 409 for a slug another product has, or a build id already in use", async () => {
      const first = sampleBundle();
      await postRoute(post(first, bot));
      const before = await counts();
      const sameSlug = await postRoute(post(sampleBundle(), bot));
      assert.equal(sameSlug.status, 409);
      assert.deepEqual(await sameSlug.json(), { error: "slug_taken", slug: "bird-count" });

      const reused: ImportBundle = JSON.parse(JSON.stringify(first));
      const id = randomUUID();
      reused.product = { ...reused.product, id, slug: "bird-count-2", sandboxName: `product-bird-count-2-${id.slice(0, 8)}` };
      reused.builds = reused.builds.map((b) => ({ ...b, productId: id }));
      const ids = await postRoute(post(reused, bot));
      assert.equal(ids.status, 409);
      const json = (await ids.json()) as { error: string; ids: string[] };
      assert.equal(json.error, "ids_taken");
      assert.deepEqual(new Set(json.ids), new Set([...first.builds.map((b) => b.id), first.inspiration.id, ...first.refineInspirations.map((i) => i.id)]));
      assert.deepEqual(await counts(), before);
      assert.equal(starts.length, 1);
    });

    it("keeps the rows when publishing can't start, and says it isn't publishing", async () => {
      startFails = true;
      const bundle = sampleBundle();
      const res = await postRoute(post(bundle, bot));
      assert.equal(res.status, 201);
      assert.deepEqual(await res.json(), { productId: bundle.product.id, slug: "bird-count", status: "imported", publishing: false });
      assert.equal((await counts()).products, 1);
    });
  });

  describe("GET", () => {
    it("says where a product stands, for admins and automation only", async () => {
      const bundle = sampleBundle();
      await postRoute(post(bundle, bot));
      const res = await getRoute(get(`?productId=${bundle.product.id.toUpperCase()}`, bot));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        productId: bundle.product.id,
        slug: "bird-count",
        status: "live",
        liveUrl: null,
        latestBuildId: bundle.product.latestBuildId,
      });
      assert.equal((await getRoute(get(`?productId=${randomUUID()}`, bot))).status, 404);
      assert.equal((await getRoute(get("?productId=bird-count", bot))).status, 400);
      viewer = guest;
      assert.equal((await getRoute(get(`?productId=${bundle.product.id}`))).status, 403);
    });
  });
});
