"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Segmented } from "@/components/docs/kit/Field";
import styles from "@/components/docs/playgrounds/cookbook-media/cookbook-media.module.css";
import { aspectDiffers, compareSize, diffImages, type DiffResult } from "@/components/docs/playgrounds/cookbook-media/image-diff";

export interface CompareImage {
  src: string;
  label: string;
}

type Mode = "side" | "wipe" | "diff";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The image didn't load."));
    img.src = src;
  });
}

/**
 * An edit next to what it edited, the editing recipe's check ("compare the output with the source image to identify
 * changes in other areas"): side by side, a wipe across the two, or a heat map of where the pixels changed. Muse Image
 * re-renders the whole frame, so small texture changes are everywhere; the threshold keeps only real changes.
 */
export function ImageCompare({ before, after }: { before: CompareImage; after: CompareImage }) {
  const id = useId();
  const [mode, setMode] = useState<Mode>("side");
  const [wipe, setWipe] = useState(50);
  const [threshold, setThreshold] = useState(32);
  const [diff, setDiff] = useState<(DiffResult & { width: number; height: number; skewed: boolean }) | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const heat = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (mode !== "diff") return;
    let live = true;
    setProblem(null);
    void (async () => {
      try {
        const [a, b] = await Promise.all([loadImage(before.src), loadImage(after.src)]);
        if (!live) return;
        const size = compareSize({ width: a.naturalWidth, height: a.naturalHeight });
        const draw = (img: HTMLImageElement) => {
          const c = document.createElement("canvas");
          c.width = size.width;
          c.height = size.height;
          const ctx = c.getContext("2d", { willReadFrequently: true });
          if (!ctx) throw new Error("This browser can't draw to a canvas.");
          ctx.drawImage(img, 0, 0, size.width, size.height);
          return ctx.getImageData(0, 0, size.width, size.height).data;
        };
        const result = diffImages(draw(a), draw(b), size.width, size.height, threshold);
        if (!live) return;
        setDiff({ ...result, ...size, skewed: aspectDiffers({ width: a.naturalWidth, height: a.naturalHeight }, { width: b.naturalWidth, height: b.naturalHeight }) });
        const bc = base.current;
        const hc = heat.current;
        if (bc && hc) {
          bc.width = hc.width = size.width;
          bc.height = hc.height = size.height;
          const bctx = bc.getContext("2d");
          if (bctx) {
            bctx.filter = "grayscale(1) opacity(0.6)";
            bctx.drawImage(b, 0, 0, size.width, size.height);
          }
          hc.getContext("2d")?.putImageData(new ImageData(result.heat, size.width, size.height), 0, 0);
        }
      } catch (err) {
        if (live) setProblem(err instanceof Error ? err.message : "Couldn't compare these images.");
      }
    })();
    return () => {
      live = false;
    };
  }, [mode, before.src, after.src, threshold]);

  return (
    <div className={styles.compare}>
      <div className={styles.spread}>
        <Segmented<Mode>
          size="sm"
          label="Compare"
          value={mode}
          onChange={setMode}
          options={[
            { value: "side", label: "Side by side" },
            { value: "wipe", label: "Wipe" },
            { value: "diff", label: "What changed" },
          ]}
        />
        {mode === "wipe" ? (
          <label className={styles.control} htmlFor={`${id}-wipe`}>
            Wipe
            <input id={`${id}-wipe`} type="range" min={0} max={100} value={wipe} onChange={(e) => setWipe(Number(e.target.value))} />
          </label>
        ) : mode === "diff" ? (
          <label className={styles.control} htmlFor={`${id}-th`}>
            Ignore changes under
            <input id={`${id}-th`} type="range" min={8} max={96} step={4} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
            <span className={styles.mono}>{threshold}</span>
          </label>
        ) : null}
      </div>
      {mode === "side" ? (
        <div className={styles.sideBySide}>
          <figure>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={before.src} alt={before.label} />
            <figcaption>{before.label}</figcaption>
          </figure>
          <figure>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={after.src} alt={after.label} />
            <figcaption>{after.label}</figcaption>
          </figure>
        </div>
      ) : mode === "wipe" ? (
        <div className={styles.tight}>
          <div className={styles.wipe}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={after.src} alt={after.label} />
            <div className={styles.wipeTop} style={{ width: `${wipe}%` }}>
              {/* The before image keeps the stage's full width, so the two line up under the wipe. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={before.src} alt={before.label} style={{ width: `${10000 / Math.max(1, wipe)}%`, maxWidth: "none" }} />
            </div>
            <span className={styles.wipeLine} style={{ left: `${wipe}%` }} aria-hidden="true" />
          </div>
          <p className={styles.note}>
            Left of the line: {before.label}. Right of it: {after.label}.
          </p>
        </div>
      ) : (
        <div className={styles.tight}>
          <div className={styles.diffStage}>
            <canvas ref={base} aria-hidden="true" />
            <canvas ref={heat} role="img" aria-label={`Where ${after.label} differs from ${before.label}, in red`} />
          </div>
          <p className={styles.note} aria-live="polite">
            {problem
              ? problem
              : diff
                ? `${Math.round(diff.share * 1000) / 10}% of the frame changed noticeably (red, over the result in grey).` +
                  (!diff.bounds
                    ? " Nothing changed beyond re-render noise."
                    : (diff.bounds.x2 - diff.bounds.x1) / diff.width > 0.9 && (diff.bounds.y2 - diff.bounds.y1) / diff.height > 0.9
                      ? " Thin red outlines are edges the re-render moved by a pixel or two; solid areas are real changes."
                      : ` The changes span x ${Math.round((diff.bounds.x1 / diff.width) * 100)}% to ${Math.round((diff.bounds.x2 / diff.width) * 100)}% and y ${Math.round((diff.bounds.y1 / diff.height) * 100)}% to ${Math.round((diff.bounds.y2 / diff.height) * 100)}% of the frame.`) +
                  (diff.skewed ? " The two images have different shapes, so this compare is approximate." : "")
                : "Comparing..."}
          </p>
        </div>
      )}
    </div>
  );
}
