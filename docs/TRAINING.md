# Fine-tuning on Lambda

Admin-only fine-tuning jobs that run on the owner's Lambda Cloud account. One job is one GPU instance: the platform launches it with a cloud-init script, the instance trains and reports back, and the platform always terminates it. Lambda bills by the hour from launch until termination, so termination is enforced from three sides: the job's workflow, the job's own "done" callback, and a sweep every 5 minutes. A job only starts while that sweep is configured and has run lately.

Shared types are in `lib/train/types.ts`. Tables are `training_jobs` and `training_events` in `lib/db/schema.ts` (migration `drizzle/0002_training_jobs.sql`).

## Secrets and trust

- `LAMBDA_API_KEY` stays on the platform (`env.lambdaApiKey`). It is never written into user data, an instance, a sandbox or a product.
- Each job gets a random job token (32 bytes, base64url). The instance gets it in its user data. The platform stores only `hashToken(token)` from `lib/gateway/tokens.ts` in `training_jobs.token_hash`. The token works only for that job's callback and upload routes, and only until 15 minutes after the job ends.
- User data is visible to anyone with access to the Lambda account. That is the owner, so the job token there is fine. Nothing else secret goes into it.
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
| Callback body | 16 KB, log text cut to 4 KB | events route |
| Callbacks per job (heartbeat, progress, log, artifact; never done or failed) | 120 a minute, then 429 `rate_limited` | events route |
| Artifacts per job | 50, then 409 `artifact_limit` | `ARTIFACTS_MAX` in `lib/train/store.ts` |
| One upload | 1 GB, one blob per grant | upload route |
| Upload grants per job | 20 an hour, and 5 GB declared an hour | upload route |
| Upload grant lifetime | 5 min plus 1 MB a second of the declared size, at most 30 min, never past `launchedAt + maxMinutes + 15 min` | upload route |
| Sweep: time and dollar backstop | `maxMinutes + 10 min`, `maxUsd * 1.1` | `lib/train/sweep.ts` |
| Sweep: stuck before launch | 15 min in queued or launching | `lib/train/sweep.ts` |
| Sweep: launched job left open (its workflow is gone) | 30 min past its time limit | `lib/train/sweep.ts` |
| Launch gate: the sweep's last good run | 15 min | `SWEEP_FRESH_MS` in `app/api/train/shared.ts` |

