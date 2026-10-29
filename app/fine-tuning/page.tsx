import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Icon } from "@/components/icons";
import { AdminsOnly } from "@/components/train/AdminsOnly";
import { DatasetsTable } from "@/components/train/DatasetsTable";
import { JobsTable } from "@/components/train/JobsTable";
import { LabIntro, ReadyDatasetsTable, ResultsTable } from "@/components/train/LabResults";
import { NewDatasetCard } from "@/components/train/NewDatasetCard";
import { NewJobCard } from "@/components/train/NewJobCard";
import { RefreshWhileActive } from "@/components/train/RefreshWhileActive";
import { WRITER_NAME, cacheCostText, isDatasetStalled, toRecipeView } from "@/components/train/format";
import { toReadyDatasetView, toResultView, type ResultView } from "@/components/train/results";
import { EmptyCard, InfoTip, NotConnected, PageHeader } from "@/components/ui";
import { env } from "@/lib/env";
import { plural, usd } from "@/lib/format";
import { safeQuery, type QueryResult } from "@/lib/queries";
import { spendPaused } from "@/lib/quota";
import { toDatasetView, toJobView } from "@/lib/train/logic";
import { RECIPES } from "@/lib/train/recipes";
import {
  activeJobCount,
  datasetProgress,
  lastSweepOkAt,
  listAdapterOptions,
  listDatasets,
  listJobs,
  listReadyDatasets,
  listResultJobs,
  trainingSpendToday,
} from "@/lib/train/store";
import { isTrainTerminal, PUBLISH_RECIPE, type DatasetView, type RecipeView, type TrainJobView } from "@/lib/train/types";
import { callbackOrigin } from "@/lib/train/userdata";
import { sweepOffReason, sweepRunning } from "@/app/api/train/shared";
import { pageViewer } from "./viewer";

export const metadata: Metadata = { title: "Fine-tuning" };

type Show = "all" | "active" | "ended";

const SUBTITLE =
  "Train Muse models on a Lambda GPU. Every job has a hard time and dollar limit, and its GPU is always shut down.";

/** What non-admins see under the title: the Lab results, which they can read but not change. */
const LAB_SUBTITLE = "Results from fine-tuning runs on Lambda GPUs, read-only.";

/** Judged jobs and ready datasets the Lab results list, newest first. */
const RESULTS_SHOWN = 50;
const LAB_DATASETS_SHOWN = 50;

function parseShow(v: string | string[] | undefined): Show {
  return v === "active" || v === "ended" ? v : "all";
}

function hrefFor(show: Show): string {
  return show === "all" ? "/fine-tuning" : `/fine-tuning?show=${show}`;
}

/** Datasets still being written whose progress the list shows; past this many, the rest show without a count. */
const PROGRESS_SHOWN = 10;

/** The datasets, newest first, with how many examples the ones still being written have so far. */
async function loadDatasets(now: number): Promise<{ datasets: DatasetView[]; written: Record<string, number> }> {
  const datasets = (await listDatasets(100)).map(toDatasetView);
  const writing = datasets.filter((d) => d.status === "generating" && !isDatasetStalled(d, now)).slice(0, PROGRESS_SHOWN);
  const counts = await Promise.all(writing.map((d) => datasetProgress(d.id)));
  const written: Record<string, number> = {};
  writing.forEach((d, i) => {
    const n = counts[i];
    if (typeof n === "number") written[d.id] = n;
  });
  return { datasets, written };
}

/** The judged jobs the Lab results list, as anyone may see them (components/train/results.ts). */
async function loadResults(): Promise<ResultView[]> {
  const recipes = RECIPES.map(toRecipeView);
  const rows = await listResultJobs(RESULTS_SHOWN);
  return rows.flatMap((row) => {
    const view = toResultView(row, recipes.find((r) => r.id === row.recipe) ?? null);
    return view ? [view] : [];
  });
}

/** "Datasets: 1 being written, 2 ready.", read out when a dataset starts or finishes while the page refreshes itself. */
function datasetsSummary(datasets: DatasetView[], now: number): string {
  const writing = datasets.filter((d) => d.status === "generating" && !isDatasetStalled(d, now)).length;
  const ready = datasets.filter((d) => d.status === "ready").length;
  return `Datasets: ${writing} being written, ${ready} ready.`;
}

/** Why POST /api/train/datasets would refuse right now, as the route checks it, or null. */
async function datasetBlock(): Promise<"meta_not_configured" | "paused" | null> {
  if (!process.env.MODEL_API_KEY) return "meta_not_configured";
  const paused = await safeQuery(spendPaused);
  return paused.ok && paused.data ? "paused" : null;
}

