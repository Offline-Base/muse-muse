"use client";

import { useId, useRef } from "react";
import { Icon } from "@/components/Icon";

/**
 * A small, quiet button for anything that throws work away: clear, delete, reset. It always asks first, in a dialog
 * where "Keep it" has the focus, so a stray tap loses nothing. Put it once, next to what it clears, never as a
 * full-width button and never on every page.
 *   <ConfirmButton label="Clear saved run" question="Clear this run?" detail="Its groups and scores go too." onConfirm={clear} />
 * Tests: click the label, then `page.getByRole("dialog").getByRole("button", { name: confirm })` (by default the label).
 */
export function ConfirmButton({
  label,
  question,
  detail,
  confirm,
  keep = "Keep it",
  onConfirm,
  disabled,
}: {
  label: string;
  /** The dialog's heading, a short question like "Delete this receipt?". */
  question: string;
  /** What goes with it, and that it can't be undone. */
  detail?: string;
  /** The dialog's button that does it. Defaults to the label. */
  confirm?: string;
  keep?: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const close = () => dialog.current?.close();
  // React doesn't put autoFocus on the element in the browser, so showModal() would focus the first button, the
  // one that clears. Move focus to "Keep it" by hand.
  const open = () => {
    dialog.current?.showModal();
    keepRef.current?.focus();
  };
  return (
    <>
      <button type="button" className="text" data-destructive onClick={open} disabled={disabled}>
        <Icon name="trash" size={18} /> {label}
      </button>
      <dialog ref={dialog} aria-labelledby={headingId}>
        <h2 id={headingId}>{question}</h2>
        {detail ? <p>{detail}</p> : null}
        <div className="actions">
          <button
            type="button"
            className="primary"
            onClick={() => {
              close();
              onConfirm();
            }}
          >
            {confirm ?? label}
          </button>
          <button ref={keepRef} type="button" className="secondary" onClick={close}>
            {keep}
          </button>
        </div>
      </dialog>
    </>
  );
}
