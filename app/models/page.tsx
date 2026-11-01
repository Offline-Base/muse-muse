import type { Metadata } from "next";
import { connection } from "next/server";
import { CALL_DAYS, hostedModelViews, tunedModelViews, type TunedModelView } from "@/components/models/catalog";
import { GlimmerCard, HostedModelsTable, TunedModelsTable, WhereTheyRun } from "@/components/models/ModelParts";
import { toRecipeView } from "@/components/train/format";
import { toResultView, type ResultView } from "@/components/train/results";
import { EmptyCard, NotConnected, PageHeader } from "@/components/ui";
import { linkedLocalFiles } from "@/components/vibe/RunLocallyLink";
import { modelCallCounts, safeQuery } from "@/lib/queries";
import { ADAPTER_RECIPE } from "@/lib/train/logic";
import { recipeById } from "@/lib/train/recipes";
import { listResultJobs } from "@/lib/train/store";

export const metadata: Metadata = { title: "Models" };

/** Judged jobs read for the tuned models, newest first. */
const TUNED_SHOWN = 20;
/** Published tuned models whose GGUF files are looked up, one small read each. */
const GGUF_LOOKUPS = 10;

/**
 * The lab's tuned Glimmer models from the Lab results (lib/train/store.ts, its Lab reads), which select only what anyone
 * may see. GGUF files are looked up only for models public on the Hub, as the model's own page does.
 */
async function loadTuned(): Promise<TunedModelView[]> {
  const recipe = recipeById(ADAPTER_RECIPE);
  const recipeView = recipe ? toRecipeView(recipe) : null;
  const results = (await listResultJobs(TUNED_SHOWN)).flatMap((row): ResultView[] => {
    if (row.recipe !== ADAPTER_RECIPE) return [];
    const view = toResultView(row, recipeView);
    return view ? [view] : [];
  });
  const published = results.filter((r) => r.hub).slice(0, GGUF_LOOKUPS);
  const files = await Promise.all(published.map((r) => linkedLocalFiles(r.id)));
  return tunedModelViews(results, new Map(published.map((r, i) => [r.id, files[i]] as const)));
}

/** Every model Muse Muse builds with, public and read-only: Meta's hosted models, then the open models the lab runs. */
export default async function ModelsPage() {
  await connection();
  const since = new Date(Date.now() - CALL_DAYS * 86_400_000);
  const [calls, tuned] = await Promise.all([safeQuery(() => modelCallCounts(since)), safeQuery(loadTuned)]);
  const hosted = hostedModelViews(calls.ok ? calls.data : null);

  return (
    <div className="page">
      <PageHeader
        title="Models"
        subtitle="What Muse Muse builds with: Meta's hosted models, and the open model its lab tunes."
      />

      <section className="section" aria-labelledby="hosted-title">
        <div className="section-head">
          <h2 id="hosted-title">Meta&apos;s hosted models</h2>
        </div>
        <p className="muted">
          Muse Muse and the products it ships call these through Meta&apos;s Model API. Prices are Muse Muse&apos;s
          estimates.
          {calls.ok
            ? ` Calls are from Muse Muse's usage records for the last ${CALL_DAYS} days.`
            : " Call counts aren't available right now."}
        </p>
        <HostedModelsTable models={hosted} />
      </section>

      <section className="section" aria-labelledby="open-title">
        <div className="section-head">
          <h2 id="open-title">Open models</h2>
        </div>
        <GlimmerCard />
        <h3 className="models-sub">Tuned Glimmer models</h3>
        {!tuned.ok ? (
          <NotConnected reason={tuned.reason} what="the tuned models" />
        ) : tuned.data.length === 0 ? (
          <EmptyCard icon="tune" title="No tuned models yet">
            <p>A tuned model shows up here once the lab has trained it and judged it against the base.</p>
          </EmptyCard>
        ) : (
          <TunedModelsTable models={tuned.data} />
        )}
        <p className="muted small">More model kinds are coming.</p>
      </section>

      <section className="section" aria-labelledby="where-title">
        <div className="section-head">
          <h2 id="where-title">Where they run</h2>
        </div>
        <WhereTheyRun />
      </section>
    </div>
  );
}
