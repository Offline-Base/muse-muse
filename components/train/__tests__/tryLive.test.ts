/**
 * The live demo's browser calls (components/train/tryLive.ts) against a faked fetch: what Try it live sends to
 * POST /api/lab/{id}/try and how it reads each reply, and what Start a live demo sends to POST /api/train/jobs. The
 * last suite runs Try it live against the real proxy route, with its store, rate limits and GPU call faked, so the
 * box and the route agree on the body and every error code. Nothing reaches the network or Neon.
 *
 *   npx tsx --test --experimental-test-module-mocks components/train/__tests__/tryLive.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { askLiveDemo, startLiveDemo, type Fetch } from "@/components/train/tryLive";

const canMock = typeof (mock as { module?: unknown }).module === "function";

const ADAPTER = "8f1d2c3b-0000-4000-8000-000000000001";
const SERVE = "5e7e5e7e-0000-4000-8000-00000000000a";
const LIMITS = { maxActive: 1, dailyUsd: 20 };

/** A fetch that records each call and answers with `status` and `body`. */
function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: Fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

describe("Try it live: askLiveDemo", () => {
  it("posts the trimmed idea to the adapter's try route and returns both answers", async () => {
    const f = fakeFetch(200, { base: "I can't see a photo.", tuned: "Product: Chalkboard Menu", ms: 41_200 });
    const r = await askLiveDemo(ADAPTER, "  A bakery menu board  \n", { fetch: f.fetch });
    assert.deepEqual(r, { ok: true, answer: { base: "I can't see a photo.", tuned: "Product: Chalkboard Menu", ms: 41_200 } });
    assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0];
    assert.equal(url, `/api/lab/${ADAPTER}/try`, "same origin, so the route's cross-site check passes");
    assert.equal(init.method, "POST");
    assert.deepEqual(init.headers, { "content-type": "application/json" });
    assert.equal(init.body, JSON.stringify({ prompt: "A bakery menu board" }));
    assert.equal(init.cache, "no-store");
    assert.ok(init.signal instanceof AbortSignal);
  });

  it("sends nothing for a blank idea", async () => {
    const f = fakeFetch(200, {});
    assert.deepEqual(await askLiveDemo(ADAPTER, "   ", { fetch: f.fetch }), { ok: false, message: "Type an app idea first.", ended: false });
    assert.equal(f.calls.length, 0);
  });

  it("turns each refusal into its sentence, and closes the box only when the demo ended", async () => {
    const cases: Array<[number, unknown, RegExp, boolean]> = [
      [404, { error: "no_live_demo" }, /has ended/, true],
      [409, { error: "busy" }, /someone else's idea/, false],
      [429, { error: "rate_limited", scope: "ip", retryAfterSeconds: 120 }, /Try again in 2 minutes\.$/, false],
      [429, { error: "rate_limited", scope: "demo", retryAfterSeconds: 1800 }, /this hour\. Try again in 30 minutes\.$/, false],
      [504, { error: "timeout" }, /within 2 minutes/, false],
      [502, { error: "demo_unavailable" }, /Couldn't reach the live demo's GPU/, false],
      [403, { error: "cross_site" }, /on Muse Muse itself/, false],
      [400, { error: "Keep the idea to 600 characters.", max: 600 }, /^Keep the idea to 600 characters\.$/, false],
      [500, "<html>oops</html>", /couldn't answer\. Try again in a moment\./, false],
    ];
    for (const [status, body, text, ended] of cases) {
      const r = await askLiveDemo(ADAPTER, "idea", { fetch: fakeFetch(status, body).fetch });
      assert.equal(r.ok, false, `${status}`);
      if (r.ok) continue;
      assert.match(r.message, text, `${status} ${JSON.stringify(body)}`);
      assert.equal(r.ended, ended, `${status} ended`);
    }
  });

  it("says so when the answer isn't both texts", async () => {
    const r = await askLiveDemo(ADAPTER, "idea", { fetch: fakeFetch(200, { base: "only one" }).fetch });
    assert.deepEqual(r, { ok: false, message: "The live demo's answer didn't come back whole. Try again.", ended: false });
  });

  it("gives up after its wait and calls it a timeout", async () => {
    const hang: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const started = Date.now();
    const r = await askLiveDemo(ADAPTER, "idea", { fetch: hang, waitMs: 30 });
    assert.ok(Date.now() - started < 2_000);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /within 2 minutes/);
  });

  it("says Muse Muse couldn't be reached when the request fails", async () => {
    const down: Fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    assert.deepEqual(await askLiveDemo(ADAPTER, "idea", { fetch: down }), {
      ok: false,
      message: "Couldn't reach Muse Muse. Check your connection and try again.",
      ended: false,
    });
  });
});

