"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { Example } from "@/components/composer/Composer";
import { Icon, type IconName } from "@/components/icons";

/** One idea in a starter grid: a squircle icon and a short label; choosing it fills the composer with `note`. */
export interface StarterIdea {
  icon: IconName;
  label: string;
  note: string;
}

/**
 * A tab of starters under the Make page's composer (docs/BRAND.md, "Starters under the composer"), laid out like Meta
 * AI's: "ideas" is a grid of icon and label rows, "photos" is a strip of photo cards that attach their photo as inspo.
 */
export type StarterTab =
  | { id: string; label: string; kind: "ideas"; ideas: StarterIdea[] }
  | { id: string; label: string; kind: "photos"; examples: Example[] };

export function Starters({
  tabs,
  disabled,
  loadingLabel,
  onIdea,
  onPhoto,
}: {
  tabs: StarterTab[];
  disabled: boolean;
  /** The photo example whose photo is loading, if any. */
  loadingLabel: string | null;
  onIdea: (note: string) => void;
  onPhoto: (ex: Example) => void;
}) {
  const [active, setActive] = useState(tabs[0]?.id ?? "");
  const base = useId();
  const pills = useRef<(HTMLButtonElement | null)[]>([]);
  const tab = tabs.find((t) => t.id === active) ?? tabs[0];
  if (!tab) return null;

  // Arrow keys move between the pills, as in any tab list; Home and End jump to the ends.
  function onKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const last = tabs.length - 1;
    const to = e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (to === null) return;
    e.preventDefault();
    setActive(tabs[to]!.id);
    pills.current[to]?.focus();
  }

  return (
    <div className="starters">
      <div className="starter-pills" role="tablist" aria-label="Starters">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              pills.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={t.id === tab.id}
            aria-controls={`${base}-panel`}
            tabIndex={t.id === tab.id ? 0 : -1}
            className="starter-pill"
            onClick={() => setActive(t.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${tab.id}`} className="starter-panel">
        {tab.kind === "ideas" ? (
          <ul className="starter-grid">
            {tab.ideas.map((idea) => (
              <li key={idea.label}>
                <button type="button" className="starter-idea" onClick={() => onIdea(idea.note)} disabled={disabled}>
                  <span className="starter-icon">
                    <Icon name={idea.icon} size={26} />
                  </span>
                  <span className="starter-label">{idea.label}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="ex-grid ex-strip">
            {tab.examples.map((ex) => (
              <li key={ex.label}>
                <button
                  type="button"
                  className="ex-card"
                  title={ex.text}
                  onClick={() => onPhoto(ex)}
                  disabled={disabled || loadingLabel !== null}
                  aria-busy={loadingLabel === ex.label}
                >
                  {ex.image ? (
                    <span className="ex-media">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={ex.image} alt="" loading="lazy" />
                    </span>
                  ) : null}
                  <span className="ex-body">
                    <span className="ex-title">{ex.label}</span>
                    {ex.text ? (
                      <span className="ex-text" aria-hidden="true">
                        {ex.text}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
