import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { pageViewer } from "@/app/fine-tuning/viewer";
import { tunedModelViews } from "@/components/models/catalog";
import { toRecipeView } from "@/components/train/format";
import { toResultView, type ResultView } from "@/components/train/results";
import { SparkOpenChip, SparkOpenNote } from "@/components/train/SparkOpenNote";
import { TrainStatusPill } from "@/components/train/TrainStatusPill";
import { ExternalLink, NotConnected, PageHeader } from "@/components/ui";
import { linkedLocalFiles } from "@/components/vibe/RunLocallyLink";
import { usd } from "@/lib/format";
import { safeQuery } from "@/lib/queries";
import { ADAPTER_RECIPE } from "@/lib/train/logic";
import { recipeById } from "@/lib/train/recipes";
import { getJob, getResultJob, listDatasetRunsForAdmin, listModelVersions } from "@/lib/train/store";
import { modelVersionViews, newVersionPlan } from "@/lib/train/versions";

export const metadata: Metadata = { title: "Model versions" };

/** Versions whose GGUF files are looked up, one small read each, as on /models. */
const GGUF_LOOKUPS = 10;

/**
 * A tuned model's page, public: every judged version trained on its dataset, with results, Hugging Face links and files.
 * Only what the Lab results already show anyone. An admin also sees runs not judged yet, and Train a new version.
 */
export default async function ModelVersionsPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const [{ id }, user] = await Promise.all([params, pageViewer()]);
  const admin = Boolean(user?.isAdmin);

  const loaded = await safeQuery(async () => {
    const row = await getResultJob(id);
    if (!row || row.recipe !== ADAPTER_RECIPE) return null;
    const recipe = recipeById(ADAPTER_RECIPE);
    const recipeView = recipe ? toRecipeView(recipe) : null;
    const current = toResultView(row, recipeView);
    if (!current) return null;
    const rows = current.datasetId ? await listModelVersions(current.datasetId) : [row];
    const results = rows.flatMap((r): ResultView[] => {
      const view = toResultView(r, recipeView);
      return view ? [view] : [];
    });
    const published = results.filter((r) => r.hub).slice(0, GGUF_LOOKUPS);
    const files = await Promise.all(published.map((r) => linkedLocalFiles(r.id)));
    const tuned = tunedModelViews(results, new Map(published.map((r, i) => [r.id, files[i]] as const)));
    const versions = modelVersionViews(results, tuned);

    if (!admin || !current.datasetId) return { current, versions, others: [], canTrain: false };
    const judged = new Set(versions.map((v) => v.id));
    const [runs, full] = await Promise.all([listDatasetRunsForAdmin(current.datasetId), getJob(current.id)]);
    return {
      current,
      versions,
      others: runs.filter((r) => !judged.has(r.id)),
      canTrain: Boolean(full && recipe && newVersionPlan(full, recipe.params)),
    };
  });

  if (!loaded.ok) {
    return (
      <div className="page">
        <NotConnected reason={loaded.reason} what="this model" />
      </div>
    );
  }
  if (!loaded.data) notFound();
  const { current, versions, others, canTrain } = loaded.data;

  return (
    <div className="page">
      <PageHeader
        title={current.title}
        subtitle={`${versions.length === 1 ? "1 version" : `${versions.length} versions`}, all trained on the same examples. Each one is judged against the base model.`}
        actions={
          canTrain ? (
            <Link href={`/models/${current.id}/new-version`} className="btn btn-primary">
              Train a new version
            </Link>
          ) : null
        }
      />

      <section className="section" aria-labelledby="versions-title">
        <div className="section-head">
          <h2 id="versions-title">Versions</h2>
        </div>
        <div className="table-wrap">
          <table className="data data-list models-tuned">
            <caption className="sr-only">Versions of this model, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Results</th>
                <th scope="col">Get it</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id} aria-current={v.id === current.id ? "true" : undefined}>
                  <td>
                    <Link href={`/fine-tuning/${v.id}`} className="row-title">
                      Version {v.number}
                    </Link>
                    <span className="row-sub muted">
                      {new Date(v.finishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}, {usd(v.costUsd)} of GPU
                    </span>
                    {v.settings.length ? (
                      <span className="row-sub muted">{v.settings.map((s) => `${s.label}: ${s.value}`).join(", ")}</span>
                    ) : null}
                    {v.sparkOpen ? (
                      <span className="row-sub">
                        <SparkOpenChip />
                      </span>
                    ) : null}
                  </td>
                  <td className="train-nowrap">{v.score}</td>
                  <td>
                    {v.hubUrl || v.gguf ? (
                      <ul className="link-list">
                        {v.hubUrl ? (
                          <li>
                            <ExternalLink href={v.hubUrl}>Hugging Face</ExternalLink>
                          </li>
                        ) : null}
                        {v.filesUrl ? (
                          <li>
                            <ExternalLink href={v.filesUrl}>Files</ExternalLink>
                          </li>
                        ) : null}
                        {v.datasetUrl ? (
                          <li>
                            <ExternalLink href={v.datasetUrl}>Dataset</ExternalLink>
                          </li>
                        ) : null}
                        {v.gguf ? (
                          <li>
                            <ExternalLink href={v.gguf.repoUrl}>GGUF files</ExternalLink>
                          </li>
                        ) : null}
                        {v.gguf ? (
                          <li>
                            <Link href={v.gguf.runHref}>Run it on your computer</Link>
                          </li>
                        ) : null}
                      </ul>
                    ) : (
                      <span className="muted">Not published</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {others.length ? (
        <section className="section" aria-labelledby="others-title">
          <div className="section-head">
            <h2 id="others-title">Not judged yet</h2>
          </div>
          <p className="muted">Only admins see these. A run gets a version number once it is judged.</p>
          <ul className="link-list">
            {others.map((r) => (
              <li key={r.id}>
                <Link href={`/fine-tuning/${r.id}`}>
                  Started {r.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
                </Link>{" "}
                <TrainStatusPill status={r.status} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {versions.some((v) => v.sparkOpen) ? <SparkOpenNote what="This model" /> : null}
    </div>
  );
}
