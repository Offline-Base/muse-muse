/**
 * The server's side of a dropped folder (TUNE_FOLDER): the rules again, a scan for secrets and personal data, rows put in
 * the right format, and the rest made into what the writer reads. Server only. Findings are counted, never quoted, so
 * nothing found can reach a log or the review. The scan catches the obvious, not everything: the notice before upload is
 * what tells the person that personal or sensitive information isn't allowed.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/tools/sign";
import { FOLDER_GROUNDING, FOLDER_FENCE } from "@/lib/train/models";
import { piiCounts } from "@/lib/train/public/content";
import { dedupePrompts } from "@/lib/train/logic";
import { parseExamples } from "@/lib/train/tune/examples";
import { classifyFile, FOLDER_LIMITS, FOLDER_ROWS_MIN, looksBinary, normalPath, type FolderDraft, type FolderReview, type SkippedFile, type SkipReason } from "@/lib/train/tune/folder";

/** Keys, tokens and passwords as they usually look. Every run of characters is bounded, so a long line costs little. */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,255}\b/,
  /\bsk-[A-Za-z0-9_-]{16,255}\b/,
  /\b[sr]k_live_[A-Za-z0-9]{10,255}\b/,
  /\bhf_[A-Za-z0-9]{20,255}\b/,
  /\bAIza[0-9A-Za-z_-]{30,60}\b/,
  /\beyJ[A-Za-z0-9_-]{8,2000}\.eyJ[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{4,2000}/,
  /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@]{1,100}:[^\s/@]{1,200}@/i,
  /(?:api[_-]?key|apikey|secret|token|passwd|password|pwd|auth)["']?\s{0,4}[:=]\s{0,4}["']?[^\s"',;]{8,200}/i,
];

export function hasSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

function hasPersonal(text: string): boolean {
  return Object.keys(piiCounts(text)).length > 0;
}

const risky = (text: string) => hasSecret(text) || hasPersonal(text);

/** The text without the lines that look like a secret or personal data, and how many went. */
export function withoutRiskyLines(text: string): { text: string; removed: number } {
  let removed = 0;
  const kept = text.split(/\r\n?|\n/).filter((line) => {
    if (!risky(line)) return true;
    removed++;
    return false;
  });
  return { text: kept.join("\n"), removed };
}

/** Rows from a data file's text, or none when it doesn't read as rows. */
function rowsOf(path: string, text: string): Array<{ prompt: string; answer: string }> {
  try {
    return parseExamples(text, path, Number.MAX_SAFE_INTEGER).rows;
  } catch {
    return [];
  }
}

const rowRisky = (r: { prompt: string; answer: string }) => risky(r.prompt) || risky(r.answer);

/** Rows that fit `max` and the draft's size, one per prompt. The rest are counted. */
function fitRows(rows: Array<{ prompt: string; answer: string }>, max: number): { rows: Array<{ prompt: string; answer: string }>; cut: number } {
  const byPrompt = new Map(rows.map((r) => [r.prompt, r]));
  const unique = dedupePrompts([], rows.map((r) => r.prompt), Number.MAX_SAFE_INTEGER).map((p) => byPrompt.get(p)!);
  const kept: typeof unique = [];
  let chars = 0;
  for (const r of unique) {
    const size = r.prompt.length + r.answer.length + 40;
    if (kept.length >= max || chars + size > FOLDER_LIMITS.draftChars) break;
    kept.push(r);
    chars += size;
  }
  return { rows: kept, cut: rows.length - kept.length };
}

/** The fence's own words can't appear in the writer's copy of a file, so a file can't close its own block. */
function unfence(text: string): string {
  const any = new RegExp(FOLDER_FENCE, "i");
  let out = text;
  // Again until it's gone: taking one out can join the pieces of another.
  while (any.test(out)) out = out.replace(new RegExp(FOLDER_FENCE, "gi"), "");
  return out;
}

function groundingOf(parts: Array<{ path: string; text: string }>, rows: Array<{ prompt: string; answer: string }>): string {
  const room = FOLDER_LIMITS.groundingChars;
  const blocks: string[] = [];
  let used = 0;
  // Every file gets a fair part of the room, and what a short file leaves goes to the next.
  parts.forEach((part, i) => {
    const share = Math.floor((room - used) / (parts.length - i + (rows.length ? 1 : 0)));
    const body = unfence(part.text).slice(0, Math.max(0, share)).trim();
    if (!body) return;
    const block = `File: ${risky(part.path) ? "a file" : unfence(part.path)}\n${body}`;
    blocks.push(block);
    used += block.length;
  });
  if (rows.length) {
    const lines: string[] = [];
    for (const r of rows) {
      const line = `Q: ${unfence(r.prompt)}\nA: ${unfence(r.answer)}`;
      if (used + line.length > room) break;
      lines.push(line);
      used += line.length;
    }
    if (lines.length) blocks.push(`Some of the person's own example rows:\n${lines.join("\n")}`);
  }
  // Once more on the whole: cutting a file short can leave something the scan would take out, and Start scans this again.
  // Cutting can't make a fence, since none is left to cut.
  return blocks.length ? `${FOLDER_GROUNDING}${withoutRiskyLines(blocks.join("\n\n").slice(0, room)).text}` : "";
}

export type FolderResult = { ok: true; draft: FolderDraft; hash: string; review: FolderReview } | { ok: false; error: string };

