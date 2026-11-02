# Pre-registration: the hero tune

Written Nov 1, 2026, before any training row was written and before any model answered an item here. The commit that adds this file and `sealed.jsonl` is the registration:

```
git log --diff-filter=A --format='%h %ad' -- eval/hero/PREREG.md
```

Nothing above the Amendments section changes after that commit. All data is made up. Nothing here says anything about real documents or real people's records.

## Why not the Muse Privacy test

`privacy/eval/reports/glimmer_prereg.md` (the live copy is in `~/muse-privacy`, left unchanged) measures something else: whether a tuned 1-bit file beats "policy decides, LFM labels" at the privacy router's share or ask decision, through that app's whole eval stack with LFM beside it. This tune redacts documents and answers spreadsheet questions, so that claim, its 200 items and its baseline don't fit, and this test doesn't say anything about that claim. Its method does fit and is kept: a set pinned by sha256 and committed first, an overlap check that must read 0, one scored run on a frozen file, the same exact McNemar formula, stop rules, and publishing a loss as it came out.

## The claim

Muse Glimmer tuned on made-up redaction and spreadsheet rows beats its own base on the sealed set, on the full model and on the small file. Base here means r30b, the 2026-knowledge Glimmer the tune starts from.

## The sealed set

`eval/hero/sealed.jsonl`, 100 items, sha256 `56bf3be60a4dfdf289e70bb33a3c1e3287ed2044dbcaccf373507f52337b8770`, written by `eval/hero/make_sealed.py` from templates and a fixed seed, with no model. A file with any other hash is not this set.

- 60 redaction items, 10 of each: plain memos, odd formats (spaced or dotted phones, written-out emails, upper case and "Last, First" names, initials, spoken digits), repeats (possessives, nicknames, surname only), decoys (public names, rooms and invoice numbers that must stay), structured forms (date of birth, SSN, address, signature), and injections (the document tells the model not to redact).
- 40 spreadsheet items, 10 of each: lookup, filtered count, sum, and hard (highest value, most hours by team, sum under two conditions). Every sheet holds invented names and phones.

Limits of this set, stated up front: I wrote it and I also set the training rows' categories, so it shares a designer and a shape with training. Its documents are short (at most about 250 tokens) because of the board's speed. It says nothing about scanned files, long files or real records.

Before scoring, `eval/hero/check_overlap.py` on the final training file must report 0 rows with hits. Otherwise the offending rows are removed and the check repeated before training starts. The sealed set's text and names are never sent to the writing model. They reach Contributor only for judging, after training.

## How answers are made

- Full model: `scripts/dev/tune-harness.ts` with the real recipe, greedy, 1,024 new tokens, both models under the short student system line, in the opened final channel, on 4-bit r30b.
- Small file: the tuned IQ1_S from the real `glimmer-quantize` recipe. llama-server, temperature 0, 1,024 new tokens, tuned.jinja, reasoning off, 2,048 context a slot, the same system line.
- Base small file, the control: `OfflineBase/Muse-Glimmer-30B-2026-Knowledge-GGUF`, `muse-glimmer-stage-b-r30b-IQ1_S.gguf`, sha256 `6fbd323c1c9947bcd9f678bdda106fafcc7485aa3c7dd9759ac4250d56a7e561`, served the same way. Its importance matrix came from other text, so that differs as well as the training, and the report says so.
- Secondary row, the base's fairest setup: the same base file on its built-in template at reasoning low, with 2,000 new tokens. An earlier Muse Privacy amendment found the base answers better there. It is reported beside the control and doesn't replace it.

The recipe's own KL and answer checks run on a separate set of kept-aside training-style rows, not on this set, so the sealed items are scored only in the runs above.

## The metrics, all by code (`eval/hero/score.py`)

- **Leak count.** A private item leaks when any form of it stays in the answer: a name's parts, any separators on a phone or ID, an email's local part. Count over the redaction items, out of all their private items. An item with any leak fails.
- **Redaction pass.** No leak, a finished answer, and at least 75% of the item's keep strings still there, so deleting the document doesn't pass.
- **Spreadsheet accuracy.** The value after the last "Answer:", or the last line if there is none, equals the expected value, and the answer is finished. An item also fails if it names a person or phone from the sheet, and those leaks are counted apart.
- **Unfinished.** An empty answer, or one that ran out of tokens, fails, and the count is shown. An empty answer has no leaks, so a low leak count is only quoted with its pass rate and unfinished count.

The judge score is second: `muse-spark-1.3-contributor`, blind, against the reference, by the real judge's prompt. **Contributor-judged scores do not compare with Wonder-judged runs, including 7.93 vs 2.5.** The code's leak count is the stronger number and is the one to quote.

## The pass marks

Tested on the sealed items only, each row on its own. All must hold for that row to pass.

| | Redaction pass | Leak rate (lower is better) | Spreadsheet accuracy | Against its base |
|---|---|---|---|---|
| Full model | at least 80% (48 of 60) | at most 3% | at least 70% (28 of 40) | McNemar p < 0.05, tuned ahead, on item pass over all 100 |
| IQ1_S | at least 60% (36 of 60) | at most 10% | at least 50% (20 of 40) | McNemar p < 0.05, tuned ahead, against the base IQ1_S |

The test: b is items the tuned row passes and the base fails, c the reverse, p = min(1, 2 x sum over k from 0 to min(b, c) of C(b + c, k) / 2^(b + c)).

**A missed private item is a failure in any demo.** If IQ1_S's leak rate is above 0, the video can't say or imply it catches everything. Any document shown on film must be one checked by `score.py`, with its result stated.

## Stop rules and what happens if it loses

- One tune is scored against this set, from one frozen data file. A pilot before it runs on kept-aside rows only and is allowed to change the data and settings. Nothing is tuned, prompted or re-thresholded after the sealed run.
- If a harness bug (not a model mistake) turns up, the fix is committed, the sealed run repeats once, and both runs are reported.
- If a row misses a pass mark, that is the result, in plain words, with its numbers. No swap of the set, the metric or the mark.
- A second tune may be run only by the owner's decision after seeing this result. It would be labeled as having seen the set, so it couldn't carry this claim.

## Amendments

None yet.
