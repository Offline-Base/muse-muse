"use client";

import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { Segmented } from "@/components/Segmented";
import { glassesMessage, statusLabel, type GlassesSource, type UseGlasses } from "@/lib/glasses/client";

const SOURCES: ReadonlyArray<{ value: GlassesSource; label: string }> = [
  { value: "glasses", label: "Glasses" },
  { value: "phone", label: "Phone" },
  { value: "sample", label: "Sample" },
];

const SAW: Record<GlassesSource, string> = {
  glasses: "What your glasses saw",
  phone: "What your phone saw",
  sample: "The sample view",
};

function chip(state: UseGlasses["status"]["state"]): { tone: string; icon: IconName } {
  if (state === "ready") return { tone: "chip positive", icon: "check" };
  if (state === "error" || state === "no-glasses" || state === "needs-meta-ai") return { tone: "chip negative", icon: "alert" };
  return { tone: "chip", icon: "info" };
}

/**
 * Where the product sees and hears from: the glasses' status chip, the button that connects them, the switch between
 * glasses, phone and sample, and the last photo taken. Pass it what useGlasses returns. Tests find its buttons by
 * name, and the iPhone app's checks find them by data-glasses-action.
 */
export function GlassesPanel({ glasses, title = "Your glasses" }: { glasses: UseGlasses; title?: string }) {
  const { source, status, inApp, photo, previewing, stream, recording } = glasses;
  const [connecting, setConnecting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (video.current) video.current.srcObject = stream;
  }, [stream]);

  const busy = connecting || status.state === "connecting" || status.state === "registering";
  const { tone, icon } = chip(status.state);
  const shownProblem = problem ?? (source === "glasses" && status.error ? glassesMessage(status.error) : null);

  const connect = async () => {
    setProblem(null);
    setConnecting(true);
    try {
      await glasses.connect();
    } catch (err) {
      setProblem(glassesMessage(err));
    } finally {
      setConnecting(false);
    }
  };

  const togglePreview = async () => {
    setProblem(null);
    try {
      await glasses.preview(!previewing);
    } catch (err) {
      setProblem(glassesMessage(err));
    }
  };

  const choose = (next: GlassesSource) => {
    setProblem(null);
    glasses.setSource(next);
  };

  return (
    <section className="card" aria-label={title} data-glasses-panel>
      <div className="card-head">
        <h2>{title}</h2>
        {source === "glasses" ? (
          <span className={tone} role="status">
            <Icon name={icon} size={16} />
            {statusLabel(status)}
          </span>
        ) : null}
      </div>
      <div className="fields" style={{ marginTop: "var(--space-12)" }}>
        <Segmented label="See and hear with" options={SOURCES} value={source} onChange={choose} disabled={recording} />

        {source === "glasses" && !inApp ? (
          <p className="note" style={{ margin: 0 }}>
            <Icon name="info" />
            Your glasses connect through the Muse Muse app on iPhone. Here, use this device&apos;s camera or the sample.
          </p>
        ) : null}

        {source === "glasses" && inApp && status.state !== "ready" ? (
          <div className="field">
            <div>
              <button type="button" className="tinted" data-glasses-action="connect" disabled={busy} aria-busy={busy} onClick={connect}>
                <Icon name="camera" />
                {busy ? "Connecting…" : "Connect your glasses"}
              </button>
            </div>
            <span className="hint">The first time, the Meta AI app opens to ask for permission. Come back here after.</span>
          </div>
        ) : null}

        {source === "phone" ? <span className="hint">Uses this device&apos;s camera and microphone.</span> : null}

        {(source === "glasses" && status.state === "ready") || source === "phone" ? (
          <div>
            <button type="button" className="text" data-glasses-action="preview" aria-pressed={previewing} onClick={togglePreview}>
              <Icon name="camera" />
              {previewing ? "Hide the live view" : "Show the live view"}
            </button>
          </div>
        ) : null}

        {source === "phone" && stream ? (
          <figure className="media">
            <video ref={video} autoPlay muted playsInline aria-label="Live view from this device's camera" />
          </figure>
        ) : null}

        {photo ? (
          <ul className="list">
            <li className="list-row">
              <img className="thumb" src={photo.dataUrl} alt={SAW[photo.source]} />
              <div className="list-text">
                <span className="list-title">{SAW[photo.source]}</span>
                <span className="meta">Your last photo</span>
              </div>
            </li>
          </ul>
        ) : null}

        {shownProblem ? (
          <div className="error" role="alert">
            <Icon name="alert" /> {shownProblem}
          </div>
        ) : null}
      </div>
    </section>
  );
}
