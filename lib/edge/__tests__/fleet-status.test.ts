/**
 * {GATEWAY_URL}/fleet/v1/segment/status (lib/edge/fleet-status.ts): the flag, who may ask, and what the control plane's
 * node list says, on a fake control plane. No board, no database, no network.
 *
 *   npx tsx --test lib/edge/__tests__/fleet-status.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fleetSamSettings, type FleetSamDeps } from "@/lib/caps/fleet/sam";
import { handleFleetSamStatus, resetFleetStatusCache, STATUS_CACHE_MS } from "@/lib/edge/fleet-status";

const SETTINGS = { BOARD_FLEET_URL: "https://fleet.example/admin", BOARD_FLEET_TOKEN: "jpt_madeup", FLEET_SAM_NODE: "jetson-04" };
let now: Date;
let asked: string[];
let nodes: unknown;
const realError = console.error;

function deps(over: Partial<FleetSamDeps> = {}): FleetSamDeps {
  return {
    on: () => true,
    allProducts: () => false,
    settings: () => fleetSamSettings(SETTINGS),
    adminEmails: ["admin@example.com"],
    findToken: async () => ({ id: "t1", productId: "p1", scope: "live", allowedModels: ["muse-wonder-1.0", "sam-3.1"], dailyBudgetUsd: 1, buildId: null }),
    product: async () => ({ status: "live", manifest: null, liveUrl: null, takenDownAt: null, ownerId: "u1", ownerEmail: "admin@example.com", ownerIsAdmin: true, ownerBannedAt: null }),
    hitRateLimits: async () => ({}),
    acquireInFlight: async () => assert.fail("a status check takes no board slot"),
    releaseInFlight: async () => undefined,
    recordUsage: async () => assert.fail("a status check is not metered as a look"),
    fetch: (async (url: string, init: RequestInit) => {
      asked.push(`${init.method ?? "GET"} ${url} ${new Headers(init.headers).get("authorization")}`);
      if (nodes === "http500") return new Response("boom", { status: 500 });
      if (nodes === "refused") throw new TypeError("fetch failed");
      return Response.json(nodes);
    }) as typeof fetch,
    now: () => now,
    ...over,
  };
}

const call = (method = "GET", auth = "Bearer mm_live_x") => new Request("https://platform.example/api/gateway/fleet/v1/segment/status", { method, headers: auth ? { authorization: auth } : {} });
const body = async (res: Response) => (await res.json()) as { connected?: boolean; error?: { code?: string } };

beforeEach(() => {
  resetFleetStatusCache();
  now = new Date("2026-11-03T15:00:00Z");
  asked = [];
  nodes = [{ id: "nd_x", name: "jetson-04", status: "online", maintenance: false }];
  console.error = () => {};
});
afterEach(() => {
  console.error = realError;
});

describe("the fleet SAM status route", () => {
  it("is 404 while FLEET_SAM is off, and takes only GET", async () => {
    assert.equal((await handleFleetSamStatus(call(), deps({ on: () => false }))).status, 404);
    const post = await handleFleetSamStatus(call("POST"), deps());
    assert.equal(post.status, 405);
    assert.deepEqual(asked, []);
  });

  it("makes the look's caller checks: no token, a build's token, a brief without SAM, a builder's product", async () => {
    assert.equal((await handleFleetSamStatus(call("GET", ""), deps())).status, 401);
    const build = await handleFleetSamStatus(call(), deps({ findToken: async () => ({ id: "t", productId: "p1", scope: "build", allowedModels: ["sam-3.1"], dailyBudgetUsd: 1, buildId: "b" }) }));
    assert.deepEqual([build.status, (await body(build)).error?.code], [503, "fleet_sam_build"]);
    const noSam = await handleFleetSamStatus(call(), deps({ findToken: async () => ({ id: "t", productId: "p1", scope: "live", allowedModels: ["muse-wonder-1.0"], dailyBudgetUsd: 1, buildId: null }) }));
    assert.equal(noSam.status, 403);
    const builder = await handleFleetSamStatus(call(), deps({ product: async () => ({ status: "live", manifest: null, liveUrl: null, takenDownAt: null, ownerId: "u2", ownerEmail: "someone@example.com", ownerIsAdmin: false, ownerBannedAt: null }) }));
    assert.equal(builder.status, 403);
    assert.deepEqual(asked, [], "nobody turned away reaches the control plane");
  });

  it("says connected only when the control plane lists the node online and not in maintenance, with the fleet's own token", async () => {
    const up = await handleFleetSamStatus(call(), deps());
    assert.equal(up.status, 200);
    assert.equal(up.headers.get("cache-control"), "no-store");
    const json = await up.json();
    assert.deepEqual(Object.keys(json).sort(), ["checkedAt", "connected"], "it never names the board or the fleet");
    assert.equal(json.connected, true);
    assert.deepEqual(asked, ["GET https://fleet.example/admin/api/nodes Bearer jpt_madeup"]);
    for (const list of [[{ name: "jetson-04", status: "offline" }], [{ name: "jetson-04", status: "online", maintenance: true }], [{ name: "jetson-03", status: "online" }], { not: "a list" }, "http500", "refused"]) {
      resetFleetStatusCache();
      nodes = list;
      assert.equal((await body(await handleFleetSamStatus(call(), deps()))).connected, false, JSON.stringify(list));
    }
  });

  it("without the fleet settings it is not connected and asks nothing", async () => {
    const res = await handleFleetSamStatus(call(), deps({ settings: () => null }));
    assert.equal((await body(res)).connected, false);
    assert.deepEqual(asked, []);
  });

  it("keeps one control-plane answer for every product for a minute", async () => {
    await handleFleetSamStatus(call(), deps());
    nodes = [];
    assert.equal((await body(await handleFleetSamStatus(call(), deps()))).connected, true, "still the cached answer");
    assert.equal(asked.length, 1);
    now = new Date(now.getTime() + STATUS_CACHE_MS + 1);
    assert.equal((await body(await handleFleetSamStatus(call(), deps()))).connected, false);
    assert.equal(asked.length, 2);
  });
});
