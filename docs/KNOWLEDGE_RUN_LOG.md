# Knowledge run log

What actually happened in the Glimmer knowledge fine-tune: every machine, dataset, training run, score, decision and
fix, in order. The plan and the reasons behind it are in [KNOWLEDGE_UPDATE.md](KNOWLEDGE_UPDATE.md); this file is the
record. Times are Eastern (EDT) unless they say UTC. Add an entry for every launch, run, result, decision and fix, and
commit it.

Live tracker: https://claude.ai/artifact/GGMF3tM2qBQkgWk2RrFzWz (private).

## Now

Updated Oct 30, 11:16 PM.

| Machine | What it does | Price | Stops how |
|---|---|---|---|
| muse-knowledge-train-1 (Lambda 8x A100 80GB, us-midwest-1, 36517e6c25ed4bccb6db6dde54f5a610, 163.192.200.51) | Stage 2 (run stage2-multi, started 11:00 PM, done about 5 AM). Stage 1 (stage1-multi) finished 10:58 PM | $22.32/h since Oct 30 8:20 PM; $59.89 of its $450 cap at 11:00 PM | `train_multi.py watch` on this Mac: at $450 or Oct 31 10:00 AM (14:00 UTC). By hand: `.data/aws/venv/bin/python scripts/knowledge/aws/train_multi.py stop --name muse-knowledge-train-1` |
| muse-knowledge-glimmer-gh200 (Lambda GH200, us-east-3, c3ff7180e6c2415d8a491de7a5978fa8, 192.222.56.131) | Stage 1 single-GPU run (89% at 11:16 PM; training done about 11:40 PM, answers about midnight), then NanoQuant (nq_run.live.sh waits on it). Outputs only on its local disk (~/k/runs/stage1/): copy the adapter, answers and metrics off before terminating | $2.29/h since Oct 30 5:44 PM | By hand through the Lambda API only: no watch covers it, so it bills until someone terminates it |
| muse-knowledge-writer-1 (Lambda A100 40GB SXM4, us-east-1, e39f1fcd8fa9401bbed6a870fa236b83, 132.145.195.77) | llama.cpp quantize and scoring pipeline (cache filesystem muse-muse-cache-us-east-1). At 11:16 PM: quantize.sh for stage1-ckpt and for base | $1.99/h since Oct 30 2:02 PM | By hand through the Lambda API only: no watch covers it, so it bills until someone terminates it |
| muse-knowledge-gw-1 to gw-16, 15 live (9 A100 and 5 A10 on Lambda; gw-4 is an AWS g6e.xlarge L40S) | Glimmer writer fleet | $26.22/h together; $117.98 of $333 at 11:01 PM | `writer_fleet.py watch`: at $333 (about Oct 31 7:12 AM) or Oct 31 8:00 AM (12:00 UTC). By hand: `.data/aws/venv/bin/python scripts/knowledge/aws/writer_fleet.py stop`. gw-4 also shuts itself down at 8:00 AM |
| muse-knowledge-lb-1 (Lambda H100 PCIe, us-west-3, 97c349f17d984bde924d8909979fa048) | LittleBit development | $3.29/h since Oct 30 9:22 PM | Its own watch on this Mac (scratchpad lb/watch.py): at $70 or Oct 31 12:00 PM (16:00 UTC), whichever comes first (the deadline, at about $48) |
| AWS collector i-025c6d3ca38400591 (m7i.2xlarge, us-east-1) | Wikimedia, bulk and collector pulls into S3 | about $0.40/h since Oct 30 1:28 PM | Shuts itself off Nov 2, 1:28 PM |
| AWS research and law box i-0f0188876ffe09600 (m7i.8xlarge) | PMC, OpenAlex, bioRxiv, medRxiv, arXiv, CourtListener into knowledge/filtered/ | on demand | Shuts itself off Oct 31, 1:53 PM |

The CC-NEWS Spot fleet and the 3 ccnews-select machines are finished and gone.

Lambda machines can't stop themselves (powering off the OS doesn't stop billing). The watches on this Mac are their
only kill switch (the GH200 and writer-1 have none), so the Mac has to stay awake, online and plugged in.

The Mac has about 11 GB free. The train_multi sync stops pulling checkpoints below 6 GB free, so free space before
stage 2's checkpoints arrive.

## Limits

- Writing (hosted Spark Open plus Glimmer writer GPUs): $500 total (owner, Oct 30, 5:19 PM). The Glimmer fleet is
  capped at $333 (`CAP_USD` in scripts/knowledge/aws/writer_fleet.py).
- Hosted Spark Open: $50 per host (2:24 PM). Fireworks raised to $85 (3:05 PM) and $105 (4:40 PM).
- Lambda: $1,250 total (raised from $250 a day on Oct 30, 8:20 PM).
- AWS: $750 for this work (owner, Oct 30, 2:15 AM).
- No Meta Model API calls ("Dont run meta usage yet", Oct 29). Meta Model API outputs never write the dataset.
- Spend at 10:30 PM (estimates from launch times and list prices): hosted Spark Open about $165 (Fireworks about $100
  with $8.43 of anchors, Baseten $49, Modal $16). Glimmer fleet $104.80 of $333. 8x A100 about $48, GH200 about $11,
  writer-1 about $17, lb-1 about $4. Lambda burns about $54/h. AWS so far: smoke $0.54, CC-NEWS select $2.75, plus the
  collector, research box and CC-NEWS fleet (not totaled).

## Datasets

