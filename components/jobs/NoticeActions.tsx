"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** The owner's answer to one notice: POST /api/products/<slug>/notices/<id>. A held send gets Confirm and Dismiss, others Clear. */
export function NoticeActions({ slug, id, held }: { slug: string; id: string; held: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function answer(action: "confirm" | "dismiss" | "read") {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch(`/api/products/${slug}/notices/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      if (!res.ok) {
        const reply = (await res.json().catch(() => null)) as { error?: string } | null;
        setProblem(reply?.error ?? "That didn't work. Try again.");
        return;
      }
      router.refresh();
    } catch {
      setProblem("That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="owner-notice-actions">
      {held ? (
        <>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void answer("confirm")}>
            Confirm and send
          </button>
          <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void answer("dismiss")}>
            Dismiss
          </button>
        </>
      ) : (
        <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void answer("read")}>
          Clear
        </button>
      )}
      {problem ? (
        <p className="muted small" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
