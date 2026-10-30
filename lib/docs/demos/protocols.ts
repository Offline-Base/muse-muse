import type { ConsolePreset } from "@/components/docs/playgrounds/protocols/ConsolePresets";
import { ConsolePresets } from "@/components/docs/playgrounds/protocols/ConsolePresets";
import type { FlowCheck, FlowSpec, FlowStep } from "@/components/docs/playgrounds/protocols/flow";
import { ProtocolCompare } from "@/components/docs/playgrounds/protocols/ProtocolCompare";
import { ProtocolLab, type LabTab } from "@/components/docs/playgrounds/protocols/ProtocolLab";
import { CHAT_SCHEMAS, MESSAGES_SCHEMAS, RESPONSES_SCHEMAS } from "@/components/docs/playgrounds/protocols/schema-examples";
import { SchemaExplorer } from "@/components/docs/playgrounds/protocols/SchemaExplorer";
import type { ComponentType } from "react";
import type { AgentPromptSpec, DemoMap, DemoSpec } from "@/lib/docs/demos/types";

/**
 * Live demos and coding-agent prompts for the "protocols" pages:
 *   protocols
 *   protocols/responses
 *   protocols/chat-completions
 *   protocols/messages
 *   api-reference/responses
 *   api-reference/responses/create-response
 *   api-reference/responses/retrieve-response
 *   api-reference/responses/delete-response
 *   api-reference/responses/cancel-response
 *   api-reference/responses/count-input-tokens
 *   api-reference/responses/schemas
 *   api-reference/chat-completions
 *   api-reference/chat-completions/create-chat-completion
 *   api-reference/chat-completions/schemas
 *   api-reference/messages
 *   api-reference/messages/create-message
 *   api-reference/messages/count-tokens
 *   api-reference/messages/schemas
 * Components live in components/docs/playgrounds/protocols/.
 *
 * Every request here was sent through the docs proxy while this was built, on muse-spark-1.3-contributor at low
 * effort. Each 400 check also checks the error names the field it's about (error.param on Responses and Chat
 * Completions, the message on Messages), so a 400 for another reason doesn't pass. Three rules the Responses guide
 * documents as 400s were accepted by the live API when this was built (truncation "auto", a reasoning item right
 * before a user message, answer text right before a function_call); they stay in the Errors tab, where the flow
 * shows them as accepted, because the page documents them and code should follow the page.
 *
 * Every call counts toward the live docs' per-minute limits (20 a reader, rejected calls included), so the check
 * lists are paced and background runs are polled every few seconds rather than every second.
 */

// ---------- Shared request pieces ----------

/** Flows fill {{model}} from their model menu; the consoles' bodies name the model outright. */
const M = "{{model}}";
const SPARK = "muse-spark-1.3-contributor";
/** Background runs hold their worst case until they finish, which keeps Muse Wonder out of them in the live docs. */
const SPARK_MODELS = ["muse-spark-1.3-contributor", "muse-spark-1.2", "muse-spark-1.2-contributor", "muse-spark-1.1"];

const CAPITAL = "What is the capital of France?";
const BAT_AND_BALL = "A bat and a ball cost $1.10 together. The bat costs $1.00 more than the ball. How much is the ball? One sentence.";
const WEATHER = "What's the weather in Paris right now?";
const WEATHER_RESULT = '{"temperature_c": 18, "conditions": "light rain"}';
const STORY = "Write a 600-word story about a lighthouse keeper who adopts a seagull.";
const PLACE_PROMPT = "I flew home from Lisbon, Portugal last week. Extract the place.";
const TCP = "What are three differences between TCP and UDP?";
const REVIEWER =
  "You are a senior backend engineer reviewing pull requests. For each code snippet the user shares, respond with: 1) a one-line summary of what the code does, 2) any bugs or issues, 3) one concrete improvement suggestion. Be direct. Do not repeat the code back.";

const PLACE_SCHEMA = {
  type: "object",
  properties: { city: { type: "string" }, country: { type: "string" } },
  required: ["city", "country"],
  additionalProperties: false,
};
const CITY_PARAMS = {
  type: "object",
  properties: { city: { type: "string", description: "City name, such as Paris" } },
  required: ["city"],
  additionalProperties: false,
};
const R_TOOL = { type: "function", name: "get_weather", description: "Get the current weather for a city.", parameters: CITY_PARAMS };
const C_TOOL = { type: "function", function: { name: "get_weather", description: "Get the current weather for a city.", parameters: CITY_PARAMS } };
const A_TOOL = { name: "get_weather", description: "Get the current weather for a city.", input_schema: CITY_PARAMS };

type Body = Record<string, unknown>;
/** A Responses body for a flow: low effort and room for the reasoning plus a short answer. */
const resp = (extra: Body): Body => ({ model: M, reasoning: { effort: "low" }, max_output_tokens: 1500, ...extra });
const chat = (extra: Body): Body => ({ model: M, reasoning_effort: "low", max_completion_tokens: 1500, ...extra });
const msg = (extra: Body): Body => ({ model: M, max_tokens: 1500, ...extra });

/** A literal as a RegExp source. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface FailsOptions {
  note?: string;
  /** The field the error's param should name: "call_id" also matches "input[1].call_id", "include" "include[0]". */
  param?: string;
  /** Words the error message should hold (Messages errors carry no param), and how to say that in the check. */
  mentions?: string;
  mentionsLabel?: string;
  /** More checks, for an error the page describes without naming a param. */
  checks?: FlowCheck[];
}

/**
 * A check that expects the documented 400. It stands alone, uses no tokens, and also checks that the error names the
 * field (or the reason) the page gives, so a 400 for something else (a storage lag, say) doesn't pass as this one.
 */
const fails = (id: string, title: string, path: string, body: Body, options: FailsOptions = {}): FlowStep => {
  const checks: FlowCheck[] = [
    ...(options.param ? [{ path: "error.param", matches: `(^|[.\\]])${literal(options.param)}(\\[\\d+\\])?$`, label: `error.param names ${options.param}` }] : []),
    ...(options.mentions
      ? [{ path: "error.message", matches: literal(options.mentions), label: options.mentionsLabel ?? `The message names ${options.mentions}` }]
      : []),
    ...(options.checks ?? []),
  ];
  return {
    id,
    title,
    path,
    body,
    independent: true,
    expect: { status: 400, ...(checks.length ? { checks } : {}) },
    ...(options.note ? { note: options.note } : {}),
  };
};

/** Paces a list of quick checks: each counts toward the per-minute limits, so Run all sends one every 1.5 s or so. */
const CHECK_PACE_MS = 1500;
/** Said in every check list's intro. */
const CHECKS_COUNT = "An error uses no tokens, but every check counts toward the live demos' per-minute limit, so Run all spaces them out.";

const flow = (id: string, label: string, props: FlowSpec, intro?: string): LabTab => ({ id, label, kind: "flow", props, ...(intro ? { intro } : {}) });
const consoleTab = (id: string, label: string, presets: ConsolePreset[], intro?: string): LabTab => ({
  id,
  label,
  kind: "console",
  props: { presets },
  ...(intro ? { intro } : {}),
});
const post = (path: string, body: Body, extra: Partial<ConsolePreset["console"]> = {}): ConsolePreset["console"] => ({ method: "POST", path, body, ...extra });

// ---------- Flows ----------

const RESPONSES_MULTI_TURN: FlowSpec = {
  intro: "The guide's three questions, chained with previous_response_id. Each request carries only the new question; the server rebuilds the conversation.",
  vars: [
    { name: "q1", label: "Turn 1", value: CAPITAL },
    { name: "q2", label: "Turn 2", value: "What is the population of that city?" },
    { name: "q3", label: "Turn 3", value: "How does that compare to London?" },
  ],
  steps: [
    {
      id: "turn1",
      title: "First turn, stored by default",
      path: "responses",
      body: resp({ instructions: "Answer in one or two sentences.", input: "{{vars.q1}}" }),
      show: ["id", "store", "usage.input_tokens"],
      note: "store defaults to true, so this response can be read back and chained from.",
    },
    {
      id: "turn2",
      title: "Second turn: only the new input",
      path: "responses",
      body: resp({ instructions: "Answer in one or two sentences.", previous_response_id: "{{turn1.id}}", input: "{{vars.q2}}" }),
      retry: { statuses: [400], tries: 3, delayMs: 2500 },
      show: ["previous_response_id", "usage.input_tokens"],
      note: "The body holds just the new question and previous_response_id. instructions doesn't carry over, so it's sent again, and input_tokens grows as the server adds the history.",
    },
    {
      id: "turn3",
      title: "Third turn",
      path: "responses",
      body: resp({ instructions: "Answer in one or two sentences.", previous_response_id: "{{turn2.id}}", input: "{{vars.q3}}" }),
      retry: { statuses: [400], tries: 3, delayMs: 2500 },
      show: ["previous_response_id", "usage.input_tokens"],
    },
    {
      id: "read",
      title: "Read the last turn back",
      path: "responses/{{turn3.id}}",
      retry: { statuses: [404], tries: 3, delayMs: 2500 },
      show: ["status", "previous_response_id", "instructions", "completed_at", "usage.output_tokens_details.reasoning_tokens"],
      expect: {
        checks: [
          { path: "previous_response_id", equals: "{{turn2.id}}", label: "previous_response_id is echoed" },
          { path: "instructions", present: true, label: "instructions is echoed" },
          { path: "completed_at", present: true, label: "completed_at is set on a completed response" },
        ],
      },
      note: "GET /v1/responses/{id} returns the stored response with the request's own parameters and the full usage breakdown.",
    },
  ],
};

const RESPONSES_STATELESS: FlowSpec = {
  intro: "Nothing is stored: each turn sends the whole conversation, reasoning items included, so the model keeps its chain of thought.",
  vars: [
    { name: "q1", label: "Turn 1", value: CAPITAL },
    { name: "q2", label: "Turn 2", value: "What is its population?" },
  ],
  steps: [
    {
      id: "turn1",
      title: "Turn 1 with store: false",
      path: "responses",
      body: resp({ input: "{{vars.q1}}", store: false, include: ["reasoning.encrypted_content"] }),
      show: ["store", "output[type=reasoning].id"],
      expect: {
        checks: [
          { path: "store", equals: false, label: "Nothing is stored" },
          { path: "output[type=reasoning].encrypted_content", present: true, label: "The reasoning item carries encrypted_content" },
        ],
      },
    },
    {
      id: "turn2",
      title: "Turn 2 replays everything",
      path: "responses",
      body: resp({
        store: false,
        include: ["reasoning.encrypted_content"],
        input: [{ role: "user", content: "{{vars.q1}}" }, { $spread: "turn1.output" }, { role: "user", content: "{{vars.q2}}" }],
      }),
      show: ["usage.input_tokens"],
      note: "input holds turn 1's question, its reasoning item with encrypted_content, the assistant message, then the new question. No previous_response_id: the encrypted item carries the state.",
    },
    fails(
      "bare",
      "A reasoning item without encrypted_content",
      "responses",
      resp({
        store: false,
        input: [{ role: "user", content: "{{vars.q1}}" }, { type: "reasoning", id: "{{turn1.output[type=reasoning].id}}", summary: [] }, "{{turn1.output[type=message]}}", { role: "user", content: "{{vars.q2}}" }],
      }),
      {
        note: "Replaying a bare rs_ id returns HTTP 400: with nothing stored, the server can't look it up.",
        mentions: "reasoning item",
        mentionsLabel: "The message says the reasoning item wasn't found",
      },
    ),
  ],
};

const RESPONSES_BACKGROUND: FlowSpec = {
  intro: "background: true answers at once and runs the response on its own. Live demos run background responses on Muse Spark only.",
  models: SPARK_MODELS,
  steps: [
    {
      id: "long",
      title: "Start a long one in the background",
      path: "responses",
      body: { model: M, input: STORY, background: true, reasoning: { effort: "low" }, max_output_tokens: 3000 },
      show: ["id", "status", "background"],
      expect: {
        checks: [
          { path: "status", oneOf: ["queued", "in_progress"], label: "The acknowledgement comes at once, queued" },
          { path: "background", equals: true, label: "It says background: true" },
        ],
      },
    },
    {
      id: "cancel",
      title: "Cancel it right away",
      method: "POST",
      path: "responses/{{long.id}}/cancel",
      show: ["status"],
      expect: {
        checks: [
          { path: "status", oneOf: ["cancelled", "in_progress"], label: "It answers with the current status: cancelled, or in_progress while the cancel takes hold" },
          { path: "output", empty: true, label: "output is always empty on a cancel" },
        ],
      },
    },
    {
      id: "settled",
      title: "Read it back until it settles",
      path: "responses/{{long.id}}",
      poll: { path: "status", until: ["cancelled", "completed", "failed", "incomplete"], everyMs: 3000, tries: 10 },
      show: ["status", "completed_at"],
      expect: {
        checks: [
          {
            path: "status",
            oneOf: ["cancelled", "completed"],
            label: "It settles: cancelled, or completed when the run finished before the cancel took hold",
          },
        ],
      },
      note: "A cancelled response keeps completed_at null, since it never completed.",
    },
    {
      id: "short",
      title: "Start a short one",
      path: "responses",
      body: { model: M, input: "Write a haiku about patience.", background: true, reasoning: { effort: "low" }, max_output_tokens: 1500 },
      show: ["id", "status"],
    },
    {
      id: "poll",
      title: "Poll until it finishes",
      path: "responses/{{short.id}}",
      poll: { path: "status", until: ["completed", "failed", "cancelled", "incomplete"], everyMs: 4000, tries: 15 },
      show: ["status", "completed_at", "usage.output_tokens"],
      expect: {
        checks: [
          { path: "status", equals: "completed", label: "It completed" },
          { path: "completed_at", present: true, label: "completed_at is set once it completes" },
        ],
      },
    },
    {
      id: "delete",
      title: "Delete it",
      method: "DELETE",
      path: "responses/{{short.id}}",
      show: ["object", "deleted"],
      expect: { checks: [{ path: "deleted", equals: true, label: "deleted: true" }] },
    },
    {
      id: "again",
      title: "Delete it again",
      method: "DELETE",
      path: "responses/{{short.id}}",
      independent: true,
      expect: { status: 404 },
      note: "Not idempotent: a repeat DELETE is a 404. The live docs answer this one themselves, since the response is gone from this browser's list; Meta's API answers 404 too.",
    },
  ],
};

