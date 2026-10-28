# Fine-tuning on Lambda

Admin-only fine-tuning jobs that run on the owner's Lambda Cloud account. One job is one GPU instance: the platform launches it with a cloud-init script, the instance trains and reports back, and the platform always terminates it. Lambda bills by the hour from launch until termination, so termination is enforced from three sides: the job's workflow, the job's own "done" callback, and a sweep every 5 minutes. A job only starts while that sweep is configured and has run lately.

Shared types are in `lib/train/types.ts`. Tables are `training_jobs` and `training_events` in `lib/db/schema.ts` (migration `drizzle/0002_training_jobs.sql`), plus `training_datasets` and `training_jobs.eval_summary` (migration `drizzle/0003_training_datasets.sql`).

A job can train on a dataset Muse Spark 1.3 wrote for a task (see Datasets). A recipe that does, such as `glimmer-lora`, answers the dataset's held-out prompts with the base and the tuned model and sends them back as eval items; once the GPU is shut down, Muse Spark 1.3 judges them (see Judging). A recipe can also keep its venv and model weights on a Lambda filesystem in the region (see Model cache).

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

A job's limits are the lower of what the admin asked for, the recipe's defaults and the ceilings. Cost is `priceCentsPerHour / 100 * hours since launchedAt` (until `terminatedAt`), rounded up to the minute. A job is terminated when its time or dollar limit is reached. When a launch was never saved (Lambda timed out, or the database didn't answer), its clock starts at `createdAt`, which is earlier than the launch, so the limits and the cost are never measured short.

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
               filesystem mounted); save instanceId and launchedAt (the time of the request), status "booting".
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
  heartbeat (every 60 s), progress, log, artifact, eval (before done), done, failed
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

`buildUserData({ jobId, callbackBase, token, recipe, params, maxMinutes, cacheDir? })` returns a `#cloud-config` document:

