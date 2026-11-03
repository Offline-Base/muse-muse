import { requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, isUuid, readJson, route } from "@/lib/http";
import { putFile } from "@/lib/storage";
import { checkPhoto, photoProblemText, splitFor } from "@/lib/train/sam/photo";
import { addDistractor, addPhoto, editProblem, getUploadRun } from "@/lib/train/sam/uploads-store";
import { SAM_TUNE_LIMITS, type SamDistractor, type SamPhoto } from "@/lib/train/sam/types";

export const runtime = "nodejs";
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

/** A base64 photo of SAM_TUNE_LIMITS.uploadMaxBytes is about 4/3 of it, plus the data URL's head and the JSON. */
const BODY_MAX = Math.ceil((SAM_TUNE_LIMITS.uploadMaxBytes * 4) / 3) + 4096;

const EDIT_TEXT = {
  not_uploads: "This run uses the built-in Muse set, so it takes no photos.",
  not_draft: "This run has started, so its photos can't change.",
} as const;

/**
 * POST {image, kind?} -> 201 {photo} or {distractor}: one photo the person sends for a draft run on their own photos.
 * `image` is a base64 data URL of a JPEG, PNG or WebP, at most 1024 px on its longest side and 400 KB (the page
 * shrinks it first). `kind` is "photo" (the person's object, the default) or "lookalike" (another one like it, a
 * negative). Saved under samtune/<id>/; every third goes in the held-out set. Admins or automation. 404 with SAM_TUNE
 * off or an unknown run; 409 when the run uses the built-in set, has started, or is full (60 photos, 24 look-alikes);
 * 400 {message} for a photo that can't be used.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.samTune) return errorJson(404, "not_found");
  await requireAdminOrAutomation(req);
  const { id } = await params;
  if (!isUuid(id)) return errorJson(404, "not_found");
  const body = await readJson(req, BODY_MAX);
  const kind = body.kind === undefined || body.kind === "photo" ? "photo" : body.kind === "lookalike" ? "lookalike" : null;
  if (!kind) return errorJson(400, "bad_request", { message: 'kind has to be "photo" or "lookalike".' });

  const run = await getUploadRun(id);
  const problem = editProblem(run);
  if (problem === "not_found" || !run) return errorJson(404, "not_found");
  if (problem) return errorJson(409, problem, { message: EDIT_TEXT[problem] });
  const count = kind === "photo" ? run.photos.length : run.distractors.length;
  const max = kind === "photo" ? SAM_TUNE_LIMITS.photosMax : SAM_TUNE_LIMITS.distractorsMax;
  if (count >= max) return errorJson(409, "full", { message: `A run takes at most ${max} ${kind === "photo" ? "photos" : "look-alikes"}.` });

  const checked = checkPhoto(typeof body.image === "string" ? body.image : "");
  if ("problem" in checked) return errorJson(400, checked.problem, { message: photoProblemText(checked.problem) });

  const folder = kind === "photo" ? "photos" : "lookalikes";
  const url = await putFile("samtune", `${id}/${folder}/${kind}.${checked.ext}`, checked.bytes, checked.contentType);
  // The count was read before the upload; the append holds the cap again in one statement. A photo that lost the race
  // stays in Blob until the cleanup cron's 7 days.
  if (kind === "photo") {
    const photo: SamPhoto = { url, split: splitFor(count), box: null, skipped: false };
    const list = await addPhoto(id, photo);
    if (!list) return errorJson(409, "full", { message: `A run takes at most ${max} photos, and only before it starts.` });
    return Response.json({ photo, count: list.length }, { status: 201 });
  }
  const distractor: SamDistractor = { url, source: "own", split: splitFor(count), kept: true };
  const list = await addDistractor(id, distractor);
  if (!list) return errorJson(409, "full", { message: `A run takes at most ${max} look-alikes, and only before it starts.` });
  return Response.json({ distractor, count: list.length }, { status: 201 });
});
