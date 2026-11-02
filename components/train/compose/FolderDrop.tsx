"use client";

import { useId, useRef, useState, type DragEvent } from "react";
import { Icon } from "@/components/icons";
import { SKIP_WORDS, type FolderDraft, type FolderReview, type FolderUpload } from "@/lib/train/tune/folder";
import type { DroppedFile } from "@/lib/train/tune/folder-read";

/** What POST /api/train/folder answered, ready for the plan and Start. */
export interface ReadyFolder {
  draft: FolderDraft;
  hash: string;
  review: FolderReview;
}

function fromFile(file: File, path: string): DroppedFile {
  return { path, size: file.size, bytes: async () => new Uint8Array(await file.arrayBuffer()) };
}

/** Every file under a dropped entry. A directory reader answers in batches, so it's read until it comes back empty. */
async function walk(entry: FileSystemEntry, out: DroppedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push(fromFile(file, entry.fullPath));
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return;
    for (const e of batch) await walk(e, out);
  }
}

/**
 * The folder drop on /fine-tuning/new (TUNE_FOLDER): a plain notice and its checkbox first, then a folder or a zip, by
 * picker or by dragging. The browser reads only allowed files as text and sends that; the raw files never leave it. The
 * server's scan comes back as a short review: the files used, the files skipped and why, and sample rows. Then the note
 * above goes on to the normal plan and Start.
 */
