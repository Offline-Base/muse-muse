"use client";

import { useCallback, useId, useMemo, useState } from "react";
import { CodeView, ErrorBox, ModelSelect, ResponseView, RunButton } from "@/components/docs/kit";
import { useDocsPage } from "@/components/docs/kit/DocsPageContext";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { Field, Segmented, TextInput, Toggle } from "@/components/docs/kit/Field";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { MaskOverlay, type PromptTool } from "@/components/docs/media/MaskOverlay";
import { useObjectUrl } from "@/components/docs/media/hooks";
import styles from "@/components/docs/media/media.module.css";
import type { DocsError } from "@/lib/docs/client/api";
import { formatUsd } from "@/lib/docs/client/cost";
import { trimForRecord } from "@/lib/docs/client/record";
import { fileToDataUrl } from "@/lib/docs/media/base64";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import { samRequest } from "@/lib/docs/media/requests";
import {
  SAM_MAX_PROMPT_OBJECTS,
  SamPromptError,
  SamStreamParser,
  buildSamPrompt,
  objectIds,
  samDelta,
  samTextOfResponse,
  type SamDiagnostic,
  type SamPromptObject,
  type SamRecord,
} from "@/lib/docs/media/sam";
import { sampleById } from "@/lib/docs/media/samples";
import { samVideoCost } from "@/lib/docs/media/video";

export interface SegmentPlaygroundProps {
  slug?: string;
  /** "image", "video" or both; the first is where it starts. */
  media?: Array<"image" | "video">;
  /** The image sample picked on load. Defaults to the street photo. */
  sampleId?: string;
  /** The clip picked on load in video mode. Defaults to the 5 s street clip. */
  videoSampleId?: string;
  /** The concept prompt to start with: a short noun phrase. */
  prompt?: string;
  /** Concept chips. Defaults to the sample's own suggestions. */
  suggestions?: string[];
  /** Start with box and point prompts instead of a concept. */
  promptKind?: "concept" | "objects";
  /** Offer box and point prompts. Default true. */
  objectPrompts?: boolean;
  maskEncoding?: "lossless" | "one_bit";
  includeConfidence?: boolean;
  /** Video box and point prompts: which frames to track over. */
  propagation?: "both" | "forward" | "backward";
  /** Stream the reply (the recommended path). Default true. */
  stream?: boolean;
  /** Start with the raw wire text showing. */
  showRaw?: boolean;
}

interface Run {
  records: SamRecord[];
  raw: string;
  diagnostics: SamDiagnostic[];
  usage: Record<string, unknown> | null;
  /** The final response object (response.completed's, or the plain reply), for the JSON tab. */
  response: unknown;
  file: PickedMedia;
  prompt: string;
  kind: "concept" | "objects";
  done: boolean;
}

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";
const VIDEO_ACCEPT = "video/mp4,video/quicktime";

/**
 * SAM 3.1 on an image or a short clip: a concept prompt (one short noun phrase) or box and point prompts drawn on the
 * media, sent on the Responses API with streaming. Each streamed line is parsed as it arrives (lib/docs/media/sam.ts)
 * and drawn on the overlay with per-object colors, labels and confidence; "Raw wire" shows the text exactly as it came.
 */
