# Muse Glimmer: the fine-tuning lab against Meta's docs

Written Oct 31, 2026 on branch `tg-train-align`. Nothing was launched, nothing was spent and Meta was never called.
What this compares:

- **Our code:** `lib/train` at `37d5ad1`. These files are the same on `tuned-model-options` at `10db713`.
- **Meta's pages:** read live, and from the repo mirror `content/meta-docs/pages/muse-glimmer/` (synced Oct 30).
- **Knowledge run:** `~/muse-muse/docs/KNOWLEDGE_RUN_LOG.md` on main (`5f2acbe`), cited below as KRL.

Read with: `docs/TRAIN_BACKENDS.md` (where a job runs), `docs/TRAINING.md` (the lab), `docs/VIBE_TUNING.md` (trainChannel).

**Status:** aligned, partly, not aligned, n/a (does not apply).

**Fix size:**

| Size | Time |
|---|---|
| XS | under 1 h |
| S | 1 to 3 h |
| M | 3 to 8 h |
| L | over 8 h |

**Fix kinds:**

- **Safe now:** docs, cards, defaults or eval reporting. What a model learns stays the same.
- **Needs a test run:** a training or quantizing change. It can change model quality, so it needs a measured run.

Every `lib/train` edit waits until `tg-decide` lands, because that branch is editing those files now. Owner decisions
(O1 to O9) are listed in `docs/TRAIN_BACKENDS.md`.

## In one minute

- **The core recipe is within Meta's ranges:**
  - QLoRA on the language model's attention and MLP projections, with the vision tower frozen.
  - LR 2e-4, rank 16, loss on the assistant answer only, no packing.
  - Meta's own chat template.
  - Merge into the bf16 base, convert to BF16, then `llama-quantize`, on a llama.cpp newer than b10353.
- **Three things are not aligned:**
  1. **We train on final answers only.** Meta warns this "may suppress the model's chain-of-thought". Our knowledge
     run measured that break, and also measured the fix. This needs a test run.
  2. **Every card and local setting says temperature 0.** Meta says: "Don't run this model greedy." This is safe to fix
     now.
  3. **trainChannel 0 adapters use `<|eom|>` stops and a custom template file.** Meta says never stop on `<|eom|>` and
     don't pass `--chat-template-file`. We keep both on purpose, for those adapters only, until trainChannel 1 becomes
     the default.
- **Different on purpose, explained under "Deliberate differences":**
  - greedy eval
  - Unsloth on one 40 GB A100
  - CUDA 12.8 wheels
  - low reasoning strength
  - the forced final channel for trainChannel 0 and for decide mode
- **What doesn't apply:** Glimmer is a dense model ([post-training#hardware][pt-hw]), so nothing about MoE applies.
  We don't do RL, so [post-training#rl][pt-rl] doesn't apply either.

## The table

### A. Data and chat template

