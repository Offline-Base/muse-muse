/**
 * The intro when someone first opens Muse Muse (components/mascot/Intro.tsx): which one, and whether this browser has
 * seen it. Two candidates from the owner's videos, Nov 2, until one is picked. Both play full screen and end on a white
 * stage with Muse walking off right, so the walking Muse comes back in from that side:
 *  - "curtain": a blue curtain; Muse waves, opens it and walks off (9.4 s);
 *  - "shades": a cream curtain; Muse waves, puts on sunglasses, throws it open and strolls off (6 s).
 * `?intro=curtain` or `?intro=shades` on any page shows that one again, for trying them.
 */

export type IntroKind = "curtain" | "shades";

export const INTRO_KINDS: IntroKind[] = ["curtain", "shades"];
export const INTRO_DEFAULT: IntroKind = "curtain";
export const INTRO_SEEN_KEY = "musemuse-intro-seen";
/** Each clip's files under public/muse/ and when it starts to wash out to white (its own ending is a white stage). */
export const INTRO_CLIPS: Record<IntroKind, { name: string; fadeAt: number }> = {
  curtain: { name: "intro-curtain", fadeAt: 8.5 },
  shades: { name: "intro-shades", fadeAt: 5.3 },
};

/** Fired on window when an intro closes, with `detail.kind`, so the walking Muse can take over. */
export const INTRO_DONE_EVENT = "musemuse-intro-done";

export function isIntroKind(v: unknown): v is IntroKind {
  return v === "curtain" || v === "shades";
}

/**
 * Which intro to show now, or null. A `?intro=` value always wins (it's how both are tried); otherwise the default, on
 * the home page only, once per browser, and never with reduced motion.
 */
export function pickIntro(opts: { param: string | null; path: string; seen: boolean; reducedMotion: boolean }): IntroKind | null {
  if (isIntroKind(opts.param)) return opts.param;
  if (opts.param === "off") return null;
  if (opts.path !== "/" || opts.seen || opts.reducedMotion) return null;
  return INTRO_DEFAULT;
}

export function readIntroSeen(): boolean {
  try {
    return localStorage.getItem(INTRO_SEEN_KEY) === "1";
  } catch {
    return true; // blocked storage: don't replay it on every page
  }
}

export function markIntroSeen(): void {
  try {
    localStorage.setItem(INTRO_SEEN_KEY, "1");
  } catch {
    // nothing to keep
  }
}