const RESPONSES_STREAMING: FlowSpec = {
  intro: "stream: true sends typed server-sent events. The raw chain of thought never streams as text; with reasoning.summary set, the summary does.",
  vars: [{ name: "q", label: "Question", value: BAT_AND_BALL, multiline: true }],
  steps: [
    {
      id: "text",
      title: "Text and a reasoning summary",
      path: "responses",
      stream: true,
      body: { model: M, input: "{{vars.q}}", reasoning: { effort: "medium", summary: "auto" }, max_output_tokens: 3000, stream: true },
      expect: {
        events: [
          "response.created",
          "response.in_progress",
          "response.output_item.added",
          "response.reasoning_summary_text.delta",
          "response.content_part.added",
          "response.output_text.delta",
          "response.output_text.done",
          "response.output_item.done",
          "response.completed",
        ],
      },
    },
    {
      id: "args",
      title: "Tool arguments stream too",
      path: "responses",
      stream: true,
      independent: true,
      body: resp({ input: WEATHER, tools: [R_TOOL], stream: true }),
      expect: { events: ["response.function_call_arguments.delta", "response.function_call_arguments.done", "response.completed"] },
    },
    {
      id: "cut",
      title: "Out of tokens: response.incomplete",
      path: "responses",
      stream: true,
      independent: true,
      body: { model: M, input: "Explain how neural networks learn.", max_output_tokens: 16, stream: true },
      expect: {
        events: ["response.incomplete"],
        checks: [{ path: "incomplete_details.reason", equals: "max_output_tokens", label: "incomplete_details says why" }],
      },
      note: "max_output_tokens counts reasoning too, and 16 is its minimum, so this run stops early.",
    },
  ],
};

const RESPONSES_FILES_SEARCH: FlowSpec = {
  intro: "Inputs beyond text, and search grounding. The samples go inline as data URLs; the search costs $0.0025 a query and the live docs cap built-in tool calls at 5.",
  steps: [
    {
      id: "pdf",
      title: "A PDF with input_file",
      path: "responses",
      independent: true,
      body: resp({
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
      note: "The 2-page sample report, inline as file_data. Larger files go up with the Files API and travel as file_id.",
    },
    {
      id: "image",
      title: "An image with input_image",
      path: "responses",
      independent: true,
      body: resp({
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "What animal is this, and where is it? One sentence." },
              { type: "input_image", image_url: "{{sample:cat-sofa}}" },
            ],
          },
        ],
      }),
    },
    {
      id: "search",
      title: "Search grounding with web_search",
      path: "responses",
      stream: true,
      independent: true,
      body: { model: M, input: "Who won the most recent Formula 1 race? One sentence.", tools: [{ type: "web_search" }], reasoning: { effort: "low" }, max_output_tokens: 3000, stream: true },
      expect: { events: ["response.web_search_call.searching", "response.web_search_call.completed", "response.completed"] },
    },
  ],
};

/** A get_weather call and its output with the given call id, for the call_id checks. */
const callPair = (callId: string, outputId = callId) => [
  { role: "user", content: WEATHER },
  { type: "function_call", call_id: callId, name: "get_weather", arguments: '{"city":"Paris"}' },
  { type: "function_call_output", call_id: outputId, output: WEATHER_RESULT },
];
const LONG_CALL_ID = `call_${"x".repeat(60)}`;
/** Said under the documented rules the live API accepted when this was built. */
const ACCEPTED_WHEN_BUILT = "The live API accepted this when the demo was built, so it may show as accepted.";

const RESPONSES_GOTCHAS: FlowSpec = {
  intro: `Requests this page says return HTTP 400, sent for real. ${CHECKS_COUNT} The last three are rules the page documents that the live API accepted when this demo was built: follow the page anyway.`,
  paceMs: CHECK_PACE_MS,
  steps: [
    {
      id: "stored",
      title: "A stored response with its reasoning, to point at",
      path: "responses",
      body: resp({ input: "Say hi.", include: ["reasoning.encrypted_content"] }),
      show: ["id", "output[type=reasoning].id"],
    },
    fails(
      "mix",
      "Encrypted replay with previous_response_id",
      "responses",
      { model: M, previous_response_id: "{{stored.id}}", input: "Again?", include: ["reasoning.encrypted_content"], max_output_tokens: 400 },
      { note: "Choose one source of prior reasoning: previous_response_id or encrypted replay.", param: "include" },
    ),
    fails("none", 'reasoning.effort "none"', "responses", { model: M, input: "Hi", reasoning: { effort: "none" }, max_output_tokens: 400 }, { note: "Muse Spark always reasons.", param: "reasoning.effort" }),
    fails("min", "max_output_tokens below 16", "responses", { model: M, input: "Hi", max_output_tokens: 15 }, { param: "max_output_tokens" }),
    fails("bgstream", "background with stream", "responses", { model: M, input: "Hi", background: true, stream: true, max_output_tokens: 400 }, { param: "background" }),
    fails(
      "logprobs",
      "Log probabilities",
      "responses",
      { model: M, input: "Hi", include: ["message.output_text.logprobs"], max_output_tokens: 400 },
      { note: "Muse Spark is a reasoning model.", param: "logprobs" },
    ),
    fails(
      "include",
      "An unknown include value",
      "responses",
      { model: M, input: "Hi", include: ["not.a.real.field"], max_output_tokens: 400 },
      { note: "include takes only the values the page lists; the error names the ones it accepts.", param: "include" },
    ),
    fails(
      "pair",
      "A function_call_output with no matching call",
      "responses",
      { model: M, input: callPair("call_a", "call_b"), tools: [R_TOOL], max_output_tokens: 400 },
      { note: "Without previous_response_id, every function_call_output.call_id must match a function_call in the same request.", param: "call_id" },
    ),
    fails("empty", "An empty call_id", "responses", { model: M, input: callPair(""), tools: [R_TOOL], max_output_tokens: 400 }, { param: "call_id" }),
    fails(
      "long",
      "A call_id over 64 characters",
      "responses",
      { model: M, input: callPair(LONG_CALL_ID), tools: [R_TOOL], max_output_tokens: 400 },
      { note: "Every call_id must be 1 to 64 characters.", param: "call_id" },
    ),
    fails(
      "order",
      "A reasoning item right before a user message",
      "responses",
      { model: M, store: false, input: [{ role: "user", content: "Say hi." }, "{{stored.output[type=reasoning]}}", { role: "user", content: "Now say it in French." }], max_output_tokens: 400 },
      {
        note: `The page: a replayed reasoning item must be followed by an assistant message or a function_call before the next user, system or developer message; after a reasoning-only turn, insert a minimal assistant message. ${ACCEPTED_WHEN_BUILT}`,
        param: "input",
      },
    ),
    fails(
      "phase",
      "Answer text right before a function_call",
      "responses",
      {
        model: M,
        input: [
          { role: "user", content: WEATHER },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Let me check the weather first." }] },
          { type: "function_call", call_id: "call_a", name: "get_weather", arguments: '{"city":"Paris"}' },
          { type: "function_call_output", call_id: "call_a", output: WEATHER_RESULT },
        ],
        tools: [R_TOOL],
        max_output_tokens: 400,
      },
      {
        note: `The page: assistant text before a function_call must carry phase "commentary"; replayed as a final answer, it's a 400. ${ACCEPTED_WHEN_BUILT}`,
        // Error handling's "Invalid conversation structure" names no param for this case, only the problem.
        checks: [{ path: "error.message", matches: "phase|commentary|conversation structure", label: "The message names the phase or the conversation structure" }],
      },
    ),
    fails(
      "truncation",
      'truncation "auto"',
      "responses",
      { model: M, input: "Hi", truncation: "auto", max_output_tokens: 400 },
      { note: `The page: only "disabled" is accepted, so trim long histories yourself. ${ACCEPTED_WHEN_BUILT}`, param: "truncation" },
    ),
  ],
};

const SAY_HI = [{ role: "user", content: "Say hi." }];

const CHAT_CHECKS: FlowSpec = {
  intro: `The parameters this page lists as unsupported, sent for real: each one returns HTTP 400 with an error naming the field. ${CHECKS_COUNT}`,
  paceMs: CHECK_PACE_MS,
  steps: [
    fails("n", "n greater than 1", "chat/completions", chat({ messages: SAY_HI, n: 2 }), { param: "n" }),
    fails("top_p", "top_p of 0", "chat/completions", chat({ messages: SAY_HI, top_p: 0 }), { param: "top_p" }),
    fails("logprobs", "logprobs", "chat/completions", chat({ messages: SAY_HI, logprobs: true }), { param: "logprobs" }),
    fails("stop", "stop sequences", "chat/completions", chat({ messages: SAY_HI, stop: ["END"] }), { param: "stop" }),
    fails("logit_bias", "logit_bias", "chat/completions", chat({ messages: SAY_HI, logit_bias: { "1734": -100 } }), { note: "Unsupported on reasoning models.", param: "logit_bias" }),
    fails(
      "prediction",
      "Predicted outputs",
      "chat/completions",
      chat({ messages: SAY_HI, prediction: { type: "content", content: "Hi there!" } }),
      { note: "Unsupported on reasoning models.", param: "prediction" },
    ),
    fails("none", 'reasoning_effort "none"', "chat/completions", chat({ messages: SAY_HI, reasoning_effort: "none" }), { param: "reasoning_effort" }),
    fails("text", "text.format (a Responses field)", "chat/completions", chat({ messages: SAY_HI, text: { format: { type: "text" } } }), { note: "Use response_format here.", param: "text" }),
    fails(
      "max_output",
      "max_output_tokens (a Responses field)",
      "chat/completions",
      { model: M, messages: SAY_HI, max_output_tokens: 500 },
      { note: "Use max_completion_tokens here.", param: "max_output_tokens" },
    ),
    fails(
      "search",
      "web_search_options",
      "chat/completions",
      chat({ messages: SAY_HI, web_search_options: {} }),
      { note: "Search grounding runs on Responses and Messages.", param: "web_search_options" },
    ),
    fails("modalities", "Audio modalities", "chat/completions", chat({ messages: SAY_HI, modalities: ["audio"] }), { param: "modalities" }),
    fails("audio", "Audio output", "chat/completions", chat({ messages: SAY_HI, audio: { voice: "alloy", format: "wav" } }), { note: "No audio output.", param: "audio" }),
    fails("verbosity", "verbosity", "chat/completions", chat({ messages: SAY_HI, verbosity: "low" }), { param: "verbosity" }),
    fails(
      "tool",
      "A tool message without its assistant tool_calls",
      "chat/completions",
      chat({ messages: [{ role: "user", content: WEATHER }, { role: "tool", tool_call_id: "call_1", content: WEATHER_RESULT }] }),
      { note: "Replay the assistant message that holds the tool_calls before its tool results.", param: "tool_call_id" },
    ),
    {
      id: "alias",
      title: "The deprecated max_tokens alias still works",
      path: "chat/completions",
      independent: true,
      body: { model: M, messages: [{ role: "user", content: "Say hi in five words." }], reasoning_effort: "low", max_tokens: 1000 },
      show: ["usage.completion_tokens"],
    },
  ],
};

const MESSAGES_THINKING: FlowSpec = {
  intro:
    "Muse Spark always reasons. The page says thinking adaptive returns a thinking summary (display summarized is the default); when this demo was built, the reasoning came back as redacted_thinking blocks only. Either way, replay the blocks as they are.",
  steps: [
    {
      id: "adaptive",
      title: "thinking adaptive with an effort",
      path: "messages",
      body: msg({ messages: [{ role: "user", content: BAT_AND_BALL }], thinking: { type: "adaptive" }, output_config: { effort: "low" } }),
      show: ["content[0].type", "content[-1].type", "stop_reason", "usage.output_tokens_details.thinking_tokens"],
      expect: {
        checks: [{ path: "content[0].type", oneOf: ["thinking", "redacted_thinking"], label: "The reasoning comes first, as a thinking or redacted_thinking block" }],
      },
      note: "A thinking block would carry the summary the page describes; a redacted_thinking block carries only the encrypted reasoning.",
    },
    {
      id: "replay",
      title: "Replay it on the next turn",
      path: "messages",
      body: msg({
        messages: [
          { role: "user", content: BAT_AND_BALL },
          { role: "assistant", content: "{{adaptive.content}}" },
          { role: "user", content: "And how much is the bat?" },
        ],
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
      }),
      show: ["usage.input_tokens", "usage.cache_read_input_tokens"],
      note: "The assistant turn goes back with all its content blocks, redacted_thinking included, so the chain of thought carries over.",
    },
    {
      id: "budget",
      title: "budget_tokens is accepted for compatibility",
      path: "messages",
      independent: true,
      body: { model: M, max_tokens: 2500, thinking: { type: "enabled", budget_tokens: 1024 }, messages: [{ role: "user", content: "Which river runs through Paris? One sentence." }] },
      show: ["usage.output_tokens_details.thinking_tokens"],
      note: "It needs budget_tokens of at least 1024 and below max_tokens, and doesn't set the effort: use output_config.effort for that.",
    },
    fails(
      "small",
      "budget_tokens under 1024",
      "messages",
      { model: M, max_tokens: 2500, thinking: { type: "enabled", budget_tokens: 512 }, messages: [{ role: "user", content: "Hi" }] },
      { mentions: "budget_tokens" },
    ),
    fails(
      "disabled",
      "thinking disabled",
      "messages",
      { model: M, max_tokens: 1000, thinking: { type: "disabled" }, messages: [{ role: "user", content: "Hi" }] },
      { note: "Muse Spark can't turn reasoning off: the adapter reads disabled as effort \"none\".", mentions: "none", mentionsLabel: 'The message names effort "none"' },
    ),
  ],
};

