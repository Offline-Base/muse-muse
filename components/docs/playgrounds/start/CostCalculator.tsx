"use client";

import { useId, useState } from "react";
import { Field, Segmented, TextInput } from "@/components/docs/kit/Field";
import { SplitPills } from "@/components/docs/playgrounds/start/SplitPills";
import {
  audioCostLines,
  compareTokenWorkload,
  exactUsd,
  imageCostLines,
  samCostLines,
  sumUsd,
  TOKEN_PRESETS,
  tokenCostLines,
  type CostLine,
  type TokenWork,
} from "@/components/docs/playgrounds/start/pricing";
import { TOKEN_MODELS } from "@/components/docs/playgrounds/start/facts";
import styles from "@/components/docs/playgrounds/start/start.module.css";

type Kind = "tokens" | "images" | "audio" | "sam";

/**
 * The pricing page's tables as a calculator: a token workload priced line by line on the model and mode picked, and
 * on every token model next to each other (Muse Wonder has no Contributor mode on pay-as-you-go); Muse Image per
 * image; Muse Voice Transcribe per second of audio, rounded down; SAM 3.1 per image and per video frame, at least 50
 * frames a video request. Nothing is sent: it's arithmetic on the page's prices.
 */
export function CostCalculator({ kind: initialKind = "tokens" }: { kind?: Kind }) {
  const id = useId();
  const [kind, setKind] = useState<Kind>(initialKind);
  return (
    <div className="pg">
      <div className="pg-bar">
        <Segmented<Kind>
          label="What to price"
          options={[
            { value: "tokens", label: "Text tokens" },
            { value: "images", label: "Muse Image" },
            { value: "audio", label: "Voice Transcribe" },
            { value: "sam", label: "SAM 3.1" },
          ]}
          value={kind}
          onChange={setKind}
        />
      </div>
      {kind === "tokens" ? <TokenCalculator id={id} /> : kind === "images" ? <ImageCalculator id={id} /> : kind === "audio" ? <AudioCalculator id={id} /> : <SamCalculator id={id} />}
    </div>
  );
}

function NumberField({ id, label, value, onChange, hint, max = 1e9, className }: { id: string; label: string; value: number; onChange(n: number): void; hint?: string; max?: number; className?: string }) {
  return (
    <Field id={id} label={label} hint={hint} className={className}>
      <TextInput
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        max={max}
        value={Number.isFinite(value) ? value : 0}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? Math.min(max, Math.max(0, Math.floor(n))) : 0);
        }}
      />
    </Field>
  );
}

function Lines({ lines, times = 1, caption }: { lines: CostLine[]; times?: number; caption: string }) {
  const total = sumUsd(lines) * times;
  return (
    <div className={styles.stack}>
      <div className={`docs-table ${styles.table}`} role="group" aria-label={caption} tabIndex={0}>
        <table>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Line</th>
              <th scope="col" className={styles.num}>
                Quantity
              </th>
              <th scope="col">Rate</th>
              <th scope="col" className={styles.num}>
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.label}>
                <td>{l.label}</td>
                <td className={styles.num}>
                  {l.quantity.toLocaleString("en-US")} {l.unit}
                </td>
                <td>{l.rate}</td>
                <td className={styles.num}>{exactUsd(l.usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.total} aria-live="polite">
        <span>{times > 1 ? `${times.toLocaleString("en-US")} requests at ${exactUsd(sumUsd(lines))} each` : "Total"}</span>
        <span className={styles.totalValue}>{exactUsd(total)}</span>
      </p>
    </div>
  );
}

