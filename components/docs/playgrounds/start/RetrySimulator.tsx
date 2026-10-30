"use client";

import { useId, useMemo, useState } from "react";
import { Field, Segmented, TextInput, Toggle } from "@/components/docs/kit/Field";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { CodeBlock } from "@/components/docs/playgrounds/start/CodeBlock";
import { SplitPills } from "@/components/docs/playgrounds/start/SplitPills";
import {
  PAGE_POLICY,
  planRetries,
  RETRY_SCENARIOS,
  retryCode,
  secondsLabel,
  seededRandom,
  timelineVerdict,
  type RetryPolicy,
  type TimelineStep,
} from "@/components/docs/playgrounds/start/retry";
import styles from "@/components/docs/playgrounds/start/start.module.css";

/**
 * A retry timeline: pick what the server does (429 with Retry-After, a rolling deploy, an overloaded backend, 500s,
 * a mid-stream shutdown, a 400, a 504) and the policy (first delay, growth, jitter, attempts, Retry-After), and see
 * every attempt, every wait and why, by the error-handling page's rules. Nothing is sent: it simulates, so it runs
 * instantly and costs nothing. The policy comes out as code.
 */
export function RetrySimulator({ scenario: initialScenario = "rate-limit", scenarios }: { scenario?: string; scenarios?: string[] }) {
  const id = useId();
  const list = scenarios?.length ? RETRY_SCENARIOS.filter((s) => scenarios.includes(s.id)) : RETRY_SCENARIOS;
  const [scenarioIndex, setScenarioIndex] = useState(() => Math.max(0, list.findIndex((s) => s.id === initialScenario)));
  const [policy, setPolicy] = useState<RetryPolicy>(PAGE_POLICY);
  const [seed, setSeed] = useState(7);
  const [lang, setLang] = useState<"python" | "typescript">("python");
  const scenario = list[scenarioIndex] ?? list[0];
  const timeline = useMemo(() => planRetries(scenario.outcomes, policy, seededRandom(seed)), [scenario, policy, seed]);
  const longest = Math.max(1, ...timeline.steps.map((s) => s.wait?.totalMs ?? 0));

  const setNumber = (key: keyof RetryPolicy, min: number, max: number) => (e: { target: { value: string } }) => {
    const n = Number(e.target.value);
    if (Number.isFinite(n)) setPolicy((p) => ({ ...p, [key]: Math.min(max, Math.max(min, n)) }));
  };

  return (
    <div className="pg">
      <SplitPills label="The server" presets={list} active={scenarioIndex} onPick={setScenarioIndex} />
      <p className="pg-hint">{scenario.story}</p>
      <div className={styles.policy}>
        <Field id={`${id}-base`} label="First delay (ms)">
          <TextInput id={`${id}-base`} type="number" inputMode="numeric" min={0} max={10000} step={100} value={policy.baseMs} onChange={setNumber("baseMs", 0, 10000)} />
        </Field>
        <Field id={`${id}-factor`} label="Growth per retry" className="pg-advanced">
          <TextInput id={`${id}-factor`} type="number" inputMode="decimal" min={1} max={4} step={0.5} value={policy.factor} onChange={setNumber("factor", 1, 4)} />
        </Field>
        <Field id={`${id}-jitter`} label="Jitter, up to (ms)" className="pg-advanced">
          <TextInput id={`${id}-jitter`} type="number" inputMode="numeric" min={0} max={5000} step={100} value={policy.jitterMs} onChange={setNumber("jitterMs", 0, 5000)} />
        </Field>
        <Field id={`${id}-attempts`} label="Attempts in all">
          <TextInput id={`${id}-attempts`} type="number" inputMode="numeric" min={1} max={8} step={1} value={policy.maxAttempts} onChange={setNumber("maxAttempts", 1, 8)} />
        </Field>
      </div>
      <div className="pg-actions pg-advanced">
        <Toggle id={`${id}-ra`} label="Wait at least Retry-After" checked={policy.honorRetryAfter} onChange={(on) => setPolicy((p) => ({ ...p, honorRetryAfter: on }))} />
        <button type="button" className="btn btn-outline btn-sm" onClick={() => setSeed((s) => s + 1)}>
          Reshuffle the jitter
        </button>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => setPolicy(PAGE_POLICY)} disabled={JSON.stringify(policy) === JSON.stringify(PAGE_POLICY)}>
          The page&apos;s policy
        </button>
      </div>

      <ol className={styles.timeline} aria-label="Attempts">
        {timeline.steps.map((step) => (
          <Attempt key={step.attempt} step={step} longest={longest} />
        ))}
      </ol>
      <p className={`pg-verdict ${timeline.result === "success" ? "pg-good" : "pg-bad"}`} role="status" aria-live="polite">
        {timelineVerdict(timeline)}
      </p>

      <div className="pg-bar pg-advanced">
        <Segmented<"python" | "typescript">
          label="Language"
          size="sm"
          options={[
            { value: "python", label: "Python (OpenAI SDK)" },
            { value: "typescript", label: "TypeScript (fetch)" },
          ]}
          value={lang}
          onChange={setLang}
        />
      </div>
      <div className="pg-advanced">
        <CodeBlock label={lang} syntax={lang} code={retryCode(policy, lang, DEFAULT_TEXT_MODEL)} caption="This policy as code" copyLabel="Copy the retry code" />
      </div>
    </div>
  );
}

function Attempt({ step, longest }: { step: TimelineStep; longest: number }) {
  const { outcome, wait } = step;
  const ok = step.verdict === "success";
  const status = outcome.midStream ? `200, then an error event: ${outcome.code}` : `${outcome.status}${outcome.code ? ` ${outcome.code}` : ""}`;
  return (
    <li className={styles.attempt}>
      <span className={styles.attemptAt}>{secondsLabel(step.atMs)}</span>
      <span className={styles.attemptBody}>
        <span>
          <strong>Attempt {step.attempt}</strong>{" "}
          <span className={`pg-status ${ok ? "pg-status-ok" : "pg-status-bad"}`}>{status}</span>
          {outcome.retryAfterSec && !outcome.midStream ? <span className="pg-meta"> Retry-After: {outcome.retryAfterSec}</span> : null}
        </span>
        <span className="pg-hint pg-advanced">{step.reason}</span>
        {wait ? (
          <span className={styles.wait}>
            <span
              className={`${styles.waitBar} ${wait.byRetryAfter ? styles.waitBarRetryAfter : ""}`}
              style={{ width: `${Math.max(2, (wait.totalMs / longest) * 60)}%` }}
              aria-hidden
            />
            <span>
              Wait {secondsLabel(wait.totalMs)}:{" "}
              {wait.byRetryAfter
                ? `Retry-After (${secondsLabel(wait.retryAfterMs)}) is longer than the backoff (${secondsLabel(wait.backoffMs)} + ${secondsLabel(wait.jitterMs)} jitter)`
                : `backoff ${secondsLabel(wait.backoffMs)} + ${secondsLabel(wait.jitterMs)} jitter`}
            </span>
          </span>
        ) : null}
      </span>
    </li>
  );
}
