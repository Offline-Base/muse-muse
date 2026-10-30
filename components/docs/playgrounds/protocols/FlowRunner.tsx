"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { Field, TextArea, TextInput } from "@/components/docs/kit/Field";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { latencyLabel, statusText } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { EventLog, ReplyView } from "@/components/docs/kit/StreamView";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { isAborted, useDocsRun } from "@/components/docs/kit/useDocsRun";
import {
  describeMissing,
  expectsError,
  firstStandIn,
  flowCost,
  methodOf,
  pollDone,
  previewTemplate,
  rateLimitWaitMs,
  resolveTemplate,
  retryReason,
  sampleRefs,
  shownFields,
  skipsRecord,
  verdictOf,
  type FlowContext,
  type FlowSpec,
  type FlowStep,
  type RetriesLeft,
  type StepReply,
  type Verdict,
} from "@/components/docs/playgrounds/protocols/flow";
import { ModelMenu } from "@/components/docs/playgrounds/protocols/ModelMenu";
import styles from "@/components/docs/playgrounds/protocols/protocols.module.css";
import { sseReader, type DocsError, type DocsResult, type SseEvent } from "@/lib/docs/client/api";
import { displayBody } from "@/lib/docs/client/codegen";
import { costExtrasOf, formatUsd } from "@/lib/docs/client/cost";
import { eventType, logEvent, type EventLogEntry } from "@/lib/docs/client/events";
import { fetchSample, readFileAs } from "@/lib/docs/client/files";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { collectorFor, collectReply, protocolOfPath, protocolOfReply, type Collected } from "@/lib/docs/client/stream";
import { sampleById } from "@/lib/docs/media/samples";
import { groupThousands } from "@/lib/format";

/**
 * Runs a page's pattern as real requests, one step after another (flow.ts describes a flow): each step's path and
 * body are filled from the replies before it, sent through the docs proxy with useDocsRun (so each one is recorded for
 * the copy prompt, except documented-error checks and clean-ups), and its reply is held up to what the page says: the
 * status it documents, the fields it names, the events a stream carries. "Run all steps" goes to the end, "Next step"
 * runs one at a time, and each step shows its request, its reply, its events and its code. A failure stops the run
 * unless the steps are independent checks. Every call counts toward the live docs' per-minute limits, so a flow can
 * space its steps (paceMs), a 429 with a short retry-after is waited out once, and one that persists stops the run.
 */

export interface FlowRunnerProps extends FlowSpec {
  slug: string;
  /** The Run button's label. Default "Run all steps". */
  runLabel?: string;
}

type StepStatus = "idle" | "running" | "ok" | "bad" | "blocked";

interface StepState {
  status: StepStatus;
  path?: string;
  body?: unknown;
  result?: DocsResult;
  reply?: StepReply;
  collected?: Collected | null;
  log?: EventLogEntry[];
  verdict?: Verdict;
  /** Why the step couldn't be built. */
  missing?: string;
  attempts?: number;
  /** A poll that ran out of tries before the value it waits for. */
  pollNote?: string;
  /** Why the step was sent more than once. */
  retryNote?: string;
  /** Requests this step sent: polls and retries count. */
  sends?: number;
  /** An unexpected failure, for ErrorBox. */
  error?: DocsError | null;
}

const IDLE: StepState = { status: "idle" };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

