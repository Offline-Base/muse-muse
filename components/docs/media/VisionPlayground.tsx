"use client";

import { useId, useMemo, useState } from "react";
import { CodeView, ErrorBox, ModelSelect, ResponseView, RunButton, DEFAULT_TEXT_MODEL } from "@/components/docs/kit";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { Field, PresetPills, Segmented, TextArea, Toggle } from "@/components/docs/kit/Field";
import { StreamView } from "@/components/docs/kit/StreamView";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { MaskOverlay } from "@/components/docs/media/MaskOverlay";
import { useObjectUrl } from "@/components/docs/media/hooks";
import styles from "@/components/docs/media/media.module.css";
import { docsCall, type DocsError } from "@/lib/docs/client/api";
import { chatCollector, responsesCollector, type Collected } from "@/lib/docs/client/stream";
import { fileToDataUrl } from "@/lib/docs/media/base64";
import { extractJson, gridToPixels, groundingShapes } from "@/lib/docs/media/grounding";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import { fileUploadFields, visionRequest, type JsonObject, type MediaRef } from "@/lib/docs/media/requests";
import { sampleById } from "@/lib/docs/media/samples";

export interface VisionPreset {
  label: string;
  question: string;
  /** Switch the picker to this sample. */
  sampleId?: string;
  extraBody?: JsonObject;
}

export interface VisionPlaygroundProps {
  slug?: string;
  /** The question to start with. */
  question?: string;
  /** The image sample picked on load (lib/docs/media/samples.ts). Defaults to the fridge. */
  sampleId?: string;
  /** Samples the picker offers: ids or kinds. Defaults to every image sample. */
  samples?: string[];
  /** input_image detail. Omitted from the request unless set. */
  detail?: "auto" | "low" | "high";
  /** "responses" (input_image parts, the default) or "chat" (Chat Completions image_url parts). */
  api?: "responses" | "chat";
  /** Offer a Responses / Chat Completions switch. */
  apiSwitch?: boolean;
  /** Merged into the request body, such as { text: { format: { type: "json_schema", ... } } }. */
  extraBody?: JsonObject;
  /** Show the extra body as editable JSON. Defaults to true when extraBody is set. */
  editExtraBody?: boolean;
  presets?: VisionPreset[];
  model?: string;
  /** Limit the model menu to these ids. */
  models?: string[];
  /** Draw the boxes and points a reply gives on the 0 to 1000 grid over the image (perception grounding). */
  grounding?: boolean;
  /** Offer a second image, for questions across two images. */
  secondImage?: boolean;
  /** "inline" sends a data URL (the default); "file" uploads with POST /v1/files, then sends the file_id. */
  send?: "inline" | "file";
  /** Stream the reply (default true). */
  stream?: boolean;
  maxOutputTokens?: number;
}

const PLACEHOLDER: MediaRef = { dataUrl: "data:image/jpeg;base64,<BASE64>" };

/**
 * Ask about an image: a photo, chart, screenshot or receipt from the picker or our samples, plus a question, on the
 * Responses API (input_image) or Chat Completions (image_url). Optional detail, extra body (a JSON schema for
 * structured output), and an overlay that draws perception grounding boxes from the reply.
 */
