/**
 * Decision datasets (docs/DECISION_MODELS.md, "The dataset"): a person's labeled rows, read from CSV, JSONL or JSON
 * rows, checked, merged where their inputs fold to the same text, and split once with the test split held out first.
 * Also the pages a decide job's GPU reads (part=train, dev and eval), laid out from the dataset's spec alone, and the
 * dataset route's page cap. Pure, no I/O: the datasets route and the job dataset route call these, and the tests run
 * them directly.
 */
import {
  DESCRIPTION_MAX_CHARS,
  NONE_OPTION,
  OPTION_MAX_CHARS,
  QUESTION_MAX_CHARS,
  QUESTION_MIN_CHARS,
  STATE_MAX_CHARS,
  decideItem,
  decisionItems,
  labelId,
  seededRandom,
  shuffled,
  trainExample,
  trainRendering,
} from "@/lib/decide/format";
import type { DecideItem, DecideSplitCounts, DecisionLabel, DecisionRow, DecisionRows, DecisionSpec } from "@/lib/decide/types";
import { isNearDuplicate, NEAR_DUPLICATE_JACCARD, promptKey, promptWords } from "@/lib/train/logic";
import type { TrainExample } from "@/lib/train/types";

// ---------------------------------------------------------------------------------------------------------------
// Limits

export const DECISION_LABELS_MIN = 2;
export const DECISION_LABELS_MAX = 12;
/** The design's floor: 20 rows per label leaves 5 to test, 3 to fit T and 12 to train on. */
export const DECISION_ROWS_PER_LABEL_MIN = 20;
/** Rows in all, read before merging, for a person's dataset. */
export const DECISION_ROWS_MAX = 3_000;
/** The whole request, under Vercel's 4.5 MB body limit. */
export const DECISION_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
export const DECISION_TITLE_MAX = 200;
/** The upload's report warns when the largest label has more than this many times the rows of the smallest. */
export const IMBALANCE_WARN_RATIO = 5;
/** Training repeats a smaller label's rows until the largest label has at most this many times its renderings... */
export const BALANCE_RATIO = 3;
/** ...with at most this many copies of a row an epoch, each with a new option order. */
export const BALANCE_COPIES_MAX = 3;

/** Held out first: 20% of each label's rows, at least 5. Never trained on, scored once. */
export const TEST_SHARE = 0.2;
export const TEST_MIN = 5;
/** Then 10% of each label's rows, at least 3, only to fit T. */
export const DEV_SHARE = 0.1;
export const DEV_MIN = 3;
/** What is left trains, at least 12 a label. */
export const TRAIN_MIN = 12;

/** A decide job's epochs param (docs/DECISION_MODELS.md, "A mode, not a new recipe"). */
export const DECIDE_EPOCHS_DEFAULT = 2;
export const DECIDE_EPOCHS_MIN = 1;
export const DECIDE_EPOCHS_MAX = 4;

/**
 * Renderings a page of a decide part. A rendering holds the task twice, and a 3,000-character state whose characters
 * JSON escapes twice (once in the task, once in the reply) can come to about 21,000 bytes a copy, so 50 keep a page
 * under 4 MB, inside Vercel's 4.5 MB response limit (decision-datasets.test.ts checks the worst case).
 */
export const DECIDE_PAGE_SIZE = 50;

/** Problems an upload lists at most; past this the last one says how many more there are. */
export const PROBLEMS_MAX = 20;

const LINE_BREAK = /[\r\n\u2028\u2029]/;

// ---------------------------------------------------------------------------------------------------------------
// Reading rows

/** One problem with an upload: its line (CSV and JSONL), its row number (JSON rows), or null for the whole upload. */
export interface DecisionProblem {
  line: number | null;
  message: string;
}

/** A row as read, before its label is matched: where it was and what it said. */
export interface ParsedDecisionRow {
  line: number;
  input: string;
  label: string;
}

interface Parsed {
  rows: ParsedDecisionRow[];
  problems: DecisionProblem[];
}

/** Text as the parsers read it: no byte order mark, and every line break a "\n". */
function normalizedText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/**
 * CSV records (RFC 4180): fields split by commas, a field in double quotes may hold commas, line breaks and "" for a
 * quote. Each record keeps the line it starts on. A record with a broken quote is a problem, and reading goes on at
 * the next line.
 */
