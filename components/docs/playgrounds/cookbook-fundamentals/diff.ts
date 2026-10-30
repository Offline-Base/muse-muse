/**
 * A small line diff for the agent demos (basic-agent-loop, interleaved reasoning, search-and-replace edits): what the
 * model changed in a file, shown the way the recipes show their diffs (unified format, three lines of context). Files
 * in these demos are a few hundred lines at most, so a plain longest-common-subsequence table is fast enough and
 * gives the minimal diff.
 */

export type DiffOpKind = "eq" | "add" | "del";

export interface DiffOp {
  op: DiffOpKind;
  text: string;
  /** 1-based line in the old text (eq and del). */
  oldLine?: number;
  /** 1-based line in the new text (eq and add). */
  newLine?: number;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  ops: DiffOp[];
}

/** Lines of a file. A trailing newline doesn't make an extra empty line, and an empty file has none. */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Past this many cells the table would be slow, so the diff falls back to "all removed, all added". */
const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffOp[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;
  // Common head and tail first: most edits touch a few lines in the middle.
  let head = 0;
  while (head < n && head < m && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < n - head && tail < m - head && a[n - 1 - tail] === b[m - 1 - tail]) tail++;
  const ops: DiffOp[] = [];
  for (let i = 0; i < head; i++) ops.push({ op: "eq", text: a[i], oldLine: i + 1, newLine: i + 1 });

  const aMid = a.slice(head, n - tail);
  const bMid = b.slice(head, m - tail);
  const rows = aMid.length;
  const cols = bMid.length;
  if (rows && cols && rows * cols <= MAX_CELLS) {
    // lcs[i][j]: length of the LCS of aMid[i..] and bMid[j..].
    const lcs: Uint32Array[] = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = cols - 1; j >= 0; j--) {
        lcs[i][j] = aMid[i] === bMid[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows || j < cols) {
      if (i < rows && j < cols && aMid[i] === bMid[j]) {
        ops.push({ op: "eq", text: aMid[i], oldLine: head + i + 1, newLine: head + j + 1 });
        i++;
        j++;
      } else if (j < cols && (i >= rows || lcs[i][j + 1] >= lcs[i + 1][j])) {
        ops.push({ op: "add", text: bMid[j], newLine: head + j + 1 });
        j++;
      } else {
        ops.push({ op: "del", text: aMid[i], oldLine: head + i + 1 });
        i++;
      }
    }
  } else {
    aMid.forEach((text, i) => ops.push({ op: "del", text, oldLine: head + i + 1 }));
    bMid.forEach((text, j) => ops.push({ op: "add", text, newLine: head + j + 1 }));
  }
  for (let k = 0; k < tail; k++) {
    ops.push({ op: "eq", text: a[n - tail + k], oldLine: n - tail + k + 1, newLine: m - tail + k + 1 });
  }
  // Removals before additions inside each changed run, the way unified diffs read.
  return reorderRuns(ops);
}

function reorderRuns(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  let run: DiffOp[] = [];
  const flush = () => {
    out.push(...run.filter((o) => o.op === "del"), ...run.filter((o) => o.op === "add"));
    run = [];
  };
  for (const o of ops) {
    if (o.op === "eq") {
      flush();
      out.push(o);
    } else run.push(o);
  }
  flush();
  return out;
}

export function diffStats(ops: readonly DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.op === "add") added++;
    else if (o.op === "del") removed++;
  }
  return { added, removed };
}

/** Changed runs with `context` unchanged lines around them; runs closer than twice that merge into one hunk. */
export function toHunks(ops: readonly DiffOp[], context = 3): Hunk[] {
  const changed = ops.map((o, i) => (o.op === "eq" ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return [];
  const ranges: Array<[number, number]> = [];
  for (const i of changed) {
    const start = Math.max(0, i - context);
    const end = Math.min(ops.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  return ranges.map(([start, end]) => {
    const slice = ops.slice(start, end + 1);
    const firstOld = slice.find((o) => o.oldLine !== undefined)?.oldLine;
    const firstNew = slice.find((o) => o.newLine !== undefined)?.newLine;
    const oldLines = slice.filter((o) => o.op !== "add").length;
    const newLines = slice.filter((o) => o.op !== "del").length;
    // An empty side starts at the line before, as diff -u writes it (a new file is @@ -0,0 +1,n @@).
    const prevOld = ops.slice(0, start).filter((o) => o.op !== "add").length;
    const prevNew = ops.slice(0, start).filter((o) => o.op !== "del").length;
    return {
      oldStart: oldLines ? (firstOld ?? prevOld + 1) : prevOld,
      oldLines,
      newStart: newLines ? (firstNew ?? prevNew + 1) : prevNew,
      newLines,
      ops: slice,
    };
  });
}

function range(start: number, lines: number): string {
  return lines === 1 ? `${start}` : `${start},${lines}`;
}

export function hunkHeader(h: Hunk): string {
  return `@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@`;
}

/** A unified diff of one file, or "" when nothing changed. A file that didn't exist before diffs from /dev/null. */
export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3): string {
  const ops = diffLines(before ?? "", after ?? "");
  const hunks = toHunks(ops, context);
  if (!hunks.length) return "";
  const lines = [before === null ? "--- /dev/null" : `--- a/${path}`, after === null ? "+++ /dev/null" : `+++ b/${path}`];
  for (const h of hunks) {
    lines.push(hunkHeader(h));
    for (const o of h.ops) lines.push(`${o.op === "add" ? "+" : o.op === "del" ? "-" : " "}${o.text}`);
  }
  return lines.join("\n");
}
