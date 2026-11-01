/**
 * The training workflow's steps ("use step"), docs/TRAINING.md "Lifecycle". Each one takes and returns small plain
 * values and is safe to run again: a step can run twice even with no retries left (its invocation can crash after the
 * side effect), so launchStep takes the job's one launch claim before it launches and looks the instance up by name on
 * a retry, and terminateStep treats an instance that is already gone as terminated.
 *
 * Once an instance is launched its id travels in the step results (it isn't secret), so the workflow can terminate it
 * by id even while the database is down. Database errors become RetryableErrors with a 30 s wait, so a short outage
 * doesn't use up a step's retries in seconds (a plain error is retried after 1 s).
 *
 * The plaintext job token is made inside launchStep and goes only into the instance's user data. It never appears in
 * a step's return value (step results are persisted in the workflow's event log), and only its hash is stored. A
 * glimmer-serve job's serving key is derived from that hash (lib/train/serve.ts) and goes only into the user data too.
 */
import { randomBytes } from "node:crypto";
import { FatalError, RetryableError } from "workflow";
import { env } from "@/lib/env";
import { hashToken } from "@/lib/gateway/tokens";
import {
  ensureFilesystem,
  ensureServeFirewall,
  findCacheFilesystem,
  findInstanceByName,
  getInstance,
  LambdaApiError,
  launchInstance,
  listInstances,
  terminateInstances,
  type LambdaFilesystem,
  type LambdaFirewallRuleset,
  type LambdaInstance,
} from "@/lib/train/lambda";
import { decideCheck, isServeRecipe, usableMinutes, type TrainJobRow } from "@/lib/train/logic";
import { recipeById } from "@/lib/train/recipes";
import { serveKeyFor } from "@/lib/train/serve";
import {
  claimLaunch,
  finishJob,
  getJob,
  markLaunched,
  recordEvent,
  releaseLaunch,
  saveLateLaunch,
  setInstanceIp,
  setStatus,
} from "@/lib/train/store";
import { QUANT_IMAGE_FAMILY, QUANT_RECIPE, isTrainTerminal, type Recipe, type TrainCheck, type TrainStatus } from "@/lib/train/types";
import { buildUserData, callbackOrigin, deadlineEpochFor } from "@/lib/train/userdata";

/** The SSH key every launch uses. Its private key stays on the owner's Mac, for debugging; the platform never uses SSH. */
const DEFAULT_SSH_KEY_NAME = "muse-muse-platform";
/** How long a launch waits after a 429 (nothing launched), or after Lambda's listing failed. */
const LAUNCH_RETRY_AFTER = "30s";
/**
 * After a timeout or 5xx the launch may have started an instance anyway. The retry looks it up by name and never
 * launches again, so it waits long enough for Lambda's instance list to show it.
 */
const AMBIGUOUS_LAUNCH_RETRY_AFTER = "2m";
const TERMINATE_RETRY_AFTER = "30s";
/** How long a step waits before trying again after the database didn't answer. */
const DB_RETRY_AFTER = "30s";
/** Lambda statuses that no longer bill and can't be terminated again. */
const GONE: readonly LambdaInstance["status"][] = ["terminated", "terminating"];

/** How a job ends: its final status and the reason shown on the job page. */
export interface TrainEnding {
  status: Extract<TrainStatus, "succeeded" | "failed" | "stopped">;
  reason: string;
}

/** A launched instance whose id the database didn't take yet. saveLaunchStep saves it; it is never launched again. */
export interface UnsavedLaunch {
  action: "save";
  maxMinutes: number;
  instanceId: string;
  /** ISO time of the launch request. */
  launchedAt: string;
}

/**
 * What launchStep did: the job is launched and should be watched, it launched but still has to be saved, or it ended
 * (before anything ran, or while the launch was in flight). `instanceId` is the instance this run launched or adopted,
 * so the workflow can terminate it by id.
 */
export type LaunchResult =
  | { action: "watch"; maxMinutes: number; instanceId: string }
  | UnsavedLaunch
  | ({ action: "end"; instanceId?: string } & TrainEnding);

/** A launch whose instance is saved on the job (or that ended). */
export type SavedLaunch = Exclude<LaunchResult, UnsavedLaunch>;

// ---------------------------------------------------------------------------------------------------------------
// Helpers (not steps)

