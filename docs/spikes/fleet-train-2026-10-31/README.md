# Fleet-train spike, Oct 31, 2026

## The answer

**Yes, federated training across several boards works in simulation, but it is slower than pooling the data, not faster.** Five
simulated boards each held a label-skewed shard. On both tasks, federated averaging got within 2 points of pooled training only
after 3 to 6 times as many example gradients as pooled training needed. Run more than one board on one job when records must
stay where they are (offline mode's rule). Do not do it for speed.

What we measured, on CPU in one Vercel Sandbox (nothing ran on a Jetson):

1. **Tabular (the paper's setting: a small binary classifier on dense features).**
   - FedAvg reached 0.845 accuracy against 0.856 for pooled training and 0.803 for a board alone.
   - Normalization from federated statistics was the cheapest real win: +0.5 points, with the target reached in 30 to 34 rounds
     instead of 41 to 43.
   - Against raw features, which collapsed to always predicting the majority class, normalization gave 48% to 51% lower
     training loss and +8.6 points.
2. **LoRA on Meta's RoBERTa-base for a four-option decision task.**
   - FedAvg reached 0.907 after 40 rounds and crossed pooled minus 2 points in 20 to 25 rounds. Pooled training reached the
     same accuracy in about 6 to 7 rounds' worth of steps.
   - **Averaging A and B separately is not the exact average of the models, yet it trained best.** We measured its gap at
     7% to 17% of each round's change (about 10% in most rounds). The two exact variants were slower: SVD back to rank 8 (36 to 39 rounds) and
     merge-and-restart (never reached the target in 40 rounds).
3. **Asynchronous buffered aggregation (FedBuff, Meta research).**
   - With boards 1x to 4x slower and one board dropping out, it reached the target 2.3 to 2.7 times sooner in simulated time.
   - It made 174 to 196 uploads, against 205 to 215 for synchronous rounds.
   - It ended no more accurate (0.837 for both).
   - The fastest board sent 4 times as many updates as the slowest, and its data is 5% positive. The final mean score was
     0.165, against 0.181 for sync and a true positive rate of 0.236. That is consistent with a tilt toward the fast board.
4. **Privacy.**
   - Per-example DP-SGD with Opacus at noise 1.0 gave epsilon 2.2 to 7.1 per board (delta 1e-5). Its accuracy matched clipping
     alone, so the 2-point cost came from clipping, not noise.
   - Board-level privacy with 5 boards is not meaningful. Noise after aggregation at z = 1 gave epsilon 85, and accuracy
     varied 2.6 points across seeds.

Spend: **Vercel Sandbox about $0.43** (worst case $0.52, cap $1). **Meta $0**: no model calls were made. One sandbox,
`spike-fl-mvx0ilks1cc3`, ran 1,101 s from create to stop. It was stopped, checked stopped, then deleted, and the listing shows no
`spike-fl-*` sandbox left.

## What ran

One sandbox from `BUILDER_SNAPSHOT_ID`: non-persistent, 8 vCPUs (4 cores with 2 threads each), 16 GB, a 30-minute timeout. The
machine was Ubuntu 26.04.1 on an `Intel(R) Xeon(R) Processor @ 2.90GHz`. The runner kept the sandbox across calls, so a bug found
by the smoke pass could be fixed in place. None was needed.

| Phase | Firewall | Exit | Time |
|---|---|---|---|
| setup (`phase-setup.sh`) | `allow-all` | 0 | 26 s |
| closed (`phase-closed.sh`) | `deny-all` | 0 | 0.2 s |
| smoke (`phase-smoke.sh`): every code path, tiny sizes | `deny-all` | 0 | 24 s |
| run (`phase-run.sh`): tabular, LoRA prep, 3 LoRA seeds at once | `deny-all` | 0 | 368 s of work (383 s with the runner) |
| extend (`phase-extend.sh`): LoRA for 40 rounds, three averaging rules | `deny-all` | 0 | 496 s of work |
| peek (`phase-peek.sh`), twice: read-only look at outputs | `deny-all` | 0 | 0.1 s |

After egress closed, curl to pypi.org, download.pytorch.org, archive.ics.uci.edu, raw.githubusercontent.com, github.com,
huggingface.co, registry.npmjs.org and api.meta.ai all failed (exit 6). Python's `urllib` got `URLError` (`closed.txt`).

### Setup and sources

- **Software** (`pip-list.txt`):
  - uv 0.13.1, sha256 checked; Python 3.12.15, uv-managed.
  - `torch==2.11.0+cpu` from PyTorch's CPU index only (BSD-style license).
  - From PyPI: `opacus==1.6.0` (Apache-2.0); `transformers==5.15.0` (Apache-2.0), plus `tokenizers==0.22.2`, `safetensors==0.8.0`
    and `huggingface-hub==1.33.0`, the pins muse-device's lock uses.
  - Pulled in by those: scipy 1.18.1 and numpy 2.5.4.
- **UCI Adult** (CC BY 4.0, per its UCI page): `adult.zip` sha256 `7537312d...`. 32,561 training rows and 16,281 test rows. 23.6%
  of test rows are above 50K.
- **Banking77** (PolyAI, CC BY 4.0 per its GitHub repo license), pinned at commit `57ec275d`:
  - `train.csv` sha256 `b06e26ac...`, `test.csv` `d12d6e3b...`.
  - `results/decision-examples.jsonl` holds the 1,200 messages we used. Their whitespace is normalized, and each is grouped into
    one of four teams. Attribution: PolyAI, "Efficient Intent Detection with Dual Sentence Encoders", CC BY 4.0.
- **RoBERTa-base** (`FacebookAI/roberta-base`, revision `e2da8e2f`; Facebook AI with the University of Washington, 2019; MIT
  license on its model card): 124,697,433 parameters. `model.safetensors` sha256 `5bde1d28...`, checked against the hash Hugging
  Face publishes.
- **Every sha256** is in `data-sha256.txt`. Setup took 26 s in all. The sandbox took in 845 MB over the whole run, about
  500 MB of it the model.

## Task (a): a binary classifier on dense features (`fl_tab.py`)

**Data split**
- Five boards with label-skewed and size-skewed shards of the training file:
  - rows per board: 6,000, 5,000, 4,000, 3,000 and 2,000;
  - share above 50K: 5%, 12%, 24%, 45% and 70%.
- The split is drawn again for each seed. The test set is the whole test file, with its natural mix.

**Model and training**
- An MLP, 108 inputs (6 numeric, 102 one-hot), then 32 hidden units, then 1: 3,521 weights, so 14,084 bytes per upload in fp32.
- Plain SGD at lr 0.05, batch 64, E = 10 local steps per round, 100 rounds, 3 seeds.
- One "round" of pooled training does the same number of example gradients as one FedAvg round over all five boards (50 steps).

**Normalization modes (numeric columns only)**
- raw;
- local, each board's own statistics. The model is then scored the way each board would use it, on test rows normalized with
  that board's statistics, averaged over boards;
- fed, from federated statistics;
- central, exact pooled statistics.

**Federated analytics**
- Each board sends Laplace-noised label counts, plus sums and sums of squares of its clipped numeric values, at epsilon 1 per
  statistic.
- Under basic composition that is epsilon 13 per board for the whole release.
- With thousands of rows per board, the noise hardly mattered. Over the 3 seeds:
  - feature means within 1.2% and standard deviations within 1.8% of the exact pooled values;
  - noisy label counts within 10 of the exact 15,390 and 4,610.
- So fed normalization equals central (paired difference 0.0000).
- Label balancing weights the loss by global class frequencies, from the noisy counts ("fed") or from each board's own counts
  ("local"). This is our rule; the paper does not spell out its own.

### Results, 3 seeds

Final values after 100 rounds, mean, with the spread over seeds. "Target" is pooled accuracy minus 2 points, 0.836.

| Method | Accuracy | Balanced acc. | AUC | Train loss | First at target |
|---|---|---|---|---|---|
| 1. Pooled (central) | 0.856 [0.855, 0.858] | 0.780 | 0.910 | 0.299 | round 7 to 9 |
| 2. Each board alone (mean of 5) | 0.803 [0.799, 0.809] | 0.721 | 0.900 | 0.272 | never |
| 3. FedAvg, local normalization | 0.845 [0.843, 0.846] | 0.718 | 0.903 | 0.279 | round 41 to 43 |
| 3. FedAvg, raw features | 0.764 (always the majority class) | 0.501 | 0.501 | 0.523 | never |
| 4. Sync FedAvg, slow boards and a dropout | 0.837 [0.837, 0.838] | 0.689 | 0.902 | | round 41 to 43, time 164 to 172 |
| 4. FedBuff, K = 2, same boards | 0.837 [0.836, 0.840] | 0.683 | 0.904 | | time 64 to 72, 87 to 98 server steps, 174 to 196 uploads |
| 5. FedAvg, fed normalization | 0.850 [0.849, 0.851] | 0.736 | 0.906 | 0.264 | round 30 to 34 |
| 5. FedAvg, fed normalization and fed balancing | 0.827 [0.823, 0.830] | 0.814 | 0.906 | 0.315 | never (balancing trades accuracy) |
| 5. FedAvg, local normalization, fed balancing | 0.829 | 0.804 | 0.904 | 0.330 | never |
| 5. FedAvg, local normalization, local balancing | 0.817 | 0.810 | 0.904 | 0.366 | never |
| FedAvg, exact pooled normalization (reference) | 0.850 | 0.736 | 0.906 | 0.264 | round 30 to 35 |
| 6. DP-SGD, clipping only (noise 0) | 0.824 | 0.661 | 0.887 | 0.405 | never |
| 6. DP-SGD, noise 0.5 | 0.824 | 0.660 | 0.887 | 0.418 | never |
| 6. DP-SGD, noise 1.0 | 0.824 | 0.660 | 0.887 | 0.418 | never |
| Board-level DP, z = 1 (noise after aggregation) | 0.825 [0.811, 0.837] | 0.739 | 0.878 | | 2 of 3 seeds, at rounds 95 and 100 |

**Paired differences per seed, with 95% t-intervals over 3 seeds**
- **Normalization:**
  - fed minus local: +0.0054 [+0.0042, +0.0066];
  - fed minus raw: +0.0856 [+0.0837, +0.0874];
  - training loss with fed normalization is 48% to 51% lower than raw, and 5% to 6% lower than local.
  - The paper reports about 75% lower training loss and about 6% higher accuracy on its own task. Ours is a different task, so
    only the direction is comparable.
- **Federation:**
  - pooled minus FedAvg (local): +0.0118 [+0.0064, +0.0172];
  - FedAvg (local) minus alone: +0.0416 [+0.0257, +0.0574];
  - alone, the 70%-positive board does worst (0.72 to 0.73), and the 24% board does best (0.85).
- **Label balancing:**
  - accuracy -0.0229 [-0.0346, -0.0113], balanced accuracy +0.0773 [+0.0712, +0.0834], AUC unchanged.
  - It moves the scores, not the ranking. The mean score goes from 0.21 to 0.33, and the share of scores below 0.05 or above 0.95
    from 0.43 to 0.31.
  - Fed counts against local counts, both on local normalization: accuracy +0.0119 [+0.0048, +0.0190], balanced accuracy
    -0.0057 [-0.0072, -0.0042].
- **Slow boards and the dropout:**
  - Board 3 is 3x slower and has 45% positives. It stops answering halfway through. The sync server waits 2x the slowest job, then
    carries on without it.
  - That costs sync FedAvg 0.0074 [+0.0045, +0.0103] accuracy and 0.0296 [+0.0206, +0.0385] balanced accuracy, against all
    boards answering.
  - FedBuff minus sync at the same simulated time:
    - at t = 40: +0.060 [+0.054, +0.065];
    - at t = 64: +0.044 [+0.029, +0.060];
    - at t = 168: +0.010 [+0.005, +0.015];
    - at the end (t = 404): +0.0001 [-0.0043, +0.0044], within noise.
  - FedBuff's uploads per board: 404, 269, 202, 66 and 101, against 100, 100, 100, 50 and 100 for sync.
  - FedBuff minus sync, mean score at the end: -0.0165 [-0.0237, -0.0093]. Averaged over the second half of the run, the mean
    score is 0.147 against 0.184.
- **DP:**
  - FedAvg minus clipping alone: +0.0202 [+0.0122, +0.0283];
  - clipping alone minus noise 1.0: +0.0003 [-0.0044, +0.0050], within noise.
  - The learning rate was not retuned for clipping.

**What the privacy numbers mean**
- **Example-level DP-SGD** comes from Opacus's RDP accountant: 1,000 steps per board, Poisson sampling at 1.1% to 3.2% (64 over
  board size), clipping norm 1, delta 1e-5.
  - Epsilon per board, from the largest board to the smallest: 2.2, 2.7, 3.4, 4.6 and 7.1 at noise 1.0, and 16, 19, 22, 29 and
    41 at noise 0.5.
  - It protects single records on a board from the server and the other boards. It needs no other participants, so it does not
    get weaker with few boards.
- **Board-level DP**, the paper's "noise after aggregation" option, but with no TEE: our server is trusted by assumption.
  - The setup: each board's update is clipped to 0.186 (the median update norm of a non-private run, which uses the data, so it
    is optimistic), then Gaussian noise at z = 1 is added to the sum of all 5 each round, for 100 rounds.
  - That gives epsilon 85 at delta 1e-3. That is no meaningful guarantee for hiding a whole board.
  - With 5 participants, the noise needed for a real guarantee would swamp the updates. That is our reading of these numbers,
    not a separate measurement.