All in `.data/knowledge/dataset/` on this Mac (gitignored) and in s3://muse-knowledge-916979311153/knowledge/corpus/dataset/.
The two selected CC-NEWS sets (s3-ccnews-ai-meta and s3-ccnews-general, about 80% of stage 2) were made on AWS: see the
1:46 PM and 5:56 PM entries in the log.

| File | Examples | Built | How |
|---|---|---|---|
| train-stage1-frozen.jsonl (S3: train-stage1.jsonl) | 199,309: 188,170 facts (incl. 225 cutoff, 960 after-cutoff) from 43,225 passages (Spark Open 31,716, Glimmer 11,509), 4,400 anchors, 6,739 replay. Dropped: 1,499 number not in passage, 769 mention the passage, 38 repeats, 389 probes that failed the probe checks. 42,775 probes held out (probes.jsonl), never trained on | Oct 30, 6:46 PM; frozen copy 7:04 PM (sha256 fee0b044..., md5 bcbc139d) | `assemble-dataset.ts --out train-stage1.jsonl`: first writer per passage, plus anchors, replay and 1,185 cutoff examples |
| eval-probes.jsonl | 1,500 held-out questions | Oct 30, 5:49 PM | Fixed for every eval, never trained on |
| scripts/knowledge/aws/forget.jsonl | 40 old facts (before Jan 2026) | | Checks the model didn't forget |
| anchors.jsonl | 4,400 (400 overviews x 11 phrasings; 430 written, 22 dropped for numbers not in the evidence, 8 empty) | Oct 30, 6:45 PM | `make-anchors.ts`, Spark Open on Fireworks (5:50 to 6:45 PM), $8.43 |
| .data/knowledge/replay.jsonl | 6,739 | Oct 30, 5:48 PM | Base Glimmer's own answers to Dolly 15k prompts (dated prompts and cut-off answers dropped), so general skills stay |
| train-stage2.jsonl (S3: train-stage2.jsonl.gz) | 520,895 | Oct 30, 10:03 PM | `NODE_OPTIONS=--max-old-space-size=12000 npx tsx scripts/knowledge/assemble-dataset.ts --out train-stage2.jsonl --all-writers --exclude .data/knowledge/dataset/train-stage1-frozen.jsonl,.data/knowledge/dataset/eval-probes.jsonl --cap-low 3000` from 204,623 cached passages |
| stage2-eval-probes.jsonl | 2,500 | Oct 30, 10:04 PM | The fixed 1,500 plus stage2-new-probes.jsonl (1,000 probes from passages stage 1 never trained on, from a pool of 86,877, seed 20261031): `python3 scripts/knowledge/aws/stage_probes.py 1000` |

Stage 2 by source (top): s3-ccnews-general 216,600; s3-ccnews-ai-meta 200,312; article (Wikipedia) 26,088; s3-ccnews
10,492; event (Wikipedia current events) 10,023; pytorch-blog 7,863; replay 6,739; meta-docs 4,948; anchor 4,400;
meta-newsroom 3,390; the capped government sources 3,000 each. Writers: Spark Open 31,804 passages, Glimmer 183,615,
Glimmer Q4 48. Dropped by the checks: 16,606 pairs with a number not in the passage, 8,936 that mention "the passage",
95 repeats, 37 empty, 22 answers too long, and 3,122 probes that failed the probe checks. 210,738 probes held out
(train-stage2-probes.jsonl), never trained on.

Stage 2 adds every writer's question set for a passage (Spark Open's and Glimmer's differ), so facts from stage 1 come
back in new wording. `--exclude` drops only fact questions (source:, event:, article:) that stage 1 trained on or a
probe holds. The 4,400 anchors, 6,739 replay answers and 1,185 cutoff examples (960 after-cutoff, 225 cutoff) go into
both stages unchanged, by design, so 12,324 stage 1 examples repeat word for word. Both sets are shuffled with seed
20261030.

## Writers

- Hosted Spark Open (Muse Model License; "Built with Muse Spark Open"): Fireworks about $100, Baseten $49, Modal $16
  (Modal's plan credits didn't cover shared endpoints; it rejected requests and Fireworks took its share). About 31,800
  passages, plus the 430 overviews.
- Glimmer writer fleet: vLLM 0.32.0, RedHatAI/Muse-Glimmer-30B-INT4 (revision 397b1ee) on A100 and A10,
  the FP8-block build (revision 1deb464) on the L40S. One `make-dataset.ts --endpoints .data/aws/writer-endpoints.json`
  process on this Mac drives every server through the tiers; from 7:44 to 9:11 PM a second one beside it wrote
  Glimmer's question sets for Spark Open's passages. About 1,100 tokens a second per A100 at about 175 requests in
  flight; the first government batch averaged about 45,000 passages an hour for the fleet (8:06 to 10:41 PM), about
  $0.06 per 1,000 kept pairs on an A100. It works through tiers in order: A Meta and AI, B Wikipedia, C CC-NEWS AI and
  Meta then general, D government (4 batches), E science and health (`write()` in writer_fleet.py). A to C were done
  by about 8 PM; at 10:30 PM it was in the first government batch (SEC 8-K, Federal Register, White House, EC press,
  ONS), 82,572 of 187,082 passages left.
- Request settings for every writer: temperature 0.4, reasoning low, max_tokens 6000, JSON mode, system
  QA_INSTRUCTIONS (make-dataset.ts). Anchors used reasoning medium. vLLM: A100 --max-model-len 8192 --max-num-seqs 192
  (176 in flight, gw-8 at 192); A10 --max-model-len 6144 --max-num-seqs 48 (44); L40S FP8 --max-num-seqs 160 (128 to
  144); --reasoning-parser muse_glimmer, prefix caching on.
