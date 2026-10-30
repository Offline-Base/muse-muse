"use client";

/** Pills the simple view keeps: what fits one row of the "Try it live" panel, with these labels. */
const SIMPLE_PILLS = 4;

/**
 * The kit's preset pills (its markup, so a single pill can carry a class), one row per group ("Try", "Video",
 * "Errors (400)"), so a page with many working examples stays scannable. The simple view keeps the first group's first
 * pills; the rest wait behind Options. `active` and `onPick` use indexes into the whole list.
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
      {groups.map((g, row) => {
        const indexes = presets.map((p, i) => (groupOf(p) === g ? i : -1)).filter((i) => i >= 0);
        return (
          <div key={g} className={row ? "pg-presets pg-advanced" : "pg-presets"} role="group" aria-label={g}>
            <span className="pg-presets-label" aria-hidden>
              {g}
            </span>
            {indexes.map((i, at) => (
              <button
                key={`${i}-${presets[i].label}`}
                type="button"
                className={at < SIMPLE_PILLS ? "pg-pill" : "pg-pill pg-advanced"}
                aria-pressed={active === i}
                disabled={disabled}
                onClick={() => onPick(i)}
              >
                {presets[i].label}
              </button>
            ))}
          </div>
        );
      })}
    </>
  );
}
