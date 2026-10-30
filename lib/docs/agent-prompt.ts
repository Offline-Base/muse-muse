import type { DocsPageInfo, RecordedRequest } from "@/components/docs/kit/DocsPageContext";
import { ANTHROPIC_BASE, ownKeyModelBody } from "@/lib/docs/client/codegen";
import { DEMO_GROUPS } from "@/lib/docs/demos/groups";
import type { AgentPromptSpec, PromptLanguage } from "@/lib/docs/demos/types";
import { RETIRED_SPARK, SPARK_STANDIN } from "@/lib/meta/spark";

/**
 * The text behind "Copy prompt for your coding agent" (docs/DOCS_MIRROR.md, "Page layout"): what to build (the page's
 * DemoSpec agentPrompt, or a task fit to the kind of page), the page's Markdown URL to read first, the Setup for where
 * the code runs, what the reader just ran in the docs when they ask for it, starter code in their language, and "done
 * when" checks. Plain text with no em dashes, kept under PROMPT_MAX_CHARS so it pastes anywhere. Pure, so the browser
 * builds it on click with the reader's choices.
 *
 * The Setup is one of three (PromptSetup): Meta's hosted Model API (base URL, MODEL_API_KEY and the model, with the
 * Anthropic SDK's base host on the Messages pages), the muse CLI on Muse Code's own pages, or the reader's own
 * OpenAI-compatible server on the open-weight pages. A page's spec can pick hosted or self-hosted itself.
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
  "muse-code": "You're Muse Code, working in my repository.",
  other: "You're a coding agent working in my repository.",
};

/** Muse Code runs on Meta's models itself, so on a hosted page it hears that the code it writes has a key of its own. */
const MUSE_CODE_ON_HOSTED = " You already run on Meta's models; the code you write calls the same API with its own key.";

const LANGUAGE_NAME: Record<PromptLanguage, string> = { python: "Python", typescript: "TypeScript", curl: "curl" };

/** Meta's prose and the page groups' text may carry em dashes; nothing Muse Muse hands out does. */
function noEmDash(text: string): string {
  return text.replace(/\s*\u2014\s*/g, ", ");
}

const TRIMMED = "... (trimmed)";

/**
 * Cuts text to at most `max` characters and says so: at a line break when one is close, else after the last whole
 * word, so a model id or a number is never cut in two ("muse-spark-1.3-c" would read as muse-spark-1.3).
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - TRIMMED.length - 1);
  const line = text.lastIndexOf("\n", room);
  const word = text.slice(0, room + 1).search(/\s\S*$/);
  const kept = text.slice(0, line > room * 0.6 ? line : word >= 0 ? word : room).trimEnd();
  return kept ? `${kept}\n${TRIMMED}` : TRIMMED;
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

function section(title: string, lines: string[]): string {
  return [title, ...lines].join("\n");
}

function bullets(items: readonly string[]): string[] {
  return items.map((item) => `- ${item}`);
}

// ---------------------------------------------------------------------------------------------------------------
// The kind of page

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

/**
 * The open-weight pages: Muse Spark Open, Muse Glimmer, the overview that picks between them, and the cookbook recipes
 * that run or train them (cookbook/run-locally, cookbook/post-training, the Mac and TorchTitan recipes). They are the
 * "open-weights" page group, so the list lives in one place.
 */
const OPEN_WEIGHT_PAGES: ReadonlySet<string> = new Set(DEMO_GROUPS["open-weights"]);

