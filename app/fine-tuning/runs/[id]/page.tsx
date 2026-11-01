import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { limitCeilings } from "@/app/api/train/shared";
import { TrainRoom } from "@/components/train/room/TrainRoom";
import { NotConnected } from "@/components/ui";
import { env } from "@/lib/env";
import { safeQuery } from "@/lib/queries";
import { loadTuneRun } from "@/lib/train/tune/store";
import { pageViewer } from "../../viewer";

export const metadata: Metadata = { title: "Fine-tuning run" };

/**
 * A run's room (docs/TRAINING.md "Fine-tune like a build"): the run is its dataset, so `id` is the dataset's. Off with
 * TUNE_COMPOSER: a 404 for everyone. On: admins only today; anyone else goes to /fine-tuning and its read-only Lab.
 */
export default async function TuneRunPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  if (!env.tuneComposer) notFound();
  const [user, { id }] = await Promise.all([pageViewer(), params]);
  if (!user?.isAdmin) redirect("/fine-tuning");
  const now = new Date();
  const result = await safeQuery(() => loadTuneRun(id, now, limitCeilings()));
  if (!result.ok) {
    return (
      <div className="page">
        <NotConnected reason={result.reason} what="this run" />
      </div>
    );
  }
  if (!result.data) notFound();
  return <TrainRoom initial={result.data} admin serverNow={now.getTime()} />;
}