**Curves** (mean of 3 seeds; the JSON has every round of every run):

| Round | 1 | 5 | 10 | 25 | 50 | 100 |
|---|---|---|---|---|---|---|
| Pooled, accuracy | 0.764 | 0.832 | 0.840 | 0.854 | 0.857 | 0.856 |
| FedAvg local, accuracy | 0.761 | 0.764 | 0.767 | 0.828 | 0.838 | 0.845 |
| FedAvg fed normalization, accuracy | 0.761 | 0.764 | 0.769 | 0.832 | 0.842 | 0.850 |
| FedAvg raw, training loss | 1.5e9 | 0.582 | 0.546 | 0.530 | 0.523 | 0.523 |
| FedAvg local, training loss | 0.649 | 0.511 | 0.436 | 0.337 | 0.309 | 0.279 |
| FedAvg fed normalization, training loss | 0.649 | 0.505 | 0.420 | 0.315 | 0.292 | 0.264 |

## Task (b): LoRA on a small Meta model, decision format (`fl_lora.py`)

**Model choice**
- RoBERTa-base (125M parameters; Facebook AI; MIT) is a small Meta model with a permissive license. MobileLLM is
  non-commercial, and Llama 3.2 1B is 1.24B parameters, too large for a CPU sandbox in minutes.
