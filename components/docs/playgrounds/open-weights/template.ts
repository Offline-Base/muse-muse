import { GLIMMER_DEFAULT_STRENGTH, SPARK, sparkStrength, type OpenEffort, type OpenModel } from "@/components/docs/playgrounds/open-weights/facts";

/**
 * What the chat template turns a conversation into, for the two prompting guides (muse-spark-open/prompting,
 * muse-glimmer/prompting). It writes exactly the framing those pages render: the special tokens, the role headers, the
 * system block's lines in the documented order, ATEM tool calls with <|eom|> between calls and <|eot|> after the last,
 * <tool_output> results, and the media placeholders. Parts the pages leave out (the tool catalog's text, Muse Spark
 * Open's recipient lines, Muse Glimmer's default system line) are marked "elided" instead of invented, and pieces the
 * pages describe without printing are marked "inferred", so the reader can tell the documented text from the rest.
 * The real text always comes from the tokenizer's apply_chat_template; snippetFor() writes that call.
 */

export type SegKind = "special" | "text" | "inferred" | "elided" | "media";

export interface Segment {
  text: string;
  kind: SegKind;
  /** Why a segment is elided or inferred, for its tooltip. */
  note?: string;
}

export type MediaKind = "image" | "video" | "audio";
export type UserPart = { type: "text"; text: string } | { type: MediaKind };