export default async function FineTuningPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const [user, sp] = await Promise.all([pageViewer(), searchParams]);
  if (!user?.isAdmin) return labPage(Boolean(user));

  const show = parseShow(sp.show);
  const initialDatasetId = typeof sp.dataset === "string" ? sp.dataset : null;
  const now = new Date();
  // Datasets, results and adapters load on their own, so a problem with them doesn't hide the jobs.
  const [result, datasetsResult, blocked, results, adapters] = await Promise.all([
    safeQuery(async () => {
      const [rows, active, spentToday] = await Promise.all([listJobs(100), activeJobCount(), trainingSpendToday(now)]);
      return { jobs: rows.map((r) => toJobView(r, now)), active, spentToday };
    }),
    safeQuery(() => loadDatasets(now.getTime())),
    datasetBlock(),
    safeQuery(loadResults),
    safeQuery(() => listAdapterOptions()),
  ]);
  const recipes = RECIPES.map(toRecipeView);
  // The model cache bills every month on its own, outside every limit on this page.
  const cacheNote = cacheCostText(recipes);
  const ceilings = { maxMinutes: env.trainJobMaxMinutes, maxUsd: env.trainJobMaxUsd };
  // The same gate POST /api/train/jobs applies. When the database can't say, the route still checks on Start.
  const lastSweep = sweepOffReason() ? null : await safeQuery(lastSweepOkAt);
  const sweepOff = sweepOffReason() ?? (lastSweep?.ok && !sweepRunning(lastSweep.data, now) ? "sweep_not_running" : null);
  const datasets = datasetsResult.ok ? datasetsResult.data.datasets : null;
  const jobsActive = result.ok && result.data.jobs.some((j) => !isTrainTerminal(j.status));
  const datasetsWriting = Boolean(datasets?.some((d) => d.status === "generating" && !isDatasetStalled(d, now.getTime())));

  return (
    <div className="page">
      <PageHeader
        title="Fine-tuning"
        subtitle={SUBTITLE}
        actions={
          <>
            <a className="btn btn-outline" href="#new-dataset">
              <Icon name="plus" size={18} />
              New dataset
            </a>
            <a className="btn btn-primary" href="#new-job">
              <Icon name="plus" size={18} />
              New job
            </a>
          </>
        }
      />
      <RefreshWhileActive active={jobsActive || datasetsWriting} />

      {!result.ok ? (
        <NotConnected reason={result.reason} what="fine-tuning jobs" />
      ) : (
        <>
          <section className="card totals" aria-label="Today">
            <p className="totals-big">
              <strong>
                {result.data.active} of {env.trainMaxActive}
              </strong>{" "}
              {env.trainMaxActive === 1 ? "GPU" : "GPUs"} in use · <strong>{usd(result.data.spentToday)}</strong> of{" "}
              {usd(env.trainDailyUsd)} spent today
            </p>
            <div className="train-totals-sub">
              <p className="muted small">
                Each job is capped at {plural(env.trainJobMaxMinutes, "minute")} and {usd(env.trainJobMaxUsd)}. Costs
                are estimates from Lambda&apos;s hourly prices, counted from launch until the GPU shuts down.
              </p>
              <InfoTip label="About the limits">
                A job stops at its own time or dollar limit, whichever comes first. A check every 5 minutes also shuts
                down any GPU past its limit, so a lost job can&apos;t keep billing. The daily cap counts UTC days.
              </InfoTip>
            </div>
            {cacheNote ? <p className="muted small">{cacheNote}</p> : null}
          </section>
          <JobsSection jobs={result.data.jobs} show={show} recipes={recipes} now={now.getTime()} />
        </>
      )}

      <ResultsSection results={results} admin />

      <NewJobCard
        // A glimmer-publish job starts from its adapter job's Hugging Face card (Publish), which keeps track of it.
        recipes={recipes.filter((r) => r.id !== PUBLISH_RECIPE)}
        ceilings={ceilings}
        maxActive={env.trainMaxActive}
        dailyUsd={env.trainDailyUsd}
        platformPublic={Boolean(callbackOrigin(env.platformUrl))}
        sweepOff={sweepOff}
        datasets={datasets ? datasets.filter((d) => d.status !== "failed" && !isDatasetStalled(d, now.getTime())) : null}
        initialDatasetId={initialDatasetId}
        adapters={adapters.ok ? adapters.data : null}
      />

      <section className="section" id="datasets" aria-labelledby="datasets-title">
        <div className="section-head">
          <h2 id="datasets-title">Datasets</h2>
        </div>
        {datasets ? (
          <p className="sr-only" aria-live="polite">
            {datasetsSummary(datasets, now.getTime())}
          </p>
        ) : null}
        {!datasetsResult.ok ? (
          <NotConnected reason={datasetsResult.reason} what="training datasets" />
        ) : datasetsResult.data.datasets.length === 0 ? (
          <EmptyCard icon="file" title="No datasets yet">
            <p>
              Describe a task below and {WRITER_NAME} writes training examples for it, with some held out to judge the
              tuned model.
            </p>
          </EmptyCard>
        ) : (
          <DatasetsTable
            datasets={datasetsResult.data.datasets}
            written={datasetsResult.data.written}
            now={now.getTime()}
            caption="Training datasets, newest first"
          />
        )}
      </section>

      <NewDatasetCard blocked={blocked} />
    </div>
  );
}

