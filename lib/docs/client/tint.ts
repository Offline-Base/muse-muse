/**
 * Colors for the kit's generated code (CodeView): a small tokenizer for the curl, Python and TypeScript that
 * lib/docs/client/codegen.ts writes, so "Show code" reads like the mirrored blocks beside it, which shiki colors on
 * the server (lib/docs/highlight.ts). Tones map to the same --docs-syn-* variables. It only needs to be right for
 * generated code: strings, comments, numbers, keywords, keys, calls, class names and punctuation.
 */

export type Tone =
  | "string"
  | "number"
  | "keyword"
  | "comment"
  | "property"
  | "function"
  | "type"
  | "operator"
  | "punct";

export interface Tinted {
  text: string;
  tone: Tone | null;
}

export type TintSyntax = "bash" | "python" | "typescript";

const KEYWORDS: Record<TintSyntax, ReadonlySet<string>> = {
  bash: new Set(["export", "if", "then", "fi", "for", "do", "done", "echo"]),
  python: new Set([
    "import", "from", "as", "def", "return", "with", "if", "elif", "else", "for", "in", "while", "try", "except",
    "finally", "raise", "class", "lambda", "await", "async", "not", "and", "or", "is", "print", "pass", "yield",
  ]),
  typescript: new Set([
    "import", "from", "export", "default", "const", "let", "var", "await", "async", "function", "return", "new", "if",
    "else", "for", "of", "in", "while", "try", "catch", "finally", "throw", "typeof", "as", "class", "type", "interface",
  ]),
};

const CONSTANTS: Record<TintSyntax, ReadonlySet<string>> = {
  bash: new Set(),
  python: new Set(["True", "False", "None"]),
  typescript: new Set(["true", "false", "null", "undefined"]),
};

/** Class names, such as OpenAI and Anthropic: capitalized, then lowercase. All-caps names (JSON, MODEL_API_KEY) aren't. */
const CLASS_NAME = /^[A-Z][a-z][A-Za-z0-9_]*$/;

function readString(code: string, at: number, syntax: TintSyntax): number {
  const quote = code[at];
  const triple = syntax === "python" && code.startsWith(quote.repeat(3), at);
  const close = triple ? quote.repeat(3) : quote;
  let i = at + close.length;
  while (i < code.length) {
    // Shell's '\'' closes a single-quoted string, adds a quote and reopens it: one string to the reader.
    if (syntax === "bash" && quote === "'" && code.startsWith("'\\''", i)) {
      i += 4;
      continue;
    }
    if (code.startsWith(close, i)) return i + close.length;
    // Shell single quotes have no escapes; everything else takes a backslash.
    if (code[i] === "\\" && !(syntax === "bash" && quote === "'")) i += 2;
    else i += 1;
  }
  return code.length;
}

/** Splits code into colored runs. Plain text has a null tone. */
export function tintCode(code: string, syntax: TintSyntax): Tinted[] {
  const out: Tinted[] = [];
  const push = (text: string, tone: Tone | null) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.tone === tone) last.text += text;
    else out.push({ text, tone });
  };
  const skipSpaces = (from: number) => {
    let j = from;
    while (j < code.length && (code[j] === " " || code[j] === "\t")) j++;
    return j;
  };
  const nextNonSpace = (from: number) => code[skipSpaces(from)] ?? "";
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const rest = code.slice(i, i + 2);
    // Comments.
    if ((c === "#" && syntax !== "typescript") || (syntax === "typescript" && rest === "//")) {
      const end = code.indexOf("\n", i);
      const stop = end < 0 ? code.length : end;
      push(code.slice(i, stop), "comment");
      i = stop;
      continue;
    }
    // Strings, and a quoted key (a string a colon follows, as in a Python dict) in the key color.
    if (c === '"' || c === "'" || (c === "`" && syntax === "typescript")) {
      const end = readString(code, i, syntax);
      const text = code.slice(i, end);
      push(text, syntax !== "bash" && nextNonSpace(end) === ":" ? "property" : "string");
      i = end;
      continue;
    }
    // Numbers that aren't part of a name.
    const number = /^-?\d[\d_]*(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(code.slice(i, i + 40));
    if (number && !/[\w$]/.test(code[i - 1] ?? "") && (c !== "-" || syntax !== "bash")) {
      push(number[0], syntax === "bash" ? null : "number");
      i += number[0].length;
      continue;
    }
    // Names: keywords, constants, keys, calls and class names.
    const word = /^[A-Za-z_$][\w$]*/.exec(code.slice(i, i + 200));
    if (word) {
      const name = word[0];
      const at = skipSpaces(i + name.length);
      const after = code[at] ?? "";
      const before = code.slice(0, i).trimEnd().slice(-1);
      let tone: Tone | null = null;
      if (syntax === "bash") tone = KEYWORDS.bash.has(name) && (before === "" || before === "\n") ? "keyword" : null;
      else if (KEYWORDS[syntax].has(name)) tone = "keyword";
      else if (CONSTANTS[syntax].has(name)) tone = "number";
      else if (CLASS_NAME.test(name)) tone = "type";
      else if (syntax === "typescript" && after === ":" && code[at + 1] !== ":" && /[{,]/.test(before || "{")) tone = "property";
      else if (after === "(") tone = "function";
      push(name, tone);
      i += name.length;
      continue;
    }
    if (syntax !== "bash" && "()[]{},.:;".includes(c)) {
      push(c, "punct");
      i += 1;
      continue;
    }
    if ("=+-*/<>!|&%?".includes(c) && !(syntax === "bash" && c === "-")) {
      push(c, syntax === "bash" && c !== "|" ? null : "operator");
      i += 1;
      continue;
    }
    push(c, null);
    i += 1;
  }
  return out;
}
