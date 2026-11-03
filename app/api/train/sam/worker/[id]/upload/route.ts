import { env } from "@/lib/env";
import { errorJson, isUuid, route } from "@/lib/http";
import { looksLikeJpeg, readCapped, SAM_TUNE_LIMITS, uploadFile } from "@/lib/train/sam/route-helpers";
import { saveUpload } from "@/lib/train/sam/store";
import { requireRunToken, requireWorker } from "@/lib/train/sam/worker-auth";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST ?name=sbs1.jpg, the raw file as the body (image/jpeg for .jpg, application/json for .json), the run's jobToken in
 * "X-Job-Token" -> {url}: one report file (a side-by-side picture, scores.json or per_image.json), saved under
 * samtune/<id>/report/. At most SAM_TUNE_LIMITS.uploadMaxBytes (400 KB) a file and uploadsMax (10) a run. 401 wrong
 * secret or token, 400 bad_name, 415 bad_type, 413 too_large, 429 too_many_uploads, 409 not_running, 404 SAM_TUNE off.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.samTune) return errorJson(404, "not_found");
  await requireWorker(req);
  const { id } = await params;
  if (!isUuid(id)) return errorJson(404, "not_found");
  await requireRunToken(req, id, req.headers.get("x-job-token")?.trim() ?? "");
  const file = uploadFile(new URL(req.url).searchParams.get("name"), req.headers.get("content-type"));
  const body = await readCapped(req, SAM_TUNE_LIMITS.uploadMaxBytes);
  if (!body.length) return errorJson(400, "empty");
  // The bytes have to be what the name says, so a .jpg on a shown report is a picture and a .json is JSON.
  if (file.contentType === "image/jpeg" && !looksLikeJpeg(body)) return errorJson(415, "bad_type");
  if (file.contentType === "application/json") {
    try {
      JSON.parse(body.toString("utf8"));
    } catch {
      return errorJson(415, "bad_type");
    }
  }
  const saved = await saveUpload(id, { ...file, body });
  if (saved === "too_many") return errorJson(429, "too_many_uploads");
  if (!saved) return errorJson(409, "not_running");
  return Response.json({ url: saved.url });
});
