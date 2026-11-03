/**
 * The intro when someone first opens Muse Muse (components/mascot/Intro.tsx): which one, and whether this browser has
 * seen it. Two candidates from the owner's videos, Nov 2, until one is picked. Both play full screen and end on a white
 * stage with Muse walking off right, so the walking Muse comes back in from that side:
 *  - "curtain": a blue curtain; Muse waves, opens it and walks off (9.4 s);
 *  - "shades": a cream curtain; Muse waves, puts on sunglasses, throws it open and strolls off (6 s);
 *  - "shirt": the same in an Offline Base T-shirt in front of a pale grey curtain (6 s). The owner's pick, Nov 2.
 * "shades" and "shirt" have their white stage cut out (scripts/dev/mascot/key_stage.py), so the curtain opens onto
 * the real page. `?intro=curtain`, `?intro=shades` or `?intro=shirt` on any page shows that one again.
 */

export type IntroKind = "curtain" | "shades" | "shirt";

export const INTRO_KINDS: IntroKind[] = ["curtain", "shades", "shirt"];
export const INTRO_DEFAULT: IntroKind = "shirt";
export const INTRO_SEEN_KEY = "musemuse-intro-seen";
/**
 * Each clip's files under public/muse/ and when it starts to leave. An opaque clip ends on a white stage, so it washes
 * out to white and then fades; a see-through clip (`seeThrough`, VP9 with alpha plus HEVC with alpha for Safari) already
 * shows the page around Muse, so it just fades.
 */
export const INTRO_CLIPS: Record<IntroKind, { name: string; fadeAt: number; seeThrough?: boolean }> = {
  curtain: { name: "intro-curtain", fadeAt: 8.5 },
  shades: { name: "intro-shades", fadeAt: 5.4, seeThrough: true },
  shirt: { name: "intro-shirt", fadeAt: 5.4, seeThrough: true },
};

/** Fired on window when an intro closes, with `detail.kind`, so the walking Muse can take over. */
export const INTRO_DONE_EVENT = "musemuse-intro-done";

export function isIntroKind(v: unknown): v is IntroKind {
  return v === "curtain" || v === "shades" || v === "shirt";
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
