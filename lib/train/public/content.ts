/**
 * What a run may be trained to do, checked before any example is written or any GPU starts (open-train.md "Content"):
 *
 * - checkTrainingTask: one Muse Wonder call (TEST_MODEL, Spark 1.3 Contributor, stands in off production) with the
 *   brief writer's REFUSE_WHEN, plus no real people's data and one narrow skill.
 * - piiFindings: a pattern scan of the task and the rows for emails, phone numbers, card numbers, government ids and
 *   street addresses. A finding says what kind and where, never the matched text, so nothing found can reach a log.
 * - VISITOR_TASK_RULES: the fixed rules every visitor task ends with (withVisitorRules).
 *
 * contentFindingsFor replaces the TODO(open-train U3) seam in lib/train/tune/plan.ts. That file is being edited by the
 * composer workflow, so it isn't changed here: the wiring step calls contentFindingsFor(caller, {note, rows}) in
 * app/api/train/plan/route.ts in place of plan.ts's contentFindings, after the route's per-caller rate limit (so an
 * anonymous caller can't run the scan unthrottled), and deletes the stub. It scans visitors only, so with
 * PUBLIC_TRAINING off nobody's plan changes. plan.ts's TODO expected the scan for everyone: if the owner wants admins
 * scanned too, call contentFindings instead and record that in open-train.md.
 */
import { z } from "zod";
import { textPart } from "@/lib/brief/media";
import { cleanStrings } from "@/lib/brief/normalize";
import { respondStructured, type StructuredOptions, type StructuredResult } from "@/lib/brief/structured";
import { testModel } from "@/lib/env";
import { REFUSE_WHEN } from "@/lib/prompts/brief";
import type { TrainCaller } from "@/lib/train/public/caller";
import { DATASET_TASK_MAX } from "@/lib/train/logic";
import type { ModelUsage } from "@/lib/types";
import { defaultModel } from "@/lib/meta/spark";

/** The row shape the composer sends (lib/train/tune/types.ts ExampleRow). */
export interface ContentRow {
  prompt: string;
  answer: string;
}

// ---------------------------------------------------------------------------------------------------------------
// The model's check

export const CHECK_MODEL = defaultModel();

export function checkModel(): string {
  return testModel() ?? CHECK_MODEL;
}

const CheckSchema = z.object({
  reason: z.string().min(1),
  allowed: z.boolean(),
  refusal: z.string().nullable(),
});

export const DEFAULT_TASK_REFUSAL = "Muse Muse can't train a model for this. Try one narrow skill on made-up examples.";

export function checkInstructions(): string {
  return `You check what someone wants a small model fine-tuned to do on Muse Muse, before any example is written or any GPU starts. Anyone can ask, without signing in.

Refuse (allowed false) when any of these is true
- The task involves ${REFUSE_WHEN}.
- It would train on real people's data: names with contact details, health, money, school or work records, private messages, or anything about a specific person who isn't a public figure. Made-up people and examples are fine.
- It isn't one narrow skill. A general assistant, "answer anything", several unrelated jobs, or a copy of another model is not narrow. One kind of question for one kind of user is.

Allow everything else. Teaching a model to talk about a public topic is fine.

refusal is null when allowed is true. Otherwise it tells the person why in one or two plain sentences and suggests a narrower, safe version when there is one. Don't use em dashes.`;
}

const CHECK_ROWS = 20;
const ROW_CHARS = 300;

function checkText(task: string, rows: readonly ContentRow[]): string {
  const shown = rows.slice(0, CHECK_ROWS).map((r, i) => `${i + 1}. ${r.prompt.slice(0, ROW_CHARS)} => ${r.answer.slice(0, ROW_CHARS)}`);
  const own = shown.length ? `\n\nSome of their own examples (${rows.length} in all):\n${shown.join("\n")}` : "";
  return `What the model should do:\n${task.slice(0, DATASET_TASK_MAX)}${own}`;
}

export interface CheckDeps {
  respond: <T>(opts: StructuredOptions<T>) => Promise<StructuredResult<T>>;
  model: () => string;
}

const defaultDeps: CheckDeps = { respond: respondStructured, model: checkModel };

export type TaskCheck = { ok: true; usage: ModelUsage[] } | { ok: false; refusal: string; usage: ModelUsage[] };

/**
 * One structured call on the check model. Throws StructuredOutputError (with its usage) when neither attempt matched the
 * schema, so a task is never passed unchecked.
 */
export async function checkTrainingTask(
  input: { task: string; rows?: readonly ContentRow[] },
  deps: CheckDeps = defaultDeps,
): Promise<TaskCheck> {
  const result = await deps.respond({
    model: deps.model(),
    instructions: checkInstructions(),
    content: [textPart(checkText(input.task, input.rows ?? []))],
    schema: CheckSchema,
    schemaName: "training_task_check",
    effort: "low",
    normalize: (raw) => cleanStrings(raw),
  });
  if (result.data.allowed) return { ok: true, usage: result.usage };
  return { ok: false, refusal: result.data.refusal?.trim() || DEFAULT_TASK_REFUSAL, usage: result.usage };
}