function tryJson(text: string): unknown {
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

/** Keeps the running step in view, but only while the reader is looking at the flow: no pulling them back to it. */
function followStep(el: HTMLElement | null | undefined) {
  const list = el?.parentElement;
  if (!el || !list) return;
  const box = list.getBoundingClientRect();
  if (box.bottom < 0 || box.top > window.innerHeight) return;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
}

function usesModel(steps: readonly FlowStep[]): boolean {
  return JSON.stringify(steps.map((s) => [s.path, s.body])).includes("{{model}}");
}

export function FlowRunner(props: FlowRunnerProps) {
  const id = useId();
  const runner = useDocsRun();
  const steps = props.steps;
  const [model, setModel] = useState(props.model ?? DEFAULT_TEXT_MODEL);
  const [vars, setVars] = useState<Record<string, string>>(() => Object.fromEntries((props.vars ?? []).map((v) => [v.name, v.value])));
  const [states, setStates] = useState<StepState[]>(() => steps.map(() => IDLE));
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState("");
  const statesRef = useRef<StepState[]>(states);
  const stopRef = useRef<AbortController | null>(null);
  const samples = useRef<Record<string, string>>({});
  const itemRefs = useRef<Array<HTMLLIElement | null>>([]);
  const showModel = usesModel(steps);

  useEffect(() => () => stopRef.current?.abort(), []);

  const update = (i: number, patch: Partial<StepState>) => {
    statesRef.current = statesRef.current.map((s, j) => (j === i ? { ...s, ...patch } : s));
    setStates(statesRef.current);
  };

  const context = (): FlowContext => {
    const replies: Record<string, StepReply> = {};
    statesRef.current.forEach((s, j) => {
      if (s.reply) replies[steps[j].id] = s.reply;
    });
    return { model, vars, steps: replies, samples: samples.current };
  };

  const loadSamples = async (ids: string[]) => {
    for (const sid of ids) {
      if (samples.current[sid]) continue;
      const sample = sampleById(sid);
      if (!sample) continue;
      samples.current[sid] = await readFileAs(await fetchSample(sample), "dataUrl");
    }
  };

  /** One request: streamed, read whole, or a GET that answers with a stream (a background retrieval). */
  const send = async (i: number, step: FlowStep, path: string, body: unknown) => {
    const method = methodOf(step);
    const streaming = !!step.stream && method === "POST";
    const protocol = streaming ? protocolOfPath(path) : null;
    let collector = protocol ? collectorFor(protocol) : null;
    let log: EventLogEntry[] = [];
    const types: string[] = [];
    let last = 0;
    const onEvent = (e: SseEvent) => {
      collector?.push(e);
      log = logEvent(log, e);
      const t = eventType(e);
      if (!types.includes(t)) types.push(t);
      // Repaint at most every 80 ms: a long stream sends hundreds of events.
      const now = performance.now();
      if (now - last > 80) {
        last = now;
        update(i, { collected: collector?.snapshot() ?? null, log });
      }
    };
    update(i, { sends: (statesRef.current[i].sends ?? 0) + 1 });
    const result = await runner.run(path, {
      method,
      ...(body !== undefined ? { body } : {}),
      stream: streaming,
      onEvent: streaming ? onEvent : undefined,
      // A deliberately invalid body or a clean-up delete would make a poor "What I just ran" for the copy prompt.
      ...(skipsRecord(step) ? { record: false as const } : {}),
    });
    let json: unknown = result.json;
    if (!streaming && result.ok && (result.headers["content-type"] ?? "").startsWith("text/event-stream") && result.text) {
      collector = collectorFor(protocolOfPath(path.split("?")[0].split("/")[0]) ?? "responses");
      const reader = sseReader(onEvent);
      reader.push(result.text);
      reader.end();
    }
    let collected: Collected | null = collector ? collector.snapshot() : null;
    if (collector) json = collected?.final ?? null;
    else if (result.ok) {
      const p = protocolOfReply(json);
      collected = p ? collectReply(p, json) : null;
    }
    if (!result.ok) json = result.json ?? tryJson(result.text);
    const reply: StepReply = { status: result.status, ok: result.ok, json, text: collected?.text ?? "", events: types };
    return { result, reply, collected, log };
  };

  /** A step's outcome: its status, "stopped" (Stop was pressed), or "limited" (still rate limited after waiting). */
  const runOne = async (i: number, signal: AbortSignal): Promise<StepStatus | "stopped" | "limited"> => {
    const step = steps[i];
    update(i, { ...IDLE, status: "running" });
    followStep(itemRefs.current[i]);
    try {
      await loadSamples(sampleRefs(step));
    } catch {
      update(i, { status: "blocked", missing: "The sample file didn't load. Check your connection and try again." });
      return "blocked";
    }
    const ctx = context();
    const path = resolveTemplate(step.path, ctx);
    const body = step.body === undefined ? ({ ok: true, value: undefined } as const) : resolveTemplate(step.body, ctx);
    if (!path.ok || !body.ok) {
      const missing = !path.ok ? path.missing : !body.ok ? body.missing : "";
      update(i, { status: "blocked", missing: describeMissing(missing, steps) });
      return "blocked";
    }
    update(i, { path: path.value, body: body.value });
    // Checks may name earlier replies too ("previous_response_id equals {{turn1.id}}").
    const expect = step.expect ? resolveTemplate(step.expect, ctx) : null;
    const judged: FlowStep = expect?.ok ? { ...step, expect: expect.value } : step;
    if (step.waitMs) await sleep(step.waitMs, signal);
    if (signal.aborted) {
      update(i, { status: "idle" });
      return "stopped";
    }
    const tries = step.poll ? Math.max(1, step.poll.tries ?? 30) : 1;
    const left: Required<RetriesLeft> = { listed: step.retry?.tries ?? 2, transient: 1, rate: 1 };
    let retryNote: string | undefined;
    for (let attempt = 1; attempt <= tries; attempt++) {
      update(i, { attempts: attempt });
      let out = await send(i, step, path.value, body.value);
      // A read right after a create can 404 while storage catches up, Meta's 5xx errors pass, and a per-minute limit
      // resets within the minute: try again after a pause (a rate limit's own retry-after).
      for (
        let why = retryReason(step, out.result.status, left, out.result.error);
        why && !isAborted(out.result) && !signal.aborted;
        why = retryReason(step, out.result.status, left, out.result.error)
      ) {
        left[why]--;
        const message = out.result.error?.message;
        const waitMs = why === "rate" ? (rateLimitWaitMs(out.result.status, out.result.error) ?? 2000) : (step.retry?.delayMs ?? 2000);
        const secs = Math.round(waitMs / 1000);
        retryNote =
          why === "listed"
            ? `The first try got ${out.result.status}: storage can lag a moment behind a new response, so it was retried, as the guide suggests.`
            : why === "rate"
              ? `The first try was rate limited (${message ?? "429"}), so it waited ${secs} s for the limit to reset and tried once more.`
              : `Meta answered ${out.result.status}${message ? ` (${message})` : ""}, so it was sent once more.`;
        update(i, { retryNote: why === "rate" ? `Rate limited: ${message ?? "429 Too Many Requests."} Waiting ${secs} s, then trying once more.` : retryNote });
        await sleep(waitMs, signal);
        if (signal.aborted) break;
        out = await send(i, step, path.value, body.value);
      }
      if (isAborted(out.result) || signal.aborted) {
        update(i, { status: "idle", attempts: undefined });
        return "stopped";
      }
      const verdict = verdictOf(judged, out.reply);
      const settled = !step.poll || !out.reply.ok || pollDone(step.poll, out.reply.json);
      if (settled || attempt === tries) {
        const pollNote =
          step.poll && !settled ? `Still ${String((out.reply.json as Record<string, unknown> | null)?.[step.poll.path] ?? "running")} after ${tries} tries. Run this step again to keep waiting.` : undefined;
        // Still the status the step retries on: Meta hasn't stored the response yet. Say so instead of a generic 404.
        if (step.retry?.statuses.includes(out.result.status)) {
          retryNote = `Still ${out.result.status} after ${(step.retry.tries ?? 2) + 1} tries: Meta hasn't stored this response yet. Storage can lag behind a new response, so retry this step in a few seconds.`;
        }
        const status: StepStatus = verdict.pass && !pollNote ? "ok" : "bad";
        const limited = out.result.status === 429 && !verdict.statusOk;
        update(i, { ...out, verdict, status, pollNote, retryNote: limited ? undefined : retryNote, error: verdict.statusOk ? null : out.result.error });
        setAnnounce(
          limited
            ? `Stopped at step ${i + 1} of ${steps.length}, ${step.title}: rate limited. Retry it once the limit resets.`
            : `Step ${i + 1} of ${steps.length}, ${step.title}: ${statusText(out.result)}${verdict.pass ? "" : ", not what the page says"}.`,
        );
        return limited ? "limited" : status;
      }
      update(i, { ...out, verdict });
      await sleep(step.poll?.everyMs ?? 1500, signal);
      if (signal.aborted) {
        update(i, { status: "idle" });
        return "stopped";
      }
    }
    return "bad";
  };

  const run = async (from: number, onlyOne: boolean) => {
    if (busy) return;
    const ctrl = new AbortController();
    stopRef.current = ctrl;
    setBusy(true);
    if (from === 0 && !onlyOne) {
      statesRef.current = steps.map(() => IDLE);
      setStates(statesRef.current);
    }
    for (let i = from; i < steps.length; i++) {
      // Spread a list of quick checks out: each one counts toward the per-minute limits, rejected or not.
      if (props.paceMs && i > from) {
        await sleep(props.paceMs, ctrl.signal);
        if (ctrl.signal.aborted) break;
      }
      const status = await runOne(i, ctrl.signal);
      // Still rate limited after waiting once: every step after it would be too, so stop here.
      if (status === "stopped" || status === "limited" || onlyOne) break;
      const s = statesRef.current[i];
      const hardFail = status === "blocked" || (status === "bad" && s.verdict && !s.verdict.statusOk);
      // A failed step stops the run, unless every step after it stands alone.
      if (hardFail && !steps[i].independent && !steps.slice(i + 1).every((x) => x.independent)) break;
    }
    stopRef.current = null;
    setBusy(false);
  };

  const stop = () => {
    stopRef.current?.abort();
    runner.abort();
  };

  const reset = () => {
    stop();
    runner.reset();
    statesRef.current = steps.map(() => IDLE);
    setStates(statesRef.current);
    setAnnounce("");
  };

  // The step Run step offers: the one a run stopped at (its request failed, or it was rate limited), else the first
  // that hasn't run.
  const stoppedAt = states.findIndex(
    (s, j) => (s.status === "bad" && s.verdict && !s.verdict.statusOk && (!steps[j].independent || s.result?.status === 429)) || s.status === "blocked",
  );
  const nextIndex = stoppedAt >= 0 ? stoppedAt : states.findIndex((s) => s.status === "idle");
  // What each step will send, for showing before it runs: everything but the values earlier replies fill in.
  const previewCtx: FlowContext = {
    model,
    vars,
    steps: Object.fromEntries(states.flatMap((s, j) => (s.reply ? [[steps[j].id, s.reply]] : []))),
  };
  const total = useMemo(
    () =>
      flowCost(
        states.filter((s) => s.reply).map((s) => ({ model: s.result?.model ?? null, json: s.reply!.json, usage: s.collected?.usage ?? undefined })),
      ),
    [states],
  );
  const calls = states.reduce((n, s) => n + (s.sends ?? 0), 0);
  const done = states.filter((s) => s.status === "ok" || s.status === "bad").length;
  const asPage = states.filter((s) => s.status === "ok").length;

  return (
    <div className="pg">
      {props.intro ? <p className="pg-hint">{props.intro}</p> : null}
      {showModel || props.vars?.length ? (
        <div className={styles.flowBar}>
          {showModel ? <ModelMenu value={model} onChange={setModel} allow={props.models} disabled={busy} /> : null}
        </div>
      ) : null}
      {props.vars?.length ? (
        <div className={styles.flowVars}>
          {props.vars.map((v) => {
            const fieldId = `${id}-var-${v.name}`;
            return (
              <Field key={v.name} id={fieldId} label={v.label}>
                {v.multiline ? (
                  <TextArea id={fieldId} rows={2} value={vars[v.name] ?? ""} disabled={busy} onChange={(e) => setVars((cur) => ({ ...cur, [v.name]: e.target.value }))} />
                ) : (
                  <TextInput id={fieldId} value={vars[v.name] ?? ""} disabled={busy} onChange={(e) => setVars((cur) => ({ ...cur, [v.name]: e.target.value }))} />
                )}
              </Field>
            );
          })}
        </div>
      ) : null}

      <div className={styles.flowActions}>
        <RunButton running={busy} onRun={() => void run(0, false)} onStop={stop} label={props.runLabel ?? (steps.length > 1 ? "Run all steps" : "Run")} />
        {steps.length > 1 ? (
          <button type="button" className="btn btn-sm btn-outline" disabled={busy || nextIndex < 0} onClick={() => void run(nextIndex, true)}>
            {nextIndex < 0 ? "All steps ran" : `${states[nextIndex].status === "idle" ? "Run" : "Retry"} step ${nextIndex + 1}`}
          </button>
        ) : null}
        {done ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={reset}>
            Reset
          </button>
        ) : null}
        {calls ? (
          <span className={styles.flowTotal}>
            {done} of {steps.length} ran, {asPage} as the page says · {calls} {calls === 1 ? "call" : "calls"}
            {total.tokens ? `, ${groupThousands(total.tokens)} tokens` : ""}, {formatUsd(total.usd)} est.
          </span>
        ) : null}
      </div>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>

      <ol className={`pg-steps ${styles.flowSteps}`}>
        {steps.map((step, i) => (
          <FlowStepView
            key={step.id}
            index={i}
            step={step}
            state={states[i]}
            elapsedMs={states[i].status === "running" ? runner.elapsedMs : undefined}
            refEl={(el) => {
              itemRefs.current[i] = el;
            }}
            fallbackModel={showModel ? model : null}
            preview={states[i].path === undefined ? previewTemplate({ path: step.path, body: step.body }, previewCtx, steps) : null}
          />
        ))}
      </ol>
    </div>
  );
}

