"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { CodeView, ErrorBox, ModelSelect, ResponseView, RunButton } from "@/components/docs/kit";
import { useDocsPage } from "@/components/docs/kit/DocsPageContext";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { Toggle } from "@/components/docs/kit/Field";
import { ImageOutput } from "@/components/docs/media/ImageOutput";
import { MaskOverlay } from "@/components/docs/media/MaskOverlay";
import { loadSample } from "@/components/docs/media/hooks";
import styles from "@/components/docs/playgrounds/cookbook-media/cookbook-media.module.css";
import { samRunOutcome } from "@/components/docs/playgrounds/cookbook-media/sam-summary";
import type { DocsError } from "@/lib/docs/client/api";
import { trimForRecord } from "@/lib/docs/client/record";
import { fileToDataUrl } from "@/lib/docs/media/base64";
import { imagesOfResponse } from "@/lib/docs/media/images";
import { imageTurnRequest, samRequest, transcribeRequestPart, type TranscribeMode } from "@/lib/docs/media/requests";
import { SamStreamParser, objectIds, samDelta, samTextOfResponse, type SamRecord } from "@/lib/docs/media/sam";
import { sampleById } from "@/lib/docs/media/samples";
import { samVideoCost } from "@/lib/docs/media/video";

/** A small live version of a recipe's first step, run right in the browser. */
export type QuickRun =
  | { kind: "image"; label: string; prompt: string; referenceSampleId?: string }
  | { kind: "transcribe"; label: string; sampleId: string; mode?: TranscribeMode; keywords?: string[] }
  | { kind: "sam"; label: string; sampleId: string; prompt: string; media: "image" | "video" };

export interface RecipeEntry {
  /** The recipe's docs slug, such as "cookbook/sam-api-basics". */
  slug: string;
  title: string;
  /** The card's line on the category page. */
  summary: string;
  /** Need ids this recipe covers, for the filter. */
  needs: string[];
  time?: string;
  models: string[];
  languages?: string;
  /** How the recipe works, step by step. */
  flow: string[];
  /** The calls a full run makes and what they cost. */
  calls?: string;
  quick?: QuickRun;
}

export interface RecipeBrowserProps {
  slug?: string;
  category: string;
  /** The choices the category page lists ("basic generation, web grounding, ..."). */
  needs: Array<{ id: string; label: string }>;
  recipes: RecipeEntry[];
}

interface Transcript {
  transcript?: string;
  audioDurationMs?: number;
  turns?: Array<{ turnId?: number; startMs?: number; endMs?: number; transcript?: string; speaker?: string }>;
}

const quickCost = (q: QuickRun): string => {
  if (q.kind === "image") return "$0.01";
  if (q.kind === "sam") return q.media === "video" ? `about $${samVideoCost(sampleById(q.sampleId)?.frames ?? 50).toFixed(3)}` : "$0.0025";
  const ms = sampleById(q.sampleId)?.durationMs ?? 0;
  return `about $${((Math.floor(ms / 1000) / 3600) * 0.18).toFixed(4)}`;
};

/**
 * A category page's recipes as a browser: pick what you need, see which recipe covers it, how it works, what a full
 * run calls and costs, and run a small live version of its first step here (one image, one transcription, or one
 * segmentation), with a link to the recipe's own page and its full demo.
 */
