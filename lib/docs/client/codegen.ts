import { mimeOfName, placeholderFileName, type FormSpec } from "@/lib/docs/client/form";
import { RETIRED_SPARK, SPARK_STANDIN } from "@/lib/meta/spark";

/**
 * A docs request as copy-paste code: curl, Python (the OpenAI SDK or requests) and TypeScript (the OpenAI SDK or
 * fetch), in the style of Meta's own examples. Messages requests use the Anthropic SDK, pointed at
 * https://api.meta.ai because that SDK appends /v1/messages itself (sdks page). The key always comes from the
 * MODEL_API_KEY environment variable: nothing here ever holds a key, and no generated line can contain one.
 */

export const API_BASE = "https://api.meta.ai/v1";

/**
 * A body as the reader's own code should send it. The live docs run Meta's muse-spark-1.3 as muse-spark-1.3-contributor
 * on Muse Muse's key, so a demo's body carries the Contributor id; copy-paste code keeps Meta's muse-spark-1.3
 * (docs/DOCS_MIRROR.md, rules), so an app built from it doesn't send its users' data to Contributor mode by default.
 * Returns the same object when there's nothing to change.
 */
export function standardModelBody<T>(body: T): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const model = (body as { model?: unknown }).model;
  return model === SPARK_STANDIN ? ({ ...body, model: RETIRED_SPARK } as T) : body;
}
export const ANTHROPIC_BASE = "https://api.meta.ai";

export type CodeLang = "curl" | "python" | "typescript";
export type CodeFlavor = "sdk" | "http";

export interface CodeRequest {
  method: "GET" | "POST" | "DELETE";
  /** Meta's path, such as "responses" or "files/file-abc/content", with an optional query string. */
  path: string;
  body?: unknown;
  form?: FormSpec[];
  /** Read the reply as server-sent events. Defaults to body.stream === true. */
  stream?: boolean;
}

