"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { Menu } from "@/components/Menu";
import { CameraCapture, useCameraSupported } from "@/components/camera/CameraCapture";
import { AttachmentChip, type Attachment } from "@/components/composer/AttachmentChip";
import { VoiceInputButton } from "@/components/voice/VoiceInputButton";
import {
  INSPO_ACCEPT,
  MAX_INSPO_BYTES,
  MAX_INSPO_FILES,
  prepareInspoFile,
  referenceKind,
  unsupportedMessage,
} from "@/lib/client/prepare";
import { uploadInspo } from "@/lib/client/upload";
import type { Reference } from "@/lib/types";

export interface Example {
  label: string;
  note: string;
  /** Playground cards only: the pill on the photo, a one-line description and the photo, attached as inspo. */
  tag?: string;
  text?: string;
  image?: string;
}

interface Props {
  /** "new" starts a build with POST /api/inspirations. "refine" posts a change to POST /api/builds/<id>/messages. */
  mode: "new" | "refine";
  buildId?: string;
  signedIn: boolean;
  examples?: Example[];
  placeholder?: string;
  autoFocus?: boolean;
  /** Pins the composer to the bottom of the column, as in the playground. */
  floating?: boolean;
  /** "playground" shows the examples as photo cards under the composer (the Make page). */
  layout?: "playground";
  /** The heading over plain examples. */
  examplesLabel?: string;
  /** Added after the note when it's sent, for a muse started from a page that has something to say (docs pages). */
  context?: string;
  /** Sent as the note when the box is empty. Only with `context`: it lets the reader send without typing. */
  blankNote?: string;
  /** Keeps this composer's draft apart from the Make page's. */
  draftId?: string;
  /** Where to come back to after signing in. */
  returnTo?: string;
}

/** Audio originals above this are refused before decoding, so a huge file can't exhaust the tab's memory. */
const MAX_AUDIO_SOURCE_BYTES = 300 * 1024 * 1024;

const nextId = (() => {
  let n = 0;
  return () => `a${Date.now().toString(36)}${(n++).toString(36)}`;
})();

function draftKey(mode: string, buildId?: string) {
  return `mm:draft:${mode}:${buildId ?? "new"}`;
}

function readDraft(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** Fills a composer's note before it opens, by the draftId it's given: the docs assistant uses it to suggest a build. */
export function writeComposerDraft(draftId: string, note: string) {
  writeDraft(draftKey("new", draftId), note);
}

function writeDraft(key: string, value: string) {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    // Storage can be blocked. The draft is a convenience only.
  }
}

/**
 * The muse box, in the Muse app's look (docs/UI_MUSE_APP.md, "The composer"). "+" attaches inspo, from files or the
 * camera where there is one (drag-drop and paste work too), each file shows as a chip with a thumbnail and a remove
 * button, audio is converted to 16 kHz mono WAV and big photos are resized before upload, and send starts the build.
 * Uploads begin as soon as a file is attached when the viewer is signed in.
 */
