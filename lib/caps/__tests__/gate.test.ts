/**
 * The cap gate (docs/CAPABILITIES.md, 2.4) and who is asking (2.2): the checks run in CAP_CHECKS order, each refusal
 * stops the call before anything after it is touched, and every claim a caller makes is checked by its signature.
 *
 *   npx tsx --test lib/caps/__tests__/gate.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mintTestUserSession, mintUserSession } from "@/lib/caps/data/identity";
import { CAP_CHECKS, capError, privateUrl, readJsonBody, runCapGate, unknownKeys, type CapGateDeps, type CapProduct, type CapRoute, type CapToken } from "@/lib/caps/gate";
import { BUILD_TEST_OWNER, resolveCapCaller, subjectKey } from "@/lib/caps/principal";
import { mintOwnerSession } from "@/lib/tools/principal";

process.env.GATEWAY_TOKEN_PEPPER ??= "test-pepper-for-the-cap-gate";

const NOW = new Date("2026-11-01T12:00:00Z");
const BUILD = "11111111-1111-4111-8111-111111111111";

function token(over: Partial<CapToken> = {}): CapToken {
  return { id: "tok-1", productId: "p1", scope: "live", allowedModels: ["muse-wonder-1.0", "cap:data"], dailyBudgetUsd: 3, buildId: null, ...over };
}

function product(over: Partial<CapProduct> = {}): CapProduct {
  return { status: "live", manifest: null, liveUrl: "https://p1.example", takenDownAt: null, ownerId: "u1", ownerEmail: "maker@example.com", ownerIsAdmin: false, ownerBannedAt: null, ...over };
}

/** A route that records which checks it reached, so a refusal can be shown to stop the rest. */
function harness(over: { token?: CapToken | null; product?: CapProduct | null; served?: string[]; deps?: Partial<CapGateDeps>; route?: Partial<CapRoute<{ n: number }>> } = {}) {
  const reached: string[] = [];
  const touched: string[] = [];
  const deps: CapGateDeps = {
    servedCaps: () => (over.served ?? ["data"]) as CapGateDeps extends { servedCaps(): infer R } ? R : never,
    findToken: async () => {
      touched.push("findToken");
      return over.token === undefined ? token() : over.token;
    },
    product: async () => {
      touched.push("product");
      return over.product === undefined ? product() : over.product;
    },
    adminEmails: [],
    hitRateLimits: async (keys) => {
      touched.push("hitRateLimits");
      return Object.fromEntries(keys.map((k) => [k, 1]));
    },
    now: () => NOW,
    ...over.deps,
  };
  const route: CapRoute<{ n: number }> = {
    cap: "data",
    what: "/data",
    allow: () => {
      reached.push("principal");
      return null;
    },
    async args() {
      reached.push("arguments");
      return { n: 1 };
    },
    limits: ({ token: t }) => {
      reached.push("rate");
      return [{ key: `t:${t.id}`, limit: 5, window: "minute", who: "this product" }];
    },
    async quota() {
      reached.push("quota");
      return null;
    },
    async work(ctx) {
      reached.push(`work:${ctx.namespace}`);
      return Response.json({ ok: true, caller: ctx.caller.kind });
    },
    ...over.route,
  };
  const req = (headers: Record<string, string> = { authorization: "Bearer mm_live_sample" }) => new Request("https://platform.example/api/gateway/data/items", { method: "POST", headers });
  return { deps, route, req, reached, touched };
}

const code = async (res: Response) => ((await res.json()) as { error?: { code: string } }).error?.code;

