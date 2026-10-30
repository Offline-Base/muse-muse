"use client";

import { useId, useMemo, useState } from "react";
import { Field, PresetPills, TextArea, TextInput } from "@/components/docs/kit/Field";
import { TabPanel, Tabs } from "@/components/docs/kit/Tabs";
import { DatasetCheck } from "@/components/docs/playgrounds/open-weights/DatasetCheck";
import { DEBUG_IMAGE_CAP, MASK_PRESETS, SFT_DEFAULTS, audioTokens, imagePatchTokens, lossMask, sciNum, sftPlan, trainedShare, type SftOptions } from "@/components/docs/playgrounds/open-weights/torchtitan";
import { Issues, NumberField, SegmentField, Status, Steps } from "@/components/docs/playgrounds/open-weights/ui";
import styles from "@/components/docs/playgrounds/open-weights/ow.module.css";

/**
 * The TorchTitan SFT recipe for Muse Spark Open (cookbook/muse-spark-open-torchtitan-sft) as a lab: build the recipe
 * and its run commands (text or image and audio, smoke test or the full model), see which tokens carry loss in a
 * conversation, count how many placeholder tokens an image or a clip expands to, and check rows in the one format the
 * recipe takes.
 */

export interface SftLabProps {
  slug: string;
}

export function SftLab(_props: SftLabProps) {
  const id = useId();
  const [tab, setTab] = useState<"recipe" | "mask" | "media" | "data">("recipe");
  return (
    <div className="pg">
      <Tabs
        label="SFT"
        idBase={id}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "recipe", label: "Recipe builder" },
          { id: "mask", label: "What gets trained" },
          { id: "media", label: "Media tokens" },
          { id: "data", label: "Check your data" },
        ]}
      />
      <TabPanel idBase={id} id="recipe" active={tab === "recipe"}>
        <Recipe />
      </TabPanel>
      <TabPanel idBase={id} id="mask" active={tab === "mask"}>
        <Mask />
      </TabPanel>
      <TabPanel idBase={id} id="media" active={tab === "media"}>
        <MediaTokens />
      </TabPanel>
      <TabPanel idBase={id} id="data" active={tab === "data"}>
        <DatasetCheck formats={["torchtitan-sft"]} />
      </TabPanel>
    </div>
  );
}

function Recipe() {
  const id = useId();
  const [o, setO] = useState<SftOptions>(SFT_DEFAULTS);
  const [data, setData] = useState(SFT_DEFAULTS.data.join("\n"));
  const [lr, setLr] = useState(sciNum(SFT_DEFAULTS.lr));
  const opts: SftOptions = { ...o, data: data.split("\n"), lr: Number(lr) > 0 ? Number(lr) : SFT_DEFAULTS.lr };
  const plan = useMemo(() => sftPlan(opts), [JSON.stringify(opts)]); // eslint-disable-line react-hooks/exhaustive-deps
  const presets = [
    { label: "Text smoke test (1 GPU)", modality: "text" as const, run: "smoke" as const, data: "/data/dolly/train.jsonl" },
    { label: "Text, full model", modality: "text" as const, run: "full" as const, data: "/data/dolly/train.jsonl" },
    { label: "Image and audio smoke test", modality: "media" as const, run: "smoke" as const, data: "/data/llava/train.jsonl\n/data/librispeech/train.jsonl" },
    { label: "Image and audio, full model", modality: "media" as const, run: "full" as const, data: "/data/llava/train.jsonl\n/data/librispeech/train.jsonl" },
  ];
  const [preset, setPreset] = useState<number | null>(0);
  return (
    <div className={styles.stack}>
      <PresetPills
        presets={presets}
        active={preset}
        onPick={(i) => {
          const p = presets[i];
          setPreset(i);
          setO((c) => ({ ...c, modality: p.modality, run: p.run }));
          setData(p.data);
        }}
      />
      <div className={styles.options}>
        <SegmentField<SftOptions["modality"]>
          label="Data"
          value={o.modality}
          options={[
            { value: "text", label: "Text" },
            { value: "media", label: "Image and audio" },
          ]}
          onChange={(modality) => {
            setPreset(null);
            setO((c) => ({ ...c, modality }));
          }}
        />
        <SegmentField<SftOptions["run"]>
          label="Run"
          value={o.run}
          options={[
            { value: "smoke", label: "Smoke test, 1 GPU" },
            { value: "full", label: "816B from the release" },
          ]}
          onChange={(run) => {
            setPreset(null);
            setO((c) => ({ ...c, run }));
          }}
        />
        <Field id={`${id}-lr`} label="lr" hint="1e-5 in the recipe; another value runs as your own function." className="pg-advanced">
          <TextInput id={`${id}-lr`} value={lr} onChange={(e) => setLr(e.target.value)} spellCheck={false} inputMode="decimal" aria-describedby={`${id}-lr-hint`} />
        </Field>
        {o.modality === "text" ? (
          <>
            <Field id={`${id}-date`} label="current_date (pinned)" hint="2026-01-15 in the recipe." className="pg-advanced">
              <TextInput id={`${id}-date`} value={o.currentDate} onChange={(e) => setO((c) => ({ ...c, currentDate: e.target.value }))} spellCheck={false} aria-describedby={`${id}-date-hint`} />
            </Field>
            <SegmentField<SftOptions["effort"]> advanced label="reasoning_effort (pinned)" value={o.effort} options={(["low", "medium", "high", "xhigh"] as const).map((e) => ({ value: e, label: e }))} onChange={(effort) => setO((c) => ({ ...c, effort }))} hint="xhigh in the recipe." />
          </>
        ) : null}
        <Field id={`${id}-data`} label="JSONL files, one per line" className={`${styles.optionWide} pg-advanced`}>
          <TextArea id={`${id}-data`} rows={2} className="pg-code-input" value={data} onChange={(e) => { setPreset(null); setData(e.target.value); }} spellCheck={false} />
        </Field>
      </div>
      <Issues warnings={plan.warnings} notes={plan.notes} />
      <Steps steps={plan.steps} label="SFT recipe" />
    </div>
  );
}

