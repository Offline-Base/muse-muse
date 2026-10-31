# Knowledge run log

What actually happened in the Glimmer knowledge fine-tune: every machine, dataset, training run, score, decision and
fix, in order. The plan and the reasons behind it are in [KNOWLEDGE_UPDATE.md](KNOWLEDGE_UPDATE.md); this file is the
record. Times are Eastern (EDT) unless they say UTC. Add an entry for every launch, run, result, decision and fix, and
commit it.

Live tracker: https://claude.ai/artifact/GGMF3tM2qBQkgWk2RrFzWz (private).

## Now

Updated Oct 30, 10:40 PM.

| Machine | What it does | Price | Stops how |
|---|---|---|---|
| muse-knowledge-train-1 (Lambda 8x A100 80GB, us-midwest-1, 36517e6c25ed4bccb6db6dde54f5a610) | Stage 1 (run stage1-multi), then stage 2 | $22.32/h since Oct 30 8:20 PM | `train_multi.py watch` on this Mac: at $450 or Oct 31 10:00 AM (14:00 UTC). By hand: `.data/aws/venv/bin/python scripts/knowledge/aws/train_multi.py stop --name muse-knowledge-train-1` |
| muse-knowledge-glimmer-gh200 (Lambda GH200, us-east-3, c3ff7180e6c2415d8a491de7a5978fa8) | Stage 1 single-GPU run, then NanoQuant | $2.29/h since Oct 30 5:44 PM | By hand through the Lambda API |
| muse-knowledge-writer-1 (Lambda A100 40GB, us-east-1, e39f1fcd8fa9401bbed6a870fa236b83) | llama.cpp quantize and scoring pipeline (cache filesystem muse-muse-cache-us-east-1) | $1.99/h | By hand through the Lambda API |
| muse-knowledge-gw-1 to gw-16, 15 live (9 A100 and 5 A10 on Lambda; gw-4 is an AWS g6e.xlarge L40S) | Glimmer writer fleet | $26.22/h together | `writer_fleet.py watch`: at $333 (about Oct 31 7:10 AM) or Oct 31 8:00 AM (12:00 UTC). By hand: `.data/aws/venv/bin/python scripts/knowledge/aws/writer_fleet.py stop` |
| muse-knowledge-lb-1 (Lambda H100 PCIe, us-west-3, 97c349f17d984bde924d8909979fa048) | LittleBit development | $3.29/h since Oct 30 9:22 PM | Its own watch on this Mac (scratchpad lb/watch.py), $70 cap |
| AWS collector box and CC-NEWS fleet | Source collection into S3 | | Shut themselves off |

Lambda machines can't stop themselves (powering off the OS doesn't stop billing). The watches on this Mac are their
only kill switch, so the Mac has to stay awake, online and plugged in.

## Limits

- Writing (hosted Spark Open plus Glimmer writer GPUs): $500 total. The Glimmer fleet is capped at $333 (`CAP_USD` in
  scripts/knowledge/aws/writer_fleet.py).
- Lambda: $1,250 total (raised from $250 a day on Oct 30, 8:20 PM).
- AWS: $750 for this work.
- No Meta Model API calls ("Dont run meta usage yet", Oct 29). Meta Model API outputs never write the dataset.

## Datasets

All in `.data/knowledge/dataset/` on this Mac (gitignored) and in s3://muse-knowledge-916979311153/knowledge/corpus/dataset/.

| File | Examples | Built | How |
|---|---|---|---|
| train-stage1-frozen.jsonl (S3: train-stage1.jsonl) | 199,309 | Oct 30, 6:46 PM | `assemble-dataset.ts --out train-stage1.jsonl`: first writer per passage, plus anchors and replay |
| eval-probes.jsonl | 1,500 held-out questions | Oct 30, 5:49 PM | Fixed for every eval, never trained on |
| scripts/knowledge/aws/forget.jsonl | 40 old facts (before Jan 2026) | | Checks the model didn't forget |
| anchors.jsonl | 4,400 (from 430 cached overviews, asked several ways) | Oct 30, 6:45 PM | `make-anchors.ts`, Spark Open on Fireworks, $8.43; overviews with numbers not in the evidence dropped |
| .data/knowledge/replay.jsonl | 6,739 | Oct 30, 5:50 PM | Base Glimmer's own answers to Dolly 15k prompts (dated prompts and cut-off answers dropped), so general skills stay |
| train-stage2.jsonl (S3: train-stage2.jsonl.gz) | 520,895 | Oct 30, 10:03 PM | `NODE_OPTIONS=--max-old-space-size=12000 npx tsx scripts/knowledge/assemble-dataset.ts --out train-stage2.jsonl --all-writers --exclude .data/knowledge/dataset/train-stage1-frozen.jsonl,.data/knowledge/dataset/eval-probes.jsonl --cap-low 3000` from 204,623 cached passages |
| stage2-eval-probes.jsonl | 2,500 | Oct 30, 10:04 PM | The fixed 1,500 plus stage2-new-probes.jsonl (1,000 probes from passages stage 1 never trained on, seed 20261031): `python3 scripts/knowledge/aws/stage_probes.py 1000` |

