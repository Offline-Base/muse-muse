import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { DriveOffer } from "@/components/drive/DriveOffer";
import { JobResults } from "@/components/train/JobResults";
import { JobRoom } from "@/components/train/JobRoom";
import type { JobLiveDemo } from "@/components/train/LiveDemo";
import { NOT_PUBLIC_TEXT, evalRows, keepEvents, sweepOffText, toRecipeView } from "@/components/train/format";
import { hasResults, toPublicLiveDemo, toResultView } from "@/components/train/results";
import { EmptyCard, NotConnected } from "@/components/ui";
import { RunLocallyLink, linkedLocalFiles } from "@/components/vibe/RunLocallyLink";
import { env } from "@/lib/env";
import { safeQuery } from "@/lib/queries";
import { ADAPTER_RECIPE, adapterProblem, toJobView } from "@/lib/train/logic";
import { recipeById } from "@/lib/train/recipes";
import {
  getAdapterSource,
  getDataset,
  getJob,
  getLiveDemo,
  getReadyDataset,
  getResultJob,
  lastSweepOkAt,
  listEvents,
  listResultEvents,
  type TrainJobRow,
} from "@/lib/train/store";
import type { LiveDemoView, Recipe, TrainEventView } from "@/lib/train/types";
import { callbackOrigin } from "@/lib/train/userdata";
import { sweepOffReason, sweepRunning } from "@/app/api/train/shared";
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

/** The trained job a glimmer-serve job's adapter param names, by id and title, or null. */
async function servedAdapter(row: TrainJobRow, recipe: Recipe | null): Promise<{ id: string; title: string } | null> {
  const field = recipe?.params.find((f) => f.kind === "adapter");
  const value = field ? row.params?.[field.key] : undefined;
  if (typeof value !== "string") return null;
  const a = await getJob(value);
  return a ? { id: a.id, title: a.title } : null;
}

/**
 * The live demo of a trained glimmer-lora job's adapter (docs/TRAINING.md "Live demo"), or null when there is none.
 * A problem reading it is logged and leaves the box out, so it never takes the rest of the page down with it.
 */
async function liveDemoOf(adapterJobId: string, now: Date): Promise<LiveDemoView | null> {
  try {
    return await getLiveDemo(adapterJobId, now);
  } catch (err) {
    console.error("[fine-tuning] live demo:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Why POST /api/train/jobs would refuse a new job right now, as the New job card says it, or null. */
async function startBlock(now: Date): Promise<string | null> {
  if (!callbackOrigin(env.platformUrl)) return NOT_PUBLIC_TEXT;
  const off = sweepOffReason();
  if (off) return sweepOffText(off);
  // When the database can't say, the route still checks on Start, as on /fine-tuning.
  const last = await lastSweepOkAt().catch(() => undefined);
  return last === undefined || sweepRunning(last, now) ? null : sweepOffText("sweep_not_running");
}

/**
 * What an admin's page of a trained glimmer-lora job shows for its live demo: the Try it live box while a serve job for
 * it is open, Start a live demo when its adapter can be served (adapterProblem, as the jobs route checks it), else null.
 */
async function adapterLiveDemo(row: TrainJobRow, now: Date): Promise<JobLiveDemo | null> {
  if (row.recipe !== ADAPTER_RECIPE || row.status !== "succeeded") return null;
  const demo = await liveDemoOf(row.id, now);
  if (demo) return { kind: "demo", demo };
  try {
    const source = await getAdapterSource(row.id);
    if (!source || adapterProblem(source.job, source.metrics)) return null;
    return {
      kind: "start",
      adapterTitle: row.title,
      ceilings: { maxMinutes: env.trainJobMaxMinutes, maxUsd: env.trainJobMaxUsd },
      maxActive: env.trainMaxActive,
      dailyUsd: env.trainDailyUsd,
      blocked: await startBlock(now),
      publicPage: hasResults(row),
    };
  } catch (err) {
    console.error("[fine-tuning] live demo adapter:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * What non-admins see (docs/TRAINING.md "Lab results"): a judged job's results, read-only, from the store's Lab reads,
 * which never select the instance, IP, region, log or error. Any other job, running, failed or not judged, is a 404.
 * While a live demo of a glimmer-lora job's adapter is open, the page also gets its PublicLiveDemo (state, minutes and
 * end time only) for the Try it live box.
 */
async function resultPage(jobId: string) {
  const now = new Date();
  const result = await safeQuery(async () => {
    const row = await getResultJob(jobId);
    const recipe = row ? recipeById(row.recipe) : null;
    const view = row ? toResultView(row, recipe ? toRecipeView(recipe) : null) : null;
    if (!view) return null;
    const [events, dataset, live, local] = await Promise.all([
      listResultEvents(view.id),
      view.datasetId ? getReadyDataset(view.datasetId) : Promise.resolve(null),
      view.recipe === ADAPTER_RECIPE ? liveDemoOf(view.id, now) : Promise.resolve(null),
      view.recipe === ADAPTER_RECIPE && view.hub ? linkedLocalFiles(view.id) : Promise.resolve(null),
    ]);
    return {
      result: view,
      rows: evalRows(events),
      dataset: dataset ? { id: dataset.id, title: dataset.title } : null,
      live: toPublicLiveDemo(live),
      local,
    };
  });
  if (!result.ok) {
    return (
      <div className="page">
        <NotConnected reason={result.reason} what="these results" />
      </div>
    );
  }
  if (!result.data) notFound();
  // "Run it on your computer" shows only once the model has public local files (docs/VIBE_TUNING.md, Feature 5).
  const { local, ...data } = result.data;
  return (
    <>
      <JobResults {...data} serverNow={now.getTime()} aside={local ? <RunLocallyLink jobId={data.result.id} files={local} /> : null} />
      <DriveOffer files={local} />
    </>
  );
}

export default async function FineTuningJobPage({ params }: { params: Promise<{ jobId: string }> }) {
  await connection();
  const [{ jobId }, user] = await Promise.all([params, pageViewer()]);
  if (!user?.isAdmin) return resultPage(jobId);

  const now = new Date();
  const result = await safeQuery(async () => {
    const row = await getJob(jobId);
    if (!row) return null;
    const recipe = recipeById(row.recipe);
    const [events, dataset, adapter, liveDemo] = await Promise.all([
      allEvents(row.id),
      jobDataset(row, recipe),
      servedAdapter(row, recipe),
      adapterLiveDemo(row, now),
    ]);
    const { kept, dropped } = keepEvents(events, EVENTS_KEPT);
    return { job: toJobView(row, now), events: kept, droppedEvents: dropped, dataset, adapter, liveDemo };
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
      adapter={result.data.adapter}
      liveDemo={result.data.liveDemo}
      hub={
        result.data.job.recipe === ADAPTER_RECIPE
          ? { offReason: env.hubOffReason, maxActive: env.trainMaxActive, dailyUsd: env.trainDailyUsd }
          : null
      }
      serverNow={now.getTime()}
    />
  );
}
