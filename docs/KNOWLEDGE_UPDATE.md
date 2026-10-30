# 2026 knowledge update: the plan

Teach Muse Glimmer 30B and Muse Spark Open what happened between January 4, 2026 (the knowledge cutoff both models state) and October 29, 2026, then keep them current with a weekly refresh. The training data is built once, in a form that can update any model.

Rewritten October 30, 2026. It folds in eight research reports (`docs/knowledge-research/*.md`), the owner's handoff note (`docs/knowledge-research/inputs/handoff-2026-10-29.md`), a Gemini Deep Research report, and a check of 169 of their claims against primary sources (`docs/knowledge-research/claim-check-2026-10-30.md`). Every cost here is an estimate until a pilot measures it.

## What we deliver

| Deliverable | What it is |
|---|---|
| Dataset release `knowledge-2026-10-29` | Facts, source documents, synthetic text, chat data, evaluations and replay prompts for the window, with a license and dates on every record. Openly licensed parts are public; the rest is private and used for training only. |
| Tuned Muse Glimmer 30B | LoRA adapter, merged BF16 weights and a Q4_K_M GGUF, with eval results and a model card. |
| Offline model for the Jetson Orin Nano 8 GB | A 3B to 4B model taught the same knowledge, as a Q4 GGUF. Glimmer 30B itself can't run usefully on the board (see Jetson). |
| Tuned Muse Spark Open | A LoRA adapter for cloud use. No new quantization of Spark Open. |
| Weekly refresh | New days added every week; models retrained monthly. |

## Where things stand (Oct 30)

- Wikipedia corpus (stage 1): 298 days, 6,446 events. The article fetch is paused at 2,802 of about 3,000.
- Q&A builder (stage 2): code done and dry-run tested. Its writer changes from Spark Open to Glimmer (see Rules).
- Research and the claim check: done (two second checks still finishing).
- Nothing trained, nothing paid, no machines launched. "Don't start fine-tuning yet" still applies.

## Decisions

By the owner:
- Glimmer first, then Spark Open (Oct 29).
- The dataset must be exhaustive and usable for any model (Oct 29).
- Every stage can be paused and resumed (Oct 29).
- No fine-tuning and no paid model calls until the owner says go (Oct 29).
- Training runs on AWS, not Lambda, because Lambda only offers A10s right now (Oct 30).
- Exa is available: the key is in `.env.local` (Oct 30), under the Exa rule below.
- From the handoff: only Glimmer's line gets quantized for the Jetson; Spark Open stays in the cloud.

Changed by the claim check:
- Glimmer writes the default training data, not Spark Open. Spark Open's license is permissive, but any model trained on its outputs becomes a "Derivative" with conditions attached, and the any-model dataset shouldn't pass those on. Spark-written data, if used, lives in its own labeled split.
- Glimmer 30B at 1 to 2 bits isn't usable on an 8 GB Jetson, so the Jetson gets a 3B to 4B student.
- Fireworks trains Glimmer LoRA SFT for free through November 30, so the first training experiment goes there.

Waiting on the owner (details at the end): the go for each paid step, an AWS daily cap, whether to use Spark-written data, the publishing call, and a legal read on three questions.

## Rules

### Who may write training data

| Writer | Allowed | Why |
|---|---|---|
| Muse Wonder and Muse Spark 1.x through Meta's Model API | Never | Model API Terms 10.1(ix) (updated Oct 9, 2026) bar using Outputs to train or fine-tune any model that competes with Meta's, and systematically collecting Outputs to build training datasets. "Competing" isn't defined. 10.1(x) also bars approximating Meta's models through systematic querying. |
| Muse Glimmer 30B, self-hosted | Default | Apache 2.0, and its usage policy doesn't ban distillation. |
| Gemma 4, Qwen3.8-27B, Qwen3.5 and 3.6, DeepSeek V4 and V4.1-Flash, GLM-5.2 | Yes, if needed | Plain Apache 2.0 or MIT, checked on each model's page. |
| Muse Spark Open | Only in the `spark` split | The Muse Model License doesn't ban training other models, and Meta claims no ownership of outputs. But a model trained on its outputs is a Derivative: it must show "Built with Muse Spark Open" (in the UI, docs, website or settings), ship the license and usage policy with every copy, follow the usage policy, and, past $20M of model-as-a-service revenue in 12 months, needs an agreement with Meta. |
| GLM-5.3, Qwen3.8-Max and Flash-Next, Kimi K3, MiniMax M3.1, Mistral Medium 3.5, Gemma 3, Llama | No | Custom licenses with revenue triggers, naming rules or output-derivative clauses. |