- It is an encoder, so it answers by filling `Answer: <mask>`. Only the logits of the four letter tokens ` A` to ` D` are scored.

**Task**
- Banking77 messages from 48 intents, grouped into four teams: A) Cards, B) Transfers, C) Top-ups, D) Cash and ATMs. Each is
  written as `{state, question: "Which team should handle this message?", options}` with a one-letter answer.
- The other 29 intents, including ambiguous ones such as `card_swallowed`, were left out. `lora-prep.json` lists the mapping.
- The pool is 1,000 messages (250 per team), and the test set is 200 (50 per team).
- Five boards of 128 examples each. 60% of each board's examples come from its main team (teams A, B, C, D, A); the rest are
  split evenly.
- Prompts average 51.6 tokens (98 at most).

**LoRA and training**
- LoRA rank 8, alpha 16, on all six linear layers (q, k, v, o, MLP up and down) of the top 2 of 12 layers: 221,184 parameters.
- The bottom 10 layers are frozen with no dropout, so their outputs are computed once and cached. That is exact: transformers'
  own layer-10 output matched the cache to 0.0.
- The top 2 layers and the head are rewritten in the script, and matched transformers' letter logits to 8.1e-6.
- Adam at lr 1e-3, batch 8, E = 5 local steps per round, a fresh optimizer each round.
- Main run: 12 rounds, 3 seeds. Follow-up: 40 rounds, 3 seeds, for the three rules that keep A trainable. One pooled
  "round" = 25 steps.
