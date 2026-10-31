/**
 * The pure parts of how a model's reply reads as Markdown (components/markdown/MarkdownText). A reply is untrusted text
 * that may still be arriving, so nothing here produces markup: these only decide what is safe to link and how to show a
 * half-written reply.
 */

/** Replies longer than this stay plain text: parsing them on every streamed token would stall the tab. */
export const MAX_MARKDOWN_CHARS = 200_000;

/**
 * The URL when a link in a reply may be followed, else null. Only http, https and mailto: a model's "javascript:" or
 * "data:" link stays text, and so does a relative one, which would point into Muse Muse itself.
 */
export function safeHref(href: string | null | undefined): string | null {
  const value = (href ?? "").trim();
  if (!value) return null;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:" ? value : null;
  } catch {
    return null;
  }
}

/** The start of what could be a JSON reply. "[" alone isn't enough: "[a link](url)" starts the same way. */
const JSON_START = /^\s*(\{|\[\s*(\{|\[|"|-?\d|\]))/;

/**
 * The reply as code when it is JSON and nothing else (structured output, tool arguments), pretty-printed, so a schema's
 * underscores and asterisks are never read as emphasis. While it streams, what looks like JSON stays as it arrived.
 */
export function jsonReply(text: string, streaming: boolean): string | null {
  if (!JSON_START.test(text)) return null;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return streaming ? text.trim() : null;
  }
}

/**
 * A streaming reply with its unfinished last block closed, so "**Sum" shows as bold while it arrives instead of as two
 * asterisks that later vanish. An open code fence is left alone: the parser runs it to the end of the text.
 */
export function closePartialMarkdown(text: string): string {
  const fences = text.match(/^ {0,3}(```|~~~)/gm)?.length ?? 0;
  if (fences % 2 === 1) return text;
  const start = text.lastIndexOf("\n\n") + 2;
  const tail = text.slice(start);
  const ticks = tail.match(/`/g)?.length ?? 0;
  if (ticks % 2 === 1) return `${text}\``;
  const bold = tail.replace(/`[^`]*`/g, "").match(/\*\*/g)?.length ?? 0;
  if (bold % 2 === 0) return text;
  // Just the opening marker so far: there's nothing to make bold yet.
  if (/\*\*\s*$/.test(tail)) return text.replace(/\*\*\s*$/, "");
  return `${text}**`;
}
