/**
 * The connect cap's routes (docs/CAPABILITIES.md, section 11) with fakes: the allowlists' paths and parameters, the
 * cache, recorded samples for builds, the vault's sealed round trip and that no answer ever holds a value, brokered
 * calls only to the service's own hosts, approvals that refuse changed arguments, and sends that are the owner's only.
 * No call leaves this process: the outside world is a fake fetch that records what it was asked.
 *
 *   npx tsx --test lib/caps/connect/__tests__/connect.test.ts
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { canonicalJson as connectCanonical, matchCall, matchFetch, PUBLIC_APIS, SERVICES } from "@/lib/caps/connect/allowlist";
import type { ConnectBrief } from "@/lib/caps/connect/brief";
import { narrowConnect } from "@/lib/caps/connect/deps";
import { handleFetch, handleSend, handleVault, type ConnectDeps } from "@/lib/caps/connect/handler";
import { API_SAMPLES, SERVICE_SAMPLES } from "@/lib/caps/connect/samples";
import type { CachedAnswer, ConnectStore, KeyRow, SendRow } from "@/lib/caps/connect/store";
import type { CapProduct, CapToken } from "@/lib/caps/gate";
import { BUILD_TEST_OWNER } from "@/lib/caps/principal";
import { newBoxKey, openSecret, parseKeyring, type SealedSecret } from "@/lib/secrets/box";
import { mintOwnerSession } from "@/lib/tools/principal";
import { canonicalJson } from "@/lib/tools/sign";

process.env.GATEWAY_TOKEN_PEPPER ??= "test-pepper-for-connect";

const NOW = new Date("2026-11-01T12:00:00Z");
const BUILD = "11111111-1111-4111-8111-111111111111";
const KEY = "ghp_madeUpKeyForTestsOnly0123456789";
const RULES: ConnectBrief = {
  publicApis: ["nws", "wikipedia"],
  keys: [{ service: "github", why: "Shows the owner's repositories." }, { service: "openweathermap", why: "Current weather." }],
  sends: [{ channel: "email", why: "Sends the plan to friends." }, { channel: "chat", why: "Posts it to the team." }],
};

const liveToken = (over: Partial<CapToken> = {}): CapToken => ({ id: "tok-live", productId: "p1", scope: "live", allowedModels: ["cap:connect"], dailyBudgetUsd: 3, buildId: null, ...over });
const buildToken = (): CapToken => liveToken({ id: "tok-build", scope: "build", buildId: BUILD });
const product = (over: Partial<CapProduct> = {}): CapProduct => ({ status: "live", manifest: null, liveUrl: "https://p1.example", takenDownAt: null, ownerId: "u1", ownerEmail: "maker@example.com", ownerIsAdmin: false, ownerBannedAt: null, ...over });

interface Outgoing {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  redirect: string | undefined;
}

class FakeStore implements ConnectStore {
  cache = new Map<string, CachedAnswer & { expiresAt: Date }>();
  keys: Array<KeyRow & SealedSecret & { productId: string; namespace: string; revokedAt: Date | null; testHash: string | null }> = [];
  sends: SendRow[] = [];
  async cacheGet(key: string, now: Date) {
    const row = this.cache.get(key);
    return row && row.expiresAt >= now ? row : null;
  }
  async cachePut(row: Parameters<ConnectStore["cachePut"]>[0]) {
    this.cache.set(row.key, row);
  }
  async listKeys(productId: string, namespace: string) {
    return this.keys.filter((k) => k.productId === productId && k.namespace === namespace && !k.revokedAt).map((k) => ({ name: k.name, service: k.service, createdAt: k.createdAt }));
  }
  async sealedKey(productId: string, namespace: string, name: string) {
    const k = this.keys.find((x) => x.productId === productId && x.namespace === namespace && x.name === name && !x.revokedAt);
    return k ? { service: k.service, ciphertext: k.ciphertext, iv: k.iv, tag: k.tag, keyVersion: k.keyVersion } : null;
  }
  async putKey(row: Parameters<ConnectStore["putKey"]>[0], max: number, now: Date) {
    const active = this.keys.filter((k) => k.productId === row.productId && k.namespace === row.namespace && !k.revokedAt);
    if (active.filter((k) => k.name !== row.name).length >= max) return false;
    for (const k of active) if (k.name === row.name) k.revokedAt = now;
    this.keys.push({ productId: row.productId, namespace: row.namespace, name: row.name, service: row.service, createdAt: now, revokedAt: null, testHash: row.testHash, ...row.sealed });
    return true;
  }
  async revokeKey(productId: string, namespace: string, name: string, now: Date) {
    const k = this.keys.find((x) => x.productId === productId && x.namespace === namespace && x.name === name && !x.revokedAt);
    if (k) k.revokedAt = now;
    return Boolean(k);
  }
  async recordSend(row: SendRow) {
    if (this.sends.some((s) => s.approvalNonce === row.approvalNonce)) throw new Error("duplicate approval");
    this.sends.push(row);
  }
}

let store: FakeStore;
let outgoing: Outgoing[];
let counters: Map<string, number>;
let usageRows: Array<{ source: string; model: string; units?: number; costUsd: number }>;
let reply: (o: Outgoing) => Response;
const ring = parseKeyring(newBoxKey())!;

function deps(over: Partial<Omit<ConnectDeps, "rules">> & { token?: CapToken; product?: CapProduct; rules?: ConnectBrief | null } = {}): ConnectDeps {
  const { token: t, product: p, rules, ...rest } = over;
  return {
    servedCaps: () => ["connect"],
    findToken: async () => t ?? liveToken(),
    product: async () => p ?? product(),
    adminEmails: [],
    hitRateLimits: async (keys) =>
      Object.fromEntries(
        keys.map((k) => {
          counters.set(k, (counters.get(k) ?? 0) + 1);
          return [k, counters.get(k)!];
        }),
      ),
    reserveCounter: async (key, _w, amount, limit) => {
      const next = (counters.get(key) ?? 0) + amount;
      if (next > limit) return null;
      counters.set(key, next);
      return next;
    },
    recordUsage: async (_ctx, items) => {
      usageRows.push(...items.map((i) => ({ source: _ctx.source, model: i.model, units: i.units, costUsd: i.costUsd })));
    },
    store,
    vaultOn: () => true,
    sendsOn: () => true,
    keyring: () => ring,
    rules: async () => (rules === undefined ? RULES : rules),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const o: Outgoing = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: typeof init?.body === "string" ? init.body : null,
        redirect: init?.redirect,
      };
      outgoing.push(o);
      return reply(o);
    }) as typeof fetch,
    userAgent: "MuseMuse/1.0 (+https://platform.example)",
    now: () => NOW,
    ...rest,
  };
}

const owner = mintOwnerSession({ productId: "p1", subject: "owner-sub" }, NOW).session;
function req(path: string, body: unknown, headers: Record<string, string> = {}, method = "POST") {
  return new Request(`https://platform.example/api/gateway/${path}`, {
    method,
    headers: { authorization: "Bearer mm_x", "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const asOwner = { "x-musemuse-owner": owner };
const asVisitor = { "x-musemuse-visitor": "visitor_abcdefghijklmnop" };
const read = async (res: Response) => (await res.json()) as Record<string, unknown> & { error?: { code: string; message: string } };

beforeEach(() => {
  store = new FakeStore();
  outgoing = [];
  counters = new Map();
  usageRows = [];
  reply = () => Response.json({ ok: true }, { headers: { "content-type": "application/json" } });
});

describe("the allowlists", () => {
  it("take only listed paths and parameters, with values that match their patterns", () => {
    const ok = matchFetch({ api: "nws", path: "/points/38.8894,-77.0352" });
    assert.ok(typeof ok !== "string");
    assert.equal(ok.url, "https://api.weather.gov/points/38.8894,-77.0352");
    const usgs = matchFetch({ api: "usgs", path: "/fdsnws/event/1/query", query: { minmagnitude: 5, limit: 3, format: "xml" as never } });
    assert.match(String(usgs), /doesn't take format/, "a fixed parameter can't be sent");
    const fixed = matchFetch({ api: "usgs", path: "/fdsnws/event/1/query", query: { minmagnitude: 5, limit: 3 } });
    assert.ok(typeof fixed !== "string");
    assert.equal(fixed.url, "https://earthquake.usgs.gov/fdsnws/event/1/query?limit=3&minmagnitude=5&format=geojson");
    for (const [req, why] of [
      [{ api: "exa", path: "/search" }, /isn't one of/],
      [{ api: "constructor", path: "/" }, /isn't one of/],
      [{ api: "nws", path: "/points/1e9,0" }, /lat in the path/],
      [{ api: "nws", path: "/gridpoints/LWX/97,71/forecast/../../../alerts" }, /climb/],
      [{ api: "nws", path: "/gridpoints/LWX/97,71" }, /no path like that/],
      [{ api: "nws", path: "/points/1,2?x=1" }, /query parameters in query/],
      [{ api: "wikipedia", path: "/api/rest_v1/page/summary/a%2Fb" }, /climb/],
      [{ api: "wikipedia", path: "/w/rest.php/v1/search/page" }, /needs q/],
      [{ api: "wikipedia", path: "/w/rest.php/v1/search/page", query: { q: "bees", limit: 500 } }, /limit isn't/],
      [{ api: "openlibrary", path: "/works/OL1W.json", query: { evil: "1" } }, /doesn't take evil/],
    ] as const) {
      assert.match(String(matchFetch(req as never)), why, JSON.stringify(req));
    }
  });

  it("take titles with a comma, which many place articles have, and still keep NWS's {lat},{lon} apart", () => {
    for (const path of ["/api/rest_v1/page/summary/Austin,_Texas", "/api/rest_v1/page/summary/Washington,_D.C.", "/api/rest_v1/page/summary/Washington%2C_D.C."]) {
      const t = matchFetch({ api: "wikipedia", path });
      assert.ok(typeof t !== "string", `${path}: ${String(t)}`);
      assert.match(t.url, /\/page\/summary\/(Austin,_Texas|Washington,_D\.C\.)$/);
    }
    const spelled = [matchFetch({ api: "wikipedia", path: "/api/rest_v1/page/summary/Washington,_D.C." }), matchFetch({ api: "wikipedia", path: "/api/rest_v1/page/summary/Washington%2C_D.C." })];
    assert.ok(spelled.every((t) => typeof t !== "string"));
    assert.equal((spelled[0] as Exclude<ReturnType<typeof matchFetch>, string>).cacheKey, (spelled[1] as Exclude<ReturnType<typeof matchFetch>, string>).cacheKey);
    assert.match(String(matchFetch({ api: "nws", path: "/points/38.8894,-77.0352,5" })), /lon in the path|no path like that/);
    assert.match(String(matchFetch({ api: "nws", path: "/gridpoints/LWX/97,71,3/forecast" })), /y in the path|no path like that/);
    assert.ok(typeof matchFetch({ api: "usgs", path: "/earthquakes/feed/v1.0/summary/4.5_week.geojson" }) !== "string");
    assert.ok(typeof matchFetch({ api: "openlibrary", path: "/works/OL45883W.json" }) !== "string");
  });

  it("drop every copy of a query key the request sent, in any spelling", () => {
    const q = matchCall("openweathermap", "GET", "/data/2.5/weather?q=x&appid=EVIL&APPID=evil2&AppId=evil3");
    assert.ok(typeof q !== "string");
    assert.equal(q.url.search, "?q=x");
  });

  it("give the same cache key for the same request in any order", () => {
    const a = matchFetch({ api: "openlibrary", path: "/search.json", query: { q: "hobbit", limit: 3 } });
    const b = matchFetch({ api: "openlibrary", path: "/search.json", query: { limit: "3", q: " hobbit " } });
    assert.ok(typeof a !== "string" && typeof b !== "string");
    assert.equal(a.cacheKey, b.cacheKey);
    assert.equal(a.url, b.url);
  });

  it("keep brokered calls on the service's own host, methods and paths, and never let a request set the key", () => {
    const ok = matchCall("github", "GET", "/repos/sample/garden?per_page=5");
    assert.ok(typeof ok !== "string");
    assert.equal(ok.url.host, "api.github.com");
    const q = matchCall("openweathermap", "GET", "/data/2.5/weather?q=Paris&appid=stolen");
    assert.ok(typeof q !== "string");
    assert.equal(q.url.searchParams.get("appid"), null, "a request's own appid is dropped");
    for (const [service, method, path, why] of [
      ["github", "DELETE", "/repos/x/y", /GET or POST/],
      ["github", "POST", "/repos/x/y/issues", /calls go only to/],
      ["github", "GET", "//evil.example/repos", /one \//],
      ["github", "GET", "https://evil.example/repos/x", /one \//],
      ["github", "GET", "/repos/%2e%2e/admin", /climb/],
      ["github", "GET", "/orgs/x", /calls go only to/],
      ["resend", "POST", "/emails", /only send/],
      ["nope", "GET", "/", /can't call/],
      ["__proto__", "GET", "/", /can't call/],
    ] as const) {
      assert.match(String(matchCall(service, method, path)), why, `${service} ${method} ${path}`);
    }
  });

  it("have a recorded sample for every path and every call, terms read for every API, and no em dash", () => {
    for (const api of Object.values(PUBLIC_APIS)) {
      assert.match(api.termsRead, /^2026-10-31: /, api.id);
      for (const p of api.paths) assert.ok(API_SAMPLES[api.id]?.[p.id]?.length, `${api.id} ${p.id}`);
    }
    for (const s of Object.values(SERVICES)) for (const c of s.calls) assert.ok(SERVICE_SAMPLES[s.id]?.[`${c.method} ${c.path}`]?.length, `${s.id} ${c.method} ${c.path}`);
    assert.ok(!JSON.stringify({ PUBLIC_APIS, SERVICES }).includes("—"));
  });

  it("hash arguments exactly as the tool gateway does", () => {
    const v = { b: [1, { z: null, a: "x" }], a: true, u: undefined };
    assert.equal(connectCanonical(v), canonicalJson(v));
  });
});

describe("POST /fetch", () => {
  it("calls the API once with its User-Agent, answers with its data and the credit, and serves the next from the cache", async () => {
    reply = () => Response.json({ properties: { gridId: "LWX" } }, { headers: { "content-type": "application/geo+json" } });
    const first = await handleFetch(req("fetch", { api: "nws", path: "/points/38.8894,-77.0352" }), deps());
    assert.equal(first.status, 200);
    const body = await read(first);
    assert.deepEqual(body.data, { properties: { gridId: "LWX" } });
    assert.equal(body.cached, false);
    assert.equal(body.credit, PUBLIC_APIS.nws!.attribution);
    assert.equal(outgoing.length, 1);
    assert.equal(outgoing[0]!.headers["user-agent"], "MuseMuse/1.0 (+https://platform.example)");
    assert.equal(outgoing[0]!.headers.accept, "application/geo+json");
    assert.equal(outgoing[0]!.redirect, "manual");
    assert.equal(outgoing[0]!.headers.authorization, undefined, "no product token or key goes out");
    const again = await read(await handleFetch(req("fetch", { api: "nws", path: "/points/38.8894,-77.0352" }), deps()));
    assert.equal(again.cached, true);
    assert.equal(outgoing.length, 1, "the cache answered");
    assert.deepEqual(usageRows, [{ source: "fetch", model: "fetch:nws", units: 1, costUsd: 0 }]);
  });

  it("gives a build the recorded sample and never calls out", async () => {
    const res = await handleFetch(req("fetch", { api: "wikipedia", path: "/api/rest_v1/page/summary/Honey_bee" }), deps({ token: buildToken() }));
    const body = await read(res);
    assert.equal(body.simulated, true);
    assert.equal(body.sample, "wikipedia:summary:0");
    assert.equal((body.data as { title: string }).title, (API_SAMPLES.wikipedia!.summary![0]!.data as { title: string }).title);
    assert.equal(outgoing.length, 0);
  });

  it("refuses an API the product's brief didn't pick, and unknown fields by name", async () => {
    const off = await handleFetch(req("fetch", { api: "usgs", path: "/earthquakes/feed/v1.0/summary/all_day.geojson" }), deps());
    assert.equal(off.status, 403);
    assert.equal((await read(off)).error!.code, "cap_not_allowed");
    const extra = await handleFetch(req("fetch", { api: "nws", path: "/points/1,2", url: "https://evil.example" }), deps());
    assert.equal(extra.status, 400);
    assert.match((await read(extra)).error!.message, /Unknown field: url/);
    const none = await handleFetch(req("fetch", { api: "nws", path: "/points/1,2" }), deps({ rules: null }));
    assert.equal(none.status, 403);
    assert.equal(outgoing.length, 0);
  });

  it("follows a redirect only on the API's own host to an allowed path, and refuses one elsewhere", async () => {
    let n = 0;
    reply = (o) => {
      n++;
      if (o.url.endsWith("/Honeybee")) return new Response(null, { status: 302, headers: { location: "/api/rest_v1/page/summary/Honey_bee" } });
      return Response.json({ title: "Honey bee" });
    };
    const ok = await read(await handleFetch(req("fetch", { api: "wikipedia", path: "/api/rest_v1/page/summary/Honeybee" }), deps()));
    assert.equal((ok.data as { title: string }).title, "Honey bee");
    assert.equal(n, 2);
    reply = () => new Response(null, { status: 301, headers: { location: "https://evil.example/x" } });
    const away = await handleFetch(req("fetch", { api: "wikipedia", path: "/api/rest_v1/page/summary/Elsewhere" }), deps());
    assert.equal(away.status, 502);
    assert.match((await read(away)).error!.message, /somewhere else/);
  });

  it("refuses an answer over 1 MB or one that isn't data, and caches a 404 briefly but not a 500", async () => {
    reply = () => new Response("x".repeat(1024 * 1024 + 1), { headers: { "content-type": "application/json" } });
    assert.equal((await handleFetch(req("fetch", { api: "nws", path: "/points/1,1" }), deps())).status, 502);
    reply = () => new Response("<html>", { headers: { "content-type": "text/html" } });
    assert.equal((await handleFetch(req("fetch", { api: "nws", path: "/points/1,2" }), deps())).status, 502);
    reply = () => Response.json({ title: "Not Found" }, { status: 404 });
    const missing = await read(await handleFetch(req("fetch", { api: "nws", path: "/points/1,3" }), deps()));
    assert.equal(missing.status, 404);
    const row = [...store.cache.values()].at(-1)!;
    assert.equal(row.expiresAt.getTime() - NOW.getTime(), 60_000);
    const size = store.cache.size;
    reply = () => Response.json({}, { status: 500 });
    await handleFetch(req("fetch", { api: "nws", path: "/points/1,4" }), deps());
    assert.equal(store.cache.size, size);
  });

  it("holds each product to 60 a minute and each end user to 20, and the API to its own rate", async () => {
    for (let i = 0; i < 20; i++) assert.equal((await handleFetch(req("fetch", { api: "nws", path: `/points/1,${i}` }, { "x-musemuse-client-ip": "203.0.113.9" }), deps())).status, 200);
    const ip = await handleFetch(req("fetch", { api: "nws", path: "/points/2,1" }, { "x-musemuse-client-ip": "203.0.113.9" }), deps());
    assert.equal(ip.status, 429);
    counters.set("fetch-api:nws", PUBLIC_APIS.nws!.perMinute);
    const busy = await handleFetch(req("fetch", { api: "nws", path: "/points/3,1" }), deps());
    assert.equal(busy.status, 429);
    assert.match((await read(busy)).error!.message, /busy/);
  });
});

describe("the key vault", () => {
  it("saves a key only for the owner, sealed, and never answers with it", async () => {
    const visitor = await handleVault(req("vault", { service: "github", value: KEY }, asVisitor), [], deps());
    assert.equal(visitor.status, 403);
    const saved = await handleVault(req("vault", { service: "github", value: KEY }, asOwner), [], deps());
    assert.equal(saved.status, 201);
    const text = await saved.text();
    assert.ok(!text.includes(KEY));
    const row = store.keys[0]!;
    assert.ok(!row.ciphertext.toString("utf8").includes("ghp_"));
    assert.equal(openSecret(row, ring, "vault:p1:live:github"), KEY, "sealed to this product, namespace and name");
    assert.throws(() => openSecret(row, ring, "vault:p2:live:github"));
    assert.equal(row.testHash, null, "a live key has no hash");
    const list = await handleVault(req("vault", undefined, asOwner, "GET"), [], deps());
    const listed = await list.text();
    assert.ok(!listed.includes(KEY));
    assert.deepEqual((JSON.parse(listed) as { keys: Array<{ name: string }> }).keys.map((k) => k.name), ["github"]);
  });

  it("refuses a service the brief didn't pick, a bad key, a webhook off its host, and an 11th key", async () => {
    const off = await handleVault(req("vault", { service: "airtable", value: KEY }, asOwner), [], deps());
    assert.equal(off.status, 403);
    const spaced = await handleVault(req("vault", { service: "github", value: "has a space in it" }, asOwner), [], deps());
    assert.equal(spaced.status, 400);
    assert.ok(!(await spaced.text()).includes("has a space"), "the refusal never repeats the value");
    const hook = await handleVault(req("vault", { service: "slack_webhook", value: "https://evil.example/services/x" }, asOwner), [], deps());
    assert.equal(hook.status, 400);
    const good = await handleVault(req("vault", { service: "slack_webhook", value: "https://hooks.slack.com/services/T000/B000/madeup" }, asOwner), [], deps());
    assert.equal(good.status, 201);
    for (let i = 0; i < 9; i++) await handleVault(req("vault", { name: `github_${i}`, service: "github", value: KEY }, asOwner), [], deps());
    const full = await handleVault(req("vault", { name: "github_x", service: "github", value: KEY }, asOwner), [], deps());
    assert.equal(full.status, 429);
    assert.equal((await read(full)).error!.code, "quota_exceeded");
  });

  it("is paused without CONNECT_VAULT_KEY, and revokes by name", async () => {
    const pausedRes = await handleVault(req("vault", { service: "github", value: KEY }, asOwner), [], deps({ keyring: () => null }));
    assert.equal(pausedRes.status, 503);
    await handleVault(req("vault", { service: "github", value: KEY }, asOwner), [], deps());
    const del = await handleVault(req("vault/github", undefined, asOwner, "DELETE"), ["github"], deps());
    assert.equal(del.status, 200);
    assert.equal((await handleVault(req("vault/github", undefined, asOwner, "DELETE"), ["github"], deps())).status, 404);
    assert.equal((await store.listKeys("p1", "live")).length, 0);
  });

  it("won't save a key named call, which DELETE /vault/<name> could never remove", async () => {
    const res = await handleVault(req("vault", { name: "call", service: "github", value: KEY }, asOwner), [], deps());
    assert.equal(res.status, 400);
    assert.match((await read(res)).error!.message, /not call/);
    assert.equal(store.keys.length, 0);
    assert.equal((await handleVault(req("vault", { name: "call_me", service: "github", value: KEY }, asOwner), [], deps())).status, 201, "only the exact name is reserved");
  });

  it("keeps a build's test keys in its own namespace with a hash for the leak scan", async () => {
    const res = await handleVault(req("vault", { service: "github", value: "mmtest_abcdefghijklmnopqrstuvwx" }), [], deps({ token: buildToken() }));
    assert.equal(res.status, 201);
    assert.equal(store.keys[0]!.namespace, `b:${BUILD}`);
    assert.match(store.keys[0]!.testHash!, /^[0-9a-f]{16}$/);
    assert.equal((await handleVault(req("vault", { service: "github", value: KEY }, asVisitor), [], deps({ token: buildToken() }))).status, 403, "a build's visitor isn't the owner");
  });
});

describe("POST /vault/call", () => {
  beforeEach(async () => {
    await handleVault(req("vault", { service: "github", value: KEY }, asOwner), [], deps());
    await handleVault(req("vault", { service: "openweathermap", value: "owmMadeUpKey1234" }, asOwner), [], deps());
    outgoing = [];
  });

  it("adds the key to the service's own auth, calls only its host, and hides the key if the answer echoes it", async () => {
    reply = (o) => Response.json({ login: "sample", echo: o.headers.authorization }, { headers: { "content-type": "application/json" } });
    const res = await handleVault(req("vault/call", { name: "github", method: "GET", path: "/repos/sample/garden" }, asOwner), ["call"], deps());
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(KEY), "the key never reaches the product");
    assert.match(text, /\[key hidden\]/);
    assert.equal(outgoing.length, 1);
    assert.equal(new URL(outgoing[0]!.url).host, "api.github.com");
    assert.equal(outgoing[0]!.headers.authorization, `Bearer ${KEY}`);
    assert.equal(outgoing[0]!.headers["x-github-api-version"], "2022-11-28");
    assert.equal(outgoing[0]!.redirect, "manual");
    const weather = await handleVault(req("vault/call", { name: "openweathermap", path: "/data/2.5/weather?q=Paris&appid=other" }, asVisitor), ["call"], deps());
    assert.equal(weather.status, 200, "a visitor may use a service that allows visitors");
    assert.equal(new URL(outgoing[1]!.url).searchParams.getAll("appid").join(), "owmMadeUpKey1234");
  });

  it("refuses a visitor for an owner-only service, a path off the list, and a redirect", async () => {
    assert.equal((await handleVault(req("vault/call", { name: "github", path: "/user" }, asVisitor), ["call"], deps())).status, 403);
    assert.equal((await handleVault(req("vault/call", { name: "github", method: "POST", path: "/repos/x/y/issues", body: {} }, asOwner), ["call"], deps())).status, 400);
    reply = () => new Response(null, { status: 302, headers: { location: "https://evil.example" } });
    assert.equal((await handleVault(req("vault/call", { name: "github", path: "/user" }, asOwner), ["call"], deps())).status, 502);
    assert.equal(outgoing.length, 1, "the redirect wasn't followed");
  });

  it("answers needs_key when no key is saved, and gives a build the service's sample", async () => {
    store.keys = [];
    const none = await read(await handleVault(req("vault/call", { name: "github", path: "/user" }, asOwner), ["call"], deps()));
    assert.equal(none.code, "needs_key");
    assert.equal(outgoing.length, 0);
    await handleVault(req("vault", { service: "github", value: "mmtest_abcdefghijklmnopqrstuvwx" }), [], deps({ token: buildToken() }));
    const sample = await read(await handleVault(req("vault/call", { name: "github", path: "/user" }), ["call"], deps({ token: buildToken() })));
    assert.equal(sample.simulated, true);
    assert.deepEqual(sample.data, SERVICE_SAMPLES.github!["GET /user"]![0]!.data);
    assert.equal(outgoing.length, 0);
  });
});

describe("POST /send", () => {
  const email = { channel: "email", to: ["Friend@Example.com"], subject: "Saturday plan", body: "Rain until noon, so the hike starts at 1." };

  beforeEach(async () => {
    await handleVault(req("vault", { service: "resend", value: "re_madeUpKey12345" }, asOwner), [], deps());
    outgoing = [];
    reply = () => Response.json({ id: "re_msg_1" });
  });

  it("answers needs_confirmation first and sends nothing, then sends once with that exact approval", async () => {
    const first = await read(await handleSend(req("send", email, asOwner), deps()));
    assert.equal(first.code, "needs_confirmation");
    const confirmation = first.confirmation as { id: string; lines: string[]; args: unknown };
    assert.deepEqual(confirmation.lines.slice(0, 2), ["To: friend@example.com", "Subject: Saturday plan"]);
    assert.equal(outgoing.length, 0);
    const sent = await read(await handleSend(req("send", { ...email, approval: confirmation.id }, asOwner), deps()));
    assert.deepEqual(sent, { ok: true, status: "sent", id: "re_msg_1" });
    assert.equal(outgoing.length, 1);
    assert.equal(outgoing[0]!.url, "https://api.resend.com/emails");
    assert.equal(outgoing[0]!.headers.authorization, "Bearer re_madeUpKey12345");
    assert.deepEqual(JSON.parse(outgoing[0]!.body!).to, ["friend@example.com"]);
    assert.equal(store.sends.length, 1);
    assert.equal(store.sends[0]!.status, "sent");
    assert.ok(!JSON.stringify(store.sends).includes("friend@"), "recipients are kept as a hash");
    const replay = await read(await handleSend(req("send", { ...email, approval: confirmation.id }, asOwner), deps()));
    assert.equal(replay.code, "needs_confirmation", "one confirmation sends once");
    assert.equal(replay.stale, true);
    assert.equal(outgoing.length, 1);
  });

  it("refuses an approval for changed words, another product or another owner", async () => {
    const { confirmation } = (await read(await handleSend(req("send", email, asOwner), deps()))) as unknown as { confirmation: { id: string } };
    const changed = await read(await handleSend(req("send", { ...email, body: "Something else", approval: confirmation.id }, asOwner), deps()));
    assert.equal(changed.code, "needs_confirmation");
    assert.equal(changed.stale, true);
    const other = mintOwnerSession({ productId: "p1", subject: "someone-else" }, NOW).session;
    const theirs = await read(await handleSend(req("send", { ...email, approval: confirmation.id }, { "x-musemuse-owner": other }), deps()));
    assert.equal(theirs.code, "needs_confirmation");
    assert.equal(outgoing.length, 0);
  });

  it("is the owner's only, refuses more than 5 recipients, and channels the brief didn't pick or that can't send yet", async () => {
    assert.equal((await handleSend(req("send", email, asVisitor), deps())).status, 403);
    const many = await handleSend(req("send", { ...email, to: ["a@example.com", "b@example.com", "c@example.com", "d@example.com", "e@example.com", "f@example.com"] }, asOwner), deps());
    assert.equal(many.status, 400);
    assert.equal((await handleSend(req("send", { channel: "sms", to: ["+15555550100"], body: "hi" }, asOwner), deps())).status, 400);
    const unpicked = await handleSend(req("send", { channel: "chat", body: "hi" }, asOwner), deps({ rules: { ...RULES, sends: [RULES.sends[0]!] } }));
    assert.equal(unpicked.status, 403);
  });

  it("is a 404 with sends off, which is production's default", async () => {
    const res = await handleSend(req("send", email, asOwner), deps({ sendsOn: () => false }));
    assert.equal(res.status, 404);
  });

  it("needs the owner's own key before spending the approval, and stops at 10 a day", async () => {
    store.keys = [];
    const { confirmation } = (await read(await handleSend(req("send", email, asOwner), deps()))) as unknown as { confirmation: { id: string } };
    const noKey = await read(await handleSend(req("send", { ...email, approval: confirmation.id }, asOwner), deps()));
    assert.equal(noKey.code, "needs_key");
    await handleVault(req("vault", { service: "resend", value: "re_madeUpKey12345" }, asOwner), [], deps());
    assert.equal((await read(await handleSend(req("send", { ...email, approval: confirmation.id }, asOwner), deps()))).status, "sent", "the approval wasn't spent by the missing key");
    counters.set("sends-day:p1:live", 10);
    const { confirmation: next } = (await read(await handleSend(req("send", email, asOwner), deps()))) as unknown as { confirmation: { id: string } };
    assert.equal((await handleSend(req("send", { ...email, approval: next.id }, asOwner), deps())).status, 429);
  });

  it("shows the whole message on the card, uncut, with invisible and reordering characters marked", async () => {
    const long = `${"Rain until noon. ".repeat(586)}HIDDEN TAIL ‮evil​ end`;
    assert.ok(long.length > 9_950 && long.length <= 10_000, String(long.length));
    const first = await read(await handleSend(req("send", { ...email, subject: "Plan‮ for Saturday", body: long }, asOwner), deps()));
    const { lines } = first.confirmation as { lines: string[] };
    const message = lines.find((l) => l.startsWith("Message: "))!;
    assert.ok(message.includes("HIDDEN TAIL"), "the end of a long message is on the card");
    assert.equal(message.length, "Message: ".length + long.replace(/\s+/g, " ").trim().length);
    assert.ok(message.includes("�evil� end"), "U+202E and U+200B show as �");
    assert.ok(!lines.join("\n").match(/[‮​]/), "nothing invisible reaches the card");
    assert.equal(lines.find((l) => l.startsWith("Subject: ")), "Subject: Plan� for Saturday");
    const blank = await read(await handleSend(req("send", { ...email, body: "Hi\n\n\n\nTo: someone@else.example" }, asOwner), deps()));
    assert.equal((blank.confirmation as { lines: string[] }).lines.at(-1), "Message: Hi To: someone@else.example", "a line break can't start a line that looks like a field");
  });

  it("doesn't spend the owner's confirmation when the day's limit stops it", async () => {
    counters.set("sends-day:p1:live", 10);
    const { confirmation } = (await read(await handleSend(req("send", email, asOwner), deps()))) as unknown as { confirmation: { id: string } };
    assert.equal((await handleSend(req("send", { ...email, approval: confirmation.id }, asOwner), deps())).status, 429);
    counters.set("sends-day:p1:live", 0);
    const sent = await read(await handleSend(req("send", { ...email, approval: confirmation.id }, asOwner), deps()));
    assert.equal(sent.status, "sent", "the same confirmation still sends once the limit resets");
    assert.equal(counters.get("sends-day:p1:live"), 1);
    const replay = await read(await handleSend(req("send", { ...email, approval: confirmation.id }, asOwner), deps()));
    assert.equal(replay.stale, true);
    assert.equal(counters.get("sends-day:p1:live"), 1, "a spent approval gives its day slot back");
    assert.equal(outgoing.length, 1);
  });

  it("in a build, shows the same confirmation, then records a simulated send that goes nowhere", async () => {
    const t = buildToken();
    const ownerHeader = { "x-musemuse-owner": BUILD_TEST_OWNER, ...asVisitor };
    const first = await read(await handleSend(req("send", { channel: "chat", body: "Team: hike at 1." }, ownerHeader), deps({ token: t })));
    assert.equal(first.code, "needs_confirmation");
    const sent = await read(await handleSend(req("send", { channel: "chat", body: "Team: hike at 1.", approval: (first.confirmation as { id: string }).id }, ownerHeader), deps({ token: t })));
    assert.equal(sent.simulated, true);
    assert.match(String(sent.id), /^sim_/);
    assert.equal(outgoing.length, 0);
    assert.equal(store.sends[0]!.status, "simulated");
    assert.equal(store.sends[0]!.namespace, `b:${BUILD}`);
  });

  it("posts a chat message to the owner's webhook and nowhere else", async () => {
    await handleVault(req("vault", { service: "slack_webhook", value: "https://hooks.slack.com/services/T0/B0/madeup" }, asOwner), [], deps());
    reply = () => new Response("ok");
    const { confirmation } = (await read(await handleSend(req("send", { channel: "chat", body: "Hike at 1." }, asOwner), deps()))) as unknown as { confirmation: { id: string; lines: string[] } };
    assert.match(confirmation.lines[0]!, /Slack channel/);
    const sent = await read(await handleSend(req("send", { channel: "chat", body: "Hike at 1.", approval: confirmation.id }, asOwner), deps()));
    assert.equal(sent.status, "sent");
    assert.equal(outgoing.at(-1)!.url, "https://hooks.slack.com/services/T0/B0/madeup");
    assert.deepEqual(JSON.parse(outgoing.at(-1)!.body!), { text: "Hike at 1." });
  });
});

describe("what a live product may reach", () => {
  it("is the shipped brief, narrowed by its manifest and never widened", () => {
    assert.deepEqual(narrowConnect(RULES, null), RULES);
    const narrowed = narrowConnect(RULES, { connect: { publicApis: ["nws", "usgs"], keys: ["github", "airtable"], sends: [] } })!;
    assert.deepEqual(narrowed.publicApis, ["nws"]);
    assert.deepEqual(narrowed.keys.map((k) => k.service), ["github"]);
    assert.deepEqual(narrowed.sends, []);
    assert.equal(narrowConnect(null, { connect: { publicApis: ["nws"] } }), null);
  });
});
