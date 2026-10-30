"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { PresetPills, Segmented, TextArea, TextInput, runOnModEnter } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { useStrictJson } from "@/components/docs/playgrounds/muse-code-cookbook/hooks";
import { filterRecipes, recipeBySlug, RECIPES, THEME_LABEL, type Theme } from "@/components/docs/playgrounds/muse-code-cookbook/logic/recipes";
import { recommendBody } from "@/components/docs/playgrounds/muse-code-cookbook/logic/requests";
import { Section, ShowCode } from "@/components/docs/playgrounds/muse-code-cookbook/parts";
import styles from "@/components/docs/playgrounds/muse-code-cookbook/mcc.module.css";

/**
 * The "Building with Muse Code" index as a browser: the ten recipes filtered by theme or search, each with its time,
 * the commands it drives and the guarantee it proves, linked to its page here. "Which recipe fits?" sends the
 * reader's need to the model with a strict schema whose slugs are the catalog's, so every pick is a real recipe; the
 * picks light up in the grid.
 */

export interface RecipeBrowserProps {
  slug: string;
  need?: string;
  needs?: string[];
}

interface Picks {
  picks: Array<{ slug: string; why: string }>;
}

const DEFAULT_NEED = "My coding agent must never delete files or edit its own rules without a person saying yes.";

export function RecipeBrowser(props: RecipeBrowserProps) {
  const id = useId();
  const [theme, setTheme] = useState<Theme | "all">("all");
  const [query, setQuery] = useState("");
  const [need, setNeed] = useState(props.need ?? DEFAULT_NEED);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const live = useStrictJson<Picks>();
  const running = live.state === "running";
  const needs = props.needs ?? [];

  const shown = useMemo(() => filterRecipes(theme, query), [theme, query]);
  const picks = (live.value?.picks ?? []).filter((p) => recipeBySlug(p.slug));
  const rank = (slug: string) => picks.findIndex((p) => p.slug === slug);

  const body = useMemo(() => recommendBody(model, need.trim() || DEFAULT_NEED), [model, need]);
  const ask = () => {
    if (!need.trim() || running) return;
    void live.run(body);
  };

  return (
    <div className={`pg ${styles.stack}`}>
      <div className={`${styles.spread} pg-advanced`}>
        <Segmented<Theme | "all">
          label="Theme"
          size="sm"
          options={[{ value: "all", label: "All" }, ...(Object.keys(THEME_LABEL) as Theme[]).map((t) => ({ value: t, label: THEME_LABEL[t] }))]}
          value={theme}
          onChange={setTheme}
        />
        <span className={styles.row}>
          <label className="sr-only" htmlFor={`${id}-q`}>
            Search the recipes
          </label>
          <TextInput id={`${id}-q`} type="search" placeholder="Search: resume, sandbox, cron..." value={query} onChange={(e) => setQuery(e.target.value)} />
        </span>
      </div>
      <p className={`${styles.note} pg-advanced`} role="status" aria-live="polite">
        Showing {shown.length} of {RECIPES.length} recipes{picks.length ? `, ${picks.length} picked for your need` : ""}.
      </p>
      <ul className={styles.cards}>
        {shown.map((r) => {
          const at = rank(r.slug);
          return (
            <li key={r.slug} className={`${styles.card} ${at >= 0 ? styles.cardPicked : ""}`}>
              <div className={styles.cardMeta}>
                <span className={styles.chip}>{THEME_LABEL[r.theme]}</span>
                <span>about {r.minutes} min</span>
                {at >= 0 ? <span className={`${styles.chip} ${styles.chipAccent}`}>Pick {at + 1}</span> : null}
              </div>
              <p className={styles.cardTitle}>
                <Link href={`/docs/cookbook/${r.slug}`}>{r.title}</Link>
              </p>
              <p className={`${styles.cardText} pg-advanced`}>{r.blurb}</p>
              <p className={`${styles.note} pg-advanced`}>
                <strong>Proves:</strong> {r.proves}
              </p>
              <ul className={`${styles.cmdList} pg-advanced`} aria-label="Commands">
                {r.commands.map((c) => (
                  <li key={c}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
              {at >= 0 ? <p className={styles.why}>{picks[at].why}</p> : null}
            </li>
          );
        })}
      </ul>
      {!shown.length ? <p className="pg-empty">No recipe matches. Clear the search or pick All.</p> : null}

      <Section title="Which recipe fits?">
        <p className={`${styles.note} pg-advanced`}>Describe what your agent harness must do. The model picks up to three recipes from this catalog (a strict schema lists only these ten), and they light up above.</p>
        <div className="pg-bar">
          <ModelSelect kind="text" value={model} onChange={setModel} disabled={running} />
        </div>
        {needs.length ? (
          <div className="pg-advanced">
            <PresetPills presets={needs.map((n) => ({ label: n }))} active={needs.indexOf(need)} onPick={(i) => setNeed(needs[i])} disabled={running} />
          </div>
        ) : null}
        <div className="pg-composer">
          <label className="sr-only" htmlFor={`${id}-need`}>
            What your agent must do
          </label>
          <TextArea id={`${id}-need`} rows={2} value={need} onChange={(e) => setNeed(e.target.value)} onKeyDown={runOnModEnter(ask)} disabled={running} />
          <div className="pg-composer-bar">
            <RunButton running={running} onRun={ask} onStop={live.abort} label="Find recipes" disabled={!need.trim()} />
          </div>
        </div>
        {running || live.result ? (
          <ResponseView result={running ? null : live.result} running={running} elapsedMs={live.elapsedMs}>
            {picks.length ? (
              <ol className="pg-list">
                {picks.map((p) => (
                  <li key={p.slug}>
                    <Link href={`/docs/cookbook/${p.slug}`}>{recipeBySlug(p.slug)?.title}</Link>: {p.why}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="pg-empty">{running ? "Matching your need to the recipes..." : "No picks in this reply."}</p>
            )}
          </ResponseView>
        ) : null}
        <ErrorBox error={live.error} />
        <ShowCode body={live.body ?? body} caption={live.body ? "The request that just ran" : "The request Run sends"} />
      </Section>
    </div>
  );
}