export function Composer({
  mode,
  buildId,
  signedIn,
  examples,
  placeholder,
  autoFocus,
  floating,
  layout,
  examplesLabel = "Try a muse",
  context,
  blankNote,
  draftId,
  returnTo,
}: Props) {
  const router = useRouter();
  const inputId = useId();
  const hintId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const aborts = useRef(new Map<string, AbortController>());
  const thumbs = useRef(new Set<string>());
  const dragDepth = useRef(0);
  // Set synchronously, so a second Enter or click before the next render can't start a second build.
  const inFlight = useRef(false);

  const [note, setNote] = useState("");
  const [items, setItems] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [loadingExample, setLoadingExample] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const canUseCamera = useCameraSupported();
  // Photos an example card attached: the reader's own photo takes their place.
  const examplePhotos = useRef(new Set<string>());

  const key = draftKey(mode, draftId ?? buildId);
  const isRefine = mode === "refine";
  const nextPath = returnTo ?? (isRefine && buildId ? `/b/${buildId}?refine=1` : "/");

  // Restore a draft note, such as one kept across sign-in.
  useEffect(() => {
    const saved = readDraft(key);
    if (saved) setNote(saved);
  }, [key]);

  useEffect(() => {
    writeDraft(key, note);
  }, [key, note]);

  useEffect(() => {
    if (autoFocus) textarea.current?.focus();
  }, [autoFocus]);

  // Grow the note field with its content, up to a cap.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [note]);

  // Release object URLs and stop uploads when the composer goes away.
  useEffect(() => {
    const urls = thumbs.current;
    const running = aborts.current;
    return () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
      running.forEach((a) => a.abort());
    };
  }, []);

  const update = useCallback((id: string, patch: Partial<Attachment>) => {
    setItems((list) => list.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const process = useCallback(
    async (id: string, file: File) => {
      update(id, { state: "preparing", error: null, progress: 0 });
      const ac = new AbortController();
      aborts.current.set(id, ac);
      try {
        const prepared = await prepareInspoFile(file);
        if (ac.signal.aborted) return;
        update(id, { state: "uploading", name: prepared.fileName, size: prepared.blob.size });
        const reference = await uploadInspo(prepared, {
          signal: ac.signal,
          onProgress: (progress) => update(id, { progress }),
        });
        update(id, { state: "done", progress: 100, reference });
      } catch (err) {
        if (ac.signal.aborted) return;
        update(id, { state: "error", error: err instanceof Error ? err.message : "Upload failed." });
      } finally {
        aborts.current.delete(id);
      }
    },
    [update],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      const problems: string[] = [];
      const accepted: Attachment[] = [];
      let room = MAX_INSPO_FILES - items.length;
      for (const file of files) {
        const kind = referenceKind(file);
        if (!kind) {
          problems.push(unsupportedMessage(file.name || "That file"));
          continue;
        }
        if (kind !== "audio" && kind !== "image" && file.size > MAX_INSPO_BYTES) {
          problems.push(`${file.name} is over 100 MB. Try a shorter clip or a smaller file.`);
          continue;
        }
        if (kind === "audio" && file.size > MAX_AUDIO_SOURCE_BYTES) {
          problems.push(`${file.name} is too long to convert in the browser.`);
          continue;
        }
        if (room <= 0) {
          problems.push(`You can add up to ${MAX_INSPO_FILES} files.`);
          break;
        }
        room--;
        let thumb: string | null = null;
        if (kind === "image" || kind === "video") {
          thumb = URL.createObjectURL(file);
          thumbs.current.add(thumb);
        }
        accepted.push({
          id: nextId(),
          file,
          kind,
          name: file.name || (kind === "image" ? "pasted-image.png" : "file"),
          size: file.size,
          thumb,
          state: signedIn ? "preparing" : "waiting",
          progress: 0,
          reference: null,
          error: null,
        });
      }
      setError(problems.length ? [...new Set(problems)].join(" ") : null);
      if (!accepted.length) return;
      setItems((list) => [...list, ...accepted]);
      if (signedIn) accepted.forEach((a) => void process(a.id, a.file));
    },
    [items.length, process, signedIn],
  );

  const remove = useCallback((id: string) => {
    aborts.current.get(id)?.abort();
    aborts.current.delete(id);
    setItems((list) => {
      const gone = list.find((it) => it.id === id);
      if (gone?.thumb) {
        URL.revokeObjectURL(gone.thumb);
        thumbs.current.delete(gone.thumb);
      }
      return list.filter((it) => it.id !== id);
    });
  }, []);

  // Drop files anywhere on the page. Without this the browser would navigate away to the dropped file.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      addFiles(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [addFiles]);

  const pending = items.some((it) => it.state === "preparing" || it.state === "uploading");
  const failed = items.some((it) => it.state === "error");
  const references = useMemo(() => items.map((it) => it.reference).filter((r): r is Reference => Boolean(r)), [items]);
  const hasContent = isRefine ? note.trim().length > 0 : note.trim().length > 0 || items.length > 0 || Boolean(blankNote);
  const canSend = hasContent && !submitting && !pending && !failed;

  const statusText = useMemo(() => {
    if (!items.length) return "";
    const ready = items.filter((it) => it.state === "done").length;
    const busy = items.filter((it) => it.state === "preparing" || it.state === "uploading").length;
    const bad = items.filter((it) => it.state === "error").length;
    return [ready && `${ready} ready`, busy && `${busy} uploading`, bad && `${bad} failed`].filter(Boolean).join(", ");
  }, [items]);

  /** Fills the note and attaches the example's photo, the way Meta's example cards load theirs. */
  async function applyExample(ex: Example) {
    setNote(ex.note);
    textarea.current?.focus();
    if (!ex.image) return;
    const fileName = ex.image.split("/").pop() ?? "example.jpg";
    if (items.some((it) => it.name === fileName)) return;
    examplePhotos.current.add(fileName);
    setLoadingExample(ex.label);
    try {
      const res = await fetch(ex.image);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      addFiles([new File([blob], fileName, { type: blob.type || "image/jpeg" })]);
    } catch {
      setError("Couldn't load that example's photo. The note is filled in, so you can still send it.");
    } finally {
      setLoadingExample(null);
    }
  }

  /** Same note as the example, with a photo the reader takes instead of ours. */
  function useCameraForExample(ex: Example) {
    setNote(ex.note);
    setCameraOpen(true);
  }

  function addCameraPhoto(file: File) {
    setCameraOpen(false);
    items.filter((it) => examplePhotos.current.has(it.name)).forEach((it) => remove(it.id));
    examplePhotos.current.clear();
    addFiles([file]);
    textarea.current?.focus();
  }

  function goSignIn() {
    writeDraft(key, note);
    router.push(`/sign-in?next=${encodeURIComponent(nextPath)}`);
  }

  async function submit() {
    if (!signedIn) {
      goSignIn();
      return;
    }
    if (inFlight.current) return;
    if (!hasContent) {
      setError(isRefine ? "Say what to change first." : "Add a note or some inspo first.");
      return;
    }
    if (pending) {
      setError("Wait for the uploads to finish.");
      return;
    }
    if (failed) {
      setError("Remove or retry the files that didn't upload.");
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const url = isRefine ? `/api/builds/${buildId}/messages` : "/api/inspirations";
    const body = isRefine
      ? { message: note.trim(), ...(references.length ? { references } : {}) }
      : { note: [note.trim() || blankNote, context].filter(Boolean).join("\n\n") || null, references };
    let res: Response;
    let data: { buildId?: string; error?: string } = {};
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      data = await res.json().catch(() => ({}));
    } catch {
      inFlight.current = false;
      setSubmitting(false);
      setError("Couldn't reach Muse Muse. Check your connection and try again.");
      return;
    }
    if ((res.status === 201 || res.status === 200) && data.buildId) {
      // Stays in flight until the build room replaces this page.
      writeDraft(key, "");
      router.push(`/b/${data.buildId}`);
      return;
    }
    inFlight.current = false;
    setSubmitting(false);
    if (res.status === 401) {
      goSignIn();
      return;
    }
    setError(errorMessage(res.status, data.error, isRefine));
  }

  const playground = layout === "playground";
  const attachOff = submitting || items.length >= MAX_INSPO_FILES;

  return (
    <div className={`composer-wrap${floating ? " composer-floating" : ""}`}>
      <form
        className={`composer${dragging ? " is-dragging" : ""}`}
        aria-label={isRefine ? "Ask for a change" : "Your muse"}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {items.length ? (
          <ul className="attach-list" aria-label="Attached inspo">
            {items.map((it) => (
              <AttachmentChip
                key={it.id}
                item={it}
                onRemove={() => remove(it.id)}
                onRetry={() => void process(it.id, it.file)}
              />
            ))}
          </ul>
        ) : null}
        <label htmlFor={inputId} className="sr-only">
          {isRefine ? "What should change?" : "Describe it, or drop in your inspo"}
        </label>
        <textarea
          id={inputId}
          ref={textarea}
          className="composer-input"
          data-voice="inline"
          rows={isRefine || playground ? 1 : 2}
          maxLength={context ? 4000 - context.length - 2 : 4000}
          value={note}
          placeholder={
            placeholder ??
            (isRefine ? "Ask for a change, like add a dark mode" : "Describe it, or drop in your inspo...")
          }
          aria-describedby={hintId}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            if (window.matchMedia?.("(pointer: coarse)").matches) return;
            e.preventDefault();
            void submit();
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (!files.length) return;
            if (!e.clipboardData.getData("text/plain")) e.preventDefault();
            addFiles(files);
          }}
        />
        <div className="composer-row">
          {canUseCamera ? (
            <Menu
              label="Attach inspo files"
              icon="plus"
              iconSize={20}
              align="start"
              buttonClassName="composer-tool"
              disabled={attachOff}
              closeOnSelect
            >
              <ul className="menu-list">
                <li>
                  <button type="button" className="menu-item" onClick={() => fileInput.current?.click()}>
                    <Icon name="image" size={18} />
                    <span className="menu-item-text">
                      <span>Photos and files</span>
                      <span className="muted small">Photos, video, a voice memo or a PDF</span>
                    </span>
                  </button>
                </li>
                <li>
                  <button type="button" className="menu-item" onClick={() => setCameraOpen(true)}>
                    <Icon name="camera" size={18} />
                    Take a photo
                  </button>
                </li>
              </ul>
            </Menu>
          ) : (
            <button
              type="button"
              className="composer-tool"
              aria-label="Attach inspo files"
              title="Attach photos, video, a voice memo or a PDF"
              onClick={() => fileInput.current?.click()}
              disabled={attachOff}
            >
              <Icon name="plus" size={20} />
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={INSPO_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <p id={hintId} className={playground && signedIn ? "sr-only" : "composer-hint"}>
            {signedIn
              ? isRefine
                ? "Muse Code picks up where it left off. Add inspo if it helps."
                : "Photos, screenshots, sketches, a short video, a voice memo or a PDF."
              : "Sign in to build. Your note is kept, files need adding again."}
          </p>
          <div className="composer-actions">
            {/* The Muse app's "Thinking" pill goes here once builds have a model or effort switch to put in it. */}
            <VoiceInputButton target={() => textarea.current} className="composer-voice" disabled={submitting} size={22} />
            <button
              type="submit"
              className="send-btn"
              aria-label={submitting ? "Starting" : isRefine ? "Send change" : "Make it"}
              disabled={!canSend && signedIn}
              aria-disabled={!canSend}
            >
              {submitting ? <span className="spinner" aria-hidden /> : <Icon name="arrowUp" size={24} />}
            </button>
          </div>
        </div>
        {dragging ? (
          <div className="drop-hint" aria-hidden>
            Drop to attach
          </div>
        ) : null}
      </form>
      <p className="sr-only" aria-live="polite">
        {statusText}
      </p>
      {error ? (
        <p className="form-error" role="alert">
          <Icon name="alert" size={18} />
          <span>{error}</span>
        </p>
      ) : null}
      {playground && examples?.length ? (
        <ul className="ex-grid" aria-label="Examples">
          {examples.map((ex) => (
            <li key={ex.label}>
              <button
                type="button"
                className="ex-card"
                title={ex.text}
                onClick={() => void applyExample(ex)}
                disabled={submitting || loadingExample !== null}
                aria-busy={loadingExample === ex.label}
              >
                {ex.image ? (
                  <span className="ex-media">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={ex.image} alt="" loading="lazy" />
                    {ex.tag ? <span className="ex-tag">{ex.tag}</span> : null}
                  </span>
                ) : null}
                <span className="ex-body">
                  <span className="ex-title">{ex.label}</span>
                  {/* The title gives screen readers the description once; this line shows it on phones, which have no tooltips. */}
                  {ex.text ? (
                    <span className="ex-text" aria-hidden="true">
                      {ex.text}
                    </span>
                  ) : null}
                </span>
              </button>
              {ex.image && canUseCamera ? (
                <button type="button" className="ex-camera" onClick={() => useCameraForExample(ex)} disabled={submitting} title={`${ex.label}, with a photo you take`}>
                  <Icon name="camera" size={15} />
                  <span>Use my camera</span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {examples?.length && !playground ? (
        <div className="examples">
          <span className="examples-label">{examplesLabel}</span>
          <ul>
            {examples.map((ex) => (
              <li key={ex.label}>
                <button
                  type="button"
                  className="example"
                  onClick={() => {
                    setNote(ex.note);
                    textarea.current?.focus();
                  }}
                >
                  {ex.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <CameraCapture open={cameraOpen} onClose={() => setCameraOpen(false)} onCapture={addCameraPhoto} />
    </div>
  );
}

/** Routes send readable sentences for 400 and 403, and stable codes for the rest (see the route contracts). */
function errorMessage(status: number, code: string | undefined, isRefine: boolean): string {
  const sentence = code && /\s/.test(code) ? code : null;
  if (code === "shared_limit")
    return "The shared guest account has used today's builds. Sign in to build under your own account.";
  if (status === 429 || code === "daily_limit") return "You've used your builds for the last 24 hours. Try again a little later.";
  if (status === 503 || code === "paused")
    return "Building is paused right now. Everything that already shipped still works.";
  if (code === "not_shipped") return "This product hasn't shipped yet, so it can't be changed.";
  if (status === 409 || code === "busy") return "A change is already building. Wait for it to finish, then try again.";
  if (status === 403)
    return (
      sentence ??
      (isRefine ? "Only the person who made this product can change it." : "You can't start builds with this account.")
    );
  if (status === 400) return sentence ?? "That didn't go through. Check the note and files.";
  if (status === 404) return "That build no longer exists.";
  if (status === 501) return "Building isn't switched on in this deployment yet.";
  if (code === "start_failed") return "The build couldn't start. Try again in a moment.";
  return "Something went wrong on our side. Try again in a moment.";
}
