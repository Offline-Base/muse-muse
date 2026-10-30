"use client";

import { useId, useState } from "react";
import { CodeView, ContributorNotice, ErrorBox, ResponseView, RunButton, Toggle, useDocsRun } from "@/components/docs/kit";
import type { DocsResult } from "@/lib/docs/client/api";
import { estimateCost, formatUsd } from "@/lib/docs/client/cost";
import { readCheck, type CheckLine, type CheckRequest } from "@/components/docs/playgrounds/muse-code/agent-configs";
import styles from "@/components/docs/playgrounds/muse-code/muse-code.module.css";

/**
 * "Does this config answer?": sends the request a generated config would make (its endpoint, model, reasoning and
 * include settings) through the docs proxy, one per distinct model, and checks what came back: the status, the model
 * that served it, the text, and the parts the config relies on, such as encrypted reasoning for OpenCode.
 */
export function ConfigCheck({ requests, label = "Check this config live" }: { requests: CheckRequest[]; label?: string }) {
  const id = useId();
  const runner = useDocsRun();
  const [results, setResults] = useState<Array<{ req: CheckRequest; result: DocsResult; lines: CheckLine[] }>>([]);
  const [busy, setBusy] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const models = [...new Set(requests.map((r) => String(r.body.model)))];

  const run = async () => {
    setBusy(true);
    setResults([]);
    const out: typeof results = [];
    for (const req of requests) {
      const result = await runner.run(req.path, { body: req.body });
      if (result.error?.code === "aborted") break;
      out.push({ req, result, lines: readCheck(req, result.status, result.json, result.model) });
      setResults([...out]);
      if (!result.ok) break;
    }
    setBusy(false);
  };

  const cost = results.reduce((n, r) => n + (estimateCost(r.result.model ?? String(r.req.body.model), (r.result.json as { usage?: unknown } | null)?.usage)?.usd ?? 0), 0);
  const passed = results.length === requests.length && results.every((r) => r.lines.every((l) => l.ok));

  return (
    <div className={`${styles.card} ${styles.cardMuted}`}>
      {models.map((m) => (
        <ContributorNotice key={m} model={m} standardHint />
      ))}
      <div className="pg-bar">
        <RunButton running={busy} onRun={() => void run()} onStop={runner.abort} label={label} />
        <span className="pg-hint">
          {requests.length === 1 ? `One request to ${requests[0].path === "messages" ? "/v1/messages" : `/v1/${requests[0].path}`} on ${models[0]}` : `${requests.length} requests, one per model: ${models.join(", ")}`}
        </span>
      </div>
      {results.length ? (
        <div className={styles.result} aria-live="polite">
          <p className={styles.big} role="status">
            {passed ? "The config answers." : busy ? "Checking..." : "The config didn't fully check out."}
            {cost ? <span className="pg-muted pg-small"> {formatUsd(cost)} est.</span> : null}
          </p>
          {results.map((r, i) => (
            <div key={i}>
              {results.length > 1 ? <p className="pg-section-label">{String(r.req.body.model)}</p> : null}
              <ul className="pg-checks">
                {r.lines.map((l, j) => (
                  <li key={j} className={l.ok ? "pg-check-ok" : "pg-check-bad"}>
                    <span className="pg-check-mark" aria-hidden>
                      {l.ok ? "✓" : "✗"}
                    </span>
                    <span className="sr-only">{l.ok ? "Pass: " : "Fail: "}</span>
                    {l.text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
      <ErrorBox error={runner.error} />
      {results.length ? <ResponseView result={results[results.length - 1].result} /> : busy ? <ResponseView result={null} running elapsedMs={runner.elapsedMs} /> : null}
      <Toggle id={`${id}-code`} label="Show the check's code" checked={showCode} onChange={setShowCode} />
      {showCode ? <CodeView method="POST" path={requests[0].path} body={requests[0].body} caption="The request the check sends (what the agent sends, with a tiny prompt)" /> : null}
    </div>
  );
}