function sshKeyName(): string {
  return process.env.TRAIN_SSH_KEY_NAME?.trim() || DEFAULT_SSH_KEY_NAME;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type RetryAfter = NonNullable<ConstructorParameters<typeof RetryableError>[1]>["retryAfter"];

/** Runs a call. Any failure becomes a RetryableError, so the step tries again after `retryAfter` instead of 1 s. */
async function retryingAfter<T>(retryAfter: RetryAfter, what: string | null, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw new RetryableError(what ? `${what}: ${message(err)}` : message(err), { retryAfter });
  }
}

/** A database call whose failure is retried after 30 s. */
function fromDb<T>(call: () => Promise<T>): Promise<T> {
  return retryingAfter(DB_RETRY_AFTER, "The database did not answer", call);
}

/** The job's own ending once it has one: a stop request, or a final status the runner already reported. */
function endingOf(job: TrainJobRow): TrainEnding | null {
  if (job.stopRequested) return { status: "stopped", reason: "Stopped by an admin." };
  if (!isTrainTerminal(job.status)) return null;
  const status = job.status as TrainEnding["status"];
  if (status === "succeeded") return { status, reason: "The job finished." };
  if (status === "failed") return { status, reason: job.error || "The job reported a failure." };
  return { status, reason: "Stopped by an admin." };
}

/**
 * The ending to record. A stop request wins, as in decideCheck, then a final status the job already has (the runner's
 * done or failed, which may land after the workflow decided), then what the workflow asked for.
 */
function settle(job: TrainJobRow, asked: TrainEnding): TrainEnding {
  const own = endingOf(job);
  if (!own || own.status === asked.status) return asked;
  return own;
}

/** Lambda answered and launched nothing: a 429 (worth another try) or a 4xx refusal, such as no capacity. */
function launchRefused(err: unknown): err is LambdaApiError {
  return err instanceof LambdaApiError && err.status >= 400 && err.status < 500;
}

/** A timeout, network error, 5xx or missing id, after which the instance may exist anyway. */
function launchAmbiguous(err: unknown): err is LambdaApiError {
  return err instanceof LambdaApiError && (err.status === 0 || err.status >= 500 || err.code === "no-instance-id");
}

/** The launch result for a job that ended while launchStep ran, read fresh so a stop or a callback is seen. */
async function endedWhileLaunching(jobId: string, instanceId?: string): Promise<SavedLaunch> {
  const job = await getJob(jobId);
  const ending = job ? endingOf(job) : null;
  return {
    action: "end",
    ...(ending ?? { status: "failed", reason: "The job ended while it was launching." }),
    ...(instanceId ? { instanceId } : {}),
  };
}

/**
 * Saves a launched or adopted instance on the job, which moves it to "booting". When the job ended meanwhile (a stop,
 * or the sweep failed it while the launch was in flight) the instance is still saved on it with saveLateLaunch, so
 * terminateStep and the sweep terminate it by id and its cost counts, and the launch ends. When the open job already
 * holds another instance, this one is a duplicate: it is terminated at once and the saved one is watched.
 */
async function recordLaunch(
  jobId: string,
  maxMinutes: number,
  launch: { instanceId: string; launchedAt: Date; ip?: string | null },
): Promise<SavedLaunch> {
  if (await markLaunched(jobId, launch)) return { action: "watch", maxMinutes, instanceId: launch.instanceId };
  const job = await getJob(jobId);
  if (job && !isTrainTerminal(job.status) && job.instanceId && job.instanceId !== launch.instanceId) {
    // If Lambda doesn't answer, the sweep terminates it as a second instance under the job's name.
    await terminateInstances([launch.instanceId]).catch((err) =>
      console.error("[train] launch: terminating a duplicate instance failed", message(err)),
    );
    return { action: "watch", maxMinutes: job.maxMinutes, instanceId: job.instanceId };
  }
  await saveLateLaunch(jobId, { instanceId: launch.instanceId, launchedAt: launch.launchedAt });
  return endedWhileLaunching(jobId, launch.instanceId);
}

/**
 * recordLaunch for an instance that exists. When the database doesn't answer, the id goes back to the workflow
 * instead of an error: a retried launchStep could miss the instance in Lambda's listing, and saveLaunchStep retries
 * only the save.
 */
