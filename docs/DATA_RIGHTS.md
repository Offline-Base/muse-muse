# Training-data rights

What every model we might feature was trained on, the exact terms that bear on it, and three yes or no questions for the owner. Written Nov 2, 2026. Not a legal opinion: nobody here is a lawyer, and nobody has read these clauses for us legally.

Read in this order: "The questions" (2 minutes), "The exact terms" (5 minutes), then the tables if an answer needs them.

## The questions

Each answer is yes or no. The tables below show where each row of data came from.

**Q1. May we train on outputs of a model Fireworks served?** (Fireworks Terms 2.2(c))
- Where it applies: Muse Spark Open on Fireworks wrote much of the knowledge run's stage 1 data and all 4,400 overviews ("anchors"), which went into stage 1 and stage 2 unchanged. Every model built on r30b inherits that.
- Yes: as far as Q1 goes, r30b and everything tuned from it can be featured, with "Built with Muse Spark Open".
- No: r30b, the earlier knowledge adapters, the moss tune 1898e46c, the hero tune (PR #54, base r30b) and every lab or product tune since Oct 31 (all train on r30b) have Fireworks-written data in their lineage. Only models on plain Muse Glimmer 30B or Llama stay clear. Fixing it means retraining stage 1 and stage 2 without the Fireworks rows (the filter below writes those copies), which costs GPU money and time we don't have before Nov 4. The owner's rule for the Nov 1 Hub upload was "dont retrain anything".
- Already decided: on Oct 31 at 9:20 PM the owner chose to publish without waiting on Fireworks' answer (docs/KNOWLEDGE_RUN_LOG.md on the knowledge branch, and the public dataset card). Q1 asks whether that also covers featuring these models in the submission. No written answer from Fireworks is recorded in the logs (asking was item 2 of the owner's list in docs/KNOWLEDGE_UPDATE.md).

**Q2. May we train on Meta Model API outputs (Muse Wonder, Muse Spark 1.3, Spark 1.3 Contributor)?** (Meta Model API Terms 10.1(ix))
- Where it applies: the knowledge run never used the Model API (its rule, docs/KNOWLEDGE_UPDATE.md line 48, says "Never"). The moss datasets, the moss tunes, both lab adapters on the Hub and every product tune the fine-tuning lab writes do use it.
- Yes: the moss tune 1898e46c and its 7.93 vs 2.5 result can be featured, and the lab can keep writing training data on Wonder or Contributor.
- No: drop the moss tune and its 7.93 vs 2.5 from the video and submission, set the moss datasets and the moss and lab model repos private (they are public now, see "Found while checking"), and keep the lab to rows a person wrote or code wrote. The hero tune is unaffected by Q2: its rows are written by code, with no Meta call (eval/hero/PREREG.md, Amendments, on branch tg-hero-tune).
- The deciding words: 10.1(ix) bars training a model "that competes with Meta's models or services". "Competes" is not defined anywhere in the terms. A tune of Meta's own open Glimmer may or may not count. That is the call the owner makes, or asks Meta about in writing.

**Q3. May we train on rows from non-commercial (NC) or no-derivatives (ND) sources?**
- Where it applies: the knowledge run's training files. Stage 1 held NC, ND and no-reuse science rows (and court records, a separate problem); stage 2 held NC rows; the r30b stage held NC rows and a few ND and no-reuse ones. Counts are in the inventory.
- Yes: r30b stands as trained. Its card already discloses these rows (owner, Oct 31, 9:50 PM: "free reign license", the rows "disclosed in the card only").
- No: r30b can't be featured without a retrain on filtered files. The Official Rules give the organizers a license to the submission "for any purpose without restriction" and ask us to warrant it violates no one's rights (quoted below), which sits badly with an NC or ND source if the model is part of the submission.
- Already decided: the owner accepted the risk for publishing on Oct 31. Q3 asks the same for the submission.

