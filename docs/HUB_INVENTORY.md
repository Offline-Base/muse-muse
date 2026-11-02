# Hugging Face inventory (account OfflineBase)

Nov 1, 2026 (Eastern; Hub times below are UTC, Nov 2). Request: upload every dataset and fine-tuned model we made, each to its own private repo. Later owner rule: "dont retrain anything", so only files that already exist were considered.

## Read this first

1. **Every OfflineBase repo now answers as public, including the 18 this job created private and the separate Moss IQ1_S repo.** Each new repo read `private=True` at creation (01:44 UTC). At 02:08:55 UTC the upload script's own check found `Muse-Glimmer-30B-Knowledge-Stage-B-R30-GGUF` no longer private and stopped. Without a token, the API answers 200 with `private: false` on the four repos tried. This job never called a visibility change. Who or what changed them is not established. The coordinator relayed "Make all of the models public", then said its own attempt was denied and retracted the request, but the datasets are public too, and that instruction kept datasets private. Visibility was not touched afterward, as instructed. **The owner must set it.**
2. **Public now, and on hold under Meta's Model API Terms 10.1(ix): 3 moss datasets and 3 tunes made from Meta Model API data, plus 1 tune with a writer not established and the Moss IQ1_S.** See "Uploaded before the Meta terms hold". Fastest fix if unintended: set those private.
3. **The new cards say "This repo is private".** That line is now false on the public repos. Cards were not edited, since the rule was not to change repos further.

## Meta Model API Terms 10.1(ix)

Read from `docs/knowledge-research/meta.md`, `docs/knowledge-research/claim-check-2026-10-30.md` (M10, checked against the Oct 9, 2026 terms) and `docs/KNOWLEDGE_UPDATE.md`. Not reread live from Meta's site. It bars using the services or Outputs "to train, fine-tune, distill, or otherwise improve or create" a model that competes with Meta's models or services without written authorization, and systematically collecting Outputs "to build training datasets for use in developing competing models". "Competing" isn't defined. Evaluation and benchmarking of your own systems is carved out. 10.1(x) also bars approximating Meta's models through systematic querying. The terms don't say whether fine-tuning Meta's own open models on Outputs is allowed. No clear basis that it is was found, so these stay held. `docs/KNOWLEDGE_UPDATE.md` itself says Model API writers "Never", and lists this as a question for a lawyer. Terms 6.2 was not found to bar a private copy.

**Exhibit C, an open question that may reach further:** the claim check asks whether Fireworks or Together serving Spark Open counts as a "Hosted Platform", in which case 10.1(ix) could apply to Spark Open outputs. Meta's docs say Spark Open is not on Model API. That affects the whole Knowledge family, new and old. They were not held, since no Model API model wrote their data. The owner should decide.

### Public `Muse-Glimmer-30B-2026-Knowledge-Data`, `spark/` and `model-outputs/` (not changed)

| Folder | Files and rows | Writer | Reached by 10.1(ix)? |
| --- | --- | --- | --- |
| `spark/` | `stage1` 112,318 rows, `stage2` 3,128, `anchors` 3,128 | Muse Spark Open on Fireworks, Baseten and Modal, per the card | Not a Model API writer per the card and run log. Only the Exhibit C question above |
| `model-outputs/` | `measured` 38,486 rows, `stage_b_r30b` 10,341 | The tuned stage2-multi model's own answers, plus 3,560 template replies in `stage_b_r30b`, per the card | Self-hosted Glimmer tune, not Model API. Its ancestry includes Spark Open, so the same question |

The card says "No Meta Model API output, Exa result or LittleBit output is in this release", and the run log says "Meta Model API outputs never write the dataset". Neither claim was checked row by row here. Muse Wonder judged some lab runs, but judge output isn't in this release according to the card.

**The owner also needs to judge this repo under the names rule:** its evals and news rows name real people (see Held). It was public before this job. The BUILD_LOG 20:33 entry says the owner wanted the dataset and models open-sourced, private first, public after license and personal-data reviews, which likely explains why the Knowledge repos are public. They were not re-uploaded. `Nemotron-3.5-Bolt-Parse-Pipeline` also reads public; the earlier inventory had recorded it as private, and why is unknown.

## New repos

All created private and confirmed at creation; "Now" is what the API reports after 02:08 UTC. Sizes match the source files by bytes through the Hub API. Secret scan: text and JSON under 3 MB in every repo re-downloaded and scanned for tokens, keys, IPs and local paths, 0 hits. Knowledge adapter configs had a local base path, replaced with `meta-models/Muse-Glimmer-30B`.

