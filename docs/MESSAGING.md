# What we can say

This is for whoever writes the submission, the video and the posts. Written Nov 2, 2026.

It comes from three deep-research reports the owner ran in a browser: Meta's direction, evidence for the problem, and a short third one. I checked them against this repo's copy of Meta's docs (`content/meta-docs/`) and against web search. A line counts as proven only if it's marked Checked below.

Nov 2, branch tg-submission-kit: every outside line below was opened on its primary source and is now Checked, with its URL. The Johns Hopkins row is checked across news outlets, not the hospital's own statement.

## Quotes and facts

| Line | Source | Status | Use it for |
|---|---|---|---|
| "you own the weights, the runtime, and the data" | Meta's Muse Glimmer docs | Checked, word for word: `content/meta-docs/pages/muse-glimmer.md` line 5 | The "own it" idea, credited to Meta, not claimed as ours |
| "Run Muse Glimmer locally and escalate to Muse Spark only after you approve the text the tool is about to send" | Meta cookbook, "Local agent that asks first" | Checked: `content/meta-docs/pages/cookbook/glimmer-api-agent.md` | Not a pitch line. It's the closest thing Meta ships to Muse Privacy; see point 1 below |
| "Compare your fine-tuned model against the base model on a held-out test set before deploying. Track both your task metric and a general-capability benchmark so you catch regressions from over-fitting." | Meta's Glimmer post-training docs | Checked: `content/meta-docs/pages/muse-glimmer/post-training.md` line 371 | Shows our blind check follows Meta's own advice. We do the first half only; see Gaps |
| Meta's smallest Glimmer files are 16.8 GB (Q4_K_M) and 19.7 GB | Meta's quantization docs | Checked: `content/meta-docs/pages/muse-glimmer/quantization.md` lines 11 to 12 | Shows how far below Meta's smallest file our 8 GB board run goes |
| Meta names LM Studio, Ollama and Unsloth as ways to run Glimmer | Meta's Glimmer docs | Checked: `muse-glimmer.md` lines 36 to 42 | Why "a UI for fine-tuning" isn't new |
| "We will build a fully private mode where even Meta cannot see or grant access to your information." | Mark Zuckerberg, "The Future is for Everyone", Aug 10, 2026 | Checked Nov 2 on the letter itself: https://www.meta.com/thefutureisforeveryone/ . An earlier sentence in it starts "We believe that people should have a fully private mode for personal agents where even Meta or any other service provider" (cut there by the fetch tool). Read through a fetch tool that renders the page; plain curl gets an error page, so look once by eye before filming | Meta's own aim for private agents. Never say Muse Privacy is that mode or delivers it |
| "People are starting to be able to manifest ideas themselves without having to raise money or build large teams." | Zuckerberg, same letter | Checked Nov 2, same URL, same way. The sentence before: "Everyone will have powerful tools to create new businesses and the economy will become more entrepreneurial." The one after: "Many ideas that would have been too hard or expensive to try before will now be possible." | The video's opener and the write-up's problem line, credited to him |
| Johns Hopkins Bayview notified 3,182 patients after a worker uploaded a patient spreadsheet to an AI tool the hospital hadn't approved. The upload was found Sept 21, 2026 | The hospital's statement, reported by WMAR, HealthExec and the Baltimore Banner | Checked across outlets, which differ on what was in the sheet | Muse Privacy's "why". Say "a patient spreadsheet" and "3,182 patients", nothing more about its contents |
| "all 12 selected agencies that allow the use of generative AI reported that the agency limits or restricts that use in some capacity. For example, GSA and DHS limit commercial generative AI use to publicly available information only" | GAO-25-107653, "Generative AI Use and Management at Federal Agencies", July 2025 | Checked Nov 2 in the report's text: https://files.gao.gov/reports/GAO-25-107653/index.html (Data security). Note "selected" and "that allow": it is 12 agencies GAO picked, not every agency | Muse Privacy's "why". Say "all 12 agencies GAO selected that allow generative AI restrict it", not "every federal agency" |
| Judging weights: Impact (30%), Use of Meta AI Tooling (25%), Technical Depth & Execution (20%), Demo (25%). Demo covers "whether the Project has a working, impressive demo, whether the product holds up live, and the quality of the demo video." | The Official Rules ("Hackathon Terms & Conditions and Event Waiver"), Meta and Cerebral Valley | Checked Nov 2, word for word in the rules text: https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver (the page loads by script; the text is in its HTML). Impact also asks "whether it fits one of the problem statements" | Planning: what the write-up and video must cover. Not a quote for the video |
| "Show us what becomes possible when these models meet the real world." | The event page, Push the Frontier theme | Checked Nov 2: https://cerebralvalley.ai/e/meta-ai-developer-hackathon . The theme in full: "Push the Frontier. Use Meta's models to tackle challenges in software, robotics, manufacturing, energy, materials and beyond. Give a machine a new capability, accelerate a scientific experiment, or unlock a better way to understand and control a physical system." | Framing the Jetson act and the theme line in the write-up |
| "The access decision does not depend on the agent behaving as intended." | Meta Engineering, "PrivacyLib: Privacy Controls at the Data Access Boundary", Oct 27, 2026, by Sai Nagabhairava, Hannes Roth, Na Chen, Peter Prelich and Jonathan Bergeron | Checked Nov 2 in the post: https://engineering.fb.com/2026/10/27/security/privacylib/ (section "PrivacyLib Controls for AI Agents"). The sentence before: "Policy Zones applies this check even when the agent chooses a tool that its developer did not anticipate." | Muse Privacy's design: enforce at the exit, outside the model. Credit Meta Engineering and never imply they reviewed Muse Privacy |
| "The deeper principle is straightforward: keep the complexity in text files that are readable by both humans and agents, rather than fine-tuned model weights." | Meta Engineering, "An Organizational Second Brain: Building an AI That Learns From Experts", Sep 2, 2026, by Shaurya Sengar, Jason Nawrocki, Jay Shah and Prashant Kommireddi | Checked Nov 2 in the post: https://engineering.fb.com/2026/09/02/ml-applications/organizational-second-brain-ai-learns-from-experts/ . The Aug 11, 2025 date seen earlier belongs to a different post listed on the same archive page | It argues against putting an organization's knowledge in weights, and the knowledge run (r30b) did exactly that. Not used in the video. If a judge asks: the one-sentence flow tunes a task's behavior, and r30b was an experiment in knowledge |