export interface ToolCallIn {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ConvMessage =
  | { role: "system"; content: string }
  | { role: "user"; parts: UserPart[] }
  | { role: "assistant"; content?: string; reasoning?: string; toolCalls?: ToolCallIn[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolDefIn {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface RenderOptions {
  model: OpenModel;
  effort: OpenEffort;
  /** Muse Spark Open's chat_template_kwargs.current_date (YYYY-MM-DD). Defaults to today's date on a real server. */
  currentDate: string;
  tools: ToolDefIn[];
  addGenerationPrompt: boolean;
}

export interface Issue {
  level: "error" | "warn" | "note";
  text: string;
}

export interface Rendered {
  segments: Segment[];
  issues: Issue[];
}

/** The page's get_weather tool, as both prompting guides define it. */
export const GET_WEATHER: ToolDefIn = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

/** The script's own answers on muse-spark-open/prompting ("Call tools"). */
export function pageWeather(city: unknown): string {
  const table: Record<string, string> = { Paris: "sunny", Rome: "rain", Tokyo: "cloudy" };
  return typeof city === "string" && table[city] ? table[city] : "unknown";
}

const MEDIA_TOKEN: Record<OpenModel, Partial<Record<MediaKind, string>>> = {
  spark: { image: "<|patch|>", video: "<|video|>", audio: "<|audio|>" },
  glimmer: { image: "<|image|>" },
};

export const SPECIAL_TOKENS = [
  "<|begin_of_text|>",
  "<|end_of_text|>",
  "<|start|>",
  "<|message|>",
  "<|eot|>",
  "<|eom|>",
  "<|patch|>",
  "<|video|>",
  "<|audio|>",
  "<|image|>",
] as const;

class Out {
  segments: Segment[] = [];
  push(text: string, kind: SegKind = "text", note?: string) {
    if (!text) return;
    const last = this.segments[this.segments.length - 1];
    if (last && last.kind === kind && kind !== "special" && kind !== "media" && last.note === note) last.text += text;
    else this.segments.push(note ? { text, kind, note } : { text, kind });
  }
  special(token: string) {
    this.push(token, "special");
  }
}

/** True when the system prompt fixes the strength itself, which the template then leaves to it. */
export function systemSetsStrength(system: string): boolean {
  return /^\s*Reasoning strength:\s*\S+/im.test(system);
}

/** A strength line written with the level name (Reasoning strength: high.), which Muse Spark Open doesn't read. */
function strengthLineProblem(system: string): string | null {
  const m = /^\s*Reasoning strength:\s*(\S+?)\.?\s*$/im.exec(system);
  if (!m) return null;
  return /^\d+$/.test(m[1]) ? null : m[1];
}

function argValue(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

function atemCall(out: Out, call: ToolCallIn, inferred: boolean) {
  const lines = [
    "<atem:function_calls>\n",
    `<atem:invoke name="${call.name}">\n`,
    ...Object.entries(call.arguments).map(([k, v]) => `<atem:parameter name="${k}">${argValue(v)}</atem:parameter>\n`),
    "</atem:invoke>\n",
    "</atem:function_calls>",
  ];
  out.push(lines.join(""), inferred ? "inferred" : "text", inferred ? "The page prints this call format for model output; replayed history is assumed to match." : undefined);
}

/** Every call id the conversation's assistant turns made, in order, with the tool it named. */
function callIndex(messages: ConvMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) if (m.role === "assistant") for (const c of m.toolCalls ?? []) map.set(c.id, c.name);
  return map;
}

/** Renders the conversation the way the model sees it, with what the pages don't print marked as such. */
export function renderTemplate(messages: ConvMessage[], opts: RenderOptions): Rendered {
  return opts.model === "spark" ? renderSpark(messages, opts) : renderGlimmer(messages, opts);
}

function renderSpark(messages: ConvMessage[], opts: RenderOptions): Rendered {
  const out = new Out();
  const issues: Issue[] = [];
  const system = messages.find((m): m is Extract<ConvMessage, { role: "system" }> => m.role === "system");
  const systemText = system?.content.trim() ?? "";
  const strengthBySystem = systemSetsStrength(systemText);
  const badLevel = strengthLineProblem(systemText);
  if (badLevel) issues.push({ level: "warn", text: `Write the strength as a number, not "${badLevel}": the template reads Reasoning strength: 256., not the level name.` });
  if (strengthBySystem && !badLevel) {
    issues.push({ level: "note", text: "Your system prompt sets the strength, so the template leaves its own line out and reasoning_effort has no effect." });
  }

  out.special("<|begin_of_text|>");
  out.special("<|start|>");
  out.push("system");
  out.special("<|message|>");
  out.push(`You are a helpful AI assistant.\n\nKnowledge cutoff: ${SPARK.knowledgeCutoff}.\n\nCurrent date: ${opts.currentDate}.\n\n`);
  if (systemText) out.push(`${systemText}\n\n`);
  if (opts.tools.length) {
    out.push(
      `[tool definitions for ${opts.tools.map((t) => t.name).join(", ")}]`,
      "elided",
      "The template writes your tools' definitions here. The page doesn't print their text: render it with apply_chat_template.",
    );
    out.push("\n\n");
  }
  if (!strengthBySystem) out.push(`Reasoning strength: ${sparkStrength(opts.effort)}.\n\n`);
  out.push("Use the appropriate recipient for each message:\n");
  out.push(
    `[recipient lines: self, commentary, user${opts.tools.length ? `, ${opts.tools.map((t) => t.name).join(", ")}` : ""}]`,
    "elided",
    "The page shows this list as \"...\". The recipients it names are self (reasoning), commentary, a tool's name and user.",
  );
  out.special("<|eot|>");

  const calls = callIndex(messages);
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.special("<|start|>");
      out.push("user");
      out.special("<|message|>");
      for (const p of m.parts) {
        if (p.type === "text") out.push(p.text);
        else out.push(MEDIA_TOKEN.spark[p.type] ?? "", "media");
      }
      if (m.parts.some((p) => p.type === "video")) {
        issues.push({ level: "note", text: "Video: use clips longer than a few seconds at 448 px or more on the short side, or the model can reply that it can't view it." });
      }
      out.special("<|eot|>");
      continue;
    }
    if (m.role === "assistant") {
      const toolCalls = m.toolCalls ?? [];
      if (m.reasoning) {
        out.special("<|start|>");
        out.push("assistant to=self", "inferred", "Reasoning goes to self; the prompting guide doesn't say whether the template replays it.");
        out.special("<|message|>");
        out.push(m.reasoning, "inferred");
        out.special("<|eom|>");
      }
      toolCalls.forEach((call, i) => {
        out.special("<|start|>");
        out.push(`assistant to=${call.name}`);
        out.special("<|message|>");
        atemCall(out, call, false);
        // Each call but the last in a turn ends with <|eom|>, the last with <|eot|>.
        out.special(i < toolCalls.length - 1 ? "<|eom|>" : "<|eot|>");
        if (Object.values(call.arguments).some((v) => typeof v !== "string")) {
          issues.push({ level: "note", text: "The page shows string arguments only; other values are written here as JSON." });
        }
      });
      if (!toolCalls.length && m.content !== undefined) {
        out.special("<|start|>");
        out.push("assistant to=user");
        out.special("<|message|>");
        out.push(m.content);
        out.special("<|eot|>");
      }
      continue;
    }
    // tool
    const name = calls.get(m.toolCallId);
    if (!name) {
      issues.push({ level: "error", text: `A tool result answers ${m.toolCallId || "no call"}, which no assistant turn made. The template finds the call by tool_call_id.` });
    }
    answered.add(m.toolCallId);
    out.special("<|start|>");
    out.push(`tool ${name ?? "?"}`);
    out.special("<|message|>");
    out.push(`<tool_output name="${name ?? "?"}">\n${m.content}\n</tool_output>`);
    out.special("<|eot|>");
  }

  const unanswered = [...calls.keys()].filter((id) => !answered.has(id));
  if (unanswered.length) {
    issues.push({ level: "warn", text: `Answer every call with its own tool message before the next request: ${unanswered.length} call${unanswered.length === 1 ? " has" : "s have"} no result yet.` });
  }
  const sameTool = [...calls.values()].length !== new Set(calls.values()).size;
  if (sameTool) {
    issues.push({ level: "note", text: "Several calls use the same tool, and a result carries only the function name, so send the results in the order of the calls." });
  }

  if (opts.addGenerationPrompt) {
    out.special("<|start|>");
    out.push("assistant");
  } else {
    issues.push({ level: "warn", text: "Without add_generation_prompt the prompt doesn't end with <|start|>assistant, so the model isn't cued to answer." });
  }
  return { segments: out.segments, issues };
}

function renderGlimmer(messages: ConvMessage[], opts: RenderOptions): Rendered {
  const out = new Out();
  const issues: Issue[] = [];
  const system = messages.find((m): m is Extract<ConvMessage, { role: "system" }> => m.role === "system");
  const systemText = system?.content.trim() ?? "";
  const inferredNote = "The guide describes this but doesn't print it for this case.";

  out.special("<|begin_of_text|>");
  out.special("<|start|>");
  out.push("system");
  out.special("<|message|>");
  if (systemText) out.push(`${systemText}\n\n`);
  else {
    out.push(
      "[default system line with the knowledge cutoff]",
      "elided",
      "Without a system prompt, the template inserts a short default system turn with a knowledge-cutoff line. The guide doesn't print its text.",
    );
    out.push("\n\n");
  }
  if (opts.tools.length) {
    out.push(`[tool catalog for ${opts.tools.map((t) => t.name).join(", ")}]`, "elided", "The template renders your tools into the system turn. The guide doesn't print the catalog or say where in the turn it sits.");
    out.push("\n\n");
  }
  out.push(`Reasoning strength: ${opts.effort}.\n\n`);
  const recipients = ["self", "user", ...opts.tools.map((t) => t.name)].map((r) => `"${r}"`).join(", ");
  if (opts.tools.length) {
    out.push(`# Valid recipients: ${recipients}.`, "inferred", "The template derives recipients from your messages and tools; the guide prints only \"self\" and \"user\".");
  } else out.push(`# Valid recipients: ${recipients}.`);
  out.special("<|eot|>");

  const calls = callIndex(messages);
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.special("<|start|>");
      out.push("user");
      out.special("<|message|>");
      for (const p of m.parts) {
        if (p.type === "text") out.push(p.text);
        else if (p.type === "image") out.push("<|image|>", "media");
        else {
          issues.push({ level: "error", text: `Muse Glimmer reads text and images only, so the ${p.type} part can't be sent.` });
        }
      }
      out.special("<|eot|>");
      continue;
    }
    if (m.role === "assistant") {
      const toolCalls = m.toolCalls ?? [];
      if (m.reasoning) {
        out.special("<|start|>");
        out.push("assistant to=self", "inferred", "reasoning_content renders as the to=self turn (prompting guide); the exact framing isn't printed.");
        out.special("<|message|>");
        out.push(m.reasoning);
        out.special("<|eom|>");
      }
      if (toolCalls.length > 1) {
        issues.push({
          level: "error",
          text: "Muse Glimmer supports one tool call per turn and no parallel calls: return each result before asking for the next tool.",
        });
      }
      toolCalls.forEach((call) => {
        out.special("<|start|>");
        out.push(`assistant to=${call.name}`);
        out.special("<|message|>");
        atemCall(out, call, false);
        out.special("<|eot|>");
      });
      if (!toolCalls.length && m.content !== undefined) {
        out.special("<|start|>");
        out.push("assistant");
        out.push(" to=user", "inferred", "to=user is the default recipient for a reply; whether the template spells it out in history isn't printed.");
        out.special("<|message|>");
        out.push(m.content);
        out.special("<|eot|>");
      }
      continue;
    }
    const name = calls.get(m.toolCallId);
    if (!name) issues.push({ level: "error", text: `A tool result answers ${m.toolCallId || "no call"}, which no assistant turn made.` });
    out.special("<|start|>");
    out.push(`tool ${name ?? "?"}`, "inferred", inferredNote);
    out.special("<|message|>");
    out.push(`<tool_output name="${name ?? "?"}">\n${m.content}\n</tool_output>`, "inferred", "The template wraps a result in a <tool_output> block on a tool turn; this follows Muse Spark Open's printed form.");
    out.special("<|eot|>");
  }

