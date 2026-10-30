/**
 * A mini agent loop for the agent-frameworks page, as pure steps the demo drives through the docs proxy: the model
 * gets three tools over a small fake repository (read a file, edit a file, run a command), the page runs each tool
 * call locally and sends the result back, and the loop ends on the model's final answer, the way a framework owns the
 * loop (content/meta-docs/pages/agent-frameworks.md "How it works"). Two wire formats, as on the page:
 *
 * - Messages, the Claude Agent SDK's: tools with input_schema, tool_use blocks, tool_result blocks in a user turn, the
 *   whole history resent each call; tool names Read, Edit and Bash like the SDK's own.
 * - Responses, the Codex app-server's: flat function tools, function_call items, function_call_output items chained
 *   with previous_response_id; tool names read_file, edit_file and exec_command.
 *
 * The repository and the shell (sim-shell.ts) are simulated in the browser: nothing runs on a machine.
 */

import { simShell } from "@/components/docs/playgrounds/muse-code/sim-shell";

export type LoopProtocol = "messages" | "responses";

export type Files = Record<string, string>;

export const REPO: Files = {
  "README.md": "# signup-service\n\nA small HTTP service that registers users.\n\n- npm start: run the server on port 3000\n- npm test: run the tests in test/\n",
  "package.json": `${JSON.stringify({ name: "signup-service", version: "0.3.1", type: "module", scripts: { start: "node src/server.js", test: "node --test test/" } }, null, 2)}\n`,
  "src/server.js":
    'import http from "node:http";\nimport { signup } from "./signup.js";\n\nhttp\n  .createServer(async (req, res) => {\n    if (req.method === "POST" && req.url === "/signup") {\n      let raw = "";\n      for await (const chunk of req) raw += chunk;\n      const { status, body } = signup(JSON.parse(raw || "{}"));\n      res.writeHead(status, { "content-type": "application/json" });\n      res.end(JSON.stringify(body));\n      return;\n    }\n    res.writeHead(404).end();\n  })\n  .listen(3000);\n',
  "src/signup.js":
    "// Registers a user. Called by src/server.js for POST /signup.\nexport function signup(body) {\n  const user = { email: body.email, password: body.password };\n  return { status: 201, body: { id: 1, email: user.email } };\n}\n",
  "test/signup.test.js":
    'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { signup } from "../src/signup.js";\n\ntest("accepts a valid signup", () => {\n  assert.equal(signup({ email: "ada@example.com", password: "correct-horse" }).status, 201);\n});\n\ntest("rejects an email without @", () => {\n  assert.equal(signup({ email: "ada.example.com", password: "correct-horse" }).status, 400);\n});\n\ntest("rejects a password under 8 characters", () => {\n  assert.equal(signup({ email: "ada@example.com", password: "short" }).status, 400);\n});\n',
};

export interface ToolNames {
  read: string;
  edit: string;
  shell: string;
}

export const NAMES: Record<LoopProtocol, ToolNames> = {
  messages: { read: "Read", edit: "Edit", shell: "Bash" },
  responses: { read: "read_file", edit: "edit_file", shell: "exec_command" },
};

interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

function specs(p: LoopProtocol): ToolSpec[] {
  const n = NAMES[p];
  const path = p === "messages" ? "file_path" : "path";
  const oldKey = p === "messages" ? "old_string" : "old_text";
  const newKey = p === "messages" ? "new_string" : "new_text";
  return [
    {
      name: n.read,
      description: "Read a file in the repository. Paths are relative to the repo root, such as src/signup.js.",
      schema: { type: "object", properties: { [path]: { type: "string" } }, required: [path], additionalProperties: false },
    },
    {
      name: n.edit,
      description: "Replace one exact, unique snippet of a file with new text. Read the file first.",
      schema: {
        type: "object",
        properties: { [path]: { type: "string" }, [oldKey]: { type: "string" }, [newKey]: { type: "string" } },
        required: [path, oldKey, newKey],
        additionalProperties: false,
      },
    },
    {
      name: n.shell,
      description: "Run a shell command in the repo root: ls, find, cat, head, tail, wc, grep, sed -n, git status, git diff, npm test and pipes between them.",
      schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
    },
  ];
}

