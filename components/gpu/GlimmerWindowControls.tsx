"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

/** Open or close a demo window on /admin/glimmer. Opening one starts a GPU, so it says what it could cost first. */
export function GlimmerWindowControls(props: { adapters: Array<{ jobId: string; title: string }>; openWindowId: string | null }) {
  const router = useRouter();
  const id = useId();
  const [adapter, setAdapter] = useState(props.adapters[0]?.jobId ?? "");
  const [minutes, setMinutes] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(url: string, method: "POST" | "DELETE", body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
      if (!res.ok) {
        const got = (await res.json().catch(() => ({}))) as { error?: string };
        setError(got.error ?? "That didn't work. Try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("That didn't reach the site. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  if (props.openWindowId) {
    return (
      <div className="row-actions">
        <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void call(`/api/admin/glimmer/windows/${props.openWindowId}`, "DELETE")}>
          Close this window
        </button>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
    );
  }
  if (!props.adapters.length) return <p className="muted">No trained adapter can be served yet.</p>;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (window.confirm("This starts a GPU that bills until the window ends or you close it. Open it?")) void call("/api/admin/glimmer/windows", "POST", { adapterJobId: adapter, minutes: Number(minutes) });
      }}
    >
      <div className="field">
        <label className="field-label" htmlFor={`${id}-adapter`}>Adapter</label>
        <select id={`${id}-adapter`} value={adapter} onChange={(e) => setAdapter(e.target.value)}>
          {props.adapters.map((a) => (
            <option key={a.jobId} value={a.jobId}>{a.title}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-minutes`}>Minutes</label>
        <input id={`${id}-minutes`} type="number" min={10} max={120} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
      </div>
      <div className="row-actions">
        <button type="submit" className="btn" disabled={busy}>Open a window</button>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </form>
  );
}
