"use client";

import { PresetPills } from "@/components/docs/kit/Field";

/**
 * The kit's preset pills, one row per group ("Try", "Video", "Errors (400)"), so a page with many working examples
 * stays scannable. `active` and `onPick` use indexes into the whole list.
 */
export function GroupedPresets<P extends { label: string; group?: string }>({
  presets,
  active,
  onPick,
  disabled,
}: {
  presets: readonly P[];
  active: number | null;
  onPick(index: number): void;
  disabled?: boolean;
}) {
  const groupOf = (p: P) => p.group ?? "Try";
  const groups = [...new Set(presets.map(groupOf))];
  return (
    <>
      {groups.map((g) => {
        const indexes = presets.map((p, i) => (groupOf(p) === g ? i : -1)).filter((i) => i >= 0);
        const at = active === null ? -1 : indexes.indexOf(active);
        return (
          <PresetPills
            key={g}
            label={g}
            presets={indexes.map((i) => presets[i])}
            active={at >= 0 ? at : null}
            onPick={(i) => onPick(indexes[i])}
            disabled={disabled}
          />
        );
      })}
    </>
  );
}
