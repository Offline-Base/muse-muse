"use client";

import type { ReactNode } from "react";
import styles from "@/components/docs/playgrounds/muse-code/muse-code.module.css";

/**
 * Small pieces the Muse Code builders share, on top of the kit (components/docs/kit): a tab panel that stays mounted
 * (so a live chat or a half-built config survives a tab switch; the kit's TabPanel renders only the active one), a
 * labeled select, a number field, a checkbox, a status chip and a notes list.
 */

/** A tab panel for the kit's Tabs (same ids) that keeps its children mounted while hidden. */
export function Panel({ idBase, id, active, children }: { idBase: string; id: string; active: boolean; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`${idBase}-panel-${id}`} aria-labelledby={`${idBase}-tab-${id}`} hidden={!active} tabIndex={0} className="pg-panel">
      {children}
    </div>
  );
}

export interface Option<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export function SelectField<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  hint,
  className,
  disabled,
}: {
  id: string;
  label: ReactNode;
  value: T;
  options: ReadonlyArray<Option<NoInfer<T>>>;
  onChange(value: NoInfer<T>): void;
  hint?: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`pg-field${className ? ` ${className}` : ""}`}>
      <label className="pg-label" htmlFor={id}>
        {label}
      </label>
      <span className="select-wrap">
        <select
          id={id}
          className="select pg-select"
          value={value}
          disabled={disabled}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(e) => onChange(e.target.value as T)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
      </span>
      {hint ? (
        <p className="pg-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  hint,
  className,
  disabled,
}: {
  id: string;
  label: ReactNode;
  /** null shows an empty box (an unset value). */
  value: number | null;
  onChange(value: number | null): void;
  min?: number;
  max?: number;
  step?: number;
  hint?: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`pg-field${className ? ` ${className}` : ""}`}>
      <label className="pg-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        className={`pg-input ${styles.numberInput}`}
        value={value === null || Number.isNaN(value) ? "" : value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
      {hint ? (
        <p className="pg-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Check({
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
    <label className={styles.check} htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export type Tone = "ok" | "warn" | "bad" | "accent" | "plain";

const TONE_CLASS: Record<Tone, string> = {
  ok: styles.chipOk,
  warn: styles.chipWarn,
  bad: styles.chipBad,
  accent: styles.chipAccent,
  plain: "",
};

export function Chip({ tone = "plain", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`${styles.chip} ${TONE_CLASS[tone]}`.trim()}>{children}</span>;
}

/** A short bulleted list of notes; nothing when empty. */
export function Notes({ items, live = false }: { items: ReadonlyArray<ReactNode>; live?: boolean }) {
  if (!items.length) return null;
  return (
    <ul className={styles.notes} aria-live={live ? "polite" : undefined}>
      {items.map((n, i) => (
        <li key={i}>{n}</li>
      ))}
    </ul>
  );
}

/** Inline code in prose. */
export function C({ children }: { children: ReactNode }) {
  return <code className={styles.code}>{children}</code>;
}

/** A message list for builder problems: errors first, then warnings, with role="status" so changes are announced. */
export function Problems({ errors = [], warnings = [], ok }: { errors?: readonly string[]; warnings?: readonly string[]; ok?: string }) {
  if (!errors.length && !warnings.length) {
    return ok ? (
      <p className="pg-hint pg-good" role="status">
        {ok}
      </p>
    ) : (
      <p className="sr-only" role="status" />
    );
  }
  return (
    <div className="pg-warn" role="status">
      {errors.length ? <p className="pg-warn-title pg-bad">{errors.length === 1 ? "1 problem" : `${errors.length} problems`}</p> : null}
      {errors.length ? (
        <ul>
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      {warnings.length ? <p className="pg-warn-title">{errors.length ? "Also worth knowing" : "Worth knowing"}</p> : null}
      {warnings.length ? (
        <ul>
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Text with every query word marked, for search results. Case-insensitive; words under 2 characters are skipped. */
export function Highlight({ text, words }: { text: string; words: readonly string[] }) {
  const terms = words.filter((w) => w.length >= 2).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${terms.join("|")})`, "gi"));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className={styles.mark}>
            {p}
          </mark>
        ) : (
          p
        ),
      )}
    </>
  );
}
