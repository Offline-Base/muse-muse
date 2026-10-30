"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { CodeView, ErrorBox, ModelSelect, ResponseView, RunButton } from "@/components/docs/kit";
import { Field, Segmented, TextInput, Toggle } from "@/components/docs/kit/Field";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { MaskOverlay, type PromptTool } from "@/components/docs/media/MaskOverlay";
import { useObjectUrl } from "@/components/docs/media/hooks";
import media from "@/components/docs/media/media.module.css";
import { GroupedPresets } from "@/components/docs/playgrounds/voice-sam/GroupedPresets";
import { MaskComposite, type CompositeMode } from "@/components/docs/playgrounds/voice-sam/MaskComposite";
import { WireLegend, WireLine } from "@/components/docs/playgrounds/voice-sam/WireLine";
import { pickSample } from "@/components/docs/playgrounds/voice-sam/pick-sample";
import {
  earliestPromptFrame,
  frameOrder,
  lintConcept,
  objectTracks,
  promptFrames,
  samCostUsd,
  trackedFrames,
  type Propagation,
} from "@/components/docs/playgrounds/voice-sam/sam-wire";
import { failureEvents, samResultView, useSamRun } from "@/components/docs/playgrounds/voice-sam/useSamRun";
import styles from "@/components/docs/playgrounds/voice-sam/voice-sam.module.css";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { formatUsd } from "@/lib/docs/client/cost";
import { fileToDataUrl } from "@/lib/docs/media/base64";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import { redactMedia, samRequest } from "@/lib/docs/media/requests";
import { SAM_MAX_PROMPT_OBJECTS, SamPromptError, buildSamPrompt, objectIds, type SamPromptObject } from "@/lib/docs/media/sam";
import { sampleById } from "@/lib/docs/media/samples";

export type SamPromptKind = "concept" | "objects" | "text";

export interface SamPreset {
  label: string;
  /** Presets with the same group share a row of pills under that label, such as "Video" or "Errors (400)". */
  group?: string;
  media?: "image" | "video";
  /** An image sample id for image presets, a video sample id for video ones. */
  sampleId?: string;
  kind?: SamPromptKind;
  /** The concept, or the raw input_text for kind "text". */
  prompt?: string;
  /** Box and point prompts, in the sample's own pixels, with frames for video. */
  objects?: SamPromptObject[];
  maskEncoding?: "lossless" | "one_bit";
  includeConfidence?: boolean;
  propagation?: Propagation;
  stream?: boolean;
  /** "file" uploads the clip with POST /v1/files once and sends its file_id. */
  send?: "inline" | "file";
  /** Metadata sent as is over the built one, to show a 400 the API returns. */
  metadata?: Record<string, string>;
  /** What to look for in the result. */
  note?: string;
}

export type SegmentPanel = "anatomy" | "useCases" | "rules" | "tracks";

export interface SegmentLabProps {
  slug?: string;
  media?: Array<"image" | "video">;
  sampleId?: string;
  videoSampleId?: string;
  prompt?: string;
  /** Prompt kinds offered; the first is where it starts. */
  kinds?: SamPromptKind[];
  presets?: SamPreset[];
  maskEncoding?: "lossless" | "one_bit";
  includeConfidence?: boolean;
  propagation?: Propagation;
  stream?: boolean;
  /** Offer the Files API upload for clips (sam/segmenting, "Upload once, reference by ID"). */
  upload?: boolean;
  /** Extra views under the result. */
  panels?: SegmentPanel[];
  /** Ask Muse Spark what to segment, then hand the concept to SAM (media-segmentation, "When to use it"). */
  pairWithSpark?: boolean;
  /** The use-case tools offered (panels: useCases). */
  useCases?: CompositeMode[];
  showRaw?: boolean;
}

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";
const VIDEO_ACCEPT = "video/mp4,video/quicktime";

const KIND_LABEL: Record<SamPromptKind, string> = {
  concept: "Concept (a noun phrase)",
  objects: "Boxes and points",
  text: "Raw input_text",
};

const SPARK_SCHEMA = {
  type: "object",
  properties: { objects: { type: "array", items: { type: "string" } } },
  required: ["objects"],
  additionalProperties: false,
};

