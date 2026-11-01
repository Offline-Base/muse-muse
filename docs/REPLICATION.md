# Paper replication

The design for Muse Muse taking a research paper and replicating it. Written Oct 31, 2026 for the owner's ask that day: "muse
muse should be able to get a research paper and replicate it, like if theres a research paper on continual learning or
something". Nothing here is built yet. Branch `tg-replicate`, worktree `~/mm-wt/replicate`. The cloud check behind the numbers
is `docs/spikes/replication-2026-10-31/README.md`.

Read `docs/DESIGN.md` (the build pipeline), `docs/MUSE_CODE_FULL.md` (how Muse Code runs) and `docs/TRAINING.md` (the GPU lab)
first; this builds on all three.

Tags, as in `docs/DECISION_MODELS.md`: **[V]** verified here from code, a file, a live page or a measured run; **[I]** inferred
or estimated, needs a test; **[R]** reported by a third party, not reproduced.

## In one minute

- **In:** a PDF, or an arXiv or OpenReview link the platform fetches under each site's rules.
- **Read:** Muse Wonder writes a **paper card**: the claims with short quotes and where they are, the method's steps, datasets,
  models, hyperparameters, compute, the reported numbers, and what the paper leaves ambiguous. A code check refuses quotes that
  aren't in the paper.
- **Plan:** a replication plan sized to a budget, full or reduced, with every deviation named and the claims it can and can't
  test. **The person approves it with its cost before anything runs**, and the cost is a hard cap.
- **Build:** Muse Code writes fresh code from the card in a research workspace with no internet, plus component tests the
  platform checks. A smoke run measures one cell and re-checks the cost.
- **Run:** the platform, not Muse Code, runs the experiment matrix with seeds, tuning on validation only, the test split
  written in only after the choices are frozen.
- **Out:** a report product with its own link (claims against measured numbers, intervals, plots, a verdict per claim:
  replicated, within noise, not replicated, not attempted), the code as a zip, and a Demo Studio video. Verdicts come from code,
  never from a model's words.
- **Compute:** CPU in a sandbox now (measured: a whole Split MNIST comparison costs about $0.05 of sandbox time [V]). GPU only
  after Nov 4, through a new sandboxed job kind in the lab, because generated code on a rented GPU is the riskiest thing here.
- **Who:** the new parts are new code, built by this session (General); wave 3 adds a dataset entry and, later, a host line.
- **By Nov 3:** a CPU-only slice on the continual learning example. After Nov 4: OpenReview, the GPU tier, a language model
  continual learning paper on the Glimmer lab, and comparing with the authors' code.

## Words used here

| Word | Means |
|---|---|
| replication | One run of this flow for one paper, with its own id, sandbox, budget and report |
| paper card | The structured reading of a paper (section 1.2). Our words, plus short quotes with locations |
| claim | One thing the paper says it found, that a number can test: a value ("reaches 98.6%") or a comparison ("EWC forgets less than fine-tuning") |
| plan | What will run, at what scale, with which deviations, at what cost (section 1.3) |
| deviation | Anything the plan does differently from the paper, with why and which claims it touches |
| cell | One point of the experiment matrix: a method, a dataset, a setting and a seed |
| research workspace | The folder in the replication's sandbox where Muse Code writes the experiment code (section 1.4) |
| tolerance | How far a measured number may be from the paper's and still count as replicated, fixed at approval |
| reduced scale | A plan that runs less than the paper did (fewer epochs, a subset, a smaller model). Always labeled |

## 1. The flow

```text
person: a PDF, or an arXiv or OpenReview link              (Replicate a paper, /replicate)
  -> intake       the platform fetches or stores the PDF; license and metadata recorded
  -> card         Muse Wonder writes the paper card; quotes checked against the PDF's text
  -> plan         Muse Wonder proposes; code prices it and checks its rules
  -> approval     the person approves the plan and its cost cap          (nothing has run or been spent on compute yet)
  -> implement    Muse Code in the research workspace, egress closed except the brokered Meta routes
  -> tests        the platform runs the component tests and its own contract tests
  -> smoke        one tiny run, one full cell timed; the cost re-checked against the cap
  -> tune         validation-only runs for any hyperparameter the paper doesn't fix; choices frozen
  -> matrix       the test split is written in; every cell, every seed, run by the platform
  -> verdicts     code compares measured with reported, per claim
  -> report       the report product deployed, the code zip, the Demo Studio video
```

Statuses: `fetching`, `reading`, `planned` (waiting for approval), `approved`, `implementing`, `testing`, `smoke`, `tuning`,
`running`, `reporting`, `done`, `partial` (some claims not attempted because of a failure or the cap), `failed`, `refused`,
`cancelled`.

The replication is its own durable workflow (`lib/replicate/workflow.ts`, Vercel Workflow like `lib/pipeline/workflow.ts`), not
a build. It reuses the build's pieces: the sandbox helpers in `lib/sandbox`, the Muse Code runner, `respondStructured` from
`lib/brief/structured.ts`, the spend cap, and the publisher for the report.

### 1.1 Intake

Three ways in, all through the platform. The sandbox never fetches a paper.

| Source | How | The site's rules we follow |
|---|---|---|
| PDF upload | The same direct-to-Blob ticket flow as inspo uploads (`docs/DESIGN.md`, Large files), PDF only, up to 25 MB | The person says they may use it |
| arXiv link or id | Metadata from the arXiv API at `export.arxiv.org` (title, authors, version, and the license), then the PDF of that exact version | One request every 3 seconds and one connection at a time across all our machines, as one platform-wide gate in `rate_limits`. Link the abstract page. Never imply arXiv endorses us. Store the PDF for this research use only and never serve it [V, arXiv API terms read Oct 31] |
| OpenReview link (after Nov 4) | The note and its PDF through OpenReview's API | Use the submission for the purpose it was made available for, never modify it, follow any upload or download limits the editors set, and read the license the venue or authors gave [V, OpenReview terms read Oct 31] |

