"use client";

import { Menu } from "@/components/Menu";
import { targetLabel } from "@/lib/format";
import type { TargetId } from "@/lib/brief/schema";

/** One short line per target in the menu. */
const TARGET_NOTES: Record<TargetId, string> = {
  web: "Always on, with its own link",
  phone: "An Android app and an iPhone icon",
  desktop: "A Mac app and a Windows app",
  vr: "Meta Quest, from its link",
  glasses: "Meta glasses, through the iPhone app",
  agent: "Looks things up and works in steps",
};

/** What the pill says: "Auto" with nothing picked, the names for one or two picks, a count past that. */
export function targetPillText(picked: readonly TargetId[]): string {
  if (!picked.length) return "Auto";
  if (picked.length > 2) return `Web + ${picked.length} more`;
  return ["web" as const, ...picked].map(targetLabel).join(" + ");
}

/**
 * Where a build runs, in the composer's pill slot, left of the mic. Auto lets the brief writer choose, and any pick
 * becomes exactly what the build makes. Web is always on, so it stays checked and locked.
 */
export function TargetPill({
  options,
  picked,
  onChange,
  disabled,
}: {
  /** The targets whose flags are on. Never web. */
  options: readonly TargetId[];
  picked: readonly TargetId[];
  onChange: (next: TargetId[]) => void;
  disabled?: boolean;
}) {
  const text = targetPillText(picked);
  return (
    <Menu text={text} label={`Where it runs: ${text}`} textIsLabel={false} align="end" buttonClassName="composer-pill target-pill" disabled={disabled}>
      <p className="target-menu-note muted small">Auto lets Muse choose where it runs.</p>
      <ul className="menu-list">
        {(["web", ...options] as TargetId[]).map((id) => (
          <li key={id}>
            <label className="menu-item target-menu-item">
              <input
                type="checkbox"
                checked={id === "web" || picked.includes(id)}
                disabled={id === "web"}
                onChange={(e) => onChange(options.filter((t) => (t === id ? e.target.checked : picked.includes(t))))}
              />
              <span className="menu-item-text">
                <span>{targetLabel(id)}</span>
                <span className="muted small">{TARGET_NOTES[id]}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </Menu>
  );
}
