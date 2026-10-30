import type { ComponentProps, ComponentType } from "react";
import type { DemoMap, DemoSpec } from "@/lib/docs/demos/types";
import { AgentLoopDemo } from "@/components/docs/playgrounds/cookbook-fundamentals/AgentLoopDemo";
import { ContextDemo } from "@/components/docs/playgrounds/cookbook-fundamentals/ContextDemo";
import { EditsDemo } from "@/components/docs/playgrounds/cookbook-fundamentals/EditsDemo";
import { LongContextDemo } from "@/components/docs/playgrounds/cookbook-fundamentals/LongContextDemo";
import { PromptCachingDemo } from "@/components/docs/playgrounds/cookbook-fundamentals/PromptCachingDemo";
import { ReasoningDemo } from "@/components/docs/playgrounds/cookbook-fundamentals/ReasoningDemo";
import { RecipeBrowser } from "@/components/docs/playgrounds/cookbook-fundamentals/RecipeBrowser";
import { RetryDemo } from "@/components/docs/playgrounds/cookbook-fundamentals/RetryDemo";
import { SearchGroundingDemo } from "@/components/docs/playgrounds/cookbook-fundamentals/SearchGroundingDemo";
import { StreamingDemo } from "@/components/docs/playgrounds/cookbook-fundamentals/StreamingDemo";
import { TabbedDemo } from "@/components/docs/playgrounds/cookbook-fundamentals/TabbedDemo";
import { ToolCallingDemo } from "@/components/docs/playgrounds/cookbook-fundamentals/ToolCallingDemo";
import { VisionInputDemo } from "@/components/docs/playgrounds/cookbook-fundamentals/VisionInputDemo";

/**
 * Live demos and coding-agent prompts for the "cookbook-fundamentals" pages:
 *   cookbook
 *   cookbook/api-fundamentals
 *   cookbook/agent-patterns
 *   cookbook/quickstart-chat-completions
 *   cookbook/streaming-responses
 *   cookbook/tool-function-calling
 *   cookbook/structured-output
 *   cookbook/prompt-caching
 *   cookbook/reasoning-thinking-tokens
 *   cookbook/vision-input
 *   cookbook/search-grounding
 *   cookbook/error-handling-retry
 *   cookbook/basic-agent-loop
 *   cookbook/interleaved-reasoning-tool-use
 *   cookbook/multi-turn-context-management
 *   cookbook/search-and-replace-edits
 *   cookbook/long-context
 * Components live in components/docs/playgrounds/cookbook-fundamentals/. Demos run on muse-spark-1.3-contributor,
 * and the code here uses it wherever the recipes say muse-spark-1.3 (Contributor mode: Meta may train on what's
 * sent; drop -contributor for Standard mode).
 */

/** A component's props without the slug the docs page adds. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;
type PropsOf<C extends AnyComponent> = Omit<ComponentProps<C>, "slug">;

/**
 * Keeps each spec's props tied to its component: the props are checked against the component's own prop types (so
 * a union like "chat" | "responses" stays a union), not inferred from the literal.
 */
const demo = <C extends AnyComponent>(
  spec: Omit<DemoSpec, "Component" | "props"> & { Component: C; props: PropsOf<C> },
): DemoSpec<PropsOf<C>> => spec as unknown as DemoSpec<PropsOf<C>>;

const M = "muse-spark-1.3-contributor";

/*
 * Snippet sizes: buildAgentPrompt (lib/docs/agent-prompt.ts) keeps a prompt under 4,000 characters by shrinking its
 * sections in steps. With "Include what I just ran" and a large recorded body (an agent loop's tools and outputs), it
 * lands on the step that allows 1,000 characters of starter code and 700 of facts. Every spec here stays inside that,
 * so a recorded run gets trimmed and the starter code and facts never do (__tests__/prompts.test.ts checks it).
 */

/**
 * The Python client setup: the standard-library imports a snippet needs, sorted in beside os, then the openai names it
 * uses beside OpenAI. The SDK doesn't read MODEL_API_KEY on its own, so the key is passed.
 */
const pyClient = (stdlib: string[] = [], openai: string[] = []) => `${["os", ...stdlib]
  .sort()
  .map((m) => `import ${m}`)
  .join("\n")}

from openai import ${["OpenAI", ...openai].sort().join(", ")}

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])`;

const PY_CLIENT = pyClient();

const TS_CLIENT = `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });`;

/**
 * A curl call with a JSON body. The body sits in single quotes, so each quote inside it (What's) is closed, escaped and
 * reopened ('\'') the way the kit's codegen writes it; otherwise the shell ends the string early.
 */
const curl = (path: string, body: string, flags = "") => `curl${flags ? ` ${flags}` : ""} -X POST "https://api.meta.ai/v1/${path}" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${body.replace(/'/g, "'\\''")}'`;

// ---------------------------------------------------------------------------------------------------------------
// Shared request pieces from the recipes

const PRODUCT_SCHEMA = {
  type: "object",
  properties: { name: { type: "string" }, price_usd: { type: "number" }, in_stock: { type: "boolean" } },
  required: ["name", "price_usd", "in_stock"],
  additionalProperties: false,
};

const KEYCHRON = "Describe the Keychron K2 in one sentence, then give its specs as JSON with keys name, price_usd, and in_stock.";

const CONTEXT_INSTRUCTIONS = `You are the engineer on a new HTTP reverse proxy + load balancer, designed in TypeScript on Node.js built-ins. This is a design conversation: describe modules and decisions, don't write code. Keep each reply under 150 words.

- Maintain STATE.md as your working memory: the goal, key decisions, a task graph with status, a file map (the files each part touches), the current step, and open questions. Update it after every turn and consult it before each.
- When a change ripples, name every module it touches.
- End every reply with the complete, updated STATE.md inside a fenced block that starts with \`\`\`state`;

