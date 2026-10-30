"use client";

import { useId, useRef, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { EffortSelect, Field, PresetPills, Segmented, TextArea, Toggle } from "@/components/docs/kit/Field";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { latencyLabel } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import styles from "@/components/docs/playgrounds/cookbook-fundamentals/cookbook.module.css";
import { Advanced, BarList, DemoTabs, Note, Stats, StatusPill } from "@/components/docs/playgrounds/cookbook-fundamentals/ui";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import { tokenUsage } from "@/lib/docs/client/cost";
import { DEFAULT_TEXT_MODEL, EFFORT_LABELS, effortsFor, fitEffort, type Effort } from "@/lib/docs/client/models";
import { collectReply } from "@/lib/docs/client/stream";

/**
 * The reasoning-thinking-tokens recipe, live, in three parts: the same question at each reasoning_effort with the
 * reasoning tokens it spends (and "none", which the endpoint rejects today), what the reasoning looks like on each
 * protocol (Chat's reasoning_content is empty; Responses returns an encrypted reasoning item, with a summary when you
 * ask for one), and carrying reasoning across turns, with previous_response_id or by replaying the encrypted item.
 */

export interface ReasoningDemoProps {
  slug: string;
  questions: Array<{ label: string; prompt: string }>;
}

type Json = Record<string, unknown>;

interface SweepRow {
  effort: string;
  status: number;
  reasoning: number | null;
  answer: string;
  ms: number;
  model: string | null;
  usage: unknown;
  error: string | null;
}

function Sweep({ questions }: { questions: ReasoningDemoProps["questions"] }) {
  const id = useId();
  const runner = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [prompt, setPrompt] = useState(questions[0]?.prompt ?? "");
  const [preset, setPreset] = useState<number | null>(questions.length ? 0 : null);
  const [withXhigh, setWithXhigh] = useState(false);
  const [rows, setRows] = useState<SweepRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const stopped = useRef(false);

  const levels: string[] = (["minimal", "low", "medium", "high", ...(withXhigh ? ["xhigh"] : [])] as Effort[]).filter((e) => effortsFor(model).includes(e));
  const body = (effort: string) => ({ model, messages: [{ role: "user", content: prompt.trim() }], reasoning_effort: effort });

  const sweep = async (efforts: string[]) => {
    if (busy || !prompt.trim()) return;
    stopped.current = false;
    setBusy(true);
    setRows([]);
    try {
      for (const effort of efforts) {
        if (stopped.current) break;
        const res = await runner.run("chat/completions", { method: "POST", body: body(effort) });
        const reply = res.ok ? collectReply("chat", res.json) : null;
        const usage = tokenUsage(reply?.usage);
        setRows((cur) => [
          ...cur,
          {
            effort,
            status: res.status,
            reasoning: usage?.reasoning ?? null,
            answer: reply?.text.trim() ?? "",
            ms: res.elapsedMs,
            model: res.model,
            usage: reply?.usage ?? null,
            error: res.ok ? null : (res.error?.message ?? "The request failed."),
          },
        ]);
      }
    } finally {
      setBusy(false);
    }
  };

  const ok = rows.filter((r) => !r.error && r.reasoning !== null);
  return (
    <div className="pg">
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={busy} />
        <Advanced>
          <Toggle id={`${id}-xhigh`} label="Add xhigh" checked={withXhigh} onChange={setWithXhigh} disabled={busy} />
        </Advanced>
      </div>
      <PresetPills
        presets={questions}
        active={preset}
        disabled={busy}
        onPick={(i) => {
          setPreset(i);
          setPrompt(questions[i].prompt);
        }}
      />
      <Field id={`${id}-q`} label="Question">
        <TextArea
          id={`${id}-q`}
          rows={2}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            setPreset(null);
          }}
          disabled={busy}
        />
      </Field>
      <div className={styles.spread}>
        <span className="pg-muted pg-small pg-advanced">One call per level, {levels.join(", ")}: under a cent together.</span>
        <span className={styles.row}>
          <button type="button" className="btn btn-sm btn-outline pg-advanced" disabled={busy || !prompt.trim()} onClick={() => void sweep(["none"])}>
            Try &quot;none&quot;
          </button>
          <RunButton
            running={busy}
            onRun={() => void sweep(levels)}
            onStop={() => {
              stopped.current = true;
              runner.abort();
            }}
            disabled={!prompt.trim()}
            label="Run every level"
          />
        </span>
      </div>
      <ErrorBox error={runner.error && rows.every((r) => r.effort !== "none") ? runner.error : null} />
      {ok.length ? (
        <>
          <p className="pg-section-label">Reasoning tokens by effort</p>
          <BarList
            label="Reasoning tokens by reasoning_effort"
            items={ok.map((r) => ({ key: r.effort, label: EFFORT_LABELS[r.effort as Effort] ?? r.effort, value: r.reasoning ?? 0, display: `${(r.reasoning ?? 0).toLocaleString("en-US")} tokens` }))}
          />
        </>
      ) : null}
      {rows.length ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">reasoning_effort</th>
                <th scope="col">Answer</th>
                <th scope="col" className={styles.num}>Time</th>
                <th scope="col">Usage</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.effort}>
                  <td>
                    <code>{r.effort}</code>
                  </td>
                  <td>{r.error ? <span className="pg-bad">HTTP {r.status}: {r.error}</span> : r.answer.slice(0, 80) || "(no text)"}</td>
                  <td className={styles.num}>{latencyLabel(r.ms)}</td>
                  <td>{r.error ? null : <UsageLine model={r.model} usage={r.usage} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {ok.length > 1 ? (
        <Note advanced>
          Reasoning tokens are output tokens: you pay for them though they never appear in the text. Keep simple calls at minimal or low and save
          high, the effective maximum (xhigh runs at the same strength), for hard problems.
        </Note>
      ) : null}
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="chat/completions" body={body("high")} caption="One level of the sweep" /> : null}
    </div>
  );
}