export interface CodeSample {
  lang: CodeLang;
  flavor: CodeFlavor;
  /** "curl", "Python (OpenAI SDK)", "Python (requests)", "TypeScript (fetch)", "Python (Anthropic SDK)" ... */
  label: string;
  /** The code block's language label: bash, python or typescript. */
  syntax: "bash" | "python" | "typescript";
  code: string;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------------------------------------------
// Requests

interface Parsed {
  method: CodeRequest["method"];
  pathname: string;
  query: string;
  url: string;
  body: unknown;
  form: FormSpec[] | null;
  stream: boolean;
  endpoint: Endpoint;
}

type Endpoint =
  | { kind: "responses.create" | "responses.input_tokens" | "chat.create" | "messages.create" | "messages.count_tokens" }
  | { kind: "images.generate" | "images.edit" | "asr.transcribe" | "status" | "models.list" | "files.create" | "files.list" }
  | { kind: "responses.retrieve" | "responses.delete" | "responses.cancel"; id: string }
  | { kind: "models.retrieve" | "files.retrieve" | "files.content" | "files.delete"; id: string }
  | { kind: "other" };

function endpointOf(method: string, pathname: string): Endpoint {
  const p = pathname.split("/");
  const two = p.length === 2;
  if (method === "POST") {
    if (pathname === "responses") return { kind: "responses.create" };
    if (pathname === "responses/input_tokens") return { kind: "responses.input_tokens" };
    if (p.length === 3 && p[0] === "responses" && p[2] === "cancel") return { kind: "responses.cancel", id: p[1] };
    if (pathname === "chat/completions") return { kind: "chat.create" };
    if (pathname === "messages") return { kind: "messages.create" };
    if (pathname === "messages/count_tokens") return { kind: "messages.count_tokens" };
    if (pathname === "files") return { kind: "files.create" };
    if (pathname === "images/generations") return { kind: "images.generate" };
    if (pathname === "images/edits") return { kind: "images.edit" };
    if (pathname === "asr/transcribe") return { kind: "asr.transcribe" };
  }
  if (method === "GET") {
    if (pathname === "status") return { kind: "status" };
    if (pathname === "models") return { kind: "models.list" };
    if (two && p[0] === "models") return { kind: "models.retrieve", id: p[1] };
    if (pathname === "files") return { kind: "files.list" };
    if (two && p[0] === "files") return { kind: "files.retrieve", id: p[1] };
    if (p.length === 3 && p[0] === "files" && p[2] === "content") return { kind: "files.content", id: p[1] };
    if (two && p[0] === "responses" && p[1] !== "input_tokens") return { kind: "responses.retrieve", id: p[1] };
  }
  if (method === "DELETE") {
    if (two && p[0] === "responses") return { kind: "responses.delete", id: p[1] };
    if (two && p[0] === "files") return { kind: "files.delete", id: p[1] };
  }
  return { kind: "other" };
}

function parse(req: CodeRequest): Parsed {
  const clean = req.path.trim().replace(/^\/+/, "").replace(/^v1\//, "");
  const q = clean.indexOf("?");
  const pathname = (q < 0 ? clean : clean.slice(0, q)).replace(/\/+$/, "");
  const query = q < 0 ? "" : clean.slice(q + 1);
  const form = req.form?.length ? req.form : null;
  const body = form ? undefined : req.body;
  return {
    method: req.method,
    pathname,
    query,
    url: `${API_BASE}/${pathname}${query ? `?${query}` : ""}`,
    body,
    form,
    stream: req.stream ?? (isObj(body) && body.stream === true),
    endpoint: endpointOf(req.method, pathname),
  };
}

/** Which streaming protocol to print deltas for. */
function streamKind(p: Parsed): "responses" | "chat" | "messages" | "other" {
  if (p.pathname === "responses") return "responses";
  if (p.pathname === "chat/completions") return "chat";
  if (p.pathname === "messages") return "messages";
  return "other";
}

const BINARY_OUT = "content.bin";

// ---------------------------------------------------------------------------------------------------------------
// Literals

/** A Python string literal. JSON's escapes are all valid Python escapes. */
function pyString(s: string): string {
  return JSON.stringify(s);
}

const PY4 = "    ";

/** A Python literal for JSON, laid out like Meta's examples: one item per line, trailing commas. */
export function pyValue(v: unknown, level = 0): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "None";
  if (typeof v === "string") return pyString(v);
  const pad = PY4.repeat(level + 1);
  const end = PY4.repeat(level);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return `[\n${v.map((x) => `${pad}${pyValue(x, level + 1)},\n`).join("")}${end}]`;
  }
  if (isObj(v)) {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    if (!entries.length) return "{}";
    return `{\n${entries.map(([k, x]) => `${pad}${pyString(k)}: ${pyValue(x, level + 1)},\n`).join("")}${end}}`;
  }
  return pyString(String(v));
}

/** A TypeScript string literal: single quotes like Meta's examples, double quotes when that saves escaping. */
function tsString(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === q) out += `\\${q}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x2028 || code === 0x2029) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}${q}`;
}

function tsKey(k: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : tsString(k);
}

/** A TypeScript literal for JSON: two-space indents, unquoted keys where possible, trailing commas. */
export function tsValue(v: unknown, level = 0): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "string") return tsString(v);
  const pad = "  ".repeat(level + 1);
  const end = "  ".repeat(level);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return `[\n${v.map((x) => `${pad}${tsValue(x, level + 1)},\n`).join("")}${end}]`;
  }
  if (isObj(v)) {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    if (!entries.length) return "{}";
    return `{\n${entries.map(([k, x]) => `${pad}${tsKey(k)}: ${tsValue(x, level + 1)},\n`).join("")}${end}}`;
  }
  return tsString(String(v));
}