- **Where the PDF lives.** Blob, under `papers/<replicationId>/<12 random hex>.pdf`, never linked from any page and deleted when
  the replication ends or after 14 days. Muse Wonder gets it inline, as the brief writer sends PDFs today (`lib/brief/media.ts`
  sends `input_file` with `file_data`) [V], so no public URL is needed. The report links to the abstract page and never to our
  copy.
- **The license is recorded, and decides what the report may show.** arXiv's terms: "The redistribution of e-prints requires
  permission from the copyright holder", and most are under arXiv's non-exclusive license to distribute [V]. So the report shows
  short quotes only (section 2.4), whatever the license, and the code zip never holds the paper.
- **Refusals.** The card step refuses a paper whose experiments need human subjects, private or personal data, weapons or other
  harm the brief policy already refuses (`lib/brief/policy.ts`), or a dataset no one can get legally. It says why.
- **Version pinning.** An arXiv paper is pinned to the version fetched (`v2`, say), and the report names it.

### 1.2 The paper card

Muse Wonder reads the PDF and writes the card in one structured call (`respondStructured`, strict JSON schema, one repair
retry) with a `check` hook that runs code checks. Schema in `lib/replicate/card.ts`:

```ts
PaperCard {
  verdict: "yes" | "partly" | "no";            // can this be replicated here at all
  refusal: string | null;
  paper: { title; authors: string[]; venue: string | null; year: number | null;
           source: { kind: "pdf" | "arxiv" | "openreview"; id: string | null; version: string | null; url: string | null };
           license: { id: string | null; from: "arxiv" | "openreview" | "person" | "unknown" } };
  summary: string;                             // our words, at most 600 characters
  claims: Array<{                              // 1 to 12
    id: "C1"...; kind: "value" | "comparison"; text: string;      // our words
    quote: string;                             // verbatim, at most 25 words
    where: string; page: number;               // "Table 2", "Section 4.1"
    metric: string; reported: number | null; spread: { kind: "sd" | "se" | "ci95" | "range"; value: number } | null;
    reportedSeeds: number | null;
    setting: { dataset: string; scenario: string | null; model: string; methods: string[] };
    headline: boolean }>;
  method: { name: string; steps: Array<{ id: "S1"...; text: string; equation: string | null; where: string }> };
  baselines: Array<{ name: string; where: string }>;
  datasets: Array<{ name: string; role: "train" | "eval" | "both"; source: string | null; statedLicense: string | null;
                    size: string | null; splits: string | null; where: string }>;
  models: Array<{ name: string; architecture: string; params: string | null; where: string }>;
  hyperparameters: Array<{ name: string; value: string; appliesTo: string; where: string }>;   // value may be "not stated"
  compute: { hardware: string | null; time: string | null; where: string | null };
  ambiguities: Array<{ id: "A1"...; what: string; readings: string[]; affects: string[] }>;  // 2 to 4 readings each
  code: { url: string | null; license: string | null };      // recorded, never fetched before the results (section 1.8)
}
```

Code checks, each a problem for the repair retry, then a refusal to go on if it persists:

- **Every quote is in the paper.** The PDF's text comes from the research snapshot's `pypdf` in the replication's sandbox,
  page by page, normalized (NFKC, ligatures such as "ﬁ" to "fi", whitespace, hyphens at line ends). A quote must appear on its
  page. A value claim's number must appear on its page too.
- **Short quotes only:** at most 25 words each, and at most 300 quoted words in the whole card.
- **Every hyperparameter has a place or says "not stated".** Unstated ones become ambiguities or tuned values in the plan.
- **Ambiguities are real choices:** each has 2 to 4 readings and names the claims it touches.

The spike shows why the ambiguity list matters: given "the mean absolute value of the gradient ... over 256 training examples",
Muse Code took the absolute value of the mean, the cheaper of two readings, and didn't say so [V]. Here the card names both
readings, the plan picks one, and the code must say where it lives (section 1.4).

### 1.3 The plan and its approval

Muse Wonder proposes the plan from the card and the budget the person picked; `lib/replicate/plan.ts` checks it and prices it
in code.

```ts
ReplicationPlan {
  scale: "full" | "reduced";
  tier: "cpu" | "gpu";
  tested: Array<{ claimId; as: "value" | "comparison"; tolerance: number; unit: string; why: string }>;
  notAttempted: Array<{ claimId; why: string }>;      // with the reason: scale, data, compute, budget
  deviations: Array<{ id: "D1"...; paper: string; ours: string; why: string; affects: string[]; changesNumbers: boolean }>;
  choices: Array<{ ambiguityId; reading: string }>;  // one per ambiguity
  tuned: Array<{ name: string; grid: number[]; on: "validation" }>;   // only what the paper doesn't fix
  matrix: { methods: string[]; datasets: string[]; settings: string[]; seeds: number; cells: number };
  estimate: { museUsd: number; sandboxUsd: number; gpuUsd: number; totalUsd: number; minutes: number; basis: string };
  cap: { usd: number; minutes: number };
}
```

Rules the code enforces, whatever the model proposed:

- **Scale is honest.** `reduced` whenever any deviation changes the amount of training, data, model size or seeds. A value claim
  touched by a deviation with `changesNumbers: true` can't be tested; it moves to `notAttempted` with that deviation as the
  reason. Comparison claims can still be tested at reduced scale, and are labeled so.
- **Seeds.** At least 3 per cell for any verdict other than not attempted; 5 by default when a cell is estimated under a minute.
  The spike's case for this: every seed had EWC forgetting less than fine-tuning, but 3 seeds left the interval across zero
  [V].
