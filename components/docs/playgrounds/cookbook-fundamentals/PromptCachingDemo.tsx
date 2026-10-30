"use client";

import { useId, useMemo, useRef, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { Segmented, Toggle } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { latencyLabel } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import {
  acmePrefix,
  ACME_SENTENCE,
  CACHE_QUESTIONS,
  cacheBody,
  cacheStat,
  LAYOUT_LABEL,
  requestUuid,
  shortId,
  type CacheLayout,
} from "@/components/docs/playgrounds/cookbook-fundamentals/caching";
import styles from "@/components/docs/playgrounds/cookbook-fundamentals/cookbook.module.css";
import { Note, Parts, Stats, StatusPill } from "@/components/docs/playgrounds/cookbook-fundamentals/ui";
import { estimateCost, formatUsd } from "@/lib/docs/client/cost";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { collectReply } from "@/lib/docs/client/stream";

/**
 * The prompt-caching recipe, live: the recipe's 4,500-token Acme support prompt sent with a question, call after call,
 * with prompt_tokens and cached_tokens from each reply's usage. The layouts are the recipe's three (stable prefix,
 * a request id before it, the same id at the end), the cache key is optional (a fresh one per run starts cold, as the
 * recipe's notebook does), and prompt_cache_retention is the recipe's hint.
 */

export interface PromptCachingDemoProps {
  slug: string;
  /** How many calls Run sends. Default 3: the first repeat can miss while the cache fills. */
  calls?: number;
}

type KeyMode = "fresh" | "stable" | "none";
type Retention = "default" | "in_memory" | "24h";
type Size = "60" | "120" | "240";

interface CallRow {
  run: number;
  n: number;
  layout: CacheLayout;
  keyMode: KeyMode;
  question: string;
  prompt: number | null;
  cached: number | null;
  model: string | null;
  usage: unknown;
  ms: number;
  error: string | null;
  answer: string;
}

const LAYOUT_NOTE: Record<CacheLayout, string> = {
  stable: "The developer prompt is byte-for-byte the same every call; only the question changes, and it comes last.",
  "volatile-first": "A new request id sits in front of the stable prompt, so the first tokens differ every call and nothing matches.",
  "volatile-last": "The same request id rides at the end of the user message instead, so the long prefix still matches.",
};

export function PromptCachingDemo({ calls = 3 }: PromptCachingDemoProps) {
  const id = useId();
  const runner = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [layout, setLayout] = useState<CacheLayout>("stable");
  const [keyMode, setKeyMode] = useState<KeyMode>("fresh");
  const [retention, setRetention] = useState<Retention>("default");
  const [size, setSize] = useState<Size>("120");
  const [rows, setRows] = useState<CallRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const runNo = useRef(0);
  const keyRef = useRef<string | undefined>(undefined);
  const stopped = useRef(false);

  const prefix = useMemo(() => acmePrefix(Number(size)), [size]);

  const callBody = (question: string, cacheKey: string | undefined, requestId: string) =>
    cacheBody({
      model,
      layout,
      question,
      prefix,
      requestId,
      cacheKey,
      retention: retention === "default" ? null : retention,
      effort: "minimal",
    });

  const sendOne = async (run: number, n: number, cacheKey: string | undefined) => {
    const question = CACHE_QUESTIONS[(n - 1) % CACHE_QUESTIONS.length];
    const res = await runner.run("chat/completions", { method: "POST", body: callBody(question, cacheKey, requestUuid()) });
    const reply = res.ok ? collectReply("chat", res.json) : null;
    const stat = cacheStat(reply?.usage);
    setRows((cur) => [
      ...cur,
      {
        run,
        n,
        layout,
        keyMode,
        question,
        prompt: stat?.prompt ?? null,
        cached: stat?.cached ?? null,
        model: res.model,
        usage: reply?.usage ?? null,
        ms: res.elapsedMs,
        error: res.ok ? null : (res.error?.message ?? "The request failed."),
        answer: reply?.text ?? "",
      },
    ]);
    return res.ok;
  };

  const run = async (count: number, more = false) => {
    if (busy) return;
    stopped.current = false;
    setBusy(true);
    try {
      if (!more) {
        runNo.current += 1;
        keyRef.current = keyMode === "fresh" ? `acme-support-${shortId()}` : keyMode === "stable" ? "acme-support-v1" : undefined;
      }
      const done = rows.filter((r) => r.run === runNo.current).length;
      for (let i = 0; i < count; i++) {
        if (stopped.current) break;
        const ok = await sendOne(runNo.current, done + i + 1, keyRef.current);
        if (!ok) break;
      }
    } finally {
      setBusy(false);
    }
  };

  const current = rows.filter((r) => r.run === runNo.current);
  const earlier = rows.filter((r) => r.run !== runNo.current);
  const totals = current.reduce(
    (acc, r) => ({ prompt: acc.prompt + (r.prompt ?? 0), cached: acc.cached + (r.cached ?? 0) }),
    { prompt: 0, cached: 0 },
  );
  const usedModel = current.find((r) => r.model)?.model ?? model;
  const paid = current.reduce((n, r) => n + (estimateCost(r.model ?? model, r.usage)?.usd ?? 0), 0);
  const uncached = current.reduce((n, r) => {
    const est = estimateCost(r.model ?? model, { prompt_tokens: r.prompt ?? 0, completion_tokens: 0 });
    return n + (est?.usd ?? 0);
  }, 0);
  const promptOnly = current.reduce((n, r) => {
    const est = estimateCost(r.model ?? model, { prompt_tokens: r.prompt ?? 0, prompt_tokens_details: { cached_tokens: r.cached ?? 0 }, completion_tokens: 0 });
    return n + (est?.usd ?? 0);
  }, 0);
  const firstWarmMiss = layout === "stable" && current.length >= 2 && (current[1].cached ?? 0) === 0;

  const shownBody = (() => {
    const body = callBody(CACHE_QUESTIONS[0], keyMode === "none" ? undefined : keyMode === "stable" ? "acme-support-v1" : "acme-support-1a2b3c4d", "8f14e45f-ceea-467a-9575-0e2c4b1a6c11");
    const messages = (body.messages as Array<{ role: string; content: string }>).map((m) =>
      m.role === "developer"
        ? { ...m, content: `${m.content.slice(0, m.content.indexOf(ACME_SENTENCE) + ACME_SENTENCE.length)}... (that sentence ${size} times in all)` }
        : m,
    );
    return { ...body, messages };
  })();

  return (
    <div className="pg">
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={busy} />
      </div>
      <div className={styles.row}>
        <span className={styles.inlineLabel}>Layout</span>
        <Segmented<CacheLayout>
          size="sm"
          label="Prompt layout"
          value={layout}
          onChange={setLayout}
          disabled={busy}
          options={(["stable", "volatile-first", "volatile-last"] as const).map((v) => ({ value: v, label: LAYOUT_LABEL[v] }))}
        />
      </div>
      <Note>{LAYOUT_NOTE[layout]}</Note>
      <div className={styles.row}>
        <span className={styles.inlineLabel}>prompt_cache_key</span>
        <Segmented<KeyMode>
          size="sm"
          label="prompt_cache_key"
          value={keyMode}
          onChange={setKeyMode}
          disabled={busy}
          options={[
            { value: "fresh", label: "New key per run" },
            { value: "stable", label: "One stable key" },
            { value: "none", label: "None" },
          ]}
        />
      </div>
      <div className={styles.row}>
        <span className={styles.inlineLabel}>prompt_cache_retention</span>
        <Segmented<Retention>
          size="sm"
          label="prompt_cache_retention"
          value={retention}
          onChange={setRetention}
          disabled={busy}
          options={[
            { value: "default", label: "Not set" },
            { value: "in_memory", label: "in_memory" },
            { value: "24h", label: "24h" },
          ]}
        />
        <span className={styles.inlineLabel}>Prefix</span>
        <Segmented<Size>
          size="sm"
          label="Prefix length"
          value={size}
          onChange={setSize}
          disabled={busy}
          options={[
            { value: "60", label: "x60" },
            { value: "120", label: "x120" },
            { value: "240", label: "x240" },
          ]}
        />
      </div>
      <div className={styles.spread}>
        <span className="pg-muted pg-small">
          {calls} calls with the same prefix and different questions, about a tenth of a cent in all. A new key per run starts cold, like the recipe&apos;s notebook.
        </span>
        <span className={styles.row}>
          {current.length && !busy ? (
            <button type="button" className="btn btn-sm btn-outline" onClick={() => void run(1, true)}>
              Send one more
            </button>
          ) : null}
          <RunButton
            running={busy}
            onRun={() => void run(calls)}
            onStop={() => {
              stopped.current = true;
              runner.abort();
            }}
            label={`Send ${calls} calls`}
          />
        </span>
      </div>
      <ErrorBox error={runner.error} />

      {current.length ? (
        <>
          <Stats
            label="This run"
            items={[
              { label: "Prompt tokens", value: totals.prompt.toLocaleString("en-US"), note: `over ${current.length} call${current.length === 1 ? "" : "s"}` },
              { label: "Cached tokens", value: totals.cached.toLocaleString("en-US"), note: totals.prompt ? `${Math.round((totals.cached / totals.prompt) * 100)}% of the prompt tokens` : undefined },
              { label: "Prompt cost", value: formatUsd(promptOnly), note: `${formatUsd(uncached)} with no cache hits` },
              { label: "Whole run", value: formatUsd(paid), note: "output included" },
            ]}
          />
          <ol className={styles.turns} aria-label="Calls" aria-live="polite">
            {current.map((r) => (
              <li key={`${r.run}-${r.n}`} className={styles.turn}>
                <div className={styles.turnHead}>
                  <span className={styles.turnTitle}>Call {r.n}</span>
                  {r.error ? (
                    <StatusPill tone="bad">Failed</StatusPill>
                  ) : (r.cached ?? 0) > 0 ? (
                    <StatusPill tone="ok">warm: {Math.round(((r.cached ?? 0) / Math.max(1, r.prompt ?? 1)) * 100)}% cached</StatusPill>
                  ) : (
                    <StatusPill tone="idle">cold: 0 cached</StatusPill>
                  )}
                  <span className="pg-muted">{r.question}</span>
                  <span className="pg-meta">{latencyLabel(r.ms)}</span>
                </div>
                {r.error ? (
                  <p className="pg-bad">{r.error}</p>
                ) : (
                  <>
                    <Parts
                      label={`Call ${r.n} prompt tokens`}
                      parts={[
                        { label: "cached", value: r.cached ?? 0 },
                        { label: "computed", value: Math.max(0, (r.prompt ?? 0) - (r.cached ?? 0)), muted: true },
                      ]}
                    />
                    <p className="pg-small">
                      <UsageLine model={r.model ?? usedModel} usage={r.usage} />
                    </p>
                  </>
                )}
              </li>
            ))}
          </ol>
          {firstWarmMiss ? (
            <Note>
              Call 2 missed even though the prefix repeated: caching is best effort, and the first repeat can land on a server that hasn&apos;t stored
              the prefix yet. Later calls with the same key hit. Watch cached_tokens / prompt_tokens over time, as the recipe says.
            </Note>
          ) : null}
          {layout === "volatile-first" && current.length > 1 && current.every((r) => !r.cached) ? (
            <Note>Every call stayed cold: the request id at the top changes the first tokens, and the cache matches from the start forward.</Note>
          ) : null}
        </>
      ) : null}

      {earlier.length ? (
        <details className="pg-raw">
          <summary>Earlier runs ({new Set(earlier.map((r) => r.run)).size})</summary>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Layout</th>
                  <th scope="col">Key</th>
                  <th scope="col" className={styles.num}>Call</th>
                  <th scope="col" className={styles.num}>Prompt</th>
                  <th scope="col" className={styles.num}>Cached</th>
                </tr>
              </thead>
              <tbody>
                {earlier.map((r) => (
                  <tr key={`${r.run}-${r.n}`}>
                    <td>{r.run}</td>
                    <td>{LAYOUT_LABEL[r.layout]}</td>
                    <td>{r.keyMode === "fresh" ? "new per run" : r.keyMode}</td>
                    <td className={styles.num}>{r.n}</td>
                    <td className={styles.num}>{r.prompt?.toLocaleString("en-US") ?? "n/a"}</td>
                    <td className={styles.num}>{r.cached?.toLocaleString("en-US") ?? "n/a"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="chat/completions" body={shownBody} caption={`One call, with the ${Number(size).toLocaleString("en-US")}-sentence prefix shortened here`} /> : null}
    </div>
  );
}
