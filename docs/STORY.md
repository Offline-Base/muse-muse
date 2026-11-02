# The story

For the submission writer. Written Nov 1, 2026, from origin/main at b2b25cb, on branch tg-story. Other streams were still running when this was written (quantize, proofs, gadgets, the Jetson flow), so before pulling a line in, check each mark against docs/PROVE_RESULTS.md and move it up only if that file shows a real run. The marks live in `lib/story/flow.ts`, and the pages read them from there.

## The frontier claim

> Muse Muse is built so one sentence becomes a tuned model on your own hardware, inside an app built for it, with checks showing what was proven.

Say "is built so" until the whole chain has run. Today it hasn't run as one, and no tuned model from this flow has run on anyone's own hardware.

| Step | Mark | Evidence |
|---|---|---|
| One sentence to a plan and data | Proven, by harness | `scripts/dev/tune-harness.ts`: 900 train and 100 kept-aside rows for an invented hobby, $0.22. The one-box page (TUNE_COMPOSER) has not started a real run |
| A tuned model on a rented GPU | Proven, by harness | Small Llama (Llama 3.2 3B), Lambda A10, about 18 minutes. Launch, callbacks, workflow and sweep were stood in for. Separately, the lab's own flow tuned Muse Glimmer 30B on an A100, 42 minutes, $1.39 (README) |
| A blind check | Proven, by harness | Muse Wonder judged 100 of 100 blind, $1.54: tuned 6.67, base 2.55, tuned won 95 to 5. The topic is invented, so base starts knowing nothing, which makes this an easy test. The Glimmer run: tuned won 40 of 40, 8.88 to 1.95, judged by Muse Spark 1.3 |
| A file small enough for a device | Not run yet | Nothing from this flow. By hand on rented machines, tuned Glimmer at IQ1_S (6.53 GB): 8.1% of probes, against 29.9% at Q4_K_M and 0.8% for base at IQ1_S (docs/KNOWLEDGE_RUN_LOG.md, stage 1). Also by hand, since Nov 2: the knowledge run's r30b at IQ1_S (5.75 GB) answers short chats on jetson-02, a real Jetson Orin Nano 8GB, at 5 to 6 tokens a second with weak answers. On 40 invented receipts it gave no valid JSON, and the board hung at receipt 23 (PR #62; docs/OFFLINE.md, section 6) |
| On your own hardware | Simulated | For this flow, a simulated board only. Emulator runs and USB export have run only against fakes. The fleet is reachable now, and jetson-02 serves the hand-made file above, but nothing this flow made has run on a board |
| An app built for it | Proven | Test builds on TEST_MODEL with made-up data, on a local site with no live link (docs/BUILD_LOG.md, "what it can build") |
| That app answering with its tuned model | Not run yet | "Its own model" plans a tune, behind a flag. The product stays on Muse Wonder until its model passes and is served |
| Checks showing what was proven | Proven | Typecheck, build, smoke test and judge on those builds. The gadget build's board was simulated |

What not to say: that Muse Glimmer scored 6.67, that the run went through the real launch path, that one-bit is good, or that anything from this flow ran on a Jetson. The knowledge run's Glimmer does run on jetson-02: say how slow and weak it is, and show "Built with Muse Spark Open" with it. docs/MESSAGING.md lists which outside quotes are checked.

## Alignment paragraph