async function keepLaunch(
  jobId: string,
  maxMinutes: number,
  launch: { instanceId: string; launchedAt: Date; ip?: string | null },
): Promise<LaunchResult> {
  try {
    return await recordLaunch(jobId, maxMinutes, launch);
  } catch (err) {
    console.error("[train] launch: saving the instance failed", message(err));
    return { action: "save", maxMinutes, instanceId: launch.instanceId, launchedAt: launch.launchedAt.toISOString() };
  }
}

/**
 * For a launch an earlier attempt claimed whose instance Lambda doesn't list (yet). It is never launched again, which
 * could bill twice: a job that ended or got its instance saved meanwhile is answered from its row, and otherwise the
 * step waits 2 minutes for the listing. Once the retries run out the job fails, and terminateStep and the sweep look
 * for the instance by name.
 */
async function launchInFlight(jobId: string): Promise<SavedLaunch> {
  const job = await fromDb(() => getJob(jobId));
  if (!job || endingOf(job)) return fromDb(() => endedWhileLaunching(jobId));
  if (job.instanceId) return { action: "watch", maxMinutes: job.maxMinutes, instanceId: job.instanceId };
  throw new RetryableError("An earlier attempt may have launched the instance and Lambda doesn't list it yet, so it isn't launched again.", {
    retryAfter: AMBIGUOUS_LAUNCH_RETRY_AFTER,
  });
}

/**
 * True for a recipe that reads a trained adapter from its region's model cache: one with an "adapter" param, such as
 * glimmer-serve and glimmer-publish. The jobs route launches its job in that adapter's region.
 */
function readsAdapter(recipe: Recipe): boolean {
  return recipe.params.some((field) => field.kind === "adapter");
}

/**
 * The region's model cache filesystem for a recipe with usesCache (made once if the account has none there), or null.
 * A recipe that reads an adapter (glimmer-serve, glimmer-publish) gets the one that is already there
 * (findCacheFilesystem), since its adapter is on it: a region with none has no adapter to read. Any failure is a
 * FatalError before the launch claim: nothing is launched, and the create is never retried in a loop.
 */
async function cacheFor(recipe: Recipe, region: string): Promise<LambdaFilesystem | null> {
  if (readsAdapter(recipe)) {
    let found: LambdaFilesystem | null;
    try {
      found = await findCacheFilesystem(region);
    } catch (err) {
      throw new FatalError(`The model cache filesystem in ${region} could not be listed, so nothing was launched: ${message(err)}`);
    }
    if (!found) {
      const use = isServeRecipe(recipe.id) ? "serves" : "reads";
      throw new FatalError(`There is no model cache filesystem in ${region}, so the adapter this job ${use} isn't there and nothing was launched.`);
    }
    return found;
  }
  if (!recipe.usesCache) return null;
  try {
    return await ensureFilesystem(region);
  } catch (err) {
    throw new FatalError(`The model cache filesystem in ${region} could not be found or created, so nothing was launched: ${message(err)}`);
  }
}

/**
 * The region's live demo firewall ruleset (the demo port and SSH, made once if the region has none) for the serve
 * recipe, or null for every other recipe, whose instances keep Lambda's default rules. Any failure is a FatalError
 * before the launch claim, like the cache's.
 */
async function firewallFor(recipe: Recipe, region: string): Promise<LambdaFirewallRuleset | null> {
  if (!isServeRecipe(recipe.id)) return null;
  try {
    return await ensureServeFirewall(region);
  } catch (err) {
    throw new FatalError(`The live demo's firewall ruleset in ${region} could not be found or created, so nothing was launched: ${message(err)}`);
  }
}

/**
 * The error's message with the job token and the serving key blanked out, for a launch error that ends up in the
 * job's error and the run log.
 */
function launchErrorText(err: unknown, token: string, serveKey?: string): string {
  let text = err instanceof Error ? err.message : `Lambda refused the launch: ${String(err)}`;
  if (token) text = text.split(token).join("[job token]");
  if (serveKey) text = text.split(serveKey).join("[serving key]");
  return text;
}

/**
 * Terminates the job's saved instance (unless it is `done`, which the caller already terminated), then anything else
 * Lambda lists under its name that is still live: an instance a crashed launch never saved, or a duplicate. Returns how
 * many of those others it terminated.
 */
