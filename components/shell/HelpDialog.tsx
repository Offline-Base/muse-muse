"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "@/components/icons";
import { HELP_SECTIONS, isActive, isHelpPath, type HelpCard } from "@/components/shell/nav";

/** The section a path belongs to, so Help opens on the page you're on. The first one otherwise. */
function sectionFor(pathname: string): string {
  return HELP_SECTIONS.find((s) => isActive(s.item, pathname))?.id ?? HELP_SECTIONS[0]!.id;
}

/**
 * The sidebar's Help row and the window it opens, laid out like meta.ai's Settings (docs/BRAND.md, "Settings window"):
 * a rounded panel with the sections listed on the left and the open section's cards on the right, and a round close
 * button in the corner. A modal <dialog>, so focus stays inside, Escape closes it and focus goes back to Help. The list is
 * a vertical tab list: arrow keys, Home and End move between sections.
 */
export function HelpDialog({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname() ?? "/";
  const dialog = useRef<HTMLDialogElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const [open, setOpen] = useState(sectionFor(pathname));
  const base = useId();
  const section = HELP_SECTIONS.find((s) => s.id === open) ?? HELP_SECTIONS[0]!;

  // A page change closes the window, as it does the phone menu.
  useEffect(() => {
    dialog.current?.close();
  }, [pathname]);

  const show = () => {
    const id = sectionFor(pathname);
    setOpen(id);
    dialog.current?.showModal();
    // Start on the open section's tab, the way the window opens on the page you're on.
    tabs.current[HELP_SECTIONS.findIndex((s) => s.id === id)]?.focus();
  };
  const close = () => dialog.current?.close();
  const follow = () => {
    close();
    onNavigate?.();
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = HELP_SECTIONS.length - 1;
    const to =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? (index + 1) % HELP_SECTIONS.length
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? (index - 1 + HELP_SECTIONS.length) % HELP_SECTIONS.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (to === null) return;
    e.preventDefault();
    setOpen(HELP_SECTIONS[to]!.id);
    tabs.current[to]?.focus();
  };

  return (
    <>
      <button
        type="button"
        className={`nav-link nav-button${isHelpPath(pathname) ? " is-current" : ""}`}
        aria-haspopup="dialog"
        onClick={show}
      >
        <Icon name="help" size={24} />
        <span>Help</span>
      </button>
      <dialog
        ref={dialog}
        className="settings"
        aria-labelledby={`${base}-title`}
        onClick={(e) => {
          // A click on the backdrop lands on the dialog element itself.
          if (e.target === e.currentTarget) close();
        }}
      >
        <div className="settings-frame">
          <div className="settings-side">
            <h2 id={`${base}-title`} className="settings-title">
              Help
            </h2>
            <div className="settings-tabs" role="tablist" aria-orientation="vertical" aria-labelledby={`${base}-title`}>
              {HELP_SECTIONS.map((s, i) => {
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
                    <Icon name={s.item.icon} size={22} />
                    <span>{s.item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <section
            className="settings-pane"
            role="tabpanel"
            id={`${base}-panel`}
            aria-labelledby={`${base}-tab-${section.id}`}
          >
            <h3 className="settings-pane-title">{section.item.label}</h3>
            <p className="settings-group">{section.group}</p>
            <ul className="settings-cards">
              {section.cards.map((card) => (
                <li key={card.href}>
                  <HelpCardLink card={card} pathname={pathname} onFollow={follow} />
                </li>
              ))}
            </ul>
          </section>
          <button type="button" className="settings-close" aria-label="Close help" onClick={close}>
            <Icon name="close" size={20} />
          </button>
        </div>
      </dialog>
    </>
  );
}

function HelpCardLink({ card, pathname, onFollow }: { card: HelpCard; pathname: string; onFollow: () => void }) {
  const body = (
    <>
      <Icon name={card.icon} size={24} className="settings-card-icon" />
      <span className="settings-card-text">
        <span className="settings-card-title">{card.title}</span>
        <span className="settings-card-sub">{card.text}</span>
      </span>
    </>
  );
  if (card.external) {
    return (
      <a className="settings-card" href={card.href} target="_blank" rel="noopener noreferrer">
        {body}
        <Icon name="external" size={18} className="settings-card-end" />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  const here = pathname === card.href;
  return (
    <Link className="settings-card" href={card.href} aria-current={here ? "page" : undefined} onClick={onFollow}>
      {body}
      <Icon name="chevronRight" size={18} className="settings-card-end" />
    </Link>
  );
}