- Before training, the model scores 0.265 (it nearly always picks A).

**Averaging rules**
- **factor:** average A and B separately; boards continue from the averages.
- **product:** average the products B A exactly, merge the average into the frozen weights, and restart LoRA (fresh A, B = 0)
  each round.
- **svd:** average B A exactly, then cut it back to rank 8 by SVD; boards continue from that.
- **ffa:** A frozen and shared, only B trained, which makes the average exact.

### Results

Target = pooled accuracy minus 2 points = 0.897.

| Method | Accuracy at round 12 | At round 40 | First at target |
|---|---|---|---|
| 1. Pooled | 0.917 [0.895, 0.935] | | round 6, 7 and not within 12 (0.895) |
| 2. Each board alone (mean of 5) | 0.650 [0.612, 0.700] | | never |
| 3. FedAvg, factor | 0.767 [0.735, 0.795] | 0.907 [0.890, 0.915] | round 20, 20, 25 |
| 3. FedAvg, svd | 0.738 [0.675, 0.770] | 0.882 [0.860, 0.910] | round 36, 38, 39 |
| 3. FedAvg, product (merge and restart) | 0.592 [0.550, 0.650] | 0.848 [0.825, 0.860] | not within 40 |
| 3. FFA (A frozen) | 0.565 [0.550, 0.595] | not run | not within 12 |
| 5. FedAvg, factor, label balancing from noisy counts | 0.795 [0.780, 0.825] | not run | not within 12 |

