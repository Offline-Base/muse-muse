/**
 * Helpers for the /api/train/sam routes (U2, tg-sam-routes). Pure except where noted, so the route tests can check
 * them directly. Not a route: Next only serves route.ts files.
 */
import { HttpError } from "@/lib/http";
import { localFileKey } from "@/lib/local-files";
import { SAM_TUNE_LIMITS, type SamReport, type SamReportIn, type SamRunView } from "@/lib/train/sam/types";

/**
 * Start reserves what a run has left to spend under the shared SAM tune day counter (types.ts SAM_TUNE_DAY_KEY, in
 * micro-dollars, windowed at the next UTC midnight), the same key and unit U6's labels and look-alikes hold, so
 * SAM_TUNE_DAILY_USD is one cap. Re-exported here so the routes have one import.
 */
export { SAM_TUNE_DAY_KEY, samMicros, samTuneDayWindow } from "@/lib/train/sam/types";

/** The worker's name: lowercase letters, digits and dashes, 1 to 40, like "jetson-03". */
export const WORKER_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** What a signed-out visitor may read of a run an admin marked shown: the report, without the worker's name. */
export interface SamPublicRun {
  id: string;
  word: string;
  generic: string;
  status: SamRunView["status"];
  costUsd: number;
  createdAt: string;
  report: Omit<SamReport, "workerId">;
}

/** The public view of a shown, finished run, or null when a visitor may not see it at all. */
export function publicRun(view: SamRunView): SamPublicRun | null {
  if (!view.shown || view.status !== "done" || !view.report) return null;
  const { workerId: _workerId, ...report } = view.report;
  return {
    id: view.id,
    word: view.word,
    generic: view.generic,
    status: view.status,
    costUsd: view.costUsd,
    createdAt: view.createdAt,
    report,
  };
}

const UPLOAD_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", json: "application/json" };

/**
 * The upload's checked file name and content type: `name` is letters, digits, "_" or "-" (1 to 40) and a .jpg, .jpeg
 * or .json ending, and the request's content-type has to match the ending. Throws HttpError 400 otherwise.
 */
export function uploadFile(name: string | null, contentType: string | null): { name: string; contentType: string } {
  const m = /^([A-Za-z0-9_-]{1,40})\.(jpg|jpeg|json)$/i.exec(name ?? "");
  if (!m) throw new HttpError(400, "bad_name");
  const want = UPLOAD_TYPES[m[2].toLowerCase()];
  const got = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (got !== want) throw new HttpError(415, "bad_type");
  return { name: `${m[1]}.${m[2].toLowerCase()}`, contentType: want };
}

/**
 * Reads a request body of at most `maxBytes`, stopping as soon as it goes over (HttpError 413), so a big body is never
 * held whole. Content-Length over the cap is refused before reading.
 */
export async function readCapped(req: Request, maxBytes: number): Promise<Buffer> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new HttpError(413, "too_large");
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "too_large");
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

/**
 * True when `url` is a file this run uploaded through /upload: on a Vercel Blob public host (or this platform's local
 * files) under samtune/<runId>/report/, https, with no credentials, port, query or fragment. A report may link and
 * show only these, so a leaked worker secret can't put another site's picture on a shown report.
 */
export function isRunReportUrl(url: string, runId: string): boolean {
  if (typeof url !== "string" || url.length > 512) return false;
  const folder = `samtune/${runId.toLowerCase()}/report/`;
  const local = localFileKey(url);
  if (local !== null) return local.startsWith(folder) && local.length > folder.length;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    u.hostname.endsWith(".public.blob.vercel-storage.com") &&
    !u.username &&
    !u.password &&
    !u.port &&
    !u.search &&
    !u.hash &&
    u.pathname.startsWith(`/${folder}`) &&
    u.pathname.length > folder.length + 1
  );
}

/** The first link in a board's report that isn't one of this run's uploads, or null when every one is. */
export function foreignReportUrl(report: SamReportIn, runId: string): string | null {
  const urls = [report.files?.scores, report.files?.perImage, ...(report.images ?? []).map((i) => i?.url)];
  for (const url of urls) if (!isRunReportUrl(url as string, runId)) return String(url);
  return null;
}

/** Bytes of a report as JSON, to hold it to SAM_TUNE_LIMITS.reportMaxBytes. */
export function reportBytes(report: unknown): number {
  return Buffer.byteLength(JSON.stringify(report) ?? "");
}

/** A whole number in [0, max], or null. */
export function wholeNumber(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

export { SAM_TUNE_LIMITS };

/**
 * Why a run can't start yet, as a sentence, or null when it can. The built-in Muse set is ready as it is; a run on
 * the person's own photos needs SAM_TUNE_LIMITS' photo, held-out and look-alike counts first.
 */
export function startProblem(view: Pick<SamRunView, "data" | "photos" | "distractors">): string | null {
  if (view.data === "builtin-muse") return null;
  const photos = (view.photos ?? []).filter((p) => !p.skipped && p.box);
  const held = photos.filter((p) => p.split === "held").length;
  const kept = (view.distractors ?? []).filter((d) => d.kept).length;
  const L = SAM_TUNE_LIMITS;
  if (photos.length < L.photosMin || photos.length > L.photosMax) {
    return `Add ${L.photosMin} to ${L.photosMax} labeled photos first (${photos.length} so far).`;
  }
  if (held < L.heldMin) return `Keep at least ${L.heldMin} photos aside for the test (${held} so far).`;
  if (kept < L.distractorsMin || kept > L.distractorsMax) {
    return `Keep ${L.distractorsMin} to ${L.distractorsMax} look-alikes (${kept} kept).`;
  }
  return null;
}

/** True for bytes that start as a JPEG does (FF D8 FF). */
export function looksLikeJpeg(body: Uint8Array): boolean {
  return body.length > 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
}
