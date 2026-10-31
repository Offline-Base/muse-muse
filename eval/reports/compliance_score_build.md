# Tagging report: compliance_score_build

Command: `uv run python -m eval.run_compliance --name compliance_score_build`

Date: 2026-10-31 01:47

Invented sentences, scored with the rules alone (no model). A miss means the private value survived. This set was used while the rules were written, so expect more misses on new text. It is not a legal measure of de-identification.

## FERPA

| Kind | Items | Missed |
|---|---|---|
| date | 8 | 0 |
| age | 4 | not tagged by this toggle |
| url | 3 | 0 |
| ip | 3 | 0 |
| record | 12 | 0 |
| place | 6 | 1 |
| detail | 6 | 1 |
| clean sentences changed (over-redaction) | 20 | 0 |

Missed: place-06, detail-06

Changed clean sentences: none

## COPPA

| Kind | Items | Missed |
|---|---|---|
| date | 8 | 0 |
| age | 4 | not tagged by this toggle |
| url | 3 | 0 |
| ip | 3 | 0 |
| record | 12 | 0 |
| place | 6 | 1 |
| detail | 6 | 1 |
| clean sentences changed (over-redaction) | 20 | 0 |

Missed: place-06, detail-06

Changed clean sentences: none

## HIPAA

| Kind | Items | Missed |
|---|---|---|
| date | 8 | 0 |
| age | 4 | 0 |
| url | 3 | 0 |
| ip | 3 | 0 |
| record | 12 | 0 |
| place | 6 | 1 |
| detail | 6 | 1 |
| clean sentences changed (over-redaction) | 20 | 0 |

Missed: place-06, detail-06

Changed clean sentences: none