**Paired differences, 95% t-intervals over 3 seeds, at round 12**
- **The gap to pooled:** pooled minus factor +0.150 [+0.072, +0.228].
- **Factor against the other rules:**
  - minus alone: +0.117 [+0.029, +0.205];
  - minus product: +0.175 [+0.049, +0.301];
  - minus FFA: +0.202 [+0.065, +0.338];
  - minus svd: +0.028 [-0.133, +0.190], within noise.
- **Label balancing:**
  - minus factor: +0.028 [-0.015, +0.072], within noise, though every seed is higher.
  - Its per-team accuracy is more even: 0.77, 0.81, 0.76 and 0.84, against 0.86, 0.85, 0.57 and 0.79.
- **At round 40:**
  - factor minus svd: +0.025 [-0.020, +0.070];
  - factor minus product: +0.058 [-0.017, +0.133].
  - Both are within noise at 3 seeds, though every seed favors factor.
- **Order noise:** the same seed and rule gave 0.767 at round 12 in the main run and 0.795 in the follow-up. Only the order of
  random batches differed, because the main run's factor came after pooled training in the same process.

**Which averaging is correct**
- The exact FedAvg of the boards' models is the average of their products, since each board ends with W + s B_k A_k.
- Averaging A and B separately differs from that by the boards' covariance of the factors. On random factors that gap was 88% of
  the exact product, and with a shared A it was 0 (`algebra_check` in `lora-prep.json`).
