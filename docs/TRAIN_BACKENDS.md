# Training backends: one fine-tune job on Lambda, Modal, Baseten or Fireworks

Written Oct 31, 2026 on branch `tg-train-align`. Nothing was launched or spent. Credentials were checked by name only;
no values were read.

Code references are to `lib/train` at `37d5ad1`. KRL means `~/muse-muse/docs/KNOWLEDGE_RUN_LOG.md` on main (`5f2acbe`).

Read with:

- `docs/GLIMMER_ALIGNMENT.md`: what the recipe should train.
- `docs/TRAINING.md`: the lab today.
- tg-decide `docs/DECISION_MODELS.md` section 5: the Fireworks export test, defined once there.

Tags: [V] verified in docs or code, [L] likely, [I] estimate or inference, not measured.

## In one minute

- **Lambda works today.** It is the only host where the Glimmer recipe has really run: an A100 40 GB, 47 minutes,
  $1.59 (`docs/VIBE_TUNING.md:60`).
- **Modal and Baseten can run our own recipe as it is, inside a container.** Each needs a backend adapter on the
  platform side and no new Python. Only `glimmer-serve` and the cloud-init bootstrap are tied to Lambda.
- **Fireworks can't run our recipe.** It is a managed SFT API with its own trainer, template rendering and loss
  masking. Use it only after the export test passes. That matches the owner's Oct 30 worry about exporting a model
  trained there (tg-decide `docs/DECISION_MODELS.md` section 5).
- **Recommended path:**
  1. A `TrainBackend` seam, as a pure refactor.
  2. Modal: cheapest per hour, a TypeScript SDK and a hard per-job timeout.
  3. Baseten, if a second container host is wanted.
  4. The Fireworks export test.
- **Every code change waits until `tg-decide` lands** (see "What waits for tg-decide"). For the Nov 4 submission,
  Lambda stays the only live backend.

## How one job runs today (Lambda)

1. **The jobs route prices the GPUs.** It calls `listInstanceTypes`, `pickGpu` and `cacheRegions`
   (`app/api/train/jobs/route.ts:6`).
2. **`launchStep` gets the box ready and launches it** (`steps.ts:326-417`):
   - It makes sure the region's cache filesystem and the serve firewall exist (`steps.ts:248, 262`).
   - It builds cloud-init user data with `job.json`, `runner.py` and `recipe.py` (`userdata.ts:70-104`).
   - It launches with tags `muse-muse` and `muse-muse-job` (`steps.ts:386-398`).
3. **The box runs `runner.py`.** The runner posts heartbeat, progress, log, artifact, eval, done and failed callbacks to
   `{callbackBase}/events`. It pages `/dataset`, uploads through `/upload` and asks `/hub` for Hub URLs
   (`runner.ts:6-22, 313-327`).
4. **`checkStep` polls Lambda every 30 s** (`steps.ts:438-462`). `decideCheck` then applies the heartbeat and limit
   rules (`docs/TRAINING.md:40-54`).
5. **The platform terminates the box,** on done, failed, stop or a limit (`steps.ts:472-529`). A 5-minute sweep backs
   this up (`sweep.ts:198`). The box can't stop its own billing (KRL:27).

## Where Lambda is wired in

