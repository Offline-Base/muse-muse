/**
 * {GATEWAY_URL}/fleet/v1/chat/completions (docs/CAPABILITIES.md, 17b): the flag, the settings, who may ask, the request, a
 * build's simulated reply, the limits, metering, and every way a live call ends, on fakes. No board, no database, no network.
 *
 *   npx tsx --test lib/caps/fleet/__tests__/handler.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FLEET_ENDPOINT, FLEET_LIMITS, FLEET_SIMULATED_REPLY, FLEET_TIMEOUT_MS, handleFleetChat, type FleetDeps } from "@/lib/caps/fleet/handler";
import { FLEET_CANNED_USAGE, FLEET_MARKER } from "@/lib/caps/fleet/marker";
import { fleetSettings } from "@/lib/caps/fleet/settings";

const NOW = new Date("2026-11-03T15:00:00Z");
const ADDRESS = "https://fleet.example/admin";
const KEY = "jik_madeup";
const MODEL = "made-up-board-model";
const SETTINGS = { FLEET_PRODUCTS_URL: ADDRESS, FLEET_PRODUCTS_KEY: KEY, FLEET_PRODUCTS_MODEL: MODEL };

let sent: Array<{ url: string; init: RequestInit; body: Record<string, unknown>; headers: Headers }>;
let usage: Array<{ source: string; endpoint: string; model: string; units?: number; costUsd: number; buildId?: string | null }>;
let counts: Record<string, number>;
let slots: Record<string, number>;
let logged: string[];
const realError = console.error;

const fleetJson = (json: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" }, ...init });
const ANSWER = { id: "fleet-id", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: "A real answer." }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 7 } };

function deps(over: Partial<FleetDeps> = {}, answer: () => Response | Promise<Response> = () => fleetJson(ANSWER)): FleetDeps {
  return {
    on: () => true,
    allProducts: () => false,
    settings: () => fleetSettings(SETTINGS),
    adminEmails: ["admin@example.com"],
    findToken: async () => ({ id: "t1", productId: "p1", scope: "live", allowedModels: [FLEET_MARKER], dailyBudgetUsd: 1, buildId: null }),
    product: async () => ({ status: "live", manifest: null, liveUrl: null, takenDownAt: null, ownerId: "u1", ownerEmail: "admin@example.com", ownerIsAdmin: true, ownerBannedAt: null }),
    hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, (counts[k] = (counts[k] ?? 0) + 1)])),
    acquireInFlight: async (key, limit) => {
      if ((slots[key] ?? 0) >= limit) return null;
      slots[key] = (slots[key] ?? 0) + 1;
      return NOW;
    },
    releaseInFlight: async (key) => {
      slots[key] = (slots[key] ?? 0) - 1;
    },
    recordUsage: async (ctx, items) => {
      for (const i of items) usage.push({ source: ctx.source, endpoint: ctx.endpoint, model: i.model, units: i.units, costUsd: i.costUsd, buildId: ctx.buildId });
    },
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), init, body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: new Headers(init.headers) });
      return answer();
    }) as typeof fetch,
    now: () => NOW,
    ...over,
  };
}

const HI = { messages: [{ role: "user", content: "hi" }] };
const call = (body: unknown = HI, headers: Record<string, string> = {}, method = "POST") =>
  new Request(`https://platform.example/api/gateway${FLEET_ENDPOINT}`, {
    method,
    headers: { authorization: "Bearer mm_live_x", ...headers },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });

const code = async (res: Response) => ((await res.clone().json()) as { error: { code: string } }).error.code;
const buildToken = async () => ({ id: "t2", productId: "p1", scope: "build", allowedModels: [FLEET_MARKER], dailyBudgetUsd: 1, buildId: "b1" });
const builder = async () => ({ status: "live" as const, manifest: null, liveUrl: null, takenDownAt: null, ownerId: "u", ownerEmail: "someone@example.com", ownerIsAdmin: false, ownerBannedAt: null });

beforeEach(() => {
  sent = [];
  usage = [];
  counts = {};
  slots = {};
  logged = [];
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
});
afterEach(() => {
  console.error = realError;
});

describe("the flag and the settings", () => {
  it("is 404 unknown_endpoint with the flag off, and nothing is touched", async () => {
    const boom = () => {
      throw new Error("touched");
    };
    const res = await handleFleetChat(call(), deps({ on: () => false, findToken: boom, product: boom, hitRateLimits: boom, settings: boom, fetch: boom as unknown as typeof fetch }));
    assert.equal(res.status, 404);
    assert.equal(await code(res), "unknown_endpoint");
    assert.equal(sent.length, 0);
  });

  for (const missing of ["FLEET_PRODUCTS_URL", "FLEET_PRODUCTS_KEY", "FLEET_PRODUCTS_MODEL"] as const) {
    it(`answers 503 fleet_closed without ${missing}, and never calls the fleet`, async () => {
      const res = await handleFleetChat(call(), deps({ settings: () => fleetSettings({ ...SETTINGS, [missing]: undefined }) }));
      assert.equal(res.status, 503);
      assert.equal(await code(res), "fleet_closed");
      assert.equal(sent.length, 0);
      assert.equal(counts["fleet:product:p1"] ?? 0, 0, "a closed fleet costs a product none of its day");
    });
  }

  it("refuses an admin's jpt_ token, or anything but a jik_ key", async () => {
    for (const key of ["jpt_madeup", " jpt_madeup ", "JPT_madeup", "madeup", "jik_", "jik_two words"]) {
      assert.equal(fleetSettings({ ...SETTINGS, FLEET_PRODUCTS_KEY: key }), null, key);
      const res = await handleFleetChat(call(), deps({ settings: () => fleetSettings({ ...SETTINGS, FLEET_PRODUCTS_KEY: key }) }));
      assert.equal(await code(res), "fleet_closed", key);
    }
    assert.equal(sent.length, 0);
  });

  it("refuses a combo/ model in any case, since it can reach the cloud", async () => {
    for (const model of ["combo/gemma-gemini", " combo/x", "COMBO/x", "Combo/x"]) {
      assert.equal(fleetSettings({ ...SETTINGS, FLEET_PRODUCTS_MODEL: model }), null, model);
      const res = await handleFleetChat(call(), deps({ settings: () => fleetSettings({ ...SETTINGS, FLEET_PRODUCTS_MODEL: model }) }));
      assert.equal(await code(res), "fleet_closed", model);
    }
    assert.equal(sent.length, 0);
  });

  it("refuses an Ollama cloud tag in any case, since a board's Ollama forwards it to ollama.com", async () => {
    for (const model of ["gpt-oss:120b-cloud", "qwen3-coder:480b-cloud", "glm-4.6:cloud", "GPT-OSS:20B-CLOUD", " minimax-m2:Cloud "]) {
      assert.equal(fleetSettings({ ...SETTINGS, FLEET_PRODUCTS_MODEL: model }), null, model);
      const res = await handleFleetChat(call(), deps({ settings: () => fleetSettings({ ...SETTINGS, FLEET_PRODUCTS_MODEL: model }) }));
      assert.equal(await code(res), "fleet_closed", model);
    }
    assert.equal(sent.length, 0);
    for (const model of ["gemma3:4b", "llama3.2:3b-instruct-q4_K_M", "cloudy:1b"]) assert.equal(fleetSettings({ ...SETTINGS, FLEET_PRODUCTS_MODEL: model })?.model, model, model);
  });

  it("wants https, with /admin, and no credentials or query in the address", () => {
    for (const url of ["http://fleet.example/admin", "https://fleet.example", "https://fleet.example/other", "https://u:p@fleet.example/admin", "https://fleet.example/admin?x=1", "not a url", ""]) {
      assert.equal(fleetSettings({ ...SETTINGS, FLEET_PRODUCTS_URL: url }), null, url);
    }
    assert.equal(fleetSettings({ ...SETTINGS, FLEET_PRODUCTS_URL: "https://fleet.example/admin/" })?.url, ADDRESS);
  });

  it("has no default model of its own", () => {
    assert.equal(fleetSettings({ FLEET_PRODUCTS_URL: ADDRESS, FLEET_PRODUCTS_KEY: KEY }), null);
  });
});

describe("who may ask", () => {
  it("refuses no token, a disabled product and a token without the marker", async () => {
    assert.equal((await handleFleetChat(call(), deps({ findToken: async () => null }))).status, 401);
    const off = await handleFleetChat(call(), deps({ product: async () => ({ ...(await builder()), status: "disabled" }) }));
    assert.equal(await code(off), "product_disabled");
    const res = await handleFleetChat(call(), deps({ findToken: async () => ({ id: "t", productId: "p", scope: "live", allowedModels: ["muse-wonder-1.0"], dailyBudgetUsd: 1, buildId: null }) }));
    assert.equal(res.status, 403);
    assert.equal(await code(res), "fleet_not_allowed");
    assert.equal(sent.length, 0);
  });

  it("keeps live answers to admins' products until FLEET_ALL_PRODUCTS, and never serves the guest's", async () => {
    assert.equal(await code(await handleFleetChat(call(), deps({ product: builder }))), "fleet_not_allowed");
    assert.equal((await handleFleetChat(call(), deps({ product: builder, allProducts: () => true }))).status, 200);
    const { GUEST_EMAIL } = await import("@/lib/auth");
    const guest = async () => ({ ...(await builder()), ownerEmail: GUEST_EMAIL });
    assert.equal(await code(await handleFleetChat(call(), deps({ product: guest, allProducts: () => true }))), "sign_in_required");
  });

  it("doesn't trust an admin flag for an email that isn't an admin's", async () => {
    const res = await handleFleetChat(call(), deps({ product: async () => ({ ...(await builder()), ownerEmail: "was-admin@example.com", ownerIsAdmin: true }) }));
    assert.equal(await code(res), "fleet_not_allowed");
  });

  it("answers GET with a 405 once the flag is on", async () => {
    assert.equal((await handleFleetChat(call(undefined, {}, "GET"), deps())).status, 405);
  });
});

describe("the request", () => {
  const user = (extra: Record<string, unknown>) => ({ messages: [{ role: "user", ...extra }] });
  for (const [what, body, want] of [
    ["an image part", user({ content: [{ type: "image_url", image_url: { url: "data:image/png;base64,x" } }] }), "text_only"],
    ["an audio part", user({ content: [{ type: "input_audio", input_audio: { data: "x", format: "wav" } }] }), "text_only"],
    ["a text part beside an image", user({ content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "x" } }] }), "text_only"],
    ["an images field, which a board's server would read", user({ content: "hi", images: ["x"] }), "text_only"],
    ["an audio field", user({ content: "hi", audio: { id: "x" } }), "text_only"],
    ["a body that isn't JSON", "{nope", "invalid_body"],
    ["an unknown key", { ...HI, tools: [] }, "invalid_arguments"],
    ["streaming", { ...HI, stream: true }, "invalid_arguments"],
    ["the caller picking a model", { ...HI, model: "combo/gemma-gemini" }, "invalid_model"],
    ["the caller picking a plain model", { ...HI, model: MODEL }, "invalid_model"],
    ["no messages", {}, "invalid_arguments"],
    ["a last message that isn't the user's", { messages: [{ role: "assistant", content: "hi" }] }, "invalid_arguments"],
    ["bad max_tokens", { ...HI, max_tokens: 0 }, "invalid_arguments"],
    ["too many characters", user({ content: "x".repeat(FLEET_LIMITS.chars + 1) }), "too_long"],
    ["too many characters across messages", { messages: [{ role: "system", content: "x".repeat(FLEET_LIMITS.chars) }, { role: "user", content: "hi" }] }, "too_long"],
  ] as const) {
    it(`refuses ${what} with a 400, for a build and for a live token`, async () => {
      for (const d of [deps(), deps({ findToken: buildToken })]) {
        const res = await handleFleetChat(call(body), d);
        assert.equal(res.status, 400);
        assert.equal(await code(res), want);
      }
      assert.equal(sent.length, 0);
    });
  }

  it("refuses a body too big to read", async () => {
    assert.equal((await handleFleetChat(call({ messages: [{ role: "user", content: "x".repeat(FLEET_LIMITS.bodyBytes) }] }), deps())).status, 413);
  });

  it("takes exactly the characters allowed", async () => {
    assert.equal((await handleFleetChat(call({ messages: [{ role: "user", content: "x".repeat(FLEET_LIMITS.chars) }] }), deps())).status, 200);
  });

  it("sends only the server's model, the text and a cap, whole, on a board, with no redirects and a timeout under the route's limit", async () => {
    const res = await handleFleetChat(call({ model: "jetson-fleet", messages: [{ role: "user", content: "hi" }], max_tokens: 50_000 }), deps());
    assert.equal(res.status, 200);
    const { url, init, body, headers } = sent[0]!;
    assert.equal(url, `${ADDRESS}/v1/chat/completions`);
    assert.deepEqual(body, { model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: FLEET_LIMITS.maxTokens, stream: false });
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(headers.get("x-jcp-route"), "local");
    const route = await import("@/app/api/gateway/fleet/v1/chat/completions/route");
    assert.ok(FLEET_TIMEOUT_MS < route.maxDuration * 1000);
  });

  it("caps max_tokens when it's left out, and keeps a smaller one", async () => {
    await handleFleetChat(call(), deps());
    assert.equal(sent[0]!.body.max_tokens, FLEET_LIMITS.maxTokens);
    await handleFleetChat(call({ ...HI, max_completion_tokens: 20 }), deps());
    assert.equal(sent[1]!.body.max_tokens, 20);
  });
});

describe("a build token", () => {
  it("gets a labeled simulated reply, and never reaches the fleet", async () => {
    const boom = (() => {
      throw new Error("touched the fleet");
    }) as unknown as typeof fetch;
    const res = await handleFleetChat(call(), deps({ findToken: buildToken, fetch: boom }));
    const body = (await res.json()) as { simulated: boolean; object: string; model: string; choices: Array<{ message: { content: string } }> };
    assert.equal(res.status, 200);
    assert.equal(body.simulated, true);
    assert.equal(body.object, "chat.completion");
    assert.equal(body.model, "jetson-fleet");
    assert.equal(body.choices[0]!.message.content, FLEET_SIMULATED_REPLY);
    assert.match(FLEET_SIMULATED_REPLY, /^Simulated reply:/);
    assert.deepEqual(usage, [{ source: "fleet", endpoint: FLEET_ENDPOINT, model: FLEET_CANNED_USAGE, units: 1, costUsd: 0, buildId: "b1" }]);
  });

  it("doesn't need the settings, and never holds a slot", async () => {
    const res = await handleFleetChat(call(), deps({ findToken: buildToken, settings: () => null, acquireInFlight: async () => assert.fail("took a slot") }));
    assert.equal(res.status, 200);
  });

  it("gets the same reply when it isn't tied to a build, as a brief with no cap blocks mints it", async () => {
    const boom = (() => {
      throw new Error("touched the fleet");
    }) as unknown as typeof fetch;
    const res = await handleFleetChat(call(), deps({ findToken: async () => ({ ...(await buildToken()), buildId: null }), fetch: boom }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { simulated: boolean; choices: Array<{ message: { content: string } }> };
    assert.equal(body.simulated, true);
    assert.equal(body.choices[0]!.message.content, FLEET_SIMULATED_REPLY);
    assert.deepEqual(usage, [{ source: "fleet", endpoint: FLEET_ENDPOINT, model: FLEET_CANNED_USAGE, units: 1, costUsd: 0, buildId: null }]);
  });

  it("a token of any other scope still never reaches the fleet", async () => {
    const res = await handleFleetChat(call(), deps({ findToken: async () => ({ ...(await buildToken()), scope: "sandbox", buildId: null }) }));
    assert.equal(res.status, 403);
    assert.equal(await code(res), "cap_not_allowed");
    assert.equal(sent.length, 0);
  });
});

describe("limits", () => {
  it("stops a product at 100 answers a day, without a call to the fleet", async () => {
    counts["fleet:product:p1"] = FLEET_LIMITS.perProductPerDay - 1;
    assert.equal((await handleFleetChat(call(), deps())).status, 200);
    const res = await handleFleetChat(call(), deps());
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("retry-after")) > 0);
    assert.equal(sent.length, 1);
    assert.equal(FLEET_LIMITS.perProductPerDay, 100);
  });

  it("holds a build's simulated replies to the same day", async () => {
    counts["fleet:product:p1"] = FLEET_LIMITS.perProductPerDay;
    assert.equal((await handleFleetChat(call(), deps({ findToken: buildToken }))).status, 429);
  });

  it("stops one address at 10 a minute, and another is fine", async () => {
    const d = deps();
    const ip = { "x-musemuse-client-ip": "203.0.113.5" };
    assert.equal(FLEET_LIMITS.perIpPerMinute, 10);
    for (let i = 0; i < 10; i++) assert.equal((await handleFleetChat(call(undefined, ip), d)).status, 200);
    assert.equal((await handleFleetChat(call(undefined, ip), d)).status, 429);
    assert.equal((await handleFleetChat(call(undefined, { "x-musemuse-client-ip": "203.0.113.6" }), d)).status, 200);
  });

  /** A fleet that answers only when told, so calls can overlap. */
  function held() {
    const waiting: Array<() => void> = [];
    return { waiting, answer: () => new Promise<Response>((resolve) => waiting.push(() => resolve(fleetJson(ANSWER)))) };
  }
  const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

  it("takes one at a time per product, says busy, and spends none of the day on it", async () => {
    const fleet = held();
    const first = handleFleetChat(call(), deps({}, fleet.answer));
    await settled();
    const second = await handleFleetChat(call(), deps({}, fleet.answer));
    assert.equal(second.status, 409);
    assert.equal(await code(second), "busy");
    assert.equal(counts["fleet:product:p1"], 1);
    fleet.waiting[0]!();
    assert.equal((await first).status, 200);
    assert.deepEqual(slots, { "fleet:flight:p1": 0, "fleet:flight:all": 0 });
    assert.equal((await handleFleetChat(call(), deps())).status, 200, "the slot was given back");
  });

  it("takes two at a time across the platform, and gives the product's slot back when it's full", async () => {
    const fleet = held();
    const on = (productId: string) => deps({ findToken: async () => ({ id: productId, productId, scope: "live", allowedModels: [FLEET_MARKER], dailyBudgetUsd: 1, buildId: null }) }, fleet.answer);
    const a = handleFleetChat(call(), on("a"));
    const b = handleFleetChat(call(), on("b"));
    await settled();
    const c = await handleFleetChat(call(), on("c"));
    assert.equal(await code(c), "busy");
    assert.equal(slots["fleet:flight:c"], 0);
    assert.equal(sent.length, 2);
    fleet.waiting.forEach((go) => go());
    assert.equal((await a).status, 200);
    assert.equal((await b).status, 200);
    assert.equal(slots["fleet:flight:all"], 0);
  });

  it("gives its slots back when the fleet fails", async () => {
    await handleFleetChat(call(), deps({}, () => new Response("no", { status: 500 })));
    assert.deepEqual(slots, { "fleet:flight:p1": 0, "fleet:flight:all": 0 });
  });
});

