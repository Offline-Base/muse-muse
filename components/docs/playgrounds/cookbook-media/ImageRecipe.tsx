"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { CodeView, ErrorBox, ModelSelect, ResponseView, RunButton, UsageLine } from "@/components/docs/kit";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { Field, Segmented, Toggle } from "@/components/docs/kit/Field";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { ImageOutput } from "@/components/docs/media/ImageOutput";
import { useObjectUrl } from "@/components/docs/media/hooks";
import { AutoTextArea } from "@/components/docs/playgrounds/cookbook-media/AutoTextArea";
import styles from "@/components/docs/playgrounds/cookbook-media/cookbook-media.module.css";
import { ImageCompare, type CompareImage } from "@/components/docs/playgrounds/cookbook-media/ImageCompare";
import {
  base64Format,
  chainOptions,
  descendants,
  imageCallOf,
  recipeCost,
  replyChecks,
  runOrder,
  stepRequest,
  tokenCounts,
  type ImageStep,
  type StateMode,
} from "@/components/docs/playgrounds/cookbook-media/image-recipe";
import type { DocsError } from "@/lib/docs/client/api";
import { formatUsd } from "@/lib/docs/client/cost";
import { fileToDataUrl } from "@/lib/docs/media/base64";
import { reasoningOfResponse } from "@/lib/docs/media/images";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import type { ImageToolSettings, JsonObject } from "@/lib/docs/media/requests";

export interface ImageRecipeProps {
  slug?: string;
  steps: ImageStep[];
  /** Offer carrying the conversation on the client (store: false, the prior image replayed) next to server state. */
  stateModes?: boolean;
  /** Offer comparing each edit with what it edited: side by side, a wipe, or where the pixels changed. */
  compare?: boolean;
  /** Show the contact sheet: anchors, panels and pages side by side. */
  sheet?: boolean;
  /** On steps with reference images, offer sending the content parts as a bare list (Meta answers HTTP 400). */
  bareList?: boolean;
  /** Offer the image_generation tool's web and image search switches. */
  searchSwitches?: boolean;
  /** A caution shown under the controls, such as what search grounding can't promise. */
  caution?: string;
}

interface StepResult {
  responseId: string | null;
  item: JsonObject | null;
  b64: string | null;
  reply: unknown;
  /** The step and response this run continued, to tell when it went stale. */
  parentStep: string | null;
  parentResponseId: string | null;
  mode: StateMode;
  status: number;
  prompt: string;
}

const PER_IMAGE = 0.01;
/** The photo samples, for reference images (charts and screenshots make poor references for a scene). */
const PHOTO_SAMPLES = ["street", "fridge", "cat-sofa", "sneaker", "living-room"];
const PLACEHOLDER_IMAGE = "data:image/jpeg;base64,<BASE64>";

