/**
 * The flow engine behind the protocol pages' step-by-step demos: paths into replies, templates that build each step
 * from the replies before it, the checks that hold a reply up to what the page says, and the cost total. Uses real
 * replies saved from the docs proxy (fixtures/). Nothing reaches the network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/protocols/__tests__/flow.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  describeMissing,
  describeValue,
  evalExpr,
  firstStandIn,
  flowCost,
  lookup,
  methodOf,
  pollDone,
  previewTemplate,
  rateLimitWaitMs,
  resolveTemplate,
  retryReason,
  sampleRefs,
  shownFields,
  skipsRecord,
  stepRefs,
  templateExprs,
  verdictOf,
  type FlowContext,
  type FlowStep,
  type StepReply,
} from "@/components/docs/playgrounds/protocols/flow";

const FIX = path.join(import.meta.dirname, "fixtures");
const fixture = (name: string) => JSON.parse(readFileSync(path.join(FIX, name), "utf8")) as Record<string, unknown>;

const basic = fixture("responses-basic.json");
const encrypted = fixture("responses-encrypted.json");
const call = fixture("responses-function-call.json");
const chatCall = fixture("chat-tool-calls.json");
const toolUse = fixture("messages-tool-use.json");

const reply = (json: unknown, status = 200, text = ""): StepReply => ({ status, ok: status < 300, json, text, events: [] });

const ctx = (steps: Record<string, StepReply> = {}): FlowContext => ({
  model: "muse-spark-1.3-contributor",
  vars: { q1: "What is the capital of France?", q2: "What is its population?" },
  steps,
  samples: { "field-report": "data:application/pdf;base64,JVBERi0x" },
});

describe("lookup", () => {
  it("steps into objects, array indexes, the last item and the first item matching a field", () => {
    assert.equal(lookup(basic, "status"), "completed");
    assert.equal(lookup(basic, "usage.output_tokens_details.reasoning_tokens"), 249);
    assert.equal(lookup(basic, "output[0].type"), "reasoning");
    assert.equal(lookup(basic, "output[-1].type"), "message");
    assert.equal(lookup(basic, "output[type=message].content[0].text"), "Paris is the capital of France.");
    assert.match(String(lookup(call, "output[type=function_call].call_id")), /^call_/);
    assert.equal(lookup(chatCall, "choices[0].message.tool_calls[0].function.name"), "get_weather");
    assert.equal(lookup(toolUse, "content[type=tool_use].name"), "get_weather");
  });

  it("is undefined for anything missing, and whole for an empty path", () => {
    assert.equal(lookup(basic, "output[type=function_call].call_id"), undefined);
    assert.equal(lookup(basic, "usage.nope.deeper"), undefined);
    assert.equal(lookup(basic, "output[9]"), undefined);
    assert.equal(lookup(basic, "status[0]"), undefined);
    assert.equal(lookup(basic, ""), basic);
    assert.equal(lookup(null, "a"), undefined);
  });

  it("reads filters whose value has dots in it", () => {
    const v = { data: [{ type: "response.output_text.delta", n: 1 }, { type: "response.completed", n: 2 }] };
    assert.equal(lookup(v, "data[type=response.completed].n"), 2);
  });
});

describe("templates", () => {
  const steps = { turn1: reply(encrypted, 200, "Paris is the capital of France.") };

  it("puts whole values where a string is only a template, and text inside longer strings", () => {
    const r = resolveTemplate(
      {
        model: "{{model}}",
        input: "{{vars.q2}}",
        previous_response_id: "{{turn1.id}}",
        note: "Turn 1 said: {{turn1.$text}} ({{turn1.$status}})",
        usage: "{{turn1.usage}}",
      },
      ctx(steps),
    );
    assert.ok(r.ok);
    assert.deepEqual(r.value, {
      model: "muse-spark-1.3-contributor",
      input: "What is its population?",
      previous_response_id: encrypted.id,
      note: "Turn 1 said: Paris is the capital of France. (200)",
      usage: encrypted.usage,
    });
  });

  it("spreads an earlier reply's output into the next input, for stateless replay", () => {
    const r = resolveTemplate(
      { input: [{ role: "user", content: "{{vars.q1}}" }, { $spread: "turn1.output" }, { role: "user", content: "{{vars.q2}}" }] },
      ctx(steps),
    );
    assert.ok(r.ok);
    const input = (r.value as { input: Array<Record<string, unknown>> }).input;
    assert.deepEqual(
      input.map((i) => i.type ?? i.role),
      ["user", "reasoning", "message", "user"],
    );
    assert.equal(typeof input[1].encrypted_content, "string", "the reasoning item travels with its encrypted_content");
  });

  it("names the first missing value instead of sending a half-built request", () => {
    const r = resolveTemplate({ input: [{ type: "function_call_output", call_id: "{{turn1.output[type=function_call].call_id}}" }] }, ctx(steps));
    assert.deepEqual(r, { ok: false, missing: "turn1.output[type=function_call].call_id" });
    assert.deepEqual(resolveTemplate("responses/{{create.id}}", ctx()), { ok: false, missing: "create.id" });
    const flow: FlowStep[] = [{ id: "turn1", title: "a", path: "responses" }, { id: "turn2", title: "b", path: "responses" }];
    assert.match(describeMissing("turn1.output[type=function_call].call_id", flow), /needs output\[type=function_call\]\.call_id from step 1's reply/);
    assert.match(describeMissing("turn2", flow), /Run step 2 first/);
    assert.match(describeMissing("vars.q1", flow), /Fill in q1/);
  });

  it("takes docs samples as data URLs or bare base64", () => {
    assert.equal(evalExpr("sample:field-report", ctx()), "data:application/pdf;base64,JVBERi0x");
    assert.equal(evalExpr("sample64:field-report", ctx()), "JVBERi0x");
    assert.equal(evalExpr("sample:cat-sofa", ctx()), undefined);
    const step: FlowStep = { id: "f", title: "PDF", path: "responses", body: { a: "{{sample:field-report}}", b: "{{sample64:cat-sofa}}", c: "{{sample:field-report}}" } };
    assert.deepEqual(sampleRefs(step), ["field-report", "cat-sofa"]);
  });

  it("lists the expressions and earlier steps a step reads from", () => {
    const step: FlowStep = { id: "s3", title: "x", path: "responses/{{s1.id}}", body: { input: [{ $spread: "s2.output" }], model: "{{model}}" } };
    assert.deepEqual(templateExprs([step.path, step.body]), ["s1.id", "s2.output", "model"]);
    assert.deepEqual(stepRefs(step, ["s1", "s2", "s3"]), ["s1", "s2"]);
  });

  it("defaults the method from the body", () => {
    assert.equal(methodOf({ id: "a", title: "", path: "responses", body: {} }), "POST");
    assert.equal(methodOf({ id: "a", title: "", path: "responses/x" }), "GET");
    assert.equal(methodOf({ id: "a", title: "", path: "responses/x", method: "DELETE" }), "DELETE");
  });
});

describe("verdicts", () => {
  it("passes a documented 400 and shows what a check found", () => {
    const step: FlowStep = { id: "c", title: "", path: "responses", body: {}, expect: { status: 400 } };
    const bad = reply({ error: { message: "`max_output_tokens` The number must be `>= 16`.", param: "max_output_tokens" } }, 400);
    assert.equal(verdictOf(step, bad).pass, true);
    assert.equal(verdictOf(step, reply(basic)).pass, false, "a 200 where the page says 400 is called out");
  });

  it("checks fields, emptiness and one-of against a real cancel reply", () => {
    const step: FlowStep = {
      id: "cancel",
      title: "",
      path: "responses/x/cancel",
      method: "POST",
      expect: {
        checks: [
          { path: "status", equals: "cancelled", label: "status is cancelled" },
          { path: "output", empty: true, label: "output is empty" },
          { path: "background", oneOf: [true], label: "it ran in the background" },
          { path: "completed_at", present: false, label: "no completed_at" },
        ],
      },
    };
    const v = verdictOf(step, reply(fixture("responses-cancel.json")));
    assert.equal(v.pass, true);
    assert.deepEqual(
      v.checks.map((c) => c.actual),
      ['status: "cancelled"', "output: an empty array", "background: true", "completed_at: missing"],
    );
  });

  it("lists the events a stream should carry", () => {
    const step: FlowStep = { id: "s", title: "", path: "responses", stream: true, expect: { events: ["response.created", "response.completed", "response.failed"] } };
    const v = verdictOf(step, { ...reply(basic), events: ["response.created", "response.output_text.delta", "response.completed"] });
    assert.deepEqual(v.events, [
      { type: "response.created", seen: true },
      { type: "response.completed", seen: true },
      { type: "response.failed", seen: false },
    ]);
    assert.equal(v.pass, false);
  });

  it("knows when a poll is done and lists the fields a step shows", () => {
    assert.equal(pollDone({ path: "status", until: ["completed", "failed"] }, { status: "in_progress" }), false);
    assert.equal(pollDone({ path: "status", until: ["completed", "failed"] }, basic), true);
    assert.deepEqual(shownFields({ id: "a", title: "", path: "", show: ["id", "store", "usage.input_tokens"] }, basic), [
      { path: "id", value: `"${basic.id}"` },
      { path: "store", value: "true" },
      { path: "usage.input_tokens", value: "18" },
    ]);
  });

  it("describes values briefly", () => {
    assert.equal(describeValue("x".repeat(100), 20), `"${"x".repeat(17)}..." (100 characters)`);
    assert.equal(describeValue([1, 2]), "an array of 2");
    assert.equal(describeValue({ a: 1, b: 2 }), "an object (a, b)");
    assert.equal(describeValue(undefined), "missing");
  });

  it("passes a 400 only when the error names the documented field", () => {
    const step: FlowStep = {
      id: "mix",
      title: "",
      path: "responses",
      body: {},
      expect: { status: 400, checks: [{ path: "error.param", matches: "(^|[.\\]])include(\\[\\d+\\])?$", label: "error.param names include" }] },
    };
    const err = (param: string | null, message = "x") => reply({ error: { type: "invalid_request_error", message, param } }, 400);
    assert.equal(verdictOf(step, err("include")).pass, true);
    assert.equal(verdictOf(step, err("include[0]")).pass, true, "an indexed param counts");
    // The storage-lag 400 a check right after a create can get is another 400: it doesn't pass as this one.
    assert.equal(verdictOf(step, err(null, "referenced response not found or expired")).pass, false);
    const callId: FlowStep = { ...step, expect: { status: 400, checks: [{ path: "error.param", matches: "(^|[.\\]])call_id(\\[\\d+\\])?$", label: "" }] } };
    assert.equal(verdictOf(callId, err("input[1].call_id")).pass, true);
    assert.equal(verdictOf(callId, err("tool_call_id")).pass, false, "a longer name ending the same way isn't it");
    const message: FlowStep = { ...step, expect: { status: 400, checks: [{ path: "error.message", matches: "top_k", label: "" }] } };
    assert.equal(verdictOf(message, reply({ type: "error", error: { type: "invalid_request_error", message: "`top_k` is not supported" } }, 400)).pass, true);
    assert.equal(verdictOf(message, reply({ type: "error", error: { type: "invalid_request_error", message: "unknown parameter `foo`" } }, 400)).pass, false);
  });
});

describe("rate limits and retries", () => {
  const step: FlowStep = { id: "a", title: "", path: "responses", body: {} };
  const limited = { code: "rate_limited", retryAfterSec: 12, message: "Live demos are limited to 20 runs a minute. Try again in 12 s." };

  it("waits out a per-minute 429 once, but not a daily limit or a spent budget", () => {
    assert.equal(rateLimitWaitMs(429, limited), 12_500);
    assert.equal(rateLimitWaitMs(429, { code: "model_busy", retryAfterSec: 40 }), 40_500);
    assert.equal(rateLimitWaitMs(429, { code: "rate_limited", retryAfterSec: 50_000 }), null, "the daily limit resets at midnight");
    assert.equal(rateLimitWaitMs(429, { code: "ip_budget", retryAfterSec: 30 }), null, "a spent budget doesn't come back in a minute");
    assert.equal(rateLimitWaitMs(429, { code: "rate_limited" }), null, "no retry-after, no wait");
    assert.equal(rateLimitWaitMs(400, limited), null);
    assert.equal(retryReason(step, 429, { listed: 2, transient: 1, rate: 1 }, limited), "rate");
    assert.equal(retryReason(step, 429, { listed: 2, transient: 1, rate: 0 }, limited), null, "once only: after that the run stops");
    assert.equal(retryReason(step, 429, { listed: 2, transient: 1 }, limited), null, "callers without a rate budget keep the old behavior");
    assert.equal(retryReason({ ...step, expect: { status: 429 } }, 429, { listed: 2, transient: 1, rate: 1 }, limited), null, "an expected status isn't retried");
    assert.equal(retryReason(step, 503, { listed: 2, transient: 1, rate: 1 }), "transient");
    assert.equal(retryReason({ ...step, retry: { statuses: [404] } }, 404, { listed: 1, transient: 1, rate: 1 }), "listed");
  });

  it("keeps documented-error checks and clean-ups out of the copy prompt", () => {
    assert.equal(skipsRecord({ ...step, expect: { status: 400 } }), true);
    assert.equal(skipsRecord({ ...step, expect: { status: 404 } }), true);
    assert.equal(skipsRecord({ ...step, method: "DELETE", cleanup: true }), true);
    assert.equal(skipsRecord({ ...step, expect: { status: [200, 400] } }), false, "a late cancel may succeed: it's a real request");
    assert.equal(skipsRecord(step), false);
  });
});

describe("previewTemplate", () => {
  const steps: FlowStep[] = [
    { id: "turn1", title: "", path: "responses", body: {} },
    { id: "call", title: "", path: "messages", body: {} },
    { id: "chat", title: "", path: "chat/completions", body: {} },
  ];
  const before = { model: "muse-spark-1.3-contributor", vars: { q: "Hi" }, steps: {} };

  it("fills in what's known before a run and shows stand-ins for what earlier replies supply", () => {
    const body = {
      model: "{{model}}",
      input: "{{vars.q}}",
      previous_response_id: "{{turn1.id}}",
      call: "{{turn1.output[type=function_call].call_id}}",
      tool: "{{call.content[type=tool_use].id}}",
      toolCall: "{{chat.choices[0].message.tool_calls[0].id}}",
      reasoning: "{{turn1.output[type=reasoning].id}}",
      message: "{{turn1.output[type=message]}}",
      replay: [{ role: "user", content: "x" }, { $spread: "turn1.output" }],
      image: "{{sample:cat-sofa}}",
      bare: "{{sample64:cat-sofa}}",
    };
    const p = previewTemplate({ path: "responses/{{turn1.id}}/cancel", body }, before, steps);
    assert.equal(p.pending, true);
    assert.equal(p.value.path, "responses/resp_from_step_1/cancel");
    assert.deepEqual(p.value.body, {
      model: "muse-spark-1.3-contributor",
      input: "Hi",
      previous_response_id: "resp_from_step_1",
      call: "call_from_step_1",
      tool: "toolu_from_step_2",
      toolCall: "call_from_step_3",
      reasoning: "rs_from_step_1",
      message: "<output[type=message] from step 1>",
      replay: [{ role: "user", content: "x" }, "<each item of output from step 1>"],
      image: "data:image/jpeg;base64,<BASE64>",
      bare: "<BASE64>",
    });
    assert.equal(firstStandIn(p.value), "resp_from_step_1");
    assert.deepEqual(previewTemplate({ model: "{{model}}", input: "{{vars.q}}" }, before, steps), { value: { model: "muse-spark-1.3-contributor", input: "Hi" }, pending: false });
  });

  it("uses the real values once the steps they come from have run", () => {
    const encrypted = fixture("responses-encrypted.json");
    const p = previewTemplate({ previous_response_id: "{{turn1.id}}", input: [{ $spread: "turn1.output" }] }, { ...before, steps: { turn1: reply(encrypted) } }, steps);
    assert.equal(p.pending, false);
    assert.equal(p.value.previous_response_id, encrypted.id);
    assert.equal(p.value.input.length, (encrypted.output as unknown[]).length);
    assert.equal(firstStandIn(p.value), null);
  });
});

describe("flowCost", () => {
  it("counts each response once, keeping the usage when a later reply for it has none", () => {
    const polled = { ...basic };
    const deleted = { id: basic.id, object: "response.deleted", deleted: true };
    const one = flowCost([{ model: null, json: basic }]);
    const many = flowCost([
      { model: null, json: { id: basic.id, status: "queued" } },
      { model: null, json: polled },
      { model: null, json: polled },
      { model: null, json: deleted },
    ]);
    assert.ok(one.usd > 0);
    assert.equal(many.usd, one.usd);
    assert.equal(many.tokens, 283);
    assert.equal(many.calls, 4);
  });

  it("adds replies without an id, prices web searches and reads a stream's collected usage", () => {
    const search = fixture("responses-web-search.json");
    const withSearch = flowCost([{ model: null, json: search }]);
    assert.ok(withSearch.usd >= 0.0025, "a search adds $0.0025");
    const counted = flowCost([
      { model: "muse-spark-1.3-contributor", json: { input_tokens: 172, object: "response.input_tokens" } },
      { model: "muse-spark-1.3-contributor", json: null, usage: { prompt_tokens: 10, completion_tokens: 20 } },
    ]);
    assert.equal(counted.tokens, 30, "a token count has no usage of its own");
  });
});
