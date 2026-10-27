# Synthetic dreaming set: eval/synthetic.jsonl

Commands, run from the repo root on Oct 27:

```
uv run python -m scripts.make_synthetic --dry-run
uv run python -m scripts.make_synthetic --count 2000 --workers 8
uv run python -m scripts.make_synthetic --check
```

The second command writes the file. The third re-checks it and prints the two tables below (exit 0 means every check passed). Token totals come from `spark_calls` in `eval/.cache/spark.db`:

```
uv run python -c "from base.spark import usage_summary; print(usage_summary('eval/.cache/spark.db'))"
```

`eval/.cache` is gitignored, so the same rows (time, model, token counts, cached; no text) are exported to `raw/synthetic_usage.jsonl` next to this report, 254 calls, with:

```
uv run python -m scripts.make_synthetic --export-usage eval/reports/raw/synthetic_usage.jsonl
```

The generator's stderr log from the run was not saved, so the drop counts and the run time quoted below cannot be rebuilt from the repo.

## How it was made

The plan wanted Muse itself to write this set on its Secure VM. This file was made with the plan's fallback instead: Muse Spark 1.3 (`muse-spark-1.3`) on the Meta Model API, reasoning effort `low`, strict json_schema, 25 items per call. Ethan can still redo it in the Muse app with the prompt in the plan, then run `uv run python -m scripts.make_synthetic --check --out <that file>` to hold it to the same checks.

Every item is invented. The script asks Spark for items in a fixed (expected, result_kind) order and keeps an item only when it passes these checks. It is dropped when:
- a phone, email, SSN or card is outside the reserved fake ranges (555-01xx, example.com or example.org, SSN starting with 9 or 000, the 4111 test card), or the device guard finds an identifier in the request,
- the request contains a name from the item,
- any name in the request or result is a roster name, nickname or one-edit misspelling of one (base.guard.find_names on eval/roster.json), or a student id is equal to or in the numbering block of a roster id,
- `expected` disagrees with `policy.wants(item)` from eval/user_policy.yaml, or a never-share keyword in the result (base.guard.blocked_topics) belongs to a topic the item does not list,
- the request repeats an earlier one, or has token Jaccard >= 0.8 with any request in eval/tasks.jsonl or eval/holdout.jsonl.

Missing slots are asked for again in later rounds.

## Counts

2000 items, 500 per decision. Within each decision the result kinds are split evenly:

| expected | result_kind | items |
|---|---|---|
| ask_user | free_text | 167 |
| ask_user | per_student | 167 |
| ask_user | snippet | 166 |
| refuse | contact_info | 100 |
| refuse | free_text | 100 |
| refuse | per_student | 100 |
| refuse | sensitive_record | 100 |
| refuse | snippet | 100 |
| share_summary | class_aggregate | 500 |
| share_tagged | document_list | 125 |
| share_tagged | free_text | 125 |
| share_tagged | per_student | 125 |
| share_tagged | snippet | 125 |

Totals by kind: class_aggregate 500, free_text 392, per_student 392, snippet 391, document_list 125, contact_info 100, sensitive_record 100. dreaming_report is left out on purpose: the router shares it on a rule path, and eval/user_policy.yaml has no rule for it (policy.wants says ask_user), so items of that kind would teach the router nothing and contradict the policy.

Tricky items: 386 of 2000 (19.3%): refuse 272, ask_user 55, share_tagged 33, share_summary 26.

Topics (an item can have several): grades 859, writing 565, reading 215, attendance 161, parent_contact 123, parents 118, third_party 105, medical 76, iep 74, lunch_status 72, home_address 68, discipline 67, custody 51, deanonymize 31, full_text 28, reidentify 28, immigration 12.

Identifiers appear in 465 items, all of them refuse. The guard finds 617 identifier hits in results: student_id 213, phone 153, email 104, address 68, ssn 62, card 16, otp 1. Names: 2276 name mentions, 2140 distinct.

## Checks

From `uv run python -m scripts.make_synthetic --check`:

| Check | Result | Detail |
|---|---|---|
| item count | pass | 2000 of 2000 |
| unique ids | pass | 2000 unique ids |
| decisions within 5% of even | pass | share_tagged 500, share_summary 500, ask_user 500, refuse 500; widest gap 0.0% |
| result kinds match the even plan | pass | 0 items off the plan |
| expected equals policy.wants | pass | 0 items disagree with eval/user_policy.yaml |
| every item passes the generator checks again | pass | 0 items fail or change |
| no roster name (guard.find_names, misspellings included) | pass | 0 items with a hit |
| every guard identifier hit is fake | pass | 617 hits ({'address': 68, 'card': 16, 'email': 104, 'otp': 1, 'phone': 153, 'ssn': 62, 'student_id': 213}), 0 real |
| no identifier in any request | pass | 0 requests with an identifier |
| never-share keywords only under their topic | pass | 0 items with an unlisted keyword topic |
| no listed name on eval/roster.json | pass | 0 items |
| no id equal to or in the block of a roster student id | pass | 0 items |
| no identifier outside the fake ranges | pass | 0 items |
| no identifier in a share item | pass | 0 items |
| no duplicate requests or results | pass | 0 repeated requests, 0 repeated results |
| no request with Jaccard >= 0.8 to tasks or holdout | pass | 0 items; highest 0.60 against 120 requests |

