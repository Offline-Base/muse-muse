# Nights of dreaming (simulated)

Command: `uv run python -m scripts.simulate_nights --nights 5 --per-day 20 --home eval/.cache/sim_before_home`

| Field | Value |
|---|---|
| Device | laptop |
| Backend | openrouter |
| Model | meta/muse-glimmer-30b |
| Dreaming backend | prompt |
| Date | 2026-10-27 03:05 |
| Day items | 80 (holdout excluded) |
| Holdout items | 20 |

Each day the simulated teacher answers every approval request. Each night the router learns
from those answers and is scored on the holdout items, which it never trains on. Approval
requests are for the day before each night; accuracy, agreement and leaks are for the rules
in place after it. Night 0 is the router with no learned rules.

| Night | Approval requests that day | Accuracy | Agreement | Leaks | Kept | Seconds |
|---|---|---|---|---|---|---|
| 0 | - | 70.0% | 70.0% | 0 | - | 64.1 |
| 1 | 3 | 85.0% | 85.0% | 0 | yes | 114.6 |
| 2 | 6 | 85.0% | 85.0% | 0 | yes | 117.1 |
| 3 | 7 | 85.0% | 85.0% | 0 | no | 132.9 |
| 4 | 7 | 90.0% | 90.0% | 0 | no | 118.6 |
| 5 | 5 | 85.0% | 85.0% | 0 | no | 126.8 |
