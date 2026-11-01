/**
 * Checks how long the client waits for each tool: past the board's own limit for the slow ones, so a call that is still
 * working isn't reported as a board that's down, and the SDK's default for the rest.
 *
 *   npx tsx --test lib/device/__tests__/client.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callDeviceTool, deviceConfig } from "@/lib/device/client";

const CONFIG = { url: "https://board.example/mcp", token: "test-device-token" };

async function timeoutFor(tool: string): Promise<number | undefined> {
  mock.method(Client.prototype, "connect", async () => {});
  const call = mock.method(Client.prototype, "callTool", async () => ({ content: [], isError: false }));
  await callDeviceTool(CONFIG, tool, {});
  const options = call.mock.calls[0]!.arguments[2] as { timeout?: number };
  return options.timeout;
}

describe("deviceConfig", () => {
  const TOKEN = "test-device-token";
  const configFor = (url: string) => {
    process.env.DEVICE_MCP_URL = url;
    process.env.DEVICE_MCP_TOKEN = TOKEN;
    return deviceConfig();
  };

  afterEach(() => {
    delete process.env.DEVICE_MCP_URL;
    delete process.env.DEVICE_MCP_TOKEN;
    mock.restoreAll();
  });

  it("takes https, and plain http only on this machine", () => {
    for (const url of ["https://board.example/mcp", "http://127.0.0.1:8765/mcp", "http://localhost:8765/mcp", "http://[::1]:8765/mcp"]) {
      assert.deepEqual(configFor(url), { url, token: TOKEN });
    }
  });

  it("won't send the token anywhere it could be read on the way, and doesn't log the address", () => {
    const logged = mock.method(console, "error", () => {});
    for (const url of ["http://board.example/mcp", "http://192.168.1.5:8765/mcp", "ftp://board.example/mcp", "not a url"]) {
      assert.equal(configFor(url), null, url);
    }
    assert.equal(logged.mock.callCount(), 4);
    assert.doesNotMatch(JSON.stringify(logged.mock.calls.map((c) => c.arguments)), /board\.example|192\.168/);
  });

  it("logs nothing for an unsafe address when asked to be quiet", () => {
    const logged = mock.method(console, "error", () => {});
    process.env.DEVICE_MCP_URL = "http://board.example/mcp";
    process.env.DEVICE_MCP_TOKEN = TOKEN;
    assert.equal(deviceConfig({ quiet: true }), null);
    assert.equal(logged.mock.callCount(), 0);
  });

  it("is off when either is missing", () => {
    assert.equal(deviceConfig(), null);
    process.env.DEVICE_MCP_URL = "   ";
    process.env.DEVICE_MCP_TOKEN = TOKEN;
    assert.equal(deviceConfig(), null);
  });
});

describe("callDeviceTool", () => {
  afterEach(() => mock.restoreAll());

  it("waits past the board's own limit for its slow tools, and within a route's 300 seconds", async () => {
    for (const [tool, boardLimitMs] of [
      ["start_model", 120_000],
      ["ask_model", 240_000],
      ["install_model", 280_000],
    ] as const) {
      const timeout = await timeoutFor(tool);
      assert.ok(timeout! > boardLimitMs && timeout! < 300_000, `${tool}: ${timeout}`);
      mock.restoreAll();
    }
  });

  it("leaves other tools at the SDK's default", async () => {
    assert.equal(await timeoutFor("capture_image"), undefined);
  });
});