/** The tool definitions in each wire format. */
export function toolDefs(p: LoopProtocol): Record<string, unknown>[] {
  return specs(p).map((s) =>
    p === "messages" ? { name: s.name, description: s.description, input_schema: s.schema } : { type: "function", name: s.name, description: s.description, parameters: s.schema, strict: true },
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The fake shell and tools

export interface ToolRun {
  output: string;
  isError: boolean;
  files: Files;
}

function lines(text: string): number {
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** The simulated test runner: checks the handler for the validation the three tests expect. */
export function runTests(files: Files): { output: string; failed: number } {
  // Comments don't count: only code that checks for "@" and a password length, and answers 400, passes.
  const src = (files["src/signup.js"] ?? "").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const returns400 = /\b400\b/.test(src);
  const checksAt = src.includes("@");
  const checksLength = /\.length\s*[<>]=?\s*\d+|\d+\s*[<>]=?\s*[\w.?]*\.length/.test(src);
  const valid = /\b201\b/.test(src);
  const results = [
    { name: "accepts a valid signup", ok: valid },
    { name: "rejects an email without @", ok: returns400 && checksAt },
    { name: "rejects a password under 8 characters", ok: returns400 && checksLength },
  ];
  const failed = results.filter((r) => !r.ok).length;
  const out = [
    "> signup-service@0.3.1 test",
    "> node --test test/",
    "",
    ...results.map((r, i) => `${r.ok ? "ok" : "not ok"} ${i + 1} - ${r.name}`),
    "",
    `# tests 3`,
    `# pass ${3 - failed}`,
    `# fail ${failed}`,
  ].join("\n");
  return { output: out, failed };
}

/** Runs one tool call against the fake repository. Unknown tools and bad arguments come back as errors the model sees. */
export function runTool(p: LoopProtocol, name: string, args: Record<string, unknown>, files: Files): ToolRun {
  const n = NAMES[p];
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof args[k] === "string") return args[k] as string;
    return undefined;
  };
  const rawPath = pick("file_path", "path", "file", "filename", "filepath") ?? "";
  const path = rawPath.replace(/^\.\//, "").replace(/^\/workspace\/signup-service\//, "");
  if (name === n.read) {
    if (!rawPath) return { output: `Missing ${p === "messages" ? "file_path" : "path"}.`, isError: true, files };
    if (!(path in files)) return { output: `No such file: ${path}. Files: ${Object.keys(files).sort().join(", ")}`, isError: true, files };
    const numbered = files[path]
      .split("\n")
      .map((l, i) => `${String(i + 1).padStart(4)}\t${l}`)
      .join("\n");
    return { output: numbered, isError: false, files };
  }
  if (name === n.edit) {
    const oldText = pick("old_string", "old_text", "old", "search") ?? "";
    const newText = pick("new_string", "new_text", "new", "replace") ?? "";
    if (!rawPath) return { output: `Missing ${p === "messages" ? "file_path" : "path"}: say which file to edit.`, isError: true, files };
    if (!(path in files)) return { output: `No such file: ${path}. Files: ${Object.keys(files).sort().join(", ")}`, isError: true, files };
    const count = oldText ? files[path].split(oldText).length - 1 : 0;
    if (count !== 1) return { output: count ? `The text to replace appears ${count} times in ${path}; give a unique snippet.` : `The text to replace isn't in ${path}. Read the file and copy it exactly.`, isError: true, files };
    const next = { ...files, [path]: files[path].replace(oldText, newText) };
    return { output: `Edited ${path}: replaced ${lines(oldText)} line(s) with ${lines(newText)}.`, isError: false, files: next };
  }
  if (name === n.shell) return simShell(pick("command", "cmd") ?? "", files, { original: REPO, runTests });
  return { output: `Unknown tool ${name}.`, isError: true, files };
}

// ---------------------------------------------------------------------------------------------------------------
// Requests and replies

export interface LoopConfig {
  protocol: LoopProtocol;
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface Call {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** The raw arguments when they weren't valid JSON. */
  bad?: string;
}

export interface Reply {
  text: string;
  calls: Call[];
  /** Messages: the assistant content to resend. Responses: the response id to chain from. */
  assistant: unknown[];
  responseId: string | null;
  stop: string | null;
  usage: Record<string, unknown> | null;
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

export function readReply(p: LoopProtocol, json: unknown): Reply {
  const r = obj(json) ?? {};
  if (p === "messages") {
    const content = Array.isArray(r.content) ? (r.content as unknown[]) : [];
    const blocks = content.map(obj).filter((b): b is Json => b !== null);
    return {
      text: blocks
        .filter((b) => b.type === "text")
        .map((b) => String(b.text ?? ""))
        .join(""),
      calls: blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: String(b.id), name: String(b.name), args: obj(b.input) ?? {} })),
      assistant: content,
      responseId: typeof r.id === "string" ? r.id : null,
      stop: typeof r.stop_reason === "string" ? r.stop_reason : null,
      usage: obj(r.usage),
    };
  }
  const output = (Array.isArray(r.output) ? (r.output as unknown[]) : []).map(obj).filter((o): o is Json => o !== null);
  const calls: Call[] = output
    .filter((o) => o.type === "function_call")
    .map((o) => {
      const raw = String(o.arguments ?? "{}");
      try {
        return { id: String(o.call_id), name: String(o.name), args: obj(JSON.parse(raw)) ?? {} };
      } catch {
        return { id: String(o.call_id), name: String(o.name), args: {}, bad: raw };
      }
    });
  const text = output
    .filter((o) => o.type === "message")
    .flatMap((o) => (Array.isArray(o.content) ? (o.content as unknown[]).map(obj) : []))
    .map((c) => (typeof c?.text === "string" ? c.text : ""))
    .join("");
  return { text, calls, assistant: [], responseId: typeof r.id === "string" ? r.id : null, stop: typeof r.status === "string" ? r.status : null, usage: obj(r.usage) };
}

/** Messages history: the user's prompt, then each assistant turn and the tool results that answer it. */
export type History = Array<{ role: "user" | "assistant"; content: unknown }>;

export function firstBody(c: LoopConfig): Json {
  if (c.protocol === "messages") {
    return { model: c.model, max_tokens: c.maxTokens, system: c.system, tools: toolDefs("messages"), messages: [{ role: "user", content: c.prompt }] };
  }
  return { model: c.model, instructions: c.system, input: c.prompt, tools: toolDefs("responses"), reasoning: { effort: "low" }, max_output_tokens: c.maxTokens };
}

export interface ToolResult {
  callId: string;
  output: string;
  isError: boolean;
}

/** The next request after tool results: the whole history on Messages, previous_response_id plus outputs on Responses. */
export function nextBody(c: LoopConfig, history: History, reply: Reply, results: ToolResult[]): { body: Json; history: History } {
  if (c.protocol === "messages") {
    const next: History = [
      ...history,
      { role: "assistant", content: reply.assistant },
      { role: "user", content: results.map((r) => ({ type: "tool_result", tool_use_id: r.callId, content: r.output, ...(r.isError ? { is_error: true } : {}) })) },
    ];
    return { body: { model: c.model, max_tokens: c.maxTokens, system: c.system, tools: toolDefs("messages"), messages: next }, history: next };
  }
  return {
    body: {
      model: c.model,
      instructions: c.system,
      previous_response_id: reply.responseId,
      input: results.map((r) => ({ type: "function_call_output", call_id: r.callId, output: r.output })),
      tools: toolDefs("responses"),
      reasoning: { effort: "low" },
      max_output_tokens: c.maxTokens,
    },
    history,
  };
}

export function initialHistory(c: LoopConfig): History {
  return [{ role: "user", content: c.prompt }];
}

/** Adds up token usage across the loop's calls, whichever protocol's shape it came in. */
export function addUsage(total: { input: number; output: number }, usage: Record<string, unknown> | null): { input: number; output: number } {
  if (!usage) return total;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const input = n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens);
  return { input: total.input + input, output: total.output + n(usage.output_tokens) };
}

