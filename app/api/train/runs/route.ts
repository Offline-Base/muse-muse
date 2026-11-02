import { contributorWriterOn, env } from "@/lib/env";
import { adjustCounter, reserveCounter } from "@/lib/gateway/store";
import { errorJson, readJson, route } from "@/lib/http";
import { spendPaused } from "@/lib/quota";
import { buildForTune } from "@/lib/train/tune/build-source";
import { runCaller, runCeilings, runExamplesMax, runOwnerId } from "@/lib/train/tune/caller";
import { checkDraft } from "@/lib/train/tune/folder-clean";
import { FOLDER_LIMITS, type FolderDraft } from "@/lib/train/tune/folder";
import { askedExamples, askedSteps, maxStepsFor, planCost, planSettings, TUNE_STEPS, verifyPlan } from "@/lib/train/tune/plan";
import { startTuneRun, TuneStartError } from "@/lib/train/tune/start";
import { resolveBase } from "@/lib/train/base-check";
import { askedBase, tuneBaseOf } from "@/lib/train/bases";
import type { TrainPlanBody, TuneBase } from "@/lib/train/tune/types";

const refusalReply = (r: { status: number; code: string; error: string; retryAfterSeconds?: number }) =>
  errorJson(r.status, r.code, { message: r.error, ...(r.retryAfterSeconds ? { retryAfterSeconds: r.retryAfterSeconds } : {}) });

/**
 * With OPEN_TRAIN on, anyone may start, but a non-admin must send `startCode` (TUNE_START_CODE, checked on the server first
 * thing, wrong tries limited), plans within their own examples, steps and job limits, and takes one running run a person,
 * starts per hour, a dataset of the day and the day's Meta budget before anything is written (reserveVisitorStart). 403
 * start_code_*, 409 visitor_one_run, 429 start_code_tries or visitor_hourly. A visitor's run never uploads.
 *
 * A folder plan (TUNE_FOLDER) also sends `folder`, the draft POST /api/train/folder answered: checked again here and
 * refused unless it is the very one the plan was signed for (400 folder_changed).
 *
 * POST {plan, settings?: {examples?, steps?, autoPublish?}} -> 201 {runId, href}. Admins or automation (tuneCaller). Off with
 * TUNE_COMPOSER: 404. `plan` is what POST /api/train/plan answered, unchanged: its token must be this caller's, for
 * exactly this plan, and not expired, and each plan starts once. Advanced may change the number of examples (40 to the
 * caller's most, tuneExamplesMax) and the training steps (10 to as many as fit in the run's time limit, maxStepsFor);
 * every other setting and the costs are made again here from the platform's defaults and ceilings, never taken from
 * the browser. A task plan saves the dataset and starts makeDataset, as POST /api/train/datasets does, keeps the steps
 * with the run and starts the tuneRun workflow, which trains it once the examples are ready (startTuneRun); the run's
 * id is the dataset's.
 *
 * With TUNE_ANY_BASE, settings.base {repo, revision?} is another Meta base, for admins: 400 with the sentence that
 * refuses it, or the run keeps it and every launch checks it again. Off: 404. Steps are checked on that base's estimate.
 *
 * A build plan (B, source {kind: "build"}) starts like a task plan, keeps its product with the run, and is one a product
 * a day (429 product_daily with {retryAfterSeconds}, counted in startTuneRun), on top of every other cap.
 *
 * A build plan is checked again at Start: 404 not_found with TUNE_FROM_BUILDS off, 404 build_not_found, 409
 * build_not_ready when the build no longer offers its own model.
 *
 * 400 bad input or plan_expired, 403 plan_invalid (tampered, or another caller's), 409 already_started, 429
 * product_daily, 503 meta_not_configured or paused, 500 start_failed.
 */