/**
 * The Lab results for non-admins (docs/TRAINING.md "Lab results"): what the lab does, the judged jobs and the ready
 * datasets, read-only. Nothing here starts, stops or changes anything, and nothing reads a job's log, instance or error.
 */
async function labPage(signedIn: boolean) {
  const now = Date.now();
  const [results, datasets] = await Promise.all([
    safeQuery(loadResults),
    safeQuery(async () =>
      (await listReadyDatasets(LAB_DATASETS_SHOWN)).filter((d) => d.status === "ready").map(toReadyDatasetView),
    ),
  ]);
  return (
    <div className="page">
      <PageHeader title="Fine-tuning" subtitle={LAB_SUBTITLE} />
      <LabIntro />
      {!results.ok && !datasets.ok ? (
        <NotConnected reason={results.reason} what="the fine-tuning results" />
      ) : (
        <>
          <ResultsSection results={results} admin={false} />
          <section className="section" id="datasets" aria-labelledby="datasets-title">
            <div className="section-head">
              <h2 id="datasets-title">Datasets</h2>
            </div>
            {!datasets.ok ? (
              <NotConnected reason={datasets.reason} what="the training datasets" />
            ) : datasets.data.length === 0 ? (
              <EmptyCard icon="file" title="No datasets yet">
                <p>Training sets {WRITER_NAME} writes show up here once they are ready.</p>
              </EmptyCard>
            ) : (
              <ReadyDatasetsTable datasets={datasets.data} now={now} caption="Ready training datasets, newest first" />
            )}
          </section>
        </>
      )}
      <AdminsOnly signedIn={signedIn} />
    </div>
  );
}

/** The judged jobs. Admins see it only when there are some, with a note that anyone can see them. */
function ResultsSection({ results, admin }: { results: QueryResult<ResultView[]>; admin: boolean }) {
  if (admin && (!results.ok || results.data.length === 0)) return null;
  return (
    <section className="section" id="results" aria-labelledby="results-title">
      <div className="section-head">
        <h2 id="results-title">Results</h2>
        {admin ? <span className="muted small">Anyone can see these, read-only.</span> : null}
      </div>
      {!results.ok ? (
        <NotConnected reason={results.reason} what="the fine-tuning results" />
      ) : results.data.length === 0 ? (
        <EmptyCard icon="tune" title="No results yet">
          <p>A job shows up here once it has finished and {WRITER_NAME} has judged it.</p>
        </EmptyCard>
      ) : (
        <ResultsTable results={results.data} caption="Judged fine-tuning jobs, newest first" />
      )}
    </section>
  );
}

function JobsSection({
  jobs,
  show,
  recipes,
  now,
}: {
  jobs: TrainJobView[];
  show: Show;
  recipes: RecipeView[];
  now: number;
}) {
  const active = jobs.filter((j) => !isTrainTerminal(j.status));
  const shown = show === "active" ? active : show === "ended" ? jobs.filter((j) => isTrainTerminal(j.status)) : jobs;
  const options: Array<{ value: Show; label: string }> = [
    { value: "all", label: "All" },
    { value: "active", label: active.length ? `Active (${active.length})` : "Active" },
    { value: "ended", label: "Ended" },
  ];

  return (
    <section className="section" aria-labelledby="jobs-title">
      <div className="section-head">
        <h2 id="jobs-title">Jobs</h2>
        <div className="segmented" role="group" aria-label="Show jobs">
          {options.map((o) => (
            <Link key={o.value} href={hrefFor(o.value)} aria-current={show === o.value ? "true" : undefined} scroll={false}>
              {o.label}
            </Link>
          ))}
        </div>
      </div>
      {jobs.length === 0 ? (
        <EmptyCard icon="tune" title="No jobs yet">
          <p>
            Start with the smoke test. It runs on the cheapest free GPU, checks the GPU, CUDA, disk and network, then
            shuts down.
          </p>
        </EmptyCard>
      ) : shown.length === 0 ? (
        <p className="muted">{show === "active" ? "No job is running right now." : "No job has ended yet."}</p>
      ) : (
        <JobsTable
          jobs={shown}
          recipes={recipes}
          now={now}
          caption={show === "active" ? "Active fine-tuning jobs, newest first" : "Fine-tuning jobs, newest first"}
        />
      )}
    </section>
  );
}