## Edge facts, Nov 2

For the edge track (docs/EDGE_PLAN.md). Each page below was opened on Nov 2, 2026 on branch tg-edge-copy, through a fetch tool, and a row is Checked only where its words were read on that page. Every freezer incident is "suspected": none is a confirmed cyberattack, and no group has claimed one. These are background for the write-up and posts. The video doesn't use them unless the owner asks, and nothing here may be tied to the app as if it would have stopped anything.

| Line | Source | Status | Use it for |
|---|---|---|---|
| Pepco said the outage came from "an event at our I Street Substation in the Foggy Bottom area of the District", leaving "about 1,100 customers without power in Northwest D.C." | WTOP, "Power outages in Downtown DC as Pepco deals with substation issue", Nov 2, 2026, by Jessica Kronzer | Checked: https://wtop.com/dc/2026/11/power-outages-in-downtown-dc-as-pepco-deals-with-substation-issue/ | Why a cloud can be out of reach. Never call it an attack |
| Pepco: "At this time, there is no indication of foul play." | Same WTOP story, from a Pepco email | Checked, same URL | Say it whenever DC comes up |
| A State Department line about its own buildings losing power | A reporter's post on X, seen only second-hand | Not checked. WTOP doesn't mention the State Department | Don't use |
| "Supermarkets across Europe were hit by suspected cyberattacks" | Bloomberg, "Supermarkets Across Europe Report New Suspected Freezer Hack", Nov 2, 2026, by Charlotte Hughes-Morgan and Christopher Jungstedt, reprinted by Claims Journal ("Copyright 2026 Bloomberg") | Checked on the reprint: https://www.claimsjournal.com/news/national/2026/11/02/341078.htm | The Nov 2 news, always with "suspected" |
| Belgium: an "IT incident" in a number of Delhaize shops; Carrefour Belgium said "15 of its 700 outlets are impacted"; Spar said refrigeration in "around five of its stores was hit" | Same Bloomberg reprint | Checked, same URL | Store counts, quoted as given |
| Ireland: "a cyber incident has affected refrigeration systems in 13 of its SuperValu sites" | Same Bloomberg reprint | Checked, same URL | Store counts |
| Sweden: "Coop has seven affected stores", confirming a hack. ICA said "a limited number of stores were affected" without confirming a cyberattack; at one ICA store "the freezers' temperature has been raised to 50C (122F)", and that store said it suspects a hack | Same Bloomberg reprint | Checked, same URL | Why the drill data has a "setpoint pushed toward 50 C" case. Say "one store reported", not "ICA was hacked" |
| Finland: some Kesko stores "experienced temperature anomalies overnight", and an IT incident is "not ruled out" | Same Bloomberg reprint, from Kesko's head of corporate security | Checked, same URL | Store counts |
| Estonia: Selver's only store still on an "older type of Danfoss refrigeration control system" had the problem, fixed in minutes | Same Bloomberg reprint | Checked, same URL. The story links the store to the older system; it doesn't say the system caused it | Store counts |
| A Danfoss spokesperson said "the incidents across Europe involved its products as was the case in France in October." "No group has publicly claimed responsibility for the hack." | Same Bloomberg reprint | Checked, same URL | Who made the controllers; nobody has claimed it |
| "Those hit overnight were not on a secure network and still used a default password, the spokesperson said." (a Danfoss spokesperson) | DutchNews.nl, "Hackers tamper with fridges at 17 Dutch firms as attacks spread", Nov 2, 2026 (the URL slug differs from the headline) | Checked: https://www.dutchnews.nl/2026/11/albert-heijn-sister-chain-hit-as-fridge-hacks-spread-in-europe/ | Why a separate probe and a tampered-reading rule matter. Credit Danfoss's spokesperson, about the Dutch sites only |
| The Paris prosecutor's office opened an investigation into "the large-scale cyberattack affecting the refrigerators of several major food retail chains across France"; French outlets put it at "250 to 350 stores" | BleepingComputer, "Cyberattack shuts down refrigerators at French supermarkets", Oct 12, 2026 (updated the same day) | Checked: https://www.bleepingcomputer.com/news/security/cyberattack-shuts-down-refrigerators-at-french-supermarkets/ . This page does not mention ANSSI | France, October. The prosecutor's word "cyberattack" is theirs; still call it suspected |
| France's cybersecurity agency "has advised companies operating affected freezer models to immediately disconnect them from the internet". Danfoss told AFP most affected systems were "legacy" products with "outdated firmware". "More than 500 shops and supermarkets" | Al Jazeera, "French fridge fright: Why supermarkets have become target for hackers", Oct 13, 2026 | Checked: https://www.aljazeera.com/economy/2026/10/13/french-fridge-fright-why-supermarkets-have-become-target-for-hackers . The page says "France's cybersecurity agency", not "ANSSI" by name, so say "France's cybersecurity agency" | The agency's advice, credited to it |
| French store counts run from 250 to 700 | BleepingComputer (250 to 350), Al Jazeera (more than 500), Bloomberg (about 700) | Checked across the three pages above | Quote the range, never one number |
| CISA ICSA-25-140-03, "Danfoss AK-SM 8xxA Series (Update A)": improper authentication, command injection, external control of system or configuration setting. Mitigations include keeping control system devices "not accessible from the Internet". First published May 20, 2025, revised Aug 26, 2025 | CISA | Checked: https://www.cisa.gov/news-events/ics-advisories/icsa-25-140-03 . The advisory says no known public exploitation had been reported. Neither news page above names this advisory number, so don't say it is the cause | The known weakness in this controller family |
| "The late August malfunctions in the United States affected at least six commissaries." Headline: "Pentagon treating military base freezer malfunctions as suspected cyberattack, officials say" | Reuters, Oct 29, 2026, by Raphael Satter, AJ Vicens and Phil Stewart, reprinted by ThePrint | Checked on the reprint: https://theprint.in/world/exclusive-pentagon-treating-military-base-freezer-malfunctions-as-suspected-cyberattack-officials-say/3085028/ . "Suspected cyberattack" is in the headline; the body says "suspected hack" | US: "at least six commissaries", treated as a suspected cyberattack |
| "The Pentagon is investigating a suspected cyberattack behind freezer malfunctions"; "some six commissaries" | Nextgov/FCW, Oct 29, 2026, by David DiMolfetta, from one US official speaking anonymously | Checked: https://www.nextgov.com/cybersecurity/2026/10/pentagon-investigates-suspected-cyberattack-behind-military-freezer-failures/416926/ | A second outlet for the Reuters line |
| Llama 3.2's "lightweight, text-only models (1B and 3B) that fit onto edge and mobile devices" | Meta AI blog, "Llama 3.2: Revolutionizing edge AI and vision with open, customizable models", Sep 25, 2024 | Checked: https://ai.meta.com/blog/llama-3-2-connect-2024-vision-edge-mobile-devices/ (first Takeaways bullet). **Retired Nov 2:** the organizers ruled that Llama does not count as a Meta model in this hackathon (see the rules section below) | Don't use. The edge model must be a Meta model, such as Glimmer |
| Muse is out on iOS and Android, with Invite Codes, Muse for Mac, and Canada | A thread from the @Muse account on X, Nov 2, pasted by Ethan | Not checked on a Meta page. Look it up on a Meta page (meta.com or about.fb.com) before saying it | Point 4: Meta's own Muse now reaches phones and the Mac. Muse Muse products are web apps plus connectors, so test one connector in the Muse app on Mac before saying it works there (docs/HANDOFF.md) |