export function RecipeBrowser({ category, needs, recipes }: RecipeBrowserProps) {
  const id = useId();
  const runner = useDocsRun();
  const { recordRequest } = useDocsPage();
  const running = runner.state === "running";
  const [need, setNeed] = useState<string | null>(null);
  const [picked, setPicked] = useState(recipes[0]?.slug ?? "");
  const [showCode, setShowCode] = useState(false);
  const [localError, setLocalError] = useState<DocsError | null>(null);
  const [outcome, setOutcome] = useState<
    | { kind: "image"; slug: string; b64: string | null }
    | { kind: "transcribe"; slug: string; reply: Transcript | null }
    | { kind: "sam"; slug: string; records: SamRecord[]; src: string; media: "image" | "video"; prompt: string; done: boolean; final: unknown }
    | null
  >(null);

  const recipe = recipes.find((r) => r.slug === picked) ?? recipes[0];
  const matches = useMemo(() => new Set(recipes.filter((r) => !need || r.needs.includes(need)).map((r) => r.slug)), [recipes, need]);
  const quick = recipe?.quick;

  const pickNeed = (next: string | null) => {
    setNeed(next);
    const first = recipes.find((r) => !next || r.needs.includes(next));
    if (first) choose(first.slug);
  };

  const choose = (slug: string) => {
    if (running) return;
    setPicked(slug);
    setLocalError(null);
  };

  // The request the quick run sends, with placeholders where the media goes (Show code).
  const shown = useMemo(() => {
    if (!quick) return null;
    if (quick.kind === "image") {
      return imageTurnRequest({ prompt: quick.prompt, references: quick.referenceSampleId ? [{ dataUrl: "data:image/jpeg;base64,<BASE64>" }] : [] });
    }
    if (quick.kind === "sam") {
      const media = quick.media === "video" ? "data:video/mp4;base64,<BASE64>" : "data:image/jpeg;base64,<BASE64>";
      return samRequest({ prompt: quick.prompt, media: { dataUrl: media }, kind: quick.media, stream: true });
    }
    return null;
  }, [quick]);
  const transcribeForm = quick?.kind === "transcribe"
    ? [
        { name: "request", value: JSON.stringify(transcribeRequestPart({ mode: quick.mode, keywords: quick.keywords })) },
        { name: "audio", value: sampleById(quick.sampleId)?.src.split("/").pop() ?? "audio.wav", file: { label: "Audio (16 kHz mono WAV)", accept: "audio/wav" } },
      ]
    : null;

  const run = async () => {
    if (!quick || !recipe) return;
    setLocalError(null);
    const slug = recipe.slug;
    try {
      if (quick.kind === "image") {
        setOutcome({ kind: "image", slug, b64: null });
        const ref = quick.referenceSampleId ? sampleById(quick.referenceSampleId) : null;
        const references = ref ? [{ dataUrl: await fileToDataUrl(await loadSample(ref), ref.mime) }] : [];
        const { path, body } = imageTurnRequest({ prompt: quick.prompt, references });
        const res = await runner.run(path, { body });
        if (res.ok) setOutcome({ kind: "image", slug, b64: imagesOfResponse(res.json)[0]?.b64 ?? null });
        return;
      }
      if (quick.kind === "transcribe") {
        setOutcome({ kind: "transcribe", slug, reply: null });
        const sample = sampleById(quick.sampleId);
        if (!sample) throw new Error("The sample is missing.");
        const form = new FormData();
        form.append("request", JSON.stringify(transcribeRequestPart({ mode: quick.mode, keywords: quick.keywords })));
        form.append("audio", await loadSample(sample), sample.src.split("/").pop());
        const res = await runner.run("asr/transcribe", { form });
        if (res.ok) setOutcome({ kind: "transcribe", slug, reply: res.json as Transcript });
        return;
      }
      const sample = sampleById(quick.sampleId);
      if (!sample) throw new Error("The sample is missing.");
      const file = await loadSample(sample);
      const { path, body } = samRequest({ prompt: quick.prompt, media: { dataUrl: await fileToDataUrl(file, sample.mime) }, kind: quick.media, stream: true });
      const parser = new SamStreamParser();
      let final: unknown = null;
      let sawDelta = false;
      const base = { kind: "sam" as const, slug, src: sample.src, media: quick.media, prompt: quick.prompt };
      setOutcome({ ...base, records: [], done: false, final: null });
      const res = await runner.run(path, {
        body,
        stream: true,
        onEvent: (e) => {
          const delta = samDelta(e.json);
          if (delta !== null) {
            sawDelta = true;
            if (parser.push(delta).length) setOutcome({ ...base, records: parser.output().records, done: false, final: null });
            return;
          }
          if (e.json?.type === "response.completed" || e.json?.type === "response.incomplete") {
            final = e.json.response ?? null;
            if (!sawDelta && final) parser.push(samTextOfResponse(final));
          }
        },
        // Recorded below with what SAM found, rather than the start of the wire text.
        record: false,
      });
      parser.end();
      const records = parser.output().records;
      recordRequest({
        method: "POST",
        path,
        body: trimForRecord(body),
        status: res.status,
        outcome: samRunOutcome({ ok: res.ok, status: res.status, aborted: res.error?.code === "aborted", error: res.error?.message, media: quick.media, records }),
      });
      setOutcome({ ...base, records, done: true, final: res.ok ? final : null });
    } catch (err) {
      setLocalError({ message: err instanceof Error ? err.message : "The run failed." });
    }
  };

  const mine = outcome && outcome.slug === recipe?.slug ? outcome : null;
  const samIds = mine?.kind === "sam" ? objectIds(mine.records) : [];
  const turns = mine?.kind === "transcribe" ? (mine.reply?.turns ?? []).filter((t) => (t.transcript ?? "").trim()) : [];

  return (
    <div className={`pg ${styles.stack}`}>
      <div className="pg-presets" role="group" aria-label="What do you need?">
        <span className="pg-presets-label">I need</span>
        <button type="button" className="pg-pill" aria-pressed={need === null} onClick={() => pickNeed(null)}>
          Any {category} recipe
        </button>
        {needs.map((n) => (
          <button key={n.id} type="button" className="pg-pill" aria-pressed={need === n.id} onClick={() => pickNeed(n.id)}>
            {n.label}
          </button>
        ))}
      </div>

      <div className={styles.browser}>
        <ul className={styles.recipeList} aria-label={`${category} recipes`}>
          {recipes.map((r) => (
            <li key={r.slug}>
              <button
                type="button"
                className={styles.recipeCard}
                aria-pressed={r.slug === recipe?.slug}
                data-dim={matches.has(r.slug) ? undefined : "true"}
                onClick={() => choose(r.slug)}
                disabled={running && r.slug !== recipe?.slug}
              >
                <span className={styles.recipeName}>{r.title}</span>
                <span className={styles.recipeSummary}>{r.summary}</span>
              </button>
            </li>
          ))}
        </ul>

        {recipe ? (
          <section className={styles.detail} aria-labelledby={`${id}-title`} aria-live="polite">
            <h3 className={styles.detailTitle} id={`${id}-title`}>
              {recipe.title}
            </h3>
            <dl className={styles.facts}>
              {recipe.time ? (
                <>
                  <dt>Time</dt>
                  <dd>{recipe.time}</dd>
                </>
              ) : null}
              <dt>{recipe.models.length > 1 ? "Models" : "Model"}</dt>
              <dd>
                {recipe.models.map((m, i) => (
                  <span key={m}>
                    {i ? ", " : ""}
                    <code>{m}</code>
                  </span>
                ))}
              </dd>
              {recipe.languages ? (
                <>
                  <dt>Languages</dt>
                  <dd>{recipe.languages}</dd>
                </>
              ) : null}
              {recipe.calls ? (
                <>
                  <dt>A full run</dt>
                  <dd>{recipe.calls}</dd>
                </>
              ) : null}
            </dl>
            <div className={styles.tight}>
              <span className={styles.label}>How it works</span>
              <ol className={styles.flow}>
                {recipe.flow.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ol>
            </div>
            <p>
              <Link href={`/docs/${recipe.slug}#try-it-live`}>Open the recipe and its full live demo</Link>
            </p>

            {quick ? (
              <div className={styles.tight}>
                <span className="pg-section-label">Try its first step here</span>
                <p className={styles.note}>
                  {quick.label} ({quickCost(quick)})
                </p>
                <div className="pg-bar">
                  <ModelSelect kind={quick.kind === "image" ? "image" : quick.kind === "sam" ? "sam" : "voice"} value={quick.kind === "image" ? "muse-image-1.0" : quick.kind === "sam" ? "sam-3.1" : "muse-voice-transcribe-1.0"} onChange={() => {}} />
                  <RunButton running={running} onRun={() => void run()} onStop={runner.abort} label="Run" />
                </div>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>

      <ErrorBox error={localError ?? runner.error} />
      {mine && (running || runner.result) ? (
        <ResponseView
          result={runner.result}
          running={running}
          elapsedMs={runner.elapsedMs}
          json={mine.kind === "sam" ? (mine.final ?? undefined) : undefined}
          usage={mine.kind === "sam" ? ((mine.final as { usage?: unknown } | null)?.usage ?? undefined) : mine.kind === "transcribe" ? {} : undefined}
          model={mine.kind === "sam" ? "sam-3.1" : mine.kind === "transcribe" ? "muse-voice-transcribe-1.0" : "muse-image-1.0"}
        >
          {mine.kind === "image" ? (
            running ? (
              <p className={styles.note}>Muse Image is rendering. It can take 10 to 60 seconds.</p>
            ) : (
              <ImageOutput images={mine.b64 ? [{ b64: mine.b64, label: recipe?.title }] : []} emptyText="No image came back." />
            )
          ) : mine.kind === "transcribe" ? (
            running ? (
              <p className={styles.note}>Transcribing...</p>
            ) : (
              <div className={styles.tight}>
                <p className="pg-stream-text">{(mine.reply?.transcript ?? "").replace(/​/g, "").trim() || "(no speech found)"}</p>
                {turns.length ? (
                  <ol className={styles.flow}>
                    {turns.map((t, i) => (
                      <li key={i}>
                        {t.speaker ? <strong>{t.speaker}: </strong> : null}
                        {(t.transcript ?? "").trim()}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </div>
            )
          ) : (
            <div className={styles.tight}>
              <MaskOverlay src={mine.src} media={mine.media} records={mine.records} fps={sampleById(quick?.kind === "sam" ? quick.sampleId : "")?.fps ?? 24} frames={sampleById(quick?.kind === "sam" ? quick.sampleId : "")?.frames} label={mine.prompt} />
              <p className={styles.note}>
                {mine.records.length
                  ? `${samIds.length} ${samIds.length === 1 ? "match" : "matches"} for "${mine.prompt}"${mine.media === "video" ? `, tracked across ${new Set(mine.records.map((r) => r.frame)).size} frames` : ""}${mine.done ? "." : " so far..."}`
                  : mine.done
                    ? "No matches, which is a valid result."
                    : "Segmenting..."}
              </p>
            </div>
          )}
        </ResponseView>
      ) : null}

      {quick ? (
        <>
          <div className="pg-actions">
            <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
          </div>
          {showCode ? (
            transcribeForm ? (
              <CodeView method="POST" path="asr/transcribe" form={transcribeForm} caption="The request Run sends" />
            ) : shown ? (
              <CodeView method="POST" path={shown.path} body={shown.body} caption="The request Run sends" />
            ) : null
          ) : null}
        </>
      ) : null}
    </div>
  );
}
