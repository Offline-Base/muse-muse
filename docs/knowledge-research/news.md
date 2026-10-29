# News and web at scale

Research agent report, checked Oct 29, 2026 ("checked" means a small index file or page was opened). Unverified where the search limit ran out: Media Cloud's terms and some vendor terms. Not yet rechecked by hand.

| Source | 2026 data | Access | Volume | License and training | Cost, credit | Verdict |
|---|---|---|---|---|---|---|
| Common Crawl main crawls | 10 crawls: CC-MAIN-2026-04, -08, -12, -17, -21, -25, -30, -34, -39, -43 (collinfo.json); 2026-04 runs Jan 12 to 25 | S3 us-east-1; columnar URL index (Parquet) via Athena; HF bucket `commoncrawl/commoncrawl` has 2026-17 to 2026-43 (829 TB, pre-warmed for GCP US East) | Oct crawl 2.16B pages; WARC 86.19 TiB, WAT 14.06, WET 5.85, index 0.20 TiB | Limited license; respect third-party copyright | Athena $5/TB plus EC2 spot (AWS), or GCP via the HF bucket; use an S3 gateway endpoint, not NAT or Elastic IP | Training-only |
| CC-NEWS 2026 | Months 01 to 09: 3,540 WARC files, 3.45 TiB compressed | S3 or HTTPS, WARC only; `brian-learns/cdx-cc-news` URL index (MIT) | ~6.7M articles a month, all languages | Publishers' copyright | AWS | Training-only, top value |
| INFINI-NEWS v2 (`ruggsea/infini-news-corpus`) | 26.7M articles Jan to Apr 2026 | HF parquet; snippet API | 1.37B articles 2016 to 2026, 1,214 languages, extracted with publish dates | Derived columns CC BY 4.0; text publishers' | Free | Training-only; saves Jan to Apr extraction |
| Fine-News (`ksolovev/fine-news`) | 14.8M deduplicated docs Jan to Apr 2026 | HF parquet | 1.03 TB total | No license stated | Free | Training-only baseline |
| CCNews-Plus (`AbedGarra/ccnews2024plus`) | English monthly sets to 2026-08 | HF jsonl | Filtered, deduplicated | No license stated | Free | Training-only |
| forecast-news (`shash42`) | Daily to 2026-08-31 with publish dates | HF parquet | 31.9M articles, 158 GiB | Tagged Apache-2.0; text publishers' | Free | Training-only |
| openalphalab/gdelt-news | Updated Oct 29 | HF parquet | Rebuilt from n-grams, incomplete | Publisher rights | Free | Skip |
| GDELT 2.0 events, mentions, GKG, translingual (65 languages) | Files for 2026-01-04 and 2026-10-29 | Raw every 15 min; BigQuery `gdelt-bq.gdeltv2` | GKG ~300-450 GB for the window; events under 20 GB | Unlimited use, redistribution with citation; URLs and metadata only | Free raw; BigQuery $6.25/TiB (Google) | Publishable (metadata, derived facts) |
| GDELT DOC API | About the last 3 months (not rechecked) | API | | Same | Free | Discovery for Aug to Oct |
| Event Registry, Webz.io, Diffbot, NewsAPI.org, GNews | | APIs | | No training grant found, or bans on news databases and republishing | Paid | Skip unless licensed in writing |
| Exa | | API | | Terms 4.2(a) bar copying, reproducing, deriving from or publishing results without written permission | $400 | URL discovery only |
| Internet Archive / Wayback | | CDX API, ~1 req/s | 382 news sites limit its crawlers | Research, noncommercial, fair use | Free | Spot gap-filling only |
| VOA and language services | Stories dated Oct 28, 2026 (restored after a March 2026 court order) | Sitemaps, RSS | Dozens of languages | Own work public domain; drop AP, Reuters, AFP items | Free | Publishable |
| Global Voices | Posts Oct 29, 2026 | RSS, sitemaps | ~50 languages | CC BY 3.0 | Free | Publishable |
| Kremlin.ru | | Sitemaps | Russian, English | CC BY 4.0 (secondary sources) | Free | Publishable |
| UN News | | RSS | ~8 languages | Reprint whole with credit (secondary sources) | Free | Training; verbatim only if published |
| Agência Brasil | Oct 29, 2026 | RSS | Portuguese, Spanish, English | Reprint with credit; footer says all rights reserved | Free | Training; publish only after reading terms |
| DVIDS | | API (free key) | 1.8M assets | Mostly public domain (not checked) | Free | Publishable |
| Media Cloud | Active | Search, 25k-source directory | 1B+ stories | Terms not checked | Free account | Directory for regional source lists |
| Wire services (AP, Reuters, AFP, dpa, EFE, Kyodo, Xinhua) | | | | Commercial licenses only | | Skip; strip syndicated copies from CC-NEWS |
| NOW corpus | | | | Paid academic license | | Skip |

