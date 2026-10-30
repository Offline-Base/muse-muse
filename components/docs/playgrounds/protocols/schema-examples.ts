import type { SchemaExample, SchemaTarget } from "@/components/docs/playgrounds/protocols/SchemaExplorer";

/**
 * The schemas explorer's live examples for the three schemas pages, as plain JSON for the DemoSpecs: working requests
 * (each one run through the docs proxy while this was built), and for each schema the example that shows it and where
 * in the request, reply or stream it sits. Bodies use {{model}} for the explorer's model menu and {{sample:...}} for the
 * docs samples (flow.ts). Muse Spark answers in a few hundred tokens at low effort, so each run is well under a cent;
 * the web search examples add $0.0025 a query.
 */

export interface SchemaExplorerData {
  examples: SchemaExample[];
  targets: Record<string, SchemaTarget>;
  starters: string[];
}

const M = "{{model}}";
/** Background responses hold their worst case until they finish, which keeps Muse Wonder out of them in the live docs. */
const SPARK_MODELS = ["muse-spark-1.3-contributor", "muse-spark-1.2", "muse-spark-1.2-contributor", "muse-spark-1.1"];
const CAPITAL = "What is the capital of France? Answer in one sentence.";
const BAT_AND_BALL = "A bat and a ball cost $1.10 together. The bat costs $1.00 more than the ball. How much is the ball? One sentence.";
const WEATHER = "What's the weather in Paris right now?";
const WEATHER_RESULT = '{"temperature_c": 18, "conditions": "light rain"}';
const PLACE_SCHEMA = {
  type: "object",
  properties: { city: { type: "string" }, country: { type: "string" } },
  required: ["city", "country"],
  additionalProperties: false,
};
const PLACE_PROMPT = "I flew home from Lisbon, Portugal last week. Extract the place.";
const CITY_PARAMS = {
  type: "object",
  properties: { city: { type: "string", description: "City name, such as Paris" } },
  required: ["city"],
  additionalProperties: false,
};

// ---------- Responses ----------

const R_TOOL = { type: "function", name: "get_weather", description: "Get the current weather for a city.", parameters: CITY_PARAMS };
const r = (body: Record<string, unknown>) => ({ model: M, reasoning: { effort: "low" }, max_output_tokens: 1500, ...body });