export const LOOP_TASKS: ReadonlyArray<{ label: string; prompt: string }> = [
  { label: "Summarize this repo", prompt: "Summarize this repo." },
  { label: "Add input validation and run the tests", prompt: "Add input validation to the signup handler and run the tests." },
];

export const LOOP_SYSTEM = "You are a coding agent. Make minimal, well-tested changes. Use the tools to look before you answer, and keep the final answer short.";

/**
 * Whether a failed call is worth retrying with backoff, as the page's production patterns advise for dropped streams
 * and 502s. Meta's stored-response chaining also answered a 503 "persistence service error" and a 400 "referenced
 * response not found" for a response made seconds earlier (seen through the docs proxy, Oct 30, 2026); both cleared
 * on a retry. The proxy's own pauses and every rate limit are never retried, and neither is a call the reader stopped:
 * the kit reports Stop (and a watchdog's abort) as status 0 with code "aborted", which would otherwise read as a
 * dropped connection and send the cancelled call again.
 */
export function isTransient(status: number, code: string | undefined, message: string | undefined, chained: boolean): boolean {
  if (code === "aborted") return false;
  if (code === "docs_paused" || code === "paid_paused" || code === "model_busy" || code === "uploads_busy") return false;
  if (status === 0 || status === 502 || status === 503 || status === 504) return true;
  return chained && status === 400 && /referenced response not found/i.test(message ?? "");
}

