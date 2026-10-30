/**
 * The search-and-replace edit contract from the cookbook's search-and-replace-edits recipe, applied in the page: an
 * `edit` names a file, the exact text in it (`oldString`) and its replacement (`newString`), and applies only when the
 * text matches exactly once (or `replaceAll` is set); a `write` creates a whole file. These are OpenCode's tool shapes,
 * which the recipe's payloads use. Pure, so the demo, its tests and the agent demos share one rule.
 */

export type Files = Record<string, string>;

export interface EditCall {
  tool: "edit" | "write";
  filePath: string;
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  content?: string;
}

export type EditProblem = "no_match" | "ambiguous" | "unchanged" | "missing_file" | "bad_arguments";

export interface EditApplied {
  ok: true;
  call: EditCall;
  /** The path as it is in the project (the model may send an absolute one). */
  path: string;
  before: string | null;
  after: string;
  matches: number;
  /** Applied, but worth a look: a whole-file rewrite, a write over an existing file. */
  warnings: string[];
}

export interface EditRejected {
  ok: false;
  call: EditCall;
  path: string;
  problem: EditProblem;
  message: string;
  matches?: number;
}

export type EditResult = EditApplied | EditRejected;

/** Non-overlapping occurrences of `needle`, as a harness counts them before it replaces. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * The project path a tool call means. OpenCode sends absolute paths ("/work/segment_anything/build_sam.py"), so a path
 * that ends with a known file's path is that file; a leading "./" is dropped.
 */
export function resolvePath(files: Files, path: string): string {
  const clean = path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (Object.prototype.hasOwnProperty.call(files, clean)) return clean;
  const bare = clean.replace(/^\/+/, "");
  if (Object.prototype.hasOwnProperty.call(files, bare)) return bare;
  const match = Object.keys(files).find((p) => bare.endsWith(`/${p}`));
  return match ?? bare;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * A tool call the model made, read into an EditCall. Takes OpenCode's names (filePath, oldString, newString,
 * replaceAll, content) and the snake_case ones some models reach for (file_path, old_string, ...).
 */
export function parseEditCall(name: string, argumentsJson: string): EditCall | { error: string } {
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "The arguments aren't a JSON object." };
    args = parsed as Record<string, unknown>;
  } catch {
    return { error: "The arguments aren't valid JSON." };
  }
  const filePath = asString(args.filePath) ?? asString(args.file_path) ?? asString(args.path);
  if (!filePath) return { error: "The call names no filePath." };
  if (name === "write") {
    const content = asString(args.content);
    if (content === undefined) return { error: "write needs content." };
    return { tool: "write", filePath, content };
  }
  if (name === "edit") {
    const oldString = asString(args.oldString) ?? asString(args.old_string);
    const newString = asString(args.newString) ?? asString(args.new_string);
    if (oldString === undefined || newString === undefined) return { error: "edit needs oldString and newString." };
    const replaceAll = args.replaceAll === true || args.replace_all === true;
    return { tool: "edit", filePath, oldString, newString, ...(replaceAll ? { replaceAll } : {}) };
  }
  return { error: `There is no ${name} tool here: use edit or write.` };
}

/** An edit that quotes nearly all of a file re-emits it: it applies, but it's the recipe's "whole-file rewrite". */
function wholeFile(oldString: string, file: string): boolean {
  return file.length > 200 && oldString.length >= file.length * 0.9;
}

/** Applies one call to the files, or says why the harness rejects it. The input isn't changed. */
export function applyEdit(files: Files, call: EditCall): EditResult {
  const path = resolvePath(files, call.filePath);
  const exists = Object.prototype.hasOwnProperty.call(files, path);
  if (call.tool === "write") {
    if (typeof call.content !== "string") return { ok: false, call, path, problem: "bad_arguments", message: "write needs content." };
    return {
      ok: true,
      call,
      path,
      before: exists ? files[path] : null,
      after: call.content,
      matches: 0,
      warnings: exists ? [`write replaced ${path}, which already existed. Use edit for files that exist; write is for new ones.`] : [],
    };
  }
  if (!exists) {
    return { ok: false, call, path, problem: "missing_file", message: `${path} doesn't exist. Use write to create a new file.` };
  }
  const oldString = call.oldString ?? "";
  const newString = call.newString ?? "";
  if (!oldString) return { ok: false, call, path, problem: "bad_arguments", message: "oldString is empty, so there's nothing to find." };
  if (oldString === newString) {
    return { ok: false, call, path, problem: "unchanged", message: "newString is the same as oldString, so the edit would change nothing." };
  }
  const file = files[path];
  const matches = countOccurrences(file, oldString);
  if (matches === 0) {
    return {
      ok: false,
      call,
      path,
      problem: "no_match",
      matches,
      message: `oldString matches 0 times in ${path}. Copy the text exactly as the file has it, spaces and indentation included.`,
    };
  }
  if (matches > 1 && !call.replaceAll) {
    return {
      ok: false,
      call,
      path,
      problem: "ambiguous",
      matches,
      message: `oldString matches ${matches} times in ${path}. Add surrounding lines so it matches once, or set replaceAll to change every one.`,
    };
  }
  const after = call.replaceAll ? file.split(oldString).join(newString) : file.replace(oldString, () => newString);
  const warnings = wholeFile(oldString, file) ? ["This edit quotes nearly the whole file. It applies, but a targeted edit is safer."] : [];
  return { ok: true, call, path, before: file, after, matches, warnings };
}

