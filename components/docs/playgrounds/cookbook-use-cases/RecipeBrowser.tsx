"use client";

import { useId, useMemo, useState } from "react";
import { CodeView, ContributorNotice, ErrorBox, ModelSelect, RunButton, DEFAULT_TEXT_MODEL } from "@/components/docs/kit";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { Field, PresetPills, Segmented, TextArea, TextInput, Toggle, runOnModEnter } from "@/components/docs/kit/Field";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import styles from "@/components/docs/playgrounds/cookbook-use-cases/cuc.module.css";
import { CAPABILITY_LABEL, HARNESSES, RECIPES, filterRecipes, pickInstructions, pickSchema, type Capability } from "@/components/docs/playgrounds/cookbook-use-cases/lib/recipes";
import { responseText } from "@/components/docs/playgrounds/cookbook-use-cases/lib/responses";
import { parseStrictJson, asObject } from "@/components/docs/playgrounds/cookbook-use-cases/lib/strict-json";
import { modelsFor } from "@/lib/docs/client/models";

/**
 * cookbook/use-cases: the category's recipes as a filterable browser (by what they use and the harness they run on),
 * plus one live call: describe your project and Muse Spark picks the recipes that fit, from this list only (a strict
 * JSON schema whose slug field is an enum of the real recipes).
 */

/** What the model menu beside the notice offers: the whole text menu. */
const TEXT_MENU = modelsFor("text").map((m) => m.id);

export interface RecipeBrowserProps {
  slug: string;
  /** The project description the "which recipe fits" box starts with. */
  project?: string;
  presets?: Array<{ label: string; project: string }>;
}

interface Pick {
  slug: string;
  why: string;
}

const CAPS = Object.keys(CAPABILITY_LABEL) as Capability[];

/**
 * The model a recipe's header names. Meta's recipes say muse-spark-1.3, which Muse Muse never runs: its demos (and the
 * code they hand out) use muse-spark-1.3-contributor, so the card says both.
 */
function recipeModel(model: string): string {
  return /muse-spark-1\.3(?!-)/.test(model) ? `${model} in the recipe, run here as muse-spark-1.3-contributor` : model;
}