interface Inspect {
  chat: { content: string; reasoningContent: unknown; reasoning: number | null } | null;
  responses: { types: string[]; id: string | null; summary: unknown; encrypted: number; answer: string; reasoning: number | null } | null;
  responsesJson: unknown;
}

function InspectReasoning() {
  const id = useId();
  const runner = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>("low");
  const [summary, setSummary] = useState(false);
  const [result, setResult] = useState<Inspect | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCode, setShowCode] = useState(false);

  const chatBody = { model, messages: [{ role: "user", content: "Name a prime number between 10 and 20." }], ...(fitEffort(model, effort) ? { reasoning_effort: fitEffort(model, effort) } : {}) };
  const responsesBody = {
    model,
    input: "In one sentence, why is the sky blue?",
    reasoning: { ...(fitEffort(model, effort) ? { effort: fitEffort(model, effort) } : {}), ...(summary ? { summary: "auto" } : {}) },
    include: ["reasoning.encrypted_content"],
    store: false,
  };

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      const c = await runner.run("chat/completions", { method: "POST", body: chatBody });
      const msg = ((c.json as { choices?: Array<{ message?: Json }> } | null)?.choices?.[0]?.message ?? null) as Json | null;
      const chat = c.ok
        ? { content: String(msg?.content ?? ""), reasoningContent: msg && "reasoning_content" in msg ? msg.reasoning_content : undefined, reasoning: tokenUsage((c.json as Json).usage)?.reasoning ?? null }
        : null;
      setResult({ chat, responses: null, responsesJson: null });
      if (!c.ok) return;
      const r = await runner.run("responses", { method: "POST", body: responsesBody });
      if (!r.ok) return;
      const json = r.json as Json;
      const items = Array.isArray(json.output) ? (json.output as Json[]) : [];
      const reasoningItem = items.find((i) => i.type === "reasoning");
      setResult({
        chat,
        responses: {
          types: items.map((i) => String(i.type)),
          id: typeof reasoningItem?.id === "string" ? reasoningItem.id : null,
          summary: reasoningItem?.summary,
          encrypted: typeof reasoningItem?.encrypted_content === "string" ? reasoningItem.encrypted_content.length : 0,
          answer: collectReply("responses", json).text,
          reasoning: tokenUsage(json.usage)?.reasoning ?? null,
        },
        responsesJson: json,
      });
    } finally {
      setBusy(false);
    }
  };

  const summaryText = Array.isArray(result?.responses?.summary)
    ? (result!.responses!.summary as Array<{ text?: string }>).map((s) => s.text ?? "").join(" ").trim()
    : "";

  return (
    <div className="pg">
      <p className={`${styles.lead} pg-advanced`}>
        Sends the recipe&apos;s two inspection calls: Chat Completions (is there reasoning_content?) and Responses with include
        reasoning.encrypted_content and store false (what does the reasoning item hold?).
      </p>
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={busy} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={busy} />
        <Advanced>
          <Toggle id={`${id}-summary`} label={'reasoning.summary: "auto"'} checked={summary} onChange={setSummary} disabled={busy} />
        </Advanced>
      </div>
      <div className={styles.spread}>
        <span className="pg-muted pg-small pg-advanced">Two calls, well under a cent.</span>
        <RunButton running={busy} onRun={() => void run()} onStop={runner.abort} label="Inspect the reasoning" />
      </div>
      <ErrorBox error={runner.error} />
      {result ? (
        <div className={styles.compare} aria-live="polite">
          <div className={styles.compareCol}>
            <p className={styles.compareTitle}>Chat Completions</p>
            {result.chat ? (
              <>
                <MarkdownText className={styles.textBlock} text={result.chat.content || "(no text)"} />
                <Stats
                  items={[
                    { label: "reasoning_tokens", value: result.chat.reasoning?.toLocaleString("en-US") ?? "n/a" },
                    {
                      label: "reasoning_content",
                      value: result.chat.reasoningContent === undefined || result.chat.reasoningContent === null || result.chat.reasoningContent === "" ? "empty" : "present",
                      note: "don't build on reading it here",
                    },
                  ]}
                />
              </>
            ) : (
              <StatusPill tone="busy">Running</StatusPill>
            )}
          </div>
          <div className={styles.compareCol}>
            <p className={styles.compareTitle}>Responses</p>
            {result.responses ? (
              <>
                <MarkdownText className={styles.textBlock} text={result.responses.answer || "(no text)"} />
                <Stats
                  items={[
                    { label: "output items", value: result.responses.types.join(", ") },
                    { label: "encrypted_content", value: result.responses.encrypted ? `${result.responses.encrypted.toLocaleString("en-US")} chars` : "missing", note: "replayable, not readable" },
                    { label: "summary", value: summaryText ? "text" : "[] (empty)", note: summary ? undefined : "ask for one with reasoning.summary" },
                    { label: "reasoning_tokens", value: result.responses.reasoning?.toLocaleString("en-US") ?? "n/a" },
                  ]}
                />
                {summaryText ? <p className={styles.thought}>{summaryText}</p> : null}
                {result.responses.id ? <p className="pg-muted pg-small">reasoning id: <code>{result.responses.id}</code></p> : null}
              </>
            ) : busy ? (
              <StatusPill tone="busy">Running</StatusPill>
            ) : (
              <p className="pg-empty">Not sent.</p>
            )}
          </div>
        </div>
      ) : null}
      {result?.responsesJson ? (
        <details className="pg-raw pg-advanced">
          <summary>The Responses reply</summary>
          <JsonTree value={result.responsesJson} openDepth={2} />
        </details>
      ) : null}
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="responses" body={responsesBody} caption="The Responses call" /> : null}
    </div>
  );
}

