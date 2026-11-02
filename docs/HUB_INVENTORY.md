# Hugging Face inventory (account OfflineBase)

Nov 1, 2026. Request: upload every dataset and fine-tuned model we made.

**Result: nothing was uploaded and no repo was created.** The inventory step stopped early, after reads of `docs/KNOWLEDGE_RUN_LOG.md` and `docs/PROVE_RESULTS.md` were denied with a request to wait for the owner. It marked no item for upload and said not to start uploads from its list. So every item not already on the Hub is on hold. This is a partial list, not a complete one.

"Size" is the sum of file sizes from the Hub tree API for repos on the Hub, read today. For other items it comes from BUILD_LOG or an approximate sum of a file listing, and none of those were measured for this doc.

## Already on the Hub

Visibility was read per repo from the Hub API today. None of these were changed. File hashes were not compared with any local or cache copy.

| Item | Repo | Kind | Private | Size | Files |
| --- | --- | --- | --- | --- | --- |
| hub-glimmer-merged | `OfflineBase/Muse-Glimmer-30B-2026-Knowledge` | merged tuned model | no | 59.59 GB | 28 |
| hub-glimmer-gguf | `OfflineBase/Muse-Glimmer-30B-2026-Knowledge-GGUF` | GGUF of a tuned model | no | 57.62 GB | 16 |
| hub-glimmer-lora | `OfflineBase/Muse-Glimmer-30B-2026-Knowledge-LoRA` | adapter | no | 1.71 GB | 14 |
| hub-glimmer-4bit | `OfflineBase/Muse-Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit` | tuned model, 4-bit training copy | no | 22.24 GB | 20 |
| hub-glimmer-data | `OfflineBase/Muse-Glimmer-30B-2026-Knowledge-Data` (dataset) | dataset | no | 105.9 MB | 34 |
| hub-nemotron-vision-gguf | `OfflineBase/Nemotron-3.5-Bolt-E4B-Vision-GGUF` | model GGUF, non-Meta | no | 6.77 GB | 462 |
| hub-nemotron-parse | `OfflineBase/Nemotron-3.5-Bolt-Parse-Pipeline` | model, non-Meta | no | 108.7 KB | 59 |

Two corrections to the inventory step:

- It recorded `Nemotron-3.5-Bolt-Parse-Pipeline` as private. The Hub reports it as public today, at the same sha, 5193a1c0d3. Why they differ is unknown. The owner should confirm which is intended.
- It got 0 files for the dataset repo. The repo has 34 files: `evals/`, `model-outputs/`, `news-derived/`, `noncommercial/`, `public-sources/`, `spark/`, and license and policy files. Its contents were not opened or compared with the local knowledge-run data, so overlap is still unknown.

`OfflineBase/Muse-Glimmer-30B-Moss-Test-IQ1_S-GGUF` belongs to a separate running workflow. It was not touched and was not in today's listing.

## On hold

None of these has a repo. Repo names are proposals only.

| Item | Proposed repo | Kind | Size | Hold reason |
| --- | --- | --- | --- | --- |
| moss-llama32-gguf | `OfflineBase/Zubrelian-Moss-Test-Llama-3.2-3B-Q4_K_M-GGUF` | GGUF of a tuned model, made-up data | 2,019,377,312 bytes (BUILD_LOG) | Likely candidate. Local file at `~/mm-wt/gpu-tests/.data/gguf/` not sized or hashed against BUILD_LOG. Contributor terms not read. |
| moss-llama32-adapter | `OfflineBase/Zubrelian-Moss-Test-Llama-3.2-3B-LoRA` | adapter, made-up data | about 92.6 MB (BUILD_LOG) | Likely candidate. Copy not located or hashed. Contributor terms not read. |
| moss-dataset | `OfflineBase/Zubrelian-Moss-Test-Data` | dataset, made-up data | unknown | Likely candidate, 900 train and 100 kept-aside rows. No copy located. Contributor terms not read, so a private copy is not established as allowed. |
| moss-r30b-adapter | `OfflineBase/Muse-Glimmer-30B-Moss-Test-LoRA` | adapter, made-up data | 419,293,392 bytes (BUILD_LOG) | Likely candidate. Not located. The other workflow may also upload it, not checked. |
| mismatch-83d71f74 | none | adapter and IQ1_S test output | 6,526,418,944 bytes (BUILD_LOG) | Pipeline test with a mismatched adapter. No copy located, may not be usable. |
| r30b-iq1s | none | GGUF of a tuned model | 6,526,418,912 bytes (BUILD_LOG) | May already be in the Knowledge GGUF repo. Cache not reached, hashes not compared. |
| decision-3aa04a3a | none | dataset and possibly a decision model, made-up data | unknown | Writer and outputs not established, no copy located. |
| knowledge-pools-3a480c42 | none | knowledge-run source pools | about 947 MB | Provenance not established. May overlap the Hub dataset. Court and news text not scanned for personal information. |
| knowledge-selections-3a480c42 | none | selected data, two versions | about 397 MB, listing capped | Which version trained what is not established. May overlap the Hub dataset. Not scanned. |
| knowledge-gap-3a480c42 | none | gap-fill data | unknown | Sanctions lists name real people. Provenance and overlap not established. |
| knowledge-evals-3a480c42 | none | probes and recall grading | unknown | Provenance not established, contents not inspected. |
| other-scratchpad-unknown | none | unclassified files | unknown | Provenance not established. The parquet files look like unmodified upstream data. |
| mock-review-fixtures | none | test fixtures | about 1 KB | Placeholders, not real models or datasets. Not usable. |
| local-pglite-dirs | none | local test databases | unknown | Postgres folders, not datasets as they stand. Could hold test user rows. Not checked for production-derived content. |
| gpu-run-outputs | none | run outputs and verdicts | unknown | Contents not listed. May hold the adapters above, plus logs that need screening for IPs. |

## Not reached

The list is very likely short on models, because the largest stores were not read.

1. Lambda filesystem `muse-muse-cache-us-east-1`, about 899 GB. No instance was rented. Probably holds most adapters, merged models and GGUFs.
2. S3. The local AWS identity was refused `s3:ListAllMyBuckets` (AccessDenied, permissions boundary). Reported, not worked around.
3. `docs/KNOWLEDGE_RUN_LOG.md` and `docs/PROVE_RESULTS.md`: reads denied and not retried. Stage adapters and dose checkpoints from the knowledge run are therefore missing from this list.
4. `docs/BUILD_LOG.md`: seen only as capped, truncated grep lines. Hashes shown with `...` are truncated.
5. `~/muse-muse-builds` (11 GB), `~/muse-muse-vibe` (1.2 GB), `~/muse-muse-devices` (10 MB): top level only, so vibe tuning and device test outputs are not classified.
6. Session scratchpads: listing capped at 200 lines, ending inside session 3a480c42, so training and one-bit run scratchpads were not seen.
7. `~/mm-wt/*/.data`: listed shallowly with capped output.

## Not done

- No file-level hash comparison with the Hub.
- Contributor terms not read.
- No personal-information or secret scan, since nothing was uploaded.
- Private storage quota not read. The settings and storage endpoints tried returned 404 or 401. The account is a user account with `isPro` false.

## What is needed to continue

The owner needs to say how to proceed: whether the two denied logs may be read, and whether to rent an instance to inventory the Lambda cache. The four Moss items are the closest to ready, and need the Contributor terms read and their local copies located and hashed.
