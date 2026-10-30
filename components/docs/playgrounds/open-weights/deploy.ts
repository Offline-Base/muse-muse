import { shq } from "@/components/docs/playgrounds/open-weights/shell";

/**
 * The shape every runtime in the deploy builders shares (muse-spark-open/deploy, muse-glimmer/deploy): its options as
 * data, a build() that turns the picked values into the page's commands, and the client the started server answers.
 * The runtimes themselves are in deploy-spark.ts and deploy-glimmer.ts; this file has the types, the option
 * defaults, and the client code (Python, TypeScript, curl) for any OpenAI-compatible server.
 */

export type OptionValue = string | number | boolean;
export type Values = Record<string, OptionValue>;

export interface OptionSpec {
  id: string;
  label: string;
  kind: "segmented" | "select" | "toggle" | "number" | "text";
  choices?: ReadonlyArray<{ value: string; label: string }>;
  default: OptionValue;
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Shown only when this holds for the current values. */
  when?: (v: Values) => boolean;
}

export type CodeLang = "bash" | "yaml" | "python" | "typescript" | "json" | "text" | "powershell";

export interface CodeStep {
  title: string;
  lang: CodeLang;
  code: string;
  note?: string;
}

export type Json = Record<string, unknown>;

export interface ClientSpec {
  /** "http://127.0.0.1:30000/v1" */
  baseUrl: string;
  /** The name the server answers to; null means ask /v1/models for it, as the SGLang example does. */
  model: string | null;
  /** Read the model id from this env var instead (Unsloth's UNSLOTH_MODEL_ID). */
  modelEnv?: string;
  /** The env var holding the server's own key, when it checks one (llama.cpp --api-key, Unsloth). */
  keyEnv: string | null;
  /** What to send when the server checks no key ("null", "unused", "ollama"). */
  keyPlaceholder: string;
  /** Where the reasoning text lands in the reply, per the page, first match wins. Empty when the page doesn't say. */
  reasoningFields: string[];
  /** Body fields the page sends: reasoning_effort, chat_template_kwargs, sampling, Unsloth's min_p. */
  extra: Json;
  maxTokens: number | null;
  /** curl --noproxy '*', which the llama.cpp smoke tests use so a proxy can't intercept loopback. */
  noProxy?: boolean;
  /** OpenAI client timeout in seconds (the SGLang example sets 600 for long reasoning). */
  timeoutSec?: number;
  /** The prompt the page's own request for this runtime sends. */
  examplePrompt?: string;
  notes?: string[];
}

export interface DeployPlan {
  steps: CodeStep[];
  client: ClientSpec | null;
  notes: string[];
  warnings: string[];
  /** Combinations the page says fail outright. */
  errors: string[];
}

export interface RuntimeDef {
  id: string;
  label: string;
  /** The page's "Best for" line. */
  bestFor: string;
  /** The page's anchor for the runtime's section. */
  anchor: string;
  /** "self-host" runtimes start a server or script; "hosted" ones are providers. */
  group: "self-host" | "hosted";
  options: OptionSpec[];
  build(v: Values): DeployPlan;
}

/** Every option at its default. */
export function defaultsOf(options: OptionSpec[]): Values {
  return Object.fromEntries(options.map((o) => [o.id, o.default]));
}

/** The options to show for these values. */
export function visibleOptions(options: OptionSpec[], v: Values): OptionSpec[] {
  return options.filter((o) => !o.when || o.when(v));
}

/** Reads a number option, falling back to its default when the box holds something else. */
export function num(v: Values, id: string, fallback: number): number {
  const x = v[id];
  const value = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : NaN;
  return Number.isFinite(value) ? value : fallback;
}

export function str(v: Values, id: string, fallback = ""): string {
  const x = v[id];
  return typeof x === "string" ? x : typeof x === "number" ? String(x) : fallback;
}

export function bool(v: Values, id: string): boolean {
  return v[id] === true;
}