/** What kind of page this is, by its place in the docs: it decides the task and checks a page without its own get. */
function pageKind(slug: string): PageKind {
  if (slug === "muse-code/changelog") return "changelog";
  if (slug === "muse-code" || slug.startsWith("muse-code/")) return "muse-code";
  if (OPEN_WEIGHT_PAGES.has(slug)) return "open-weight";
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

// ---------------------------------------------------------------------------------------------------------------
// The Setup: where the code runs

/**
 * Where the code the prompt asks for runs: Meta's hosted Model API, the muse CLI (Muse Code's own pages), or the
 * reader's own OpenAI-compatible server (the open-weight pages). It decides the Setup lines and the key check.
 */
type PromptSetup = "hosted" | "muse-cli" | "self-hosted";

/**
 * Muse Code's own pages and its changelog hand the agent a task with the muse CLI, which signs in with META_API_KEY or
 * a stored credential (muse-code/auth), not the API's MODEL_API_KEY. Their setup says so, unless the starter code
 * calls the Model API itself (the rewind page's chat feature does).
 */
const MUSE_CLI_KINDS: ReadonlySet<PageKind> = new Set(["muse-code", "changelog"]);

/** Hosted or self-hosted, before the starter code is known: what the page's spec says, else what its kind is. */
function hostingFor(kind: PageKind, spec: AgentPromptSpec | null): "hosted" | "self-hosted" {
  return spec?.setup ?? (kind === "open-weight" ? "self-hosted" : "hosted");
}

/**
 * The Setup for a page: what its spec asks for, else self-hosted on the open-weight pages, the muse CLI on Muse Code's
 * pages unless the starter code calls the Model API, and the hosted API everywhere else.
 */
function setupFor(kind: PageKind, spec: AgentPromptSpec | null, snippet: string): PromptSetup {
  const hosting = hostingFor(kind, spec);
  if (hosting === "hosted" && !spec?.setup && MUSE_CLI_KINDS.has(kind) && !snippet.includes(META_BASE_URL)) return "muse-cli";
  return hosting;
}

const LANGUAGE_SETUP: Record<PromptLanguage, string> = {
  python: `Python: the OpenAI SDK (pip install openai) with base_url="${META_BASE_URL}" and api_key=os.environ["MODEL_API_KEY"] works, or plain requests.`,
  typescript: `TypeScript: the OpenAI SDK (npm install openai) with baseURL "${META_BASE_URL}" and apiKey process.env.MODEL_API_KEY works, or fetch.`,
  curl: 'curl: export MODEL_API_KEY in the shell first and send -H "Authorization: Bearer $MODEL_API_KEY".',
};

/**
 * The Messages pages (protocols/messages, api-reference/messages/*) teach the Anthropic wire format, and their code
 * uses the Anthropic SDK: it takes the base host without /v1 (it adds /v1/messages itself) and the key as auth_token,
 * sent as a bearer token. Their setup says so instead of pointing the agent at the OpenAI SDK.
 */
const MESSAGES_PAGE = /^(protocols|api-reference)\/messages(\/|$)/;

const MESSAGES_LANGUAGE_SETUP: Record<PromptLanguage, string> = {
  python: `Python: the Anthropic SDK (pip install anthropic) with base_url="${ANTHROPIC_BASE}" (no /v1) and auth_token=os.environ["MODEL_API_KEY"], or plain requests to ${META_BASE_URL}/messages.`,
  typescript: `TypeScript: the Anthropic SDK (npm install @anthropic-ai/sdk) with baseURL "${ANTHROPIC_BASE}" (no /v1) and authToken process.env.MODEL_API_KEY, or fetch to ${META_BASE_URL}/messages.`,
  curl: LANGUAGE_SETUP.curl,
};

const CONTRIBUTOR_NOTE = " (Contributor mode: Meta may use what you send to train future models; drop -contributor for Standard mode)";

/**
 * The model a hosted prompt names: what the reader's request asked for (its body, before the docs' swap), else what
 * the proxy ran, else what the page is about (Muse Image, Voice Transcribe or SAM by the slug, the image recipes and
 * the sticker pack included), else Muse Spark 1.3 Contributor. muse-spark-1.3 itself is never named.
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

function hostedSetup(slug: string, model: string, language: PromptLanguage): string[] {
  const messages = MESSAGES_PAGE.test(slug);
  return [
    messages
      ? `Base URL: ${META_BASE_URL} for HTTP calls (POST ${META_BASE_URL}/messages); the Anthropic SDK takes ${ANTHROPIC_BASE}`
      : `Base URL: ${META_BASE_URL}`,
    "Auth: send Authorization: Bearer $MODEL_API_KEY, reading MODEL_API_KEY from the environment. Never hard-code, print or commit the key.",
    `Model: ${model}${model.endsWith("-contributor") ? CONTRIBUTOR_NOTE : ""}`,
    (messages ? MESSAGES_LANGUAGE_SETUP : LANGUAGE_SETUP)[language],
  ];
}

const MUSE_CLI_SETUP: readonly string[] = [
  "Muse Code: muse on PATH (install: curl -fsSL https://dev.meta.ai/install.sh | sh, or irm https://dev.meta.ai/install.ps1 | iex on Windows; check: muse --version). Its default model is muse-spark-1.2; --model picks another.",
  "Auth: muse reads META_API_KEY from the environment (in CI, from the secret store), else a key stored with muse auth set or a browser sign-in; not MODEL_API_KEY. Never hard-code, print or commit the key.",
];

const MUSE_CLI_LANGUAGE: Record<PromptLanguage, string> = {
  python: "Python: a plain script that runs muse through subprocess where a step needs it.",
  typescript: "TypeScript: a Node script that runs muse through node:child_process where a step needs it.",
  curl: "Shell: bash on macOS and Linux, PowerShell on Windows.",
};

/**
 * The open-weight pages run the model on the reader's hardware, so their Setup is the reader's own server (SGLang,
 * vLLM, llama.cpp, MLX and the rest serve the OpenAI-compatible /v1 these pages call), with no Model API base URL, key
 * or model id.
 */
const SELF_HOSTED_SETUP: readonly string[] = [
  "Server: the model runs on hardware you control, behind an OpenAI-compatible server (SGLang, vLLM, llama.cpp or another runtime this page covers). Code takes the server's base URL from configuration (such as http://127.0.0.1:8000/v1) and sends the model name it serves (GET <base URL>/models lists it).",
  "Auth: a local server takes any placeholder key unless it was started with one; read a real key, and any token a download needs, from the environment. Never hard-code, print or commit a key or token.",
];

const SELF_HOSTED_LANGUAGE: Record<PromptLanguage, string> = {
  python: "Python: the OpenAI SDK (pip install openai) with base_url set to the server's /v1 and a placeholder api_key, or plain requests.",
  typescript: "TypeScript: the OpenAI SDK (npm install openai) with baseURL set to the server's /v1 and a placeholder apiKey, or fetch.",
  curl: "Shell: bash on Linux and macOS; curl the server's /v1 with an Authorization header only when the server was started with a key.",
};

/** The "Done when" line about the credential, for each Setup. */
const KEY_CHECK: Record<PromptSetup, string> = {
  hosted: "The key comes from MODEL_API_KEY and never appears in code, logs or commits.",
  "muse-cli": "The key comes from META_API_KEY or a stored sign-in and never appears in code, logs or commits.",
  "self-hosted": "Any key or token comes from the environment and never appears in code, logs or commits.",
};

// ---------------------------------------------------------------------------------------------------------------
// The prompt

/** What I just ran, in parts that shrink on their own: the recorded body first, then the start of the reply. */
interface RanParts {
  head: string;
  /** A line under the head, such as the stand-in note on a self-hosted page. */
  note: string | null;
  /** The body as JSON or the multipart description; null when there is none or the starter code repeats it. */
  body: string | null;
  bodyIsStarter: boolean;
  result: string | null;
}

/** How long each section may be: whole (its full length) until the prompt is over PROMPT_MAX_CHARS. */
interface Budget {
  ranBody: number;
  ranResult: number;
  facts: number;
  snippet: number;
  task: number;
}

/**
 * The order sections give way when a prompt is too long, and how far each may shrink: the recorded run's body, then
 * the start of its reply, then the facts, then the starter code, then the task. Each takes only what is over, so a
 * long run never costs the page's own text room it doesn't need. Starter code written from the run (a page without
 * a snippet in the reader's language) is the run's too, so it gives way before the facts.
 */
const SHRINK_ORDER: ReadonlyArray<readonly [keyof Budget, number]> = [
  ["ranBody", 0],
  ["ranResult", 0],
  ["facts", 300],
  ["snippet", 300],
  ["task", 300],
];
const SHRINK_ORDER_RUN_CODE: ReadonlyArray<readonly [keyof Budget, number]> = [
  ["ranBody", 0],
  ["ranResult", 0],
  ["snippet", 300],
  ["facts", 300],
  ["task", 300],
];

const SELF_HOSTED_RUN_NOTE =
  "The docs sent it to hosted Muse Spark as a stand-in for the open weights; your own server takes the same messages under the model name it serves.";

/** The last request as "What I just ran" shows it. `snippetIsRun`: the starter code repeats its JSON body. */
function ranParts(request: RecordedRequest, snippetIsRun: boolean, selfHosted: boolean): RanParts {
  const path = request.path.replace(/^\/+/, "").replace(/^v1\//, "");
  const bodyIsStarter = snippetIsRun && request.body !== undefined && typeof request.body === "object";
  return {
    head: `${request.method} /v1/${path}${request.status ? ` returned HTTP ${request.status}` : ""}${request.model ? ` on ${modelForOwnKey(request.model)}` : ""}.`,
    note: selfHosted ? SELF_HOSTED_RUN_NOTE : null,
    body:
      request.body === undefined || bodyIsStarter
        ? null
        : noEmDash(typeof request.body === "string" ? request.body : json(trimBody(ownKeyModelBody(request.body)))),
    bodyIsStarter,
    result: request.outcome?.trim() ? noEmDash(request.outcome.trim().slice(0, 300)) : null,
  };
}

/** Builds the prompt. Always includes the page's Markdown URL; the last request only when one is passed. */
export function buildAgentPrompt({ page, spec, agent, language, lastRequest }: AgentPromptInput): string {
  const title = noEmDash(page.title);
  const description = noEmDash(page.description).trim();
  const kind = pageKind(page.slug);
  const fallback = fallbackFor(kind, page.slug, title, description);
  const task = noEmDash(spec?.task?.trim() || fallback.task);

  const own = noEmDash(spec?.snippets?.[language]?.trim() ?? "");
  // A self-hosted page's code talks to the reader's server, so the run (a hosted stand-in) never becomes its code.
  const selfHosted = hostingFor(kind, spec) === "self-hosted";
  // Without a snippet of the page's own, the starter code repeats the request the reader ran.
  const snippetIsRun = !own && Boolean(lastRequest) && !selfHosted;
  const snippet = snippetIsRun && lastRequest ? noEmDash(codeForRequest(lastRequest, language)) : own;
  const setup = setupFor(kind, spec, snippet);
  const languageName = setup !== "hosted" && language === "curl" ? "shell" : LANGUAGE_NAME[language];

  const setupLines =
    setup === "muse-cli"
      ? [...MUSE_CLI_SETUP, MUSE_CLI_LANGUAGE[language]]
      : setup === "self-hosted"
        ? [...SELF_HOSTED_SETUP, SELF_HOSTED_LANGUAGE[language]]
        : hostedSetup(page.slug, modelFor(page.slug, lastRequest), language);

  const done = [
    ...(spec?.checklist?.length ? spec.checklist : fallback.done),
    KEY_CHECK[setup],
    ...(setup === "hosted" && (CALLS_THE_API.has(kind) || kind === "open-weight")
      ? ["API errors (4xx, 429) surface their message instead of failing silently."]
      : []),
  ].map(noEmDash);

  const facts = spec?.facts?.length ? bullets(spec.facts.map(noEmDash)).join("\n") : "";

  const ran = lastRequest ? ranParts(lastRequest, snippetIsRun, selfHosted) : null;

  const ranText = (b: Budget) =>
    ran
      ? [
          ran.head,
          ...(ran.note ? [ran.note] : []),
          ...(ran.bodyIsStarter ? ["The starter code below sends the same body."] : []),
          ...(ran.body !== null ? ["Body:", clip(ran.body, b.ranBody)] : []),
          ...(ran.result ? [`Result: ${clip(ran.result, b.ranResult)}`] : []),
        ].join("\n")
      : "";

  const intro = INTRO[agent] + (agent === "muse-code" && setup === "hosted" ? MUSE_CODE_ON_HOSTED : "");
  const render = (b: Budget) =>
    noEmDash(
      [
        intro,
        section("Task", [clip(task, b.task)]),
        section("Read this first", [
          `Meta's docs page "${title}" as Markdown: ${page.markdownUrl}`,
          `It's the source of truth for request and response shapes. The same page for people: ${page.sourceUrl}`,
        ]),
        section("Setup", bullets(setupLines)),
        ...(facts ? [section("Facts to get right", [clip(facts, b.facts)])] : []),
        ...(ran ? [section("What I just ran in the docs", [ranText(b)])] : []),
        snippet
          ? section(`Starter code (${languageName})`, [clip(snippet, b.snippet)])
          : section("Starter code", [`Start from the page's ${languageName} example, if it has one.`]),
        section("Done when", bullets(done)),
      ].join("\n\n"),
    );

  // Everything whole when it fits; otherwise each section in SHRINK_ORDER gives up what is over, down to its floor.
  const whole: Budget = {
    ranBody: ran?.body?.length ?? 0,
    ranResult: ran?.result?.length ?? 0,
    facts: facts.length,
    snippet: snippet.length,
    task: task.length,
  };
  let budget = whole;
  let text = render(budget);
  for (const [part, floor] of snippetIsRun ? SHRINK_ORDER_RUN_CODE : SHRINK_ORDER) {
    const over = text.length - PROMPT_MAX_CHARS;
    if (over <= 0) break;
    if (whole[part] <= floor) continue;
    budget = { ...budget, [part]: Math.max(floor, whole[part] - over) };
    text = render(budget);
  }
  return text.length <= PROMPT_MAX_CHARS ? text : clip(text, PROMPT_MAX_CHARS);
}
