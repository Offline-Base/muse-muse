# Item sets for the simulated persona relaxed_teacher (invented)

Command: `uv run python -m scripts.relabel_for_persona --persona eval/personas/relaxed_teacher/persona.yaml`

Source: eval/splits (sim_days.jsonl, sim_holdout.jsonl, sim_unseen.jsonl), split kept. Every item is invented; `expected` is relaxed_teacher's policy on the hand labels, which changed 163 of 980 labels.

| Set | Items | Expected decisions |
|---|---|---|
| days | 800 | share_tagged:352 share_summary:213 ask_user:23 refuse:212 |
| holdout | 80 | share_tagged:31 share_summary:20 ask_user:9 refuse:20 |
| unseen | 100 | share_tagged:47 share_summary:25 ask_user:3 refuse:25 |

Decisions with fewer than 10 day items: none.