describe("a live token", () => {
  it("answers in OpenAI's shape under the brief's name, and names neither the fleet's model nor its request", async () => {
    const res = await handleFleetChat(call(), deps());
    const text = await res.text();
    const body = JSON.parse(text) as { object: string; model: string; choices: Array<{ message: { content: string }; finish_reason: string }>; usage: { total_tokens: number }; simulated?: boolean };
    assert.equal(body.object, "chat.completion");
    assert.equal(body.model, "jetson-fleet");
    assert.equal(body.choices[0]!.message.content, "A real answer.");
    assert.equal(body.choices[0]!.finish_reason, "stop");
    assert.equal(body.usage.total_tokens, 12);
    assert.equal(body.simulated, undefined);
    assert.ok(!text.includes(MODEL));
    assert.ok(!text.includes("fleet-id"));
  });

  it("meters one row per answer at $0, and none for a failure", async () => {
    await handleFleetChat(call(), deps());
    assert.deepEqual(usage, [{ source: "fleet", endpoint: FLEET_ENDPOINT, model: "jetson-fleet", units: 1, costUsd: 0, buildId: null }]);
    await handleFleetChat(call(), deps({}, () => new Response("no", { status: 500 })));
    assert.equal(usage.length, 1);
  });

  it("still answers when metering fails", async () => {
    const res = await handleFleetChat(call(), deps({ recordUsage: async () => { throw new Error("db down"); } }));
    assert.equal(res.status, 200);
  });

  for (const served of ["cloud", "Cloud", " CLOUD ", "local, cloud"]) {
    it(`treats X-JCP-Served-By: ${served} as an error, never an answer`, async () => {
      const res = await handleFleetChat(call(), deps({}, () => fleetJson({ ...ANSWER, choices: [{ message: { content: "Written in the cloud." } }] }, { headers: { "x-jcp-served-by": served } })));
      const text = await res.text();
      assert.equal(res.status, 502);
      assert.ok(text.includes("fleet_unavailable"));
      assert.ok(!text.includes("Written in the cloud"));
      assert.equal(usage.length, 0);
      assert.deepEqual(logged, ["[fleet] fleet_cloud_answer"]);
      logged.length = 0;
    });
  }

  it("takes a board's own word for it, and a plain model's answer with no header", async () => {
    assert.equal((await handleFleetChat(call(), deps({}, () => fleetJson(ANSWER, { headers: { "x-jcp-served-by": "local" } })))).status, 200);
    assert.equal((await handleFleetChat(call(), deps())).status, 200);
  });
});

