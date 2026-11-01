/** npx tsx --test lib/caps/platform/__tests__/powers.test.ts */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { BUILD_TEST_OWNER } from "@/lib/caps/principal";
import { isPowerChild, powerChildMark, powerParentOf } from "@/lib/caps/platform/child";
import { powerKeyLeftUsd } from "@/lib/caps/platform/gateway";
import { handlePlatform, type PlatformDeps } from "@/lib/caps/platform/handler";
import { capsForBuilder } from "@/lib/trust/tiers";
import { OWNER_HEADER } from "@/lib/gateway/policy";
import type { CapId } from "@/lib/caps/ids";
import { env } from "@/lib/env";
import { mintOwnerSession } from "@/lib/tools/principal";

const PRODUCT = "11111111-1111-4111-8111-111111111111";
const LIVE = "live-token";

function fakeDeps(over: Partial<PlatformDeps> = {}) {
  const counters = new Map<string, number>();
  const calls: string[] = [];
  const deps: PlatformDeps = {
    servedCaps: () => ["platform"] as CapId[],
    findToken: async (raw) => (raw === LIVE ? { id: "t1", productId: PRODUCT, scope: "live", allowedModels: ["cap:platform"], dailyBudgetUsd: 10, buildId: null } : raw === "build" ? { id: "t2", productId: PRODUCT, scope: "build", allowedModels: ["cap:platform"], dailyBudgetUsd: 10, buildId: "22222222-2222-4222-8222-222222222222" } : null),
    product: async () => ({ status: "live", manifest: null, liveUrl: null, takenDownAt: null, ownerId: "owner", ownerEmail: "someone@example.com", ownerIsAdmin: false, ownerBannedAt: null }),
    adminEmails: [],
    hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, 1])),
    briefPowers: async () => ({ sandboxes: true, gateway: true, publish: true }),
    isChildProduct: async () => false,
    productDailyUsd: 20,
    allDailyUsd: 50,
    keyMaxUsd: 5,
    buildUsd: 12,
    reserveCounter: async (key, _w, amount, limit) => {
      const total = (counters.get(key) ?? 0) + amount;
      if (total > limit) return null;
      counters.set(key, total);
      return total;
    },
    adjustCounter: async (key, _w, delta) => void counters.set(key, Math.max(0, (counters.get(key) ?? 0) + delta)),
    counterValue: async (key) => counters.get(key) ?? 0,
    sessions: () => {
      throw new Error("no sessions here");
    },
    keyModel: () => "muse-wonder-1.0",
    storeKey: async () => {
      calls.push("storeKey");
      return { id: "33333333-3333-4333-8333-333333333333" };
    },
    revokeKey: async (_p, id) => id === "33333333-3333-4333-8333-333333333333",
    startBuild: async () => {
      calls.push("startBuild");
      return { ok: true, buildId: "44444444-4444-4444-8444-444444444444" };
    },
    childBuild: async () => null,
    ...over,
  };
  return { deps, counters, calls };
}

function call(path: string[], opts: { token?: string; owner?: boolean; body?: unknown; method?: string } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.token ?? LIVE}` };
  if (opts.owner !== false && (opts.token ?? LIVE) === LIVE) headers[OWNER_HEADER] = mintOwnerSession({ productId: PRODUCT, subject: "own_1" }, new Date()).session;
  if ((opts.token ?? LIVE) === "build") headers[OWNER_HEADER] = BUILD_TEST_OWNER;
  return new Request(`https://x/api/gateway/platform/${path.join("/")}`, { method: opts.method ?? (opts.body === undefined ? "GET" : "POST"), headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
}
const code = async (r: Response) => ((await r.json()) as { error?: { code?: string } }).error?.code;
const keyBody = { label: "a", budgetUsd: 5, hours: 2 };

beforeEach(() => {
  process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret";
  process.env.GATEWAY_TOKEN_PEPPER ??= "test-pepper";
});

describe("the gate holds powers shut", () => {
  it("answers 404 with the cap off, and touches nothing", async () => {
    const { deps } = fakeDeps({ servedCaps: () => [], findToken: async () => assert.fail("touched") });
    const res = await handlePlatform(call([]), [], deps);
    assert.equal(res.status, 404);
  });

  it("refuses a product made as the shared guest", async () => {
    const { deps, calls } = fakeDeps({ product: async () => ({ status: "live", manifest: null, liveUrl: null, takenDownAt: null, ownerId: "g", ownerEmail: (await import("@/lib/auth")).GUEST_EMAIL, ownerIsAdmin: false, ownerBannedAt: null }) });
    const res = await handlePlatform(call(["keys"], { body: keyBody }), ["keys"], deps);
    assert.equal(res.status, 403);
    assert.equal(await code(res), "sign_in_required");
    assert.deepEqual(calls, []);
  });

  it("refuses a visitor: only the owner's signed pass gets in", async () => {
    const { deps, calls } = fakeDeps();
    const res = await handlePlatform(call(["keys"], { body: keyBody, owner: false }), ["keys"], deps);
    assert.equal(await code(res), "sign_in_required");
    assert.deepEqual(calls, []);
  });

  it("refuses a power the brief didn't ask for", async () => {
    const { deps } = fakeDeps({ briefPowers: async () => ({ sandboxes: false, gateway: true, publish: false }) });
    assert.equal(await code(await handlePlatform(call(["products"], { body: { note: "x" } }), ["products"], deps)), "cap_not_allowed");
  });

  it("refuses a product a power started, so powers never recurse", async () => {
    const { deps, calls } = fakeDeps({ isChildProduct: async () => true });
    assert.equal(await code(await handlePlatform(call(["products"], { body: { note: "x" } }), ["products"], deps)), "cap_not_allowed");
    assert.deepEqual(calls, []);
  });

  it("refuses unknown fields and a key over its limit", async () => {
    const { deps } = fakeDeps();
    assert.equal(await code(await handlePlatform(call(["keys"], { body: { ...keyBody, extra: 1 } }), ["keys"], deps)), "invalid_arguments");
    assert.equal(await code(await handlePlatform(call(["keys"], { body: { ...keyBody, budgetUsd: 6 } }), ["keys"], deps)), "invalid_arguments");
    assert.equal(await code(await handlePlatform(call(["keys"], { body: { ...keyBody, hours: 25 } }), ["keys"], deps)), "invalid_arguments");
  });
});

