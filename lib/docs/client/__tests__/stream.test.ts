/**
 * The three protocol readers on event sequences shaped like the mirrored docs' schemas and examples
 * (api-reference/responses/schemas stream events, chat-completions chunks, Anthropic message events), fed through the
 * real SSE splitter in odd chunk sizes, plus whole replies from the docs' "Example response" blocks.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/docs/client/__tests__/stream.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sseReader } from "@/lib/docs/client/api";
import {
  chatCollector,
  collectReply,
  imageMime,
  messagesCollector,
  protocolOfPath,
  protocolOfReply,
  responsesCollector,
  type Collector,
} from "@/lib/docs/client/stream";

/** SSE text for events, Responses-style (event line plus data) or data-only (Chat). */
function sse(events: Array<Record<string, unknown> | string>, named = true): string {
  return events
    .map((e) => {
      if (typeof e === "string") return `data: ${e}\n\n`;
      const type = typeof e.type === "string" ? e.type : null;
      return `${named && type ? `event: ${type}\n` : ""}data: ${JSON.stringify(e)}\n\n`;
    })
    .join("");
}

/** Feeds SSE text into a collector in chunks of `size` characters, the way a network read splits it. */
function feed(collector: Collector, text: string, size = 7) {
  const reader = sseReader((e) => collector.push(e));
  for (let i = 0; i < text.length; i += size) reader.push(text.slice(i, i + size));
  reader.end();
  return collector.snapshot();
}

// From protocols/responses "Example response".
const exampleResponse = {
  id: "resp_abc123",
  object: "response",
  created_at: 1714502400,
  status: "completed",
  model: "muse-spark-1.3",
  output: [
    {
      id: "msg_abc123:456",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "The capital of France is **Paris**.", annotations: [] }],
    },
  ],
  usage: { input_tokens: 69, output_tokens: 163, total_tokens: 232 },
};

