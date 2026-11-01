import { start } from "workflow/api";
import { requireUser } from "@/lib/auth";
import { grantEditPass } from "@/lib/edit-pass";
import { env } from "@/lib/env";
import { errorJson, readJson, route } from "@/lib/http";
import { requestedTargetsFrom } from "@/lib/native/targets";
import { catalogItem } from "@/lib/pipeline/catalog";
import { attachRun, insertBuild, markStartFailed } from "@/lib/pipeline/records";
import { validateNote, validateReferences } from "@/lib/pipeline/references";
import { buildProduct } from "@/lib/pipeline/workflow";
import { checkBuildAllowed } from "@/lib/quota";

/**
 * POST {note, references, rebuildOf?, targets?} -> 201 {buildId}. Saves the muse, queues a build and starts the build
 * workflow. `targets` is where the person picked for it to run (docs/NATIVE.md), and with every target flag off it is
 * ignored. 400 bad input or a target whose flag is off, 401 signed out, 403 rebuildOf from someone who isn't an admin (showcase rebuilds are admin-only, as
 * in /api/rebuilds), 429 {error: "daily_limit" | "shared_limit"}, 503 {error: "paused"} (daily spend cap) or
 * {error: "no_storage"} (neither BLOB_READ_WRITE_TOKEN nor BLOB_STORE_ID is set).
 */
export const POST = route(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson(req);

  const note = validateNote(body.note);
  if (!note.ok) return errorJson(400, note.error);
  const references = validateReferences(body.references);
  if (!references.ok) return errorJson(400, references.error);
  if (!note.value && references.value.length === 0) return errorJson(400, "Add a note or at least one file.");

  let rebuildOf: string | null = null;
  if (body.rebuildOf !== undefined && body.rebuildOf !== null) {
    if (!user.isAdmin) return errorJson(403, "Only admins can start a rebuild of Meta's demos.");
    if (typeof body.rebuildOf !== "string" || !catalogItem(body.rebuildOf)) {
      return errorJson(400, "That rebuild isn't in the catalog.");
    }
    rebuildOf = body.rebuildOf;
  }

  const targets = requestedTargetsFrom(body.targets, env.enabledTargets);
  if (!targets.ok) return errorJson(400, targets.error);

  const allowed = await checkBuildAllowed(user);
  if (!allowed.ok) return errorJson(allowed.status, allowed.error);

  const { buildId } = await insertBuild({
    userId: user.id,
    note: note.value,
    references: references.value,
    rebuildOf,
    requestedTargets: targets.value,
  });
  let runId: string;
  try {
    runId = (await start(buildProduct, [{ buildId }])).runId;
  } catch (err) {
    await markStartFailed(buildId, err);
    return errorJson(500, "start_failed");
  }
  await attachRun(buildId, runId).catch((err) => console.error("[inspirations] attachRun", err));
  await grantEditPass(user, buildId);
  return Response.json({ buildId }, { status: 201 });
});
