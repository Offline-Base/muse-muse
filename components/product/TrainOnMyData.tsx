"use client";

import { useId, useState, type FormEvent } from "react";

/**
 * "Train on my data" on a product's page (docs/CAPABILITIES.md, section 17, decision 12), for its signed-in builder. Nothing
 * starts without the box ticked: it's the owner's explicit action, and it only ever reads their own rows.
 */
export function TrainOnMyData({ slug }: { slug: string }) {
  const id = useId();
  const [collections, setCollections] = useState("");
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const names = collections.split(",").map((c) => c.trim()).filter(Boolean);
      const res = await fetch(`/api/products/${slug}/train`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ collections: names, confirm: sure }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string; rows?: number };
      if (!res.ok) setError(body.error ?? "That didn't start. Try again.");
      else setDone(body.message ?? `Training started on ${body.rows ?? "your"} rows. It takes about an hour, and the product keeps answering with Muse Wonder until its model passes.`);
    } catch {
      setError("That didn't reach the site. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  async function forget() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch(`/api/products/${slug}/train`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) setError(body.error ?? "That didn't delete anything. Try again.");
      else setDone(body.message ?? "Deleted.");
    } catch {
      setError("That didn't reach the site. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <h3>Train on my data</h3>
      <p className="muted">Trains a small Muse Glimmer on one GPU from rows saved as yours in this product. Never from what anyone else saved, and never from a collection that can hold personal details. Your rows stay private: they don't show on the Lab pages. It can be wrong, and it only answers during demo windows.</p>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-collections`}>Collections, with commas</label>
        <input id={`${id}-collections`} value={collections} onChange={(e) => setCollections(e.target.value)} />
      </div>
      <label>
        <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> Use my rows in these collections to train this model.
      </label>
      <div className="row-actions">
        <button type="submit" className="btn btn-outline btn-sm" disabled={busy || !sure || !collections.trim()}>Train</button>
        <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void forget()}>Delete what training kept</button>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {done ? <p role="status">{done}</p> : null}
    </form>
  );
}