async function terminateJobInstances(job: TrainJobRow, done?: string): Promise<number> {
  if (job.instanceId && job.instanceId !== done) await terminateInstances([job.instanceId]);
  let listed: LambdaInstance[];
  try {
    listed = await listInstances();
  } catch (err) {
    // With the known instance terminated, a duplicate is left to the sweep, which terminates instances of ended jobs.
    // Without a known id the listing is the only way to find an unsaved launch, so that case is retried.
    if (!job.instanceId && !done) throw err;
    console.error("[train] terminate: listing instances failed", message(err));
    return 0;
  }
  const known = new Set([job.instanceId, done].filter(Boolean));
  const others = listed.filter((i) => i.name === job.instanceName && !known.has(i.id) && !GONE.includes(i.status)).map((i) => i.id);
  await terminateInstances(others);
  return others.length;
}

// ---------------------------------------------------------------------------------------------------------------
// Steps

/**
 * Launches the job's instance, once. A job that was stopped or already ended isn't launched. An instance already
 * listed under the job's name (an earlier attempt launched it and crashed before saving) is adopted: its user data
 * holds the token whose hash was stored before that launch. Otherwise a new token is made and claimLaunch stores its
 * hash and claims the job's one launch; only the attempt holding the claim sends a launch, so a retry or a duplicate
 * delivery can only adopt the instance or wait for Lambda's listing, never launch a second one.
 *
 * A recipe with usesCache gets its region's cache filesystem first (ensureFilesystem, before the claim; a failure is a
 * FatalError) and launches with it mounted, its mount path in job.json as cacheDir. A glimmer-serve or glimmer-publish
 * job (which the jobs route put in its adapter's region) mounts only the cache already there (findCacheFilesystem,
 * since its adapter is on it; none is a FatalError). A glimmer-serve job also gets the region's live demo firewall
 * ruleset (ensureServeFirewall, before the claim, a failure fatal) attached at launch, and its serving key (serveKeyFor
 * the new token's hash) in job.json as serveKey.
 * job.json's deadlineEpoch is stamped before the launch request from usableMinutes (the time limit, or the dollar limit
 * at the job's price when that runs out first), so the runner's deadline is never after decideCheck would stop the job.
 *
 * Lambda refusing the launch (a 4xx other than 429, such as no capacity) gives the claim back and is a FatalError, so
 * it is never retried; a 429 gives the claim back and is retried after 30 s; a timeout or 5xx keeps the claim and is
 * retried after 2 minutes, when the retry looks the instance up by name. Once the instance exists its id is returned
 * even when the database can't save it (action "save").
 */
