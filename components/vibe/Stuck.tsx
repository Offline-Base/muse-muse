"use client";

import { useId, useMemo, useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { Icon } from "@/components/icons";
import type { AppId } from "@/lib/vibe/device";
import {
  PASTE_MAX,
  diagnostics,
  findSymptoms,
  fixFor,
  symptomsAt,
  type DiagnosticsOs,
  type StepId,
  type Symptom,
} from "@/lib/vibe/troubleshoot";

export interface StuckProps {
  step: StepId;
  app: AppId | null;
  os: DiagnosticsOs;
  /** The build being set up, for the diagnostics' first line. */
  level: string | null;
  /** An NVIDIA card adds nvidia-smi to the diagnostics. */
  nvidia: boolean;
  /** Where to write for help (DRIVE_CONTACT_EMAIL), or null when the site names nobody. */
  help?: string | null;
}

/** "send them to <the address>" when the site names one, else to whoever is helping. */
function SendTo({ help }: { help: string | null }) {
  return help ? (
    <>
      email them to <a href={`mailto:${help}`}>{help}</a>
    </>
  ) : (
    <>send them to whoever is helping you</>
  );
}

function SymptomText({ symptom, app }: { symptom: Symptom; app: AppId | null }) {
  return (
    <>
      <p>
        <strong>Likely cause.</strong> {symptom.cause}
      </p>
      <p>
        <strong>Fix.</strong> {fixFor(symptom, app)}
      </p>
    </>
  );
}

/**
 * "Stuck?" under a checklist step (docs/VIBE_TUNING.md, Feature 5): the troubleshooting tree opened at that step, a box
 * that matches pasted text against it in the browser (nothing is sent), and "Copy diagnostics" with the read-only
 * commands it copies shown in full, so nobody runs a command they haven't seen.
 */
export function Stuck({ step, app, os, level, nvidia, help = null }: StuckProps) {
  const id = useId();
  const [pasted, setPasted] = useState("");
  const found = useMemo(() => findSymptoms(pasted), [pasted]);
  const diag = diagnostics({ os, app, level, step, nvidia });
  const shell = os === "windows" ? "PowerShell" : "Terminal";

  return (
    <details className="vibe-stuck">
      <summary>
        <Icon name="info" size={16} />
        Stuck?
      </summary>
      <div className="vibe-stuck-body">
        <ul className="vibe-symptoms" aria-label="What you might see">
          {symptomsAt(step, os).map((s) => (
            <li key={s.id}>
              <details className="vibe-symptom">
                <summary>{s.title}</summary>
                <SymptomText symptom={s} app={app} />
              </details>
            </li>
          ))}
        </ul>

        <div className="train-field">
          <label className="train-label" htmlFor={`${id}-paste`}>
            Paste what it said
          </label>
          <textarea
            id={`${id}-paste`}
            className="train-input train-textarea vibe-paste-box"
            rows={3}
            maxLength={PASTE_MAX}
            value={pasted}
            placeholder="An error message, the end of a log, or an odd answer"
            onChange={(e) => setPasted(e.target.value)}
            aria-describedby={`${id}-paste-help`}
          />
          <p className="train-help" id={`${id}-paste-help`}>
            Matched against the list above, in this browser. Nothing you paste is sent anywhere.
          </p>
        </div>
        {pasted.trim() ? (
          <div className="vibe-found" aria-live="polite">
            {found.length ? (
              found.map((s) => (
                <div key={s.id} className="vibe-found-item">
                  <h4>{s.title}</h4>
                  <SymptomText symptom={s} app={app} />
                </div>
              ))
            ) : (
              <p className="muted small">
                Nothing on the list matches that. Copy the diagnostics below and <SendTo help={help} />.
              </p>
            )}
          </div>
        ) : null}

        <div className="vibe-diag">
          <div className="vibe-paste-head">
            <h4>Diagnostics</h4>
            <CopyButton value={diag.commands} label="Copy diagnostics" text="Copy diagnostics" className="btn btn-sm btn-outline" />
          </div>
          <p className="train-help">
            Read-only commands for {shell}: they print your system, memory, free disk and graphics, and change nothing. Run
            them, then paste what they print above, or <SendTo help={help} /> with what you see.
            {diag.tested ? "" : " These haven't been tried on a real PC yet."}
          </p>
          <pre className="vibe-pre">{diag.commands}</pre>
        </div>
      </div>
    </details>
  );
}
