# Policy simulation (Simulated, no model)

Current policy: `eval/user_policy.yaml`. Proposed policy: `eval/personas/relaxed_teacher/policy.yaml`. Items: `eval/fresh_200.jsonl`.

Command: `uv run python -m scripts.simulate_policy --proposed eval/personas/relaxed_teacher/policy.yaml --current eval/user_policy.yaml --set eval/fresh_200.jsonl`

Every item went through the real egress (Egress.release) twice in one throwaway home, once per policy, with a fake device model that finds no names and gives no request labels (scripts/replay_null_names.py). Limits: docs/SIMULATE.md.

## Totals

| | Current | Proposed |
|---|---|---|
| allow | 84 | 126 |
| ask | 73 | 31 |
| block | 43 | 43 |
| items with a leak in what Muse got | 0 | 0 |

126 of 200 items change: 42 now allowed, 0 now ask, 0 now blocked, 0 redacted differently, 84 with the same outcome for another reason. 42 looser, 0 stricter.

Of the 42 looser items, 34 have a hand label of ask_user or refuse: results the eval's simulated teacher wanted to be asked about or kept, which would now go out at once.

## Item by item: what Muse gets changes

| Item | Change | Current | Proposed | Current code | Proposed code | Leak kinds (proposed) | Hand label |
|---|---|---|---|---|---|---|---|
| syn-0435 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-0394 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-1910 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-0318 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-1438 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-1422 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | share_summary |
| syn-1678 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-1945 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-0120 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-1828 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-0763 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-0883 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-1582 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | share_tagged |
| syn-1153 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | share_summary |
| syn-1696 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-1655 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-1450 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-1134 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-1303 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | share_tagged |
| syn-0390 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-0936 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-0055 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-1391 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-1114 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-1275 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-0623 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-0439 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-0031 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-1157 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | share_summary |
| syn-1797 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-1417 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | share_tagged |
| syn-0023 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-1528 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-0455 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-0932 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-1453 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | share_summary |
| syn-1555 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | share_summary |
| syn-0670 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-0835 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-0650 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-1487 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |
| syn-0909 | now_allowed | ask (ask_user) | allow (share_tagged) | policy_default | policy_default | - | ask_user |

## Item by item: same outcome, another reason

| Current code | Proposed code | Outcome | Items |
|---|---|---|---|
| policy_rule:tagged_grades_and_excerpts | policy_default | allow | syn-1299, syn-1795, syn-0224, syn-1570, syn-0656, syn-0946, syn-0934, syn-0533, syn-1796, syn-1709, syn-0336, syn-1735, syn-0987, syn-1791, syn-1112, syn-0710, syn-0015, syn-1672, syn-1599, syn-1720, syn-0252, syn-0013, syn-0927, syn-0733, syn-0858, syn-0177, syn-1492, syn-1269, syn-0480, syn-0053, syn-0366, syn-1822, syn-0966, syn-1230, syn-1409, syn-0569, syn-0997, syn-0757, syn-1621 |
| policy_rule:class_averages | policy_rule:class_numbers | allow | syn-1520, syn-1029, syn-0971, syn-0908, syn-1216, syn-1928, syn-1282, syn-1890, syn-1740, syn-0249, syn-0924, syn-1040 |
| policy_rule:class_statistics | policy_rule:class_numbers | allow | syn-1037, syn-1471, syn-0963, syn-0277, syn-1559, syn-1701, syn-0549, syn-0163, syn-1898, syn-1367, syn-1666, syn-0838, syn-0431, syn-0317, syn-0389, syn-1590, syn-0601, syn-1964, syn-0541, syn-1921, syn-0878, syn-0629, syn-0900, syn-0530, syn-1343, syn-1705, syn-0491, syn-0116, syn-1351, syn-1990, syn-0613, syn-0649, syn-1607 |
