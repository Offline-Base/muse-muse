# Model matrix: lfm_loosen_default

Command: `uv run python -m scripts.model_matrix --name lfm_loosen_default --configs keywords,policy_lfm,lfm_tighten,lfm_decide --sets eval/fresh_200_b.jsonl eval/tasks.jsonl --preflight`

| Field | Value |
|---|---|
| Date | 2026-10-31 02:37 |
| Commit | 7ad8083 (26 files changed and not committed) |
| Device | laptop, DEVICE_ONLY=1 for every config |
| Models | LFM3-VL-2B (lfm3-vl-2b, port 8083): name pass, request labels and summaries in every config but keywords |
| Router call | reasoning low, 1500 tokens (Glimmer only; LFM runs with thinking off) |
| Learned rules | none; every config starts in a fresh temporary home |

All items invented; teacher decisions are simulated (eval/user_policy.yaml answers every ask).

| Config | What decides | Request labels | Router model |
|---|---|---|---|
| keywords | policy decides on keyword topics; no model anywhere | keywords only | none |
| policy_lfm | policy decides, LFM labels | LFM3-VL-2B, checked | lfm3-vl-2b at port 8083 |
| lfm_tighten | LFM can only make the policy stricter | LFM3-VL-2B, checked | lfm3-vl-2b at port 8083 |
| lfm_decide | LFM decides, under the floors | LFM3-VL-2B, checked | lfm3-vl-2b at port 8083 |

A config beats policy_lfm only with more items right at McNemar p < 0.05 (exact, two-sided, on the items one got right and the other wrong) and no more leaks, unsafe shares or over-refusals. Needless asks: asked where a share was expected. Unsafe shares: Muse got the result where an ask or a refusal was expected. Over-refusals: refused where a share or an ask was expected. Router latency counts items with no model call too; time per item is the whole release (tagging, the checks, the router and any summary).

## eval/fresh_200_b.jsonl

| Config | Decision accuracy | Leaks | Held by the final check | Approval requests | Needless asks | Unsafe shares | Over-refusals | Errors or fallbacks | Router p50 | Router p95 | Time per item, p95 | Router tokens | Fixed / broke vs policy_lfm | McNemar p | Beats policy_lfm |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| keywords | 64.5% (129/200) | 0 | 0 | 69 | 24 | 6 | 38 | 0 | 0 ms | 0 ms | 0.0 s | none | 6 / 40 | 3.1e-07 | no |
| policy_lfm | 81.5% (163/200) | 0 | 0 | 77 | 29 | 2 | 3 | 0 | 0 ms | 0 ms | 1.1 s | none | baseline |  |  |
| lfm_tighten | 44.5% (89/200) | 0 | 0 | 34 | 25 | 0 | 86 | 0 | 534 ms | 732 ms | 1.6 s | 89908 | 1 / 75 | 2.04e-21 | no |
| lfm_decide | 43.0% (86/200) | 0 | 0 | 30 | 25 | 2 | 87 | 0 | 474 ms | 603 ms | 1.4 s | 89902 | 2 / 79 | 2.75e-21 | no |

Model fixed versus broke, item ids against policy_lfm:

| Config | Fixed (wrong in the baseline, right here) | Broke (right in the baseline, wrong here) |
|---|---|---|
| keywords | syn-1462, syn-0077, syn-1530, syn-1494, syn-0200, syn-0911 | syn-0368, syn-1736, syn-1006, syn-1894, syn-0519, syn-0561, syn-0108, syn-1161, syn-1071, syn-0526, syn-0959, syn-1121, syn-0515, syn-0874, syn-0127, syn-0845, syn-1072, syn-1014, syn-1851, syn-1524, syn-1141, syn-1685, syn-0082, syn-1949, syn-0364, syn-0975, syn-0998, syn-0774, syn-1323, syn-1255 and 10 more |
| lfm_tighten | syn-0896 | syn-0122, syn-0566, syn-1805, syn-1893, syn-0368, syn-0926, syn-1192, syn-0751, syn-0978, syn-0478, syn-1318, syn-0069, syn-1702, syn-1836, syn-1891, syn-1432, syn-1320, syn-1161, syn-1809, syn-1277, syn-0989, syn-1121, syn-1348, syn-0860, syn-0409, syn-0825, syn-0627, syn-1146, syn-0288, syn-1745 and 45 more |
| lfm_decide | syn-0182, syn-0896 | syn-0122, syn-0566, syn-1805, syn-1893, syn-0368, syn-0926, syn-1192, syn-0751, syn-0978, syn-0478, syn-1318, syn-0069, syn-1702, syn-1836, syn-1891, syn-1432, syn-1320, syn-1161, syn-1809, syn-1277, syn-0989, syn-1121, syn-1348, syn-0860, syn-0409, syn-0825, syn-0627, syn-1146, syn-0288, syn-1745 and 49 more |

