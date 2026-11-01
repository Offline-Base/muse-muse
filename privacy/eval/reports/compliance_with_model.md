# Tagging report: compliance_with_model

Command: `uv run python -m eval.run_compliance --name compliance_with_model --model`

Date: 2026-10-30 14:48

Invented sentences, scored with the rules and LFM3-VL-2B on this device. A miss means the private value survived. This set was used while the rules were written, so expect more misses on new text. It is not a legal measure of de-identification.

## HIPAA

| Kind | Items | Missed |
|---|---|---|
| date | 8 | 0 |
| age | 4 | 0 |
| url | 3 | 0 |
| ip | 3 | 0 |
| record | 12 | 0 |
| place | 6 | 0 |
| detail | 6 | 0 |
| clean sentences changed (over-redaction) | 16 | 1 |

Missed: none

Changed clean sentences: clean-13

