# The video

**DRAFT until the owners pick the story.** This is the recommended one. Written Nov 2, 2026, on branch tg-submission-kit.

**Revision approved Nov 2:** the owner said yes to O1 and O6 (docs/EDGE_PLAN.md), so the edge act at the end of this file ("Proposed revision: the edge act") is the script to film, and edge and defense is a headline beside frontier. The script just below stays as the fallback. Organizer rule (Discord, Nov 2): the video's opening line must say what existed before the event and what was built this week, so every cut opens with shot 0 as revised below.

Where it came from: this replaces the three-minute table that was in docs/STORY.md and the inspo-first script that was section 2 of docs/SUBMISSION.md. If the owners want the inspo-first story instead, it is at `git show e290545d:docs/SUBMISSION.md`, but fix its "24 of 24 builds went live" line first: that was a local batch that never deployed.

## The rules for this script

- **Length.** The Official Rules and the event page don't state a limit (read Nov 2, docs/MESSAGING.md, "What the rules say"). Check the portal's form. This cut runs 2:50. The 2:30 cut is at the end.
- **Demo is 25% of the score**, and it covers "the quality of the demo video" (Official Rules, Checked). Impact is 30%, Meta tooling 25%, technical depth 20%.
- **Only Checked lines** from docs/MESSAGING.md, and only steps with a proven mark in docs/STORY.md, unless a shot is tagged and labeled.
- **No em dashes** in captions or cards. They/them for people.
- Never say the whole chain runs end to end, or that data never leaves. Say how many leaks on how many invented items.

### Tags

- **[needs the chain run]**: needs footage from one paid end-to-end run, from the sentence to the app, which hasn't happened (docs/HANDOFF.md, owner to-do 2). Each has a fallback that is true today.
- **[Hussam films]**: Jetson footage. Hussam owns the boards.
- **[film now]**: can be filmed on the live site today, signed out.

## Before you record

