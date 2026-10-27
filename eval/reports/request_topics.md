# Request topics: Glimmer labels against hand labels

Command: `uv run python -m scripts.check_request_topics --keywords eval/reports/raw/request_topics_keywords.yaml`

Model: meta/muse-glimmer-30b on openrouter. 260 calls, 0 failed (a failure counts as no topics). Latency per call: mean 1729 ms, p95 3226 ms.

Topics and descriptions come from the policy (`request_topics` in eval/user_policy.yaml). The synthetic sample is half items with an outside-the-class topic (rare in the set), so its precision is not the precision on all 2000 items. Hand labels are Spark's and have noise: a school newsletter is labeled parents in some items and third_party in others.

## Synthetic sample (held out) (160 items)

| Topic | Method | Labeled | Found | Precision | Recall |
|---|---|---|---|---|---|
| parents | Glimmer | 34 | 37 | 0.86 | 0.94 |
| parents | Keywords | 34 | 48 | 0.69 | 0.97 |
| third_party | Glimmer | 32 | 39 | 0.74 | 0.91 |
| third_party | Keywords | 32 | 30 | 0.73 | 0.69 |
| full_text | Glimmer | 10 | 12 | 0.83 | 1.00 |
| full_text | Keywords | 10 | 2 | 1.00 | 0.20 |
| deanonymize | Glimmer | 8 | 8 | 1.00 | 1.00 |
| deanonymize | Keywords | 8 | 8 | 1.00 | 1.00 |
| class_level | Glimmer | 25 | 25 | 1.00 | 1.00 |
| class_level | Keywords | 25 | 17 | 0.94 | 0.64 |

## Eval tasks and holdout (120 items)

| Topic | Method | Labeled | Found | Precision | Recall |
|---|---|---|---|---|---|
| parents | Glimmer | 9 | 10 | 0.90 | 1.00 |
| parents | Keywords | 9 | 11 | 0.82 | 1.00 |
| third_party | Glimmer | 9 | 9 | 1.00 | 1.00 |
| third_party | Keywords | 9 | 9 | 1.00 | 1.00 |
| full_text | Glimmer | 7 | 8 | 0.88 | 1.00 |
| full_text | Keywords | 7 | 7 | 1.00 | 1.00 |
| deanonymize | Glimmer | 4 | 5 | 0.80 | 1.00 |
| deanonymize | Keywords | 4 | 4 | 1.00 | 1.00 |
| class_level | Glimmer | 37 | 37 | 0.97 | 0.97 |
| class_level | Keywords | 37 | 33 | 0.91 | 0.81 |
