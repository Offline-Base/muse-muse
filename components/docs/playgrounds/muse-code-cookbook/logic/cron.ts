/**
 * The scheduling rules from the loop-and-cron recipe, checkable in the browser: a five-field cron expression in the
 * machine's local timezone (minute, hour, day of month, month, day of week), its next fire times, the forward jitter
 * window recurring jobs get (capped at 30 minutes), the seven-day lifetime of a recurring job, and what bounded
 * recovery delivers after Muse Code was closed: at most one catch-up for a recurring job, and a missed one-time job
 * once. `/loop` asks the model for the expression; this module validates whatever it returns.
 */

export interface CronField {
  name: "minute" | "hour" | "day of month" | "month" | "day of week";
  min: number;
  max: number;
  values: number[];
  /** True when the field is `*` (no restriction), which matters for the day-of-month and day-of-week rule. */
  any: boolean;
}

export interface Cron {
  expression: string;
  fields: [CronField, CronField, CronField, CronField, CronField];
}

export type CronParse = { ok: true; cron: Cron } | { ok: false; errors: string[] };

const SPECS: ReadonlyArray<{ name: CronField["name"]; min: number; max: number; names?: string[] }> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] },
  { name: "day of week", min: 0, max: 7, names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] },
];

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function atom(text: string, spec: (typeof SPECS)[number]): number | null {
  const upper = text.toUpperCase();
  const named = spec.names?.indexOf(upper) ?? -1;
  if (named >= 0) return named + (spec.name === "month" ? 1 : 0);
  if (!/^\d+$/.test(text)) return null;
  return Number(text);
}

function parseField(text: string, spec: (typeof SPECS)[number]): { field?: CronField; error?: string } {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) ? Number(stepText) : NaN;
    if (!Number.isInteger(step) || step < 1) return { error: `${spec.name}: "${part}" has a bad step` };
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = spec.min;
      hi = spec.name === "day of week" ? 6 : spec.max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      const x = atom(a, spec);
      const y = atom(b, spec);
      if (x === null || y === null) return { error: `${spec.name}: "${part}" isn't a number or a name` };
      lo = x;
      hi = y;
    } else {
      const x = atom(range, spec);
      if (x === null) return { error: `${spec.name}: "${part}" isn't a number or a name` };
      lo = x;
      hi = stepText === undefined ? x : spec.name === "day of week" ? 6 : spec.max;
    }
    if (lo < spec.min || hi > spec.max || lo > hi) return { error: `${spec.name}: "${part}" is outside ${spec.min} to ${spec.max}` };
    for (let v = lo; v <= hi; v += step) values.add(spec.name === "day of week" && v === 7 ? 0 : v);
  }
  return {
    field: { name: spec.name, min: spec.min, max: spec.max, values: [...values].sort((a, b) => a - b), any: text === "*" },
  };
}

/** Parses a five-field expression. Names (JAN, MON) and 7 for Sunday are accepted. */
export function parseCron(expression: string): CronParse {
  const parts = expression.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) return { ok: false, errors: [`A cron expression has 5 fields (minute hour day-of-month month day-of-week); this one has ${parts.length}.`] };
  const errors: string[] = [];
  const fields: CronField[] = [];
  parts.forEach((p, i) => {
    const r = parseField(p, SPECS[i]);
    if (r.error) errors.push(r.error);
    else fields.push(r.field!);
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, cron: { expression: parts.join(" "), fields: fields as Cron["fields"] } };
}

function dayMatches(cron: Cron, d: Date): boolean {
  const [, , dom, month, dow] = cron.fields;
  if (!month.values.includes(d.getMonth() + 1)) return false;
  const domHit = dom.values.includes(d.getDate());
  const dowHit = dow.values.includes(d.getDay());
  // Standard cron: when both day fields are restricted, either one matching is enough.
  if (!dom.any && !dow.any) return domHit || dowHit;
  if (!dom.any) return domHit;
  if (!dow.any) return dowHit;
  return true;
}

