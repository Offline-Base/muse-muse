/**
 * POST and GET /api/admin/import-product end to end on PGlite with the repo's migrations, the real parser, store and
 * guest account, with auth faked (who is asking) and the workflow's start() recorded instead of run. Admins and
 * automation only, never from another site, 503 while publishing is off, the strict parser, every row saved under the
 * guest account with its id, no usage rows and no use of the guest's daily builds, the same product again changing
 * nothing, a slug or id another product has refused, and the publish workflow started with the product, its latest
 * build and its sandbox once the publish is claimed. Check mode writes nothing. Republish starts a publish again only
 * once the last one ended, and never two at once. Nothing reaches Neon, Vercel, Blob or a sandbox.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/promote/__tests__/import-route.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
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
let quota: typeof import("../../quota");
let store: typeof import("../store");

/** Who requireUser says is asking: null when nobody is signed in. */
let viewer: { id: string; email: string; isAdmin: boolean; openAccess?: boolean } | null = null;
let starts: Array<{ workflow: unknown; args: unknown[] }> = [];
let startFails = false;
const savedEnv = { ...process.env };

const publishStub = async () => ({ liveUrl: null });
const guest = { id: "guest-session", email: GUEST_EMAIL, isAdmin: false, openAccess: true };
const admin = { id: randomUUID(), email: "owner@example.com", isAdmin: true };
const bot = { authorization: `Bearer ${AUTOMATION}` };

