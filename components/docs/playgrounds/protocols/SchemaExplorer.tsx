"use client";

import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { Segmented, TextInput } from "@/components/docs/kit/Field";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { latencyLabel, statusText } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { isAborted, useDocsRun } from "@/components/docs/kit/useDocsRun";
import {
  describeMissing,
  expectsError,
  firstStandIn,
  lookup,
  methodOf,
  previewTemplate,
  rateLimitWaitMs,
  resolveTemplate,
  retryReason,
  sampleRefs,
  verdictOf,
  type FlowContext,
  type FlowStep,
  type RetriesLeft,
  type StepReply,
} from "@/components/docs/playgrounds/protocols/flow";
import { InlineMd, ProseMd } from "@/components/docs/playgrounds/protocols/Markdown";
import { ModelMenu } from "@/components/docs/playgrounds/protocols/ModelMenu";
import styles from "@/components/docs/playgrounds/protocols/protocols.module.css";
import { checkSchema, type SchemaCheck } from "@/components/docs/playgrounds/protocols/schema-check";
import { parseSchemaPage, schemaKind, searchText, type SchemaDef, type SchemaKind, type SchemaPage } from "@/components/docs/playgrounds/protocols/schema-parse";
import { type DocsResult, type SseEvent } from "@/lib/docs/client/api";
import { displayBody } from "@/lib/docs/client/codegen";
import { costExtrasOf } from "@/lib/docs/client/cost";
import { eventType } from "@/lib/docs/client/events";
import { fetchSample, readFileAs } from "@/lib/docs/client/files";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { collectorFor, protocolOfPath } from "@/lib/docs/client/stream";
import { sampleById } from "@/lib/docs/media/samples";

/**
 * The schemas pages as an explorer: every schema on the page, searchable by name, field and description, with its
 * fields, the schemas it points at (click to open them here) and the ones that point at it. Many schemas carry a live
 * example: a working request that runs through the docs proxy, after which the real request or reply (or a stream
 * event) is held up against the schema's table field by field (schema-check.ts). One run answers every schema that
 * example covers. The page's Markdown comes from /docs/md/<slug> when the explorer mounts and parses in a few
 * milliseconds, so the page itself carries nothing extra.
 */

export interface SchemaTarget {
  /** The example that shows this schema live. */
  example: string;
  /** Where the schema sits: the request body, the reply, or a stream event. */
  at: "request" | "reply" | "event";
  /** A path to the spot, in flow.ts's `lookup` syntax. Empty means the whole value. */
  path?: string;
  /** For events: the event type, and a path the event must have (the first one that does is checked). */
  event?: string;
  where?: string;
  /** The example step whose request or reply to read. Default the last one. */
  step?: string;
}

export interface SchemaExample {
  id: string;
  label: string;
  /** What the example sends, in a sentence. */
  blurb?: string;
  steps: FlowStep[];
  /**
   * The models this example may run on, when it can't run on every one: a background response runs on Muse Spark
   * only in the live docs. The menu shows just these while the example is open.
   */
  models?: string[];
}

export interface SchemaExplorerProps {
  slug: string;
  /** The schemas page to read. Default the page's own slug. */
  source?: string;
  examples: SchemaExample[];
  targets: Record<string, SchemaTarget>;
  /** Schemas offered as pills up front: the request and reply bodies. */
  starters?: string[];
  /** The schema shown first. Default the first starter. */
  initial?: string;
  model?: string;
  models?: string[];
  /** The page's Markdown, instead of fetching /docs/md/<source> (tests render with it). */
  markdown?: string;
}

type Filter = "all" | "live" | "event" | "type";

interface ExampleStep {
  step: FlowStep;
  path?: string;
  body?: unknown;
  result?: DocsResult;
  reply?: StepReply;
  /** The first few events of each type a stream carried. */
  events?: Record<string, unknown[]>;
  blocked?: string;
}

interface ExampleRun {
  running: boolean;
  steps: ExampleStep[];
}

const KIND_LABEL: Record<SchemaKind, string> = {
  object: "object",
  event: "stream event",
  union: "one of",
  enum: "enum",
  alias: "type",
};

const PLACEHOLDER_SAMPLE = "data:application/octet-stream;base64,AAAA";

