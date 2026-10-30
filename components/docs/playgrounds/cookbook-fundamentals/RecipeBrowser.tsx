"use client";

import { useId, useMemo, useRef, useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { PresetPills, TextInput, Toggle } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { ReplyView } from "@/components/docs/kit/StreamView";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import styles from "@/components/docs/playgrounds/cookbook-fundamentals/cookbook.module.css";
import {
  filterRecipes,
  findRecipe,
  sectionsById,
  type CoreCall,
  type Recipe,
} from "@/components/docs/playgrounds/cookbook-fundamentals/recipes";
import type { DocsError, SseEvent } from "@/lib/docs/client/api";
import { fetchSample, readFileAs } from "@/lib/docs/client/files";
import type { FormSpec } from "@/lib/docs/client/form";
import { kindOfModel } from "@/lib/docs/client/models";
import { jsonSet } from "@/lib/docs/client/pointer";
import { collectorFor, protocolOfPath, type Collected } from "@/lib/docs/client/stream";
import { sampleById } from "@/lib/docs/media/samples";

/**
 * A browser for the cookbook's recipes (the cookbook index and its category pages): every recipe the page lists, a
 * filter, and for each one its core call, the one request at the heart of the recipe, run live through the docs
 * proxy. A card's button opens its call in the panel at the top, where the model menu (with the Contributor notice
 * and the Standard models) and Run are, so nothing is sent before the reader has seen which model it goes to.
 * Recipes that run on your machine (Muse Code, open weights) show the command to start with; Muse Spark Open on Mac
 * has both. Samples the calls need (a chart, a screenshot, a recording) are fetched from our origin and sent inline.
 */

export interface RecipeBrowserProps {
  slug: string;
  /** Section ids from recipes.ts, in order. Every section when left out. */
  sections?: string[];
  /** The recipe selected on load. Defaults to the first one with a call. */
  start?: string;
}

const KIND_BADGE: Record<Recipe["kind"], string> = { api: "Live call", "muse-code": "Muse Code", "open-weights": "Your hardware" };

function placeholderFor(sampleId: string): string {
  const s = sampleById(sampleId);
  return `data:${s?.mime ?? "image/png"};base64,<BASE64>`;
}

/** The request as code shows it: samples as placeholders, the picked model in. */
function shownBody(call: CoreCall, model: string | null): Record<string, unknown> | undefined {
  if (!call.body) return undefined;
  let body = call.body;
  for (const f of call.fills ?? []) body = jsonSet(body, f.pointer, placeholderFor(f.sampleId));
  return model && typeof body.model === "string" ? { ...body, model } : body;
}

function formSpecs(call: CoreCall): FormSpec[] | undefined {
  return call.form?.map((p) => {
    if (!p.sampleId) return { name: p.name, value: p.value ?? "" };
    const s = sampleById(p.sampleId);
    const name = s?.src.split("/").pop() ?? `${p.sampleId}.wav`;
    return { name: p.name, value: name, file: { label: s?.label ?? name, accept: s?.mime ?? "audio/wav", as: "file" as const } };
  });
}

export function RecipeBrowser({ sections: sectionIds, start }: RecipeBrowserProps) {
  const id = useId();
  const all = useMemo(() => sectionsById(sectionIds), [sectionIds]);
  const many = all.length > 1;
  const [filter, setFilter] = useState<string>(many ? all[0].id : "all");
  const [query, setQuery] = useState("");
  const firstWithCall = all.flatMap((s) => s.recipes).find((r) => r.call)?.slug ?? all[0]?.recipes[0]?.slug ?? "";
  const [selected, setSelected] = useState(start && findRecipe(start) ? start : firstWithCall);
  const [models, setModels] = useState<Record<string, string>>({});
  const [reply, setReply] = useState<Collected | null>(null);
  const [localError, setLocalError] = useState<DocsError | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [ranSlug, setRanSlug] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const runner = useDocsRun();
  const running = runner.state === "running" || preparing;

  const recipe = findRecipe(selected);
  const call = recipe?.call;
  const defaultModel = typeof call?.body?.model === "string" ? call.body.model : call?.form ? "muse-voice-transcribe-1.0" : null;
  const kind = defaultModel ? kindOfModel(defaultModel) : null;
  const model = recipe && defaultModel ? (models[recipe.slug] ?? defaultModel) : null;

  const visible = useMemo(() => {
    const scoped = filter === "all" ? all : all.filter((s) => s.id === filter);
    return filterRecipes(scoped, query);
  }, [all, filter, query]);

  const runRecipe = async (r: Recipe) => {
    const c = r.call;
    if (!c) return;
    setSelected(r.slug);
    setRanSlug(r.slug);
    setReply(null);
    setLocalError(null);
    runner.reset();
    panelRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    const picked = c.body && typeof c.body.model === "string" ? (models[r.slug] ?? c.body.model) : null;
    let body: Record<string, unknown> | undefined = c.body ? { ...c.body, ...(picked ? { model: picked } : {}) } : undefined;
    let form: FormData | undefined;
    setPreparing(true);
    try {
      for (const f of c.fills ?? []) {
        const sample = sampleById(f.sampleId);
        if (!sample) throw new Error(`The sample ${f.sampleId} is missing.`);
        body = jsonSet(body, f.pointer, await readFileAs(await fetchSample(sample), "dataUrl"));
      }
      if (c.form) {
        form = new FormData();
        for (const p of c.form) {
          if (p.sampleId) {
            const sample = sampleById(p.sampleId);
            if (!sample) throw new Error(`The sample ${p.sampleId} is missing.`);
            const file = await fetchSample(sample);
            form.append(p.name, file, file.name);
          } else form.append(p.name, p.value ?? "");
        }
      }
    } catch (err) {
      setLocalError({ message: err instanceof Error ? err.message : "Couldn't load the sample this call needs." });
      return;
    } finally {
      setPreparing(false);
    }
    const protocol = protocolOfPath(c.path);
    const collector = protocol && c.stream ? collectorFor(protocol) : null;
    await runner.run(c.path, {
      method: "POST",
      ...(form ? { form } : { body }),
      stream: !!c.stream,
      onEvent: collector
        ? (e: SseEvent) => {
            collector.push(e);
            setReply(collector.snapshot());
          }
        : undefined,
    });
  };

  // Opening another recipe leaves a call that's running alone: its result stays with its own recipe. Focus moves to
  // the panel's Run button (or its first control) once the panel shows the new recipe.
  const pick = (r: Recipe) => {
    setSelected(r.slug);
    panelRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    requestAnimationFrame(() => {
      const panel = panelRef.current;
      (panel?.querySelector<HTMLElement>(".pg-run") ?? panel?.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
    });
  };

  const commandBlock = (r: Recipe) =>
    r.command ? (
      <div className={styles.stack} style={{ gap: 6 }}>
        <div className={styles.spread}>
          <span className="pg-section-label">Start with</span>
          <CopyButton value={r.command} label={`Copy the command for ${r.title}`} className="icon-btn icon-btn-plain icon-btn-sm" />
        </div>
        <pre className={styles.command}>{r.command}</pre>
      </div>
    ) : null;

  const filters = many ? [{ label: "All", id: "all" }, ...all.map((s) => ({ label: s.title, id: s.id }))] : [];
  const showResult = !!call && ranSlug === selected;
  let lastGroup = "";

  return (
    <div className="pg">
      {recipe ? (
        <div className={styles.callPanel} ref={panelRef}>
          <div className={styles.spread}>
            <p className="pg-title">
              <a href={`/docs/${recipe.slug}`}>{recipe.title}</a>
            </p>
            <span className={styles.badge} data-kind={recipe.kind}>
              {KIND_BADGE[recipe.kind]}
            </span>
          </div>
          {call ? (
            <>
              {recipe.command ? (
                <>
                  {recipe.where ? <p className={styles.note}>{recipe.where}</p> : null}
                  {commandBlock(recipe)}
                </>
              ) : null}
              <p className={styles.lead}>
                <strong>Core call:</strong> {call.label}. <span className="pg-muted">POST /v1/{call.path}</span>
              </p>
              <div className="pg-bar">
                {model && kind ? (
                  <ModelSelect
                    kind={kind}
                    value={model}
                    onChange={(m) => setModels((cur) => ({ ...cur, [recipe.slug]: m }))}
                    disabled={running || !!call.form}
                  />
                ) : null}
              </div>
              {recipe.where && !recipe.command ? <p className={styles.note}>{recipe.where}</p> : null}
              <div className={styles.spread}>
                <p className={`${styles.note} pg-advanced`}>
                  <strong>Look for:</strong> {call.look}
                  {call.cost ? ` ${call.cost}` : ""}
                </p>
                <RunButton running={running} onRun={() => void runRecipe(recipe)} onStop={runner.abort} label="Run the core call" />
              </div>
            </>
          ) : (
            <>
              <p className={styles.note}>{recipe.where}</p>
              {commandBlock(recipe)}
            </>
          )}
          <ErrorBox error={showResult ? (localError ?? runner.error) : null} />
          {showResult && (running || runner.result) ? (
            <ResponseView
              result={runner.result}
              running={running}
              elapsedMs={runner.elapsedMs}
              json={reply?.final ?? undefined}
              usage={reply?.usage ?? undefined}
            >
              {reply ? <ReplyView reply={reply} running={running} /> : undefined}
            </ResponseView>
          ) : null}
          {call ? (
            <>
              <div className="pg-actions">
                <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
              </div>
              {showCode ? (
                <CodeView method="POST" path={call.path} body={shownBody(call, model)} form={formSpecs(call)} stream={!!call.stream} caption="The core call" />
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <div className={`${styles.toolbar} pg-advanced`}>
        {filters.length ? (
          <PresetPills
            label="Section"
            presets={filters}
            active={filters.findIndex((f) => f.id === filter)}
            onPick={(i) => setFilter(filters[i].id)}
          />
        ) : null}
        <label className="sr-only" htmlFor={`${id}-q`}>
          Filter recipes
        </label>
        <TextInput id={`${id}-q`} className={styles.search} type="search" placeholder="Filter recipes" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {visible.length ? (
        visible.map((s) => {
          const groupHead = many && filter === "all" && s.group !== lastGroup ? s.group : null;
          lastGroup = s.group;
          return (
            <section key={s.id} className={styles.section} aria-labelledby={`${id}-${s.id}`}>
              {groupHead ? <p className="pg-section-label">{groupHead}</p> : null}
              <h3 id={`${id}-${s.id}`} className={many ? styles.sectionHead : "sr-only"}>
                {s.title}
              </h3>
              {many ? <p className={`${styles.sectionBlurb} pg-advanced`}>{s.blurb}</p> : null}
              <ul className={styles.cards}>
                {s.recipes.map((r) => (
                  <li key={r.slug} className={styles.card} data-active={r.slug === selected ? "true" : undefined}>
                    <div className={styles.cardHead}>
                      <a className={styles.cardTitle} href={`/docs/${r.slug}`}>
                        {r.title}
                      </a>
                      <span className={styles.badge} data-kind={r.kind}>
                        {KIND_BADGE[r.kind]}
                      </span>
                    </div>
                    <p className={`${styles.cardSummary} pg-advanced`}>{r.summary}</p>
                    <div className={styles.cardFoot}>
                      {r.call ? (
                        <button type="button" className="btn btn-sm btn-outline" onClick={() => pick(r)} aria-label={`Try the core call of ${r.title}`}>
                          Try its core call
                        </button>
                      ) : (
                        <button type="button" className="btn btn-sm" onClick={() => pick(r)} aria-label={`Show how to start ${r.title}`}>
                          How to start
                        </button>
                      )}
                      {r.call?.cost ? <span className="pg-muted pg-small pg-advanced">{r.call.cost.split(":")[0]}</span> : null}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      ) : (
        <p className="pg-empty">No recipe matches that filter.</p>
      )}
    </div>
  );
}