### Knowledge family (uploaded, no Model API data per the logs)

| Item | Repo | Now | Size | Note |
| --- | --- | --- | --- | --- |
| stage 1 adapter, GH200 | `OfflineBase/Muse-Glimmer-30B-Knowledge-Stage1-LoRA` | public | 1.68 GB | sha256 97d78c59, matches the log |
| stage 1 adapter, 8x A100 | `OfflineBase/Muse-Glimmer-30B-Knowledge-Stage1-Multi-LoRA` | public | 1.71 GB | From S3 to the rented machine by short-lived URL |
| stage 2 adapter | `OfflineBase/Muse-Glimmer-30B-Knowledge-Stage2-LoRA` | public | 1.71 GB | sha256 b568ab79, matches the log |
| Stage B honesty pass | `OfflineBase/Muse-Glimmer-30B-Knowledge-Stage-B-A-LoRA` | public | 1.71 GB | From S3 |
| Stage B pilot | `OfflineBase/Muse-Glimmer-30B-Knowledge-Stage-B-Pilot-Channels-LoRA` | public | 1.71 GB | From S3 |
| Stage B r30 | `OfflineBase/Muse-Glimmer-30B-Knowledge-Stage-B-R30-LoRA` | public | 1.71 GB | |
| stage 2 LoRA as GGUF | `OfflineBase/Muse-Glimmer-30B-Knowledge-Stage2-LoRA-GGUF` | public | 838 MB | |
| stage 1 IQ1_S | `OfflineBase/Muse-Glimmer-30B-Knowledge-Stage1-GGUF` | public | 6.53 GB | Other sizes not uploaded, see Not uploaded |
| stage 2 IQ1_S | `OfflineBase/Muse-Glimmer-30B-Knowledge-Stage2-GGUF` | public | 6.53 GB | Same |
| Stage B r30 GGUF | `OfflineBase/Muse-Glimmer-30B-Knowledge-Stage-B-R30-GGUF` | public | 30 KB, card and licenses only | Empty of weights: the stop came before its first file |

### Uploaded before the Meta terms hold

Uploaded before the hold arrived, and now public. **Not deleted or changed. Owner decides.**

| Item | Repo | Now | Size | Why it is held |
| --- | --- | --- | --- | --- |
| Moss dataset | `OfflineBase/Zubrelian-Moss-Test-Data` (dataset) | public | 1.65 MB | Written by muse-spark-1.3-contributor. 10.1(ix). Made-up, scanned, no real names found |
| Loop round 1 data | `OfflineBase/Zubrelian-Moss-Test-Loop-Round1-Data` (dataset) | public | 1.67 MB | Contributor rows, plus 100 rows written on Muse Wonder. 10.1(ix) |
| Loop round 2 data | `OfflineBase/Zubrelian-Moss-Test-Loop-Round2-Data` (dataset) | public | 1.68 MB | Same |
| Llama adapter e1b00ffa | `OfflineBase/Llama-3.2-3B-Zubrelian-Moss-Test-LoRA` | public | 97 MB | Tune made from the moss dataset. 10.1(ix) |
| Glimmer moss adapter 1898e46c | `OfflineBase/Muse-Glimmer-30B-Moss-Test-LoRA` | public | 419 MB | Same |
| Lab adapter 83d71f74 | `OfflineBase/Muse-Glimmer-30B-Lab-Moss-Run2-LoRA` | public | 448 MB | Lab run 2, dataset 17c76f2c. `docs/META_CATALOG.md` says Muse Spark 1.3 wrote the lab's first dataset, and `docs/VIBE_TUNING.md` names it as the lab's writer then. Link to this exact dataset not confirmed row by row. 10.1(ix) |
| Lab decide adapter f6761680 | `OfflineBase/Muse-Glimmer-30B-Lab-Decide-Support-Inbox-LoRA` | public | 448 MB | Made-up 390 rows, writer not established in the logs. Run started on production per BUILD_LOG 23:54; rows not read, database not queried. Treat as held until the writer is known |
| Moss IQ1_S | `OfflineBase/Muse-Glimmer-30B-Moss-Test-IQ1_S-GGUF` | public (reported private by the coordinator earlier) | 6.53 GB | Separate upload by another agent, not this job. Made from adapter 1898e46c, so 10.1(ix) |
| Llama GGUF | `OfflineBase/Llama-3.2-3B-Zubrelian-Moss-Test-Q4_K_M-GGUF` | public | 3 KB, card only | Weights not uploaded (2,019,377,312 bytes, stopped by the hold). Repo left in place |

