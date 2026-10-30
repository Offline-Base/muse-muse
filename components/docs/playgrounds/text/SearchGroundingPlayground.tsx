"use client";

import { Fragment, useId, useMemo, useRef, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { EffortSelect, Field, PresetPills, runOnModEnter, Segmented, TextArea, TextInput, Toggle, useModEnterHint } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { isAborted, useDocsRun } from "@/components/docs/kit/useDocsRun";
import type { SseEvent } from "@/lib/docs/client/api";
import { logEvent, type EventLogEntry } from "@/lib/docs/client/events";
import { DEFAULT_TEXT_MODEL, fitEffort, type Effort } from "@/lib/docs/client/models";
import { AnswerText } from "@/components/docs/playgrounds/text/AnswerText";
import { answerItems, itemsReader, itemsOf, type ItemsSnapshot } from "@/components/docs/playgrounds/text/items";
import {
  citedKeys,
  encodeCitations,
  groundingBody,
  groundingSteps,
  hostOf,
  numberSources,
  searchCounts,
  segmentCitations,
  sourceKey,
  type GroundingStep,
} from "@/components/docs/playgrounds/text/grounding";
import { Badge, cx, DemoTabs } from "@/components/docs/playgrounds/text/parts";
import { RuleChecks } from "@/components/docs/playgrounds/text/RuleChecks";
import type { RuleCheck } from "@/components/docs/playgrounds/text/rules";
import styles from "@/components/docs/playgrounds/text/text.module.css";

/**
 * Search grounding, live (search-grounding page): a Responses call with the `web_search` tool, its options
 * (`search_context_size`, an approximate `user_location`), and `include: ["web_search_call.results"]` for the raw
 * hits. The reply is drawn the way the page describes using it: the searches the model ran and the pages it opened,
 * the answer (drawn from its Markdown) with a numbered marker after each span a `url_citation` covers, the sources
 * those numbers point to, and the results it saw, marked where it cited them. Streams by default, so the searches
 * show as they happen.
 */

export interface GroundingLocation {
  country?: string;
  region?: string;
  city?: string;
  timezone?: string;
}

export interface GroundingPreset {
  label: string;
  prompt: string;
  contextSize?: "low" | "medium" | "high" | null;
  /** A location to send with this preset, or null to send none. Left out: keep what's set. */
  location?: GroundingLocation | null;
}

export interface SearchGroundingPlaygroundProps {
  slug: string;
  prompt?: string;
  presets?: GroundingPreset[];
  model?: string;
  models?: string[];
  /** Default "low". */
  effort?: Effort | null;
  /** Ask for web_search_call.results. Default true. */
  include?: boolean;
  /** Default true. */
  stream?: boolean;
  maxOutputTokens?: number;
  /** Quick picks for the location fields. */
  places?: Array<{ label: string; location: GroundingLocation }>;
  checks?: RuleCheck[];
  checksIntro?: string;
}

type ContextSize = "default" | "low" | "medium" | "high";

const EMPTY: ItemsSnapshot = { items: [], response: null, usage: null, error: null, done: false };

export function SearchGroundingPlayground(props: SearchGroundingPlaygroundProps) {
  const id = useId();
  const runner = useDocsRun();
  const runHint = useModEnterHint("to run");
  const [model, setModel] = useState(props.model ?? DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>(props.effort === undefined ? "low" : props.effort);
  const [stream, setStream] = useState(props.stream ?? true);
  const [include, setInclude] = useState(props.include ?? true);
  const [context, setContext] = useState<ContextSize>("default");
  const [useLocation, setUseLocation] = useState(false);
  const [location, setLocation] = useState<GroundingLocation>({ country: "GB", region: "London", city: "London", timezone: "Europe/London" });
  const [prompt, setPrompt] = useState(props.prompt ?? props.presets?.[0]?.prompt ?? "");
  const [preset, setPreset] = useState<number | null>(props.prompt ? null : props.presets?.length ? 0 : null);
  const [snap, setSnap] = useState<ItemsSnapshot>(EMPTY);
  const [sent, setSent] = useState<{ body: Record<string, unknown>; question: string } | null>(null);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [showCode, setShowCode] = useState(false);
  const eventsRef = useRef<EventLogEntry[]>([]);
  const running = runner.state === "running";

  const body = useMemo(
    () =>
      groundingBody({
        model,
        prompt,
        context,
        location: useLocation ? location : null,
        include,
        effort: fitEffort(model, effort),
        maxOutputTokens: props.maxOutputTokens,
        stream,
      }),
    [model, prompt, context, location, useLocation, include, effort, stream, props.maxOutputTokens],
  );

  const pick = (i: number) => {
    const p = props.presets?.[i];
    if (!p) return;
    setPreset(i);
    setPrompt(p.prompt);
    if (p.contextSize !== undefined) setContext(p.contextSize ?? "default");
    if (p.location !== undefined) {
      setUseLocation(p.location !== null);
      if (p.location) setLocation(p.location);
    }
  };

  const send = async () => {
    const question = prompt.trim();
    if (!question || running) return;
    const reader = itemsReader();
    eventsRef.current = [];
    setEvents([]);
    setSnap(EMPTY);
    setSent({ body, question });
    const onEvent = (e: SseEvent) => {
      reader.push(e);
      eventsRef.current = logEvent(eventsRef.current, e);
      setSnap(reader.snapshot());
      setEvents(eventsRef.current);
    };
    const res = await runner.run("responses", { method: "POST", body, stream, onEvent: stream ? onEvent : undefined });
    if (!stream && res.ok) {
      reader.push(res.json as Record<string, unknown>);
      setSnap(reader.snapshot());
    } else if (stream) {
      setSnap(reader.snapshot());
    }
  };

  const items = snap.response && snap.done ? itemsOf(snap.response) : snap.items;
  const steps = groundingSteps(items);
  const answers = answerItems(items);
  const sources = numberSources(answers);
  const cited = citedKeys(sources);
  const counts = searchCounts(steps);
  const results = steps.flatMap((s) => (s.kind === "search" && s.results ? s.results : []));
  // Meta often sends results with an empty snippet; the column only shows when some result has one.
  const withSnippets = results.some((r) => r.snippet.trim());
  const finalJson = snap.response ?? runner.result?.json ?? undefined;
  const hasRun = running || !!runner.result;

  const demo = (
    <div className={`pg ${styles.stack}`}>
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} allow={props.models} disabled={running} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={running} />
        <Toggle id={`${id}-stream`} label="Stream" checked={stream} onChange={setStream} disabled={running} />
        <Toggle id={`${id}-include`} label={<>Include raw results</>} checked={include} onChange={setInclude} disabled={running} />
      </div>

      <div className={styles.row}>
        <span className="pg-inline-field">
          <span className="pg-label" id={`${id}-ctx`}>
            Search context
          </span>
          <Segmented<ContextSize>
            label="search_context_size"
            size="sm"
            options={[
              { value: "default", label: "Default" },
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
            ]}
            value={context}
            onChange={setContext}
            disabled={running}
          />
        </span>
        <Toggle id={`${id}-loc`} label="User location" checked={useLocation} onChange={setUseLocation} disabled={running} />
      </div>

      {useLocation ? (
        <div className={cx(styles.card, styles.cardSoft)}>
          <div className={styles.inputs}>
            {(
              [
                ["country", "Country (ISO code)", "GB"],
                ["region", "Region", "London"],
                ["city", "City", "London"],
                ["timezone", "Time zone (IANA)", "Europe/London"],
              ] as const
            ).map(([key, label, placeholder]) => (
              <Field key={key} id={`${id}-loc-${key}`} label={label}>
                <TextInput
                  id={`${id}-loc-${key}`}
                  value={location[key] ?? ""}
                  placeholder={placeholder}
                  maxLength={key === "country" ? 2 : 80}
                  onChange={(e) => setLocation((l) => ({ ...l, [key]: e.target.value }))}
                  disabled={running}
                  spellCheck={false}
                />
              </Field>
            ))}
          </div>
          {props.places?.length ? (
            <PresetPills label="Places" presets={props.places} onPick={(i) => setLocation(props.places![i].location)} disabled={running} />
          ) : null}
          <p className={cx(styles.about, styles.small)}>
            Sent as <code>user_location</code> with <code>&quot;type&quot;: &quot;approximate&quot;</code>, the only type; every field is optional. It biases the
            results of searches the model runs; in our checks the model didn&apos;t see it as where you are, and asked about &quot;near me&quot; it often asked for
            your city instead of searching. Naming the place in the question works every time.
          </p>
        </div>
      ) : null}

      {props.presets?.length ? <PresetPills presets={props.presets} active={preset} onPick={pick} disabled={running} /> : null}

      <div className="pg-composer">
        <label className="sr-only" htmlFor={`${id}-prompt`}>
          Question
        </label>
        <TextArea
          id={`${id}-prompt`}
          rows={2}
          value={prompt}
          placeholder="Ask about something recent"
          onChange={(e) => {
            setPrompt(e.target.value);
            if (preset !== null && e.target.value !== props.presets?.[preset]?.prompt) setPreset(null);
          }}
          onKeyDown={runOnModEnter(() => void send())}
        />
        <div className="pg-composer-bar">
          <span className="pg-muted pg-kbd-hint">The model decides whether to search. {runHint ?? ""}</span>
          <RunButton running={running} onRun={() => void send()} onStop={runner.abort} disabled={!prompt.trim()} />
        </div>
      </div>

      {hasRun ? (
        <ResponseView
          result={running ? null : runner.result}
          running={running}
          elapsedMs={runner.elapsedMs}
          json={finalJson ?? undefined}
          usage={snap.usage ?? undefined}
          model={runner.result?.model ?? (typeof snap.response?.model === "string" ? snap.response.model : null)}
          events={events.length ? events : undefined}
        >
          <div className={styles.stack}>
            {sent ? <p className="pg-bubble-user">{sent.question}</p> : null}
            <StepsView steps={steps} running={running} />
            <AnswerView answers={answers} sources={sources} running={running} />
            {sources.length ? (
              <div>
                <p className="pg-section-label">Sources</p>
                <ol className={styles.sources}>
                  {sources.map((s) => (
                    <li key={s.n} id={`${id}-src-${s.n}`}>
                      <a href={s.url} target="_blank" rel="noopener noreferrer">
                        {s.title}
                      </a>
                      <span className={styles.host}>
                        {s.host}
                        {s.spans > 1 ? `, cited ${s.spans} times` : ""}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : !running && answers.length ? (
              <p className="pg-hint">No citations in this answer: the model may have answered without searching.</p>
            ) : null}
            {results.length ? (
              <details className={styles.details}>
                <summary>
                  {results.length} result{results.length === 1 ? "" : "s"} the model saw
                  {running ? "" : ` (${results.filter((r) => cited.has(sourceKey(r.url))).length} cited)`}
                </summary>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th scope="col">Result</th>
                        {withSnippets ? <th scope="col">Snippet</th> : null}
                        <th scope="col">Cited</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((r, i) => (
                        <tr key={`${r.url}-${i}`}>
                          <td>
                            <a href={r.url} target="_blank" rel="noopener noreferrer">
                              {r.title}
                            </a>
                            <span className={styles.host}>{hostOf(r.url)}</span>
                          </td>
                          {withSnippets ? <td className="pg-muted">{r.snippet || "(none)"}</td> : null}
                          <td>{cited.has(sourceKey(r.url)) ? <Badge tone="ok">Cited</Badge> : <span className="pg-muted">No</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className={cx(styles.about, styles.small)}>
                  The results list is every source the model considered; the url_citation annotations are the subset it cited.
                </p>
              </details>
            ) : include && !running && counts.queries ? (
              <p className="pg-hint">The searches came back without a results list.</p>
            ) : null}
            {!running && counts.calls ? (
              <p className={cx(styles.about, styles.small)}>
                {counts.queries} search quer{counts.queries === 1 ? "y" : "ies"}
                {counts.opened ? ` and ${counts.opened} page${counts.opened === 1 ? "" : "s"} opened` : ""}. Searches cost $2.50 per 1,000 queries on top of tokens; the estimate above
                counts every web_search_call, so it errs high.
              </p>
            ) : null}
            {!running && snap.response?.status === "incomplete" ? (
              <p className="pg-hint pg-bad">
                The reply stopped early ({String((snap.response.incomplete_details as { reason?: unknown } | null)?.reason ?? "incomplete")}), so the end of the answer and
                its citations may be missing. Searches add a lot of input; give the answer more room with max_output_tokens.
              </p>
            ) : null}
            {!running && runner.result && isAborted(runner.result) ? <p className="pg-muted">Stopped before the reply finished.</p> : null}
          </div>
        </ResponseView>
      ) : null}

      <ErrorBox error={runner.error} />

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="responses" body={sent && !prompt.trim() ? sent.body : body} caption="The request Run sends" /> : null}
    </div>
  );

  if (!props.checks?.length) return demo;
  return (
    <DemoTabs
      label="Search grounding demo"
      tabs={[
        { id: "demo", label: "Search and cite", content: demo },
        { id: "rules", label: "Check the rules", count: props.checks.length, content: <RuleChecks slug={props.slug} checks={props.checks} intro={props.checksIntro} models={props.models} /> },
      ]}
    />
  );
}

function StepsView({ steps, running }: { steps: readonly GroundingStep[]; running: boolean }) {
  if (!steps.length) {
    return running ? <p className="pg-wait">Waiting for the model to decide whether to search...</p> : null;
  }
  return (
    <ol className={styles.timeline} aria-label="What the model did">
      {steps.map((s) => {
        const busy = s.kind !== "note" && s.status !== "completed" && s.status !== "failed";
        const dot = cx(styles.eventDot, s.kind !== "note" && (busy ? styles.eventDotBusy : styles.eventDotAccent));
        return (
          <li key={s.id} className={styles.event}>
            <span className={dot} aria-hidden />
            <div className={styles.eventBody}>
              {s.kind === "note" ? (
                <p className={styles.note}>{s.text}</p>
              ) : s.kind === "search" ? (
                <p>
                  <strong>Searched</strong>{" "}
                  {s.queries.length ? s.queries.map((q, i) => <Fragment key={i}>{i ? ", " : ""}<q>{q}</q></Fragment>) : <span className="pg-muted">(the query isn&apos;t shown)</span>}
                  {s.results ? <span className="pg-muted"> {s.results.length} results</span> : null}
                  {busy ? <span className="pg-muted"> ({s.status.replace(/_/g, " ")})</span> : null}
                  {s.status === "failed" ? <span className="pg-bad"> (failed)</span> : null}
                </p>
              ) : s.kind === "open" ? (
                <p>
                  <strong>Opened</strong>{" "}
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noopener noreferrer">
                      {hostOf(s.url) || s.url}
                    </a>
                  ) : (
                    <span className="pg-muted">a page</span>
                  )}
                  {busy ? <span className="pg-muted"> (opening)</span> : null}
                </p>
              ) : (
                <p>
                  <strong>Looked in a page</strong> for <q>{s.pattern ?? ""}</q>
                  {s.url ? <span className={styles.host}>{hostOf(s.url)}</span> : null}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function AnswerView({ answers, sources, running }: { answers: ReturnType<typeof answerItems>; sources: ReturnType<typeof numberSources>; running: boolean }) {
  const text = answers.map((a) => a.text).join("");
  if (!text) {
    return running ? null : <p className="pg-empty">No answer text in this reply.</p>;
  }
  // The citation marks go into the text before its Markdown is read, so each marker lands right after its span even
  // inside bold text or a list item.
  const cite = {
    citedClass: styles.cited,
    marker: (m: number) => {
      const s = sources.find((x) => x.n === m);
      return (
        <sup className={styles.marker}>
          <a href={s?.url} target="_blank" rel="noopener noreferrer" title={s?.title} aria-label={`Source ${m}: ${s?.title ?? ""}`}>
            [{m}]
          </a>
        </sup>
      );
    },
  };
  return (
    <div>
      <p className="pg-section-label">Answer</p>
      {answers.map((a, i) => (
        // aria-busy holds the announcement until the answer is whole, as the kit's StreamView does.
        <div key={a.id} className={styles.answer} aria-live="polite" aria-busy={running || undefined}>
          <AnswerText
            text={encodeCitations(segmentCitations(a.text, a.annotations, sources))}
            cite={cite}
            tail={running && i === answers.length - 1 ? <span className="pg-caret" aria-hidden /> : null}
          />
        </div>
      ))}
    </div>
  );
}
