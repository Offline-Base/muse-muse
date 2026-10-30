import { estimateCost, costExtrasOf } from "@/lib/docs/client/cost";
import { sampleById } from "@/lib/docs/media/samples";

/**
 * Flows: one pattern from a protocol page as a short list of real requests, where each step is built from the replies
 * before it (the id of the response to chain from, the reasoning item to replay, the call id to answer). The docs
 * pages teach sequences (create, then retrieve, then delete; call, then send the result back), and a flow runs the
 * sequence for real so the reader sees what each request carries and what each reply says. Everything here is pure
 * data and functions, so the step templates and the checks are tested without React or the network; FlowRunner.tsx
 * sends the requests.
 *
 * A step's path and body may hold templates:
 *   "{{model}}"                    the model picked in the flow's menu
 *   "{{vars.question}}"            a value the reader can edit above the steps
 *   "{{turn1.id}}"                 a field of an earlier step's reply (see `lookup` for the path syntax)
 *   "{{turn1.$text}}"              that reply's text; "{{turn1.$status}}" its HTTP status
 *   "{{sample:field-report}}"      a docs sample as a data URL; "{{sample64:cat-sofa}}" as bare base64
 * A string that is only a template becomes the value itself (an object, an array, a number), and inside an array
 * { "$spread": "turn1.output" } splices in every item of an earlier array.
 */

export type FlowMethod = "GET" | "POST" | "DELETE";

/** A value the reader can change before running, used in templates as {{vars.name}}. */
export interface FlowVar {
  name: string;
  label: string;
  value: string;
  multiline?: boolean;
}

/** One thing the page says about a reply, checked against the real one. */
export interface FlowCheck {
  /** Where to look in the reply, in `lookup` syntax: "status", "output[type=function_call].name". */
  path: string;
  /** What the page says, in a few words: "status is cancelled". */
  label: string;
  /** The value equals this. */
  equals?: unknown;
  /** The value exists and isn't null (true), or is missing or null (false). */
  present?: boolean;
  /** The value is an empty array or string. */
  empty?: boolean;
  /** The value is one of these. */
  oneOf?: unknown[];
  /**
   * The value is a string this regular expression finds a match in, ignoring case: an error's param or message
   * naming the field it's about, so a 400 for another reason doesn't pass as the documented one.
   */
  matches?: string;
}

export interface FlowExpect {
  /** The HTTP status the page documents for this request. Unset means any 2xx. */
  status?: number | number[];
  /** Event types the stream should carry. */
  events?: string[];
  checks?: FlowCheck[];
}

/** Repeat a GET until a field reaches one of the values, such as a background response's status. */
export interface FlowPoll {
  path: string;
  until: string[];
  everyMs?: number;
  tries?: number;
}

export interface FlowStep {
  /** Unique in the flow; later steps name it in templates. */
  id: string;
  title: string;
  /** Default POST when there is a body, else GET. */
  method?: FlowMethod;
  /** Meta's path without /v1/, templates allowed: "responses/{{turn1.id}}". */
  path: string;
  body?: unknown;
  /** Read a POST reply as server-sent events. */
  stream?: boolean;
  /** What to look for, from the page. */
  note?: string;
  expect?: FlowExpect;
  poll?: FlowPoll;
  /** A check that stands alone: Run all goes on past it when it fails, and it never waits on another step. */
  independent?: boolean;
  /** Wait this long before sending. */
  waitMs?: number;
  /** Reply fields to list under the step, in `lookup` syntax. */
  show?: string[];
  /**
   * Statuses to try again on, such as the 404 a read can get right after a create while storage catches up (the
   * Responses guide: "retry once or twice with a short backoff"). Server errors (5xx) are always retried once.
   */
  retry?: { statuses: number[]; tries?: number; delayMs?: number };
  /**
   * Clean-up after the demo (deleting what it created). Like the documented-error checks, it isn't recorded for the
   * copy prompt's "Include what I just ran", so the request recorded last is the one the page is about.
   */
  cleanup?: boolean;
}

/** Statuses a step tries once more by itself: Meta's transient server errors. */
export const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);

/** The longest rate-limit wait a step sits out by itself: the docs' per-minute windows reset within a minute. */
export const RATE_WAIT_MAX_SEC = 65;

/**
 * How long to wait out a 429 before trying once more: its retry-after plus a moment, when that is within a minute
 * (the per-minute limits, a model busy for every reader, too many calls at once). Null when waiting won't help soon:
 * a daily limit or a spent budget, whose retry-after runs to midnight UTC.
 */