export const RETRY_DELAYS_MS: readonly number[] = [2000, 5000, 10000];

/** What callWithRetries needs from a call's result (a DocsResult has all of it). */
export interface RetryableResult {
  ok: boolean;
  status: number;
  error?: { code?: string; message?: string } | null;
}

export interface RetryHooks {
  /** True once the reader pressed Stop: no attempt starts after that. */
  stopped(): boolean;
  /** The wait between attempts. Stop may end it early; the next attempt still checks stopped() first. */
  sleep(ms: number): Promise<void>;
  /** Called before each wait, to say a retry is coming. */
  onRetry?(attempt: number, waitMs: number, failed: RetryableResult): void;
}

/**
 * One call with the backoff above: transient failures are tried again after 2, 5 and 10 seconds. A stopped call is
 * never re-sent, and once Stop is pressed (even during a wait) no new attempt starts, so a cancelled turn costs
 * nothing more. Returns the last result; the caller reads hooks.stopped() to tell a stop from a failure.
 */
export async function callWithRetries<R extends RetryableResult>(call: () => Promise<R>, chained: boolean, hooks: RetryHooks): Promise<R> {
  let res = await call();
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (res.ok || hooks.stopped() || !isTransient(res.status, res.error?.code, res.error?.message, chained)) return res;
    const wait = RETRY_DELAYS_MS[attempt];
    hooks.onRetry?.(attempt + 1, wait, res);
    await hooks.sleep(wait);
    if (hooks.stopped()) return res;
    res = await call();
  }
  return res;
}

/** The line a demo shows while it waits to retry, so the reader knows a call is coming and that Stop cancels it. */
export function retryMessage(attempt: number, waitMs: number, failed: RetryableResult): string {
  const what = failed.status ? `The API answered ${failed.status}${failed.error?.message ? ` (${failed.error.message})` : ""}` : "The connection dropped";
  return `${what}, which usually clears on a retry. Trying again in ${waitMs / 1000} s (attempt ${attempt + 1} of ${RETRY_DELAYS_MS.length + 1}). Stop cancels it.`;
}

/**
 * A wait that Stop can cut short: resolves after `ms`, or as soon as cancel() runs. The demos keep the cancel in a
 * ref so their Stop button ends a backoff at once instead of leaving the reader waiting on a retry that won't come.
 */
export function pausable(ms: number): { done: Promise<void>; cancel(): void } {
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    finish = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { done, cancel: () => finish() };
}
