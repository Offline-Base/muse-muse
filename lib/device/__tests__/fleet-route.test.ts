/**
 * Drives /api/device/fleet with auth and the control plane faked: guests never reach the fleet, a missing or down fleet
 * says so, and neither the address nor the token ever appears in a reply.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/device/__tests__/fleet-route.test.ts
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { resetFleetCache } from "@/lib/device/fleet";

const at = (path: string) => new URL(path, import.meta.url).href;
const URL_VALUE = "https://fleet.example.com/admin";
/** A test value, not a real token. */
const TOKEN_VALUE = "jpt_made_up_token";

class FakeAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

describe("/api/device/fleet", { skip: typeof mock.module !== "function" }, () => {
  let admin = true;
  let openAccess = false;
  let fetches = 0;
  let answer: () => Response = () => new Response("[]");
  let handlers: typeof import("@/app/api/device/fleet/route");
  const realFetch = globalThis.fetch;
  const realError = console.error;
  let logged: unknown[][] = [];

  const get = () => handlers.GET(new Request("http://x/api/device/fleet"));

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
    handlers = await import("@/app/api/device/fleet/route");
  });

  beforeEach(() => {
    admin = true;
    openAccess = false;
    fetches = 0;
    logged = [];
    resetFleetCache();
    answer = () => new Response("[]");
    process.env.BOARD_FLEET_URL = URL_VALUE;
    process.env.BOARD_FLEET_TOKEN = TOKEN_VALUE;
    console.error = (...args: unknown[]) => void logged.push(args);
    globalThis.fetch = (async () => {
      fetches++;
      return answer();
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    console.error = realError;
    delete process.env.BOARD_FLEET_URL;
    delete process.env.BOARD_FLEET_TOKEN;
  });

  after(() => mock.reset());

  it("refuses anyone but an admin before the fleet", async () => {
    admin = false;
    assert.equal((await get()).status, 403);
    assert.equal(fetches, 0);
  });

  it("refuses OPEN_ACCESS=admin's stand-in admin before the fleet, cached list or not", async () => {
    await get();
    assert.equal(fetches, 1);
    openAccess = true;
    assert.equal((await get()).status, 403);
    assert.equal(fetches, 1);
  });

  it("says so when the fleet isn't set up, without calling anything", async () => {
    delete process.env.BOARD_FLEET_TOKEN;
    const res = await get();
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "fleet_not_configured" });
    assert.equal(fetches, 0);
  });

  it("treats an address that would expose the token as not set up", async () => {
    process.env.BOARD_FLEET_URL = "http://fleet.example.com/admin";
    assert.equal((await get()).status, 503);
    assert.equal(fetches, 0);
  });

  it("lists the boards with only what's safe to show", async () => {
    answer = () =>
      Response.json([
        {
          id: "nd_secret",
          name: "jetson-02",
          status: "online",
          maintenance: false,
          pool: null,
          labels: { room: "secret" },
          facts: { hostname: "secret-host", ip: "10.0.0.9" },
          capabilities: ["ollama"],
          metrics: { mem: { used_mb: 100, total_mb: 200 }, temps_c: { cpu: 50, tj: 60 } },
          loaded_models: ["bolt"],
        },
      ]);
    const res = await get();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      boards: [{ name: "jetson-02", status: "online", pool: null, maintenance: false, loadedModels: ["bolt"], memUsedMb: 100, memTotalMb: 200, maxTempC: 60 }],
    });
  });

  it("reveals nothing when the fleet is down, in the reply or the log", async () => {
    const downs: Array<() => Response> = [
      () => {
        throw new Error(`fetch failed for ${URL_VALUE} with ${TOKEN_VALUE}`);
      },
      () => new Response(`bad token ${TOKEN_VALUE} at ${URL_VALUE}`, { status: 500 }),
      () => new Response(`<html>${URL_VALUE}</html>`),
    ];
    for (const down of downs) {
      resetFleetCache();
      answer = down;
      const res = await get();
      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), { error: "fleet_unavailable" });
    }
    assert.equal(logged.length, downs.length);
    assert.doesNotMatch(JSON.stringify(logged), /fleet\.example|jpt_/);
  });

  it("tells a wrong token or address apart from an outage, and still reveals nothing", async () => {
    for (const status of [401, 403, 404]) {
      resetFleetCache();
      answer = () => new Response(`bad token ${TOKEN_VALUE} at ${URL_VALUE}`, { status });
      const res = await get();
      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), { error: "fleet_refused" });
    }
    assert.doesNotMatch(JSON.stringify(logged), /fleet\.example|jpt_/);
  });

  it("makes one call through the tunnel for several admins, working or not", async () => {
    await Promise.all([get(), get()]);
    await get();
    assert.equal(fetches, 1);

    resetFleetCache();
    fetches = 0;
    answer = () => new Response("", { status: 500 });
    assert.equal((await get()).status, 502);
    assert.equal((await get()).status, 502);
    assert.equal(fetches, 1);
  });
});
