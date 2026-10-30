"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Field, PresetPills, Segmented, TextInput, Toggle } from "@/components/docs/kit/Field";
import { copyText } from "@/components/docs/page/clipboard";
import { CheckIcon, CopyIcon } from "@/components/docs/page/icons";
import { Icon } from "@/components/icons";
import type { CodeLang, CodeStep, OptionSpec, OptionValue, Values } from "@/components/docs/playgrounds/open-weights/deploy";
import { visibleOptions } from "@/components/docs/playgrounds/open-weights/deploy";
import { tintCode, type TintSyntax } from "@/lib/docs/client/tint";
import styles from "@/components/docs/playgrounds/open-weights/ow.module.css";

/**
 * The open-weight builders' shared pieces: code cards drawn like the mirrored blocks (the docs-code classes, with the
 * kit's syntax colors and a copy button), titled step lists, the issue boxes, the status line a builder updates as
 * the reader picks, option controls generated from a runtime's options, and the stand-in banner.
 */

const TINT: Record<CodeLang, TintSyntax | null> = { bash: "bash", python: "python", typescript: "typescript", yaml: "bash", json: "typescript", text: null, powershell: "bash" };

function Tinted({ code, lang }: { code: string; lang: CodeLang }) {
  const syntax = TINT[lang];
  const runs = useMemo(() => (syntax ? tintCode(code, syntax) : [{ text: code, tone: null }]), [code, syntax]);
  return (
    <>
      {runs.map((t, i) =>
        t.tone ? (
          <span key={i} className={`pg-tok pg-tok-${t.tone}`}>
            {t.text}
          </span>
        ) : (
          t.text
        ),
      )}
    </>
  );
}

function useCopy() {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async (text: string) => {
    const ok = await copyText(text);
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };
  return { state, copy };
}

function CopyCodeButton({ code, label }: { code: string; label: string }) {
  const { state, copy } = useCopy();
  return (
    <button type="button" className="docs-copy-btn" onClick={() => void copy(code)} aria-label={`Copy ${label}`} title={`Copy ${label}`}>
      {state === "copied" ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : ""}
      </span>
    </button>
  );
}

/** One code block with its language and a copy button. */
export function CodeCard({ code, lang, label }: { code: string; lang: CodeLang; label?: string }) {
  const name = label ?? lang;
  return (
    <div className={`docs-code ${styles.code}`}>
      <div className="docs-code-head">
        <span className="docs-code-label">{name}</span>
        <span className="docs-code-tools">
          <CopyCodeButton code={code} label={`${name} code`} />
        </span>
      </div>
      <div className={`docs-code-body ${styles.codeBody}`} role="group" aria-label={name} tabIndex={0}>
        <pre>
          <code>
            <Tinted code={code} lang={lang} />
          </code>
        </pre>
      </div>
    </div>
  );
}

export interface CodeTab {
  id: string;
  label: string;
  lang: CodeLang;
  code: string;
}

