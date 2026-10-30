import { createHighlighterCore, type HighlighterCore, type ShikiTransformer, type ThemeRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/**
 * Syntax highlighting for the docs code blocks: one shiki highlighter per server process, on shiki's JavaScript regex
 * engine (no WebAssembly to ship or trace), loaded with only the languages the mirror uses. Colors are CSS variables
 * (--docs-syn-*, set for light and dark in app/docs/docs.css) so one rendering serves both themes, tuned to the
 * palette of dev.meta.ai's code blocks: navy keys and operators, green strings, brown numbers, gray comments, blue
 * keywords, dark blue function names, violet class names, light gray punctuation in Python and TypeScript (dark in
 * JSON), and plain shell commands.
 */

const v = (name: string) => `var(--docs-syn-${name})`;

const THEME: ThemeRegistration = {
  name: "docs",
  type: "light",
  fg: v("fg"),
  bg: "transparent",
  colors: { "editor.foreground": v("fg"), "editor.background": "transparent" },
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment", "string.quoted.docstring"], settings: { foreground: v("comment") } },
    { scope: ["string", "markup.inline.raw", "markup.fenced_code"], settings: { foreground: v("string") } },
    {
      scope: ["constant.numeric", "constant.language", "constant.character", "constant.other", "support.constant", "variable.language"],
      settings: { foreground: v("number") },
    },
    {
      scope: ["keyword", "storage", "keyword.control", "support.function.builtin", "entity.name.tag", "markup.heading"],
      settings: { foreground: v("keyword") },
    },
    { scope: ["keyword.operator", "punctuation.separator.key-value", "punctuation.definition.template-expression"], settings: { foreground: v("operator") } },
    {
      scope: [
        "support.type.property-name",
        "meta.object-literal.key",
        "entity.name.tag.yaml",
        "variable.other.property",
        "meta.mapping.key",
        "support.type.property-name.toml",
        "entity.other.attribute-name",
      ],
      settings: { foreground: v("property") },
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call.generic", "variable.function"],
      settings: { foreground: v("function") },
    },
    { scope: ["entity.name.type", "entity.name.class", "support.class", "support.type", "entity.other.inherited-class"], settings: { foreground: v("type") } },
    { scope: ["punctuation", "meta.brace", "meta.delimiter"], settings: { foreground: v("punct") } },
    // A string's quotes take the string's color, and a JSON or object key's quotes the key's, as on dev.meta.ai.
    { scope: ["punctuation.definition.string", "string punctuation"], settings: { foreground: v("string") } },
    {
      scope: [
        "support.type.property-name punctuation.definition.string",
        "support.type.property-name punctuation",
        "meta.object-literal.key punctuation.definition.string",
      ],
      settings: { foreground: v("property") },
    },
    // Shell commands and their flags read as plain text on dev.meta.ai; only strings, operators and comments stand out.
    {
      scope: [
        "entity.name.command",
        "support.function.builtin.shell",
        "entity.name.function.call.shell",
        "string.unquoted.argument.shell",
        "constant.other.option",
        "meta.argument.shell",
        "variable.other.normal.shell",
        "variable.other.readwrite.shell",
      ],
      settings: { foreground: v("fg") },
    },
    { scope: ["keyword.operator.pipe.shell", "keyword.operator.logical.shell", "keyword.operator.redirect.shell"], settings: { foreground: v("operator") } },
    // Python, TypeScript and JavaScript punctuation is light gray on dev.meta.ai: brackets, commas, dots and colons.
    // These outrank the generic punctuation rule; string quotes and JSON keep theirs (more specific rules above).
    {
      scope: [
        "source.python punctuation",
        "source.ts punctuation",
        "source.tsx punctuation",
        "source.js punctuation",
        "source.ts meta.brace",
        "source.tsx meta.brace",
        "source.js meta.brace",
        "source.ts punctuation.separator.key-value",
        "source.tsx punctuation.separator.key-value",
        "source.js punctuation.separator.key-value",
      ],
      settings: { foreground: v("punct-code") },
    },
    {
      scope: [
        "source.python string punctuation.definition.string",
        "source.ts string punctuation.definition.string",
        "source.tsx string punctuation.definition.string",
        "source.js string punctuation.definition.string",
        "source.ts punctuation.definition.template-expression",
        "source.tsx punctuation.definition.template-expression",
        "source.js punctuation.definition.template-expression",
      ],
      settings: { foreground: v("string") },
    },
    // PowerShell's grammar reads the slashes in a URL as division; dev.meta.ai shows PowerShell plain.
    { scope: ["source.powershell keyword.operator"], settings: { foreground: v("fg") } },
    { scope: ["markup.inserted", "punctuation.definition.inserted"], settings: { foreground: v("inserted") } },
    { scope: ["markup.deleted", "punctuation.definition.deleted"], settings: { foreground: v("deleted") } },
    { scope: ["meta.diff.header", "meta.diff.range"], settings: { foreground: v("comment") } },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
  ],
};

