/**
 * Request bodies for the three protocols from the neutral shape, checked against the field names and placement on
 * the mirrored protocol pages, and mergeBody for a page's extraBody.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/docs/client/__tests__/body.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBody, chatBody, mergeBody, messagesBody, responsesBody, type NeutralRequest } from "@/lib/docs/client/body";

const weather = {
  name: "get_weather",
  description: "Return current weather for the given location.",
  parameters: { type: "object", properties: { location: { type: "string", description: "City name" } }, required: ["location"] },
};
const address = { name: "Address", schema: { type: "object", properties: { street: { type: "string" } }, required: ["street"] }, strict: true };
const ask = (over: Partial<NeutralRequest> = {}): NeutralRequest => ({
  model: "muse-spark-1.3-contributor",
  messages: [{ role: "user", content: "What is the capital of France?" }],
  ...over,
});

describe("Responses bodies", () => {
  it("sends a single question as a plain input string", () => {
    assert.deepEqual(responsesBody(ask()), { model: "muse-spark-1.3-contributor", input: "What is the capital of France?" });
  });

  it("puts instructions, reasoning, tools, text.format, the token limit and stream where the Responses API wants them", () => {
    const body = responsesBody(
      ask({ system: "Be brief.", effort: "low", summary: "auto", tools: [weather], parallelToolCalls: false, schema: address, maxOutputTokens: 2048, stream: true }),
    );
    assert.deepEqual(body, {
      model: "muse-spark-1.3-contributor",
      instructions: "Be brief.",
      input: "What is the capital of France?",
      reasoning: { effort: "low", summary: "auto" },
      tools: [{ type: "function", ...weather }],
      parallel_tool_calls: false,
      text: { format: { type: "json_schema", name: "Address", schema: address.schema, strict: true } },
      max_output_tokens: 2048,
      stream: true,
    });
  });

  it("replays history as typed items, assistant turns as output_text", () => {
    const body = responsesBody(
      ask({
        messages: [
          { role: "user", content: "What is the capital of France?" },
          { role: "assistant", content: "The capital of France is Paris." },
          { role: "user", content: "What is its population?" },
        ],
      }),
    );
    assert.deepEqual(body.input, [
      { role: "user", content: "What is the capital of France?" },
      { role: "assistant", content: [{ type: "output_text", text: "The capital of France is Paris." }] },
      { role: "user", content: "What is its population?" },
    ]);
  });

  it("sends only the newest question with previous_response_id", () => {
    const body = responsesBody(
      ask({
        previousResponseId: "resp_abc123",
        messages: [
          { role: "user", content: "What is the capital of France?" },
          { role: "assistant", content: "Paris." },
          { role: "user", content: "What is the population of that city?" },
        ],
      }),
    );
    assert.equal(body.input, "What is the population of that city?");
    assert.equal(body.previous_response_id, "resp_abc123");
  });

  it("leaves strict out unless the page sets it, and drops blank instructions", () => {
    const body = responsesBody(ask({ system: "   ", schema: { name: "A", schema: { type: "object" } } }));
    assert.equal("instructions" in body, false);
    assert.deepEqual(body.text, { format: { type: "json_schema", name: "A", schema: { type: "object" } } });
  });
});

describe("Chat Completions bodies", () => {
  it("uses a developer message, reasoning_effort, nested tools, response_format and max_completion_tokens", () => {
    const body = chatBody(ask({ system: "Be brief.", effort: "high", tools: [weather], schema: address, maxOutputTokens: 512 }));
    assert.deepEqual(body, {
      model: "muse-spark-1.3-contributor",
      messages: [
        { role: "developer", content: "Be brief." },
        { role: "user", content: "What is the capital of France?" },
      ],
      reasoning_effort: "high",
      tools: [{ type: "function", function: weather }],
      response_format: { type: "json_schema", json_schema: { name: "Address", schema: address.schema, strict: true } },
      max_completion_tokens: 512,
    });
  });

  it("asks for the usage chunk when it streams", () => {
    const body = chatBody(ask({ stream: true }));
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  });
});

describe("Messages bodies", () => {
  it("always sets max_tokens, which Messages requires", () => {
    assert.deepEqual(messagesBody(ask()), {
      model: "muse-spark-1.3-contributor",
      max_tokens: 4096,
      messages: [{ role: "user", content: "What is the capital of France?" }],
    });
    assert.equal(messagesBody(ask({ maxOutputTokens: 1024 })).max_tokens, 1024);
  });

  it("maps effort to thinking plus output_config.effort, and minimal to low", () => {
    const body = messagesBody(ask({ system: "Be brief.", effort: "minimal", schema: address }));
    assert.equal(body.system, "Be brief.");
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.deepEqual(body.output_config, { effort: "low", format: { type: "json_schema", schema: address.schema } });
  });

  it("sends tools with input_schema, and turns off parallel calls through tool_choice", () => {
    const body = messagesBody(ask({ tools: [weather], parallelToolCalls: false, stream: true }));
    assert.deepEqual(body.tools, [{ name: "get_weather", description: weather.description, input_schema: weather.parameters }]);
    assert.deepEqual(body.tool_choice, { type: "auto", disable_parallel_tool_use: true });
    assert.equal(body.stream, true);
  });
});

describe("buildBody and mergeBody", () => {
  it("picks the builder for the protocol", () => {
    assert.equal("input" in buildBody("responses", ask()), true);
    assert.equal("messages" in buildBody("chat", ask()), true);
    assert.equal("max_tokens" in buildBody("messages", ask()), true);
  });

  it("joins tools and include, merges objects, and lets the page win elsewhere", () => {
    const base = { model: "m", tools: [{ type: "function", name: "a" }], include: ["x"], reasoning: { effort: "low" }, stream: true };
    const extra = { tools: [{ type: "web_search" }], include: ["x", "web_search_call.results"], reasoning: { summary: "auto" }, stream: false, skip: undefined };
    const merged = mergeBody(base, extra);
    assert.deepEqual(merged, {
      model: "m",
      tools: [{ type: "function", name: "a" }, { type: "web_search" }],
      include: ["x", "web_search_call.results"],
      reasoning: { effort: "low", summary: "auto" },
      stream: false,
    });
    assert.deepEqual(base.tools, [{ type: "function", name: "a" }], "the base is not changed");
    assert.deepEqual(mergeBody(base, null), base);
    assert.deepEqual(mergeBody({ text: { format: { type: "text" } } }, { text: { format: { type: "json_schema", name: "A" } } }), {
      text: { format: { type: "json_schema", name: "A" } },
    });
  });
});