- In training, boards start each round from the same factors, so the gap stays small:
  - 7% to 17% of each round's change (`mismatch_rel_to_update_by_round`);
  - 12% of the whole adapter in round 1, falling to 0.8% by round 40.
- Even so, factor averaging trained fastest here. The exact rules lost for other reasons:
  - Merge-and-restart starts every round from B = 0 with a fresh optimizer, so 5 local steps move little.
  - The SVD cut loses 1% to 7% of the average each round and changes the factors' scale.
  - FFA can only move B.
- So: **product averaging is the correct FedAvg; factor averaging is an approximation that worked better at 5 local steps per
  round, and exactness was not the bottleneck.**
- With many more local steps per round, the boards' factors drift further apart and the gap grows. We did not measure that.

**Overfitting:** in the 40-round factor run, test loss bottomed near round 20 (0.40), then rose to 0.71 by round 40 while accuracy
stayed near 0.90. Each board had seen its 128 examples about 12 times. A real run should stop on a held-out set.

**Curves** (mean of 3 seeds, accuracy; the JSON has train and test loss for every round):

| Round | 1 | 4 | 8 | 12 | 20 | 30 | 40 |
|---|---|---|---|---|---|---|---|
| Pooled (main run) | 0.485 | 0.820 | 0.872 | 0.917 | | | |
| Factor (40-round run) | 0.257 | 0.442 | 0.672 | 0.795 | 0.893 | 0.900 | 0.907 |
| Svd (40-round run) | 0.327 | 0.417 | 0.612 | 0.693 | 0.853 | 0.873 | 0.882 |
| Product (40-round run) | 0.317 | 0.418 | 0.478 | 0.583 | 0.638 | 0.803 | 0.848 |
| Factor, test loss (40-round run) | 1.373 | 1.265 | 0.956 | 0.635 | 0.404 | 0.523 | 0.712 |

### Bytes a board sends

| | Per upload |
|---|---|
| Tabular MLP, fp32 | 14,084 B (1.41 MB over 100 rounds) |
| This run's adapter (rank 8, top 2 layers, 6 linears each), fp32 raw | 884,736 B |
| The same with `torch.save` | 891,611 B |
| The same, gzip level 6 | 822,145 B (7% smaller: trained floats barely compress) |
| The same in fp16 | 442,368 B |
| FFA (B only), fp32 | 442,368 B, up and down |
| Product rule, download per round | 4,423,680 B (all 5 adapters), or 56,623,104 B as a dense merged update |
| Factor and svd rules, download per round | 884,736 B |
| Computed: RoBERTa-base, rank 8 on all 12 layers' 6 linears, fp32 | 5,308,416 B |
| Computed: Llama 3.2 1B, rank 8 on all 7 projections, 5,636,096 parameters | 22.5 MB fp32, 11.3 MB bf16 |

To reach the target, factor averaging sent 20 to 25 adapters per board, which is 17.7 to 22.1 MB up and the same down. At the
same number of rounds, a Llama 3.2 1B adapter would mean 225 to 282 MB up per board in bf16, or 450 to 564 MB in fp32 (estimate;
the round count for that model is not measured).

### Time and memory (the sandbox, not a Jetson)

- **Tabular:** the whole script took 269 s at 2 threads beside the LoRA work, with 753 MB peak RSS.
  - One plain run: 2.4 to 4.4 s.
  - FedBuff: 14.7 s, since it has 2.3 times as many local jobs.
  - An Opacus DP run: 12 to 13 s.
- **LoRA prep** took 35 s at 6 threads, with 3.4 GB peak RSS. The cache of 1,200 by 98 by 768 floats is 361 MB.
- **LoRA training:**
  - One training step (batch 8, 2 cached layers): 0.084 s at 2 threads alone.
  - A 12-round method: 45 to 52 s with three seed processes at 2 threads each beside the tabular run (alone: 36 to 38 s).
  - A 40-round method: 151 to 171 s.
  - Each seed process peaked at 1.4 to 1.5 GB RSS.

