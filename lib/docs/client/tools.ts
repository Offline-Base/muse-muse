import { CalcError, evaluate, tidy } from "@/lib/docs/client/calc";
import type { ToolDef } from "@/lib/docs/client/body";

/**
 * Built-in mock tools for the tool-calling demos. Each has the definition the model sees and a local function the
 * playground runs when the model calls it, the way a reader's own code would. They answer with made-up but steady
 * data (the same city always gets the same weather) and never reach anything outside the page: send_email only
 * says what it would have sent, and search_docs reads this site's own docs index.
 */

type Args = Record<string, unknown>;

export interface MockTool extends ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Args): unknown | Promise<unknown>;
}

/** A tool as a page gives it: a built-in's name, or a definition with an optional fixed result. */
export interface ToolSpec {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
  /** What the tool returns whatever the arguments. Overrides a built-in's own answer. */
  result?: unknown;
}

export interface ResolvedTool {
  def: ToolDef;
  /** True when a built-in mock's own code answers. */
  builtIn: boolean;
  /** Where the answer comes from: a built-in mock, a fixed result from the page, or an echo of the arguments. */
  source: "mock" | "fixed" | "echo";
  run(args: Args): Promise<unknown>;
}

const MOCK_NOTE = "Sample data from a mock tool in the docs demo.";