describe("the cap gate", () => {
  it("names its thirteen checks in the contract's order", () => {
    assert.deepEqual(CAP_CHECKS, ["flag", "token", "marker", "builder", "principal", "arguments", "rate", "in_flight", "quota", "budget", "reserve", "work", "settle"]);
  });

  it("1. flag: a cap that isn't served, or a route switch that's off, is a 404 that touches nothing", async () => {
    for (const h of [harness({ served: [] }), harness({ route: { enabled: () => false } })]) {
      const res = await runCapGate(h.req(), h.deps, h.route);
      assert.equal(res.status, 404);
      assert.equal(await code(res), "unknown_endpoint");
      assert.deepEqual(h.touched, []);
      assert.deepEqual(h.reached, []);
    }
  });

  it("2. token: no bearer, an unknown token, a scope the route doesn't take, an off or taken-down product, a banned owner", async () => {
    const none = harness();
    assert.equal((await runCapGate(none.req({}), none.deps, none.route)).status, 401);
    assert.deepEqual(none.touched, [], "no bearer reads nothing");
    const unknown = harness({ token: null });
    assert.equal((await runCapGate(unknown.req(), unknown.deps, unknown.route)).status, 401);
    const scoped = harness({ route: { scopes: ["build"] } });
    assert.equal(await code(await runCapGate(scoped.req(), scoped.deps, scoped.route)), "cap_not_allowed");
    for (const p of [null, product({ status: "disabled" }), product({ status: "failed" }), product({ takenDownAt: NOW }), product({ ownerBannedAt: NOW })]) {
      const h = harness({ product: p });
      const res = await runCapGate(h.req(), h.deps, h.route);
      assert.equal(res.status, 403);
      assert.equal(await code(res), "product_disabled");
      assert.deepEqual(h.reached, []);
    }
  });

  it("3. marker: no cap:data on the token, or a manifest that narrows it out", async () => {
    const bare = harness({ token: token({ allowedModels: ["muse-wonder-1.0"] }) });
    assert.equal(await code(await runCapGate(bare.req(), bare.deps, bare.route)), "cap_not_allowed");
    const narrowed = harness({ product: product({ manifest: { caps: ["files"] } }) });
    assert.equal(await code(await runCapGate(narrowed.req(), narrowed.deps, narrowed.route)), "cap_not_allowed");
    // A build token skips the stored manifest, which is the previous version's.
    const build = harness({ token: token({ scope: "build", buildId: BUILD }), product: product({ manifest: { caps: [] } }) });
    assert.equal((await runCapGate(build.req(), build.deps, build.route)).status, 200);
    assert.deepEqual(build.reached, ["principal", "arguments", "rate", "quota", `work:b:${BUILD}`]);
  });

  it("4. builder: a product the shared guest made can't use a cap that needs a signed-in builder", async () => {
    const guest = harness({ product: product({ ownerEmail: "guest@musemuse.local" }) });
    const { GUEST_EMAIL } = await import("@/lib/auth");
    const real = harness({ product: product({ ownerEmail: GUEST_EMAIL }) });
    assert.equal((await runCapGate(guest.req(), guest.deps, guest.route)).status, 200, "an address that isn't the guest's is a builder");
    const res = await runCapGate(real.req(), real.deps, real.route);
    assert.equal(await code(res), "sign_in_required");
    assert.deepEqual(real.reached, []);
  });

  it("5. principal: a build token with no build is refused, and the route's own rule runs", async () => {
    const orphan = harness({ token: token({ scope: "build", buildId: null }) });
    assert.equal(await code(await runCapGate(orphan.req(), orphan.deps, orphan.route)), "cap_not_allowed");
    assert.deepEqual(orphan.reached, []);
    const ruled = harness({ route: { allow: () => capError("sign_in_required", "Sign in.") } });
    assert.equal(await code(await runCapGate(ruled.req(), ruled.deps, ruled.route)), "sign_in_required");
    assert.deepEqual(ruled.reached, []);
  });

  it("6. arguments: a refusal stops before the rate limits", async () => {
    const h = harness({ route: { args: async () => capError("invalid_arguments", "No.") } });
    assert.equal(await code(await runCapGate(h.req(), h.deps, h.route)), "invalid_arguments");
    assert.ok(!h.touched.includes("hitRateLimits"));
  });

  it("7. rate: over a minute's limit, or a day's, is 429 with a retry time", async () => {
    const minute = harness({ deps: { hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, 6])) } });
    const res = await runCapGate(minute.req(), minute.deps, minute.route);
    assert.equal(res.status, 429);
    assert.equal(await code(res), "rate_limited");
    assert.equal(res.headers.get("retry-after"), "60");
    assert.ok(!minute.reached.includes("quota"));
    const windows: Date[] = [];
    const day = harness({
      deps: { hitRateLimits: async (keys, w) => (windows.push(w), Object.fromEntries(keys.map((k) => [k, 501]))) },
      route: { limits: () => [{ key: "d", limit: 500, window: "day", who: "your saves here" }] },
    });
    const dayRes = await runCapGate(day.req(), day.deps, day.route);
    assert.match(((await dayRes.json()) as { error: { message: string } }).error.message, /^Your saves here reached today's limit of 500\. It resets at 00:00 UTC\.$/);
    assert.equal(windows[0]!.toISOString(), "2026-11-02T00:00:00.000Z", "a day window ends at the next midnight, so the hourly prune keeps it");
  });

  it("8. in flight: no slot is 429, and a slot taken is given back after the work, even when it fails", async () => {
    const released: string[] = [];
    const full = harness({ deps: { acquireInFlight: async () => null, releaseInFlight: async (k) => void released.push(k) }, route: { inFlight: () => ({ key: "slot", limit: 2 }) } });
    assert.equal(await code(await runCapGate(full.req(), full.deps, full.route)), "rate_limited");
    const held = harness({
      deps: { acquireInFlight: async () => NOW, releaseInFlight: async (k) => void released.push(k) },
      route: { inFlight: () => ({ key: "slot", limit: 2 }), work: async () => { throw new Error("boom"); } },
    });
    const res = await runCapGate(held.req(), held.deps, held.route);
    assert.equal(res.status, 502);
    assert.equal(await code(res), "cap_failed");
    assert.deepEqual(released, ["slot"]);
  });

  it("9. quota: a full product stops before the work", async () => {
    const h = harness({ route: { quota: async () => capError("quota_exceeded", "Full.") } });
    const res = await runCapGate(h.req(), h.deps, h.route);
    assert.equal(res.status, 429);
    assert.equal(await code(res), "quota_exceeded");
    assert.ok(!h.reached.some((r) => r.startsWith("work")));
  });

  it("10 to 13. budget, reserve, work and settle for a route that spends; a paused cap is 503", async () => {
    const rows: Array<[string, unknown]> = [];
    const spendRoute = (over: Partial<CapRoute<{ n: number }>["spend"]> = {}) => ({
      spend: { source: "exec", endpoint: "exec", model: null, worstCaseUsd: () => 0.05, ...over },
      work: async () => ({ response: Response.json({ ok: true }), usage: { model: "exec", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, units: 1, costUsd: 0.01 } }),
    });
    const money: Partial<CapGateDeps> = {
      tokenSpendToday: async () => 1,
      platformSpendToday: async () => 10,
      dailySpendCapUsd: 50,
      reserveSpend: async (ctx, _m, usd) => (rows.push(["reserve", { usd, source: ctx.source, tokenId: ctx.tokenId }]), "r1"),
      settleSpend: async (id, item) => void rows.push(["settle", { id, cost: item?.costUsd ?? null }]),
    };
    const ok = harness({ deps: money, route: spendRoute() });
    assert.equal((await runCapGate(ok.req(), ok.deps, ok.route)).status, 200);
    assert.deepEqual(rows, [["reserve", { usd: 0.05, source: "exec", tokenId: "tok-1" }], ["settle", { id: "r1", cost: 0.01 }]]);
    const paused = harness({ deps: money, route: spendRoute({ capDailyUsd: 0 }) });
    const p = await runCapGate(paused.req(), paused.deps, paused.route);
    assert.equal(p.status, 503);
    assert.equal(await code(p), "caps_paused");
    for (const deps of [{ ...money, tokenSpendToday: async () => 2.99 }, { ...money, platformSpendToday: async () => 49.99 }, { ...money, builderDailyUsd: 5, builderSpendToday: async () => 4.99 }]) {
      rows.length = 0;
      const over = harness({ deps, route: spendRoute() });
      const res = await runCapGate(over.req(), over.deps, over.route);
      assert.equal(await code(res), "budget_exceeded");
      assert.deepEqual(rows, [], "nothing is reserved over a budget");
    }
    const capped = harness({ deps: money, route: spendRoute({ capDailyUsd: 2, capSpendToday: async () => 1.98 }) });
    assert.equal(await code(await runCapGate(capped.req(), capped.deps, capped.route)), "budget_exceeded");
  });

  it("works in the build namespace for a build token and in live for a live one", async () => {
    const live = harness();
    await runCapGate(live.req(), live.deps, live.route);
    assert.ok(live.reached.includes("work:live"));
    const build = harness({ token: token({ scope: "build", buildId: BUILD }) });
    await runCapGate(build.req(), build.deps, build.route);
    assert.ok(build.reached.includes(`work:b:${BUILD}`));
  });
});

