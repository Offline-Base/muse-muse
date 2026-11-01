"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/icons";

/** Restore this version: says what it does, then starts a new build on top of the history and opens its room. */
export function RestoreVersion({ buildId, number }: { buildId: string; number: number }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/builds/${buildId}/restore`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { buildId?: string; error?: string };
      if (res.status === 201 && body.buildId) {
        router.push(`/b/${body.buildId}`);
        return;
      }
      // The route answers codes for these, and sentences for the rest.
      const codes: Record<string, string> = {
        busy: "Another build of this product is running. Try again when it ends.",
        not_shipped: "This product isn't live right now, so it can't be restored.",
        daily_limit: "You've used today's builds, and a restore counts as one. Try again tomorrow.",
        shared_limit: "Guests have used today's builds, and a restore counts as one. Try again tomorrow.",
        paused: "Building is paused for today. Try again tomorrow.",
      };
      const said = body.error ?? "";
      setError(codes[said] ?? (/^[a-z_]+$/.test(said) || !said ? "It couldn't be restored. Try again." : said));
    } catch {
      setError("It couldn't be restored. Check your connection and try again.");
    }
    setBusy(false);
  }

  if (!asking) {
    return (
      <button type="button" className="btn" onClick={() => setAsking(true)}>
        <Icon name="history" size={18} />
        <span>Restore this version</span>
      </button>
    );
  }
  return (
    <div className="code-restore">
      <p className="small">
        This deploys version {number}&apos;s files as a new version on top, so nothing in the history goes away. Saved data isn&apos;t rolled back, and the demo video stays as it is.
      </p>
      <div className="code-actions">
        <button type="button" className="btn btn-primary" onClick={restore} disabled={busy}>
          {busy ? "Starting" : `Restore version ${number}`}
        </button>
        <button type="button" className="btn" onClick={() => setAsking(false)} disabled={busy}>
          Cancel
        </button>
      </div>
      {error ? (
        <p className="small code-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
