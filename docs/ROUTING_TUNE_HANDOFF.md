# Routing fine-tune handoff, Oct 31

For the session training Muse Glimmer on routing. What the app sends at run time, what to train on and what must stay out.

## The data

`uv run python -m scripts.export_routing_training --out DIR` writes rows in the exact format the app sends, with the expected answer. All items are invented, and there are no real connector interactions in them. The exports are in `~/muse-privacy-routing-training/`:

| Folder | Items used | route.jsonl | labels.jsonl | Note |
|---|---:|---:|---:|---|
| `clean/` | 420 | 392 rows | 302 rows | No eval set or split at all |
| `with_sim_days/` | 1220 | 1093 rows | 846 rows | Also the persona study's simulated days |

Use `with_sim_days/` unless the data turns out to be enough without it. The persona study's primary metric is on its unseen set, which stays out either way. Only its day-by-day counts stop being new to the model, and the study report must say so.

Each row is `{"messages": [system, user, assistant]}`. `manifest.json` has counts and sha256. Re-export after any router or policy change: the rows follow the code.

## The two jobs

- **route.jsonl, for `--mode decide` or `tighten`.** The assistant replies with only `{"decision": "...", "reason": "..."}`. The decision is one of share_tagged, share_summary, ask_user or refuse.
- **labels.jsonl, for `--mode labels`.** The assistant replies with only `{"topics": [...]}`, using the names listed in the system prompt.

Recommendation: train both, and weigh labels at least as heavily. On LFM, the policy deciding on the model's labels scored 81.5% and the model deciding scored 43.0%, on the same set in one run (eval/reports/matrix_lfm_loosen_default.md). Labels are a small closed-set task, which suits a low-bit file (the base i1-IQ1_S measures 1.874 bits per weight), and the code's floors and policy still decide.

The candidate mode for the pre-registered claim is "model decides" unless changed. It can be switched once, in the Amendments of eval/reports/glimmer_prereg.md, before any tuned row runs. Tell the Muse Privacy session which mode the tune targets before handing over the file.

## Format

- The rows have no "Reasoning strength" line, because the file is served with reasoning off. The app strips that line when `GLIMMER_REASONING=off`. If reasoning gets repaired and the file is served with it on, re-export with `--keep-reasoning-line`.
- Render the assistant turn as the final channel only: `<|start|>assistant to=user<|message|>JSON<|eot|>`, with no `to=self` turn. Test with the same template the file will be served with, and hand that template over too (`GLIMMER_TEMPLATE`).
- Replies are generated under a strict JSON schema on llama.cpp. Test the final quantized file with `response_format` json_schema, not only free text.
- In real use, the user's learned rules follow "This user's rules, learned from their decisions:" in the router's system prompt. The rows have "None yet."

## What must stay out

- `eval/splits/fresh_200_c.jsonl`, `eval/templated/fresh_200_t.jsonl`, `eval/splits/sim_holdout.jsonl`, `eval/splits/sim_unseen.jsonl`, `eval/fresh_200.jsonl`, `eval/fresh_200_b.jsonl`, `eval/tasks.jsonl`, `eval/holdout.jsonl`, `eval/compliance.jsonl`. The exports already leave these out, by id and by result text.
- Do not train on the rest of `eval/synthetic.jsonl` by another route, and do not read the sealed sets to write new items.
- More items are welcome if they come from new text. New items must be invented and follow eval/DATASET.md, with invented names, 555-01xx phones and example.com or example.org emails. Do not use real connector data: Muse's connector guidelines bar using user data for model training.

## Before handing over

Run this on the full training file, knowledge rows and routing rows together, and send the counts:

```
uv run python -m scripts.check_overlap --train TRAINING_FILE --name glimmer_tuned --sets eval/splits/fresh_200_c.jsonl eval/templated/fresh_200_t.jsonl
```

Any exact hit or name hit against a set disqualifies that set (eval/reports/glimmer_prereg.md). Send a GGUF, the chat template, what the training file holds, and the intended mode.

## What will be measured on arrival

`plug_in_model --check`, then `glimmer_probe` for the reply shape, then speed, then the matrix on the same items as the LFM baseline (eval/reports/matrix_baseline_attack_fixes.md: 82.0% on fresh_200_b and 81.0% on tasks, 0 leaks). The stop rules are more than 10% errors plus fallbacks, or a p95 of 20 s or more.
