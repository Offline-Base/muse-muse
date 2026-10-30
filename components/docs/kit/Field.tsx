"use client";

import { useSyncExternalStore, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type Ref, type TextareaHTMLAttributes } from "react";
import { EFFORT_LABELS, effortsFor, fitEffort, type Effort } from "@/lib/docs/client/models";

/**
 * Small form controls for the playgrounds, styled by kit.css: a labeled field, text inputs, a switch, a segmented
 * pill group (a radio group), preset pills and the reasoning-effort menu. Each one is a native control underneath, so
 * labels, focus and keyboard use work the standard way.
 */

export function Field({
  id,
  label,
  hint,
  children,
  className,
}: {
  /** The id of the control inside, so the label points at it. */
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`pg-field${className ? ` ${className}` : ""}`}>
      <label className="pg-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint ? (
        <p className="pg-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextInput({ className, ref, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} type="text" className={`pg-input${className ? ` ${className}` : ""}`} {...props} />;
}

export function TextArea({ className, ref, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} className={`pg-textarea${className ? ` ${className}` : ""}`} {...props} />;
}

/** A switch: a button with role="switch", labeled by the text next to it. */
/**
 * Controls that tune a request rather than make it. They carry `pg-advanced`, and the "Try it live" panel hides them
 * until the reader turns on Options, so a demo opens as what to ask and a Run button (app/docs/docs.css).
 */
const ADVANCED_TOGGLE = /^(show |stream|reasoning summary|raw wire|parallel calls|web search|expires_after|pause after)/i;
const ADVANCED_SEGMENT = /^(protocol|api|adapter|mask encoding|how the image is sent)$/i;

export function Toggle({
  id,
  label,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: ReactNode;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
}) {
  return (
    <span className={typeof label === "string" && ADVANCED_TOGGLE.test(label) ? "pg-toggle pg-advanced" : "pg-toggle"}>
      <button type="button" role="switch" id={id} className="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} />
      <label htmlFor={id} className="pg-toggle-label">
        {label}
      </label>
    </span>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

/**
 * One choice out of a few, as pills (a radio group: arrow keys move the choice). The choice's type comes from
 * `value` alone (NoInfer elsewhere), so `onChange={setState}` works with a union-typed state.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  size = "md",
}: {
  label: string;
  options: ReadonlyArray<SegmentOption<NoInfer<T>>>;
  value: T;
  onChange(value: NoInfer<T>): void;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  const enabled = options.filter((o) => !o.disabled);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step || !enabled.length) return;
    e.preventDefault();
    const at = enabled.findIndex((o) => o.value === value);
    const next = enabled[(at + step + enabled.length) % enabled.length];
    onChange(next.value);
    const group = e.currentTarget.parentElement;
    const index = options.indexOf(next);
    (group?.children[index] as HTMLElement | undefined)?.focus();
  };
  return (
    <div className={`pg-seg pg-seg-${size}${ADVANCED_SEGMENT.test(label) ? " pg-advanced" : ""}`} role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className="pg-seg-btn"
            disabled={disabled || o.disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={onKeyDown}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Example inputs a page offers, as pills; picking one fills the form. */
export function PresetPills({
  label = "Try",
  presets,
  active,
  onPick,
  disabled,
}: {
  label?: string;
  presets: ReadonlyArray<{ label: string }>;
  /** Index of the preset in use, if any. */
  active?: number | null;
  onPick(index: number): void;
  disabled?: boolean;
}) {
  if (!presets.length) return null;
  return (
    <div className="pg-presets" role="group" aria-label={label}>
      <span className="pg-presets-label" aria-hidden>
        {label}
      </span>
      {presets.map((p, i) => (
        <button key={`${i}-${p.label}`} type="button" className="pg-pill" aria-pressed={active === i} disabled={disabled} onClick={() => onPick(i)}>
          {p.label}
        </button>
      ))}
    </div>
  );
}

/** The reasoning-effort menu, with only the levels the model accepts. "Default" leaves the field out. */
export function EffortSelect({
  id,
  model,
  value,
  onChange,
  disabled,
  label = "Reasoning",
}: {
  id: string;
  model: string;
  value: Effort | null;
  onChange(effort: Effort | null): void;
  disabled?: boolean;
  label?: string;
}) {
  const efforts = effortsFor(model);
  // A level the model doesn't take (max after switching to Contributor) shows as the highest it does, which is also
  // what the playgrounds send (fitEffort).
  const shown = fitEffort(model, value);
  return (
    <span className="pg-inline-field pg-advanced">
      <label className="pg-label" htmlFor={id}>
        {label}
      </label>
      <span className="select-wrap">
        <select
          id={id}
          className="select pg-select"
          value={shown ?? ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value ? (e.target.value as Effort) : null)}
        >
          <option value="">Default</option>
          {efforts.map((e) => (
            <option key={e} value={e}>
              {EFFORT_LABELS[e]}
            </option>
          ))}
        </select>
      </span>
    </span>
  );
}

const noSubscribe = () => () => {};

/** "Cmd" on Apple platforms, "Ctrl" elsewhere, and null on a touch screen with no keyboard to press it on. */
function modKeySnapshot(): "Cmd" | "Ctrl" | null {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const touchOnly = window.matchMedia?.("(pointer: coarse)").matches && !window.matchMedia?.("(any-pointer: fine)").matches;
  if (touchOnly) return null;
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform) ? "Cmd" : "Ctrl";
}

/**
 * The shortcut hint for a prompt box, such as "Cmd+Enter to ask": the platform's modifier once the page is in the
 * browser (the server renders "Ctrl"), and null on phones and tablets without a keyboard, where it doesn't apply.
 */
export function useModEnterHint(action: string): string | null {
  const mod = useSyncExternalStore(noSubscribe, modKeySnapshot, () => "Ctrl" as const);
  return mod ? `${mod}+Enter ${action}` : null;
}

/** Ctrl+Enter or Cmd+Enter in a prompt box runs it, the way most playgrounds do. */
export function runOnModEnter(run: () => void) {
  return (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      run();
    }
  };
}