A job's limits are the lower of what the admin asked for, the recipe's defaults and the ceilings. Cost is `priceCentsPerHour / 100 * hours since launchedAt` (until `terminatedAt`), rounded up to the minute. A job is terminated when its time or dollar limit is reached. When a launch was never saved (Lambda timed out, or the database didn't answer), its clock starts at `createdAt`, which is earlier than the launch, so the limits and the cost are never measured short.

Jobs holding a GPU (compared with `TRAIN_MAX_ACTIVE`) are every job that hasn't ended plus every ended job with `launchedAt` set and no `terminatedAt`. Today's committed spend (compared with `TRAIN_DAILY_USD`) counts every unfinished job at its full dollar limit.

## Lifecycle

```text
POST /api/train/jobs (admin)          -> refused unless the sweep is configured and ran lately (see Routes),
                                         then row "queued", token not made yet, workflow started
trainJob workflow (lib/train/workflow.ts):
  launchStep   launches at most once per job: an instance already listed under instanceName is adopted
               (clock at createdAt); otherwise make the token and claimLaunch (queued -> "launching" with the
               token's hash, in one guarded update; only the holder of the claim launches); launch with user
               data; save instanceId and launchedAt (the time of the request), status "booting".
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
Instance (runner.py) -> POST /api/train/jobs/{id}/events with the job token:
  heartbeat (every 60 s), progress, log, artifact, done, failed
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

`buildUserData({ jobId, callbackBase, token, recipe, params, maxMinutes })` returns a `#cloud-config` document:

- `write_files`:
  - `/opt/muse/job.json` (0600): `{ jobId, callbackBase, token, params, maxMinutes, recipe }`
  - `/opt/muse/runner.py` (0755): `RUNNER_PY` from `lib/train/recipes/runner.ts`
  - `/opt/muse/recipe.py` (0644): the recipe's script
- `runcmd`: start `python3 /opt/muse/runner.py /opt/muse/job.json` detached, logging to `/var/log/muse-job.log`.

`callbackBase` is `${env.platformUrl}/api/train/jobs/${jobId}`. Creating a job is refused when `env.platformUrl` isn't public (`publicHost` from `lib/sandbox/policy.ts` is null), since the instance couldn't reach a local platform. The document must stay under 1 MB and must not contain `LAMBDA_API_KEY` or any other env secret.

## Runner and recipes (lib/train/recipes)

Python files are kept as TypeScript string constants (`String.raw`), so Vercel bundles them with no file tracing. Never use `${` or backticks in the Python.

- `runner.ts` exports `RUNNER_PY`. It uses only the Python standard library. It reads job.json, starts a heartbeat thread (every 60 s), imports `recipe.py` and calls `run(ctx)`. It then posts `done` with the returned dict as metrics, or `failed` with the last 3 KB of the traceback. Callbacks retry 3 times with backoff and never print the token. `ctx` has:
  - `params`
  - `log(text)`
  - `progress(step=None, total_steps=None, loss=None, message=None)`
  - `run(cmd, timeout=None)`, which runs a shell command, streams it to the log and posts its last lines as a log event
  - `upload(path, name, kind)`, which asks `POST {callbackBase}/upload` for a Blob client token, PUTs the file to Vercel Blob and posts an `artifact` event. It returns None when the platform answers 503 (no storage). It declares the type `mimetypes` names when the platform takes it (`UPLOAD_TYPES`, the same list as `TRAIN_UPLOAD_TYPES` in `lib/train/types.ts`) and `application/octet-stream` otherwise. A grant covers one blob that can't be written twice, so when Blob refuses a retried PUT or multipart complete (the first try may have landed before its answer was lost) it asks for a fresh grant and uploads once more.
  - `work_dir`
- `smoke.ts` exports `SMOKE_PY`. It reads `nvidia-smi` (GPU name, memory), checks that torch sees CUDA and runs a matmul on the GPU, and reads free disk. It also checks HTTPS reachability of huggingface.co and pypi.org, and sends 3 progress ticks 20 s apart. It returns those as metrics. With `params.allowNoGpu` truthy it tolerates a missing GPU, which is how the local test runs it.
- `index.ts` exports `RECIPES: Recipe[]` and `recipeById(id)`.

### smoke recipe

GPUs, in order: `gpu_1x_a10`, `gpu_1x_rtx6000`, `gpu_1x_a6000`, `gpu_1x_a100_sxm4`, `gpu_1x_a100`. Defaults: 30 minutes, $1. Params: none (`allowNoGpu` is internal).

## Lambda client (lib/train/lambda.ts)

Base `https://cloud.lambda.ai/api/v1`, `Authorization: Bearer env.lambdaApiKey`, 20 s timeout per call, one retry on 429 or 5xx with a 2 s wait. Errors throw `LambdaApiError(status, code, message)`. The key is never logged.

```ts
export interface LambdaInstanceType { name: string; description: string; priceCentsPerHour: number; gpus: number; regionsWithCapacity: string[] }
export interface LambdaInstance { id: string; name: string | null; status: "booting" | "active" | "unhealthy" | "terminated" | "terminating" | "preempted"; ip: string | null; instanceType: string; region: string; tags?: Array<{ key: string; value: string }> }
export async function listInstanceTypes(): Promise<LambdaInstanceType[]>              // GET /instance-types
export async function listInstances(): Promise<LambdaInstance[]>                      // GET /instances
export async function getInstance(id: string): Promise<LambdaInstance | null>         // GET /instances/{id}, null on 404
export async function findInstanceByName(name: string): Promise<LambdaInstance | null> // not terminated, from listInstances
export async function launchInstance(input: { name: string; instanceType: string; region: string; userData: string; sshKeyName: string; tags: Array<{ key: string; value: string }> }): Promise<string> // POST /instance-operations/launch, returns the instance id
export async function terminateInstances(ids: string[]): Promise<void>               // POST /instance-operations/terminate; a 404 or already-terminated is success
export function pickGpu(choices: GpuChoice[], types: LambdaInstanceType[], asked?: string): { instanceType: string; region: string; priceCentsPerHour: number } | null
```

`pickGpu` takes the asked type if it is one of the choices and has capacity; otherwise it takes the first choice with capacity. Regions starting with `us-` come first.

## Store and logic

`lib/train/store.ts` (database) and `lib/train/logic.ts` (pure, unit tested):

```ts
// logic.ts
export const BOOT_GRACE_MS = 25 * 60_000; export const SILENCE_MS = 10 * 60_000; export const POLL_MS = 30_000
export function estimateCostUsd(job: { priceCentsPerHour: number; launchedAt: Date | null; terminatedAt: Date | null }, now: Date): number
export function clampLimits(recipe: Recipe, asked: Partial<TrainLimits>, ceilings: TrainLimits): TrainLimits
export function validateParams(recipe: Recipe, raw: unknown): { ok: true; value: Record<string, string | number> } | { ok: false; error: string }
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
```

## Routes

| Route | Who | Does |
|---|---|---|
| `GET /api/train/jobs` | admin | `{ jobs: TrainJobView[], recipes: RecipeView[] }` |
| `POST /api/train/jobs` | admin or automation | body `{ recipe, title?, params?, instanceType?, maxMinutes?, maxUsd? }` -> 201 `{ job }`. 400 bad input, 409 `too_many_active`, 503 `lambda_not_configured`, `platform_not_public`, `sweep_not_configured` with `{ reason }` (`cron_secret_unset`, or `not_production` since Vercel runs crons only there; `TRAIN_ALLOW_OUTSIDE_PRODUCTION=1` lifts only the second, for a deliberate test), `sweep_not_running` with `{ lastSweepAt }` (no sweep run with Lambda's listing answering in the last 15 min; on a new deployment, wait for the first run or call the sweep once by hand), `no_capacity` (with `{ options }`), `daily_cap` |
| `GET /api/train/jobs/{id}` | admin | `{ job, events: TrainEventView[] }`, `?after=<event id>` for new events only |
| `POST /api/train/jobs/{id}/stop` | admin | on an open job: sets stopRequested and terminates the instance right away (best effort; the job ends as stopped). On an ended job whose instance isn't confirmed terminated: terminates it again, and the job keeps its status. So Stop can be pressed again until `terminatedAt` is set; when Lambda doesn't answer, the sweep terminates it within 5 minutes. 409 `already_ended` once terminated or if it never launched |
| `POST /api/train/jobs/{id}/events` | job token | `TrainCallback` body -> 204. 401 bad token, 400 not a callback, or an artifact URL that isn't this job's own upload (https on this deployment's Blob store, under `models/<jobId>/`, no query or credentials), 409 `job_ended` (except a late `log`; any other late callback also terminates the instance when it isn't confirmed terminated yet), 409 `artifact_limit`, 429 `rate_limited` |
| `POST /api/train/jobs/{id}/upload` | job token | `{ name, bytes, contentType }` -> `{ clientToken, pathname }`. Each token covers one blob: the platform picks `models/<jobId>/<12 random hex>-<safe name>`, with no random suffix and no overwrite, at most the declared bytes (1 GB max) and only the declared type, which must be on `TRAIN_UPLOAD_TYPES` (no HTML, SVG or XHTML, and no names ending in html, htm, xhtml, shtml, xml, svg or svgz). Lifetime as in Limits. 400 bad input, 409 `job_ended`, 413 `too_large`, 413 `upload_budget`, 429 `upload_limit`, 503 `no_storage` without BLOB_READ_WRITE_TOKEN |
| `GET /api/train/gpus` | admin | `{ options: GpuOption[] }` |
| `GET /api/cron/train-sweep` | CRON_SECRET | the sweep; `vercel.json` cron `*/5 * * * *`. Notes each run whose Lambda listing answered, for the launch gate |

## Admin pages

`/fine-tuning` (nav "Fine-tuning", in the Usage group) lists jobs in the Usage-style table: title, recipe, GPU, status pill, elapsed, cost, started. It also has a New job card: recipe select, params fields from the recipe, a GPU select from `/api/train/gpus` with price and capacity, and limits fields. `/fine-tuning/{id}` shows the job with the build-room layout: an event log on the left that polls every 5 s while the job isn't terminal, and a right panel with status, GPU, region, IP, limits, a running cost, progress, artifacts and a Stop button. Non-admins see an "Admins only" card. Visual rules: docs/UI_PATTERNS.md.

- Both pages confirm admin against the database (`pageViewer` in `app/fine-tuning/viewer.ts`, as `requireUser` does), so revoking `is_admin` takes effect without waiting for the cookie to expire.
- The New job card blocks Start, with a sentence saying why, when the route would refuse for the sweep (`sweep_not_configured` or `sweep_not_running`).
- Stop reads "Stop job", then "Try stop again" after a stop request, or "Shut down GPU" for an ended job whose GPU isn't confirmed gone. It goes away once `terminatedAt` is set.
- Artifact links open only this job's own folder on a Blob public host; any other URL shows as plain text.

## Testing without spending

Run them with `npx tsx --test --experimental-test-module-mocks lib/train/__tests__/*.test.ts` (the flag gives node:test `mock.module`; without it the mocked suites skip). Nothing calls Lambda or Neon.

- `lib/train/__tests__/logic.test.ts`: decideCheck, costs, limits and params.
- `lib/train/__tests__/lambda.test.ts`: the client against a faked fetch.
- `lib/train/__tests__/steps.test.ts`: the real steps with Lambda and the store faked: one launch per job under retries, duplicate runs and database errors; terminate by id before any database read; checks that ride out outages.
- `lib/train/__tests__/workflow.scenario.test.ts`: the workflow with steps faked, in the style of lib/pipeline/__tests__/workflow.scenario.test.ts.
- `lib/train/__tests__/sweep.test.ts`: the sweep with Lambda and the store faked, including a failed listing and renamed or tagged instances.
- `lib/train/__tests__/store.test.ts`: the store's SQL against an in-memory PGlite with the repo's migrations (holding a GPU, the daily cap, finishJob, the launch claim, the sweep's heartbeat, the upload budget).
- `lib/train/__tests__/routes.test.ts`: the job, events, upload, stop and sweep cron routes with their dependencies faked.
- `lib/train/__tests__/runner.test.ts`: compiles every Python string with `python3 -m py_compile`, then runs runner.py with the smoke recipe (`allowNoGpu`) against a local HTTP server standing in for the platform and for Vercel Blob. It checks the events, their order, the Authorization header, uploads (simple, multipart, media types, a fresh grant after a refused retry). It is skipped when python3 is missing.
- `lib/train/__tests__/userdata.test.ts`: cloud-config shape, size and no secrets.
- `components/train/__tests__/`: the page copy and the rendered cards.
