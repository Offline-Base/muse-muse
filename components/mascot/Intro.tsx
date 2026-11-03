"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { INTRO_CLIPS, INTRO_DONE_EVENT, markIntroSeen, pickIntro, readIntroSeen, type IntroKind } from "@/lib/intro";

/** How long the clip takes to wash out to white before the page shows through. */
const WHITE_MS = 450;
/** The overlay's fade (globals.css, .intro-curtain) plus room; closes it even if no transitionend comes (reduced motion). */
const LEAVE_MS = 900;
/** The most an intro may take, however the video behaves (a stalled download): the longest clip is 9.4 s. */
const MAX_MS = 15000;

/**
 * The first-open intro (lib/intro.ts has which clip, when, and how to try both). Full screen, muted (browsers block
 * sound on autoplay anyway). It never blocks: "Skip intro" is focused from the start, Escape skips, and a clip that
 * can't play closes it. A see-through clip plays over the real page and fades out at its end; an opaque one washes
 * out to white first (its own last frames are a white stage), so no ghost of the big Muse shows over the page. Then the
 * walking Muse comes in from the right.
 */
export function Intro() {
  const path = usePathname();
  const params = useSearchParams();
  const param = params.get("intro");
  const [kind, setKind] = useState<IntroKind | null>(null);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setKind(pickIntro({ param, path, seen: readIntroSeen(), reducedMotion }));
  }, [param, path]);

  const close = useCallback(() => {
    setKind((k) => {
      if (k) {
        markIntroSeen();
        window.dispatchEvent(new CustomEvent(INTRO_DONE_EVENT, { detail: { kind: k } }));
      }
      return null;
    });
  }, []);

  useEffect(() => {
    if (!kind) return;
    document.documentElement.dataset.intro = kind;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      delete document.documentElement.dataset.intro;
      window.removeEventListener("keydown", onKey);
    };
  }, [kind, close]);

  return kind ? <Clip key={kind} kind={kind} onDone={close} /> : null;
}

const isSafari = () => /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);

function Clip({ kind, onDone }: { kind: IntroKind; onDone: () => void }) {
  const { name, fadeAt, seeThrough } = INTRO_CLIPS[kind];
  // Safari draws only the HEVC file's alpha, Chrome and Firefox only the VP9 one's, so a see-through clip picks by browser.
  const [safari] = useState(() => typeof navigator !== "undefined" && isSafari());
  const skip = useRef<HTMLButtonElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [white, setWhite] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    // Skip takes focus; whatever had it gets it back when the intro closes.
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    skip.current?.focus();
    const v = video.current;
    if (v) void v.play().catch(onDone);
    const cap = setTimeout(onDone, MAX_MS);
    return () => {
      clearTimeout(cap);
      if (before?.isConnected && before !== document.body) before.focus();
    };
  }, [onDone]);

  useEffect(() => {
    if (!white) return;
    const t = setTimeout(() => setLeaving(true), WHITE_MS);
    return () => clearTimeout(t);
  }, [white]);

  // The fade's transitionend usually closes it; this makes sure it closes even when there is no transition to end.
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(onDone, LEAVE_MS);
    return () => clearTimeout(t);
  }, [leaving, onDone]);

  return (
    <div
      className={`intro-curtain${seeThrough ? " is-see-through" : ""}${white ? " is-white" : ""}${leaving ? " is-leaving" : ""}`}
      role="dialog"
      aria-label="Welcome to Muse Muse"
      onTransitionEnd={(e) => {
        // Only the overlay's own fade, not the white wash on its ::after (which reports the same target).
        if (e.target === e.currentTarget && !e.pseudoElement && e.propertyName === "opacity" && leaving) onDone();
      }}
    >
      <video
        ref={video}
        className="intro-curtain-video"
        muted
        playsInline
        preload="auto"
        poster={`/muse/${name}.jpg`}
        aria-hidden
        onTimeUpdate={(e) => {
          if (e.currentTarget.currentTime < fadeAt) return;
          if (seeThrough) setLeaving(true);
          else if (!white) setWhite(true);
        }}
        onEnded={() => (seeThrough ? setLeaving(true) : setWhite(true))}
        onError={onDone}
      >
        {seeThrough ? (
          safari ? (
            <source src={`/muse/${name}-hevc.mov`} type='video/mp4; codecs="hvc1"' />
          ) : (
            <source src={`/muse/${name}.webm`} type="video/webm" />
          )
        ) : (
          <>
            <source src={`/muse/${name}.webm`} type="video/webm" />
            <source src={`/muse/${name}.mp4`} type="video/mp4" />
          </>
        )}
      </video>
      <button ref={skip} type="button" className="btn intro-skip" onClick={onDone}>
        Skip intro
      </button>
    </div>
  );
}
