import { JOBS_LIMITS } from "@/lib/caps/jobs/limits";

/**
 * When a schedule runs (docs/CAPABILITIES.md, section 12). A brief and a manifest say it in one string:
 *
 *   "15 minutes"   "2 hours"   "1 day at 07:30"   "1 week at 09:00 America/New_York"   "6 hours at 00:30 Europe/Paris"
 *
 * The slots of a day are local midnight plus `atMinute`, then every `everyMinutes`, in the schedule's time zone, so
 * "1 day at 07:30" stays at 07:30 on the clock across a daylight saving change. A time that doesn't exist that day (the
 * spring gap) runs that much later on the new clock. A time that happens twice runs the first time. Anything rarer than a day
 * counts whole days from the epoch in that time zone, so a run's slot never drifts.
 */
export interface Every {
  everyMinutes: number;
  atMinute: number | null;
  tz: string;
}

const UNIT_MINUTES: Record<string, number> = { minute: 1, hour: 60, day: 1440, week: 10_080 };
const EVERY = /^(?:every\s+)?(\d{1,5})?\s*(minute|hour|day|week)s?(?:\s+at\s+(\d{1,2}):(\d{2}))?(?:\s+([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*))?$/i;

/** True for a time zone this runtime knows. */
export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The schedule a string says, or null when it isn't one. Below 15 minutes it comes back as 15, the floor. "daily",
 * "hourly" and "weekly" are understood. An unknown time zone is refused rather than quietly run in UTC.
 */
export function parseEvery(raw: unknown): Every | null {
  if (typeof raw !== "string") return null;
  const text = raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(?:every )?daily\b/i, "1 day")
    .replace(/^(?:every )?hourly\b/i, "1 hour")
    .replace(/^(?:every )?weekly\b/i, "1 week");
  const m = EVERY.exec(text);
  if (!m) return null;
  const count = m[1] === undefined ? 1 : Number(m[1]);
  if (count < 1) return null;
  const minutes = count * UNIT_MINUTES[m[2]!.toLowerCase()]!;
  let atMinute: number | null = null;
  if (m[3] !== undefined) {
    const [h, min] = [Number(m[3]), Number(m[4])];
    if (h > 23 || min > 59) return null;
    atMinute = h * 60 + min;
  }
  const tz = m[5] ?? "UTC";
  if (!validTimeZone(tz)) return null;
  return { everyMinutes: Math.min(JOBS_LIMITS.maxEveryMinutes, Math.max(JOBS_LIMITS.minEveryMinutes, minutes)), atMinute, tz };
}

/** A schedule in the same words parseEvery reads, for a prompt or a page. */
export function everyWords({ everyMinutes, atMinute, tz }: Every): string {
  const unit = everyMinutes % 10_080 === 0 ? ["week", 10_080] : everyMinutes % 1440 === 0 ? ["day", 1440] : everyMinutes % 60 === 0 ? ["hour", 60] : ["minute", 1];
  const count = everyMinutes / (unit[1] as number);
  const at = atMinute === null ? "" : ` at ${String(Math.floor(atMinute / 60)).padStart(2, "0")}:${String(atMinute % 60).padStart(2, "0")}`;
  return `${count} ${unit[0]}${count === 1 ? "" : "s"}${at}${tz === "UTC" ? "" : ` ${tz}`}`;
}

interface Local {
  /** Whole days since 1970-01-01 on this time zone's calendar. */
  day: number;
  /** Minutes after midnight on its clock. */
  minute: number;
}

function formatter(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
}

function localOf(at: Date, fmt: Intl.DateTimeFormat): Local & { ms: number } {
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, Number(p.value)]));
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return { day: Math.floor(asUtc / 86_400_000), minute: parts.hour! * 60 + parts.minute!, ms: asUtc };
}

/** The first instant on a time zone's clock at or after this day and minute. */
function instantOf(day: number, minute: number, fmt: Intl.DateTimeFormat): Date {
  const wanted = day * 86_400_000 + minute * 60_000;
  // The zone's offset can differ on either side of a change, so try the offset either side of the wanted time.
  const offsets = [-36, 36].map((hours) => {
    const probe = new Date(wanted + hours * 3_600_000);
    return localOf(probe, fmt).ms - probe.getTime();
  });
  const candidates = [...new Set(offsets)].map((offset) => wanted - offset).sort((a, b) => a - b);
  for (const c of candidates) {
    const seen = localOf(new Date(c), fmt);
    if (seen.ms === wanted) return new Date(c);
  }
  // No such time that day (the spring gap): the same distance past the jump on the new clock.
  return new Date(Math.max(...candidates));
}

/** The first slot strictly after `after`. */
export function nextRunAfter(every: Every, after: Date): Date {
  const fmt = formatter(every.tz);
  const today = localOf(after, fmt).day;
  const at = every.atMinute ?? 0;
  if (every.everyMinutes >= 1440) {
    const stride = Math.max(1, Math.round(every.everyMinutes / 1440));
    let day = today - 1;
    day += stride - (((day % stride) + stride) % stride);
    for (let i = 0; i < 4; i++) {
      const candidate = instantOf(day + i * stride, at, fmt);
      if (candidate > after) return candidate;
    }
    return new Date(after.getTime() + every.everyMinutes * 60_000);
  }
  let soonest: Date | null = null;
  for (let day = today - 1; day <= today + 1; day++) {
    for (let minute = at % every.everyMinutes; minute < 1440; minute += every.everyMinutes) {
      const candidate = instantOf(day, minute, fmt);
      if (candidate > after && (!soonest || candidate < soonest)) soonest = candidate;
    }
  }
  return soonest ?? new Date(after.getTime() + every.everyMinutes * 60_000);
}