export const cookbookFundamentalsDemos: DemoMap = {
  cookbook: demo({
    title: "Run any recipe's core call",
    blurb:
      "Pick a recipe's card and Run sends its core call, the one request at its heart, through the live docs: a fraction of a cent for most, about 1 cent for Muse Image and web search, 2.4 cents for the SAM clip. Muse Code and open-weight recipes show the command to start with instead, and Muse Spark Open on Mac shows both.",
    Component: RecipeBrowser,
    props: { start: "cookbook/quickstart-chat-completions" },
    agentPrompt: {
      task: "Pick the cookbook recipe that fits this project best and tell me which one and why in two sentences. Then build its core call into this project: one function that sends the recipe's key request to Meta Model API and returns the field that recipe reads from the reply. Read that recipe's own page as Markdown (https://dev.meta.ai/docs/cookbook/<recipe>.md) before you write code.",
      facts: [
        "Text recipes use Chat Completions (POST /v1/chat/completions) or Responses (POST /v1/responses); web search and reasoning items are Responses only.",
        "Models: muse-spark-1.3-contributor for text (drop -contributor for Standard mode), sam-3.1 for segmentation, muse-voice-transcribe-1.0 on POST /v1/asr/transcribe (multipart).",
        "muse-image-1.0 ($0.01 an image): its recipes call it on Responses; POST /v1/images/generations and /v1/images/edits take it too.",
        "Muse Code recipes run in the muse CLI (curl -fsSL https://dev.meta.ai/install.sh | sh) and open-weight recipes on your own hardware: neither is a Model API call.",
        "The OpenAI SDK doesn't read MODEL_API_KEY: pass it as the api key.",
      ],
      checklist: ["You named the recipe and why it fits.", "Running the new function once makes a real call and prints the field the recipe's page says to read."],
      snippets: {
        python: `${PY_CLIENT}

# The quickstart recipe's core call: a model and a messages array.
response = client.chat.completions.create(
    model="${M}",
    messages=[{"role": "user", "content": "In two sentences, what is the Meta Model API?"}],
)
print(response.choices[0].message.content)
print("finish_reason:", response.choices[0].finish_reason)
print("usage:", response.usage)`,
        typescript: `${TS_CLIENT}

// The quickstart recipe's core call: a model and a messages array.
const response = await client.chat.completions.create({
  model: "${M}",
  messages: [{ role: "user", content: "In two sentences, what is the Meta Model API?" }],
});
console.log(response.choices[0].message.content);
console.log("finish_reason:", response.choices[0].finish_reason, "usage:", response.usage);`,
        curl: curl("chat/completions", `{"model": "${M}", "messages": [{"role": "user", "content": "In two sentences, what is the Meta Model API?"}]}`),
      },
    },
  }),

  "cookbook/api-fundamentals": demo({
    title: "Run each fundamentals recipe's core call",
    blurb:
      "Pick any of the ten cards and Run sends that recipe's core call through the live docs and points at the field it teaches, under a cent each (about 1 cent for web search).",
    Component: RecipeBrowser,
    props: { sections: ["api-fundamentals"] },
    agentPrompt: {
      task: "Build a small Meta Model API starter module for this project covering the API fundamentals recipes: a client, a chat helper with a developer message, a streaming helper that guards empty chunks and returns the final chunk's usage, a structured-output helper with response_format json_schema, and a retry wrapper for 429, 5xx and timeouts. Add one runnable example per helper.",
      facts: [
        "muse-spark-1.3-contributor is a reasoning model: stop, n > 1, logit_bias and verbosity return HTTP 400, and reasoning tokens bill as output.",
        "Chat Completions is stateless: resend the history every call. Prefer the developer role to system.",
        "Streaming: stream_options include_usage puts usage on the final chunk, whose delta.content is None.",
        "Structured output: response_format json_schema on Chat, text.format on Responses. Recursive $ref schemas are rejected.",
        "Retry 429, 5xx and timeouts with 0.5 * 2**attempt + uniform(0, 0.5) s waits; never retry another 4xx.",
        "Web search and previous_response_id are Responses API features (POST /v1/responses).",
      ],
      checklist: ["Each example runs and prints its result.", "A request with n=2 raises a 400 once, with no retries."],
      snippets: {
        python: `${pyClient(["random", "time"], ["APIConnectionError", "APIStatusError"])}


def complete(messages, max_retries=5, **kwargs):
    for attempt in range(max_retries):
        try:
            return client.chat.completions.create(model="${M}", messages=messages, **kwargs)
        except (APIStatusError, APIConnectionError) as exc:
            status = getattr(exc, "status_code", 500)  # a timeout has none: retry it
            if (status < 500 and status != 429) or attempt == max_retries - 1:
                raise  # any other 4xx: fix the request
        time.sleep(0.5 * 2**attempt + random.uniform(0, 0.5))


reply = complete([
    {"role": "developer", "content": "Answer in one sentence."},
    {"role": "user", "content": "What is a context window?"},
])
print(reply.choices[0].message.content, reply.usage)`,
        typescript: `${TS_CLIENT}

export async function complete(messages: OpenAI.ChatCompletionMessageParam[], maxRetries = 5) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.chat.completions.create({ model: "${M}", messages });
    } catch (err) {
      const status = err instanceof OpenAI.APIError ? err.status : undefined;
      const transient = status === undefined || status === 429 || status >= 500;
      if (!transient || attempt === maxRetries - 1) throw err;
      await new Promise((r) => setTimeout(r, (0.5 * 2 ** attempt + Math.random() * 0.5) * 1000));
    }
  }
}`,
        curl: curl(
          "chat/completions",
          `{"model": "${M}", "messages": [{"role": "developer", "content": "Answer in one sentence."}, {"role": "user", "content": "What is a context window?"}]}`,
        ),
      },
    },
  }),

  "cookbook/agent-patterns": demo({
    title: "Run each agent pattern's first step",
    blurb:
      "Pick any of the five cards and Run sends the first request of that recipe's loop through the live docs, well under a cent each, while the recipe pages run the whole loops.",
    Component: RecipeBrowser,
    props: { sections: ["agent-patterns"] },
    agentPrompt: {
      task: "Add a minimal agent loop to this project on Meta Model API's Responses API: read_file, write_file and run_tests function tools, each call run here and sent back as function_call_output with previous_response_id, repeated until the model answers, with the agent-patterns guards: a turn cap, a token budget, and a stop when one call repeats three times.",
      facts: [
        "POST /v1/responses with tools [{type: function, name, description, parameters}]; each function_call has a call_id and arguments as a JSON string.",
        "Send results as input [{type: function_call_output, call_id, output}] with previous_response_id. Instructions and tools don't carry over: resend them every call.",
        "parallel_tool_calls: false keeps it to one tool per turn, the basic loop's contract.",
        "Muse Spark often writes a line of narration beside its tool call.",
        "For long runs, have the model keep a STATE.md, and edit files with exact-match replacements rather than whole-file writes.",
      ],
      checklist: [
        "The loop fixes a failing test in a sample repo and stops when the tests pass.",
        "A run that repeats the same call three times stops with a stuck message.",
      ],
      snippets: {
        python: `import json


def agent(client, task, tools, run_tool, max_turns=15):
    """client: OpenAI on https://api.meta.ai/v1. run_tool(name, args) returns text, errors included."""
    opts = {"model": "${M}", "tools": tools, "parallel_tool_calls": False}
    r, seen = client.responses.create(input=task, **opts), []
    for _ in range(max_turns):
        calls = [i for i in r.output if i.type == "function_call"]
        if not calls:
            return r.output_text
        seen += [(c.name, c.arguments) for c in calls]
        if any(seen.count(key) >= 3 for key in seen):
            raise RuntimeError("stuck: the same call three times")
        outputs = [{"type": "function_call_output", "call_id": c.call_id,
                    "output": run_tool(c.name, json.loads(c.arguments))} for c in calls]
        r = client.responses.create(previous_response_id=r.id, input=outputs, **opts)
    raise RuntimeError("turn cap reached")`,
        typescript: `import type OpenAI from "openai";

export async function agent(client: OpenAI, task: string, tools: OpenAI.Responses.Tool[], runTool: (name: string, args: unknown) => Promise<string>) {
  const opts = { model: "${M}", tools, parallel_tool_calls: false };
  let r = await client.responses.create({ ...opts, input: task });
  const seen: Record<string, number> = {};
  for (let i = 0; i < 15; i++) {
    const calls = r.output.filter((o) => o.type === "function_call");
    if (!calls.length) return r.output_text;
    if (calls.some((c) => (seen[c.name + c.arguments] = (seen[c.name + c.arguments] ?? 0) + 1) >= 3)) throw new Error("stuck");
    const input = [];
    for (const c of calls) input.push({ type: "function_call_output" as const, call_id: c.call_id, output: await runTool(c.name, JSON.parse(c.arguments)) });
    r = await client.responses.create({ ...opts, previous_response_id: r.id, input });
  }
  throw new Error("turn cap reached");
}`,
        curl: curl(
          "responses",
          `{"model": "${M}", "input": "tests/test_pagination.py is failing. Fix the bug.", "parallel_tool_calls": false, "tools": [{"type": "function", "name": "read_file", "description": "Read a file.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}]}`,
        ),
      },
    },
  }),

  "cookbook/quickstart-chat-completions": demo({
    title: "Your first chat completion, then the recipe's variations",
    blurb:
      "Run sends the recipe's first request to Chat Completions, with presets for a developer message, a persona, temperature 0.2 and 1.5 and an unsupported parameter's 400, and a second tab that shows statelessness, each run a fraction of a cent.",
    Component: TabbedDemo,
    props: {
      label: "Quickstart demos",
      tabs: [
        {
          id: "chat",
          label: "Chat",
          kind: "chat",
          props: {
            protocol: "chat",
            prompt: "In two sentences, what is the Meta Model API?",
            effort: "minimal",
            stream: false,
            // Each of the recipe's examples is one message on its own; the next tab is where history gets resent.
            multiTurn: false,
            presets: [
              { label: "First completion", prompt: "In two sentences, what is the Meta Model API?", system: "" },
              {
                label: "Developer message",
                system: "You are a terse assistant. Answer in exactly one sentence, with no preamble.",
                prompt: "Why do reasoning models use chain-of-thought?",
              },
              { label: "Persona: a pirate", system: "Answer as a pirate.", prompt: "Why do reasoning models use chain-of-thought?" },
              { label: "temperature 0.2", system: "", prompt: "Suggest a name for a Python logging library.", extraBody: { temperature: 0.2 } },
              { label: "temperature 1.5", system: "", prompt: "Suggest a name for a Python logging library.", extraBody: { temperature: 1.5 } },
              { label: "stop (HTTP 400)", system: "", prompt: "Count from 1 to 5, one number per line.", extraBody: { stop: ["3"] } },
            ],
          },
        },
        { id: "stateless", label: "Stateless vs history", kind: "stateless", props: {} },
      ],
    },
    agentPrompt: {
      task: "Add a Meta Model API chat helper to this project with the OpenAI SDK pointed at https://api.meta.ai/v1: complete(messages) on Chat Completions with model muse-spark-1.3-contributor, a developer message for standing rules, and a Conversation that appends each reply and the next user message, then resends the whole array. Wrap the call in a retry for 429, 5xx and timeouts that never retries a 400.",
      facts: [
        "Chat Completions is stateless: send the history every call, or use the Responses API's previous_response_id.",
        "Prefer the developer role: system is applied at the developer level anyway.",
        "Leave temperature at its default 1.0, and set temperature or top_p, not both.",
        "stop and logit_bias return HTTP 400. logprobs needs reasoning_effort none, which this model rejects today, so leave logprobs out.",
        "Reasoning tokens count as output (usage.completion_tokens_details.reasoning_tokens).",
        "finish_reason: stop is a natural end, length hit the token cap, tool_calls wants a tool.",
      ],
      checklist: [
        "A first call prints the reply, finish_reason and usage.",
        'A follow-up about "your previous answer" works because the history is resent.',
        "A request with stop raises a 400 at once, with no retries.",
      ],
      snippets: {
        python: `${PY_CLIENT}
MODEL = "${M}"

messages = [
    {"role": "developer", "content": "You are a concise assistant."},
    {"role": "user", "content": "In one sentence, name the most underrated module in the Python standard library."},
]
opinion = client.chat.completions.create(model=MODEL, messages=messages)
messages.append({"role": "assistant", "content": opinion.choices[0].message.content})

# Turn 2 resends turn 1
messages.append({"role": "user", "content": "Expand your previous answer into a short paragraph with an example."})
expanded = client.chat.completions.create(model=MODEL, messages=messages)
print(expanded.choices[0].message.content)
print(expanded.choices[0].finish_reason, expanded.usage)`,
        typescript: `${TS_CLIENT}

const messages: OpenAI.ChatCompletionMessageParam[] = [
  { role: "developer", content: "You are a concise assistant." },
  { role: "user", content: "In one sentence, name the most underrated module in the Python standard library." },
];
const opinion = await client.chat.completions.create({ model: "${M}", messages });
messages.push({ role: "assistant", content: opinion.choices[0].message.content ?? "" });
messages.push({ role: "user", content: "Expand your previous answer into a short paragraph with an example." });
const expanded = await client.chat.completions.create({ model: "${M}", messages });
console.log(expanded.choices[0].message.content, expanded.usage);`,
        curl: curl(
          "chat/completions",
          `{"model": "${M}", "messages": [{"role": "developer", "content": "You are a terse assistant. Answer in exactly one sentence, with no preamble."}, {"role": "user", "content": "Why do reasoning models use chain-of-thought?"}]}`,
        ),
      },
    },
  }),

  "cookbook/streaming-responses": demo({
    title: "Watch a stream arrive, chunk by chunk",
    blurb:
      "Run streams the recipe's request from Chat Completions and times it, showing the first chunk, the first visible token, each delta on a timeline, the final chunk with finish_reason and usage, and where a naive loop would crash, for well under a cent.",
    Component: StreamingDemo,
    props: {
      prompt: "List three uses for a hash map, one line each.",
      effort: "minimal",
      presets: [
        { label: "Hash map uses", prompt: "List three uses for a hash map, one line each." },
        { label: "Sorting algorithms", prompt: "Name two sorting algorithms." },
        { label: "Code review tip", prompt: "Give me a one-sentence tip for code review." },
        { label: "Why stream", prompt: "In two sentences, why use streaming in a chat UI?" },
      ],
    },
    agentPrompt: {
      task: "Add streaming to this project's Meta Model API chat calls: a stream_completion(messages) helper on Chat Completions (stream=True, stream_options include_usage) that renders each delta as it arrives, accumulates the full text, returns it with the usage from the final chunk, and keeps the partial text when the stream times out or the connection drops.",
      facts: [
        "Guard every chunk: skip it when choices is empty or delta.content is None. The final chunk carries finish_reason and no content, so a naive text += delta.content raises a TypeError.",
        "A stream reports usage only with stream_options={'include_usage': True}, on its last chunk: read it from whichever chunk has usage set.",
        "Muse Spark reasons before the first visible delta: expect a pause that grows with reasoning_effort.",
        "Set a client timeout and catch APITimeoutError and APIConnectionError; a retry restarts the stream from the beginning.",
      ],
      checklist: [
        "Text prints as it streams, and the returned string equals the joined deltas.",
        "Usage is printed from the final chunk.",
        "Dropping the connection mid-stream returns the partial text instead of crashing.",
      ],
      snippets: {
        python: `${pyClient([], ["APIConnectionError"])}


def stream_completion(messages):
    parts, usage = [], None
    try:
        stream = client.chat.completions.create(
            model="${M}", messages=messages, timeout=60,
            stream=True, stream_options={"include_usage": True},
        )
        for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:  # the last chunk has none
                parts.append(chunk.choices[0].delta.content)
                print(parts[-1], end="", flush=True)
            usage = chunk.usage or usage
    except APIConnectionError as exc:  # timeouts too
        print(f"\\n[cut off: {type(exc).__name__}]")
    return "".join(parts), usage


text, usage = stream_completion([{"role": "user", "content": "Name two sorting algorithms."}])
print("\\nusage:", usage)`,
        typescript: `${TS_CLIENT}

const stream = await client.chat.completions.create({
  model: "${M}",
  messages: [{ role: "user", content: "List three uses for a hash map, one line each." }],
  stream: true,
  stream_options: { include_usage: true },
});
let text = "";
for await (const chunk of stream) {
  const piece = chunk.choices[0]?.delta?.content;
  if (piece) {
    text += piece;
    process.stdout.write(piece);
  }
  if (chunk.usage) console.log("\\nusage:", chunk.usage);
}`,
        curl: curl(
          "chat/completions",
          `{"model": "${M}", "stream": true, "stream_options": {"include_usage": true}, "messages": [{"role": "user", "content": "List three uses for a hash map, one line each."}]}`,
          "-N",
        ),
      },
    },
  }),

  "cookbook/tool-function-calling": demo({
    title: "Run the tool loop on Chat Completions",
    blurb:
      "Run sends the question with the recipe's get_weather tool, runs each call the model returns here in the page, appends the results after the assistant message and loops until it answers, while two switches send the history and the tool_choice the API rejects (under a cent).",
    Component: ToolCallingDemo,
    props: {
      prompt: "Compare the temperature in Tokyo and Nairobi, then say which is warmer.",
      readings: { Paris: "18°C", Tokyo: "24°C", Nairobi: "26°C" },
      maxCalls: 5,
      presets: [
        { label: "Two cities", prompt: "Compare the temperature in Tokyo and Nairobi, then say which is warmer." },
        { label: "One city", prompt: "What's the temperature in Paris right now?" },
        { label: "Unknown city", prompt: "What's the temperature in Reykjavik right now?" },
        { label: "No tool needed", prompt: "In one sentence, what is a weather front?" },
      ],
    },
    agentPrompt: {
      task: "Add tool calling to this project on Meta Model API's Chat Completions: define get_weather(city) as a function tool and loop up to 5 turns: while the reply has tool_calls, append the assistant message, run every call and append one tool message per tool_call_id; then print the answer. Validate arguments and return an error string the model can recover from instead of raising.",
      facts: [
        "Tools nest under function: {type: function, function: {name, description, parameters}}; arguments arrive as a JSON string.",
        "Append the whole assistant message (with tool_calls) before its tool messages, or the API returns HTTP 400.",
        "One turn can hold several tool_calls: answer each by its id.",
        "tool_choice supports only auto; none, required and named choices return HTTP 400, so handle both a tool call and a plain answer.",
        "Chat Completions takes only function tools (web_search is Responses only).",
      ],
      checklist: [
        "Asking about Tokyo and Nairobi runs get_weather for both and the answer names the warmer city.",
        "A question that needs no tool gets a plain answer.",
        "The loop stops after 5 turns at most.",
      ],
      snippets: {
        python: `${pyClient(["json"])}
READINGS = {"Tokyo": "24°C", "Nairobi": "26°C"}
tools = [{"type": "function", "function": {
    "name": "get_weather", "description": "Get the current temperature for a city.",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
}}]

messages = [{"role": "user", "content": "Is Tokyo or Nairobi warmer?"}]
for _ in range(5):
    message = client.chat.completions.create(model="${M}", messages=messages, tools=tools).choices[0].message
    if not message.tool_calls:
        print(message.content)
        break
    messages.append(message)  # before its tool results
    for tc in message.tool_calls:
        city = json.loads(tc.function.arguments).get("city", "")
        messages.append({"role": "tool", "tool_call_id": tc.id, "content": READINGS.get(city, "unknown city")})`,
        typescript: `${TS_CLIENT}
const temps: Record<string, string> = { Tokyo: "24°C", Nairobi: "26°C" };
const tools = [{ type: "function" as const, function: { name: "get_weather", description: "Temperature for a city.",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }];
const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "user", content: "Is Tokyo or Nairobi warmer?" }];
for (let i = 0; i < 5; i++) {
  const [{ message }] = (await client.chat.completions.create({ model: "${M}", messages, tools })).choices;
  if (!message.tool_calls?.length) { console.log(message.content); break; }
  messages.push(message);
  for (const tc of message.tool_calls) if (tc.type === "function") messages.push({ role: "tool", tool_call_id: tc.id, content: temps[JSON.parse(tc.function.arguments).city] ?? "unknown" });
}`,
        curl: curl(
          "chat/completions",
          `{"model": "${M}", "messages": [{"role": "user", "content": "What's the temperature in Paris right now?"}], "tools": [{"type": "function", "function": {"name": "get_weather", "description": "Get the current temperature for a city.", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]}`,
        ),
      },
    },
  }),

  "cookbook/structured-output": demo({
    title: "Constrain a reply to your schema",
    blurb:
      "Run sends the recipe's product schema as response_format and checks the reply field by field, while the other tabs put the naive prompt beside the schema and send the shapes the API rejects, each request a fraction of a cent.",
    Component: TabbedDemo,
    props: {
      label: "Structured output demos",
      tabs: [
        {
          id: "schema",
          label: "Schema",
          kind: "structured",
          props: {
            protocol: "chat",
            protocols: ["chat", "responses"],
            strict: true,
            effort: "low",
            stream: false,
            presets: [
              { label: "Product (the recipe's schema)", name: "product", schema: PRODUCT_SCHEMA, prompt: KEYCHRON },
              {
                label: "Pydantic Product",
                name: "Product",
                schema: {
                  properties: {
                    name: { title: "Name", type: "string" },
                    price_usd: { title: "Price Usd", type: "number" },
                    in_stock: { title: "In Stock", type: "boolean" },
                  },
                  required: ["name", "price_usd", "in_stock"],
                  title: "Product",
                  type: "object",
                  additionalProperties: false,
                },
                prompt: "Product: Logitech MX Master 3S, $99, sold out.",
              },
              {
                label: "Closed set (enum)",
                name: "ticket",
                schema: {
                  type: "object",
                  properties: {
                    summary: { type: "string" },
                    priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
                    product_area: { type: "string", enum: ["billing", "login", "performance", "other"] },
                  },
                  required: ["summary", "priority", "product_area"],
                  additionalProperties: false,
                },
                prompt: "Ticket: since this morning nobody on our team can sign in, and we have a demo in an hour.",
              },
            ],
          },
        },
        {
          id: "naive",
          label: "Naive vs schema",
          kind: "showcase",
          props: {
            intro: "The same prompt twice: once asking for JSON in words, once with a response_format schema. Each reply goes through JSON.parse.",
            items: [
              {
                id: "naive",
                label: "JSON asked for in the prompt",
                what: "The reply is free text: often a sentence of preamble or a markdown fence around the JSON, and the parse fails.",
                path: "chat/completions",
                body: { model: M, messages: [{ role: "user", content: KEYCHRON }], reasoning_effort: "low" },
                expect: "ok",
                read: "json",
              },
              {
                id: "schema",
                label: "response_format with the schema",
                what: "Constrained decoding: the content is only the JSON object, so the parse always succeeds.",
                path: "chat/completions",
                body: {
                  model: M,
                  messages: [{ role: "user", content: KEYCHRON }],
                  response_format: { type: "json_schema", json_schema: { name: "product", schema: PRODUCT_SCHEMA } },
                  reasoning_effort: "low",
                },
                expect: "ok",
                read: "json",
              },
            ],
          },
        },
        {
          id: "rejects",
          label: "What the API rejects",
          kind: "showcase",
          props: {
            intro: "The recipe's production notes, as requests: two shapes the API refuses with a 400, and the right one for the Responses API.",
            items: [
              {
                id: "recursive",
                label: "A recursive schema",
                what: "A self-referencing $ref is rejected on both endpoints: flatten it or cap the depth.",
                path: "chat/completions",
                body: {
                  model: M,
                  messages: [{ role: "user", content: "Give a tiny org chart with a CEO and one report." }],
                  response_format: {
                    type: "json_schema",
                    json_schema: {
                      name: "org",
                      schema: {
                        $ref: "#/$defs/node",
                        $defs: {
                          node: {
                            type: "object",
                            properties: { name: { type: "string" }, reports: { type: "array", items: { $ref: "#/$defs/node" } } },
                            required: ["name", "reports"],
                            additionalProperties: false,
                          },
                        },
                      },
                    },
                  },
                },
                expect: "error",
              },
              {
                id: "response-format-on-responses",
                label: "response_format on the Responses API",
                what: "Responses takes the schema in text.format; response_format there is an unknown parameter.",
                path: "responses",
                body: {
                  model: M,
                  input: "Product: Logitech MX Master 3S, $99, sold out.",
                  response_format: { type: "json_schema", json_schema: { name: "Product", schema: PRODUCT_SCHEMA } },
                  reasoning: { effort: "low" },
                },
                expect: "error",
              },
              {
                id: "text-format",
                label: "text.format on the Responses API",
                what: "The same schema where Responses wants it: the reply parses.",
                path: "responses",
                body: {
                  model: M,
                  input: "Product: Logitech MX Master 3S, $99, sold out.",
                  text: { format: { type: "json_schema", name: "Product", schema: PRODUCT_SCHEMA } },
                  reasoning: { effort: "low" },
                },
                expect: "ok",
                read: "json",
              },
            ],
          },
        },
      ],
    },
    agentPrompt: {
      task: "Add structured output to this project's Meta Model API calls: extract a product (name, price_usd, in_stock) with Chat Completions' response_format json_schema, lock the shape with required and additionalProperties false, parse the content with json.loads (JSON.parse), and in Python also offer client.beta.chat.completions.parse with a Pydantic model. Fail loudly when a reply doesn't parse.",
      facts: [
        "Chat: response_format={'type': 'json_schema', 'json_schema': {'name': ..., 'schema': {...}}}. Responses: text={'format': {'type': 'json_schema', 'name': ..., 'schema': {...}}}.",
        "response_format sent to the Responses API returns HTTP 400 (unknown parameter).",
        "Recursive schemas (a self-referencing $ref) return HTTP 400 on both endpoints: flatten them or cap the depth.",
        "Set additionalProperties: false, list every field in required, and use enum for closed sets.",
        "JSON asked for only in the prompt often comes with prose or a markdown fence, and json.loads fails.",
      ],
      checklist: ["The product extraction parses on every run.", "A Pydantic model comes back typed on message.parsed."],
      snippets: {
        python: `import json
import os

from openai import OpenAI
from pydantic import BaseModel

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])
MODEL = "${M}"
schema = {"type": "object", "required": ["name", "price_usd", "in_stock"], "additionalProperties": False,
          "properties": {"name": {"type": "string"}, "price_usd": {"type": "number"}, "in_stock": {"type": "boolean"}}}
r = client.chat.completions.create(
    model=MODEL,
    messages=[{"role": "user", "content": "Keychron K2 specs as JSON."}],
    response_format={"type": "json_schema", "json_schema": {"name": "product", "schema": schema}},
)
print(json.loads(r.choices[0].message.content))


class Product(BaseModel):
    name: str
    price_usd: float
    in_stock: bool


ask = [{"role": "user", "content": "Logitech MX Master 3S, $99, sold out."}]
print(client.beta.chat.completions.parse(model=MODEL, messages=ask, response_format=Product).choices[0].message.parsed)`,
        typescript: `${TS_CLIENT}

const response = await client.chat.completions.create({
  model: "${M}",
  messages: [{ role: "user", content: "Product: Logitech MX Master 3S, $99, sold out." }],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "product",
      schema: {
        type: "object",
        properties: { name: { type: "string" }, price_usd: { type: "number" }, in_stock: { type: "boolean" } },
        required: ["name", "price_usd", "in_stock"],
        additionalProperties: false,
      },
    },
  },
});
const product = JSON.parse(response.choices[0].message.content ?? "");
console.log(product);`,
        curl: curl(
          "chat/completions",
          `{"model": "${M}", "messages": [{"role": "user", "content": "Product: Logitech MX Master 3S, $99, sold out."}], "response_format": {"type": "json_schema", "json_schema": {"name": "product", "schema": {"type": "object", "properties": {"name": {"type": "string"}, "price_usd": {"type": "number"}, "in_stock": {"type": "boolean"}}, "required": ["name", "price_usd", "in_stock"], "additionalProperties": false}}}}`,
        ),
      },
    },
  }),

  "cookbook/prompt-caching": demo({
    title: "Watch cached_tokens climb on a stable prefix",
    blurb:
      "Run sends the recipe's 4,500-token support prompt three times with different questions and reads cached_tokens from each reply, and switching the layout shows a request id at the top breaking every hit, about a tenth of a cent in all.",
    Component: PromptCachingDemo,
    props: { calls: 3 },
    agentPrompt: {
      task: "Restructure this project's Meta Model API requests for prompt caching: the long, stable content (instructions, examples, reference text) first as a byte-identical developer message, anything per request (ids, timestamps, the question) at the end, one stable prompt_cache_key per shared prefix, and a log of usage.prompt_tokens_details.cached_tokens / prompt_tokens for every call.",
      facts: [
        "Caching is automatic, with no flag. Matching runs from the first token forward, so one changed early token ends the match.",
        "The first request with a new prefix is a miss (cached_tokens 0); repeats reuse it. It's best effort: an early repeat can still miss.",
        "prompt_cache_key is optional: one stable key per shared prefix raises the hit rate; a key per user or session lowers it.",
        "prompt_cache_retention: in_memory (the default) or 24h, a hint for bursty traffic.",
        "On muse-spark-1.3-contributor cached input is $0.002 per million tokens against $0.10 uncached.",
      ],
      checklist: [
        "Repeated calls with the same prefix show cached_tokens close to prompt_tokens by the second or third call.",
        "Every call logs its cached ratio.",
      ],
      snippets: {
        python: `${PY_CLIENT}
rules = ("You are a support agent for the Acme Cloud platform. Be concise, cite the relevant runbook "
         "section, never invent product names, and escalate billing disputes to tier 2. ")
PREFIX = "ACME SUPPORT KNOWLEDGE BASE\\n" + rules * 120  # stable: always first


def ask(question, request_id):
    response = client.chat.completions.create(
        model="${M}",
        prompt_cache_key="acme-support-v1",
        messages=[
            {"role": "developer", "content": PREFIX},
            {"role": "user", "content": f"{question} (request {request_id})"},  # volatile parts last
        ],
    )
    u = response.usage
    cached = u.prompt_tokens_details.cached_tokens if u.prompt_tokens_details else 0
    print(f"{cached}/{u.prompt_tokens} cached")


ask("How do I reset a password?", "r1")
ask("How do I add a teammate?", "r2")`,
        typescript: `${TS_CLIENT}
const rules = "You are a support agent for the Acme Cloud platform. Be concise, cite the relevant runbook section, never invent product names, and escalate billing disputes to tier 2. ";
const PREFIX = "ACME SUPPORT KNOWLEDGE BASE\\n" + rules.repeat(120); // stable: always first

async function ask(question: string, requestId: string) {
  const { usage } = await client.chat.completions.create({
    model: "${M}",
    prompt_cache_key: "acme-support-v1",
    messages: [
      { role: "developer", content: PREFIX },
      { role: "user", content: \`\${question} (request \${requestId})\` }, // volatile parts last
    ],
  });
  console.log(\`\${usage?.prompt_tokens_details?.cached_tokens ?? 0}/\${usage?.prompt_tokens} cached\`);
}

await ask("How do I reset a password?", "r1");
await ask("How do I add a teammate?", "r2");`,
        curl: curl(
          "chat/completions",
          `{"model": "${M}", "prompt_cache_key": "acme-support-v1", "messages": [{"role": "developer", "content": "ACME SUPPORT KNOWLEDGE BASE ... (the same long text every call)"}, {"role": "user", "content": "How do I reset a password?"}]}`,
        ),
      },
    },
  }),

  "cookbook/reasoning-thinking-tokens": demo({
    title: "Set reasoning effort and see what it costs",
    blurb:
      "Run sends the recipe's question at minimal, low, medium and high effort and charts the reasoning tokens each spends, while the other tabs show where the reasoning is on each protocol and carry it across turns, each tab's run under a cent.",
    Component: ReasoningDemo,
    props: {
      questions: [
        {
          label: "The farmer",
          prompt: "A farmer has 17 sheep. All but 9 run away. He then buys 3 times as many as he has left. How many sheep does he have? Answer with just the number.",
        },
        { label: "Trivial: 12 * 8", prompt: "What is 12 * 8? Reply with just the number." },
        { label: "A prime", prompt: "Name a prime number between 10 and 20." },
      ],
    },
    agentPrompt: {
      task: "Make reasoning effort a per-call setting in this project's Meta Model API calls: default simple calls to minimal or low, reserve high for hard problems, log the reasoning tokens every call spends, and carry reasoning across turns of a multi-step flow with the Responses API's previous_response_id (or, with store false, by replaying the encrypted reasoning item).",
      facts: [
        "Chat: reasoning_effort minimal, low, medium or high (xhigh runs as high). Responses: reasoning={'effort': ...}.",
        "The string 'none' returns HTTP 400 today; Python None leaves the field out.",
        "Reasoning tokens bill as output: usage.completion_tokens_details.reasoning_tokens on Chat, usage.output_tokens_details.reasoning_tokens on Responses.",
        "Chat's reasoning_content is empty. Responses returns a reasoning item with encrypted content (replayable, not readable) and an empty summary unless reasoning.summary is 'auto'.",
        "Stateless replay: include=['reasoning.encrypted_content'] with store=False, then send that reasoning item back in the next input.",
      ],
      checklist: [
        "A sweep prints reasoning_tokens for each effort, rising with it.",
        'Turn 2 answers "why that one?" through previous_response_id.',
      ],
      snippets: {
        python: `${PY_CLIENT}
MODEL = "${M}"

question = "A farmer has 17 sheep. All but 9 run away. He then buys 3 times as many as he has left. How many sheep does he have? Answer with just the number."
for effort in ("minimal", "low", "medium", "high"):
    r = client.chat.completions.create(model=MODEL, messages=[{"role": "user", "content": question}], reasoning_effort=effort)
    print(effort, r.usage.completion_tokens_details.reasoning_tokens, "reasoning tokens:", r.choices[0].message.content)

# Turn 2 keeps turn 1's reasoning through previous_response_id
first = client.responses.create(model=MODEL, input="Suggest one Lisbon neighborhood for a 3-day trip.")
print(client.responses.create(model=MODEL, input="Why that one?", previous_response_id=first.id).output_text)`,
        typescript: `${TS_CLIENT}

for (const effort of ["minimal", "low", "medium", "high"] as const) {
  const r = await client.chat.completions.create({
    model: "${M}",
    messages: [{ role: "user", content: "What is 12 * 8? Reply with just the number." }],
    reasoning_effort: effort,
  });
  console.log(effort, r.usage?.completion_tokens_details?.reasoning_tokens, r.choices[0].message.content);
}`,
        curl: curl(
          "responses",
          `{"model": "${M}", "input": "In one sentence, why is the sky blue?", "reasoning": {"effort": "low", "summary": "auto"}, "include": ["reasoning.encrypted_content"], "store": false}`,
        ),
      },
    },
  }),

  "cookbook/vision-input": demo({
    title: "Send an image by base64 or by URL",
    blurb:
      "Run asks about the recipe's own test image sent inline as base64, and you can switch to a public URL or the recipe's three swatches, ask for a structured analysis, count the image's tokens first for free, or put the image in a developer message for the 400 (under a cent).",
    Component: VisionInputDemo,
    props: {},
    agentPrompt: {
      task: "Add image input to this project's Meta Model API calls on Chat Completions: a describe_image(image, question) helper that takes a local file (as a base64 data URL) or a public URL in an image_url part of a user message, can return a structured analysis with response_format json_schema, and first measures the image's token cost with POST /v1/responses/input_tokens.",
      facts: [
        "Content parts: [{type: text, text}, {type: image_url, image_url: {url}}], where url is https:// (the server fetches it) or data:image/png;base64,....",
        "Images go in user messages only: an image in a developer or system message returns HTTP 400.",
        "Several images can share one message, seen in the order listed (about 50 a request).",
        "jpeg, png, gif, webp or x-icon; up to 50 MB inline, 1 GiB through the Files API.",
        "input_tokens takes Responses parts (input_text, input_image with image_url) and counts for free. Image tokens grow with resolution.",
        "A URL the server can't fetch fails with a 400 (media_url_not_fetchable).",
      ],
      checklist: [
        "A red and blue test image is described correctly from base64.",
        "The same helper works with a public image URL.",
        "The token count shows what the image adds before the real call.",
      ],
      snippets: {
        python: `${pyClient(["base64"])}
MODEL = "${M}"
with open("photo.png", "rb") as f:
    url = "data:image/png;base64," + base64.b64encode(f.read()).decode()


def count_tokens(content):
    body = {"model": MODEL, "input": [{"role": "user", "content": content}]}
    return client.post("/responses/input_tokens", body=body, cast_to=object)["input_tokens"]


text = [{"type": "input_text", "text": "Describe this image."}]
print(count_tokens(text + [{"type": "input_image", "image_url": url}]) - count_tokens(text), "image tokens")

content = [{"type": "text", "text": "Describe this image in one short sentence."}, {"type": "image_url", "image_url": {"url": url}}]
r = client.chat.completions.create(model=MODEL, messages=[{"role": "user", "content": content}])
print(r.choices[0].message.content)`,
        typescript: `import { readFileSync } from "node:fs";
${TS_CLIENT}

const url = "data:image/png;base64," + readFileSync("photo.png").toString("base64");
const response = await client.chat.completions.create({
  model: "${M}",
  messages: [{ role: "user", content: [
    { type: "text", text: "Describe this image in one short sentence." },
    { type: "image_url", image_url: { url } },
  ] }],
});
console.log(response.choices[0].message.content);`,
        curl: curl(
          "chat/completions",
          `{"model": "${M}", "messages": [{"role": "user", "content": [{"type": "text", "text": "What animal is this?"}, {"type": "image_url", "image_url": {"url": "https://raw.githubusercontent.com/facebookresearch/segment-anything/main/notebooks/images/dog.jpg"}}]}]}`,
        ),
      },
    },
  }),

  "cookbook/search-grounding": demo({
    title: "Ground an answer in live web search",
    blurb:
      "Run sends the question to the Responses API with web_search on and lists the output items and the sources the searches found, for about 1 cent. Live replies carry no url_citation annotations today, so the footnotes (back to front, one number per URL) show on Meta's documented example, replayed for free.",
    Component: SearchGroundingDemo,
    props: {
      presets: [
        { label: "Fusion research", prompt: "Summarize the latest developments in nuclear fusion energy research." },
        { label: "Capital of France", prompt: "What is the capital of France?" },
        { label: "AI regulation, streamed", prompt: "What are the latest developments in AI regulation?", stream: true },
        { label: "Cite sources, high context", prompt: "Summarize recent breakthroughs in fusion energy and cite your sources.", contextSize: "high" },
      ],
    },
    agentPrompt: {
      task: "Add search-grounded answers to this project on Meta Model API's Responses API: send the question with tools=[{'type': 'web_search'}], check for web_search_call items, add [n] footnote markers from the url_citation annotations on the answer's output_text block (back to front, one number per URL) and list the sources, or the search results when there are no annotations.",
      facts: [
        "Responses API only (POST /v1/responses): Chat Completions has no web_search.",
        "output interleaves reasoning, web_search_call and message items: filter by type, and don't assume a search ran.",
        "url_citation has url, title, start_index and end_index into its output_text block's text.",
        "Live replies often carry empty annotations today: then list the sources from web_search_call results, sent when the request has include=['web_search_call.results'].",
        "search_context_size on the tool: low, medium or high. Each search costs $0.0025 plus tokens; max_tool_calls caps searches.",
      ],
      checklist: ["A recent-news question prints the answer with [n] markers and a source list.", '"What is the capital of France?" reports whether a search ran.'],
      snippets: {
        python: `${PY_CLIENT}


def render_with_footnotes(text, annotations):
    cites = [a for a in annotations if a.type == "url_citation"]
    numbers = {}
    for a in cites:
        numbers.setdefault(a.url, len(numbers) + 1)
    for a in sorted(cites, key=lambda a: a.end_index, reverse=True):
        text = text[: a.end_index] + f"[{numbers[a.url]}]" + text[a.end_index :]
    return text, list(numbers)


r = client.responses.create(model="${M}", input="What's new in AI regulation?",
                            tools=[{"type": "web_search"}], include=["web_search_call.results"])
block = [b for i in r.output if i.type == "message" for b in i.content][-1]
text, urls = render_with_footnotes(block.text, block.annotations or [])
urls = urls or [x["url"] for i in r.output for x in i.model_dump().get("results") or []]
print(text, *urls, sep="\\n")`,
        typescript: `${TS_CLIENT}
const r = await client.responses.create({
  model: "${M}",
  input: "What's new in AI regulation?",
  tools: [{ type: "web_search" }],
  include: ["web_search_call.results"],
});
console.log("searched:", r.output.some((i) => i.type === "web_search_call"));
let cited = 0;
for (const item of r.output) {
  if (item.type !== "message") continue;
  for (const block of item.content) {
    if (block.type !== "output_text") continue;
    for (const a of block.annotations) {
      if (a.type === "url_citation" && ++cited) console.log(\`"\${block.text.slice(a.start_index, a.end_index)}" -> \${a.url}\`);
    }
  }
}
// No annotations (common today): list what the searches returned instead.
for (const item of r.output) if (!cited && item.type === "web_search_call" && "results" in item) console.log(item.results);`,
        curl: curl(
          "responses",
          `{"model": "${M}", "input": "What are the latest developments in AI regulation?", "tools": [{"type": "web_search", "search_context_size": "medium"}], "include": ["web_search_call.results"]}`,
        ),
      },
    },
  }),

  "cookbook/error-handling-retry": demo({
    title: "Retry what's transient, surface the rest",
    blurb:
      "Run sends a request through the recipe's retry wrapper, with scenarios for real 400s and 404s and simulated 429s, 503s and timeouts so you see the jittered backoff and the 4xx that's never retried, while other tabs send the parameters this model rejects and step a circuit breaker (under a cent).",
    Component: RetryDemo,
    props: {
      unsupported: [
        {
          id: "n",
          label: "n=2",
          what: "n must be 1: the error names the param, and its code is null.",
          path: "chat/completions",
          body: { model: M, messages: [{ role: "user", content: "hi" }], n: 2 },
          expect: "error",
        },
        {
          id: "stop",
          label: "stop",
          what: "Stop sequences aren't supported on this reasoning model.",
          path: "chat/completions",
          body: { model: M, messages: [{ role: "user", content: "Count to five." }], stop: ["3"] },
          expect: "error",
        },
        {
          id: "logit-bias",
          label: "logit_bias",
          what: "Token biasing isn't supported either.",
          path: "chat/completions",
          body: { model: M, messages: [{ role: "user", content: "hi" }], logit_bias: { "50256": -100 } },
          expect: "error",
        },
        {
          id: "verbosity",
          label: "verbosity",
          what: "Another OpenAI parameter this model refuses.",
          path: "chat/completions",
          body: { model: M, messages: [{ role: "user", content: "hi" }], verbosity: "low" },
          expect: "error",
        },
        {
          id: "valid",
          label: "The same call, fixed",
          what: "Drop the unsupported parameter and it succeeds.",
          path: "chat/completions",
          body: { model: M, messages: [{ role: "user", content: "Say hi in one word." }], reasoning_effort: "minimal" },
          expect: "ok",
        },
      ],
    },
    agentPrompt: {
      task: "Make this project's Meta Model API client resilient: complete_with_retry retries 429, 5xx, timeouts and connection errors with capped exponential backoff and jitter and raises other 4xx at once, branching on the error's type and HTTP status, not its code; then add a circuit breaker that opens after N failures in a row and lets one trial call through after a cooldown.",
      facts: [
        "Errors look like {'error': {'message', 'type', 'param', 'code'}}; code is often null on validation errors. With the SDK, read exc.status_code and exc.body.",
        "Retry: 429 RateLimitError, 5xx APIStatusError, APITimeoutError, APIConnectionError. Don't retry: 400 BadRequestError, 401 AuthenticationError, 404 NotFoundError.",
        "This reasoning model rejects stop, n > 1, logit_bias and verbosity with HTTP 400.",
        "Replies carry x-ratelimit-remaining-requests, x-ratelimit-remaining-tokens and their x-ratelimit-limit-* pair: read them (with_raw_response in Python) and slow down before a 429.",
      ],
      checklist: [
        "n=2 raises BadRequestError after one attempt.",
        "A mocked 429 followed by success retries once, after a jittered wait.",
        "The breaker skips calls while open and closes after a successful trial.",
      ],
      snippets: {
        python: `${pyClient(["random", "time"], ["APIConnectionError", "APIStatusError"])}
MODEL = "${M}"


def complete_with_retry(messages, *, max_retries=5, **kwargs):
    for attempt in range(max_retries):
        try:
            return client.chat.completions.create(model=MODEL, messages=messages, **kwargs)
        except (APIStatusError, APIConnectionError) as exc:
            status = getattr(exc, "status_code", 500)  # a timeout has none
            if (status < 500 and status != 429) or attempt == max_retries - 1:
                raise
        time.sleep(0.5 * 2**attempt + random.uniform(0, 0.5))


raw = client.chat.completions.with_raw_response.create(model=MODEL, messages=[{"role": "user", "content": "Hi"}])
print(raw.headers.get("x-ratelimit-remaining-requests"))`,
        typescript: `${TS_CLIENT}

export async function completeWithRetry(messages: OpenAI.ChatCompletionMessageParam[], maxRetries = 5) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.chat.completions.create({ model: "${M}", messages });
    } catch (err) {
      const status = err instanceof OpenAI.APIError ? err.status : undefined;
      const retryable = status === undefined || status === 429 || status >= 500;
      if (!retryable || attempt === maxRetries - 1) throw err; // another 4xx: fix the request
      await new Promise((r) => setTimeout(r, (0.5 * 2 ** attempt + Math.random() * 0.5) * 1000));
    }
  }
}`,
        curl: curl("chat/completions", `{"model": "${M}", "messages": [{"role": "user", "content": "hi"}], "n": 2}`),
      },
    },
  }),

  "cookbook/basic-agent-loop": demo({
    title: "Run the agent loop on a project with failing tests",
    blurb:
      "Run lets Muse Spark fix a planted bug through read_file, write_file and run_tests tools, one tool per turn, with the recipe's trace, its guards and the diff, while the tests run in your browser as the oracle, for a few tenths of a cent a run.",
    Component: AgentLoopDemo,
    props: { project: "agent-loop-target", variant: "loop", effort: "low", maxTurns: 15, tokenBudget: 120_000 },
    agentPrompt: {
      task: "Build the perceive-decide-act loop in this project on Meta Model API's Responses API: list_files, read_file, write_file and run_tests tools, one tool call per turn (parallel_tool_calls false), each call run locally and sent back with previous_response_id, until the model answers or a guard fires: a turn cap, a token budget, or one (tool, arguments) three times. Print a THINK, ACT, RESULT, EVAL trace, then run the tests yourself.",
      facts: [
        "Each turn: POST /v1/responses with input [{type: function_call_output, call_id, output}] and previous_response_id; instructions and tools don't carry over, so resend them.",
        "Muse Spark often adds a one-line narration message beside its function_call: a good THINK line.",
        "Every tool returns text, errors included (a missing file, an unknown tool), so the model can recover.",
        "Stop at the turn cap, the token budget, or the third repeat of one (tool_name, arguments). Only done counts, and only when the tests pass.",
      ],
      checklist: [
        "On a repo with one failing test, the loop reads, edits, runs the tests and stops with them passing.",
        "Forcing the same call three times stops the loop with a stuck message.",
      ],
      snippets: {
        python: `import json


def loop(client, task, tools, run_tool, max_turns=15, token_budget=120_000):
    opts = {"model": "${M}", "tools": tools, "parallel_tool_calls": False}
    r, seen, used = client.responses.create(input=task, **opts), [], 0
    for turn in range(1, max_turns + 1):
        used += r.usage.total_tokens
        call = next((i for i in r.output if i.type == "function_call"), None)
        if call is None:
            return r.output_text
        seen.append((call.name, call.arguments))
        if seen.count(seen[-1]) >= 3 or used >= token_budget:
            raise RuntimeError(f"guard fired on turn {turn}")
        out = run_tool(call.name, json.loads(call.arguments))
        item = {"type": "function_call_output", "call_id": call.call_id, "output": out}
        r = client.responses.create(previous_response_id=r.id, input=[item], **opts)
    raise RuntimeError("turn cap reached")`,
        typescript: `import type OpenAI from "openai";

export async function loop(client: OpenAI, task: string, tools: OpenAI.Responses.Tool[], runTool: (name: string, args: unknown) => Promise<string>) {
  const opts = { model: "${M}", tools, parallel_tool_calls: false };
  let r = await client.responses.create({ ...opts, input: task });
  const seen: Record<string, number> = {};
  for (let turn = 1; turn <= 15; turn++) {
    const call = r.output.find((o) => o.type === "function_call");
    if (!call) return r.output_text;
    const key = call.name + call.arguments;
    if ((seen[key] = (seen[key] ?? 0) + 1) >= 3) throw new Error(\`stuck: \${call.name}\`);
    const output = await runTool(call.name, JSON.parse(call.arguments));
    r = await client.responses.create({ ...opts, previous_response_id: r.id, input: [{ type: "function_call_output", call_id: call.call_id, output }] });
  }
  throw new Error("turn cap reached");
}`,
        curl: curl(
          "responses",
          `{"model": "${M}", "parallel_tool_calls": false, "input": "tests/test_pagination.py is failing. Read it and the implementation, fix the bug so the test passes, then run the tests.", "tools": [{"type": "function", "name": "read_file", "description": "Read a file.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}]}`,
        ),
      },
    },
  }),

  "cookbook/interleaved-reasoning-tool-use": demo({
    title: "Reason, act, observe: a migration in dependency order",
    blurb:
      "Run has Muse Spark migrate a small callback-style app to async/await, reasoning before each tool call, with the reasoning tokens every turn spends and the tests and a callback check as the oracle, and running it again at another effort compares the two, about a cent a run.",
    Component: AgentLoopDemo,
    props: { project: "callback-target", variant: "interleaved", effort: "high", summary: true, maxTurns: 25, tokenBudget: 240_000 },
    agentPrompt: {
      task: "Add interleaved reasoning to this project's agent on Meta Model API's Responses API: set the reasoning effort per task (high for multi-file or ordered changes, minimal for mechanical ones), log each turn's reasoning tokens and summary beside the tool call it led to, and check every change with the typecheck and tests before the next, feeding errors back.",
      facts: [
        "reasoning={'effort': 'minimal' | 'low' | 'medium' | 'high', 'summary': 'auto'}; summaries can be empty on tool-call turns.",
        "Each turn's thinking is usage.output_tokens_details.reasoning_tokens.",
        "A turn runs reasoning, then a function_call; your harness runs it and returns function_call_output (text, errors included) with previous_response_id.",
        "Too low an effort can take more turns end to end: measure whole runs, not single calls.",
        "Migrate leaf functions first; when a function becomes async, update every caller, or the build breaks.",
      ],
      checklist: [
        "The trace prints the reasoning tokens, then the action, for every turn.",
        "Runs at minimal and high effort are compared on turns and total tokens.",
      ],
      snippets: {
        python: `import json


def run(client, task, tools, run_tool, effort="high", max_turns=25):
    opts = {"model": "${M}", "tools": tools, "reasoning": {"effort": effort, "summary": "auto"}}
    r = client.responses.create(input=task, **opts)
    for turn in range(1, max_turns + 1):
        calls = [i for i in r.output if i.type == "function_call"]
        thought = " ".join(s.text for i in r.output if i.type == "reasoning" for s in i.summary)
        tokens = r.usage.output_tokens_details.reasoning_tokens
        print(f"turn {turn}: thought ({tokens} tok) {thought[:80]} -> {[c.name for c in calls]}")
        if not calls:
            return r.output_text
        outputs = [{"type": "function_call_output", "call_id": c.call_id,
                    "output": run_tool(c.name, json.loads(c.arguments))} for c in calls]
        r = client.responses.create(previous_response_id=r.id, input=outputs, **opts)
    raise RuntimeError("turn cap reached")`,
        typescript: `import type OpenAI from "openai";

type RunTool = (name: string, args: unknown) => Promise<string>;

export async function run(client: OpenAI, task: string, tools: OpenAI.Responses.Tool[], runTool: RunTool, effort: OpenAI.ReasoningEffort = "high") {
  const opts = { model: "${M}", tools, reasoning: { effort, summary: "auto" as const } };
  let r = await client.responses.create({ ...opts, input: task });
  for (let turn = 1; turn <= 25; turn++) {
    const calls = r.output.filter((o) => o.type === "function_call");
    console.log(turn, r.usage?.output_tokens_details.reasoning_tokens, calls.map((c) => c.name));
    if (!calls.length) return r.output_text;
    const input = [];
    for (const c of calls) input.push({ type: "function_call_output" as const, call_id: c.call_id, output: await runTool(c.name, JSON.parse(c.arguments)) });
    r = await client.responses.create({ ...opts, previous_response_id: r.id, input });
  }
  throw new Error("turn cap reached");
}`,
        curl: curl(
          "responses",
          `{"model": "${M}", "reasoning": {"effort": "high", "summary": "auto"}, "input": "Migrate src/lib/callbackUtils.js retry() to async/await. Read what you need first.", "tools": [{"type": "function", "name": "read_file", "description": "Read a file.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}]}`,
        ),
      },
    },
  }),

  "cookbook/multi-turn-context-management": demo({
    title: "Grow a task over turns and keep its context in check",
    blurb:
      "Run plays the recipe's growing task (an initial spec, three requirement changes, then a check of every decision) under the strategy you pick, full history, a sliding window, the model's own STATE.md or compaction, showing what each turn sent and its input tokens, about a tenth of a cent in all.",
    Component: ContextDemo,
    props: {
      instructions: CONTEXT_INSTRUCTIONS,
      script: [
        {
          label: "Initial spec",
          content:
            "Initial spec: design the first version. Config validation, a backend pool, a streaming reverse proxy, round-robin and least-connections balancing, health checks and a circuit breaker. Give the plan and the file map.",
        },
        { label: "Change 1: hierarchical backends", content: "Requirement change 1: backends become hierarchical, so a pool can contain sub-pools. Update the design and say which files change." },
        {
          label: "Change 2: async and cancellable",
          content: "Requirement change 2: all backend I/O and health checks become fully async and cancellable with AbortSignal. Update the design and list every file it ripples into.",
        },
        {
          label: "Change 3: multi-tenant",
          content: "Requirement change 3: the proxy becomes multi-tenant. A tenant context threads through config, pool, router, balancers, rate limiting, metrics and logging. Update the design.",
        },
        {
          label: "Coherence check",
          content: "Coherence check: list every key decision so far, one line each, and name the requirement change (or the initial spec) that introduced it.",
        },
      ],
    },
    agentPrompt: {
      task: "Keep this project's long agent runs coherent on Meta Model API: have the model keep a STATE.md (goal, key decisions, task graph with status, file map, current step, open questions), update it after every task and consult it before each, re-read a file before editing it after a few turns, and near a declared limit compact older turns into a summary note, keeping the system prompt and newest turns verbatim.",
      facts: [
        "Muse Spark's window is 1,048,576 tokens, shared by input and output. Track usage.prompt_tokens per turn.",
        "Give requirement changes one at a time, each after the last is green, so the model refactors instead of pre-planning.",
        "STATE.md's file map tells the model which files a change touches, so it re-reads only those.",
        "A sliding window forgets old turns; compaction keeps the goal, files and plan in a note. OpenCode's Meta provider declares Muse Spark's window, so it compacts near it, or at a smaller limit.context.",
      ],
      checklist: [
        "After three requirement changes, the model still lists every key decision, from STATE.md.",
        "Per-turn input tokens grow far slower with the running state than with the full history.",
      ],
      snippets: {
        python: `${PY_CLIENT}
INSTRUCTIONS = (
    "Keep STATE.md as your working memory (goal, decisions, task graph, file map, current step, "
    "open questions). Update it after every task and end every reply with it in a fenced block."
)
state = ""


def turn(user_message):
    global state
    messages = [{"role": "developer", "content": INSTRUCTIONS}]
    if state:
        messages.append({"role": "developer", "content": "Current STATE.md:\\n" + state})
    messages.append({"role": "user", "content": user_message})
    reply = client.chat.completions.create(model="${M}", messages=messages)
    text = reply.choices[0].message.content
    if "\`\`\`" in text:
        state = text.split("\`\`\`")[-2].split("\\n", 1)[-1]
    print("prompt tokens:", reply.usage.prompt_tokens)
    return text`,
        typescript: `${TS_CLIENT}

let state = "";
async function turn(user: string) {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "developer", content: "Maintain STATE.md as your working memory and end every reply with the full STATE.md in a fenced block." },
    ...(state ? [{ role: "developer" as const, content: \`Current STATE.md:\\n\${state}\` }] : []),
    { role: "user", content: user },
  ];
  const reply = await client.chat.completions.create({ model: "${M}", messages });
  const text = reply.choices[0].message.content ?? "";
  state = /\`\`\`[^\\n]*\\n([\\s\\S]*?)\`\`\`/.exec(text)?.[1] ?? state;
  console.log("prompt tokens:", reply.usage?.prompt_tokens);
  return text;
}`,
        curl: curl(
          "chat/completions",
          `{"model": "${M}", "messages": [{"role": "developer", "content": "Maintain STATE.md as your working memory..."}, {"role": "developer", "content": "Current STATE.md: ..."}, {"role": "user", "content": "Requirement change 1: backends become hierarchical."}]}`,
        ),
      },
    },
  }),

  "cookbook/search-and-replace-edits": demo({
    title: "Exact-match edits, applied and checked",
    blurb:
      "Run sends one of the recipe's six prompts with segment-anything's files, and the page applies each edit or write call the model returns only when oldString matches exactly once, shows the diff and sends rejections back for a retry, with hand-made broken edits for each failure mode (under a cent).",
    Component: EditsDemo,
    props: {},
    agentPrompt: {
      task: "Add search-and-replace edits to this project's coding agent on Meta Model API: an edit tool (filePath, oldString, newString, optional replaceAll) applied only when oldString matches the file exactly once, a write tool for new files only, rejections sent back as the tool output (with the current file) so the model can retry, and a compile and lint check after each applied edit.",
      facts: [
        "Zero matches means a misquote (often whitespace); more than one is ambiguous: reject both and ask for more context, unless replaceAll is set on purpose.",
        "Re-read a file before editing it, so oldString comes from the current bytes.",
        "An insertion at the top of a file is an edit anchored on its first lines; write over an existing file discards it.",
        "Applying cleanly isn't correct: run py_compile and flake8 (or your build) after each edit, feeding errors back.",
        "Edits are function tools on POST /v1/responses; one turn can carry several.",
      ],
      checklist: [
        "An oldString that matches twice is rejected with its reason, and the retry applies.",
        "Each applied edit prints a unified diff, then the checks run.",
      ],
      snippets: {
        python: `from pathlib import Path

EDIT_TOOL = {
    "type": "function", "name": "edit",
    "description": "Replace oldString with newString; oldString must match the file exactly once.",
    "parameters": {"type": "object", "required": ["filePath", "oldString", "newString"], "properties": {
        "filePath": {"type": "string"}, "oldString": {"type": "string"},
        "newString": {"type": "string"}, "replaceAll": {"type": "boolean"}}},
}


def apply_edit(path, old, new, replace_all=False):
    text = Path(path).read_text()
    count = text.count(old)
    if count == 0:
        return f"Rejected: oldString isn't in {path}. Copy it exactly, whitespace included."
    if count > 1 and not replace_all:
        return f"Rejected: oldString matches {count} times. Add surrounding lines or set replaceAll."
    if old == new:
        return "Rejected: newString is the same as oldString."
    Path(path).write_text(text.replace(old, new, -1 if replace_all else 1))
    return f"Applied to {path}."`,
        typescript: `import { readFileSync, writeFileSync } from "node:fs";

export function applyEdit(path: string, oldString: string, newString: string, replaceAll = false): string {
  const text = readFileSync(path, "utf8");
  const count = text.split(oldString).length - 1;
  if (count === 0) return \`Rejected: oldString matches 0 times in \${path}. Copy it exactly.\`;
  if (count > 1 && !replaceAll) return \`Rejected: oldString matches \${count} times. Add context or set replaceAll.\`;
  if (oldString === newString) return "Rejected: newString is the same as oldString.";
  writeFileSync(path, replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString));
  return \`Applied the edit to \${path}.\`;
}`,
        curl: curl(
          "responses",
          `{"model": "${M}", "instructions": "Edit files with the edit tool: oldString must match exactly once.", "input": "In segment_anything/build_sam.py, change image_size in _build_sam from 1024 to 512. ...the file...", "tools": [{"type": "function", "name": "edit", "description": "Replace oldString with newString; oldString must match exactly once.", "parameters": {"type": "object", "properties": {"filePath": {"type": "string"}, "oldString": {"type": "string"}, "newString": {"type": "string"}}, "required": ["filePath", "oldString", "newString"]}}]}`,
        ),
      },
    },
  }),

  "cookbook/long-context": demo({
    title: "Measure, price and fit a long request",
    blurb:
      "Count a long document (Alice, chapters 1 to 3, or the recipe's stand-in, up to 64 copies) with input_tokens for free, see its cost and window share before sending, then send it, while other tabs compare full text and summary, trim a conversation, and go past the window for the 400 (one copy costs about a tenth of a cent).",
    Component: LongContextDemo,
    props: {},
    agentPrompt: {
      task: "Add context budgeting to this project's Meta Model API calls: count every large or variable request with POST /v1/responses/input_tokens first, refuse or compact it when input plus planned output passes 1,048,576 tokens, estimate its cost, and cap conversations with a sliding window that keeps the instruction messages and drops the oldest turns (or summarizes them when they still matter).",
      facts: [
        "input_tokens takes a Responses body (model, input) and returns {'input_tokens': n} without generating. With the OpenAI SDK: client.post('/responses/input_tokens', body=..., cast_to=object).",
        "Input and the requested output share the 1,048,576-token window; over it is HTTP 400 context_length_exceeded.",
        "Send full text when exact wording matters (code, contracts), a summary when the gist is enough.",
        "muse-spark-1.3-contributor input costs $0.10 per million tokens.",
      ],
      checklist: [
        "A large request prints its token count and estimated cost before it's sent.",
        "An oversized request is caught before sending instead of failing with a 400.",
        "trim_history keeps the developer message and the newest turns.",
      ],
      snippets: {
        python: `${PY_CLIENT}
MODEL, WINDOW = "${M}", 1_048_576


def count_input_tokens(text):
    body = {"model": MODEL, "input": text}
    return client.post("/responses/input_tokens", body=body, cast_to=object)["input_tokens"]


def ask_long(text, max_output=4_000):
    tokens = count_input_tokens(text)
    print(f"{tokens:,} input tokens, about \${tokens * 0.10 / 1e6:.4f}")
    if tokens + max_output > WINDOW:
        raise ValueError("Too long: trim or summarize first.")
    return client.chat.completions.create(model=MODEL, messages=[{"role": "user", "content": text}], max_completion_tokens=max_output)


def trim_history(messages, max_messages=8):
    keep = [m for m in messages if m["role"] in ("developer", "system")]
    turns = [m for m in messages if m not in keep]
    return keep + turns[max(0, len(turns) - max_messages + len(keep)):]`,
        typescript: `${TS_CLIENT}
const WINDOW = 1_048_576;
// The recipe's stand-in for a large file: one paragraph, 800 times.
const document = "The service uses a sharded datastore with async replication. ".repeat(800);
const counted = (await client.post("/responses/input_tokens", {
  body: { model: "${M}", input: document },
})) as { input_tokens: number };
if (counted.input_tokens + 4_000 > WINDOW) throw new Error("Too long for the window: trim or summarize first.");
console.log(\`\${counted.input_tokens} tokens, about $\${((counted.input_tokens * 0.1) / 1e6).toFixed(4)} of input\`);`,
        curl: curl("responses/input_tokens", `{"model": "${M}", "input": "The service uses a sharded datastore with async replication. ..."}`),
      },
    },
  }),
};
