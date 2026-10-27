# Request topics: Glimmer labels against hand labels

Command: `uv run python -m scripts.check_request_topics --keywords eval/reports/raw/request_topics_keywords.yaml --extra-topic 'reidentify=narrows the class down to one or a few students by a personal trait or a one-time event only they share'`

Model: meta/muse-glimmer-30b on openrouter, device setting laptop. 420 calls with the policy's topics, 0 failed (a failure counts as no topics). Latency per call: mean 1583 ms, p95 2875 ms. Tokens over all 840 calls: prompt 249374, completion 113358.

Topics and descriptions come from the policy (`request_topics` in eval/user_policy.yaml). Hand labels are Spark's and have noise: a school newsletter is labeled parents in some items and third_party in others.

## Which numbers are held out

The descriptions were written from eval/DATASET.md's topic definitions with the eval task requests in view, then checked on the seed-7 synthetic sample. Those runs also scored reidentify, grades and writing, which were then left out of the policy. After one scored run, the full_text description was tightened ("not a search, a quote, an excerpt or a summary") after looking at its false positives, mostly eval tasks such as "Search the essays for compost." and "Find excerpts that mention a friend.". So the seen-during-tuning sample and the eval tasks are in-sample. Only the first table is held out: a fresh draw (seed 11) with the descriptions frozen, leaving out every id in `eval/reports/raw/request_topics_tuning.jsonl` (the labels kept from those runs). Each sample is half items with an outside-the-class topic (rare in the 2000 items), so its precision is not the precision on all items. The eval tasks include the 20 holdout items (eval/holdout.jsonl is a subset), scored once.

## Candidate topics (not in the policy)

Each is scored from a second call per item that lists the policy's topics plus the candidates, as the policy would if it shipped them. Only the candidate's labels are scored from that call; the policy's own rows come from the first call.

- reidentify: "narrows the class down to one or a few students by a personal trait or a one-time event only they share"

## Synthetic sample, held out (160 items)

| Topic | Method | Labeled | Found | Precision | Recall |
|---|---|---|---|---|---|
| parents | Glimmer | 37 | 37 | 0.86 | 0.86 |
| parents | Keywords | 37 | 57 | 0.65 | 1.00 |
| third_party | Glimmer | 32 | 36 | 0.75 | 0.84 |
| third_party | Keywords | 32 | 24 | 0.67 | 0.50 |
| full_text | Glimmer | 6 | 12 | 0.50 | 1.00 |
| full_text | Keywords | 6 | 4 | 1.00 | 0.67 |
| deanonymize | Glimmer | 6 | 6 | 1.00 | 1.00 |
| deanonymize | Keywords | 6 | 6 | 1.00 | 1.00 |
| class_level | Glimmer | 18 | 18 | 0.94 | 0.94 |
| class_level | Keywords | 18 | 13 | 0.92 | 0.67 |
| reidentify (candidate) | Glimmer | 10 | 6 | 0.50 | 0.30 |
| reidentify (candidate) | Keywords | 10 | 0 | n/a | 0.00 |

## Synthetic sample, seen during tuning (160 items)

| Topic | Method | Labeled | Found | Precision | Recall |
|---|---|---|---|---|---|
| parents | Glimmer | 34 | 41 | 0.80 | 0.97 |
| parents | Keywords | 34 | 48 | 0.69 | 0.97 |
| third_party | Glimmer | 32 | 37 | 0.76 | 0.88 |
| third_party | Keywords | 32 | 30 | 0.73 | 0.69 |
| full_text | Glimmer | 10 | 12 | 0.83 | 1.00 |
| full_text | Keywords | 10 | 2 | 1.00 | 0.20 |
| deanonymize | Glimmer | 8 | 9 | 0.89 | 1.00 |
| deanonymize | Keywords | 8 | 8 | 1.00 | 1.00 |
| class_level | Glimmer | 25 | 25 | 1.00 | 1.00 |
| class_level | Keywords | 25 | 17 | 0.94 | 0.64 |
| reidentify (candidate) | Glimmer | 6 | 12 | 0.25 | 0.50 |
| reidentify (candidate) | Keywords | 6 | 0 | n/a | 0.00 |

## Eval tasks, in-sample (100 items)

| Topic | Method | Labeled | Found | Precision | Recall |
|---|---|---|---|---|---|
| parents | Glimmer | 8 | 9 | 0.89 | 1.00 |
| parents | Keywords | 8 | 10 | 0.80 | 1.00 |
| third_party | Glimmer | 7 | 7 | 1.00 | 1.00 |
| third_party | Keywords | 7 | 7 | 1.00 | 1.00 |
| full_text | Glimmer | 6 | 6 | 1.00 | 1.00 |
| full_text | Keywords | 6 | 6 | 1.00 | 1.00 |
| deanonymize | Glimmer | 3 | 5 | 0.60 | 1.00 |
| deanonymize | Keywords | 3 | 3 | 1.00 | 1.00 |
| class_level | Glimmer | 30 | 30 | 0.97 | 0.97 |
| class_level | Keywords | 30 | 27 | 0.89 | 0.80 |
| reidentify (candidate) | Glimmer | 2 | 6 | 0.17 | 0.50 |
| reidentify (candidate) | Keywords | 2 | 1 | 1.00 | 0.50 |

Raw rows: raw/request_topics.jsonl next to this report (ids and topic names only).

## Reading (written by hand after the run)

- Spend: the OpenRouter key's usage rose by $0.17 over this run (GET /api/v1/key before and after; any other call on the key in those three minutes counts too). From the token counts above at the list price ($0.30 per million prompt tokens, $1.20 per million completion tokens) it would be $0.21 with no discount for cached prompt tokens.
- On the held-out draw Glimmer beats the keyword list on third_party and class_level, trades recall for precision on parents (0.86 and 0.86 against 0.65 and 1.00) and ties on deanonymize. full_text is the exception: precision 0.50 (12 found, 6 labeled), against 0.83 on the seen-during-tuning sample, 1.00 on the eval tasks and 1.00 for the keyword list. Its 6 false positives ask for one paragraph or note ("Show me [Student A]'s paragraph about library books for grading."), and each would reach the router and the dreaming rules as a full-text request. Apart from full_text precision, the held-out numbers are within about 0.1 of the seen-during-tuning ones (parents recall 0.86 against 0.97 is the largest gap; deanonymize is higher held out).
- reidentify, with the description that was tried, found 24 requests in all three sets and 7 of them were labeled reidentify: precision 0.50 held out (3 of 6), 0.25 on the tuning sample (3 of 12), 0.17 on the eval tasks (1 of 6), recall 0.30, 0.50 and 0.50. Spark's reidentify labels are noisy (several labeled items are plain per-student requests, such as "Show log scores and lunch aid flag for [Student J] and [Student K]."), and the eval-task "false positives" t078, t088 and t094 do single out students by a trait but carry a never-share label instead. Either way the label is too unreliable to feed the no_reidentifying refuse floor, which supports leaving it out of the policy.
- Changing a description after reading these errors would make the held-out draw seen too: add `raw/request_topics.jsonl` to `--seen` and draw again with another `--seed`.
