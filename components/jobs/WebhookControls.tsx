"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CopyField } from "@/components/CopyButton";

/** Make, replace or remove one webhook. Its address, secret and all, shows here once and is never kept in the clear. */
export function WebhookControls({ slug, name, active }: { slug: string; name: string; active: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  async function call(method: "POST" | "DELETE") {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch(`/api/products/${slug}/webhooks${method === "DELETE" ? `?name=${encodeURIComponent(name)}` : ""}`, {
        method,
        ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) } : {}),
      });
      const reply = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok) {
        setProblem(reply?.error ?? "That didn't work. Try again.");
        return;
      }
      setUrl(reply?.url ?? null);
      router.refresh();
    } catch {
      setProblem("That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field-block">
      {url ? (
        <>
          <CopyField value={url} label={`Address for ${name}`} />
          <p className="muted small">This shows only once. Anyone with it can start this job, so keep it private.</p>
        </>
      ) : null}
      <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void call("POST")}>
        {active ? "Replace address" : "Make address"}
      </button>{" "}
      {active ? (
        <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void call("DELETE")}>
          Remove
        </button>
      ) : null}
      {problem ? (
        <p className="muted small" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
