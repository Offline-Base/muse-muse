/**
 * Drives the dataset's trip to the board with a fake store and a fake board that holds to the real one's 1 MiB body limit:
 * every example arrives once and in order, a bad dataset never reaches the board, and a refusal carries the board's words.
 *
 *   npx tsx --test lib/device/__tests__/train.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DeviceToolResult } from "@/lib/device/client";
import {
  DatasetUnavailableError,
  deviceTrainingStatus,
  DeviceRefusedError,
  isRunName,
  startDeviceTraining,
  stopDeviceTraining,
  type DeviceTrainDeps,
} from "@/lib/device/train";
import type { TrainExample } from "@/lib/train/types";

const CONFIG = { url: "https://board.example/mcp", token: "test-device-token" };
const MAX_BODY_BYTES = 1024 * 1024;

const example = (answer: string): TrainExample => ({
  messages: [
    { role: "user", content: "Hi" },
    { role: "assistant", content: answer },
  ],
});
const numbered = (count: number, answer = (i: number) => `Answer ${i}`) => Array.from({ length: count }, (_, i) => example(answer(i)));
const json = (value: unknown): DeviceToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError: false });
const refusal = (text: string): DeviceToolResult => ({ content: [{ type: "text", text }], isError: true });

/** A store holding `items` and a board that keeps the file and answers as save_dataset and train_model do. */
function harness(items: TrainExample[], status = "ready") {
  const reads: Array<{ part: string; offset: number; limit: number }> = [];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const file: TrainExample[] = [];
  const bodies: number[] = [];
  const replies: Record<string, DeviceToolResult> = {};
  const deps: DeviceTrainDeps = {
    readPage: async (_id, part, offset, limit) => {
      reads.push({ part, offset, limit });
      return { status, total: items.length, items: items.slice(offset, offset + limit) };
    },
    callTool: async (_config, name, args) => {
      calls.push({ name, args });
      if (replies[name]) return replies[name]!;
      if (name === "save_dataset") {
        const body = JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name, arguments: args } });
        bodies.push(Buffer.byteLength(body));
        assert.ok(Buffer.byteLength(body) <= MAX_BODY_BYTES, "a body over the board's limit");
        if (!args.append) file.length = 0;
        file.push(...(args.examples as TrainExample[]));
        return json({ name: args.name, examples: file.length });
      }
      return json({ run: args.name, state: "loading" });
    },
  };
  return { reads, calls, file, bodies, replies, deps };
}