export async function launchStep(jobId: string): Promise<LaunchResult> {
  "use step";
  const job = await fromDb(() => getJob(jobId));
  if (!job) throw new FatalError(`Training job ${jobId} was not found.`);
  const before = endingOf(job);
  if (before) return { action: "end", ...before };
  if (job.instanceId) return { action: "watch", maxMinutes: job.maxMinutes, instanceId: job.instanceId };

  const recipe = recipeById(job.recipe);
  if (!recipe) throw new FatalError(`The recipe "${job.recipe}" doesn't exist anymore.`);
  const origin = callbackOrigin(env.platformUrl);
  if (!origin) {
    throw new FatalError("The platform URL isn't public https, so the instance couldn't report back. Nothing was launched.");
  }

  const existing = await retryingAfter(LAUNCH_RETRY_AFTER, "Looking for the job's instance failed", () =>
    findInstanceByName(job.instanceName),
  );
  if (existing) {
    if (!job.tokenHash) {
      throw new FatalError(`An instance named ${job.instanceName} already exists, but this job never launched it.`);
    }
    // Lambda doesn't say when it launched. createdAt is earlier than the launch request, so the time and dollar limits
    // and the cost are never measured short.
    return keepLaunch(jobId, job.maxMinutes, { instanceId: existing.id, launchedAt: job.launchedAt ?? job.createdAt, ip: existing.ip });
  }
  if (job.tokenHash) return launchInFlight(jobId);

  const cache = await cacheFor(recipe, job.region);
  const firewall = await firewallFor(recipe, job.region);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const serveKey = isServeRecipe(recipe.id) ? serveKeyFor(jobId, tokenHash) : undefined;
  // Stamped before requestedAt below, which becomes launchedAt, so the runner stops no later than the time limit, or
  // than the dollar limit when that runs out first at the job's price.
  const runnable = usableMinutes({ maxMinutes: job.maxMinutes, maxUsd: job.maxUsd }, job.priceCentsPerHour);
  const deadlineEpoch = deadlineEpochFor(runnable);
  let userData: string;
  try {
    userData = buildUserData({
      jobId,
      callbackBase: `${origin}/api/train/jobs/${jobId}`,
      token,
      recipe,
      params: job.params,
      maxMinutes: job.maxMinutes,
      deadlineEpoch,
      ...(cache ? { cacheDir: cache.mountPoint } : {}),
      ...(serveKey ? { serveKey } : {}),
    });
  } catch (err) {
    throw new FatalError(`The instance's setup script could not be built: ${message(err)}`);
  }
  const claimed = await fromDb(() => claimLaunch(jobId, tokenHash, `Launching a ${job.instanceType} in ${job.region}.`));
  if (!claimed) return launchInFlight(jobId);

  // Stamped before the call, so the saved launch time is never later than the real one.
  const requestedAt = new Date();
  let instanceId: string;
  try {
    instanceId = await launchInstance({
      name: job.instanceName,
      instanceType: job.instanceType,
      region: job.region,
      userData,
      sshKeyName: sshKeyName(),
      tags: [
        { key: "muse-muse", value: "train" },
        { key: "muse-muse-job", value: jobId },
      ],
      ...(cache ? { fileSystemNames: [cache.name] } : {}),
      ...(firewall ? { firewallRulesetIds: [firewall.id] } : {}),
      ...(job.recipe === QUANT_RECIPE ? { imageFamily: QUANT_IMAGE_FAMILY } : {}),
    });
  } catch (err) {
    // Step errors are kept in the run's log and become the job's error, so the token and key are blanked out of them.
    const text = launchErrorText(err, token, serveKey);
    if (launchRefused(err)) {
      // Nothing launched, so the claim goes back: a retry after a 429 can launch, and terminateStep knows no
      // instance can exist. If this write fails the claim stays, and the job fails safe without launching.
      await releaseLaunch(jobId, tokenHash).catch((e) => console.error("[train] launch: releasing the claim failed", message(e)));
      if (err.status === 429) throw new RetryableError(text, { retryAfter: LAUNCH_RETRY_AFTER });
      throw new FatalError(text);
    }
    if (launchAmbiguous(err)) throw new RetryableError(text, { retryAfter: AMBIGUOUS_LAUNCH_RETRY_AFTER });
    throw new FatalError(text);
  }

  return keepLaunch(jobId, job.maxMinutes, { instanceId, launchedAt: requestedAt });
}
// Only the attempt holding the launch claim can launch, so a retry adopts the instance or waits for the listing. The
// retries give an ambiguous launch about 6 minutes to show up, and a 429 (which gives the claim back) a few more tries.
launchStep.maxRetries = 3;

/**
 * Saves an instance launchStep launched but the database didn't take. It never launches. Database errors are retried
 * every 30 s for about 10 minutes; if they never clear, the workflow still holds the instance id and terminateStep
 * terminates it by id.
 */
export async function saveLaunchStep(jobId: string, launch: UnsavedLaunch): Promise<SavedLaunch> {
  "use step";
  return fromDb(() =>
    recordLaunch(jobId, launch.maxMinutes, { instanceId: launch.instanceId, launchedAt: new Date(launch.launchedAt) }),
  );
}
saveLaunchStep.maxRetries = 20;

/**
 * Refreshes the instance's status and IP from Lambda, then asks decideCheck what to do. When the job already has an
 * ending (a stop request, or the runner's done or failed) Lambda isn't asked. When Lambda doesn't answer, the limits
 * and heartbeats are still checked from the database, and the instance is checked again next time. When the database
 * doesn't answer the check is retried after 30 s; a check that still fails doesn't end the watch (see the workflow).
 */
export async function checkStep(jobId: string): Promise<TrainCheck> {
  "use step";
  const job = await fromDb(() => getJob(jobId));
  if (!job) return { action: "terminate", status: "failed", reason: "The job's record is gone." };
  if (endingOf(job)) return decideCheck(job, null, new Date());
  if (!job.instanceId) return { action: "terminate", status: "failed", reason: "The job has no instance to check." };

  let instance: LambdaInstance | null;
  try {
    instance = await getInstance(job.instanceId);
  } catch (err) {
    console.error("[train] check: Lambda did not answer", message(err));
    return decideCheck(job, { status: "active" }, new Date());
  }
  if (instance?.ip && instance.ip !== job.instanceIp) {
    // The IP is only shown on the job page, so a failed write doesn't hold up the check.
    await setInstanceIp(jobId, instance.ip).catch((err) => console.error("[train] check: saving the IP failed", message(err)));
  }
  return decideCheck(job, instance, new Date());
}
checkStep.maxRetries = 3;

