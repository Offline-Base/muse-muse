"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { INTRO_DONE_EVENT } from "@/lib/intro";
import {
  CLIMB_SPEED_PER_HEIGHT,
  MASCOT_EVENT,
  WALK_FRAME,
  WALK_SPEED_PER_HEIGHT,
  climbStep,
  readMascotOn,
  setMascotOn,
  walkStep,
} from "@/lib/mascot";

/** The drawn height: smaller on phones. */
const heightFor = (vw: number) => (vw < 760 ? 72 : 96);
/** Climbing the side is for the desktop view; on a phone it just turns at the edges. */
const canClimb = (vw: number) => vw >= 760;

type Clip = "walk" | "climb-up" | "climb-down";

/**
 * Safari plays the HEVC files with their alpha; Chrome and Firefox play the VP9 WebMs with theirs. Each one misdraws the
 * other's file (no transparency), so the source is picked here instead of left to <source> order.
 */
function sources(): Record<Clip, { src: string; type: string }> {
  const safari = /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
  const pick = (name: string) =>
    safari ? { src: `/muse/muse-${name}-hevc.mov`, type: 'video/mp4; codecs="hvc1"' } : { src: `/muse/muse-${name}.webm`, type: "video/webm" };
  return { walk: pick("walk"), "climb-up": pick("climb-up"), "climb-down": pick("climb-down") };
}

/**
 * Muse, on screen (docs/BRAND.md, "Muse, the mascot"). It walks along the bottom of the content area (never behind the
 * sidebar), stopping now and then. On the desktop view it sometimes climbs the right edge of the window, hangs there a
 * moment and climbs back down, then walks off the other way. Off in Settings, it's gone; with reduced motion it stands
 * still in the corner. It never takes a click or covers a control: it sits under docks, menus and dialogs, and pointer
 * events pass through. Following the cursor and walkthroughs come with their own assets.
 */