## Proven lines, Nov 3

Each was run and logged. Say it in these words or narrower, with its caveat.

| Line | Evidence | Caveat that goes with it |
|---|---|---|
| Meta's SAM 3.1 runs on a Jetson Orin Nano 8GB at 1.42 s a look | docs/BUILD_LOG.md, "Nov 3, 2026, 2:15 to 4 AM ET: the boards, checked for real" (first look 3.27 s, then 1.42 to 1.43 s, Meta's 1800 x 1200 truck photo, jetson-04) | Once warm, on Meta's sample photo. Not a camera feed or video |
| SAM 3.1's detector was tuned on an 8 GB board to find a new word, "muse": 0 to 38 of 38 held-out made-up images | Same entry, the jetson-03 table | Meta's SAM 3.1 already finds the mascot as "plush toy" (38 of 38). The held-out images are composites with no other toys |
| An edge build passed all 8 simulated outage drills in its own build sandbox | cold-room-watcher-2's product page (www.musemuse.dev/p/cold-room-watcher-2, "All 8 outage drills passed"), logged in docs/BUILD_LOG.md, "Nov 3, 2026, about noon ET: claim fixes" | Against a simulated board and a blocked cloud, not a real board. That product is hidden from the gallery: its tagline says it answers on the office board while its page says "Not connected to a board" |
| 18 apps built overnight on the test model, most for $0.17 to $0.40 | docs/BUILD_LOG.md, "Nov 3, 2026, 2 to 3 AM ET" and "Nov 3, 2026, 5:30 AM ET: target audit" | Always with the hands-on audit: 7 work, 9 have gaps, 2 broken (the list is in the claim-fixes entry; three of the 7 were called "works, with gaps"). The audit was agents using each app, not a person, so say "hands-on audit", not "by hand". 17 costs are logged; the legal case agent's isn't, and it shipped as partial, so never "each" or "all 18 passed" |
| A tune launched from the site itself: 19 of 20 held-out prompts, one H100, 32 minutes, $1.75 | Job 83ae46c8's public page; docs/BUILD_LOG.md, "Nov 3, 2026, about 10:30 AM ET: partner evals" | Only once DATA_RIGHTS.md Q1 to Q3 allow it (Contributor wrote its rows; its base is r30b). Judged by Spark 1.3 Contributor; doesn't compare with Wonder-judged runs |
| One-bit Glimmer ran on a Galaxy S25 at 1.94 tokens a second, Nov 1 | docs/GLIMMER_DEVICES.md; docs/BUILD_LOG.md, "Nov 3, 2026, 10:05 to 10:30 AM ET" | 3 of 3 simple questions, adb shell, not an app. Hugging Face weights, separate from the apps |
| `npm run drill` passes 11 of 11 with no key | docs/BUILD_LOG.md, "Nov 3, 2026, 10:30 AM ET: demos in check for judges" | On loopback with a fake model and a fake SAM service |

