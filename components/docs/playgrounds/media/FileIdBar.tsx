"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { ErrorBox, RunButton } from "@/components/docs/kit";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { FilePicker } from "@/components/docs/media/FilePicker";
import styles from "@/components/docs/playgrounds/media/demos.module.css";
import type { DocsError } from "@/lib/docs/client/api";
import { recentIds, subscribeRecent, type RecentId } from "@/lib/docs/client/recent";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import { fileUploadFields } from "@/lib/docs/media/requests";

const NONE: RecentId[] = [];

/**
 * The files this visitor uploaded during the visit (lib/docs/client/recent.ts), fresh as other demos on the page add
 * more. The snapshot is cached by its ids, so React sees the same array until something changes.
 */
export function useRecentFiles(): RecentId[] {
  const cache = useRef<{ key: string; list: RecentId[] }>({ key: "", list: NONE });
  return useSyncExternalStore(
    subscribeRecent,
    () => {
      const list = recentIds("file");
      const key = list.map((r) => r.id).join(",");
      if (key !== cache.current.key) cache.current = { key, list };
      return cache.current.list;
    },
    () => NONE,
  );
}

/**
 * Uploads a picked file with POST /v1/files (purpose user_data, the fields before the file) through a demo's runner.
 * Not recorded for the copy prompt: the request the demo makes with the id is the one worth repeating. The error is
 * the HTTP error, or a note when a 200 came back without an id.
 */
export async function uploadPicked(
  run: ReturnType<typeof useDocsRun>["run"],
  picked: PickedMedia,
  expiresAfterSeconds?: number | null,
): Promise<{ id: string | null; json: unknown; error: DocsError | null }> {
  const form = new FormData();
  for (const [k, v] of fileUploadFields({ expiresAfterSeconds })) form.append(k, v);
  form.append("file", picked.blob, picked.name);
  const res = await run("files", { form, record: false });
  const id = (res.json as { id?: unknown } | null)?.id;
  if (res.ok && typeof id === "string") return { id, json: res.json, error: null };
  return { id: null, json: res.json, error: res.error ?? (res.ok ? { message: "The upload didn't return a file id." } : null) };
}

/**
 * Where a demo gets a file id of the reader's own: the files they uploaded here (the docs proxy only lets a visitor
 * use their own), or a quick upload of a sample or their file with POST /v1/files.
 */
export function FileIdBar({
  value,
  onChange,
  sampleId = "field-report",
  accept = "image/png,image/jpeg,image/webp,image/gif,video/mp4,audio/wav,audio/mpeg,application/pdf,text/plain",
  label = "file_id",
  showFiles = true,
}: {
  value: string;
  onChange(id: string): void;
  sampleId?: string;
  accept?: string;
  label?: string;
  /** List the reader's files as pills. Off where the console below already offers them (an id in its path). */
  showFiles?: boolean;
}) {
  const files = useRecentFiles();
  const uploader = useDocsRun();
  const [picked, setPicked] = useState<PickedMedia | null>(null);
  const [open, setOpen] = useState(false);
  const running = uploader.state === "running";

  const upload = async () => {
    if (!picked || running) return;
    const { id } = await uploadPicked(uploader.run, picked);
    if (id) {
      onChange(id);
      setOpen(false);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardTitle}>
          {label}: {value ? <code>{value}</code> : <span className={styles.note}>none yet</span>}
        </span>
        <button type="button" className="btn btn-outline btn-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)} disabled={running}>
          {open ? "Close" : files.length ? "Upload another" : "Upload a file"}
        </button>
      </div>
      {files.length && showFiles ? (
        <div className="pg-presets" role="group" aria-label="Your files">
          <span className="pg-presets-label">Your files</span>
          {files.slice(0, 6).map((f) => (
            <button key={f.id} type="button" className="pg-pill" aria-pressed={f.id === value} onClick={() => onChange(f.id)} disabled={running}>
              {f.label ? `${f.id} (${f.label})` : f.id}
            </button>
          ))}
        </div>
      ) : !files.length ? (
        <p className={`${styles.note} pg-advanced`}>The live demos use only files uploaded from this browser in the last hour. Upload one to get its id.</p>
      ) : null}
      {open || (!files.length && !value) ? (
        <div className={styles.stack}>
          <FilePicker accept={accept} value={picked} onChange={setPicked} defaultSampleId={sampleId} preview="compact" prepare="none" disabled={running} />
          <div className={styles.row}>
            <RunButton running={running} onRun={() => void upload()} onStop={uploader.abort} label="Upload" disabled={!picked || picked.problems.length > 0} />
            <span className={`${styles.note} pg-advanced`}>POST /v1/files with purpose user_data. Demo uploads expire after an hour.</span>
          </div>
          <ErrorBox error={uploader.error} />
        </div>
      ) : null}
    </div>
  );
}