describe("what a failure says", () => {
  const SECRET = "no online node can serve model made-up-board-model at fleet.example/admin on nd_123";
  const cases: Array<[string, () => Response | Promise<Response>, number, string]> = [
    ["the fleet's own error", () => fleetJson({ error: { message: SECRET, type: "no_capacity" } }, { status: 503 }), 502, "fleet_unavailable"],
    ["the fleet being busy", () => fleetJson({ error: { message: SECRET, code: "fleet_busy" } }, { status: 429, headers: { "retry-after": "5" } }), 502, "fleet_unavailable"],
    ["the fleet's key being refused", () => fleetJson({ error: { message: SECRET } }, { status: 401 }), 502, "fleet_unavailable"],
    ["an HTML page where an answer should be", () => new Response(`<html>${SECRET}</html>`, { status: 200 }), 502, "fleet_unavailable"],
    ["an empty answer", () => fleetJson({ choices: [{ message: { content: "  " } }] }), 502, "fleet_unavailable"],
    ["no choices at all", () => fleetJson({ detail: SECRET }), 502, "fleet_unavailable"],
    ["a redirect, which fetch refuses", () => { throw new TypeError(`fetch failed: redirect mode is set to error: ${ADDRESS}`); }, 502, "fleet_unavailable"],
    ["a network failure", () => { throw new Error(`connect ECONNREFUSED ${ADDRESS}`); }, 502, "fleet_unavailable"],
    ["a timeout", () => { throw new DOMException(`The operation timed out at ${ADDRESS}`, "TimeoutError"); }, 504, "timeout"],
    ["the caller leaving", () => { throw new DOMException(`aborted ${ADDRESS}`, "AbortError"); }, 504, "timeout"],
  ];
  for (const [what, answer, status, want] of cases) {
    it(`${what}: ${status} ${want}, with no address, model, key or fleet text in the answer or the logs, and no message logged`, async () => {
      const res = await handleFleetChat(call({ messages: [{ role: "user", content: "my secret question" }] }), deps({}, answer));
      assert.equal(res.status, status);
      assert.equal(await code(res), want);
      const seen = `${await res.text()}\n${[...res.headers].join("\n")}\n${logged.join("\n")}`;
      for (const leak of ["fleet.example", "/admin", MODEL, KEY, "nd_123", "no online node", "my secret question"]) assert.ok(!seen.includes(leak), leak);
      assert.equal(usage.length, 0);
    });
  }

  it("turns anything else into a 502, not a stack", async () => {
    const res = await handleFleetChat(call(), deps({ product: async () => { throw new Error("db down at 10.0.0.1"); } }));
    assert.equal(res.status, 502);
    assert.ok(!(await res.text()).includes("10.0.0.1"));
    assert.ok(!logged.join().includes("10.0.0.1"));
  });

  it("a refused setting's answer doesn't name the setting's value either", async () => {
    const res = await handleFleetChat(call(), deps({ settings: () => fleetSettings({ ...SETTINGS, FLEET_PRODUCTS_KEY: "jpt_madeup" }) }));
    const text = await res.text();
    for (const leak of ["jpt_madeup", "fleet.example", MODEL]) assert.ok(!text.includes(leak), leak);
  });
});
