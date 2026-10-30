"use client";

import { useId, useRef, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { useDocsPage } from "@/components/docs/kit/DocsPageContext";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { EffortSelect, Field, PresetPills, Segmented, TextInput, Toggle } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { latencyLabel } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { isAborted, useDocsRun } from "@/components/docs/kit/useDocsRun";
import type { SseEvent } from "@/lib/docs/client/api";
import { DEFAULT_TEXT_MODEL, docsModelLabel, fitEffort, type Effort } from "@/lib/docs/client/models";
import { outcomeOfCollected } from "@/lib/docs/client/record";
import { collectorFor } from "@/lib/docs/client/stream";
import {
  bookPart,
  cacheBody,
  cacheReading,
  cacheRunFrom,
  cachedShare,
  CACHE_INSTRUCTIONS,
  DEFAULT_CACHE_KEY,
  freshTag,
  inputCost,
  pairCost,
  type BookPart,
  type CacheProtocol,
  type CacheRun,
  type CacheScenario,
  type CacheSetup,
  shortenForCode,
} from "@/components/docs/playgrounds/text/caching";
import { usdExact } from "@/components/docs/playgrounds/text/money";
import { Badge, cx, Meter, n, Tile, Tiles } from "@/components/docs/playgrounds/text/parts";
import { failureOutcome, recordOf } from "@/components/docs/playgrounds/text/record";
import styles from "@/components/docs/playgrounds/text/text.module.css";

/**
 * Prompt caching, measured (prompt-caching page): the same long prefix (instructions plus three chapters of a
 * public-domain book from /docs-samples) sent twice with a different question at the end. The second call reports
 * `cached_tokens`; the table shows the share served from cache, time to first token, and the cost against the same
 * tokens uncached. Two scenarios break the prefix the ways the page warns about: a timestamp first, and an edit in
 * the middle. A fresh random tag at the very start makes each pair's first call a true cache miss. Each call is
 * recorded for the copy prompt with its cached_tokens, once the reply is in.
 */

export interface CacheScenarioSpec {
  id: CacheScenario;
  label: string;
  about: string;
}

export interface PromptCachingLabProps {
  slug: string;
  scenarios: CacheScenarioSpec[];
  questions: [string, string];
  /** Default "chapters-1-3". */
  part?: BookPart;
  model?: string;
  models?: string[];
  /** Default "minimal": the point is the input side. */
  effort?: Effort | null;
  /** Where the long text sample lives. */
  sampleUrl?: string;
}

interface CallState {
  call: 1 | 2;
  running: boolean;
  run: CacheRun | null;
  answer: string;
  ranOn: string | null;
}

const SAMPLE = "/docs-samples/alice-chapters-1-3.txt";

export function PromptCachingLab(props: PromptCachingLabProps) {
  const id = useId();
  const runner = useDocsRun();
  const { recordRequest } = useDocsPage();
  const [protocol, setProtocol] = useState<CacheProtocol>("responses");
  const [model, setModel] = useState(props.model ?? DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>(props.effort === undefined ? "minimal" : props.effort);
  const [scenarioIndex, setScenarioIndex] = useState(0);
  const scenario = props.scenarios[scenarioIndex] ?? props.scenarios[0];
  const [part, setPart] = useState<BookPart>(props.part ?? "chapters-1-3");
  const [useKey, setUseKey] = useState(true);
  const [cacheKey, setCacheKey] = useState(DEFAULT_CACHE_KEY);
  const [retention, setRetention] = useState<"" | "in_memory" | "24h">("");
  const [store, setStore] = useState(true);
  const [cold, setCold] = useState(true);
  const [q1, setQ1] = useState(props.questions[0]);
  const [q2, setQ2] = useState(props.questions[1]);
  const [calls, setCalls] = useState<CallState[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastSetup, setLastSetup] = useState<CacheSetup | null>(null);
  const [showCode, setShowCode] = useState(false);
  const book = useRef<string | null>(null);
  const stop = useRef(false);

  const loadBook = async (): Promise<string | null> => {
    if (book.current) return book.current;
    try {
      const res = await fetch(props.sampleUrl ?? SAMPLE, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      book.current = await res.text();
      return book.current;
    } catch {
      setLoadError("Couldn't load the book sample from this site. Reload the page and try again.");
      return null;
    }
  };

  const setupWith = (text: string, tag: string | null): CacheSetup => ({
    protocol,
    model,
    book: text,
    part,
    scenario: scenario.id,
    tag,
    questions: [q1, q2],
    cacheKey: useKey ? cacheKey : null,
    retention: protocol === "responses" && retention ? retention : null,
    store: protocol === "responses" ? store : true,
    effort: fitEffort(model, effort),
    maxOutputTokens: 400,
  });

  /** One streamed call, timing the first visible text. */
  const send = async (setup: CacheSetup, call: 1 | 2) => {
    const body = cacheBody(setup, call, new Date());
    const collector = collectorFor(protocol);
    const started = performance.now();
    let firstText: number | null = null;
    const onEvent = (e: SseEvent) => {
      collector.push(e);
      if (firstText === null && collector.snapshot().text) firstText = performance.now() - started;
    };
    setCalls((c) => [...c.filter((x) => x.call !== call), { call, running: true, run: null, answer: "", ranOn: null }]);
    const path = protocol === "chat" ? "chat/completions" : "responses";
    const res = await runner.run(path, { method: "POST", body, stream: true, onEvent, record: false });
    const reply = collector.snapshot();
    const ran = res.model ?? model;
    const run = res.ok && reply.usage ? cacheRunFrom(call, ran, reply.usage, firstText, res.elapsedMs) : null;
    const outcome = !res.ok || isAborted(res)
      ? failureOutcome(res)
      : run
        ? `cache call ${call}: ${n(run.cached)} of ${n(run.input)} input tokens cached (${Math.round(cachedShare(run) * 1000) / 10}%); ${outcomeOfCollected(reply)}`
        : `cache call ${call}: ${outcomeOfCollected(reply)}`;
    recordRequest(recordOf(path, body, res, outcome));
    setCalls((c) => [...c.filter((x) => x.call !== call), { call, running: false, run, answer: reply.text, ranOn: res.model }].sort((a, b) => a.call - b.call));
    return res.ok && !reply.error;
  };

  const runPair = async () => {
    if (busy || !q1.trim() || !q2.trim()) return;
    stop.current = false;
    setBusy(true);
    setLoadError(null);
    setCalls([]);
    const text = await loadBook();
    if (!text) {
      setBusy(false);
      return;
    }
    const setup = setupWith(text, cold && scenario.id !== "timestamp" ? freshTag() : null);
    setLastSetup(setup);
    const ok = await send(setup, 1);
    if (ok && !stop.current) await send(setup, 2);
    setBusy(false);
  };

  /** A third call with the same prefix as the last pair's second call: the cache is still there. */
  const again = async () => {
    if (busy || !lastSetup) return;
    setBusy(true);
    await send({ ...lastSetup, questions: [lastSetup.questions[0], q2] }, 2);
    setBusy(false);
  };

  const one = calls.find((c) => c.call === 1)?.run ?? null;
  const two = calls.find((c) => c.call === 2)?.run ?? null;
  const ranOn = calls.find((c) => c.ranOn)?.ranOn ?? model;
  const previewText = book.current ? bookPart(book.current, part) : null;
  const cost = pairCost(model, part);
  const codeSetup = lastSetup ?? setupWith(previewText ?? "<the book's text>", cold ? "Session 482913." : null);

  return (
    <div className={`pg ${styles.stack}`}>
      <div className="pg-bar">
        <Segmented<CacheProtocol>
          label="Protocol"
          options={[
            { value: "responses", label: "Responses" },
            { value: "chat", label: "Chat Completions" },
          ]}
          value={protocol}
          onChange={(p) => {
            setProtocol(p);
            setCalls([]);
          }}
          disabled={busy}
        />
        <ModelSelect kind="text" value={model} onChange={setModel} allow={props.models} disabled={busy} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={busy} />
      </div>

      <div className={styles.tight}>
        <PresetPills
          label="Scenario"
          presets={props.scenarios}
          active={scenarioIndex}
          onPick={(i) => {
            setScenarioIndex(i);
            setCalls([]);
          }}
          disabled={busy}
        />
        <p className={cx(styles.about, "pg-advanced")} aria-live="polite">
          {scenario.about}
        </p>
      </div>

      <section className={cx(styles.card, styles.cardSoft)} aria-labelledby={`${id}-req`}>
        <p className={styles.cardTitle} id={`${id}-req`}>
          The request
        </p>
        <div className={cx(styles.row, "pg-advanced")}>
          <span className="pg-inline-field">
            <span className="pg-label">Stable prefix</span>
            <Segmented<BookPart>
              label="Prefix length"
              size="sm"
              options={[
                { value: "chapter-1", label: "Chapter I (about 3,000 tokens)" },
                { value: "chapters-1-3", label: "Chapters I to III (about 8,300)" },
              ]}
              value={part}
              onChange={setPart}
              disabled={busy}
            />
          </span>
          {scenario.id !== "timestamp" ? <Toggle id={`${id}-cold`} label="Start cold (a fresh tag first)" checked={cold} onChange={setCold} disabled={busy} /> : null}
        </div>
        <div className={cx(styles.row, "pg-advanced")}>
          <Toggle id={`${id}-key`} label={<code>prompt_cache_key</code>} checked={useKey} onChange={setUseKey} disabled={busy} />
          {useKey ? (
            <span className="pg-inline-field">
              <label className="sr-only" htmlFor={`${id}-keyval`}>
                Cache key
              </label>
              <TextInput id={`${id}-keyval`} value={cacheKey} onChange={(e) => setCacheKey(e.target.value)} disabled={busy} spellCheck={false} style={{ width: "16rem" }} />
            </span>
          ) : null}
          {protocol === "responses" ? (
            <>
              <span className="pg-inline-field">
                <label className="pg-label" htmlFor={`${id}-ret`}>
                  <code>prompt_cache_retention</code>
                </label>
                <span className="select-wrap">
                  <select id={`${id}-ret`} className="select pg-select" value={retention} disabled={busy} onChange={(e) => setRetention(e.target.value as "" | "in_memory" | "24h")}>
                    <option value="">Not sent</option>
                    <option value="in_memory">in_memory</option>
                    <option value="24h">24h</option>
                  </select>
                </span>
              </span>
              <Toggle id={`${id}-store`} label={<code>store</code>} checked={store} onChange={setStore} disabled={busy} />
            </>
          ) : null}
        </div>
        <p className={cx(styles.about, styles.small, "pg-advanced")}>
          {useKey
            ? "On by default, though the page says caching needs no key: in our runs without one, call 2 landed on another backend and cached nothing. Turn it off to test the page's claim."
            : "Without a key the second call may land on a backend that doesn't hold the prefix and miss; we saw that happen. One stable key per shared prefix keeps them together."}
        </p>
        <div className={styles.inputs}>
          <Field id={`${id}-q1`} label="Call 1 asks">
            <TextInput id={`${id}-q1`} value={q1} onChange={(e) => setQ1(e.target.value)} disabled={busy} />
          </Field>
          <Field id={`${id}-q2`} label="Call 2 asks">
            <TextInput id={`${id}-q2`} value={q2} onChange={(e) => setQ2(e.target.value)} disabled={busy} />
          </Field>
        </div>
        <details className={cx(styles.details, "pg-advanced")}>
          <summary>What each call sends, in order</summary>
          <p className={styles.preview}>
            <span className={styles.prefixPart}>
              {scenario.id === "timestamp" ? "Current time: <now, to the millisecond>." : cold ? "Session <random tag>." : ""} {CACHE_INSTRUCTIONS}
            </span>
            {"\n\n"}
            <span className={styles.prefixPart}>
              {previewText ? `${previewText.slice(0, 280)}... (${n(previewText.length)} characters of the book${scenario.id === "edit" ? ", with a note put in midway on call 2" : ""})` : "The book's text, loaded when you run."}
            </span>
            {"\n\n"}
            <span className={styles.varPart}>The question for that call</span>
          </p>
          <p className={cx(styles.about, styles.small)}>
            Blue is the stable prefix ({protocol === "chat" ? "a developer message" : "instructions"}); amber is the part that changes, last, where the page says it belongs.
          </p>
        </details>
      </section>

      <div className="pg-composer-bar">
        <span className="pg-muted pg-kbd-hint">
          Two calls, one after the other: at most {usdExact(cost.hit)} on {docsModelLabel(model)} when call 2 hits the cache, {usdExact(cost.miss)} if it misses.
        </span>
        {two && lastSetup && scenario.id === "same" ? (
          <button type="button" className="btn btn-sm btn-outline" onClick={() => void again()} disabled={busy}>
            Send call 2 again
          </button>
        ) : null}
        <RunButton
          running={busy}
          onRun={() => void runPair()}
          onStop={() => {
            stop.current = true;
            runner.abort();
          }}
          label="Send both calls"
          disabled={!q1.trim() || !q2.trim()}
        />
      </div>

      {loadError ? <div className="pg-hint pg-bad">{loadError}</div> : null}

      {calls.length ? (
        <section className={styles.stack} aria-label="Results">
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Call</th>
                  <th scope="col" className={styles.num}>
                    Input
                  </th>
                  <th scope="col" className={styles.num}>
                    Cached
                  </th>
                  <th scope="col" style={{ minWidth: 120 }}>
                    Share cached
                  </th>
                  <th scope="col" className={styles.num}>
                    First text
                  </th>
                  <th scope="col" className={styles.num}>
                    Cost
                  </th>
                  <th scope="col" className={styles.num}>
                    Uncached
                  </th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.call}>
                    <td>
                      {c.call}{" "}
                      {c.run ? (
                        <Badge tone={cacheReading(c.run) === "hit" ? "ok" : cacheReading(c.run) === "partial" ? "warn" : "neutral"}>{cacheReading(c.run)}</Badge>
                      ) : c.running ? (
                        <Badge tone="accent">running</Badge>
                      ) : (
                        <Badge tone="bad">failed</Badge>
                      )}
                    </td>
                    <td className={styles.num}>{c.run ? n(c.run.input) : ""}</td>
                    <td className={styles.num}>{c.run ? n(c.run.cached) : ""}</td>
                    <td>{c.run ? <Meter share={cachedShare(c.run)} label={`Call ${c.call}: share of input served from cache`} left={`${Math.round(cachedShare(c.run) * 1000) / 10}%`} /> : null}</td>
                    <td className={styles.num}>{c.run?.ttftMs != null ? latencyLabel(c.run.ttftMs) : c.run ? latencyLabel(c.run.totalMs) : ""}</td>
                    <td className={styles.num}>{c.run ? usdExact(c.run.usd) : ""}</td>
                    <td className={styles.num}>{c.run ? usdExact(c.run.usdUncached) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {one && two ? <Verdict scenario={scenario.id} one={one} two={two} model={ranOn} /> : null}

          {two && two.cached > 0 ? (
            <div className={cx(styles.card, "pg-advanced")}>
              <p className={styles.cardTitle}>Call 2&apos;s input at each rate</p>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">Model</th>
                      <th scope="col" className={styles.num}>
                        With the cache
                      </th>
                      <th scope="col" className={styles.num}>
                        With nothing cached
                      </th>
                      <th scope="col" className={styles.num}>
                        Saved
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {["muse-spark-1.3-contributor", "muse-spark-1.2", "muse-wonder-1.0"].map((m) => {
                      const withCache = inputCost(m, two.input, two.cached);
                      const without = inputCost(m, two.input, 0);
                      return (
                        <tr key={m}>
                          <td>{docsModelLabel(m)}</td>
                          <td className={styles.num}>{usdExact(withCache)}</td>
                          <td className={styles.num}>{usdExact(without)}</td>
                          <td className={styles.num}>{without > 0 ? `${Math.round((1 - withCache / without) * 100)}%` : ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className={cx(styles.about, styles.small)}>
                Cached tokens are a subset of input tokens, billed at the cached rate: $0.002 per million on Spark 1.3 Contributor, $0.15 on Spark Standard, $0.20 on Muse
                Wonder, against $0.10, $1.25 and $4.00 uncached.
              </p>
            </div>
          ) : null}

          <details className={styles.details}>
            <summary>The answers</summary>
            <ul className="pg-list">
              {calls.map((c) => (
                <li key={c.call}>
                  Call {c.call}: {c.answer || (c.running ? "..." : "(no text)")}
                </li>
              ))}
            </ul>
          </details>
        </section>
      ) : null}

      <ErrorBox error={runner.error} />

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? (
        <CodeView method="POST" path={protocol === "chat" ? "chat/completions" : "responses"} body={shortenForCode(cacheBody(codeSetup, 2, new Date()))} caption="Call 2's request, with the book shortened here" />
      ) : null}
    </div>
  );
}

function Verdict({ scenario, one, two, model }: { scenario: CacheScenario; one: CacheRun; two: CacheRun; model: string }) {
  const share = Math.round(cachedShare(two) * 1000) / 10;
  const firstFaster = one.ttftMs !== null && two.ttftMs !== null ? one.ttftMs - two.ttftMs : null;
  const saved = one.usdUncached > 0 && two.usdUncached > 0 ? 1 - two.usd / two.usdUncached : 0;
  return (
    <div className={styles.stack}>
      <Tiles label="What the cache did">
        <Tile label="Call 2 from cache" value={`${share}%`} note={`${n(two.cached)} of ${n(two.input)} input tokens`} />
        <Tile label="Call 2's cost" value={usdExact(two.usd)} note={`${usdExact(two.usdUncached)} with nothing cached${saved > 0.005 ? `, ${Math.round(saved * 100)}% less` : ""}`} />
        <Tile
          label="Time to first text"
          value={two.ttftMs !== null ? latencyLabel(two.ttftMs) : latencyLabel(two.totalMs)}
          note={firstFaster !== null ? `${firstFaster >= 0 ? `${latencyLabel(firstFaster)} sooner` : `${latencyLabel(-firstFaster)} later`} than call 1` : "first text not timed"}
        />
      </Tiles>
      <p className={styles.about} role="status">
        {scenario === "same"
          ? two.cached > 0
            ? `Call 2 reused the prefix call 1 left in the cache on ${docsModelLabel(model)}: only the tokens after it, the question, were computed fresh. Time to first text moves less than cost at this length, since reasoning time and the network vary from call to call; the saving grows with the prefix.`
            : "Call 2 missed the cache. That can happen right after a first call or when a request lands on another backend; send call 2 again, and keep prompt_cache_key on."
          : scenario === "timestamp"
            ? two.cached > 0
              ? "Something early in the prompt still matched (Meta's own scaffolding comes first), but the long prefix after the timestamp was computed fresh both times."
              : "Both calls missed: the timestamp at the very start made every prefix new, so nothing after it could be reused. Put volatile content last."
            : two.cached === 0
              ? "Call 2 cached nothing: the note put in midway ended the match, and what came after it was computed fresh. The page's \"lower than expected\" case."
              : `Call 2 reused ${n(two.cached)} tokens, at most the part before the note put in midway; everything after the change was computed fresh.`}
      </p>
    </div>
  );
}
