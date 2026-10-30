/**
 * Parsing the JSON a reader types, with errors that point at a line and column instead of "position 412".
 */

export type JsonParse = { ok: true; value: unknown } | { ok: false; message: string; line?: number; column?: number };

/** Line and column (both from 1) of a character offset. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, offset));
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/**
 * Where JSON text first goes wrong, as a character offset (or -1 when it's fine). V8 gives a position for some
 * errors but not for "Unexpected token", so the editor finds it itself with a small scanner.
 */
export function jsonErrorOffset(text: string): number {
  let i = 0;
  const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const fail = (): never => {
    throw i;
  };
  const string = () => {
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i++;
        return;
      }
      if (c === "\\") i += 2;
      else if (c < " ") fail();
      else i++;
    }
    fail();
  };
  const value = (depth: number): void => {
    if (depth > 500) fail();
    ws();
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      const close = ch === "{" ? "}" : "]";
      i++;
      ws();
      if (text[i] === close) {
        i++;
        return;
      }
      for (;;) {
        if (ch === "{") {
          ws();
          if (text[i] !== '"') fail();
          string();
          ws();
          if (text[i] !== ":") fail();
          i++;
        }
        value(depth + 1);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === close) {
          i++;
          return;
        }
        fail();
      }
    }
    if (ch === '"') return string();
    number.lastIndex = i;
    const m = number.exec(text);
    if (m && m[0]) {
      i += m[0].length;
      return;
    }
    for (const word of ["true", "false", "null"]) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return;
      }
    }
    fail();
  };
  try {
    value(0);
    ws();
    if (i < text.length) fail();
    return -1;
  } catch (at) {
    return typeof at === "number" ? Math.min(at, text.length) : -1;
  }
}

export function parseJsonText(text: string): JsonParse {
  if (!text.trim()) return { ok: false, message: "The body is empty. Type a JSON object." };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // V8 says "... in JSON at position 42" and, in newer versions, "(line 3 column 5)" after it.
    const lc = /line (\d+) column (\d+)/.exec(raw);
    const pos = /position (\d+)/.exec(raw);
    const found = lc || pos ? -1 : jsonErrorOffset(text);
    const where = lc
      ? { line: Number(lc[1]), column: Number(lc[2]) }
      : pos
        ? lineColumn(text, Number(pos[1]))
        : found >= 0
          ? lineColumn(text, found)
          : null;
    const reason = raw
      .replace(/\s*\(line \d+ column \d+\)/, "")
      .replace(/\s*in JSON at position \d+/, "")
      // "Unexpected token '}', ..."input": }" is not valid JSON" keeps only its first part.
      .replace(/^(Unexpected token '.+?'), .*is not valid JSON$/s, "$1")
      .replace(/^JSON\.parse: /, "")
      .trim();
    return where
      ? { ok: false, message: `Line ${where.line}, column ${where.column}: ${reason}`, ...where }
      : { ok: false, message: reason || "This isn't valid JSON." };
  }
}

/** Pretty JSON for an editor: two-space indents, like Meta's examples. */
export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
