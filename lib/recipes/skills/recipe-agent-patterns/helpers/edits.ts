/**
 * Exact-once edits (recipe-agent-patterns, 02/04): an `edit` names a file, the exact text in it (`oldString`) and its
 * replacement (`newString`), and applies only when the text matches exactly once (or `replaceAll` is set); a `write`
 * creates a new file. Pure and import-free: copy it to lib/agent/edits.ts and use it in the browser or a route.
 * Every rejection goes back to the model as the tool's output with the file as it is now, so it can retry.
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

/**
 * A JavaScript syntax check after an applied edit, without running the code: the source is compiled as a function
 * body (CommonJS style), which throws a SyntaxError for a broken edit. Null when it parses. Browser and Node both.
 */
export function jsSyntaxProblem(source: string): string | null {
  try {
    new Function("module", "exports", "require", source);
    return null;
  } catch (err) {
    return err instanceof SyntaxError ? `SyntaxError: ${err.message}` : null;
  }
}