**Q4, related (only if FIREWORKS_TUNE is ever turned on).** May we upload model-written rows to Fireworks as training input? Fireworks 3.3(v) has us warrant that Input contains no "machine-generated content". The lab's datasets are written by Muse Wonder or Spark 1.3 Contributor, and docs/TRAIN_BACKENDS.md already says they "can't go there". The flag is off and no Fireworks job has run (docs/BUILD_LOG.md, Nov 1, "Train on Fireworks, flag off").

### What each answer changes, by model

"Exposed" means the model's training data, or its base's, contains rows of that kind. Counts and sources are in the inventory.

| Model we might feature | Where | Q1 Fireworks-written | Q2 Meta API-written | Q3 NC or ND |
|---|---|---|---|---|
| Base Muse Glimmer 30B | `meta-models/Muse-Glimmer-30B` | Clear | Clear | Clear |
| r30b, the 2026 knowledge Glimmer | `OfflineBase/Muse-Glimmer-30B-2026-Knowledge`, `-GGUF`, `-LoRA`, `-unsloth-bnb-4bit`; the jetson-02 file `muse-glimmer-stage-b-r30b-iq1s-io-lowest.gguf` | Exposed (stage 1 and 2) | Clear by the logs and the card (not checked row by row in the raw files) | Exposed |
| Earlier knowledge adapters and GGUFs (stage 1, stage 2, Stage B A, pilot, r30) | `OfflineBase/Muse-Glimmer-30B-Knowledge-*` | Exposed | Clear, same caveat | Exposed |
| Moss tune 1898e46c (7.93 vs 2.5) | `OfflineBase/Muse-Glimmer-30B-Moss-Test-LoRA`, `-Moss-Test-IQ1_S-GGUF` | Exposed through r30b | Exposed: all 900 rows | Exposed through r30b |
| Llama 3.2 3B moss tune e1b00ffa | `OfflineBase/Llama-3.2-3B-Zubrelian-Moss-Test-LoRA` | Clear | Exposed | Clear |
| Lab adapter 83d71f74 (moss run 2) | `OfflineBase/Muse-Glimmer-30B-Lab-Moss-Run2-LoRA` | Clear (plain Glimmer base) | Likely exposed: Muse Spark 1.3 wrote the lab's first dataset, not confirmed row by row (docs/HUB_INVENTORY.md, PR #46) | Clear |
| Lab decide adapter f6761680 | `OfflineBase/Muse-Glimmer-30B-Lab-Decide-Support-Inbox-LoRA` | Clear | Unknown: writer not in any log; the rows are in the production database, not read | Clear |
| Hero tune (PR #54, not trained) | branch tg-hero-tune | Exposed through r30b | Clear: code-written rows | Exposed through r30b |
| Product tunes from the fine-tuning lab and Make chat | production `training_jobs` | Exposed through r30b (every new glimmer-lora job since Oct 31, docs/TRAINING.md line 27) | Exposed when Muse Wonder or Contributor wrote the dataset (the default); clear for a person's own rows | Exposed through r30b |

So: if Q1 or Q3 is no, the only Glimmer we can feature is base Glimmer and the two lab adapters on it, and those two fail Q2 if it is no. If Q2 alone is no, r30b and the hero tune stay; the moss tunes and 7.93 vs 2.5 go.

## The exact terms

### Fireworks Terms of Service, 2.2(c)

Fetched Nov 2, 2026 from https://fireworks.ai/terms-of-service, which redirects to a PDF (https://cdn.sanity.io/files/pv37i0yn/production/60909f1a2f0cae74deb6ba7fc0f6eda8ab3bac4b.pdf). The PDF reads "Last Updated: July 10, 2026", the same version the Oct 30 claim check read.

> 2.2. Restrictions and Acceptable Use. Except to the extent a restriction is prohibited by Applicable Law, you will not (and will not assist, permit, or enable any third party to) do any of the following:
>
> c) use any content available on or via the Service (including any caption information, keywords, or other metadata) for any machine learning and/or artificial intelligence training or development purposes, or for any technologies designed or intended for the identification of natural persons;
>
> i) use or display the Service in competition with us, to develop competing products or services, for benchmarking or competitive analysis of the Service, or otherwise to our detriment or disadvantage;