function TokenCalculator({ id }: { id: string }) {
  const [work, setWork] = useState<TokenWork>(TOKEN_PRESETS[1].work);
  const [requests, setRequests] = useState(TOKEN_PRESETS[1].requests);
  const [preset, setPreset] = useState<number | null>(1);
  const [model, setModel] = useState("muse-spark-1.3-contributor");
  const row = TOKEN_MODELS.find((m) => m.id === model) ?? TOKEN_MODELS[4];
  const set = (patch: Partial<TokenWork>) => {
    setWork((w) => ({ ...w, ...patch }));
    setPreset(null);
  };
  const compare = compareTokenWorkload(work, requests);
  const cheapest = Math.min(...compare.filter((c) => c.usd !== null && c.usd > 0).map((c) => c.usd!));

  return (
    <div className={styles.stack}>
      <SplitPills
        label="Workload"
        keep={4}
        presets={TOKEN_PRESETS}
        active={preset}
        onPick={(i) => {
          setPreset(i);
          setWork(TOKEN_PRESETS[i].work);
          setRequests(TOKEN_PRESETS[i].requests);
        }}
      />
      <div className={styles.inputs}>
        <NumberField id={`${id}-in`} label="Input tokens" value={work.input} onChange={(input) => set({ input })} hint="Cached ones included" />
        <NumberField id={`${id}-cached`} label="Of which cached" className="pg-advanced" value={work.cached} onChange={(cached) => set({ cached })} hint="A prompt-cache hit" />
        <NumberField id={`${id}-out`} label="Output tokens" value={work.output} onChange={(output) => set({ output })} hint="Reasoning included" />
        <NumberField id={`${id}-search`} label="Web searches" className="pg-advanced" value={work.searches ?? 0} onChange={(searches) => set({ searches })} max={1000} />
        <NumberField id={`${id}-req`} label="Requests" className="pg-advanced" value={requests} onChange={(n) => { setRequests(Math.max(1, n)); setPreset(null); }} max={100_000_000} />
      </div>
      {work.cached > work.input ? <div className="pg-hint pg-bad">Cached tokens are part of input_tokens, so they count as at most the input.</div> : null}
      <span className="pg-inline-field">
        <label className="pg-label" htmlFor={`${id}-model`}>
          Model and mode
        </label>
        <span className="select-wrap">
          <select id={`${id}-model`} className="select pg-select" value={model} onChange={(e) => setModel(e.target.value)}>
            {TOKEN_MODELS.filter((m) => m.id).map((m) => (
              <option key={m.id} value={m.id!}>
                {m.label}
              </option>
            ))}
          </select>
        </span>
      </span>
      {row.rates ? <Lines lines={tokenCostLines(row.rates, work)} times={requests} caption={`${row.label} cost`} /> : null}
      <div className="pg-advanced">
        <p className="pg-section-label">The same workload on every token model</p>
        <div className={`docs-table ${styles.table}`} role="group" aria-label="The same workload on every model" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Mode</th>
                <th scope="col" className={styles.num}>
                  Cost
                </th>
                <th scope="col" className={styles.num}>
                  vs cheapest
                </th>
              </tr>
            </thead>
            <tbody>
              {compare.map(({ row: r, usd }) => (
                <tr key={r.label} className={r.id === model ? styles.rowActive : undefined}>
                  <td>{r.label}</td>
                  <td>{r.mode === "contributor" ? "Contributor" : "Standard"}</td>
                  <td className={styles.num}>{usd === null ? "Not available" : exactUsd(usd)}</td>
                  <td className={styles.num}>{usd === null || !Number.isFinite(cheapest) || !usd ? "" : usd === cheapest ? "cheapest" : `${(usd / cheapest).toFixed(usd / cheapest >= 10 ? 0 : 1)}x`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="pg-hint">
          Same rate whether the context window is nearly empty or nearly full: there&apos;s no long-context premium. Tokens Meta
          injects for steering aren&apos;t billed or counted. Contributor mode lets Meta train on what you send.
        </p>
      </div>
    </div>
  );
}

function ImageCalculator({ id }: { id: string }) {
  const [images, setImages] = useState(100);
  return (
    <div className={styles.stack}>
      <div className={styles.inputs}>
        <NumberField id={`${id}-images`} label="Images returned" value={images} onChange={setImages} hint="n images per call bill as n" />
      </div>
      <Lines lines={imageCostLines(images)} caption="Muse Image cost" />
      <p className="pg-hint">
        A flat $0.01 per generated image, whatever the prompt length, reasoning_strength or tools it used (its web and image search is
        included). Images that fail or are removed by safety filtering aren&apos;t billed. The usage object&apos;s token counts are for
        reference only.
      </p>
    </div>
  );
}

function AudioCalculator({ id }: { id: string }) {
  const [h, setH] = useState(1);
  const [m, setM] = useState(0);
  const [s, setS] = useState(0);
  const seconds = h * 3600 + m * 60 + s;
  return (
    <div className={styles.stack}>
      <div className={styles.inputs}>
        <NumberField id={`${id}-h`} label="Hours" value={h} onChange={setH} max={100_000} />
        <NumberField id={`${id}-m`} label="Minutes" value={m} onChange={setM} max={59} />
        <NumberField id={`${id}-s`} label="Seconds" value={s} onChange={setS} max={59} />
      </div>
      <Lines lines={audioCostLines(seconds)} caption="Muse Voice Transcribe cost" />
      <p className="pg-hint">
        Billed by audio processed, in whole seconds rounded down: $0.18 an hour, the same for realtime and file transcription.
        Contributor mode isn&apos;t available; zero data retention costs the same as Standard mode.
      </p>
    </div>
  );
}

function SamCalculator({ id }: { id: string }) {
  const [images, setImages] = useState(1000);
  const [frames, setFrames] = useState(24);
  const [requests, setRequests] = useState(10);
  return (
    <div className={styles.stack}>
      <div className={styles.inputs}>
        <NumberField id={`${id}-sam-images`} label="Images segmented" value={images} onChange={setImages} />
        <NumberField id={`${id}-frames`} label="Frames per video request" value={frames} onChange={setFrames} hint="Billed as at least 50" />
        <NumberField id={`${id}-videos`} label="Video requests" value={requests} onChange={setRequests} />
      </div>
      <Lines lines={samCostLines(images, frames, requests)} caption="SAM 3.1 cost" />
      <p className="pg-hint">
        Per image and per video frame, not per token, streaming or not. A clip or tracking range under 50 frames is billed as 50;
        the response&apos;s usage.video_frames_processed reports the frames billed.
      </p>
    </div>
  );
}
