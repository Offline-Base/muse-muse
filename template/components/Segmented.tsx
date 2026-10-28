"use client";

import { useId } from "react";

/**
 * Pick one of two to five short options, like "Indoor" and "Outdoor". It is a native radio group, so arrow keys move
 * the choice, screen readers read it as a group, and tests use page.getByRole("radio", { name: "Outdoor" }).check().
 * The label is shown above it, like every field.
 */
export function Segmented<T extends string>(props: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
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
