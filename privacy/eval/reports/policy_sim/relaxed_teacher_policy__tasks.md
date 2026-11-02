# Policy simulation (Simulated, no model)

Current policy: `eval/user_policy.yaml`. Proposed policy: `eval/personas/relaxed_teacher/policy.yaml`. Items: `eval/tasks.jsonl`.

Command: `uv run python -m scripts.simulate_policy --proposed eval/personas/relaxed_teacher/policy.yaml --current eval/user_policy.yaml --set eval/tasks.jsonl`

Every item went through the real egress (Egress.release) twice in one throwaway home, once per policy, with a fake device model that finds no names and gives no request labels (scripts/replay_null_names.py). Limits: docs/SIMULATE.md.

## Totals

| | Current | Proposed |
|---|---|---|
| allow | 56 | 64 |
| ask | 22 | 14 |
| block | 22 | 22 |
| items with a leak in what Muse got | 0 | 0 |

63 of 100 items change: 8 now allowed, 0 now ask, 0 now blocked, 0 redacted differently, 55 with the same outcome for another reason. 8 looser, 0 stricter.

Of the 8 looser items, 8 have a hand label of ask_user or refuse: results the eval's simulated teacher wanted to be asked about or kept, which would now go out at once.

## Item by item: what Muse gets changes

| Item | Change | Current | Proposed | Current code | Proposed code | Leak kinds (proposed) | Hand label |
|---|---|---|---|---|---|---|---|
| t063 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| t071 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| t072 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| t073 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| t074 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| t075 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| t085 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | refuse |
| t098 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | refuse |

## Item by item: same outcome, another reason

| Current code | Proposed code | Outcome | Items |
|---|---|---|---|
| policy_rule:tagged_grades_and_excerpts | policy_default | allow | t005, t006, t007, t008, t009, t010, t011, t012, t013, t014, t015, t016, t017, t018, t019, t020, t021, t022, t023, t024, t025, t027, t033, t037, t047, t058, t065, t066, t067, t068, t069, t070, t077, t100 |
| policy_rule:class_averages | policy_rule:class_numbers | allow | t026, t028, t029, t030, t031, t032, t034, t035, t036 |
| policy_rule:class_statistics | policy_rule:class_numbers | allow | t038, t039, t040, t041, t042, t043, t044, t045, t046, t048, t049, t050 |