describe("startDeviceTraining", () => {
  const start = (deps: DeviceTrainDeps, extra: { steps?: number; rank?: number; maxLength?: number } = {}) =>
    startDeviceTraining(CONFIG, { datasetId: "d", name: "bakery", ...extra }, deps);

  it("reads every train page, sends each example once and in order, then starts the run", async () => {
    const items = numbered(250);
    const h = harness(items);
    assert.deepEqual(await start(h.deps), { run: "bakery", state: "loading" });
    assert.deepEqual(h.reads, [
      { part: "train", offset: 0, limit: 100 },
      { part: "train", offset: 100, limit: 100 },
      { part: "train", offset: 200, limit: 100 },
    ]);
    assert.deepEqual(h.file, items);
    assert.deepEqual(h.calls.at(-1), { name: "train_model", args: { dataset: "bakery", name: "bakery" } });
  });

  it("passes on steps and rank when they're given", async () => {
    const h = harness(numbered(3));
    await start(h.deps, { steps: 20, rank: 4, maxLength: 1024 });
    assert.deepEqual(h.calls.at(-1)!.args, { dataset: "bakery", name: "bakery", steps: 20, rank: 4, max_length: 1024 });
  });

  it("splits by bytes, so long multi-byte answers stay under the body limit", async () => {
    // Each is about 12 KB in bytes and 4 KB in characters, so counting characters would overrun the limit.
    const items = numbered(1000, (i) => `${i} ${"é€漢".repeat(1300)}`);
    const h = harness(items);
    await start(h.deps);
    const saves = h.calls.filter((call) => call.name === "save_dataset");
    assert.ok(saves.length > 1);
    assert.deepEqual(saves.map((save) => save.args.append), saves.map((_, i) => i > 0));
    assert.deepEqual(h.file, items);
    assert.ok(Math.max(...h.bodies) > 0.9 * MAX_BODY_BYTES, "pages should be close to full");
  });

  it("doesn't touch the board for a dataset that's unknown, unfinished or empty", async () => {
    const unknown = harness(numbered(1));
    unknown.deps.readPage = async () => null;
    await assert.rejects(start(unknown.deps), (err: DatasetUnavailableError) => err.reason === "not_found");
    assert.deepEqual(unknown.calls, []);

    const generating = harness(numbered(1), "generating");
    await assert.rejects(start(generating.deps), (err: DatasetUnavailableError) => err.reason === "not_ready");
    assert.deepEqual(generating.calls, []);

    const empty = harness([]);
    await assert.rejects(start(empty.deps), (err: DatasetUnavailableError) => err.reason === "not_ready");
    assert.deepEqual(empty.calls, []);
  });

  it("stops when a dataset stops being ready or runs out partway", async () => {
    const h = harness(numbered(150));
    const read = h.deps.readPage;
    h.deps.readPage = async (...args) => {
      const page = await read(...args);
      return args[2] ? { ...page!, status: "failed" } : page;
    };
    await assert.rejects(start(h.deps), DatasetUnavailableError);
    assert.equal(h.calls.some((call) => call.name === "train_model"), false);

    const short = harness(numbered(150));
    short.deps.readPage = async (_id, _part, offset) => ({ status: "ready", total: 150, items: offset ? [] : numbered(100) });
    await assert.rejects(start(short.deps), /ended at 100 of 150/);
    assert.equal(short.calls.some((call) => call.name === "train_model"), false);
  });

  it("refuses an example too long for any body, rather than have the board reject it", async () => {
    const h = harness([example("x".repeat(MAX_BODY_BYTES))]);
    await assert.rejects(start(h.deps), DeviceRefusedError);
    assert.deepEqual(h.calls, []);
  });

  it("carries the board's words when save_dataset fails, and doesn't train", async () => {
    const h = harness(numbered(2));
    h.replies.save_dataset = refusal("There's too little disk.");
    await assert.rejects(start(h.deps), (err: Error) => err instanceof DeviceRefusedError && err.message === "There's too little disk.");
    assert.equal(h.calls.some((call) => call.name === "train_model"), false);
  });

  it("carries the board's words when train_model refuses", async () => {
    const h = harness(numbered(2));
    h.replies.train_model = refusal("Run other is still active.");
    await assert.rejects(start(h.deps), (err: Error) => err instanceof DeviceRefusedError && err.message === "Run other is still active.");
  });

  it("doesn't train on a copy that came up short", async () => {
    const h = harness(numbered(2));
    h.replies.save_dataset = json({ name: "bakery", examples: 1 });
    await assert.rejects(start(h.deps), /kept 1 of 2/);
    assert.equal(h.calls.some((call) => call.name === "train_model"), false);
  });

  it("lets a board that can't be reached throw", async () => {
    const h = harness(numbered(2));
    h.deps.callTool = async () => {
      throw new Error("fetch failed");
    };
    await assert.rejects(start(h.deps), /fetch failed/);
  });
});

describe("the status and stop calls", () => {
  it("name the run only when there is one", async () => {
    const h = harness([]);
    h.replies.training_status = json({ state: "training", step: 5, steps: 60, loss: 1.5 });
    h.replies.stop_training = { content: [{ type: "text", text: "Stopping." }], isError: false };
    assert.equal((await deviceTrainingStatus(CONFIG, "bakery", h.deps)).step, 5);
    await deviceTrainingStatus(CONFIG, undefined, h.deps);
    await stopDeviceTraining(CONFIG, "bakery", h.deps);
    await stopDeviceTraining(CONFIG, undefined, h.deps);
    assert.deepEqual(h.calls, [
      { name: "training_status", args: { run: "bakery" } },
      { name: "training_status", args: {} },
      { name: "stop_training", args: { run: "bakery" } },
      { name: "stop_training", args: {} },
    ]);
  });

  it("carry the board's refusal", async () => {
    const h = harness([]);
    h.replies.training_status = refusal("No such run.");
    h.replies.stop_training = refusal("Nothing is running.");
    await assert.rejects(deviceTrainingStatus(CONFIG, undefined, h.deps), (err: Error) => err instanceof DeviceRefusedError && err.message === "No such run.");
    await assert.rejects(stopDeviceTraining(CONFIG, undefined, h.deps), (err: Error) => err instanceof DeviceRefusedError && err.message === "Nothing is running.");
  });
});

describe("isRunName", () => {
  it("holds to the board's rule", () => {
    for (const good of ["a", "9", "bakery-helper_v1.2", "x".repeat(64)]) assert.equal(isRunName(good), true, good);
    for (const bad of ["", ".hidden", "-x", "_x", "a/b", "../up", "a b", "a\n", "x".repeat(65), 5, null, undefined]) {
      assert.equal(isRunName(bad), false, String(bad));
    }
  });
});
