# Wikimedia and open knowledge bases

Research agent report, checked Oct 29, 2026 from dumps.wikimedia.org listings and free Wikimedia APIs. Late items (DBpedia, YAGO, QLever, BigQuery) less verified. Not yet rechecked by hand.

| Source | 2026 data | Access, volume | License | Cost | Verdict |
|---|---|---|---|---|---|
| enwiki dumps | Monthly 20260401 to 20261001; 20261001 multistream 25.1 GB | HTTP; 20th-of-month runs ended Jan 2026; legacy XML deprecated Jan 23, 2026 (T414389) | CC BY-SA 4.0 + GFDL | Free | Publishable (the "after" snapshot) |
| enwiki 20260101 multistream | Gone from WMF, your.org, umu.se and the Debian mirror; only a torrent listing (seeding unverified) | Torrent | Same | Free | Fallback only |
| Dumps 2 history (`other/mediawiki_content_history/enwiki/2026-10-01/`) | Runs 2026-08, 09, 10-01, split by page id | About 2 TB bz2 for enwiki (estimate); ~900 wikis | CC BY-SA 4.0 | AWS spot, ~$50 | Publishable, best source |
| Dumps 2 current (`other/mediawiki_content_current/`) | 2026-10-01: 19 files, 46.6 GB | | CC BY-SA 4.0 | Free | Publishable |
| Adds-changes incremental (`other/incr/`) | Daily 20260918 to 20261028 still up (~6 weeks kept); enwiki ~0.84 GB a day, Wikidata ~0.6 GB | Experimental, 12-hour delay, no deletes or moves | CC BY-SA / CC0 | Free | Publishable. Time-sensitive: October's files start disappearing mid-November |
| mediawiki_history (`other/mediawiki_history/2026-09/enwiki/`) | Monthly TSVs 2026-01 to 09, ~0.55 GB bz2 each | Every revision and page event, revert and bot flags; has usernames | CC0 | Free | Index only, not published |
| CirrusSearch index (`other/cirrus_search_index/`) | Weekly; 20261025 enwiki_content 41.9 GB bz2 | Rendered plain text plus Wikidata ids, all wikis | CC BY-SA | Free | Publishable, cleanest text |
| Wikimedia Enterprise | Free tier: monthly snapshot, limited requests, Structured Contents beta; HTML dumps no longer mirrored since Mar 2025 | API, needs the owner's signup | CC BY-SA | Free | Optional (rendered infoboxes) |
| Legacy pages-meta-history | 20261001, deprecated | 7z | | | Skip; use Dumps 2 |
| Other-language Wikipedias | ja monthly portal pages; fr, de, ru month articles; de "Nekrolog"; es year and monthly deaths articles; zh portal ended 2009; English about 10x richer | Dumps 2, Cirrus | CC BY-SA | Free | Publishable via month, year and deaths articles plus new pages |
| Wikidata JSON (`wikidatawiki/entities/`) | latest-all.json.bz2 103.6 GB (Oct 27); truthy drops qualifiers; lexemes 485 MB; dated folders only from 20260914 | Stream-filter on AWS | CC0 | ~$20 | Publishable; exact answers for probes |
| Wikidata SPARQL | 60 s timeout, per-UA quotas, 5 parallel per IP; scholarly split to query-scholarly | | CC0 | Free | Spot checks only |
| Wiktionary via Kaikki.org | JSONL from the 2026-10-01 dump, 2.9 GB gz, weekly | | CC BY-SA 4.0 / GFDL | Free | Publishable (new words) |
| Wikinews | Closed, read-only since May 4, 2026 | | CC BY 4.0 | Free | Minor |
| Wikisource | en "Category:2026 works": 106 pages (State of the Union, executive orders, rulings) | API, dumps | Mostly public domain texts | Free | Publishable, small, high value |
| Wikivoyage | 5,660 en pages mention 2026 | Dumps | CC BY-SA | Free | Low priority |
| Commons structured data | 61.8 GB | | CC0 | | Skip |
| Pageviews | REST top endpoint current; pageview_complete 2026-01 to 10, ~22 GB a month; no public 2026 BigQuery table found | REST, dumps | CC0 | Free | Publishable (ranking) |
| Clickstream | 2026-01 to 09, 40 wikis | | CC0 | Free | Minor |
| EventStreams, recentchanges API | 7 to 31 days of history | | | Free | Weekly refresh only |
| DBpedia | No 2026 release confirmed | | CC BY-SA | | Skip |
| YAGO 4.6 | July 2026 | | CC BY 4.0 | | Skip; use Wikidata |
| OpenStreetMap | Current | | ODbL | | Skip |

Access rules: User-Agent must carry contact details (email, website or wiki user); 2026 limits are 200 requests a minute for UA-identified clients and 10 for unidentified ones; unauthenticated Action API use is 1 concurrent request and under 5 a second; honor Retry-After on 429s. Bulk users are pointed to dumps or Enterprise.

Scale: 152,943 new user-created articles January to September; 1.26 to 1.52 million article pages edited each month.

## Top 10

1. Dumps 2 enwiki content history: the exact January 4 state of every page and when each sentence first appeared.
2. CirrusSearch enwiki_content for `documents/`.
3. Wikidata full JSON: dated statements as facts and probes.
4. mediawiki_history: what changed, with revert and vandalism filtering.
5. Portal:Current events (built).
6. Adds-changes daily files for October.
7. Pageviews for ranking and the coverage audit.
8. Month, year and deaths articles in de, fr, ja, ru, es, it, pt, pl, nl.
9. Wikisource 2026 works.
10. Wiktionary via Kaikki.

## Full Wikipedia coverage, recommended

1. What changed: mediawiki_history 2026-01 to 09 (~5 GB), October from incremental stubs or recentchanges; drop reverted and bot-only edits.
2. Text: on an AWS us-east-1 spot instance, stream the 2026-10-01 Dumps 2 history (your.org mirror). For each touched page keep the last revision on or before January 4, the October 1 revision, and the revision where each added sentence first appeared (its "as of" date). This replaces the January 1 dump and per-article API calls.
3. October 1 to now from the adds-changes daily files, then the November 1 dump; EventStreams for weekly refreshes.
4. Rendered text from CirrusSearch, or Enterprise (owner signup).
5. Repeat per language.

## Corrections to the plan

- The January 1 dump isn't on any HTTP mirror checked, only a torrent, and is three days before the baseline.
- Legacy XML dumps are deprecated; switch to Dumps 2.
- Wikinews closed in May 2026 and is CC BY 4.0.
- Wikidata dated statements need the full JSON dump (truthy drops qualifiers, SPARQL times out); no January Wikidata dump survives, so changes come from Dumps 2 Wikidata history.
- Per-article API fetching (stage 1) doesn't scale under 2026 limits, and our User-Agent's only contact is a private GitHub repo: add an email.
- Add mediawiki_history, CirrusSearch, Wikisource, clickstream.
- License: Q&A rewritten from Wikipedia is likely an adaptation, so CC BY-SA 4.0 with per-article attribution (title, URL or history, license, change note). CC0 mixes freely; ODbL can't be relicensed. Check whether Spark Open's derivative terms conflict with BY-SA (needs a legal read). Wikimedia's licenses don't forbid AI training.
