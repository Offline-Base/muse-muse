"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CodeView, DEFAULT_TEXT_MODEL, ErrorBox, ModelSelect, ResponseView, RunButton } from "@/components/docs/kit";
import { EffortSelect, Field, Segmented, TextArea, TextInput, Toggle, runOnModEnter } from "@/components/docs/kit/Field";
import { StreamView } from "@/components/docs/kit/StreamView";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { useObjectUrl } from "@/components/docs/media/hooks";
import { MaskOverlay } from "@/components/docs/media/MaskOverlay";
import {
  countsOf,
  groundingPrompt,
  IMAGE_SENDS,
  imageSendIsUrl,
  imageSendOnChat,
  imageSendUploads,
  objectList,
  tokenCountBody,
  toPixels,
  visionBody,
  type Api,
  type GroundingMode,
  type ImageSend,
} from "@/components/docs/playgrounds/media/bodies";
import styles from "@/components/docs/playgrounds/media/demos.module.css";
import { SimplePills } from "@/components/docs/playgrounds/media/SimplePills";
import { UploadCache } from "@/components/docs/playgrounds/media/upload-cache";
import { docsCall, type DocsError } from "@/lib/docs/client/api";
import type { Effort } from "@/lib/docs/client/models";
import { chatCollector, responsesCollector, type Collected } from "@/lib/docs/client/stream";
import { fileToDataUrl, formatBytes } from "@/lib/docs/media/base64";
import { downscaleImage } from "@/lib/docs/media/downscale";
import { extractJson, gridToPixels, groundingShapes } from "@/lib/docs/media/grounding";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import { fileUploadFields } from "@/lib/docs/media/requests";

export interface VisionLabPreset {
  label: string;
  /** The row of pills it sits in, such as "Ask", "Locate" or "Send". */
  group?: string;
  question?: string;
  /** Samples for the image slots (lib/docs/media/samples.ts), one slot each. */
  samples?: string[];
  /** URLs for the URL modes, one slot each. */
  urls?: string[];
  send?: ImageSend;
  api?: Api;
  /** A perception grounding preset: the prompt is the page's template for this mode with `objects`. */
  grounding?: GroundingMode;
  objects?: string[];
}

export interface VisionLabProps {
  slug?: string;
  /** The first one loads on start. */
  presets: VisionLabPreset[];
  /** The public image the URL modes start with. */
  publicUrl?: string;
  model?: string;
  models?: string[];
  /** Reasoning effort; low by default so a short answer doesn't spend its output budget on reasoning. */
  effort?: Effort | null;
  /** Most images one run sends here. The API takes up to 50 per request. */
  maxImages?: number;
}

interface Slot {
  key: number;
  sampleId?: string;
  picked: PickedMedia | null;
  url: string;
}

const SEND_LABEL: Record<ImageSend, string> = {
  data_url: "Base64 data URL",
  public_url: "Public URL",
  file_id_image: "Uploaded, input_image",
  file_id_file: "Uploaded, input_file",
  file_url: "input_file file_url",
};

const SEND_NOTE: Record<ImageSend, string> = {
  data_url: "The image bytes go inline as data:image/...;base64 in image_url. No hosting needed.",
  public_url: "image_url holds a public http or https link, and Meta fetches the image itself.",
  file_id_image: "Run uploads each image with POST /v1/files (purpose user_data), then sends an input_image part with its file_id.",
  file_id_file: "Run uploads each image with POST /v1/files (purpose user_data), then sends an input_file part with its file_id.",
  file_url: "An input_file part carries file_url, a public URL the server fetches for you. Responses API only.",
};

const MODE_LABEL: Record<GroundingMode, string> = { point: "Point", box: "Box", count: "Count" };
const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
/** Longest sides the token comparison measures, from a thumbnail up to what the picker sends. */
const SIZES = [64, 256, 512, 1024];

interface SizeRow {
  label: string;
  width: number;
  height: number;
  bytes: number;
  tokens: number | null;
}

