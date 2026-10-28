import type { Metadata } from "next";
import { connection } from "next/server";
import { AdminsOnly } from "@/components/train/AdminsOnly";
import { JobRoom } from "@/components/train/JobRoom";
import { toRecipeView } from "@/components/train/format";
import { EmptyCard, NotConnected, PageHeader } from "@/components/ui";
import { safeQuery } from "@/lib/queries";
import { toJobView } from "@/lib/train/logic";
import { recipeById } from "@/lib/train/recipes";
import { getJob, listEvents } from "@/lib/train/store";
import { pageViewer } from "../viewer";

export const metadata: Metadata = { title: "Fine-tuning job" };

export default async function FineTuningJobPage({ params }: { params: Promise<{ jobId: string }> }) {
  await connection();
  const [{ jobId }, user] = await Promise.all([params, pageViewer()]);
  if (!user?.isAdmin) {
    return (
      <div className="page">
        <PageHeader title="Fine-tuning job" />
        <AdminsOnly signedIn={Boolean(user)} next={`/fine-tuning/${encodeURIComponent(jobId)}`} />
      </div>
    );
  }

  const now = new Date();
  const result = await safeQuery(async () => {
    const row = await getJob(jobId);
    if (!row) return null;
    return { job: toJobView(row, now), events: await listEvents(row.id) };
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
      recipe={recipe ? toRecipeView(recipe) : null}
      serverNow={now.getTime()}
    />
  );
}