const MESSAGES_TOOL_USE: FlowSpec = {
  intro: "A custom tool round trip in the Anthropic shape: the model asks with tool_use, your code answers with tool_result in the next user turn.",
  steps: [
    {
      id: "call",
      title: "The model asks for get_weather",
      path: "messages",
      body: msg({ messages: [{ role: "user", content: WEATHER }], tools: [A_TOOL] }),
      show: ["stop_reason", "content[type=tool_use].name", "content[type=tool_use].input"],
      expect: { checks: [{ path: "stop_reason", equals: "tool_use", label: "stop_reason is tool_use" }] },
    },
    {
      id: "result",
      title: "Send the result back",
      path: "messages",
      body: msg({
        messages: [
          { role: "user", content: WEATHER },
          { role: "assistant", content: "{{call.content}}" },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "{{call.content[type=tool_use].id}}", content: WEATHER_RESULT }] },
        ],
        tools: [A_TOOL],
      }),
      show: ["stop_reason"],
      expect: { checks: [{ path: "stop_reason", equals: "end_turn", label: "The final answer ends with end_turn" }] },
      note: "Your code ran get_weather here; this demo answers with a fixed result. The assistant's content, thinking blocks included, goes back first.",
    },
  ],
};

const MESSAGES_COUNT_THEN_SEND: FlowSpec = {
  intro: "count_tokens takes the same body as a message, without max_tokens, and generates nothing.",
  steps: [
    {
      id: "count",
      title: "Count the request",
      path: "messages/count_tokens",
      body: { model: M, system: "You are a geography tutor.", messages: [{ role: "user", content: CAPITAL }] },
      show: ["input_tokens"],
    },
    {
      id: "send",
      title: "Send the same request",
      path: "messages",
      body: { model: M, max_tokens: 1500, system: "You are a geography tutor.", messages: [{ role: "user", content: CAPITAL }] },
      show: ["usage.input_tokens", "usage.cache_read_input_tokens"],
      note: "count_tokens measures the fully rendered input, so it can read higher than the usage a real call bills.",
    },
  ],
};

const MESSAGES_CHECKS: FlowSpec = {
  intro: `Fields this page says return HTTP 400, sent for real. Each error comes back in Anthropic's envelope, its message naming the field. ${CHECKS_COUNT}`,
  paceMs: CHECK_PACE_MS,
  steps: (
    [
      ["stop", "stop_sequences", { stop_sequences: ["END"] }, "stop_sequences"],
      ["top_k", "top_k", { top_k: 5 }, "top_k"],
      ["container", "container", { container: "c1" }, "container"],
      ["geo", "inference_geo", { inference_geo: "us" }, "inference_geo"],
      ["unknown", "An unknown top-level field", { foo: 1 }, "foo"],
      ["named", "A named tool_choice", { tool_choice: { type: "tool", name: "get_weather" }, tools: [A_TOOL] }, "tool_choice"],
      ["uses", "web_search max_uses", { tools: [{ type: "web_search", max_uses: 2 }] }, "max_uses"],
      ["system", "An image in system", { system: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }] }, "image"],
      ["temp", "temperature above 1", { temperature: 1.5 }, "temperature"],
      ["tier", 'service_tier "priority"', { service_tier: "priority" }, "service_tier"],
    ] as const
  ).map(([id, title, extra, field]) => {
    const step = fails(id, title, "messages", { model: M, max_tokens: 1000, messages: SAY_HI, ...extra }, { mentions: field });
    return {
      ...step,
      expect: {
        status: 400,
        checks: [
          { path: "type", equals: "error", label: 'type is "error"' },
          { path: "error.type", equals: "invalid_request_error", label: "error.type is invalid_request_error" },
          ...(step.expect?.checks ?? []),
        ],
      },
    };
  }),
};

const LIFECYCLE: FlowSpec = {
  intro: "Every endpoint in this section on one response.",
  steps: [
    {
      id: "create",
      title: "Create a stored response",
      path: "responses",
      body: resp({ input: CAPITAL, metadata: { demo: "lifecycle" } }),
      show: ["id", "status", "store"],
    },
    {
      id: "count",
      title: "Count the next turn's input tokens",
      path: "responses/input_tokens",
      body: { model: M, previous_response_id: "{{create.id}}", input: "And its population?" },
      retry: { statuses: [400, 404], tries: 3, delayMs: 2500 },
      show: ["object", "input_tokens"],
      note: "The count includes the resolved previous_response_id history. Nothing is generated or stored.",
    },
    {
      id: "read",
      title: "Retrieve it",
      path: "responses/{{create.id}}",
      retry: { statuses: [404], tries: 3, delayMs: 2500 },
      show: ["status", "metadata", "completed_at"],
      expect: { checks: [{ path: "metadata.demo", equals: "lifecycle", label: "metadata is echoed" }] },
    },
    {
      id: "delete",
      title: "Delete it",
      method: "DELETE",
      path: "responses/{{create.id}}",
      show: ["object", "deleted"],
      retry: { statuses: [404], tries: 3, delayMs: 2500 },
      expect: { checks: [{ path: "deleted", equals: true, label: "deleted: true" }] },
    },
    {
      id: "gone",
      title: "Retrieve it after the delete",
      path: "responses/{{create.id}}",
      independent: true,
      expect: { status: 404 },
      note: "A deleted response can't be read or chained from. The live docs answer this 404 themselves, since the response is gone from this browser's list.",
    },
  ],
};

const CANCEL_FLOW: FlowSpec = {
  intro: "Only background responses can be cancelled. Live demos run them on Muse Spark only.",
  models: SPARK_MODELS,
  steps: [
    {
      id: "start",
      title: "Start a long response in the background",
      path: "responses",
      body: { model: M, input: STORY, background: true, reasoning: { effort: "low" }, max_output_tokens: 3000 },
      show: ["id", "status"],
    },
    {
      id: "cancel",
      title: "Cancel it",
      method: "POST",
      path: "responses/{{start.id}}/cancel",
      show: ["object", "status", "background"],
      expect: {
        checks: [
          { path: "status", oneOf: ["cancelled", "in_progress"], label: "It answers with the current status: cancelled, or in_progress while the cancel takes hold" },
          { path: "output", empty: true, label: "output is always empty" },
        ],
      },
    },
    {
      id: "read",
      title: "Retrieve it until it settles",
      path: "responses/{{start.id}}",
      poll: { path: "status", until: ["cancelled", "completed", "failed", "incomplete"], everyMs: 3000, tries: 10 },
      show: ["status", "completed_at"],
      expect: {
        checks: [
          {
            path: "status",
            oneOf: ["cancelled", "completed"],
            label: "It settles: cancelled, or completed when the run finished before the cancel took hold",
          },
        ],
      },
      note: "A cancelled response keeps completed_at null, since it never completed.",
    },
    {
      id: "again",
      title: "Cancel it again",
      method: "POST",
      path: "responses/{{start.id}}/cancel",
      independent: true,
      expect: { status: [200, 400] },
      show: ["status"],
      note: "A cancelled response answers with its current state, not an error. One that completed answered 400 \"Cannot cancel a completed response.\" when this demo was built.",
    },
    { id: "delete", title: "Clean up", method: "DELETE", path: "responses/{{start.id}}", independent: true, cleanup: true, show: ["deleted"] },
  ],
};

const CANCEL_AFTER_FLOW: FlowSpec = {
  intro: "A cancel that comes too late. The guide says you get the response back with status completed and an empty output[]; when this demo was built, Meta answered 400 \"Cannot cancel a completed response.\" Either way, read the output with GET.",
  models: SPARK_MODELS,
  steps: [
    {
      id: "start",
      title: "Start a short response in the background",
      path: "responses",
      body: { model: M, input: "Write a haiku about patience.", background: true, reasoning: { effort: "low" }, max_output_tokens: 1500 },
      show: ["id", "status"],
    },
    {
      id: "poll",
      title: "Wait until it completes",
      path: "responses/{{start.id}}",
      poll: { path: "status", until: ["completed", "failed", "cancelled", "incomplete"], everyMs: 4000, tries: 15 },
      show: ["status"],
    },
    {
      id: "cancel",
      title: "Cancel after it finished",
      method: "POST",
      path: "responses/{{start.id}}/cancel",
      independent: true,
      expect: { status: [200, 400] },
      show: ["status", "output"],
    },
    { id: "read", title: "Read the output with GET", path: "responses/{{start.id}}", independent: true, show: ["status"] },
    { id: "delete", title: "Clean up", method: "DELETE", path: "responses/{{start.id}}", independent: true, cleanup: true, show: ["deleted"] },
  ],
};

const RETRIEVE_FLOW: FlowSpec = {
  intro: "A retrieval echoes the request's parameters and the full usage breakdown.",
  steps: [
    {
      id: "create",
      title: "Create a stored response",
      path: "responses",
      body: resp({ instructions: "Answer in one sentence.", input: CAPITAL, metadata: { demo: "retrieve" } }),
      show: ["id"],
    },
    {
      id: "read",
      title: "Retrieve it by id",
      path: "responses/{{create.id}}",
      retry: { statuses: [404], tries: 3, delayMs: 2500 },
      show: ["status", "instructions", "metadata", "completed_at", "usage.output_tokens_details.reasoning_tokens", "usage.input_tokens_details.cached_tokens"],
      expect: {
        checks: [
          { path: "id", equals: "{{create.id}}", label: "It's the same response" },
          { path: "instructions", equals: "Answer in one sentence.", label: "instructions is echoed" },
          { path: "metadata.demo", equals: "retrieve", label: "metadata is echoed" },
          { path: "completed_at", present: true, label: "completed_at is set" },
          { path: "usage.output_tokens_details.reasoning_tokens", present: true, label: "usage keeps its reasoning_tokens" },
        ],
      },
    },
    { id: "delete", title: "Clean up", method: "DELETE", path: "responses/{{create.id}}", cleanup: true, show: ["deleted"] },
  ],
};

const RETRIEVE_BACKGROUND_FLOW: FlowSpec = {
  intro:
    "A background response read while it runs, then once it's done. The reference documents stream=true for in-progress background responses; when this demo was built, Meta answered it with the JSON response, so that step shows whichever comes back. Polls go every 5 s: each one counts toward the per-minute limit.",
  models: SPARK_MODELS,
  steps: [
    {
      id: "start",
      title: "Start in the background",
      path: "responses",
      // Room for the reasoning and the whole story: at 3,000 the reasoning alone used up the limit once.
      body: { model: M, input: STORY, background: true, reasoning: { effort: "low" }, max_output_tokens: 6000 },
      show: ["id", "status"],
    },
    {
      id: "now",
      title: "Retrieve it right away",
      path: "responses/{{start.id}}",
      show: ["status", "completed_at"],
      expect: { checks: [{ path: "completed_at", present: false, label: "completed_at is null until it completes" }] },
    },
    {
      id: "stream",
      title: "Retrieve with stream=true",
      path: "responses/{{start.id}}?stream=true",
      independent: true,
      show: ["status"],
      note: "The reference documents an event stream here (response.created, then the terminal event with the whole response, then [DONE], with starting_after=N to resume). When this demo was built the live API answered with the JSON response instead, so handle both.",
    },
    {
      id: "poll",
      title: "Poll until it's done",
      path: "responses/{{start.id}}",
      poll: { path: "status", until: ["completed", "failed", "cancelled", "incomplete"], everyMs: 5000, tries: 36 },
      show: ["status", "completed_at", "usage.output_tokens"],
      expect: {
        checks: [
          { path: "status", equals: "completed", label: "It completed" },
          { path: "completed_at", present: true, label: "completed_at is set once it completes" },
        ],
      },
    },
    { id: "delete", title: "Clean up", method: "DELETE", path: "responses/{{start.id}}", cleanup: true, show: ["deleted"] },
  ],
};

const DELETE_FLOW: FlowSpec = {
  intro: "DELETE soft-deletes a stored response.",
  steps: [
    { id: "create", title: "Create a stored response", path: "responses", body: resp({ input: CAPITAL }), show: ["id"] },
    {
      id: "delete",
      title: "Delete it",
      method: "DELETE",
      path: "responses/{{create.id}}",
      show: ["id", "object", "deleted"],
      retry: { statuses: [404], tries: 3, delayMs: 2500 },
      expect: {
        checks: [
          { path: "object", equals: "response.deleted", label: 'object is "response.deleted"' },
          { path: "deleted", equals: true, label: "deleted: true" },
          { path: "id", equals: "{{create.id}}", label: "It names the deleted response" },
        ],
      },
    },
    {
      id: "read",
      title: "It can't be retrieved",
      path: "responses/{{create.id}}",
      independent: true,
      expect: { status: 404 },
    },
    {
      id: "again",
      title: "A second DELETE is a 404",
      method: "DELETE",
      path: "responses/{{create.id}}",
      independent: true,
      expect: { status: 404 },
      note: "Not idempotent. The live docs answer these two 404s themselves, since the response is gone from this browser's list; Meta's API answers 404 too.",
    },
  ],
};

const COUNT_THEN_SEND: FlowSpec = {
  intro: "Measure a request before you send it. The count is the fully rendered input: instructions, tools and the server's own scaffolding included.",
  vars: [{ name: "q", label: "Question", value: WEATHER }],
  steps: [
    {
      id: "count",
      title: "Count the input tokens",
      path: "responses/input_tokens",
      body: { model: M, instructions: "Answer in one sentence.", input: "{{vars.q}}", tools: [R_TOOL] },
      show: ["object", "input_tokens"],
    },
    {
      id: "send",
      title: "Send the same request",
      path: "responses",
      body: resp({ instructions: "Answer in one sentence.", input: "{{vars.q}}", tools: [R_TOOL] }),
      show: ["usage.input_tokens", "usage.input_tokens_details.cached_tokens"],
      note: "A context-size measurement, not a bill: usage.input_tokens on the real call can read lower than the count.",
    },
  ],
};

const COUNT_WITH_HISTORY: FlowSpec = {
  intro: "With previous_response_id, the count includes the stored conversation it points at.",
  steps: [
    { id: "turn1", title: "A stored first turn", path: "responses", body: resp({ input: CAPITAL }), show: ["id", "usage.input_tokens"] },
    {
      id: "bare",
      title: "Count the follow-up alone",
      path: "responses/input_tokens",
      body: { model: M, input: "And its population?" },
      show: ["input_tokens"],
    },
    {
      id: "chained",
      title: "Count it on top of turn 1",
      path: "responses/input_tokens",
      body: { model: M, previous_response_id: "{{turn1.id}}", input: "And its population?" },
      retry: { statuses: [400, 404], tries: 3, delayMs: 2500 },
      show: ["input_tokens"],
      note: "Higher than the follow-up alone: the resolved history counts.",
    },
    { id: "delete", title: "Clean up", method: "DELETE", path: "responses/{{turn1.id}}", cleanup: true, show: ["deleted"] },
  ],
};

