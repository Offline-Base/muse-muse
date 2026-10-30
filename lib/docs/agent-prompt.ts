import type { DocsPageInfo, RecordedRequest } from "@/components/docs/kit/DocsPageContext";
import type { AgentPromptSpec, PromptLanguage } from "@/lib/docs/demos/types";
import { ownKeyModelBody } from "@/lib/docs/client/codegen";
import { RETIRED_SPARK, SPARK_STANDIN } from "@/lib/meta/spark";

/**
 * The text behind "Copy prompt for your coding agent" (docs/DOCS_MIRROR.md, "Page layout"): what to build (the page's
 * DemoSpec agentPrompt, or a generic task from its title and description), the page's Markdown URL to read first, the
 * setup facts, what the reader just ran in the docs when they ask for it, starter code in their language, and "done
 * when" checks. Plain text with no em dashes, kept under PROMPT_MAX_CHARS so it pastes anywhere. Pure, so the browser
 * builds it on click with the reader's choices.
 */

export type CodingAgent = "claude-code" | "codex" | "cursor" | "opencode" | "muse-code" | "other";

export const CODING_AGENTS: readonly { id: CodingAgent; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "opencode", label: "OpenCode" },
  { id: "muse-code", label: "Muse Code" },
  { id: "other", label: "Other" },
];

export const PROMPT_LANGUAGES: readonly { id: PromptLanguage; label: string }[] = [
  { id: "python", label: "Python" },
  { id: "typescript", label: "TypeScript" },
  { id: "curl", label: "curl" },
];

export const PROMPT_MAX_CHARS = 4000;
export const META_BASE_URL = "https://api.meta.ai/v1";

export interface AgentPromptInput {
  page: Pick<DocsPageInfo, "slug" | "title" | "description" | "sourceUrl" | "markdownUrl">;
  /** The page's DemoSpec agentPrompt, or null for a page without one. */
  spec: AgentPromptSpec | null;
  agent: CodingAgent;
  language: PromptLanguage;
  /** The request to include under "What I just ran", or null to leave it out. */
  lastRequest: RecordedRequest | null;
}

const INTRO: Record<CodingAgent, string> = {
  "claude-code": "You're Claude Code, working in my repository.",
  codex: "You're Codex, working in my repository. Plan briefly before you edit.",
  cursor: "You're the Cursor agent in my workspace. Run commands in the integrated terminal.",
  opencode: "You're OpenCode, working in my repository.",
  "muse-code":
    "You're Muse Code, working in my repository. You already run on Meta's models; the code you write calls the same API with its own key.",
  other: "You're a coding agent working in my repository.",
};

const LANGUAGE_SETUP: Record<PromptLanguage, string> = {
  python:
    'Python: the OpenAI SDK (pip install openai) with base_url="https://api.meta.ai/v1" and api_key=os.environ["MODEL_API_KEY"] works, or plain requests.',
  typescript:
    'TypeScript: the OpenAI SDK (npm install openai) with baseURL "https://api.meta.ai/v1" and apiKey process.env.MODEL_API_KEY works, or fetch.',
  curl: 'curl: export MODEL_API_KEY in the shell first and send -H "Authorization: Bearer $MODEL_API_KEY".',
};

/**
 * The Messages pages (protocols/messages, api-reference/messages/*) teach the Anthropic wire format, and their code
 * uses the Anthropic SDK: it takes the base host without /v1 (it adds /v1/messages itself) and the key as auth_token,
 * sent as a bearer token. Their setup says so instead of pointing the agent at the OpenAI SDK.
 */
const MESSAGES_PAGE = /^(protocols|api-reference)\/messages(\/|$)/;

const MESSAGES_LANGUAGE_SETUP: Record<PromptLanguage, string> = {
  python:
    'Python: the Anthropic SDK (pip install anthropic) with base_url="https://api.meta.ai" (no /v1) and auth_token=os.environ["MODEL_API_KEY"], or plain requests to https://api.meta.ai/v1/messages.',
  typescript:
    'TypeScript: the Anthropic SDK (npm install @anthropic-ai/sdk) with baseURL "https://api.meta.ai" (no /v1) and authToken process.env.MODEL_API_KEY, or fetch to https://api.meta.ai/v1/messages.',
  curl: LANGUAGE_SETUP.curl,
};

