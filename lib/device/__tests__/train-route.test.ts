/**
 * Drives /api/device/train with auth, the board client and the store faked: guests never reach the board, every failure
 * has its own status, the board's refusal is passed on, and neither the address nor the token ever appears in a reply.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/device/__tests__/train-route.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import type { DeviceToolResult } from "@/lib/device/client";

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

const text = (value: string, isError = false): DeviceToolResult => ({ content: [{ type: "text", text: value }], isError });

describe("/api/device/train", { skip: typeof mock.module !== "function" }, () => {
  let admin = true;
  let boardDown = false;
  let storeDown = false;
  let page: { status: string; total: number; items: unknown[] } | null = null;
  let calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let replies: Record<string, DeviceToolResult> = {};
  let handlers: typeof import("@/app/api/device/train/route");

  const post = (body: unknown) => handlers.POST(new Request("http://x/api/device/train", { method: "POST", body: JSON.stringify(body) }));
  const get = (query = "") => handlers.GET(new Request(`http://x/api/device/train${query}`));
  const del = (query = "") => handlers.DELETE(new Request(`http://x/api/device/train${query}`, { method: "DELETE" }));
  const START = { datasetId: "d", name: "bakery" };

  /** Runs `use` with the expected console.error out of the test's output. */
  async function quietly<T>(use: () => Promise<T>): Promise<T> {
    const original = console.error;
    console.error = () => {};
    try {
      return await use();
    } finally {
      console.error = original;
    }
  }

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
        callDeviceTool: async (_config: unknown, name: string, args: Record<string, unknown>) => {
          if (boardDown) throw new Error(`fetch failed for ${URL_VALUE} with ${TOKEN_VALUE}`);
          calls.push({ name, args });
          if (replies[name]) return replies[name];
          if (name === "list_models") return text(JSON.stringify({ files: [] }));
          if (name === "save_dataset") return text(JSON.stringify({ name: args.name, examples: (args.examples as unknown[]).length }));
          if (name === "train_model") return text(JSON.stringify({ run: args.name, state: "loading" }));
          if (name === "training_status") return text(JSON.stringify({ state: "training", step: 5, steps: 60, loss: 1.5 }));
          return text("Stopping.");
        },
      },
    });
    mock.module(at("../../train/store.ts"), {
      namedExports: {
        datasetPage: async () => {
          if (storeDown) throw new Error("database down");
          return page;
        },
      },
    });
    handlers = await import("@/app/api/device/train/route");
  });

  beforeEach(() => {
    admin = true;
    boardDown = false;
    storeDown = false;
    page = { status: "ready", total: 1, items: [{ messages: [{ role: "assistant", content: "Hello" }] }] };
    calls = [];
    replies = {};
    process.env.DEVICE_MCP_URL = URL_VALUE;
  });

  after(() => {
    delete process.env.DEVICE_MCP_URL;
    mock.reset();
  });

  it("refuses anyone but an admin before touching the board", async () => {
    admin = false;
    assert.equal((await post(START)).status, 403);
    assert.equal((await get()).status, 403);
    assert.equal((await del()).status, 403);
    assert.deepEqual(calls, []);
  });

  it("says so when no board is configured", async () => {
    delete process.env.DEVICE_MCP_URL;
    for (const res of [await post(START), await get(), await del()]) {
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, "device_not_configured");
    }
  });

  it("starts a run, sending the dataset first", async () => {
    const res = await post({ ...START, steps: 20, rank: 4, maxLength: 1024 });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { run: "bakery", state: "loading" });
    assert.deepEqual(calls.map((call) => call.name), ["list_models", "save_dataset", "train_model"]);
    assert.deepEqual(calls[2]!.args, { dataset: "bakery", name: "bakery", steps: 20, rank: 4, max_length: 1024 });
  });

  it("refuses bad input before the store or the board", async () => {
    const bad = [
      {},
      { name: "bakery" },
      { datasetId: 5, name: "bakery" },
      { datasetId: "d" },
      { datasetId: "d", name: "../up" },
      { datasetId: "d", name: "x".repeat(65) },
      { ...START, steps: 0 },
      { ...START, steps: 1.5 },
      { ...START, rank: "4" },
      { ...START, maxLength: 0 },
    ];
    for (const body of bad) assert.equal((await post(body)).status, 400, JSON.stringify(body));
    assert.equal((await get("?run=../up")).status, 400);
    assert.equal((await del("?run=../up")).status, 400);
    assert.deepEqual(calls, []);
  });

  it("answers 404 for no such dataset and 409 for one that isn't ready", async () => {
    page = null;
    const missing = await post(START);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "dataset_not_found");

    page = { status: "generating", total: 0, items: [] };
    const generating = await post(START);
    assert.equal(generating.status, 409);
    assert.equal((await generating.json()).error, "dataset_not_ready");
    assert.deepEqual(calls, []);
  });

  it("passes on the board's refusal, wherever it comes from", async () => {
    replies.train_model = text("Run other is still active.", true);
    const start = await post(START);
    assert.equal(start.status, 409);
    assert.deepEqual(await start.json(), { error: "device_refused", message: "Run other is still active." });

    replies.training_status = text("No such run.", true);
    const status = await get("?run=none");
    assert.equal(status.status, 409);
    assert.deepEqual(await status.json(), { error: "device_refused", message: "No such run." });

    replies.stop_training = text("Nothing is running.", true);
    const stop = await del();
    assert.equal(stop.status, 409);
    assert.deepEqual(await stop.json(), { error: "device_refused", message: "Nothing is running." });
  });

  it("reports a run, the newest when none is named", async () => {
    const named = await get("?run=bakery");
    assert.equal(named.status, 200);
    assert.deepEqual(await named.json(), { state: "training", step: 5, steps: 60, loss: 1.5 });
    assert.equal((await get()).status, 200);
    assert.deepEqual(calls, [
      { name: "training_status", args: { run: "bakery" } },
      { name: "training_status", args: {} },
    ]);
  });

  it("stops a run", async () => {
    const res = await del("?run=bakery");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { stopped: true });
    assert.deepEqual(calls, [{ name: "stop_training", args: { run: "bakery" } }]);
  });

  it("keeps the address and token out of the reply when the board is down", async () => {
    boardDown = true;
    await quietly(async () => {
      for (const res of [await post(START), await get(), await del()]) {
        const body = await res.text();
        assert.equal(res.status, 502);
        assert.match(body, /device_unavailable/);
        assert.doesNotMatch(body, new RegExp(`${TOKEN_VALUE}|board\\.example`));
      }
    });
  });

  it("doesn't blame the board for a database that fails", async () => {
    storeDown = true;
    const res = await quietly(() => post(START));
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, "server_error");
    assert.deepEqual(calls, []);
  });
});
