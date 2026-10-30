"use client";

import { useRef, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { latencyLabel } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import styles from "@/components/docs/playgrounds/cookbook-fundamentals/cookbook.module.css";
import { StatusPill } from "@/components/docs/playgrounds/cookbook-fundamentals/ui";
import type { DocsResult } from "@/lib/docs/client/api";
import { parseJsonText } from "@/lib/docs/client/json";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { collectReply, protocolOfPath } from "@/lib/docs/client/stream";

/**
 * A row of real requests that each make one of a recipe's points, side by side: the ones the recipe says the API
 * rejects (they come back with Meta's own 400 and its message) next to the ones that work, each with what to expect.
 * Run one, or run them all in order; every request goes through the docs proxy and is recorded for the copy prompt.
 */

export interface ShowcaseItem {
  id: string;
  label: string;
  /** What this request shows, in a sentence. */
  what: string;
  path: string;
  body: Record<string, unknown>;
  /** What the recipe says happens. */
  expect: "ok" | "error";
  /** How to read a reply that worked: show its text, or also try JSON.parse on it. */
  read?: "text" | "json";
}

export interface RequestShowcaseProps {
  items: ShowcaseItem[];
  /** A line above the rows. */
  intro?: string;
  /** Offer the model menu (every body's model is replaced by the pick). Default true. */
  modelMenu?: boolean;
}

interface Outcome {
  result: DocsResult;
  text: string | null;
  json: { ok: true; value: unknown } | { ok: false; message: string } | null;
}

export function RequestShowcase({ items, intro, modelMenu = true }: RequestShowcaseProps) {
  const runner = useDocsRun();
  const stopped = useRef(false);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [active, setActive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);

  const bodyOf = (item: ShowcaseItem) => (modelMenu && typeof item.body.model === "string" ? { ...item.body, model } : item.body);

  const runOne = async (item: ShowcaseItem) => {
    setActive(item.id);
    const res = await runner.run(item.path, { method: "POST", body: bodyOf(item) });
    const protocol = protocolOfPath(item.path);
    const text = res.ok && protocol ? collectReply(protocol, res.json).text : null;
    const json = text !== null && item.read === "json" ? parseJsonText(text) : null;
    setOutcomes((cur) => ({ ...cur, [item.id]: { result: res, text, json } }));
  };

  const run = async (only?: ShowcaseItem) => {
    if (busy) return;
    stopped.current = false;
    setBusy(true);
    try {
      for (const item of only ? [only] : items) {
        if (stopped.current) break;
        await runOne(item);
      }
    } finally {
      setBusy(false);
      setActive(null);
    }
  };

  return (
    <div className="pg">
      {intro ? <p className={styles.lead}>{intro}</p> : null}
      <div className={styles.spread}>
        {modelMenu ? <ModelSelect kind="text" value={model} onChange={setModel} disabled={busy} /> : <span />}
        <RunButton
          running={busy}
          onRun={() => void run()}
          onStop={() => {
            stopped.current = true;
            runner.abort();
          }}
          label="Run them all"
        />
      </div>
      <ul className={styles.turns} aria-live="polite">
        {items.map((item) => {
          const o = outcomes[item.id];
          const r = o?.result;
          const matched = r ? (item.expect === "ok") === r.ok : null;
          const err = r && !r.ok ? r.error : null;
          return (
            <li key={item.id} className={styles.turn}>
              <div className={styles.spread}>
                <div className={styles.turnHead}>
                  <span className={styles.turnTitle}>{item.label}</span>
                  <StatusPill tone={item.expect === "ok" ? "ok" : "warn"}>{item.expect === "ok" ? "expect 200" : "expect a 400"}</StatusPill>
                </div>
                <button type="button" className="btn btn-sm btn-outline" onClick={() => void run(item)} disabled={busy} aria-label={`Run: ${item.label}`}>
                  {active === item.id ? "Running" : "Run"}
                </button>
              </div>
              <p className={styles.note}>{item.what}</p>
              {r ? (
                <div className={styles.stack} style={{ gap: 6 }}>
                  <p className={styles.turnHead}>
                    <StatusPill tone={r.ok ? "ok" : r.status ? "bad" : "idle"}>{r.status ? `HTTP ${r.status}` : "No reply"}</StatusPill>
                    {matched !== null ? <span className="pg-muted pg-small">{matched ? "as the recipe says" : "not what the recipe says: see the reply"}</span> : null}
                    <span className="pg-meta">{latencyLabel(r.elapsedMs)}</span>
                    {r.ok && r.json && typeof r.json === "object" ? <UsageLine model={r.model} usage={(r.json as { usage?: unknown }).usage} /> : null}
                  </p>
                  {err && item.expect === "error" ? (
                    <p className={styles.result}>
                      {err.type ? `${err.type}: ` : ""}
                      {err.message}
                    </p>
                  ) : null}
                  {/* A failure the recipe doesn't predict (a rate limit, the budget) gets the kit's explanation. */}
                  {err && item.expect === "ok" ? <ErrorBox error={err} /> : null}
                  {o.text !== null ? <p className={styles.textBlock}>{o.text || "(no text)"}</p> : null}
                  {o.json ? (
                    <p className={o.json.ok ? "pg-good pg-small" : "pg-bad pg-small"}>
                      {o.json.ok ? "JSON.parse: parsed." : `JSON.parse failed: ${o.json.message}`}
                    </p>
                  ) : null}
                  <details className="pg-raw">
                    <summary>Reply JSON</summary>
                    {r.json ? <JsonTree value={r.json} openDepth={2} /> : <pre className="pg-pre">{r.text || "(empty)"}</pre>}
                  </details>
                </div>
              ) : null}
              <div className="pg-actions">
                <button type="button" className="btn btn-sm" aria-expanded={code === item.id} onClick={() => setCode(code === item.id ? null : item.id)}>
                  {code === item.id ? "Hide code" : "Show code"}
                </button>
              </div>
              {code === item.id ? <CodeView method="POST" path={item.path} body={bodyOf(item)} caption={item.label} /> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
