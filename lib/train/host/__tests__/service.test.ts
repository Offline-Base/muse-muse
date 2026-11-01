/** Starting, stopping, the sweep and the gateway, on fakes. npx tsx --test lib/train/host/__tests__/service.test.ts */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { handleHostedChat, type HostedGatewayDeps } from "@/lib/train/host/gateway";
import { chatOnEndpoint, deployEndpoint, stopEndpoint, sweepEndpoints, type NewEndpoint } from "@/lib/train/host/service";
import { HostError, type HostAdapter, type HostEndpoint } from "@/lib/train/host/types";
import { hostView } from "@/lib/train/host/view";
import { facts, ID, JOB, row } from "@/lib/train/host/__tests__/helpers";

const NOW = new Date("2026-11-03T12:00:00Z");
const LIMITS = { dailyUsd: 25, maxLive: 2, idleMinutes: 15, maxMinutes: 240 };

let rows: HostEndpoint[];
let settled: { id: string; costUsd: number | null }[];
let reserved: number[];
let stops: string[];
let deployThrows: Error | null;
let stopResult: () => Promise<{ done: boolean; costUsd?: number }>;
let usage: unknown[];

const adapter = (over: Partial<HostAdapter> = {}): HostAdapter => ({
  id: "modal",
  label: "Modal",
  missingKeys: () => [],
  cantServe: () => null,
  price: () => ({ hourlyUsd: 4, gpu: "H100" }),
  deploy: async () => {
    if (deployThrows) throw deployThrows;
    return { url: "https://secret-host.modal.run" };
  },
  status: async () => "ready",
  stop: async (_r, name) => {
    stops.push(name);
    return stopResult();
  },
  inferenceUrl: (r) => r.url ?? null,
  chat: async () => ({ text: "answer", finish: "stop", usage: { input: 3, output: 4 } }),
  ...over,
});

function deps(over: Partial<HostedGatewayDeps> = {}, a: HostAdapter = adapter()): HostedGatewayDeps {
  return {
    on: () => true,
    limits: () => LIMITS,
    platformCapUsd: () => 100,
    platformSpend: async () => 0,
    adapter: () => a,
    adapters: () => [a],
    rows: async () => rows,
    insert: async (r: NewEndpoint) => {
      const saved = row({ ...r, status: "starting", ref: null, readyAt: null, lastUsedAt: null });
      rows.push(saved);
      return saved;
    },
    patch: async (id, patch) => {
      rows = rows.map((e) => (e.id === id ? { ...e, ...patch } : e));
    },
    touch: async (id, now) => {
      rows = rows.map((e) => (e.id === id ? { ...e, lastUsedAt: now } : e));
    },
    takeDeployLock: async () => true,
    reserveSpend: async (_c, _m, usd) => {
      reserved.push(usd);
      return "res";
    },
    settleSpend: async (id, item) => {
      settled.push({ id, costUsd: item?.costUsd ?? null });
    },
    hashToken: (raw) => `hash:${raw}`,
    newId: () => ID,
    byOwnerTokenHash: async (h) => rows.find((e) => e.ownerTokenHash === h) ?? null,
    byModel: async (m) => rows.find((e) => e.adapterJobId === m) ?? null,
    findToken: async (raw) => (raw === "product-token" ? { id: "t1", productId: "p1", scope: "live", allowedModels: [], dailyBudgetUsd: 1, buildId: null } : raw === "build-token" ? { id: "t2", productId: "p1", scope: "build", allowedModels: [], dailyBudgetUsd: 1, buildId: "b" } : null),
    product: async () => ({ status: "live" }) as never,
    productOwnsModel: async () => true,
    hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, 1])),
    recordUsage: async (_c, items) => void usage.push(...items),
    now: () => NOW,
    ...over,
  };
}

beforeEach(() => {
  rows = [];
  settled = [];
  reserved = [];
  stops = [];
  deployThrows = null;
  stopResult = async () => ({ done: true });
  usage = [];
});

const input = () => ({ provider: "modal" as const, facts: facts(), callerId: "u1" });
const code = (c: string) => (e: HostError) => e.code === c;

