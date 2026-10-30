"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import styles from "@/components/docs/media/media.module.css";
import type { PixelShape } from "@/lib/docs/media/grounding";
import {
  boxFromCorners,
  objectIds,
  recordsByFrame,
  toMediaPixels,
  type SamPromptObject,
  type SamRecord,
} from "@/lib/docs/media/sam";
import "@/components/docs/media/mask-decoder";
import { decodeMaskRaster, rasterToRgba } from "@/lib/docs/media/sam-mask";

export type PromptTool = "box" | "point" | "negative";

export interface MaskOverlayProps {
  /** The image or video the results belong to: an object URL or a path on our origin. */
  src: string;
  media: "image" | "video";
  /** SAM 3.1 records. For a video, every frame's; the overlay draws the current frame's. */
  records?: readonly SamRecord[];
  /** Other shapes in media pixels, such as Muse Spark's perception grounding boxes and points. */
  shapes?: readonly PixelShape[];
  /** Video only: frames per second, to turn playback time into SAM's frame numbers. Defaults to 30. */
  fps?: number;
  /** Video only: the clip's frame count, for the frame slider. */
  frames?: number;
  /** A name for every object, such as the concept prompt ("dog"). */
  label?: string;
  /** Names per object id, overriding `label`. */
  labels?: Readonly<Record<string, string>>;
  alt?: string;
  /** Box and point prompts to draw (sam/segmenting, Prompt with boxes and points). */
  prompts?: readonly SamPromptObject[];
  /** Turns drawing on: drag a box, click a point, or click a negative point. */
  tool?: PromptTool | null;
  /** The object id new prompts belong to. */
  activeObjectId?: number;
  onPromptsChange?(prompts: SamPromptObject[]): void;
  /** The current frame (0 for an image), as it changes. */
  onFrame?(frame: number): void;
  /** The media's pixel size, once it loads. Prompts and SAM's w and h use it. */
  onMediaSize?(size: { width: number; height: number }): void;
}

/** Fallbacks for the theme's chart colors, which a canvas can't read as var(). */
const FALLBACK = ["#7489f7", "#f2b97c", "#5bbfa3", "#ec8a9e", "#9aa8b6", "#b99af0", "#e5c84a", "#4fb3d9"];

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0x7489f7;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function paletteFrom(el: Element | null): string[] {
  if (!el || typeof getComputedStyle !== "function") return FALLBACK;
  const css = getComputedStyle(el);
  return FALLBACK.map((fallback, i) => {
    const v = i < 6 ? css.getPropertyValue(`--chart-${i + 1}`).trim() : "";
    return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
  });
}

function formatConfidence(c: number | undefined): string {
  return c === undefined ? "" : c.toFixed(2);
}

/**
 * Draws segmentation over an image or the current video frame: SAM 3.1's boxes and masks with per-object colors,
 * labels and confidence, plus any grounding shapes and the reader's own box and point prompts. The legend toggles
 * objects; for video, a frame bar steps through SAM's frames. Mask pixels need a decoder (lib/docs/media/sam-mask.ts);
 * without one the boxes, which are exact, are drawn alone and the overlay says so.
 */
