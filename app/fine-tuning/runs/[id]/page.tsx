import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { limitCeilings } from "@/app/api/train/shared";
import { TrainRoom } from "@/components/train/room/TrainRoom";
import { TuneLoopCard } from "@/components/train/TuneLoop";
import { NotConnected } from "@/components/ui";
import { env } from "@/lib/env";
import { makeChatAllOn } from "@/lib/make/switch";
import { safeQuery } from "@/lib/queries";
import { getDataset } from "@/lib/train/store";
import { mayTouchRun, pageRunCaller, runCeilings } from "@/lib/train/tune/caller";
import { loopsOfRun } from "@/lib/train/tune/loop-store";
import { visitorRunView } from "@/lib/train/tune/view";
import { loadTuneRun } from "@/lib/train/tune/store";
import { runLiveDemo } from "../live";
import { pageViewer } from "../../viewer";

export const metadata: Metadata = { title: "Fine-tuning run" };

/**
 * A run's room (docs/TRAINING.md "Fine-tune like a build"): the run is its dataset, so `id` is the dataset's. Off with
 * TUNE_COMPOSER: a 404 for everyone. On: admins only today; anyone else goes to /fine-tuning and its read-only Lab.
 * Once a run's job is trained, the room also gets that job's live demo and its Hugging Face card's setup, as the job's
 * own page does.
 */
/** A visitor's own run (OPEN_TRAIN), as visitorRunView shows it. Anyone else's run is a 404. */
async function visitorRoom(id: string) {
  const now = new Date();
  const result = await safeQuery(async () => {
    const caller = await pageRunCaller();
    const dataset = await getDataset(id);
    if (!dataset || !(await mayTouchRun(caller, dataset.createdBy))) return null;
    const run = await loadTuneRun(id, now, runCeilings(caller));
    return run ? visitorRunView(run) : null;
  });
  if (!result.ok) {
    return (
      <div className="page">
        <NotConnected reason={result.reason} what="this run" />
      </div>
    );
  }
  if (!result.data) notFound();
  return <TrainRoom initial={result.data} admin={false} needsCode serverNow={now.getTime()} story={makeChatAllOn()} />;
}

export default async function TuneRunPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  if (!env.tuneComposer) notFound();
  const [user, { id }] = await Promise.all([pageViewer(), params]);
  if (!user?.isAdmin) {
    if (!env.openTrain) redirect("/fine-tuning");
    return visitorRoom(id);
  }
  const now = new Date();
  const result = await safeQuery(async () => {
    const run = await loadTuneRun(id, now, limitCeilings());
    if (!run) return null;
    const loops = env.tuneLoop && run.verdict?.scored ? await loopsOfRun(run.id) : null;
    return { run, liveDemo: await runLiveDemo(run.job, now), loops };
  });
  if (!result.ok) {
    return (
      <div className="page">
        <NotConnected reason={result.reason} what="this run" />
      </div>
    );
  }
  if (!result.data) notFound();
  const { loops } = result.data;
  return (
    <>
      <TrainRoom
        initial={result.data.run}
        admin
        liveDemo={result.data.liveDemo}
        hub={{ offReason: env.hubOffReason, maxActive: env.trainMaxActive, dailyUsd: env.trainDailyUsd }}
        serverNow={now.getTime()}
        quantTargets={env.quantTargets}
        story={makeChatAllOn()}
        partners={env.partnerEvalProvider ? { hostTuned: env.hostTuned } : null}
      />
      {loops ? <TuneLoopCard datasetId={result.data.run.id} loops={loops.map((l) => ({ id: l.id, running: !l.ended, startedAt: l.spec.startedAt }))} /> : null}
    </>
  );
}
