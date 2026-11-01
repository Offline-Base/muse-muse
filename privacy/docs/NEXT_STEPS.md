# Next steps

Written Oct 30, 2026, after the Oct 29 build session (local LFM models, hybrid search, PDF reading, always-approve, ask_device, privacy controls, the approval page restyle). What we recommend doing next, in order. Submission is due Nov 4 at 9 PM ET; we submit by noon.

For device-only mode, the FERPA, COPPA and HIPAA toggles and the dated schedule, follow docs/COMPLIANCE_PLAN.md. It takes priority where the two overlap.

## What changed on Oct 29, and why it matters

- Every model step but the privacy router now runs on Liquid's LFM3-VL-2B on the laptop (`PRIMARY_MODEL=lfm`), with LFM3-1.7B on Ethan's Jetson (through the Jetson gateway) as the fallback. The router stays on Muse Glimmer (OpenRouter), because the 2B model shared results that Glimmer asks about first.
- Search ranks ~800-character passages by keyword (BM25) and meaning (EmbeddingGemma 2 on the laptop), and the local model rewrites queries. ask_device is a second way to ask: the device's model splits a request into parts, keeps searching, and returns one finished answer with quotes it checked against the passages.
- The approval page has Always approve and a Controls tab (what gets redacted, which folders Muse can see).

Most eval numbers in eval/reports were measured with Glimmer for every step. They do not describe the current default. For the device-only setup use eval/reports/device_only_unseen_200.md, device_only_final.md and compliance*.md.

## Before submitting (by Nov 4, noon)

1. **Decide the model story.** Oct 30: Ethan chose Liquid for now, so no Meta model runs on the device, and the Meta tooling is the Muse app, Spark's invented data and the earlier Glimmer measurements. The rubric gives 25% to "Use of Meta AI Tooling", so this is the weaker story for that criterion, and the Official Rules require building with Meta AI products. Revisit before submitting. Options, best first:
   - Run Glimmer on the device for the reasoning steps (grading, the ask_device answer and combine), with LFM for tagging, search and scans. Needs the laptop to hold Glimmer Q4_K_M (17 GB) in memory; check RAM first.
   - Keep LFM first and present Glimmer as the privacy router, the judge of what leaves. Honest, but the weaker tooling story.
   - Go back to Glimmer everywhere (`PRIMARY_MODEL=glimmer`). The measured numbers then hold again.
2. **Fix every public claim to match the choice.** The landing page (site/index.html, "Muse Glimmer for every private step"), the README, docs/RUBRIC.md, docs/DEMO_SCRIPT.md and CLAUDE.md's hackathon section still say Glimmer runs every private step. The landing page is public on Vercel, so fix it first.
3. **Measure what we ship.** Re-run the eval for the chosen setup and write the numbers to eval/reports with the commands. Add a small labeled set for ask_device and passage search (questions with known answers, mid-document and paraphrased), since the Oct 29 checks were quick smoke tests, not reportable numbers.
4. **Set demo defaults.** Always approve off, no folder with "Send real names", every folder visible. Move Ethan's own files (the resume PDF and the screenshot) out of `demo/`, which is marked as invented data, before any recording or public repo.
5. **One command to start the device.** Today it is five processes: the LFM server, the embedder, `python -m base`, the relay client and `caffeinate`. Fold them into scripts/start.sh, and keep the laptop plugged in: on battery the local model runs about 12 times slower (16 vs 190 tokens a second).
6. **Record the video** from a fresh Muse chat with the test script in docs/MUSE_SETUP.md, both modes (search_documents, ask_device) and one held result.
7. **Housekeeping:** make the repo public (it is private), confirm the track and entity, rotate the OpenRouter key and the Jetson gateway key (it was pasted into a chat), and keep relay/wrangler.jsonc uncommitted.

## After the hackathon: the official Muse connector

The Muse Connector Platform (platform.muse.ai/docs, read Oct 30) asks for business verification, a data processing questionnaire, integration credentials ("OAuth client credentials or an API key"), per-tool documentation, a test account that stays up through review, and a three-stage review (risk assessment, tool review, end-to-end QA). There is no published timeline. Recommended order:

1. **Ship a device-only mode for the catalog version:** Glimmer through llama-server for the router and reasoning, no OpenRouter, no gateway fallback. It makes the data processing answers simple: documents and models stay on the device, Muse gets tagged results through the relay.
2. **Relay changes:** pre-registered OAuth client credentials for Meta, a read-only scope users can choose on the Link your device page (the guidelines ask for this "where possible"), a custom domain on the organization's Cloudflare account, monitoring, and a clear tool result when a device is offline (today it is an HTTP 503).
3. **An installer:** one download that starts the services at login, fetches the models and updates itself, for the laptop and the Jetson.
4. **A reviewer device:** a machine with invented data that stays online and paired through review, with written steps.
5. **Paperwork:** tool documentation (from docs/CONTRACTS.md), the data processing questionnaire, a privacy policy and terms written for teachers and student data (FERPA; a data processing agreement template for districts), support and security contacts, and a 48-hour incident process (vendor-incident@meta.com).
6. **Risky controls:** keep "Send real names" and Always approve off by default and explain them in the docs, or leave them out of the catalog build. Reviewers will look at both.
7. **Optional:** list the server in the public MCP Registry so other MCP clients can find it.

## Known gaps

- The 2B local model is uneven: ask_device answered 11 of 12 smoke-test questions; one run missed the resume part. The prompt now keeps details like "in the resume" when splitting a request.
- When the laptop model is down, the name check falls back to the Jetson gateway with raw text. Ethan chose to keep that on Oct 29; the device-only mode above removes it.
