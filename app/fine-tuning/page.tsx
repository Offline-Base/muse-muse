import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Icon } from "@/components/icons";
import { AdminsOnly } from "@/components/train/AdminsOnly";
import { JobsTable } from "@/components/train/JobsTable";
import { NewJobCard } from "@/components/train/NewJobCard";
import { RefreshWhileActive } from "@/components/train/RefreshWhileActive";
import { toRecipeView } from "@/components/train/format";
import { EmptyCard, InfoTip, NotConnected, PageHeader } from "@/components/ui";
import { env } from "@/lib/env";
import { plural, usd } from "@/lib/format";
import { safeQuery } from "@/lib/queries";
import { toJobView } from "@/lib/train/logic";
import { RECIPES } from "@/lib/train/recipes";
import { activeJobCount, lastSweepOkAt, listJobs, trainingSpendToday } from "@/lib/train/store";
import { isTrainTerminal, type RecipeView, type TrainJobView } from "@/lib/train/types";
import { callbackOrigin } from "@/lib/train/userdata";
import { sweepOffReason, sweepRunning } from "@/app/api/train/shared";
import { pageViewer } from "./viewer";

export const metadata: Metadata = { title: "Fine-tuning" };

type Show = "all" | "active" | "ended";

const SUBTITLE =
  "Train Muse models on a Lambda GPU. Every job has a hard time and dollar limit, and its GPU is always shut down.";

function parseShow(v: string | string[] | undefined): Show {
  return v === "active" || v === "ended" ? v : "all";
}

function hrefFor(show: Show): string {
  return show === "all" ? "/fine-tuning" : `/fine-tuning?show=${show}`;
}

export default async function FineTuningPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const [user, sp] = await Promise.all([pageViewer(), searchParams]);
  if (!user?.isAdmin) {
    return (
      <div className="page">
        <PageHeader title="Fine-tuning" subtitle={SUBTITLE} />
        <AdminsOnly signedIn={Boolean(user)} />
      </div>
    );
  }

  const show = parseShow(sp.show);
  const now = new Date();
  const result = await safeQuery(async () => {
    const [rows, active, spentToday] = await Promise.all([listJobs(100), activeJobCount(), trainingSpendToday(now)]);
    return { jobs: rows.map((r) => toJobView(r, now)), active, spentToday };
  });
  const recipes = RECIPES.map(toRecipeView);
  const ceilings = { maxMinutes: env.trainJobMaxMinutes, maxUsd: env.trainJobMaxUsd };
  // The same gate POST /api/train/jobs applies. When the database can't say, the route still checks on Start.
  const lastSweep = sweepOffReason() ? null : await safeQuery(lastSweepOkAt);
  const sweepOff = sweepOffReason() ?? (lastSweep?.ok && !sweepRunning(lastSweep.data, now) ? "sweep_not_running" : null);

  return (
    <div className="page">
      <PageHeader
        title="Fine-tuning"
        subtitle={SUBTITLE}
        actions={
          <a className="btn btn-primary" href="#new-job">
            <Icon name="plus" size={18} />
            New job
          </a>
        }
      />

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
          </section>
          <JobsSection jobs={result.data.jobs} show={show} recipes={recipes} now={now.getTime()} />
        </>
      )}

      <NewJobCard
        recipes={recipes}
        ceilings={ceilings}
        maxActive={env.trainMaxActive}
        dailyUsd={env.trainDailyUsd}
        platformPublic={Boolean(callbackOrigin(env.platformUrl))}
        sweepOff={sweepOff}
      />
    </div>
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
      <RefreshWhileActive active={active.length > 0} />
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
