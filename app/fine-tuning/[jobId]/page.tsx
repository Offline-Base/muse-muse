import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { JobResults } from "@/components/train/JobResults";
import { JobRoom } from "@/components/train/JobRoom";
import { evalRows, keepEvents, toRecipeView } from "@/components/train/format";
import { toResultView } from "@/components/train/results";
import { EmptyCard, NotConnected } from "@/components/ui";
import { safeQuery } from "@/lib/queries";
import { toJobView } from "@/lib/train/logic";
import { recipeById } from "@/lib/train/recipes";
import {
  getDataset,
  getJob,
  getReadyDataset,
  getResultJob,
  listEvents,
  listResultEvents,
  type TrainJobRow,
} from "@/lib/train/store";
import type { Recipe, TrainEventView } from "@/lib/train/types";
import { pageViewer } from "../viewer";

export const metadata: Metadata = { title: "Fine-tuning job" };

/** Events read per query, and the most pages read: a long job's log is read in full, up to 20,000 events. */
const EVENTS_PAGE = 1000;
const EVENTS_PAGES = 20;
/** The log rows sent to the browser, besides every eval item and judgement (JobRoom shows this many). */
const EVENTS_KEPT = 1500;

/** The job's whole log, oldest first, page by page. */
async function allEvents(jobId: string): Promise<TrainEventView[]> {
  const out: TrainEventView[] = [];
  let after = 0;
  for (let page = 0; page < EVENTS_PAGES; page++) {
    const batch = await listEvents(jobId, after, EVENTS_PAGE);
    out.push(...batch);
    if (batch.length < EVENTS_PAGE) break;
    after = batch[batch.length - 1].id;
  }
  return out;
}

/** The dataset a job's dataset param names, by id and title, or null. */
async function jobDataset(row: TrainJobRow, recipe: Recipe | null): Promise<{ id: string; title: string } | null> {
  const field = recipe?.params.find((f) => f.kind === "dataset");
  const value = field ? row.params?.[field.key] : undefined;
  if (typeof value !== "string") return null;
  const d = await getDataset(value);
  return d ? { id: d.id, title: d.title } : null;
}

/**
 * What non-admins see (docs/TRAINING.md "Lab results"): a judged job's results, read-only, from the store's Lab reads,
 * which never select the instance, IP, region, log or error. Any other job, running, failed or not judged, is a 404.
 */
async function resultPage(jobId: string) {
  const result = await safeQuery(async () => {
    const row = await getResultJob(jobId);
    const recipe = row ? recipeById(row.recipe) : null;
    const view = row ? toResultView(row, recipe ? toRecipeView(recipe) : null) : null;
    if (!view) return null;
    const [events, dataset] = await Promise.all([
      listResultEvents(view.id),
      view.datasetId ? getReadyDataset(view.datasetId) : Promise.resolve(null),
    ]);
    return { result: view, rows: evalRows(events), dataset: dataset ? { id: dataset.id, title: dataset.title } : null };
  });
  if (!result.ok) {
    return (
      <div className="page">
        <NotConnected reason={result.reason} what="these results" />
      </div>
    );
  }
  if (!result.data) notFound();
  return <JobResults {...result.data} />;
}

export default async function FineTuningJobPage({ params }: { params: Promise<{ jobId: string }> }) {
  await connection();
  const [{ jobId }, user] = await Promise.all([params, pageViewer()]);
  if (!user?.isAdmin) return resultPage(jobId);

  const now = new Date();
  const result = await safeQuery(async () => {
    const row = await getJob(jobId);
    if (!row) return null;
    const [events, dataset] = await Promise.all([allEvents(row.id), jobDataset(row, recipeById(row.recipe))]);
    const { kept, dropped } = keepEvents(events, EVENTS_KEPT);
    return { job: toJobView(row, now), events: kept, droppedEvents: dropped, dataset };
  });
  if (!result.ok) {
    return (
      <div className="page">
        <NotConnected reason={result.reason} what="this job" />
      </div>
    );
  }
  if (!result.data) {
    return (
      <div className="page">
        <EmptyCard icon="tune" title="No job here" action={{ href: "/fine-tuning", label: "See all jobs" }}>
          <p>This link doesn&apos;t match a fine-tuning job. It may have a typo.</p>
        </EmptyCard>
      </div>
    );
  }

  const recipe = recipeById(result.data.job.recipe);
  return (
    <JobRoom
      job={result.data.job}
      events={result.data.events}
      droppedEvents={result.data.droppedEvents}
      recipe={recipe ? toRecipeView(recipe) : null}
      dataset={result.data.dataset}
      serverNow={now.getTime()}
    />
  );
}