## What it means for training across Jetsons (our reading, for the design)

- **One job over several boards pays only when the data cannot move.** On these skewed splits, FedAvg needed 3 to 6 times the
  example gradients of pooled training to come within 2 points.
  - Offline mode's rule is that records stay on the device. That is the reason to federate, and the simulation says it works.
  - If records can move, pool them on one board or the platform.
- **Many jobs at once** (different fine-tunes on different boards) needs no federation. The "alone" rows show what a board gets
  from its own skewed data: 0.80 tabular, 0.65 LoRA.
- **Worth building, cheap:**
  - federated statistics for normalization, a few numbers per board;
  - noisy label counts for class weights, when a balanced metric matters more than accuracy.
- **FedBuff mainly helps with stragglers and dropouts:** 2.3 to 2.7 times sooner to target here, with one 4x-slow board and a
  timeout. Other speed mixes will differ; this is not an estimate for them.
  - It over-weights fast boards, so weighting by examples or capping uploads per board is worth a design note. We did not test
    either.
  - Papaya's 5x came from 130 to 2,600 concurrent phones, not five boards.
- **For LoRA, average A and B separately and keep A trainable.** It was the best rule here. The exact rules cost more download
  (5 adapters, or a 56.6 MB dense update) and learned slower. Stop on held-out loss.
- **Privacy at fleet size:**
  - Opacus per-example DP-SGD is the meaningful option. Epsilon is 2 to 7 per board at noise 1.0 with no measurable accuracy
    cost beyond clipping on this task.
  - Board-level DP with 5 boards gives no useful guarantee.
  - Opacus's memory on a Jetson is not measured.
- **Board work for Hussam** (not done here):
  - a two-board Gloo all-reduce, or a hub-and-spoke adapter upload;
  - `train_model` taking a starting adapter, plus a tool that returns adapter weights;
  - one real step time and peak memory per board.

## Meta research, checked

Meta's here:
- **From the paper (2206.00807):** the design ideas, meaning federated statistics for normalization and label balancing, and noise
  on device or after aggregation.
- **FedBuff** (Nguyen et al., Meta AI).
- **Opacus** (Meta), the DP library and its accountant.
- **RoBERTa-base**, the model (Facebook AI with the University of Washington).

Not Meta's:
- **DP-SGD itself** (Abadi et al., Google), which Opacus implements.
- **LoRA** (Hu et al., Microsoft).
- **FFA-LoRA's** frozen-A idea (Sun et al., ICLR 2024).
- **The data:** UCI Adult and PolyAI's Banking77.
- **The tooling:** Hugging Face transformers and PyTorch's CPU build.

Every line of experiment code is fresh.

## Spend

| | Cost | How it was measured |
|---|---|---|
| Vercel Sandbox | about $0.43 | After stop: 5,719 s of active CPU at $0.128 an hour ($0.20), 16 GB for 1,101 s at $0.0212 a GB-hour ($0.10), 848 MB of transfer at $0.15 a GB ($0.13). Pro rates as `run-spike.ts` lists them. Worst case, every vCPU busy throughout: $0.52 |
| Meta | $0 | No model calls |

`cost-ledger.jsonl` holds the run. The runner refuses to start when the ledger plus a 30-minute worst case ($0.78) could pass $1.

### Cost ledger

The one row in `cost-ledger.jsonl`, written by `run-spike.ts down` after the sandbox stopped:

| Field | Value |
|---|---|
| Written at | 2026-10-31 23:26:56 UTC (19:26:56 EDT) |
| Sandbox | `spike-fl-mvx0ilks1cc3`, 8 vCPUs, created in 1.9 s |
| Phases, in order | setup 25.9 s (`allow-all`); then all `deny-all`: closed 0.2 s, smoke 23.6 s, peek 0.1 s, run 383.3 s (budget 720 s), peek 0.1 s, extend 501.3 s (budget 540 s). Every phase exited 0 |
| Create to stop | 1,101 s |
| Active CPU | 5,719 s (5,719,269 ms) |
| Transfer | 845,316,117 B in, 2,863,129 B out |
| End state | stopped, deleted, "gone" when checked after the delete |
| Estimate | $0.4343 |
| Worst case | $0.5168 |

