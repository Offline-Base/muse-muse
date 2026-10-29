# Science, research, health and space sources

Research agent report, checked live on Oct 29, 2026 (counts from live API, FTP or bucket queries unless marked "not verified"). Every source is free; credits only pay for processing. Links and counts not yet rechecked by hand.

| Source | 2026 holdings | Access and volume | License, AI training, redistribution | Cost | Verdict |
|---|---|---|---|---|---|
| arXiv metadata (OAI-PMH, export API, Kaggle Cornell-University/arxiv) | About 308k new papers Jan to Oct (23.3k in Jan to 40.4k in Sep); Kaggle v309 updated Oct 24 | OAI-PMH at most 1 request per 3 s; Kaggle 5.6 GB, needs an account | Metadata and abstracts CC0; each record's license field gives the paper's license | Free | Publishable |
| arXiv full text | `s3://arxiv` monthly tars; free GCS mirror `gs://arxiv-dataset` has PDFs for 2601 to 2610 | 9.2 TB total in Apr 2025, about 100 GB a month; 2026 about 1.2 to 1.5 TB (estimate) | arXiv's default license forbids re-hosting; only CC BY, BY-SA and CC0 papers publishable; NC needs its own split | S3 requester pays, nearly free on EC2 in us-east-1 (AWS); GCS reads on GCP | CC papers publishable, the rest training-only |
| OpenAlex | Snapshot Oct 14 in `s3://openalex`; API shows 32.3M works published Jan 4 to Oct 28 | 745 GB gz JSONL or 770 GB Parquet; public snapshot quarterly, daily paid; API metered ($1/day with a free key) | CC0 for OpenAlex data; abstracts belong to publishers | Free | Metadata publishable; abstracts training-only |
| Semantic Scholar datasets | Release 2026-10-20 | Needs an API key (owner applies); papers 200M, s2orc_v2 16M full texts, tldrs 58M | ODC-BY; paper text keeps its license | Free | TLDRs and metadata publishable with attribution; s2orc training-only |
| Crossref | REST API: 6.45M works in window, 4,177 retraction notices | REST cursor; the March public file mostly predates the window | Metadata unrestricted; abstracts publishers' | Free | Publishable (metadata) |
| PubMed | Baseline pubmed26n0001-1334 plus updates to n1700 (Oct 29); 1.45M records in window | FTP | NLM credit line and currency statement required; abstracts may be copyrighted | Free | Metadata and MeSH publishable; abstracts training-only |
| PMC open access | 714,839 OA articles in window, 467,790 CC BY | `s3://pmc-oa-opendata`, per-article folders, license JSON, daily inventory (the FTP bulk packages were removed in late Aug 2026) | Per article | Free (AWS processing) | CC BY, BY-SA, CC0 publishable; NC, ND, manuscripts training-only |
| Europe PMC | 680,899 OA records, 598,230 CC BY or CC0, 188,302 preprints | REST, weekly FTP | Per article | Free | Per license (overlaps PMC) |
| bioRxiv, medRxiv | 45,223 and 14,529 new papers in window; about a third cc_by | API with JATS links; `s3://biorxiv-src-monthly` requester pays | No re-hosting under TDM terms; license per paper | Nearly free in us-east-1 | CC BY and CC0 publishable; rest training-only |
| OpenReview | ICLR, ICML, NeurIPS 2026 (not verified: anonymous API now challenged) | Needs the owner's free account | Reviews CC BY 4.0, metadata CC0, papers per license | Free | Reviews publishable |
| ACL Anthology | 2026 ACL (2,650 papers), EACL, Findings, LREC | GitHub XML and PDFs | CC BY 4.0 | Free | Publishable |
| CORE | Recent dumps need a paid licence | | | Paid | Skip |
| DOAJ | 1,069,216 articles dated 2026 | API; full dump by email request | CC0 metadata | Free | Publishable |
| ClinicalTrials.gov | 45,108 studies first posted, 4,988 first results in window | API v2, bulk zip | US government (terms page not verified) | Free | Publishable |
| openFDA | Updated Oct 28; recalls, 510(k), PMA decisions in window; FAERS stops Jul 30 | API and bulk | CC0 except GMDN device terms (licence needed for AI training) | Free | Publishable without GMDN fields |
| DailyMed | 34,568 drug labels since Jan 4 | API and bulk | Public domain | Free | Publishable |
| CDC MMWR | Volume 75 through issue 42 | HTML | Public domain | Free | Publishable |
| WHO | 31 Disease Outbreak News items | OData API | CC BY-NC-SA 3.0 IGO | Free | Facts only; text training-only |
| ECDC, EMA | Not checked | Web | ECDC CC BY 4.0; EMA commercial reuse with credit | Free | Publishable |
| NIH RePORTER, NSF | 66,667 NIH projects, 6,649 NSF awards in window | APIs | Public domain | Free | Publishable |
| NASA news and images | 1,071 news posts since Jan 4; 3,598 Artemis images | APIs | Generally not copyrighted; AI products may not say "according to NASA" or use the insignia | Free | Publishable, with that phrasing rule |
| NASA ADS | Needs a token | | Abstracts publishers' | Free | Skip |
| Exoplanet Archive | 361 planets discovered in 2026 | TAP | Public | Free | Publishable |
| ESA | Not checked | Web | Personal, non-commercial only | | Facts only |
| NOAA Storm Events | 2026 details file c20261026 | NCEI CSV | Public domain | Free | Publishable |
| USGS earthquakes | 23,859 at M2.5+, 117 at M6+ | API | Public domain | Free | Publishable |
| Copernicus CDS and ADS | Not checked | Free account | CC BY 4.0 since Jul 2, 2025 | Free | Publishable (data) |
| Nature News, Science, Cell, Lancet, NEJM, STAT | robots.txt blocks CCBot, GPTBot, ClaudeBot | | Springer Nature commercial TDM is paid | | Skip |
| The Conversation | | | CC BY-ND, but blocks AI crawlers | | Skip |
| EurekAlert | | | Personal, non-commercial; no retrieval systems | | Skip |
| Retraction Watch | CSV updated every working day (GitLab crossref/retraction-watch-data) | git clone | No license in README; Crossref site CC BY 4.0; confirm first | Free | Publishable once confirmed |
| Google Patents (BigQuery) | 2026 freshness not verified | BigQuery, multi-TB | CC BY 4.0 | 1 TiB a month free, then $6.25/TiB (GCP) | Publishable; USPTO bulk as fallback |
| Nobel Prize API | 2026 laureates live | API | CC0 metadata | Free | Publishable |
| Zenodo, OSF | 1.53M Zenodo records, 20,236 OSF preprints in window | APIs | Per record | Free | Per license |

