# Fine-tuning on Lambda

Admin-only fine-tuning jobs that run on the owner's Lambda Cloud account. One job is one GPU instance: the platform launches it with a cloud-init script, the instance trains and reports back, and the platform always terminates it. Lambda bills by the hour from launch until termination, so termination is enforced from three sides: the job's workflow, the job's own "done" callback, and a sweep every 5 minutes. A job only starts while that sweep is configured and has run lately.

Shared types are in `lib/train/types.ts`. Tables are `training_jobs` and `training_events` in `lib/db/schema.ts` (migration `drizzle/0002_training_jobs.sql`), plus `training_datasets` and `training_jobs.eval_summary` (migration `drizzle/0003_training_datasets.sql`), and `training_jobs.serve_endpoint` (migration `drizzle/0004_serve_endpoint.sql`).

A job can train on a dataset Muse Spark 1.3 wrote for a task (see Datasets). A recipe that does, such as `glimmer-lora`, answers the dataset's held-out prompts with the base and the tuned model and sends them back as eval items; once the GPU is shut down, Muse Spark 1.3 judges them (see Judging). A recipe can also keep its venv and model weights on a Lambda filesystem in the region (see Model cache). A trained adapter can then be served for a set number of minutes by the `glimmer-serve` recipe, so anyone on its public result page can compare the base and the tuned model live (see Live demo (glimmer-serve)).

## Secrets and trust

- `LAMBDA_API_KEY` stays on the platform (`env.lambdaApiKey`). It is never written into user data, an instance, a sandbox or a product.
- Each job gets a random job token (32 bytes, base64url). The instance gets it in its user data. The platform stores only `hashToken(token)` from `lib/gateway/tokens.ts` in `training_jobs.token_hash`. The token works only for that job's callback and upload routes, and only until 15 minutes after the job ends.
- User data is visible to anyone with access to the Lambda account. That is the owner, so the job token there is fine, and so is a glimmer-serve job's serving key, which is derived from the token's hash (see Live demo (glimmer-serve)). Nothing else secret goes into it.
- Every launch uses the SSH key `muse-muse-platform` (`TRAIN_SSH_KEY_NAME`). Its private key lives only on the owner's Mac at `~/.ssh/muse-muse-lambda`, for debugging. The platform never needs SSH.
- Creating and stopping jobs is admin only (`requireAdminOrAutomation`, so scripts can use `AUTOMATION_SECRET`).

## Limits

