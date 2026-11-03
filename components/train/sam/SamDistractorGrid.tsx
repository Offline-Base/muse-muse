"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { postJson, sendPhoto } from "@/components/train/sam/upload";
import { LOOKALIKE_BATCH, LOOKALIKE_USD } from "@/lib/train/sam/distractors";
import { SAM_TUNE_LIMITS, type SamDistractor } from "@/lib/train/sam/types";

/**
 * SAM_TUNE, a run on the person's own photos: the look-alikes, other things of the same kind that the tune should not
 * call by the person's word. Muse Image makes them up after the person's training photos ($0.01 each, 4 a round), or
 * the person adds their own photos of other ones. Drop any that look too much like the real thing.
 */

interface Props {
  runId: string;
  word: string;
  generic: string;
  distractors: SamDistractor[];
  /** Training photos with a checked box: Muse Image draws after them, so it waits for at least one. */
  referenceCount: number;
  onChange?: (distractors: SamDistractor[]) => void;
}

export function SamDistractorGrid({ runId, word, generic, distractors: initial, referenceCount, onChange }: Props) {
  const [items, setItems] = useState<SamDistractor[]>(initial);
  const [busy, setBusy] = useState<"make" | "upload" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(items);
  latest.current = items;

  const update = (next: SamDistractor[]) => {
    latest.current = next;
    setItems(next);
    onChange?.(next);
  };
  const kept = items.filter((d) => d.kept).length;
  const room = SAM_TUNE_LIMITS.distractorsMax - items.length;
  const round = Math.min(LOOKALIKE_BATCH, Math.max(0, room));

  async function make() {
    setBusy("make");
    setNote(null);
    const res = await postJson(`/api/train/sam/${runId}/distractors`, { count: round });
    setBusy(null);
    if (!res.ok) return setNote(res.message);
    const out = res.body as { made: SamDistractor[]; skipped: string[]; message?: string };
    update([...latest.current, ...out.made]);
    const missed = out.skipped.length;
    setNote(
      out.message ??
        (missed ? `Made ${out.made.length}. ${missed} didn't come out; try again for more.` : `Made ${out.made.length}.`),
    );
  }

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).slice(0, Math.max(0, room));
    e.target.value = "";
    if (!files.length) return;
    setBusy("upload");
    setNote(null);
    for (const file of files) {
      const res = await sendPhoto(runId, file, "lookalike");
      if (!res.ok) {
        setNote(res.message);
        break;
      }
      update([...latest.current, res.body.distractor as SamDistractor]);
    }
    setBusy(null);
  }

  async function toggle(d: SamDistractor) {
    update(latest.current.map((x) => (x.url === d.url ? { ...x, kept: !d.kept } : x)));
    const res = await postJson(`/api/train/sam/${runId}/distractors`, { url: d.url, kept: !d.kept }, "PATCH");
    if (!res.ok) {
      setNote(res.message);
      update(latest.current.map((x) => (x.url === d.url ? { ...x, kept: d.kept } : x)));
    }
  }

  return (
    <section className="train-form sam-lookalikes" aria-labelledby={`sam-lookalikes-${runId}`}>
      <div className="train-label-row">
        <h3 id={`sam-lookalikes-${runId}`} className="train-label">
          Look-alikes
        </h3>
        <span className="train-count num">
          {kept} kept, {SAM_TUNE_LIMITS.distractorsMin} to {SAM_TUNE_LIMITS.distractorsMax} needed
        </span>
      </div>
      <p className="train-help">
        Other {generic}s that aren&rsquo;t your {word}, so the tune learns to stay quiet for them. Muse Image makes them up after your photos, or add
        photos of real ones. Drop any that look too much like your {word}.
      </p>
      <div className="train-foot">
        <button type="button" className="btn btn-primary" disabled={busy !== null || round === 0 || referenceCount === 0} onClick={make}>
          {busy === "make" ? "Making look-alikes..." : `Make ${round} with Muse Image (about $${(round * LOOKALIKE_USD).toFixed(2)})`}
        </button>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={onPick} />
        <button type="button" className="btn btn-outline" disabled={busy !== null || room <= 0} onClick={() => input.current?.click()}>
          {busy === "upload" ? "Adding photos..." : "Add your own"}
        </button>
        {referenceCount === 0 && <span className="muted small">Check at least one training photo&rsquo;s box first.</span>}
      </div>
      {note && (
        <p className="train-help" role="status">
          {note}
        </p>
      )}
      <ul className="sam-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12, listStyle: "none", padding: 0 }}>
        {items.map((d, i) => (
          <li key={d.url} style={{ opacity: d.kept ? 1 : 0.45 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={d.url} alt={`Look-alike ${i + 1}`} style={{ width: "100%", display: "block", borderRadius: 8 }} />
            <div className="muted small" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
              <span>
                {d.source === "muse-image" ? "Made up, Muse Image" : "Your photo"} · {d.split === "held" ? "Test" : "Training"}
              </span>
              <button type="button" className="btn btn-outline" disabled={busy !== null} onClick={() => toggle(d)}>
                {d.kept ? "Drop" : "Keep"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