const LANGUAGE_NAME: Record<PromptLanguage, string> = { python: "Python", typescript: "TypeScript", curl: "curl" };

/** Meta's prose and the page groups' text may carry em dashes; nothing Muse Muse hands out does. */
function noEmDash(text: string): string {
  return text.replace(/\s*\u2014\s*/g, ", ");
}

/** Cuts text to `max` characters, at a line break when one is close, and says so. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - 14);
  const cut = text.lastIndexOf("\n", room);
  return `${text.slice(0, cut > room * 0.6 ? cut : room).trimEnd()}\n... (trimmed)`;
}

/** The body with long strings (data URLs, base64, long prompts) and long arrays shortened, for the prompt. */
export function trimBody(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.length <= 160) return value;
    const data = value.match(/^data:([^;,]+)[;,]/);
    if (data) return `data:${data[1]};base64,<${Math.round((value.length * 3) / 4 / 1024)} KB of base64, trimmed>`;
    return `${value.slice(0, 120)}... (${value.length - 120} more characters)`;
  }
  if (depth > 6) return Array.isArray(value) ? "[...]" : typeof value === "object" && value ? "{...}" : value;
  if (Array.isArray(value)) {
    const head = value.slice(0, 8).map((v) => trimBody(v, depth + 1));
    return value.length > 8 ? [...head, `... ${value.length - 8} more`] : head;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimBody(v, depth + 1)]));
  }
  return value;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

/** JSON as a Python literal: the same text with true, false and null spelled the Python way, outside strings. */
function pythonLiteral(value: unknown): string {
  return json(value).replace(/("(?:[^"\\]|\\.)*")|\b(true|false|null)\b/g, (whole, str: string | undefined, word: string | undefined) =>
    str ? str : word === "true" ? "True" : word === "false" ? "False" : "None",
  );
}

function indent(text: string, by: string): string {
  return text.replace(/\n/g, `\n${by}`);
}

/**
 * The model id for the reader's own code. Muse Muse never runs muse-spark-1.3 (lib/meta/spark.ts): it becomes
 * muse-spark-1.3-contributor here too, and the Setup line says what Contributor mode means and how to leave it.
 */
export function modelForOwnKey(model: string): string {
  return model === RETIRED_SPARK ? SPARK_STANDIN : model;
}


/** Starter code that repeats the request the reader ran, in their language, with the model their own key should use. */
export function codeForRequest(request: RecordedRequest, language: PromptLanguage): string {
  const url = `${META_BASE_URL}/${request.path.replace(/^\/+/, "").replace(/^v1\//, "")}`;
  const body = request.body === undefined ? undefined : trimBody(ownKeyModelBody(request.body));
  const isJson = body !== undefined && typeof body === "object";
  if (language === "curl") {
    const lines = [`curl -X ${request.method} "${url}"`, `  -H "Authorization: Bearer $MODEL_API_KEY"`];
    if (isJson) lines.push(`  -H "Content-Type: application/json"`, `  -d '${json(body).replace(/'/g, "'\\''")}'`);
    else if (typeof body === "string") lines.push(`  # ${body}`);
    return lines.join(" \\\n");
  }
  if (language === "python") {
    const call = request.method === "GET" ? "get" : request.method === "DELETE" ? "delete" : "post";
    return [
      "import os",
      "",
      "import requests",
      "",
      `response = requests.${call}(`,
      `    "${url}",`,
      `    headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"},`,
      ...(isJson ? [`    json=${indent(pythonLiteral(body), "    ")},`] : typeof body === "string" ? [`    # ${body}`] : []),
      ")",
      "response.raise_for_status()",
      "print(response.json())",
    ].join("\n");
  }
  return [
    `const response = await fetch("${url}", {`,
    `  method: "${request.method}",`,
    "  headers: {",
    "    Authorization: `Bearer ${process.env.MODEL_API_KEY}`,",
    ...(isJson ? ['    "Content-Type": "application/json",'] : []),
    "  },",
    ...(isJson ? [`  body: JSON.stringify(${indent(json(body), "  ")}),`] : typeof body === "string" ? [`  // ${body}`] : []),
    "});",
    "if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);",
    "console.log(await response.json());",
  ].join("\n");
}

/**
 * The model the prompt names: what the reader's request asked for (its body, before the docs' swap), else what the
 * proxy ran, else what the page is about, else Muse Spark 1.3 Contributor (muse-spark-1.3 itself is never used).
 */
