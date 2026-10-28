/**
 * The live demo proxy against a local HTTPS server standing in for a glimmer-serve job's demo server, with self-signed
 * certificates made here with openssl. lib/train/serve.ts: the right certificate fingerprint is accepted, a different
 * one is refused before a single byte (the serving key included) is sent, the key is the HMAC of the job's token hash,
 * and busy, refused, bad and slow answers come back as their codes. POST /api/lab/{id}/try, with the store, the rate
 * limits and requireUser faked: only same-origin, the prompt checked, an unjudged adapter's demo only for admins, no
 * live demo, 5 prompts per IP in 10 minutes, 60 an hour per demo, one at a time (the slot always given back), and
 * nothing about the GPU (its IP, the key, the certificate) in any reply. Nothing here calls Lambda, Neon or a GPU.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/lab-try.test.ts
 *
 * Without openssl this file skips; without the flag the route's suite skips.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";

const SERVE_JOB = "bbbbbbbb-0000-4000-8000-000000000000";
const ADAPTER = "aaaaaaaa-0000-4000-8000-000000000000";
const TOKEN_HASH = "stored-token-hash-of-the-serve-job";
const PEPPER = "test-pepper-for-lab-try";
const savedPepper = process.env.GATEWAY_TOKEN_PEPPER;

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

interface Pem {
  key: string;
  cert: string;
  /** The SHA-256 fingerprint, as the platform stores it: 64 lowercase hex characters. */
  sha256: string;
}

/** A fresh self-signed P-256 certificate, as the demo server makes one at start. */
function selfSigned(dir: string, name: string): Pem {
  const keyPath = join(dir, `${name}.key`);
  const certPath = join(dir, `${name}.crt`);
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", `/CN=${name}`],
    { stdio: "ignore" },
  );
  const cert = readFileSync(certPath, "utf8");
  return { key: readFileSync(keyPath, "utf8"), cert, sha256: new X509Certificate(cert).fingerprint256.replace(/:/g, "").toLowerCase() };
}

interface Seen {
  method: string;
  url: string;
  auth: string | null;
  body: string;
}

/** How the fake demo server answers the next requests. */
let answer: (seen: Seen) => { status: number; body: unknown; delayMs?: number } = () => ({
  status: 200,
  body: { base: "A base answer.", tuned: "A tuned brief.", ms: 1234 },
});
let seen: Seen[] = [];
/** TCP connections the fake servers took: a pinned client that refuses the certificate still connects first. */
let connections = 0;

/** A demo server on 127.0.0.1 with this certificate, standing in for the GPU. */
async function demoServer(pem: Pem): Promise<{ server: Server; port: number }> {
  const server = createServer({ key: pem.key, cert: pem.cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const one: Seen = { method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization ?? null, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(one);
      const { status, body, delayMs } = answer(one);
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      };
      if (delayMs) setTimeout(send, delayMs).unref();
      else send();
    });
  });
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

const openssl = hasOpenssl();
const canMock = typeof (mock as { module?: unknown }).module === "function";
let dir = "";
let certA: Pem;
let certB: Pem;
let serverA: { server: Server; port: number };
let serve: typeof import("../serve");

