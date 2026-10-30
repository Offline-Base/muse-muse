"use client";

import { useId, useMemo, useRef, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { EffortSelect, PresetPills, runOnModEnter, Segmented, TextArea, Toggle, useModEnterHint } from "@/components/docs/kit/Field";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { latencyLabel, statusText } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { prettyArguments, ReplyView, ToolCalls } from "@/components/docs/kit/StreamView";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { isAborted, useDocsRun } from "@/components/docs/kit/useDocsRun";
import type { DocsResult, SseEvent } from "@/lib/docs/client/api";
import { PROTOCOL_LABEL, PROTOCOL_PATH, type NeutralRequest } from "@/lib/docs/client/body";
import { costExtrasOf } from "@/lib/docs/client/cost";
import { DEFAULT_TEXT_MODEL, docsModelLabel, fitEffort, type Effort } from "@/lib/docs/client/models";
import { collectorFor, collectReply, type Collected } from "@/lib/docs/client/stream";
import { finalAnswer, nextAction, nextModelBody, requestedCalls, type LoopProtocol, type LoopStep, type ModelStep } from "@/lib/docs/client/toolloop";
import { resolveTools, runToolCall, type ToolSpec } from "@/lib/docs/client/tools";

/**
 * The tool-calling loop, one step at a time (tool-calling page): the model call, the tool calls it asks for with
 * their arguments, each tool run locally (built-in mock tools by name, or a page's own definitions with fixed
 * results), the results sent back, and the final answer. Responses continues with previous_response_id and
 * function_call_output items; Chat Completions resends the history with tool messages. Step runs the next action,
 * Run all runs to the answer. Parallel calls run together.
 */

export interface ToolLoopPlaygroundProps {
  slug: string;
  prompt: string;
  /** Built-in mock tools by name (get_weather, get_time, calculator, lookup_order, search_docs, send_email), or definitions. */
  tools: Array<string | ToolSpec>;
  /** Fixed results per tool name, over the built-ins' own answers. */
  results?: Record<string, unknown>;
  /** Default "responses". */
  protocol?: LoopProtocol;
  protocols?: LoopProtocol[];
  model?: string;
  models?: string[];
  system?: string;
  /** parallel_tool_calls. Default true. */
  parallel?: boolean;
  /** Most model calls per run. Default 6. */
  maxCalls?: number;
  /** Default "low". */
  effort?: Effort | null;
  /** Stream each model call, so arguments show as they arrive. Default false. */
  stream?: boolean;
  presets?: Array<{ label: string; prompt: string }>;
}

function failed(protocol: LoopProtocol, res: DocsResult): Collected {
  const c = collectReply(protocol, null);
  return { ...c, done: true, error: { code: res.error?.code ?? null, message: res.error?.message ?? "The request failed." } };
}

export function ToolLoopPlayground(props: ToolLoopPlaygroundProps) {
  const id = useId();
  const protocols: LoopProtocol[] = props.protocols?.length ? props.protocols : [props.protocol ?? "responses"];
  const runner = useDocsRun();
  const loopHint = useModEnterHint("runs the whole loop");
  const [protocol, setProtocol] = useState<LoopProtocol>(props.protocol && protocols.includes(props.protocol) ? props.protocol : protocols[0]);
  const [model, setModel] = useState(props.model ?? DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>(props.effort === undefined ? "low" : props.effort);
  const [parallel, setParallel] = useState(props.parallel ?? true);
  const [stream, setStream] = useState(props.stream ?? false);
  const [prompt, setPrompt] = useState(props.prompt);
  const [system, setSystem] = useState(props.system ?? "");
  const [preset, setPreset] = useState<number | null>(null);
  const [steps, setSteps] = useState<LoopStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [systemOpen, setSystemOpen] = useState(!!props.system);
  const stepsRef = useRef<LoopStep[]>([]);
  const stopRef = useRef(false);
  const maxCalls = props.maxCalls ?? 6;

  const tools = useMemo(() => resolveTools(props.tools, props.results), [props.tools, props.results]);
  const base: NeutralRequest = useMemo(
    () => ({
      model,
      system,
      messages: [{ role: "user", content: prompt.trim() }],
      tools: tools.map((t) => t.def),
      parallelToolCalls: parallel,
      effort: fitEffort(model, effort),
      stream,
    }),
    [model, system, prompt, tools, parallel, effort, stream],
  );

  const commit = (next: LoopStep[]) => {
    stepsRef.current = next;
    setSteps(next);
  };

  /** Runs the next action: a model call or the tools it asked for. */
  const step = async (): Promise<void> => {
    const current = stepsRef.current;
    const action = nextAction(current, maxCalls);
    if (action === "model") {
      const body = nextModelBody(protocol, base, current);
      const pending: ModelStep = { kind: "model", call: current.filter((s) => s.kind === "model").length + 1, body, collected: null };
      commit([...current, pending]);
      const collector = collectorFor(protocol);
      const onEvent = (e: SseEvent) => {
        collector.push(e);
        commit([...current, { ...pending, collected: { ...collector.snapshot(), done: false } }]);
      };
      const res = await runner.run(PROTOCOL_PATH[protocol], { method: "POST", body, stream, onEvent: stream ? onEvent : undefined });
      const got = !res.ok ? failed(protocol, res) : stream ? collector.snapshot() : collectReply(protocol, res.json);
      // The call is over either way: a stream cut off before its last event still counts as this step's reply.
      const collected: Collected = isAborted(res) ? { ...got, done: true, error: { code: "aborted", message: "Stopped." } } : { ...got, done: true };
      if (isAborted(res)) stopRef.current = true;
      commit([...current, { ...pending, collected, status: res.status, model: res.model, elapsedMs: res.elapsedMs }]);
      return;
    }
    if (action === "tools") {
      const last = current[current.length - 1] as ModelStep;
      const calls = requestedCalls(last);
      commit([...current, { kind: "tools", results: calls.map((call) => ({ call, run: null })) }]);
      // Parallel calls run together, as a reader's own code would run them.
      const runs = await Promise.all(calls.map((c) => runToolCall(tools, c.name, c.arguments)));
      commit([...current, { kind: "tools", results: calls.map((call, i) => ({ call, run: runs[i] })) }]);
    }
  };

  const runAll = async () => {
    if (busy) return;
    stopRef.current = false;
    setBusy(true);
    try {
      for (;;) {
        const action = nextAction(stepsRef.current, maxCalls);
        if (action !== "model" && action !== "tools") break;
        await step();
        if (stopRef.current) break;
      }
    } finally {
      setBusy(false);
    }
  };

  const stepOnce = async () => {
    if (busy) return;
    stopRef.current = false;
    setBusy(true);
    try {
      await step();
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    stopRef.current = true;
    runner.reset();
    commit([]);
  };

  const stop = () => {
    stopRef.current = true;
    runner.abort();
  };

  const action = nextAction(steps, maxCalls);
  const finished = action === "done" || action === "limit";
  const answer = action === "done" ? finalAnswer(steps) : "";
  const lastModel = [...steps].reverse().find((s): s is ModelStep => s.kind === "model");
  const codeBody = !finished && !busy ? nextModelBody(protocol, base, steps) : (lastModel?.body ?? nextModelBody(protocol, base, []));
  const nextLabel = action === "tools" ? "Run the tools" : action === "model" ? (steps.length ? "Send the results" : "Call the model") : "Step";

  return (
    <div className="pg pg-tools">
      <div className="pg-bar">
        {protocols.length > 1 ? (
          <Segmented<LoopProtocol>
            label="Protocol"
            options={protocols.map((p) => ({ value: p, label: PROTOCOL_LABEL[p] }))}
            value={protocol}
            onChange={(p) => {
              setProtocol(p);
              reset();
            }}
            disabled={busy}
          />
        ) : null}
        <ModelSelect kind="text" value={model} onChange={setModel} allow={props.models} disabled={busy} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={busy} />
        <Toggle id={`${id}-parallel`} label="Parallel calls" checked={parallel} onChange={setParallel} disabled={busy} />
        <Toggle id={`${id}-stream`} label="Stream" checked={stream} onChange={setStream} disabled={busy} />
      </div>

      <div className="pg-tool-defs">
        <p className="pg-section-label">Tools the model can call</p>
        <ul className="pg-tool-def-list">
          {tools.map((t) => (
            <li key={t.def.name}>
              <details>
                <summary>
                  <code className="pg-toolcall-name">{t.def.name}</code>
                  <span className="pg-muted"> {t.def.description}</span>
                  <span className="pg-badge">{t.source === "mock" ? "mock" : t.source === "fixed" ? "fixed result" : "echoes its arguments"}</span>
                </summary>
                <JsonTree value={t.def} openDepth={4} label={`${t.def.name} definition`} />
              </details>
            </li>
          ))}
        </ul>
        <p className="pg-muted pg-small">The tools run here in the page with sample data. Nothing is sent anywhere else, and send_email only pretends.</p>
      </div>

      {props.presets?.length ? (
        <PresetPills
          presets={props.presets}
          active={preset}
          onPick={(i) => {
            setPreset(i);
            setPrompt(props.presets![i].prompt);
            reset();
          }}
          disabled={busy}
        />
      ) : null}

      <details className="pg-system" open={systemOpen} onToggle={(e) => setSystemOpen(e.currentTarget.open)}>
        <summary>Instructions{system ? "" : " (optional)"}</summary>
        <label className="sr-only" htmlFor={`${id}-system`}>
          Instructions
        </label>
        <TextArea id={`${id}-system`} rows={2} value={system} onChange={(e) => setSystem(e.target.value)} disabled={busy || steps.length > 0} />
      </details>

      <div className="pg-composer">
        <label className="sr-only" htmlFor={`${id}-prompt`}>
          Message
        </label>
        <TextArea
          id={`${id}-prompt`}
          rows={2}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={runOnModEnter(() => void runAll())}
          disabled={busy || steps.length > 0}
        />
        <div className="pg-composer-bar">
          <span className="pg-muted pg-kbd-hint">{steps.length ? "Reset to change the question." : (loopHint ?? "")}</span>
          {steps.length ? (
            <button type="button" className="btn btn-sm" onClick={reset} disabled={busy}>
              Reset
            </button>
          ) : null}
          <button type="button" className="btn btn-sm btn-outline" onClick={() => void stepOnce()} disabled={busy || finished || !prompt.trim()}>
            {nextLabel}
          </button>
          <RunButton running={busy} onRun={() => void runAll()} onStop={stop} label={steps.length ? "Run to the end" : "Run all"} disabled={finished || !prompt.trim()} />
        </div>
      </div>

      {steps.length ? (
        <ol className="pg-steps" aria-label="Steps">
          {steps.map((s, i) =>
            s.kind === "model" ? (
              <li key={i} className="pg-step">
                <p className="pg-step-title">
                  <span className="pg-step-num">{i + 1}</span>
                  Model call {s.call}
                  {s.call > 1 ? (
                    <span className="pg-muted">
                      {" "}
                      {protocol === "responses" ? `with previous_response_id and the tool results` : "with the history and the tool results"}
                    </span>
                  ) : null}
                </p>
                <p className="pg-step-meta" role="status">
                  {!s.collected || !s.collected.done ? (
                    <span className="pg-status pg-status-busy">
                      <span className="pg-dot pg-dot-busy" aria-hidden />
                      Running
                    </span>
                  ) : s.status ? (
                    <span className={`pg-status ${s.collected.error ? "pg-status-bad" : "pg-status-ok"}`}>
                      <span className={`pg-dot ${s.collected.error ? "pg-dot-bad" : "pg-dot-ok"}`} aria-hidden />
                      {s.collected.error?.code === "aborted" ? "Stopped" : statusText({ status: s.status, error: null } as DocsResult)}
                    </span>
                  ) : null}
                  {s.model ? <span className="pg-meta">{docsModelLabel(s.model)}</span> : null}
                  {s.elapsedMs ? <span className="pg-meta">{latencyLabel(s.elapsedMs)}</span> : null}
                  {s.collected?.usage ? <UsageLine model={s.model ?? model} usage={s.collected.usage} {...costExtrasOf(s.collected.final)} /> : null}
                </p>
                {s.collected && requestedCalls(s).length ? (
                  <ToolCalls calls={requestedCalls(s)} title={requestedCalls(s).length > 1 ? `The model asked for ${requestedCalls(s).length} tool calls` : "The model asked for a tool call"} />
                ) : (
                  <ReplyView reply={s.collected} running={!s.collected?.done} placeholder={s.collected?.error ? s.collected.error.message : undefined} />
                )}
                <details className="pg-raw">
                  <summary>Request{s.collected?.final ? " and reply" : ""} JSON</summary>
                  <p className="pg-section-label">Request</p>
                  <JsonTree value={s.body} openDepth={2} />
                  {s.collected?.final ? (
                    <>
                      <p className="pg-section-label">Reply</p>
                      <JsonTree value={s.collected.final} openDepth={2} />
                    </>
                  ) : null}
                </details>
              </li>
            ) : (
              <li key={i} className="pg-step">
                <p className="pg-step-title">
                  <span className="pg-step-num">{i + 1}</span>
                  Your code runs {s.results.length === 1 ? "the tool" : `${s.results.length} tools`}
                </p>
                <ul className="pg-toolcall-list">
                  {s.results.map((r, j) => (
                    <li key={r.call.callId || j} className={`pg-toolcall ${r.run && !r.run.ok ? "pg-toolcall-bad" : ""}`}>
                      <p className="pg-toolcall-head">
                        <code className="pg-toolcall-name">{r.call.name}</code>
                        <code className="pg-muted">{r.call.callId}</code>
                        {r.run ? <span className="pg-muted">{r.run.ms} ms</span> : <span className="pg-muted">running</span>}
                      </p>
                      <pre className="pg-pre">{prettyArguments(r.call.arguments) || "{}"}</pre>
                      {r.run ? (
                        <>
                          <p className="pg-section-label">{protocol === "responses" ? "function_call_output" : "tool message"}</p>
                          <JsonTree value={r.run.value} openDepth={3} />
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </li>
            ),
          )}
        </ol>
      ) : null}

      {action === "done" && answer ? (
        <div className="pg-final" role="status">
          <p className="pg-section-label">Final answer</p>
          <div className="pg-stream-text">{answer}</div>
        </div>
      ) : null}
      {action === "limit" ? <p className="pg-hint">Stopped after {maxCalls} model calls, this demo&apos;s limit. Reset to start over.</p> : null}

      <ErrorBox error={runner.error} />

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? (
        <CodeView method="POST" path={PROTOCOL_PATH[protocol]} body={codeBody} caption={!finished && !busy ? "The request the next step sends" : "The last request"} />
      ) : null}
    </div>
  );
}