export function FolderDrop({ ready, onReady, canLeaveOut = false }: { ready: ReadyFolder | null; onReady: (next: ReadyFolder | null) => void; /** MAKE_CHAT_ALL: each used file can be left out, and the folder is checked again without it. */ canLeaveOut?: boolean }) {
  const noticeId = useId();
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const [agreed, setAgreed] = useState(false);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const lastUpload = useRef<FolderUpload | null>(null);

  async function check(upload: FolderUpload) {
    setBusy("Checking them");
    const res = await fetch("/api/train/folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true, files: upload.files, skipped: upload.skipped }),
    });
    const data = (await res.json().catch(() => null)) as (ReadyFolder & { error?: string; message?: string }) | null;
    if (res.ok && data?.draft) {
      lastUpload.current = upload;
      onReady({ draft: data.draft, hash: data.hash, review: data.review });
    } else if (res.status === 413) setProblem("That's too much text to send at once. Try a smaller folder.");
    else if (res.status === 429) setProblem("That's a lot of folders from this network this hour. Try again later.");
    else setProblem(data?.message ?? (data?.error && /\s/.test(data.error) ? data.error : "Those files couldn't be checked. Try again."));
  }

  async function take(files: DroppedFile[]) {
    if (!files.length) return;
    setProblem(null);
    onReady(null);
    setBusy("Reading your files");
    try {
      const { readDropped } = await import("@/lib/train/tune/folder-read");
      await check(await readDropped(files, (done, total) => setBusy(`Reading your files, ${done} of ${total}`)));
    } catch {
      setProblem("Those files couldn't be read. Try again.");
    }
    setBusy(null);
  }

  /** Checks the same files again without this one: what's left is what the plan is signed for. */
  async function leaveOut(path: string) {
    const upload = lastUpload.current;
    if (!upload) return;
    setProblem(null);
    onReady(null);
    try {
      await check({ ...upload, files: upload.files.filter((f) => f.path !== path) });
    } catch {
      setProblem("Those files couldn't be checked. Try again.");
    }
    setBusy(null);
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    if (!agreed) {
      setProblem("Read the notice and check the box first.");
      return;
    }
    const out: DroppedFile[] = [];
    const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry()).filter((x): x is FileSystemEntry => Boolean(x));
    try {
      for (const entry of entries) await walk(entry, out);
    } catch {
      setProblem("That folder couldn't be read. Try the picker instead.");
      return;
    }
    await take(out);
  }

  const onPick = (list: FileList | null) => {
    const files = [...(list ?? [])];
    void take(files.map((f) => fromFile(f, f.webkitRelativePath || f.name)));
  };

  const review = ready?.review;
  return (
    <section className="tune-folder" aria-label="Train from a folder">
      <div className="tune-folder-zone" data-over={over} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => void onDrop(e)}>
        <strong>Or train from a folder</strong>
        <p id={noticeId} className="muted small">
          Your files go to Meta on a tier where Meta may train on them. Personal or sensitive information isn&apos;t allowed, so use only files you&apos;re fine sharing that way. Muse Muse skips key and hidden files and takes out what looks like a secret or personal data, but that scan can miss things.
        </p>
        <label className="train-help">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} aria-describedby={noticeId} /> I understand, and these files hold no personal or sensitive information
        </label>
        <div className="row-actions">
          <button type="button" className="btn btn-outline" disabled={!agreed || Boolean(busy)} onClick={() => folderInput.current?.click()}>
            <Icon name="file" size={18} />
            Pick a folder
          </button>
          <button type="button" className="btn btn-outline" disabled={!agreed || Boolean(busy)} onClick={() => zipInput.current?.click()}>
            Pick a zip
          </button>
        </div>
        <p className="muted small">Or drag one here. Text, code, documents, PDF, CSV and JSON or JSONL.</p>
        {/* webkitdirectory isn't in React's types: the ref sets it. */}
        <input
          ref={(el) => {
            folderInput.current = el;
            el?.setAttribute("webkitdirectory", "");
          }}
          type="file"
          multiple
          hidden
          aria-label="Folder"
          onChange={(e) => {
            onPick(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={zipInput}
          type="file"
          accept=".zip,application/zip"
          hidden
          aria-label="Zip"
          onChange={(e) => {
            onPick(e.target.files);
            e.target.value = "";
          }}
        />
        {busy ? <p aria-live="polite">{busy}</p> : null}
        {problem ? (
          <p className="form-error" role="alert">
            <Icon name="alert" size={18} />
            <span>{problem}</span>
          </p>
        ) : null}
      </div>

      {ready && review ? (
        <div className="tune-folder-zone">
          <strong>{ready.draft.mode === "rows" ? `${ready.draft.rows.length} rows, ready to train as they are` : "Spark 1.3 Contributor will write examples from these"}</strong>
          <p className="muted small">Now say above what the model should do, and plan it.</p>
          <details open>
            <summary>{review.used.length} {review.used.length === 1 ? "file" : "files"} used</summary>
            <ul className="tune-folder-list">
              {review.used.map((f) => (
                <li key={f.path}>
                  {f.path}
                  {f.rows ? ` (${f.rows} rows)` : ""}
                  {f.removedLines ? ` (${f.removedLines} lines taken out)` : ""}
                  {canLeaveOut && review.used.length > 1 ? (
                    <>
                      {" "}
                      <button type="button" className="link-btn" onClick={() => void leaveOut(f.path)} disabled={Boolean(busy)}>
                        Leave out
                      </button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
          {review.skipped.length ? (
            <details>
              <summary>{review.skipped.length} skipped</summary>
              <ul className="tune-folder-list">
                {review.skipped.map((f) => (
                  <li key={f.path}>
                    {f.path}: {SKIP_WORDS[f.reason]}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {review.droppedRows || review.removedLines ? (
            <p className="small">
              Taken out for what looked like a secret or personal data: {review.droppedRows} rows and {review.removedLines} lines.
            </p>
          ) : null}
          {review.cutRows ? <p className="small">{review.cutRows} rows were left out as repeats or over the limit.</p> : null}
          {review.samples.length ? (
            <details open>
              <summary>Sample rows</summary>
              <ul className="tune-folder-list">
                {review.samples.map((r) => (
                  <li key={r.prompt}>
                    <strong>{r.prompt.slice(0, 200)}</strong> {r.answer.slice(0, 200)}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <button type="button" className="link-btn" onClick={() => onReady(null)}>
            Remove this folder
          </button>
        </div>
      ) : null}
    </section>
  );
}