/** The model an example runs on: the one picked, unless the example is limited to others (then its first). */
function modelFor(example: SchemaExample | undefined, picked: string): string {
  const allowed = example?.models;
  return !allowed?.length || allowed.includes(picked) ? picked : allowed[0];
}

function useSchemaPage(source: string, markdown?: string) {
  const [state, setState] = useState<{ page: SchemaPage | null; error: string | null }>(() => ({
    page: markdown ? parseSchemaPage(markdown) : null,
    error: null,
  }));
  useEffect(() => {
    if (markdown) return;
    const ctrl = new AbortController();
    fetch(`/docs/md/${source}`, { signal: ctrl.signal, credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setState({ page: parseSchemaPage(await res.text()), error: null });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({ page: null, error: err instanceof Error ? err.message : "The page didn't load." });
      });
    return () => ctrl.abort();
  }, [source, markdown]);
  return state;
}

export function SchemaExplorer(props: SchemaExplorerProps) {
  const source = props.source ?? props.slug;
  const { page, error } = useSchemaPage(source, props.markdown);
  const id = useId();
  const runner = useDocsRun();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(props.initial ?? props.starters?.[0] ?? null);
  const [model, setModel] = useState(props.model ?? DEFAULT_TEXT_MODEL);
  const [runs, setRuns] = useState<Record<string, ExampleRun>>({});
  const runsRef = useRef<Record<string, ExampleRun>>({});
  const samples = useRef<Record<string, string>>({});
  const listRef = useRef<HTMLUListElement | null>(null);
  const titleRef = useRef<HTMLParagraphElement | null>(null);
  const examples = useMemo(() => new Map(props.examples.map((e) => [e.id, e])), [props.examples]);

  // A link to #some-schema opens it here too.
  useEffect(() => {
    if (!page) return;
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (hash && page.byAnchor[hash]) setSelected(hash);
    else if (!selected || !page.byAnchor[selected]) setSelected(page.schemas[0]?.anchor ?? null);
    // Only when the page arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const index = useMemo(
    () => (page ? page.schemas.map((s) => ({ s, kind: schemaKind(s), text: searchText(s), live: !!props.targets[s.anchor] })) : []),
    [page, props.targets],
  );

  const shown = useMemo(() => {
    const words = deferred.toLowerCase().split(/\s+/).filter(Boolean);
    const out: Array<{ s: SchemaDef; kind: SchemaKind; live: boolean; match: string | null; rank: number }> = [];
    for (const item of index) {
      if (filter === "live" && !item.live) continue;
      if (filter === "event" && item.kind !== "event") continue;
      if (filter === "type" && item.kind !== "enum" && item.kind !== "union" && item.kind !== "alias") continue;
      if (!words.length) {
        out.push({ ...item, match: null, rank: 0 });
        continue;
      }
      let rank = 0;
      let ok = true;
      let match: string | null = null;
      for (const w of words) {
        const squashed = w.replace(/[\s_-]/g, "");
        if (item.text.name.includes(w) || item.text.name.replace(/[\s-]/g, "").includes(squashed)) rank = Math.max(rank, 3);
        else if (item.text.fields.includes(w)) {
          rank = Math.max(rank, 2);
          match ??= item.s.fields.find((f) => f.name.toLowerCase().includes(w))?.name ?? null;
        } else if (item.text.body.includes(w)) rank = Math.max(rank, 1);
        else ok = false;
      }
      if (ok) out.push({ ...item, match: match ? `field ${match}` : rank === 1 ? "in the description" : null, rank });
    }
    return words.length ? out.sort((a, b) => b.rank - a.rank) : out;
  }, [index, deferred, filter]);

  const current = page && selected ? (page.byAnchor[selected] ?? null) : null;

  const select = (anchor: string, focusDetail = false) => {
    if (!page?.byAnchor[anchor]) return;
    setSelected(anchor);
    if (!shown.some((x) => x.s.anchor === anchor)) {
      setQuery("");
      setFilter("all");
    }
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-anchor="${anchor}"]`)?.scrollIntoView({ block: "nearest" });
      if (focusDetail) titleRef.current?.focus();
    });
  };

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-anchor]") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[at < 0 ? 0 : Math.min(buttons.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    e.preventDefault();
    next.focus();
    const anchor = next.dataset.anchor;
    if (anchor) setSelected(anchor);
  };

  const loadSamples = async (ids: string[]) => {
    for (const sid of ids) {
      if (samples.current[sid]) continue;
      const sample = sampleById(sid);
      if (sample) samples.current[sid] = await readFileAs(await fetchSample(sample), "dataUrl");
    }
  };

  const setRun = (exampleId: string, run: ExampleRun) => {
    runsRef.current = { ...runsRef.current, [exampleId]: run };
    setRuns(runsRef.current);
  };

  const runExample = async (ex: SchemaExample) => {
    if (Object.values(runsRef.current).some((r) => r.running)) return;
    const replies: Record<string, StepReply> = {};
    const done: ExampleStep[] = [];
    const runModel = modelFor(ex, model);
    setRun(ex.id, { running: true, steps: [] });
    for (const step of ex.steps) {
      try {
        await loadSamples(sampleRefs(step));
      } catch {
        done.push({ step, blocked: "The sample file didn't load. Try again." });
        break;
      }
      const ctx: FlowContext = { model: runModel, vars: {}, steps: replies, samples: samples.current };
      const path = resolveTemplate(step.path, ctx);
      const body = step.body === undefined ? ({ ok: true, value: undefined } as const) : resolveTemplate(step.body, ctx);
      if (!path.ok || !body.ok) {
        done.push({ step, blocked: describeMissing(!path.ok ? path.missing : !body.ok ? body.missing : "", ex.steps) });
        break;
      }
      const method = methodOf(step);
      const streaming = !!step.stream && method === "POST";
      const protocol = streaming ? protocolOfPath(path.value) : null;
      const sendOnce = async () => {
        const collector = protocol ? collectorFor(protocol) : null;
        const events: Record<string, unknown[]> = {};
        const types: string[] = [];
        const onEvent = (e: SseEvent) => {
          collector?.push(e);
          const t = eventType(e);
          if (!types.includes(t)) types.push(t);
          const list = (events[t] ??= []);
          if (e.json && list.length < 6) list.push(e.json);
        };
        const result = await runner.run(path.value, { method, ...(body.value !== undefined ? { body: body.value } : {}), stream: streaming, onEvent: streaming ? onEvent : undefined });
        return { result, collector, events, types };
      };
      let sent = await sendOnce();
      // A read right after a create can 404 while storage catches up, 5xx errors pass, and a per-minute limit resets
      // within the minute: try again after a pause (a rate limit's own retry-after).
      const left: Required<RetriesLeft> = { listed: step.retry?.tries ?? 2, transient: 1, rate: 1 };
      for (
        let why = retryReason(step, sent.result.status, left, sent.result.error);
        why && !isAborted(sent.result);
        why = retryReason(step, sent.result.status, left, sent.result.error)
      ) {
        left[why]--;
        const waitMs = why === "rate" ? (rateLimitWaitMs(sent.result.status, sent.result.error) ?? 2000) : (step.retry?.delayMs ?? 2000);
        await new Promise((r) => setTimeout(r, waitMs));
        sent = await sendOnce();
      }
      const { result, collector, events, types } = sent;
      if (isAborted(result)) {
        setRun(ex.id, { running: false, steps: done });
        return;
      }
      const json = collector ? (collector.snapshot().final ?? null) : (result.json ?? null);
      const reply: StepReply = { status: result.status, ok: result.ok, json, text: "", events: types };
      replies[step.id] = reply;
      done.push({ step, path: path.value, body: body.value, result, reply, events });
      setRun(ex.id, { running: true, steps: [...done] });
      if (!verdictOf(step, reply).statusOk) break;
    }
    setRun(ex.id, { running: false, steps: done });
  };

  if (error) {
    return (
      <div className="pg">
        <ErrorBox error={{ message: `The schemas didn't load (${error}). Reload the page to try again.` }} />
      </div>
    );
  }
  if (!page) return <p className="pg-wait">Loading the schemas...</p>;

  const target = current ? props.targets[current.anchor] : undefined;
  const example = target ? examples.get(target.example) : undefined;

  return (
    <div className={`pg ${styles.explorer}`}>
      <div className={styles.explorerTop}>
        <span className={styles.search}>
          <label className="sr-only" htmlFor={`${id}-search`}>
            Search schemas
          </label>
          <span className="sr-only" id={`${id}-search-hint`}>
            Matches schema names, field names and descriptions.
          </span>
          <TextInput
            id={`${id}-search`}
            type="search"
            value={query}
            placeholder={`Search ${page.schemas.length} schemas`}
            aria-describedby={`${id}-search-hint`}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && shown[0]) select(shown[0].s.anchor, true);
            }}
          />
        </span>
        <Segmented<Filter>
          label="Show"
          size="sm"
          options={[
            { value: "all", label: "All" },
            { value: "live", label: "Live examples" },
            { value: "event", label: "Events" },
            { value: "type", label: "Unions and enums" },
          ]}
          value={filter}
          onChange={setFilter}
        />
        <span className={styles.count} aria-live="polite">
          {shown.length === page.schemas.length ? `${page.schemas.length} schemas` : `${shown.length} of ${page.schemas.length}`}
        </span>
      </div>

      {props.starters?.length ? (
        <div className={styles.starters} role="group" aria-label="Start with">
          <span className="pg-presets-label" aria-hidden>
            Start with
          </span>
          {props.starters
            .filter((a) => page.byAnchor[a])
            .map((a) => (
              <button key={a} type="button" className="pg-pill" aria-pressed={selected === a} onClick={() => select(a, true)}>
                {page.byAnchor[a].code}
              </button>
            ))}
        </div>
      ) : null}

      <div className={styles.panes}>
        <ul ref={listRef} className={styles.list} aria-label="Schemas" onKeyDown={onListKey}>
          {shown.length ? (
            shown.map(({ s, kind, live, match }) => (
              <li key={s.anchor}>
                <button
                  type="button"
                  className={styles.item}
                  data-anchor={s.anchor}
                  aria-current={selected === s.anchor ? "true" : undefined}
                  // On a phone the detail sits under the list: take the reader to it.
                  onClick={() => select(s.anchor, window.matchMedia?.("(max-width: 719px)").matches)}
                >
                  <span className={styles.itemName}>{s.name}</span>
                  <span className={styles.itemMeta}>
                    <span>{KIND_LABEL[kind]}</span>
                    {s.fields.length ? <span>{s.fields.length === 1 ? "1 field" : `${s.fields.length} fields`}</span> : null}
                    {live ? (
                      <span className={styles.liveDot}>
                        <span aria-hidden>●</span> live
                      </span>
                    ) : null}
                  </span>
                  {match ? <span className={styles.itemMatch}>{match}</span> : null}
                </button>
              </li>
            ))
          ) : (
            <li className={styles.empty}>Nothing matches. Try a field name such as previous_response_id.</li>
          )}
        </ul>

        {current ? (
          <SchemaDetail
            key={current.anchor}
            def={current}
            page={page}
            pagePath={source}
            titleRef={titleRef}
            onSchema={(a) => select(a, true)}
            target={target}
            example={example}
            run={example ? runs[example.id] : undefined}
            anyRunning={Object.values(runs).some((r) => r.running)}
            onRun={() => example && void runExample(example)}
            onStop={runner.abort}
            hasTarget={(a) => !!props.targets[a]}
            model={modelFor(example, model)}
            modelSelect={
              <ModelMenu
                value={modelFor(example, model)}
                onChange={setModel}
                allow={example?.models ?? props.models}
                disabled={Object.values(runs).some((r) => r.running)}
              />
            }
            samplesLoaded={samples.current}
          />
        ) : (
          <p className={styles.empty}>Pick a schema.</p>
        )}
      </div>
    </div>
  );
}