function modelFor(slug: string, lastRequest: RecordedRequest | null): string {
  const asked = (lastRequest?.body as { model?: unknown } | undefined)?.model;
  const ran = typeof asked === "string" && asked ? asked : lastRequest?.model;
  if (typeof ran === "string" && ran) return modelForOwnKey(ran);
  if (/image-generation|images|muse-image|image-editing|image-series/.test(slug)) return "muse-image-1.0";
  if (/speech|voice|transcribe/.test(slug)) return "muse-voice-transcribe-1.0";
  if (/(^|\/)sam(\/|-|$)|segmentation|sticker/.test(slug)) return "sam-3.1";
  return SPARK_STANDIN;
}

function section(title: string, lines: string[]): string {
  return [title, ...lines].join("\n");
}

/** API reference pages that document one endpoint, and the call each one documents. */
const ENDPOINT_PAGES: Readonly<Record<string, string>> = {
  "api-reference/chat-completions/create-chat-completion": "POST /v1/chat/completions",
  "api-reference/files/upload-file": "POST /v1/files",
  "api-reference/files/list-files": "GET /v1/files",
  "api-reference/files/retrieve-file": "GET /v1/files/{file_id}",
  "api-reference/files/retrieve-file-content": "GET /v1/files/{file_id}/content",
  "api-reference/files/delete-file": "DELETE /v1/files/{file_id}",
  "api-reference/images/create-image": "POST /v1/images/generations",
  "api-reference/images/edit-image": "POST /v1/images/edits",
  "api-reference/messages/create-message": "POST /v1/messages",
  "api-reference/messages/count-tokens": "POST /v1/messages/count_tokens",
  "api-reference/models/list-models": "GET /v1/models",
  "api-reference/models/retrieve-model": "GET /v1/models/{model}",
  "api-reference/responses/create-response": "POST /v1/responses",
  "api-reference/responses/retrieve-response": "GET /v1/responses/{response_id}",
  "api-reference/responses/delete-response": "DELETE /v1/responses/{response_id}",
  "api-reference/responses/cancel-response": "POST /v1/responses/{response_id}/cancel",
  "api-reference/responses/count-input-tokens": "POST /v1/responses/input_tokens",
  "api-reference/status": "GET /v1/status",
  "api-reference/voice/transcribe": "POST /v1/asr/transcribe",
  "api-reference/voice/realtime": "the realtime WebSocket, wss://api.meta.ai/v1/asr/realtime,",
};

type PageKind =
  | "guide"
  | "recipe"
  | "cookbook"
  | "endpoint"
  | "schemas"
  | "api-overview"
  | "muse-code"
  | "changelog"
  | "open-weight";

/** What kind of page this is, by its place in the docs: it decides the task and checks a page without its own get. */
function pageKind(slug: string): PageKind {
  if (slug === "muse-code/changelog") return "changelog";
  if (slug === "muse-code" || slug.startsWith("muse-code/")) return "muse-code";
  if (slug === "open-weight-models" || /^(muse-glimmer|muse-spark-open)(\/|$)/.test(slug)) return "open-weight";
  if (slug === "cookbook") return "cookbook";
  if (slug.startsWith("cookbook/")) return "recipe";
  if (ENDPOINT_PAGES[slug]) return "endpoint";
  if (/^api-reference\/[^/]+\/schemas$/.test(slug)) return "schemas";
  if (slug === "api-reference" || slug.startsWith("api-reference/")) return "api-overview";
  return "guide";
}

/** The description, unless it only restates the title: then the title is said once, through the description. */
function opensWithTitle(title: string, description: string): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return Boolean(title) && norm(description).startsWith(norm(title));
}

