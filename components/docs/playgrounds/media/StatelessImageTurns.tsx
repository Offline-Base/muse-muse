"use client";

import { useId, useState } from "react";
import { CodeView, ErrorBox, ModelSelect, ResponseView, RunButton } from "@/components/docs/kit";
import { Field, PresetPills, TextArea, Toggle, runOnModEnter } from "@/components/docs/kit/Field";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { ImageOutput } from "@/components/docs/media/ImageOutput";
import { imageCallsOf, shortId, statelessTurnBody } from "@/components/docs/playgrounds/media/bodies";
import styles from "@/components/docs/playgrounds/media/demos.module.css";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import type { DocsError } from "@/lib/docs/client/api";
import { base64ImageMime, fileToDataUrl } from "@/lib/docs/media/base64";
import { reasoningOfResponse } from "@/lib/docs/media/images";
import type { PickedMedia } from "@/lib/docs/media/prepare";

export interface StatelessImageTurnsProps {
  slug?: string;
  prompt?: string;
  /** Follow-up pills after the first turn. */
  followUps?: string[];
  /** Start with the quick settings on: reasoning_strength low and Muse Image's lookups off. */
  fast?: boolean;
  /** Samples offered as reference images. */
  referenceSampleIds?: string[];
}

interface Turn {
  prompt: string;
  imageId: string;
  b64: string;
  reasoning: string;
}

/** Meta's own placeholder for the replayed id (image-generation, "Manage state yourself"). */
const PRIOR_ID = "ig_xxx_from_prior_turn";

/**
 * Muse Image with store: false (image-generation, "Manage state yourself"): nothing is kept at Meta, so each
 * follow-up replays the last image_generation_call item, its id with result null, before the new instruction, and can
 * add new reference images. Turns stay in the page, and picking an earlier one branches from it. $0.01 per image.
 */
