"use client";

import { useMemo, useState } from "react";
import { ApiConsole } from "@/components/docs/playgrounds/common/ApiConsole";
import { FileIdBar } from "@/components/docs/playgrounds/media/FileIdBar";
import styles from "@/components/docs/playgrounds/media/demos.module.css";
import { SimplePills } from "@/components/docs/playgrounds/media/SimplePills";
import { EXAMPLE_ID } from "@/lib/docs/client/endpoints";
import type { FileSlot, FormSpec } from "@/lib/docs/client/form";
import { jsonSet } from "@/lib/docs/client/pointer";

export interface ConsolePreset {
  label: string;
  /** One line under the pills: what this request shows and what it costs. */
  note?: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  form?: FormSpec[];
  fileSlots?: FileSlot[];
  stream?: boolean;
  /**
   * Where one of the reader's own file ids goes: "path" swaps the example id in the path (files/file_abc123), a JSON
   * Pointer sets it in the body (/images/0/file_id). The console then offers their files and a quick upload.
   */
  fileId?: string;
  /** The sample the quick upload offers first. */
  uploadSampleId?: string;
  uploadAccept?: string;
}

export interface PresetConsoleProps {
  slug?: string;
  presets: ConsolePreset[];
  /** The pills' label. */
  label?: string;
}

/** The preset's request with the reader's file id put where it goes. */
export function withFileId(preset: ConsolePreset, fileId: string): { path: string; body: unknown } {
  if (!preset.fileId || !fileId) return { path: preset.path, body: preset.body };
  if (preset.fileId === "path") return { path: preset.path.replace(EXAMPLE_ID, fileId), body: preset.body };
  try {
    return { path: preset.path, body: jsonSet(preset.body, preset.fileId, fileId) };
  } catch {
    return { path: preset.path, body: preset.body };
  }
}

/**
 * The kit's API console with a page's worked requests as pills: each pill loads one request (an endpoint, its body
 * or multipart form, file slots) into the console, ready to send. A request that needs one of the reader's file ids
 * gets them offered above the console, with a quick upload when there are none yet.
 */
export function PresetConsole({ presets, label = "Try" }: PresetConsoleProps) {
  const [at, setAt] = useState(0);
  const [fileId, setFileId] = useState("");
  const preset = presets[at] ?? presets[0];
  const request = useMemo(() => (preset ? withFileId(preset, fileId) : null), [preset, fileId]);
  if (!preset || !request) return null;

  return (
    <div className={`pg ${styles.lab}`}>
      {presets.length > 1 ? <SimplePills label={label} presets={presets} active={at} onPick={setAt} /> : null}
      {preset.note ? <p className={`${styles.note} pg-advanced`}>{preset.note}</p> : null}
      {preset.fileId ? (
        <FileIdBar
          value={fileId}
          onChange={setFileId}
          sampleId={preset.uploadSampleId}
          accept={preset.uploadAccept}
          // With the id in the path, the console itself offers the reader's files while the example id is there.
          showFiles={preset.fileId !== "path"}
        />
      ) : null}
      <ApiConsole
        // A new preset or file id starts a fresh console: its body editor holds its own text.
        key={`${at}:${preset.fileId ? fileId : ""}`}
        method={preset.method}
        path={request.path}
        body={request.body}
        form={preset.form}
        fileSlots={preset.fileSlots}
        stream={preset.stream}
        hideIdHint={!!preset.fileId}
      />
    </div>
  );
}