export function rateLimitWaitMs(status: number, error?: { code?: string; retryAfterSec?: number } | null): number | null {
  if (status !== 429 || error?.code === "ip_budget") return null;
  const after = error?.retryAfterSec;
  if (!after || after > RATE_WAIT_MAX_SEC) return null;
  return Math.ceil(after * 1000) + 500;
}

/** Retries a step has left: listed statuses, Meta's 5xx errors, and one rate-limit wait. */
export interface RetriesLeft {
  listed: number;
  transient: number;
  rate?: number;
}

/**
 * Whether to send a step again after a reply with this status, given the retries left. A status the step expects
 * (a documented error) is never retried. A 429 with a short retry-after is waited out once ("rate").
 */
export function retryReason(
  step: FlowStep,
  status: number,
  left: RetriesLeft,
  error?: { code?: string; retryAfterSec?: number } | null,
): "listed" | "transient" | "rate" | null {
  if ((expectedStatuses(step) ?? []).includes(status)) return null;
  if (step.retry?.statuses.includes(status) && left.listed > 0) return "listed";
  if (TRANSIENT_STATUSES.has(status) && left.transient > 0) return "transient";
  if ((left.rate ?? 0) > 0 && rateLimitWaitMs(status, error) !== null) return "rate";
  return null;
}

export interface FlowSpec {
  /** A line above the steps. */
  intro?: string;
  vars?: FlowVar[];
  /** The model {{model}} stands for. Default muse-spark-1.3-contributor. */
  model?: string;
  /** Limit the model menu, such as Spark only for background runs. */
  models?: string[];
  /**
   * Run all waits this long between steps. Every call counts toward the live docs' per-minute limits (rejected ones
   * too), so a list of quick checks is spread out rather than sent in a burst.
   */
  paceMs?: number;
  steps: FlowStep[];
}

/**
 * True for a step whose request isn't recorded for the copy prompt: a clean-up, or a documented-error check (every
 * status it expects is an error). A step that takes a 200 or a 400, such as a late cancel, is a real request: kept.
 */
export function skipsRecord(step: FlowStep): boolean {
  const expected = expectedStatuses(step);
  return !!step.cleanup || (!!expected?.length && expected.every((s) => s >= 400));
}

/** What a finished step leaves for the steps after it. */
export interface StepReply {
  status: number;
  ok: boolean;
  /** The JSON body, or a stream's final object as its collector rebuilt it. */
  json: unknown;
  /** The reply's text, for the text protocols. */
  text: string;
  /** The event types a stream carried, each once, in the order they first came. */
  events: string[];
}