describe("deployEndpoint", () => {
  it("reserves before starting, and hands back a token it keeps only as a hash", async () => {
    const got = await deployEndpoint(input(), deps(), NOW);
    assert.deepEqual(reserved, [16]);
    assert.match(got.ownerToken, /^mmh_/);
    assert.equal(rows[0]!.ownerTokenHash, `hash:${got.ownerToken}`);
    assert.equal(rows[0]!.stopsAt.getTime(), NOW.getTime() + 240 * 60_000);
    assert.equal(rows[0]!.ref?.url, "https://secret-host.modal.run");
  });
  it("refuses a model that hasn't passed, an unset key, and a base it can't serve, before any spend", async () => {
    await assert.rejects(deployEndpoint({ ...input(), facts: facts({ problem: "It didn't pass." }) }, deps(), NOW), code("cant_host"));
    await assert.rejects(deployEndpoint(input(), deps({}, adapter({ missingKeys: () => ["MODAL_TOKEN_ID"] })), NOW), (e: HostError) => /MODAL_TOKEN_ID/.test(e.message));
    await assert.rejects(deployEndpoint(input(), deps({}, adapter({ cantServe: () => "No." })), NOW), code("provider_unavailable"));
    assert.deepEqual(reserved, []);
  });
  it("allows one per model and the live limit, and a stopping one still counts", async () => {
    rows = [row({ status: "stopping" })];
    await assert.rejects(deployEndpoint(input(), deps(), NOW), code("already_hosted"));
    rows = [row({ adapterJobId: "x1", slot: 1 }), row({ adapterJobId: "x2", slot: 2, status: "stopping" })];
    await assert.rejects(deployEndpoint(input(), deps(), NOW), code("too_many_live"));
  });
  it("refuses when the budget is held, and when the budget is 0", async () => {
    rows = [row({ adapterJobId: "x", reservedUsd: 24, hourlyUsd: 4 })];
    await assert.rejects(deployEndpoint(input(), deps(), NOW), code("budget_exceeded"));
    await assert.rejects(deployEndpoint(input(), deps({ limits: () => ({ ...LIMITS, dailyUsd: 0 }) }), NOW), code("hosting_paused"));
  });
  it("gives the place back when a race lost it", async () => {
    await assert.rejects(deployEndpoint(input(), deps({ insert: async () => null }), NOW), code("already_hosted"));
    assert.deepEqual(settled, [{ id: "res", costUsd: null }]);
  });
  it("stops by name after a failed deploy, and says nothing of the provider's words", async () => {
    deployThrows = new Error("boom at https://secret-host");
    await assert.rejects(deployEndpoint(input(), deps(), NOW), (e: HostError) => e.code === "deploy_failed" && !/secret/.test(e.message));
    assert.equal(stops.length, 1);
    assert.equal(rows[0]!.status, "failed");
  });
  it("backs out, spending nothing, when a racing start took the money", async () => {
    let inserted = false;
    const racing = deps({ insert: async (r: NewEndpoint) => { inserted = true; const saved = row({ ...r, status: "starting", ref: null, readyAt: null, lastUsedAt: null }); rows.push(saved, row({ id: "other", adapterJobId: "other", name: "mm-host-other", slot: 2, reservedUsd: 20, status: "starting", createdAt: NOW })); return saved; } });
    let deployed = false;
    const a = adapter({ deploy: async () => { deployed = true; return {}; } });
    await assert.rejects(deployEndpoint(input(), { ...racing, adapter: () => a }, NOW), code("budget_exceeded"));
    assert.ok(inserted);
    assert.equal(deployed, false);
    assert.deepEqual(settled, [{ id: "res", costUsd: null }]);
    assert.equal(rows.find((e) => e.id === ID)?.status, "failed");
  });
  it("stops what it just made when a stop came while it was deploying, holding the money until then", async () => {
    const a = adapter({
      deploy: async (d) => {
        const during = rows.find((e) => e.id === d.endpointId)!;
        const held = await stopEndpoint(during, "person", deps(), NOW);
        assert.equal(held.status, "stopping");
        assert.deepEqual(stops, [], "no stop by name while the deploy may still be making it");
        assert.deepEqual(settled, []);
        return { url: "https://secret-host.modal.run" };
      },
    });
    await assert.rejects(deployEndpoint(input(), deps({}, a), NOW), code("stopped_while_starting"));
    assert.equal(stops.length, 1);
    assert.equal(settled.length, 1);
    assert.equal(rows[0]!.status, "stopped");
    assert.equal(rows[0]!.stopReason, "person");
  });
  it("in the sweep, stops a row whose deploy died, by name", async () => {
    rows = [row({ status: "starting", ref: null, readyAt: null, createdAt: new Date(NOW.getTime() - 7 * 60_000) })];
    await sweepEndpoints(deps(), NOW);
    assert.equal(stops.length, 1);
    assert.equal(rows[0]!.status, "failed");
  });
  it("in the sweep, leaves a deploy still inside its window alone", async () => {
    rows = [row({ status: "starting", ref: null, readyAt: null, createdAt: new Date(NOW.getTime() - 2 * 60_000) })];
    await sweepEndpoints(deps(), NOW);
    assert.deepEqual(stops, []);
    assert.equal(rows[0]!.status, "starting");
  });
  it("doesn't take a deploy that began during the sweep for an orphan", async () => {
    const a = adapter({
      listOwned: async () => {
        rows.push(row({ name: "mm-host-new", status: "starting", ref: null, readyAt: null, createdAt: NOW }));
        return ["mm-host-new"];
      },
    });
    const got = await sweepEndpoints(deps({}, a), NOW);
    assert.deepEqual(got.orphans, []);
    assert.deepEqual(stops, []);
  });
  it("goes on to the next orphan when one can't be stopped", async () => {
    const a = adapter({ listOwned: async () => ["mm-host-a", "mm-host-b"], stop: async (_r, name) => { if (name === "mm-host-a") throw new Error("no"); return { done: true }; } });
    const got = await sweepEndpoints(deps({}, a), NOW);
    assert.deepEqual(got.orphans, ["mm-host-b"]);
    assert.equal(got.errors.length, 1);
  });
  it("carries Llama's license line onto the API's replies", async () => {
    const { endpoint } = await deployEndpoint({ ...input(), facts: facts({ family: "llama3", sparkOpen: false, duties: { family: "llama3", line: "Built with Llama", namePrefix: "Llama-", license: "The Llama 3.2 Community License and its Acceptable Use Policy apply.", points: [] } }) }, deps(), NOW);
    assert.equal(endpoint.ref?.note, "Built with Llama. The Llama 3.2 Community License and its Acceptable Use Policy apply.");
  });
  it("keeps the money held and stays stopping when that stop fails", async () => {
    deployThrows = new Error("boom");
    stopResult = async () => {
      throw new Error("unreachable");
    };
    await assert.rejects(deployEndpoint(input(), deps(), NOW));
    assert.equal(rows[0]!.status, "stopping");
    assert.deepEqual(settled, []);
  });
});