### Sources

- Every crawled page passes the opt-out test. A page is dropped if its robots.txt blocks an AI-training crawler, if it sets `Content-Signal: ai-train=no` or an equivalent, or if it reserves text and data mining (TDMRep, `noai`, EU terms), taking the strictest answer across the window. The result is stored on the record.
- A record is public only if its license allows redistribution. Copyrighted text stays in a private, training-only split that is never published. NC and ND material stays out of anything published.
- Exa: its terms (4.2(a)) bar copying or deriving from "any information contained on, or obtained from or through, the Services" without written permission, which literally covers result lists. Exa sells training data under its own agreements (exa.ai/use-cases/model-training says "Contact Sales"). Until Exa confirms in writing, nothing from Exa is stored or used for the dataset.
- Fireworks: its terms (2.2(c)) bar using "any content available on or via the Service" for AI training. Sending our own data to its free SFT is fine. Training on outputs generated through Fireworks waits for a written answer from Fireworks.
- Each source's conditions travel in its records' license field: attribution for Wikipedia (CC BY-SA), citations for GDELT and BIS, the USDA NASS notice, EIA's credit line, PubMed's credit and currency statement, NASA's rule against "according to NASA" wording, Japan's PDL edit notes, Korea's KOGL source line.
- Personal data: no private individuals from court and DOJ records, no FEC donor names, no Dun & Bradstreet fields from USAspending in bulk.

### Spending

- Each phase has a spend cap and reports its real cost before the next one starts. Caps count earlier cached spend, so resuming can't go over.
- Lambda: $250 a day. AWS: $250 a day unless the owner sets another number, with an AWS Budgets alarm.
- AWS on-demand instances only. Capacity Blocks are charged up front, and the credit terms exclude upfront fees.
- Every GPU job has a time limit and terminates its instance when it finishes or stalls.

### EU AI Act

Our runs (about 10^20 to 10^21 FLOP) are far below the guidelines' line of one third of the original model's training compute, so we are downstream modifiers, not providers of a general-purpose model. We still publish a training-content summary with the dataset, modeled on the Commission's template.

## Data sources

Public: we may publish the text. Private: training only, never published. Facts only: we keep dates, numbers and names, not text. Licenses and details are in the research reports and the claim check.

**Wikipedia and Wikidata (public)**
- Wikipedia's Dumps 2 content history for October 1, 2026 (about 196 GB as 7z, 1.94 TB as bz2): every page as of January 4 against October 1, and the date each new sentence first appeared.
- The daily adds-changes files from October 1 on (about 0.93 GB a day for English). They're kept 42 days, so October 1's are deleted around November 12.
- The weekly CirrusSearch plain-text index, mediawiki_history (edits, with reverts flagged), Portal:Current events (built), and month, year and deaths articles in other languages.
- Wikidata's full JSON (CC0): every dated statement, and exact answers for evals.
- Wiktionary via Kaikki, Wikisource 2026 works, Wikinews (closed May 6), pageviews and clickstream.

**News and web (mostly private)**
- CC-NEWS 2026: 3.45 TiB of WARCs for January to September (roughly 7 to 10 million articles a month, an estimate), plus October.
- The ten 2026 Common Crawl crawls, through the URL index, for primary-source and regional sites.
- Already extracted: Infini-News v2 (26.7M articles from January to April 2026, 36.6 GB), Fine-News, CCNews-Plus, forecast-news.
- GDELT (public with a citation): event records, story clusters, links and coverage counts.
- Public outlets: VOA (minus wire copy), Global Voices, Kremlin.ru, DVIDS. Private: UN News, Agência Brasil.
- About 46% of 2026 long-form CC-NEWS editorial pages trip Originality.ai's AI detector (by its own threshold). So a likely-AI score lowers a page's weight, and such a page can't be a fact's only source.