Stage 2 by source (top): s3-ccnews-general 216,600; s3-ccnews-ai-meta 200,312; article (Wikipedia) 26,088; s3-ccnews
10,492; event (Wikipedia current events) 10,023; pytorch-blog 7,863; replay 6,739; meta-docs 4,948; anchor 4,400;
meta-newsroom 3,390; the capped government sources 3,000 each. Writers: Spark Open 31,804 passages, Glimmer 183,615,
Glimmer Q4 48. Dropped by the checks: 16,606 pairs with a number not in the passage, 8,936 that mention "the passage",
3,122 held out as probes.

Stage 2 adds every writer's question set for a passage (Spark Open's and Glimmer's differ), so facts from stage 1 come
back in new wording, and drops any question stage 1 trained on or a probe holds.

## Writers

- Hosted Spark Open (Muse Model License; "Built with Muse Spark Open"): Fireworks about $100, Baseten $49, Modal $16
  (Modal's plan credits didn't cover shared endpoints; it rejected requests and Fireworks took its share). About 31,800
  passages, plus the 430 overviews.
- Glimmer writer fleet: vLLM 0.32.0, RedHatAI/Muse-Glimmer-30B-INT4 (revision 397b1ee) on A100 and A10,
  the FP8-block build (revision 1deb464) on the L40S. One `make-dataset.ts --endpoints .data/aws/writer-endpoints.json`
  process on this Mac drives every server. About 1,100 tokens a second per A100 at about 175 requests in flight, about
  50,000 passages an hour for the fleet, about $0.06 per 1,000 kept pairs on an A100. It works through tiers in order:
  A Meta and AI, B Wikipedia, C CC-NEWS AI and Meta then general, D government (4 batches), E science and health
  (`write()` in writer_fleet.py). A to C were done by about 8 PM; at 10:30 PM it was in the first government batch
  (SEC 8-K, Federal Register, White House, EC press, ONS), 82,572 of 187,082 passages left.
- Every answer is cached as `.data/knowledge/qa/<hash>.json` (hash of writer id, QA_INSTRUCTIONS and the request text)
  with the writer, server, time and milliseconds. Glimmer's are copied to S3 corpus/qa-glimmer/ every 15 minutes,
  Spark Open's are in corpus/qa/. 238,683 cache files at 10:20 PM.

## Training runs

All runs: Unsloth LoRA rank 64 on every language projection, lr 1e-4 cosine, 1 epoch, effective batch 32, loss on
responses only, scored on the final channel (scripts/knowledge/aws/job/train_glimmer.py). "Probes" is the share of
held-out questions answered right; "old facts" is out of 40.

