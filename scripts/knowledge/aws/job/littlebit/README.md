# LittleBit for Muse Glimmer 30B (below 1 bit per weight)

## License: non-commercial only

LittleBit (Samsung Research, NeurIPS 2025, arXiv 2506.13771, https://github.com/SamsungLabs/LittleBit) is licensed
**CC BY-NC 4.0**. The owner approved its use on Oct 30, 2026 ("Ok, lets use it. this is non commercial").

- LittleBit's code is not in this repo. `setup.sh` clones it on the GPU machine at a pinned commit
  (`42d658b0c79f76450b34b6a3547462c7cdc3e1a0`) into its own venv. Our scripts import it at run time.
- The scripts in this folder, and every model they produce, are for non-commercial research use only. Keep them out
  of Muse Muse, the Jetson deliverable and anything else that is or could become commercial. Don't publish or upload
  the models. If that ever changes, this whole folder needs a new legal read first.
- The other inputs keep their own terms: Glimmer is Apache 2.0, LittleBit's general text is C4 (ODC-BY) and
  WikiText-2 (CC BY-SA), and our knowledge text follows docs/KNOWLEDGE_UPDATE.md (private parts stay private).

## Files

| File | What it does |
|---|---|
| `glimmer_littlebit.py` | Our Glimmer adaptation. `data` renders our training text in Glimmer's chat format (exactly as `train_glimmer.py` does), mixes in LittleBit's c4_wiki loader and drops any example whose question matches an eval probe or forgetting check. `init` runs LittleBit's Dual-SVID + Joint-ITQ init layer by layer, sharded over GPUs. `train` runs LittleBit's KDTrainer under DeepSpeed ZeRO-3 (or on one GPU) and saves LittleBit's packed format. `slice` makes a small Glimmer of the first N layers for tests. |
| `eval_littlebit.py` | Scores a LittleBit model (or, with `--fp`, the BF16 model): greedy answers with `train_glimmer.py`'s exact final-channel prompt and scoring on the 1,500 eval probes and the 40 forgetting checks, plus WikiText-2 perplexity. |
| `setup.sh` | Installs LittleBit and the tested versions in `~/lb/venv` (apart from the training venv). |
| `run_8gpu.sh` | The full run on one 8-GPU machine: reference eval, data, init, train, eval. Each step skips what's done and resumes. |
| `ds_student_fast.json`, `ds_teacher_fast.json` | Optional DeepSpeed configs (`FAST=1`) that keep parameters on the GPUs; the default uses LittleBit's own `configs/zero3.json` and `zero3_inference.json`, which offload to CPU. |

## What the adaptation does

- Glimmer loads as `MuseGlimmerForConditionalGeneration` (transformers 5.15.0). LittleBit's `main.py`, `eval.py` and loader use `AutoModelForCausalLM`, which has no Glimmer entry, and pin transformers 4.51, which has no Glimmer at all. Its `main.py` also passes `warmup_ratio`, which transformers 5 removed. So we don't run its `main.py` or `eval.py`; we use its `LittleBitLinear`, `patch_inst`, quantizers (`SmoothSign`), `KDTrainer`, data loader and packed format.
- Only the language model's projections become LittleBitLinear: `self_attn.{q,k,v,o,gate}_proj` and `mlp.{gate,up,down}_proj` in all 52 decoder layers (416 modules, 25.16B of 29.78B weights; Glimmer gates its attention output, hence the attention `gate_proj`). The vision tower, vision adapter and projection, embeddings and lm_head stay BF16 and frozen. The decoder norms train, as in LittleBit's recipe.
- `--l2l_loss_scale` (default 10): LittleBit's KDTrainer computes `KL(teacher || student)` on the logits plus `l2l_loss_scale x` the sum over decoder layers of the MSE between the student's and the teacher's hidden states. It is layer-to-layer distillation from the frozen full-precision teacher, and it is always on in LittleBit's trainer. The student never sees labels. Our teacher is the BF16 model the student was made from (the merged, tuned Glimmer for the real run).
- Defaults follow LittleBit's README: `SmoothSign`, residual path on, `kv_factor 1`, `min_split_dim 8`, lr 4e-5, batch 4 per GPU, 5 epochs, warmup 0.02, plus LittleBit-2's `--use_itq True`.
- Workarounds, all at run time, none in LittleBit's files: its packages only import in `main.py`'s order; its loader asks the Hub for the old `wikitext` id (now `Salesforce/wikitext`); checkpoints save plain parameters (LittleBitLinear's `state_dict` packs signs, which would lose the latent values resume needs); the init is seeded per layer so it doesn't depend on the GPU count; cuDNN attention is off in the eval (it rebuilt a graph for every sequence length and made decoding about 50 times slower on the H100).

## Measured on the dev machine (1x H100 PCIe 80 GB, 26 vCPUs, 221 GB RAM, Oct 31, 2026)

Base Glimmer at revision `cec94fcf`, `SmoothSign`, residual on, Joint-ITQ on, batch 4 x 2,048 tokens.

The whole model on one GPU, 0.1 bits, LittleBit's own ZeRO-3 configs (student, optimizer and teacher offloaded to CPU):
- 416 modules patched, 25.16B weights at 0.0993 bits each, 2.30B trainable parameters (factors, scales, decoder norms).
- 6 QAT steps: steady 8.22 s per step (first step 19.3 s), peak GPU 52.4 GB allocated (73.3 GB reserved). KD loss
  26,112 to 16,768 in 5 steps. Teacher load 88 s. Packed save 9.0 GB.
- Eval of that 6-step model, which is far too little training: 0 of 1,500 probes, 0 of 40 forgetting checks,
  WikiText-2 perplexity 11,092 (it answers "the the the"). It shows the full-size load, generation and perplexity
  path works: load 14.7 s, 1,540 answers in 429 s, 141 perplexity windows in 47 s, 16.8 GB of GPU memory.
- The BF16 teacher with the same eval: probes 18.73%, forgetting 40 of 40, WikiText-2 perplexity 6.22, 59.4 GB.
  Stage 1's base answers (train_glimmer.py through Unsloth) scored 18.60% and 40 of 40; the two runs give the same
  verdict on 1,484 of 1,500 probes and on all 40 checks, so the prompt and scoring match.

Slices (the first 2 and 4 decoder layers) under DeepSpeed ZeRO-3, median seconds per step:

| Bits | 2 layers | 4 layers | Per layer | Fixed | Full model on 1 GPU (52 layers) |
|---|---|---|---|---|---|
| 0.55 | 1.053 | 1.496 | 0.22 | 0.61 | 12.1 s, extrapolated (doesn't fit 221 GB RAM) |
| 0.3 | 0.928 | 1.309 | 0.19 | 0.55 | 10.4 s, extrapolated (doesn't fit) |
| 0.1 | 0.821 | 1.108 | 0.14 | 0.53 | 8.0 s extrapolated, 8.22 s measured |

- `FAST=1` configs on one GPU: same losses, 0.98 s (0.1 bits) and 1.64 s (0.55 bits) for 4 layers. Not faster at 0.55,
  so the default stays LittleBit's configs.
- Without DeepSpeed (one GPU, Trainer's autocast) the student's FP32 scales push LittleBit's elementwise math to FP32:
  1.15 s for 4 layers at 0.55 bits and 71 GB at batch 4. Use DeepSpeed (BF16) for real runs.
- Init per decoder layer (Dual-SVID + Joint-ITQ, 50 iterations): 55 s at 0.55 bits, 22.5 s at 0.3, 7.3 s at 0.1.
- Checkpoint and resume: checkpoints at steps 5 and 10, then a restart picked up at step 11 with the loss carrying on
  (3,445, then 3,380). A 4-layer checkpoint is 31 GB and took about 30 s.
- DeepSpeed CPU Adam: 0.17 s per step for 0.85B parameters on 26 threads.
- Data: stage 1 is 199,308 examples (1 more dropped because its question matched an eval probe), 21.0M tokens,
  10,237 blocks; c4_wiki is 80,945 blocks (165.8M tokens). One epoch of both: 91,182 blocks, 186.7M tokens.
- `setup.sh` from scratch, then `run_8gpu.sh` itself with `NGPU=1` on the 2-layer slice (`MAX_STEPS=4 SAVE_STEPS=2
  GENERAL_RATIO=0.5`): every step ran and it exited 0. Its 8-GPU parts (sharded init over 8 processes, 8 ranks) were
  only tested as 2 shards and 1 rank.
- Logs, step times and eval answers from these runs: `.data/knowledge/littlebit-dev/` (not in git).

Size. LittleBit leaves 9.2 GB in BF16: embeddings 2.7, lm_head 2.7 (Glimmer's vocabulary is 202,048), vision 3.8.

| Bits (decoder projections) | Packed projections | Whole saved model | Without the vision tower | Bits per weight, whole text model |
|---|---|---|---|---|
| 0.55 (0.548 actual) | 1.72 GB | about 10.9 GB | about 7.1 GB | about 2.0 |
| 0.3 (0.298) | 0.94 GB | about 10.2 GB | about 6.3 GB | about 1.8 |
| 0.1 (0.099) | 0.31 GB | 9.0 GB (measured) | about 5.7 GB | about 1.6 |

There are no inference kernels: the eval unpacks the signs to BF16, so the 0.1-bit model used 16.8 GB of GPU memory
(about 37 GB expected at 0.55, not measured). llama.cpp can't run it, so this is not a Jetson path as it stands.

## Time and cost on 8x A100 80GB (estimate, uncertain)

Per step: batch 4 on each of 8 GPUs, 65,536 tokens. Seconds per step = the one-GPU H100 figure above x 1.1 to 1.6
(A100 against H100 PCIe for this workload) x 1.05 to 1.2 (ZeRO-3 traffic across 8 GPUs), plus CPU Adam per rank:
0.55 bits 14 to 24 s, 0.3 bits 12 to 20 s, 0.1 bits 9 to 15 s. At $22.32 an hour (Lambda, gpu_8x_a100_80gb_sxm4):

| Recipe (stage 1 text) | Steps | 0.55 bits | 0.3 bits | 0.1 bits |
|---|---|---|---|---|
| LittleBit's: 5 epochs, all of c4_wiki | 14,248 | 57 to 93 h, $1,260 to $2,080 | 48 to 80 h, $1,080 to $1,780 | 37 to 61 h, $820 to $1,360 |
| 1 epoch, all of c4_wiki | 2,850 | 11 to 19 h, $250 to $415 | 10 to 16 h, $215 to $360 | 7 to 12 h, $165 to $270 |
| `GENERAL_RATIO=1`, 2 epochs | 1,280 | 5 to 8 h, $115 to $190 | 4 to 7 h, $95 to $160 | 3 to 5.5 h, $75 to $120 |

Each run adds about 40 minutes (about $15): model loads, init (7 layers per GPU: about 7 to 10 minutes at 0.55 bits,
1 minute at 0.1), checkpoint saves, the final save and the eval. Setup, data and the BF16 reference eval add about
30 minutes once. Stage 2's text adds one block per 2,048 tokens. A checkpoint at 0.55 bits is about 235 GB (two are
kept), and the run needs about 1 TB of RAM; the machine has 20 TB of disk and 1,800 GiB.

Why this is uncertain: nothing ran on more than one GPU, so NCCL traffic and 8 ranks offloading through the same host
are unmeasured. The A100 factor is a judgment: the time per layer (0.14 to 0.22 s) is far above the matrix-multiply
work (about 0.02 s), so the run is bound by memory traffic and kernel launches, where an A100 is close to an H100
PCIe. The 0.55 and 0.3 full-model figures come from slices (the same method was within 3% at 0.1). Quality after real
training was not measured; LittleBit reports Llama2-7B WikiText-2 perplexity going from about 5.5 to 10.5 at 0.55 bits
and 15.9 at 0.1 bits after its full recipe. Read `pace.jsonl` after about 50 steps: hours = steps x seconds per step / 3600.

## Running it on the 8x A100 80GB machine (muse-knowledge-train-1)

From this Mac, after stage 2 has finished and nothing else runs on the machine (IP from `train_multi.py status`):

```bash
cd ~/muse-muse
IP=<muse-knowledge-train-1 IP>
SSHO=(-i ~/.ssh/muse-muse-lambda -o BatchMode=yes)
scp "${SSHO[@]}" -r scripts/knowledge/aws/job/littlebit "ubuntu@${IP}:/home/ubuntu/k/"
scp "${SSHO[@]}" scripts/knowledge/aws/job/merge_adapter.py "ubuntu@${IP}:/home/ubuntu/k/"   # not in train_multi.py's CODE list
ssh "${SSHO[@]}" "ubuntu@${IP}" 'bash /home/ubuntu/k/littlebit/setup.sh > /home/ubuntu/lb-setup.log 2>&1; tail -1 /home/ubuntu/lb-setup.log'
# The teacher: stage 2's adapter merged into the BF16 base, in the training venv (merge_adapter.py checks the merge).
ssh "${SSHO[@]}" "ubuntu@${IP}" 'cd /home/ubuntu/k && venv/bin/python merge_adapter.py --base "$(cat weights.txt)" \
  --adapter runs/stage2-multi/out/adapter --out /home/ubuntu/k/merged --report /home/ubuntu/k/merged-report.json > merge.log 2>&1; tail -2 merge.log'
# One bit width per call; run the same command again to resume. MAX_HOURS stops it cleanly before the machine's deadline.
ssh "${SSHO[@]}" "ubuntu@${IP}" 'cd /home/ubuntu/k && setsid nohup env MODEL=/home/ubuntu/k/merged \
  TRAIN="/home/ubuntu/k/data/train.jsonl /home/ubuntu/k/data-stage2-multi/train.jsonl" \
  PROBES=/home/ubuntu/k/data/probes.jsonl FORGET=/home/ubuntu/k/data/forget.jsonl GLIMMER_JOB_DIR=/home/ubuntu/k \
  WORK=/home/ubuntu/lbrun MAX_HOURS=20 bash littlebit/run_8gpu.sh 0.55 1 > /home/ubuntu/lbrun-0.55.log 2>&1 < /dev/null &'
# Progress: steps, seconds per step and GPU memory, one line per step.
ssh "${SSHO[@]}" "ubuntu@${IP}" 'tail -3 /home/ubuntu/lbrun/runs/lb-0.55/pace.jsonl; tail -2 /home/ubuntu/lbrun/logs/run.log'
```

Then `0.3` and `0.1` the same way (`run_8gpu.sh 0.3 1`, `run_8gpu.sh 0.1 1`); the data and the reference eval are
reused. Paths assume the stage 2 run is named `stage2-multi` and its data sits in `/home/ubuntu/k/data-stage2-multi/`
(what `train_multi.py start-run --train` makes); adjust `TRAIN` and `--adapter` if not. Results: `RUN/eval/metrics.json`
(probe and forgetting accuracy, WikiText-2 perplexity) against `WORK/eval-fp/metrics.json` (the BF16 teacher).

The machine's own kill switch (`train_multi.py watch`) still applies: its cap and deadline were set for stage 1 and 2.
A LittleBit run takes many hours (below), so the main session has to raise that lane's cap and deadline first, or set
`MAX_HOURS` so the run stops cleanly before them.
