/**
 * The pure parts of voice input (components/voice): which text fields offer it, and where dictated words go. Saying
 * something sends it to Meta, so a field that holds a secret or an exact value never offers it.
 */

/** Longest take, Muse Muse's limit for one transcribe request from the browser (MAX_TRANSCRIBE_SECONDS). */
export const DICTATION_MAX_SECONDS = 120;

const NOT_SPEECH_TYPES = new Set(["password", "email", "url", "number", "tel", "date", "time", "datetime-local", "month", "week", "color", "range", "file", "hidden", "checkbox", "radio", "button", "submit", "reset", "image"]);

/** Names and labels of fields that hold secrets or exact values: speaking these is unsafe, or would only garble them. */
const NOT_SPEECH_NAME =
  /pass(word|code|phrase)?\b|secret|token|api[\s_-]?key|\bkey\b|access[\s_-]?code|\botp\b|one[\s_-]?time|\bcard\b|\bcvc\b|\bcvv\b|\bssn\b|e-?mail|\burl\b|webhook|\bids?\b|_id\b|\bjson\b|\bschema\b|\bregex\b|\bcron\b|\bsize\b|\bzip\b|\bpostal\b|\bamount\b|tracking|\bcode\b/i;

const NOT_SPEECH_AUTOCOMPLETE = /password|one-time-code|email|cc-|tel|url|username|postal-code/i;

export interface FieldFacts {
  tag: string;
  type: string;
  /** name, id, aria-label, its label's text and its placeholder, joined. */
  names: string;
  autocomplete: string;
  className: string;
  readOnly: boolean;
  disabled: boolean;
  /** spellcheck="false": the page says this isn't prose. */
  noSpellcheck: boolean;
  /** data-voice: "off" refuses, "inline" means the field has its own button. */
  voice: string | null;
  /** A placeholder or value that starts like code or data. */
  looksLikeData: boolean;
  width: number;
}

/** Whether the shared mic should appear on this field. */
export function offersVoice(field: FieldFacts): boolean {
  if (field.voice === "off" || field.voice === "inline") return false;
  if (field.tag !== "textarea" && field.tag !== "input") return false;
  if (field.tag === "input" && NOT_SPEECH_TYPES.has(field.type)) return false;
  if (field.readOnly || field.disabled || field.looksLikeData) return false;
  // Search boxes turn spellcheck off for typing comfort, not because they hold code.
  if (field.noSpellcheck && field.type !== "search") return false;
  if (field.width < 140) return false;
  if (/\bpg-code-input\b/.test(field.className)) return false;
  if (NOT_SPEECH_AUTOCOMPLETE.test(field.autocomplete)) return false;
  return !NOT_SPEECH_NAME.test(field.names);
}

/** True for text that starts like code or data: JSON, a URL, a shell command, a data URL. */
export function looksLikeData(text: string): boolean {
  return /^\s*([{[<]|https?:|data:|\$ |curl\b)/i.test(text);
}

/**
 * The field's new text with dictated words in place of the selection, with a space on whichever side needs one, and
 * the caret after them. Cut to the field's maxLength, if it has one.
 */
export function insertDictation(value: string, start: number, end: number, words: string, maxLength = -1): { value: string; caret: number } {
  const text = words.trim();
  if (!text) return { value, caret: end };
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const tail = after && !/^[\s.,;:!?)]/.test(after) ? " " : "";
  const room = maxLength >= 0 ? Math.max(0, maxLength - before.length - after.length - lead.length - tail.length) : text.length;
  const fitted = text.slice(0, room);
  if (!fitted) return { value, caret: end };
  const caret = before.length + lead.length + fitted.length;
  return { value: `${before}${lead}${fitted}${tail}${after}`, caret };
}

/** A transcript tidied for a text box: a take cut off mid-sentence can end in "..", which reads as a typo. */
export function tidyTranscript(text: string): string {
  return text.trim().replace(/(^|[^.])\.\.$/, "$1.");
}

/** What the reader sees when a take goes wrong. */
export function dictationError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Allow the microphone for this site to use voice input.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found.";
  if (name === "NotReadableError") return "Another app is using the microphone.";
  return err instanceof Error && err.message ? err.message : "Voice input didn't work. Try again.";
}