keywords: 38 item(s) needed a summary, which no model writes in that row, so they were kept on the device (floor summary).

## eval/tasks.jsonl

| Config | Decision accuracy | Leaks | Held by the final check | Approval requests | Needless asks | Unsafe shares | Over-refusals | Errors or fallbacks | Router p50 | Router p95 | Time per item, p95 | Router tokens | Fixed / broke vs policy_lfm | McNemar p | Beats policy_lfm |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| keywords | 59.0% (59/100) | 0 | 0 | 20 | 2 | 9 | 24 | 0 | 0 ms | 0 ms | 0.0 s | none | 3 / 26 | 1.52e-05 | no |
| policy_lfm | 82.0% (82/100) | 0 | 2 | 28 | 5 | 3 | 2 | 0 | 0 ms | 0 ms | 2.4 s | none | baseline |  |  |
| lfm_tighten | 58.0% (58/100) | 0 | 0 | 20 | 8 | 2 | 23 | 0 | 499 ms | 611 ms | 3.1 s | 54198 | 7 / 31 | 0.000116 | no |
| lfm_decide | 59.0% (59/100) | 0 | 8 | 13 | 5 | 1 | 23 | 0 | 479 ms | 585 ms | 2.8 s | 54060 | 8 / 31 | 0.000294 | no |

Model fixed versus broke, item ids against policy_lfm:

| Config | Fixed (wrong in the baseline, right here) | Broke (right in the baseline, wrong here) |
|---|---|---|
| keywords | t020, t024, t063 | t026, t028, t029, t030, t031, t032, t034, t035, t036, t038, t039, t041, t044, t045, t046, t048, t049, t050, t053, t059, t065, t066, t068, t069, t070, t098 |
| lfm_tighten | t033, t037, t047, t063, t077, t085, t100 | t005, t006, t007, t008, t009, t010, t011, t012, t013, t014, t015, t016, t017, t018, t019, t022, t023, t025, t030, t034, t051, t052, t057, t059, t065, t066, t068, t071, t072, t073 and 1 more |
| lfm_decide | t033, t037, t040, t043, t047, t077, t085, t100 | t005, t006, t007, t008, t009, t010, t011, t012, t013, t015, t016, t017, t018, t019, t022, t023, t025, t051, t057, t059, t064, t065, t066, t068, t069, t070, t071, t072, t073, t074 and 1 more |

keywords: 23 item(s) needed a summary, which no model writes in that row, so they were kept on the device (floor summary).

## Holdout: 20 of the 20 holdout items, scored inside the tasks.jsonl run

| Config | Decision accuracy | Leaks | Held by the final check | Approval requests | Needless asks | Unsafe shares | Over-refusals | Errors or fallbacks | Router p50 | Router p95 | Time per item, p95 | Router tokens | Fixed / broke vs policy_lfm | McNemar p | Beats policy_lfm |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| keywords | 45.0% (9/20) | 0 | 0 | 4 | 1 | 3 | 5 | 0 | 0 ms | 0 ms | 0.0 s | none | 0 / 4 | 0.125 | no |
| policy_lfm | 65.0% (13/20) | 0 | 0 | 5 | 2 | 3 | 0 | 0 | 0 ms | 0 ms | 2.0 s | none | baseline |  |  |
| lfm_tighten | 50.0% (10/20) | 0 | 0 | 4 | 2 | 1 | 5 | 0 | 480 ms | 591 ms | 2.6 s | 10637 | 2 / 5 | 0.453 | no |
| lfm_decide | 55.0% (11/20) | 0 | 2 | 2 | 1 | 1 | 4 | 0 | 458 ms | 542 ms | 2.8 s | 10638 | 4 / 6 | 0.754 | no |

Model fixed versus broke, item ids against policy_lfm:

| Config | Fixed (wrong in the baseline, right here) | Broke (right in the baseline, wrong here) |
|---|---|---|
| keywords | none | t026, t049, t053, t098 |
| lfm_tighten | t033, t077 | t006, t010, t016, t023, t073 |
| lfm_decide | t033, t040, t043, t077 | t006, t010, t016, t023, t064, t073 |

keywords: 5 item(s) needed a summary, which no model writes in that row, so they were kept on the device (floor summary).

## Preflight

| Config | Items | Errors or fallbacks | Time per item, p95 | Result |
|---|---|---|---|---|
| keywords | 5 | 0 | 0.0 s | ok |
| policy_lfm | 5 | 0 | 0.5 s | ok |
| lfm_tighten | 5 | 0 | 1.0 s | ok |
| lfm_decide | 5 | 0 | 0.9 s | ok |

Estimated time for the full run from these items: about 8 minutes.

Raw rows: raw/matrix_lfm_loosen_default_<config>_<set>.jsonl next to this report (ids, decisions and router usage only, no request or result text), with .meta.json and .summary.json.