export function StatelessImageTurns({
  prompt: initialPrompt = "a red fox trotting through fresh snow, golden hour",
  followUps = ["now make it night, with the aurora overhead", "add a small red wool hat on the fox's head", "make it a pencil sketch"],
  fast: initialFast = true,
  referenceSampleIds = ["sneaker", "living-room", "cat-sofa", "street"],
}: StatelessImageTurnsProps) {
  const id = useId();
  const runner = useDocsRun();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [at, setAt] = useState(0);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [fast, setFast] = useState(initialFast);
  const [reference, setReference] = useState<PickedMedia | null>(null);
  const [localError, setLocalError] = useState<DocsError | null>(null);
  const [showCode, setShowCode] = useState(false);
  const running = runner.state === "running";
  const base = turns[at] ?? null;

  const run = async () => {
    if (running || !prompt.trim()) return;
    setLocalError(null);
    const references = reference ? [await fileToDataUrl(reference.blob, reference.mime)] : [];
    const { path, body } = statelessTurnBody({ prompt, previousImageId: base?.imageId ?? null, references, fast });
    const res = await runner.run(path, { body });
    if (!res.ok) return;
    const call = imageCallsOf(res.json)[0];
    if (!call) return setLocalError({ message: "The reply had no image_generation_call item. Try rephrasing the instruction." });
    const next: Turn = { prompt, imageId: call.id, b64: call.b64, reasoning: reasoningOfResponse(res.json) };
    // Branching from an earlier turn drops the turns after it, as a conversation you manage yourself would.
    const kept = turns.slice(0, base ? at + 1 : 0);
    setTurns([...kept, next]);
    setAt(kept.length);
    setPrompt("");
    setReference(null);
  };

  const shownBody = statelessTurnBody({
    prompt: prompt || followUps[0] || initialPrompt,
    previousImageId: base ? PRIOR_ID : null,
    references: reference ? ["data:image/jpeg;base64,<BASE64>"] : [],
    fast,
  });
  const current = turns[at] ?? null;

  return (
    <div className={`pg ${styles.lab}`}>
      <div className="pg-bar">
        <ModelSelect kind="image" value="muse-image-1.0" onChange={() => {}} />
      </div>
      <p className={`${styles.note} pg-advanced`}>
        Every request sends <code>store: false</code>, so Meta keeps no conversation. The first turn sends the prompt. Each follow-up replays the last
        <code> image_generation_call</code> item (its id, with <code>result: null</code>) and then your new instruction, so you never resend the image.
      </p>

      {turns.length ? (
        <div className={styles.stack}>
          <ul className={styles.history} aria-label="Turns">
            {turns.map((t, i) => (
              <li key={t.imageId}>
                <button type="button" className={styles.historyItem} aria-current={i === at} title={`Turn ${i + 1}: ${t.prompt}`} onClick={() => setAt(i)} disabled={running}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`data:${base64ImageMime(t.b64)};base64,${t.b64}`} alt={`Turn ${i + 1}`} />
                </button>
              </li>
            ))}
          </ul>
          {current ? (
            <p className={styles.idLine}>
              Turn {at + 1} image_generation_call id: {shortId(current.imageId, 16)} ({current.imageId.length} characters, sent whole)
            </p>
          ) : null}
        </div>
      ) : null}

      <Field id={`${id}-p`} label={turns.length ? "Follow-up instruction" : "Prompt"}>
        <TextArea
          id={`${id}-p`}
          value={prompt}
          rows={2}
          placeholder={turns.length ? followUps[0] : undefined}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={runOnModEnter(() => void run())}
          disabled={running}
        />
      </Field>
      {turns.length ? <PresetPills label="Follow up" presets={followUps.map((f) => ({ label: f }))} onPick={(i) => setPrompt(followUps[i])} disabled={running} /> : null}

      <details className="pg-system">
        <summary>Add a reference image (optional, an input_image part after the instruction)</summary>
        <FilePicker accept="image/png,image/jpeg,image/webp" value={reference} onChange={setReference} samples={referenceSampleIds} preview="compact" disabled={running} />
      </details>

      <div className={styles.spread}>
        <span className="pg-advanced">
          <Toggle id={`${id}-fast`} label="Quick: reasoning_strength low, lookups off" checked={fast} onChange={setFast} disabled={running} />
        </span>
        <div className={styles.row}>
          {turns.length ? (
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => {
                setTurns([]);
                setAt(0);
                setPrompt(initialPrompt);
                runner.reset();
              }}
              disabled={running}
            >
              Start over
            </button>
          ) : null}
          <RunButton running={running} onRun={() => void run()} onStop={runner.abort} label={turns.length ? "Follow up" : "Generate"} disabled={!prompt.trim() || (reference?.problems.length ?? 0) > 0} />
        </div>
      </div>
      <p className={`${styles.note} pg-advanced`}>$0.01 per image. A quick turn takes about 10 seconds.</p>

      <ErrorBox error={localError ?? runner.error} />
      {running || runner.result ? (
        <ResponseView result={runner.result} running={running} elapsedMs={runner.elapsedMs}>
          {running ? (
            <p className={styles.note}>Muse Image is working on it.</p>
          ) : current ? (
            <div className={styles.stack}>
              {current.reasoning ? (
                <details className="pg-reasoning" open>
                  <summary>What Muse Image did (reasoning summary)</summary>
                  <MarkdownText className="pg-reasoning-text" text={current.reasoning} />
                </details>
              ) : null}
              <ImageOutput images={[{ b64: current.b64, mime: base64ImageMime(current.b64), label: `Turn ${at + 1}` }]} name="muse-image-turn" />
            </div>
          ) : undefined}
        </ResponseView>
      ) : current ? (
        <ImageOutput images={[{ b64: current.b64, mime: base64ImageMime(current.b64), label: `Turn ${at + 1}` }]} name="muse-image-turn" />
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? (
        <CodeView
          method="POST"
          path={shownBody.path}
          body={shownBody.body}
          caption={base ? `The next follow-up. ${PRIOR_ID} stands for the id the last turn returned.` : "The first turn"}
        />
      ) : null}
    </div>
  );
}
