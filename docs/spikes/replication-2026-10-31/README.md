# Replication spike, Oct 31, 2026

## The answer

**Yes. A build sandbox from the builder snapshot installed CPU PyTorch and fetched MNIST in 18 s with open egress, then, with
egress closed, ran a fresh Split MNIST continual learning experiment (fine-tuning, EWC and replay, 2 scenarios, 3 seeds) in
under 100 s.** Muse Code then implemented a made-up method from one paragraph, tested it and ran it, offline, in 42.5 s for
$0.0064 on `muse-spark-1.3-contributor`.

Three things change the design (`docs/REPLICATION.md`):

1. **Muse Code took one reading of an ambiguous sentence and didn't say so.** Its code computes importance as the absolute value
   of the mean gradient over 256 examples. The description's "mean absolute value of the gradient ... over 256 training examples"
   reads more naturally as the mean over examples of each one's absolute gradient. The paper card must list ambiguities, the plan
   must pick a reading, and the code must say where each choice lives.
2. **Its test tests nothing it shipped.** `test_rid.py` defines its own `damp()` and checks that. It never imports `rid.py`, so it
   would pass with the damping in `rid.py` broken. Component tests must import the code under test, and the platform must check
   that they do.
3. **The same seed doesn't give the same numbers at 4 and 8 threads, and that flipped a hyperparameter choice.** 7 of 12
   fine-tuning and replay runs gave slightly different accuracy matrices. EWC's lambda for the task-known scenario came out 1000 at
   8 threads and 10000 at 4, on a fourth-decimal difference in validation accuracy. The report must record the thread count and
   the validation table, and a rerun elsewhere may choose differently.

Spend: **Vercel Sandbox about $0.11** (worst case $0.19, cap $1), **Meta $0.006433** (cap $0.15), 1 sandbox, stopped and verified
stopped, then deleted. The listing found no `spike-rep-*` sandbox left.

## What ran

One sandbox, `spike-rep-mvwv7g0k429f`, from `BUILDER_SNAPSHOT_ID`, non-persistent, 8 vCPUs, 16 GB, a 30-minute timeout. 250 s
from create to stop. The scripts and every output are here; `run-spike.ts` drives the phases in order and changes the firewall
between them:

| Phase | Firewall | Exit | Time |
|---|---|---|---|
| setup (`phase-setup.sh`) | `allow-all` | 0 | 18 s |
| closed (`phase-closed.sh`) | `deny-all` | 0 | 0.2 s |
| run (`phase-run.sh`, `cl.py`) | `deny-all` | 0 | 175 s |
| muse (`phase-muse.sh`, `mc-proxy.mjs`) | `api.meta.ai` only, real key only for the proxy's placeholder | 0 | 50 s |

The machine: Ubuntu 26.04.1, x86_64, `Intel(R) Xeon(R) Processor @ 2.90GHz`, 64 GB disk with 59 GB free, system Python 3.14.4.

## Setup, with open egress