/** The value a target names in a run (or, for a request, in the example as it would be sent). */
function targetValue(
  target: SchemaTarget,
  example: SchemaExample,
  run: ExampleRun | undefined,
  model: string,
  samplesLoaded: Readonly<Record<string, string>>,
): { value: unknown; ready: boolean; event?: string } {
  const stepIndex = target.step ? example.steps.findIndex((s) => s.id === target.step) : example.steps.length - 1;
  const step = example.steps[stepIndex];
  const done = run?.steps[stepIndex];
  if (target.at === "request") {
    if (done?.body !== undefined) return { value: lookup(done.body, target.path ?? ""), ready: true };
    // Before a run, a first step's body can be checked as written: samples stand in as placeholders.
    const placeholders = Object.fromEntries(sampleRefs(step).map((id) => [id, samplesLoaded[id] ?? PLACEHOLDER_SAMPLE]));
    const resolved = resolveTemplate(step.body, { model, vars: {}, steps: {}, samples: placeholders });
    return resolved.ok ? { value: lookup(resolved.value, target.path ?? ""), ready: true } : { value: undefined, ready: false };
  }
  if (!done?.reply?.ok) return { value: undefined, ready: false };
  if (target.at === "reply") return { value: lookup(done.reply.json, target.path ?? ""), ready: true };
  const list = done.events?.[target.event ?? ""] ?? [];
  const event = target.where ? list.find((e) => lookup(e, target.where!) !== undefined) : list[0];
  return { value: event === undefined ? undefined : lookup(event, target.path ?? ""), ready: true, event: target.event };
}