describe("Start a live demo: startLiveDemo", () => {
  const demo = { adapterJobId: ADAPTER, adapterTitle: "Brief writer", minutes: 30 };

  it("posts a glimmer-serve job for the adapter with its minutes and no limits, so the route sizes them", async () => {
    const f = fakeFetch(201, { job: { id: SERVE, recipe: "glimmer-serve" } });
    assert.deepEqual(await startLiveDemo(demo, LIMITS, { fetch: f.fetch }), { ok: true, jobId: SERVE });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, "/api/train/jobs");
    assert.equal(f.calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), {
      recipe: "glimmer-serve",
      title: "Live demo: Brief writer",
      params: { adapterJobId: ADAPTER, minutes: 30 },
    });
  });

  it("keeps the title within the route's 200 characters", async () => {
    const f = fakeFetch(201, { job: { id: SERVE } });
    await startLiveDemo({ ...demo, adapterTitle: "x".repeat(300) }, LIMITS, { fetch: f.fetch });
    assert.equal(JSON.parse(String(f.calls[0].init.body)).title.length, 200);
  });

  it("starts even when the new job's link doesn't come back", async () => {
    assert.deepEqual(await startLiveDemo(demo, LIMITS, { fetch: fakeFetch(201, { job: { id: "nope" } }).fetch }), { ok: true, jobId: null });
  });

  it("says why the route refused, and when a demo of this adapter is already open", async () => {
    const running = await startLiveDemo(demo, LIMITS, { fetch: fakeFetch(409, { error: "demo_running", serveJobId: SERVE }).fetch });
    assert.deepEqual(running, {
      ok: false,
      message: "A live demo of this adapter is already starting or running, so another one wasn't started.",
      running: true,
    });
    const busy = await startLiveDemo(demo, LIMITS, { fetch: fakeFetch(409, { error: "too_many_active", max: 1 }).fetch });
    assert.equal(busy.ok, false);
    if (!busy.ok) {
      assert.match(busy.message, /only 1 job can hold one at a time/);
      assert.equal(busy.running, false);
    }
    const full = await startLiveDemo(demo, LIMITS, {
      fetch: fakeFetch(503, { error: "no_capacity", options: [], region: "us-east-1" }).fetch,
    });
    if (!full.ok) assert.match(full.message, /no free GPU for this in us-east-1/);
    const fit = await startLiveDemo(demo, LIMITS, {
      fetch: fakeFetch(400, { error: "A 60-minute live demo needs about 75 minutes of GPU time.", estimateMinutes: 75, usableMinutes: 69 }).fetch,
    });
    if (!fit.ok) assert.equal(fit.message, "A 60-minute live demo needs about 75 minutes of GPU time.");
  });

  it("says Muse Muse couldn't be reached when the request fails", async () => {
    const down: Fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    assert.deepEqual(await startLiveDemo(demo, LIMITS, { fetch: down }), {
      ok: false,
      message: "Couldn't reach Muse Muse. Check your connection and try again.",
      running: false,
    });
  });
});