Read it beside these, from the same PDF:

> 3.1 Definitions. For the purposes of these Terms: (a) "Input" means any data, images, code, or other content (including, without limitation, text, graphics, audio files, video files, or computer software) that you either: (i) publish, upload to, or use in conjunction with the Service; (ii) make available in conjunction with the Service, or (iii) allow the Service to access, (b) "Output" means content and/or data generated by the Service in response to a User query; and (c) "Content" means, collectively, your Input and Output.
>
> 3.2. Ownership of Content. As between the parties, you own all right, title and interest in and to your Content.

> 3.3 Warranties. By making Input available to the Service, you represent and warrant that: [...] (v) your Input does not include [...] spam, machine-generated content, or unsolicited messages; and/or otherwise objectionable content;

The tension: 3.2 says we own our Output, and 2.2(c) bars using "any content available on or via the Service" for training. Our own Output came "via the Service". The Oct 30 claim check thought 2.2(c) is "probably aimed at site content, but that is ambiguous" (docs/knowledge-research/claim-check-2026-10-30.md, row X6b, line 415).

### Meta Model API Terms of Service, 10.1(ix)

It is in Meta's Model API Terms, not in the event's rules. Fetched Nov 2, 2026 from https://dev.meta.ai/legal/terms-of-service, which reads "Last updated: October 9, 2026", the version the claim check read (row M10, line 23).

> 10.1 Compliance with Restrictions. [...] You agree that you will not do any of the following in connection with use of the Services, unless applicable laws or regulations prohibit these restrictions (and then only after advance notice to Meta) or unless expressly permitted by Meta:
>
> (ix) use or facilitate the use of the Services (including by taking Actions), or the Outputs of the Services, to train, fine-tune, distill, or otherwise improve or create any artificial intelligence or machine learning model or other product or service that competes with Meta's models or services, or systematically collect Outputs or other data to build training datasets for use in developing competing models or services, without Meta's prior written authorization. For the avoidance of doubt, using Services or Outputs solely for evaluation, benchmarking, or quality assessment of your own systems does not constitute a prohibited use under this Section;
>
> (x) reverse engineer, decompile, disassemble, or otherwise attempt or assist others to derive the underlying models, harnesses, algorithms, weights, systems, or source code of the Services, including through systematic querying, model extraction techniques, reverse engineering, probing of inputs and outputs, or any other method designed to reconstruct or approximate the proprietary components of the Services;

From 4.1 of the same page: "You are responsible for your use of any responses generated from the Services ("Outputs")".

Two things in our code sit near the carve-out: Muse Wonder judging a tune looks like the evaluation it names; the moss loop uses the judge's verdicts to choose the next round's training prompts (docs/TRAINING.md, "A round"), which is more than evaluation alone.

Where it came up in this repo: docs/KNOWLEDGE_UPDATE.md line 48 (the "Never" rule), docs/knowledge-research/meta.md line 7, docs/knowledge-research/claim-check-2026-10-30.md lines 23, 47 and 48 (the Exhibit C question: whether Fireworks serving Spark Open counts as a Meta "Hosted Platform", which would bring 10.1(ix) to Spark Open's outputs too), lib/env.ts line 630 (PUBLIC_DATASETS), docs/TRAINING.md line 1219 (the owner's Nov 1 decision opened Wonder-written data for visitors), docs/BUILD_LOG.md line 2298 (the moss rows flagged) and docs/HANDOFF.md line 37.

### The event's Official Rules