/** Single-quoted for the shell: a ' inside becomes '\'' . */
function shSingle(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Double-quoted for the shell, with $, `, " and \ escaped. */
function shDouble(s: string): string {
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

function isJsonText(s: string | undefined): boolean {
  if (!s) return false;
  const t = s.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/** Long data URLs and base64 shortened to placeholders, so code stays readable. The request itself isn't changed. */
export function displayBody(body: unknown): unknown {
  if (typeof body === "string") {
    const dataUrl = /^data:([^;,]+)(;[^,]*)?;base64,/.exec(body);
    if (dataUrl && body.length > 120) return `data:${dataUrl[1]};base64,<BASE64>`;
    if (body.length > 400 && /^[A-Za-z0-9+/=\r\n]+$/.test(body)) return "<BASE64>";
    if (body.length > 6000) return `${body.slice(0, 6000)}...`;
    return body;
  }
  if (Array.isArray(body)) return body.map(displayBody);
  if (isObj(body)) return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, displayBody(v)]));
  return body;
}

// ---------------------------------------------------------------------------------------------------------------
// curl

export function curlCode(req: CodeRequest): string {
  const p = parse(req);
  const lines: string[] = [];
  const first = `curl ${p.stream ? "-N " : ""}-X ${p.method} ${shDouble(p.url)}`;
  lines.push(`-H "Authorization: Bearer $MODEL_API_KEY"`);
  if (p.form) {
    for (const f of p.form) {
      if (f.file) {
        const name = f.value || placeholderFileName(f.file.accept);
        const type = (f.file.accept ?? "").startsWith("audio") ? `;type=${mimeOfName(name)}` : "";
        lines.push(`-F ${shDouble(`${f.name}=@${name}${type}`)}`);
      } else if (isJsonText(f.value)) {
        lines.push(`-F ${shSingle(`${f.name}=${JSON.stringify(JSON.parse(f.value!))};type=application/json`)}`);
      } else {
        lines.push(`-F ${shDouble(`${f.name}=${f.value ?? ""}`)}`);
      }
    }
  } else if (p.body !== undefined) {
    lines.push(`-H "Content-Type: application/json"`);
    if (p.stream) lines.push(`-H "Accept: text/event-stream"`);
    lines.push(`-d ${shSingle(JSON.stringify(p.body, null, 2))}`);
  } else if (p.stream) {
    lines.push(`-H "Accept: text/event-stream"`);
  }
  if (p.endpoint.kind === "files.content") lines.push(`-o ${BINARY_OUT}`);
  return [first, ...lines].join(" \\\n  ");
}

// ---------------------------------------------------------------------------------------------------------------
// Python

const PY_KEY = `os.environ['MODEL_API_KEY']`;
const PY_AUTH = `"Authorization": f"Bearer {${PY_KEY}}"`;

/** Keyword arguments each SDK method takes; anything else goes in extra_body, which the SDKs pass through. */
const PY_PARAMS: Record<string, ReadonlySet<string>> = {
  "responses.create": new Set(
    "background conversation include input instructions max_output_tokens max_tool_calls metadata model parallel_tool_calls previous_response_id prompt prompt_cache_key prompt_cache_retention reasoning safety_identifier service_tier store stream stream_options temperature text tool_choice tools top_logprobs top_p truncation user".split(
      " ",
    ),
  ),
  "chat.create": new Set(
    "messages model audio frequency_penalty function_call functions logit_bias logprobs max_completion_tokens max_tokens metadata modalities n parallel_tool_calls prediction presence_penalty prompt_cache_key prompt_cache_retention reasoning_effort response_format safety_identifier seed service_tier stop store stream stream_options temperature tool_choice tools top_logprobs top_p user verbosity web_search_options".split(
      " ",
    ),
  ),
  "images.generate": new Set(
    "prompt background model moderation n output_compression output_format partial_images quality response_format size stream style user".split(
      " ",
    ),
  ),
  "messages.create": new Set(
    "max_tokens messages model metadata service_tier stop_sequences stream system temperature thinking tool_choice tools top_k top_p".split(" "),
  ),
  "messages.count_tokens": new Set("messages model system thinking tool_choice tools".split(" ")),
};

const PY_KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(
    " ",
  ),
);

function pyKwargs(kind: string, body: unknown, level: number): string {
  if (!isObj(body)) return "";
  const known = PY_PARAMS[kind];
  const pad = PY4.repeat(level + 1);
  const extra: Json = {};
  let out = "";
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    const ok = /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !PY_KEYWORDS.has(k) && (!known || known.has(k));
    if (ok) out += `${pad}${k}=${pyValue(v, level + 1)},\n`;
    else extra[k] = v;
  }
  if (Object.keys(extra).length) out += `${pad}extra_body=${pyValue(extra, level + 1)},\n`;
  return out;
}

function pyCall(target: string, call: string, args: string): string {
  return args ? `${target} = ${call}(\n${args})` : `${target} = ${call}()`;
}

const PY_OPENAI_CLIENT = `import os

from openai import OpenAI

client = OpenAI(
    base_url="${API_BASE}",
    api_key=os.environ["MODEL_API_KEY"],
)`;

const PY_ANTHROPIC_CLIENT = `import os

from anthropic import Anthropic

client = Anthropic(
    base_url="${ANTHROPIC_BASE}",
    auth_token=os.environ["MODEL_API_KEY"],
)`;

function pyStreamLoop(kind: "responses" | "chat" | "messages"): string {
  if (kind === "responses") {
    return `for event in stream:
    if event.type == "response.output_text.delta":
        print(event.delta, end="", flush=True)
print()`;
  }
  if (kind === "chat") {
    return `for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
print()`;
  }
  return `for event in stream:
    if event.type == "content_block_delta" and event.delta.type == "text_delta":
        print(event.delta.text, end="", flush=True)
print()`;
}

function queryKwargs(query: string, level: number): string {
  if (!query) return "";
  const pad = PY4.repeat(level + 1);
  return [...new URLSearchParams(query).entries()]
    .map(([k, v]) => `${pad}${k}=${/^\d+$/.test(v) ? v : pyString(v)},\n`)
    .join("");
}

function pythonSdk(p: Parsed): string | null {
  const e = p.endpoint;
  if (p.query && e.kind !== "files.list") return null;
  switch (e.kind) {
    case "responses.create":
    case "chat.create":
    case "images.generate": {
      const call = e.kind === "responses.create" ? "client.responses.create" : e.kind === "chat.create" ? "client.chat.completions.create" : "client.images.generate";
      const args = pyKwargs(e.kind, p.body, 0);
      if (p.stream && e.kind !== "images.generate") {
        return `${PY_OPENAI_CLIENT}\n\n${pyCall("stream", call, args)}\n\n${pyStreamLoop(e.kind === "chat.create" ? "chat" : "responses")}\n`;
      }
      return `${PY_OPENAI_CLIENT}\n\n${pyCall("response", call, args)}\n\nprint(response.model_dump_json(indent=2))\n`;
    }
    case "messages.create":
    case "messages.count_tokens": {
      const call = e.kind === "messages.create" ? "client.messages.create" : "client.messages.count_tokens";
      const args = pyKwargs(e.kind, p.body, 0);
      if (p.stream && e.kind === "messages.create") {
        return `${PY_ANTHROPIC_CLIENT}\n\n${pyCall("stream", call, args)}\n\n${pyStreamLoop("messages")}\n`;
      }
      return `${PY_ANTHROPIC_CLIENT}\n\n${pyCall("message", call, args)}\n\nprint(message.model_dump_json(indent=2))\n`;
    }
    case "responses.retrieve":
    case "responses.cancel":
    case "models.retrieve":
    case "files.retrieve":
    case "files.delete": {
      const call = {
        "responses.retrieve": "client.responses.retrieve",
        "responses.cancel": "client.responses.cancel",
        "models.retrieve": "client.models.retrieve",
        "files.retrieve": "client.files.retrieve",
        "files.delete": "client.files.delete",
      }[e.kind];
      return `${PY_OPENAI_CLIENT}\n\nresponse = ${call}(${pyString(e.id)})\n\nprint(response.model_dump_json(indent=2))\n`;
    }
    case "responses.delete":
      // The SDK's delete returns nothing for responses, so there is no body to print.
      return `${PY_OPENAI_CLIENT}\n\nclient.responses.delete(${pyString(e.id)})\nprint(${pyString(`Deleted ${e.id}`)})\n`;
    case "files.content":
      return `${PY_OPENAI_CLIENT}\n\ncontent = client.files.content(${pyString(e.id)})\ncontent.write_to_file("${BINARY_OUT}")\nprint("Saved ${BINARY_OUT}")\n`;
    case "models.list":
      return `${PY_OPENAI_CLIENT}\n\nresponse = client.models.list()\n\nprint(response.model_dump_json(indent=2))\n`;
    case "files.list":
      return `${PY_OPENAI_CLIENT}\n\n${pyCall("response", "client.files.list", queryKwargs(p.query, 0))}\n\nprint(response.model_dump_json(indent=2))\n`;
    case "files.create": {
      const fileField = p.form?.find((f) => f.file && f.name === "file");
      if (!p.form || !fileField) return null;
      const name = fileField.value || placeholderFileName(fileField.file?.accept);
      const args =
        p.form
          .filter((f) => !f.file)
          .map((f) => `${PY4.repeat(2)}${f.name}=${pyString(f.value ?? "")},\n`)
          .join("") + `${PY4.repeat(2)}file=f,\n`;
      return `${PY_OPENAI_CLIENT}\n\nwith open(${pyString(name)}, "rb") as f:\n    file = client.files.create(\n${args}    )\n\nprint(file.model_dump_json(indent=2))\n`;
    }
    default:
      return null;
  }
}

/** A safe Python name for a file handle, from its field name ("file" becomes f, as in Meta's examples). */
function handleName(field: string, i: number, taken: Set<string>): string {
  let name = field === "file" ? "f" : /^[A-Za-z_][A-Za-z0-9_]*$/.test(field) && !PY_KEYWORDS.has(field) ? field : `f${i}`;
  if (["json", "os", "requests", "response", "data", "files", "out"].includes(name)) name = `${name}_file`;
  while (taken.has(name)) name = `${name}_`;
  taken.add(name);
  return name;
}

function pyStreamPrint(kind: ReturnType<typeof streamKind>): string {
  if (kind === "responses") {
    return `    if event.get("type") == "response.output_text.delta":
        print(event.get("delta", ""), end="", flush=True)`;
  }
  if (kind === "chat") {
    return `    choices = event.get("choices") or []
    if choices and choices[0].get("delta", {}).get("content"):
        print(choices[0]["delta"]["content"], end="", flush=True)`;
  }
  if (kind === "messages") {
    return `    if event.get("type") == "content_block_delta" and event["delta"].get("type") == "text_delta":
        print(event["delta"]["text"], end="", flush=True)`;
  }
  return `    print(event.get("type", data[:80]))`;
}

function pythonHttp(p: Parsed): string {
  const fn = p.method.toLowerCase();
  const head = p.endpoint.kind === "files.content" ? "import os\n\nimport requests\n\n" : "import json\nimport os\n\nimport requests\n\n";
  const done =
    p.endpoint.kind === "files.content"
      ? `response.raise_for_status()\nwith open("${BINARY_OUT}", "wb") as out:\n    out.write(response.content)\nprint(f"Saved {len(response.content)} bytes to ${BINARY_OUT}")\n`
      : "response.raise_for_status()\nprint(json.dumps(response.json(), indent=2))\n";

  if (p.form) {
    const taken = new Set<string>();
    const opens: string[] = [];
    const data: string[] = [];
    const files: string[] = [];
    const pad = PY4.repeat(3);
    p.form.forEach((f, i) => {
      if (f.file) {
        const name = f.value || placeholderFileName(f.file.accept);
        const handle = handleName(f.name, i, taken);
        opens.push(`open(${pyString(name)}, "rb") as ${handle}`);
        files.push(`${pad}${pyString(f.name)}: (${pyString(name)}, ${handle}, ${pyString(mimeOfName(name))}),\n`);
      } else if (isJsonText(f.value)) {
        const value = pyValue(JSON.parse(f.value!), 3);
        files.push(`${pad}${pyString(f.name)}: (None, json.dumps(${value}), "application/json"),\n`);
      } else {
        data.push(`${pad}${pyString(f.name)}: ${pyString(f.value ?? "")},\n`);
      }
    });
    const args =
      `${PY4.repeat(2)}${pyString(p.url)},\n` +
      `${PY4.repeat(2)}headers={${PY_AUTH}},\n` +
      (data.length ? `${PY4.repeat(2)}data={\n${data.join("")}${PY4.repeat(2)}},\n` : "") +
      (files.length ? `${PY4.repeat(2)}files={\n${files.join("")}${PY4.repeat(2)}},\n` : "");
    const call = `response = requests.${fn}(\n${args}${PY4})`;
    // Without a file to open the call isn't nested in a with block, so every line moves out one level.
    if (!opens.length) return `${head}${call.replace(/\n {4}/g, "\n")}\n${done}`;
    return `${head}with ${opens.join(", ")}:\n    ${call}\n${done}`;
  }

  const hasBody = p.body !== undefined;
  const headers = hasBody
    ? `    headers={\n        ${PY_AUTH},\n        "Content-Type": "application/json",\n${p.stream ? `        "Accept": "text/event-stream",\n` : ""}    },\n`
    : p.stream
      ? `    headers={\n        ${PY_AUTH},\n        "Accept": "text/event-stream",\n    },\n`
      : `    headers={${PY_AUTH}},\n`;
  const json = hasBody ? `    json=${pyValue(p.body, 1)},\n` : "";
  const call = `response = requests.${fn}(\n    ${pyString(p.url)},\n${headers}${json}${p.stream ? "    stream=True,\n" : ""})\n`;
  if (!p.stream) return `${head}${call}${done}`;
  return `${head}${call}response.raise_for_status()

for raw_line in response.iter_lines(decode_unicode=False):
    if not raw_line:
        continue
    line = raw_line.decode("utf-8", errors="replace")
    if not line.startswith("data: "):
        continue
    data = line.removeprefix("data: ")
    if data == "[DONE]":
        break
    event = json.loads(data)
${pyStreamPrint(streamKind(p))}
print()
`;
}

export function pythonCode(req: CodeRequest, flavor: CodeFlavor): string | null {
  const p = parse(req);
  return flavor === "sdk" ? pythonSdk(p) : pythonHttp(p);
}

// ---------------------------------------------------------------------------------------------------------------
// TypeScript

const TS_KEY_CHECK = `const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) {
  throw new Error('MODEL_API_KEY is not set');
}`;

// Kept out of template literals on purpose: the generated code has its own template literal with ${apiKey}.
const TS_AUTH = "Authorization: `Bearer " + "$" + "{apiKey}`";

const TS_OPENAI_CLIENT = `const client = new OpenAI({
  baseURL: '${API_BASE}',
  apiKey,
});`;

const TS_ANTHROPIC_CLIENT = `const client = new Anthropic({
  baseURL: '${ANTHROPIC_BASE}',
  authToken: apiKey,
});`;

function tsStreamLoop(kind: "responses" | "chat" | "messages"): string {
  if (kind === "responses") {
    return `for await (const event of stream) {
  if (event.type === 'response.output_text.delta') {
    process.stdout.write(event.delta);
  }
}
process.stdout.write('\\n');`;
  }
  if (kind === "chat") {
    return `for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta?.content;
  if (delta) {
    process.stdout.write(delta);
  }
}
process.stdout.write('\\n');`;
  }
  return `for await (const event of stream) {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    process.stdout.write(event.delta.text);
  }
}
process.stdout.write('\\n');`;
}

function tsArgs(body: unknown): string {
  return isObj(body) && Object.keys(body).length ? tsValue(body, 0) : "";
}

function typescriptSdk(p: Parsed): string | null {
  const e = p.endpoint;
  if (p.query && e.kind !== "files.list") return null;
  const openai = (imports: string, rest: string) => `${imports}import OpenAI from 'openai';\n\n${TS_KEY_CHECK}\n\n${TS_OPENAI_CLIENT}\n\n${rest}\n`;
  const print = (name: string) => `console.log(JSON.stringify(${name}, null, 2));`;
  switch (e.kind) {
    case "responses.create":
    case "chat.create":
    case "images.generate": {
      const call = e.kind === "responses.create" ? "client.responses.create" : e.kind === "chat.create" ? "client.chat.completions.create" : "client.images.generate";
      const args = tsArgs(p.body);
      if (p.stream && e.kind !== "images.generate") {
        return openai("", `const stream = await ${call}(${args});\n\n${tsStreamLoop(e.kind === "chat.create" ? "chat" : "responses")}`);
      }
      return openai("", `const response = await ${call}(${args});\n\n${print("response")}`);
    }
    case "messages.create":
    case "messages.count_tokens": {
      const call = e.kind === "messages.create" ? "client.messages.create" : "client.messages.countTokens";
      const args = tsArgs(p.body);
      const head = `import Anthropic from '@anthropic-ai/sdk';\n\n${TS_KEY_CHECK}\n\n${TS_ANTHROPIC_CLIENT}\n\n`;
      if (p.stream && e.kind === "messages.create") return `${head}const stream = await ${call}(${args});\n\n${tsStreamLoop("messages")}\n`;
      return `${head}const message = await ${call}(${args});\n\n${print("message")}\n`;
    }
    case "responses.retrieve":
    case "responses.cancel":
    case "models.retrieve":
    case "files.retrieve":
    case "files.delete": {
      const call = {
        "responses.retrieve": "client.responses.retrieve",
        "responses.cancel": "client.responses.cancel",
        "models.retrieve": "client.models.retrieve",
        "files.retrieve": "client.files.retrieve",
        "files.delete": "client.files.delete",
      }[e.kind];
      return openai("", `const response = await ${call}(${tsString(e.id)});\n\n${print("response")}`);
    }
    case "responses.delete":
      return openai("", `await client.responses.delete(${tsString(e.id)});\nconsole.log(${tsString(`Deleted ${e.id}`)});`);
    case "files.content":
      return openai(
        "import { writeFile } from 'node:fs/promises';\n",
        `const content = await client.files.content(${tsString(e.id)});\nconst bytes = Buffer.from(await content.arrayBuffer());\nawait writeFile('${BINARY_OUT}', bytes);\nconsole.log(\`Saved \${bytes.length} bytes to ${BINARY_OUT}\`);`,
      );
    case "models.list":
      return openai("", `const page = await client.models.list();\n\n${print("page.data")}`);
    case "files.list": {
      const params = [...new URLSearchParams(p.query).entries()];
      const args = params.length
        ? `{\n${params.map(([k, v]) => `  ${tsKey(k)}: ${/^\d+$/.test(v) ? v : tsString(v)},\n`).join("")}}`
        : "";
      return openai("", `const page = await client.files.list(${args});\n\n${print("page.data")}`);
    }
    case "files.create": {
      const fileField = p.form?.find((f) => f.file && f.name === "file");
      if (!p.form || !fileField) return null;
      const name = fileField.value || placeholderFileName(fileField.file?.accept);
      const fields = p.form
        .filter((f) => !f.file)
        .map((f) => `  ${tsKey(f.name)}: ${tsString(f.value ?? "")},\n`)
        .join("");
      return openai(
        "import fs from 'node:fs';\n",
        `const file = await client.files.create({\n  file: fs.createReadStream(${tsString(name)}),\n${fields}});\n\n${print("file")}`,
      );
    }
    default:
      return null;
  }
}

