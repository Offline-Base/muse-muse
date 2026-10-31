import type { ChatPart } from "@/lib/docs/client/assistant";

/**
 * How the docs assistant's messages show in the Muse app look (docs/UI_MUSE_APP.md, "Where it applies", "Docs sidebar
 * chat"). Pure, so the sidebar (components/docs/chat/Message) only draws what these decide.
 */

export type ToolPart = Extract<ChatPart, { kind: "tool" }>;

export interface ReplyView {
  /** The steps folded behind "Show thinking": every one once the reply is done with words, none before that. */
  folded: ToolPart[];
  /**
   * What shows, in order: while the reply runs, every part as it comes; once done, what it made and its answer. A reply
   * that ended before a word, such as one stopped mid-step, shows every part, so the reader sees where it ended.
   */
  shown: ChatPart[];
  /** Running and waiting on the model, not on a step or on its words: a "Thinking..." step shows last. */
  waiting: boolean;
}

export function replyView(parts: readonly ChatPart[], live: boolean): ReplyView {
  if (!live) {
    if (!parts.some((p) => p.kind === "text")) return { folded: [], shown: [...parts], waiting: false };
    return {
      folded: parts.filter((p): p is ToolPart => p.kind === "tool"),
      shown: parts.filter((p) => p.kind !== "tool"),
      waiting: false,
    };
  }
  // A demo's pictures can arrive while its step still runs, so the last part alone doesn't say the step is over.
  const stepRunning = parts.some((p) => p.kind === "tool" && p.state === "running");
  return { folded: [], shown: [...parts], waiting: !stepRunning && parts[parts.length - 1]?.kind !== "text" };
}

/** A message the reader sent: its words, and any pictures in it, which show as the bubble's thumbnails. */
export function userView(parts: readonly ChatPart[]): { text: string; images: string[] } {
  return {
    text: parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])).join("\n\n"),
    images: parts.flatMap((p) => (p.kind === "images" ? p.srcs : [])),
  };
}
