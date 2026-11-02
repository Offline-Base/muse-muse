# Vibe tuning

The design for six additions to the fine-tuning lab, decided Oct 28, 2026, with the owner's answers applied (see Decisions). It was written from five research notes (listed under Sources) and a re-check of the facts that decide feasibility, and it builds on `docs/TRAINING.md`. Build order marks each part as it ships.

It adds six things to the fine-tuning lab:

1. **Vibe fine-tuning.** Anyone describes in plain words what a model should do and gets a tuned Muse Glimmer 30B.
2. **Files sized to the device.** GGUF builds of the tuned model in three sizes, and a picker that says which one fits the person's computer.
3. **Automatic open-sourcing.** The adapter, the GGUF files and the training data go public on Hugging Face once every check passes.
4. **Inference on Lambda.** Time-boxed sessions on the owner's GPUs: first today's glimmer-serve, later one shared vLLM server.
5. **Help running it locally.** A guided page with one-click links into existing apps, the exact settings, and a troubleshooting tree.
6. **Order it on a flash drive.** One click sends an order request, with no payment on the site; the owner emails an invoice, then flashes and ships the drive; it runs offline.

Tags:

- **[V]** verified from the code, a source file, a live page or a measured run.
- **[R]** reported by a third party, not reproduced.
- **[S]** a secondary source: press, a forum, a law-firm summary or a price survey.
- **[I]** inferred or estimated: needs a test.
- **[D]** the repo's docs say so, but it hasn't been seen on real hardware.

Paths without a folder are in this repo. Base Drive (`~/base-drive`) is cited only for lessons. This design copies none of its code or text.

## Decisions

The owner answered the open questions on Oct 28. The rest are the research's recommended defaults.

