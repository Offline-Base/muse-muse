# Government, law, policy, elections and finance sources

Research agent report, checked Oct 29, 2026 ("Yes" means 2026 records were confirmed from a public listing or a small API call). No bulk downloads. All free; credits pay for processing (AWS for CourtListener in us-west-2, the EDGAR crawl and OCR; Lambda for fact extraction; Google only for Patents on BigQuery; Exa for pages without feeds). Not yet rechecked by hand.

| Source | 2026 data | Access and limits | Volume in window | License | Verdict |
|---|---|---|---|---|---|
| GovInfo bulk: FR, BILLS, BILLSTATUS, PLAW, ECFR | Yes (FR/2026/01-10; BILLS/119/2 updated Oct 29) | No key | ~0.7 GB FR XML (50-100M tokens), 9,079 bill versions, 69 public laws | Public domain | Publishable |
| GovInfo API: CREC, CHRG, CRPT, CPD, USCOURTS | Yes: 160 Record issues, 253 hearings, 485 reports, 654 presidential documents, 118,706 court packages | api.data.gov key, 36,000 an hour; the Record isn't in bulkdata | 100-300M tokens | Public domain | Publishable; printed hearings lag months |
| Federal Register API | Yes: 68 executive orders, latest Oct 28 | No key; 10,000 results per query, so query by day | ~25k documents | Public domain | Publishable |
| Congress.gov API | Yes: 2026 House roll calls | api.data.gov key, 5,000 an hour | Actions, votes, nominations, treaties | Public domain | Publishable |
| CRS and GAO reports | GAO feed latest Oct 26 | RSS, Congress.gov | Thousands | Public domain | Publishable; best neutral explainers |
| White House and agencies | whitehouse.gov JSON API 403, sitemap allowed; DOJ API works | Sitemaps, RSS, DOJ API | 10k+ | Public domain | Publishable after removing private defendants' names |
| CourtListener bulk (S3 us-west-2) | Yes: Sept 30, 2026 snapshot (opinions 55.3 GB compressed) | No sign-in; quarterly full snapshot; API now 125 requests a day | 0.5-1.5B tokens for 2026 (estimate) | Public Domain Mark | Opinions publishable; dockets training-only |
| supremecourt.gov | Yes: 75 OT2025 opinions and orders | PDFs | Small | Public domain | Publishable |
| PACER | | $0.10 a page | | | Skip; use RECAP |
| Open States bulk | Yes: Oct 2026 dump, 10.77 GB | No key | All 50 states | Public domain dedication | Publishable |
| LegiScan | Bot-blocked | Free account, weekly datasets | All states | CC BY 4.0 | Publishable backup |
| SEC EDGAR | Yes: daily index all four quarters; 8,956 8-Ks with "material definitive agreement"; XBRL sets 2026 Q1-Q3 | No key; User-Agent with name and email; 10 a second | ~1M filings, 1-2B tokens of 10-K, 10-Q, 8-K text (estimate) | SEC claims no copyright; filer text and exhibits vary | XBRL and metadata publishable; full text training-only |
| FRED and ALFRED | | | | Terms ban use in developing or training AI | Skip; use the primary sources |
| BLS | Yes: CPI-U Sept 2026 336.940 | v2 key (500 a day); site needs an email in the User-Agent | Small | Public domain | Publishable |
| BEA, Census | Not checked | BEA UserID; Census key past 500 a day | Small | Public domain | Publishable |
| Treasury Fiscal Data | Yes (Oct 27-28) | No key | Small | Public domain | Publishable |
| Federal Reserve Board | Yes: FOMC statements Jan 28 to Oct 28 | Pages, feeds | Small | Public domain | Publishable |
| FEC | Yes: 2025-26 bulk | api.data.gov key | GBs | Donor names may not be used commercially | Committee and candidate totals only |
| USPTO Open Data Portal | Not checked | Identity-verified account | ~7k grants a week | Public domain | Training-only, low priority |
| Sanctions: OFAC, EU, UK, UN | Yes (OFAC Oct 28, EU Oct 23); UK OFSI list closed Jan 28, 2026 (UK Sanctions List only now); old UN XML URL 404 | No key | Small, exact dates | OFAC public domain; EU with attribution; UK OGL; UN terms | Publishable except UN (training-only); skip OpenSanctions (non-commercial) |
| EUR-Lex (Cellar SPARQL) | Yes: 1,178 judgments, 1,043 decisions, 1,885 consolidated texts; drop 747k procurement notices | No key | Large | CC BY 4.0 | Publishable |
| European Parliament API v2 | Yes | No key | Votes, debates, documents | CC BY 4.0 or CC0 | Publishable |
| Commission press corner API | Yes (Oct 29) | No key | ~8k | CC BY 4.0 | Publishable |
| Eurostat API | Yes, through Sept 2026 | No key; old HICP set frozen since Feb 2026, use prc_hicp_minr | Small | Attribution | Publishable |
| legislation.gov.uk | Yes: 27 Public General Acts | Atom feeds | Small | OGL v3 | Publishable |
| UK Hansard API | Yes | No key | Tens of millions of words a year | Open Parliament Licence | Publishable |
| GOV.UK Search and Content APIs | Yes: 61,991 items since Jan 4 | No key | Large | OGL | Publishable |
| ONS | API live | No key | Small | OGL | Publishable |
| Canada parliament | Not checked | Email in User-Agent | | Non-commercial | Training-only |
| Australia Hansard | 403 | | | CC BY-NC-ND | Training-only; legislation.gov.au CC BY 4.0 publishable |
| India | Not checked | | | PIB free to reproduce | PIB publishable; debates training-only |
| Bundestag DIP | Not checked | Free key | Plenary text | Official works with credit | Publishable |
| UN (Digital Library, documents, press, treaties) | Yes | Search API | Large | Personal, non-commercial, no redistribution | Training-only |
| World Bank | Yes: 31,049 documents | No key | Large | CC BY 4.0 default | Publishable |
| OECD | Bot-blocked | SDMX API | | CC BY 4.0 | Publishable |
| IMF | | | | Bans LLM training and bulk downloads without permission | Skip, or ask |
| BIS | | | | Non-commercial, 400-word extracts | Training-only at most |
| ECB, Bank of England | | | | ECB free with attribution; BoE non-commercial (OGL for statistics only) | ECB publishable; BoE text training-only |
| Election results | MIT election lab only to 2024 | State offices, national commissions | | Mostly public records | Wikidata plus official results; US general election (Nov 3) is after the window |