export const POST = route(async (req: Request) => {
  if (!env.tuneComposer) return errorJson(404, "not_found");
  const caller = await runCaller(req);
  // Only a folder plan is big, and only with its flag on.
  const body = await readJson(req, env.tuneFolder ? FOLDER_LIMITS.bodyBytes : 32 * 1024);
  const now = new Date();

  if (caller.visitor) {
    const { checkStartCode } = await import("@/lib/train/public/start-code");
    const refused = await checkStartCode({ key: caller.id, ip: caller.visitor.ip }, body.startCode, now);
    if (refused) return refusalReply(refused);
  }

  if (!caller.id) return errorJson(403, "plan_invalid");
  const check = verifyPlan(body.plan, caller.id, now);
  if (!check.ok) {
    if (check.reason === "expired") return errorJson(400, "plan_expired");
    if (check.reason === "bad_token") return errorJson(403, "plan_invalid");
    return errorJson(400, "Send the plan POST /api/train/plan answered, unchanged.");
  }
  // The token signs the task, not the size: Advanced may change it, up to the caller's own most (tuneExamplesMax).
  const size = askedExamples(body.settings, runExamplesMax(caller));
  if (!size.ok) return errorJson(400, size.error);
  if (size.value === undefined && check.plan.settings.examples > runExamplesMax(caller)) {
    return errorJson(400, `Runs here ask for at most ${runExamplesMax(caller)} examples. Change it and send it again.`);
  }
  const ceilings = runCeilings(caller);
  const sized = planSettings(size.value ?? check.plan.settings.examples, ceilings);
  // Another Meta base (TUNE_ANY_BASE), admins only: checked against the Hub again here, whatever the card showed.
  const askedForBase = askedBase((body.settings as { base?: unknown } | undefined)?.base);
  if (!askedForBase.ok) return errorJson(400, askedForBase.error);
  let picked: TuneBase | undefined;
  let gpu: string | undefined;
  if (askedForBase.value) {
    if (!env.tuneAnyBase) return errorJson(404, "not_found");
    if (!caller.isAdmin) return errorJson(403, "Only admins can pick a base.");
    const checked = await resolveBase(askedForBase.value);
    if (!checked.ok) return errorJson(400, checked.error);
    const b = checked.base;
    picked = tuneBaseOf(b);
    gpu = b.gpus[0];
  }
  const stepsMost = maxStepsFor(picked ? { ...sized, base: picked, gpu: gpu! } : sized);
  const steps = askedSteps(body.settings, caller.visitor ? Math.min(stepsMost, caller.visitor.limits.job.maxSteps) : stepsMost);
  if (!steps.ok) return errorJson(400, steps.error);
  // With no steps asked, the default has to fit this base's time too: launch would refuse it after the examples are paid for.
  if (picked && steps.value === undefined && TUNE_STEPS > maxStepsFor({ ...sized, base: picked, gpu: gpu! })) {
    return errorJson(400, "The default steps don't fit this base's time limit. Ask for fewer steps.");
  }
  const settings = { ...planSettings(sized.examples, ceilings, caller.visitor ? Math.min(steps.value ?? TUNE_STEPS, caller.visitor.limits.job.maxSteps) : steps.value), ...(picked ? { base: picked, gpu: gpu! } : {}) };
  const plan: TrainPlanBody = { ...check.plan, settings, cost: planCost(settings) };

  // A build plan starts only while TUNE_FROM_BUILDS is on and the build still offers its own model: the plan's token
  // lasts two hours, and the flag or the build may have changed since it was signed.
  if (plan.source.kind === "build") {
    if (!env.tuneFromBuilds) return errorJson(404, "not_found");
    const build = await buildForTune(plan.source.buildId);
    if (!build || build.productId !== plan.source.productId) return errorJson(404, "build_not_found");
    if (!build.offers) return errorJson(409, "build_not_ready");
  }

  let folder: FolderDraft | null = null;
  if (plan.source.kind === "folder") {
    if (!env.tuneFolder) return errorJson(404, "not_found");
    folder = checkDraft(body.folder, plan.source.hash, runExamplesMax(caller));
    if (!folder || folder.mode !== plan.source.mode) return errorJson(400, "folder_changed");
    if (folder.mode === "write" && !contributorWriterOn()) return errorJson(503, "folder_writer_off");
  }
  if (caller.visitor && plan.source.kind !== "task" && plan.source.kind !== "folder") return errorJson(403, "plan_invalid");

  if (plan.source.kind === "task" || plan.source.kind === "build" || plan.source.kind === "folder") {
    if (!process.env.MODEL_API_KEY) return errorJson(503, "meta_not_configured");
    if (await spendPaused()) return errorJson(503, "paused");
  }

  // One start per plan. The row outlives the plan by the hourly cleanup's hour, so a replay finds it.
  const token = (body.plan as { token: string }).token;
  const until = new Date((body.plan as { exp: string }).exp);
  const key = `tune-run:${token}`;
  if ((await reserveCounter(key, until, 1, 1)) === null) return errorJson(409, "already_started");

  // A visitor's whole start is taken here, before anything is written or billed. Given back when nothing started.
  let owner: string;
  let held: import("@/lib/train/public/limits").Reservation | null = null;
  try {
    owner = await runOwnerId({ ...caller, id: caller.id });
    if (caller.visitor) {
      const { reserveVisitorStart } = await import("@/lib/train/public/open-start");
      const taken = await reserveVisitorStart(
        { trainerId: caller.id, ip: caller.visitor.ip, limits: caller.visitor.limits },
        {
          ownerId: owner,
          source: folder ? (folder.mode === "rows" ? "rows" : "contributor") : "tune_writer",
          rows: folder?.mode === "rows" ? folder.rows.length : settings.examples,
          // planCost prices Muse Wonder. A folder's rows write nothing, and Contributor costs about a tenth or less.
          metaUsd: (folder?.mode === "rows" ? 0 : folder ? plan.cost.metaHighUsd / 10 : plan.cost.metaHighUsd) + plan.cost.scoreHighUsd,
        },
        now,
      );
      if (!taken.ok) {
        await adjustCounter(key, until, -1).catch((e) => console.error("[train/runs] release", e));
        return refusalReply(taken);
      }
      held = taken.reservation;
    }
  } catch (err) {
    await adjustCounter(key, until, -1).catch((e) => console.error("[train/runs] release", e));
    throw err;
  }
  const giveBack = async () => {
    if (!held) return;
    const { releaseReservation } = await import("@/lib/train/public/limits");
    await releaseReservation(held).catch((e) => console.error("[train/runs] release visitor", e));
  };

  try {
    // A build plan's product gets one run a day, counted (and given back on a failed start) in startTuneRun.
    // Advanced's upload choice. startTuneRun checks the flag, the dataset and the product; visitors never get it.
    const autoPublish = caller.isAdmin && (body.settings as { autoPublish?: unknown } | undefined)?.autoPublish !== false;
    const run = await startTuneRun({
      plan,
      callerId: owner,
      autoPublish: autoPublish && !folder,
      visitor: caller.visitor ? { trainerId: caller.id, ip: caller.visitor.ip } : null,
      folder,
    });
    return Response.json(run, { status: 201 });
  } catch (err) {
    await giveBack();
    if (!(err instanceof TuneStartError)) throw err;
    // Nothing started, so the plan may be started again (tomorrow, for product_daily).
    if (err.status >= 500 || err.code === "product_daily") {
      await adjustCounter(key, until, -1).catch((e) => console.error("[train/runs] release", e));
    }
    return errorJson(err.status, err.code, err.body);
  }
});
