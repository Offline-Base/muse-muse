import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { BoardLoopRoom } from "@/components/board-loop/BoardLoopRoom";
import { EmptyCard, PageHeader } from "@/components/ui";
import { loopView } from "@/lib/board-loop/logic";
import { getLoop } from "@/lib/board-loop/store";
import { env } from "@/lib/env";
import { pageViewer } from "../../viewer";

export const metadata: Metadata = { title: "Board loop" };

/** One board loop, for admins (docs/BOARD_LOOP.md). */
export default async function BoardLoopPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  if (!env.boardLoop) notFound();
  const viewer = await pageViewer();
  if (!viewer?.isAdmin) {
    return (
      <div className="page">
        <EmptyCard icon="tune" title="Admins only" />
      </div>
    );
  }
  const row = await getLoop((await params).id);
  if (!row) notFound();
  return (
    <div className="page">
      <PageHeader title={row.data.title} subtitle="From a judged model to a board people can try." />
      <BoardLoopRoom initial={loopView(row)} />
    </div>
  );
}
