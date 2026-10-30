/**
 * Drives /api/device with auth and the board client faked: guests never reach the board, a missing board says so, and
 * neither the address nor the token ever appears in a reply.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/device/__tests__/route.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

const at = (path: string) => new URL(path, import.meta.url).href;
const URL_VALUE = "https://board.example/mcp";
/** A test value, not a real token. */
const TOKEN_VALUE = "test-device-token";

class FakeAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

describe("/api/device", { skip: typeof mock.module !== "function" }, () => {
  let admin = true;
  let calls: Array<{ name: string; args: unknown }> = [];
  let boardDown = false;
  let handlers: typeof import("@/app/api/device/route");

  const post = (body: unknown) =>
    handlers.POST(new Request("http://x/api/device", { method: "POST", body: JSON.stringify(body) }));

  before(async () => {
    mock.module(at("../../auth.ts"), {
      namedExports: {
        AuthError: FakeAuthError,
        requireAdminOrAutomation: async () => {
          if (!admin) throw new FakeAuthError("Admins only.", 403);
          return { id: "u", email: "a@example.com", isAdmin: true };
        },
      },
    });
    mock.module(at("../client.ts"), {
      namedExports: {
        deviceConfig: () => (process.env.DEVICE_MCP_URL ? { url: process.env.DEVICE_MCP_URL, token: process.env.DEVICE_MCP_TOKEN } : null),
        listDeviceTools: async () => [{ name: "describe_device", inputSchema: { type: "object" } }],
        callDeviceTool: async (_config: unknown, name: string, args: unknown) => {
          if (boardDown) throw new Error(`fetch failed for ${URL_VALUE} with ${TOKEN_VALUE}`);
          calls.push({ name, args });
          return { content: [{ type: "text", text: "ok" }], isError: false };
        },
      },
    });
    handlers = await import("@/app/api/device/route");
  });

  beforeEach(() => {
    admin = true;
    boardDown = false;
    calls = [];
    process.env.DEVICE_MCP_URL = URL_VALUE;
    process.env.DEVICE_MCP_TOKEN = TOKEN_VALUE;
  });

  after(() => {
    delete process.env.DEVICE_MCP_URL;
    delete process.env.DEVICE_MCP_TOKEN;
    mock.reset();
  });

  it("refuses anyone but an admin before touching the board", async () => {
    admin = false;
    const res = await post({ tool: "capture_image" });
    assert.equal(res.status, 403);
    assert.equal((await handlers.GET(new Request("http://x/api/device"))).status, 403);
    assert.deepEqual(calls, []);
  });

  it("says so when no board is configured", async () => {
    delete process.env.DEVICE_MCP_URL;
    const res = await post({ tool: "capture_image" });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "device_not_configured");
  });

  it("lists the board's tools", async () => {
    const res = await handlers.GET(new Request("http://x/api/device"));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).tools[0].name, "describe_device");
  });

  it("passes one tool call through and defaults its arguments", async () => {
    const res = await post({ tool: "describe_device" });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [{ name: "describe_device", args: {} }]);
  });

  it("refuses a body with no tool, or arguments that aren't an object", async () => {
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ tool: "x", arguments: [1] })).status, 400);
    assert.equal((await post({ tool: "x", arguments: "y" })).status, 400);
    assert.deepEqual(calls, []);
  });

  it("keeps the address and token out of the reply when the board is down", async () => {
    boardDown = true;
    const original = console.error;
    console.error = () => {};
    try {
      const res = await post({ tool: "describe_device" });
      const text = await res.text();
      assert.equal(res.status, 502);
      assert.match(text, /device_unavailable/);
      assert.doesNotMatch(text, new RegExp(`${TOKEN_VALUE}|board\\.example`));
    } finally {
      console.error = original;
    }
  });
});
