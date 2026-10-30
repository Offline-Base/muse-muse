import { asObject } from "@/components/docs/playgrounds/cookbook-use-cases/lib/strict-json";

/**
 * cookbook/perception-chart-analysis on our bar chart sample (public/docs-samples/bar-chart.png, values from
 * lib/docs/media/samples.ts): the recipe's explain-only prompts adapted to a bar chart, its structured-analysis
 * schema, and the verification step it calls the objective backbone: every number the model read is checked
 * against the chart's known values. "Cover the printed values" hides the numbers above the bars, so the model has
 * to read the axis, which is where the recipe says misreads happen.
 */

export interface Bar {
  label: string;
  value: number | null;
  how_read?: string;
}

export const SAMPLE_CHART = {
  title: "Cups sold by drink, week of Oct 20, 2026",
  unit: "Cups sold",
  bars: [
    { label: "Latte", value: 412 },
    { label: "Cold brew", value: 341 },
    { label: "Cappuccino", value: 287 },
    { label: "Americano", value: 198 },
    { label: "Mocha", value: 156 },
    { label: "Tea", value: 122 },
  ] as const,
  /** Pixel geometry of the 1200 x 800 PNG: bar centers, the zero line and pixels per cup. */
  geometry: { width: 1200, height: 800, zeroY: 689, pxPerUnit: 1.14, centers: [197, 372, 547, 722, 897, 1072], gridlines: [119, 233, 347, 461, 575], gridColor: "#f1f2f4" },
};

/** The rectangles that hide each printed value above its bar, in the sample's pixels. */
export function valueLabelRects(): Array<{ x: number; y: number; w: number; h: number }> {
  const g = SAMPLE_CHART.geometry;
  return SAMPLE_CHART.bars.map((b, i) => {
    const top = g.zeroY - b.value * g.pxPerUnit;
    return { x: g.centers[i] - 48, y: Math.round(top - 42), w: 96, h: 38 };
  });
}

/** The gridline pieces a cover rectangle hides, to paint back so the axis stays whole (2 px high, as drawn). */
export function gridlinePatches(): Array<{ x: number; y: number; w: number; h: number }> {
  const g = SAMPLE_CHART.geometry;
  return valueLabelRects().flatMap((r) => g.gridlines.filter((y) => y + 1 >= r.y && y <= r.y + r.h).map((y) => ({ x: r.x, y, w: r.w, h: 2 })));
}

/** Step 1: the recipe's explain-only probe, for a bar chart. */
export const EXPLAIN_PROMPT =
  "Help me understand this chart. Describe ONLY what is visible: the title, what is measured and in what unit, the categories, the value of each bar if you can read it, the overall pattern, and anything labeled. State a value only if you can read it; say 'not readable' otherwise. Mark values you interpolate from gridlines as (approx). Do NOT give advice or predictions.";

/** Step 2: the structured analysis, as the recipe asks for it. */
export const STRUCTURED_PROMPT =
  "Analyze the chart and return ONLY JSON matching the schema. Give every bar with its value. If a value isn't printed, read it off the gridlines and say so in how_read (approx); use null and add the bar to 'unreadable' only when you can't read it at all. In how_read, say whether you read a printed label or interpolated from the gridlines. No advice.";

/** Step 3: the recipe's verification prompt. */
export const VERIFY_PROMPT =
  "From the chart, list every value you reference and HOW you read it (which gridline or label). Mark interpolated values (approx); if you cannot read a value, say so.";

/** Strict schema for bar values. */
export function barSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "unit", "trend", "bars", "unreadable"],
    properties: {
      title: { type: "string" },
      unit: { type: "string" },
      trend: { type: "string", enum: ["up", "down", "sideways", "mixed"] },
      bars: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "value", "how_read"],
          properties: { label: { type: "string" }, value: { type: ["number", "null"] }, how_read: { type: "string" } },
        },
      },
      unreadable: { type: "array", items: { type: "string" } },
    },
  };
}

/** The recipe's own analysis schema for price charts, strict. */
export function recipeSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["instrument", "timeframe", "trend", "keyLevels", "pctChangeVisible", "notableEvents", "unreadable"],
    properties: {
      instrument: { type: "string" },
      timeframe: { type: "string" },
      trend: { type: "string", enum: ["up", "down", "sideways"] },
      keyLevels: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "value"],
          properties: { type: { type: "string", enum: ["support", "resistance"] }, value: { type: ["number", "null"] } },
        },
      },
      pctChangeVisible: { type: ["number", "null"] },
      notableEvents: { type: "array", items: { type: "string" } },
      unreadable: { type: "array", items: { type: "string" } },
    },
  };
}