let slotKeys = 0;

function slotsFor(p: VisionLabPreset, publicUrl: string): Slot[] {
  const n = Math.max(1, p.samples?.length ?? 0, p.urls?.length ?? 0);
  return Array.from({ length: n }, (_, i) => ({
    key: ++slotKeys,
    sampleId: p.samples?.[i] ?? (i === 0 ? "street" : undefined),
    picked: null,
    url: p.urls?.[i] ?? (i === 0 ? publicUrl : ""),
  }));
}

/**
 * Image understanding as the page teaches it: one or more images and a question on the Responses API or Chat
 * Completions, with every way an image can go in (base64 data URL, public URL, an uploaded file's id in input_image
 * or input_file, input_file's file_url), the page's point, box and count grounding prompts drawn over the image on
 * the 0 to 1000 grid, and free input token counts from POST /v1/responses/input_tokens, including how the count
 * grows with resolution.
 */
export function VisionLab({
  presets,
  publicUrl = "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c9/Avocado_Hass_-_single_and_halved.jpg/1280px-Avocado_Hass_-_single_and_halved.jpg",
  model: initialModel = DEFAULT_TEXT_MODEL,
  models,
  effort: initialEffort = "low",
  maxImages = 4,
}: VisionLabProps) {
  const id = useId();
  const first = presets[0] ?? { label: "Describe", question: "What is in this image?" };
  const runner = useDocsRun();
  const uploader = useDocsRun();
  const counter = useDocsRun();
  const [model, setModel] = useState(initialModel);
  const [effort, setEffort] = useState<Effort | null>(initialEffort);
  const [api, setApiState] = useState<Api>(first.api ?? "responses");
  const [send, setSend] = useState<ImageSend>(first.send ?? "data_url");
  const [slots, setSlots] = useState<Slot[]>(() => slotsFor(first, publicUrl));
  const [grounding, setGrounding] = useState<GroundingMode | null>(first.grounding ?? null);
  const [objects, setObjects] = useState((first.objects ?? []).join(", "));
  const [question, setQuestion] = useState(first.grounding ? groundingPrompt(first.grounding, first.objects ?? []) : (first.question ?? ""));
  const [preset, setPreset] = useState<number | null>(presets.length ? 0 : null);
  const [live, setLive] = useState<Collected | null>(null);
  const [localError, setLocalError] = useState<DocsError | null>(null);
  const [shown, setShown] = useState<{ src: string | null; blob: Blob | null; grounding: GroundingMode | null } | null>(null);
  const [mediaSize, setMediaSize] = useState<{ width: number; height: number } | null>(null);
  const [tokens, setTokens] = useState<{ total: number; textOnly: number | null } | null>(null);
  const [sizeRows, setSizeRows] = useState<SizeRow[] | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [urlBroken, setUrlBroken] = useState<Record<number, boolean>>({});
  // Uploads are reused while their picked file stays the same and the upload is under an hour old.
  const uploaded = useRef(new UploadCache<PickedMedia>());
  const [lastIds, setLastIds] = useState<string[]>([]);
  const shownBlobUrl = useObjectUrl(shown?.blob ?? null);

  const groups = useMemo(() => {
    const order: string[] = [];
    const by = new Map<string, number[]>();
    presets.forEach((p, i) => {
      const g = p.group ?? "Try";
      if (!by.has(g)) {
        by.set(g, []);
        order.push(g);
      }
      by.get(g)!.push(i);
    });
    return order.map((g) => ({ label: g, indexes: by.get(g)! }));
  }, [presets]);

  const running = runner.state === "running" || uploader.state === "running";
  const counting = counter.state === "running" || measuring;
  const busy = running || counting;
  const urlMode = imageSendIsUrl(send);
  const pickedSlots = slots.filter((s) => s.picked);
  const problems = urlMode ? [] : pickedSlots.flatMap((s) => s.picked!.problems);
  const ready = urlMode ? slots.some((s) => s.url.trim()) : pickedSlots.length > 0;
  const chatBlocked = api === "chat" && !imageSendOnChat(send);

  const resetOutput = () => {
    runner.reset();
    counter.reset();
    setLive(null);
    setLocalError(null);
    setShown(null);
    setTokens(null);
    setSizeRows(null);
  };

  const setApi = (next: Api) => {
    setApiState(next);
    // Chat Completions takes a URL or a data URL in image_url.url; file ids and file_url are Responses parts.
    if (next === "chat" && !imageSendOnChat(send)) setSend(imageSendIsUrl(send) ? "public_url" : "data_url");
  };

  const applyPreset = (i: number) => {
    const p = presets[i];
    setPreset(i);
    setApiState(p.api ?? "responses");
    setSend(p.send ?? "data_url");
    setSlots(slotsFor(p, publicUrl));
    setGrounding(p.grounding ?? null);
    setObjects((p.objects ?? []).join(", "));
    setQuestion(p.grounding ? groundingPrompt(p.grounding, p.objects ?? []) : (p.question ?? ""));
    setUrlBroken({});
    resetOutput();
  };

  const changeGrounding = (mode: GroundingMode | null, list = objects) => {
    setGrounding(mode);
    if (mode) setQuestion(groundingPrompt(mode, objectList(list)));
  };

  /** Each slot's value for the request: its URL, a data URL, or (after uploading it) its file id. */
  const resolveImages = async (): Promise<string[] | null> => {
    if (urlMode) return slots.map((s) => s.url.trim()).filter(Boolean);
    const picked = slots.map((s) => s.picked).filter((p): p is PickedMedia => !!p);
    if (!imageSendUploads(send)) return Promise.all(picked.map((p) => fileToDataUrl(p.blob, p.mime)));
    const ids: string[] = [];
    for (const p of picked) {
      const known = uploaded.current.get(p);
      if (known) {
        ids.push(known);
        continue;
      }
      const form = new FormData();
      for (const [k, v] of fileUploadFields({})) form.append(k, v);
      form.append("file", p.blob, p.name);
      const up = await uploader.run("files", { form, record: false });
      const fileId = (up.json as { id?: unknown } | null)?.id;
      if (!up.ok || typeof fileId !== "string") {
        setLocalError(up.error ?? { message: "The upload didn't return a file id." });
        return null;
      }
      uploaded.current.set(p, fileId);
      ids.push(fileId);
    }
    setLastIds(ids);
    return ids;
  };

  /** After a 404 the ids sent are gone (expired, or owned by an older cookie): the next run uploads the files again. */
  const forgetUploadsAfter = (status: number) => {
    if (status !== 404 || !imageSendUploads(send)) return;
    for (const s of slots) if (s.picked) uploaded.current.forget(s.picked);
  };

  const run = async () => {
    if (busy || !ready || !question.trim() || chatBlocked) return;
    resetOutput();
    const images = await resolveImages();
    if (!images?.length) return;
    const head = slots[0];
    setMediaSize(null);
    setShown({ src: urlMode ? head.url.trim() : null, blob: urlMode ? null : (head.picked?.blob ?? null), grounding });
    const { path, body } = visionBody({ model, api, question, send, images, effort, stream: true });
    const collector = api === "chat" ? chatCollector() : responsesCollector();
    const res = await runner.run(path, {
      body,
      stream: true,
      onEvent: (e) => {
        collector.push(e);
        setLive(collector.snapshot());
      },
    });
    forgetUploadsAfter(res.status);
  };

  const countTokens = async () => {
    if (busy || !ready) return;
    setTokens(null);
    setSizeRows(null);
    setLocalError(null);
    const images = await resolveImages();
    if (!images?.length) return;
    // The same question with no image, so the image's share can be told apart from the text and formatting.
    const base = await docsCall<{ input_tokens?: number }>("responses/input_tokens", { body: tokenCountBody(model, question, send, []) });
    const res = await counter.run("responses/input_tokens", { body: tokenCountBody(model, question, send, images) });
    forgetUploadsAfter(res.status);
    const total = (res.json as { input_tokens?: unknown } | null)?.input_tokens;
    if (res.ok && typeof total === "number") setTokens({ total, textOnly: typeof base.json?.input_tokens === "number" ? base.json.input_tokens : null });
  };

  /** Counts the first image at several sizes (all free), to show cost following resolution. */
  const compareSizes = async () => {
    const picked = slots[0]?.picked;
    if (busy || !picked) return;
    setMeasuring(true);
    setTokens(null);
    setLocalError(null);
    try {
      const base = await docsCall<{ input_tokens?: number }>("responses/input_tokens", { body: tokenCountBody(model, question, "data_url", []) });
      const textOnly = typeof base.json?.input_tokens === "number" ? base.json.input_tokens : 0;
      if (!base.ok) {
        setLocalError(base.error);
        return;
      }
      const longest = Math.max(picked.width ?? 0, picked.height ?? 0);
      const sizes = [...SIZES.filter((s) => !longest || s < longest), 0];
      const rows: SizeRow[] = [];
      for (const side of sizes) {
        const img = side ? await downscaleImage(picked.blob, { maxSide: side, maxDataUrl: 8 * 1024 * 1024 }) : null;
        const blob = img?.blob ?? picked.blob;
        const mime = img?.mime ?? picked.mime;
        const dataUrl = await fileToDataUrl(blob, mime);
        const res = await docsCall<{ input_tokens?: number }>("responses/input_tokens", { body: tokenCountBody(model, question, "data_url", [dataUrl]) });
        if (!res.ok) {
          setLocalError(res.error);
          break;
        }
        const n = typeof res.json?.input_tokens === "number" ? res.json.input_tokens : null;
        rows.push({
          label: side ? `${side} px` : "As sent",
          width: img?.width ?? picked.width ?? 0,
          height: img?.height ?? picked.height ?? 0,
          bytes: blob.size,
          tokens: n === null ? null : n - textOnly,
        });
        setSizeRows([...rows]);
      }
    } finally {
      setMeasuring(false);
    }
  };

  // The request as code: placeholders for inline bytes, the real ids once uploaded.
  const code = useMemo(() => {
    const n = Math.max(1, urlMode ? slots.filter((s) => s.url.trim()).length : pickedSlots.length);
    const values = Array.from({ length: n }, (_, i) =>
      urlMode
        ? slots.filter((s) => s.url.trim())[i]?.url.trim() || publicUrl
        : imageSendUploads(send)
          ? (lastIds[i] ?? "file-abc123")
          : `data:${pickedSlots[i]?.picked?.mime ?? "image/jpeg"};base64,<BASE64>`,
    );
    return { request: visionBody({ model, api, question, send, images: values, effort, stream: true }), count: tokenCountBody(model, question, send, values) };
  }, [urlMode, slots, pickedSlots, send, lastIds, publicUrl, model, api, question, effort]);

  const overlaySrc = shown ? (shown.src ?? shownBlobUrl) : null;
  const parsed = useMemo(() => (shown?.grounding && live?.text ? extractJson(live.text) : null), [shown?.grounding, live?.text]);
  const grid = useMemo(() => (parsed ? groundingShapes(parsed) : []), [parsed]);
  const pixels = useMemo(() => (mediaSize ? gridToPixels(grid, mediaSize.width, mediaSize.height) : []), [grid, mediaSize]);
  const counts = useMemo(() => (shown?.grounding === "count" && parsed ? countsOf(parsed) : []), [shown?.grounding, parsed]);
  const done = runner.state === "done" || runner.state === "error";

  // A new picked file can't reuse a stale size from the last overlay.
  useEffect(() => setMediaSize(null), [overlaySrc]);

  const updateSlot = (key: number, change: Partial<Slot>) => setSlots((list) => list.map((s) => (s.key === key ? { ...s, ...change } : s)));

  return (
    <div className={`pg ${styles.lab}`}>
      <div className={styles.stack}>
        {groups.map((g, row) => (
          <SimplePills
            key={g.label}
            advanced={row > 0}
            label={g.label}
            presets={g.indexes.map((i) => presets[i])}
            active={preset !== null && g.indexes.includes(preset) ? g.indexes.indexOf(preset) : null}
            onPick={(j) => applyPreset(g.indexes[j])}
            disabled={busy}
          />
        ))}
      </div>

      <div className="pg-bar">
        <ModelSelect kind="vision" value={model} onChange={setModel} allow={models} disabled={busy} />
      </div>
      <div className={`${styles.controls} pg-advanced`}>
        <span className={styles.inline}>
          <span className={styles.label}>API</span>
          <Segmented<Api>
            size="sm"
            label="API"
            value={api}
            onChange={setApi}
            disabled={busy}
            options={[
              { value: "responses", label: "Responses" },
              { value: "chat", label: "Chat Completions" },
            ]}
          />
        </span>
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={busy} />
      </div>

      <div className={`${styles.stack} pg-advanced`}>
        <span className={`${styles.inline} ${styles.segWrap}`}>
          <span className={styles.label}>Send the image as</span>
          <Segmented<ImageSend>
            size="sm"
            label="How the image is sent"
            value={send}
            onChange={(s) => {
              setSend(s);
              setUrlBroken({});
            }}
            disabled={busy}
            options={IMAGE_SENDS.map((s) => ({ value: s, label: SEND_LABEL[s], disabled: api === "chat" && !imageSendOnChat(s) }))}
          />
        </span>
        <p className={styles.note}>
          {SEND_NOTE[send]}
          {api === "chat" ? " On Chat Completions the image goes in an image_url object: {\"url\": ...}." : ""}
        </p>
      </div>

      <div className={styles.stack}>
        {slots.map((s, i) => (
          <div key={s.key} className={slots.length > 1 ? styles.card : undefined}>
            {slots.length > 1 ? (
              <div className={styles.cardHead}>
                <span className={styles.cardTitle}>Image {i + 1}</span>
                {i > 0 ? (
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setSlots((list) => list.filter((x) => x.key !== s.key))} disabled={busy}>
                    Remove
                  </button>
                ) : null}
              </div>
            ) : null}
            {urlMode ? (
              <div className={styles.stack}>
                <Field id={`${id}-url-${s.key}`} label={slots.length > 1 ? "Image URL" : "Public image URL"} hint="Meta's servers fetch it, so it has to be public. Local files need the data URL or upload modes.">
                  <TextInput
                    id={`${id}-url-${s.key}`}
                    className={styles.urlInput}
                    value={s.url}
                    placeholder="https://example.com/photo.jpg"
                    spellCheck={false}
                    onChange={(e) => {
                      updateSlot(s.key, { url: e.target.value });
                      setUrlBroken((b) => ({ ...b, [s.key]: false }));
                    }}
                    disabled={busy}
                    aria-describedby={`${id}-url-${s.key}-hint`}
                  />
                </Field>
                {/^https?:\/\//.test(s.url.trim()) ? (
                  urlBroken[s.key] ? (
                    <p className={styles.note}>Your browser couldn&apos;t show this URL. Meta fetches it itself, so it may still work.</p>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className={styles.urlPreview} src={s.url.trim()} alt={`Image ${i + 1} from the URL`} onError={() => setUrlBroken((b) => ({ ...b, [s.key]: true }))} />
                  )
                ) : null}
              </div>
            ) : (
              <FilePicker
                key={s.key}
                label={slots.length > 1 ? undefined : "Image"}
                accept={IMAGE_ACCEPT}
                value={s.picked}
                onChange={(f) => updateSlot(s.key, { picked: f })}
                samples={["image"]}
                defaultSampleId={s.sampleId}
                preview={slots.length > 1 ? "compact" : "full"}
                disabled={busy}
              />
            )}
          </div>
        ))}
        {slots.length < maxImages ? (
          <div className={`${styles.row} pg-advanced`}>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => setSlots((list) => [...list, { key: ++slotKeys, picked: null, url: "" }])}
              disabled={busy}
            >
              Add an image
            </button>
            <span className={styles.note}>Up to {maxImages} here; the API takes up to 50 images per request, each one more content part.</span>
          </div>
        ) : null}
      </div>

      <div className={`${styles.controls} pg-advanced`}>
        <span className={styles.inline}>
          <span className={styles.label}>Grounding</span>
          <Segmented<"off" | GroundingMode>
            size="sm"
            label="Perception grounding mode"
            value={grounding ?? "off"}
            onChange={(v) => changeGrounding(v === "off" ? null : v)}
            disabled={busy}
            options={[
              { value: "off", label: "Off" },
              ...(["point", "box", "count"] as const).map((m) => ({ value: m, label: MODE_LABEL[m] })),
            ]}
          />
        </span>
      </div>
      {grounding ? (
        <Field id={`${id}-objects`} className="pg-advanced" label="Objects to find" hint="Comma separated. The question below is the page's prompt for this mode with your objects.">
          <TextInput
            id={`${id}-objects`}
            value={objects}
            onChange={(e) => {
              setObjects(e.target.value);
              changeGrounding(grounding, e.target.value);
            }}
            disabled={busy}
            aria-describedby={`${id}-objects-hint`}
          />
        </Field>
      ) : null}
      <Field id={`${id}-q`} label="Question">
        <TextArea id={`${id}-q`} value={question} rows={grounding ? 6 : 3} onChange={(e) => setQuestion(e.target.value)} onKeyDown={runOnModEnter(() => void run())} disabled={busy} />
      </Field>

      <div className={styles.spread}>
        <div className={`${styles.row} pg-advanced`}>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => void countTokens()} disabled={busy || !ready}>
            {counter.state === "running" ? "Counting..." : "Count input tokens"}
          </button>
          {!urlMode && slots[0]?.picked ? (
            <button type="button" className="btn btn-outline btn-sm" onClick={() => void compareSizes()} disabled={busy}>
              {measuring ? "Measuring..." : "Compare sizes"}
            </button>
          ) : null}
        </div>
        <RunButton
          running={running}
          onRun={() => void run()}
          onStop={() => {
            runner.abort();
            uploader.abort();
          }}
          disabled={!ready || !question.trim() || problems.length > 0 || chatBlocked || counting}
        />
      </div>

      {!tokens && !sizeRows ? (
        <p className={`${styles.note} pg-advanced`}>
          Counting is free: POST /v1/responses/input_tokens counts the same input without generating.
          {!urlMode && slots[0]?.picked ? " Compare sizes counts the first image at several sizes, to show cost following resolution." : ""}
        </p>
      ) : null}
      {tokens ? (
        <p className={styles.note} role="status">
          <strong className={styles.num}>{tokens.total.toLocaleString("en-US")}</strong> input tokens
          {tokens.textOnly !== null ? (
            <>
              : {tokens.textOnly.toLocaleString("en-US")} for the text and formatting, {(tokens.total - tokens.textOnly).toLocaleString("en-US")} for the{" "}
              {slots.length > 1 ? "images" : "image"}.
            </>
          ) : (
            "."
          )}
        </p>
      ) : null}
      <ErrorBox error={counter.error} />
      {sizeRows ? (
        <div className={styles.tableWrap} aria-live="polite">
          <table className={styles.table}>
            <caption className="sr-only">Input tokens for the first image at each size</caption>
            <thead>
              <tr>
                <th>Size</th>
                <th>Pixels</th>
                <th className={styles.right}>Bytes</th>
                <th className={styles.right}>Image tokens</th>
              </tr>
            </thead>
            <tbody>
              {sizeRows.map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td className={styles.num}>
                    {r.width} x {r.height}
                  </td>
                  <td className={`${styles.right} ${styles.num}`}>{formatBytes(r.bytes)}</td>
                  <td className={`${styles.right} ${styles.num}`}>{r.tokens === null ? "?" : r.tokens.toLocaleString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <ErrorBox error={localError ?? uploader.error ?? runner.error} />
      {running || runner.result ? (
        <ResponseView result={runner.result} running={running} elapsedMs={runner.elapsedMs} json={live?.final ?? undefined} usage={live?.usage ?? undefined}>
          <StreamView text={live?.text ?? ""} reasoning={live?.reasoning} refusal={live?.refusal} running={running} placeholder={uploader.state === "running" ? "Uploading the image..." : undefined} />
          {shown?.grounding && done && live?.text ? (
            <GroundingResult
              src={overlaySrc}
              mode={shown.grounding}
              grid={grid}
              pixels={pixels}
              counts={counts}
              size={mediaSize}
              onSize={setMediaSize}
            />
          ) : null}
        </ResponseView>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? (
        <div className={styles.stack}>
          <CodeView method="POST" path={code.request.path} body={code.request.body} stream caption="The request Run sends" />
          {imageSendUploads(send) ? <p className={styles.note}>Before it, each image is uploaded with POST /v1/files and purpose user_data. File handling shows that call.</p> : null}
          <CodeView method="POST" path="responses/input_tokens" body={code.count} caption="The token count (free, and always in the Responses shape)" />
        </div>
      ) : null}
    </div>
  );
}

function GroundingResult({
  src,
  mode,
  grid,
  pixels,
  counts,
  size,
  onSize,
}: {
  src: string | null;
  mode: GroundingMode;
  grid: ReturnType<typeof groundingShapes>;
  pixels: ReturnType<typeof gridToPixels>;
  counts: ReturnType<typeof countsOf>;
  size: { width: number; height: number } | null;
  onSize(size: { width: number; height: number }): void;
}) {
  if (!grid.length) {
    return <p className={styles.note}>No boxes or points on the 0 to 1000 grid in this reply, so there&apos;s nothing to draw. Try again, or name fewer objects.</p>;
  }
  return (
    <div className={styles.stack}>
      {src ? <MaskOverlay src={src} media="image" shapes={pixels} alt="The image you sent, with the reply's grounding drawn on it" onMediaSize={onSize} /> : null}
      {counts.length ? (
        <p className={styles.note}>
          Counted: {counts.map((c) => `${c.name} ${c.count}${c.points && c.points !== c.count ? ` (${c.points} points)` : ""}`).join(", ")}.
        </p>
      ) : null}
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className="sr-only">Grounding results on the 0 to 1000 grid and in pixels</caption>
          <thead>
            <tr>
              <th>Object</th>
              <th>{mode === "box" ? "Box" : "Point"} (0 to 1000)</th>
              <th>Pixels{size ? ` (${size.width} x ${size.height} image)` : ""}</th>
            </tr>
          </thead>
          <tbody>
            {grid.slice(0, 40).map((g, i) => {
              const a = size ? toPixels(g.kind === "box" ? g.x1 : g.x, g.kind === "box" ? g.y1 : g.y, size.width, size.height) : null;
              const b = size && g.kind === "box" ? toPixels(g.x2, g.y2, size.width, size.height) : null;
              return (
                <tr key={i}>
                  <td>{g.label || "object"}</td>
                  <td className={`${styles.mono} ${styles.num}`}>{g.kind === "box" ? `[${g.x1}, ${g.y1}, ${g.x2}, ${g.y2}]` : `(${g.x}, ${g.y})`}</td>
                  <td className={`${styles.mono} ${styles.num}`}>{a ? (b ? `[${a.x}, ${a.y}, ${b.x}, ${b.y}]` : `(${a.x}, ${a.y})`) : "..."}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className={styles.note}>
        Pixels use the page&apos;s to_pixels: value x size / 1000 of the image that was sent, clamped to its edges.
      </p>
    </div>
  );
}
