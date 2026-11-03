import { requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, readJson, route } from "@/lib/http";
import { genericProblem, wordProblem } from "@/lib/train/sam/logic";
import { createRun } from "@/lib/train/sam/store";
import type { SamData } from "@/lib/train/sam/types";

export const runtime = "nodejs";

const DATA: SamData[] = ["builtin-muse", "uploads"];

/**
 * POST {word, generic, data, maxUsd?} -> 201 {run}: a draft SAM 3.1 tune run (docs/TRAINING.md "Teach SAM 3.1 a new
 * object"). Admins or automation. data is "builtin-muse" (the Nov 3 Muse sets) or "uploads" (the person's own
 * photos). maxUsd is held to SAM_TUNE_MAX_USD. Off with SAM_TUNE: 404. 400 {error, message} for a bad field.
 */
export const POST = route(async (req: Request) => {
  if (!env.samTune) return errorJson(404, "not_found");
  const user = await requireAdminOrAutomation(req);
  const body = await readJson(req, 4096);
  const word = typeof body.word === "string" ? body.word.trim() : "";
  const generic = typeof body.generic === "string" ? body.generic.trim().replace(/\s+/g, " ") : "";
  const data = body.data as SamData;
  const problem = wordProblem(word) ?? genericProblem(generic) ?? (DATA.includes(data) ? null : "Pick the built-in Muse set or your own photos.");
  if (problem) return errorJson(400, "bad_request", { message: problem });
  if (word === generic) return errorJson(400, "bad_request", { message: "The name and the everyday word have to differ." });
  const ceiling = env.samTuneMaxUsd;
  const asked = body.maxUsd === undefined ? ceiling : body.maxUsd;
  if (typeof asked !== "number" || !Number.isFinite(asked) || asked < 0) {
    return errorJson(400, "bad_request", { message: "maxUsd has to be a dollar amount of 0 or more." });
  }
  const run = await createRun({ word, generic, data, createdBy: user.id, maxUsd: Math.min(asked, ceiling) });
  return Response.json({ run }, { status: 201 });
});
