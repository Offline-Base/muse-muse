/**
 * Reading the "STRICT JSON only" replies the cookbook recipes ask for. Models sometimes wrap the object in markdown
 * fences or add a line of prose anyway; the alert-fatigue recipe's recovery is to strip the fences, then take the
 * first balanced {...}. This does exactly that and says which recovery it needed, so a demo can show it.
 */

export type StrictJson =
  | { ok: true; value: unknown; recovered: null | "fences" | "balanced" }
  | { ok: false; error: string };

/** The text inside the first ```json ... ``` (or bare ```) fence, or null when there is none. */
export function fencedBody(text: string): string | null {
  const m = /```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)```/.exec(text);
  return m ? m[1].trim() : null;
}

/**
 * The first balanced JSON object in `text`, read with string awareness so braces inside strings don't count.
 * Returns the substring, or null when no object closes.
 */
export function firstBalancedObject(text: string, open = "{", close = "}"): string | null {
  const start = text.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Parses a reply that should be one JSON object, recovering from fences and surrounding prose. */
export function parseStrictJson(text: string): StrictJson {
  const raw = text.trim();
  if (!raw) return { ok: false, error: "The reply was empty." };
  try {
    return { ok: true, value: JSON.parse(raw), recovered: null };
  } catch {
    // Recover below.
  }
  const fenced = fencedBody(raw);
  if (fenced) {
    try {
      return { ok: true, value: JSON.parse(fenced), recovered: "fences" };
    } catch {
      // Fall through to the balanced scan.
    }
  }
  const balanced = firstBalancedObject(raw);
  if (balanced) {
    try {
      return { ok: true, value: JSON.parse(balanced), recovered: "balanced" };
    } catch (err) {
      return { ok: false, error: `The first {...} isn't valid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { ok: false, error: "No JSON object found in the reply (unbalanced braces)." };
}

/** A plain object, or null. */
export function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