describe("the gate's argument helpers", () => {
  it("refuse unknown keys by name, a body over the size, and a body that isn't an object", async () => {
    assert.equal(unknownKeys({ data: 1 }, ["data"]), null);
    assert.match(((await unknownKeys({ data: 1, extra: 2 }, ["data"])!.json()) as { error: { message: string } }).error.message, /Unknown field: extra\./);
    const big = new Request("https://x.example/", { method: "POST", body: "x".repeat(2000) });
    assert.ok((await readJsonBody(big, 1000)) instanceof Response);
    assert.ok((await readJsonBody(new Request("https://x.example/", { method: "POST", body: "[1]" }), 1000)) instanceof Response);
    assert.deepEqual(await readJsonBody(new Request("https://x.example/", { method: "POST", body: '{"a":1}' }), 1000), { a: 1 });
  });

  it("refuse private, loopback and odd-scheme URLs", () => {
    for (const bad of ["http://localhost/x", "http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.1/", "http://172.20.0.1/", "http://169.254.169.254/latest", "http://[::1]/", "http://[fd00::1]/", "file:///etc/passwd", "http://box.internal/", "not a url"]) {
      assert.equal(privateUrl(bad), true, bad);
    }
    for (const good of ["https://example.com/a", "http://203.0.113.9/", "https://172.32.0.1/"]) assert.equal(privateUrl(good), false, good);
  });
});

