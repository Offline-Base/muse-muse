import { sdkCallFromCode } from "@/lib/docs/sdk-request";

/**
 * Turns the API calls in Meta's docs into requests the docs proxy can run, so each code block that calls
 * https://api.meta.ai/v1 can get a Run button (docs/DOCS_MIRROR.md, "Page layout"). Reads curl commands (multi-line
 * with backslashes, -X, -H, -d and its --data variants, -F/--form, quoted JSON), bare request lines such as
 * "POST https://api.meta.ai/v1/responses" followed by a JSON body, and OpenAI SDK calls with literal arguments
 * (lib/docs/sdk-request.ts). Placeholders the reader has to fill (@file uploads, $(base64 ...), <BASE64>-style and
 * truncated data URLs, example.com media URLs, file-... ids) come back as slots for file pickers. Pure: no I/O, no
 * DOM, safe on the server and in the browser.
 */

export const META_API_BASE = "https://api.meta.ai/v1";

export type RequestMethod = "GET" | "POST" | "DELETE";

/** Same shape as FileSlotSpec in components/docs/playgrounds/common/ApiConsole.tsx (the kit contract). */
export interface ParsedFileSlotSpec {
  label: string;
  accept?: string;
  as?: "dataUrl" | "base64" | "file";
}

/** Same shape as FileSlot in ApiConsole.tsx. The parser only emits body slots; form files ride on their field. */
export interface ParsedFileSlot extends ParsedFileSlotSpec {
  /** A JSON Pointer (RFC 6901) into the body. */
  pointer: string;
  target?: "body" | "form";
}

/** Same shape as FormSpec in ApiConsole.tsx: a multipart field, either a value or a file to pick. */
export interface ParsedFormField {
  name: string;
  value?: string;
  file?: ParsedFileSlotSpec;
}

/**
 * A Files API id in the example (`files/file_abc123` or `"file_id": "file-abc123"`). It doesn't exist for the reader,
 * so the Run panel offers to upload a file and put the new id in its place.
 */
export interface ParsedIdSlot {
  /** A JSON Pointer into the body, or null when the id is a segment of the path. */
  pointer: string | null;
  placeholder: string;
  label: string;
}

export interface ParsedRequest {
  method: RequestMethod;
  /** Meta's path without /v1, with any query string: "responses", "asr/transcribe?sessionId=abc". */
  path: string;
  /** The JSON body, when the request sends one. */
  body?: unknown;
  /** The multipart fields, when the request sends a form. */
  form?: ParsedFormField[];
  fileSlots: ParsedFileSlot[];
  fileIds: ParsedIdSlot[];
  /** The reply is server-sent events: "stream": true, Accept: text/event-stream, or ?stream=true. */
  stream: boolean;
}

// ---------- Shell words ----------

/** Index of the ")" that closes the "(" at `open`, skipping quoted text; -1 when it never closes. */
function closeParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) return -1;
      i = j;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Splits one shell command into words the way sh would, without expanding anything: quotes are removed, `$VAR` and
 * `$(...)` stay as written, backslash-newline joins lines, and the command ends at an unquoted newline, `|`, `;`, `&`,
 * a redirect or a comment. Returns null for unbalanced quotes.
 */
export function shellWords(src: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  const push = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      const next = src[i + 1];
      if (next === "\n") i += 2;
      else if (next === "\r" && src[i + 2] === "\n") i += 3;
      else if (next === undefined) i += 1;
      else {
        word += next;
        inWord = true;
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return null;
      word += src.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let text = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length && '"\\$`\n'.includes(src[j + 1])) {
          if (src[j + 1] !== "\n") text += src[j + 1];
          j += 2;
        } else if (src[j] === "$" && src[j + 1] === "(") {
          const end = closeParen(src, j + 1);
          if (end < 0) return null;
          text += src.slice(j, end + 1);
          j = end + 1;
        } else {
          text += src[j];
          j += 1;
        }
      }
      if (j >= src.length) return null;
      word += text;
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === "$" && src[i + 1] === "(") {
      const end = closeParen(src, i + 1);
      if (end < 0) return null;
      word += src.slice(i, end + 1);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === "#" && !inWord) {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if ("\n;|&<>".includes(c)) break;
    if (c === " " || c === "\t" || c === "\r") {
      push();
      i += 1;
      continue;
    }
    word += c;
    inWord = true;
    i += 1;
  }
  push();
  return words;
}

// ---------- Paths, media types, placeholders ----------

