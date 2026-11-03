"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ranOnLabel, type DeviceRun } from "@/lib/devices/runs";

/**
 * Where a product ran (docs/BRAND.md, "Device stage"): each device it was recorded on, drawn as that device, with the
 * recording playing on its screen and the run's facts under it. The frames are drawings with no makers' logos; what is on
 * each screen is the recording from that device. Clips play only while on screen and never with reduced motion, and
 * one button pauses them all.
 */
export function DeviceStage({ runs, productName }: { runs: readonly DeviceRun[]; productName: string }) {
  const id = useId();
  const root = useRef<HTMLElement>(null);
  const [paused, setPaused] = useState(false);
  const [still, setStill] = useState(true);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMotion = () => setStill(motion.matches);
    onMotion();
    motion.addEventListener("change", onMotion);
    return () => motion.removeEventListener("change", onMotion);
  }, []);

  useEffect(() => {
    const videos = Array.from(root.current?.querySelectorAll("video") ?? []);
    if (still || paused) {
      videos.forEach((v) => v.pause());
      return;
    }
    const seen = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const v = e.target as HTMLVideoElement;
          if (e.isIntersecting) void v.play().catch(() => {});
          else v.pause();
        }
      },
      { threshold: 0.25 },
    );
    videos.forEach((v) => seen.observe(v));
    return () => seen.disconnect();
  }, [still, paused]);

  const computers = runs.filter((r) => r.device === "mac" || r.device === "windows");
  const phones = runs.filter((r) => r.device === "android" || r.device === "iphone");
  const real = runs.filter((r) => !r.simulated).length;

  return (
    <section className="card section-card device-stage" aria-labelledby={`${id}-title`} ref={root}>
      <div className="device-stage-head">
        <div>
          <h2 id={`${id}-title`}>Where it ran</h2>
          <p className="muted">
            {productName}, used on {runs.length} {runs.length === 1 ? "device" : "devices"}
            {real && real < runs.length ? `, ${real} of them real hardware` : ""}. Each screen plays the run recorded on that device.
          </p>
        </div>
        {!still ? (
          <button type="button" className="btn btn-outline btn-sm" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
            {paused ? "Play" : "Pause"}
          </button>
        ) : null}
      </div>
      {computers.length ? <div className="device-stage-row device-stage-computers">{computers.map((r) => <Device key={r.video} run={r} />)}</div> : null}
      {phones.length ? <div className="device-stage-row device-stage-phones">{phones.map((r) => <Device key={r.video} run={r} />)}</div> : null}
      <p className="muted small device-stage-note">The devices are drawings. What is on each screen is the recording made on that device.</p>
    </section>
  );
}

function Device({ run }: { run: DeviceRun }) {
  const screen = (
    <div className="device-screen">
      <video muted loop playsInline preload="metadata" poster={run.poster || undefined}>
        <source src={run.video} type="video/mp4" />
      </video>
    </div>
  );
  const day = ranOnLabel(run.ranOn);
  return (
    <figure className={`device device-${run.device}`}>
      {run.device === "mac" || run.device === "windows" ? (
        <div className="device-laptop" aria-hidden>
          <div className="device-lid">{screen}</div>
          <div className="device-hinge" />
          <div className="device-base" />
        </div>
      ) : (
        <div className="device-phone" aria-hidden>
          <i className="device-btn device-btn-vol" />
          <i className="device-btn device-btn-power" />
          {screen}
        </div>
      )}
      <figcaption>
        <strong>{run.name}</strong>
        <span className="muted small">
          {run.place}
          {run.detail ? `. ${run.detail}` : ""}
          {day ? `. ${day}` : ""}
        </span>
        <span className={`pill ${run.simulated ? "pill-partial" : "pill-live"}`}>{run.simulated ? "Simulated" : run.device === "android" || run.device === "iphone" ? "Real phone" : "Real machine"}</span>
      </figcaption>
    </figure>
  );
}