| Step | Time | Size |
|---|---|---|
| uv 0.13.1, sha256 checked (the lab's pin from `lib/train/recipes/glimmer.ts`) | 0.4 s | 38 MB binary |
| Python 3.12.15, uv-managed | 0.7 s | 104 MB |
| `torch==2.11.0+cpu torchvision==0.26.0+cpu` from `https://download.pytorch.org/whl/cpu` only, 13 packages | 10.7 s | torch wheel 181.5 MiB; installed venv 869 MB, of which torch 720 MB, numpy 31 MB, torchvision 6 MB |
| MNIST through `torchvision.datasets.MNIST(download=True)` (its md5 check) | 3.5 s | 4 gz files, 11.6 MB; 66.5 MB with the unpacked copies |
| All of it | 18 s | 299 MB in over the network for the whole sandbox |

- **The pinned versions resolved** (`pip-list.txt`). The CPU index alone served all 13 packages, so no PyPI host was needed.
  Which paths on `download.pytorch.org` the files came from wasn't recorded (the firewall was open), so a path rule for that host
  needs one more check.
- **MNIST's sha256s** (`mnist-sha256.txt`) are what a platform mirror would pin:
  `train-images-idx3-ubyte.gz 440fcabf...`, `train-labels 3552534a...`, `t10k-images 8d422c7b...`, `t10k-labels f7ae60f9...`.
- PyTorch started with 4 threads by default on an 8 vCPU VM (`torch.get_num_threads()`), so the experiment sets threads itself.

## Egress closed

After `sandbox.update({ networkPolicy: "deny-all" })`, curl to pypi.org, download.pytorch.org, the MNIST mirror, github.com,
huggingface.co, registry.npmjs.org and api.meta.ai all failed at once (exit 6, no address), and Python's `urllib` got `URLError`
for two of them (`phase-closed.txt`). Everything after this ran from the files setup left.

## The experiment (`cl.py`, written fresh)

Split MNIST: 5 tasks of 2 digits, one MLP (784-400-400-10, ReLU, 478,410 weights), Adam at 1e-3 reset each task, batch 128,
**1 epoch per task** (425 optimizer steps in all), 90% of each task's training rows (10% held out for validation). Two
scenarios: **task known** (only the task's two outputs compete, at training and test) and **class-incremental** (one 10-way head,
no task id). Methods: fine-tuning; EWC with a diagonal Fisher from 500 examples per task, labels sampled from the model, lambda
picked per scenario from 10 to 1,000,000 on the validation split with seed 0; replay with a class-balanced buffer of 200 examples,
128 of them mixed into every batch. 3 seeds. Average accuracy is the mean test accuracy over the 5 tasks after the last; forgetting
is, for each of the first 4 tasks, its best accuracy after any earlier task minus its accuracy at the end, averaged.

Results at 8 threads (`cl-8.json`, every run's accuracy matrix included). Brackets are 95% t-intervals over 3 seeds, which are wide
at n = 3:

| Scenario | Method | Avg accuracy | Forgetting | Lambda |
|---|---|---|---|---|
| Task known | Fine-tuning | 0.959 [0.892, 1.026] | 0.041 [-0.039, 0.122] | |
| Task known | EWC | 0.986 [0.979, 0.994] | 0.006 [-0.005, 0.017] | 1000 |
| Task known | Replay (200) | 0.985 [0.983, 0.987] | 0.009 [0.007, 0.010] | |
| Class-incremental | Fine-tuning | 0.192 [0.187, 0.197] | 0.986 [0.985, 0.987] | |
| Class-incremental | EWC | 0.205 [0.161, 0.248] | 0.974 [0.915, 1.032] | 10000 |
| Class-incremental | Replay (200) | 0.835 [0.821, 0.849] | 0.172 [0.152, 0.192] | |

This is the pattern the continual learning literature describes: EWC helps when the task is known and does almost nothing
class-incremental, where fine-tuning keeps only the last task (about 0.2, two classes of ten), and a small replay buffer does
far better. It is our own run of our own code, not a replication of any paper's numbers.

**Paired differences, per seed** (what a comparison claim's verdict would use):

- Task known, forgetting of fine-tuning minus EWC: 0.018, 0.071, 0.017; mean 0.035, interval [-0.041, 0.111]. Every seed has EWC
  forgetting less, yet the interval includes zero, so with 3 seeds "EWC forgets less than fine-tuning" comes out **within noise**
  under the rule in `docs/REPLICATION.md`. Cheap cells should get more seeds.
- Class-incremental, accuracy of EWC minus fine-tuning: 0.006, 0.002, 0.031; mean 0.013, interval [-0.027, 0.053].

**4 against 8 vCPUs.** The same script pinned to 4 CPUs with `taskset` and 4 threads, in the same VM (a stand-in for a 4 vCPU
sandbox, not one):

| | 8 threads | 4 threads |
|---|---|---|
| Lambda search (12 EWC runs on validation) | 39.9 s | 48.9 s |
| The matrix (18 runs) | 37.9 s | 44.7 s |
| Whole script, with load | 79.7 s | 95.4 s |
| One run | 0.9 to 3.7 s | about 20% longer |
| Peak memory | 1,150 MB | 1,146 MB |

The model is too small to use 8 threads well: half the vCPUs cost about 20% more time. For work this size, 4 vCPUs is the better
buy, and two cells at 4 threads each would use an 8 vCPU sandbox better than one at 8.

**Determinism.** Fine-tuning and replay with the same seed gave identical accuracy matrices at both thread counts in 5 runs and
slightly different ones in 7. The summaries agree to 3 decimals. EWC's task-known lambda flipped (1000 at 8 threads, validation
0.9891 against 0.9889 for 10000; 10000 at 4 threads, where the two tied at 4 decimals), which moved its forgetting from 0.006 to
0.003. Every other choice matched.

## Muse Code from one paragraph (optional, Contributor only)

The prompt (`phase-muse.sh`) described a made-up method, "Running Importance Damping": after each task, a per-weight importance
from 256 examples, a running sum that halves each task, and each later gradient divided by `1 + 20 * O / max(O)`. It gave the
setup (the same MLP, Split MNIST with the task known, 1 epoch, seed 0), the data path and the venv, asked for `rid.py` (fine-tuning
and the method), `test_rid.py` (one unittest of the damping) and a fixed `RESULT` line, and forbade reading outside its folder.
Our `cl.py` was deleted from the sandbox first.

How it ran: `muse exec` 1.4.14, `--model muse-spark-1.3-contributor --reasoning-effort low --max-model-steps 40`, reminders and
telemetry off, `endpoint_transport` pinned to `auth: "bearer"` on the loopback proxy. The proxy forwarded only the catalog and
Contributor calls, under a $0.13 budget. Muse Code held a stand-in key; only the root proxy held the placeholder the firewall
swaps.

| | |
|---|---|
| Time | 42.5 s, exit 0 |
| Calls | 5 model calls, all `muse-spark-1.3-contributor` at low effort, plus 1 catalog read. None refused |
| Tokens | 141,980 in (85,715 cached), 3,175 out (1,244 reasoning) |
| Cost | $0.006433. The proxy's tally and Muse Code's `run.usage` agree to the cent |
| Tools | 3 shell commands (`ls` of its folder and the data, the test, the script) and 2 file writes. It read nothing outside its folder and the data |
| Files | `rid.py` (98 lines) and `test_rid.py` (20 lines), copied to `results/muse/code/` |
| Its result | fine-tuning 0.9526 average accuracy, 0.0506 forgetting; the method 0.9506 and 0.0537 |
| Our rerun | the test passed and `rid.py` printed the same `RESULT` line, in 6.3 s |

**What it got right:** IDX parsing with no torchvision, the masked loss, a fresh Adam per task, the running sum with the halving,
the damping by the global maximum (skipped while it is zero, on the first task), the metrics as defined, and the exact `RESULT`
line. The fine-tuning baseline (0.953 average accuracy, 0.051 forgetting, seed 0, all training rows) is in the range our own
fine-tuning gave (0.928 to 0.976 over 3 seeds on 90% of the rows).

**What it got wrong, silently:** the importance reading (above), and a test that never touches the shipped code. The method did not
reduce forgetting in its run (0.054 against 0.051). Since the method is made up, there is no claim to check that against, and
with its reading of the importance step, the result says nothing about the other reading.

Muse Code's stderr also notes that it found no usable bubblewrap. That is expected: builds run with `--yolo`, and the microVM and
its firewall are the boundary.

## Spend

| | Cost | How it was measured |
|---|---|---|
| Vercel Sandbox | about $0.11 | After stop: 1,045 s of active CPU at $0.128 an hour, 16 GB for 250 s at $0.0212 a GB-hour, 301 MB of transfer at $0.15 a GB (Pro rates as `run-spike.ts` lists them). Worst case, every vCPU busy throughout: $0.19 |
| Meta | $0.006433 | Meta's reported usage, priced as in `lib/meta/pricing.ts` |

`cost-ledger.jsonl` holds the run. The runner refuses to start when the ledger plus a run's worst case could pass $1.

## What it means for the design

- The CPU tier is real for small classic experiments: a full Split MNIST comparison with a lambda search and 3 seeds costs
  about $0.05 of sandbox time.
- The torch stack belongs in a research snapshot. Setup took 18 s, but it needs `download.pytorch.org` open, and the build
  firewall shouldn't open a package host for every replication.
- Datasets should come from the platform, pinned by sha256, not from the open internet: the hashes above are the registry entry.
- The plan should ask for more seeds where cells are cheap, or comparison claims stay "within noise".
- Record threads, versions and the validation table with every run.
- Component tests need a platform check that they import the code under test.
- The card needs an ambiguity list, and the code a `DECISIONS.md` that maps each choice to where it lives.

## Not measured

- A real 4 vCPU sandbox. The 4-thread run shared an 8 vCPU VM, pinned with `taskset`.
- The exact file paths `download.pytorch.org` serves the wheels from, and so whether a path rule on that host is enough.
- Muse Code on Muse Wonder, on a real paper, or on a task needing more than one round.
- The research snapshot itself: its size and its start time.
- The GPU tier. No GPU was used.

## Files

- `run.sh` gets a fresh OIDC token the way `docs/spikes/xr-2026-10-31/run.sh` does, into a mode 600 temp file in the session
  scratchpad, reads only that token and deletes the file. From the linked checkout's `.env.local` it reads two names only,
  `BUILDER_SNAPSHOT_ID` and, for the muse phase, `MODEL_API_KEY`, into a clean child environment. Nothing is printed.
- `run-spike.ts` makes the sandbox, sets each phase's firewall, uploads the scripts, copies `/tmp/out` back, stops the sandbox,
  checks it stopped, reads its usage and deletes it, then scans what came back for any credential. `list.ts` lists `spike-rep-*`
  sandboxes and, with `--stop`, stops any still running.
- `phase-setup.sh`, `phase-closed.sh`, `phase-run.sh`, `phase-muse.sh`; `cl.py` (the experiment); `mc-proxy.mjs` (the metering
  proxy).
- `results/`: each phase's output, `setup.json`, `pip-list.txt`, `mnist-sha256.txt`, `closed.txt`, `cl-8.json` and `cl-4.json`
  (every run), `proxy.jsonl`, `sandbox.json`, and `muse/` (the exec log, its code, our rerun). The credential scan was clean.

## Running it again

From the worktree root: `docs/spikes/replication-2026-10-31/run.sh docs/spikes/replication-2026-10-31/results-2 setup closed run`
(add `muse` for the Muse Code phase), then `docs/spikes/replication-2026-10-31/run.sh --list`. `REP_VCPUS` sets the size, at most 8.
