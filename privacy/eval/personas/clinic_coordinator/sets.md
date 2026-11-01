# Item sets for the simulated persona clinic_coordinator (invented)

Command: `uv run python -m scripts.relabel_for_persona --persona eval/personas/clinic_coordinator/persona.yaml --pool eval/personas/clinic_coordinator/items.jsonl --holdout-n 16 --unseen-n 16`

Source: eval/personas/clinic_coordinator/items.jsonl, split here with seed 0. Every item is invented; `expected` is clinic_coordinator's policy on the hand labels, which changed 0 of 80 labels.

| Set | Items | Expected decisions |
|---|---|---|
| days | 48 | share_tagged:12 share_summary:12 ask_user:12 refuse:12 |
| holdout | 16 | share_tagged:4 share_summary:4 ask_user:4 refuse:4 |
| unseen | 16 | share_tagged:4 share_summary:4 ask_user:4 refuse:4 |

Decisions with fewer than 10 day items: none.