/** Where a target looks, in words. */
function targetWhere(target: SchemaTarget): string {
  const at = target.path ? ` at ${target.path}` : "";
  if (target.at === "request") return `the request body${at}`;
  if (target.at === "reply") return `the reply${at}`;
  return `the first ${target.event} event${target.where ? ` with ${target.where}` : ""}${at}`;
}

/**
 * Why a schema has neither a live example nor a parent with one. Most such schemas are simply not covered; the line
 * only gives a reason where there is one: failure and refusal shapes the demos don't set out to cause, and prompt
 * templates and stored conversations, which the live docs refuse.
 */
export function noLiveReason(def: Pick<SchemaDef, "name">): string {
  if (/error|refusal|fail/i.test(def.name)) return "No live example: the live docs don't set out to cause a failure or a refusal.";
  if (/prompt|conversation/i.test(def.name)) return "No live example: the live docs don't run prompt templates or stored conversations.";
  return "No live example for this one.";
}

/** Ancestors (up to three levels) that have a live example, for a schema without one of its own. */
function liveAncestors(anchor: string, page: SchemaPage, hasTarget: (a: string) => boolean): string[] {
  const seen = new Set<string>([anchor]);
  let frontier = [anchor];
  const found: string[] = [];
  for (let depth = 0; depth < 3 && frontier.length && found.length < 4; depth++) {
    const next: string[] = [];
    for (const a of frontier) {
      for (const parent of page.usedBy[a] ?? []) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        if (hasTarget(parent)) found.push(parent);
        else next.push(parent);
      }
    }
    frontier = next;
  }
  return found.slice(0, 4);
}

