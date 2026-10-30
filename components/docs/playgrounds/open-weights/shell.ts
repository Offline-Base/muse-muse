/**
 * Formatting for the commands the builders write: one flag per line with a trailing backslash, as Meta's pages lay
 * them out, and quoting that keeps a path or JSON value one shell word. Pure, so the tests can pin the exact text.
 */

/** Words that need no quotes in a POSIX shell. */
const SAFE = /^[A-Za-z0-9_@%+=:,./~-]+$/;

/** Quotes a value for a POSIX shell when it needs it: single quotes, with any single quote inside spelled '\''. */
export function shq(value: string): string {
  if (value !== "" && SAFE.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Double quotes, for values that should still expand $VARS (paths built from an env var). */
export function dq(value: string): string {
  return `"${value.replace(/(["\\`])/g, "\\$1")}"`;
}

export type Arg = string | false | null | undefined;

/**
 * A command with one argument group per line:
 *
 *   sglang serve \
 *     --model-path meta-models/... \
 *     --tp-size 4
 *
 * Falsy entries are skipped, so a builder can write `on && "--flag"`. With `inline` set, a short command stays on
 * one line.
 */
export function command(head: string, args: Arg[], { indent = "  ", inline = false }: { indent?: string; inline?: boolean } = {}): string {
  const parts = args.filter((a): a is string => typeof a === "string" && a.length > 0);
  if (!parts.length) return head;
  if (inline) return [head, ...parts].join(" ");
  return [head, ...parts.map((p) => `${indent}${p}`)].join(" \\\n");
}

/** Environment lines: `export NAME=value`, one per line. */
export function exports(vars: Record<string, string | number | false | null | undefined>): string {
  return Object.entries(vars)
    .filter((e): e is [string, string | number] => e[1] !== false && e[1] !== null && e[1] !== undefined && e[1] !== "")
    .map(([k, v]) => `export ${k}=${typeof v === "number" ? v : shq(v)}`)
    .join("\n");
}

/** Joins non-empty blocks with a blank line between them. */
export function blocks(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0).join("\n\n");
}

/** A compact JSON value for a single-quoted shell argument, such as --speculative-config. */
export function jsonArg(value: unknown): string {
  return `'${JSON.stringify(value).replace(/'/g, "'\\''")}'`;
}

/** Python literal for a plain JSON value: True, False and None outside strings. Short values stay on one line. */
export function py(value: unknown, indent = 4, level = 0): string {
  const inline = pyInline(value);
  if (inline !== null && inline.length + indent * level <= 88) return inline;
  const pad = " ".repeat(indent * (level + 1));
  const end = " ".repeat(indent * level);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((v) => `${pad}${py(v, indent, level + 1)}`).join(",\n")},\n${end}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return "{}";
    return `{\n${entries.map(([k, v]) => `${pad}${JSON.stringify(k)}: ${py(v, indent, level + 1)}`).join(",\n")},\n${end}}`;
  }
  return pyInline(value) ?? "None";
}

/** The one-line form, or null for values that hold objects inside arrays or objects inside objects deeper than one. */
function pyInline(value: unknown, depth = 0): string | null {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "None";
  if (typeof value === "string") return JSON.stringify(value);
  if (depth > 1) return null;
  if (Array.isArray(value)) {
    const parts = value.map((v) => pyInline(v, depth + 1));
    return parts.some((x) => x === null) ? null : `[${parts.join(", ")}]`;
  }
  const parts = Object.entries(value as Record<string, unknown>).map(([k, v]) => {
    const x = pyInline(v, depth + 1);
    return x === null ? null : `${JSON.stringify(k)}: ${x}`;
  });
  return parts.some((x) => x === null) ? null : `{${parts.join(", ")}}`;
}
