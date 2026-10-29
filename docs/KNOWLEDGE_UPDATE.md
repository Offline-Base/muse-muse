# 2026 knowledge update

Teach Muse Glimmer 30B, and later Muse Spark Open, what happened between Glimmer's knowledge cutoff (January 4, 2026) and now. Started Oct 29, 2026. This file is the plan and the place to pick the work back up.

## Status

Run `npm run knowledge:status` for the live numbers. As of Oct 29, 2026:

| Stage | State | Cost |
|---|---|---|
| 1. Corpus from Wikipedia | Built: 298 days, 6,446 events; article fetch for the top 3,000 articles running | Free |
| 2. Training data (Spark Open writes Q&A) | Code done and dry-run tested. Waiting for a Spark Open API key and the owner's OK for a pilot | Pilot about $1 to $2; full set estimated at $50 to $100 |
| 3. Fine-tune Glimmer | Not started. The owner said not to start fine-tuning yet | About $10 to $20 a run on one H100 |
| 4. Fine-tune Spark Open | Later, after Glimmer works | About $150 to $250 an attempt on 8 GPUs |

## Pause and continue

Every stage can stop at any point and carry on later without losing work or spending twice.

- `npm run knowledge:pause` (or Ctrl+C in the terminal that's running it): the running stage finishes the requests in flight, caches them and stops. No output file is overwritten with partial results. New runs refuse to start while paused.
- `npm run knowledge:resume` lifts the pause. Then run the same stage command again: it reads its cache and only does what's missing.
- Spend caps (`--max-usd`) count every cached answer from earlier runs, so resuming can't go past a cap.
- Everything lives in `.data/knowledge/` (git ignored): `raw/` (Wikipedia pages), `qa/` (one cached answer per passage), `events.jsonl`, `articles.jsonl`, `manifest.json`, `dataset/`.

Fine-tuning runs will follow the same rule: the knowledge recipe saves a LoRA checkpoint to the Lambda model cache every few hundred steps, and a stopped job can be relaunched from its last checkpoint (to build, see Next steps).

## Decisions so far

- Glimmer first, then Spark Open with the recipe that worked (owner, Oct 29).
- Muse Spark Open writes the question-answer pairs (owner, Oct 29). It runs on a host's OpenAI-compatible API (Fireworks or Together AI, both about $1.25 per million input tokens and $4.25 per million output), not on Meta's Model API and not on our GPUs. It only ever sees public Wikipedia text.
- No fine-tuning and no paid model calls until the owner says go.
- Spark Open's own weights are gated on Hugging Face. For stage 4 the owner accepts Meta's license on Hugging Face (it asks for legal name, date of birth and organization) and makes a separate read-only token for downloads. `HF_TOKEN` itself still never goes to a GPU.

## Stage 1: corpus (`npm run knowledge:corpus`)

`scripts/knowledge/build-corpus.ts`, with the parsing in `lib/knowledge/`.

- Wikipedia's daily current-events pages, `Portal:Current events/2026 January 4` through `2026 October 28`, become dated events with their category, the stories they sit under, linked articles and cited outlets (`lib/knowledge/current-events.ts`).
- The articles those events link to get "what changed since January 4": sentences in today's text that weren't in the last revision on or before January 4 (`lib/knowledge/wikipedia.ts`, `addedSince`). Big articles are rewritten constantly, so in an article that already existed a sentence only counts when no old sentence reads like it (70% word overlap or more is a copyedit) and it mentions 2026 or sits in a 2026 section or article. An article created after January 4 counts in full.
- Articles about 2026 come first, then the most linked. The default fetch is 3,000 articles.
- Requests go one at a time with `maxlag` and a User-Agent naming the project, as Wikimedia asks.

## Stage 2: training data (`npm run knowledge:dataset`)

`scripts/knowledge/make-dataset.ts`, with `lib/knowledge/{passages,qa,dataset}.ts`.

- Passages: a day's events grouped by story, and each article's additions by section, at most 220 words, with a dated header.
- Spark Open writes 2 to 8 pairs per passage (about one per 35 words) and one probe: a short-answer question worded unlike the pairs, with aliases (`QA_INSTRUCTIONS` in `lib/knowledge/qa.ts`).
- Checks drop a pair that mentions "the passage", runs over 120 words, repeats a question, or has a number in its answer that isn't in the passage. Spelled-out numbers count as missing, which errs on the safe side.
- Output: `train.jsonl` in the lab's chat shape, plus a few examples that teach the new cutoff date and decline questions about days after it. Also `probes.jsonl` (held out) and `report.json`.
- Commands: `-- --dry-run --limit 40` uses a fake writer with no network; `-- --limit 300 --max-usd 3` is the pilot; no `--limit` runs the full set.
- Needs `SPARK_OPEN_BASE_URL`, `SPARK_OPEN_API_KEY` and `SPARK_OPEN_MODEL` in `.env.local` (Fireworks: `https://api.fireworks.ai/inference/v1` and `accounts/fireworks/models/muse-spark-open`).

## Stage 3: fine-tune Glimmer (to build)

- A `glimmer-knowledge` recipe beside `glimmer-lora` (Unsloth QLoRA on one H100, `lib/train/recipes/glimmer.ts`). Short examples packed into 2,048-token sequences, two to three passes over the data, and a LoRA rank above the default 16, since facts need more capacity than style.
- Some replay to keep old skills: general prompts answered by base Glimmer itself on the GPU before training.
- The tuned chat template's `knowledge_cutoff` (`lib/train/tuned-template.ts`, now `2026-01-04`) moves to the corpus's last day.
- Checkpoints to the model cache, and a resume parameter, so a run can stop and carry on.
- Graded on the GPU with no judge model: the share of probes the base and tuned models answer (`probeAnswered`), questions about days after the cutoff (it should say it doesn't know), and a set of pre-2026 questions (it shouldn't forget). The lab's 60-item eval limit stays for the sample shown on the page; the full scores go in the job's metrics.
- The lab's limits (`TRAIN_JOB_MAX_MINUTES` 120, `TRAIN_JOB_MAX_USD` $5, `TRAIN_DAILY_USD` $20) need raising for this run.

## Stage 4: Spark Open (later)

816B total, 42B active MoE. QLoRA needs about eight H100s (about $36 an hour on Lambda) and a 1.6 TB download; keeping it in the model cache costs about $330 a month. Unsloth's open library is single-GPU, so this likely means NVIDIA NeMo AutoModel (which lists Spark Open) or Hugging Face multi-GPU training. Start with a short load-and-train test.

## Expectations

This teaches the events in the corpus, not everything. LoRA picks up new facts slowly, and research (Gekhman et al., 2024) found fine-tuning on new facts can make a model make things up more, which is why the probes, the after-cutoff questions and the replay are there. Search or retrieval stays the dependable way to be current.

## License and credit

Wikipedia text is CC BY-SA 4.0: a published dataset keeps that license and links its sources. Pairs are written by Muse Spark Open, whose license asks derivatives to show "Built with Muse Spark Open"; the model card should say it.

## Next steps

1. Owner: a Fireworks (or Together AI) API key in `.env.local`, and an OK for the pilot.
2. Pilot 300 passages, read 50 pairs by hand, tune `QA_INSTRUCTIONS` and the checks.
3. Full dataset.
4. Build stage 3, dry-run it with the lab's fake platform, then wait for the owner's go to train.
