/**
 * The registry and the gadget route against the real muse-device/server.py over real MCP, on loopback with a throwaway home
 * folder and made-up token. No board: a Mac has no sensors, so read_sensor comes back as the tool's own plain error.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/caps/hardware/__tests__/real-server.test.ts
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";
import { OWNER_HEADER } from "@/lib/gateway/policy";
import { newBoxKey } from "@/lib/secrets/box";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const python = spawnSync("python3", ["--version"]).status === 0;
const at = (path: string) => new URL(path, import.meta.url).href;
const TOKEN = "made-up-board-token-0123456789-0123456789";
const LIVE = "mm_live_" + "a".repeat(30);
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

describe("against the real muse-device server", { skip: !canMock ? "needs --experimental-test-module-mocks" : !python ? "needs python3" : false }, () => {
  let home = "";
  let child: ChildProcess | null = null;
  let url = "";
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let boards: typeof import("@/app/api/boards/route");
  let productBoard: typeof import("@/app/api/products/[slug]/board/route");
  let gadget: typeof import("@/app/api/gateway/gadget/route");
  let ownerPass = "";
  let userId = "";

  before(async () => {
    home = mkdtempSync(join(tmpdir(), "mm-board-"));
    mkdirSync(join(home, ".muse-device"), { mode: 0o700 });
    writeFileSync(join(home, ".muse-device/token"), TOKEN, { mode: 0o600 });
    const port = await freePort();
    url = `http://127.0.0.1:${port}/mcp`;
    child = spawn("python3", [new URL("../../../../muse-device/server.py", import.meta.url).pathname, "--port", String(port)], { env: { PATH: process.env.PATH ?? "", HOME: home } as unknown as NodeJS.ProcessEnv, stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      const up = await fetch(url, { method: "POST" }).then(() => true, () => false);
      if (up) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../../drizzle", import.meta.url).pathname });
    const [user] = await testDb.insert(realSchema.users).values({ email: "admin@example.com", isAdmin: true }).returning();
    const [product] = await testDb.insert(realSchema.products).values({ slug: "corner", name: "Corner", ownerId: user!.id, status: "live" }).returning();
    userId = user!.id;
    mock.module(at("../../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    class AuthError extends Error {
      status = 401;
    }
    mock.module(at("../../../auth.ts"), { namedExports: { AuthError, GUEST_EMAIL: "guest@musemuse.invalid", isCrossSite: () => false, requireAdmin: async () => ({ id: userId, isAdmin: true }), requireUser: async () => ({ id: userId, isAdmin: true }) } });
    mock.module(at("../../../gateway/tokens.ts"), {
      namedExports: { findToken: async (t: string) => (t === LIVE ? { id: "tok", productId: product!.id, scope: "live", allowedModels: ["muse-gadget", "cap:hardware", "board-tools"], dailyBudgetUsd: 3 } : null) },
    });
    process.env.HARDWARE_BOARD_REGISTRY = "1";
    process.env.HARDWARE_BOARD_TOOLS = "1";
    process.env.HARDWARE_GADGET_OWNER_CHECK = "1";
    process.env.HARDWARE_BOARD_KEY = newBoxKey();
    process.env.TOOLS_SIGNING_SECRET = "made-up-secret-for-the-real-server-test-0123456789";
    boards = await import("@/app/api/boards/route");
    productBoard = await import("@/app/api/products/[slug]/board/route");
    gadget = await import("@/app/api/gateway/gadget/route");
    const { mintOwnerSession, ownerSubject } = await import("@/lib/tools/principal");
    ownerPass = mintOwnerSession({ productId: product!.id, subject: ownerSubject(userId) }, new Date()).session;
  });

  after(async () => {
    child?.kill();
    await client?.close();
    rmSync(home, { recursive: true, force: true });
    for (const k of ["HARDWARE_BOARD_REGISTRY", "HARDWARE_BOARD_TOOLS", "HARDWARE_GADGET_OWNER_CHECK", "HARDWARE_BOARD_KEY", "TOOLS_SIGNING_SECRET"]) delete process.env[k];
  });

  const json = (body: unknown) => new Request("https://mm.example/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const tool = (name: string, args: object, headers: Record<string, string> = {}) =>
    gadget.POST(new Request("https://mm.example/api/gateway/gadget", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${LIVE}`, ...headers }, body: JSON.stringify({ tool: name, arguments: args }) }));

  it("refuses a wrong token, registers with the right one, and the owner reaches the board's tools", async () => {
    const wrong = await boards.POST(json({ name: "Local", mcpUrl: url, token: "w".repeat(40) }));
    assert.equal(wrong.status, 502, "the board refused the token");
    const made = await boards.POST(json({ name: "Local", mcpUrl: url, token: TOKEN }));
    assert.equal(made.status, 201);
    const { id } = (await made.json()) as { id: string };
    const linked = await productBoard.POST(json({ boardId: id }), { params: Promise.resolve({ slug: "corner" }) });
    assert.equal(linked.status, 200);

    assert.equal((await tool("show_text", { text: "Hi" })).status, 503, "nobody without the owner's pass");
    assert.equal(existsSync(join(home, ".muse-device/show-text.txt")), false);

    const owner = { [OWNER_HEADER]: ownerPass };
    const shown = (await (await tool("show_text", { text: "Back in 5 minutes" }, owner)).json()) as { isError: boolean; simulated: boolean; content: Array<{ text: string }> };
    assert.equal(shown.isError, false);
    assert.equal(shown.simulated, false);
    assert.deepEqual(JSON.parse(shown.content[0]!.text), { shown: "Back in 5 minutes" });
    assert.equal(readFileSync(join(home, ".muse-device/show-text.txt"), "utf8"), "Back in 5 minutes\n");

    const described = (await (await tool("describe_device", {}, owner)).json()) as { content: Array<{ text: string }> };
    assert.deepEqual(Object.keys(JSON.parse(described.content[0]!.text)).sort(), ["cameras", "microphones", "model"], "a product learns what a board has, not where it sits");

    const sensor = await tool("read_sensor", {}, owner);
    assert.equal(sensor.status, 200, "answered, with or without sensors on this machine");

    const list = (await (await gadget.GET(new Request("https://mm.example/api/gateway/gadget", { headers: { authorization: `Bearer ${LIVE}`, [OWNER_HEADER]: ownerPass } }))).json()) as { tools: Array<{ name: string }> };
    assert.deepEqual(list.tools.map((t) => t.name).sort(), ["capture_image", "describe_device", "read_sensor", "record_audio", "show_text"], "never run_command");
    assert.equal((await tool("run_command", { command: "id" }, owner)).status, 400);
  });
});
