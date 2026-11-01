import { notFound } from "next/navigation";
import { ConfirmAction } from "@/components/gadgets/ConfirmAction";
import { getSessionUser } from "@/lib/auth";
import { canOwnBoard } from "@/lib/caps/hardware/admin";
import { gadgetConnectOn } from "@/lib/caps/hardware/flags";
import { readRobotRequest } from "@/lib/caps/hardware/robot";
import { linkedBoardRow, pairedFactsOf } from "@/lib/caps/hardware/store";
import { robotActionLines, robotActionProblem } from "@/lib/gateway/gadget-sim";

export const metadata = { title: "Confirm an action", robots: { index: false } };

/** Where the owner says yes to one robot action. Everyone else sees that it isn't theirs, and nothing about the action. */
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  if (!gadgetConnectOn()) notFound();
  const { r } = await searchParams;
  const user = await getSessionUser();
  const request = readRobotRequest(r, new Date());
  const mine = request && canOwnBoard(user) && request.ownerUserId === user!.id && !robotActionProblem(request.action, request.args);
  const row = mine ? await linkedBoardRow(request.productId) : null;
  const facts = row && row.boardId === request!.boardId ? pairedFactsOf(row.models) : null;
  if (!mine || !facts) {
    return (
      <div className="page">
        <section className="card section-card">
          <h1>This isn&apos;t waiting for you</h1>
          <p className="muted">It has expired, or it belongs to another account. Sign in as the board&apos;s owner and ask from the product again.</p>
        </section>
      </div>
    );
  }
  const { title, lines } = robotActionLines(request.action, request.args);
  return (
    <div className="page">
      <ConfirmAction request={r as string} title={title} lines={lines} simulated={facts.simulated} />
    </div>
  );
}
