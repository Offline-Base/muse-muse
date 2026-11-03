import { requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, isUuid, readJson, route } from "@/lib/http";
import { LOOKALIKE_BATCH, lookalikesToMake, makeLookalikes } from "@/lib/train/sam/distractors";
import { refusalText } from "@/lib/train/sam/spend";
import { distractorDeps, spendLimits } from "@/lib/train/sam/uploads-deps";
import { editProblem, getUploadRun, setDistractorKept } from "@/lib/train/sam/uploads-store";

export const runtime = "nodejs";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

const EDIT_TEXT = {
  not_uploads: "This run uses the built-in Muse set, which has its own look-alikes.",
  not_draft: "This run has started, so its look-alikes can't change.",
} as const;

async function editableRun(req: Request, params: Ctx["params"]) {
  if (!env.samTune) return { response: errorJson(404, "not_found") };
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
 * POST {count?} -> {made, skipped, costUsd, refused, message?}: up to 4 made-up Muse Image look-alikes ($0.01 each),
 * other things of the run's everyday kind drawn after one of the person's training photos. Each picture is held
 * against the platform's daily cap, SAM_TUNE_DAILY_USD and the run's own cap before its call; when a cap says no
 * before the first, nothing is sent and the answer is 402 {error, message}. A run holds at most 24 look-alikes (409
 * full). Admins or automation. 404 with SAM_TUNE off or an unknown run; 409 when the run uses the built-in set or has
 * started.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const got = await editableRun(req, params);
  if (!got.run) return got.response;
  const body = await readJson(req, 1024).catch(() => ({}) as Record<string, unknown>);
  const asked = typeof body.count === "number" ? body.count : LOOKALIKE_BATCH;
  if (lookalikesToMake(got.run, asked) === 0) {
    return errorJson(409, "full", { message: "This run has all the look-alikes it can take, or none were asked for." });
  }
  const outcome = await makeLookalikes(got.run, spendLimits(got.run), distractorDeps(got.run), asked);
  if (outcome.refused && outcome.made.length === 0 && outcome.skipped.length === 0) {
    return errorJson(402, outcome.refused, { message: refusalText(outcome.refused) });
  }
  return Response.json({ ...outcome, message: outcome.refused ? refusalText(outcome.refused) : undefined });
});

/** PATCH {url, kept} -> {ok: true}: keeps or drops one look-alike, from the look-alike grid. Costs nothing. */
export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const got = await editableRun(req, params);
  if (!got.run) return got.response;
  const body = await readJson(req, 4096);
  const url = typeof body.url === "string" ? body.url : "";
  if (typeof body.kept !== "boolean") return errorJson(400, "bad_request", { message: "kept has to be true or false." });
  if (!got.run.distractors.some((d) => d.url === url)) return errorJson(404, "no_lookalike");
  if (!(await setDistractorKept(got.run.id, url, body.kept))) return errorJson(409, "not_draft", { message: EDIT_TEXT.not_draft });
  return Response.json({ ok: true, kept: body.kept });
});
