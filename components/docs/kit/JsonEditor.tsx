"use client";

import { useMemo } from "react";
import { formatJson, parseJsonText } from "@/lib/docs/client/json";

/**
 * A request body editor: a monospace textarea that says whether its JSON is valid (and where it breaks, by line and
 * column), with Format and, when there's an original to go back to, Reset. The text is the parent's state, so the
 * parent decides what to do with it.
 */
export function JsonEditor({
  id,
  value,
  onChange,
  label = "Request body",
  rows = 12,
  resetTo,
  hint,
  disabled,
}: {
  id: string;
  value: string;
  onChange(text: string): void;
  label?: string;
  rows?: number;
  /** The original text; Reset appears once the text differs from it. */
  resetTo?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const parsed = useMemo(() => parseJsonText(value), [value]);
  const lines = Math.min(Math.max(value.split("\n").length + 1, 4), rows * 3);
  return (
    <div className="pg-field pg-json-editor">
      <div className="pg-json-editor-head">
        <label className="pg-label" htmlFor={id}>
          {label}
        </label>
        <span className="pg-json-editor-actions">
          {resetTo !== undefined && value !== resetTo ? (
            <button type="button" className="btn btn-sm" onClick={() => onChange(resetTo)} disabled={disabled}>
              Reset
            </button>
          ) : null}
          <button type="button" className="btn btn-sm btn-outline" onClick={() => parsed.ok && onChange(formatJson(parsed.value))} disabled={disabled || !parsed.ok}>
            Format
          </button>
        </span>
      </div>
      <textarea
        id={id}
        className="pg-textarea pg-code-input"
        value={value}
        rows={Math.min(lines, rows)}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        disabled={disabled}
        aria-invalid={!parsed.ok}
        aria-describedby={`${id}-status${hint ? ` ${id}-hint` : ""}`}
        onChange={(e) => onChange(e.target.value)}
      />
      <p id={`${id}-status`} className={`pg-json-status ${parsed.ok ? "pg-good" : "pg-bad"}`} aria-live="polite">
        {parsed.ok ? "Valid JSON" : parsed.message}
      </p>
      {hint ? (
        <p className="pg-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