describe("who is asking", () => {
  const req = (headers: Record<string, string>) => new Request("https://platform.example/api/gateway/data", { headers });
  const live = { productId: "p1", scope: "live" };

  it("a live call is product, visitor, user or owner, strongest first, each only by its signature", () => {
    assert.equal(resolveCapCaller(req({}), live, NOW).kind, "product");
    const visitor = resolveCapCaller(req({ "x-musemuse-visitor": "visitor_abcdefghijklmnop" }), live, NOW);
    assert.deepEqual([visitor.kind, visitor.visitor], ["visitor", "visitor_abcdefghijklmnop"]);
    assert.equal(resolveCapCaller(req({ "x-musemuse-visitor": "short" }), live, NOW).visitor, null, "a visitor id that isn't one is ignored");
    const { session } = mintUserSession({ productId: "p1", subject: "subj_ana" }, NOW);
    const user = resolveCapCaller(req({ "x-musemuse-user": session, "x-musemuse-visitor": "visitor_abcdefghijklmnop" }), live, NOW);
    assert.deepEqual([user.kind, user.user, user.visitor], ["user", "subj_ana", "visitor_abcdefghijklmnop"]);
    const owner = mintOwnerSession({ productId: "p1", subject: "own_1" }, NOW).session;
    const both = resolveCapCaller(req({ "x-musemuse-user": session, "x-musemuse-owner": owner }), live, NOW);
    assert.deepEqual([both.kind, both.owner, both.user], ["owner", "own_1", "subj_ana"]);
  });

  it("a forged, expired or other product's session, or a build's made-up person on a live token, is no one", () => {
    const { session } = mintUserSession({ productId: "p1", subject: "subj_ana" }, NOW);
    const forged = session.replace(/\.[^.]+$/, ".AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const later = new Date(NOW.getTime() + 31 * 24 * 3_600_000);
    assert.equal(resolveCapCaller(req({ "x-musemuse-user": forged }), live, NOW).user, null);
    assert.equal(resolveCapCaller(req({ "x-musemuse-user": session }), live, later).user, null);
    assert.equal(resolveCapCaller(req({ "x-musemuse-user": session }), { productId: "p2", scope: "live" }, NOW).user, null);
    const test = mintTestUserSession({ productId: "p1", buildId: BUILD, subject: "made_up" }, NOW).session;
    assert.equal(resolveCapCaller(req({ "x-musemuse-user": test }), live, NOW).user, null);
  });

  it("a build is the owner only when the call names no one else, and takes its own made-up people only", () => {
    const build = { productId: "p1", scope: "build", buildId: BUILD };
    const test = mintTestUserSession({ productId: "p1", buildId: BUILD, subject: "made_up" }, NOW).session;
    const other = mintTestUserSession({ productId: "p1", buildId: "22222222-2222-4222-8222-222222222222", subject: "made_up" }, NOW).session;
    const real = mintUserSession({ productId: "p1", subject: "subj_ana" }, NOW).session;
    const c = resolveCapCaller(req({ "x-musemuse-user": test, "x-musemuse-client-ip": "203.0.113.7" }), build, NOW);
    assert.deepEqual([c.kind, c.owner, c.user, c.ip], ["build", null, "made_up", "203.0.113.7"], "a made-up person is that person, not the owner");
    assert.equal(resolveCapCaller(req({}), build, NOW).owner, "build", "seed and the build's own server calls");
    assert.equal(resolveCapCaller(req({ "x-musemuse-visitor": "visitor_abcdefghijklmnop" }), build, NOW).owner, null, "a second browser is a visitor");
    const asOwner = resolveCapCaller(req({ "x-musemuse-visitor": "visitor_abcdefghijklmnop", "x-musemuse-owner": BUILD_TEST_OWNER }), build, NOW);
    assert.deepEqual([asOwner.owner, asOwner.visitor], ["build", "visitor_abcdefghijklmnop"], "openAsOwner's pass");
    assert.equal(resolveCapCaller(req({ "x-musemuse-owner": BUILD_TEST_OWNER }), { productId: "p1", scope: "live" }, NOW).owner, null, "never on a live token");
    assert.equal(resolveCapCaller(req({ "x-musemuse-user": other }), build, NOW).user, null, "another build's person");
    assert.equal(resolveCapCaller(req({ "x-musemuse-user": real }), build, NOW).user, null, "a real person's session never reaches a build");
  });

  it("stores under a subject key, never a raw id, and one per product and kind", () => {
    const a = subjectKey("visitor", "p1", "visitor_abcdefghijklmnop");
    assert.equal(a.length, 32);
    assert.ok(!a.includes("visitor_abc"));
    assert.notEqual(a, subjectKey("visitor", "p2", "visitor_abcdefghijklmnop"));
    assert.notEqual(a, subjectKey("user", "p1", "visitor_abcdefghijklmnop"));
    assert.equal(a, subjectKey("visitor", "p1", "visitor_abcdefghijklmnop"));
  });
});