function tsStreamPrint(kind: ReturnType<typeof streamKind>): string {
  if (kind === "responses") return `    if (event.type === 'response.output_text.delta') process.stdout.write(event.delta);`;
  if (kind === "chat") return `    const delta = event.choices?.[0]?.delta?.content;\n    if (delta) process.stdout.write(delta);`;
  if (kind === "messages") {
    return `    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') process.stdout.write(event.delta.text);`;
  }
  return `    console.log(event.type ?? data.slice(0, 80));`;
}

function typescriptHttp(p: Parsed): string {
  const check = `if (!res.ok) {\n  throw new Error(\`HTTP \${res.status}: \${await res.text()}\`);\n}\n`;
  const printJson = `\nconsole.log(JSON.stringify(await res.json(), null, 2));\n`;
  const method = p.method === "GET" ? "" : `  method: '${p.method}',\n`;

  if (p.form) {
    const usesFiles = p.form.some((f) => f.file);
    const appends = p.form
      .map((f) => {
        if (f.file) {
          const name = f.value || placeholderFileName(f.file.accept);
          return `form.append(${tsString(f.name)}, new Blob([await readFile(${tsString(name)})], { type: ${tsString(mimeOfName(name))} }), ${tsString(name)});`;
        }
        if (isJsonText(f.value)) return `form.append(${tsString(f.name)}, JSON.stringify(${tsValue(JSON.parse(f.value!), 0)}));`;
        return `form.append(${tsString(f.name)}, ${tsString(f.value ?? "")});`;
      })
      .join("\n");
    return `${usesFiles ? "import { readFile } from 'node:fs/promises';\n\n" : ""}${TS_KEY_CHECK}

const form = new FormData();
${appends}

const res = await fetch(${tsString(p.url)}, {
${method}  headers: { ${TS_AUTH} },
  body: form,
});
${check}${printJson}`;
  }

  const hasBody = p.body !== undefined;
  const headerLines = [
    `    ${TS_AUTH},`,
    ...(hasBody ? [`    'Content-Type': 'application/json',`] : []),
    ...(p.stream ? [`    Accept: 'text/event-stream',`] : []),
  ];
  const headers = headerLines.length === 1 ? `  headers: { ${TS_AUTH} },\n` : `  headers: {\n${headerLines.join("\n")}\n  },\n`;
  const body = hasBody ? `  body: JSON.stringify(${tsValue(p.body, 1)}),\n` : "";
  const call = `const res = await fetch(${tsString(p.url)}, {\n${method}${headers}${body}});\n`;

  if (p.endpoint.kind === "files.content") {
    return `import { writeFile } from 'node:fs/promises';

${TS_KEY_CHECK}

${call}${check}
const bytes = Buffer.from(await res.arrayBuffer());
await writeFile('${BINARY_OUT}', bytes);
console.log(\`Saved \${bytes.length} bytes to ${BINARY_OUT}\`);
`;
  }
  if (!p.stream) return `${TS_KEY_CHECK}\n\n${call}${check}${printJson}`;
  return `${TS_KEY_CHECK}

${call}if (!res.ok || !res.body) {
  throw new Error(\`HTTP \${res.status}: \${await res.text()}\`);
}

const decoder = new TextDecoder();
let buffer = '';
for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline: number;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line.startsWith('data: ')) continue;
    const data = line.slice('data: '.length);
    if (data === '[DONE]') continue;
    const event = JSON.parse(data);
${tsStreamPrint(streamKind(p))}
  }
}
process.stdout.write('\\n');
`;
}

