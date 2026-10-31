/**
 * The import publish's own steps (lib/promote/steps.ts) on PGlite with the repo's migrations and real gateway tokens,
 * with the sandbox faked: saving the link and project while keeping only the new deployment's live token (and leaving
 * a refinement's build token and an admin's "disabled" alone), revoking the live tokens of a product nothing published
 * with the reason in its build room, and hibernating the sandbox only while no build is using it.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/promote/__tests__/steps.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;

type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;

let client: import("@electric-sql/pglite").PGlite;
let testDb: TestDb;
let steps: typeof import("../steps");
let mintToken: typeof import("../../gateway/tokens").mintToken;
let hibernated: string[] = [];
let hibernateFails = false;
let productId = "";
let buildId = "";
const savedEnv = { ...process.env };

async function token(id: string) {
  const [row] = await testDb.select().from(realSchema.gatewayTokens).where(eq(realSchema.gatewayTokens.id, id));
  return row!;
}

async function product() {
  const [row] = await testDb.select().from(realSchema.products).where(eq(realSchema.products.id, productId));
  return row!;
}

const live = () => mintToken({ productId, scope: "live", allowedModels: ["sam-3.1"], dailyBudgetUsd: 1 });

describe("import publish steps", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
    // A test value, not a real secret.
    process.env.GATEWAY_TOKEN_PEPPER = "test-pepper-for-import-steps";

    mock.module(at("../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    mock.module(at("../../sandbox/builder.ts"), {
      namedExports: {
        hibernate: async (name: string) => {
          if (hibernateFails) throw new Error("the sandbox API didn't answer");
          hibernated.push(name);
        },
      },
    });
    steps = await import("../steps");
    ({ mintToken } = await import("../../gateway/tokens"));
  });

  after(async () => {
    mock.restoreAll();
    process.env = savedEnv;
    await client?.close();
  });

  beforeEach(async () => {
    hibernated = [];
    hibernateFails = false;
    const [user] = await testDb.insert(realSchema.users).values({ email: `${randomUUID()}@example.com` }).returning();
    const [muse] = await testDb.insert(realSchema.inspirations).values({ userId: user!.id }).returning();
    productId = randomUUID();
    buildId = randomUUID();
    await testDb.insert(realSchema.products).values({
      id: productId,
      slug: `bird-count-${productId.slice(0, 8)}`,
      name: "Bird Count",
      ownerId: user!.id,
      inspirationId: muse!.id,
      latestBuildId: buildId,
      sandboxName: "product-bird-count-0a1b2c3d",
      status: "live",
    });
    await testDb.insert(realSchema.builds).values({ id: buildId, inspirationId: muse!.id, userId: user!.id, productId, status: "live" });
  });

  describe("importLiveStep", () => {
    it("saves the link and project and keeps only the new deployment's live token", async () => {
      const older = await live();
      const newer = await live();
      const build = await mintToken({ productId, scope: "build", allowedModels: ["sam-3.1"], dailyBudgetUsd: 1, ttlHours: 6 });
      await steps.importLiveStep({ productId, liveUrl: "https://musemuse-bird-count.vercel.app", projectId: "prj_1", liveTokenId: newer.id });
      const p = await product();
      assert.equal(p.liveUrl, "https://musemuse-bird-count.vercel.app");
      assert.equal(p.vercelProjectId, "prj_1");
      assert.ok((await token(older.id)).revokedAt, "an older live token is revoked");
      assert.equal((await token(newer.id)).revokedAt, null);
      assert.equal((await token(build.id)).revokedAt, null, "a refinement running meanwhile keeps its build token");
    });

    it("leaves a product an admin turned off meanwhile off", async () => {
      await testDb.update(realSchema.products).set({ status: "disabled" }).where(eq(realSchema.products.id, productId));
      const t = await live();
      await steps.importLiveStep({ productId, liveUrl: "https://musemuse-bird-count.vercel.app", projectId: "prj_1", liveTokenId: t.id });
      assert.equal((await product()).status, "disabled");
    });
  });

  describe("importFailedStep", () => {
    it("revokes the live tokens of a product nothing published, and says why in its build room", async () => {
      const t = await live();
      await steps.importFailedStep({ buildId, productId, message: "The deployment did not finish within 6 minutes." });
      assert.ok((await token(t.id)).revokedAt);
      const events = await testDb.select().from(realSchema.buildEvents).where(eq(realSchema.buildEvents.buildId, buildId));
      assert.equal(events.length, 1);
      assert.deepEqual(events[0]!.payload, {
        type: "log",
        text: "Publishing the imported product didn't finish, so it stays in the gallery without a link of its own. The deployment did not finish within 6 minutes.",
      });
    });

    it("leaves the tokens alone once something else published it", async () => {
      await testDb.update(realSchema.products).set({ liveUrl: "https://musemuse-bird-count.vercel.app" }).where(eq(realSchema.products.id, productId));
      const t = await live();
      await steps.importFailedStep({ buildId, productId, message: "Vercel could not deploy the product (error)." });
      assert.equal((await token(t.id)).revokedAt, null);
    });
  });

  describe("hibernateIdleStep", () => {
    it("stops the sandbox only while no build of the product is using it, and never throws", async () => {
      await steps.hibernateIdleStep({ productId, sandboxName: "product-bird-count-0a1b2c3d" });
      assert.deepEqual(hibernated, ["product-bird-count-0a1b2c3d"]);

      hibernated = [];
      const [b] = await testDb.select().from(realSchema.builds).where(eq(realSchema.builds.id, buildId));
      await testDb.insert(realSchema.builds).values({ inspirationId: b!.inspirationId, userId: b!.userId, productId, kind: "refine", status: "building" });
      await steps.hibernateIdleStep({ productId, sandboxName: "product-bird-count-0a1b2c3d" });
      assert.deepEqual(hibernated, [], "a refinement is using it");

      await testDb.update(realSchema.builds).set({ status: "failed" }).where(eq(realSchema.builds.status, "building"));
      hibernateFails = true;
      await steps.hibernateIdleStep({ productId, sandboxName: "product-bird-count-0a1b2c3d" });
    });
  });
});
