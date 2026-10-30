"use client";

import { PresetPills } from "@/components/docs/kit/Field";

/**
 * PresetPills that keep the "Try it live" simple view to one row: the first `keep` pills always show, and the rest
 * wait behind Options as a second row (components/docs/kit/README.md, "Simple view and pg-advanced"). `active` and
 * `onPick` use the index in the whole list.
 */
export function PresetRow({
  label,
  presets,
  active,
  onPick,
  disabled,
  keep = 5,
}: {
  label?: string;
  presets: ReadonlyArray<{ label: string }>;
  active?: number | null;
  onPick(index: number): void;
  disabled?: boolean;
  keep?: number;
}) {
  if (presets.length <= keep) return <PresetPills label={label} presets={presets} active={active} onPick={onPick} disabled={disabled} />;
  return (
    <>
      <PresetPills label={label} presets={presets.slice(0, keep)} active={active} onPick={onPick} disabled={disabled} />
      <div className="pg-advanced">
        <PresetPills label="More" presets={presets.slice(keep)} active={active == null ? active : active - keep} onPick={(i) => onPick(i + keep)} disabled={disabled} />
      </div>
    </>
  );
}
