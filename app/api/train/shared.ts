/**
 * Helpers shared by the /api/train routes (docs/TRAINING.md "Routes"). Not a route: Next only serves route.ts files.
 */
import { HttpError } from "@/lib/http";
import { verifyJobToken } from "@/lib/train/store";

// The launch gate's helpers live in lib/train/gate.ts, so launchJob and the tuneRun workflow's steps share them.
export {
  gpuOptions,
  lambdaConfigured,
  limitCeilings,
  recipeView,
  SWEEP_FRESH_MS,
  sweepOffReason,
  sweepRunning,
  type SweepOffReason,
} from "@/lib/train/gate";

/**
 * The public host of the Blob store BLOB_READ_WRITE_TOKEN belongs to ("<store id>.public.blob.vercel-storage.com",
 * lowercase), from the token's "vercel_blob_rw_<store id>_<secret>" shape, as @vercel/blob reads it. Null without a
 * token or with one of another shape. The secret part is never returned.
 */
export function blobPublicHost(): string | null {
  const token = process.env.BLOB_READ_WRITE_TOKEN ?? "";
  const storeId = token.startsWith("vercel_blob_rw_") ? (token.split("_")[3] ?? "") : "";
  return /^[A-Za-z0-9-]+$/.test(storeId) ? `${storeId.toLowerCase()}.public.blob.vercel-storage.com` : null;
}

/** Longer than any URL an upload grant can produce (the upload route's pathname is under 200 characters). */
const BLOB_URL_MAX = 512;

/**
 * `url` as stored, when it is a file this job uploaded: https on this deployment's Blob store, under models/<jobId>/,
 * with no credentials, port, query or fragment. Null for anything else (another host, another job's folder, no
 * BLOB_READ_WRITE_TOKEN), so an artifact link on the job page can only open the job's own upload.
 */
export function jobBlobUrl(url: string, jobId: string): string | null {
  const host = blobPublicHost();
  if (!host || url.length > BLOB_URL_MAX) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const folder = `/models/${jobId.toLowerCase()}/`;
  const ok =
    u.protocol === "https:" &&
    u.hostname === host &&
    !u.username &&
    !u.password &&
    !u.port &&
    !u.search &&
    !u.hash &&
    u.pathname.startsWith(folder) &&
    u.pathname.length > folder.length;
  return ok ? u.href : null;
}

/**
 * Checks "Authorization: Bearer <job token>" for this job (verifyJobToken: the stored hash, and no later than 15
 * minutes after the job ended). Throws HttpError 401 otherwise. The instance's runner is the only caller; it has no
 * session, and nothing in front of these routes asks for one.
 */
export async function requireJobToken(req: Request, jobId: string): Promise<void> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token || !(await verifyJobToken(jobId, token))) throw new HttpError(401, "unauthorized");
}

