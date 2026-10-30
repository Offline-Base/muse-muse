"use client";

import { useState } from "react";
import { PresetPills } from "@/components/docs/kit/Field";
import { ApiConsole, type ApiConsoleProps } from "@/components/docs/playgrounds/common/ApiConsole";

/**
 * The API console with a page's working requests as preset pills: each preset is a full ApiConsole setup (method,
 * path, body, file slots), so picking one loads a request that runs as it is. The console keeps its own state, so a
 * new preset mounts a fresh one; the reader's edits to the current preset stay until they pick another.
 */

export interface ConsolePreset {
  label: string;
  /** A line under the pills: what this request shows. */
  note?: string;
  console: ApiConsoleProps;
}

export interface ConsolePresetsProps {
  slug: string;
  presets: ConsolePreset[];
  /** The pills' label. Default "Request". */
  label?: string;
  /** The preset that loads first. Default 0. */
  start?: number;
}

export function ConsolePresets({ presets, label = "Request", start = 0 }: ConsolePresetsProps) {
  const [active, setActive] = useState(Math.min(Math.max(0, start), Math.max(0, presets.length - 1)));
  const preset = presets[active];
  if (!preset) return null;
  return (
    <div className="pg">
      {presets.length > 1 ? <PresetPills label={label} presets={presets} active={active} onPick={setActive} /> : null}
      {preset.note ? <p className="pg-hint">{preset.note}</p> : null}
      <ApiConsole key={active} {...preset.console} />
    </div>
  );
}
