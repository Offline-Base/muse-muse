"use client";

import { uploadPresigned } from "@vercel/blob/client";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { safeFileName } from "@/lib/client/upload";

/** Same as lib/native/clips.ts, which a client component can't import. A test keeps them in step. */
export const CLIP_ACCEPT = "video/mp4,video/quicktime,video/webm";
export const CLIP_MAX_BYTES = 500 * 1024 * 1024;
const MULTIPART_BYTES = 8 * 1024 * 1024;

/** What the route's error means to the person uploading. */
export function clipFailureMessage(status: number, error: string | undefined): string {
  if (status === 429) return "That's too many uploads for this hour. Try again later.";
  if (status === 503) return "File uploads aren't set up on this site yet.";
  if (status === 401 || status === 403) return "Only this product's owner can add a clip.";
  if (status === 400 || status === 409) return error || "That clip didn't go through. Try again.";
  return "That clip didn't go through. Try again.";
}

async function answer(res: Response): Promise<void> {
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(clipFailureMessage(res.status, body.error));
}

/** Blob's client reports every route failure the same way, so this keeps its message only when it means something. */
async function sendToBlob(file: File, slug: string, productId: string, onProgress: (percent: number) => void): Promise<string> {
  const pathname = `clips/${productId}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
  try {
    const blob = await uploadPresigned(pathname, file, {
      access: "public",
      handleUploadUrl: `/api/products/${slug}/clips`,
      contentType: file.type,
      multipart: file.size >= MULTIPART_BYTES,
      onUploadProgress: (e) => onProgress(Math.round(e.percentage)),
    });
    return blob.url;
  } catch {
    throw new Error("That clip didn't upload. Check your connection and try again.");
  }
}

/** Adds a clip filmed on a real device to the product's page, with a caption saying what it was filmed on. */
export function AddClip({ slug, productId }: { slug: string; productId: string }) {
  const router = useRouter();
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [caption, setCaption] = useState("");
  const [state, setState] = useState<{ busy: boolean; percent: number | null; error: string | null }>({ busy: false, percent: null, error: null });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return setState({ busy: false, percent: null, error: "Choose a video first." });
    if (!CLIP_ACCEPT.split(",").includes(file.type)) return setState({ busy: false, percent: null, error: "Use an MP4, MOV or WebM video." });
    if (file.size > CLIP_MAX_BYTES) return setState({ busy: false, percent: null, error: "That clip is over the 500 MB limit." });
    setState({ busy: true, percent: null, error: null });
    try {
      const route = `/api/products/${slug}/clips`;
      if (process.env.NEXT_PUBLIC_LOCAL_FILES === "1") {
        const form = new FormData();
        form.append("file", file);
        form.append("caption", caption);
        await answer(await fetch(route, { method: "POST", body: form }));
      } else {
        const url = await sendToBlob(file, slug, productId, (percent) => setState({ busy: true, percent, error: null }));
        await answer(await fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, caption }) }));
      }
      setCaption("");
      if (fileRef.current) fileRef.current.value = "";
      setState({ busy: false, percent: null, error: null });
      router.refresh();
    } catch (err) {
      setState({ busy: false, percent: null, error: err instanceof Error ? err.message : "That clip didn't go through. Try again." });
    }
  }

  return (
    <form className="getit-addclip" onSubmit={(e) => void submit(e)}>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-file`}>
          Add a clip you filmed
        </label>
        <input ref={fileRef} id={`${id}-file`} type="file" accept={CLIP_ACCEPT} disabled={state.busy} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-caption`}>
          What it was filmed on
        </label>
        <input
          id={`${id}-caption`}
          type="text"
          required
          maxLength={300}
          placeholder="Filmed on a Meta Quest 3"
          value={caption}
          disabled={state.busy}
          onChange={(e) => setCaption(e.target.value)}
        />
      </div>
      <p>
        <button type="submit" className="btn btn-outline btn-sm" disabled={state.busy}>
          {state.busy ? (state.percent === null ? "Adding it" : `Uploading, ${state.percent}%`) : "Add the clip"}
        </button>
      </p>
      {state.error ? (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/** Takes a clip off the product's page, after a second press. */
export function RemoveClip({ slug, url }: { slug: string; url: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "sure" | "busy" | "failed">("idle");

  async function press() {
    if (state === "idle" || state === "failed") return setState("sure");
    setState("busy");
    try {
      const res = await fetch(`/api/products/${slug}/clips`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
      if (!res.ok && res.status !== 404) throw new Error(String(res.status));
      router.refresh();
    } catch {
      setState("failed");
    }
  }

  return (
    <button type="button" className="getit-removeclip" disabled={state === "busy"} onClick={() => void press()}>
      {state === "sure" ? "Press again to remove it" : state === "failed" ? "That didn't work. Try again" : "Remove"}
    </button>
  );
}
