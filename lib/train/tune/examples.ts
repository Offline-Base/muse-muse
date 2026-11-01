/**
 * The person's own examples for a run, parsed in the browser before anything is sent: a CSV with a prompt and an answer
 * column, a JSONL file (one object a line), or pairs pasted as text. Only the first EXAMPLE_ROWS_MAX rows go to the
 * plan route, which folds as many as fit into the dataset's task as style examples (foldExamples). Pure functions, so
 * the composer and the route share them.
 */
import type { ExampleRow } from "@/lib/train/tune/types";

/** Rows sent to the plan route at most. The rest are counted and left out. */
export const EXAMPLE_ROWS_MAX = 50;
/** A file bigger than this is refused before it is read. */
export const EXAMPLE_FILE_MAX_BYTES = 512 * 1024;
/** A prompt or an answer longer than these is cut, so one row can't crowd out the rest. */
export const EXAMPLE_PROMPT_MAX = 1500;
export const EXAMPLE_ANSWER_MAX = 4000;
/** The files the composer's "+" takes for a run. */
export const EXAMPLE_ACCEPT = ".csv,.jsonl,.json,.txt,.tsv,text/csv,text/plain,application/json,application/x-ndjson";

export type ExampleFormat = "csv" | "tsv" | "jsonl" | "text";

export interface ParsedExamples {
  /** The first EXAMPLE_ROWS_MAX usable rows. */
  rows: ExampleRow[];
  /** Usable rows in all, kept or not. */
  total: number;
  format: ExampleFormat;
  /** Plain sentences about what was skipped, at most a few. */
  problems: string[];
}

const PROMPT_KEYS = ["prompt", "input", "question", "instruction", "user", "query", "message", "text"];
const ANSWER_KEYS = ["answer", "output", "response", "completion", "assistant", "reply", "reference", "label"];

const clean = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "").replace(/\r\n?/g, "\n").trim();

function row(prompt: unknown, answer: unknown): ExampleRow | null {
  const p = clean(prompt).slice(0, EXAMPLE_PROMPT_MAX);
  const a = clean(answer).slice(0, EXAMPLE_ANSWER_MAX);
  return p && a ? { prompt: p, answer: a } : null;
}

/** The format a file or a paste most likely is, from its name first and then its first line. */
export function detectFormat(text: string, fileName?: string | null): ExampleFormat {
  const name = (fileName ?? "").toLowerCase();
  if (name.endsWith(".jsonl") || name.endsWith(".json")) return "jsonl";
  if (name.endsWith(".tsv")) return "tsv";
  if (name.endsWith(".csv")) return "csv";
  const first = text.replace(/^﻿/, "").trimStart().split("\n", 1)[0] ?? "";
  if (first.startsWith("{") || first.startsWith("[")) return "jsonl";
  if (first.includes("\t")) return "tsv";
  const head = first.toLowerCase();
  if (head.includes(",") && [...PROMPT_KEYS, ...ANSWER_KEYS].some((k) => new RegExp(`(^|,)\\s*"?${k}"?\\s*(,|$)`).test(head))) return "csv";
  return "text";
}

/** Reads one object as a row: prompt and answer under any of the usual names, or chat messages (user, then assistant). */
function objectRow(o: unknown): ExampleRow | null {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const rec = o as Record<string, unknown>;
  if (Array.isArray(rec.messages)) {
    const msgs = rec.messages as Array<{ role?: unknown; content?: unknown }>;
    const user = msgs.find((m) => m?.role === "user");
    const reply = msgs.find((m) => m?.role === "assistant");
    return row(user?.content, reply?.content);
  }
  const lower = new Map(Object.entries(rec).map(([k, v]) => [k.toLowerCase(), v]));
  const pick = (keys: string[]) => keys.map((k) => lower.get(k)).find((v) => clean(v));
  return row(pick(PROMPT_KEYS), pick(ANSWER_KEYS));
}

/** Splits CSV text into records (RFC 4180: quoted fields, doubled quotes, line breaks inside quotes). */
export function csvRecords(text: string, sep = ","): string[][] {
  const out: string[][] = [];
  let rec: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
      rec.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      rec.push(field);
      if (rec.some((f) => f.trim())) out.push(rec);
      rec = [];
      field = "";
    } else field += c;
  }
  rec.push(field);
  if (rec.some((f) => f.trim())) out.push(rec);
  return out;
}

function tableRows(records: string[][]): { rows: ExampleRow[]; skipped: number } {
  if (!records.length) return { rows: [], skipped: 0 };
  const head = records[0]!.map((h) => h.trim().toLowerCase());
  let pi = head.findIndex((h) => PROMPT_KEYS.includes(h));
  let ai = head.findIndex((h) => ANSWER_KEYS.includes(h));
  let body = records.slice(1);
  if (pi < 0 || ai < 0 || pi === ai) {
    // No header that names the columns: the first two columns are the prompt and the answer.
    pi = 0;
    ai = 1;
    body = records;
  }
  const rows: ExampleRow[] = [];
  let skipped = 0;
  for (const r of body) {
    const got = row(r[pi], r[ai]);
    if (got) rows.push(got);
    else skipped++;
  }
  return { rows, skipped };
}

