"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Icon } from "@/components/icons";
import { CodeView, ErrorBox, JsonTree, ModelSelect, ResponseView, RunButton } from "@/components/docs/kit";
import { useDocsPage } from "@/components/docs/kit/DocsPageContext";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { Field, Segmented, TextInput, Toggle } from "@/components/docs/kit/Field";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { MaskOverlay } from "@/components/docs/media/MaskOverlay";
import { useObjectUrl } from "@/components/docs/media/hooks";
import styles from "@/components/docs/playgrounds/cookbook-media/cookbook-media.module.css";
import {
  maskFileName,
  maskSvg,
  samOutcome,
  samRunOutcome,
  summarizeConcept,
  validateSummary,
  wroteLine,
  type ConceptSummary,
} from "@/components/docs/playgrounds/cookbook-media/sam-summary";
import type { DocsError } from "@/lib/docs/client/api";
import { formatUsd } from "@/lib/docs/client/cost";
import { trimForRecord } from "@/lib/docs/client/record";
import { fileToDataUrl } from "@/lib/docs/media/base64";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import { commaList, fileUploadFields, samRequest, type JsonObject } from "@/lib/docs/media/requests";
import { SamStreamParser, samDelta, samTextOfResponse, type SamDiagnostic, type SamRecord } from "@/lib/docs/media/sam";
import { samVideoCost } from "@/lib/docs/media/video";

export interface SamBasicsProps {
  slug?: string;
  /** Media offered; the first is where it starts. */
  media?: Array<"image" | "video">;
  imageSampleId?: string;
  videoSampleId?: string;
  /** Noun phrases to start with, comma separated: one request each. */
  concepts?: string;
  videoConcepts?: string;
  maskEncoding?: "lossless" | "one_bit";
}

interface ConceptRun {
  concept: string;
  records: SamRecord[];
  diagnostics: SamDiagnostic[];
  summary: ConceptSummary | null;
  final: unknown;
  done: boolean;
  problem: string | null;
}

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";
const VIDEO_ACCEPT = "video/mp4,video/quicktime";

/**
 * The SAM API basics recipe in the browser: an image sent as a data URL, or a video uploaded with purpose=user_data
 * and referenced by file_id, one request per noun phrase, each streamed and parsed with the kit's SAM parser. The
 * result is the recipe's summary.json (outcome, record counts, boxes, decoded masks, track ranges) and an SVG per
 * mask, checked the way its validate_result is: a completed request with no masks is a valid empty match.
 */
