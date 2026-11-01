# Fleet training: fine-tuning on several Jetsons

Design, Oct 31, 2026. Branch `tg-fleet-train`. Nothing here is built. A CPU simulation backs it up, in
[spikes/fleet-train-2026-10-31/](spikes/fleet-train-2026-10-31/README.md). Nothing ran on a Jetson, and nothing will
until Hussam and the owner agree to it.

The owner's ask, Oct 31 at about 18:30: could Meta's paper "Applied Federated Learning: Architectural Design for Robust
and Efficient Learning in Privacy Aware Settings" (Stojkovic et al., arXiv 2206.00807) help with training across several
Jetsons? They want to run fine-tuning jobs on several Jetsons at once, and they want to be sure this uses Meta research.

Read with [TRAINING.md](TRAINING.md) (the Lambda lab), [HANDOFF_HUSSAM.md](HANDOFF_HUSSAM.md) (boards and his rules),
`muse-device/train.py` and `server.py` (one board's fine-tune), and on their branches `docs/OFFLINE.md` (tg-offline),
`docs/DECISION_MODELS.md` (tg-decide) and `docs/CAPABILITIES.md` sections 18 and 19 (tg-cap-contract).

Tags, as in VIBE_TUNING.md:

- **[V]** verified: in this repo's code, a measured run, or the spike.
- **[R]** reported by someone else (a paper, a model card, a forum post), not reproduced here.
- **[I]** inferred or estimated. Needs a test.

## In one minute

- **Does the paper help?** Partly. It is about millions of phones training small yes/no classifiers. We have a handful of
  8 GB boards and language models. Its architecture carries over as a set of design ideas. Its scale tricks and its
  privacy machinery mostly do not.
- **Two modes, kept apart:**
  - **A. Many jobs at once.** Each board runs its own fine-tune, from a fleet job queue. No federation. This is a fan-out
    of what `lib/device/train.ts` already does for one board, plus an orchestrator with eligibility checks borrowed from the
    paper.
  - **B. One job across several boards.** Federated fine-tuning of a LoRA adapter: the records stay on the boards, and
    only adapters travel to an aggregator.
- **Mode B is not a speed-up.** In the simulation, federated averaging needed 3 to 6 times the training examples that
  pooled training needed to get within 2 points of it [V]. Five boards in parallel finish in about 0.6 to 1.2 times the
  steps one board needs on all the data (our arithmetic from those step counts, before network time) [I]. Use it when
  records must stay where they are, which is offline mode's rule.
- **Meta research.** The design uses the paper's ideas, FedBuff and Papaya (Meta AI) and Opacus (Meta, Apache-2.0).
  Section 4 maps every piece to its source. The board trains Llama 3.2 1B since Nov 1 (Meta models only), not yet measured on a board.
  Llama 3.2 1B is the Meta model that fits an 8 GB board, and its license has duties (section 5).
- **Glimmer can't train on a board.** A 4-bit Glimmer is about 20 GB [R]. Boards train a small model on the same
  decision task format; Glimmer stays on Lambda.
- **Who:** General builds the platform side, the aggregator and the docs. Hussam owns everything that runs on a board.

## 1. The owner's question: where the paper helps and where it doesn't

The paper's setting and ours:

| | The paper (2206.00807) [R] | Our fleet [V unless marked] |
|---|---|---|
| Devices | Phones running Meta's apps, a very large population | 5 or 6 Jetson Orin Nano 8 GB (HANDOFF_HUSSAM lists 6; the roster enrolls 5) |
| Model | Small binary classifiers on dense features | LoRA adapters on 0.8B to 1B language models |
| Who takes part in a round | A sample of eligible phones, many dropping out | Every board we pick, by name |
| Aggregation | Synchronous secure aggregation in a TEE, weighted averaging | An ordinary process we trust, weighted averaging. No TEE |
| Privacy | DP noise on device or after aggregation | Optional per-example DP-SGD on each board (Opacus). Board-level DP doesn't work at 5 boards (below) |
| Statistics | A federated analytics server computes noisy feature and label statistics | Label counts per board, and feature statistics only for tasks that have dense features |
| Its own verdict | Iteration stays far slower than central training | The simulation agrees: slower than pooling, by 3 to 6 times in examples |

**Where it helps us:**

1. **The on-device Orchestrator.** Check eligibility before a board takes work, schedule it, submit results, log
   everything. That is Mode A's orchestrator, and Mode B reuses it every round.
2. **Federated analytics for normalization and label balance.** Boards send a few numbers each, not records. In the
   simulation, shared normalization statistics were the cheapest real win: +0.5 points and the target 8 to 11 rounds
   sooner than each board using its own; +8.6 points over raw features [V]. Label counts let the aggregator weight
   classes the way decision models already balance them centrally (at most 3 to 1).
3. **Metrics on held-out devices.** Score the shared model on boards or splits that never trained it.
4. **Funnel logging with short-lived ids.** Count where each board drops out of a round, without logging records.
5. **Shipping training logic without an app release.** Our version is simpler: the platform sends each round's settings,
   and Hussam ships code changes to `muse-device`.
6. **Weighted averaging by example count.** `training_status` already reports `examples`, the weight it needs [V].

**Where it doesn't:**

1. **Scale.** Papaya's 2 to 5 times speed-up came from 130 to 2,600 phones training at once [R]. FedBuff reports doing
   about as well as synchronous averaging with server momentum when few clients train at once [R]. With 5 boards, buffered async helps with a slow or
   dropped board and nothing more.
2. **Privacy by noise across devices.** Noise after aggregation over 5 boards gave epsilon 85 in the simulation, which is no
   guarantee [V]. Secure aggregation over 2 boards lets each recover the other's update from the sum [I].
3. **The TEE.** We have none. Jetson Linux ships OP-TEE, but nothing like Papaya's attested aggregation was found for it
   [R]. Our aggregator is trusted by assumption: the owner's house machine or the platform.
4. **The model type.** The paper's tricks are tuned for dense-feature classifiers. Ours are language models on text, where
   label counts carry over and feature normalization mostly doesn't.

## 2. Two modes

### Mode A: many jobs at once

Each board runs its own fine-tune. Typical uses: one person's model per board, several datasets at once, or the same
dataset at different settings to compare. No board waits for another, and nothing is averaged.

**The flow:**

```text
admin or Wonder asks -> fleet job (N tasks) -> orchestrator checks each board -> place tasks on eligible boards
  -> per task: save_dataset pages, then train_model (exists today) -> poll training_status
  -> results: status, loss, seconds, peak GiB; the adapter stays on the board as safetensors and GGUF
```

**Eligibility checks** (the paper's Orchestrator, done by the platform before each placement and again every poll):

| Check | Rule for v1 | Where the fact comes from | Today |
|---|---|---|---|
| Registered | A `devices` row, `kind = muse_device`, not revoked | the shared devices table (unit 13) | After unit 13 merges |
| Allowed to train | A per-board flag the owner sets. Never `jetson-05` (Hussam's rule) | new `train_allowed` on the row | New |
| Reachable | `describe_device` answers within 15 s | `muse-device` | Exists [V] |
| Idle | No active run, no `muse-device` model, no download | `train_model` already refuses otherwise | Exists [V] |
| Fleet model | Stopped on that board, or a measured run shows training fits beside it | the control plane's `get_node` and `list_models` (read only) | Read only, exists |
| Free memory | `MemAvailable` at least the base's weights plus 1.0 GiB | `train_model`'s own check (`TRAIN_OVERHEAD_GIB`) | Exists [V] |
| Disk | At least 0.5 GiB free after the dataset, and 1 GiB left by `save_dataset` | `train_model` and `save_dataset` | Exists [V] |
| Temperature | Start only under 70 C; stop the run at 85 C (our picks, under the fleet's 80 C warning and 90 C critical defaults) [I] | `describe_device` `max_temp_c` [V]; the control plane's alerts (`settings_store.py`) | Start check new; stop on heat is board side, new |
| Power mode | The mode the job's time estimate was measured at (the fleet's measurements used MAXN_SUPER) | `nvpmodel -q`, a new field from Hussam | New |
| Version | `muse-device` new enough for the tools the job needs | `serverInfo.version` (0.3.0 today) | Exists [V] |

A board that fails a check is skipped with its reason in the funnel log, not retried in a loop.

**Placement:** one run per board (the board enforces it [V]). Fill idle eligible boards in order of free memory. A task
that names a board waits for it; one that doesn't takes the next free board. Queued tasks start when a board frees up.

**Caps:**

- Boards per fleet job: 5 by default, at most the number of boards allowed to train.
- Steps: the board's own limits (1 to 5,000 steps, rank up to 64) [V]. Runs that Wonder starts keep its caps: 300 steps,
  rank 16, length 1,024 [V].
- A wall-clock limit per task (new, platform side): past it, the platform calls `stop_training` (SIGTERM, then SIGKILL
  after 30 s, as the board does today [V]).
- One fleet job per owner at a time in v1 [I].

**Cancel:** `DELETE /api/fleet/jobs/{id}` calls `stop_training` on every active task and marks queued ones stopped.

**Results back:**

- Each task's status JSON as today: state, step, loss, seconds, peak GiB, examples, skipped [V].
- The adapter stays on its board (`~/train/runs/<name>/adapter` and `~/models/<name>.gguf`) [V]. `start_model` and
  `ask_model` compare base and tuned on that board [V]. Drive export (unit 12) copies it to USB [V on its branch].
- Pulling an adapter's bytes to the platform needs the new `read_adapter` tool (Hussam), and only happens when the owner
  asks, since an adapter can carry traces of its records.

Later, not v1: averaging the adapters of several Mode A jobs into one, the Branch-Train-Merge idea. That paper found it
works with domain splits and poorly with random ones [R], so it needs a test first.

### Mode B: one job across several boards

One shared adapter, trained by several boards on records that never leave them.

**When to use it:** records must stay on the board that holds them. If records may move, pool them on one board (Mode A)
or send them to Lambda: that is faster and simpler.

**Why it is not faster** (our arithmetic on the spike's step counts, equal board speeds, no network or reload time) [I]:

| Task | One board, all the data | Five boards, federated, in parallel |
|---|---|---|
| Tabular | Target at round 7 to 9, 50 steps a round: 350 to 450 steps | Round 30 to 43, 10 steps a round: 300 to 430 steps |
| LoRA decision task | Round 6 to 7, 25 steps a round: 150 to 175 steps | Round 20 to 25, 5 steps a round: 100 to 125 steps |

So five boards take 0.6 to 1.2 times as long as one board on pooled data: about one board's speed, spread over five.

**One run, step by step:**

1. **Plan.** Pick K training boards (eligibility as above) and, optionally, one held-out board. Round 0's adapter is made
   once by one board with the job's seed and sent to the rest, so every board starts from the same A and B.
2. **Statistics, once, before round 1** (the paper's federated analytics). Each board reports counts per label of its own
   rows. The aggregator turns the totals into class weights, capped at 3 to 1 like decision models. Tasks with dense
   numeric features also send sums and sums of squares for normalization. Decision text tasks have none.
3. **Each round:**
   1. The aggregator sends the current adapter (`save_adapter`, in pages under the board's 1 MiB body limit, as
      `save_dataset` already pages).
   2. Each board trains E local steps from it (`train_model` with `init_adapter`, a per-round seed, and no GGUF).
   3. The aggregator reads each adapter back (`read_adapter`, paged, sha256 checked) with its example count.
   4. It averages A and B separately, weighted by example count (below).
   5. Each board scores the new adapter on its own held-out split and sends back counts only (correct, total, loss sum).
      The held-out board, if any, does the same on all its rows.
   6. It logs the round's funnel.
4. **Stop** when held-out loss has risen for 2 rounds in a row, or at the round cap. In the simulation, test loss bottomed
   near round 20 and then rose while accuracy held [V], so stopping on accuracy alone would overtrain.
5. **Finish.** The best round's adapter goes to the boards the owner picks and is converted to GGUF there. From then on
   it is an ordinary board adapter: `ask_model` and drive export work as today.

**The averaging rule:** average A and B separately, weighted by examples, and keep A trainable. In the simulation this
trained best (0.907 at round 40), even though it is not the exact average of the boards' models (a gap of 7% to 17% of
each round's change) [V]. The exact rules lost: SVD back to rank 8 reached 0.882, merge and restart 0.848, frozen A
0.565 at round 12 [V]. The gap should grow with more local steps per round, which was not measured.

**Synchronous first, buffered async later.** A sync round waits up to twice the slowest board's usual round time, then
carries on without the late board (the simulation's rule). FedBuff (K = 2) reached the target 2.3 to 2.7 times sooner
in simulated time with one 4 times slower board and one dropout, and ended no more accurate (0.837 for both) [V]. It
also tilted toward the fastest board, which sent 4 times as many updates (mean score down 0.0165) [V]. If we build it,
cap uploads per board per window.

**Local steps per round:** the simulation used 5 (LoRA) and 10 (tabular). On a board, each round restarts `train.py`,
loads the base and saves the adapter, which is unmeasured time. Start with E = 20 and measure [I]. If the reload
dominates, a resident round worker that keeps the base loaded is the fix (later).

**Privacy options:**

| Option | What it protects | Measured | Use |
|---|---|---|---|
| Records stay on boards | Raw rows never move | By design | Always in Mode B |
| Aggregator on the house machine | Adapters stay on the home network | By design | Default for private data |
| Per-example DP-SGD with Opacus on each board | Single records, from the aggregator and other boards | Tabular: epsilon 2.2 to 7.1 per board at noise 1.0 (delta 1e-5, 1,000 steps). Accuracy matched clipping alone, which cost 2.0 points [V]. Opacus's PEFT tutorial: BERT at epsilon 7.42 reached 0.740 against 0.749 without DP [R] | Option, when boards hold different people's data. Memory on a Jetson unmeasured |
| Noise after aggregation (board level) | A whole board's data | Epsilon 85 at 5 boards [V] | Not offered |
| Secure aggregation | Each board's update from the aggregator | Not built. With 2 boards, the sum reveals the other's [I] | Not offered |
| Encrypted local storage | Rows on a stolen board | Datasets are plain JSONL today [V] | Disk encryption is Hussam's call |

Adapters can leak traces of their records. Stock et al. (Meta AI, 2202.07623) bound how much DP protects against
reconstruction [R], which is the reason to keep private adapters on the home network.

**Funnel logging with short-lived ids:** each round gets a fresh random id, and each board's part in it a task id. The
stages are eligible, sent, training, uploaded, averaged, scored, or dropped with a reason (too hot, low memory, busy,
timeout, failed). Logs hold counts, losses and timings. Never example text, adapter bytes, board URLs or tokens.

**Mode B against one Lambda GPU:**

| Situation | Better | Why, with numbers |
|---|---|---|
| The model is Glimmer | Lambda | A 4-bit Glimmer is about 20 GB [R]; the board caps a model at 8 GiB [V]. A Glimmer LoRA step is about 5 s on an H100 SXM5 at $4.29 an hour (`runEstimate`, TRAINING.md) |
| The records may move | Lambda, or one board on pooled data | Federated needs 3 to 6 times the examples of pooled training to come within 2 points [V] |
| The records must stay on the boards | Federated boards | The only option that keeps them put. It came within 1.2 points of pooled on tabular (0.845 against 0.856), and LoRA reached 0.907 at round 40 against 0.917 pooled at 12 [V] |
| No internet (offline mode) | Boards | Lambda can't be reached |
| Fast iteration on a setting | Lambda | The paper's own conclusion [R]; per-round reloads on boards are unmeasured |
| No cloud spend | Boards | Owned hardware. Lambda's lab caps spend at $20 a day by default [V] |
| Speed on a 1B model | Unknown | No board step time is recorded in this repo [V]. A community post reports 22 minutes for 3,000 short samples (TinyLlama 1.1B, LoRA rank 4, length 64) on an Orin Nano 8 GB [R]. No 1B cloud step time is measured here either |

**Bytes a board moves:** a Llama 3.2 1B rank 8 adapter on all 7 projections is 5,636,096 parameters: 11.3 MB in bf16 per
upload and the same per download [V, computed]. At the simulation's 20 to 25 rounds that is 225 to 282 MB each way per
board [I]. Fine on a home network; untested through tunnels.

## 3. Mode A and Mode B side by side

| | Mode A: many jobs | Mode B: one federated job |
|---|---|---|
| Result | One adapter per task | One shared adapter |
| Board-to-board waiting | None | Every round |
| Records | Copied to the board that trains on them | Stay on the boards that already hold them |
| New board tools | None needed for v1 (optional `read_adapter`) | `save_adapter`, `read_adapter`, `eval_adapter`, `train_model` with `init_adapter` and `seed` |
| Speed | Each job as fast as one board | About one board's speed, spread over five [I] |
| Build cost | Small (section 8) | Larger (section 8) |

## 4. Meta sources, piece by piece

Muse Muse uses these papers and libraries. Meta has not reviewed or endorsed this design, and no Meta logo or Meta
branding goes on any page about it. All code is written fresh; papers are ideas, not code.

| Piece | Meta source | What we take | License |
|---|---|---|---|
| Orchestrator with eligibility checks | 2206.00807, Architecture (Meta) | Check before work, schedule, submit, log | Paper CC BY 4.0; ideas only |
| Federated statistics for normalization and label balance | 2206.00807, Application to Problems and Results; Cormode and Markov 2108.01521 (Facebook) | Boards send counts and sums, not rows. At 5 boards the aggregator can take exact sums or Laplace-noised ones; the bit-pushing estimator needs a large population [R] | Papers; ideas only |
| Metrics on held-out devices | 2206.00807, Results | Held-out splits per board, plus an optional held-out board | Paper; ideas only |
| Funnel logging with short-lived ids | 2206.00807, Architecture | Per-round ids, drop reasons, no records | Paper; ideas only |
| Weighted averaging; noise on device or after aggregation | 2206.00807, Model aggregation | Weight by example count. Board-level noise rejected at our size | Paper; ideas only |
| Buffered async aggregation | FedBuff, 2106.06639 (Meta AI, AISTATS 2022); Papaya, 2111.04877 (Meta AI) | Later option for slow boards, K = 2, capped uploads | Papers; ideas only |
| Per-example DP-SGD | Opacus (Meta, v1.6.0, May 2026) | Optional on each board, with its RDP accountant | Apache-2.0 |
| Choosing a privacy budget | Stock et al., 2202.07623 (Meta AI) | What epsilon protects against reconstruction | Paper; ideas only |
| Starting from a pretrained model | "Where to Begin?", 2206.15387 (Meta AI, ICLR 2023) | Federated LoRA on a pretrained base, not training from scratch | Paper; ideas only (affiliation marked likely by the research stage) |
| Keeping part of the model per board | Partial model personalization, 2204.03809 (ICML 2022) | Later option: some adapter layers stay local | Paper; ideas only (affiliation likely) |
| Many jobs, then merge | Branch-Train-Merge, 2208.03306 (UW, AI2 and Meta AI); Branch-Train-MiX, 2403.07816 (FAIR) | Later option for Mode A results | Papers; ideas only |
| One job with little communication | Stochastic Gradient Push, 1811.10792; SlowMo, 1910.00643 (FAIR) | Background only: both need boards to talk to each other, which the fleet has no path for | Papers |
| Training framework | PyTorch (created at Meta, now the PyTorch Foundation) | Already what `train.py` runs on | BSD-3-Clause |
| 4-bit base for a 3B model | torchao `NF4Tensor` (Meta) | Only if a 3B base is tried | BSD-3-Clause |
| The model | Llama 3.2 1B (Meta) | The Meta base that fits a board (section 5) | Llama 3.2 Community License |
| The simulation's model | RoBERTa-base (Facebook AI with UW) | Used in the spike only | MIT |

Looked at and left out:

- **FLSim** (Meta): archived Oct 2025, a single-process simulator, and its LICENSE (BSD-3) and README (Apache 2.0) disagree.
- **torchft** (Meta, BSD-3): LocalSGD and DiLoCo, marked experimental, x86_64 wheels only, so a Rust source build on the
  boards. It also needs boards to reach each other.
- **ExecuTorch training** (Meta, BSD): experimental, and its LoRA example is CPU and fp32 only.
- **torchtune** (Meta): no longer maintained.
- **PrE-Text** (CMU and Meta, 2406.02958) is a counterpoint worth knowing: small models trained on private synthetic text
  beat on-device training there [R].

Not Meta, so not counted as Meta research: DP-SGD itself (Abadi et al., Google), LoRA (Microsoft), DiLoCo (Google
DeepMind), the frozen-A idea (FFA-LoRA), and Hugging Face `transformers` and `peft` (Apache-2.0). The research stage found no Meta paper on federated LoRA for language models on edge devices.
That is a search result, not proof.

## 5. Which models

| Model | Size | LoRA on one 8 GB board | License | Role |
|---|---|---|---|---|
| **Llama 3.2 1B** | 1.24B | Likely, about 2.5 GB of bf16 weights; needs the fleet model stopped on that board, since about 2.9 GB is free beside Bolt [I] | Llama 3.2 Community License | **The Meta base for boards** |
| Llama 3.2 3B | 3.2B | Only at 4 bits (torchao NF4); bitsandbytes 4-bit failed on one Orin Nano report [R] [I] | Llama 3.2 Community License | Later, after a 1B measurement |
| MobileLLM-Pro, MobileLLM-R1 | 1.08B and smaller | Likely [I] | FAIR non-commercial | Only if the use is non-commercial |
| RoBERTa-base | 125M | Easily | MIT | Spike only: an encoder can't answer through llama-server |
| Muse Glimmer 30B | 29.6B | No | Apache-2.0 with its usage policy | Stays on Lambda |

**Llama 3.2's duties** [R]: ship the license, show "Built with Llama" on anything distributed, start the name of any
distributed model trained on it with "Llama", follow the Acceptable Use Policy; services over 700M monthly users need
Meta's permission. KNOWLEDGE_UPDATE.md left Llama 3.2 out of the student for license reasons. The owner chose Meta models only
on Nov 1, which settles decision 2.

**What Glimmer can't do here:** load on a board. Its smallest working file in the knowledge run was IQ2_XXS at 7.96 GB
[V there], against the board's 8 GiB model cap and the device rule's 70% of RAM. Splitting it over several 8 GB boards on
Ethernet is impractical [I]. What it can do: train decision models on Lambda (tg-decide), and stay the big model those
board models are compared with.

**The tie to decision models:** use the same task format. A decision task is `{state, question, options}` with a
one-letter answer, rendered as the same messages JSONL `train.py` reads [V on tg-decide]. The spike's LoRA task used that
format on Banking77 [V]. So a decision dataset can train Glimmer on Lambda and a Llama 3.2 1B on boards, and both are
scored on the same held-out rows. The board scores letters from the model's own logits in PyTorch during rounds, and
through llama-server's `n_probs` once converted, as DECISION_MODELS.md describes for GGUF files.

## 6. How it plugs into what exists

**`muse-device` (Hussam's).** What exists covers Mode A for one board. Needed changes, all his:

- `train.py` seeds 3407 on every run [V]. Run per round, every round would see the same first examples in the same order,
  so it needs a `--seed` (the coordinator sends job seed plus round).
- `--init-adapter DIR`: start from a given adapter (the knowledge run's `KNOWLEDGE_INIT_ADAPTER` is the precedent).
- `--no-gguf`: skip the GGUF conversion until the last round.
- New tools: `save_adapter` and `read_adapter` (paged, sha256 checked), `eval_adapter` (held-out counts only), and power
  mode in `describe_device` or a `train_eligibility` tool.
- Optional: `--dp-noise` and `--dp-clip` through Opacus, with epsilon in the status.
- `setup-train.sh`: a Llama 3.2 1B base option, its GGUF in `~/models` (the server requires `<base>-<quant>.gguf` [V]),
  its license file, and Opacus in the lock if DP ships.

**`lib/device/train.ts` (platform).** `startDeviceTraining`, `deviceTrainingStatus` and `stopDeviceTraining` already take
a `DeviceConfig` per call [V]. Mode A calls them once per board. Mode B adds `sendAdapter`, `readAdapter` and
`scoreAdapter` beside them.

**The devices registry (wave 3 unit 13, shared with offline mode).** One `devices` table, `kind = muse_device` rows, with
encrypted URL and token [V on tg-cap-contract]. Fleet training reads its boards there instead of the single
`DEVICE_MCP_URL`. It needs one more column, `train_allowed`. Until unit 13 merges, the env board is the only board.

**`lib/train` job records.** New tables, not `training_jobs`: those rows carry Lambda instance, token and cost fields, and
the 5-minute sweep terminates instances by them [V]. Proposed migration 0028, or the next free number at merge time (0016
to 0027 are reserved):

- `fleet_jobs`: id, owner, mode (`many` or `federated`), dataset ids, base, params, limits, status (the `TrainStatus` names
  where they fit), summary.
- `fleet_tasks`: id, job, device, round, state, step, loss, examples, skipped, seconds, peak GiB, error.
- `fleet_events`: the funnel, with round ids.
- Data comes from `training_datasets` through the same `readPage` that `startDeviceTraining` uses [V].
- Adapters in flight go in a private store and are deleted after each round, keeping only the current shared adapter.
  Never a public Blob URL, and never a workflow step's argument or result, since step data is persisted (TRAINING.md keeps
  the HF token out of steps for the same reason) [V].

**The coordinator.** Written as a plain state machine (`lib/fleet/rounds.ts`), so two drivers can run it: a Workflow DevKit
workflow online, and a local loop on the house machine offline (offline mode doesn't use Workflow DevKit [V on
tg-offline]).

**The jetson-infra control plane (Hussam's).** Read-only facts for eligibility: online state, loaded models, temperature,
power mode, maintenance flag. Optionally a fleet Job (exec plus `systemd-run`, the fleet's pattern for long work [V]) to
install `muse-device` training on a pool of boards at once, with the owner's OK. It can't carry training itself: no file
transfer, a 600 s exec limit through MCP, and boards only dial out, so they can't reach each other [V]. A training board
can also be put in `maintenance`, so the router stops sending it chats (Hussam's call).

**Offline mode (tg-offline).** "Records stay on the device that holds them" is exactly Mode B's reason. Its table returns
503 for fine-tuning offline [V], so fleet training over LAN boards would be the one training path offline allows. That is a
change to OFFLINE.md (decision 4).

**Drive export (wave 3 unit 12).** A finished adapter, from either mode, ends as `~/models/<name>.gguf` on a board, which
is the source drive export already copies [V on tg-cap-drive]. A Llama-based export needs the Llama license file and
"Built with Llama". Both landed on Nov 1 (docs/DRIVE_EXPORT.md).

**The build log.** Every fleet run, real or simulated, every board measurement and every owner decision gets an entry in
`docs/BUILD_LOG.md`, as its header asks. Board runs record board, base, steps, seconds and peak GiB.

## 7. Who does what

| | General (this session's side) | Hussam |
|---|---|---|
| Owns | Platform code (`lib/fleet`, routes, pages, migration), the aggregator, the simulated board, the spike, this doc and the log | Everything that runs on a board: `muse-device`, setup, installs, real runs, thermals, the control plane |
| Never | SSH to a board, call a fleet tool that changes anything, run Glimmer on the laptop, train on the laptop | Start on `jetson-05` |
| Needs the other for | Board tool shapes, real step times and memory | The coordinator to drive rounds, the registry |

Nothing runs on a real board without Hussam and the owner. On Oct 31 the owner said no Jetson test or training for now,
and that the Nov 4 demo has no Jetson endpoint (BUILD_LOG, KNOWLEDGE_RUN_LOG).

## 8. Build units

Hours are estimates [I].

| # | Unit | Owner | Hours | Files |
|---|---|---|---|---|
| G1 | Fleet job records: migration, schema, types | General | 3 | `drizzle/0028_fleet_train.sql`, `lib/db/schema.ts`, `lib/fleet/types.ts` |
| G2 | Board list from `devices` (env board until unit 13) | General | 2 | `lib/fleet/boards.ts` |
| G3 | Orchestrator: eligibility, placement, caps | General | 4 | `lib/fleet/eligibility.ts`, `lib/fleet/place.ts` |
| G4 | Mode A queue: start, poll, cancel, results | General | 4 | `lib/fleet/queue.ts`, `lib/fleet/workflow.ts`, `app/api/fleet/jobs/route.ts`, `app/api/fleet/jobs/[id]/route.ts` |
| G5 | Fleet page: boards, jobs, funnel counts | General | 4 | `app/device/fleet/page.tsx`, `components/fleet/*` |
| G6 | Adapter averaging: safetensors in and out, bf16 and fp32, weighted factor averaging, checks on keys, shapes, base and rank | General | 3 | `lib/fleet/safetensors.ts`, `lib/fleet/average.ts` |
| G7 | Mode B rounds: state machine, workflow driver, house-machine driver, sync timeout, early stop | General | 6 | `lib/fleet/rounds.ts`, `lib/fleet/round-workflow.ts`, `scripts/fleet/coordinate.ts` |
| G8 | Federated label counts and class weights (optional Laplace noise) | General | 2 | `lib/fleet/analytics.ts` |
| G9 | Funnel log with round ids | General | 1.5 | `lib/fleet/funnel.ts` |
| G10 | Simulated board: the new tools on a tiny model, for tests and the demo | General | 3 | `lib/fleet/sim-board.ts`, `lib/fleet/__tests__/*` |
| G11 | Docs and build log | General | 1 | `docs/FLEET_TRAINING.md`, `docs/TRAINING.md`, `docs/BUILD_LOG.md` |
| H1 | Llama 3.2 1B base: end token from the tokenizer, setup, license file, one measured run with the fleet model stopped | Hussam | 3, plus board time | `muse-device/train.py`, `setup-train.sh`, `requirements-train.lock` |
| H2 | Round mode: `init_adapter`, `seed`, no GGUF; `save_adapter`, `read_adapter` | Hussam | 4 | `muse-device/train.py`, `server.py`, `test_server.py` |
| H3 | Eligibility facts: power mode, fleet model loaded, stop on heat | Hussam | 1.5 | `muse-device/server.py`, `train.py` |
| H4 | `eval_adapter`: held-out counts only | Hussam | 2 | `muse-device/train.py`, `server.py` |
| H5 | Two-board federated run on real boards (not `jetson-05`), with thermals logged, after the owner's OK | Hussam | 4, plus board time | none new |
| H6 | Opacus DP-SGD option, memory measured on a board | Hussam | 4 | `muse-device/train.py`, `requirements-train.lock` |

Totals: General 33.5 hours, Hussam 18.5 hours plus board time [I]. Mode A alone is G1 to G5 plus H3: about 18.5 hours.

**A demo slice before Nov 4, if the owner wants one** (about 11 hours, General only, no real board): G6, the G7 state
machine with the workflow driver, G10, and a small page that runs a federated job over 5 simulated boards and shows
rounds, the funnel and held-out accuracy. Every screen says "Simulated boards". A cheaper option (about 2 hours) is a
static card on `/device` with the spike's measured curves. Either queues after decision models D3 to D9.

**Cut order** (cut first at the top):

1. H6, DP-SGD.
2. Buffered async (keep sync rounds with a timeout).
3. Noise on federated statistics (exact counts from a trusted aggregator).
4. The held-out board (keep held-out splits per board).
5. Fleet page polish (keep a plain table).
6. Mode B entirely (G6 to G8, H2, H4, H5).
7. Kept to the end: Mode A's queue, the orchestrator's checks and the devices registry.

## 9. Owner decisions

1. **When to build.** Recommendation: commit this design and the spike now; build after decision models, and no real board
   work before Nov 4, as the owner said today.
2. **The board's base model.** Settled Nov 1: Llama 3.2 1B, Meta models only. Any shared derivative is named "Llama-..." with
   "Built with Llama" shown.
3. **May records move between boards?** Recommendation: yes for the owner's own shared rows (pool them, Mode A); no for
   anything offline mode keeps on its device (Mode B).
4. **Where the aggregator runs.** Recommendation: the house machine for private data, so adapters stay on the home
   network; the platform for the owner's shared data. That also means letting offline mode run fleet training on LAN
   boards (a change to OFFLINE.md).
5. **Differential privacy.** Recommendation: off by default for one household's own boards; Opacus per-example DP-SGD as an
   option when boards hold different people's data; never claim board-level privacy at this fleet size.
6. **Which boards may train, beside what.** Recommendation: Hussam picks; never `jetson-05`; stop the fleet model and set
   `maintenance` during a run until a measured run shows training fits beside Bolt.
7. **Sync or async rounds.** Recommendation: sync with a timeout; FedBuff only if real boards differ a lot in speed, with
   per-board upload caps.
8. **A Nov 4 demo slice.** Recommendation: no live fleet training in the Nov 4 demo. If there is time after decision
   models, the 2-hour results card; the 11-hour simulated slice only if the owner wants to show the flow.

## 10. Risks and limits

- **Nothing measured on a Jetson.** No board step time is recorded anywhere in the repo [V]. Board memory for Llama 3.2
  1B, Opacus on a board, per-round reload time and real transfer times are all unmeasured.
- **The live fleet wasn't read.** At 18:37 EDT the control plane's tunnel was offline (ERR_NGROK_3200) and
  `jetson-05.local:8080` didn't answer [V]. The last snapshot (16:05 Oct 31): 8 machines enrolled, 3 online, none
  running a Meta model [V on tg-offline].
- **Thermals.** Training is sustained GPU load, unlike chat. The fleet alerts at 80 C and 90 C by default [V], and no
  long training soak has been measured. H5 logs temperatures for that reason.
- **Power.** Speed depends on the power mode, and a run measured at one mode is not an estimate for another. The house's
  power supplies and outlets under several boards at full load are untested.
- **Memory.** These boards have frozen and rebooted on failed GPU allocations, which is why `train.py` caps itself [V].
  Bolt with its drafter froze a board at about 650 MB free [V in fleet.md]. Training beside Bolt is untested.
- **Network.** Boards are reached through tunnels today. Whether they can be reached by LAN address, not only through the
  tunnel, is marked unknown in OFFLINE.md [V on tg-offline]. About 11 MB per board each way per round for a 1B adapter [V, computed].
- **Weak DP with few boards.** Board-level epsilon 85 at 5 boards [V]. Per-example DP holds per board but costs
  accuracy through clipping (2 points on the tabular task) [V].
- **Stragglers and bias.** Async rounds tilt toward fast boards [V]. Sync rounds lose a late board's data for that round
  [V].
- **Overfitting.** Small boards see their rows many times; the simulation's test loss rose after round 20 [V].
- **The averaging gap** grows with more local steps per round, which wasn't measured.
- **Only 3 seeds** in the spike, and several LoRA comparisons are within noise [V].
- **Simulation, not boards.** The spike's board speeds, dropout and data skew are made up, and its LoRA covered the top 2
  layers of an encoder, not a decoder [V].
- **Licenses.** Llama's naming and attribution duties; MobileLLM is non-commercial; Glimmer's usage policy passes down.
- **Hardware count.** HANDOFF_HUSSAM says 6 Orin Nanos, the roster enrolls 5 [V].
- **The paper's own warning:** iteration is far slower than central training. Mode B is for when the data can't move, not
  for speed.

## Sources

- The spike: [spikes/fleet-train-2026-10-31/README.md](spikes/fleet-train-2026-10-31/README.md), with every table, the
  cost ledger (about $0.43, cap $1) and the code.
- Papers: arXiv 2206.00807, 2111.04877, 2106.06639, 2108.01521, 2202.07623, 2206.15387, 2204.03809, 2208.03306, 2403.07816,
  1811.10792, 1910.00643, 2406.02958; not Meta: 1607.00133 (DP-SGD), 2311.08105 (DiLoCo).
- Libraries: github.com/meta-pytorch/opacus (Apache-2.0), github.com/pytorch/ao (BSD-3), github.com/meta-pytorch/torchft
  (BSD-3), github.com/facebookresearch/FLSim (archived).
- Models: huggingface.co/meta-llama/Llama-3.2-1B (license), huggingface.co/FacebookAI/roberta-base (MIT),
  huggingface.co/facebook/MobileLLM-Pro (FAIR non-commercial).
- Board numbers: NVIDIA developer forum, "Production-ready guide: TinyLlama fine-tuning on Jetson Orin Nano 8GB" (March
  2026, community); jetson-ai-lab.com tutorials (no Orin Nano training times).
- Our code: `muse-device/train.py`, `muse-device/server.py`, `lib/device/train.ts`, `lib/device/client.ts`,
  `lib/train/types.ts`; `~/jetson-infra` docs `architecture.md`, `protocol.md`, `fleet.md` and
  `control-plane/jetson_cp/settings_store.py` (read only).
