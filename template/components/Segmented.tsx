"use client";

import { useId } from "react";

/**
 * Pick one of two to five short options, like "Indoor" and "Outdoor". It is a native radio group, so arrow keys move
 * the choice, screen readers read it as a group, and tests use page.getByRole("radio", { name: "Outdoor" }).check().
 * The label is shown above it, like every field. It lays the options out from their labels (segmentedLayout).
 */
export function Segmented<T extends string>(props: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const labels = props.options.map((option) => option.label);
  return (
    <div className="field">
      <span className="label" id={`${id}-label`}>
        {props.label}
      </span>
      <div
        className="segmented"
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        data-layout={segmentedLayout(labels)}
        data-wide={segmentedLayout(labels, 640)}
      >
        {props.options.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name={id}
              value={option.value}
              checked={option.value === props.value}
              disabled={props.disabled}
              onChange={() => props.onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * Where the options go in a row `row` px wide: "row" when every label fits its equal share of the row on one line,
 * with the check; "grid", two rows of two, for four that don't; otherwise "stack", one full-width row per option. A
 * phone's card leaves a 326 px row. The 720 px column's leaves 680, so data-wide asks about 640, and globals.css uses
 * it in a container that wide.
 */
export function segmentedLayout(labels: readonly string[], row = 326): "row" | "grid" | "stack" {
  // The widest label, plus 24 px of padding, 20 for the check and 4 to spare.
  const widest = Math.max(0, ...labels.map(labelWidth)) + 48;
  const fits = (columns: number) => widest <= (row - (columns - 1) * 8) / columns;
  if (labels.length <= 5 && fits(labels.length)) return "row";
  if (labels.length === 4 && fits(2)) return "grid";
  return "stack";
}

/** About how wide a label is in the pill's font (Inter, 600, 15 px), from the kind of each character. */
function labelWidth(label: string): number {
  let width = 0;
  for (const c of label) {
    if (/[\s.,:;!'`|ijlI]/.test(c)) width += 4.2;
    else if (/[-tfr1()[\]/]/.test(c)) width += 6.1;
    else if (/[mwMW%@]/.test(c)) width += 13.8;
    else if (/[A-Z]/.test(c)) width += 10.4;
    else width += 8.9;
  }
  return width;
}
