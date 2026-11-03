"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { genericProblem, planFor, wordProblem } from "@/lib/train/sam/logic";
import type { SamData } from "@/lib/train/sam/types";

/** The one blue for actions (the Meta AI app look). Inline, so /fine-tuning/new gets no new stylesheet. */
const BLUE = "#0866ff";

/**
 * "Teach SAM 3.1 a new object" on /fine-tuning/new, for admins, only with SAM_TUNE on (docs/TRAINING.md): the new
 * word, the everyday words Meta's SAM 3.1 is compared with, which photos (the built-in Muse set, or the person's own
 * once SAM_TUNE uploads are in), and the plan card (lib/train/sam/logic.ts planFor: the board, minutes and Meta cost).
 * Start makes the run (POST /api/train/sam), puts a built-in run in the office board's queue (POST .../start) and opens
 * its room. A run on the person's photos opens as a draft, where they add the photos first. Uses the site's existing
 * classes and inline styles only, so the page's stylesheets don't change.
 */
export function SamNewCard({ uploads = false, maxUsd }: { uploads?: boolean; maxUsd: number }) {
  const id = useId();
  const router = useRouter();
  const [data, setData] = useState<SamData>("builtin-muse");
  const [word, setWord] = useState("muse");
  const [generic, setGeneric] = useState("plush toy");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const builtin = data === "builtin-muse";
  const asked = builtin ? "muse" : word.trim();
  const everyday = generic.trim().replace(/\s+/g, " ");
  const problem = wordProblem(asked) ?? genericProblem(everyday, asked);
  const plan = planFor({ data, photos: [] });

  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/train/sam", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ word: asked, generic: everyday, data, maxUsd }),
      });
      const made = (await res.json().catch(() => ({}))) as { run?: { id?: unknown }; message?: unknown };
      const runId = typeof made.run?.id === "string" ? made.run.id : null;
      if (!res.ok || !runId) {
        setError(typeof made.message === "string" ? made.message : "Couldn't make the run. Try again.");
        return;
      }
      if (builtin) {
        const queued = await fetch(`/api/train/sam/${runId}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        if (!queued.ok) {
          // The run exists as a draft: its room shows why and offers Start again.
          const why = (await queued.json().catch(() => ({}))) as { message?: unknown };
          if (typeof why.message === "string") setError(why.message);
        }
      }
      router.push(`/fine-tuning/sam/${runId}`);
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card train-new" id="new-sam-tune" aria-labelledby={`${id}-title`} style={{ maxWidth: "var(--composer-w, 768px)", margin: "24px auto 48px" }}>
      <div className="train-new-head">
        <h2 id={`${id}-title`} style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
          Teach SAM 3.1 a new object
        </h2>
        <p className="muted small" style={{ margin: "4px 0 0" }}>
          Tunes Meta&apos;s SAM 3.1 detector on the office board to find a new word, then scores it against Meta&apos;s own
          SAM 3.1 asked the everyday words and &quot;toy&quot;.
        </p>
      </div>
      <form className="train-form" onSubmit={start} noValidate>
        <div className="train-grid">
          <fieldset className="train-field train-field-wide" disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="train-label">Photos</legend>
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
              <input type="radio" name={`${id}-data`} value="builtin-muse" checked={builtin} onChange={() => setData("builtin-muse")} />
              Muse (built in): the Nov 3 Muse images, COCO teddy bears as look-alikes, the Nov 3 test photos
            </label>
            {uploads ? (
              <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                <input type="radio" name={`${id}-data`} value="uploads" checked={!builtin} onChange={() => setData("uploads")} />
                Your own photos of your own object
              </label>
            ) : null}
          </fieldset>
          <div className="train-field">
            <label className="train-label" htmlFor={`${id}-word`}>
              New word
            </label>
            <input
              id={`${id}-word`}
              className="train-input"
              value={asked}
              readOnly={builtin}
              disabled={busy}
              maxLength={24}
              autoComplete="off"
              onChange={(e) => setWord(e.target.value.toLowerCase())}
              aria-describedby={`${id}-word-help`}
            />
            <p className="train-help" id={`${id}-word-help`}>
              {builtin ? "The built-in photos are of Muse, so the word is muse." : "One word of lowercase letters."}
            </p>
          </div>
          <div className="train-field">
            <label className="train-label" htmlFor={`${id}-generic`}>
              Everyday words to compare with
            </label>
            <input
              id={`${id}-generic`}
              className="train-input"
              value={generic}
              disabled={busy}
              maxLength={24}
              autoComplete="off"
              onChange={(e) => setGeneric(e.target.value.toLowerCase())}
              aria-describedby={`${id}-generic-help`}
            />
            <p className="train-help" id={`${id}-generic-help`}>
              What Meta&apos;s SAM 3.1 is asked, like plush toy. &quot;toy&quot; is always asked too.
            </p>
          </div>
        </div>

        <div aria-label="Plan" style={{ border: "1px solid #e4e6eb", borderRadius: 16, padding: 16, margin: "16px 0" }}>
          <p style={{ margin: "0 0 6px", fontWeight: 600 }}>Plan</p>
          <ul style={{ margin: 0, paddingLeft: 20, lineHeight: "22px" }}>
            {plan.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
            <li>
              Capped at ${maxUsd.toFixed(2)} for the run. You can stop it until training ends.
            </li>
          </ul>
        </div>

        {problem && asked && everyday ? (
          <p className="train-field-error" role="alert">
            {problem}
          </p>
        ) : null}
        {error ? (
          <p className="train-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          className="btn"
          disabled={busy || Boolean(problem)}
          style={{ background: BLUE, color: "#fff" }}
        >
          {busy ? "Starting" : builtin ? "Start" : "Make the run"}
        </button>
      </form>
    </section>
  );
}