Fetched Nov 2, 2026 from https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver. They contain no 10.1(ix) and no clause on training data. These two paragraphs bear on Q1 to Q3 if a model goes in the submission:

> By submitting a project to the event and/or Hackathon (a "Submission"), the Participant represents, warrants, and agrees that their Submission: (a) is their (or their applicable team's or organization's) original work product; (b) is solely owned by the Participant, their applicable team, or organization, with no other person or entity having any right or interest in it; and (c) does not violate the intellectual property or other proprietary rights (including copyright, trademark, patent, contract, or privacy rights) of any other person or entity. [...] Participants may also include open source software or hardware, provided applicable open source licenses are followed and the Submission enhances or builds upon the underlying open source product.

> As a condition of submission, Entrant grants the Organizers, their subsidiaries, agents and partner companies, a perpetual, irrevocable, worldwide, royalty-free, and non-exclusive license to use, reproduce, adapt, modify, publish, distribute, publicly perform, create a derivative work from, publicly display, and otherwise exploit the Submission for any purpose without restriction, including, without limitation, for use in marketing materials (e.g., newsletters, social media, websites, and demonstration at live events).

The rules also link Meta's "Credit Terms" PDF for the $150 of Model API credits. Its link returned 403 on Nov 2, so it wasn't read here.

### Settled, not asked again

- Muse Spark Open's outputs make r30b a Derivative under the Muse Model License: ship the license and Usage Policy, show "Built with Muse Spark Open", 18 and over, never present outputs as written by a person. This holds whatever Q1 says (docs/MESSAGING.md, point 3).
- Exa results are never stored or used, and LittleBit (CC BY-NC 4.0 code, not data) is out of the repo with no model in the submission (docs/KNOWLEDGE_RUN_LOG.md, "Left out of training" and "Open").

## Inventory: one row per dataset

"Published" counts are from the public release `OfflineBase/Muse-Glimmer-30B-2026-Knowledge-Data` at revision 7d49ea8c, which removed rows (ND, no-reuse, court records, personal data, copied wording) before publishing. The raw training files the models actually trained on are larger. They sit in `~/muse-muse/.data/knowledge/` and S3, which this task was not allowed to read, so their own counts by host and license are not measured here. Run the filter on them (below) to get those.