export interface BarAnalysis {
  title: string;
  unit: string;
  trend: string;
  bars: Bar[];
  unreadable: string[];
}

export function readBarAnalysis(value: unknown): BarAnalysis | null {
  const o = asObject(value);
  if (!o || !Array.isArray(o.bars)) return null;
  return {
    title: String(o.title ?? ""),
    unit: String(o.unit ?? ""),
    trend: String(o.trend ?? ""),
    bars: o.bars
      .map((b) => asObject(b))
      .filter((b): b is Record<string, unknown> => !!b)
      .map((b) => ({
        label: String(b.label ?? ""),
        value: typeof b.value === "number" && Number.isFinite(b.value) ? b.value : null,
        how_read: typeof b.how_read === "string" ? b.how_read : undefined,
      })),
    unreadable: Array.isArray(o.unreadable) ? o.unreadable.map(String) : [],
  };
}

export type CheckStatus = "exact" | "close" | "wrong" | "missing" | "unreadable" | "extra";

export interface BarCheck {
  label: string;
  /** The label the model wrote for the bar this check matched ("Cold-brew" for "Cold brew"), when it read one. */
  readLabel?: string;
  known: number | null;
  read: number | null;
  delta: number | null;
  status: CheckStatus;
  how?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Each known bar against what the model read: exact, close (within `tolerance` of the true value, as a fraction),
 * wrong, missing, or marked unreadable; bars the chart doesn't have come last as extra.
 */
export function checkBars(read: Bar[], known: ReadonlyArray<{ label: string; value: number }> = SAMPLE_CHART.bars, tolerance = 0.03, unreadable: string[] = []): BarCheck[] {
  const out: BarCheck[] = [];
  const used = new Set<number>();
  for (const k of known) {
    const idx = read.findIndex((r, i) => !used.has(i) && (norm(r.label) === norm(k.label) || norm(r.label).includes(norm(k.label)) || norm(k.label).includes(norm(r.label))));
    if (idx < 0) {
      out.push({ label: k.label, known: k.value, read: null, delta: null, status: unreadable.some((u) => norm(u).includes(norm(k.label))) ? "unreadable" : "missing" });
      continue;
    }
    used.add(idx);
    const r = read[idx];
    if (r.value === null) {
      out.push({ label: k.label, readLabel: r.label, known: k.value, read: null, delta: null, status: "unreadable", how: r.how_read });
      continue;
    }
    const delta = r.value - k.value;
    const status: CheckStatus = delta === 0 ? "exact" : Math.abs(delta) <= k.value * tolerance ? "close" : "wrong";
    out.push({ label: k.label, readLabel: r.label, known: k.value, read: r.value, delta, status, how: r.how_read });
  }
  read.forEach((r, i) => {
    if (!used.has(i)) out.push({ label: r.label, readLabel: r.label, known: null, read: r.value, delta: null, status: "extra", how: r.how_read });
  });
  return out;
}

/** "5 of 6 exact, 1 within 3%" for a check list. */
export function checkSummary(checks: BarCheck[]): string {
  const known = checks.filter((c) => c.known !== null).length;
  const count = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
  const parts = [`${count("exact")} of ${known} exact`];
  if (count("close")) parts.push(`${count("close")} within 3%`);
  if (count("wrong")) parts.push(`${count("wrong")} wrong`);
  if (count("unreadable")) parts.push(`${count("unreadable")} marked unreadable`);
  if (count("missing")) parts.push(`${count("missing")} missing`);
  if (count("extra")) parts.push(`${count("extra")} not on the chart`);
  return parts.join(", ");
}

/** Facts for the summary card, from the extracted values only (the card can't drift from what the model read). */
export function summaryFacts(a: BarAnalysis): { leader: Bar | null; last: Bar | null; total: number | null; gap: number | null } {
  const readable = a.bars.filter((b): b is Bar & { value: number } => typeof b.value === "number");
  if (!readable.length) return { leader: null, last: null, total: null, gap: null };
  const sorted = [...readable].sort((x, y) => y.value - x.value);
  return {
    leader: sorted[0],
    last: sorted[sorted.length - 1],
    total: readable.length === a.bars.length ? readable.reduce((s, b) => s + b.value, 0) : null,
    gap: sorted.length > 1 ? sorted[0].value - sorted[1].value : null,
  };
}
