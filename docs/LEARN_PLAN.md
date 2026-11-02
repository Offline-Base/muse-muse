# Learn plan: redo all 30 of Meta's lessons

Written Mon Nov 2, 2026, on branch `tg-learn` (PR #69), from the Nov 2 audit of every lesson on Meta's Videos page, the review of this branch, and a read of the code and docs named below. **Status: planned. Nothing in this file has run, nothing has been spent, and nothing starts until the owner says go.** The owner said: redo all of them, but not now; plan it, and they will say when.

**Meta models only (updated Nov 2, evening, branch `tg-mo-learn-plans`).** The organizers ruled on Nov 2 (3:57 PM ET, Cerebral Valley Discord; docs/MESSAGING.md, rules section) that Llama of any version, Llama Guard and Prompt Guard do not count as Meta models, and that every model the project runs must be a Meta model. So every tune below is Muse Glimmer 30B (r30b), the default base, with `TUNE_ANY_BASE` left off: about $1.39 to $1.86 of GPU a run (measured: $1.39 for the 40 of 40 brief-writer run on an A100, 42 to 48 minutes; $1.86 for 120 steps on an H100, BUILD_LOG Nov 1), and its files you keep are one-bit IQ1_S (6.53 GB) or Q4_K_M (16.9 GB, kept only if it passes its closeness check; the one tuned r30b Q4_K_M so far missed it by 0.00045). The Prompt Guard 2 layer and the optional guard tune are gone: Muse Wonder is the only safety layer. The free Kaggle notebook is retired, since it tunes Llama and Glimmer 30B doesn't fit a free 16 GB T4. Meta's Llama-era videos stay linked as reading.

Every number below is an estimate unless it says measured, and every measured number names where it was measured. "Is built so" is used for anything that exists in code but hasn't run. Sources: `catalog/meta-resources.json` (the 30 cards), docs/CHAIN_RUN.md, docs/EDGE_PLAN.md, docs/TRAINING.md, docs/JUDGING_WEEK.md, docs/DATA_RIGHTS.md, docs/BUILD_LOG.md (Nov 1 and Nov 2), `lib/train/bases.ts`, `lib/env.ts`, `lib/gateway/policy.ts`, `app/api/rebuilds/route.ts`, `scripts/rebuild-all.ts`, `scripts/dev/receipt-bench.py`, `scripts/dev/drill-bench.py`, `notebooks/README.md`.

Lessons are numbered L1 to L30 in the order Meta's page lists them. Builds are P1 to P12, tunes are T0, T1 and T3, prep units are U1 to U8 and K1.

## 1. Summary

### Totals

Two ways the platform can be set when the owner says go. **Mode A** is today: `BUILDS_ON_CONTRIBUTOR` is on, so builds, the dataset writer and the tune judge run on Muse Spark 1.3 Contributor, and the lesson products get Muse Wonder at run time through the gateway once their slugs are added to `WONDER_DEMO_SLUGS` (U3). **Mode B** is after the planned Nov 4 flip to Wonder (docs/JUDGING_WEEK.md, "Flip to Wonder"): everything with a model runs on Muse Wonder.

| | Mode A (today's settings) | Mode B (after the flip) |
|---|---|---|
| Meta credits | $6 to $36, about $21 expected | $38 to $85 |
| GPU dollars (Lambda) | $7.70 to $10.80, about $9 expected (three r30b site jobs at $1.39 to $1.86, two IQ1_S files on an A10 at about $1.75 to $2.60 each); hard caps allow at most about $18.90 (three $5 site jobs, two 90-minute A10s) | the same |
| Other cloud (AWS Windows lab box, for L28) | $0.50 to $1 | the same |
| Free Kaggle runs | None. Retired by the Nov 2 ruling: the notebook tunes Llama, and Glimmer 30B doesn't fit a free T4 | the same |
| Builds | 12 (P1 to P12) | 12 |
| Tunes | 2 new site tunes (T1 receipts, T3 teacher to student) plus 1 tuning-loop round on T3; T0 (the cold-room chain run) is reused, not rerun | the same |
| Files you keep | 2 new one-bit IQ1_S GGUFs (T1, T3), a Q4_K_M beside each only if it passes its check, plus T0's IQ1_S from the chain run | the same |
| Board jobs | 1 (Hussam: T1's IQ1_S file on a board, scored on the 40 sealed receipts, only if the edge gate H1 passed), $0 | the same |
| Wall time | 5 evenings, about 18.5 hours of runs | the same |
| Prep before batch 1 | about 15 agent hours of code and fixtures, $0 (section 2) | the same |
| Watching | about 6 hours of talks at normal speed, by a person, for the watch guides | the same |

Not counted here: T0, the cold-room chain run, has its own approved $25 cap (O2, docs/CHAIN_RUN.md) and runs whether or not this plan does. The optional steps marked "optional, not in the totals" (L5's 100-row overfit job) are not counted either. The Glimmer step-up became the main tune, and the guard tune and the Llama 4 Scout run are dropped under the ruling.

Where the money goes in Mode A: about half is the 12 builds on Contributor ($0.02 to $1.80 each; $0.92 was the highest of the last three, docs/JUDGING_WEEK.md), about 45% is the products' own Wonder calls when the benches run (40 receipt photos, a 45-prompt safety bench, 24 file questions three ways, 40 issues), and the rest is judging and data on Contributor. In Mode B the builds alone are $23 to $54 (each lesson's Wonder build estimate in section 4, from the six Oct 28 rebuilds at $1.66 to $5.01) and T3's 300 Wonder-written examples are $4.62 to $10.14 (the New dataset card's estimate).

### What one run of the whole plan proves

When every batch has run and its log entry is in docs/BUILD_LOG.md, each of the 30 cards on `/learn` moves from planned to run (U1) with its own measured result, and together they show the owner's headline, frontier plus edge and defense, set up for any scenario:

- **Frontier:** Muse Wonder doing each tutorial's technique (reading receipt photos, page-by-page document parsing, retrieval with citations, three-pass issue triage, prompt optimization, long context, many images, tool calls), with a number scored in code on invented data whose answers are known, not a model's opinion.
- **Defense:** one safety lab with separate layers, run on a fixed 45-item labeled bench, reporting what each layer caught, missed and flagged by mistake. Every layer is Muse Wonder.
- **Edge:** tuned one-bit Muse Glimmer 30B (r30b) files (IQ1_S) you keep, served with llama.cpp on Linux, on a Windows box and on a Jetson board, each scored by code on held-out invented items. One-bit answers are slow (about 4.7 tokens a second on jetson-02) and weaker than the cloud, and the cards say so. The cold-room chain run (T0) covers the outage drill and the take.
- **Fine-tuning:** two more r30b Glimmer launches through the site (after T0), each judged blind against its base with the general and safety checks on, one tuning-loop round that shows where more synthetic data stops helping, and every number labeled by which check made it.
- **Honest limits:** each card also says plainly what Muse Muse can't do yet (vision fine-tuning, a Meta model smaller than Glimmer 30B to tune first, running Llama or guard models, which aren't Meta models under the hackathon's rules, an air-gapped deployment), so no card claims more than ran.

It does not prove: real-world accuracy on real receipts, documents or traffic (all data is invented), that a guard stops attacks, that anything works offline in general, or anything about a Mac until the owner allows the L22 run (section 4, L22).

## 2. Before any batch

### Gates

| Gate | What | Who | Needed for |
|---|---|---|---|
| G0 | The owner says go, and names the evening | Owner | Everything |
| G1 | PR #69 (`tg-learn`) and the prep PR (U1 to U8, K1) merged and deployed. `POST /api/rebuilds` builds from the **deployed** catalog's `rebuild.note`, so the muses must be live first | Owner or Hussam merges | Every build |
| G2 | The shared clock is free: not during the chain run (Tue 8 AM to 3 PM ET), the edge take (Tue 7 to 9 PM), or Wed morning's submission (docs/EDGE_PLAN.md). docs/JUDGING_WEEK.md says "run no batches on production this week" (Nov 4 to 9) because the daily cap is shared with judges. **Recommended: start after judging ends.** If the owner wants a batch during judging week, run only Mode A batches and keep at least $30 of the day's cap for visitors | Owner | Every batch |
| G3 | T0 has run and is logged, and its IQ1_S file was copied off with its sha256 checked. It is a hand transfer, not a public repo: folder rows can't be published (docs/CHAIN_RUN.md), and M9's Llama repo is dropped. Readers get the steps, not the file | Chain run | Batches 2, 3, 5 |
| G4 | Data-rights Q2 answered (docs/DATA_RIGHTS.md): may we train on Meta Model API outputs? | Owner | T3 and its lessons (batch 3). If no, T3 is dropped and its lessons use T0 and T1 (section 4 says how each card changes) |
| G5 | `TUNE_ANY_BASE` stays **off**, so every job trains r30b; `TUNE_GENERAL_CHECKS` on for T1 and T3, `TUNE_LOOP` on for batch 3, `TRAIN_CONTRIBUTOR_WRITER` on (it is, per JUDGING_WEEK). Each change needs a redeploy and one sweep after it before pressing Start | Owner | Batches 1 and 3 |
| G6 | Mode A only: U3's slug list merged and deployed after the builds, so the benches run on Wonder. Without it, a bench runs on Contributor and its number is labeled "Test model", and P2's voice notes are refused (Contributor lists no audio input, `lib/gateway/policy.ts`) | Owner merges | Every bench |
| G7 | `MEDIA_SPEECH` stays off for these builds: its in-page model (SpeechT5) is not a Meta model. P2 and P9 read aloud with the browser's own voice only, and whether to keep even that is an open owner question | Owner | P2, P9 |
| G8 | The edge gate (docs/EDGE_PLAN.md, H1) passed, and Hussam agrees to batch 2's board job on a board that can hold a 6.53 GB IQ1_S file (jetson-02 today, if the owner or Hussam lifts the "never jetson-02" rule), never jetson-05. If the gate failed, L25's board stop is dropped and says why | Hussam | L25, L1's edge step |

### Prep units ($0, code and fixtures only, no model or GPU)

All written by code from seeds, invented, rights-clean, with right answers computed in code. One PR for all of them; tests only for the touched files.

| Unit | What | Hours | Used by |
|---|---|---|---|
| U1 | Card status: widen `LessonPlan.status` in `lib/types.ts` to `"planned" \| "run" \| "dropped"`, add `result?: { date, summary, spendUsd, log }`, render a "Run" pill and the result line in `components/learn/LearnView.tsx`, change the header count. Test in `components/learn/__tests__/learn.test.tsx` | 1.5 | Section 5 |
| U2 | Catalog: put each build's exact muse (section 4) in its owning lesson's `rebuild.note`; add `learn.sharesWith` on the lessons that share a build or tune, and have their cards show "Shares <lesson>'s product" instead of "Build its product", so nothing is built twice | 1.5 | Every build |
| U3 | After a batch's builds: add the new lesson slugs to `WONDER_DEMO_SLUGS` in `lib/gateway/policy.ts`, with its test. Skipped in Mode B | 0.5 each batch | G6 |
| U4 | Receipts: in `scripts/dev/receipt-bench.py`, (a) a `folder/` output in the TUNE_FOLDER row format with the `SYSTEM` line, the drill-bench pattern, with a test that the folder keeps all rows; (b) more wordings in the three training layouts (an earlier experiment, a Llama tune on a board that is not part of the submitted project, missed "Net / VAT / Gross" because training had one wording each), with `heldout.jsonl` pinned by sha256 before and after so the board numbers stay comparable (if the held-out file changes, stop and keep the old wordings), and `scripts/dev/receipt-bench.test.ts` checking the folder keeps all 300 rows and the hash holds; (c) `photos`, which renders the 40 held-out receipts as PNG images with their ids; (d) `ask --url` against any OpenAI-compatible endpoint without `--board` or `FLEET_TOKEN`, and a `--schema` option that sends the `json_schema` response format, as drill-bench's does (one-bit Glimmer gave no valid JSON without it); (e) a converter from P1's download to `score`'s answer format | 2.5 | T1, P1, L1, L25 |
| K1 | **Dropped (Nov 2 ruling).** The Kaggle notebook tunes Llama, and Glimmer 30B doesn't fit a free 16 GB T4, so there is no free twin. L5's overfit check becomes an optional 100-row r30b job on the site (section 4, L5) | 0 | none |
| U5 | Safety bench: `eval/learn/safety-bench.jsonl`, 45 made-up labeled items (20 benign, including ones that look scary but are fine; 10 jailbreaks; 10 indirect injections hidden in pasted pages; 5 replies with insecure code), mild and holding no harmful instructions, like the safety set in docs/TRAINING.md. A scorer, `scripts/dev/learn-score.py safety`, that counts caught, missed and false flags per layer | 1.5 | P6, L6, L16, L30 |
| U6 | Fixtures and scorers in `eval/learn/` and `learn-score.py`: (a) a made-up 4-page research paper PDF with a table, a chart and known values; (b) 50 invented facility-support messages with urgency, sentiment and category labels; (c) a made-up product manual (about 10k tokens), a 12-file made-up code repo, and 24 questions with the answer and the passage or line (20 covered, 4 not); (d) 40 invented GitHub issues with labels and 5 planted duplicate pairs, as `gh issue list --json` output; (e) 3 shelf images drawn by code with known item counts; (f) 3 fixed texts (English, Spanish, code) for token counts; (g) a made-up 6-page PDF for the podcast; (h) a folder of 5 made-up how-to docs for a made-up shop. `learn-score.py` subcommands: `paper`, `baseline`, `prompt`, `files`, `triage`, `podcast`, `shelf`, `tokens`, and `facts` (T3's store facts: 8 AM to 8 PM, 14 days, 3 miles, $30), each with a test that the right answers score 100% | 4 | P3, P4, P5, P7, P8, P9, P10, P11, P12, L9 |
| U7 | `scripts/dev/learn-judge.ts`: a blind A and B judgement of two outputs for the same input, using the judging rubric in `lib/train/judge.ts`, random order, prints wins and cost; `--dry` makes no calls. Used only where code can't score (P3, P9) | 1.5 | P3, P9 |
| U8 | Watch-guide drafts: for each talk, Claude fills a template from Meta's page and the YouTube description (read-only GETs). Timestamps and key ideas stay empty until a person has watched it | 1 | Every talk card |

Total about 13 agent hours. They can run as 3 to 4 agents at once.

## 3. Batches

Each batch fits one evening, about 6 PM to 10:30 PM ET, with at most 3 heavy jobs at once. A heavy job is a GPU (a site tune, a hand-launched A10), a sandbox build, a board, the AWS Windows box, or a model on the laptop.

| Batch | Lessons | Shares | Heavy jobs at once | Meta, Mode A | Meta, Mode B | GPU | Wall |
|---|---|---|---|---|---|---|---|
| 1. The six we got wrong or partly wrong | L1, L2, L3, L4, L5, L6 | T1 (L1, L5); P5 (L5, later L15, L18); P6 (L6, later L16, L30) | T1 on Lambda, then the A10; 2 builds | $2.50 to $16.75 | $17.60 to $38 | $3.15 to $4.50 | 4.5 h |
| 2. Defense and edge | L30, L16, L21, L22, L25, L28, L13, L29 | P6 (L30, L16); T0's file (L21, L22, L25, L28); T1's file (L25); P7 (L13, L29) | 1 build; the Windows box; 1 board (only if the edge gate passed); L22 only on a Mac that isn't the owner's laptop | $1.60 to $5.60 | $3.60 to $8.80 | $0 | 3.5 h |
| 3. Fine-tuning on one shared tune | L26, L9, L17, L20, L23, L15 | T3 (L26, L9, L23, L15, later L12, L19); T0 (L17); T1 and T3's measured runs (L20) | T3 on Lambda, then its loop round, then the A10 | $0.25 to $0.50 | $9 to $16 | $4.55 to $6.30 | 4.5 h |
| 4. The other tutorials and the course | L7, L8, L10, L11, L14 | P11 (L11, L14) | 2 builds | $1.73 to $11.50 | $6.30 to $17 | $0 | 3 h |
| 5. Talks and keynotes | L12, L18, L19, L24, L27 | P12 (L19, L24); try-its link T0, T3, P5, P6 | 1 build | $0.07 to $2 | $2 to $5.20 | $0 | 3 h, plus watching |

**Why this order.** Batch 1 fixes what is wrong in public today. Batch 2 is the headline's defense and edge half, and needs only T0's file and P6 from batch 1. Batch 3 is the fine-tuning lessons on one tune and waits on Q2. Batch 4 holds the tutorials and the course that fit neither group; L14 (a talk) is here because it shares P11 with the course (L11). Batch 5 is the talks, each a watch guide plus one small try-it. L15 and L23 are talks but go in batch 3 because they are fine-tuning lessons that share T3.

**What shares what.**

| Shared | What it is | Lessons |
|---|---|---|
| T0 | The cold-room chain run: Muse Glimmer 30B (r30b) on 900 code-written rows, judged on the site, scored by drill-bench on 100 sealed rows, an IQ1_S file you keep (docs/CHAIN_RUN.md) | L17 and L21 (the owner's two), and its file for L22, L25, L28, L23, L18, L27 |
| T1 | Receipt reader: Muse Glimmer 30B (r30b) on receipt-bench's code-written rows, general checks on, scored by code on 40 sealed receipts, an IQ1_S file you keep | L1, L5, L20, L25 |
| T3 | Teacher to student: a hosted Meta model writes 300 examples for a made-up shop's support desk, Muse Glimmer 30B (r30b) learns them, blind judge, one loop round, an IQ1_S file you keep (needs Q2 yes) | L26, L9, L23, L15, L12, L19, L11 (part 7) |
| P5 | Fine-tune planner | L5, L15, L18 |
| P6 | Safety lab | L6, L16, L30, L19 (link) |
| P7 | Ask my files | L13, L29 |
| P11 | Muse model tour | L11, L14 |
| P12 | Two-model bench | L19, L24, L23 (link) |

Dropped from the audits, to save money and because a shared item already teaches it: the optional tunes for L7 (triage), L8 (podcast rewriter), L10 (prompt), L13 (code folder), L29 (grounded answers) and L6 (verdict tune); the companion apps for L9, L12 (talk chapters), L22 (Ollama chat page), L23 (three answers side by side), L27 (pottery chat) and L28 (dinner helper). Each card links the shared item instead and says so.

## 4. The lessons

Format for each: Meta's title and link; what Muse Muse will make; models; what is checked and how; expected cost (Mode A, then Mode B where it differs); what the card says after it runs; what it can't do and must say. Every muse is typed exactly as written, as the lesson's `rebuild.note` (U2), and built with the card's "Build its product" button or `rebuild-all` (section 5).

### Batch 1: the six we got wrong or partly wrong

#### L1. How to fine-tune Llama models for structured extraction of data from images

- **Meta:** https://dev.meta.ai/llama/resources/videos/llama-fine-tune-structured-image-extraction (Nov 4, 2025; recipe: llama-cookbook `getting-started/finetuning/vision`).
- **Verdict today:** wrong. Receipt Form Reader runs on Spark 1.3 with no tune, no baseline and no score.
- **Makes:** P1 and T1. The video's method: measure first, tune, measure again, check nothing broke.
  - P1 muse: "Read photos of receipts and give me the shop, date, subtotal, tax, total and how many items I bought as JSON, and when I upload a batch of photos with a file of the right answers, show how often each field comes out right and let me download every answer as one JSON line per photo."
  - T1 tune: base Muse Glimmer 30B (r30b), the default (no base is picked, `TUNE_ANY_BASE` off); data: receipt-bench `make` with U4's wider wordings, 300 training rows in three layouts, written by code; the site holds out about 30 for its judge, and the 40 sealed receipts in two other layouts never go to the site; recipe `glimmer-lora`, 150 steps (about two passes at 4 rows a step), rank 16, learning rate 0.0002, student prompt "full" (so the sealed scoring prompt is the one it trained on); GPU "1x A100 SXM4 (40 GB)" through the site (the measured $1.39 run's GPU), limits 120 minutes and $5; `TUNE_GENERAL_CHECKS` on. Then the IQ1_S file (and Q4_K_M if it passes) and the sealed scoring on a hand-launched A10. No free twin: the Kaggle notebook is retired.
- **Models:** Muse Wonder reads the photos (P1); r30b Glimmer base and tuned read receipt text (T1); the site judge is Contributor in Mode A, Wonder in Mode B.
- **Checked:** in code. P1: U4's 40 rendered photos and truth file, P1's download converted and scored with `receipt-bench.py score`, field by field; P1's own on-page score is checked against ours. T1: base against tuned on the 40 sealed receipts, both as IQ1_S under llama-server with a `json_schema` response format, scored by `receipt-bench.py score`; the site's blind judge on its ~30 held-out rows and the 20 general and 20 safety checks, as the video's "kept its other skills" step.
- **Cost:** build $0.02 to $1.80 ($2 to $5 in Mode B); 40-photo bench on Wonder about $1 to $2; T1 site GPU $1.39 to $1.86 (measured r30b runs; cap $5); A10 for the IQ1_S file and sealed scoring $1.75 to $2.60 (the Nov 1 tuned r30b quantize took 29 minutes of job and 1.36 hours of machine, about $1.75; 90-minute timer); judge about 70 items, cents (about $1.10 in Mode B, from $1.54 per 100 measured Nov 1).
- **Card after:** "Run <date>. Muse Wonder read 40 invented receipt photos: <x>% of fields right, scored by code. Muse Glimmer 30B on receipt text, one-bit files: base <a>%, tuned <b>% of fields right, all six right <c>% to <d>%, on 40 receipts in layouts it never trained on. Line count: <e>% to <f>%. General checks: tuned <won/tied/lost> against base on 20, safety on 20 (judge: <model>). Meta's numbers (base 58, LoRA 72, full 98) are theirs, on W-2 forms with a vision model." No link to the Nov 2 Llama 1B board tune: it is an earlier experiment, not part of the submitted project.
- **Must say:** Muse Muse can't fine-tune a vision model (r30b Glimmer is text only), so we tune the text half and Wonder reads the photo. All receipts are invented. Counting lines in code is a cheap fix that beats some tunes, and the card says that too. The old Receipt Form Reader stays hidden as the lesson's answer.

#### L2. How to build your own multi-modal WhatsApp chatbot with Llama 4

- **Meta:** https://dev.meta.ai/llama/resources/videos/build-multi-modal-whatsapp-chatbot-with-llama-4 (Nov 4, 2025; Nilesh Pandey; recipe `end-to-end-use-cases/whatsapp_llama_4_bot`).
- **Verdict today:** partly wrong (Spark 1.3, no webhook flow).
- **Makes:** P2. Muse: "Make a chat helper for a small shop that answers typed questions, photos and voice notes from the shop's own details, can read a voice-note answer back out loud, and includes a WhatsApp webhook simulator that sends sample Cloud API messages to its own webhook route and shows the reply it would send."
- **Models:** Muse Wonder (text and photos), Muse Voice Transcribe 1.0 (voice notes). Spoken replies use the browser's own voice (speechSynthesis), which is the browser's, not a model Muse Muse runs. The platform's in-page speech part (SpeechT5) is not a Meta model and is out under the ruling.
- **Checked:** in code: the simulator's three sample payloads (text, image with a media id, audio) each reach the right handler, and the reply payload has the Cloud API messages shape (a fixed list of keys). By a person: one typed question, one photo, one voice note, and a listen to the spoken reply. The build's own checks (typecheck, build, start, console, smoke, the screenshot judge).
- **Cost:** build $0.02 to $1.80 ($3 to $6 in Mode B, from this muse's earlier $3.11 and $5.01); try-its $0.10 to $0.30.
- **Card after:** "Run <date>. Built from one sentence. The simulator sent text, a photo and a voice note to the product's own webhook route; <n> of 3 reached the right handler and showed the reply it would send."
- **Must say:** no real WhatsApp is connected and nothing is sent; a live verify handshake needs the owner's Business account. Platform webhooks are POST-only and queue to a 5-minute cron, so the product owns its route. Voice notes need Wonder at run time (G6); spoken replies are the browser's own voice (G7).

#### L3. How to quickly generate technical blogs from your docs with Llama and RAG

- **Meta:** https://dev.meta.ai/llama/resources/videos/generate-technical-blogs-from-your-docs-with-Llama-and-RAG (Sep 24, 2025; recipe `end-to-end-use-cases/blog_generator`).
- **Verdict today:** partly wrong (no retrieval).
- **Makes:** P3. Muse: "Turn my docs into a technical blog post that finds the right sections first, cites them, flags anything the docs don't back up, and adds a header image."
- **Models:** Muse Wonder (pick, write, check), Muse Image (header). Sample docs: Muse Muse's own public README and three docs pages.
- **Checked:** in code: every section cites at least one chunk id that exists; count of flagged claims; tokens and cost of "retrieve" against "send all the docs", as the product shows them. Blind judge (U7): this post against the old Doc to Blog Drafts post on the same docs, and "retrieve" against "send all".
- **Cost:** build $0.02 to $1.80 ($3 to $6 in Mode B); two posts about $0.25 each on Wonder plus the judge, $0.30 to $0.80.
- **Card after:** "Run <date>. It split the docs into <n> chunks, searched them by keyword, cited <m> of them, and flagged <k> claims the docs didn't back up. Retrieval used <t1> tokens against <t2> for sending everything. A blind judge preferred <which>."
- **Must say:** the Model API has no embeddings model, so search is keyword (BM25) plus Wonder's pick, not the video's embedding search and reranker. The header image is our addition.

#### L4. Llama Best Practices: Unlock Rich Insights from Rich Documents

- **Meta:** https://dev.meta.ai/resources/videos/unlock-rich-insights-from-rich-documents (Sep 18, 2025; recipe `end-to-end-use-cases/structured_parser`).
- **Verdict today:** partly wrong (no check of its answers).
- **Makes:** P4. Muse: "Turn a PDF research paper into checked, structured data: read each page, pull text, tables and charts into JSON that matches a schema I can edit, keep the page number for every value, export CSV, Excel and SQLite, and show how many fields it gets right on a sample paper whose answers are known."
- **Models:** Muse Wonder (one call per page and artifact type), SAM 3.1 (figure crops). Wonder, not Spark 1.3 as the audit had, per the real-product rule.
- **Checked:** in code: U6(a)'s made-up paper, the product's JSON export scored field by field against its truth file, page numbers checked; the product's own score checked against ours.
- **Cost:** build $0.02 to $1.80 ($2 to $5 in Mode B, a guess); one 4-page paper on Wonder $0.30 to $1.
- **Card after:** "Run <date>. On a made-up 4-page paper with known values: <x> of <y> fields right, every value with its page."
- **Must say:** the sample paper is invented; SAM 3.1 under `BUILDS_ON_CONTRIBUTOR` is unverified; no vector index (no Muse embedding model). The orphaned report-insight-lens product can be unlinked by the owner.

#### L5. Llama Best Practices: Fine-Tuning Llama Models in the Real World

- **Meta:** https://dev.meta.ai/llama/resources/videos/fine-tuning-llama-models-in-the-real-world (Sep 18, 2025; Sanyam Bhutani; code: synthetic-data-kit).
- **Verdict today:** wrong (Few Shot Tune Check runs no tune).
- **Makes:** the lesson's order on real runs, sharing T1:
  - Data first: T1's code-written receipt rows, with the review of rows used and dropped.
  - Baseline first: P1's Wonder score and T1's base score on the same 40 receipts.
  - Smallest model first: explained, not done. r30b Glimmer is the one open Meta model Muse Muse tunes, so T1 is the tune, and the card says there was no smaller Meta model to try first.
  - Overfit on 100 first, the video's tip 03 (optional, not in the totals): a 100-row r30b job on the site from the same receipt rows, about three passes; the training loss should fall near zero. About $1.39 at the measured run's price, unmeasured at this size. The free Kaggle version is retired.
  - P5 muse (shared with L15 and L18): "Paste my task and a few labeled examples, score a quick few-shot baseline on them, then tell me whether to fix the prompt, make training data, or tune an open Muse Glimmer model I keep, and which parts of my product need a hosted model and which could run on open weights, with the time and cost of each step from these measured runs: a Muse Glimmer 30B tune took 42 to 48 minutes and about $1.39 of GPU on an A100, a blind check of 100 answers cost $1.54, and making its one-bit file took about $1.75 on an A10."
- **Models:** Muse Wonder (P5, P1); r30b Glimmer (T1 and the optional overfit job).
- **Checked:** in code: P5's baseline score on 20 of U6(b)'s labeled messages, recomputed by `learn-score.py`; the overfit job's loss curve from its event log, if it ran; T1 as in L1.
- **Cost:** P5 build $0.02 to $1.80 ($1.20 to $3 in Mode B); P5 try-it $0.10 to $0.30; the optional overfit job about $1.39, not in the totals; T1 is counted under L1.
- **Card after:** "Run <date>. Baseline first: Wonder <x>%, base Glimmer <a>%. Then the tune: tuned Glimmer <b>% on 40 sealed receipts. Overfit check: loss <l0> to <l1> on 100 rows in <s> steps (or: not run). The planner's baseline matched our recount on <k> of 20."
- **Must say:** chain-of-thought rationales (`cot-enhance`) and an LLM quality filter (`curate`) are not built; our curation is de-duplication and the secret and personal-data scan. The data is invented. There was no smaller Meta model to start with.

#### L6. How to implement Llama Protections to your GenAI applications

- **Meta:** https://dev.meta.ai/llama/resources/videos/implement-llama-protections-to-genAI-applications (Sep 10, 2025; cookbook `getting-started/responsible_ai`).
- **Verdict today:** partly wrong (one self-grading call in Shield Chat Guard).
- **Makes:** P6, shared with L16 and L30. Muse: "A safety lab for my chatbot that runs each message through separate layers, an injection check that also screens pasted pages and files for hidden instructions, a check of prompts and replies against a written list of hazard categories I can edit, and a review of any code in a reply, shows allow, needs review or block with the layer and reason, and has a test bench where I paste labeled prompts and see what each layer caught, missed and flagged by mistake."
- **Models:** Muse Wonder, each layer its own call with its own structured output.
- **Checked:** in code: U5's 45-item bench pasted in, the product's results exported and scored by `learn-score.py safety`: per layer, caught, missed, false flags on the 20 benign. First run at the default strictness here; the second strictness run is in batch 2.
- **Cost:** build $0.02 to $1.80 ($3 to $6 in Mode B); one bench run $0.50 to $1.50 on Wonder.
- **Card after:** "Run <date>. On 45 made-up labeled items: the injection layer caught <a> of 20 attacks, the hazard layer <b>, the code review <c> of 5 insecure replies; <f> of 20 harmless items were flagged by mistake."
- **Must say:** a general model stands in for Meta's dedicated classifiers. Llama Guard and Prompt Guard are linked as reading; under the hackathon's rules they aren't Meta models, so Muse Muse doesn't run or tune them. "Is built to flag", never "blocks". The bench is ours, not CyberSecEval. Shield Chat Guard stays as the simpler first version.

### Batch 2: defense and edge

#### L30. Open Approach to Trust & Safety: Llama Guard 3, Prompt Guard & More

- **Meta:** https://dev.meta.ai/resources/videos/open-approach-to-trust-and-safety (YouTube IvjLXGR7-vM, Aug 9, 2024, 27:08; listed Apr 10, 2025).
- **Makes:** a lesson page "Safety as a system: checks around the model" with the talk's chapters (03:37 system-level safety, 11:01 Llama Guard, 13:18 Prompt Guard, 17:04 CodeShield, 23:02 CyberSecEval) and one diagram, plus P6 (built in batch 1) at a second, stricter setting on the same 45 items.
- **Models:** Muse Wonder (P6).
- **Checked:** in code, the same scorer; the two strictness runs side by side (catches against false flags).
- **Cost:** $0.50 to $1.50 for the second bench run; the page is $0.
- **Card after:** "Run <date>. The same 45 items at two settings: default caught <a>, flagged <f> harmless; strict caught <a2>, flagged <f2>."
- **Must say:** the hazard list is modeled on Llama Guard 3's categories as published, not Meta's classifier; the code review is a review, not a security guarantee.

#### L16. New Protection tools for Llama developers

- **Meta:** https://dev.meta.ai/resources/videos/protection-tools (LlamaCon, Apr 29, 2025, 11:15; Lauren Deason).
- **Makes:** a page on Llama Guard 4, Prompt Guard 2, LlamaFirewall and CyberSecEval 4 (linked as reading, not rebuilt or run). Try-it: P6's Muse Wonder injection layer on 18 made-up attack lines (10 blunt, 8 subtle). The Nov 1 Prompt Guard 2 laptop numbers are an earlier experiment, not part of the submitted project, and aren't shown.
- **Checked:** in code, P6's export scored against the 18 lines' labels, plus false flags on U5's 20 benign items.
- **Cost:** $0.10 to $0.30.
- **Card after:** "Run <date>. On 18 made-up attack lines, the lab's Muse Wonder injection layer caught <a> of 10 blunt and <b> of 8 subtle ones, and flagged <f> of 20 harmless items by mistake."
- **Must say:** Muse Muse doesn't run Prompt Guard 2 or Llama Guard 4: under the hackathon's rules they aren't Meta models. Muse Wonder is the only layer. Prompt Guard 2 staged on jetson-05 stays not running. No fine-tune.

#### L21. Running Llama 3 on Linux

- **Meta:** https://dev.meta.ai/llama/resources/videos/running-llama-3-on-linux (YouTube XYoI6u0TMxI, 12:23, May 23, 2024; Navyata Bawa).
- **Makes:** "Run a tuned Glimmer file on Linux", answered by T0, the cold-room chain run. The card shows the tuned one-bit r30b Glimmer (IQ1_S) served by llama-server (`--jinja`) on Linux (the A10 in CHAIN_RUN step 6, and the Jetson board, which runs Linux, through Hussam's M10 and M11 if the edge gate passed), base against tuned on 100 sealed invented windows, plus the cold-room app's outage drill (M5, M12). Try-it for readers: the llama.cpp b11669 commands, run on the public base IQ1_S from `OfflineBase/Muse-Glimmer-30B-2026-Knowledge-GGUF` (T0's own file is a hand transfer, not published).
- **Checked:** in code by drill-bench, from the chain run's log.
- **Cost:** $0 beyond the chain run.
- **Card after:** "Run <chain run date>. Muse Glimmer 30B tuned on 900 invented rows, one-bit file, on a Linux box: all five right <b>% against base <a>% on 100 sealed windows, hard rule <v> violations; on a Jetson <t> tokens a second (or: not run on a board)."
- **Must say:** the video's Llama 3 8B is not what we ran; ours is a 6.53 GB one-bit Glimmer file, slow and weaker than the cloud. The cold room is simulated.

#### L22. Running Llama 3 on Mac

- **Meta:** https://dev.meta.ai/llama/resources/videos/running-llama-3-on-mac (YouTube aJ064KCr7OU, 7:24).
- **Makes:** "Run a tuned Glimmer file on your Mac": the video's four steps with T0's IQ1_S file: an Ollama Modelfile, `ollama create`, `ollama run`, the video's curl to `localhost:11434/api/chat` and the same call from Python, with the stock base IQ1_S side by side on 5 sealed drill prompts.
- **Checked:** drill-bench scores the 5 answers from each model; time per answer.
- **Cost:** $0 on a borrowed Mac; about $1 to $2 of AWS Mac time otherwise (unpriced). **Never on the owner's laptop:** Glimmer never runs there (CLAUDE.md). It needs an Apple silicon Mac with at least 16 GB that isn't the owner's (the AWS Mac or another), and the owner's OK, after the Windows box is done.
- **Card after:** "Run <date> on an Apple silicon Mac: the tuned file answered <n> of 5 right, stock <m> of 5, at <t> tokens a second."
- **Must say:** if no such Mac is used, "Not run on a Mac. The steps are Meta's and ours." The `muse-glimmer:30b-mlx` tag is from Meta's docs, not run by us.

#### L25. More ways to run Llama 3

- **Meta:** https://dev.meta.ai/llama/resources/videos/more-ways-to-run-llama-3 (YouTube dmXBFoYRPo4, 11:10).
- **Makes:** a tour, "Where your model can run", each stop labeled by how far it has run: the cloud (P1 on Wonder), your own computer (L21, L22, L28), a board, and hosted GPUs (Modal, Baseten, Fireworks, Lambda: built, not run on a real provider). The board stop's try-it is this batch's board job, only if the edge gate (H1) passed: Hussam serves T1's tuned IQ1_S on the gate's board and runs `receipt-bench.py ask --schema` (U4) on the 40 sealed receipts, next to the stock one-bit Glimmer's Nov 2 board number (0 of 40 valid JSON without a schema). The Nov 2 Bolt, LFM3-VL and Llama 1B board numbers are earlier experiments with non-Meta models, not part of the submitted project, and aren't shown.
- **Checked:** in code by `receipt-bench.py score`.
- **Cost:** $0.
- **Card after:** "Run <date>. The same 40 invented receipts on: Muse Wonder <x>%, tuned one-bit Glimmer on an A10 <b>%, tuned one-bit Glimmer on <board> <j>% at <t> tokens a second (or: the board stop didn't run)."
- **Must say:** hosted-GPU stops are built, not run. Board numbers are board numbers, over invented data. The receipt product has no offline fallback; the cold-room app is the edge example.

#### L28. Running Llama 3 on Windows

- **Meta:** https://dev.meta.ai/llama/resources/videos/running-llama-3-on-windows (YouTube a_HHryXoDjM, 10:28).
- **Makes:** "Run a tuned Glimmer file on a Windows PC": T0's IQ1_S file on the AWS Windows lab box (Windows Server 2022, CPU only). A t3.large has 8 GB, too little for a 6.53 GB file plus Windows, so use a 16 GB size (t3.xlarge, about twice the t3.large's $0.11 an hour; unpriced). First the PowerShell export script from `/models/{id}` if `EXPORT_TUNED` is on and it lists the file (it has never run on Windows); otherwise llama.cpp b11669's Windows build by hand. Base and tuned side by side on 5 sealed drill prompts.
- **Checked:** drill-bench scores the 10 answers; time per answer.
- **Cost:** about $0.50 to $1 of AWS time. Stop the instance by hand at the end.
- **Card after:** "Run <date> on a Windows Server box with no GPU: tuned <n> of 5 right, base <m> of 5, at <t> tokens a second. The PowerShell script <ran / wasn't offered>."
- **Must say:** a CPU-only server, not a gaming PC; no GPU speed is claimed, and a one-bit 30B on CPU is slow. The video's dinner prompt doesn't fit a cold-room model, so the card uses drill prompts and says why.

#### L13. Leidos boosts developer efficiency with Llama and Sourcegraph

- **Meta:** https://dev.meta.ai/llama/resources/videos/llama-and-sourcegraph (LlamaCon, Apr 29, 2025; Beyang Liu).
- **Makes:** a case-study page (Leidos ran Llama 3.1 70B behind LiteLLM on air-gapped AWS, with Sourcegraph's retrieval loop; results quoted as self-reported) and P7, shared with L29. Muse: "Drop in a folder of docs or code and ask questions about it: it searches the files first with a search tool, answers with the file and the page or line it used, says plainly when the files don't cover a question, and has a check page that runs my question list three ways, with no files, with all the files, and with search, and shows how often each is right and cites a real passage."
- **Models:** Muse Wonder.
- **Checked:** in code: U6(c)'s made-up repo and 12 of its questions (the code half), answers scored for the key fact and the cited file and line.
- **Cost:** build $0.02 to $1.80 ($2 to $5 in Mode B); the code half of the check $0.50 to $1.
- **Card after:** "Run <date>. On a made-up 12-file repo: search answered <a> of 12 right with the right file and line; no files <b>; all files <c>."
- **Must say:** hosted on Meta's API, so not air-gapped. The local half (the one-bit Muse Glimmer file answering from the same search) is built only in an edge build (O4, preview only) and hasn't run; it is slow and far weaker than the cloud.

#### L29. Llama Stack RAG walkthrough

- **Meta:** https://dev.meta.ai/llama/resources/videos/llama-stack-rag-walkthrough (Meta's page returns 404; YouTube FhEboUKsDD8, Dec 19, 2024, 3:09; card date Apr 1, 2025 from the listing).
- **Makes:** P7 (shared with L13). The docs half: U6(c)'s made-up product manual and its 12 questions, 4 of them not covered.
- **Checked:** in code: key fact and cited passage for the 8 covered; a plain "the docs don't cover it" on the 4 uncovered; the three setups compared.
- **Cost:** $0.50 to $1 for the docs half (P7's build is counted under L13).
- **Card after:** "Run <date>. On a made-up manual: search right and cited on <a> of 8, refused <r> of 4 it couldn't answer; all docs in context <c> of 8; no docs <d> of 8."
- **Must say:** keyword search, because the Meta API has no embeddings endpoint. Meta's page 404s, so the card links the YouTube video.

### Batch 3: fine-tuning on one shared tune

Batch 3 waits on Q2 (G4). If Q2 is no, T3 doesn't run: L26, L9, L23 and L15 link T0 and T1 (rows written by code), and each card says "the teacher-written step waits on a data-rights answer".

#### L26. Knowledge Distillation with Llama 3.1 405B

- **Meta:** https://dev.meta.ai/llama/resources/videos/knowledge-distillation-with-llama-3-1-405B (YouTube kxx6TfpAkEU, 29:18; Hamid and Suraj).
- **Makes:** T3, the teacher to student loop.
  - Dataset, on `/fine-tuning`'s New dataset card: title "Juniper Pantry's support desk"; 300 examples; task: "Answer customer emails for Juniper Pantry, a made-up neighborhood grocery, in two to five short sentences, friendly and plain, using only these invented store facts: open 8 AM to 8 PM every day, returns within 14 days with a receipt, delivery within 3 miles for orders over $30, no alcohol delivery, gift cards never expire; say you will pass anything else to a person." Confirm it is made up. The teacher is the platform's writer that day (Contributor in Mode A, Wonder in Mode B); log which.
  - Tune: base Muse Glimmer 30B (r30b), the default; about 270 training rows after the 10% hold-out; 140 steps (about two passes at 4 rows a step); rank 16; learning rate 0.0002; student prompt "short" (the distillation framing: the student sees only "You are Juniper Pantry's support desk"); `gpu_1x_a100_sxm4` through the site; limits 120 minutes and $5; general checks on.
  - Collapse round: one tuning-loop round (`TUNE_LOOP`), 1 round, 100 new examples from the judge's weak prompts, cap $5.
  - File: IQ1_S (and Q4_K_M if it passes) by `quant-harness.ts` on a hand-launched A10, kept private until Q2 allows publishing.
- **Models:** the teacher (Contributor or Wonder), r30b Glimmer (student), the judge (the same model as the writer that day).
- **Checked:** the site's blind judge on about 30 held-out prompts, plus the 20 general and 20 safety checks; the loop round judged on its sealed half. In code: the share of student answers that state a store fact wrongly (hours, 14 days, 3 miles, $30), by `learn-score.py facts`.
- **Cost:** data $0.10 to $0.30 in Mode A ($4.62 to $10.14 in Mode B); GPU $1.39 to $1.86; loop round data cents ($1.39 to $3.40 in Mode B) plus GPU $1.39 to $1.86; judges cents (about $2.20 in Mode B); A10 for the IQ1_S file $1.75 to $2.60.
- **Card after:** "Run <date>. <Teacher> wrote 300 examples; Muse Glimmer 30B learned them under a one-line role. Blind judge: tuned won <w> of <n> (<avg_t> against <avg_b>). Store facts wrong: base <x>%, tuned <y>%. One more round on its weak prompts moved the score <from> to <to>." The Nov 1 loop rounds (6.67, 6.67, 6.54) were on Llama through the harness, an earlier experiment, so the card doesn't cite them.
- **Must say:** the video distills from 405B; our teacher is a hosted Meta model and the student the open Glimmer 30B. A judge's score is not a benchmark. If the round didn't help, the card says so; that is the collapse chapter's point.

#### L9. How to create synthetic datasets for fine-tuning Llama

- **Meta:** https://dev.meta.ai/llama/resources/videos/synthetic-datasets-for-fine-tuning-llama (Jul 10, 2025, 2:51; Sanyam Bhutani; synthetic-data-kit).
- **Makes:** the kit's four steps on the platform. Ingest and create: drop U6(h)'s folder of 5 made-up how-to docs in the Make chat with menu "Dataset" (dataset only, no GPU); the review lists files used and skipped and why. Curate: the near-duplicate rule and the secret and personal-data scan. Save: download the rows. Train and prove, the two steps the video skips: T3.
- **Checked:** in code: rows written, rows dropped, held-out count, no held-out prompt in training (the review's numbers). T3's checks for the tune.
- **Cost:** the folder dataset, cents in Mode A (about $0.50 in Mode B); T3 is counted under L26.
- **Card after:** "Run <date>. 5 made-up docs became <n> rows (<d> near-duplicates dropped, <h> held out). The tune that proves it is <link to L26>: tuned won <w> of <n>."
- **Must say:** the kit's quality-score filter (`curate --threshold`) is not built. T3's rows came from a task description, not from this folder, and the card says so. Only made-up files belong on the Contributor tier, where Meta may train on inputs.

#### L17. Tailoring Llama for your needs: Fine-tuning & Evaluation

- **Meta:** https://dev.meta.ai/resources/videos/fine-tuning-and-evaluation (LlamaCon, Apr 29, 2025; Micheal Slater, as spelled on Meta's page).
- **Makes:** answered by T0, the chain run: your rows (900 written by code), a held-out split, a QLoRA of Muse Glimmer 30B (r30b) on a rented GPU through the site, a blind judge against the base, a sealed check by code, a file you keep. The card is written from the chain run's log in this batch.
- **Checked:** the site's judge and drill-bench, from the log.
- **Cost:** $0 beyond the chain run.
- **Card after:** "Run <chain run date>. Judge: tuned won <w> of <n> held-out rows. Code: all five right <b>% against <a>% on 100 sealed windows. A 6.53 GB one-bit file you keep." For "without losing what it knew", link T1's and T3's general checks.
- **Must say:** the video tunes Llama 3.3 8B; Muse Muse tunes no Llama, only Meta's Muse Glimmer. T0 ran without the general checks.

#### L20. Finetune Llama 4 faster with Unsloth

- **Meta:** https://dev.meta.ai/resources/videos/fine-tune-with-unsloth (LlamaCon, 2:45; Daniel Han-Chen).
- **Makes:** "the same Unsloth QLoRA, measured": the recipe is Unsloth (FastLanguageModel, answers only, adamw_8bit, gradient checkpointing). The card reads peak GPU memory, seconds a step and cost from T1's and T3's job events, beside the Nov 1 r30b run on an H100 (22.44 GB peak, 971 s of training for 120 steps, with other jobs sharing the GPU) and a panel of Unsloth's own claims labeled as theirs.
- **Checked:** numbers from the job events, by code.
- **Cost:** $0.
- **Card after:** "Measured <dates>: Muse Glimmer 30B QLoRA on an A100 SXM4, <g> GB peak, <s> s a step, $<c> for <n> steps."
- **Must say:** no plain transformers and PEFT baseline was run, so we measured no speedup. Muse Muse tunes no Llama, so Unsloth's Llama 4 claims stay theirs.

#### L23. Break Free from Closed Models: Unlock the Power of Open Source Now

- **Meta:** https://dev.meta.ai/resources/videos/break-free-from-closed-models-unlock-the-power-of-open-source-now (YouTube U8onau0gkf0, 26:19; Amit Sangani).
- **Makes:** a watch guide plus the talk's Scribd pattern done for real, by linking T3 (a hosted model writes the data, a small open model learns it) and T0's file (no lock-in: the file is yours). Try-it: P12 (batch 5) puts the cloud model next to the tuned file's sealed answers.
- **Checked:** T3's and T0's checks.
- **Cost:** $0 extra.
- **Card after:** "A hosted model taught an open Glimmer we keep: <T3 line>. The file: T0's one-bit IQ1_S, 6.53 GB."
- **Must say:** the talk's case-study numbers are theirs; a 1,000-example Wonder dataset was never measured.

#### L15. The Llama toolbox: a collection of practical tools and recipes

- **Meta:** https://dev.meta.ai/llama/resources/videos/llama-toolbox (LlamaCon, 21:26; Hamid Shojanazeri).
- **Makes:** the toolbox's chain as real platform steps: prompt first (P5, built in batch 1), synthetic data, fine-tune, evaluate, ship and keep (T3 and its file).
- **Checked:** P5's baseline check and T3's.
- **Cost:** $0 extra.
- **Card after:** "Prompt first: <P5 result>. Then data, tune and a blind check: <T3 line>. A file you keep."
- **Must say:** the recipe chain is our reading of the talk until someone watches it (U8).

### Batch 4: the other tutorials and the course

#### L7. How to automatically analyze and triage issues on GitHub repos with Llama

- **Meta:** https://dev.meta.ai/llama/resources/videos/auto-analyze-triage-github-issues-with-llama (Sep 3, 2025; YouTube VMMFSTGnlmU, 4:44).
- **Makes:** P8. Muse: "Load a GitHub repo's issues from a pasted or uploaded export, or from my own read-only token, and give me a triage board that shows each issue's type, severity, component, likely causes and two suggested fixes, groups them by theme, flags likely duplicates, and writes a one-page summary for maintainers with open questions and the issue numbers behind every claim."
- **Models:** Muse Wonder, three passes, each with a strict schema.
- **Checked:** in code: U6(d)'s 40 made-up issues: type and severity against their labels, every cited issue number exists, how many of the 5 planted duplicate pairs it found.
- **Cost:** build $0.02 to $1.80 ($2 to $4 in Mode B); 40 issues on Wonder $1 to $2.
- **Card after:** "Run <date>. On 40 made-up issues: type right <a>%, severity <b>%, <d> of 5 duplicates found, 0 unknown issue numbers cited."
- **Must say:** read-only: labels are suggested, never posted. The token path is optional and not used in the run. The edge tune is dropped.

#### L8. How to use Llama to convert PDFs into a podcast with NotebookLlama

- **Meta:** https://dev.meta.ai/llama/resources/videos/convert-pdfs-to-podcast-with-notebookllama (Jul 16, 2025; Sanyam Bhutani).
- **Makes:** P9. Muse: "Turn any PDF into a short two-host podcast: read the whole PDF, write a lively conversation that explains it with page references, and play it aloud with a transcript you can read along with."
- **Models:** Muse Wonder (reads the PDF through the files API). Read aloud with the browser's own voice only; the platform's in-page speech model (SpeechT5) is not a Meta model and is out.
- **Checked:** in code: on U6(g)'s made-up 6-page PDF, every turn has a page from 1 to 6, the speakers alternate, no spoken piece over 600 characters. Blind judge (U7): the script against a plain one-pass summary of the same PDF, for "explains it". A person listens for 2 minutes.
- **Cost:** build $0.02 to $1.80 ($0.30 to $1.80 in Mode B, the README's local batch); one PDF $0.10 to $0.50.
- **Card after:** "Run <date>. A 6-page made-up PDF became a <m>-minute two-host script, <t> turns, every one with a page; a blind judge preferred <which>."
- **Must say:** Meta's API has no text-to-speech; the voice is the browser's own; downloading the audio isn't proven. The rewriter tune is dropped.

#### L10. How to optimize your prompt for Llama

- **Meta:** https://dev.meta.ai/llama/resources/videos/optimize-llama-prompts (Jun 26, 2025; Justin Lee; github.com/meta-llama/prompt-ops).
- **Makes:** P10. Muse: "Paste a prompt written for another model and about 50 labeled examples, and get a rewritten prompt for a Muse model with its score before and after on examples it never saw."
- **Models:** Muse Wonder proposes rewrites; the prompt under test runs on Contributor (test calls) or Wonder.
- **Checked:** in code: U6(b)'s 50 labeled messages, the product's search and sealed scores recomputed by `learn-score.py` with exact field matches.
- **Cost:** build $0.02 to $1.80 ($0.30 to $1.80 in Mode B); one optimization $0.25 to $0.60.
- **Card after:** "Run <date>. On 15 sealed made-up messages: original prompt <a>%, rewritten <b>%, exact field match, scored by code."
- **Must say:** the video shows the old llama-prompt-ops name. The tune comparison is dropped; L5 and L26 show tuning.

#### L11. Building with Llama 4

- **Meta:** https://dev.meta.ai/llama/resources/videos/building-with-llama-4 (Jun 20, 2025; the DeepLearning.AI course, Amit Sangani).
- **Makes:** the course's seven topics on Muse Muse: MoE on the Models page, the quickstart, image grounding, prompt format, long context, prompt optimization (link L10), synthetic data and a real tune (link T3). P11, shared with L14. Muse: "Make a page where I paste a long code repo and get a getting-started guide, drop in a few photos to hear where they were taken and see the booking request a model would send for that place, and upload shelf photos to box and count each product with answers about a parts catalog I paste in."
- **Models:** Muse Wonder, SAM 3.1.
- **Checked:** in code: the token count and cost shown before the long-context step; the tool-call JSON validates against the function's schema; shelf counts on U6(e)'s 3 code-drawn images against their known counts.
- **Cost:** build $0.02 to $1.80 ($2 to $5 in Mode B); runs $0.30 to $1.20 (keep the repo under 50k tokens; a 200k-token repo is about $1 on Wonder).
- **Card after:** "Run <date>. Shelf counts right on <n> of 3 drawn images; the booking call matched its schema; a <k>k-token repo became a guide for $<c>."
- **Must say:** the course's gated lesson contents weren't read. SAM 3.1 counting real shelves is unproven; the images are drawn by code.

#### L14. Unpack the latest Llama 4 herd

- **Meta:** https://dev.meta.ai/llama/resources/videos/llama-4-herd (LlamaCon, Apr 29, 2025; Rangaprabhu Parthasarathy).
- **Makes:** "Meet the Muse models: long context, many images, tool calls", on P11 (shared with L11), plus a short read: Llama 4 Scout and Maverick were open-weight MoE models; Meta's current models are Muse Wonder and Spark 1.3 (hosted, 1,048,576-token context) and the open Muse Glimmer 30B.
- **Checked:** P11's checks.
- **Cost:** $0 extra.
- **Card after:** a link to P11's result, with the lesson's own three steps named.
- **Must say:** what the talk says, until someone watches it (U8). Several images and tool calls on Muse models were untested before P11's run.

### Batch 5: talks and keynotes

Each talk card gets a watch guide from U8 (a person watches and fills 3 to 5 timestamps; until then, "not watched yet") and one small try-it.

#### L12. A conversation with Mark Zuckerberg and Satya Nadella

- **Meta:** https://dev.meta.ai/resources/videos/mark-zuckerberg-and-satya-nadella (LlamaCon, Apr 29, 2025; YouTube WaJOONFllLc, 31:50).
- **Makes:** a watch guide; try-it: "Big model to small model", T3's result page.
- **Cost:** $0.
- **Card after:** watch guide, then "Try it: <T3 line>".
- **Must say:** nothing is attributed to the speakers beyond what was watched or the named press source. If Q2 is no, the try-it is T0 (rows written by code), labeled "not distillation".

#### L18. A conversation with Mark Zuckerberg and Ali Ghodsi

- **Meta:** https://dev.meta.ai/resources/videos/mark-zuckerberg-and-ali-ghodsi (LlamaCon, Apr 29, 2025).
- **Makes:** a watch guide on the two topics Meta lists; try-its: "own an open model" (T0's file) and "advice for founders" (P5's hosted-or-open-weights part).
- **Cost:** $0.
- **Must say:** P5 is inspired by the topic, never quotes either speaker. Meta's page may show a placeholder instead of a player.

#### L19. LlamaCon 2025 Keynote

- **Meta:** https://dev.meta.ai/llama/resources/videos/llamacon-2025-keynote (Apr 29, 2025; Chris Cox, Manohar Paluri, Angela Fan).
- **Makes:** "then and now" (the Llama API preview then, the Model API now), and P12, shared with L24. Muse: "A one-page bench that sends the same text to Muse Wonder and Muse Spark 1.3 Contributor, shows both answers side by side with how long each took, and counts the tokens of the same text in English, Spanish and code on each model, with tokens per word and how much of each context window it fills." Links: fine-tune and evaluate (T3, or T0), protections (P6), where it runs (the cold-room edge act).
- **Models:** Muse Wonder and Contributor.
- **Checked:** in code: the same text counted twice gives the same count; counts for U6(f)'s 3 texts against the docs proxy's count; times shown for both models.
- **Cost:** build $0.02 to $1.80 ($2 to $5 in Mode B); runs $0.05 to $0.20.
- **Card after:** "Run <date>. The same question to two Muse models: <t1> s and <t2> s; token counts for 3 texts on each."
- **Must say:** Cerebras and Groq inference and Llama Stack are out of scope. Mark which parts of the keynote were confirmed by watching.

#### L24. Understanding the Llama 3 Tokenizer

- **Meta:** https://dev.meta.ai/llama/resources/videos/understanding-the-llama-3-tokenizer (YouTube Tmdk_H2WDj4, 24:50; Aston Zhang).
- **Makes:** a concept page ("Tokenizers, Llama 3 to Muse": SentencePiece 32K to a BPE of about 128K, Muse Glimmer's 202,048 tokens, our lab's real tokenizer failures and fixes) and P12's token counter.
- **Checked:** P12's checks.
- **Cost:** $0 extra.
- **Card after:** "Run <date>. 3,000 characters of English: <n> tokens on Wonder, <m> on Contributor."
- **Must say:** the 32K and 128,256 figures are from Meta's model cards, not rechecked. Whether a product may call `input_tokens`, and whether it costs anything, is unverified until P12 runs. Hosted models don't show token boundaries.

#### L27. AI and The Next Computing Platforms With Jensen Huang and Mark Zuckerberg

- **Meta:** https://dev.meta.ai/resources/videos/ai-and-the-next-computing-platforms-with-jensen-huang-and-mark-zuckerberg (SIGGRAPH, Jul 29, 2024; YouTube w-cmMcMZoZ4, 58:37).
- **Makes:** a watch guide with three try-its, all already run by then: open models you own (T0's file), next computing platforms (the cold-room app's edge act, or its no-model fallback if the edge gate failed), vision (the live Object Count Studio first demo on SAM 3.1).
- **Cost:** $0.
- **Must say:** no real person's likeness in any build; nothing attributed beyond the YouTube description until watched. The pottery-studio build is dropped.

## 5. How to run it

### Before every batch (10 minutes)

1. Gates G0 to G2 hold, and the batch's own gates (G3 to G8).
2. `scripts/dev/judge-watch.sh` passes (about $0.0001).
3. `/usage`: today's spend plus the batch's Mode ceiling (section 3) stays under `DAILY_SPEND_CAP_USD` with at least $30 left for visitors. The cap is per UTC day; a batch that crosses midnight UTC counts on two days. Remember 0 means $100, not a pause (docs/JUDGING_WEEK.md).
4. Lambda console: no instance running, none named `mm-train-*`. `/fine-tuning`: no job running (`TRAIN_MAX_ACTIVE` is 1).
5. The live Make page's model label says which Mode is on; use that Mode's numbers.
6. Leave the training ceilings at their defaults: `TRAIN_JOB_MAX_USD` $5, `TRAIN_JOB_MAX_MINUTES` 120, `TRAIN_DAILY_USD` $20, `TRAIN_MAX_ACTIVE` 1. Set each job's own limits on the form as written below.
7. Open the batch's docs/BUILD_LOG.md entry with "started" and the time (section 6).

**Stop rules, every batch:** stop starting new work when the batch's Meta ceiling or GPU ceiling is reached; one retry per build or job, only after a fix you understand; a product that hits its token's daily budget finishes its bench the next UTC day (don't raise budgets); a refusal is logged, not worked around.

**Hand-launched A10 rules** (no platform cap applies): `gpu_1x_a10`, image `lambda-stack-24-04`, named `learn-quant-<n>`, never `mm-train-*` (the sweep ends those). Set a 60-minute timer at launch. Copy the file and answers off, check the sha256, terminate from the Lambda console, and confirm the instance list is empty.

**Builds:** two at a time. Either the lesson card's "Build its product" on `/learn` as an admin (it asks first, with the estimate), or from the worktree, at the deployed main, with the key loaded by the script and never opened by hand:

```
PLATFORM_URL=https://muse-muse.vercel.app npm run rebuild-all -- <id> <id>
```

Build only the owning lesson of a shared product (the U2 cards say "Shares <lesson>'s product"). Watch each build room; never press "Tune a model on this" in a run room (it trains r30b, docs/CHAIN_RUN.md).

### Batch 1 (the six)

Ceilings: Meta $17 (Mode A) or $38 (Mode B, on a day with nothing else); GPU $5 for T1 plus $1.94 for a 90-minute A10.

1. **6:00 PM. T1's data, on the laptop, $0.**
   ```
   python3 -I scripts/dev/receipt-bench.py make --out eval/receipts
   shasum -a 256 eval/receipts/heldout.jsonl
   npx tsx --test --experimental-test-module-mocks scripts/dev/receipt-bench.test.ts
   ```
   The held-out hash must match the one U4 pinned. Make `train.json` and `dev.json` for the A10 bundle as CHAIN_RUN section 6 does.
2. **6:05. T1 on the site (heavy 1).** Make chat, menu "Dataset", sentence "Read invented receipt text and answer with the six fields as JSON", drop `eval/receipts/folder/`, confirm; the review should say 300 rows, 0 dropped. Start (dataset only, no GPU). Then `/fine-tuning?dataset=<id>#new-job`: recipe `glimmer-lora`; base: the default r30b (no picker shows with `TUNE_ANY_BASE` off; log the commit the job shows); steps 150; rank 16; learning rate 0.0002; student prompt "full"; GPU "1x A100 SXM4 (40 GB)" by hand if the form offers a choice (unverified for r30b); limits 120 minutes, $5. Start. If `sweep_not_running`, wait 5 minutes.
3. **6:10. Builds P1 and P2 (heavy 2 and 3):** `-- structured-image-extraction whatsapp-multimodal-chatbot`.
4. **6:40. P3 and P4:** `-- docs-to-blog-rag rich-documents`. **7:10. P5 and P6:** `-- fine-tuning-real-world llama-protections`.
5. **About 7:30. T1 judged.** Read the job's public result page for the judge's summary and the general and safety lines.
6. **7:40. A10 (replaces the site GPU).** The adapter from the job page, then on the laptop:
   ```
   npx tsx scripts/dev/quant-harness.ts <out> '{"adapterJobId":"<job id>","levels":"IQ1_S,Q4_K_M","slug":"receipt-reader","trainChannel":<the job's own>,"publish":0}' "<the dataset's title>" <train.json> <dev.json> 90 /opt/muse-cache
   ```
   Launch `learn-quant-1`, run the bundle as CHAIN_RUN step 5 does, then on the A10:
   ```
   llama-server -m <tuned IQ1_S file> --port 8080 --jinja --reasoning-format none
   python3 receipt-bench.py ask --heldout heldout.jsonl --url http://127.0.0.1:8080/v1 --model tuned --schema --out tuned.jsonl
   ```
   (Glimmer under llama-server also needs the reasoning-off chat template jetson-02 uses, docs/HANDOFF.md, fleet changes; `--schema` is U4's) and the same with the public base IQ1_S from `OfflineBase/Muse-Glimmer-30B-2026-Knowledge-GGUF` (sha256 checked) as `--model base --out base.jsonl`. Copy the file and both answer files off, terminate. On the laptop: `python3 -I scripts/dev/receipt-bench.py score --heldout eval/receipts/heldout.jsonl --answers <file>` for each.
7. **8:30. U3 for batch 1's six slugs** (Mode A): open the PR; the owner merges; wait for the deploy. Mode B skips this.
8. **8:45. Benches (light, product calls):** P1: `python3 -I scripts/dev/receipt-bench.py photos --heldout eval/receipts/heldout.jsonl --out eval/receipts/photos`, upload the 40 photos and `truth.json` in P1, download the answers, convert (U4) and score. P3: two posts and `npx tsx scripts/dev/learn-judge.ts` on the pair. P4: upload U6(a), export, `python3 -I scripts/dev/learn-score.py paper ...`. P5: 20 of U6(b), `learn-score.py baseline ...`. P6: paste U5, export, `learn-score.py safety ...`. P2: the three simulator messages and the three try-its.
9. **9:00. Optional overfit job (heavy, only if the owner adds its $1.39):** a 100-row dataset from the same receipt rows, then an r30b job on the site with three passes' worth of steps, limits 60 minutes and $3. Read the loss curve from its event log.
10. **10:00.** Log (section 6). If T1 failed on the site twice, there is no free standby: the card says the tune didn't run.

### Batch 2 (defense and edge)

Ceilings: Meta $6 (Mode A) or $9 (Mode B); AWS $1; GPU $0.

1. **6:00. P7 build (heavy 1):** `-- leidos-sourcegraph-code-assistant`.
2. **6:00. Windows (heavy 2):** start the AWS Windows lab box at a 16 GB size, set a 4-hour stop reminder. Copy T0's IQ1_S over and pull the public base IQ1_S, check both sha256. Try the PowerShell script from `/models/{id}` with `-CheckOnly` first, then `-Prompt`; if it isn't offered, llama.cpp b11669's Windows release by hand. Ask 5 sealed drill prompts to each with drill-bench's system line, save answers, score with `drill-bench.py score` on the laptop. Stop the instance.
3. **6:30. Board (heavy 3, Hussam, only if the edge gate passed):** T1's tuned IQ1_S to the gate's board by `gguf-serve.sh --model-url` with its sha256 (a 6.53 GB file; jetson-02 has about 400 MB of disk free beside its 5.75 GB stock file, so Hussam decides what moves), then `receipt-bench.py ask --schema` (U4) on the 40 sealed receipts through the fleet, `--board <name>`. Hussam reports tokens a second and memory; if the board freezes once, stop.
4. **7:00. P6's strict run** (L30) and **the 18 attack lines** (L16): paste, export, score.
5. **7:30. U3 for P7** (Mode A), then **P7's check:** U6(c)'s 24 questions three ways, export, `learn-score.py files ...`.
6. **8:30. L22, only with the owner's OK, after the Windows box is stopped, and never on the owner's laptop:** on a 16 GB or larger Apple silicon Mac that isn't the owner's, a Modelfile for T0's IQ1_S, `ollama create`, `ollama run`, the video's curl and Python calls, and the stock base IQ1_S side by side on the same 5 prompts. Unload both models when done.
7. **9:30.** Write the L21, L25 and L28 cards from the logs. Log.

### Batch 3 (fine-tuning on one tune)

Gate: Q2 yes (G4), `TUNE_LOOP` and `TUNE_GENERAL_CHECKS` on (G5). Ceilings: Meta $1 (Mode A) or $16 (Mode B); GPU $10 for the two site jobs plus $1.94 for a 90-minute A10, inside the $20 a day training cap.

1. **6:00. T3's data.** `/fine-tuning`, New dataset card: title, task and count from L26; confirm it is made up. About 5 minutes on Contributor, about 30 on Wonder (the card's estimate).
2. **6:00. L9's folder (light):** Make chat, menu "Dataset", the sentence "Answer questions about Juniper Pantry from its how-to docs", drop U6(h)'s folder, confirm; record the review's numbers. Don't start a tune from it.
3. **6:35. T3 on the site (heavy 1):** the New job card with T3's settings (L26). Start.
4. **About 7:45. Judged.** Read the summary. Then the loop: on the run, set 1 round, 100 new examples, cap $5, and start it. The round writes, merges and launches with the same settings.
5. **About 9:15. Round judged.** Then the A10 for T3's file (as batch 1 step 6, slug `juniper-support`), kept private. Copy off, terminate.
6. **On the laptop:** `learn-score.py facts` on the base and tuned answers from the job's eval items.
7. **10:15.** Write the L26, L9, L17, L20, L23 and L15 cards. Log, including the docs/KNOWLEDGE_RUN_LOG.md lines.

### Batch 4 (tutorials and the course)

Ceilings: Meta $12 (Mode A) or $17 (Mode B); GPU $0.

1. **6:00. P8 and P9:** `-- github-issue-triage notebookllama-pdf-podcast`. **6:35. P10 and P11:** `-- optimize-llama-prompts building-with-llama-4`.
2. **7:15. U3 for the four slugs** (Mode A).
3. **7:45. Benches:** P8 on U6(d), `learn-score.py triage`; P9 on U6(g), `learn-score.py podcast` and `learn-judge.ts`, then a 2-minute listen; P10 on U6(b), `learn-score.py prompt`; P11 on U6(e) and a repo under 50k tokens, `learn-score.py shelf` and the schema check.
4. **9:30.** Log.

### Batch 5 (talks and keynotes)

Ceilings: Meta $2 (Mode A) or $6 (Mode B); GPU $0.

1. **6:00. P12:** `-- llamacon-2025-keynote`; U3 for its slug (Mode A); then U6(f)'s 3 texts and two questions.
2. **6:00 to 9:00. Watching (a person):** L12 (31:50), L27 (58:37), L24 (24:50), the keynote and the Ghodsi talk, and any talk from earlier batches not watched yet. Fill U8's timestamps and 3 to 5 key ideas each; anything not watched stays "not watched yet".
3. **9:00.** Write the five cards. Log.

## 6. Logging each run, and moving a card from planned to run

For every batch, in this order, in the batch's branch:

1. **docs/BUILD_LOG.md**, one entry per batch, written as it happens: `## <date>: Learn batch <n>, <name> (branch <branch>)`, with
   - what started and when, each build id and product slug, each training job id and dataset id, the A10 instance name and its start and end;
   - every number, labeled by where it came from ("scored by code on 40 sealed invented receipts", "site judge, <model>, <n> items", "board number, <board>", "Test model" for anything on Contributor);
   - every refusal, retry, failure and its last log line;
   - spend: Meta from `/usage` for the batch window, GPU from each job page and the A10 at $1.29 an hour, and AWS from the console;
   - what may now be said, checked against docs/MESSAGING.md.
2. **docs/KNOWLEDGE_RUN_LOG.md:** one line per training, dataset or quantize action (T1, T3, the loop round, each GGUF, the optional overfit job), per the repo rule.
3. **Screenshots** in `docs/log/shots/<date>/`: each result page, bench table and card, with no IP, key, console or board address in frame.
4. **The card,** for each lesson the batch ran, in `catalog/meta-resources.json` (after U1):
   - `learn.status` from `"planned"` to `"run"` only when its check ran and the log entry exists; `"dropped"` with a reason when a step can't run (for example T3 if Q2 is no);
   - `learn.result`: `{ "date": "<YYYY-MM-DD>", "summary": "<the card line from section 4, filled in>", "spendUsd": <n>, "log": "docs/BUILD_LOG.md#<anchor>" }`;
   - the lesson's `current.product` to the new product, and its verdict line updated by a person who checked the product against the lesson;
   - a result that didn't beat its baseline is still a run: show both numbers and say so.
5. **Tests** for the touched files only: `npx tsx --experimental-test-module-mocks --test components/learn/__tests__/learn.test.tsx` and any scorer's test.
6. **docs/HANDOFF.md** when a fact in it changes (open PRs, flags turned on, files published). **docs/EDGE_PLAN.md** if a board or file unit changed status. **docs/STORY.md** marks only from the log entry.
7. **A PR** for the batch's log, cards and U3 slugs; the owner or Hussam merges; the cards change on `/learn` after the deploy. Check signed out that each moved card shows "Run" with its result and no em dash.
8. **After the last batch:** the `/learn` header counts 30 lessons run or dropped, and `docs/SUBMISSION.md` and the page copy change only from the log, after the owner reads them.