function csvRecords(text: string): Array<{ line: number; fields: string[] } | { line: number; problem: string }> {
  const s = normalizedText(text);
  const out: Array<{ line: number; fields: string[] } | { line: number; problem: string }> = [];
  let i = 0;
  let line = 1;
  while (i < s.length) {
    const start = line;
    const fields: string[] = [];
    let problem: string | null = null;
    for (;;) {
      let field = "";
      if (s[i] === '"') {
        i++;
        let closed = false;
        while (i < s.length) {
          const c = s[i]!;
          if (c === '"') {
            if (s[i + 1] === '"') {
              field += '"';
              i += 2;
              continue;
            }
            i++;
            closed = true;
            break;
          }
          if (c === "\n") line++;
          field += c;
          i++;
        }
        if (!closed) {
          problem = "a quoted field is never closed. Close it with a double quote.";
          i = s.length;
          break;
        }
        if (i < s.length && s[i] !== "," && s[i] !== "\n") {
          problem = 'there is text right after a closing quote. Write a quote inside quoted text as "".';
          while (i < s.length && s[i] !== "\n") i++;
          if (i < s.length) {
            i++;
            line++;
          }
          break;
        }
      } else {
        while (i < s.length && s[i] !== "," && s[i] !== "\n") field += s[i++];
      }
      fields.push(field);
      if (i >= s.length) break;
      if (s[i] === ",") {
        i++;
        if (i >= s.length) {
          fields.push("");
          break;
        }
        continue;
      }
      i++; // "\n"
      line++;
      break;
    }
    out.push(problem ? { line: start, problem } : { line: start, fields });
  }
  return out;
}

/**
 * Rows from CSV text: a header naming the columns input and label (in either order, other columns ignored), then one
 * row a line. Blank lines are skipped. Every row has as many fields as the header, so an input with an unquoted comma
 * is caught on its line.
 */
export function parseDecisionCsv(text: string): Parsed {
  const rows: ParsedDecisionRow[] = [];
  const problems: DecisionProblem[] = [];
  const records = csvRecords(text);
  const blank = (r: (typeof records)[number]) => "fields" in r && r.fields.every((f) => !f.trim());
  const at = records.findIndex((r) => !blank(r));
  const header = records[at];
  const columns = header && "fields" in header ? header.fields.map((f) => f.trim().toLowerCase()) : [];
  const inputAt = columns.indexOf("input");
  const labelAt = columns.indexOf("label");
  if (!header || inputAt < 0 || labelAt < 0 || columns.lastIndexOf("input") !== inputAt || columns.lastIndexOf("label") !== labelAt) {
    const line = header?.line ?? 1;
    return { rows, problems: [{ line, message: `Line ${line}: the first line must name the columns, as input,label.` }] };
  }
  for (const r of records.slice(at + 1)) {
    if (blank(r)) continue;
    if ("problem" in r) {
      problems.push({ line: r.line, message: `Line ${r.line}: ${r.problem}` });
      continue;
    }
    if (r.fields.length !== columns.length) {
      problems.push({
        line: r.line,
        message: `Line ${r.line} has ${r.fields.length} fields, but the header has ${columns.length}. Put text that has commas in double quotes.`,
      });
      continue;
    }
    rows.push({ line: r.line, input: r.fields[inputAt]!, label: r.fields[labelAt]! });
  }
  return { rows, problems };
}

/** Rows from JSON Lines: one object a line, with input and label as text. Blank lines are skipped, other keys ignored. */
export function parseDecisionJsonl(text: string): Parsed {
  const rows: ParsedDecisionRow[] = [];
  const problems: DecisionProblem[] = [];
  normalizedText(text)
    .split("\n")
    .forEach((raw, i) => {
      const line = i + 1;
      if (!raw.trim()) return;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        problems.push({ line, message: `Line ${line} isn't valid JSON.` });
        return;
      }
      const row = rowOf(value);
      if (row) rows.push({ line, ...row });
      else problems.push({ line, message: `Line ${line} must be an object with "input" and "label", both text.` });
    });
  return { rows, problems };
}

/** Rows sent as a JSON array of {input, label}. A row's "line" is its number in the array, from 1. */
export function parseDecisionRows(value: unknown): Parsed {
  if (!Array.isArray(value)) return { rows: [], problems: [{ line: null, message: "rows must be a list of {input, label}." }] };
  const rows: ParsedDecisionRow[] = [];
  const problems: DecisionProblem[] = [];
  value.forEach((item, i) => {
    const line = i + 1;
    const row = rowOf(item);
    if (row) rows.push({ line, ...row });
    else problems.push({ line, message: `Row ${line} must be an object with "input" and "label", both text.` });
  });
  return { rows, problems };
}