export function Mascot() {
  const [on, setOn] = useState(false);
  const [still, setStill] = useState(false);
  const [src, setSrc] = useState<Record<Clip, { src: string; type: string }> | null>(null);
  // Shown for a few seconds after the close button hides it, so the person knows how to bring it back.
  const [bye, setBye] = useState(false);
  const walker = useRef<HTMLDivElement>(null);
  const figure = useRef<HTMLDivElement>(null);
  const climber = useRef<HTMLDivElement>(null);
  const videos = useRef<Partial<Record<Clip, HTMLVideoElement | null>>>({});
  // While the pointer is on it (or its close button has focus), it stops, so the close button is easy to hit.
  const held = useRef(false);

  useEffect(() => {
    if (!bye) return;
    const t = setTimeout(() => setBye(false), 5000);
    return () => clearTimeout(t);
  }, [bye]);

  // Everything it reads lives in the browser, so it starts after mount and the server renders nothing.
  useEffect(() => {
    setSrc(sources());
    setOn(readMascotOn());
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    setStill(motion.matches);
    const onMotion = () => setStill(motion.matches);
    const onPref = () => setOn(readMascotOn());
    motion.addEventListener("change", onMotion);
    window.addEventListener(MASCOT_EVENT, onPref);
    window.addEventListener("storage", onPref);
    return () => {
      motion.removeEventListener("change", onMotion);
      window.removeEventListener(MASCOT_EVENT, onPref);
      window.removeEventListener("storage", onPref);
    };
  }, []);

  useEffect(() => {
    const walk = walker.current;
    const fig = figure.current;
    const climb = climber.current;
    const v = videos.current;
    if (!on || !walk || !fig || !climb || !v.walk || !v["climb-up"] || !v["climb-down"]) return;

    const sidebar = () => (window.innerWidth >= 760 ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w")) || 256 : 0);
    const height = () => heightFor(window.innerWidth);
    const walkWidth = () => (height() * WALK_FRAME.width) / WALK_FRAME.height;
    const bounds = () => ({ left: sidebar() + 8, right: window.innerWidth - walkWidth() - 8 });

    // Shows one clip, playing or paused, and hides the others.
    const show = (clip: Clip, playing: boolean) => {
      walk.hidden = clip !== "walk";
      climb.hidden = clip === "walk";
      for (const name of ["walk", "climb-up", "climb-down"] as Clip[]) {
        const el = v[name]!;
        el.hidden = name !== clip && name !== "walk";
        if (name === clip && playing) void el.play().catch(() => {});
        else el.pause();
      }
    };
    const placeWalk = (x: number, dir: 1 | -1) => {
      walk.style.transform = `translate3d(${Math.round(x)}px, 0, 0)`;
      fig.style.transform = dir < 0 ? "scaleX(-1)" : "";
    };
    const placeClimb = (y: number) => {
      climb.style.transform = `translate3d(0, ${-Math.round(y)}px, 0)`;
    };

    if (still) {
      show("walk", false);
      placeWalk(bounds().right, -1);
      return;
    }

    let mode: "walk" | "up" | "hang" | "down" = "walk";
    // It starts in the middle of the open space, heading right, so the first climb comes within seconds.
    let x = (bounds().left + bounds().right) / 2;
    let dir: 1 | -1 = 1;
    let y = 0;
    let top = 0;
    let climbs = 0;
    let last = performance.now();
    let restUntil = 0;
    let wasHeld = false;
    let raf = 0;
    const clipFor = (): Clip => (mode === "walk" ? "walk" : mode === "down" ? "climb-down" : "climb-up");
    const rest = (now: number, ms: number) => {
      restUntil = now + ms;
      show(clipFor(), false);
    };

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      raf = requestAnimationFrame(tick);
      if (held.current) {
        if (!wasHeld) show(clipFor(), false);
        wasHeld = true;
        return;
      }
      if (wasHeld) {
        wasHeld = false;
        if (now >= restUntil && mode !== "hang") show(clipFor(), true);
      }
      if (now < restUntil) return;
      const h = height();

      if (mode === "walk") {
        show("walk", true);
        const next = walkStep({ x, dir }, dt, h * WALK_SPEED_PER_HEIGHT, bounds());
        x = next.x;
        dir = next.dir;
        placeWalk(x, dir);
        // The first time it reaches the right edge it always climbs; after that, more often than not.
        if (next.turned && dir === -1 && canClimb(window.innerWidth) && (climbs++ === 0 || Math.random() < 0.6)) {
          // At the right edge: up the side of the window, to somewhere between a quarter and half its height.
          mode = "up";
          y = 0;
          top = window.innerHeight * (0.25 + Math.random() * 0.25);
          placeClimb(0);
          show("climb-up", true);
        } else if (next.turned) rest(now, 1200);
        // About once every 15 seconds, a short stop to look around.
        else if (Math.random() < dt / 15) rest(now, 1500 + Math.random() * 2000);
        return;
      }
      if (mode === "hang") {
        mode = "down";
        show("climb-down", true);
        return;
      }
      const step = climbStep(y, mode === "up" ? 1 : -1, dt, h * CLIMB_SPEED_PER_HEIGHT, top);
      y = step.y;
      placeClimb(y);
      if (step.arrived && mode === "up") {
        mode = "hang";
        rest(now, 1500 + Math.random() * 1500);
      } else if (step.arrived) {
        // Back on the ground: walk off to the left.
        mode = "walk";
        x = bounds().right;
        dir = -1;
        placeWalk(x, dir);
        show("walk", true);
      }
    };

    // When the curtain intro ends, Muse has just walked off its stage to the right: come back in from that side.
    const onIntroDone = (e: Event) => {
      if ((e as CustomEvent<{ kind?: string }>).detail?.kind !== "curtain") return;
      mode = "walk";
      x = bounds().right;
      dir = -1;
      restUntil = 0;
      placeClimb(0);
      placeWalk(x, dir);
      show("walk", true);
    };
    window.addEventListener(INTRO_DONE_EVENT, onIntroDone);

    placeWalk(x, dir);
    placeClimb(0);
    show("walk", true);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener(INTRO_DONE_EVENT, onIntroDone);
    };
  }, [on, still, src]);

  if (!on || !src)
    return bye ? (
      <p className="mascot-note" role="status">
        Muse is hidden. Bring him back in Settings, under Muse on screen.
      </p>
    ) : null;
  const clip = (name: Clip, poster: string) => (
    <video
      ref={(el) => {
        videos.current[name] = el;
      }}
      className={name === "walk" ? "mascot-walk" : "mascot-climb-clip"}
      aria-hidden
      muted
      loop
      playsInline
      preload="auto"
      poster={poster}
    >
      <source src={src[name].src} type={src[name].type} />
    </video>
  );
  // Pointer on it, or its close button focused: it stops where it is.
  const hold = {
    onPointerEnter: () => (held.current = true),
    onPointerLeave: () => (held.current = false),
    onFocus: () => (held.current = true),
    onBlur: () => (held.current = false),
  };
  const close = (
    <button
      type="button"
      className="mascot-close"
      aria-label="Hide Muse"
      title="Hide Muse"
      onClick={() => {
        held.current = false;
        setBye(true);
        setMascotOn(false);
      }}
    >
      <Icon name="close" size={14} aria-hidden />
    </button>
  );
  return (
    <>
      <div className="mascot" ref={walker} {...hold}>
        <div className="mascot-figure" ref={figure}>
          {clip("walk", "/muse/muse-walk.png")}
        </div>
        {close}
      </div>
      <div className="mascot-climb" ref={climber} hidden {...hold}>
        {clip("climb-up", "/muse/muse-climb.png")}
        {clip("climb-down", "/muse/muse-climb.png")}
        {close}
      </div>
    </>
  );
}