/** A steady small number from a string, so mock answers don't change between runs. */
export function hashOf(text: string): number {
  let h = 2166136261;
  for (const ch of text.toLowerCase().trim()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function text(args: Args, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v);
}

const CONDITIONS = ["Sunny", "Partly cloudy", "Cloudy", "Light rain", "Showers", "Windy", "Fog", "Clear"];
const ORDER_STATUS = ["processing", "shipped", "out for delivery", "delivered"];
const ITEMS = ["Trail running shoes", "Wool socks (3 pairs)", "Insulated water bottle", "Rain shell jacket", "Headlamp"];

/** Pages the search_docs mock can fall back on when the site's search index can't be read. */
const DOCS_FALLBACK = [
  { title: "Quickstart", url: "/docs/quickstart", text: "Set your key, call the API, and read your first response." },
  { title: "Tool calling", url: "/docs/tool-calling", text: "Define functions, run the calls the model returns, and send results back." },
  { title: "Structured output", url: "/docs/structured-output", text: "Constrain replies to a JSON Schema with text.format or response_format." },
  { title: "Search grounding", url: "/docs/search-grounding", text: "Add the web_search tool for cited, current answers." },
  { title: "Reasoning", url: "/docs/reasoning", text: "Control reasoning effort and request reasoning summaries." },
  { title: "Responses API", url: "/docs/protocols/responses", text: "Multi-turn with previous_response_id, streaming events, background runs." },
  { title: "Chat completion", url: "/docs/protocols/chat-completions", text: "OpenAI-compatible messages, streaming chunks, tool calls." },
  { title: "Messages API", url: "/docs/protocols/messages", text: "Anthropic-compatible requests with max_tokens, thinking and tools." },
  { title: "Pricing and rate limits", url: "/docs/pricing-rate-limits", text: "Per-token prices, Contributor mode, and limits per model." },
  { title: "Error handling", url: "/docs/error-handling", text: "Error shapes, retries with backoff, and streaming errors." },
  { title: "Image understanding", url: "/docs/image-understanding", text: "Send photos, charts and screenshots as input_image." },
  { title: "File handling", url: "/docs/file-handling", text: "Upload files and reference them by file_id." },
];

let docsIndex: Promise<Array<{ title: string; url: string; text: string }>> | null = null;

/** The site's search index (/docs/search.json), read once per page load; the short list above if that fails. */
function loadDocsIndex() {
  if (!docsIndex) {
    docsIndex = (async () => {
      try {
        if (typeof fetch !== "function" || typeof window === "undefined") return DOCS_FALLBACK;
        const res = await fetch("/docs/search.json", { credentials: "same-origin" });
        if (!res.ok) return DOCS_FALLBACK;
        const raw = (await res.json()) as unknown;
        const list = Array.isArray(raw) ? raw : Array.isArray((raw as { pages?: unknown }).pages) ? (raw as { pages: unknown[] }).pages : [];
        const pages = list
          .map((p) => p as Record<string, unknown>)
          .filter((p) => typeof p.title === "string")
          .map((p) => ({
            title: String(p.title),
            url: typeof p.href === "string" ? p.href : typeof p.url === "string" ? p.url : typeof p.slug === "string" ? `/docs/${p.slug}` : "/docs",
            text: [p.description, p.navLabel, ...(Array.isArray(p.headings) ? p.headings.map((h) => (typeof h === "string" ? h : (h as { text?: string }).text)) : [])]
              .filter((x) => typeof x === "string")
              .join(" "),
          }));
        return pages.length ? pages : DOCS_FALLBACK;
      } catch {
        return DOCS_FALLBACK;
      }
    })();
  }
  return docsIndex;
}

/** The best matches for a query by shared words, title words counting double. */
export function rankDocs(pages: Array<{ title: string; url: string; text: string }>, query: string, limit = 3) {
  const words = query.toLowerCase().match(/[a-z0-9_]+/g)?.filter((w) => w.length > 2) ?? [];
  if (!words.length) return [];
  return pages
    .map((p) => {
      const title = p.title.toLowerCase();
      const body = p.text.toLowerCase();
      const score = words.reduce((sum, w) => sum + (title.includes(w) ? 2 : 0) + (body.includes(w) ? 1 : 0), 0);
      return { page: p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ page }) => ({ title: page.title, url: page.url, snippet: page.text.slice(0, 200) }));
}

export const MOCK_TOOLS: Record<string, MockTool> = {
  get_weather: {
    name: "get_weather",
    description: "Return current weather for the given location.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name, e.g. 'Seattle'" },
        unit: { type: "string", enum: ["celsius", "fahrenheit"], description: "Temperature unit. Defaults to celsius." },
      },
      required: ["location"],
      additionalProperties: false,
    },
    run(args) {
      const location = text(args, "location") || "Unknown";
      const h = hashOf(location);
      const celsius = 4 + (h % 27);
      const fahrenheit = text(args, "unit") === "fahrenheit";
      return {
        location,
        temperature: fahrenheit ? `${Math.round((celsius * 9) / 5 + 32)}°F` : `${celsius}°C`,
        condition: CONDITIONS[(h >>> 5) % CONDITIONS.length],
        humidity: `${35 + ((h >>> 9) % 55)}%`,
        wind: `${3 + ((h >>> 13) % 30)} km/h`,
        note: MOCK_NOTE,
      };
    },
  },
  get_time: {
    name: "get_time",
    description: "Return the current date and time in an IANA time zone.",
    parameters: {
      type: "object",
      properties: { timezone: { type: "string", description: "IANA time zone, e.g. 'Asia/Tokyo' or 'America/New_York'" } },
      required: ["timezone"],
      additionalProperties: false,
    },
    run(args) {
      const timezone = text(args, "timezone") || "UTC";
      const now = new Date();
      try {
        const local = new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "full", timeStyle: "long" }).format(now);
        return { timezone, local_time: local, utc: now.toISOString() };
      } catch {
        return { error: `Unknown time zone "${timezone}". Use an IANA name such as Europe/London.` };
      }
    },
  },
  calculator: {
    name: "calculator",
    description: "Evaluate an arithmetic expression. Supports + - * / % ^, parentheses, sqrt, round, min, max, log, ln, pi and e.",
    parameters: {
      type: "object",
      properties: { expression: { type: "string", description: "The expression, e.g. '(3 + 4) * 2 ^ 3'" } },
      required: ["expression"],
      additionalProperties: false,
    },
    run(args) {
      const expression = text(args, "expression");
      try {
        return { expression, result: tidy(evaluate(expression)) };
      } catch (err) {
        return { expression, error: err instanceof CalcError ? err.message : "Couldn't evaluate the expression." };
      }
    },
  },
  lookup_order: {
    name: "lookup_order",
    description: "Look up an order by its id and return its status, items and delivery estimate.",
    parameters: {
      type: "object",
      properties: { order_id: { type: "string", description: "The order id, e.g. 'A1042'" } },
      required: ["order_id"],
      additionalProperties: false,
    },
    run(args) {
      const id = text(args, "order_id");
      if (!id) return { error: "order_id is required." };
      const h = hashOf(id);
      const status = ORDER_STATUS[h % ORDER_STATUS.length];
      const items = [ITEMS[h % ITEMS.length], ITEMS[(h >>> 7) % ITEMS.length]].filter((x, i, a) => a.indexOf(x) === i);
      return {
        order_id: id,
        status,
        items,
        total: `$${(20 + (h % 18000) / 100).toFixed(2)}`,
        estimated_delivery: status === "delivered" ? "Delivered" : `${1 + ((h >>> 3) % 6)} business days`,
        note: MOCK_NOTE,
      };
    },
  },
  search_docs: {
    name: "search_docs",
    description: "Search these Model API docs and return the most relevant pages with a short snippet each.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "What to look for, e.g. 'stream tool call arguments'" } },
      required: ["query"],
      additionalProperties: false,
    },
    async run(args) {
      const query = text(args, "query");
      const results = rankDocs(await loadDocsIndex(), query);
      return { query, results, ...(results.length ? {} : { note: "No page matched. Try other words." }) };
    },
  },
  send_email: {
    name: "send_email",
    description: "Send an email to one recipient.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Subject line" },
        body: { type: "string", description: "Plain-text body" },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
    run(args) {
      // A demo must never send mail: this only describes what a real tool would have sent.
      return {
        status: "not_sent",
        note: "This demo only pretends. No email was sent.",
        would_send: { to: text(args, "to"), subject: text(args, "subject"), body_preview: text(args, "body").slice(0, 160) },
      };
    },
  },
};