  if (opts.addGenerationPrompt) {
    out.special("<|start|>");
    out.push("assistant");
  } else {
    issues.push({ level: "warn", text: "Missing generation prompt: without add_generation_prompt=True the model doesn't receive the cue to start generating." });
  }
  if (opts.effort !== GLIMMER_DEFAULT_STRENGTH) {
    issues.push({ level: "note", text: `reasoning_strength="${opts.effort}" is a template argument (default "high"), passed to apply_chat_template or as chat_template_kwargs.` });
  }
  return { segments: out.segments, issues };
}

// ---------------------------------------------------------------------------------------------------------------
// Token counts

/**
 * A rough BPE-style count for plain text: words and number groups as one token each (long words as several),
 * punctuation as one. Special tokens are exact (one each); elided parts aren't counted at all.
 */
export function estimateTextTokens(text: string): number {
  let count = 0;
  for (const m of text.matchAll(/\s*[A-Za-z]+|\s*\d{1,3}|\s*[^\sA-Za-z\d]|\s+$/g)) {
    const word = m[0].trim();
    count += /^[A-Za-z]+$/.test(word) ? Math.max(1, Math.ceil(word.length / 7)) : 1;
  }
  return count;
}

export interface TokenTally {
  special: number;
  media: number;
  text: number;
  elided: number;
  total: number;
}