describe("stopEndpoint", () => {
  it("settles at the clock's rate when the provider gives no cost", async () => {
    rows = [row()];
    const done = await stopEndpoint(rows[0]!, "person", deps(), NOW);
    assert.equal(done.status, "stopped");
    assert.deepEqual(settled, [{ id: "r1", costUsd: 2 }]);
  });
  it("settles at the provider's cost when it says", async () => {
    stopResult = async () => ({ done: true, costUsd: 1.25 });
    rows = [row()];
    await stopEndpoint(rows[0]!, "person", deps(), NOW);
    assert.deepEqual(settled, [{ id: "r1", costUsd: 1.25 }]);
  });
  it("stays stopping until the provider is done", async () => {
    stopResult = async () => ({ done: false });
    rows = [row()];
    assert.equal((await stopEndpoint(rows[0]!, "idle", deps(), NOW)).status, "stopping");
    assert.deepEqual(settled, []);
    assert.equal(rows[0]!.stopReason, "idle");
  });
});

describe("sweepEndpoints", () => {
  const idle = () => row({ readyAt: new Date(NOW.getTime() - 20 * 60_000) });
  it("stops an idle endpoint and leaves a used one", async () => {
    rows = [idle(), row({ id: "fresh", adapterJobId: "x", readyAt: NOW, slot: 2 })];
    const got = await sweepEndpoints(deps(), NOW);
    assert.deepEqual(got.stopped, [ID]);
    assert.equal(rows.find((e) => e.id === "fresh")!.status, "live");
  });
  it("stops everything at the daily cap and with the flag off", async () => {
    rows = [row({ hourlyUsd: 100, readyAt: NOW })];
    assert.deepEqual((await sweepEndpoints(deps(), NOW)).stopped, [ID]);
    rows = [row({ readyAt: NOW })];
    assert.deepEqual((await sweepEndpoints(deps({ on: () => false }), NOW)).stopped, [ID]);
  });
  it("stops the newest past a lowered limit", async () => {
    rows = [row({ id: "old", readyAt: NOW, createdAt: new Date(NOW.getTime() - 60 * 60_000) }), row({ id: "new", adapterJobId: "x", slot: 2, readyAt: NOW, createdAt: new Date(NOW.getTime() - 30 * 60_000) })];
    assert.deepEqual((await sweepEndpoints(deps({ limits: () => ({ ...LIMITS, maxLive: 1 }) }), NOW)).stopped, ["new"]);
  });
  it("retries a stopping endpoint", async () => {
    rows = [row({ status: "stopping", stopReason: "idle" })];
    await sweepEndpoints(deps(), NOW);
    assert.equal(rows[0]!.status, "stopped");
    assert.equal(rows[0]!.stopReason, "idle");
  });
  it("marks one it can't stop as stopping, so it gets no traffic, and reports it", async () => {
    stopResult = async () => {
      throw new Error("provider down");
    };
    rows = [idle()];
    const got = await sweepEndpoints(deps(), NOW);
    assert.equal(rows[0]!.status, "stopping");
    assert.equal(got.errors.length, 1);
  });
  it("stops anything a provider holds with no open row", async () => {
    rows = [row({ readyAt: NOW, name: "mm-host-known" })];
    const a = adapter({ listOwned: async () => ["mm-host-known", "mm-host-orphan"] });
    const got = await sweepEndpoints(deps({}, a), NOW);
    assert.deepEqual(got.orphans, ["mm-host-orphan"]);
    assert.deepEqual(stops, ["mm-host-orphan"]);
  });
  it("with the rows unreadable, stops everything the provider holds", async () => {
    const a = adapter({ listOwned: async () => ["mm-host-1", "mm-host-2"] });
    const got = await sweepEndpoints(deps({ rows: async () => { throw new Error("db down"); } }, a), NOW);
    assert.deepEqual(got.orphans, ["mm-host-1", "mm-host-2"]);
    assert.equal(got.errors.length, 1);
  });
});

