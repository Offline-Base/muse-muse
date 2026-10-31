"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent } from "react";
import { CameraCapture, useCameraSupported } from "@/components/camera/CameraCapture";
import { Icon, type IconName } from "@/components/icons";
import styles from "@/components/docs/media/media.module.css";
import { loadSample, useObjectUrl } from "@/components/docs/media/hooks";
import { acceptKinds, matchesAccept } from "@/lib/docs/media/accept";
import { formatBytes } from "@/lib/docs/media/base64";
import { formatDuration } from "@/lib/docs/media/audio";
import { prepareFile, type PickedMedia, type PrepareMode } from "@/lib/docs/media/prepare";
import { DOCS_SAMPLES, sampleById, type DocsSample, type SampleKind } from "@/lib/docs/media/samples";

const KINDS: readonly SampleKind[] = ["image", "video", "audio", "pdf", "text"];
const KIND_ICON: Record<SampleKind, IconName> = { image: "image", video: "film", audio: "mic", pdf: "doc", text: "file" };
/** Samples the "Try it live" simple view shows; the rest wait behind Options, except the one in use. */
const SIMPLE_SAMPLES = 4;

export interface FilePickerProps {
  /** The file input's accept list, such as "image/*" or "audio/*,.wav". It also decides which samples are offered. */
  accept: string;
  value: PickedMedia | null;
  onChange(file: PickedMedia | null): void;
  label?: string;
  hint?: string;
  /**
   * Samples to offer: true (the default) for every sample `accept` allows, false for none, or a list of sample
   * kinds or sample ids from lib/docs/media/samples.ts.
   */
  samples?: boolean | readonly string[];
  /** Load this sample on mount when nothing is picked, so Run works right away. */
  defaultSampleId?: string;
  /** How to prepare the file. Defaults from its kind: images downscale, audio becomes 16 kHz WAV, video is checked. */
  prepare?: PrepareMode;
  /** The most a file may be after preparing. Defaults to 3 MB. */
  maxBytes?: number;
  /** Check video codecs against what SAM 3.1 takes. */
  forSam?: boolean;
  maxAudioSeconds?: number;
  /** "full" shows the image, video or audio player; "compact" a thumbnail only. */
  preview?: "full" | "compact";
  disabled?: boolean;
}

function sampleList(accept: string, samples: FilePickerProps["samples"]): DocsSample[] {
  if (samples === false) return [];
  if (Array.isArray(samples) && samples.length) {
    const kinds = samples.filter((s): s is SampleKind => (KINDS as readonly string[]).includes(s));
    if (kinds.length === samples.length) return DOCS_SAMPLES.filter((s) => kinds.includes(s.kind));
    return samples.map((id) => sampleById(id)).filter((s): s is DocsSample => !!s);
  }
  const kinds = acceptKinds(accept);
  return DOCS_SAMPLES.filter((s) => kinds.includes(s.kind));
}

function metaLine(f: PickedMedia): string {
  const parts = [formatBytes(f.bytes)];
  if (f.width && f.height) parts.push(`${f.width} x ${f.height}`);
  if (f.durationMs) parts.push(formatDuration(f.durationMs));
  if (f.fps && f.kind === "video") parts.push(`${f.fps} fps`);
  return parts.join(" · ");
}

/**
 * Picks the file a demo sends: drop it, choose it, or pick one of our samples for the kind `accept` allows. Shows a
 * preview with its size, and prepares it (downscale, WAV conversion, video checks) before handing it over.
 */