describe("Try it live against the real proxy route", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  type Ctx = { params: Promise<{ id: string }> };
  let route: (req: Request, ctx: Ctx) => Promise<Response>;
  let target: Record<string, unknown> | null;
  let slotFree: boolean;
  let hits: Record<string, number>;
  let gpu: (prompt: string) => Promise<{ base: string; tuned: string; ms: number }>;
  const prompts: string[] = [];

  /** The proxy's own error type, as the faked lib/train/serve.ts exports it. */
  class ServeError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }

  before(async () => {
    const at = (rel: string) => new URL(rel, import.meta.url).href;
    mock.module(at("../../../lib/train/store.ts"), {
      namedExports: {
        // The adapter is judged, so its demo is public and the route never asks who is signed in.
        getResultJob: async (id: string) => (id === ADAPTER ? { id } : null),
        liveServeTarget: async (id: string) => (id === ADAPTER ? target : null),
        takeDemoSlot: async () => (slotFree ? new Date("2026-10-27T12:00:00.000Z") : null),
        releaseDemoSlot: async () => {},
      },
    });
    mock.module(at("../../../lib/gateway/store.ts"), {
      namedExports: {
        hitRateLimits: async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, (hits[k] = (hits[k] ?? 0) + 1)])),
      },
    });
    mock.module(at("../../../lib/train/serve.ts"), {
      namedExports: {
        ServeError,
        serveKeyFor: () => "derived-serve-key",
        serveTiming: { connectMs: 10, answerMs: 50 },
        askLive: async (_target: unknown, _key: string, prompt: string) => {
          prompts.push(prompt);
          return gpu(prompt);
        },
      },
    });
    ({ POST: route } = await import(at("../../../app/api/lab/[id]/try/route.ts")));
  });

  after(() => mock.restoreAll());

  beforeEach(() => {
    target = { jobId: SERVE, tokenHash: "hash", ip: "203.0.113.9", port: 8443, certSha256: "c3".repeat(32) };
    slotFree = true;
    hits = {};
    prompts.length = 0;
    gpu = async () => ({ base: "A base answer.", tuned: "A tuned brief.", ms: 1234 });
  });

  /** The browser's same-origin fetch, handed straight to the route. */
  const viaRoute: Fetch = async (url, init) => {
    const req = new Request(new URL(url, "https://muse.example.com"), {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), "sec-fetch-site": "same-origin", "x-real-ip": "198.51.100.1" },
    });
    const id = /^\/api\/lab\/([^/]+)\/try$/.exec(new URL(req.url).pathname)?.[1] ?? "";
    return route(req, { params: Promise.resolve({ id }) });
  };

  it("gets both answers through the route", async () => {
    const r = await askLiveDemo(ADAPTER, "  A habit tracker for night owls ", { fetch: viaRoute });
    assert.deepEqual(r, { ok: true, answer: { base: "A base answer.", tuned: "A tuned brief.", ms: 1234 } });
    assert.deepEqual(prompts, ["A habit tracker for night owls"]);
  });

  it("reads each of the route's refusals as its own sentence", async () => {
    target = null;
    const none = await askLiveDemo(ADAPTER, "idea", { fetch: viaRoute });
    assert.equal(none.ok, false);
    if (!none.ok) {
      assert.match(none.message, /has ended/);
      assert.equal(none.ended, true);
    }
    target = { jobId: SERVE, tokenHash: "hash", ip: "203.0.113.9", port: 8443, certSha256: "c3".repeat(32) };

    slotFree = false;
    const busy = await askLiveDemo(ADAPTER, "idea", { fetch: viaRoute });
    if (!busy.ok) assert.match(busy.message, /someone else's idea/);
    slotFree = true;

    for (const [code, text] of [
      ["timeout", /within 2 minutes/],
      ["busy", /someone else's idea/],
      ["pin_mismatch", /Couldn't reach the live demo's GPU/],
      ["unreachable", /Couldn't reach the live demo's GPU/],
      ["bad_prompt", /couldn't take that idea/],
    ] as const) {
      hits = {};
      gpu = async () => {
        throw new ServeError(code, `GPU at 203.0.113.9 said ${code}`);
      };
      const errors = mock.method(console, "error", () => {});
      try {
        const r = await askLiveDemo(ADAPTER, "idea", { fetch: viaRoute });
        assert.equal(r.ok, false, code);
        if (!r.ok) {
          assert.match(r.message, text, code);
          assert.doesNotMatch(r.message, /203\.0\.113\.9|8443|c3c3/, "nothing about the GPU");
        }
      } finally {
        errors.mock.restore();
      }
    }
  });

  it("says when the per-connection limit is reached, with how long to wait", async () => {
    let last: Awaited<ReturnType<typeof askLiveDemo>> | null = null;
    for (let i = 0; i < 6; i++) last = await askLiveDemo(ADAPTER, `idea ${i}`, { fetch: viaRoute });
    assert.equal(prompts.length, 5, "five ideas reach the GPU");
    assert.ok(last && !last.ok);
    if (last && !last.ok) assert.match(last.message, /^That's as many ideas as the demo takes from you for now\. Try again in \d+ minutes?\.$/);
  });

  it("shows the route's own sentence for an idea that is too long", async () => {
    const r = await askLiveDemo(ADAPTER, "x".repeat(601), { fetch: viaRoute });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.message, "Keep the idea to 600 characters.");
    assert.equal(prompts.length, 0);
  });
});