| File | Lambda calls |
|---|---|
| `lib/train/steps.ts:19-32` | ensureFilesystem, ensureServeFirewall, findCacheFilesystem, findInstanceByName, getInstance, launchInstance, listInstances, terminateInstances |
| `lib/train/sweep.ts:16, 49-64` | listInstances, getInstance, terminateInstances. These are already injected as `TrainSweepDeps` |
| `lib/train/logic.ts:7` | the `LambdaInstance` type in `decideCheck` |
| `app/api/train/jobs/route.ts:6` | listInstanceTypes, pickGpu, cacheRegions |
| `app/api/train/gpus/route.ts:3` | listInstanceTypes |
| `app/api/train/jobs/[id]/stop/route.ts:3`, `events/route.ts:4` | terminateInstances |
| `app/api/train/shared.ts:6` | the `LambdaInstanceType` type |
| `lib/train/userdata.ts:70-104` | the cloud-init document (Lambda's `user_data`) |
| `lib/train/recipes/index.ts:19-47` | GPU lists use Lambda instance names (`gpu_1x_a100_sxm4`) |
| `lib/train/logic.ts:94-102` | cost is `priceCentsPerHour` times started minutes |
| `lib/train/recipes/serve.ts:83-84`, `lambda.ts:521-640` | the live demo: the box's public IP, port 8443 opened by a Lambda firewall ruleset, a pinned self-signed certificate |

## The TrainBackend seam

**Where it goes:** a new `lib/train/backends/` folder. `lambda.ts` stays as it is, wrapped by `backends/lambda.ts`. The
callers above switch from Lambda functions to `backendFor(job)`. This is a design; nothing is built.

```ts
// lib/train/backends/types.ts (design)
export type BackendId = "lambda" | "modal" | "baseten" | "fireworks";
export interface Offer { gpuClass: string; sku: string; region: string; priceCentsPerHour: number; available: boolean }
export interface JobBundle { jobJson: string; runnerPy: string; recipePy: string; cacheMount?: string; inboundPort?: number }
export interface RunStatus { state: "starting" | "running" | "gone" | "unknown"; endpoint?: string | null }

export interface TrainBackend {
  id: BackendId;
  kind: "container" | "managed";                         // managed = Fireworks: no runner, the workflow reports for it
  offers(recipe: Recipe): Promise<Offer[]>;                // capacity and price
  launch(job: LaunchInput, bundle: JobBundle): Promise<{ ref: string; launchedAt: Date }>; // idempotent by job name
  status(ref: string): Promise<RunStatus>;                 // feeds decideCheck in place of LambdaInstance
  events(ref: string, since?: Date): Promise<string[]>;    // provider logs; the runner's callbacks stay the main channel
  artifacts(job: TrainJobRow): Promise<ArtifactRef[]>;     // where the adapter lives
  cancel(refs: string[]): Promise<void>;                   // terminate or stop; safe to repeat; gone counts as done
  listOurs(): Promise<RunRef[]>;                           // by tag or name, for the sweep
  costSoFar(job: TrainJobRow, now: Date): number;          // price x time, plus what the host adds
}
```

### How each method maps onto each host

| Method | Lambda (today) | Modal | Baseten | Fireworks |
|---|---|---|---|---|
| launch | `launchInstance` with `buildUserData` (`lambda.ts:329`, `userdata.ts:70`) | Create a GPU Sandbox with image, gpu, `timeoutMs`, volume, name and tags. Write the three files, then run `python3 -u runner.py job.json` | `POST /v1/training_projects/{id}/jobs` with `base_image`, `start_commands`, env and `cache_config` | Create the dataset and upload it. `POST .../supervisedFineTuningJobs` with an explicit `loraRank`, then read it back |
| status | `getInstance` (`lambda.ts:287`) | Sandbox poll (`sandboxes.fromId`) | GET the job | GET the job's state |
| events | none off the box | Sandbox stdout and stderr | `.../logs` | the job's state and metrics |
| artifacts | `<cache>/models/<jobId>` on the region NFS, plus Blob and Hub uploads | the same path on a Modal Volume | the same path under `BT_PROJECT_CACHE_DIR`; checkpoint URLs last 7 days | signed URLs from `getDownloadEndpoint` |
| cancel | `terminateInstances` (`lambda.ts:371`) | `sandbox.terminate` | `POST .../jobs/{id}/stop` | cancel the job |
| listOurs | `listInstances` with tags (`lambda.ts:271`) | list by tags | the jobs in one `muse-muse` project | the jobs by display name |
| costSoFar | price x started minutes (`logic.ts:94-102`) | per-second GPU, plus CPU and memory | per-minute wall clock | $0 during the promotion, else tokens x price |

### Other parts of the seam

- **Job row.** Add a `backend` column, default `lambda`, so existing rows stay Lambda. `instanceType` becomes a SKU
  string for each backend. Use the next free migration number: 0017 to 0019 are taken on `tg-decide` and the
  `tg-cap-*` branches.
- **GPU classes.** Recipes ask for a class: a100-40, h100-80, a10-24, or "any 24 GB or more". Each backend maps the
  class to its own SKU and price. `runEstimate` keys its step times by class (`logic.ts:662-674`), using Lambda's
  numbers until another host is measured.
- **Bootstrap.**
  - One `JobBundle` builder replaces the inline files in `buildUserData`.
  - Lambda wraps the bundle in cloud-init.
  - Modal writes the files through the Sandbox filesystem.
  - Baseten has two options: a start command that decodes the bundle from an env var, or a new token-gated
    `GET /api/train/jobs/{id}/bundle`.
  - `runner.py` already takes the `job.json` path and a `workDir` (`runner.ts:1406-1435`), so `/opt/muse` isn't
    required.
- **Callbacks.** Unchanged. The platform URL must be public https (`userdata.ts:48`) on every host.
- **Cache.** `cacheDir` points at the host's volume. Use a volume only the lab writes to: on the shared Lambda cache,
  a lab job retired the knowledge pipeline's venv (KRL:875). With `TRAIN_MAX_ACTIVE` at 1 there is one writer at a
  time.
- **Follow-on jobs.** Publish, quantize and serve must run on the backend and volume that hold the adapter, so
  `AdapterOption` gains `backend`.
- **Billing ends on its own [L].** On Modal and Baseten the job ends when `runner.py` exits, which Lambda never does.
  The platform still terminates every job anyway.

## What runs unchanged, and where

| Part | Lambda | Modal (Sandbox) | Baseten (Training Job) | Fireworks (managed SFT) |
|---|---|---|---|---|
| `runner.py` and its callbacks | runs | runs: python3 and HTTPS out | runs | not used |
| `glimmer-lora` (`GLIMMER_PY`) | runs, measured | runs as is [L], given an x86_64 CUDA container with python3, a driver new enough for cu128 wheels and a writable cacheDir. Untested under gVisor | runs as is [L], same needs | can't run: Fireworks trains with its own stack |
| `glimmer-publish` | runs | runs on the adapter's volume | runs on the project cache | n/a |
| `glimmer-quantize` (220 GiB RAM, 512 GiB disk: `recipes/index.ts:59-65`) | runs (never run on a real GPU: `docs/TRAINING.md:770`) | container limits not checked | not checked | n/a |
| `glimmer-serve` (IP, port 8443, pinned cert) | runs (never run on a real GPU: `docs/TRAINING.md:557-559`) | needs a tunnel mode with an encrypted port and the serve key | not in a training job; needs a separate Truss deployment | dedicated deployment, $8/h |
| `smoke` | runs | runs | runs | n/a |
| cloud-init (`userdata.ts`) | Lambda only | replaced | replaced | n/a |

## Per provider

### Lambda (today)

- **What works for Glimmer [V]:**
  - Everything in the lab.
  - The measured run: an A100 40 GB, 42 to 47 minutes, $1.39 to $1.59 (`docs/VIBE_TUNING.md:60`).
  - GH200 is left out, because Unsloth on arm64 needs a source build (`recipes/index.ts:76`).
- **GPU and price** ([pricing](https://lambda.ai/pricing)):
  - A100 SXM4 40 GB: $1.99/h
  - H100 PCIe: $3.29/h
  - H100 SXM: $4.29/h
  - GH200: $2.29/h
  - B200: $6.99/h
  - Billed per minute until terminate, with no egress charges
    ([billing](https://docs.lambda.ai/public-cloud/billing/)).
- **Credentials:**
  - `LAMBDA_API_KEY` is in both `muse-muse-builds/.env.local` and `~/muse-muse/.env.local`.
  - The SSH key name is `TRAIN_SSH_KEY_NAME`, with a built-in default (`steps.ts:96-98`).
- **Artifacts:**
  - The adapter is on the region's NFS (`docs/TRAINING.md:296-327`), with Blob uploads through the platform.
  - The Hub path needs `HF_TOKEN`, which is in neither env file.
- **Caps and kill switches:**
  - The `TRAIN_*` ceilings (`lib/env.ts:227-243`).
  - A 30 s workflow poll.
  - Heartbeat rules: 25 minutes to boot, 10 minutes of silence.
  - The sweep, at `maxMinutes + 10` or `maxUsd x 1.1` (`docs/TRAINING.md:40-54`).
  - Lambda itself has no spend cap.
  - Small fix: Lambda allows 1 launch per 12 s, but our 429 retry waits 2 s (`lambda.ts:40`). Retry after 12 s.
- **Data terms:** not read in this pass.
- **Smoke test:** nothing needed for readiness. The alignment run N1 costs about $1.59.

### Modal

- **What works for Glimmer:**
  - No Glimmer offering. Jobs pull the public Hugging Face weights, which need no token [V].
  - GPU Sandboxes can be created from TypeScript with the `modal` npm SDK, which needs Node 22 or newer. Our
    `package.json` already requires that (`package.json:56-57`).
  - The SDK supports [V]:
    - creating a Sandbox with gpu, `timeoutMs`, `idleTimeoutMs`, command, secrets, volumes, `encryptedPorts`, name
      and tags
    - `images.fromRegistry` and `volumes.fromName`
    - filesystem access, `exec` and `terminate`
    - `sandboxes.fromId` and listing by tags
  - GPU Sandboxes run only on gVisor. Unsloth and bitsandbytes haven't been tried there.
  - Don't use Modal Functions for the runner. GPU Functions are always preemptible and restart on the same input
    ([preemption](https://modal.com/docs/guide/preemption)), and our runner can't restart.
- **GPU and price** ([pricing](https://modal.com/pricing)):
  - A100 40 GB: about $2.10/h
  - A100 80 GB: about $2.50/h
  - H100: about $3.95/h. Use `H100!` to stop a free upgrade to H200.
  - L40S: about $1.95/h
  - A10: about $1.10/h
  - CPU and memory are billed per second on top.
  - Egress: $0.04/GiB.
  - Volumes: free up to 1 TiB.
  - The Starter plan includes $30 a month.
  - Sandboxes run up to 24 h ([sandboxes](https://modal.com/docs/guide/sandboxes)).
- **Credentials:**
  - `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` are in neither env file.
  - `~/.modal.toml` exists, so the CLI here is signed in. The platform on Vercel still needs that env pair.
- **Artifacts:**
  - Use a v2 Volume: no inode cap, and it suits the uv venv and the HF cache
    ([volumes](https://modal.com/docs/guide/volumes)). The adapter goes at `models/<jobId>`.
  - Writes need a commit before other containers see them, and the smoke test must show the next Sandbox does.
- **Caps and kill switches:**
  - `timeoutMs` is a hard stop on Modal's side for each job, which Lambda lacks.
  - Our sweep lists Sandboxes by tag.
  - The owner can set a workspace spend limit in the dashboard ([budgets](https://modal.com/docs/guide/budgets)).
    Setting it by API isn't documented.
- **Data terms:** not read in this pass.
- **Smoke test (one test in two stages, none run):**
  - **Stage 1:** the `smoke` recipe in an A10 Sandbox for at most 10 minutes, about $0.20 plus CPU and memory [I].
    It proves:
    - launch from our code
    - file delivery
    - callbacks
    - terminate
    - tag listing
    - the driver version
  - **Stage 2:** if stage 1 passes, `glimmer-lora` with `maxSteps` 10 and `publish` 0 on a 40-row dataset, on A100 40 GB.
    That is about 47 minutes with the cold venv and download, about $1.65 plus CPU and memory [I]. It proves:
    - Unsloth under gVisor
    - the venv on the Volume
    - that the adapter is visible to the next Sandbox
  - **Total:** about $2.30 [I].

### Baseten

- **What works for Glimmer:**
  - Training Jobs run a container we define. The fields are `image.base_image`, compute (H100 or H200 only, dedicated
    or spot), and `runtime` (`start_commands`, environment variables or `SecretReference`, `cache_config`,
    `checkpointing_config`) [V].
  - There is a full REST API: create a project and jobs, stop, logs, checkpoint files and download (Baseten
    management API; [training SDK](https://docs.baseten.co/reference/sdk/training)).
  - Baseten Loops, its managed LoRA product, doesn't list Glimmer
    ([supported models](https://docs.baseten.co/loops/supported-models)).
  - Serving a tuned model needs a custom-server Truss running Meta's vLLM image on a merged BF16 model. That needs about
    72 GB, so an H100 80 GB or a B200. Neither route has been tried.
- **GPU and price** ([pricing](https://www.baseten.co/pricing/)):
  - H100: about $6.50/h
  - B200: about $9.98/h
  - H200 is about $7.50/h, from third-party reads only.
  - Billed per minute of wall-clock time.
  - Training can't use an A100.
- **Credentials:**
  - `BASETEN_API_KEY` is in `~/muse-muse/.env.local` only, not in `muse-muse-builds/.env.local`.
- **Artifacts:**
  - Set `cacheDir` to `BT_PROJECT_CACHE_DIR`, the read-write cache. The adapter goes at `models/<jobId>` there.
  - Checkpoint download URLs last 7 days ([deployment](https://docs.baseten.co/training/deployment)).
- **Caps and kill switches:**
  - Training jobs have no max-runtime field.
  - "Enforce budget" never stops training jobs ([billing](https://docs.baseten.co/organization/billing)).
  - So the hard stops are the runner's own deadline, the job ending when `runner.py` exits [L], and our sweep calling
    stop.
  - An org admin can cap concurrent GPUs per team through `PATCH /v1/training/capacity`. Set it to 1 H100.
- **Data terms:** not read in this pass.
- **Smoke test (none run):**
  - The `smoke` recipe as a Training Job on 1x H100 for at most 10 minutes, about $1.10 [I].
  - It proves:
    - REST create and bundle delivery through `start_commands`
    - callbacks
    - stop
    - logs
    - the cache mount
    - a driver new enough for cu128
  - The first `glimmer-lora` run proves Unsloth there. It takes about 45 to 60 minutes on an H100, about $5 to $6.50
    [I]. That is over the $5 job ceiling, so `TRAIN_JOB_MAX_USD` needs raising for that run.

### Fireworks (managed SFT, not a host for our runner)

- **What works for Glimmer:**
  - Fireworks has its own base, `accounts/fireworks/models/muse-glimmer-30b`, with 131K context
    ([model page](https://fireworks.ai/models/fireworks/muse-glimmer-30b)).
  - Managed SFT is `POST /v1/accounts/{account_id}/supervisedFineTuningJobs`, with `baseModel`, `dataset`, `epochs`,
    `learningRate`, `loraRank`, `maxContextLength` and `lrScheduler`
    ([API](https://docs.fireworks.ai/api-reference/create-supervised-fine-tuning-job)).
  - Over REST, an omitted rank becomes 0, which means full-parameter training, and that isn't free.
  - Datasets are `messages` JSONL, 3 to 3M lines
    ([fine-tuning](https://docs.fireworks.ai/fine-tuning/fine-tuning-models)). Our Oct 30 claim check found that
    `reasoning_content` is accepted.
  - Our masking, trainChannel and template choices don't carry over.
- **GPU and price** ([pricing](https://fireworks.ai/pricing)):
  - LoRA SFT is free through Nov 30. Ask Fireworks whether managed SFT sent through REST counts.
  - After that, $3.00 per 1M training tokens.
  - Glimmer has no serverless inference. Deployments cost $8/h for an H100.
- **Credentials:**
  - `FIREWORKS_API_KEY` is in `~/muse-muse/.env.local` only.
  - `FIREWORKS_ACCOUNT_ID` is stored nowhere, and the REST paths need it.
- **Artifacts and export:**
  - Adapters download in PEFT format through signed URLs. Fireworks' base may differ from the public weights
    ([deploying LoRAs](https://docs.fireworks.ai/fine-tuning/deploying-loras)), so it needs a parity test.
  - Importing our adapters needs rank 4 to 64 and an explicit target list. Unsloth writes a regex
    ([uploading models](https://docs.fireworks.ai/models/uploading-custom-models)).
- **Caps and kill switches:**
  - There is no cost or time cap field, and `estimatedCost` is read-only.
  - The kill switch is cancelling the job.
  - The export tool reads the job back and cancels it unless the rank matches what was sent (tg-decide
    `docs/DECISION_MODELS.md` section 5).
- **Data terms** ([terms](https://fireworks.ai/terms-of-service)):
  - 2.2(c) bars training on content from the service.
  - 3.3(v) warrants that input has no "machine-generated content".
  - Lab datasets are written by Muse Wonder or Muse Spark 1.3, so they can't go there. Send only human-written data,
    and never bring Fireworks output back as training data.
- **Smoke test:** the export test in tg-decide `docs/DECISION_MODELS.md` section 5, none run.
  - Data: 300 human-written MASSIVE en-US rows.
  - Rank 16, sent explicitly and read back.
  - Download the adapter, then check parity against the public BF16 base on Lambda and against our 4-bit base.
  - Cost: about $2.50 to $4.50 [I], with training at $0 and about $2.47 of Lambda time.
  - Run it before Nov 29.

## At a glance

| | Lambda | Modal | Baseten | Fireworks |
|---|---|---|---|---|
| Runs our recipe | yes, measured | yes [L] | yes [L] | no |
| GPU that fits | A100 40 GB, $1.99/h | A100 40 GB, about $2.10/h | H100, about $6.50/h | n/a |
| One 120-step run | $1.59 measured | about $1.70 plus CPU and memory [I] | about $3.50 to $5 [I] | $0 through Nov 30 |
| Stop on the provider's side | none | Sandbox timeout, spend limit | GPU capacity cap only | none |
| Credentials in builds `.env.local` | yes | no (CLI profile only) | no (in `~/muse-muse`) | no, and no account id |
| Smoke cost | n/a | about $2.30 | about $1.10 | about $2.50 to $4.50 |

## Build units

| # | Unit | Hours | Proves it |
|---|---|---|---|
| B0 | Rebase onto main after tg-decide lands, and refresh the line references here | 0.5 | it builds |
| B1 | `TrainBackend` and a Lambda adapter, as a pure refactor of steps, sweep, logic and the four routes | 5 to 6 | the existing tests pass unchanged, plus one contract test the fakes share |
| B2 | The `backend` column and migration, store, the jobs route and the admin select | 2 to 3 | migration and store tests |
| B3 | GPU classes, per-backend price tables, `pickGpu` over offers, `runEstimate` by class | 2 | unit tests |
| B4 | The `JobBundle` builder (cloud-init becomes one wrapper), plus the optional token-gated bundle route | 2 | userdata and route tests |
| B5 | Modal backend: pinned `modal` SDK, Sandbox launch, poll, terminate and list, v2 Volume, `MODAL_TOKEN_*` in `lib/env.ts`, a fake Modal | 6 to 8 | fake tests, then the Modal smoke |
| B6 | Baseten backend: REST project and job create, status, logs, stop, list, capacity read, a fake Baseten | 5 to 7 | fake tests, then the Baseten smoke |
| B7 | Live demo on Modal: an encrypted-port tunnel, and a proxy mode "host HTTPS plus serve key" beside the pinned-cert mode | 3 to 4 | first real serve |
| B8 | Fireworks export test tooling: dataset export, SFT create with the rank guard, poll, download, parity scoring | 6 to 8 | the export test |
| B9 | Fireworks import: adapter into a backend cache, then a `scoreOnly` job. Only after B8 passes | 4 to 6 | one import run |
| B10 | Baseten serving: a Truss with Meta's vLLM image on a merged BF16 (needs GLIMMER_ALIGNMENT E2) | 6 to 8 | one deployment |
| B11 | A backends section in TRAINING.md, and the build log | 1 | review |

Modal end to end (B0 to B5 plus B11) is about 19 to 23 hours.

## Recommended order

1. **After tg-decide lands:** the "safe now" alignment fixes in `docs/GLIMMER_ALIGNMENT.md` (S1 to S5, about 4 h).
2. **B0 and B1:** no behavior change, and the tests show Lambda is untouched.
3. **B2 to B4.**
4. **B5, then the Modal smoke,** with the owner's OK.
5. **B6 and its smoke,** only if a second container host is wanted, for example H100 capacity when Lambda is out.
6. **Fireworks:**
   - the export test, with the owner's OK, human-written data, before Nov 29
   - B8, and B9 only if the test passes
7. **B7 and B10** when a hosted demo needs them.

For Nov 4, steps 1 and 2 are realistic. Every provider run waits for the owner.

## Owner decisions

Each comes with a recommendation.

- **O1. Second host.** Recommend Modal: about $2.10/h for an A100 against Baseten's $6.50/h H100, a TypeScript SDK, and
  a hard per-job timeout. Its one risk is Unsloth under gVisor, which the smoke test checks.
- **O2. Rewrite the cards already on Hugging Face for Meta's sampling.** Recommend yes: card and params text only, no
  weights.
- **O3. Live demo decoding.** Recommend Meta's sampling by default, with a "same as eval" greedy switch.
- **O4. Smoke spend.** Modal about $2.30, Baseten about $1.10, the Fireworks export about $2.50 to $4.50. Recommend
  approving Modal first.
- **O5. Credentials and caps (the owner sets these himself):**
  - Make a new Modal token for the platform.
  - Put `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `BASETEN_API_KEY`, `FIREWORKS_API_KEY` and `FIREWORKS_ACCOUNT_ID`
    into `muse-muse-builds/.env.local` and Vercel.
  - Set a Modal spend limit, and a Baseten training capacity cap of 1 H100.
  - Rotate the keys that were pasted in chat (KRL:908).
- **O6. `HF_PUBLIC` default (public).** Recommend keeping it for model-written lab data. Go private-first for any
  dataset with real user text.
- **O7. Reasoning-preserving training as the default (GLIMMER_ALIGNMENT N1).** Recommend yes, starting with one Lambda
  run, about $1.59.
- **O8. A merged BF16 repo (about 60 GB) for hosted serving.** Recommend making one only for an adapter someone will
  serve on Baseten, Fireworks or vLLM.
- **O9. Fireworks for the lab's own datasets.** Recommend no: terms 3.3(v). Use it only for the human-written export
  test.

## What waits for tg-decide

- **Every `lib/train` edit.** tg-decide changes these files now: `logic.ts`, `types.ts`, `runner.ts`, `glimmer.ts`,
  `hub-cards.ts`, `store.ts`, `workflow.ts`, `models.ts` and `recipes/index.ts`.
- **The routes it also changes:** `app/api/train/jobs/route.ts` and `jobs/[id]/events/route.ts`.
- **Schema and migrations:** tg-decide adds 0017.
- **Decide jobs:** they are `glimmer-lora` jobs in decide mode, so they go through the seam unchanged. Their
  `runEstimate` decide rates need per-class keys too.
- **The Fireworks export test** stays defined in one place, tg-decide's `docs/DECISION_MODELS.md` section 5.
- **What can happen now:**
  - these docs
  - the owner decisions above
  - provider accounts, keys and spend limits (the owner)
  - the free Hub reads (GLIMMER_ALIGNMENT S3)
  - reading Lambda's, Modal's and Baseten's terms

## Gaps

- **Modal:**
  - whether GPU Sandboxes are ever preempted
  - Unsloth and bitsandbytes under gVisor
  - whether the gRPC SDK works inside a Vercel function
  - its H100 driver versions
  - how Volume writes reach the next Sandbox
- **Baseten:**
  - how runtime artifacts are unpacked
  - whether a job ends on its own when the start command exits [L]
  - driver versions
  - the H200 price
- **Fireworks:**
  - Glimmer's rank limit and target modules
  - whether REST managed SFT is in the free offer
  - whether its base matches `cec94fcf`
- **Lambda:** whether a CUDA 13 driver is offered, which Meta's vLLM image needs; real filesystem prices.
- **All hosts:** no provider API was called, and no capacity or quota was checked.