// ---------------------------------------------------------------------------------------------------------------
// The pattern scan

export type PiiKind = "email" | "phone" | "card" | "government_id" | "street_address";

export interface PiiFinding {
  kind: PiiKind;
  /** "task", or a row (1-based) and which side of it. */
  where: "task" | { row: number; field: "prompt" | "answer" };
  /** How many matches there. Never the matches themselves. */
  count: number;
}

/** Domains kept for examples (RFC 2606, 6761), so made-up addresses like name@example.com pass. */
const EXAMPLE_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i;
/**
 * The local part starts where the run of address characters starts and is at most 64 long, so a long run with no "@"
 * is tried once, not from every position (unanchored, 100,000 digits took about 5 seconds).
 */
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,})/g;

/** Separated phone numbers: (512) 555-0134, 512-555-0134, 512.555.0134, +44 20 7946 0958. */
const PHONE = /(?<![\w+])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}(?![\w])/g;
/**
 * Unseparated: +442079460958 (a + and 10 to 15 digits), or 5128675309 shaped like a North American number (area code
 * and exchange not starting 0 or 1, an optional leading 1). Other runs of 10 digits, such as most order numbers, pass.
 */
const PHONE_RUN = /(?<![\w+])(?:\+\d{10,15}|1?[2-9]\d{2}[2-9]\d{6})(?!\w)/g;
/** 555-0100 to 555-0199 are set aside for fiction: the last seven digits. */
const FICTIONAL_PHONE = /55501\d\d$/;

const CARD = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;