function SchemaDetail({
  def,
  page,
  pagePath,
  titleRef,
  onSchema,
  target,
  example,
  run,
  anyRunning,
  onRun,
  onStop,
  hasTarget,
  model,
  modelSelect,
  samplesLoaded,
}: {
  def: SchemaDef;
  page: SchemaPage;
  pagePath: string;
  titleRef: RefObject<HTMLParagraphElement | null>;
  onSchema(anchor: string): void;
  target?: SchemaTarget;
  example?: SchemaExample;
  run?: ExampleRun;
  anyRunning: boolean;
  onRun(): void;
  onStop(): void;
  hasTarget(anchor: string): boolean;
  model: string;
  modelSelect: ReactNode;
  samplesLoaded: Readonly<Record<string, string>>;
}) {
  const [codeOpen, setCodeOpen] = useState(false);
  const kind = schemaKind(def);
  const usedBy = page.usedBy[def.anchor] ?? [];
  const ancestors = target ? [] : liveAncestors(def.anchor, page, hasTarget);
  const live = target && example ? targetValue(target, example, run, model, samplesLoaded) : null;
  const check: SchemaCheck | null = live?.ready && live.value !== undefined ? checkSchema(def, live.value, page) : null;
  const mainIndex = target && example ? (target.step ? example.steps.findIndex((s) => s.id === target.step) : example.steps.length - 1) : -1;
  const lastStep = run?.steps[run.steps.length - 1];
  const firstStep = example?.steps[0];
  const blocked = run?.steps.find((s) => s.blocked)?.blocked;
  // The code for the step the schema sits in: as sent once it ran, else with the model filled in and stand-ins
  // (resp_from_step_1) for what earlier replies supply.
  const codeStep = example ? (example.steps[mainIndex] ?? firstStep) : undefined;
  const sentStep = run?.steps[mainIndex]?.path !== undefined ? run.steps[mainIndex] : undefined;
  const codePreview =
    example && codeStep && !sentStep
      ? previewTemplate(
          { path: codeStep.path, body: codeStep.body },
          { model, vars: {}, steps: Object.fromEntries((run?.steps ?? []).flatMap((s) => (s.reply ? [[s.step.id, s.reply]] : []))) },
          example.steps,
        )
      : null;

  return (
    <section className={styles.detail} aria-labelledby={`${def.anchor}-x-title`}>
      <div className={styles.detailHead}>
        <p ref={titleRef} id={`${def.anchor}-x-title`} className={styles.detailTitle} role="heading" aria-level={3} tabIndex={-1}>
          {def.name}
        </p>
        <code className={styles.detailCode}>{def.code}</code>
        <span className={styles.kind}>{KIND_LABEL[kind]}</span>
        <a className={`docs-link ${styles.detailLink}`} href={`#${def.anchor}`}>
          On the page
        </a>
      </div>
      {def.description ? <ProseMd md={def.description} pagePath={pagePath} onSchema={onSchema} /> : null}
      {def.typeLine ? (
        <p className={styles.typeLine}>
          <span className="pg-muted">Type: </span>
          <InlineMd md={def.typeLine} pagePath={pagePath} onSchema={onSchema} />
        </p>
      ) : null}

      {target && example ? (
        <div className={styles.live}>
          <div className={styles.liveHead}>
            <span className={styles.liveTitle}>Live example: {example.label}</span>
            <RunButton running={!!run?.running} onRun={onRun} onStop={onStop} label={run?.steps.length ? "Run again" : "Run example"} disabled={anyRunning && !run?.running} />
          </div>
          {example.blurb ? <p className="pg-hint">{example.blurb}</p> : null}
          {modelSelect}
          <p className="pg-hint">
            Checks {targetWhere(target)}
            {example.steps.length > 1 ? `, after ${example.steps.length} requests: ${example.steps.map((s) => s.title).join(", then ")}` : ""}.
            {target.at === "request" && !run?.steps.length ? " The request is checked as written; Run sends it." : ""}
          </p>
          {run?.steps.length ? (
            <ul className={styles.runList} aria-label="Requests">
              {run.steps.map((s, i) => (
                <li key={i} className="pg-meta">
                  <span className={`pg-method pg-method-${methodOf(s.step).toLowerCase()}`}>{methodOf(s.step)}</span>{" "}
                  <code>/v1/{s.path ?? s.step.path}</code>{" "}
                  {s.result ? `${statusText(s.result)}, ${latencyLabel(s.result.elapsedMs)}` : s.blocked ? "couldn't run" : ""}
                  {s.result && i === mainIndex && s.reply?.json ? (
                    <>
                      {" "}
                      <UsageLine model={s.result.model} usage={(s.reply.json as { usage?: unknown }).usage ?? null} {...costExtrasOf(s.reply.json)} />
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {blocked ? <p className={styles.blocked}>{blocked}</p> : null}
          {lastStep?.result && !lastStep.result.ok && !expectsError(lastStep.step) ? <ErrorBox error={lastStep.result.error} /> : null}

          {check ? <SchemaCheckView check={check} /> : live && !live.ready ? null : live ? <p className="pg-hint">Nothing at that spot this time: the model may have answered another way. Run it again.</p> : null}

          <div className={styles.more}>
            {live?.ready && live.value !== undefined ? (
              <details className="pg-raw">
                <summary>The value checked</summary>
                <JsonTree value={displayBody(live.value)} openDepth={2} label="Checked value" />
              </details>
            ) : null}
            {codeStep ? (
              <details className="pg-raw" open={codeOpen} onToggle={(e) => setCodeOpen(e.currentTarget.open)}>
                <summary>Code</summary>
                {codeOpen ? (
                  <CodeView
                    method={methodOf(codeStep)}
                    path={sentStep?.path ?? codePreview?.value.path ?? codeStep.path}
                    body={sentStep ? sentStep.body : codePreview ? codePreview.value.body : codeStep.body}
                    stream={!!codeStep.stream}
                    caption={
                      codePreview?.pending
                        ? `Values from earlier replies show as stand-ins (such as ${firstStandIn(codePreview.value) ?? "resp_from_step_1"}) until Run fills them in.`
                        : undefined
                    }
                  />
                ) : null}
              </details>
            ) : null}
          </div>
        </div>
      ) : ancestors.length ? (
        <div className={styles.chips}>
          <span className="pg-muted">No live example of its own. See it live inside</span>
          {ancestors.map((a) => (
            <button key={a} type="button" className="pg-pill" onClick={() => onSchema(a)}>
              {page.byAnchor[a]?.code ?? a}
            </button>
          ))}
        </div>
      ) : (
        <p className="pg-hint">{noLiveReason(def)}</p>
      )}
      {def.fields.length ? (
        <ul className={styles.fieldList} aria-label={`${def.name} fields`}>
          {def.fields.map((f) => (
            <li key={f.name} className={`${styles.field} ${f.name.includes(".") ? styles.fieldNested : ""}`}>
              <span className={styles.fieldHead}>
                <span className={styles.fieldName}>{f.name}</span>
                {f.type ? (
                  <span className={styles.fieldType}>
                    <InlineMd md={f.type} pagePath={pagePath} onSchema={onSchema} />
                  </span>
                ) : (
                  <span className={`${styles.fieldType} pg-muted`}>any</span>
                )}
                {f.required ? <span className={styles.req}>required</span> : null}
              </span>
              {f.description ? (
                <span className={styles.fieldDesc}>
                  <InlineMd md={f.description} pagePath={pagePath} onSchema={onSchema} />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {usedBy.length ? (
        <div className={styles.chips}>
          <span className="pg-muted">Used by</span>
          {usedBy.slice(0, 12).map((a) => (
            <button key={a} type="button" className="pg-pill" onClick={() => onSchema(a)}>
              {page.byAnchor[a]?.code ?? a}
            </button>
          ))}
          {usedBy.length > 12 ? <span className="pg-muted">and {usedBy.length - 12} more</span> : null}
        </div>
      ) : null}

    </section>
  );
}

function SchemaCheckView({ check }: { check: SchemaCheck }) {
  if (check.fits !== null) {
    return <p className={`pg-verdict ${check.fits ? "pg-good" : "pg-bad"}`}>{check.summary}</p>;
  }
  const rows = check.fields.filter((f) => f.status !== "absent");
  const absent = check.fields.length - rows.length;
  // Nothing from the table came back: say so plainly rather than as a pass.
  if (!rows.length && check.fields.length) {
    return (
      <p className="pg-hint" role="status">
        {check.summary}
      </p>
    );
  }
  return (
    <div className="pg-col">
      <p className={`pg-verdict ${check.fields.some((f) => f.status === "mismatch") ? "pg-bad" : "pg-good"}`} role="status">
        {check.summary}
      </p>
      {rows.length ? (
        <ul className="pg-checks" aria-label="Field by field">
          {rows.map((f) => (
            <li key={f.field} className={f.status === "ok" ? "pg-check-ok" : "pg-check-bad"}>
              <span className="pg-check-mark" aria-hidden>
                {f.status === "ok" ? "✓" : "✗"}
              </span>
              <span className="sr-only">{f.status === "ok" ? "Matches: " : f.status === "missing" ? "Missing: " : "Another type: "}</span>
              <code>{f.field}</code>{" "}
              <span className={styles.checkActual}>{f.actual}</span>
              {f.status !== "ok" ? (
                <span className={styles.checkWhy}>
                  {f.status === "missing" ? "Required by the table, as " : "The table says "}
                  {f.expected}.
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {check.fields.some((f) => f.status === "mismatch" || f.status === "missing") ? (
        <p className="pg-hint">A mismatch or a missing field means the live API sent something the table doesn&apos;t describe, such as a null it doesn&apos;t list. Code that reads it should allow for that.</p>
      ) : null}
      {absent ? <p className="pg-hint">{absent} optional {absent === 1 ? "field isn't" : "fields aren't"} in this one.</p> : null}
      {check.extra.length ? (
        <p className="pg-hint">
          Also here, not in the table: {check.extra.map((k, i) => (
            <span key={k}>
              {i ? ", " : ""}
              <code>{k}</code>
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}
