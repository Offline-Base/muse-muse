# Eval splits

Command: `uv run python -m scripts.make_splits`

Status: **UNSEALED**. Ethan has not confirmed what his fine-tuned Glimmer trained on. Every set here, like fresh_200 and fresh_200_b, comes from eval/synthetic.jsonl, so if the fine-tune used that file every one of them is contaminated, not only fresh_200_c. Seal fresh_200_c only after he confirms the fine-tune never saw eval/synthetic.jsonl and scripts/check_overlap.py on his training file finds nothing.

Source: `eval/synthetic.jsonl` (sha256 `639885ec87a32b1c`), seed 20261101. All items invented. The pool is 1264 items no set or scored report has used; 84 are left over. Each file keeps the source's lines byte for byte, in source order. Do not run an eval on fresh_200_c, or read anything about its items, until it is sealed.

| File | Items | share_tagged | share_summary | ask_user | refuse | sha256 | Purpose |
|---|---:|---:|---:|---:|---:|---|---|
| fresh_200_c.jsonl | 200 | 46 | 66 | 40 | 48 | `74b58035d877631c` | candidate sealed final set: nobody reads its misses before submission |
| sim_holdout.jsonl | 80 | 20 | 20 | 20 | 20 | `df8d3a1e8c4ec3e6` | the dreaming gate's holdout in the simulation, an equal share per decision |
| sim_unseen.jsonl | 100 | 25 | 25 | 25 | 25 | `dc74add075860286` | the simulation's unseen test, an equal share per decision |
| sim_days.jsonl | 800 | 222 | 213 | 153 | 212 | `6f796ebad0acfd4e` | the simulated days, free to read |

Left out of the pool:

- scored in a report: 336
- in a set: 400

Sets checked by id and by result text:

- `eval/fresh_200.jsonl`: 200 ids
- `eval/fresh_200_b.jsonl`: 200 ids
- `eval/tasks.jsonl`: 100 ids
- `eval/holdout.jsonl`: 20 ids
- `eval/compliance.jsonl`: 62 ids

Report rows that scored items (ids only):

- `eval/reports/final/raw/nights/unseen-last-night.jsonl`: 100 ids
- `eval/reports/final/raw/nights/unseen-night-0.jsonl`: 100 ids
- `eval/reports/nights_device_rules/raw/nights/unseen-last-night.jsonl`: 100 ids
- `eval/reports/nights_device_rules/raw/nights/unseen-night-0.jsonl`: 100 ids
- `eval/reports/nights_device_tighten/raw/nights/unseen-last-night.jsonl`: 100 ids
- `eval/reports/nights_device_tighten/raw/nights/unseen-night-0.jsonl`: 100 ids
- `eval/reports/raw/request_topics.jsonl`: 420 ids
- `eval/reports/raw/request_topics_tuning.jsonl`: 260 ids

Check the files against this manifest: `uv run python -m scripts.make_splits --verify`.
