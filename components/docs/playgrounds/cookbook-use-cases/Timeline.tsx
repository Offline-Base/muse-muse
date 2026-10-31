"use client";

import { useState, type ReactNode } from "react";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { latencyLabel } from "@/components/docs/kit/ResponseView";
import { prettyArguments, ToolCalls } from "@/components/docs/kit/StreamView";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { TextInput } from "@/components/docs/kit/Field";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import { formatUsd } from "@/lib/docs/client/cost";
import { docsModelLabel } from "@/lib/docs/client/models";
import type { ToolCall } from "@/lib/docs/client/stream";
import styles from "@/components/docs/playgrounds/cookbook-use-cases/cuc.module.css";
import { commentaryText, functionCalls, responseStatus, responseText, webSearchCount } from "@/components/docs/playgrounds/cookbook-use-cases/lib/responses";
import type { Entry, HumanEntry, ModelEntry, ToolEntry } from "@/components/docs/playgrounds/cookbook-use-cases/useAgentRun";

/**
 * The timeline an agent run leaves (useAgentRun): model calls with what the model said and the tools it asked for,
 * each tool the page ran and what it returned, the harness's notes, and questions waiting for the reader. Every model
 * call keeps its exact request and reply JSON behind a fold.
 */

const PALETTE = ["var(--chart-1)", "var(--chart-3)", "var(--chart-2)", "var(--chart-4)", "var(--chart-6)", "var(--chart-5)"];

/** A steady color per agent name, so one agent reads the same across the timeline and the board. */
export function agentColor(name: string, order?: readonly string[]): string {
  const at = order?.indexOf(name) ?? -1;
  if (at >= 0) return PALETTE[at % PALETTE.length];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function AgentBadge({ name, order, label }: { name: string; order?: readonly string[]; label?: string }) {
  return (
    <span className={styles.agent} style={{ ["--badge" as string]: agentColor(name, order) }}>
      {label ?? name}
    </span>
  );
}

function clip(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: `${text.slice(0, max)}\n... (${text.length - max} more characters)`, cut: true } : { text, cut: false };
}

