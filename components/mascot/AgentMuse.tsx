"use client";

import { useCallback, useEffect, useState } from "react";
import { AGENT_FRAME, MUSE_MODE_EVENT, MUSE_MODE_KEY, readMuseMode, setMuseMode, type AgentRole } from "@/lib/mascot";

const isSafari = () => /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);

/**
 * One agent as a little Muse (lib/mascot.ts, AgentRole): the orchestrator, or a sub-agent waving one way. A transparent
 * loop while it works; its first frame, still, when it's done, before the page has loaded, or under reduced motion.
 * Safari only draws the HEVC file's alpha, Chrome and Firefox only the VP9 one's, so the file is picked in the browser.
 * Decorative: the row or caption beside it says what the agent is doing.
 */
export function AgentMuse({ role, height, playing = true, className }: { role: AgentRole; height: number; playing?: boolean; className?: string }) {
  const width = Math.round((height * AGENT_FRAME.width) / AGENT_FRAME.height);
  const poster = `/muse/agent-${role}.png`;
  const [video, setVideo] = useState<{ src: string; type: string } | null>(null);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return setVideo(null);
    setVideo(isSafari() ? { src: `/muse/agent-${role}-hevc.mov`, type: 'video/mp4; codecs="hvc1"' } : { src: `/muse/agent-${role}.webm`, type: "video/webm" });
  }, [role]);
  const cls = `agent-muse${className ? ` ${className}` : ""}`;
  if (!playing || !video) {
    // eslint-disable-next-line @next/next/no-img-element -- a small transparent still, nothing to optimize
    return <img className={cls} src={poster} alt="" aria-hidden width={width} height={height} decoding="async" />;
  }
  return (
    <video key={video.src} className={cls} width={width} height={height} poster={poster} muted loop autoPlay playsInline preload="auto" aria-hidden>
      <source src={video.src} type={video.type} />
    </video>
  );
}

/** Muse mode, on or off, kept in step with Settings, the build room's switch and other tabs. Off on the server. */
export function useMuseMode(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(readMuseMode());
    const sync = () => setOn(readMuseMode());
    const onStorage = (e: StorageEvent) => {
      if (e.key === MUSE_MODE_KEY || e.key === null) sync();
    };
    const onEvent = (e: Event) => setOn(Boolean((e as CustomEvent<{ on: boolean }>).detail?.on));
    window.addEventListener(MUSE_MODE_EVENT, onEvent);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(MUSE_MODE_EVENT, onEvent);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  const set = useCallback((next: boolean) => {
    setOn(next);
    setMuseMode(next);
  }, []);
  return [on, set];
}
