"use client";

import { useId, useState, type ReactNode } from "react";
import { Tabs } from "@/components/docs/kit/Tabs";
import styles from "@/components/docs/playgrounds/text/text.module.css";

/**
 * Small pieces the text group's demos share: a class joiner, a single-series bar list (one hue, each value labeled
 * beside its bar, so no legend is needed and nothing hides in a tooltip), a meter for one ratio against a limit, and
 * stat tiles.
 * Each figure is also readable as text: the bars carry their value and an aria-label, the meter says its numbers.
 */

export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

export interface BarItem {
  /** Stable key. */
  id: string;
  label: ReactNode;
  value: number;
  /** The value as shown at the bar's tip ("2,751 tokens"). */
  display: string;
  /** Draw this bar in the muted gray instead of the accent (a baseline to compare against). */
  muted?: boolean;
}

/**
 * Horizontal bars from a shared zero, scaled to the largest value. Each row is label, bar, value in columns every row
 * shares, so the bars are drawn on one track at any width; below about 26rem the label sits above its bar.
 */
export function BarList({ items, label, max }: { items: readonly BarItem[]; label: string; max?: number }) {
  const top = Math.max(max ?? 0, ...items.map((i) => i.value), 1);
  return (
    <div className={styles.barsBox}>
      <ul className={styles.bars} aria-label={label}>
        {items.map((i) => {
          const pct = Math.max(0, Math.min(100, (i.value / top) * 100));
          return (
            <li key={i.id} className={styles.bar}>
              <span className={styles.barLabel}>{i.label}</span>
              <span className={styles.barTrack} aria-hidden>
                <span className={cx(styles.barFill, i.muted && styles.barFillMuted)} style={{ width: `${pct}%` }} />
              </span>
              <span className={styles.barValue}>{i.display}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One ratio against its whole: the filled part in the accent over a track in its soft step. */
export function Meter({ share, label, left, right }: { share: number; label: string; left: ReactNode; right?: ReactNode }) {
  const pct = Math.max(0, Math.min(100, share * 100));
  return (
    <div className={styles.meter}>
      <div className={styles.meterTrack} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100) / 100}>
        <span className={styles.meterFill} style={{ width: `${pct}%` }} />
      </div>
      <div className={styles.meterLabel}>
        <span>{left}</span>
        {right ? <span>{right}</span> : null}
      </div>
    </div>
  );
}

export function Tiles({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className={styles.tiles} role="group" aria-label={label}>
      {children}
    </div>
  );
}

export function Tile({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className={styles.tile}>
      <p className={styles.tileLabel}>{label}</p>
      <p className={styles.tileValue}>{value}</p>
      {note ? <p className={styles.tileNote}>{note}</p> : null}
    </div>
  );
}

export type BadgeTone = "neutral" | "ok" | "bad" | "warn" | "accent";

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  const toneClass = tone === "ok" ? styles.badgeOk : tone === "bad" ? styles.badgeBad : tone === "warn" ? styles.badgeWarn : tone === "accent" ? styles.badgeAccent : null;
  return <span className={cx(styles.badge, toneClass)}>{children}</span>;
}

/** "1,234". */
export function n(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export interface DemoTab {
  id: string;
  label: string;
  count?: number;
  content: ReactNode;
}

/**
 * The kit's underline tabs over panels that all stay mounted (hidden when not selected), so a half-run tool loop or
 * a filled-in form survives a look at the other tab. The kit's TabPanel renders only the active panel, which suits
 * response views but would reset a demo.
 */
export function DemoTabs({
  tabs,
  label,
  initial,
  value,
  onChange,
}: {
  tabs: readonly DemoTab[];
  label: string;
  initial?: string;
  /** Controlled use: the selected tab, and what to call when the reader picks another. */
  value?: string;
  onChange?(id: string): void;
}) {
  const idBase = useId();
  const [own, setOwn] = useState(initial && tabs.some((t) => t.id === initial) ? initial : tabs[0]?.id);
  const active = value ?? own;
  const setActive = (next: string) => {
    setOwn(next);
    onChange?.(next);
  };
  if (tabs.length === 1) return <>{tabs[0].content}</>;
  return (
    <div>
      <Tabs label={label} idBase={idBase} tabs={tabs.map(({ id, label: l, count }) => ({ id, label: l, count }))} value={active ?? ""} onChange={setActive} />
      {tabs.map((t) => (
        <div key={t.id} role="tabpanel" id={`${idBase}-panel-${t.id}`} aria-labelledby={`${idBase}-tab-${t.id}`} hidden={t.id !== active} className={styles.panel}>
          {t.content}
        </div>
      ))}
    </div>
  );
}

/**
 * A <details> whose content renders only once it has been opened: a folded JSON tree of a 37-function library or of
 * every rule check's request would otherwise add hundreds of kilobytes to the page for something few readers open.
 */
export function LazyDetails({ summary, children, className }: { summary: ReactNode; children: ReactNode; className?: string }) {
  const [opened, setOpened] = useState(false);
  return (
    <details className={className ?? styles.details} onToggle={(e) => e.currentTarget.open && setOpened(true)}>
      <summary>{summary}</summary>
      {opened ? children : null}
    </details>
  );
}

/** Toggle pills for choosing several of a few options (aria-pressed buttons in a labeled group). */
export function PickPills<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: ReactNode; disabled?: boolean }>;
  value: readonly T[];
  onChange(next: T[]): void;
  disabled?: boolean;
}) {
  const toggle = (v: T) => {
    const on = value.includes(v);
    onChange(on ? value.filter((x) => x !== v) : options.map((o) => o.value).filter((x) => x === v || value.includes(x)));
  };
  return (
    <div className={styles.picks} role="group" aria-label={label}>
      <span className={styles.picksLabel} aria-hidden>
        {label}
      </span>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="pg-pill"
          aria-pressed={value.includes(o.value)}
          disabled={disabled || o.disabled}
          onClick={() => toggle(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