export function emptyPlan(): DeployPlan {
  return { steps: [], client: null, notes: [], warnings: [], errors: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// Client code for the started server

export interface ClientCode {
  python: string;
  typescript: string;
  curl: string;
}

/** Sampling fields read as floats on the pages (temperature 1.0, top_p 1.0, min_p 0.0), so whole numbers keep a ".0". */
const FLOAT_KEYS = /("(?:temperature|top_p|min_p)": )(-?\d+)(?=[,\n\r}\s])/g;

export function floatJson(text: string): string {
  return text.replace(FLOAT_KEYS, "$1$2.0");
}

function pyFloat(key: string, value: unknown): string | null {
  return (key === "temperature" || key === "top_p" || key === "min_p") && typeof value === "number" && Number.isInteger(value) ? `${value}.0` : null;
}

function pyLiteral(value: unknown, indent = "    "): string {
  return floatJson(JSON.stringify(value, null, 4))
    .replace(/("(?:[^"\\]|\\.)*")|\b(true|false|null)\b/g, (_whole, s: string | undefined, w: string | undefined) =>
      s ? s : w === "true" ? "True" : w === "false" ? "False" : "None",
    )
    .replace(/\n/g, `\n${indent}`);
}

/** Standard Chat Completions fields the OpenAI SDK takes as keyword arguments; the rest go in extra_body. */
const SDK_FIELDS = new Set(["temperature", "top_p", "max_tokens", "reasoning_effort", "stream", "tools", "tool_choice", "response_format"]);

/** The request body the client code sends. */
export function clientBody(c: ClientSpec, prompt: string, stream: boolean): Json {
  return {
    model: c.model ?? (c.modelEnv ? `$${c.modelEnv}` : "<model id from /v1/models>"),
    messages: [{ role: "user", content: prompt }],
    ...(c.maxTokens ? { max_tokens: c.maxTokens } : {}),
    ...c.extra,
    ...(stream ? { stream: true } : {}),
  };
}

function pyReasoning(obj: string, fields: string[]): string {
  return fields.map((f) => `getattr(${obj}, ${JSON.stringify(f)}, None)`).join(" or ");
}

function tsReasoning(obj: string, fields: string[]): string {
  return fields.map((f) => `${obj}.${f}`).join(" ?? ");
}