function Mask() {
  const [i, setI] = useState(0);
  const segments = useMemo(() => lossMask(MASK_PRESETS[i].messages), [i]);
  const share = trainedShare(segments);
  return (
    <div className={styles.stack}>
      <PresetPills presets={MASK_PRESETS} active={i} onPick={setI} label="Conversation" />
      <pre className={styles.render} aria-label="The conversation with trained tokens marked" tabIndex={0}>
        {segments.map((s, j) => (
          <span key={j} className={`${s.trained ? styles.tokTrained : styles.tokMasked} ${s.special ? (s.media ? styles.tokMedia : styles.tokSpecial) : ""}`}>
            {s.text}
          </span>
        ))}
      </pre>
      <ul className={`${styles.legend} pg-advanced`}>
        <li>
          <span className={styles.tokTrained}>&nbsp;to=user&lt;|message|&gt;&nbsp;</span> carries loss
        </li>
        <li>
          <span className={styles.tokMasked}>everything else</span> masked
        </li>
      </ul>
      <Status tone="ok">
        {Math.round((share.trainedChars / Math.max(1, share.totalChars)) * 100)}% of this conversation&apos;s text carries loss: only what the model generates when it answers.
      </Status>
      <Issues
        notes={[
          "The to=user recipient is trained: Muse Spark chooses who it's talking to, and that choice is part of the answer. <|start|>assistant isn't: at inference the prompt supplies it.",
          "Media tokens are never trained. The template's own system lines (the pinned date and reasoning effort) are left out of this view.",
          "Text conversations go through Muse Spark's renderer in TorchTitan's ChatProcessor; conversations with media through the checkpoint's chat template, whose Jinja generation blocks sft.py trims to the same tokens.",
        ]}
      />
    </div>
  );
}

function MediaTokens() {
  const id = useId();
  const [w, setW] = useState("448");
  const [h, setH] = useState("448");
  const [secs, setSecs] = useState("5");
  const patches = imagePatchTokens(Number(w) || 0, Number(h) || 0);
  const audio = audioTokens(Number(secs) || 0);
  return (
    <div className={styles.stack}>
      <div className={styles.grid2}>
        <div className={styles.card}>
          <h4 className={styles.cardTitle}>Image</h4>
          <div className={styles.options}>
            <NumberField id={`${id}-w`} label="Width (px)" value={w} min={1} step={14} onChange={setW} />
            <NumberField id={`${id}-h`} label="Height (px)" value={h} min={1} step={14} onChange={setH} />
          </div>
          <Status tone={patches > DEBUG_IMAGE_CAP ? "warn" : "ok"}>
            {patches.toLocaleString("en-US")} &lt;|patch|&gt; tokens: one per 2x2 group of 14-pixel patches ({Math.ceil((Number(w) || 0) / 28)} × {Math.ceil((Number(h) || 0) / 28)}).
          </Status>
          <pre className={`${styles.render} pg-advanced`} style={{ maxHeight: 120 }}>
            {`rendered:  <|start|>user<|message|><|patch|>What color is the horse?<|eot|>\nexpanded:  <|start|>user<|message|><|image_start|><|patch|> x ${patches} <|image_end|>What color...`}
          </pre>
          <p className="pg-hint">
            At the size the encoder sees, before any resizing the processor does. The debug model caps images at {DEBUG_IMAGE_CAP} tokens to fit its 512-token context.
          </p>
        </div>
        <div className={styles.card}>
          <h4 className={styles.cardTitle}>Audio</h4>
          <NumberField id={`${id}-s`} label="Clip length (seconds)" value={secs} min={0} step={1} onChange={setSecs} />
          <Status tone="ok">
            {audio.toLocaleString("en-US")} &lt;|audio|&gt; tokens: one per 1,920 samples at 24 kHz, 12.5 a second.
          </Status>
          <p className="pg-hint">Audio for the recipe is 16-bit PCM WAV, mono, any sample rate.</p>
        </div>
      </div>
      <Issues
        notes={[
          "The template writes one placeholder per media part; the processor loads the media, counts the embeddings the encoder will emit, and expands the placeholder to match. The count must match exactly, so sft.py reads the geometry from the model config.",
          "MMSamplePackingConfig keeps each image and clip with its conversation, and dataset_modalities runs an absent encoder on a dummy input so every GPU joins the same collectives.",
        ]}
      />
    </div>
  );
}