**US government (public)**
- GovInfo (Federal Register, Congressional Record, bills, laws, presidential documents, court packages), Congress.gov, CRS, GAO, White House and agency releases.
- CourtListener bulk opinions, supremecourt.gov, Open States, LegiScan.
- SEC EDGAR: filing data and XBRL public, full text private.
- BLS, BEA, Census, Treasury Fiscal Data, the Federal Reserve, EIA (single prices only; its daily Brent and Henry Hub series come from LSEG and aren't republished whole), USDA NASS (with its notice), CFTC, USAspending (award amounts only), FEC (totals only), OFAC.

**Other governments (public unless noted)**
- EU: EUR-Lex, European Parliament, the Commission press corner, Eurostat, ECB, EU sanctions.
- UK: GOV.UK, legislation.gov.uk, Hansard, ONS, the UK Sanctions List. Companies House register data isn't under the OGL, so facts only.
- Japan: e-Gov laws (PDL 1.0), e-Stat (Standard Terms 2.0), JMA, and the Kanpo gazette (its site bans crawlers and issues are free for 90 days, so only small manual pulls). Diet minutes: private.
- Korea: items marked KOGL Type 1 or the new KOGL AI-training type.
- India: data.gov.in (GODL), PIB, the gazette and acts. Rajya Sabha debates: private (its terms allow only non-commercial reuse).
- France (Légifrance, Licence Ouverte), Australia (legislation.gov.au, CC BY 4.0; Hansard is NC-ND, so out), Canada (Statistics Canada, Bank of Canada; House of Commons private), Germany (Bundestag DIP).
- Official texts free by statute: Indonesia, South Africa, Kazakhstan, Uzbekistan, Greece, Saudi Arabia (and GASTAT), Mexico (and INEGI), Turkey, Egypt, Nigeria, Pakistan, Singapore (with AGC's notice), Ontario (with its notice). Not Quebec, Chile or Argentina's laws; Argentina's INDEC is CC BY-SA.
- International: BIS statistics (with a citation), the World Bank including the Pink Sheet (CC BY 4.0), OECD.
- Elections: Wikipedia's 2026 national electoral calendar and Wikidata, spot-checked against national election bodies. That's about 59 direct national votes in sovereign states in the window, or 70 to 76 with indirect ones.

**Science and health (license per paper)**
- arXiv (metadata CC0; CC-licensed full text public), OpenAlex, Semantic Scholar, Crossref, PubMed, PubMed Central open access (S3; read `license_code` on each article version and treat a null as unknown), Europe PMC, bioRxiv, medRxiv, OpenReview, ACL Anthology, DOAJ, Zenodo, OSF, Retraction Watch, Google Patents.
- ClinicalTrials.gov, openFDA (without GMDN fields), DailyMed, CDC MMWR, ECDC, EMA, NIH RePORTER, NSF, the Nobel Prize API. WHO: facts only.
- NASA, the Exoplanet Archive, GCAT (CC BY 4.0) and Launch Library 2 (with attribution) for launches, NOAA Storm Events, National Hurricane Center reports, USGS earthquakes, Copernicus, GDACS.

**Software and AI**
- Public: releases and changelogs of the top 2,000 GitHub repositories, permissively licensed 2026 commits, deps.dev, ecosyste.ms, PyPI on BigQuery, Homebrew, OSV, the GitHub Advisory Database, cvelistV5, CISA KEV (NVD now enriches only priority CVEs), endoflife.date, openly licensed docs, Hugging Face cards with open licenses, models.dev, LMArena, Epoch AI, the SWE-bench sets, Google's changelogs, the Stack Overflow 2026 survey.
- Standards: ECMAScript 2026, WHATWG, Python PEPs, newer Rust RFCs, and W3C specs under the permissive license (checked spec by spec). IETF RFCs word for word only. Unicode as data files and facts only, since the standard's text can't be redistributed.
- Private: Hacker News, Anthropic's release notes. GH Archive for discovery only, since it captures only a fraction of 2026 events.

**Meta**
- Newsroom (169 posts since January 4), the engineering blog, dev.meta.ai docs, changelogs and pricing, the AI blog (collected by hand), investor releases, SEC filings, GitHub and Hugging Face, the PyTorch blog. Oversight Board: facts only. Text is private except SEC filings; the facts are public.

**Sports, culture and business (public)**
- openfootball (World Cup 2026), Cricsheet, nflverse, Retrosheet once its 2026 season is out, Wikidata culture classes, TVmaze, MusicBrainz core, Discogs, Open Library (no declared license), GLEIF, NHTSA, fueleconomy.gov, BTS on-time data, Open Food Facts.
- Open books: DOAB, OAPEN, Language Science Press and Pressbooks titles under CC BY or CC BY-SA, checked book by book. OpenStax moved new editions to CC BY-NC-SA on April 22, 2026, so it's out.
- ForecastBench resolved questions for evaluation only, after dropping rows from sources that bar AI training (Metaculus, FRED).

**Not used:** Stack Exchange 2026, FRED, IMF, TMDB, IMDb, Sports Reference, the MLB, NBA and NHL stats APIs, Box Office Mojo, OpenAI's website, Reddit, X, YouTube, TikTok, Instagram, Facebook, Bluesky, Binance, CoinGecko, Yahoo Finance, EM-DAT, Jolpica F1 and OpenF1, StatsBomb, IGDB, PR Newswire, Manifold, Metaculus, Quebec's laws, Australia's Hansard, news sites that opt out, Meta's Model API, and Exa results until Exa agrees.

## The dataset

### Parts

```
knowledge-2026-10-29/
  facts/         atomic dated facts with sources and validity dates
  documents/     source text: public/ (open licenses) and private/ (training only)
  synthetic/     rewrites and questions written from the facts and documents:
                 open/ (Glimmer or another permissive writer), spark/ (Spark Open, if used)
  sft/           chat examples
  eval/          held-out probes, the monthly cutoff ladder, the forgetting set
  replay/        general prompts; each student answers them itself before training
  index/         the facts and documents as a search index, for retrieval
  MANIFEST.json  sources, versions, hashes, counts, licenses and the training-content summary
```

### Records

A fact:

```json
{
  "id": "fact-2026-10-25-brazil-presidential-runoff",
  "claim": "Lula won Brazil's presidential runoff on October 25, 2026, with 51.79% of valid votes against Flávio Bolsonaro.",
  "kind": "event",
  "entities": [{"label": "Luiz Inácio Lula da Silva", "wikidata": "<Wikidata id>"}],
  "event_date": "2026-10-25",
  "date_precision": "day",
  "valid_from": "2026-10-25",
  "valid_to": null,
  "as_of": "2026-10-29",
  "supersedes": null,
  "story_cluster": "story-brazil-election-2026",
  "topic": "politics",
  "region": "BR",
  "language": "en",
  "tier": "core",
  "sources": [
    {"url": "<TSE results file>", "publisher": "Tribunal Superior Eleitoral", "published_at": "2026-10-25T23:26:38-03:00",
     "retrieved_at": "2026-10-30", "license": "public record", "visibility": "public", "quote": "..."}
  ],
  "independent_sources": 2,
  "checks": {"two_sources": true, "entailment": 0.97, "ai_likely": false},
  "split": "train",
  "visibility": "public"
}
```

The other record types carry these fields:

| Part | Fields |
|---|---|
| documents | id, url, publisher, title, language, published_at, retrieved_at, license (id, url, evidence), opt_out (robots, content_signal, tdm, checked_at, allowed), visibility, text, sha256, near_duplicate_of, story_cluster, scores (quality, ai_likely), pii_removed, fact_ids |
| synthetic | id, kind (summary, news_brief, timeline, explainer, entity_relations, key_concepts, mind_map, implications, qa_critical, case_study, discussion, teacher, qa, prefix_continuation), lineage (open or spark), writer (model, revision, license), fact_ids, document_ids, text, checks (claims_supported, numbers_match), visibility |
| sft | messages (a system line with the current date; user; assistant, with optional reasoning_content), kind (qa, latest, timeline, compare, multi_turn, from_context, unknown, false_premise, after_cutoff, cutoff), fact_ids, lineage, as_of |
| eval | id, question, answer, aliases, kind (exact, multiple_choice, order, latest, reverse, multi_hop, false_premise, after_cutoff, unresolved, fabricated, forgetting), month, language, fact_ids, story_cluster, trained (always false) |
| replay | id, prompt, source (dataset, license), answers (one per student model revision, written by that model before training) |

### Rules for the data

- Train and eval are split by story cluster, so no story appears in both. About 2,000 window facts are never trained on at all.
- Contexts per fact, by tier: core 8 to 12, middle 4 to 6, tail 2 to 3. Each fact gets 3 to 5 question phrasings, including one reverse question.
- Every synthetic claim is checked against the fact store, not only the numbers.
- Dedup is exact and MinHash across everything, keeping deliberate restatements. Eval answers never appear in training text. 13-gram and embedding checks run against public benchmarks.
- The exporter takes `--since`, `--until`, `--open-only`, `--lineage open|all`, `--format chat|sharegpt|alpaca|text`, `--token-budget` and `--min-contexts`, so a model gets only what it lacks.

## How the dataset gets built

| Phase | What | Where | Cost (estimate) |
|---|---|---|---|
| 0. Setup | AWS GPU quota, an S3 bucket in us-east-1, a budget alarm, keys, a contact email for User-Agents | AWS | Free |
| 1. Save disappearing data | Wikipedia adds-changes files from October 1 (October 1's deleted around November 12), then daily; Kanpo issues inside its 90-day window; finish the paused Wikipedia fetch | S3 | Under $5 |
| 2. Open bulk | Dumps 2 history (7z), CirrusSearch, Wikidata, and the government, science, software and culture sources | AWS spot CPU and S3; BigQuery | $100 to $400 |
| 3. Meta and AI in depth | Primary sources, checked against the AI and Meta part of the coverage map | Mac or AWS | Free |
| 4. News at scale | CC-NEWS and Common Crawl: extract text, find publish dates and language, run the opt-out test, dedup, cluster into stories, score likely-AI pages | AWS spot CPU, Athena | $300 to $1,500 |
| 5. Facts | Glimmer on vLLM extracts facts from each story (1 to 3 articles) and from Wikipedia's new sentences; then merge, corroborate, link to Wikidata and build as-of chains | AWS GPU | $500 to $2,000 |
| 6. Training text | Synthetic documents, Q&A, chat data, evals and replay, written by Glimmer and checked against the facts | AWS GPU | $900 to $1,800 |
| 7. Coverage audit | Compare against the coverage map, pageview leaders, "2026 in ..." pages, Wikidata counts and GDELT stories; fill gaps; repeat until two rounds find nothing new | AWS | $50 to $200 |

The coverage map is the second Gemini brief ("everything a model should know"). Its report hasn't been saved; if it doesn't arrive, phase 7 builds the map from Wikipedia's "2026 in ..." pages and Wikidata. Phases 5 and 6 assume about 30 million output tokens an hour for a 30B model on one 8x H100 machine ($55.04 an hour), based on a published 70B FP8 benchmark. The pilot measures the real rate.

## Training methods

The terms:
- **SFT (supervised fine-tuning):** training on chat examples, each a prompt and the answer to learn.
- **LoRA and QLoRA:** training small adapter matrices on a frozen base; QLoRA keeps the base in 4-bit. They are cheaper ways to run SFT or continued pretraining, not separate objectives.
- **Continued pretraining (CPT):** next-token training on raw documents. With LoRA it's cheap. Full-parameter CPT updates every weight; for 30B that's about 360 GB of weights, gradients and Adam state before activations.
- **Self-distillation from context (SDFT):** the model reading a document in its prompt is the teacher, and the same model without the document is the student, trained on its own answers. This is the practical form of Google's "knowledge seeding".
- **RL (GRPO):** shapes behavior with a reward. Meta's docs: "RL shapes behavior. It doesn't teach the model facts it lacks."
- **RAG:** retrieval at answer time, no training. It stays the most dependable way to be current, so the facts and documents also ship as a search index.

What the checked research says:
- Facts stick when the model sees them in many differently written texts, and at large scale synthetic rewrites nearly match having the passage in context. On SQuAD (Qwen2.5-7B, 200 passages, synthetic data 4,000 times the size of the source) the base scores 31.3%, SEAL 74.2%, rephrasing 86.9%, Q&A only 89.6%, Active Reading 90.3% and SPA's seven templates 91.3%, against 91.4% with the passage in context (SPA, arXiv 2603.22213). SPA's templates: key concepts, mind map, implications, Q&A with critical thinking, case studies, discussions, teacher-style.
- Active Reading (Llama 3.1 8B) took SimpleWikiQA from 7.4% to 66.3%, about the same as having the documents in context (65.9%), using about 4 billion generated words.
- SDFT (arXiv 2601.19897, Qwen2.5-7B-Instruct, facts about 2025 disasters from Wikipedia) reached 89% strict accuracy, against 80% for SFT and 9% for continued pretraining, and 98% against 80% and 7% on out-of-distribution questions. TRL has it as the experimental `SDFTTrainer`: the teacher is the same model with the adapter switched off, reading a `privileged_context` column, so no second copy of the model is loaded.
- Google's sleep paper (arXiv 2606.03979) is real but doesn't carry over: it relies on its own memory architecture with MoE experts, tests models of 8B or less, and has no code. SDFT stands in for its knowledge-seeding step.
- Sparse memory fine-tuning (Meta FAIR) forgets least (an 11% drop on a held-out benchmark, against 71% for LoRA and 89% for full fine-tuning) but needs memory layers Glimmer doesn't have.
- Order matters: Q&A before or mixed with the documents beats documents first, then Q&A (PIT, ACL 2024: 48.1% against 30.3% on Llama 2).
- LoRA goes on all linear layers. Rank 128 matched full continued pretraining at 1B and came close at 3B (arXiv 2609.23916). There's no evidence at 30B, so we test rank 32 (Meta's default) and 128.
- Facts learned late in training make made-up answers more likely (Gekhman et al., 2024). Facts the model still doesn't know after training become "I don't have reliable information" examples, and grading counts correct, wrong and abstained separately.
- Meta warns that fine-tuning Glimmer only on final answers can suppress its chain of thought. SDFT trains on the model's own reasoning, and SFT examples include reasoning written by Glimmer.

The approach:
1. Stage A teaches the knowledge, by whichever of SFT, mixed CPT or SDFT wins the pilot, with 15 to 25% replay of older material.
2. Re-measure what the model now knows.
3. Stage B is a short chat SFT built from that measurement: known facts as Q&A with reasoning, unknown ones as an honest "I don't know", false-premise and after-cutoff questions, a current-date system line, answering from given context, and about 4% cutoff examples.

## Glimmer

The model: `meta-models/Muse-Glimmer-30B`, a dense 29.7B text model plus a vision encoder (kept frozen), 128K context, Apache 2.0. Pin the revision Meta's recipe uses (`a4e59da52a7bc87ae7251dd5545c0dd437c44b68`). Fireworks doesn't publish which revision its base is; the Hugging Face weights haven't changed since August 10 (commit `46ac57a4`), so compare weight hashes before merging a Fireworks adapter onto the public weights.

Tools: Meta's verified recipe is Axolotl 0.19.0 with its pinned versions (torch 2.12.1, CUDA 13.0, flash-attn 2.8.3). Its QLoRA run peaks at 27 to 29 GiB on one H100. TRL 1.17.0 handles SFT and SDFT; don't pin 1.12, which was published by accident as a copy of 1.11. Meta lists Unsloth for Glimmer training as "planned", so we use it only where the lab already proved it.

Starting settings: LoRA on all language projections (q, k, v, o, gate, up, down) with vision frozen; rank 32 and 128; QLoRA learning rate 2e-4 (Meta's), swept from 1e-4 to 3e-4; 4,096-token sequences, packed for text (Meta's no-packing rule is for images); memory sized for the second optimizer step; checkpoints to S3 every few hundred steps, so a stopped run resumes.

Experiments, each at pilot size first (about 3,000 facts, 10 to 20 million tokens):

| # | Method | Data | Runs on | Cost (estimate) |
|---|---|---|---|---|
| G0 | Baseline, no training | Eval suite | AWS, 1x H100 ($6.88 an hour) | $20 to $40 |
| G1 | LoRA SFT on Q&A | About 10,000 Glimmer-written Q&A pairs | Fireworks, free through Nov 30 (eval sampling billed at $1.96 in and $4.88 out per million tokens) | $0 to train, $5 to $20 to evaluate |
| G2 | LoRA continued pretraining | Documents plus synthetic rewrites | AWS, 1x H100, QLoRA | $30 to $80 |
| G3 | Mixed, Q&A first (PIT) | Q&A, then Q&A plus documents | AWS, 1x H100 | $40 to $100 |
| G4 | SDFT | Passages with question prompts | AWS, 1x H100, TRL SDFTTrainer | $50 to $150 |
| G5 | The winner plus the stage B chat SFT | | AWS | $20 to $40 |
| G6 | Rank, learning rate and replay sweep on the winner | | AWS | $100 to $250 |
| G7 | Full run | 300 million to 1 billion tokens | AWS, 8x H100 ($55.04 an hour) | $700 to $2,500 |

These costs come from Meta's measured QLoRA runs and AWS on-demand prices. The pilot measures real tokens per second before anything bigger.

Fireworks details for G1: LoRA SFT only; chat-format JSONL of 3 to 3 million lines. Set the LoRA rank explicitly, because the REST API sends a missing rank as 0, which means full-parameter training (not free). Jobs must start before 2026-12-01 00:00 Pacific. Download the adapter in PEFT format and merge it on AWS. Ask Fireworks first whether the free offer needs a payment method on file, how a job that runs past the deadline is billed, and which base revision it uses.

Pass or fail: keep the checkpoint that learns the most window facts while its wrong-answer rate stays within 1 point of base and its general scores stay inside their confidence intervals. If retention slips, lower the learning rate or epochs, add replay, or lower the rank. Nothing that regresses ships.

Outputs: the PEFT adapter, merged BF16 weights, a Q4_K_M GGUF (llama.cpp b10353 or newer; text-only with `--no-mmproj`), and a model card listing the data's licenses. The tuned chat template's `knowledge_cutoff` moves from 2026-01-04 to 2026-10-29 only once the evals show the model knows the window.

## Spark Open

The model: 816B total and 42B active parameters, 256 experts with 8 active per token. BF16 weights are 1,644 GB; Meta's NVFP4 weights are 533 GB and need at least 700 GB of GPU memory.

Training options, checked:
- No documented recipe uses 8 GPUs or fewer, and only Fireworks trains on a quantized base. TorchTitan's LoRA recipe uses 16 GB300 GPUs; TRL's uses 64 H100s (14.2 s per step, 40.2 GB per GPU); NeMo's uses 32 GB200s.
- Fireworks serverless LoRA on the NVFP4 base supports SFT, DPO, distillation and RL, rank up to 64 and 262K context. It costs $18.58 per million training tokens plus $6.19 per million prefill and $15.48 per million sampled, paid in cash (cloud credits don't cover it).
- On AWS, TRL's recipe needs eight 8x H100 machines (about $440 an hour), a quota of 1,536 vCPUs and EFA networking, which a new account is unlikely to get. Not planned.

The plan:
1. S0, baseline: run the eval suite on Spark Open through Fireworks ($1.25 in and $4.25 out per million tokens; a few million tokens, about $10 to $25), with the owner's OK.
2. S1, after Glimmer's recipe wins: a Fireworks LoRA pilot on the same data (10 million training tokens, about $190 plus sampling), then a full run (50 to 100 million tokens, about $930 to $1,860), each with the owner's OK.
3. Serve on Fireworks, or download the adapter. Before relying on it, check with Fireworks whether an adapter trained on the NVFP4 base works on the BF16 weights.

## Jetson

What the check found:
- The Orin Nano 8 GB shows about 7.5 GiB to Linux and has 68 GB/s of memory bandwidth (102 GB/s in Super mode). Our boards run JetPack 7 and llama.cpp releases b11574 and b11970.
- Glimmer 30B's smallest community files are 4.85 to 7.06 GB, which is really 1.4 to 2.0 bits per weight. A similar dense 27B model scores about 42% on MMLU at that size (IQ1_S), against 71% at 4 bits; random guessing gets 25%. Not usable.

The plan:
1. Pick a 3B to 4B student with a permissive license that llama.cpp runs: Gemma 4 E4B (Apache 2.0), Qwen3.5-4B (Apache 2.0), Granite 4.2 3B (Apache 2.0) or Nemotron 3.5 Bolt E4B (OpenMDW; already 13 to 15 tokens a second on our boards). Not Liquid's LFM models (their license limits use above $10M of revenue) or Llama 3.2.
2. Train it on the dataset's open lineage (documents, synthetic text, Q&A) plus tuned Glimmer's answers to the same questions. That Glimmer must have no Spark-written training data, so the student stays permissive. A 4B QLoRA fits on Lambda's A10s.
3. Quantize to Q4_K_M (about 2.5 to 3 GB) and test on one board through the fleet's normal deploy path, with the owner's OK. Record RAM, tokens a second, fact accuracy and power, at 512 to 2,048 tokens of context.
4. For the record only, measure Glimmer 30B at Q4_K_M, IQ2_M, IQ1_M and Q1_0 on a cloud GPU.

## Evaluation

- Probes come from held-out story clusters, in several phrasings: exact answers, multiple choice, ordering, the latest value of something, reverse questions, multi-hop, false premises, made-up entities, days after the cutoff (the right answer is "I don't know"), open stories (no invented outcomes), and other languages.
- A monthly cutoff ladder, January to October, shows what each model already knows before training.
- Forgetting: pre-2026 facts, SimpleQA, and general suites for reasoning, tool use, structured output and other languages.
- RealTimeQA's 2026 weekly sets are for internal checks only (no license). FreshQA hasn't updated since April 2026.
- Grading is correct, wrong or abstained, by exact match with aliases. Any model judge is Glimmer or another permissive model, never Meta's API.
- Closed-book runs (no tools) and retrieval runs are reported separately. Results carry confidence intervals.

## Weekly refresh

- Every week: pull the new days (Wikipedia current events and adds-changes files, GDELT, new CC-NEWS files, government feeds, Meta's Newsroom), extract facts, update as-of chains, add a held-out eval set for the week, re-run the regression evals, update the search index.
- Every month: retrain from the original weights on all data so far (the methods research's recommendation), compared against adding one adapter on top. Keep the better one; roll back on any regression.
- Every week: re-fetch each source's terms page and flag any change.

## Costs and credits

| Item | Paid with | Estimate |
|---|---|---|
| Data phases 0 to 2 and 7 | AWS credits (Google credits for BigQuery) | $150 to $600 |
| News at scale (phase 4) | AWS credits | $300 to $1,500 |
| Facts and training text (phases 5 and 6) | AWS credits | $1,400 to $3,800 |
| Glimmer pilots G0 to G6 | AWS credits, plus Fireworks eval in cash | $260 to $660, plus about $20 cash |
| Glimmer full run G7 | AWS credits | $700 to $2,500 |
| Storage, about 5 to 10 TB during the build | AWS credits | About $115 to $230 a month |
| Jetson student | Lambda credits (A10s) | $50 to $200 |
| Spark Open baseline, pilot and full run | Cash (Fireworks) | $1,150 to $2,100 |
| Weekly refresh | AWS credits | $50 to $200 a week |
| Exa | Exa credits, only after Exa agrees | Up to $400 |

AWS comes to about $3,000 to $9,500 of the $10,000 before the weekly refresh, so phases 4 to 6 get capped and measured first. Lambda's $7,500 mostly waits for H100s to come back. Google's $2,500 covers BigQuery (GDELT, patents, deps.dev, PyPI) with room to spare.

## Dates

- Now: request the AWS GPU quota, which can take days.
- By about November 12: save October's Wikipedia adds-changes files (September 18's are deleted around October 31).
- Before 2026-12-01 00:00 Pacific: start any free Fireworks Glimmer SFT jobs.
- Then, roughly: weeks 1 and 2, setup, the saves and pilot data, with G0 and G1; weeks 2 to 4, phases 3 to 6 at pilot size and G2 to G6; weeks 4 to 6, the full data, G7, the Jetson student and the Spark Open pilot; then the weekly refresh.

## What the owner needs to do

Free, and best done now:
1. AWS: request the "Running On-Demand P instances" quota (192 vCPUs for one 8x H100 machine; 16 for a single H100), confirm the Credits page lists EC2, S3 and Athena, and set the daily cap.
2. Fireworks: ask in writing about terms section 2.2(c), the free offer's limits and the base revision.
3. Exa: send the training-rights email (drafted in chat on Oct 30).
4. A contact email for the SEC, BLS and Wikimedia User-Agents.
5. Free keys: api.data.gov, BLS, BEA, Census, EIA, USDA NASS, Semantic Scholar, an OpenReview login, LegiScan, Bundestag DIP.

Decisions:
6. Go for the phase 1 saves (under $5) and the G0 baseline ($20 to $40).
7. Whether Spark-written data is used at all.
8. Publishing: the open parts go to a Hugging Face dataset repo after review; the private parts stay in S3 only.
9. A lawyer's read on: the fine-tuning lab's Wonder-written datasets under Meta's 10.1(ix); training on copyrighted news in a private split; ND and NC content.

## Pause and continue

Every stage can stop at any point and carry on later without losing work or spending twice.

- `npm run knowledge:pause` (or Ctrl+C in the terminal that's running it): the running stage finishes the requests in flight, caches them and stops. No output file is overwritten with partial results. New runs refuse to start while paused.
- `npm run knowledge:resume` lifts the pause. Then run the same stage command again: it reads its cache and only does what's missing.
- Spend caps (`--max-usd`) count every cached answer from earlier runs, so resuming can't go past a cap.
- Everything lives in `.data/knowledge/` (git ignored): `raw/` (Wikipedia pages), `qa/` (one cached answer per passage), `events.jsonl`, `articles.jsonl`, `manifest.json`, `dataset/`.

Training jobs follow the same rule: checkpoints go to S3 every few hundred steps, and a stopped job relaunches from its last checkpoint.

## Code so far

- `lib/knowledge/` and `scripts/knowledge/`: the Wikipedia corpus (stage 1) and the Q&A builder (stage 2). Commands: `npm run knowledge:corpus`, `npm run knowledge:dataset -- --dry-run --limit 40`, `npm run knowledge:status`, `npm run knowledge:pause`, `npm run knowledge:resume`.
- The corpus turns `Portal:Current events` pages into dated events, and keeps sentences that are new in linked articles since January 4 (rewrites with 70% or more word overlap don't count, and a sentence must relate to 2026).
- The Q&A builder calls an OpenAI-compatible endpoint (`SPARK_OPEN_BASE_URL`, `SPARK_OPEN_API_KEY`, `SPARK_OPEN_MODEL`). To make Glimmer the writer, point it at Glimmer served by vLLM (which speaks the same API) and rename the settings. Fireworks no longer serves Glimmer serverless.
- The fine-tuning lab (`lib/train/`) runs on Lambda (`lib/train/lambda.ts`). The knowledge jobs need a small AWS runner: EC2 on-demand, S3 for data and checkpoints, and a hard time limit.

## Evidence

- `docs/knowledge-research/`: the eight research reports (news, wikimedia, government, science, software, culture, meta, plus the methods findings folded in above) and `meta-newsroom-2026.tsv`.
- `docs/knowledge-research/claim-check-2026-10-30.md`: 169 claims checked against primary sources, with quotes and links.
- `docs/knowledge-research/inputs/handoff-2026-10-29.md`: the owner's handoff note.