export const MOCK_TOOL_NAMES = Object.keys(MOCK_TOOLS);

/**
 * The tools a page asked for, ready to send and run. A name picks a built-in; a definition with the same name as a
 * built-in keeps the built-in's code unless it (or `results`) gives a fixed result; any other definition answers with
 * its fixed result, or echoes its arguments so the loop can still finish.
 */
export function resolveTools(tools: ReadonlyArray<string | ToolSpec>, results: Record<string, unknown> = {}): ResolvedTool[] {
  return tools.map((t) => {
    const spec: ToolSpec = typeof t === "string" ? { name: t } : t;
    const mock = MOCK_TOOLS[spec.name];
    const fixed = Object.prototype.hasOwnProperty.call(results, spec.name) ? results[spec.name] : spec.result;
    const def: ToolDef = {
      name: spec.name,
      description: spec.description ?? mock?.description ?? `The ${spec.name} tool.`,
      parameters: spec.parameters ?? mock?.parameters ?? { type: "object", properties: {}, additionalProperties: true },
      ...(spec.strict !== undefined ? { strict: spec.strict } : {}),
    };
    const run = async (args: Args): Promise<unknown> => {
      if (fixed !== undefined) return fixed;
      if (mock) return mock.run(args);
      return { ok: true, note: `The demo has no local code for ${spec.name}, so it echoes the arguments.`, arguments: args };
    };
    const source = fixed !== undefined ? "fixed" : mock ? "mock" : "echo";
    return { def, builtIn: source === "mock", source, run };
  });
}

export interface ToolRun {
  ok: boolean;
  /** The string sent back to the model (function_call_output.output or the tool message's content). */
  output: string;
  /** The same, parsed, for display. */
  value: unknown;
  ms: number;
}

/** Runs one call the model made: parses its arguments, runs the tool, and turns the result into the text sent back. */
export async function runToolCall(tools: ResolvedTool[], name: string, argumentsJson: string): Promise<ToolRun> {
  const started = Date.now();
  const finish = (ok: boolean, value: unknown): ToolRun => ({
    ok,
    value,
    output: typeof value === "string" ? value : JSON.stringify(value),
    ms: Date.now() - started,
  });
  const tool = tools.find((t) => t.def.name === name);
  if (!tool) return finish(false, { error: `There is no tool named "${name}".` });
  let args: Args = {};
  if (argumentsJson.trim()) {
    try {
      const parsed = JSON.parse(argumentsJson) as unknown;
      args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Args) : {};
    } catch {
      return finish(false, { error: "The arguments weren't valid JSON." });
    }
  }
  try {
    const value = await tool.run(args);
    const failed = !!value && typeof value === "object" && "error" in (value as Record<string, unknown>);
    return finish(!failed, value);
  } catch (err) {
    return finish(false, { error: err instanceof Error ? err.message : "The tool failed." });
  }
}
