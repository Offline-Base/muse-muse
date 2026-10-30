/**
 * The mock tools (steady answers, nothing sent anywhere) and the tool loop's sequence for Responses
 * (previous_response_id plus function_call_output) and Chat Completions (assistant tool_calls plus tool messages).
 *
 *   npx tsx --test --experimental-test-module-mocks lib/docs/client/__tests__/tools-loop.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NeutralRequest } from "@/lib/docs/client/body";
import type { Collected } from "@/lib/docs/client/stream";
import { collectReply } from "@/lib/docs/client/stream";
import { finalAnswer, nextAction, nextModelBody, type LoopStep } from "@/lib/docs/client/toolloop";
import { MOCK_TOOLS, rankDocs, resolveTools, runToolCall } from "@/lib/docs/client/tools";

describe("mock tools", () => {
  it("answers get_weather the same way every time for a city", async () => {
    const { location: _a, ...a } = (await MOCK_TOOLS.get_weather.run({ location: "Seattle" })) as Record<string, unknown>;
    const { location: _b, ...b } = (await MOCK_TOOLS.get_weather.run({ location: "seattle " })) as Record<string, unknown>;
    assert.deepEqual(a, b);
    assert.deepEqual([_a, _b], ["Seattle", "seattle"]);
    assert.match((a as { temperature: string }).temperature, /^\d+°C$/);
    assert.match((await MOCK_TOOLS.get_weather.run({ location: "Seattle", unit: "fahrenheit" }) as { temperature: string }).temperature, /°F$/);
  });

  it("runs the calculator through the safe parser and reports its errors", async () => {
    assert.deepEqual(await MOCK_TOOLS.calculator.run({ expression: "0.1 + 0.2" }), { expression: "0.1 + 0.2", result: 0.3 });
    const bad = (await MOCK_TOOLS.calculator.run({ expression: "process.exit()" })) as { error: string };
    assert.match(bad.error, /Unexpected "\."/);
    const name = (await MOCK_TOOLS.calculator.run({ expression: "process" })) as { error: string };
    assert.match(name.error, /Unknown name "process"/);
  });

  it("never sends email", async () => {
    const out = (await MOCK_TOOLS.send_email.run({ to: "a@example.com", subject: "Hi", body: "Hello there" })) as Record<string, unknown>;
    assert.equal(out.status, "not_sent");
    assert.match(String(out.note), /No email was sent/);
  });

  it("tells a bad time zone from a good one", async () => {
    assert.ok("local_time" in ((await MOCK_TOOLS.get_time.run({ timezone: "Asia/Tokyo" })) as object));
    assert.ok("error" in ((await MOCK_TOOLS.get_time.run({ timezone: "Mars/Olympus" })) as object));
  });

  it("ranks docs pages by shared words, titles counting double", () => {
    const pages = [
      { title: "Tool calling", url: "/docs/tool-calling", text: "Define functions and send results back." },
      { title: "Reasoning", url: "/docs/reasoning", text: "Effort levels; tool loops keep reasoning." },
      { title: "Pricing", url: "/docs/pricing-rate-limits", text: "Prices per token." },
    ];
    assert.deepEqual(rankDocs(pages, "how does tool calling work").map((r) => r.url), ["/docs/tool-calling", "/docs/reasoning"]);
    assert.deepEqual(rankDocs(pages, "a"), []);
  });

  it("resolves names, page definitions and fixed results", async () => {
    const tools = resolveTools(
      ["get_weather", { name: "lookup_order", result: { status: "shipped" } }, { name: "book_table", description: "Book a table.", parameters: { type: "object", properties: {} } }],
      { get_weather: { temperature: "15°C", condition: "Cloudy" } },
    );
    assert.deepEqual(tools.map((t) => [t.def.name, t.builtIn]), [["get_weather", false], ["lookup_order", false], ["book_table", false]]);
    assert.equal(tools[0].def.description, MOCK_TOOLS.get_weather.description, "a fixed result keeps the built-in's definition");
    assert.deepEqual(await tools[0].run({ location: "Paris" }), { temperature: "15°C", condition: "Cloudy" });
    assert.deepEqual(await tools[1].run({}), { status: "shipped" });
    const echo = (await tools[2].run({ party: 2 })) as Record<string, unknown>;
    assert.deepEqual(echo.arguments, { party: 2 });
    assert.equal(resolveTools(["calculator"])[0].builtIn, true);
  });

  it("turns a call into the text sent back, and survives bad arguments", async () => {
    const tools = resolveTools(["calculator"]);
    const ok = await runToolCall(tools, "calculator", '{"expression": "6*7"}');
    assert.equal(ok.ok, true);
    assert.equal(ok.output, '{"expression":"6*7","result":42}');
    const bad = await runToolCall(tools, "calculator", "{not json");
    assert.equal(bad.ok, false);
    assert.match(bad.output, /weren't valid JSON/);
    const missing = await runToolCall(tools, "nope", "{}");
    assert.deepEqual(missing.value, { error: 'There is no tool named "nope".' });
  });
});

const base: NeutralRequest = {
  model: "muse-spark-1.3-contributor",
  system: "Use the tools.",
  messages: [{ role: "user", content: "What is the weather in Seattle?" }],
  tools: resolveTools(["get_weather"]).map((t) => t.def),
};

function modelStep(call: number, collected: Collected, body: Record<string, unknown> = {}): LoopStep {
  return { kind: "model", call, body, collected, status: 200 };
}

const responsesCall = collectReply("responses", {
  id: "resp_1",
  object: "response",
  status: "completed",
  output: [{ id: "fc_1", type: "function_call", call_id: "call_abc123", name: "get_weather", arguments: '{"location":"Seattle"}', status: "completed" }],
});
const responsesAnswer = collectReply("responses", {
  id: "resp_2",
  object: "response",
  status: "completed",
  output: [{ id: "msg_1", type: "message", content: [{ type: "output_text", text: "It is 15°C and cloudy in Seattle." }] }],
});

describe("tool loop", () => {
  it("steps model, tools, model, then done", async () => {
    const steps: LoopStep[] = [];
    assert.equal(nextAction(steps, 4), "model");
    steps.push({ kind: "model", call: 1, body: {}, collected: null });
    assert.equal(nextAction(steps, 4), "busy");
    steps[0] = modelStep(1, responsesCall);
    assert.equal(nextAction(steps, 4), "tools");
    const run = await runToolCall(resolveTools(["get_weather"]), "get_weather", responsesCall.toolCalls[0].arguments);
    steps.push({ kind: "tools", results: [{ call: responsesCall.toolCalls[0], run }] });
    assert.equal(nextAction(steps, 4), "model");
    assert.equal(nextAction(steps, 1), "limit");
    steps.push(modelStep(2, responsesAnswer));
    assert.equal(nextAction(steps, 4), "done");
    assert.equal(finalAnswer(steps), "It is 15°C and cloudy in Seattle.");
  });

  it("stops on an error reply", () => {
    const failed: Collected = { ...responsesAnswer, error: { code: "server_error", message: "boom" } };
    assert.equal(nextAction([modelStep(1, failed)], 4), "done");
  });

  it("continues a Responses loop with previous_response_id and function_call_output, resending instructions and tools", () => {
    const first = nextModelBody("responses", base, []);
    assert.equal(first.input, "What is the weather in Seattle?");
    const steps: LoopStep[] = [
      modelStep(1, responsesCall),
      { kind: "tools", results: [{ call: responsesCall.toolCalls[0], run: { ok: true, output: '{"temperature":"15°C"}', value: {}, ms: 1 } }] },
    ];
    const body = nextModelBody("responses", base, steps);
    assert.equal(body.previous_response_id, "resp_1");
    assert.equal(body.instructions, "Use the tools.");
    assert.deepEqual(body.input, [{ type: "function_call_output", call_id: "call_abc123", output: '{"temperature":"15°C"}' }]);
    assert.ok(Array.isArray(body.tools));
  });

  it("replays a Chat Completions loop with the assistant's tool_calls and one tool message per call", () => {
    const chatCalls = collectReply("chat", {
      id: "chatcmpl-1",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"location":"Seattle"}' } },
              { id: "call_b", type: "function", function: { name: "get_weather", arguments: '{"location":"Tokyo"}' } },
            ],
          },
        },
      ],
    });
    const run = (output: string) => ({ ok: true, output, value: {}, ms: 1 });
    const steps: LoopStep[] = [
      modelStep(1, chatCalls),
      { kind: "tools", results: [{ call: chatCalls.toolCalls[0], run: run("A") }, { call: chatCalls.toolCalls[1], run: run("B") }] },
    ];
    const body = nextModelBody("chat", { ...base, parallelToolCalls: true }, steps);
    assert.deepEqual(body.messages, [
      { role: "developer", content: "Use the tools." },
      { role: "user", content: "What is the weather in Seattle?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"location":"Seattle"}' } },
          { id: "call_b", type: "function", function: { name: "get_weather", arguments: '{"location":"Tokyo"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: "A" },
      { role: "tool", tool_call_id: "call_b", content: "B" },
    ]);
    assert.equal(body.parallel_tool_calls, true);
  });
});
