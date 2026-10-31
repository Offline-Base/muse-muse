# Item sets for the simulated persona sped_coordinator (invented)

Command: `uv run python -m scripts.relabel_for_persona --persona eval/personas/sped_coordinator/persona.yaml`

Source: eval/splits (sim_days.jsonl, sim_holdout.jsonl, sim_unseen.jsonl), split kept. Every item is invented; `expected` is sped_coordinator's policy on the hand labels, which changed 42 of 980 labels.

| Set | Items | Expected decisions |
|---|---|---|
| days | 800 | share_tagged:222 share_summary:213 ask_user:189 refuse:176 |
| holdout | 80 | share_tagged:20 share_summary:20 ask_user:23 refuse:17 |
| unseen | 100 | share_tagged:25 share_summary:25 ask_user:28 refuse:22 |

Decisions with fewer than 10 day items: none.