/** The files after an applied edit. */
export function withEdit(files: Files, result: EditResult): Files {
  return result.ok ? { ...files, [result.path]: result.after } : files;
}

/** The text sent back to the model for one call: what happened, and for a rejection the file as it is now. */
export function editFeedback(result: EditResult, files: Files): string {
  if (result.ok) {
    const warn = result.warnings.length ? ` Note: ${result.warnings.join(" ")}` : "";
    return result.call.tool === "write"
      ? `Wrote ${result.path} (${result.after.split("\n").length} lines).${warn}`
      : `Applied the edit to ${result.path} (${result.matches} match${result.matches === 1 ? "" : "es"} replaced).${warn}`;
  }
  const current = Object.prototype.hasOwnProperty.call(files, result.path) ? `\nThe file as it is now:\n${files[result.path]}` : "";
  return `Rejected: ${result.message}${current}`;
}

// ---------------------------------------------------------------------------------------------------------------
// A light syntax check for Python sources

const BLOCK = /^(?:async\s+def|def|class|if|elif|else|for|while|with|try|except|finally)\b/;

/**
 * A light check of a Python file, run in the page after each edit: unclosed or stray brackets and strings, tabs in
 * indentation, a block line without its colon, and a block with nothing indented under it. It is no substitute for
 * py_compile and flake8 (the recipe's checks), and says so where it's shown.
 */
export function pythonProblems(source: string): string[] {
  const problems: string[] = [];
  const lines = source.split("\n");
  const stack: Array<{ ch: string; line: number }> = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let triple: { quote: string; line: number } | null = null;
  // A logical line runs until its brackets close; its first physical line decides whether it opens a block.
  let logicalStart = -1;
  let logicalText = "";
  let expectIndentAfter: { line: number; indent: number } | null = null;

  const indentOf = (line: string) => /^[ \t]*/.exec(line)![0];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    let code = "";
    let j = 0;
    if (!triple && stack.length === 0) {
      const indent = indentOf(raw);
      if (raw.trim() && indent.includes("\t")) problems.push(`Line ${lineNo} indents with a tab.`);
      if (raw.trim() && !raw.trim().startsWith("#")) {
        if (expectIndentAfter && indent.replace(/\t/g, "    ").length <= expectIndentAfter.indent) {
          problems.push(`Line ${lineNo} should be indented under the block that line ${expectIndentAfter.line} opens.`);
        }
        expectIndentAfter = null;
        logicalStart = lineNo;
        logicalText = "";
      }
    }
    while (j < raw.length) {
      const ch = raw[j];
      if (triple) {
        if (raw.startsWith(triple.quote, j)) {
          triple = null;
          j += 3;
        } else j++;
        continue;
      }
      if (ch === "#") break;
      if (raw.startsWith('"""', j) || raw.startsWith("'''", j)) {
        triple = { quote: raw.slice(j, j + 3), line: lineNo };
        code += "S";
        j += 3;
        continue;
      }
      if (ch === '"' || ch === "'") {
        let k = j + 1;
        while (k < raw.length && raw[k] !== ch) k += raw[k] === "\\" ? 2 : 1;
        if (k >= raw.length) {
          problems.push(`Line ${lineNo} has a string that never closes.`);
          break;
        }
        code += "S";
        j = k + 1;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") stack.push({ ch, line: lineNo });
      else if (ch === ")" || ch === "]" || ch === "}") {
        const top = stack.pop();
        if (!top || top.ch !== pairs[ch]) {
          problems.push(`Line ${lineNo} has a ${ch} with no matching ${pairs[ch]}.`);
          if (top) stack.push(top);
        }
      }
      code += ch;
      j++;
    }
    if (logicalStart > 0) logicalText += ` ${code}`;
    if (!triple && stack.length === 0 && logicalStart > 0 && logicalText.trim()) {
      const text = logicalText.trim();
      if (BLOCK.test(text)) {
        if (!text.endsWith(":")) {
          // A one-line block ("if x: return y") has its colon inside, which is fine.
          if (!/:\s*\S/.test(text)) problems.push(`Line ${logicalStart} starts a block but doesn't end with a colon.`);
        } else {
          expectIndentAfter = { line: logicalStart, indent: indentOf(lines[logicalStart - 1]).replace(/\t/g, "    ").length };
        }
      }
      logicalStart = -1;
      logicalText = "";
    }
  }
  if (triple) problems.push(`The string opened with ${triple.quote} on line ${triple.line} never closes.`);
  for (const open of stack) problems.push(`The ${open.ch} on line ${open.line} never closes.`);
  if (expectIndentAfter) problems.push(`The block that line ${expectIndentAfter.line} opens has nothing in it.`);
  return problems;
}