export const RESPONSES_SCHEMAS: SchemaExplorerData = {
  starters: ["create-response", "response", "response-usage", "output-item", "token-counts-body", "response-stream-event"],
  examples: [
    {
      id: "basic",
      label: "A plain response",
      blurb: "POST /v1/responses with a question and metadata; it's stored by default.",
      steps: [{ id: "create", title: "Create", path: "responses", body: r({ input: CAPITAL, metadata: { demo: "schemas" } }) }],
    },
    {
      id: "stream",
      label: "A streamed response with a reasoning summary",
      blurb: "stream: true and reasoning.summary, so the summary and the text both arrive as events.",
      steps: [
        {
          id: "create",
          title: "Stream",
          path: "responses",
          stream: true,
          body: { model: M, input: BAT_AND_BALL, reasoning: { effort: "medium", summary: "auto" }, max_output_tokens: 3000, stream: true },
        },
      ],
    },
    {
      id: "encrypted",
      label: "Stateless, with encrypted reasoning",
      blurb: "store: false and include reasoning.encrypted_content, so the reasoning item carries its encrypted state.",
      steps: [{ id: "create", title: "Create", path: "responses", body: r({ input: CAPITAL, store: false, include: ["reasoning.encrypted_content"] }) }],
    },
    {
      id: "replay",
      label: "Replaying reasoning on the next turn",
      blurb: "Turn 1 returns an encrypted reasoning item; turn 2 sends it back in input with the assistant message.",
      steps: [
        { id: "turn1", title: "Turn 1", path: "responses", body: r({ input: CAPITAL, store: false, include: ["reasoning.encrypted_content"] }) },
        {
          id: "turn2",
          title: "Turn 2",
          path: "responses",
          body: r({
            store: false,
            include: ["reasoning.encrypted_content"],
            input: [{ role: "user", content: CAPITAL }, { $spread: "turn1.output" }, { role: "user", content: "And its population? One sentence." }],
          }),
        },
      ],
    },
    {
      id: "input-array",
      label: "An input array",
      blurb: "The guide's own input array: a developer message, a user turn, a replayed assistant turn, then the question.",
      steps: [
        {
          id: "create",
          title: "Create",
          path: "responses",
          body: r({
            input: [
              { role: "developer", content: [{ type: "input_text", text: "You are a helpful geography assistant. Answer in one sentence." }] },
              { role: "user", content: [{ type: "input_text", text: "What is the capital of France?" }] },
              { role: "assistant", content: [{ type: "output_text", text: "The capital of France is Paris." }] },
              { role: "user", content: [{ type: "input_text", text: "What is its population?" }] },
            ],
          }),
        },
      ],
    },
    {
      id: "image",
      label: "An image input",
      blurb: "input_image with the cat sample as a data URL.",
      steps: [
        {
          id: "create",
          title: "Create",
          path: "responses",
          body: r({
            input: [
              {
                role: "user",
                content: [
                  { type: "input_text", text: "What animal is this, and where is it? One sentence." },
                  { type: "input_image", image_url: "{{sample:cat-sofa}}", detail: "auto" },
                ],
              },
            ],
          }),
        },
      ],
    },
    {
      id: "file",
      label: "A PDF input",
      blurb: "input_file with the 2-page sample report inline as file_data.",
      steps: [
        {
          id: "create",
          title: "Create",
          path: "responses",
          body: r({
            input: [
              {
                role: "user",
                content: [
                  { type: "input_text", text: "What is this report about? Two sentences." },
                  { type: "input_file", filename: "field-report.pdf", file_data: "{{sample:field-report}}" },
                ],
              },
            ],
          }),
        },
      ],
    },
    {
      id: "tool",
      label: "A function call",
      blurb: "A get_weather function tool; the model answers with a function_call item.",
      steps: [{ id: "call", title: "Call", path: "responses", body: r({ input: WEATHER, tools: [R_TOOL], tool_choice: "auto", parallel_tool_calls: true }) }],
    },
    {
      id: "tool-result",
      label: "Sending a tool result back",
      blurb: "The function call, then function_call_output with previous_response_id.",
      steps: [
        { id: "call", title: "Call", path: "responses", body: r({ input: WEATHER, tools: [R_TOOL] }) },
        {
          id: "result",
          title: "Result",
          path: "responses",
          retry: { statuses: [400] },
          body: r({
            previous_response_id: "{{call.id}}",
            input: [{ type: "function_call_output", call_id: "{{call.output[type=function_call].call_id}}", output: WEATHER_RESULT }],
            tools: [R_TOOL],
          }),
        },
      ],
    },
    {
      id: "tool-stream",
      label: "A streamed function call",
      blurb: "The function call streamed, so its arguments arrive as events.",
      steps: [{ id: "call", title: "Stream", path: "responses", stream: true, body: r({ input: WEATHER, tools: [R_TOOL], stream: true }) }],
    },
    {
      id: "search",
      label: "Web search, streamed ($0.0025 a query)",
      blurb: "The web_search tool with an approximate location; the search shows as a web_search_call item and its own events.",
      steps: [
        {
          id: "create",
          title: "Search",
          path: "responses",
          stream: true,
          body: {
            model: M,
            input: "Who won the most recent Formula 1 race? One sentence.",
            tools: [{ type: "web_search", user_location: { type: "approximate", country: "US" } }],
            reasoning: { effort: "low" },
            max_output_tokens: 3000,
            stream: true,
          },
        },
      ],
    },
    {
      id: "json",
      label: "Structured output",
      blurb: "text.format with a strict JSON Schema.",
      steps: [{ id: "create", title: "Create", path: "responses", body: r({ input: PLACE_PROMPT, text: { format: { type: "json_schema", name: "place", strict: true, schema: PLACE_SCHEMA } } }) }],
    },
    {
      id: "count",
      label: "Counting input tokens",
      blurb: "POST /v1/responses/input_tokens: nothing is generated or stored.",
      steps: [{ id: "count", title: "Count", path: "responses/input_tokens", body: { model: M, instructions: "Answer in one sentence.", input: CAPITAL } }],
    },
    {
      id: "delete",
      label: "Deleting a response",
      blurb: "A stored response, then DELETE /v1/responses/{id}.",
      steps: [
        { id: "create", title: "Create", path: "responses", body: r({ input: CAPITAL }) },
        { id: "delete", title: "Delete", method: "DELETE", path: "responses/{{create.id}}", retry: { statuses: [404] } },
      ],
    },
    {
      id: "cancel",
      label: "Cancelling a background response",
      blurb: "A long background response, cancelled right away. Background runs need Muse Spark in the live docs.",
      models: SPARK_MODELS,
      steps: [
        {
          id: "start",
          title: "Start",
          path: "responses",
          body: { model: M, input: "Write a 600-word story about a lighthouse keeper who adopts a seagull.", background: true, reasoning: { effort: "low" }, max_output_tokens: 3000 },
        },
        { id: "cancel", title: "Cancel", method: "POST", path: "responses/{{start.id}}/cancel" },
      ],
    },
    {
      id: "incomplete",
      label: "An incomplete response",
      blurb: "max_output_tokens at its minimum of 16, streamed: the run stops early and ends with response.incomplete.",
      steps: [{ id: "create", title: "Stream", path: "responses", stream: true, body: { model: M, input: "Explain how neural networks learn.", max_output_tokens: 16, stream: true } }],
    },
    {
      id: "computer",
      label: "A computer use call",
      blurb: "The computer tool and a screenshot of a sign-up form; the model answers with a computer_call holding its actions.",
      steps: [
        {
          id: "create",
          title: "Create",
          path: "responses",
          body: r({
            tools: [{ type: "computer" }],
            input: [
              {
                role: "user",
                content: [
                  { type: "input_text", text: "Here is the screen. Click the Create account button." },
                  { type: "input_image", image_url: "{{sample:signup-screen}}" },
                ],
              },
            ],
          }),
        },
      ],
    },
    {
      id: "tool-search",
      label: "Tool search over deferred tools",
      blurb: "tool_search with two functions marked defer_loading; the server searches, then the model calls get_weather.",
      steps: [
        {
          id: "create",
          title: "Create",
          path: "responses",
          body: r({
            input: WEATHER,
            tools: [
              { type: "tool_search" },
              { ...R_TOOL, defer_loading: true },
              {
                type: "function",
                name: "get_stock_price",
                description: "Get a stock price by ticker.",
                parameters: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"], additionalProperties: false },
                defer_loading: true,
              },
            ],
          }),
        },
      ],
    },
  ],
  targets: {
    "create-response": { example: "basic", at: "request" },
    "create-model-response-properties": { example: "basic", at: "request" },
    response: { example: "basic", at: "reply" },
    "response-properties": { example: "basic", at: "reply" },
    "model-response-properties": { example: "basic", at: "reply" },
    metadata: { example: "basic", at: "reply", path: "metadata" },
    "service-tier": { example: "basic", at: "reply", path: "service_tier" },
    "response-usage": { example: "basic", at: "reply", path: "usage" },
    "output-item": { example: "basic", at: "reply", path: "output[-1]" },
    "output-message": { example: "basic", at: "reply", path: "output[type=message]" },
    "output-message-content": { example: "basic", at: "reply", path: "output[type=message].content[0]" },
    "output-content": { example: "basic", at: "reply", path: "output[type=message].content[0]" },
    "output-text-content": { example: "basic", at: "reply", path: "output[type=message].content[0]" },
    "reasoning-item": { example: "encrypted", at: "reply", path: "output[type=reasoning]" },
    "include-enum": { example: "encrypted", at: "request", path: "include[0]" },
    "reasoning-item-param": { example: "replay", at: "request", path: "input[type=reasoning]", step: "turn2" },
    item: { example: "replay", at: "request", path: "input[type=reasoning]", step: "turn2" },
    reasoning: { example: "stream", at: "request", path: "reasoning" },
    "reasoning-effort": { example: "stream", at: "request", path: "reasoning.effort" },
    "summary-text-content": { example: "stream", at: "reply", path: "output[type=reasoning].summary[0]" },
    "input-param": { example: "input-array", at: "request", path: "input" },
    "input-item": { example: "input-array", at: "request", path: "input[0]" },
    "easy-input-message": { example: "input-array", at: "request", path: "input[2]" },
    "input-message": { example: "input-array", at: "request", path: "input[1]" },
    "input-message-content-list": { example: "input-array", at: "request", path: "input[1].content" },
    "input-text-content": { example: "input-array", at: "request", path: "input[1].content[0]" },
    "input-content": { example: "image", at: "request", path: "input[0].content[1]" },
    "input-image-content": { example: "image", at: "request", path: "input[0].content[1]" },
    "image-detail": { example: "image", at: "request", path: "input[0].content[1].detail" },
    "input-file-content": { example: "file", at: "request", path: "input[0].content[1]" },
    "function-tool": { example: "tool", at: "request", path: "tools[0]" },
    tool: { example: "tool", at: "request", path: "tools[0]" },
    "tools-array": { example: "tool", at: "request", path: "tools" },
    "tool-choice-param": { example: "tool", at: "request", path: "tool_choice" },
    "tool-choice-options": { example: "tool", at: "request", path: "tool_choice" },
    "function-tool-call": { example: "tool", at: "reply", path: "output[type=function_call]" },
    "function-call-status": { example: "tool", at: "reply", path: "output[type=function_call].status" },
    "message-phase": { example: "tool", at: "reply", path: "output[type=message].phase" },
    "function-call-output-item-param": { example: "tool-result", at: "request", path: "input[0]", step: "result" },
    "function-tool-call-output": { example: "tool-result", at: "request", path: "input[0]", step: "result" },
    "response-function-call-arguments-delta-event": { example: "tool-stream", at: "event", event: "response.function_call_arguments.delta" },
    "response-function-call-arguments-done-event": { example: "tool-stream", at: "event", event: "response.function_call_arguments.done" },
    "web-search-tool": { example: "search", at: "request", path: "tools[0]" },
    "web-search-approximate-location": { example: "search", at: "request", path: "tools[0].user_location" },
    "web-search-tool-call": { example: "search", at: "reply", path: "output[type=web_search_call]" },
    "web-search-action-search": { example: "search", at: "reply", path: "output[type=web_search_call].action" },
    "response-web-search-call-in-progress-event": { example: "search", at: "event", event: "response.web_search_call.in_progress" },
    "response-web-search-call-searching-event": { example: "search", at: "event", event: "response.web_search_call.searching" },
    "response-web-search-call-completed-event": { example: "search", at: "event", event: "response.web_search_call.completed" },
    "response-text-param": { example: "json", at: "request", path: "text" },
    "text-response-format-configuration": { example: "json", at: "request", path: "text.format" },
    "text-response-format-json-schema": { example: "json", at: "request", path: "text.format" },
    "response-format-json-schema-schema": { example: "json", at: "request", path: "text.format.schema" },
    "token-counts-body": { example: "count", at: "request" },
    "token-counts-resource": { example: "count", at: "reply" },
    "delete-response-response": { example: "delete", at: "reply" },
    "cancel-response-response": { example: "cancel", at: "reply" },
    "response-stream-event": { example: "stream", at: "event", event: "response.created" },
    "response-stream-wire-event": { example: "stream", at: "event", event: "response.created" },
    "response-created-event": { example: "stream", at: "event", event: "response.created" },
    "response-in-progress-event": { example: "stream", at: "event", event: "response.in_progress" },
    "response-output-item-added-event": { example: "stream", at: "event", event: "response.output_item.added" },
    "response-output-item-done-event": { example: "stream", at: "event", event: "response.output_item.done" },
    "response-content-part-added-event": { example: "stream", at: "event", event: "response.content_part.added" },
    "response-content-part-done-event": { example: "stream", at: "event", event: "response.content_part.done" },
    "response-text-delta-event": { example: "stream", at: "event", event: "response.output_text.delta" },
    "response-text-done-event": { example: "stream", at: "event", event: "response.output_text.done" },
    "response-reasoning-summary-part-added-event": { example: "stream", at: "event", event: "response.reasoning_summary_part.added" },
    "response-reasoning-summary-part-done-event": { example: "stream", at: "event", event: "response.reasoning_summary_part.done" },
    "response-reasoning-summary-text-delta-event": { example: "stream", at: "event", event: "response.reasoning_summary_text.delta" },
    "response-reasoning-summary-text-done-event": { example: "stream", at: "event", event: "response.reasoning_summary_text.done" },
    "response-completed-event": { example: "stream", at: "event", event: "response.completed" },
    "response-incomplete-event": { example: "incomplete", at: "event", event: "response.incomplete" },
    "computer-tool": { example: "computer", at: "request", path: "tools[0]" },
    "computer-tool-call": { example: "computer", at: "reply", path: "output[type=computer_call]" },
    "computer-action-list": { example: "computer", at: "reply", path: "output[type=computer_call].actions" },
    "computer-action": { example: "computer", at: "reply", path: "output[type=computer_call].actions[0]" },
    "computer-call-safety-check-param": { example: "computer", at: "reply", path: "output[type=computer_call].pending_safety_checks[0]" },
    "tool-search-tool-param": { example: "tool-search", at: "request", path: "tools[0]" },
    "tool-search-call": { example: "tool-search", at: "reply", path: "output[type=tool_search_call]" },
    "tool-search-output": { example: "tool-search", at: "reply", path: "output[type=tool_search_output]" },
    "tool-search-execution-type": { example: "tool-search", at: "reply", path: "output[type=tool_search_call].execution" },
  },
};

