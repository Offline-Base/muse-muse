import { requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, readJson, route } from "@/lib/http";
import { resolveBase } from "@/lib/train/base-check";
import { askedBase } from "@/lib/train/bases";

/**
 * POST {base: {repo, revision?}} -> 200 {base}, every check a launch makes (lib/train/base-check.ts) with nothing started,
 * for the picker. Admins or automation only; off with TUNE_ANY_BASE: 404. 400 with the sentence that says why not.
 */
export const POST = route(async (req: Request) => {
  if (!env.tuneAnyBase) return errorJson(404, "not_found");
  await requireAdminOrAutomation(req);
  const body = await readJson(req, 4 * 1024);
  const asked = askedBase(body.base);
  if (!asked.ok) return errorJson(400, asked.error);
  if (!asked.value) return errorJson(400, "Pick a base.");
  const checked = await resolveBase(asked.value);
  if (!checked.ok) return errorJson(400, checked.error);
  return Response.json({ base: checked.base });
});
