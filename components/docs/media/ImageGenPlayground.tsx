"use client";

import { useId, useState } from "react";
import { CodeView, ErrorBox, ModelSelect, ResponseView, RunButton } from "@/components/docs/kit";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { Field, PresetPills, Segmented, TextArea, Toggle } from "@/components/docs/kit/Field";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { ImageOutput, type OutputImage } from "@/components/docs/media/ImageOutput";
import styles from "@/components/docs/media/media.module.css";
import type { DocsError } from "@/lib/docs/client/api";
import type { FormSpec } from "@/lib/docs/client/form";
import { fileToDataUrl } from "@/lib/docs/media/base64";
import { imagesOfImagesReply, imagesOfResponse, reasoningOfResponse } from "@/lib/docs/media/images";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import {
  imageTurnRequest,
  imagesEditFormFields,
  imagesEditJsonRequest,
  imagesGenerationRequest,
  type ImageToolSettings,
  type MediaRef,
} from "@/lib/docs/media/requests";

export type ImageGenMode = "responses" | "generations" | "edits";

export interface ImageGenPlaygroundProps {
  slug?: string;
  /** The modes offered; the first is where it starts. */
  modes?: ImageGenMode[];
  prompt?: string;
  /** The prompt edits mode starts with. */
  editPrompt?: string;
  /** Follow-up suggestions for the conversation ("now make it night"), shown as pills after the first turn. */
  followUps?: string[];
  /** Requested shape ("1536x1024"). It sets only the aspect ratio. */
  size?: string;
  sizes?: string[];
  /** Images per images/generations or images/edits call (the demos allow 1 or 2). */
  n?: number;
  outputFormat?: "webp" | "png" | "jpeg";
  reasoningStrength?: "low" | "high";
  /** Start with these of Muse Image's built-in tools switched off. */
  toolsOff?: Array<"image_search" | "web_search" | "shell">;
  /** Samples offered for edits and for reference images (ids or kinds). */
  editSampleIds?: string[];
  /** The edit image picked on load. Defaults to the sneaker. */
  editSampleId?: string;
  /** Offer reference images on the conversational mode. Default true. */
  references?: boolean;
  /** images/edits body: Meta's JSON (an images array) or multipart (as the OpenAI SDK sends). */
  editBody?: "json" | "multipart";
}

const MODE_LABEL: Record<ImageGenMode, string> = {
  responses: "Conversation (Responses)",
  generations: "Generate (images/generations)",
  edits: "Edit (images/edits)",
};

const SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536", "1792x1024"];
const PLACEHOLDER: MediaRef = { dataUrl: "data:image/jpeg;base64,<BASE64>" };

interface Turn {
  prompt: string;
  responseId: string | null;
  images: OutputImage[];
  reasoning: string;
}

/**
 * Muse Image three ways: a conversation on the Responses API where each follow-up edits the last image through
 * previous_response_id, one-off images/generations, and images/edits with your own or sample images (Meta's JSON body
 * or multipart). Size, n, format, reasoning strength and the built-in tools are all settable. $0.01 per image.
 */