describe("the daily limit is hard", () => {
  it("commits a key's whole budget, and refuses the one that would pass the limit", async () => {
    const { deps, calls, counters } = fakeDeps();
    for (let i = 0; i < 4; i++) assert.equal((await handlePlatform(call(["keys"], { body: keyBody }), ["keys"], deps)).status, 200);
    const over = await handlePlatform(call(["keys"], { body: keyBody }), ["keys"], deps);
    assert.equal(over.status, 429);
    assert.equal(await code(over), "budget_exceeded");
    assert.equal(calls.length, 4);
    assert.equal(counters.get(`power:usd:${PRODUCT}`), 2000);
  });

  it("a product's new build counts its worst case first, and gets it back only if it never started", async () => {
    const { deps, counters } = fakeDeps({ startBuild: async () => ({ ok: false, status: 429, error: "daily_limit" }) });
    assert.equal(await code(await handlePlatform(call(["products"], { body: { note: "x" } }), ["products"], deps)), "quota_exceeded");
    assert.equal(counters.get(`power:usd:${PRODUCT}`), 0);
    const ok = fakeDeps();
    assert.equal((await handlePlatform(call(["products"], { body: { note: "x" } }), ["products"], ok.deps)).status, 200);
    assert.equal(ok.counters.get(`power:usd:${PRODUCT}`), 1200);
    assert.equal(await code(await handlePlatform(call(["products"], { body: { note: "y" } }), ["products"], ok.deps)), "budget_exceeded");
  });

  it("everyone's limit holds too, and gives back the product's share when it refuses", async () => {
    const { deps, counters } = fakeDeps({ allDailyUsd: 4 });
    assert.equal(await code(await handlePlatform(call(["keys"], { body: keyBody }), ["keys"], deps)), "budget_exceeded");
    assert.equal(counters.get(`power:usd:${PRODUCT}`), 0);
  });

  it("0 pauses them", async () => {
    const { deps } = fakeDeps({ productDailyUsd: 0 });
    assert.equal(await code(await handlePlatform(call(["keys"], { body: keyBody }), ["keys"], deps)), "caps_paused");
  });

  it("a key's budget is its whole life's, whichever day it's spent", () => {
    assert.equal(powerKeyLeftUsd(5, 2), 3);
    assert.equal(powerKeyLeftUsd(5, 7), 0);
  });
});

describe("what a product gets", () => {
  it("a key is scoped, shown once, and no platform secret comes back in any answer", async () => {
    process.env.MODEL_API_KEY = "platform-secret-value";
    const { deps } = fakeDeps();
    const res = await handlePlatform(call(["keys"], { body: keyBody }), ["keys"], deps);
    const text = await res.text();
    assert.match(text, /"key":"mm_pk_[A-Za-z0-9_-]{43}"/);
    assert.doesNotMatch(text, /platform-secret-value/);
    assert.doesNotMatch(text, new RegExp(process.env.GATEWAY_TOKEN_PEPPER!));
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("a build's tests are simulated: nothing spent, nothing started", async () => {
    const { deps, calls, counters } = fakeDeps();
    const res = await handlePlatform(call(["products"], { token: "build", body: { note: "x" } }), ["products"], deps);
    assert.equal(((await res.json()) as { simulated: boolean }).simulated, true);
    const status = (await (await handlePlatform(call([], { token: "build" }), [], deps)).json()) as { simulated: boolean };
    assert.equal(status.simulated, true);
    assert.deepEqual(calls, []);
    assert.equal(counters.size, 0);
  });

  it("another product's build isn't found", async () => {
    const { deps } = fakeDeps();
    const id = "44444444-4444-4444-8444-444444444444";
    assert.equal(await code(await handlePlatform(call(["products", id]), ["products", id], deps)), "invalid_arguments");
  });
});

describe("who gets offered powers", () => {
  const enabled: CapId[] = ["jobs", "platform"];
  it("a guest's writer never gets them, with TRUST_SIGNED_IN_CAPS on or off", () => {
    assert.deepEqual(capsForBuilder("guest", enabled, false), ["jobs"]);
    assert.deepEqual(capsForBuilder("guest", enabled, true), []);
    assert.deepEqual(capsForBuilder("banned", enabled, false), ["jobs"]);
  });
  it("a signed-in builder's does", () => {
    assert.deepEqual(capsForBuilder("builder", enabled, false), enabled);
    assert.deepEqual(capsForBuilder("admin", enabled, true), enabled);
  });
  it("off by default: the flag alone doesn't serve an unready cap", () => {
    process.env.PLATFORM_POWERS = "1";
    assert.deepEqual(env.servedCaps.filter((c) => c === "platform"), []);
    delete process.env.PLATFORM_POWERS;
  });
  it("a child's mark names its parent, and is unique", () => {
    const mark = powerChildMark(PRODUCT);
    assert.equal(isPowerChild(mark), true);
    assert.equal(powerParentOf(mark), PRODUCT);
    assert.notEqual(mark, powerChildMark(PRODUCT));
    assert.equal(isPowerChild("meta-demo-id"), false);
    assert.equal(isPowerChild(null), false);
  });
});