/** Meta's path for an api.meta.ai/v1 URL ("responses", "files/file-1?x=1"), or null for anything else. */
export function metaPath(url: string): string | null {
  const m = url.trim().match(/^https:\/\/api\.meta\.ai\/v1\/([^#\s]+)$/);
  if (!m) return null;
  const path = m[1].replace(/^\/+/, "");
  return path && !path.startsWith("?") ? path : null;
}

const EXT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  json: "application/json",
  jsonl: "application/jsonl",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
};

function typeOfName(name: string): string | undefined {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)(?:[?#].*)?$/)?.[1];
  return ext ? EXT_TYPES[ext] : undefined;
}

/** What a file picker should accept for a media type: any image for an image, the exact type otherwise. */
function acceptFor(type: string | undefined): string | undefined {
  if (!type) return undefined;
  if (type.startsWith("image/")) return "image/*";
  if (type.startsWith("video/")) return "video/*";
  return type;
}

function kindOf(type: string | undefined, key: string | null): string {
  const t = type ?? "";
  const k = key ?? "";
  if (t.startsWith("image/") || /image/.test(k)) return "Image";
  if (t.startsWith("video/") || /video/.test(k)) return "Video";
  if (t.startsWith("audio/") || /audio/.test(k)) return "Audio";
  if (t === "application/pdf") return "PDF";
  return "File";
}

/** The media type a JSON field implies when its placeholder doesn't say. */
function typeOfKey(key: string | null, pointer: string): string | undefined {
  const k = `${pointer}/${key ?? ""}`;
  if (/image/.test(k)) return "image/png";
  if (/video/.test(k)) return "video/mp4";
  if (/audio/.test(k)) return "audio/wav";
  if (/file_data|file_url/.test(k)) return "application/pdf";
  return undefined;
}

function escapePointer(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** A data URL whose payload is a stand-in ("UklGR...", "<...>", "$(base64 ...)") rather than real bytes. */
function placeholderDataUrl(value: string): string | null {
  const m = value.match(/^data:([\w.+-]+\/[\w.+-]+);base64,([\s\S]*)$/);
  if (!m) return null;
  const payload = m[2];
  const stub = /[<>{}$]|\.\.\./.test(payload) || payload.length < 64 || !/^[A-Za-z0-9+/=\s]+$/.test(payload);
  return stub ? m[1] : null;
}

const FILE_ID = /^file[-_][A-Za-z0-9][\w-]*$/;
const EXAMPLE_HOST = /^https?:\/\/(?:[\w-]+\.)*example\.(?:com|org|net)\//i;
const MEDIA_KEYS = new Set(["image_url", "video_url", "file_url", "audio_url", "url"]);

/** "image_url" for /input/0/content/1/image_url; a generic leaf such as "url" or "data" keeps its parent: "image_url.url". */
function fieldName(pointer: string): string {
  const parts = pointer.split("/").filter((p) => p && !/^\d+$/.test(p));
  const leaf = parts.pop() ?? "body";
  return (leaf === "url" || leaf === "data") && parts.length ? `${parts.pop()}.${leaf}` : leaf;
}

function slot(pointer: string, type: string | undefined, as: "dataUrl" | "base64"): ParsedFileSlot {
  const name = fieldName(pointer);
  return { pointer, target: "body", label: `${kindOf(type, name)} for ${name}`, accept: acceptFor(type), as };
}

/** Fills slots and id slots for the placeholders in a JSON body, walking every string with its JSON Pointer. */
function bodySlots(body: unknown, slots: ParsedFileSlot[], ids: ParsedIdSlot[]) {
  const visit = (value: unknown, pointer: string, key: string | null) => {
    if (typeof value === "string") {
      const dataType = placeholderDataUrl(value);
      if (dataType) {
        slots.push(slot(pointer, dataType, "dataUrl"));
        return;
      }
      if (/\$\(\s*base64\b/.test(value)) {
        const named = value.match(/\$\(\s*base64\s+(?:-[a-zA-Z]+\s+)*([^\s)]+)/)?.[1];
        const type = (named && typeOfName(named)) || typeOfKey(key, pointer);
        slots.push(slot(pointer, type, value.startsWith("data:") || /url$/.test(key ?? "") ? "dataUrl" : "base64"));
        return;
      }
      if (/^<[^<>]{1,60}>$/.test(value) && /base64|b64|bytes|binary|encoded|image|audio|video/i.test(value)) {
        slots.push(slot(pointer, typeOfKey(key, pointer), /url$/.test(key ?? "") ? "dataUrl" : "base64"));
        return;
      }
      if (key && MEDIA_KEYS.has(key) && EXAMPLE_HOST.test(value)) {
        // example.com hosts nothing, so Meta can't fetch it: send a file inline instead.
        slots.push(slot(pointer, typeOfName(value) ?? typeOfKey(key, pointer), "dataUrl"));
        return;
      }
      if (key === "file_id" && FILE_ID.test(value)) {
        ids.push({ pointer, placeholder: value, label: `file_id ${value}` });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, `${pointer}/${i}`, null));
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) visit(v, `${pointer}/${escapePointer(k)}`, k);
    }
  };
  visit(body, "", null);
}

function pathIds(path: string): ParsedIdSlot[] {
  const bare = path.split("?")[0];
  return bare
    .split("/")
    .filter((segment, i, all) => i > 0 && all[i - 1] === "files" && FILE_ID.test(segment))
    .map((segment) => ({ pointer: null, placeholder: segment, label: `file id ${segment} in the path` }));
}

function isStream(path: string, body: unknown, accept: string | null): boolean {
  if (accept && /text\/event-stream/i.test(accept)) return true;
  if (/[?&]stream=true(?:&|$)/.test(path)) return true;
  return Boolean(body && typeof body === "object" && (body as { stream?: unknown }).stream === true);
}

// ---------- curl ----------

/** curl options that take a value (the next word, or the rest of a short-option cluster). */
const VALUE_FLAGS = new Set([
  "-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-ascii",
  "--data-urlencode", "--json", "-F", "--form", "--form-string", "-o", "--output", "-w", "--write-out", "-u", "--user",
  "-A", "--user-agent", "-e", "--referer", "-m", "--max-time", "--connect-timeout", "--retry", "--retry-delay",
  "--retry-max-time", "-b", "--cookie", "-c", "--cookie-jar", "--url", "-T", "--upload-file", "-x", "--proxy",
  "--cacert", "--cert", "--key", "-r", "--range", "--limit-rate", "--resolve", "-K", "--config",
]);

const SHORT_VALUE = new Set("XHdFowuAembcTxrK".split(""));

interface CurlArgs {
  url: string | null;
  method: string | null;
  headers: [string, string][];
  data: string[];
  json: string | null;
  form: string[];
  unsupported: boolean;
}

function readCurlArgs(words: string[]): CurlArgs {
  const args: CurlArgs = { url: null, method: null, headers: [], data: [], json: null, form: [], unsupported: false };
  const take = (flag: string, value: string | undefined) => {
    if (value === undefined) {
      args.unsupported = true;
      return;
    }
    switch (flag) {
      case "-X":
      case "--request":
        args.method = value.toUpperCase();
        break;
      case "-H":
      case "--header": {
        const colon = value.indexOf(":");
        if (colon > 0) args.headers.push([value.slice(0, colon).trim().toLowerCase(), value.slice(colon + 1).trim()]);
        break;
      }
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-ascii":
        args.data.push(value);
        break;
      case "--json":
        args.json = value;
        break;
      case "-F":
      case "--form":
      case "--form-string":
        args.form.push(value);
        break;
      case "--url":
        args.url = value;
        break;
      case "--data-urlencode":
      case "-T":
      case "--upload-file":
        args.unsupported = true;
        break;
      default:
        break;
    }
  };
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = eq > 0 ? w.slice(0, eq) : w;
      if (name === "--head" || name === "--get") args.unsupported = true;
      if (VALUE_FLAGS.has(name)) take(name, eq > 0 ? w.slice(eq + 1) : words[++i]);
      continue;
    }
    if (w.startsWith("-") && w.length > 1) {
      // A short-option cluster such as -sS, -XPOST or -N.
      for (let k = 1; k < w.length; k++) {
        const letter = w[k];
        if (letter === "I" || letter === "G") args.unsupported = true;
        if (SHORT_VALUE.has(letter)) {
          const rest = w.slice(k + 1);
          take(`-${letter}`, rest ? rest : words[++i]);
          break;
        }
      }
      continue;
    }
    if (!args.url) args.url = w;
  }
  return args;
}

/** One form field from -F: "purpose=user_data", "file=@photo.png;type=image/png", 'request={...};type=application/json'. */
function formField(spec: string): ParsedFormField | null {
  const eq = spec.indexOf("=");
  if (eq <= 0) return null;
  const name = spec.slice(0, eq);
  const raw = spec.slice(eq + 1);
  if (raw.startsWith("@") || raw.startsWith("<")) {
    const [file, ...params] = raw.slice(1).split(";");
    const typed = params.find((p) => p.startsWith("type="))?.slice(5);
    const type = typed || typeOfName(file);
    const base = file.split("/").pop() || file;
    return { name, file: { label: `${kindOf(type, name)} to upload (${base})`, accept: acceptFor(type), as: "file" } };
  }
  // curl's ";type=..." and ";filename=..." suffixes set the part's headers; they aren't part of the value.
  let value = raw;
  for (;;) {
    const suffix = value.match(/;(?:type|filename)=[^;"'{}]*$/i);
    if (!suffix || suffix.index === undefined) break;
    value = value.slice(0, suffix.index);
  }
  return { name, value };
}

/** A request with its file slots, id slots and stream flag worked out; null for a method the proxy doesn't run. */
export function toParsedRequest(
  method: string,
  path: string,
  headers: [string, string][],
  body: unknown,
  form: ParsedFormField[] | undefined,
): ParsedRequest | null {
  if (method !== "GET" && method !== "POST" && method !== "DELETE") return null;
  const fileSlots: ParsedFileSlot[] = [];
  const fileIds: ParsedIdSlot[] = pathIds(path);
  if (body !== undefined) bodySlots(body, fileSlots, fileIds);
  const accept = headers.find(([name]) => name === "accept")?.[1] ?? null;
  const out: ParsedRequest = { method, path, fileSlots, fileIds, stream: isStream(path, body, accept) };
  if (body !== undefined) out.body = body;
  if (form) out.form = form;
  return out;
}

/** The request a curl command makes, when it calls https://api.meta.ai/v1 in a way the proxy can repeat. */
export function parseCurl(command: string): ParsedRequest | null {
  const start = command.search(/\bcurl\b/);
  if (start < 0) return null;
  const words = shellWords(command.slice(start));
  if (!words || words[0] !== "curl") return null;
  const args = readCurlArgs(words);
  if (args.unsupported || !args.url) return null;
  const path = metaPath(args.url);
  if (!path) return null;

  let body: unknown;
  let form: ParsedFormField[] | undefined;
  if (args.form.length) {
    if (args.data.length || args.json !== null) return null;
    const fields = args.form.map(formField);
    if (fields.some((f) => !f)) return null;
    form = fields as ParsedFormField[];
  } else if (args.json !== null || args.data.length) {
    const text = args.json ?? args.data.join("&");
    if (text.startsWith("@")) return null;
    try {
      body = JSON.parse(text);
    } catch {
      return null;
    }
  }
  const method = args.method ?? (body !== undefined || form ? "POST" : "GET");
  return toParsedRequest(method, path, args.headers, body, form);
}

/**
 * The request a bare HTTP request line makes: "POST https://api.meta.ai/v1/responses", optional header lines, then a
 * JSON body.
 */
export function parseHttpRequest(text: string): ParsedRequest | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const m = lines[i]?.trim().match(/^(GET|POST|DELETE)\s+(\S+)(?:\s+HTTP\/[\d.]+)?$/i);
  if (!m) return null;
  const path = metaPath(m[2]);
  if (!path) return null;
  i++;
  const headers: [string, string][] = [];
  while (i < lines.length && /^[A-Za-z][\w-]*:\s*\S/.test(lines[i])) {
    const colon = lines[i].indexOf(":");
    headers.push([lines[i].slice(0, colon).trim().toLowerCase(), lines[i].slice(colon + 1).trim()]);
    i++;
  }
  const rest = lines.slice(i).join("\n").trim();
  let body: unknown;
  if (rest) {
    try {
      body = JSON.parse(rest);
    } catch {
      return null;
    }
  }
  return toParsedRequest(m[1].toUpperCase(), path, headers, body, undefined);
}

/**
 * Every curl command in a block of code, each from its `curl` word to the end of that command: at the start of a
 * line (after an optional "$ " prompt), or captured into a variable as in `response=$(curl ...)`.
 */
export function curlCommands(code: string): string[] {
  const out: string[] = [];
  const re = /(^|\n)[ \t]*(?:\$[ \t]+|[A-Za-z_]\w*=(\$\())?(curl\b)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const start = m.index + m[0].length - "curl".length;
    if (!m[2]) {
      out.push(code.slice(start));
      continue;
    }
    // Captured as $(curl ...): the command ends at the parenthesis that closes it.
    const close = closeParen(code, start - 1);
    if (close > start) out.push(code.slice(start, close));
  }
  return out;
}

/**
 * The first runnable Meta API request in a code block (a curl command, a bare request line, or an SDK call with
 * literal arguments), or null. `lang` is the fence's language, which tells Python from TypeScript.
 */
export function requestFromCode(code: string, lang = ""): ParsedRequest | null {
  if (!code.includes("api.meta.ai")) return null;
  for (const command of curlCommands(code)) {
    const parsed = parseCurl(command);
    if (parsed) return parsed;
  }
  const line = parseHttpRequest(code);
  if (line) return line;
  const call = sdkCallFromCode(code, lang);
  return call ? toParsedRequest(call.method, call.path, [], call.body, undefined) : null;
}