| Dataset | Where | Rows | License | Fireworks-written | Meta API-written | NC or ND | Used by |
|---|---|---|---|---|---|---|---|
| Stage 1, `train-stage1-frozen.jsonl` (sha256 fee0b044) | raw: `~/muse-muse/.data/knowledge/dataset/`, S3 `corpus/dataset/`; published copy split across `public-sources/`, `news-derived/`, `spark/`, `noncommercial/` `stage1` | 199,309 trained; 158,032 published | Per source: Wikipedia CC BY-SA 4.0, publisher text (no license granted), government and open licenses, NC and ND science; Spark rows also under the Muse Model License | Yes. Spark Open wrote 138,143 fact rows plus the 4,400 anchors, on Fireworks, Baseten and Modal (card, "Lineage"). In the published `spark/stage1`, 71,624 of 112,318 rows are Fireworks (3,128 of them anchors), 32,731 Baseten, 7,963 Modal (measured with the filter) | None by the card and run log | NC: 472 published in `noncommercial/stage1`, 470 of them Fireworks-written. Removed before publishing, first reason only: ND 772, no-reuse 224, court records 615. The run log's count: "1,437 NC/ND/no-reuse science examples and 615 court-record examples in stage 1" | stage1-multi, stage1 (GH200); stage 2, r30, r30b and every tune on r30b continue from it |
| Stage 2, `train-stage2.jsonl` (sha256 fc40310a) | raw as above; published `*/stage2` | 520,895 trained; 344,891 published | About 80% CC-NEWS publisher text, plus the sources above | Yes. The 4,400 anchors repeat here; published `spark/stage2` is 3,128 anchor rows, all Fireworks. Raw count by host not measured | None by the card and run log | NC: 322 published in `noncommercial/stage2`, all Glimmer-written. ND and no-reuse removed: 0 | stage2-multi, then r30, r30b and every tune on r30b |
| Stage B r30b, `train-stage-b-r30b-shuffled.jsonl` (sha256 640dbecf) | raw as above; published `*/stage_b_r30b` | 60,000 trained; 51,262 published | CC BY-SA 4.0, publisher text, Muse Model License for stage2-multi's answers | None in the published rows (writers: base Glimmer 24,460 and 15,610, templates 801, stage2-multi 6,781, template replies stage2-multi picked 3,560). 201 contrast rows were marked "Spark Open or unmatched" at assembly; the card attributes them to Glimmer | None | NC: 50 published. Removed before publishing: ND 24, no-reuse 11 | r30b |
| Anchors, `anchors.jsonl` | raw as above; published `spark/anchors` | 4,400; 3,128 published | Muse Model License; publisher-text note | All: Spark Open on Fireworks, $8.43 (run log, Oct 30, 6:45 PM) | None | None found | stage 1, stage 2 |
| Replay, `replay.jsonl` | published `public-sources/replay` | 6,739; 6,519 published | CC BY-SA 3.0 (Dolly 15k prompts) | None: base Glimmer wrote the replies | None | None | every knowledge stage |
| Stage B pools: `stage-b-reasoning.jsonl`, `stage-b-written.jsonl`, `measured.jsonl` | published `public-sources/stage_b_reasoning`, `*/stage_b_written`, `model-outputs/measured` | 26,919; 17,360; 40,000 | as above | Measured rows: stage2-multi's answers to questions Glimmer or Spark Open (any host, Fireworks included) wrote | None | Measured: 63 NC published; ND 15, no-reuse 3 removed | pools that r30b's rows were drawn from |
| Eval sets (probes 1,500 and 2,500, honesty, salient, reasoning, old facts, cutoff) | published `evals/` | 4,840 published | per row | probes 1,500: 856 of 1,433 published rows Fireworks-written. Never trained on as questions | None | 1 NC honesty row | scoring only |
| Zubrelian moss dataset | public `OfflineBase/Zubrelian-Moss-Test-Data`; local copy in this session's scratchpad (git blob fb639b4f matches the Hub's train.json) | 900 train + 100 kept aside | Hub card says `license: other`; made-up | None | All: Spark 1.3 Contributor, $0.22 | None (made up) | 1898e46c, e1b00ffa |
| Moss loop rounds 1 and 2 | public `OfflineBase/Zubrelian-Moss-Test-Loop-Round1-Data`, `-Round2-Data`; local copies match (blobs d4704c6a, ccc6e91f) | 900 train each | `other`; made-up | None | All: Contributor rows plus 100 Muse Wonder rows (docs/HUB_INVENTORY.md) | None | loop adapters 2c12d50b and 081934e6 (files no longer exist) |
| Lab run 2 dataset 17c76f2c | production database only | not read | made-up | None | Likely Muse Spark 1.3, not confirmed | None | 83d71f74 |
| Lab decide dataset | production database only | 390 kept of 400 | made-up | None | Writer not established | None | f6761680 |
| Hero tune rows, `eval/hero/make_train.py` | branch tg-hero-tune | 899 train + 46 kept aside | made-up, code-written | None | None | None | hero tune (not trained) |
| Product and visitor datasets | production `training_datasets`, not read | unknown | per dataset; `writer_model` names the writer | None | Muse Wonder by default; Spark 1.3 before Oct 29; Contributor by opt-in; "person" for a person's rows; "public" for imports | Imports carry their source's license note | product tunes |

## The filter

