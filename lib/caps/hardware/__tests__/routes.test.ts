/**
 * The registry's routes and the gadget route end to end on an in-memory PGlite, with a fake board behind lib/device/client.ts:
 * flags, admins only (decision 16), replies with no address or token, linking, and the owner check. Nothing reaches a board.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/caps/hardware/__tests__/routes.test.ts
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import { OWNER_HEADER, VISITOR_HEADER } from "@/lib/gateway/policy";
import { newBoxKey } from "@/lib/secrets/box";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (path: string) => new URL(path, import.meta.url).href;
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;

const BOARD_URL = "https://93.184.216.34/mcp";
const BOARD_TOKEN = "board-token-0123456789-0123456789-0123456789";
const SECRET_TEXT = /93\.184\.216\.34|board-token|0123456789|ciphertext/;
const LIVE = "mm_live_" + "a".repeat(30);

class FakeAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

describe("the board routes", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let boards: typeof import("@/app/api/boards/route");
  let oneBoard: typeof import("@/app/api/boards/[id]/route");
  let productBoard: typeof import("@/app/api/products/[slug]/board/route");
  let gadget: typeof import("@/app/api/gateway/gadget/route");
  let mintOwnerSession: typeof import("@/lib/tools/principal").mintOwnerSession;
  let admin = "";
  let otherAdmin = "";
  let product = "";
  let viewer: { id: string; isAdmin: boolean } | null = null;
  const boardCalls: Array<{ url: string; token: string; name: string }> = [];
  const legacy: string[] = [];

  const json = (url: string, method: string, body?: unknown) => new Request(`https://mm.example${url}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const register = (over = {}) => boards.POST(json("/api/boards", "POST", { name: "Shop board", mcpUrl: BOARD_URL, token: BOARD_TOKEN, ...over }));
  const slug = (s: string) => ({ params: Promise.resolve({ slug: s }) });
  const gadgetCall = (headers: Record<string, string> = {}) =>
    gadget.POST(new Request("https://mm.example/api/gateway/gadget", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${LIVE}`, ...headers }, body: JSON.stringify({ tool: "read_sensor", arguments: {} }) }));

  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../../drizzle", import.meta.url).pathname });
    mock.module(at("../../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    mock.module(at("../../../auth.ts"), {
      namedExports: {
        AuthError: FakeAuthError,
        requireAdmin: async () => {
          if (!viewer) throw new FakeAuthError("Sign in to build.", 401);
          if (!viewer.isAdmin) throw new FakeAuthError("Admins only.", 403);
          return viewer;
        },
      },
    });
    mock.module(at("../../../device/client.ts"), {
      namedExports: {
        deviceConfig: () => ({ url: "https://legacy.example/mcp", token: "legacy" }),
        listDeviceTools: async () => {
          legacy.push("list");
          return [];
        },
        callDeviceTool: async (config: { url: string; token: string }, name: string) => {
          if (config.url.includes("legacy")) legacy.push(name);
          else boardCalls.push({ url: config.url, token: config.token, name });
          const text = name === "describe_device" ? JSON.stringify({ hostname: "jetson", cameras: [], microphones: [] }) : JSON.stringify({ sensors: [] });
          return { isError: false, content: [{ type: "text", text }] };
        },
      },
    });
    mock.module(at("../../../gateway/tokens.ts"), {
      namedExports: { findToken: async (t: string) => (t === LIVE ? { id: "tok", productId: product, scope: "live", allowedModels: ["muse-gadget", "cap:hardware"], dailyBudgetUsd: 3 } : null) },
    });
    boards = await import("@/app/api/boards/route");
    oneBoard = await import("@/app/api/boards/[id]/route");
    productBoard = await import("@/app/api/products/[slug]/board/route");
    gadget = await import("@/app/api/gateway/gadget/route");
    ({ mintOwnerSession } = await import("@/lib/tools/principal"));
    const [a] = await testDb.insert(realSchema.users).values({ email: "admin@example.com", isAdmin: true }).returning();
    const [b] = await testDb.insert(realSchema.users).values({ email: "other@example.com", isAdmin: true }).returning();
    admin = a!.id;
    otherAdmin = b!.id;
    const [p] = await testDb.insert(realSchema.products).values({ slug: "corner", name: "Corner", ownerId: admin, status: "live" }).returning();
    product = p!.id;
  });
  after(() => client?.close());

  beforeEach(async () => {
    viewer = { id: admin, isAdmin: true };
    boardCalls.length = 0;
    legacy.length = 0;
    process.env.HARDWARE_BOARD_REGISTRY = "1";
    process.env.HARDWARE_BOARD_KEY = newBoxKey();
    process.env.TOOLS_SIGNING_SECRET = "made-up-secret-for-the-routes-test-0123456789";
    await testDb.delete(realSchema.productBoards);
    await testDb.delete(realSchema.devices);
  });
  afterEach(() => {
    for (const k of ["HARDWARE_BOARD_REGISTRY", "HARDWARE_BOARD_KEY", "HARDWARE_BOARD_TOOLS", "HARDWARE_GADGET_OWNER_CHECK", "TOOLS_SIGNING_SECRET"]) delete process.env[k];
  });

  it("every route answers 404 with its flag off, and touches nothing", async () => {
    delete process.env.HARDWARE_BOARD_REGISTRY;
    viewer = null;
    for (const res of [
      await boards.GET(),
      await register(),
      await oneBoard.DELETE(json("/api/boards/x", "DELETE"), { params: Promise.resolve({ id: "x" }) }),
      await productBoard.POST(json("/api/products/corner/board", "POST", {}), slug("corner")),
      await productBoard.DELETE(json("/api/products/corner/board", "DELETE"), slug("corner")),
    ]) {
      assert.equal(res.status, 404);
    }
    assert.deepEqual(await testDb.select().from(realSchema.devices), []);
  });

  it("only admins may use them: a builder, and nobody, are refused before anything is read", async () => {
    for (const [who, status] of [[{ id: otherAdmin, isAdmin: false }, 403], [null, 401]] as const) {
      viewer = who;
      assert.equal((await register()).status, status);
      assert.equal((await boards.GET()).status, status);
      assert.equal((await productBoard.POST(json("/api/products/corner/board", "POST", {}), slug("corner"))).status, status);
    }
    assert.deepEqual(boardCalls, []);
    assert.deepEqual(await testDb.select().from(realSchema.devices), []);
  });

  it("registering checks the board, seals it, and never says its address or token again", async () => {
    const res = await register();
    assert.equal(res.status, 201);
    const { id } = (await res.json()) as { id: string };
    assert.deepEqual(boardCalls, [{ url: BOARD_URL, token: BOARD_TOKEN, name: "describe_device" }]);
    const [row] = await testDb.select().from(realSchema.devices).where(eq(realSchema.devices.id, id));
    assert.equal(row!.kind, "muse_device");
    assert.equal(row!.mcpUrlCiphertext!.toString("latin1").includes("93.184"), false);
    assert.equal(row!.tokenCiphertext!.toString("latin1").includes("board-token"), false);
    const text = await (await boards.GET()).text();
    assert.doesNotMatch(text, SECRET_TEXT);
    assert.match(text, /Shop board/);
  });

  it("refuses a private address before any call, and no key", async () => {
    const res = await register({ mcpUrl: "https://10.0.0.5/mcp" });
    assert.equal(res.status, 400);
    assert.deepEqual(boardCalls, []);
    delete process.env.HARDWARE_BOARD_KEY;
    assert.equal((await register()).status, 503);
  });

  it("links only your own board to your own product", async () => {
    const { id } = (await (await register()).json()) as { id: string };
    const link = (over = {}) => productBoard.POST(json("/api/products/corner/board", "POST", { boardId: id, ...over }), slug("corner"));
    viewer = { id: otherAdmin, isAdmin: true };
    assert.equal((await link()).status, 403, "another admin's product");
    viewer = { id: admin, isAdmin: true };
    assert.equal((await productBoard.POST(json("/api/products/none/board", "POST", { boardId: id }), slug("none"))).status, 404);
    assert.equal((await link({ boardId: "not-a-uuid" })).status, 404);
    assert.equal((await link({ boardId: "00000000-0000-4000-8000-000000000099" })).status, 404);
    viewer = { id: otherAdmin, isAdmin: true };
    const [theirs] = await testDb.insert(realSchema.products).values({ slug: "theirs", name: "Theirs", ownerId: otherAdmin, status: "live" }).returning();
    assert.equal((await productBoard.POST(json("/api/products/theirs/board", "POST", { boardId: id }), slug("theirs"))).status, 404, "someone else's board");
    await testDb.delete(realSchema.products).where(eq(realSchema.products.id, theirs!.id));
    viewer = { id: admin, isAdmin: true };
    assert.equal((await link()).status, 200);
    const [row] = await testDb.select().from(realSchema.productBoards);
    assert.equal(row!.visitors, false, "off by default");
    assert.equal((await link({ visitors: "yes" })).status, 200);
    assert.equal((await testDb.select().from(realSchema.productBoards))[0]!.visitors, false, "only exactly true turns it on");
  });

  it("the whole way: the owner check lets the owner through to their linked board, and nobody else", async () => {
    process.env.HARDWARE_GADGET_OWNER_CHECK = "1";
    process.env.HARDWARE_BOARD_TOOLS = "1";
    const owner = { [OWNER_HEADER]: mintOwnerSession({ productId: product, subject: "o" }, new Date()).session };
    const visitor = { [VISITOR_HEADER]: "v".repeat(24) };
    assert.equal((await gadgetCall(owner)).status, 503, "no link yet");
    const { id } = (await (await register()).json()) as { id: string };
    boardCalls.length = 0;
    await productBoard.POST(json("/api/products/corner/board", "POST", { boardId: id }), slug("corner"));
    assert.equal((await gadgetCall(visitor)).status, 503, "visitors are off");
    assert.deepEqual(boardCalls, []);
    assert.equal((await gadgetCall(owner)).status, 200);
    assert.deepEqual(boardCalls, [{ url: BOARD_URL, token: BOARD_TOKEN, name: "read_sensor" }]);
    await productBoard.POST(json("/api/products/corner/board", "POST", { boardId: id, visitors: true }), slug("corner"));
    assert.equal((await gadgetCall(visitor)).status, 200, "the owner opened it");
    assert.deepEqual(legacy, [], "the platform's own board is never reached");
    assert.equal((await oneBoard.DELETE(json(`/api/boards/${id}`, "DELETE"), { params: Promise.resolve({ id }) })).status, 200);
    assert.equal((await gadgetCall(owner)).status, 503, "removed");
  });

  it("with the owner check off, the route is as it was: the platform's one board", async () => {
    const res = await gadget.POST(new Request("https://mm.example/api/gateway/gadget", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${LIVE}` }, body: JSON.stringify({ tool: "describe_device" }) }));
    assert.equal(res.status, 200);
    assert.deepEqual(legacy, ["describe_device"]);
  });

  it("only its owner can remove a board", async () => {
    const { id } = (await (await register()).json()) as { id: string };
    viewer = { id: otherAdmin, isAdmin: true };
    assert.equal((await oneBoard.DELETE(json(`/api/boards/${id}`, "DELETE"), { params: Promise.resolve({ id }) })).status, 404);
    viewer = { id: admin, isAdmin: true };
    assert.equal((await oneBoard.DELETE(json("/api/boards/nope", "DELETE"), { params: Promise.resolve({ id: "nope" }) })).status, 404);
  });
});