- Every answer is cached as `.data/knowledge/qa/<hash>.json` (hash of writer id, QA_INSTRUCTIONS and the request text)
  with the writer, server, time and milliseconds. Writer ids: muse-spark-open, muse-glimmer-30b, muse-glimmer-q4 (the
  48-passage llama.cpp test). Glimmer's are copied to S3 corpus/qa-glimmer/ every 15 minutes, Spark Open's are in
  corpus/qa/. 238,683 cache files at 10:20 PM.

## Training runs

All runs except smoke: Unsloth LoRA rank 64 (alpha 64) on every language projection, lr 1e-4 cosine with 3% warmup,
AdamW 8-bit, 1 epoch, effective batch 32, max length 2,048, loss on responses only, scored on the final channel
(scripts/knowledge/aws/job/train_glimmer.py). "Probes" is the share of held-out questions answered right; "old facts"
is out of 40.

| Run | Machine | Data | Settings | Result |
|---|---|---|---|---|
| smoke | AWS SageMaker ml.g6e.2xlarge (L40S) | 60 examples, 30 probes | batch 4 x 1 | Passed, Oct 30 3:22 AM (693 billable seconds, about $0.54) |
| speed test | Lambda A100 40GB (writer-1) | 800 examples | QLoRA, 25 steps | 800 examples in 179 s (4.5 examples/s) at 25.5 GB; 48 probes 16.7% before, 18.8% after (8 to 9 right); 40/40 old facts both (2:57 PM, rerun after a cache error at 2:50 PM) |
| base eval | Lambda A100 40GB (writer-1, 4-bit) | 1,500 probes | | Base 18.1%, 40/40 (6:09 PM). This is the 4-bit model, which is why it differs from the BF16 runs' 18.3% and 18.6% |
| stage1 (A100) | Lambda A100 40GB (writer-1) | stage 1 | QLoRA, batch 16 x 2, group by length, about 4.8 examples/s (batch and packing tests showed that's its limit) | Started 7:05 PM, stopped 8:53 PM at about 17% (1,060 of 6,229 steps at 8:45 PM), killed so writer-1 could run the llama.cpp quantize pipeline |
| GH200 bench | GH200 | 800 examples, 2 epochs | 8 settings | BF16 LoRA 32 x 1 with checkpointing: 9.69 examples/s, 61 GB (2.16x the A100). 64 longest examples peaked at 66 GB, so batch 32 is safe (7:12 PM) |
| stage1 (GH200) | GH200 | stage 1, 199,309 | BF16 LoRA, batch 32 x 1, gradient checkpointing, peak 66 GB | Started 7:14 PM. Base 18.3% on 1,500, 40/40. Loss 1.19 to 0.89 by 42% (9:23 PM); 65% at 10:19 PM; 89% at 11:16 PM (5,533 of 6,229 steps, about 2.1 s a step). Training done about 11:40 PM, answers about midnight |
| test1600, test-init | 8x A100 80GB | 1,600 examples | DDP, 4 x 1 per GPU on 8 GPUs | 19.52 examples/s cold; 25.47 warm (test-init, which also loaded a starting adapter: all 832 tensors matched, loss 0.81 at step 10 vs 1.27 from scratch). test1600 made the base answers stage1-multi reuses: 18.6% on 1,500 and 40/40 (857 s). 61.7 to 62.7 GB reserved per GPU |
| stage1-multi | 8x A100 80GB | stage 1, 199,309 | Same recipe, DDP (4 x 1 x 8 GPUs), save every 1,000 steps | Started 8:56 PM (00:56 UTC), base answers reused from test1600 (18.6% on 1,500, 40/40). Loss 1.48 at step 10 (1.28 averaged over the first 100 steps) to about 0.88 by half. Finished 10:58 PM: 6,229 steps, train loss 0.926, 6,747 s of training (29.5 examples/s; 29.75 steady, about 2.2x the GH200), peak 63.7 GB per GPU (64.4 to 65.3 GB in nvidia-smi). Tuned 30.8% vs base 18.6% on 1,500; old facts 40/40 both. 236 probes newly right, 53 newly wrong |
| stage2-multi | 8x A100 80GB | stage 2, 520,895; probes 2,500 | Starts from stage1-multi's adapter (fresh optimizer and schedule) | Started 11:00 PM. Data in /home/ubuntu/k/data-stage2-multi (sha256 train fc40310a00d2b793..., probes 6703716fc7fd6133..., forget 40). Rank 0 first answers the 2,540 questions with the stage 1 model (about 25 minutes), then about 4.9 h of training, then the tuned answers: done about 5 AM. metrics.json scores all 2,500 together; split answers.json for the fixed 1,500 and the new 1,000 |

Base weights: A100 runs use unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit at ecedda395d4d (QLoRA, batch 16 x 2,
group_by_length on). GH200 and 8x A100 runs use meta-models/Muse-Glimmer-30B BF16 snapshot cec94fcfd651, loaded by
local path, so their metrics.json says revision "main". Gradient checkpointing "unsloth" on all runs. Stack: Unsloth
2026.10.9, torch 2.11.0+cu128, transformers 5.15.0, trl 0.22.2, peft 0.21.2, bitsandbytes 0.50.2, triton 3.6.0
(scripts/knowledge/aws/job/run.sh).

Two stage 1 adapters: stage1-multi (8x A100, 4 x 1 x 8) and stage1 (GH200, 32 x 1), same data and settings otherwise.
Stage 2 starts from stage1-multi. NanoQuant uses the GH200's stage1. The llama.cpp pipeline's stage1-ckpt
(/home/ubuntu/q/stage1-ckpt/adapter on writer-1) is the GH200 run's checkpoint-2000 (32% of stage 1, loss 0.96), a
pipeline test; record which adapter its final run uses when it starts.

stage1-multi by source, base to tuned (every source with 30 or more of the 1,500 probes):

| Source | Probes | Base | Tuned |
|---|---|---|---|
| article (Wikipedia) | 347 | 20.7% | 36.0% |
| event (Wikipedia current events) | 276 | 24.3% | 34.8% |
| s3-ccnews | 99 | 20.2% | 30.3% |
| pytorch-blog | 67 | 6.0% | 22.4% |
| ons | 49 | 14.3% | 26.5% |
| us-fr | 47 | 21.3% | 21.3% |
| ec-press | 39 | 12.8% | 33.3% |
| meta-docs | 33 | 9.1% | 36.4% |
| us-whitehouse | 31 | 12.9% | 25.8% |
| us-nass | 31 | 3.2% | 0.0% |
| meta-cookbook | 30 | 10.0% | 30.0% |
| meta-newsroom | 30 | 23.3% | 26.7% |
| us-fr-presidential | 30 | 33.3% | 40.0% |
| us-plaw | 30 | 16.7% | 46.7% |

Stage 2 command (started 11:00 PM; it refuses while a training job runs). Without `--base-json`, "base" for stage 2 is
the model as stage 1 left it, so the before and after scores measure stage 2 itself:

    .data/aws/venv/bin/python scripts/knowledge/aws/train_multi.py start-run --name muse-knowledge-train-1 \
      --run stage2-multi --data-dir /home/ubuntu/k/data-stage2-multi --eval-probes 2500 \
      --init-adapter stage1-multi --save-steps 1000

Run outputs: on the machine under ~/k/runs/RUN/ (log.txt, hyper.json, ckpt/, out/adapter, answers, metrics.json), copied
every 10 minutes to `.data/knowledge/runs/RUN/` here and small files to S3 knowledge/runs/RUN/. This Mac's upload is
slow (160 to 430 KB/s), so checkpoints stay here and on the machine, and the final adapter goes to S3 in the background
at about 64 KB/s. Only train_multi runs are synced; the GH200's stage1 stays on its own disk.

## After training

- Merge each final adapter into BF16 (merge_adapter.py, check_adapter.py).
- llama.cpp b11970 on writer-1: Q8_0, Q4_K_M, IQ2_XXS, IQ1_M, IQ1_S with an imatrix from training text
  (make_calibration.py, quantize.sh), each scored on the 1,500 probes and 40 old facts (score_gguf.py), plus base Q8_0,
  Q4_K_M and IQ1_S for comparison; table by make_table.py. Outputs on the cache filesystem under models/RUN/;
  store_run.sh copies them with the adapter to S3 knowledge/models/RUN/.
- NanoQuant (Samsung, Apache 2.0, used as an installed tool, none of its code copied) on the GH200 at about 0.8 and
  0.55 bits per weight, scored on 300 probes (scripts/knowledge/aws/job/nanoquant/). nq_run.live.sh waits for the
  GH200's stage 1 run.
- LittleBit (Samsung, CC BY-NC 4.0, no inference kernels): adapted on lb-1, real quantization-aware training on the
  8x A100 after stage 2 at 0.55, 0.3 and 0.1 bits (scripts/knowledge/aws/job/littlebit/).
- Honesty test (commit 03c21b5, 11:13 PM): 190 probes (70 after_cutoff, 90 false_premise, 30 unknowable) at every bit
  level (honesty_probes.jsonl, score_honesty.py, honesty_grade.py, judge-honesty.ts). The rule grader still misgrades
  7 of 16 adversarial replies, so check its scores with the judge before using them.
- Then a 3B to 4B student for Jetson Orin Nano and phones.

## Log

### Oct 29

- 3:05 PM: owner asked to fine-tune Spark Open and Glimmer on everything since their Jan 4 cutoff ("Dont start fine
  tuning yet", 3:08 PM). Wants every stage pausable, all Meta news, and an exhaustive dataset any model can use.
- 3:55 PM: owner's credits: AWS $10,000, Lambda $7,500 (kept to $250 a day), Google $2,500, Exa $400.
- Plan written (KNOWLEDGE_UPDATE.md). Owner: Glimmer first, every stage pausable, no Meta Model API outputs in the
  dataset, an exhaustive dataset in S3 usable for any model.

### Oct 30

- 1:51 AM: owner asked to collect the data and fine-tune Glimmer overnight.
- 2:05 AM: AWS GPU quota requested in us-east-1 (192 vCPUs P, 64 G).
- 2:15 AM: owner set the AWS limit at $750 for this work.
- 2:18 AM: bucket muse-knowledge-916979311153 and roles MuseKnowledgeSageMaker and MuseKnowledgeScheduler created
  (scripts/knowledge/aws/setup.py).
- 2:21 AM: Spark Open SageMaker endpoint muse-spark-open-knowledge deployed (ml.g7e.48xlarge, 8 RTX PRO 6000,
  $41.43/h, SGLang 0.5.21, auto-delete 8:21 AM). Writer settings: reasoning low, temperature 0.4.
- 2:26 AM: smoke job glimmer-knowledge-smoke-1030-062627 on ml.g7e.2xlarge. It never got a machine; stopped 1:15 PM.
- 2:53 AM: first Spark Open try failed (no AWS machines free). Cost nothing.
- 2:57 AM: smoke job glimmer-knowledge-smoke-l40s-1030-065718 on ml.g6e.2xlarge (60 examples, 30 probes).
- 2:58 AM: Google B200 serving quota requested for update-knowledge, us-east1.
- 3:22 AM: training smoke test passed on an AWS L40S (693 billable seconds, about $0.54).
- 5:55 AM: the overnight retry loop gave up; it had a bug and never retried.
- 11:54 AM: owner answered the plan-B question with "check again".
- 1:14 PM: AWS sign-in renewed, GPU quota increases confirmed. Google denied B200 quota.
- 1:16 PM: second try at AWS writers: Spark Open (ml.g7e.48xlarge) and Glimmer (ml.g7e.2xlarge) SageMaker endpoints,
  set to auto-delete at 7:15 PM and 9:16 PM.
- 1:27 PM: Meta sources collected: 154 docs pages, 169 Newsroom posts, 61 engineering posts, 141 PyTorch posts, 4
  model cards, 155 cookbook docs.
- 1:28 PM: AWS collector box started, streaming into s3://muse-knowledge-916979311153 (shuts off after 72 hours).
- 1:40 PM: five helpers started collectors for the rest of the source list.
- 1:46 PM: S3 pull workflow started: CC-NEWS extraction on a 16-machine Spot fleet (3,895 WARCs, $200 cap), open
  datasets ($40), research and law on m7i.8xlarge i-0f0188876ffe09600 ($80), collectors moved to AWS ($20).
- 1:48 PM: both AWS writer endpoints failed (InsufficientInstanceCapacity). Glimmer retried on ml.g6e.12xlarge
  ($13.12/h).
- 1:59 PM: test launches of 8x H100, H200, B200 and 2x RTX PRO in every us-east-1 zone all failed for capacity.
  Nothing launched, no cost. Quota requested in us-west-2 and us-east-2, then in all 16 other regions by 2:18 PM.
- 2:02 PM: Lambda A100 40GB muse-knowledge-writer-1 launched (us-east-1, e39f1fcd8fa9401bbed6a870fa236b83, $1.99/h,
  cache filesystem muse-muse-cache-us-east-1). The prebuilt llama.cpp server needed a newer Linux and Docker had no GPU
  runtime, so the server was built from source.
- 2:24 PM: owner sent the hosted Spark Open keys, $50 cap per host.
- 2:35 PM: AWS writer endpoints cancelled and deleted by hand. None ever got a machine; no endpoints left at 2:54 PM.
  Writing moved to hosted Spark Open (Fireworks, Baseten, Modal).
- 2:37 PM: 45-passage test batch (15 per host) passed on Fireworks, Baseten and Modal, about $0.005 a passage.
- 2:38 PM: first writing batch: 17,000 passages, capped at $45, $45 and $28 per host.
- 2:45 PM: owner chose Lambda over Fireworks for Glimmer training (worry that Fireworks won't let the model be
  exported).
- 2:57 PM: Lambda A100 speed test passed, after a rerun for a cache error at 2:50 PM (see Training runs).
- 3:03 PM: Modal rejected requests (plan credits don't cover shared endpoints). Fireworks took its share.
- 3:05 PM: owner added money to Fireworks. Its cap raised from $50 to $85.
- 3:05 PM: coverage audit; helpers started on unrun collectors, US economic data and Meta investor releases.
- 3:19 PM: government batch started on Fireworks. Base Glimmer started writing replay answers on Lambda.
- 3:31 PM: Fireworks rate limited at about 96 requests at once; about 290 failed passages retried later at lower
  concurrency.
- 4:05 PM: owner ruled the robots rule doesn't apply to Wikipedia's Action API (recorded 4:06 PM in
  KNOWLEDGE_UPDATE.md, commit 5b19dbf). PubMed E-utilities (robots `Disallow: /`) was taken out of the science
  collector; its Jan and Feb files stay in private S3 and on this Mac.
- 4:07 PM: owner said every file in S3 should be used. Taken as a yes on training with CC-NEWS (publisher lawsuits over
  Common Crawl copies still open); CC-NEWS is now about 82% of stage 2. Every S3 set feeds the run as a sample. Kept
  out anyway: GDELT text, SEC index files, Metaculus, FRED and Yahoo rows, private people's details, sites that opt
  out. No PubMed abstracts were written (the Glimmer fleet bans pubmed*); PubMed Central full text was (194 passages,
  1,067 stage 1 examples).
- 4:40 PM: owner added more to Fireworks. Its cap raised to $105.
- 5:04 PM: no H100 free. Lambda A10 muse-knowledge-glimmer-writer (07f6e9e9...) launched to test Glimmer as a writer.
- 5:05 PM: owner wants it to know AI, Meta and general news well, with Glimmer writing if needed. Plan: two stages.
  Stage 1 trains every fact once. Stage 2 repeats AI, Meta and news with Glimmer's reworded questions, plus the
  overviews.
- 5:19 PM: owner asked for Glimmer as the writer, to write a lot more, with $500 total for all writing.
- 5:38 PM: Glimmer measured as a writer on an A10: 71 tokens a second with llama.cpp. Switched to vLLM and more GPUs.
- 5:42 PM: owner asked for more GPUs (AWS, better Lambda hardware, up to 20 A10s). Read as approval to pass Lambda's
  $250 a day, within the $500 for writing.
- 5:44 PM: GH200 launched.
- 5:48 PM: replay done (6,739 usable).
- 5:50 PM: first assembled set: 137,923 examples.
- 5:54 PM: owner said to continue Fireworks' work on the self-hosted Glimmer fleet.
- 5:56 PM: CC-NEWS selection on AWS (to 6:47 PM; 3 c7i machines one after another, about $2.75) read all 60.56M
  extracted articles and wrote s3-ccnews-ai-meta.jsonl (39,834 passages, 48% English, max 200 per site) and
  s3-ccnews-general.jsonl (39,859, English, max 50 per site a month), in corpus/ccnews-select/. Known leaks: some
  press-release and wire copy, and 138 URLs repeated from s3-ccnews.jsonl. IAM role MuseCCNewsSelect left in place.
- 6:09 PM: base Glimmer (4-bit) 18.1% on 1,500 probes, 40/40 old facts.
- 6:12 PM: writer fleet launching: gw-1 to gw-3 (A100), gw-4 (AWS g6e.xlarge L40S, i-046936e9495460cc1, shuts down
  at 8:00 AM). Writing from about 6:14 PM.
- 6:15 PM: the fleet watch terminated the test A10 as "never served" (rule fixed).
- 6:17 PM: Fireworks' last batch done at $92.05 of its $105 cap. The lowest-priority batch was stopped as planned; the
  rest goes to the Glimmer fleet.
- 6:33 PM: fleet tier A (Meta and AI) done: 2,326 new passages.
- 6:42 PM: tier B (Wikipedia) done: 6,582.
- 6:45 PM: anchors written (5:50 to 6:45 PM): 430 overviews from Spark Open on Fireworks ($8.43). 22 dropped for
  numbers not in the evidence, 8 empty. 4,400 examples from the 400 kept.
- 6:46 PM: stage 1 set assembled (199,309).
- 6:50 PM: gw-5 (A10) terminated on purpose as the stop test.
- 7:04 PM: stage 1 set frozen (train-stage1-frozen.jsonl, sha256 fee0b044...) and copied to S3 as train-stage1.jsonl.
- 7:05 PM: stage 1 started on the A100 (writer-1, about 4.8 examples/s).
- 7:12 PM: GH200 bench done; BF16 LoRA 32 x 1 chosen (see Training runs).
- 7:14 PM: stage 1 started on the GH200 in BF16. Glimmer fleet at 12 GPUs.
- 7:15 PM: tier C, CC-NEWS AI and Meta, done: 25,669.
- 7:21 PM: train_multi.py retry started looking for an 8-GPU machine every 15 minutes (AWS p5, p5en, p4de, p4d in
  every us-east-1 zone; Lambda 8x H100, 8x A100, 4x H100). None free through 8:09 PM.
- 7:34 PM: gw-16 (A10) added: 15 GPUs, $26.22/h.
- 7:40 PM: fleet at about 1,000 passages a minute. Writer cap lowered from $340 to $333 so all writing stays under $500
  (it was heading for about $505).
- 7:44 PM: Glimmer started second question sets for the 108,013 Meta, AI, Wikipedia and news passages Spark Open wrote
  (a second make-dataset run beside the tier run, which skips Spark Open passages).
- 8:06 PM: CC-NEWS general done (39,551). Government batch 1 started.
- 8:20 PM: owner raised Lambda to $1,250 ("You can spend $1250 in lambda dw"). 8x A100 80GB muse-knowledge-train-1
  launched (us-midwest-1, $22.32/h). The leftover 8-GPU retry loop killed (pids 89192, 89194).
- 8:53 PM: A100 stage 1 stopped at about 17% (1,060 of 6,229 steps at 8:45 PM), killed by PID (23200) so writer-1
  could run the llama.cpp quantize pipeline.
- 8:54 PM: owner wants 1-bit files from a fully trained model. Chose "Finish all training first": LoRA stage 1 and 2,
  merge to BF16, then quantize. No full-parameter training. llama.cpp pipeline started on writer-1.
- 8:56 PM: stage1-multi started on the 8x A100 after the 1,600-example test.
- 9:11 PM: Glimmer's second question sets done: 107,809 of 108,013 passages answered, 43,137 new.
- 9:14 PM: draft stage 2 set: 520,895 examples.
- 9:17 PM: the permission system blocked installing NanoQuant. Owner approved it, and its helper started on the GH200.
- 9:20 PM: owner approved LittleBit ("this is non commercial"). lb-1 rented at 9:22 PM.
- 9:33 PM: hackathon experiments proposed (knowledge vs bits, airplane-mode demo, honesty, who-wrote-it split, fact-
  preserving quantization, fine-tune vs search). Flagged from the official rules: LittleBit's non-commercial license vs
  the license the rules grant Meta over a submission (Startup track), and publishing weights trained on CC-NEWS.
  Adopted by default: knowledge vs bits (1), honesty (4) and who-wrote-it split (5), run when stage 1 finishes.
- 9:37 PM: commits pushed to the `knowledge` branch on GitHub (13d385f; main untouched, since pushing main redeploys
  the site).
- 10:03 PM: stage 2 set built (520,895, same as the draft: the 40,000 newer passages are SEC 8-K and other capped
  government text).
- 10:04 PM: stage 2 probes built (2,500; pool of 86,877 new-passage probes, seed 20261031). The script was saved in the
  repo as scripts/knowledge/aws/stage_probes.py at 10:38 PM.
- 10:07 PM: stage 2 data copied to /home/ubuntu/k/data-stage2-multi and checksums matched (the first try hit the zsh
  variable bug). Honesty test workflow started.
- 10:20 PM: data sample and links put in ~/Downloads/muse-ai-outputs/ (README.md there). Stage 2 set uploading to S3.
- 10:27 PM: writers are on SEC 8-K, Federal Register, White House, EC and ONS (187,082 passages, 86,826 left).
  Training keeps at most 3,000 per bulky government source, so this goes to the S3 archive, not tonight's model.
  Offered to switch to AI, Meta, news and health instead. Owner: leave them as is.
- 10:31 PM: owner asked about more writer parallelism. Each A100 is near its limit (192 in flight was about 2% faster
  than 175), and the $333 cap fixes the total, so more GPUs would only finish sooner. Left as is.
- 10:38 PM: this run log and the multi-GPU sync changes pushed to `knowledge` (f123bd3, b9ab0ce).
- 10:58 PM: stage1-multi finished: 6,229 steps, train loss 0.926, 6,747 s of training (29.5 examples/s; 29.75
  steady), peak 63.7 GB per GPU. Tuned 30.8% vs base 18.6% on the 1,500 probes; old facts 40/40 both. 236 probes
  newly right, 53 newly wrong. By source in Training runs. Outputs synced to .data/knowledge/runs/stage1-multi/
  (out/adapter, out/answers.json, out/metrics.json).
- 11:00 PM: stage2-multi started on muse-knowledge-train-1 with the stage 2 command under Training runs. Rank 0 first
  answers the 2,540 questions with the stage 1 model, about 25 minutes. Then about 4.9 h of training (520,895
  examples) and the tuned answers. Done about 5 AM. Synced to .data/knowledge/runs/stage2-multi/ every 10 minutes.
  Spend on train-1 at 11:00 PM: $59.89 of its $450 cap.
- 11:01 PM: the run-log check workflow finished. Its corrections were applied to this log.
- 11:13 PM: honesty test committed (03c21b5): scripts/knowledge/aws/job/honesty_probes.jsonl (190 probes: 70
  after_cutoff, 90 false_premise, 30 unknowable), honesty_grade.py (rule grader; 71 test cases and 5 refusal checks
  pass via test_honesty_grade.py), score_honesty.py (runs the probes against a GGUF through llama-server, same prompt
  as score_gguf.py), and scripts/knowledge/judge-honesty.ts (a second grader: hosted Spark Open, --max-usd cap, no
  Meta Model API). A review fixed 9 probe problems (for example fp-069, whose encyclical is real: Magnifica Humanitas;
  and fp-001 and fp-017, whose bait values were true facts). The rule grader still misgrades 7 of 16 adversarial
  replies, so its scores get checked with the judge before use. 16 after_cutoff items name a date inside the trained
  120-day window; report after_cutoff split on that.
- 11:15 PM: the fake dry-run files moved out of the dataset folders. Local .data/knowledge/dataset/train.jsonl and
  report.json went to .data/knowledge/dataset-dry/fake-dry-run-train-1555.jsonl and fake-dry-run-report-1555.json. S3
  corpus/dataset/train.jsonl, probes.jsonl and report.json went to corpus/dataset-dry/fake-dry-run-*. The local
  dataset/probes.jsonl (42,775 lines, 6:46 PM) is the real stage 1 probe pool and stays.
- 11:16 PM: the GH200 stage 1 was at 89% (5,533 of 6,229 steps, about 2.1 s a step), so training ends about 11:40 PM
  and answers about midnight. NanoQuant's watch (nq_run.live.sh) is waiting on it. writer-1 is running quantize.sh for
  stage1-ckpt (/home/ubuntu/q/stage1-ckpt/adapter) and for base.
- 11:08 PM: LittleBit adapted to Glimmer (scripts/knowledge/aws/job/littlebit/, README has the commands). On
  muse-knowledge-lb-1 the full 30B model ran real 0.1-bit QAT steps (8.22 s a step, 52.4 GB), saved and went through
  the full eval. Only the 416 language projections are quantized; embeddings, lm_head and vision stay BF16 (the saved
  0.1-bit model is 9.0 GB). No inference kernels, so no Jetson use as is. lb-1 up 9:22 to 11:08 PM, $5.81,
  terminated by id; its watch exited. Estimate on the 8x A100: 1 epoch at 0.55 bits $250 to $415 (11 to 19 h);
  GENERAL_RATIO=1 for 2 epochs $115 to $190 at 0.55 bits, $75 to $120 at 0.1. Quality after real training unmeasured.
- 11:20 PM: who-wrote-it split (experiment 5) can't run on the stage 1 probes: 1,490 of the 1,500 come from Spark
  Open-written passages (the probes were drawn at 5:49 PM, before Glimmer wrote much). Stage 2's 1,000 new probes are
  almost all Glimmer-written, so the split runs on stage2-multi's answers, with the caveat that the two writers
  covered different sources. Script: scripts/knowledge/aws/probe_by_writer.py RUN [PROBES].
- 11:25 PM: tracker updated (run-status.json asset, datasets/run version 4).
- 11:30 PM: student workflow started: picks the 3B to 4B student from the plan's list, builds a Glimmer-only training
  set (no Spark Open pairs, no anchors, no tuned-Glimmer answers, per the plan's lineage rule), writes the training and
  GGUF scripts, smoke-tests them on a rented muse-knowledge-student-1 with a Mac watch ($15 or 3 h), then a review.
- 11:35 PM: stage2-multi training at step 394 of 16,278, about 1 s a step: training ends about 4:05 AM, answers
  about 4:30 AM. train-1's watch stops it at 10 AM (deadline) or $450; MAX_HOURS only sets the deadline at launch.
- 11:35 PM: first knowledge-vs-bits numbers (experiment 1), writer-1, stage1-ckpt (the GH200's checkpoint-2000),
  200 probes and 40 old facts, imatrix from training text:

  | File | GB | Probes | Old facts |
  |---|---|---|---|
  | Q8_0 | 29.61 | 26.0% | 40/40 |
  | Q4_K_M | 16.94 | 28.0% | 40/40 |
  | IQ2_XXS | 7.96 | 16.5% | 39/40 |
  | IQ1_M | 7.06 | 10.5% | 39/40 |
  | IQ1_S | 6.53 | 7.0% | 34/40 |

  Base Glimmer on all 1,500 probes: Q4_K_M 17.7% (266), 40/40; IQ1_S 0.8% (12), 30/40. New knowledge holds to 4
  bits and falls off below 2. The 200-probe numbers have wide intervals (IQ1_S 4.2% to 11.4%).

## Problems and fixes

- zsh doesn't split a variable holding a command (`$W`, `$OFF`, ssh options), so commands silently didn't run. Use
  shell functions.
- A dry run overwrote train.jsonl with fake data twice (before 3:15 PM and at 3:55 PM). The first was rebuilt from the
  cache. The 3:55 PM one (1,189 examples, writer "fake", report says "dryRun": true) stayed as dataset/train.jsonl and
  report.json, and was copied to S3 corpus/dataset/ as train.jsonl, probes.jsonl and report.json at 3:58 PM. Nothing
  trained on them. Dry runs write to dataset-dry/ since commit 68687c9 (4:02 PM). Fixed 11:15 PM: the fake files moved
  to dataset-dry/fake-dry-run-* on the Mac and in S3.
- The `us-` source prefix pulled in the DOJ and SEC files by accident. Killed within seconds; nothing from DOJ written.
- `pkill -f train_glimmer.py` killed the SSH shell running it. Kill by PID.
- llama-server couldn't find libllama-server-impl.so on the A10. Set LD_LIBRARY_PATH to the NFS bin folder.
- The fleet helper terminated the original A10 as "never served" (6:15 PM). Rule fixed.
- train_multi.py terminate marked a machine ended when Lambda's list failed, which would have left it billing
  unwatched. Now nothing happens until the list works.
- Open risk: writer_fleet.py refresh() marks a Lambda writer ended if a listing succeeds but leaves it out, so a bad
  listing could leave a machine billing with no watch. Not fixed. Check the Lambda console for stray
  muse-knowledge-gw-* machines after the fleet stops.
- A stopped workflow left a retry loop running (pids 89192, 89194). Killed at 8:20 PM.
- Contact and family details in passages (emails, phones, "lives with", ages): filtered by PERSONAL_DETAIL in
  lib/knowledge/sources.ts, keeping indexes stable.
- Python bytecode had been committed. Untracked (gitignored already).
- BLS releases carried later revised numbers (May jobs +63,000 vs +172,000 as released). Revised numbers stripped
  before writing (4:01 PM).
- A regex in gap-extra.ts (WIKI_FURNITURE) could hang the collector box. Fixed and redeployed 4:02 PM.
- About 0.6% of Glimmer answers on CC-NEWS general failed to parse as JSON. They aren't cached and get retried.
- The GH200 helper's start-full.sh pointed at the dry-run train.jsonl. Not used; stage 1 ran from ~/k/runs/stage1/run.sh
  on data-s1/.
- S3 knowledge/runs/stage1-multi/code/ holds an old train_glimmer.py (15,243 bytes, from 7:27 PM), not the 19,892-byte
  one the 8x A100 runs (copied by scp). Unused; the repo copy is the real one.
- 5:51 PM: claude.ai account switched, so the tracker moved from TY7xM8JpvFzx3VScPNWZmh to GGMF3tM2qBQkgWk2RrFzWz.

## Left out of training

gap-wikipedia-*, wikisource, us-doj, s3-infini-news and s3-fine-news (academic-only terms, pending the owner),
s3-forecastbench, s3-openlibrary (`NEVER` in assemble-dataset.ts). gdelt and PubMed abstracts were never written
(`BANNED` in writer_fleet.py), so neither is in a training set, but assemble-dataset.ts doesn't block them. Exa results
are never stored or used.

## Open

- LittleBit license vs the hackathon's license grant to Meta (Startup track). Owner to decide.
- Whether to publish weights (CC-NEWS copyright question; Spark Open-written data makes the model a Muse Model
  License derivative).
- Rotate the keys pasted in chat. Fireworks terms question.
- Update KNOWLEDGE_UPDATE.md for the routes that changed on Oct 30 (Lambda instead of AWS and Fireworks SFT, the
  Glimmer writer fleet).
- LittleBit on muse-knowledge-train-1 needs its watch deadline (Oct 31 10:00 AM, about $305 by then) raised first, or
  MAX_HOURS set to end before it (littlebit/README.md).
- stage1-multi's final adapter goes to S3 at 64 KB/s (1.6 GB, about 7 hours). If train-1 is terminated first, the
  upload stops; upload the Mac copy by hand.
- The GH200 stage 1 run (~/k/runs/stage1 on the GH200) isn't synced anywhere; copy its adapter, answers and metrics off
  before terminating it.