export function tallyTokens(segments: Segment[]): TokenTally {
  const t: TokenTally = { special: 0, media: 0, text: 0, elided: 0, total: 0 };
  for (const s of segments) {
    if (s.kind === "special") t.special += 1;
    else if (s.kind === "media") t.media += 1;
    else if (s.kind === "elided") t.elided += 1;
    else t.text += estimateTextTokens(s.text);
  }
  t.total = t.special + t.media + t.text;
  return t;
}

/** The rendered text as one string, with elided parts kept in brackets so a copy says what's missing. */
export function plainText(segments: Segment[]): string {
  return segments.map((s) => s.text).join("");
}

// ---------------------------------------------------------------------------------------------------------------
// The same conversation as a server request and as an apply_chat_template call

const SAMPLE_MEDIA_URL: Record<MediaKind, string> = {
  image: "https://example.com/chart.png",
  video: "https://example.com/demo.mp4",
  audio: "https://example.com/question.wav",
};

type Json = Record<string, unknown>;

/** OpenAI-style function tools, as both guides pass them. */
export function openaiTools(tools: ToolDefIn[]): Json[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, ...(t.description ? { description: t.description } : {}), ...(t.parameters ? { parameters: t.parameters } : {}) },
  }));
}

/**
 * The messages as Chat Completions JSON. `argsAs: "string"` writes tool-call arguments as a JSON string (what a server
 * takes); `"dict"` keeps them an object, which apply_chat_template needs ("Pass each call's arguments ... as a
 * dictionary, not a JSON string"). Media parts differ the same way: a server takes OpenAI-style image_url, video_url
 * and audio_url parts (muse-spark-open/prompting, "Send images, video, and audio"), while the processor's
 * apply_chat_template takes {"type": "image", "url": ...} (muse-glimmer/prompting, "Multimodal input"), and video
 * and audio the same way.
 */