- **Tolerances are fixed now,** before any run: the paper's own spread when it reports one, else 1 point of accuracy (or 2% of
  the value for other metrics), stated per claim. They can't change after a result is seen.
- **Tuning only on validation.** A held-out share of the training data (10% by default); the grid is in the plan.
- **The estimate:** Muse Code from the build history (about $3 on Muse Wonder for one build of this size [I], see
  `docs/DESIGN.md`, Cost model), sandbox time at the Pro rates in the spike's runner, cells times an estimated cell time from
  the card's compute line and model size, plus the tuning grid. The `basis` line says which parts are guesses until the smoke run.
- **The cap** defaults to the estimate plus 30%, at most the owner's per-replication ceiling (`REPLICATE_MAX_USD`, $10 by
  default) and the platform's daily spend cap. It covers Meta, sandbox and GPU together.

**Approval.** The plan page shows, in this order: the claims it will test and those it won't (with why), every deviation, every
ambiguity choice, the matrix, and the cost with its cap. One button, "Approve and run for up to $X", sends `POST
/api/replications/{id}/approve { capUsd }`. Nothing runs before it, other than the card and plan calls, which the page priced
before intake. The person can edit the matrix, the seeds and the cap; any edit is checked and priced again.

### 1.4 Implementation by Muse Code

A replication has one sandbox from the research snapshot (section 3.3), named `rep-<id>`, persistent while it runs, with a
policy of its own in `lib/replicate/policy.ts` (as unit 9's sandboxes have `lib/caps/code/policy.ts`): deny by default, the
brokered `api.meta.ai` routes for Muse Code as in `lib/sandbox/policy.ts`, and the platform host for dataset files. No PyPI, no
GitHub, no Hugging Face.

The platform writes the workspace before Muse Code starts and rewrites its own files before every round:

```text
/vercel/research/
  AGENTS.md          the rules (platform's, rewritten each round)
  paper/card.json    the card
  paper/pages/       the PDF's text, one file per page, for reading the method closely
  plan.json          the approved plan
  configs/           one JSON per cell, written by the platform from the plan
  data/              dataset files, written by the platform (train and validation only until tuning ends)
  rep/               Muse Code's package
  tests/             Muse Code's component tests (pytest)
  DECISIONS.md       each ambiguity choice and deviation by id, with the file and function that carries it
```

The contract, in AGENTS.md and checked by the platform:

- `python -m rep.run --config configs/<cell>.json --seed N --split val|test --out out/<cell>-<seed>.json` runs one cell and writes
  `{cell, seed, split, metrics: {name: value}, curves?: {name: number[]}, matrix?: number[][], seconds, threads, versions}`.
- `--split test` exits with an error while `data/` has no test files, so a tuning run can't touch them.
- Write the method from the card and the paper's text only. The authors' code isn't available here and must not be
  reconstructed from memory: write it fresh.
- Every method step `S<n>` and every choice `A<n>` and deviation `D<n>` appears in `DECISIONS.md` with where it lives.
- Every component test imports from `rep`. One test per method step at least, named for it (`test_S2_...`).
- Keep each cell's work inside its time limit and use the threads the config gives.

Muse Code runs as builds run it (the engine in `docs/MUSE_CODE_FULL.md`): Muse Wonder in production, `muse-spark-1.3-contributor`
with a made-up paper for tests (section 5), reasoning high, a 25-minute round, reminders as builds have them. One fix round is
allowed for failing component tests and one for a crashing smoke run, both inside the cap.

The spike measured the simplest version of this: given one made-up paragraph, Muse Code on Contributor wrote, tested and ran
the method in 42.5 s for $0.0064, reading nothing outside its folder [V].

### 1.5 Component tests and the smoke run

The platform runs, in order, and a failure goes back to Muse Code once:

1. **Muse Code's tests:** `pytest -q tests/` under `coverage run`. The run fails when a test file doesn't import from `rep`,
   or when a method step's functions (named in `DECISIONS.md`) were never executed by the tests. The spike's `test_rid.py`
   defined its own copy of the damping and checked that, so it would pass with the shipped code broken [V]; this check catches
   exactly that.
2. **The platform's contract tests** (`lib/replicate/contract/`, copied in read-only): the CLI runs on a tiny config; the output
   matches the schema; the same seed twice gives the same metrics at a fixed thread count; two seeds give different ones; `--split
   test` refuses while there is no test data.
3. **The smoke run:** one cell at about 1% of its work, then one whole cell with seed 0 on validation, timed. The platform
   extrapolates the matrix and the tuning grid from it. When the total passes the approved cap, it stops and asks again with the
   matrix that fits, never cutting cells on its own.

### 1.6 The experiment matrix

The platform runs the cells. Muse Code isn't in the loop, so the matrix costs sandbox time only.

- **Tuning first,** on validation, for each `tuned` entry: seed 0, the plan's grid. The chosen values and the whole validation
  table are saved, then frozen.
- **Then the test split** is written into `data/`, and every cell runs with every seed. The code's git commit is recorded once,
  before the first test run; a change after that starts the matrix over.
- **Packing:** cells run as detached commands with `taskset` and a fixed thread count (`startTaskStep` and `pollTaskStep` in
  `lib/pipeline/build-steps.ts` are the pattern). The spike's MLP gained only about 20% from 8 threads over 4 [V], so small cells
  run two at a time at 4 threads each on 8 vCPUs.
- **Limits per cell:** the plan's time per cell, plus 50%, then killed and marked failed; one retry. A replication's sandbox
  stays within its session limit (45 minutes on Hobby, 24 hours on Pro, `README.md`); a longer matrix continues in a new session
  from the research snapshot with the workspace restored from Blob.
- **Record:** every cell's output JSON, its seconds, threads and versions. The spike found the same seed gives slightly different
  numbers at 4 and 8 threads in 7 of 12 runs, and that it flipped EWC's lambda choice on a fourth-decimal tie [V], so threads are
  part of the record and the report says so.

### 1.7 Verdicts

`lib/replicate/verdict.ts`, pure and unit tested. Inputs: the claim, the plan's tolerance, the per-seed measurements (paired by
seed for comparisons), and the scale. `m` is the mean, `[lo, hi]` the 95% t-interval over seeds, `r` the reported value.

