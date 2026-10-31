# Item sets for the simulated persona caseworker_cui (invented)

Command: `uv run python -m scripts.relabel_for_persona --persona eval/personas/caseworker_cui/persona.yaml --pool eval/personas/caseworker_cui/items.jsonl --holdout-n 8 --unseen-n 8`

Source: eval/personas/caseworker_cui/items.jsonl, split here with seed 0. Every item is invented; `expected` is caseworker_cui's policy on the hand labels, which changed 0 of 36 labels.

| Set | Items | Expected decisions |
|---|---|---|
| days | 20 | refuse:20 |
| holdout | 8 | refuse:8 |
| unseen | 8 | refuse:8 |

Decisions with fewer than 10 day items: none.
