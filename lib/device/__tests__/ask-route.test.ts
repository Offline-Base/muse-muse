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
  let paused = false;
  let boardDown = false;
  let modelDown = false;
  let modelCalls = 0;
  let recorded: Array<{ ctx: { source: string; endpoint: string }; items: Array<{ model: string; outputTokens: number }> }> = [];
  let boardCalls = 0;
  let hits = 0;
  let pauseAfterModelCalls = Infinity;
  let handlers: typeof import("@/app/api/device/ask/route");

  const post = (body: unknown) => handlers.POST(new Request("http://x/api/device/ask", { method: "POST", body: JSON.stringify(body) }));

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
        deviceConfig: () => (process.env.DEVICE_MCP_URL ? { url: process.env.DEVICE_MCP_URL, token: TOKEN_VALUE } : null),
        listDeviceTools: async () => {
          boardCalls++;
          if (boardDown) throw new Error(`fetch failed for ${URL_VALUE} with ${TOKEN_VALUE}`);
          return [{ name: "capture_image", inputSchema: { type: "object" } }];
        },
        callDeviceTool: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
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
            create: async () => {
              modelCalls++;
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
    boardCalls = 0;
    hits = 0;
    pauseAfterModelCalls = Infinity;
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