export function SamBasics({
  media: kinds = ["image", "video"],
  imageSampleId = "street",
  videoSampleId = "street-pan",
  concepts: initialConcepts = "dog",
  videoConcepts = "dog",
  maskEncoding: initialEncoding = "lossless",
}: SamBasicsProps) {
  const id = useId();
  const runner = useDocsRun();
  const { recordRequest } = useDocsPage();
  const running = runner.state === "running";
  const [kind, setKind] = useState<"image" | "video">(kinds[0] ?? "image");
  const [image, setImage] = useState<PickedMedia | null>(null);
  const [video, setVideo] = useState<PickedMedia | null>(null);
  const [concepts, setConcepts] = useState({ image: initialConcepts, video: videoConcepts });
  const [encoding, setEncoding] = useState(initialEncoding);
  const [reuse, setReuse] = useState(true);
  const [upload, setUpload] = useState<{ fileId: string; file: PickedMedia } | null>(null);
  const [runs, setRuns] = useState<ConceptRun[]>([]);
  const [runFor, setRunFor] = useState<PickedMedia | null>(null);
  const [shownConcept, setShownConcept] = useState(0);
  const [frame, setFrame] = useState(0);
  const [phase, setPhase] = useState<string | null>(null);
  const [localError, setLocalError] = useState<DocsError | null>(null);
  const [showCode, setShowCode] = useState(false);
  const file = kind === "image" ? image : video;
  const url = useObjectUrl(file?.blob ?? null);
  const list = commaList(kind === "image" ? concepts.image : concepts.video);
  const reusable = kind === "video" && upload && upload.file === video;

  useEffect(() => {
    setShownConcept(0);
  }, [runs.length]);

  const segmentOne = async (concept: string, mediaRef: { dataUrl: string } | { fileId: string }): Promise<ConceptRun> => {
    const { path, body } = samRequest({ prompt: concept, media: mediaRef, kind, stream: true, maskEncoding: encoding });
    const parser = new SamStreamParser();
    let final: unknown = null;
    let sawDelta = false;
    let streamError: string | null = null;
    const update = (done: boolean) => {
      const out = parser.output();
      setRuns((rs) => rs.map((r) => (r.concept === concept ? { ...r, records: out.records, diagnostics: out.diagnostics, done } : r)));
    };
    const res = await runner.run(path, {
      body,
      stream: true,
      onEvent: (e) => {
        const delta = samDelta(e.json);
        if (delta !== null) {
          sawDelta = true;
          if (parser.push(delta).length) update(false);
          return;
        }
        const type = e.json?.type;
        if (type === "response.output_text.done" && !sawDelta && typeof e.json?.text === "string") {
          sawDelta = true;
          parser.push(e.json.text);
        }
        if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
          final = e.json?.response ?? null;
          if (!sawDelta && final) parser.push(samTextOfResponse(final));
        }
        if (type === "error" || e.event === "error") streamError = String((e.json?.message as string | undefined) ?? "The stream reported an error.");
      },
      // Recorded below with what SAM found, rather than the start of the wire text.
      record: false,
    });
    parser.end();
    const out = parser.output();
    recordRequest({
      method: "POST",
      path,
      body: trimForRecord(body),
      status: res.status,
      outcome: samRunOutcome({ ok: res.ok, status: res.status, aborted: res.error?.code === "aborted", error: res.error?.message, media: kind, records: out.records }),
    });
    const { outcome, problem } = samOutcome({ httpOk: res.ok, aborted: res.error?.code === "aborted", final, streamError });
    const summary = summarizeConcept(concept, kind, outcome, out.records, out.diagnostics);
    return { concept, records: out.records, diagnostics: out.diagnostics, summary, final, done: true, problem: res.ok ? problem : (res.error?.message ?? problem) };
  };

  const run = async () => {
    if (!file || !list.length) return;
    setLocalError(null);
    setRunFor(file);
    setRuns(list.map((concept) => ({ concept, records: [], diagnostics: [], summary: null, final: null, done: false, problem: null })));
    let mediaRef: { dataUrl: string } | { fileId: string };
    if (kind === "video") {
      if (reuse && reusable && upload) mediaRef = { fileId: upload.fileId };
      else {
        setPhase("Uploading the clip with purpose=user_data...");
        const form = new FormData();
        for (const [k, v] of fileUploadFields({})) form.append(k, v);
        form.append("file", file.blob, file.name);
        const res = await runner.run("files", { form });
        const fileId = (res.json as { id?: unknown } | null)?.id;
        if (!res.ok || typeof fileId !== "string") {
          setPhase(null);
          setRuns([]);
          return;
        }
        setUpload({ fileId, file });
        mediaRef = { fileId };
      }
    } else mediaRef = { dataUrl: await fileToDataUrl(file.blob, file.mime) };
    for (let i = 0; i < list.length; i++) {
      setPhase(`Segmenting "${list[i]}" (request ${i + 1} of ${list.length})...`);
      const done = await segmentOne(list[i], mediaRef);
      setRuns((rs) => rs.map((r) => (r.concept === done.concept ? done : r)));
      if (done.summary?.outcome === "stopped" || done.summary?.outcome === "http_error") break;
    }
    setPhase(null);
  };

  const summaries = runs.map((r) => r.summary).filter((s): s is ConceptSummary => !!s);
  const current = runs[shownConcept] ?? null;
  const shownRuns = runFor && runFor === file ? runs : [];
  const onFrame = useCallback((f: number) => setFrame(f), []);

  // SVG masks: every mask for an image, the current frame's for a video.
  const svgs = useMemo(() => {
    if (!current?.done) return [];
    const recs = kind === "image" ? current.records : current.records.filter((r) => r.frame === frame);
    return recs.slice(0, 16).map((r) => ({ name: maskFileName(kind, r, current.concept), svg: maskSvg(r) })).filter((m) => m.svg);
  }, [current, frame, kind]);

  const summaryJson = summaries.length ? JSON.stringify(summaries, null, 2) : "";
  // The download link's object URL is made in an effect (not during render) and revoked when the summary changes.
  const [summaryHref, setSummaryHref] = useState<string | null>(null);
  useEffect(() => {
    if (!summaryJson) {
      setSummaryHref(null);
      return;
    }
    const href = URL.createObjectURL(new Blob([summaryJson], { type: "application/json" }));
    setSummaryHref(href);
    return () => URL.revokeObjectURL(href);
  }, [summaryJson]);

  const frames = file?.frames ?? 50;
  const estimate = kind === "video" ? samVideoCost(frames) * Math.max(1, list.length) : 0.0025 * Math.max(1, list.length);
  const shownBody: JsonObject = samRequest({
    prompt: list[0] ?? "dog",
    media: kind === "video" ? { fileId: upload?.fileId ?? "file-abc123" } : { dataUrl: "data:image/jpeg;base64,<BASE64>" },
    kind,
    stream: true,
    maskEncoding: encoding,
  }).body;

  return (
    <div className={`pg ${styles.stack}`}>
      <div className="pg-bar">
        {kinds.length > 1 ? (
          <Segmented
            label="Media"
            value={kind}
            onChange={(v) => {
              setKind(v);
              setLocalError(null);
            }}
            disabled={running}
            options={kinds.map((k) => ({ value: k, label: k === "image" ? "1. Image (data URL)" : "2. Video (upload, then file_id)" }))}
          />
        ) : null}
        <ModelSelect kind="sam" value="sam-3.1" onChange={() => {}} />
      </div>

      {kind === "image" ? (
        <FilePicker key="image" label="Image" accept={IMAGE_ACCEPT} value={image} onChange={setImage} samples={["image"]} defaultSampleId={imageSampleId} preview="compact" disabled={running} />
      ) : (
        <FilePicker
          key="video"
          label="Video (MP4 or MOV with H.264, H.265 or MPEG-4, up to 3 MB here)"
          accept={VIDEO_ACCEPT}
          value={video}
          onChange={setVideo}
          samples={["video"]}
          defaultSampleId={videoSampleId}
          forSam
          preview="compact"
          disabled={running}
        />
      )}

      <Field
        id={`${id}-concepts`}
        label="Concepts (comma separated)"
        hint="Each short noun phrase is its own request, as the recipe's repeated --concept does; their summaries are combined here."
      >
        <TextInput
          id={`${id}-concepts`}
          value={kind === "image" ? concepts.image : concepts.video}
          onChange={(e) => setConcepts((c) => ({ ...c, [kind]: e.target.value }))}
          disabled={running}
        />
      </Field>

      <div className={styles.row}>
        <span className={styles.control}>
          <span className={styles.label}>Masks</span>
          <Segmented<"lossless" | "one_bit">
            size="sm"
            label="Mask encoding"
            value={encoding}
            onChange={setEncoding}
            disabled={running}
            options={[
              { value: "lossless", label: "lossless (default)" },
              { value: "one_bit", label: "one_bit" },
            ]}
          />
        </span>
        {kind === "video" && upload && upload.file === video ? (
          <Toggle id={`${id}-reuse`} label={`Reuse ${upload.fileId} (the recipe's --file-id)`} checked={reuse} onChange={setReuse} disabled={running} />
        ) : null}
      </div>

      <div className={styles.row}>
        <RunButton running={running} onRun={() => void run()} onStop={runner.abort} label="Segment" disabled={!file || !list.length || (file?.problems.length ?? 0) > 0} />
        <span className={styles.note}>
          {kind === "video"
            ? `Video is billed per frame, $0.20 per 1,000 with a 50-frame minimum: about ${formatUsd(estimate)} for ${list.length || 1} request${list.length > 1 ? "s" : ""} over ${frames} frames.`
            : `$2.50 per 1,000 images: about ${formatUsd(estimate)} for ${list.length || 1} request${list.length > 1 ? "s" : ""}.`}
        </span>
      </div>
      {phase ? (
        <p className={styles.note} aria-live="polite">
          {phase}
        </p>
      ) : null}

      <ErrorBox error={localError ?? runner.error} />

      {shownRuns.length ? (
        <div className={styles.stack} aria-live="polite">
          <ul className={styles.progressList} aria-label="Requests">
            {shownRuns.map((r, i) => {
              const v = r.summary ? validateSummary(r.summary) : null;
              return (
                <li key={r.concept} className={styles.progressItem}>
                  <Icon name={!r.done ? "refresh" : v?.ok ? "check" : "alert"} size={15} className={styles.checkIcon} />
                  <button type="button" className="link-btn" onClick={() => setShownConcept(i)} aria-pressed={i === shownConcept}>
                    {r.concept}
                  </button>
                  <span>
                    {!r.done
                      ? r.records.length
                        ? `streaming: ${new Set(r.records.map((x) => x.objectId)).size} objects on ${new Set(r.records.map((x) => x.frame)).size} frames so far`
                        : "waiting"
                      : (v?.message ?? "").replace(/^"[^"]*": /, "") + (r.problem ? ` ${r.problem}` : "")}
                  </span>
                </li>
              );
            })}
          </ul>
          {summaries.length === shownRuns.length && summaries.every((s) => s.outcome === "completed") ? (
            <p className={styles.mono}>
              {wroteLine(summaries)} {kind === "video" && upload ? `(file ${upload.fileId})` : ""}
            </p>
          ) : null}
        </div>
      ) : null}

      {file && url ? (
        <MaskOverlay
          src={url}
          media={kind}
          records={shownRuns.length ? (current?.records ?? []) : []}
          fps={file.fps ?? 24}
          frames={file.frames}
          label={current?.concept}
          alt={file.description}
          onFrame={onFrame}
        />
      ) : null}

      {running || runner.result ? (
        <ResponseView result={runner.result} running={running} elapsedMs={runner.elapsedMs} model="sam-3.1" json={current?.final ?? runner.result?.json ?? undefined} usage={(current?.final as { usage?: unknown } | null)?.usage ?? undefined}>
          <p className={styles.note}>
            {running ? "Streaming. Each output line is parsed as it arrives and drawn above." : "The overlay above shows the selected concept; summary.json and the masks are below."}
          </p>
        </ResponseView>
      ) : null}

      {summaries.length ? (
        <section className={styles.stack} aria-label="Output">
          <div className={styles.spread}>
            <span className="pg-section-label">summary.json</span>
            {summaryHref ? (
              <a className="btn btn-outline btn-sm" href={summaryHref} download="summary.json">
                <Icon name="download" size={16} />
                Download summary.json
              </a>
            ) : null}
          </div>
          <JsonTree value={summaries} openDepth={2} />
          {svgs.length ? (
            <div className={styles.tight}>
              <span className="pg-section-label">
                {kind === "image" ? "Masks" : `Masks on frame ${frame}`} as SVG ({svgs.length})
              </span>
              <div className={styles.stickers}>
                {svgs.map((m) => {
                  const href = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(m.svg!)}`;
                  return (
                    <figure key={m.name} className={styles.sticker}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img className={styles.checker} src={href} alt={`${m.name}: the mask on its frame`} />
                      <a href={href} download={m.name} className="link-btn">
                        {m.name}
                      </a>
                    </figure>
                  );
                })}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? (
        <div className={styles.stack}>
          {kind === "video" ? (
            <CodeView
              method="POST"
              path="files"
              form={[...fileUploadFields({}).map(([name, value]) => ({ name, value })), { name: "file", value: video?.name ?? "clip.mp4", file: { label: "Video", accept: VIDEO_ACCEPT } }]}
              caption="1. Upload the clip (skipped when reusing a file id)"
            />
          ) : null}
          <CodeView method="POST" path="responses" body={shownBody} stream caption={kind === "video" ? "2. Segment it by file_id, streamed (one request per concept)" : "The request Segment sends, once per concept"} />
        </div>
      ) : null}
    </div>
  );
}