/** Several versions of one snippet (Python, TypeScript, curl) as a tabbed block, like the mirrored tab groups. */
export function CodeTabs({ tabs, label = "Language" }: { tabs: CodeTab[]; label?: string }) {
  const idBase = useId();
  const [picked, setPicked] = useState(tabs[0]?.id ?? "");
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const tab = tabs.find((t) => t.id === picked) ?? tabs[0];
  if (!tab) return null;
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = tabs.length - 1;
    const next = e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    setPicked(tabs[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div className={`docs-code docs-code-grouped ${styles.code}`}>
      <div className="docs-tabs" role="tablist" aria-label={label}>
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${t.id}`}
            aria-selected={t.id === tab.id}
            aria-controls={`${idBase}-panel`}
            tabIndex={t.id === tab.id ? 0 : -1}
            className="docs-tab"
            onClick={() => setPicked(t.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            <span className="docs-tab-text" data-label={t.label}>
              {t.label}
            </span>
          </button>
        ))}
      </div>
      <div className="docs-code-head">
        <span className="docs-code-label">{tab.lang}</span>
        <span className="docs-code-tools">
          <CopyCodeButton code={tab.code} label={`${tab.label} code`} />
        </span>
      </div>
      <div id={`${idBase}-panel`} role="tabpanel" aria-labelledby={`${idBase}-tab-${tab.id}`} className={`docs-code-body ${styles.codeBody}`} tabIndex={0}>
        <pre>
          <code>
            <Tinted code={tab.code} lang={tab.lang} />
          </code>
        </pre>
      </div>
    </div>
  );
}

/**
 * Prose with the code in it set as code: CLI flags, special tokens, snake_case fields, file names and repository ids.
 * Flags and tokens never break across lines (a line break after "--" reads as a different flag).
 */
const CODE_BITS =
  /((?<![\w-])--?[a-z][a-z0-9-]*(?:=[\w.:/-]+)?|<\|[a-z_]+\|>|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?:=[\w.:/,-]+)?|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?:\.[a-z_]+)*\b|\b[\w.+-]+\.(?:gguf|yaml|json|jsonl|pte|ptd|py|wav|bin|jinja|safetensors)\b|\b(?:meta-models|RadixArk|amd|intel-ai|unsloth|ggml-org|Inferact|vllm|lmsysorg|radixark)\/[\w.:+-]+)/g;

export function Rich({ text }: { text: string }) {
  const parts = text.split(CODE_BITS);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className={/^-|^<\|/.test(part) ? styles.flag : styles.inlineCode}>
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** A builder's commands, numbered, one code card each with the page's note under it. */
export function Steps({ steps, label }: { steps: CodeStep[]; label: string }) {
  if (!steps.length) return null;
  return (
    <ol className={styles.steps} aria-label={label}>
      {steps.map((s, i) => (
        <li key={`${i}-${s.title}`} className={styles.step}>
          <h4 className={styles.stepTitle}>{s.title}</h4>
          <CodeCard code={s.code} lang={s.lang} label={s.lang === "text" ? "text" : s.lang} />
          {s.note ? (
            <p className={`${styles.stepNote} pg-advanced`}>
              <Rich text={s.note} />
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * What the page says goes wrong with this pick: errors, then warnings, then notes. The notes wait behind Options in the
 * "Try it live" panel, unless they are the demo's result (`notesAreResult`).
 */
export function Issues({ errors = [], warnings = [], notes = [], noteTitle = "From the page", notesAreResult }: { errors?: string[]; warnings?: string[]; notes?: string[]; noteTitle?: string; notesAreResult?: boolean }) {
  if (!errors.length && !warnings.length && !notes.length) return null;
  return (
    <div className={styles.issues}>
      {errors.length ? (
        <ul className={`${styles.issueList} ${styles.issueError}`} role="alert">
          <li className={styles.issueTitle}>This won&apos;t start</li>
          {errors.map((t) => (
            <li key={t}>
              <Rich text={t} />
            </li>
          ))}
        </ul>
      ) : null}
      {warnings.length ? (
        <ul className={`${styles.issueList} ${styles.issueWarn}`}>
          <li className={styles.issueTitle}>Check this</li>
          {warnings.map((t) => (
            <li key={t}>
              <Rich text={t} />
            </li>
          ))}
        </ul>
      ) : null}
      {notes.length ? (
        <ul className={`${styles.issueList} ${styles.issueNote}${notesAreResult ? "" : " pg-advanced"}`}>
          <li className={styles.issueTitle}>{noteTitle}</li>
          {notes.map((t) => (
            <li key={t}>
              <Rich text={t} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The builder's one-line verdict, announced politely as the reader changes things. */
export function Status({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "bad"; children: ReactNode }) {
  const cls = tone === "ok" ? styles.statusOk : tone === "warn" ? styles.statusWarn : tone === "bad" ? styles.statusBad : "";
  return (
    <div className={`${styles.status} ${cls}`} role="status" aria-live="polite">
      <span>{typeof children === "string" ? <Rich text={children} /> : children}</span>
    </div>
  );
}

export function Badge({ tone, children, wrap }: { tone: "ok" | "warn" | "bad" | "info" | "neutral"; children: ReactNode; wrap?: boolean }) {
  const cls = { ok: styles.badgeOk, warn: styles.badgeWarn, bad: styles.badgeBad, info: styles.badgeInfo, neutral: styles.badgeNeutral }[tone];
  return <span className={`${styles.badge} ${cls}${wrap ? ` ${styles.badgeWrap}` : ""}`}>{children}</span>;
}

/** Label and value pairs, such as a model's quick facts. */
export function Facts({ items, label, advanced }: { items: Array<{ label: string; value: ReactNode }>; label: string; advanced?: boolean }) {
  return (
    <dl className={`${styles.facts}${advanced ? " pg-advanced" : ""}`} aria-label={label}>
      {items.map((f) => (
        <div key={f.label} className={styles.fact}>
          <dt>{f.label}</dt>
          <dd>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The banner every live stand-in carries: what runs, and what it isn't. */
export function StandInBanner({ children }: { children: ReactNode }) {
  return (
    <p className={styles.standin} role="note">
      <Icon name="info" size={16} className={styles.standinIcon} />
      <span>{children}</span>
    </p>
  );
}

/** A labeled native select in the kit's pill style. */
export function SelectField({
  id,
  label,
  value,
  options,
  onChange,
  hint,
  disabled,
  advanced,
}: {
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange(value: string): void;
  hint?: string;
  disabled?: boolean;
  advanced?: boolean;
}) {
  return (
    <Field id={id} label={label} hint={hint} className={advanced ? "pg-advanced" : undefined}>
      <span className="select-wrap">
        <select id={id} className="select pg-select" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-describedby={hint ? `${id}-hint` : undefined}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </span>
    </Field>
  );
}

/** A labeled number box that keeps what's typed (so it can be cleared) and reports numbers. */
export function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  step,
  hint,
  suffix,
  advanced,
}: {
  id: string;
  label: string;
  value: number | string;
  onChange(value: string): void;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  suffix?: string;
  advanced?: boolean;
}) {
  return (
    <Field id={id} label={label} hint={hint} className={`${styles.numberField}${advanced ? " pg-advanced" : ""}`}>
      <span className={styles.row} style={{ gap: 8, flexWrap: "nowrap" }}>
        <TextInput
          id={id}
          type="number"
          inputMode="decimal"
          value={String(value)}
          min={min}
          max={max}
          step={step ?? "any"}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        {suffix ? <span className="pg-muted pg-small">{suffix}</span> : null}
      </span>
    </Field>
  );
}

/**
 * Example pills split so the first row can stay in the "Try it live" panel's simple view: the first `keep` show there,
 * the rest wait behind Options and read as the same list's next line.
 */
export function PresetRows({
  presets,
  keep,
  active,
  onPick,
  label,
  disabled,
}: {
  presets: ReadonlyArray<{ label: string }>;
  keep: number;
  active?: number | null;
  onPick(index: number): void;
  label?: string;
  disabled?: boolean;
}) {
  const at = active ?? -1;
  return (
    <>
      <PresetPills presets={presets.slice(0, keep)} active={at < keep ? active : null} onPick={onPick} label={label} disabled={disabled} />
      {presets.length > keep ? (
        <div className={`${styles.morePresets} pg-advanced`}>
          <PresetPills presets={presets.slice(keep)} active={at >= keep ? at - keep : null} onPick={(i) => onPick(i + keep)} label={label} disabled={disabled} />
        </div>
      ) : null}
    </>
  );
}

/** A segmented choice with a visible label above it. */
export function SegmentField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  disabled,
  advanced,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: NoInfer<T>; label: ReactNode; disabled?: boolean }>;
  onChange(value: NoInfer<T>): void;
  hint?: string;
  disabled?: boolean;
  advanced?: boolean;
}) {
  const id = useId();
  return (
    <div className={`pg-field${advanced ? " pg-advanced" : ""}`}>
      <span className="pg-label" id={`${id}-label`}>
        {label}
      </span>
      <Segmented<T> label={label} options={options} value={value} onChange={onChange} disabled={disabled} size="sm" />
      {hint ? <p className="pg-hint">{hint}</p> : null}
    </div>
  );
}

/**
 * Controls for a runtime's options, in the order it lists them, hiding the ones its current values make moot. In the
 * "Try it live" panel's simple view only the first `simple` choices stay, plus any text field (a path the command
 * needs); the rest wait behind Options.
 */
export function OptionControls({ options, values, onChange, idBase, simple = Infinity }: { options: OptionSpec[]; values: Values; onChange(id: string, value: OptionValue): void; idBase: string; simple?: number }) {
  const shown = visibleOptions(options, values);
  if (!shown.length) return null;
  const kept = new Set([...shown.filter((o) => o.kind === "segmented" || o.kind === "select").slice(0, simple), ...shown.filter((o) => o.kind === "text")].map((o) => o.id));
  return (
    <div className={styles.options}>
      {shown.map((o) => {
        const id = `${idBase}-${o.id}`;
        const v = values[o.id] ?? o.default;
        const advanced = simple !== Infinity && !kept.has(o.id);
        if (o.kind === "toggle") {
          return (
            <div key={o.id} className={`pg-field${advanced ? " pg-advanced" : ""}`}>
              <Toggle id={id} label={o.label} checked={v === true} onChange={(c) => onChange(o.id, c)} />
              {o.hint ? <p className="pg-hint">{o.hint}</p> : null}
            </div>
          );
        }
        if (o.kind === "segmented") {
          return (
            <div key={o.id} className={(o.choices?.length ?? 0) > 3 ? styles.optionWide : undefined}>
              <SegmentField label={o.label} value={String(v)} options={o.choices ?? []} onChange={(x) => onChange(o.id, x)} hint={o.hint} advanced={advanced} />
            </div>
          );
        }
        if (o.kind === "select") {
          return <SelectField key={o.id} id={id} label={o.label} value={String(v)} options={o.choices ?? []} onChange={(x) => onChange(o.id, x)} hint={o.hint} advanced={advanced} />;
        }
        if (o.kind === "number") {
          return <NumberField key={o.id} id={id} label={o.label} value={typeof v === "boolean" ? "" : v} min={o.min} max={o.max} step={o.step} hint={o.hint} onChange={(x) => onChange(o.id, x)} advanced={advanced} />;
        }
        return (
          <Field key={o.id} id={id} label={o.label} hint={o.hint}>
            <TextInput id={id} value={String(v)} onChange={(e) => onChange(o.id, e.target.value)} spellCheck={false} />
          </Field>
        );
      })}
    </div>
  );
}

export { styles };
