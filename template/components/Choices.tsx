"use client";

import { useId } from "react";

/**
 * Pick one of several options whose labels are too long for <Segmented>, or one of five to seven: a radio list, one
 * row per option with its label, an optional `meta` line and a radio at the end. It is a native radio group, so arrow
 * keys move the choice, screen readers read it as a group, and tests use page.getByRole("radio", { name }).check().
 * The label is shown above it, like every field. Segmented renders this by itself when its labels don't fit one row.
 */
export function Choices<T extends string>(props: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string; meta?: string }>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="field">
      <span className="label" id={`${id}-label`}>
        {props.label}
      </span>
      <div className="choices" role="radiogroup" aria-labelledby={`${id}-label`}>
        {props.options.map((option) => (
          <label className="choice" key={option.value}>
            <input
              type="radio"
              name={id}
              value={option.value}
              checked={option.value === props.value}
              disabled={props.disabled}
              onChange={() => props.onChange(option.value)}
            />
            <span className="list-text">
              <span className="list-title">{option.label}</span>
              {option.meta ? <span className="meta">{option.meta}</span> : null}
            </span>
            <span className="radio" aria-hidden="true" />
          </label>
        ))}
      </div>
    </div>
  );
}
