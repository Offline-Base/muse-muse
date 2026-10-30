import type { RequestMethod } from "@/lib/docs/curl";

/**
 * Reads the SDK calls in Meta's Python and TypeScript examples into requests the docs proxy can run, so blocks that
 * call the API through the OpenAI SDK (or Anthropic's, for Messages) get a Run button too, not only curl:
 * `client.responses.create(model="...", input="...")` and `await client.chat.completions.create({ ... })`, and the
 * plain HTTP tabs: `requests.post("https://api.meta.ai/v1/...", json={...})` and `fetch(url, { body:
 * JSON.stringify({...}) })`.
 *
 * Only literal arguments are read: strings, numbers, booleans, null, and lists and objects of them, plus names the
 * same block assigns a literal to (`tools = [...]`, then `tools=tools`). A call that passes anything computed (a
 * variable from a loop, an f-string, a file handle) gets no Run button rather than a request that isn't the
 * example's. Pure, like lib/docs/curl.ts, which turns what this finds into a runnable request.
 */

/** An SDK call as the HTTP request it makes. */
export interface SdkCall {
  method: RequestMethod;
  /** Meta's path without /v1, with any query string. */
  path: string;
  body?: Record<string, unknown>;
}

type Lang = "python" | "js";

/** The SDK methods the proxy runs, with the request each one makes. `{id}` is the call's first argument. */
const CALLS: Record<string, { method: RequestMethod; path: string; args: "body" | "id" | "query"; stream?: true }> = {
  "responses.create": { method: "POST", path: "responses", args: "body" },
  "responses.stream": { method: "POST", path: "responses", args: "body", stream: true },
  "responses.retrieve": { method: "GET", path: "responses/{id}", args: "id" },
  "responses.delete": { method: "DELETE", path: "responses/{id}", args: "id" },
  "responses.cancel": { method: "POST", path: "responses/{id}/cancel", args: "id" },
  "responses.input_tokens.count": { method: "POST", path: "responses/input_tokens", args: "body" },
  "chat.completions.create": { method: "POST", path: "chat/completions", args: "body" },
  "images.generate": { method: "POST", path: "images/generations", args: "body" },
  "messages.create": { method: "POST", path: "messages", args: "body" },
  "messages.count_tokens": { method: "POST", path: "messages/count_tokens", args: "body" },
  "models.list": { method: "GET", path: "models", args: "query" },
  "models.retrieve": { method: "GET", path: "models/{id}", args: "id" },
  "files.list": { method: "GET", path: "files", args: "query" },
  "files.retrieve": { method: "GET", path: "files/{id}", args: "id" },
  "files.content": { method: "GET", path: "files/{id}/content", args: "id" },
  "files.delete": { method: "DELETE", path: "files/{id}", args: "id" },
};

/**
 * SDK options that shape the HTTP call rather than the body. extra_body is merged into the body instead. The last
 * three are LiteLLM's, whose completion() is a chat completion.
 */
const PY_OPTIONS = new Set(["extra_headers", "extra_query", "timeout", "api_base", "base_url", "api_key"]);
/** requests' arguments that don't change the request the proxy would send: the key goes in headers, for one. */
const REQUESTS_SKIPPED = new Set(["headers", "timeout", "stream", "verify", "allow_redirects"]);
/** Query parameters the list calls take (lib/docs/proxy/endpoints.ts passes these on). */
const LIST_QUERY = new Set(["purpose", "limit", "order", "after", "client"]);

class NotLiteral extends Error {}

/** A small reader for Python and JavaScript literals over one block of code. */
class Reader {
  i: number;
  private depth = 0;

  constructor(
    private readonly src: string,
    start: number,
    private readonly lang: Lang,
  ) {
    this.i = start;
  }

  fail(): never {
    throw new NotLiteral();
  }

  peek(): string {
    return this.src[this.i] ?? "";
  }