## Publish dates

The URL index has fetch time, not publish date. Select rows in Athena by domain and path, then read `article:published_time` or JSON-LD `datePublished` from WAT meta tags, or byte-range the WARC and run htmldate or trafilatura; URL date patterns as fallback. Google News sitemaps only list two days; use monthly sitemaps from robots.txt. January 4 to 11 is only in CC-NEWS (the first 2026 crawl starts Jan 12).

## Opt-out test

A site is out if any of these hold, taking the strictest answer across the window:
- robots.txt disallows an AI-training agent (CCBot, GPTBot, Google-Extended, ClaudeBot, Applebot-Extended, Meta-ExternalAgent, Bytespider). Common Crawl stores each crawl's robots.txt (0.15 TiB per crawl).
- robots.txt carries `Content-Signal: ai-train=no` (Cloudflare default on ~3.8M domains), an RSL `License:` line or `Content-Usage: train-ai=n` (IETF draft).
- TDMRep: `/.well-known/tdmrep.json`, a `tdm-reservation` header or meta tag (WAT files carry these).
- A `noai` meta tag or `/ai.txt` (llms.txt isn't an opt-out).
- Blocklists: Common Crawl's Opt-Out Ledger, the News Media Alliance Exhibit A list (Apr 29, 2026), the Digital Content Next cease-and-desist publishers (Jun 3, 2026: AP, NYT, NBC, Bloomberg, NPR, Fox). Common Crawl doesn't delete old files, so we apply these ourselves.
- EU publishers: exclude unless their terms allow it (a 2024 German ruling counted terms-based reservations).

Our own fetching: a User-Agent with a contact URL, about 1 request a second per host, robots.txt checked for our agent.

## Top 10

1. CC-NEWS 2026 (INFINI-NEWS for Jan to Apr, our own extraction for May to Oct).
2. GDELT GKG and translingual on BigQuery (publishable, 65 languages).
3. Common Crawl main crawls via the columnar index, for primary and regional sites.
4. Fine-News and CCNews-Plus as dedup baselines.
5. Opt-out tooling.
6. VOA.
7. Global Voices.
8. forecast-news, for checking probes.
9. Kremlin.ru, UN News, Agência Brasil, DVIDS.
10. Media Cloud's directory plus the INFINI search API for gap checks.

## Corrections to the plan

- Wikinews has been read-only since May 4, 2026.
- Exa's terms forbid copying or deriving from results without written permission: use it to find URLs, then fetch from the source under the opt-out rules, or get Exa's written OK.
- The opt-out test must be defined: 79% of the top 100 US and UK news sites block at least one AI bot (reported Jan 2026), so major outlets mostly drop out and regional and non-English outlets dominate.
- GDELT is redistributable with a citation: publishable, not training-only.
- Extracted 2026 news text already exists through April (all languages) and August (English).
- Size: CC-NEWS alone is about 60 to 70M articles in the window, roughly 40B tokens raw or about 20B after dedup, before opt-outs: above the plan's 5 to 20B.
- No download fees only without NAT gateways or Elastic IPs; seven of ten crawls are also in the HF bucket for GCP.
- Filtering all ten crawls on AWS spot: about $300 to $1,500 (estimate).