| Limit | Default | Where |
|---|---|---|
| Jobs holding a GPU at once | 1 | `TRAIN_MAX_ACTIVE` |
| Estimated training spend per day, all jobs | $20 | `TRAIN_DAILY_USD` |
| Ceiling on one job's dollar limit | $5 | `TRAIN_JOB_MAX_USD` |
| Ceiling on one job's time limit | 120 min | `TRAIN_JOB_MAX_MINUTES` |
| Boot grace: no heartbeat yet | 25 min after launch | `lib/train/logic.ts` |
| Silence after the first heartbeat | 10 min | `lib/train/logic.ts` |
| A watched command with no output (`ctx.run(stall_seconds=...)`) | reported stalled once, then no heartbeats until it writes again: 20 min for every glimmer-lora build step and the child | `STALL_SECONDS` in `lib/train/recipes/glimmer.ts` |
| Callback body | 16 KB (an eval callback 64 KB), log text cut to 4 KB, eval texts to 3,500 characters | events route |
| Callbacks per job (heartbeat, progress, log, artifact, eval; never done or failed) | 120 a minute, then 429 `rate_limited` | events route |
| Artifacts per job | 50, then 409 `artifact_limit` | `ARTIFACTS_MAX` in `lib/train/store.ts` |
| Eval items per job | 60, then 409 `eval_limit` | `EVALS_MAX` in `lib/train/logic.ts` |
| Dataset pages per job | 100 items a page, 120 pages an hour, then 429 `rate_limited` | dataset route |
| One upload | 1 GB, one blob per grant | upload route |
| Upload grants per job | 20 an hour, and 5 GB declared an hour | upload route |
| Upload grant lifetime | 5 min plus 1 MB a second of the declared size, at most 30 min, never past `launchedAt + maxMinutes + 15 min` | upload route |
| Sweep: time and dollar backstop | `maxMinutes + 10 min`, `maxUsd * 1.1` | `lib/train/sweep.ts` |
| Sweep: stuck before launch | 15 min in queued or launching | `lib/train/sweep.ts` |
| Sweep: launched job left open (its workflow is gone) | 30 min past its time limit | `lib/train/sweep.ts` |
| Launch gate: the sweep's last good run | 15 min | `SWEEP_FRESH_MS` in `app/api/train/shared.ts` |
| Live demo: minutes it serves | 10 to 120 (default 30), plus 15 to boot and load the model | `SERVE_MINUTES_MIN`, `SERVE_MINUTES_MAX`, `SERVE_BOOT_MINUTES` in `lib/train/logic.ts` |
| Live demo: prompts per client IP | 5 in a fixed 10-minute window, then 429 `rate_limited` (`scope` "ip") | `PER_IP` in `app/api/lab/[id]/try/route.ts` |
| Live demo: prompts per demo, from everyone | 60 a clock hour, then 429 `rate_limited` (`scope` "demo") | `PER_DEMO_HOUR`, same route |
| Live demo: prompts at once | 1 per demo, then 409 `busy` (the platform's slot, and a lock on the GPU) | `takeDemoSlot` in `lib/train/store.ts`, `SERVE_PY` |
| Live demo: one prompt | 600 characters, trimmed | the route's `PROMPT_MAX`, `PROMPT_MAX_CHARS` in `lib/train/recipes/serve.ts` |
| Live demo: one answer | 400 new tokens a model, 120 s for both, each cut to 8,000 characters for the browser | `SERVE_MAX_NEW_TOKENS`, `serveTiming.answerMs` and `ANSWER_TEXT_MAX` in `lib/train/serve.ts` |

A job's limits are what the admin asked for, capped by the ceilings; the recipe's defaults (capped the same way) fill in a limit the admin didn't ask for (`clampLimits`). So a recipe can run past its own defaults when the admin asks and the ceilings allow it. `usableMinutes(limits, priceCentsPerHour)` is how long a job can run before either limit stops it: the time limit, or less when the dollar limit runs out first (every started minute counts in full, so $4.29 at $4.29 an hour allows 59 minutes). The runner's deadline is stamped from it (see User data). Cost is `priceCentsPerHour / 100 * hours since launchedAt` (until `terminatedAt`), rounded up to the minute. A job is terminated when its time or dollar limit is reached. When a launch was never saved (Lambda timed out, or the database didn't answer), its clock starts at `createdAt`, which is earlier than the launch, so the limits and the cost are never measured short.

Jobs holding a GPU (compared with `TRAIN_MAX_ACTIVE`) are every job that hasn't ended plus every ended job with `launchedAt` set and no `terminatedAt`. Today's committed spend (compared with `TRAIN_DAILY_USD`) counts every unfinished job at its full dollar limit.

## Lifecycle

```text
POST /api/train/jobs (admin)          -> refused unless the sweep is configured and ran lately (see Routes),
                                         then row "queued", token not made yet, workflow started
trainJob workflow (lib/train/workflow.ts):
  launchStep   launches at most once per job: an instance already listed under instanceName is adopted
               (clock at createdAt); otherwise, for a usesCache recipe, ensureFilesystem(region) (see Model
               cache), then make the token and claimLaunch (queued -> "launching" with the token's hash, in one
               guarded update; only the holder of the claim launches); launch with user data (and the cache
               filesystem mounted), its deadlineEpoch stamped just before the request; save instanceId and
               launchedAt (the time of the request), status "booting".
               429: the claim is given back, retried after 30 s. Other 4xx: claim given back, FatalError.
               Timeout or 5xx: the claim is kept and the retry (2 min later) only adopts the instance by name
               or waits for it, never launches again. maxRetries 3.
               The instance id is returned to the workflow (it isn't secret), so it can terminate by id.
               Database didn't take the instance -> {action: "save"} and saveLaunchStep retries only the save.
               Job ended while the launch was in flight -> the instance is saved anyway (saveLateLaunch) and
               the workflow terminates it. Open job already holding another instance -> this one is
               terminated at once.
  loop every 30 s:
    checkStep  refresh instance status and IP from Lambda, then decideCheck(job, instance, now)
               -> wait | terminate(status, reason). A check that fails (the database stayed down through its
               30 s retries) doesn't end the watch; the next poll tries again.
  terminateStep terminate the workflow's instance id first, before reading the database; then the saved id
               and anything live under instanceName (an instance that is already gone counts as terminated);
               then finishJob. A launch that was sent but that Lambda doesn't list yet ends the job without
               terminatedAt and with its clock at createdAt, so it keeps its GPU slot until the sweep looks.
               Lambda and database errors retried every 30 s for about 10 minutes.
  abandonStep  if terminateStep never got through: ends the job without terminatedAt (saving an instance
               only the workflow knew), so the sweep terminates it. Retried every 30 s for about 10 minutes.
               If both fail, both are tried again every minute for an hour.
  judging      only when terminate returned "succeeded" and the job has eval items: judgePlanStep, judgeStep
               4 at once, saveEvalSummaryStep (lib/train/judge.ts, see Judging). Never changes the status.
Instance (runner.py) -> POST /api/train/jobs/{id}/events with the job token:
  heartbeat (every 60 s), progress, log, artifact, eval (before done), serving (glimmer-serve only), done, failed
Instance (runner.py) -> GET /api/train/jobs/{id}/dataset?part=train|eval&page=N with the job token (see Datasets)
  "done" and "failed" set the final status at once and also ask Lambda to terminate right away (best effort),
  and so does any other callback from an instance whose job already ended but isn't terminated
Every 5 min, /api/cron/train-sweep (CRON_SECRET): see "The sweep"
```

`decideCheck` order: stop requested -> "stopped"; status already succeeded/failed by callback -> terminate with that status; instance terminated or preempted outside the platform -> "failed"; time limit -> "failed" ("Reached the N-minute limit"); dollar limit -> "failed"; no heartbeat 25 min after launch -> "failed"; no heartbeat for 10 min after the first -> "failed"; instance "unhealthy" -> "failed"; else wait.

The workflow loop also stops after `maxMinutes + 15` minutes no matter what, and then terminates.

`finishJob` decides the final status in the same SQL statement, from the row as it is then: a stop request makes it "stopped", a job that already ended keeps its own status (a done that landed while the caller was terminating wins), and only an open job takes the status the caller asked for. It keeps the first `terminatedAt`, and logs the termination once however many calls overlap.

### The sweep (lib/train/sweep.ts)

The backstop for a job whose workflow is gone (a database outage it couldn't ride out, `MAX_EVENTS_EXCEEDED`, a queue outage). It lists every live instance on the account but only ever touches the platform's: those named `mm-train-*`, and those a job claims by its saved instance id or the `muse-muse-job` tag (so a renamed instance is still found). Any other instance on the account is left alone.

- An `mm-train-*` instance that no job claims, an instance whose job ended, and a second instance for the same job: terminated.
- An open job's instance, in this order: an admin asked to stop (the job ends as "stopped"); past `maxMinutes + 10 min` or `maxUsd * 1.1`; then decideCheck's own rules with the limits left out (no heartbeat 25 min after launch, 10 min of silence, preempted or unhealthy). The job ends as "failed".
- Jobs stuck in queued or launching for 15 min are failed, with any instance under their name. A stuck launch that holds the launch claim but has no instance listed yet keeps its GPU slot (no `terminatedAt`, clock at `createdAt`) until a later sweep finds the instance or, 10 min after it ended, calls it gone.
- A launched job left open 30 min past its time limit is failed.
- An ended job with no `terminatedAt` whose instance isn't listed: a saved id is asked about with GET /instances/{id} first (the listing can lag); `terminatedAt` is stamped once it is gone. With no saved id, only 10 min after the job ended.
- An instance found running after its job was recorded as terminated (a launch Lambda listed late): terminated, and `extendTermination` moves `terminatedAt` to now and counts that time, so the job page and the daily cap include it.
- When GET /instances fails, instances whose ids jobs saved are still terminated by id: ended jobs without `terminatedAt`, and open jobs the rules above say to end. An instance no job saved waits for the listing.
- A run whose listing answered is noted (`recordSweepOk`, one `rate_limits` row a minute under `train-sweep-ok`), for the launch gate.

## Instance names and tags

- Name: `mm-train-<first 8 chars of job id>-<recipe>`, under 64 chars. Stored in `training_jobs.instance_name` when the row is created. Launch finds instances by this name; the sweep by this name, the saved instance id or the job tag.
- Tags: `muse-muse: train`, `muse-muse-job: <job id>`. The sweep uses the job tag only to find a job's instance, never as a reason to touch an instance no job claims.

## User data (lib/train/userdata.ts)

`buildUserData({ jobId, callbackBase, token, recipe, params, maxMinutes, deadlineEpoch?, cacheDir?, serveKey? })` returns a `#cloud-config` document:

- `write_files`:
  - `/opt/muse/job.json` (0600): `{ jobId, callbackBase, token, params, maxMinutes, recipe, deadlineEpoch }`, plus `cacheDir` (the cache filesystem's mount path) for a recipe with `usesCache`, and `serveKey` for a glimmer-serve job (see Live demo (glimmer-serve)). `deadlineEpoch` is the Unix second the runner must be done by: `launchStep` stamps it just before the launch request as `deadlineEpochFor(usableMinutes(...))`, so it is never after `launchedAt` plus the time the job's limits allow, and decideCheck never stops a job before it. Without one it defaults to now plus `maxMinutes`
  - `/opt/muse/runner.py` (0755): `RUNNER_PY` from `lib/train/recipes/runner.ts`
  - `/opt/muse/recipe.py` (0644): the recipe's script
- `runcmd`: start `python3 /opt/muse/runner.py /opt/muse/job.json` detached, logging to `/var/log/muse-job.log`.

`callbackBase` is `${env.platformUrl}/api/train/jobs/${jobId}`. Creating a job is refused when `env.platformUrl` isn't public (`publicHost` from `lib/sandbox/policy.ts` is null), since the instance couldn't reach a local platform. The document must stay under 1 MB and must not contain `LAMBDA_API_KEY` or any other env secret.

## Runner and recipes (lib/train/recipes)

Python files are kept as TypeScript string constants (`String.raw`), so Vercel bundles them with no file tracing. Never use `${` or backticks in the Python.

- `runner.ts` exports `RUNNER_PY`. It uses only the Python standard library. It reads job.json, starts a heartbeat thread (every 60 s), imports `recipe.py` and calls `run(ctx)`. It then posts `done` with the returned dict as metrics, or `failed` with the last 3 KB of the traceback. Callbacks retry 3 times with backoff and never print the token. `ctx` has:
  - `params`, `job_id`, `max_minutes`
  - `deadline`: the Unix time the job must be done by, job.json's `deadlineEpoch` (or `maxMinutes` from when the runner started, without one)
  - `log(text)`
  - `progress(step=None, total_steps=None, loss=None, message=None)`
  - `run(cmd, timeout=None, check=False, env=None, on_line=None, on_event=None, stall_seconds=None)`, which runs a shell command in `work_dir`, streams it to the log and posts its last lines as a log event. It reads the output in chunks rather than lines, so a progress bar's carriage-return redraws count as output, and keeps the text after a line's last carriage return. `env` adds variables for the command, and `on_line(line)` sees each output line as it arrives (its errors are logged, never raised). `on_event(line)` does the same for the lines the command writes to a pipe of its own, whose file descriptor is in its `MUSE_EVENT_FD`: a channel a progress bar on stderr can't write into. With `stall_seconds`, the command is watched: once it has written nothing on either for that long, the heartbeat thread posts one "Stalled: no output for N minutes from $ <cmd>" log and sends no more heartbeats until it writes again (the first one back says "No longer stalled"), so the platform's 10-minute silence rule ends a stuck job instead of it billing to its limit. The result is a `subprocess.CompletedProcess` with the last lines as `stdout` and `timed_out` set when the timeout killed it. With `check=True` a non-zero exit raises
  - `upload(path, name, kind)`, which asks `POST {callbackBase}/upload` for a Blob client token, PUTs the file to Vercel Blob and posts an `artifact` event. It returns None when the platform answers 503 (no storage). It declares the type `mimetypes` names when the platform takes it (`UPLOAD_TYPES`, the same list as `TRAIN_UPLOAD_TYPES` in `lib/train/types.ts`) and `application/octet-stream` otherwise. A grant covers one blob that can't be written twice, so when Blob refuses a retried PUT or multipart complete (the first try may have landed before its answer was lost) it asks for a fresh grant and uploads once more.
  - `work_dir`
  - `cache_dir`: the mounted cache filesystem (job.json's `cacheDir`) once it is a folder, waiting up to 60 s for the mount (`cacheWaitSeconds` in job.json for tests), or None (with a log line) when there is none
  - `get_json(path_and_query)`: GETs `callbackBase + path` with the job token, the same retries as callbacks (429 and 5xx, 3 times) and no redirects. A status of 300 or more raises `PlatformError` (with `.status`)
  - `dataset(part)`: pages `GET {callbackBase}/dataset?part=train|eval&page=N` from page 0 until `nextPage` is null and returns every item. A job with no dataset answers 404 and a dataset that isn't ready 409, which raise
  - `dataset_title`: the dataset's title from the pages `dataset()` read (None before that, or when a page has none)
  - `serve_key`: job.json's `serveKey` for a glimmer-serve job, else None. The runner blanks it out of every log line as `[serve key]`, as it does the token
  - `serving(port, cert_sha256, model, adapter_job_id)`: posts `{ type: "serving", port, certSha256, model, adapterJobId }` (the fingerprint lowercased, without colons) and returns True when the platform took it. Raises ValueError for a port or a fingerprint that isn't one, before sending
  - `eval(index, prompt, reference, base, tuned)`: posts `{ type: "eval", ... }` with each text field cut to 3,500 characters (and the longest shortened further if multibyte text would push the body past 15 KB). At most 60 per job; later calls only log and return False. Recipes send them before returning, so they land before "done"
- `smoke.ts` exports `SMOKE_PY`. It reads `nvidia-smi` (GPU name, memory), checks that torch sees CUDA and runs a matmul on the GPU, and reads free disk. It also checks HTTPS reachability of huggingface.co and pypi.org, and sends 3 progress ticks 20 s apart. It returns those as metrics. With `params.allowNoGpu` truthy it tolerates a missing GPU, which is how the local test runs it.
- `glimmer.ts` exports `GLIMMER_PY` (see "glimmer-lora recipe").
- `serve.ts` exports `SERVE_PY`, glimmer-lora's Python with the demo server after it (see Live demo (glimmer-serve)).
- `index.ts` exports `RECIPES: Recipe[]` and `recipeById(id)`.

### smoke recipe

GPUs, in order: `gpu_1x_a10`, `gpu_1x_rtx6000`, `gpu_1x_a6000`, `gpu_1x_a100_sxm4`, `gpu_1x_a100`. Defaults: 30 minutes, $1. Params: none (`allowNoGpu` is internal).

## Lambda client (lib/train/lambda.ts)

Base `https://cloud.lambda.ai/api/v1`, `Authorization: Bearer env.lambdaApiKey`, 20 s timeout per call, one retry on 429 or 5xx with a 2 s wait (a launch, a filesystem create or a firewall ruleset create retries only a 429). Errors throw `LambdaApiError(status, code, message)`. The key is never logged. Filesystems are only ever listed and created, never deleted (see Model cache). Firewall rulesets are only ever listed, created and patched, only the platform's own (by name), and never deleted (see Live demo (glimmer-serve)).

```ts
export interface LambdaInstanceType { name: string; description: string; priceCentsPerHour: number; gpus: number; regionsWithCapacity: string[] }
export interface LambdaInstance { id: string; name: string | null; status: "booting" | "active" | "unhealthy" | "terminated" | "terminating" | "preempted"; ip: string | null; instanceType: string; region: string; tags?: Array<{ key: string; value: string }> }
export async function listInstanceTypes(): Promise<LambdaInstanceType[]>              // GET /instance-types
export async function listInstances(): Promise<LambdaInstance[]>                      // GET /instances
export async function getInstance(id: string): Promise<LambdaInstance | null>         // GET /instances/{id}, null on 404
export async function findInstanceByName(name: string): Promise<LambdaInstance | null> // not terminated, from listInstances
export async function launchInstance(input: { name: string; instanceType: string; region: string; userData: string; sshKeyName: string; tags: Array<{ key: string; value: string }>; fileSystemNames?: string[]; firewallRulesetIds?: string[] }): Promise<string> // POST /instance-operations/launch, returns the instance id; file_system_names and firewall_rulesets ([{ id }]) sent only when non-empty
export async function terminateInstances(ids: string[]): Promise<void>               // POST /instance-operations/terminate; a 404 or already-terminated is success
export function pickGpu(choices: GpuChoice[], types: LambdaInstanceType[], asked?: string, preferRegions: string[] = [], onlyRegion?: string): { instanceType: string; region: string; priceCentsPerHour: number } | null
// listFilesystems, ensureFilesystem, findCacheFilesystem, cacheRegions, cacheFilesystemName: see Model cache
// listFirewallRulesets, ensureServeFirewall, serveFirewallName, serveFirewallRules: see Live demo (glimmer-serve)
```

`pickGpu` takes the asked type if it is one of the choices and has capacity; otherwise it takes the first choice with capacity in one of `preferRegions` (regions that already hold the model cache), then the first choice with capacity anywhere. Within a type, a preferred region comes first, then regions starting with `us-`. A type with no positive price is skipped. With `onlyRegion`, capacity in any other region doesn't count (a glimmer-serve job launches only where its adapter's cache is).

## Store and logic

`lib/train/store.ts` (database) and `lib/train/logic.ts` (pure, unit tested):

```ts
// logic.ts
export const BOOT_GRACE_MS = 25 * 60_000; export const SILENCE_MS = 10 * 60_000; export const POLL_MS = 30_000
export function estimateCostUsd(job: { priceCentsPerHour: number; launchedAt: Date | null; terminatedAt: Date | null }, now: Date): number
export function clampLimits(recipe: Pick<Recipe, "defaultMaxMinutes" | "defaultMaxUsd">, asked: Partial<TrainLimits>, ceilings: TrainLimits): TrainLimits
export function usableMinutes(limits: TrainLimits, priceCentsPerHour: number | null): number // before the time or dollar limit stops it
export function runEstimate(recipe, params, instanceType, cached): RunEstimate | null // glimmer-lora only; GLIMMER_STEP_SECONDS, GLIMMER_OVERHEAD_MINUTES
export function runFitProblem(estimate: RunEstimate, usable: number, gpuLabel: string): string | null // the jobs route's 400
export function validateParams(recipe: Recipe, raw: unknown): { ok: true; value: Record<string, string | number> } | { ok: false; error: string } // a "dataset" param takes only a uuid, lowercased
export function decideCheck(job: JobState, instance: { status: LambdaInstance["status"] } | null, now: Date): TrainCheck
export function instanceNameFor(jobId: string, recipe: RecipeId): string
export function toJobView(row, now): TrainJobView
// store.ts
createJob, getJob, listJobs(limit), listEvents(jobId, afterId?), recordEvent(jobId, body), setStatus,
markLaunched(jobId, { instanceId, launchedAt, ip? }) (open jobs only; never replaces another saved instance),
applyCallback(jobId, callback, now) (heartbeat -> lastHeartbeatAt, firstHeartbeatAt, booting -> running; done/failed -> final status, finishedAt;
  an artifact past ARTIFACTS_MAX = 50 is refused with artifactLimit),
requestStop(jobId), finishJob(jobId, { status, reason, terminatedAt, launchedAt? }) (status decided in SQL, see Lifecycle),
activeJobCount(), trainingSpendToday(), trainingCommittedToday(),
claimLaunch(jobId, tokenHash, message) / releaseLaunch(jobId, tokenHash) (the job's one launch claim, and giving it back after a refusal),
saveLateLaunch(jobId, { instanceId, launchedAt }) (saves an instance on a job with none, whatever its status, and clears terminatedAt),
extendTermination(jobId, { terminatedAt, reason }) (moves terminatedAt later, never earlier, and recounts the cost),
reserveUploadBytes(jobId, bytes, hour, capBytes) (the upload byte budget, one upsert in rate_limits),
recordSweepOk(now?) / lastSweepOkAt() (the sweep's heartbeat, in rate_limits),
verifyJobToken(jobId, token) (constant-time compare of hashToken(token) with token_hash; false once 15 min past finishedAt)
// eval items, judging and datasets: see Datasets and Judging; the live demo's reads and slot: see Live demo (glimmer-serve)
```

## Routes

| Route | Who | Does |
|---|---|---|
| `GET /api/train/jobs` | admin | `{ jobs: TrainJobView[], recipes: RecipeView[] }` |
| `POST /api/train/jobs` | admin or automation | body `{ recipe, title?, params?, instanceType?, maxMinutes?, maxUsd? }` -> 201 `{ job }`. A "dataset" param must name a dataset that exists and is ready. An "adapter" param (glimmer-serve) must name a job whose adapter can be served (`adapterProblem`, else 400 after the param's label); the GPU is then picked only in that adapter's region, the limits default to its minutes plus 15 (`recipeDefaults`), a demo whose limits can't cover that on the GPU it gets is a 400 (`serveFitProblem`, with `{ estimateMinutes, usableMinutes }`), its `minutes` are stored whole (`serveMinutes` rounds down), a second open demo for the same adapter is 409 `demo_running` with `{ serveJobId }` (two asked for at once both get created, and the later backs out with the same 409: `earlierOpenServeJob`), and a region with no free GPU is 503 `no_capacity` with `{ options, region }`. For a `usesCache` recipe the GPU is picked with `pickGpu(recipe.gpus, types, asked, await cacheRegions())`, and a `cacheRegions()` error falls back to no preference. A run that can't fit its limits on the GPU it gets (`runEstimate` against `usableMinutes`, see glimmer-lora recipe) is refused with 400 and a sentence saying why, with `{ estimateMinutes, usableMinutes }`, before anything is created. 400 bad input (including a dataset that doesn't exist, is still being written or failed), 502 `lambda_unavailable`, 409 `too_many_active`, 503 `lambda_not_configured`, `platform_not_public`, `sweep_not_configured` with `{ reason }` (`cron_secret_unset`, or `not_production` since Vercel runs crons only there; `TRAIN_ALLOW_OUTSIDE_PRODUCTION=1` lifts only the second, for a deliberate test), `sweep_not_running` with `{ lastSweepAt }` (no sweep run with Lambda's listing answering in the last 15 min; on a new deployment, wait for the first run or call the sweep once by hand), `no_capacity` (with `{ options }`), `daily_cap` |
| `GET /api/train/jobs/{id}` | admin | `{ job, events: TrainEventView[] }` (`job.evalSummary` once judged), `?after=<event id>` for new events only |
| `POST /api/train/jobs/{id}/stop` | admin | on an open job: sets stopRequested and terminates the instance right away (best effort; the job ends as stopped). On an ended job whose instance isn't confirmed terminated: terminates it again, and the job keeps its status. So Stop can be pressed again until `terminatedAt` is set; when Lambda doesn't answer, the sweep terminates it within 5 minutes. 409 `already_ended` once terminated or if it never launched |
| `POST /api/train/jobs/{id}/events` | job token | `TrainCallback` body -> 204. 401 bad token, 400 not a callback, a `serving` callback that doesn't name port 8443 and a SHA-256 fingerprint or comes from a job that isn't glimmer-serve, or an artifact URL that isn't this job's own upload (https on this deployment's Blob store, under `models/<jobId>/`, no query or credentials), 413 over 16 KB (64 KB for eval), 409 `job_ended` (except a late `log`; any other late callback also terminates the instance when it isn't confirmed terminated yet), 409 `artifact_limit`, 409 `eval_limit` with `{ max }`, 429 `rate_limited`. An eval item sent again with an index the job already has: 204, logged once (see Judging) |
| `GET /api/train/jobs/{id}/dataset?part=train\|eval&page=N` | job token | `{ items: TrainExample[] \| EvalExample[], nextPage: number \| null, title }` from the job's `params.datasetId` (for a glimmer-serve job, its adapter job's; `title` is the dataset's name), at most 100 items a page, N from 0, nextPage null on the last page. The token rules are the events route's (until 15 min after the job ended). 400 bad part or page, 404 `no_dataset` (no dataset param, or the dataset is gone), 409 `dataset_not_ready`, 429 `rate_limited` past 120 pages an hour |
| `POST /api/train/jobs/{id}/upload` | job token | `{ name, bytes, contentType }` -> `{ clientToken, pathname }`. Each token covers one blob: the platform picks `models/<jobId>/<12 random hex>-<safe name>`, with no random suffix and no overwrite, at most the declared bytes (1 GB max) and only the declared type, which must be on `TRAIN_UPLOAD_TYPES` (no HTML, SVG or XHTML, and no names ending in html, htm, xhtml, shtml, xml, svg or svgz). Lifetime as in Limits. 400 bad input, 409 `job_ended`, 413 `too_large`, 413 `upload_budget`, 429 `upload_limit`, 503 `no_storage` without BLOB_READ_WRITE_TOKEN |
| `GET /api/train/gpus` | admin | `{ options: GpuOption[] }` |
| `GET /api/train/datasets` | admin | `{ datasets: DatasetView[] }`, newest first |
| `POST /api/train/datasets` | admin or automation | body `{ title?, task, count }` -> 201 `{ dataset }`, makeDataset workflow started. No title: the start of the task. 400 bad input, 503 `meta_not_configured` (no MODEL_API_KEY), 503 `paused` (daily spend cap), 500 `start_failed` (the dataset is failed) |
| `GET /api/train/datasets/{id}` | admin | `{ dataset, sampleTrain, sampleEval }`, the first 5 of each. While generating, sampleTrain is the first answered examples, before eval is held out, and sampleEval is empty (eval then holds the answers of the chunk being written) |
| `POST /api/lab/{id}/try` | anyone (not cross-site) | `{ prompt }` -> `{ base, tuned, ms }` from the live demo of training job `{id}`'s adapter (see Live demo (glimmer-serve)). Anyone for a judged job (one with a public result page), only an admin for one that isn't. 403 `cross_site`, 400 a blank prompt or one over 600 characters (a sentence), 404 `no_live_demo` (also for an unjudged job's demo asked for by anyone else), 409 `busy`, 429 `rate_limited` with `{ scope, retryAfterSeconds }`, 502 `demo_unavailable`, 504 `timeout`. Never the GPU's IP, the serving key or the certificate |
| `GET /api/cron/train-sweep` | CRON_SECRET | the sweep; `vercel.json` cron `*/5 * * * *`. Notes each run whose Lambda listing answered, for the launch gate |

## Admin pages

`/fine-tuning` (nav "Fine-tuning", in the Usage group) lists jobs in the Usage-style table: title, recipe, GPU, status pill, elapsed, cost, started. It also has a New job card: recipe select, params fields from the recipe, a GPU select from `/api/train/gpus` with price and capacity, and limits fields, which start at the recipe's defaults under the ceilings (`limitDefaults`) and go up to the ceilings (`limitBounds`). For glimmer-lora the card shows how long the run takes on the chosen GPU (on Auto, the slowest free one) with and without the model cache, and a warning when the job's limits would stop it first (`runTimeHint`, the estimate the jobs route checks). Under the totals, a note says what the model cache costs every month on its own (`cacheCostText`, see Model cache). `/fine-tuning/{id}` shows the job with the build-room layout: an event log on the left that polls every 5 s while the job isn't terminal, and a right panel with status, GPU, region, IP, limits, a running cost, progress, artifacts and a Stop button. Non-admins see the read-only Lab results (below). Visual rules: docs/UI_PATTERNS.md.

- Both pages confirm admin against the database (`pageViewer` in `app/fine-tuning/viewer.ts`, as `requireUser` does), so revoking `is_admin` takes effect without waiting for the cookie to expire.
- The New job card blocks Start, with a sentence saying why, when the route would refuse for the sweep (`sweep_not_configured` or `sweep_not_running`).
- Stop reads "Stop job", then "Try stop again" after a stop request, or "Shut down GPU" for an ended job whose GPU isn't confirmed gone. It goes away once `terminatedAt` is set.
- Artifact links open only this job's own folder on a Blob public host; any other URL shows as plain text.

Datasets and eval results:

- `/fine-tuning` also has a Datasets table (dataset, examples, status, cost, created) and a New dataset card: the task (20 to 2,000 characters), an optional name, the number of examples (20 to 1,000), and a line with a rough cost and time and how many are held out (`datasetCostHint`). The card is blocked, with a sentence saying why, when the route would refuse (`meta_not_configured`, `paused`). The page refreshes every 10 s while a job is running or a dataset is being written.
- `/fine-tuning/datasets/{id}` shows a dataset: its status, counts and cost (examples answered so far while it is written), the task, the first 10 training conversations and every eval prompt with its reference (only once it is ready), and a "Train on it" button on a ready one (`/fine-tuning?dataset=<id>#new-job`). A ready dataset that stopped early shows its note (in `error`) as a warning there and under its name in the Datasets table. `/fine-tuning/datasets` redirects to `/fine-tuning#datasets`.
- A dataset still "generating" 6 hours after it was made shows as "Stalled" (`DATASET_STALE_MS`): its workflow most likely died. It isn't refreshed for, and the New job card doesn't offer it.
- In the New job card a param of kind "dataset" is a select of ready datasets (ones still being written are listed but can't be picked); `?dataset=<id>` picks that one and the first recipe that takes a dataset. For a `usesCache` recipe, Auto reads "a free GPU near the model cache", and the cost estimate uses the priciest free GPU, since only the platform knows which regions hold the cache.
- The job page reads the whole event log (pages of 1,000, up to 20,000 events) and sends the browser every eval and judgement event plus the latest 1,500 others; runs of eval and judgement events fold into one log row each. The panel names the job's dataset with a link and has an Eval row ("Tuned won N of M", or "Not judged").
- Eval results on the job page: a summary strip once judged (wins, ties, average scores, judging cost), and each item as a group of rows: the prompt across the full width, then the reference, the base and the tuned answer and the verdict, long text folded. While the job runs it says the items are being answered; after a job that succeeded it says "Judging..." and keeps polling until the job's eval summary arrives (with a `note` when judging was skipped or judged nothing, which the page shows as the reason) or 20 minutes pass after the job ended (`JUDGE_WAIT_MS`). `evalState` reads only the job's own eval summary, its status and the platform's judgement events, never log text, which the job's runner can write to.

Live demo (see Live demo (glimmer-serve)), in `components/train/LiveDemo.tsx`:

- In the New job card a param of kind "adapter" is a select of the adapters a serve job can serve (`listAdapterOptions`, loaded on `/fine-tuning`): title, tuned wins, date, region and dataset (`adapterOptionText`). The GPU list and Auto count only capacity in that adapter's region, changing the minutes moves the time and dollar limits to what the route would give (`recipeDefaults` under the ceilings), and the run line says how long it serves and whether the limits cover it (`serveTimeHint`, the route's `serveFitProblem`). The card is held, with a sentence, when no adapter can be served or they couldn't be loaded.
- The admin page of a succeeded glimmer-lora job whose adapter can be served has Start a live demo (`StartLiveDemo`) when none is open: a minutes select (10 to 120; choices whose minutes plus 15 pass the time ceiling can't be picked), the limits it gets, a warning when the dollar ceiling would refuse it on an H100 SXM5, and a button that confirms, then POSTs `/api/train/jobs` with `{ recipe: "glimmer-serve", title: "Live demo: <job title>", params: { adapterJobId, minutes } }` and no limits, so the route sizes them. It is held, with the reason, when the platform isn't public or the sweep isn't running. While a demo for it is open, the page has the Try it live box instead, with a link to the serve job.
- A glimmer-serve job's page has a Live demo section in the panel (`servingText`: not serving yet, serving since and until when with the minutes left, stopping, or when it served once it ended, from `TrainJobView.serving`), a status line that reads "Loading the model for the live demo" or "Serving the live demo" (`jobWorkingText`), the Adapter setting linked to its job, and the serving event in the log with only the start of the certificate's fingerprint.

## Testing without spending

Run them with `npx tsx --test --experimental-test-module-mocks lib/train/__tests__/*.test.ts` (the flag gives node:test `mock.module`; without it the mocked suites skip). Nothing calls Lambda or Neon.

- `lib/train/__tests__/logic.test.ts`: decideCheck, costs, limits (and `usableMinutes` agreeing with decideCheck), params and run estimates.
- `lib/train/__tests__/lambda.test.ts`: the client against a faked fetch.
- `lib/train/__tests__/steps.test.ts`: the real steps with Lambda and the store faked: one launch per job under retries, duplicate runs and database errors; the runner's deadline stamped before the launch, at the time or the dollar limit; terminate by id before any database read; checks that ride out outages.
- `lib/train/__tests__/workflow.scenario.test.ts`: the workflow with steps faked, in the style of lib/pipeline/__tests__/workflow.scenario.test.ts.
- `lib/train/__tests__/sweep.test.ts`: the sweep with Lambda and the store faked, including a failed listing and renamed or tagged instances.
- `lib/train/__tests__/store.test.ts`: the store's SQL against an in-memory PGlite with the repo's migrations (holding a GPU, the daily cap, finishJob, the launch claim, the sweep's heartbeat, the upload budget).
- `lib/train/__tests__/routes.test.ts`: the job, events, upload, stop and sweep cron routes with their dependencies faked.
- `lib/train/__tests__/runner.test.ts`: compiles every Python string with `python3 -m py_compile`, then runs runner.py with the smoke recipe (`allowNoGpu`) against a local HTTP server standing in for the platform and for Vercel Blob. It checks the events, their order, the Authorization header, uploads (simple, multipart, media types, a fresh grant after a refused retry), `ctx.deadline`, the event pipe against a progress bar on stderr, and the stall report with heartbeats held back. Its "glimmer recipe internals" suite runs glimmer.py's own functions against a fake ctx: the venv race and the build lock, leftovers and old venvs, the readiness check, the pinned uv, build timeouts, stale Hugging Face locks, a venv marked broken, the deadline, stopping training early and partial results, the training text and eval prompts on the final channel (against a small tokenizer whose template is pinned to the real `chat_template.jinja`'s output), the masking check, unfinished answers, the student prompt switch, and the child itself run on fake Unsloth, torch, datasets, transformers and trl modules (the masks and their failures, 1,024 new tokens, the diagnostics in the log). It is skipped when python3 is missing.
- `lib/train/__tests__/userdata.test.ts`: cloud-config shape, size and no secrets, `deadlineEpoch`, and `cacheDir` only when given.
- `lib/train/__tests__/datasets.test.ts` and `judge.test.ts`: see Datasets and Judging. `lambda.test.ts` and `steps.test.ts` also cover the filesystems, `pickGpu`'s region preference and the cache at launch; `runner.test.ts` runs the glimmer-lora recipe with `dryRun: 1` against the fake platform serving `/dataset` pages.
- `components/train/__tests__/`: the page copy and the rendered cards, including datasets and eval results.
- The live demo: see Live demo (glimmer-serve) for its tests.

All of it, with the component renders: `npx tsx --test --experimental-test-module-mocks $(find lib components -name '*.test.ts')` and `npx tsx --test --experimental-test-module-mocks components/train/__tests__/*.test.tsx`.

## Model cache (Lambda filesystems)

A recipe with `usesCache: true` (`glimmer-lora`, and `glimmer-serve`, which loads its adapter from there) keeps its Python venv and model weights on a Lambda persistent filesystem, one per region, so the next job in that region skips the install and the 21 GB download. Filesystems bill by stored GB per month even with no instance running (about 40 GB a region, roughly $8 a month at about $0.20 a GB, outside every job, daily and spend limit; `/fine-tuning` says so); the platform never deletes them (delete one by hand in the Lambda console when it is no longer wanted). Inside one, the recipe clears what dead jobs left and venvs nobody uses any more (see the cache layout below), but keeps every job's adapter.

- Name: `muse-muse-cache-<region>` (`cacheFilesystemName(region)`, prefix `CACHE_FILESYSTEM_PREFIX`). Mounted at Lambda's default `/lambda/nfs/<name>` (the filesystem's `mount_point`).
- Job creation: the jobs route calls `pickGpu(recipe.gpus, types, asked, recipe.usesCache ? await cacheRegions() : [])`; a `cacheRegions()` error only drops the preference, it never refuses the job. An asked GPU type with capacity still wins (in a cache region when it has capacity there); otherwise the first recipe GPU with capacity in a cache region is taken, then the first with capacity anywhere.
- Launch: `launchStep` calls `ensureFilesystem(job.region)` after the adopt and in-flight checks and before the launch claim, then launches with `file_system_names: [name]` and puts the mount path in job.json as `cacheDir`. If the filesystem can't be listed or created, the launch fails with a FatalError ("The model cache filesystem in <region> could not be found or created, so nothing was launched: ...") and nothing is claimed or launched. An adopted instance (found by name on a retry) is never asked about again. A glimmer-serve job instead calls `findCacheFilesystem(job.region)`, which only lists: a new, empty filesystem wouldn't hold its adapter, so a region with none fails the launch with a FatalError ("There is no model cache filesystem in <region>, so the adapter this job serves isn't there and nothing was launched.") before the claim.
- `ensureFilesystem` is idempotent and never loops on a create: it lists, and creates with one `POST /filesystems` `{ name, region }` only when the region has none (a 429 is retried once, since nothing was made). A `global/duplicate`, a timeout, a network error or a 5xx reads the listing once more and returns the filesystem if it is there; anything else (a quota refusal, say) is thrown. A cache name found in another region is refused (`filesystem-in-wrong-region`).
- On the instance, the runner waits up to 60 s for `cacheDir` to be a folder and sets `ctx.cache_dir` to it, or to None (with a log line) when it never shows up (see Runner and recipes). A recipe also checks it can write there (root squash would refuse) and otherwise runs without the cache.

```ts
export const CACHE_FILESYSTEM_PREFIX = "muse-muse-cache-"
export interface LambdaFilesystem { id: string; name: string; region: string; mountPoint: string; inUse: boolean; bytesUsed: number | null }
export function cacheFilesystemName(region: string): string
export async function listFilesystems(): Promise<LambdaFilesystem[]>          // GET /filesystems
export async function ensureFilesystem(region: string): Promise<LambdaFilesystem> // GET, then at most one POST /filesystems; launchStep only
export async function findCacheFilesystem(region: string): Promise<LambdaFilesystem | null> // GET only; launchStep, for glimmer-serve
export async function cacheRegions(): Promise<string[]>                       // regions with a muse-muse-cache-<region>; throws LambdaApiError
export function pickGpu(choices, types, asked?, preferRegions?: string[])     // preferRegions: see "Job creation" above
// launchInstance input also takes fileSystemNames?: string[] (sent as file_system_names only when non-empty)
```

Cache layout, under `cacheDir` (or `/opt/muse` when a job has none):

| Path | What |
|---|---|
| `venvs/glimmer-<12 hex>/` | the uv venv; the hash covers the Python version, the uv version and every install line, so changing a pin makes a new one. Ready once `.muse-ready` is in it. Every job stamps the one it runs from (`.muse-last-used`); a venv of other pins with no stamp gets one when a job first sees it, and goes once no job stamped it for 12 hours (by then every job launched with its pins has ended, as long as `TRAIN_JOB_MAX_MINUTES` stays well under 12 hours). The one in use is never removed |
| `venvs/glimmer-<12 hex>.lock/` | the build lock (a folder, since `mkdir` is atomic on NFS), with an `owner` file; its holder touches it every minute, and one untouched for 10 minutes is broken |
| `venvs/glimmer-<12 hex>.building-<job>/`, `.stale-*` | a build in progress, and folders moved aside (a broken lock, a venv that wasn't ready, an old venv being deleted). Any job deletes those older than 12 hours, on a thread of its own |
| `uv/<version>/uv`, `uv/python/` | the pinned uv, checked against its sha256 before it is kept, and the uv-managed Python the venvs point at |
| `hf/` | `HF_HOME`: the model weights at the pinned revision. Download locks under `hf/hub/.locks` that nobody took for an hour are a dead download's and are removed before the model loads |
| `models/<jobId>/` | each job's saved LoRA adapter, kept after the upload (it is never cleared); a glimmer-serve job loads it from here |

## glimmer-lora recipe (lib/train/recipes/glimmer.ts)

A LoRA fine-tune of Muse Glimmer 30B on one dataset, then the dataset's held-out prompts answered by the base and the tuned model as eval items, for the platform to judge. It follows Unsloth's Muse Glimmer guide (unsloth.ai/docs/models/muse-glimmer and /train) and its Conversational Kaggle notebook (`Kaggle-Muse_Glimmer_(30B)-Conversational.ipynb`).

- GPUs, in order: `gpu_1x_h100_pcie`, `gpu_1x_h100_sxm5`, `gpu_1x_a100_sxm4`. `gpu_1x_gh200` is left out: it is arm64, and Unsloth documents arm64 only through a from-source Docker build (its DGX Spark Dockerfile), not the pip install below. Defaults: 150 minutes, $14, `usesCache: true`. These sit above the default ceilings (`TRAIN_JOB_MAX_MINUTES` 120, `TRAIN_JOB_MAX_USD` $5), so a job that asks for nothing gets 120 minutes and $5 until those are raised; with them raised (say 300 and $40), an admin can ask for more than the defaults.
- How long a run takes (`runEstimate` in `lib/train/logic.ts`): `maxSteps` at about 5 s a step on an H100 SXM5, 6 on an H100 PCIe and 12 on an A100 SXM4 (or any other GPU), plus 20 minutes in a region with the model cache or 45 without it. The jobs route refuses a run whose estimate is over `usableMinutes`, and the New job card shows the same estimate. A dry run has none.
- Params: `datasetId` (kind "dataset", required), `maxSteps` (default 120, 10 to 2000), `learningRate` (default 0.0002, 0.000001 to 0.01), `loraRank` (default 16, 4 to 128; `lora_alpha` is the same), `studentPrompt` (kind "text", "short" or "full", default "short"; the recipe refuses anything else when it starts), `dryRun` (0 or 1, default 0).
- Student prompt (distillation framing). The teacher, Muse Spark 1.3, wrote every answer under the dataset's long task prompt (`datasetSystemPrompt(task)`, up to about 2,300 characters). With `studentPrompt` "short", every training conversation's system message is replaced by one line, "You are " and the dataset's title (`student_system`: "You are Muse Muse's brief writer." for a dataset named "Muse Muse's brief writer"; "You are a helpful assistant." when the title is missing, over 80 characters or only the start of the task, the name a dataset gets when it is made without one), and both the base and the tuned model answer the eval prompts under that same line. The references stay the teacher's answers. Neither model is told the task, so the scores measure what training taught: the base model has to guess the format, the tuned one learned it. With "full", training keeps the dataset's conversations as they are and both models answer under the system message they share (none when they differ), which measures how well each model follows the task's instructions; the base model often does well there without any training. The line used is in the first log line and in the metrics (`student_prompt`, `student_system`). `dryRun: 1` is also the cheap first check on a real GPU: it launches, mounts the cache, pages the dataset, sends the eval items (which get judged) and uploads a stand-in adapter, in a few minutes of GPU time.
- Install (once per region and pin set): uv 0.13.1 from its GitHub release, checked against `UV_SHA256` (a uv on PATH is never used), `uv venv --relocatable --python-preference only-managed --python 3.12`, then the notebook's install cell as `uv pip install` lines pinned to what it resolved to on 2026-10-27 for Python 3.12 on x86_64 Linux: `torch==2.11.0+cu128 torchvision==0.26.0+cu128 torchaudio==2.11.0+cu128 xformers==0.0.35 --index-url https://download.pytorch.org/whl/cu128`, `unsloth==2026.10.9 unsloth_zoo==2026.10.9 peft==0.21.2 accelerate==1.15.0 bitsandbytes==0.50.2 datasets==4.8.5`, `--no-deps torchao==0.18.0`, `transformers==5.15.0`, `--no-deps trl==0.22.2` (the last with `--compile-bytecode`, which compiles the whole venv). Only the direct packages are pinned, not a hash-locked set of every transitive one. Each step's timeout is its cap (15 minutes, 40 for an install) or less, so the job can still train after it; with under a minute to spare the job fails before installing. Then the readiness check imports what the child imports (Unsloth's `FastModel` and `train_on_responses_only`, torch, datasets, peft, bitsandbytes, transformers, trl), asserts `torch.cuda.is_available()` and must print `MUSE_CHECK transformers=5.15.0 trl=0.22.2`; only then is `.muse-ready` written.
- Two jobs and one venv: the build goes into `.building-<job>`, and one job builds at a time, holding the venv's `.lock` folder while the others poll every 15 s and reuse its venv when it is ready (a waiter gives up when too little time is left to train). The finished build is renamed into place, and the rename settles any race: it fails onto a folder that isn't empty, so the venv already there wins and the loser reuses it. A ready venv is never deleted or moved, since jobs may be running from it; a folder in its place that isn't ready is moved aside and left for the 12-hour cleanup. A failed build deletes its own folder, and only a lock's owner removes it. Jobs run the venv with `PYTHONDONTWRITEBYTECODE=1`, so nothing writes into it. When a reused venv makes the child fail with a `ModuleNotFoundError` before its imports are done, its marker is renamed to `.muse-broken` (nothing is deleted), so the next job builds it again.
- The runner imports recipe.py with the system python, so its top level is standard library only. The GPU work runs as `<venv>/bin/python -u recipe.py --child glimmer-config.json` through `ctx.run`, with `HF_HOME=<cache>/hf`, watched with `stall_seconds=1200` like every build step (20 minutes with no output is a stall). The child writes `MUSE_EVENT {...}` lines to the runner's event pipe (`MUSE_EVENT_FD`, falling back to stdout, where the recipe finds the prefix anywhere in a line in case a progress bar is glued in front), which the recipe turns into progress events (training every 10 steps with the loss, plus phase messages); results come back in `work/glimmer-result.json`, written aside and renamed so a killed child never leaves half of one.
- The deadline: the child gets until `ctx.deadline` less 5 minutes (the parent's own time, for the eval items and the upload) and is killed a minute after that. With under 15 minutes left for it, the job fails at once instead of loading a model it can't train.
- The child: `FastModel.from_pretrained("unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit", revision=MODEL_REVISION, max_seq_length=2048)`, the model pinned to the hub commit `ecedda39...` (main on 2026-10-27); `FastModel.get_peft_model` with language, attention and MLP modules (vision frozen), `r = lora_alpha = loraRank`, dropout 0, bias "none", `use_gradient_checkpointing="unsloth"`, seed 3407. Text goes through the model's own ATEM chat template (`chat_template.jinja` in the model repo) with the leading `<|begin_of_text|>` removed and `reasoning_strength="low"`, which only sets the "Reasoning strength: low." line in the system block. The channels: an assistant message with `reasoning_content` renders as `<|start|>assistant to=self<|message|>` (reasoning), `<|eom|>`, then `<|start|>assistant to=user<|message|>` (the final answer) and `<|eot|>`; without it, only the final message. `<|eot|>` ends generation (it is in the model's `eos_token_id`), `<|eom|>` doesn't. The dataset's answers have no reasoning, so each training text ends `<|start|>assistant to=user<|message|>ANSWER<|eot|>` with no to=self message (`training_text`, which checks that every prompt follows `<|start|>user<|message|>` and every answer follows `<|start|>assistant to=user<|message|>` in the rendered text, so a template that renders otherwise fails the job before any answer). The template's generation prompt ends at `<|start|>assistant` and leaves the channel to the model, which opens its to=self reasoning; that choice is never trained, since it sits inside the response marker. So each eval prompt is the generation prompt with ` to=user<|message|>` appended (`eval_prompt`): it ends exactly as a training text does before its answer, and both models answer on the final channel at once, with no reasoning, the way the tuned one was trained. Base answers first (a fresh LoRA adds zero), greedy, `max_new_tokens=1024`, batches of 8, left padded; the answer is the text up to the first `<|eot|>`, `<|eom|>` or `<|end_of_text|>`. An answer that never closes (the budget ran out, or the model opened another message first) or is empty is sent as "[Unfinished: no complete final answer within 1024 new tokens. The raw output follows, with only the chat template's control tokens taken out.]" and the raw output with only the control tokens taken out, so the judge sees what the model wrote and that it never finished; `base_unfinished` and `tuned_unfinished` count them, and the summary says so when either is above 0. The base answers are written to the result file at once. Then `SFTTrainer` with the notebook's `SFTConfig` (batch 1, gradient accumulation 4, warmup 5, `max_steps=maxSteps`, `learning_rate`, `loss_type="nll"`, `adamw_8bit`, weight decay 0.001, linear schedule, `save_strategy="no"`) and `train_on_responses_only(instruction_part="<|start|>user<|message|>", response_part="<|start|>assistant to=user<|message|>")`. The child then checks the masks it made (`check_masking`): every training example must have trained tokens, and its first trained span must start with its answer (its first 40 characters, or all of it when `max_seq_length` cut it shorter); otherwise the job fails before training with which example and why (the marker wasn't found, or the span starts elsewhere). The job log gets, from the child's `log` events: the first training example's text with the trained span between `[train]` and `[/train]` and its trained-token count (sent before the check, so a failed check shows what was masked), and the first 600 characters of the base and the tuned model's raw output for eval item 0, control tokens kept. A trainer callback stops training early once the clock reaches the child's deadline less 1.3 times the base answers' time and 3 minutes, so the tuned answers and the save still fit; the summary then says "N of M steps (stopped early to finish within the time limit)". The adapter is saved with `save_pretrained` to `<cache>/models/<jobId>/` and the result file rewritten before the tuned answers, then the optimizer's memory is freed. A failure in the tuned answers is recorded as `tuned_error` and the child still exits 0.
- The recipe then sends one eval item per held-out prompt (a dataset holds out at most 40; the recipe and the runner stop at 60), uploads the adapter folder as `glimmer-lora-<job id start>.tar.gz` (kind "adapter") when storage is available and it is under 1 GB (a failed upload is logged, not fatal), and returns metrics: `train_loss_final`, `steps`, `max_steps`, `stopped_early` (yes or no), `train_seconds`, `base_answer_seconds`, `base_unfinished`, `tuned_unfinished`, `trained_tokens_min`, `trained_tokens_mean`, `max_new_tokens`, `peak_vram_gb`, `gpu`, `eval_items`, `train_examples`, `student_prompt`, `student_system`, `cached_weights` and `cached_venv` (yes or no), `cache_used`, `adapter_dir`, `adapter_uploaded`, `adapter_mb`, `adapter_url` when uploaded, and a summary. The parent reads whatever result the child left, whatever its exit: with no result the job fails with how the child ended and its last lines; with the base answers but no adapter it fails saying training didn't finish; with the adapter but no tuned answers it uploads the adapter, logs the metrics, sends no eval items (so nothing is judged) and then fails saying why.
- `dryRun: 1` skips the venv, the model and the GPU: it fetches the dataset, sends progress ticks, makes deterministic fake answers, writes a stand-in adapter folder, offers it for upload, sends the eval items and finishes. `lib/train/__tests__/runner.test.ts` runs it against the fake platform serving `/dataset` pages and checks the eval events.

## Datasets (lib/train/datasets.ts)

Training data Muse Spark 1.3 writes from a task description. Table `training_datasets` (migration `drizzle/0003_training_datasets.sql`): `id, title, task, status ("generating" | "ready" | "failed"), requested, train (TrainExample[]), eval (EvalExample[]), train_count, eval_count, cost_usd, error, created_by, created_at, finished_at, workflow_run_id`. Examples can run to megabytes, so only the paging and the generating steps read `train` and `eval`; every other query selects the head columns (`DatasetHead`).

```text
POST /api/train/datasets (admin)  -> refused while the platform's daily spend cap is reached (lib/quota spendPaused),
                                     then row "generating", makeDataset workflow started
makeDataset (one file: the workflow and its steps):
  loadDatasetStep      the task and the count; a dataset that isn't generating is left alone
  promptBatchStep      x ceil(count / 25) + up to 4 more: structured output {prompts}, 25 a batch, each batch leaning
                       to other styles (casual, detailed, beginner, expert, concrete specifics, a format, edge cases,
                       in a hurry): one each in turn when the count needs 8 batches or more, otherwise an even share
                       of the 8 per batch (stylesFor), so even a 20-example dataset has them all. The latest 40
                       prompts (cut to 140 chars) are shown as ones not to repeat. The workflow de-duplicates (case,
                       accents, spacing and punctuation folded) and stops at the count.
                       The batches that leaned to the same styles before are shown too, up to 40 more of their
                       prompts (avoidList), since those are the likeliest to come back as close variants.
                       Prompts over 1,500 chars are dropped. Under 16 different prompts fails the dataset. A later
                       batch that fails, once there are 16, ends the prompts and the answers go on with those (but
                       not when the spend cap is the cause).
  answerChunkStep      chunks of 12: 6 calls at a time, instructions datasetSystemPrompt(task) (answers under about
                       350 words), effort low, max_output_tokens 3000, 90 s each with one SDK retry, so a prompt takes
                       at most about 3 minutes. An answer that failed, came back incomplete or empty, or is over 4,000
                       chars is skipped, not cut. Em dashes are taken out. Each call is charged (recordUsage and
                       cost_usd) as it returns, and each usable answer is saved at once into `eval` (stageAnswer; a
                       retried write saves it once). At the end of the step the chunk's answers move onto `train` as
                       {messages: [system, user, assistant]} in one statement (flushAnswers), so `train` is rewritten
                       once a chunk. A failed write after a paid call is tried again in the step about 5 times over
                       about 100 s. A retried step asks only the prompts with no saved answer, and one that finds the
                       dataset past its offset asks nothing. Past 120 s a step starts no new prompt and hands the
                       rest to the next step, so it ends in about 7 to 8 minutes at worst, under the 800 s limit. A
                       chunk with no usable answer is retried after 30 s only when nothing was billed (every call
                       failed); billed but unusable answers aren't asked again. Up to 2 such chunks are left out.
  finishDatasetStep    moves any answers still saved for a chunk onto `train`, counts what it holds, then in one
                       statement: the items evalSplit picks move to `eval` as {prompt, reference}, their
                       near-duplicates leave `train`, counts set, status "ready". Under 16 examples fails the dataset.
  failDatasetStep      on an error before answering starts: status "failed" with the error's first line.
```

- A dataset keeps what it paid for. Once answering has started, anything that stops it (the spend cap, the database, a third chunk Meta never answered) ends the answers, and finishDatasetStep makes the dataset "ready" with what it holds when that is at least 16, with a note in `error` ("Stopped early, once N of the M examples asked for were answered. <reason>"); with fewer it fails with the reason.
- Eval holds out 10% of the answered examples, at least 8 and at most 40, always leaving at least 8 to train on (`evalHoldoutCount`), near the evenly spread `evalIndexes` positions, so every batch's style is in it (`evalSplit`). Each position takes the closest prompt with no near-duplicate anywhere in the dataset: two prompts are near-duplicates when at least 70% of their words (after `promptKey`'s folding) are shared (`isNearDuplicate`, Jaccard). When none is left, it takes the closest prompt anyway and holds its near-duplicates out beside it while there is room; any still in train are dropped, never leaving fewer than 8 to train on. That catches reorderings, typos and a changed word or two, not a paraphrase in other words. The split is deterministic.
- Every training example's system message is `datasetSystemPrompt(task)`, the same instructions the answers were written with. Eval items carry only the prompt and Muse Spark 1.3's answer as the reference. glimmer-lora answers them under a short system message made from the dataset's title (its `studentPrompt` "short", the default), or under the training examples' shared system message ("full"), so name a dataset as a role, such as "Muse Muse's brief writer".
- Every Meta call is recorded with `recordUsage({ source: "platform", endpoint: "responses" })` and added to `cost_usd`; a structured reply that never matched the schema is still recorded. Each model step checks `spendPaused()` first and stops the dataset ("The platform's daily spend cap is reached, so the dataset stopped.") once the cap is reached: before any answer that fails it, after that it keeps what it has (see above).
- A dataset whose workflow died stays "generating". No job can use it, and nothing bills for it. The admin pages call it "Stalled" after 6 hours.
- Measured on 2026-10-27 (the real steps against Muse Spark 1.3, locally): 20 examples took 24 s (one prompt batch in 7 s, 20 answers 6 at a time in 17 s) and cost $0.069, about $0.0035 an example; answers ran 1,100 to 1,300 characters. The New dataset card's estimate (`datasetCostRange`, `datasetMinutes`) is deliberately higher.
- A job names its dataset with a recipe param of kind "dataset" (its key is `datasetId`). `validateParams` takes only a uuid there (lowercased); the jobs route then refuses with 400 a dataset that doesn't exist, is still generating or failed.

| Limit | Value | Where |
|---|---|---|
| Examples asked for | 20 to 1000 | `DATASET_MIN_COUNT`, `DATASET_MAX_COUNT` in `lib/train/logic.ts` |
| Task description | 20 to 2,000 characters | `DATASET_TASK_MIN`, `DATASET_TASK_MAX` |
| Fewest examples a dataset may end with | 16 | `DATASET_MIN_EXAMPLES` |
| Dataset page for a job | 100 items, under 2.5 MB even when every character takes 3 bytes (about 180 KB for 100 typical English examples) | dataset route |
| Dataset pages per job | 120 an hour, then 429 `rate_limited` | dataset route |

Routes: `GET` and `POST /api/train/datasets`, `GET /api/train/datasets/{id}` and the job's `GET /api/train/jobs/{id}/dataset` pages are in the Routes table above.

```ts
// datasets.ts
makeDataset({ datasetId }) (the workflow), loadDatasetStep, promptBatchStep, answerChunkStep, finishDatasetStep,
failDatasetStep, stylesFor(batch, batches), avoidList(byBatch, batch, batches), DATASET_MODEL, PROMPT_BATCH (25),
ANSWER_CHUNK (12), ANSWER_CONCURRENCY (6), ANSWER_STEP_TIMING
// store.ts
createDataset({ title, task, requested, createdBy? }), getDataset(id), listDatasets(limit), attachDatasetRun(id, runId),
datasetPage(id, part, offset, limit) -> { status, total, items } (sliced in SQL),
datasetProgress(id) (examples held while generating, else null), answerProgress(id) -> { held, staged } (the examples and
the prompts answered but not yet moved onto train), stageAnswer(id, { prompt, reference }) (once per prompt),
flushAnswers(id, system) (the saved answers onto train, in one statement), addDatasetCost(id, usd),
finishDataset(id, count, note?) (the eval split; note goes in error), failDataset(id, error) (only while generating)
// logic.ts
evalHoldoutCount(n), evalIndexes(n), evalSplit(prompts) -> { held, dropped }, promptKey(text), promptWords(text),
isNearDuplicate(a, b), NEAR_DUPLICATE_JACCARD (0.7), dedupePrompts(existing, incoming, max), datasetSystemPrompt(task),
toDatasetView(row)
```

## Judging (lib/train/judge.ts)

A job whose recipe answers its dataset's held-out prompts with the base and the tuned model sends each as an eval callback before "done". Once the job has ended as "succeeded" and its instance has been terminated, Muse Spark 1.3 judges them and the job gets an eval summary.

Eval callbacks on `POST /api/train/jobs/{id}/events`:

- Body `{ type: "eval", index, prompt, reference, base, tuned }`: `index` a whole number from 0 to 9999, the four texts strings (the prompt not blank), each cut to 3,500 characters (`EVAL_TEXT_MAX`). Anything else is 400.
- An eval body may be up to 64 KB, since four 3,500-character texts can pass 16 KB once escaped or outside ASCII. Every other callback keeps the 16 KB limit.
- Like any callback, it counts as a sign of life and toward the 120 a minute, and is 409 `job_ended` once the job has ended.
- Logged as a training event of type "eval" by `recordEvalEvent`, which locks the job row, so callbacks at once can't pass the cap: at most 60 per job (`EVALS_MAX`), then 409 `eval_limit` with `{ max }`. An item sent again with an index the job already has is a retry: 204, and it isn't logged twice.

Judging, at the end of `trainJob` (lib/train/workflow.ts):

```text
terminate returned "succeeded" ->
  judgePlanStep          the job's eval indexes (at most 60) and its dataset's task. Nothing when it has none or already
                         has a summary; nothing when MODEL_API_KEY isn't set or the spend cap is reached, and then an
                         unjudged summary with a note ("Judging skipped: ...") and a log line
  judgeStep x n, 4 at once   Muse Spark 1.3, structured output, effort low; usage recorded, then a "judgement" event
  saveEvalSummaryStep    eval_summary on training_jobs and a log line; with nothing judged, an unjudged summary with a
                         note ("Judging failed: none of the N eval items could be judged.") and a log line
```

- Judging starts only after `terminate` returned, so it never keeps a GPU billing, and nothing in it can change the job's status: a judge step that fails is left out of the summary, and an error in judging as a whole is swallowed.
- The judge sees the user message, the reference, and the two answers blind as A and B: the base model's is A on even indexes and B on odd ones, so neither labels nor position favor one model. It returns `{ note, scoreA, scoreB, better: "A" | "B" | "tie" }`; scores are clamped to whole numbers from 1 to 10 and the note is cut to 30 words. The verdict is logged as `{ type: "judgement", index, baseScore, tunedScore, better: "base" | "tuned" | "tie", note }`. When the scores differ, `better` follows them; when they are equal the judge's own pick stands.
- `judgeStep` is safe to run again: an item that already has a judgement is returned as it is, at no cost, without asking Meta. Usage is recorded (`source "platform"`, endpoint `responses`) before the judgement is logged. A reply that never matched the schema is recorded and not retried.
- `EvalSummary` (`training_jobs.eval_summary`, `TrainJobView.evalSummary`): `items, tunedWins, baseWins, ties, avgBaseScore, avgTunedScore` (hundredths) and `judgeCostUsd`, the sum of what the judge steps cost (an item judged again after a crash counts at 0). An unjudged summary (`unjudgedSummary(note)`, typed `UnjudgedSummary` in logic.ts) has 0 items and a `note` saying why; `unjudgedNote(summary)` reads it back. The job page takes judging's outcome only from this, never from log text.

```ts
// logic.ts
EVALS_MAX = 60, EVAL_TEXT_MAX = 3500, judgeScore(n), betterOf(baseScore, tunedScore, said), summarizeJudgements(items),
unjudgedSummary(note), unjudgedNote(summary)
// store.ts
recordEvalEvent(jobId, body, max?) -> "recorded" | "duplicate" | "limit", listEvalIndexes(jobId), getEvalItem(jobId, index),
getJudgement(jobId, index), setEvalSummary(jobId, summary)
```

Tests (nothing calls Meta, Lambda or Neon):

- `lib/train/__tests__/datasets.test.ts`: makeDataset and its real steps with the store, Meta, the spend cap and usage faked: batches and their styles, the avoid list, de-duplication and the extra-batch bound, 6 answers at a time in chunks of 12, skipped answers, usage and cost as each call returns, the eval split and near-duplicates, the spend cap before and during the answers (a smaller ready dataset with a note), a late prompt batch that fails, a retried step that asks only what wasn't saved, a billed but unusable chunk that isn't asked again, and a step that runs out of time.
- `lib/train/__tests__/judge.test.ts`: the blind order and the mapping back, better against the scores, the cleaned reply, usage before the judgement, an item already judged, the skips and the unjudged summaries, the summary.
- `lib/train/__tests__/store.test.ts`, `routes.test.ts`, `workflow.scenario.test.ts` and `logic.test.ts` cover the SQL (one eval per index, the cap, staging and flushing answers, the split with near-duplicates, the note, paging), the routes above, judging only after terminate (4 at once, never changing the status) and the pure helpers.

## Lab results

Non-admins (the shared guest under OPEN_ACCESS=guest, and signed-out visitors) get a read-only view of the fine-tuning pages. Every control and every `/api/train/*` route stays admin, automation or job token only.

- `/fine-tuning`: what the lab does, the judged jobs (title, recipe, model, tuned vs base wins, average scores, GPU, GPU minutes, cost) and the ready datasets (title, task, counts, cost). Admins see the same Results list, with a note that anyone can see it, once there is one.
- `/fine-tuning/{id}`: a judged job only, else a 404. It shows the recipe, model, dataset (when ready), GPU, GPU minutes and cost, and the settings `maxSteps`, `loraRank`, `learningRate` and `studentPrompt`, then the eval summary strip and the side-by-side table. Never the instance id, IP, region, limits, event log, error, metrics, artifacts or Stop. While a live demo of a glimmer-lora job's adapter is starting or live, the Try it live box comes first (see Live demo (glimmer-serve)); without one the page is exactly as before.
- `/fine-tuning/datasets/{id}`: a ready dataset only, else a 404. It shows 3 training conversations and 5 eval prompts, with no "Train on it" and no note.
- A job has results when it succeeded, `terminatedAt` is set, its eval summary has items, and it isn't a dry run. The Lab reads at the end of `lib/train/store.ts` apply this in SQL and select only the columns these pages show. `components/train/results.ts` maps the rows field by field and checks the rule again (`hasResults`). Model text renders as plain text.
- Tests: `components/train/__tests__/pages.test.tsx`.

## Live demo (glimmer-serve)

"Try tuned Glimmer live". The `glimmer-serve` recipe serves ONE trained glimmer-lora adapter on one GPU for a set number of minutes. While it runs, that adapter's public result page (`/fine-tuning/{trainJobId}`) has a Try it live box: anyone types an app idea and gets the base and the tuned Muse Glimmer's answers side by side, from the same GPU (the base with PEFT's `disable_adapter`). It is a job like every other, with the same lifecycle, limits, sweep, deadline and termination: its `run(ctx)` keeps a server up until its minutes are up or `ctx.deadline` less 3 minutes, then returns, and the runner posts done.

```text
admin: Start a live demo (the adapter's page) or the New job card
  -> POST /api/train/jobs { recipe: "glimmer-serve", params: { adapterJobId, minutes } }
     adapter servable (adapterProblem), one open demo per adapter (409 demo_running), GPU only in the adapter's region
     (pickGpu onlyRegion), limits minutes + 15 (recipeDefaults), refused when they can't cover that (serveFitProblem)
launchStep: findCacheFilesystem(region) (the cache already there, never a new one), ensureServeFirewall(region),
     then the token, serveKey = serveKeyFor(jobId, hashToken(token)) into job.json, launch with the cache mounted and
     firewall_rulesets [{ id }]
GPU, run(ctx): the adapter at <cache>/models/<adapterJobId>/, the system line from the adapter's dataset, ensure_venv,
     then the child: a self-signed certificate (openssl), the 4-bit base and the adapter, HTTPS on 8443
  -> "serving" { port, certSha256, model, adapterJobId } -> training_jobs.serve_endpoint { ip (Lambda's), port,
     certSha256, startedAt }
browser -> POST /api/lab/{trainJobId}/try { prompt } -> rate limits and the demo's one slot -> HTTPS pinned to certSha256,
     POST /generate with "Authorization: Bearer <serveKey>" -> { base, tuned, ms }
end: its minutes after it came up, or ctx.deadline - 180 s when that is first -> the server drains and stops -> done
     -> terminated like every job (no eval items, so nothing is judged)
```

### Recipe, params and limits

- Params: `adapterJobId` (kind "adapter", required) and `minutes` (number, default 30, 10 to 120: how long it serves once the model is loaded). `validateParams` takes only a uuid for the adapter, lowercased. The jobs route stores `minutes` whole (`serveMinutes`, rounded down), and the GPU reads it the same way (`read_serve_params`: floor, then clamp), so the limits, the page's end time, the proxy's cutoff and the server all count the same minutes.
- An adapter can be served (`adapterProblem` in `lib/train/logic.ts`, the jobs route's 400) when its job is glimmer-lora, succeeded, wasn't a dry run (`dryRun` under 1), and its latest done metrics say `cache_used` "yes" with `adapter_dir` ending in `models/<its id>`, so it is at `<cache>/models/<id>/` on the filesystem of its own region (`training_jobs.region`). `listAdapterOptions` lists those, newest first, for the select; `getAdapterSource(jobId)` reads one with its done metrics.
- GPUs: glimmer-lora's (`gpu_1x_h100_pcie`, `gpu_1x_h100_sxm5`, `gpu_1x_a100_sxm4`), picked only in the adapter's region: `pickGpu(recipe.gpus, types, asked, [region], region)`. `usesCache: true`.
- Limits: `recipeDefaults(recipe, params)` fills in what the admin didn't ask for: the minutes plus `SERVE_BOOT_MINUTES` (15, to boot, mount the cache and load the model), and dollars for one minute more at `SERVE_SIZING_CENTS_PER_HOUR` ($4.29 an hour, an H100 SXM5, the priciest it may get), rounded up to the cent. 30 minutes gives 45 minutes and $3.29; the recipe's own `defaultMaxMinutes` and `defaultMaxUsd` are those. The ceilings cap them as for every job (`clampLimits`). With the default $5 ceiling a 60-minute demo needs 75 minutes but $5 allows 69 on an H100 SXM5, so the route refuses it there (`serveFitProblem`) and it fits on an A100 SXM4 or an H100 PCIe; the Start a live demo control warns about it.
- One open demo per adapter (409 `demo_running`). Two asked for at the same moment can both pass that check, so right after `createJob` the route asks `earlierOpenServeJob(adapterJobId, jobId)` (an open serve job of that adapter whose `(created_at, id)` is before the new row's own, in SQL, so a tie still has one winner); when there is one, the new job is marked failed ("Another live demo of this adapter started at the same moment, so this one was not launched.") and the reply is the same 409, so one demo always survives. `TRAIN_MAX_ACTIVE` still allows one GPU at a time, so a demo can't start while a job trains. A demo counts toward the daily cap at its full dollar limit like any job.

### Serving key, TLS pinning and what the browser sees

- The serving key is `serveKeyFor(jobId, tokenHash)` in `lib/train/serve.ts`: hex HMAC-SHA256 with `GATEWAY_TOKEN_PEPPER` of `serve:<jobId>:<tokenHash>`. The platform stores only the token's hash, so the key is never in the database: launchStep puts it in job.json as `serveKey` next to the job token (and blanks it out of launch errors as `[serving key]`), and the proxy derives it again from the job's row on each call. The runner blanks it out of every log line as `[serve key]`.
- The demo server answers only `Authorization: Bearer <serveKey>`, on every route.
- TLS: the child makes a new self-signed certificate with the openssl CLI at start (RSA 2048, 2 days, CN `localhost`, which says nothing about what serves it), and `certSha256` is the SHA-256 of its DER bytes in lowercase hex. The proxy connects with Node's `tls.connect` and `rejectUnauthorized: false` (no CA validation), compares the peer certificate's `fingerprint256` with the stored one in constant time (`certFingerprint` takes either form), and only then writes the HTTP request on that connection, so a server with another certificate never gets the key or the prompt (`pin_mismatch`). Fingerprint pinning is the only check.
- The address: a serving callback carries only the port and the fingerprint. `applyCallback` writes `serve_endpoint.ip` from `training_jobs.instance_ip`, the IP Lambda reports, and `setInstanceIp` keeps it in step when Lambda reports a new one, so a leaked job token can't point the proxy anywhere else. A later serving callback replaces the endpoint (a restarted server has a new certificate).
- The browser never gets the IP, the port, the key, the fingerprint or the serve job's id. The store's `getLiveDemo` (`LiveDemoView`: serve job id, state, minutes, endsAt) is mapped to `PublicLiveDemo` (state, minutes, endsAt) by `toPublicLiveDemo` in `components/train/results.ts` before the public page renders, and the proxy's replies are only answers or error codes. `TrainJobView.serving` (admin) is `{ startedAt, endsAt }`. The admin event log shows the serving callback with only the first 12 characters of the fingerprint.

### Firewall ruleset

- `ensureServeFirewall(region)` in `lib/train/lambda.ts` returns the ruleset `muse-muse-serve-<region>` (`serveFirewallName`), whose one rule (`serveFirewallRules`) lets in TCP 8443 from `0.0.0.0/0`. Nothing else: Lambda's spec says the global ruleset (`GET /firewall-rulesets/global`) holds "Firewall rules that apply across all regions", so SSH on a demo's GPU stays exactly as the owner set it there (narrowed to their own address, say), and the platform never opens port 22 to everyone. Port 8443 is open to every address because the proxy runs on Vercel, whose outbound addresses aren't fixed; the serving key, the pinned certificate and the server's per-connection deadline are what protect it.
- Idempotent like `ensureFilesystem`: it lists (`GET /firewall-rulesets`) and reuses a ruleset of that name in that region as it is while it lets 8443 in from everywhere, whatever else the owner added to it. When it no longer does (someone edited it in the console), one `PATCH /firewall-rulesets/{id}` sends its own rules with the 8443 rule appended, so the owner's other rules stay. Only a region with none gets one `POST /firewall-rulesets { name, region, rules }` (a 429 retried once). A duplicate, a 409, a timeout, a network error or a 5xx reads the listing once more and returns the ruleset when it is there; anything else is thrown. Never deleted: delete one by hand in the Lambda console when it is no longer wanted.
- launchStep calls it for glimmer-serve jobs only, after `findCacheFilesystem` and before the launch claim (a failure is a FatalError: "The live demo's firewall ruleset in <region> could not be found or created, so nothing was launched: ..."), and launches with `firewall_rulesets: [{ id }]`. Every other recipe launches without one and keeps Lambda's defaults. An adopted instance is never asked about again.

### The GPU side (lib/train/recipes/serve.ts)

- `SERVE_PY` is its own docstring, then glimmer-lora's Python as it is (`glimmerHelpers`: `GLIMMER_PY` without its docstring and its `__main__` block, which throws if `GLIMMER_PY` no longer has that shape), then the serve code. So the venv (and its build lock), the cache, the pinned model and revision, the chat template, `eval_prompt`, `final_answer` and the event relay are exactly training's. `glimmer.ts` is unchanged.
- `run(ctx)` fails before any GPU work when `adapterJobId` isn't a uuid, job.json has no `serveKey`, the cache isn't mounted or writable, `<cache>/models/<adapterJobId>/adapter_config.json` is missing (the adapter isn't in this region), it is a dry run's stand-in, there are no adapter weights, or fewer than 10 minutes are left to serve before `ctx.deadline` less 3 minutes (5 minutes, checked again once the venv is ready).
- The system line: `GET /dataset?part=train&page=0` (the dataset route pages a glimmer-serve job its adapter job's dataset), then `student_system(title, shared system)`, the line glimmer-lora's short student prompt trains with: "You are " and the dataset's title as a role, such as "You are the Muse Muse brief writer.", or "You are a helpful assistant." for a missing, long or task-start title. When the platform answers with an error status (the dataset is gone or not ready), both models answer under "You are a helpful assistant." and the log says so. An adapter trained with `studentPrompt` "full" still gets the short line. The line is in the job log and in the metrics (`system`).
- The child runs as `<venv>/bin/python -u recipe.py --serve serve-config.json` through `ctx.run`, like glimmer-lora's, with `HF_HOME=<cache>/hf` and `stall_seconds=1200`. Its config (with the key) is written 0600 and removed when it exits. It makes the certificate first, so a missing openssl fails in seconds, then `FastModel.from_pretrained(MODEL, revision=MODEL_REVISION, max_seq_length=2048)`, `PeftModel.from_pretrained(model, <cache>/models/<adapterJobId>, is_trainable=False)` and `FastModel.for_inference` (a failure there is logged and it answers without it).
- Each prompt is answered as glimmer-lora's eval answered its held-out prompts: `eval_prompt` (the template at low reasoning, under the system line, with the final channel opened), greedy, `max_new_tokens=400` (`SERVE_MAX_NEW_TOKENS`), the base model first inside `model.disable_adapter()`, then the tuned one. Both together get `SERVE_ANSWER_SECONDS` (100, equal to the constant in `lib/train/recipes/serve.ts`, and a test checks it plus the proxy's 10 s to connect fits its 120 s wait): the base `max_time` half of it (transformers' `MaxTimeCriteria`), the tuned what is left, and the tuned isn't started with under 5 s left (`TUNED_MIN_SECONDS`). So the GPU never keeps the lock answering a prompt the proxy gave up on. The answer is `final_answer`'s text; one that never closes, or that the clock stopped or never started, is "[Unfinished: no complete answer within 400 new tokens or the time limit. ...]" and the raw output with only the template's control tokens taken out.
- A visitor's prompt goes into the template as text, and the tokenizer reads special-token strings in text as real tokens, so `neutral_prompt` neutralizes them first, on the GPU: every `<|` becomes `< |` (every Glimmer template token starts with it, and `< |` can't make a new one), and any other special or added token the tokenizer has (`all_special_tokens`, `added_tokens_encoder`) is dropped, again until none is left, since dropping one can join the halves of another. A prompt can't close its user turn, forge a system message or open the assistant's answer.
- The server: HTTPS on `0.0.0.0:8443` (`SERVE_PORT`), TLS 1.2 or later, a thread per connection with the TLS handshake on that thread, at most 64 connections at once and 4 from one address (`MAX_CONNECTIONS`, `MAX_CONNECTIONS_PER_IP`; more are closed at once, before any handshake), and a 30 s socket timeout on each read or write. A connection must finish its handshake and send a whole request with the key within 10 s of being accepted (`REQUEST_DEADLINE_SECONDS`), or a `RequestDeadline` timer shuts it (the plain socket's shutdown, so a read blocked on it returns at once), however slowly it trickles bytes: a socket timeout starts again with every read, this doesn't. It is cancelled once the key checks out, so a slow answer is never cut off. So a stranger can hold a slot for 10 s at most, and four from one address, and can't lock the platform's proxy out. It reads a request's body before any reply, sends no Server header, and logs nothing about who asked or what.
  - `POST /generate { prompt }` -> 200 `{ base, tuned, ms }`, the prompt trimmed and cut to 600 characters (`PROMPT_MAX_CHARS`). One at a time (a lock): 409 `busy` while another is answered. 400 `bad_json` or `no_prompt`, 411 without a Content-Length, 413 over 16 KB, 503 `stopping` once its time is up, 500 `generation_failed` (logged; the server goes on, but 3 in a row, `FAILS_TO_STOP`, as a broken CUDA context gives, stop it at once with a note, "The demo server stopped after 3 live answers in a row failed (last: <error type>)", which fails the job, so the GPU doesn't bill for minutes nobody can use; an answer that works starts the count again).
  - `GET /health` -> `{ ok, busy, model, adapterJobId, served }`.
  - 401 `unauthorized` without the key, on every route; 404 for any other path.
- Once it listens, the child emits "serving" and the recipe posts `ctx.serving(port, certSha256, model, adapterJobId)`. When the platform doesn't take it, it is sent again with each "alive" event, 5 times in all, then the server stops (nobody could reach it) and the job fails. The child writes an "alive" event every minute, so the 20-minute stall watch never holds back the heartbeats while it waits for prompts; each answer becomes a progress message ("Serving live: N answered").
- It stops at whichever comes first, `ctx.deadline` less 180 s (`SERVE_MARGIN_SECONDS`, equal to `SERVE_STOP_MARGIN_SECONDS` in logic.ts) or its minutes after it started serving: the listener closes, an answer in progress gets up to 115 s to finish (`DRAIN_SECONDS`, a whole answer's budget and 15 s), and the child writes its result (`peak_vram_gb` null when torch.cuda itself fails) and exits. `run(ctx)` returns `adapter_job_id`, `served`, `busy_refused`, `unauthorized`, `bad_requests`, `errors`, `serve_minutes`, `load_seconds`, `max_new_tokens`, `system`, `gpu`, `peak_vram_gb`, `cached_weights`, `cached_venv` and a summary. A child that ends before serving fails the job with its last lines (and, from a reused venv with a `ModuleNotFoundError` before its imports, marks that venv broken as glimmer-lora does); one that ends while serving fails it with how many it answered.

### The platform side

- Events route: a `serving` callback is taken only from a glimmer-serve job (else 400), with `port` 8443 and `certSha256` a SHA-256 fingerprint (64 hex characters, or the colon form, stored lowercased); `model` and `adapterJobId` are cut to 200 characters. It counts as a sign of life and toward the 120 a minute, moves the job to running, writes `serve_endpoint` and is logged.
- `serve_endpoint` (jsonb, `ServeEndpoint`): `{ ip, port, certSha256, startedAt }`, `ip` null until Lambda reported one.
- `serveEndsAt(job)`: when serving is expected to stop, its minutes after `startedAt`, or launch plus `usableMinutes` less `SERVE_STOP_MARGIN_SECONDS` when that comes first (only the latter before it serves; null before launch). `toLiveDemoView(row, now)`: null once the job ended, a stop was asked for or `endsAt` passed; "live" when it is running with a usable endpoint (an IP, port 8443, a fingerprint, `usableEndpoint`); "starting" otherwise.
- `getLiveDemo(adapterJobId, now)` and `liveServeTarget(adapterJobId, now)` read the newest open serve job for the adapter (`params.adapterJobId`, not ended, no stop asked for). `liveServeTarget` (proxy only) returns `{ jobId, tokenHash, ip, port, certSha256 }` for a live one with a token.
- `POST /api/lab/{trainJobId}/try`, in order: 403 `cross_site` for a request from another site (`isCrossSite`, the same check signed-in writes use); 404 `no_live_demo` for an id that isn't a uuid; the body (JSON, at most 8 KB) and the prompt, trimmed, 1 to 600 characters (400 with a sentence); 404 `no_live_demo` when the job has no public result page (`getResultJob`: not judged yet) and the caller isn't an admin (`requireUser`, which confirms the flag against the database), the same reply as no demo, before any rate limit, so the access matches what Start a live demo says (only admins can try an unjudged job's demo); 404 `no_live_demo` when `liveServeTarget` finds none; 5 prompts per client IP (`x-real-ip`) in a fixed 10-minute window, key `lab-try:ip:<ip>` (429 `rate_limited`, `scope` "ip", `retryAfterSeconds`), counted before the slot, so a busy reply uses one of them; the demo's one slot (`takeDemoSlot`, key `lab-try-busy:<serve job id>` in `rate_limits`, 3-minute windows that also count the previous one, so a slot a crashed call never gave back clears within 6 minutes; 409 `busy`), given back in a `finally`; 60 prompts per demo per clock hour, key `lab-try:demo:<serve job id>`, counted only for prompts that got the slot (429, `scope` "demo"); then `askLive` with 120 s (`serveTiming.answerMs`). The GPU's 409, 423 or 429 is 409 `busy`; its 503 (time's up) is 404 `no_live_demo`; its 400, 413 or 422 is a 400 sentence; a timeout is 504 `timeout`; a pin mismatch, no connection, another error status or an answer that isn't `{ base, tuned, ms }` (or is over 256 KB) is 502 `demo_unavailable`. Each answer is cut to 8,000 characters; replies are `cache-control: no-store`. `maxDuration` is 150 s. Failures are logged with the serve job id and the error code, with the GPU's address blanked out.

### Pages

- The public result page of a glimmer-lora job reads `getLiveDemo` for it (a failure is logged and the page renders without the box) and, while one is starting or live, shows the Try it live box (`TryLiveCard`) first. Starting: a "Starting" pill, a line that the GPU boots and loads the model (up to about 15 minutes) before the box opens for N minutes, the button held, and the page refreshed every 15 s. Live: a "Live" pill and the minutes left, a textarea with an example placeholder, a 600-character cap and a counter, an "Ask both models" button, and the two answers side by side as plain text, labeled "Base Glimmer" and "Tuned Glimmer" (stacked on a phone), with how long the GPU took. The browser gives up after 150 s (`TRY_WAIT_MS`). Each error code has its own sentence (`tryErrorText`); when the time is up or the route says `no_live_demo`, the box says the demo ended and the page refreshes once. With no demo, guests see the page exactly as before.
- Admins: Start a live demo on the adapter's job page, and the serve job's own page (see Admin pages).

### Tests

Nothing calls Lambda, Meta or production; the GPU, Unsloth and PEFT are faked.

- `lib/train/__tests__/runner.test.ts`: `SERVE_PY` built on glimmer-lora's helpers unchanged, with the port, prompt cap, token budget, minutes bounds and stop margin equal to the TypeScript constants, and the recipe's registration; `run(ctx)` against a fake ctx and child (the private config, the system line, the serving callback, its retries and the stop, every early failure, a broken venv); the real server on fake Unsloth and PEFT with a real openssl certificate (the key on every route, health, base with the adapter disabled and tuned with it, the 600-character cap, unfinished answers, bad requests, a 500 it recovers from, one at a time, a drained shutdown, stopping at the deadline or after its minutes); a forged turn in a prompt rendered with no extra control token, and `neutral_prompt` on spliced tokens; each answer inside its time budget, with the tuned skipped and marked unfinished when the base used it up; slowloris clients (trickling after the handshake, or never starting it) shut at the request deadline while the platform's slow answer still arrives, and the per-address cap; 3 failed answers in a row stopping the server with the note that fails the job; minutes rounded down as `serveMinutes` does; a Node client that checks `fingerprint256` before sending the key, as the proxy does; and the runner's serving body, its key blanked out of logs and a bad port or fingerprint refused.
- `lib/train/__tests__/lab-try.test.ts` (skipped without openssl): two self-signed certificates and a local HTTPS server. The serving key's derivation, the pinned certificate accepted, a different one refused after the handshake with nothing received, the GPU's statuses mapped, the timeout and a closed port; then the route with the store, the rate limits and `requireUser` faked: the key from the token hash, cross-site and bad prompts refused first, an unjudged job's demo only for an admin (404 before any rate limit for anyone else), no demo, 5 per IP, 60 per demo hour, busy (the slot or the GPU), the GPU's time up, a wrong certificate, a timeout, and no reply naming the GPU.
- `lambda.test.ts` (the ruleset's one rule, create, reuse with the owner's own rules left alone, the patch that appends to them, and races, the launch body, `findCacheFilesystem`, `pickGpu`'s region pinning), `steps.test.ts` (the serve launch with the existing cache, the ruleset and the key, a missing cache or ruleset failing before the claim, the key blanked out of errors, adoption), `store.test.ts` on PGlite (the endpoint and its IP, the adapter listing, the live demo's state, the earlier of two demos by the database's own microseconds and a tie, the slot), `routes.test.ts` (serving callbacks, the serve job checks, minutes stored whole, the later of two simultaneous demos backing out, the dataset fallback), `logic.test.ts` and `userdata.test.ts` (the helpers above, and `serveKey` only in job.json).
- `components/train/__tests__/live.test.tsx` renders the box in each state, the plain-text answers, Start a live demo, the adapter select and the serve job's page; `tryLive.test.ts` runs the browser calls against a fake fetch and the box against the real proxy route with its store, rate limits and GPU faked; `pages.test.tsx` and `format.test.ts` cover the page reads and the text helpers.

### Not proven yet

Nothing here has run on a GPU or on Lambda. Still to see on a first real demo: Unsloth's 4-bit Glimmer with the adapter loaded by `PeftModel.from_pretrained` and `disable_adapter` giving the base model's answers; both answers of 400 tokens finishing well inside 120 s; the model loading within the 15 minutes of boot time from the cache; and that an attached ruleset adds to Lambda's global rules, as the spec's "apply across all regions" says (if it replaced them, SSH to a demo's GPU would be closed, which costs only debugging: the platform never needs SSH). Port 8443 is open to scanners for the demo's minutes: they get a TLS error or a 401, and a slow client holds a connection for 10 s at most, 4 from one address. Many addresses together could still fill the 64 slots for as long as they keep reconnecting; limiting the rule to the platform's outbound addresses would end that, if the hosting plan ever has fixed ones.
