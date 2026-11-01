/**
 * {GATEWAY_URL}/decide (lib/gateway/decide.ts, docs/DECISION_MODELS.md "The gateway route") with every dep faked: the
 * permission, build tokens' stand-in, muse-decide (base Glimmer zero-shot) and a person's model on a backend that
 * returns made-up log-probabilities, decide_offline with no window, the backend's failures, the limits, metering at $0
 * and no state in any log. Then lib/train/decide-window.ts, the backend on the lab's own serving windows, with the GPU
 * call faked. Nothing reaches a GPU, Lambda, Neon or Meta.
 *
 *   npx tsx --test lib/gateway/__tests__/decide.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { decidePrompt, decideRenderings, decisionFromScores, NONE_OPTION, standInDecision } from "@/lib/decide/format";
import type { DecisionModel } from "@/lib/decide/serving";
import type { DecideBackend, DecideScoreInput, DecisionLabel } from "@/lib/decide/types";
import {
  DECIDE_ID,
  DECIDE_LIMITS,
  DECIDE_ZERO_SHOT_MODEL,
  DecideBackendError,
  handleDecide,
  type DecideDeps,
} from "@/lib/gateway/decide";
import type { GatewayToken } from "@/lib/gateway/handler";
import { windowBackends, type WindowTarget } from "@/lib/train/decide-window";
import { ServeError } from "@/lib/train/serve";
import type { UsageContext } from "@/lib/usage";
import type { ModelUsage } from "@/lib/types";

const LIVE = "mm_live_" + "a".repeat(30);
const BUILD = "mm_build_" + "b".repeat(30);
const MODEL_ID = "d0d0d0d0-0000-4000-8000-000000000001";
const PRIVATE_ID = "d0d0d0d0-0000-4000-8000-000000000002";
const STATE = "Hi, I was charged twice for my October order and want a refund";

const label = (name: string, description = ""): DecisionLabel => ({ id: name.toLowerCase().replaceAll(" ", "-"), name, description });
const TICKETS = [label("Billing", "Charges, refunds and invoices"), label("Shipping", "Delivery and tracking"), label("Account"), label("Returns")];
const SIX = [...TICKETS, label("Sales"), label("Press")];

function token(scope: "build" | "live", allowedModels = ["muse-wonder-1.0", DECIDE_ID]): GatewayToken {
  return { id: `tok-${scope}`, productId: "prod-1", scope, allowedModels, dailyBudgetUsd: 3 };
}

const person = (over: Partial<DecisionModel> = {}): DecisionModel => ({
  id: MODEL_ID,
  title: "Ticket router",
  question: "Which team should handle this support ticket?",
  labels: TICKETS,
  base: { T: 1.4, calibrated: true },
  tuned: { T: 0.8, calibrated: true },
  public: true,
  trainRows: 168,
  accuracy: null,
  ...over,
});

/** Log-probabilities that put `p` of 0.9 on letter `at` of each prompt and share the rest. */
function scoresFor(input: DecideScoreInput, at = 0, p = 0.8): number[][] {
  return input.letters.map((letters) => letters.map((_, j) => Math.log(j === at ? 0.9 * p : (0.9 * (1 - p)) / (letters.length - 1))));
}

interface Fake {
  deps: DecideDeps;
  scored: DecideScoreInput[];
  backendFor: Array<string | null>;
  usage: Array<{ ctx: UsageContext; items: ModelUsage[] }>;
  rateKeys: string[][];
}

function fake(over: Partial<DecideDeps> & { counts?: Record<string, number>; score?: DecideBackend["score"] | null } = {}): Fake {
  const scored: DecideScoreInput[] = [];
  const backendFor: Array<string | null> = [];
  const usage: Fake["usage"] = [];
  const rateKeys: string[][] = [];
  const tokens: Record<string, GatewayToken> = { [LIVE]: token("live"), [BUILD]: token("build") };
  const score: DecideBackend["score"] =
    over.score ??
    (async (input) => {
      scored.push(input);
      return { logprobs: scoresFor(input), ms: 840 };
    });
  const deps: DecideDeps = {
    findToken: async (t) => tokens[t] ?? null,
    productStatus: async () => "live",
    hitRateLimits: async (keys) => {
      rateKeys.push(keys);
      return Object.fromEntries(keys.map((k) => [k, over.counts?.[k] ?? 1]));
    },
    findModel: async (id) => (id === MODEL_ID ? person() : id === PRIVATE_ID ? person({ id: PRIVATE_ID, public: false }) : null),
    backend: async (adapter) => {
      backendFor.push(adapter);
      return over.score === null ? null : { score };
    },
    recordUsage: async (ctx, items) => void usage.push({ ctx, items }),
    ...over,
  };
  return { deps, scored, backendFor, usage, rateKeys };
}