/** Labels a pasted pair may use, before the prompt and before the answer. */
const PASTE_PROMPT = /^(?:q|question|prompt|user|input|customer)\s*:\s*/i;
const PASTE_ANSWER = /^(?:a|answer|response|assistant|output|reply)\s*:\s*/i;

/**
 * Pairs pasted as text: "Q: ... / A: ..." (or Prompt/Answer, User/Assistant, Input/Output), one label a line, an
 * answer running on until the next prompt; or one pair a line with a tab or " => " between them.
 */
function pastedRows(text: string): { rows: ExampleRow[]; skipped: number } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const rows: ExampleRow[] = [];
  let skipped = 0;
  let prompt: string[] | null = null;
  let answer: string[] | null = null;
  const flush = () => {
    if (prompt || answer) {
      const got = row(prompt?.join("\n"), answer?.join("\n"));
      if (got) rows.push(got);
      else skipped++;
    }
    prompt = null;
    answer = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (PASTE_PROMPT.test(line.trimStart())) {
      flush();
      prompt = [line.trimStart().replace(PASTE_PROMPT, "")];
    } else if (PASTE_ANSWER.test(line.trimStart()) && prompt && !answer) {
      answer = [line.trimStart().replace(PASTE_ANSWER, "")];
    } else if (answer) {
      answer.push(line);
    } else if (prompt) {
      prompt.push(line);
    } else if (/\t| => /.test(line)) {
      const [p, ...rest] = line.split(/\t| => /);
      const got = row(p, rest.join(" "));
      if (got) rows.push(got);
      else skipped++;
    } else if (line.trim()) {
      skipped++;
    }
  }
  flush();
  return { rows, skipped };
}

/**
 * The rows in a file's text or a paste. `fileName` picks the format when it has a known extension; otherwise the text
 * decides (detectFormat). Rows past EXAMPLE_ROWS_MAX are counted in `total` but not kept.
 */
export function parseExamples(text: string, fileName?: string | null): ParsedExamples {
  const format = detectFormat(text, fileName);
  let rows: ExampleRow[] = [];
  let skipped = 0;
  if (format === "jsonl") {
    const trimmed = text.replace(/^﻿/, "").trim();
    let objects: unknown[] | null = null;
    if (trimmed.startsWith("[")) {
      try {
        const all = JSON.parse(trimmed) as unknown;
        objects = Array.isArray(all) ? all : null;
      } catch {
        objects = null;
      }
    }
    if (!objects) {
      objects = trimmed
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l) as unknown;
          } catch {
            return null;
          }
        });
    }
    for (const o of objects) {
      const got = objectRow(o);
      if (got) rows.push(got);
      else skipped++;
    }
  } else if (format === "csv" || format === "tsv") {
    ({ rows, skipped } = tableRows(csvRecords(text, format === "tsv" ? "\t" : ",")));
  } else {
    ({ rows, skipped } = pastedRows(text));
  }
  const problems: string[] = [];
  if (skipped) problems.push(`${skipped} ${skipped === 1 ? "row has" : "rows have"} no prompt and answer, so ${skipped === 1 ? "it was" : "they were"} left out.`);
  if (rows.length > EXAMPLE_ROWS_MAX) problems.push(`Only the first ${EXAMPLE_ROWS_MAX} of ${rows.length} rows are used.`);
  if (!rows.length) problems.push("No examples found. Use a prompt and an answer per row, like Q: and A: lines.");
  return { rows: rows.slice(0, EXAMPLE_ROWS_MAX), total: rows.length, format, problems };
}

/** The rows the plan route takes from a request body: plain objects with a prompt and an answer, at most EXAMPLE_ROWS_MAX. */
export function examplesFromBody(raw: unknown): ExampleRow[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > EXAMPLE_ROWS_MAX) return null;
  const rows: ExampleRow[] = [];
  for (const r of raw) {
    const got = r && typeof r === "object" ? row((r as ExampleRow).prompt, (r as ExampleRow).answer) : null;
    if (!got) return null;
    rows.push(got);
  }
  return rows;
}

/** How much of one row goes into the task: enough to show its style. */
const FOLD_PROMPT_CHARS = 200;
const FOLD_ANSWER_CHARS = 320;
const FOLD_HEAD = "Write in the style of these examples, which are the person's own:";

function cut(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 3).replace(/\s+\S*$/, "")}...`;
}

/**
 * The dataset's task: the person's words, then as many of their rows as fit under `max` characters, each cut short, as
 * the examples whose style the writer follows. `used` is how many fit.
 */
export function foldExamples(note: string, rows: readonly ExampleRow[], max: number): { task: string; used: number } {
  let task = note.trim();
  let used = 0;
  for (const r of rows) {
    const line = `\n- Q: ${cut(r.prompt, FOLD_PROMPT_CHARS)}\n  A: ${cut(r.answer, FOLD_ANSWER_CHARS)}`;
    const next = used === 0 ? `${task}\n\n${FOLD_HEAD}${line}` : `${task}${line}`;
    if (next.length > max) break;
    task = next;
    used++;
  }
  return { task, used };
}
