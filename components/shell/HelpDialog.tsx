"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { Icon } from "@/components/icons";
import { HELP_SECTIONS, isActive, isHelpPath, type HelpCard } from "@/components/shell/nav";
import { SettingsWindow, type SettingsWindowHandle } from "@/components/shell/SettingsWindow";

/** The section a path belongs to, so Help opens on the page you're on. The first one otherwise. */
function sectionFor(pathname: string): string {
  return HELP_SECTIONS.find((s) => isActive(s.item, pathname))?.id ?? HELP_SECTIONS[0]!.id;
}

/** The sidebar's Help row and its window (SettingsWindow): How it works and the Model API docs, as cards. */
export function HelpDialog({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname() ?? "/";
  const win = useRef<SettingsWindowHandle>(null);

  // A page change closes the window, as it does the phone menu.
  useEffect(() => {
    win.current?.close();
  }, [pathname]);

  const follow = () => {
    win.current?.close();
    onNavigate?.();
  };

  return (
    <>
      <button
        type="button"
        className={`nav-link nav-button${isHelpPath(pathname) ? " is-current" : ""}`}
        aria-haspopup="dialog"
        onClick={() => win.current?.show(sectionFor(pathname))}
      >
        <Icon name="help" size={24} />
        <span>Help</span>
      </button>
      <SettingsWindow
        ref={win}
        title="Help"
        closeLabel="Close help"
        initial={sectionFor(pathname)}
        sections={HELP_SECTIONS.map((s) => ({
          id: s.id,
          label: s.item.label,
          icon: s.item.icon,
          body: (
            <>
              <p className="settings-group">{s.group}</p>
              <ul className="settings-cards">
                {s.cards.map((card) => (
                  <li key={card.href}>
                    <HelpCardLink card={card} pathname={pathname} onFollow={follow} />
                  </li>
                ))}
              </ul>
            </>
          ),
        }))}
      />
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