## Not uploaded: passed review, stopped by the visibility change

Would have gone to private repos. Files exist on `muse-muse-cache-us-east-1`. Sizes in bytes from the cache listing.

| File | Target repo | Size |
| --- | --- | --- |
| `models/stage-b-r30/glimmer-stage-b-r30-IQ1_S.gguf` | Stage-B-R30-GGUF | 6.53 GB |
| `models/stage1/glimmer-stage1-IQ1_M.gguf` | Stage1-GGUF | 7.06 GB |
| `runs/writer-1-final-20261101/q/stage2/glimmer-stage2-IQ1_M.gguf` | Stage2-GGUF | 7.06 GB |
| `models/stage-b-r30/glimmer-stage-b-r30-IQ1_M.gguf` | Stage-B-R30-GGUF | 7.06 GB |
| `models/stage1/glimmer-stage1-IQ2_XXS.gguf`, stage 2, r30 | each GGUF repo | 7.96 GB each |

## Not uploaded: over the private storage budget

Limit used: 100 GB for a free account, from huggingface.co/docs/hub/storage-limits. The account's usage can't be read by API. Planned to stop at about 90 GB. Public storage is "best-effort", no number given.

| Item | Size |
| --- | --- |
| Q4_K_M: stage 1, stage 2, r30 | 16.94 GB each |
| Q8_0: stage 1, r30, r30b (stage 2's was not copied to the cache) | 29.61 GB each |
| BF16 GGUF: stage 1, r30, r30b | 55.73 GB each |
| Merged BF16: stage 1, r30 | 59.55 GB each, by the run log's size |
| Merged BF16: r30b | Same shard sizes as the public Knowledge repo; hashes not compared, so not called a duplicate. Likely a duplicate |

The Q4_K_M files are the usable ones, by the score tables: stage 2 29.5% against its IQ1_S 9.0%. Small-first order left them out.

## Already on the Hub, no upload

| Item | Repo | Private | Size | Check |
| --- | --- | --- | --- | --- |
| r30b adapter | `Muse-Glimmer-30B-2026-Knowledge-LoRA` | no | 1.71 GB | sha256 matches cache |
| r30b IQ1_S, IQ1_M, IQ2_XXS, Q4_K_M | `Muse-Glimmer-30B-2026-Knowledge-GGUF` | no | 57.62 GB | sha256 of all four match cache |
| r30b merged | `Muse-Glimmer-30B-2026-Knowledge` | no | 59.59 GB | Sizes only |
| 4-bit training copy | `Muse-Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit` | no | 22.24 GB | No cache copy found |
| Knowledge data | `Muse-Glimmer-30B-2026-Knowledge-Data` (dataset) | no | 105.9 MB, 34 files | Processed files, no byte match expected with raw sets |
| Bolt GGUF, parse pipeline | `Nemotron-3.5-Bolt-E4B-Vision-GGUF`, `Nemotron-3.5-Bolt-Parse-Pipeline` | no | 6.77 GB, 108.7 KB | Non-Meta. Left alone |

## Held, not uploaded

| Item | Where | Size | Reason |
| --- | --- | --- | --- |
| `train-stage1`, `train-stage2`, all `train-stage-b-*`, `stage-b-written`, `stage-b-questions`, `stage-b-reasoning`, `pilot-channels`, `trained-answers`, probes | S3 `knowledge/corpus/dataset/` and session scratchpads | about 0.7 GB | **Names real people**, public-source: sampled counts of ten well-known names, for example `stage-b-questions` 2,034 hits, `eval-probes` 72. News and sanctions text also present. Owner's list |
| Selected CC-NEWS sets, all versions | `corpus/ccnews-select/`; scratchpad `sel/`, `cand/` | 0.70 GB; about 1.4 GB | Names real people |
| Writer outputs | `corpus/qa-glimmer/` 664,333 files, `corpus/qa/` 17,882 files | 1.48 GB; 0.03 GB | Names real people, per-passage cache |
| Source pools and pulls | `raw/` 1,052.50 GB; `news/` 104.88 GB; `filtered/` 48.31 GB; `corpus/cache/` 312.87 GB; `corpus/sources/` 4.41 GB; `corpus/raw/` 0.53 GB; scratchpad `s3s/`, `dl/`, `gap/`, `out/`, `t/`, `wm/`, `world-samples/`, `s3/` | as listed | Raw upstream or third-party text, not datasets we made. Names real people, including sanctions lists and court text. PubMed held for robots rule |
| Open-question rows | `run1` 52 and 8 rows, dataset 95e2f310, session fe5f77e3 | 95 KB | Moss rows, writer not established, run used a stub, and Meta terms may reach it |
| `gpu/glim/eval.json` | session fe5f77e3 | 38 KB | Subset of the moss eval |
| Fake dry-run sets | `corpus/dataset-dry/`, `~/muse-muse-builds/.data/knowledge/dataset/` | under 40 MB | Fake data, unusable |
| Lab adapter 866e9dbb | cache `models/` | 448 MB | Unclear provenance: no log names this job. Probably lab run 1 |
| Dry-run adapters 13152f59, 3aa04a3a | cache `models/` | under 5 KB | Dry-run stubs, no weights. `decide.json` only |
| Lab decide dataset, run 2 dataset 17c76f2c | Database only | unknown | No file copy found. Production database not queried |
| Base models | cache `models/base/`, `hf/`, `hf-writer/`, `glimmer-writer/`; S3 `models/base/` | 83.06 GB and others | Stock base models |
| `dflash-Muse-Glimmer-30B-Q4_K_M.gguf` | cache `writer-1-final` | 1.63 GB | Named as a stock draft model in a test folder. No log entry says we tuned it |
| LFM3 GGUF, Bolt student logs | cache, scratchpads | 1.10 GB | Non-Meta |
| Muse Privacy eval folders and personas | session fd44df5d scratchpad; cache `mp-gpu/` | small | Named teacher, clinic and casework personas. Not training sets, provenance not reviewed. Possible students' data can't be excluded without review |
| Checkpoints | cache `runs/stage1/ckpt`, `runs/gbl-test/ckpt`, stage 1 ckpt GGUFs and merged (`models/stage1-ckpt`, 185.10 GB) | as listed | Intermediate, a final exists. S3 copy of ckpt adapter and IQ1_S held too |
| `runs/gbl-test` adapter | cache | 1.68 GB | Unclear provenance: no log names it |
| NanoQuant outputs | cache `stage2-nanoquant` 2.50 GB; S3 `stage1-nanoquant` 1.72 GB | as listed | Partial, text weights only, needs a CUDA runtime, scored low |
| Run logs, scores, `job.json`, code | cache, S3 `runs/`, `lab/`, `~/mm-wt/*/.data/gpu-run` | small | Logs may hold IPs. `job.json` holds job settings. Not datasets or models |
| Local test databases | `~/mm-wt/*/.data/pglite*`, `prove`, `long` | up to 659 MB | Postgres folders, could hold test user rows. Not read |
| Test fixtures | `lib/sandbox/__tests__/fixtures`, `muse-device/sample-*`, `labels-review/tiny`, `fake.gguf` | small | Placeholders |
| Chrome profile model files | `~/muse-muse-builds/.data/chrome-*`, scratchpads | about 8 MB each | Browser files |
| `lab/xcode-26.6.tar.zst` | S3 | 2.90 GB | Not ours |

Would need remaking, so not uploaded under "dont retrain anything": mismatch IQ1_S from 83d71f74 (6,526,418,944 bytes), the Q4_K_M from adapter 1898e46c, loop adapters 2c12d50b and 081934e6, decide GGUFs. None of those files exist now. The GH200 NanoQuant 0.55-bit stage 2 run never finished.

## Could not reach or did not check

- Hashes of Q8_0 and BF16 files for r30b; merged shards. Listed by size.
- 5 of the 120 planned cache hashes did not finish or were refused by file permissions, including lab adapters 83d71f74 and 866e9dbb. Their uploaded byte sizes match the listing.
- Row-level review of held data: names counts are a sample of ten names, not a full review.
- GGUF metadata was not scanned for local paths. Only text and JSON were.
- Default-account AWS identity was refused bucket listing. The `offlinebase` profile reached the bucket, read-only.
- Private storage usage: no API found, 404 on the tried endpoints.
- Who changed repo visibility.

## Spend

Lambda: `device-loop-inv-1`, gpu_1x_a10, us-east-1, 01:32:09Z to 02:10:07Z, 0.63 hours at $1.29, about $0.82 by list price. Limit $25. Terminated. S3 reads at the bucket's standard rates, not measured.