  /** Skips spaces, line breaks and comments. */
  space(): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.i++;
      else if (this.lang === "python" && c === "#") this.skipTo("\n");
      else if (this.lang === "js" && this.src.startsWith("//", this.i)) this.skipTo("\n");
      else if (this.lang === "js" && this.src.startsWith("/*", this.i)) {
        const end = this.src.indexOf("*/", this.i + 2);
        this.i = end < 0 ? this.src.length : end + 2;
      } else if (this.lang === "python" && c === "\\" && this.src[this.i + 1] === "\n") this.i += 2;
      else return;
    }
  }

  private skipTo(stop: string): void {
    const end = this.src.indexOf(stop, this.i);
    this.i = end < 0 ? this.src.length : end;
  }

  eat(token: string): boolean {
    this.space();
    if (!this.src.startsWith(token, this.i)) return false;
    this.i += token.length;
    return true;
  }

  expect(token: string): void {
    if (!this.eat(token)) this.fail();
  }

  identifier(): string | null {
    this.space();
    const m = /^[A-Za-z_$][\w$]*/.exec(this.src.slice(this.i, this.i + 200));
    if (!m) return null;
    this.i += m[0].length;
    return m[0];
  }

  /**
   * Steps over one argument without reading it (headers with an f-string, a timeout), to the comma or bracket that
   * ends it at this depth. Strings, template literals and nested brackets are stepped over whole.
   */
  skipValue(): void {
    let depth = 0;
    for (;;) {
      this.space();
      const c = this.peek();
      if (!c) this.fail();
      if (depth === 0 && ",)]}".includes(c)) return;
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      if (c === "'" || c === '"' || c === "`") this.skipString();
      else this.i++;
    }
  }

  private skipString(): void {
    const quote = this.peek();
    const triple = this.lang === "python" && this.src.startsWith(quote.repeat(3), this.i);
    const close = triple ? quote.repeat(3) : quote;
    this.i += close.length;
    while (this.i < this.src.length) {
      if (this.src.startsWith(close, this.i)) {
        this.i += close.length;
        return;
      }
      if (this.src[this.i] === "\\") {
        this.i += 2;
        continue;
      }
      if (quote === "`" && this.src.startsWith("${", this.i)) {
        this.i += 2;
        let depth = 1;
        while (this.i < this.src.length && depth) {
          const d = this.src[this.i];
          if (d === "'" || d === '"' || d === "`") {
            this.skipString();
            continue;
          }
          if (d === "{") depth++;
          else if (d === "}") depth--;
          this.i++;
        }
        continue;
      }
      this.i++;
    }
    this.fail();
  }

  /** One literal value. `resolve` turns a bare name into the literal the block assigned to it. */
  value(resolve: (name: string, at: number) => unknown): unknown {
    if (++this.depth > 64) this.fail();
    try {
      this.space();
      const c = this.peek();
      let out: unknown;
      if (c === "'" || c === '"' || (this.lang === "js" && c === "`")) out = this.strings();
      else if (this.lang === "python" && /[rRuU]/.test(c) && (this.src[this.i + 1] === "'" || this.src[this.i + 1] === '"')) out = this.strings();
      else if (c === "[") out = this.list(resolve);
      else if (c === "{") out = this.object(resolve);
      else if (c === "(" && this.lang === "python") {
        this.i++;
        out = this.value(resolve);
        this.expect(")");
      } else if (/[-+\d.]/.test(c)) out = this.number();
      else {
        const start = this.i;
        const name = this.identifier();
        if (!name) this.fail();
        const consts: Record<string, unknown> =
          this.lang === "python" ? { True: true, False: false, None: null } : { true: true, false: false, null: null };
        if (name in consts) out = consts[name];
        else {
          // A name followed by a call, an index or an attribute is computed, not a literal.
          this.space();
          if ("([.".includes(this.peek()) && !this.src.startsWith("...", this.i)) this.fail();
          out = resolve(name, start);
        }
      }
      if (this.lang === "js") {
        // TypeScript's `as const` changes nothing about the value.
        const save = this.i;
        if (!(this.eat("as") && this.eat("const"))) this.i = save;
      }
      return out;
    } finally {
      this.depth--;
    }
  }

  /** A string literal, with Python's adjacent-literal concatenation ("a" "b"). */
  private strings(): string {
    let out = this.string();
    if (this.lang === "python") {
      for (;;) {
        const save = this.i;
        this.space();
        const c = this.peek();
        if (c === "'" || c === '"' || (/[rRuU]/.test(c) && /['"]/.test(this.src[this.i + 1] ?? ""))) out += this.string();
        else {
          this.i = save;
          break;
        }
      }
    }
    return out;
  }

  private string(): string {
    let raw = false;
    if (this.lang === "python") {
      const prefix = this.peek();
      if (/[rR]/.test(prefix)) raw = true;
      if (/[rRuU]/.test(prefix)) this.i++;
      // f-strings and byte strings were skipped by the caller's checks: an f or b prefix isn't read as a literal.
    }
    const quote = this.peek();
    const triple = this.lang === "python" && this.src.startsWith(quote.repeat(3), this.i);
    const close = triple ? quote.repeat(3) : quote;
    this.i += close.length;
    let out = "";
    for (;;) {
      if (this.i >= this.src.length) this.fail();
      if (this.src.startsWith(close, this.i)) {
        this.i += close.length;
        return out;
      }
      const c = this.src[this.i];
      if (!triple && (c === "\n" || c === "\r") && quote !== "`") this.fail();
      if (quote === "`" && this.src.startsWith("${", this.i)) this.fail();
      if (c === "\\" && !raw) {
        const next = this.src[this.i + 1];
        const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "0": "\0", "\\": "\\", "'": "'", '"': '"', "`": "`" };
        if (next === "\n") this.i += 2;
        else if (next in simple) {
          out += simple[next];
          this.i += 2;
        } else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(this.src.slice(this.i + 2, this.i + 6))) {
          out += String.fromCharCode(parseInt(this.src.slice(this.i + 2, this.i + 6), 16));
          this.i += 6;
        } else if (next === "x" && /^[0-9a-fA-F]{2}$/.test(this.src.slice(this.i + 2, this.i + 4))) {
          out += String.fromCharCode(parseInt(this.src.slice(this.i + 2, this.i + 4), 16));
          this.i += 4;
        } else {
          out += next ?? "";
          this.i += 2;
        }
        continue;
      }
      out += c;
      this.i++;
    }
  }

  private number(): number {
    const m = /^[-+]?(?:\d[\d_]*)?(?:\.\d[\d_]*)?(?:[eE][-+]?\d+)?/.exec(this.src.slice(this.i, this.i + 64));
    const text = m?.[0].replace(/_/g, "") ?? "";
    const n = Number(text);
    if (!text || !/\d/.test(text) || !Number.isFinite(n)) this.fail();
    this.i += m![0].length;
    return n;
  }

  private list(resolve: (name: string, at: number) => unknown): unknown[] {
    this.expect("[");
    const out: unknown[] = [];
    for (;;) {
      if (this.eat("]")) return out;
      out.push(this.value(resolve));
      if (this.eat("]")) return out;
      this.expect(",");
    }
  }

  private object(resolve: (name: string, at: number) => unknown): Record<string, unknown> {
    this.expect("{");
    const out: Record<string, unknown> = {};
    for (;;) {
      if (this.eat("}")) return out;
      this.space();
      let key: string;
      const c = this.peek();
      if (c === "'" || c === '"') key = this.string();
      else if (this.lang === "js") {
        const start = this.i;
        const name = this.identifier();
        if (!name) this.fail();
        key = name;
        this.space();
        // Shorthand { name }: the value is whatever the block assigned to it.
        if (this.peek() === "," || this.peek() === "}") {
          out[key] = resolve(name, start);
          if (this.eat("}")) return out;
          this.expect(",");
          continue;
        }
      } else this.fail();
      this.expect(":");
      out[key] = this.value(resolve);
      if (this.eat("}")) return out;
      this.expect(",");
    }
  }
}