export function typescriptCode(req: CodeRequest, flavor: CodeFlavor): string | null {
  const p = parse(req);
  return flavor === "sdk" ? typescriptSdk(p) : typescriptHttp(p);
}

// ---------------------------------------------------------------------------------------------------------------

/** Every sample a request has, in tab order: curl, then Python and TypeScript with the SDK first where one fits. */
export function codeSamples(req: CodeRequest): CodeSample[] {
  const p = parse(req);
  const anthropic = p.endpoint.kind === "messages.create" || p.endpoint.kind === "messages.count_tokens";
  const sdk = anthropic ? "Anthropic SDK" : "OpenAI SDK";
  const out: CodeSample[] = [{ lang: "curl", flavor: "http", label: "curl", syntax: "bash", code: curlCode(req) }];
  const pySdk = pythonSdk(p);
  if (pySdk) out.push({ lang: "python", flavor: "sdk", label: `Python (${sdk})`, syntax: "python", code: pySdk });
  out.push({ lang: "python", flavor: "http", label: "Python (requests)", syntax: "python", code: pythonHttp(p) });
  const tsSdk = typescriptSdk(p);
  if (tsSdk) out.push({ lang: "typescript", flavor: "sdk", label: `TypeScript (${sdk})`, syntax: "typescript", code: tsSdk });
  out.push({ lang: "typescript", flavor: "http", label: "TypeScript (fetch)", syntax: "typescript", code: typescriptHttp(p) });
  return out;
}