export function VisionPlayground({
  question: initialQuestion = "What's in this image? List the main things you see.",
  sampleId = "fridge",
  samples,
  detail: initialDetail,
  api: initialApi = "responses",
  apiSwitch = false,
  extraBody,
  editExtraBody,
  presets = [],
  model: initialModel = DEFAULT_TEXT_MODEL,
  models,
  grounding = false,
  secondImage = false,
  send = "inline",
  stream = true,
  maxOutputTokens,
}: VisionPlaygroundProps) {
  const id = useId();
  const runner = useDocsRun();
  const [showCode, setShowCode] = useState(false);
  const [model, setModel] = useState(initialModel);
  const [api, setApi] = useState<"responses" | "chat">(initialApi);
  const [image, setImage] = useState<PickedMedia | null>(null);
  const [image2, setImage2] = useState<PickedMedia | null>(null);
  const [question, setQuestion] = useState(initialQuestion);
  const [detail, setDetail] = useState<"none" | "auto" | "low" | "high">(initialDetail ?? "none");
  const [extraText, setExtraText] = useState(extraBody ? JSON.stringify(extraBody, null, 2) : "");
  const [preset, setPreset] = useState<number | null>(null);
  const [live, setLive] = useState<Collected | null>(null);
  const [localError, setLocalError] = useState<DocsError | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [sent, setSent] = useState<{ width: number; height: number; blob: Blob } | null>(null);
  const [pickerSample, setPickerSample] = useState(sampleId);
  const sentUrl = useObjectUrl(sent?.blob ?? null);

  const extra = useMemo<{ value: JsonObject | null; error: string | null }>(() => {
    if (!extraText.trim()) return { value: null, error: null };
    try {
      const v = JSON.parse(extraText) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? { value: v as JsonObject, error: null } : { value: null, error: "The extra body must be a JSON object." };
    } catch {
      return { value: null, error: "The extra body isn't valid JSON yet." };
    }
  }, [extraText]);

  const shown = useMemo(() => {
    const ref: MediaRef = send === "file" ? { fileId: uploaded ?? "file-abc123" } : PLACEHOLDER;
    return visionRequest({
      model,
      question,
      images: secondImage && image2 ? [ref, ref] : [ref],
      detail: detail === "none" ? undefined : detail,
      api,
      stream,
      maxOutputTokens,
      extraBody: extra.value,
    });
  }, [send, uploaded, model, question, secondImage, image2, detail, api, stream, maxOutputTokens, extra.value]);

  const running = runner.state === "running" || uploading;
  const problems = [...(image?.problems ?? []), ...(image2?.problems ?? [])];

  const run = async () => {
    if (!image) return;
    setLocalError(null);
    setLive(null);
    if (extra.error) return setLocalError({ message: extra.error });
    const picked = [image, ...(secondImage && image2 ? [image2] : [])];
    let refs: MediaRef[];
    if (send === "file") {
      refs = [];
      for (const p of picked) {
        const form = new FormData();
        for (const [k, v] of fileUploadFields({})) form.append(k, v);
        form.append("file", p.blob, p.name);
        setUploading(true);
        const up = await docsCall<{ id?: string }>("files", { form }).finally(() => setUploading(false));
        if (!up.ok || !up.json?.id) return setLocalError(up.error ?? { message: "The upload didn't return a file id." });
        setUploaded(up.json.id);
        refs.push({ fileId: up.json.id });
      }
    } else {
      refs = await Promise.all(picked.map(async (p) => ({ dataUrl: await fileToDataUrl(p.blob, p.mime) })));
    }
    const { path, body } = visionRequest({
      model,
      question,
      images: refs,
      detail: detail === "none" ? undefined : detail,
      api,
      stream,
      maxOutputTokens,
      extraBody: extra.value,
    });
    setSent({ width: image.width ?? 0, height: image.height ?? 0, blob: image.blob });
    const collector = api === "chat" ? chatCollector() : responsesCollector();
    const res = await runner.run(path, {
      body,
      stream,
      onEvent: (e) => {
        collector.push(e);
        setLive(collector.snapshot());
      },
    });
    if (!stream && res.json && typeof res.json === "object") {
      collector.push(res.json as Record<string, unknown>);
      setLive(collector.snapshot());
    }
  };

  const shapes = useMemo(() => {
    if (!grounding || !live?.text || !sent?.width || !sent.height) return [];
    return gridToPixels(groundingShapes(extractJson(live.text)), sent.width, sent.height);
  }, [grounding, live?.text, sent]);

  return (
    <div className={`pg ${styles.playground}`}>
      <div className="pg-bar">
        <ModelSelect kind="vision" value={model} onChange={setModel} allow={models} disabled={running} />
      </div>
      <PresetPills
        presets={presets}
        active={preset}
        disabled={running}
        onPick={(i) => {
          const p = presets[i];
          setPreset(i);
          setQuestion(p.question);
          if (p.extraBody) setExtraText(JSON.stringify(p.extraBody, null, 2));
          if (p.sampleId && sampleById(p.sampleId) && p.sampleId !== image?.sampleId) {
            setImage(null);
            setPickerSample(p.sampleId);
          }
        }}
      />
      <FilePicker
        key={pickerSample}
        label={secondImage ? "First image" : "Image"}
        accept="image/png,image/jpeg,image/webp,image/gif"
        value={image}
        onChange={setImage}
        samples={samples ?? ["image"]}
        defaultSampleId={pickerSample}
        disabled={running}
      />
      {secondImage ? (
        <div className="pg-advanced">
          <FilePicker label="Second image" accept="image/png,image/jpeg,image/webp,image/gif" value={image2} onChange={setImage2} samples={samples ?? ["image"]} disabled={running} />
        </div>
      ) : null}
      <Field id={`${id}-q`} label="Question">
        <TextArea id={`${id}-q`} value={question} rows={3} onChange={(e) => setQuestion(e.target.value)} disabled={running} />
      </Field>
      <div className={`${styles.options} pg-advanced`}>
        <span className={styles.inline}>
          <span className={styles.label}>Detail</span>
          <Segmented<"none" | "auto" | "low" | "high">
            size="sm"
            label="Image detail"
            value={detail}
            onChange={setDetail}
            disabled={running}
            options={[
              { value: "none", label: "Not set" },
              { value: "auto", label: "auto" },
              { value: "low", label: "low" },
              { value: "high", label: "high" },
            ]}
          />
        </span>
        {apiSwitch ? (
          <span className={styles.inline}>
            <span className={styles.label}>API</span>
            <Segmented<"responses" | "chat">
              size="sm"
              label="API"
              value={api}
              onChange={setApi}
              disabled={running}
              options={[
                { value: "responses", label: "Responses" },
                { value: "chat", label: "Chat Completions" },
              ]}
            />
          </span>
        ) : null}
      </div>
      {editExtraBody ?? !!extraBody ? (
        <Field id={`${id}-extra`} className="pg-advanced" label="Extra body (merged into the request)" hint={extra.error ?? "For example a text.format JSON schema for structured output."}>
          <TextArea id={`${id}-extra`} className={styles.mono} value={extraText} rows={8} spellCheck={false} onChange={(e) => setExtraText(e.target.value)} disabled={running} />
        </Field>
      ) : null}
      <div className={styles.spread}>
        <RunButton running={running} onRun={() => void run()} onStop={runner.abort} disabled={!image || !question.trim() || problems.length > 0} />
      </div>
      {send === "file" ? (
        <p className={`${styles.note} pg-advanced`}>
          The image is uploaded with POST /v1/files first{uploaded ? ` (${uploaded})` : ""}, then the question references its file_id. Demo files are deleted within an hour.
        </p>
      ) : null}
      <ErrorBox error={localError ?? runner.error} />
      {running || runner.result ? (
        <ResponseView
          result={runner.result}
          running={running}
          elapsedMs={runner.elapsedMs}
          json={live?.final ?? undefined}
          usage={live?.usage ?? undefined}
        >
          <StreamView text={live?.text ?? ""} reasoning={live?.reasoning} refusal={live?.refusal} running={running} />
          {grounding && sentUrl && !running ? (
            shapes.length ? (
              <MaskOverlay src={sentUrl} media="image" shapes={shapes} alt={image?.description ?? "The image you sent"} />
            ) : (
              <p className={styles.note}>No boxes or points on the 0 to 1000 grid in this reply, so there&apos;s nothing to draw.</p>
            )
          ) : null}
        </ResponseView>
      ) : null}
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path={shown.path} body={shown.body} stream={stream} caption="The request Run sends" /> : null}
    </div>
  );
}
