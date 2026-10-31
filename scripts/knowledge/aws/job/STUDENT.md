# The Jetson student

The 3B to 4B model for Jetson Orin Nano 8 GB boards and phones (docs/KNOWLEDGE_UPDATE.md, Jetson): NVIDIA Nemotron
3.5 Bolt E4B, BF16 release `nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-BF16` at `49843eed8db1f1c616c47af75cfd36e07aec0667`
(OpenMDW-1.1, built on Gemma 4 E4B, Apache 2.0), the model the fleet already serves on jetson-03 and jetson-04. It
trains on `train-student.jsonl` (562,827 examples, sha256 `efa8fff05d717e0b71a376bce5fe984d0831aba5d1f5c68af70e40feaca3693d`;
the `.gz` is `90b5077b84785e5889dd37da1620bc47f1f62be070297307cc8244167f60e136`): Glimmer-written Q&A, base Glimmer's
replay answers and the cutoff templates, checked by `check_student_lineage.py`. No Spark Open pairs, no anchors, no
tuned Glimmer answers, so the student stays permissive.

Fallbacks: `STUDENT_PROFILE=gemma4-e4b` (Google's same architecture and template, same code path) or
`STUDENT_PROFILE=qwen3.5-4b` (not smoke-tested; its venv also needs flash-linear-attention and causal-conv1d).

## Files

| File | What it does |
|---|---|
| `train_student.py` | Base answers, LoRA training (Unsloth, loss on answers only), tuned answers, `metrics.json` and `answers.json` with train_glimmer.py's keys plus `probe_split`, then the merge into BF16 (`train_student.py merge`, CPU) |
| `run_student.sh` | On the GPU machine: checks nothing else is running, the venv (run.sh's pins), the weights (anonymous), then `torchrun` on every GPU or one process on one GPU; with `GGUF=1`, `student_gguf.sh` afterwards |
| `student_gguf.sh` | llama.cpp b11970 build, BF16 GGUF, Q8_0, imatrix from training text, Q4_K_M in the layout of NVIDIA's fleet file, each scored, all on GPU 0; `base` mode does the same for the untouched model, `build` mode only the build, at low priority with no GPU use |
| `score_student_gguf.py` | Scores a GGUF through llama-server (same prompts, grading and probe subset as training), checks llama.cpp's tokenizer and the GGUF's template against training, writes the calibration text and the table |
| `test_student.py` | CPU check of rendering, masking and the merge, on this Mac with Bolt's real tokenizer, no weights |
| `../check_student_lineage.py` | On this Mac: every fact pair against the Q&A cache, no anchors, no eval probe question (compared normalized) |
| `../make_student_slice.py` | On this Mac: the smoke test's 3,000 rows and 200 probes |

## Settings and why

- LoRA rank 128, alpha 128 (scale 1, as Glimmer's recipe) on q, k, v, o, gate, up and down of the language model:
  258 modules, 516 tensors (k and v only on layers 0 to 23; layers 24 to 41 reuse their K/V). Rank 128 is what matched
  full continued pretraining at 1B and came close at 3B (arXiv 2609.23916).
- Learning rate 2e-4, cosine, 3% warmup, AdamW 8-bit, 2 epochs, effective batch 32 (4 per GPU on 8 GPUs; 4 x 8
  accumulation on one), max length 2,048 (the longest example is 518 tokens, a replay answer; the mean is 83). Glimmer used 1e-4 at 30B; a 4B
  model has far less spare capacity and needs more passes per fact. If time is short, 1 epoch.
- Chat: Bolt's own `chat_template.jinja` with thinking off and the system line "You are a helpful assistant.". With
  transformers 5.15 Bolt's tokenizer adds no BOS, so the template's `<bos>` stays in the text and is the sequence's one
  BOS (train_glimmer.py strips it, which would leave none here).
- Loss on answers only: Unsloth's `train_on_responses_only` with `<|turn>user\n` and `<|turn>model\n`; the answer and its
  `<turn|>` are trained. Before training, its labels on the first 256 examples must equal `response_labels()` and decode
  to exactly the answers, or the run stops (`MASKING=own` trains on this file's own labels instead).
- Guards that stop a run: the LoRA layout isn't the 258 modules; the first logged loss is above 8 (1 to 3 is normal; 10
  to 15 means the KV-sharing path is broken); a LoRA weight has no gradient, or a lora_B a zero one, on step 1 (this also
  covers `ddp_find_unused_parameters=False`); the saved adapter's tensor count differs; any merge check fails.
- Eval: greedy, 96 new tokens, the 2,500 probes (stage2-eval-probes.jsonl, shuffled with seed 7) and the 40 old facts,
  base and tuned. `probe_split` splits them into fixed (the 1,500) and new (the 1,000), and covered (the student set has
  the passage: 1,854 of 2,500) or not. "What is the capital of Australia?" is also a replay prompt, so the old-fact
  score without it is kept too.

## The training set

Built on this Mac on Oct 30 at 11:34 PM, with one row dropped on Oct 31:

```
npx tsx scripts/knowledge/assemble-dataset.ts --out train-student.jsonl --writers muse-glimmer-30b,muse-glimmer-q4 \
  --all-writers --no-anchors --exclude .data/knowledge/dataset/eval-probes.jsonl,.data/knowledge/dataset/stage2-new-probes.jsonl \
  --cap-low 3000
python3 scripts/knowledge/aws/check_student_lineage.py
```

`train-student-report.json` keeps these flags (`argv`). The command is checked: run with the exact `--exclude` of that
day on the cache as it stood at 11:32 PM (299,174 files), it gave the original file byte for byte (sha256 `5f5c982a...`,
562,828 examples). The cache has grown since and is still growing (about 165,000 more Glimmer files by 2:37 AM), so a
rerun now gives a different file; the sha256 above is the set.

The dropped row is `source:s3-ccnews:ec3811df949f935b:0`, the only one whose question matches an eval probe once
normalized: it differs from a probe of `source:s3-ccnews:40fb7af3dcadefeb:0` by a curly apostrophe, which the exact
comparison of that day missed. It was removed from the file as is, keeping every other row and the order, so the smoke
test's slice and `base.json` still apply; `--exclude` and the lineage check now compare normalized questions. Rebuilding
with the new `--exclude` drops the same row, but one row fewer reshuffles the file and redraws `--cap-low`'s picks (10,871
rows in five capped sources), which is why this set wasn't rebuilt.
`train-student.jsonl.gz` is `gzip -nc` of the file. The set, its report and its lineage report are in
`s3://muse-knowledge-916979311153/knowledge/corpus/dataset/`.

## CPU check on this Mac

```
uv run --no-project --python 3.12 --with transformers==5.15.0 --with tokenizers==0.22.2 --with jinja2 \
  --with torch --with safetensors python -I scripts/knowledge/aws/job/test_student.py
```

16 checks, about a minute. Add `--fetch-qwen` to cover the fallback's tokenizer (about 23 MB, already cached here).

## Shell helpers (this Mac, zsh)

The Lambda key is `~/.ssh/muse-muse-lambda`; no other secret leaves this Mac.

```
J=scripts/knowledge/aws/job; D=.data/knowledge/dataset
k()   { ssh -i ~/.ssh/muse-muse-lambda -o StrictHostKeyChecking=accept-new -o BatchMode=yes ubuntu@$IP "$@"; }
kcp() { scp -i ~/.ssh/muse-muse-lambda -o StrictHostKeyChecking=accept-new -o BatchMode=yes -C "$@"; }
code_to() { k 'mkdir -p ~/k/student ~/k/runs' && kcp $J/train_glimmer.py $J/score_gguf.py $J/train_student.py \
  $J/score_student_gguf.py $J/run_student.sh $J/student_gguf.sh ubuntu@$IP:k/student/; }
log_of() { k "tail -n 3 ~/k/runs/$1/log.txt; grep -hoE 'MUSE \{\"event\": \"(base_reused|lora|chat|masking|first_loss|grad_check|trained|done|merged)\".{0,320}' ~/k/runs/$1/log.txt; grep -h 'MERGE {\"event\": \"check\"' ~/k/runs/$1/log.txt | cut -c1-320; cat ~/k/runs/$1/gguf/table.md 2>/dev/null"; }
```

The code goes to `~/k/student/`, never over `~/k/train_glimmer.py`, which stage 2 runs.

Detached starts below put `|| exit 1;` before `setsid`, never `&& setsid ... &`: with `&&`, the shell backgrounds the
whole list in a subshell that keeps ssh's output open, so `k` doesn't return until the run ends (the smoke test hit this).

## (a) Smoke test on one GPU

On a new `muse-knowledge-student-N` machine (one A100 or H100; 40 GB or more trains the real BF16 path, an A10 runs
QLoRA), never an existing machine. Its Mac watch (dollar cap and deadline, terminate by id, as train_multi.py's
`watch` and `terminate()` do) runs before anything else. About 30 minutes for 3,000 examples over 2 epochs, most of it
training and the llama.cpp build (under 15 minutes with 12 jobs at low priority); the venv and the 15 GB download took
under a minute.

```
IP=<the student machine's address>
python3 scripts/knowledge/aws/make_student_slice.py .data/knowledge/student-smoke
code_to
k 'mkdir -p ~/k/data-student-smoke'
kcp .data/knowledge/student-smoke/train.jsonl .data/knowledge/student-smoke/probes.jsonl ubuntu@$IP:k/data-student-smoke/
kcp $D/eval-probes.jsonl ubuntu@$IP:k/data-student-smoke/eval-probes.jsonl
kcp scripts/knowledge/aws/forget.jsonl ubuntu@$IP:k/data-student-smoke/forget.jsonl
k 'cd ~/k || exit 1; setsid nohup bash student/student_gguf.sh build > runs/student-build.wrapper.log 2>&1 < /dev/null &'
k 'tail -n 2 ~/k/runs/student-build/gguf/pipeline.log'   # until "finished: built"
k 'cd ~/k || exit 1; GGUF=1 setsid nohup bash student/run_student.sh student-smoke ~/k/data-student-smoke 2 3000 200 > runs/student-smoke.wrapper.log 2>&1 < /dev/null &'
log_of student-smoke
```

The slice is the one the smoke test trained on (train sha256 `2db0fc25c0260b93...`, in its metrics.json). That run built
llama.cpp by hand first (same tag, with CUDA and llama-bench too), so its log says `skip build`; `student_gguf.sh build`
came later and first runs on a real machine at (b) step 1.

It passes when `log_of` shows:
- `lora`: tensors 516, modules 258, layers_with_kv_lora 24;
- `chat`: bos_dropped false, instruction_ids [105, 2364, 107], response_ids [105, 4368, 107], end_ids [1, 50, 105, 106];
- `masking`: all_right true; `first_loss` about 1 to 3;
- `grad_check`: without_grad 0 and lora_b_zero_grad 0, and each of the four `kv_producer_grad_norms` at least 5 times
  `other_kv_median_grad_norm`. It was 8 to 18 times on all six one-GPU runs. Near 1 time means the shared K/V got
  detached: layers 22 and 23 still get gradients from their own attention, and the loss looks fine, so nothing else
  shows it;
- the merge `check`: ok true, targeted_tensors 258, changed_untargeted 0;
- `table.md`: Q4_K_M about 6.2 GB, llama.cpp ids 8/8, server template 8/8 text and 8 ids;
- `EXIT 0` and `GGUF EXIT 0` at the end of the log.

Then, on the same machine while its watch allows (about 25 minutes), the untouched model's files as the yardstick, on
the full probes, with the full set for its calibration (65 MB from this Mac):

```
k 'mkdir -p ~/k/data-student'
kcp $D/train-student.jsonl.gz ubuntu@$IP:k/data-student/
kcp $D/stage2-eval-probes.jsonl ubuntu@$IP:k/data-student/probes.jsonl
kcp $D/eval-probes.jsonl ubuntu@$IP:k/data-student/eval-probes.jsonl
kcp scripts/knowledge/aws/forget.jsonl ubuntu@$IP:k/data-student/forget.jsonl
k 'cd ~/k/data-student && gunzip -c train-student.jsonl.gz > train.jsonl && sha256sum train.jsonl'
k 'cd ~/k || exit 1; DATA=~/k/data-student setsid nohup bash student/student_gguf.sh base ~/k/hf/hub/models--nvidia--NVIDIA-Nemotron-3.5-Bolt-E4B-BF16/snapshots/49843eed8db1f1c616c47af75cfd36e07aec0667 2500 > runs/student-base.wrapper.log 2>&1 < /dev/null &'
k 'cat ~/k/runs/student-base/gguf/table.md'
mkdir -p .data/knowledge/student-dev && kcp -r ubuntu@$IP:k/runs/student-smoke ubuntu@$IP:k/runs/student-base .data/knowledge/student-dev/
```

The runs folders hold only logs, scores and JSON (no weights), so copying them here is safe. The base answers for (b)
came from `student-dev/student-smoke/base_bf16.sh` (train_student.py with base_only 1 on `~/k/data-student`, one GPU,
566 s). Then stop the machine with its watch.

### What the smoke test measured (Oct 31, muse-knowledge-student-1, one A100 SXM4 40GB)

All of the pass checks above held (results in `.data/knowledge/student-dev/`). Steady training rate on one GPU by
examples per step (`BATCH`): 4: 9.7 a second (19.1 GB peak); 16: 31 to 33 (20.9 GB); 32: 39 (23.2 GB). The loss curve
is the same for 16 x 2 and 32 x 1 at an effective batch of 32, so `BATCH` changes only speed at a fixed effective
batch. On 8 GPUs the effective batch is `BATCH` x 8, though: 4 keeps the recipe's 32, 16 makes it 128. On the
3,000-example slice (200 probes, base 5.5%): effective batch 32 for 2 epochs gave 20.5%, for 1 epoch 15.0%; effective
batch 128 for 2 epochs gave 16.5% at 2e-4 and 15.0% at 4e-4. Other steps: venv 14 s, weights 28 s, first step 3 min
(compiling), merge 40 s, BF16 GGUF 63 s, Q8_0 19 s, imatrix 3 min (381 chunks; 6.2 min for the full set's 781), Q4_K_M
35 s, the base answers on all 2,540 questions 566 s. The Q4_K_M's header matches the fleet's file in every key but the
imatrix's, with the same 720 tensors, shapes and types. llama-bench on the tuned Q4_K_M: 140.9 tokens a second on the
A100 (with or without `-ot per_layer_token_embd=CPU`), 18.2 on 6 cores of an EPYC 7J13 (not a board's cores).
`student-dev/student-base-bf16/base.json` holds the base answers on all 2,540 questions, for (b).

## (b) Full run on muse-knowledge-train-1 after stage 2

train-1's watch terminates it at Oct 31 10:00 AM ET (14:00 UTC) or $450, and nothing on its disk survives that.
run_student.sh refuses while any GPU is busy, so one job runs at a time.

1. Code, data and the llama.cpp build, any time (nothing touches the GPUs; the train file goes as the 65 MB `.gz`; the
   build runs beside stage 2 at the lowest CPU and disk priority, with 12 jobs, under 15 minutes on the smoke machine):

   ```
   IP=163.192.200.51
   code_to
   k 'mkdir -p ~/k/data-student'
   kcp $D/train-student.jsonl.gz ubuntu@$IP:k/data-student/
   kcp $D/stage2-eval-probes.jsonl ubuntu@$IP:k/data-student/probes.jsonl
   kcp $D/eval-probes.jsonl ubuntu@$IP:k/data-student/eval-probes.jsonl
   kcp scripts/knowledge/aws/forget.jsonl ubuntu@$IP:k/data-student/forget.jsonl
   k 'mkdir -p ~/k/student-ckpt/student-ddp'
   kcp .data/knowledge/student-dev/student-base-bf16/base.json ubuntu@$IP:k/student-ckpt/student-ddp/base.json
   k 'cd ~/k/data-student && gunzip -c train-student.jsonl.gz > train.jsonl && sha256sum train.jsonl probes.jsonl ../student-ckpt/student-ddp/base.json && wc -l *.jsonl'
   k 'cd ~/k || exit 1; setsid nohup bash student/student_gguf.sh build > runs/student-build.wrapper.log 2>&1 < /dev/null &'
   k 'tail -n 2 ~/k/runs/student-build/gguf/pipeline.log'
   ```

   Expect train `efa8fff0...`, probes `6703716fc7fd6133...` (stage 2's), base.json `067d419d51c361dd...`, and 562,827,
   2,500, 1,500 and 40 lines. The build has passed when the log ends `llama.cpp b11970 at 52202132...` and `finished: built`;
   a failure leaves the reason in `~/k/runs/student-build/gguf/logs/build.log`, and it is far better found now than after
   training. If it hasn't run by the full run, `student_gguf.sh` builds first, about 15 minutes more.

2. Stage 2 is finished (its tuned answers end about 4:30 to 5 AM): `EXIT 0` in its log, no GPU process, and its
   outputs in `.data/knowledge/runs/stage2-multi/out/` here:

   ```
   k 'tail -n 2 ~/k/runs/stage2-multi/log.txt; nvidia-smi --query-compute-apps=pid,process_name --format=csv,noheader'
   ```

3. An 8-GPU test, about 7 minutes: 6,400 examples under DDP at the full run's `BATCH`, reusing the base answers from
   step 1 (without that file it adds about 10 minutes). DDP has not run on this code yet, so this is its first real
   check, and Unsloth sets up checkpointing differently under DDP, so the one-GPU gradient result doesn't carry over.

   The rates before it are estimates. The best case takes the smoke test's 4 x 8 and 16 x 8 (9.7 and 33 a second on one
   GPU) with 95% scaling: `BATCH=4` (the recipe's effective batch 32) 74 a second, `BATCH=16` (effective batch 128) 250.
   But on 8 GPUs both run accumulation 1, an optimizer step and an all-reduce of about 1.1 GB of LoRA gradients on every
   step. Going by `16 x 2` at 31 against 33 for `16 x 8`, expect about 64 and 220 before the all-reduce's own cost
   (not measured):

   | `BATCH` | Best case | Likely | Time an epoch |
   |---|---|---|---|
   | 4 | 74 a second | 64 a second | 2.1 to 2.4 hours |
   | 16 | 250 a second | 220 a second | 37 to 43 minutes |

   Either way only 1 epoch of `BATCH=4` fits before 10:00 AM, and 2 epochs of `BATCH=16` fit with room to spare.
   The commands use `BATCH=16`, a change from the recipe's effective batch of 32; for `BATCH=4`, drop it from both and
   run 1 epoch.

   ```
   k 'cd ~/k || exit 1; BATCH=16 TUNED_EVAL=0 MERGE=0 setsid nohup bash student/run_student.sh student-ddp ~/k/data-student 1 6400 2500 > runs/student-ddp.wrapper.log 2>&1 < /dev/null &'
   log_of student-ddp
   k 'grep -nE "Traceback|Error" ~/k/runs/student-ddp/log.txt | cut -c1-200 | head'
   mkdir -p .data/knowledge/student-dev && kcp -r ubuntu@$IP:k/runs/student-ddp ubuntu@$IP:k/runs/student-build .data/knowledge/student-dev/
   ```

   It passes when:
   - `base_reused` is there; `lora`, `chat`, `masking` and `first_loss` read as in (a);
   - `grad_check` reads as in (a), the ratio included: this is the check that matters most here;
   - `trained`: `gpus` 8, `effective_batch` 128 (32 for `BATCH=4`), eight `peak_vram_gb_per_gpu` values;
   - `done` with tuned_eval false, `EXIT 0` at the end of the log, and no error from the grep. With `MERGE=0`,
     `TUNED_EVAL=0` and no `GGUF`, there is no merge check, `table.md` or `GGUF EXIT 0` to read.

   The copy keeps the first measured 8-GPU rate, which train-1's termination would otherwise lose; the sync only covers
   student-bolt. Decide from `examples_per_second_steady` in `trained`, not the table: training takes 562,827 x epochs /
   that rate seconds. Keep about 1 hour 45 minutes after training for the tuned answers (about 10 minutes), merge and
   GGUF (about 23 minutes on one GPU, measured on the base files) and the adapter copy (step 5) before 10:00 AM: 2
   epochs if that fits, else 1.

4. The full run, reusing the test's base answers:

   ```
   k 'mkdir -p ~/k/student-ckpt/student-bolt && cp ~/k/student-ckpt/student-ddp/base.json ~/k/student-ckpt/student-bolt/ && cd ~/k || exit 1; BATCH=16 GGUF=1 setsid nohup bash student/run_student.sh student-bolt ~/k/data-student 2 0 2500 > runs/student-bolt.wrapper.log 2>&1 < /dev/null &'
   nohup caffeinate -ims .data/aws/venv/bin/python scripts/knowledge/aws/train_multi.py lambda-sync --name muse-knowledge-train-1 \
     --run student-bolt >> .data/knowledge/logs/train-multi-sync-student-bolt.out 2>&1 &
   log_of student-bolt
   ```

   The sync brings `~/k/runs/student-bolt` (logs, metrics, answers, scores: no weights) to
   `.data/knowledge/runs/student-bolt/` every 10 minutes and puts it in `s3://muse-knowledge-916979311153/knowledge/runs/student-bolt/`.

5. Before 10:00 AM, the adapter (and the Q4_K_M if the link allows) to S3, streamed through this Mac without touching
   its disk; the AWS profile stays here:

   ```
   S3=s3://muse-knowledge-916979311153/knowledge/models/student-bolt
   k 'cd ~/k/models/student-bolt && tar -cf - adapter' | aws --profile offlinebase s3 cp --only-show-errors - $S3/adapter.tar
   f=student-bolt-Q4_K_M.gguf
   k "cat ~/k/models/student-bolt/$f" | aws --profile offlinebase s3 cp --only-show-errors - $S3/$f
   k "cat ~/k/runs/student-bolt/gguf/sha256.txt"; aws --profile offlinebase s3 ls $S3/
   ```

   The adapter is 1,116,287,176 bytes at rank 128 (float32): about 9 minutes at the 2.2 MB/s this Mac uploaded at
   during the smoke test, up to 2 hours at the 160 KB/s seen earlier. The Q4_K_M (6.18 GB) fits only if the link stays
   near 2 MB/s. Anything not copied is rebuilt from the adapter on any GPU machine with the base weights, in about 10
   minutes on one A100 (the smoke test's merge, conversion, imatrix and quantize steps):
   `train_student.py merge --base BOLT_DIR --adapter adapter --merged merged`, then `student_gguf.sh student-bolt merged`.

6. Results, here:

   ```
   cat .data/knowledge/runs/student-bolt/gguf/table.md
   python3 $J/score_student_gguf.py table --dir .data/knowledge/runs/student-bolt/gguf \
     --metrics .data/knowledge/runs/student-bolt/out/metrics.json --base-dir .data/knowledge/student-dev/student-base/gguf
   python3 scripts/knowledge/aws/probe_by_writer.py student-bolt $D/stage2-eval-probes.jsonl
   ```

## Boards

A Q4_K_M goes onto a board only through the fleet's normal deploy path, with the owner's OK, on a board in maintenance
(jetson-03 or jetson-04 style, never jetson-05), with the fleet's command unchanged: `llama-server -ngl 999 -c 8192
-np 1 -fa on -b 512 -ub 512 --cache-ram 256 --jinja --reasoning off --temp 1.0 --top-p 0.95 --load-mode mmap
--lazy-mode on -ot per_layer_token_embd=CPU`. Never `--no-mmap` or `--mlock` (a failed GPU allocation has frozen and
rebooted boards). Phones are measured with the devices kit before any claim. None of these scripts touches a board.
