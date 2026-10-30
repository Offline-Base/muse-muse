import type { DemoMap } from "@/lib/docs/demos/types";
import { PromptCachingLab } from "@/components/docs/playgrounds/text/PromptCachingLab";
import { ReasoningLab } from "@/components/docs/playgrounds/text/ReasoningLab";
import { SearchGroundingPlayground } from "@/components/docs/playgrounds/text/SearchGroundingPlayground";
import { StructuredOutputDemo } from "@/components/docs/playgrounds/text/StructuredOutputDemo";
import { TokenCounter } from "@/components/docs/playgrounds/text/TokenCounter";
import { ToolCallingDemo } from "@/components/docs/playgrounds/text/ToolCallingDemo";
import { ToolSearchPlayground } from "@/components/docs/playgrounds/text/ToolSearchPlayground";
import type { RuleCheck } from "@/components/docs/playgrounds/text/rules";

/**
 * Live demos and coding-agent prompts for the "text" pages:
 *   tool-calling
 *   tool-search
 *   search-grounding
 *   reasoning
 *   structured-output
 *   prompt-caching
 *   token-counting
 * Components live in components/docs/playgrounds/text/ (README.md there lists their props).
 *
 * Every demo runs on muse-spark-1.3-contributor by default (muse-spark-1.3 itself never runs here), and every rule
 * check below was run against the live API through the docs proxy on Oct 30, 2026; where the API answered
 * differently from the page, the check says so in its note rather than changing the page's claim.
 */

const M = "muse-spark-1.3-contributor";

/** Small and cheap, for checks the API accepts. */
const CHEAP = { reasoning: { effort: "minimal" }, max_output_tokens: 400 } as const;

/** The page's get_weather definition (tool-calling, "Defining tools"). */
const WEATHER_PARAMS = {
  type: "object",
  properties: { location: { type: "string", description: "City name, e.g. 'Seattle'" } },
  required: ["location"],
  additionalProperties: false,
};
const WEATHER_TOOL = { type: "function", name: "get_weather", description: "Return current weather for the given location.", parameters: WEATHER_PARAMS };
const WEATHER_SPEC = { name: "get_weather", description: "Return current weather for the given location.", parameters: WEATHER_PARAMS };

/** A schema that breaks the strict subset: no additionalProperties, and unit isn't in required. */
const LOOSE_WEATHER = {
  type: "object",
  properties: { location: { type: "string" }, unit: { type: "string", enum: ["celsius", "fahrenheit"] } },
  required: ["location"],
};

const TOOL_CALLING_CHECKS: RuleCheck[] = [
  {
    id: "strict-rejects",
    rule: "strict: true checks the schema against the strict subset",
    sends: "get_weather with strict: true, no additionalProperties: false and unit left out of required",
    path: "responses",
    expect: "rejected",
    anchor: "strict",
    body: { model: M, input: "What is the weather in Seattle?", ...CHEAP, tools: [{ type: "function", name: "get_weather", description: "Return current weather.", strict: true, parameters: LOOSE_WEATHER }] },
  },
  {
    id: "strict-default",
    rule: "Without strict, the same schema is accepted as it is",
    sends: "the same get_weather with strict left out (it defaults to false)",
    path: "responses",
    expect: "accepted",
    anchor: "strict",
    body: { model: M, input: "What is the weather in Seattle?", ...CHEAP, tools: [{ type: "function", name: "get_weather", description: "Return current weather.", parameters: LOOSE_WEATHER }] },
  },
  {
    id: "root-type",
    rule: "A schema without a root type gets \"type\": \"object\" added",
    sends: "get_weather whose parameters leave out the root type",
    path: "responses",
    expect: "accepted",
    anchor: "defining-tools",
    body: {
      model: M,
      input: "What is the weather in Seattle?",
      ...CHEAP,
      tools: [{ type: "function", name: "get_weather", description: "Return current weather.", parameters: { properties: { location: { type: "string" } }, required: ["location"] } }],
    },
  },
  {
    id: "two-dots",
    rule: "Function names may contain at most one dot",
    sends: "a function named crm.orders.list",
    path: "responses",
    expect: "rejected",
    anchor: "function-name-rules",
    body: { model: M, input: "List open orders for CUST-1.", ...CHEAP, tools: [{ type: "function", name: "crm.orders.list", description: "List open orders.", parameters: { type: "object", properties: { customer_id: { type: "string" } }, required: ["customer_id"] } }] },
  },
  {
    id: "tool-choice",
    rule: "tool_choice must be \"auto\"",
    sends: "tool_choice: \"required\"",
    path: "responses",
    expect: "rejected",
    anchor: "guidelines",
    body: { model: M, input: "What is the weather in Seattle?", ...CHEAP, tool_choice: "required", tools: [WEATHER_TOOL] },
  },
  {
    id: "call-id-match",
    rule: "Without previous_response_id, each function_call_output must match a function_call by call_id",
    sends: "a history whose output answers call_2 when the call was call_1",
    path: "responses",
    expect: "rejected",
    anchor: "guidelines",
    body: {
      model: M,
      ...CHEAP,
      tools: [WEATHER_TOOL],
      input: [
        { role: "user", content: "What is the weather in Seattle?" },
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"location":"Seattle"}' },
        { type: "function_call_output", call_id: "call_2", output: '{"temperature":"15°C"}' },
      ],
    },
  },
  {
    id: "call-id-length",
    rule: "call_id must be 1 to 64 characters",
    sends: "a function_call and its output with an empty call_id",
    path: "responses",
    expect: "rejected",
    anchor: "guidelines",
    body: {
      model: M,
      ...CHEAP,
      tools: [WEATHER_TOOL],
      input: [
        { role: "user", content: "What is the weather in Seattle?" },
        { type: "function_call", call_id: "", name: "get_weather", arguments: '{"location":"Seattle"}' },
        { type: "function_call_output", call_id: "", output: "{}" },
      ],
    },
  },
  {
    id: "assistant-first",
    rule: "On Chat Completions, a tool message needs the assistant message with its tool_calls first",
    sends: "a tool message with no assistant tool_calls message before it",
    path: "chat/completions",
    expect: "rejected",
    anchor: "guidelines",
    body: {
      model: M,
      reasoning_effort: "minimal",
      max_completion_tokens: 400,
      tools: [{ type: "function", function: { name: "get_weather", description: "Return current weather.", parameters: WEATHER_PARAMS } }],
      messages: [
        { role: "user", content: "What is the weather in Seattle?" },
        { role: "tool", tool_call_id: "call_1", content: '{"temperature":"15°C"}' },
      ],
    },
  },
  {
    id: "custom-chat",
    rule: "Custom tools are Responses-only: Chat Completions answers 400",
    sends: "a custom run_shell tool, in Chat Completions' nested shape, to Chat Completions",
    path: "chat/completions",
    expect: "rejected",
    anchor: "custom-tools",
    note: "Sent in the shape Chat Completions uses for tools ({type, custom: {name, description}}), so the 400 is about custom tools, not a malformed tool.",
    body: {
      model: M,
      reasoning_effort: "minimal",
      max_completion_tokens: 400,
      messages: [{ role: "user", content: "List the files here." }],
      tools: [{ type: "custom", custom: { name: "run_shell", description: "Execute a shell command supplied as freeform text." } }],
    },
  },
  {
    id: "custom-responses",
    rule: "A custom tool takes freeform text input on the Responses API",
    sends: "the page's custom run_shell tool",
    path: "responses",
    expect: "accepted",
    anchor: "custom-tools",
    note: "When these docs were checked (Oct 30, 2026), the live API answered HTTP 400, \"custom tools are not supported on this endpoint\", on every model, so the loop uses function tools.",
    body: { model: M, input: "List the files in the current directory.", ...CHEAP, tools: [{ type: "custom", name: "run_shell", description: "Execute a shell command supplied as freeform text." }] },
  },
];