// ---------- Console presets ----------

const RESPONSES_CREATE_PRESETS: ConsolePreset[] = [
  { label: "Plain text", note: "The page's own request.", console: post("responses", { model: SPARK, input: CAPITAL }) },
  {
    label: "Instructions",
    console: post("responses", { model: SPARK, instructions: "You are a concise geography tutor. Answer in one sentence.", input: "Which river runs through Paris?", reasoning: { effort: "low" }, max_output_tokens: 1500 }),
  },
  {
    label: "Input array",
    note: "Typed items: a developer message, a user turn, a replayed assistant turn as output_text, then the question.",
    console: post("responses", {
      model: SPARK,
      input: [
        { role: "developer", content: [{ type: "input_text", text: "You are a helpful geography assistant." }] },
        { role: "user", content: [{ type: "input_text", text: CAPITAL }] },
        { role: "assistant", content: [{ type: "output_text", text: "The capital of France is Paris." }] },
        { role: "user", content: [{ type: "input_text", text: "What is its population?" }] },
      ],
      reasoning: { effort: "low" },
      max_output_tokens: 1500,
    }),
  },
  { label: "Stream", console: post("responses", { model: SPARK, input: "Explain how neural networks learn.", reasoning: { effort: "low" }, max_output_tokens: 1500, stream: true }) },
  {
    label: "Reasoning summary",
    note: "reasoning.summary asks for a summary of the reasoning; the raw chain of thought never comes back as text.",
    console: post("responses", { model: SPARK, input: BAT_AND_BALL, reasoning: { effort: "medium", summary: "auto" }, max_output_tokens: 3000 }),
  },
  { label: "Function tool", note: "The reply's output holds a function_call to run.", console: post("responses", { model: SPARK, input: WEATHER, tools: [R_TOOL], reasoning: { effort: "low" }, max_output_tokens: 1500 }) },
  {
    label: "Web search",
    note: "$0.0025 a query; the live docs set max_tool_calls to 5.",
    console: post("responses", { model: SPARK, input: "Who won the most recent Formula 1 race?", tools: [{ type: "web_search" }], reasoning: { effort: "low" }, max_output_tokens: 3000, stream: true }),
  },
  {
    label: "Structured output",
    note: "text.format, not response_format, on Responses.",
    console: post("responses", { model: SPARK, input: PLACE_PROMPT, text: { format: { type: "json_schema", name: "place", strict: true, schema: PLACE_SCHEMA } }, reasoning: { effort: "low" }, max_output_tokens: 1500 }),
  },
  {
    label: "Stateless",
    note: "store: false with encrypted reasoning, for replaying the output items in your next input.",
    console: post("responses", { model: SPARK, input: CAPITAL, store: false, include: ["reasoning.encrypted_content"], reasoning: { effort: "low" }, max_output_tokens: 1500 }),
  },
  {
    label: "Background",
    note: "Answers at once with status queued; its id then shows up in the retrieve and cancel consoles. Background runs need Muse Spark in the live docs: they hold their worst case until they finish, which on Muse Wonder is more than a reader's daily budget.",
    console: post("responses", { model: SPARK, input: "Write a haiku about patience.", background: true, reasoning: { effort: "low" }, max_output_tokens: 1500 }),
  },
  {
    label: "Image (pick one)",
    note: "Pick a sample or your own image; it goes in as a data URL.",
    console: post(
      "responses",
      {
        model: SPARK,
        input: [{ role: "user", content: [{ type: "input_text", text: "What's in this image? One sentence." }, { type: "input_image", image_url: "<BASE64>" }] }],
        reasoning: { effort: "low" },
        max_output_tokens: 1500,
      },
      { fileSlots: [{ pointer: "/input/0/content/1/image_url", label: "Image", accept: "image/*", as: "dataUrl" }] },
    ),
  },
  {
    label: "PDF (pick one)",
    console: post(
      "responses",
      {
        model: SPARK,
        input: [
          { role: "user", content: [{ type: "input_text", text: "Summarize this document in two sentences." }, { type: "input_file", filename: "document.pdf", file_data: "<BASE64>" }] },
        ],
        reasoning: { effort: "low" },
        max_output_tokens: 1500,
      },
      { fileSlots: [{ pointer: "/input/0/content/1/file_data", label: "PDF", accept: "application/pdf", as: "dataUrl" }] },
    ),
  },
];

const RESPONSES_ENDPOINT_PRESETS: ConsolePreset[] = [
  { label: "Create", console: post("responses", { model: SPARK, input: CAPITAL }) },
  { label: "Retrieve", note: "Create a response first (here or in the other tabs); its id shows up to use.", console: { method: "GET", path: "responses/{response_id}" } },
  { label: "Delete", console: { method: "DELETE", path: "responses/{response_id}" } },
  { label: "Cancel", note: "Only background responses can be cancelled.", console: { method: "POST", path: "responses/{response_id}/cancel" } },
  { label: "Count input tokens", console: post("responses/input_tokens", { model: SPARK, input: CAPITAL }) },
];

const COUNT_PRESETS: ConsolePreset[] = [
  { label: "The page's request", console: post("responses/input_tokens", { model: SPARK, input: CAPITAL }) },
  { label: "With instructions and a tool", console: post("responses/input_tokens", { model: SPARK, instructions: "Answer in one sentence.", input: WEATHER, tools: [R_TOOL] }) },
  {
    label: "With an image (pick one)",
    console: post(
      "responses/input_tokens",
      { model: SPARK, input: [{ role: "user", content: [{ type: "input_text", text: "Describe this image." }, { type: "input_image", image_url: "<BASE64>" }] }] },
      { fileSlots: [{ pointer: "/input/0/content/1/image_url", label: "Image", accept: "image/*", as: "dataUrl" }] },
    ),
  },
];

const CHAT_PRESETS: ConsolePreset[] = [
  { label: "Plain", note: "The page's own request.", console: post("chat/completions", { model: SPARK, messages: [{ role: "user", content: TCP }] }) },
  {
    label: "Developer message",
    console: post("chat/completions", { model: SPARK, messages: [{ role: "developer", content: REVIEWER }, { role: "user", content: "def div(a, b):\n    return a / b" }] }),
  },
  {
    label: "Stream",
    note: "stream_options.include_usage puts usage on the last chunk.",
    console: post("chat/completions", { model: SPARK, messages: [{ role: "user", content: "Explain how garbage collection works in Python." }], stream: true, stream_options: { include_usage: true } }),
  },
  {
    label: "Multi-turn",
    note: "You own the history: the whole array goes back each turn.",
    console: post("chat/completions", {
      model: SPARK,
      messages: [
        { role: "developer", content: "You are a concise coding tutor." },
        { role: "user", content: "What is a Python decorator?" },
        { role: "assistant", content: "A decorator is a function that wraps another function to add behavior, applied with @name above a def." },
        { role: "user", content: "Show me an example that logs function execution time." },
      ],
    }),
  },
  { label: "Reasoning effort", console: post("chat/completions", { model: SPARK, messages: [{ role: "user", content: BAT_AND_BALL }], reasoning_effort: "medium", max_completion_tokens: 3000 }) },
  {
    label: "Structured output",
    note: "response_format here; text.format belongs to Responses and is a 400 on this endpoint.",
    console: post("chat/completions", { model: SPARK, messages: [{ role: "user", content: PLACE_PROMPT }], response_format: { type: "json_schema", json_schema: { name: "place", strict: true, schema: PLACE_SCHEMA } } }),
  },
  {
    label: "JSON mode",
    console: post("chat/completions", {
      model: SPARK,
      messages: [
        { role: "developer", content: "Reply with a JSON object with the keys city and country." },
        { role: "user", content: "I flew home from Lisbon, Portugal last week." },
      ],
      response_format: { type: "json_object" },
    }),
  },
  { label: "Tool call", console: post("chat/completions", { model: SPARK, messages: [{ role: "user", content: WEATHER }], tools: [C_TOOL] }) },
  {
    label: "Tool result",
    note: "The assistant message with its tool_calls, then one tool message per call id.",
    console: post("chat/completions", {
      model: SPARK,
      messages: [
        { role: "user", content: WEATHER },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: WEATHER_RESULT },
      ],
      tools: [C_TOOL],
    }),
  },
  {
    label: "Image (pick one)",
    console: post(
      "chat/completions",
      { model: SPARK, messages: [{ role: "user", content: [{ type: "text", text: "What's in this image? One sentence." }, { type: "image_url", image_url: { url: "<BASE64>" } }] }] },
      { fileSlots: [{ pointer: "/messages/0/content/1/image_url/url", label: "Image", accept: "image/*", as: "dataUrl" }] },
    ),
  },
];

const MESSAGES_PRESETS: ConsolePreset[] = [
  { label: "Plain", note: "The page's own request.", console: post("messages", { model: SPARK, max_tokens: 1024, messages: [{ role: "user", content: CAPITAL }] }) },
  { label: "System", console: post("messages", { model: SPARK, max_tokens: 1024, system: "You are a concise geography tutor. Answer in one sentence.", messages: [{ role: "user", content: "Which river runs through Paris?" }] }) },
  {
    label: "Thinking",
    note: "thinking adaptive plus output_config.effort. The page says this returns a thinking summary; when this demo was built the reasoning came back as a redacted_thinking block only.",
    console: post("messages", { model: SPARK, max_tokens: 3000, messages: [{ role: "user", content: BAT_AND_BALL }], thinking: { type: "adaptive" }, output_config: { effort: "medium" } }),
  },
  { label: "Stream", console: post("messages", { model: SPARK, max_tokens: 1024, messages: [{ role: "user", content: CAPITAL }], stream: true }) },
  { label: "Tool", console: post("messages", { model: SPARK, max_tokens: 1024, messages: [{ role: "user", content: WEATHER }], tools: [A_TOOL] }) },
  {
    label: "Tool result",
    note: "The assistant's tool_use replayed, then a tool_result in the next user turn.",
    console: post("messages", {
      model: SPARK,
      max_tokens: 1024,
      messages: [
        { role: "user", content: WEATHER },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: WEATHER_RESULT }] },
      ],
      tools: [A_TOOL],
    }),
  },
  {
    label: "Web search",
    note: "$0.0025 a query. user_location works; allowed_domains, blocked_domains and max_uses are 400s.",
    console: post("messages", { model: SPARK, max_tokens: 3000, messages: [{ role: "user", content: "Who won the most recent Formula 1 race? One sentence." }], tools: [{ type: "web_search" }] }),
  },
  {
    label: "Structured output",
    console: post("messages", { model: SPARK, max_tokens: 1024, messages: [{ role: "user", content: PLACE_PROMPT }], output_config: { format: { type: "json_schema", schema: PLACE_SCHEMA } } }),
  },
  {
    label: "Document",
    console: post("messages", {
      model: SPARK,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "How much did rides grow, per this note? One sentence." },
            { type: "document", source: { type: "text", media_type: "text/plain", data: "Northwind Bikes, Q3 2026: rides grew 18% over Q2 to 12,480. The new Harbor station opened on July 14." }, title: "Q3 note" },
          ],
        },
      ],
    }),
  },
  { label: "Count tokens", console: post("messages/count_tokens", { model: SPARK, messages: [{ role: "user", content: CAPITAL }] }) },
];

const MESSAGES_COUNT_PRESETS: ConsolePreset[] = [
  { label: "The page's request", console: post("messages/count_tokens", { model: SPARK, messages: [{ role: "user", content: CAPITAL }] }) },
  { label: "With system and a tool", console: post("messages/count_tokens", { model: SPARK, system: "You are a weather assistant.", messages: [{ role: "user", content: WEATHER }], tools: [A_TOOL] }) },
  {
    label: "A longer conversation",
    console: post("messages/count_tokens", {
      model: SPARK,
      messages: [
        { role: "user", content: CAPITAL },
        { role: "assistant", content: "The capital of France is Paris." },
        { role: "user", content: "What is its population?" },
      ],
    }),
  },
];

// ---------- Snippets ----------

const PY_CLIENT = `import os

from openai import OpenAI

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])
MODEL = "muse-spark-1.3-contributor"`;

const TS_CLIENT = `import OpenAI from 'openai';

const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) throw new Error('MODEL_API_KEY is not set');
const client = new OpenAI({ baseURL: 'https://api.meta.ai/v1', apiKey });
const model = 'muse-spark-1.3-contributor';`;

const PY_ANTHROPIC = `import os

from anthropic import Anthropic

client = Anthropic(base_url="https://api.meta.ai", auth_token=os.environ["MODEL_API_KEY"])
MODEL = "muse-spark-1.3-contributor"`;

const TS_MESSAGES_HELPER = `const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) throw new Error('MODEL_API_KEY is not set');
const model = 'muse-spark-1.3-contributor';

async function messages(path: string, body: unknown) {
  const res = await fetch(\`https://api.meta.ai/v1/\${path}\`, {
    method: 'POST',
    headers: { Authorization: \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(\`\${res.status}: \${json.error?.message}\`);
  return json;
}`;

const curl = (path: string, body: string, extra = "") =>
  `curl ${extra}-X POST "https://api.meta.ai/v1/${path}" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${body}'`;

/** A create that keeps the new response's id in $RESPONSE_ID (with jq), so the commands after it run as they are. */
const curlCreate = (body: string) =>
  `# Needs jq to read the id.
RESPONSE_ID=$(curl -s -X POST "https://api.meta.ai/v1/responses" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${body}' | jq -r .id)`;

/** One more call on $RESPONSE_ID: GET or DELETE /v1/responses/{id}, or POST its cancel. */
const curlOnId = (method: "GET" | "DELETE" | "POST", suffix = "") =>
  `curl -X ${method} "https://api.meta.ai/v1/responses/$RESPONSE_ID${suffix}" -H "Authorization: Bearer $MODEL_API_KEY"`;

// ---------- Pages ----------

const tabs = (list: LabTab[]) => ({ tabs: list });

/** Checks a page's props against its component's own props (DemoMap's typing is loose), then hands back the spec. */
function demo<P extends { slug: string }>(spec: {
  title: string;
  blurb: string;
  Component: ComponentType<P>;
  props: Omit<P, "slug">;
  agentPrompt: AgentPromptSpec;
}): DemoSpec {
  return spec as unknown as DemoSpec;
}