/**
 * The next `count` fire times strictly after `from`, in local time, stopping at `until` when given. Searches up to
 * eight years ahead, so a once-a-year date (or Feb 29) is still found.
 */
export function nextRuns(cron: Cron, from: Date, count: number, until?: Date): Date[] {
  const out: Date[] = [];
  const [minutes, hours] = cron.fields;
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let i = 0; i < 366 * 8 && out.length < count; i++) {
    const d = new Date(day.getFullYear(), day.getMonth(), day.getDate() + i);
    if (until && d > until) break;
    if (!dayMatches(cron, d)) continue;
    for (const h of hours.values) {
      for (const m of minutes.values) {
        const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
        // A local time skipped by a daylight-saving change lands on another hour; it isn't a match.
        if (t.getHours() !== h || t.getMinutes() !== m) continue;
        if (until && t > until) return out;
        if (t > from) out.push(t);
        if (out.length >= count) return out;
      }
    }
  }
  return out;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function clock(h: number, m: number): string {
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${suffix}`;
}

function list(values: string[]): string {
  if (values.length <= 1) return values.join("");
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

function isRange(values: number[]): boolean {
  return values.length > 2 && values.every((v, i) => i === 0 || v === values[i - 1] + 1);
}

/** The expression in words: "At 8:00 AM, every day", "Every 15 minutes", "At 2:00 PM on October 31". */
export function describeCron(cron: Cron): string {
  const [minute, hour, dom, month, dow] = cron.fields;
  let time: string;
  if (minute.any && hour.any) time = "Every minute";
  else if (hour.any && minute.values.length > 1 && minute.values[0] === 0) {
    const step = minute.values[1] - minute.values[0];
    time = minute.values.every((v, i) => v === i * step) ? `Every ${step} minutes` : `At minutes ${list(minute.values.map(String))} of every hour`;
  } else if (hour.any) time = `At minute ${list(minute.values.map(String))} of every hour`;
  else if (minute.values.length * hour.values.length <= 4) time = `At ${list(hour.values.flatMap((h) => minute.values.map((m) => clock(h, m))))}`;
  else time = `At minute ${list(minute.values.map(String))} past hours ${list(hour.values.map(String))}`;

  const days: string[] = [];
  if (!dom.any) days.push(`on day ${list(dom.values.map(String))} of the month`);
  if (!dow.any) {
    const names = dow.values.map((v) => DAYS[v]);
    days.push(isRange(dow.values) ? `${dom.any ? "" : "or "}on ${names[0]} through ${names[names.length - 1]}` : `${dom.any ? "" : "or "}on ${list(names)}`);
  }
  const months = month.any ? "" : ` in ${list(month.values.map((v) => MONTHS[v - 1]))}`;
  if (!dom.any && dow.any && month.values.length === 1 && dom.values.length === 1) {
    return `${time} on ${MONTHS[month.values[0] - 1]} ${dom.values[0]}`;
  }
  // "Every 15 minutes" already says every day; "At 8:00 AM" needs it.
  if (!days.length) return hour.any ? `${time}${months}` : `${time}, every day${months}`;
  return `${time} ${days.join(" ")}${months}`.replace(/\s+/g, " ");
}

/** True when the expression can only fire on one calendar date a year: what a one-time job stores. */
export function isFixedDate(cron: Cron): boolean {
  const [minute, hour, dom, month] = cron.fields;
  return minute.values.length === 1 && hour.values.length === 1 && dom.values.length === 1 && month.values.length === 1 && !dom.any && !month.any;
}

export const JITTER_CAP_MINUTES = 30;
export const LIFETIME_DAYS = 7;

export interface Job {
  id: string;
  cron: string;
  recurring: boolean;
  task: string;
  createdAt: number;
  /** The session that created it: jobs belong to it, and a new session has a separate list. */
  session: string;
  lastFiredAt: number | null;
  fireCount: number;
}

/** Recurring jobs expire seven days after creation. One-time jobs end when delivered. */
export function expiresAt(job: Job): number | null {
  return job.recurring ? job.createdAt + LIFETIME_DAYS * 24 * 3600 * 1000 : null;
}

/** The next base cron match after `now`, or null once a recurring job expired (or a one-time job was delivered). */
export function nextFire(job: Job, now: number): Date | null {
  const parsed = parseCron(job.cron);
  if (!parsed.ok) return null;
  if (!job.recurring && job.fireCount > 0) return null;
  const [next] = nextRuns(parsed.cron, new Date(now), 1);
  if (!next) return null;
  const end = expiresAt(job);
  return end !== null && next.getTime() > end ? null : next;
}

/** Most fires counted in a window: a job every minute fires 10,080 times in seven days. */
const MAX_COUNT = 10_080;

/** How many times a recurring job can fire before it expires, counted from creation. */
export function firesWithinLifetime(job: Job): number {
  const parsed = parseCron(job.cron);
  if (!parsed.ok) return 0;
  if (!job.recurring) return 1;
  return nextRuns(parsed.cron, new Date(job.createdAt), MAX_COUNT, new Date(expiresAt(job)!)).length;
}

export interface Recovery {
  /** Base fire times that fell while Muse Code was closed. */
  missed: number;
  /** What runs when the session resumes: at most one catch-up for recurring work; a missed one-time job once. */
  catchUpRuns: number;
  note: string;
}

/** What bounded recovery delivers for a job after Muse Code was closed from `closedAt` to `resumedAt`. */
export function recovery(job: Job, closedAt: number, resumedAt: number): Recovery {
  const parsed = parseCron(job.cron);
  if (!parsed.ok) return { missed: 0, catchUpRuns: 0, note: "The expression doesn't parse." };
  const end = new Date(Math.min(resumedAt, expiresAt(job) ?? Infinity));
  // A delivered one-time job has nothing left to miss.
  const missed = !job.recurring && job.fireCount > 0 ? 0 : nextRuns(parsed.cron, new Date(closedAt), job.recurring ? MAX_COUNT : 1, end).length;
  if (!missed) return { missed, catchUpRuns: 0, note: "Nothing was due while Muse Code was closed." };
  if (!job.recurring) return { missed, catchUpRuns: 1, note: "The missed one-time job is delivered once after recovery, then deletes itself." };
  return {
    missed,
    catchUpRuns: 1,
    note: `${missed} interval${missed === 1 ? "" : "s"} passed while closed; recovery runs at most one catch-up, then the normal cadence resumes.`,
  };
}

/** "Fri, Oct 30, 8:00 AM" in the browser's local time. */
export function formatLocal(d: Date): string {
  return `${DAYS[d.getDay()].slice(0, 3)}, ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}, ${clock(d.getHours(), d.getMinutes())}`;
}

/**
 * When a job is next eligible to fire. A recurring job's base cron match starts a window of deterministic forward
 * jitter capped at 30 minutes ("Fri, Oct 30, 8:00 AM to 8:30 AM"); the recipe doesn't say how the offset is picked,
 * so the window is what can be known. A one-time job fires at its base time.
 */
export function formatFireWindow(base: Date, recurring: boolean, jitterMinutes: number = JITTER_CAP_MINUTES): string {
  if (!recurring) return formatLocal(base);
  const end = new Date(base.getTime() + jitterMinutes * 60_000);
  const sameDay = end.getFullYear() === base.getFullYear() && end.getMonth() === base.getMonth() && end.getDate() === base.getDate();
  return `${formatLocal(base)} to ${sameDay ? clock(end.getHours(), end.getMinutes()) : formatLocal(end)}`;
}

/** An 8-hex job id like the recipe's 3a3a0d42. */
export function jobId(random: () => number = Math.random): string {
  return Array.from({ length: 8 }, () => Math.floor(random() * 16).toString(16)).join("");
}