export function SegmentPlayground({
  media: kinds = ["image", "video"],
  sampleId = "street",
  videoSampleId = "street-pan",
  prompt: initialPrompt = "dog",
  suggestions,
  promptKind: initialKind = "concept",
  objectPrompts = true,
  maskEncoding: initialEncoding = "one_bit",
  includeConfidence: initialConfidence = true,
  propagation: initialPropagation = "both",
  stream: initialStream = true,
  showRaw: initialRaw = false,
}: SegmentPlaygroundProps) {
  const id = useId();
  const runner = useDocsRun();
  const [showCode, setShowCode] = useState(false);
  const { recordRequest } = useDocsPage();
  const [kind, setKind] = useState<"image" | "video">(kinds[0] ?? "image");
  const [image, setImage] = useState<PickedMedia | null>(null);
  const [video, setVideo] = useState<PickedMedia | null>(null);
  const [promptKind, setPromptKind] = useState<"concept" | "objects">(objectPrompts ? initialKind : "concept");
  const [concept, setConcept] = useState(initialPrompt);
  const [objects, setObjects] = useState<SamPromptObject[]>([]);
  const [activeId, setActiveId] = useState(1);
  const [tool, setTool] = useState<PromptTool>("box");
  const [frame, setFrame] = useState(0);
  const [encoding, setEncoding] = useState(initialEncoding);
  const [confidence, setConfidence] = useState(initialConfidence);
  const [propagation, setPropagation] = useState(initialPropagation);
  const [stream, setStream] = useState(initialStream);
  const [raw, setRaw] = useState(initialRaw);
  const [result, setResult] = useState<Run | null>(null);
  const [localError, setLocalError] = useState<DocsError | null>(null);
  const running = runner.state === "running";
  const file = kind === "image" ? image : video;
  const url = useObjectUrl(file?.blob ?? null);
  const shownRun = result && result.file === file ? result : null;
  const size = file?.width && file?.height ? { width: file.width, height: file.height } : null;

  // Concept chips: the sample's own short prompts (its longer ones are questions for other demos).
  const sample = sampleById(kind === "image" ? (image?.sampleId ?? sampleId) : (video?.sampleId ?? videoSampleId));
  const chips = suggestions ?? sample?.prompts?.filter((p) => p.split(" ").length <= 3) ?? [];

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

  const promptText = promptKind === "concept" ? concept.trim() : objectPrompt.text;
  const shown = samRequest({
    prompt: promptText || "dog",
    media: { dataUrl: kind === "image" ? "data:image/jpeg;base64,<BASE64>" : "data:video/mp4;base64,<BASE64>" },
    kind,
    stream,
    maskEncoding: encoding,
    includeConfidence: confidence,
    propagation: promptKind === "objects" ? propagation : undefined,
  });

  const run = async () => {
    if (!file || !promptText) return;
    setLocalError(null);
    const dataUrl = await fileToDataUrl(file.blob, file.mime);
    const { path, body } = samRequest({
      prompt: promptText,
      media: { dataUrl },
      kind,
      stream,
      maskEncoding: encoding,
      includeConfidence: confidence,
      propagation: promptKind === "objects" ? propagation : undefined,
    });
    const parser = new SamStreamParser();
    let usage: Record<string, unknown> | null = null;
    let response: unknown = null;
    let sawDelta = false;
    const base: Run = { records: [], raw: "", diagnostics: [], usage: null, response: null, file, prompt: promptText, kind: promptKind, done: false };
    setResult(base);
    const update = (done = false) => {
      const out = parser.output();
      setResult({ ...base, records: out.records, raw: parser.raw, diagnostics: out.diagnostics, usage, response, done });
    };
    const res = await runner.run(path, {
      body,
      stream,
      record: false,
      onEvent: (e) => {
        const delta = samDelta(e.json);
        if (delta !== null) {
          sawDelta = true;
          if (parser.push(delta).length) update();
          return;
        }
        const type = e.json?.type;
        // A lane finalized without deltas carries the whole text once.
        if (type === "response.output_text.done" && !sawDelta && typeof e.json?.text === "string") {
          sawDelta = true;
          parser.push(e.json.text);
        }
        if (type === "response.completed" || type === "response.incomplete") {
          const final = e.json?.response as Record<string, unknown> | undefined;
          response = final ?? null;
          usage = (final?.usage as Record<string, unknown> | undefined) ?? null;
          if (!sawDelta && final) parser.push(samTextOfResponse(final));
        }
      },
    });
    if (!stream && res.json) {
      response = res.json;
      parser.push(samTextOfResponse(res.json));
      usage = ((res.json as { usage?: Record<string, unknown> }).usage as Record<string, unknown> | undefined) ?? null;
    }
    parser.end();
    update(true);
    const out = parser.output();
    const ids = objectIds(out.records);
    const frames = new Set(out.records.map((r) => r.frame)).size;
    recordRequest({
      method: "POST",
      path: "responses",
      body: trimForRecord(body),
      status: res.status,
      outcome: !res.ok
        ? `error ${res.status}: ${res.error?.message ?? ""}`.trim()
        : ids.length
          ? `${ids.length} object${ids.length === 1 ? "" : "s"} (ids ${ids.join(", ")}) on ${frames} frame${frames === 1 ? "" : "s"}, as box and mask tokens in output_text`
          : "no matches: an empty output_text, which is a normal result",
    });
  };

  const addObject = () => {
    const used = new Set(objects.map((o) => o.id));
    let next = 1;
    while (used.has(next)) next++;
    setActiveId(next);
  };

  const onFrame = useCallback((f: number) => setFrame(f), []);
  const ids = shownRun ? objectIds(shownRun.records) : [];
  const frameCount = shownRun ? new Set(shownRun.records.map((r) => r.frame)).size : 0;
  const estimate = kind === "video" ? samVideoCost(file?.frames ?? 50) : 0.0025;
  const promptIds = [...new Set([...objects.map((o) => o.id), activeId])].sort((a, b) => a - b);
  const labels = shownRun?.kind === "objects" ? Object.fromEntries(ids.map((i) => [i, "Object"])) : undefined;

  return (
    <div className={`pg ${styles.playground}`}>
      <div className="pg-bar">
        {kinds.length > 1 ? (
          <span className="pg-advanced">
            <Segmented
              label="Media"
              value={kind}
              onChange={(v) => {
                setKind(v);
                setObjects([]);
              }}
              disabled={running}
              options={kinds.map((k) => ({ value: k, label: k === "image" ? "Image (input_image)" : "Video (input_video)" }))}
            />
          </span>
        ) : null}
        <ModelSelect kind="sam" value="sam-3.1" onChange={() => {}} />
      </div>
      {kind === "image" ? (
        <FilePicker
          label="Image"
          accept={IMAGE_ACCEPT}
          value={image}
          onChange={(f) => {
            setImage(f);
            setObjects([]);
          }}
          samples={["image"]}
          defaultSampleId={sampleId}
          preview="compact"
          disabled={running}
        />
      ) : (
        <FilePicker
          label="Video (MP4 or MOV with H.264, H.265 or MPEG-4, up to 3 MB here)"
          accept={VIDEO_ACCEPT}
          value={video}
          onChange={(f) => {
            setVideo(f);
            setObjects([]);
          }}
          samples={["video"]}
          defaultSampleId={videoSampleId}
          forSam
          preview="compact"
          disabled={running}
        />
      )}

      {objectPrompts ? (
        <span className="pg-advanced">
          <Segmented<"concept" | "objects">
            size="sm"
            label="Prompt"
            value={promptKind}
            onChange={setPromptKind}
            disabled={running}
            options={[
              { value: "concept", label: "Concept (a noun phrase)" },
              { value: "objects", label: "Boxes and points" },
            ]}
          />
        </span>
      ) : null}

      {promptKind === "concept" ? (
        <div className={styles.stack}>
          <Field id={`${id}-c`} label="Concept" hint="One short noun phrase, such as dog or red bicycle. Lists and questions return nothing.">
            <TextInput id={`${id}-c`} value={concept} onChange={(e) => setConcept(e.target.value)} disabled={running} />
          </Field>
          {chips.length ? (
            <div className={styles.chips}>
              {chips.map((c) => (
                <button key={c} type="button" className={styles.chip} onClick={() => setConcept(c)} disabled={running}>
                  {c}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className={styles.stack}>
          <div className={styles.options}>
            <span className={styles.inline}>
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
            <span className={styles.inline}>
              <span className={styles.label}>Object</span>
              <Segmented size="sm" label="Object id" value={String(activeId)} onChange={(v) => setActiveId(Number(v))} disabled={running} options={promptIds.map((i) => ({ value: String(i), label: String(i) }))} />
              <button type="button" className="btn btn-outline btn-sm" onClick={addObject} disabled={running || promptIds.length >= SAM_MAX_PROMPT_OBJECTS}>
                New object
              </button>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setObjects([])} disabled={running || !objects.length}>
                Clear
              </button>
            </span>
          </div>
          <p className={`${styles.note} pg-advanced`}>
            {kind === "video" ? `Prompts go on the frame you're on (frame ${frame}); use the frame bar to move. ` : ""}
            Coordinates are converted to the {kind}&apos;s own pixels{size ? ` (${size.width} x ${size.height})` : ""} before they&apos;re sent.
          </p>
          {objectPrompt.error ? <p className={styles.hint}>{objectPrompt.error}</p> : <pre className={styles.raw}>{objectPrompt.text}</pre>}
        </div>
      )}

      {file && url ? (
        <MaskOverlay
          src={url}
          media={kind}
          records={shownRun?.records ?? []}
          fps={file.fps ?? 24}
          frames={file.frames}
          label={shownRun?.kind === "concept" ? shownRun.prompt : undefined}
          labels={labels}
          alt={file.description}
          prompts={promptKind === "objects" ? objects : []}
          tool={promptKind === "objects" && !running ? tool : null}
          activeObjectId={activeId}
          onPromptsChange={setObjects}
          onFrame={onFrame}
        />
      ) : null}

      <div className={`${styles.options} pg-advanced`}>
        <span className={styles.inline}>
          <span className={styles.label}>Masks</span>
          <Segmented<"lossless" | "one_bit">
            size="sm"
            label="Mask encoding"
            value={encoding}
            onChange={setEncoding}
            disabled={running}
            options={[
              { value: "one_bit", label: "one_bit" },
              { value: "lossless", label: "lossless" },
            ]}
          />
        </span>
        {kind === "video" && promptKind === "objects" ? (
          <span className={styles.inline}>
            <span className={styles.label}>Track</span>
            <Segmented<"both" | "forward" | "backward">
              size="sm"
              label="Tracking direction"
              value={propagation}
              onChange={setPropagation}
              disabled={running}
              options={[
                { value: "both", label: "both" },
                { value: "forward", label: "forward" },
                { value: "backward", label: "backward" },
              ]}
            />
          </span>
        ) : null}
        <Toggle id={`${id}-conf`} label="Confidence" checked={confidence} onChange={setConfidence} disabled={running} />
        <Toggle id={`${id}-stream`} label="Stream" checked={stream} onChange={setStream} disabled={running} />
        <Toggle id={`${id}-raw`} label="Raw wire" checked={raw} onChange={setRaw} />
      </div>

      <div className={styles.spread}>
        <RunButton
          running={running}
          onRun={() => void run()}
          onStop={runner.abort}
          label="Segment"
          disabled={!file || !promptText || (file?.problems.length ?? 0) > 0}
        />
      </div>
      <p className={`${styles.note} pg-advanced`}>
        {kind === "video"
          ? `Video is billed per frame, $0.20 per 1,000 with a 50-frame minimum: about ${formatUsd(estimate)} for ${file?.frames ? `these ${file.frames} frames` : "a short clip"}.`
          : "Images cost $2.50 per 1,000, so about $0.0025 a run."}
      </p>

      <ErrorBox error={localError ?? runner.error} />

      {running || (runner.result && shownRun) ? (
        <ResponseView
          result={runner.result}
          running={running}
          elapsedMs={runner.elapsedMs}
          model="sam-3.1"
          usage={shownRun?.usage ?? undefined}
          json={shownRun?.response ?? undefined}
        >
          <div className={styles.output} aria-live="polite">
            <p className={styles.note}>
              {shownRun?.records.length
                ? `${ids.length} object${ids.length === 1 ? "" : "s"}${shownRun.kind === "concept" ? ` matching "${shownRun.prompt}"` : ""}${kind === "video" ? ` across ${frameCount} frame${frameCount === 1 ? "" : "s"}` : ""}${shownRun.done ? ", drawn on the overlay above." : " so far..."}`
                : shownRun?.done
                  ? runner.result?.ok
                    ? "No matches. SAM returns an empty output for a concept that isn't there, which is a normal result: try another phrase."
                    : "Nothing came back."
                  : "Segmenting..."}
            </p>
            {shownRun?.diagnostics.length ? (
              <ul className={styles.note}>
                {shownRun.diagnostics.slice(0, 5).map((d, i) => (
                  <li key={i}>
                    Line {d.line}: {d.message}
                  </li>
                ))}
              </ul>
            ) : null}
            {raw ? <pre className={styles.raw}>{shownRun?.raw || "(no output text yet)"}</pre> : null}
          </div>
        </ResponseView>
      ) : null}
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path={shown.path} body={shown.body} stream={stream} caption="The request Run sends" /> : null}
    </div>
  );
}