export function chatMessages(messages: ConvMessage[], model: OpenModel, argsAs: "string" | "dict" = "string", media: "server" | "processor" = "server"): Json[] {
  return messages.map((m): Json => {
    if (m.role === "system") return { role: "system", content: m.content };
    if (m.role === "user") {
      const onlyText = m.parts.every((p) => p.type === "text");
      if (onlyText) return { role: "user", content: m.parts.map((p) => (p.type === "text" ? p.text : "")).join("") };
      return {
        role: "user",
        content: m.parts.map((p) => {
          if (p.type === "text") return { type: "text", text: p.text };
          if (media === "processor") return { type: p.type, url: SAMPLE_MEDIA_URL[p.type] };
          const key = `${p.type}_url`;
          return { type: key, [key]: { url: SAMPLE_MEDIA_URL[p.type] } };
        }),
      };
    }
    if (m.role === "assistant") {
      const out: Json = { role: "assistant" };
      if (m.content !== undefined && !m.toolCalls?.length) out.content = m.content;
      if (m.reasoning && model === "glimmer") out.reasoning_content = m.reasoning;
      if (m.toolCalls?.length) {
        out.content = null;
        out.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: argsAs === "dict" ? c.arguments : JSON.stringify(c.arguments) },
        }));
      }
      return out;
    }
    return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  });
}

/** What a self-hosted OpenAI-compatible server receives for this conversation. */
export function serverRequest(messages: ConvMessage[], opts: RenderOptions): Json {
  const body: Json = {
    model: opts.model === "spark" ? "meta-models/Muse-Spark-Open-816B-A42B" : "muse-glimmer",
    messages: chatMessages(messages, opts.model),
  };
  if (opts.tools.length) body.tools = openaiTools(opts.tools);
  if (opts.model === "spark") {
    body.reasoning_effort = opts.effort;
    body.chat_template_kwargs = { current_date: opts.currentDate };
  } else {
    body.chat_template_kwargs = { reasoning_strength: opts.effort };
  }
  body.stream = true;
  return body;
}

function pyValue(value: unknown, level: number): string {
  const pad = "    ".repeat(level + 1);
  const end = "    ".repeat(level);
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((v) => `${pad}${pyValue(v, level + 1)}`).join(",\n")},\n${end}]`;
  }
  const entries = Object.entries(value as Json);
  const flat = entries.every(([, v]) => v === null || typeof v !== "object");
  const line = `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${pyValue(v, level + 1)}`).join(", ")}}`;
  if (flat && line.length + level * 4 <= 96) return line;
  return `{\n${entries.map(([k, v]) => `${pad}${JSON.stringify(k)}: ${pyValue(v, level + 1)}`).join(",\n")},\n${end}}`;
}

