/**
 * Five-field cron for session-scoped schedules, after Meta's loop-and-cron recipe (04/09), for a product that schedules
 * its own runs while its page is open (recipe-code-sessions, Part 2). Copy it to lib/sim/cron.ts. It imports nothing.
 *
 * Fields: minute hour day-of-month month day-of-week, in the browser's local time. Each takes *, a number, a-b, a list
 * with commas, and a step with /n. Day of week is 0 to 7, where 0 and 7 are Sunday. When both day fields are limited, a
 * day matches either one, as in standard cron. The model turns words into an expression; this code decides if it's valid.
 */

export interface Cron {
  expr: string;
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dayOfMonth: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dayOfWeek: ReadonlySet<number>;
  domAny: boolean;
  dowAny: boolean;
}

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

function field(text: string, min: number, max: number, name: string): Set<number> | string {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return `The ${name} field "${part}" isn't a number, a range, a list or a step.`;
    const step = m[4] ? Number(m[4]) : 1;
    if (step < 1) return `The ${name} field's step must be 1 or more.`;
    const lo = m[1] === "*" ? min : Number(m[2]);
    const hi = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo;
    if (lo < min || hi > max || lo > hi) return `The ${name} field must stay within ${min} to ${max}.`;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): { ok: true; cron: Cron } | { ok: false; reason: string } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return { ok: false, reason: `A cron expression has 5 fields, and this one has ${parts.length}.` };
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const f = FIELDS[i];
    const s = field(parts[i], f.min, f.max, f.name);
    if (typeof s === "string") return { ok: false, reason: s };
    sets.push(s);
  }
  if (sets[4].has(7)) sets[4].add(0);
  return {
    ok: true,
    cron: { expr: parts.join(" "), minute: sets[0], hour: sets[1], dayOfMonth: sets[2], month: sets[3], dayOfWeek: sets[4], domAny: parts[2] === "*", dowAny: parts[4] === "*" },
  };
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.dayOfMonth.has(d.getDate());
  const dow = c.dayOfWeek.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dow;
  if (c.dowAny) return dom;
  return dom || dow;
}

/** The next `count` times the expression matches, after `from`, in local time. Searches at most two years ahead. */
export function nextRuns(cronOrExpr: Cron | string, from: Date, count = 3): Date[] {
  const parsed = typeof cronOrExpr === "string" ? parseCron(cronOrExpr) : { ok: true as const, cron: cronOrExpr };
  if (!parsed.ok) return [];
  const c = parsed.cron;
  const out: Date[] = [];
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = from.getTime() + 2 * 366 * 24 * 3600 * 1000;
  while (out.length < count && t.getTime() <= limit) {
    if (!c.month.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
    } else if (!dayMatches(c, t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
    } else if (!c.hour.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
    } else if (!c.minute.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
    } else {
      out.push(new Date(t.getTime()));
      t.setMinutes(t.getMinutes() + 1, 0, 0);
    }
  }
  return out;
}

/** Forward jitter for a recurring job, the same for the same job id: at most 30 minutes and a tenth of its period. */
export function jitterMs(jobId: string, periodMs: number): number {
  let h = 2166136261;
  for (let i = 0; i < jobId.length; i++) h = Math.imul(h ^ jobId.charCodeAt(i), 16777619) >>> 0;
  const cap = Math.min(30 * 60 * 1000, Math.floor(periodMs / 10));
  return cap > 0 ? h % cap : 0;
}

/** Recurring jobs expire seven days after they're made, as in the recipe. */
export const RECURRING_LIFETIME_MS = 7 * 24 * 3600 * 1000;