/** One summary line per prompt object and frame, for the prompt list. */
function describeObject(o: SamPromptObject): string {
  const parts: string[] = [];
  if (o.box) parts.push(`box (${o.box.x1}, ${o.box.y1}) to (${o.box.x2}, ${o.box.y2})`);
  const pos = (o.points ?? []).filter((p) => !p.negative).length;
  const neg = (o.points ?? []).filter((p) => p.negative).length;
  if (pos) parts.push(`${pos} point${pos === 1 ? "" : "s"}`);
  if (neg) parts.push(`${neg} negative point${neg === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/**
 * SAM 3.1 the way sam/segmenting, sam/overview and media-segmentation teach it: a concept prompt (with the page's
 * prompt rules as live warnings), box and point prompts drawn on the image or on several video frames, or the raw
 * input_text; mask encoding, confidence, the tracking direction and streaming; inline media or a clip uploaded once
 * with the Files API and referenced by file_id. Presets are working requests, including ones the API rejects on
 * purpose to show its 400 messages. Panels add the request and response anatomy, the masks put to use (cut out, blur,
 * measure), and objects followed across frames.
 */
export function SegmentLab({
  media: kinds = ["image", "video"],
  sampleId = "street",
  videoSampleId = "street-pan",
  prompt: initialPrompt = "dog",
  kinds: promptKinds = ["concept", "objects", "text"],
  presets = [],
  maskEncoding: initialEncoding = "one_bit",
  includeConfidence: initialConfidence = true,
  propagation: initialPropagation = "both",
  stream: initialStream = true,
  upload = false,
  panels = [],
  pairWithSpark = false,
  useCases = ["cutout", "blur", "measure"],
  showRaw: initialRaw = false,
}: SegmentLabProps) {
  const id = useId();
  const sam = useSamRun();
  const running = sam.state === "running";
  const [kind, setKind] = useState<"image" | "video">(kinds[0] ?? "image");
  const [image, setImage] = useState<PickedMedia | null>(null);
  const [video, setVideo] = useState<PickedMedia | null>(null);
  const [promptKind, setPromptKind] = useState<SamPromptKind>(promptKinds[0] ?? "concept");
  const [concept, setConcept] = useState(initialPrompt);
  const [rawText, setRawText] = useState("");
  const [objects, setObjects] = useState<SamPromptObject[]>([]);
  const [activeId, setActiveId] = useState(1);
  const [tool, setTool] = useState<PromptTool>("box");
  const [frame, setFrame] = useState(0);
  const [encoding, setEncoding] = useState(initialEncoding);
  const [confidence, setConfidence] = useState(initialConfidence);
  const [propagation, setPropagation] = useState<Propagation>(initialPropagation);
  const [stream, setStream] = useState(initialStream);
  const [send, setSend] = useState<"inline" | "file">("inline");
  const [raw, setRaw] = useState(initialRaw);
  const [showCode, setShowCode] = useState(false);
  const [preset, setPreset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [ranFile, setRanFile] = useState<PickedMedia | null>(null);
  const [ranKind, setRanKind] = useState<SamPromptKind>("concept");
  const [ranPrompt, setRanPrompt] = useState("");
  const [ranBody, setRanBody] = useState<Record<string, unknown> | null>(null);
  const uploads = useRef(new WeakMap<Blob, string>());
  const overlayWrap = useRef<HTMLDivElement>(null);
  /** A frame to show once the clip is ready: a preset's earliest prompt frame, or a frame chip the reader picked. */
  const [seekTo, setSeekTo] = useState<number | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const uploader = useDocsRun();

  const file = kind === "image" ? image : video;
  const url = useObjectUrl(file?.blob ?? null);
  const size = file?.width && file?.height ? { width: file.width, height: file.height } : null;
  const active = preset !== null ? presets[preset] : null;
  const out = sam.out && ranFile === file ? sam.out : null;

  const sample = sampleById(kind === "image" ? (image?.sampleId ?? sampleId) : (video?.sampleId ?? videoSampleId));
  const chips = (sample?.prompts ?? []).filter((p) => p.split(" ").length <= 4);
  const warnings = promptKind === "concept" ? lintConcept(concept) : [];

  const objectPrompt = useMemo((): { text: string; error: string | null } => {
    if (promptKind !== "objects") return { text: "", error: null };
    if (!size) return { text: "", error: `Pick ${kind === "image" ? "an image" : "a video"} first.` };
    if (!objects.length) return { text: "", error: `Drag a box or click a point on the ${kind} to prompt object ${activeId}.` };
    try {
      return { text: buildSamPrompt(size, objects), error: null };
    } catch (err) {
      return { text: "", error: err instanceof SamPromptError ? err.message : "Those prompts can't be sent." };
    }
  }, [promptKind, size, objects, kind, activeId]);

  const promptText = promptKind === "concept" ? concept.trim() : promptKind === "objects" ? objectPrompt.text : rawText.trim();
  const usesFrames = kind === "video" && (promptKind === "objects" || (promptKind === "text" && promptText.startsWith("<")));
  const earliest = promptKind === "objects" ? earliestPromptFrame(objects) : Math.min(...promptFrames(promptText), Number.POSITIVE_INFINITY);
  const totalFrames = file?.frames ?? 0;
  const tracked = usesFrames && Number.isFinite(earliest) && totalFrames ? trackedFrames(propagation, earliest, totalFrames) : null;
  const estimate = kind === "image" ? samCostUsd("image") : samCostUsd("video", tracked ? tracked.frames : totalFrames || 50);
  const fileId = file && send === "file" && kind === "video" ? (uploads.current.get(file.blob) ?? null) : null;

  const bodyFor = useCallback(
    (ref: { dataUrl: string } | { fileId: string }) => {
      const { body } = samRequest({
        prompt: promptText,
        media: ref,
        kind,
        stream,
        maskEncoding: encoding,
        includeConfidence: confidence,
        propagation: usesFrames ? propagation : undefined,
      });
      if (active?.metadata) body.metadata = { ...((body.metadata as Record<string, string> | undefined) ?? {}), ...active.metadata };
      return body;
    },
    [promptText, kind, stream, encoding, confidence, usesFrames, propagation, active],
  );
  const shownBody = redactMedia(
    bodyFor(fileId ? { fileId } : send === "file" && kind === "video" ? { fileId: "file-abc123" } : { dataUrl: `data:${file?.mime ?? (kind === "image" ? "image/jpeg" : "video/mp4")};base64,<BASE64>` }),
  );

  const loadSampleFor = async (mediaKind: "image" | "video", sample: string) => {
    setLoading(true);
    try {
      const picked = await pickSample(sample, { forSam: mediaKind === "video" });
      if (!picked) return;
      if (mediaKind === "image") setImage(picked);
      else setVideo(picked);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Couldn't load that sample.");
    } finally {
      setLoading(false);
    }
  };

  const applyPreset = async (i: number) => {
    const p = presets[i];
    if (!p) return;
    setPreset(i);
    setLocalError(null);
    sam.clear();
    const mediaKind = p.media && kinds.includes(p.media) ? p.media : kind;
    setKind(mediaKind);
    const k = p.kind && promptKinds.includes(p.kind) ? p.kind : "concept";
    setPromptKind(k);
    if (k === "concept") setConcept(p.prompt ?? concept);
    if (k === "text") setRawText(p.prompt ?? "");
    setObjects(k === "objects" ? (p.objects ?? []) : []);
    if (k === "objects") setActiveId(p.objects?.[0]?.id ?? 1);
    setEncoding(p.maskEncoding ?? initialEncoding);
    setConfidence(p.includeConfidence ?? initialConfidence);
    setPropagation(p.propagation ?? "both");
    setStream(p.stream ?? true);
    setSend(p.send === "file" && upload ? "file" : "inline");
    const want = p.sampleId ?? (mediaKind === "image" ? sampleId : videoSampleId);
    const current = mediaKind === "image" ? image : video;
    if (current?.sampleId !== want) await loadSampleFor(mediaKind, want);
    if (mediaKind === "video" && k === "objects" && p.objects?.length) setSeekTo(earliestPromptFrame(p.objects));
  };

  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    setPreset(null);
    set(v);
  };

  const ensureUpload = async (f: PickedMedia): Promise<string | null> => {
    const known = uploads.current.get(f.blob);
    if (known) {
      setUploadNote(`Referencing ${known}, uploaded earlier from this page: no upload this time.`);
      return known;
    }
    const form = new FormData();
    form.append("purpose", "user_data");
    form.append("file", f.blob, f.name);
    setUploadNote(`Uploading ${f.name} with POST /v1/files...`);
    const res = await uploader.run("files", { form });
    const idOf = (res.json as { id?: unknown } | null)?.id;
    if (!res.ok || typeof idOf !== "string") {
      setUploadNote(null);
      setLocalError(res.error?.message ?? "The upload failed.");
      return null;
    }
    uploads.current.set(f.blob, idOf);
    setUploadNote(`Uploaded once as ${idOf} (status ${(res.json as { status?: string }).status ?? "uploaded"}). This and later runs send only the id.`);
    return idOf;
  };

  const run = async () => {
    if (!file || !promptText) return;
    setLocalError(null);
    let ref: { dataUrl: string } | { fileId: string };
    if (send === "file" && kind === "video") {
      const idOf = await ensureUpload(file);
      if (!idOf) return;
      ref = { fileId: idOf };
    } else {
      setUploadNote(null);
      ref = { dataUrl: await fileToDataUrl(file.blob, file.mime) };
    }
    const body = bodyFor(ref);
    setRanFile(file);
    setRanKind(promptKind);
    setRanPrompt(promptText);
    setRanBody(redactMedia(body));
    await sam.run({ body, stream });
  };

  const onFrame = useCallback((f: number) => setFrame(f), []);

  // MaskOverlay follows its video's playback time, so moving the clip to a frame moves the overlay with it.
  useEffect(() => {
    if (seekTo === null || kind !== "video") return;
    const v = overlayWrap.current?.querySelector("video");
    if (!v) return;
    const fps = video?.fps ?? 24;
    const go = () => {
      v.pause();
      v.currentTime = (seekTo + 0.5) / fps;
      setSeekTo(null);
    };
    if (v.readyState >= 1) go();
    else {
      v.addEventListener("loadedmetadata", go, { once: true });
      return () => v.removeEventListener("loadedmetadata", go);
    }
  }, [seekTo, kind, video, url]);
  const ids = out ? objectIds(out.records) : [];
  const frameCount = out ? new Set(out.records.map((r) => r.frame)).size : 0;
  const promptIds = [...new Set([...objects.map((o) => o.id), activeId])].sort((a, b) => a - b);
  const labels = ranKind === "concept" ? undefined : Object.fromEntries(ids.map((i) => [i, "Object"]));
  const arrival = out ? out.frames.map((f) => f.frame) : [];
  const order = frameOrder(arrival);
  const markers = out ? [...new Set(out.records.map((r) => r.mask.encoding))] : [];

  return (
    <div className={styles.lab}>
      {presets.length ? <GroupedPresets presets={presets} active={preset} onPick={(i) => void applyPreset(i)} disabled={running || loading} /> : null}
      {active?.note ? <p className={`${styles.note} pg-advanced`}>{active.note}</p> : null}

      {/* With a prompt switch below, that one is the simple view's one switch. */}
      <div className={kinds.length > 1 && promptKinds.length <= 1 ? "pg-bar" : "pg-bar pg-advanced"}>
        {kinds.length > 1 ? (
          <Segmented<"image" | "video">
            label="Media"
            value={kind}
            onChange={(v) => {
              setPreset(null);
              setKind(v);
              setObjects([]);
            }}
            disabled={running}
            options={kinds.map((k) => ({ value: k, label: k === "image" ? "Image (input_image)" : "Video (input_video)" }))}
          />
        ) : null}
        <ModelSelect kind="sam" value="sam-3.1" onChange={() => {}} />
      </div>

      {kind === "image" ? (
        <FilePicker
          label="Image"
          accept={IMAGE_ACCEPT}
          value={image}
          onChange={(f) => {
            setPreset(null);
            setImage(f);
            setObjects([]);
          }}
          samples={["image"]}
          defaultSampleId={sampleId}
          preview="compact"
          disabled={running || loading}
        />
      ) : (
        <FilePicker
          label="Video (MP4 or MOV with H.264, H.265 or MPEG-4; up to 3 MB here)"
          accept={VIDEO_ACCEPT}
          value={video}
          onChange={(f) => {
            setPreset(null);
            setVideo(f);
            setObjects([]);
          }}
          samples={["video"]}
          defaultSampleId={videoSampleId}
          forSam
          preview="compact"
          disabled={running || loading}
        />
      )}

      {promptKinds.length > 1 ? (
        <Segmented<SamPromptKind>
          size="sm"
          label="Prompt"
          value={promptKind}
          onChange={edit(setPromptKind)}
          disabled={running}
          options={promptKinds.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
        />
      ) : null}

      {promptKind === "concept" ? (
        <div className={styles.stack}>
          <Field id={`${id}-c`} label="Concept" hint="One short noun phrase that names one concrete object, such as dog or red bicycle.">
            <TextInput id={`${id}-c`} value={concept} onChange={(e) => edit(setConcept)(e.target.value)} disabled={running} aria-describedby={`${id}-c-hint`} />
          </Field>
          {chips.length ? (
            // The page's presets are the simple view's examples; without any, these are.
            <div className={presets.length ? `${media.chips} pg-advanced` : media.chips} role="group" aria-label="Concepts for this sample">
              {chips.map((c) => (
                <button key={c} type="button" className={media.chip} onClick={() => edit(setConcept)(c)} disabled={running}>
                  {c}
                </button>
              ))}
            </div>
          ) : null}
          {warnings.length ? (
            <ul className={styles.checkList} aria-label="Prompt rules">
              {warnings.map((w) => (
                <li key={w.rule} className={styles.warn}>
                  <strong>{w.rule}.</strong> {w.message}
                </li>
              ))}
            </ul>
          ) : panels.includes("rules") && concept.trim() ? (
            <p className={`${styles.note} pg-advanced`}>Fits the page&apos;s prompt rules: one concrete noun phrase. Plurals, case and punctuation don&apos;t change the match.</p>
          ) : null}
          {pairWithSpark && image && kind === "image" ? <SparkSuggest image={image} onPick={(c) => edit(setConcept)(c)} disabled={running} /> : null}
        </div>
      ) : promptKind === "objects" ? (
        <div className={styles.stack}>
          <div className={media.options}>
            <span className={media.inline}>
              <span className={styles.label}>Draw</span>
              <Segmented<PromptTool>
                size="sm"
                label="Prompt tool"
                value={tool}
                onChange={setTool}
                disabled={running}
                options={[
                  { value: "box", label: "Box" },
                  { value: "point", label: "Point" },
                  { value: "negative", label: "Negative point" },
                ]}
              />
            </span>
            <span className={media.inline}>
              <span className={styles.label}>Object id</span>
              <Segmented size="sm" label="Object id" value={String(activeId)} onChange={(v) => setActiveId(Number(v))} disabled={running} options={promptIds.map((i) => ({ value: String(i), label: String(i) }))} />
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => {
                  const used = new Set(objects.map((o) => o.id));
                  let next = 1;
                  while (used.has(next)) next++;
                  setActiveId(next);
                }}
                disabled={running || promptIds.length >= SAM_MAX_PROMPT_OBJECTS}
              >
                New object
              </button>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => edit(setObjects)([])} disabled={running || !objects.length}>
                Clear
              </button>
            </span>
          </div>
          <p className={`${styles.note} pg-advanced`}>
            {kind === "video" ? `Prompts go on the frame you're on (frame ${frame}); move with the frame bar to prompt other frames. Repeat an id to prompt the same object again. ` : ""}
            Drawn coordinates are converted to the {kind}&apos;s own pixels{size ? ` (w=${size.width}, h=${size.height})` : ""}, the w and h every token carries.
          </p>
          {kind === "video" && new Set(objects.map((o) => o.frame ?? 0)).size ? (
            <div className={`${media.chips} pg-advanced`} role="group" aria-label="Go to a prompted frame">
              <span className={styles.note}>Go to:</span>
              {[...new Set(objects.map((o) => o.frame ?? 0))]
                .sort((a, b) => a - b)
                .map((f) => (
                  <button key={f} type="button" className={`${media.chip} ${styles.pressable}`} aria-pressed={frame === f} onClick={() => setSeekTo(f)}>
                    Frame {f}
                  </button>
                ))}
            </div>
          ) : null}
          {objects.length ? (
            <ul className={`${styles.checkList} pg-advanced`} aria-label="Prompted objects">
              {[...objects]
                .sort((a, b) => (a.frame ?? 0) - (b.frame ?? 0) || a.id - b.id)
                .map((o) => (
                  <li key={`${o.id}-${o.frame ?? 0}`} className={styles.note}>
                    {kind === "video" ? `Frame ${o.frame ?? 0}: ` : ""}object {o.id}, {describeObject(o)}
                  </li>
                ))}
            </ul>
          ) : null}
          {objectPrompt.error ? (
            <p className={media.hint}>{objectPrompt.error}</p>
          ) : (
            <div className="pg-advanced">
              <WireLine line={objectPrompt.text} full />
            </div>
          )}
        </div>
      ) : (
        <div className={styles.stack}>
          <label className={styles.label} htmlFor={`${id}-raw`}>
            input_text, sent exactly as typed
          </label>
          <textarea id={`${id}-raw`} className={styles.textarea} value={rawText} rows={3} spellCheck={false} onChange={(e) => edit(setRawText)(e.target.value)} disabled={running} />
          <p className={`${styles.note} pg-advanced`}>
            A noun phrase, or box and point prompts in the output grammar: {"<0f>1<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|>"}, points as{" "}
            {"<|point;x=..;y=..;w=..;h=..|>"}, a - before a point for a negative one. Never both kinds in one prompt.
          </p>
        </div>
      )}

      {file && url ? (
        // Until a run, the picker's thumbnail shows the file, and this large preview would push Segment off the panel. Box
        // and point prompts are drawn on it, and a run's masks land on it, so it shows for those.
        <div ref={overlayWrap} className={running || out || promptKind === "objects" ? undefined : "pg-advanced"}>
        <MaskOverlay
          src={url}
          media={kind}
          records={out?.records ?? []}
          fps={file.fps ?? 24}
          frames={file.frames}
          label={ranKind === "concept" ? ranPrompt : undefined}
          labels={labels}
          alt={file.description}
          prompts={promptKind === "objects" ? objects : []}
          tool={promptKind === "objects" && !running ? tool : null}
          activeObjectId={activeId}
          onPromptsChange={(p) => edit(setObjects)(p)}
          onFrame={onFrame}
        />
        </div>
      ) : null}

      <div className={`${media.options} pg-advanced`}>
        <span className={media.inline}>
          <span className={styles.label}>mask_encoding</span>
          <Segmented<"lossless" | "one_bit">
            size="sm"
            label="Mask encoding"
            value={encoding}
            onChange={edit(setEncoding)}
            disabled={running}
            options={[
              { value: "one_bit", label: "one_bit (!)" },
              { value: "lossless", label: "lossless (~)" },
            ]}
          />
        </span>
        {usesFrames ? (
          <span className={media.inline}>
            <span className={styles.label}>propagation_direction</span>
            <Segmented<Propagation>
              size="sm"
              label="Tracking direction"
              value={propagation}
              onChange={edit(setPropagation)}
              disabled={running}
              options={[
                { value: "both", label: "both" },
                { value: "forward", label: "forward" },
                { value: "backward", label: "backward" },
              ]}
            />
          </span>
        ) : null}
        <Toggle id={`${id}-conf`} label='include_confidence: "true"' checked={confidence} onChange={edit(setConfidence)} disabled={running} />
        <Toggle id={`${id}-stream`} label="Stream" checked={stream} onChange={edit(setStream)} disabled={running} />
        {upload && kind === "video" ? (
          <span className={media.inline}>
            <span className={styles.label}>Send the clip</span>
            <Segmented<"inline" | "file">
              size="sm"
              label="Send the clip"
              value={send}
              onChange={edit(setSend)}
              disabled={running}
              options={[
                { value: "inline", label: "Inline (video_url)" },
                { value: "file", label: "Upload once (file_id)" },
              ]}
            />
          </span>
        ) : null}
        <Toggle id={`${id}-raw-wire`} label="Raw wire" checked={raw} onChange={setRaw} />
      </div>
      {usesFrames && tracked ? (
        <p className={`${styles.note} pg-advanced`}>
          Tracking {propagation} from frame {earliest}: frames {tracked.range}, {tracked.frames} of {totalFrames}.
          {propagation === "backward" && earliest === 0 ? " backward needs a prompt on a frame after frame 0; the API answers 400." : ""}
          {propagation === "both" ? " Omit the key for both; it's the default." : ""}
        </p>
      ) : null}
      {active?.metadata ? (
        <p className={styles.warn}>
          <strong>This preset is rejected on purpose.</strong> It sends metadata {JSON.stringify(active.metadata)} so you can read the API&apos;s 400.
        </p>
      ) : null}

      <div className={media.spread}>
        <RunButton
          running={running || uploader.state === "running"}
          onRun={() => void run()}
          onStop={() => {
            sam.abort();
            uploader.abort();
          }}
          label="Segment"
          disabled={!file || !promptText || loading || (file?.problems.length ?? 0) > 0}
        />
      </div>
      <p className={uploadNote ? styles.note : `${styles.note} pg-advanced`}>
        {kind === "video"
          ? `Video is billed per frame tracked, $0.20 per 1,000 with a 50-frame minimum: about ${formatUsd(estimate)} for ${tracked ? `these ${tracked.frames} frames` : file?.frames ? `all ${file.frames} frames` : "a short clip"}.`
          : "Images cost $2.50 per 1,000, so $0.0025 a run."}
        {uploadNote ? ` ${uploadNote}` : ""}
      </p>

      <ErrorBox error={localError ? { message: localError } : (sam.error ?? uploader.error)} />

      {running || (sam.result && out) ? (
        <ResponseView result={samResultView(sam.result, out)} running={running} elapsedMs={sam.elapsedMs} model="sam-3.1" usage={out?.usage ?? undefined} json={out?.response ?? undefined}>
          <div className={media.output} aria-live="polite">
            <p className={styles.note}>
              {out?.records.length
                ? `${ids.length} object${ids.length === 1 ? "" : "s"}${ranKind === "concept" ? ` matching "${ranPrompt}"` : ""}${kind === "video" ? ` across ${frameCount} frame${frameCount === 1 ? "" : "s"}` : ""}${out.done ? (out.error ? `, then the stream failed (${failureEvents(out)}), so the result is incomplete.` : ", drawn on the overlay above.") : " so far..."}`
                : out?.done
                  ? out.error
                    ? `The request failed inside the stream: HTTP 200, then ${failureEvents(out)}. The error above says why. This is a failure, not zero matches, so handle both events.`
                    : sam.result?.ok
                      ? "No matches: an empty output_text, which is a normal result, not an error. Try another phrase."
                      : "Nothing came back."
                  : "Segmenting..."}
              {out?.done && markers.length ? ` Masks came back ${markers.map((m) => (m === "lossless" ? "lossless (~)" : "one_bit (!)")).join(" and ")}.` : ""}
              {out?.done && kind === "video" && arrival.length > 1 ? ` Lines arrived ${order === "ascending" ? "in ascending frame order" : order === "descending" ? "backward, down from the earliest prompt frame" : order === "forward-then-backward" ? "forward from the earliest prompt frame, then backward" : "out of order"}.` : ""}
            </p>
            {out?.diagnostics.length ? (
              <ul className={styles.note}>
                {out.diagnostics.slice(0, 5).map((d, i) => (
                  <li key={i}>
                    Line {d.line}: {d.message}
                  </li>
                ))}
              </ul>
            ) : null}
            {raw ? <pre className={styles.pre}>{out?.raw || "(no output text yet)"}</pre> : null}
          </div>
        </ResponseView>
      ) : null}

      {panels.includes("anatomy") && out?.done && sam.result?.ok && ranBody ? <Anatomy body={ranBody} out={out} kind={kind} /> : null}
      {panels.includes("useCases") && out?.done && kind === "image" && out.records.length && url && size ? (
        <MaskComposite src={url} records={out.records} width={size.width} height={size.height} label={ranKind === "concept" ? ranPrompt : undefined} modes={useCases} />
      ) : null}
      {panels.includes("tracks") && out?.done && kind === "video" && out.records.length ? <Tracks out={out} total={totalFrames} /> : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? (
        <div className={`${styles.stack} pg-advanced`}>
          {send === "file" && kind === "video" ? (
            <CodeView method="POST" path="files" form={[{ name: "purpose", value: "user_data" }, { name: "file", value: file?.name ?? "clip.mp4", file: { label: "Clip", accept: "video/mp4" } }]} caption="1. Upload the clip once" />
          ) : null}
          <CodeView method="POST" path="responses" body={shownBody} stream={stream} caption={send === "file" && kind === "video" ? "2. Reference it by file_id in each request" : "The request Segment sends"} />
        </div>
      ) : null}
    </div>
  );
}