describe("Responses reader", () => {
  it("collects output text deltas, the id, the model and the final usage", () => {
    const usage = { input_tokens: 69, input_tokens_details: { cached_tokens: 0 }, output_tokens: 163, output_tokens_details: { reasoning_tokens: 150 }, total_tokens: 232 };
    const text = sse([
      { type: "response.created", sequence_number: 0, response: { id: "resp_abc123", object: "response", status: "in_progress", model: "muse-spark-1.3-contributor", output: [] } },
      { type: "response.in_progress", sequence_number: 1, response: { id: "resp_abc123", status: "in_progress" } },
      { type: "response.output_item.added", sequence_number: 2, output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] } },
      { type: "response.content_part.added", sequence_number: 3, item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", sequence_number: 4, item_id: "msg_1", output_index: 0, content_index: 0, delta: "The capital ", logprobs: [] },
      { type: "response.output_text.delta", sequence_number: 5, item_id: "msg_1", output_index: 0, content_index: 0, delta: "of France is ", logprobs: [] },
      { type: "response.output_text.delta", sequence_number: 6, item_id: "msg_1", output_index: 0, content_index: 0, delta: "**Paris**.", logprobs: [] },
      { type: "response.output_text.done", sequence_number: 7, item_id: "msg_1", output_index: 0, content_index: 0, text: "The capital of France is **Paris**.", logprobs: [] },
      { type: "response.output_item.done", sequence_number: 8, output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "The capital of France is **Paris**.", annotations: [] }] } },
      {
        type: "response.completed",
        sequence_number: 9,
        response: { ...exampleResponse, model: "muse-spark-1.3-contributor", usage },
      },
      "[DONE]",
    ]);
    const c = feed(responsesCollector(), text);
    assert.equal(c.text, "The capital of France is **Paris**.");
    assert.equal(c.id, "resp_abc123");
    assert.equal(c.model, "muse-spark-1.3-contributor");
    assert.equal(c.status, "completed");
    assert.deepEqual(c.usage, usage);
    assert.equal(c.done, true);
    assert.equal(c.error, null);
    assert.equal((c.final as { object?: string }).object, "response");
  });

  it("shows text as it arrives, before the terminal event", () => {
    const col = responsesCollector();
    col.push({ type: "response.created", response: { id: "resp_1", status: "in_progress", model: "m" } });
    col.push({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hel" });
    assert.equal(col.snapshot().text, "Hel");
    col.push({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "lo" });
    const c = col.snapshot();
    assert.equal(c.text, "Hello");
    assert.equal(c.done, false);
    assert.equal(c.status, "in_progress");
  });

  it("collects the reasoning summary from reasoning_summary_text deltas", () => {
    const text = sse([
      { type: "response.created", response: { id: "resp_r", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } },
      { type: "response.reasoning_summary_part.added", item_id: "rs_1", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "Assume sqrt(2) = p/q " },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "in lowest terms." },
      { type: "response.reasoning_summary_text.done", item_id: "rs_1", output_index: 0, summary_index: 0, text: "Assume sqrt(2) = p/q in lowest terms." },
      { type: "response.output_item.added", output_index: 1, item: { id: "msg_2", type: "message", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_2", output_index: 1, content_index: 0, delta: "Suppose it is rational." },
      { type: "response.completed", response: { id: "resp_r", object: "response", status: "completed", output: [] } },
    ]);
    const c = feed(responsesCollector(), text, 11);
    assert.equal(c.reasoning, "Assume sqrt(2) = p/q in lowest terms.");
    // The terminal response had an empty output here, so what streamed stays.
    assert.equal(c.text, "Suppose it is rational.");
  });

  it("streams function call arguments and keeps the call_id to answer with", () => {
    const col = responsesCollector();
    const events = [
      { type: "response.created", response: { id: "resp_fc", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { id: "fc_1", type: "function_call", status: "in_progress", call_id: "call_abc123", name: "get_weather", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"location":' },
    ];
    for (const e of events) col.push(e);
    const mid = col.snapshot();
    assert.equal(mid.toolCalls.length, 1);
    assert.equal(mid.toolCalls[0].arguments, '{"location":');
    assert.equal(mid.toolCalls[0].done, false);

    col.push({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: ' "Seattle"}' });
    col.push({ type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, name: "get_weather", arguments: '{"location": "Seattle"}' });
    col.push({
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "fc_1", type: "function_call", status: "completed", call_id: "call_abc123", name: "get_weather", arguments: '{"location": "Seattle"}' },
    });
    col.push({
      type: "response.completed",
      response: {
        id: "resp_fc",
        object: "response",
        status: "completed",
        output: [{ id: "fc_1", type: "function_call", status: "completed", call_id: "call_abc123", name: "get_weather", arguments: '{"location": "Seattle"}' }],
        usage: { input_tokens: 85, output_tokens: 24, total_tokens: 109 },
      },
    });
    const c = col.snapshot();
    assert.deepEqual(c.toolCalls, [
      { id: "fc_1", callId: "call_abc123", name: "get_weather", arguments: '{"location": "Seattle"}', done: true, kind: "function" },
    ]);
    assert.equal(c.text, "");
  });

  it("tracks web search calls and url_citation annotations (search-grounding example)", () => {
    const answer =
      "**Muse Spark** was announced by Meta on **Wednesday, April 8, 2026**.\n\n- It was unveiled as the first AI model from Meta's new \"Muse\" family";
    const citation = {
      type: "url_citation",
      url: "https://www.techtarget.com/searchcio/feature/Weekly-news-roundup-Claude-Mythos-concerns-Muse-Spark-debut-and-US-infrastructure-disruption",
      title: "Weekly news roundup: Claude Mythos concerns, Muse Spark debut and U.S. infrastructure disruption | TechTarget",
      start_index: 38,
      end_index: 76,
    };
    const col = responsesCollector();
    for (const e of [
      { type: "response.created", response: { id: "resp_123", status: "in_progress", model: "muse-spark-1.3" } },
      { type: "response.output_item.added", output_index: 0, item: { id: "ws_789", type: "web_search_call", status: "in_progress" } },
      { type: "response.web_search_call.in_progress", output_index: 0, item_id: "ws_789" },
      { type: "response.web_search_call.searching", output_index: 0, item_id: "ws_789" },
    ]) {
      col.push(e);
    }
    assert.equal(col.snapshot().searches[0].status, "searching");
    for (const e of [
      { type: "response.web_search_call.completed", output_index: 0, item_id: "ws_789" },
      { type: "response.output_item.done", output_index: 0, item: { id: "ws_789", type: "web_search_call", status: "completed" } },
      { type: "response.output_item.added", output_index: 1, item: { id: "msg_b4", type: "message", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_b4", output_index: 1, content_index: 0, delta: answer },
      { type: "response.output_text.annotation.added", item_id: "msg_b4", output_index: 1, content_index: 0, annotation_index: 0, annotation: citation },
    ]) {
      col.push(e);
    }
    const mid = col.snapshot();
    assert.equal(mid.searches[0].status, "completed");
    assert.equal(mid.citations.length, 1);
    assert.equal(mid.citations[0].start, 38);

    col.push({
      type: "response.completed",
      response: {
        id: "resp_123",
        object: "response",
        status: "completed",
        model: "muse-spark-1.3",
        output: [
          { id: "ws_789", type: "web_search_call", status: "completed" },
          { id: "msg_b4", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: answer, annotations: [citation] }] },
        ],
      },
    });
    const c = col.snapshot();
    assert.equal(c.text, answer);
    assert.deepEqual(c.citations, [{ url: citation.url, title: citation.title, start: 38, end: 76, quote: undefined }]);
    assert.deepEqual(c.searches.map((s) => [s.id, s.status]), [["ws_789", "completed"]]);
  });

  it("reads raw search results when web_search_call.results is included", () => {
    const c = collectReply("responses", {
      id: "resp_s",
      object: "response",
      status: "completed",
      output: [
        {
          id: "ws_789",
          type: "web_search_call",
          status: "completed",
          results: [{ type: "text_result", title: "2026 British Grand Prix", url: "https://en.wikipedia.org/wiki/2026_British_Grand_Prix", snippet: "Leclerc took his ninth Formula One victory" }],
        },
      ],
    });
    assert.deepEqual(c.searches[0].results, [
      { url: "https://en.wikipedia.org/wiki/2026_British_Grand_Prix", title: "2026 British Grand Prix", snippet: "Leclerc took his ninth Formula One victory" },
    ]);
  });

  it("collects generated images from image_generation_call items (image-generation example)", () => {
    const c = collectReply("responses", {
      id: "resp_abc123",
      object: "response",
      status: "completed",
      output: [
        { type: "reasoning", id: "rs_xxx", summary: [{ type: "summary_text", text: "Looked up the current table and each crest, then laid out the panel." }], status: "completed" },
        { type: "message", id: "msg_xxx", role: "assistant", content: [], status: "completed" },
        { type: "image_generation_call", id: "ig_xxx", status: "completed", result: "UklGRiQAAABXRUJQ" },
      ],
    });
    assert.equal(c.reasoning, "Looked up the current table and each crest, then laid out the panel.");
    assert.deepEqual(c.images, [{ id: "ig_xxx", b64: "UklGRiQAAABXRUJQ", mime: "image/webp" }]);
    assert.equal(imageMime("iVBORw0KGgo"), "image/png");
    assert.equal(imageMime("/9j/4AAQ"), "image/jpeg");
  });

  it("reports a failed response and an error event", () => {
    const failed = responsesCollector();
    failed.push({
      type: "response.failed",
      response: { id: "resp_f", object: "response", status: "failed", output: [], error: { code: "server_error", message: "The model hit an internal error." } },
    });
    assert.deepEqual(failed.snapshot().error, { code: "server_error", message: "The model hit an internal error." });
    assert.equal(failed.snapshot().status, "failed");

    const errored = responsesCollector();
    errored.push({ type: "error", code: "rate_limit_exceeded", message: "Slow down.", param: null, sequence_number: 3 });
    assert.deepEqual(errored.snapshot().error, { code: "rate_limit_exceeded", message: "Slow down." });
  });

  it("reads a whole response handed over as one event, and the docs' example response", () => {
    const col = responsesCollector();
    col.push({ event: null, data: JSON.stringify(exampleResponse), json: exampleResponse });
    const c = col.snapshot();
    assert.equal(c.text, "The capital of France is **Paris**.");
    assert.equal(c.done, true);
    const whole = collectReply("responses", exampleResponse);
    assert.equal(whole.text, "The capital of France is **Paris**.");
    assert.deepEqual(whole.usage, { input_tokens: 69, output_tokens: 163, total_tokens: 232 });
    assert.equal(protocolOfReply(exampleResponse), "responses");
  });

  it("ignores keepalive events and joins separate messages with a blank line", () => {
    const col = responsesCollector();
    col.push({ type: "keepalive", sequence_number: 1 });
    col.push({ type: "response.output_text.delta", item_id: "msg_a", output_index: 0, content_index: 0, delta: "Let me check the weather first." });
    col.push({ type: "response.output_text.delta", item_id: "msg_b", output_index: 2, content_index: 0, delta: "It is 15°C." });
    assert.equal(col.snapshot().text, "Let me check the weather first.\n\nIt is 15°C.");
    assert.equal(col.snapshot().events, 3);
  });
});

describe("Chat Completions reader", () => {
  it("collects content deltas, the finish reason and the usage chunk", () => {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
      id: "chatcmpl-abc123",
      object: "chat.completion.chunk",
      created: 1714502400,
      model: "muse-spark-1.2",
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const text = sse(
      [
        chunk({ role: "assistant", content: "" }),
        chunk({ content: "Here are three " }),
        chunk({ content: "key differences" }),
        chunk({ content: " between TCP and UDP..." }, "stop"),
        { id: "chatcmpl-abc123", object: "chat.completion.chunk", created: 1714502400, model: "muse-spark-1.2", choices: [], usage: { prompt_tokens: 25, completion_tokens: 19, total_tokens: 44 } },
        "[DONE]",
      ],
      false,
    );
    const c = feed(chatCollector(), text, 5);
    assert.equal(c.text, "Here are three key differences between TCP and UDP...");
    assert.equal(c.finishReason, "stop");
    assert.deepEqual(c.usage, { prompt_tokens: 25, completion_tokens: 19, total_tokens: 44 });
    assert.equal(c.id, "chatcmpl-abc123");
    assert.equal(c.done, true);
    const final = c.final as { object: string; choices: Array<{ message: { content: string } }> };
    assert.equal(final.object, "chat.completion");
    assert.equal(final.choices[0].message.content, c.text);
  });

  it("accumulates tool_call deltas by index, parallel calls included", () => {
    const col = chatCollector();
    const tc = (tool_calls: unknown[], finish: string | null = null) => ({ id: "chatcmpl-t", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls }, finish_reason: finish }] });
    col.push(tc([{ index: 0, id: "call_abc123", type: "function", function: { name: "get_weather", arguments: "" } }]));
    col.push(tc([{ index: 0, function: { arguments: '{"location": ' } }]));
    col.push(tc([{ index: 1, id: "call_def456", type: "function", function: { name: "get_weather", arguments: '{"location": "Tokyo"}' } }]));
    col.push(tc([{ index: 0, function: { arguments: '"Seattle, WA"}' } }], "tool_calls"));
    const c = col.snapshot();
    assert.deepEqual(
      c.toolCalls.map((t) => [t.callId, t.name, t.arguments, t.done]),
      [
        ["call_abc123", "get_weather", '{"location": "Seattle, WA"}', true],
        ["call_def456", "get_weather", '{"location": "Tokyo"}', true],
      ],
    );
    assert.equal(c.finishReason, "tool_calls");
    const message = (c.final as { choices: Array<{ message: { tool_calls: unknown[] } }> }).choices[0].message;
    assert.equal(message.tool_calls.length, 2);
  });

  it("reads the docs' tool call example response and an error chunk", () => {
    const c = collectReply("chat", {
      id: "chatcmpl-abc123",
      object: "chat.completion",
      created: 1714502400,
      model: "muse-spark-1.3",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null, tool_calls: [{ id: "call_abc123", type: "function", function: { name: "get_weather", arguments: '{"location": "Seattle, WA"}' } }] },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 85, completion_tokens: 24, total_tokens: 109 },
    });
    assert.equal(c.text, "");
    assert.equal(c.toolCalls[0].callId, "call_abc123");
    assert.equal(c.finishReason, "tool_calls");

    const err = chatCollector();
    err.push({ error: { type: "invalid_request_error", code: "invalid_value", message: "top_p must be greater than 0." } });
    assert.deepEqual(err.snapshot().error, { code: "invalid_value", message: "top_p must be greater than 0." });
  });
});