| Verdict | A value claim | A comparison claim (difference `d` = ours A minus B, paired by seed) |
|---|---|---|
| replicated | `abs(m - r) <= tolerance` | the interval is all on the paper's side of zero, and when the paper gives a size, `abs(mean d - its size) <= tolerance` |
| not replicated | `r` is outside `[lo, hi]` and outside the tolerance (and outside the paper's own spread, when it gives one) | the interval is all on the other side of zero, or excludes the paper's size |
| within noise | anything else: the interval and the tolerance disagree | anything else, such as an interval across zero |
| not attempted | in `notAttempted`, or its cells failed, or the cap stopped them, or fewer than 3 seeds ran | same |

At reduced scale every verdict carries the label "at reduced scale" with its deviations, and the headline can only be "N of M
claims replicated at reduced scale". A value claim touched by a number-changing deviation never gets a verdict other than not
attempted (section 1.3).

Worked from the spike's own numbers (our code, not a paper's): "a 200-example replay buffer keeps class-incremental Split MNIST
above 0.80 average accuracy" would be **replicated** (0.835, interval 0.821 to 0.849); "EWC forgets less than fine-tuning when the
task is known" would be **within noise** with 3 seeds (mean difference 0.035, interval -0.041 to 0.111), and would need more seeds
[V].

### 1.8 Comparing with the authors' code (after the results, after Nov 4)

Only once the report exists, and only when the card found a code URL:

- The platform reads the repository's license first. With an open source license, a read-only pass (a Muse Code session in a
  sandbox whose firewall allows only that one Git host, or the platform cloning it to Blob) lists where the authors' defaults
  differ from our plan: hyperparameters, data handling, the metric's definition, the ambiguity readings. It never copies code into
  ours or runs theirs inside our replication.
- With no license, all rights are reserved, as with Scion in `docs/DECISION_MODELS.md`: ideas only. The comparison lists
  differences in words and nothing else.
- The report adds a "Compared with the authors' code" section: each difference, which claim it may explain, and a link to their
  repository. Our verdicts don't change; a rerun with their reading is a new replication with its own plan and cost.

## 2. The result

### 2.1 The report product

