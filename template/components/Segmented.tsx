"use client";

import { useId } from "react";
import { Choices } from "./Choices";

/**
 * Pick one of two to four short options, like "Indoor" and "Outdoor": one track, the chosen option raised on it,
 * always one row. It is a native radio group, so arrow keys move the choice, screen readers read it as a group, and
 * tests use page.getByRole("radio", { name: "Outdoor" }).check(). The label is shown above it, like every field. When
 * the labels don't fit one row on a phone (segmentedLayout), it renders the radio list from components/Choices
 * instead, with the same props and the same radios, so a choice never wraps or stacks into buttons.
 */
export function Segmented<T extends string>(props: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const id = useId();
  if (segmentedLayout(props.options.map((option) => option.label)) === "list") return <Choices {...props} />;
  return (
    <div className="field">
      <span className="label" id={`${id}-label`}>
        {props.label}
      </span>
      <div className="segmented" role="radiogroup" aria-labelledby={`${id}-label`}>
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

/** The track's inner width in a phone's card: the card's 326 px row less the track's 4 px of padding on each side. */
const TRACK = 318;

/**
 * "row" when there are 2 to 4 options and every label, plus its segment's 24 px of padding, fits its equal share of
 * the track on one line; otherwise "list", the radio list.
 */
export function segmentedLayout(labels: readonly string[]): "row" | "list" {
  if (labels.length < 2 || labels.length > 4) return "list";
  const share = TRACK / labels.length;
  return labels.every((label) => labelWidth(label) + 24 <= share) ? "row" : "list";
}

/** About how wide a label is in the chosen segment's font (Inter, 600, 15 px), from the kind of each character. */
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