// ---------- Chat Completions ----------

const C_TOOL = { type: "function", function: { name: "get_weather", description: "Get the current weather for a city.", parameters: CITY_PARAMS } };
const c = (body: Record<string, unknown>) => ({ model: M, reasoning_effort: "low", max_completion_tokens: 1500, ...body });
const TCP = "What are three differences between TCP and UDP? Keep it short.";

export const CHAT_SCHEMAS: SchemaExplorerData = {
  starters: ["create-chat-completion-request", "create-chat-completion-response", "chat-completion-response-message", "completion-usage", "create-chat-completion-stream-response"],
  examples: [
    {
      id: "basic",
      label: "A plain chat completion",
      blurb: "POST /v1/chat/completions with one user message, a prompt_cache_key and the default service_tier.",
      steps: [{ id: "create", title: "Create", path: "chat/completions", body: c({ messages: [{ role: "user", content: TCP }], prompt_cache_key: "docs-schemas", service_tier: "auto" }) }],
    },
    {
      id: "multi",
      label: "Every message role",
      blurb: "A system and a developer message, a user turn, a replayed assistant turn, then the question.",
      steps: [
        {
          id: "create",
          title: "Create",
          path: "chat/completions",
          body: c({
            messages: [
              { role: "system", content: "Keep answers short." },
              { role: "developer", content: "You are a concise coding tutor." },
              { role: "user", content: "What is a Python decorator?" },
              { role: "assistant", content: "A decorator is a function that wraps another function to add behavior." },
              { role: "user", content: "Show a one-line example." },
            ],
          }),
        },
      ],
    },
    {
      id: "stream",
      label: "A streamed chat completion",
      blurb: "stream: true with stream_options.include_usage, so the last chunk carries usage.",
      steps: [{ id: "create", title: "Stream", path: "chat/completions", stream: true, body: c({ messages: [{ role: "user", content: TCP }], stream: true, stream_options: { include_usage: true } }) }],
    },
    {
      id: "tools",
      label: "A tool call",
      blurb: "A get_weather function tool; the reply's message carries tool_calls.",
      steps: [{ id: "call", title: "Call", path: "chat/completions", body: c({ messages: [{ role: "user", content: WEATHER }], tools: [C_TOOL], tool_choice: "auto", parallel_tool_calls: true }) }],
    },
    {
      id: "tools-stream",
      label: "A streamed tool call",
      blurb: "The tool call streamed: its id and arguments arrive in tool_calls chunks.",
      steps: [
        { id: "call", title: "Stream", path: "chat/completions", stream: true, body: c({ messages: [{ role: "user", content: WEATHER }], tools: [C_TOOL], stream: true, stream_options: { include_usage: true } }) },
      ],
    },
    {
      id: "tool-result",
      label: "Sending a tool result back",
      blurb: "The tool call, then the assistant message with its tool_calls and a tool message per call.",
      steps: [
        { id: "call", title: "Call", path: "chat/completions", body: c({ messages: [{ role: "user", content: WEATHER }], tools: [C_TOOL] }) },
        {
          id: "result",
          title: "Result",
          path: "chat/completions",
          body: c({
            messages: [
              { role: "user", content: WEATHER },
              "{{call.choices[0].message}}",
              { role: "tool", tool_call_id: "{{call.choices[0].message.tool_calls[0].id}}", content: WEATHER_RESULT },
            ],
            tools: [C_TOOL],
          }),
        },
      ],
    },
    {
      id: "json",
      label: "Structured output",
      blurb: "response_format json_schema with a strict schema.",
      steps: [
        {
          id: "create",
          title: "Create",
          path: "chat/completions",
          body: c({ messages: [{ role: "user", content: PLACE_PROMPT }], response_format: { type: "json_schema", json_schema: { name: "place", strict: true, schema: PLACE_SCHEMA } } }),
        },
      ],
    },
    {
      id: "json-object",
      label: "JSON mode",
      blurb: "response_format json_object; the developer message asks for JSON, as JSON mode needs.",
      steps: [
        {
          id: "create",
          title: "Create",
          path: "chat/completions",
          body: c({
            messages: [
              { role: "developer", content: "Reply with a JSON object with the keys city and country." },
              { role: "user", content: "I flew home from Lisbon, Portugal last week." },
            ],
            response_format: { type: "json_object" },
          }),
        },
      ],
    },
    {
      id: "text",
      label: "Plain text format",
      blurb: "response_format text, the default.",
      steps: [{ id: "create", title: "Create", path: "chat/completions", body: c({ messages: [{ role: "user", content: "Say hello in French." }], response_format: { type: "text" } }) }],
    },
    {
      id: "image",
      label: "An image input",
      blurb: "An image_url content part with the cat sample as a data URL.",
      steps: [
        {
          id: "create",
          title: "Create",
          path: "chat/completions",
          body: c({
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "What animal is this, and where is it? One sentence." },
                  { type: "image_url", image_url: { url: "{{sample:cat-sofa}}", detail: "auto" } },
                ],
              },
            ],
          }),
        },
      ],
    },
    {
      id: "file",
      label: "A PDF input",
      blurb: "A file content part with the sample report inline as file_data.",
      steps: [
        {
          id: "create",
          title: "Create",
          path: "chat/completions",
          body: c({
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "What is this report about? Two sentences." },
                  { type: "file", file: { filename: "field-report.pdf", file_data: "{{sample:field-report}}" } },
                ],
              },
            ],
          }),
        },
      ],
    },
  ],
  targets: {
    "create-chat-completion-request": { example: "basic", at: "request" },
    "create-model-response-properties": { example: "basic", at: "request" },
    "model-response-properties": { example: "basic", at: "request" },
    "reasoning-effort": { example: "basic", at: "request", path: "reasoning_effort" },
    "create-chat-completion-response": { example: "basic", at: "reply" },
    "chat-completion-response-message": { example: "basic", at: "reply", path: "choices[0].message" },
    "completion-usage": { example: "basic", at: "reply", path: "usage" },
    "chat-completion-request-message": { example: "multi", at: "request", path: "messages[0]" },
    "chat-completion-request-system-message": { example: "multi", at: "request", path: "messages[role=system]" },
    "chat-completion-request-developer-message": { example: "multi", at: "request", path: "messages[role=developer]" },
    "chat-completion-request-user-message": { example: "multi", at: "request", path: "messages[role=user]" },
    "chat-completion-request-assistant-message": { example: "multi", at: "request", path: "messages[role=assistant]" },
    "chat-completion-stream-options": { example: "stream", at: "request", path: "stream_options" },
    "create-chat-completion-stream-response": { example: "stream", at: "event", event: "chat.completion.chunk" },
    "chat-completion-stream-response-delta": { example: "stream", at: "event", event: "chat.completion.chunk", where: "choices[0].delta.content", path: "choices[0].delta" },
    "chat-completion-tool": { example: "tools", at: "request", path: "tools[0]" },
    "function-object": { example: "tools", at: "request", path: "tools[0].function" },
    "function-parameters": { example: "tools", at: "request", path: "tools[0].function.parameters" },
    "chat-completion-tool-choice-option": { example: "tools", at: "request", path: "tool_choice" },
    "parallel-tool-calls": { example: "tools", at: "request", path: "parallel_tool_calls" },
    "chat-completion-message-tool-calls": { example: "tools", at: "reply", path: "choices[0].message.tool_calls" },
    "chat-completion-message-tool-call": { example: "tools", at: "reply", path: "choices[0].message.tool_calls[0]" },
    "chat-completion-message-tool-call-chunk": {
      example: "tools-stream",
      at: "event",
      event: "chat.completion.chunk",
      where: "choices[0].delta.tool_calls",
      path: "choices[0].delta.tool_calls[0]",
    },
    "chat-completion-request-tool-message": { example: "tool-result", at: "request", path: "messages[role=tool]", step: "result" },
    "response-format-json-schema": { example: "json", at: "request", path: "response_format" },
    "response-format-json-schema-schema": { example: "json", at: "request", path: "response_format.json_schema.schema" },
    "response-format-json-object": { example: "json-object", at: "request", path: "response_format" },
    "response-format-text": { example: "text", at: "request", path: "response_format" },
    "chat-completion-request-user-message-content-part": { example: "image", at: "request", path: "messages[0].content[1]" },
    "chat-completion-request-message-content-part-text": { example: "image", at: "request", path: "messages[0].content[0]" },
    "chat-completion-request-message-content-part-image": { example: "image", at: "request", path: "messages[0].content[1]" },
    "chat-completion-request-message-content-part-file": { example: "file", at: "request", path: "messages[0].content[1]" },
  },
};

