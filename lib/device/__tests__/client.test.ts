/**
 * Checks how long the client waits for each tool: past the board's own limit for the slow ones, so a call that is still
 * working isn't reported as a board that's down, and the SDK's default for the rest.
 *
 *   npx tsx --test lib/device/__tests__/client.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callDeviceTool } from "@/lib/device/client";

const CONFIG = { url: "https://board.example/mcp", token: "test-device-token" };

async function timeoutFor(tool: string): Promise<number | undefined> {
  mock.method(Client.prototype, "connect", async () => {});
  const call = mock.method(Client.prototype, "callTool", async () => ({ content: [], isError: false }));
  await callDeviceTool(CONFIG, tool, {});
  const options = call.mock.calls[0]!.arguments[2] as { timeout?: number };
  return options.timeout;
}

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