/** The task and "done when" checks for a page without an agentPrompt of its own, fit to its kind. */
function fallbackFor(kind: PageKind, slug: string, title: string, description: string): { task: string; done: string[] } {
  const about = description ? ` ${description}` : "";
  const quoted = `"${title}"`;
  switch (kind) {
    case "changelog":
      return {
        task: "Check this project's Muse Code setup against the latest release notes on this page (Muse Code's changelog). List what changed that affects how this project uses Muse Code, and update its config or scripts where a release calls for it.",
        done: ["Every change that affects this project is listed with what to do about it, and the setup matches the latest release."],
      };
    case "muse-code":
      return {
        task: `Set up Muse Code in this project as this page describes (${quoted}).${about} Install or configure it, with any config files or settings the page names.`,
        done: ["muse runs in this project with the setup this page describes."],
      };
    case "open-weight":
      return {
        task: `Self-host the open-weight model as this page describes (${quoted}).${about} Follow its steps on hardware I control, and tell me first if this machine can't run it.`,
        done: ["A local OpenAI-compatible endpoint answers a short chat request."],
      };
    case "cookbook":
      return {
        task: "Pick the recipe on this page (Meta's cookbook index) that fits this project best, tell me which one and why, then build it here from the recipe's own page.",
        done: ["The recipe you picked runs end to end in this project."],
      };
    case "endpoint": {
      const call = ENDPOINT_PAGES[slug];
      return {
        task: `Call ${call} from this project as this API reference page (${quoted}) specifies, and check what comes back against the response shape it documents.`,
        done: [`A real call to ${call.replace(/,$/, "")} succeeds, and its response has the fields this page lists.`],
      };
    }
    case "schemas":
      return {
        task: `Type the requests this project sends and the responses it reads with the definitions on this page (${quoted}): the fields, their types and which are required.`,
        done: ["The types match this page's fields, required ones included.", "A real call's response parses with these types."],
      };
    case "api-overview":
      return {
        task: `Use the endpoints this overview (${quoted}) covers from this project, starting with the one my code needs.${about}`,
        done: ["Running it once makes a real call to the API and prints the result this page describes."],
      };
    case "recipe":
      return {
        task: opensWithTitle(title, description)
          ? `${description} Build it in this project from Meta's cookbook recipe, adapting its code to my project instead of pasting it as is.`
          : `Build the ${quoted} recipe from Meta's cookbook in this project.${about} Adapt its code to my project instead of pasting it as is.`,
        done: ["Running it once makes a real call to the API and prints the result this page describes."],
      };
    case "guide":
      return {
        task: opensWithTitle(title, description)
          ? `${description} Apply it in this project with Meta Model API, adapting the page's examples to my code instead of pasting them as is.`
          : `Use Meta Model API to apply ${quoted} in this project.${about} Adapt the page's examples to my code instead of pasting them as is.`,
        done: ["Running it once makes a real call to the API and prints the result this page describes."],
      };
  }
}

/** Kinds of page whose work is calling the API, so a failed call should say why. */
const CALLS_THE_API: ReadonlySet<PageKind> = new Set(["guide", "recipe", "cookbook", "endpoint", "schemas", "api-overview"]);

/**
 * Muse Code's own pages and its changelog hand the agent a task with the muse CLI, which signs in with META_API_KEY or
 * a stored credential (muse-code/auth), not the API's MODEL_API_KEY. Their setup says so, unless the starter code
 * calls the Model API itself (the rewind page's chat feature does).
 */
const MUSE_CLI_KINDS: ReadonlySet<PageKind> = new Set(["muse-code", "changelog"]);

const MUSE_CLI_SETUP: readonly string[] = [
  "Muse Code: muse on PATH (install: curl -fsSL https://dev.meta.ai/install.sh | sh, or irm https://dev.meta.ai/install.ps1 | iex on Windows; check: muse --version). Its default model is muse-spark-1.2; --model picks another.",
  "Auth: muse reads META_API_KEY from the environment (in CI, from the secret store), else a key stored with muse auth set or a browser sign-in; not MODEL_API_KEY. Never hard-code, print or commit the key.",
];

const MUSE_CLI_LANGUAGE: Record<PromptLanguage, string> = {
  python: "Python: a plain script that runs muse through subprocess where a step needs it.",
  typescript: "TypeScript: a Node script that runs muse through node:child_process where a step needs it.",
  curl: "Shell: bash on macOS and Linux, PowerShell on Windows.",
};

function bullets(items: string[]): string[] {
  return items.map((item) => `- ${item}`);
}

