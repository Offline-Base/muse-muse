"use client";

import { useId, useMemo, useRef, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { EffortSelect, PresetPills, runOnModEnter, Segmented, TextArea, Toggle, useModEnterHint } from "@/components/docs/kit/Field";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { latencyLabel, statusText } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { prettyArguments } from "@/components/docs/kit/StreamView";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { isAborted, useDocsRun } from "@/components/docs/kit/useDocsRun";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import type { DocsResult } from "@/lib/docs/client/api";
import { estimateCost, formatUsd } from "@/lib/docs/client/cost";
import { DEFAULT_TEXT_MODEL, docsModelLabel, fitEffort, type Effort } from "@/lib/docs/client/models";
import { AnswerText } from "@/components/docs/playgrounds/text/AnswerText";
import { BarList, Badge, cx, DemoTabs, LazyDetails, n } from "@/components/docs/playgrounds/text/parts";
import { withChainRetry } from "@/components/docs/playgrounds/text/chain";
import { RuleChecks } from "@/components/docs/playgrounds/text/RuleChecks";
import type { RuleCheck } from "@/components/docs/playgrounds/text/rules";
import { LIBRARY_NAMESPACES, TOOL_LIBRARY, libraryShape, loadedTools, namespacesOf } from "@/components/docs/playgrounds/text/tool-library";
import {
  clientSearches,
  firstTsBody,
  functionCalls,
  loadedGroups,
  modelCalls,
  modelStepFrom,
  nextTsAction,
  nextTsBody,
  recordBody,
  savings,
  searchStepFor,
  searchedFor,
  toolSearchOutput,
  toolsStepFor,
  tsFinalAnswer,
  type SearchMode,
  type TsBase,
  type TsModelStep,
  type TsStep,
} from "@/components/docs/playgrounds/text/tool-search";
import styles from "@/components/docs/playgrounds/text/text.module.css";

/**
 * Tool search, live (tool-search page): a library of seven namespaces and 37 functions, deferred with
 * `defer_loading` inside each namespace plus one `tool_search` tool. Hosted mode lets the API search and load in the
 * same response; client-executed mode hands the search to this page, which looks through its library and sends a
 * tool_search_output back. Each step shows what was searched, what loaded, the call the model made, the mock result
 * and the answer. "Up front" counts the tokens with POST /v1/responses/input_tokens (free), deferred against every
 * schema loaded, so the saving is measured, not claimed.
 */

export interface ToolSearchPreset {
  label: string;
  prompt: string;
}

export interface ToolSearchPlaygroundProps {
  slug: string;
  /** Default "hosted". */
  mode?: SearchMode;
  hostedPresets: ToolSearchPreset[];
  clientPresets: ToolSearchPreset[];
  /** Namespaces to start with; all seven by default. */
  namespaces?: string[];
  model?: string;
  models?: string[];
  /** Default "low". Tool search needs reasoning: "none" returns 400, and the menu doesn't offer it. */
  effort?: Effort | null;
  /** Most model calls in one run. Default 6. */
  maxCalls?: number;
  checks?: RuleCheck[];
  checksIntro?: string;
}

interface Counts {
  key: string;
  deferred: number | null;
  loaded: number | null;
  bare: number | null;
}

function countKey(mode: SearchMode, base: TsBase): string {
  return JSON.stringify([mode, base.model, base.prompt, base.namespaces.map((x) => x.name), base.keepLoaded]);
}

function failedStep(n: number, body: Record<string, unknown>, res: DocsResult): TsModelStep {
  return {
    ...modelStepFrom(n, body, null),
    status: res.status,
    model: res.model,
    elapsedMs: res.elapsedMs,
    error: { code: res.error?.code ?? null, message: res.error?.message ?? "The request failed." },
  };
}

export function ToolSearchPlayground(props: ToolSearchPlaygroundProps) {
  const id = useId();
  const runner = useDocsRun();
  const counter = useDocsRun();
  const hint = useModEnterHint("runs the whole loop");
  const [mode, setMode] = useState<SearchMode>(props.mode ?? "hosted");
  const [model, setModel] = useState(props.model ?? DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>(props.effort === undefined ? "low" : props.effort);
  const [picked, setPicked] = useState<string[]>(props.namespaces?.length ? props.namespaces : LIBRARY_NAMESPACES);
  const [keepLoaded, setKeepLoaded] = useState(true);
  const presets = mode === "hosted" ? props.hostedPresets : props.clientPresets;
  const [preset, setPreset] = useState<number | null>(0);
  const [prompt, setPrompt] = useState(presets[0]?.prompt ?? "");
  const [steps, setSteps] = useState<TsStep[]>([]);
  const stepsRef = useRef<TsStep[]>([]);
  const [busy, setBusy] = useState(false);
  const stopRef = useRef(false);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [counting, setCounting] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const maxCalls = props.maxCalls ?? 6;

  const namespaces = useMemo(() => namespacesOf(picked), [picked]);
  const shape = libraryShape(namespaces, mode === "hosted" && keepLoaded);
  const base: TsBase = useMemo(
    () => ({ model, prompt: prompt.trim(), effort: fitEffort(model, effort), namespaces, keepLoaded: mode === "hosted" && keepLoaded }),
    [model, prompt, effort, namespaces, keepLoaded, mode],
  );

  const commit = (next: TsStep[]) => {
    stepsRef.current = next;
    setSteps(next);
  };

  const reset = () => {
    stopRef.current = true;
    runner.reset();
    commit([]);
  };

  /** Up-front tokens: the request as sent, the same tools all loaded, and no tools at all. Free calls, not recorded. */
  const count = async () => {
    const key = countKey(mode, base);
    setCounting(true);
    const ask = async (body: Record<string, unknown>) => {
      const res = await counter.run("responses/input_tokens", { method: "POST", body, record: false });
      const v = (res.json as { input_tokens?: unknown } | null)?.input_tokens;
      return typeof v === "number" ? v : null;
    };
    const first = firstTsBody(mode, base);
    const deferred = await ask({ model: first.model, input: first.input, tools: first.tools, parallel_tool_calls: false });
    const loaded = deferred === null ? null : await ask({ model: base.model, input: base.prompt, tools: loadedTools(namespaces), parallel_tool_calls: false });
    const bare = loaded === null ? null : await ask({ model: base.model, input: base.prompt });
    setCounts({ key, deferred, loaded, bare });
    setCounting(false);
  };

  const step = async (): Promise<void> => {
    const current = stepsRef.current;
    const action = nextTsAction(current, maxCalls);
    if (action === "model") {
      const body = nextTsBody(mode, base, current);
      const n = modelCalls(current) + 1;
      const pending: TsModelStep = { ...modelStepFrom(n, body, null), done: false };
      commit([...current, pending]);
      const res = await withChainRetry(() => runner.run("responses", { method: "POST", body, record: { body: recordBody(body) } }), body, {
        stopped: () => stopRef.current,
      });
      if (isAborted(res)) {
        stopRef.current = true;
        commit([...current, { ...pending, done: true, error: { code: "aborted", message: "Stopped." } }]);
        return;
      }
      commit([...current, res.ok ? modelStepFrom(n, body, res.json, { status: res.status, model: res.model, elapsedMs: res.elapsedMs }) : failedStep(n, body, res)]);
      return;
    }
    if (action === "search") {
      const last = current[current.length - 1] as TsModelStep;
      const call = clientSearches(last)[0];
      commit([...current, searchStepFor(call, namespaces)]);
      return;
    }
    if (action === "tools") {
      const last = current[current.length - 1] as TsModelStep;
      commit([...current, toolsStepFor(last)]);
    }
  };

  const drive = async (all: boolean) => {
    if (busy || !prompt.trim()) return;
    stopRef.current = false;
    setBusy(true);
    try {
      if (all && !stepsRef.current.length && counts?.key !== countKey(mode, base)) void count();
      for (;;) {
        const action = nextTsAction(stepsRef.current, maxCalls);
        if (action !== "model" && action !== "search" && action !== "tools") break;
        await step();
        if (!all || stopRef.current) break;
      }
    } finally {
      setBusy(false);
    }
  };

  /** A failed call that may pass on a second try (a 5xx, a rate limit, a dropped connection): take it back and go on. */
  const lastStep = steps[steps.length - 1];
  const transient = !!lastStep && lastStep.kind === "model" && !!lastStep.error && lastStep.error.code !== "aborted" && (lastStep.status === 0 || lastStep.status === 429 || (lastStep.status ?? 0) >= 500);
  const retryLast = () => {
    if (busy || !transient) return;
    commit(stepsRef.current.slice(0, -1));
    runner.reset();
    void drive(true);
  };

  const switchMode = (m: SearchMode) => {
    setMode(m);
    const list = m === "hosted" ? props.hostedPresets : props.clientPresets;
    setPreset(0);
    setPrompt(list[0]?.prompt ?? "");
    reset();
  };

  const action = nextTsAction(steps, maxCalls);
  const finished = action === "done" || action === "limit";
  const answer = action === "done" ? tsFinalAnswer(steps) : "";
  const lastModelStep = [...steps].reverse().find((s): s is TsModelStep => s.kind === "model");
  // The final answer has its own box below the steps, so the step it came from doesn't show it a second time.
  const answerStep = answer && lastModelStep ? steps.lastIndexOf(lastModelStep) : -1;
  const codeBody = !finished && !busy ? nextTsBody(mode, base, steps) : (lastModelStep?.body ?? firstTsBody(mode, base));
  const nextLabel =
    action === "search" ? "Search your library" : action === "tools" ? "Run the tools" : action === "model" ? (steps.length ? (steps[steps.length - 1].kind === "search" ? "Send the loaded tools" : "Send the results") : "Call the model") : "Step";
  const freshCounts = counts && counts.key === countKey(mode, base) ? counts : null;
  const saved = freshCounts?.deferred != null && freshCounts.loaded != null ? savings(freshCounts.deferred, freshCounts.loaded) : null;
  const locked = busy || steps.length > 0;

  const demo = (
    <div className={`pg ${styles.stack}`}>
      <div className="pg-bar">
        <span className="pg-advanced">
          <Segmented<SearchMode>
            label="Execution mode"
            options={[
              { value: "hosted", label: "Hosted" },
              { value: "client", label: "Client-executed" },
            ]}
            value={mode}
            onChange={switchMode}
            disabled={busy}
          />
        </span>
        <ModelSelect kind="text" value={model} onChange={setModel} allow={props.models} disabled={locked} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={locked} />
      </div>

      <section className={cx(styles.card, styles.cardSoft, "pg-advanced")} aria-labelledby={`${id}-lib`}>
        <div className={styles.spread}>
          <p className={styles.cardTitle} id={`${id}-lib`}>
            Tool library
          </p>
          <span className="pg-muted pg-small">
            {shape.namespaces} namespaces, {shape.functions} functions,{" "}
            {mode === "hosted" ? `${shape.deferred} deferred` : "all kept by this page until the model searches"}
          </span>
        </div>
        <div className={styles.picks} role="group" aria-label="Namespaces in the library">
          {TOOL_LIBRARY.map((ns) => {
            const on = picked.includes(ns.name);
            return (
              <button
                key={ns.name}
                type="button"
                className="pg-pill"
                aria-pressed={on}
                disabled={locked || (on && picked.length === 1)}
                title={ns.description}
                onClick={() => setPicked(on ? picked.filter((x) => x !== ns.name) : LIBRARY_NAMESPACES.filter((x) => x === ns.name || picked.includes(x)))}
              >
                {ns.name} <span className="pg-muted">{ns.functions.length}</span>
              </button>
            );
          })}
        </div>
        {mode === "hosted" && !picked.includes("crm") ? null : mode === "hosted" ? (
          <Toggle
            id={`${id}-keep`}
            label={
              <>
                Keep <code>crm.get_customer_profile</code> loaded up front (a namespace can mix both)
              </>
            }
            checked={keepLoaded}
            onChange={setKeepLoaded}
            disabled={locked}
          />
        ) : (
          <p className={styles.about}>
            The request carries only a <code>tool_search</code> tool with <code>&quot;execution&quot;: &quot;client&quot;</code>. When the model asks, this page
            searches the library above and sends back what to load.
          </p>
        )}
        <LazyDetails summary="The tools array this request sends">
          <JsonTree value={firstTsBody(mode, base).tools} openDepth={2} label="tools" />
        </LazyDetails>
      </section>

      {presets.length ? (
        <PresetPills
          presets={presets}
          active={preset}
          onPick={(i) => {
            setPreset(i);
            setPrompt(presets[i].prompt);
            reset();
          }}
          disabled={busy}
        />
      ) : null}

      <div className="pg-composer">
        <label className="sr-only" htmlFor={`${id}-prompt`}>
          Task
        </label>
        <TextArea
          id={`${id}-prompt`}
          rows={2}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            if (preset !== null && e.target.value !== presets[preset]?.prompt) setPreset(null);
          }}
          onKeyDown={runOnModEnter(() => void drive(true))}
          disabled={locked}
        />
        <div className="pg-composer-bar">
          <span className="pg-muted pg-kbd-hint">{steps.length ? "Reset to change the task or the library." : (hint ?? "")}</span>
          {steps.length ? (
            <button type="button" className="btn btn-sm" onClick={reset} disabled={busy}>
              Reset
            </button>
          ) : null}
          <button type="button" className="btn btn-sm btn-outline pg-advanced" onClick={() => void drive(false)} disabled={busy || finished || !prompt.trim()}>
            {nextLabel}
          </button>
          <RunButton
            running={busy}
            onRun={() => void drive(true)}
            onStop={() => {
              stopRef.current = true;
              runner.abort();
            }}
            label={steps.length ? "Run to the end" : "Run all"}
            disabled={finished || !prompt.trim()}
          />
        </div>
      </div>

      {/* The counts are a result once Run all or the button has made them; until then the card waits behind Options. */}
      <section className={cx(styles.card, !freshCounts && !counting && !counter.error && "pg-advanced")} aria-labelledby={`${id}-front`}>
        <div className={styles.spread}>
          <p className={styles.cardTitle} id={`${id}-front`}>
            Up front: input tokens before the model loads anything
          </p>
          <button type="button" className="btn btn-sm btn-outline pg-advanced" onClick={() => void count()} disabled={counting || !prompt.trim()}>
            {counting ? "Counting" : freshCounts ? "Count again" : "Count the tokens"}
          </button>
        </div>
        {freshCounts && freshCounts.deferred !== null && freshCounts.loaded !== null ? (
          <>
            <BarList
              label="Input tokens up front"
              items={[
                { id: "deferred", label: mode === "hosted" ? "With tool search" : "Client tool search", value: freshCounts.deferred, display: `${n(freshCounts.deferred)} tokens` },
                { id: "loaded", label: "Every schema loaded", value: freshCounts.loaded, display: `${n(freshCounts.loaded)} tokens` },
                ...(freshCounts.bare !== null ? [{ id: "bare", label: "No tools at all", value: freshCounts.bare, display: `${n(freshCounts.bare)} tokens`, muted: true }] : []),
              ]}
            />
            {saved ? (
              <p className={styles.about} role="status">
                {saved.tokens > 0 ? (
                  <>
                    Deferring keeps {n(saved.tokens)} tokens of schemas out of every request ({Math.round(saved.share * 100)}% fewer). Over 1,000 requests that is about{" "}
                    {formatUsd(estimateCost("muse-spark-1.3-contributor", { input_tokens: saved.tokens * 1000, output_tokens: 0 })?.usd ?? 0)} of input on Spark 1.3 Contributor,{" "}
                    {formatUsd(estimateCost("muse-spark-1.2", { input_tokens: saved.tokens * 1000, output_tokens: 0 })?.usd ?? 0)} on Spark Standard and{" "}
                    {formatUsd(estimateCost("muse-wonder-1.0", { input_tokens: saved.tokens * 1000, output_tokens: 0 })?.usd ?? 0)} on Muse Wonder.
                  </>
                ) : (
                  <>
                    With this few tools, tool search costs {n(-saved.tokens)} more tokens than loading every schema: its own instructions outweigh what it defers.
                    Add namespaces and the saving appears.
                  </>
                )}
              </p>
            ) : null}
            <p className={cx(styles.about, styles.small, "pg-advanced")}>
              Counted with <code>POST /v1/responses/input_tokens</code>, which tokenizes the fully rendered input (Meta&apos;s scaffolding included) and costs
              nothing. Tools the search loads later are appended at the end of the context, so the cached prefix stays intact.
            </p>
          </>
        ) : counter.error ? (
          <ErrorBox error={counter.error} />
        ) : (
          <p className={styles.about}>{counting ? "Counting three requests, free..." : "Counts this request's tokens with the library deferred, all loaded, and without tools. Run all counts them too."}</p>
        )}
      </section>

      {steps.length ? (
        <ol className="pg-steps" aria-label="Steps">
          {steps.map((s, i) => (
            <li key={i} className="pg-step">
              {s.kind === "model" ? (
                <ModelStepView step={s} index={i} answerBelow={i === answerStep} />
              ) : s.kind === "search" ? (
                <SearchStepView step={s} index={i} />
              ) : (
                <ToolsStepView step={s} index={i} />
              )}
            </li>
          ))}
        </ol>
      ) : null}

      {action === "done" && answer ? (
        <div className="pg-final" role="status">
          <p className="pg-section-label">Final answer</p>
          <AnswerText text={answer} className={styles.answer} />
        </div>
      ) : null}
      {action === "limit" ? <div className="pg-hint">Stopped after {maxCalls} model calls, this demo&apos;s limit. Reset to start over.</div> : null}
      {transient ? (
        <div className="pg-actions">
          <button type="button" className="btn btn-sm btn-outline" onClick={retryLast} disabled={busy}>
            Try that call again
          </button>
          <span className="pg-muted pg-small">Errors like this usually pass; the steps before it are kept.</span>
        </div>
      ) : null}

      <ErrorBox error={runner.error} />

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="responses" body={codeBody} caption={!finished && !busy ? "The request the next step sends" : "The last request"} /> : null}
    </div>
  );

  if (!props.checks?.length) return demo;
  return (
    <DemoTabs
      label="Tool search demo"
      tabs={[
        { id: "demo", label: "Search and call", content: demo },
        { id: "rules", label: "Check the rules", count: props.checks.length, content: <RuleChecks slug={props.slug} checks={props.checks} intro={props.checksIntro} models={props.models} /> },
      ]}
    />
  );
}

