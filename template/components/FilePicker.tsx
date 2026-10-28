"use client";

import { useId, useState, type ChangeEvent } from "react";

/**
 * A file input in the product's style. The real input is visually hidden but labelled, so tests still use
 * page.getByLabel(label).setInputFiles("fixtures/...").
 */
export function FilePicker(props: {
  label: string;
  accept: string;
  onFile: (file: File | null) => void;
  /** The button text, like "Choose a photo". */
  button?: string;
  /** Shown before a file is picked, like "JPG or PNG, up to 4 MB". */
  hint?: string;
  /** Set it when the product loads a sample itself, so the picker shows what is loaded. */
  fileName?: string | null;
  capture?: "environment" | "user";
  disabled?: boolean;
}) {
  const id = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const shown = props.fileName ?? picked;
  const change = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setPicked(file?.name ?? null);
    props.onFile(file);
  };
  return (
    <div className="field">
      <span className="label" id={`${id}-label`}>
        {props.label}
      </span>
      <label className="file-picker">
        <input
          type="file"
          className="visually-hidden"
          aria-labelledby={`${id}-label`}
          accept={props.accept}
          capture={props.capture}
          disabled={props.disabled}
          onChange={change}
        />
        <span className="file-picker-button">{props.button ?? "Choose a file"}</span>
        <span className="file-picker-name">{shown ?? props.hint ?? "No file yet"}</span>
      </label>
    </div>
  );
}