/** The size an image decodes to, or an error, once it loads. */
function useDecoded(src: string | null): { width: number; height: number } | "error" | null {
  const [size, setSize] = useState<{ width: number; height: number } | "error" | null>(null);
  useEffect(() => {
    if (!src) {
      setSize(null);
      return;
    }
    let live = true;
    const img = new Image();
    img.onload = () => live && setSize({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => live && setSize("error");
    img.src = src;
    return () => {
      live = false;
    };
  }, [src]);
  return size;
}

const dataUrlOf = (b64: string) => `data:${base64Format(b64) === "PNG" ? "image/png" : base64Format(b64) === "JPEG" ? "image/jpeg" : "image/webp"};base64,${b64}`;

/**
 * A Muse Image cookbook recipe as steps you run one at a time or all together: each step is one Responses turn on
 * muse-image-1.0, starting a conversation or continuing an earlier step with previous_response_id (or, with the
 * client carrying state, store: false and the prior image_generation_call replayed). Every result shows its image,
 * the recipe's checks (status, the image item found by type, the bytes decode), token usage and the response id;
 * edits can be compared with their source. $0.01 per image.
 */
export function ImageRecipe({ steps, stateModes = false, compare = false, sheet = false, bareList = false, searchSwitches = false, caution }: ImageRecipeProps) {
  const id = useId();
  const runner = useDocsRun();
  const running = runner.state === "running";
  const [mode, setMode] = useState<StateMode>("server");
  const [replay, setReplay] = useState<"id" | "item">("id");
  const [prompts, setPrompts] = useState<Record<string, string>>(() => Object.fromEntries(steps.map((s) => [s.id, s.prompt])));
  const [chains, setChains] = useState<Record<string, string | null>>(() => Object.fromEntries(steps.map((s) => [s.id, s.chainFrom ?? null])));
  const [refs, setRefs] = useState<Record<string, Array<PickedMedia | null>>>({});
  const [bare, setBare] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState({ web: true, image: true });
  const [results, setResults] = useState<Record<string, StepResult>>({});
  const resultsRef = useRef(results);
  resultsRef.current = results;
  const [runningStep, setRunningStep] = useState<string | null>(null);
  const [focus, setFocus] = useState<string>(steps[0]?.id ?? "");
  const [queue, setQueue] = useState<{ at: number; total: number } | null>(null);
  const [localError, setLocalError] = useState<DocsError | null>(null);
  const [showCode, setShowCode] = useState(false);
  /** The step Muse Image's safety filter stopped last, if any. */
  const [filtered, setFiltered] = useState<string | null>(null);
  const stopAll = useRef(false);

  const indexOf = useCallback((stepId: string) => steps.findIndex((s) => s.id === stepId), [steps]);
  const stepNo = (stepId: string | null) => (stepId ? indexOf(stepId) + 1 : 0);
  const cost = recipeCost(steps, PER_IMAGE);

  const settingsFor = (step: ImageStep): ImageToolSettings => ({
    size: step.settings?.size,
    reasoningStrength: step.settings?.reasoningStrength,
    enableWebSearch: searchSwitches ? search.web && step.settings?.enableWebSearch !== false : step.settings?.enableWebSearch,
    enableImageSearch: searchSwitches ? search.image && step.settings?.enableImageSearch !== false : step.settings?.enableImageSearch,
  });

  const picked = (stepId: string) => (refs[stepId] ?? []).filter((r): r is PickedMedia => !!r);

  /** The request for a step, with real data URLs when `withMedia`, placeholders otherwise (for Show code). */
  const requestFor = async (step: ImageStep, withMedia: boolean) => {
    const parentStep = chains[step.id] ?? null;
    const parent = parentStep ? resultsRef.current[parentStep] : null;
    const references = withMedia
      ? await Promise.all(picked(step.id).map(async (p) => ({ dataUrl: await fileToDataUrl(p.blob, p.mime) })))
      : picked(step.id).map(() => ({ dataUrl: PLACEHOLDER_IMAGE }));
    const placeholderParent = { responseId: `resp_from_step_${stepNo(parentStep)}`, item: { type: "image_generation_call", id: `ig_from_step_${stepNo(parentStep)}`, status: "completed", result: null } };
    return {
      parentStep,
      parent,
      ...stepRequest({
        prompt: prompts[step.id] ?? step.prompt,
        references,
        parent: parentStep ? (parent ? { responseId: parent.responseId, item: parent.item } : placeholderParent) : null,
        mode,
        settings: settingsFor(step),
        replay,
        bareList: bareList && !!bare[step.id],
      }),
    };
  };

  /** Runs one step. Resolves true when it produced an image. */
  const runStep = async (step: ImageStep): Promise<boolean> => {
    setLocalError(null);
    setFocus(step.id);
    const parentStep = chains[step.id] ?? null;
    if (parentStep && !resultsRef.current[parentStep]?.item) {
      setLocalError({ message: `Run step ${stepNo(parentStep)} first: this step continues its image.` });
      return false;
    }
    if (picked(step.id).some((p) => p.problems.length)) {
      setLocalError({ message: "A reference image can't be sent as it is. Pick another one." });
      return false;
    }
    setRunningStep(step.id);
    setFiltered(null);
    const { path, body, parent } = await requestFor(step, true);
    const res = await runner.run(path, { body });
    setRunningStep(null);
    if (!res.ok) {
      if (res.error?.code === "content_policy_violation") setFiltered(step.id);
      return false;
    }
    const call = imageCallOf(res.json);
    const next: StepResult = {
      responseId: typeof (res.json as { id?: unknown })?.id === "string" ? (res.json as { id: string }).id : null,
      item: call?.item ?? null,
      b64: typeof call?.item.result === "string" ? (call.item.result as string) : null,
      reply: res.json,
      parentStep,
      parentResponseId: parent?.responseId ?? null,
      mode,
      status: res.status,
      prompt: prompts[step.id] ?? step.prompt,
    };
    setResults((r) => ({ ...r, [step.id]: next }));
    resultsRef.current = { ...resultsRef.current, [step.id]: next };
    if (!call) setLocalError({ message: "The reply had no image_generation_call item, so there's no image to continue from. Try rephrasing the step." });
    return !!call;
  };

  const runAll = async () => {
    stopAll.current = false;
    const order = runOrder(steps);
    // Steps that already have a fresh image are kept, so after a stop Run all carries on from where it was.
    const firstMissing = order.findIndex((s) => !resultsRef.current[s.id]?.item || isStale(resultsRef.current[s.id], resultsRef.current));
    // With every step done, Run all starts the chain again.
    for (let i = Math.max(0, firstMissing); i < order.length; i++) {
      if (stopAll.current) break;
      setQueue({ at: i + 1, total: order.length });
      const ok = await runStep(order[i]);
      if (!ok) break;
    }
    setQueue(null);
  };

  const stop = () => {
    stopAll.current = true;
    runner.abort();
  };

  const startOver = () => {
    stopAll.current = true;
    runner.reset();
    setResults({});
    resultsRef.current = {};
    setLocalError(null);
    setQueue(null);
  };

  const switchMode = (next: StateMode) => {
    // A store: false turn can't be continued by id, and a stored one isn't replayed; start the chain again.
    startOver();
    setMode(next);
  };

  // Show code follows the focused step.
  const focusStep = steps.find((s) => s.id === focus) ?? steps[0];
  const [shown, setShown] = useState<{ path: string; body: JsonObject } | null>(null);
  useEffect(() => {
    if (!showCode || !focusStep) return;
    let live = true;
    void requestFor(focusStep, false).then((r) => live && setShown({ path: r.path, body: r.body }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCode, focusStep, prompts, chains, refs, mode, replay, bare, search, results]);

  const imagesDone = Object.keys(results).length;
  const remaining = runOrder(steps).filter((s) => !results[s.id]?.item || isStale(results[s.id], results)).length;
  const runAllLabel = remaining > 0 && remaining < cost.images ? `Run the remaining ${remaining} step${remaining === 1 ? "" : "s"}` : `Run all ${cost.images} steps`;
  const groups = useMemo(() => {
    const order: Array<NonNullable<ImageStep["group"]>> = ["anchor", "panel", "page", "compare", "turn"];
    const titles: Record<string, string> = { anchor: "Reference anchors", panel: "Panels", page: "Page", compare: "Without anchors", turn: "Turns" };
    return order
      .map((g) => ({ g, title: titles[g], steps: steps.filter((s) => (s.group ?? "turn") === g) }))
      .filter((x) => x.steps.length);
  }, [steps]);

  return (
    <div className={`pg ${styles.stack}`}>
      <div className="pg-bar">
        <ModelSelect kind="image" value="muse-image-1.0" onChange={() => {}} />
        {stateModes ? (
          <span className={styles.control}>
            <span className={styles.label}>State</span>
            <Segmented<StateMode>
              size="sm"
              label="Who keeps the conversation"
              value={mode}
              onChange={switchMode}
              disabled={running}
              options={[
                { value: "server", label: "Server (previous_response_id)" },
                { value: "client", label: "You (store: false)" },
              ]}
            />
          </span>
        ) : null}
        {stateModes && mode === "client" ? (
          <span className={styles.control}>
            <span className={styles.label}>Replay</span>
            <Segmented<"id" | "item">
              size="sm"
              label="How the prior image is replayed"
              value={replay}
              onChange={setReplay}
              disabled={running}
              options={[
                { value: "id", label: "Signed id, result: null" },
                { value: "item", label: "Whole item" },
              ]}
            />
          </span>
        ) : null}
      </div>
      {stateModes && mode === "client" ? (
        <p className={styles.note}>
          Each turn sends <code>store: false</code>, and a continued turn starts its <code>input</code> with the prior{" "}
          <code>image_generation_call</code> item, then your message. The item&apos;s id is a signed handle that carries the image, so{" "}
          <code>result: null</code> works (the image guide&apos;s way); the recipe replays the whole item, which resends the image&apos;s bytes.
        </p>
      ) : null}
      {searchSwitches ? (
        <div className={styles.row}>
          <Toggle id={`${id}-ws`} label="Web search (enable_web_search)" checked={search.web} onChange={(v) => setSearch((s) => ({ ...s, web: v }))} disabled={running} />
          <Toggle id={`${id}-is`} label="Image search (enable_image_search)" checked={search.image} onChange={(v) => setSearch((s) => ({ ...s, image: v }))} disabled={running} />
        </div>
      ) : null}
      {caution ? (
        <p className="pg-notice" role="note">
          <Icon name="info" size={16} className="pg-notice-icon" />
          <span>{caution}</span>
        </p>
      ) : null}

      <div className={styles.spread}>
        <div className={styles.row}>
          <RunButton running={running && !!queue} onRun={() => void runAll()} onStop={stop} label={runAllLabel} disabled={running && !queue} />
          {imagesDone ? (
            <button type="button" className="btn btn-outline btn-sm" onClick={startOver} disabled={running}>
              Start over
            </button>
          ) : null}
        </div>
        <span className={styles.note} aria-live="polite">
          {queue
            ? `Step ${queue.at} of ${queue.total}: ${steps.find((s) => s.id === runningStep)?.label ?? "running"}...`
            : `$${PER_IMAGE.toFixed(2)} per image: about ${formatUsd(cost.usd)} for all ${cost.images}${steps.length > cost.images ? ` (optional steps are $${PER_IMAGE.toFixed(2)} more each)` : ""}. Each image takes 10 to 60 seconds.`}
        </span>
      </div>

      {imagesDone ? (
        <ul className={styles.thumbs} aria-label="Step results">
          {steps.map((s, i) => {
            const r = results[s.id];
            return (
              <li key={s.id}>
                <button type="button" className={styles.thumb} aria-current={focus === s.id} onClick={() => {
                  setFocus(s.id);
                  document.getElementById(`${id}-step-${s.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
                }}>
                  {r?.b64 ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={dataUrlOf(r.b64)} alt="" />
                  ) : (
                    <span className={styles.thumbEmpty}>{i + 1}</span>
                  )}
                  <span className={styles.thumbLabel} title={s.label}>
                    Step {i + 1}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <ol className={styles.steps}>
        {steps.map((step, i) => (
          <StepCard
            key={step.id}
            idBase={`${id}-step-${step.id}`}
            n={i + 1}
            step={step}
            steps={steps}
            prompt={prompts[step.id] ?? step.prompt}
            onPrompt={(v) => setPrompts((p) => ({ ...p, [step.id]: v }))}
            chain={chains[step.id] ?? null}
            onChain={(v) => setChains((c) => ({ ...c, [step.id]: v }))}
            refs={refs[step.id] ?? []}
            onRef={(slot, f) => setRefs((r) => {
              const list = [...(r[step.id] ?? [])];
              list[slot] = f;
              return { ...r, [step.id]: list };
            })}
            bare={!!bare[step.id]}
            onBare={bareList ? (v) => setBare((b) => ({ ...b, [step.id]: v })) : undefined}
            mode={mode}
            result={results[step.id] ?? null}
            parentResult={chains[step.id] ? (results[chains[step.id]!] ?? null) : null}
            rootPhoto={rootPhotoOf(step.id, chains, refs)}
            stale={isStale(results[step.id], results)}
            // Only steps that have an image can go stale; the rest have nothing to lose yet.
            downstream={descendants(steps, step.id, chains).filter((d) => results[d]).map(stepNo)}
            compare={compare}
            active={focus === step.id}
            running={running}
            runningThis={runningStep === step.id}
            onRun={() => void runStep(step)}
            onStop={stop}
            onFocus={() => setFocus(step.id)}
          />
        ))}
      </ol>

      <ErrorBox error={localError ?? runner.error} />
      {filtered && runner.error?.code === "content_policy_violation" ? (
        <p className="pg-notice" role="note">
          <Icon name="info" size={16} className="pg-notice-icon" />
          <span>
            Muse Image&apos;s safety filter stopped step {stepNo(filtered)}. Filtered images aren&apos;t billed, and the filter isn&apos;t
            deterministic: run the step again, or reword it, then carry on from there.
          </span>
        </p>
      ) : null}
      {running || runner.result ? (
        <ResponseView result={runner.result} running={running} elapsedMs={runner.elapsedMs} model="muse-image-1.0" usage={(runner.result?.json as { usage?: unknown } | null)?.usage ?? undefined}>
          <p className={styles.note}>
            {running
              ? `Step ${stepNo(runningStep)} is rendering. Muse Image may look things up before it draws.`
              : runner.result?.ok
                ? `Step ${stepNo(focus)} finished: its image and checks are in the step above. The JSON tab has the whole reply.`
                : "The step didn't finish. The error is above."}
          </p>
        </ResponseView>
      ) : null}

      {sheet && imagesDone ? (
        <section className={styles.sheet} aria-label="Contact sheet">
          <p className="pg-section-label">Contact sheet: compare every panel with the anchors</p>
          {groups.map(({ g, title, steps: list }) => (
            <div key={g} className={styles.tight}>
              <span className={styles.label}>{title}</span>
              <div className={styles.sheetRow}>
                {list.map((s) => {
                  const r = results[s.id];
                  return (
                    <figure key={s.id} className={styles.sheetItem}>
                      {r?.b64 ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={dataUrlOf(r.b64)} alt={`${s.label}: ${r.prompt.slice(0, 120)}`} />
                      ) : (
                        <span className={styles.thumbEmpty}>Not run</span>
                      )}
                      <figcaption>
                        {stepNo(s.id)}. {s.label}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
        {showCode ? <span className={styles.note}>For step {stepNo(focusStep?.id ?? null)}: {focusStep?.label}. Pick a step to see its request.</span> : null}
      </div>
      {showCode && shown ? <CodeView method="POST" path={shown.path} body={shown.body} caption={`The request step ${stepNo(focusStep?.id ?? null)} sends`} /> : null}
    </div>
  );
}

/** A result goes stale when the step it continued has been run again since. */
function isStale(r: StepResult | undefined, all: Record<string, StepResult>): boolean {
  if (!r?.parentStep) return false;
  const parent = all[r.parentStep];
  return !parent || parent.responseId !== r.parentResponseId;
}

/** The photo a chain started from: the first reference image of the earliest step in this step's chain that has one. */
function rootPhotoOf(stepId: string, chains: Record<string, string | null>, refs: Record<string, Array<PickedMedia | null>>): PickedMedia | null {
  let at: string | null = stepId;
  let found: PickedMedia | null = null;
  const seen = new Set<string>();
  while (at && !seen.has(at)) {
    seen.add(at);
    const first = (refs[at] ?? []).find((r): r is PickedMedia => !!r) ?? null;
    if (first) found = first;
    at = chains[at] ?? null;
  }
  return found;
}

function StepCard({
  idBase,
  n,
  step,
  steps,
  prompt,
  onPrompt,
  chain,
  onChain,
  refs,
  onRef,
  bare,
  onBare,
  mode,
  result,
  parentResult,
  rootPhoto,
  stale,
  downstream,
  compare,
  active,
  running,
  runningThis,
  onRun,
  onStop,
  onFocus,
}: {
  idBase: string;
  n: number;
  step: ImageStep;
  steps: readonly ImageStep[];
  prompt: string;
  onPrompt(v: string): void;
  chain: string | null;
  onChain(v: string | null): void;
  refs: Array<PickedMedia | null>;
  onRef(slot: number, f: PickedMedia | null): void;
  bare: boolean;
  onBare?: (v: boolean) => void;
  mode: StateMode;
  result: StepResult | null;
  parentResult: StepResult | null;
  rootPhoto: PickedMedia | null;
  stale: boolean;
  downstream: number[];
  compare: boolean;
  active: boolean;
  running: boolean;
  runningThis: boolean;
  onRun(): void;
  onStop(): void;
  onFocus(): void;
}) {
  const chainSteps = chainOptions(steps, step.id);
  const parentNo = chain ? steps.findIndex((s) => s.id === chain) + 1 : 0;
  const src = result?.b64 ? dataUrlOf(result.b64) : null;
  const decoded = useDecoded(src);
  const rootUrl = useObjectUrl(rootPhoto?.blob ?? null);
  const tokens = result ? tokenCounts(result.reply) : null;
  const checks = result ? replyChecks(result.reply) : [];
  const reasoning = result ? reasoningOfResponse(result.reply) : "";
  const hasRefs = (step.references?.length ?? 0) > 0;
  const [compareWith, setCompareWith] = useState<"parent" | "source">("parent");

  const before: CompareImage | null = (() => {
    const parentSrc = parentResult?.b64 ? dataUrlOf(parentResult.b64) : null;
    const options: Record<"parent" | "source", CompareImage | null> = {
      parent: parentSrc ? { src: parentSrc, label: `Step ${parentNo}'s image` } : null,
      source: rootUrl ? { src: rootUrl, label: "The source photo" } : null,
    };
    return options[compareWith] ?? options.parent ?? options.source;
  })();

  const chainBadge = !chain
    ? "New conversation"
    : mode === "server"
      ? `Continues step ${parentNo} (previous_response_id)`
      : `Replays step ${parentNo}'s image (store: false)`;

  return (
    <li className={styles.step} id={idBase} data-active={active ? "true" : undefined} data-done={result?.b64 ? "true" : undefined} onFocusCapture={onFocus}>
      <div className={styles.stepHead}>
        <span className={styles.stepNum} aria-hidden="true">
          {n}
        </span>
        <h3 className={styles.stepTitle}>
          <span className="sr-only">Step {n}: </span>
          {step.label}
        </h3>
        <span className={styles.badge}>{chainBadge}</span>
        {step.optional ? <span className={styles.badge}>Optional, not in Run all</span> : null}
      </div>
      {step.note ? <p className={styles.note}>{step.note}</p> : null}
      <Field id={`${idBase}-prompt`} label={chain ? "Instruction (only the change)" : "Prompt"}>
        {/* A first guess from desktop line length; the box then grows to fit the text at the width it really has. */}
        <AutoTextArea
          id={`${idBase}-prompt`}
          rows={Math.min(7, Math.max(2, Math.ceil(prompt.length / 95)))}
          value={prompt}
          onChange={(e) => onPrompt(e.target.value)}
          disabled={running}
        />
      </Field>
      {hasRefs ? (
        <div className={styles.tight}>
          <span className={styles.label}>Reference images (input_image parts in the same user message)</span>
          <div className={styles.row}>
            {(step.references ?? []).map((r, slot) => (
              <div key={`${r.sampleId}-${slot}`} style={{ flex: "1 1 240px", minWidth: 0 }}>
                <FilePicker
                  label={r.label ?? `Reference ${slot + 1}`}
                  accept="image/png,image/jpeg,image/webp"
                  value={refs[slot] ?? null}
                  onChange={(f) => onRef(slot, f)}
                  samples={PHOTO_SAMPLES}
                  defaultSampleId={r.sampleId}
                  preview="compact"
                  disabled={running}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <details className={styles.details}>
        <summary>Options for this step</summary>
        <div className={styles.tight}>
          <label className={styles.control} htmlFor={`${idBase}-chain`}>
            Continue from
            <span className="select-wrap">
              <select id={`${idBase}-chain`} className="select pg-select" value={chain ?? ""} onChange={(e) => onChain(e.target.value || null)} disabled={running}>
                <option value="">Nothing: a new conversation</option>
                {chainSteps.map((s) => (
                  <option key={s.id} value={s.id}>
                    Step {steps.indexOf(s) + 1}: {s.label}
                  </option>
                ))}
              </select>
            </span>
          </label>
          {onBare && hasRefs ? (
            <Toggle
              id={`${idBase}-bare`}
              label="Send the parts as a bare list, without the user message (the recipe says Meta rejects this with HTTP 400; it costs nothing)"
              checked={bare}
              onChange={onBare}
              disabled={running}
            />
          ) : null}
        </div>
      </details>
      <div className={styles.row}>
        <RunButton running={runningThis} onRun={onRun} onStop={onStop} label={result ? `Run step ${n} again` : `Run step ${n}`} disabled={running && !runningThis} />
        <span className={styles.note}>
          $0.01 for its image
          {downstream.length && result
            ? `. Running it again makes ${downstream.length === 1 ? `step ${downstream[0]}` : `steps ${downstream.slice(0, -1).join(", ")} and ${downstream.at(-1)}`} stale.`
            : "."}
        </span>
      </div>

      {result ? (
        <div className={styles.result} aria-live="polite">
          <div className={styles.tight}>
            {result.b64 ? <ImageOutput images={[{ b64: result.b64, label: `Step ${n}`, alt: `Step ${n}: ${result.prompt.slice(0, 140)}` }]} name={`step-${n}`} /> : null}
            {stale ? (
              <p className={`${styles.badge} ${styles.badgeWarn}`}>Stale: step {parentNo} was run again, so this image continues an older version. Run this step again.</p>
            ) : null}
          </div>
          <div className={styles.tight}>
            <ul className={styles.checks} aria-label="Checks">
              {[
                ...checks,
                {
                  label: "the result decodes as an image",
                  ok: !!decoded && decoded !== "error",
                  detail: !result.b64 ? "no result" : decoded === "error" ? "it didn't decode" : decoded ? `${base64Format(result.b64) ?? "image"}, ${decoded.width} x ${decoded.height}` : "decoding...",
                },
              ].map((c) => (
                <li key={c.label} className={styles.check} data-ok={c.ok ? "true" : "false"}>
                  <Icon name={c.ok ? "check" : "close"} size={15} className={styles.checkIcon} />
                  <span>
                    {c.label}
                    {c.detail ? <span className={styles.note}> ({c.detail})</span> : null}
                  </span>
                </li>
              ))}
            </ul>
            {tokens ? (
              <dl className={styles.tokens} aria-label="usage">
                {(
                  [
                    ["input_tokens", tokens.input],
                    ["cached", tokens.cached],
                    ["output_tokens", tokens.output],
                    ["reasoning", tokens.reasoning],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className={styles.token}>
                    <dt>{k}</dt>
                    <dd>{v.toLocaleString("en-US")}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <p className={styles.note}>
              <UsageLine model="muse-image-1.0" usage={(result.reply as { usage?: unknown })?.usage ?? {}} images={result.b64 ? 1 : 0} />
              {" · "}
              <span className={styles.mono}>{result.responseId ?? "no id"}</span>
              {result.mode === "client" ? " (store: false, so it can't be continued by id)" : ""}
            </p>
            {reasoning ? (
              <details className={styles.details}>
                <summary>What Muse Image planned (reasoning summary)</summary>
                <p className={styles.note} style={{ whiteSpace: "pre-wrap" }}>
                  {reasoning}
                </p>
              </details>
            ) : null}
          </div>
        </div>
      ) : null}

      {compare && result?.b64 && src && before ? (
        <details className={styles.details} open>
          <summary>Compare with what it edited</summary>
          <div className={styles.tight}>
            {parentResult?.b64 && rootUrl ? (
              <Segmented<"parent" | "source">
                size="sm"
                label="Compare with"
                value={compareWith}
                onChange={setCompareWith}
                options={[
                  { value: "parent", label: `Step ${parentNo}'s image` },
                  { value: "source", label: "The source photo" },
                ]}
              />
            ) : null}
            <ImageCompare before={before} after={{ src, label: `Step ${n}'s image` }} />
          </div>
        </details>
      ) : null}
    </li>
  );
}