export function draftHash(d: FolderDraft): string {
  return createHash("sha256").update(canonicalJson({ mode: d.mode, rows: d.rows, grounding: d.grounding })).digest("hex");
}

const SKIP_REASONS = new Set<SkipReason>(["hidden", "env_file", "key_file", "not_text", "too_big", "too_many", "unreadable", "has_secret", "nothing_left"]);

/** What the browser says it skipped, for the review only: bounded, and a reason it can't make up. */
function skippedOf(raw: unknown): SkippedFile[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 500).flatMap((s) => {
    const r = s as { path?: unknown; reason?: unknown };
    return typeof r?.path === "string" && SKIP_REASONS.has(r.reason as SkipReason) ? [{ path: normalPath(r.path), reason: r.reason as SkipReason }] : [];
  });
}

/** The folder a request sent, cleaned, as what trains and what the person reviews. `maxRows`: the caller's most examples. */
export function cleanFolder(raw: { files?: unknown; skipped?: unknown }, maxRows: number): FolderResult {
  if (!Array.isArray(raw.files)) return { ok: false, error: "Send the files as a list." };
  const skipped = skippedOf(raw.skipped);
  const used: FolderReview["used"] = [];
  const texts: Array<{ path: string; text: string }> = [];
  const allRows: Array<{ prompt: string; answer: string }> = [];
  let removedLines = 0;
  let droppedRows = 0;
  let total = 0;
  for (const [i, f] of raw.files.entries()) {
    const file = f as { path?: unknown; text?: unknown };
    if (typeof file?.path !== "string" || typeof file.text !== "string") return { ok: false, error: "Each file needs a path and its text." };
    const path = normalPath(file.path);
    const skip = (reason: SkipReason) => skipped.push({ path, reason });
    if (i >= FOLDER_LIMITS.files) {
      skip("too_many");
      continue;
    }
    const kind = classifyFile(path);
    if (!kind.ok) {
      skip(kind.reason);
      continue;
    }
    if (looksBinary(file.text)) {
      skip("not_text");
      continue;
    }
    if (/-----BEGIN [A-Z ]{0,40}PRIVATE KEY/.test(file.text)) {
      skip("has_secret");
      continue;
    }
    const text = file.text.slice(0, FOLDER_LIMITS.textChars);
    total += text.length;
    if (total > FOLDER_LIMITS.totalChars) {
      skip("too_big");
      continue;
    }
    if (kind.kind === "data") {
      const rows = rowsOf(path, text);
      if (rows.length) {
        const safe = rows.filter((r) => !rowRisky(r));
        droppedRows += rows.length - safe.length;
        allRows.push(...safe);
        if (safe.length) used.push({ path, rows: safe.length });
        else skip("nothing_left");
        continue;
      }
    }
    const lines = withoutRiskyLines(text);
    removedLines += lines.removed;
    if (!lines.text.trim()) {
      skip("nothing_left");
      continue;
    }
    texts.push({ path, text: lines.text });
    used.push({ path, chars: lines.text.length, ...(lines.removed ? { removedLines: lines.removed } : {}) });
  }

  const fit = fitRows(allRows, maxRows);
  const mode: FolderDraft["mode"] = fit.rows.length >= FOLDER_ROWS_MIN ? "rows" : "write";
  const draft: FolderDraft = mode === "rows" ? { mode, rows: fit.rows, grounding: "" } : { mode, rows: [], grounding: groundingOf(texts, fit.rows) };
  if (mode === "write" && !draft.grounding) return { ok: false, error: "Nothing in these files could be used. Try text, documents, or rows with a prompt and an answer." };
  return {
    ok: true,
    draft,
    hash: draftHash(draft),
    review: {
      used,
      skipped: skipped.slice(0, 200),
      droppedRows,
      removedLines,
      cutRows: mode === "rows" ? fit.cut : 0,
      samples: (mode === "rows" ? fit.rows : []).slice(0, 3),
    },
  };
}

/**
 * The draft Start sent back, checked the same way again: only what this scan keeps can train, whatever a request claims,
 * and it must be the very draft the plan was signed for. Null when it isn't.
 */
export function checkDraft(raw: unknown, hash: string, maxRows: number): FolderDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as { mode?: unknown; rows?: unknown; grounding?: unknown };
  if (d.mode !== "rows" && d.mode !== "write") return null;
  if (typeof d.grounding !== "string" || !Array.isArray(d.rows)) return null;
  const rows: FolderDraft["rows"] = [];
  for (const r of d.rows as Array<{ prompt?: unknown; answer?: unknown }>) {
    if (typeof r?.prompt !== "string" || typeof r.answer !== "string" || !r.prompt || !r.answer) return null;
    rows.push({ prompt: r.prompt, answer: r.answer });
  }
  const draft: FolderDraft = { mode: d.mode, rows, grounding: d.grounding };
  if (draftHash(draft) !== hash) return null;
  if (draft.mode === "rows") {
    if (rows.length < FOLDER_ROWS_MIN || rows.length > maxRows || rows.some(rowRisky) || draft.grounding) return null;
  } else {
    if (rows.length || !draft.grounding.startsWith(FOLDER_GROUNDING) || draft.grounding.length > FOLDER_LIMITS.groundingChars + FOLDER_GROUNDING.length) return null;
    if (new RegExp(FOLDER_FENCE, "i").test(draft.grounding) || withoutRiskyLines(draft.grounding).removed > 0) return null;
  }
  return draft;
}