describe("live demo proxy", { skip: openssl ? false : "needs openssl to make test certificates" }, () => {
  before(async () => {
    process.env.GATEWAY_TOKEN_PEPPER = PEPPER;
    dir = mkdtempSync(join(tmpdir(), "muse-lab-try-"));
    certA = selfSigned(dir, "demo-a");
    certB = selfSigned(dir, "demo-b");
    assert.notEqual(certA.sha256, certB.sha256);
    serverA = await demoServer(certA);
    serve = await import("../serve");
  });

  after(async () => {
    await closeServer(serverA?.server);
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (savedPepper === undefined) delete process.env.GATEWAY_TOKEN_PEPPER;
    else process.env.GATEWAY_TOKEN_PEPPER = savedPepper;
  });

  beforeEach(() => {
    seen = [];
    connections = 0;
    answer = () => ({ status: 200, body: { base: "A base answer.", tuned: "A tuned brief.", ms: 1234 } });
    serve.serveTiming.connectMs = 10_000;
    serve.serveTiming.answerMs = 120_000;
  });

  const target = (over: Partial<{ ip: string; port: number; certSha256: string }> = {}) => ({
    ip: "127.0.0.1",
    port: serverA.port,
    certSha256: certA.sha256,
    ...over,
  });
  const KEY = "k".repeat(64);

  describe("pinned HTTPS (lib/train/serve.ts)", () => {
    it("derives the serving key as the HMAC of serve:<job id>:<token hash> with the pepper", async () => {
      const { createHmac } = await import("node:crypto");
      const expected = createHmac("sha256", PEPPER).update(`serve:${SERVE_JOB}:${TOKEN_HASH}`).digest("hex");
      assert.equal(serve.serveKeyFor(SERVE_JOB, TOKEN_HASH), expected);
      assert.notEqual(serve.serveKeyFor(SERVE_JOB, "another-hash"), expected, "a new token means a new key");
      assert.notEqual(serve.serveKeyFor(ADAPTER, TOKEN_HASH), expected, "and so does another job");
    });

    it("accepts the self-signed certificate whose fingerprint was pinned, and sends the key and the prompt", async () => {
      const got = await serve.askLive(target(), KEY, "A recipe app for picky kids", 5_000);
      assert.deepEqual(got, { base: "A base answer.", tuned: "A tuned brief.", ms: 1234 });
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0], { method: "POST", url: "/generate", auth: `Bearer ${KEY}`, body: JSON.stringify({ prompt: "A recipe app for picky kids" }) });
      // The colon-separated uppercase form pins the same certificate.
      const colons = certA.sha256.toUpperCase().match(/../g)!.join(":");
      assert.equal((await serve.askLive(target({ certSha256: colons }), KEY, "Again", 5_000)).tuned, "A tuned brief.");
    });

    it("refuses a different certificate after the handshake, before anything (the key included) is sent", async () => {
      await assert.rejects(serve.askLive(target({ certSha256: certB.sha256 }), KEY, "Leak the key?", 5_000), (err: Error) => {
        assert.ok(err instanceof serve.ServeError);
        assert.equal(err.code, "pin_mismatch");
        assert.ok(!err.message.includes(certA.sha256) && !err.message.includes(KEY));
        return true;
      });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(connections, 1, "it connected, and the refusal came from the certificate it was shown");
      assert.equal(seen.length, 0, "no request reached the server");

      // A server with another certificate on the pinned address: the same refusal.
      const serverB = await demoServer(certB);
      try {
        await assert.rejects(serve.askLive(target({ port: serverB.port }), KEY, "Leak the key?", 5_000), { code: "pin_mismatch" });
        assert.equal(seen.length, 0);
      } finally {
        await closeServer(serverB.server);
      }
      await assert.rejects(serve.askLive(target({ certSha256: "not-a-fingerprint" }), KEY, "x", 5_000), { code: "pin_mismatch" });
      assert.equal(connections, 2, "nothing to pin means no connection at all");
    });

    it("maps busy, refused and malformed answers, and cuts long ones", async () => {
      for (const status of [409, 429]) {
        answer = () => ({ status, body: { error: "busy" } });
        await assert.rejects(serve.askLive(target(), KEY, "x", 5_000), { code: "busy" });
      }
      // The GPU's server answers 503 only once its minutes are up.
      answer = () => ({ status: 503, body: { error: "stopping" } });
      await assert.rejects(serve.askLive(target(), KEY, "x", 5_000), { code: "stopping" });
      answer = () => ({ status: 400, body: { error: "prompt_too_long" } });
      await assert.rejects(serve.askLive(target(), KEY, "x", 5_000), { code: "bad_prompt" });
      answer = () => ({ status: 401, body: { error: "unauthorized" } });
      await assert.rejects(serve.askLive(target(), KEY, "x", 5_000), { code: "refused" });
      answer = () => ({ status: 200, body: "<html>not json</html>" });
      await assert.rejects(serve.askLive(target(), KEY, "x", 5_000), { code: "bad_answer" });
      answer = () => ({ status: 200, body: { base: 1, tuned: "t" } });
      await assert.rejects(serve.askLive(target(), KEY, "x", 5_000), { code: "bad_answer" });
      answer = () => ({ status: 200, body: { base: "b".repeat(300_000), tuned: "t", ms: 1 } });
      await assert.rejects(serve.askLive(target(), KEY, "x", 5_000), { code: "bad_answer" }, "more than the proxy reads");

      answer = () => ({ status: 200, body: { base: "b".repeat(9000), tuned: "t", ms: -4 } });
      const cut = await serve.askLive(target(), KEY, "x", 5_000);
      assert.equal(cut.base.length, serve.ANSWER_TEXT_MAX);
      assert.equal(cut.ms, 0);
    });

    it("gives up after its timeout, and calls a closed port unreachable", async () => {
      answer = () => ({ status: 200, body: { base: "late", tuned: "late", ms: 1 }, delayMs: 2_000 });
      const started = Date.now();
      await assert.rejects(serve.askLive(target(), KEY, "x", 200), { code: "timeout" });
      assert.ok(Date.now() - started < 1_500);

      const closed = await demoServer(certA);
      const port = closed.port;
      await closeServer(closed.server);
      await assert.rejects(serve.askLive(target({ port }), KEY, "x", 5_000), { code: "unreachable" });
      await assert.rejects(serve.askLive(target({ ip: "demo.example.com" }), KEY, "x", 5_000), { code: "unreachable" }, "only an IP");
    });
  });

  describe("POST /api/lab/{id}/try", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
    type Ctx = { params: Promise<{ id: string }> };
    let tryRoute: (req: Request, ctx: Ctx) => Promise<Response>;
    let calls: Array<{ fn: string; args: unknown[] }> = [];
    let live: Record<string, unknown> | null = null;
    /** Adapter jobs with a public result page (judged), for getResultJob. */
    let judged = new Set<string>();
    /** Who requireUser says is asking: null when nobody is signed in, an Error when it can't tell. */
    let viewer: { id: string; email: string; isAdmin: boolean } | Error | null = null;
    let slotFree = true;
    let hits: Record<string, number> = {};
    const called = (fn: string) => calls.filter((c) => c.fn === fn);
    const ctx = (id = ADAPTER): Ctx => ({ params: Promise.resolve({ id }) });

    before(async () => {
      const at = (rel: string) => new URL(rel, import.meta.url).href;
      // lib/auth as it is (the same-origin check included), with a requireUser the test sets.
      const realAuth = (await import(at("../../auth.ts"))) as typeof import("../../auth");
      mock.module(at("../../auth.ts"), {
        namedExports: {
          ...realAuth,
          requireUser: async () => {
            calls.push({ fn: "requireUser", args: [] });
            if (viewer instanceof Error) throw viewer;
            if (!viewer) throw new Error("Sign in to build.");
            return viewer;
          },
        },
      });
      mock.module(at("../store.ts"), {
        namedExports: {
          getResultJob: async (id: string) => {
            calls.push({ fn: "getResultJob", args: [id] });
            return judged.has(id) ? { id } : null;
          },
          liveServeTarget: async (id: string) => {
            calls.push({ fn: "liveServeTarget", args: [id] });
            return id === ADAPTER ? live : null;
          },
          takeDemoSlot: async (id: string) => {
            calls.push({ fn: "takeDemoSlot", args: [id] });
            return slotFree ? new Date("2026-10-27T12:00:00.000Z") : null;
          },
          releaseDemoSlot: async (...args: unknown[]) => void calls.push({ fn: "releaseDemoSlot", args }),
        },
      });
      mock.module(at("../../gateway/store.ts"), {
        namedExports: {
          hitRateLimits: async (keys: string[], windowStart: Date) => {
            calls.push({ fn: "hitRateLimits", args: [keys, windowStart] });
            return Object.fromEntries(keys.map((k) => [k, (hits[k] = (hits[k] ?? 0) + 1)]));
          },
        },
      });
      ({ POST: tryRoute } = await import(at("../../../app/api/lab/[id]/try/route.ts")));
    });

    after(() => mock.restoreAll());

    beforeEach(() => {
      calls = [];
      hits = {};
      judged = new Set([ADAPTER]);
      viewer = null;
      slotFree = true;
      live = { jobId: SERVE_JOB, tokenHash: TOKEN_HASH, ip: "127.0.0.1", port: serverA.port, certSha256: certA.sha256 };
    });

    function tryReq(body: unknown, headers: Record<string, string> = {}): Request {
      return new Request(`https://muse.example.com/api/lab/${ADAPTER}/try`, {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-real-ip": "198.51.100.1", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    }

    /** True when a reply says nothing about the GPU: its address, port, certificate or key. */
    function saysNothingAboutTheGpu(text: string): boolean {
      const key = serve.serveKeyFor(SERVE_JOB, TOKEN_HASH);
      return [certA.sha256, certB.sha256, key, TOKEN_HASH, "127.0.0.1", String(serverA.port)].every((s) => !text.includes(s));
    }

    it("answers with both models from the GPU, sending it the key derived from the job's token hash", async () => {
      const res = await tryRoute(tryReq({ prompt: "  A habit tracker for night owls  " }), ctx());
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const text = await res.text();
      assert.deepEqual(JSON.parse(text), { base: "A base answer.", tuned: "A tuned brief.", ms: 1234 });
      assert.ok(saysNothingAboutTheGpu(text));
      assert.deepEqual(seen.map((s) => [s.auth, s.body]), [[`Bearer ${serve.serveKeyFor(SERVE_JOB, TOKEN_HASH)}`, JSON.stringify({ prompt: "A habit tracker for night owls" })]]);
      assert.deepEqual(called("liveServeTarget")[0]!.args, [ADAPTER]);
      assert.deepEqual(called("releaseDemoSlot").map((c) => c.args[0]), [SERVE_JOB], "the slot is given back");
    });

    it("refuses another site's request, a bad id and a bad prompt before looking for a demo", async () => {
      const cross = await tryRoute(tryReq({ prompt: "x" }, { "sec-fetch-site": "cross-site" }), ctx());
      assert.equal(cross.status, 403);
      assert.deepEqual(await cross.json(), { error: "cross_site" });
      assert.equal((await tryRoute(tryReq({ prompt: "x" }, { "sec-fetch-site": "same-site" }), ctx())).status, 403);
      assert.equal((await tryRoute(tryReq({ prompt: "x" }), ctx("not-a-job"))).status, 404);
      for (const body of [{}, { prompt: "   " }, { prompt: 42 }, { prompt: "x".repeat(601) }, "not json"]) {
        assert.equal((await tryRoute(tryReq(body), ctx())).status, 400, JSON.stringify(body));
      }
      const long = await tryRoute(tryReq({ prompt: "x".repeat(601) }), ctx());
      assert.deepEqual(await long.json(), { error: "Keep the idea to 600 characters.", max: 600 });
      assert.equal(called("liveServeTarget").length + called("getResultJob").length + seen.length, 0);
      assert.equal((await tryRoute(tryReq({ prompt: "é".repeat(600) }), ctx())).status, 200, "600 characters is fine");
    });

    it("keeps the demo of an adapter that isn't judged to admins: anyone else gets no_live_demo, before any rate limit", async () => {
      judged = new Set();
      for (const who of [null, { id: "u-1", email: "guest@example.com", isAdmin: false }, new Error("The database is down.")]) {
        viewer = who;
        const res = await tryRoute(tryReq({ prompt: "A bakery site" }), ctx());
        assert.equal(res.status, 404, String(who));
        assert.deepEqual(await res.json(), { error: "no_live_demo" }, "the same reply as no demo at all");
      }
      assert.equal(called("liveServeTarget").length + called("hitRateLimits").length + called("takeDemoSlot").length + seen.length, 0);
      assert.deepEqual(called("getResultJob").map((c) => c.args[0]), [ADAPTER, ADAPTER, ADAPTER]);

      // An admin (requireUser confirms the flag against the database) tries it from the job's admin page.
      viewer = { id: "admin-1", email: "admin@example.com", isAdmin: true };
      const res = await tryRoute(tryReq({ prompt: "A bakery site" }), ctx(ADAPTER.toUpperCase()));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { base: "A base answer.", tuned: "A tuned brief.", ms: 1234 });
      assert.equal(seen.length, 1);

      // A judged adapter's demo is public: nobody is asked who they are.
      judged = new Set([ADAPTER]);
      viewer = null;
      calls = [];
      assert.equal((await tryRoute(tryReq({ prompt: "A bakery site" }, { "x-real-ip": "203.0.113.7" }), ctx())).status, 200);
      assert.equal(called("requireUser").length, 0);
    });

    it("answers no_live_demo when nothing serves that adapter", async () => {
      live = null;
      const res = await tryRoute(tryReq({ prompt: "A bakery site" }), ctx());
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "no_live_demo" });
      assert.equal(called("takeDemoSlot").length + called("hitRateLimits").length, 0);
    });

    it("lets one IP send 5 prompts in 10 minutes, and others still get theirs", async () => {
      for (let i = 0; i < 5; i++) assert.equal((await tryRoute(tryReq({ prompt: `Idea ${i}` }), ctx())).status, 200);
      const over = await tryRoute(tryReq({ prompt: "One more" }), ctx());
      assert.equal(over.status, 429);
      const body = (await over.json()) as { error: string; scope: string; retryAfterSeconds: number };
      assert.deepEqual([body.error, body.scope], ["rate_limited", "ip"]);
      assert.ok(body.retryAfterSeconds >= 1 && body.retryAfterSeconds <= 600);
      assert.equal(seen.length, 5, "the sixth never reached the GPU");
      const window = called("hitRateLimits")[0]!.args[1] as Date;
      assert.equal(window.getTime() % (10 * 60_000), 0, "a fixed 10-minute window");

      assert.equal((await tryRoute(tryReq({ prompt: "Mine" }, { "x-real-ip": "203.0.113.50" }), ctx())).status, 200);
    });

    it("lets a demo answer 60 prompts an hour from everyone together, giving the slot back when it refuses", async () => {
      for (let i = 0; i < 60; i++) {
        const res = await tryRoute(tryReq({ prompt: `Idea ${i}` }, { "x-real-ip": `198.51.100.${(i % 200) + 1}` }), ctx());
        assert.equal(res.status, 200, `prompt ${i}`);
      }
      calls = [];
      const over = await tryRoute(tryReq({ prompt: "Too many" }, { "x-real-ip": "203.0.113.99" }), ctx());
      assert.equal(over.status, 429);
      assert.equal(((await over.json()) as { scope: string }).scope, "demo");
      assert.equal(seen.length, 60);
      assert.equal(called("releaseDemoSlot").length, 1);
      const demoWindow = called("hitRateLimits")[1]!.args[1] as Date;
      assert.equal(demoWindow.getTime() % 3_600_000, 0, "a clock hour");
    });

    it("answers busy while another prompt holds the demo, or when the GPU says so", async () => {
      slotFree = false;
      const held = await tryRoute(tryReq({ prompt: "Wait your turn" }), ctx());
      assert.equal(held.status, 409);
      assert.deepEqual(await held.json(), { error: "busy" });
      assert.equal(seen.length, 0);
      assert.equal(called("releaseDemoSlot").length, 0, "it never had the slot");

      slotFree = true;
      answer = () => ({ status: 409, body: { error: "busy" } });
      const gpu = await tryRoute(tryReq({ prompt: "Now?" }), ctx());
      assert.equal(gpu.status, 409);
      assert.equal(called("releaseDemoSlot").length, 1);
    });

    it("answers no_live_demo when the GPU says its minutes are up", async () => {
      answer = () => ({ status: 503, body: { error: "stopping" } });
      const res = await tryRoute(tryReq({ prompt: "Just in time?" }), ctx());
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "no_live_demo" });
      assert.equal(called("releaseDemoSlot").length, 1);
    });

    it("answers demo_unavailable, saying nothing about the GPU, when its certificate isn't the pinned one", async () => {
      live = { ...live!, certSha256: certB.sha256 };
      const res = await tryRoute(tryReq({ prompt: "Is this the real GPU?" }), ctx());
      assert.equal(res.status, 502);
      const text = await res.text();
      assert.deepEqual(JSON.parse(text), { error: "demo_unavailable" });
      assert.ok(saysNothingAboutTheGpu(text));
      assert.equal(seen.length, 0, "the key never left");
      assert.equal(called("releaseDemoSlot").length, 1);
    });

    it("answers timeout when the GPU takes too long, and passes a refused prompt back as a sentence", async () => {
      serve.serveTiming.answerMs = 200;
      answer = () => ({ status: 200, body: { base: "late", tuned: "late", ms: 1 }, delayMs: 2_000 });
      const slow = await tryRoute(tryReq({ prompt: "Slow one" }), ctx());
      assert.equal(slow.status, 504);
      assert.deepEqual(await slow.json(), { error: "timeout" });
      assert.equal(called("releaseDemoSlot").length, 1);

      serve.serveTiming.answerMs = 120_000;
      answer = () => ({ status: 400, body: { error: "prompt_too_long" } });
      const refused = await tryRoute(tryReq({ prompt: "Fine here" }), ctx());
      assert.equal(refused.status, 400);
      assert.match(((await refused.json()) as { error: string }).error, /couldn't take that idea/);
    });
  });
});