const post = (bearer: string | null, body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://platform.example/api/gateway/decide", {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const errorOf = async (res: Response) => ((await res.json()) as { error?: { code?: string; message?: string } }).error;
const general = (over: Record<string, unknown> = {}) => ({ state: STATE, question: "Which team should handle this?", options: ["Billing", "Shipping", "Account"], ...over });

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  mock.method(console, "error", (...args: unknown[]) => void logged.push(args.map(String).join(" ")));
});
afterEach(() => {
  mock.restoreAll();
  assert.ok(!logged.some((l) => l.includes("charged twice")), "the state is never logged");
});

describe("{GATEWAY_URL}/decide", () => {
  it("needs the product's token, a product that's on, and muse-decide in its brief", async () => {
    assert.equal((await handleDecide(post(null, general()), fake().deps)).status, 401);
    assert.equal((await handleDecide(post("mm_live_unknown_value_123456789", general()), fake().deps)).status, 401);
    const off = await handleDecide(post(LIVE, general()), fake({ productStatus: async () => "disabled" }).deps);
    assert.equal((await errorOf(off))?.code, "product_disabled");
    const f = fake({ findToken: async () => token("live", ["muse-wonder-1.0", "muse-gadget"]) });
    const denied = await handleDecide(post(LIVE, general()), f.deps);
    assert.equal(denied.status, 403);
    assert.equal((await errorOf(denied))?.code, "decide_not_allowed");
    assert.equal(denied.headers.get("x-should-retry"), "false");
    assert.deepEqual([f.backendFor, f.usage], [[], []], "nothing scored or metered");
  });

  it("gives build tokens the word-overlap stand-in, never a GPU, and says it is not a model", async () => {
    const f = fake();
    const res = await handleDecide(post(BUILD, general()), f.deps);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    const labels = [label("Billing"), label("Shipping"), label("Account")];
    assert.deepEqual(body, {
      ...standInDecision({ state: STATE, labels }),
      model: "stand-in",
      calibrated: false,
      simulated: true,
      ms: 0,
      note: "The build-time stand-in: the option whose words overlap the state's most. It is not a model; live, the decision model answers.",
    });
    // A person's model's own labels, with their descriptions: "refund" and "charges" pick Billing.
    const own = (await (await handleDecide(post(BUILD, { state: STATE, model: MODEL_ID.toUpperCase() }), f.deps)).json()) as Record<string, unknown>;
    assert.equal(own.decision, "Billing");
    assert.deepEqual(own.probabilities, standInDecision({ state: STATE, labels: TICKETS }).probabilities);
    assert.deepEqual(f.backendFor, [], "the backend is never asked for a build");
    assert.equal(f.usage.length, 2);
    assert.deepEqual(f.usage[0], {
      ctx: { source: "gateway", productId: "prod-1", tokenId: "tok-build", endpoint: "/decide" },
      items: [{ model: DECIDE_ID, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, units: 1, costUsd: 0 }],
    });
  });

  it("answers muse-decide with base Glimmer zero-shot on the platform's renderings, and says so", async () => {
    const f = fake();
    const res = await handleDecide(post(LIVE, general({ options: ["Billing", { option: "Shipping", description: "Delivery and tracking" }] })), f.deps);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(f.backendFor, [null], "base Glimmer: no adapter");
    const labels = [label("Billing"), label("Shipping", "Delivery and tracking")];
    const renderings = decideRenderings({ state: STATE, question: "Which team should handle this?", labels });
    const input = f.scored[0]!;
    assert.deepEqual(input.prompts, renderings.map((r) => decidePrompt(r)), "exactly what scoring and decide.json render");
    assert.deepEqual(input.letters, [["A", "B", "C"]]);
    assert.equal(input.adapter, null);
    assert.ok(input.signal instanceof AbortSignal);
    const { decision } = decisionFromScores({ labels, renderings, logprobs: scoresFor(input), T: 1 });
    assert.deepEqual(body, {
      ...decision,
      model: DECIDE_ZERO_SHOT_MODEL,
      calibrated: false,
      simulated: false,
      ms: 840,
      note: "Muse Decide isn't trained yet, so base Muse Glimmer 30B picked zero-shot. Its confidence is its own probability, not calibrated.",
    });
    assert.equal(body.decision, "Billing");
    assert.equal(f.usage.length, 1, "metered at $0");

    // none: false shows the options alone.
    await handleDecide(post(LIVE, general({ none: false })), f.deps);
    assert.deepEqual(f.scored[1]!.letters, [["A", "B", "C"]]);
    assert.doesNotMatch(f.scored[1]!.prompts[0]!.text, new RegExp(NONE_OPTION));
    // A flat object is its JSON text.
    await handleDecide(post(LIVE, general({ state: { order: 1042, note: "charged twice", paid: true } })), f.deps);
    assert.match(f.scored[2]!.prompts[0]!.messages[1]!.content as string, /"state":"\{\\"order\\":1042,\\"note\\":\\"charged twice\\",\\"paid\\":true\}"/);
  });

  it("answers a person's model with its own labels, groups and T, from its own window", async () => {
    const f = fake({ findModel: async (id) => (id === MODEL_ID ? person({ labels: SIX }) : null) });
    const res = await handleDecide(post(LIVE, { state: STATE, model: MODEL_ID }), f.deps);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(f.backendFor, [MODEL_ID]);
    const input = f.scored[0]!;
    assert.equal(input.prompts.length, 2, "6 labels make 2 prompts, each with none");
    assert.equal(input.adapter, MODEL_ID);
    const renderings = decideRenderings({ state: STATE, question: person().question, labels: SIX });
    const { decision } = decisionFromScores({ labels: SIX, renderings, logprobs: scoresFor(input), T: 0.8 });
    assert.deepEqual(body, { ...decision, model: MODEL_ID, calibrated: true, simulated: false, ms: 840, note: null });

    // Other options or another question are allowed, but out of what it learned: its T isn't applied, and the note says so.
    const other = (await (await handleDecide(post(LIVE, { state: STATE, model: MODEL_ID, options: ["Refunds", "Other"] }), f.deps)).json()) as Record<string, unknown>;
    assert.equal(other.calibrated, false);
    assert.equal(other.note, "These options aren't the labels this model learned, so its pick and its confidence are less reliable.");
    assert.deepEqual((other.probabilities as Array<{ id: string }>).map((p) => p.id), ["refunds", "other"]);
    const same = (await (await handleDecide(post(LIVE, { state: STATE, model: MODEL_ID, options: SIX.map((l) => l.name.toUpperCase()) }), f.deps)).json()) as Record<string, unknown>;
    assert.equal(same.note, null, "its own labels, in another case, are its own");
    const asked = (await (await handleDecide(post(LIVE, { state: STATE, model: MODEL_ID, question: "Who answers this?" }), f.deps)).json()) as Record<string, unknown>;
    assert.match(String(asked.note), /This question isn't the one this model learned/);

    const off = await handleDecide(post(LIVE, { state: STATE, model: MODEL_ID, none: false }), f.deps);
    assert.equal(off.status, 400);
    assert.match(String((await errorOf(off))?.message), /always shows "None of the listed options matches"/);
  });

  it("knows only public decision models: 404 unknown_model for anything else", async () => {
    for (const model of ["d0d0d0d0-0000-4000-8000-00000000ffff", PRIVATE_ID, "muse-spark-1.3", "../etc"]) {
      const f = fake();
      const res = await handleDecide(post(LIVE, { state: STATE, model }), f.deps);
      assert.equal(res.status, 404, model);
      assert.equal((await errorOf(res))?.code, "unknown_model");
      assert.deepEqual(f.backendFor, []);
    }
  });

  it("answers 503 decide_offline when no window serves the model, and maps each backend failure", async () => {
    const offline = await handleDecide(post(LIVE, general()), fake({ score: null }).deps);
    assert.equal(offline.status, 503);
    const err = await errorOf(offline);
    assert.equal(err?.code, "decide_offline");
    assert.match(String(err?.message), /isn't running right now/);
    assert.equal(offline.headers.get("x-should-retry"), "false");

    const failing = (thrown: unknown) => fake({ score: async () => Promise.reject(thrown) }).deps;
    const cases: Array<[unknown, number, string]> = [
      [new DecideBackendError("busy", "busy"), 429, "rate_limited"],
      [new DecideBackendError("offline", "stopping"), 503, "decide_offline"],
      [new DecideBackendError("timeout", "slow"), 504, "timeout"],
      [new DecideBackendError("too_long", "422"), 400, "invalid_task"],
      [new Error("ECONNREFUSED"), 502, "decide_unavailable"],
    ];
    for (const [thrown, status, code] of cases) {
      const res = await handleDecide(post(LIVE, general()), failing(thrown));
      assert.equal(res.status, status, code);
      assert.equal((await errorOf(res))?.code, code);
    }
    const busy = await handleDecide(post(LIVE, general()), failing(new DecideBackendError("busy", "busy")));
    assert.equal(busy.headers.get("retry-after"), "2");

    // A backend that never answers: 504 at the gateway's own deadline.
    const hung = fake({ score: () => new Promise(() => {}), timeoutMs: 50 });
    const started = Date.now();
    const slow = await handleDecide(post(LIVE, general()), hung.deps);
    assert.equal(slow.status, 504);
    assert.ok(Date.now() - started < 2_000);
    assert.equal(hung.usage.length, 0, "nothing answered, nothing metered");
  });

  it("refuses scores that can't be log-probabilities instead of answering confidently", async () => {
    // Probabilities sent in place of log-probabilities, and no probability on any letter.
    for (const logprobs of [[[0.7, 0.2, 0.05, 0.05]], [[-1e9, -1e9, -1e9, -1e9]], [[0, 0]]]) {
      const res = await handleDecide(post(LIVE, general()), fake({ score: async () => ({ logprobs, ms: 1 }) }).deps);
      assert.equal(res.status, 502, JSON.stringify(logprobs));
      assert.equal((await errorOf(res))?.code, "decide_unavailable");
    }
  });

  it("checks the state, the question, the options and the body before anything else", async () => {
    const f = fake();
    const cases: Array<[unknown, string, RegExp?]> = [
      ["{nope", "invalid_body"],
      [[1, 2], "invalid_body"],
      [general({ state: undefined }), "invalid_state"],
      [general({ state: { nested: { no: 1 } } }), "invalid_state"],
      [general({ state: "   " }), "invalid_task", /1 to 3,000 characters/],
      [general({ state: "x".repeat(3001) }), "invalid_task", /1 to 3,000 characters/],
      [general({ question: undefined }), "invalid_question"],
      [general({ question: "Why" }), "invalid_task", /5 to 300 characters/],
      [general({ options: undefined }), "invalid_options"],
      [general({ options: ["Billing"] }), "invalid_options", /Muse Decide takes 2 to 4 options a call, its training range/],
      [general({ options: ["A", "B", "C", "D", "E"] }), "invalid_options", /2 to 4 options/],
      [general({ options: ["Billing", "billing"] }), "invalid_options", /repeats another option/],
      [general({ options: ["Billing", NONE_OPTION] }), "invalid_options", /is added for you/],
      [general({ options: ["Billing", "!!"] }), "invalid_options", /at least one letter or digit/],
      [general({ options: ["Billing", "x".repeat(61)] }), "invalid_options", /1 to 60 characters/],
      [general({ options: ["Billing", { option: "Shipping", description: "d".repeat(201) }] }), "invalid_options", /up to 200 characters/],
      [general({ none: "yes" }), "invalid_none"],
      [general({ model: 7 }), "invalid_model"],
    ];
    for (const [body, code, message] of cases) {
      const res = await handleDecide(post(LIVE, body), f.deps);
      assert.equal(res.status, 400, `${JSON.stringify(body).slice(0, 80)}`);
      const err = await errorOf(res);
      assert.equal(err?.code, code, `${JSON.stringify(body).slice(0, 80)}`);
      if (message) assert.match(String(err?.message), message);
    }
    assert.equal((await handleDecide(post(LIVE, general({ state: "x".repeat(3000) })), f.deps)).status, 200, "3,000 characters is fine");
    assert.equal((await handleDecide(post(LIVE, general({ state: "x".repeat(70_000) })), f.deps)).status, 413);
    assert.equal(f.scored.length, 1, "only the good one reached the backend");
  });

  it("allows 60 a minute per token and 20 per visitor", async () => {
    const tooMany = fake({ counts: { "decide:token:tok-live": DECIDE_LIMITS.perTokenPerMinute + 1 } });
    const res = await handleDecide(post(LIVE, general()), tooMany.deps);
    assert.equal(res.status, 429);
    assert.equal((await errorOf(res))?.code, "rate_limited");
    assert.ok(Number(res.headers.get("retry-after")) >= 1);
    assert.deepEqual(tooMany.backendFor, []);
    const perIp = fake({ counts: { "decide:ip:prod-1:203.0.113.9": DECIDE_LIMITS.perIpPerMinute + 1 } });
    assert.equal((await handleDecide(post(LIVE, general(), { "x-musemuse-client-ip": "203.0.113.9" }), perIp.deps)).status, 429);
    const ok = fake();
    await handleDecide(post(LIVE, general(), { "x-musemuse-client-ip": "203.0.113.9" }), ok.deps);
    assert.deepEqual(ok.rateKeys, [["decide:token:tok-live", "decide:ip:prod-1:203.0.113.9"]]);
    assert.deepEqual([DECIDE_LIMITS.perTokenPerMinute, DECIDE_LIMITS.perIpPerMinute], [60, 20]);
  });

  it("counts refused calls too, and looks up no model once a token is over its minute", async () => {
    const looked: string[] = [];
    const refused = fake({ findModel: async (id) => (looked.push(id), null) });
    assert.equal((await handleDecide(post(LIVE, { state: STATE, model: "no-such-model" }), refused.deps)).status, 404);
    assert.equal((await handleDecide(post(LIVE, "not json"), refused.deps)).status, 400);
    assert.equal(refused.rateKeys.length, 2, "both refused calls counted");
    const over = fake({ counts: { "decide:token:tok-live": DECIDE_LIMITS.perTokenPerMinute + 1 }, findModel: async (id) => (looked.push(id), null) });
    assert.equal((await handleDecide(post(LIVE, { state: STATE, model: "no-such-model" }), over.deps)).status, 429);
    assert.deepEqual(looked, ["no-such-model"], "the over-limit call never reached findModel");
  });
});

describe("the lab's serving windows as a DecideBackend (lib/train/decide-window.ts)", () => {
  const target: WindowTarget = { jobId: "5e7e5e7e-0000-4000-8000-00000000000a", tokenHash: "hash", ip: "203.0.113.9", port: 8443, certSha256: "ab".repeat(32) };
  const input = (adapter: string | null): DecideScoreInput => {
    const renderings = decideRenderings({ state: STATE, question: person().question, labels: SIX });
    return { prompts: renderings.map((r) => decidePrompt(r)), letters: renderings.map((r) => [...r.letters]), adapter };
  };

  function windows(over: { slots?: Array<Date | null>; ask?: (...args: unknown[]) => Promise<unknown>; target?: WindowTarget | null } = {}) {
    const log: string[] = [];
    const asked: unknown[][] = [];
    const slots = [...(over.slots ?? [new Date(0)])];
    const backends = windowBackends({
      target: async (adapter) => {
        log.push(`target ${adapter}`);
        return over.target === undefined ? target : over.target;
      },
      takeSlot: async (id) => {
        log.push(`take ${id}`);
        return slots.length ? slots.shift()! : null;
      },
      releaseSlot: async (id) => void log.push(`release ${id}`),
      keyFor: (jobId, hash) => `key:${jobId}:${hash}`,
      ask: (async (...args: unknown[]) => {
        asked.push(args);
        return over.ask ? over.ask(...args) : { base: [[-0.5, -1, -3, -4], [-1, -2, -0.4]], tuned: [[-0.1, -3, -4, -5], [-3, -3, -0.05]], baseMass: [0.8, 0.8], tunedMass: [0.98, 0.98], ms: 640 };
      }) as never,
      slotWaitMs: 300,
      slotPollMs: 20,
    });
    return { backends, log, asked };
  }

  it("scores a person's model with the tuned model and muse-decide with base Glimmer, on the window's one slot", async () => {
    const w = windows();
    const backend = (await w.backends(MODEL_ID))!;
    const got = await backend.score(input(MODEL_ID));
    assert.deepEqual(got, { logprobs: [[-0.1, -3, -4, -5], [-3, -3, -0.05]], ms: 640 });
    const [sentTarget, key, items, timeout] = w.asked[0]!;
    assert.deepEqual(sentTarget, { ip: target.ip, port: 8443, certSha256: target.certSha256 });
    assert.equal(key, `key:${target.jobId}:hash`);
    assert.deepEqual(items, input(MODEL_ID).prompts.map((p, i) => ({ messages: p.messages, letters: input(MODEL_ID).letters[i] })));
    assert.ok(typeof timeout === "number" && timeout <= 30_000 && timeout > 29_000, String(timeout));
    assert.deepEqual(w.log, [`target ${MODEL_ID}`, `take ${target.jobId}`, `release ${target.jobId}`]);

    const base = windows();
    assert.deepEqual((await (await base.backends(null))!.score(input(null))).logprobs, [[-0.5, -1, -3, -4], [-1, -2, -0.4]]);
    assert.equal(await windows({ target: null }).backends(MODEL_ID), null, "no live window: decide_offline");
  });

  it("waits for the slot, then says busy, and always gives it back", async () => {
    const waited = windows({ slots: [null, null, new Date(0)] });
    await (await waited.backends(MODEL_ID))!.score(input(MODEL_ID));
    assert.equal(waited.log.filter((l) => l.startsWith("take")).length, 3);
    const left = waited.asked[0]![3] as number;
    assert.ok(left <= 30_000 - 35, `the slot wait comes off the GPU call's time (${left} ms left)`);
    const gaveUp = windows();
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      (await gaveUp.backends(MODEL_ID))!.score({ ...input(MODEL_ID), signal: ac.signal }),
      (err: unknown) => err instanceof DecideBackendError && err.code === "timeout",
    );
    assert.equal(gaveUp.asked.length, 0, "no GPU call once the gateway stopped waiting");
    assert.deepEqual(gaveUp.log.slice(1), [`take ${target.jobId}`, `release ${target.jobId}`], "and the slot goes back at once");
    const held = windows({ slots: [] });
    await assert.rejects((await held.backends(MODEL_ID))!.score(input(MODEL_ID)), (err: unknown) => err instanceof DecideBackendError && err.code === "busy");
    assert.equal(held.asked.length, 0);
    assert.equal(held.log.filter((l) => l.startsWith("release")).length, 0, "it never held the slot");

    const cases: Array<[ServeError | Error, string | null]> = [
      [new ServeError("busy", "busy", 409), "busy"],
      [new ServeError("stopping", "stopping", 503), "offline"],
      [new ServeError("timeout", "slow"), "timeout"],
      [new ServeError("bad_prompt", "too long", 422), "too_long"],
      [new ServeError("unreachable", "The demo server's connection failed: connect ECONNREFUSED 203.0.113.9:8443"), null],
    ];
    for (const [thrown, code] of cases) {
      const w = windows({ ask: async () => Promise.reject(thrown) });
      await assert.rejects((await w.backends(MODEL_ID))!.score(input(MODEL_ID)), (err: unknown) => {
        if (code) return err instanceof DecideBackendError && err.code === code;
        return err instanceof Error && !(err instanceof DecideBackendError) && !err.message.includes("203.0.113.9") && err.message.includes("[decision GPU]");
      });
      assert.deepEqual(w.log.at(-1), `release ${target.jobId}`, "the slot is given back");
    }
  });
});
