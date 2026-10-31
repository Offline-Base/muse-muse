"use client";

import { useId, useRef, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { Segmented, Toggle } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { latencyLabel } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import styles from "@/components/docs/playgrounds/cookbook-fundamentals/cookbook.module.css";
import { RequestShowcase, type ShowcaseItem } from "@/components/docs/playgrounds/cookbook-fundamentals/RequestShowcase";
import {
  backoffSchedule,
  breakerCall,
  CircuitBreaker,
  classify,
  RECIPE_BACKOFF,
  withRetry,
  type AttemptOutcome,
  type Failure,
  type RetryEvent,
} from "@/components/docs/playgrounds/cookbook-fundamentals/retry";
import { Advanced, DemoTabs, Note, SplitPills, StatusPill } from "@/components/docs/playgrounds/cookbook-fundamentals/ui";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import type { DocsResult } from "@/lib/docs/client/api";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { collectReply } from "@/lib/docs/client/stream";

/**
 * The error-handling-retry recipe, live: its complete_with_retry against real calls through the docs proxy (a valid
 * call, a 400, a 404) and against failures simulated in the page (429s, a 503, timeouts) that a demo can't ask Meta
 * for, with the backoff it waits each time; the retry-everything loop it warns against; the error envelope; the
 * parameters this reasoning model rejects; and its circuit breaker, step by step.
 */

export interface RetryDemoProps {
  slug: string;
  unsupported: ShowcaseItem[];
}

type Step = "real" | "429" | "503" | "timeout";
type BodyKind = "valid" | "n2" | "unknown";

interface Scenario {
  label: string;
  what: string;
  plan: Step[];
  body: BodyKind;
  naive?: boolean;
}

const SCENARIOS: Scenario[] = [
  { label: "A valid call", what: "Succeeds on the first attempt, so nothing is retried.", plan: ["real"], body: "valid" },
  { label: "n=2 (HTTP 400)", what: "A malformed request: surfaced at once, never retried.", plan: ["real"], body: "n2" },
  { label: "Unknown model (HTTP 404)", what: "Fix the model or path; retrying can't help. This 404 comes from the live docs' own model check.", plan: ["real"], body: "unknown" },
  { label: "Two 429s, then OK", what: "Two rate limits (simulated here), each followed by a longer wait, then the real call.", plan: ["429", "429", "real"], body: "valid" },
  { label: "A 503, then OK", what: "A server error (simulated) is transient: back off, then the real call.", plan: ["503", "real"], body: "valid" },
  { label: "Timeouts throughout", what: "Every attempt times out (simulated): the loop gives up after max_retries and raises.", plan: ["timeout"], body: "valid" },
  { label: "Retry everything (anti-pattern)", what: "The recipe's naive loop retries the 400 four times. Every attempt fails the same way.", plan: ["real"], body: "n2", naive: true },
];

const SIMULATED: Record<Exclude<Step, "real">, Failure> = {
  "429": { kind: "status", status: 429, message: "Too many requests (simulated in the page)." },
  "503": { kind: "status", status: 503, message: "Service unavailable (simulated in the page)." },
  timeout: { kind: "timeout" },
};

interface AttemptRow {
  attempt: number;
  simulated: boolean;
  label: string;
  outcome: RetryEvent["outcome"] | "pending";
  wait?: number;
  ms?: number;
  why?: string;
}

function failureLabel(f: Failure): string {
  if (f.kind === "timeout") return "timeout";
  if (f.kind === "connection") return "connection error";
  return `HTTP ${f.status}`;
}

function RetryLoop() {
  const id = useId();
  const runner = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [scenario, setScenario] = useState(0);
  const [maxRetries, setMaxRetries] = useState<"3" | "5">("5");
  const [fast, setFast] = useState(false);
  const [rows, setRows] = useState<AttemptRow[]>([]);
  const [waiting, setWaiting] = useState<number | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [envelope, setEnvelope] = useState<DocsResult | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const cancelled = useRef(false);

  const s = SCENARIOS[scenario];
  const body = (kind: BodyKind) => ({
    model: kind === "unknown" ? "muse-spark-9" : model,
    messages: [{ role: "user", content: kind === "valid" ? "Say hi in one word." : "hi" }],
    ...(kind === "n2" ? { n: 2 } : {}),
    ...(kind === "valid" ? { reasoning_effort: "minimal" } : {}),
  });

  const sleep = (seconds: number) =>
    new Promise<void>((resolve) => {
      const scale = fast ? 0.25 : 1;
      const end = performance.now() + seconds * 1000 * scale;
      const tick = () => {
        const left = (end - performance.now()) / 1000 / scale;
        if (left <= 0 || cancelled.current) {
          setWaiting(null);
          resolve();
          return;
        }
        setWaiting(left);
        setTimeout(tick, 100);
      };
      tick();
    });

  const run = async () => {
    if (busy) return;
    cancelled.current = false;
    setBusy(true);
    setRows([]);
    setSummary(null);
    setEnvelope(null);
    setAnswer(null);
    const started = performance.now();
    try {
      const send = async (attempt: number): Promise<AttemptOutcome<DocsResult>> => {
        const step = s.plan[Math.min(attempt, s.plan.length - 1)];
        const simulated = step !== "real";
        setRows((cur) => [...cur, { attempt: attempt + 1, simulated, label: simulated ? `simulated ${failureLabel(SIMULATED[step])}` : "real call", outcome: "pending" }]);
        if (simulated) {
          await new Promise((r) => setTimeout(r, fast ? 80 : 300));
          return { ok: false, failure: SIMULATED[step] };
        }
        const res = await runner.run("chat/completions", { method: "POST", body: body(s.body) });
        setRows((cur) => cur.map((r) => (r.attempt === attempt + 1 ? { ...r, label: `real call: ${res.status ? `HTTP ${res.status}` : "no reply"}`, ms: res.elapsedMs } : r)));
        if (res.ok) {
          setAnswer(collectReply("chat", res.json).text);
          return { ok: true, value: res };
        }
        setEnvelope(res);
        return { ok: false, failure: res.status === 0 ? { kind: "connection" } : { kind: "status", status: res.status, message: res.error?.message } };
      };
      const result = await withRetry(send, {
        maxRetries: s.naive ? 4 : Number(maxRetries),
        naive: s.naive,
        sleep,
        cancelled: () => cancelled.current,
        onEvent: (e) =>
          setRows((cur) => cur.map((r) => (r.attempt === e.attempt ? { ...r, outcome: e.outcome, wait: e.wait, why: e.classified ? `${e.classified.exception}: ${e.classified.why}` : undefined } : r))),
      });
      const total = latencyLabel(performance.now() - started);
      if (cancelled.current) setSummary("Stopped.");
      else if (result.ok) setSummary(`Succeeded on attempt ${result.attempts} after ${total}.`);
      else {
        const c = result.failure ? classify(result.failure) : null;
        setSummary(
          s.naive
            ? `Gave up after ${result.attempts} attempts and ${total}: the request was malformed, not transient.`
            : c?.retry
              ? `Raised ${c.exception} after ${result.attempts} attempts (${total}): out of retries.`
              : `Raised ${c?.exception ?? "an error"} on attempt ${result.attempts}, with no retries: ${c?.why ?? ""}`,
        );
      }
    } finally {
      setBusy(false);
      setWaiting(null);
    }
  };

  const err = envelope?.json && typeof envelope.json === "object" ? ((envelope.json as { error?: Record<string, unknown> }).error ?? null) : null;

  return (
    <div className="pg">
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={busy} />
        <span className="pg-inline-field pg-advanced">
          <span className="pg-label">max_retries</span>
          <Segmented<"3" | "5"> size="sm" label="max_retries" value={maxRetries} onChange={setMaxRetries} disabled={busy} options={[{ value: "3", label: "3" }, { value: "5", label: "5" }]} />
        </span>
        <Advanced>
          <Toggle id={`${id}-fast`} label="Wait 4x faster" checked={fast} onChange={setFast} disabled={busy} />
        </Advanced>
      </div>
      <SplitPills label="Scenario" presets={SCENARIOS} active={scenario} onPick={setScenario} disabled={busy} simple={5} />
      <div className={styles.spread}>
        <Note advanced>{s.what}</Note>
        <RunButton
          running={busy}
          onRun={() => void run()}
          onStop={() => {
            cancelled.current = true;
            runner.abort();
          }}
          label="Run with retries"
        />
      </div>
      {rows.length ? (
        <ol className={styles.turns} aria-label="Attempts" aria-live="polite">
          {rows.map((r) => (
            <li key={r.attempt} className={styles.turn}>
              <div className={styles.turnHead}>
                <span className={styles.turnTitle}>Attempt {r.attempt}</span>
                <span className="pg-muted">{r.label}</span>
                {r.outcome === "ok" ? (
                  <StatusPill tone="ok">done</StatusPill>
                ) : r.outcome === "retry" ? (
                  <StatusPill tone="warn">retry in {r.wait?.toFixed(2)} s</StatusPill>
                ) : r.outcome === "raise" ? (
                  <StatusPill tone="bad">raised</StatusPill>
                ) : (
                  <StatusPill tone="busy">running</StatusPill>
                )}
                {r.ms ? <span className="pg-meta">{latencyLabel(r.ms)}</span> : null}
              </div>
              {r.why ? <p className={`${styles.note} pg-advanced`}>{r.why}</p> : null}
              {r.outcome === "retry" && r.wait !== undefined && !s.naive ? (
                <p className="pg-muted pg-small">
                  wait = {RECIPE_BACKOFF.delay} x 2^{r.attempt - 1} + uniform(0, {RECIPE_BACKOFF.jitter}) = {r.wait.toFixed(2)} s
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {s.body === "valid" ? <ErrorBox error={runner.error} /> : null}
      {waiting !== null ? <p className="pg-hint" role="status">Backing off: {waiting.toFixed(1)} s left.</p> : null}
      {summary ? (
        <div className="pg-final" role="status">
          <p className="pg-section-label">Result</p>
          <p>{summary}</p>
          {answer ? (
            <div className="pg-muted">
              <p>The model said:</p>
              <MarkdownText text={answer.trim()} />
            </div>
          ) : null}
        </div>
      ) : null}
      {err ? (
        <div className={styles.compareCol}>
          <p className={styles.compareTitle}>The error envelope</p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <tbody>
                <tr>
                  <th scope="row">status_code</th>
                  <td>{envelope?.status}</td>
                </tr>
                {(["type", "param", "code", "message"] as const).map((k) => (
                  <tr key={k}>
                    <th scope="row">{k}</th>
                    <td>
                      <code>{err[k] === null || err[k] === undefined ? "null" : String(err[k])}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Note advanced>Branch on type and the status code, not code: code is often null on validation errors.</Note>
        </div>
      ) : null}
      <details className="pg-raw pg-advanced">
        <summary>The backoff schedule for max_retries {maxRetries}</summary>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">After attempt</th>
                <th scope="col" className={styles.num}>Shortest wait</th>
                <th scope="col" className={styles.num}>Longest wait</th>
              </tr>
            </thead>
            <tbody>
              {backoffSchedule(Number(maxRetries)).map((w) => (
                <tr key={w.attempt}>
                  <td>{w.attempt}</td>
                  <td className={styles.num}>{w.min.toFixed(2)} s</td>
                  <td className={styles.num}>{w.max.toFixed(2)} s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Note>Doubling spreads retries out; the jitter keeps many clients from retrying in lockstep.</Note>
      </details>
      <Note advanced>
        Throttle before a 429: Meta sends x-ratelimit-remaining-requests, x-ratelimit-limit-requests, x-ratelimit-remaining-tokens and
        x-ratelimit-limit-tokens on every reply (read them with with_raw_response). The live docs pass them on, in a reply&apos;s Headers
        tab: there they count Muse Muse&apos;s team, which every reader shares, so read your own on your own calls.
      </Note>
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="chat/completions" body={body(s.body)} caption="The real call in this scenario" /> : null}
    </div>
  );
}

function Breaker() {
  const id = useId();
  const [threshold, setThreshold] = useState<"2" | "3">("2");
  const clock = useRef(0);
  const breaker = useRef(new CircuitBreaker(2, 30, () => clock.current));
  const [log, setLog] = useState<string[]>([]);
  const [, setTick] = useState(0);
  const calls = useRef(0);

  const reset = (t = threshold) => {
    clock.current = 0;
    calls.current = 0;
    breaker.current = new CircuitBreaker(Number(t), 30, () => clock.current);
    setLog([]);
    setTick((n) => n + 1);
  };

  const call = (ok: boolean) => {
    calls.current += 1;
    const line = breakerCall(breaker.current, `call ${calls.current}`, ok);
    setLog((cur) => [...cur, line]);
    setTick((n) => n + 1);
  };

  const cooldown = () => {
    clock.current += breaker.current.cooldown;
    setLog((cur) => [...cur, "-- cooldown elapsed --"]);
    setTick((n) => n + 1);
  };

  const replay = () => {
    reset("2");
    setThreshold("2");
    // The recipe's sequence: two failures open it, a call is skipped, the cooldown passes, a trial succeeds.
    const b = breaker.current;
    const lines = [breakerCall(b, "call 1", false), breakerCall(b, "call 2", false), breakerCall(b, "call 3", true)];
    clock.current += b.cooldown;
    lines.push("-- cooldown elapsed --", breakerCall(b, "call 4", true));
    calls.current = 4;
    setLog(lines);
    setTick((n) => n + 1);
  };

  const state = breaker.current.state();
  return (
    <div className="pg">
      <p className={`${styles.lead} pg-advanced`}>
        After a run of failures the breaker opens and stops calls for a cooldown, then lets one trial through (half-open). A failed trial opens it
        again at once; a success closes it. This is the recipe&apos;s CircuitBreaker class, on a simulated clock.
      </p>
      <div className="pg-bar">
        <span className="pg-inline-field pg-advanced">
          <span className="pg-label">threshold</span>
          <Segmented<"2" | "3">
            size="sm"
            label="threshold"
            value={threshold}
            onChange={(t) => {
              setThreshold(t);
              reset(t);
            }}
            options={[
              { value: "2", label: "2" },
              { value: "3", label: "3" },
            ]}
          />
        </span>
        <span className="pg-inline-field">
          <span className="pg-label">State</span>
          <StatusPill tone={state === "open" ? "bad" : state === "half-open" ? "warn" : "ok"}>{state}</StatusPill>
          <span className="pg-muted pg-small">
            failures {breaker.current.failures}, cooldown {breaker.current.cooldown} s
          </span>
        </span>
      </div>
      <div className={styles.row}>
        <button type="button" className="btn btn-sm btn-outline" onClick={() => call(true)}>
          A call succeeds
        </button>
        <button type="button" className="btn btn-sm btn-outline" onClick={() => call(false)}>
          A call fails
        </button>
        <button type="button" className="btn btn-sm btn-outline" onClick={cooldown}>
          Let the cooldown pass
        </button>
        <button type="button" className="btn btn-sm" onClick={replay}>
          Replay the recipe&apos;s sequence
        </button>
        <button type="button" className="btn btn-sm" onClick={() => reset()}>
          Reset
        </button>
      </div>
      <pre className={styles.trace} id={`${id}-log`} role="log" aria-live="polite" aria-label="Breaker log">
        {log.length ? log.join("\n") : "Press a button to make a call."}
      </pre>
    </div>
  );
}

export function RetryDemo({ unsupported }: RetryDemoProps) {
  return (
    <DemoTabs
      label="Error handling demos"
      tabs={[
        { id: "retry", label: "Retry with backoff", content: <RetryLoop /> },
        {
          id: "unsupported",
          label: "Parameters that 400",
          content: (
            <RequestShowcase
              intro="This reasoning model rejects a few OpenAI parameters with a 400. Each request below sends one; none is worth retrying."
              items={unsupported}
            />
          ),
        },
        { id: "breaker", label: "Circuit breaker", content: <Breaker /> },
      ]}
    />
  );
}