const TIMELINE_TYPES = new Set(["tool_search_call", "tool_search_output", "function_call"]);

function StepNumber({ index }: { index: number }) {
  return <span className="pg-step-num">{index + 1}</span>;
}

function ModelStepView({ step, index, answerBelow = false }: { step: TsModelStep; index: number; answerBelow?: boolean }) {
  const searches = step.items.filter((x) => x.type === "tool_search_call");
  const outputs = step.items.filter((x) => x.type === "tool_search_output");
  const calls = functionCalls(step);
  // What the timeline draws: preambles, the answer (unless it has its own box below), and the tool items.
  const shown = step.items.filter((it) =>
    it.type === "message" ? !!it.text.trim() && (it.phase === "commentary" || !answerBelow) : TIMELINE_TYPES.has(it.type),
  );
  return (
    <>
      <p className="pg-step-title">
        <StepNumber index={index} />
        Model call {step.n}
        <span className="pg-muted">
          {step.body.previous_response_id ? " with previous_response_id and the results" : Array.isArray(step.body.input) ? " replaying the turn with the loaded tools" : ""}
        </span>
      </p>
      <p className="pg-step-meta" role="status">
        {!step.done ? (
          <span className="pg-status pg-status-busy">
            <span className="pg-dot pg-dot-busy" aria-hidden />
            Running
          </span>
        ) : step.status ? (
          <span className={`pg-status ${step.error ? "pg-status-bad" : "pg-status-ok"}`}>
            <span className={`pg-dot ${step.error ? "pg-dot-bad" : "pg-dot-ok"}`} aria-hidden />
            {statusText({ status: step.status, error: null } as DocsResult)}
          </span>
        ) : null}
        {step.model ? <span className="pg-meta">{docsModelLabel(step.model)}</span> : null}
        {step.elapsedMs ? <span className="pg-meta">{latencyLabel(step.elapsedMs)}</span> : null}
        {step.response?.usage ? <UsageLine model={step.model ?? null} usage={step.response.usage} /> : null}
      </p>
      {step.error && step.error.code !== "aborted" ? <div className="pg-hint pg-bad">{step.error.message}</div> : null}
      {step.done && !step.error && shown.length ? (
        <ol className={styles.timeline} aria-label={`What model call ${step.n} returned`}>
          {shown.map((it) => {
            if (it.type === "message") {
              if (!it.text.trim()) return null;
              return it.phase === "commentary" ? (
                <li key={it.id} className={styles.event}>
                  <span className={styles.eventDot} aria-hidden />
                  <MarkdownText className={styles.note} text={it.text} />
                </li>
              ) : (
                <li key={it.id} className={styles.event}>
                  <span className={cx(styles.eventDot, styles.eventDotAccent)} aria-hidden />
                  <div className={styles.eventBody}>
                    <p className={styles.eventTitle}>Answer</p>
                    <AnswerText text={it.text} className={styles.answer} />
                  </div>
                </li>
              );
            }
            if (it.type === "tool_search_call") {
              const what = searchedFor(it);
              const client = it.raw.execution === "client";
              return (
                <li key={it.id} className={styles.event}>
                  <span className={cx(styles.eventDot, styles.eventDotAccent)} aria-hidden />
                  <div className={styles.eventBody}>
                    <p className={styles.eventTitle}>
                      tool_search_call <Badge tone="accent">{client ? "client: your app runs it" : "server: the API ran it"}</Badge>
                    </p>
                    {what.paths.length ? (
                      <div className={styles.chips} aria-label="Searched">
                        <span className="pg-muted pg-small">Searched</span>
                        {what.paths.map((p) => (
                          <span key={p} className={styles.chip}>
                            {p || "(root)"}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="pg-small">
                        Goal: <q>{what.goal}</q>
                        {client ? <span className="pg-muted"> (call_id {String(it.raw.call_id ?? "")})</span> : null}
                      </p>
                    )}
                  </div>
                </li>
              );
            }
            if (it.type === "tool_search_output") {
              const groups = loadedGroups(it);
              const total = groups.reduce((sum, g) => sum + g.functions.length, 0);
              return (
                <li key={it.id} className={styles.event}>
                  <span className={cx(styles.eventDot, styles.eventDotAccent)} aria-hidden />
                  <div className={styles.eventBody}>
                    <p className={styles.eventTitle}>
                      tool_search_output: loaded {total} function{total === 1 ? "" : "s"}, now callable
                    </p>
                    {groups.map((g, gi) => (
                      <div key={`${g.namespace}-${gi}`} className={styles.chips}>
                        {g.functions.map((f) => (
                          <span key={f} className={styles.chip}>
                            {g.namespace ? `${g.namespace}.` : ""}
                            {f}
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                </li>
              );
            }
            if (it.type === "function_call") {
              return (
                <li key={it.id} className={styles.event}>
                  <span className={cx(styles.eventDot, styles.eventDotAccent)} aria-hidden />
                  <div className={styles.eventBody}>
                    <p className={styles.eventTitle}>
                      function_call <code className="pg-toolcall-name">{String(it.raw.namespace ? `${it.raw.namespace}.${it.raw.name}` : it.raw.name)}</code>
                    </p>
                    <pre className="pg-pre pg-advanced">{prettyArguments(String(it.raw.arguments ?? "")) || "{}"}</pre>
                  </div>
                </li>
              );
            }
            return null;
          })}
        </ol>
      ) : null}
      {searches.length === 0 && outputs.length === 0 && calls.length === 0 && step.done && !step.error && step.items.every((x) => x.type !== "message" || !x.text.trim()) ? (
        <div className="pg-hint">No text or calls in this reply.</div>
      ) : null}
      {answerBelow ? <p className="pg-small pg-muted">This call&apos;s reply is the final answer, below.</p> : null}
      <LazyDetails className="pg-raw pg-advanced" summary={`Request${step.response ? " and reply" : ""} JSON`}>
        <p className="pg-section-label">Request</p>
        <JsonTree value={step.body} openDepth={2} />
        {step.response ? (
          <>
            <p className="pg-section-label">Reply</p>
            <JsonTree value={step.response} openDepth={2} />
          </>
        ) : null}
      </LazyDetails>
    </>
  );
}

function SearchStepView({ step, index }: { step: Extract<TsStep, { kind: "search" }>; index: number }) {
  return (
    <>
      <p className="pg-step-title">
        <StepNumber index={index} />
        Your app searches its library
      </p>
      <p className="pg-small">
        For the goal <q>{step.goal}</q>, a keyword search over names, descriptions and keywords picked {step.hits.length ? `${step.hits.length}:` : "nothing."}
      </p>
      {step.hits.length ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Function</th>
                <th scope="col">Why</th>
                <th scope="col" className={styles.num}>
                  Score
                </th>
              </tr>
            </thead>
            <tbody>
              {step.hits.map((h) => (
                <tr key={`${h.namespace}.${h.fn.name}`}>
                  <td>
                    <code>
                      {h.namespace}.{h.fn.name}
                    </code>
                  </td>
                  <td className="pg-muted">{h.fn.description}</td>
                  <td className={styles.num}>{h.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="pg-hint">With nothing loaded, the model can only say it found no tool. Anything left out of tool_search_output stays unavailable.</p>
      )}
      <LazyDetails className="pg-raw pg-advanced" summary="The tool_search_output it sends back">
        <JsonTree value={toolSearchOutput(step)} openDepth={3} />
      </LazyDetails>
    </>
  );
}

function ToolsStepView({ step, index }: { step: Extract<TsStep, { kind: "tools" }>; index: number }) {
  return (
    <>
      <p className="pg-step-title">
        <StepNumber index={index} />
        Your code runs {step.results.length === 1 ? "the tool" : `${step.results.length} tools`}
      </p>
      <ul className="pg-toolcall-list">
        {step.results.map((r, j) => (
          <li key={r.callId || j} className={`pg-toolcall ${r.run && !r.run.ok ? "pg-toolcall-bad" : ""}`}>
            <p className="pg-toolcall-head">
              <code className="pg-toolcall-name">{r.namespace ? `${r.namespace}.${r.name}` : r.name}</code>
              <code className="pg-muted">{r.callId}</code>
            </p>
            {r.name === "tool_search" ? (
              <p className="pg-hint">
                The model called <code>tool_search</code> as a function instead of emitting a tool_search_call, a quirk we saw on the live API. The page answers
                with a note that the tools it found are loaded, and the model carries on.
              </p>
            ) : null}
            {r.run?.matched && r.run.matched !== (r.namespace ? `${r.namespace}.${r.name}` : r.name) ? (
              <p className="pg-hint">
                The model called <code>{r.name}</code>; the page matched it to <code>{r.run.matched}</code>.
              </p>
            ) : null}
            <pre className="pg-pre pg-advanced">{prettyArguments(r.arguments) || "{}"}</pre>
            {r.run ? (
              <>
                <p className="pg-section-label pg-advanced">function_call_output</p>
                <div className="pg-advanced">
                  <JsonTree value={r.run.value} openDepth={3} />
                </div>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      <p className={cx(styles.about, styles.small, "pg-advanced")}>
        The tools run here in the page with sample data. Refunds, rollbacks and pages answer as if they were done, marked <code>simulated: true</code>; nothing happens.
      </p>
    </>
  );
}
