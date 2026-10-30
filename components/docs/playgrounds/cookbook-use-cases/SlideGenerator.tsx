"use client";

import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { CodeView, ErrorBox, ModelSelect, RunButton, DEFAULT_TEXT_MODEL } from "@/components/docs/kit";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { Segmented, TextArea, TextInput, Toggle } from "@/components/docs/kit/Field";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { latencyLabel } from "@/components/docs/kit/ResponseView";
import type { SseEvent } from "@/lib/docs/client/api";
import { formatUsd } from "@/lib/docs/client/cost";
import { collectResponseObject, responsesCollector, type Citation } from "@/lib/docs/client/stream";
import styles from "@/components/docs/playgrounds/cookbook-use-cases/cuc.module.css";
import { SandboxFrame } from "@/components/docs/playgrounds/cookbook-use-cases/SandboxFrame";
import { extractHtml } from "@/components/docs/playgrounds/cookbook-use-cases/lib/harness";
import { outputItems, replyUsd, responseText } from "@/components/docs/playgrounds/cookbook-use-cases/lib/responses";
import { parseStrictJson } from "@/components/docs/playgrounds/cookbook-use-cases/lib/strict-json";
import { DESIGN_INSTRUCTIONS, OUTLINE_INSTRUCTIONS, RESEARCH_INSTRUCTIONS, deckFileName, deckSources, normalizeOutline, type Outline } from "@/components/docs/playgrounds/cookbook-use-cases/lib/slides";
import { withRetries } from "@/components/docs/playgrounds/cookbook-use-cases/lib/retry";
import { useRetryGuard } from "@/components/docs/playgrounds/cookbook-use-cases/useRetryGuard";

/**
 * cookbook/generating-slides: the recipe's three stages. Research (the built-in web_search tool on the Responses API;
 * the model picks its own queries), outline (JSON, normalized for the key names models vary), and the deck, shown
 * here as slides. The optional design stage hands the outline back and lets the model write the whole HTML deck,
 * shown in a sandboxed frame. The stats line mirrors the recipe's *_slides_stats.json.
 */

export interface SlideGeneratorProps {
  slug: string;
  topic?: string;
  content?: string;
  source?: "research" | "content";
}

type Json = Record<string, unknown>;

