"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

/**
 * One report's admin actions on /admin/reports (TRUST_REPORTS): close, dismiss or reopen it, take its product down or
 * undo that, and ban or unban the product's owner. A takedown and a ban ask for a reason, which only admins see.
 */
export function AdminReportActions(props: {
  reportId: string;
  status: string;
  slug: string | null;
  takenDown: boolean;
  ownerId: string | null;
  ownerBanned: boolean;
}) {
  const router = useRouter();
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(url: string, method: "POST" | "DELETE", body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error && /\s/.test(data.error) ? data.error : `That didn't work (${res.status}).`);
      } else {
        // A takedown or ban is done even when Vercel refused to pause the site. Say so, since the site may still be up.
        const data = (await res.json().catch(() => ({}))) as { result?: { link?: string } | null; products?: Array<{ slug: string; link?: string }> };
        const sites = [...(data.result ? [{ slug: props.slug ?? "", link: data.result.link }] : []), ...(data.products ?? [])];
        const stuck = sites.filter((s) => s.link?.includes("failed"));
        if (stuck.length) setError(`Done, but Vercel didn't pause ${stuck.map((s) => s.slug).join(", ")}: ${stuck[0]!.link}. Check the site by hand.`);
        router.refresh();
      }
    } catch {
      setError("Couldn't reach Muse Muse.");
    }
    setBusy(false);
  }

  const needReason = () => {
    if (reason.trim()) return true;
    setError("Write a reason first.");
    return false;
  };
  const report = `/api/admin/reports/${props.reportId}`;

  return (
    <div className="form" style={{ gap: 8 }}>
      <div className="row-actions">
        {props.status === "open" ? (
          <>
            <button type="button" className="btn btn-outline" disabled={busy} onClick={() => call(report, "POST", { status: "closed" })}>
              Close
            </button>
            <button type="button" className="btn btn-outline" disabled={busy} onClick={() => call(report, "POST", { status: "dismissed" })}>
              Dismiss
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-outline" disabled={busy} onClick={() => call(report, "POST", { status: "open" })}>
            Reopen
          </button>
        )}
      </div>
      {props.slug ? (
        <>
          <div className="field">
            <label htmlFor={reasonId}>Reason for a takedown or ban</label>
            <input id={reasonId} type="text" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="row-actions">
            {props.takenDown ? (
              <button type="button" className="btn btn-outline" disabled={busy} onClick={() => call(`/api/admin/products/${props.slug}/takedown`, "DELETE")}>
                Undo takedown
              </button>
            ) : (
              <button type="button" className="btn btn-outline" disabled={busy} onClick={() => needReason() && call(`/api/admin/products/${props.slug}/takedown`, "POST", { reason })}>
                Take down
              </button>
            )}
            {props.ownerId ? (
              props.ownerBanned ? (
                <button type="button" className="btn btn-outline" disabled={busy} onClick={() => call(`/api/admin/users/${props.ownerId}/ban`, "DELETE")}>
                  Lift ban
                </button>
              ) : (
                <button type="button" className="btn btn-outline" disabled={busy} onClick={() => needReason() && call(`/api/admin/users/${props.ownerId}/ban`, "POST", { reason })}>
                  Ban owner
                </button>
              )
            ) : null}
          </div>
        </>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
