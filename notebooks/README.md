# Edge tune on a free GPU

`edge-tune-kaggle.ipynb` tunes Llama 3.2 3B Instruct for the Simulated cold-room drill on Kaggle's free T4 (or Colab's free T4), so the edge tune (docs/EDGE_PLAN.md, M8) doesn't need a rented GPU. It scores the base and the tuned model on the 100 sealed held-out rows with drill-bench's own scorer, then exports a Q4_K_M GGUF with its sha256 for `gguf-serve.sh`.

**Status:** built and checked without a GPU: the notebook is valid nbformat JSON, every code cell parses, and the scoring cell runs against small fake answer files with no model (`test_edge_tune_notebook.py`). It has not run on a GPU, on Kaggle or on Colab yet. Every time below is an estimate. Until it runs, say the tune "is built so" it runs on a free T4, and give no score.

| File | What |
|---|---|
| `edge-tune-kaggle.ipynb` | The notebook. Generated: edit `build_notebook.py`, not the .ipynb |
| `build_notebook.py` | The cells as plain Python. `python3 -I notebooks/build_notebook.py` rewrites the notebook; `--check` says if they differ |
| `test_edge_tune_notebook.py` | The no-GPU checks |

## 1. Make the data (on the laptop, a few seconds, no network)

`sealed.jsonl` is in git. `train.jsonl` and `dev.jsonl` are not (`eval/drill/.gitignore`), so make them. The same seed gives the same bytes, so rewriting the committed `sealed.jsonl` leaves git clean.

```
python3 scripts/dev/drill-bench.py make --out eval/drill
mkdir -p ~/cold-room-drill
cp eval/drill/train.jsonl eval/drill/dev.jsonl eval/drill/sealed.jsonl scripts/dev/drill-bench.py ~/cold-room-drill/
shasum -a 256 ~/cold-room-drill/*
```

The hashes must be:

| File | sha256 |
|---|---|
| `sealed.jsonl` | `52b23493d1f832aebf717829469091ded8029b77fc82b517544746c94346f3dd` (pinned in the script and the notebook; any other hash stops the run) |
| `train.jsonl` | `0fb64c3cb5058d54811c2134dc4c6cd67b656c681a8d0075406b9532e1f26238` |
| `dev.jsonl` | `90653359d9ec97340421f29a317c71165429248a6c18363ba16817274f512915` |
| `drill-bench.py` | `ed3672b5bba9ddfa07e4ebed06eac9ed1c3b976e766b0e250896dcb3842e2499` (at e4beadc1; a different one only prints a note) |

Checked on Nov 2 from e4beadc1: `make` printed these three data hashes. Upload exactly these four files. Don't upload `folder/`: those rows have no system line, so training on them wouldn't match how drill-bench asks. The notebook checks every training row carries drill-bench's `SYSTEM` line verbatim and stops if one doesn't.

## 2. Upload them as a Kaggle dataset

On kaggle.com: Datasets, New Dataset, drop the four files from `~/cold-room-drill`, title `cold-room-drill`, keep it **Private**, Create. All four are Simulated rows written by code, about 3.2 MB.

## 3. Run it on Kaggle

1. New Notebook, then File, Import Notebook, and pick `notebooks/edge-tune-kaggle.ipynb`.
2. Add Input: your `cold-room-drill` dataset. The notebook finds it under `/kaggle/input` on its own.
3. Settings: Accelerator **GPU T4 x2** (it trains on the first card), Internet **on** (needed to install packages and download the model; Kaggle asks for a verified phone number for this).
4. Run all, or better, Save Version with "Save & Run All (Commit)", which runs to the end with the browser closed. Outputs land in `/kaggle/working`, under the version's Output tab.

No Hugging Face token is needed: the base model is ungated. Leave Kaggle Secrets empty unless you turn on the upload (section 6).