export function FilePicker({
  accept,
  value,
  onChange,
  label,
  hint,
  samples,
  defaultSampleId,
  prepare,
  maxBytes,
  forSam,
  maxAudioSeconds,
  preview = "full",
  disabled,
}: FilePickerProps) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const loadedDefault = useRef(false);
  // A sample can still be loading when the picker goes away (a preset swaps it); its result is dropped then.
  const alive = useRef(true);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const offered = useMemo(() => sampleList(accept, samples), [accept, samples]);
  const [cameraOpen, setCameraOpen] = useState(false);
  const canUseCamera = useCameraSupported() && acceptKinds(accept).includes("image");
  const url = useObjectUrl(value?.blob ?? null);

  const take = useCallback(
    async (file: Blob & { name?: string }, sample: DocsSample | null) => {
      setError(null);
      if (!sample && !matchesAccept({ type: file.type, name: file.name }, accept)) {
        setError(`${file.name || "That file"} isn't a type this demo takes (${accept}).`);
        return;
      }
      setBusy(sample?.id ?? "upload");
      try {
        const picked = await prepareFile(file, { prepare, sample, maxBytes, forSam, maxAudioSeconds });
        if (alive.current) onChange(picked);
      } catch (err) {
        if (alive.current) setError(err instanceof Error ? err.message : "Couldn't read that file.");
      } finally {
        if (alive.current) setBusy(null);
      }
    },
    [accept, prepare, maxBytes, forSam, maxAudioSeconds, onChange],
  );

  const pickSample = useCallback(
    async (sample: DocsSample) => {
      setBusy(sample.id);
      try {
        await take(await loadSample(sample), sample);
      } catch (err) {
        if (!alive.current) return;
        setError(err instanceof Error ? err.message : "Couldn't load that sample.");
        setBusy(null);
      }
    },
    [take],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (loadedDefault.current || value || !defaultSampleId) return;
    const sample = sampleById(defaultSampleId);
    if (!sample) return;
    loadedDefault.current = true;
    void pickSample(sample);
  }, [defaultSampleId, value, pickSample]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && !disabled) void take(file, null);
  };

  return (
    <div className={styles.picker}>
      {label ? (
        <label className={styles.label} htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <div
        className={styles.drop}
        data-dragging={dragging ? "true" : undefined}
        onDragEnter={(e) => {
          e.preventDefault();
          depth.current++;
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (!depth.current) setDragging(false);
        }}
        onDrop={onDrop}
      >
        <span className={styles.dropIcon} aria-hidden="true">
          <Icon name="arrowUp" size={18} />
        </span>
        <span className={styles.dropText}>
          Drop a file here, or{" "}
          <button type="button" className="link-btn" onClick={() => input.current?.click()} disabled={disabled || !!busy}>
            choose one
          </button>
          {canUseCamera ? (
            <>
              , or{" "}
              <button type="button" className="link-btn" onClick={() => setCameraOpen(true)} disabled={disabled || !!busy}>
                take a photo
              </button>
            </>
          ) : null}
          {busy === "upload" ? " (preparing...)" : null}
        </span>
        <input
          ref={input}
          id={inputId}
          className={styles.fileInput}
          type="file"
          accept={accept}
          disabled={disabled}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void take(file, null);
          }}
        />
      </div>
      {canUseCamera ? (
        <CameraCapture
          open={cameraOpen}
          onClose={() => setCameraOpen(false)}
          onCapture={(file) => {
            setCameraOpen(false);
            void take(file, null);
          }}
        />
      ) : null}
      {offered.length ? (
        <div className={styles.samples} role="group" aria-label="Samples">
          {offered.map((s, i) => (
            <button
              key={s.id}
              type="button"
              className={i >= SIMPLE_SAMPLES && value?.sampleId !== s.id ? `${styles.sample} pg-advanced` : styles.sample}
              aria-pressed={value?.sampleId === s.id}
              title={s.description}
              disabled={disabled || !!busy}
              onClick={() => void pickSample(s)}
            >
              {s.thumb ? (
                <img className={styles.sampleThumb} src={s.thumb} alt="" loading="lazy" decoding="async" />
              ) : (
                <span className={styles.sampleThumb} aria-hidden="true">
                  <Icon name={KIND_ICON[s.kind]} size={15} />
                </span>
              )}
              {busy === s.id ? "Loading..." : s.label}
            </button>
          ))}
        </div>
      ) : null}
      {value ? <Picked file={value} url={url} preview={preview} onRemove={disabled ? undefined : () => onChange(null)} /> : null}
      {hint ? <p className={`${styles.hint} pg-advanced`}>{hint}</p> : null}
      {error ? (
        <p className={styles.problem} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Picked({
  file,
  url,
  preview,
  onRemove,
}: {
  file: PickedMedia;
  url: string | null;
  preview: "full" | "compact";
  onRemove?: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (file.kind !== "text") return;
    let live = true;
    void file.blob
      .slice(0, 1200)
      .text()
      .then((t) => live && setText(t));
    return () => {
      live = false;
    };
  }, [file]);

  const thumb =
    file.kind === "image" && url ? (
      <img className={styles.pickedThumb} src={url} alt="" />
    ) : (
      <span className={styles.pickedThumb} aria-hidden="true">
        <Icon name={KIND_ICON[file.kind]} size={22} />
      </span>
    );

  return (
    <div className={styles.picked}>
      <div className={styles.pickedHead}>
        {preview === "compact" || file.kind !== "image" ? thumb : null}
        <div className={styles.pickedBody}>
          <span className={styles.pickedName}>{file.name}</span>
          <span className={styles.pickedMeta}>
            {metaLine(file)}
            {file.source === "sample" ? " · sample" : file.source === "recording" ? " · recording" : ""}
          </span>
        </div>
        {onRemove ? (
          <button type="button" className="icon-btn icon-btn-plain icon-btn-sm" onClick={onRemove} aria-label={`Remove ${file.name}`}>
            <Icon name="close" size={16} />
          </button>
        ) : null}
      </div>
      {preview === "full" && url ? (
        file.kind === "image" ? (
          <img className={styles.mediaPreview} src={url} alt={file.description ?? file.name} />
        ) : file.kind === "video" ? (
          <video className={styles.mediaPreview} src={url} controls muted playsInline preload="metadata" />
        ) : file.kind === "audio" ? (
          <audio className={styles.audioPreview} src={url} controls preload="metadata" />
        ) : null
      ) : null}
      {file.kind === "text" && text !== null ? <pre className={styles.textPreview}>{text}</pre> : null}
      {file.note ? <p className={`${styles.note} pg-advanced`}>{file.note}</p> : null}
      {file.problems.map((p) => (
        <p key={p} className={styles.problem}>
          {p}
        </p>
      ))}
    </div>
  );
}
