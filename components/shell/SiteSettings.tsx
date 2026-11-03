"use client";

import Link from "next/link";
import { useEffect, useId, useState, type Ref } from "react";
import { Icon } from "@/components/icons";
import type { AccountUser } from "@/components/shell/AccountMenu";
import { DISCLAIMER } from "@/components/shell/disclaimer";
import { SettingsWindow, type SettingsWindowHandle } from "@/components/shell/SettingsWindow";
import { initials } from "@/lib/format";
import { useMuseMode } from "@/components/mascot/AgentMuse";
import { readMascotOn, setMascotOn } from "@/lib/mascot";
import { THEME_CHOICES, applyTheme, isThemeChoice, readTheme, type ThemeChoice } from "@/lib/theme";

/** Theme: System, Light or Dark, as a row in a settings list (meta.ai's Settings, "Theme  System ⌄"). */
function ThemeRow() {
  const id = useId();
  // The saved choice lives in the browser, so it's read after mount; the server always renders System.
  const [theme, setTheme] = useState<ThemeChoice>("system");
  useEffect(() => setTheme(readTheme()), []);
  return (
    <div className="settings-row">
      <label htmlFor={id}>Theme</label>
      <span className="settings-select">
        <select
          id={id}
          value={theme}
          onChange={(e) => {
            const next = e.target.value;
            if (!isThemeChoice(next)) return;
            setTheme(next);
            applyTheme(next);
          }}
        >
          {THEME_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={18} aria-hidden />
      </span>
    </div>
  );
}

/** Muse on screen: the mascot walking along the bottom (components/mascot/Mascot.tsx), on unless switched off here. */
function MascotRow() {
  const id = useId();
  const [on, setOn] = useState(true);
  useEffect(() => setOn(readMascotOn()), []);
  return (
    <div className="settings-row">
      <span id={id}>Muse on screen</span>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={on}
        aria-labelledby={id}
        onClick={() => {
          setOn(!on);
          setMascotOn(!on);
        }}
      />
    </div>
  );
}

/** Muse mode: while a build works, its agents show as a crew of Muses (components/mascot/MuseCrew.tsx). Off by default. */
function MuseModeRow() {
  const id = useId();
  const [on, setOn] = useMuseMode();
  return (
    <div className="settings-row">
      <span id={id}>Muse mode</span>
      <button type="button" role="switch" className="switch" aria-checked={on} aria-labelledby={id} onClick={() => setOn(!on)} />
    </div>
  );
}

/**
 * Settings, opened from the account chip: General (who you are here, and the theme) and About (what Muse Muse is).
 * Laid out like meta.ai's Settings through SettingsWindow.
 */
export function SiteSettings({ user, signInHref, ref }: { user: AccountUser | null; signInHref: string; ref?: Ref<SettingsWindowHandle> }) {
  const name = user ? (user.openAccess && !user.isAdmin ? "Guest" : user.email) : null;
  const role = user ? `${user.isAdmin ? "Admin" : "Builder"}${user.openAccess ? ", sign-in off" : ""}` : null;
  return (
    <SettingsWindow
      ref={ref}
      title="Settings"
      closeLabel="Close settings"
      sections={[
        {
          id: "general",
          label: "General",
          icon: "sliders",
          body: (
            <>
              <p className="settings-group">Your account</p>
              {name ? (
                <div className="settings-card settings-card-static">
                  <span className="avatar" aria-hidden>
                    {initials(name)}
                  </span>
                  <span className="settings-card-text">
                    <span className="settings-card-title">{name}</span>
                    <span className="settings-card-sub">{role}</span>
                  </span>
                </div>
              ) : (
                <Link className="settings-card" href={signInHref}>
                  <Icon name="user" size={24} className="settings-card-icon" />
                  <span className="settings-card-text">
                    <span className="settings-card-title">Sign in</span>
                    <span className="settings-card-sub">Browsing is open to everyone. Sign in to build.</span>
                  </span>
                  <Icon name="chevronRight" size={18} className="settings-card-end" />
                </Link>
              )}
              <div className="settings-list">
                <ThemeRow />
                <MascotRow />
                <MuseModeRow />
              </div>
            </>
          ),
        },
        {
          id: "about",
          label: "About Muse Muse",
          icon: "info",
          body: (
            <>
              <p className="settings-group">{DISCLAIMER}</p>
              <ul className="settings-cards">
                <li>
                  <Link className="settings-card" href="/how-it-works">
                    <Icon name="book" size={24} className="settings-card-icon" />
                    <span className="settings-card-text">
                      <span className="settings-card-title">How it works</span>
                      <span className="settings-card-sub">From an idea to a live product you own.</span>
                    </span>
                    <Icon name="chevronRight" size={18} className="settings-card-end" />
                  </Link>
                </li>
              </ul>
            </>
          ),
        },
      ]}
    />
  );
}
