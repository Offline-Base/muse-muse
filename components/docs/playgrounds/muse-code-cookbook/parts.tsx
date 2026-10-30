"use client";

import { Fragment, useId, useState, type ReactNode } from "react";
import { CopyButton } from "@/components/CopyButton";
import { CodeView } from "@/components/docs/kit/CodeView";
import { Toggle } from "@/components/docs/kit/Field";
import styles from "@/components/docs/playgrounds/muse-code-cookbook/mcc.module.css";

/**
 * Small pieces the Muse Code recipe demos share: a terminal block for CLI output (the recipes run in a terminal), the
 * contract steps each recipe walks, a verdict box, and the kit's Show code toggle around CodeView for the live calls.
 */

export type Tone = "cmd" | "prompt" | "err" | "ok" | "warn" | "muted" | "plain";

export interface TermLine {
  text: string;
  tone?: Tone;
}

const TONE_CLASS: Record<Tone, string> = {
  cmd: styles.termCmd,
  prompt: styles.termPrompt,
  err: styles.termErr,
  ok: styles.termOk,
  warn: styles.termWarn,
  muted: styles.termMuted,
  plain: "",
};

/** Lines from text: "$ " at the start marks a command, as in the recipes' transcripts. */
export function linesOf(text: string, tone: Tone = "plain"): TermLine[] {
  return text.split("\n").map((t) => (t.startsWith("$ ") ? { text: t.slice(2), tone: "cmd" as const } : { text: t, tone }));
}

/** Plain text of terminal lines, commands written back with "$ ", for the copy button. */
export function plainText(lines: readonly TermLine[]): string {
  return lines.map((l) => (l.tone === "cmd" ? `$ ${l.text}` : l.tone === "prompt" ? `> ${l.text}` : l.text)).join("\n");
}

/**
 * A terminal block. Lines wrap by default; `wrap={false}` keeps each line whole and scrolls sideways instead, for
 * column output such as the audit ledger, where a wrapped row stops lining up.
 */
export function Terminal({ title, lines, live = false, copy = true, wrap = true }: { title: string; lines: readonly TermLine[]; live?: boolean; copy?: boolean; wrap?: boolean }) {
  return (
    <div className={styles.terminal} role="group" aria-label={title}>
      <div className={styles.termHead}>
        <span>{title}</span>
        {copy ? <CopyButton value={plainText(lines)} label={`Copy ${title}`} className="icon-btn icon-btn-plain icon-btn-sm" /> : null}
      </div>
      <pre className={`${styles.termBody} ${wrap ? "" : styles.termNoWrap}`} aria-live={live ? "polite" : undefined}>
        {lines.map((l, i) => (
          <span key={i} className={TONE_CLASS[l.tone ?? "plain"]}>
            {l.text}
            {i < lines.length - 1 ? "\n" : ""}
          </span>
        ))}
      </pre>
    </div>
  );
}

export type StepState = "done" | "failed" | "skipped" | "idle" | "active";

export function Steps({ label, steps }: { label: string; steps: ReadonlyArray<{ id: string; label: string; state: StepState; detail: string }> }) {
  const mark: Record<StepState, string> = { done: "Done", failed: "Failed", skipped: "Skipped", idle: "Not yet", active: "Now" };
  return (
    <ol className={styles.steps} aria-label={label}>
      {steps.map((s) => (
        <li key={s.id} className={`${styles.step} ${styles[`step_${s.state}`] ?? ""}`}>
          <span className={styles.stepLabel}>
            {s.label}
            <span className="sr-only">: {mark[s.state]}</span>
          </span>
          <span>{s.detail}</span>
        </li>
      ))}
    </ol>
  );
}

export type VerdictTone = "ok" | "bad" | "warn" | "info";

const VERDICT_CLASS: Record<VerdictTone, string> = { ok: styles.verdictOk, bad: styles.verdictBad, warn: styles.verdictWarn, info: styles.verdictInfo };

export function Verdict({ tone, title, children, live = true }: { tone: VerdictTone; title: ReactNode; children?: ReactNode; live?: boolean }) {
  return (
    <div className={`${styles.verdict} ${VERDICT_CLASS[tone]}`} role={live ? "status" : undefined} aria-live={live ? "polite" : undefined}>
      <p className={styles.verdictTitle}>{title}</p>
      {children}
    </div>
  );
}

/**
 * An argv as JSON, ["rm","-rf","report.log"], that wraps only between its words: a line never breaks at the hyphen
 * inside "-rf" or in the middle of a path.
 */
export function Argv({ argv }: { argv: readonly string[] }) {
  if (!argv.length) return <code>[]</code>;
  return (
    <code className={styles.argv}>
      {argv.map((word, i) => (
        <Fragment key={i}>
          {i ? <wbr /> : null}
          <span className={styles.argvWord}>
            {i === 0 ? "[" : ""}
            {JSON.stringify(word)}
            {i < argv.length - 1 ? "," : "]"}
          </span>
        </Fragment>
      ))}
    </code>
  );
}

/**
 * Text that wraps only right after a separator, never inside a word: a policy_decision such as
 * reminder_child:read_only:subagent_tool_auto_approval breaks at its colons. Use inside a code element with the argv
 * class (overflow-wrap: normal).
 */
export function BreakAfter({ text, after = ":" }: { text: string; after?: string }) {
  const parts = text.split(after);
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i ? <wbr /> : null}
          {part}
          {i < parts.length - 1 ? after : ""}
        </Fragment>
      ))}
    </>
  );
}

export function Chip({ tone, children }: { tone?: "ok" | "bad" | "warn" | "accent"; children: ReactNode }) {
  const cls = tone === "ok" ? styles.chipOk : tone === "bad" ? styles.chipBad : tone === "warn" ? styles.chipWarn : tone === "accent" ? styles.chipAccent : "";
  return <span className={`${styles.chip} ${cls}`}>{children}</span>;
}

/** The kit's "Show code" switch with the exact request a live call sends (or just sent). */
export function ShowCode({ body, path = "responses", caption }: { body: unknown; path?: string; caption?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={open} onChange={setOpen} />
      </div>
      {open ? <CodeView method="POST" path={path} body={body} caption={caption} /> : null}
    </>
  );
}

export function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  const auto = useId();
  const headingId = `${id ?? auto}-title`;
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h3 className={styles.sectionTitle} id={headingId}>
        {title}
      </h3>
      {children}
    </section>
  );
}