| # | Decision | What we do |
|---|---|---|
| 1 | Who may start a paid run | **Anyone, within the caps** (the owner's answer). `VIBE_APPROVAL=auto` is the default: a run starts as soon as its checks allow it. An idea the request check marks "review" (for example a model for children or students) still waits for an admin. `VIBE_APPROVAL=admin` makes every run wait. A bot check (Vercel BotID, or Cloudflare Turnstile) guards the public routes. |
| 2 | Runs a day | `VIBE_DAILY_RUNS=4` and 1 per client a day. Raise `TRAIN_DAILY_USD` from $20 to $40 before raising runs to 8. A run uses about $4 of GPU, and the $20 is shared with admin jobs. |
| 3 | While Meta billing is down | Wait for Muse Wonder, the lab's writer and judge since Oct 29 (it was Muse Spark 1.3 when this was decided). Meanwhile, build and test everything after training on run 2 (job 83d71f74) and its dataset 17c76f2c: none of it calls Meta. |
| 4 | Where models publish | **A dedicated Hugging Face organization** the owner creates (the owner's answer), with a fine-grained token that can write to it. Everything goes public once every check passes; an admin can make any run private. |
| 5 | The training data Muse Wonder writes | Published as the lab already does, under Meta's Model API terms for outputs with a `LICENSE.md`, never under Apache 2.0 (`datasetLicense` in `lib/train/hub-cards.ts`). |
| 6 | GGUF sizes | Q3_K_M, Q4_K_M and Q6_K, 53.5 GB a model on the Hub. v1 has no Q8_0, IQ, MLX or vision file. At 4 runs a day that is about 6.4 TB a month, so watch the organization's storage. |
| 7 | Hosted inference | **v1:** today's glimmer-serve. A run's owner starts it for 30 minutes, on its own GPU slot (`INFER_MAX_ACTIVE=1`) and a $15 daily cap (`INFER_DAILY_USD`). **v2:** one shared vLLM server, after a spike. |
| 8 | Drive orders | **An order request, no payment on the site** (the owner's answer). The request saves the model, the build and the shipping address; the owner emails an invoice and moves the order along from an admin page. A returning buyer orders with one click, from details their browser remembers if they ask it to. The page shows `DRIVE_PRICE_TEXT` when it is set (for example "$59 with US shipping, invoiced by email"), and otherwise "We'll email you a quote before anything is charged". |
| 9 | Payment account | **Stripe Checkout, added Oct 30** (the owner's answer), on the same order rows. Card orders while `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `DRIVE_PRICE_CENTS` are set; the emailed invoice otherwise. A live key also needs `DRIVE_LIVE_SALES=1`. See "Paying by card" in Feature 6. |
| 10 | Fulfillment | The owner flashes the drives from an admin queue with a bench script. No vendor offers a different 54 GB image per single order at a sane price. |
| 11 | Signing the drive's launchers | Unsigned while the owner ships drives to people they know. Before selling to strangers: an Apple Developer ID and Windows code signing. |
| 12 | Keeping what people typed | The plain words and the hashed client keys go after 30 days. The spec stays with the run. A drive request's name, email and address go 60 days after delivery or cancellation. |

## Hard facts that decide feasibility

| # | Fact | Tag | Source |
|---|---|---|---|
| 1 | llama.cpp supports Glimmer (arch `muse-glimmer`) from build b10353, Aug 10, 2026. That covers the text model, the vision projector and the DFlash drafter. Quantizing works. | V | PR #26841; the b10353 release; ggml-org's conversion log (quantization notes) |
| 2 | GGUF builds of the base already exist: Meta's Q4_K_M is 16.76 GB, and public ladders run from 6.5 to 32 GB. Nothing needs porting. | V | Hugging Face API (quantization notes) |
| 3 | llama.cpp can't convert a Glimmer LoRA adapter. The Glimmer converter calls `tensor.ndim` (`conversion/muse_glimmer.py:17`), but the LoRA converter's tensor class has only `shape` (`convert_lora_to_gguf.py:40`, `:122`). | V (source read), R (the crash reported) | saved sources in the drive and quantization notes |
| 4 | Ollama dropped LoRA `ADAPTER` support on 2026-09-15. | V | commit 98acec40ae, PR #14969 (local-run notes) |
| 5 | So every local file is a merged model: merge the adapter into the bf16 base (59.55 GB in 2 shards), convert, then quantize. | I (follows from 3 and 4) | |
| 6 | The merge needs about 60 GB of RAM and 180 to 260 GB of disk. A Lambda 1x A100 40 GB has 220 GiB of RAM and 512 GiB of disk. A 1x A10 has 226 GiB and 1.3 TiB. | I (the needs), V (the instance specs) | lambda.ai/pricing, saved Oct 28 |
| 7 | Tuned files are the same size as the base's: Q3_K_M 13.68 GB, Q4_K_M 16.94, Q6_K 22.87, Q8_0 29.61, BF16 55.73. Publishers' builds differ by up to 0.5 GB. | V (base files), I (the tuned model has the same shapes) | Hub trees (quantization notes) |
| 8 | Q4_K_M needs about 18 GB of memory at 8K context. Meta lists about 17 GB for text only, and aims the file at 24 GB GPUs. | I, V (Meta's figures) | Meta's GGUF card |
| 9 | The platform can't publish a GGUF today. `HUB_FILE_MAX_BYTES` is 10 GB (`lib/train/types.ts:457`), `HUB_FILE_NAMES` has no `.gguf` (`types.ts:466`), and Blob takes at most 1 GB. | V | code |
| 10 | The lab's adapters never learned to open the final channel. The header sits inside the masked response part (`lib/train/recipes/glimmer.ts:105`), and eval opens it for the model (`glimmer.ts:106-110`, `eval_prompt` at `:1146`). Run 1, which let the model choose, "never left the reasoning channel" (`docs/SUBMISSION.md:103`). Stock local apps end the prompt at `<\|start\|>assistant`. | V (code and run 1), I (the current adapters will show empty replies locally) | |
| 11 | llama.cpp's release assets have no Linux CUDA build. b10353 ships Ubuntu CPU, Vulkan, ROCm, SYCL and OpenVINO builds. | V | the b10353 release JSON |
| 12 | vLLM serves Glimmer from v0.28.0, and its model class declares LoRA support; a startup crash with LoRA was fixed on Aug 24 (#53513). v0.32.0 is current. Its `--api-key` doesn't guard `/invocations` or `/tokenize`. | V | vLLM source (inference notes) |
| 13 | Today's live demo takes about 90 s per answer pair and costs about $1.50 per 30-minute window. | V (measured in production) | `docs/SUBMISSION.md:220` |
| 14 | Training is measured: A100 40 GB, 120 steps, 42 and 47 minutes, $1.39 and $1.59. A 400-example dataset cost $1.51 and judging $0.15. | V | `docs/SUBMISSION.md:102-105` |
| 15 | Every vibe run needs Muse Wonder to write its data and to judge it, and "judged" gates the public page, the public demo and publishing. Muse Spark 1.3 wrote and judged the runs before Oct 29. | V | `DATASET_MODEL` in `lib/train/datasets.ts`, `JUDGE_MODEL` in `judge.ts`, `components/train/results.ts:58` |
| 16 | Lambda 1x prices on Oct 28: GH200 96 GB $2.29, H100 SXM $4.29, H100 PCIe $3.29, A100 40 GB $1.99, A10 $1.29, A6000 $1.09, RTX 6000 $0.69. Billing is per minute, with no egress fees. | V | pricing page and billing docs (inference notes) |
| 17 | A Hub file can be up to 500 GB, under 200 GB is recommended, and free accounts get best-effort public storage. | V | huggingface.co/docs/hub/storage-limits |

## Build order

Each step ships on its own behind its own switch, has unit tests with fakes, and ends with the cheapest real run that proves it. Steps 0 to 4 need no Meta calls.

| Step | Build | Ships | Cheapest real check | Cost |
|---|---|---|---|---|
| 0 | No code. Set `HF_TOKEN` and `HF_NAMESPACE` with `HF_PUBLIC=0`, then publish run 2 with the existing glimmer-publish. | Adapter publishing, proven on the real Hub | The cards and repos on the Hub. Note the multipart `chunk_size` the Hub answers, which decides whether step 1 must page the plan. | about $0.15 to $0.45 (10 to 20 minutes on the cheapest free GPU) |
| 1 | `glimmer-quantize`, the Hub's GGUF names and sizes, the GGUF card, and a "Make local files" button for admins (Features 2 and 3) | GGUF files for any judged adapter | Quantize run 2 into a private repo. Then run Q4_K_M on the owner's Mac, which needs about 25 GB free (it had 18 GiB), with `tuned.jinja`. | about $2.50 |
| 2 | `trainChannel` in glimmer-lora, and "Judge now" for jobs judged while Meta was down (Feature 1) | New runs whose files work in stock apps | Train on dataset 17c76f2c with `trainChannel: 1`, quantize it, then try LM Studio and Ollama with no template change. Judging waits for Meta. | about $4 |
| 3 | The device picker and the run-locally page (Features 2 and 5) | "Run it on your computer" on public model pages | Render tests, then three real machines: the owner's Mac, a Windows PC with an NVIDIA GPU, and a 16 GB laptop. | $0 |
| 4 | Separate GPU slot and cap for serving. Owners start v1 sessions (Feature 4). | A hosted fallback for devices that can't run it | One 10-minute session | about $0.83 |
| 5 | The vibe front door: spec, checks, `vibe_runs`, admin review, orchestrator, run page and gate (Features 1 and 3) | Vibe tuning behind `VIBE_ENABLED` | One run end to end once Meta billing works | about $9 |
| 6 | Drive order requests: `drive_orders`, the request form, the order page, the admin queue, the bench script and the drive image (Feature 6) | "Get it on a flash drive" behind `DRIVE_ENABLED` | One request in a private test. One real drive tested on a clean Mac and a clean Windows PC. | about $15 for the stick |
| 7 | The Glimmer pool (v2 inference): spike first, then streaming and keys (Feature 4) | Fast shared sessions and an OpenAI-style endpoint | Run 2's adapter on vLLM FP8, replaying the 40 held-out prompts | about $1.50 to $2.50 |
| 8 | Later: the assistant chat, MLX, IQ sizes with an importance matrix, drives with the base plus a small adapter, Stripe checkout, signing | | | |

Cut line before the Nov 2 feature freeze (`docs/BUILD_PLAN.md`): steps 0 to 5, with step 6 in test mode if time allows. The pool comes after the event.

## The whole flow

```text
person: plain words (20 to 600 characters), 18+ box
  -> POST /api/vibe/spec      rule checks, then one Wonder call: allowed or not, a role name, a task, 3 example requests
  -> person: "Start"          POST /api/vibe/runs/{id}/submit -> "queued" (auto, the default) or "review" (flagged, or VIBE_APPROVAL=admin)
vibeRun workflow (lib/vibe/workflow.ts):
  review      waits on hook vibe-review:<run> until an admin approves or refuses
  data        createDataset + makeDataset as today (VIBE_DATASET_COUNT, 300), waits on hook vibe-data:<run>
  data check  one Wonder call over a sample of the examples: allow | review | refuse
  gpu         waits on hook vibe-gpu:<run>:train until the dispatcher says this run is next
  train       createTrainJob glimmer-lora {datasetId, trainChannel: 1, publish: 2}, A100 40 GB first
              -> the job's own trainJob workflow: GPU, judging, adapter files uploaded but not committed
  gate        judged, tuned beat base, both checks allow -> publishToHub (adapter and data); else "not_published"
  gpu         waits on hook vibe-gpu:<run>:quant
  quantize    createTrainJob glimmer-quantize {adapterJobId} -> merge, GGUF, 3 sizes, file checks, upload,
              then its own trainJob publishes the GGUF repo
  ready       the run page: results, Try it live, Run it on your computer, Get it on a drive
```

## Feature 1: Vibe fine-tuning

### What the person sees

1. **`/vibe`, Describe.**
   - A box: "What should your model do?" (20 to 600 characters), with three example chips.
   - What happens next, in four plain lines:
     - Muse Wonder writes about 300 examples.
     - Muse Glimmer 30B learns from them on a GPU.
     - Muse Wonder judges the result blind.
     - It takes about three hours once it starts.
   - Two warnings: the model and its training data become public on Hugging Face under Apache 2.0, so don't type personal or confidential details; and Meta's Usage Policy says the model "is not intended for individuals under the age of 18".
   - An 18+ box and a "Check my idea" button.
   - A status line: how many runs are waiting, or "Paused: Meta's Model API isn't answering", "Paused: today's runs are used up", or "Off".
2. **`/vibe/{id}`, Check (a draft).**
   - The role, as the model will be prompted ("You are the meeting-notes summarizer.").
   - What it will learn: the task Muse Wonder wrote, folded after two lines.
   - Three example requests.
   - "Start", or "Change my words", which counts toward the day's checks.
   - A refused idea shows one sentence of why, with a link to the Usage Policy.
3. **Submitted.**
   - "Saved. Bookmark this link: it is the only way back to your run." The link is shown once, with a copy button, and a cookie keeps it for this browser.
   - Then "Waiting for review", or "In line: N runs ahead of yours".
4. **Progress.** A timeline that refreshes every 10 s, each stage with one plain sentence and its elapsed time:
   1. Writing examples (N of 300)
   2. Waiting for a GPU
   3. Training (step N of 120, loss)
   4. Judging (N of 30)
   5. Publishing
   6. Making local files (three sizes)
   7. Ready

   "Cancel" works until training starts.
5. **Ready.**
   - The eval strip ("Tuned won N of M") and three held-out pairs, base next to tuned.
   - The Hugging Face links.
   - Three buttons: "Try it live" (Feature 4), "Run it on your computer" (Features 2 and 5) and "Get it on a drive" (Feature 6).
   - **Not published** instead says why ("The tuned model didn't beat the base: 9 to 14", or "The examples need a person to look at them") and offers "Try again with clearer words", which counts as a new run.

Admins see a **Vibe requests** table on `/fine-tuning` with these columns: words (folded), role, check verdict and reasons, client (the first 6 characters of its hash), status, cost so far, waiting since. The actions are Approve, Refuse (with a note), Stop and Make private. A line above the table shows the approval mode and today's runs against the cap.

### Table `vibe_runs` (migration `drizzle/0007_vibe_runs.sql`)

| Column | What |
|---|---|
| `id` | uuid |
| `status` | see Statuses |
| `waiting` | the plain reason while waiting: "an admin", "a GPU", "today's budget" |
| `words` | the person's text, cleared after 30 days |
| `spec` | jsonb `{ title, roleLine, task, samples[3], studentFacing }`, all written by Muse Wonder |
| `request_check`, `data_check` | jsonb `{ verdict: "allow" \| "review" \| "refuse", reasons, costUsd, at }` |
| `client_key`, `browser_key` | HMAC with `GATEWAY_TOKEN_PEPPER` of the client IP (`x-real-ip`) and of a random HttpOnly cookie id, for quotas. Never the raw IP. |
| `secret_hash` | `hashToken` of the run link's secret (32 random bytes), as gateway tokens are stored (`lib/gateway/tokens.ts`) |
| `created_by` | the user id: the shared guest under `OPEN_ACCESS=guest` |
| `reviewed_by`, `reviewed_at`, `review_note` | the admin's decision |
| `dataset_id`, `train_job_id`, `quant_job_id` | the lab rows it made |
| `gate` | jsonb: `{ judged, tunedWins, baseWins, avgTuned, avgBase, pass, reason }`, plus the quantize job's file checks |
| `publish_mode` | "public" or "private", from `VIBE_PUBLISH`, and set by an admin's Make private |
| `age_ok_at`, `terms_version` | the person's 18+ box and the terms they saw |
| `cost_usd` | Meta and GPU spend so far, from the dataset and job rows |
| `error`, `workflow_run_id` | |
| timestamps | `created_at`, `updated_at`, `queued_at` (the queue order), `finished_at` |

Quotas count rows, not `rate_limits` windows, since the hourly cleanup deletes those after an hour (`lib/gateway/cleanup.ts:25`). A row matching the client key or the browser key in the last 24 hours counts.

### Statuses

```text
checking -> draft -> review -> queued -> data -> training -> judging -> publishing -> quantizing -> ready
                 \-> refused   \-> refused (admin)
any stage before training -> cancelled (the person or an admin)
gate fails -> not_published        a stage fails -> failed (with the stage and one sentence)
a draft nobody started for 1 hour -> expired (still counts toward the day's checks)
```

### Routes

| Route | Who | Does |
|---|---|---|
| `POST /api/vibe/spec` | anyone, not cross-site (`requireUser`), with the bot check | `{ words }` -> 201 `{ runId, spec }`, or 200 `{ refused, reason }`. Makes a draft row and its cookie. Rule checks first, then one Muse Wonder call. 429 `daily_limit` (10 checks per client a day, `VIBE_DAILY_SPECS` 200 for everyone), 503 `paused` (`spendPaused`), `meta_not_configured`, `vibe_off`. |
| `POST /api/vibe/runs/{id}/submit` | the browser holding the draft's cookie | `{ ageOk: true, termsVersion }` -> 200 `{ link }`, shown once. Sets status "review" (or "queued" under `auto`) and starts `vibeRun`. 429 `daily_limit` (1 run per client a day, `VIBE_DAILY_RUNS` for everyone), 409 `not_draft`. |
| `GET /api/vibe/runs/{id}` | the run's secret (the cookie, or `?k=` once, which sets the cookie and redirects to the clean URL), or an admin | The safe view: status, waiting, spec, progress, gate, and public links once published. Never the IP hash, words of other runs, instance data, log text or errors beyond one sentence. |
| `POST /api/vibe/runs/{id}/cancel` | the secret or an admin | Before training: status "cancelled", and the hook is resumed with a cancel. 409 after that. |
| `POST /api/vibe/runs/{id}/session` | the secret | Starts a live session (Feature 4) |
| `GET /api/vibe/runs` | admin or automation | Every run, newest first, with both checks and the costs |
| `POST /api/vibe/runs/{id}/review` | admin or automation | `{ approve: boolean, note? }` -> resumes `vibe-review:<id>`. The hook token proves nothing by itself: the route checks admin first. |
| `POST /api/vibe/runs/{id}/visibility` | admin or automation | `{ public: boolean }` -> sets the three repos' visibility (Feature 3) |
| `GET /api/cron/vibe-dispatch` | `CRON_SECRET`, every 5 min (`vercel.json`) | Runs the dispatcher, and wakes any run whose awaited dataset or job already ended (a lost nudge) |

### The workflow (lib/vibe/workflow.ts)

- **No long polling.** Each stage waits on a hook with a deterministic token, `vibe-<stage>:<runId>`, raced against a `sleep` backstop: 2 hours for data, 3 for training, 3 for quantizing. A Vercel World run fails with `MAX_EVENTS_EXCEEDED` at its per-run event limit (`node_modules/workflow/docs/whats-new.mdx:208`), and `trainJob`'s 30 s loop would be a poor model for a wait of hours.
- **Who wakes the hooks.** The end of `finishDatasetStep` and `failDatasetStep` (`datasets.ts`) and the end of `trainJob` (`lib/train/workflow.ts:190-191`) each get a best-effort `notifyVibe(id)`. It never throws and never changes the dataset's or the job's outcome.
- **`createTrainJob(input, actor)`.** The jobs route's body (`app/api/train/jobs/route.ts:139-269`) becomes this function. The route and the workflow both call it, the way Publish already calls the jobs handler in-process (`app/api/train/jobs/[id]/publish/route.ts:28-41`). It keeps every check: the sweep gate, capacity, `runEstimate`, the back-out when two jobs start at once (`route.ts:247-255`), and the daily cap.
- **The vibe training job:**
  - `glimmer-lora`, `title` the spec's title.
  - `params { datasetId, maxSteps: 120, studentPrompt: "short", trainChannel: 1, publish: 2 }`.
  - `instanceType: VIBE_TRAIN_GPU` (default `gpu_1x_a100_sxm4`). `pickGpu` takes it when it has capacity and falls back to the recipe's order otherwise.
  - Limits: 75 minutes and $4.20. Those fit an H100 SXM5 even without the cache: `runEstimate` gives 120 × 5 s + 45 min = 55 min, and $4.20 buys 58 minutes there (`usableMinutes` counts every started minute in full).
- **The vibe quantize job:** `glimmer-quantize { adapterJobId }`, 110 minutes and $3.70.

### The dispatcher

Only one place starts vibe GPU jobs, so two runs never race into the route's back-out, where both lose (`route.ts:245-246`).

- `dispatchVibe()` runs from the cron and from every `notifyVibe`.
- Inside one transaction it takes `pg_try_advisory_xact_lock(<vibe constant>)`, then picks the oldest run (by `queued_at`) waiting on a GPU hook.
- It checks three things:
  1. `activeJobCount("train") < TRAIN_MAX_ACTIVE`.
  2. `trainingCommittedToday() + the stage's limit <= TRAIN_DAILY_USD`.
  3. For a training stage, today's started runs are under `VIBE_DAILY_RUNS`.
- When all pass, it resumes that run's hook.
- The run's step then calls `createTrainJob`:
  - **409 or a daily-cap 503:** the run keeps its place and waits for the next tick.
  - **503 `no_capacity`:** it waits up to 6 hours, then fails with "No GPU was free in the regions the model cache is in".
  - **400:** fails at once.
- Admin jobs never queue, so they can always go first.

### Changes to the lab

- **glimmer-lora `trainChannel`** (number 0 or 1, default 0, so current runs are unchanged).
  - With 1, `RESPONSE_PART` becomes `GENERATION_PROMPT` (`glimmer.ts:105-109`), so the trained span is ` to=user<|message|>ANSWER<|eot|>` and the model learns to open its final answer.
  - `check_masking` (`glimmer.ts:1174`) then expects the first trained span to start with `FINAL_CHANNEL` and then the answer.
  - `eval_prompt` (`:1146`) stops at `<|start|>assistant`, the way stock apps do, and lets both models choose. `final_answer` (`:1102`) takes the first `to=user` message, after any `to=self` reasoning, up to `<|eot|>`.
  - A new metric, `tuned_direct_final`, counts the answers that opened the final channel first.
  - The card's "How to use it" then shows the stock prompt with no forced channel.
  - glimmer-serve keeps forcing the channel, which is right for both kinds of adapter.
  - One real run must show the tuned model picks `to=user` reliably [I].
- **glimmer-lora `publish: 2`**: upload while training, then wait. The GPU uploads exactly as with 1, but `trainJob`'s publishing stops at hub state "uploaded". The vibe gate then starts the existing `publishToHub` workflow with the run's visibility. `validateParams` takes 0 to 2.
- **"Judge now".**
  - What it does: `POST /api/train/jobs/{id}/judge` (admin) starts a small `judgeJob` workflow made of the existing `judgePlanStep`, `judgeStep` and `saveEvalSummaryStep`.
  - When it runs: only on a succeeded, terminated job with eval items whose summary is unjudged.
  - Why: a run that ended while Meta was down can then be judged and published later.
- **Card wording.** For a vibe run, the model card's "which the admin described as" (`lib/train/hub-cards.ts:780`) becomes "which the person who asked for it described as". The quoted text is the spec's task, written by Muse Wonder and checked, never the person's raw words. Its Markdown is escaped like the judge's notes are.
- **Lab reads** for the run page select only the run's own safe columns, as the Lab reads already do (`lib/train/store.ts:1039-1112`).

### The checks

**Rule checks** (pure, in `lib/vibe/logic.ts`, free). They refuse words that:

- are under 20 or over 600 characters;
- contain `<|` or other control characters;
- contain an email address, a phone number or a street address ("Leave out personal details");
- ask to remove safety ("uncensored", "jailbreak", "abliterate", "no refusals" and similar). Usage Policy item 1.8 forbids circumventing safety measures, and the Hub already has such Glimmer variants (drive notes).

**The request check** (one Muse Wonder call, structured output, effort low; usage recorded under `source "platform"`):

- It returns `{ verdict, reasons, title, roleLine, task, samples, studentFacing }`.
- **Refuse:** anything the Usage Policy forbids, content aimed at a private individual, and impersonating a real person or brand.
- **Review:** student-facing or child-facing models. These always need an admin, even under `auto`, since the card makes deployers responsible where minors could use it.
- **The role and the task:**
  - `title` must read well after "You are " and stay under 60 characters, so glimmer-lora's `student_system` makes a real role line from it (`TRAINING.md:322`).
  - The `task` is 20 to 2,000 characters, which is what `datasetSystemPrompt(task)` takes (`lib/train/logic.ts:559`).
  - The person can change only their words, never the task text. So what reaches the teacher's system prompt is always Muse Wonder's checked rewrite.

**The data check** (one Muse Wonder call): 20 random training examples and every eval prompt, as data. "allow" lets the gate pass. "review" or "refuse" holds the run as `not_published` until an admin publishes it privately or discards it.

**The gate** (pure, `vibeGate`), checked after judging. Every part must hold:

- at least 8 judged items;
- `tunedWins > baseWins` and `avgTunedScore > avgBaseScore`;
- tuned unfinished answers under 20%;
- both checks "allow".

### GPU, time and cost per run

| Stage | Where | Time | Cost |
|---|---|---|---|
| Request check and spec | Muse Wonder, 1 call | 10 to 30 s | about $0.04 [I] |
| Dataset, 300 examples | Muse Wonder | 8 to 15 min [I] | about $3.50 to $5.50 [I, scaled from Spark 1.3's measured $0.0035 to $0.0038 an example: `TRAINING.md:375`, `SUBMISSION.md:102`] |
| Data check | Muse Wonder, 1 call | under 1 min | about $0.04 [I] |
| Training, 120 steps | A100 SXM4 40 GB, $1.99 an hour; then H100 PCIe or SXM5 | 42 to 47 min on the A100 [V]; about 32 or 30 min on the H100s [I, `runEstimate`] | $1.39 to $1.59 [V]; about $1.75 or $2.15 on the H100s [I] |
| Judging, 30 items | Muse Wonder | 2 to 5 min [I] | about $0.35 to $0.50 [I; run 2 was $0.15 for 40 on Spark 1.3] |
| Story for the card | Muse Wonder | under 1 min | about $0.08 [I] |
| Adapter publishing | platform | 2 to 5 min [I] | $0 |
| Quantizing | A100 SXM4 40 GB (Feature 2) | 45 to 110 min, typically about 75 [I] | about $1.50 to $3.65, typically $2.50 [I] |
| **Total** | | about 2.5 to 3 hours from approval, with a free GPU | **about $7 to $12, typically $9**: about $5 to Meta and $4 of GPU |

The Meta rows were measured or estimated on Muse Spark 1.3 and are scaled here to Muse Wonder's prices, which are 3.2 times Spark's for input and 4.7 times for output [I]. Wonder bills reasoning as output and may also take longer, so the first real run should replace these figures.

- The person can try the adapter live after about an hour, and download files after about 2.5 hours.
- One GPU slot does about 2 GPU-hours per run, so at most about 10 runs a day. The $20 `TRAIN_DAILY_USD` binds first, at about 4 runs.

### Who may do what, and what is automatic

- **Anyone (the shared guest):** check up to 10 ideas and submit 1 run a day, per client.
- **The run's owner** (whoever holds the link): see progress, cancel before training, start one live session a day, and see the not-published reason.
- **Admins:** approve, refuse, stop and make private. They can also publish a held run privately, start "Judge now", and change the caps.
- **Automatic:** both checks, everything after approval, and the publishing when the gate passes. Approval itself is automatic only under `VIBE_APPROVAL=auto`, and "review" verdicts always wait for an admin.

### Settings

| Setting | Default | What |
|---|---|---|
| `VIBE_ENABLED` | off | The whole front door |
| `VIBE_APPROVAL` | `auto` | `auto` (the owner's choice) or `admin` |
| `VIBE_DAILY_RUNS`, `VIBE_DAILY_SPECS` | 4, 200 | For everyone, a rolling 24 hours |
| `VIBE_CLIENT_RUNS`, `VIBE_CLIENT_SPECS` | 1, 10 | Per client key or browser key, a rolling 24 hours |
| `VIBE_DATASET_COUNT` | 300 | Examples asked for (`DATASET_MIN_COUNT` to `DATASET_MAX_COUNT`) |
| `VIBE_TRAIN_GPU` | `gpu_1x_a100_sxm4` | The GPU asked for first |
| `VIBE_TRAIN_MAX_MINUTES`, `VIBE_TRAIN_MAX_USD` | 75, 4.20 | Under `TRAIN_JOB_MAX_*` |
| `VIBE_QUANT_MAX_MINUTES`, `VIBE_QUANT_MAX_USD` | 110, 3.70 | Under `TRAIN_JOB_MAX_*` |
| `VIBE_PUBLISH` | `public` | What the gate's publishing does |
| `DAILY_SPEND_CAP_USD`, `TRAIN_DAILY_USD`, `TRAIN_MAX_ACTIVE` | as today | Still apply to every Meta call and every GPU job |

### Tests

These follow the lab's pattern: `npx tsx --test --experimental-test-module-mocks`, nothing calls Meta, Lambda, the Hub or Neon.

- **`lib/vibe/__tests__/logic.test.ts`:** the rule checks (personal details, control tokens, safety-removal words, lengths), the status transitions, `vibeGate` at its edges, the quota counting, and the role line read through `studentSystem`.
- **`check.test.ts`:** both Muse Wonder checks against a fake Meta client: the schema, refusals, a reply that never matched, usage recorded before the verdict is saved, and the spend cap.
- **`store.test.ts`** on PGlite with the repo's migrations: quotas by either key over 24 hours, the advisory-lock dispatch order, one job per stage, and the 30-day clearing.
- **`routes.test.ts`:** spec, submit, status, cancel, review and visibility with their dependencies faked. It covers cross-site requests, the bot check faked, the link secret and its redirect, a status that never names an IP, and every limit.
- **`workflow.scenario.test.ts`:** `vibeRun` with its steps faked, in the style of `lib/train/__tests__/workflow.scenario.test.ts`:
  - approval and refusal, and a cancel while waiting;
  - a dataset that fails, and a data check that holds the run;
  - a GPU wait through 409 and `no_capacity`;
  - a training job that fails, a run that lost to base, the gate passing;
  - a quantize job that fails, and lost nudges that the cron recovers.
- **`lib/train/__tests__/runner.test.ts`, glimmer internals:** with `trainChannel: 1`:
  - the masks start at ` to=user<|message|>`;
  - the eval prompt ends at `<|start|>assistant`;
  - `final_answer` handles reasoning before the answer, and an answer that never reaches `to=user`.

  It runs against the small tokenizer pinned to the real template's output.
- **Then real:** the step-2 run (dataset 17c76f2c, no Meta needed until judging), and one full vibe run once Meta billing works.

## Feature 2: Files sized to the device

### Three sizes, and why not more

A fixed ladder made once per model is cheaper than quantizing per request: each new size would mean merging again, about $2.50 and a 60 GB download. Three files cover every machine that can run a dense 30B model:

| Build | File | Memory to run, 8K context [I] | Picked for | KL divergence vs BF16, on the base model [R] |
|---|---|---|---|---|
| Q3_K_M | 13.68 GB | about 15 GB | Mac 24 GB; NVIDIA 16 GB; NVIDIA 12 GB with part on the CPU | 0.0395, top token the same 92.3% of the time |
| Q4_K_M | 16.94 GB | about 18 GB | Mac 32 or 36 GB; NVIDIA 24 GB; a PC with 32 GB of RAM and no big GPU | 0.0141, 95.3% |
| Q6_K | 22.87 GB | about 24 GB | Mac 48 GB or more; NVIDIA 32 GB | about 0.0009 |

- **Memory to run** is the file, plus about 0.2 GB of KV cache at 8K context, plus 0.5 to 1 GB of buffers. The KV cache is small because the model has only 2 KV heads and 39 of its 52 layers use a 2,048-token window [I, from config.json].
- **Left out of v1** [V sizes]:
  - IQ2_M (9.85 GB, demo quality), IQ3_XXS (11.14) and IQ4_XS (15.3) need an importance matrix to be worth it.
  - Q5_K_M (19.81) and Q8_0 (29.61) add little over Q4_K_M and Q6_K.
  - MLX 4-bit (about 15.6 GB of text) has a Linux conversion path nobody has tried yet.
  - `QUANT_LEVELS` can add any of them later.
- **Vision.** The adapter leaves vision frozen (`glimmer.ts:1249-1260`), so Meta's 1.40 GB Q4_K_M vision projector should work unchanged with the tuned file [I]. v1 is text only, and the card says how to add the projector.
- **DFlash** stays off. Its drafter reads the target's hidden layers, so its hit rate drops on a tuned model [I], and with it on, prompt processing halves [R, llama.cpp #29982].

### The quantize recipe (`glimmer-quantize`)

Registry entry (`lib/train/recipes/index.ts`, id added to `RecipeId` at `lib/train/types.ts:12`, no migration since the column is text):

- **GPUs, in order:** `gpu_1x_a100_sxm4`, `gpu_1x_a100`, `gpu_1x_a10`. Each has at least 220 GiB of RAM and 512 GiB of disk [V pricing].
  - On the A100s, 40 GB of VRAM holds the Q8_0 reference fully on the GPU.
  - The A10 comes last [I]: its 24 GB is tight for loading the 4-bit model (22.2 GB) for the merge, and it splits the reference with the CPU.
  - The A6000 (100 GiB of RAM) and RTX 6000 (46 GiB) are left out, because the merge needs about 60 GB [I].
- **Region:** pinned to the adapter's cache, exactly like glimmer-publish (`steps.ts:222-245`). The cache is listed, never created.
- **Defaults:** 110 minutes and $3.70.
- **Params:** `adapterJobId` (kind "adapter") and `publish` (0 or 1). The platform writes `levels` from `QUANT_LEVELS` into the params itself. Both the TypeScript and the Python check it against an allowlist, so no caller chooses it.
- **Estimate:** `runEstimate` gains it: 90 minutes, or 80 once the region's CUDA build is cached [I, to replace with measured numbers].
- **Paging the dataset:** the dataset route pages it its adapter job's dataset, as it already does for glimmer-serve (`app/api/train/jobs/[id]/dataset/route.ts:23-29`).
- **In the New job card:** it shows there, and the adapter's job page gets a "Make local files" button.

The GPU side (`QUANT_PY`, built as the head plus `glimmerHelpers(GLIMMER_PY)` plus its own body, as `SERVE_PY` and `PUBLISH_PY` are, `lib/train/recipes/serve.ts:53-60`):

1. **Fail fast.** Fail in seconds, with one sentence, when any of these holds:
   - the adapter isn't at `<cache>/models/<id>/`, or it is a dry run's stand-in;
   - local disk has under 300 GB free, or RAM is under 180 GiB;
   - under 45 minutes are left before `ctx.deadline`.
2. **The venv.** `ensure_venv` reuses glimmer's venv from the cache for the merge (Unsloth 2026.10.9, transformers 5.15.0, PEFT 0.21.2).
3. **The llama.cpp tools, at one pinned build** (≥ b10353, the tag and every sha256 in the recipe source, checked like uv's, `TRAINING.md:323`):
   - its Ubuntu x64 CPU tarball, for converting and quantizing;
   - its source tarball, for `convert_hf_to_gguf.py` and gguf-py, in a small uv venv `venvs/llamacpp-<hash>`;
   - a CUDA build of that source for the checks, since releases have none (fact 11). It is built once per region into `<cache>/llamacpp/<tag>-cuda/` under the same build lock as venvs. An official CUDA container image at a pinned digest is the alternative, and the spike picks one [I].
4. **The merge.** Done in the child, with the venv's Python and the usual `ctx.run(stall_seconds=1200)`:
   1. Load the 4-bit base from the cache and the adapter.
   2. Call `save_pretrained_merged(<local>/merged, save_method="merged_16bit")`. Unsloth maps the 4-bit repo to `unsloth/Muse-Glimmer-30B`, whose shards have the same SHA-256 as Meta's, and merges tensor by tensor in fp32 (quantization notes, [V source]).
   3. The bf16 download goes to local disk (`HF_HOME` on local disk), never the cache, which bills per GB.
   4. Don't use `merged_4bit`, and don't call `merge_and_unload()` on the 4-bit model.
5. **Checks on the merged folder.**
   - Copy Meta's current `chat_template.jinja` (Meta's repo at a pinned revision) and its processor files into it, so the GGUF embeds Meta's template, not Unsloth's older copy.
   - Check that the merged checkpoint has the base's 1,436 tensor names and shapes.
   - Check that `adapter_config.json` targets no vision module.
6. **Convert and quantize.**
   1. Convert: `convert_hf_to_gguf.py <merged> --outtype bf16`, then delete `merged/`.
   2. Run `llama-quantize` to Q8_0 (the check reference, never published) and to each level.
   3. Delete the BF16 file once all of them exist.
   4. Peak disk: about 260 GB of the A100's 550 GB [I].
7. **File checks** (see below), then the sha256 of every file. `runner.ts:560-569` already computes it.
8. **Upload.** `ctx.hub_upload(<local>/out)` sends the files that passed, plus the small files: `system`, `params`, and `tuned.jinja` for an adapter trained before `trainChannel`.
9. **Return the metrics**, per level: bytes, sha256, mean and 99th-percentile KL divergence, top-token agreement and the channel check. Plus the llama.cpp build, the merge seconds and a summary.

Unsloth's own GGUF export was considered and left out: it builds llama.cpp from an unpinned checkout at run time [I].

### The file checks (the quality gate)

None of them calls Meta.

1. **Template.** Start `llama-server --jinja` on Q4_K_M and POST the lab's system line and held-out prompt 0 to `/apply-template`. The rendered prompt must equal the training text's prefix character for character. For an old adapter, `tuned.jinja` is used and the comparison includes the opened final channel.
2. **Closeness.** `llama-perplexity --kl-divergence-base` from Q8_0, over the held-out conversations rendered with their references, then each level against it. Each level must pass: Q3_K_M at most 0.08, Q4_K_M 0.03, Q6_K 0.005. That is about twice the base model's published numbers [I]. A level that fails isn't published; the others still are.
3. **Channel.** On Q4_K_M, with the prompt a stock app sends: the Glimmer parser on and `reasoning_strength` low. Use `tuned.jinja` for an old adapter. Every held-out prompt is answered greedily with 1,024 new tokens. At least 90% must end with a non-empty final answer. Otherwise nothing is published, with the reason "The local files keep thinking instead of answering".
4. **Agreement** (shown, not gating): how many Q4_K_M answers match the tuned model's stored eval answers in their first 200 characters.

The merge itself also needs one check, once in the step-1 spike. Greedy answers from the merged Q8_0 should match the evaluated tuned answers, which ran on the 4-bit base, closely enough to read the same. Unsloth says the gap is negligible for most models (quantization notes).

### GPU, time and cost of one quantize job

All on a 1x A100 SXM4 40 GB at $1.99 an hour, and all [I] until the step-1 run measures them.

| Stage | Time |
|---|---|
| Boot, mount the cache, venv ready from the cache | 5 to 10 min |
| llama.cpp: the CPU tarball (seconds); the CUDA build the first time in a region, cached after | 0 to 12 min |
| Download the bf16 base, 59.6 GB, to local disk | 3 to 10 min |
| Merge, and the checks on the merged folder | 10 to 20 min |
| Convert to BF16 GGUF | 5 to 10 min |
| Quantize Q8_0 and the three levels (ggml-org measured 22 s for Q8_0 and 95 s for Q4_K_M on their machine [V]) | 5 to 15 min |
| The file checks | 10 to 20 min |
| Upload 53.5 GB to the Hub | 5 to 15 min |
| **Total** | **45 to 110 min, typically about 75, so about $1.50 to $3.65, typically $2.50** |

- **Not cached on purpose:** the bf16 base stays off the region's filesystem. Keeping it would cost about $12 a month per region at about $0.20 a GB (`TRAINING.md:284`) to save 3 to 10 minutes, about $0.10 to $0.35, a run.
- **Revisit** at about 50 runs a month.

### The picker (on the model page and the run page)

It runs entirely in the browser. Nothing about the device goes to the server, which only serves the file list (names, sizes, sha256) from the GGUF job's hub state.

**What the browser can tell without asking** [V, from a headless Chrome 156 probe on this Mac, M4 Max with 36 GiB, plus MDN and WebKit sources]:

| Signal | Chrome and Edge | Safari | Firefox | Used for |
|---|---|---|---|---|
| `navigator.userAgentData.getHighEntropyValues` | architecture "arm" or "x86", platform, platformVersion (Windows 11 when the major is 13 or more) | none | none | OS, chip family |
| `navigator.deviceMemory` | 2, 4, 8, 16 or 32 from Chrome 147. 24 GB reads 16; anything over 24 GB reads 32. | none | none | 32 means comfortably over 24 GB; 16 means ask |
| WebGL unmasked renderer | the exact chip or GPU ("Apple M4 Max") | "Apple GPU" on Apple silicon | off under resistFingerprinting | Chip or GPU name |
| WebGPU `adapter.info` | vendor only, no VRAM | vendor | on Apple silicon from 145 | Apple silicon in Firefox |
| `maxTouchPoints`, the user agent | iPad (Macintosh with touch), phones | same | same | "can't run here" |

**The flow:**

1. Pre-fill one editable sentence, such as "Mac, Apple M4 Max, 32 GB or more". Tag each part "from your browser" or "you told us".
2. **Memory always needs a yes from the person.** The options come from the chip's valid sizes (for example, an M4 Max comes with 36, 48, 64 or 128 GB) intersected with the `deviceMemory` bucket.
3. A PC with a graphics card also confirms its VRAM. The page gives the path: Task Manager > Performance > GPU > Dedicated GPU memory. A model lookup table pre-fills it, minding "Laptop GPU" variants.
4. A box: "I have at least the file size plus 5 GB free".

**The verdict** (`pickBuild(profile, files)`, a pure function in `lib/vibe/device.ts`):

- Mac GPU budgets are about 2/3 of RAM up to 36 GB, and 3/4 above [R].
- Speeds are about 0.72 × memory bandwidth ÷ file size, which matches Meta's three measured speeds [V] to within a few percent [I].

| Device | Memory | Build | Verdict | Tokens a second [I unless marked] |
|---|---|---|---|---|
| Phone, tablet, Chromebook | any | none | Won't run here: use Try it live | |
| Mac with an Intel chip | any | none | Won't run well: use Try it live. LM Studio and Jan need Apple silicon; Ollama runs only on the CPU. | |
| Mac, Apple silicon | 8 to 18 GB | none | Won't run: use Try it live | |
| Mac, Apple silicon | 24 GB | Q3_K_M | Runs; close other apps | about 6 (M4) to 14 (M4 Pro) |
| Mac, Apple silicon | 32 or 36 GB | Q4_K_M | Runs well | about 5 (M4) to 17 (M-series Max); Meta measured 23.7 on an M4 Max [V] |
| Mac, Apple silicon | 48 GB or more | Q6_K | Runs well | about 9 (M4 Pro) to 25 (Ultra) |
| PC, NVIDIA | 32 GB of VRAM | Q6_K | Runs well | about 56 (RTX 5090) |
| PC, NVIDIA | 24 GB of VRAM | Q4_K_M | Runs well | about 40 (3090, 4090); 74.9 on a 5090, measured by Meta [V] |
| PC, NVIDIA | 16 GB of VRAM | Q3_K_M | Runs well | about 15 (4060 Ti) to 50 (5080) |
| PC, NVIDIA | 12 GB of VRAM, 32 GB of RAM | Q3_K_M, part on the CPU | Runs slowly | about 8 to 20 |
| PC, small or no GPU | 32 GB of RAM or more | Q4_K_M on the CPU | Runs slowly: use Try it live for long work | about 1.5 (4-core laptop, measured [R]) to 3.5 |
| PC | under 32 GB of RAM and no 16 GB GPU | none | Won't run: use Try it live | |

- **AMD and Intel GPUs** use the NVIDIA rows by VRAM, through LM Studio's Vulkan engine, marked "less tested" [I].
- **Linux** uses the PC rows.
- **Download time.** The verdict also gives it ("17 GB: about 45 minutes at 50 Mbps"). When it is long, the verdict offers the drive.

### Tests

- **`lib/vibe/__tests__/device.test.ts`:**
  - every row of the table, the budget edges (36 GB against Q6_K, 16 GB of VRAM against Q3_K_M) and the hosted fallbacks;
  - parsing of real WebGL renderer strings, Rosetta (x86 with "Apple M"), iPad and the `deviceMemory` buckets.
- **`runner.test.ts`:** `QUANT_PY` against a fake ctx, with fake `convert_hf_to_gguf.py`, `llama-quantize`, `llama-perplexity` and `llama-server` scripts. They write files that start with the GGUF magic and print canned KL divergence and answers. A fake Unsloth merge rounds out the fakes. The cases:
  - the early failures (disk, RAM, a stand-in adapter), the pins and their sha256, the CUDA build lock;
  - a level that fails its KL divergence and is left out, and a failed channel check that publishes nothing;
  - files deleted as they finish, and the deadline.
- **Then real** (build order step 1): run 2 on an A100 into a private repo. Time each stage and replace the estimates with what it measured.

## Feature 3: Open-sourcing on Hugging Face

### What the person sees

- **On the Ready screen and the public model page:** an "On Hugging Face" chip and three links (the adapter, the GGUF files, the data), shown only once the repos are public. That is the rule the Lab pages already follow (`TRAINING.md:644`).
- **On the Hub:** the GGUF card opens with "Which file for my computer", then the exact way to run it.
- **A run that didn't pass the gate** shows no links and says why.

**Cost and time.** No GPU of its own: the uploads ride inside the training and quantize jobs. The platform's commit steps take 1 to 3 minutes [I]. Storage on a free organization costs nothing, but it is best effort (fact 17).

### Three repos per run

| Repo | Name | Made by | Holds |
|---|---|---|---|
| Model (adapter) | `<ns>/muse-glimmer-30b-<slug>-lora-<job8>` (`hub-cards.ts:84-91`) | the training job, as today | the adapter, its card, LICENSE, `muse_muse_run.json` |
| Dataset | `<ns>/muse-muse-<slug>-<dataset8>` | the training job, as today | `data/train.jsonl`, `data/eval.jsonl`, its card |
| GGUF (new) | `<ns>/muse-glimmer-30b-<slug>-gguf-<job8>`, where `job8` is the training job's id, so the three repos line up | the quantize job | the three `.gguf` files, `system`, `params`, `tuned.jinja` (old adapters only), README, LICENSE, `muse_muse_quant.json` |

GGUF file names are `muse-glimmer-30b-<slug>-<LEVEL>.gguf`. Every local app picks a file by the level in its name (local-run notes), and the longest name stays under the Hub's 96 characters.

### The GGUF card

Front matter, to be checked with `POST /api/validate-yaml` and against the Hub's docs. The validator accepts made-up values (`HF_EXPORT_RESEARCH.md:97-98`):

```yaml
base_model: meta-models/Muse-Glimmer-30B
base_model_relation: finetune
pipeline_tag: text-generation
license: apache-2.0
language: [en]
tags: [gguf, llama.cpp, muse-muse, lora-merged]
datasets: [<ns>/muse-muse-<slug>-<dataset8>]
```

- **Why `finetune` [I]:** the weights are Meta's bf16 base with the adapter folded in. `quantized` would claim the base is the adapter repo, which isn't a whole model.
- **The `library_name`:** none. The Hub detects GGUF from the files [I].

Sections, in order (every number from the records or the job's metrics, never from a model, with `noEmDashes` and Markdown escaping as the adapter card does, `TRAINING.md:632`):

1. **The lead.** What it is in one sentence, with links to the adapter repo and the public lab page, and "Not an official Meta product".
2. **Which file for my computer.** The table from Feature 2, with this model's sizes, and a link to the picker.
3. **Run it.** LM Studio (deep link and manual steps), the Llama app on a Mac, llama.cpp, and Ollama (Feature 5).
4. **Prompt it the way it was trained.** The system message in a fence, reasoning strength low, temperature 0 to match the eval, and stops.
5. **How close the files are.** The KL divergence, top-token agreement and channel check per level, measured on this model's held-out conversations.
6. **How it was made.**
   - The adapter repo at its commit, and the base at its revision.
   - The merge method and the llama.cpp build.
   - The commands.
   - "No importance matrix".
7. **Files and checksums.** The sha256 list, which buyers of a drive can check against too.
8. **Limits, License and Provenance**, as on the adapter card: Apache 2.0, the Usage Policy with its under-18 note, and "Meta didn't make, review or endorse it".

Publishing the GGUF repo also commits a README-only change to the adapter's card, so "How to use it" links to it. The existing publish path commits only what differs (`TRAINING.md:620`).

### Changes to the publish path

1. **A file-name allowlist per recipe.** The rule lives in three places that must change together: `runner.ts:107-122`, `types.ts:466-481` with `hub-cards.ts:99-101`, and `hub-steps.ts:562`, `:575`. The adapter list stays as it is. glimmer-quantize gets this pattern: `muse-glimmer-30b-<slug>-(Q3_K_M|Q4_K_M|Q6_K)\.gguf`, plus `system`, `params` and `tuned.jinja`.
2. **A size cap per recipe.** Adapters keep 10 GB (`types.ts:457`). GGUF files get `HUB_GGUF_FILE_MAX_BYTES`, 32 GB.
3. **The plan answer's size.** Every part URL comes back in one JSON body under Vercel's 4.5 MB limit (`hub/route.ts:40-44`), and the part count depends on the Hub's `chunk_size`, which is still unknown. Step 0 measures it.
   - **When three files' parts would pass about 3.5 MB:** the runner plans one file at a time. It already re-plans per file after a 403 (`TRAINING.md:598`), so this is a smaller change than paging.
   - **When one file alone would pass it:** the platform pages that file's parts. That needs a check that a second LFS batch call for the same object keeps the first's multipart upload [I].
4. **`targetOf` and `hubJobProblem`:**
   - `targetOf` (`hub/route.ts:149-155`): glimmer-quantize acts for itself and keeps its own `training_jobs.hub` state.
   - `hubJobProblem` (`hub-steps.ts:432-452`): such a job publishes when it succeeded, `terminatedAt` is set, and its file checks passed. Its adapter job must also be published: publicly for a public GGUF repo, or as an admin's private test.
5. **The GGUF card.** A generator, `ggufCard`, in `hub-cards.ts`, reading the template facts from `GLIMMER_PY` as the adapter card does (`TRAINING.md:635`).
6. **Visibility per run.** A vibe run's `publish_mode` replaces the global `HF_PUBLIC` for its three repos (`lib/env.ts:176-182`). Make private sets all three private, and the dataset card follows the existing rules for a shared dataset (`TRAINING.md:623`).
7. **The `publish: 2` hold** (Feature 1).

What stays manual: Make private, publishing a held run, and deleting repos, which the platform never does.

### Tests

- **`hub-cards.test.ts`:** the GGUF names under the Hub's rules, the front matter line for line, the sections in order, every number from the records, and escaping.
- **`hub-flow.test.ts`** with the fake Hub (`lib/train/__tests__/fake-hub.ts`):
  - **The upload:** a 30 GB file declared in many parts (the fake answers a small `chunk_size`), with per-file planning or paging; the size caps per recipe; names outside the GGUF pattern refused.
  - **Publishing:** gated on the adapter's state; the adapter README updated with nothing else committed again; per-run visibility and Make private for all three.
- **`workflow.scenario.test.ts`:** the quantize job's publishing after it ends.
- **Then real:** step 0 (run 2's adapter), then step 1 (run 2's GGUF repo, private). Both pass the Hub's validator.

## Feature 4: Inference on Lambda

Lambda's own serverless inference only serves its own catalog (inference notes), so inference means our own instances.

### What the person sees

- **v1, on the run page:** "Try it live for 30 minutes" (once a day).
  1. Pressing it shows "Starting: the GPU boots and loads your model, up to about 15 minutes", and the page refreshes every 15 s.
  2. Then the existing Try it live box opens with the minutes left. It shows the base and tuned answers side by side, about 90 s per pair.
  3. When the time is up, the box says so.
  4. While it is open, the public model page has the same box for anyone, as today.
- **v2:** "Start a session" (20 minutes for guests). It goes from "Waiting" to "Starting" to "Live".
  - A chat streams the tuned model's answers, with "Compare with the base" as a toggle.
  - "Use it from code" shows the key once, with the base URL and a curl line.
  - "End session" stops it early.

### v1: sessions on glimmer-serve (build order step 4)

The existing recipe is unchanged: one adapter per GPU, base and tuned side by side, about 90 s per pair [V], and the public Try it live box (`TRAINING.md:459-542`).

- **A slot of its own.** `activeJobCount(kind)` splits the jobs:
  - "train" is every recipe but the serving ones, and is compared with `TRAIN_MAX_ACTIVE`.
  - "serve" is glimmer-serve, compared with the new `INFER_MAX_ACTIVE` (default 1).

  So a session no longer blocks training (`TRAINING.md:487`).
- **A daily cap of its own.** `trainingCommittedToday()` leaves serving out. The new `inferCommittedToday()` counts it against `INFER_DAILY_USD` (default $15).
- **Who starts one.**
  - Admins, as today.
  - A run's owner, through `POST /api/vibe/runs/{id}/session`. The platform fixes everything there: `{ recipe: "glimmer-serve", params: { adapterJobId: <the run's training job>, minutes: VIBE_SESSION_MINUTES } }`, with 30 minutes, 1 session per run a day, and the route's sizing.
- **Who may type into it.** Anyone, for a judged job, as today. Besides admins, the owner may also use an unjudged run's box, which helps when the gate held it. That widens one check at `app/api/lab/[id]/try/route.ts:86`.
- **Cost.** A 30-minute session bills 45 minutes: $1.49 on an A100 SXM4, $2.47 on an H100 PCIe, $3.22 on an H100 SXM5 [V prices]. $15 a day buys 4 to 10 sessions.
- **Tests:** `store.test.ts` (the split counts and caps on PGlite), `routes.test.ts` (the owner's session route and its limits), `lab-try.test.ts` (the owner's cookie on an unjudged demo). Real: one 10-minute session, about $0.83.

### v2: the Glimmer pool (build order step 7)

One shared vLLM server serves an FP8 copy of the base and loads each person's adapter on demand. It is the inference notes' recommendation, and every speed below is an estimate.

| | v1 (glimmer-serve) | v2 (pool) |
|---|---|---|
| Engine | transformers with Unsloth's 4-bit model and PEFT, greedy, base then tuned (`recipes/serve.ts:860-868`, `:462-469`) | vLLM 0.32.0 with `RedHatAI/Muse-Glimmer-30B-FP8-block` (34.4 GB) and LoRA |
| GPU | the adapter's region, A100 or H100 | GH200 96 GB ($2.29, arm64, the official arm64 image); then H100 PCIe or SXM5 (FP8); then A100 40 GB with the INT4 base |
| Adapters | one | up to 8 on the GPU (`--max-loras 8`) and 32 in CPU memory, rank 16 (`--max-lora-rank 16`) |
| Speed | about 5 to 9 tokens a second, about 90 s per pair [V] | about 80 tokens a second per stream (65 to 95), about 5 to 6 s per 400+400 pair, 400 to 550 a second in all across 8 sessions [I] |
| Cold start | up to 15 minutes budgeted | about 6 to 12 minutes to the first token [I] |
| Streaming | no (`lib/train/serve.ts:132-142` buffers) | yes |
| API | none | OpenAI-compatible, with a short-lived key |

**On the GPU** (`glimmer-pool`):

- **vLLM itself.** `docker run vllm/vllm-openai:v0.32.0`, pinned by digest, listening on `127.0.0.1:8000` only, with `--enable-lora --language-model-only`.
  - It uses a server-side chat template that opens the final channel at reasoning strength low. That works for adapters trained either way.
  - Stops are `<|eot|>` and `<|eom|>` per request.
  - It never binds publicly: its key doesn't guard `/invocations` or `/tokenize` (fact 12).
- **The TLS front on 8443** keeps every protection of today's server (`recipes/serve.ts:116-125`, `TRAINING.md:511`): a key on every route, a 10 s request deadline, and 64 connections in all, 4 per address. It becomes a streaming pass-through with an allowlist:
  - `/v1/chat/completions`, `/v1/models` and `/health`;
  - `/admin/adapters/load` and `/admin/adapters/unload`. The platform sends the adapter's Hub repo, commit and sha256. The front downloads `adapter_model.safetensors` and `adapter_config.json` from the public repo, checks the sha256, then calls vLLM's runtime load. vLLM's own resolver plugins stay off.
- **Adapters come from Hugging Face,** never from a cache, so the pool can run in any region. Only adapters the platform trained, judged and published are served.

**Tables and settings:**

- **`training_jobs.lease_until`** (migration 0009).
  - The front asks `GET /api/train/jobs/{id}/lease`, with the job token, every 60 s.
  - Once the lease has passed, it drains (no new requests, 2 minutes for those in flight) and returns, and the runner posts done.
  - `decideCheck` gains a rule for pool jobs: past `lease_until` + 10 minutes means terminate.
  - The hard cap is `INFER_POOL_MAX_MINUTES` (240) and its dollar limit at the GPU's price.
- **`infer_sessions`:**
  - `id`, `adapter_job_id`, `vibe_run_id`, `pool_job_id`;
  - `status` (waiting, starting, live, ended);
  - `key_hash` (`mm_glim_` + 32 random bytes, stored like gateway tokens), `client_key`;
  - `minutes`, `created_at`, `live_at`, `ends_at`, `ended_at`;
  - `requests`, `input_tokens`, `output_tokens`, `cost_usd`.
- **Settings:** `INFER_POOL_MAX_MINUTES` 240, `INFER_POOL_IDLE_MINUTES` 10, `INFER_SESSION_MINUTES_GUEST` 20, `INFER_SESSION_MINUTES_USER` 60, `INFER_MAX_LORAS` 8. `INFER_MAX_ACTIVE` and `INFER_DAILY_USD` are shared with v1.

**The session lifecycle:**

1. The person presses "Start a session".
2. The platform checks the per-client minutes (20 a day for guests, 60 signed in) and `INFER_DAILY_USD`. It counts committed spend as billed so far plus the current lease, like training's committed spend.
3. It reuses the live pool, or creates one (status "starting").
4. When the pool posts "serving", a platform step loads the session's adapter through the pinned TLS connection.
5. The session goes live with `ends_at` = now + its minutes. The lease is the latest `ends_at` + 10 minutes.
6. With 8 sessions live, new ones wait in line, with an estimate from the earliest `ends_at`.
7. The last session to end lets the lease run out, and the pool stops.

The existing workflow and the 5-minute sweep still enforce shutdown.

**Routes:**

| Route | Who | Does |
|---|---|---|
| `POST /api/models/{jobId}/sessions` | a run's owner or an admin (v2.1: anyone, within the per-client minutes) | -> `{ sessionId, key, state }`. The key is shown once. |
| `GET` and `DELETE /api/models/{jobId}/sessions/{id}` | the same | State, or end it early |
| `POST /api/glimmer/v1/chat/completions` | `Authorization: Bearer mm_glim_...` | Streams SSE. The model is pinned to the session's adapter, or to the base for comparing. `max_tokens` defaults to 1,024 and is capped at 2,048. Context is capped at 16K, `n` is 1, and there is no `best_of`, beam search or prompt logprobs. 30 requests a minute and 2 at once per key. `<\|` in user text is neutralized, as `neutral_prompt` does today. Usage is metered from the stream, as the gateway does (`lib/gateway/handler.ts:297-327`). 503 `glimmer_offline` with Retry-After when the pool is off. |
| `POST /api/lab/{id}/try` | as today | Streams when the model is on the pool |

- **The client.** A streaming `pinnedPost` (`lib/train/serve.ts:80-181`) checks the fingerprint before writing a byte, passes chunks to a `ReadableStream`, and aborts the GPU request when the browser goes away. Its `maxDuration` is 300, as the gateway's route has.
- **Using it from a product.** The base URL `https://muse-muse.vercel.app/api/glimmer/v1` works with products' `GLIMMER_URL`, `GLIMMER_API_KEY` and `GLIMMER_MODEL` as they are (`template/lib/meta/glimmer.ts:3-16`). Keys end with their session (60 minutes at most), so this is for trying a model, not for hosting a product.

**Cost** [I, from $2.29 an hour]:

- A lone 60-minute session costs about $2.86 (60 minutes, plus 5 to start, plus the 10-minute idle tail). A lone 30-minute one costs about $1.72.
- Four people at once pay about $0.57 to $0.72 each.
- Always-on would be $54.96 a day. A 9-hour warm window on judging day is $20.61.
- A pool filesystem for the image and the weights would add about $15 to $20 a month per region. v2.0 does without one, and measures the cold start first.

**Spikes before building it:**

1. Serve run 2's adapter on vLLM FP8, on an H100 PCIe or a GH200, and confirm the adapter's attention-gate weights land on vLLM's `output_gate_proj`. Then replay the 40 held-out prompts greedily and compare them with the stored tuned answers. The adapter was trained on the 4-bit base and is served on FP8 here [I].
2. Time each part of the cold start, and measure real tokens a second.
3. Check GH200 capacity (`GET /instance-types`).
4. As an experiment, try DFlash with LoRA. v0.32.0's docs mark speculative decoding with LoRA as incompatible, and the fix merged after it (PR #63186) is tested on CPU only.

**Tests:**

- **The TLS front** against a fake vLLM (a small HTTP server that streams SSE), in `runner.test.ts`: the path allowlist, the key on every route, a load with a wrong sha256 refused, the lease and the drain, and a slow client cut at the deadline.
- **The platform side:**
  - `lab-try.test.ts`, extended: streaming through the pin, with no bytes before the fingerprint check.
  - `store.test.ts`: the session queue and lease.
  - `routes.test.ts`: the keys, limits and metering.

## Feature 5: Running it on your own computer

### The page (`/fine-tuning/{jobId}/run`, linked from the model page and the run page)

1. **The header.** The file sizes, "needs at least 24 GB of memory" and the under-18 notice. "Try it live" is the fallback: a box while a session is open, a run's owner starting one in v1, and anyone within the per-client minutes in v2.1 (Feature 4).
2. **Your computer.** The picker from Feature 2.
3. **The verdict.** "Runs well", "Runs slowly" or "Won't run here", with the build, a speed range and the download time.
4. **The app, pre-picked.**
   - A Mac with Apple silicon gets LM Studio, with the Llama app as the alternative.
   - Windows gets LM Studio.
   - Linux gets Ollama or llama.cpp.
   - An Intel Mac gets the hosted version, or Ollama with a "slow" warning.
   - An "Other ways" tab has llama.cpp, Ollama and Jan.
5. **A checklist,** one step at a time:
   1. Install the app from its official link.
   2. Get the model: the deep link, then "Did it open?" Yes or No. A web page can't reliably tell whether an app is installed.
   3. Say hello: paste the system message and held-out prompt 0, then compare with the tuned answer shown.
6. **"Stuck?" on every step.** It opens the troubleshooting tree at that step, with "Copy diagnostics".

What the page never does:

- download 17 GB inside the browser;
- offer `.command`, `.cmd` or `.ps1` downloads;
- probe localhost on its own;
- send browser signals to the server.

### Per app [V unless marked; local-run notes]

- **LM Studio** (macOS 14 or later on Apple silicon; Windows x64 with AVX2, or ARM; Linux AppImage):
  - The deep link is `lmstudio://open_from_hf?model=<ns>/<repo>&file=<file>.gguf`.
  - LM Studio's terms forbid redistributing it, so it is never on the drive.
  - On M5 chips, prompt processing is 2 to 3 times slower than MLX would be [R].
- **The Llama app** (Mac; `brew install --cask llama-app`, or the .dmg): the deep link is `llama://install?repo=<ns>/<repo>&quant=<LEVEL>`. It serves `http://localhost:9931/v1` and says when no build fits. The Windows tray app opens only models already installed.
- **llama.cpp** (`brew install llama.cpp` or `winget install llama.cpp`, build b10353 or later):
  - The command is `llama serve -hf <ns>/<repo>:<LEVEL> --no-mmproj`.
  - Its web UI is at `http://127.0.0.1:9931`.
  - `-hf` defaults to Q4_K_M and fetches a vision projector unless told not to.
- **Ollama** (0.32.8 or later): download the file, write a Modelfile, `ollama create`, then `ollama run`. Avoid `ollama run hf.co/...` for Glimmer files: its import generated `<|start|>` and `<|message|>` stops and gave empty replies (issues #17939, #18808). Whether a repo `params` file fixes that is a spike [I]. The Modelfile for a `trainChannel` model:

  ```text
  FROM ./muse-glimmer-30b-<slug>-Q4_K_M.gguf
  RENDERER glimmer
  PARSER glimmer
  SYSTEM """You are <role>.

  Reasoning strength: low."""
  PARAMETER temperature 0
  PARAMETER num_ctx 8192
  ```

  `RENDERER` and `PARSER` are accepted by Ollama's parser but not documented. For an old adapter, the card gives a `TEMPLATE` that opens `to=user` and stops at `<|eot|>`, `<|eom|>`, `<|end_of_text|>` and `<|start|>` (quantization notes).
- **Jan** (Apple silicon, macOS 13.6 or later; deep link `jan://models/huggingface/<id>`): on the "Other ways" tab. Its Glimmer support is unchecked [I].

### Making it behave like the eval

- **The system message.** Paste it exactly: "You are <role>." then a blank line, then "Reasoning strength: low.". Meta's current template reads that line and doesn't add a second one [V template], and it renders the same text as training did [V, both templates read]. Local apps default to high reasoning [V], and LM Studio's "Reasoning Strength" field should be set to low too.
- **The sampling.** Temperature 0, to match the greedy eval [I]. Meta's defaults (1.0, top_p 0.95, top_k 64) give more varied answers.
- **An old adapter** (run 2) needs `tuned.jinja` from its GGUF repo. That is Meta's template with the default level set to low and a generation prompt that opens `to=user`. In llama.cpp: `--chat-template-file tuned.jinja --skip-chat-parsing --reasoning off`, with `"stop": ["<|eom|>", "<|start|>"]`. In LM Studio: My Models, the gear, Prompt Template, Jinja.

### Launchers

Never from the website:

- Chrome warns first-time visitors about `.command`, `.bat`, `.cmd` and `.ps1` files [V Chromium's file types].
- A downloaded `.command` loses its executable bit [V].
- Since macOS Sequoia, the only override is Privacy & Security, Open Anyway [V].
- Smart App Control blocks `.bat`, `.cmd` and `.ps1` files from the internet, with no override [V].

Files copied from a USB stick carry no quarantine or Mark of the Web (Base Drive lesson, `docs/troubleshooting.md:88-90`), so launchers ship only on the drive (Feature 6).

### Troubleshooting tree and the assistant

**v1 is a fixed tree** (`lib/vibe/troubleshoot.ts`, pure data). It works while Meta is down, and each answer is one step:

| Symptom | Likely cause | Fix |
|---|---|---|
| "unknown model architecture: 'muse-glimmer'" | an engine older than b10353 | Update: LM Studio's runtime, `brew upgrade llama.cpp`, or Ollama 0.32.8 or later |
| "unable to allocate ... buffer", "failed to fit params", "insufficient system resources" | not enough memory | The next smaller build, 8K context, `--no-mmproj`, close other apps |
| `to=self<\|message\|>` or `<\|start\|>` in the answer | an engine that doesn't know the Glimmer format | Update. Then check that the template wasn't replaced. |
| An empty answer, or thinking that never ends | high reasoning, a small `max_tokens`, or an old adapter without `tuned.jinja` | Set the system line's "Reasoning strength: low.", raise `max_tokens`, use `-np 1` in llama-server, use `tuned.jinja` |
| Very slow | partly on the CPU, or an old driver | `ollama ps` shows "100% GPU" or a split; NVIDIA driver 551.61 or later on Windows |
| Intel Mac, or a Mac app running under Rosetta | the wrong build | `sysctl -n sysctl.proc_translated` returns 1 under Rosetta: install the native app |
| Answers, then stops halfway | Ollama's 4,096-token default context | `PARAMETER num_ctx 8192` |
| The first load takes minutes | a cold disk after a big download | Wait. Allow up to 10 minutes the first time (a Base Drive lesson: a 180 s limit was blown right after a big copy, `models.txt:9-14`). |
| Two apps fight over a port | a second engine running | Quit one, and check `ollama ps` |

**"Copy diagnostics"** copies read-only commands for the person to run and paste back:

- **Mac** [V, tested locally]: `sw_vers -productVersion; uname -m; sysctl -n machdep.cpu.brand_string hw.memsize hw.optional.arm64 sysctl.proc_translated; df -h ~`, plus `ollama ps` and the last 40 lines of its log when Ollama is the app.
- **Windows** [I, to try on a real PC]: the CPU architecture, total memory, the GPU name and `nvidia-smi`. Ignore `AdapterRAM`, which caps at 4 GB.

**v2 is an assistant on top of the tree**:

- Muse Wonder when Meta answers, or the pool's base Glimmer.
- Its inputs are the confirmed profile, the app, the build, the step and a pasted log. The log is redacted in the browser and treated as data.
- It never asks for passwords or tokens, and never suggests turning off Gatekeeper, SmartScreen, Smart App Control or Defender.
- 20 messages per client a day, counted in `DAILY_SPEND_CAP_USD`.

### Cost, who, and what is automatic

- **Cost.** The page and the tree are static and cost nothing. The v2 assistant costs one Muse Wonder or pool call per message, about $0.01 to $0.04 [I], inside the existing caps.
- **Who.** Anyone, for any model with a public GGUF repo.
- **What is automatic.** All of it; no admin step.
- **Files the page builds on.** It reads the GGUF job's file list and the model's system line from the store. It never calls the Hub from the browser beyond the deep links.

### Tests

- `troubleshoot.test.ts`: every symptom string reaches its fix, and no answer suggests turning a protection off.
- `pages.test.tsx`: the page per verdict, the deep links built from the repo and file, and the system message the same as the card's.
- Real: build order step 3's three machines, with Safari and Firefox on a Mac (only headless Chrome was probed).

## Feature 6: Order it on a flash drive

### What the buyer sees

1. **On a model's public page and its run-locally page:** "Get it on a flash drive".
   - **Shown only when:** `DRIVE_ENABLED` is on, the GGUF repo is public, its file checks passed, and the run isn't flagged.
   - **A panel says what's on it:** all three sizes and a runtime. It runs offline on a Mac with Apple silicon and 24 GB or more, or on a Windows PC with a 16 GB NVIDIA GPU or 32 GB of RAM. The device picker's verdict is shown next to it, so nobody orders a drive their computer can't run.
   - **The price line:** `DRIVE_PRICE_TEXT` when set, otherwise "We'll email you a quote before anything is charged".
2. **The order request, one screen.** Name, email, a US shipping address, "I'm 18 or older" and the terms. "Remember my details on this device" keeps them in this browser only (localStorage), so the next order is one click: the button sends the request straight away, shows what it sent, and offers Cancel on the order page.
3. **The order page,** `/orders/{id}`, a secret link like a run's (shown once, kept in a cookie):
   - **Statuses:** Requested, Invoiced, Paid, Flashing, Checked, Shipped (with tracking), Delivered, or Cancelled.
   - **What happens next:** "We'll email an invoice to <email> within 2 business days. Nothing is charged until you pay it."
   - **Cancel** works until the order is flashing.

### The request (`POST /api/drive/requests`)

- **Who:** anyone, not cross-site (`requireUser`), with the bot check. 3 requests per client a day (`DRIVE_CLIENT_REQUESTS`) and 20 for everyone (`DRIVE_DAILY_REQUESTS`).
- **Body:** `{ trainingJobId, build: "all" | "Q3_K_M" | "Q4_K_M" | "Q6_K", name, email, address: { line1, line2?, city, state, postalCode }, ageOk: true, termsVersion }`. US addresses only in v1 (a two-letter state and a 5 or 9 digit ZIP).
- **Checks:** the model is eligible (above), the email looks like one, nothing holds `<|` or control characters, and every field is bounded.
- **Answer:** 201 `{ orderId, link }`, the link shown once.
- **Then:** the owner is told. v1 shows a count on the admin page and, when `DRIVE_NOTIFY_URL` is set, POSTs a one-line summary to it (a Slack or Discord webhook), never the buyer's address or email.

### Table `drive_orders` (one migration)

- `id`, `status` (requested, invoiced, paid, flashing, checked, shipped, delivered, cancelled), `secret_hash`;
- what goes on the drive: `training_job_id`, `build`, `gguf_repo`, `gguf_commit`, the files with their sha256, `image_version`;
- the buyer: `name`, `email`, `address` (jsonb), all purged 60 days after delivery or cancellation;
- the owner's notes: `invoice_ref`, `amount_text`, `note`;
- consent: `terms_version`, `terms_accepted_at`, `age_ok_at`;
- quotas: `client_key`, `browser_key` (HMACs, as vibe runs keep them);
- the bench: `serial`, `verify_result` (PASS or FAIL), `manifest_sha256`;
- shipping: `carrier`, `tracking`;
- a timestamp for every status.

### Paying by card (added Oct 30)

With Stripe set up, the order is paid when it's placed instead of invoiced. The invoice flow stays for sites without it.

| | |
|---|---|
| **When** | `env.driveCheckout`: `DRIVE_ENABLED`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `DRIVE_PRICE_CENTS` (US cents, US shipping included) are all set, and the key is a test key or `DRIVE_LIVE_SALES=1`. Each order keeps how it is paid (`payment`: `card` or `invoice`), so turning Stripe on or off never changes an order already placed. |
| **Terms** | `DRIVE_CARD_TERMS` and `DRIVE_CARD_TERMS_VERSION` (`lib/drive/terms.ts`): paid on Stripe's page, cancel for a full refund until flashing, unpaid orders cancelled after 7 days. |
| **The buyer** | The form says "Continue to payment ($59)". The request saves the order as `requested`, then `POST /api/drive/orders/{id}/checkout` (the link's cookie only) answers with a Checkout Session URL and the browser goes there. Stripe returns them to `/orders/{id}?session={CHECKOUT_SESSION_ID}`, which reads the session and settles it, so the page shows Paid before the webhook lands. The order page shows the order's link (rebuilt from the browser's own cookie), since a buyer who went straight to Stripe never saw it. While unpaid, the page has "Pay $59 by card". |
| **The session** | One line item in USD, card only (so paid means paid, with no bank transfer to wait for), the buyer's email for Stripe's receipt, and the order id in `client_reference_id` and in the session's and the payment's metadata. Never the address. The order's open session is reused, and a new one is idempotent on the previous session's id, so double clicks make one. |
| **The webhook** | `POST /api/drive/stripe`, for `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Only a body signed with `STRIPE_WEBHOOK_SECRET` within 5 minutes counts. A paid session moves its card order from `requested` to `paid` in one guarded update (the `checkout` actor), keeping the payment's id in `invoice_ref` and "$59 by card" in `amount_text`, and `DRIVE_NOTIFY_URL` gets one line without the buyer's details. A replay changes nothing. A payment for an order already paid by another session, or for a cancelled order, is refunded at once. A failure answers 500 so Stripe retries. |
| **Refunds** | Cancelling a paid card order (the buyer until flashing, an admin until shipping) refunds it in full on Stripe, keyed on the payment so it happens once, and keeps `refund_ref`. A refund that fails leaves a note on the order for the admin queue and never undoes the cancel. |
| **The admin** | Card orders never show Invoiced or Paid; the route refuses them (409). "To invoice" counts invoice orders only, and the queue shows which orders are card ones, refunds sent, and refunds that failed. The page names any Stripe setting that's missing, never its value. |
| **The purge** | A card order still unpaid after 7 days (`CARD_UNPAID_DAYS`) is cancelled by `checkout`, so its buyer's details go 60 days later as any cancelled order's do. |
| **Not yet** | Sales tax (Stripe Tax isn't on), other currencies, shipping outside the US, and the counsel, tax and insurance review before live sales. |

Tests: `lib/drive/__tests__/checkout.test.ts`, with a fake Stripe.

### The admin queue (`/fine-tuning/orders`, `requireAdmin`)

- One row per order: model, build, the buyer's name and email, status, waiting since. An order still Requested after 2 business days is highlighted.
- Actions: **Invoiced** (with the invoice reference and amount text), **Paid**, **Cancel**, and **Shipped** (carrier and tracking). Flashing and Checked come from the bench script.
- The buyer sees each change on the order page. The invoice email is the owner's own; the platform sends no email in v1.
- Every change is checked against the allowed transitions (`lib/drive/logic.ts`), so v1 needs no workflow.

### Fulfillment: the bench

The owner flashes on a Mac with a powered hub, so a hub doesn't brown out the drives (a Base Drive lesson, `PRODUCTION-CHECKLIST.md:186-188`). The bench script is `scripts/drive-bench.ts`, run with `npx tsx`, holding `DRIVE_BENCH_TOKEN`. The platform stores only its hash, and the token can only read the queue and report.

1. `GET /api/drive/bench/next` returns the oldest Paid order: its repo and commit, the files with their sizes and sha256, the image version and a serial.
2. Fetch the three files from the public repo at that commit, or reuse the copy on the Mac, and check the sha256 of each. A new model is a 53.5 GB download once.
3. The owner plugs in a stick.
   - The script lists only removable USB disks between 60 and 70 GB.
   - It shows the disk's name and size.
   - It erases only after the owner types the disk id. It never touches an internal disk.
4. Erase as exFAT on MBR, labeled MUSEMUSE. Copy the image and the three files. Write `PROVENANCE.json` with the serial, and `SHA256SUMS`. Strip extended attributes and run `dot_clean`, so no quarantine flag rides along in `._` files. Then eject.
5. The owner unplugs the stick and plugs it back in, so the check reads the stick and not a cache. The script hashes every file on the stick against the manifest. A FAIL never ships.
6. `POST /api/drive/bench/{id}/flashed { serial, manifestSha256, result }`.
7. Buy the label by hand (for example in Pirate Ship). Then enter the tracking number on the admin page, at `/fine-tuning/orders`.

Owner time is about 10 minutes of hands-on work per drive. The write itself runs alone, and its length depends on the stick [I]:

- a stick that holds 60 to 100 MB/s takes 9 to 15 minutes for 53.6 GB;
- at 20 to 30 MB/s it takes 30 to 45 minutes;
- at the 6.7 MB/s Base Drive's 3.2 GB took (`FLASH.md:136`, which may include its check), it would take over two hours.

The first real drive (build order step 6) measures the chosen stick's sustained write past its cache, before any stock is bought.

### What goes on the drive

```text
MUSEMUSE (exFAT, MBR, about 53.6 GB on a 64 GB stick)
  Start Here.html                      works offline: which build fits, the system message, Open Anyway steps
  Start (Mac).command   Start (Windows).cmd
  Verify (Mac).command  Verify (Windows).cmd    shasum -a 256 -c / Get-FileHash against SHA256SUMS
  model/   muse-glimmer-30b-<slug>-Q3_K_M.gguf  -Q4_K_M.gguf  -Q6_K.gguf  system.txt  [tuned.jinja]
  runtime/ macos-arm64/  windows-x64-vulkan/  windows-x64-cpu/     one pinned llama.cpp build (MIT), with its LICENSE
  MODEL_CARD.md
  licenses/ Apache-2.0 (verbatim)  USAGE_POLICY.md (Meta's, verbatim)  llama.cpp LICENSE and notices  CHANGES.md
  PROVENANCE.json   the repo and commit of every file, sha256, the llama.cpp build and its asset sha256, the serial
  SHA256SUMS
```

- **Sizes.** The models take 53.49 GB, and the runtimes about 70 MB (macOS arm64 about 11 MB, Windows Vulkan about 34 MB and CPU about 18 MB in b10353 [V]). A 64 GB stick holds about 59.6 GiB.
- **The stick.** Buy name-brand sticks with both USB-C and USB-A, since MacBooks have only USB-C [I].
- **Left off:** the training data, which a Meta model wrote (its output terms are unchecked; the card links it), LM Studio (its terms forbid redistribution), and the vision projector (v1).
- **`CHANGES.md`** states what was changed, as Apache 2.0 section 4(b) asks: fine-tuned with a LoRA adapter, merged, quantized.

### Launcher behavior [I design; the build table is generated from Feature 2's constants when the image is built, so the web and the drive agree]

1. **Check the machine.** On a Mac, `sysctl -n hw.optional.arm64` must be 1, since `uname -m` says x86_64 in a Rosetta Terminal [V tested]. An Intel Mac is refused in one plain sentence. On Windows, it reads the architecture and the GPU.
2. **Pick the build.** Read RAM and VRAM, pick the build, and say why in one sentence. Low RAM is a warning; too little disk for a copy is a hard stop (a Base Drive lesson, `setup-mac.sh:1113-1122`).
3. **Copy, if the person agrees.** Offer to copy the build to the computer, which is recommended: loads are faster and the stick can come out. The sha256 is checked while copying.
4. **Start the server.** Start `llama-server` on `127.0.0.1` at a free port, with `--jinja -c 8192 --no-mmproj`, plus `tuned.jinja` for an old adapter. Wait for `/health` up to 10 minutes the first time, then open the browser.
5. **The system message.** The built-in web UI needs it pasted, and Start Here has a copy button. Whether llama-server can preset it from the command line is a spike. If it can't, the drive gets a small offline chat page that always sends it.
6. **Nothing downloads.** The launchers never download anything.

**Trust on the buyer's machine** (drive notes, with Base Drive lessons):

- **On a Mac:**
  - A stick with no quarantine flags isn't blocked by Gatekeeper, but macOS asks for access to a removable volume [V].
  - A `.command` can't be notarized. Selling to strangers needs a notarized app in a stapled DMG [V, `docs/signing-macos.md:8-10`, `:133-135`].
- **On Windows:**
  - exFAT drops the Mark of the Web, so SmartScreen usually doesn't prompt [S].
  - Smart App Control on a clean Windows 11 install blocks unsigned apps with no bypass [S]. Until signing, the drive page says "Windows PCs with Smart App Control on aren't supported yet".
- **Neither OS runs anything automatically from a stick,** so the buyer double-clicks Start.

### Cost per order (US)

| Item | Cost |
|---|---|
| 64 GB stick, USB-C and USB-A, name brand | $15 ($10 to $25 [S]) |
| Spares (3%), mailer, card, label | $1.70 [I] |
| USPS Ground Advantage, under 4 oz | $7 ($5 to $9; commercial holiday prices $7.33 to $8.95 from Oct 4 to Jan 17 [S]) |
| Invoice payment fees (a card through the owner's invoicing tool, about 3%) | $1.80 [I] |
| Owner time, about 10 minutes at $30 an hour | $5.00 [I] |
| Refund reserve | $1.45 [I] |
| **Total** | **about $31.95, leaving about $27 at $59** |

- **Alternatives:**
  - A 32 GB stick holding only the picked build (about 17 GB) costs about $30 and writes three times faster. The request's `build` field allows it.
  - Later, once llama.cpp can convert Glimmer adapters (fact 3), a drive could hold Meta's base files, flashed ahead in batches, plus a 200 to 400 MB adapter per order.
- **One-time costs:**
  - a powered hub, $40 to $80 [I];
  - a first stock of 10 sticks, about $150;
  - an Apple Developer ID at $99 a year, and Windows signing at about $9.99 a month [S].
- **Vendors.** TrepStar loads data per project at $15.25 shipped, but stops at 32 GB, and single-quantity projects cost about $1 a GB more [V]. Bulk duplicators need one image per batch [V]. Neither fits per-order models now.

### Legal and trust

- **Apache 2.0.** Include the license and keep the notices; Glimmer ships no NOTICE file [V]. Mark the changes. Section 6 grants no trademark rights.
- **The label and README** say: "Fine-tuned from Meta's Muse Glimmer 30B (Apache 2.0). Not made, reviewed or endorsed by Meta." That matches the card (`TRAINING.md:634`). Packaging is where trademark risk concentrates, so ask the hackathon organizers (decision 9).
- **The Usage Policy, verbatim.** It requires the 18+ box, and K-12 sales need a separate review.
- **Shipping.** US only (the request form takes US addresses). Going international adds customs forms, VAT, CE, UKCA and WEEE marks, and embargo screening [I].
- **The FTC mail-order rule.** State "ships in 2 business days", and send a delay notice with an option to cancel [S].
- **The refund policy.** Call it a refund policy rather than a warranty; Magnuson-Moss applies to written warranties over $15 [I].
- **Before live sales:** a counsel, tax, insurance and Prop 65 review (a Base Drive lesson, `docs/liability-checklist.md:181-206`).

### Tests

- **`lib/drive/__tests__/`:**
  - The request route with its dependencies faked: eligibility, the 18+ box, US-only addresses, the quotas by either key, cross-site requests, the link secret, and that the order view never shows the address to anyone but the link's holder and admins.
  - The status transitions in `lib/drive/logic.ts`, including cancel before flashing only.
  - The bench routes with the token: only Paid orders, one serial per order, a FAIL report never moving an order to Checked.
- **The bench script** against a fake platform and a temporary folder standing in for the stick. No real disk is touched. It covers the manifest, a hash mismatch failing and an interrupted copy.
- **Then real:** one request on the live site in a private test, and one real 64 GB stick:
  - Measure its sustained write past its cache.
  - Test on a clean Mac: no quarantine, the removable-volume prompt, `.command` on exFAT runs [I].
  - Test on a clean Windows 11 PC with Smart App Control on, then off.

## Who may do what

| Action | Anyone (the shared guest) | A run's owner (its link) | A buyer (the order link) | Admin or automation | GPU job token | Bench token |
|---|---|---|---|---|---|---|
| Check an idea, submit a run | 10 checks and 1 run a day | | | yes | | |
| See a run's progress | | own run | | every run | | |
| Cancel before training | | own run | | yes | | |
| Approve, refuse, stop, Make private, Judge now | | | | yes | | |
| Start a live session (v1) | | own run, 1 a day | | any adapter | | |
| Type into a live box | judged models | own run, judged or not | | any | | |
| Download files | public repos | | | | | |
| Request a drive, see the order | request (18+), 3 a day | request (18+) | own order, cancel before flashing | every order: invoiced, paid, shipped, cancel | | |
| Read the bench queue (Paid orders), report flashed | | | | yes | | yes |
| Callbacks, dataset pages, uploads, Hub plans | | | | | own job only | |

## What runs on its own and what an admin does

| Piece | On its own | Admin |
|---|---|---|
| Rule checks, request check, spec | yes | sees the verdicts |
| Starting a run | yes, under `VIBE_APPROVAL=auto` (the default), except ideas the check marks "review" | approves or refuses flagged ideas, or every run under `VIBE_APPROVAL=admin` |
| Data, data check, training, judging | yes | Stop |
| Adapter and data publishing | when the gate passes | Make private; publish a held run privately |
| Quantizing and GGUF publishing | after the adapter publishes | can run it for any judged adapter, privately |
| v1 sessions | started by a run's owner | can start one for any adapter |
| v2 pool | starts with the first session, stops after the last lease | kill switch |
| Drive orders | the request, its checks, the order page, the 2-day highlight | invoices, marks paid, flashes, ships, cancels |

## How it reuses the lab

| New piece | Reuses |
|---|---|
| Request and data checks, spec | The platform's Meta client, structured output, `recordUsage`, `spendPaused` (`datasets.ts`, `judge.ts`); the quota pattern of `app/api/inspirations/route.ts:16-36` and `lib/quota.ts:61-72` |
| Dataset | `createDataset` and `makeDataset` as they are |
| Training | glimmer-lora, plus `trainChannel` and `publish: 2`; `createTrainJob` is the jobs route's body; the sweep, the limits and termination are unchanged |
| Judging | `judge.ts` as it is; "Judge now" reuses its steps |
| Publishing | `publishToHub`, the hub state with its claim, `hub-cards.ts` helpers (names, escaping, `noEmDashes`) |
| Quantizing | The runner, `ctx.run` with the stall watch, the glimmer venv on the cache, the sha256-pinned download pattern of uv, `ctx.hub_upload` (1 MB streaming, multipart, re-plan on 403, deadline cut-off), events and metrics |
| v1 inference | glimmer-serve, `/api/lab/{id}/try`, the serve key and pinned TLS |
| v2 inference | The serve key, `pinnedPost`, the TLS front's protections, the firewall ruleset, gateway token hashing and stream metering |
| Local help | The card's template facts (`glimmerTemplate`), `student_system`, the eval items as test prompts |
| Drive | Workflow hooks, `requireAdmin`, the hub state's sha256 list, Base Drive's lessons as ideas only |

## Risks and unknowns

1. **Meta.**
   - Muse Wonder writes every dataset and judges every run, and Meta billing is down.
   - Steps 0 to 4 avoid it.
   - A base-Glimmer teacher and judge on the pool is the fallback if it stays down. It changes the lab's story and needs its own eval.
2. **Local behavior.** Whether a `trainChannel` model picks `to=user` reliably in every stock app is unproven until one run, and the file checks catch it before publishing. Run 2's files need `tuned.jinja`.
3. **The merge.**
   - The adapter was trained on the 4-bit base and is merged into bf16.
   - The KL divergence check compares each build with the merged model, not with the evaluated one, so the one-time spike in step 1 compares answers too.
4. **The Hub.**
   - The plan body for multi-GB files, how long presigned URLs last, and 53.5 GB of upload inside the job's time are all unproven.
   - Storage is "best effort" for free public repos, at about 6.4 TB a month at 4 runs a day.
   - Nothing has run against the real Hub yet (`TRAINING.md:661`).
5. **Guest mode.**
   - One shared identity, and IP and cookie quotas that a VPN dodges.
   - The caps, the bot check and the "review" verdicts bound the spend and the content. Each day that is at most $20 of training GPU (`TRAIN_DAILY_USD`) and $15 of serving GPU (`INFER_DAILY_USD`), and Meta stays under the $40 platform cap (`DAILY_SPEND_CAP_USD`).
6. **Public content.** Requested models are published under the owner's namespace, and Muse Wonder's checks will miss some cases. Make private exists, and "review" verdicts always wait for a person.
7. **Device promises.** A dense 30B needs at least 24 GB, and most laptops have less. The picker says so first, and the drive page prints the minimum spec. That one line drives the return rate (a Base Drive lesson, `PRODUCTION-CHECKLIST.md:192-196`).
8. **The drive.** Stick write speed, unsigned launchers on Windows with Smart App Control, and the trademark and rules questions. Invoices and payments are the owner's own, outside the platform.
9. **The pool.** Adapter weight names on vLLM, FP8 under an adapter trained on 4-bit, the arm64 image, GH200 capacity, and the cold-start time.
10. **The cache.** Adapters are kept forever (`TRAINING.md:313`) and filesystems are never deleted. Quantizing writes only to local disk, so it adds nothing there.
11. **Lambda limits.** The account's limit on instances at once is unknown, and it caps `TRAIN_MAX_ACTIVE` plus `INFER_MAX_ACTIVE` [I].

## Sources

Research notes for this design (scratchpad, Oct 28, 2026; raw evidence next to each):

- Code map: `<local scratchpad>/vibe/codemap/01-notes-recipes-runner.md`
- Quantization: `<local scratchpad>/vibe/quantization/raw/` (configs, safetensors headers, llama.cpp, Ollama, MLX and Unsloth sources, `llama_release_b10353.json`)
- Local runs: `<local scratchpad>/vibe/local-run/evidence-log.txt` and `probe/out/result-0.json`
- Lambda inference: `<local scratchpad>/vibe/lambda-inference/INDEX.txt` (`lambda/pricing.txt` holds the instance specs)
- Flash-drive orders: `<local scratchpad>/vibe/flash-drive-order/INDEX.txt` (`raw/convert_lora_to_gguf.py`, Stripe and USPS pages, TrepStar)

Re-checked for this draft:

- the code: `lib/train/types.ts:12,457,466`, `glimmer.ts:105-112`, `app/api/train/jobs/route.ts:187,205,245-255`, `lib/env.ts:133-185`, `lib/auth.ts:101`, `lib/quota.ts:61-72`, `template/lib/meta/glimmer.ts:5-13`, `hub-cards.ts:742,780`, `app/api/train/jobs/[id]/dataset/route.ts:23-29`, `hub/route.ts:40-44,149-155`;
- the Workflow docs on hooks and event limits;
- the Lambda instance specs;
- the llama.cpp b10353 release assets;
- the `ndim` and `shape` lines in both converters.

Primary pages:

- **Models:** https://huggingface.co/meta-models/Muse-Glimmer-30B, https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF
- **llama.cpp and vLLM:** https://github.com/ggml-org/llama.cpp (PR #26841, issues #27975 and #29982), https://github.com/vllm-project/vllm (v0.32.0; #53254, #63186, #63435)
- **Ollama:** https://ollama.com/library/muse-glimmer, and commit 98acec40ae
- **Hugging Face Hub:** https://huggingface.co/docs/hub/storage-limits, https://huggingface.co/docs/hub/ollama, https://huggingface.co/docs/hub/lmstudio
- **Lambda:** https://lambda.ai/pricing, https://docs.lambda.ai/public-cloud/billing/
- **Stripe:** https://docs.stripe.com/payments/checkout/fulfillment, https://docs.stripe.com/webhooks, https://docs.stripe.com/elements/express-checkout-element, https://stripe.com/pricing
- **Base Drive lessons**, cited by file:line above: `~/base-drive` (`FLASH.md`, `PRODUCTION-CHECKLIST.md`, `docs/troubleshooting.md`, `docs/signing-macos.md`, `docs/liability-checklist.md`, `models.txt`, `setup-mac.sh`)
