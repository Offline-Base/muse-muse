import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { RefreshWhileActive } from "@/components/train/RefreshWhileActive";
import { ResearchReport } from "@/components/train/research/ResearchReport";
import { NotConnected, PageHeader } from "@/components/ui";
import { env } from "@/lib/env";
import { usd } from "@/lib/format";
import { safeQuery } from "@/lib/queries";
import { getResearch } from "@/lib/train/research/store";
import { toResearchView } from "@/lib/train/research/view";
import { pageViewer } from "../../viewer";

export const metadata: Metadata = { title: "Data research" };

/** One research report. Admins only, and with TUNE_RESEARCH on. */
export default async function ResearchPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const [{ id }, user] = await Promise.all([params, pageViewer()]);
  if (!env.tuneResearch || !user?.isAdmin) notFound();
  const result = await safeQuery(() => getResearch(id));
  if (!result.ok) {
    return (
      <div className="page">
        <NotConnected reason={result.reason} what="this report" />
      </div>
    );
  }
  if (!result.data) notFound();
  const view = toResearchView(result.data);
  return (
    <div className="page">
      <PageHeader title="Data research" subtitle={`${usd(view.costUsd)} spent of its ${usd(view.maxUsd)} cap, on Muse Wonder and Meta's web search.`} />
      <RefreshWhileActive active={view.status === "running"} />
      <ResearchReport research={view} />
    </div>
  );
}
