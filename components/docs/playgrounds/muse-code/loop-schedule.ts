/**
 * What a `/loop` command schedules (content/meta-docs/pages/muse-code/interactive.md "Goals and long-running loops"):
 * a shorthand interval (5m, 1h, 2d) or a 5-field cron expression (minute hour day-of-month month day-of-week, local
 * time), every 10 minutes when no cadence is given, auto-expiring after 7 days, and skipping occurrences that land
 * during an active run. Pure: give it a start time and it lists the occurrences before the job expires.
 */

export const LOOP_DEFAULT_MINUTES = 10;
export const LOOP_EXPIRES_DAYS = 7;

export type Cadence = { kind: "interval"; minutes: number; label: string } | { kind: "cron"; expr: string; fields: CronFields; label: string };

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** Day-of-month and day-of-week both restricted: cron matches either one. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

export type LoopParse = { ok: true; cadence: Cadence; prompt: string; defaulted: boolean } | { ok: false; error: string };

const RANGES = { minute: [0, 59], hour: [0, 23], dom: [1, 31], month: [1, 12], dow: [0, 7] } as const;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(text: string, name: keyof typeof RANGES): Set<number> | string {
  const [lo, hi] = RANGES[name];
  const out = new Set<number>();
  const value = (v: string): number => {
    const lower = v.toLowerCase();
    if (name === "month" && MONTHS.includes(lower)) return MONTHS.indexOf(lower) + 1;
    if (name === "dow" && DAYS.includes(lower)) return DAYS.indexOf(lower);
    return /^\d+$/.test(v) ? Number(v) : NaN;
  };
  for (const part of text.split(",")) {
    const m = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return `"${part}" isn't a valid ${name} field`;
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) return `The step in "${part}" must be at least 1`;
    let from: number;
    let to: number;
    if (m[1] === "*") {
      from = lo;
      to = name === "dow" ? 6 : hi;
    } else if (m[1].includes("-")) {
      const [a, b] = m[1].split("-");
      from = value(a);
      to = value(b);
    } else {
      from = value(m[1]);
      to = m[2] ? (name === "dow" ? 6 : hi) : from;
    }
    if (Number.isNaN(from) || Number.isNaN(to) || from < lo || to > hi || from > to) return `"${part}" is out of range for ${name} (${lo} to ${hi})`;
    for (let v = from; v <= to; v += step) out.add(name === "dow" && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string): CronFields | string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return `A cron expression has 5 fields (minute hour day-of-month month day-of-week); this has ${parts.length}.`;
  const names = ["minute", "hour", "dom", "month", "dow"] as const;
  const sets: Partial<Record<(typeof names)[number], Set<number>>> = {};
  for (let i = 0; i < 5; i++) {
    const r = parseField(parts[i], names[i]);
    if (typeof r === "string") return r;
    sets[names[i]] = r;
  }
  return {
    minute: sets.minute!,
    hour: sets.hour!,
    dom: sets.dom!,
    month: sets.month!,
    dow: sets.dow!,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Reads "/loop 10m /run-tests", '/loop "0 9 * * 1-5" standup' or "/loop standup". */
export function parseLoop(input: string): LoopParse {
  let rest = input.trim();
  if (rest.startsWith("/loop")) rest = rest.slice(5).trim();
  if (!rest) return { ok: false, error: "Add what to run, such as /loop 10m /run-tests." };
  const quoted = /^(["'])(.*?)\1\s*(.*)$/.exec(rest);
  if (quoted) {
    const fields = parseCron(quoted[2]);
    if (typeof fields === "string") return { ok: false, error: fields };
    const prompt = quoted[3].trim();
    if (!prompt) return { ok: false, error: "Add the prompt or /skill to run after the cron expression." };
    return { ok: true, cadence: { kind: "cron", expr: quoted[2].trim(), fields, label: `Cron ${quoted[2].trim()} (local time)` }, prompt, defaulted: false };
  }
  const interval = /^(\d+)([mhd])\s+(.+)$/.exec(rest);
  if (interval) {
    const n = Number(interval[1]);
    if (n < 1) return { ok: false, error: "An interval has to be at least 1." };
    const minutes = interval[2] === "m" ? n : interval[2] === "h" ? n * 60 : n * 1440;
    const unit = interval[2] === "m" ? "minute" : interval[2] === "h" ? "hour" : "day";
    return { ok: true, cadence: { kind: "interval", minutes, label: `Every ${plural(n, unit)}` }, prompt: interval[3].trim(), defaulted: false };
  }
  if (/^\d+[a-z]*$/i.test(rest.split(/\s+/)[0]) && rest.split(/\s+/).length > 1) {
    return { ok: false, error: `"${rest.split(/\s+/)[0]}" isn't a cadence: use a number with m, h or d (5m, 1h, 2d), or a quoted 5-field cron.` };
  }
  return { ok: true, cadence: { kind: "interval", minutes: LOOP_DEFAULT_MINUTES, label: "Every 10 minutes (the default)" }, prompt: rest, defaulted: true };
}

function cronMatches(f: CronFields, d: Date): boolean {
  if (!f.minute.has(d.getMinutes()) || !f.hour.has(d.getHours()) || !f.month.has(d.getMonth() + 1)) return false;
  const dom = f.dom.has(d.getDate());
  const dow = f.dow.has(d.getDay());
  if (f.domRestricted && f.dowRestricted) return dom || dow;
  if (f.domRestricted) return dom;
  if (f.dowRestricted) return dow;
  return true;
}

export interface Schedule {
  /** Occurrences between creation and expiry, in local time. */
  runs: Date[];
  /** True when there were more than `limit`. */
  more: boolean;
  total: number;
  expires: Date;
}

/** Occurrences from `created` until the job expires 7 days later. Intervals count from creation. */
export function occurrences(cadence: Cadence, created: Date, limit = 8): Schedule {
  const expires = new Date(created.getTime() + LOOP_EXPIRES_DAYS * 86_400_000);
  const runs: Date[] = [];
  let total = 0;
  if (cadence.kind === "interval") {
    const step = cadence.minutes * 60_000;
    for (let t = created.getTime() + step; t <= expires.getTime(); t += step) {
      total++;
      if (runs.length < limit) runs.push(new Date(t));
    }
  } else {
    const t = new Date(created.getTime());
    t.setSeconds(0, 0);
    t.setMinutes(t.getMinutes() + 1);
    while (t.getTime() <= expires.getTime()) {
      if (cronMatches(cadence.fields, t)) {
        total++;
        if (runs.length < limit) runs.push(new Date(t.getTime()));
      }
      t.setMinutes(t.getMinutes() + 1);
    }
  }
  return { runs, more: total > runs.length, total, expires };
}