Checked by hand as well:
- The 68 addresses use invented street names such as "27 Moonmoss Court" and "14 Fernwhistle Lane". The one code hit is "code 4412" in a refuse item about lunch status.
- base.dreaming.dataset.load_synthetic reads all 2000 items.

## Generation log

Drops in the final run of the command above (round 1 replayed earlier Spark replies from the response cache):

| | |
|---|---|
| Spark calls | 84 (round 1: 80, round 2: 3, round 3: 1) |
| items generated | 2071 |
| roster_collision | 50 |
| label_topic_mismatch | 19 |
| name_in_request | 1 |
| real_identifier | 1 |
| kept | 2000 |

No batch failed or was cut short: every reply ended with finish_reason `stop`. One call of 25 items took about 20 seconds and about 6,400 tokens. With 8 calls in flight, the first full run took 3 minutes 39 seconds.

## Tokens and spend

All Spark calls made for this set, from `spark_calls` (cache hits cost nothing and are not counted):

| Run | API calls | Prompt tokens | Cached prompt tokens | Completion tokens | Of which reasoning |
|---|---|---|---|---|---|
| Two one-batch pilots (`--count 25 --max-calls 1`) | 2 | 3,092 | 0 | 10,267 | 4,593 |
| First full run | 84 | 134,775 | 45,412 | 415,161 | 180,401 |
| Rerun after the roster-id check (round 1 from cache) | 4 | 6,192 | 3,795 | 18,003 | 9,710 |
| Rerun after the em dash cleanup (all from cache) | 0 | 0 | 0 | 0 | 0 |
| Total | 90 | 144,059 | 49,207 | 443,431 | 194,704 |

Estimated spend: about $2.07 ($0.18 for prompt tokens, $1.88 for completion tokens). This uses $1.25 per million input tokens and $4.25 per million output tokens from a third-party price list, not Meta's own page, so treat it as an estimate. Reasoning tokens are counted inside completion tokens. Even at twice that rate the total stays under $5.

The response cache is gitignored. With it in place, the generation command rebuilds this exact file with 0 API calls. With an empty cache, Spark writes a different set.

## What changed in scripts/make_synthetic.py for this run

- Topics and decision order now match eval/user_policy.yaml. The topics added are writing, reading, attendance, parents, third_party, full_text, deanonymize and reidentify. The prompt lists the decisions in the policy's first-match order. Before this change, the policy check would have dropped most ask_user items about parents or newsletters, and every share_tagged essay excerpt.
- dreaming_report is out of the plan (see Counts).
- Spark's output now goes through the device guard: roster names with misspellings, identifier hits held to the fake ranges, and never-share keywords added to the item's topics.
- The prompt steers toward rare first names and made-up surnames. In the first pilot, which asked for "names from many cultures", 7 of 25 items reused real roster names or near misses.
- Identifier formats are described without patterns. One pilot item had copied "9NN-NN-NNNN" from the prompt, and items with such placeholders are now dropped.
- Student ids in a roster id's numbering block are dropped. The first full run had 5 items with ids like S401275, next to roster ids S401270 and S401287.
- Em dashes are replaced with " - " (4 items).
- Also added: a `--max-calls` spend cap (default 200) and a `--check` mode.

## Limits

- The `names` ground truth comes from Spark. Every listed name is verified to appear in its result and to be off the roster. Whether Spark listed every name in a result was not checked independently. Dreaming tags only the listed names, so a missed invented name would stay in that training example's text. Every name is invented, so this adds noise, not a leak.
- Names lean toward a made-up, storybook style, and some surnames repeat often (Quillfeather in 60 mentions, Brambleton 50, Ashdale 45). This was the price of keeping roster collisions low. Dreaming masks names before it learns, so the style does not reach the router.
- Kinds are balanced within each decision, not across all kinds. share_summary is always class_aggregate, so that kind holds 500 items.
- Tricky items cluster in refuse (272 of 386).
- Each item's topics are Spark's judgment. The checks prove they agree with the policy and with the never-share keywords. They do not prove that, say, every `parents` item is really addressed to families. That was spot read only.
