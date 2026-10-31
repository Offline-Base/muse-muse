# Privacy and compliance plan

## Status, Oct 30 (evening)

Ethan chose: use Liquid for now and ignore Glimmer. So Phase 1 runs LFM3-VL-2B for every step, with no Glimmer download. Where the plan below says Glimmer, read LFM3-VL-2B. Built and tested: device-only mode, the toggles, more identifier kinds, holds and locks, the setup and Prepare pages, the raw-detail warning, receipts, the audit export, retention, one-command start and the compliance eval.

What measurement changed:

- A router on the 2B model scored 38 of 100 with heavy over-asking, so no model decides now. The user's policy decides, the model only labels requests, and the labels are checked against the request's words.
- The 2B name check let 10 of 200 invented results through with an off-roster name, counting 4 that came out after a simulated approval. A deterministic name-shape check fixed that: 0 leaks on a second sample of 200 that was not read while writing the rules.

Numbers for what ships, all on invented data:

| Measure | Result | Report |
|---|---|---|
| 200 items the rules were not written against | 0 leaks, 73.5% agreement, 90 approval requests, 2 shared that should have waited or stayed | eval/reports/device_only_unseen_200.md |
| The 100 items the rules were written against | 0 leaks, 81% agreement, 27 approval requests, 6 shared that should have waited or stayed | eval/reports/device_only_final.md |
| 42 private details, 16 clean sentences, rules alone | 2 lower-case details missed, 0 clean sentences changed | eval/reports/compliance.md |
| The same with the local model | 0 missed, 1 clean sentence changed | eval/reports/compliance_with_model.md |

Learning modes, measured on LFM3-VL-2B on Oct 30, all invented data. Rules in code stays the default on LFM. Prompt modes get measured again with Ethan's tuned Glimmer.

| Mode | 200 untouched items | Report |
|---|---|---|
| Rules in code | 73.5% agreement, 0 leaks, 90 approval requests | eval/reports/device_only_unseen_200.md |
| Prompt, stricter only | 42.5% agreement, 0 leaks, 36 approval requests (too many refusals) | eval/reports/device_only_unseen_200_tighten.md |
| Prompt, model decides | 41.5% agreement, 0 leaks, 30 approval requests (too many refusals) | eval/reports/device_only_unseen_200_decide.md |

Five simulated nights, with no practice data, on 100 unseen items:

| Mode | Before dreaming | After dreaming | Report |
|---|---|---|---|
| Rules in code | 74% agreement, 44 approval requests | 74% agreement, 44 approval requests (3 rules learned) | eval/reports/nights_device_rules/nights.md |
| Prompt, stricter only | 42% agreement, 12 approval requests | 42% agreement, 8 approval requests (0 rules learned) | eval/reports/nights_device_tighten/nights.md |

So dreaming does not lower the prompts on this setup yet. Most requests are ones the policy wants asked, so the next lever is the policy's defaults.

Local fine-tuning: the `local_lora` mode, the adapter loading and the training file export are in, but the on-device training script is not built, and nothing has been trained or tested, on Ethan's Oct 30 instruction not to test Glimmer fine-tuning yet. Decision models (d1-2B first) are proposed for request labels only and not started.

Ready for Ethan's tuned Glimmer: `scripts/plug_in_model.py` checks the GGUF and sets `.env`, `scripts/start.sh` loads one copy of it with LFM for scans and search, `scripts/device_smoke.py` runs Muse's tools with private-value checks, and `scripts/compare_modes.py` scores each router mode. All of it was rehearsed on Oct 30 with the LFM file standing in as the model, through the app and every mode, with no private values in any tool output. It has not run on a real Glimmer file. The stand-in's agreement numbers mean nothing and were deleted; about a third of its prompt-mode calls failed, and the server log for the same stand-in shows answers cut off, because the Glimmer path doesn't turn off LFM's thinking. Watch "Errors or fallbacks" in the first real run.

Tool path on LFM (eval/reports/device_smoke_lfm.md): 24 essays graded in about 35 seconds, with no private values in any tool output, with and without FERPA. About 1 grading result in 10 stays on the device because LFM's generated feedback used a never-share word ("allergy"). That is the rule working, and the feedback files are still written on the device.

Open:

- Tag rotation (2.6) is built on the lane/b-privacy branch: tags change every day, an old tag restores for 36 hours after its day ends or it was last sent, and the device restores only tags it sent. It is daily, not per chat, because no chat ID reaches the device, so results from the same day can still be linked. FERPA counts multiple releases, so linking within a day is a known gap. Not yet on the live app: the first start rewrites tagmap.json as version 2, after copying it and base.db.
- The tag map is cleared on the retention schedule (docs/RETENTION.md) on the same branch: stopped tags hourly with no toggle, old values not on the roster under COPPA and GDPR.
- The Prepare page works on the laptop only, not the phone.
- 90 approval requests in 200 is not yet seamless, and dreaming didn't lower it (see above). Grading has not been measured on LFM.
- The local model's summaries can add details the result doesn't state. A live check on Oct 30 added a "typical range", and the prompt now forbids that, but it is not measured.
- The leak number covers names and identifiers listed in the invented items. It does not measure re-identification from context, and nothing has had outside or legal review.
- Meta tooling: no Meta model runs on the device now (see docs/NEXT_STEPS.md).

Written Oct 30, 2026. Goal: a user never has to think about ZDR or where their documents went, with toggles for FERPA, COPPA and HIPAA. Submission is due Nov 4; we submit by noon ET. This plan takes priority over the "Before submitting" list in docs/NEXT_STEPS.md where they overlap.

## What we promise

"Your documents and the models that read them stay on your device. Only tagged results leave, and you get a receipt for each one."

We do not promise that a user can't get in trouble, and no page says "FERPA compliant" or "HIPAA compliant". Use "built for FERPA workflows". Three limits stay true whatever we build:

- What someone types into Muse reaches Meta before the connector sees it.
- A toggle cannot create a contract. Whether a school or clinic may use Muse at all is their decision.
- Automatic de-identification can miss things. We measure the misses and publish them.

## Why ZDR cannot be the answer