## What the rules say about the submission

Read Nov 2 in the Official Rules (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver) and on the event page.

- **Video length:** not stated in the rules or on the event page. A participant's repo on GitHub says 3 minutes, with no source. Plan for 3:00 at most, and check the portal's form when filling it in.
- **Submission fields:** not published. Projects go in through "Cerebral Valley's portal at https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit", which needs a sign-in. The rules ask the team's Representative to "identify all other team members in the project submission". The startup track's Representative "must be an active employee of the startup".
- **Deadline:** "Nov 4: Project submissions due by 9:00 PM ET".
- **Startup track:** "Judged on technical execution and whether it holds up in production."
- **Open source:** "Participants may also include open source software or hardware, provided applicable open source licenses are followed and the Submission enhances or builds upon the underlying open source product."
- **Ownership:** "the entrant retains ownership of all intellectual and industrial property rights", and grants the Organizers a perpetual, royalty-free license to use the Submission, marketing included.
- **Public repo:** the rules say nothing about it. The organizers' later answers (docs/SUBMISSION.md) ask for a fresh public repo created Oct 26 or later, with pre-existing material labeled.
- **Meta models only, at runtime (organizer answer in the Cerebral Valley Discord, Nov 2, 3:57 PM, as pasted by Ethan):** Llama is not part of this hackathon and does not count as a Meta model, however it is run. Open Meta models anyone can get count: Muse Glimmer, Muse Spark Open, SAM, V-JEPA 2. Every model the project calls at runtime must be a Meta model, so no non-Meta helper either (their example was an embedding model, even beside a Meta chat model). A hybrid with Llama as the default is not allowed. An optional Muse Spark API mode is fine if Meta models do real work in it, and the demo must show that path working. Faster local builds of Glimmer, such as a quantized one, still count. For us this rules out Llama 3.2 (the edge plan and #67's receipt reader), LFM (Muse Privacy's device model, jetson-05), Bolt (jetson-03 and 04) and Prompt Guard at runtime.

## What the research changes

1. **Meta already ships a local-then-cloud pattern.** In its cookbook, Glimmer runs locally, the person sees the exact text, and Muse Spark gets that text only once the person approves it. Each send is logged.
   - `privacy/docs/PRIOR_WORK.md` lists PlanTwin, Minions and PAPILLON but not this. A judge from Meta will know it, so list it first.
   - The difference, from `privacy/README.md`: Muse plans over tags and never gets the documents. A policy file decides what may leave, a check for names and identifiers runs on every result, and a router learns from what was approved before. Nobody has to approve each string.
   - Measured so far on Glimmer: 0 leaks of names or identifiers on invented sets (200 items on Nov 2, 100 on Oct 27), and one leak in the round before Oct 27's final runs, from a guard gap since closed.
   - Research says hybrid splits do leak (PAPILLON's best setup leaked 7.5%). So the claim is always "measured on N invented items", never "never leaves".
2. **Fine-tuning isn't the new part.** Meta documents SFT, LoRA, QLoRA and RL for Glimmer, and points to Unsloth. We tune on Unsloth's 4-bit build, so say so.
   - The claim: one sentence becomes a plan, data, a tune, a blind check against the base model, and a file you keep, plus an app built around it.
3. **The Jetson result is the honest frontier.** Meta's smallest Glimmer is 16.8 GB. The knowledge run's r30b, cut to 5.75 GB, now runs on a real Jetson Orin Nano 8GB (`jetson-02`, llama.cpp).
   - On the board: 5 to 6 tokens a second with poor answers. Its card reports loops on 17 of 60 prompts.
   - On Hussam's 40-receipt bench (PR #62), run without a JSON schema, it gave 0% valid JSON, and the board stopped answering at receipt 23 and needed a power cycle. So don't film it doing a document task. Nov 3: with a `json_schema` it always gave valid JSON, but called the cold-room reading wrong in every setup tried, so the board fallback is fixed code (thresholds plus the probe-disagreement rule, no model), and the edge apps don't use Glimmer (BUILD_LOG, "Nov 3, 2026, 10:05 to 10:30 AM ET"). The same bench ran other companies' models on other boards; those numbers aren't project results and stay out of public copy.
   - Nov 1, found Nov 3: a 6.53 GB one-bit r30b file ran on a Galaxy S25 (12 GB, CPU) in AWS Device Farm at 1.94 tokens a second, 3 of 3 simple questions, from adb shell, not an app (docs/GLIMMER_DEVICES.md).
   - These are Hugging Face weights from the knowledge run. Keep them apart from the app story: no Muse Muse app calls them, and nothing the one-sentence flow made has run on a board.
   - Show it as "a third the size of Meta's smallest file, and here's what that costs", never as the model doing the reasoning in a demo.
   - r30b is a Derivative of Muse Spark Open (BUILD_LOG, Oct 31, "r30b is a Derivative of Muse Spark Open"). So "Built with Muse Spark Open" goes on screen with it, and its Usage Policy means 18 and over.
4. **Don't pitch a gap in Meta's lineup.** Meta already has Muse (a personal agent with a Secure VM and audit trail), Muse Code, Glimmer and the cookbook above. Replit and Lovable already turn a sentence into an app.
   - The safe contrast, from the report: "Meta now offers frontier cloud models and open models for local use. Muse Muse explores whether one person can move between them, shape the result, and leave with something they control."
   - Nov 2, unchecked: an @Muse thread on X says Muse is now on iOS, Android and Mac, with Invite Codes, and in Canada. If a Meta page confirms it, Muse Muse's connectors are a way into Meta's own app on those devices. Say so only after one connector has run in the Muse app on Mac.
5. **Compliance.** The privacy toggles already say none of them makes anyone legally covered. Keep it that way.

## Gaps the research points at

None of these is built.

- **General-capability and safety checks on a tune.** Meta's guide says to track a general benchmark as well as the task metric, and research finds small fine-tunes can weaken safety. Our blind check compares tuned and base on held-out task prompts only. Adding a small general set and a small safety set to the same judge would let us say we follow Meta's guide in full.
- **A network capture for Muse Privacy.** Plant a canary string in a document, record every outbound request during a run, and show that the string never goes out. This is stronger than counting leaks with our own checker.
- **The judge as one signal, not the gate.** Research puts LLM code judges at 17 to 22% false positives. Our build checks run typecheck, build and a smoke test before the judge, so say the judge is one check of four.

## Stale lines, fixed Nov 2 on branch tg-messaging

- `privacy/README.md` and `privacy/CLAUDE.md` said "solo" and the Build for Your World theme. They now say Ethan and Hussam, Push the Frontier.
- `privacy/README.md`, `docs/STORY.md`, `docs/OFFLINE.md` and `lib/story/flow.ts` (the `/offline` page) said no Glimmer had run on a Jetson, or that jetson-02 ran LFM3. They now give the r30b run on jetson-02 with its limits.
- `docs/STORY.md`: the lifted no-company-name rule, and the Oct 30 run with 10 leaks next to the "0 leaks" line.
- `privacy/docs/PRIOR_WORK.md` lists Meta's "Local agent that asks first" first.

Still stale, found by Hussam's PR #61 and left for later because they need a new builder snapshot or are Muse Privacy's own copy:
- `template/.agents/skills/meta-glimmer/SKILL.md` lines 3 and 14, and `lib/prompts/catalog.ts` line 201, still pitch Glimmer for "local, private or offline" use.
- `privacy/README.md` line 13 and `privacy/docs/OTHER_APPS.md` line 5 say the Claude and ChatGPT apps weren't tried, but `privacy/docs/BUILD_LOG.md` for Oct 31 shows both working.

## Don't say

- That Meta hasn't built private AI, fine-tuning or local agents.
- That Muse Privacy solves Meta's local-and-cloud problem.
- That data never leaves the device. Say how many leaks on how many invented items, and what that tested.
- "0 leaks on 300 items", or the Oct 30 run's 10 leaks on 200 items (`privacy/eval/reports/device_only_fresh_200.md`), as Muse Privacy results. Both were measured with LFM3-VL-2B, which isn't a Meta model, so neither goes in public copy. Muse Privacy's public numbers come only from runs on Glimmer (the Nov 2 rerun of today's setup, `privacy/eval/reports/glimmer_fresh_200_b_2026-11-02.md`, or the Oct 27 cloud run), with every leak given.
- That fleet or board answers are private. They pass through the product's server, Muse Muse, ngrok and the lead board, and jetson-05's ngrok agent keeps recent request bodies in memory (PR #61).
- That Glimmer 30B runs well on 8 GB.
- That one-bit or 4-bit costs nothing.
- That the whole chain runs end to end. The marks in `docs/STORY.md` decide what's proven.
- HIPAA, FERPA or COPPA compliant, or compliant because it's offline.
- That the judge proves an app works.
- That most non-developers now build software.
- That Muse Spark Open is unrestricted open source. (The LFM license note that was here is moot: LFM is out of the project under the Nov 2 ruling.)
- That Meta is going closed, or that everything Meta makes will be open.
- Any judge's name. None has been made public.
- That Muse Privacy is the "fully private mode" from Zuckerberg's letter, or that Meta Engineering reviewed or endorses anything here.
- "Every federal agency restricts AI." GAO's line is about the 12 agencies it selected that allow generative AI.
- That Llama, LFM, Bolt or Prompt Guard is part of the project, or that Llama is a Meta model for this hackathon. The organizers ruled on Nov 2 that only Meta models may run (see the rules section).

Meta-models-only lines, added Nov 2 evening from the Meta-models audit:
- "Built with Llama", anywhere. Llama of any version, Llama Guard and Prompt Guard are not Meta models in this hackathon.
- That a non-Meta model (LFM, Bolt, EmbeddingGemma, SpeechT5, any ONNX or transformers.js model) does work in Muse Muse or Muse Privacy. Labeling one "not a Meta model" doesn't make it allowed.
- Bolt, LFM or Llama numbers as project results, including the Llama harness tune (6.67 to 2.55, 95 to 5), the 2.02 GB Llama file, and the receipt-bench numbers for Bolt and LFM.
- "Nothing leaves the device", "device-only" or "on the device" for Muse Privacy while its submitted path is Muse Glimmer in the cloud. Say Glimmer runs in the cloud on invented data, and that device Glimmer is the target.
- That one-bit Glimmer reads documents reliably on 8 GB. Don't film it on a document task unless the schema gate passed.
- That Llama or Glimmer was tuned on a board. PR #67 tuned Llama on jetson-04, which isn't a Meta model, and an 8 GB board can't tune Glimmer. Meta SAM 3.1's detector learning the word "muse" on jetson-03 (Nov 3) may be said, as docs/EDGE_PLAN.md words it: "muse" went from 0 to 38 of 38 held-out made-up images, and Meta's SAM 3.1 already finds the same mascot as "plush toy", so the tune adds a name, not accuracy. Never say it sees better than Meta's weights.
- That the d1 router, System One, combos or the fleet console's assistant are part of Muse Muse. Muse Muse never calls them.
- Keep the fleet console and jetson-03, 04 and 05 out of frame, along with the Claude and ChatGPT connector labels. Show only the Muse app connector.

Edge lines, added Nov 3 (branch tg-c-claims):
- That the edge app falls back to one-bit Glimmer, or that a model judges the cold room on the board. The board fallback is rules in code plus SAM 3.1 (BUILD_LOG, "Nov 3, 2026, 10:05 to 10:30 AM ET").
- That Muse Privacy "keeps documents on hardware you own". It runs in the cloud on invented data.
- That Muse Wonder planned, built or judged a product, unless that build's log entry shows it ran on Wonder. Builds on the live site run on Muse Spark 1.3 Contributor while `BUILDS_ON_CONTRIBUTOR` is on (docs/HANDOFF.md, "Wonder stays off").
- That Muse Spark Open runs inside apps through Fireworks. Fireworks' account answered 412 on Nov 2, and no logged product call has used Spark Open.

Edge lines, added Nov 2 (docs/EDGE_PLAN.md):
- That AI "stops hacks", or that anything is "attack-proof".
- That the DC outage was an attack. Pepco said there is "no indication of foul play".
- That Britain or Norway were hit.
- "Hackers hit commissaries". Say the Pentagon is treating it as a suspected cyberattack.
- That any freezer incident is a confirmed cyberattack. Say "suspected".
- "Works offline" in general, or that the platform runs offline. Say which app kept answering, on which board, with what cut, and only after it ran.
- "Private" or "on-device" for board answers, or that data never leaves the device.
- That anything survives a power loss. Power loss is a case in invented data only.
- Food-safety advice, or anything about real freezers. The cold room is simulated and its readings are invented.
- Wikipedia's unchecked "no alarms" and "admin" password lines, or the "dozens of locations" snippet.
- That ANSSI said something, by name, unless a page naming ANSSI has been read. Say "France's cybersecurity agency".
- That CISA ICSA-25-140-03 caused or explains any incident. No news page above names it.
