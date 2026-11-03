"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { START_MUSING } from "@/components/shell/nav";
import { INTRO_DONE_EVENT, markIntroSeen, pickIntro, readIntroSeen, type IntroKind } from "@/lib/intro";

/** When the curtain clip starts to wash out to white (it ends on a white stage), then the page shows through. */
const CURTAIN_FADE_AT = 8.5;
const CURTAIN_WHITE_MS = 450;

const isSafari = () => /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);

/**
 * The first-open intro (lib/intro.ts has which, when and how to try both). It never blocks: Skip and Escape close it at
 * once, and a clip that can't play closes it too. Muted, since browsers block sound on autoplay anyway.
 */
export function Intro() {
  const path = usePathname();
  const params = useSearchParams();
  const param = params.get("intro");
  const [kind, setKind] = useState<IntroKind | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setKind(pickIntro({ param, path, seen: readIntroSeen(), reducedMotion }));
    setLeaving(false);
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

  const leave = useCallback(() => setLeaving(true), []);

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

  if (kind === "curtain") return <Curtain leaving={leaving} onLeave={leave} onDone={close} />;
  if (kind === "hello") return <Hello onDone={close} />;
  return null;
}

function Curtain({ leaving, onLeave, onDone }: { leaving: boolean; onLeave: () => void; onDone: () => void }) {
  const skip = useRef<HTMLButtonElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [white, setWhite] = useState(false);

  // Two steps, so no ghost of the big Muse shows over the page: the clip washes out to white, then the white fades.
  useEffect(() => {
    if (!white) return;
    const t = setTimeout(onLeave, CURTAIN_WHITE_MS);
    return () => clearTimeout(t);
  }, [white, onLeave]);

  useEffect(() => {
    skip.current?.focus();
    const v = video.current;
    if (v) void v.play().catch(onDone);
  }, [onDone]);

  return (
    <div className={`intro-curtain${white ? " is-white" : ""}${leaving ? " is-leaving" : ""}`} role="dialog" aria-label="Welcome to Muse Muse" onTransitionEnd={(e) => e.target === e.currentTarget && leaving && onDone()}>
      <video
        ref={video}
        className="intro-curtain-video"
        muted
        playsInline
        preload="auto"
        poster="/muse/intro-curtain.jpg"
        aria-hidden
        onTimeUpdate={(e) => {
          if (!white && e.currentTarget.currentTime >= CURTAIN_FADE_AT) setWhite(true);
        }}
        onEnded={() => setWhite(true)}
        onError={onDone}
      >
        <source src="/muse/intro-curtain.webm" type="video/webm" />
        <source src="/muse/intro-curtain.mp4" type="video/mp4" />
      </video>
      <button ref={skip} type="button" className="btn intro-skip" onClick={onDone}>
        Skip intro
      </button>
    </div>
  );
}

function Hello({ onDone }: { onDone: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [src, setSrc] = useState<{ src: string; type: string } | null>(null);

  useEffect(() => {
    setSrc(isSafari() ? { src: "/muse/muse-hello-hevc.mov", type: 'video/mp4; codecs="hvc1"' } : { src: "/muse/muse-hello.webm", type: "video/webm" });
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  return (
    <dialog ref={dialog} className="intro-hello" aria-labelledby="intro-hello-title" onCancel={(e) => (e.preventDefault(), onDone())}>
      <div className="intro-hello-figure">
        {src && (
          <video className="intro-hello-video" autoPlay muted loop playsInline poster="/muse/muse-hello.png" aria-hidden>
            <source src={src.src} type={src.type} />
          </video>
        )}
      </div>
      <h2 id="intro-hello-title">{"Hi, I’m Muse."}</h2>
      <p>Tell me what you want to make, and I’ll build it: a live product you own, made with Meta’s models.</p>
      <div className="intro-hello-actions">
        <Link href={START_MUSING.href} className="btn btn-primary" autoFocus onClick={onDone}>
          {START_MUSING.label}
        </Link>
        <button type="button" className="btn" onClick={onDone}>
          Look around first
        </button>
      </div>
    </dialog>
  );
}