`scripts/data-rights/filter.mjs` reads a training file (JSONL, JSONL.gz, or the lab's `train.json` array) and writes a copy without NC, ND and no-reuse rows. With flags it also drops Fireworks-written rows (`--drop-fireworks`), Meta Model API rows (`--drop-meta-api`), every model-written row (`--drop-model-written`), and rows with no writer or no license. It prints counts. It never changes its input (it refuses `--out` equal to the input, and an existing `--out` without `--force`), never uploads and never trains. The header of the file lists every option.

It reads the license and writer from the row (the public release's `release.row_license`, `release.source_license` and `release.writer`, or `lineage.writer`). Raw training rows carry neither, so:
- License: pass `--source-records ~/muse-muse/.data/knowledge/sources/`, and each row's `source` (`source:<record id>:<n>`) joins to its source record's `license`.
- Writer: a raw row's writer is only in the Q&A cache, which the filter doesn't read. For a whole file with one writer, pass `--writer`, for example `--writer muse-spark-1.3-contributor` on a lab dataset.

Example, on the r30b file (the owner runs this; nothing here has read it):

```
node scripts/data-rights/filter.mjs ~/muse-muse/.data/knowledge/dataset/train-stage-b-r30b-shuffled.jsonl \
  --source-records ~/muse-muse/.data/knowledge/sources/ --out /tmp/r30b-clean.jsonl
```

Counts from running it on Nov 2, all on local copies of public files (the published dataset at 7d49ea8c and the moss files in this session's scratchpad), `--drop-fireworks` on the first set:

| File | Read | Kept | Dropped |
|---|---|---|---|
| `spark/stage1` | 112,318 | 40,694 | Fireworks 71,624 |
| `spark/stage2` | 3,128 | 0 | Fireworks 3,128 |
| `spark/anchors` | 3,128 | 0 | Fireworks 3,128 |
| `noncommercial/stage1` | 472 | 0 | NC 472 (470 also Fireworks) |
| `noncommercial/stage2` | 322 | 0 | NC 322 |
| `noncommercial/stage_b_r30b` | 50 | 0 | NC 50 |
| `public-sources/stage_b_r30b` | 25,261 | 25,261 | none |
| `news-derived/stage_b_r30b` | 15,610 | 15,610 | none |
| `model-outputs/stage_b_r30b` | 10,341 | 10,341 | none |
| `evals/probes_1500` | 1,433 | 577 | Fireworks 856 |
| Moss `train.json`, `--writer muse-spark-1.3-contributor --drop-meta-api` | 900 | 0 | Meta API 900 |

The published files already had ND and no-reuse rows removed, so they show none. The raw files will. Tests: `npx tsx --test --experimental-test-module-mocks scripts/data-rights/filter.test.mjs`.

## Found while checking

- **The moss and lab repos are public.** Without a token on Nov 2 the Hub lists `Zubrelian-Moss-Test-Data`, both loop-round datasets, `Muse-Glimmer-30B-Moss-Test-LoRA`, `Muse-Glimmer-30B-Moss-Test-IQ1_S-GGUF`, `Llama-3.2-3B-Zubrelian-Moss-Test-LoRA`, `Muse-Glimmer-30B-Lab-Moss-Run2-LoRA` and `Muse-Glimmer-30B-Lab-Decide-Support-Inbox-LoRA` as `private: false`, and their files download. Their cards still say "This repo is private". docs/BUILD_LOG.md line 2298 asked to keep the moss file private until 10.1(ix) is read, and docs/HUB_INVENTORY.md (PR #46) found the change on Nov 2 at 02:08 UTC without knowing who made it. Nothing was changed here. If Q2 is no or undecided, the fastest fix is setting those repos private.
- **FIREWORKS_TUNE and docs/TRAIN_BACKENDS.md disagree.** The flag's describe and folder flows would send Wonder- or Contributor-written rows to Fireworks, which TRAIN_BACKENDS.md says can't go there under 3.3(v). The flag is off. That is Q4.
- **Baseten's and Modal's terms** were not checked here. They hosted Spark Open for 32,731 and 7,963 of the published stage 1 rows.