function LongText({ text, max = 1600, className }: { text: string; max?: number; className?: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? { text, cut: false } : clip(text, max);
  return (
    <>
      <pre className={className ?? "pg-pre"}>{shown.text}</pre>
      {shown.cut || all ? (
        <button type="button" className="btn btn-sm" onClick={() => setAll(!all)}>
          {all ? "Show less" : "Show all"}
        </button>
      ) : null}
    </>
  );
}

function ModelItem({ e, n, order }: { e: ModelEntry; n: number; order?: readonly string[] }) {
  const calls = e.response ? functionCalls(e.response) : [];
  const commentary = e.response ? commentaryText(e.response) : "";
  const text = e.response && !calls.length ? responseText(e.response) : "";
  const status = e.response ? responseStatus(e.response) : null;
  const searches = e.response ? webSearchCount(e.response) : 0;
  const toolCalls: ToolCall[] = calls.map((c) => ({ id: c.id, callId: c.callId, name: c.name, arguments: c.arguments, done: true, kind: "function" }));
  return (
    <li className={styles.entry} data-depth={Math.min(e.depth, 2)}>
      <p className={styles.entryHead}>
        <span className="pg-step-num">{n}</span>
        <AgentBadge name={e.agent} order={order} />
        <span>Model call {e.call}</span>
        <span className={styles.entryMeta}>
          {e.status === "running" ? (
            <span className="pg-status pg-status-busy">
              <span className="pg-dot pg-dot-busy" aria-hidden />
              Running
            </span>
          ) : e.status === "stopped" ? (
            <span className="pg-status">Stopped</span>
          ) : (
            <span className={`pg-status ${e.status === "error" ? "pg-status-bad" : "pg-status-ok"}`}>
              <span className={`pg-dot ${e.status === "error" ? "pg-dot-bad" : "pg-dot-ok"}`} aria-hidden />
              {e.httpStatus ?? ""} {e.status === "error" ? "Error" : "OK"}
            </span>
          )}
          {e.model ? <span>{docsModelLabel(e.model)}</span> : null}
          {e.elapsedMs ? <span>{latencyLabel(e.elapsedMs)}</span> : null}
          {e.response?.usage ? <UsageLine model={e.model ?? null} usage={e.response.usage} webSearches={searches || undefined} /> : null}
        </span>
      </p>
      {e.error ? <div className="pg-hint pg-bad">{e.error.message}</div> : null}
      {commentary ? <MarkdownText className={styles.commentary} text={commentary} /> : null}
      {status && status.status === "incomplete" ? (
        <div className="pg-hint pg-bad">The reply stopped early ({status.reason ?? "incomplete"}).</div>
      ) : null}
      {toolCalls.length ? (
        <div className="pg-advanced">
          <ToolCalls calls={toolCalls} title={toolCalls.length > 1 ? `Asked for ${toolCalls.length} tool calls` : "Asked for a tool call"} />
        </div>
      ) : null}
      {text ? <MarkdownText className={styles.answer} text={text} /> : null}
      <details className="pg-raw pg-advanced">
        <summary>Request{e.response ? " and reply" : ""} JSON</summary>
        <p className="pg-section-label">Request</p>
        <JsonTree value={e.body} openDepth={1} />
        {e.response ? (
          <>
            <p className="pg-section-label">Reply</p>
            <JsonTree value={e.response} openDepth={1} />
          </>
        ) : null}
      </details>
    </li>
  );
}

function ToolItem({ e, n, order, render }: { e: ToolEntry; n: number; order?: readonly string[]; render?: (e: ToolEntry) => ReactNode }) {
  const custom = render?.(e);
  // The step's own output is a detail in the simple view, unless it's why the step failed.
  const output = custom ?? (e.output !== undefined ? <LongText text={e.output || "(empty)"} max={1200} /> : null);
  return (
    <li className={styles.entry} data-depth={Math.min(e.depth, 2)}>
      <p className={styles.entryHead}>
        <span className="pg-step-num">{n}</span>
        <AgentBadge name={e.agent} order={order} />
        <code className="pg-toolcall-name">{e.name}</code>
        <span className={styles.toolBadge} data-status={e.status}>
          {e.status === "running" ? "running" : e.status === "denied" ? "denied" : e.status === "error" ? "error" : "ran"}
        </span>
        <span className={styles.entryMeta}>
          {e.note ? <span>{e.note}</span> : null}
          {e.ms !== undefined ? <span>{e.ms} ms</span> : null}
        </span>
      </p>
      {e.args && e.args !== "{}" ? (
        // Long arguments (a whole file for write_file) are already shown in the model call above, so fold them here.
        e.args.length > 280 ? (
          <details className="pg-raw pg-advanced">
            <summary>Arguments ({e.args.length.toLocaleString()} characters, shown in the call above)</summary>
            <pre className="pg-pre">{prettyArguments(e.args)}</pre>
          </details>
        ) : (
          <pre className="pg-pre pg-advanced">{prettyArguments(e.args)}</pre>
        )
      ) : null}
      {output ? <div className={e.status === "error" || e.status === "denied" ? styles.toolOutput : `${styles.toolOutput} pg-advanced`}>{output}</div> : null}
    </li>
  );
}

function HumanItem({ e, n, order, onAnswer }: { e: HumanEntry; n: number; order?: readonly string[]; onAnswer(id: number, v: string): void }) {
  const [text, setText] = useState("");
  const waiting = e.status === "waiting";
  return (
    <li className={styles.entry} data-depth={Math.min(e.depth, 2)}>
      <p className={styles.entryHead}>
        <span className="pg-step-num">{n}</span>
        <AgentBadge name={e.agent} order={order} />
        <span>{e.title ?? "Asks you"}</span>
      </p>
      <div className={styles.human} data-status={e.status} role={waiting ? "group" : undefined} aria-label={waiting ? e.title ?? "Your answer" : undefined}>
        <p className={styles.humanPrompt}>{e.prompt}</p>
        {waiting ? (
          <>
            <div className={styles.options}>
              {e.options.map((o) => (
                <button key={o.value} type="button" className={styles.option} onClick={() => onAnswer(e.id, o.value)}>
                  <span>{o.label}</span>
                  {o.hint ? <span className={styles.optionHint}>{o.hint}</span> : null}
                </button>
              ))}
            </div>
            {e.allowText ? (
              <form
                className={styles.textAnswer}
                onSubmit={(ev) => {
                  ev.preventDefault();
                  if (text.trim()) onAnswer(e.id, text.trim());
                }}
              >
                <label className="sr-only" htmlFor={`human-${e.id}`}>
                  {e.textLabel ?? "Your answer"}
                </label>
                <TextInput id={`human-${e.id}`} placeholder={e.textLabel ?? "Or type your own answer"} value={text} onChange={(ev) => setText(ev.target.value)} />
                <button type="submit" className="btn btn-sm" disabled={!text.trim()}>
                  Send
                </button>
              </form>
            ) : null}
          </>
        ) : (
          <p className="pg-small">
            {e.status === "stopped" ? (
              <span className="pg-muted">No answer: the run was stopped.</span>
            ) : (
              <>
                <span className="pg-muted">You answered: </span>
                <strong>{e.options.find((o) => o.value === e.answer)?.label ?? e.answer}</strong>
              </>
            )}
          </p>
        )}
      </div>
    </li>
  );
}

export function Timeline({
  entries,
  onAnswer,
  order,
  renderTool,
  label = "Run timeline",
  window: shown = 60,
}: {
  entries: Entry[];
  onAnswer(id: number, value: string): void;
  /** Agent names in the order their colors should follow. */
  order?: readonly string[];
  /** A custom view of a tool's result (a diff, a screenshot); return undefined for the default. */
  renderTool?: (e: ToolEntry) => ReactNode;
  label?: string;
  /** How many of the newest entries to show before "Show earlier steps". */
  window?: number;
}) {
  const [all, setAll] = useState(false);
  if (!entries.length) return null;
  // Numbers count every step, shown or not, so they stay stable as the window moves.
  let n = 0;
  const numbered = entries.map((e) => ({ e, n: e.kind === "note" ? 0 : ++n }));
  const hidden = all ? 0 : Math.max(0, numbered.length - shown);
  const visible = numbered.slice(hidden);
  return (
    <>
      {hidden ? (
        <button type="button" className="btn btn-sm" onClick={() => setAll(true)} style={{ alignSelf: "flex-start" }}>
          Show the {hidden} earlier entries
        </button>
      ) : null}
      <ol className={styles.timeline} aria-label={label}>
        {visible.map(({ e, n: num }) => {
          if (e.kind === "note") {
            return (
              <li key={e.id} className={styles.note} data-tone={e.tone}>
                <span className={styles.noteMark} aria-hidden>
                  {e.tone === "good" ? "\u2713" : e.tone === "bad" ? "\u2717" : e.tone === "warn" ? "!" : "\u203a"}
                </span>
                <span>
                  {e.agent ? <AgentBadge name={e.agent} order={order} /> : null} {e.text}
                </span>
              </li>
            );
          }
          if (e.kind === "model") return <ModelItem key={e.id} e={e} n={num} order={order} />;
          if (e.kind === "tool") return <ToolItem key={e.id} e={e} n={num} order={order} render={renderTool} />;
          return <HumanItem key={e.id} e={e} n={num} order={order} onAnswer={onAnswer} />;
        })}
      </ol>
    </>
  );
}

/** The status line over a run: calls so far, the estimated cost, and Next step while a paused run waits. */
export function RunBar({
  busy,
  modelCalls,
  totalUsd,
  waitingStep,
  onAdvance,
  children,
}: {
  busy: boolean;
  modelCalls: number;
  totalUsd: number;
  waitingStep: boolean;
  onAdvance(): void;
  children?: ReactNode;
}) {
  if (!busy && !modelCalls) return null;
  return (
    <div className={styles.runbar} role="status" aria-live="polite">
      <span>
        {busy ? (waitingStep ? "Paused before the next step." : "Running...") : "Run finished."} {modelCalls} model call{modelCalls === 1 ? "" : "s"},{" "}
        {formatUsd(totalUsd)} est.
      </span>
      <span className={styles.runbarSpacer} />
      {children}
      {waitingStep ? (
        <button type="button" className="btn btn-sm btn-primary" onClick={onAdvance}>
          Next step
        </button>
      ) : null}
    </div>
  );
}
