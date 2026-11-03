/**
 * What a run tells the page, one JSON object per line of the route's reply. The step and source shapes follow the
 * platform's chat kit, so a run reads the same way there and here. Safe in the browser: no server code in this file.
 */

export type AgentStepState = "running" | "done" | "failed" | "waiting";

export interface AgentStep {
  id: string;
  title: string;
  /** A second line: what it looked for, or what went wrong. */
  description?: string;
  state: AgentStepState;
  kind?: "search" | "tool" | "step";
}

export interface AgentSource {
  id: string;
  title: string;
  href: string;
  /** The site's name, for the second line. */
  detail: string;
  /** A short passage from the page. Never its full text. */
  snippet?: string;
  date?: string;
  kind: "web";
  /** True when the answer cites it. False when the model only read it. */
  cited: boolean;
}

export interface AgentConfirm {
  approvalId: string;
  title: string;
  lines: string[];
}

export interface AgentConnect {
  toolkit: string;
  label: string;
  canConnect: boolean;
}

export type AgentStatus = "completed" | "waiting" | "stopped" | "failed";

export type AgentReason =
  | "stopped"
  | "time"
  | "turns"
  | "limit"
  | "cost"
  | "busy"
  | "budget"
  | "length"
  | "no_answer"
  | "error"
  | "confirm"
  | "connect";

export type AgentEvent =
  | { type: "step"; step: AgentStep }
  /** A step that turned out not to matter, like a search over the turn's limit that Meta dropped. */
  | { type: "step_gone"; id: string }
  | { type: "source"; source: AgentSource }
  /** Answer text as it arrives. A new `turn` starts the text over: only the last turn's words are the answer. */
  | { type: "text"; delta: string; turn: number }
  | { type: "confirm"; confirm: AgentConfirm }
  | { type: "connect"; connect: AgentConnect }
  /** A running estimate from the usage so far. Always show it as an estimate. */
  | { type: "cost"; costUsd: number; estimate: true }
  /** What the gateway changed in a request, for logs. Not for the screen. */
  | { type: "note"; message: string }
  /** Where to pick up from if the connection drops or the person presses Stop. */
  | { type: "checkpoint"; resume: string }
  | { type: "error"; code: string; message: string }
  | {
      type: "done";
      status: AgentStatus;
      reason?: AgentReason;
      /** The answer: submit_answer's fields when the run has an output schema, else the text. */
      answer?: unknown;
      text: string;
      costUsd: number;
      /** Send it back with the same route to go on. Present unless the run finished. */
      resume?: string;
      message?: string;
    };

/** What a page draws from a run. `reduceAgent` builds it from the events. */
export interface AgentView<T = unknown> {
  status: "idle" | "running" | AgentStatus;
  reason: AgentReason | null;
  steps: AgentStep[];
  sources: AgentSource[];
  text: string;
  turn: number;
  answer: T | null;
  confirm: AgentConfirm | null;
  connect: AgentConnect | null;
  costUsd: number;
  message: string | null;
  resume: string | null;
}

export const IDLE_VIEW: AgentView<never> = {
  status: "idle",
  reason: null,
  steps: [],
  sources: [],
  text: "",
  turn: -1,
  answer: null,
  confirm: null,
  connect: null,
  costUsd: 0,
  message: null,
  resume: null,
};

function upsert<V extends { id: string }>(list: readonly V[], item: V): V[] {
  const at = list.findIndex((x) => x.id === item.id);
  if (at < 0) return [...list, item];
  const next = list.slice();
  next[at] = item;
  return next;
}

