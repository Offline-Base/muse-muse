import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { EmptyCard, NotConnected, PageHeader } from "@/components/ui";
import { env } from "@/lib/env";
import { usd } from "@/lib/format";
import { safeQuery } from "@/lib/queries";
import { listResearch } from "@/lib/train/research/store";
import { pageViewer } from "../viewer";

export const metadata: Metadata = { title: "Data research" };

/** Past data research runs. Admins only, and with TUNE_RESEARCH on. */
export default async function ResearchIndex() {
  await connection();
  const user = await pageViewer();
  if (!env.tuneResearch || !user?.isAdmin) notFound();
  const result = await safeQuery(listResearch);
  return (
    <div className="page">
      <PageHeader title="Data research" subtitle="Reports of public data that could help a fine-tune. Start one from the New dataset card." />
      {!result.ok ? (
        <NotConnected reason={result.reason} what="data research" />
      ) : result.data.length === 0 ? (
        <EmptyCard title="No research yet">
          <Link href="/fine-tuning#new-dataset">Describe a task on the New dataset card</Link> and choose Find data first.
        </EmptyCard>
      ) : (
        <ul className="research-list">
          {result.data.map((r) => (
            <li key={r.id} className="card">
              <Link href={`/fine-tuning/research/${r.id}`}>{r.task.length > 120 ? `${r.task.slice(0, 120)}...` : r.task}</Link>
              <p className="muted small">
                {r.status === "running" ? "Researching" : r.status === "ready" ? "Ready" : "Failed"} · {usd(r.costUsd)} · {r.createdAt.toISOString().slice(0, 10)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