| # | Area | What Meta says | What we do | Status | Fix (size, kind) |
|---|---|---|---|---|---|
| A1 | Data format | Chat `messages` JSONL, one conversation per line, system message optional ([post-training#trl-sft-prepare-data][pt-trl-data]) | Single-turn system, user, assistant rows, string content only (`types.ts:332-340`, `glimmer.ts:216-230`) | aligned | none |
| A2 | Rendering | Always render with the shipped template through `apply_chat_template` and never hand-build prompts ([prompting#chat-template][p-template]) | Training text goes through the model's own template (`glimmer.ts:1122-1143`). Eval and the live demo add ` to=user<\|message\|>` after the generation prompt (`glimmer.ts:106-110, 1146-1153`, `serve.ts:428-443`) | partly | trainChannel 1 drops the forced channel for new adapters (S, needs a test run). Decide mode keeps it on purpose |
| A3 | Reasoning traces | Put the trace in `reasoning_content`. Answer-only targets "may suppress" chain-of-thought ([post-training#trl-sft-prepare-data][pt-trl-data]) | No row has `reasoning_content`. Loss covers only `ANSWER<\|eot\|>` after `RESPONSE_PART` (`glimmer.ts:101-110, 1365`) | not aligned | Mix in reasoning rows with whole-turn labels, and label the `to=user` header on plain rows (L, needs a test run). See fix N1 |
| A4 | Reasoning strength | Levels low to xhigh, default high, cannot be turned off ([prompting#reasoning][p-reasoning]). Meta's own `llama serve` example passes low ([deploy#llama-cpp-server][d-llama-server]) | Low in training text and eval (`glimmer.ts:116-118`) and in the GGUF channel check (`quantize.ts:832-841`). Cards tell local apps to set low (`hub-cards.ts:1654, 1717`) | aligned | none. Keep training and serving at the same strength |
| A5 | System prompt | Put a system prompt in every example for a steady persona ([post-training#trl-sft-prepare-data][pt-trl-data]). With a system message, the template drops the cutoff and date lines ([prompting#system-prompts][p-system]) | Every row has a system message: the short role line by default, or the task prompt (`glimmer.ts:248-285`) | aligned | none |
| A6 | Data volume | About 500 or more good examples for real adaptation, 5,000 to 10,000 or more for strong domain work ([post-training#trl-sft-prepare-data][pt-trl-data]) | 20 to 1,000 examples a dataset (`logic.ts:428-429`) | partly | A hint under 500 in the dataset form and in TRAINING.md (XS, safe now) |
| A7 | Mixing | Mix datasets only with a sampling policy and a held-out eval for each part, and change one thing at a time ([post-training#axolotl-prepare-your-data][pt-ax-data]) | One dataset a job | aligned | none |
| A8 | Sequence length | Start short and set it from the data. Meta measured with a 4,096-token limit ([post-training#trl-sft-hyperparameters][pt-trl-hp], [post-training#axolotl-results][pt-ax-results]) | `MAX_SEQ_LENGTH` 2,048 (`glimmer.ts:119`). Answers are capped near 4,000 characters (`docs/TRAINING.md:368-369`) | aligned | Raise to 4,096 when reasoning rows land (XS, part of N1) |
| A9 | Packing | Keep sample packing off ([post-training#axolotl-prepare-your-data][pt-ax-data]) | `SFTConfig` leaves `packing` unset (`glimmer.ts:1345-1363`). TRL 0.22.2's default is believed to be off, but that wasn't checked | likely aligned | Set `packing=False` explicitly (XS, safe now, no behavior change) |
| A10 | Loss masking | Meta's Axolotl configs train assistant turns only and train the end-of-turn token (cookbook configs, linked from [post-training#axolotl-links][pt-ax-links]) | `train_on_responses_only` covers the answer and `<\|eot\|>`, and `check_masking` checks it (`glimmer.ts:1174-1202, 1365-1371`) | aligned for answer-only rows | With reasoning rows, labels run from `to=self` through the answer (part of N1) |

### B. LoRA and optimizer

Meta gives two sources that disagree:

- **Measured:** the Axolotl configs, linked from [post-training#axolotl-links][pt-ax-links]. They use r 32, alpha 16,
  dropout 0.05, attention plus MLP, 1 epoch, a cosine schedule and warmup 0.1.
- **Unmeasured:** the TRL example at [post-training#trl-sft-lora][pt-trl-lora]. It uses r 16, alpha 32, q/k/v/o
  only, 3 epochs.

| # | Area | What Meta says | What we do | Status | Fix (size, kind) |
|---|---|---|---|---|---|
| B1 | Method | QLoRA first. Then LoRA, and full fine-tuning only when an eval shows adapters are the limit ([post-training#hardware][pt-hw]) | QLoRA on `unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit` (`glimmer.ts:39-41`) | aligned | none |
| B2 | Targets | Language-model attention and MLP projections, with the vision tower frozen (Axolotl configs) | `finetune_language_layers`, attention and MLP on, vision off (`glimmer.ts:1249-1254`) | aligned | Read the real `adapter_config.json` on the next run to confirm the module list (XS) |
| B3 | Rank | r 8 to 32 ([post-training#trl-sft-hyperparameters][pt-trl-hp]) | Default 16, allowed range 4 to 128 (`glimmer.ts:168`) | aligned | Cap the range at 64. That is Fireworks' import limit and Baseten's default (XS, safe now, default unchanged) |
| B4 | Alpha | Axolotl uses alpha = r/2. TRL uses 2x rank | alpha = r (`glimmer.ts:1256`), between Meta's two sources | partly | None now. Try it as one A/B arm later (N5) |
| B5 | Dropout | 0.05 in both sources | 0 (`glimmer.ts:1257`), as in Unsloth's notebook | partly | A/B arm (N5, needs a test run) |
| B6 | Learning rate | 2e-4 for QLoRA. The TRL range is 1e-4 to 3e-4 | 2e-4 default (`glimmer.ts:167`) | aligned | none |
| B7 | Schedule | Cosine with warmup ratio 0.1 (Axolotl) | Linear schedule with 5 warmup steps (`glimmer.ts:1352, 1358`) | partly | A/B arm (N5) |
| B8 | Batch | Effective 4 to 16 ([post-training#trl-sft-hyperparameters][pt-trl-hp]) | 1 x 4 = 4 (`glimmer.ts:1350-1351`) | aligned, at the floor | none |
| B9 | Length of training | Axolotl runs 1 epoch. The TRL range is 2 to 5 epochs | 120 steps by default (`glimmer.ts:166`): 1.2 epochs on 400 rows, 0.48 on 1,000, 4.8 on 100 | partly | Base the default steps on dataset size, aiming for 1 to 2 epochs (S, needs a test run, N3) |
| B10 | Optimizer | 8-bit Adam for QLoRA, weight decay 0 (Axolotl) | `adamw_8bit`, weight decay 0.001 (`glimmer.ts:1356-1357`) | aligned | none |
| B11 | Precision | bf16 compute ([post-training#axolotl][pt-ax]) | Not set. Unsloth picks the compute dtype (`glimmer.ts:1345-1363`) | likely aligned | Log the dtype in metrics (XS, safe now) |
| B12 | Memory | Size for the second optimizer step ([post-training#hardware][pt-hw]) | At least 10 steps (`glimmer.ts:166`). Peak VRAM is logged (`glimmer.ts:1395`) | aligned | none |

### C. Software and hardware

| # | Area | What Meta says | What we do | Status | Fix (size, kind) |
|---|---|---|---|---|---|
| C1 | Trainer and pins | Axolotl 0.19.0, torch 2.12.1 on CUDA 13.0, transformers 5.15 or newer, Hopper builds ([post-training#axolotl-install][pt-ax-install]) | Unsloth 2026.10.9, torch 2.11.0 cu128, transformers 5.15.0, TRL 0.22.2 (`glimmer.ts:42-58`) | partly, on purpose | none (see D2 under "Deliberate differences") |
| C2 | Model revision | Pin it. Meta's Axolotl recipe pins `a4e59da5` ([post-training#axolotl][pt-ax]) | Pinned: Unsloth 4-bit at `ecedda39` (`glimmer.ts:41`), Meta template and tokenizer at `cec94fcf` (`quantize.ts:103`) | partly | One free Hub read comparing `chat_template.jinja` and `generation_config.json` at `cec94fcf` and `a4e59da5` (XS, safe now) |
| C3 | Training hardware | Verified on 8x H100, and QLoRA also on 1x H100 ([post-training#axolotl][pt-ax]) | 1x A100 40 GB by default, then H100 (`recipes/index.ts:19-23`). Measured at 42 to 47 min and $1.39 to $1.59 (`docs/VIBE_TUNING.md:60`). QLoRA peak 25.5 GB (KRL:112) | partly, measured | none |
| C4 | Serving hardware page | Lists only bf16 rows: Intel Arc Pro B70 x2, Xeon 6, and NVIDIA B300 at driver 580 or newer for CUDA 13 ([hardware-platforms#intel][hw-intel], [hardware-platforms#nvidia-b300][hw-b300]) | We train and serve on A100 and H100, which the page doesn't list | n/a | The smoke recipe already records the GPU's driver version (`recipes/smoke.ts:30-40`). Run it on each new host (see TRAIN_BACKENDS.md) |

### D. Evaluation

| # | Area | What Meta says | What we do | Status | Fix (size, kind) |
|---|---|---|---|---|---|
| D1 | Held-out set | Compare the tuned model against the base on held-out data ([post-training#trl-sft-evaluate][pt-trl-eval]) | 10% held out (8 to 40 items), near-duplicates kept out of training (`logic.ts:436-447, 488`). Base answers first, then tuned (`glimmer.ts:1272-1311, 1413-1415`) | aligned | none |
| D2 | Matched base | Meta's cookbook compares QLoRA against a 4-bit base (cookbook README, linked from [post-training#axolotl-links][pt-ax-links]) | The same 4-bit base answers with the new LoRA adding zero | aligned | none |
| D3 | Eval decoding | The TRL eval samples at temperature 1.0 and top_p 0.95 ([post-training#trl-sft-evaluate][pt-trl-eval]). Meta's cookbook held-out check uses greedy decoding for reproducible comparison (cookbook README, linked from [post-training#axolotl-links][pt-ax-links]) | Greedy, 1,024 new tokens (`glimmer.ts:120, 1288-1294`) | aligned with the cookbook, on purpose | Keep greedy. Say so on every card (F1) |
| D4 | Hitting the cap | Count an answer that hits the cap as a failure, not as dropped (cookbook README) | An unfinished answer goes to the judge marked `[Unfinished ...]` (`glimmer.ts:1102-1119`) | aligned | Also count final answers closed by `<\|eom\|>`, which is a format drift (XS, safe now) |
| D5 | General capability | Track the task metric and a general benchmark. If general capability drops, cut epochs or LR, or add diverse data ([post-training#trl-sft-evaluate][pt-trl-eval]) | Task judge only (`judge.ts:9-10, 41, 59`) | not aligned | A fixed set of 40 old facts, base and tuned, as the knowledge run used (M, needs a run to calibrate, N4) |
| D6 | Room for reasoning | Leave generous `max_tokens` and check per-slot context. A slot that runs out fails quietly ([deploy#llama-cpp-context-per-slot][d-llama-slot]) | Fine for trainChannel 0. The GGUF check runs `-c 8192 -np 4`, which is 2,048 tokens a slot (`quantize.ts:163-166`) | partly | For trainChannel 1 and reasoning rows: 4,096 new tokens and `-np 1` or a larger `-c` (S, part of N1) |

### E. Merge, export and quantization

| # | Area | What Meta says | What we do | Status | Fix (size, kind) |
|---|---|---|---|---|---|
| E1 | Merge | Merge into the bf16 base. Any runtime can then serve it ([post-training#trl-sft-merge-adapters][pt-trl-merge]) | Unsloth `merged_16bit` into the 16-bit base, with shards checked against Meta's SHA-256. It never merges into 4-bit (`quantize.ts:126-136, 1138-1170`) | aligned | none |
| E2 | Merged checkpoint | The merged model is what other runtimes load ([post-training#trl-sft-merge-adapters][pt-trl-merge]) | The merged BF16 is built, then deleted once nothing needs it (`quantize.ts:23`). Only GGUFs are published (`quantize.ts:1096-1116`) | partly | An optional merged BF16 repo for hosted serving (M, owner decision, see TRAIN_BACKENDS.md) |
| E3 | generation_config | Ship `eos_token_id` [200001, 200008] and never include `<\|eom\|>` ([deploy#vllm-stop-tokens][d-vllm-stop]) | Meta's file at `cec94fcf` goes into the merged folder (`quantize.ts:98-112`). Adapter repos ship none (`types.ts:516-531`), so loaders use the base repo's file | partly | Read the Unsloth repo's `generation_config.json` at `ecedda39` to check its eos list (XS, safe now) |
| E4 | llama.cpp version | b10353 or newer ([quantization#run][q-run]) | b11669 (`quantize.ts:74-80`) | aligned | none |
| E5 | Quantizing it yourself | `convert_hf_to_gguf --outtype bf16`, then `llama-quantize` Q4_K_M, then check perplexity against full precision and on your own workload ([quantization#quantize-yourself][q-diy]) | The same steps (`quantize.ts:1002-1026`). The gate is mean KL against Q8_0 on held-out text (`quantize.ts:58-60, 1028-1056`) | aligned | Also log wikitext-2 perplexity so our numbers compare to Meta's (S, next quantize run, N6) |
| E6 | Shipped mixes | Meta's Q4_K_M uses a custom mix, and Q4_K_XL is a larger, higher-quality option ([quantization#checkpoints][q-ckpt]) | Stock Q3_K_M, Q4_K_M and Q6_K, no imatrix (`quantize.ts:58`) | partly | None needed. Our gate decides what ships |
| E7 | Template in GGUF | Don't pass `--chat-template-file`, because the embedded template is Meta's own ([deploy#llama-cpp-server][d-llama-server]) | Every GGUF must carry Meta's template (`quantize.ts:678`). trainChannel 0 cards add `tuned.jinja` (`hub-cards.ts:1639-1640`, `quantize.ts:1064-1066`) | aligned for trainChannel 1, not for trainChannel 0 | Goes away when trainChannel 1 is the default (N1). Until then, see the deliberate differences |
| E8 | Context | Native context is 131,072. KQuant-17GB at full context with the projector measures 19.0 GiB ([quantization#memory-budget][q-mem]) | Cards and Ollama use 8,192 (`hub-cards.ts:1391, 1416, 1639`) | partly | Cards say 8,192 suits small machines and final answers, and that Meta's full context fits in about 19 GiB (XS, safe now) |
| E9 | Vision | The mmproj file is needed for images ([quantization#checkpoints][q-ckpt]) | Text-only files with `--no-mmproj`. The vision tower is untouched | n/a | Meta's mmproj may work with our GGUFs, but this is untested (KRL, "Open"). Don't claim it |

### F. Serving and local use

| # | Area | What Meta says | What we do | Status | Fix (size, kind) |
|---|---|---|---|---|---|
| F1 | Sampling | Temperature 1.0, top_p 0.95, top_k 64. "Don't run this model greedy." If you set sampling, send all three ([deploy#vllm-sampling][d-vllm-samp], [prompting#temperature-and-sampling][p-sampling]). Greedy decoding loops ([deploy#together-ai-behavior][d-together]) | Temperature 0 in Ollama params, the Modelfile, LM Studio advice and the card text (`hub-cards.ts:1391, 1415, 1654, 1717`, `quantize.ts:380`). The run-locally snippet uses `do_sample=False` (`hub-cards.ts:684`) | not aligned | The agreed change, fix S1 (S, safe now) |
| F2 | Stop tokens | Stop only on 200001 and 200008, never on `<\|eom\|>` (200007) ([deploy#vllm-stop-tokens][d-vllm-stop], [deploy#llama-cpp-stop-tokens][d-llama-stop], [hardware-platforms#troubleshooting][hw-trouble]) | trainChannel 1 already matches (`hub-cards.ts:1386`, `quantize.ts:180`). trainChannel 0 adds `<\|eom\|>` and `<\|start\|>` (`quantize.ts:171, 181`, `hub-cards.ts:1386, 1668`). `FINAL_ENDS` in eval is a parse cut, not a runtime stop (`glimmer.ts:112`) | partly, on purpose | Keep them for trainChannel 0 only, with a sentence on the card saying why (part of S1) |
| F3 | Server | vLLM in Docker with the `muse_glimmer` parsers and `--generation-config auto`. bf16 needs about 72 GB to serve ([deploy#vllm][d-vllm], [deploy#run-inference][d-run]) | The live demo runs Unsloth 4-bit plus PEFT in its own HTTPS server (`serve.ts:853-866`), with base and tuned in one process (`serve.ts:465`) | partly, on purpose | Hosted serving on another provider uses Meta's vLLM image on a merged BF16 (TRAIN_BACKENDS.md) |
| F4 | Live demo decoding | Same as F1 | Greedy, 400 new tokens (`serve.ts:40, 87, 455`) | not aligned | Owner decision O3: Meta's sampling by default, with a "same as eval" greedy switch (S, check on the first real serve run) |
| F5 | Serving LoRA | Not covered. The documented path is merge, then serve ([post-training#trl-sft-merge-adapters][pt-trl-merge]) | PEFT in the demo, merged GGUF for local use | n/a | none |
| F6 | DFlash drafter | Meta's drafter files ([spec-decode][spec]). Meta doesn't say whether they work on tuned targets | Measured on a tuned Q4_K_M: 1.39x at 47% acceptance. No drafter by default (KRL:818-828) | aligned, measured | none |

### G. Data use

| # | Area | What Meta says | What we do | Status | Fix (size, kind) |
|---|---|---|---|---|---|
| G1 | Adapters and data | Check licenses, consent and privacy in the training data. Meta keeps adapter uploads to W&B off by default, because adapters can encode private data (cookbook README, linked from [post-training#axolotl-links][pt-ax-links]) | Lab data is written by a model from the admin's task. Repos go public once verified unless `HF_PUBLIC` is off (`docs/TRAINING.md:605`) | partly | Owner decision O6 (XS) |

## Fixes in priority order

### Safe now

These change docs, cards or defaults only. Everything in `lib/train` waits for `tg-decide` to land.

**S1. Sampling and stops on every card (the agreed item, S).**

- Cards recommend Meta's sampling: temperature 1.0, top_p 0.95, top_k 64, all three sent together.
- Cards say the eval was greedy so that base and tuned compare like for like, and that greedy isn't a serving setting.
- The eval itself stays greedy (`glimmer.ts:1292`).
- `<|eom|>` and `<|start|>` stops stay only for trainChannel 0. The card gives the reason: that adapter answers inside
  a final channel that `tuned.jinja` opens, so the answer ends where its message ends.

Files:

- `hub-cards.ts:1389-1418`: the Ollama params and the Modelfile.
- `hub-cards.ts:1654`: LM Studio advice (Temperature 1.0, Top P 0.95, Top K 64).
- `hub-cards.ts:1717`: the card text.
- `hub-cards.ts:684`: the run-locally snippet. Use `do_sample=True` with the three values, and keep a greedy line
  "to reproduce the eval".
- `quantize.ts:377-380`: `params_file`.

`ggufSmallProblem` compares the params file byte for byte (`hub-cards.ts:1434`), so `params_file` and `ggufParams` must
change together, and so must `gguf-cards.test.ts`.

Rewriting cards already on Hugging Face is owner decision O2.

**S2. Context advice (XS).** Cards keep `-c 8192`. Add one line: it suits small machines and final answers, and
Meta's full 131,072-token context fits in about 19 GiB with Q4_K_M ([quantization#memory-budget][q-mem]).

**S3. Free checks, no GPU (XS):**

- Compare `chat_template.jinja` and `generation_config.json` at `cec94fcf` and at Meta's Axolotl pin `a4e59da5` (C2).
- Read the Unsloth 4-bit repo's eos list at `ecedda39` (E3).

**S4. Small default and limit changes (XS each):**

- Explicit `packing=False` (A9).
- Log the compute dtype (B11).
- Cap `loraRank` at 64 (B3).
- A dataset-size hint under 500 rows (A6).
- Count final answers closed by `<|eom|>` (D4).

**S5. TRAINING.md (XS).** A short "How this differs from Meta's recipe" section that links here.

### Needs a test run

Each run is a Lambda A100 job of about 47 minutes, about $1.59 (`docs/VIBE_TUNING.md:60`). Each needs the owner's
OK, and none has been run.

**N1. Keep the reasoning channel (L, highest value).**

- Make trainChannel 1 the default. Its design is in `docs/VIBE_TUNING.md:223-230`. It labels the ` to=user<|message|>`
  header, so the model learns to open its answer itself.
- Mix in reasoning rows with labels from `to=self` through the answer.
- Raise `MAX_SEQ_LENGTH` to 4,096 and the eval budget to 4,096 tokens.

Why: the knowledge run measured both the break and the repair.

- **The break:** answer-only labels took P("=self") from 0.99999 to 0.21, and well-formed outputs from 257 to 40 of
  260 (KRL:513-522).
- **The repair:** 30% reasoning rows with whole-turn labels brought them back to 257 of 260 (base 259) and 0.999998
  (KRL:743-744).
- **What it didn't fix:** plain rows still skipped the header with reasoning on, because they had no header labels
  (KRL:745-748). trainChannel 1 adds those labels.

The dataset generator also needs a trace for each reasoning row: the teacher's own, or base Glimmer's at the same
strength.

Test: one run, plus the knowledge run's channel check (`scripts/knowledge/aws/job/score_reasoning.py`) on the adapter.

**N2. Retire `tuned.jinja` for new adapters (S, after N1).** New cards drop `--chat-template-file`, `--reasoning off`
and the extra stops (E7, F2). Old adapters keep them.

**N3. Default steps from dataset size, aiming for 1 to 2 epochs (S, B9).** Test with one run on a 400-row set and one
on a 1,000-row set.

**N4. General-capability check in the eval (M, D5).** It doesn't change the model, but it changes the verdict. Calibrate
the threshold on one run.

**N5. One-axis A/B arms, low priority:** dropout 0.05 (B5), then cosine with warmup 0.1 (B7), then alpha (B4). One run
each, kept only if the judge and N4 both hold.

**N6. Wikitext-2 perplexity next to the KL gate (S, E5).** It goes on the first real quantize run. No real GPU has run
`QUANT_PY` yet (`docs/TRAINING.md:770`).

**N7. Live demo sampling (S, F4).** Owner decision O3. Check it on the first real serve run, since `glimmer-serve` has
never run on a GPU (`docs/TRAINING.md:557-559`).

## Deliberate differences

Each one is kept on purpose, and the reason comes from our own measurements or constraints.

- **Greedy eval (D3).** We need a fixed, repeatable before and after. Meta's cookbook makes its held-out check greedy
  for the same reason. Our knowledge run says every one of its numbers was greedy and counts only as a comparison
  (KRL:770). The cards must say so (S1).
- **Forced final channel and the extra stops, for trainChannel 0 and decide mode only (A2, E7, F2).**
  - These adapters were trained to answer inside an open `to=user` message and never to open it themselves.
  - Our measurement shows that serving answer-only tuning with reasoning on breaks the format (KRL:513-522). For
    these models, forcing the channel is the safe path, not a bug.
  - Decide mode reads one letter's probability from one forward pass (tg-decide `docs/DECISION_MODELS.md` section 1),
    so sampling doesn't apply to it.
  - New chat adapters should move to N1 instead.
- **Low reasoning strength (A4).** Meta allows it, uses it in its own `llama serve` example
  ([deploy#llama-cpp-server][d-llama-server]), and [Axolotl's Glimmer guide][axolotl-guide] asks only that training
  and serving match. They do. The knowledge run found that forcing reasoning on a model that learned a behavior only in
  direct answers made it worse: honest answers fell from 51 to 28 of 64 (KRL:756-758). Train and serve at the same
  strength.
- **Unsloth on one 40 GB A100, with torch 2.11 on cu128 (C1, C3).**
  - It is measured: 47 minutes for $1.59 (`docs/VIBE_TUNING.md:60`).
  - Meta's stack is pinned to CUDA 13.0, which needs NVIDIA driver 580 or newer
    ([hardware-platforms#nvidia-b300][hw-b300]). None of the provider pages we read states that driver on their H100s.
  - cu128 wheels run on older drivers, which keeps the recipe portable (see TRAIN_BACKENDS.md).
  - Axolotl is worth adding only for multi-GPU runs.
- **8,192-token local context (E8).** Final answers need far less, and the setting saves memory on small machines.
  The cards say how to use the full context (S2).

## What our measurements don't support

The **1-bit loops** don't argue against Meta's sampling.

- Every knowledge-run score was decoded greedily (temperature 0, top_k 1). Examples:
  `scripts/knowledge/aws/job/score_gguf.py:117`, `score_reasoning.py:564`, `score_honesty.py:248`.
- The loops showed up under that greedy decoding:
  - Base IQ1_S ran to the cap repeating on 1,457 of 1,500 probes (KRL:408-410), and 177 of 190 honesty replies hit the
    cap (KRL:473).
  - r30's IQ1_S looped on 10 of 60 replies (KRL:826).
- Meta names greedy decoding as a cause of looping ([deploy#together-ai-behavior][d-together]).

So part of those loops may come from greedy decoding, not only from 1-bit quantizing. The knowledge run already plans a
loop check on the final IQ1_S, both greedy and with Meta's sampling (KRL:826-827). Until that check runs, don't
describe IQ1_S loops as a quantizing result alone. The base-versus-tuned comparisons still hold.

## Gaps in this check

- The exact LoRA module list Unsloth produces wasn't read from a real `adapter_config.json` (B2).
- TRL 0.22.2's packing default and Unsloth's compute dtype were inferred, not checked (A9, B11).
- Whether Unsloth's own kernels have the gated-attention problem Meta's cookbook reports for Axolotl's fused LoRA
  kernels is unknown. Our measured runs gave no sign of it, but no loss-parity test was done.
- Meta's main revision may have moved since `cec94fcf`. That wasn't checked (S3 checks it).
- The dev.meta.ai pages are summarized here in our words. The mirror can lag behind the live pages.

[pt-hw]: https://dev.meta.ai/docs/muse-glimmer/post-training#hardware
[pt-ax]: https://dev.meta.ai/docs/muse-glimmer/post-training#axolotl
[pt-ax-links]: https://dev.meta.ai/docs/muse-glimmer/post-training#axolotl-links
[pt-ax-install]: https://dev.meta.ai/docs/muse-glimmer/post-training#axolotl-install
[pt-ax-data]: https://dev.meta.ai/docs/muse-glimmer/post-training#axolotl-prepare-your-data
[pt-ax-results]: https://dev.meta.ai/docs/muse-glimmer/post-training#axolotl-results
[pt-trl-data]: https://dev.meta.ai/docs/muse-glimmer/post-training#trl-sft-prepare-data
[pt-trl-lora]: https://dev.meta.ai/docs/muse-glimmer/post-training#trl-sft-lora
[pt-trl-hp]: https://dev.meta.ai/docs/muse-glimmer/post-training#trl-sft-hyperparameters
[pt-trl-eval]: https://dev.meta.ai/docs/muse-glimmer/post-training#trl-sft-evaluate
[pt-trl-merge]: https://dev.meta.ai/docs/muse-glimmer/post-training#trl-sft-merge-adapters
[pt-rl]: https://dev.meta.ai/docs/muse-glimmer/post-training#rl
[q-ckpt]: https://dev.meta.ai/docs/muse-glimmer/quantization#checkpoints
[q-run]: https://dev.meta.ai/docs/muse-glimmer/quantization#run
[q-mem]: https://dev.meta.ai/docs/muse-glimmer/quantization#memory-budget
[q-diy]: https://dev.meta.ai/docs/muse-glimmer/quantization#quantize-yourself
[d-run]: https://dev.meta.ai/docs/muse-glimmer/deploy#run-inference
[d-vllm]: https://dev.meta.ai/docs/muse-glimmer/deploy#vllm
[d-vllm-samp]: https://dev.meta.ai/docs/muse-glimmer/deploy#vllm-sampling
[d-vllm-stop]: https://dev.meta.ai/docs/muse-glimmer/deploy#vllm-stop-tokens
[d-llama-server]: https://dev.meta.ai/docs/muse-glimmer/deploy#llama-cpp-server
[d-llama-slot]: https://dev.meta.ai/docs/muse-glimmer/deploy#llama-cpp-context-per-slot
[d-llama-stop]: https://dev.meta.ai/docs/muse-glimmer/deploy#llama-cpp-stop-tokens
[d-together]: https://dev.meta.ai/docs/muse-glimmer/deploy#together-ai-behavior
[hw-intel]: https://dev.meta.ai/docs/muse-glimmer/hardware-platforms#intel
[hw-b300]: https://dev.meta.ai/docs/muse-glimmer/hardware-platforms#nvidia-b300
[hw-trouble]: https://dev.meta.ai/docs/muse-glimmer/hardware-platforms#troubleshooting
[p-template]: https://dev.meta.ai/docs/muse-glimmer/prompting#chat-template
[p-system]: https://dev.meta.ai/docs/muse-glimmer/prompting#system-prompts
[p-reasoning]: https://dev.meta.ai/docs/muse-glimmer/prompting#reasoning
[p-sampling]: https://dev.meta.ai/docs/muse-glimmer/prompting#temperature-and-sampling
[spec]: https://dev.meta.ai/docs/muse-glimmer/spec-decode
[axolotl-guide]: https://docs.axolotl.ai/docs/models/muse-glimmer.html