describe("chatOnEndpoint", () => {
  const ask = { messages: [{ role: "user" as const, content: "hi" }], stop: [] };
  it("answers and resets the idle clock", async () => {
    rows = [row()];
    assert.equal((await chatOnEndpoint(rows[0]!, ask, deps(), NOW)).text, "answer");
    assert.equal(rows[0]!.lastUsedAt, NOW);
  });
  it("refuses past a limit and stops it, without calling the model", async () => {
    let called = false;
    rows = [row({ stopsAt: NOW })];
    await assert.rejects(chatOnEndpoint(rows[0]!, ask, deps({}, adapter({ chat: async () => ((called = true), { text: "", finish: "stop", usage: { input: 0, output: 0 } }) })), NOW), code("endpoint_closed"));
    assert.equal(called, false);
    assert.equal(rows[0]!.status, "stopped");
  });
  it("at the daily cap refuses clearly and stops the others too", async () => {
    rows = [row({ hourlyUsd: 100 }), row({ id: "other", adapterJobId: "x", slot: 2, hourlyUsd: 1 })];
    await assert.rejects(chatOnEndpoint(rows[0]!, ask, deps(), NOW), code("budget_exceeded"));
    assert.deepEqual(rows.map((e) => e.status), ["stopped", "stopped"]);
  });
  it("says it's starting, then goes live when the provider is ready", async () => {
    rows = [row({ status: "starting", readyAt: null })];
    await assert.rejects(chatOnEndpoint(rows[0]!, ask, deps({}, adapter({ status: async () => "starting" })), NOW), code("endpoint_starting"));
    assert.equal((await chatOnEndpoint(rows[0]!, ask, deps(), NOW)).text, "answer");
    assert.equal(rows[0]!.status, "live");
  });
  it("refuses a stopping endpoint", async () => {
    rows = [row({ status: "stopping" })];
    await assert.rejects(chatOnEndpoint(rows[0]!, ask, deps(), NOW), code("endpoint_closed"));
  });
});

