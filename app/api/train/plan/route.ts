import { contributorWriterOn, env } from "@/lib/env";
import { reserveCounter } from "@/lib/gateway/store";
import { errorJson, readJson, route } from "@/lib/http";
import { spendPaused } from "@/lib/quota";
import { makeChatAllOn } from "@/lib/make/switch";
import { runCaller, runCallerToCreate, runCeilings, runExamplesMax, withCookies } from "@/lib/train/tune/caller";
import { buildForTune } from "@/lib/train/tune/build-source";
import { examplesFromBody } from "@/lib/train/tune/examples";
import { taskWriterModel } from "@/lib/train/writer";
import { hasSecret } from "@/lib/train/tune/folder-clean";
import { askedExamples, clampExamples, contentFindings, draftPlan, NOTE_MAX, NOTE_MIN, StructuredOutputError } from "@/lib/train/tune/plan";
import { contentFindings as visitorFindings, withVisitorRules } from "@/lib/train/public/content";
import { recordUsage } from "@/lib/usage";

/** Plans one caller may draft an hour: each is one Muse Wonder call, about $0.01 to $0.03 (an estimate). */
/** lib/train/public loads only for a visitor's request, so with OPEN_TRAIN off nothing here changes. */
const START_CODE_UNSET = { ok: false as const, status: 403, code: "start_code_unset", error: "Starting a run isn't open right now." };
const PLANS_PER_HOUR = 20;
const HOUR_MS = 60 * 60_000;
/** The plan request's largest body: the note and 50 rows cut for the task, even in a script that takes 3 bytes a letter. */
const PLAN_BODY_MAX = 128 * 1024;
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * With OPEN_TRAIN on, visitors plan too, under their own limits (runCaller): at most their examples, never for a build,
 * refused while no start code is set, their note and rows scanned for personal data, the narrow-skill rule on, and limits
 * per IP and on every visitor's day, since a plan is a paid call before Start's code. `folder` {hash, mode, rows}
 * (TUNE_FOLDER, POST /api/train/folder's answer) signs that draft into the plan; its files never reach the plan's model.
 * A write-mode folder needs Spark 1.3 Contributor on: 503 folder_writer_off.
 *
 * POST {note, examples?, settings?: {examples?}} -> 200 {plan}. Admins or automation (tuneCaller). Off with
 * TUNE_COMPOSER: 404. One respondStructured call on Muse Wonder (TEST_MODEL where that is on) names the model, sums it
 * up and checks the task against the brief writer's refusal policy; `examples` (at most 50 of the person's own
 * {prompt, answer} rows, parsed in the browser) fold into the task as style examples. The plan comes back signed for
 * this caller, for POST /api/train/runs. 400 bad input (examples outside 40 to the caller's most, tuneExamplesMax),
 * 413 body_too_large (the composer cuts its rows first: planRows), 422 {refusal} when it can't be trained, 429
 * rate_limited (20 an hour per caller), 502 plan_failed (no valid reply after a retry), 503 meta_not_configured or
 * paused.
 *
 * `fromBuildId` (B, the build room's "Its own model"; TUNE_FROM_BUILDS, else 404): a live or partial build whose brief
 * picked muse-glimmer, of a product the caller owns or an admin. The plan's source is then {kind: "build", buildId,
 * productId}, signed with the rest, so Start keeps the product with the run. 404 build_not_found (no such build, or no
 * product yet), 409 build_not_ready (not live or partial, or its brief has no muse-glimmer), 403 not_owner.
 */
async function takeVisitorPlan(ip: string, now: Date) {
  return (await import("@/lib/train/public/open-start")).takeVisitorPlan(ip, now);
}

const refusalReply = (r: { status: number; code: string; error: string; retryAfterSeconds?: number }) =>
  errorJson(r.status, r.code, { message: r.error, ...(r.retryAfterSeconds ? { retryAfterSeconds: r.retryAfterSeconds } : {}) });

export const POST = route(async (req: Request) => {
  if (!env.tuneComposer) return errorJson(404, "not_found");
  const out = { headers: new Headers() };
  let caller = await runCaller(req);
  if (caller.visitor && !env.tuneStartCode) return refusalReply(START_CODE_UNSET);
  // The browser cuts each row to what the task can use (planRows), so 50 rows fit with room to spare.
  const body = await readJson(req, PLAN_BODY_MAX);

  if (typeof body.note !== "string") return errorJson(400, "Say what the model should do.");
  const note = body.note.trim();
  if (note.length < NOTE_MIN) return errorJson(400, `Say what the model should do in at least ${NOTE_MIN} characters.`);
  if (note.length > NOTE_MAX) return errorJson(400, `Keep it under ${NOTE_MAX} characters. Add the rest as examples.`);
  const rows = examplesFromBody(body.examples);
  if (!rows) return errorJson(400, "examples must be up to 50 rows, each with a prompt and an answer.");
  const size = askedExamples(body.settings, runExamplesMax(caller));
  if (!size.ok) return errorJson(400, size.error);
  // A caller that will ask POST /api/train/runs to stop at the dataset says so here, so a site without it refuses before the
  // plan's model call is paid for and counted, not after.
  if ((body.settings as { datasetOnly?: unknown } | undefined)?.datasetOnly === true && !makeChatAllOn()) {
    return errorJson(404, "dataset_only_off", { message: "Stopping at the dataset needs MAKE_CHAT_ALL on this site." });
  }
  const asked = size.value;

  let source: { kind: "build"; buildId: string; productId: string } | { kind: "folder"; hash: string; mode: "rows" | "write" } | undefined;
  let rowsGiven: number | undefined;
  if (body.folder !== undefined && body.folder !== null) {
    if (!env.tuneFolder) return errorJson(404, "not_found");
    const f = body.folder as { hash?: unknown; mode?: unknown; rows?: unknown };
    if (typeof f.hash !== "string" || !HASH_RE.test(f.hash) || (f.mode !== "rows" && f.mode !== "write")) return errorJson(400, "Send the folder as it was reviewed.");
    if (f.mode === "write" && !contributorWriterOn()) return errorJson(503, "folder_writer_off");
    rowsGiven = f.mode === "rows" && typeof f.rows === "number" && Number.isInteger(f.rows) && f.rows > 0 ? f.rows : 0;
    source = { kind: "folder", hash: f.hash, mode: f.mode };
  }
  if (body.fromBuildId !== undefined && body.fromBuildId !== null) {
    if (!env.tuneFromBuilds) return errorJson(404, "not_found");
    if (caller.visitor) return errorJson(403, "not_owner");
    const build = typeof body.fromBuildId === "string" ? await buildForTune(body.fromBuildId) : null;
    if (!build) return errorJson(404, "build_not_found");
    if (!caller.isAdmin && caller.id !== build.ownerId) return errorJson(403, "not_owner");
    if (!build.offers) return errorJson(409, "build_not_ready");
    source = { kind: "build", buildId: build.buildId, productId: build.productId };
  }

  const findings = caller.visitor ? visitorFindings({ note, rows }) : contentFindings({ note, rows });
  if (findings.length) return errorJson(422, "refused", { refusal: findings.join(" ") });
  // As a folder's files are scanned: this text goes to Meta in the plan call. Says nothing about what it matched.
  if (caller.visitor && (hasSecret(note) || rows.some((r) => hasSecret(r.prompt) || hasSecret(r.answer)))) {
    return errorJson(422, "refused", { refusal: "This looks like it holds a key, token or password. Take it out and try again." });
  }
  if (!process.env.MODEL_API_KEY) return errorJson(503, "meta_not_configured");
  if (await spendPaused()) return errorJson(503, "paused");

  const now = new Date();
  // After the input is checked, so bad requests don't use up a network's new visitors.
  const made = await runCallerToCreate(caller, req, out);
  if (!made.ok) return refusalReply(made);
  caller = made.caller;
  const callerId = made.caller.id;
  if (caller.visitor) {
    const refused = await takeVisitorPlan(caller.visitor.ip, now);
    if (refused) return withCookies(refusalReply(refused), out);
  }
  const hour = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  if ((await reserveCounter(`tune-plan:${callerId}`, hour, 1, PLANS_PER_HOUR)) === null) {
    const retryAfterSeconds = Math.max(1, Math.ceil((hour.getTime() + HOUR_MS - now.getTime()) / 1000));
    return withCookies(errorJson(429, "rate_limited", { retryAfterSeconds }), out);
  }

  let result: Awaited<ReturnType<typeof draftPlan>>;
  try {
    result = await draftPlan({
      note,
      rows,
      callerId,
      examples: clampExamples(Math.min(asked ?? env.tuneDefaultExamples, runExamplesMax(caller))),
      ceilings: runCeilings(caller),
      source,
      now,
      visitor: Boolean(caller.visitor),
      ...(caller.visitor ? { finishTask: withVisitorRules } : {}),
      ...(rowsGiven !== undefined ? { rowsGiven } : {}),
    });
  } catch (err) {
    if (!(err instanceof StructuredOutputError)) throw err;
    await recordUsage({ source: "platform", endpoint: "responses" }, err.usage).catch((e) => console.error("[train/plan] usage", e));
    return withCookies(errorJson(502, "plan_failed"), out);
  }
  await recordUsage({ source: "platform", endpoint: "responses" }, result.usage).catch((e) => console.error("[train/plan] usage", e));
  if (!result.ok) return withCookies(errorJson(422, "refused", { refusal: result.refusal }), out);
  // A described run's examples writer, so an unattended caller can check it before it starts the run.
  const writerModel = result.plan.source.kind === "task" ? { writerModel: taskWriterModel() } : {};
  return withCookies(Response.json({ plan: result.plan, ...writerModel }), out);
});
