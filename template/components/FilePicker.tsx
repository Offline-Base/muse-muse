"use client";

import { useId, useState, type ChangeEvent, type DragEvent } from "react";
import { Icon, type IconName } from "@/components/Icon";

/**
 * A file input styled as a dropzone: tap or click to choose, or drop a file on it. On phones the chooser offers the
 * camera and the photo library; `capture` skips the library and opens the camera. The real input is visually hidden
 * but labelled and focusable, so keyboards and screen readers use it as a normal file input and tests still use
 * page.getByLabel(label).setInputFiles("fixtures/...").
 */
export function FilePicker(props: {
  label: string;
  accept: string;
  onFile: (file: File | null) => void;
  /** What the dropzone says before a pick, like "Take or choose a photo". */
  button?: string;
  /** The way to change a picked file, like "Choose another photo". */
  change?: string;
  /** Shown before a file is picked, like "JPG or PNG, up to 4 MB". */
  hint?: string;
  /**
   * The picked file's name from the product's own state, fileName={file?.name ?? null}: null shows the empty dropzone,
   * so Start over clears it. Leave it out to show whatever the person picked. For a sample, put a File named for people
   * in that state: new File([blob], "Sample receipt", { type: blob.type }).
   */
  fileName?: string | null;
  /** Opens the camera straight away on phones, with no photo library. Use it only with words like "Take a photo". */
  capture?: "environment" | "user";
  disabled?: boolean;
}) {
  const id = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const shown = props.fileName !== undefined ? props.fileName : picked;
  const button = props.button ?? "Choose a file";

  const take = (file: File | null) => {
    setPicked(file?.name ?? null);
    props.onFile(file);
  };
  const change = (e: ChangeEvent<HTMLInputElement>) => {
    take(e.target.files?.[0] ?? null);
    // Empty the input, so picking the same file again (after Start over) still counts as a change.
    e.target.value = "";
  };
  const dragging = (e: DragEvent<HTMLLabelElement>) => {
    if (props.disabled || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setOver(true);
  };
  const leave = (e: DragEvent<HTMLLabelElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
  };
  const drop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!props.disabled && file) take(file);
  };

  return (
    <div className="field">
      <span className="label" id={`${id}-label`}>
        {props.label}
      </span>
      <label
        className="dropzone"
        data-over={over ? "" : undefined}
        data-filled={shown ? "" : undefined}
        onDragEnter={dragging}
        onDragOver={dragging}
        onDragLeave={leave}
        onDrop={drop}
      >
        <input
          type="file"
          className="visually-hidden"
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-title ${id}-hint`}
          accept={props.accept}
          capture={props.capture}
          disabled={props.disabled}
          onChange={change}
        />
        <span className="icon-circle" aria-hidden="true">
          <Icon name={shown ? "check" : iconFor(props.accept, props.capture)} size={22} />
        </span>
        <span className="dropzone-text">
          <span className="dropzone-title" id={`${id}-title`} aria-live="polite" data-user-text={shown ? "" : undefined}>
            {shown ?? button}
          </span>
          <span className="dropzone-hint" id={`${id}-hint`}>
            {shown ? (props.change ?? "Choose another") : (props.hint ?? <span className="on-pointer">or drop it here</span>)}
          </span>
        </span>
      </label>
    </div>
  );
}

function iconFor(accept: string, capture?: string): IconName {
  if (capture && accept.includes("image")) return "camera";
  if (accept.startsWith("image")) return "image";
  if (accept.startsWith("audio")) return "mic";
  if (accept.startsWith("video")) return "play";
  if (accept.includes("pdf") || accept.includes("text")) return "file";
  return "upload";
}
