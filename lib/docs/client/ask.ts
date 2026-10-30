/**
 * Helpers for "Ask about this page": starter questions that fit the page, and the short history each question
 * carries to /api/docs/ask (the proxy grounds the answer in the page's Markdown, so old turns add little).
 */

export interface AskMessage {
  role: "user" | "assistant";
  content: string;
}

/** Questions sent with each ask: the newest few turns. */
export const ASK_HISTORY = 6;
/** Longest question the panel sends. */
export const ASK_MAX_CHARS = 2000;

/** "Tool calling" from "tool-calling", for pages the context doesn't name. */
export function titleFromSlug(slug: string): string {
  const last = slug.split("/").filter(Boolean).pop() ?? "this page";
  const words = last.replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "This page";
}

/** API reference groups whose own page is an overview of their endpoints (api-reference/responses, ...). */
const REFERENCE_GROUPS = new Set(["chat-completions", "files", "images", "messages", "models", "responses", "voice"]);

/**
 * Three questions a reader might start with, shaped by the kind of page. The title goes in quotes because Meta's
 * titles are as often imperatives ("Build with Muse Code", "Get the model") as topics, and quoted, both read fine.
 */
export function starterQuestions(title: string, slug: string): string[] {
  const name = `"${(title.trim() || titleFromSlug(slug)).replace(/"/g, "'")}"`;
  const parts = slug.split("/");
  if (slug.startsWith("api-reference/") && parts.at(-1) === "schemas") {
    return [
      `Which fields does the main object in ${name} have?`,
      "Which of these schemas does a request use, and which come back in the reply?",
      "Which fields are required, and what are the defaults?",
    ];
  }
  if (slug === "api-reference" || (parts[0] === "api-reference" && parts.length === 2 && REFERENCE_GROUPS.has(parts[1]))) {
    return [`Which endpoints does ${name} cover?`, "Which endpoint should I call first?", "How do these endpoints authenticate, and what do they return on errors?"];
  }
  if (slug === "cookbook") {
    return ["Which recipe should I start with?", "Which recipes use Muse Image, SAM or Muse Voice Transcribe?", "Which recipes run on open-weight models I host myself?"];
  }
  if (slug === "muse-code/changelog") {
    return ["What changed in the latest release?", "Which releases changed a default or something I have to update?", "Summarize the last three releases."];
  }
  if (slug === "open-weight-models" || /^(muse-glimmer|muse-spark-open)(\/|$)/.test(slug)) {
    return ["What hardware does this need?", `What's the quickest way to run ${name} on my own machine?`, `Which settings in ${name} matter most?`];
  }
  if (slug.startsWith("api-reference")) {
    return [
      `What does a request to ${name} need?`,
      `What does the response from ${name} look like, field by field?`,
      `Which errors can ${name} return, and how do I handle them?`,
    ];
  }
  if (slug.startsWith("cookbook")) {
    return [`What does the ${name} recipe build?`, `What do I need before I start ${name}?`, `How would I adapt ${name} to my own app?`];
  }
  if (slug.startsWith("muse-code") || slug === "coding-agents" || slug === "agent-frameworks") {
    return [`Summarize ${name} in three bullet points.`, `What's the quickest way to try ${name}?`, `Which settings or limits in ${name} should I know about?`];
  }
  return [`Summarize ${name} in three bullet points.`, `Show me the smallest working request for ${name}.`, `What limits or gotchas does ${name} mention?`];
}

/** The newest `max` messages, starting with a user turn so the history reads as question and answer pairs. */
export function trimHistory(messages: readonly AskMessage[], max = ASK_HISTORY): AskMessage[] {
  const recent = messages.slice(-max);
  const firstUser = recent.findIndex((m) => m.role === "user");
  return firstUser < 0 ? [] : recent.slice(firstUser).map((m) => ({ role: m.role, content: m.content.slice(0, ASK_MAX_CHARS * 2) }));
}
