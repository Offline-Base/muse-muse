# 2026 knowledge update

Teach Muse Glimmer 30B, and later Muse Spark Open, what happened between Glimmer's knowledge cutoff (January 4, 2026) and now. Started Oct 29, 2026. This file is the plan and the place to pick the work back up.

## Status

Run `npm run knowledge:status` for the live numbers. As of Oct 29, 2026:

| Stage | State | Cost |
|---|---|---|
| 1. Corpus from Wikipedia | Built: 298 days, 6,446 events. Article fetch paused at 2,802 of about 3,000 (`npm run knowledge:resume`, then `npm run knowledge:corpus`) | Free |
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

## Exhaustive corpus (proposed Oct 29, not approved yet)

The owner wants the dataset to hold everything needed to teach any model what happened in this window, pulled from every source we can use. Stages 1 and 2 above become the first slice of it.

### What the release contains

One versioned release per end date (`knowledge-2026-10-28`), usable for any model:

| Part | What | For |
|---|---|---|
| `facts/` | Atomic dated facts: claim, event date, "as of" date, entities with Wikidata ids, topic, every source with its license, how many independent sources back it, and which older fact it replaces | The base everything else is made from |
| `documents/` | Source text. Openly licensed text in full; copyrighted text in a private, training-only split that is never published | Continued pretraining |
| `synthetic/` | Text Spark Open writes from the facts only: encyclopedia-style summaries, news briefs, timelines and explainers per entity and topic, several styles each | Knowledge sticks better with many phrasings |
| `sft/` | Chat data with no chat template baked in: several phrasings of each question, multi-turn talks, "what's the latest on X", timelines, comparisons, code that uses 2026 library versions, cutoff questions and "I don't know" for later days | Instruction tuning any chat model |
| `eval/` | Held-out probes with exact answers, multiple choice, put-in-order questions, after-cutoff questions, a pre-2026 forgetting set, packaged for lm-evaluation-harness and checked against common benchmarks so none leak in | Scoring any model the same way |
| `replay/` | General prompts only; each student answers them itself before training | Keeping old skills |

Every record has an event date, a publish date, a license and a source tier, so an export can take `--since <a model's cutoff>`, `--open-only` and `--format chat|sharegpt|alpaca|text`. A model whose cutoff is after January 4 takes only what it lacks. A model with an earlier cutoff needs the window extended back, which is one setting and roughly doubles the cost per extra year. A weekly refresh adds new days so "now" stays current.

### Sources

