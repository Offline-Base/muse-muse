/**
 * What the lab's routes share (docs/NATIVE_LAB.md, "HTTP contract"). With NATIVE_LAB off every one of them is a plain 404
 * before it reads anything, so a box that's up early sees what it would see if the routes didn't exist.
 */
import { env } from "@/lib/env";
import { isSafeFileKey, localFileKey, localFilesEnabled } from "@/lib/local-files";
import type { NativeArtifactKind } from "@/lib/native/types";

/** A 404 when the lab is off, and null when it's on. Every route starts with this. */
export function labGate(): Response | null {
  return env.nativeLab ? null : notFound();
}

export function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

/** The answer for a job token whose run doesn't own the job, or a job that isn't there. */
export function gone(): Response {
  return Response.json({ error: "gone" }, { status: 410 });
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/** Job ids are UUIDs. Anything else can't be a job, and shouldn't reach a uuid column. */
export function isJobId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** The JSON body, or null when it's too big or isn't JSON. Reads the text first, so its size is what counts. */
export async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return null;
  const text = await req.text().catch(() => null);
  if (text === null || Buffer.byteLength(text) > maxBytes) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface UploadRule {
  kind: NativeArtifactKind;
  contentType: string;
  maxBytes: number;
}

const MB = 1024 * 1024;
const SHOT: UploadRule = { kind: "shot", contentType: "image/jpeg", maxBytes: 2 * MB };
const LOG: UploadRule = { kind: "log", contentType: "text/plain", maxBytes: MB };

/** The only files a job may leave, as docs/NATIVE_LAB.md lists them. */
export const UPLOAD_RULES: Readonly<Record<string, UploadRule>> = {
  "shot-1.jpg": SHOT,
  "shot-2.jpg": SHOT,
  "shot-3.jpg": SHOT,
  "shot-4.jpg": SHOT,
  "clip.mp4": { kind: "clip", contentType: "video/mp4", maxBytes: 16 * MB },
  "poster.jpg": { kind: "poster", contentType: "image/jpeg", maxBytes: 2 * MB },
  "report.json": { kind: "report", contentType: "application/json", maxBytes: MB },
  "log.txt": LOG,
  "logcat.txt": LOG,
};

export function uploadRule(name: string): UploadRule | null {
  return Object.hasOwn(UPLOAD_RULES, name) ? UPLOAD_RULES[name] : null;
}

/** Where a job's files go. Built from the job row, never from a request. */
export function jobFolder(job: { runId: string; id: string }): string {
  return `native/runs/${job.runId}/${job.id}/`;
}

/** The public host of this platform's Blob store, from either credential. The id's shape is as @vercel/blob reads it. */
function blobStoreHost(): string | null {
  const id = env.blobStoreId || env.blobReadWriteToken?.split("_")[3];
  return id ? `${id.replace(/^store_/, "").toLowerCase()}.public.blob.vercel-storage.com` : null;
}

/** True when a finish call's url really is that file in this job's folder, on the store this platform uses. */
export function artifactLinkHolds(job: { runId: string; id: string }, name: string, pathname: string, url: string): boolean {
  if (pathname !== `${jobFolder(job)}${name}` || !isSafeFileKey(pathname)) return false;
  if (localFilesEnabled()) return localFileKey(url) === pathname;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== blobStoreHost()) return false;
  try {
    return decodeURIComponent(parsed.pathname) === `/${pathname}`;
  } catch {
    return false;
  }
}