/** US SSN (not 000, 666 or 9xx; group not 00; serial not 0000), UK National Insurance, and ids named as such. */
const SSN = /(?<!\d)(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?!\d)/g;
const NINO = /\b(?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g;
const NAMED_ID =
  /\b(?:passport|driver'?s? licen[cs]e|national id|id card|social security|tax id|NHS number)(?:\s+(?:no\.?|number|#))?\s*[:#]?\s*(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{5,14}\b/gi;
/** SSN and TIN only in capitals: "a tin of 100000" is a can. */
const NAMED_ID_ACRONYM = /\b(?:SSN|TIN)(?:\s+(?:[Nn]o\.?|[Nn]umber|#))?\s*[:#]?\s*(?=[A-Za-z0-9-]*\d)[A-Za-z0-9][A-Za-z0-9-]{5,14}\b/g;

/** 1600 Pennsylvania Avenue, 221B Baker Street, 42 Elm St: a house number (and letter), capitalized words, a suffix. */
const STREET =
  /\b\d{1,6}[A-Z]?\s+(?:[A-Z][A-Za-z'.-]*\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Terrace|Parkway|Pkwy|Highway|Hwy|Way)\b\.?/g;
/**
 * In any case, "123 main street": one or two words before street, avenue or boulevard only. The short suffixes in lower
 * case ("a 5 minute drive", "a 2 lane road") are ordinary words too often.
 */
const STREET_ANY_CASE = /\b\d{1,5}[A-Za-z]?\s+(?:[A-Za-z][A-Za-z'.-]*\s+){1,2}(?:street|avenue|boulevard)\b/gi;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function countMatches(text: string, re: RegExp, keep: (m: RegExpMatchArray) => boolean = () => true): number {
  let n = 0;
  for (const m of text.matchAll(re)) if (keep(m)) n++;
  return n;
}

/** Matches of any of `res`, counting overlapping ones once ("SSN 123-45-6789" is one id, not two). */
function distinctSpans(text: string, res: RegExp[]): number {
  const spans = res.flatMap((re) => [...text.matchAll(re)].map((m) => [m.index!, m.index! + m[0].length] as const)).sort((a, b) => a[0] - b[0]);
  let n = 0;
  let end = -1;
  for (const [a, b] of spans) {
    if (a >= end) n++;
    end = Math.max(end, b);
  }
  return n;
}

/** How many of each kind one text has. Pure; the text never leaves this function. */
export function piiCounts(text: string): Partial<Record<PiiKind, number>> {
  const out: Partial<Record<PiiKind, number>> = {};
  const add = (kind: PiiKind, n: number) => {
    if (n > 0) out[kind] = n;
  };
  add("email", countMatches(text, EMAIL, (m) => !EXAMPLE_DOMAIN.test(m[1])));
  // A long run of digits (a card number, or an order number shaped like one) also looks like a phone number, so phone
  // matches inside one are left out.
  const runs: Array<[number, number]> = [];
  add(
    "card",
    countMatches(text, CARD, (m) => {
      runs.push([m.index!, m.index! + m[0].length]);
      const digits = m[0].replace(/\D/g, "");
      return digits.length >= 13 && digits.length <= 19 && !/^(\d)\1+$/.test(digits) && luhn(digits);
    }),
  );
  const inCard = (m: RegExpMatchArray) => runs.some(([a, b]) => m.index! >= a && m.index! < b);
  const realPhone = (m: RegExpMatchArray) => {
    const digits = m[0].replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 15 && !FICTIONAL_PHONE.test(digits) && !inCard(m);
  };
  add("phone", countMatches(text, PHONE, realPhone) + countMatches(text, PHONE_RUN, realPhone));
  add("government_id", distinctSpans(text, [SSN, NINO, NAMED_ID, NAMED_ID_ACRONYM]));
  add("street_address", distinctSpans(text, [STREET, STREET_ANY_CASE]));
  return out;
}

/** Every kind found in the task and in each row's prompt and answer, with where and how many. */
export function piiFindings(input: { task?: string; rows?: readonly ContentRow[] }): PiiFinding[] {
  const found: PiiFinding[] = [];
  const scan = (text: string, where: PiiFinding["where"]) => {
    for (const [kind, count] of Object.entries(piiCounts(text)) as Array<[PiiKind, number]>) found.push({ kind, where, count });
  };
  if (input.task) scan(input.task, "task");
  (input.rows ?? []).forEach((r, i) => {
    scan(r.prompt, { row: i + 1, field: "prompt" });
    scan(r.answer, { row: i + 1, field: "answer" });
  });
  return found;
}

const KIND_WORDS: Record<PiiKind, string> = {
  email: "an email address",
  phone: "a phone number",
  card: "a card number",
  government_id: "a government id number",
  street_address: "a street address",
};
const ROWS_SHOWN = 3;

/** One plain sentence per kind found, naming where (the task, or up to three rows). Never the matched text. */
export function piiSentences(findings: readonly PiiFinding[]): string[] {
  const byKind = new Map<PiiKind, { task: boolean; rows: Set<number> }>();
  for (const f of findings) {
    const entry = byKind.get(f.kind) ?? { task: false, rows: new Set<number>() };
    if (f.where === "task") entry.task = true;
    else entry.rows.add(f.where.row);
    byKind.set(f.kind, entry);
  }
  const out: string[] = [];
  for (const [kind, { task, rows }] of byKind) {
    const list = [...rows].sort((a, b) => a - b);
    const shown = list.slice(0, ROWS_SHOWN).join(", ") + (list.length > ROWS_SHOWN ? ` and ${list.length - ROWS_SHOWN} more` : "");
    const places = [task ? "the task" : "", list.length ? `${list.length === 1 ? "row" : "rows"} ${shown}` : ""].filter(Boolean).join(" and ");
    out.push(`${places[0].toUpperCase()}${places.slice(1)} ${(task && list.length > 0) || list.length > 1 ? "have" : "has"} what looks like ${KIND_WORDS[kind]}. Take out real people's details, or use made-up ones.`);
  }
  return out;
}

/** What a log may say about findings: the kinds and how many places, nothing else. */
export function piiLogLine(findings: readonly PiiFinding[]): string {
  const kinds = [...new Set(findings.map((f) => f.kind))].sort();
  return `[train/public] pii scan: ${findings.length} place(s), kinds ${kinds.join(",") || "none"}`;
}

/**
 * The plan route's content check (lib/train/tune/plan.ts contentFindings has the same shape): the person's sentences
 * for whatever the scan found in the note and rows, empty when nothing was. Any finding refuses the plan with a 422.
 */
export function contentFindings(input: { note: string; rows: readonly ContentRow[] }): string[] {
  const findings = piiFindings({ task: input.note, rows: input.rows });
  if (findings.length) console.warn(piiLogLine(findings));
  return piiSentences(findings);
}

/**
 * contentFindings for a visitor, nothing for an admin or automation: what the plan route calls (see the header), so
 * PUBLIC_TRAINING off, where every caller is an admin, changes nobody's plan.
 */
export function contentFindingsFor(caller: Pick<TrainCaller, "kind">, input: { note: string; rows: readonly ContentRow[] }): string[] {
  return caller.kind === "visitor" ? contentFindings(input) : [];
}

// ---------------------------------------------------------------------------------------------------------------
// The fixed rules

/** Every visitor task ends with these, so the examples written and the model trained keep to them. */
export const VISITOR_TASK_RULES = `

Rules for this model, always: keep to the task above and politely decline anything else. Never ask for, repeat or keep personal details such as email addresses, phone numbers, street addresses, card or id numbers. Never claim to be a person, a real company, Meta or Muse Muse. Keep every answer safe for a general audience. Use made-up names and details in every example.`;

/** The task with the rules at its end, within `max` characters (the task is cut, never the rules). Adds them once. */
export function withVisitorRules(task: string, max: number = DATASET_TASK_MAX): string {
  const base = task.endsWith(VISITOR_TASK_RULES) ? task.slice(0, -VISITOR_TASK_RULES.length) : task;
  return base.slice(0, Math.max(0, max - VISITOR_TASK_RULES.length)).trimEnd() + VISITOR_TASK_RULES;
}