## Top 10

1. PMC open access on S3 plus Europe PMC: about 468k CC BY full texts from 2026.
2. arXiv: CC0 metadata for about 308k papers, plus CC-licensed full text (the GCS mirror is easiest).
3. OpenAlex snapshot: the backbone for dates, entities and venues.
4. bioRxiv and medRxiv, with per-paper licenses from the API.
5. OpenReview reviews and the ACL Anthology for 2026 ML and NLP.
6. openFDA, DailyMed and ClinicalTrials.gov: approvals, recalls and trials with exact answers.
7. MMWR, WHO outbreak news, ECDC and EMA.
8. Retraction Watch and Crossref retraction notices.
9. Nobel Prize API, Exoplanet Archive, USGS and NOAA: exact-answer probes.
10. NIH RePORTER and NSF: 2026 funding changes.

## Corrections to the plan

1. OpenAlex's CC0 doesn't cover abstracts; the free snapshot is quarterly and the API needs a free key.
2. PMC's FTP bulk packages are gone; use `s3://pmc-oa-opendata` and its license JSON. The OA subset includes NC and ND articles, which can't be published.
3. Most 2026 arXiv papers use the default license, which forbids re-hosting; count the CC subset before sizing.
4. Add PubMed (1.45M records, MeSH), with NLM's credit and currency terms in the dataset card.
5. Chat data must not say "according to NASA".
6. ESA and WHO aren't open licenses; add ECDC and EMA, which are.
7. OpenReview needs the owner's login.
8. Common Crawl will have almost none of the major journals' news, since they block CCBot.
9. The openly licensed token estimate is low: 468k CC BY PMC articles at about 7k tokens each is about 3B tokens before arXiv (estimate).
10. arXiv and bioRxiv reads are nearly free on EC2 in us-east-1; BigQuery and the GCS arXiv mirror fit the Google credits; Lambda is only needed if we parse PDFs rather than LaTeX or JATS.
