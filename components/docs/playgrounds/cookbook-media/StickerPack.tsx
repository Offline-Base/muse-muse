"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { CodeView, ErrorBox, JsonTree, ModelSelect, ResponseView, RunButton } from "@/components/docs/kit";
import { useDocsPage } from "@/components/docs/kit/DocsPageContext";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { Field, TextInput, Toggle } from "@/components/docs/kit/Field";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { MaskOverlay } from "@/components/docs/media/MaskOverlay";
import "@/components/docs/media/mask-decoder";
import { useObjectUrl } from "@/components/docs/media/hooks";
import styles from "@/components/docs/playgrounds/cookbook-media/cookbook-media.module.css";
import { encodeGif } from "@/components/docs/playgrounds/cookbook-media/gif";
import { samRunOutcome } from "@/components/docs/playgrounds/cookbook-media/sam-summary";
import { capFrameRate, motionBetween, packManifest, pickWindows, smoothCrops, stickerLength, tracksOf, WINDOW_SHARE, type Crop, type TrackInfo } from "@/components/docs/playgrounds/cookbook-media/sticker";
import { buildAnimatedWebp, describeAnimatedWebp } from "@/components/docs/playgrounds/cookbook-media/webp-anim";
import type { DocsError } from "@/lib/docs/client/api";
import { formatUsd } from "@/lib/docs/client/cost";
import { trimForRecord } from "@/lib/docs/client/record";
import { formatBytes } from "@/lib/docs/media/base64";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import { fileUploadFields, samRequest } from "@/lib/docs/media/requests";
import { SamStreamParser, samDelta, samTextOfResponse, type SamRecord } from "@/lib/docs/media/sam";
import { decodeMaskRaster } from "@/lib/docs/media/sam-mask";
import { samVideoCost } from "@/lib/docs/media/video";

export interface StickerPackProps {
  slug?: string;
  videoSampleId?: string;
  /** The subject, as one concrete noun ("dog", "cat", "bird"). */
  concept?: string;
  /** Sticker side in pixels (the recipe's are 512). */
  size?: number;
  maxFps?: number;
  /** Longest sticker, seconds. */
  maxSeconds?: number;
  /** Largest sticker file, bytes (the recipe keeps each under 500 KB). */
  maxBytes?: number;
}

interface Sticker {
  file: string;
  webp: Blob | null;
  gif: Blob;
  frames: number;
  fps: number;
  durationMs: number;
  quality: number | null;
  encoder: "webp" | "gif";
  from: number;
  to: number;
}

interface Pack {
  stickers: Sticker[];
  /** Set when the clip was too short for full-length stickers: each one's length, and the third it was cut from. */
  shortened: { seconds: number; thirdSeconds: number } | null;
  tray: Blob | null;
  sheet: Blob | null;
  contents: unknown;
  report: unknown;
}

/** Seconds with up to two decimals and no trailing zeros: 1.25, 2.5, 1. */
const seconds = (s: number) => String(Math.round(s * 100) / 100);

const EMOJI: Record<string, string> = { dog: "🐶", cat: "🐱", bird: "🐦", horse: "🐴", rabbit: "🐰", fish: "🐟" };

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function toBlob(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("The canvas couldn't be encoded."))), type, quality));
}

/** Seeks a video element and waits for the frame to be ready to draw. */
function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Seeking the clip timed out.")), 8000);
    const done = () => {
      window.clearTimeout(timer);
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    video.currentTime = time;
  });
}

async function openVideo(src: string): Promise<HTMLVideoElement> {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.src = src;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("The clip didn't load.")), 10000);
    v.onloadeddata = () => {
      window.clearTimeout(timer);
      resolve();
    };
    v.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error("This browser can't decode the clip."));
    };
  });
  return v;
}