From the pages read on Oct 30 ([Muse Privacy Policy](https://muse.ai/privacy), [Meta AIs Terms](https://www.facebook.com/legal/ai-terms), [Connector Terms](https://platform.muse.ai/terms)). The general Meta Privacy Policy was not read.

- Training on Muse interactions is on by default, and connector data follows the same setting under Data controls.
- Deleting a message, thread or account may not delete Meta's copy, and Meta may review chats, sometimes with people.
- These pages give no retention period, no ZDR option, no BAA and no FERPA terms. Under-13s cannot use Meta's AIs.

So we plan as if everything that reaches Muse is kept.

## What the code does today

| Finding | Where | Effect on the plan |
|---|---|---|
| Cloud calls are refused unless the workspace has a `.synthetic` marker | base/local_llm.py:372, base/config.py:293 | A real, unmarked folder cannot use the cloud router. Real use needs Glimmer on the device, so Phase 1 comes first. |
| demo/ has the marker and also holds a real resume, so the marker lets that file through | demo/ | Device-only mode removes the cloud path without moving the file. |
| A failed name or topic check holds the result | base/egress.py:219, :230 | Already fails closed. Keep it. |
| A failed router call becomes "ask the user", and Always approve then shares it | base/router.py:283, base/egress.py:272 | New gap: a router outage skips the router's judgment. Fix in Phase 1. |
| Tagged kinds: names, phone, email, SSN, card, student ID, street address, date of birth, user terms | base/guard.py:57 | Far short of HIPAA Safe Harbor. Phase 2. |
| One tag per value, for good, on each device | base/guard.py:1155 | Results can be linked over time. FERPA counts multiple releases. Phase 2. |
| The connector does not use a chat or session ID | base/connector/server.py | "New tags per chat" may not be possible. Needs a spike. |
| The audit table holds labels only; decision rows hold tagged text | base/connector/audit.py, base/approvals.py | Good base for receipts. |
| The approval page binds 127.0.0.1 | CLAUDE.md | The "Prepare my question" page works on the laptop only for now, not the phone. |
| FileVault is on; no Glimmer GGUF on this laptop; 18 GiB free disk | checked Oct 30 | Glimmer Q4_K_M is 17 GB, so disk must be freed first. |

## Decisions

Item 1 was answered on Oct 30: no Glimmer for now. The others went ahead as assumed here when Ethan said to build.

1. **Download Glimmer Q4_K_M to this laptop.** Answered: no, use Liquid for now.
2. **Remove the Jetson fallback in device-only mode.** This reverses the Oct 29 "keep as is", because that fallback is the one route that can send raw text off the laptop. Assumed: yes.
3. **Regulated toggles lock Always approve, real names, never-redact words and identifier opt-outs.** Assumed: yes. Always approve stays available with every toggle off.
4. **Redeploy the landing page with corrected claims.** Assumed: yes, in Phase 0.

## Phase 0: today, Oct 30

- Restart the LFM server and embedder (both down at last check); confirm the relay client is connected.
- Turn Always approve off until Phase 1 task 1.3 lands.
- Fix site/index.html ("Muse Glimmer for every private step") and redeploy.
- Free the disk space and download Glimmer.

## Phase 1: device-only and fail closed, Oct 30 to 31

| # | Task | Files | Done when |
|---|---|---|---|
| 1.1 | Add `DEVICE_ONLY=1`. Startup fails unless Glimmer is `llama_server`; the Jetson role and OpenRouter clients are never built. The existing cloud check stays exactly as it is. | base/config.py, base/services.py, docs/CONTRACTS.md | Tests show no cloud client exists in this mode |
| 1.2 | Run the router on local Glimmer. Start only the router server (8082) when `PRIMARY_MODEL=lfm`, since start.sh would otherwise load a second 17 GB copy for the answer port. | scripts/start.sh, base/services.py | Router answers on 8082; memory use recorded |
| 1.3 | Always approve must not apply when `route.source == "fallback"`. | base/egress.py | Test: router outage plus Always approve gives "waiting", not "shared" |
| 1.4 | Network test: patch socket connections to allow loopback only, then run search_documents, ask_device and run_private_task against stub local servers. | tests/test_no_egress.py | Any non-loopback connection fails the test |
| 1.5 | When a local model is down, tools return "the device is starting, nothing was shared", and the page shows it. | base/connector/server.py, base/ui_app.py | Test with each model down |
| 1.6 | Measure: rerun the eval on the device-only setup and record router speed. | eval/run_eval.py, eval/reports/device_only.md | Report holds numbers and the command |

**Go or no-go on Oct 31:** ship device-only if the router's eval shows no more leaks than the cloud report and p95 latency is under 60 seconds plugged in. Otherwise the demo runs on invented data with the cloud router, the regulated toggles are disabled in that setup, and the video says so.

## Phase 2: toggles and stronger tagging, Oct 31 to Nov 1

| # | Task | Files | Done when |
|---|---|---|---|
| 2.1 | Add `Controls.profiles` (`ferpa`, `coppa`, `hipaa`). Several can be on and the strictest rule wins. Enforce locks on the server, not only in the page. A broken file still means the strict default. | base/compliance.py (new), base/controls.py | Tests cover each lock and each combination |
| 2.2 | Add identifier kinds, used only when a profile asks for them, so default output stays the same: `place` (ZIP, City ST, towns), `date`, `age` (over 89), `org` (employers, schools), `record` (medical record, plan, account, license, vehicle, device), `url`, `ip`. `guard.leaks` checks the same kinds. | base/guard.py | Existing guard tests unchanged; each new kind tested, in both tagging and the leak check |
| 2.3 | Extend the local model's name pass to find places and organizations. Add a strict rule: any capitalized phrase not on the stoplist gets tagged, so errors lean toward removing too much. A failed pass holds the result, as it does now. | base/local_llm.py, base/guard.py | Tested on invented documents |
| 2.4 | Add a compliance check before the router. It holds results that describe fewer than 10 people (our default and configurable, not a legal number) and any image. Each hold gives a plain reason. | base/egress.py, base/compliance.py | All tools that release results are tested, including ask_device parts |
| 2.5 | Add the Compliance section at the top of Controls: toggles, locked controls greyed out, and a plain note on what each toggle can't do. Follow docs/UI_STYLE.md. | ui/templates/controls.html, base/ui_app.py | Browser check; no "compliant" wording |
| 2.6 | Spike, one hour: can tags rotate per chat? If the connector can't identify chats, rotate daily and keep old tags restorable. | base/guard.py, base/connector/server.py | Built under the FERPA profile, or recorded as a known gap |

What each toggle does:

| Toggle | Turns on | Stated limit |
|---|---|---|
| FERPA | All kinds in 2.2, small-group holds, tag rotation if built | The route is de-identified results only. Meta is not a "school official", because that needs [the school's direct control](https://studentprivacy.ed.gov/sites/default/files/resource_document/file/Vendor%20FAQ.pdf). The school makes the [reasonable determination](https://www.ecfr.gov/current/title-34/subtitle-A/part-99/subpart-D/section-99.31). |
| COPPA | Strictest handling for data about under-13s, including government IDs and biometrics, plus a local [retention schedule](https://www.federalregister.gov/documents/2025/04/22/2025-05904/childrens-online-privacy-protection-rule) | Children still cannot use Muse. |
| HIPAA | The [Safe Harbor list](https://www.hhs.gov/sites/default/files/ocr/privacy/hipaa/understanding/coveredentities/De-identification/hhs_deid_guidance.pdf): all date parts except the year, geography below state level, images held, also applied to relatives, employers and household members | No BAA, and removing the listed identifiers is not always enough per HHS. Muse [cannot give medical advice](https://platform.muse.ai/terms). |

## Phase 3: seamless, Nov 1 to 2

| # | Task | Files | Done when |
|---|---|---|---|
| 3.1 | One command starts everything, and a login item restarts it after sleep. Warn when on battery (about 12 times slower). | scripts/start.sh, scripts/install_login.sh (new) | Cold start to a working Muse call with one command |
| 3.2 | Setup page: "Who are you protecting?" picks the toggles. Checklist: FileVault on, models healthy, device paired, Muse training turned off. We can't read Muse's setting, so the user confirms that one. | ui/templates/setup.html (new), base/ui_app.py | Fresh BASE_HOME lands here first |
| 3.3 | "Prepare my question" page: type with real names, get a tagged prompt to copy, using the device's tag map. Laptop only for now. | ui/templates/prepare.html (new), base/ui_app.py | Tested; never logs the raw text |
| 3.4 | Warn when Muse's tool call carries a raw identifier: tell the user in the result and on the page that Muse has already seen it. Check before tags are restored, so a tag Muse passes back doesn't trigger it. | base/connector/server.py | Tests for both cases |
| 3.5 | Receipts: on each decision row, store kinds and counts removed, checks run, models used, toggles on, destination, and a hash of the released text. Show them in History and export as CSV. Never store real values. | base/approvals.py, base/egress.py, ui/templates/history.html | Test: seeded real values never appear in the export |
| 3.6 | Retention: delete old decision rows, finished files and jobs on a schedule (default 90 days under COPPA, editable). Write the policy down. | base/approvals.py, base/dreaming/night.py, docs/RETENTION.md (new) | Test with aged rows |

## Phase 4: proof and claims, Nov 2 to 3

- **Compliance eval:** add `eval/compliance.jsonl`, invented documents covering every identifier kind, plus `eval/run_compliance.py`, which reports misses per kind and per toggle in eval/reports/compliance.md. Structured kinds (dates, ZIPs, URLs, IPs, labeled numbers) must have zero misses. Model-found kinds (towns, employers) get reported as measured.
- **Prompt count:** record how often the eval asks the user, per toggle, so "seamless" has a number.
- **Claims:** update site/index.html, README, docs/RUBRIC.md, docs/DEMO_SCRIPT.md, docs/MUSE_SETUP.md, CLAUDE.md and docs/NEXT_STEPS.md to match what shipped, using only numbers in eval/reports.
- **Demo defaults:** Always approve off and no names-off folders.
- **Video, Nov 3:** turn on FERPA, ask a question, show a tagged answer, a held small-group result and its receipt, then run the no-network test on screen.
- **Freeze on Nov 3 at 9 PM ET.** After that, only fixes to what the video shows.

## If time runs short

Cut in this order, first cut first:

1. Tag rotation (2.6), recorded as a known gap
2. Retention (3.6), but keep the COPPA toggle's limit honest
3. Login item (the second half of 3.1)
4. Prepare page (3.3)
5. Strict capitalized-phrase rule (part of 2.3)

Never cut 1.1, 1.3, 1.4, 2.1, 2.2, the compliance eval or the claims fix.

## After the hackathon

- Have a lawyer review the claims, toggle text and a district agreement template.
- Ask Meta in writing whether regulated data is allowed in connector results, whether "improve Muse" in Terms 3.1(c) includes training, and whether a BAA or no-training option exists. Read the general Meta Privacy Policy.
- Phone access to the Prepare page through an authenticated relay route.
- Installer, then the official connector steps in docs/NEXT_STEPS.md.
- Research more toggles: NY Ed Law 2-d, California SOPIPA, GDPR, GLBA.
- Plug in the tuned Glimmer from the Muse Muse work when it beats base Glimmer on the same evals. Nothing in this plan waits on it.
