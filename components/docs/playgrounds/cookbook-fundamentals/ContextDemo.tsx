"use client";

import { useId, useRef, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { EffortSelect, Segmented, Toggle } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { latencyLabel } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import styles from "@/components/docs/playgrounds/cookbook-fundamentals/cookbook.module.css";
import {
  COMPACT_AT,
  compactionMessages,
  defaultDeclaredWindow,
  extractState,
  meterWarnAt,
  planRequest,
  shouldCompact,
  STRATEGY_LABEL,
  type Msg,
  type Strategy,
  type Transcript,
} from "@/components/docs/playgrounds/cookbook-fundamentals/context";
import { BarList, Meter, Note, StatusPill } from "@/components/docs/playgrounds/cookbook-fundamentals/ui";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import { tokenUsage } from "@/lib/docs/client/cost";
import { DEFAULT_TEXT_MODEL, fitEffort, type Effort } from "@/lib/docs/client/models";
import { collectReply } from "@/lib/docs/client/stream";

/**
 * The multi-turn-context-management recipe, live and scaled down to a design conversation: the recipe's growing task
 * (an initial spec, then three requirement changes given one at a time), then a check that asks for every decision so
 * far. Each strategy decides what goes back to the model each turn: the whole history, a sliding window, the running
 * STATE.md the model keeps (the recipe's main technique), or a summary that compacts older turns once the context
 * passes a threshold of a window you declare. Every turn shows what it sent and the input tokens it cost.
 */

export interface ContextDemoProps {
  slug: string;
  instructions: string;
  script: Array<{ label: string; content: string }>;
}

type WindowSize = "1000" | "2000" | "8000" | "1048576";

interface TurnRow {
  n: number;
  label: string;
  user: string;
  reply: string;
  state: string | null;
  sent: number;
  dropped: number;
  note: string;
  input: number;
  cached: number;
  output: number;
  usage: unknown;
  model: string | null;
  ms: number;
  compacted: boolean;
}

interface RunSummary {
  strategy: Strategy;
  turns: number;
  totalInput: number;
  peakInput: number;
  compactions: number;
  probe: string;
}

export function ContextDemo({ instructions, script }: ContextDemoProps) {
  const id = useId();
  const runner = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>("minimal");
  const [strategy, setStrategy] = useState<Strategy>("state");
  const [windowMessages, setWindowMessages] = useState<"3" | "5">("3");
  // The strategy's own default (defaultDeclaredWindow) until the reader picks a window.
  const [declaredPick, setDeclared] = useState<WindowSize | null>(null);
  const declared = declaredPick ?? (String(defaultDeclaredWindow(strategy)) as WindowSize);
  const [rows, setRows] = useState<TurnRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [summaries, setSummaries] = useState<RunSummary[]>([]);
  const [lastBody, setLastBody] = useState<Record<string, unknown> | null>(null);
  const [showCode, setShowCode] = useState(false);
  const transcript = useRef<Transcript>({ instructions, turns: [], state: null, summary: null, summaryUpTo: 0 });
  const stopped = useRef(false);
  const compactions = useRef(0);

  const reset = () => {
    runner.reset();
    transcript.current = { instructions, turns: [], state: null, summary: null, summaryUpTo: 0 };
    compactions.current = 0;
    setRows([]);
    setLastBody(null);
  };

  const bodyOf = (messages: Msg[]) => {
    const e = fitEffort(model, effort);
    return { model, messages: messages.map((m) => ({ role: m.role, content: m.content })), ...(e ? { reasoning_effort: e } : {}) };
  };

  /** Runs one scripted turn under the chosen strategy. Returns false when it failed or was stopped. */
  const runTurn = async (index: number, priorInput: number): Promise<{ ok: boolean; input: number }> => {
    const step = script[index];
    const t = transcript.current;
    let compacted = false;
    // Compaction: when the last request passed the threshold, fold the older turns into one note first.
    if (strategy === "summary" && shouldCompact(priorInput, Number(declared)) && t.turns.length > 2) {
      const upTo = t.turns.length - (t.turns[t.turns.length - 1]?.role === "assistant" ? 2 : 1);
      const res = await runner.run("chat/completions", { method: "POST", body: bodyOf(compactionMessages(t, upTo)) });
      if (!res.ok) return { ok: false, input: priorInput };
      t.summary = collectReply("chat", res.json).text.trim();
      t.summaryUpTo = upTo;
      compactions.current += 1;
      compacted = true;
      if (stopped.current) return { ok: false, input: priorInput };
    }
    t.turns = [...t.turns, { role: "user", content: step.content }];
    const plan = planRequest(strategy, t, { windowMessages: Number(windowMessages) + 1 });
    const body = bodyOf(plan.messages);
    setLastBody(body);
    const res = await runner.run("chat/completions", { method: "POST", body });
    if (!res.ok) {
      t.turns = t.turns.slice(0, -1);
      return { ok: false, input: priorInput };
    }
    const reply = collectReply("chat", res.json);
    const { state, rest } = extractState(reply.text);
    if (state) t.state = state;
    t.turns = [...t.turns, { role: "assistant", content: reply.text }];
    const usage = tokenUsage(reply.usage);
    const input = usage?.input ?? 0;
    setRows((cur) => [
      ...cur,
      {
        n: index + 1,
        label: step.label,
        user: step.content,
        reply: rest,
        state,
        sent: plan.messages.length,
        dropped: plan.dropped,
        note: plan.note,
        input,
        cached: usage?.cached ?? 0,
        output: usage?.output ?? 0,
        usage: reply.usage,
        model: res.model,
        ms: res.elapsedMs,
        compacted,
      },
    ]);
    return { ok: true, input };
  };

  /** Runs the next turn, or every turn left; `fresh` starts over from turn 1 (after reset()). */
  const run = async (all: boolean, fresh = false) => {
    if (busy) return;
    stopped.current = false;
    setBusy(true);
    try {
      const done = fresh ? [] : rows;
      let prior = done.length ? done[done.length - 1].input : 0;
      let total = done.reduce((n, r) => n + r.input, 0);
      let peak = done.reduce((n, r) => Math.max(n, r.input), 0);
      let index = done.length;
      let probe = "";
      while (index < script.length) {
        const res = await runTurn(index, prior);
        if (!res.ok) break;
        prior = res.input;
        total += res.input;
        peak = Math.max(peak, res.input);
        index += 1;
        if (index === script.length) probe = extractState(transcript.current.turns[transcript.current.turns.length - 1]?.content ?? "").rest;
        if (!all || stopped.current) break;
      }
      if (index === script.length && probe) {
        setSummaries((cur) => [...cur, { strategy, turns: index, totalInput: total, peakInput: peak, compactions: compactions.current, probe }]);
      }
    } finally {
      setBusy(false);
    }
  };

  const latest = rows[rows.length - 1];
  const state = transcript.current.state;
  const finished = rows.length >= script.length;

  return (
    <div className="pg">
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={busy} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={busy} />
      </div>
      <div className={styles.row}>
        <span className={styles.inlineLabel}>Strategy</span>
        <Segmented<Strategy>
          size="sm"
          label="Context strategy"
          value={strategy}
          onChange={(s) => {
            setStrategy(s);
            reset();
          }}
          disabled={busy}
          options={(["full", "window", "state", "summary"] as const).map((s) => ({ value: s, label: STRATEGY_LABEL[s] }))}
        />
      </div>
      <Note advanced>
        {strategy === "full"
          ? "Every turn resends the whole conversation: nothing is forgotten, and the input grows every turn."
          : strategy === "window"
            ? "The long-context recipe's trim_history: keep the instructions and the newest messages, drop the oldest."
            : strategy === "state"
              ? "The recipe's running state: the model updates STATE.md every reply, and each turn sends STATE.md plus the newest exchange instead of the old turns."
              : `Compaction: once the last request passes ${Math.round(COMPACT_AT * 100)}% of the declared window, older turns are summarized into one note (an extra call).`}
      </Note>
      <div className={`${styles.row} pg-advanced`}>
        {strategy === "window" ? (
          <>
            <span className={styles.inlineLabel}>Keep the last</span>
            <Segmented<"3" | "5">
              size="sm"
              label="Messages kept"
              value={windowMessages}
              onChange={(v) => {
                setWindowMessages(v);
                reset();
              }}
              disabled={busy}
              options={[
                { value: "3", label: "3 messages" },
                { value: "5", label: "5 messages" },
              ]}
            />
          </>
        ) : null}
        <span className={styles.inlineLabel}>Declared window</span>
        <Segmented<WindowSize>
          size="sm"
          label="Declared context window"
          value={declared}
          onChange={setDeclared}
          disabled={busy}
          options={[
            { value: "1000", label: "1k" },
            { value: "2000", label: "2k" },
            { value: "8000", label: "8k" },
            { value: "1048576", label: "1M (Muse Spark)" },
          ]}
        />
      </div>
      <Note advanced>
        The declared window is what the meter and compaction measure against, like OpenCode&apos;s limit.context; Muse Spark&apos;s own window is 1,048,576
        tokens. It starts at 2k, or 1k for compaction so it triggers within these five turns.
      </Note>
      <div className={styles.spread}>
        <span className="pg-muted pg-small pg-advanced">
          {script.length} scripted turns{strategy === "summary" ? " plus any compaction calls" : ""}, about a tenth of a cent in all.
        </span>
        <span className={styles.row}>
          {rows.length ? (
            <button type="button" className="btn btn-sm" onClick={reset} disabled={busy}>
              Start over
            </button>
          ) : null}
          {!finished ? (
            <button type="button" className="btn btn-sm btn-outline pg-advanced" onClick={() => void run(false)} disabled={busy}>
              {rows.length ? `Turn ${rows.length + 1}` : "Turn 1"}
            </button>
          ) : null}
          <RunButton
            running={busy}
            onRun={() => {
              if (finished) {
                reset();
                void run(true, true);
              } else void run(true);
            }}
            onStop={() => {
              stopped.current = true;
              runner.abort();
            }}
            label={finished ? "Run all turns again" : rows.length ? "Run the rest" : "Run all turns"}
          />
        </span>
      </div>
      <ErrorBox error={runner.error} />

      {latest ? (
        <Meter
          label="Latest input against the declared window"
          value={latest.input}
          max={Number(declared)}
          markAt={strategy === "summary" ? COMPACT_AT : undefined}
          warnAt={meterWarnAt(strategy)}
          left={`Turn ${latest.n}: ${latest.input.toLocaleString("en-US")} input tokens`}
          right={`${((latest.input / Number(declared)) * 100).toFixed(1)}% of ${Number(declared).toLocaleString("en-US")}`}
        />
      ) : null}
      {rows.length ? (
        <>
          <p className="pg-section-label">Input tokens per turn ({STRATEGY_LABEL[strategy]})</p>
          <BarList label="Input tokens per turn" items={rows.map((r) => ({ key: String(r.n), label: `${r.n}. ${r.label}`, value: r.input }))} />
        </>
      ) : null}

      {rows.length ? (
        <ol className={styles.turns} aria-label="Turns" aria-live="polite">
          {rows.map((r) => (
            <li key={r.n} className={styles.turn}>
              <div className={styles.turnHead}>
                <span className={styles.turnTitle}>
                  {r.n}. {r.label}
                </span>
                <StatusPill tone="idle">
                  sent {r.sent} messages{r.dropped ? `, ${r.dropped} left out` : ""}
                </StatusPill>
                {r.compacted ? <StatusPill tone="warn">compacted first</StatusPill> : null}
                <span className="pg-meta pg-advanced">{latencyLabel(r.ms)}</span>
              </div>
              <p className={`${styles.note} pg-advanced`}>{r.note}</p>
              <details className="pg-advanced">
                <summary className="pg-muted pg-small">The reply</summary>
                <MarkdownText className={styles.textBlock} text={r.reply || "(only the STATE.md block)"} />
              </details>
              <p className="pg-small pg-advanced">
                <UsageLine model={r.model} usage={r.usage} />
              </p>
            </li>
          ))}
        </ol>
      ) : null}

      {state ? (
        <details className="pg-raw" open={strategy === "state"}>
          <summary>STATE.md, as the model keeps it</summary>
          <pre className={styles.trace}>{state}</pre>
        </details>
      ) : null}
      {strategy === "summary" && transcript.current.summary ? (
        <details className="pg-raw" open>
          <summary>The compaction note (covers {transcript.current.summaryUpTo} messages)</summary>
          <pre className={styles.trace}>{transcript.current.summary}</pre>
        </details>
      ) : null}

      {finished && latest ? (
        <div className="pg-final">
          <p className="pg-section-label">The coherence check&apos;s answer</p>
          <MarkdownText className={styles.textBlock} text={latest.reply} />
          <Note advanced>Does it remember the decisions from turn 1? A sliding window drops them first; the running state carries them forward in far fewer tokens than the full history.</Note>
        </div>
      ) : null}

      {summaries.length ? (
        <div className={styles.tableWrap}>
          <p className="pg-section-label">Runs compared</p>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Strategy</th>
                <th scope="col" className={styles.num}>Input, all turns</th>
                <th scope="col" className={styles.num}>Peak input</th>
                <th scope="col" className={styles.num}>Compactions</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((s, i) => (
                <tr key={i}>
                  <td>{STRATEGY_LABEL[s.strategy]}</td>
                  <td className={styles.num}>{s.totalInput.toLocaleString("en-US")}</td>
                  <td className={styles.num}>{s.peakInput.toLocaleString("en-US")}</td>
                  <td className={styles.num}>{s.compactions}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {summaries.length === 1 ? <Note>Pick another strategy and run it again to compare.</Note> : null}
        </div>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? (
        <CodeView
          method="POST"
          path="chat/completions"
          body={lastBody ?? bodyOf(planRequest(strategy, { ...transcript.current, turns: [{ role: "user", content: script[0]?.content ?? "" }] }, { windowMessages: Number(windowMessages) + 1 }).messages)}
          caption={lastBody ? "The last turn's request" : "Turn 1's request"}
        />
      ) : null}
    </div>
  );
}