**Colab instead:** Runtime, Change runtime type, T4 GPU. Upload the four files to `/content/drill` (or set `DRILL_DATA` to their folder). Outputs go to `/content/edge-tune-out`. A free Colab session can drop; the answer files are written as they come, and after a restart the scoring cell reruns from them once the settings and helpers cells have run (a dropped answer run starts over, it doesn't resume).

## What it does

| Step | Cell | Estimate on one T4 |
|---|---|---|
| Install the pinned packages (torch reinstall about 2.5 GB) | `install` | 4 to 10 min |
| Check data hashes, the system line on all 900 rows, no sealed prompt in training | `data` | seconds |
| Load the 4-bit model (about 2.3 GB) and a rank-16 LoRA, fp16 | `model` | 2 to 4 min |
| Base answers, 100 sealed rows, one at a time, greedy (temperature 0), at most 200 new tokens | `base-answers` | 5 to 12 min |
| QLoRA on 900 rows, 2 epochs = about 225 steps of 8 rows (rows run about 1,000 to 1,300 tokens), answers only, eval loss on the 50 dev rows | `train` | 30 to 60 min (about half with `EPOCHS = 1`) |
| Tuned answers, same 100 rows, same prompt | `tuned-answers` | 5 to 12 min |
| Score and write `scores.json` (no GPU) | `score` | seconds |
| Merge, build llama.cpp, write the Q4_K_M GGUF (about 2 GB) and its sha256, fetch the license files | `export` | 10 to 25 min |
| Write `MODEL_CARD.md` from this run's numbers | `card` | seconds |
| Upload to Hugging Face, off by default | `push` | |

Total: about 1 to 2 hours, inside Kaggle's 12-hour session and its weekly free GPU hours. The estimates come from the Nov 1 Llama 3.2 3B harness tune on a Lambda A10 (450 steps of 4 shorter rows in 404 s, base answers 414 s, peak 3.61 GB of GPU memory, docs/BUILD_LOG.md), scaled for a T4 being slower and these rows being longer. Memory should sit well under the T4's 16 GB.

Training and scoring match drill-bench's `ask`: the same `SYSTEM` line from the uploaded `drill-bench.py`, the model's own Llama 3.2 chat template, one BOS, temperature 0, 200 new tokens, and `parse_answer` on the raw text. The template's "Today Date" line is pinned to `26 Jul 2024` in both, so a run on another day renders the same text; a server on a board fills in its own date there. Answers are taken one prompt at a time with no padding, since batch padding once changed scores here (docs/BUILD_LOG.md, Nov 1 RL entry).

The printed table has, for base and tuned: valid JSON, all five right, each field (status, trust_controller, likely_cause, actions, escalate), actions overlap, the hard rule (violations out of the 12 mismatch rows, pass only at 0), answered, cut off, median seconds and tokens a second, then all-five-right by cause.

## Outputs

`answers-base.jsonl` and `answers-tuned.jsonl` (drill-bench ask's row format, so `drill-bench.py score --heldout eval/drill/sealed.jsonl --answers <file>` regrades them on the laptop), `scores.json`, `versions.json` (what pip actually installed), `adapter/` (the LoRA, about 90 MB), and with the export on: `Llama-3.2-3B-ColdRoom-Watch-Q4_K_M.gguf`, `Llama-3.2-3B-ColdRoom-Watch-Q4_K_M.gguf.sha256`, `MODEL_CARD.md`, `LICENSE.txt`, `USE_POLICY.md`.

**For the board:** put the GGUF somewhere it can be pulled, then hand Hussam its address and the `.sha256` line for `gguf-serve.sh --model-url` (docs/EDGE_PLAN.md H4). The notebook scores the 4-bit model before conversion, not the Q4_K_M file, so score the file again where it is served. Serve it with the GGUF's own chat template (`llama-server --jinja`): training rendered Llama 3.2's template, whose system turn starts with "Cutting Knowledge Date" and "Today Date" lines, and llama.cpp's built-in llama3 fallback leaves those lines out, so without `--jinja` the board's prompt differs from training by more than the date. Then: `python3 scripts/dev/drill-bench.py ask --heldout eval/drill/sealed.jsonl --url <board base ending in /v1> --model <id> --label "Llama 3.2 3B tuned, Q4_K_M" --out answers.jsonl`.

## If the install fails

The default `PIN_SET = "repo"` is the set docs/TRAINING.md records for the repo's Lambda tunes, resolved Oct 27, 2026 for Python 3.12 on x86_64 Linux: `torch==2.11.0+cu128 torchvision==0.26.0+cu128 torchaudio==2.11.0+cu128 xformers==0.0.35` from the cu128 index, `unsloth==2026.10.9 unsloth_zoo==2026.10.9 peft==0.21.2 accelerate==1.15.0 bitsandbytes==0.50.2 datasets==4.8.5`, `--no-deps torchao==0.18.0`, `transformers==5.15.0`, `--no-deps trl==0.22.2`. It has not been tried on a T4 or on Kaggle's image. In order:

1. `PIN_SET = "keep-torch"`: the same pins, holding the image's own torch with a pip constraint. Restart the session first if torch was already imported.
2. If pip says those Unsloth pins need a newer torch, or the GPU check says the torch build has no `sm_75` kernels: keep `"repo"` but check `nvidia-smi` shows a driver new enough for CUDA 12.8; otherwise drop the pins and follow Unsloth's current Kaggle install line, then record `versions.json` in the log.
3. If `trl` rejects an `SFTConfig` argument (names move between versions), `max_length` was `max_seq_length` and `eval_strategy` was `evaluation_strategy` in older releases.
4. If `save_pretrained_gguf` fails: `model.save_pretrained_merged(dir, tokenizer, save_method="merged_16bit")`, then llama.cpp's `convert_hf_to_gguf.py` and `llama-quantize <f16.gguf> <out.gguf> Q4_K_M`.

Whatever ran, the log entry names the versions from `versions.json`, the GPU and the times from `scores.json`.

## License and data

- **Llama 3.2:** licensed under the Llama 3.2 Community License, Copyright (c) Meta Platforms, Inc. All Rights Reserved. Any copy shared carries the license text (`LICENSE.txt`) and says "Built with Llama"; use is subject to the Llama 3.2 Acceptable Use Policy (`USE_POLICY.md`). A derivative model's name starts with "Llama", hence `Llama-3.2-3B-ColdRoom-Watch`. The export cell copies both files from the base repo, or from meta-llama/llama-models on GitHub, and says so if it can't.
- **Data:** every row is Simulated, invented by `scripts/dev/drill-bench.py` from seed 1104. No model wrote any of it, so it is rights-clean (docs/DATA_RIGHTS.md). Nothing in it is about a real freezer or store, and nothing is food-safety advice.
- **Limits of the score:** the right answer follows from written rules, so a few lines of code score 100%. The set measures whether a small model applies those rules to log layouts it never saw in training, not judgment.

## Safety

- No keys or tokens in the notebook, and none needed to run it.
- The Hugging Face upload is off (`PUSH_TO_HF = False`). When turned on it reads `HF_TOKEN` from Kaggle Secrets (or Colab's secrets), never prints it, and makes the repo private unless `HF_PRIVATE = False`. Whether the repo goes public is the owner's decision (docs/EDGE_PLAN.md O5).
- Nothing in it opens a tunnel, a shared link or a public endpoint. Don't add one.

## Checks without a GPU

```
python3 -I -B -m unittest discover -s notebooks -p 'test_*.py'
python3 -I notebooks/build_notebook.py --check
```
