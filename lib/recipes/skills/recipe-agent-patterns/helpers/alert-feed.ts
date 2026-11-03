/**
 * A noisy, made-up alert feed with known patterns, its parser and its digest (recipe-agent-patterns, 02/05). Pure and
 * import-free: copy it to lib/alerts/feed.ts. The sample is the hard part of the note, so it is never 9 clean lines:
 *
 * - 42 alerts over about 30 days, baked so code knows the answers: 28 recurring (66.7%), 31 owned by the first owner
 *   (73.8%), 28 between 02:00 and 03:59, 3 silenced, and 7 components at 6 alerts each.
 * - Noise on top, as a real export has it: 4 repeated lines (the same alert sent twice), 3 lines out of time order,
 *   one blank line and one cut-off line. parseAlertFeed drops and reports them, and the page shows what it dropped.
 *
 * The digest is what the model may state. numberCheck marks every number in an answer as grounded in the digest or
 * not, and the page shows the ungrounded ones.
 */

export interface AlertRow {
  id: string;
  /** Local time with its offset, as the feed has it: 2026-09-04T02:37:00-05:00. */
  ts: string;
  component: string;
  title: string;
  severity: "P1" | "P2" | "P3";
  owner: string;
  host: string;
  recurring: boolean;
  silenced: boolean;
}

export interface FeedComponent {
  name: string;
  /** The alert that keeps firing. */
  recurring: string;
  /** Two alerts that fire once each. */
  oneOff: [string, string];
}

export interface FeedOptions {
  /** Exactly 7, so the baked counts hold. Made-up names only. */
  components: FeedComponent[];
  /** The first carries most alerts; three more share the rest. Made-up first names. */
  owners: [string, string, string, string];
  /** Hosts end in this domain, which must end in .example. */
  domain: string;
  /** Id prefix, such as "ALR". */
  idPrefix?: string;
  /** The month, YYYY-MM, default 2026-09. */
  month?: string;
  /** UTC offset written on every time, default -05:00. */
  offset?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The 42 clean alerts in time order. Alert i is component i mod 7, occurrence i div 7: occurrences 0 to 3 recur. */
export function makeAlerts(opts: FeedOptions): AlertRow[] {
  if (opts.components.length !== 7) throw new Error("makeAlerts needs exactly 7 components, so the baked counts hold.");
  if (!opts.domain.endsWith(".example")) throw new Error("Use a made-up domain that ends in .example.");
  const [main, a, b, c] = opts.owners;
  const others: Record<string, string> = { "6:0": a, "4:4": a, "5:4": a, "6:4": b, "0:5": a, "1:5": b, "2:5": c, "3:5": a, "4:5": b, "5:5": c, "6:5": c };
  const silenced = new Set(["1:1", "4:2", "6:3"]);
  const month = opts.month ?? "2026-09";
  const offset = opts.offset ?? "-05:00";
  const out: AlertRow[] = [];
  for (let i = 0; i < 42; i++) {
    const ci = i % 7;
    const j = Math.floor(i / 7);
    const comp = opts.components[ci];
    const recurring = j < 4;
    // 24 recurring and 4 one-off alerts fire between 02:00 and 03:59; the rest in the daytime.
    const night = recurring ? !(j === 3 && ci <= 3) : j === 4 && ci <= 3;
    const day = 1 + Math.floor((i * 30) / 42);
    const minutes = night ? 120 + ((i * 37) % 120) : 9 * 60 + ((i * 53) % 600);
    out.push({
      id: `${opts.idPrefix ?? "ALR"}-${1000 + i}`,
      ts: `${month}-${pad(day)}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00${offset}`,
      component: comp.name,
      title: recurring ? comp.recurring : comp.oneOff[j - 4],
      severity: recurring ? "P3" : ci <= 1 ? "P1" : "P2",
      owner: others[`${ci}:${j}`] ?? main,
      host: `${comp.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.${opts.domain}`,
      recurring,
      silenced: silenced.has(`${ci}:${j}`),
    });
  }
  return out;
}

/** The sample as a noisy export: one JSON object a line, with repeats, lines out of order, a blank and a cut-off line. */
export function makeAlertFeed(opts: FeedOptions): string {
  const lines = makeAlerts(opts).map((r) => JSON.stringify(r));
  // Three lines out of order: swap a few neighbors.
  for (const k of [5, 17, 29]) [lines[k], lines[k + 1]] = [lines[k + 1], lines[k]];
  // Four alerts sent twice.
  for (const k of [33, 21, 12, 3]) lines.splice(k + 1, 0, lines[k]);
  lines.splice(25, 0, "");
  const cut = lines[40];
  lines.splice(41, 0, cut.slice(0, Math.floor(cut.length / 2)));
  return lines.join("\n");
}

export interface ParsedFeed {
  rows: AlertRow[];
  /** Ids seen more than once; each repeat was dropped. */
  duplicates: string[];
  /** 1-based line numbers that weren't an alert, with why. Blank lines are skipped quietly. */
  skipped: Array<{ line: number; reason: string }>;
  /** True when the feed's times weren't in order; rows come back sorted by time. */
  reordered: boolean;
}

const FIELDS: Array<keyof AlertRow> = ["id", "ts", "component", "title", "owner"];

/** Parses the feed in code, before any model call. The model only ever sees these rows, by id. */
export function parseAlertFeed(text: string): ParsedFeed {
  const rows: AlertRow[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const skipped: ParsedFeed["skipped"] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      skipped.push({ line: i + 1, reason: "not valid JSON (cut off?)" });
      return;
    }
    const r = v as Partial<AlertRow>;
    const missing = FIELDS.filter((f) => typeof r[f] !== "string" || !r[f]);
    if (missing.length) {
      skipped.push({ line: i + 1, reason: `missing ${missing.join(", ")}` });
      return;
    }
    if (seen.has(r.id!)) {
      duplicates.push(r.id!);
      return;
    }
    seen.add(r.id!);
    rows.push({ ...(r as AlertRow), severity: r.severity ?? "P3", host: r.host ?? "", recurring: r.recurring === true, silenced: r.silenced === true });
  });
  const sorted = [...rows].sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
  const reordered = sorted.some((r, i) => r !== rows[i]);
  return { rows: sorted, duplicates, skipped, reordered };
}