describe("handleHostedChat", () => {
  const post = (token: string | null, body: unknown) =>
    new Request("https://x/api/gateway/hosted/v1/chat/completions", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });
  const body = (over: object = {}) => ({ model: JOB, messages: [{ role: "user", content: "hi" }], ...over });
  beforeEach(() => {
    rows = [row({ ownerTokenHash: "hash:mmh_good" })];
  });
  it("is 404 with the flag off, reading nothing", async () => {
    const res = await handleHostedChat(post("mmh_good", body()), deps({ on: () => false, byOwnerTokenHash: async () => { throw new Error("read"); } }));
    assert.equal(res.status, 404);
  });
  it("needs a real token", async () => {
    assert.equal((await handleHostedChat(post(null, body()), deps())).status, 401);
    assert.equal((await handleHostedChat(post("mmh_bad", body()), deps())).status, 401);
    assert.equal((await handleHostedChat(post("nope", body()), deps())).status, 401);
  });
  it("answers an owner token in OpenAI's shape, with the duties line, and meters it", async () => {
    const res = await handleHostedChat(post("mmh_good", body()), deps());
    assert.equal(res.status, 200);
    const got = (await res.json()) as { choices: { message: { content: string } }[]; note: string; usage: { total_tokens: number } };
    assert.equal(got.choices[0]!.message.content, "answer");
    assert.match(got.note, /Built with Muse Spark Open/);
    assert.equal(got.usage.total_tokens, 7);
    assert.deepEqual(usage, [{ model: "hosted-modal", inputTokens: 3, cachedInputTokens: 0, outputTokens: 4, units: 1, costUsd: 0 }]);
    assert.ok(!JSON.stringify(got).includes("secret-host"));
  });
  it("refuses an owner token for another model", async () => {
    assert.equal((await handleHostedChat(post("mmh_good", body({ model: "other" })), deps())).status, 400);
  });
  it("takes a live product token whose product owns the model, not a build's, nor another product's", async () => {
    assert.equal((await handleHostedChat(post("product-token", body()), deps())).status, 200);
    assert.equal((await handleHostedChat(post("build-token", body()), deps())).status, 403);
    assert.equal((await handleHostedChat(post("product-token", body()), deps({ productOwnsModel: async () => false }))).status, 403);
  });
  it("refuses streaming and unknown keys", async () => {
    assert.equal((await handleHostedChat(post("mmh_good", body({ stream: true })), deps())).status, 400);
    assert.equal((await handleHostedChat(post("mmh_good", body({ tools: [] })), deps())).status, 400);
  });
  it("holds to the rate limit, and sends the retry time while waking", async () => {
    const limited = deps({ hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, 9999])) });
    assert.equal((await handleHostedChat(post("mmh_good", body()), limited)).status, 429);
    const waking = deps({}, adapter({ chat: async () => { throw new HostError(503, "endpoint_waking", "Waking.", 30); } }));
    const res = await handleHostedChat(post("mmh_good", body()), waking);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "30");
  });
});

describe("hostView", () => {
  it("shows why a provider is unavailable, and never an address, ref or token hash", () => {
    const a = adapter();
    const unset = adapter({ id: "baseten", label: "Baseten", missingKeys: () => ["BASETEN_API_KEY"] });
    const base = adapter({ id: "fireworks", label: "Fireworks", cantServe: () => "Wrong base." });
    const view = hostView(facts(), [a, unset, base], [row({ ownerTokenHash: "hash-value" })], LIMITS, NOW);
    assert.deepEqual(view.choices.map((c) => c.available), [true, false, false]);
    assert.match(view.choices[1]!.reason!, /BASETEN_API_KEY/);
    assert.equal(view.choices[2]!.reason, "Wrong base.");
    assert.equal(view.endpoint?.status, "live");
    const text = JSON.stringify(view);
    for (const secret of ["secret-host", "hash-value", "mm-host-", "endpointId"]) assert.ok(!text.includes(secret), secret);
    assert.match(text, /Built with Muse Spark Open/);
  });
  it("marks every choice unavailable for a model that hasn't passed", () => {
    const view = hostView(facts({ problem: "It didn't pass." }), [adapter()], [], LIMITS, NOW);
    assert.equal(view.choices[0]!.available, false);
    assert.equal(view.choices[0]!.reason, "It didn't pass.");
  });
});