type Carry = "previous" | "replay";

/** The body with each encrypted_content shortened, for the code view: it's thousands of characters nobody reads. */
function shortenEncrypted(value: unknown): Json {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Json).map(([k, x]) => [k, k === "encrypted_content" && typeof x === "string" ? `<encrypted_content from turn 1, ${x.length.toLocaleString("en-US")} characters>` : walk(x)]),
      );
    }
    return v;
  };
  return walk(value) as Json;
}

interface Turn {
  text: string;
  input: number | null;
  usage: unknown;
  model: string | null;
  body: Json;
}

function CarryAcross() {
  const id = useId();
  const runner = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [mode, setMode] = useState<Carry>("previous");
  const [first, setFirst] = useState("I'm planning a 3-day trip to Lisbon. Suggest one neighborhood to stay in. Keep it short.");
  const [second, setSecond] = useState("Why that one over the alternatives? Two sentences.");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [showCode, setShowCode] = useState(false);
  // Turn 2's input tokens the last time each way ran, to compare what each carries.
  const [inputs, setInputs] = useState<Partial<Record<Carry, number>>>({});

  const base = { model, reasoning: { effort: "low" } };
  const turn1Body: Json =
    mode === "previous" ? { ...base, input: first.trim() } : { ...base, input: first.trim(), include: ["reasoning.encrypted_content"], store: false };

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setTurns([]);
    try {
      const r1 = await runner.run("responses", { method: "POST", body: turn1Body });
      if (!r1.ok) return;
      const j1 = r1.json as Json;
      const t1: Turn = { text: collectReply("responses", j1).text, input: tokenUsage(j1.usage)?.input ?? null, usage: j1.usage, model: r1.model, body: turn1Body };
      setTurns([t1]);
      let body2: Json;
      if (mode === "previous") {
        body2 = { ...base, input: second.trim(), previous_response_id: j1.id };
      } else {
        // Stateless: replay turn 1's items (its encrypted reasoning and its answer) ahead of the new question.
        const items = (Array.isArray(j1.output) ? (j1.output as Json[]) : []).map((it) =>
          it.type === "reasoning"
            ? { type: "reasoning", id: it.id, encrypted_content: it.encrypted_content, summary: it.summary ?? [] }
            : it.type === "message"
              ? { type: "message", role: "assistant", content: [{ type: "output_text", text: collectReply("responses", { output: [it] }).text }] }
              : it,
        );
        body2 = { ...base, input: [{ role: "user", content: first.trim() }, ...items, { role: "user", content: second.trim() }], include: ["reasoning.encrypted_content"], store: false };
      }
      const r2 = await runner.run("responses", { method: "POST", body: body2 });
      if (!r2.ok) return;
      const j2 = r2.json as Json;
      const input2 = tokenUsage(j2.usage)?.input ?? null;
      setTurns([t1, { text: collectReply("responses", j2).text, input: input2, usage: j2.usage, model: r2.model, body: body2 }]);
      if (input2 !== null) setInputs((cur) => ({ ...cur, [mode]: input2 }));
    } finally {
      setBusy(false);
    }
  };

  const codeBody = shortenEncrypted(turns[1]?.body ?? (mode === "previous" ? { ...base, input: second.trim(), previous_response_id: "resp_..." } : turn1Body));

  return (
    <div className="pg">
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={busy} />
        <Advanced>
          <Segmented<Carry>
            label="How turn 2 gets turn 1's reasoning"
            value={mode}
            onChange={(m) => {
              setMode(m);
              setTurns([]);
            }}
            disabled={busy}
            options={[
              { value: "previous", label: "previous_response_id" },
              { value: "replay", label: "Replay the encrypted item" },
            ]}
          />
        </Advanced>
      </div>
      <Note advanced>
        {mode === "previous"
          ? "The server stores turn 1 and replays its reasoning and history when turn 2 names it."
          : "Nothing is stored (store: false). Your client keeps turn 1's encrypted reasoning item and sends it back in turn 2's input."}
      </Note>
      <div className="pg-split">
        <Field id={`${id}-t1`} label="Turn 1">
          <TextArea id={`${id}-t1`} rows={2} value={first} onChange={(e) => setFirst(e.target.value)} disabled={busy} />
        </Field>
        <Field id={`${id}-t2`} label="Turn 2">
          <TextArea id={`${id}-t2`} rows={2} value={second} onChange={(e) => setSecond(e.target.value)} disabled={busy} />
        </Field>
      </div>
      <div className={styles.spread}>
        <span className="pg-muted pg-small pg-advanced">Two calls, well under a cent.</span>
        <RunButton running={busy} onRun={() => void run()} onStop={runner.abort} label="Run both turns" disabled={!first.trim() || !second.trim()} />
      </div>
      <ErrorBox error={runner.error} />
      {turns.length ? (
        <div className={styles.compare} aria-live="polite">
          {turns.map((t, i) => (
            <div key={i} className={styles.compareCol}>
              <p className={styles.compareTitle}>Turn {i + 1}</p>
              <MarkdownText className={styles.textBlock} text={t.text || "(no text)"} />
              <p className="pg-small">
                <UsageLine model={t.model} usage={t.usage} />
              </p>
              {i === 1 ? (
                <p className={styles.note}>
                  {mode === "previous"
                    ? `Turn 2 billed ${t.input?.toLocaleString("en-US") ?? "?"} input tokens for the history the server carried from turn 1.`
                    : `Turn 2 billed ${t.input?.toLocaleString("en-US") ?? "?"} input tokens: the history plus the encrypted reasoning item you sent back, which counts as input.`}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {inputs.previous !== undefined && inputs.replay !== undefined ? (
        <BarList
          label="Turn 2 input tokens by how the reasoning was carried"
          items={[
            { key: "previous", label: "previous_response_id", value: inputs.previous, display: `${inputs.previous.toLocaleString("en-US")} tokens` },
            { key: "replay", label: "Replayed item", value: inputs.replay, display: `${inputs.replay.toLocaleString("en-US")} tokens` },
          ]}
        />
      ) : turns.length === 2 ? (
        <Note advanced>Run it the other way too to compare turn 2&apos;s input tokens.</Note>
      ) : null}
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="responses" body={codeBody} caption="Turn 2" /> : null}
    </div>
  );
}

export function ReasoningDemo({ questions }: ReasoningDemoProps) {
  return (
    <DemoTabs
      label="Reasoning demos"
      tabs={[
        { id: "sweep", label: "Effort levels", content: <Sweep questions={questions} /> },
        { id: "inspect", label: "Where the reasoning is", content: <InspectReasoning /> },
        { id: "carry", label: "Across turns", content: <CarryAcross /> },
      ]}
    />
  );
}
