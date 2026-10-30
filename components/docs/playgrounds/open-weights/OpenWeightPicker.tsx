"use client";

import { useId, useMemo, useState } from "react";
import { Toggle } from "@/components/docs/kit/Field";
import { HARDWARE, recommend, type HardwareId, type Needs, type Verdict } from "@/components/docs/playgrounds/open-weights/picker";
import { MODEL_NAME } from "@/components/docs/playgrounds/open-weights/facts";
import { Badge, CodeCard, Status } from "@/components/docs/playgrounds/open-weights/ui";
import styles from "@/components/docs/playgrounds/open-weights/ow.module.css";

/**
 * Which open-weight model to run (open-weight-models): pick the hardware you have and what you need, and see whether
 * Muse Spark Open and Muse Glimmer fit, which checkpoint and runtime their pages give for it, and the first command,
 * or the hosted providers when there's nothing to run it on.
 */

export interface OpenWeightPickerProps {
  slug: string;
  /** The hardware picked on load. */
  hardware?: HardwareId;
}

function VerdictCard({ v, picked }: { v: Verdict; picked: boolean }) {
  const tone = v.level === "fits" ? "ok" : v.level === "limited" ? "warn" : "bad";
  const word = v.level === "fits" ? "Fits" : v.level === "limited" ? "With caveats" : "Doesn't fit";
  return (
    <article className={`${styles.card} ${picked ? styles.cardPicked : ""}`} aria-label={MODEL_NAME[v.model]}>
      <div className={styles.cardHead}>
        <h4 className={styles.cardTitle}>{MODEL_NAME[v.model]}</h4>
        <span className={styles.row} style={{ gap: 6 }}>
          {picked ? <Badge tone="info">Start here</Badge> : null}
          <Badge tone={tone}>{word}</Badge>
        </span>
      </div>
      <p className={styles.cardText}>
        <strong>{v.headline}</strong>
      </p>
      <ul className="pg-list pg-small" style={{ color: "var(--fg-2)" }}>
        {v.why.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
      {v.checkpoint || v.runtime ? (
        <p className="pg-small">
          {v.checkpoint ? (
            <>
              Checkpoint: <code>{v.checkpoint}</code>
              <br />
            </>
          ) : null}
          {v.runtime ? <>Runtime: {v.runtime}</> : null}
        </p>
      ) : null}
      {v.command ? <CodeCard code={v.command} lang="bash" label="First command" /> : null}
      <a className={styles.cardLink} href={v.link.href}>
        {v.link.label}
      </a>
    </article>
  );
}

export function OpenWeightPicker({ hardware = "gpu24" }: OpenWeightPickerProps) {
  const id = useId();
  const [hw, setHw] = useState<HardwareId>(hardware);
  const [needs, setNeeds] = useState<Needs>({ audioVideo: false, images: false, longContext: false, apache: false });
  const rec = useMemo(() => recommend(hw, needs), [hw, needs]);
  const set = (k: keyof Needs) => (on: boolean) => setNeeds((n) => ({ ...n, [k]: on }));
  const tone = rec.pick === "neither" ? "bad" : rec.spark.level === "fits" || rec.glimmer.level === "fits" ? "ok" : "warn";

  return (
    <div className="pg">
      <fieldset className={styles.stack} style={{ margin: 0, padding: 0, border: 0 }}>
        <legend className="pg-label" style={{ marginBottom: 8 }}>
          What will you run it on?
        </legend>
        <div className={styles.cards} style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 190px), 1fr))", gap: 8 }}>
          {HARDWARE.map((h) => (
            <label key={h.id} className={`${styles.card} ${hw === h.id ? styles.cardPicked : ""}`} style={{ gap: 2, padding: "9px 12px", cursor: "pointer" }}>
              <span className={styles.row} style={{ gap: 8, flexWrap: "nowrap" }}>
                <input type="radio" name={`${id}-hw`} value={h.id} checked={hw === h.id} onChange={() => setHw(h.id)} />
                <span style={{ fontWeight: 600, fontSize: 14 }}>{h.label}</span>
              </span>
              <span className="pg-small pg-muted" style={{ paddingLeft: 24 }}>
                {h.detail}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className={styles.row} style={{ margin: 0, padding: 0, border: 0 }}>
        <legend className="pg-label" style={{ marginBottom: 8 }}>
          What do you need?
        </legend>
        <Toggle id={`${id}-av`} label="Audio or video input" checked={needs.audioVideo} onChange={set("audioVideo")} />
        <Toggle id={`${id}-img`} label="Image input" checked={needs.images} onChange={set("images")} />
        <Toggle id={`${id}-ctx`} label="Context past 128K tokens" checked={needs.longContext} onChange={set("longContext")} />
        <Toggle id={`${id}-apache`} label="An Apache 2.0 license" checked={needs.apache} onChange={set("apache")} />
      </fieldset>
      <Status tone={tone}>
        {rec.pick === "neither" ? rec.reason : `Start with ${MODEL_NAME[rec.pick]}. ${rec.reason}`}
      </Status>
      <div className={styles.grid2}>
        <VerdictCard v={rec.spark} picked={rec.pick === "spark"} />
        <VerdictCard v={rec.glimmer} picked={rec.pick === "glimmer"} />
      </div>
      <p className="pg-hint">
        Self-hosted, prompts and responses stay on your own infrastructure and no API key is involved. The hosted Model API models are on the Models page.
      </p>
    </div>
  );
}