/** Builds the prompt. Always includes the page's Markdown URL; the last request only when one is passed. */
export function buildAgentPrompt({ page, spec, agent, language, lastRequest }: AgentPromptInput): string {
  const title = noEmDash(page.title);
  const description = noEmDash(page.description).trim();
  const model = modelFor(page.slug, lastRequest);
  const kind = pageKind(page.slug);
  const fallback = fallbackFor(kind, page.slug, title, description);

  const task = spec?.task?.trim() || fallback.task;

  let snippet = spec?.snippets?.[language]?.trim() ?? "";
  // Without a snippet of the page's own, the starter code repeats the request the reader ran.
  const snippetIsRun = !snippet && Boolean(lastRequest);
  if (snippetIsRun && lastRequest) snippet = codeForRequest(lastRequest, language);
  const museCli = MUSE_CLI_KINDS.has(kind) && !snippet.includes(META_BASE_URL);
  const languageName = museCli && language === "curl" ? "shell" : LANGUAGE_NAME[language];

  const anthropic = MESSAGES_PAGE.test(page.slug);
  const setup = museCli
    ? MUSE_CLI_SETUP.concat(MUSE_CLI_LANGUAGE[language])
    : [
        anthropic ? `Base URL: ${META_BASE_URL} for HTTP calls (POST ${META_BASE_URL}/messages); the Anthropic SDK takes https://api.meta.ai` : `Base URL: ${META_BASE_URL}`,
        "Auth: send Authorization: Bearer $MODEL_API_KEY, reading MODEL_API_KEY from the environment. Never hard-code, print or commit the key.",
        `Model: ${model}${model.endsWith("-contributor") ? " (Contributor mode: Meta may use what you send to train future models; drop -contributor for Standard mode)" : ""}`,
        (anthropic ? MESSAGES_LANGUAGE_SETUP : LANGUAGE_SETUP)[language],
      ];

  const done = [
    ...(spec?.checklist?.length ? spec.checklist : fallback.done),
    museCli
      ? "The key comes from META_API_KEY or a stored sign-in and never appears in code, logs or commits."
      : "The key comes from MODEL_API_KEY and never appears in code, logs or commits.",
    ...(CALLS_THE_API.has(kind) ? ["API errors (4xx, 429) surface their message instead of failing silently."] : []),
  ];

  const ran = lastRequest
    ? [
        `${lastRequest.method} /v1/${lastRequest.path.replace(/^\/+/, "").replace(/^v1\//, "")}${lastRequest.status ? ` returned HTTP ${lastRequest.status}` : ""}${lastRequest.model ? ` on ${lastRequest.model}` : ""}.`,
        ...(lastRequest.body === undefined
          ? []
          : snippetIsRun && typeof lastRequest.body === "object"
            ? ["The starter code below sends the same body."]
            : ["Body:", typeof lastRequest.body === "string" ? lastRequest.body : json(trimBody(ownKeyModelBody(lastRequest.body)))]),
        ...(lastRequest.outcome ? [`Result: ${lastRequest.outcome.trim().slice(0, 300)}`] : []),
      ].join("\n")
    : "";

  const build = (budget: { task: number; facts: number; ran: number; snippet: number }) =>
    [
      INTRO[agent],
      section("Task", [clip(noEmDash(task), budget.task)]),
      section("Read this first", [
        `Meta's docs page "${title}" as Markdown: ${page.markdownUrl}`,
        `It's the source of truth for request and response shapes. The same page for people: ${page.sourceUrl}`,
      ]),
      section("Setup", bullets(setup)),
      ...(spec?.facts?.length ? [section("Facts to get right", [clip(bullets(spec.facts.map(noEmDash)).join("\n"), budget.facts)])] : []),
      ...(ran ? [section("What I just ran in the docs", [clip(ran, budget.ran)])] : []),
      snippet
        ? section(`Starter code (${languageName})`, [clip(snippet, budget.snippet)])
        : section("Starter code", [`Start from the page's ${languageName} example, if it has one.`]),
      section("Done when", bullets(done.map(noEmDash))),
    ].join("\n\n");

  // Shrink the long sections until the prompt fits, snippet first since the page itself has the full examples.
  const budgets = [
    { task: 700, facts: 900, ran: 1100, snippet: 1500 },
    { task: 600, facts: 700, ran: 800, snippet: 1000 },
    { task: 500, facts: 500, ran: 500, snippet: 600 },
    { task: 400, facts: 300, ran: 300, snippet: 300 },
  ];
  let text = "";
  for (const budget of budgets) {
    text = noEmDash(build(budget));
    if (text.length <= PROMPT_MAX_CHARS) return text;
  }
  return clip(text, PROMPT_MAX_CHARS);
}