Muse Muse does the heavy work once in the cloud, and the aim is that what comes out is yours to run offline. Offline Base already makes the other half: Base Drive, an offline AI kit on a flash drive whose setup is designed to work with Wi-Fi and Ethernet off, and a fleet of Jetson Orin Nano boards run from one console, where the model server stays on the board and the fleet agent dials out, so neither listens on the local network. Muse Muse could make what runs there, tuned to one person's job: a small Llama on most devices and one-bit Muse Glimmer on a Jetson. The fleet has real boards, but this flow has not run on them, and everything it does on a board so far is simulated. A one-bit Glimmer made by hand (the knowledge run's r30b, 5.75 GB) now fits on an 8 GB Jetson and answers short chats, at 5 to 6 tokens a second with weak answers. Under a 40-receipt bench it gave no valid JSON and the board hung partway (PR #62). Meta's smallest published Glimmer file is 16.8 GB. See `/offline`.

## Privacy paragraph

The owner lifted the no-company-name rule for Muse Privacy content on Nov 1. `components/story/__tests__/story.test.tsx` and the `/private` test still enforce it, so change those tests first if this paragraph should name the company.

Muse can reach your files through connectors, but what it reads lands in its cloud computer, names and all, so private work like grading stays out of its reach. Muse Privacy is a connector that runs on hardware you own. Muse plans with tags like [Student A], a model on your device does every step that touches the documents, your policy file decides what can leave, and a final check runs on every result. It is aimed at a hostile or compromised Muse and at instructions planted in documents. On 300 invented items on a laptop, with today's router, it had 0 leaks of names or identifiers (an earlier run on Oct 30 had 10 leaks on 200 items, cause not recorded and not rerun: `privacy/eval/reports/device_only_fresh_200.md`) and agreed with the expected decision 82.0% of the time on 200 items and 81.0% on 100 tasks, though only 65.0% (13 of 20) on the holdout items inside those tasks. 5 results were shared that should have waited, it asks too often (76 requests on the 200 items, 28 needless), and "leaks" doesn't cover everything: a summary can point at someone without naming them. There are no real users, the sealed test set hasn't been scored, the attacks are hand-written, and the device model today is Liquid's LFM3-VL-2B, not Muse Glimmer. It sits beside Muse Muse rather than inside it: you build with made-up data in Muse Muse, and Muse Privacy is how Muse can help when the real files must stay with you. See `/private`.

## Three-minute video

Show only what has run. Put "Simulated" on screen whenever a simulated board is on screen.

| Time | On screen | Say |
|---|---|---|
| 0:00 to 0:20 | The Make page, one sentence typed | "People know what they want in a sentence. Getting from there to an AI that's theirs takes a team. Muse Muse is built to close that gap, and it marks what's proven." |
| 0:20 to 1:00 | A real build: plan, build room, checks, the live app | "Muse Wonder writes the plan, Muse Code builds in a sealed sandbox, and the checks run: types, build, a smoke test, a judge reading screenshots. When one fails, it goes back and fixes it." |
| 1:00 to 1:40 | `/fine-tuning`, then held-out prompts with base and tuned answers side by side | "Then tuning. On a rented GPU, through our test harness, a small Llama learned an invented topic: 6.67 against 2.55 on 100 prompts it never saw, judged blind. The topic is invented, so that's an easy test. Muse Glimmer has its own run: 40 of 40." |
| 1:40 to 2:10 | `/offline`, the step list with its marks | "This is the part we're most careful about. Green ran. Amber ran through our test harness. Blue is simulated. Grey hasn't run. Running on your own board is simulated today. One-bit size costs real quality, and we show that number too." Show the real quantize result here only if docs/PROVE_RESULTS.md has one. |
| 2:10 to 2:40 | `/private`, before and after, then the replay | "Some files can't go to any cloud. With Muse Privacy, your device reads them and Muse gets tags. This replay is recorded, with a script playing Muse. 0 leaks of names or identifiers on 300 invented items, no real users yet." Before saying "0 leaks", rerun or explain the Oct 30 run with 10 leaks (privacy paragraph above). |
| 2:40 to 3:00 | Back to the claim on `/offline` | "One sentence, a tuned model on your own hardware, in an app built for it, with checks that show what was proven. Part of that is proven today, and the page tells you which part." |

Before recording: `/offline`, the longer `/private` and the frontier section need STORY_PAGES, which is read at build time. The first row needs a real build on the site being filmed.

## For the owner to settle

- The owner's "Meta models only" and Muse Privacy's device model conflict in the plain reading: it runs Liquid's LFM3-VL-2B today, and the pages say so.
- How Muse Muse relates to Offline Base is stated only as "this project's repository sits in its GitHub organization". "Offline Base makes AI that runs on hardware people hold" is my summary of Base Drive and the fleet.
- Base Drive's README says its Windows edition hasn't run on a physical PC. That line may be older than the Windows drives in the production log, which check files only.
