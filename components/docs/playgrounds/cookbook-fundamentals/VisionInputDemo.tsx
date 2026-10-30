"use client";

import { useId, useMemo, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { EffortSelect, Field, PresetPills, Segmented, TextArea, TextInput, Toggle } from "@/components/docs/kit/Field";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { StreamView } from "@/components/docs/kit/StreamView";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { FilePicker } from "@/components/docs/media/FilePicker";
import styles from "@/components/docs/playgrounds/cookbook-fundamentals/cookbook.module.css";
import { Note, Stats } from "@/components/docs/playgrounds/cookbook-fundamentals/ui";
import {
  ANALYSIS_SCHEMA,
  IMAGE_TYPES,
  inputTokensBody,
  isPublicImageUrl,
  RECIPE_TEST_IMAGE,
  solidPng,
  SWATCHES,
  URL_SAMPLES,
  visionChatBody,
} from "@/components/docs/playgrounds/cookbook-fundamentals/vision";
import type { DocsError } from "@/lib/docs/client/api";
import { estimateCost, formatUsd } from "@/lib/docs/client/cost";
import { parseJsonText } from "@/lib/docs/client/json";
import { DEFAULT_TEXT_MODEL, fitEffort, type Effort } from "@/lib/docs/client/models";
import { validateJson } from "@/lib/docs/client/schema";
import { collectReply } from "@/lib/docs/client/stream";
import { fileToDataUrl } from "@/lib/docs/media/base64";
import type { PickedMedia } from "@/lib/docs/media/prepare";

/**
 * The vision-input recipe, live on Chat Completions: an image as a base64 data URL (a sample, your own file, or the
 * recipe's red and blue test image), a public URL the server fetches, or the recipe's three swatches in one request,
 * with a question; optional structured analysis (a strict json_schema); the developer-role mistake and its 400; and
 * the image's token cost measured first with POST /v1/responses/input_tokens.
 */

export interface VisionInputDemoProps {
  slug: string;
}

type Source = "base64" | "url" | "several";

const QUESTIONS: Record<Source, Array<{ label: string; question: string }>> = {
  base64: [
    { label: "Describe it", question: "Describe this image in one short sentence." },
    { label: "Read the text", question: "Read any text in this image, word for word." },
  ],
  url: [
    { label: "What animal", question: "What animal is this?" },
    { label: "Describe it", question: "Describe this image in one short sentence." },
  ],
  several: [
    { label: "Colors in order", question: "Each image is a solid-color swatch. List the colors in the order shown." },
    { label: "Which is warmest", question: "Which of these swatches is the warmest color, and which position is it in?" },
  ],
};

export function VisionInputDemo(_props: VisionInputDemoProps) {
  const id = useId();
  const runner = useDocsRun();
  const counter = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>("minimal");
  const [source, setSource] = useState<Source>("base64");
  const [picked, setPicked] = useState<PickedMedia | null>(null);
  const [useTestImage, setUseTestImage] = useState(true);
  const [url, setUrl] = useState(URL_SAMPLES[0].url);
  const [order, setOrder] = useState<number[]>([0, 1, 2]);
  const [question, setQuestion] = useState(QUESTIONS.base64[0].question);
  const [preset, setPreset] = useState<number | null>(0);
  const [structured, setStructured] = useState(false);
  const [developer, setDeveloper] = useState(false);
  const [localError, setLocalError] = useState<DocsError | null>(null);
  const [counts, setCounts] = useState<{ text: number; image: number; images: number } | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [preparing, setPreparing] = useState(false);

  const swatchUrls = useMemo(() => SWATCHES.map((s) => solidPng(s.rgb)), []);
  const running = runner.state === "running" || counter.state === "running" || preparing;

  /** The image URLs this request sends: data URLs inline, or the public URL. Never a stand-in for a missing file. */
  const imageUrls = async (): Promise<string[]> => {
    if (source === "url") return [url.trim()];
    if (source === "several") return order.map((i) => swatchUrls[i]);
    if (useTestImage) return [RECIPE_TEST_IMAGE];
    if (!picked || picked.problems.length) throw new Error(fileProblem ?? "Pick an image first.");
    return [await fileToDataUrl(picked.blob, picked.mime)];
  };

  const shownImages = source === "url" ? [url.trim()] : source === "several" ? order.map(() => "data:image/png;base64,<BASE64>") : ["data:image/png;base64,<BASE64>"];
  const body = (images: string[]) =>
    visionChatBody({ model, question: question.trim(), images, role: developer ? "developer" : "user", effort: fitEffort(model, effort), structured });

  const urlProblem = source === "url" && !isPublicImageUrl(url) ? "Use a public https URL: the API's servers fetch it, so it can't be on localhost or a private network." : null;
  // Your own file: Ask and Count wait for one, and for its problems (too large, unreadable) to be fixed.
  const fileProblem =
    source === "base64" && !useTestImage
      ? !picked
        ? "Pick an image or a sample above, or turn the recipe's test image back on."
        : picked.problems.length
          ? picked.problems.join(" ")
          : null
      : null;
  const blocked = urlProblem ?? fileProblem;

  const run = async () => {
    if (running) return;
    setLocalError(null);
    setPreparing(true);
    let images: string[];
    try {
      images = await imageUrls();
    } catch (err) {
      setLocalError({ message: err instanceof Error && err.message ? err.message : "Couldn't read that image." });
      return;
    } finally {
      setPreparing(false);
    }
    await runner.run("chat/completions", { method: "POST", body: body(images) });
  };

  const count = async () => {
    if (running) return;
    setLocalError(null);
    setCounts(null);
    setPreparing(true);
    let images: string[];
    try {
      images = await imageUrls();
    } catch (err) {
      setLocalError({ message: err instanceof Error && err.message ? err.message : "Couldn't read that image." });
      return;
    } finally {
      setPreparing(false);
    }
    const a = await counter.run("responses/input_tokens", { method: "POST", body: inputTokensBody(model, question.trim()) });
    if (!a.ok) return;
    const b = await counter.run("responses/input_tokens", { method: "POST", body: inputTokensBody(model, question.trim(), images) });
    if (!b.ok) return;
    const t = (a.json as { input_tokens?: number }).input_tokens ?? 0;
    const i = (b.json as { input_tokens?: number }).input_tokens ?? 0;
    setCounts({ text: t, image: i, images: images.length });
  };

  const reply = runner.result?.ok ? collectReply("chat", runner.result.json) : null;
  const parsed = structured && reply?.text ? parseJsonText(reply.text) : null;
  const report = parsed?.ok ? validateJson(ANALYSIS_SCHEMA, parsed.value) : null;
  const imageCost = counts ? estimateCost(model, { prompt_tokens: counts.image - counts.text, completion_tokens: 0 }) : null;

  const pickSource = (s: Source) => {
    setSource(s);
    setPreset(0);
    setQuestion(QUESTIONS[s][0].question);
    setCounts(null);
    runner.reset();
  };

  return (
    <div className="pg">
      <div className="pg-bar">
        <ModelSelect kind="vision" value={model} onChange={setModel} disabled={running} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={running} />
      </div>
      <div className={styles.row}>
        <span className={styles.inlineLabel}>Image</span>
        <Segmented<Source>
          label="How the image is sent"
          value={source}
          onChange={pickSource}
          disabled={running}
          options={[
            { value: "base64", label: "Base64, inline" },
            { value: "url", label: "Public URL" },
            { value: "several", label: "Several images" },
          ]}
        />
      </div>

      {source === "base64" ? (
        <div className={styles.stack}>
          <Toggle id={`${id}-test`} label="The recipe's own test image (256 x 256, red and blue)" checked={useTestImage} onChange={setUseTestImage} disabled={running} />
          {useTestImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className={styles.thumb} src={RECIPE_TEST_IMAGE} alt="The recipe's test image: red on the left half, blue on the right" />
          ) : (
            <FilePicker label="Image" accept="image/png,image/jpeg,image/webp,image/gif" value={picked} onChange={setPicked} samples={["image"]} defaultSampleId="receipt" disabled={running} />
          )}
          <Note>Sent as a data:image/...;base64 URL in the image_url part, so nothing has to be hosted.</Note>
        </div>
      ) : source === "url" ? (
        <div className={styles.stack}>
          <PresetPills
            label="Public images"
            presets={URL_SAMPLES}
            active={URL_SAMPLES.findIndex((u) => u.url === url)}
            onPick={(i) => setUrl(URL_SAMPLES[i].url)}
            disabled={running}
          />
          <Field id={`${id}-url`} label="Image URL" hint={urlProblem ?? "The API's servers fetch it, so it must be public. These come from Meta's segment-anything repository."}>
            <TextInput id={`${id}-url`} value={url} onChange={(e) => setUrl(e.target.value)} disabled={running} spellCheck={false} />
          </Field>
          {!urlProblem ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className={styles.preview} src={url} alt="The image at that URL" loading="lazy" />
          ) : null}
        </div>
      ) : (
        <div className={styles.stack}>
          <div className={styles.row}>
            <div className={styles.thumbs} role="group" aria-label="Swatches in the order they're sent">
              {order.map((i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} className={styles.thumb} src={swatchUrls[i]} alt={`${SWATCHES[i].name} swatch`} />
              ))}
            </div>
            <button type="button" className="btn btn-sm btn-outline" disabled={running} onClick={() => setOrder((o) => [...o.slice(1), o[0]])}>
              Rotate the order
            </button>
          </div>
          <Note>
            The recipe&apos;s solid_png, ported: three 64 x 64 PNGs made in the page, sent as three image_url parts in one user message. The
            model sees them in the order listed (about 50 images fit one request).
          </Note>
        </div>
      )}

      <PresetPills
        presets={QUESTIONS[source].map((q) => ({ label: q.label }))}
        active={preset}
        disabled={running}
        onPick={(i) => {
          setPreset(i);
          setQuestion(QUESTIONS[source][i].question);
        }}
      />
      <Field id={`${id}-q`} label="Question">
        <TextArea
          id={`${id}-q`}
          rows={2}
          value={question}
          onChange={(e) => {
            setQuestion(e.target.value);
            setPreset(null);
          }}
          disabled={running}
        />
      </Field>
      <div className="pg-bar">
        <Toggle id={`${id}-structured`} label="Structured analysis (json_schema)" checked={structured} onChange={setStructured} disabled={running} />
        <Toggle id={`${id}-dev`} label="Put the image in a developer message (HTTP 400)" checked={developer} onChange={setDeveloper} disabled={running} />
      </div>
      {fileProblem ? (
        <p className="pg-hint" role="status">
          {fileProblem}
        </p>
      ) : null}
      <div className={styles.spread}>
        <button type="button" className="btn btn-sm btn-outline" onClick={() => void count()} disabled={running || !question.trim() || !!blocked}>
          Count the image&apos;s tokens first (free)
        </button>
        <RunButton running={runner.state === "running" || preparing} onRun={() => void run()} onStop={runner.abort} disabled={!question.trim() || !!blocked || counter.state === "running"} label="Ask" />
      </div>

      <ErrorBox error={localError ?? counter.error} />
      {counts ? (
        <Stats
          label="Input tokens"
          items={[
            { label: "Text only", value: counts.text.toLocaleString("en-US") },
            { label: `With the image${counts.images > 1 ? "s" : ""}`, value: counts.image.toLocaleString("en-US") },
            {
              label: counts.images > 1 ? `The ${counts.images} images cost` : "The image costs",
              value: `${(counts.image - counts.text).toLocaleString("en-US")} tokens`,
              note: imageCost?.priced ? `${formatUsd(imageCost.usd)} as input` : undefined,
            },
          ]}
        />
      ) : null}

      <ErrorBox error={runner.error} />
      {runner.error && developer ? <Note>Image content is accepted only in user messages: move it back to the user message, as the first example does.</Note> : null}
      {runner.state === "running" || runner.result ? (
        <ResponseView result={runner.result} running={runner.state === "running"} elapsedMs={runner.elapsedMs}>
          {reply ? (
            <div className={styles.stack}>
              {parsed?.ok && report ? (
                <>
                  <p className={`pg-verdict ${report.valid ? "pg-good" : "pg-bad"}`}>{report.valid ? "Matches the analysis schema." : "Doesn't match the schema."}</p>
                  <JsonTree value={parsed.value} openDepth={3} />
                </>
              ) : (
                <StreamView text={reply.text} placeholder="No text in the reply." />
              )}
            </div>
          ) : undefined}
        </ResponseView>
      ) : null}

      <Note>
        Types image_url takes: {IMAGE_TYPES.join(", ")}. Up to about 50 images a request, 50 MB per inline image or 1 GiB through the Files API (the
        live docs keep uploads under 3 MB). Token cost grows with resolution.
      </Note>
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="chat/completions" body={body(shownImages)} caption="The request Ask sends" /> : null}
    </div>
  );
}
