import { acmePrefix } from "@/components/docs/playgrounds/cookbook-fundamentals/caching";
import { standInDocument } from "@/components/docs/playgrounds/cookbook-fundamentals/long-context";
import { RECIPE_TEST_IMAGE } from "@/components/docs/playgrounds/cookbook-fundamentals/vision";

/**
 * The cookbook's recipes, as the cookbook pages list them (cookbook, cookbook/api-fundamentals,
 * cookbook/agent-patterns), each with its core call: the one request at the heart of the recipe, small enough to run
 * from the recipe browser through the live docs. Muse Code and open-weight recipes run on your machine, so they carry
 * the command to start with instead (and, where it helps, the same prompt on hosted Muse Spark). Text calls use
 * muse-spark-1.3-contributor, the docs' default (muse-spark-1.3 itself never runs here).
 */

export type RecipeKind = "api" | "muse-code" | "open-weights";

/** A docs sample dropped into the body before sending, as a data URL at a JSON Pointer. */
export interface SampleFill {
  pointer: string;
  sampleId: string;
}

/** A multipart field: a text value, or a docs sample as the file. */
export interface FormPart {
  name: string;
  value?: string;
  sampleId?: string;
}

export interface CoreCall {
  /** What Run does, in a few words. */
  label: string;
  /** Meta's path, without /v1. */
  path: string;
  body?: Record<string, unknown>;
  fills?: SampleFill[];
  form?: FormPart[];
  /** Read the reply as server-sent events. */
  stream?: boolean;
  /** What it costs, when that's over a cent. */
  cost?: string;
  /** What to look at in the reply. */
  look: string;
}

export interface Recipe {
  slug: string;
  title: string;
  /** The recipe's line on the cookbook page. */
  summary: string;
  kind: RecipeKind;
  call?: CoreCall;
  /** The command to start with, for recipes that run on your machine. */
  command?: string;
  /** Where it runs, for recipes that aren't an API call. */
  where?: string;
}

export interface RecipeSection {
  id: string;
  /** "Meta Model API" or "Open-weight models", the cookbook page's two halves. */
  group: string;
  title: string;
  blurb: string;
  recipes: Recipe[];
}

const SPARK = "muse-spark-1.3-contributor";

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current temperature for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name, such as Paris." } },
      required: ["city"],
    },
  },
};

const PRODUCT_FORMAT = {
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
};

const FARMER =
  "A farmer has 17 sheep. All but 9 run away. He then buys 3 times as many as he has left. How many sheep does he have? Answer with just the number.";

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
  type: "function",
  name,
  description,
  parameters: { type: "object", properties, required, additionalProperties: false },
});

const PATH_PARAM = { path: { type: "string", description: "Path from the project root." } };

const CONTEXT_PROMPT = `You are the engineer on a new HTTP reverse proxy + load balancer. Build it in
TypeScript using only Node.js built-in modules plus the existing vitest tooling.
Work one task at a time and keep the full test suite green.

- Maintain and actively leverage STATE.md as your working memory: the goal, key
  decisions, a task graph with status, the files each task touches, the current
  step, and open questions. Update it after every task and consult it before each.
- Before editing a file you last read more than a couple of turns ago, re-read it
  in full from disk.
- When a change ripples, update every affected module and its tests.`;

const BUILD_SAM_EXCERPT = `def _build_sam(
    encoder_embed_dim,
    encoder_depth,
    encoder_num_heads,
    encoder_global_attn_indexes,
    checkpoint=None,
):
    prompt_embed_dim = 256
    image_size = 1024
    vit_patch_size = 16
    image_embedding_size = image_size // vit_patch_size`;

const ALERTS = [
  "2026-10-20 02:14 checkout-api p95 latency > 2s (owner: alex, recurring)",
  "2026-10-20 03:02 payments-worker queue depth > 5k (owner: alex, recurring)",
  "2026-10-21 02:41 inventory-sync job failed (owner: alex, recurring)",
  "2026-10-21 14:10 marketing-site 404 spike (owner: sam, one-off)",
  "2026-10-22 02:55 checkout-api p95 latency > 2s (owner: alex, recurring)",
  "2026-10-22 09:30 pos-printer offline at store 12 (owner: jo, silenced)",
  "2026-10-23 03:20 payments-worker queue depth > 5k (owner: alex, recurring)",
  "2026-10-24 02:08 inventory-sync job failed (owner: alex, recurring)",
].join("\n");

const PROBE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "alert_probe",
    strict: true,
    schema: {
      type: "object",
      properties: {
        patterns: {
          type: "array",
          items: {
            type: "object",
            properties: { text: { type: "string" }, salience: { type: "string", enum: ["high", "medium", "low"] } },
            required: ["text", "salience"],
            additionalProperties: false,
          },
        },
        refined_purpose: {
          type: "object",
          properties: { statement: { type: "string" }, rationale: { type: "string" } },
          required: ["statement", "rationale"],
          additionalProperties: false,
        },
        signals: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, kind: { type: "string", enum: ["north-star", "leading"] } },
            required: ["name", "kind"],
            additionalProperties: false,
          },
        },
      },
      required: ["patterns", "refined_purpose", "signals"],
      additionalProperties: false,
    },
  },
};

