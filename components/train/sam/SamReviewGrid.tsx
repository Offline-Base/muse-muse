"use client";

import { useRef, useState, type ChangeEvent, type PointerEvent } from "react";
import { postJson, sendPhoto } from "@/components/train/sam/upload";
import { LABEL_BATCH, LABEL_PHOTO_USD, type CocoBox } from "@/lib/train/sam/label";
import { SAM_TUNE_LIMITS, type SamPhoto } from "@/lib/train/sam/types";

/**
 * SAM_TUNE, a run on the person's own photos: add photos of the object, let hosted SAM 3.1 find a first box in each
 * (asked the everyday word, $0.0025 a photo), then check every box. Drag on a photo to draw its box again, or skip it.
 * Only checked boxes go to the board. Every third photo is kept aside for the test, and the grid says which.
 */

interface Props {
  runId: string;
  word: string;
  generic: string;
  photos: SamPhoto[];
  /** Told after every change, so the room can redraw its Start checks. */
  onChange?: (photos: SamPhoto[]) => void;
}

type Drag = { url: string; x: number; y: number; x2: number; y2: number };

function money(usd: number): string {
  return usd < 0.1 ? `$${usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}` : `$${usd.toFixed(2)}`;
}

export function SamReviewGrid({ runId, word, generic, photos: initial, onChange }: Props) {
  const [photos, setPhotos] = useState<SamPhoto[]>(initial);
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({});
  const [busy, setBusy] = useState<"upload" | "label" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const update = (next: SamPhoto[]) => {
    setPhotos(next);
    onChange?.(next);
  };
  const patchLocal = (url: string, patch: Partial<SamPhoto>) => update(photosRef().map((p) => (p.url === url ? { ...p, ...patch } : p)));
  // The latest list inside async loops, which outlive one render.
  const latest = useRef(photos);
  latest.current = photos;
  const photosRef = () => latest.current;

  const waiting = photos.filter((p) => !p.box && !p.skipped).length;
  const boxed = photos.filter((p) => p.box && !p.skipped);
  const held = boxed.filter((p) => p.split === "held").length;
  const room = SAM_TUNE_LIMITS.photosMax - photos.length;

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).slice(0, Math.max(0, room));
    e.target.value = "";
    if (!files.length) return;
    setBusy("upload");
    setNote(null);
    let added = 0;
    for (const file of files) {
      const res = await sendPhoto(runId, file, "photo");
      if (!res.ok) {
        setNote(res.message);
        break;
      }
      latest.current = [...photosRef(), res.body.photo as SamPhoto];
      update(latest.current);
      added += 1;
    }
    setBusy(null);
    if (added) setNote(`Added ${added} ${added === 1 ? "photo" : "photos"}.`);
  }

  async function findBoxes() {
    setBusy("label");
    setNote(null);
    for (;;) {
      const res = await postJson(`/api/train/sam/${runId}/label`, {});
      if (!res.ok) {
        setNote(res.message);
        break;
      }
      const out = res.body as { labeled: Array<{ url: string; box: CocoBox | null; skipped: boolean }>; left: number; failed: number; message?: string };
      let next = photosRef();
      for (const l of out.labeled) next = next.map((p) => (p.url === l.url ? { ...p, box: l.box, skipped: l.skipped } : p));
      latest.current = next;
      update(next);
      if (out.message) {
        setNote(out.message);
        break;
      }
      if (out.left === 0 || (out.labeled.length === 0 && out.failed > 0)) {
        if (out.failed) setNote(`SAM 3.1 couldn't look at ${out.failed} ${out.failed === 1 ? "photo" : "photos"}. Try again, or draw those boxes yourself.`);
        break;
      }
    }
    setBusy(null);
  }

  async function save(url: string, box: CocoBox | null, skipped: boolean) {
    const before = photosRef().find((p) => p.url === url);
    patchLocal(url, { box, skipped });
    const res = await postJson(`/api/train/sam/${runId}/label`, { url, box, skipped }, "PATCH");
    if (!res.ok) {
      setNote(res.message);
      if (before) patchLocal(url, { box: before.box, skipped: before.skipped });
    }
  }

  // Drawing a box: pointer positions in the shown image, turned into the photo's own pixels.
  const point = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  function endDrag(url: string) {
    const size = sizes[url];
    const d = drag;
    setDrag(null);
    if (!d || d.url !== url || !size) return;
    const x = Math.round(Math.min(d.x, d.x2) * size.w);
    const y = Math.round(Math.min(d.y, d.y2) * size.h);
    const w = Math.round(Math.abs(d.x2 - d.x) * size.w);
    const h = Math.round(Math.abs(d.y2 - d.y) * size.h);
    if (w < 2 || h < 2) return;
    void save(url, [x, y, w, h], false);
  }

  return (
    <section className="train-form sam-review" aria-labelledby={`sam-review-${runId}`}>
      <div className="train-label-row">
        <h3 id={`sam-review-${runId}`} className="train-label">
          Photos of your {word}
        </h3>
        <span className="train-count num">
          {boxed.length} with a box, {held} kept aside for the test
        </span>
      </div>
      <p className="train-help">
        Add {SAM_TUNE_LIMITS.photosMin} to {SAM_TUNE_LIMITS.photosMax} photos of it in different places. SAM 3.1 finds a first box in each, asked
        &ldquo;{generic}&rdquo;. Check every one: drag on a photo to draw its box again, or skip it. Every third photo is kept aside to test the tune.
      </p>
      <div className="train-foot">
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={onPick} />
        <button type="button" className="btn btn-outline" disabled={busy !== null || room <= 0} onClick={() => input.current?.click()}>
          {busy === "upload" ? "Adding photos..." : "Add photos"}
        </button>
        <button type="button" className="btn btn-primary" disabled={busy !== null || waiting === 0} onClick={findBoxes}>
          {busy === "label"
            ? "Finding boxes..."
            : `Find boxes with SAM 3.1 (${waiting} ${waiting === 1 ? "photo" : "photos"}, about ${money(waiting * LABEL_PHOTO_USD)})`}
        </button>
        <span className="muted small">Up to {LABEL_BATCH} photos a round. Capped per run and per day.</span>
      </div>
      {note && (
        <p className="train-help" role="status">
          {note}
        </p>
      )}
      <ul className="sam-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12, listStyle: "none", padding: 0 }}>
        {photos.map((p, i) => {
          const size = sizes[p.url];
          const live = drag?.url === p.url ? drag : null;
          const box = live
            ? { left: Math.min(live.x, live.x2), top: Math.min(live.y, live.y2), width: Math.abs(live.x2 - live.x), height: Math.abs(live.y2 - live.y) }
            : p.box && size
              ? { left: p.box[0] / size.w, top: p.box[1] / size.h, width: p.box[2] / size.w, height: p.box[3] / size.h }
              : null;
          return (
            <li key={p.url} style={{ opacity: p.skipped ? 0.45 : 1 }}>
              <div
                style={{ position: "relative", touchAction: "none", cursor: "crosshair", userSelect: "none" }}
                onPointerDown={(e) => {
                  if (busy || !size) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const at = point(e);
                  setDrag({ url: p.url, x: at.x, y: at.y, x2: at.x, y2: at.y });
                }}
                onPointerMove={(e) => {
                  if (drag?.url !== p.url) return;
                  const at = point(e);
                  setDrag({ ...drag, x2: at.x, y2: at.y });
                }}
                onPointerUp={() => endDrag(p.url)}
                onPointerCancel={() => setDrag(null)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.url}
                  alt={`Photo ${i + 1} of your ${word}`}
                  draggable={false}
                  style={{ width: "100%", display: "block", borderRadius: 8 }}
                  onLoad={(e) => {
                    const img = e.currentTarget;
                    setSizes((s) => ({ ...s, [p.url]: { w: img.naturalWidth, h: img.naturalHeight } }));
                  }}
                />
                {box && !p.skipped && (
                  <span
                    aria-hidden
                    style={{
                      position: "absolute",
                      left: `${box.left * 100}%`,
                      top: `${box.top * 100}%`,
                      width: `${box.width * 100}%`,
                      height: `${box.height * 100}%`,
                      border: "2px solid #0866ff",
                      borderRadius: 4,
                      pointerEvents: "none",
                    }}
                  />
                )}
              </div>
              <div className="muted small" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                <span>
                  {p.split === "held" ? "Test" : "Training"} · {p.skipped ? "Skipped" : p.box ? "Box checked" : "No box yet"}
                </span>
                <button type="button" className="btn btn-outline" disabled={busy !== null} onClick={() => save(p.url, p.box, !p.skipped)}>
                  {p.skipped ? "Use it" : "Skip"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
