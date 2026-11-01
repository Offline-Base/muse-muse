# Name parts: what guard.tag leaves when the name pass reports part of a name

Command: `uv run python -m scripts.check_name_parts --before-module guard_8afe137.py`

This is a simulation of the model's answer, not Glimmer itself. No model was called. A fake name pass stands in for Glimmer's second name pass (LocalLLM.llm_names) and returns a fixed answer built from each item's hand labels, so the numbers show what the guard does with each kind of answer, not how often Glimmer gives it.

## What it measures

Items: 1380 of 2000 items in synthetic, 4 of 100 items in tasks. An item is in when its `result` still shows a `names` or `other_names` value after the roster pass alone (guard.tag with no name pass, the roster loaded the way the eval's services load it). Only the model's name pass can catch those names.

For each item, guard.tag runs once per answer and guard, with a fresh in-memory tag map. The fake keeps a name only if guard.name_occurs finds it in the text, as LocalLLM.llm_names does. Answers:

- all: every name in names + other_names.
- full: only the longest name of each person. A value whose words are all in another value is the same person and is dropped.
- first: only the first word of each person's longest name. Titles such as Mr and Ms are skipped.
- last: only the last word of each person's longest name. Suffixes such as Jr are skipped.
- none: nothing.

Columns:

- Leaked: items where a names or other_names value still appears in the tagged text (eval/run_eval.py's find_leaks, matcher _contains).
- Past final check: leaked items in which guard.leaks (egress's final_check, with the same tag map) finds nothing, so egress would send the text to Muse. Egress holds the others.
- Over-tags: name tags (student, teacher or person) on words that are not words of any names or other_names value. Counted as tags; the number of items with any is in brackets.

Guards:

- after: `base/guard.py`, sha256 d7bfc2325a30.
- before: `guard_8afe137.py`, sha256 369691cf830f.

A guard shown by file name only was loaded from a file outside the repo, such as an earlier commit's guard saved with `git show REV:base/guard.py`. `git show REV:base/guard.py | shasum -a 256` tells which commit it is.

## All items

| Model answer | Items | Leaked before | Leaked after | Past final check before | Past final check after | Over-tags before | Over-tags after |
|---|---|---|---|---|---|---|---|
| all | 1384 | 0 | 0 | 0 | 0 | 0 (0) | 30 (15) |
| full | 1384 | 15 | 0 | 15 | 0 | 0 (0) | 30 (15) |
| first | 1384 | 0 | 0 | 0 | 0 | 0 (0) | 33 (16) |
| last | 1384 | 31 | 1 | 31 | 1 | 0 (0) | 33 (16) |
| none | 1384 | 1384 | 1384 | 1384 | 1384 | 0 (0) | 0 (0) |

guard.tag raised on 0 runs (counted as held, not leaked).

## Answer: all (every name in names + other_names)

| Set | Items | Leaked before | Leaked after | Past final check before | Past final check after | Over-tags before | Over-tags after |
|---|---|---|---|---|---|---|---|
| synthetic | 1380 | 0 | 0 | 0 | 0 | 0 (0) | 30 (15) |
| tasks | 4 | 0 | 0 | 0 | 0 | 0 (0) | 0 (0) |

Still leak after (after): none.

Leaked before (before): none.

Items with more over-tags after than before: 15.

## Answer: full (only the longest name of each person)

| Set | Items | Leaked before | Leaked after | Past final check before | Past final check after | Over-tags before | Over-tags after |
|---|---|---|---|---|---|---|---|
| synthetic | 1380 | 15 | 0 | 15 | 0 | 0 (0) | 30 (15) |
| tasks | 4 | 0 | 0 | 0 | 0 | 0 (0) | 0 (0) |

Still leak after (after): none.

Leaked before (before): syn-0752, syn-0755, syn-0759, syn-0765, syn-0767, syn-1114, syn-1261, syn-1431, syn-1435, syn-1447, syn-1451, syn-1525, syn-1530, syn-1541, syn-1561.

Items with more over-tags after than before: 15.

## Answer: first (only the first word of each name)

| Set | Items | Leaked before | Leaked after | Past final check before | Past final check after | Over-tags before | Over-tags after |
|---|---|---|---|---|---|---|---|
| synthetic | 1380 | 0 | 0 | 0 | 0 | 0 (0) | 33 (16) |
| tasks | 4 | 0 | 0 | 0 | 0 | 0 (0) | 0 (0) |

Still leak after (after): none.

Leaked before (before): none.

Items with more over-tags after than before: 16.

## Answer: last (only the last word of each name)

| Set | Items | Leaked before | Leaked after | Past final check before | Past final check after | Over-tags before | Over-tags after |
|---|---|---|---|---|---|---|---|
| synthetic | 1380 | 31 | 1 | 31 | 1 | 0 (0) | 33 (16) |
| tasks | 4 | 0 | 0 | 0 | 0 | 0 (0) | 0 (0) |

Still leak after (after): syn-0728.
- syn-0728: the only word reported for the leaked name is a common word written in lowercase, which the guard neither tags nor widens.

Leaked before (before): syn-0728, syn-0752, syn-0755, syn-0756, syn-0757, syn-0759, syn-0760, syn-0764, syn-0765, syn-0767, syn-0768, syn-0771, syn-0772, syn-0773, syn-0776, syn-1114, syn-1261, syn-1431, syn-1432, syn-1435, syn-1439, syn-1440, syn-1443, syn-1447, syn-1448, syn-1451, syn-1455, syn-1525, syn-1530, syn-1541, syn-1561.

Items with more over-tags after than before: 16.

## Answer: none (nothing)

| Set | Items | Leaked before | Leaked after | Past final check before | Past final check after | Over-tags before | Over-tags after |
|---|---|---|---|---|---|---|---|
| synthetic | 1380 | 1380 | 1380 | 1380 | 1380 | 0 (0) | 0 (0) |
| tasks | 4 | 4 | 4 | 4 | 4 | 0 (0) | 0 (0) |

Every item leaks under every guard here, by construction: the items are the ones the roster pass alone leaves names in. This row checks the selection.

## Over-tags by kind

- identifier: the tag overlaps an identifier the guard finds in the raw text (a student id's leading S, for example), so that identifier is no longer tagged as one.
- family_name: the tag is a one-word labeled name plus the words after it, likely a family name the hand labels left out.
- other: any other word, such as a capitalized label or heading next to a name.

| Model answer | Guard | identifier | family_name | other |
|---|---|---|---|---|
| all | before | 0 | 0 | 0 |
| all | after | 0 | 30 | 0 |
| full | before | 0 | 0 | 0 |
| full | after | 0 | 30 | 0 |
| first | before | 0 | 0 | 0 |
| first | after | 0 | 30 | 3 |
| last | before | 0 | 0 | 0 |
| last | after | 0 | 30 | 3 |
| none | before | 0 | 0 | 0 |
| none | after | 0 | 0 | 0 |

## Identifier digits left in the tagged text

Items whose hand-labeled `identifiers` still show their longest digit group (4 or more digits) in the tagged text. find_leaks matches whole identifiers only, so it does not count these. Past final check: guard.leaks finds nothing in the tagged text, so egress would send it.

| Model answer | Items with identifiers | Digits left before | Digits left after | Past final check before | Past final check after |
|---|---|---|---|---|---|
| all | 464 | 2 | 2 | 2 | 2 |
| full | 464 | 2 | 2 | 2 | 2 |
| first | 464 | 2 | 2 | 2 | 2 |
| last | 464 | 2 | 2 | 2 | 2 |
| none | 464 | 2 | 2 | 2 | 2 |

Items with digits left under before, any answer: syn-0358, syn-0876.
Items with digits left under after, any answer: syn-0358, syn-0876.

Items with digits left under after and not under before: 0.

## Limits

- The answers are built from hand labels, so the fake never reports a word that is not a name. Glimmer can, and a capitalized false positive next to other capitalized words would be widened too. The over-tag counts here do not measure that.
- Hand labels have gaps (a family name left out) and slips (a lowercase word inside a name), which show up as family_name over-tags and as leaks of the last-word answer.
- Only `result` is tagged. Summaries and Muse's request are not part of this check.
- Each run uses a fresh tag map. On a device the tag map persists, so a name tagged in an earlier result is caught later too.

Raw rows: raw/name_parts.jsonl next to this report (ids, answer kinds, leak flags and kinds; never the names).