/** Ids a model cited that aren't rows of the feed. A pattern citing any of these is rejected. */
export function unknownIds(ids: readonly string[], rows: readonly AlertRow[]): string[] {
  const known = new Set(rows.map((r) => r.id));
  return ids.filter((id) => !known.has(id));
}

export interface Digest {
  total: number;
  recurring: number;
  oneOff: number;
  silenced: number;
  days: number;
  perDay: number;
  night: number;
  owners: Array<[string, number]>;
  components: Array<[string, number]>;
  recurringPct: number;
  nightPct: number;
  topOwnerPct: number;
}

function counter(values: string[]): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

/** The counts code computes from the rows: the only numbers the model may state. Night is 02:00 to 03:59 local. */
export function digestOf(rows: readonly AlertRow[]): Digest {
  const total = rows.length;
  const recurring = rows.filter((r) => r.recurring).length;
  const night = rows.filter((r) => {
    const h = Number(r.ts.slice(11, 13));
    return h >= 2 && h < 4;
  }).length;
  const dates = [...new Set(rows.map((r) => r.ts.slice(0, 10)))].sort();
  const days = dates.length ? Math.round((Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) - Date.parse(`${dates[0]}T00:00:00Z`)) / 86_400_000) + 1 : 0;
  const owners = counter(rows.map((r) => r.owner));
  return {
    total,
    recurring,
    oneOff: total - recurring,
    silenced: rows.filter((r) => r.silenced).length,
    days,
    perDay: days ? Math.round((total / days) * 10) / 10 : 0,
    night,
    owners,
    components: counter(rows.map((r) => r.component)),
    recurringPct: pct(recurring, total),
    nightPct: pct(night, total),
    topOwnerPct: pct(owners[0]?.[1] ?? 0, total),
  };
}

/** The digest as plain lines, sent with every call and shown on the page. */
export function digestText(d: Digest): string {
  return [
    `total alerts: ${d.total}`,
    `recurring: ${d.recurring} (${d.recurringPct}%), one-off: ${d.oneOff}, silenced: ${d.silenced}`,
    `over ${d.days} days, ${d.perDay} alerts a day`,
    `between 02:00 and 03:59: ${d.night} of ${d.total} (${d.nightPct}%)`,
    `owners: ${d.owners.map(([o, n]) => `${o} ${n}`).join(", ")} (top owner ${d.topOwnerPct}%)`,
    `components: ${d.components.map(([c, n]) => `${c} ${n}`).join(", ")}`,
  ].join("\n");
}

function groundedNumbers(d: Digest): Set<string> {
  const nums = [d.total, d.recurring, d.oneOff, d.silenced, d.days, d.perDay, d.night, d.recurringPct, d.nightPct, d.topOwnerPct, d.components.length, 2, 4];
  for (const [, n] of [...d.owners, ...d.components]) nums.push(n, pct(n, d.total));
  const out = new Set<string>();
  for (const n of nums) {
    out.add(String(n));
    out.add(String(Math.round(n)));
  }
  return out;
}

const CLOCK = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\.?)?/gi;
const ALERT_ID = /\b[A-Z]{2,6}-\d{3,6}\b/g;

/**
 * Every number in an answer, marked grounded when the digest has it. Clock times and alert ids are left out, so the
 * 00 in 02:00 or the 1004 in ALR-1004 isn't read as a count.
 */
export function numberCheck(answer: string, d: Digest): Array<{ text: string; grounded: boolean }> {
  const grounded = groundedNumbers(d);
  const seen = new Set<string>();
  const out: Array<{ text: string; grounded: boolean }> = [];
  for (const raw of answer.replace(CLOCK, " ").replace(ALERT_ID, " ").match(/\d+(?:\.\d+)?/g) ?? []) {
    const n = String(Number(raw));
    if (seen.has(n)) continue;
    seen.add(n);
    out.push({ text: raw, grounded: grounded.has(n) });
  }
  return out;
}