/** The Python that prints the real rendering: the tokenizer's (or, with media, the processor's) apply_chat_template. */
export function snippetFor(messages: ConvMessage[], opts: RenderOptions): string {
  const repo = opts.model === "spark" ? "meta-models/Muse-Spark-Open-816B-A42B" : "meta-models/Muse-Glimmer-30B";
  const media = messages.some((m) => m.role === "user" && m.parts.some((p) => p.type !== "text"));
  const loader = media ? "AutoProcessor" : "AutoTokenizer";
  const varName = media ? "processor" : "tok";
  const lines = [
    `from transformers import ${loader}`,
    "",
    `${varName} = ${loader}.from_pretrained(${JSON.stringify(repo)})`,
    "",
    `messages = ${pyValue(chatMessages(messages, opts.model, "dict", "processor"), 0)}`,
  ];
  if (opts.tools.length) lines.push(`tools = ${pyValue(openaiTools(opts.tools), 0)}`);
  const args = [
    "messages",
    ...(opts.tools.length ? ["tools=tools"] : []),
    `add_generation_prompt=${opts.addGenerationPrompt ? "True" : "False"}`,
    "tokenize=False",
    ...(opts.model === "spark" ? [`reasoning_effort=${JSON.stringify(opts.effort)}`, `current_date=${JSON.stringify(opts.currentDate)}`] : [`reasoning_strength=${JSON.stringify(opts.effort)}`]),
  ];
  lines.push("", `print(${varName}.apply_chat_template(`, ...args.map((a) => `    ${a},`), "))");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Presets: each guide's own examples

export interface TemplatePreset {
  id: string;
  label: string;
  messages: ConvMessage[];
  effort: OpenEffort;
  tools: boolean;
  /** Muse Spark Open's current_date, pinned to the page's example where it shows one. */
  currentDate?: string;
}

const STRUCTURED_SYSTEM = `You are [specific role].

## Objective
Produce [precise user-visible outcome].

## Priority rules
1. [Highest-severity invariant]
2. [Second priority]
3. [Tie-breaker]

## Output
Return exactly: {"decision":"...","confidence":0.0,"evidence":["..."],"explanation":"..."}`;

export const SPARK_PRESETS: TemplatePreset[] = [
  {
    id: "system",
    label: "System prompt",
    effort: "xhigh",
    tools: false,
    currentDate: "2026-10-15",
    messages: [
      { role: "system", content: "You are a code reviewer. Flag correctness bugs before style issues." },
      { role: "user", parts: [{ type: "text", text: "Review this function for off-by-one errors: ..." }] },
    ],
  },
  {
    id: "effort",
    label: "reasoning_effort: high",
    effort: "high",
    tools: false,
    messages: [{ role: "user", parts: [{ type: "text", text: "Find the race condition in this worker-pool design." }] }],
  },
  {
    id: "strength-line",
    label: "Strength in the system prompt",
    effort: "low",
    tools: false,
    messages: [
      { role: "system", content: "You are a release planner. Answer with a numbered plan.\n\nReasoning strength: 256." },
      { role: "user", parts: [{ type: "text", text: "Plan a zero-downtime database migration in three steps." }] },
    ],
  },
  {
    id: "tools",
    label: "Tool loop: three calls",
    effort: "low",
    tools: true,
    messages: [
      { role: "user", parts: [{ type: "text", text: "What's the weather in Paris, Rome, and Tokyo?" }] },
      {
        role: "assistant",
        toolCalls: [
          { id: "call_1", name: "get_weather", arguments: { city: "Paris" } },
          { id: "call_2", name: "get_weather", arguments: { city: "Rome" } },
          { id: "call_3", name: "get_weather", arguments: { city: "Tokyo" } },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: "sunny" },
      { role: "tool", toolCallId: "call_2", content: "rain" },
      { role: "tool", toolCallId: "call_3", content: "cloudy" },
    ],
  },
  {
    id: "media",
    label: "Image, video and audio",
    effort: "medium",
    tools: false,
    messages: [
      {
        role: "user",
        parts: [{ type: "image" }, { type: "video" }, { type: "audio" }, { type: "text", text: "Answer the question in the recording." }],
      },
    ],
  },
  {
    id: "structured",
    label: "Structured system prompt",
    effort: "medium",
    tools: false,
    messages: [
      { role: "system", content: STRUCTURED_SYSTEM },
      { role: "user", parts: [{ type: "text", text: "Ticket: the export button does nothing on Safari 26." }] },
    ],
  },
];

export const GLIMMER_PRESETS: TemplatePreset[] = [
  {
    id: "system",
    label: "System prompt",
    effort: "high",
    tools: false,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", parts: [{ type: "text", text: "Explain speculative decoding in two sentences." }] },
    ],
  },
  {
    id: "reviewer",
    label: "Specific persona",
    effort: "medium",
    tools: false,
    messages: [
      {
        role: "system",
        content:
          "You are a senior Python engineer conducting code review. For each issue, state the line, the problem, and a fix. Respond in markdown with one H2 per issue.",
      },
      { role: "user", parts: [{ type: "text", text: "Review this function:\n\n```python\ndef fetch(url):\n    import requests\n    r = requests.get(url)\n    return r.json()\n```" }] },
    ],
  },
  {
    id: "tools",
    label: "One tool call",
    effort: "low",
    tools: true,
    messages: [
      { role: "user", parts: [{ type: "text", text: "What's the weather in Tokyo?" }] },
      { role: "assistant", toolCalls: [{ id: "call_1", name: "get_weather", arguments: { city: "Tokyo" } }] },
      { role: "tool", toolCallId: "call_1", content: "cloudy" },
    ],
  },
  {
    id: "image",
    label: "Image input",
    effort: "high",
    tools: false,
    messages: [{ role: "user", parts: [{ type: "image" }, { type: "text", text: "What trend does this chart show?" }] }],
  },
  {
    id: "multi",
    label: "Multi-turn with reasoning replay",
    effort: "high",
    tools: false,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", parts: [{ type: "text", text: "What is the capital of France?" }] },
      { role: "assistant", reasoning: "The user asks for France's capital. That is Paris.", content: "The capital of France is Paris." },
      { role: "user", parts: [{ type: "text", text: "What is its population?" }] },
    ],
  },
  {
    id: "no-system",
    label: "No system prompt",
    effort: "low",
    tools: false,
    messages: [{ role: "user", parts: [{ type: "text", text: "In one sentence, what is Muse Glimmer good at?" }] }],
  },
];

