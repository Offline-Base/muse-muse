/**
 * Drives /api/device/ask with auth, the board, the spend cap and the model faked: guests never reach the model or the
 * board, a paused platform spends nothing, and every model call is recorded.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/device/__tests__/ask-route.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import OpenAI from "openai";
import { ASKS_PER_MINUTE } from "@/lib/device/agent";

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

describe("/api/device/ask", { skip: typeof mock.module !== "function" }, () => {
  let admin = true;
  let openAccess = false;
  let paused = false;
  let boardDown = false;
  let modelDown = false;
  let modelCalls = 0;
  let offered: string[][] = [];
  let recorded: Array<{ ctx: { source: string; endpoint: string }; items: Array<{ model: string; outputTokens: number }> }> = [];
  let boardCalls = 0;
  let hits = 0;
  let pauseAfterModelCalls = Infinity;
  let roverListed = 0;
  let handlers: typeof import("@/app/api/device/ask/route");

  const post = (body: unknown) => handlers.POST(new Request("http://x/api/device/ask", { method: "POST", body: JSON.stringify(body) }));

  before(async () => {
    mock.module(at("../../auth.ts"), {
      namedExports: {
        AuthError: FakeAuthError,
        requireAdminOrAutomation: async () => {
          if (!admin) throw new FakeAuthError("Admins only.", 403);
          return { id: "u", email: "a@example.com", isAdmin: true, ...(openAccess ? { openAccess } : {}) };
        },
      },
    });
    mock.module(at("../client.ts"), {
      namedExports: {
        deviceConfig: () => (process.env.DEVICE_MCP_URL ? { url: process.env.DEVICE_MCP_URL, token: TOKEN_VALUE } : null),
        listDeviceTools: async () => {
          boardCalls++;
          if (boardDown) throw new Error(`fetch failed for ${URL_VALUE} with ${TOKEN_VALUE}`);
          return [{ name: "capture_image", inputSchema: { type: "object" } }];
        },
        callDeviceTool: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
      },
    });
    mock.module(at("../rover.ts"), {
      namedExports: {
        roverBoard: () => "ArduinoQ-01",
        listRoverTools: async () => {
          roverListed++;
          return ["rover_drive", "rover_ranges"].map((name) => ({ name, inputSchema: { type: "object" } }));
        },
        callRoverTool: async () => ({ content: [{ type: "text", text: '{"front_mm":500}' }], isError: false }),
      },
    });
    mock.module(at("../../quota.ts"), { namedExports: { spendPaused: async () => paused || modelCalls >= pauseAfterModelCalls } });
    mock.module(at("../../gateway/store.ts"), {
      namedExports: { hitRateLimits: async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, ++hits])) },
    });
    mock.module(at("../../usage.ts"), {
      namedExports: {
        recordUsage: async (ctx: { source: string; endpoint: string }, items: Array<{ model: string; outputTokens: number }>) => {
          recorded.push({ ctx, items });
        },
      },
    });
    mock.module(at("../../meta/platform.ts"), {
      namedExports: {
        metaPlatform: () => ({
          responses: {
            create: async (body: { tools?: Array<{ name: string }> }) => {
              modelCalls++;
              offered.push((body.tools ?? []).map((tool) => tool.name));
              if (modelDown) throw new OpenAI.APIConnectionError({ message: "model down" });
              return modelCalls === 1
                ? { id: "r1", output: [{ type: "function_call", name: "capture_image", arguments: "{}", call_id: "c1" }], usage: { output_tokens: 5 } }
                : { id: "r2", output: [], output_text: "A desk.", usage: { output_tokens: 7 } };
            },
          },
        }),
      },
    });
    handlers = await import("@/app/api/device/ask/route");
  });

  beforeEach(() => {
    admin = true;
    paused = false;
    boardDown = false;
    modelDown = false;
    modelCalls = 0;
    offered = [];
    boardCalls = 0;
    hits = 0;
    pauseAfterModelCalls = Infinity;
    roverListed = 0;
    recorded = [];
    process.env.DEVICE_MCP_URL = URL_VALUE;
  });

  after(() => {
    delete process.env.DEVICE_MCP_URL;
    mock.reset();
  });

  it("refuses anyone but an admin before the model or the board", async () => {
    admin = false;
    assert.equal((await post({ prompt: "look" })).status, 403);
    assert.equal(modelCalls + boardCalls, 0);
  });

  it("refuses a missing or oversized prompt", async () => {
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ prompt: "   " })).status, 400);
    assert.equal((await post({ prompt: "x".repeat(2001) })).status, 400);
    assert.equal(modelCalls, 0);
  });

  it("says so when no board is configured", async () => {
    delete process.env.DEVICE_MCP_URL;
    const res = await post({ prompt: "look" });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "device_not_configured");
  });

  it("answers with the fleet alone when no single board is set up, and never touches a board", async () => {
    delete process.env.DEVICE_MCP_URL;
    process.env.BOARD_FLEET_URL = "https://fleet.example.com/admin";
    process.env.BOARD_FLEET_TOKEN = "jpt_made_up_token";
    try {
      const res = await post({ prompt: "what's on the fleet?" });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(offered[0], ["fleet_status", "fleet_ask_model"]);
      assert.equal(boardCalls, 0);
      // The fake model asks for capture_image, which isn't there to reach.
      assert.equal(data.steps[0].isError, true);
      assert.equal(data.answer, "A desk.");
    } finally {
      delete process.env.BOARD_FLEET_URL;
      delete process.env.BOARD_FLEET_TOKEN;
    }
  });

  it("offers Wonder the fleet only when the fleet is set up", async () => {
    await post({ prompt: "look" });
    assert.deepEqual(offered[0], ["capture_image"]);
  });

  it("doesn't give OPEN_ACCESS=admin's stand-in admin the fleet, with or without a board", async () => {
    process.env.BOARD_FLEET_URL = "https://fleet.example.com/admin";
    process.env.BOARD_FLEET_TOKEN = "jpt_made_up_token";
    openAccess = true;
    try {
      assert.equal((await post({ prompt: "what's on the fleet?" })).status, 200);
      assert.deepEqual(offered[0], ["capture_image"]);

      delete process.env.DEVICE_MCP_URL;
      const res = await post({ prompt: "what's on the fleet?" });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, "device_not_configured");
    } finally {
      openAccess = false;
      delete process.env.BOARD_FLEET_URL;
      delete process.env.BOARD_FLEET_TOKEN;
    }
  });

  it("gives Wonder the rover only with ROVER_ENABLED and the fleet, and never to OPEN_ACCESS=admin's stand-in admin", async () => {
    process.env.BOARD_FLEET_URL = "https://fleet.example.com/admin";
    process.env.BOARD_FLEET_TOKEN = "jpt_made_up_token";
    try {
      await post({ prompt: "how far is the wall?" });
      assert.equal(roverListed, 0);
      assert.ok(!offered[0]!.includes("rover_ranges"));

      process.env.ROVER_ENABLED = "1";
      offered = [];
      modelCalls = 0;
      await post({ prompt: "how far is the wall?" });
      assert.equal(roverListed, 1);
      assert.deepEqual(offered[0], ["capture_image", "rover_ranges", "fleet_status", "fleet_ask_model"]);

      openAccess = true;
      offered = [];
      modelCalls = 0;
      await post({ prompt: "how far is the wall?" });
      assert.equal(roverListed, 1);
      assert.deepEqual(offered[0], ["capture_image"]);

      openAccess = false;
      delete process.env.BOARD_FLEET_TOKEN;
      offered = [];
      modelCalls = 0;
      await post({ prompt: "how far is the wall?" });
      assert.equal(roverListed, 1);
    } finally {
      openAccess = false;
      delete process.env.ROVER_ENABLED;
      delete process.env.BOARD_FLEET_URL;
      delete process.env.BOARD_FLEET_TOKEN;
    }
  });

  it("spends nothing once the platform is paused", async () => {
    paused = true;
    const res = await post({ prompt: "look" });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "paused");
    assert.equal(modelCalls + boardCalls, 0);
  });

  it("stops partway when the spend cap is reached during a question", async () => {
    pauseAfterModelCalls = 1;
    const res = await post({ prompt: "what do you see?" });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "paused");
    assert.equal(modelCalls, 1);
  });

  it("limits how many questions an admin can ask in a minute", async () => {
    for (let i = 0; i < ASKS_PER_MINUTE; i++) {
      modelCalls = 0;
      assert.equal((await post({ prompt: "look" })).status, 200);
    }
    modelCalls = 0;
    boardCalls = 0;
    const res = await post({ prompt: "look" });
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error, "rate_limited");
    assert.equal(modelCalls + boardCalls, 0);
  });

  it("answers and records every model call", async () => {
    const res = await post({ prompt: "what do you see?" });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.answer, "A desk.");
    assert.equal(data.steps[0].tool, "capture_image");
    assert.deepEqual(recorded.map((r) => r.items[0]!.outputTokens), [5, 7]);
    assert.deepEqual(recorded[0]!.ctx, { source: "platform", endpoint: "device_ask" });
  });

  it("names which side failed, and keeps the address and token out of the reply", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      boardDown = true;
      const board = await post({ prompt: "look" });
      const text = await board.text();
      assert.equal(board.status, 502);
      assert.match(text, /device_unavailable/);
      assert.doesNotMatch(text, new RegExp(`${TOKEN_VALUE}|board\\.example`));

      boardDown = false;
      modelDown = true;
      const model = await post({ prompt: "look" });
      assert.equal(model.status, 502);
      assert.equal((await model.json()).error, "model_unavailable");
    } finally {
      console.error = original;
    }
  });
});