export const protocolsDemos: DemoMap = {
  protocols: demo({
    title: "One prompt, three request formats",
    blurb:
      "Send runs the same question through Responses, Chat Completions and Messages at once and lines up each request, reply shape, usage and cost; a follow-up shows how each format carries the conversation. Well under a cent.",
    Component: ProtocolCompare,
    props: {
      prompt: CAPITAL,
      presets: [
        { label: "Capital of France", prompt: CAPITAL },
        { label: "TCP vs UDP", prompt: `${TCP} Keep it short.` },
        { label: "With instructions", prompt: "Which river runs through Paris?", system: "You are a concise geography tutor. Answer in one sentence." },
      ],
      followUps: ["What is its population?", "How does that compare to London?"],
      effort: "low",
      maxOutputTokens: 1500,
    },
    agentPrompt: {
      task: "Pick the Model API request format that fits my project and wire it in: Chat Completions if the code already calls OpenAI chat.completions, Messages if it uses the Anthropic SDK or Claude-style tools, otherwise the Responses API. Make one call through it, read the reply text and token usage from that format's own fields, and tell me which format you chose and why.",
      facts: [
        "All three run the same models with the same bearer auth and cost the same per token.",
        "Responses: POST /v1/responses with model and input. The full feature set: reasoning across turns (previous_response_id or encrypted replay), search grounding, tool search, background runs, file inputs.",
        "Chat Completions: POST /v1/chat/completions with model and messages. No reasoning across turns, no search grounding or tool search; function tools work.",
        "Messages: POST /v1/messages, Anthropic format. The Anthropic SDK's base URL is https://api.meta.ai (no /v1); max_tokens is required; stateless, so resend history.",
        "Text: output[].content[].text (output_text in the SDK), choices[0].message.content, content[] text blocks. Usage: input_tokens/output_tokens, but prompt_tokens/completion_tokens on Chat.",
      ],
      checklist: [
        "The chosen format matches the client code already in the project, and the reason is stated.",
        "One real call prints the reply text and the token usage under that format's field names.",
      ],
      snippets: {
        python: `${PY_CLIENT}
question = "What is the capital of France?"

r = client.responses.create(model=MODEL, input=question)
print("responses:", r.output_text, r.usage.input_tokens, r.usage.output_tokens)

c = client.chat.completions.create(model=MODEL, messages=[{"role": "user", "content": question}])
print("chat:", c.choices[0].message.content, c.usage.prompt_tokens, c.usage.completion_tokens)

# Messages: the Anthropic SDK, base URL without /v1, max_tokens required.
from anthropic import Anthropic

anthropic = Anthropic(base_url="https://api.meta.ai", auth_token=os.environ["MODEL_API_KEY"])
m = anthropic.messages.create(model=MODEL, max_tokens=1024, messages=[{"role": "user", "content": question}])
print("messages:", "".join(b.text for b in m.content if b.type == "text"), m.usage.input_tokens, m.usage.output_tokens)`,
        typescript: `${TS_CLIENT}
const question = 'What is the capital of France?';

const r = await client.responses.create({ model, input: question });
console.log('responses:', r.output_text, r.usage?.input_tokens, r.usage?.output_tokens);

const c = await client.chat.completions.create({ model, messages: [{ role: 'user', content: question }] });
console.log('chat:', c.choices[0].message.content, c.usage?.prompt_tokens, c.usage?.completion_tokens);

// Messages speaks the Anthropic wire format; max_tokens is required.
const res = await fetch('https://api.meta.ai/v1/messages', {
  method: 'POST',
  headers: { Authorization: \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: question }] }),
});
const m = await res.json();
console.log('messages:', m.content.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join(''));`,
        curl: `${curl("responses", '{"model": "muse-spark-1.3-contributor", "input": "What is the capital of France?"}')}

${curl("chat/completions", '{"model": "muse-spark-1.3-contributor", "messages": [{"role": "user", "content": "What is the capital of France?"}]}')}

${curl("messages", '{"model": "muse-spark-1.3-contributor", "max_tokens": 1024, "messages": [{"role": "user", "content": "What is the capital of France?"}]}')}`,
      },
    },
  }),

  "protocols/responses": demo({
    title: "Carry a conversation, and its reasoning, through the Responses API",
    blurb:
      "Each tab runs one pattern from this page on the live API: chaining with previous_response_id, stateless encrypted replay, a tool loop, background runs with cancel and delete, the stream's events, files and search, and the errors the page documents. Each run is well under a cent; search adds $0.0025 a query.",
    Component: ProtocolLab,
    props: tabs([
      flow("multi", "Multi-turn", RESPONSES_MULTI_TURN),
      flow("stateless", "Stateless", RESPONSES_STATELESS),
      {
        id: "tools",
        label: "Tool loop",
        kind: "tools",
        intro: "The model calls get_weather; the result goes back as function_call_output with previous_response_id. Tools aren't carried over, so each request sends them again.",
        props: {
          protocol: "responses",
          prompt: WEATHER,
          tools: ["get_weather", "get_time"],
          presets: [
            { label: "One city", prompt: WEATHER },
            { label: "Two cities at once", prompt: "Compare the weather in Paris and Tokyo right now." },
            { label: "Weather and time", prompt: "What time is it in Tokyo, and what's the weather there?" },
          ],
        },
      },
      flow("background", "Background", RESPONSES_BACKGROUND),
      flow("stream", "Streaming", RESPONSES_STREAMING),
      flow("files", "Files and search", RESPONSES_FILES_SEARCH),
      flow("gotchas", "Errors", RESPONSES_GOTCHAS),
    ]),
    agentPrompt: {
      task: "Use the Responses API for multi-turn conversations in my app: continue each turn with previous_response_id (only the new input), and add a stateless mode (store: false, include [\"reasoning.encrypted_content\"]) that replays the previous output items, reasoning included, in the next input. Stream replies and print each turn's text and usage.",
      facts: [
        "POST /v1/responses with model and input (a string or items); store defaults to true. previous_response_id carries the conversation only: resend instructions, tools and reasoning.effort.",
        "Stateless: store: false plus include [\"reasoning.encrypted_content\"]; replay each reasoning item whole (encrypted_content, summary [] when empty). A bare rs_ id is a 400, and so is encrypted replay with previous_response_id.",
        "Each replayed reasoning item must be followed by an assistant message or a function_call before the next user, system or developer message; after a reasoning-only turn, add a minimal assistant message.",
        "Assistant text before a function_call keeps phase \"commentary\"; each function_call_output.call_id (1 to 64 characters) matches a function_call.",
        "Streams: text arrives as response.output_text.delta; response.completed ends it (else response.incomplete or response.failed).",
      ],
      checklist: [
        "Turn 2 sent with previous_response_id answers about turn 1 (\"that city\" resolves to Paris).",
        "The stateless mode works with store: false and the encrypted reasoning items replayed, with an assistant message after a reasoning-only turn.",
        "A streamed turn prints text as it arrives and ends on response.completed.",
      ],
      snippets: {
        python: `${PY_CLIENT}

first = client.responses.create(model=MODEL, input="What is the capital of France?")
print(first.output_text)

# Server-managed history, streamed: send only the new input.
with client.responses.stream(model=MODEL, input="What is the population of that city?", previous_response_id=first.id) as stream:
    for event in stream:
        if event.type == "response.output_text.delta":
            print(event.delta, end="", flush=True)
    second = stream.get_final_response()
print("\\n", second.usage.input_tokens)

# Stateless: nothing stored; replay the output items, reasoning included.
q = "What is the capital of France?"
turn1 = client.responses.create(model=MODEL, input=q, store=False, include=["reasoning.encrypted_content"])
history = [{"role": "user", "content": q}] + [item.model_dump(exclude_none=True) for item in turn1.output]
if not any(item.type == "message" for item in turn1.output):
    history.append({"role": "assistant", "content": "(no answer)"})  # reasoning-only turn
history.append({"role": "user", "content": "What is its population?"})
turn2 = client.responses.create(model=MODEL, input=history, store=False, include=["reasoning.encrypted_content"])
print(turn2.output_text)`,
        typescript: `${TS_CLIENT}

const first = await client.responses.create({ model, input: 'What is the capital of France?' });
console.log(first.output_text);

const stream = client.responses.stream({
  model,
  input: 'What is the population of that city?',
  previous_response_id: first.id,
});
for await (const event of stream) {
  if (event.type === 'response.output_text.delta') process.stdout.write(event.delta);
}
const second = await stream.finalResponse();
console.log('\\n', second.usage?.input_tokens);`,
        curl: `${curlCreate('{"model": "muse-spark-1.3-contributor", "input": "What is the capital of France?"}')}

# The next turn sends only the new input, chained to that id, and streams.
${curl("responses", '{"model": "muse-spark-1.3-contributor", "input": "What is the population of that city?", "stream": true, "previous_response_id": "\'"$RESPONSE_ID"\'"}', "-N ")}`,
      },
    },
  }),

  "protocols/chat-completions": demo({
    title: "Chat Completions: send the messages, get the next turn",
    blurb:
      "Chat streams a reply with the developer message and history this page covers; Tool calls runs the tool_calls round trip; JSON output checks a response_format schema; Checks sends the parameters the page says return HTTP 400. Well under a cent a run.",
    Component: ProtocolLab,
    props: tabs([
      {
        id: "chat",
        label: "Chat",
        kind: "chat",
        intro: "Follow-ups resend the whole messages array: the API keeps no state between requests.",
        props: {
          protocol: "chat",
          prompt: TCP,
          maxOutputTokens: 2000,
          presets: [
            { label: "TCP vs UDP", prompt: TCP },
            { label: "Code review (developer)", prompt: "def div(a, b):\n    return a / b", system: REVIEWER },
            { label: "Garbage collection", prompt: "Explain how garbage collection works in Python." },
            { label: "Coding tutor", prompt: "What is a Python decorator?", system: "You are a concise coding tutor." },
          ],
        },
      },
      {
        id: "tools",
        label: "Tool calls",
        kind: "tools",
        intro: "The assistant message with its tool_calls goes back first, then one tool message per tool_call_id.",
        props: {
          protocol: "chat",
          prompt: WEATHER,
          tools: ["get_weather", "get_time"],
          presets: [
            { label: "One city", prompt: WEATHER },
            { label: "Two cities at once", prompt: "Compare the weather in Paris and Tokyo right now." },
          ],
        },
      },
      {
        id: "json",
        label: "JSON output",
        kind: "structured",
        intro: "Structured output on this endpoint is response_format with a json_schema.",
        props: {
          protocol: "chat",
          presets: [
            { label: "Extract a place", name: "place", schema: PLACE_SCHEMA, prompt: PLACE_PROMPT },
            {
              label: "TCP vs UDP table",
              name: "comparison",
              schema: {
                type: "object",
                properties: {
                  differences: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { aspect: { type: "string" }, tcp: { type: "string" }, udp: { type: "string" } },
                      required: ["aspect", "tcp", "udp"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["differences"],
                additionalProperties: false,
              },
              prompt: "List three differences between TCP and UDP.",
            },
          ],
        },
      },
      flow("checks", "Checks", CHAT_CHECKS),
    ]),
    agentPrompt: {
      task: "Add a chat feature to my app with Chat Completions: keep a messages array that starts with a developer message, append each user message and assistant reply, resend the whole array every turn, and stream the reply to the user. Trim the oldest user and assistant pairs past a token budget while always keeping the developer message.",
      facts: [
        "POST https://api.meta.ai/v1/chat/completions with model and messages. Roles: developer (highest precedence), system (same level), user, assistant, tool.",
        "The text is at choices[0].message.content; stream chunks carry choices[0].delta.content. Add stream_options {\"include_usage\": true} to get usage on the last chunk.",
        "Use max_completion_tokens (max_tokens still works). max_output_tokens and text.format are Responses fields and return 400 here; structured output is response_format.",
        "HTTP 400: n > 1, top_p 0, logprobs, stop, verbosity, logit_bias, prediction, web_search_options, modalities, audio, reasoning_effort \"none\".",
        "Reasoning isn't carried across turns. A tool result needs the assistant message with its tool_calls first, then one tool message per tool_call_id.",
        "Leave temperature and top_p at their defaults of 1.0.",
      ],
      checklist: [
        "A second question that refers to the first (\"show me an example\") gets an answer that uses the first turn.",
        "Streaming prints the reply as it arrives and reports usage at the end.",
        "A 400 (try n: 2) surfaces the API's message.",
      ],
      snippets: {
        python: `${PY_CLIENT}

messages = [{"role": "developer", "content": "You are a concise coding tutor."}]
for question in ["What is a Python decorator?", "Show me an example that logs function execution time."]:
    messages.append({"role": "user", "content": question})
    stream = client.chat.completions.create(
        model=MODEL, messages=messages, stream=True, stream_options={"include_usage": True}
    )
    reply = ""
    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta.content:
            reply += chunk.choices[0].delta.content
            print(chunk.choices[0].delta.content, end="", flush=True)
        if chunk.usage:
            print(f"\\n[{chunk.usage.prompt_tokens} in, {chunk.usage.completion_tokens} out]")
    messages.append({"role": "assistant", "content": reply})`,
        typescript: `${TS_CLIENT}

const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'developer', content: 'You are a concise coding tutor.' }];
for (const question of ['What is a Python decorator?', 'Show me an example that logs function execution time.']) {
  messages.push({ role: 'user', content: question });
  const stream = await client.chat.completions.create({ model, messages, stream: true, stream_options: { include_usage: true } });
  let reply = '';
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      reply += delta;
      process.stdout.write(delta);
    }
    if (chunk.usage) console.log(\`\\n[\${chunk.usage.prompt_tokens} in, \${chunk.usage.completion_tokens} out]\`);
  }
  messages.push({ role: 'assistant', content: reply });
}`,
        curl: curl(
          "chat/completions",
          '{"model": "muse-spark-1.3-contributor", "messages": [{"role": "developer", "content": "You are a concise coding tutor."}, {"role": "user", "content": "What is a Python decorator?"}], "stream": true, "stream_options": {"include_usage": true}}',
          "-N ",
        ),
      },
    },
  }),

  "protocols/messages": demo({
    title: "Anthropic-format requests on Muse Spark",
    blurb:
      "Chat sends system, max_tokens and thinking in the Anthropic shape; Thinking shows redacted_thinking and its replay; Tool use runs tool_use and tool_result; Count tokens measures a request; Checks sends the fields the page says return HTTP 400. Well under a cent a run.",
    Component: ProtocolLab,
    props: tabs([
      {
        id: "chat",
        label: "Chat",
        kind: "chat",
        intro: "Reasoning sends thinking {type: \"adaptive\"} with output_config.effort. Follow-ups resend the history: Messages is stateless.",
        props: {
          protocol: "messages",
          system: "You are a concise geography tutor.",
          prompt: CAPITAL,
          maxOutputTokens: 2000,
          presets: [
            { label: "Capital of France", prompt: CAPITAL },
            { label: "Bat and ball", prompt: BAT_AND_BALL, system: "" },
          ],
        },
      },
      flow("thinking", "Thinking", MESSAGES_THINKING),
      flow("tools", "Tool use", MESSAGES_TOOL_USE),
      flow("count", "Count tokens", MESSAGES_COUNT_THEN_SEND),
      flow("checks", "Checks", MESSAGES_CHECKS),
    ]),
    agentPrompt: {
      task: "Point my Anthropic SDK code at Meta Model API through the Messages API: base URL https://api.meta.ai with MODEL_API_KEY as a bearer token, model, max_tokens and messages as before, reasoning set with thinking {type: \"adaptive\"} and output_config.effort, and the full assistant content (thinking blocks included) replayed each turn. Handle tool_use by sending tool_result in the next user turn.",
      facts: [
        "POST /v1/messages. The Anthropic SDK takes base_url \"https://api.meta.ai\" (no /v1) and auth_token (bearer). max_tokens is required.",
        "Stateless: resend the history. The page says thinking adaptive returns a thinking summary; when this was built Meta sent redacted_thinking only. Handle thinking and redacted_thinking blocks and replay both unchanged.",
        "thinking disabled is a 400 (Muse Spark always reasons); budget_tokens needs at least 1024 and under max_tokens, and doesn't set the effort.",
        "HTTP 400: stop_sequences, top_k, container, inference_geo, unknown fields, a named tool_choice, web_search allowed_domains, blocked_domains or max_uses. temperature runs 0 to 1.",
        "Errors use Anthropic's envelope {\"type\": \"error\", \"error\": {\"type\", \"message\"}}. Usage: input_tokens, output_tokens, cache_read_input_tokens, output_tokens_details.thinking_tokens.",
      ],
      checklist: [
        "A follow-up turn replays the assistant content blocks and gets an answer that uses the first turn.",
        "A tool_use reply (stop_reason tool_use) is answered with tool_result and ends with end_turn.",
      ],
      snippets: {
        python: `${PY_ANTHROPIC}

messages = [{"role": "user", "content": "What is the capital of France?"}]
first = client.messages.create(
    model=MODEL, max_tokens=1024, messages=messages,
    thinking={"type": "adaptive"}, extra_body={"output_config": {"effort": "low"}},
)
print("".join(b.text for b in first.content if b.type == "text"))

# Stateless: replay the whole assistant content, thinking and redacted_thinking blocks included.
messages += [{"role": "assistant", "content": first.content}, {"role": "user", "content": "And its population?"}]
second = client.messages.create(model=MODEL, max_tokens=1024, messages=messages)
print("".join(b.text for b in second.content if b.type == "text"), second.usage.input_tokens)`,
        typescript: `${TS_MESSAGES_HELPER}

const history: Array<{ role: string; content: unknown }> = [{ role: 'user', content: 'What is the capital of France?' }];
const first = await messages('messages', { model, max_tokens: 1024, messages: history, thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
history.push({ role: 'assistant', content: first.content }, { role: 'user', content: 'And its population?' });
const second = await messages('messages', { model, max_tokens: 1024, messages: history });
console.log(second.content.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join(''));`,
        curl: curl(
          "messages",
          '{"model": "muse-spark-1.3-contributor", "max_tokens": 1024, "messages": [{"role": "user", "content": "What is the capital of France?"}], "thinking": {"type": "adaptive"}, "output_config": {"effort": "low"}}',
        ),
      },
    },
  }),

  "api-reference/responses": demo({
    title: "Create, read, cancel and delete responses",
    blurb:
      "Lifecycle runs every endpoint in this section on one response: create, count the next turn's tokens, retrieve, delete; Cancel starts a background response and cancels it; Endpoints has a console per endpoint. Well under a cent.",
    Component: ProtocolLab,
    props: tabs([
      flow("lifecycle", "Lifecycle", LIFECYCLE),
      flow("cancel", "Cancel", CANCEL_FLOW),
      consoleTab("endpoints", "Endpoints", RESPONSES_ENDPOINT_PRESETS, "Each endpoint with a working request. The ids of responses you create show up in the retrieve, delete and cancel consoles."),
    ]),
    agentPrompt: {
      task: "Wrap the Responses endpoints in a small client module for my app: create (POST /v1/responses), retrieve (GET /v1/responses/{response_id}), delete (DELETE /v1/responses/{response_id}), cancel (POST /v1/responses/{response_id}/cancel) and count input tokens (POST /v1/responses/input_tokens), each returning the parsed JSON and raising the API's error message on a 4xx or 5xx.",
      facts: [
        "Base URL https://api.meta.ai/v1. Responses are stored by default (store: true), so they can be retrieved and chained with previous_response_id.",
        "Retrieve echoes the request's parameters, usage and completed_at (null until the status is completed).",
        "Cancel works on background responses only and returns an always-empty output; cancelling one again returns its current state; a deleted one is a 404.",
        "DELETE soft-deletes and returns {\"object\": \"response.deleted\", \"deleted\": true}; a repeat DELETE is a 404, not a 200.",
        "input_tokens returns {\"object\": \"response.input_tokens\", \"input_tokens\": n} for the fully rendered input, resolved previous_response_id history included. Nothing is generated or stored.",
      ],
      checklist: ["One script creates a response, counts a follow-up, retrieves it, deletes it, and shows the 404 on a second delete."],
      snippets: {
        python: `${PY_CLIENT}

import openai
import requests

created = client.responses.create(model=MODEL, input="What is the capital of France?")
count = requests.post(
    "https://api.meta.ai/v1/responses/input_tokens",
    headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"},
    json={"model": MODEL, "previous_response_id": created.id, "input": "And its population?"},
)
count.raise_for_status()
print("follow-up input tokens:", count.json()["input_tokens"])
fetched = client.responses.retrieve(created.id)
print(fetched.status, fetched.completed_at, fetched.usage.output_tokens)
client.responses.delete(created.id)  # returns nothing on success
try:
    client.responses.delete(created.id)
except openai.NotFoundError:
    print("second delete: 404, already gone")

background = client.responses.create(model=MODEL, input="Write a 600-word story.", background=True)
print(client.responses.cancel(background.id).status)`,
        typescript: `${TS_CLIENT}

const created = await client.responses.create({ model, input: 'What is the capital of France?' });
const count = await client.responses.inputTokens.count({ model, previous_response_id: created.id, input: 'And its population?' });
console.log('follow-up input tokens:', count.input_tokens);
const fetched = await client.responses.retrieve(created.id);
console.log(fetched.status, fetched.usage?.output_tokens);
await client.responses.delete(created.id);
await client.responses.delete(created.id).catch((err) => {
  if (!(err instanceof OpenAI.NotFoundError)) throw err;
  console.log('second delete: 404, already gone');
});

const background = await client.responses.create({ model, input: 'Write a 600-word story.', background: true });
console.log((await client.responses.cancel(background.id)).status);`,
        curl: `${curlCreate('{"model": "muse-spark-1.3-contributor", "input": "What is the capital of France?"}')}

${curlOnId("GET")}
${curlOnId("DELETE")}
# A second delete answers 404:
${curlOnId("DELETE")}`,
      },
    },
  }),

  "api-reference/responses/create-response": demo({
    title: "POST /v1/responses, with working bodies",
    blurb:
      "Pick a body and Send: plain text, instructions, an input array, a stream, a reasoning summary, a function tool, web search, structured output, stateless, background, or your own image or PDF. Under a cent each; web search adds $0.0025 a query.",
    Component: ConsolePresets,
    props: { presets: RESPONSES_CREATE_PRESETS },
    agentPrompt: {
      task: "Call POST /v1/responses from my app through one request builder that covers the fields I use (model, input as a string or items, instructions, reasoning.effort, max_output_tokens, tools, text.format, store, include, stream, background) and read the reply's output items, output text and usage.",
      facts: [
        "The body is CreateResponse; send model and input. The reply is a Response with an output array of items: reasoning, message (content output_text), function_call, web_search_call.",
        "max_output_tokens counts reasoning and visible output, has a minimum of 16, and must fit the context window with the input.",
        "Structured output is text.format (json_schema); response_format doesn't configure it here. Only truncation \"disabled\" is supported, so trim history yourself.",
        "background and stream can't be combined. A stream sends response.* events and ends with response.completed, response.incomplete or response.failed.",
        "usage: input_tokens, output_tokens, output_tokens_details.reasoning_tokens, input_tokens_details.cached_tokens.",
      ],
      checklist: [
        "A plain call, a call with a function tool and a text.format call all succeed, and the code reads the text from the message item's output_text.",
        "A max_output_tokens below 16 surfaces the API's 400 message.",
      ],
      snippets: {
        python: `${PY_CLIENT}

response = client.responses.create(
    model=MODEL,
    instructions="Answer in one sentence.",
    input="What is the capital of France?",
    reasoning={"effort": "low"},
    max_output_tokens=1500,
)
for item in response.output:
    print(item.type)
print(response.output_text, response.usage.output_tokens_details.reasoning_tokens)`,
        typescript: `${TS_CLIENT}

const response = await client.responses.create({
  model,
  instructions: 'Answer in one sentence.',
  input: 'What is the capital of France?',
  reasoning: { effort: 'low' },
  max_output_tokens: 1500,
});
for (const item of response.output) console.log(item.type);
console.log(response.output_text, response.usage?.output_tokens_details?.reasoning_tokens);`,
        curl: curl("responses", '{"model": "muse-spark-1.3-contributor", "input": "What is the capital of France?"}'),
      },
    },
  }),

  "api-reference/responses/retrieve-response": demo({
    title: "GET /v1/responses/{response_id}",
    blurb:
      "Read back creates a stored response and retrieves it, checking the fields a retrieval echoes; While it runs retrieves a background response before, during and after it finishes, stream=true included. Well under a cent on Muse Spark 1.3 Contributor; the story can reach about 3 cents on a Standard Spark.",
    Component: ProtocolLab,
    props: tabs([
      flow("read", "Read back", RETRIEVE_FLOW),
      flow("background", "While it runs", RETRIEVE_BACKGROUND_FLOW),
      consoleTab("console", "Console", [
        { label: "Retrieve", note: "Responses you create in this browser show up to pick.", console: { method: "GET", path: "responses/{response_id}" } },
      ]),
    ]),
    agentPrompt: {
      task: "Add a function to my app that fetches a stored response by id with GET /v1/responses/{response_id} and reports its status, output text and usage; for a background response, poll it until the status is completed, failed, cancelled or incomplete.",
      facts: [
        "Only stored responses (store: true, the default) can be retrieved.",
        "The reply is the Response with the request's parameters echoed (instructions, tools, metadata, max_output_tokens, previous_response_id, ...), incomplete_details, created_at, completed_at and the full usage.",
        "completed_at is set only once status is completed; it's null for queued, in_progress, failed and cancelled responses.",
        "Query parameters: stream=true (documented as SSE for in-progress background responses: response.created, a terminal event, [DONE]) and starting_after (skip events at or below a sequence_number). The live API answered stream=true with JSON when this was built, so handle both.",
        "Persistence can lag the terminal event: a GET right after completion may 404 for a few seconds, so retry once or twice with backoff.",
      ],
      checklist: ["A background response started by the script is polled until a terminal status, then its status, output text and usage print."],
      snippets: {
        python: `import os
import time

import openai
from openai import OpenAI

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])

def wait_for(response_id: str, tries: int = 90):
    for _ in range(tries):
        try:
            response = client.responses.retrieve(response_id)
            if response.status in ("completed", "failed", "cancelled", "incomplete"):
                return response
        except openai.NotFoundError:
            pass  # storage can lag a brand-new response for a moment
        time.sleep(2)
    raise TimeoutError(f"{response_id} is still running")

job = client.responses.create(model="muse-spark-1.3-contributor", input="Write a haiku about patience.", background=True)
response = wait_for(job.id)
print(response.status, response.completed_at, response.output_text, response.usage)`,
        typescript: `${TS_CLIENT}

async function waitFor(id: string, tries = 90) {
  for (let i = 0; i < tries; i++) {
    const response = await client.responses.retrieve(id).catch((err) => {
      if (err instanceof OpenAI.NotFoundError) return null; // storage can lag a brand-new response
      throw err;
    });
    if (response && ['completed', 'failed', 'cancelled', 'incomplete'].includes(response.status ?? '')) return response;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(\`\${id} is still running\`);
}

const job = await client.responses.create({ model, input: 'Write a haiku about patience.', background: true });
const response = await waitFor(job.id);
console.log(response.status, response.output_text, response.usage);`,
        curl: `${curlCreate('{"model": "muse-spark-1.3-contributor", "input": "Write a haiku about patience.", "background": true}')}

# Repeat until status is completed, failed, cancelled or incomplete:
${curlOnId("GET")}`,
      },
    },
  }),

  "api-reference/responses/delete-response": demo({
    title: "DELETE /v1/responses/{response_id}",
    blurb: "Run creates a stored response, deletes it, then shows that it can't be retrieved and that a second delete is a 404. Under a cent.",
    Component: ProtocolLab,
    props: tabs([
      flow("delete", "Delete", DELETE_FLOW),
      consoleTab("console", "Console", [{ label: "Delete", note: "Responses you create in this browser show up to pick.", console: { method: "DELETE", path: "responses/{response_id}" } }]),
    ]),
    agentPrompt: {
      task: "Add cleanup to my app: when a conversation ends, delete its stored responses with DELETE /v1/responses/{response_id}, and treat a 404 on a repeat delete as already gone rather than an error.",
      facts: [
        "Returns {\"id\": \"resp_...\", \"object\": \"response.deleted\", \"deleted\": true}.",
        "A soft delete: the response can no longer be retrieved or referenced with previous_response_id.",
        "Not idempotent: a second DELETE of the same id returns 404.",
        "Only stored responses exist to delete; store: false responses never were.",
      ],
      checklist: ["Deleting a fresh response prints deleted: true; deleting it again is handled as already gone."],
      snippets: {
        python: `import os

import openai
from openai import OpenAI

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])

def delete_response(response_id: str) -> bool:
    try:
        client.responses.delete(response_id)
        return True
    except openai.NotFoundError:
        return False  # already gone: a repeat DELETE is a 404

created = client.responses.create(model="muse-spark-1.3-contributor", input="Hi")
print(delete_response(created.id), delete_response(created.id))`,
        typescript: `${TS_CLIENT}

async function deleteResponse(id: string): Promise<boolean> {
  try {
    await client.responses.delete(id);
    return true;
  } catch (err) {
    if (err instanceof OpenAI.NotFoundError) return false; // a repeat DELETE is a 404
    throw err;
  }
}

const created = await client.responses.create({ model, input: 'Hi' });
console.log(await deleteResponse(created.id), await deleteResponse(created.id));`,
        curl: `${curlCreate('{"model": "muse-spark-1.3-contributor", "input": "Hi"}')}

${curlOnId("DELETE")}
# Again: a repeat DELETE answers 404.
${curlOnId("DELETE")}`,
      },
    },
  }),

  "api-reference/responses/cancel-response": demo({
    title: "POST /v1/responses/{response_id}/cancel",
    blurb:
      "Cancel starts a long background response, cancels it, reads it back until it settles and cancels it again; Too late cancels one that already finished. Well under a cent: a cancelled run stops early.",
    Component: ProtocolLab,
    props: tabs([
      flow("cancel", "Cancel", CANCEL_FLOW),
      flow("late", "Too late", CANCEL_AFTER_FLOW),
      consoleTab("console", "Console", [{ label: "Cancel", note: "Background responses you start in this browser show up to pick.", console: { method: "POST", path: "responses/{response_id}/cancel" } }]),
    ]),
    agentPrompt: {
      task: "Add a Stop button for long requests in my app: start them with background: true, keep the id, cancel with POST /v1/responses/{response_id}/cancel, show the status the cancel returns, and fetch the response with GET when it had already finished.",
      facts: [
        "Only background responses can be cancelled. The reply has id, object, status, model, background and an always-empty output; its status is the current one (cancelled, or in_progress while the cancel takes hold), so poll GET until it settles; a run can still finish first and settle completed.",
        "A cancel that races completion returns the completed response; cancelling an already cancelled or failed one returns its current state; a deleted one is a 404.",
        "The guide says a cancel after completion returns status completed with an empty output[]; the live API has also answered 400 \"Cannot cancel a completed response.\" Handle both, then read the output with GET /v1/responses/{id}.",
        "background: true can't be combined with stream: true; a background body is capped at 1 MiB.",
      ],
      checklist: ["Stopping a running background response shows status cancelled; stopping one that already finished shows its output from GET."],
      snippets: {
        python: `import os

import openai
from openai import OpenAI

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])

job = client.responses.create(model="muse-spark-1.3-contributor", input="Write a 600-word story.", background=True)
try:
    result = client.responses.cancel(job.id)
    print(result.status)  # "cancelled", or "completed" if it won the race
except openai.BadRequestError as err:
    print("too late:", err.message)
print(client.responses.retrieve(job.id).status)`,
        typescript: `${TS_CLIENT}

const job = await client.responses.create({ model, input: 'Write a 600-word story.', background: true });
try {
  console.log((await client.responses.cancel(job.id)).status);
} catch (err) {
  if (err instanceof OpenAI.BadRequestError) console.log('too late:', err.message);
  else throw err;
}
console.log((await client.responses.retrieve(job.id)).status);`,
        curl: `${curlCreate('{"model": "muse-spark-1.3-contributor", "input": "Write a 600-word story.", "background": true}')}

${curlOnId("POST", "/cancel")}
# Then read it with GET; a cancel that came too late answers 400 or the completed response.
${curlOnId("GET")}`,
      },
    },
  }),

  "api-reference/responses/count-input-tokens": demo({
    title: "Measure a request before you send it",
    blurb:
      "Count, then send counts a request's input tokens and sends the same request, showing both numbers; With history counts a follow-up alone and on top of a stored turn; the console takes any body. Counting is free; each send is under a cent.",
    Component: ProtocolLab,
    props: tabs([
      flow("count", "Count, then send", COUNT_THEN_SEND),
      flow("history", "With history", COUNT_WITH_HISTORY),
      consoleTab("console", "Console", COUNT_PRESETS),
    ]),
    agentPrompt: {
      task: "Before my app sends a long Responses request, measure it: post the same body to POST /v1/responses/input_tokens, check that input_tokens plus max_output_tokens fits the model's context window, and drop the oldest whole turns until it does.",
      facts: [
        "The body is TokenCountsBody: the same fields as a create (model, input, instructions, tools, previous_response_id, ...). Nothing is generated or stored.",
        "The reply is {\"object\": \"response.input_tokens\", \"input_tokens\": n}: the fully rendered input, with resolved previous_response_id history, instructions, tools, media and server scaffolding.",
        "It's a context-size measurement, not billing: usage.input_tokens on the real call can differ.",
        "Muse Spark and Muse Wonder have a 1,048,576-token context window, which input_tokens plus max_output_tokens must fit.",
        "Conversation resources aren't supported. An over-context create is a 400: truncation only takes \"disabled\".",
        "When trimming encrypted reasoning items, keep or drop each one whole.",
      ],
      checklist: ["The app prints the count for a request, and a request trimmed to fit still runs."],
      snippets: {
        python: `import os

import requests

body = {
    "model": "muse-spark-1.3-contributor",
    "instructions": "Answer in one sentence.",
    "input": "What is the capital of France?",
}
response = requests.post(
    "https://api.meta.ai/v1/responses/input_tokens",
    headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"},
    json=body,
)
response.raise_for_status()
print(response.json()["input_tokens"])`,
        typescript: `const res = await fetch('https://api.meta.ai/v1/responses/input_tokens', {
  method: 'POST',
  headers: { Authorization: \`Bearer \${process.env.MODEL_API_KEY}\`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'muse-spark-1.3-contributor',
    instructions: 'Answer in one sentence.',
    input: 'What is the capital of France?',
  }),
});
if (!res.ok) throw new Error(\`HTTP \${res.status}: \${await res.text()}\`);
const { input_tokens } = await res.json();
console.log(input_tokens);`,
        curl: curl("responses/input_tokens", '{"model": "muse-spark-1.3-contributor", "input": "What is the capital of France?"}'),
      },
    },
  }),

  "api-reference/responses/schemas": demo({
    title: "Explore the Responses schemas, and check them against the live API",
    blurb:
      "Search the 146 schemas by name, field or description and open any one; for schemas with a live example, Run sends a working request and checks the real request, reply or stream event against the table field by field. Each run is well under a cent; search examples add $0.0025.",
    Component: SchemaExplorer,
    props: { source: "api-reference/responses/schemas", ...RESPONSES_SCHEMAS },
    agentPrompt: {
      task: "Type the requests my app sends to /v1/responses and the replies it reads with the definitions on this page: CreateResponse, Response, the OutputItem union (told apart by its type field), ResponseUsage and the stream events I handle. Then parse one real reply and one stream with those types.",
      facts: [
        "Unions such as OutputItem, InputItem, Tool and ResponseStreamEvent are told apart by type: message, reasoning, function_call, web_search_call, computer_call, tool_search_call; response.output_text.delta, response.completed, ...",
        "Response.output is an array of OutputItem; the visible text is in a message item's output_text content. A tool preamble message carries phase \"commentary\".",
        "The tables mark some fields required that a live reply can leave out (metadata when the request sent none), so parse defensively.",
        "ReasoningItem.encrypted_content is set only when the request includes reasoning.encrypted_content; ResponseUsage has input_tokens_details.cached_tokens and output_tokens_details.reasoning_tokens.",
        "Stream events carry sequence_number; response.completed, response.incomplete and response.failed carry the whole Response.",
      ],
      checklist: ["A real reply and a real stream parse with the types without errors, and an unknown output item type is handled rather than thrown on."],
      snippets: {
        typescript: `type OutputText = { type: 'output_text'; text: string; annotations?: unknown[] };
type OutputMessage = { type: 'message'; id?: string; role: 'assistant'; content: OutputText[]; phase?: 'commentary' | 'final_answer' | null; status?: string };
type ReasoningItem = { type: 'reasoning'; id: string; summary: Array<{ type: 'summary_text'; text: string }>; encrypted_content?: string | null };
type FunctionCall = { type: 'function_call'; id?: string; call_id: string; name: string; arguments: string; status?: string };
type OutputItem = OutputMessage | ReasoningItem | FunctionCall | { type: string };

interface ResponseUsage {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
}

interface Response {
  id: string;
  object: 'response';
  status?: 'completed' | 'failed' | 'in_progress' | 'cancelled' | 'queued' | 'incomplete';
  model: string;
  output: OutputItem[];
  usage?: ResponseUsage;
  metadata?: Record<string, string> | null;
}`,
        python: `from typing import Literal, NotRequired, TypedDict

class OutputText(TypedDict):
    type: Literal["output_text"]
    text: str

class OutputMessage(TypedDict):
    type: Literal["message"]
    role: Literal["assistant"]
    content: list[OutputText]
    phase: NotRequired[str | None]

class ResponseUsage(TypedDict):
    input_tokens: int
    input_tokens_details: dict
    output_tokens: int
    output_tokens_details: dict
    total_tokens: int

class Response(TypedDict):
    id: str
    object: Literal["response"]
    status: NotRequired[str]
    model: str
    output: list[dict]  # OutputItem: switch on item["type"]
    usage: NotRequired[ResponseUsage]
    metadata: NotRequired[dict | None]`,
        curl: curl("responses", '{"model": "muse-spark-1.3-contributor", "input": "What is the capital of France?"}'),
      },
    },
  }),

  "api-reference/chat-completions": demo({
    title: "Chat completions, with working bodies",
    blurb: "Pick a body and Send: the page's request, a stream with usage, structured output, or a tool call. Under a cent each.",
    Component: ConsolePresets,
    props: { presets: [CHAT_PRESETS[0], CHAT_PRESETS[2], CHAT_PRESETS[5], CHAT_PRESETS[7], CHAT_PRESETS[8]] },
    agentPrompt: {
      task: "Call POST /v1/chat/completions from my app with the request shape this reference documents (model and messages, plus max_completion_tokens, reasoning_effort, response_format and tools as needed) and read choices[0].message and usage from the reply.",
      facts: [
        "Reasoning isn't carried across turns on this endpoint; use the Responses API for agentic, multi-step work.",
        "The reply is CreateChatCompletionResponse: one choice, choices[0].message.content (or tool_calls), finish_reason stop, length or tool_calls, usage prompt_tokens and completion_tokens.",
        "A stream sends chat.completion.chunk events with choices[0].delta; stream_options {\"include_usage\": true} adds usage on the last chunk; it ends with [DONE].",
        "n must be 1; stop, logprobs, modalities and audio are 400s on Muse Spark.",
      ],
      checklist: ["A call prints choices[0].message.content and usage; a streamed call prints deltas and the final usage."],
      snippets: {
        python: `${PY_CLIENT}

response = client.chat.completions.create(
    model=MODEL,
    messages=[{"role": "user", "content": "What are three differences between TCP and UDP?"}],
    max_completion_tokens=1500,
)
print(response.choices[0].message.content, response.choices[0].finish_reason, response.usage)`,
        typescript: `${TS_CLIENT}

const response = await client.chat.completions.create({
  model,
  messages: [{ role: 'user', content: 'What are three differences between TCP and UDP?' }],
  max_completion_tokens: 1500,
});
console.log(response.choices[0].message.content, response.choices[0].finish_reason, response.usage);`,
        curl: curl("chat/completions", '{"model": "muse-spark-1.3-contributor", "messages": [{"role": "user", "content": "What are three differences between TCP and UDP?"}]}'),
      },
    },
  }),

  "api-reference/chat-completions/create-chat-completion": demo({
    title: "POST /v1/chat/completions, with working bodies",
    blurb:
      "Pick a body and Send: the page's request, a developer message, a stream, a multi-turn history, reasoning effort, structured output, JSON mode, a tool call, a tool result, or your own image. Under a cent each.",
    Component: ConsolePresets,
    props: { presets: CHAT_PRESETS },
    agentPrompt: {
      task: "Add a chat completion call to my app with the full request this endpoint takes: a messages array with developer, user, assistant and tool messages, max_completion_tokens, reasoning_effort, response_format for JSON and function tools. Handle a tool_calls reply by running the tool and sending back the assistant message plus one tool message per call.",
      facts: [
        "POST https://api.meta.ai/v1/chat/completions; body CreateChatCompletionRequest with model and messages (at least one).",
        "Tools nest under function: {\"type\": \"function\", \"function\": {\"name\", \"description\", \"parameters\"}}; tool_choice takes \"auto\". Arguments come back as a JSON string: validate before running.",
        "response_format {\"type\": \"json_schema\", \"json_schema\": {\"name\", \"schema\", \"strict\"}} for structured output; {\"type\": \"json_object\"} needs an instruction asking for JSON.",
        "reasoning_effort: minimal, low, medium, high, xhigh; \"none\" is a 400. max_tokens is a deprecated alias of max_completion_tokens.",
        "n must be 1; stop, logprobs, modalities and audio are 400s.",
      ],
      checklist: ["A tool_calls reply is answered and the second call returns finish_reason stop with the final text.", "A response_format call returns JSON that parses."],
      snippets: {
        python: `import json

${PY_CLIENT}
tools = [{"type": "function", "function": {"name": "get_weather", "description": "Get the current weather for a city.",
          "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]
messages = [{"role": "user", "content": "What's the weather in Paris right now?"}]

first = client.chat.completions.create(model=MODEL, messages=messages, tools=tools)
message = first.choices[0].message
if message.tool_calls:
    messages.append(message.model_dump(exclude_none=True))
    for call in message.tool_calls:
        args = json.loads(call.function.arguments)
        messages.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps({"city": args["city"], "temperature_c": 18})})
    final = client.chat.completions.create(model=MODEL, messages=messages, tools=tools)
    print(final.choices[0].message.content)`,
        typescript: `${TS_CLIENT}

const tools: OpenAI.ChatCompletionTool[] = [{
  type: 'function',
  function: { name: 'get_weather', description: 'Get the current weather for a city.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
}];
const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: "What's the weather in Paris right now?" }];
const first = await client.chat.completions.create({ model, messages, tools });
const message = first.choices[0].message;
if (message.tool_calls?.length) {
  messages.push(message);
  for (const call of message.tool_calls) {
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ temperature_c: 18 }) });
  }
  const final = await client.chat.completions.create({ model, messages, tools });
  console.log(final.choices[0].message.content);
}`,
        curl: curl("chat/completions", '{"model": "muse-spark-1.3-contributor", "messages": [{"role": "user", "content": "What are three differences between TCP and UDP?"}]}'),
      },
    },
  }),

  "api-reference/chat-completions/schemas": demo({
    title: "Explore the Chat Completions schemas, and check them against the live API",
    blurb:
      "Search the 43 schemas and open any one; for those with a live example, Run sends a working request and checks the real request, reply or stream chunk against the table field by field. Well under a cent a run.",
    Component: SchemaExplorer,
    props: { source: "api-reference/chat-completions/schemas", ...CHAT_SCHEMAS },
    agentPrompt: {
      task: "Type my app's Chat Completions calls with the definitions on this page: CreateChatCompletionRequest with its message union (developer, system, user, assistant, tool), ChatCompletionTool, CreateChatCompletionResponse, ChatCompletionResponseMessage, CompletionUsage and the stream chunk. Then parse one real reply and one stream with them.",
      facts: [
        "ChatCompletionRequestMessage is a union told apart by role; tool messages need tool_call_id; an assistant message needs content unless it has tool_calls.",
        "choices[].message.content and refusal are required but may be null; tool_calls[].function.arguments is a JSON string the model can get wrong, so validate it.",
        "In a stream, every chunk has the same id and created; finish_reason is null until the last chunk, though the table lists no null; usage is on the last chunk only with stream_options.include_usage.",
        "CompletionUsage has prompt_tokens, completion_tokens, total_tokens, plus completion_tokens_details.reasoning_tokens and prompt_tokens_details.cached_tokens.",
        "finish_reason is stop, length, tool_calls, content_filter or the deprecated function_call.",
      ],
      checklist: ["A real reply and a real stream parse with the types, and a tool_calls reply types its calls."],
      snippets: {
        typescript: `type Role = 'developer' | 'system' | 'user' | 'assistant' | 'tool';
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type RequestMessage =
  | { role: 'developer' | 'system' | 'user'; content: string | Array<{ type: string; [k: string]: unknown }>; name?: string }
  | { role: 'assistant'; content?: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
}

interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{ index: number; finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call'; message: { role: 'assistant'; content: string | null; refusal: string | null; tool_calls?: ToolCall[] } }>;
  usage?: CompletionUsage;
}`,
        python: `from typing import Literal, NotRequired, TypedDict

class ToolCall(TypedDict):
    id: str
    type: Literal["function"]
    function: dict  # {"name": str, "arguments": str (JSON)}

class ResponseMessage(TypedDict):
    role: Literal["assistant"]
    content: str | None
    refusal: str | None
    tool_calls: NotRequired[list[ToolCall]]

class Choice(TypedDict):
    index: int
    finish_reason: Literal["stop", "length", "tool_calls", "content_filter", "function_call"]
    message: ResponseMessage

class ChatCompletion(TypedDict):
    id: str
    object: Literal["chat.completion"]
    created: int
    model: str
    choices: list[Choice]
    usage: NotRequired[dict]`,
        curl: curl("chat/completions", '{"model": "muse-spark-1.3-contributor", "messages": [{"role": "user", "content": "Hi"}]}'),
      },
    },
  }),

  "api-reference/messages": demo({
    title: "Messages and count_tokens, with working bodies",
    blurb: "Pick a body and Send: the page's message, a stream, a tool, structured output, or a token count. Under a cent each; counting is free.",
    Component: ConsolePresets,
    props: { presets: [MESSAGES_PRESETS[0], MESSAGES_PRESETS[3], MESSAGES_PRESETS[4], MESSAGES_PRESETS[7], MESSAGES_PRESETS[9]] },
    agentPrompt: {
      task: "Call the two Messages endpoints from my app in the Anthropic wire format: POST /v1/messages to generate (model, max_tokens, messages, optional system, tools and thinking) and POST /v1/messages/count_tokens to measure a request first, reading content blocks, stop_reason and usage from the reply.",
      facts: [
        "Auth is Authorization: Bearer $MODEL_API_KEY (x-api-key is accepted too); anthropic-version is accepted for SDK compatibility.",
        "Supported tools are developer-defined custom tools and the built-in web_search.",
        "count_tokens takes the same body minus max_tokens and returns {\"input_tokens\": n}.",
        "Rate limits and billing are the same as the other endpoints.",
      ],
      checklist: ["A message call prints its text blocks and usage; a count_tokens call prints input_tokens for the same body."],
      snippets: {
        python: `${PY_ANTHROPIC}

body = {"model": MODEL, "messages": [{"role": "user", "content": "What is the capital of France?"}]}
print(client.messages.count_tokens(**body).input_tokens)
message = client.messages.create(max_tokens=1024, **body)
print(message.stop_reason, [b.type for b in message.content], message.usage)`,
        typescript: `${TS_MESSAGES_HELPER}

const body = { model, messages: [{ role: 'user', content: 'What is the capital of France?' }] };
console.log((await messages('messages/count_tokens', body)).input_tokens);
const message = await messages('messages', { ...body, max_tokens: 1024 });
console.log(message.stop_reason, message.content.map((b: { type: string }) => b.type), message.usage);`,
        curl: `${curl("messages/count_tokens", '{"model": "muse-spark-1.3-contributor", "messages": [{"role": "user", "content": "What is the capital of France?"}]}')}

${curl("messages", '{"model": "muse-spark-1.3-contributor", "max_tokens": 1024, "messages": [{"role": "user", "content": "What is the capital of France?"}]}')}`,
      },
    },
  }),

  "api-reference/messages/create-message": demo({
    title: "POST /v1/messages, with working bodies",
    blurb:
      "Pick a body and Send: the page's request, system, thinking, a stream, a tool, a tool result, web search, structured output, a document, or a token count. Under a cent each; web search adds $0.0025 a query.",
    Component: ConsolePresets,
    props: { presets: MESSAGES_PRESETS },
    agentPrompt: {
      task: "Add an Anthropic-format message call to my app against Meta Model API: model, max_tokens and messages, with system, custom tools, thinking and output_config.format as needed. Handle stop_reason tool_use by running the tool and sending tool_result in the next user turn, and replay the assistant content as returned.",
      facts: [
        "POST https://api.meta.ai/v1/messages; body AnthropicMessageRequest with model, messages (at least one) and max_tokens (at least 1).",
        "Custom tools carry input_schema; tool_choice takes auto, any or none (a named tool is a 400); disable_parallel_tool_use is accepted.",
        "content blocks: text, thinking (a summary, per the page) and redacted_thinking (encrypted; the only kind Meta sent when this was built): replay both. Also tool_use, server_tool_use (web_search). stop_reason: end_turn, tool_use, max_tokens or refusal.",
        "output_config.format {\"type\": \"json_schema\", \"schema\"} for structured output; output_config.effort low, medium, high, xhigh.",
        "stop_sequences, top_k, container and inference_geo are 400s; temperature runs 0 to 1.",
      ],
      checklist: ["A tool_use reply is answered with tool_result and the final reply ends with end_turn.", "A 400 (try top_k) surfaces the error envelope's message."],
      snippets: {
        python: `import json

${PY_ANTHROPIC}
tools = [{"name": "get_weather", "description": "Get the current weather for a city.",
          "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}]
messages = [{"role": "user", "content": "What's the weather in Paris right now?"}]

reply = client.messages.create(model=MODEL, max_tokens=1024, messages=messages, tools=tools)
if reply.stop_reason == "tool_use":
    messages.append({"role": "assistant", "content": reply.content})
    results = [{"type": "tool_result", "tool_use_id": b.id, "content": json.dumps({"temperature_c": 18})}
               for b in reply.content if b.type == "tool_use"]
    messages.append({"role": "user", "content": results})
    reply = client.messages.create(model=MODEL, max_tokens=1024, messages=messages, tools=tools)
print(reply.stop_reason, "".join(b.text for b in reply.content if b.type == "text"))`,
        typescript: `${TS_MESSAGES_HELPER}

const tools = [{ name: 'get_weather', description: 'Get the current weather for a city.', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];
const history: Array<{ role: string; content: unknown }> = [{ role: 'user', content: "What's the weather in Paris right now?" }];
let reply = await messages('messages', { model, max_tokens: 1024, messages: history, tools });
if (reply.stop_reason === 'tool_use') {
  history.push({ role: 'assistant', content: reply.content });
  const results = reply.content
    .filter((b: { type: string }) => b.type === 'tool_use')
    .map((b: { id: string }) => ({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify({ temperature_c: 18 }) }));
  history.push({ role: 'user', content: results });
  reply = await messages('messages', { model, max_tokens: 1024, messages: history, tools });
}
console.log(reply.stop_reason, reply.content);`,
        curl: curl("messages", '{"model": "muse-spark-1.3-contributor", "max_tokens": 1024, "messages": [{"role": "user", "content": "What is the capital of France?"}]}'),
      },
    },
  }),

  "api-reference/messages/count-tokens": demo({
    title: "POST /v1/messages/count_tokens",
    blurb: "Count, then send counts a request and sends the same one, showing both numbers; the console takes any body. Counting is free; the send is under a cent.",
    Component: ProtocolLab,
    props: tabs([flow("count", "Count, then send", MESSAGES_COUNT_THEN_SEND), consoleTab("console", "Console", MESSAGES_COUNT_PRESETS)]),
    agentPrompt: {
      task: "Before my app sends an Anthropic-format request, count it: post the same body without max_tokens to POST /v1/messages/count_tokens, and trim the oldest turns when input_tokens plus max_tokens won't fit the model's context window.",
      facts: [
        "The body is AnthropicCountTokensRequest: model, messages, and optional system, tools, tool_choice, thinking, output_config; max_tokens and stream are ignored.",
        "The reply is {\"input_tokens\": n}; nothing is generated.",
        "The count measures the rendered input, so it can differ from the usage a real call bills.",
        "Muse Spark and Muse Wonder have a 1,048,576-token context window, which input_tokens plus max_tokens must fit.",
        "Auth is Authorization: Bearer $MODEL_API_KEY; the Anthropic SDK's base URL is https://api.meta.ai.",
      ],
      checklist: ["The app prints input_tokens for a request before sending it."],
      snippets: {
        python: `${PY_ANTHROPIC}

count = client.messages.count_tokens(
    model=MODEL,
    system="You are a geography tutor.",
    messages=[{"role": "user", "content": "What is the capital of France?"}],
)
print(count.input_tokens)`,
        typescript: `${TS_MESSAGES_HELPER}

const count = await messages('messages/count_tokens', {
  model,
  system: 'You are a geography tutor.',
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
});
console.log(count.input_tokens);`,
        curl: curl("messages/count_tokens", '{"model": "muse-spark-1.3-contributor", "messages": [{"role": "user", "content": "What is the capital of France?"}]}'),
      },
    },
  }),

  "api-reference/messages/schemas": demo({
    title: "Explore the Messages schemas, and check them against the live API",
    blurb:
      "Search the 53 schemas and open any one; for those with a live example, Run sends a working request and checks the real request, reply or stream event against the table field by field. Well under a cent a run; the search example adds $0.0025.",
    Component: SchemaExplorer,
    props: { source: "api-reference/messages/schemas", ...MESSAGES_SCHEMAS },
    agentPrompt: {
      task: "Type my app's Messages calls with the definitions on this page: AnthropicMessageRequest (messages, system blocks, tools, tool_choice, thinking, output_config), the content block params I send, AnthropicMessage with its content blocks and AnthropicUsage, and the count_tokens request and response. Then parse one real reply with them.",
      facts: [
        "Input content blocks are a union told apart by type: text, image, video, document, search_result, tool_use, tool_result, server_tool_use, thinking, redacted_thinking. A block a role doesn't support is an invalid_request_error.",
        "Reply content blocks include text, thinking (the summary the page describes), redacted_thinking (field data; the only reasoning block Meta sent when this was built), tool_use and server_tool_use. Replay reasoning blocks as is.",
        "AnthropicThinkingConfigParam is enabled (budget_tokens at least 1024 and below max_tokens), adaptive or disabled; display is summarized or omitted.",
        "AnthropicUsage: input_tokens and output_tokens, plus cache_read_input_tokens, cache_creation_input_tokens and output_tokens_details.thinking_tokens.",
        "AnthropicToolChoice type is auto, any or none; cache_control takes only {\"type\": \"ephemeral\", \"ttl\": \"5m\"}.",
      ],
      checklist: ["A real reply parses with the types, thinking, redacted_thinking and tool_use blocks included."],
      snippets: {
        typescript: `type TextBlock = { type: 'text'; text: string };
type Thinking = { type: 'thinking'; thinking: string; signature?: string };
type RedactedThinking = { type: 'redacted_thinking'; data: string };
type ToolUse = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type ServerToolUse = { type: 'server_tool_use'; id: string; name: 'web_search' | 'tool_search'; input: { query?: string } };
type ContentBlock = TextBlock | Thinking | RedactedThinking | ToolUse | ServerToolUse | { type: string };

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
}

interface AnthropicMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: ContentBlock[];
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal';
  stop_sequence: string | null;
  usage: AnthropicUsage;
}`,
        python: `from typing import Literal, NotRequired, TypedDict

class AnthropicUsage(TypedDict):
    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: NotRequired[int]
    cache_read_input_tokens: NotRequired[int]
    output_tokens_details: NotRequired[dict]

class AnthropicMessage(TypedDict):
    id: str
    type: Literal["message"]
    role: Literal["assistant"]
    model: str
    content: list[dict]  # switch on block["type"]: text, thinking, redacted_thinking, tool_use, server_tool_use
    stop_reason: Literal["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal"]
    stop_sequence: str | None
    usage: AnthropicUsage`,
        curl: curl("messages", '{"model": "muse-spark-1.3-contributor", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hi"}]}'),
      },
    },
  }),
};