/** The text a message shows in the editor and sends to the stand-in. */
export function userText(m: Extract<ConvMessage, { role: "user" }>): string {
  return m.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

// ---------------------------------------------------------------------------------------------------------------
// The live stand-in's side of the conversation

/**
 * The docs samples the stand-in sends in place of the page's example URLs, which aren't real files
 * (public/docs-samples): the bar chart for an image, the street clip for a video, a two-voice call for audio.
 */
export const STANDIN_SAMPLE: Record<MediaKind, { id: string; what: string }> = {
  image: { id: "bar-chart", what: "the bar chart (bar-chart.png)" },
  video: { id: "street-pan", what: "a 5-second street clip (street-pan.mp4)" },
  audio: { id: "two-voices", what: "a two-voice phone call (two-voices.wav)" },
};

/** The media kinds a conversation's user turns carry, in first-seen order. */
export function mediaKinds(conv: ConvMessage[]): MediaKind[] {
  const out: MediaKind[] = [];
  for (const m of conv) if (m.role === "user") for (const p of m.parts) if (p.type !== "text" && !out.includes(p.type)) out.push(p.type);
  return out;
}

/** One media part as hosted Chat Completions takes it (api-reference/chat-completions/schemas), from a data URL. */
function hostedPart(kind: MediaKind, dataUrl: string): Json {
  if (kind === "image") return { type: "image_url", image_url: { url: dataUrl } };
  if (kind === "video") return { type: "video_url", video_url: { url: dataUrl } };
  return { type: "input_audio", input_audio: { data: dataUrl.slice(dataUrl.indexOf(",") + 1), format: "wav" } };
}

/**
 * The conversation as hosted Chat Completions takes it: each media part becomes the docs sample loaded for its kind
 * (`media`, data URLs), in the same place among the text, since the page's example URLs aren't real files; a kind
 * whose sample hasn't loaded is left out. Replayed reasoning_content is left out too. Returns what was left out, for
 * the stand-in's note.
 */
export function hostedMessages(conv: ConvMessage[], model: OpenModel, media: Partial<Record<MediaKind, string>> = {}): { messages: Json[]; dropped: string[] } {
  const dropped = new Set<string>();
  const messages = chatMessages(conv, model).map((m, i) => {
    const src = conv[i];
    if (src?.role === "user" && src.parts.some((p) => p.type !== "text")) {
      const parts: Json[] = [];
      for (const p of src.parts) {
        if (p.type === "text") {
          if (p.text) parts.push({ type: "text", text: p.text });
          continue;
        }
        const url = media[p.type];
        if (url) parts.push(hostedPart(p.type, url));
        else dropped.add(`${p.type} parts (the docs sample hasn't loaded)`);
      }
      return { role: "user", content: parts.length ? parts : "(media only)" };
    }
    if (m.role === "assistant" && "reasoning_content" in m) {
      dropped.add("replayed reasoning_content (hosted Chat Completions doesn't take it)");
      const rest = { ...m };
      delete rest.reasoning_content;
      return rest;
    }
    return m;
  });
  return { messages, dropped: [...dropped] };
}

/** What a Chat Completions reply adds, read from the kit's collector: its tool calls, or its text. */
export interface ReplyLike {
  text: string;
  toolCalls: Array<{ id: string; callId: string; name: string; arguments: string }>;
}

let callSeq = 0;

/**
 * Appends a reply the way the page's loop does: an assistant turn with the calls and one tool result per call (the
 * page's get_weather answers), or the assistant's answer.
 */
export function appendReply(conv: ConvMessage[], reply: ReplyLike): ConvMessage[] {
  if (reply.toolCalls.length) {
    const toolCalls: ToolCallIn[] = reply.toolCalls.map((t) => {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(t.arguments || "{}") as unknown;
        args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
      } catch {
        args = { raw: t.arguments };
      }
      return { id: t.callId || t.id || `call_${++callSeq}`, name: t.name, arguments: args };
    });
    return [
      ...conv,
      { role: "assistant", toolCalls },
      ...toolCalls.map((t): ConvMessage => ({ role: "tool", toolCallId: t.id, content: t.name === "get_weather" ? pageWeather(t.arguments.city) : "ok" })),
    ];
  }
  if (reply.text) return [...conv, { role: "assistant", content: reply.text }];
  return conv;
}
