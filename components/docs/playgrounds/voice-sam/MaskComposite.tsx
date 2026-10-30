"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Segmented } from "@/components/docs/kit/Field";
import "@/components/docs/media/mask-decoder";
import media from "@/components/docs/media/media.module.css";
import { maskAreaPx } from "@/components/docs/playgrounds/voice-sam/sam-wire";
import styles from "@/components/docs/playgrounds/voice-sam/voice-sam.module.css";
import { decodeMaskRaster, rasterArea } from "@/lib/docs/media/sam-mask";
import type { SamRecord } from "@/lib/docs/media/sam";

/**
 * What media-segmentation says to build with the masks, done on the page from the reply: cut the objects out, blur
 * everything else, or measure each one (its box, the pixels its mask covers and its share of the image) and count
 * them. Masks decode with Meta's parser (components/docs/media/mask-decoder.ts); each raster sits on its record's box
 * (sam/reading-segmentation, "Boxes and masks").
 */

export type CompositeMode = "cutout" | "blur" | "measure";

export function MaskComposite({
  src,
  records,
  width,
  height,
  label,
  modes = ["cutout", "blur", "measure"],
}: {
  /** The image the records belong to: an object URL or a path on our origin. */
  src: string;
  /** One image's records (frame 0). */
  records: readonly SamRecord[];
  width: number;
  height: number;
  label?: string;
  modes?: CompositeMode[];
}) {
  const id = useId();
  const [mode, setMode] = useState<CompositeMode>(modes[0] ?? "cutout");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const canvas = useRef<HTMLCanvasElement>(null);
  const shown = useMemo(() => records.filter((r) => !hidden.has(r.objectId)), [records, hidden]);

  const rows = useMemo(
    () =>
      records.map((r) => {
        const res = decodeMaskRaster(r.mask);
        const set = res.ok ? rasterArea(res.raster) : null;
        const area = set === null ? null : maskAreaPx(r, set);
        return {
          r,
          ok: res.ok,
          area,
          share: area === null ? null : area / (width * height),
          boxW: r.box.x2 - r.box.x1 + 1,
          boxH: r.box.y2 - r.box.y1 + 1,
          fill: area === null ? null : area / ((r.box.x2 - r.box.x1 + 1) * (r.box.y2 - r.box.y1 + 1)),
        };
      }),
    [records, width, height],
  );

  useEffect(() => {
    if (mode === "measure") return;
    const c = canvas.current;
    if (!c) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      c.width = width;
      c.height = height;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      // The union of the selected masks at full size, each raster drawn on its box.
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = width;
      maskCanvas.height = height;
      const mctx = maskCanvas.getContext("2d");
      if (!mctx) return;
      for (const r of shown) {
        const res = decodeMaskRaster(r.mask);
        if (!res.ok) continue;
        const piece = document.createElement("canvas");
        piece.width = r.mask.width;
        piece.height = r.mask.height;
        const pctx = piece.getContext("2d");
        if (!pctx) continue;
        const data = new Uint8ClampedArray(r.mask.width * r.mask.height * 4);
        for (let i = 0; i < res.raster.length; i++) if (res.raster[i]) data[i * 4 + 3] = 255;
        pctx.putImageData(new ImageData(data, r.mask.width, r.mask.height), 0, 0);
        mctx.drawImage(piece, r.box.x1, r.box.y1, r.box.x2 - r.box.x1 + 1, r.box.y2 - r.box.y1 + 1);
      }
      ctx.clearRect(0, 0, width, height);
      if (mode === "blur") {
        ctx.filter = `blur(${Math.max(6, Math.round(width / 90))}px)`;
        ctx.drawImage(img, 0, 0, width, height);
        ctx.filter = "none";
      }
      const sharp = document.createElement("canvas");
      sharp.width = width;
      sharp.height = height;
      const sctx = sharp.getContext("2d");
      if (!sctx) return;
      sctx.drawImage(img, 0, 0, width, height);
      sctx.globalCompositeOperation = "destination-in";
      sctx.drawImage(maskCanvas, 0, 0);
      ctx.drawImage(sharp, 0, 0);
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [mode, shown, src, width, height]);

  const name = label || "Object";
  return (
    <section className={styles.stack} aria-label="What you can build with the masks">
      <div className={styles.row}>
        <span className={styles.label}>Build with the masks</span>
        <Segmented<CompositeMode>
          size="sm"
          label="Use the masks"
          value={mode}
          onChange={setMode}
          options={modes.map((m) => ({ value: m, label: m === "cutout" ? "Cut out" : m === "blur" ? "Blur the background" : "Measure and count" }))}
        />
      </div>
      <ul className={media.legend} aria-label="Objects to include">
        {records.map((r) => {
          const on = !hidden.has(r.objectId);
          return (
            <li key={`${r.frame}-${r.objectId}`}>
              <button
                type="button"
                className={media.legendItem}
                aria-pressed={on}
                onClick={() =>
                  setHidden((h) => {
                    const next = new Set(h);
                    if (next.has(r.objectId)) next.delete(r.objectId);
                    else next.add(r.objectId);
                    return next;
                  })
                }
              >
                {name} {r.objectId}
              </button>
            </li>
          );
        })}
      </ul>
      {mode === "measure" ? (
        <>
          <p className={styles.note} aria-live="polite">
            {records.length} {records.length === 1 ? "instance" : "instances"} of {label ? `"${label}"` : "the prompt"}. Areas are the mask&apos;s
            set pixels; the box only bounds them.
          </p>
          <div className={media.tableWrap}>
            <table className={media.table}>
              <thead>
                <tr>
                  <th scope="col">Object</th>
                  <th scope="col">Box (x1, y1) to (x2, y2)</th>
                  <th scope="col">Box size</th>
                  <th scope="col">Mask area</th>
                  <th scope="col">Of the image</th>
                  <th scope="col">Fills its box</th>
                  <th scope="col">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ r, area, share, boxW, boxH, fill }) => (
                  <tr key={`${r.frame}-${r.objectId}`}>
                    <td>
                      {name} {r.objectId}
                    </td>
                    <td className={styles.mono}>
                      ({r.box.x1}, {r.box.y1}) to ({r.box.x2}, {r.box.y2})
                    </td>
                    <td className={styles.mono}>
                      {boxW} x {boxH}
                    </td>
                    <td className={styles.mono}>{area === null ? "mask didn't decode" : `${area.toLocaleString("en-US")} px`}</td>
                    <td className={styles.mono}>{share === null ? "" : `${(share * 100).toFixed(1)}%`}</td>
                    <td className={styles.mono}>{fill === null ? "" : `${(fill * 100).toFixed(0)}%`}</td>
                    <td className={styles.mono}>{r.box.confidence !== undefined ? r.box.confidence.toFixed(3) : "not requested"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <div className={styles.canvasWrap}>
            <canvas ref={canvas} id={`${id}-composite`} role="img" aria-label={mode === "cutout" ? `The ${shown.length} selected objects cut out on a transparent background` : `The photo with everything but the ${shown.length} selected objects blurred`} />
          </div>
          <p className={styles.note}>
            {mode === "cutout"
              ? "Only the mask pixels are kept; the checkerboard is transparency. This is the cut-out an editor would composite."
              : "Everything outside the masks is blurred, the way a portrait mode or a privacy filter would."}
          </p>
        </>
      )}
    </section>
  );
}
