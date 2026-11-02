/**
 * The site's theme: System (follow the device), Light or Dark, kept in this browser. app/globals.css already has both
 * sets of colors: [data-theme="light"] and [data-theme="dark"] on <html> force one, and no attribute follows the device.
 * THEME_SCRIPT runs in <head> before the page paints, so a saved choice never flashes the other theme first.
 */

export type ThemeChoice = "system" | "light" | "dark";

export const THEME_KEY = "musemuse-theme";

export const THEME_CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

/** The saved choice, or System when there's none or storage is blocked. */
export function readTheme(): ThemeChoice {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return isThemeChoice(saved) ? saved : "system";
  } catch {
    return "system";
  }
}

/** Shows a choice now and keeps it for next time. System clears the attribute and the saved value. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Private windows and blocked storage: the choice still applies to this page.
  }
}

/** Inline in <head> (app/layout.tsx): applies a saved Light or Dark before first paint. */
export const THEME_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