- `write_files`:
  - `/opt/muse/job.json` (0600): `{ jobId, callbackBase, token, params, maxMinutes, recipe }`, plus `cacheDir` (the cache filesystem's mount path) for a recipe with `usesCache`
  - `/opt/muse/runner.py` (0755): `RUNNER_PY` from `lib/train/recipes/runner.ts`
  - `/opt/muse/recipe.py` (0644): the recipe's script
- `runcmd`: start `python3 /opt/muse/runner.py /opt/muse/job.json` detached, logging to `/var/log/muse-job.log`.

`callbackBase` is `${env.platformUrl}/api/train/jobs/${jobId}`. Creating a job is refused when `env.platformUrl` isn't public (`publicHost` from `lib/sandbox/policy.ts` is null), since the instance couldn't reach a local platform. The document must stay under 1 MB and must not contain `LAMBDA_API_KEY` or any other env secret.

## Runner and recipes (lib/train/recipes)

Python files are kept as TypeScript string constants (`String.raw`), so Vercel bundles them with no file tracing. Never use `${` or backticks in the Python.

- `runner.ts` exports `RUNNER_PY`. It uses only the Python standard library. It reads job.json, starts a heartbeat thread (every 60 s), imports `recipe.py` and calls `run(ctx)`. It then posts `done` with the returned dict as metrics, or `failed` with the last 3 KB of the traceback. Callbacks retry 3 times with backoff and never print the token. `ctx` has:
  - `params`, `job_id`, `max_minutes`
  - `log(text)`
  - `progress(step=None, total_steps=None, loss=None, message=None)`
  - `run(cmd, timeout=None, check=False, env=None, on_line=None)`, which runs a shell command in `work_dir`, streams it to the log and posts its last lines as a log event. `env` adds variables for the command, and `on_line(line)` sees each output line as it arrives (its errors are logged, never raised). With `check=True` a non-zero exit raises
  - `upload(path, name, kind)`, which asks `POST {callbackBase}/upload` for a Blob client token, PUTs the file to Vercel Blob and posts an `artifact` event. It returns None when the platform answers 503 (no storage). It declares the type `mimetypes` names when the platform takes it (`UPLOAD_TYPES`, the same list as `TRAIN_UPLOAD_TYPES` in `lib/train/types.ts`) and `application/octet-stream` otherwise. A grant covers one blob that can't be written twice, so when Blob refuses a retried PUT or multipart complete (the first try may have landed before its answer was lost) it asks for a fresh grant and uploads once more.
  - `work_dir`
  - `cache_dir`: the mounted cache filesystem (job.json's `cacheDir`) once it is a folder, waiting up to 60 s for the mount (`cacheWaitSeconds` in job.json for tests), or None (with a log line) when there is none
  - `get_json(path_and_query)`: GETs `callbackBase + path` with the job token, the same retries as callbacks (429 and 5xx, 3 times) and no redirects. A status of 300 or more raises `PlatformError` (with `.status`)
  - `dataset(part)`: pages `GET {callbackBase}/dataset?part=train|eval&page=N` from page 0 until `nextPage` is null and returns every item. A job with no dataset answers 404 and a dataset that isn't ready 409, which raise
  - `eval(index, prompt, reference, base, tuned)`: posts `{ type: "eval", ... }` with each text field cut to 3,500 characters (and the longest shortened further if multibyte text would push the body past 15 KB). At most 60 per job; later calls only log and return False. Recipes send them before returning, so they land before "done"
- `smoke.ts` exports `SMOKE_PY`. It reads `nvidia-smi` (GPU name, memory), checks that torch sees CUDA and runs a matmul on the GPU, and reads free disk. It also checks HTTPS reachability of huggingface.co and pypi.org, and sends 3 progress ticks 20 s apart. It returns those as metrics. With `params.allowNoGpu` truthy it tolerates a missing GPU, which is how the local test runs it.
- `glimmer.ts` exports `GLIMMER_PY` (see "glimmer-lora recipe").
- `index.ts` exports `RECIPES: Recipe[]` and `recipeById(id)`.

### smoke recipe

GPUs, in order: `gpu_1x_a10`, `gpu_1x_rtx6000`, `gpu_1x_a6000`, `gpu_1x_a100_sxm4`, `gpu_1x_a100`. Defaults: 30 minutes, $1. Params: none (`allowNoGpu` is internal).

## Lambda client (lib/train/lambda.ts)

Base `https://cloud.lambda.ai/api/v1`, `Authorization: Bearer env.lambdaApiKey`, 20 s timeout per call, one retry on 429 or 5xx with a 2 s wait (a launch or a filesystem create retries only a 429). Errors throw `LambdaApiError(status, code, message)`. The key is never logged. Filesystems are only ever listed and created, never deleted (see Model cache).

```ts
export interface LambdaInstanceType { name: string; description: string; priceCentsPerHour: number; gpus: number; regionsWithCapacity: string[] }
export interface LambdaInstance { id: string; name: string | null; status: "booting" | "active" | "unhealthy" | "terminated" | "terminating" | "preempted"; ip: string | null; instanceType: string; region: string; tags?: Array<{ key: string; value: string }> }
export async function listInstanceTypes(): Promise<LambdaInstanceType[]>              // GET /instance-types
export async function listInstances(): Promise<LambdaInstance[]>                      // GET /instances
export async function getInstance(id: string): Promise<LambdaInstance | null>         // GET /instances/{id}, null on 404
export async function findInstanceByName(name: string): Promise<LambdaInstance | null> // not terminated, from listInstances
export async function launchInstance(input: { name: string; instanceType: string; region: string; userData: string; sshKeyName: string; tags: Array<{ key: string; value: string }>; fileSystemNames?: string[] }): Promise<string> // POST /instance-operations/launch, returns the instance id; file_system_names sent only when non-empty
export async function terminateInstances(ids: string[]): Promise<void>               // POST /instance-operations/terminate; a 404 or already-terminated is success
export function pickGpu(choices: GpuChoice[], types: LambdaInstanceType[], asked?: string, preferRegions: string[] = []): { instanceType: string; region: string; priceCentsPerHour: number } | null
// listFilesystems, ensureFilesystem, cacheRegions, cacheFilesystemName: see Model cache
```

`pickGpu` takes the asked type if it is one of the choices and has capacity; otherwise it takes the first choice with capacity in one of `preferRegions` (regions that already hold the model cache), then the first choice with capacity anywhere. Within a type, a preferred region comes first, then regions starting with `us-`. A type with no positive price is skipped.

## Store and logic

`lib/train/store.ts` (database) and `lib/train/logic.ts` (pure, unit tested):

```ts
// logic.ts
export const BOOT_GRACE_MS = 25 * 60_000; export const SILENCE_MS = 10 * 60_000; export const POLL_MS = 30_000
export function estimateCostUsd(job: { priceCentsPerHour: number; launchedAt: Date | null; terminatedAt: Date | null }, now: Date): number
export function clampLimits(recipe: Recipe, asked: Partial<TrainLimits>, ceilings: TrainLimits): TrainLimits
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
// eval items, judging and datasets: see Datasets and Judging
```

## Routes

| Route | Who | Does |
|---|---|---|
| `GET /api/train/jobs` | admin | `{ jobs: TrainJobView[], recipes: RecipeView[] }` |
| `POST /api/train/jobs` | admin or automation | body `{ recipe, title?, params?, instanceType?, maxMinutes?, maxUsd? }` -> 201 `{ job }`. A "dataset" param must name a dataset that exists and is ready. For a `usesCache` recipe the GPU is picked with `pickGpu(recipe.gpus, types, asked, await cacheRegions())`, and a `cacheRegions()` error falls back to no preference. 400 bad input (including a dataset that doesn't exist, is still being written or failed), 502 `lambda_unavailable`, 409 `too_many_active`, 503 `lambda_not_configured`, `platform_not_public`, `sweep_not_configured` with `{ reason }` (`cron_secret_unset`, or `not_production` since Vercel runs crons only there; `TRAIN_ALLOW_OUTSIDE_PRODUCTION=1` lifts only the second, for a deliberate test), `sweep_not_running` with `{ lastSweepAt }` (no sweep run with Lambda's listing answering in the last 15 min; on a new deployment, wait for the first run or call the sweep once by hand), `no_capacity` (with `{ options }`), `daily_cap` |
| `GET /api/train/jobs/{id}` | admin | `{ job, events: TrainEventView[] }` (`job.evalSummary` once judged), `?after=<event id>` for new events only |
| `POST /api/train/jobs/{id}/stop` | admin | on an open job: sets stopRequested and terminates the instance right away (best effort; the job ends as stopped). On an ended job whose instance isn't confirmed terminated: terminates it again, and the job keeps its status. So Stop can be pressed again until `terminatedAt` is set; when Lambda doesn't answer, the sweep terminates it within 5 minutes. 409 `already_ended` once terminated or if it never launched |
| `POST /api/train/jobs/{id}/events` | job token | `TrainCallback` body -> 204. 401 bad token, 400 not a callback, or an artifact URL that isn't this job's own upload (https on this deployment's Blob store, under `models/<jobId>/`, no query or credentials), 413 over 16 KB (64 KB for eval), 409 `job_ended` (except a late `log`; any other late callback also terminates the instance when it isn't confirmed terminated yet), 409 `artifact_limit`, 409 `eval_limit` with `{ max }`, 429 `rate_limited`. An eval item sent again with an index the job already has: 204, logged once (see Judging) |
| `GET /api/train/jobs/{id}/dataset?part=train\|eval&page=N` | job token | `{ items: TrainExample[] \| EvalExample[], nextPage: number \| null }` from the job's `params.datasetId`, at most 100 items a page, N from 0, nextPage null on the last page. The token rules are the events route's (until 15 min after the job ended). 400 bad part or page, 404 `no_dataset` (no dataset param, or the dataset is gone), 409 `dataset_not_ready`, 429 `rate_limited` past 120 pages an hour |
| `POST /api/train/jobs/{id}/upload` | job token | `{ name, bytes, contentType }` -> `{ clientToken, pathname }`. Each token covers one blob: the platform picks `models/<jobId>/<12 random hex>-<safe name>`, with no random suffix and no overwrite, at most the declared bytes (1 GB max) and only the declared type, which must be on `TRAIN_UPLOAD_TYPES` (no HTML, SVG or XHTML, and no names ending in html, htm, xhtml, shtml, xml, svg or svgz). Lifetime as in Limits. 400 bad input, 409 `job_ended`, 413 `too_large`, 413 `upload_budget`, 429 `upload_limit`, 503 `no_storage` without BLOB_READ_WRITE_TOKEN |
| `GET /api/train/gpus` | admin | `{ options: GpuOption[] }` |
| `GET /api/train/datasets` | admin | `{ datasets: DatasetView[] }`, newest first |
| `POST /api/train/datasets` | admin or automation | body `{ title?, task, count }` -> 201 `{ dataset }`, makeDataset workflow started. No title: the start of the task. 400 bad input, 503 `meta_not_configured` (no MODEL_API_KEY), 503 `paused` (daily spend cap), 500 `start_failed` (the dataset is failed) |
| `GET /api/train/datasets/{id}` | admin | `{ dataset, sampleTrain, sampleEval }`, the first 5 of each. While generating, sampleTrain is the first answered examples, before eval is held out |
| `GET /api/cron/train-sweep` | CRON_SECRET | the sweep; `vercel.json` cron `*/5 * * * *`. Notes each run whose Lambda listing answered, for the launch gate |

## Admin pages

`/fine-tuning` (nav "Fine-tuning", in the Usage group) lists jobs in the Usage-style table: title, recipe, GPU, status pill, elapsed, cost, started. It also has a New job card: recipe select, params fields from the recipe, a GPU select from `/api/train/gpus` with price and capacity, and limits fields. `/fine-tuning/{id}` shows the job with the build-room layout: an event log on the left that polls every 5 s while the job isn't terminal, and a right panel with status, GPU, region, IP, limits, a running cost, progress, artifacts and a Stop button. Non-admins see an "Admins only" card. Visual rules: docs/UI_PATTERNS.md.

- Both pages confirm admin against the database (`pageViewer` in `app/fine-tuning/viewer.ts`, as `requireUser` does), so revoking `is_admin` takes effect without waiting for the cookie to expire.
- The New job card blocks Start, with a sentence saying why, when the route would refuse for the sweep (`sweep_not_configured` or `sweep_not_running`).
- Stop reads "Stop job", then "Try stop again" after a stop request, or "Shut down GPU" for an ended job whose GPU isn't confirmed gone. It goes away once `terminatedAt` is set.
- Artifact links open only this job's own folder on a Blob public host; any other URL shows as plain text.

Datasets and eval results:

- `/fine-tuning` also has a Datasets table (dataset, examples, status, cost, created) and a New dataset card: the task (20 to 2,000 characters), an optional name, the number of examples (20 to 1,000), and a line with a rough cost and time and how many are held out (`datasetCostHint`). The card is blocked, with a sentence saying why, when the route would refuse (`meta_not_configured`, `paused`). The page refreshes every 10 s while a job is running or a dataset is being written.
- `/fine-tuning/datasets/{id}` shows a dataset: its status, counts and cost (examples answered so far while it is written), the task, the first 10 training conversations and every eval prompt with its reference, and a "Train on it" button on a ready one (`/fine-tuning?dataset=<id>#new-job`). `/fine-tuning/datasets` redirects to `/fine-tuning#datasets`.
- A dataset still "generating" 6 hours after it was made shows as "Stalled" (`DATASET_STALE_MS`): its workflow most likely died. It isn't refreshed for, and the New job card doesn't offer it.
- In the New job card a param of kind "dataset" is a select of ready datasets (ones still being written are listed but can't be picked); `?dataset=<id>` picks that one and the first recipe that takes a dataset. For a `usesCache` recipe, Auto reads "a free GPU near the model cache", and the cost estimate uses the priciest free GPU, since only the platform knows which regions hold the cache.
- The job page reads the whole event log (pages of 1,000, up to 20,000 events) and sends the browser every eval and judgement event plus the latest 1,500 others; runs of eval and judgement events fold into one log row each. The panel names the job's dataset with a link and has an Eval row.
- Eval results on the job page: a summary strip once judged (wins, ties, average scores, judging cost), and each item as a group of rows: the prompt across the full width, then the reference, the base and the tuned answer and the verdict, long text folded. While the job runs it says the items are being answered; after a job that succeeded it says "Judging..." and keeps polling until the summary arrives, a "Judging skipped:" or "Judging failed:" log line appears (`lib/train/judge.ts` writes those), or 20 minutes pass after the job ended (`JUDGE_WAIT_MS`).

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
- `lib/train/__tests__/userdata.test.ts`: cloud-config shape, size and no secrets, and `cacheDir` only when given.
- `lib/train/__tests__/datasets.test.ts` and `judge.test.ts`: see Datasets and Judging. `lambda.test.ts` and `steps.test.ts` also cover the filesystems, `pickGpu`'s region preference and the cache at launch; `runner.test.ts` runs the glimmer-lora recipe with `dryRun: 1` against the fake platform serving `/dataset` pages.
- `components/train/__tests__/`: the page copy and the rendered cards, including datasets and eval results.

All of it, with the component renders: `npx tsx --test --experimental-test-module-mocks $(find lib components -name '*.test.ts')` and `npx tsx --test --experimental-test-module-mocks components/train/__tests__/*.test.tsx`.

## Model cache (Lambda filesystems)

A recipe with `usesCache: true` (today only `glimmer-lora`) keeps its Python venv and model weights on a Lambda persistent filesystem, one per region, so the next job in that region skips the install and the 21 GB download. Filesystems bill by stored GB per month even with no instance running; the platform never deletes them (delete one by hand in the Lambda console when it is no longer wanted).

- Name: `muse-muse-cache-<region>` (`cacheFilesystemName(region)`, prefix `CACHE_FILESYSTEM_PREFIX`). Mounted at Lambda's default `/lambda/nfs/<name>` (the filesystem's `mount_point`).
- Job creation: the jobs route calls `pickGpu(recipe.gpus, types, asked, recipe.usesCache ? await cacheRegions() : [])`; a `cacheRegions()` error only drops the preference, it never refuses the job. An asked GPU type with capacity still wins (in a cache region when it has capacity there); otherwise the first recipe GPU with capacity in a cache region is taken, then the first with capacity anywhere.
- Launch: `launchStep` calls `ensureFilesystem(job.region)` after the adopt and in-flight checks and before the launch claim, then launches with `file_system_names: [name]` and puts the mount path in job.json as `cacheDir`. If the filesystem can't be listed or created, the launch fails with a FatalError ("The model cache filesystem in <region> could not be found or created, so nothing was launched: ...") and nothing is claimed or launched. An adopted instance (found by name on a retry) is never asked about again.
- `ensureFilesystem` is idempotent and never loops on a create: it lists, and creates with one `POST /filesystems` `{ name, region }` only when the region has none (a 429 is retried once, since nothing was made). A `global/duplicate`, a timeout, a network error or a 5xx reads the listing once more and returns the filesystem if it is there; anything else (a quota refusal, say) is thrown. A cache name found in another region is refused (`filesystem-in-wrong-region`).
- On the instance, the runner waits up to 60 s for `cacheDir` to be a folder and sets `ctx.cache_dir` to it, or to None (with a log line) when it never shows up (see Runner and recipes). A recipe also checks it can write there (root squash would refuse) and otherwise runs without the cache.

```ts
export const CACHE_FILESYSTEM_PREFIX = "muse-muse-cache-"
export interface LambdaFilesystem { id: string; name: string; region: string; mountPoint: string; inUse: boolean; bytesUsed: number | null }
export function cacheFilesystemName(region: string): string
export async function listFilesystems(): Promise<LambdaFilesystem[]>          // GET /filesystems
export async function ensureFilesystem(region: string): Promise<LambdaFilesystem> // GET, then at most one POST /filesystems; launchStep only
export async function cacheRegions(): Promise<string[]>                       // regions with a muse-muse-cache-<region>; throws LambdaApiError
export function pickGpu(choices, types, asked?, preferRegions?: string[])     // preferRegions: see "Job creation" above
// launchInstance input also takes fileSystemNames?: string[] (sent as file_system_names only when non-empty)
```

Cache layout, under `cacheDir` (or `/opt/muse` when a job has none):

| Path | What |
|---|---|
| `venvs/glimmer-<12 hex>/` | the uv venv; the hash covers the Python version and every install line, so changing a pin makes a new one. Ready once `.muse-ready` is in it |
| `uv/bin/uv`, `uv/python/` | uv itself and the uv-managed Python the venvs point at |
| `hf/` | `HF_HOME`: the model weights |
| `models/<jobId>/` | each job's saved LoRA adapter, kept after the upload |

## glimmer-lora recipe (lib/train/recipes/glimmer.ts)

A LoRA fine-tune of Muse Glimmer 30B on one dataset, then the dataset's held-out prompts answered by the base and the tuned model as eval items, for the platform to judge. It follows Unsloth's Muse Glimmer guide (unsloth.ai/docs/models/muse-glimmer and /train) and its Conversational Kaggle notebook (`Kaggle-Muse_Glimmer_(30B)-Conversational.ipynb`).

- GPUs, in order: `gpu_1x_h100_pcie`, `gpu_1x_h100_sxm5`, `gpu_1x_a100_sxm4`. `gpu_1x_gh200` is left out: it is arm64, and Unsloth documents arm64 only through a from-source Docker build (its DGX Spark Dockerfile), not the pip install below. Defaults: 150 minutes, $14, `usesCache: true`. These sit above the default ceilings (`TRAIN_JOB_MAX_MINUTES` 120, `TRAIN_JOB_MAX_USD` $5), so raise those to get them; a job is otherwise clamped to 120 minutes and $5.
- Params: `datasetId` (kind "dataset", required), `maxSteps` (default 120, 10 to 2000), `learningRate` (default 0.0002, 0.000001 to 0.01), `loraRank` (default 16, 4 to 128; `lora_alpha` is the same), `dryRun` (0 or 1, default 0). `dryRun: 1` is also the cheap first check on a real GPU: it launches, mounts the cache, pages the dataset, sends the eval items (which get judged) and uploads a stand-in adapter, in a few minutes of GPU time.
- Install (once per region and pin set): uv (Astral's installer into the cache), `uv venv --relocatable --python-preference only-managed --python 3.12`, then the notebook's pins as `uv pip install` lines: `torch torchvision torchaudio xformers --index-url https://download.pytorch.org/whl/cu128`, `unsloth`, `--no-deps --upgrade "torchao>=0.16.0"`, `transformers==5.15.0`, `--no-deps trl==0.22.2`. It checks transformers is 5.15.0, writes `.muse-ready`, and renames the venv into place, so a half-built venv is never reused and two jobs building at once don't clash.
- The runner imports recipe.py with the system python, so its top level is standard library only. The GPU work runs as `<venv>/bin/python -u recipe.py --child glimmer-config.json` through `ctx.run`, with `HF_HOME=<cache>/hf`. The child prints `MUSE_EVENT {...}` lines, which the recipe turns into progress events (training every 10 steps with the loss, plus phase messages); results come back in `work/glimmer-result.json`.
- The child: `FastModel.from_pretrained("unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit", max_seq_length=2048)`; `FastModel.get_peft_model` with language, attention and MLP modules (vision frozen), `r = lora_alpha = loraRank`, dropout 0, bias "none", `use_gradient_checkpointing="unsloth"`, seed 3407. Text goes through the model's own ATEM chat template with the leading `<|begin_of_text|>` removed, and `reasoning_strength="low"` for both the training text and the eval prompts (reasoning tokens count against the 512 new tokens). The eval prompts are answered under the system message every training conversation shares (`datasetSystemPrompt(task)` for a platform dataset; none when they differ), so both models see what training saw. Base answers first (a fresh LoRA adds zero), greedy, `max_new_tokens=512`, batches of 8, left padded; the answer is the text on the `to=user` channel, or "[no final answer within 512 new tokens]". Then `SFTTrainer` with the notebook's `SFTConfig` (batch 1, gradient accumulation 4, warmup 5, `max_steps=maxSteps`, `learning_rate`, `loss_type="nll"`, `adamw_8bit`, weight decay 0.001, linear schedule, `save_strategy="no"`) and `train_on_responses_only(instruction_part="<|start|>user<|message|>", response_part="<|start|>assistant to=user<|message|>")`. Then the tuned answers, and the adapter saved with `save_pretrained` to `<cache>/models/<jobId>/`.
- The recipe then sends one eval item per held-out prompt (a dataset holds out at most 40; the recipe and the runner stop at 60), uploads the adapter folder as `glimmer-lora-<job id start>.tar.gz` (kind "adapter") when storage is available and it is under 1 GB (a failed upload is logged, not fatal), and returns metrics: `train_loss_final`, `steps`, `train_seconds`, `peak_vram_gb`, `gpu`, `eval_items`, `train_examples`, `cached_weights` and `cached_venv` (yes or no), `cache_used`, `adapter_dir`, `adapter_uploaded`, `adapter_mb`, `adapter_url` when uploaded, and a summary.
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
                       Prompts over 1,500 chars are dropped. Under 16 different prompts fails the dataset.
  answerChunkStep      x ceil(prompts / 24): 6 calls at a time, instructions datasetSystemPrompt(task) (answers under
                       about 350 words), effort low, max_output_tokens 3000, 90 s each. An answer that failed, came
                       back incomplete or empty, or is over 4,000 chars is skipped, not cut. Em dashes are taken out.
                       The answered ones are appended to `train` as {messages: [system, user, assistant]} only when the
                       dataset holds exactly the offset the workflow expects, so a retry of a chunk that was saved
                       asks and pays for nothing. A chunk with no usable answer is retried after 30 s, 3 times;
                       up to 2 such chunks are left out, and a third fails the dataset.
  finishDatasetStep    one statement: the items at evalIndexes(n) move to `eval` as {prompt, reference}, the rest stay
                       in `train`, counts set, status "ready". Under 16 answered examples fails the dataset instead.
  failDatasetStep      on any error: status "failed" with the error's first line.
```

- Eval holds out 10% of the answered examples, at least 8 and at most 40, always leaving at least 8 to train on (`evalHoldoutCount`). They are spread evenly through the list (`evalIndexes`), so every batch's style is in it, and the split is deterministic.
- Every training example's system message is `datasetSystemPrompt(task)`, the same instructions the answers were written with. Eval items carry only the prompt and Muse Spark 1.3's answer as the reference; glimmer-lora answers them under the training examples' shared system message.
- Every Meta call is recorded with `recordUsage({ source: "platform", endpoint: "responses" })` and added to `cost_usd`; a structured reply that never matched the schema is still recorded. Each model step checks `spendPaused()` first and fails the dataset ("The platform's daily spend cap is reached, so the dataset stopped.") once the cap is reached.
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
failDatasetStep, stylesFor(batch, batches), DATASET_MODEL, PROMPT_BATCH (25), ANSWER_CHUNK (24), ANSWER_CONCURRENCY (6)
// store.ts
createDataset({ title, task, requested, createdBy? }), getDataset(id), listDatasets(limit), attachDatasetRun(id, runId),
datasetPage(id, part, offset, limit) -> { status, total, items } (sliced in SQL),
datasetProgress(id) (examples held while generating, else null), appendTrainExamples(id, offset, items) (only at offset),
addDatasetCost(id, usd), finishDataset(id, count) (the eval split), failDataset(id, error) (only while generating)
// logic.ts
evalHoldoutCount(n), evalIndexes(n), promptKey(text), dedupePrompts(existing, incoming, max), datasetSystemPrompt(task),
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
                         has a summary; nothing, with a log line, when MODEL_API_KEY isn't set or the spend cap is reached
  judgeStep x n, 4 at once   Muse Spark 1.3, structured output, effort low; usage recorded, then a "judgement" event
  saveEvalSummaryStep    eval_summary on training_jobs and a log line; with nothing judged, only a log line
```

- Judging starts only after `terminate` returned, so it never keeps a GPU billing, and nothing in it can change the job's status: a judge step that fails is left out of the summary, and an error in judging as a whole is swallowed.
- The judge sees the user message, the reference, and the two answers blind as A and B: the base model's is A on even indexes and B on odd ones, so neither labels nor position favor one model. It returns `{ note, scoreA, scoreB, better: "A" | "B" | "tie" }`; scores are clamped to whole numbers from 1 to 10 and the note is cut to 30 words. The verdict is logged as `{ type: "judgement", index, baseScore, tunedScore, better: "base" | "tuned" | "tie", note }`. When the scores differ, `better` follows them; when they are equal the judge's own pick stands.
- `judgeStep` is safe to run again: an item that already has a judgement is returned as it is, at no cost, without asking Meta. Usage is recorded (`source "platform"`, endpoint `responses`) before the judgement is logged. A reply that never matched the schema is recorded and not retried.
- `EvalSummary` (`training_jobs.eval_summary`, `TrainJobView.evalSummary`): `items, tunedWins, baseWins, ties, avgBaseScore, avgTunedScore` (hundredths) and `judgeCostUsd`, the sum of what the judge steps cost (an item judged again after a crash counts at 0).

```ts
// logic.ts
EVALS_MAX = 60, EVAL_TEXT_MAX = 3500, judgeScore(n), betterOf(baseScore, tunedScore, said), summarizeJudgements(items)
// store.ts
recordEvalEvent(jobId, body, max?) -> "recorded" | "duplicate" | "limit", listEvalIndexes(jobId), getEvalItem(jobId, index),
getJudgement(jobId, index), setEvalSummary(jobId, summary)
```

Tests (nothing calls Meta, Lambda or Neon):

- `lib/train/__tests__/datasets.test.ts`: makeDataset and its real steps with the store, Meta, the spend cap and usage faked: batches and their styles, de-duplication and the extra-batch bound, 6 answers at a time in chunks of 24, skipped answers, usage and cost, the eval split, the spend cap, a retried chunk that asks and pays for nothing.
- `lib/train/__tests__/judge.test.ts`: the blind order and the mapping back, better against the scores, the cleaned reply, usage before the judgement, an item already judged, the skips, the summary.
- `lib/train/__tests__/store.test.ts`, `routes.test.ts`, `workflow.scenario.test.ts` and `logic.test.ts` cover the SQL (one eval per index, the cap, appending at the offset, the split, paging), the routes above, judging only after terminate (4 at once, never changing the status) and the pure helpers.