function rowOf(value: unknown): { input: string; label: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { input, label } = value as Record<string, unknown>;
  return typeof input === "string" && typeof label === "string" ? { input, label } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Checking the definition

/**
 * A decision's labels from what a person sent: 2 to 12, each a name (1 to 60 characters, unique ignoring case, never
 * the "none" text) or {name, description} with a description of up to 200. Ids are made from the names (labelId), so
 * two names that make the same id are refused too.
 */
export function checkLabels(value: unknown): { labels: DecisionLabel[]; problems: DecisionProblem[] } {
  const problems: DecisionProblem[] = [];
  const fail = (message: string) => ({ labels: [], problems: [{ line: null, message }] });
  if (!Array.isArray(value)) return fail("labels must be a list of names, or of {name, description}.");
  if (value.length < DECISION_LABELS_MIN || value.length > DECISION_LABELS_MAX) {
    return fail(`A decision has ${DECISION_LABELS_MIN} to ${DECISION_LABELS_MAX} labels; this has ${value.length}.`);
  }
  const labels: DecisionLabel[] = [];
  const names = new Map<string, number>();
  const ids = new Map<string, number>();
  const noneKey = promptKey(NONE_OPTION);
  value.forEach((item, i) => {
    const n = i + 1;
    const raw = typeof item === "string" ? { name: item } : item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    if (!raw || typeof raw.name !== "string") {
      problems.push({ line: null, message: `Label ${n} needs a name.` });
      return;
    }
    const name = raw.name.trim();
    const length = Array.from(name).length;
    if (length < 1 || length > OPTION_MAX_CHARS) {
      problems.push({ line: null, message: `Label ${n}'s name must be 1 to ${OPTION_MAX_CHARS} characters.` });
      return;
    }
    if (LINE_BREAK.test(name)) {
      problems.push({ line: null, message: `Label ${n}'s name must be on one line.` });
      return;
    }
    if (promptKey(name) === noneKey) {
      problems.push({ line: null, message: `"${NONE_OPTION}" is added to every prompt, so it can't be a label.` });
      return;
    }
    if (raw.description !== undefined && raw.description !== null && typeof raw.description !== "string") {
      problems.push({ line: null, message: `Label ${n}'s description must be text.` });
      return;
    }
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    if (Array.from(description).length > DESCRIPTION_MAX_CHARS) {
      problems.push({ line: null, message: `Label ${n}'s description must be at most ${DESCRIPTION_MAX_CHARS} characters.` });
      return;
    }
    const id = labelId(name);
    if (!id) {
      problems.push({ line: null, message: `Label ${n}'s name needs a letter or a digit.` });
      return;
    }
    const folded = name.toLowerCase();
    if (names.has(folded)) {
      problems.push({ line: null, message: `Labels ${names.get(folded)} and ${n} have the same name.` });
      return;
    }
    if (ids.has(id)) {
      problems.push({ line: null, message: `Labels ${ids.get(id)} and ${n} are too alike: both become "${id}".` });
      return;
    }
    names.set(folded, n);
    ids.set(id, n);
    labels.push({ id, name, description });
  });
  return { labels, problems };
}

/** The question every task asks, trimmed: 5 to 300 characters. Null with the problem otherwise. */
export function checkQuestion(value: unknown): { question: string } | { problem: DecisionProblem } {
  const question = typeof value === "string" ? value.trim() : "";
  const length = Array.from(question).length;
  if (length < QUESTION_MIN_CHARS || length > QUESTION_MAX_CHARS) {
    return { problem: { line: null, message: `The question must be ${QUESTION_MIN_CHARS} to ${QUESTION_MAX_CHARS} characters.` } };
  }
  return { question };
}

/**
 * The label a row names: by name, ignoring case and the spaces around it, or by the id the platform makes from a
 * name ("sign-in-issues", or anything labelId folds to it). Null when it is none of them.
 */
export function matchLabel(labels: readonly DecisionLabel[], given: string): DecisionLabel | null {
  const text = given.trim().toLowerCase();
  if (!text) return null;
  const id = labelId(given);
  return labels.find((l) => l.name.toLowerCase() === text) ?? labels.find((l) => l.id === text || (id && l.id === id)) ?? null;
}

/** The key two inputs share when they fold to the same text (promptKey); an input with no letters or digits keeps its own text. */
export function rowKey(input: string): string {
  return promptKey(input) || `\u0000${input}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Merging and splitting

export interface MergeReport {
  /** Rows dropped because an earlier row with the same label folds to the same text: its line, and the kept row's. */
  merged: Array<{ line: number; sameAs: number }>;
  /** Inputs that fold to the same text but came with different labels: every such row is dropped, listed here. */
  conflicts: Array<{ lines: number[]; labels: string[] }>;
}

/**
 * Rows whose inputs fold to the same text (rowKey) become one: the first, when they agree on the label. When they
 * don't, all of them are dropped and listed, since the person's own data disagrees. Order is kept.
 */
export function mergeDecisionRows(rows: ReadonlyArray<{ line: number; input: string; label: string }>): {
  rows: Array<{ line: number; input: string; label: string }>;
  report: MergeReport;
} {
  const groups = new Map<string, Array<{ line: number; input: string; label: string }>>();
  for (const r of rows) {
    const key = rowKey(r.input);
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }
  const kept = new Set<{ line: number; input: string; label: string }>();
  const report: MergeReport = { merged: [], conflicts: [] };
  for (const group of groups.values()) {
    const labels = [...new Set(group.map((r) => r.label))];
    if (labels.length > 1) {
      report.conflicts.push({ lines: group.map((r) => r.line), labels });
      continue;
    }
    kept.add(group[0]!);
    for (const r of group.slice(1)) report.merged.push({ line: r.line, sameAs: group[0]!.line });
  }
  return { rows: rows.filter((r) => kept.has(r)), report };
}

/** How many of a label's `n` rows the test and dev splits want: 20% (at least 5) and 10% (at least 3). */
export function splitWants(n: number): { test: number; dev: number } {
  return { test: Math.max(TEST_MIN, Math.round(n * TEST_SHARE)), dev: Math.max(DEV_MIN, Math.round(n * DEV_SHARE)) };
}

/**
 * Near-duplicate clusters (isNearDuplicate, 70% shared words), joined through any chain of near-duplicates, as a root
 * index per row. Only pairs whose word counts allow 70% overlap are compared.
 */
function nearDuplicateRoots(inputs: readonly string[]): number[] {
  const parent = inputs.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const words = inputs.map(promptWords);
  const bySize = inputs.map((_, i) => i).sort((a, b) => words[a]!.size - words[b]!.size || a - b);
  for (let x = 0; x < bySize.length; x++) {
    const i = bySize[x]!;
    const small = words[i]!.size;
    if (!small) continue;
    for (let y = x + 1; y < bySize.length; y++) {
      const j = bySize[y]!;
      // Sizes only grow from here, and Jaccard is at most small / big.
      if (small < NEAR_DUPLICATE_JACCARD * words[j]!.size) break;
      if (find(i) === find(j)) continue;
      if (isNearDuplicate(words[i]!, words[j]!)) parent[find(j)] = find(i);
    }
  }
  return inputs.map((_, i) => find(i));
}

/**
 * The split, made once when the dataset is saved, the test split held out first. Within each label, rows are ordered
 * by a hash of the seed and their folded text. Walking the labels in order and each label's rows in that order, a row
 * and every row joined to it by near-duplicates (one cluster) go to one split together: test while every label in the
 * cluster still has room under its test count, else dev the same way, else train. So a test row never has a
 * near-twin in train or dev, which catches reorderings and small edits, not paraphrases. A label left with fewer than 5
 * test, 3 dev or 12 train rows is a problem. Each split comes back grouped by label in the labels' order, each label's
 * rows in hash order: the order the pages are laid out from (splitRanges).
 */
export function splitDecisionRows(
  rows: readonly DecisionRow[],
  labels: readonly DecisionLabel[],
  seed: string,
): { rows: DecisionRows; perLabel: Record<string, DecideSplitCounts>; problems: DecisionProblem[] } {
  const order = rows.map((r) => seededRandom(`${seed}:${rowKey(r.input)}`)());
  const roots = nearDuplicateRoots(rows.map((r) => r.input));
  const clusters = new Map<number, number[]>();
  roots.forEach((root, i) => {
    const c = clusters.get(root);
    if (c) c.push(i);
    else clusters.set(root, [i]);
  });
  const keys = rows.map((r) => rowKey(r.input));
  const byOrder = (a: number, b: number) => order[a]! - order[b]! || (keys[a]! < keys[b]! ? -1 : keys[a]! > keys[b]! ? 1 : a - b);
  const counts: Record<string, DecideSplitCounts> = {};
  const wants: Record<string, { test: number; dev: number }> = {};
  for (const l of labels) {
    counts[l.id] = { train: 0, dev: 0, test: 0 };
    wants[l.id] = splitWants(rows.filter((r) => r.label === l.id).length);
  }
  const placed: Array<keyof DecideSplitCounts | undefined> = rows.map(() => undefined);
  for (const l of labels) {
    const mine = rows.map((_, i) => i).filter((i) => rows[i]!.label === l.id).sort(byOrder);
    for (const i of mine) {
      if (placed[i]) continue;
      const cluster = clusters.get(roots[i]!)!;
      const need = new Map<string, number>();
      for (const j of cluster) need.set(rows[j]!.label, (need.get(rows[j]!.label) ?? 0) + 1);
      const fits = (part: "test" | "dev") => [...need].every(([id, k]) => counts[id]![part] + k <= wants[id]![part]);
      const part = fits("test") ? "test" : fits("dev") ? "dev" : "train";
      for (const j of cluster) {
        placed[j] = part;
        counts[rows[j]!.label]![part] += 1;
      }
    }
  }
  const problems: DecisionProblem[] = [];
  for (const l of labels) {
    const c = counts[l.id]!;
    if (c.test < TEST_MIN || c.dev < DEV_MIN || c.train < TRAIN_MIN) {
      problems.push({
        line: null,
        message:
          `"${l.name}": too many of its examples are near-copies of each other or of other labels' examples to hold out ` +
          `${TEST_MIN} for testing and ${DEV_MIN} for calibration and still train on ${TRAIN_MIN}. Add more varied examples.`,
      });
    }
  }
  const split = (part: keyof DecideSplitCounts): DecisionRow[] =>
    labels.flatMap((l) =>
      rows
        .map((_, i) => i)
        .filter((i) => placed[i] === part && rows[i]!.label === l.id)
        .sort(byOrder)
        .map((i) => ({ input: rows[i]!.input, label: rows[i]!.label })),
    );
  return { rows: { train: split("train"), dev: split("dev"), test: split("test") }, perLabel: counts, problems };
}

