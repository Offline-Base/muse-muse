import { requireAdminOrAutomation } from "@/lib/auth";
import { errorJson, isUuid, readJson, route } from "@/lib/http";
import { labelPhotos, LABEL_BATCH, personBox } from "@/lib/train/sam/label";
import { refusalText } from "@/lib/train/sam/spend";
import { samTuneOn } from "@/lib/train/sam/u1-shim";
import { labelDeps, spendLimits } from "@/lib/train/sam/uploads-deps";
import { editProblem, getUploadRun, savePhoto } from "@/lib/train/sam/uploads-store";

export const runtime = "nodejs";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

const EDIT_TEXT = {
  not_uploads: "This run uses the built-in Muse set, which is labeled already.",
  not_draft: "This run has started, so its boxes can't change.",
} as const;

async function editableRun(req: Request, params: Ctx["params"]) {
  if (!samTuneOn()) return { response: errorJson(404, "not_found") };
  await requireAdminOrAutomation(req);
  const { id } = await params;
  if (!isUuid(id)) return { response: errorJson(404, "not_found") };
  const run = await getUploadRun(id);
  const problem = editProblem(run);
  if (problem === "not_found" || !run) return { response: errorJson(404, "not_found") };
  if (problem) return { response: errorJson(409, problem, { message: EDIT_TEXT[problem] }) };
  return { run };
}

/**
 * POST -> {labeled, left, failed, costUsd, refused, message?}: first boxes for up to 6 photos that have none, one hosted
 * SAM 3.1 look each ($0.0025), asked the run's everyday word. Every look is held against the platform's daily cap,
 * SAM_TUNE_DAILY_USD and the run's own cap before it is sent; when a cap says no before the first look, nothing is
 * sent and the answer is 402 {error, message}. The page asks again while `left` is above zero. Admins or automation.
 * 404 with SAM_TUNE off or an unknown run; 409 when the run uses the built-in set or has started.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const got = await editableRun(req, params);
  if (!got.run) return got.response;
  const outcome = await labelPhotos(got.run, spendLimits(got.run), labelDeps(got.run), LABEL_BATCH);
  if (outcome.refused && outcome.labeled.length === 0 && outcome.failed === 0) {
    return errorJson(402, outcome.refused, { message: refusalText(outcome.refused), left: outcome.left });
  }
  return Response.json({ ...outcome, message: outcome.refused ? refusalText(outcome.refused) : undefined });
});

/**
 * PATCH {url, box, skipped?} -> {ok: true}: the person's own box for one photo, from the review grid. `box` is
 * [x, y, width, height] in the photo's pixels; skipped true leaves the photo out (its box is kept), and null with skipped false
 * puts it back with no box, for SAM to look again. Costs nothing.
 * 400 for a bad box; 404 when the run has no photo at that url.
 */
export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const got = await editableRun(req, params);
  if (!got.run) return got.response;
  const body = await readJson(req, 4096);
  const url = typeof body.url === "string" ? body.url : "";
  const photo = got.run.photos.find((p) => p.url === url);
  if (!photo) return errorJson(404, "no_photo");
  const skipped = body.skipped === true;
  // A skipped photo keeps its box, so "Use it" brings it back as it was. Box null and not skipped puts the photo
  // back in SAM's queue with no box.
  const box = skipped ? photo.box : body.box === null ? null : personBox(body.box);
  if (!skipped && !box && body.box !== null) return errorJson(400, "bad_box", { message: "Draw a box at least 2 px wide and tall inside the photo, or skip it." });
  if (!(await savePhoto(got.run.id, url, { box, skipped }))) return errorJson(409, "not_draft", { message: EDIT_TEXT.not_draft });
  return Response.json({ ok: true, box, skipped });
});