/** The fence languages the mirror uses, mapped to the grammar that highlights them. Anything else is plain text. */
const GRAMMARS: Record<string, string> = {
  bash: "shellscript",
  shell: "shellscript",
  sh: "shellscript",
  zsh: "shellscript",
  shellscript: "shellscript",
  console: "shellscript",
  powershell: "powershell",
  ps1: "powershell",
  python: "python",
  py: "python",
  typescript: "typescript",
  ts: "typescript",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  jsonl: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  diff: "diff",
  markdown: "markdown",
  md: "markdown",
  jinja: "jinja",
  html: "html",
  css: "css",
  tsx: "tsx",
  sql: "sql",
};

/** Grammars whose capitalized names (OpenAI, BaseModel) dev.meta.ai colors as types, though the grammar leaves them plain. */
const CLASS_NAME_GRAMMARS = new Set(["python", "typescript", "tsx", "javascript"]);
const CLASS_NAME = /^[A-Z][a-z][A-Za-z0-9_]*$/;

/**
 * Colors capitalized identifiers as types: `from openai import OpenAI` and `client = OpenAI(` get the class color, as
 * on dev.meta.ai, where the grammar leaves the first plain and reads the second as a function call. All-caps names
 * (MODEL_API_KEY, JSON) stay as they are. A token can carry the spaces around a name, so the name is split out of it.
 */
export const classNamesAsTypes: ShikiTransformer = {
  name: "docs:class-names",
  tokens(lines) {
    return lines.map((line) =>
      line.flatMap((token) => {
        if (token.color && token.color !== v("fg") && token.color !== v("function")) return [token];
        const m = token.content.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*)$/);
        if (!m || !CLASS_NAME.test(m[2])) return [token];
        const [, before, name, after] = m;
        const parts = [];
        if (before) parts.push({ ...token, content: before });
        parts.push({ ...token, content: name, offset: token.offset + before.length, color: v("type") });
        if (after) parts.push({ ...token, content: after, offset: token.offset + before.length + name.length });
        return parts;
      }),
    );
  },
};

let highlighter: Promise<HighlighterCore> | null = null;

function load(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [THEME],
    langs: [
      import("shiki/langs/shellscript.mjs"),
      import("shiki/langs/powershell.mjs"),
      import("shiki/langs/python.mjs"),
      import("shiki/langs/typescript.mjs"),
      import("shiki/langs/javascript.mjs"),
      import("shiki/langs/json.mjs"),
      import("shiki/langs/jsonc.mjs"),
      import("shiki/langs/json5.mjs"),
      import("shiki/langs/yaml.mjs"),
      import("shiki/langs/toml.mjs"),
      import("shiki/langs/diff.mjs"),
      import("shiki/langs/markdown.mjs"),
      import("shiki/langs/jinja.mjs"),
      import("shiki/langs/html.mjs"),
      import("shiki/langs/css.mjs"),
      import("shiki/langs/tsx.mjs"),
      import("shiki/langs/sql.mjs"),
    ],
    // forgiving: a grammar rule the JavaScript engine can't express is skipped instead of failing the whole page.
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}

/** The grammar for a fence language, or null when the block is shown as plain text. */
export function grammarFor(lang: string): string | null {
  return GRAMMARS[lang.trim().toLowerCase()] ?? null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Plain text in the same markup shiki writes, so plain and highlighted blocks style and copy the same way. */
export function plainCodeHtml(code: string): string {
  const lines = code.split("\n").map((line) => `<span class="line">${escapeHtml(line)}</span>`);
  return `<pre class="shiki docs" tabindex="0"><code>${lines.join("\n")}</code></pre>`;
}

/**
 * Highlighted HTML for one block: `<pre class="shiki docs"><code>` with a span per line. Never throws: a grammar
 * failure falls back to plain text.
 */
export async function highlightCode(code: string, lang: string): Promise<string> {
  const grammar = grammarFor(lang);
  if (!grammar) return plainCodeHtml(code);
  try {
    const hl = await load();
    const transformers = CLASS_NAME_GRAMMARS.has(grammar) ? [classNamesAsTypes] : [];
    return hl.codeToHtml(code, { lang: grammar, theme: "docs", transformers });
  } catch {
    return plainCodeHtml(code);
  }
}
