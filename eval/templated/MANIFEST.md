# Templated test set: eval/templated/fresh_200_t.jsonl

**Status: UNSEALED.** Ethan has not yet said what his fine-tuned Glimmer trained on. Until he does, this set is not a sealed test set. Do not run an eval on it and do not read its items; only the tests open it. Once he confirms the training data, the status line changes to SEALED with the date and commit, and the set is scored once, on the frozen commit (eval/reports/glimmer_prereg.md).

| Field | Value |
|---|---|
| File | eval/templated/fresh_200_t.jsonl |
| sha256 | `c83fd50f66d38d8683cea0f312e639891fb3ad8151d939507e65f17c19092e34` |
| Items | 200 |
| Seed | 20261102 |
| Generator command | `uv run python -m scripts.make_templated_set` |
| Check command | `uv run python -m scripts.make_templated_set --check` (exit 0 means every check below passed) |
| Generator | scripts/make_templated_set.py: seeded templates, no model, nothing read from eval/synthetic.jsonl |
| Roster | 47 invented students (15 with nicknames), 18 guardian first names, 6 staff; no name token appears in any other eval set, eval/roster.json, a demo file or a test roster |
| Labels | `expected` is policy.wants(item) from eval/user_policy.yaml, as in every other set |

Every person, number and identifier is invented. Phones are 555-01xx, emails use example.com or example.org, SSNs start with 9, student ids are S7 plus five digits (outside the roster's S401 block), and identifiers appear only in refuse items.

## Counts

Same (expected, result_kind) counts as eval/fresh_200_b.jsonl.

| expected | result_kind | items |
|---|---|---|
| ask_user | free_text | 15 |
| ask_user | per_student | 13 |
| ask_user | snippet | 23 |
| refuse | contact_info | 5 |
| refuse | free_text | 9 |
| refuse | per_student | 9 |
| refuse | sensitive_record | 11 |
| refuse | snippet | 12 |
| share_summary | class_aggregate | 44 |
| share_tagged | document_list | 19 |
| share_tagged | free_text | 17 |
| share_tagged | per_student | 12 |
| share_tagged | snippet | 11 |

By decision: share_tagged 59, share_summary 44, ask_user 51, refuse 46.
Tricky items: 45 of 200 (share_tagged 18, share_summary 4, ask_user 10, refuse 13).
Topics (an item can have several): grades 74, writing 29, reading 17, attendance 13, parents 12, third_party 11, medical 11, parent_contact 8, lunch_status 7, custody 6, full_text 5, iep 5, discipline 4, immigration 3, home_address 3, deanonymize 2, reidentify 2.

## Checks

From `uv run python -m scripts.make_templated_set --check`:

| Check | Result | Detail |
|---|---|---|
| item count | pass | 200 of 200 |
| unique ids | pass | 200 unique ids |
| decision and kind counts equal fresh_200_b's | pass | 0 items off the plan |
| expected equals policy.wants | pass | 0 items disagree with eval/user_policy.yaml |
| every item passes make_synthetic.clean_item unchanged | pass | 0 items fail or change |
| no roster word, no keyword in a non-refuse request, no em dash | pass | 0 items |
| no eval/roster.json name (guard.find_names, misspellings included) | pass | 0 items with a hit |
| every guard identifier hit is fake | pass | 25 hits ({'address': 3, 'dob': 4, 'email': 4, 'phone': 9, 'ssn': 2, 'student_id': 3}), 0 real |
| no phone, email, SSN or card outside the fake ranges | pass | 0 items |
| no identifier in a share item | pass | 0 items |
| no repeated request or result | pass | 0 repeats |
| 0 overlap hits against every other eval set | pass | 0 hits in 18 sets |
| roster names are new | pass | 0 name tokens in 0 files |

## Overlap with the other eval sets

Hits of this set's items against each set, from the same command. Exact means equal after lowercasing and dropping punctuation. A near request has token Jaccard 0.8 or more with any text in the set; a near result has Jaccard 0.8 or more, or half or more of its 8-word runs inside one text. Identifier means a phone, email, id or address shared with an item there. The last two columns are the closest any item came (thresholds 0.8 and 0.5).

| Set | Exact request | Exact result | Exact pair | Near request | Near result | Identifier | Id | Closest Jaccard | Closest 8-gram share |
|---|---|---|---|---|---|---|---|---|---|
| eval/compliance.jsonl | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.25 | 0.00 |
| eval/fresh_200.jsonl | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.47 | 0.00 |
| eval/fresh_200_b.jsonl | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.54 | 0.00 |
| eval/holdout.jsonl | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.36 | 0.00 |
| eval/personas/caseworker_cui/days.jsonl | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.43 | 0.00 |
| eval/personas/caseworker_cui/holdout.jsonl | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.43 | 0.00 |
| eval/personas/caseworker_cui/items.jsonl | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.43 | 0.00 |
| eval/personas/caseworker_cui/unseen.jsonl | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.43 | 0.00 |
| eval/personas/clinic_coordinator/days.jsonl | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.38 | 0.00 |
| eval/personas/clinic_coordinator/holdout.jsonl | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.31 | 0.00 |
| eval/personas/clinic_coordinator/items.jsonl | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.38 | 0.00 |
| eval/personas/clinic_coordinator/unseen.jsonl | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.38 | 0.00 |
| eval/splits/fresh_200_c.jsonl | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.50 | 0.00 |
| eval/splits/sim_days.jsonl | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.60 | 0.00 |
| eval/splits/sim_holdout.jsonl | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.45 | 0.00 |
| eval/splits/sim_unseen.jsonl | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.44 | 0.00 |
| eval/synthetic.jsonl | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.60 | 0.00 |
| eval/tasks.jsonl | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.54 | 0.00 |

Roster names found in other eval, demo or test-roster files: 0.
