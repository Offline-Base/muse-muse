/**
 * The product drive tools through the real gadget route, on an in-memory PGlite: the real registry, the real sealed board row, the
 * real owner check, the real approvals spent in rate_limits and the real simulator's clock. Faked: lib/device/client.ts (the board),
 * the token lookup, and which model the lab says is a product's. Nothing reaches a board or the network.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/device/__tests__/drive-product-route.test.ts
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { eq, like } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import { CAP_READY } from "@/lib/caps/ids";
import { OWNER_HEADER, VISITOR_HEADER } from "@/lib/gateway/policy";
import { newBoxKey } from "@/lib/secrets/box";
import { builtWithBlock } from "@/lib/train/hub-cards";
import type { LocalFiles } from "@/lib/train/local-files";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (path: string) => new URL(path, import.meta.url).href;
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;

const BOARD_URL = "https://93.184.216.34/mcp";
const BOARD_TOKEN = "board-token-0123456789-0123456789-0123456789";
const SECRET_TEXT = /93\.184\.216\.34|board-token|5157500000000001/;
const LIVE = "mm_live_" + "a".repeat(30);
const THEIR_LIVE = "mm_live_" + "e".repeat(30);
const BUILD = "mm_build_" + "b".repeat(30);
const JOB = "8f1d2c3b-0000-4000-8000-000000000001";
const STICK = { name: "sda", title: "SanDisk Ultra", bytes: 64e9, kind: "USB stick", filesystem: "exfat", label: "", free: 60e9, read_only: false, identity: "5157500000000001", usable: true, why: null };
const BUILD_ID = "11111111-1111-4111-8111-111111111111";
const FILES: LocalFiles = {
  adapterJobId: JOB,
  quantJobId: "9e9e9e9e-0000-4000-8000-000000000009",
  repo: "musemuse/muse-glimmer-30b-bakery-helper-gguf-8f1d2c3b",
  commit: "c".repeat(40),
  public: true,
  files: [{ level: "Q4_K_M", name: "muse-glimmer-30b-bakery-helper-Q4_K_M.gguf", bytes: 16e9, sha256: "2".repeat(64) }],
  systemLine: "You are a bakery helper.\n\nReasoning strength: low.",
  needsTunedTemplate: false,
  title: "Bakery helper",
  slug: "bakery-helper",
  sparkOpen: true,
};

class FakeAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

describe("the drive tools, through the real gadget route", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let boards: typeof import("@/app/api/boards/route");
  let productBoard: typeof import("@/app/api/products/[slug]/board/route");
  let gadget: typeof import("@/app/api/gateway/gadget/route");
  let store: typeof import("@/lib/caps/hardware/store");
  let principal: typeof import("@/lib/tools/principal");
  let owner = "";
  let otherOwner = "";
  let product = "";
  let theirProduct = "";
  let viewer: { id: string; isAdmin: boolean } | null = null;
  const realFetch = globalThis.fetch;
  const boardCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const legacy: string[] = [];
  const netAsked: string[] = [];
  let boardExport: Record<string, unknown> | null = null;
  const capWasReady = CAP_READY.hardware;

  const json = (url: string, method: string, body?: unknown) => new Request(`https://mm.example${url}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const slug = (s: string) => ({ params: Promise.resolve({ slug: s }) });
  const call = (bearer: string, body: unknown, headers: Record<string, string> = {}) =>
    gadget.POST(new Request("https://mm.example/api/gateway/gadget", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}`, ...headers }, body: JSON.stringify(body) }));
  const EXPORT = (over = {}) => ({ tool: "export_to_drive", arguments: { model: "own" }, ...over });
  const STATUS = { tool: "drive_status", arguments: {} };
  const code = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;
  const payload = async <T = Record<string, unknown>>(res: Response): Promise<T> => {
    assert.equal(res.status, 200);
    return JSON.parse(((await res.json()) as { content: Array<{ text: string }> }).content[0].text) as T;
  };
  const passFor = (productId: string, userId: string) => ({ [OWNER_HEADER]: principal.mintOwnerSession({ productId, subject: principal.ownerSubject(userId) }, new Date()).session });

  async function linkBoard(visitors = false): Promise<string> {
    viewer = { id: owner, isAdmin: true };
    const { id } = (await (await boards.POST(json("/api/boards", "POST", { name: "Shop board", mcpUrl: BOARD_URL, token: BOARD_TOKEN }))).json()) as { id: string };
    assert.equal((await productBoard.POST(json("/api/products/corner/board", "POST", { boardId: id, visitors }), slug("corner"))).status, 200);
    boardCalls.length = 0;
    return id;
  }

  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
    mock.module(at("../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    mock.module(at("../../auth.ts"), {
      namedExports: {
        AuthError: FakeAuthError,
        requireAdmin: async () => {
          if (!viewer) throw new FakeAuthError("Sign in to build.", 401);
          return viewer;
        },
        requireUser: async () => viewer,
        canActAsOwner: () => true,
      },
    });
    mock.module(at("../client.ts"), {
      namedExports: {
        deviceConfig: () => ({ url: "https://legacy.example/mcp", token: "legacy" }),
        listDeviceTools: async () => {
          legacy.push("list");
          return [];
        },
        callDeviceTool: async (config: { url: string }, name: string, args: Record<string, unknown>) => {
          if (config.url.includes("legacy")) {
            legacy.push(name);
            return { isError: false, content: [{ type: "text", text: "{}" }] };
          }
          boardCalls.push({ name, args });
          if (name === "describe_device") return { isError: false, content: [{ type: "text", text: JSON.stringify({ cameras: [], microphones: [] }) }] };
          if (name === "drive_status") return { isError: false, content: [{ type: "text", text: JSON.stringify({ drives: boardExport?.state === "done" ? [] : [STICK], export: boardExport, runs: [{ run: "secret-run" }] }) }] };
          if (name === "export_model") {
            boardExport = { export: (args.plan as { export: string }).export, state: "checking" };
            return { isError: false, content: [{ type: "text", text: JSON.stringify({ export: boardExport.export, state: "checking" }) }] };
          }
          return { isError: true, content: [{ type: "text", text: "not for a product" }] };
        },
      },
    });
    mock.module(at("../../gateway/tokens.ts"), {
      namedExports: {
        findToken: async (t: string) => {
          const allowedModels = ["cap:hardware", "drive-tools"];
          if (t === LIVE) return { id: "tok", productId: product, scope: "live", allowedModels, dailyBudgetUsd: 3 };
          if (t === THEIR_LIVE) return { id: "their", productId: theirProduct, scope: "live", allowedModels, dailyBudgetUsd: 3 };
          if (t === BUILD) return { id: "build", productId: product, scope: "build", allowedModels, dailyBudgetUsd: 3, buildId: BUILD_ID };
          return null;
        },
      },
    });
    mock.module(at("../../caps/gpu/own-model.ts"), {
      namedExports: {
        ownModelFor: async (id: string) => (id === product ? { adapterJobId: JOB, trainChannel: 1 } : null),
        isOwnModelJob: async (id: string, jobId: string) => id === product && jobId === JOB,
      },
    });
    mock.module(at("../../train/local-files-server.ts"), { namedExports: { localFilesFor: async (id: string) => (id === JOB ? FILES : null) } });
    const kitActual = await import("@/lib/drive/kit");
    const realKit = (await kitActual.loadKit())!;
    mock.module(at("../../drive/kit.ts"), { namedExports: { ...kitActual, loadKit: async () => ({ ...realKit, baseUrl: "https://kit.test/drive-kit/" }) } });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      netAsked.push(url);
      if (url.startsWith("https://huggingface.co/") && url.includes("/raw/")) return new Response(`# Bakery helper GGUF\n\n${builtWithBlock("These files")}\n`);
      throw new Error("no network in this test");
    }) as typeof fetch;
    boards = await import("@/app/api/boards/route");
    productBoard = await import("@/app/api/products/[slug]/board/route");
    gadget = await import("@/app/api/gateway/gadget/route");
    store = await import("@/lib/caps/hardware/store");
    principal = await import("@/lib/tools/principal");
    const [a] = await testDb.insert(realSchema.users).values({ email: "owner@example.com", isAdmin: true }).returning();
    const [b] = await testDb.insert(realSchema.users).values({ email: "other@example.com", isAdmin: true }).returning();
    owner = a!.id;
    otherOwner = b!.id;
    const [p] = await testDb.insert(realSchema.products).values({ slug: "corner", name: "Corner", ownerId: owner, status: "live" }).returning();
    const [q] = await testDb.insert(realSchema.products).values({ slug: "theirs", name: "Theirs", ownerId: otherOwner, status: "live" }).returning();
    product = p!.id;
    theirProduct = q!.id;
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await client?.close();
  });

  beforeEach(async () => {
    boardCalls.length = 0;
    legacy.length = 0;
    netAsked.length = 0;
    boardExport = null;
    Object.assign(CAP_READY, { hardware: true });
    Object.assign(process.env, { HARDWARE_ENABLED: "1", HARDWARE_BOARD_REGISTRY: "1", HARDWARE_BOARD_KEY: newBoxKey(), TOOLS_SIGNING_SECRET: "made-up-secret-for-the-drive-route-test-0123456789", HARDWARE_GADGET_OWNER_CHECK: "1", DRIVE_EXPORT_PRODUCTS: "1" });
    await testDb.delete(realSchema.productBoards);
    await testDb.delete(realSchema.devices);
    await testDb.delete(realSchema.rateLimits);
  });
  afterEach(() => {
    Object.assign(CAP_READY, { hardware: capWasReady });
    for (const k of ["HARDWARE_ENABLED", "HARDWARE_BOARD_REGISTRY", "HARDWARE_BOARD_KEY", "HARDWARE_GADGET_OWNER_CHECK", "DRIVE_EXPORT_PRODUCTS", "TOOLS_SIGNING_SECRET"]) delete process.env[k];
  });

  it("the whole way: registered board, own model, confirmed once, export on the board, done", async () => {
    await linkBoard();
    const pass = passFor(product, owner);
    const card = await payload<{ code: string; approval: { id: string; lines: string[] } }>(await call(LIVE, EXPORT(), pass));
    assert.equal(card.code, "needs_confirmation");
    assert.deepEqual(boardCalls.map((c) => c.name), ["drive_status"]);

    const res = await call(LIVE, EXPORT({ approval: card.approval.id }), pass);
    const raw = await res.clone().text();
    assert.doesNotMatch(raw, SECRET_TEXT);
    const started = await payload<{ ok: boolean; state: string }>(res);
    assert.deepEqual([started.ok, started.state], [true, "checking"]);
    const sent = boardCalls.find((c) => c.name === "export_model")!;
    assert.equal(sent.args.drive, "sda");
    assert.equal(sent.args.wait_for_drive, undefined);
    assert.ok((sent.args.plan as { files: Array<{ path: string }> }).files.some((f) => f.path === "licenses/MUSE_MODEL_LICENSE.md"));

    // The nonce is spent in rate_limits, as the tool gateway's are.
    const spent = await testDb.select().from(realSchema.rateLimits).where(like(realSchema.rateLimits.key, "tool-approval:%"));
    assert.equal(spent.length, 1);
    boardExport = { export: "exp_x", state: "done", message: "Done: PASS. Safe to unplug.", result: "PASS", problems: [] };
    const doneRes = await call(LIVE, STATUS, pass);
    const doneRaw = await doneRes.clone().text();
    assert.ok(!doneRaw.includes("secret-run"));
    const done = await payload<{ export: { state: string; result: string } }>(doneRes);
    assert.deepEqual([done.export.state, done.export.result], ["done", "PASS"]);
    assert.deepEqual(legacy, [], "DEVICE_MCP_URL's board was never reached");
  });

  it("a spent approval can't start a second export", async () => {
    await linkBoard();
    const pass = passFor(product, owner);
    const card = await payload<{ approval: { id: string } }>(await call(LIVE, EXPORT(), pass));
    await payload(await call(LIVE, EXPORT({ approval: card.approval.id }), pass));
    boardExport = { export: "exp_x", state: "stopped" };
    const again = await payload<{ code: string; stale: boolean }>(await call(LIVE, EXPORT({ approval: card.approval.id }), pass));
    assert.deepEqual([again.code, again.stale], ["needs_confirmation", true]);
    assert.equal(boardCalls.filter((c) => c.name === "export_model").length, 1);
  });

  it("a visitor on a link open to visitors, an admin's own pass and another owner's board all get 503, and the board is never called", async () => {
    await linkBoard(true);
    for (const [token, headers] of [
      [LIVE, { [VISITOR_HEADER]: "v".repeat(24) }],
      [LIVE, {}],
      [LIVE, passFor(product, otherOwner)],
      [LIVE, passFor(theirProduct, owner)],
    ] as const) {
      for (const body of [EXPORT(), STATUS]) {
        const res = await call(token, body, headers);
        assert.equal(res.status, 503);
        assert.equal(await code(res), "gadget_offline");
      }
    }
    // Someone else's product pointed at this board: the row's own join refuses, even with that product's real owner's pass.
    const [board] = await testDb.select().from(realSchema.devices).where(eq(realSchema.devices.ownerUserId, owner));
    await testDb.insert(realSchema.productBoards).values({ productId: theirProduct, boardId: board!.id, visitors: true });
    const theirs = await call(THEIR_LIVE, STATUS, passFor(theirProduct, otherOwner));
    assert.equal(theirs.status, 503);
    assert.deepEqual(boardCalls, []);
    assert.deepEqual(legacy, []);
  });

  it("a build gets the simulator through the real counters, and no board, even with one linked", async () => {
    await linkBoard();
    const card = await payload<{ approval: { id: string }; simulated: boolean }>(await call(BUILD, EXPORT()));
    assert.equal(card.simulated, true);
    const started = await payload<{ ok: boolean; simulated: boolean }>(await call(BUILD, EXPORT({ approval: card.approval.id })));
    assert.deepEqual([started.ok, started.simulated], [true, true]);
    const going = await payload<{ export: { state: string }; simulated: boolean }>(await call(BUILD, STATUS));
    assert.equal(going.simulated, true);
    assert.notEqual(going.export, null, "the real rate_limits row is the simulator's clock");
    assert.ok(["checking", "writing", "verifying", "done"].includes(going.export.state));
    assert.ok((await store.latestProofAt(`hardware-proof:export_to_drive:${BUILD_ID}`)) instanceof Date);
    assert.equal(await store.latestProofAt("hardware-proof:export_to_drive:nobody"), null);
    assert.deepEqual(boardCalls, []);
    assert.deepEqual(legacy, []);
    assert.deepEqual(netAsked, []);
  });

  it("the cap unserved: a token and a pass made while it was on reach nothing, and /gadget answers as it did", async () => {
    await linkBoard();
    const pass = passFor(product, owner);
    const card = await payload<{ code: string; approval: { id: string } }>(await call(LIVE, EXPORT(), pass));
    assert.equal(card.code, "needs_confirmation", "served, the same token and pass get a card");
    boardCalls.length = 0;
    const offs: Array<() => () => void> = [
      () => {
        delete process.env.HARDWARE_ENABLED;
        return () => void (process.env.HARDWARE_ENABLED = "1");
      },
      () => {
        Object.assign(CAP_READY, { hardware: false });
        return () => void Object.assign(CAP_READY, { hardware: true });
      },
    ];
    for (const off of offs) {
      const restore = off();
      for (const body of [EXPORT(), EXPORT({ approval: card.approval.id }), STATUS]) {
        const res = await call(LIVE, body, pass);
        assert.equal(res.status, 403);
        assert.equal(await code(res), "gadget_not_allowed");
      }
      const listed = await gadget.GET(new Request("https://mm.example/api/gateway/gadget", { headers: { authorization: `Bearer ${LIVE}`, ...pass } }));
      assert.ok(!(await listed.text()).includes("export_to_drive"));
      restore();
    }
    assert.deepEqual(boardCalls, []);
    assert.deepEqual(legacy, []);
  });

  it("flags off: the route's tools aren't there for anyone, and neither board is touched", async () => {
    await linkBoard();
    const pass = passFor(product, owner);
    for (const off of [["DRIVE_EXPORT_PRODUCTS"], ["HARDWARE_GADGET_OWNER_CHECK"], ["DRIVE_EXPORT_PRODUCTS", "HARDWARE_GADGET_OWNER_CHECK"]]) {
      const saved = off.map((k) => [k, process.env[k]] as const);
      for (const k of off) delete process.env[k];
      for (const [token, headers] of [[LIVE, pass], [BUILD, {}]] as const) {
        const res = await call(token, EXPORT(), headers);
        assert.equal(res.status, 403, off.join());
        assert.equal(await code(res), "gadget_not_allowed");
      }
      for (const [k, v] of saved) process.env[k] = v;
    }
    assert.deepEqual(boardCalls, []);
    assert.deepEqual(legacy, []);
  });
});