/**
 * Terminates every live instance of the job: `instanceId` (the one the workflow launched) first, before anything is
 * read, so a database outage can't keep it billing; then the saved id and anything listed under the job's name (one
 * that is already gone counts as terminated). Then records the ending with finishJob: terminatedAt, the final cost,
 * finishedAt, the status and the error. Safe to run again: finishJob keeps the first terminatedAt. Returns the final
 * status. When it terminated an instance the launch never saved, the job's clock starts at createdAt so its cost counts.
 *
 * When a launch was sent but no instance is known or listed, Lambda may simply not list it yet: the job ends without
 * terminatedAt and with its clock at createdAt, so it keeps its GPU slot and its cost counts until the sweep has looked.
 *
 * Lambda and database errors are retried every 30 s, about 10 minutes in all.
 */
export async function terminateStep(jobId: string, ending: TrainEnding, instanceId?: string): Promise<TrainStatus> {
  "use step";
  if (instanceId) await retryingAfter(TERMINATE_RETRY_AFTER, null, () => terminateInstances([instanceId]));
  const job = await fromDb(() => getJob(jobId));
  // The sweep terminates any mm-train- instance whose job is missing.
  if (!job) return ending.status;
  const others = await retryingAfter(TERMINATE_RETRY_AFTER, null, () => terminateJobInstances(job, instanceId));
  const final = settle(job, ending);

  if (!instanceId && !job.instanceId && job.tokenHash && others === 0 && !job.terminatedAt) {
    if (!isTrainTerminal(job.status)) {
      const note = "Lambda doesn't list an instance for this launch yet, so the 5-minute sweep will look for it and terminate it.";
      const ended = await fromDb(() =>
        setStatus(jobId, final.status, {
          message: `${final.reason} ${note}`,
          set: { launchedAt: job.createdAt, ...(final.status === "failed" ? { error: job.error || final.reason } : {}) },
        }),
      );
      if (ended) return final.status;
    } else if (job.launchedAt) {
      // Already ended that way (the sweep's rule for a stuck launch): the sweep keeps looking for the instance.
      return final.status;
    }
  }

  const unsaved = (others > 0 || instanceId) && !job.launchedAt ? { launchedAt: job.createdAt } : {};
  const row = await fromDb(() => finishJob(jobId, { ...final, terminatedAt: new Date(), ...unsaved }));
  return row?.status ?? final.status;
}
terminateStep.maxRetries = 20;

/**
 * For when terminateStep ran out of retries: ends the job without terminatedAt, so the sweep (which terminates any
 * instance whose job has ended, and then stamps terminatedAt) takes over within 5 minutes. An instance only the
 * workflow knew about (`instanceId`, never saved) is saved first, so the sweep can terminate it by id. Database errors
 * are retried every 30 s, about 10 minutes in all. Returns the final status.
 */
export async function abandonStep(jobId: string, ending: TrainEnding, instanceId?: string): Promise<TrainStatus> {
  "use step";
  const job = await fromDb(() => getJob(jobId));
  if (!job) return ending.status;
  if (instanceId && !job.instanceId) {
    await fromDb(() => saveLateLaunch(jobId, { instanceId, launchedAt: job.launchedAt ?? job.createdAt }));
  }
  const final = settle(job, ending);
  const note = "Lambda did not confirm the terminate, so the 5-minute sweep will terminate the instance.";
  // A launch that was sent counts from createdAt, so the job keeps its GPU slot until the sweep stamps terminatedAt.
  const clock = !job.launchedAt && !instanceId && job.tokenHash ? { launchedAt: job.createdAt } : {};
  await fromDb(() =>
    setStatus(jobId, final.status, {
      message: `${final.reason} ${note}`,
      set: { ...clock, ...(final.status === "failed" ? { error: job.error || final.reason } : {}) },
    }),
  );
  await fromDb(() => recordEvent(jobId, { type: "log", text: note }));
  return ((await fromDb(() => getJob(jobId))) ?? job).status;
}
abandonStep.maxRetries = 20;