// ---------------------------------------------------------------------------------------------------------------
// The upload, end to end

/** What POST /api/train/datasets takes for kind "decision". Exactly one of rows, csv and jsonl. */
export interface DecisionUploadInput {
  title?: unknown;
  question?: unknown;
  labels?: unknown;
  rows?: unknown;
  csv?: unknown;
  jsonl?: unknown;
}

/** What the upload card shows after a save. */
export interface DecisionUploadReport {
  /** Rows read. */
  read: number;
  /** Rows kept after merging, all of them in a split. */
  kept: number;
  merged: MergeReport["merged"];
  conflicts: MergeReport["conflicts"];
  /** Rows per split, per label id. */
  perLabel: Record<string, DecideSplitCounts>;
  /** Plain sentences, such as a label with far more rows than another. */
  warnings: string[];
}

export type DecisionUploadResult =
  | { ok: true; title: string; spec: DecisionSpec; rows: DecisionRows; report: DecisionUploadReport }
  | { ok: false; error: string; problems: DecisionProblem[] };

/** The start of the question, cut at a word, for a dataset sent without a title. */
function titleFromQuestion(question: string): string {
  const max = 60;
  if (question.length <= max) return question;
  return question.slice(0, max).replace(/\s+\S*$/, "") || question.slice(0, max);
}