Open, free and publishable:
- Wikipedia: the January 1, 2026 dump (about 26 GB, on mirrors and a torrent) against the latest one, so every article created or changed in 2026 counts, filtered as in stage 1. The top non-English Wikipedias for regional news, optional. Wikinews, and Wiktionary for new words and senses.
- Wikidata: every statement dated in the window (winners, results, deaths, releases, versions, acquisitions, office holders). CC0. Exact answers for probes.
- Wikimedia pageviews: what people looked up each day, to rank topics and find gaps.
- Government, public domain or open licence: Federal Register, Congress.gov (bills and laws), White House and agency releases, court opinions (CourtListener), SEC EDGAR filings (every US public company's material events), BLS, BEA, Census, NASA, NOAA, USGS earthquakes, NWS storm events, CDC, FDA approvals; EUR-Lex and European Commission releases; gov.uk (Open Government Licence); central bank statements.
- Research: arXiv metadata and openly licensed full text, OpenAlex (CC0, every field), the PubMed Central open-access subset, bioRxiv and medRxiv where licensed, open conference proceedings.
- Software and AI: GitHub releases, changelogs and docs for the top 2,000 repositories; npm, PyPI, crates.io, Go, Maven, NuGet, RubyGems, Homebrew and Docker Hub metadata; Hugging Face model and dataset cards; CVE and the GitHub Advisory Database; framework docs under open licenses (MDN and others).
- Culture: MusicBrainz and Discogs data (CC0), Open Library (CC0), with results and awards from Wikipedia and Wikidata.

Copyrighted, training-only (facts first, never published as text):
- News at scale: CC-NEWS for every 2026 month and the monthly Common Crawl crawls (CC-MAIN-2026-04 onward, about 2.1 billion pages each), filtered to pages published in the window on news and primary-source sites. No 2026 FineWeb exists, so we run our own filtering. GDELT's event index and article links for discovery and coverage counts.
- Primary sources by entity: Meta's sites (Newsroom, AI and research blogs, dev.meta.ai docs and changelogs, investor releases, Hugging Face model cards, GitHub) and those of about 300 other notable companies, read from sitemaps and RSS.
- Exa: targeted search by topic and month, and gap-filling.

Left out:
- Stack Exchange 2026: its downloads now require affirming no LLM training, and the last dump without that (2025-12-31) predates the window.
- Reddit, X, YouTube, TikTok, Instagram and Facebook posts: their terms forbid this use.
- Paywalled articles, sites that opt out of AI training in robots.txt or reserve text and data mining under EU law, and personal data about private people.

### Processing at this size

- Common Crawl lives in AWS us-east-1, so filtering runs on a machine there (no download fees) using the text extracts and the URL index, not on this Mac.
- News repeats each story many times, so articles are clustered into stories first and facts come from one to three articles per story.
- Bulk fact writing runs on our own GPUs (Glimmer or Spark Open on vLLM) at a fraction of API prices: inference, not fine-tuning. Hosted Spark Open handles the parts where quality matters most: Meta, AI, the biggest stories and the synthetic text.
- Every step dedupes (exact and near), strips personal data, drops spam and low-quality pages, and keeps the source of every fact.

### Phases (each paused and capped, each reviewed before the next)

0. Setup: keys, the cloud machine, storage.
1. Open bulk: Wikipedia, Wikidata, Wiktionary, pageviews, government, research, software registries, culture databases. Free.
2. Meta and AI in depth: primary sources plus Exa, against a coverage checklist.
3. News at scale: GDELT, CC-NEWS and Common Crawl, clustered into stories.
4. Facts: extraction, merging, corroboration, "as of" updates.
5. Training text: synthetic documents, chat data, eval sets, exports and the dataset card.
6. Coverage audit: compare against pageview leaders, "2026 in ..." pages and Wikidata counts per topic and month, fill gaps with Exa, and repeat until two rounds find nothing new.

### Rough size and cost

| | Estimate |
|---|---|
| Raw text | 5 to 20 billion tokens (1 to 2 billion openly licensed) |
| Facts | 1 to 3 million |
| Chat examples | 5 to 10 million |
| Probes | About 20,000 |
| Phases 1, 2 and 6 with Exa and hosted Spark Open | $400 to $800 |
| Phases 3 and 4 at full scale (cloud filtering, GPU extraction, synthetic text) | $1,000 to $2,500 more |

These are early estimates; each phase reports its real numbers before the next starts.

### What the owner provides

- Exa and Fireworks (or Together AI) API keys, each with a cap.
- An AWS account for the us-east-1 machine, or a decision to skip Common Crawl.
- OK to use Lambda GPUs for bulk inference within the $250 a day budget.
- Somewhere to keep a dataset of several terabytes during building and the final release: a private Hugging Face dataset repo (pushed from the platform, never from a GPU) or S3 or R2.
- A contact email for the User-Agent that SEC EDGAR requires.
- The publishing call: open-licensed parts public, copyrighted-source parts private and training-only.

## Research round (Oct 29, in progress)

After the owner said they have AWS $10k, Lambda $7.5k, Google Cloud $2.5k and Exa $400 in credits, eight research agents went out, one per area, research only (no downloads, sign-ups or paid calls): 1 news and web at scale (Common Crawl, CC-NEWS, GDELT, news APIs, other languages, AI opt-outs); 2 Wikimedia and open knowledge bases; 3 government, law, elections, finance; 4 science, health, space; 5 software, developer tools, AI companies (BigQuery public datasets); 6 Meta on every channel, with a dated checklist of every announcement since January 4; 7 sports, culture, entertainment, business; 8 training methods and dataset design.

Done: 8 (methods, summarized below) and 4 (science, full table in `docs/knowledge-research/science.md`). Each finished report goes in `docs/knowledge-research/<area>.md`. If the others were cut off when the laptop closed, relaunch them with the same areas: each returns a source table (what it holds for 2026 and how that was checked, access, volume, license and AI-training terms, cost and which credits pay, verdict), its top 10, and what the plan above gets wrong.

Likely use of credits: AWS for Common Crawl filtering in us-east-1, large research collections and build storage; Lambda for bulk fact writing on our GPUs (possibly Spark Open itself, needing a read-only Hugging Face download token, never `HF_TOKEN`) and the training runs; Google Cloud for BigQuery public datasets; Exa for Meta coverage and gap-filling. The $250 a day Lambda limit would stretch $7.5k over about 30 days; ask the owner before raising it.

### Methods findings (agent report, links not yet checked by hand)

- Facts stick only when seen in many differently written texts with Q&A mixed in (Allen-Zhu and Li, arxiv 2309.14316; Ovadia, 2312.05934). Paraphrase plateaus; EntiGraph-style relation documents (2409.07431) and Active Reading, where the model writes its own study strategies per document (2508.09494), keep improving. Generate per fact, not per token (2404.00213). Include reverse-direction questions (reversal curse, 2309.12288).
- LoRA matches full fine-tuning when applied to all layers including MLP, rank not too small (128 matched full training in a September 2026 continued-pretraining study, 2609.23916; 32 fell short) and learning rate about 10x the full-fine-tuning one. Recall's best learning rate is about 10x lower than for skills.
- Replay: 1% to 25% old data depending on shift (2502.06042, 2403.08763); MoE routers held up with 30 to 40% replay (2503.05029). Anchor questions on popular older facts protect them (2609.08067).
- Hallucination: unknown facts learned late raise hallucination (Gekhman, 2405.05904). Label still-unknown facts "I don't know" (2403.05612, 2311.09677). Grade correct, wrong or abstained, as SimpleQA does, and report the wrong-answer rate.
- Time: date-prefixed text helps (2106.15110). Effective cutoffs differ from stated ones and the last months before a cutoff are weak, so measure each model's knowledge with a monthly "cutoff ladder" of probes instead of trusting `--since`.
- Knowledge editing (ROME, MEMIT) fails at this scale; retrieval plus continual fine-tuning wins (2503.05683).

Changes this implies for the release (to fold into "What the release contains" once the other seven report):
1. Per-fact metadata: `valid_from`, `valid_to`, `supersedes`, story cluster, popularity tier, source spans, entailment score; split train and eval by story cluster.
2. `synthetic/` built with Active Reading and EntiGraph-style strategies, dated, each document listing its fact ids, every claim checked against the fact store (numbers-only checks are too weak).
3. Contexts per fact by tier: core 8 to 12, middle 4 to 6, long tail 2 to 3; 3 to 5 question phrasings each including a reverse one; an exporter with `--token-budget` that keeps every fact's minimum.
4. Two training stages: A teaches knowledge from documents; B is chat tuning built after re-measuring what A learned (known facts get Q&A, unknown get "I don't have reliable information", plus fabricated and false-premise questions, current-date system prompts, answering from given context, about 4% cutoff examples).
5. Replay in three kinds: openly licensed older web text, the student's own answers, anchor questions.
6. Evals: held-out phrasings, reverse, multi-hop, ordering, latest value, about 2k never-trained window facts, fabricated questions, the cutoff ladder, SimpleQA and general suites, in lm-evaluation-harness, generated and multiple-choice forms.
7. Decontamination: exact and MinHash dedup (keeping deliberate restatements), 13-gram plus embedding plus LLM checks against benchmarks.
8. Ship facts and documents as a retrieval index too; retrain monthly from original weights on cumulative data rather than stacking adapters.

Reference recipe (30B dense, starting point, tune on an 8B pilot first): stage A at 60% window documents, 15% Q&A as text, 15% older web, 10% self-answers; 0.5 to 1B tokens, two passes; 4,096-token packed sequences; LoRA rank 128 on all linear layers; peak learning rate 1e-4, cosine; evaluate every 250 to 500 steps and keep the checkpoint that learns most while the wrong-answer rate stays within a point of base. About 13 to 23 hours on 8 H100s. Large MoE: router frozen, per-expert LoRA (or ESFT), core and middle facts only, 35% replay.

## Next steps

1. Owner: a Fireworks (or Together AI) API key in `.env.local`, and an OK for the pilot.
2. Pilot 300 passages, read 50 pairs by hand, tune `QA_INSTRUCTIONS` and the checks.
3. Full dataset.
4. Build stage 3, dry-run it with the lab's fake platform, then wait for the owner's go to train.