describe("Messages reader", () => {
  it("collects text deltas and merges usage from message_start and message_delta", () => {
    const text = sse([
      { type: "message_start", message: { id: "msg_abc123", type: "message", role: "assistant", model: "muse-spark-1.3-contributor", content: [], usage: { input_tokens: 14, output_tokens: 1, cache_read_input_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "EnC..." } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "ping" },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "The capital of France " } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "is Paris." } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8, output_tokens_details: { thinking_tokens: 5 } } },
      { type: "message_stop" },
    ]);
    const c = feed(messagesCollector(), text, 9);
    assert.equal(c.text, "The capital of France is Paris.");
    assert.equal(c.id, "msg_abc123");
    assert.equal(c.finishReason, "end_turn");
    assert.deepEqual(c.usage, { input_tokens: 14, output_tokens: 8, cache_read_input_tokens: 0, output_tokens_details: { thinking_tokens: 5 } });
    assert.equal(c.done, true);
    assert.equal(c.reasoning, "");
  });

  it("collects thinking and a tool_use block's streamed input_json_delta", () => {
    const col = messagesCollector();
    for (const e of [
      { type: "message_start", message: { id: "msg_t", model: "muse-spark-1.3-contributor", usage: { input_tokens: 90, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "The user wants the weather." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_01", name: "get_weather", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"locat' } },
    ]) {
      col.push(e);
    }
    assert.equal(col.snapshot().toolCalls[0].arguments, '{"locat');
    col.push({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'ion": "Seattle"}' } });
    col.push({ type: "content_block_stop", index: 1 });
    col.push({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 40 } });
    col.push({ type: "message_stop" });
    const c = col.snapshot();
    assert.equal(c.reasoning, "The user wants the weather.");
    assert.deepEqual(c.toolCalls, [{ id: "toolu_01", callId: "toolu_01", name: "get_weather", arguments: '{"location": "Seattle"}', done: true, kind: "function" }]);
    assert.equal(c.finishReason, "tool_use");
    const content = (c.final as { content: Array<{ type: string; input?: unknown }> }).content;
    assert.deepEqual(content[1], { type: "tool_use", id: "toolu_01", name: "get_weather", input: { location: "Seattle" } });
  });

  it("gives a tool with no arguments the input it started with", () => {
    const col = messagesCollector();
    col.push({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_2", name: "get_time", input: {} } });
    col.push({ type: "content_block_stop", index: 0 });
    assert.equal(col.snapshot().toolCalls[0].arguments, "{}");
  });

  it("reads the docs' example message and an error event", () => {
    const msg = {
      id: "msg_abc123",
      type: "message",
      role: "assistant",
      model: "muse-spark-1.3",
      content: [{ type: "text", text: "The capital of France is Paris." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 14, output_tokens: 8 },
    };
    const c = collectReply("messages", msg);
    assert.equal(c.text, "The capital of France is Paris.");
    assert.equal(protocolOfReply(msg), "messages");
    const col = messagesCollector();
    col.push({ event: "message", data: JSON.stringify(msg), json: msg });
    assert.equal(col.snapshot().text, "The capital of France is Paris.");

    const err = messagesCollector();
    err.push({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    assert.deepEqual(err.snapshot().error, { code: "overloaded_error", message: "Overloaded" });
  });
});

describe("protocol helpers", () => {
  it("knows the protocol of a path", () => {
    assert.equal(protocolOfPath("responses"), "responses");
    assert.equal(protocolOfPath("/v1/chat/completions"), "chat");
    assert.equal(protocolOfPath("messages?beta=true"), "messages");
    assert.equal(protocolOfPath("messages/count_tokens"), null);
    assert.equal(protocolOfPath("files"), null);
  });

  it("returns fresh arrays from every snapshot", () => {
    const col = chatCollector();
    col.push({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "f", arguments: "{}" } }] } }] });
    const a = col.snapshot();
    a.toolCalls[0].arguments = "changed";
    assert.equal(col.snapshot().toolCalls[0].arguments, "{}");
  });
});