The report is a product: its own Vercel project and link (`musemuse-<slug>`), a product page, a Demo Studio video and a
connector, like everything Muse Muse ships. Unlike other products, **Muse Code doesn't write it**. A fixed report app
(`template/replication-report/`, Next.js with the template's design tokens) reads one `report.json` the platform writes from the
database, so every number on screen comes from the measurements and the verdict code.

Pages:

- **Overview:** the paper's citation and a link to its abstract page, the version, the scale label, verdict counts, what ran,
  how long, what it cost.
- **Claims:** a row per claim: our words, the short quote with its location, the reported value and spread, ours as mean and
  interval over n seeds with the per-seed values, the tolerance, and the verdict chip with "at reduced scale" when it applies.
- **Method and choices:** the steps, each ambiguity with the reading taken, each deviation with why, and the tuned values with
  the validation table.
- **Runs:** the matrix, each cell's seeds and seconds, and plots drawn as inline SVG from the curves and accuracy matrices
  (for continual learning: accuracy on each task after each task, and the average over time per method), in the dashboard's
  chart style.
- **Code:** the zip, its commit, and how to rerun one cell.
- **Sources:** the paper's BibTeX, every dataset with its source and license, and the tools (PyTorch and its version).

Its `musemuse.json` is fixed too: actions `list_claims`, `get_claim` and `get_run`, read-only, so the Muse app can ask "which
claims held?".

### 2.2 The code download

`GET /p/<slug>/get/code.zip`, made by the platform from the research workspace:

- `rep/`, `tests/`, `configs/`, `DECISIONS.md`, `results/` (every cell's JSON), `plan.json`, and a README: what this is
  ("written by Muse Code from the paper card, not the authors' code"), the commit, the exact versions, and how to rerun with uv.
- `card.json` keeps only our words and the short quotes. `paper/pages/` and the PDF never go in.
- `CITATION.cff` cites the paper. A LICENSE file carries the owner's chosen license for generated code (section 6).
- The Muse Code spike's filter: workspace only, no symlinks followed, drop files whose sha256 matches the Muse Code binary or
  `fx`, drop ELF files, 50 MB in all (`docs/spikes/musecode-2026-10-31/README.md`, "The binary") [V there].

### 2.3 The Demo Studio video

The report app ships a fixed smoke test: open the overview, open a claim, show its plot, open Method and choices, press the
download. Demo Studio records it like any product's (`docs/DEMO_STUDIO.md`), with no model waits, so no badge. A second, optional
clip is the replication room's time-lapse, recorded the way the build room's is.

### 2.4 Honest by construction

- No "replicated" without measured numbers from at least 3 seeds, computed by `verdict.ts`. Muse Wonder and Muse Code write no
  verdict, no measured number and no summary of results. The report's prose is fixed text with numbers filled in.
- Reduced scale is labeled on every verdict and in the headline. A value claim at a changed scale is not attempted, not compared.
- Tolerances and seeds are fixed at approval, before any result.
- Tuning sees validation only; the test split isn't in the workspace until the choices are frozen.
- Failed and capped cells show as not attempted, with why. A partial replication says partial.
- Quotes: at most 25 words each, 300 in all, each with its page and location. No figures or tables are reproduced from the paper;
  ours are redrawn from our numbers.
- Citations: the paper on every page, datasets and tools on Sources. The paper's own name is never used as the product's name:
  the product is "Replication of <short title>", with "Not affiliated with the authors" under it.
- A checked report: a fixed test fails the build when any number on the Claims page lacks a `data-cell` link to `report.json`.

## 3. Compute

### 3.1 CPU in the sandbox (now)

What the spike measured on the builder snapshot, 8 vCPUs, 16 GB (Ubuntu 26.04, Xeon at 2.9 GHz) [V]:

| | |
|---|---|
| Setup with open egress: uv, Python 3.12, CPU torch 2.11.0 and torchvision 0.26.0, MNIST | 18 s; the torch wheel is 181.5 MiB, the venv 869 MB |
| Split MNIST, 2 scenarios, 3 methods, 3 seeds (18 runs) | 37.9 s at 8 threads, 44.7 s at 4 |
| EWC lambda search, 6 values, 2 scenarios, on validation | 39.9 s at 8 threads, 48.9 s at 4 |
| One run (5 tasks, 1 epoch each, 425 steps) | 0.9 to 3.7 s |
| Peak memory | 1.15 GB |
| The whole sandbox, 250 s including Muse Code | about $0.11, worst case $0.19 |

Caps for the CPU tier (`lib/env.ts`, one block):

| Setting | Default | Means |
|---|---|---|
| `REPLICATE_ENABLED` | off | The Replicate a paper page and routes |
| `REPLICATE_VCPUS` | 8 | The sandbox size, at most 8 |
| `REPLICATE_MAX_USD` | 10 | Ceiling on one replication's cap: Meta, sandbox and GPU together |
| `REPLICATE_SANDBOX_MINUTES` | 120 | Ceiling on one replication's sandbox minutes |
| `REPLICATE_CELL_MINUTES` | 20 | Ceiling on one cell |
| `REPLICATE_DAILY` | 5 | Replications started per builder per day |

What fits: anything that trains in minutes on CPU (MLPs and small CNNs on MNIST-sized data, linear models, small RL
environments, tabular methods). What doesn't: anything with an ImageNet-sized dataset, a large model, or GPU hours in its compute
line. The plan says so and offers reduced scale or the GPU tier.

### 3.2 GPU through a controlled path (after Nov 4)

Wave 3's unit 11 runs a shared Glimmer endpoint and "train on my data" on the lab's existing recipes. Neither runs generated code,
and the lab never has (`docs/TRAINING.md`: recipes are fixed Python strings). A replication on a GPU needs a new job kind, and it
is the riskiest piece of this design.

**Two routes, in order of preference:**

1. **Map the paper onto a fixed recipe.** Many language model papers are a training schedule over an existing model: a data mix,
   a replay ratio, a learning rate schedule, LoRA settings. If the plan can express the method as params of `glimmer-lora` (or a
   new fixed recipe written and reviewed by people, as decide mode is in `docs/DECISION_MODELS.md`), no generated code reaches the
   GPU. This is the default for the language model example (section 5).
2. **`replicate-run`, a sandboxed recipe** for generated code. Its shape:
   - The trusted runner (`runner.py`, as today) holds the job token. The generated code runs in a jail with no network
     namespace (bubblewrap with `--unshare-net`, or a container with `--network none`), as an unprivileged user with no
     capabilities, `no-new-privileges`, a read-only root, and only `/work` (the code, read-only), `/data` (read-only) and `/out`
     mounted, plus the GPU device files [I: which of these Lambda's image ships needs the smoke recipe's check first].
   - The code and data come in before the jail starts: the runner downloads a code tarball and dataset files the platform
     names in the job's params with their sha256, from Blob URLs that expire. Results leave only through the runner's upload
     grants (`ctx.upload`) after the jail exits.
   - **The platform's keys never reach it:** no `LAMBDA_API_KEY`, `HF_TOKEN`, Meta key, Blob write token or database URL in user
     data, the jail or the instance, as for every lab job. The job token never enters the jail.
   - **No model cache.** It launches without the region's cache filesystem, so it can't read other jobs' adapters or weights, and
     with no firewall ruleset, so nothing listens.
   - **Limits:** `REPLICATE_GPU_JOB_USD` (default $3, under `TRAIN_JOB_MAX_USD` $5), inside `TRAIN_DAILY_USD` ($20) and
     `TRAIN_MAX_ACTIVE` (1), so it shares the lab's one GPU with decision models and training. The sweep, deadline and
     termination are the lab's. Admin only until wave 3's trust unit lands; then the owner decides.

**The risk, plainly.** Code a model wrote from a stranger's PDF runs on a GPU in the owner's Lambda account. Lambda's firewall
rulesets admit inbound traffic (`docs/TRAINING.md`, Firewall ruleset) and, as far as the lab's code uses them, don't limit
outbound, so outbound limits must be inside the VM [I]. If the jail held, the worst case is a wasted GPU budget. If it broke
(a kernel bug, a misconfigured mount), the code would have the instance's network and the job token: it could send traffic from
the owner's account until the deadline, and post fake callbacks for that one job for up to 15 minutes after it ends. The
mitigations limit the damage, not the chance: nothing else secret on the box, a short deadline, one job at a time, admin approval
per job, and Lambda's Acceptable Use rules still make the owner answerable. That is why it waits until after Nov 4 and needs the
owner's yes.

### 3.3 Python, wheels and datasets: what changes in the firewall

Today's build firewall allows `api.meta.ai` (brokered routes only), `registry.npmjs.org` and the platform host
(`lib/sandbox/policy.ts`) [V]. Wave 3's unit 10 plans `pypi.org` and `files.pythonhosted.org`, GET only, for briefs with Python.

What a replication needs, and the choice for each:

| Need | Option | Choice |
|---|---|---|
| The common stack: torch (CPU), torchvision, numpy, scipy, scikit-learn, pandas, matplotlib, pytest, coverage, pypdf | A **research snapshot**: the builder snapshot plus uv, Python 3.12 and a hash-locked venv, made by `scripts/make-research-snapshot.ts` with open egress, like the builder snapshot | **This, for the slice.** No package host is opened. The venv is about 0.9 GB with torch [V]; the snapshot's size and start time are not measured yet [I] |
| torch from PyPI | PyPI's Linux torch wheels pull the CUDA libraries, gigabytes a VM won't use [R] | Never. The CPU index served all 13 packages on its own in the spike [V] |
| Another package the plan names | `download.pytorch.org` (GET, path starting `/whl/`) or PyPI (unit 10's GET rule), only for that replication, only from a lock with hashes (`uv pip compile --generate-hashes`, then `--require-hashes`), as the board's training packages are installed (commit 1e1caf8) | After Nov 4. The exact wheel paths on the PyTorch host need one check with only that host allowed [I] |
| Datasets | Open `huggingface.co` or a dataset's own host in the build firewall | **Never.** Hub downloads redirect to other storage hosts, any repository would be reachable, and some datasets ship loading code |
| | **The platform fetches to Blob first:** a dataset registry entry (id, title, source, license as read and when, files with bytes and sha256), mirrored once by a script, served to sandboxes from the platform host | **This.** Wave 3's unit 4 owns the registry (`lib/caps/files/datasets.json`, `{GATEWAY_URL}/datasets`); until it lands, the replication workflow writes the files into the workspace itself from Blob |

### 3.4 Dataset license checks

- A dataset is used only if its license allows the research use, and mirrored to our (public) Blob store only if it allows
  redistribution, as unit 4's guard says. A dataset that can't be mirrored (ImageNet's terms, say) makes its claims not
  attempted, with that reason, unless the person uploads their own copy and confirms their right to use it; such a copy stays in
  that replication's namespace and is deleted with it.
- **Record the source and the text read, with the date,** because hosts disagree. MNIST: the Hugging Face card's license field
  reads "mit" [V, read Oct 31]; other hosts state other licenses [R]. The registry keeps which one it relied on, and the report's
  Sources page shows it.
- Hugging Face datasets, when mirrored after Nov 4: a pinned revision, Parquet files only (no loading scripts), the card's
  license tag recorded, and refused when the tag is missing or not on the allowed list.
- The spike's MNIST sha256s are in `docs/spikes/replication-2026-10-31/results/mnist-sha256.txt`, ready for a registry entry.

## 4. Ownership

| Piece | Owner | For the slice |
|---|---|---|
| Milestone builds, round time by size (unit 2, engine) | wave 3 | Not needed. A replication chains its own steps in its own workflow; its Muse Code rounds use today's 25-minute cap |
| The caps frame, `CAP_BUILD_HOSTS` (unit 2) | wave 3 | Not used: a replication's sandbox has its own policy file |
| Vetted datasets on Blob, `{GATEWAY_URL}/datasets` (unit 4, files) | wave 3 | Unit 4 adds MNIST and Fashion-MNIST in its format; we hand over the sha256s. Until then the workflow writes the files itself |
| `/exec`, Pyodide, browse (unit 9, code) | wave 3 | Not used |
| Muse Code sessions (`code_sessions`, tg-musecode) | General | Not used; replications use the build engine |
| PyPI in the build firewall, Python functions (unit 10, runtime) | wave 3 | Not used; the research snapshot instead. After Nov 4, one `replicate` line for the PyTorch host, if needed |
| Shared Glimmer endpoint, train on my data (unit 11, gpu) | wave 3 | Not used. Its `training_jobs.product_id` (0025) can link a GPU job to a report later |
| The lab (`lib/train`), decide mode | General (tg-decide) | The GPU tier's `replicate-run` recipe goes here after Nov 4 |
| **New:** intake, arXiv client and its gate, the card, the plan and its pricing, approval, the research snapshot, the workspace and its contract tests, the replication workflow, the matrix runner, verdicts, `report.json`, the report app, the code zip, the replication room, migration 0028 | General | All of it |

**Proposal.** This session (General) builds every new piece on `tg-replicate`, since it already owns the Muse Code engine, the lab
and decision models, which the GPU tier joins. The wave 3 session does one thing for the slice, inside its own unit 4: the MNIST
and Fashion-MNIST registry entries. To stay off wave 3's shared files (section 3 of `docs/CAPABILITIES.md` on `tg-cap-contract`),
replication adds its own `lib/replicate/policy.ts`, its own workflow and its own template folder, and touches only shared files
every unit appends to: one `lib/env.ts` block, one `.env.example` block, new tables at the end of `lib/db/schema.ts`, one
`STORED_PREFIXES` entry (`papers`, `replications`) in `lib/local-files.ts`, and one cleanup registration.

**Migration `0028_replications`**, the next free number after wave 3's 0027_code_sessions, journal time `1793432270646` by the contract's rule
(`1793431490646 + (27 - 15) * 60000`), merged after 0026:

- `replications`: `id`, `user_id`, `status`, `source` jsonb, `paper_path`, `card` jsonb, `plan` jsonb, `approved_at`, `cap_usd`,
  `spent` jsonb (`{meta, sandbox, gpu}`), `sandbox_name`, `muse_session_id`, `code_commit`, `report` jsonb, `product_id` (null,
  references `products`), `created_at`, `ended_at`.
- `replication_cells`: `id`, `replication_id`, `cell`, `seed`, `split`, `status`, `seconds`, `threads`, `metrics` jsonb,
  `tier`, `cost_usd`, `started_at`, `ended_at`.
- `replication_events`: `id`, `replication_id`, `seq`, `type`, `payload` jsonb, `at`, as `build_events`, so the room can reuse the
  build room's log parts.

## 5. The demo slice, by Nov 3

**The worked example: continual learning, on CPU.** The setup the spike ran: Split MNIST, 5 tasks, an MLP, fine-tuning, EWC and
replay, the task-known and class-incremental scenarios. A paper of this kind usually makes exactly the claims the report is built
for: EWC and similar methods nearly match replay when the task is known, and fall to fine-tuning's level class-incremental while
replay holds up. The ambiguity the card must catch is the one that made those papers necessary: which scenario "Split MNIST"
means.

Two runs make the demo:

1. **Tests, on `muse-spark-1.3-contributor`, with a made-up paper only.** A two-page PDF we write about a made-up method (the
   spike's "Running Importance Damping" grown into a paper, with made-up reported numbers and a planted ambiguity). Meta may train
   on Contributor prompts, so no real paper's text goes there.
2. **The video, on Muse Wonder, with one real arXiv paper** on Split MNIST continual learning, chosen with the owner, fetched
   under arXiv's rules. Estimate: about $3 to $4 of Muse Wonder for the card, plan and implementation [I], and about $0.10 of
   sandbox time [V for the experiment at this size]. Reduced scale where the paper trained longer, labeled.

| # | Unit | Files | Hours | Heavy |
|---|---|---|---|---|
| R0 | Contract: types, flags, the 0028 number agreed with wave 3 | `lib/replicate/types.ts`, this doc | 1 | no |
| R1 | Intake: PDF upload, arXiv link with the 3-second gate | `lib/replicate/intake.ts`, `lib/replicate/arxiv.ts`, `app/api/replications/route.ts` | 3 | no |
| R2 | Migration and store | `drizzle/0028_replications.sql`, `drizzle/meta/`, `lib/db/schema.ts` (end of file), `lib/replicate/store.ts`, store tests | 3 | yes (PGlite) |
| R3 | The card: schema, prompt, writer, quote checks | `lib/replicate/card.ts`, `lib/prompts/paper-card.ts`, tests with a fixture card and page texts | 4 | no |
| R4 | The plan: rules, pricing, approval route | `lib/replicate/plan.ts`, `lib/replicate/estimate.ts`, `app/api/replications/[id]/approve/route.ts`, tests | 4 | no |
| R5 | Research snapshot and sandbox policy | `scripts/make-research-snapshot.ts`, `lib/replicate/policy.ts`, a lock file for the venv | 2 | no (cloud) |
| R6 | Workspace, contract tests, Muse Code rounds, smoke run | `lib/replicate/workspace.ts`, `lib/replicate/contract/*.py`, `lib/replicate/workflow.ts`, `lib/prompts/replicate.ts` | 5 | no |
| R7 | Tuning, the matrix runner, verdicts | `lib/replicate/matrix.ts`, `lib/replicate/verdict.ts`, verdict tests (every row of section 1.7, plus the spike's numbers) | 4 | no |
| R8 | The report app, `report.json`, the code zip, its smoke test and the video | `template/replication-report/**`, `lib/replicate/report.ts`, `lib/replicate/zip.ts`, publish through `lib/publish` | 6 | yes (browser) |
| R9 | The replication room: intake, card, plan and approval, live steps | `app/replicate/page.tsx`, `app/replicate/[id]/page.tsx`, `components/replicate/*` (design tokens only) | 4 | yes (browser) |
| R10 | Real runs: the made-up paper on Contributor, end to end; then the real paper on Wonder for the video | results in this doc | 2, plus wall time | no |
| R11 | Docs and the build log | this doc, `README.md` one paragraph | 1 | no |

About 39 hours. Order: Nov 1, R0 to R4; Nov 2, R5 to R8; Nov 3, R9 and R10 in the morning, so a failure leaves the afternoon for
one fix, then R11. At most 2 heavy units at once from this session, inside wave 3's limit of 4 across sessions. This competes with
decision models (about 32 hours on the same days, `docs/DECISION_MODELS.md`), so the owner's order decides which starts first.

### Cut order

When time runs short, cut from the top:

1. The real paper on Wonder: the video uses the made-up paper's run, labeled made up.
2. The arXiv link: PDF upload only.
3. The live log in the replication room: a step list that refreshes.
4. The report's connector actions.
5. Comparison claims: value claims only.
6. Packing two cells at once: one at a time.
7. The smoke run's re-estimate: the plan's estimate and the hard cap only.
8. The Demo Studio video: screenshots on the product page.

Never cut: approval with its cost before anything runs; measured numbers behind every verdict; the reduced scale label; tuning
on validation only; short quotes only; the code zip's filter.

### After Nov 4

- **A language model continual learning paper on the Glimmer lab.** The knowledge run is already continual learning: new 2026
  facts taught to Muse Glimmer with replay of older material, old-fact retention measured (`docs/KNOWLEDGE_UPDATE.md`, Training
  methods; `docs/KNOWLEDGE_RUN_LOG.md`). A paper about replay ratios or learning rate schedules for continual training maps onto
  `glimmer-lora` params plus two probe sets, new facts and old facts, so it runs as a fixed recipe (section 3.2, route 1), always at
  reduced scale (LoRA on a 30B model, not the paper's setup). Two things from the run log shape it: the 40 old facts stayed 40/40
  through stage 1, a ceiling, so retention needs a larger and harder old set; and a run is minutes to hours of GPU, so 3 seeds of 3
  settings is 9 jobs, about $8 to $15 on an A100 [I], over a single job's cap and a day's training cap.
- OpenReview intake.
- The GPU tier (`replicate-run`), with the owner's yes.
- Comparing with the authors' code (section 1.8).
- Packages beyond the snapshot, from hash-checked locks; Hugging Face datasets through the registry.
- Signed-in builders, then visitors, under wave 3's trust caps.

## 6. Owner decisions

Each with a recommendation.

1. **Where it lives:** a "Replicate a paper" card on Make that opens `/replicate`, behind `REPLICATE_ENABLED`, off in production
   until a real replication passes.
2. **Who may run one:** admins only through Nov 4, then signed-in builders with `REPLICATE_DAILY` and wave 3's per-builder caps.
3. **The ceiling per replication:** $10 (`REPLICATE_MAX_USD`), with each replication's own cap set at approval.
4. **Real papers on Contributor:** never; test with made-up papers on Contributor, and read real papers on Muse Wonder only.
5. **The paper's PDF:** keep it private in Blob only while the replication runs (14 days at most), link the abstract page, and show
   quotes of 25 words or fewer.
6. **The license of the generated code in the zip:** MIT, with a line that Muse Code wrote it from the paper and it isn't the
   authors' code.
7. **Python packages:** bake the common stack into a research snapshot now, and open a package host only for a hash-checked lock
   after Nov 4.
8. **Datasets:** mirror to Blob only datasets whose license allows redistribution, record the source of each license, and never
   open Hugging Face in a build firewall.
9. **Generated code on a GPU:** none before Nov 4; after, the sandboxed `replicate-run` recipe, admin approval per job, $3 a job.
10. **The authors' code:** never read before our results exist; after, compare under its license only, and with no license list
    differences in words.
11. **The demo paper:** a real arXiv paper on Split MNIST continual learning for the video on Wonder (about $4), plus the made-up
    paper for every test.
12. **Order against decision models:** build the replication slice after decision models' D0 to D3, sharing Nov 2 and 3, and cut
    from section 5's list rather than slip either.
13. **The migration number:** take 0028, settled with the wave 3 session on Nov 1 (0027 went to code_sessions).

## 7. Risks

- **Silent wrong method.** Muse Code can write code that runs and implements another method. The spike showed it taking one
  reading of an ambiguous step without saying so [V]. Mitigations: the ambiguity list, `DECISIONS.md` with locations, tests per
  step that must run the shipped code, and a read-only review pass over the method steps when time allows. None of these prove the
  code right, which is why the report shows the choices next to the numbers.
- **Tests that test nothing.** Seen in the spike [V]; the coverage and import checks in 1.5 are the answer.
- **Overclaiming.** A model summarizing results could say more than the numbers do. Verdicts and the report's numbers come from
  code; the report app is fixed; a test fails the build on an unlinked number.
- **Noise.** Three seeds give wide intervals [V]; small differences come out "within noise". The plan asks for more seeds where
  cells are cheap; the report explains the verdict.
- **Reruns differ.** Thread counts change the numbers slightly and can flip a hyperparameter choice [V]. The record has threads and
  versions; the report says a rerun elsewhere may differ in the last digits.
- **Cost overrun.** Estimates from a card are guesses. The smoke run re-checks; the cap is hard; the matrix never shrinks without
  the person.
- **Copyright.** Papers are mostly not ours to redistribute [V, arXiv's terms]. The PDF is never served, quotes are short and
  counted, figures are redrawn from our numbers, and the zip never holds the paper.
- **Site rules.** A burst of arXiv links could break its 3-second rule; one platform-wide gate holds every fetch.
- **Dataset licenses.** Hosts disagree [V for MNIST]; the registry records which source it trusted.
- **Generated code on a GPU** (section 3.2). Deferred, jailed, and the owner's call.
- **Sandbox session limits.** A long matrix outlives one session; the workspace is restored from Blob into a new one.
- **Contributor data use.** Meta may train on Contributor prompts; tests use made-up papers only.
- **The schedule.** Thirty-nine hours on top of decision models and wave 3. The cut order keeps a demo that is honest, if smaller.

## The cloud check

`docs/spikes/replication-2026-10-31/README.md` has the method, every number, and how to run it again. In short: one sandbox from
`BUILDER_SNAPSHOT_ID`, 8 vCPUs, open egress for an 18 s setup, then deny-all; a fresh Split MNIST experiment (fine-tuning, EWC
and replay, 2 scenarios, 3 seeds, lambda tuned on validation) in 79.7 s at 8 threads and 95.4 s at 4; then Muse Code on
Contributor implementing a made-up method from one paragraph in 42.5 s for $0.0064. Sandbox about $0.11, Meta $0.006433, the
sandbox stopped and verified stopped, none left.

## Sources

- arXiv API Terms of Use: https://info.arxiv.org/help/api/tou.html (read Oct 31: the 3-second rule, one connection,
  redistribution needs the copyright holder's permission, link the abstract page)
- OpenReview Terms of Use: https://openreview.net/legal/terms (read Oct 31: use submissions for their purpose, don't modify them,
  editors may set limits, authors keep copyright)
- MNIST on the Hugging Face Hub: https://huggingface.co/datasets/ylecun/mnist (read Oct 31: license field "mit")
- Vercel Sandbox pricing: https://vercel.com/docs/sandbox/pricing (the rates in the spike's runner)
- Vercel Sandbox firewall: https://vercel.com/docs/sandbox/concepts/firewall
- In this repo: `docs/DESIGN.md`, `docs/MUSE_CODE_FULL.md`, `docs/TRAINING.md`, `docs/KNOWLEDGE_UPDATE.md`,
  `docs/KNOWLEDGE_RUN_LOG.md`, `lib/sandbox/policy.ts`, `lib/brief/media.ts`, `lib/brief/structured.ts`; on other branches,
  `docs/DECISION_MODELS.md` (tg-decide), `docs/CAPABILITIES.md` (tg-cap-contract), `docs/spikes/musecode-2026-10-31/README.md`
  (tg-musecode); `~/mm-wt/_plan/wave3.md`.
