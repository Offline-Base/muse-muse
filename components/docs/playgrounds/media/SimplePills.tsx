"use client";

import { PresetPills } from "@/components/docs/kit/Field";

/**
 * A row of preset pills for the "Try it live" simple view: the first `visible` pills stay, and the rest sit in a row of
 * their own behind Options (`pg-advanced`), or all of them with `advanced`, for a demo's extra rows.
 */
export function SimplePills({
  label,
  presets,
  active,
  onPick,
  disabled,
  visible = 5,
  advanced = false,
}: {
  label?: string;
  presets: ReadonlyArray<{ label: string }>;
  active?: number | null;
  onPick(index: number): void;
  disabled?: boolean;
  visible?: number;
  advanced?: boolean;
}) {
  const split = advanced ? 0 : visible;
  const at = active ?? null;
  return (
    <>
      {split > 0 ? <PresetPills label={label} presets={presets.slice(0, split)} active={at !== null && at < split ? at : null} onPick={onPick} disabled={disabled} /> : null}
      {presets.length > split ? (
        <div className="pg-advanced">
          <PresetPills label={label} presets={presets.slice(split)} active={at !== null && at >= split ? at - split : null} onPick={(i) => onPick(i + split)} disabled={disabled} />
        </div>
      ) : null}
    </>
  );
}