function failed(problems: DecisionProblem[]): DecisionUploadResult {
  const shown = problems.slice(0, PROBLEMS_MAX);
  if (problems.length > PROBLEMS_MAX) shown.push({ line: null, message: `And ${problems.length - PROBLEMS_MAX} more.` });
  const error =
    problems.length === 1 ? problems[0]!.message : `The upload has ${problems.length.toLocaleString("en-US")} problems. The first: ${problems[0]!.message}`;
  return { ok: false, error, problems: shown };
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}

function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * A decision dataset from what a person sent: the title (or the start of the question), the question, the labels and
 * the rows (CSV, JSONL or JSON), checked, merged and split with `seed`. Every problem comes back at once, each with
 * its line when it has one. On success: the spec and the split rows to save, and the report the upload card shows.
 */
export function checkDecisionUpload(input: DecisionUploadInput, seed: string): DecisionUploadResult {
  const problems: DecisionProblem[] = [];
  if (input.title !== undefined && input.title !== null && typeof input.title !== "string") problems.push({ line: null, message: "title must be text." });
  const asked = checkQuestion(input.question);
  if ("problem" in asked) problems.push(asked.problem);
  const { labels, problems: labelProblems } = checkLabels(input.labels);
  problems.push(...labelProblems);
  const sources = (["rows", "csv", "jsonl"] as const).filter((k) => input[k] !== undefined && input[k] !== null);
  let parsed: Parsed = { rows: [], problems: [] };
  if (sources.length !== 1) {
    problems.push({ line: null, message: "Send the rows one way: rows (a list of {input, label}), csv or jsonl." });
  } else if (sources[0] === "rows") {
    parsed = parseDecisionRows(input.rows);
  } else if (typeof input[sources[0]!] !== "string") {
    problems.push({ line: null, message: `${sources[0]} must be text.` });
  } else {
    parsed = (sources[0] === "csv" ? parseDecisionCsv : parseDecisionJsonl)(input[sources[0]!] as string);
  }
  if (parsed.rows.length + parsed.problems.length > DECISION_ROWS_MAX) {
    const n = parsed.rows.length + parsed.problems.length;
    return failed([{ line: null, message: `The upload has ${n.toLocaleString("en-US")} rows; a decision dataset takes at most ${DECISION_ROWS_MAX.toLocaleString("en-US")}.` }]);
  }
  // With the definition broken, rows can't be matched to labels: say what is wrong with both and stop.
  if (problems.length) return failed([...problems, ...parsed.problems]);
  if (!parsed.rows.length && !parsed.problems.length) return failed([{ line: null, message: "The upload has no rows." }]);
  problems.push(...parsed.problems);

  // Every row: an input of 1 to 3,000 characters and a known label. Unknown labels are listed once each, with their lines.
  const unknown = new Map<string, number[]>();
  const resolved: Array<{ line: number; input: string; label: string }> = [];
  const where = sources[0] === "rows" ? "Row" : "Line";
  for (const r of parsed.rows) {
    const text = r.input.trim();
    const length = Array.from(text).length;
    if (length < 1 || length > STATE_MAX_CHARS) {
      problems.push({ line: r.line, message: `${where} ${r.line}: the input must be 1 to ${STATE_MAX_CHARS.toLocaleString("en-US")} characters.` });
      continue;
    }
    const label = matchLabel(labels, r.label);
    if (!label) {
      const key = r.label.trim();
      unknown.set(key, [...(unknown.get(key) ?? []), r.line]);
      continue;
    }
    resolved.push({ line: r.line, input: text, label: label.id });
  }
  for (const [given, lines] of unknown) {
    const shown = lines.slice(0, 10).map(String);
    const more = lines.length > 10 ? ` and ${lines.length - 10} more` : "";
    const name = given ? `The label "${given}"` : "An empty label";
    problems.push({
      line: lines[0]!,
      message: `${name} isn't one of this decision's labels (${where.toLowerCase()}${lines.length === 1 ? "" : "s"} ${andList(shown)}${more}).`,
    });
  }
  if (problems.length) return failed(problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)));

  const merged = mergeDecisionRows(resolved);
  for (const l of labels) {
    const n = merged.rows.filter((r) => r.label === l.id).length;
    if (n < DECISION_ROWS_PER_LABEL_MIN) {
      problems.push({
        line: null,
        message: `"${l.name}" has ${plural(n, "example")}${merged.report.merged.length || merged.report.conflicts.length ? " after repeats are merged" : ""}; each label needs at least ${DECISION_ROWS_PER_LABEL_MIN}.`,
      });
    }
  }
  if (problems.length) return failed(problems);

  const split = splitDecisionRows(
    merged.rows.map((r) => ({ input: r.input, label: r.label })),
    labels,
    seed,
  );
  if (split.problems.length) return failed(split.problems);

  const question = "question" in asked ? asked.question : "";
  const title = (typeof input.title === "string" && input.title.trim() ? input.title.trim() : titleFromQuestion(question)).slice(0, DECISION_TITLE_MAX);
  const totals: DecideSplitCounts = { train: split.rows.train.length, dev: split.rows.dev.length, test: split.rows.test.length };
  const spec: DecisionSpec = { version: 1, question, labels, seed, split: totals, perLabel: split.perLabel, source: "person" };
  const warnings: string[] = [];
  const sizes = labels.map((l) => ({ l, n: merged.rows.filter((r) => r.label === l.id).length }));
  const largest = sizes.reduce((a, b) => (b.n > a.n ? b : a));
  const smallest = sizes.reduce((a, b) => (b.n < a.n ? b : a));
  if (largest.n > IMBALANCE_WARN_RATIO * smallest.n) {
    warnings.push(
      `"${largest.l.name}" has ${plural(largest.n, "example")}, more than ${IMBALANCE_WARN_RATIO} times the ${smallest.n.toLocaleString("en-US")} of "${smallest.l.name}". ` +
        `Training repeats the smaller labels' examples up to ${BALANCE_COPIES_MAX} times, and macro F1 shows how the small labels do, but more examples of them would help more.`,
    );
  }
  if (merged.report.conflicts.length) {
    warnings.push(`${plural(merged.report.conflicts.length, "input")} came with two different labels, so ${merged.report.conflicts.length === 1 ? "its rows were" : "their rows were"} left out.`);
  }
  return {
    ok: true,
    title,
    spec,
    rows: split.rows,
    report: {
      read: parsed.rows.length,
      kept: merged.rows.length,
      merged: merged.report.merged,
      conflicts: merged.report.conflicts,
      perLabel: split.perLabel,
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// What a decide job reads: the train, dev and eval (test) parts, laid out from the spec

export type DecisionSplit = keyof DecisionRows;

/** True when a job's params ask for decide mode (the glimmer-lora recipe's `mode` param). */
export function isDecideMode(params: Record<string, unknown> | null | undefined): boolean {
  return params?.mode === "decide";
}

/** A decide job's epochs: its `epochs` param when it is a whole number from 1 to 4, else 2. */
export function decideEpochs(params: Record<string, unknown> | null | undefined): number {
  const raw = params?.epochs;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw.trim()) : NaN;
  return Number.isInteger(n) && n >= DECIDE_EPOCHS_MIN && n <= DECIDE_EPOCHS_MAX ? n : DECIDE_EPOCHS_DEFAULT;
}

/** Where each label's rows sit in a split: grouped by label in the labels' order, as splitDecisionRows saves them. */
export function splitRanges(spec: DecisionSpec, split: DecisionSplit): Array<{ id: string; from: number; to: number }> {
  let at = 0;
  return spec.labels.map((l) => {
    const n = spec.perLabel[l.id]?.[split] ?? 0;
    const range = { id: l.id, from: at, to: at + n };
    at += n;
    return range;
  });
}

/** The label of each row of a split, in order, from the spec alone. */
export function splitLabels(spec: DecisionSpec, split: DecisionSplit): string[] {
  return splitRanges(spec, split).flatMap((r) => Array.from({ length: r.to - r.from }, () => r.id));
}

/**
 * Copies of each train row an epoch, per label id: 1 for the largest label, and for a smaller one enough that the
 * largest has at most 3 times its renderings, at most 3 (each copy gets a new option order). So 900 against 100 is 3
 * copies (3 to 1), and 900 against 12 is still 3 (25 to 1): macro F1 shows how such a label does.
 */
export function balanceCopies(spec: DecisionSpec): Record<string, number> {
  const counts = spec.labels.map((l) => spec.perLabel[l.id]?.train ?? 0);
  const largest = Math.max(0, ...counts);
  return Object.fromEntries(
    spec.labels.map((l, i) => {
      const n = counts[i]!;
      return [l.id, n > 0 ? Math.min(BALANCE_COPIES_MAX, Math.max(1, Math.ceil(largest / (BALANCE_RATIO * n)))) : 0];
    }),
  );
}

/**
 * The train part's layout: one slot per training rendering, {row, copy}. A row of label L has epochs x
 * balanceCopies[L] renderings, copies 0 on, each seeded `${spec.seed}:${row}:${copy}` (trainRendering). Laid out in
 * rounds: round c holds every row with more than c renderings, in an order seeded by the round, so labels are mixed on
 * every page and a trainer that doesn't shuffle still sees them mixed.
 */
export function trainLayout(spec: DecisionSpec, epochs: number): Array<{ row: number; copy: number }> {
  const copies = balanceCopies(spec);
  const ranges = splitRanges(spec, "train").map((r) => ({ ...r, renderings: epochs * (copies[r.id] ?? 0) }));
  const rounds = Math.max(0, ...ranges.map((r) => r.renderings));
  const out: Array<{ row: number; copy: number }> = [];
  for (let copy = 0; copy < rounds; copy++) {
    const rows = ranges.filter((r) => r.renderings > copy).flatMap((r) => Array.from({ length: r.to - r.from }, (_, k) => r.from + k));
    for (const row of shuffled(rows, seededRandom(`${spec.seed}|round|${copy}`))) out.push({ row, copy });
  }
  return out;
}

/** The seed of one training rendering: the spec's seed, the train row and the copy, so every copy gets its own order. */
export function trainSeed(spec: DecisionSpec, row: number, copy: number): string {
  return `${spec.seed}:${row}:${copy}`;
}

/**
 * Dev or test rows as decisionItems lays them out, with the real labels (from the spec) and a stand-in input: the
 * layout depends only on the rows' labels, so a page knows which rows it needs before reading any text.
 */
function placeholderRows(spec: DecisionSpec, split: "dev" | "test", real?: ReadonlyMap<number, DecisionRow>): DecisionRow[] {
  return splitLabels(spec, split).map((label, i) => real?.get(i) ?? { input: "-", label });
}

/** Renderings (train) or items (dev and test) in a part. */
export function decisionPartSize(spec: DecisionSpec, split: DecisionSplit, epochs: number): number {
  if (split === "train") {
    const copies = balanceCopies(spec);
    return spec.labels.reduce((sum, l) => sum + (spec.perLabel[l.id]?.train ?? 0) * epochs * (copies[l.id] ?? 0), 0);
  }
  return decisionItems({ question: spec.question, labels: spec.labels, rows: placeholderRows(spec, split), part: split }).length;
}

/** Pages a decide job reads in all: train, dev and eval, DECIDE_PAGE_SIZE renderings each. */
export function decisionPageCount(spec: DecisionSpec, epochs: number): number {
  return (["train", "dev", "test"] as const).reduce((sum, s) => sum + Math.ceil(decisionPartSize(spec, s, epochs) / DECIDE_PAGE_SIZE), 0);
}

/** The rows of a split one page renders, ascending: what the route reads from the database for it. */
export function decisionPageRows(spec: DecisionSpec, split: DecisionSplit, epochs: number, page: number): number[] {
  const from = page * DECIDE_PAGE_SIZE;
  const to = from + DECIDE_PAGE_SIZE;
  const rows =
    split === "train"
      ? trainLayout(spec, epochs).slice(from, to).map((s) => s.row)
      : decisionItems({ question: spec.question, labels: spec.labels, rows: placeholderRows(spec, split), part: split })
          .slice(from, to)
          .map((item) => item.row);
  return [...new Set(rows)].sort((a, b) => a - b);
}

/**
 * One page of a part, from the rows it needs (decisionPageRows, read by index). part=train: TrainExample rows, the
 * shape glimmer-lora trains on, the assistant message one letter. dev and test: DecideItems with no answer, laid out by
 * decisionItems, the layout scoring reads back, so an index means the same thing to both. Throws when a row is missing
 * or has a label other than the spec says, since then the stored rows and the spec disagree.
 */
export function decisionPage(
  spec: DecisionSpec,
  split: DecisionSplit,
  epochs: number,
  page: number,
  rows: ReadonlyMap<number, DecisionRow>,
): { items: TrainExample[] | DecideItem[]; total: number; nextPage: number | null } {
  const labels = splitLabels(spec, split);
  for (const row of decisionPageRows(spec, split, epochs, page)) {
    const r = rows.get(row);
    if (!r || r.label !== labels[row]) throw new Error(`The dataset's ${split} row ${row} doesn't match its spec.`);
  }
  const from = page * DECIDE_PAGE_SIZE;
  const to = from + DECIDE_PAGE_SIZE;
  const total = decisionPartSize(spec, split, epochs);
  const nextPage = to < total ? page + 1 : null;
  if (split === "train") {
    const items = trainLayout(spec, epochs)
      .slice(from, to)
      .map(({ row, copy }) => {
        const r = rows.get(row)!;
        return trainExample(trainRendering({ state: r.input, question: spec.question, labels: spec.labels, answer: r.label, seed: trainSeed(spec, row, copy) }));
      });
    return { items, total, nextPage };
  }
  const items = decisionItems({ question: spec.question, labels: spec.labels, rows: placeholderRows(spec, split, rows), part: split })
    .slice(from, to)
    .map((item) => decideItem(item.index, item.row, item.group, item.rendering));
  return { items, total, nextPage };
}

/** The first `n` rows of each label in a split, as indexes: the dataset page's samples. */
export function sampleRowIndexes(spec: DecisionSpec, split: DecisionSplit, n: number): number[] {
  return splitRanges(spec, split).flatMap((r) => Array.from({ length: Math.max(0, Math.min(n, r.to - r.from)) }, (_, k) => r.from + k));
}