/** The page's hosted example (tool-search, "Hosted tool search"). */
const CRM_NAMESPACE = {
  type: "namespace",
  name: "crm",
  description: "CRM tools for customer lookup and order management.",
  tools: [
    {
      type: "function",
      name: "get_customer_profile",
      description: "Fetch a customer profile by customer ID.",
      parameters: { type: "object", properties: { customer_id: { type: "string" } }, required: ["customer_id"], additionalProperties: false },
    },
    {
      type: "function",
      name: "list_open_orders",
      description: "List open orders for a customer ID.",
      defer_loading: true,
      parameters: { type: "object", properties: { customer_id: { type: "string" } }, required: ["customer_id"], additionalProperties: false },
    },
  ],
};
const CRM_NOT_DEFERRED = { ...CRM_NAMESPACE, tools: CRM_NAMESPACE.tools.map((t) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== "defer_loading"))) };
const ORDERS = "List open orders for customer CUST-12345.";

const TOOL_SEARCH_CHECKS: RuleCheck[] = [
  {
    id: "hosted-ok",
    rule: "Defer functions inside a namespace and add one tool_search tool",
    sends: "the page's crm namespace with list_open_orders deferred, counted with the free count endpoint",
    path: "responses/input_tokens",
    expect: "accepted",
    anchor: "deferring-tools",
    body: { model: M, input: ORDERS, parallel_tool_calls: false, tools: [CRM_NAMESPACE, { type: "tool_search" }] },
  },
  {
    id: "needs-tool-search",
    rule: "Deferred tools need a tool_search tool",
    sends: "list_open_orders with defer_loading: true and no tool_search",
    path: "responses",
    expect: "rejected",
    anchor: "constraints",
    body: { model: M, input: ORDERS, ...CHEAP, tools: [CRM_NAMESPACE] },
  },
  {
    id: "needs-deferred",
    rule: "Hosted tool search needs at least one deferred tool",
    sends: "tool_search with nothing marked defer_loading",
    path: "responses",
    expect: "rejected",
    anchor: "constraints",
    body: { model: M, input: ORDERS, ...CHEAP, tools: [CRM_NOT_DEFERRED, { type: "tool_search" }] },
  },
  {
    id: "one-tool-search",
    rule: "One tool_search tool per request",
    sends: "two tool_search tools",
    path: "responses",
    expect: "rejected",
    anchor: "constraints",
    body: { model: M, input: ORDERS, ...CHEAP, tools: [CRM_NAMESPACE, { type: "tool_search" }, { type: "tool_search" }] },
  },
  {
    id: "reserved",
    rule: "tool_search is a reserved name",
    sends: "a function tool named tool_search next to the real one",
    path: "responses",
    expect: "rejected",
    anchor: "constraints",
    body: {
      model: M,
      input: ORDERS,
      ...CHEAP,
      tools: [CRM_NAMESPACE, { type: "function", name: "tool_search", description: "My own search.", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }, { type: "tool_search" }],
    },
  },
  {
    id: "no-schema",
    rule: "Tool search can't be combined with a json_schema text.format",
    sends: "tool search plus structured output",
    path: "responses",
    expect: "rejected",
    anchor: "constraints",
    body: {
      model: M,
      input: ORDERS,
      ...CHEAP,
      tools: [CRM_NAMESPACE, { type: "tool_search" }],
      text: { format: { type: "json_schema", name: "Orders", schema: { type: "object", properties: { orders: { type: "array", items: { type: "string" } } }, required: ["orders"], additionalProperties: false } } },
    },
  },
  {
    id: "needs-reasoning",
    rule: "Tool search needs reasoning: effort \"none\" is rejected",
    sends: "reasoning.effort: \"none\" with tool search",
    path: "responses",
    expect: "rejected",
    anchor: "constraints",
    body: { model: M, input: ORDERS, reasoning: { effort: "none" }, max_output_tokens: 400, tools: [CRM_NAMESPACE, { type: "tool_search" }] },
  },
  {
    id: "no-chat",
    rule: "Tool search isn't available on Chat Completions",
    sends: "a deferred function and tool_search to Chat Completions",
    path: "chat/completions",
    expect: "rejected",
    anchor: "constraints",
    body: {
      model: M,
      max_completion_tokens: 400,
      messages: [{ role: "user", content: ORDERS }],
      tools: [
        { type: "function", function: { name: "list_open_orders", description: "List open orders for a customer ID.", defer_loading: true, parameters: { type: "object", properties: { customer_id: { type: "string" } }, required: ["customer_id"] } } },
        { type: "tool_search" },
      ],
    },
  },
  {
    id: "messages",
    rule: "On the Messages API, hosted searches come back as server_tool_use blocks",
    sends: "a deferred tool and tool_search in an Anthropic-shaped request",
    path: "messages",
    expect: "accepted",
    anchor: "constraints",
    replyHas: "server_tool_use",
    body: {
      model: M,
      max_tokens: 800,
      messages: [{ role: "user", content: ORDERS }],
      tools: [
        { name: "get_customer_profile", description: "Fetch a customer profile by customer ID.", input_schema: { type: "object", properties: { customer_id: { type: "string" } }, required: ["customer_id"] } },
        { name: "list_open_orders", description: "List open orders for a customer ID.", defer_loading: true, input_schema: { type: "object", properties: { customer_id: { type: "string" } }, required: ["customer_id"] } },
        { type: "tool_search" },
      ],
    },
  },
];

const SEARCH_CHECKS: RuleCheck[] = [
  {
    id: "no-chat",
    rule: "Search grounding isn't available on Chat Completions",
    sends: "the web_search tool to Chat Completions",
    path: "chat/completions",
    expect: "rejected",
    anchor: "constraints",
    body: { model: M, reasoning_effort: "minimal", max_completion_tokens: 400, messages: [{ role: "user", content: "Who won the most recent Formula 1 race?" }], tools: [{ type: "web_search" }] },
  },
  {
    id: "reserved",
    rule: "With web_search on, function tools can't use its reserved names",
    sends: "a function named browser.search next to web_search",
    path: "responses",
    expect: "rejected",
    anchor: "constraints",
    body: {
      model: M,
      input: "Who won the most recent Formula 1 race?",
      ...CHEAP,
      tools: [{ type: "web_search" }, { type: "function", name: "browser.search", description: "Search my notes.", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }],
    },
  },
  {
    id: "reserved-alone",
    rule: "Without web_search, those names are ordinary function names",
    sends: "the same browser.search function on its own",
    path: "responses",
    expect: "accepted",
    anchor: "constraints",
    body: { model: M, input: "Search my notes for 'tea'.", ...CHEAP, tools: [{ type: "function", name: "browser.search", description: "Search my notes.", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }] },
  },
  {
    id: "approximate",
    rule: "user_location's type must be \"approximate\"",
    sends: "user_location with type \"exact\"",
    path: "responses",
    expect: "rejected",
    anchor: "user-location",
    body: { model: M, input: "Coffee near me?", ...CHEAP, tools: [{ type: "web_search", user_location: { type: "exact", city: "London" } }] },
  },
  {
    id: "replay",
    rule: "A replayed web_search_call needs no id",
    sends: "a history with a web_search_call that has no id, counted with the free count endpoint",
    path: "responses/input_tokens",
    expect: "accepted",
    anchor: "constraints",
    body: {
      model: M,
      tools: [{ type: "web_search" }],
      input: [
        { role: "user", content: "Who won the most recent Formula 1 race?" },
        { type: "web_search_call", status: "completed", action: { type: "search", query: "most recent Formula 1 race winner" } },
        { role: "assistant", content: [{ type: "output_text", text: "Kimi Antonelli won the United States Grand Prix." }] },
        { role: "user", content: "Thanks! Reply with just OK." },
      ],
    },
  },
  {
    id: "messages-domains",
    rule: "On the Messages API, allowed_domains returns 400",
    sends: "web_search with allowed_domains to Messages",
    path: "messages",
    expect: "rejected",
    anchor: "constraints",
    body: { model: M, max_tokens: 400, messages: [{ role: "user", content: "Who won the most recent Formula 1 race?" }], tools: [{ type: "web_search", allowed_domains: ["formula1.com"] }] },
  },
  {
    id: "messages-max-uses",
    rule: "On the Messages API, max_uses returns 400",
    sends: "web_search with max_uses to Messages",
    path: "messages",
    expect: "rejected",
    anchor: "constraints",
    body: { model: M, max_tokens: 400, messages: [{ role: "user", content: "Who won the most recent Formula 1 race?" }], tools: [{ type: "web_search", max_uses: 2 }] },
  },
];