## Top 10

1. GovInfo (Federal Register, Congressional Record, bills, laws, presidential documents, court packages).
2. SEC EDGAR 8-Ks and XBRL.
3. CourtListener bulk opinions plus supremecourt.gov.
4. EUR-Lex, European Parliament, Commission press corner.
5. GOV.UK, legislation.gov.uk, Hansard.
6. Congress.gov API with CRS and GAO.
7. Fed, Treasury, BLS, BEA, Census (instead of FRED).
8. Open States.
9. OFAC, EU and UK sanctions lists.
10. World Bank, OECD, Eurostat.

## Corrections to the plan

- Central banks aren't all open: Fed and ECB yes; Bank of England and BIS non-commercial; IMF bans LLM training.
- CourtListener: bulk snapshot only (API 125 a day), quarterly full snapshot, bucket in us-west-2; October from GovInfo and supremecourt.gov.
- SEC full text is training-only; XBRL and metadata publishable.
- Keep FRED and ALFRED out.
- Owner provides more keys: api.data.gov (GovInfo, Congress.gov, FEC), BEA UserID, BLS v2 key, Census key, LegiScan account, Bundestag DIP key, identity-verified USPTO account. BLS wants an email in the User-Agent like the SEC.
- White House: use the sitemap plus GovInfo presidential documents.
- Parliaments differ: UK Open Parliament Licence; Canada non-commercial; Australia no-derivatives; UN non-commercial.
- Personal data: FEC donor names not for commercial use; DOJ releases and dockets name private people.
- Add the Congressional Record via the GovInfo API, CRS and GAO; use the UK Sanctions List.
- Federal Register: query by day. Eurostat's old HICP set froze in Feb 2026. Drop EUR-Lex procurement notices.
- The US general election (Nov 3) and the December FOMC fall after the window: after-cutoff probes and the weekly refresh.
