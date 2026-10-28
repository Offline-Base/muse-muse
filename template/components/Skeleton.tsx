import type { CSSProperties } from "react";

const WIDTHS = ["100%", "92%", "78%", "86%", "64%"];

/**
 * Placeholder shapes in the shape of the result that is on its way, pulsing like Facebook's loading glimmer. Put it
 * where the result will appear, next to a .working line that names the step, like "Reading the receipt…", and replace
 * it with the result. It marks itself aria-busy, so judgeShot waits until it is gone and a .card.ai around it moves its
 * gradient cap. `height` adds a block first (an image or a table), then `lines` text lines.
 */
export function Skeleton({ lines = 3, height, style }: { lines?: number; height?: number | string; style?: CSSProperties }) {
  return (
    <div className="skeleton-group" aria-hidden="true" aria-busy="true" style={style}>
      {height !== undefined ? <div className="skeleton block" style={{ height }} /> : null}
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: i === lines - 1 && lines > 1 ? "56%" : WIDTHS[i % WIDTHS.length] }} />
      ))}
    </div>
  );
}