const REASONING_CHECKS: RuleCheck[] = [
  {
    id: "none-responses",
    rule: "\"none\" isn't supported by Muse Wonder or Muse Spark",
    sends: "reasoning.effort: \"none\" on the Responses API",
    path: "responses",
    expect: "rejected",
    anchor: "how-it-works",
    body: { model: M, input: "What is 17 * 24 - 13 * 13? Answer with the number only.", reasoning: { effort: "none" }, max_output_tokens: 400 },
  },
  {
    id: "none-chat",
    rule: "The same on Chat Completions",
    sends: "reasoning_effort: \"none\"",
    path: "chat/completions",
    expect: "rejected",
    anchor: "chat-completions",
    body: { model: M, reasoning_effort: "none", max_completion_tokens: 400, messages: [{ role: "user", content: "What is 17 * 24 - 13 * 13? Answer with the number only." }] },
  },
  {
    id: "logprobs-chat",
    rule: "logprobs aren't supported: Muse Spark is a reasoning model",
    sends: "logprobs: true on Chat Completions",
    path: "chat/completions",
    expect: "rejected",
    anchor: "logprobs",
    body: { model: M, reasoning_effort: "low", logprobs: true, max_completion_tokens: 400, messages: [{ role: "user", content: "What is 17 * 24 - 13 * 13? Answer with the number only." }] },
  },
  {
    id: "logprobs-responses",
    rule: "The same on the Responses API",
    sends: "include: [\"message.output_text.logprobs\"]",
    path: "responses",
    expect: "rejected",
    anchor: "logprobs",
    body: { model: M, input: "What is 17 * 24 - 13 * 13? Answer with the number only.", reasoning: { effort: "low" }, include: ["message.output_text.logprobs"], max_output_tokens: 400 },
  },
  {
    id: "summary-chat",
    rule: "Reasoning summaries are a Responses API feature",
    sends: "reasoning.summary to Chat Completions",
    path: "chat/completions",
    expect: "rejected",
    anchor: "summaries",
    body: { model: M, reasoning_effort: "low", reasoning: { summary: "auto" }, max_completion_tokens: 400, messages: [{ role: "user", content: "What is 17 * 24 - 13 * 13? Answer with the number only." }] },
  },
];

/** The page's Address schema, exactly as its examples send it (no additionalProperties). */
const ADDRESS_SCHEMA = {
  type: "object",
  properties: {
    street: { type: "string" },
    city: { type: "string" },
    state: { type: "string", description: "2-letter state abbreviation" },
    zip: { type: "string", description: "5-digit zip code" },
  },
  required: ["street", "city", "state", "zip"],
};
const ADDRESS_MESSAGES = [
  { role: "system", content: "Extract the address from the user input into the specified JSON format." },
  { role: "user", content: "Please format this address: 1 Hacker Wy Menlo Park CA 94025" },
];
const TREE_SCHEMA = {
  type: "object",
  properties: { root: { $ref: "#/$defs/node" } },
  required: ["root"],
  additionalProperties: false,
  $defs: {
    node: {
      type: "object",
      properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#/$defs/node" } } },
      required: ["name", "children"],
      additionalProperties: false,
    },
  },
};

function nestedSchema(levels: number): Record<string, unknown> {
  let s: Record<string, unknown> = { type: "string" };
  for (let i = levels; i >= 1; i--) s = { type: "object", properties: { [`level_${i}`]: s }, required: [`level_${i}`], additionalProperties: false };
  return s;
}