interface StageStat {
  name: string;
  ms: number;
  usage: unknown;
  model: string | null;
  usd: number;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/html" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function SlideGenerator({
  topic: initialTopic = "AI Agents in Production",
  content: initialContent = "",
  source: initialSource = "research",
}: SlideGeneratorProps) {
  const id = useId();
  const runner = useDocsRun();
  const [source, setSource] = useState<"research" | "content">(initialSource);
  const [topic, setTopic] = useState(initialTopic);
  const [content, setContent] = useState(initialContent);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [phase, setPhase] = useState<string | null>(null);
  const [brief, setBrief] = useState<{ text: string; queries: string[]; citations: Citation[]; results: number } | null>(null);
  const [outline, setOutline] = useState<Outline | null>(null);
  const [renamed, setRenamed] = useState<string[]>([]);
  const [stats, setStats] = useState<StageStat[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [streamed, setStreamed] = useState(0);
  const [showCode, setShowCode] = useState(false);
  const guard = useRetryGuard(runner.abort);
  const running = runner.state === "running" || guard.waiting;

  const researchBody: Json = useMemo(
    () => ({
      model,
      instructions: RESEARCH_INSTRUCTIONS,
      input: `Topic: ${topic.trim() || "AI Agents in Production"}`,
      tools: [{ type: "web_search" }],
      include: ["web_search_call.results"],
      reasoning: { effort: "low" },
      max_output_tokens: 4000,
    }),
    [model, topic],
  );
  const outlineBody = (prev: string | null): Json => ({
    model,
    ...(prev ? { previous_response_id: prev } : {}),
    instructions: OUTLINE_INSTRUCTIONS,
    input: prev ? "Write the outline from your research brief. Use its source URLs." : `Source content:\n${content.trim()}`,
    reasoning: { effort: "low" },
    max_output_tokens: 4000,
  });
  const designBody = (o: Outline | null): Json => ({
    model,
    instructions: DESIGN_INSTRUCTIONS,
    input: `Outline:\n${JSON.stringify(o ?? { title: "...", slides: [] })}`,
    reasoning: { effort: "low" },
    max_output_tokens: 12000,
    stream: true,
  });

  const run = async () => {
    guard.begin();
    setBrief(null);
    setOutline(null);
    setRenamed([]);
    setStats([]);
    setParseError(null);
    setHtml(null);
    let prev: string | null = null;
    const got: StageStat[] = [];
    if (source === "research") {
      setPhase("Researching with web search");
      const r = await withRetries(() => runner.run("responses", { method: "POST", body: researchBody }), guard.options);
      if (!r.ok) return setPhase(null);
      const json = r.json as Json;
      const c = collectResponseObject(json);
      const queries = outputItems(json)
        .filter((it) => it.type === "web_search_call")
        .map((it) => String((it.action as Json | undefined)?.query ?? ""))
        .filter(Boolean);
      const results = c.searches.reduce((n, s) => n + (s.results?.length ?? 0), 0);
      setBrief({ text: c.text, queries, citations: c.citations, results });
      got.push({ name: "research", ms: r.elapsedMs, usage: json.usage, model: r.model, usd: replyUsd(r.model ?? model, json) });
      setStats([...got]);
      prev = typeof json.id === "string" ? json.id : null;
    }
    setPhase("Writing the outline");
    const r2 = await withRetries(() => runner.run("responses", { method: "POST", body: outlineBody(prev) }), guard.options);
    setPhase(null);
    if (!r2.ok) return;
    const j2 = r2.json as Json;
    got.push({ name: "outline", ms: r2.elapsedMs, usage: j2.usage, model: r2.model, usd: replyUsd(r2.model ?? model, j2) });
    setStats([...got]);
    const parsed = parseStrictJson(responseText(j2));
    if (!parsed.ok) return setParseError(parsed.error);
    const n = normalizeOutline(parsed.value);
    setOutline(n.outline);
    setRenamed(n.renamed);
  };

  const design = async () => {
    if (!outline) return;
    setHtml(null);
    setStreamed(0);
    setPhase("Designing the HTML deck");
    const collector = responsesCollector();
    const onEvent = (e: SseEvent) => {
      collector.push(e);
      setStreamed(collector.snapshot().text.length);
    };
    const r = await runner.run("responses", { method: "POST", body: designBody(outline), stream: true, onEvent });
    setPhase(null);
    const reply = collector.snapshot();
    if (!r.ok) return;
    setStats((s) => [...s, { name: "design", ms: r.elapsedMs, usage: reply.usage, model: r.model, usd: replyUsd(r.model ?? model, reply.final) }]);
    const page = extractHtml(reply.text);
    if (!page) setParseError(reply.finishReason === "max_output_tokens" ? "The deck was cut off at the output limit." : "The reply had no HTML in it.");
    else setHtml(page);
  };

  const total = stats.reduce((s, x) => s + x.usd, 0);
  const sources = outline ? deckSources(outline) : [];

  return (
    <div className="pg">
      <div className="pg-bar">
        <div className="pg-advanced">
          <Segmented<"research" | "content">
            label="Source"
            options={[
              { value: "research", label: "Research a topic" },
              { value: "content", label: "From my content" },
            ]}
            value={source}
            onChange={setSource}
            disabled={running}
          />
        </div>
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={running} />
      </div>
      {source === "research" ? (
        <div className={styles.textAnswer}>
          <label className="sr-only" htmlFor={`${id}-topic`}>
            Topic
          </label>
          <TextInput id={`${id}-topic`} value={topic} onChange={(e) => setTopic(e.target.value)} disabled={running} placeholder="AI Agents in Production" />
        </div>
      ) : (
        <>
          <label className="pg-label" htmlFor={`${id}-content`}>
            Source content
          </label>
          <TextArea id={`${id}-content`} rows={6} value={content} onChange={(e) => setContent(e.target.value)} disabled={running} placeholder="Paste notes, a report or an article" />
        </>
      )}
      <p className="pg-hint">
        {source === "research"
          ? "Research runs web_search, usually 3 to 5 queries at $0.0025 each (the docs proxy caps a request at 5), plus well under a cent of tokens."
          : "No search: the outline comes straight from what you paste."}
      </p>
      <div className="pg-actions">
        <RunButton running={running} onRun={() => void run()} onStop={guard.stop} label="Make the deck" disabled={source === "research" ? !topic.trim() : !content.trim()} />
        {outline ? (
          <button type="button" className="btn btn-sm pg-advanced" onClick={() => void design()} disabled={running}>
            Let the model design the HTML
          </button>
        ) : null}
        {phase ? (
          <span className="pg-hint" role="status">
            {phase}
            {phase.startsWith("Designing") ? `: ${streamed.toLocaleString()} characters` : "..."}
          </span>
        ) : null}
      </div>
      {guard.waitNote ? (
        <div className="pg-hint" role="status">
          {guard.waitNote}
        </div>
      ) : null}
      <ErrorBox error={guard.waiting ? null : runner.error} />
      {parseError ? <div className="pg-hint pg-bad">{parseError}</div> : null}

      {brief ? (
        <details className={styles.card} open={!outline}>
          <summary className={styles.cardTitle}>
            1. Research brief: {brief.queries.length} search{brief.queries.length === 1 ? "" : "es"}, {brief.citations.length} citation{brief.citations.length === 1 ? "" : "s"}
          </summary>
          {brief.queries.length ? (
            <div className={styles.chips}>
              {brief.queries.map((q, i) => (
                <span key={i} className={styles.chip}>
                  search: {q}
                </span>
              ))}
            </div>
          ) : null}
          <p className={styles.answer}>{brief.text}</p>
        </details>
      ) : null}

      {outline ? (
        <div className={styles.stack}>
          <p className="pg-section-label">
            2. Outline: {outline.slides.length} slides{renamed.length ? `, normalized keys: ${renamed.join(", ")}` : ", no keys to normalize"}
          </p>
          <Deck outline={outline} />
          <details className="pg-advanced">
            <summary className="pg-small">The outline JSON</summary>
            <pre className="pg-pre">{JSON.stringify(outline, null, 2)}</pre>
          </details>
          {sources.length ? <p className="pg-hint">{sources.length} distinct sources across the deck.</p> : null}
        </div>
      ) : null}

      {html ? (
        <div className={styles.stack}>
          <p className="pg-section-label">3. The model&apos;s own design</p>
          <SandboxFrame html={html} title={deckFileName(topic)} viewport={{ width: 1280, height: 720 }} />
          <div className={styles.row}>
            <button type="button" className="btn btn-sm" onClick={() => download(deckFileName(topic), html)}>
              Download {deckFileName(topic)}
            </button>
            <span className="pg-hint">Click into the frame, then use the arrow keys.</span>
          </div>
        </div>
      ) : null}

      {stats.length ? (
        <div className={`${styles.tableWrap} pg-advanced`}>
          <table className={styles.table}>
            <caption className="sr-only">Pipeline stats</caption>
            <thead>
              <tr>
                <th>Stage</th>
                <th>Time</th>
                <th>Tokens and cost</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td>{latencyLabel(s.ms)}</td>
                  <td>
                    <UsageLine model={s.model ?? model} usage={s.usage} webSearches={s.name === "research" ? brief?.queries.length : undefined} />
                  </td>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>total</strong>
                </td>
                <td>{latencyLabel(stats.reduce((n, s) => n + s.ms, 0))}</td>
                <td>{formatUsd(total)} est.</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? (
        <>
          {source === "research" ? <CodeView method="POST" path="responses" body={researchBody} caption="1. Research with web_search" /> : null}
          <CodeView method="POST" path="responses" body={outlineBody(source === "research" ? "resp_from_research" : null)} caption="2. The JSON outline" />
          <CodeView method="POST" path="responses" body={designBody(outline)} caption="3. The model-designed HTML (optional)" />
        </>
      ) : null}
    </div>
  );
}

/** The outline as a deck: a title slide, the content slides, and a sources slide. Arrow keys move when it has focus. */
function Deck({ outline }: { outline: Outline }) {
  const [at, setAt] = useState(0);
  const sources = deckSources(outline);
  const count = outline.slides.length + 1 + (sources.length ? 1 : 0);
  const go = (n: number) => setAt(Math.max(0, Math.min(count - 1, n)));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight" || e.key === "PageDown") {
      e.preventDefault();
      go(at + 1);
    } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
      e.preventDefault();
      go(at - 1);
    }
  };
  const slide = at > 0 && at <= outline.slides.length ? outline.slides[at - 1] : null;
  return (
    <div className={styles.deck}>
      <div tabIndex={0} onKeyDown={onKey} role="region" aria-roledescription="slide deck" aria-label={`Slide deck: ${outline.title}`}>
        {at === 0 ? (
          <div className={`${styles.slide} ${styles.slideTitle}`}>
            <h3>{outline.title}</h3>
            {outline.subtitle ? <p style={{ opacity: 0.85 }}>{outline.subtitle}</p> : null}
            <div className={styles.slideFoot}>
              <span>Made with Muse Spark</span>
              <span>1 / {count}</span>
            </div>
          </div>
        ) : slide ? (
          <div className={styles.slide}>
            <h3>{slide.title}</h3>
            {slide.bullets.length ? (
              <ul>
                {slide.bullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            ) : null}
            {slide.code ? <pre>{slide.code.code}</pre> : null}
            <div className={styles.slideFoot}>
              <span>{slide.sources.map((s) => s.title).join(" · ")}</span>
              <span>
                {at + 1} / {count}
              </span>
            </div>
          </div>
        ) : (
          <div className={styles.slide}>
            <h3>Sources</h3>
            <ul>
              {sources.slice(0, 10).map((s) => (
                <li key={s.url}>
                  <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ color: "#bcd0ff" }}>
                    {s.title}
                  </a>
                </li>
              ))}
            </ul>
            <div className={styles.slideFoot}>
              <span />
              <span>
                {at + 1} / {count}
              </span>
            </div>
          </div>
        )}
      </div>
      <div className={styles.deckNav}>
        <button type="button" className="btn btn-sm" onClick={() => go(at - 1)} disabled={at === 0} aria-label="Previous slide">
          Previous
        </button>
        <span aria-live="polite">
          Slide {at + 1} of {count}
        </span>
        <button type="button" className="btn btn-sm" onClick={() => go(at + 1)} disabled={at === count - 1} aria-label="Next slide">
          Next
        </button>
      </div>
    </div>
  );
}
