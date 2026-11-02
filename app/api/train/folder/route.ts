import { env } from "@/lib/env";
import { errorJson, readJson, route } from "@/lib/http";
import { cleanFolder } from "@/lib/train/tune/folder-clean";
import { FOLDER_LIMITS } from "@/lib/train/tune/folder";
import { runCaller, runExamplesMax } from "@/lib/train/tune/caller";

/** Folders one IP may send an hour. No model reads them here, but scanning them isn't free. */
const FOLDERS_PER_HOUR = 30;

/**
 * POST {confirmed: true, files: [{path, text}], skipped?} -> 200 {draft, hash, review} (TUNE_FOLDER, docs/TRAINING.md
 * "Anyone can fine-tune"). Off: 404. Admins and automation, and anyone while OPEN_TRAIN is on; refused for visitors with no
 * start code set. Nothing is saved and no model is called: the browser reads the files, this cleans them (the rules again,
 * a scan for secrets and personal data, rows in the right format) and answers what would train, and Start sends that back,
 * checked again. `confirmed` is the person's yes to the notice: files go to Meta on a tier where Meta may train, and
 * personal or sensitive information isn't allowed.
 *
 * 400 bad input, 413 body_too_large, 422 {error} when nothing could be used, 428 notice_not_confirmed, 429 rate_limited.
 */
export const POST = route(async (req: Request) => {
  if (!env.tuneComposer || !env.tuneFolder) return errorJson(404, "not_found");
  const caller = await runCaller(req);
  if (caller.visitor) {
    if (!env.tuneStartCode) return errorJson(403, "start_code_unset", { message: "Starting a run isn't open right now." });
    const { hourStart, secondsUntil } = await import("@/lib/docs/proxy/limits");
    const { reserveCounter } = await import("@/lib/gateway/store");
    const now = new Date();
    const hour = hourStart(now);
    if ((await reserveCounter(`tune-folder:ip:${caller.visitor.ip}`, hour, 1, FOLDERS_PER_HOUR)) === null) {
      return errorJson(429, "rate_limited", { retryAfterSeconds: secondsUntil(new Date(hour.getTime() + 60 * 60_000), now) });
    }
  }
  const body = await readJson(req, FOLDER_LIMITS.bodyBytes);
  if (body.confirmed !== true) return errorJson(428, "notice_not_confirmed");
  const result = cleanFolder(body, runExamplesMax(caller));
  if (!result.ok) return errorJson(422, result.error);
  return Response.json({ draft: result.draft, hash: result.hash, review: result.review });
});