export interface FlowContext {
  model: string;
  vars: Readonly<Record<string, string>>;
  steps: Readonly<Record<string, StepReply>>;
  /** Docs samples as data URLs, by sample id, fetched before the step resolves. */
  samples?: Readonly<Record<string, string>>;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// ---------- Paths ----------

type Segment = { key: string; picks: Pick[] };
type Pick = { index: number } | { where: [string, string] };

/** Splits "a.b[type=x.y].c" at the dots outside brackets. */
function splitPath(path: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of path) {
    if (ch === "[") depth++;
    if (ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "." && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

function parseSegment(part: string): Segment | null {
  const m = /^([^[\]]*)((?:\[[^\]]*\])*)$/.exec(part);
  if (!m) return null;
  const picks: Pick[] = [];
  for (const b of m[2].matchAll(/\[([^\]]*)\]/g)) {
    const inner = b[1];
    if (/^-?\d+$/.test(inner)) picks.push({ index: Number(inner) });
    else if (inner.includes("=")) {
      const at = inner.indexOf("=");
      picks.push({ where: [inner.slice(0, at), inner.slice(at + 1)] });
    } else return null;
  }
  return { key: m[1], picks };
}

/**
 * A value inside a reply. Dots step into objects, [2] picks an array item ([-1] the last), and [type=message] the
 * first item whose field equals that text: "output[type=function_call].call_id", "choices[0].message.tool_calls".
 * Undefined when any step is missing.
 */
export function lookup(value: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (!trimmed) return value;
  let current: unknown = value;
  for (const part of splitPath(trimmed)) {
    const seg = parseSegment(part);
    if (!seg) return undefined;
    if (seg.key) {
      if (!isObject(current)) return undefined;
      current = current[seg.key];
    }
    for (const pick of seg.picks) {
      if (!Array.isArray(current)) return undefined;
      if ("index" in pick) current = current[pick.index < 0 ? current.length + pick.index : pick.index];
      else {
        const [k, v] = pick.where;
        current = current.find((item) => isObject(item) && String(item[k]) === v);
      }
      if (current === undefined) return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

// ---------- Templates ----------

const WHOLE = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const PART = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Thrown inside resolution when an expression has no value yet; `resolveTemplate` turns it into a result. */
class Missing extends Error {
  constructor(readonly expr: string) {
    super(`Missing ${expr}`);
  }
}

/** The value an expression stands for, or undefined when it has none yet. */
export function evalExpr(expr: string, ctx: FlowContext): unknown {
  const e = expr.trim();
  if (e === "model") return ctx.model;
  if (e.startsWith("vars.")) return ctx.vars[e.slice(5)];
  if (e.startsWith("sample:")) return ctx.samples?.[e.slice(7)];
  if (e.startsWith("sample64:")) {
    const url = ctx.samples?.[e.slice(9)];
    return url === undefined ? undefined : url.slice(url.indexOf(",") + 1);
  }
  const dot = e.indexOf(".");
  const stepId = dot < 0 ? e : e.slice(0, dot);
  const rest = dot < 0 ? "" : e.slice(dot + 1);
  const reply = ctx.steps[stepId];
  if (!reply) return undefined;
  if (rest === "$status") return reply.status;
  if (rest === "$text") return reply.text || undefined;
  if (rest === "$ok") return reply.ok;
  return lookup(reply.json, rest);
}

function resolveValue(value: unknown, ctx: FlowContext): unknown {
  if (typeof value === "string") {
    const whole = WHOLE.exec(value);
    if (whole) {
      const v = evalExpr(whole[1], ctx);
      if (v === undefined) throw new Missing(whole[1]);
      return v;
    }
    if (!value.includes("{{")) return value;
    return value.replace(PART, (_m, expr: string) => {
      const v = evalExpr(expr, ctx);
      if (v === undefined) throw new Missing(expr);
      return typeof v === "string" ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      if (isObject(item) && typeof item.$spread === "string" && Object.keys(item).length === 1) {
        const v = evalExpr(item.$spread, ctx);
        if (v === undefined) throw new Missing(item.$spread);
        if (Array.isArray(v)) out.push(...v);
        else out.push(v);
      } else out.push(resolveValue(item, ctx));
    }
    return out;
  }
  if (isObject(value)) {
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, ctx);
    return out;
  }
  return value;
}

export type Resolved<T> = { ok: true; value: T } | { ok: false; missing: string };

/** Fills a step's templates from the context. A template with no value yet names what's missing instead. */
export function resolveTemplate<T = unknown>(value: T, ctx: FlowContext): Resolved<T> {
  try {
    return { ok: true, value: resolveValue(value, ctx) as T };
  } catch (err) {
    if (err instanceof Missing) return { ok: false, missing: err.expr };
    throw err;
  }
}

/** The id prefix a placeholder borrows, so a stand-in looks like the id it stands for: resp_, call_, toolu_. */
function idPrefix(field: string, path: string): string {
  if (/call_id$/.test(field) || /tool_calls/.test(field)) return "call";
  if (/tool_use/.test(field)) return "toolu";
  if (/reasoning/.test(field)) return "rs";
  if (field === "id") return path.startsWith("chat/") ? "chatcmpl" : path.startsWith("messages") ? "msg" : "resp";
  return "id";
}

/**
 * What a value from an earlier reply looks like before that reply exists: "resp_from_step_1" for an id, so code
 * built from it reads like real code, and "<content from step 2>" for anything bigger.
 */
function standIn(expr: string, steps: readonly FlowStep[]): string {
  const dot = expr.indexOf(".");
  const id = dot < 0 ? expr : expr.slice(0, dot);
  const field = dot < 0 ? "" : expr.slice(dot + 1);
  const at = steps.findIndex((s) => s.id === id);
  const n = at + 1;
  if (at < 0) return `<${expr}>`;
  if (!field || field === "$text") return `<the reply from step ${n}>`;
  if (field === "$status") return `<the status from step ${n}>`;
  if (/(^|\.)(call_)?id$|\]\.id$/.test(field)) return `${idPrefix(field, steps[at].path)}_from_step_${n}`;
  return `<${field} from step ${n}>`;
}

/** A docs sample as a short data URL with its own type, for showing where the file goes. */
function sampleStandIn(id: string, bare: boolean): string {
  if (bare) return "<BASE64>";
  return `data:${sampleById(id)?.mime ?? "application/octet-stream"};base64,<BASE64>`;
}

/**
 * A step's path or body as it will go out, for showing before it runs (its request body, its code). The model, the
 * vars and the samples are known up front; a value from an earlier step's reply is a readable stand-in until that
 * step has run (resp_from_step_1, "<output items from step 1>"). `pending` says whether any stand-in is left.
 */
export function previewTemplate<T>(value: T, ctx: FlowContext, steps: readonly FlowStep[]): { value: T; pending: boolean } {
  let pending = false;
  const one = (expr: string): unknown => {
    const v = evalExpr(expr, ctx);
    if (v !== undefined) return v;
    const e = expr.trim();
    if (e.startsWith("sample:")) return sampleStandIn(e.slice(7), false);
    if (e.startsWith("sample64:")) return sampleStandIn(e.slice(9), true);
    if (e.startsWith("vars.")) return "";
    pending = true;
    return standIn(e, steps);
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const whole = WHOLE.exec(v);
      if (whole) return one(whole[1]);
      return v.includes("{{") ? v.replace(PART, (_m, expr: string) => {
        const got = one(expr);
        return typeof got === "string" ? got : JSON.stringify(got);
      }) : v;
    }
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const item of v) {
        if (isObject(item) && typeof item.$spread === "string" && Object.keys(item).length === 1) {
          const got = evalExpr(item.$spread, ctx);
          if (Array.isArray(got)) out.push(...got);
          else if (got !== undefined) out.push(got);
          else {
            pending = true;
            const s = standIn(item.$spread.trim(), steps);
            out.push(s.startsWith("<") ? `<each item of ${s.slice(1)}` : s);
          }
        } else out.push(walk(item));
      }
      return out;
    }
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(value) as T;
  return { value: out, pending };
}

const STAND_IN = /\b[a-z]+_from_step_\d+\b|<[^<>]+ from step \d+>/;

/** The first stand-in a preview holds ("resp_from_step_1"), to name in the line that explains them. */
export function firstStandIn(value: unknown): string | null {
  if (typeof value === "string") return STAND_IN.exec(value)?.[0] ?? null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const got = firstStandIn(v);
      if (got) return got;
    }
    return null;
  }
  if (isObject(value)) return firstStandIn(Object.values(value));
  return null;
}

