"use client";

import { useId, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { EffortSelect, Field, runOnModEnter, TextArea, TextInput, Toggle } from "@/components/docs/kit/Field";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { costExtrasOf } from "@/lib/docs/client/cost";
import { DEFAULT_TEXT_MODEL, docsModelLabel, fitEffort, type Effort } from "@/lib/docs/client/models";
import { CostCalculator } from "@/components/docs/playgrounds/start/CostCalculator";
import { BACKGROUND_SUBMISSIONS_PER_MINUTE, RATE_LIMIT_HEADERS, RATE_LIMITS } from "@/components/docs/playgrounds/start/facts";
import { costOfUsage, exactUsd, hasLiveLimits, liveLimits, rateLimitFit, remainingLine, type LiveLimits } from "@/components/docs/playgrounds/start/pricing";
import { RetrySimulator } from "@/components/docs/playgrounds/start/RetrySimulator";
import { SectionTabs } from "@/components/docs/playgrounds/start/SectionTabs";
import { capWonder, WONDER_COST_NOTE, WONDER_MODEL } from "@/components/docs/playgrounds/start/wonder";
import styles from "@/components/docs/playgrounds/start/start.module.css";

export type PricingSection = "calculator" | "real-call" | "limits";

/**
 * The pricing page in three parts: a calculator over its price tables, a real call whose usage is turned into the
 * page's line items, and its rate limits (the table, a check of whether a steady workload fits a model's team limits,
 * the rate-limit headers with the values Meta sent on the last reply, and the 429 backoff the page recommends). Both
 * live calls report their reply's headers, so the headers table shows whichever ran last.
 */
export function PricingDemo({ initial = "calculator" }: { slug: string; initial?: PricingSection }) {
  const [live, setLive] = useState<LiveLimits | null>(null);
  return (
    <SectionTabs
      label="Pricing and rate limits"
      initial={initial}
      sections={[
        { id: "calculator", label: "Cost calculator", content: <CostCalculator /> },
        { id: "real-call", label: "Price a real call", content: <RealCallCost onLimits={setLive} /> },
        { id: "limits", label: "Rate limits", content: <RateLimits live={live} onLimits={setLive} /> },
      ]}
    />
  );
}

function RealCallCost({ onLimits }: { onLimits(live: LiveLimits): void }) {
  const id = useId();
  const runner = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [prompt, setPrompt] = useState("In two sentences: what does Contributor mode trade for its lower price?");
  const [effort, setEffort] = useState<Effort | null>("low");
  const [search, setSearch] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const running = runner.state === "running";
  const draft: Record<string, unknown> = { model, input: prompt.trim() || "Hello" };
  const e = fitEffort(model, effort);
  if (e) draft.reasoning = { effort: e };
  if (search) draft.tools = [{ type: "web_search" }];
  const body = capWonder(draft);
  const send = async () => {
    const reply = await runner.run("responses", { method: "POST", body });
    if (reply.ok) onLimits(liveLimits(reply.model ?? model, reply.headers));
  };

  const result = runner.result;
  const json = result?.ok ? (result.json as Record<string, unknown> | null) : null;
  const searches = costExtrasOf(json).webSearches ?? 0;
  const cost = json ? costOfUsage(result?.model ?? model, json.usage, searches) : null;

  return (
    <div className="pg">
      <p className={styles.lead}>
        Send one request, then see its real <code>usage</code> priced with the page&apos;s rates, line by line. Reasoning tokens are
        output tokens; cached tokens are inside <code>input_tokens</code> and billed at the cached rate.
      </p>
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={running} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={running} />
        <Toggle id={`${id}-search`} label="Web search ($2.50 per 1,000)" checked={search} onChange={setSearch} disabled={running} />
      </div>
      <div className="pg-composer">
        <label className="sr-only" htmlFor={`${id}-prompt`}>
          Input
        </label>
        <TextArea id={`${id}-prompt`} rows={2} value={prompt} onChange={(ev) => setPrompt(ev.target.value)} onKeyDown={runOnModEnter(() => void send())} />
        <div className="pg-composer-bar">
          <span className="pg-muted pg-kbd-hint">{model === WONDER_MODEL ? WONDER_COST_NOTE : "Fractions of a cent on Contributor."}</span>
          <RunButton running={running} onRun={() => void send()} onStop={runner.abort} disabled={!prompt.trim()} />
        </div>
      </div>
      <ErrorBox error={runner.error} />
      <ResponseView result={result} running={running} elapsedMs={runner.elapsedMs} />
      {cost?.priced ? (
        <div className={styles.stack} aria-live="polite">
          <p className="pg-section-label">What this call cost, by the page&apos;s rates for {docsModelLabel(cost.model)}</p>
          <div className={`docs-table ${styles.table}`} role="group" aria-label="This call's cost" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Line</th>
                  <th scope="col" className={styles.num}>
                    Quantity
                  </th>
                  <th scope="col">Rate</th>
                  <th scope="col" className={styles.num}>
                    Cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {cost.lines.map((l) => (
                  <tr key={l.label}>
                    <td>{l.label}</td>
                    <td className={styles.num}>
                      {l.quantity.toLocaleString("en-US")} {l.unit}
                    </td>
                    <td>{l.rate}</td>
                    <td className={styles.num}>{exactUsd(l.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.total}>
            <span>
              {cost.tokens ? `${cost.tokens.reasoning.toLocaleString("en-US")} of the ${cost.tokens.output.toLocaleString("en-US")} output tokens were reasoning.` : ""}
            </span>
            <span className={styles.totalValue}>{exactUsd(cost.usd)}</span>
          </p>
          <p className="pg-hint">
            An estimate from the published prices: Meta&apos;s bill is what counts. On the same usage, Muse Spark Standard costs{" "}
            {exactUsd(costOfUsage("muse-spark-1.2", json?.usage, searches).usd)} and Muse Wonder {exactUsd(costOfUsage("muse-wonder-1.0", json?.usage, searches).usd)}.
          </p>
        </div>
      ) : null}
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="responses" body={body} /> : null}
    </div>
  );
}

function RateLimits({ live, onLimits }: { live: LiveLimits | null; onLimits(live: LiveLimits): void }) {
  const id = useId();
  const [model, setModel] = useState("muse-spark-1.3-contributor");
  const [rpm, setRpm] = useState(120);
  const [tokens, setTokens] = useState(30_000);
  const fit = rateLimitFit(model, rpm, tokens);
  const share = (x: number | null) => (x === null ? "no limit" : `${Math.round(x * 100)}%`);
  return (
    <div className="pg">
      <p className={styles.lead}>
        Limits are per team, not per key: every key in a team counts toward the same limits, and each model has its own.
      </p>
      <div className={`docs-table ${styles.table}`} role="group" aria-label="Rate limits" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col" className={styles.num}>
                Requests a minute
              </th>
              <th scope="col" className={styles.num}>
                Tokens a minute
              </th>
              <th scope="col">Other limits</th>
            </tr>
          </thead>
          <tbody>
            {RATE_LIMITS.map((l) => (
              <tr key={l.model} className={l.model === model ? styles.rowActive : undefined}>
                <td className={styles.cell}>
                  <code className="docs-code-inline">{l.model}</code>
                </td>
                <td className={styles.num}>{l.rpm === null ? "None" : l.rpm.toLocaleString("en-US")}</td>
                <td className={styles.num}>{l.tpm === null ? "None" : l.tpm.toLocaleString("en-US")}</td>
                <td>{l.other ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="pg-hint">
        Background responses add a cap of {BACKGROUND_SUBMISSIONS_PER_MINUTE} submissions a minute per team (responses already running
        go on). SAM 3.1 and Muse Image are billed per image or frame, so they have no TPM limit; Voice Transcribe is limited by streams,
        shared between realtime and files. A rejected realtime stream closes with 1013; a rejected file transcription returns 429.
      </p>

      <div>
        <p className="pg-section-label">Will a steady workload fit?</p>
        <div className={styles.inputs}>
          <Field id={`${id}-model`} label="Model" className={styles.wide}>
            <span className="select-wrap">
              <select id={`${id}-model`} className="select pg-select" value={model} onChange={(e) => setModel(e.target.value)}>
                {RATE_LIMITS.filter((l) => l.rpm !== null).map((l) => (
                  <option key={l.model} value={l.model}>
                    {l.model}
                  </option>
                ))}
              </select>
            </span>
          </Field>
          <Field id={`${id}-rpm`} label="Requests a minute">
            <TextInput id={`${id}-rpm`} type="number" min={0} value={rpm} onChange={(e) => setRpm(Math.max(0, Number(e.target.value) || 0))} />
          </Field>
          <Field id={`${id}-tok`} label="Tokens per request" hint="Input plus output">
            <TextInput id={`${id}-tok`} type="number" min={0} value={tokens} aria-describedby={`${id}-tok-hint`} onChange={(e) => setTokens(Math.max(0, Number(e.target.value) || 0))} />
          </Field>
        </div>
        {fit ? (
          <p className={`pg-verdict ${fit.fits ? "pg-good" : "pg-bad"}`} role="status" aria-live="polite">
            {fit.fits ? "Fits" : "Over the limit"}: {share(fit.requestShare)} of the requests a minute and {share(fit.tokenShare)} of the tokens a
            minute.
            {fit.maxRequestsPerMinute !== null
              ? ` At this size the team can send up to ${fit.maxRequestsPerMinute.toLocaleString("en-US")} requests a minute; the ${fit.binding === "tokens" ? "token" : "request"} limit binds first.`
              : ""}
          </p>
        ) : null}
      </div>

      <LiveHeaders live={live} onLimits={onLimits} />

      <div>
        <p className="pg-section-label">When a 429 comes anyway</p>
        <RetrySimulator scenario="rate-limit-backoff" scenarios={["rate-limit-backoff", "rate-limit"]} />
      </div>
    </div>
  );
}

/** A number as the page writes it ("3,000,000"); anything else as it came. */
function headerValue(value: string): string {
  const n = Number(value);
  return value.trim() && Number.isFinite(n) ? n.toLocaleString("en-US") : value;
}

/**
 * The page's rate-limit headers, with the values Meta sent on the last reply when there is one: from "Price a real
 * call", or from the smallest request a model takes (16 output tokens), sent here to read them.
 */
export function LiveHeaders({ live, onLimits }: { live: LiveLimits | null; onLimits(live: LiveLimits): void }) {
  const id = useId();
  const runner = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [showCode, setShowCode] = useState(false);
  const running = runner.state === "running";
  const effort = fitEffort(model, "minimal");
  const body: Record<string, unknown> = { model, input: "Reply with the word ok.", max_output_tokens: 16, ...(effort ? { reasoning: { effort } } : {}) };
  const read = async () => {
    const reply = await runner.run("responses", { method: "POST", body });
    if (reply.ok) onLimits(liveLimits(reply.model ?? model, reply.headers));
  };
  const left = live ? remainingLine(live) : null;
  return (
    <div>
      <p className="pg-section-label">Read the headers, slow down early</p>
      <div className={`docs-table ${styles.table}`} role="group" aria-label="Rate-limit headers" tabIndex={0}>
        <table>
          {live ? (
            <thead>
              <tr>
                <th scope="col">Header</th>
                <th scope="col">What it says</th>
                <th scope="col" className={styles.num}>
                  Last reply
                </th>
              </tr>
            </thead>
          ) : null}
          <tbody>
            {RATE_LIMIT_HEADERS.map((h, i) => {
              const value = live?.documented[i]?.value ?? null;
              return (
                <tr key={h.name}>
                  <td className={styles.cell}>
                    <code className="docs-code-inline">{h.name}</code>
                  </td>
                  <td>{h.description}</td>
                  {live ? <td className={styles.num}>{value === null ? "not sent" : headerValue(value)}</td> : null}
                </tr>
              );
            })}
            {live?.other.map((h) => (
              <tr key={h.name}>
                <td className={styles.cell}>
                  <code className="docs-code-inline">{h.name}</code>
                </td>
                <td>Also on the last reply.</td>
                <td className={styles.num}>{headerValue(h.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {live ? (
        <p className="pg-hint" role="status" aria-live="polite">
          {hasLiveLimits(live)
            ? `${docsModelLabel(live.model)}: ${left ?? "the headers above"}. That's Muse Muse's team, which every reader of these docs shares, so the numbers move as others run demos; your own key's team has its own.`
            : `The last reply, on ${docsModelLabel(live.model)}, carried no rate-limit headers.`}
        </p>
      ) : null}
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={running} />
        <RunButton running={running} onRun={() => void read()} onStop={runner.abort} label="Read them live" />
      </div>
      <ErrorBox error={runner.error} />
      <p className="pg-hint">
        Every successful token-based response carries these (transcription responses don&apos;t), and the live docs pass Meta&apos;s on.
        Read them live sends the smallest request a model takes (16 output tokens), a fraction of a cent.
      </p>
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="responses" body={body} /> : null}
    </div>
  );
}