// ---------- Messages ----------

const A_TOOL = { name: "get_weather", description: "Get the current weather for a city.", input_schema: CITY_PARAMS };
const a = (body: Record<string, unknown>) => ({ model: M, max_tokens: 1500, ...body });

export const MESSAGES_SCHEMAS: SchemaExplorerData = {
  starters: ["anthropic-message-request", "anthropic-message", "anthropic-usage", "anthropic-content-block", "anthropic-count-tokens-request", "anthropic-stream-event"],
  examples: [
    { id: "basic", label: "A plain message", blurb: "POST /v1/messages with model, max_tokens and one user turn.", steps: [{ id: "create", title: "Create", path: "messages", body: a({ messages: [{ role: "user", content: CAPITAL }] }) }] },
    {
      id: "system",
      label: "System text blocks",
      blurb: "system as an array of text blocks, one with a cache_control breakpoint.",
      steps: [
        {
          id: "create",
          title: "Create",
          path: "messages",
          body: a({
            system: [{ type: "text", text: "You are a concise geography tutor. Answer in one sentence.", cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: "Which river runs through Paris?" }],
          }),
        },
      ],
    },
    {
      id: "thinking",
      label: "Adaptive thinking with an effort",
      blurb: "thinking adaptive and output_config.effort medium.",
      steps: [{ id: "create", title: "Create", path: "messages", body: a({ max_tokens: 3000, messages: [{ role: "user", content: BAT_AND_BALL }], thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "medium" } }) }],
    },
    {
      id: "budget",
      label: "A thinking budget",
      blurb: "thinking enabled with budget_tokens 1024, below max_tokens as it must be. Accepted for compatibility.",
      steps: [{ id: "create", title: "Create", path: "messages", body: a({ max_tokens: 2500, thinking: { type: "enabled", budget_tokens: 1024 }, messages: [{ role: "user", content: "Which river runs through Paris? One sentence." }] }) }],
    },
    {
      id: "replay",
      label: "Replaying thinking on the next turn",
      blurb: "Turn 1 returns redacted_thinking; turn 2 sends the whole assistant content back with the next question.",
      steps: [
        { id: "turn1", title: "Turn 1", path: "messages", body: a({ messages: [{ role: "user", content: CAPITAL }], thinking: { type: "adaptive" }, output_config: { effort: "low" } }) },
        {
          id: "turn2",
          title: "Turn 2",
          path: "messages",
          body: a({
            messages: [
              { role: "user", content: CAPITAL },
              { role: "assistant", content: "{{turn1.content}}" },
              { role: "user", content: "And its population? One sentence." },
            ],
            thinking: { type: "adaptive" },
            output_config: { effort: "low" },
          }),
        },
      ],
    },
    {
      id: "stream",
      label: "A streamed message",
      blurb: "stream: true, read as Anthropic's event sequence.",
      steps: [{ id: "create", title: "Stream", path: "messages", stream: true, body: a({ messages: [{ role: "user", content: CAPITAL }], stream: true }) }],
    },
    {
      id: "tools",
      label: "A tool call",
      blurb: "A custom get_weather tool with input_schema; the reply ends with stop_reason tool_use.",
      steps: [{ id: "call", title: "Call", path: "messages", body: a({ messages: [{ role: "user", content: WEATHER }], tools: [A_TOOL], tool_choice: { type: "auto" } }) }],
    },
    {
      id: "tool-result",
      label: "Sending a tool result back",
      blurb: "The tool_use, then the assistant content replayed and a tool_result in the next user turn.",
      steps: [
        { id: "call", title: "Call", path: "messages", body: a({ messages: [{ role: "user", content: WEATHER }], tools: [A_TOOL] }) },
        {
          id: "result",
          title: "Result",
          path: "messages",
          body: a({
            messages: [
              { role: "user", content: WEATHER },
              { role: "assistant", content: "{{call.content}}" },
              { role: "user", content: [{ type: "tool_result", tool_use_id: "{{call.content[type=tool_use].id}}", content: WEATHER_RESULT }] },
            ],
            tools: [A_TOOL],
          }),
        },
      ],
    },
    {
      id: "search",
      label: "Web search ($0.0025 a query)",
      blurb: "The web_search tool with user_location; the search comes back as a server_tool_use block.",
      steps: [
        {
          id: "create",
          title: "Search",
          path: "messages",
          body: a({
            max_tokens: 3000,
            messages: [{ role: "user", content: "Who won the most recent Formula 1 race? One sentence." }],
            tools: [{ type: "web_search", user_location: { type: "approximate", country: "US" } }],
          }),
        },
      ],
    },
    {
      id: "json",
      label: "Structured output",
      blurb: "output_config.format with a JSON Schema.",
      steps: [{ id: "create", title: "Create", path: "messages", body: a({ messages: [{ role: "user", content: PLACE_PROMPT }], output_config: { format: { type: "json_schema", schema: PLACE_SCHEMA } } }) }],
    },
    {
      id: "image",
      label: "An image block",
      blurb: "An image block with the cat sample as base64.",
      steps: [
        {
          id: "create",
          title: "Create",
          path: "messages",
          body: a({
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "What animal is this, and where is it? One sentence." },
                  { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "{{sample64:cat-sofa}}" } },
                ],
              },
            ],
          }),
        },
      ],
    },
    {
      id: "document",
      label: "A plain-text document",
      blurb: "A document block with a text source and a title.",
      steps: [
        {
          id: "create",
          title: "Create",
          path: "messages",
          body: a({
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "How much did rides grow, per this note? One sentence." },
                  {
                    type: "document",
                    source: { type: "text", media_type: "text/plain", data: "Northwind Bikes, Q3 2026: rides grew 18% over Q2 to 12,480. The new Harbor station opened on July 14." },
                    title: "Q3 note",
                  },
                ],
              },
            ],
          }),
        },
      ],
    },
    {
      id: "count",
      label: "Counting tokens",
      blurb: "POST /v1/messages/count_tokens: the same body minus max_tokens; nothing is generated.",
      steps: [{ id: "count", title: "Count", path: "messages/count_tokens", body: { model: M, system: "You are a geography tutor.", messages: [{ role: "user", content: "What is the capital of France?" }] } }],
    },
  ],
  targets: {
    "anthropic-message-request": { example: "basic", at: "request" },
    "anthropic-message-request-base": { example: "basic", at: "request" },
    "anthropic-input-message": { example: "basic", at: "request", path: "messages[0]" },
    "anthropic-message": { example: "basic", at: "reply" },
    "anthropic-usage": { example: "basic", at: "reply", path: "usage" },
    "anthropic-content-block": { example: "basic", at: "reply", path: "content[type=text]" },
    "anthropic-system-text-block-param": { example: "system", at: "request", path: "system[0]" },
    "anthropic-cache-control-ephemeral-param": { example: "system", at: "request", path: "system[0].cache_control" },
    "anthropic-thinking-config-param": { example: "thinking", at: "request", path: "thinking" },
    "anthropic-thinking-config-adaptive-param": { example: "thinking", at: "request", path: "thinking" },
    "anthropic-output-config": { example: "thinking", at: "request", path: "output_config" },
    "anthropic-thinking-config-enabled-param": { example: "budget", at: "request", path: "thinking" },
    "anthropic-redacted-thinking-block-param": { example: "replay", at: "request", path: "messages[1].content[type=redacted_thinking]", step: "turn2" },
    "anthropic-stream-event": { example: "stream", at: "event", event: "message_start" },
    "anthropic-tool": { example: "tools", at: "request", path: "tools[0]" },
    "anthropic-custom-tool-param": { example: "tools", at: "request", path: "tools[0]" },
    "anthropic-tool-choice": { example: "tools", at: "request", path: "tool_choice" },
    "anthropic-tool-use-block-param": { example: "tool-result", at: "request", path: "messages[1].content[type=tool_use]", step: "result" },
    "anthropic-tool-result-block-param": { example: "tool-result", at: "request", path: "messages[2].content[0]", step: "result" },
    "anthropic-content-block-param": { example: "tool-result", at: "request", path: "messages[2].content[0]", step: "result" },
    "anthropic-web-search-tool-param": { example: "search", at: "request", path: "tools[0]" },
    "anthropic-user-location-param": { example: "search", at: "request", path: "tools[0].user_location" },
    "anthropic-server-tool-use-block-param": { example: "search", at: "reply", path: "content[type=server_tool_use]" },
    "anthropic-server-tool-use-input-param": { example: "search", at: "reply", path: "content[type=server_tool_use].input" },
    "anthropic-json-output-format": { example: "json", at: "request", path: "output_config.format" },
    "anthropic-text-block-param": { example: "image", at: "request", path: "messages[0].content[0]" },
    "anthropic-image-block-param": { example: "image", at: "request", path: "messages[0].content[1]" },
    "anthropic-media-source-param": { example: "image", at: "request", path: "messages[0].content[1].source" },
    "anthropic-base64-source-param": { example: "image", at: "request", path: "messages[0].content[1].source" },
    "anthropic-document-block-param": { example: "document", at: "request", path: "messages[0].content[1]" },
    "anthropic-document-source-param": { example: "document", at: "request", path: "messages[0].content[1].source" },
    "anthropic-plain-text-source-param": { example: "document", at: "request", path: "messages[0].content[1].source" },
    "anthropic-count-tokens-request": { example: "count", at: "request" },
    "anthropic-count-tokens-response": { example: "count", at: "reply" },
  },
};