| Run | Machine | Data | Settings | Result |
|---|---|---|---|---|
| smoke | AWS L40S | tiny | | Passed, Oct 30 3:22 AM |
| speed test | Lambda A100 40GB | 800 examples | QLoRA | 800 examples in 179 s at 26 GB; base 17% of 48 probes, 40/40 old facts (2:50 PM) |
| base eval | Lambda A100 | 1,500 probes | | Base 18.1%, 40/40 (6:09 PM) |
| stage1 (A100) | Lambda A100 40GB | stage 1 | QLoRA, about 4.8 examples/s (batch and packing tests showed that's its limit) | Started 7:05 PM, stopped 8:20 PM once faster machines ran |
| stage1 (GH200) | GH200 | stage 1, 199,309 | BF16 LoRA, batch 32 x 1, gradient checkpointing, peak 66 GB | Started 7:14 PM. Base 18.3% on 1,500, 40/40. Loss 1.19 to 0.89 by 42% (9:23 PM); 65% at 10:19 PM, about 2.4 s a step, done about 11:50 PM |
| test1600, test-init | 8x A100 80GB | 1,600 examples | DDP, 4 x 1 per GPU on 8 GPUs | 19.52 examples/s cold; 25.47 warm (test-init, which also loaded a starting adapter: all 832 tensors matched, loss 0.81 at step 10 vs 1.27 from scratch) |
| stage1-multi | 8x A100 80GB | stage 1, 199,309 | Same recipe, DDP, save every 1,000 steps | Started 8:56 PM (00:56 UTC). Base 18.6% on 1,500, 1.0 old facts. 28 to 31 examples/s (about 3x the GH200), 61.7 to 62.7 GB reserved per GPU. Loss 1.27 to about 0.86 by half. 72% at 10:19 PM; training done about 10:55 PM, answers about 11:15 PM |
| stage2-multi | 8x A100 80GB | stage 2, 520,895; probes 2,500 | Starts from stage1-multi's adapter (fresh optimizer and schedule) | Next. Data copied to /home/ubuntu/k/data-stage2-multi (sha256 train fc40310a00d2b793..., probes 6703716fc7fd6133...). About 5.2 hours |

Stage 2 command (once stage1-multi is done; it refuses while a training job runs). Without `--base-json`, "base" for
stage 2 is the model as stage 1 left it, so the before and after scores measure stage 2 itself:

    .data/aws/venv/bin/python scripts/knowledge/aws/train_multi.py start-run --name muse-knowledge-train-1 \
      --run stage2-multi --data-dir /home/ubuntu/k/data-stage2-multi --eval-probes 2500 \
      --init-adapter stage1-multi --save-steps 1000

Run outputs: on the machine under ~/k/runs/RUN/ (log.txt, hyper.json, ckpt/, out/adapter, answers, metrics.json), copied
every 10 minutes to `.data/knowledge/runs/RUN/` here and small files to S3 knowledge/runs/RUN/. This Mac's upload is
slow (160 to 430 KB/s), so checkpoints stay here and on the machine, and the final adapter goes to S3 in the background
at about 64 KB/s.

## After training

- Merge each final adapter into BF16 (merge_adapter.py, check_adapter.py).
- llama.cpp b11970 on writer-1: Q8_0, Q4_K_M, IQ2_XXS, IQ1_M, IQ1_S with an imatrix from training text
  (make_calibration.py, quantize.sh), each scored on the 1,500 probes and 40 old facts (score_gguf.py), plus base Q4
  and IQ1 for comparison; table by make_table.py. Outputs on the cache filesystem under models/RUN/ and in S3
  knowledge/models/RUN/.
- NanoQuant (Samsung, Apache 2.0, used as an installed tool, none of its code copied) on the GH200 at about 0.8 and
  0.55 bits per weight, scored on 300 probes (scripts/knowledge/aws/job/nanoquant/).
- LittleBit (Samsung, CC BY-NC 4.0, no inference kernels): adapted on lb-1, real quantization-aware training on the
  8x A100 after stage 2 at 0.55, 0.3 and 0.1 bits (scripts/knowledge/aws/job/littlebit/).
- Honesty test: about 190 questions about things after Oct 29 or that don't exist, plus real controls, at every bit
  level (honesty_probes.jsonl, score_honesty.py; being built Oct 30 night).
- Then a 3B to 4B student for Jetson Orin Nano and phones.

## Log

### Oct 29

- Plan written (KNOWLEDGE_UPDATE.md). Owner: Glimmer first, every stage pausable, no Meta Model API outputs in the
  dataset, an exhaustive dataset in S3 usable for any model.

### Oct 30

- 2:53 AM: first Spark Open try failed (no AWS machines free). Cost nothing.
- 3:22 AM: training smoke test passed on an AWS L40S.
- 5:55 AM: the overnight retry loop gave up; it had a bug and never retried.
- 1:14 PM: AWS sign-in renewed, GPU quota increases confirmed. Google denied B200 quota.
- 1:16 PM: first Spark Open and Glimmer writers deployed on AWS (auto-deleted at 7:15 PM and 9:16 PM).
- 1:25 PM: Meta sources collected: 154 docs pages, 169 Newsroom posts, 61 engineering posts, 141 PyTorch posts, model
  cards and cookbooks.
- 1:28 PM: AWS collector box started, streaming into s3://muse-knowledge-916979311153 (shuts off after 72 hours).
- 1:40 PM: five helpers started collectors for the rest of the source list.
- 2:37 PM: 50-passage test batch passed on Fireworks, Baseten and Modal, about $0.005 a passage.
- 2:38 PM: first writing batch: 17,000 passages, capped at $45, $45 and $28 per host.
- 2:50 PM: Lambda A100 speed test passed (see Training runs).
- 3:03 PM: Modal rejected requests (plan credits don't cover shared endpoints). Fireworks took its share.
- 3:05 PM: coverage audit; helpers started on unrun collectors, US economic data and Meta investor releases.
- 3:19 PM: government batch started on Fireworks. Base Glimmer started writing replay answers on Lambda.
- 3:31 PM: Fireworks rate limited at about 96 requests at once; about 290 failed passages retried later at lower
  concurrency.
- 4:10 PM: owner ruled the robots rule doesn't apply to Wikipedia's Action API. PubMed E-utilities (robots
  `Disallow: /`) was taken out of the science collector; its Jan and Feb files stay in private S3. Later the owner said
  every file in S3 should be used, and PubMed abstracts were in some writing batches.
- 5:38 PM: Glimmer measured as a writer on an A10: 71 tokens a second with llama.cpp. Switched to vLLM and more GPUs.
- 5:44 PM: GH200 launched.
- 5:50 PM: replay done (6,739 usable). First assembled set: 137,923 examples.
- 6:09 PM: base Glimmer 18.1% on 1,500 probes, 40/40 old facts.
- 6:25 PM: anchors written. Fireworks stopped near its cap.
- 6:46 PM: stage 1 set assembled and frozen (199,309).
- 7:05 PM: stage 1 started on the A100 (about 4.8 examples/s).
- 7:14 PM: stage 1 started on the GH200 in BF16. Glimmer fleet at 12 GPUs.
- 7:40 PM: fleet at 15 GPUs, about 1,000 passages a minute. Writer cap lowered from $340 to $333 so all writing stays
  under $500 (it was heading for about $505).
- 8:20 PM: owner raised Lambda to $1,250. 8x A100 80GB launched. A100 stage 1 stopped.
- 8:56 PM: stage1-multi started on the 8x A100 after the 1,600-example test.
- 9:10 PM: Glimmer's second question sets done for Meta, AI, Wikipedia and news (43,137 passages). Draft stage 2:
  520,895 examples.
- 9:20 PM: owner approved quantizing to 1 bit and below: llama.cpp IQ1, NanoQuant, and LittleBit ("this is
  non commercial").
- 9:33 PM: hackathon experiments proposed (knowledge vs bits, airplane-mode demo, honesty, who-wrote-it split, fact-
  preserving quantization, fine-tune vs search). Flagged from the official rules: LittleBit's non-commercial license vs
  the license the rules grant Meta over a submission (Startup track), and publishing weights trained on CC-NEWS.
- 9:40 PM: commits pushed to the `knowledge` branch on GitHub (main untouched; pushing main redeploys the site).
- 10:03 PM: stage 2 set built (520,895, same as the draft: the 40,000 newer passages are SEC 8-K and other capped
  government text). Stage 2 probes built. Data copied to the 8x A100 and checked.
- 10:05 PM: honesty test workflow started.
- 10:20 PM: data sample and links put in ~/Downloads/muse-ai-outputs/ (README.md there). Stage 2 set uploading to S3.
- 10:35 PM: owner asked about more writer parallelism. Each A100 is near its limit (192 in flight was about 2% faster
  than 175), and the $333 cap fixes the total, so more GPUs would only finish sooner. Left as is.

## Problems and fixes

- zsh doesn't split a variable holding a command (`$W`, `$OFF`, ssh options), so commands silently didn't run. Use
  shell functions.
- A dry run overwrote train.jsonl with fake data. Rebuilt from the cache; dry runs now write to dataset-dry/.
- The `us-` source prefix pulled in the DOJ and SEC files by accident. Killed within seconds; nothing from DOJ written.
- `pkill -f train_glimmer.py` killed the SSH shell running it. Kill by PID.
- llama-server couldn't find libllama-server-impl.so on the A10. Set LD_LIBRARY_PATH to the NFS bin folder.
- The fleet helper terminated the original A10 as "never served". Rule fixed.
- train_multi.py terminate marked a machine ended when Lambda's list failed, which would have left it billing
  unwatched. Now nothing happens until the list works.
- A stopped workflow left a retry loop running (pids 89192, 89194). Killed.
- Contact and family details in passages (emails, phones, "lives with", ages): filtered by PERSONAL_DETAIL in
  lib/knowledge/sources.ts, keeping indexes stable.
- Python bytecode had been committed. Untracked (gitignored already).

## Left out of training

gap-wikipedia-*, wikisource, us-doj, s3-infini-news and s3-fine-news (academic-only terms, pending the owner),
s3-forecastbench, s3-openlibrary (`NEVER` in assemble-dataset.ts). Exa results are never stored or used.

## Open

- LittleBit license vs the hackathon's license grant to Meta (Startup track). Owner to decide.
- Whether to publish weights (CC-NEWS copyright question; Spark Open-written data makes the model a Muse Model
  License derivative).
- Rotate the keys pasted in chat. Fireworks terms question.
- Update KNOWLEDGE_UPDATE.md for the routes that changed on Oct 30 (Lambda instead of AWS and Fireworks SFT, the
  Glimmer writer fleet).
