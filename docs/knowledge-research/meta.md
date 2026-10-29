# Meta, every channel

Research agent report, checked Oct 29, 2026 with web search and direct fetches (Exa wasn't available to it; its search budget ran out partway). The full dated list of all 169 Newsroom posts since January 4 is in `meta-newsroom-2026.tsv` beside this file. Not yet rechecked by hand, except the Model API terms below.

## Terms that change the plan

Meta's Model API Terms (dev.meta.ai/legal/terms-of-service, last updated Oct 9, 2026), checked directly: section 10.1(ix) bars using the services or Outputs "to train, fine-tune, distill, or otherwise improve or create" a model that competes with Meta's models or services without Meta's written authorization, and bars systematically collecting Outputs "to build training datasets for use in developing competing models". Evaluation and benchmarking of your own systems is carved out. The terms don't mention Muse Glimmer or say whether fine-tuning Meta's own open models on Outputs is allowed.

So:
- No part of the any-model knowledge dataset may be written by Muse Wonder or Spark through the Model API.
- Spark Open on Fireworks or our own GPUs is governed by the Muse Model License instead, which is gated on Hugging Face and unread. The owner accepts it and we read it before the synthetic phase.
- The fine-tuning lab (Wonder or Spark writing datasets that tune Glimmer, published to Hugging Face) is a gray area under these terms: a legal read before its next run.

## Channels

| Channel | 2026 items | How to list every item | Terms | Verdict |
|---|---|---|---|---|
| Meta Newsroom (about.fb.com) | 169 posts since Jan 4 (WordPress API X-WP-Total) | `/wp-json/wp/v2/posts?after=2026-01-04` (date, title, full HTML); sitemaps, news sitemap, RSS, llms.txt with .md for 70 posts | robots allows all; Meta copyright | Main primary source; text training-only |
| about.meta.com | HTTP 400 to curl | | Meta Terms | Skip |
| ai.meta.com blog and research | Spark 1.1 (Jul 9), Muse Image and Muse Video (Jul 7) visible | Sitemap and curl 403; JavaScript listing | robots: automated collection prohibited without written permission | Known posts one by one, facts only |
| dev.meta.ai (docs, blog, pricing, changelog) | 8 dated blog posts, pricing page, Muse Code changelog 1.1.1 to 1.4.13 | sitemap.xml (412 URLs, no lastmod); changelog undated | Same notice; Model API Terms | Facts plus training-only text |
| engineering.fb.com | 61 posts, latest Oct 29 | WordPress API, sitemaps, feed (also Meta Tech Podcast) | robots allows all | Ingest all |
| developers.facebook.com changelogs | Graph API v25.0 Feb 18, v26.0 Jul 29; Marketing API auto-upgrade Jul 29 | Version tables, no RSS | Automated-collection notice | A few pages by hand |
| meta.com/blog and developers.meta.com VR blog | RSS works (latest 10) | 243-page HTML listing; sitemaps 403 | Automated-collection notice | Gentle crawl, facts plus training-only |
| investor.atmeta.com | RSS back to May 28, release and transcript PDFs | RSS; PDFs on q4cdn | Crawl-delay 10 | Earnings numbers; Q3 transcript 404 |
| SEC EDGAR | 38 non-Form-4 filings in 2026 | Submissions JSON (User-Agent email) | Public domain | Best for legal facts, 8-Ks, financing; publishable |
| Transparency Center | No 2026 dates visible | Sitemap | robots blocks AI bots | Leave out; numbers from press or EDGAR |
| Oversight Board | 54 news posts; 166 decisions modified since Jan 4 | WordPress API, sitemaps, feed | Non-commercial only, no scraping without consent | Facts only, or ask |
| GitHub orgs | meta-models: meta-model-cookbook (Jul 7), meta-oss-cookbook (Aug 10), muse-code-sdk (Aug 28), meta-sam (Sep 18), legal-agent-workshop (Oct 27); facebookresearch 100+; facebookincubator 11 (muse-gadget-sdk Oct 2) | `/orgs/{org}/repos?sort=created` | Per repo | Per license |
| Hugging Face | meta-models: Glimmer x4 (Aug 9-10, Apache 2.0), Spark Open x2 (created Sep 15, gated, Muse Model License); facebook: 67 incl. sam3.1 (Mar 26), sapiens2 (Apr 23) | `/api/models?author=X&sort=createdAt` | Per card; gated cards unreadable | Cards are must-have |
| PyTorch blog | PyTorch 2.15 (Oct 28); 146 posts modified since Jan 4 | feed, post sitemap | robots `Content-Signal: ai-train=yes` | Ingest |
| Connect 2026 | Keynote plus 16 sessions | Agenda page | Videos on Meta sites and YouTube | Use Newsroom recaps |
| YouTube, podcasts | Not checked | | YouTube terms forbid this use | Leave out |
| Press | Lots | GDELT, CC-NEWS | Copyrighted | Facts only; many AI-written aggregators with wrong dates (one says "Spark 2.1"): require two independent sources |

## Dated checklist (key items)

Muse models, API and apps:
- 03-26 SAM 3.1 weights on Hugging Face
- 04-08 Muse Spark, MSL's first model, closed weights (NR 04/introducing-muse-spark-meta-superintelligence-labs)
- 05-12 Spark in WhatsApp, Instagram, Facebook, Messenger, glasses
- 05-13 Incognito Chat with Meta AI
- 07-07 Muse Image in Meta AI; Muse Video previewed, not shipped
- 07-08/09 Spark 1.1 and Model API preview: $1.25/$4.25, $20 credits, US only
- 07-24 Meta AI agentic tasks
- 08-05 Spark 1.2 and Muse Code beta; contributor tier $0.10/$0.20
- 08-09/10 Muse Glimmer 30B, Apache 2.0
- 08-25 Muse Image on the API, $0.01 an image
- 08-31 Muse Code out of beta: four plans, SDK preview, workflows
- 09-02 Spark 1.3, price unchanged; Max mode 09-04 (secondary sources only)
- 09-03 Muse Voice Transcribe, $0.18 an hour
- 09-08 Muse personal agent (US); Canada 09-18; Singapore 10-27
- 09-15 Meta One subscriptions ($2.99 to $19.99)
- 09-29 Muse for Small Business
- 10-09 Model API Terms updated
- 10-12 Muse Wonder and Wonder Full: $4 in, $20 out, $0.20 cached, no contributor mode
- 10-15 Muse Spark Open 816B-A42B (repo created 09-15, gated)

Hardware and Connect:
- 01-06 CES: Ray-Ban Display features; international rollout paused
- 03-31 Prescription glasses at $499
- 04-16 Quest price increase
- 05-21 Japan, 05-26 Korea glasses launches
- 06-23 "Meta Glasses" brand from $299
- 08-24 MTIA 300 chip and MetaRoCE
- 09-23/24 Connect: Meta VR Glasses ($1,299.99, spring 2027), Ray-Ban Meta Audio ($349), Gen 3 ($449), Muse Charm, Muse Realtime Avatar
- 09-28 Meta Enterprise Platform; CJ Desai hired

Infrastructure and deals:
- 01-09 Nuclear deals up to 6.6 GW; 01-27 Corning up to $6B
- 02-17 Nvidia; 02-24 AMD; 03-11 custom silicon; 03-24 Arm; 04-14 Broadcom; 04-24 AWS Graviton
- 03-16 Nebius up to $27B; 04-09 CoreWeave about $21B
- Data centers: 02-11 Lebanon IN; 04-21 Tulsa; 06-09 Reliance (India); 07-08 first Canadian; 07-28 El Paso with BlackRock
- 09-21 Petal subsea cable

Corporate and financial:
- 01-12 Dina Powell McCormick, President and Vice Chairman
- 01-13 (approx.) Reality Labs cuts about 10%
- 01-28 Q4: revenue $59.89B; 2026 capex guide $115-135B
- 04-23 About 10% of staff (about 8,000) cut, carried out 05-20
- 04-29 Q1: $56.31B; capex $125-145B; 04-30 $25B bond sale
- 05-27 Annual meeting
- 07-29 Q2: $60.80B; capex $130-145B
- 10-20 Nonvoting Class C stock plan
- 10-21 Q3: $64.60B, $9.89B charge for the state AG settlement, Muse over 10M accounts, headcount 66,775
- 10-26/27 $25B forward sale plus $12.5B mandatory convertible preferred

Legal and regulatory:
- 01-20 FTC appeals the antitrust ruling
- 03-24 New Mexico jury $375M; 03-25 Los Angeles K.G.M. verdict $6M
- 04-14 or 04-27 (conflicting) China orders the Manus deal unwound
- 04-29 EU DSA preliminary findings on under-13 users; 07-10 on addictive design
- 05-05 Publishers' copyright suit (SDNY)
- 06-09 EU interim order opening WhatsApp to rival AI assistants
- 07-28 Meta signs the EU AI Act transparency code
- 08-06 New Mexico $567M abatement fund
- 08-12 Australia under-16 ban compliance
- 08-26 State AG settlement up to $18.59B
- 10-21 New Mexico $25B penalty; 10-22 Rhode Island scam-ads suit
- Oversight Board: 03-26 Community Notes opinion; 09-17 AI deepfake decisions; 10-29 pregnancy drugs decision

## Gaps

- ai.meta.com can't be listed; MSL research posts may be missing.
- The Muse Model License is gated and unread.
- Muse Code plan prices and per-version dates.
- Spark 1.3 and Max mode dates are secondary-source only; no official SAM 3.1 announcement date; no exact Muse Realtime Avatar date.
- Missing: Q3 call transcript, latest Meta AI monthly users, leadership news (LeCun, Friedman, MSL reorganizations), Moltbook and ARI acquisition dates, regulators in the UK, India, Brazil, Japan and Korea, whether the Oct 28 JCCP trial started, whether Muse Video shipped.
- YouTube and podcasts unchecked.
