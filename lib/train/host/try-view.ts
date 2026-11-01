/** What the public Try box shows, and its size limits. Types and constants only, so the browser can import it. */
export const TRY_PROMPT_CHARS = 600;
export const TRY_MESSAGES_MAX = 6;

export type TryState = "asleep" | "waking" | "live" | "stopping";

/** What the box shows. Built field by field: no address, ref, token or dollar amount reaches a visitor. */
export interface TryView {
  state: TryState;
  provider: string | null;
  /** Why it can't be woken right now, in words to show, or null. Says nothing about a model already awake. */
  cantWake: string | null;
  duties: { line: string | null; license: string; points: string[] };
}
