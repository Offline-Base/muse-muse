import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { RefreshWhileActive } from "@/components/train/RefreshWhileActive";
import { StopLoopButton } from "@/components/train/TuneLoop";
import { NotConnected } from "@/components/ui";
import { env } from "@/lib/env";
import { usd } from "@/lib/format";
import { safeQuery } from "@/lib/queries";
import type { LoopRoundView } from "@/lib/train/tune/loop";
import { loadLoopView } from "@/lib/train/tune/loop-store";
import { pageViewer } from "../../viewer";

export const metadata: Metadata = { title: "Tuning loop" };

const STAGE: Record<LoopRoundView["stage"], string> = {
  writing: "Writing examples",
  checking: "Checking, then waiting for a GPU",
  training: "Training",
  scoring: "Judging",
  done: "Judged",
  failed: "Failed",
};

function scoreCell(s: LoopRoundView["sealed"]): string {
  return s ? `${s.avgTunedScore} vs ${s.avgBaseScore} base, won ${s.tunedWins} of ${s.items}` : "Not yet";
}

/** A tuning loop and every round (docs/TRAINING.md "Tuning loop"). Off with TUNE_LOOP: a 404. Admins only. */
export default async function TuneLoopPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  if (!env.tuneLoop) notFound();
  const [user, { id }] = await Promise.all([pageViewer(), params]);
  if (!user?.isAdmin) redirect("/fine-tuning");
  const result = await safeQuery(() => loadLoopView(id));
  if (!result.ok) {
    return (
      <div className="page">
        <NotConnected reason={result.reason} what="this loop" />
      </div>
    );
  }
  const loop = result.data;
  if (!loop) notFound();
  return (
    <div className="page">
      <RefreshWhileActive active={loop.running} everyMs={15_000} />
      <h1>Tuning loop: {loop.title}</h1>
      <p>
        Target {loop.spec.target} on the sealed prompts, {usd(loop.spentUsd)} spent of a {usd(loop.spec.capUsd)} cap, up to {loop.spec.maxRounds} rounds.
      </p>
      <p>{loop.running ? "Running." : `Ended. ${loop.stopText}`}</p>
      {loop.running ? <StopLoopButton loopId={loop.id} /> : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Round</th>
              <th>Stage</th>
              <th>Sealed prompts</th>
              <th>All prompts</th>
              <th>New examples</th>
              <th>Trained on</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {loop.rounds.map((r) => (
              <tr key={r.round}>
                <td>{r.round === 0 ? "Start" : r.round}</td>
                <td>
                  {r.jobId ? <Link href={`/fine-tuning/${r.jobId}`}>{STAGE[r.stage]}</Link> : STAGE[r.stage]}
                  {r.reached ? " (reached the target)" : ""}
                </td>
                <td>{scoreCell(r.sealed)}</td>
                <td>{scoreCell(r.all)}</td>
                <td>{r.added ?? ""}</td>
                <td>{r.trainCount ?? ""}</td>
                <td>{r.round === 0 ? "Before the loop" : usd(r.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loop.rounds
        .filter((r) => r.weak.length)
        .map((r) => (
          <details key={r.round}>
            <summary>What round {r.round} aimed at ({r.weak.length} prompts)</summary>
            <ul>
              {r.weak.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </details>
        ))}
    </div>
  );
}