/** Every expression a value's templates use, in order, each once. */
export function templateExprs(value: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") for (const m of v.matchAll(PART)) out.add(m[1].trim());
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isObject(v)) {
      if (typeof v.$spread === "string" && Object.keys(v).length === 1) out.add(v.$spread.trim());
      Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return [...out];
}

/** The docs samples a step names, so they can be fetched before it resolves. */
export function sampleRefs(step: FlowStep): string[] {
  return templateExprs([step.path, step.body])
    .filter((e) => e.startsWith("sample:") || e.startsWith("sample64:"))
    .map((e) => e.slice(e.indexOf(":") + 1))
    .filter((id, i, all) => all.indexOf(id) === i);
}

/** The earlier steps a step reads from. */
export function stepRefs(step: FlowStep, ids: readonly string[]): string[] {
  const known = new Set(ids);
  return templateExprs([step.path, step.body])
    .map((e) => e.split(".")[0])
    .filter((id, i, all) => known.has(id) && all.indexOf(id) === i);
}

/** What a missing expression means to a reader: "step 2's reply has no output[type=function_call].call_id". */
export function describeMissing(expr: string, steps: readonly FlowStep[]): string {
  if (expr === "model") return "No model is picked.";
  if (expr.startsWith("vars.")) return `Fill in ${expr.slice(5)} first.`;
  if (expr.startsWith("sample")) return "The sample file didn't load. Try again.";
  const dot = expr.indexOf(".");
  const id = dot < 0 ? expr : expr.slice(0, dot);
  const at = steps.findIndex((s) => s.id === id);
  if (at < 0) return `Nothing in this flow is called ${id}.`;
  const field = dot < 0 ? "" : expr.slice(dot + 1);
  return field
    ? `This step needs ${field} from step ${at + 1}'s reply, and that reply doesn't have it.`
    : `This step needs step ${at + 1}'s reply. Run step ${at + 1} first.`;
}

export function methodOf(step: FlowStep): FlowMethod {
  return step.method ?? (step.body !== undefined ? "POST" : "GET");
}

