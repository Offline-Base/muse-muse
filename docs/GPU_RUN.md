# Measuring Glimmer on the GPU machine

Glimmer does not run on the owner's laptop: it overheated on the base file on Oct 31. This is how to measure it on the training session's A100 instead (llama.cpp b11970). All items are invented.

## What these numbers mean

They describe decisions and leaks on an A100. They do not describe speed, memory or heat on any device this ships on. Every report says so through `--measured-on`. The same file on another machine or llama.cpp build can answer differently, so a claim about the Jetson or the laptop needs its own run. Reasoning off has not been tested on the Jetson's b10353.

## The go-ahead

Ethan said yes in chat on Oct 31. The amendments are in `eval/reports/glimmer_prereg.md`. The stage 2 stand-in proves the run on 20 items per row and carries no claim; the final file and base get full rows.

## Limits on the shared machine

Work only under `~/mp-gpu`, with at most 8 GB of disk, and delete it when done. Bind 127.0.0.1 only. Hold `flock /home/ubuntu/q/gpu.lock` for each server session and release it between rows where possible, since the training session's final build must not wait long after about 8:15 PM ET. Check `nvidia-smi` first for servers not holding the lock. Put no keys there except the throwaway llama key, and no Hugging Face token. Never use the training machine for this: it must not see the eval sets.

## Build the copy, on the Mac

From a clean checkout of main, writing outside the repo:

```
uv run python -m scripts.make_bundle --dev-sets-only --out ~/muse-privacy-gpu --name muse-gpu-run
```

It holds the sets this run scores, `eval/fresh_200_b.jsonl` and `eval/tasks.jsonl`, and the older eval sets beside them. None of those may go into training (docs/ROUTING_TUNE_HANDOFF.md), so keep the copy away from anything the training jobs read. It leaves out `eval/splits/`, `eval/templated/` and `eval/synthetic.jsonl`, because this machine also trains the model and the sealed set must stay unseen. It also leaves out `.env`, every model file and `eval/reports`, and the build stops on any secrets-scan finding.

## Run it, on the GPU machine

Files to have there:

| File | Check |
|---|---|
| `LFM3-VL-2B-Q4_K_M.gguf` from `LiquidAI/LFM3-VL-2B-GGUF` | sha256 `56dac2e192ff0d9ab8507f4f1aeb4aed0463449bbbefaac79497f041c95f21eb`, the laptop's file |
| The Glimmer file to test | Its sha256 goes in the report, through `plug_in_model --check` |
| `tuned-reasoning-off.jinja` | The same template for tuned and base |

```
tar xzf muse-gpu-run.tar.gz && cd muse-gpu-run
sha256sum -c SHA256SUMS
uv sync --frozen --no-dev

export CHECKER_SERVER_BIN=/path/to/llama-server
export CHECKER_GGUF=/path/to/LFM3-VL-2B-Q4_K_M.gguf
export SIDE_TEMPLATE=/path/to/tuned-reasoning-off.jinja
scripts/start_side_models.sh /path/to/glimmer.gguf "$PWD/.side"
```

That runs in the foreground, binds 127.0.0.1 only and prints the environment. In a second shell, use the `export` lines it printed, then:

```
uv run python -m scripts.plug_in_model /path/to/glimmer.gguf --check --label tuned
uv run python -m scripts.glimmer_probe --url http://127.0.0.1:8181/v1 --key-file "$PWD/.side/llama_api_key"
```

Stop if the probe exits nonzero: fix the serving, and score nothing. Then the rows:

```
uv run python -m scripts.model_matrix --name a100_tuned --preflight \
  --configs policy_lfm,glimmer_decide,glimmer_tighten,glimmer_labels,shipped_answers,shipped_labels,shipped_tighten,shipped_decide \
  --sets eval/fresh_200_b.jsonl eval/tasks.jsonl \
  --glimmer-url http://127.0.0.1:8181/v1 --glimmer-gguf /path/to/glimmer.gguf --glimmer-label tuned \
  --measured-on "A100 GPU, llama.cpp b11970, not a device this ships on"
```

For the base control, restart the side models on the base file and repeat with `--label base_iq1s`, `--name a100_base`, `--glimmer-label base_iq1s` and `--configs policy_lfm,glimmer_decide,glimmer_tighten,glimmer_labels`. Keep the same flags and template. Base on this template has not been tried, so the probe comes first here too.

`--preflight` scores 5 items per row and stops on more than 10% errors plus fallbacks, or a p95 of 20 s or more. It also prints a time estimate. `--resume` picks up an interrupted run.

These item lists must match the laptop baseline (`ids_sha256` in each row's `.meta.json`):

| Set | Items | ids_sha256 |
|---|---:|---|
| `eval/fresh_200_b.jsonl` | 200 | `9b3530914f60aa56` |
| `eval/tasks.jsonl` | 100 | `d3b8d89a85aee98f` |

## Bring back

`eval/reports/matrix_a100_*.md`, `eval/reports/raw/matrix_a100_*` and `eval/reports/model_file_*.md`, and nothing else. Run the secrets scan on the Mac before committing them. Log each step in `docs/BUILD_LOG.md`.

## Not in this run

- **The sealed set.** It stays on the Mac until the model is frozen. Run `scripts.check_overlap` on the Mac, from this repo, because the GPU copy has no sealed sets to check against. The chosen set then goes over for one scored pass, in a run nobody reads the items of (eval/reports/glimmer_prereg.md).
- **The persona study.** It needs `eval/splits/`, so it needs its own copy and its own decision.
- **Speed on a device.** That is `scripts.bench_device` on the device itself.
- **Made-up answers.** No check for them exists yet. The matrix counts decisions and leaks, and a summary can be wrong without leaking.
