"use client";

import { useState } from "react";
import { REPLAY_SCENES, REPLAY_SOURCE } from "@/lib/private/replay";

function seconds(value: number): string {
  return value < 0.1 ? "under 0.1 s" : `${value} s`;
}

/** Steps through what was recorded. Nothing here runs: the label says so, and every value comes from the report. */
export function Replay() {
  const [sceneIndex, setSceneIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const scene = REPLAY_SCENES[sceneIndex]!;
  const step = scene.steps[stepIndex]!;
  const last = stepIndex === scene.steps.length - 1;

  return (
    <section className="pv-replay" aria-label="Recorded replay">
      <p className="pv-replay-tag">Recorded, not live. {REPLAY_SOURCE}</p>
      <div className="pv-scenes">
        {REPLAY_SCENES.map((s, i) => (
          <button
            key={s.id}
            type="button"
            className="pv-scene"
            aria-pressed={i === sceneIndex}
            onClick={() => {
              setSceneIndex(i);
              setStepIndex(0);
            }}
          >
            {s.title}
          </button>
        ))}
      </div>
      <p className="muted">{scene.point}</p>
      <ol className="pv-steps">
        {scene.steps.map((s, i) => (
          <li key={s.label} className="pv-step" data-state={i === stepIndex ? "now" : i < stepIndex ? "done" : "next"}>
            <button type="button" aria-current={i === stepIndex ? "step" : undefined} onClick={() => setStepIndex(i)}>
              {s.label}
            </button>
          </li>
        ))}
      </ol>
      <dl className="pv-result" aria-live="polite">
        <div>
          <dt>Tool Muse called</dt>
          <dd>
            <code>{step.tool}</code>
          </dd>
        </div>
        <div>
          <dt>What came back</dt>
          <dd>
            <span className="pv-status" data-status={step.status.split(" ")[0]}>
              {step.status}
            </span>
          </dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd>{seconds(step.seconds)}</dd>
        </div>
        <div>
          <dt>Private values in the output</dt>
          <dd>None</dd>
        </div>
        {step.kept ? (
          <div className="pv-result-wide">
            <dt>What Muse was told</dt>
            <dd>{step.kept}</dd>
          </div>
        ) : null}
      </dl>
      <div className="pv-controls">
        <button type="button" className="btn" disabled={stepIndex === 0} onClick={() => setStepIndex(stepIndex - 1)}>
          Back
        </button>
        <button type="button" className="btn btn-primary" disabled={last} onClick={() => setStepIndex(stepIndex + 1)}>
          Next step
        </button>
        <span className="muted">
          Step {stepIndex + 1} of {scene.steps.length}
        </span>
      </div>
    </section>
  );
}