// ---------- Checks ----------

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A value in a few words for a check line: a short string, a number, "an array of 3", "missing". */
export function describeValue(v: unknown, max = 60): string {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  if (typeof v === "string") {
    const t = v.replace(/\s+/g, " ");
    return t.length > max ? `"${t.slice(0, max - 3)}..." (${v.length} characters)` : `"${t}"`;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.length ? `an array of ${v.length}` : "an empty array";
  if (isObject(v)) {
    const keys = Object.keys(v);
    return keys.length ? `an object (${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", ..." : ""})` : "an empty object";
  }
  return String(v);
}

/** A check's pattern as a case-insensitive RegExp; a pattern that doesn't compile matches its own text literally. */
function safeRegex(source: string): RegExp {
  try {
    return new RegExp(source, "i");
  } catch {
    return new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

export interface CheckResult {
  label: string;
  pass: boolean;
  actual: string;
}

function checkOne(c: FlowCheck, json: unknown): CheckResult {
  const v = lookup(json, c.path);
  let pass = true;
  if (c.equals !== undefined) pass = pass && same(v, c.equals);
  if (c.present !== undefined) pass = pass && (c.present ? v !== undefined && v !== null : v === undefined || v === null);
  if (c.empty !== undefined) {
    const isEmpty = (Array.isArray(v) && v.length === 0) || v === "";
    pass = pass && (c.empty ? isEmpty : v !== undefined && !isEmpty);
  }
  if (c.oneOf) pass = pass && c.oneOf.some((o) => same(o, v));
  if (c.matches !== undefined) pass = pass && typeof v === "string" && safeRegex(c.matches).test(v);
  return { label: c.label, pass, actual: `${c.path}: ${describeValue(v)}` };
}

export interface Verdict {
  /** The status the page documents came back (any 2xx when the step names none). */
  statusOk: boolean;
  /** The documented statuses, or null for "any 2xx". */
  expected: number[] | null;
  checks: CheckResult[];
  events: Array<{ type: string; seen: boolean }>;
  /** Everything the step expects held. */
  pass: boolean;
}

export function expectedStatuses(step: FlowStep): number[] | null {
  const s = step.expect?.status;
  return s === undefined ? null : Array.isArray(s) ? s : [s];
}

/** True when the step expects an error status, such as a documented 400. */
export function expectsError(step: FlowStep): boolean {
  return (expectedStatuses(step) ?? []).some((s) => s >= 400);
}

/** How a reply measures up to what the step (the page) says about it. */
export function verdictOf(step: FlowStep, reply: StepReply): Verdict {
  const expected = expectedStatuses(step);
  const statusOk = expected ? expected.includes(reply.status) : reply.status >= 200 && reply.status < 300;
  const checks = statusOk ? (step.expect?.checks ?? []).map((c) => checkOne(c, reply.json)) : [];
  const events = (step.expect?.events ?? []).map((type) => ({ type, seen: reply.events.includes(type) }));
  return {
    statusOk,
    expected,
    checks,
    events,
    pass: statusOk && checks.every((c) => c.pass) && events.every((e) => e.seen),
  };
}

/** True once a polled GET shows one of the values it waits for. */
export function pollDone(poll: FlowPoll, json: unknown): boolean {
  const v = lookup(json, poll.path);
  return typeof v === "string" && poll.until.includes(v);
}

/** The reply fields a step lists, as label and short value. */
export function shownFields(step: FlowStep, json: unknown): Array<{ path: string; value: string }> {
  return (step.show ?? []).map((path) => ({ path, value: describeValue(lookup(json, path), 80) }));
}

// ---------- Cost ----------

export interface CostedReply {
  /** The model the proxy ran (x-docs-model), when the reply doesn't say. */
  model: string | null;
  json: unknown;
  /** Usage when it isn't json.usage (a stream's collected usage). */
  usage?: unknown;
}

/**
 * What a run of steps cost, estimated from each reply's usage. A response is counted once however many replies name
 * its id (the latest one with usage wins), so polling a background response, reading it back or deleting it doesn't
 * count its tokens twice or wipe them.
 */
export function flowCost(replies: readonly CostedReply[]): { usd: number; calls: number; tokens: number } {
  const byId = new Map<string, { usd: number; tokens: number }>();
  let anon = 0;
  for (const r of replies) {
    const json = isObject(r.json) ? r.json : null;
    const usage = r.usage ?? json?.usage;
    const model = (typeof json?.model === "string" ? json.model : null) ?? r.model;
    const est = usage ? estimateCost(model, usage, costExtrasOf(json)) : null;
    const entry = { usd: est?.usd ?? 0, tokens: est?.tokens?.total ?? 0 };
    const id = typeof json?.id === "string" ? json.id : null;
    const key = id ?? `#${anon++}`;
    if (entry.tokens > 0 || entry.usd > 0 || !byId.has(key)) byId.set(key, entry);
  }
  let usd = 0;
  let tokens = 0;
  for (const e of byId.values()) {
    usd += e.usd;
    tokens += e.tokens;
  }
  return { usd, calls: replies.length, tokens };
}