function FlowStepView({
  index,
  step,
  state,
  elapsedMs,
  refEl,
  fallbackModel,
  preview,
}: {
  index: number;
  step: FlowStep;
  state: StepState;
  elapsedMs?: number;
  refEl: (el: HTMLLIElement | null) => void;
  fallbackModel: string | null;
  /** Before the step has run: its path and body with what's known filled in (flow.ts previewTemplate). */
  preview: { value: { path: string; body: unknown }; pending: boolean } | null;
}) {
  const [codeOpen, setCodeOpen] = useState(false);
  const method = methodOf(step);
  const path = state.path ?? preview?.value.path ?? step.path;
  const body = state.body ?? (preview ? preview.value.body : step.body);
  const standIns = state.body === undefined && !!preview?.pending;
  const result = state.result;
  const reply = state.reply;
  const verdict = state.verdict;
  const running = state.status === "running";
  // A documented error that came back as the page says (a step may allow a 200 too, such as a late cancel).
  const expectedError = !!verdict?.statusOk && expectsError(step) && (result?.status ?? 0) >= 400;
  const json = reply?.json;
  const errorMessage = result?.error?.message ?? "";
  const errorParam = (json as { error?: { param?: unknown } } | null)?.error?.param;
  const fields = reply?.ok ? shownFields(step, json) : [];
  const usage = state.collected?.usage ?? (json as { usage?: unknown } | null)?.usage ?? null;
  const usedModel = result?.model ?? ((json as { model?: unknown } | null)?.model as string | undefined) ?? fallbackModel;
  const hasReplyText = !!state.collected && (state.collected.text || state.collected.toolCalls.length || state.collected.reasoning || state.collected.searches.length);
  const badge =
    state.status === "running"
      ? state.attempts && state.attempts > 1
        ? `Try ${state.attempts}`
        : "Running"
      : state.status === "blocked"
        ? "Can't run yet"
        : result
          ? statusText(result)
          : null;

  return (
    <li ref={refEl} className={`pg-step ${styles.flowStep}`} data-status={state.status} aria-current={running ? "step" : undefined}>
      <div className="pg-step-title">
        <span className={`pg-step-num ${styles.stepNum}`}>{index + 1}</span>
        <span className={styles.stepTitle}>{step.title}</span>
        {badge ? (
          <span
            className={`pg-status ${styles.stepBadge} ${
              state.status === "running" ? "pg-status-busy" : state.status === "ok" ? "pg-status-ok" : state.status === "idle" ? "" : "pg-status-bad"
            }`}
          >
            {badge}
          </span>
        ) : null}
      </div>
      <div className={styles.stepReq}>
        <span className={`pg-method pg-method-${method.toLowerCase()}`}>{method}</span>
        <code className={styles.stepPath}>/v1/{path}</code>
        {step.stream ? <span className="pg-badge">stream</span> : null}
      </div>
      {step.note ? <p className={styles.stepNote}>{step.note}</p> : null}
      {state.status === "blocked" && state.missing ? (
        <p className={styles.blocked} role="alert">
          {state.missing}
        </p>
      ) : null}

      {running && !state.collected?.text ? (
        <p className="pg-wait">
          {state.attempts && state.attempts > 1 ? `Polling, try ${state.attempts}` : "Waiting for the reply"}
          {elapsedMs ? `, ${latencyLabel(elapsedMs)}` : ""}...
        </p>
      ) : null}

      {result || (running && state.collected) ? (
        <div className={styles.stepResult}>
          {result ? (
            <div className={styles.stepHead}>
              <span className={`pg-status ${result.ok || expectedError ? "pg-status-ok" : "pg-status-bad"}`}>
                <span className={`pg-dot ${result.ok || expectedError ? "pg-dot-ok" : "pg-dot-bad"}`} aria-hidden />
                {statusText(result)}
              </span>
              {result.elapsedMs ? <span className="pg-meta">{latencyLabel(result.elapsedMs)}</span> : null}
              {usage ? <UsageLine model={usedModel ?? null} usage={usage} {...costExtrasOf(json)} /> : null}
            </div>
          ) : null}
          {result?.note ? <p className="pg-proxy-note">{result.note}</p> : null}

          {expectedError ? (
            <p className={styles.expected}>
              <strong>{result?.status} as the page says.</strong>
              <span className={styles.errorText}>
                {errorMessage}
                {typeof errorParam === "string" && errorParam ? ` (param: ${errorParam})` : ""}
              </span>
            </p>
          ) : null}
          {verdict && !verdict.statusOk && verdict.expected && result?.ok ? (
            <p className={styles.unexpected}>
              <strong>The API accepted this ({result.status}).</strong> The page documents {verdict.expected.join(" or ")} for it.
            </p>
          ) : null}
          {verdict && !verdict.statusOk && !result?.ok && !(result && step.retry?.statuses.includes(result.status)) ? <ErrorBox error={state.error ?? result?.error ?? null} /> : null}
          {verdict && !verdict.statusOk && result && !result.ok && step.retry?.statuses.includes(result.status) ? (
            <p className={styles.unexpected}>
              <strong>{statusText(result)}</strong>
              <span className={styles.errorText}>{errorMessage}</span>
            </p>
          ) : null}

          {hasReplyText ? (
            <div className={styles.stepText}>
              <ReplyView reply={state.collected ?? null} running={running} />
            </div>
          ) : null}
          {fields.length ? (
            <dl className={styles.fields}>
              {fields.map((f) => (
                <div key={f.path} style={{ display: "contents" }}>
                  <dt>{f.path}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {verdict?.checks.length || verdict?.events.length ? (
            <ul className="pg-checks" aria-label="What the page says">
              {verdict.checks.map((c) => (
                <li key={c.label} className={c.pass ? "pg-check-ok" : "pg-check-bad"}>
                  <span className="pg-check-mark" aria-hidden>
                    {c.pass ? "✓" : "✗"}
                  </span>
                  <span className="sr-only">{c.pass ? "Holds: " : "Doesn't hold: "}</span>
                  {c.label} <span className={styles.checkActual}>({c.actual})</span>
                </li>
              ))}
              {verdict.events.map((e) => (
                <li key={e.type} className={e.seen ? "pg-check-ok" : "pg-check-bad"}>
                  <span className="pg-check-mark" aria-hidden>
                    {e.seen ? "✓" : "✗"}
                  </span>
                  <span className="sr-only">{e.seen ? "Came: " : "Didn't come: "}</span>
                  <code>{e.type}</code>
                </li>
              ))}
            </ul>
          ) : null}
          {state.pollNote ? <p className={styles.blocked}>{state.pollNote}</p> : null}
          {state.retryNote ? <p className={state.status === "bad" ? styles.blocked : "pg-hint"}>{state.retryNote}</p> : null}
        </div>
      ) : null}

      <div className={styles.more}>
        {body !== undefined ? (
          <details className="pg-raw">
            <summary>{standIns ? "Request body (filled in when it runs)" : "Request body"}</summary>
            <JsonTree value={displayBody(body)} openDepth={2} label="Request body" />
          </details>
        ) : null}
        {json !== undefined && json !== null ? (
          <details className="pg-raw">
            <summary>Reply JSON</summary>
            <JsonTree value={json} openDepth={1} label="Reply" />
          </details>
        ) : null}
        {state.log?.length ? (
          <details className="pg-raw">
            <summary>Events ({state.log.reduce((n, e) => n + e.count, 0)})</summary>
            <EventLog events={state.log} />
          </details>
        ) : null}
        <details className="pg-raw" open={codeOpen} onToggle={(e) => setCodeOpen(e.currentTarget.open)}>
          <summary>Code</summary>
          {codeOpen ? (
            <CodeView
              method={method}
              path={path}
              body={body}
              stream={!!step.stream && method === "POST"}
              caption={standIns ? `Values from earlier replies show as stand-ins (such as ${firstStandIn([path, body]) ?? "resp_from_step_1"}) until those steps run.` : undefined}
            />
          ) : null}
        </details>
      </div>
    </li>
  );
}
