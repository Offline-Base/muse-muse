# Cloud scripts

Two Modal jobs that need a GPU this laptop does not have. **Both cost money and need Ethan's go-ahead before every `--run`.** Neither has been run yet. Each has a `--check` mode that validates its inputs on the laptop with no network and no compute, and `--help` works without Modal installed.

| Script | What it does | GPU | Estimated time | Estimated cost |
|---|---|---|---|---|
| `quant_eval_modal.py` | Builds llama.cpp b10353 with CUDA, downloads Meta's Q4_K_M and mradermacher's i1-IQ1_S and i1-IQ1_M, runs three jobs on each, writes `eval/reports/quantization.md` | 1x L40S (48 GB) | 1 to 2 hours, plus about 20 minutes of one-time image build | about $2 to $5 |
| `train_lora_modal.py` | QLoRA on Glimmer from dreaming's training JSONL (transformers + peft, 4-bit base), then llama.cpp's `convert_lora_to_gguf.py`; writes the adapter `.gguf` to `BASE_HOME/adapters/router-candidate.gguf` | 1x H100 (80 GB) | 1.5 to 3 hours for about 2,000 examples and 2 epochs, including the base model download | about $6 to $12 |

The estimates assume Modal's list prices at the time of writing (roughly $2 per hour for an L40S and $4 per hour for an H100) and a 30B model; check current pricing before a run. Downloads go to a Modal volume (`muse-privacy-hf-cache`), so a second run skips them. The volume holds about 31 GB for the eval and about 60 GB for the bf16 base weights.

## Before a run

1. Ethan says yes, for this run.
2. A Modal account and token: `uv run --with modal modal token new`.
3. A Modal secret named `huggingface` holding `HF_TOKEN`, for repos that need a login: `uv run --with modal modal secret create huggingface HF_TOKEN=...`. Never paste the token into a file in this repo.
4. `--check` passes.

Modal is not a project dependency. Both scripts load it only for `--run`, so use `uv run --with modal`.

## Quantization eval

```
uv run python scripts/cloud/quant_eval_modal.py --check
uv run --with modal python scripts/cloud/quant_eval_modal.py --run
```

The three jobs, run on each model with temperature 0 and reasoning strength low:

1. **Names**: list the person names in 20 essays from the demo folder; recall is scored against the roster names that appear in each essay.
2. **Lookups**: 20 routing decisions on `eval/tasks.jsonl` items, 5 per expected decision, with each item's names replaced by tags first; scored against `expected`. The user policy goes in the system prompt.
3. **Grading**: grade 10 essays with the folder's `rubric.md`; the IQ1 totals are compared with the Q4_K_M totals (exact match rate and mean difference).

The report lists file size, prompt and generation tokens per second (from llama-server's timings), the three scores and JSON failures per model, with the command at the top. Raw results go to `eval/reports/raw/quantization.json`. Tokens per second are on the cloud GPU and say nothing about Jetson speed; Jetson numbers have to come from a board.

Only an essay folder with a `.synthetic` marker is sent. The roster stays on the laptop; only the expected names per essay go up for scoring. `--essays`, `--roster`, `--tasks`, `--policy` and `--q4-repo` override the defaults. The Q4_K_M file comes from `meta-models/Muse-Glimmer-30B-GGUF`, the 1-bit files from `mradermacher/Muse-Glimmer-30B-i1-GGUF`.

## Router LoRA

```
uv run python scripts/cloud/train_lora_modal.py --check --data ~/.base/adapters/train-<date>.jsonl
uv run --with modal python scripts/cloud/train_lora_modal.py --run --data ~/.base/adapters/train-<date>.jsonl
```

Each line is either `{"messages": [...], "weight": 3}` ending with the assistant's JSON decision, or a dreaming example `{"request", "result_kind", "tagged_text", "label", "weight"}`. The `messages` form is better, because it can use the router's exact prompt.

Dreaming's lora backend (`base/dreaming/train.py`) writes the training file to `BASE_HOME/adapters/train-<date>.jsonl`. It holds tagged text and requests only from decisions the user approved: for every other row both are replaced with a fixed "withheld" line, and any row that still names someone after tagging is left out. `--check` and `--run` decode each line and refuse the file if it holds an email, phone number, SSN or card number (in any dash style), a roster name in any case, or anything `base.guard.leaks` finds with the roster and the device's tag map (`--tagmap`, default `BASE_HOME/tagmap.json`). Even so, sending real decision rows to the cloud is a separate call for Ethan to make; the default today is the prompt backend, which trains nothing in the cloud.

Training examples are built from Glimmer's own chat template, so the adapter learns the same answer header and end token llama-server parses, and only the language model's attention layers get adapters (not the vision tower). The training packages (torch, transformers, peft, bitsandbytes) are not pinned yet: the base model records a transformers development version, so pin the versions that load it on the first paid smoke run.

The adapter comes back as `router-candidate.gguf`. Nothing gates it yet: `base/dreaming/gate.py` compares rule files only, and a night with the lora backend keeps the current rules. Before using an adapter, score it with `eval.run_eval --holdout` against a llama-server that loads it on the same IQ1_S file the Jetson runs, and promote it to `router.gguf` by hand only if accuracy, agreement and zero leaks hold. On a Jetson, install it with `deploy/jetson/adapter_sync.sh`.

Defaults: rank 16, alpha 32, dropout 0.05, attention projections, learning rate 2e-4, gradient accumulation 8, max length 2048, 2 epochs, examples weighted by their `weight`. `--base-model` names the bf16 Hugging Face repo (default `meta-models/Muse-Glimmer-30B`), and `--trust-remote-code` is off unless you pass it.