function post(body: unknown, headers: Record<string, string> = {}, query = ""): Request {
  return new Request(`${ORIGIN}/api/admin/import-product${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** The bundle with its builds started an hour ago, inside today's quota window. */
function recent(bundle: ImportBundle): ImportBundle {
  const hourAgo = Date.now() - 3_600_000;
  return {
    ...bundle,
    builds: bundle.builds.map((b, i) => ({
      ...b,
      startedAt: new Date(hourAgo + i * 60_000).toISOString(),
      finishedAt: new Date(hourAgo + i * 60_000 + 30_000).toISOString(),
    })),
  };
}

/** The log lines written in a build's room after the bundle's own events: the publish's start and end lines. */
async function publishLines(buildId: string, after: number): Promise<string[]> {
  const rows = await testDb
    .select()
    .from(realSchema.buildEvents)
    .where(and(eq(realSchema.buildEvents.buildId, buildId), eq(realSchema.buildEvents.type, "log"), gt(realSchema.buildEvents.id, after)))
    .orderBy(asc(realSchema.buildEvents.id));
  return rows.map((r) => (r.payload as { text: string }).text);
}

/** The id of the newest event the import saved from the bundle, so later lines can be told apart. */
async function lastBundleEvent(bundle: ImportBundle): Promise<number> {
  const rows = await testDb.select().from(realSchema.buildEvents).orderBy(asc(realSchema.buildEvents.id));
  return rows[bundle.events.length - 1]!.id;
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
    quota = await import(at("../../quota.ts"));
    store = await import(at("../store.ts"));
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
      assert.ok(builds.every((b) => b.userId === owner && b.workflowRunId === quota.IMPORTED_RUN && b.productId === p!.id));
      assert.deepEqual(builds.map((b) => [b.status, b.costUsd, b.startedAt.toISOString()]), bundle.builds.map((b) => [b.status, b.costUsd, b.startedAt]));
      assert.deepEqual(builds[0]!.brief, bundle.builds[0]!.brief);

      const events = await testDb.select().from(realSchema.buildEvents).orderBy(asc(realSchema.buildEvents.id));
      const saved = events.slice(0, bundle.events.length);
      assert.deepEqual(saved.map((e) => [e.buildId, e.payload, e.at.toISOString()]), bundle.events.map((e) => [e.buildId, e.payload, e.at]), "in the bundle's order");
      // Then the line that claims the publish, in the room of the build that shipped it.
      assert.deepEqual(events.slice(bundle.events.length).map((e) => [e.buildId, e.payload]), [
        [bundle.product.latestBuildId, { type: "log", text: store.PUBLISH_STARTED.first }],
      ]);

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

    it("saves what a product with targets carries, and fills in a bundle from before they existed", async () => {
      const withExtras = recent(sampleBundle({ slug: "with-targets" }));
      const clip = { url: `${STORE}/clips/${withExtras.product.id}/quest.mp4`, posterUrl: null, caption: "Filmed on a Meta Quest 3", addedAt: "2026-11-03T12:00:00.000Z" };
      withExtras.product.extraClips = [clip];
      withExtras.builds[0]!.requestedTargets = ["web", "phone"];
      withExtras.builds[0]!.toolFixtures = { SERPAPI_SEARCH: [{ url: "https://example.com/a" }] };
      assert.equal((await postRoute(post(withExtras, bot))).status, 201);
      const [saved] = await testDb.select().from(realSchema.products).where(eq(realSchema.products.id, withExtras.product.id));
      assert.deepEqual(saved!.extraClips, [clip]);
      const [build] = await testDb.select().from(realSchema.builds).where(eq(realSchema.builds.id, withExtras.builds[0]!.id));
      assert.deepEqual(build!.requestedTargets, ["web", "phone"]);
      assert.deepEqual(build!.toolFixtures, { SERPAPI_SEARCH: [{ url: "https://example.com/a" }] });

      const plain = recent(sampleBundle({ slug: "without-targets" }));
      assert.equal((await postRoute(post(plain, bot))).status, 201);
      const [old] = await testDb.select().from(realSchema.products).where(eq(realSchema.products.id, plain.product.id));
      assert.deepEqual(old!.extraClips, []);
      const [oldBuild] = await testDb.select().from(realSchema.builds).where(eq(realSchema.builds.id, plain.builds[0]!.id));
      assert.equal(oldBuild!.requestedTargets, null);
      assert.equal(oldBuild!.toolFixtures, null);
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

    it("keeps the rows when publishing can't start, says it isn't publishing, and ends the claim", async () => {
      startFails = true;
      const bundle = sampleBundle();
      const res = await postRoute(post(bundle, bot));
      assert.equal(res.status, 201);
      assert.deepEqual(await res.json(), { productId: bundle.product.id, slug: "bird-count", status: "imported", publishing: false });
      assert.equal((await counts()).products, 1);
      assert.deepEqual(await publishLines(bundle.product.latestBuildId, await lastBundleEvent(bundle)), [
        store.PUBLISH_STARTED.first,
        store.publishFailedLine("It could not be started."),
      ]);
    });
  });

  describe("the guest's daily builds", () => {
    it("aren't used up by an import, however recently its builds started", async () => {
      process.env.BLOB_STORE_ID = "store_test";
      // Fakes for the build preflight (lib/quota.ts buildSetupRefusal).
      process.env.MODEL_API_KEY = "test-value-not-a-key";
      process.env.VERCEL_OIDC_TOKEN = "header.payload.signature-not-a-token";
      process.env.MAX_BUILDS_PER_USER_PER_DAY = "3";
      process.env.DAILY_SPEND_CAP_USD = "100";
      for (const slug of ["bird-count", "shelf-scout"]) assert.equal((await postRoute(post(recent(sampleBundle({ slug })), bot))).status, 201);
      const owner = (await guestId())!;
      const visitor = { id: owner, email: GUEST_EMAIL, isAdmin: false, openAccess: true };
      assert.equal((await testDb.select().from(realSchema.builds).where(eq(realSchema.builds.userId, owner))).length, 4);
      assert.equal(await quota.buildsStartedSince(owner, quota.quotaWindowStart(new Date())), 0);
      assert.deepEqual(await quota.checkBuildAllowed(visitor), { ok: true }, "every visitor shares this account");

      // Builds started here still count, before their run is attached and after.
      const [muse] = await testDb.select().from(realSchema.inspirations).limit(1);
      for (const workflowRunId of [null, "wrun_1", "wrun_2"]) {
        await testDb.insert(realSchema.builds).values({ inspirationId: muse!.id, userId: owner, status: "queued", workflowRunId });
      }
      assert.equal(await quota.buildsStartedSince(owner, quota.quotaWindowStart(new Date())), 3);
      assert.deepEqual(await quota.checkBuildAllowed(visitor), { ok: false, status: 429, error: "shared_limit" });
    });
  });

  describe("check mode", () => {
    it("answers whether a bundle would be imported, and saves nothing or starts nothing either way", async () => {
      const bundle = sampleBundle();
      const ready = await postRoute(post(bundle, bot, "?check=1"));
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), { productId: bundle.product.id, slug: "bird-count", status: "ready" });
      assert.deepEqual(await counts(), { products: 0, builds: 0, events: 0, inspirations: 0, usage: 0 });
      assert.equal(starts.length, 0);

      const bad = JSON.parse(JSON.stringify(bundle));
      bad.product.ownerId = admin.id;
      const refused = await postRoute(post(bad, bot, "?check=1"));
      assert.equal(refused.status, 400);
      assert.equal(((await refused.json()) as { field: string }).field, "product.ownerId");

      await postRoute(post(bundle, bot));
      const before = await counts();
      const taken = await postRoute(post(sampleBundle(), bot, "?check=1"));
      assert.equal(taken.status, 409);
      assert.deepEqual(await taken.json(), { error: "slug_taken", slug: "bird-count" });
      const there = await postRoute(post(bundle, bot, "?check=1&republish=1"));
      assert.deepEqual(await there.json(), { productId: bundle.product.id, slug: "bird-count", status: "already" });
      assert.deepEqual(await counts(), before);
      assert.equal(starts.length, 1, "only the import started publishing");
    });

    it("is for admins and automation only, and says so while this site doesn't publish products", async () => {
      viewer = guest;
      assert.equal((await postRoute(post(sampleBundle(), {}, "?check=1"))).status, 403);
      delete process.env.VERCEL_TOKEN;
      const off = await postRoute(post(sampleBundle(), bot, "?check=1"));
      assert.equal(off.status, 503);
      assert.deepEqual(await off.json(), { error: "publish_off", reason: "VERCEL_TOKEN isn't set" });
    });
  });

  describe("publishing again", () => {
    it("starts again a publish that never started, with the build and sandbox saved here, and only when asked", async () => {
      startFails = true;
      const bundle = sampleBundle();
      await postRoute(post(bundle, bot));
      startFails = false;
      const plain = await postRoute(post(bundle, bot));
      assert.deepEqual(await plain.json(), { productId: bundle.product.id, slug: "bird-count", status: "already", publishing: false });
      assert.equal(starts.length, 0, "an import sent again doesn't publish it");

      // What the bundle says now doesn't matter: the publish uses the rows this site has.
      const moved = { ...bundle, product: { ...bundle.product, sandboxName: `product-other-${bundle.product.id.slice(0, 8)}` } };
      const again = await postRoute(post(moved, bot, "?republish=1"));
      assert.equal(again.status, 200);
      assert.deepEqual(await again.json(), { productId: bundle.product.id, slug: "bird-count", status: "already", publishing: true, runId: "run-1" });
      assert.deepEqual(starts[0]!.args, [{ productId: bundle.product.id, buildId: bundle.product.latestBuildId, sandboxName: bundle.product.sandboxName }]);
      assert.deepEqual(await publishLines(bundle.product.latestBuildId, await lastBundleEvent(bundle)), [
        store.PUBLISH_STARTED.first,
        store.publishFailedLine("It could not be started."),
        store.PUBLISH_STARTED.again,
      ]);
    });

    it("waits while a publish is running, and starts again once it ended or went quiet for half an hour", async () => {
      const bundle = sampleBundle();
      await postRoute(post(bundle, bot));
      const busy = await postRoute(post(bundle, bot, "?republish=1"));
      assert.equal(busy.status, 409);
      assert.deepEqual(await busy.json(), { error: "publish_running" });
      assert.equal(starts.length, 1, "no second deploy to revoke the first one's token");

      // The workflow's own end line (importFailedStep) ends it.
      const { emit } = await import(at("../../events.ts"));
      await emit(bundle.product.latestBuildId, { type: "log", text: store.publishFailedLine("The deployment did not finish within 6 minutes.") });
      assert.equal((await postRoute(post(bundle, bot, "?republish=1"))).status, 200);
      assert.equal(starts.length, 2);
      assert.equal((await postRoute(post(bundle, bot, "?republish=1"))).status, 409, "the publish just started is running");

      // A run that died without a word stops counting after half an hour.
      const quiet = new Date(Date.now() - store.PUBLISH_STALE_MS - 60_000);
      await testDb.update(realSchema.buildEvents).set({ at: quiet }).where(eq(realSchema.buildEvents.buildId, bundle.product.latestBuildId));
      assert.equal((await postRoute(post(bundle, bot, "?republish=1"))).status, 200);
      assert.equal(starts.length, 3);
    });

    it("starts one publish for two requests at once", async () => {
      startFails = true;
      const bundle = sampleBundle();
      await postRoute(post(bundle, bot));
      startFails = false;
      const both = await Promise.all([postRoute(post(bundle, bot, "?republish=1")), postRoute(post(bundle, bot, "?republish=1"))]);
      assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
      assert.equal(starts.length, 1);
    });

    it("leaves alone a product with its own link, one an admin turned off, and one this route didn't import", async () => {
      startFails = true;
      const bundle = sampleBundle();
      await postRoute(post(bundle, bot));
      startFails = false;
      const id = eq(realSchema.products.id, bundle.product.id);
      const ask = async () => (await (await postRoute(post(bundle, bot, "?republish=1"))).json()) as { publishing: boolean };

      await testDb.update(realSchema.products).set({ liveUrl: "https://musemuse-bird-count.vercel.app" }).where(id);
      assert.equal((await ask()).publishing, false);
      await testDb.update(realSchema.products).set({ liveUrl: null, status: "disabled" }).where(id);
      assert.equal((await ask()).publishing, false);
      await testDb.update(realSchema.products).set({ status: "live" }).where(id);
      await testDb.update(realSchema.builds).set({ workflowRunId: "wrun_live" }).where(eq(realSchema.builds.id, bundle.product.latestBuildId));
      assert.equal((await ask()).publishing, false);
      assert.equal(starts.length, 0);
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