## Not measured

- **Anything on a Jetson:** step time, memory, Opacus there, Gloo or NCCL between boards, and real network transfer.
- **Real board speeds and dropout patterns.** Speeds 1x to 4x, one dropout and the 2x timeout are made up.
- **LoRA beyond the top 2 layers, or on a decoder.** Also Llama 3.2 1B, and DP-SGD on the LoRA task.
- **The averaging gap at more local steps.** Also FedBuff weighted by examples, and FedBuff on the LoRA task.
- **More than 3 seeds.** Several LoRA comparisons are within noise at 3 seeds.
- **A tuned learning rate for DP-SGD.** Also an adaptive clipping norm for board-level DP.
- **Federated statistics on small boards.** With 50 rows a board, the Laplace noise would matter far more than at 2,000 to
  6,000.

## Files

- `run.sh` gets a fresh OIDC token the way the replication spike does, into a mode 600 temp file in the session scratchpad. It
  reads only that token and deletes the file. From the linked checkout's `.env.local` it reads one name, `BUILDER_SNAPSHOT_ID`,
  into a clean child environment. Nothing is printed.
- `run-spike.ts` drives the sandbox: `up`, `exec smoke|closed|peek|run|extend`, `wait`, `down`. The sandbox's name and phase
  timings sit in a mode 600 state file in the scratchpad, removed by `down`.
  - `down` copies `/tmp/out` back, stops the sandbox, checks it stopped, reads its usage, deletes it, writes the ledger and scans
    the copy for the token. The scan was clean.
- `list.ts` lists `spike-fl-*` sandboxes; with `--stop` it stops any still running.
- Phase scripts: `phase-setup.sh`, `phase-closed.sh`, `phase-smoke.sh`, `phase-run.sh`, `phase-extend.sh`, `phase-peek.sh`.
- Experiments, written fresh: `fl_tab.py` and `fl_lora.py`.
- `results/`:
  - `tab.json` and `tab.txt`: every round of every tabular run;
  - `lora-prep.json`: the checks, the intent mapping, zero-shot, the plan and the algebra check;
  - `lora.json`, `lora-seed{0,1,2}.json`: the main LoRA run;
  - `lora-long.json`, `lora-long-seed{0,1,2}.json`: the 40-round follow-up;
  - `decision-examples.jsonl`;
  - the phase outputs, `setup.json`, `pip-list.txt`, `data-sha256.txt`, `closed.txt`, `progress.log`, `sandbox.json`;
  - `smoke/`, the smoke pass.

## Running it again

From the worktree root:

```
docs/spikes/fleet-train-2026-10-31/run.sh up docs/spikes/fleet-train-2026-10-31/results-2
docs/spikes/fleet-train-2026-10-31/run.sh exec docs/spikes/fleet-train-2026-10-31/results-2 smoke
docs/spikes/fleet-train-2026-10-31/run.sh exec docs/spikes/fleet-train-2026-10-31/results-2 run 720
docs/spikes/fleet-train-2026-10-31/run.sh wait docs/spikes/fleet-train-2026-10-31/results-2 480
docs/spikes/fleet-train-2026-10-31/run.sh exec docs/spikes/fleet-train-2026-10-31/results-2 extend 540   (optional)
docs/spikes/fleet-train-2026-10-31/run.sh wait docs/spikes/fleet-train-2026-10-31/results-2 540 extend
docs/spikes/fleet-train-2026-10-31/run.sh down docs/spikes/fleet-train-2026-10-31/results-2
docs/spikes/fleet-train-2026-10-31/run.sh --list
```

The ledger already holds this run's $0.52 worst case. A second full run would need the cap raised, or a new ledger.