/** Where `name` was last given a value before `before`: `name = ...` in Python, `const name = ...` in JavaScript. */
function assignmentOf(code: string, name: string, before: number, lang: Lang): number | null {
  const escaped = name.replace(/[$]/g, "\\$");
  const re =
    lang === "python"
      ? new RegExp(`^[ \\t]*${escaped}[ \\t]*(?::[^=\\n]+)?=(?!=)`, "gm")
      : new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*(?::[^=;]+)?=(?![=>])`, "g");
  let at: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) && m.index < before) at = m.index + m[0].length;
  return at;
}

/**
 * A reader at `start` whose bare names resolve to the literal last assigned to them before `bound`: the start of the
 * call being read, so a keyword argument such as `tools=tools` inside the call isn't taken for an assignment.
 */
function parseWith(code: string, start: number, lang: Lang, seen: Set<string>, bound = start) {
  const reader = new Reader(code, start, lang);
  const resolve = (name: string): unknown => {
    if (seen.has(name) || seen.size > 8) return reader.fail();
    const from = assignmentOf(code, name, bound, lang);
    if (from === null) return reader.fail();
    const inner = new Set(seen).add(name);
    try {
      return parseWith(code, from, lang, inner).value();
    } catch {
      return reader.fail();
    }
  };
  return { reader, value: () => reader.value(resolve), resolve };
}

/**
 * The keyword arguments of a Python call whose "(" is at `open`, and its positional ones in order. Arguments named in
 * `skip` (the SDK's options, such as a timeout or the key) are stepped over unread, since they never reach the body.
 */
function pythonArgs(
  code: string,
  open: number,
  skip: ReadonlySet<string> = PY_OPTIONS,
): { kwargs: Record<string, unknown>; positional: unknown[] } {
  const { reader, resolve } = parseWith(code, open, "python", new Set());
  reader.expect("(");
  const kwargs: Record<string, unknown> = {};
  const positional: unknown[] = [];
  for (;;) {
    if (reader.eat(")")) return { kwargs, positional };
    if (reader.eat("**")) reader.fail();
    const save = reader.i;
    const name = reader.identifier();
    if (name && reader.eat("=") && reader.peek() !== "=") {
      if (skip.has(name)) reader.skipValue();
      else kwargs[name] = reader.value(resolve);
    } else {
      reader.i = save;
      positional.push(reader.value(resolve));
    }
    if (reader.eat(")")) return { kwargs, positional };
    reader.expect(",");
  }
}

/** The first argument of a JavaScript call whose "(" is at `open`. The rest (request options) are stepped over. */
function jsArgs(code: string, open: number): unknown[] {
  const { reader, resolve } = parseWith(code, open, "js", new Set());
  reader.expect("(");
  if (reader.eat(")")) return [];
  if (reader.eat("...")) reader.fail();
  const first = reader.value(resolve);
  while (reader.eat(",")) if (!reader.eat(")")) reader.skipValue();
  reader.eat(")");
  return [first];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Python or JavaScript, from the fence's language or, without one, from how the code reads. */
function languageOf(code: string, fence: string): Lang | null {
  const f = fence.toLowerCase();
  if (f === "python" || f === "py") return "python";
  if (["typescript", "ts", "javascript", "js", "tsx", "jsx", "mjs"].includes(f)) return "js";
  if (f) return null;
  if (/^\s*(?:from\s+\w+\s+import|import\s+\w+\s*$)/m.test(code) && !/\b(?:const|let)\s/.test(code)) return "python";
  if (/\b(?:const|let)\s|=>|import\s+\w+\s+from\s+['"]/.test(code)) return "js";
  return null;
}

const CALL_RE = new RegExp(
  `\\b[A-Za-z_$][\\w$]*\\.(${Object.keys(CALLS)
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/\./g, "\\."))
    .join("|")})\\s*\\(`,
  "g",
);

/** One SDK call as a request, or null when its arguments aren't all literals. */
function callRequest(code: string, lang: Lang, name: string, open: number): SdkCall | null {
  const call = CALLS[name];
  try {
    let body: Record<string, unknown> | undefined;
    let id: unknown;
    let query: Record<string, unknown> = {};
    if (lang === "python") {
      const { kwargs, positional } = pythonArgs(code, open);
      if (call.args === "body") {
        if (positional.length) return null;
        body = {};
        for (const [k, v] of Object.entries(kwargs)) {
          if (k === "extra_body") {
            if (!isObject(v)) return null;
            Object.assign(body, v);
          } else body[k] = v;
        }
      } else if (call.args === "id") {
        id = positional[0] ?? Object.values(kwargs)[0];
      } else query = kwargs;
    } else {
      const args = jsArgs(code, open);
      if (call.args === "body") {
        if (!isObject(args[0])) return null;
        body = { ...args[0] };
      } else if (call.args === "id") id = args[0];
      else if (isObject(args[0])) query = args[0];
    }
    if (call.stream && body) body.stream = true;
    let path = call.path;
    if (call.args === "id") {
      if (typeof id !== "string" || !/^[\w.:-]{1,128}$/.test(id)) return null;
      path = path.replace("{id}", id);
    }
    const params = Object.entries(query).filter(([k, v]) => LIST_QUERY.has(k) && (typeof v === "string" || typeof v === "number"));
    if (params.length) path += `?${new URLSearchParams(params.map(([k, v]) => [k, String(v)])).toString()}`;
    return body ? { method: call.method, path, body } : { method: call.method, path };
  } catch (err) {
    if (err instanceof NotLiteral) return null;
    throw err;
  }
}

/** Meta's path for an https://api.meta.ai/v1 URL ("responses", "models?client=x"), or null. */
function apiPath(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const m = url.trim().match(/^https:\/\/api\.meta\.ai\/v1\/([^#\s]+)$/);
  return m && !m[1].startsWith("?") ? m[1] : null;
}

const HTTP_METHODS: Record<string, RequestMethod> = { get: "GET", post: "POST", delete: "DELETE" };

/** `requests.post("https://api.meta.ai/v1/...", headers=..., json={...})` as a request, or null. */
function pythonRequests(code: string, verb: string, open: number): SdkCall | null {
  const method = HTTP_METHODS[verb];
  const { reader, resolve } = parseWith(code, open, "python", new Set());
  try {
    reader.expect("(");
    let url: unknown;
    let body: unknown;
    let positional = 0;
    for (;;) {
      if (reader.eat(")")) break;
      const save = reader.i;
      const name = reader.identifier();
      if (name && reader.eat("=") && reader.peek() !== "=") {
        if (name === "url") url = reader.value(resolve);
        else if (name === "json") body = reader.value(resolve);
        else if (REQUESTS_SKIPPED.has(name)) reader.skipValue();
        // data=, files= and params= send something this doesn't read.
        else return null;
      } else {
        reader.i = save;
        if (positional++) return null;
        url = reader.value(resolve);
      }
      if (reader.eat(")")) break;
      reader.expect(",");
    }
    const path = apiPath(url);
    if (!path || (body !== undefined && !isObject(body))) return null;
    return isObject(body) ? { method, path, body } : { method, path };
  } catch (err) {
    if (err instanceof NotLiteral) return null;
    throw err;
  }
}

/** `fetch("https://api.meta.ai/v1/...", { method, headers, body: JSON.stringify({...}) })` as a request, or null. */
function jsFetch(code: string, open: number): SdkCall | null {
  const { reader, resolve } = parseWith(code, open, "js", new Set());
  try {
    reader.expect("(");
    const url = reader.value(resolve);
    let method: RequestMethod | undefined = "GET";
    let body: unknown;
    if (reader.eat(",") && !reader.eat(")")) {
      reader.expect("{");
      for (;;) {
        if (reader.eat("}")) break;
        reader.space();
        const quoted = reader.peek() === "'" || reader.peek() === '"';
        const key = quoted ? reader.value(resolve) : reader.identifier();
        if (typeof key !== "string" || !reader.eat(":")) return null;
        if (key === "method") {
          const value = reader.value(resolve);
          method = typeof value === "string" ? HTTP_METHODS[value.toLowerCase()] : undefined;
        } else if (key === "body") {
          if (!(reader.eat("JSON") && reader.eat(".") && reader.eat("stringify") && reader.eat("("))) return null;
          body = reader.value(resolve);
          while (reader.eat(",")) if (!reader.eat(")")) reader.skipValue();
          reader.eat(")");
        } else reader.skipValue();
        if (reader.eat("}")) break;
        reader.expect(",");
      }
      reader.eat(",");
      reader.expect(")");
    }
    const path = apiPath(url);
    if (!method || !path || (body !== undefined && !isObject(body))) return null;
    return isObject(body) ? { method, path, body } : { method, path };
  } catch (err) {
    if (err instanceof NotLiteral) return null;
    throw err;
  }
}

/** The first call in a block that the proxy can run as written, or null. `fence` is the block's language. */
export function sdkCallFromCode(code: string, fence = ""): SdkCall | null {
  const lang = languageOf(code, fence);
  if (!lang) return null;
  const candidates: Array<{ at: number; read: () => SdkCall | null }> = [];
  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(code))) {
    const [name, open] = [m[1], m.index + m[0].length - 1];
    candidates.push({ at: m.index, read: () => callRequest(code, lang, name, open) });
  }
  // LiteLLM routes "openai/<model>" through the OpenAI protocol: a chat completion on <model>.
  const litellm = /\blitellm\.completion\s*\(/g;
  while (lang === "python" && (m = litellm.exec(code))) {
    const open = m.index + m[0].length - 1;
    candidates.push({
      at: m.index,
      read: () => {
        const call = callRequest(code, lang, "chat.completions.create", open);
        const model = call?.body?.model;
        return call && typeof model === "string" ? { ...call, body: { ...call.body, model: model.replace(/^openai\//, "") } } : null;
      },
    });
  }
  const http = lang === "python" ? /\brequests\.(get|post|delete)\s*\(/g : /\bfetch\s*\(/g;
  while ((m = http.exec(code))) {
    const [verb, open] = [m[1], m.index + m[0].length - 1];
    candidates.push({ at: m.index, read: () => (lang === "python" ? pythonRequests(code, verb, open) : jsFetch(code, open)) });
  }
  for (const c of candidates.sort((a, b) => a.at - b.at)) {
    const call = c.read();
    if (call) return call;
  }
  return null;
}