const chatImage = (text: string) => [{ role: "user", content: [{ type: "text", text }, { type: "image_url", image_url: { url: "" } }] }];
const IMAGE_AT = "/messages/0/content/1/image_url/url";
const responsesImage = (text: string) => [{ role: "user", content: [{ type: "input_text", text }, { type: "input_image", image_url: "" }] }];
const RESPONSES_IMAGE_AT = "/input/0/content/1/image_url";

const MUSE_CODE_WHERE = "Runs in Muse Code, the CLI, on your machine: there's no single API call to try here. Install it with curl -fsSL https://dev.meta.ai/install.sh | sh.";

/** A Muse Code recipe. `before` says what the recipe sets up before its command, when the command needs that. */
function museCode(slug: string, title: string, summary: string, command: string, before?: string): Recipe {
  return { slug, title, summary, kind: "muse-code", command, where: before ? `${MUSE_CODE_WHERE} ${before}` : MUSE_CODE_WHERE };
}

export const RECIPE_SECTIONS: readonly RecipeSection[] = [
  {
    id: "api-fundamentals",
    group: "Meta Model API",
    title: "API fundamentals",
    blurb: "Validate one building block at a time and walk away with a starter you can extend.",
    recipes: [
      {
        slug: "cookbook/quickstart-chat-completions",
        title: "Quickstart: chat completions",
        summary: "Point the OpenAI SDK at a new base URL and make your first Muse Spark call.",
        kind: "api",
        call: {
          label: "Your first completion: a model and a messages array",
          path: "chat/completions",
          body: { model: SPARK, messages: [{ role: "user", content: "In two sentences, what is the Meta Model API?" }], reasoning_effort: "minimal" },
          look: "choices[0].message.content, finish_reason and usage: the three fields the recipe reads first.",
        },
      },
      {
        slug: "cookbook/streaming-responses",
        title: "Streaming responses",
        summary: "Stream tokens as they generate and read usage in the final chunk.",
        kind: "api",
        call: {
          label: "Stream a reply and read usage from the final chunk",
          path: "chat/completions",
          body: {
            model: SPARK,
            messages: [{ role: "user", content: "List three uses for a hash map, one line each." }],
            stream: true,
            stream_options: { include_usage: true },
            reasoning_effort: "minimal",
          },
          stream: true,
          look: "The Events tab: chat.completion.chunk deltas, then a chunk with finish_reason and usage, then [DONE].",
        },
      },
      {
        slug: "cookbook/tool-function-calling",
        title: "Tool and function calling",
        summary: "Detect a tool call, execute it, and feed the result back into the loop.",
        kind: "api",
        call: {
          label: "Offer get_weather and get a tool call back",
          path: "chat/completions",
          body: { model: SPARK, messages: [{ role: "user", content: "What's the temperature in Paris right now?" }], tools: [WEATHER_TOOL], reasoning_effort: "low" },
          look: 'finish_reason is tool_calls, and message.tool_calls asks for get_weather with {"city": "Paris"} as a JSON string.',
        },
      },
      {
        slug: "cookbook/structured-output",
        title: "Structured output",
        summary: "Return JSON that matches your schema and parses on the first try.",
        kind: "api",
        call: {
          label: "Constrain the reply to the recipe's product schema",
          path: "chat/completions",
          body: {
            model: SPARK,
            messages: [
              {
                role: "user",
                content: "Describe the Keychron K2 in one sentence, then give its specs as JSON with keys name, price_usd, and in_stock.",
              },
            ],
            response_format: PRODUCT_FORMAT,
            reasoning_effort: "low",
          },
          look: "The content is bare JSON with name, price_usd and in_stock, so it parses every time.",
        },
      },
      {
        slug: "cookbook/prompt-caching",
        title: "Prompt caching",
        summary: "Reuse a stable prompt prefix and measure cached tokens.",
        kind: "api",
        call: {
          label: "Send the recipe's 4,500-token prefix (run it twice or three times)",
          path: "chat/completions",
          body: {
            model: SPARK,
            messages: [
              { role: "developer", content: acmePrefix() },
              { role: "user", content: "How do I reset a password?" },
            ],
            prompt_cache_key: "docs-cookbook-acme-support",
            reasoning_effort: "minimal",
          },
          look: "usage.prompt_tokens_details.cached_tokens: 0 while the prefix is cold, close to prompt_tokens once a repeat hits the cache.",
        },
      },
      {
        slug: "cookbook/reasoning-thinking-tokens",
        title: "Reasoning and thinking tokens",
        summary: "Set reasoning effort and replay reasoning across turns.",
        kind: "api",
        call: {
          label: "The recipe's farmer question at low effort",
          path: "chat/completions",
          body: { model: SPARK, messages: [{ role: "user", content: FARMER }], reasoning_effort: "low" },
          look: "usage.completion_tokens_details.reasoning_tokens: thinking billed as output that never shows in the text.",
        },
      },
      {
        slug: "cookbook/vision-input",
        title: "Vision input",
        summary: "Send images by URL or base64 and get structured analysis back.",
        kind: "api",
        call: {
          label: "The recipe's red and blue test image, inline as base64",
          path: "chat/completions",
          body: {
            model: SPARK,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Describe this image in one short sentence." },
                  { type: "image_url", image_url: { url: RECIPE_TEST_IMAGE } },
                ],
              },
            ],
            reasoning_effort: "minimal",
          },
          look: "An image_url part inside a user message; prompt_tokens includes what the image cost.",
        },
      },
      {
        slug: "cookbook/long-context",
        title: "Long context",
        summary: "Pack repo-scale context into a single context window.",
        kind: "api",
        call: {
          label: "Count the recipe's stand-in document before sending it (free)",
          path: "responses/input_tokens",
          body: { model: SPARK, input: standInDocument() },
          look: "input_tokens: about 9,000 of the 1,048,576-token window. Counting generates nothing.",
        },
      },
      {
        slug: "cookbook/error-handling-retry",
        title: "Error handling and retry",
        summary: "Back off with jitter and skip retries on client errors.",
        kind: "api",
        call: {
          label: "Send n=2, a malformed request, and read the error envelope",
          path: "chat/completions",
          body: { model: SPARK, messages: [{ role: "user", content: "hi" }], n: 2 },
          look: "HTTP 400 with error.type invalid_request_error, param n and code null: branch on type and status, and don't retry it.",
        },
      },
      {
        slug: "cookbook/search-grounding",
        title: "Search grounding",
        summary: "Ground answers in live web search with inline citations.",
        kind: "api",
        call: {
          label: "Ask about AI regulation with web_search on (two searches at most)",
          path: "responses",
          body: {
            model: SPARK,
            input: "What are the latest developments in AI regulation? Answer in three short bullet points.",
            tools: [{ type: "web_search" }],
            include: ["web_search_call.results"],
            max_tool_calls: 2,
            reasoning: { effort: "low" },
          },
          cost: "About 1 cent: each search is $0.0025, plus the tokens the results add.",
          look: "output interleaves reasoning, web_search_call and message items; citations come as url_citation annotations when the model attaches them.",
        },
      },
    ],
  },
  {
    id: "agent-patterns",
    group: "Meta Model API",
    title: "Agent patterns",
    blurb: "Turn a model into an agent. These loops handle planning, self-correction, and staying coherent across long runs.",
    recipes: [
      {
        slug: "cookbook/basic-agent-loop",
        title: "Basic agent loop",
        summary: "Wire up the core perceive-decide-act loop.",
        kind: "api",
        call: {
          label: "Turn 1 of the loop: the model reads before it acts",
          path: "responses",
          body: {
            model: SPARK,
            instructions: "You are a coding agent. Each turn: think, call exactly one tool, read the result, then decide whether the task is done.",
            input: "tests/test_pagination.js is failing. Read it and the implementation, fix the bug so the test passes, then run: run_tests tests/test_pagination.js",
            tools: [
              fn("read_file", "Read a file from the project.", PATH_PARAM, ["path"]),
              fn("write_file", "Replace a file's whole content.", { ...PATH_PARAM, content: { type: "string" } }, ["path", "content"]),
              fn("run_tests", "Run one test file, or every test.", { path: { type: "string" } }, []),
            ],
            parallel_tool_calls: false,
            reasoning: { effort: "low" },
          },
          look: "One function_call (read_file of the test) and a line of narration. The recipe's page runs the whole loop on a real project.",
        },
      },
      {
        slug: "cookbook/interleaved-reasoning-tool-use",
        title: "Interleaved reasoning and tool use",
        summary: "Interleave reasoning with tool calls in a single turn.",
        kind: "api",
        call: {
          label: "High effort: reasoning first, then the tool call it leads to",
          path: "responses",
          body: {
            model: SPARK,
            input:
              "In src/lib/callbackUtils.js, migrate the retry function from error-first callbacks to async/await. Start by reading what you need.",
            tools: [fn("read_file", "Read a file from the project.", PATH_PARAM, ["path"]), fn("grep", "Find lines containing some text.", { pattern: { type: "string" } }, ["pattern"])],
            reasoning: { effort: "high", summary: "auto" },
          },
          look: "A reasoning item (counted in usage's reasoning_tokens) comes before the function_call: the action follows from the reasoning.",
        },
      },
      {
        slug: "cookbook/multi-turn-context-management",
        title: "Multi-turn context management",
        summary: "Keep context under control across a long agent run.",
        kind: "api",
        call: {
          label: "The recipe's initial prompt: start the running state (STATE.md)",
          path: "chat/completions",
          body: {
            model: SPARK,
            messages: [
              { role: "developer", content: CONTEXT_PROMPT },
              { role: "user", content: "Start: write the first STATE.md for this project. Don't write code yet. Keep it under 250 words." },
            ],
            reasoning_effort: "low",
          },
          look: "The goal, key decisions, task graph, file map, current step and open questions: the working memory the model re-reads instead of the whole history.",
        },
      },
      {
        slug: "cookbook/search-and-replace-edits",
        title: "Search-and-replace edits",
        summary: "Make exact-match file edits that stay reviewable.",
        kind: "api",
        call: {
          label: "Task 1: change image_size from 1024 to 512 with one edit call",
          path: "responses",
          body: {
            model: SPARK,
            instructions:
              "Edit files with the edit tool: oldString must be the exact current text and match exactly once, so quote enough surrounding lines to make it unique. Use write only for new files.",
            input: `In segment_anything/build_sam.py, change the SAM input image size in _build_sam from 1024 to 512. Make a precise in-place edit; do not rewrite the file.\n\nsegment_anything/build_sam.py (excerpt):\n${BUILD_SAM_EXCERPT}`,
            tools: [
              fn("edit", "Replace oldString with newString in a file. oldString must match exactly once.", { filePath: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } }, ["filePath", "oldString", "newString"]),
              fn("write", "Create a new file.", { filePath: { type: "string" }, content: { type: "string" } }, ["filePath", "content"]),
            ],
            reasoning: { effort: "low" },
          },
          look: "An edit call whose oldString quotes the lines around image_size = 1024, so it matches once and the diff stays one line.",
        },
      },
      {
        slug: "cookbook/alert-fatigue-copilot",
        title: "Alert fatigue copilot",
        summary: "Pull grounded patterns from noisy alerts, then probe, chat, and self-assess with strict JSON.",
        kind: "api",
        call: {
          label: "The probe turn: patterns, a refined purpose and signals as strict JSON",
          path: "chat/completions",
          body: {
            model: SPARK,
            messages: [
              { role: "developer", content: "You triage alerts for the fictional BrewBean POS SRE team. Ground every pattern in the alerts given. Do not act on real systems." },
              { role: "user", content: `Alerts:\n${ALERTS}\n\nExtract the patterns with salience, propose a sharper triage purpose, and name the signals to watch.` },
            ],
            response_format: PROBE_FORMAT,
            reasoning_effort: "low",
          },
          look: "Strict JSON in the recipe's probe shape: patterns with salience, a refined purpose with its rationale, signals labelled north-star or leading.",
        },
      },
    ],
  },
  {
    id: "use-cases",
    group: "Meta Model API",
    title: "Use cases",
    blurb: "Build end-to-end: multimodal perception, orchestration, and complete apps you can adapt.",
    recipes: [
      {
        slug: "cookbook/perception-chart-analysis",
        title: "Chart analysis",
        summary: "Read charts and extract structured data from images.",
        kind: "api",
        call: {
          label: "Read the sample bar chart into JSON",
          path: "chat/completions",
          body: {
            model: SPARK,
            messages: chatImage("Read every bar's label and value from this chart."),
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "chart",
                strict: true,
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    bars: {
                      type: "array",
                      items: { type: "object", properties: { label: { type: "string" }, value: { type: "number" } }, required: ["label", "value"], additionalProperties: false },
                    },
                  },
                  required: ["title", "bars"],
                  additionalProperties: false,
                },
              },
            },
            reasoning_effort: "low",
          },
          fills: [{ pointer: IMAGE_AT, sampleId: "bar-chart" }],
          look: "The schema guarantees the shape, not the reading: check the values against the chart (Latte 412, Cold brew 341, and so on).",
        },
      },
      {
        slug: "cookbook/perception-error-screenshot-fix",
        title: "Error screenshot fix",
        summary: "Diagnose a bug from a screenshot and ship the fix.",
        kind: "api",
        call: {
          label: "Diagnose the sample error screenshot",
          path: "chat/completions",
          body: {
            model: SPARK,
            messages: chatImage("This is my web app's error. Name the bug, the stack frame that matters, and the smallest fix. Be brief."),
            reasoning_effort: "low",
          },
          fills: [{ pointer: IMAGE_AT, sampleId: "error-screenshot" }],
          look: "It reads the TypeError and the file and line from the overlay, then proposes a guard for cart.items.",
        },
      },
      {
        slug: "cookbook/rayban-openclaw",
        title: "Smart glasses with OpenClaw",
        summary: "Look, ask out loud, and hear the answer, hands-free on Ray-Ban Meta glasses.",
        kind: "api",
        call: {
          label: "What the glasses see, answered in one spoken sentence",
          path: "chat/completions",
          body: {
            model: SPARK,
            messages: chatImage("I'm wearing smart glasses and looking at this. What am I looking at? Answer in one short sentence I can hear."),
            reasoning_effort: "minimal",
          },
          fills: [{ pointer: IMAGE_AT, sampleId: "street" }],
          look: "A short answer meant to be spoken back; the recipe adds OpenClaw, speech in and speech out around this call.",
        },
      },
      {
        slug: "cookbook/generating-slides",
        title: "Generating slides",
        summary: "Generate a slide deck from a prompt or source content.",
        kind: "api",
        call: {
          label: "Research a topic with web_search and outline the deck",
          path: "responses",
          body: {
            model: SPARK,
            input: "Research the current state of solid-state batteries and outline a 5-slide deck: a title and three short bullets per slide.",
            tools: [{ type: "web_search" }],
            max_tool_calls: 1,
            reasoning: { effort: "low" },
          },
          cost: "About 1 cent with its one search.",
          look: "A web search, then a structured outline the recipe turns into a reveal.js deck.",
        },
      },
      {
        slug: "cookbook/browser-verified-web-design",
        title: "Browser-verified web design",
        summary: "Build a website with a coding agent that checks its own work in a real browser.",
        kind: "api",
        call: {
          label: "Write the page the agent will then check in a browser",
          path: "chat/completions",
          body: {
            model: SPARK,
            messages: [
              {
                role: "user",
                content:
                  "Write a single-file HTML landing page for a neighborhood bakery: a hero, a menu with prices, opening hours and a footer. Inline CSS, no external assets, responsive. Return only the HTML.",
              },
            ],
            stream: true,
            reasoning_effort: "low",
          },
          stream: true,
          look: "A whole page in one file. The recipe's agent opens it in a real browser, looks, and fixes what's off.",
        },
      },
      {
        slug: "cookbook/iterative-game-dev",
        title: "Iterative game dev",
        summary: "Build a browser game end-to-end with a coding agent, verified in a real browser.",
        kind: "api",
        call: {
          label: "Plan iteration 1 and its browser checks",
          path: "chat/completions",
          body: {
            model: SPARK,
            messages: [
              {
                role: "user",
                content: "Plan iteration 1 of a browser Snake game in one HTML file: the game loop, input handling, and three checks to verify in a real browser before iteration 2. Under 150 words.",
              },
            ],
            reasoning_effort: "low",
          },
          look: "Small iterations, each with checks a browser can confirm: the loop the recipe's agent runs.",
        },
      },
      {
        slug: "cookbook/sandboxed-execution",
        title: "Sandboxed execution",
        summary: "Execute model-generated code in a sandbox.",
        kind: "api",
        call: {
          label: "The model writes code for your sandbox tool",
          path: "responses",
          body: {
            model: SPARK,
            input: "What is the 30th Fibonacci number? Write Python and run it with run_python.",
            tools: [fn("run_python", "Run Python code in a sandbox and return its stdout.", { code: { type: "string", description: "The Python source." } }, ["code"])],
            reasoning: { effort: "low" },
          },
          look: "A run_python call carrying the code. Your sandbox runs it and returns stdout; nothing runs here.",
        },
      },
      {
        slug: "cookbook/multi-agent-orchestration",
        title: "Multi-agent orchestration",
        summary: "Orchestrate a team of specialists that coordinate through a shared Kanban board.",
        kind: "api",
        call: {
          label: "A planner splits a goal into Kanban cards for specialists",
          path: "chat/completions",
          body: {
            model: SPARK,
            messages: [{ role: "user", content: "Break 'add password reset to a web app' into Kanban cards for a planner, a coder, a reviewer and a tester." }],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "board",
                strict: true,
                schema: {
                  type: "object",
                  properties: {
                    cards: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          title: { type: "string" },
                          owner: { type: "string", enum: ["planner", "coder", "reviewer", "tester"] },
                          column: { type: "string", enum: ["todo", "doing", "done"] },
                          depends_on: { type: "array", items: { type: "string" } },
                        },
                        required: ["title", "owner", "column", "depends_on"],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ["cards"],
                  additionalProperties: false,
                },
              },
            },
            reasoning_effort: "low",
          },
          look: "Cards with an owner, a column and dependencies: the shared board the specialists coordinate through.",
        },
      },
      {
        slug: "cookbook/one-shot-game-dev",
        title: "One-shot game dev",
        summary: "Build a complete 3D browser game in one pass: one structured prompt, no iteration loop.",
        kind: "api",
        call: {
          label: "One structured prompt, one complete game file",
          path: "chat/completions",
          body: {
            model: SPARK,
            messages: [
              {
                role: "user",
                content:
                  "Build a complete 3D browser game in one HTML file using three.js from https://unpkg.com/three@0.160.0/build/three.module.js. Gameplay: steer a glowing cube with the arrow keys to collect spinning spheres. Include a score, a 60-second timer and a restart button. Return only the HTML.",
              },
            ],
            stream: true,
            reasoning_effort: "low",
          },
          stream: true,
          look: "The whole game in one reply. Save it as an .html file and open it.",
        },
      },
      {
        slug: "cookbook/perception-grounding",
        title: "Perception grounding",
        summary: "Pin interactive dots at object pixel locations and generate a self-contained HTML overlay.",
        kind: "api",
        call: {
          label: "Point at each dog and bicycle on a 0 to 1000 grid",
          path: "chat/completions",
          body: {
            model: SPARK,
            messages: chatImage('Find each dog and each bicycle. Return only JSON: a list of {"label", "x", "y"} points on a 0 to 1000 grid, x from the left edge and y from the top.'),
            reasoning_effort: "low",
          },
          fills: [{ pointer: IMAGE_AT, sampleId: "street" }],
          look: "Points on the 0 to 1000 grid, ready to scale to the image's pixels and pin as dots.",
        },
      },
      {
        slug: "cookbook/github-agent",
        title: "GitHub agent",
        summary: "Run an autonomous GitHub Actions bot for triage, PR review, and bug-fix PRs on OpenCode and Muse Spark.",
        kind: "api",
        call: {
          label: "Triage an issue into labels and a priority",
          path: "chat/completions",
          body: {
            model: SPARK,
            messages: [
              {
                role: "user",
                content:
                  "Triage this GitHub issue.\n\nTitle: Login button does nothing on Safari 17\nBody: Clicking 'Sign in' on Safari 17.4 does nothing. Chrome works. Console shows 'TypeError: crypto.randomUUID is not a function'.",
              },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "triage",
                strict: true,
                schema: {
                  type: "object",
                  properties: {
                    labels: { type: "array", items: { type: "string" } },
                    priority: { type: "string", enum: ["p0", "p1", "p2", "p3"] },
                    summary: { type: "string" },
                    needs_repro: { type: "boolean" },
                  },
                  required: ["labels", "priority", "summary", "needs_repro"],
                  additionalProperties: false,
                },
              },
            },
            reasoning_effort: "low",
          },
          look: "The triage step the bot runs on every new issue, in a shape a GitHub Action can apply.",
        },
      },
      {
        slug: "cookbook/computer-use",
        title: "Computer use",
        summary: "Control a desktop from screenshots with a computer-use agent.",
        kind: "api",
        call: {
          label: "From a screenshot to the next click",
          path: "responses",
          body: {
            model: SPARK,
            input: responsesImage("Goal: type ada@example.com into the sign-up form's Email field. Take the next step with a tool. Coordinates are pixels in this 1280 x 800 screenshot."),
            tools: [
              fn("left_click", "Click at a point on the screen.", { x: { type: "integer" }, y: { type: "integer" } }, ["x", "y"]),
              fn("type_text", "Type text at the focused field.", { text: { type: "string" } }, ["text"]),
            ],
            reasoning: { effort: "low" },
          },
          fills: [{ pointer: RESPONSES_IMAGE_AT, sampleId: "signup-screen" }],
          look: "A left_click near the Email field (about x 900, y 356). A real agent clicks, takes a new screenshot and asks again.",
        },
      },
      {
        slug: "cookbook/computer-use-macos",
        title: "Computer use on macOS",
        summary: "Drive a real Mac from screenshots with native mouse and keyboard events.",
        kind: "api",
        call: {
          label: "One look-act step against a screenshot",
          path: "responses",
          body: {
            model: SPARK,
            instructions: "You operate a Mac through its GUI with native mouse and keyboard tools. Take one step at a time.",
            input: responsesImage("Goal: tick the Terms checkbox, then press Create account. Take the next step."),
            tools: [
              fn("mouse_click", "Click at screen coordinates in pixels.", { x: { type: "integer" }, y: { type: "integer" } }, ["x", "y"]),
              fn("key_press", "Press a key or a key combination, such as cmd+l.", { keys: { type: "string" } }, ["keys"]),
            ],
            reasoning: { effort: "low" },
          },
          fills: [{ pointer: RESPONSES_IMAGE_AT, sampleId: "signup-screen" }],
          look: "One native action at a time: here a mouse_click near the checkbox (about x 735, y 486).",
        },
      },
      {
        slug: "cookbook/glimmer-api-agent",
        title: "Local agent that asks first",
        summary: "Run Muse Glimmer locally and escalate to Muse Spark only after you approve the text the tool is about to send.",
        kind: "api",
        call: {
          label: "The escalation: only the approved text goes to Muse Spark",
          path: "chat/completions",
          body: {
            model: SPARK,
            messages: [
              {
                role: "user",
                content:
                  "Approved for sending: summarize these release notes as three changelog bullets.\n\nv2.4: adds offline mode for notes; fixes a crash when importing CSV files over 10 MB; speeds up search by about 40 percent.",
              },
            ],
            reasoning_effort: "minimal",
          },
          look: "The one call that leaves your machine carries only the text you approved; Muse Glimmer does the rest locally.",
        },
      },
    ],
  },
  {
    id: "building-with-muse-code",
    group: "Meta Model API",
    title: "Building with Muse Code",
    blurb: "Build durable, auditable agents with Muse Code: the harness building blocks for safety, recovery, and orchestration.",
    recipes: [
      museCode(
        "cookbook/audit-agent-sessions",
        "Audit and resume agent sessions",
        "Replay any session exactly as it ran from an append-only event log, show who authorized each action, then kill the run mid-task and resume with no duplicate side effects.",
        "muse export --last",
      ),
      museCode(
        "cookbook/deterministic-replay",
        "Deterministic replay in CI",
        "Turn recorded events into a golden fixture and replay its model-context projection as a merge-blocking CI check.",
        'SESSION_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/muse/sessions"\nF="$(ls -1t "$SESSION_ROOT"/$(date +%Y/%m/%d)/*/session.jsonl | head -n 1)"\nmuse trace inspect --session-log "$F" --render-mode compact',
        "Run a Muse Code session first: this inspects the newest one from today.",
      ),
      museCode(
        "cookbook/staged-approvals",
        "Staged approvals",
        "Split a compound shell command into stages so safe ones auto-resolve while risky ones hold for review.",
        "muse --approval-mode untrusted",
      ),
      museCode(
        "cookbook/contained-execution",
        "Contained execution",
        "Run every command in an OS sandbox that refuses to proceed unless containment is proven live.",
        "mkdir -p /tmp/sandbox_demo && cd /tmp/sandbox_demo && git init -q\nmuse --disable-approval --trust-workspace",
        "The recipe's setup step also writes its sample script, build_info.sh, into that folder.",
      ),
      museCode(
        "cookbook/immutable-guardrails",
        "Immutable guardrails",
        "The agent can't rewrite its own rules: guardrail edits stop for review and a shell write to the same path fails read-only at the sandbox.",
        "mkdir -p /tmp/rule12_demo/.agents && cd /tmp/rule12_demo && git init -q\nmuse --trust-workspace",
        "The recipe's setup step also writes the rules file, .agents/AGENTS.md, and billing.py, and commits them.",
      ),
      museCode(
        "cookbook/subagent-fanout",
        "Subagent fanout",
        "Fan one job out to parallel subagents, each in its own isolated git worktree.",
        "muse --subagent-worktree-isolation",
      ),
      museCode(
        "cookbook/goal-tracking",
        "Goal tracking",
        "Pin an objective once and the harness audits the work against acceptance checks before the goal can close.",
        "/goal <objective>",
      ),
      museCode(
        "cookbook/bundled-skills",
        "Bundled skills",
        "Drive the built-in /plan, /grilling, /grill-with-docs, and /taste skills to plan, pressure-test, and build.",
        "/plan Add a transfer(src, dst, glimbers) operation to SnorkelLedger with overdraft protection",
      ),
      museCode(
        "cookbook/loop-and-cron",
        "Loop and cron",
        "Schedule recurring or one-time agent work in natural language, then view, change, or cancel it from the same chat.",
        "/loop every morning at 8am, triage new bugs from bugs/BUGS.md and post a digest to docs/BUG_DIGEST.md",
      ),
      museCode(
        "cookbook/side-chats",
        "Side chats",
        "Branch off the main thread for a side conversation that never enters the main history.",
        "/side While that build runs, quick side question: ...",
      ),
    ],
  },
  {
    id: "muse-image",
    group: "Meta Model API",
    title: "Muse Image",
    blurb: "Use Muse Image to generate, edit, or combine images. Choose a recipe based on whether you need web grounding, consistency across a series, or multi-turn editing.",
    recipes: [
      {
        slug: "cookbook/image-generation-basics",
        title: "Generate, edit, and compose images",
        summary: "Generate an image, refine it across turns, or combine it with new reference images.",
        kind: "api",
        call: {
          label: "Turn 1: the recipe's watercolor fox",
          path: "responses",
          body: {
            model: "muse-image-1.0",
            input: "a watercolor painting of a red fox sitting in a snowy pine forest, soft golden morning light",
          },
          cost: "1 cent for the image.",
          look: "The image is the base64 result on the image_generation_call item; keep the response id to refine it next turn.",
        },
      },
      {
        slug: "cookbook/search-grounded-image-generation",
        title: "Ground image generation with web search",
        summary: "Use web references when an image should reflect current products, places, or styles. Verify factual details independently.",
        kind: "api",
        call: {
          label: "Search the web for a real product set, then render it",
          path: "responses",
          body: {
            model: "muse-image-1.0",
            input:
              "Search the web for a coordinated modern rattan outdoor lounge set with white cushions sold as one collection: a full sofa, a two-seat loveseat, and two matching single armchairs. Render a clean e-commerce product grid with one cell per piece on a plain white background, catalog style.",
          },
          cost: "1 cent for the image, plus any searches it runs.",
          look: "Muse Image researches before it renders. Check the details against the real product yourself.",
        },
      },
      {
        slug: "cookbook/anchored-image-series",
        title: "Keep an image series consistent",
        summary: "Use reference images to improve character, style, and setting consistency across a series. Compare each output with the references.",
        kind: "api",
        call: {
          label: "The series' first anchor: the hero's character sheet",
          path: "responses",
          body: {
            model: "muse-image-1.0",
            input:
              "an original comic-book superhero character sheet, a stylized man wearing a bright green flowing cape and a green eye mask, dark hair, muscular build, confident heroic pose, plain white background, full body centered, bold clean comic-book line art with thick black outlines, flat vivid colors",
          },
          cost: "1 cent for the image.",
          look: "The reference every later panel chains from, so the hero stays on model.",
        },
      },
      {
        slug: "cookbook/image-editing-with-reasoning",
        title: "Edit image details across turns",
        summary: "Edit one part of a photo, then refine the result across turns. Check that unchanged areas still match the source.",
        kind: "api",
        call: {
          label: "Turn 1: your photo plus one instruction",
          path: "responses",
          body: {
            model: "muse-image-1.0",
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "add a small handwritten price tag next to the sneaker, like a piece of masking tape with a marker price: $80; keep the sneaker and the background otherwise unchanged",
                  },
                  { type: "input_image", image_url: "" },
                ],
              },
            ],
          },
          fills: [{ pointer: RESPONSES_IMAGE_AT, sampleId: "sneaker" }],
          cost: "1 cent for the image.",
          look: "Only the tag should change; compare the rest with the source photo.",
        },
      },
    ],
  },
  {
    id: "muse-voice-transcribe",
    group: "Meta Model API",
    title: "Muse Voice Transcribe",
    blurb:
      "Use Muse Voice Transcribe to turn speech into text, streaming over a WebSocket while the speaker is still talking, or in one HTTP request for a recording you already have. The model handles punctuation, speech-boundary detection, and speaker attribution itself.",
    recipes: [
      {
        slug: "cookbook/voice-api-fundamentals",
        title: "Speech to text",
        summary:
          "Transcribe a recording or a live microphone over the streaming WebSocket, get speaker-attributed turns with diarization, or post a whole recording in one HTTP request.",
        kind: "api",
        call: {
          label: "Post a whole recording in one HTTP request",
          path: "asr/transcribe",
          form: [
            { name: "request", value: JSON.stringify({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV" }) },
            { name: "audio", sampleId: "speech-paragraph" },
          ],
          look: "The transcript of the 15-second sample, punctuated. Billed by audio length: well under a cent.",
        },
      },
      {
        slug: "cookbook/voice-chess-cua",
        title: "Control Apple Chess with voice",
        summary:
          "Turn exact spoken chess moves into locally validated Apple Chess actions with a passive HUD, calibrated grid, dry-run mode, and fail-closed native input.",
        kind: "api",
        call: {
          label: "Transcribe spoken moves with chess words as keywords",
          path: "asr/transcribe",
          form: [
            {
              name: "request",
              value: JSON.stringify({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", keywords: ["pawn", "knight", "bishop", "castle", "kingside"] }),
            },
            { name: "audio", sampleId: "chess-moves" },
          ],
          look: '"Pawn to e4. Knight to f3. ..." as text, which the recipe validates as moves before any click.',
        },
      },
    ],
  },
  {
    id: "sam",
    group: "Meta Model API",
    title: "Segment Anything Model",
    blurb:
      "Use Segment Anything Model to find and cut out objects in images and video from a short noun phrase. SAM 3.1 returns a box and a pixel mask for every match, and holds each object's identity across a whole clip, so a recipe can track and composite without per-frame bookkeeping.",
    recipes: [
      {
        slug: "cookbook/sam-api-basics",
        title: "SAM API basics",
        summary: "Segment an image or an uploaded video in Python or TypeScript, streaming the response and parsing it with the official meta-sam parsers.",
        kind: "api",
        call: {
          label: 'Segment "dog" in the street photo, streamed',
          path: "responses",
          body: {
            model: "sam-3.1",
            input: [{ role: "user", content: [{ type: "input_text", text: "dog" }, { type: "input_image", image_url: "" }] }],
            stream: true,
          },
          fills: [{ pointer: RESPONSES_IMAGE_AT, sampleId: "street" }],
          stream: true,
          look: "SAM's text grammar, one line per object with a box and a mask. The official parsers decode it; the SAM pages draw it.",
        },
      },
      {
        slug: "cookbook/video-to-sticker-pack",
        title: "Video to animated stickers",
        summary: "Track an animal through a clip, cut the background from its longest-lived track, and export transparent animated stickers.",
        kind: "api",
        call: {
          label: 'Track "dog" through the 5-second sample clip',
          path: "responses",
          body: {
            model: "sam-3.1",
            input: [{ role: "user", content: [{ type: "input_text", text: "dog" }, { type: "input_video", video_url: "" }] }],
            stream: true,
          },
          fills: [{ pointer: "/input/0/content/1/video_url", sampleId: "street-pan" }],
          stream: true,
          cost: "About 2.4 cents: 120 frames at $0.20 per 1,000.",
          look: "Each object keeps its id across frames, which is what lets the recipe cut a sticker from the longest-lived track.",
        },
      },
      {
        slug: "cookbook/headlocked-speech-bubble-captions",
        title: "Multi-speaker headlocked captions",
        summary: "Match diarized voices to SAM-tracked people, preview collision-aware speech bubbles, and download the captioned video.",
        kind: "api",
        call: {
          label: "The voice half: a diarized two-speaker call",
          path: "asr/transcribe",
          form: [
            { name: "request", value: JSON.stringify({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "DIARIZATION" }) },
            { name: "audio", sampleId: "two-voices" },
          ],
          look: "Speaker-attributed turns; the recipe matches each voice to a SAM-tracked person and pins a bubble over them.",
        },
      },
    ],
  },
  {
    id: "run-locally",
    group: "Open-weight models",
    title: "Run locally",
    blurb: "Serve a Muse open-weight model on your own machines, step by step.",
    recipes: [
      {
        slug: "cookbook/muse-spark-open-mac",
        title: "Muse Spark Open on Mac",
        summary: "Run Muse Spark Open on two or four Mac Studios.",
        kind: "open-weights",
        where: "Runs on your own Macs. The call here sends the recipe's test prompt to hosted Muse Spark instead.",
        command:
          "mlx.launch --hostfile hostfile.json --backend jaccl --env MLX_METAL_FAST_SYNCH=1 -- \\\n  mlx_lm.server --model meta-models/Muse-Spark-Open-816B-A42B-NVFP4 --port 8080",
        call: {
          label: "The recipe's test prompt, on hosted Muse Spark",
          path: "chat/completions",
          body: { model: SPARK, messages: [{ role: "user", content: "Give me a one-sentence summary of what you can do." }], reasoning_effort: "low" },
          look: "The same OpenAI-compatible request your Macs serve on port 8080 once the server is up.",
        },
      },
    ],
  },
  {
    id: "post-training",
    group: "Open-weight models",
    title: "Post-training",
    blurb: "Fine-tune a Muse open-weight model on your own data, step by step.",
    recipes: [
      {
        slug: "cookbook/muse-spark-open-torchtitan-rl",
        title: "RL with TorchTitan",
        summary: "GRPO with the DAPO loss on a task you plug in, starting from DAPO-Math.",
        kind: "open-weights",
        where: "Runs on your GPUs with TorchTitan: there's no API call to try here.",
        command: "python -m torchtitan.rl.train --module rl --config muse_spark_dapo_math",
      },
      {
        slug: "cookbook/muse-spark-open-torchtitan-sft",
        title: "SFT with TorchTitan",
        summary: "Full-parameter SFT on your own text, image, and audio conversations.",
        kind: "open-weights",
        where: "Runs on your GPUs with TorchTitan: there's no API call to try here.",
        command: "NGPU=1 MODULE=sft CONFIG=muse_spark_debugmodel_sft ./run_train.sh",
      },
    ],
  },
];

export function sectionsById(ids: readonly string[] | undefined): RecipeSection[] {
  if (!ids?.length) return [...RECIPE_SECTIONS];
  return ids.map((id) => RECIPE_SECTIONS.find((s) => s.id === id)).filter((s): s is RecipeSection => !!s);
}

export function findRecipe(slug: string): Recipe | null {
  for (const s of RECIPE_SECTIONS) {
    const r = s.recipes.find((x) => x.slug === slug);
    if (r) return r;
  }
  return null;
}

/** Recipes whose title, summary or slug has every word of the query, in section order. */
export function filterRecipes(sections: readonly RecipeSection[], query: string): RecipeSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...sections];
  return sections
    .map((s) => ({
      ...s,
      recipes: s.recipes.filter((r) => {
        const hay = `${r.title} ${r.summary} ${r.slug} ${s.title}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      }),
    }))
    .filter((s) => s.recipes.length > 0);
}
