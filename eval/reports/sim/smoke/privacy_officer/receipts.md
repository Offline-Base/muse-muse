# Receipt audit replay (simulated run, invented data)

Command: `uv run python -m scripts.simulate_nights --persona eval/personas/privacy_officer/persona.yaml --nights 1 --per-day 10 --tasks eval/tasks.jsonl --holdout eval/holdout.jsonl --unseen none --out eval/reports/sim/smoke/privacy_officer`

Persona: Simulated district privacy reviewer (invented). The persona is a policy file with seeded habits, not a person. No model calls; counts only.

| Count | Value |
|---|---|
| Decision rows | 10 |
| Shared (of which after an OK) | 6 (0) |
| Waiting for an answer | 3 |
| Kept on the device | 1 |
| Deleted later by the persona | 0 |
| Texts Muse got (ledger): shared, waiting, kept | 5, 3, 2 |
| Held by the final leak check after the router shared | 1 |
| Shared by Always approve | 0 |
| Shared texts with a word the name check reported only later | 2 |

| Check | Mismatches |
|---|---|
| Row without a receipt | 0 |
| Receipt hash is not the row's outgoing text | 0 |
| Receipt's device-only mode is not the run's | 0 |
| Receipt's toggles are not the run's | 0 |
| Shared with a floor that refuses | 0 |
| Shared at once with a never-share topic | 0 |
| Shared text with a roster name or identifier | 0 |
| Shared by Always approve while a toggle was on | 0 |
| Ledger line for a row that does not exist | 0 |
| Text Muse got is not its receipt's text or a fixed sentence | 0 |
| Private-detail note and receipt disagree | 0 |
| **All** | **0** |

0 mismatches is the pass.

## Controls and the rules they relate to

A checklist for a reviewer. It maps each control the device runs to a rule it relates to, with counts from this simulated run. It cites rules and makes no finding about any law; a toggle does not satisfy a law by itself (each toggle's own limit is on the Controls page).

| Control | Related rule (cited) | This run |
|---|---|---|
| Names and identifiers are swapped for tags before any result leaves the device | FERPA, 34 CFR 99.3 (personally identifiable information) and 99.31(b)(1) (release after removing it); COPPA, 16 CFR 312.2 (the definition of personal information); HIPAA, 45 CFR 164.514(b)(2) (the Safe Harbor list) | tags in receipts: detail 12, person 7, student 68 |
| Every result gets a decision row and a receipt (kinds, counts, checks, sha256; no values) | FERPA, 34 CFR 99.32 (record of disclosures), as the closest rule; tagged results are meant to carry no PII | 10 of 10 rows have a receipt |
| What Muse received is the text each receipt describes | the same record-keeping rules as above | 0 of 10 texts differ from their receipt or a fixed sentence |
| A result about fewer than 10 people stays on the device | FERPA, 34 CFR 99.3 (indirect identifiers) and 99.31(b)(1) (a reasonable determination across releases); HIPAA, 45 CFR 164.514(b)(2)(ii) (no actual knowledge that the rest could identify someone) | 0 results kept as a small group |
| Old results on the device are deleted after 90 days | COPPA, 16 CFR 312.10 (data retention and deletion) | retention set by the toggles; this run lasted less than a day, so nothing was old enough |
| Always approve is off while a toggle is on | no rule; a device setting | 0 results shared by Always approve |
