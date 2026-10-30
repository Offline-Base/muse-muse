"use client";

import { useId, useState } from "react";
import { PresetPills } from "@/components/docs/kit/Field";
import { Tabs } from "@/components/docs/kit/Tabs";
import { TranscribePlayground, type TranscribePlaygroundProps } from "@/components/docs/media/TranscribePlayground";
import styles from "@/components/docs/playgrounds/cookbook-media/cookbook-media.module.css";
import { PacingSimulator } from "@/components/docs/playgrounds/cookbook-media/PacingSimulator";

export interface TranscribePreset {
  label: string;
  /** What the preset shows, in the recipe's terms. */
  note: string;
  /** The playground's starting settings for it: endpoint, sample, mode, keywords. */
  props: Omit<TranscribePlaygroundProps, "slug">;
}

export interface TranscribeRecipeProps {
  slug?: string;
  presets: TranscribePreset[];
  /** Add the cutoff simulator as a second tab. */
  simulator?: boolean;
}

type Tab = "live" | "cutoffs";

/**
 * The speech-to-text recipe's variations as presets over the media kit's TranscribePlayground (stream a recording,
 * dictate, diarize, one request, bias), each a working request; picking one starts the playground fresh with its
 * settings. A second tab simulates the realtime cutoff rules. Both tabs stay mounted, so switching keeps their state.
 */
export function TranscribeRecipe({ presets, simulator = true }: TranscribeRecipeProps) {
  const id = useId();
  const [picked, setPicked] = useState(0);
  const [tab, setTab] = useState<Tab>("live");
  const preset = presets[picked] ?? presets[0];
  const tabs = [
    { id: "live" as const, label: "Transcribe live" },
    ...(simulator ? [{ id: "cutoffs" as const, label: "Cutoff simulator" }] : []),
  ];

  const live = (
    <div className={styles.stack}>
      <PresetPills label="Recipe step" presets={presets} active={picked} onPick={setPicked} />
      {preset ? <p className={styles.note}>{preset.note}</p> : null}
      {preset ? <TranscribePlayground key={picked} {...preset.props} /> : null}
    </div>
  );

  if (tabs.length < 2) return <div className={`pg ${styles.stack}`}>{live}</div>;
  return (
    <div className={`pg ${styles.stack}`}>
      <Tabs<Tab> label="Speech to text demo" idBase={id} tabs={tabs} value={tab} onChange={setTab} />
      {/* Panels stay mounted (hidden when not shown) so the playground keeps its audio and results. */}
      <div role="tabpanel" id={`${id}-panel-live`} aria-labelledby={`${id}-tab-live`} hidden={tab !== "live"} className="pg-panel">
        {live}
      </div>
      <div role="tabpanel" id={`${id}-panel-cutoffs`} aria-labelledby={`${id}-tab-cutoffs`} hidden={tab !== "cutoffs"} className="pg-panel">
        <PacingSimulator />
      </div>
    </div>
  );
}