function Anatomy({ body, out, kind }: { body: Record<string, unknown>; out: NonNullable<ReturnType<typeof useSamRun>["out"]>; kind: "image" | "video" }) {
  const content = ((body.input as Array<{ content?: Array<Record<string, unknown>> }> | undefined)?.[0]?.content ?? []) as Array<Record<string, unknown>>;
  const text = content.find((c) => c.type === "input_text")?.text as string | undefined;
  const mediaPart = content.find((c) => c.type !== "input_text");
  const firstLine = out.raw.split("\n").find((l) => l.trim());
  const usage = out.usage ?? {};
  return (
    <section className={styles.split} aria-label="Anatomy">
      <div className={styles.card}>
        <p className={styles.cardTitle}>The request</p>
        <ul className={styles.checkList}>
          <li>
            <code>model</code>: sam-3.1, on <code>POST /v1/responses</code>
          </li>
          <li>One user message with two parts:</li>
          <li>
            &nbsp;&nbsp;<code>input_text</code>: {text?.startsWith("<") ? "box and point prompts" : `"${text}", one short noun phrase`}
          </li>
          <li>
            &nbsp;&nbsp;<code>{String(mediaPart?.type)}</code>:{" "}
            {mediaPart?.file_id ? `file_id ${String(mediaPart.file_id)}` : mediaPart?.image_url ? "image_url, a base64 data URL" : "video_url, a base64 data URL"}
          </li>
          <li>
            <code>stream</code>: {body.stream === true ? "true, so each frame arrives as its own delta" : "omitted, so the whole result comes back at once"}
          </li>
          <li>
            <code>metadata</code>: {body.metadata ? JSON.stringify(body.metadata) : "none (lossless masks, no confidence)"}
          </li>
        </ul>
      </div>
      <div className={styles.card}>
        <p className={styles.cardTitle}>The response</p>
        <ul className={styles.counts} aria-label="Events in order">
          {out.events.map(([type, n], i) => (
            <li key={`${type}-${i}`} className={styles.count}>
              {type.replace(/^response\./, "")}
              {n > 1 ? <b>x{n}</b> : null}
            </li>
          ))}
        </ul>
        {firstLine ? (
          <>
            <WireLine line={firstLine} />
            <WireLegend />
            <p className={styles.note}>
              {kind === "image" ? "An image is one line, frame <0f>." : `One line per frame: ${out.frames.length} lines.`} The leading integer is the object id,
              then one box (corners in source pixels, x2 and y2 inclusive) and one mask (rows, columns, then ~ lossless or ! one_bit).
            </p>
          </>
        ) : out.error ? (
          <p className={styles.note}>
            No output text: the stream failed under HTTP 200 with {failureEvents(out)} ({out.error.code ? `${out.error.code}: ` : ""}
            {out.error.message}). Treat those events as a failure; only a completed stream with an empty lane means zero matches.
          </p>
        ) : (
          <p className={styles.note}>The output_text lane is empty: zero matches, a valid result. Branch on it rather than treating it as an error.</p>
        )}
        <p className={styles.note}>
          usage: {Object.entries(usage)
            .filter(([, v]) => typeof v === "number" && v > 0)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ") || "no billable units reported"}
          . Tokens stay at 0: SAM bills images and frames.
        </p>
      </div>
    </section>
  );
}

function Tracks({ out, total }: { out: NonNullable<ReturnType<typeof useSamRun>["out"]>; total: number }) {
  const tracks = objectTracks(out.records);
  const last = Math.max(total - 1, ...out.records.map((r) => r.frame), 0);
  return (
    <section className={styles.card} aria-label="Objects across frames">
      <p className={styles.cardTitle}>Objects across frames</p>
      {tracks.map((t) => {
        const present = new Set(t.frames);
        return (
          <div key={t.objectId} className={styles.track}>
            <span className={styles.mono}>id {t.objectId}</span>
            <div className={styles.trackBar} role="img" aria-label={`Object ${t.objectId} on ${t.frames.length} frames, ${t.first} to ${t.last}`}>
              {Array.from({ length: last + 1 }, (_, f) => (
                <span key={f} className={styles.trackCell} style={{ background: present.has(f) ? "var(--accent)" : "transparent" }} />
              ))}
            </div>
          </div>
        );
      })}
      <p className={styles.note}>
        Each id names the same object on every frame it appears on, so follow an object by holding its id. Gaps are frames where it wasn&apos;t found;
        don&apos;t rely on an id across an exit, a full occlusion or very long clips.
      </p>
    </section>
  );
}

/**
 * Muse Spark names what's in the photo, SAM 3.1 cuts it out: the pairing media-segmentation suggests. A Responses call
 * with the image and a JSON schema for short noun phrases; each one becomes a concept chip.
 */
function SparkSuggest({ image, onPick, disabled }: { image: PickedMedia; onPick(concept: string): void; disabled?: boolean }) {
  const runner = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [nouns, setNouns] = useState<string[]>([]);
  const running = runner.state === "running";
  const ask = async () => {
    setNouns([]);
    const dataUrl = await fileToDataUrl(image.blob, image.mime);
    const body = {
      model,
      max_output_tokens: 600,
      reasoning: { effort: "low" },
      text: { format: { type: "json_schema", name: "segmentable_objects", strict: true, schema: SPARK_SCHEMA } },
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "List up to 6 concrete objects in this photo that someone might want to cut out, each as a short noun phrase of 1 to 3 words." },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      ],
    };
    // Not recorded: the copy prompt should keep describing the SAM request this page is about.
    const res = await runner.run("responses", { body, record: false });
    const reply = res.json as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> } | null;
    const text = reply?.output_text ?? reply?.output?.flatMap((o) => o.content ?? []).find((c) => c.type === "output_text")?.text ?? "";
    try {
      const parsed = JSON.parse(text) as { objects?: unknown };
      setNouns(Array.isArray(parsed.objects) ? parsed.objects.filter((x): x is string => typeof x === "string").slice(0, 8) : []);
    } catch {
      setNouns([]);
    }
  };
  return (
    <div className={styles.card}>
      <p className={styles.cardTitle}>Not sure what to segment? Ask Muse Spark first</p>
      <p className={`${styles.note} pg-advanced`}>Muse Spark reads the scene and names the objects; SAM 3.1 then returns their pixels. One call to each, under a cent together.</p>
      <div className="pg-bar">
        <ModelSelect kind="vision" value={model} onChange={setModel} disabled={running || disabled} />
        <RunButton running={running} onRun={() => void ask()} onStop={runner.abort} label="Ask Muse Spark" disabled={disabled} />
      </div>
      <ErrorBox error={runner.error} />
      {nouns.length ? (
        <div className={media.chips} role="group" aria-label="Concepts Muse Spark found">
          <span className={styles.note}>Segment:</span>
          {nouns.map((n) => (
            <button key={n} type="button" className={media.chip} onClick={() => onPick(n)} disabled={disabled}>
              {n}
            </button>
          ))}
        </div>
      ) : runner.state === "done" ? (
        <p className={styles.note}>Muse Spark didn&apos;t return a list this time. Try again.</p>
      ) : null}
    </div>
  );
}