/** One event onto the view. Pure, so the hook, a test and a server-side collector all agree on what a run did. */
export function reduceAgent<T>(view: AgentView<T>, event: AgentEvent): AgentView<T> {
  switch (event.type) {
    case "step":
      return { ...view, steps: upsert(view.steps, event.step) };
    case "step_gone":
      return { ...view, steps: view.steps.filter((s) => s.id !== event.id) };
    case "source":
      return { ...view, sources: upsert(view.sources, event.source) };
    case "text":
      return event.turn === view.turn ? { ...view, text: view.text + event.delta } : { ...view, turn: event.turn, text: event.delta };
    case "confirm":
      return { ...view, confirm: event.confirm };
    case "connect":
      return { ...view, connect: event.connect };
    case "cost":
      return { ...view, costUsd: event.costUsd };
    case "checkpoint":
      return { ...view, resume: event.resume };
    case "error":
      return { ...view, message: event.message };
    case "done":
      return {
        ...view,
        // A step cut short was done over under a new id if the run finished, and it's waiting if the run didn't.
        steps:
          event.status === "completed"
            ? view.steps.filter((s) => s.state !== "running" && s.state !== "waiting")
            : view.steps.map((s) => (s.state === "running" ? { ...s, state: "waiting" as const } : s)),
        status: event.status,
        reason: event.reason ?? null,
        answer: event.status === "completed" ? ((event.answer ?? null) as T | null) : view.answer,
        text: event.text,
        costUsd: event.costUsd,
        resume: event.resume ?? null,
        message: event.message ?? view.message,
        confirm: event.status === "waiting" ? view.confirm : null,
        // "Only the owner can connect this" still explains the answer once the run is over.
        connect: event.status === "waiting" || view.connect?.canConnect === false ? view.connect : null,
      };
    default:
      return view;
  }
}

/** What to tell the person when a run ends without its answer. */
export function stopMessage(reason: AgentReason | null): string {
  switch (reason) {
    case "stopped":
      return "Stopped. You can keep going from here.";
    case "time":
      return "This is taking a while, so it paused. You can keep going.";
    case "turns":
    case "limit":
    case "cost":
      return "This run reached its limit. You can keep going, or try a narrower question.";
    case "length":
      return "The answer got too long and was cut off. You can keep going.";
    case "busy":
      return "Too many people are using this right now. Try again in a minute.";
    case "budget":
      return "This app has used up its budget for today. Try again tomorrow.";
    case "no_answer":
      return "This run didn't come up with an answer. Try rewording your question.";
    case "confirm":
      return "This needs your OK before it goes on.";
    case "connect":
      return "This needs an account connected before it goes on.";
    default:
      return "Something went wrong. Try again in a minute.";
  }
}

// ---------- Tool names never reach the screen ----------

/** Names the kit gives its own tools, with the words a person sees instead. */
const KIT_TOOL_LABELS: Record<string, string> = {
  submit_answer: "the answer",
  web_search: "web search",
  tool_search: "picking a tool",
  read_page: "reading a page",
};

/** A connected app's tool id, like GMAIL_SEND_EMAIL. */
const SHOUTED_TOOL = "[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+";

/**
 * Plain words for a tool's name: "the answer" for submit_answer, "Gmail send email" for GMAIL_SEND_EMAIL, "look up
 * stock" for look_up_stock. Never the raw id.
 */
export function toolLabel(name: string): string {
  const known = KIT_TOOL_LABELS[name];
  if (known) return known;
  const words = name.split(/[_.\s]+/).filter(Boolean);
  if (!words.length) return "a tool";
  if (/^[A-Z0-9_]+$/.test(name)) {
    const [app, ...rest] = words.map((w) => w.toLowerCase());
    return [app.charAt(0).toUpperCase() + app.slice(1), ...rest].join(" ");
  }
  return words.join(" ").toLowerCase();
}

/**
 * Text for the screen with tool ids swapped for plain words (toolLabel): the kit's own, any in `names` (a product's own
 * tools), and any connected app's GMAIL_SEND_EMAIL. Code blocks are left as they are. Text that is nothing but a tool
 * id, like a model writing "submit_answer" instead of calling it, comes back empty: it isn't words for a person.
 */
export function withoutToolNames(text: string, names: readonly string[] = []): string {
  if (!text) return text;
  // A product's own tool counts when its name reads as an id (look_up_stock), not as a word a sentence might use.
  const own = [...new Set([...Object.keys(KIT_TOOL_LABELS), ...names.filter((n) => /^[\w.-]+$/.test(n) && /[_.]/.test(n))])];
  const lone = new RegExp(`^[\\s\`"'*(]*(?:${[...own.map(escapeRe), SHOUTED_TOOL].join("|")})(?:\\s*\\([\\s\\S]*\\))?[\\s\`"'*).]*$`);
  if (lone.test(text)) return "";
  const named = own.length ? new RegExp(`\`?\\b(?:${own.map(escapeRe).join("|")})\\b\`?`, "g") : null;
  return text
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      let out = named ? part.replace(named, (m) => toolLabel(m.replace(/`/g, ""))) : part;
      out = out.replace(new RegExp(`\`?\\b${SHOUTED_TOOL}\\b\`?`, "g"), (m) => toolLabel(m.replace(/`/g, "")));
      return out;
    })
    .join("");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
