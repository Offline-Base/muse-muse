# Sports, culture, entertainment, business and everyday sources

Research agent report, checked Oct 29, 2026 with page fetches and small API calls (GitHub API, Wikidata SPARQL counts, S3 listings). Not checked (search budget ran out): IGDB, NYT Books API, OpenSky, Billboard's terms, Kaggle. Not yet rechecked by hand.

| Source | 2026 data | Access | License, AI training | Verdict |
|---|---|---|---|---|
| openfootball (worldcup.json, football.json) | World Cup 2026 folder (README: Spain champions); 2025-26, 2026, 2026-27 seasons | git, a few MB | CC0 | Publishable |
| Cricsheet | 2,246 matches from 2026 | zip JSON or YAML | ODC-BY (XML CC BY 4.0), commercial OK | Publishable |
| nflverse-data | play_by_play_2026 updated Oct 29; 2025 file covers Super Bowl LX | GitHub releases | CC BY 4.0 (data originates with the NFL) | Publishable with attribution |
| Retrosheet | Latest season 2025 | Event files | Any use with its credit line | Publishable once 2026 is out |
| MLB Stats API, NBA.com stats, NHL API | Live | API | Personal, non-commercial; no databases or scraping | Skip |
| Sports Reference (FBref and others) | Live | Web | Bans AI training, fine-tuning and prompting by name | Skip |
| Jolpica F1, OpenF1 | 2026 rounds present | API, dumps | CC BY-NC-SA 4.0 | Training-only if non-commercial, else skip |
| Sackmann tennis_atp and tennis_wta | Repos deleted | | | Skip |
| StatsBomb open data | No free 2026 World Cup release found (unverified) | git | Non-commercial agreement | Skip |
| Milano Cortina 2026 Olympics | No open dataset found | | IOC terms | Use Wikipedia and Wikidata |
| Wikidata culture classes | Since Jan 4: 17,674 deaths; published in 2026: 2,497 films, 2,458 games, 969 albums, 713 literary works | SPARQL, dump | CC0 | Publishable |
| TMDB API | Live | API | Forbids training AI, including LLMs | Skip |
| IMDb datasets | Daily | TSV | Personal, non-commercial | Skip |
| Box Office Mojo, The Numbers | Live | Web | Ban scraping | Skip; use "2026 in film" |
| TVmaze API | Live | API, 20 calls per 10 s | CC BY-SA, any purpose | Publishable, share-alike |
| MusicBrainz | Full export 2026-10-28 | Postgres or JSON | Core CC0; tags, ratings, edits, stats CC BY-NC-SA | Core publishable |
| ListenBrainz | Dump 2026-10-15 | Large | No license stated | Training-only until confirmed |
| Discogs | discogs_20261001 | XML, 10 GB+ (estimate) | CC0 | Publishable |
| Billboard, Spotify charts | | Web | Copyright and terms | Skip; use Wikipedia's 2026 number-ones lists |
| Open Library | Dump 2026-09-30 | 9.2 GB editions, 12.4 GB all | CC0 per secondary sources (dumps page names none) | Publishable, citing that |
| Library of Congress MARC | 2026 records need a paid subscription | | | Skip |
| Nobel Prize API | All six 2026 prizes | API | CC0 | Publishable |
| IGDB | Unverified | API | Twitch agreement, commercial needs partnership | Skip |
| Steam Web API | Live | 100k calls a day | Personal-use distribution only | Training-only, facts |
| GLEIF Golden Copy | Three files a day plus deltas | CSV, XML | CC0 | Publishable |
| OpenCorporates | Live | Bulk on request | ODbL or paid | Skip for now |
| FRED | Runs to Oct 28 | API | S&P 500 series copyrighted; Fed and Treasury series public domain | Public-domain series only |
| Binance Vision | Daily | Bulk | CC BY-NC-SA 4.0 since Aug 26, 2026 | Skip for publishing |
| CoinGecko, Yahoo Finance | Live | API | Ban storing or deriving; personal use | Skip |
| openFDA | 676 drug-recall reports in 2026 | API, bulk | Open license | Publishable |
| NHTSA vPIC and recalls, fueleconomy.gov | 2027 model years listed | API | US government | Publishable |
| NOAA Storm Events | 2026 file c20261026 | CSV | Public domain | Publishable |
| NOAA Billion-Dollar Disasters | Retired May 2025; Climate Central continues it (terms unverified) | | | Check Climate Central |
| EM-DAT | 2026 | Portal | Non-commercial after registration, no redistribution | Skip |
| ReliefWeb API | 2026 | API, pre-approved appname since Nov 2025 | Varies by report | Training-only |
| ERA5 | About 5 days behind | Grids | CC BY | Optional, low text value |
| BTS airline on-time | Through Aug 2026 | CSV | Public domain | Publishable |
| Mobility Database | 6,000+ transit feeds | Catalog | Per feed | Low value |
| Open Food Facts | Nightly | JSONL, CSV | ODbL / DbCL; images CC BY-SA | Publishable, share-alike |
| Hugging Face 2026 sets | Small, mostly unlicensed or scraped | | | Skip |

## Top 10

1. Wikidata culture and sports classes (exact answers for probes).
2. openfootball: World Cup 2026 and 2025-26 leagues.
3. nflverse.
4. Cricsheet.
5. MusicBrainz core plus Discogs (October 2026 dumps).
6. Open Library (Sep 30 dump).
7. TVmaze.
8. NHTSA, fueleconomy.gov, openFDA.
9. GLEIF deltas.
10. Nobel API, BTS, NOAA Storm Events.

## Corrections to the plan

- MusicBrainz is CC0 only for the core dump; MetaBrainz asks commercial users to pay.
- Open Library's CC0 comes from secondary sources; cite it that way.
- Sports needs its own open sources and an explicit block list: Sports Reference, MLB, NBA, NHL, TMDB, IMDb, Box Office Mojo, The Numbers, Binance, Jolpica and OpenF1 (NC-SA), CoinGecko, Yahoo, EM-DAT.
- The window ends mid-season (World Series, NFL, NBA, NHL, F1): probes must not ask for unsettled outcomes.
- Some 2026 data arrives after Oct 28 (Retrosheet, Lahman, BTS from September, hurricane reports, year-end lists in November and December); the weekly refresh must revisit them.
- NOAA's billion-dollar series stops at 2024.
- Hugging Face and Kaggle 2026 sets are small and mostly unlicensed.
