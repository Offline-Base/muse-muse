"use client";

import { useId, useState, type ReactNode } from "react";
import { Tabs } from "@/components/docs/kit/Tabs";
import styles from "@/components/docs/playgrounds/cookbook-fundamentals/cookbook.module.css";

/**
 * Small pieces the cookbook-fundamentals demos share, in the kit's look: tabs whose panels stay mounted (a run in one
 * tab keeps its result while you read another), stat tiles, single-series bars, a meter, a two-part bar, status pills
 * and file views. Charts follow one rule set: one series, one color, values written next to the marks (so nothing is
 * read from color alone), text in text colors.
 */

export interface DemoTab {
  id: string;
  label: string;
  content: ReactNode;
}

export function DemoTabs({ label, tabs, initial }: { label: string; tabs: DemoTab[]; initial?: string }) {
  const idBase = useId();
  const [tab, setTab] = useState(initial && tabs.some((t) => t.id === initial) ? initial : tabs[0]?.id ?? "");
  return (
    <div>
      <Tabs label={label} idBase={idBase} tabs={tabs.map((t) => ({ id: t.id, label: t.label }))} value={tab} onChange={setTab} />
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${idBase}-panel-${t.id}`}
          aria-labelledby={`${idBase}-tab-${t.id}`}
          hidden={t.id !== tab}
          tabIndex={0}
          className={styles.tabPanel}
        >
          {t.content}
        </div>
      ))}
    </div>
  );
}

export interface StatItem {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}

export function Stats({ items, label }: { items: StatItem[]; label?: string }) {
  if (!items.length) return null;
  return (
    <dl className={styles.stats} aria-label={label}>
      {items.map((s) => (
        <div key={s.label} className={styles.stat}>
          <dt className={styles.statLabel}>{s.label}</dt>
          <dd className={styles.statValue} style={{ margin: 0 }}>
            {s.value}
          </dd>
          {s.note ? <dd className={styles.statNote} style={{ margin: 0 }}>{s.note}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

export interface BarItem {
  key: string;
  label: string;
  value: number;
  /** The value as written beside the bar. Defaults to the number with thousands separators. */
  display?: string;
  /** Gray instead of the series color, for the parts that aren't the point. */
  muted?: boolean;
  title?: string;
}

/** Horizontal bars for one series, longest = max, each with its value written at the tip. */
export function BarList({ items, label, max }: { items: BarItem[]; label: string; max?: number }) {
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className={styles.bars} aria-label={label}>
      {items.map((i) => {
        const share = top > 0 ? Math.max(0, Math.min(1, i.value / top)) : 0;
        return (
          <li key={i.key} className={styles.barRow} title={i.title}>
            <span className={styles.barLabel}>{i.label}</span>
            <span className={styles.barCell}>
              <span className={styles.barFill} data-muted={i.muted ? "true" : undefined} style={{ width: `calc((100% - 84px) * ${share.toFixed(4)})` }} aria-hidden />
              <span className={styles.barValue}>{i.display ?? i.value.toLocaleString("en-US")}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** One value against a limit: the fill turns to warning past `warnAt` and to danger past `badAt` (shares of max). */
export function Meter({
  value,
  max,
  label,
  left,
  right,
  warnAt = 0.8,
  badAt = 1,
  markAt,
}: {
  value: number;
  max: number;
  label: string;
  left?: ReactNode;
  right?: ReactNode;
  warnAt?: number;
  badAt?: number;
  /** A tick on the track, as a share of max (a compaction threshold). */
  markAt?: number;
}) {
  const share = max > 0 ? value / max : 0;
  const state = share >= badAt ? "bad" : share >= warnAt ? "warn" : undefined;
  return (
    <div className={styles.meter}>
      <div className={styles.meterLabel}>
        <span>{left}</span>
        <span>{right}</span>
      </div>
      <div
        className={styles.meterTrack}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(value, max)}
        aria-valuetext={`${Math.round(share * 1000) / 10}%`}
      >
        <div className={styles.meterFill} data-state={state} style={{ width: `${Math.min(100, share * 100).toFixed(2)}%` }} />
        {markAt !== undefined ? <span className={styles.meterMark} style={{ left: `${Math.min(100, markAt * 100)}%` }} aria-hidden /> : null}
      </div>
    </div>
  );
}

/** Part to whole: the emphasized part in the series color, the rest gray, a 2px gap between, and a legend. */
export function Parts({ parts, label }: { parts: Array<{ label: string; value: number; muted?: boolean }>; label: string }) {
  const total = parts.reduce((n, p) => n + Math.max(0, p.value), 0);
  return (
    <div className={styles.stack} style={{ gap: 6 }}>
      <div className={styles.parts} role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.value.toLocaleString("en-US")}`).join(", ")}`}>
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <span key={p.label} className={styles.part} data-muted={p.muted ? "true" : undefined} style={{ flex: `${p.value} 0 0` }} />
          ))}
        {total === 0 ? <span className={styles.part} data-muted="true" style={{ flex: "1 0 0" }} /> : null}
      </div>
      <ul className={styles.legend}>
        {parts.map((p) => (
          <li key={p.label}>
            <span className={styles.swatch} data-muted={p.muted ? "true" : undefined} aria-hidden />
            {p.label} {p.value.toLocaleString("en-US")}
          </li>
        ))}
      </ul>
    </div>
  );
}

export type Tone = "ok" | "bad" | "warn" | "busy" | "idle";

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={styles.status} data-tone={tone}>
      {children}
    </span>
  );
}

/** A file with line numbers. */
export function CodeLines({ text, label }: { text: string; label: string }) {
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <pre className={styles.code} role="region" aria-label={label} tabIndex={0}>
      <code>
        {lines.map((l, i) => (
          <span key={i} className={styles.codeLine}>
            {l || " "}
          </span>
        ))}
      </code>
    </pre>
  );
}

/** A unified diff, its added and removed lines shaded. */
export function DiffView({ diff, label }: { diff: string; label: string }) {
  if (!diff) return <p className={styles.note}>No changes.</p>;
  return (
    <pre className={styles.diff} role="region" aria-label={label} tabIndex={0}>
      <code>
        {diff.split("\n").map((l, i) => (
          <span
            key={i}
            className={styles.diffLine}
            data-op={l.startsWith("@@") ? "hunk" : l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : undefined}
          >
            {l || " "}
          </span>
        ))}
      </code>
    </pre>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className={styles.note}>{children}</p>;
}

/** "640 ms", "1.4 s": the kit's latency format, for times that aren't a whole call's. */
export function ms(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`;
}

export function count(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? "n/a" : Math.round(n).toLocaleString("en-US");
}
