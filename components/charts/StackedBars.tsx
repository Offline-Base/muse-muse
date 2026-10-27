import { compact, dayLabel, usd } from "@/lib/format";

/**
 * A stacked bar chart drawn as inline SVG: one bar per day, horizontal gridlines only, muted axis labels and a
 * legend of colored dots. Bars are drawn in a stretchable SVG; labels are HTML so text stays crisp at any width.
 * A visually hidden table carries the numbers for screen readers.
 */

export type ChartUnit = "tokens" | "usd" | "count";

export interface ChartSeries {
  key: string;
  label: string;
  values: number[];
  /** A CSS color, usually a token such as var(--chart-1). */
  color: string;
}

export const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];

function fmt(v: number, unit: ChartUnit): string {
  if (unit === "usd") return v === 0 ? "$0" : v < 1 ? usd(v) : v < 1000 ? `$${Number(v.toFixed(2))}` : `$${compact(v)}`;
  return v > 0 && v < 1000 ? String(Number(v.toFixed(2))) : compact(v);
}

/** A round axis maximum with four equal steps. */
function niceMax(max: number, unit: ChartUnit): number {
  if (max <= 0) return unit === "usd" ? 1 : 4;
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
  const s = unit === "count" ? Math.max(1, Math.ceil(step)) : step;
  return s * 4;
}

export function StackedBars({
  days,
  series,
  unit,
  label,
}: {
  days: string[];
  series: ChartSeries[];
  unit: ChartUnit;
  label: string;
}) {
  const n = days.length;
  const totals = days.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals), unit);
  const ticks = [0, 1, 2, 3, 4].map((k) => (max / 4) * k);
  const empty = totals.every((t) => t === 0);
  const every = n <= 7 ? 1 : n <= 14 ? 2 : 5;
  // Phones fit about four day labels; the rest are hidden by CSS (.x-wide-only).
  const everyNarrow = Math.max(every, Math.ceil(n / 4));
  const W = n * 10;

  return (
    <figure className="chart">
      <div className="chart-area">
        <div className="chart-y" aria-hidden>
          {ticks.map((t) => (
            <span key={t} style={{ bottom: `${(t / max) * 100}%` }}>
              {fmt(t, unit)}
            </span>
          ))}
        </div>
        <div className="chart-plot">
          <svg viewBox={`0 0 ${W} 100`} preserveAspectRatio="none" role="img" aria-label={label}>
            {ticks.map((t) => (
              <line
                key={t}
                className="chart-grid"
                x1={0}
                x2={W}
                y1={100 - (t / max) * 100}
                y2={100 - (t / max) * 100}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {days.map((day, i) => {
              let acc = 0;
              const parts = series
                .map((s) => {
                  const v = s.values[i] ?? 0;
                  const h = (v / max) * 100;
                  const y = 100 - ((acc + v) / max) * 100;
                  acc += v;
                  return v > 0 ? <rect key={s.key} x={i * 10 + 2} width={6} y={y} height={h} fill={s.color} /> : null;
                })
                .filter(Boolean);
              const tip = `${dayLabel(day)}: ${series.map((s) => `${s.label} ${fmt(s.values[i] ?? 0, unit)}`).join(", ")}`;
              return (
                <g key={day} className="chart-day">
                  <title>{tip}</title>
                  <rect className="chart-hit" x={i * 10} width={10} y={0} height={100} />
                  {parts}
                </g>
              );
            })}
          </svg>
          {empty ? <p className="chart-empty">No usage in this range</p> : null}
        </div>
        <div className="chart-x" aria-hidden style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
          {days.map((d, i) => {
            const last = i === n - 1;
            const shown = i % every === 0 || last;
            const narrow = (i % everyNarrow === 0 && n - 1 - i >= everyNarrow / 2) || last;
            return (
              <span key={d} className={shown && !narrow ? "x-wide-only" : undefined}>
                {shown ? dayLabel(d) : ""}
              </span>
            );
          })}
        </div>
      </div>
      <figcaption>
        <ul className="legend">
          {series.map((s) => (
            <li key={s.key}>
              <span className="legend-dot" style={{ background: s.color }} aria-hidden />
              {s.label}
            </li>
          ))}
        </ul>
      </figcaption>
      {/* sr-only goes on a wrapper: a table sizes itself to its content and ignores the 1px box, widening the page. */}
      <div className="sr-only">
      <table>
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((d, i) => (
            <tr key={d}>
              <th scope="row">{dayLabel(d)}</th>
              {series.map((s) => (
                <td key={s.key}>{fmt(s.values[i] ?? 0, unit)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </figure>
  );
}