export function RecipeBrowser({ project: initialProject = "", presets = [] }: RecipeBrowserProps) {
  const id = useId();
  const runner = useDocsRun();
  const [query, setQuery] = useState("");
  const [caps, setCaps] = useState<Capability[]>([]);
  const [harness, setHarness] = useState<string>("any");
  const [project, setProject] = useState(initialProject);
  const [preset, setPreset] = useState<number | null>(null);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [showCode, setShowCode] = useState(false);
  const [picks, setPicks] = useState<{ picks: Pick[]; firstStep: string } | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const shown = useMemo(() => filterRecipes(caps, query, harness === "any" ? null : harness), [caps, query, harness]);
  const pickRank = new Map((picks?.picks ?? []).map((p, i) => [p.slug, i + 1]));

  const body = useMemo(
    () => ({
      model,
      instructions: pickInstructions(),
      input: project.trim() || "A web app",
      reasoning: { effort: "low" },
      max_output_tokens: 2000,
      text: { format: { type: "json_schema", name: "recipe_picks", strict: true, schema: pickSchema() } },
    }),
    [model, project],
  );

  const ask = async () => {
    if (!project.trim()) return;
    setPicks(null);
    setParseError(null);
    const res = await runner.run("responses", { method: "POST", body });
    if (!res.ok) return;
    const parsed = parseStrictJson(responseText(res.json));
    const o = parsed.ok ? asObject(parsed.value) : null;
    if (!o || !Array.isArray(o.picks)) {
      setParseError(parsed.ok ? "The reply didn't have a picks list." : parsed.error);
      return;
    }
    const list = (o.picks as unknown[])
      .map((p) => asObject(p))
      .filter((p): p is Record<string, unknown> => !!p && typeof p.slug === "string")
      .map((p) => ({ slug: String(p.slug), why: String(p.why ?? "") }))
      .filter((p) => RECIPES.some((r) => r.slug === p.slug));
    setPicks({ picks: list, firstStep: String(o.first_step ?? "") });
    // Show the picks even if the filters would hide them.
    setCaps([]);
    setQuery("");
    setHarness("any");
  };

  const toggleCap = (c: Capability) => setCaps((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));

  return (
    <div className="pg">
      <div className={styles.stack}>
        <Field id={`${id}-q`} label="Find a recipe" className="pg-advanced">
          <TextInput id={`${id}-q`} type="search" placeholder="Search titles, harnesses and what each demo does" value={query} onChange={(e) => setQuery(e.target.value)} />
        </Field>
        <div className="pg-presets pg-advanced" role="group" aria-label="Filter by what the recipe uses">
          <span className="pg-presets-label" aria-hidden>
            Uses
          </span>
          {CAPS.map((c) => (
            <button key={c} type="button" className="pg-pill" aria-pressed={caps.includes(c)} onClick={() => toggleCap(c)}>
              {CAPABILITY_LABEL[c]}
            </button>
          ))}
        </div>
        <div className="pg-bar pg-advanced">
          <span className="pg-label">Harness</span>
          <Segmented
            label="Harness"
            size="sm"
            options={[{ value: "any", label: "Any" }, ...HARNESSES.map((h) => ({ value: h, label: h }))]}
            value={harness}
            onChange={setHarness}
          />
        </div>
        <p className="pg-hint pg-advanced" role="status" aria-live="polite">
          Showing {shown.length} of {RECIPES.length} recipes{picks ? `, ${picks.picks.length} picked for your project` : ""}.
        </p>
      </div>

      <ul className={styles.grid2} style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Recipes">
        {[...shown]
          .sort((a, b) => (pickRank.get(a.slug) ?? 99) - (pickRank.get(b.slug) ?? 99))
          .map((r) => {
            const rank = pickRank.get(r.slug);
            const why = picks?.picks.find((p) => p.slug === r.slug)?.why;
            return (
              <li key={r.slug} className={styles.card} style={rank ? { borderColor: "var(--accent)" } : undefined}>
                <div className={styles.row}>
                  <a className={styles.cardTitle} href={`/docs/cookbook/${r.slug}`}>
                    {r.title}
                  </a>
                  {rank ? (
                    <span className={styles.chip} data-tone="accent">
                      Pick {rank}
                    </span>
                  ) : null}
                </div>
                <p className="pg-small pg-advanced">{r.summary}</p>
                <div className={`${styles.chips} pg-advanced`}>
                  {r.capabilities.map((c) => (
                    <span key={c} className={styles.chip}>
                      {CAPABILITY_LABEL[c]}
                    </span>
                  ))}
                </div>
                <p className="pg-hint">
                  {r.harness} · {r.time} · {recipeModel(r.model)}
                </p>
                <p className="pg-hint">Needs: {r.needs}</p>
                <p className="pg-small pg-advanced">
                  <span className="pg-muted">Live demo there: </span>
                  {r.demo}
                </p>
                {why ? (
                  <p className="pg-small">
                    <strong>Why it fits: </strong>
                    {why}
                  </p>
                ) : null}
              </li>
            );
          })}
      </ul>
      {!shown.length ? <p className="pg-empty">No recipe uses all of those. Clear a filter to see more.</p> : null}

      <div className={styles.card}>
        <p className={styles.cardTitle}>Which recipe fits my project?</p>
        <p className="pg-hint">Muse Spark picks up to three recipes from this list, as strict JSON whose slug can only be one of the real recipes.</p>
        {presets.length ? (
          <PresetPills
            presets={presets}
            active={preset}
            onPick={(i) => {
              setPreset(i);
              setProject(presets[i].project);
            }}
            disabled={runner.state === "running"}
          />
        ) : null}
        <div className="pg-composer">
          <label className="sr-only" htmlFor={`${id}-project`}>
            Your project
          </label>
          <TextArea
            id={`${id}-project`}
            rows={2}
            placeholder="I run a support desk and want an assistant that reads screenshots customers send"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            onKeyDown={runOnModEnter(() => void ask())}
          />
          <div className="pg-composer-bar">
            <ModelSelect kind="text" value={model} onChange={setModel} notice={false} disabled={runner.state === "running"} />
            <span className={styles.runbarSpacer} />
            <RunButton running={runner.state === "running"} onRun={() => void ask()} onStop={runner.abort} label="Pick recipes" disabled={!project.trim()} />
          </div>
        </div>
        <ContributorNotice model={model} menu={TEXT_MENU} />
        <ErrorBox error={runner.error} />
        {parseError ? <div className="pg-hint pg-bad">{parseError}</div> : null}
        {picks ? (
          <div className={styles.stack} role="status">
            <ol className="pg-list">
              {picks.picks.map((p) => (
                <li key={p.slug}>
                  <a href={`/docs/cookbook/${p.slug}`}>{RECIPES.find((r) => r.slug === p.slug)?.title ?? p.slug}</a>: {p.why}
                </li>
              ))}
            </ol>
            {picks.firstStep ? (
              <p className="pg-small">
                <strong>First step: </strong>
                {picks.firstStep}
              </p>
            ) : null}
            {runner.result?.json ? <UsageLine model={runner.result.model ?? model} usage={(runner.result.json as { usage?: unknown }).usage} /> : null}
          </div>
        ) : null}
        <div className="pg-actions">
          <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
        </div>
        {showCode ? <CodeView method="POST" path="responses" body={body} /> : null}
      </div>
    </div>
  );
}