export function clientCode(c: ClientSpec, prompt: string, stream: boolean): ClientCode {
  const base = c.baseUrl.replace(/\/+$/, "");
  const extras = Object.entries(c.extra);
  const sdkArgs = extras.filter(([k]) => SDK_FIELDS.has(k));
  const extraBody = Object.fromEntries(extras.filter(([k]) => !SDK_FIELDS.has(k)));
  const fields = c.reasoningFields;

  // Python, with the OpenAI SDK pointed at the server, as the pages' own scripts do.
  const py: string[] = [];
  if (c.keyEnv || c.modelEnv) py.push("import os", "");
  py.push("from openai import OpenAI", "");
  py.push(
    "client = OpenAI(",
    `    base_url=${JSON.stringify(base)},`,
    c.keyEnv ? `    api_key=os.environ[${JSON.stringify(c.keyEnv)}],` : `    api_key=${JSON.stringify(c.keyPlaceholder)},  # this server doesn't check the key`,
    ...(c.timeoutSec ? [`    timeout=${c.timeoutSec.toFixed(1)},`] : []),
    ")",
  );
  py.push(
    c.model
      ? `model = ${JSON.stringify(c.model)}`
      : c.modelEnv
        ? `model = os.environ[${JSON.stringify(c.modelEnv)}]`
        : "model = client.models.list().data[0].id  # the model the server is serving",
    "",
  );
  py.push(
    `${stream ? "stream" : "response"} = client.chat.completions.create(`,
    "    model=model,",
    `    messages=[{"role": "user", "content": ${JSON.stringify(prompt)}}],`,
    ...(c.maxTokens ? [`    max_tokens=${c.maxTokens},`] : []),
    ...sdkArgs.map(([k, v]) => `    ${k}=${pyFloat(k, v) ?? pyLiteral(v)},`),
    ...(Object.keys(extraBody).length ? [`    extra_body=${pyLiteral(extraBody)},`] : []),
    ...(stream ? ["    stream=True,"] : []),
    ")",
  );
  if (stream) {
    py.push(
      "for chunk in stream:",
      "    if not chunk.choices:",
      "        continue",
      "    delta = chunk.choices[0].delta",
      ...(fields.length ? [`    thinking = ${pyReasoning("delta", fields)}`, "    if thinking:", '        print(thinking, end="", flush=True)'] : []),
      "    if delta.content:",
      '        print(delta.content, end="", flush=True)',
    );
  } else {
    py.push(
      "choice = response.choices[0]",
      ...(fields.length ? [`print("Reasoning:", ${pyReasoning("choice.message", fields)})`] : []),
      'print("Content:", choice.message.content)',
      'print("Finish reason:", choice.finish_reason)',
    );
  }

  // TypeScript, with fetch, so nonstandard fields (chat_template_kwargs, min_p) need no SDK casts.
  const body = clientBody(c, prompt, stream);
  const auth = c.keyEnv ? "Authorization: `Bearer ${process.env." + c.keyEnv + "}`" : null;
  const headers = ['"Content-Type": "application/json"', ...(auth ? [auth] : [])];
  const ts: string[] = [`const BASE_URL = ${JSON.stringify(base)};`];
  let modelExpr = c.model ? JSON.stringify(c.model) : "model";
  if (!c.model && c.modelEnv) {
    ts.push(`const model = process.env.${c.modelEnv}!;`);
  } else if (!c.model) {
    ts.push(
      "",
      `const listed = await fetch(\`\${BASE_URL}/models\`${auth ? `, { headers: { ${auth} } }` : ""});`,
      "const model: string = (await listed.json()).data[0].id;",
    );
  } else modelExpr = JSON.stringify(c.model);
  const tsBody = floatJson(JSON.stringify({ ...body, model: "__MODEL__" }, null, 2)).replace('"__MODEL__"', modelExpr).replace(/\n/g, "\n  ");
  ts.push(
    "",
    "const response = await fetch(`${BASE_URL}/chat/completions`, {",
    '  method: "POST",',
    `  headers: { ${headers.join(", ")} },`,
    `  body: JSON.stringify(${tsBody}),`,
    "});",
    "if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);",
  );
  if (stream) {
    ts.push(
      "",
      "// Server-sent events: one JSON chunk per data: line, then data: [DONE].",
      "const reader = response.body!.getReader();",
      "const decoder = new TextDecoder();",
      'let buffer = "";',
      "for (;;) {",
      "  const { done, value } = await reader.read();",
      "  if (done) break;",
      "  buffer += decoder.decode(value, { stream: true });",
      '  const lines = buffer.split("\\n");',
      '  buffer = lines.pop() ?? "";',
      "  for (const line of lines) {",
      '    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;',
      "    const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta ?? {};",
      ...(fields.length ? [`    const thinking = ${tsReasoning("delta", fields)};`, "    if (thinking) process.stdout.write(thinking);"] : []),
      "    if (delta.content) process.stdout.write(delta.content);",
      "  }",
      "}",
    );
  } else {
    ts.push(
      "const { choices } = await response.json();",
      ...(fields.length ? [`console.log("Reasoning:", ${tsReasoning("choices[0].message", fields)});`] : []),
      'console.log("Content:", choices[0].message.content);',
      'console.log("Finish reason:", choices[0].finish_reason);',
    );
  }

  // curl, the way the pages' smoke tests send it. An env-var model id ("$UNSLOTH_MODEL_ID") needs double quotes to
  // expand, so that body is escaped for them instead of single-quoted.
  const json = floatJson(JSON.stringify(body, null, 2));
  const data = c.modelEnv && !c.model ? `"${json.replace(/(["\\`])/g, "\\$1")}"` : shq(json);
  const curl = [
    `curl -s${c.noProxy ? " --noproxy '*'" : ""}${stream ? " -N" : ""} ${base}/chat/completions`,
    `  -H "Content-Type: application/json"`,
    ...(c.keyEnv ? [`  -H "Authorization: Bearer $${c.keyEnv}"`] : []),
    `  -d ${data}`,
  ].join(" \\\n");
  return { python: py.join("\n"), typescript: ts.join("\n"), curl };
}
