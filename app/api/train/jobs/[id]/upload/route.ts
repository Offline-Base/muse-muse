import { randomBytes } from "node:crypto";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { env } from "@/lib/env";
import { hitRateLimits } from "@/lib/gateway/store";
import { errorJson, readJson, route } from "@/lib/http";
import { getJob, reserveUploadBytes } from "@/lib/train/store";
import { isTrainTerminal, TRAIN_UPLOAD_TYPES } from "@/lib/train/types";
import { requireJobToken } from "../../../shared";

type Ctx = { params: Promise<{ id: string }> };

/** The largest file a job may upload, such as a LoRA adapter or a checkpoint. */
const MAX_UPLOAD_BYTES = 1024 ** 3;
/**
 * A grant lasts this long plus the time its file takes at UPLOAD_MIN_BYTES_PER_SECOND (about 22 minutes for 1 GB),
 * and never past TOKEN_TTL_MAX_MS or the job's own end.
 */
const TOKEN_BASE_MS = 5 * 60_000;
const UPLOAD_MIN_BYTES_PER_SECOND = 1024 ** 2;
const TOKEN_TTL_MAX_MS = 30 * 60_000;
/** The job token's grace after the end (lib/train/store.ts TOKEN_GRACE_MS): the workflow's hard stop is inside it. */
const AFTER_END_MS = 15 * 60_000;
const NAME_MAX = 120;
/** Upload tokens one job may get per hour. A run uploads a few files; this and the byte budget bound a leaked token. */
const GRANTS_PER_HOUR = 20;
/** Bytes one job may be granted per hour, counted from the sizes it declares (each grant allows no more). */
const GRANT_BYTES_PER_HOUR = 5 * 1024 ** 3;
/** Media types a job may upload (lib/train/types.ts). runner.py sends anything else as application/octet-stream. */
const UPLOAD_TYPES = TRAIN_UPLOAD_TYPES;
/** Names a browser could take for a web page even with a safe media type. */
const PAGE_NAME = /\.(html?|xhtml|shtml|xml|svgz?)$/i;

/** The file's base name with anything but letters, digits, dot, dash and underscore turned into a dash. Null when nothing is left. */
function safeName(raw: string): string | null {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, NAME_MAX)
    .replace(/[-.]+$/, "");
  return clean || null;
}

/**
 * POST {name, bytes, contentType} -> {clientToken, pathname}, from the job's runner with its job token. Each token
 * covers exactly one blob: the platform picks the pathname, models/<jobId>/<12 random hex>-<safe name>, with no random
 * suffix and no overwrite, so a second put with the same token fails. It allows no more than the declared bytes (up to
 * 1 GB), only the declared media type (one of UPLOAD_TYPES), and expires after the time that file needs (5 minutes
 * plus 1 MB a second, at most 30 minutes) or 15 minutes after the job's time limit, whichever is first. Uploads are
 * public, as the runner sends "x-vercel-blob-access: public" and every other blob here is public; a client token
 * doesn't carry the access level. 401 bad token, 400 bad input (a name, size or media type it can't take), 409
 * job_ended, 413 too_large, 413 upload_budget (more than 5 GB granted this hour), 429 upload_limit (more than 20
 * tokens this hour), 503 no_storage (no BLOB_READ_WRITE_TOKEN, which the runner takes as "skip the upload").
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  await requireJobToken(req, id);
  const body = await readJson(req, 16 * 1024);

  const name = typeof body.name === "string" ? safeName(body.name) : null;
  if (!name) return errorJson(400, "Send the file's name.");
  if (PAGE_NAME.test(name)) return errorJson(400, "Web pages and SVG files can't be uploaded.");
  const bytes = typeof body.bytes === "number" && Number.isFinite(body.bytes) ? body.bytes : NaN;
  if (!(bytes >= 0)) return errorJson(400, "Send the file's size in bytes.");
  if (bytes > MAX_UPLOAD_BYTES) return errorJson(413, "too_large", { maxBytes: MAX_UPLOAD_BYTES });
  const contentType = body.contentType === undefined ? "application/octet-stream" : body.contentType;
  if (typeof contentType !== "string" || !UPLOAD_TYPES.includes(contentType)) {
    return errorJson(400, "That media type can't be uploaded.", { allowed: UPLOAD_TYPES });
  }

  const job = await getJob(id);
  if (!job) return errorJson(404, "not_found");
  if (isTrainTerminal(job.status)) return errorJson(409, "job_ended");
  const now = Date.now();
  // The instance can't outlive this: the workflow's hard stop and the sweep both come before it.
  const jobEnd = job.launchedAt ? job.launchedAt.getTime() + job.maxMinutes * 60_000 + AFTER_END_MS : now + AFTER_END_MS;
  const needed = TOKEN_BASE_MS + Math.ceil((bytes / UPLOAD_MIN_BYTES_PER_SECOND) * 1000);
  const validUntil = Math.min(now + Math.min(needed, TOKEN_TTL_MAX_MS), jobEnd);
  if (validUntil <= now) return errorJson(409, "job_ended");

  let token: string;
  try {
    token = env.blobToken;
  } catch {
    return errorJson(503, "no_storage");
  }
  const hour = new Date(Math.floor(now / 3_600_000) * 3_600_000);
  const key = `train-upload:${id}`;
  const counts = await hitRateLimits([key], hour);
  if ((counts[key] ?? 0) > GRANTS_PER_HOUR) return errorJson(429, "upload_limit");
  if (!(await reserveUploadBytes(id, bytes, hour, GRANT_BYTES_PER_HOUR))) {
    return errorJson(413, "upload_budget", { maxBytesPerHour: GRANT_BYTES_PER_HOUR });
  }
  const pathname = `models/${id.toLowerCase()}/${randomBytes(6).toString("hex")}-${name}`;
  const clientToken = await generateClientTokenFromReadWriteToken({
    token,
    pathname,
    maximumSizeInBytes: Math.min(MAX_UPLOAD_BYTES, Math.max(1, Math.ceil(bytes))),
    allowedContentTypes: [contentType],
    validUntil,
    addRandomSuffix: false,
    allowOverwrite: false,
  });
  return Response.json({ clientToken, pathname });
});