/** A canvas with the mask's pixels white and opaque, transparent elsewhere: drawn with destination-in, it cuts out the subject. */
function maskCanvas(r: SamRecord): HTMLCanvasElement | null {
  const res = decodeMaskRaster(r.mask);
  if (!res.ok) return null;
  const c = canvas(r.mask.width, r.mask.height);
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(r.mask.width, r.mask.height);
  for (let i = 0; i < res.raster.length; i++) {
    if (!res.raster[i]) continue;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** One cutout frame: the crop of the source frame, scaled to `side`, with everything outside the mask transparent. */
function cutout(video: HTMLVideoElement, r: SamRecord, crop: Crop, side: number): HTMLCanvasElement {
  const out = canvas(side, side);
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  const scale = side / crop.side;
  const sx = crop.cx - crop.side / 2;
  const sy = crop.cy - crop.side / 2;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, -sx * scale, -sy * scale, video.videoWidth * scale, video.videoHeight * scale);
  const m = maskCanvas(r);
  ctx.globalCompositeOperation = "destination-in";
  if (m) ctx.drawImage(m, (r.box.x1 - sx) * scale, (r.box.y1 - sy) * scale, m.width * scale, m.height * scale);
  else ctx.clearRect(0, 0, side, side);
  ctx.globalCompositeOperation = "source-over";
  return out;
}

/**
 * The video-to-sticker-pack recipe in the browser: SAM 3.1 tracks every matching subject through the clip (uploaded
 * with purpose=user_data, then referenced by file_id), the longest-lived track is cut out of each frame with its
 * masks and a smoothed square crop, the highest-motion window in each third of the clip becomes a sticker, and the
 * stickers are encoded here as transparent animated WebP (with GIF previews, a tray icon, contents.json and a report).
 * SAM supplies identity and masks; everything after that is deterministic and calls no other model.
 */
export function StickerPack({
  videoSampleId = "street-pan",
  concept: initialConcept = "dog",
  size = 512,
  maxFps = 15,
  maxSeconds = 2.5,
  maxBytes = 500 * 1024,
}: StickerPackProps) {
  const id = useId();
  const runner = useDocsRun();
  const { recordRequest } = useDocsPage();
  const running = runner.state === "running";
  const [video, setVideo] = useState<PickedMedia | null>(null);
  const [concept, setConcept] = useState(initialConcept);
  const [upload, setUpload] = useState<{ fileId: string; file: PickedMedia } | null>(null);
  const [records, setRecords] = useState<SamRecord[]>([]);
  const [segmentedFor, setSegmentedFor] = useState<{ file: PickedMedia; concept: string } | null>(null);
  const [final, setFinal] = useState<unknown>(null);
  const [trackId, setTrackId] = useState<string | null>(null);
  const [pack, setPack] = useState<Pack | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [localError, setLocalError] = useState<DocsError | null>(null);
  const [showCode, setShowCode] = useState(false);
  const timings = useRef<Record<string, number>>({});
  const url = useObjectUrl(video?.blob ?? null);

  const tracks: TrackInfo[] = useMemo(() => tracksOf(records), [records]);
  const chosen = trackId ?? tracks[0]?.id ?? null;
  const fps = video?.fps ?? 24;
  const fresh = segmentedFor && segmentedFor.file === video && segmentedFor.concept === concept.trim();

  // Object URLs for the outputs: made in an effect (not during render), revoked when the pack changes.
  type Hrefs = {
    stickers: Array<{ webp: string | null; gif: string | null }>;
    tray: string | null;
    sheet: string | null;
    contents: string | null;
    report: string | null;
  };
  const [hrefs, setHrefs] = useState<Hrefs | null>(null);
  useEffect(() => {
    if (!pack) {
      setHrefs(null);
      return;
    }
    const made: string[] = [];
    const make = (b: Blob | null) => {
      if (!b) return null;
      const h = URL.createObjectURL(b);
      made.push(h);
      return h;
    };
    setHrefs({
      stickers: pack.stickers.map((s) => ({ webp: make(s.webp), gif: make(s.gif) })),
      tray: make(pack.tray),
      sheet: make(pack.sheet),
      contents: make(new Blob([JSON.stringify(pack.contents, null, 2)], { type: "application/json" })),
      report: make(new Blob([JSON.stringify(pack.report, null, 2)], { type: "application/json" })),
    });
    return () => made.forEach((h) => URL.revokeObjectURL(h));
  }, [pack]);

  const segment = async (): Promise<SamRecord[] | null> => {
    if (!video) return null;
    const noun = concept.trim();
    let fileId = upload && upload.file === video ? upload.fileId : null;
    if (!fileId) {
      setPhase("1 of 5: uploading the clip with purpose=user_data...");
      const t0 = performance.now();
      const form = new FormData();
      for (const [k, v] of fileUploadFields({})) form.append(k, v);
      form.append("file", video.blob, video.name);
      const res = await runner.run("files", { form });
      timings.current.upload_ms = Math.round(performance.now() - t0);
      const got = (res.json as { id?: unknown } | null)?.id;
      if (!res.ok || typeof got !== "string") return null;
      fileId = got;
      setUpload({ fileId, file: video });
    }
    setPhase(`2 of 5: SAM 3.1 is tracking every "${noun}" through the clip...`);
    const t1 = performance.now();
    // one_bit masks: several times smaller than the default lossless ones, and decoded to the same 0 and 1 raster
    // (sam/segmenting, "Choose a mask encoding", recommends them for video).
    const { path, body } = samRequest({ prompt: noun, media: { fileId }, kind: "video", stream: true, maskEncoding: "one_bit" });
    const parser = new SamStreamParser();
    let sawDelta = false;
    let last: unknown = null;
    setRecords([]);
    const res = await runner.run(path, {
      body,
      stream: true,
      onEvent: (e) => {
        const delta = samDelta(e.json);
        if (delta !== null) {
          sawDelta = true;
          if (parser.push(delta).length) setRecords(parser.output().records);
          return;
        }
        if (e.json?.type === "response.completed" || e.json?.type === "response.incomplete") {
          last = e.json.response ?? null;
          if (!sawDelta && last) parser.push(samTextOfResponse(last));
        }
      },
      // Recorded below with what SAM found, rather than the start of the wire text.
      record: false,
    });
    parser.end();
    timings.current.sam_ms = Math.round(performance.now() - t1);
    const out = parser.output().records;
    recordRequest({
      method: "POST",
      path,
      body: trimForRecord(body),
      status: res.status,
      outcome: samRunOutcome({ ok: res.ok, status: res.status, aborted: res.error?.code === "aborted", error: res.error?.message, media: "video", records: out }),
    });
    setRecords(out);
    setFinal(last);
    if (!res.ok) return null;
    setSegmentedFor({ file: video, concept: noun });
    setTrackId(null);
    return out;
  };

  const build = async (recs: SamRecord[], track: string) => {
    if (!video || !url) return;
    setBuilding(true);
    setLocalError(null);
    try {
      const t0 = performance.now();
      const mine = recs.filter((r) => r.objectId === track);
      const byFrame = new Map(mine.map((r) => [r.frame, r]));
      const crops = new Map(smoothCrops(recs, track).map((c) => [c.frame, c]));
      const kept = capFrameRate([...byFrame.keys()].sort((a, b) => a - b), fps, maxFps);
      const v = await openVideo(url);

      // A small pass first, to score motion on the cutout without holding every full-size frame.
      setPhase(`3 of 5: cutting the subject out of ${kept.frames.length} frames...`);
      const small: Uint8ClampedArray[] = [];
      for (const f of kept.frames) {
        await seek(v, (f + 0.5) / fps);
        const c = cutout(v, byFrame.get(f)!, crops.get(f)!, 64);
        small.push(c.getContext("2d")!.getImageData(0, 0, 64, 64).data);
      }
      const scores = small.map((px, i) => (i ? motionBetween(small[i - 1], px) : 0));
      const length = stickerLength(kept.frames.length, kept.fps, maxSeconds);
      const windows = pickWindows(scores, 3, length.frames);
      timings.current.cutout_ms = Math.round(performance.now() - t0);

      setPhase("4 of 5: encoding the highest-motion window of each third...");
      const t1 = performance.now();
      const stickers: Sticker[] = [];
      let tray: Blob | null = null;
      const sheetCanvas = canvas(size * windows.length, size);
      const sheetCtx = sheetCanvas.getContext("2d")!;
      let webpOk = true;
      for (const [k, w] of windows.entries()) {
        const frames = kept.frames.slice(w.start, w.end);
        const full: HTMLCanvasElement[] = [];
        for (const f of frames) {
          await seek(v, (f + 0.5) / fps);
          full.push(cutout(v, byFrame.get(f)!, crops.get(f)!, size));
        }
        const delay = 1000 / kept.fps;
        // Animated WebP from the browser's own WebP frames, lowering quality until it fits the size cap.
        let webp: Blob | null = null;
        let quality: number | null = null;
        if (webpOk) {
          for (const q of [0.82, 0.7, 0.58, 0.45, 0.32]) {
            const stills = await Promise.all(full.map((c) => toBlob(c, "image/webp", q)));
            if (stills.some((b) => b.type !== "image/webp")) {
              webpOk = false;
              break;
            }
            const bytes = buildAnimatedWebp({ width: size, height: size, frames: await Promise.all(stills.map(async (b) => new Uint8Array(await b.arrayBuffer()))), durationMs: delay });
            // Read the container back: every frame must be there, at the sticker's size.
            const check = describeAnimatedWebp(bytes);
            if (check.frames !== full.length || check.width !== size) throw new Error("The animated WebP didn't come out right.");
            webp = new Blob([bytes as BlobPart], { type: "image/webp" });
            quality = q;
            if (webp.size <= maxBytes) break;
          }
        }
        // The browser-friendly preview: a GIF at half size (one palette, one-bit transparency).
        const half = Math.round(size / 2);
        const gifFrames = full.map((c) => {
          const s = canvas(half, half);
          const sctx = s.getContext("2d", { willReadFrequently: true })!;
          sctx.drawImage(c, 0, 0, half, half);
          return { rgba: sctx.getImageData(0, 0, half, half).data, delayMs: delay };
        });
        const gif = new Blob([encodeGif(half, half, gifFrames) as BlobPart], { type: "image/gif" });
        const n = String(k + 1).padStart(2, "0");
        stickers.push({
          file: webp ? `sticker-${n}.webp` : `sticker-${n}.gif`,
          webp,
          gif,
          frames: frames.length,
          fps: kept.fps,
          durationMs: Math.round(frames.length * delay),
          quality,
          encoder: webp ? "webp" : "gif",
          from: frames[0],
          to: frames.at(-1)!,
        });
        const middle = full[Math.floor(full.length / 2)];
        sheetCtx.drawImage(middle, k * size, 0);
        if (!tray) {
          const t = canvas(96, 96);
          t.getContext("2d")!.drawImage(full[0], 0, 0, 96, 96);
          tray = await toBlob(t, "image/png");
        }
      }
      timings.current.encode_ms = Math.round(performance.now() - t1);
      const sheet = await toBlob(sheetCanvas, "image/png");
      const noun = concept.trim();
      const contents = packManifest({
        name: `${noun[0]?.toUpperCase() ?? ""}${noun.slice(1)} stickers`,
        stickers: stickers.map((s) => ({ file: s.file, emojis: [EMOJI[noun.toLowerCase()] ?? "✨"] })),
        tray: "tray.png",
      });
      const report = {
        source: { file: video.name, frames: video.frames ?? null, fps, width: video.width ?? null, height: video.height ?? null },
        object: noun,
        track: { object_id: track, frames: byFrame.size, chosen: trackId ? "picked" : "longest-lived" },
        frame_rate: { source_fps: fps, sticker_fps: kept.fps, every_nth_frame: kept.step },
        stickers: stickers.map((s) => ({
          file: s.file,
          source_frames: [s.from, s.to],
          frames: s.frames,
          duration_ms: s.durationMs,
          bytes: s.webp?.size ?? s.gif.size,
          encoding: s.encoder === "webp" ? `animated WebP, quality ${s.quality}` : "GIF (this browser can't encode WebP)",
          preview_bytes: s.gif.size,
        })),
        api_timings_ms: { upload: timings.current.upload_ms ?? 0, segmentation: timings.current.sam_ms ?? 0 },
        local_timings_ms: { cutout: timings.current.cutout_ms ?? 0, encode: timings.current.encode_ms ?? 0 },
        constraints: { size: `${size}x${size}`, max_fps: maxFps, max_seconds: maxSeconds, max_bytes: maxBytes },
        window: { frames: length.frames, seconds: Math.round((length.frames / kept.fps) * 100) / 100, shortened_for_short_clip: length.shortened },
      };
      setPack({
        stickers,
        tray,
        sheet,
        contents,
        report,
        shortened: length.shortened ? { seconds: length.frames / kept.fps, thirdSeconds: kept.frames.length / 3 / kept.fps } : null,
      });
      setPhase(null);
      if (!webpOk) setLocalError({ message: "This browser can't encode WebP, so the stickers are GIFs. Chrome, Edge and Firefox make animated WebP." });
    } catch (err) {
      setPhase(null);
      setLocalError({ message: err instanceof Error ? err.message : "Building the stickers failed." });
    } finally {
      setBuilding(false);
    }
  };

  const run = async () => {
    setPack(null);
    setLocalError(null);
    timings.current = {};
    const recs = fresh ? records : await segment();
    if (!recs) {
      setPhase(null);
      return;
    }
    const pick = tracksOf(recs)[0];
    if (!pick) {
      setPhase(null);
      setLocalError({ message: `SAM found no "${concept.trim()}" in this clip, which is a valid empty match. Try another noun.` });
      return;
    }
    await build(recs, trackId && recs.some((r) => r.objectId === trackId) ? trackId : pick.id);
  };

  const estimate = samVideoCost(video?.frames ?? 50);
  const busy = running || building;

  return (
    <div className={`pg ${styles.stack}`}>
      <div className="pg-bar">
        <ModelSelect kind="sam" value="sam-3.1" onChange={() => {}} />
      </div>
      <FilePicker
        label="Video (MP4 or MOV with H.264, H.265 or MPEG-4, up to 3 MB here)"
        accept="video/mp4,video/quicktime"
        value={video}
        onChange={setVideo}
        samples={["video"]}
        defaultSampleId={videoSampleId}
        forSam
        preview="compact"
        disabled={busy}
      />
      <Field id={`${id}-noun`} label="Subject" hint="One concrete noun, such as dog, cat, horse or bird. The street clip has two dogs.">
        <TextInput id={`${id}-noun`} value={concept} onChange={(e) => setConcept(e.target.value)} disabled={busy} />
      </Field>
      <div className={styles.row}>
        <RunButton running={busy} onRun={() => void run()} onStop={running ? runner.abort : undefined} label={fresh ? "Make the stickers again" : "Track and make stickers"} disabled={!video || !concept.trim() || (video?.problems.length ?? 0) > 0} />
        <span className={styles.note}>
          {fresh ? "Uses the tracks you already have: no new API call." : `SAM bills video per frame: about ${formatUsd(estimate)} for ${video?.frames ?? "these"} frames. The rest runs in your browser.`}
        </span>
      </div>
      {phase ? (
        <p className={styles.note} aria-live="polite">
          {phase}
        </p>
      ) : null}
      <ErrorBox error={localError ?? runner.error} />

      {tracks.length ? (
        <div className={`${styles.tight} pg-advanced`}>
          <label className={styles.control} htmlFor={`${id}-track`}>
            Track
            <span className="select-wrap">
              <select id={`${id}-track`} className="select pg-select" value={chosen ?? ""} disabled={busy} onChange={(e) => setTrackId(e.target.value)}>
                {tracks.map((t, i) => (
                  <option key={t.id} value={t.id}>
                    {concept.trim()} {t.id}: {t.frames} frames ({t.first} to {t.last}){i === 0 ? ", longest-lived" : ""}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <p className={styles.note}>
            The recipe uses the track present in the most frames (ties go to the bigger subject); pick another the way its --track-id does, then make the
            stickers again without another call.
          </p>
        </div>
      ) : null}

      {video && url ? (
        <MaskOverlay src={url} media="video" records={fresh ? records.filter((r) => r.objectId === chosen) : records} fps={fps} frames={video.frames} label={concept.trim()} alt={video.description} />
      ) : null}

      {running || runner.result ? (
        <ResponseView result={runner.result} running={running} elapsedMs={runner.elapsedMs} model="sam-3.1" json={final ?? runner.result?.json ?? undefined} usage={(final as { usage?: unknown } | null)?.usage ?? undefined}>
          <p className={styles.note}>
            {records.length
              ? `${tracks.length} track${tracks.length === 1 ? "" : "s"} across ${new Set(records.map((r) => r.frame)).size} frames${running ? " so far" : ""}.`
              : running
                ? "Waiting for the first frame..."
                : "No frames came back."}
          </p>
        </ResponseView>
      ) : null}

      {pack && hrefs ? (
        <section className={styles.stack} aria-label="Sticker pack">
          <span className="pg-section-label">The pack: one sticker from each third of the clip</span>
          {pack.shortened ? (
            <p className={styles.note}>
              Each third of this clip is {pack.shortened.thirdSeconds.toFixed(1)} s, too short for the recipe&apos;s {maxSeconds} s stickers, so each one is{" "}
              {seconds(pack.shortened.seconds)} s: short enough that the motion score still picks the busiest window inside its third. A clip of{" "}
              {Math.ceil((maxSeconds * 3) / WINDOW_SHARE)} s or more gets full-length stickers.
            </p>
          ) : null}
          <div className={styles.stickers}>
            {pack.stickers.map((s, i) => {
              const h = hrefs.stickers[i];
              return (
                <figure key={s.file} className={styles.sticker}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className={styles.checker} src={h.webp ?? h.gif ?? ""} alt={`Sticker ${i + 1}: the ${concept.trim()} cut out, frames ${s.from} to ${s.to}`} />
                  <span>
                    {s.file}: {s.frames} frames at {Math.round(s.fps * 10) / 10} fps, {seconds(s.durationMs / 1000)} s, {formatBytes(s.webp?.size ?? s.gif.size)}
                    {s.webp && s.webp.size > maxBytes ? " (over the 500 KB cap even at the lowest quality)" : ""}
                  </span>
                  <span className={styles.downloads}>
                    {h.webp ? (
                      <a className="btn btn-outline btn-sm" href={h.webp} download={s.file}>
                        <Icon name="download" size={16} />
                        WebP
                      </a>
                    ) : null}
                    {h.gif ? (
                      <a className="btn btn-outline btn-sm" href={h.gif} download={`sticker-${String(i + 1).padStart(2, "0")}-preview.gif`}>
                        <Icon name="download" size={16} />
                        GIF preview
                      </a>
                    ) : null}
                  </span>
                </figure>
              );
            })}
          </div>
          <div className={styles.downloads}>
            {hrefs.tray ? (
              <a className="btn btn-outline btn-sm" href={hrefs.tray} download="tray.png">
                <Icon name="download" size={16} />
                tray.png (96 x 96)
              </a>
            ) : null}
            {hrefs.sheet ? (
              <a className="btn btn-outline btn-sm" href={hrefs.sheet} download="pack-preview.png">
                <Icon name="download" size={16} />
                pack-preview.png
              </a>
            ) : null}
            {hrefs.contents ? (
              <a className="btn btn-outline btn-sm" href={hrefs.contents} download="contents.json">
                <Icon name="download" size={16} />
                contents.json
              </a>
            ) : null}
            {hrefs.report ? (
              <a className="btn btn-outline btn-sm" href={hrefs.report} download="report.json">
                <Icon name="download" size={16} />
                report.json
              </a>
            ) : null}
          </div>
          <details className={styles.details}>
            <summary>report.json</summary>
            <JsonTree value={pack.report} openDepth={2} />
          </details>
        </section>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? (
        <div className={styles.stack}>
          <CodeView
            method="POST"
            path="files"
            form={[...fileUploadFields({}).map(([name, value]) => ({ name, value })), { name: "file", value: video?.name ?? "clip.mp4", file: { label: "Video", accept: "video/mp4" } }]}
            caption="1. Upload the clip"
          />
          <CodeView
            method="POST"
            path="responses"
            body={samRequest({ prompt: concept.trim() || "dog", media: { fileId: upload?.fileId ?? "file-abc123" }, kind: "video", stream: true, maskEncoding: "one_bit" }).body}
            stream
            caption="2. Track the subject, streamed, with compact one_bit masks"
          />
        </div>
      ) : null}
    </div>
  );
}
