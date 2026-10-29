# Software, developer tools and AI industry sources

Research agent report, checked Oct 29, 2026 with header checks, single free API calls, GitHub repo metadata and page reads. No sign-ups, payments or BigQuery queries. BigQuery is on-demand at about $6.25/TiB (Google credits). Not yet rechecked by hand.

| Source | 2026 data | Access and volume | License: train / redistribute | Verdict |
|---|---|---|---|---|
| GH Archive (data.gharchive.org, BigQuery `githubarchive`) | Yes but degraded: hourly files shrank from 34 MB in Jan to 4.3 MB on Oct 28; stars about 1% of expected; push events lack commit summaries since 2025-10-07 | ~100-150 GB gz for the window; BigQuery 1-3 TiB with selected columns (~$6-20) | No data license; GitHub user content | Training-only, discovery only, never for counts |
| OpenDigger mirror | From 2026-09-06, about 8x GH Archive's events | Hourly gz | Not stated | Training-only backfill |
| GitHub REST and GraphQL | Live | 5,000 requests or points an hour per token; releases for 2,000 repos take a few thousand calls | AUP allows research with open results; changelogs follow repo license | Publishable for permissive repos; release bodies training-only |
| Software Heritage | No 2026 export | S3, ~30 TiB | Contents need an agreement and an open model release | Skip |
| The Stack v3 | Cutoff 2025-08-07 | 3.6T tokens | ODC-By, opt-out honored | Pre-window baseline to dedupe against |
| deps.dev (BigQuery `deps_dev_v1` and API) | Yes (338 react versions since Jan 4; 19.3.0 on Sep 9) | 7 ecosystems; BigQuery under $50 | CC BY 4.0 | Publishable |
| PyPI BigQuery | Not checked | ~9 TiB for the window (~$55) | Unstated | Aggregates and facts |
| ecosyste.ms | 100 registries refreshed Oct 28-29 (npm 6.0M packages, Go 2.5M, Docker Hub 1.0M, PyPI 946k, HF 910k, NuGet, Maven, crates, RubyGems) | API | CC BY-SA 4.0 | Publishable, share-alike; covers Docker Hub, Homebrew, Packagist |
| npm replicate, crates.io and RubyGems dumps, Go index | Live | npm's changes feed no longer carries documents (4.5M separate fetches); crates 1 req/s | No data license; READMEs per package | Facts only |
| Docker Hub | No dump | | | Skip; use ecosyste.ms and docker-library/official-images |
| Homebrew | formula.json updated Oct 29 | JSON | BSD-2 | Publishable |
| OSV | all.zip updated Oct 29 | GCS | Per source; Chainguard/Wolfi CC BY-NC-ND | Publishable without NC-ND |
| GitHub Advisory DB, cvelistV5, CISA KEV, NVD | All updated Oct 28-29 | git, API | Advisory DB CC BY 4.0; NVD US government | Publishable; NVD enriches only priority CVEs since Apr 15, 2026 |
| Hugging Face Hub | Trending: DeepSeek-V4.1-Flash, MiniMax-M3.1-Flash, LFM3-1.7B; librarian-bots card dumps (885k model, 681k dataset) Oct 23; hub-stats Oct 29 | API 500 or 1,000 calls per 5 min | Each card per repo license | Permissive cards publishable |
| Framework docs | Checked | MDN CC BY-SA 2.5 (code CC0); Python PSF-2; CC BY 4.0: TypeScript, react.dev, Kubernetes, github/docs, .NET, Azure, ai.google.dev; MIT: Next.js, Angular, Deno, LangChain; Apache: docker/docs; BSD: Django, Go. No open license: Tailwind, svelte.dev, Vue (unclear), Anthropic, AWS, Apple | | Open ones publishable, rest training-only |
| endoflife.date | Python 3.15 (Oct 9), Node 26 (May 5), Go 1.26 and 1.27, Rust 1.93-1.99, Django 6.1, Angular 22, Kubernetes 1.36 and 1.37, Ubuntu 26.04 and 26.10 | API | MIT | Publishable, ideal for probes |
| AI lab release notes | Google changelog Jan 8 to Oct 27; Anthropic notes (no license); OpenAI site 403 and its terms ban automated extraction | Pages | SDK repos Apache or MIT | Google and SDK changelogs publishable; Anthropic training-only; OpenAI site skip |
| Open-weight model cards | Active | HF | DeepSeek MIT; Qwen, Mistral Apache; Llama, Gemma custom | Publishable when permissive |
| models.dev | 233 providers, 8,918 models, 5,674 released since Jan 4 | JSON | MIT | Publishable (pricing, release dates) |
| OpenRouter models API | 283 of 456 created since Jan 4 | API | Terms ban scraping and data use | Skip, cross-check only |
| LMArena leaderboard-dataset | Updated Oct 29, full history | HF | CC BY 4.0 | Publishable |
| Epoch AI data | Updated Oct 29 | ZIP | CC BY | Publishable |
| Artificial Analysis | Free API, 1,000 a day | API | Attribution; redistribution needs permission | Training-only facts |
| SWE-bench family | SWE-bench Pro (Sep), SWE-rebench-V2 (Oct 1, plus 126k PRs set), SWE-bench-Live, Terminal-Bench | HF, GitHub | MIT, CC BY 4.0, Apache | Publishable evals; Open LLM Leaderboard retired |
| Hacker News | Firebase API live; ~3.5-4M items in window (estimate) | API | YC terms ban scraping; users own text | Training-only via the API |
| Developer surveys | Stack Overflow 2026 survey CSV published | CSV | ODbL / DbCL | Publishable, share-alike |
| Exa | $7 per 1,000 searches plus $1 per 1,000 pages | | Terms not shown | Targeted gap-filling only (about 45-50k searches for $400) |