export function ImageGenPlayground({
  modes = ["responses", "generations", "edits"],
  prompt: initialPrompt = "A watercolor painting of a red fox sitting in a snowy pine forest, soft golden morning light",
  editPrompt = "Make the sneaker bright orange with white laces. Keep the white background and the soft shadow.",
  followUps = ["Now make it night, with the aurora overhead", "Add a small red wool hat on the fox", "Make it a pencil sketch"],
  size: initialSize = "auto",
  sizes = SIZES,
  n: initialN = 1,
  outputFormat: initialFormat = "webp",
  reasoningStrength,
  toolsOff = [],
  editSampleIds = ["sneaker", "living-room", "cat-sofa", "street"],
  editSampleId = "sneaker",
  references = true,
  editBody: initialEditBody = "json",
}: ImageGenPlaygroundProps) {
  const id = useId();
  const runner = useDocsRun();
  const [showCode, setShowCode] = useState(false);
  const [mode, setMode] = useState<ImageGenMode>(modes[0] ?? "responses");
  const [prompt, setPrompt] = useState(modes[0] === "edits" ? editPrompt : initialPrompt);
  const [size, setSize] = useState(initialSize);
  const [n, setN] = useState(Math.min(2, Math.max(1, initialN)));
  const [format, setFormat] = useState(initialFormat);
  const [strength, setStrength] = useState<"default" | "low" | "high">(reasoningStrength ?? "default");
  const [tools, setTools] = useState({
    imageSearch: !toolsOff.includes("image_search"),
    webSearch: !toolsOff.includes("web_search"),
    shell: !toolsOff.includes("shell"),
  });
  const [refs, setRefs] = useState<[PickedMedia | null, PickedMedia | null]>([null, null]);
  const [edits, setEdits] = useState<[PickedMedia | null, PickedMedia | null]>([null, null]);
  const [editBody, setEditBody] = useState(initialEditBody);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [shownTurn, setShownTurn] = useState(0);
  const [images, setImages] = useState<OutputImage[]>([]);
  const [localError, setLocalError] = useState<DocsError | null>(null);
  const running = runner.state === "running";

  const settings: ImageToolSettings = {
    size,
    outputFormat: format === "webp" ? undefined : format,
    reasoningStrength: strength === "default" ? undefined : strength,
    enableImageSearch: tools.imageSearch,
    enableWebSearch: tools.webSearch,
    enableShell: tools.shell,
  };
  const pickedRefs = refs.filter((r): r is PickedMedia => !!r);
  const pickedEdits = edits.filter((r): r is PickedMedia => !!r);
  // A follow-up chains from the turn on screen, so picking an earlier one in the history branches from it.
  const base = turns[shownTurn] ?? turns.at(-1) ?? null;

  const switchMode = (next: ImageGenMode) => {
    setMode(next);
    setLocalError(null);
    runner.reset();
    if (next === "edits" && prompt === initialPrompt) setPrompt(editPrompt);
    if (next !== "edits" && prompt === editPrompt) setPrompt(initialPrompt);
  };

  // The request as code, with placeholders where the images go.
  const shown = ((): { path: string; body?: unknown; form?: FormSpec[] } => {
    if (mode === "responses") {
      return imageTurnRequest({
        prompt,
        previousResponseId: base?.responseId ?? null,
        references: pickedRefs.map(() => PLACEHOLDER),
        settings,
      });
    }
    if (mode === "generations") return imagesGenerationRequest({ prompt, n, settings });
    if (editBody === "multipart") {
      const fields = imagesEditFormFields({ prompt, imageCount: Math.max(1, pickedEdits.length), n, settings });
      return {
        path: "images/edits",
        form: [
          ...fields.scalars.map(([name, value]) => ({ name, value })),
          ...fields.files.map((name, i) => ({ name, value: pickedEdits[i]?.name ?? "image.png", file: { label: "Image", accept: "image/*" } })),
        ],
      };
    }
    return imagesEditJsonRequest({ prompt, images: (pickedEdits.length ? pickedEdits : [null]).map(() => PLACEHOLDER), n, settings });
  })();

  const run = async () => {
    setLocalError(null);
    if (!prompt.trim()) return;
    if (mode === "responses") {
      const refUrls = await Promise.all(pickedRefs.map(async (p) => ({ dataUrl: await fileToDataUrl(p.blob, p.mime) })));
      const { path, body } = imageTurnRequest({ prompt, previousResponseId: base?.responseId ?? null, references: refUrls, settings });
      const res = await runner.run(path, { body });
      if (!res.ok) return;
      const found = imagesOfResponse(res.json);
      if (!found.length) return setLocalError({ message: "The reply had no image_generation_call item. Try rephrasing the prompt." });
      const next: Turn = {
        prompt,
        responseId: typeof (res.json as { id?: unknown })?.id === "string" ? ((res.json as { id: string }).id) : null,
        images: found.map((img, i) => ({ ...img, label: `Turn ${turns.length + 1}${found.length > 1 ? `.${i + 1}` : ""}` })),
        reasoning: reasoningOfResponse(res.json),
      };
      setTurns((t) => [...t, next]);
      setShownTurn(turns.length);
      setPrompt("");
      setRefs([null, null]);
      return;
    }
    if (mode === "generations") {
      const { path, body } = imagesGenerationRequest({ prompt, n, settings });
      const res = await runner.run(path, { body });
      if (res.ok) setImages(imagesOfImagesReply(res.json));
      return;
    }
    if (!pickedEdits.length) return setLocalError({ message: "Pick at least one image to edit." });
    if (editBody === "multipart") {
      const fields = imagesEditFormFields({ prompt, imageCount: pickedEdits.length, n, settings });
      const form = new FormData();
      for (const [k, v] of fields.scalars) form.append(k, v);
      fields.files.forEach((name, i) => form.append(name, pickedEdits[i].blob, pickedEdits[i].name));
      const res = await runner.run("images/edits", { form });
      if (res.ok) setImages(imagesOfImagesReply(res.json));
      return;
    }
    const urls = await Promise.all(pickedEdits.map(async (p) => ({ dataUrl: await fileToDataUrl(p.blob, p.mime) })));
    const { path, body } = imagesEditJsonRequest({ prompt, images: urls, n, settings });
    const res = await runner.run(path, { body });
    if (res.ok) setImages(imagesOfImagesReply(res.json));
  };

  const turnShown = turns[shownTurn] ?? null;
  const outputImages = mode === "responses" ? (turnShown?.images ?? []) : images;
  const problems = [...pickedRefs, ...pickedEdits].flatMap((p) => p.problems);
  const imageAccept = "image/png,image/jpeg,image/webp";

  return (
    <div className={`pg ${styles.playground}`}>
      <div className="pg-bar">
        {modes.length > 1 ? (
          <span className="pg-advanced">
            <Segmented label="Endpoint" value={mode} onChange={switchMode} disabled={running} options={modes.map((m) => ({ value: m, label: MODE_LABEL[m] }))} />
          </span>
        ) : null}
        <ModelSelect kind="image" value="muse-image-1.0" onChange={() => {}} />
      </div>

      {mode === "responses" && turns.length ? (
        <div className={styles.stack}>
          <ul className={styles.history} aria-label="Turns">
            {turns.map((t, i) =>
              t.images[0] ? (
                <li key={i}>
                  <button
                    type="button"
                    className={styles.historyItem}
                    aria-current={i === shownTurn}
                    title={`Turn ${i + 1}: ${t.prompt}`}
                    onClick={() => setShownTurn(i)}
                  >
                    <img src={t.images[0].b64 ? `data:${t.images[0].mime ?? "image/webp"};base64,${t.images[0].b64}` : t.images[0].url} alt={`Turn ${i + 1}`} />
                  </button>
                </li>
              ) : null,
            )}
          </ul>
          <p className={styles.note}>
            Turn {shownTurn + 1}: {turnShown?.prompt}
            {base?.responseId ? ` · the next turn follows up on ${base.responseId} with previous_response_id.` : ""}
          </p>
        </div>
      ) : null}

      <Field id={`${id}-p`} label={mode === "responses" && turns.length ? "Follow-up instruction" : "Prompt"}>
        <TextArea
          id={`${id}-p`}
          value={prompt}
          rows={3}
          placeholder={turns.length ? followUps[0] : undefined}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={running}
        />
      </Field>
      {mode === "responses" && turns.length ? (
        <PresetPills label="Follow up" presets={followUps.map((f) => ({ label: f }))} onPick={(i) => setPrompt(followUps[i])} disabled={running} />
      ) : null}

      {mode === "responses" && references ? (
        <details className={`${styles.events} pg-advanced`}>
          <summary>Reference images (optional, sent as input_image parts after the prompt)</summary>
          <div className={styles.stack}>
            <FilePicker accept={imageAccept} value={refs[0]} onChange={(f) => setRefs([f, refs[1]])} samples={editSampleIds} preview="compact" disabled={running} />
            {refs[0] ? (
              <FilePicker accept={imageAccept} value={refs[1]} onChange={(f) => setRefs([refs[0], f])} samples={editSampleIds} preview="compact" disabled={running} />
            ) : null}
          </div>
        </details>
      ) : null}

      {mode === "edits" ? (
        <div className={styles.stack}>
          <FilePicker
            label="Image to edit"
            accept={imageAccept}
            value={edits[0]}
            onChange={(f) => setEdits([f, edits[1]])}
            samples={editSampleIds}
            defaultSampleId={editSampleId}
            disabled={running}
          />
          <div className="pg-advanced">
            <FilePicker
              label="Second image (optional, to compose two into one scene)"
              accept={imageAccept}
              value={edits[1]}
              onChange={(f) => setEdits([edits[0], f])}
              samples={editSampleIds}
              preview="compact"
              disabled={running}
            />
          </div>
          <span className={`${styles.inline} pg-advanced`}>
            <span className={styles.label}>Body</span>
            <Segmented<"json" | "multipart">
              size="sm"
              label="Edit body"
              value={editBody}
              onChange={setEditBody}
              disabled={running}
              options={[
                { value: "json", label: "JSON images array" },
                { value: "multipart", label: "multipart (OpenAI SDK)" },
              ]}
            />
          </span>
        </div>
      ) : null}

      <div className={`${styles.options} pg-advanced`}>
        <span className={styles.inline}>
          <label className={styles.label} htmlFor={`${id}-size`}>
            Size
          </label>
          <span className="select-wrap">
            <select id={`${id}-size`} className="select" value={size} onChange={(e) => setSize(e.target.value)} disabled={running}>
              {sizes.map((s) => (
                <option key={s} value={s}>
                  {s === "auto" ? "Default" : s}
                </option>
              ))}
            </select>
          </span>
        </span>
        {mode !== "responses" ? (
          <span className={styles.inline}>
            <span className={styles.label}>Images</span>
            <Segmented size="sm" label="Number of images" value={String(n) as "1" | "2"} onChange={(v) => setN(Number(v))} disabled={running} options={[{ value: "1", label: "1" }, { value: "2", label: "2" }]} />
          </span>
        ) : null}
        <span className={styles.inline}>
          <span className={styles.label}>Format</span>
          <Segmented<"webp" | "png" | "jpeg"> size="sm" label="Output format" value={format} onChange={setFormat} disabled={running} options={[{ value: "webp", label: "webp" }, { value: "png", label: "png" }, { value: "jpeg", label: "jpeg" }]} />
        </span>
        <span className={styles.inline}>
          <span className={styles.label}>Reasoning</span>
          <Segmented<"default" | "low" | "high">
            size="sm"
            label="Reasoning strength"
            value={strength}
            onChange={setStrength}
            disabled={running}
            options={[
              { value: "default", label: "Default (high)" },
              { value: "low", label: "low, faster" },
            ]}
          />
        </span>
      </div>
      <div className={`${styles.options} pg-advanced`}>
        <Toggle id={`${id}-is`} label="Image search" checked={tools.imageSearch} onChange={(v) => setTools((t) => ({ ...t, imageSearch: v }))} disabled={running} />
        <Toggle id={`${id}-ws`} label="Web search" checked={tools.webSearch} onChange={(v) => setTools((t) => ({ ...t, webSearch: v }))} disabled={running} />
        <Toggle id={`${id}-sh`} label="Shell (charts, layouts)" checked={tools.shell} onChange={(v) => setTools((t) => ({ ...t, shell: v }))} disabled={running} />
      </div>

      <div className={styles.spread}>
        <div className={styles.row}>
          {mode === "responses" && turns.length ? (
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => {
                setTurns([]);
                setShownTurn(0);
                setPrompt(initialPrompt);
                runner.reset();
              }}
              disabled={running}
            >
              Start over
            </button>
          ) : null}
          <RunButton
            running={running}
            onRun={() => void run()}
            onStop={runner.abort}
            label={mode === "responses" && turns.length ? "Follow up" : mode === "edits" ? "Edit" : "Generate"}
            disabled={!prompt.trim() || problems.length > 0 || (mode === "edits" && !pickedEdits.length)}
          />
        </div>
      </div>
      <p className={`${styles.note} pg-advanced`}>
        Muse Image costs $0.01 per image it returns{mode === "responses" ? "" : `, so this run costs about $${(0.01 * n).toFixed(2)}`}. It
        can take 10 to 60 seconds: it may look things up before it renders.
      </p>

      <ErrorBox error={localError ?? runner.error} />
      {running || runner.result ? (
        <ResponseView result={runner.result} running={running} elapsedMs={runner.elapsedMs}>
          {running ? (
            <p className={styles.note}>Muse Image is working on it. It may look things up before it renders.</p>
          ) : (
            <>
              {mode === "responses" && turnShown?.reasoning ? (
                <details className={styles.events} open>
                  <summary>What Muse Image did (reasoning summary)</summary>
                  <p className={styles.note}>{turnShown.reasoning}</p>
                </details>
              ) : null}
              <ImageOutput images={outputImages} name={mode === "edits" ? "muse-image-edit" : "muse-image"} emptyText="No images in this reply." />
            </>
          )}
        </ResponseView>
      ) : mode === "responses" && turnShown ? (
        <ImageOutput images={turnShown.images} />
      ) : null}
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path={shown.path} body={shown.body} form={shown.form} caption="The request Run sends" /> : null}
    </div>
  );
}
