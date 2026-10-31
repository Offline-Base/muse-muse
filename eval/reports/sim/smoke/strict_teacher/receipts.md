# Receipt audit replay (simulated run, invented data)

Command: `uv run python -m scripts.simulate_nights --persona eval/personas/strict_teacher/persona.yaml --seed 101 --nights 1 --per-day 10 --tasks eval/personas/strict_teacher/days.jsonl --holdout eval/personas/strict_teacher/holdout.jsonl --unseen eval/personas/strict_teacher/unseen.jsonl --home /var/folders/hq/4lxx9jy977lg_xvw20bhjs8c0000gn/T/pzh.kfHWUA9yrP --out eval/reports/sim/smoke/strict_teacher`

Persona: Simulated strict 4th-grade teacher (invented). The persona is a policy file with seeded habits, not a person. No model calls; counts only.

| Count | Value |
|---|---|
| Decision rows | 10 |
| Shared (of which after an OK) | 6 (1) |
| Waiting for an answer | 0 |
| Kept on the device | 4 |
| Deleted later by the persona | 0 |
| Texts Muse got (ledger): shared, waiting, kept | 6, 3, 4 |
| Held by the final leak check after the router shared | 0 |
| Shared by Always approve | 0 |
| Shared texts with a word the name check reported only later | 0 |

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