export function MaskOverlay({
  src,
  media,
  records = [],
  shapes = [],
  fps = 30,
  frames,
  label,
  labels,
  alt,
  prompts = [],
  tool = null,
  activeObjectId = 1,
  onPromptsChange,
  onFrame,
  onMediaSize,
}: MaskOverlayProps) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const masks = useRef(new Map<string, HTMLCanvasElement>());
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [frame, setFrame] = useState(0);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [show, setShow] = useState({ masks: true, boxes: true, labels: true });
  const [drag, setDrag] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null);
  // The theme's chart colors, read once mounted so the canvas and the legend use the same ones.
  const [palette, setPalette] = useState<string[]>(FALLBACK);
  useEffect(() => setPalette(paletteFrom(stage.current)), []);

  const byFrame = useMemo(() => recordsByFrame(records), [records]);
  const ids = useMemo(() => objectIds(records), [records]);
  const groups = useMemo(() => [...new Set(shapes.map((s) => s.group ?? s.label ?? ""))], [shapes]);
  const lastFrame = useMemo(() => {
    const seen = records.reduce((m, r) => Math.max(m, r.frame), 0);
    return Math.max(seen, (frames ?? 0) - 1, 0);
  }, [records, frames]);

  const maskStatus = useMemo(() => {
    let pending = 0;
    let invalid = 0;
    for (const r of records) {
      const res = decodeMaskRaster(r.mask);
      if (!res.ok && res.reason === "no_decoder") pending++;
      else if (!res.ok) invalid++;
    }
    return { pending, invalid };
  }, [records]);

  const colorOf = useCallback((key: string) => palette[Math.max(0, ids.indexOf(key)) % palette.length], [ids, palette]);

  const draw = useCallback(() => {
    const c = canvas.current;
    if (!c || !size) return;
    const rect = c.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(rect.width * dpr);
    c.height = Math.round(rect.height * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    const sx = c.width / size.width;
    const sy = c.height / size.height;
    const line = Math.max(2, Math.round(2 * dpr));
    const font = Math.round(12 * dpr);

    const tag = (text: string, x: number, y: number, color: string) => {
      ctx.font = `600 ${font}px system-ui, sans-serif`;
      const w = ctx.measureText(text).width + 10 * dpr;
      const h = font + 8 * dpr;
      const top = y - h < 0 ? y : y - h;
      ctx.fillStyle = color;
      ctx.fillRect(x, top, w, h);
      ctx.fillStyle = "#111112";
      ctx.fillText(text, x + 5 * dpr, top + h - 6 * dpr);
    };

    const current = media === "image" ? (byFrame.get(0) ?? records) : (byFrame.get(frame) ?? []);
    for (const r of current) {
      if (hidden.has(r.objectId)) continue;
      const color = colorOf(r.objectId);
      const x = r.box.x1 * sx;
      const y = r.box.y1 * sy;
      const w = (r.box.x2 - r.box.x1 + 1) * sx;
      const h = (r.box.y2 - r.box.y1 + 1) * sy;
      if (show.masks) {
        const res = decodeMaskRaster(r.mask);
        if (res.ok) {
          const key = `${color}|${r.mask.payload}`;
          let off = masks.current.get(key);
          if (!off) {
            off = document.createElement("canvas");
            off.width = r.mask.width;
            off.height = r.mask.height;
            const octx = off.getContext("2d");
            const [cr, cg, cb] = hexToRgb(color);
            octx?.putImageData(new ImageData(rasterToRgba(res.raster, r.mask.width, r.mask.height, [cr, cg, cb, 120]), r.mask.width, r.mask.height), 0, 0);
            if (masks.current.size > 500) masks.current.clear();
            masks.current.set(key, off);
          }
          // The raster is the box's own size and sits on the box (sam/reading-segmentation, Boxes and masks).
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(off, x, y, w, h);
        }
      }
      if (show.boxes) {
        ctx.lineWidth = line;
        ctx.strokeStyle = color;
        ctx.strokeRect(x, y, w, h);
      }
      if (show.labels) {
        const name = labels?.[r.objectId] ?? label ?? "Object";
        const conf = formatConfidence(r.box.confidence);
        tag(`${name} ${r.objectId}${conf ? ` · ${conf}` : ""}`, x, y, color);
      }
    }

    shapes.forEach((s) => {
      const group = s.group ?? s.label ?? "";
      const color = palette[(ids.length + groups.indexOf(group)) % palette.length];
      if (s.kind === "box") {
        const x = s.x1 * sx;
        const y = s.y1 * sy;
        if (show.boxes) {
          ctx.lineWidth = line;
          ctx.strokeStyle = color;
          ctx.strokeRect(x, y, (s.x2 - s.x1) * sx, (s.y2 - s.y1) * sy);
        }
        if (show.labels && s.label) tag(s.label, x, y, color);
      } else {
        ctx.beginPath();
        ctx.arc(s.x * sx, s.y * sy, 6 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = Math.max(1, dpr);
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
        if (show.labels && s.label) tag(s.label, s.x * sx + 8 * dpr, s.y * sy, color);
      }
    });

    const onFrameNow = media === "image" ? 0 : frame;
    for (const p of prompts) {
      if ((p.frame ?? 0) !== onFrameNow) continue;
      const color = palette[p.id % palette.length];
      if (p.box) {
        ctx.setLineDash([6 * dpr, 4 * dpr]);
        ctx.lineWidth = line;
        ctx.strokeStyle = color;
        ctx.strokeRect(p.box.x1 * sx, p.box.y1 * sy, (p.box.x2 - p.box.x1 + 1) * sx, (p.box.y2 - p.box.y1 + 1) * sy);
        ctx.setLineDash([]);
        tag(`prompt ${p.id}`, p.box.x1 * sx, p.box.y1 * sy, color);
      }
      for (const pt of p.points ?? []) {
        const cx = (pt.x + 0.5) * sx;
        const cy = (pt.y + 0.5) * sy;
        ctx.beginPath();
        ctx.arc(cx, cy, 7 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = pt.negative ? "#b42318" : color;
        ctx.fill();
        ctx.lineWidth = Math.max(1, 1.5 * dpr);
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
        ctx.fillStyle = "#ffffff";
        ctx.font = `700 ${Math.round(11 * dpr)}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(pt.negative ? "-" : "+", cx, cy + 4 * dpr);
        ctx.textAlign = "start";
      }
    }

    if (drag) {
      const b = boxFromCorners(drag.a, drag.b);
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.lineWidth = line;
      ctx.strokeStyle = "#ffffff";
      ctx.strokeRect(b.x1 * sx, b.y1 * sy, (b.x2 - b.x1 + 1) * sx, (b.y2 - b.y1 + 1) * sy);
      ctx.setLineDash([]);
    }
  }, [size, media, byFrame, records, frame, hidden, show, colorOf, labels, label, shapes, ids, groups, prompts, drag, palette]);

  useEffect(() => {
    draw();
  }, [draw]);

  // Redraw when the stage changes size (window resize, sidebar, zoom).
  useEffect(() => {
    const el = stage.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(el);
    return () => ro.disconnect();
  }, [draw]);

  // Follow playback: the frame index is the playback time times the frame rate.
  useEffect(() => {
    const v = video.current;
    if (media !== "video" || !v) return;
    let handle = 0;
    let stopped = false;
    const read = () => {
      const f = Math.min(lastFrame, Math.max(0, Math.floor(v.currentTime * fps + 1e-3)));
      setFrame((old) => (old === f ? old : f));
    };
    const loop = () => {
      read();
      if (stopped || v.paused || v.ended) return;
      const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
      handle = rvfc ? rvfc.call(v, loop) : window.requestAnimationFrame(loop);
    };
    v.addEventListener("play", loop);
    v.addEventListener("seeked", read);
    v.addEventListener("timeupdate", read);
    return () => {
      stopped = true;
      window.cancelAnimationFrame(handle);
      v.removeEventListener("play", loop);
      v.removeEventListener("seeked", read);
      v.removeEventListener("timeupdate", read);
    };
  }, [media, fps, lastFrame, src]);

  useEffect(() => {
    onFrame?.(media === "image" ? 0 : frame);
  }, [frame, media, onFrame]);

  const loaded = (width: number, height: number) => {
    if (!width || !height) return;
    setSize((old) => (old && old.width === width && old.height === height ? old : { width, height }));
    onMediaSize?.({ width, height });
  };

  const seek = (f: number) => {
    const v = video.current;
    const next = Math.min(lastFrame, Math.max(0, f));
    setFrame(next);
    if (v) {
      v.pause();
      v.currentTime = (next + 0.5) / fps;
    }
  };

  const pointToMedia = (e: PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return toMediaPixels({ x: e.clientX, y: e.clientY }, rect, size ?? { width: 1, height: 1 });
  };

  const addPrompt = (change: (o: SamPromptObject) => SamPromptObject) => {
    if (!onPromptsChange) return;
    const at = media === "image" ? 0 : frame;
    const list = [...prompts];
    const i = list.findIndex((p) => p.id === activeObjectId && (p.frame ?? 0) === at);
    const base: SamPromptObject = i >= 0 ? list[i] : { id: activeObjectId, frame: at };
    const next = change(base);
    if (i >= 0) list[i] = next;
    else list.push(next);
    onPromptsChange(list);
  };

  const drawing = !!tool && !!onPromptsChange && !!size;
  const visibleIds = ids;
  return (
    <div className={styles.overlay}>
      <div className={styles.stage} ref={stage}>
        {media === "image" ? (
          <img className={styles.stageMedia} src={src} alt={alt ?? "Segmented image"} onLoad={(e) => loaded(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
        ) : (
          <video
            ref={video}
            className={styles.stageMedia}
            src={src}
            controls={!drawing}
            muted
            playsInline
            preload="auto"
            aria-label={alt ?? "Segmented video"}
            onLoadedMetadata={(e) => loaded(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
          />
        )}
        <canvas
          ref={canvas}
          className={styles.stageCanvas}
          data-drawing={drawing ? "true" : undefined}
          aria-hidden="true"
          onPointerDown={(e) => {
            if (!drawing) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            const p = pointToMedia(e);
            setDrag({ a: p, b: p });
          }}
          onPointerMove={(e) => {
            if (!drawing || !drag || tool !== "box") return;
            setDrag({ a: drag.a, b: pointToMedia(e) });
          }}
          onPointerUp={(e) => {
            if (!drawing || !drag) return;
            const end = pointToMedia(e);
            const moved = Math.abs(end.x - drag.a.x) + Math.abs(end.y - drag.a.y);
            setDrag(null);
            if (tool === "box") {
              if (moved >= 4) addPrompt((o) => ({ ...o, box: boxFromCorners(drag.a, end) }));
            } else {
              addPrompt((o) => ({ ...o, points: [...(o.points ?? []), { x: end.x, y: end.y, negative: tool === "negative" }] }));
            }
          }}
          onPointerCancel={() => setDrag(null)}
        />
      </div>

      {media === "video" ? (
        <div className={styles.frameBar}>
          <button type="button" className="icon-btn icon-btn-plain icon-btn-sm" onClick={() => seek(frame - 1)} aria-label="Previous frame">
            {"<"}
          </button>
          <input
            type="range"
            min={0}
            max={lastFrame}
            value={frame}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Frame"
          />
          <button type="button" className="icon-btn icon-btn-plain icon-btn-sm" onClick={() => seek(frame + 1)} aria-label="Next frame">
            {">"}
          </button>
          <span>
            Frame {frame} of {lastFrame} ({fps} fps){byFrame.has(frame) ? "" : records.length ? ", nothing found on this frame" : ""}
          </span>
        </div>
      ) : null}

      {visibleIds.length || groups.length ? (
        <div className={styles.spread}>
          <ul className={styles.legend} aria-label="Objects">
            {visibleIds.map((id) => {
              const mine = records.filter((r) => r.objectId === id);
              const here = mine.find((r) => r.frame === (media === "image" ? r.frame : frame)) ?? mine[0];
              const conf = here?.box.confidence;
              const on = !hidden.has(id);
              return (
                <li key={id}>
                  <button
                    type="button"
                    className={styles.legendItem}
                    aria-pressed={on}
                    title={on ? "Hide this object" : "Show this object"}
                    onClick={() =>
                      setHidden((h) => {
                        const next = new Set(h);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return next;
                      })
                    }
                  >
                    <span className={styles.swatch} style={{ background: colorOf(id) }} aria-hidden="true" />
                    {labels?.[id] ?? label ?? "Object"} {id}
                    {conf !== undefined ? ` · ${formatConfidence(conf)}` : ""}
                    {media === "video" ? ` · ${new Set(mine.map((r) => r.frame)).size} frames` : ""}
                  </button>
                </li>
              );
            })}
            {groups.map((g, i) => (
              <li key={`g-${g}`}>
                <span className={styles.legendItem}>
                  <span className={styles.swatch} style={{ background: palette[(ids.length + i) % palette.length] }} aria-hidden="true" />
                  {g || "Shape"} ({shapes.filter((s) => (s.group ?? s.label ?? "") === g).length})
                </span>
              </li>
            ))}
          </ul>
          <div className={styles.options}>
            {(["masks", "boxes", "labels"] as const).map((k) => (
              <label key={k} className={styles.check}>
                <input type="checkbox" checked={show[k]} onChange={(e) => setShow((s) => ({ ...s, [k]: e.target.checked }))} />
                {k[0].toUpperCase() + k.slice(1)}
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {records.length && maskStatus.pending ? (
        <p className={styles.note}>
          SAM sent a mask with every box, but the mask decoder isn&apos;t loaded, so the overlay shows the exact
          boxes. Raw wire shows the mask payloads.
        </p>
      ) : null}
      {maskStatus.invalid ? <p className={styles.problem}>{maskStatus.invalid} mask payloads didn&apos;t decode.</p> : null}
    </div>
  );
}
