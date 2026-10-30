"use client";

import { useState } from "react";
import { Icon } from "@/components/icons";
import { fetchSample, sampleKindOf, sizeLabel, uploadProblem } from "@/lib/docs/client/files";
import { samplesOf } from "@/lib/docs/media/samples";

/**
 * A file for a request: choose one from disk or take one of the docs' samples for the slot's accept type
 * (lib/docs/media/samples.ts). It hands back the File; the caller reads it as a data URL, base64 or multipart part
 * when it sends. Files over 3 MB are turned away with a reason, since the proxy takes bodies up to 4.5 MB.
 */

export interface PickedFile {
  file: File;
  /** "sample" when it came from public/docs-samples, which is what the code and the record say. */
  source: "upload" | "sample";
  sampleId?: string;
}

export function FileSlotInput({
  id,
  label,
  accept,
  value,
  onChange,
  disabled,
  hint,
}: {
  id: string;
  label: string;
  accept?: string;
  value: PickedFile | null;
  onChange(file: PickedFile | null): void;
  disabled?: boolean;
  hint?: string;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const kind = sampleKindOf(accept);
  const samples = kind ? samplesOf(kind) : [];

  const take = (file: File, source: PickedFile["source"], sampleId?: string) => {
    const why = uploadProblem(file);
    setProblem(why);
    if (!why) onChange({ file, source, ...(sampleId ? { sampleId } : {}) });
  };

  return (
    <div className="pg-field pg-fileslot">
      <span className="pg-label" id={`${id}-label`}>
        {label}
      </span>
      {value ? (
        <div className="pg-file-chip">
          <Icon name="file" size={16} />
          <span className="pg-file-name">{value.file.name}</span>
          <span className="pg-muted">
            {sizeLabel(value.file.size)}
            {value.source === "sample" ? ", sample" : ""}
          </span>
          <button type="button" className="icon-btn icon-btn-plain icon-btn-sm" aria-label={`Remove ${value.file.name}`} onClick={() => onChange(null)} disabled={disabled}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ) : null}
      <div className="pg-fileslot-row">
        <label className="btn btn-sm btn-outline pg-file-button" aria-disabled={disabled || undefined}>
          <Icon name="plus" size={16} />
          <span>{value ? "Choose another file" : "Choose a file"}</span>
          <input
            id={id}
            type="file"
            className="sr-only"
            accept={accept}
            disabled={disabled}
            aria-labelledby={`${id}-label`}
            aria-describedby={hint ? `${id}-hint` : undefined}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) take(file, "upload");
              e.target.value = "";
            }}
          />
        </label>
        {samples.length ? (
          <span className="pg-samples" role="group" aria-label={`Samples for ${label}`}>
            <span className="pg-muted">or a sample:</span>
            {samples.map((s) => (
              <button
                key={s.id}
                type="button"
                className="pg-pill"
                aria-pressed={value?.sampleId === s.id}
                disabled={disabled || loading !== null}
                title={s.description}
                onClick={async () => {
                  setLoading(s.id);
                  try {
                    take(await fetchSample(s), "sample", s.id);
                  } catch (err) {
                    setProblem(err instanceof Error ? err.message : "Couldn't load that sample.");
                  } finally {
                    setLoading(null);
                  }
                }}
              >
                {loading === s.id ? "Loading..." : s.label}
              </button>
            ))}
          </span>
        ) : null}
      </div>
      {hint ? (
        <p className="pg-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {problem ? (
        <p className="pg-hint pg-bad" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
