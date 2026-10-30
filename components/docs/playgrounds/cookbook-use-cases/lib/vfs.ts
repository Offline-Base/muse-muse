/**
 * A tiny in-memory file tree for the agent demos (a repo the GitHub agent reads, the /testbed a sandboxed fix edits,
 * the app an error screenshot comes from). Paths are relative and use "/", like a checkout. The tools built on it
 * behave like the coding-agent tools the recipes name: read with line numbers, list, glob, grep, an edit that needs
 * its oldString to match exactly once (OpenCode's rule), and a unified diff of what changed.
 */

export type Vfs = Readonly<Record<string, string>>;

export function normalizePath(path: string): string {
  const p = path
    .trim()
    .replace(/^\.?\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
  // /testbed is the sandbox's checkout root, and "." the current directory.
  if (p === "testbed" || p === "." || p === "~") return "";
  return p.replace(/^testbed\//, "").replace(/^\.\//, "");
}

/** The file's text with numbered lines, like `cat -n`, optionally a window of it. Null when there's no such file. */
export function readNumbered(vfs: Vfs, path: string, offset = 1, limit = 400): string | null {
  const text = vfs[normalizePath(path)];
  if (text === undefined) return null;
  const lines = text.split("\n");
  const from = Math.max(1, Math.floor(offset));
  return lines
    .slice(from - 1, from - 1 + limit)
    .map((line, i) => `${String(from + i).padStart(5, " ")}\t${line}`)
    .join("\n");
}

/** The entries directly under `dir` ("" for the root): files, and folders with a trailing slash. */
export function listDir(vfs: Vfs, dir: string): string[] {
  const base = normalizePath(dir);
  const prefix = base ? `${base}/` : "";
  const out = new Set<string>();
  for (const path of Object.keys(vfs)) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    out.add(slash < 0 ? rest : `${rest.slice(0, slash)}/`);
  }
  return [...out].sort();
}

/** Glob to RegExp: ** crosses folders, * and ? stay inside one, {a,b} picks one. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  const g = normalizePath(glob);
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*") {
      if (g[i + 1] === "*") {
        re += g[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += g[i + 2] === "/" ? 2 : 1;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (ch === "{") {
      const end = g.indexOf("}", i);
      if (end < 0) {
        re += "\\{";
        continue;
      }
      re += `(?:${g
        .slice(i + 1, end)
        .split(",")
        .map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
        .join("|")})`;
      i = end;
    } else re += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function globFiles(vfs: Vfs, glob: string): string[] {
  const re = globToRegExp(glob);
  const bare = !glob.includes("/");
  return Object.keys(vfs)
    .filter((p) => re.test(p) || (bare && re.test(p.split("/").pop() ?? "")))
    .sort();
}

/**
 * Lines matching `pattern` (a regular expression, or a plain string when it isn't one) as "path:line:text", at most
 * `max` of them. `include` limits the files by glob, as OpenCode's grep does.
 */
export function grepFiles(vfs: Vfs, pattern: string, opts: { include?: string; max?: number; ignoreCase?: boolean } = {}): string[] {
  let re: RegExp;
  try {
    re = new RegExp(pattern, opts.ignoreCase ? "i" : "");
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), opts.ignoreCase ? "i" : "");
  }
  const files = opts.include ? globFiles(vfs, opts.include) : Object.keys(vfs).sort();
  const out: string[] = [];
  for (const path of files) {
    const lines = vfs[path].split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        out.push(`${path}:${i + 1}:${lines[i]}`);
        if (out.length >= (opts.max ?? 50)) return out;
      }
    }
  }
  return out;
}

export type EditResult = { ok: true; content: string } | { ok: false; error: string };

/** Replaces oldString with newString, but only when oldString appears exactly once (or replaceAll is set). */
export function exactEdit(content: string, oldString: string, newString: string, replaceAll = false): EditResult {
  if (!oldString) return { ok: false, error: "oldString is empty. To create a file, use write instead." };
  if (oldString === newString) return { ok: false, error: "oldString and newString are the same." };
  const count = content.split(oldString).length - 1;
  if (count === 0) return { ok: false, error: "oldString not found in the file. Read the file first and copy the exact text." };
  if (count > 1 && !replaceAll) {
    return { ok: false, error: `oldString was found ${count} times. Include more surrounding lines so it matches exactly once.` };
  }
  return { ok: true, content: replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, () => newString) };
}

type Op = { kind: " " | "-" | "+"; line: string };

/** Line operations from an LCS table; the files here are small, so O(n*m) is fine. */
function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ kind: "-", line: a[i++] });
    else ops.push({ kind: "+", line: b[j++] });
  }
  while (i < n) ops.push({ kind: "-", line: a[i++] });
  while (j < m) ops.push({ kind: "+", line: b[j++] });
  return ops;
}

/** A unified diff of one file ("" when nothing changed), with `context` lines around each change. */
export function unifiedDiff(path: string, before: string | undefined, after: string | undefined, context = 3): string {
  if (before === after) return "";
  const a = before === undefined ? [] : before.split("\n");
  const b = after === undefined ? [] : after.split("\n");
  const ops = diffOps(a, b);
  const changed = ops.map((o, idx) => (o.kind !== " " ? idx : -1)).filter((x) => x >= 0);
  if (!changed.length) return "";
  const hunks: Array<[number, number]> = [];
  for (const idx of changed) {
    const start = Math.max(0, idx - context);
    const end = Math.min(ops.length - 1, idx + context);
    const last = hunks[hunks.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else hunks.push([start, end]);
  }
  const lines = [`--- ${before === undefined ? "/dev/null" : `a/${path}`}`, `+++ ${after === undefined ? "/dev/null" : `b/${path}`}`];
  for (const [start, end] of hunks) {
    let aLine = 1;
    let bLine = 1;
    for (let k = 0; k < start; k++) {
      if (ops[k].kind !== "+") aLine++;
      if (ops[k].kind !== "-") bLine++;
    }
    const slice = ops.slice(start, end + 1);
    const aCount = slice.filter((o) => o.kind !== "+").length;
    const bCount = slice.filter((o) => o.kind !== "-").length;
    lines.push(`@@ -${aCount ? aLine : aLine - 1},${aCount} +${bCount ? bLine : bLine - 1},${bCount} @@`);
    for (const o of slice) lines.push(`${o.kind}${o.line}`);
  }
  return lines.join("\n");
}

/** Every file that differs between two trees, as one patch. */
export function treeDiff(before: Vfs, after: Vfs): string {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return paths
    .map((p) => unifiedDiff(p, before[p], after[p]))
    .filter(Boolean)
    .join("\n");
}

/** Lines added and removed in a patch, for a "+3 -1" badge. */
export function diffStats(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}
