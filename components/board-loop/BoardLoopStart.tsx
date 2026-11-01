"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** The single start action on a judged model. */
export function BoardLoopStart({ adapterJobId, simulated }: { adapterJobId: string; simulated: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setProblem(null);
    const res = await fetch("/api/board-loop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ adapterJobId }) }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { id?: string; message?: string; error?: string } | null;
    if (res?.status === 202 && body?.id) return router.push(`/fine-tuning/board-loop/${body.id}`);
    setBusy(false);
    setProblem(body?.message ?? body?.error ?? "It didn't start.");
  };
  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={go} disabled={busy}>
        {simulated ? "Send to the simulated board" : "Send to the board"}
      </button>
      {problem ? (
        <p className="board-notice" role="alert">
          {problem}
        </p>
      ) : null}
    </>
  );
}
