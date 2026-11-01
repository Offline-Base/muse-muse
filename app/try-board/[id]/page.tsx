import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { BoardTry } from "@/components/board-loop/BoardTry";
import { PageHeader } from "@/components/ui";
import { boardLabel } from "@/lib/board-loop/logic";
import { getLoop } from "@/lib/board-loop/store";
import { TRY_LIMITS } from "@/lib/board-loop/try";
import { mayTry, tryDeps } from "@/lib/board-loop/try-server";
import { env } from "@/lib/env";

export const metadata: Metadata = { title: "Try it on a board", robots: { index: false } };

/** The public, queued try page for one board loop. */
export default async function TryBoardPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  if (!env.boardLoop) notFound();
  const loop = await getLoop((await params).id);
  if (!loop || !(await mayTry(loop))) notFound();
  let state: "open" | "closed" | "offline" = "closed";
  if (loop.tryOpen) {
    const board = await tryDeps.board(loop);
    state = board && (await board.status().then((s) => s.online, () => false)) ? "open" : "offline";
  }
  return (
    <div className="page page-narrow">
      <PageHeader title={loop.data.title} subtitle={loop.target === "simulated" ? "A simulated board stands in until a real one is connected." : "Try this model on a board."} />
      <BoardTry loopId={loop.id} label={boardLabel(loop.target)} simulated={loop.target === "simulated"} initialState={state} promptChars={TRY_LIMITS.promptChars} perHour={TRY_LIMITS.perVisitorPerHour} />
    </div>
  );
}
