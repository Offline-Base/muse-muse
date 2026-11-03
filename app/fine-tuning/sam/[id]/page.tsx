import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { SamReport } from "@/components/train/sam/SamReport";
import { SamRoom } from "@/components/train/sam/SamRoom";
import { env } from "@/lib/env";
import { isUuid } from "@/lib/http";
import { getRunView } from "@/lib/train/sam/store";
import { pageViewer } from "../../viewer";

export const metadata: Metadata = { title: "Teach SAM 3.1" };

/**
 * One SAM 3.1 tune run (SAM_TUNE; docs/TRAINING.md "Teach SAM 3.1 a new object"). Off: a 404 for everyone. Admins get
 * the room (components/train/sam/SamRoom.tsx). Anyone else sees only a finished run an admin marked shown, and then
 * only its report, without the board's name, photos or costs; any other run is a 404, the same as an unknown id.
 */
export default async function SamTunePage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  if (!env.samTune) notFound();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const viewer = await pageViewer();
  const view = await getRunView(id);
  if (!view) notFound();
  if (viewer?.isAdmin) {
    return (
      <div className="page sam-page">
        <SamRoom initial={view} serverNow={Date.now()} />
      </div>
    );
  }
  if (!view.shown || view.status !== "done" || !view.report) notFound();
  const { workerId: _workerId, ...report } = view.report;
  return (
    <div className="page sam-page">
      <SamReport report={report} />
    </div>
  );
}
