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

/** What the pill says: "Auto" with nothing picked, the name for one pick, a count past that, which stays short on a phone. */
export function targetPillText(picked: readonly TargetId[]): string {
  if (!picked.length) return "Auto";
  if (picked.length > 1) return `Web + ${picked.length} more`;
  return ["web" as const, ...picked].map(targetLabel).join(" + ");
}

/** One row: a check mark beside its name and a short line, grey when picked. The checkbox stays for keyboards and screen readers. */
function targetRow({ title, note, checked, locked, quiet, onToggle }: { title: string; note: string; checked: boolean; locked?: boolean; quiet?: boolean; onToggle: (on: boolean) => void }) {
  return (
    <label className={`menu-item target-menu-item${checked && !quiet ? " is-picked" : ""}${quiet ? " is-quiet" : ""}`}>
      <input
        type="checkbox"
        className="target-menu-box"
        checked={checked}
        disabled={locked}
        onChange={(e) => onToggle(e.target.checked)}
        onKeyDown={(e) => {
          // Enter in a form's checkbox would send the form, and start a build on half-made picks. Here it toggles, as Space does.
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.click();
          }
        }}
      />
      <span className="target-menu-check" aria-hidden="true">
        {checked ? (
          <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 10.5 8.2 15 16 5.5" />
          </svg>
        ) : null}
      </span>
      <span className="menu-item-text target-menu-text">
        <span>{title}</span>
        <span className="muted small">{note}</span>
      </span>
    </label>
  );
}

/**
 * Where a build runs, in the composer's pill slot, left of the mic. Auto lets the brief writer choose, and any pick
 * becomes exactly what the build makes. Web is always on, so it stays checked and locked. Several can be picked.
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
      <ul className="menu-list target-menu-list">
        {options.length ? (
          <li>
            {targetRow({ title: "Auto", note: "Muse chooses where it runs", checked: !picked.length, locked: !picked.length, onToggle: () => onChange([]) })}
          </li>
        ) : null}
        {(["web", ...options] as TargetId[]).map((id) => (
          <li key={id}>
            {targetRow({
              title: targetLabel(id),
              note: TARGET_NOTES[id],
              checked: id === "web" || picked.includes(id),
              locked: id === "web",
              quiet: id === "web",
              onToggle: (on) => onChange(options.filter((t) => (t === id ? on : picked.includes(t)))),
            })}
          </li>
        ))}
      </ul>
    </Menu>
  );
}
