# Why the router asked: loosen_result_words_sim_days200

Command: `uv run python -m scripts.ask_causes --raw eval/reports/sim/fixes_dev/raw/loosen_result_words_sim_days200.jsonl --set eval/splits/sim_days.jsonl --out eval/reports/sim/fixes_dev`

Rows: eval/reports/sim/fixes_dev/raw/loosen_result_words_sim_days200.jsonl (ids, decisions and reason codes only). Items: eval/splits/sim_days.jsonl. Written 2026-10-31 01:58. Counts only, no request or result text.

| Count | Value |
|---|---|
| Items | 200 |
| Approval requests | 70 |
| Wanted (expected ask_user) | 38 |
| Needless (expected anything else) | 32 |
| Missed asks (the policy wants an ask, the router shared) | 3 |
| Refusals shared (the policy refuses, the router shared) | 0 |

## Needless approval requests by reason code

Rows are the code of what decided the ask, columns the item's expected decision. The total is the needless count above.

| Code | share_tagged | share_summary | refuse | Total |
|---|---|---|---|---|
| unknown_person_title | 16 | 0 | 0 | 16 |
| outside_class | 3 | 6 | 0 | 9 |
| policy_default | 2 | 4 | 0 | 6 |
| policy_rule:ask_before_outside_class | 1 | 0 | 0 | 1 |
| Total | 22 | 10 | 0 | 32 |

## Wanted approval requests by reason code

| Code | Asks |
|---|---|
| policy_default | 18 |
| outside_class | 13 |
| policy_rule:ask_before_parents | 4 |
| policy_rule:ask_before_outside_class | 3 |
| Total | 38 |

## Needless approval requests by reason code and result kind

The kind the connector sends for the item (eval/run_eval.py production_labels).

| Code | document_list | free_text | per_student | snippet | Total |
|---|---|---|---|---|---|
| unknown_person_title | 16 | 0 | 0 | 0 | 16 |
| outside_class | 0 | 7 | 1 | 1 | 9 |
| policy_default | 0 | 5 | 0 | 1 | 6 |
| policy_rule:ask_before_outside_class | 0 | 1 | 0 | 0 | 1 |

## What the codes mean

| Code | Meaning |
|---|---|
| outside_class | the request names a destination outside the class |
| policy_default | no policy rule matched, so the policy's default applied |
| policy_rule:ask_before_outside_class | the policy rule named after the colon |
| policy_rule:ask_before_parents | the policy rule named after the colon |
| unknown_person_title | a document list whose titles name someone the roster does not know |
