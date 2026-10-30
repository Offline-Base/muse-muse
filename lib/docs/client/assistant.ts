/**
 * The pure parts of the docs assistant (components/docs/chat): its tool names, what each step reads as in the chat, what
 * it must leave to the reader, and the history a new question carries. Shared with the route (lib/docs/proxy/assistant).
 */

export const ASSISTANT_TOOL_NAMES = ["search_docs", "read_page", "open_page", "open_demo", "read_demo", "set_demo_field", "run_demo", "open_build"] as const;

export type AssistantToolName = (typeof ASSISTANT_TOOL_NAMES)[number];

/** Rounds of tool calls one question may take, here and on the server. */
export const ASSISTANT_MAX_TOOL_CALLS = 12;
/** Finished messages sent with a new question. Tool calls from earlier questions are dropped: their answers remain. */
export const ASSISTANT_HISTORY = 12;
/** A longest result handed back to the model for one tool. */
export const TOOL_RESULT_CHARS = 8_000;
export const ASSISTANT_MAX_CHARS = 2_000;

/** Buttons a person has to press: approvals of what an agent wants to do, and anything that deletes or sends. */
const READER_ONLY = /\b(allow|approve|acknowledge|accept|grant|confirm|delete|remove|deny|reject|upload|record|choose|sign in|pay|buy|send to)\b/i;

/** The reason the assistant can't press this button itself, or null when it may. */
export function readerOnlyReason(label: string): string | null {
  return READER_ONLY.test(label) ? `"${label}" is for the reader to press, so tell them it's waiting for them.` : null;
}

/** The best match for a label a model gave: exact first, then the start of one, ignoring case and a leading "1) ". */
export function matchLabel<T extends string>(labels: readonly T[], wanted: string): T | null {
  const norm = (s: string) => s.toLowerCase().replace(/^\d+\)\s*/, "").replace(/\s+/g, " ").trim();
  const want = norm(wanted);
  if (!want) return null;
  return labels.find((l) => norm(l) === want) ?? labels.find((l) => norm(l).startsWith(want)) ?? labels.find((l) => norm(l).includes(want)) ?? null;
}

/** Text cut to fit a tool result, and saying so. */
export function clipResult(text: string, max: number = TOOL_RESULT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n... (cut, ${(text.length - max).toLocaleString("en-US")} more characters)`;
}

/** No em dashes in what Muse Muse shows, even when a model writes them despite being asked not to. */
export function noEmDashes(text: string): string {
  return text.replace(/\s*\u2014\s*/g, ", ");
}

/** A tool call's arguments, or an empty object when the model sent something that isn't a JSON object. */
export function parseToolArgs(args: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(args || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, typeof v === "string" ? v : String(v)]));
  } catch {
    return {};
  }
}

/** What a step reads as in the chat, while it runs and after. */
export function toolLabel(name: string, args: Record<string, string>, running: boolean): string {
  const q = (text: string | undefined) => (text ? `"${text.length > 48 ? `${text.slice(0, 48)}...` : text}"` : "");
  switch (name) {
    case "search_docs":
      return `${running ? "Searching" : "Searched"} the docs for ${q(args.query)}`;
    case "read_page":
      return `${running ? "Reading" : "Read"} ${args.slug ?? "a page"}`;
    case "open_page":
      return `${running ? "Opening" : "Opened"} ${args.slug ?? "a page"}${args.section ? `, ${args.section}` : ""}`;
    case "open_demo":
      return running ? "Opening the live demo" : "Opened the live demo";
    case "read_demo":
      return running ? "Looking at the demo" : "Looked at the demo";
    case "set_demo_field":
      return `${running ? "Setting" : "Set"} ${args.label ?? "a field"} to ${q(args.value)}`;
    case "run_demo":
      return running ? `Running the demo${args.button ? `: ${args.button}` : ""}` : `Ran the demo${args.button ? `: ${args.button}` : ""}`;
    case "open_build":
      return running ? "Opening the build box" : "Opened the build box for you to send";
    default:
      return name;
  }
}

export type ChatPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; label: string; state: "running" | "done" | "failed"; detail?: string };

export interface ChatMessage {
  role: "user" | "assistant";
  parts: ChatPart[];
}

/** The earlier conversation as a new question sends it: finished text only, the newest messages, starting with the reader. */
export function historyItems(messages: readonly ChatMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  const items = messages
    .map((m) => ({
      role: m.role,
      content: m.parts
        .flatMap((p) => (p.kind === "text" ? [p.text] : []))
        .join("\n\n")
        .trim()
        .slice(0, 4_000),
    }))
    .filter((m) => m.content)
    .slice(-ASSISTANT_HISTORY);
  while (items.length && items[0].role !== "user") items.shift();
  return items;
}

/** Questions to start with, fit to whether the page has a demo. */
export function chatStarters(hasPage: boolean): string[] {
  return [
    ...(hasPage ? ["What can I do with this page?", "Run this page's demo and tell me what happened"] : []),
    "Find the page about streaming and open it",
    "Help me build something with this",
  ];
}
