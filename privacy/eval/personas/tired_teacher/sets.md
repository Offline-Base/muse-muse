# Item sets for the simulated persona tired_teacher (invented)

Command: `uv run python -m scripts.relabel_for_persona --persona eval/personas/tired_teacher/persona.yaml`

Source: eval/splits (sim_days.jsonl, sim_holdout.jsonl, sim_unseen.jsonl), split kept. Every item is invented; `expected` is tired_teacher's policy on the hand labels, which changed 0 of 980 labels.

| Set | Items | Expected decisions |
|---|---|---|
| days | 800 | share_tagged:222 share_summary:213 ask_user:153 refuse:212 |
| holdout | 80 | share_tagged:20 share_summary:20 ask_user:20 refuse:20 |
| unseen | 100 | share_tagged:25 share_summary:25 ask_user:25 refuse:25 |

Decisions with fewer than 10 day items: none.
