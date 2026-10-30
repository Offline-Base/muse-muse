"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CodeView, DEFAULT_TEXT_MODEL, ErrorBox, JsonTree, ModelSelect, PresetPills, RunButton, Segmented, TextArea, Toggle, latencyLabel, useDocsRun } from "@/components/docs/kit";
import type { DocsError, DocsResult } from "@/lib/docs/client/api";
import { estimateCost, formatUsd } from "@/lib/docs/client/cost";
import {
  addUsage,
  firstBody,
  initialHistory,
  isTransient,
  LOOP_SYSTEM,
  LOOP_TASKS,
  nextBody,
  pausable,
  readReply,
  REPO,
  RETRY_DELAYS_MS,
  runTool,
  runTests,
  type Files,
  type LoopConfig,
  type LoopProtocol,
} from "@/components/docs/playgrounds/muse-code/agent-loop";
import styles from "@/components/docs/playgrounds/muse-code/muse-code.module.css";
import { Chip, NumberField } from "@/components/docs/playgrounds/muse-code/ui";

/**
 * A live mini agent loop on the Messages API (the Claude Agent SDK's wire format) or the Responses API (the Codex
 * app-server's): the model reads, edits and tests a small simulated repository through three tools, the page runs
 * each tool call and sends the result back, and the run ends on the model's final answer. It follows the page's
 * production patterns: a cap on model calls, a wall-clock cap and an idle watchdog, retries with backoff for
 * transient errors, cost metered from usage, and a run without a final message counted as a failure.
 */

type Step =
  | { kind: "model"; n: number; ms: number; text: string; calls: string[]; usage: Record<string, unknown> | null; request: Record<string, unknown>; reply: unknown }
  | { kind: "tool"; name: string; args: Record<string, unknown>; output: string; isError: boolean }
  | { kind: "retry"; text: string };

interface Final {
  ok: boolean;
  text: string;
  calls: number;
  tokens: { input: number; output: number };
  usd: number;
  ms: number;
  tests: string;
}

