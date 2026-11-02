"use client";

import { useId, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Icon, type IconName } from "@/components/icons";

export interface SettingsSection {
  id: string;
  label: string;
  icon: IconName;
  /** What the right side shows under the section's name. */
  body: ReactNode;
}

export interface SettingsWindowHandle {
  /** Opens the window on a section (the first one by default) and focuses that section's tab. */
  show: (sectionId?: string) => void;
  close: () => void;
}

/**
 * A window laid out like meta.ai's Settings (docs/BRAND.md, "Settings window"): a rounded panel with the sections listed
 * on the left and the open section on the right, and a round close button in the corner. A modal <dialog>, so focus
 * stays inside, Escape closes it and focus goes back to the button that opened it. The list is a vertical tab list:
 * arrow keys, Home and End move between sections. Help and Settings both use it.
 */
export function SettingsWindow({
  title,
  closeLabel,
  sections,
  initial,
  ref,
}: {
  title: string;
  closeLabel: string;
  sections: SettingsSection[];
  /** The section it starts on before the first show(). */
  initial?: string;
  ref?: Ref<SettingsWindowHandle>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const [open, setOpen] = useState(initial ?? sections[0]!.id);
  const base = useId();
  const section = sections.find((s) => s.id === open) ?? sections[0]!;

  useImperativeHandle(ref, () => ({
    show: (sectionId) => {
      const index = Math.max(0, sections.findIndex((s) => s.id === sectionId));
      setOpen(sections[index]!.id);
      dialog.current?.showModal();
      tabs.current[index]?.focus();
    },
    close: () => dialog.current?.close(),
  }));

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const n = sections.length;
    const to =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? (index + 1) % n
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? (index - 1 + n) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    setOpen(sections[to]!.id);
    tabs.current[to]?.focus();
  };

  return (
    <dialog
      ref={dialog}
      className="settings"
      aria-labelledby={`${base}-title`}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === e.currentTarget) dialog.current?.close();
      }}
    >
      <div className="settings-frame">
        <div className="settings-side">
          <h2 id={`${base}-title`} className="settings-title">
            {title}
          </h2>
          <div className="settings-tabs" role="tablist" aria-orientation="vertical" aria-labelledby={`${base}-title`}>
            {sections.map((s, i) => {
              const selected = s.id === section.id;
              return (
                <button
                  key={s.id}
                  ref={(el) => {
                    tabs.current[i] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`${base}-tab-${s.id}`}
                  aria-selected={selected}
                  aria-controls={`${base}-panel`}
                  tabIndex={selected ? 0 : -1}
                  className="settings-tab"
                  onClick={() => setOpen(s.id)}
                  onKeyDown={(e) => onTabKey(e, i)}
                >
                  <Icon name={s.icon} size={22} />
                  <span>{s.label}</span>
                </button>
              );
            })}
          </div>
        </div>
        <section className="settings-pane" role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${section.id}`}>
          <h3 className="settings-pane-title">{section.label}</h3>
          {section.body}
        </section>
        <button type="button" className="settings-close" aria-label={closeLabel} onClick={() => dialog.current?.close()}>
          <Icon name="close" size={20} />
        </button>
      </div>
    </dialog>
  );
}