## Code that uses 2026 versions, legally

1. Find candidates from deps.dev dependents of 2026 versions (Next 16.x, React 19.3, Python 3.15), GH Archive or OpenDigger events, and SWE-rebench-V2 PRs.
2. Only permissive licenses at the commit (MIT, Apache, BSD, ISC, 0BSD, CC0), from GitHub's license field plus ScanCode. No license means all rights reserved.
3. Honor the BigCode opt-out list. Shallow, blobless clones since 2026-01-04 from AWS.
4. Keep commit message, diff, license, SHA and attribution on every record.
5. Dedupe against The Stack v3; scan for secrets and personal data.
6. Build and test against the pinned versions.

## Top 10

1. Open-licensed docs repos plus endoflife.date.
2. ecosyste.ms plus deps.dev.
3. Permissive 2026 commits, SWE-rebench-V2 and SWE-bench-Live.
4. CHANGELOG.md and releases for top repos via GraphQL.
5. Epoch AI data.
6. LMArena leaderboard-dataset.
7. models.dev.
8. HF hub-stats and card dumps.
9. Google changelog and lab SDK changelogs.
10. OSV, GitHub Advisory DB, cvelistV5, KEV.

## Corrections to the plan

- GH Archive is degraded in 2026 and has no commit messages after Oct 7, 2025; use the GitHub API and git instead.
- npm metadata: use ecosyste.ms or deps.dev, not the replication feed.
- Docker Hub has no dump; use ecosyste.ms.
- NVD stopped enriching most CVEs in April 2026; use cvelistV5 and OSV.
- OSV's NC-ND data stays out of the public release.
- Docs carry several share-alike licenses; many big docs have no open license and are training-only.
- Only permissively licensed Hugging Face cards are publishable.
- OpenAI's terms forbid scraping its websites; use its MIT and Apache repos.
- Software Heritage's terms require an open model release.
- Add: Epoch AI, LMArena, models.dev, endoflife.date, 2026 SWE task sets, The Stack v3 as a dedupe baseline, the Stack Overflow 2026 survey (ODbL, separate from the dump restriction).