- Production needs `STORY_PAGES` on for `/offline`, the longer `/private` and the frontier section. It's read at build time, so it needs a redeploy.
- Stay signed out, so the site shows what judges see. Browser at 1440×900, light theme, 100% zoom, a clean profile.
- Never show `.env.local`, the Vercel, Lambda or AWS consoles, an admin job page (it shows the instance's address), the fleet console, or any ngrok domain or board address.
- Builds on the test model get a corner label "Test model". Sped-up footage gets "Sped up".
- If the Oct 30 privacy run (10 leaks on 200 items) has been rerun by recording day, use its result in shot 9 instead of "we haven't found why yet", and fix the card.

## Timing

| # | Time | Act | Shot | Tag |
|---|---|---|---|---|
| 0 | 0:00 to 0:10 | Open | Zuckerberg's line | film now |
| 1 | 0:10 to 0:22 | 1 | One sentence on the Make page | needs the chain run |
| 2 | 0:22 to 0:34 | 1 | The plan and the data | needs the chain run |
| 3 | 0:34 to 0:58 | 1 | The tune and the blind check | film now |
| 4 | 0:58 to 1:08 | 1 | A file you keep | needs the chain run |
| 5 | 1:08 to 1:22 | 1 | An app built around it | film now, plus needs the chain run |
| 6 | 1:22 to 1:32 | 1 | The marks on `/offline` | film now |
| 7 | 1:32 to 1:44 | 2 | Why some files can't go to a cloud | film now |
| 8 | 1:44 to 2:04 | 2 | Muse Privacy: tags, not documents | film now |
| 9 | 2:04 to 2:17 | 2 | The numbers, both runs | film now |
| 10 | 2:17 to 2:27 | 3 | Glimmer on the Jetson | Hussam films |
| 11 | 2:27 to 2:37 | 3 | What that costs | film now |
| 12 | 2:37 to 2:50 | Close | The claim, and its marks | film now |

Narration is about 400 words, about 140 a minute. Read it aloud once with a timer before recording.

## Shots

### Open

**0. Zuckerberg's line (0:00 to 0:10)** [film now]

- On screen: a title card. "People are starting to be able to manifest ideas themselves without having to raise money or build large teams." Under it: "Mark Zuckerberg, The Future is for Everyone, Aug 10, 2026."
- Say: "Mark Zuckerberg wrote that people are starting to build their ideas without raising money or a big team. How far can one sentence go with Meta's models?"
- Source: docs/MESSAGING.md, Checked.

### Act 1: one sentence becomes a model you keep, and an app around it

**1. One sentence on the Make page (0:10 to 0:22)** [needs the chain run]

- On screen: https://muse-muse.vercel.app, the Make chat. Type one sentence, for example "A helper that turns my bakery's receipts into a weekly cost sheet." Send it.
- Say: "You type what you want in one sentence. Muse Muse is built to turn it into a plan, training data, a tuned model and an app."
- Fallback: film typing only, don't send, and cut to shot 2's fallback card.
- Mark: one sentence to a plan and data is "Proven, by harness". The one-box page has not started a real run.

**2. The plan and the data (0:22 to 0:34)** [needs the chain run]

- On screen: the plan the Meta model wrote, then a few training rows scrolling.
- Say: "A Meta model writes the plan and the training data, with prompts kept aside that the tune never sees."
- Fallback card: "Test harness, invented hobby. 900 rows to train on, 100 kept aside. $0.22. Not started from the site."

**3. The tune and the blind check (0:34 to 0:58)** [film now]

- On screen: `/fine-tuning`, the public read-only page. Open the Glimmer run that won 40 of 40. The summary strip, then scroll two or three side-by-side items: prompt, base answer, tuned answer, verdict. Overlay, from Meta's post-training docs: "Compare your fine-tuned model against the base model on a held-out test set before deploying."
- Say: "Muse Glimmer 30B learned a task on a rented GPU in 42 minutes for $1.39. Then a judge compared it with base Glimmer, blind, on 40 prompts it never saw. Tuned won all 40. That's the check Meta's own guide asks for. The guide also asks for a general benchmark, and we don't run that yet."
- Source: docs/STORY.md, "A tuned model" and "A blind check", Proven by harness; this Glimmer run was the lab's own flow, judged by Muse Spark 1.3. docs/MESSAGING.md, the post-training row.
- Don't say the run came from shot 1's sentence. If the chain run happens, show its own blind check here instead.

**4. A file you keep (0:58 to 1:08)** [needs the chain run]

- On screen: the run's download, the file name and its size. Overlay, credited to Meta's Muse Glimmer docs: "you own the weights, the runtime, and the data".
- Say: "What comes out is a file you keep. In Meta's words, you own the weights, the runtime, and the data."
- Fallback card: "Test harness, made-up data: a tuned small Llama became a 2.02 GB file and passed every check. A tuned Glimmer became a 6.53 GB one-bit file."

**5. An app built around it (1:08 to 1:22)** [film now, plus needs the chain run]

- On screen: a finished build's room on the live site, if a signed-out visitor can open one, sped up and labeled "Sped up. Real build." Otherwise a Nov 1 recipe demo clip from docs/PROVE_RESULTS.md, labeled "Test model, made-up data". The checks turn: typecheck, build, smoke test, the judge's screenshots.
- Say: "Muse Code builds an app around it and checks it: types, a build, a smoke test and a judge. The app answering with its own tuned model hasn't run yet."
- With the chain run: end on the app answering from its tuned model, and drop the last sentence only if docs/STORY.md marks that step proven.
- Source: docs/STORY.md, "An app built for it" and "Checks", Proven; "That app answering with its tuned model", Not run yet.

**6. The marks on `/offline` (1:22 to 1:32)** [film now]

- On screen: `/offline`, the step list with each mark.
- Say: "Every step on this page carries a mark: proven, proven by our test harness, simulated, or not run yet. Running on your own board is simulated in this flow today."

### Act 2: Muse Privacy

Keep the company's name out of this act (`components/story/__tests__/story.test.tsx` still enforces it).

**7. Why some files can't go to a cloud (1:32 to 1:44)** [film now]

- On screen: two cards. "Johns Hopkins Bayview notified 3,182 patients after a worker uploaded a patient spreadsheet to an AI tool the hospital hadn't approved." Source line: "Reported by WMAR, HealthExec and the Baltimore Banner." Then: "All 12 agencies GAO selected that allow generative AI limit or restrict that use. GAO-25-107653, July 2025."
- Say: "Some files can't go to any cloud. One spreadsheet in an unapproved AI tool meant a hospital notified 3,182 patients. GAO found all 12 agencies it selected that allow generative AI restrict it."
- Source: docs/MESSAGING.md, both Checked. Say "a patient spreadsheet", nothing more about its contents.

**8. Muse Privacy: tags, not documents (1:44 to 2:04)** [film now]

- On screen: `/private`, before and after, then the replay, labeled "Recorded replay. A script plays Muse." Optional overlay: "'The access decision does not depend on the agent behaving as intended.' Meta Engineering, on PrivacyLib, Oct 27, 2026."
- Say: "Muse Privacy is a connector on hardware you own. Muse plans with tags like Student A and never gets the documents. A model on the device does every step that touches them, your policy file decides what can leave, and a last check runs on every result before it goes."
- Source: docs/STORY.md, privacy paragraph; privacy/README.md.

**9. The numbers, both runs (2:04 to 2:17)** [film now]

- On screen: a card. "Invented items, on a laptop. Today: 0 leaks of names or identifiers on 300 items. Oct 30: 10 leaks on 200 items, cause not found. 76 approval requests on 200 items, 28 needless. Device model: Liquid's LFM3-VL-2B, not a Meta model. No real users."
- Say: "On 300 invented items, no names or identifiers leaked. An earlier run leaked 10 on 200, and we haven't found why yet. The model on the device today is Liquid's, not Meta's."
- Source: docs/STORY.md, privacy paragraph; `privacy/eval/reports/device_only_fresh_200.md`.

### Act 3: the Jetson

**10. Glimmer on the Jetson (2:17 to 2:27)** [Hussam films]

- On screen: about 10 seconds of jetson-02, a Jetson Orin Nano 8GB, answering one short chat question in real time, not sped up. Lower third: "Muse Glimmer 30B, one-bit (IQ1_S), 5.75 GB. Meta's smallest Glimmer file: 16.8 GB. Built with Muse Spark Open. 18 and over."
- Say: "This is Muse Glimmer on an 8 GB Jetson, a third the size of Meta's smallest file. We made it by hand, not yet from the flow."
- For Hussam: a short chat only, never a receipt or other document task. jetson-02, not jetson-05. No addresses, ngrok domain or fleet console in frame. Say "offline" on screen only if the board is filmed with its network unplugged.
- Source: docs/MESSAGING.md, quantization row (Checked) and point 3; docs/STORY.md, device-file row.

**11. What that costs (2:27 to 2:37)** [film now]

- On screen: a card. "5 to 6 tokens a second. Weak answers. 40 invented receipts: no valid JSON, and the board hung at receipt 23."
- Say: "The cost: 5 to 6 tokens a second, weak answers, and no valid output on a receipt test. That's the frontier we're working on."
- Source: docs/STORY.md, device-file row (PR #62).

### Close

**12. The claim, and its marks (2:37 to 2:50)** [film now]

- On screen: back on `/offline`, the frontier claim above the step list. Overlay the live URL, the repo URL once it's public, and "Not an official Meta product."
- Say: "Muse Muse is built so one sentence becomes a tuned model on your own hardware, in an app built for it. Part of that is proven today, and the page shows which part."
- Source: docs/STORY.md, the frontier claim. Keep "is built so" until docs/STORY.md marks every step proven.

## The 2:30 cut

Drop shot 0 (open on shot 1 and fold "one sentence" into its line), and cut shot 6 to its last sentence. That saves about 15 seconds. To go shorter still, drop shot 4 and say "a file you keep" in shot 3.

## Who films what

| Shots | Who | When |
|---|---|---|
| 0, 3, 5 (recorded build), 6, 7, 8, 9, 11, 12 | Ethan, or whoever records | Any time once `STORY_PAGES` is on |
| 1, 2, 4, 5 (tuned app) | Whoever runs the chain | Only during the approved chain run. Otherwise use the fallbacks |
| 10 | Hussam | 1 to 2 hours, on jetson-02 |

## Proposed revision: the edge act

**Approved by the owner on Nov 2 (O1 and O6 yes, docs/EDGE_PLAN.md).** O1 reverses the Oct 31 line "No Jetson or fleet endpoint in the Nov 4 demo". O6 approves this re-cut. Shots tagged with a unit still wait on that unit's run. Written Nov 2 on branch tg-edge-copy, from the merged edge plan.

What changes:
- Act 1 runs on the cold-room sentence, if the chain run (O2) happens. Otherwise Act 1 stays as above.
- Act 2 (Muse Privacy) goes from about 33 s (shots 8 and 9) to about 20 s. Shot 7 stays.
- Shots 10 and 11 become a Glimmer shot of about 5 s and an edge act of about 30 s. The Glimmer shot stays because the Open Weights prize names Glimmer or Spark Open, not Llama.
- The 60-second X cut uses E3a.

### More tags

- **[needs M5]**, **[needs M7]**, **[needs M8]**, **[needs M10]**, **[needs M12]**: needs that unit from docs/EDGE_PLAN.md to have run, with a log entry. Each shot has a fallback.
- The scenario is a simulated cold room with invented readings. Every edge shot carries "Simulated" somewhere on screen. No food-safety advice and nothing about real freezers, in captions or narration.

### Revised timing

| # | Time | Act | Shot | Tag |
|---|---|---|---|---|
| 0 | 0:00 to 0:12 | Open | What existed before, what we built this week, then Zuckerberg's line | film now |
| 1 | 0:12 to 0:22 | 1 | One sentence on the Make page: the cold-room sentence | needs the chain run |
| 2 | 0:22 to 0:34 | 1 | The plan and the data | needs the chain run |
| 3 | 0:34 to 0:58 | 1 | The tune and the blind check | film now |
| 4 | 0:58 to 1:08 | 1 | A file you keep | needs the chain run |
| 5 | 1:08 to 1:22 | 1 | An app built around it | film now, plus needs the chain run |
| 6 | 1:22 to 1:32 | 1 | The marks on `/offline` | film now |
| 7 | 1:32 to 1:44 | 2 | Why some files can't go to a cloud | film now |
| 8 | 1:44 to 1:56 | 2 | Muse Privacy: tags, not documents, shorter | film now |
| 9 | 1:56 to 2:04 | 2 | The numbers, both runs, shorter | film now |
| 10 | 2:04 to 2:09 | 3 | Glimmer on the Jetson, shorter | Hussam films |
| E1 | 2:09 to 2:17 | 3 | Drills passing on the build screen | needs M5, needs M7 |
| E2 | 2:17 to 2:23 | 3 | The tune card | needs M8 |
| E3a | 2:23 to 2:33 | 3 | Cables out, the app still answers | needs M12, Hussam films |
| E3b | 2:33 to 2:41 | 3 | A reading that doesn't add up | needs M12, Hussam films |
| 12 | 2:41 to 2:54 | Close | The claim, and its marks | film now |

About 2:54. Shot 11's card ("What that costs") is dropped; its numbers stay in the write-up.

### Revised shots

**0. The opening line (0:00 to 0:12)** [film now]

- Required by the organizers (Discord, Nov 2): the first line says what existed before and what was built this week.
- Say first: "Before this week, Offline Base had a fleet of Jetson boards and the software that runs them, plus a scaffold of design notes and stubs for Muse Muse. Everything Muse Muse does in this video, we built this week."
- On screen while it's said: a plain card with two columns, "Before Oct 26" (the Jetson fleet and its control software, the boards' models, a Muse Muse scaffold with no working code) and "Built this week" (Muse Muse, Muse Privacy, the edge track).
- Then Zuckerberg's line from shot 0 above, as a 4-second title card with no narration over it.
- Source: README.md, "Before the event"; docs/MESSAGING.md for the quote.

**1. One sentence (0:12 to 0:22)** [needs the chain run]

- Only if O2 is yes and the chain run uses this sentence. Type: "A watcher for my cold room that reads the controller, a second probe, the door, defrost and power, and keeps answering when the cloud is down." Corner label: "Simulated cold room. Test model."
- Say: as shot 1 above.
- Fallback: shot 1 as written above, with its own sentence.

**2, for the cold-room run (0:22 to 0:34)** [needs the chain run]

- On screen: the plan, then a few of the 900 training rows scrolling, each marked Simulated.
- Say: "A Meta model writes the plan. The training rows are simulated cold-room logs our own code wrote, with 100 sealed away that the tune never sees." (Not "a Meta model writes the training data": for this run it doesn't. docs/CHAIN_RUN.md.)

**8, shorter (1:44 to 1:56)** [film now]

- On screen: `/private`, before and after, then a few seconds of the replay, labeled "Recorded replay. A script plays Muse."
- Say: "Muse Privacy plans with tags like Student A and never gets the documents. Your policy file decides what can leave, and a last check runs on every result."

**9, shorter (1:56 to 2:04)** [film now]

- On screen: shot 9's card, unchanged.
- Say: "On 300 invented items, no names or identifiers leaked. An earlier run leaked 10 on 200. The device model today is Liquid's."

**10, shorter (2:04 to 2:09)** [Hussam films]

- On screen: 5 seconds of jetson-02 answering one short chat, with shot 10's lower third above, unchanged.
- Say: "Muse Glimmer, cut to a third of Meta's smallest file, on an 8 GB Jetson."

**E1. Drills passing on the build screen (2:09 to 2:17)** [needs M5] [needs M7]

- On screen: an edge build's room on a preview, the drill step turning green: cloud refused, cloud hangs, both down, tampered reply rejected. Corner label: "Test build on Muse Spark 1.3 Contributor". Caption: "Simulated outage drills".
- Say: "Every edge build is drilled before it ships. We cut its cloud four ways and check it still answers, or says plainly that it can't."
- Fallback: M3's drills on the laptop, captioned "Simulated outage drills, on a laptop", and the narration says "is built so every edge build is drilled". If M5 hasn't run, never say "every edge build".

**E2. The tune card (2:17 to 2:23)** [needs M8]

- On screen: the tune result, tuned against base on the 100 held-out invented items, scored by drill-bench. "Llama 3.2 3B. Built with Llama." Caption: "Invented data. Scored by code, not a judge."
- Say: "Muse Muse tuned a Llama 3.2 3B for this one job, and checked it against the base model on 100 items it never saw."
- Fill the numbers from docs/BUILD_LOG.md only. If tuned didn't beat base, show both numbers and say so.
- Fallback: drop E2 and give its 6 seconds to E3a. Label the board model "base" everywhere after it.

**E3a. Cables out (2:23 to 2:33)** [needs M12] [Hussam films]

- On screen: one take, not sped up. The board's Ethernet and Wi-Fi out, the laptop's Wi-Fi off, a terminal where `api.meta.ai` fails. The app answers. Answer label: "Answered on jetson-0X, Llama 3.2 3B (tuned)", or "(base)" at ladder level 3. Lower third: "Simulated cold room. Real board, real unplug."
- Say: "Now every cable comes out. The same app keeps answering on the Jetson, from the model we tuned for it. N of 5 drills passed, at X tokens a second."
- N and X come from that take only. Never "works offline" in general, never "private" or "on-device", never that anything survives a power loss. No power cuts on camera.
- Fallback: the ladder in docs/EDGE_PLAN.md. At level 4, use shot 10 as written above plus a "Simulated outage" card from M3, and say "is built so it keeps answering when the cloud is cut".

**E3b. A reading that doesn't add up (2:33 to 2:41)** [needs M12] [Hussam films]

- On screen: the same take. A spoofed log from M2's demo CSV: the controller reads -18 C while the independent probe reads +9 C and rising. The app flags it, says not to trust the controller, and lists its actions. Lower third, as E3a.
- Say: "Here the controller says minus 18 and the second probe says plus 9 and climbing. The app doesn't trust the controller, and flags it."
- Don't read the actions aloud and don't call them advice. Never say it stops hacks or is attack-proof.
- Fallback: drop E3b and end E3a at 2:41.

**12. Close (2:41 to 2:54)** [film now]

- As shot 12 above. With M12 run, the claim may add: "and this app kept answering on one Jetson with its network unplugged". Keep "is built so" for the rest.

### The 60-second X cut

Shot 1 (or its fallback), E2 if it ran, E3a, then shot 12's URL card. Same labels and lower third.

### Who films the edge act

| Shots | Who | When |
|---|---|---|
| E1 | Whoever runs M7 | Tue, during the M7 build on a preview (O4) |
| E2 | The lead | Tue afternoon, after M8 is logged |
| 10 (5 s), E3a, E3b | Hussam, with Ethan | Tue 7 to 9 PM (H5): two rehearsals, one take. No addresses, ngrok domain or console in frame |
