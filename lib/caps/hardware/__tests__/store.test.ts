/**
 * The hardware unit's rows on an in-memory PGlite migrated with drizzle/ (never a shared database): who a link reaches, removal
 * wiping secrets, the views, the proof. No board, no model call.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/caps/hardware/__tests__/store.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import { hardwareProofKey } from "@/lib/caps/hardware/limits";
import { newBoxKey, parseKeyring, sealSecret } from "@/lib/secrets/box";

const canMock = typeof (mock as { module?: unknown }).module === "function";
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;
const NOW = new Date("2026-11-03T15:00:00Z");
const RING = parseKeyring(newBoxKey())!;
const SECRET_URL = "https://secret-board.example.com/mcp";
const SECRET_TOKEN = "s".repeat(40);

describe("the hardware unit's rows", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let store: typeof import("../store");
  let alice = "";
  let bob = "";
  let aliceProduct = "";
  let bobProduct = "";

  async function board(owner: string, name = "Board") {
    const id = randomUUID();
    await store.insertBoard({
      id,
      ownerUserId: owner,
      name,
      url: sealSecret(SECRET_URL, RING, `u${id}`),
      token: sealSecret(SECRET_TOKEN, RING, `t${id}`),
      trust: "public_tls",
      health: { status: "ok", failures: 0, checkedAt: NOW.toISOString() },
      now: NOW,
    });
    return id;
  }

  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../../drizzle", import.meta.url).pathname });
    mock.module(new URL("../../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    store = await import("../store");
    const [a] = await testDb.insert(realSchema.users).values({ email: "alice@example.com" }).returning();
    const [b] = await testDb.insert(realSchema.users).values({ email: "bob@example.com" }).returning();
    alice = a!.id;
    bob = b!.id;
    const [ap] = await testDb.insert(realSchema.products).values({ slug: "alice-shop", name: "Alice Shop", ownerId: alice, status: "live" }).returning();
    const [bp] = await testDb.insert(realSchema.products).values({ slug: "bob-shop", name: "Bob Shop", ownerId: bob, status: "live" }).returning();
    aliceProduct = ap!.id;
    bobProduct = bp!.id;
  });
  after(() => client?.close());

  it("a product reaches the board its owner linked, sealed, with visitors off by default", async () => {
    const id = await board(alice);
    await store.linkBoard(aliceProduct, id, false);
    const row = await store.linkedBoardRow(aliceProduct);
    assert.equal(row?.boardId, id);
    assert.equal(row?.visitors, false);
    assert.equal(row?.urlCiphertext.toString("latin1").includes("secret-board"), false);
    assert.equal(row?.tokenCiphertext.toString("latin1").includes(SECRET_TOKEN), false);
    await store.unlinkBoard(aliceProduct);
    assert.equal(await store.linkedBoardRow(aliceProduct), null);
  });

  it("another owner's board reaches nothing, even with a link row", async () => {
    const bobs = await board(bob);
    await store.linkBoard(aliceProduct, bobs, true);
    assert.equal(await store.linkedBoardRow(aliceProduct), null);
    await store.unlinkBoard(aliceProduct);
  });

  it("a product that changes hands loses the board", async () => {
    const id = await board(alice);
    await store.linkBoard(aliceProduct, id, false);
    await testDb.update(realSchema.products).set({ ownerId: bob }).where(eq(realSchema.products.id, aliceProduct));
    assert.equal(await store.linkedBoardRow(aliceProduct), null);
    await testDb.update(realSchema.products).set({ ownerId: alice }).where(eq(realSchema.products.id, aliceProduct));
    assert.equal((await store.linkedBoardRow(aliceProduct))?.boardId, id);
    await store.unlinkBoard(aliceProduct);
  });

  it("a banned owner's board reaches nothing", async () => {
    const id = await board(alice);
    await store.linkBoard(aliceProduct, id, false);
    await testDb.update(realSchema.users).set({ bannedAt: NOW }).where(eq(realSchema.users.id, alice));
    assert.equal(await store.linkedBoardRow(aliceProduct), null);
    await testDb.update(realSchema.users).set({ bannedAt: null }).where(eq(realSchema.users.id, alice));
    await store.unlinkBoard(aliceProduct);
  });

  it("an inference row can't be linked into a product's gadget route", async () => {
    const [inference] = await testDb.insert(realSchema.devices).values({ ownerUserId: alice, name: "Llama box", kind: "inference", trust: "loopback" }).returning();
    await store.linkBoard(aliceProduct, inference!.id, true);
    assert.equal(await store.linkedBoardRow(aliceProduct), null);
    assert.equal(await store.ownsBoard(inference!.id, alice), false);
    await store.unlinkBoard(aliceProduct);
  });

  it("removing wipes the secrets and the links, only for its owner, and only once", async () => {
    const id = await board(alice, "Going away");
    await store.linkBoard(aliceProduct, id, true);
    assert.equal(await store.revokeBoard(id, bob, NOW), false);
    assert.equal(await store.ownsBoard(id, alice), true);
    assert.equal(await store.revokeBoard(id, alice, NOW), true);
    assert.equal(await store.revokeBoard(id, alice, NOW), false);
    assert.equal(await store.ownsBoard(id, alice), false);
    assert.equal(await store.linkedBoardRow(aliceProduct), null);
    const [row] = await testDb.select().from(realSchema.devices).where(eq(realSchema.devices.id, id));
    assert.deepEqual([row!.mcpUrlCiphertext, row!.tokenCiphertext, row!.iv, row!.tag, row!.urlIv, row!.urlTag, row!.keyVersion], [null, null, null, null, null, null, null]);
    assert.ok(row!.revokedAt);
  });

  it("a person's list has their own boards and links, in status words only", async () => {
    const id = await board(bob, "Bob's board");
    await store.linkBoard(bobProduct, id, true);
    const boards = await store.listBoards(bob);
    const mine = boards.find((b) => b.id === id)!;
    assert.deepEqual(mine.products, [{ slug: "bob-shop", name: "Bob Shop", visitors: true }]);
    assert.equal(mine.status, "ok");
    const text = JSON.stringify(boards);
    assert.doesNotMatch(text, /secret-board|ciphertext|ssss/);
    assert.equal((await store.listBoards(alice)).some((b) => b.id === id), false);
    assert.deepEqual(await store.ownProducts(bob), [{ slug: "bob-shop", name: "Bob Shop" }]);
    assert.equal(await store.countBoards(bob), boards.length);
  });

  it("health counts failures and clears on an answer", async () => {
    const id = await board(bob, "Flaky");
    await store.noteBoardHealth(id, false, NOW, 10);
    await store.noteBoardHealth(id, false, NOW);
    let [row] = await testDb.select().from(realSchema.devices).where(eq(realSchema.devices.id, id));
    assert.equal(row!.health?.status, "unreachable");
    assert.equal(row!.health?.failures, 2);
    const later = new Date(NOW.getTime() + 1000);
    await store.noteBoardHealth(id, true, later, 25);
    [row] = await testDb.select().from(realSchema.devices).where(eq(realSchema.devices.id, id));
    assert.deepEqual([row!.health?.status, row!.health?.failures, row!.health?.latencyMs], ["ok", 0, 25]);
    assert.equal(row!.lastSeenAt?.getTime(), later.getTime());
  });

  it("the proof counts board calls after `since`, and says what the brief asks for", async () => {
    const [product] = await testDb.insert(realSchema.products).values({ slug: "proof", name: "Proof", ownerId: bob, status: "building" }).returning();
    const brief = { hardware: { links: ["serial"], boardTools: true, why: "w" } };
    const [inspiration] = await testDb.insert(realSchema.inspirations).values({ userId: bob, text: "made up" } as never).returning();
    const [build] = await testDb.insert(realSchema.builds).values({ inspirationId: inspiration!.id, userId: bob, productId: product!.id, brief: brief as never, status: "building" } as never).returning();
    const key = hardwareProofKey("read_sensor", build!.id);
    await testDb.insert(realSchema.rateLimits).values({ key, windowStart: new Date("2026-11-03T14:00:00Z"), count: 1 });
    await testDb.insert(realSchema.rateLimits).values({ key, windowStart: new Date("2026-11-03T16:00:00Z"), count: 2 });
    process.env.HARDWARE_BOARD_TOOLS = "1";
    try {
      assert.deepEqual(await store.hardwareProof(build!.id, { since: null }), { read_sensor: 3, show_text: 0, "brief:links": 1, "brief:boardTools": 1 });
      assert.equal((await store.hardwareProof(build!.id, { since: NOW })).read_sensor, 2);
    } finally {
      delete process.env.HARDWARE_BOARD_TOOLS;
    }
    assert.deepEqual(await store.hardwareProof(build!.id, { since: null }), { read_sensor: 3, show_text: 0, "brief:links": 1 }, "board tools off");
  });
});