export function MiniAgentLoop({ protocol: startProtocol = "messages" }: { protocol?: LoopProtocol }) {
  const id = useId();
  const runner = useDocsRun();
  const [protocol, setProtocol] = useState<LoopProtocol>(startProtocol);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [task, setTask] = useState<number | null>(0);
  const [prompt, setPrompt] = useState(LOOP_TASKS[0].prompt);
  const [maxCalls, setMaxCalls] = useState<number | null>(8);
  const [overallS, setOverallS] = useState<number | null>(240);
  const [idleS, setIdleS] = useState<number | null>(75);
  const [steps, setSteps] = useState<Step[]>([]);
  const [final, setFinal] = useState<Final | null>(null);
  const [files, setFiles] = useState<Files>(REPO);
  const [error, setError] = useState<DocsError | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const stopped = useRef(false);
  // Ends a backoff wait at once when Stop is pressed, so no retry goes out after it.
  const cancelWait = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      stopped.current = true;
      cancelWait.current?.();
    },
    [],
  );
  const cfg: LoopConfig = { protocol, model, system: LOOP_SYSTEM, prompt: prompt.trim() || LOOP_TASKS[0].prompt, maxTokens: model === "muse-wonder-1.0" ? 800 : 1500 };
  const path = protocol === "messages" ? "messages" : "responses";

  const run = async () => {
    stopped.current = false;
    setBusy(true);
    setSteps([]);
    setFinal(null);
    setError(null);
    let work: Files = { ...REPO };
    setFiles(work);
    let history = initialHistory(cfg);
    let body = firstBody(cfg);
    let tokens = { input: 0, output: 0 };
    let usd = 0;
    const started = performance.now();
    const cap = Math.max(1, maxCalls ?? 8);
    const push = (s: Step) => setSteps((cur) => [...cur, s]);
    const finish = (ok: boolean, text: string, calls: number) => {
      setFinal({ ok, text, calls, tokens, usd, ms: performance.now() - started, tests: runTests(work).output.split("\n").slice(-2).join(", ").replace(/# /g, "") });
      setBusy(false);
    };

    for (let n = 1; n <= cap; n++) {
      if (stopped.current) return finish(false, "Stopped before a final message.", n - 1);
      if (overallS && performance.now() - started > overallS * 1000) return finish(false, `Hit the ${overallS} s wall-clock cap without a final message, so the run counts as a failure.`, n - 1);
      let attempt = 0;
      let watchdogFired = false;
      let res: DocsResult | undefined;
      for (;;) {
        const timer = idleS ? setTimeout(() => {
          watchdogFired = true;
          runner.abort();
        }, idleS * 1000) : null;
        const t0 = performance.now();
        res = await runner.run(path, { body });
        if (timer) clearTimeout(timer);
        if (watchdogFired) return finish(false, `The idle watchdog stopped call ${n}: no reply for ${idleS} s. Without it, a silent hang would wait forever.`, n - 1);
        if (stopped.current || res.error?.code === "aborted") return finish(false, "Stopped before a final message.", n - 1);
        if (res.ok || attempt >= RETRY_DELAYS_MS.length || !isTransient(res.status, res.error?.code, res.error?.message, "previous_response_id" in body)) {
          if (res.ok) {
            const reply = readReply(protocol, res.json);
            tokens = addUsage(tokens, reply.usage);
            usd += estimateCost(res.model ?? model, reply.usage)?.usd ?? 0;
            push({ kind: "model", n, ms: performance.now() - t0, text: reply.text, calls: reply.calls.map((c) => c.name), usage: reply.usage, request: body, reply: res.json });
          }
          break;
        }
        const wait = RETRY_DELAYS_MS[attempt++];
        push({ kind: "retry", text: `Call ${n} hit a transient error (${res.status}: ${res.error?.message ?? "no message"}). Retrying in ${wait / 1000} s, with backoff.` });
        const pause = pausable(wait);
        cancelWait.current = pause.cancel;
        await pause.done;
        cancelWait.current = null;
        if (stopped.current) return finish(false, "Stopped before a final message.", n - 1);
      }
      if (!res?.ok) {
        setError(res?.error ?? null);
        return finish(false, "The model call failed, so the run ends without a final message.", n);
      }
      const reply = readReply(protocol, res.json);
      if (!reply.calls.length) {
        if (!reply.text.trim()) return finish(false, "The model stopped without tools or text: a run without a final message is a failure.", n);
        return finish(true, reply.text, n);
      }
      const results = reply.calls.map((c) => {
        const r = c.bad ? { output: `The arguments weren't valid JSON: ${c.bad.slice(0, 200)}`, isError: true, files: work } : runTool(protocol, c.name, c.args, work);
        work = r.files;
        push({ kind: "tool", name: c.name, args: c.args, output: r.output, isError: r.isError });
        return { callId: c.id, output: r.output, isError: r.isError };
      });
      setFiles(work);
      const next = nextBody(cfg, history, reply, results);
      body = next.body;
      history = next.history;
    }
    finish(false, `Hit the ${cap}-call cap without a final message, so the run counts as a failure.`, cap);
  };

  const changed = Object.keys(files).filter((f) => REPO[f] !== files[f]);

  return (
    <div className="pg-col">
      <div className="pg-bar">
        <div className="pg-field pg-advanced">
          <span className="pg-label">Wire format</span>
          <Segmented<LoopProtocol>
            label="Wire format"
            size="sm"
            value={protocol}
            onChange={setProtocol}
            disabled={busy}
            options={[
              { value: "messages", label: "Messages (Claude Agent SDK)" },
              { value: "responses", label: "Responses (Codex app-server)" },
            ]}
          />
        </div>
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={busy} />
      </div>
      <PresetPills
        presets={LOOP_TASKS}
        active={task}
        disabled={busy}
        onPick={(i) => {
          setTask(i);
          setPrompt(LOOP_TASKS[i].prompt);
        }}
      />
      <label className="sr-only" htmlFor={`${id}-prompt`}>
        Task
      </label>
      <TextArea
        id={`${id}-prompt`}
        rows={2}
        value={prompt}
        disabled={busy}
        onChange={(e) => {
          setPrompt(e.target.value);
          setTask(null);
        }}
      />
      <div className={styles.row}>
        <NumberField id={`${id}-calls`} className="pg-advanced" label="Most model calls" value={maxCalls} min={1} max={15} onChange={setMaxCalls} disabled={busy} />
        <NumberField id={`${id}-overall`} className="pg-advanced" label="Wall-clock cap (s)" value={overallS} min={10} onChange={setOverallS} disabled={busy} />
        <NumberField id={`${id}-idle`} className="pg-advanced" label="Idle watchdog (s)" value={idleS} min={5} onChange={setIdleS} disabled={busy} />
        <RunButton
          running={busy}
          onRun={() => void run()}
          onStop={() => {
            stopped.current = true;
            cancelWait.current?.();
            runner.abort();
          }}
          label="Run the agent"
        />
      </div>
      <p className="pg-hint">
        Tools: {protocol === "messages" ? "Read, Edit and Bash, named like the SDK's own" : "read_file, edit_file and exec_command"}, over a simulated repository in your browser. Nothing runs on a machine,
        and the test runner is simulated too.
      </p>
      <ErrorBox error={error} />

      {steps.length ? (
        <ol className="pg-steps" aria-label="Agent loop" aria-live="polite">
          {steps.map((s, i) => (
            <li key={i} className="pg-step">
              {s.kind === "model" ? (
                <>
                  <p className="pg-step-title">
                    <span className="pg-step-num">{s.n}</span> Model call {s.n}
                    <span className="pg-muted pg-small">{latencyLabel(s.ms)}</span>
                    {s.calls.length ? <Chip tone="accent">asks for {s.calls.join(", ")}</Chip> : <Chip tone="ok">final message</Chip>}
                  </p>
                  {s.text ? <div className={styles.msgAssistant}>{s.text}</div> : null}
                  <details className="pg-raw pg-advanced">
                    <summary>Request and reply JSON</summary>
                    <JsonTree value={{ request: s.request, reply: s.reply }} openDepth={1} />
                  </details>
                </>
              ) : s.kind === "tool" ? (
                <>
                  <p className="pg-step-title">
                    <span className="pg-muted">Tool</span> <code className={styles.code}>{s.name}</code>
                    <span className="pg-muted pg-small">{JSON.stringify(s.args).slice(0, 120)}</span>
                    {s.isError ? <Chip tone="bad">error</Chip> : null}
                  </p>
                  <pre className="pg-pre pg-advanced">{s.output.length > 1400 ? `${s.output.slice(0, 1400)}\n...` : s.output}</pre>
                </>
              ) : (
                <p className="pg-hint">{s.text}</p>
              )}
            </li>
          ))}
        </ol>
      ) : null}

      {busy && !final ? (
        <div className="pg-hint" role="status">
          Running: model call {steps.filter((s) => s.kind === "model").length + 1}, {latencyLabel(runner.elapsedMs)} so far.
        </div>
      ) : null}

      {final ? (
        <section className={`${styles.verdict} ${final.ok ? styles.verdictOk : styles.verdictBad}`} aria-label="Result" role="status">
          <p className={styles.big}>{final.ok ? "Result" : "No result: treated as a failure"}</p>
          <div className={styles.msgAssistant}>{final.text}</div>
          <p className="pg-small">
            {final.calls} model {final.calls === 1 ? "call" : "calls"} · {latencyLabel(final.ms)} · {final.tokens.input.toLocaleString("en-US")} in, {final.tokens.output.toLocaleString("en-US")} out ·{" "}
            {formatUsd(final.usd)} est. · simulated tests: {final.tests}
          </p>
        </section>
      ) : null}

      {changed.length ? (
        <details className="pg-system" open>
          <summary>Workspace after the run ({changed.join(", ")} changed)</summary>
          {changed.map((f) => (
            <pre key={f} className="pg-pre" aria-label={f}>
              {files[f]}
            </pre>
          ))}
        </details>
      ) : null}

      <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      {showCode ? <CodeView method="POST" path={path} body={firstBody(cfg)} caption={`The loop's first request; each next one ${protocol === "messages" ? "resends the history with tool_result blocks" : "chains with previous_response_id and function_call_output items"}`} /> : null}
    </div>
  );
}
