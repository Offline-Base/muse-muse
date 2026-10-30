"use client";

import { PresetPills } from "@/components/docs/kit/Field";

/**
 * The kit's PresetPills in two groups, so "Try it live" opens with one row of examples: the first `keep` pills always
 * show, and the rest sit in a second group that carries pg-advanced, so they appear with Options on. `active` and
 * `onPick` still use the index into the whole list.
 */
export function SplitPills({
  label,
  presets,
  active,
  onPick,
  disabled,
  keep = 5,
}: {
  label: string;
  presets: ReadonlyArray<{ label: string }>;
  active?: number | null;
  onPick(index: number): void;
  disabled?: boolean;
  keep?: number;
}) {
  const inFirst = typeof active === "number" && active < keep;
  const inRest = typeof active === "number" && active >= keep;
  const rest = presets.slice(keep);
  return (
    <>
      <PresetPills label={label} presets={presets.slice(0, keep)} active={inFirst ? active : null} onPick={onPick} disabled={disabled} />
      {rest.length ? (
        <div className="pg-advanced">
          <PresetPills label={label} presets={rest} active={inRest ? active - keep : null} onPick={(i) => onPick(i + keep)} disabled={disabled} />
        </div>
      ) : null}
    </>
  );
}