const STRUCTURED_CHECKS: RuleCheck[] = [
  {
    id: "recursive",
    rule: "Recursive schemas aren't supported",
    sends: "a tree whose node refers to itself through $ref",
    path: "responses",
    expect: "rejected",
    anchor: "how-it-works",
    body: { model: M, input: "Make an org chart for a three-person startup.", ...CHEAP, text: { format: { type: "json_schema", name: "Org", schema: TREE_SCHEMA } } },
  },
  {
    id: "strict-closed",
    rule: "strict: true needs additionalProperties: false on every object",
    sends: "the page's Address schema with strict: true",
    path: "chat/completions",
    expect: "rejected",
    anchor: "strict-mode",
    body: { model: M, messages: ADDRESS_MESSAGES, reasoning_effort: "minimal", max_completion_tokens: 400, response_format: { type: "json_schema", json_schema: { name: "Address", schema: ADDRESS_SCHEMA, strict: true } } },
  },
  {
    id: "strict-default",
    rule: "strict defaults to false, so the same schema is accepted without it",
    sends: "the page's Address schema as its examples send it",
    path: "chat/completions",
    expect: "accepted",
    anchor: "strict-mode",
    body: { model: M, messages: ADDRESS_MESSAGES, reasoning_effort: "minimal", max_completion_tokens: 600, response_format: { type: "json_schema", json_schema: { name: "Address", schema: ADDRESS_SCHEMA } } },
  },
  {
    id: "strict-required",
    rule: "strict: true needs every property listed in required",
    sends: "an object with properties a and b, only a required",
    path: "responses",
    expect: "rejected",
    anchor: "strict-mode",
    body: {
      model: M,
      input: "Fill it in.",
      ...CHEAP,
      text: { format: { type: "json_schema", name: "X", strict: true, schema: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"], additionalProperties: false } } },
    },
  },
  {
    id: "strict-oneof",
    rule: "allOf and oneOf aren't supported anywhere under strict",
    sends: "a property that is oneOf a string or a number",
    path: "responses",
    expect: "rejected",
    anchor: "strict-mode",
    body: {
      model: M,
      input: "Fill it in.",
      ...CHEAP,
      text: { format: { type: "json_schema", name: "X", strict: true, schema: { type: "object", properties: { v: { oneOf: [{ type: "string" }, { type: "number" }] } }, required: ["v"], additionalProperties: false } } },
    },
  },
  {
    id: "strict-root",
    rule: "Under strict, the root must be a plain object",
    sends: "a root that is anyOf two objects",
    path: "responses",
    expect: "rejected",
    anchor: "strict-mode",
    body: {
      model: M,
      input: "Fill it in.",
      ...CHEAP,
      text: {
        format: {
          type: "json_schema",
          name: "X",
          strict: true,
          schema: {
            anyOf: [
              { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false },
              { type: "object", properties: { b: { type: "string" } }, required: ["b"], additionalProperties: false },
            ],
          },
        },
      },
    },
  },
  {
    id: "depth",
    rule: "Nesting depth is capped at 10 levels",
    sends: "eleven nested objects",
    path: "responses",
    expect: "rejected",
    anchor: "schema-constraints",
    body: { model: M, input: "Fill it in with tiny values.", ...CHEAP, text: { format: { type: "json_schema", name: "Deep", schema: nestedSchema(11) } } },
  },
];

export const textDemos: DemoMap = {
  "tool-calling": {
    title: "Call your tools and send back the results",
    blurb:
      "Run all calls the model with tools, runs each call it asks for here in the page with sample data, sends the results back and shows the answer, one step at a time if you like; Check the rules sends the page's invalid requests to see the 400s.",
    Component: ToolCallingDemo,
    props: {
      scenarios: [
        {
          id: "weather",
          label: "Weather (the page's example)",
          about: "The page's get_weather tool: one call, your code answers it, the model writes the reply. Switch to Chat Completions for the tool_calls and tool message version.",
          prompt: "What is the weather in Seattle?",
          tools: [WEATHER_SPEC],
          presets: [
            { label: "Seattle", prompt: "What is the weather in Seattle?" },
            { label: "No tool needed", prompt: "What does a weather forecast's \"chance of rain\" mean?" },
          ],
        },
        {
          id: "parallel",
          label: "Parallel calls",
          about: "Several lookups in one question: the model asks for them in one turn and your code answers each by its call_id. Turn off Parallel calls (parallel_tool_calls: false) for one call per turn.",
          prompt: "What's the weather in Seattle, Tokyo and Paris right now?",
          tools: [WEATHER_SPEC, "get_time"],
          presets: [
            { label: "Three cities", prompt: "What's the weather in Seattle, Tokyo and Paris right now?" },
            { label: "Weather and time", prompt: "What's the weather and the local time in Tokyo and in Paris?" },
          ],
        },
        {
          id: "chain",
          label: "A chain of calls",
          about: "One result decides the next call: look the order up, then email the customer. Each round goes back with previous_response_id (Responses) or the whole history (Chat Completions). send_email answers as a sent email, marked simulated: nothing is sent.",
          prompt: "Look up order A1042 and email its status and delivery estimate to sam@example.com.",
          tools: ["lookup_order", "send_email"],
          // The kit's send_email answers "not_sent", which made the model report a failed email; this reads as the
          // success a real tool would return, flagged so the model can say it was simulated.
          results: { send_email: { status: "sent", simulated: true, message_id: "msg_demo_1042", note: "Demo only: no email left this page." } },
        },
        {
          id: "math",
          label: "Calculations",
          about: "The model hands the arithmetic to your calculator instead of doing it in its head, one of the page's uses for tools.",
          prompt: "A $1,240 order gets 15% off, then 8.25% sales tax on the discounted price. What's the total?",
          tools: ["calculator"],
        },
        {
          id: "strict",
          label: "Strict schema",
          about: "strict: true makes the server check the schema against the strict subset: additionalProperties: false and every property in required. This one passes; Check the rules shows one that doesn't.",
          prompt: "What's the weather in Boston, in Fahrenheit?",
          tools: [
            {
              name: "get_weather",
              description: "Return current weather for the given location.",
              strict: true,
              parameters: {
                type: "object",
                properties: {
                  location: { type: "string", description: "City name, e.g. 'Seattle'" },
                  unit: { type: "string", enum: ["celsius", "fahrenheit"], description: "Temperature unit." },
                },
                required: ["location", "unit"],
                additionalProperties: false,
              },
            },
          ],
        },
      ],
      checks: TOOL_CALLING_CHECKS,
      checksIntro: "Each check sends one small request that shows a rule from this page and compares the API's answer with what the page says.",
      maxCalls: 6,
    },
    agentPrompt: {
      task:
        "Add tool calling to my app with the Responses API: define a get_weather function tool, validate and run each function_call the model returns, send each result back as a function_call_output with its call_id and previous_response_id, and loop until the model answers, with a turn cap.",
      facts: [
        "Responses tools are flat {type: \"function\", name, description, parameters}; calls are function_call items (call_id, JSON-string arguments). Chat Completions nests tools under \"function\"; role \"tool\" results follow the whole assistant message.",
        "Resend tools with every request: they don't carry over with previous_response_id.",
        "Answer every call_id (parallel_tool_calls defaults to true). tool_choice takes only \"auto\".",
        "strict: true needs additionalProperties: false and every property required, else HTTP 400. Names allow one dot.",
        "Custom tools (type \"custom\") got HTTP 400 live (Oct 30, 2026).",
      ],
      checklist: [
        "\"What is the weather in Seattle?\" calls get_weather and the reply uses the result.",
        "Three cities get three calls in one turn, each answered by its call_id.",
        "A question needing no tool gets a plain answer; the loop stops at its cap.",
      ],
      snippets: {
        python: `import json, os

from openai import OpenAI

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])
tools = [{"type": "function", "name": "get_weather", "description": "Current weather for a location.",
          "parameters": {"type": "object", "properties": {"location": {"type": "string"}}, "required": ["location"]}}]
base = {"model": "muse-spark-1.3-contributor", "tools": tools}  # tools go with every request

resp = client.responses.create(**base, input="What is the weather in Seattle?")
for _ in range(5):
    calls = [i for i in resp.output if i.type == "function_call"]
    if not calls:
        break
    outs = [{"type": "function_call_output", "call_id": c.call_id,  # run your tool on c.arguments
             "output": json.dumps({**json.loads(c.arguments), "temperature": "15°C"})} for c in calls]
    resp = client.responses.create(**base, input=outs, previous_response_id=resp.id)
print(resp.output_text)`,
        typescript: `import OpenAI from "openai";
const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
const model = "muse-spark-1.3-contributor";
const tools: OpenAI.Responses.Tool[] = [{
  type: "function", name: "get_weather", strict: false, description: "Current weather for a location.",
  parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
}];

let resp = await client.responses.create({ model, input: "What is the weather in Seattle?", tools });
for (let n = 0; n < 5; n++) {
  const calls = resp.output.filter((i) => i.type === "function_call");
  if (!calls[0]) break;
  const input = calls.map((c) => ({ type: "function_call_output" as const, call_id: c.call_id,
    output: JSON.stringify({ ...JSON.parse(c.arguments), temperature: "15°C" }) })); // your tool
  resp = await client.responses.create({ model, input, previous_response_id: resp.id, tools });
}
console.log(resp.output_text);`,
        curl: `# 1. Ask with the tool: output holds a function_call with a call_id.
curl -X POST "https://api.meta.ai/v1/responses" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "muse-spark-1.3-contributor", "input": "What is the weather in Seattle?",
  "tools": [{"type": "function", "name": "get_weather", "description": "Return current weather for the given location.",
    "parameters": {"type": "object", "properties": {"location": {"type": "string"}}, "required": ["location"]}}]}'

# 2. Send the result with that response id and call_id, and the same tools.
curl -X POST "https://api.meta.ai/v1/responses" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "muse-spark-1.3-contributor", "previous_response_id": "resp_...",
  "input": [{"type": "function_call_output", "call_id": "call_...", "output": "{\\"temperature\\": \\"15°C\\"}"}],
  "tools": [...]}'`,
      },
    },
  },

  "tool-search": {
    title: "Search a deferred tool library",
    blurb:
      "Run all sends a 37-function library deferred behind tool_search, shows what the model searched for and loaded, runs the call it makes here with sample data and returns the result; the up-front counts measure what deferral saved, for free.",
    Component: ToolSearchPlayground,
    props: {
      hostedPresets: [
        { label: "Open orders (the page's example)", prompt: ORDERS },
        { label: "Two namespaces", prompt: "Refund $25 on invoice INV-2207 because it arrived damaged, and add an internal note about it to customer CUST-12345's profile." },
        { label: "Shipping", prompt: "Where is order A1042 and when will it arrive?" },
        { label: "On call", prompt: "Roll the checkout service back to its previous deployment and page the payments on-call engineer." },
        { label: "Time off", prompt: "How many vacation days does employee E-1042 have left this year?" },
      ],
      clientPresets: [
        { label: "Shipping ETA (the page's example)", prompt: "Find the shipping ETA tool, then use it for order_42." },
        { label: "Discount code", prompt: "Find a tool that applies discount codes, then apply SPRING25 for customer CUST-12345." },
        { label: "Holidays", prompt: "Find the tool for public holidays and list the US ones for 2026." },
      ],
      checks: TOOL_SEARCH_CHECKS,
      checksIntro: "The page's constraints, checked live. Most are 400s, which cost nothing; the first is counted with the free count endpoint.",
    },
    agentPrompt: {
      task:
        "Add tool search to my agent on the Responses API: put my tools in namespaces with defer_loading: true on the functions inside (never on the namespace), add one {\"type\": \"tool_search\"} tool, log the tool_search_call and tool_search_output items, then run the function_call and send its result with previous_response_id.",
      facts: [
        "HTTP 400: Chat Completions (Responses and Messages only), two tool_search tools, nothing deferred, deferred tools without tool_search, a function named tool_search, a json_schema text.format, effort \"none\".",
        "Hosted calls came back named \"crm.list_open_orders\" (no namespace field): read both.",
        "Client mode: reply with a tool_search_output echoing the call_id, and replay the user's message. The model also called loaded tools as tool_<name>, and tool_search as a function: match names leniently; answer stray calls with a function_call_output.",
        "It pays at scale: 2 tools cost more deferred (1,107 vs 757 tokens); 37 saved 47%.",
      ],
      checklist: [
        "A task needing a deferred tool returns tool_search_call, tool_search_output and a function_call.",
        "The result goes back with previous_response_id and the model answers.",
        "POST /v1/responses/input_tokens counts fewer tokens deferred than fully loaded.",
      ],
      snippets: {
        python: `import os

from openai import OpenAI

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])
fn = {"type": "function", "name": "list_open_orders", "description": "List open orders for a customer ID.", "defer_loading": True,
      "parameters": {"type": "object", "properties": {"customer_id": {"type": "string"}}, "required": ["customer_id"],
                     "additionalProperties": False}}
crm = {"type": "namespace", "name": "crm", "description": "CRM tools for customer lookup and orders.", "tools": [fn]}

response = client.responses.create(model="muse-spark-1.3-contributor", input="List open orders for customer CUST-12345.",
                                   parallel_tool_calls=False, tools=[crm, {"type": "tool_search"}])
for item in response.output:
    print(item.type, item.model_dump_json()[:200])`,
        typescript: `const fn = { type: "function", name: "list_open_orders", description: "List open orders for a customer ID.", defer_loading: true,
  parameters: { type: "object", properties: { customer_id: { type: "string" } }, required: ["customer_id"], additionalProperties: false } };
const res = await fetch("https://api.meta.ai/v1/responses", {
  method: "POST",
  headers: { Authorization: \`Bearer \${process.env.MODEL_API_KEY}\`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "muse-spark-1.3-contributor", input: "List open orders for customer CUST-12345.", parallel_tool_calls: false,
    tools: [{ type: "namespace", name: "crm", description: "CRM tools for customer lookup and orders.", tools: [fn] }, { type: "tool_search" }] }),
});
if (!res.ok) throw new Error(\`HTTP \${res.status}: \${await res.text()}\`);
for (const item of (await res.json()).output) console.log(item.type, item);`,
        curl: `curl -X POST "https://api.meta.ai/v1/responses" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "model": "muse-spark-1.3-contributor",
  "input": "List open orders for customer CUST-12345.",
  "parallel_tool_calls": false,
  "tools": [
    {"type": "namespace", "name": "crm", "description": "CRM tools for customer lookup and order management.",
     "tools": [{"type": "function", "name": "list_open_orders", "description": "List open orders for a customer ID.", "defer_loading": true,
                "parameters": {"type": "object", "properties": {"customer_id": {"type": "string"}}, "required": ["customer_id"], "additionalProperties": false}}]},
    {"type": "tool_search"}
  ]
}'`,
      },
    },
  },

  "search-grounding": {
    title: "Ask with web search and read the citations",
    blurb:
      "Run asks with the web_search tool and streams the searches the model runs, the answer with a numbered marker after each cited span, and its sources; searches cost $2.50 per 1,000 on top of tokens, usually 1 to 2 cents a run.",
    Component: SearchGroundingPlayground,
    props: {
      presets: [
        { label: "Latest F1 race (the page's example)", prompt: "Who won the most recent Formula 1 race?", contextSize: null, location: null },
        { label: "Tokyo's population", prompt: "What is the current population of Tokyo?", contextSize: null, location: null },
        { label: "Fusion energy, high context", prompt: "Summarize recent developments in fusion energy research.", contextSize: "high", location: null },
        { label: "Coffee near me, in London", prompt: "What are the best-rated coffee shops near me?", contextSize: null, location: { country: "GB", region: "London", city: "London", timezone: "Europe/London" } },
        { label: "AI regulation news", prompt: "What are the latest developments in AI regulation?", contextSize: null, location: null },
        { label: "Capital of France (may not search)", prompt: "What is the capital of France?", contextSize: null, location: null },
      ],
      places: [
        { label: "London", location: { country: "GB", region: "London", city: "London", timezone: "Europe/London" } },
        { label: "San Francisco", location: { country: "US", region: "California", city: "San Francisco", timezone: "America/Los_Angeles" } },
        { label: "Tokyo", location: { country: "JP", region: "Tokyo", city: "Tokyo", timezone: "Asia/Tokyo" } },
        { label: "Sydney", location: { country: "AU", region: "New South Wales", city: "Sydney", timezone: "Australia/Sydney" } },
      ],
      include: true,
      maxOutputTokens: 4000,
      checks: SEARCH_CHECKS,
      checksIntro: "The page's constraints, checked live. The 400s cost nothing; the accepted checks cost a fraction of a cent, and the replay check uses the free count endpoint.",
    },
    agentPrompt: {
      task:
        "Add search grounding to my app: call the Responses API with tools [{\"type\": \"web_search\"}] and include [\"web_search_call.results\"], then show the answer with a numbered marker after each url_citation span, a numbered sources list, and the searches the model ran.",
      facts: [
        "Responses and Messages only (Chat Completions: HTTP 400).",
        "Citation offsets index their own output_text block and count code points; preambles have phase \"commentary\".",
        "web_search_call.action: search (queries), open_page or find_in_page; raw results need include web_search_call.results.",
        "search_context_size: low, medium (default), high. user_location {type: \"approximate\", country, region, city, timezone} biases results, but the model can't see it: name the place.",
        "Searches cost $2.50 per 1,000 queries plus tokens; leave room in max_output_tokens.",
        "No functions named browser.search, browser.open or browser.find next to web_search.",
      ],
      checklist: [
        "\"Who won the most recent Formula 1 race?\" shows a cited answer and numbered sources.",
        "Each marker sits right after text[start_index:end_index] of its block.",
        "An answer without searches renders cleanly, with no sources.",
      ],
      snippets: {
        python: `import os

from openai import OpenAI

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])
response = client.responses.create(
    model="muse-spark-1.3-contributor",
    input="Who won the most recent Formula 1 race?",
    tools=[{"type": "web_search"}],
    include=["web_search_call.results"],
)

urls: list[str] = []
for item in response.output:
    if item.type != "message" or getattr(item, "phase", None) == "commentary":
        continue  # skip preambles
    for block in item.content:
        text, out, at = block.text, "", 0
        for ann in sorted((a for a in block.annotations if a.type == "url_citation"), key=lambda a: a.end_index):
            if ann.url not in urls:
                urls.append(ann.url)
            out += text[at:ann.end_index] + f"[{urls.index(ann.url) + 1}]"
            at = ann.end_index
        print(out + text[at:])
for n, url in enumerate(urls, 1):
    print(f"[{n}] {url}")`,
        typescript: `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
const res = await client.responses.create({ model: "muse-spark-1.3-contributor", input: "Who won the most recent Formula 1 race?",
  tools: [{ type: "web_search" }], include: ["web_search_call.results"] });
const urls: string[] = [];
for (const item of res.output) {
  if (item.type !== "message" || item.phase === "commentary") continue;
  for (const block of item.content) {
    if (block.type !== "output_text") continue;
    const cites = block.annotations.filter((a) => a.type === "url_citation");
    for (const a of cites) if (!urls.includes(a.url)) urls.push(a.url);
    const chars = [...block.text];
    for (const a of cites.sort((x, y) => y.end_index - x.end_index)) chars.splice(a.end_index, 0, \`[\${urls.indexOf(a.url) + 1}]\`);
    console.log(chars.join(""));
  }
}
urls.forEach((url, i) => console.log(\`[\${i + 1}] \${url}\`));`,
        curl: `curl -X POST "https://api.meta.ai/v1/responses" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "model": "muse-spark-1.3-contributor",
  "input": "Who won the most recent Formula 1 race?",
  "tools": [{"type": "web_search", "search_context_size": "medium"}],
  "include": ["web_search_call.results"]
}'`,
      },
    },
  },

  reasoning: {
    title: "Compare reasoning effort levels",
    blurb:
      "Run sends the same prompt at each effort you pick and compares reasoning tokens, time, cost and the summary, then you can follow up from any run to carry its reasoning forward; under a cent on Spark 1.3 Contributor, 10 to 16 cents for the Muse Wonder preset.",
    Component: ReasoningLab,
    props: {
      presets: [
        { label: "Prove √2 is irrational (the page's example)", prompt: "Prove that the square root of 2 is irrational.", followUp: "Now extend the proof to show that the square root of 3 is also irrational." },
        {
          label: "Logic puzzle",
          prompt: "Three boxes are labeled Apples, Oranges and Mixed, and every label is wrong. You may take one fruit from one box without looking inside. Which box do you pick, and how do you then fix all three labels?",
          followUp: "What changes if exactly one label were right instead?",
        },
        {
          label: "Plan a migration",
          prompt: "We run a monolith on one Postgres database at 2,000 writes a second. Outline a step-by-step plan to split out the billing service with zero downtime, and name the riskiest step.",
          followUp: "Rewrite the riskiest step as a checklist for the on-call engineer.",
        },
        { label: "A direct task (low is enough)", prompt: "Translate \"Where is the train station?\" into French, Spanish and Japanese.", efforts: ["minimal", "low", "high"], followUp: "Now add German." },
        {
          label: "Too small an output limit",
          prompt: "Prove that the square root of 2 is irrational.",
          efforts: ["minimal", "medium", "high"],
          maxOutputTokens: 700,
          followUp: "Now extend the proof to show that the square root of 3 is also irrational.",
        },
        {
          label: "Max on Muse Wonder (costs more)",
          prompt: "A Python worker sometimes processes the same queue message twice after a restart. Rank the likely causes and give the fix for each.",
          model: "muse-wonder-1.0",
          efforts: ["low", "max"],
          maxOutputTokens: 4000,
          followUp: "Write the fix for the top cause as a short code sketch.",
        },
      ],
      efforts: ["minimal", "low", "medium", "high"],
      summary: "auto",
      maxOutputTokens: 6000,
      checks: REASONING_CHECKS,
      checksIntro: "The page's constraints, checked live. Each expects HTTP 400, which costs nothing.",
    },
    agentPrompt: {
      task:
        "Make reasoning effort configurable in my app: send reasoning.effort (reasoning_effort on Chat Completions), log usage.output_tokens_details.reasoning_tokens, show the reasoning.summary when one comes back, carry reasoning into follow-ups with previous_response_id, and raise the output limit when a reply is incomplete.",
      facts: [
        "Efforts: minimal to xhigh. The page offers max on muse-wonder-1.0 but not on the Contributor model (live, it took max anyway). \"none\" is HTTP 400; left out, the model picks (replies echoed \"high\").",
        "Reasoning tokens count toward max_output_tokens (max_completion_tokens on Chat) and bill as output; too low a limit gives status \"incomplete\" and no text.",
        "reasoning.summary (auto, concise, detailed) is Responses only and can be empty.",
        "Follow-ups: previous_response_id, or stateless with include [\"reasoning.encrypted_content\"] and store: false. Chat Completions can't carry reasoning.",
        "logprobs aren't supported with reasoning (HTTP 400).",
      ],
      checklist: [
        "low and high on one prompt log different reasoning_tokens.",
        "A follow-up with previous_response_id builds on the first answer.",
        "An incomplete reply is retried with a higher limit, not shown as empty text.",
      ],
      snippets: {
        python: `import os

from openai import OpenAI

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])
MODEL = "muse-spark-1.3-contributor"

first = client.responses.create(
    model=MODEL, reasoning={"effort": "high", "summary": "auto"}, max_output_tokens=6000,
    input="Prove that the square root of 2 is irrational.")
if first.status == "incomplete":
    print("Ran out of output tokens:", first.incomplete_details.reason)
print("reasoning tokens:", first.usage.output_tokens_details.reasoning_tokens)
for item in first.output:
    if item.type == "reasoning":
        for part in item.summary:
            print("summary:", part.text)
print(first.output_text)

follow = client.responses.create(
    model=MODEL, reasoning={"effort": "high"}, previous_response_id=first.id,
    input="Now prove the same for the square root of 3.")
print(follow.output_text)`,
        typescript: `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
const model = "muse-spark-1.3-contributor";

const first = await client.responses.create({ model, reasoning: { effort: "high", summary: "auto" }, max_output_tokens: 6000,
  input: "Prove that the square root of 2 is irrational." });
if (first.status === "incomplete") console.warn("Ran out of output tokens:", first.incomplete_details?.reason);
console.log("reasoning tokens:", first.usage?.output_tokens_details?.reasoning_tokens);
for (const item of first.output) {
  if (item.type === "reasoning") for (const part of item.summary) console.log("summary:", part.text);
}
console.log(first.output_text);

const follow = await client.responses.create({ model, reasoning: { effort: "high" }, previous_response_id: first.id,
  input: "Now prove the same for the square root of 3." });
console.log(follow.output_text);`,
        curl: `curl -X POST "https://api.meta.ai/v1/responses" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "model": "muse-spark-1.3-contributor",
  "reasoning": {"effort": "high", "summary": "auto"},
  "max_output_tokens": 6000,
  "input": "Prove that the square root of 2 is irrational."
}'
# Read usage.output_tokens_details.reasoning_tokens, then follow up with "previous_response_id": "<id>".`,
      },
    },
  },

  "structured-output": {
    title: "Constrain a reply to a JSON Schema",
    blurb:
      "Run sends the schema as response_format (Chat Completions) or text.format (Responses) and checks the reply field by field; the size tab measures any schema against the page's limits without sending it.",
    Component: StructuredOutputDemo,
    props: {
      presets: [
        { label: "Address (the page's example)", name: "Address", schema: ADDRESS_SCHEMA, system: ADDRESS_MESSAGES[0].content, prompt: ADDRESS_MESSAGES[1].content },
        {
          label: "Contact info",
          name: "Contact",
          system: "Extract the contact details from the email signature. Use null for anything that isn't there.",
          prompt: "Thanks again,\nPriya Raman\nHead of Partnerships, Northwind Labs\npriya.raman@northwind.example | +1 (415) 555-0134\n500 Howard St, San Francisco",
          schema: {
            type: "object",
            properties: {
              name: { type: "string" },
              title: { anyOf: [{ type: "string" }, { type: "null" }] },
              company: { anyOf: [{ type: "string" }, { type: "null" }] },
              email: { anyOf: [{ type: "string" }, { type: "null" }] },
              phone: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
            required: ["name", "title", "company", "email", "phone"],
            additionalProperties: false,
          },
        },
        {
          label: "Classify a ticket",
          name: "TicketTriage",
          system: "Classify the support ticket.",
          prompt: "Subject: Charged twice\n\nHi, my card was charged twice for the March invoice and I can't reach anyone. Please fix this today, it's the second time this has happened.",
          schema: {
            type: "object",
            properties: {
              category: { type: "string", enum: ["billing", "bug", "feature_request", "account", "other"] },
              priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
              sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
              summary: { type: "string", description: "One sentence." },
              needs_human: { type: "boolean" },
            },
            required: ["category", "priority", "sentiment", "summary", "needs_human"],
            additionalProperties: false,
          },
        },
        {
          label: "Receipt line items",
          name: "Receipt",
          system: "Extract the receipt's line items and totals. Amounts are numbers in dollars.",
          prompt: "GREEN GROCER  10/28/2026\nBananas 1.2 lb ........ 0.83\nOat milk x2 ........... 7.98\nSourdough loaf ........ 6.50\nSUBTOTAL .............. 15.31\nTAX 8.25% ............. 0.63\nTOTAL ................. 15.94",
          schema: {
            type: "object",
            properties: {
              merchant: { type: "string" },
              date: { type: "string", description: "YYYY-MM-DD" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: { description: { type: "string" }, quantity: { type: "number" }, amount: { type: "number" } },
                  required: ["description", "quantity", "amount"],
                  additionalProperties: false,
                },
              },
              subtotal: { type: "number" },
              tax: { type: "number" },
              total: { type: "number" },
            },
            required: ["merchant", "date", "items", "subtotal", "tax", "total"],
            additionalProperties: false,
          },
        },
        {
          label: "Function arguments",
          name: "CreateEvent",
          system: "Turn the request into arguments for create_event. Today is Friday, October 30, 2026, in America/Los_Angeles.",
          prompt: "Set up a 45-minute design review with ana@example.com and ben@example.com next Tuesday at 2pm.",
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
              start: { type: "string", description: "ISO 8601 with offset" },
              duration_minutes: { type: "integer" },
              attendees: { type: "array", items: { type: "string" } },
            },
            required: ["title", "start", "duration_minutes", "attendees"],
            additionalProperties: false,
          },
        },
        {
          label: "A config from requirements",
          name: "DeployConfig",
          system: "Write the deployment config the requirements describe.",
          prompt: "Run the api service in us-east and eu-west, at least 3 replicas and at most 12, scaling at 65% CPU, with health checks on /healthz every 10 seconds.",
          schema: {
            type: "object",
            properties: {
              service: { type: "string" },
              regions: { type: "array", items: { type: "string", enum: ["us-east", "us-west", "eu-west", "ap-south"] } },
              autoscale: {
                type: "object",
                properties: { min: { type: "integer" }, max: { type: "integer" }, cpu_target_percent: { type: "integer" } },
                required: ["min", "max", "cpu_target_percent"],
                additionalProperties: false,
              },
              health_check: {
                type: "object",
                properties: { path: { type: "string" }, interval_seconds: { type: "integer" } },
                required: ["path", "interval_seconds"],
                additionalProperties: false,
              },
            },
            required: ["service", "regions", "autoscale", "health_check"],
            additionalProperties: false,
          },
        },
        {
          label: "A fixed-depth tree",
          name: "OrgChart",
          system: "Recursive schemas aren't supported, so this org chart is two levels deep by design.",
          prompt: "Make an org chart for a small startup: a CEO with two leads, each with two reports.",
          schema: {
            type: "object",
            properties: {
              name: { type: "string" },
              role: { type: "string" },
              reports: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    role: { type: "string" },
                    reports: {
                      type: "array",
                      items: { type: "object", properties: { name: { type: "string" }, role: { type: "string" } }, required: ["name", "role"], additionalProperties: false },
                    },
                  },
                  required: ["name", "role", "reports"],
                  additionalProperties: false,
                },
              },
            },
            required: ["name", "role", "reports"],
            additionalProperties: false,
          },
        },
      ],
      protocols: ["chat", "responses"],
      strict: false,
      sizePresets: [
        { label: "Ten levels (passes)", generate: "nested-10" },
        { label: "Eleven levels (fails)", generate: "nested-11" },
        { label: "Arrays count too (fails)", generate: "nested-arrays-11" },
        { label: "A recursive tree (fails)", schema: TREE_SCHEMA },
        { label: "A big string enum (fails)", generate: "big-enum" },
        { label: "1,500 enum values", generate: "many-enums" },
      ],
      enumAllowance: 3000,
      checks: STRUCTURED_CHECKS,
      checksIntro: "The page's rules, checked live. The 400s cost nothing; the accepted check costs a fraction of a cent.",
    },
    agentPrompt: {
      task:
        "Add structured output to my app: send a JSON Schema as response_format on Chat Completions (or text.format on Responses), parse the reply as JSON and validate it before use. Close every object and require every property, so strict: true accepts my schemas.",
      facts: [
        "Chat Completions: response_format {type: \"json_schema\", json_schema: {name, schema, strict}}. Responses: text.format {type: \"json_schema\", name, schema, strict}. Parse the text as JSON.",
        "Decoding always follows the schema. strict (default false) adds the subset check: object root, no allOf or oneOf, additionalProperties: false, every property required.",
        "Recursive schemas are HTTP 400.",
        "Limits (HTTP 400): depth 10 (arrays count), 5,000 properties, 120,000 characters, 1,000 enum values by default, 15,000 characters per string enum over 250 values.",
        "Python SDK: client.beta.chat.completions.parse(response_format=Model) gives .parsed.",
      ],
      checklist: [
        "The Address example returns street, city, state and zip as parseable JSON.",
        "A closed, fully required schema is accepted with strict: true.",
        "Unparseable or incomplete JSON is caught, never used.",
      ],
      snippets: {
        python: `import json, os

from openai import OpenAI

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])
schema = {"type": "object",
          "properties": {"street": {"type": "string"}, "city": {"type": "string"},
                         "state": {"type": "string", "description": "2-letter state abbreviation"},
                         "zip": {"type": "string", "description": "5-digit zip code"}},
          "required": ["street", "city", "state", "zip"], "additionalProperties": False}
response = client.chat.completions.create(
    model="muse-spark-1.3-contributor",
    messages=[{"role": "system", "content": "Extract the address as JSON."},
              {"role": "user", "content": "Please format this address: 1 Hacker Wy Menlo Park CA 94025"}],
    response_format={"type": "json_schema", "json_schema": {"name": "Address", "strict": True, "schema": schema}},
)
print(json.loads(response.choices[0].message.content))`,
        typescript: `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
const schema = {
  type: "object",
  properties: { street: { type: "string" }, city: { type: "string" },
    state: { type: "string", description: "2-letter state abbreviation" }, zip: { type: "string", description: "5-digit zip code" } },
  required: ["street", "city", "state", "zip"], additionalProperties: false,
};
const response = await client.chat.completions.create({
  model: "muse-spark-1.3-contributor",
  messages: [{ role: "system", content: "Extract the address as JSON." },
    { role: "user", content: "Please format this address: 1 Hacker Wy Menlo Park CA 94025" }],
  response_format: { type: "json_schema", json_schema: { name: "Address", strict: true, schema } },
});
const address = JSON.parse(response.choices[0].message.content ?? "{}");
console.log(address.city, address.state);`,
        curl: `curl -X POST "https://api.meta.ai/v1/chat/completions" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "model": "muse-spark-1.3-contributor",
  "messages": [
    {"role": "system", "content": "Extract the address from the user input into the specified JSON format."},
    {"role": "user", "content": "Please format this address: 1 Hacker Wy Menlo Park CA 94025"}
  ],
  "response_format": {"type": "json_schema", "json_schema": {"name": "Address", "schema": {
    "type": "object",
    "properties": {"street": {"type": "string"}, "city": {"type": "string"}, "state": {"type": "string"}, "zip": {"type": "string"}},
    "required": ["street", "city", "state", "zip"]
  }}}
}'`,
      },
    },
  },

  "prompt-caching": {
    title: "Send a long prefix twice and watch the cache",
    blurb:
      "Send both calls sends the same 8,300-token prefix twice with a different question at the end and compares cached_tokens, time to first text and cost; about a tenth of a cent on Spark 1.3 Contributor, up to 8 cents on Muse Wonder.",
    Component: PromptCachingLab,
    props: {
      scenarios: [
        {
          id: "same",
          label: "Same prefix twice",
          about: "Both calls start with the same instructions and book; only the question at the end differs. Call 2 should report most of its input as cached_tokens.",
        },
        {
          id: "timestamp",
          label: "Timestamp first",
          about: "The page's warning: volatile content early shortens the reusable prefix. Each call opens with the current time, so neither can reuse the other's long prefix.",
        },
        {
          id: "edit",
          label: "Edit the middle",
          about: "Call 2's book has a note put in partway through. The match ends at the first difference, so cached_tokens drops below what it would be.",
        },
      ],
      questions: ["What animal does Alice follow down the rabbit-hole?", "What does the label on the little bottle say?"],
      part: "chapters-1-3",
      effort: "minimal",
    },
    agentPrompt: {
      task:
        "Make my app's requests cache well: keep the stable part (system prompt, examples, reference documents) first and byte-identical, put the user's message and anything that changes last, send one stable prompt_cache_key per shared prefix, and log cached_tokens against input tokens on every call.",
      facts: [
        "Prefix caching is automatic, with no flag: the match ends at the first difference, so timestamps, ids and user data go last.",
        "cached_tokens is a subset of input: usage.input_tokens_details (Responses), usage.prompt_tokens_details (Chat). Cached input bills at $0.002 against $0.10 per million on muse-spark-1.3-contributor.",
        "prompt_cache_key (Responses and Chat): one stable value per shared prefix, not per user. Without it, a second call missed for us.",
        "prompt_cache_retention \"24h\" (Responses only) is a hint; store: false doesn't disable caching.",
        "Zero is normal on the first request with a new prefix or after eviction.",
      ],
      checklist: [
        "Two requests sharing a long prefix: the second reports most of its input as cached_tokens.",
        "Every request logs cached_tokens and input tokens.",
        "Nothing that changes per request sits before the stable prefix.",
      ],
      snippets: {
        python: `import os

from openai import OpenAI

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])

SYSTEM = open("support_handbook.md").read()  # long and stable: it goes first


def ask(question: str) -> str:
    response = client.chat.completions.create(
        model="muse-spark-1.3-contributor",
        prompt_cache_key="support-agent",  # one stable key per shared prefix
        messages=[
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": question},  # what changes goes last
        ],
    )
    usage = response.usage
    cached = usage.prompt_tokens_details.cached_tokens if usage.prompt_tokens_details else 0
    print(f"cached {cached} of {usage.prompt_tokens} input tokens")
    return response.choices[0].message.content


ask("How do I rotate my API keys without downtime?")
ask("How do I change the email on my account?")`,
        typescript: `import { readFileSync } from "node:fs";
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
const system = readFileSync("support_handbook.md", "utf8"); // long and stable: it goes first

async function ask(question: string) {
  const response = await client.chat.completions.create({
    model: "muse-spark-1.3-contributor",
    prompt_cache_key: "support-agent", // one stable key per shared prefix
    messages: [
      { role: "system", content: system },
      { role: "user", content: question }, // what changes goes last
    ],
  });
  const cached = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  console.log(\`cached \${cached} of \${response.usage?.prompt_tokens} input tokens\`);
  return response.choices[0].message.content;
}

await ask("How do I rotate my API keys without downtime?");
await ask("How do I change the email on my account?");`,
        curl: `curl -X POST "https://api.meta.ai/v1/chat/completions" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "model": "muse-spark-1.3-contributor",
  "prompt_cache_key": "my-app-system-prompt",
  "messages": [
    {"role": "system", "content": "You are a senior technical support engineer for Acme Corp. ... (your long, stable prompt)"},
    {"role": "user", "content": "How do I rotate my API keys without downtime?"}
  ]
}'
# Send it twice: the second reply's usage.prompt_tokens_details.cached_tokens should be most of prompt_tokens.`,
      },
    },
  },

  "token-counting": {
    title: "Count tokens before you send",
    blurb:
      "Count tokens counts a question, a tool conversation, web search's scaffolding, an image or a long document against the 1,048,576-token context window, for free; Send it runs the real call to compare the count with the reply's usage.",
    Component: TokenCounter,
    props: {
      endpoint: "responses/input_tokens",
      sampleId: "bar-chart",
    },
    agentPrompt: {
      task:
        "Add a preflight token count to my app: before a large or variable request, send the same body to POST /v1/responses/input_tokens (or POST /v1/messages/count_tokens for Anthropic-shaped ones), check that input_tokens plus the output limit fits the 1,048,576-token context window, and trim or split the input when it doesn't.",
      facts: [
        "responses/input_tokens takes the /v1/responses body and returns {\"object\": \"response.input_tokens\", \"input_tokens\": n}; messages/count_tokens takes the /v1/messages body. Free: nothing is generated or stored.",
        "It validates like a real request (HTTP 400 on bad arguments, call_id mismatches or tools) and resolves previous_response_id.",
        "Counts include Meta's injected prompt and tool scaffolding (web_search: 172 to 1,179 tokens) and depend on the model (172 Spark, 169 Wonder) and on image resolution.",
        "Size context with the count, not usage.input_tokens (discounted, and summed over hosted-tool turns).",
      ],
      checklist: [
        "The page's example (\"What is the capital of France?\") returns a small positive input_tokens.",
        "A request over the window is caught before it's sent.",
        "The count uses the same model, tools and instructions as the real call.",
      ],
      snippets: {
        python: `import os

import requests

CONTEXT_WINDOW = 1_048_576
headers = {"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}", "Content-Type": "application/json"}

body = {
    "model": "muse-spark-1.3-contributor",
    "input": "What is the capital of France?",
}
count = requests.post("https://api.meta.ai/v1/responses/input_tokens", headers=headers, json=body)
count.raise_for_status()
input_tokens = count.json()["input_tokens"]

max_output = 4000
if input_tokens + max_output > CONTEXT_WINDOW:
    raise ValueError(f"{input_tokens} input tokens leave no room for {max_output} output tokens")

reply = requests.post("https://api.meta.ai/v1/responses", headers=headers, json={**body, "max_output_tokens": max_output})
reply.raise_for_status()
print(input_tokens, reply.json()["usage"]["input_tokens"])`,
        typescript: `const CONTEXT_WINDOW = 1_048_576;
const headers = { Authorization: \`Bearer \${process.env.MODEL_API_KEY}\`, "Content-Type": "application/json" };
const body = { model: "muse-spark-1.3-contributor", input: "What is the capital of France?" };

const count = await fetch("https://api.meta.ai/v1/responses/input_tokens", { method: "POST", headers, body: JSON.stringify(body) });
if (!count.ok) throw new Error(\`HTTP \${count.status}: \${await count.text()}\`);
const { input_tokens } = await count.json();

const maxOutput = 4000;
if (input_tokens + maxOutput > CONTEXT_WINDOW) throw new Error(\`\${input_tokens} input tokens: no room for the output\`);

const reply = await fetch("https://api.meta.ai/v1/responses", { method: "POST", headers, body: JSON.stringify({ ...body, max_output_tokens: maxOutput }) });
if (!reply.ok) throw new Error(\`HTTP \${reply.status}: \${await reply.text()}\`);
console.log(input_tokens, (await reply.json()).usage.input_tokens);`,
        curl: `curl -X POST "https://api.meta.ai/v1/responses/input_tokens" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "model": "muse-spark-1.3-contributor",
  "input": "What is the capital of France?"
}'

# Anthropic-shaped requests:
curl -X POST "https://api.meta.ai/v1/messages/count_tokens" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "muse-spark-1.3-contributor", "messages": [{"role": "user", "content": "What is the capital of France?"}]}'`,
      },
    },
  },
};
