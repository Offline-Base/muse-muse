/**
 * Serving Muse Glimmer for products (lib/train/glimmer-serving.ts): Meta's settings and the request checks, the chat
 * backend on fake serving windows (the slot, busy, timeouts, another adapter, the GPU's address kept out of errors),
 * askChat against a local pinned HTTPS server standing in for the GPU, and liveChatServeTarget on an in-memory PGlite
 * with the repo's migrations. The real Python server answering these same requests is in runner.test.ts ("glimmer-serve
 * recipe internals", products' chat). Nothing reaches a GPU, Lambda or Meta, and nothing is spent.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/glimmer-serving.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const openssl = spawnSync("openssl", ["version"]).status === 0;
const at = (rel: string) => new URL(rel, import.meta.url).href;
const savedEnv = { ...process.env };

const ADAPTER = "866e9dbb-1111-4222-8333-444455556666";
const DECIDER = "866e9dbb-2222-4222-8333-444455556666";
const SERVE_JOB = "5e5e5e5e-0000-4000-8000-000000000001";
const CERT = "ab".repeat(32);

type GS = typeof import("@/lib/train/glimmer-serving");
type Serve = typeof import("@/lib/train/serve");
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema> & {
  batch: (queries: PromiseLike<unknown>[]) => Promise<unknown[]>;
};

let gs: GS;
let serve: Serve;
let store: typeof import("@/lib/train/store");
let client: import("@electric-sql/pglite").PGlite;
let testDb: TestDb;

const user = (content: string) => [{ role: "user" as const, content }];

describe("glimmer-serving", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    const local: TestDb = Object.assign(drizzle({ client, schema: realSchema }), {
      batch: async (queries: PromiseLike<unknown>[]) => {
        const results: unknown[] = [];
        for (const q of queries) results.push(await q);
        return results;
      },
    });
    await migrate(local, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
    testDb = local;
    mock.module(at("../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    gs = await import("@/lib/train/glimmer-serving");
    serve = await import("@/lib/train/serve");
    store = await import("@/lib/train/store");
  });

  after(async () => {
    mock.restoreAll();
    process.env = savedEnv;
    await client?.close();
  });

  describe("Meta's settings and the request", () => {
    it("keeps Meta's sampling, end ids and token budgets (deploy.md lines 239, 243, 317, 319 to 321)", () => {
      assert.deepEqual({ ...gs.GLIMMER_SAMPLING }, { temperature: 1.0, top_p: 0.95, top_k: 64 });
      assert.deepEqual([...gs.GLIMMER_EOS_IDS], [200001, 200008]);
      assert.deepEqual({ ...gs.GLIMMER_MAX_TOKENS }, { final: 1024, reasoning: 4096, cap: 4096 });
      assert.deepEqual([...gs.GLIMMER_FINAL_ONLY_STOPS], ["<|eom|>", "<|start|>"]);
      // The chat answer ends on the GPU before the platform gives up, and the platform gives up before the window's slot
      // stops counting, so a call never outlives its slot.
      assert.ok(gs.CHAT_ANSWER_SECONDS * 1000 + serve.serveTiming.connectMs <= serve.serveTiming.chatMs);
      assert.ok(serve.serveTiming.chatMs < store.DEMO_SLOT_MS);
    });

    it("picks the channel and the new tokens: final-only for a trainChannel 0 tuned model, reasoning otherwise", () => {
      assert.equal(gs.glimmerChannel(true, 0), "final");
      assert.equal(gs.glimmerChannel(true, 1), "reasoning");
      assert.equal(gs.glimmerChannel(false, 0), "reasoning");
      assert.equal(gs.glimmerMaxTokens(undefined, "final"), 1024);
      assert.equal(gs.glimmerMaxTokens(undefined, "reasoning"), 4096);
      assert.equal(gs.glimmerMaxTokens(9999, "final"), 4096, "never past the cap");
      assert.equal(gs.glimmerMaxTokens(7, "reasoning"), 7);
      for (const bad of [0, -1, 1.5, Number.NaN]) assert.equal(gs.glimmerMaxTokens(bad, "final"), null, String(bad));
    });

    it("takes <|eom|> out of every stop and never adds it", () => {
      assert.deepEqual(gs.glimmerStops(undefined), []);
      assert.deepEqual(gs.glimmerStops("<|eom|>"), []);
      assert.deepEqual(gs.glimmerStops(["END", "<|eom|>", "a<|eom|>b", "END"]), ["END", "ab"]);
      assert.equal(gs.glimmerStops(["a", "b", "c", "d", "e"]), null);
      assert.equal(gs.glimmerStops(["x".repeat(65)]), null);
    });

    it("checks the messages as the GPU does", () => {
      assert.equal(gs.chatMessagesProblem(user("hi")), null);
      assert.equal(gs.chatMessagesProblem([{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }]), null);
      assert.equal(gs.chatMessagesProblem([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }]), null);
      for (const bad of [
        [],
        "hi",
        [{ role: "tool", content: "hi" }],
        [{ role: "user", content: ["parts"] }],
        [{ role: "user", content: "a" }, { role: "system", content: "late" }, { role: "user", content: "b" }],
        [{ role: "assistant", content: "hi" }],
        user("   "),
        user("x".repeat(gs.CHAT_CHARS_MAX + 1)),
        Array.from({ length: gs.CHAT_MESSAGES_MAX + 1 }, () => ({ role: "user", content: "x" })),
      ]) {
        assert.equal(typeof gs.chatMessagesProblem(bad), "string", JSON.stringify(bad).slice(0, 80));
      }
    });

    it("always sends Meta's sampling in OpenAI's chat shape", () => {
      const body = gs.glimmerChatBody({ model: ADAPTER, messages: user("hi"), maxTokens: 1024, stop: [] });
      assert.deepEqual(body, { model: ADAPTER, messages: user("hi"), max_tokens: 1024, temperature: 1, top_p: 0.95, top_k: 64, stream: false });
      assert.deepEqual(gs.glimmerChatBody({ model: "muse-glimmer", messages: user("hi"), maxTokens: 9, stop: ["END"] }).stop, ["END"]);
    });

    it("maps each ServeError as the contract says", () => {
      const reply = (code: ConstructorParameters<Serve["ServeError"]>[0]) => gs.glimmerErrorReply(new serve.ServeError(code, "x"));
      assert.deepEqual(reply("busy"), { status: 409, code: "busy" });
      assert.deepEqual(reply("stopping"), { status: 503, code: "glimmer_closed" });
      assert.deepEqual(reply("timeout"), { status: 504, code: "timeout" });
      assert.deepEqual(reply("bad_prompt"), { status: 400, code: "bad_request" });
      for (const code of ["unreachable", "pin_mismatch", "refused", "bad_answer"] as const) assert.deepEqual(reply(code), { status: 502, code: "glimmer_unavailable" });
    });
  });

  describe("the chat backend on a serving window", () => {
    type Target = import("@/lib/train/store").ChatServeTargetRow;
    const target = (over: Partial<Target> = {}): Target => ({
      jobId: SERVE_JOB,
      tokenHash: "hash",
      ip: "203.0.113.7",
      port: 8443,
      certSha256: CERT,
      adapterJobId: ADAPTER,
      trainChannel: 0,
      ...over,
    });
    let held = false;
    let taken: string[] = [];
    let released: string[] = [];
    let asked: Array<{ target: unknown; key: string; body: Record<string, unknown>; timeoutMs: number }> = [];
    let answer: () => Promise<import("@/lib/train/serve").ChatAnswer> = async () => ({ text: "Hello", finish: "stop", usage: { input: 9, output: 2 }, ms: 1200 });
    const backends = (t: Target | null = target(), over: Partial<import("@/lib/train/glimmer-serving").ChatWindowDeps> = {}) =>
      gs.chatWindowBackends({
        target: async (adapter) => (t && (adapter === null || adapter === t.adapterJobId) ? t : null),
        takeSlot: async (id) => {
          taken.push(id);
          return held ? null : new Date(0);
        },
        releaseSlot: async (id) => {
          released.push(id);
        },
        ask: async (tg, key, body, timeoutMs) => {
          asked.push({ target: tg, key, body, timeoutMs });
          return answer();
        },
        keyFor: (jobId, hash) => `key:${jobId}:${hash}`,
        slotWaitMs: 40,
        slotPollMs: 5,
        ...over,
      });

    beforeEach(() => {
      held = false;
      taken = [];
      released = [];
      asked = [];
      answer = async () => ({ text: "Hello", finish: "stop", usage: { input: 9, output: 2 }, ms: 1200 });
    });

    it("is null when no window serves the adapter", async () => {
      assert.equal(await backends(null)(ADAPTER), null);
      assert.equal(await backends()("00000000-0000-4000-8000-000000000000"), null);
    });

    it("asks the window's GPU for the tuned model or base Glimmer, with the derived key, Meta's sampling and the slot", async () => {
      const backend = (await backends()(ADAPTER))!;
      const tuned = await backend.chat({ messages: user("count gulls"), adapter: ADAPTER.toUpperCase() });
      assert.deepEqual(tuned, { text: "Hello", finish: "stop", usage: { input: 9, output: 2 }, ms: 1200 });
      assert.equal(asked[0]!.key, `key:${SERVE_JOB}:hash`);
      assert.deepEqual(asked[0]!.target, { ip: "203.0.113.7", port: 8443, certSha256: CERT }, "never the token hash");
      assert.deepEqual(asked[0]!.body, { model: ADAPTER, messages: user("count gulls"), max_tokens: 1024, temperature: 1, top_p: 0.95, top_k: 64, stream: false });
      assert.ok(asked[0]!.timeoutMs > 0 && asked[0]!.timeoutMs <= serve.serveTiming.chatMs);
      assert.deepEqual([taken, released], [[SERVE_JOB], [SERVE_JOB]], "one slot, given back");

      await backend.chat({ messages: user("hi"), adapter: null, maxTokens: 50, stop: ["<|eom|>", "END"] });
      assert.deepEqual([asked[1]!.body.model, asked[1]!.body.max_tokens, asked[1]!.body.stop], ["muse-glimmer", 50, ["END"]]);
      await backend.chat({ messages: user("hi"), adapter: null });
      assert.equal(asked[2]!.body.max_tokens, 4096, "base Glimmer reasons first");
      assert.equal("stop" in asked[2]!.body, false);

      // A trainChannel 1 adapter reasons first too.
      const reasoning = (await backends(target({ trainChannel: 1 }))(ADAPTER))!;
      await reasoning.chat({ messages: user("hi"), adapter: ADAPTER });
      assert.equal(asked[3]!.body.max_tokens, 4096);

      // For null, base Glimmer on any chat adapter's window; its tuned model is still that window's adapter only.
      const any = (await backends()(null))!;
      await any.chat({ messages: user("hi"), adapter: null });
      assert.equal(asked[4]!.body.model, "muse-glimmer");
    });

    it("refuses a request the GPU would refuse, before taking the slot", async () => {
      const backend = (await backends()(ADAPTER))!;
      for (const input of [
        { messages: [], adapter: null },
        { messages: user("hi"), adapter: "00000000-0000-4000-8000-000000000000" },
        { messages: user("hi"), adapter: null, maxTokens: 0 },
        { messages: user("hi"), adapter: null, stop: ["a", "b", "c", "d", "e"] },
      ]) {
        await assert.rejects(backend.chat(input as never), (e: unknown) => e instanceof serve.ServeError && e.code === "bad_prompt" && e.status === 400);
      }
      assert.deepEqual([taken, asked], [[], []]);
    });

    it("answers busy when the window's slot stays taken, and timeout when the caller stops waiting", async () => {
      const backend = (await backends()(ADAPTER))!;
      held = true;
      await assert.rejects(backend.chat({ messages: user("hi"), adapter: null }), (e: unknown) => e instanceof serve.ServeError && e.code === "busy");
      assert.ok(taken.length > 1, "it looked again before giving up");
      assert.deepEqual([released, asked], [[], []], "nothing to give back, nothing sent");

      const stop = new AbortController();
      stop.abort();
      await assert.rejects(backend.chat({ messages: user("hi"), adapter: null, signal: stop.signal }), (e: unknown) => e instanceof serve.ServeError && e.code === "timeout");
      held = false;
      taken = [];
      const late = new AbortController();
      answer = async () => {
        throw new serve.ServeError("timeout", "Muse Glimmer didn't answer in time.");
      };
      await assert.rejects(backend.chat({ messages: user("hi"), adapter: null, signal: late.signal }), (e: unknown) => e instanceof serve.ServeError && e.code === "timeout");
      assert.deepEqual(released, [SERVE_JOB], "the slot is given back after a failure too");
    });

    it("keeps the GPU's address out of every error", async () => {
      const backend = (await backends()(ADAPTER))!;
      answer = async () => {
        throw new serve.ServeError("unreachable", "The demo server's connection failed: connect ECONNREFUSED 203.0.113.7:8443");
      };
      await assert.rejects(backend.chat({ messages: user("hi"), adapter: null }), (e: unknown) => {
        assert.ok(e instanceof serve.ServeError && e.code === "unreachable");
        assert.ok(!e.message.includes("203.0.113.7") && e.message.includes("[Glimmer GPU]"), e.message);
        return true;
      });
      answer = async () => {
        throw new Error("socket hang up at 203.0.113.7");
      };
      await assert.rejects(backend.chat({ messages: user("hi"), adapter: null }), (e: unknown) => e instanceof Error && !e.message.includes("203.0.113.7"));
    });
  });

  describe("askChat over pinned HTTPS", { skip: openssl ? false : "needs openssl to make a test certificate" }, () => {
    let dir = "";
    let server: Server;
    let port = 0;
    let pin = "";
    let reply: { status: number; body: unknown } = { status: 200, body: {} };
    let seen: { path?: string; auth?: string; body?: unknown } = {};

    before(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "muse-chat-"));
      const key = path.join(dir, "key.pem");
      const cert = path.join(dir, "cert.pem");
      const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-subj", "/CN=localhost", "-keyout", key, "-out", cert]);
      assert.equal(made.status, 0, String(made.stderr));
      const pem = await readFile(cert, "utf8");
      const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
      pin = createHash("sha256").update(der).digest("hex");
      server = createServer({ key: await readFile(key), cert: pem }, (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          seen = { path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
          res.writeHead(reply.status, { "content-type": "application/json" });
          res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as AddressInfo).port;
    });

    after(async () => {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    const completion = (content: unknown, finish: unknown = "stop") => ({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: ADAPTER,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      ms: 812.4,
    });
    const ask = (body: Record<string, unknown> = { model: ADAPTER }, certSha256 = pin) => serve.askChat({ ip: "127.0.0.1", port, certSha256 }, "k".repeat(64), body, 5_000);

    it("posts the chat body to /v1/chat/completions with the key, and reads the first choice back", async () => {
      reply = { status: 200, body: completion("Hello there") };
      const body = gs.glimmerChatBody({ model: ADAPTER, messages: user("hi"), maxTokens: 1024, stop: [] });
      assert.deepEqual(await ask(body), { text: "Hello there", finish: "stop", usage: { input: 12, output: 3 }, ms: 812 });
      assert.deepEqual(seen, { path: "/v1/chat/completions", auth: `Bearer ${"k".repeat(64)}`, body });
      reply = { status: 200, body: completion("", "length") };
      assert.deepEqual((await ask()).finish, "length", "an answer cut off mid-thought is empty, finish length");
    });

    it("maps the GPU's refusals and answers that aren't a chat completion", async () => {
      const code = async () => {
        try {
          await ask();
          return "answered";
        } catch (e) {
          assert.ok(e instanceof serve.ServeError);
          return `${e.code}:${e.status ?? ""}`;
        }
      };
      for (const [status, want] of [
        [409, "busy:409"],
        [429, "busy:429"],
        [503, "stopping:503"],
        [400, "bad_prompt:400"],
        [413, "bad_prompt:413"],
        [422, "bad_prompt:422"],
        [501, "refused:501"],
        [500, "refused:500"],
      ] as const) {
        reply = { status, body: { error: "x" } };
        assert.equal(await code(), want, String(status));
      }
      for (const body of ["not json", { choices: [] }, completion(5), completion("hi", "tool_calls")]) {
        reply = { status: 200, body };
        assert.equal(await code(), "bad_answer:200", JSON.stringify(body));
      }
      reply = { status: 200, body: completion("hi") };
      await assert.rejects(ask({ model: ADAPTER }, "0".repeat(64)), (e: unknown) => e instanceof serve.ServeError && e.code === "pin_mismatch");
    });
  });

  describe("liveChatServeTarget", () => {
    const t0 = new Date("2026-11-03T18:00:00.000Z");
    const serveRow = (over: Partial<typeof realSchema.trainingJobs.$inferInsert> = {}) => ({
      recipe: "glimmer-serve",
      title: "Try tuned Glimmer live",
      status: "running",
      params: { adapterJobId: ADAPTER, minutes: 30, trainChannel: 0 },
      instanceType: "gpu_1x_a100_sxm4",
      instanceName: "mm-train-serve",
      region: "us-east-1",
      priceCentsPerHour: 129,
      maxMinutes: 45,
      maxUsd: 3.29,
      tokenHash: "token-hash",
      launchedAt: new Date(t0.getTime() - 20 * 60_000),
      serveEndpoint: { ip: "203.0.113.7", port: 8443, certSha256: CERT, startedAt: new Date(t0.getTime() - 5 * 60_000).toISOString() },
      createdAt: new Date(t0.getTime() - 20 * 60_000),
      ...over,
    });

    beforeEach(async () => {
      await testDb.delete(realSchema.trainingJobs);
      const adapter = { recipe: "glimmer-lora", title: "Bakery LoRA", status: "succeeded", instanceType: "gpu_1x_a100_sxm4", instanceName: "mm-train-lora", region: "us-east-1", priceCentsPerHour: 129, maxMinutes: 90, maxUsd: 5 };
      await testDb.insert(realSchema.trainingJobs).values([
        { ...adapter, id: ADAPTER, params: { datasetId: "dddddddd-0000-4000-8000-0000000000aa", maxSteps: 120 } },
        { ...adapter, id: DECIDER, params: { datasetId: "dddddddd-0000-4000-8000-0000000000bb", mode: "decide" } },
      ]);
    });

    it("finds a chat adapter's live window, with its adapter and trainChannel, for the adapter or for any", async () => {
      assert.equal(await store.liveChatServeTarget(ADAPTER, t0), null, "nothing serving");
      await testDb.insert(realSchema.trainingJobs).values(serveRow({ id: SERVE_JOB }));
      const want = { jobId: SERVE_JOB, tokenHash: "token-hash", ip: "203.0.113.7", port: 8443, certSha256: CERT, adapterJobId: ADAPTER, trainChannel: 0 };
      assert.deepEqual(await store.liveChatServeTarget(ADAPTER.toUpperCase(), t0), want);
      assert.deepEqual(await store.liveChatServeTarget(null, t0), want);
      assert.equal(await store.liveChatServeTarget("00000000-0000-4000-8000-000000000000", t0), null);
      assert.equal(await store.liveChatServeTarget("not-a-uuid", t0), null);
      // Past its minutes it isn't live.
      assert.equal(await store.liveChatServeTarget(ADAPTER, new Date(t0.getTime() + 60 * 60_000)), null);
    });

    it("never counts a decision model's window, a stopping one, one still starting, or one without a usable endpoint", async () => {
      await testDb.insert(realSchema.trainingJobs).values([
        serveRow({ params: { adapterJobId: DECIDER, minutes: 30, trainChannel: 0 } }),
        serveRow({ stopRequested: true }),
        serveRow({ status: "booting" }),
        serveRow({ serveEndpoint: { ip: null, port: 8443, certSha256: CERT, startedAt: t0.toISOString() } }),
        serveRow({ tokenHash: null }),
      ]);
      assert.equal(await store.liveChatServeTarget(null, t0), null);
      assert.equal(await store.liveChatServeTarget(DECIDER, t0), null);
      assert.equal(await store.liveChatServeTarget(ADAPTER, t0), null);
      // A trainChannel 1 serve job says so, and serveJobChatBackend wires it to a backend.
      await testDb.insert(realSchema.trainingJobs).values(serveRow({ id: SERVE_JOB, params: { adapterJobId: ADAPTER, minutes: 30, trainChannel: 1 } }));
      assert.equal((await store.liveChatServeTarget(ADAPTER, t0))?.trainChannel, 1);
      assert.ok(await gs.serveJobChatBackend(ADAPTER, t0));
      assert.equal(await gs.serveJobChatBackend(DECIDER, t0), null);
    });
  });
});
