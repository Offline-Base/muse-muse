"use client";

import { Fragment, useId, useMemo, useRef, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { EffortSelect, PresetPills, runOnModEnter, Segmented, TextArea, Toggle } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { Searches, StreamView } from "@/components/docs/kit/StreamView";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import styles from "@/components/docs/playgrounds/cookbook-fundamentals/cookbook.module.css";
import {
  DOCUMENTED_SEARCH_REPLY,
  finalAnswerBlock,
  outputItemTypes,
  passages,
  renderWithFootnotes,
  sourceList,
} from "@/components/docs/playgrounds/cookbook-fundamentals/footnotes";
import { Note, Stats } from "@/components/docs/playgrounds/cookbook-fundamentals/ui";
import type { SseEvent } from "@/lib/docs/client/api";
import { logEvent, type EventLogEntry } from "@/lib/docs/client/events";
import { DEFAULT_TEXT_MODEL, fitEffort, type Effort } from "@/lib/docs/client/models";
import { collectReply, responsesCollector, type Collected, type SearchResult } from "@/lib/docs/client/stream";

/**
 * The search-grounding recipe, live on the Responses API: web_search on, the output items in order (reasoning,
 * web_search_call, message), the grounded answer rebuilt with footnote markers from its url_citation annotations
 * (inserted back to front, one number per URL), each cited passage, search_context_size, streaming with the
 * citations read from the final response, and the "don't assume a search ran" check. Live replies carry no
 * annotations today, so the sources the searches returned are listed instead, and Meta's documented example reply
 * can be replayed through the same rendering (no request) to show the footnotes.
 */

export interface SearchGroundingDemoProps {
  slug: string;
  presets: Array<{ label: string; prompt: string; contextSize?: ContextSize; stream?: boolean }>;
}

type ContextSize = "unset" | "low" | "medium" | "high";
type MaxCalls = "1" | "2" | "5";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * One finished Responses reply, read the way the recipe reads it: what came back, the items in order, the answer with
 * its footnotes and sources, each citation's passage, and the recipe's printout. With no annotations it says so and
 * lists `results` (what the searches returned) when there are any.
 */
function GroundedAnswer({ final, results, includeResults, onReplay }: { final: unknown; results: SearchResult[]; includeResults: boolean; onReplay?: () => void }) {
  const answer = finalAnswerBlock(final);
  const footnoted = answer ? renderWithFootnotes(answer.text, answer.annotations) : null;
  const cited = answer ? passages(answer.text, answer.annotations) : [];
  const types = outputItemTypes(final);
  const searched = types.includes("web_search_call");
  return (
    <>
      <Stats
        label="What came back"
        items={[
          { label: "Performed a search", value: searched ? "yes" : "no", note: searched ? undefined : "the model answered from what it knows" },
          { label: "web_search_call items", value: types.filter((t) => t === "web_search_call").length.toLocaleString("en-US") },
          { label: "url_citation annotations", value: cited.length.toLocaleString("en-US"), note: footnoted?.sources.length ? `${footnoted.sources.length} unique sources` : undefined },
          { label: "Results the search returned", value: includeResults ? results.length.toLocaleString("en-US") : "not asked for" },
        ]}
      />
      <p className="pg-section-label">Output items, in order</p>
      <p className={styles.act}>{types.join(" → ")}</p>
      <p className="pg-section-label">The grounded answer{footnoted?.sources.length ? ", with footnotes" : ""}</p>
      {footnoted ? (
        <p className={styles.answer} tabIndex={0}>
          {footnoted.segments.map((seg, i) => (
            <Fragment key={i}>
              {seg.text}
              {seg.marks.map((m, j) => (
                <span key={j} className={styles.mark}>
                  [{m}]
                </span>
              ))}
            </Fragment>
          ))}
        </p>
      ) : (
        <p className="pg-empty">No message item in this reply.</p>
      )}
      {footnoted?.sources.length ? (
        <>
          <p className="pg-section-label">Sources</p>
          <ol className="pg-citation-list">
            {footnoted.sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.title}
                </a>
                <span className="pg-citation-host">{hostOf(s.url)}</span>
              </li>
            ))}
          </ol>
          <details className="pg-raw">
            <summary>Each citation&apos;s passage</summary>
            <ul className="pg-checks">
              {cited.map((c, i) => (
                <li key={i}>
                  &quot;{c.passage}&quot; <span className="pg-muted">{c.title}</span>
                </li>
              ))}
            </ul>
          </details>
          <details className="pg-raw">
            <summary>As the recipe&apos;s render_with_footnotes prints it</summary>
            <pre className="pg-pre">{`${footnoted.marked}\n\nSources:\n${sourceList(footnoted.sources)}`}</pre>
          </details>
        </>
      ) : answer ? (
        <>
          <Note>
            This answer carries no url_citation annotations, so there is nothing to footnote. Live replies come back that way today, and a message without
            them is still a valid answer: drive citation rendering off the annotations that are present, never off the prose.
            {includeResults && results.length ? " The sources the search returned (from include) are below." : ""}
          </Note>
          {includeResults && results.length ? (
            <ol className="pg-citation-list" aria-label="Sources the search returned">
              {results.slice(0, 8).map((r) => (
                <li key={r.url}>
                  <a href={r.url} target="_blank" rel="noopener noreferrer">
                    {r.title || r.url}
                  </a>
                  <span className="pg-citation-host">{hostOf(r.url)}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {onReplay ? (
            <p className="pg-small">
              <button type="button" className="btn btn-sm btn-outline" onClick={onReplay}>
                See the footnotes on Meta&apos;s documented example
              </button>
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}

export function SearchGroundingDemo({ presets }: SearchGroundingDemoProps) {
  const id = useId();
  const runner = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>("low");
  const [contextSize, setContextSize] = useState<ContextSize>(presets[0]?.contextSize ?? "unset");
  const [stream, setStream] = useState(presets[0]?.stream ?? false);
  const [includeResults, setIncludeResults] = useState(true);
  const [maxCalls, setMaxCalls] = useState<MaxCalls>("2");
  const [prompt, setPrompt] = useState(presets[0]?.prompt ?? "");
  const [preset, setPreset] = useState<number | null>(presets.length ? 0 : null);
  const [live, setLive] = useState<Collected | null>(null);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [showCode, setShowCode] = useState(false);
  const [replay, setReplay] = useState(false);
  const eventsRef = useRef<EventLogEntry[]>([]);
  const replayRef = useRef<HTMLDivElement>(null);
  const running = runner.state === "running";

  const body = useMemo(() => {
    const e = fitEffort(model, effort);
    return {
      model,
      input: prompt.trim() || "...",
      tools: [{ type: "web_search", ...(contextSize !== "unset" ? { search_context_size: contextSize } : {}) }],
      ...(includeResults ? { include: ["web_search_call.results"] } : {}),
      max_tool_calls: Number(maxCalls),
      ...(e ? { reasoning: { effort: e } } : {}),
      ...(stream ? { stream: true } : {}),
    };
  }, [model, effort, prompt, contextSize, includeResults, maxCalls, stream]);

  const run = async () => {
    if (running || !prompt.trim()) return;
    const collector = responsesCollector();
    eventsRef.current = [];
    setEvents([]);
    setLive(null);
    const res = await runner.run("responses", {
      method: "POST",
      body,
      stream,
      onEvent: stream
        ? (e: SseEvent) => {
            collector.push(e);
            eventsRef.current = logEvent(eventsRef.current, e);
            setLive(collector.snapshot());
            setEvents(eventsRef.current);
          }
        : undefined,
    });
    if (!stream && res.ok) setLive(collectReply("responses", res.json));
  };

  const showReplay = () => {
    setReplay(true);
    // On the next frame, once the replay has rendered.
    requestAnimationFrame(() => replayRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }));
  };

  // Citations are only complete on the final response, streamed or not.
  const final = live?.final ?? null;
  const done = !running && !!final;
  const results = (live?.searches ?? []).flatMap((s) => s.results ?? []);
  const uniqueResults = results.filter((r, i) => results.findIndex((x) => x.url === r.url) === i);

  return (
    <div className="pg">
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={running} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={running} />
        <Toggle id={`${id}-stream`} label="Stream" checked={stream} onChange={setStream} disabled={running} />
      </div>
      <div className={styles.row}>
        <span className={styles.inlineLabel}>search_context_size</span>
        <Segmented<ContextSize>
          size="sm"
          label="search_context_size"
          value={contextSize}
          onChange={setContextSize}
          disabled={running}
          options={[
            { value: "unset", label: "Not set" },
            { value: "low", label: "low" },
            { value: "medium", label: "medium" },
            { value: "high", label: "high" },
          ]}
        />
        <span className={styles.inlineLabel}>max_tool_calls</span>
        <Segmented<MaxCalls>
          size="sm"
          label="max_tool_calls"
          value={maxCalls}
          onChange={setMaxCalls}
          disabled={running}
          options={[
            { value: "1", label: "1" },
            { value: "2", label: "2" },
            { value: "5", label: "5" },
          ]}
        />
      </div>
      <Toggle id={`${id}-results`} label={<code>include: [&quot;web_search_call.results&quot;]</code>} checked={includeResults} onChange={setIncludeResults} disabled={running} />
      <PresetPills
        presets={presets}
        active={preset}
        disabled={running}
        onPick={(i) => {
          const p = presets[i];
          setPreset(i);
          setPrompt(p.prompt);
          setContextSize(p.contextSize ?? "unset");
          setStream(!!p.stream);
        }}
      />
      <div className="pg-composer">
        <label className="sr-only" htmlFor={`${id}-prompt`}>
          Question
        </label>
        <TextArea
          id={`${id}-prompt`}
          rows={2}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            setPreset(null);
          }}
          onKeyDown={runOnModEnter(() => void run())}
          disabled={running}
        />
        <div className="pg-composer-bar">
          <span className="pg-muted pg-kbd-hint">Each search is $0.0025 on top of tokens; max_tool_calls caps them. A run is about 1 cent.</span>
          <RunButton running={running} onRun={() => void run()} onStop={runner.abort} disabled={!prompt.trim()} label="Search and answer" />
        </div>
      </div>
      <div className={styles.spread}>
        <span className="pg-muted pg-small">Live replies carry no url_citation annotations today. Meta&apos;s guide documents one that does.</span>
        <button
          type="button"
          className="btn btn-sm btn-outline"
          aria-expanded={replay}
          onClick={() => (replay ? setReplay(false) : showReplay())}
        >
          {replay ? "Hide Meta's documented example" : "Replay Meta's documented example (free)"}
        </button>
      </div>
      <ErrorBox error={runner.error} />
      {running || runner.result ? (
        <ResponseView
          result={runner.result}
          running={running}
          elapsedMs={runner.elapsedMs}
          json={final ?? undefined}
          usage={live?.usage ?? undefined}
          model={runner.result?.model ?? live?.model ?? null}
          events={events.length ? events : undefined}
        >
          <div className={styles.stack}>
            {live?.searches.length ? <Searches searches={live.searches} /> : null}
            {!done ? (
              <StreamView text={live?.text ?? ""} running={running} placeholder={running ? undefined : "No answer."} />
            ) : (
              <GroundedAnswer final={final} results={uniqueResults} includeResults={includeResults} onReplay={replay ? undefined : showReplay} />
            )}
          </div>
        </ResponseView>
      ) : null}
      {replay ? (
        <div className="pg-final" ref={replayRef} role="region" aria-label="Meta's documented example, replayed">
          <p className="pg-section-label">Meta&apos;s documented example, replayed (no request sent)</p>
          <Note>
            The example response on Meta&apos;s search grounding guide, run through the recipe&apos;s render_with_footnotes here in the page: markers go in
            back to front, and the source cited twice keeps the number [1]. The guide&apos;s offsets look illustrative, so some markers land mid-phrase,
            exactly where its end_index values point.
          </Note>
          <GroundedAnswer final={DOCUMENTED_SEARCH_REPLY} results={[]} includeResults={false} />
        </div>
      ) : null}
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="responses" body={body} stream={stream} caption="The request Run sends" /> : null}
    </div>
  );
}
