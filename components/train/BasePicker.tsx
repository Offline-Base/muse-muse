"use client";

import { useId, useState } from "react";
import { R30B_NAME } from "@/components/train/results";
import { errorCode } from "@/components/train/format";
import { baseDutiesText, CURATED_BASES, type ResolvedBase } from "@/lib/train/bases";

/** What the picker holds: the default (no base sent), a base that passed, or a choice that didn't, which stops Start. */
export type BaseChoice = { state: "default" } | { state: "checking" } | { state: "ok"; base: ResolvedBase } | { state: "refused" };

const DEFAULT = "";
const PASTE = "paste";

/**
 * The base a job trains on (TUNE_ANY_BASE, admins only): the updated Muse Glimmer by default, a curated Meta model, or a
 * pasted repo id, each checked on the server (POST /api/train/bases) before it can start. Only the default sends nothing.
 */
export function BasePicker({ value, onChange, disabled = false }: { value: BaseChoice; onChange: (next: BaseChoice) => void; disabled?: boolean }) {
  const id = useId();
  const [pick, setPick] = useState(DEFAULT);
  const [pasted, setPasted] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function check(repo: string, revision: string | null) {
    setProblem(null);
    onChange({ state: "checking" });
    try {
      const res = await fetch("/api/train/bases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ base: { repo, ...(revision ? { revision } : {}) } }),
      });
      const data = (await res.json().catch(() => null)) as { base?: ResolvedBase } | null;
      if (res.ok && data?.base) {
        onChange({ state: "ok", base: data.base });
        return;
      }
      setProblem(errorCode(data) || "That base couldn't be checked. Try again in a moment.");
    } catch {
      setProblem("Couldn't reach Muse Muse. Check your connection and try again.");
    }
    onChange({ state: "refused" });
  }

  function choose(next: string) {
    setPick(next);
    setProblem(null);
    if (next === DEFAULT) return onChange({ state: "default" });
    if (next === PASTE) return onChange({ state: "refused" });
    const curated = CURATED_BASES.find((b) => b.repo === next);
    if (curated) void check(curated.repo, curated.revision);
  }

  const note = CURATED_BASES.find((b) => b.repo === pick)?.note;
  const base = value.state === "ok" ? value.base : null;
  return (
    <div className="field">
      <label htmlFor={`${id}-base`}>Base model</label>
      <select id={`${id}-base`} className="train-select" value={pick} onChange={(e) => choose(e.target.value)} disabled={disabled}>
        <option value={DEFAULT}>{R30B_NAME} (the default)</option>
        {CURATED_BASES.map((b) => (
          <option key={b.repo} value={b.repo}>
            {b.label}
          </option>
        ))}
        <option value={PASTE}>Paste a Hugging Face repo id</option>
      </select>
      {pick === PASTE ? (
        <div className="row-actions">
          <input
            aria-label="Hugging Face repo id"
            className="train-input"
            type="text"
            value={pasted}
            maxLength={193}
            placeholder="unsloth/Llama-3.2-3B-Instruct-bnb-4bit"
            autoComplete="off"
            onChange={(e) => setPasted(e.target.value.trim())}
            disabled={disabled}
          />
          <button type="button" className="btn btn-outline" onClick={() => void check(pasted, null)} disabled={disabled || !pasted || value.state === "checking"}>
            Check it
          </button>
        </div>
      ) : null}
      {note && !base && !problem ? <span className="field-hint">{note}</span> : null}
      {value.state === "checking" ? <span className="field-hint">Checking it on Hugging Face.</span> : null}
      {problem ? (
        <p className="form-error" role="alert">
          {problem}
        </p>
      ) : null}
      {base ? (
        <span className="field-hint">
          {base.repo} at {base.revision.slice(0, 12)}, about {base.memoryGb} GB of GPU memory{base.gated ? ", gated, and HF_TOKEN opens it" : ""}. Decide mode: {base.decide ? "yes" : "no, chat only"}. {base.localFiles}{" "}
          {baseDutiesText(base)}
        </span>
      ) : null}
    </div>
  );
}
