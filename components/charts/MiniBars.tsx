import { dayLabel } from "@/lib/format";

/**
 * The dashboard cards' bar chart: one rounded bar per day, no axis or gridlines, day labels underneath. Each bar's
 * value is in its title, and the figure's label summarizes the range for screen readers.
 */
export function MiniBars({
  days,
  values,
  label,
  format,
}: {
  days: string[];
  values: number[];
  label: string;
  format: (v: number) => string;
}) {
  const n = days.length;
  const max = Math.max(0, ...values);
  const every = n <= 7 ? 1 : n <= 14 ? 2 : n <= 30 ? 5 : 15;
  const cols = { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` };
  return (
    <figure className="mini" role="img" aria-label={label}>
      <div className="mini-bars" style={cols}>
        {days.map((d, i) => {
          const v = values[i] ?? 0;
          return (
            <span
              key={d}
              className="mini-bar"
              title={`${dayLabel(d)}: ${format(v)}`}
              style={{ height: max > 0 && v > 0 ? `${Math.max(2, (v / max) * 100)}%` : 0 }}
            />
          );
        })}
      </div>
      <div className="mini-x" style={cols} aria-hidden>
        {days.map((d, i) => {
          const shown = (n - 1 - i) % every === 0;
          return (
            <span key={d}>{shown ? dayLabel(d) : ""}</span>
          );
        })}
      </div>
    </figure>
  );
}
