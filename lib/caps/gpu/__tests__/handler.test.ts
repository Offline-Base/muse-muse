/**
 * {GATEWAY_URL}/glimmer/v1/chat/completions (docs/CAPABILITIES.md, section 17): the flag, who may ask, the limits, a build's
 * sample replies, and every way a live call ends, on fakes. No GPU, no database, no model call.
 *
 *   npx tsx --test lib/caps/gpu/__tests__/handler.test.ts
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { GLIMMER_CANNED_REPLIES } from "@/lib/caps/gpu/canned";
import { GLIMMER_LIMITS, GLIMMER_TEST_HEADER, handleGlimmerChat, type GlimmerDeps } from "@/lib/caps/gpu/handler";
import { GLIMMER_MARKER } from "@/lib/caps/gpu/marker";
import type { GlimmerWindow } from "@/lib/caps/gpu/types";
import { GLIMMER_SAMPLING, type GlimmerChatInput } from "@/lib/train/glimmer-serving";
import { ServeError } from "@/lib/train/serve";

const NOW = new Date("2026-11-03T15:00:00Z");
const ADAPTER = "aaaaaaaa-0000-4000-8000-000000000001";
const WINDOW: GlimmerWindow = {
  id: "bbbbbbbb-0000-4000-8000-000000000001",
  startsAt: new Date(NOW.getTime() - 60_000),
  endsAt: new Date(NOW.getTime() + 60_000),
  createdBy: null,
  capUsd: 3,
  status: "open",
  costUsd: null,
  adapterJobId: ADAPTER,
  serveJobId: "cccccccc-0000-4000-8000-000000000001",
  sparkOpen: false,
  reservationId: null,
  createdAt: NOW,
};

let chats: GlimmerChatInput[];
let usage: Array<{ source: string; model: string; units?: number; costUsd: number; buildId?: string | null }>;
let counts: Record<string, number>;

function deps(over: Partial<GlimmerDeps> = {}): GlimmerDeps {
  return {
    on: () => true,
    paused: () => false,
    allProducts: () => false,
    adminEmails: ["admin@example.com"],
    findToken: async () => ({ id: "t1", productId: "p1", scope: "live", allowedModels: ["muse-wonder-1.0", GLIMMER_MARKER], dailyBudgetUsd: 1, buildId: null }),
    product: async () => ({ status: "live", manifest: null, liveUrl: null, takenDownAt: null, ownerId: "u1", ownerEmail: "admin@example.com", ownerIsAdmin: true, ownerBannedAt: null }),
    hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, (counts[k] = (counts[k] ?? 0) + 1)])),
    openWindow: async () => WINDOW,
    ownModel: async () => ({ adapterJobId: ADAPTER, trainChannel: 0 }),
    startingFor: async () => null,
    backend: async () => ({
      chat: async (i) => {
        chats.push(i);
        return { text: "A real answer.", finish: "stop", usage: { input: 5, output: 7 }, ms: 40 };
      },
    }),
    recordUsage: async (ctx, items) => {
      for (const i of items) usage.push({ source: ctx.source, model: i.model, units: i.units, costUsd: i.costUsd, buildId: ctx.buildId });
    },
    now: () => NOW,
    ...over,
  };
}

const call = (body: unknown = { model: "muse-glimmer", messages: [{ role: "user", content: "hi" }] }, headers: Record<string, string> = {}, method = "POST") =>
  new Request("https://platform.example/api/gateway/glimmer/v1/chat/completions", {
    method,
    headers: { authorization: "Bearer mm_live_x", ...headers },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });

const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

const buildToken = async () => ({ id: "t2", productId: "p1", scope: "build", allowedModels: [GLIMMER_MARKER], dailyBudgetUsd: 1, buildId: "b1" });

beforeEach(() => {
  chats = [];
  usage = [];
  counts = {};
});

describe("who may ask", () => {
  it("is 404 with the flag off, and nothing is touched", async () => {
    const boom = () => {
      throw new Error("touched");
    };
    const res = await handleGlimmerChat(call(), deps({ on: () => false, findToken: boom, product: boom, hitRateLimits: boom, openWindow: boom }));
    assert.equal(res.status, 404);
    assert.equal(await code(res), "unknown_endpoint");
  });

  it("refuses no token, a disabled product and a token without the marker", async () => {
    assert.equal((await handleGlimmerChat(call(), deps({ findToken: async () => null }))).status, 401);
    for (const product of [
      { status: "disabled" as const, takenDownAt: null, ownerBannedAt: null },
      { status: "live" as const, takenDownAt: NOW, ownerBannedAt: null },
      { status: "live" as const, takenDownAt: null, ownerBannedAt: NOW },
    ]) {
      const res = await handleGlimmerChat(call(), deps({ product: async () => ({ manifest: null, liveUrl: null, ownerId: "u", ownerEmail: "a@example.com", ownerIsAdmin: false, ...product }) }));
      assert.equal(await code(res), "product_disabled");
    }
    const res = await handleGlimmerChat(call(), deps({ findToken: async () => ({ id: "t", productId: "p", scope: "live", allowedModels: ["muse-wonder-1.0"], dailyBudgetUsd: 1, buildId: null }) }));
    assert.equal(res.status, 403);
    assert.equal(await code(res), "glimmer_not_allowed");
  });

  it("keeps live answers to admins' products until GPU_GLIMMER_ALL_PRODUCTS, and never serves the guest's", async () => {
    const builder = async () => ({ status: "live" as const, manifest: null, liveUrl: null, takenDownAt: null, ownerId: "u", ownerEmail: "someone@example.com", ownerIsAdmin: false, ownerBannedAt: null });
    const off = await handleGlimmerChat(call(), deps({ product: builder }));
    assert.equal(await code(off), "glimmer_not_allowed");
    assert.equal((await handleGlimmerChat(call(), deps({ product: builder, allProducts: () => true }))).status, 200);
    const { GUEST_EMAIL } = await import("@/lib/auth");
    const guest = async () => ({ status: "live" as const, manifest: null, liveUrl: null, takenDownAt: null, ownerId: "u", ownerEmail: GUEST_EMAIL, ownerIsAdmin: false, ownerBannedAt: null });
    assert.equal(await code(await handleGlimmerChat(call(), deps({ product: guest, allProducts: () => true }))), "sign_in_required");
  });

  it("doesn't trust an admin flag for an email that isn't an admin's", async () => {
    const res = await handleGlimmerChat(call(), deps({ product: async () => ({ status: "live", manifest: null, liveUrl: null, takenDownAt: null, ownerId: "u", ownerEmail: "was-admin@example.com", ownerIsAdmin: true, ownerBannedAt: null }) }));
    assert.equal(await code(res), "glimmer_not_allowed");
  });
});

describe("limits", () => {
  it("stops a product at 200 a day", async () => {
    counts["glimmer:product:p1"] = GLIMMER_LIMITS.perProductPerDay - 1;
    assert.equal((await handleGlimmerChat(call(), deps())).status, 200);
    const res = await handleGlimmerChat(call(), deps());
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("retry-after")) > 0);
  });

  it("stops one address at 10 a minute", async () => {
    const d = deps();
    const ip = { "x-musemuse-client-ip": "203.0.113.5" };
    for (let i = 0; i < GLIMMER_LIMITS.perIpPerMinute; i++) assert.equal((await handleGlimmerChat(call(undefined, ip), d)).status, 200);
    assert.equal((await handleGlimmerChat(call(undefined, ip), d)).status, 429);
    assert.equal((await handleGlimmerChat(call(undefined, { "x-musemuse-client-ip": "203.0.113.6" }), d)).status, 200, "another address is fine");
  });
});

describe("the request", () => {
  for (const [what, body] of [
    ["a body that isn't JSON", "{nope"],
    ["an unknown key", { messages: [{ role: "user", content: "hi" }], tools: [] }],
    ["streaming", { messages: [{ role: "user", content: "hi" }], stream: true }],
    ["another model", { model: "muse-wonder-1.0", messages: [{ role: "user", content: "hi" }] }],
    ["no messages", { model: "muse-glimmer" }],
    ["a last message that isn't the user's", { messages: [{ role: "assistant", content: "hi" }] }],
    ["bad max_tokens", { messages: [{ role: "user", content: "hi" }], max_tokens: 0 }],
    ["too many stops", { messages: [{ role: "user", content: "hi" }], stop: ["a", "b", "c", "d", "e"] }],
  ] as const) {
    it(`refuses ${what} with a 400, for a build and for a live token`, async () => {
      assert.equal((await handleGlimmerChat(call(body), deps())).status, 400);
      assert.equal((await handleGlimmerChat(call(body), deps({ findToken: buildToken }))).status, 400);
      assert.equal(chats.length, 0);
    });
  }

  it("refuses a body too big to read", async () => {
    const res = await handleGlimmerChat(call({ messages: [{ role: "user", content: "x".repeat(GLIMMER_LIMITS.bodyBytes) }] }), deps());
    assert.equal(res.status, 413);
  });

  it("takes sampling from the SDK and ignores it, and takes <|eom|> out of a stop", async () => {
    const res = await handleGlimmerChat(call({ messages: [{ role: "user", content: "hi" }], temperature: 0, top_p: 0.1, stop: ["<|eom|>", "END"] }), deps());
    assert.equal(res.status, 200);
    assert.deepEqual(chats[0]!.stop, ["END"]);
    assert.ok(!("temperature" in chats[0]!), "only the backend's GLIMMER_SAMPLING is sent");
    assert.equal(GLIMMER_SAMPLING.temperature, 1);
  });
});

describe("a build token", () => {
  it("gets a steady sample reply, marked simulated, with no window and no GPU", async () => {
    const boom = async () => {
      throw new Error("touched a GPU path");
    };
    const d = deps({ findToken: buildToken, openWindow: boom, backend: boom, ownModel: boom });
    const first = (await (await handleGlimmerChat(call(), d)).json()) as { simulated: boolean; choices: Array<{ message: { content: string } }>; object: string };
    const second = (await (await handleGlimmerChat(call(), d)).json()) as typeof first;
    assert.equal(first.simulated, true);
    assert.equal(first.object, "chat.completion");
    assert.ok((GLIMMER_CANNED_REPLIES as readonly string[]).includes(first.choices[0]!.message.content));
    assert.equal(first.choices[0]!.message.content, second.choices[0]!.message.content);
    assert.deepEqual(usage[0], { source: "glimmer", model: "glimmer-canned", units: 1, costUsd: 0, buildId: "b1" });
  });

  it("gets a sample for own too, and a closed window when its test asks", async () => {
    const d = deps({ findToken: buildToken });
    assert.equal((await handleGlimmerChat(call({ model: "own", messages: [{ role: "user", content: "hi" }] }), d)).status, 200);
    const res = await handleGlimmerChat(call(undefined, { [GLIMMER_TEST_HEADER]: "closed" }), d);
    assert.equal(res.status, 503);
    assert.equal(await code(res), "glimmer_closed");
    assert.equal(usage.at(-1)!.model, "glimmer-closed");
  });

  it("a live token can't ask for that closed test", async () => {
    assert.equal((await handleGlimmerChat(call(undefined, { [GLIMMER_TEST_HEADER]: "closed" }), deps())).status, 200);
  });

  it("is refused when it isn't tied to a build", async () => {
    const res = await handleGlimmerChat(call(), deps({ findToken: async () => ({ id: "t", productId: "p", scope: "build", allowedModels: [GLIMMER_MARKER], dailyBudgetUsd: 1, buildId: null }) }));
    assert.equal(res.status, 403);
  });
});

describe("a live token", () => {
  it("answers in OpenAI's shape from base Glimmer during a window, one unit at $0", async () => {
    const res = await handleGlimmerChat(call(), deps());
    const body = (await res.json()) as { object: string; model: string; choices: Array<{ message: { content: string }; finish_reason: string }>; usage: { total_tokens: number }; simulated?: boolean };
    assert.equal(body.object, "chat.completion");
    assert.equal(body.model, "muse-glimmer");
    assert.equal(body.choices[0]!.message.content, "A real answer.");
    assert.equal(body.choices[0]!.finish_reason, "stop");
    assert.equal(body.usage.total_tokens, 12);
    assert.equal(body.simulated, undefined);
    assert.equal(chats[0]!.adapter, null);
    assert.deepEqual(usage, [{ source: "glimmer", model: "muse-glimmer", units: 1, costUsd: 0, buildId: null }]);
  });

  it("is closed with no window, and while the daily cap is 0, without asking anything else", async () => {
    const boom = async () => {
      throw new Error("touched");
    };
    assert.equal(await code(await handleGlimmerChat(call(), deps({ openWindow: async () => null, backend: boom }))), "glimmer_closed");
    assert.equal(await code(await handleGlimmerChat(call(), deps({ paused: () => true, openWindow: boom, backend: boom }))), "glimmer_closed");
    assert.equal(usage.length, 0);
  });

  it("says when the GPU is starting, and how long to wait", async () => {
    const res = await handleGlimmerChat(call(), deps({ startingFor: async () => 240 }));
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { code: string }; retryAfterSeconds: number };
    assert.equal(body.error.code, "glimmer_starting");
    assert.equal(body.retryAfterSeconds, 240);
    assert.equal(res.headers.get("retry-after"), "240");
  });

  it("is closed when the window's job is gone", async () => {
    assert.equal(await code(await handleGlimmerChat(call(), deps({ backend: async () => null }))), "glimmer_closed");
  });

  it("serves own only with a passing model that this window is serving", async () => {
    const own = { model: "own", messages: [{ role: "user", content: "hi" }] };
    const none = await handleGlimmerChat(call(own), deps({ ownModel: async () => null }));
    assert.equal(none.status, 404);
    assert.equal(await code(none), "own_model_not_ready");
    assert.equal(await code(await handleGlimmerChat(call(own), deps({ ownModel: async () => ({ adapterJobId: "dddddddd-0000-4000-8000-000000000001", trainChannel: 0 }) }))), "glimmer_closed");
    assert.equal((await handleGlimmerChat(call(own), deps())).status, 200);
    assert.equal(chats[0]!.adapter, ADAPTER);
    assert.equal(usage.at(-1)!.model, "muse-glimmer-own");
  });

  it("maps every ServeError to the contract's answer, and never logs or returns the GPU's address", async () => {
    const cases: Array<[ConstructorParameters<typeof ServeError>[0], number, string]> = [
      ["busy", 409, "busy"],
      ["stopping", 503, "glimmer_closed"],
      ["timeout", 504, "timeout"],
      ["bad_prompt", 400, "bad_request"],
      ["unreachable", 502, "glimmer_unavailable"],
      ["pin_mismatch", 502, "glimmer_unavailable"],
    ];
    for (const [c, status, want] of cases) {
      const res = await handleGlimmerChat(call(), deps({ backend: async () => ({ chat: async () => { throw new ServeError(c, "connect 203.0.113.77"); } }) }));
      assert.equal(res.status, status, c);
      const text = await res.text();
      assert.ok(text.includes(want), c);
      if (c !== "bad_prompt") assert.ok(!text.includes("203.0.113.77"), c);
    }
  });

  it("turns anything else into a 502, not a stack", async () => {
    const res = await handleGlimmerChat(call(), deps({ openWindow: async () => { throw new Error("db down at 10.0.0.1"); } }));
    assert.equal(res.status, 502);
    assert.ok(!(await res.text()).includes("10.0.0.1"));
  });

  it("carries the Spark Open line and the usage points for a Derivative's window, in the header and the body", async () => {
    const res = await handleGlimmerChat(call(), deps({ openWindow: async () => ({ ...WINDOW, sparkOpen: true }) }));
    assert.match(res.headers.get("x-musemuse-note") ?? "", /^Built with Muse Spark Open\. For people 18 and over only\./);
    assert.match(((await res.json()) as { note: string }).note, /Never present them as written by a person/);
    const plain = await handleGlimmerChat(call(), deps());
    assert.equal(plain.headers.get("x-musemuse-note"), null);
  });

  it("answers GET with a 405 once the flag is on", async () => {
    assert.equal((await handleGlimmerChat(call(undefined, {}, "GET"), deps())).status, 405);
  });
});

describe("what a closed window costs a product", () => {
  it("nothing of its day: 201 closed calls still leave an open window answering", async () => {
    const closedNow = deps({ openWindow: async () => null });
    for (let i = 0; i < 201; i++) assert.equal(await code(await handleGlimmerChat(call(), closedNow)), "glimmer_closed");
    assert.equal(counts["glimmer:product:p1"] ?? 0, 0);
    assert.equal((await handleGlimmerChat(call(), deps())).status, 200);
  });

  it("a GPU still starting, or no own model, doesn't count either", async () => {
    await handleGlimmerChat(call(), deps({ startingFor: async () => 30 }));
    await handleGlimmerChat(call({ model: "own", messages: [{ role: "user", content: "hi" }] }), deps({ ownModel: async () => null }));
    assert.equal(counts["glimmer:product:p1"] ?? 0, 0);
  });

  it("the day still holds for answers, and for a build's sample replies", async () => {
    counts["glimmer:product:p1"] = GLIMMER_LIMITS.perProductPerDay;
    assert.equal((await handleGlimmerChat(call(), deps())).status, 429);
    assert.equal(chats.length, 0);
    counts["glimmer:product:p1"] = GLIMMER_LIMITS.perProductPerDay;
    assert.equal((await handleGlimmerChat(call(), deps({ findToken: buildToken }))).status, 429);
  });

  it("the minute's limit per IP still comes first", async () => {
    counts["glimmer:ip:p1:203.0.113.9"] = GLIMMER_LIMITS.perIpPerMinute;
    const res = await handleGlimmerChat(call(undefined, { "x-musemuse-client-ip": "203.0.113.9" }), deps({ openWindow: async () => assert.fail("read the window") }));
    assert.equal(res.status, 429);
  });
});

describe("a stop that isn't text", () => {
  for (const stop of [5, {}, true]) {
    it(`${JSON.stringify(stop)} is the caller's mistake: 400, not 502`, async () => {
      const res = await handleGlimmerChat(call({ model: "muse-glimmer", messages: [{ role: "user", content: "hi" }], stop }), deps());
      assert.equal(res.status, 400);
      assert.equal(await code(res), "invalid_arguments");
    });
  }
});
