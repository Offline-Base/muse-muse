# Muse Muse submission

**DRAFT until the owners pick the demo story** (docs/HANDOFF.md, owner to-do 1). Rewritten Nov 2, 2026, on branch tg-submission-kit, to match the recommended script in [VIDEO.md](VIDEO.md).

Meta Global AI Developer Hackathon. Startup track, theme Push the Frontier, by Ethan and Hussam. Due Nov 4, 2026, 9 PM ET; Ethan submits by noon ET.

- **Live site:** https://muse-muse.vercel.app (open to anyone, no sign-in)
- **Repo:** https://github.com/Offline-Base/muse-muse (private until the owner makes it public)
- **Video:** PLACEHOLDER: the link, once recorded

Every claim here traces to a Checked row in [MESSAGING.md](MESSAGING.md), a mark in [STORY.md](STORY.md) (which reads `lib/story/flow.ts`), or a logged result in [PROVE_RESULTS.md](PROVE_RESULTS.md) or [BUILD_LOG.md](BUILD_LOG.md). Each section says which. If a mark changes, change the line here.

This file has four parts: the form, the write-up, the video, and the checklist.

## 1. The form

The portal is https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit and needs a sign-in. Its fields aren't published, so the list below is a guess: Ethan opens the form, and anything it asks that isn't here goes in this section.

| Likely field | Answer |
|---|---|
| Project name | Muse Muse |
| Track | Startup |
| Theme | Push the Frontier |
| Team | Ethan and Hussam. The rules ask the Representative to "identify all other team members in the project submission" |
| One line | Section 2, "One line" |
| Description | Section 2, from "The problem" to "What isn't proven yet" |
| Demo video | The link, once recorded. No length limit is published; the cut runs 2:50 |
| Live link | https://muse-muse.vercel.app |
| Repo | https://github.com/Offline-Base/muse-muse, once the owner decides on public (docs/HANDOFF.md) |
| Meta models and tools used | Section 2, "How it uses Meta's models" |

## 2. Write-up

### One line

Muse Muse is built so one sentence becomes a tuned model you keep, inside an app built for it, with marks that show what was proven.

Source: STORY.md, the frontier claim. Keep "is built so" until every step there is marked proven.

### The problem

> "People are starting to be able to manifest ideas themselves without having to raise money or build large teams."
> Mark Zuckerberg, "The Future is for Everyone", Aug 10, 2026

Meta now offers frontier cloud models and open models for local use. Muse Muse explores whether one person can move between them, shape the result, and leave with something they control. Going from a sentence to a model that's yours still takes data, a GPU, a fair test against the base model, a file small enough for a device, and an app around it.

Some of that work can't go to any cloud. Johns Hopkins Bayview notified 3,182 patients after a worker uploaded a patient spreadsheet to an AI tool the hospital hadn't approved. GAO found that "all 12 selected agencies that allow the use of generative AI reported that the agency limits or restricts that use in some capacity" (GAO-25-107653, July 2025).

Source: MESSAGING.md, all Checked.

### What it does

**1. One sentence to a model and an app.** You type what you want. Muse Muse is built to turn it into a plan and training data, tune a model on a rented GPU, check it blind against the base model on prompts it never saw, make a file small enough for a device, and build an app around it. Each step carries a mark on `/offline`:

| Step | Mark | What ran |
|---|---|---|
| One sentence to a plan and data | Proven, by harness | 900 rows to train on and 100 kept aside, for an invented hobby, $0.22. The one-box page hasn't started a real run |
| A tuned model on a rented GPU | Proven, by harness | Llama 3.2 3B on a Lambda A10, about 18 minutes. Separately, the lab's own flow tuned Muse Glimmer 30B on an A100 in 42 minutes for $1.39 |
| A blind check against base | Proven, by harness | Muse Wonder judged 100 of 100 blind: tuned 6.67, base 2.55, tuned won 95 to 5. The topic is invented, so base starts knowing nothing, which makes it an easy test. The Glimmer run won 40 of 40, 8.88 to 1.95, judged by Muse Spark 1.3 |
| A file small enough for a device | Proven, by harness | The real quantize recipe, made-up data: a tuned small Llama became a 2.02 GB file and passed every check; a tuned Glimmer became a 6.53 GB one-bit file |
| On your own hardware | Simulated | A simulated board only, for this flow |
| An app built for it | Proven | Test builds on the test model with made-up data, on a local site with no live link |
| That app answering with its tuned model | Not run yet | Planned behind a flag. Products answer on Muse Wonder until their model passes and is served |
| Checks showing what was proven | Proven | Typecheck, build, a smoke test Muse Code wrote, and a judge reading screenshots. The judge is one check of four |

The steps haven't run as one chain yet. Source: STORY.md.

**2. Muse Privacy.** Muse can reach your files through connectors, but what it reads lands in its cloud computer, names and all. Muse Privacy is a connector that runs on hardware you own. Muse plans with tags like [Student A] and never gets the documents. A model on the device does every step that touches them, a policy file decides what can leave, and a final check runs on every result before it leaves.

- On 300 invented items on a laptop, with today's router: 0 leaks of names or identifiers.
- An earlier run, Oct 30, had 10 leaks on 200 items. The cause isn't recorded and the set hasn't been rerun (`privacy/eval/reports/device_only_fresh_200.md`).
- It agreed with the expected decision 82.0% of the time on 200 items and 81.0% on 100 tasks, but 65.0% (13 of 20) on the holdout items inside those tasks.
- It asks too often: 76 approval requests on the 200 items, 28 needless. 5 results were shared that should have waited.
- "Leaks" counts names and identifiers. A summary can still point at someone without naming them.
- No real users, the sealed test set hasn't been scored, the attacks are hand-written, and the device model is Liquid's LFM3-VL-2B, not a Meta model.

Meta's cookbook already has a local agent that asks before each send ("Local agent that asks first"). The difference here is that a policy file decides, and a router learns from what was approved before. It shares the idea in Meta Engineering's PrivacyLib post: "The access decision does not depend on the agent behaving as intended." The check sits at the exit, outside the model. A toggle doesn't make anyone legally covered.

Source: STORY.md, privacy paragraph; MESSAGING.md, Checked rows and point 1.

**3. On a Jetson.** Meta's smallest Glimmer files are 16.8 GB and 19.7 GB. By hand, the knowledge run's Glimmer (r30b), cut to one-bit size (IQ1_S, 5.75 GB), runs on a real Jetson Orin Nano 8GB, about a third the size of Meta's smallest file. Here's the cost: 5 to 6 tokens a second with weak answers. On 40 invented receipts it gave no valid JSON, and the board stopped answering at receipt 23. r30b is a Derivative of Muse Spark Open: Built with Muse Spark Open, 18 and over. Nothing the one-sentence flow made has run on a board.

Source: MESSAGING.md, quantization row (Checked) and point 3; STORY.md, device-file row.

**Under all three: the build platform.** Muse Code runs headless in a Vercel Sandbox microVM and writes a Next.js app from a template. The checks run, and failures go back to the same Muse Code session with the judge's screenshots, up to three rounds. Apps reach Meta only through a metered gateway, each with its own scoped, budgeted token, and the sandbox firewall adds the Meta key only on Muse Code's own routes. Every app gets a demo video cut from its own passing test, with model waits sped up and labeled. Source: README.md and BUILD_LOG.md.

### How it uses Meta's models

| Model or tool | Where |
|---|---|
| **Muse Wonder 1.0** | The default for briefs, builds, fix rounds, judging and products when `BUILDS_ON_CONTRIBUTOR` is off. It judged the harness's blind check (100 of 100, $1.54). Check production before submitting: the site runs on Contributor until someone flips it (docs/JUDGING_WEEK.md) |
| **Muse Spark 1.3 Contributor** | The live site's model while `BUILDS_ON_CONTRIBUTOR` is on, and the test model for test builds with made-up data. Meta may train on contributor prompts, so products on it show a notice |
| **Muse Spark 1.3** | Wrote the lab's first dataset (400 examples for $1.51) and judged both lab runs. Not used since Oct 29 |
| **Muse Code** | Writes every app headless: `muse exec --json` with hardened flags, `--session-id` to resume for fix rounds, `--image` for screenshots, and `muse export --redacted` for each app's "How it was built" |
| **Muse Glimmer 30B** | The tuned student: QLoRA on rented GPUs, judged blind against base, quantized to one-bit files. Its knowledge-run version runs on a Jetson |
| **Muse Spark Open** | r30b is a Derivative of it |
| **Llama 3.2 3B** | The harness's small model, tuned and quantized to a 2.02 GB file |
| **Muse Image 1.0, SAM 3.1, Muse Voice Transcribe 1.0** | Inside apps: making and editing images, finding and outlining things in photos and video, and speech to text |
| **Meta Model API** | `responses`, `images/generations`, `images/edits`, `files` and `asr/transcribe`, which apps reach only through the gateway |
| **Meta's docs** | The post-training guide's check against base on a held-out set, which the blind check follows (its general-benchmark half isn't built yet). The quantization docs for the 16.8 GB size. The cookbook's "Local agent that asks first", the closest Meta pattern to Muse Privacy |

### What was hard

1. **Keeping the key away from generated code while Muse Code still works.** Muse Code holds a per-sandbox placeholder, and the firewall swaps it for the real key on four routes only. Every other request to `api.meta.ai` gets a 403.
2. **Muse Code with nobody watching.** Its launcher tries to self-update from a blocked host and may start a device sign-in, so the runner turns both off. Its own sandbox can't run in the microVM, so the VM is the boundary. Fifteen bundled skills fought the template, so the snapshot turns them off.
3. **Honest cost.** `run.usage` counts only the main agent. Reminder agents were 31% to 43% of each build's real Muse Code spend, so the platform reads Muse Code's session logs and charges them.
4. **A fair blind check.** The first real Glimmer run lost 28 to 11. The cause was an eval bug: training put every answer on Glimmer's final channel, but the eval let the model choose, and the tuned answers never left the reasoning channel. After the fix, tuned won 40 of 40.
5. **GPUs that bill by the hour.** Three things terminate every instance: the job's workflow, the instance's done callback, and a sweep every 5 minutes. Jobs won't launch unless the sweep ran in the last 15 minutes.
6. **One-bit files that still answer.** One-bit size costs a lot: tuned Glimmer at IQ1_S answered 8.1% of new-knowledge probes, against 29.9% at Q4_K_M. A KL limit leaves out a file that drifts too far from its source.

Source: BUILD_LOG.md and README.md; item 6, STORY.md and `lib/story/flow.ts`.

### Results

**Tuning and files** (STORY.md and `lib/story/flow.ts`)

- Llama 3.2 3B, through the test harness: tuned 6.67 against base 2.55, won 95 of 100, judged blind by Muse Wonder for $1.54. An invented topic, which is an easy test.
- Muse Glimmer 30B, the lab's own flow: A100, 42 minutes, $1.39. Tuned won all 40 held-out prompts, 8.88 against 1.95, judged by Muse Spark 1.3. Results are public and read-only at `/fine-tuning`.
- A Nov 1 Glimmer run through the harness also won 40 of 40, 7.93 against 2.5 (PROVE_RESULTS.md). Hold this one until the owner settles the training-data question (docs/DATA_RIGHTS.md): its rows were written by Muse Spark 1.3 Contributor.
- Quantized, made-up data: a 2.02 GB Llama file that passed every check, and a 6.53 GB one-bit Glimmer file.

**Builds** (README.md, BUILD_LOG.md, PROVE_RESULTS.md)

- Oct 27, a local batch: 24 of 24 builds passed their checks, at 3 to 9 minutes and about $0.30 to $1.80 each. Local runs stop before the deploy step, so none of these 24 was deployed.
- Oct 28, on the live site: 9 of 10 catalog rebuilds went live, including all 6 of Meta's videos, for $24.70 in total. The Muse Wonder first demo failed its smoke test in all 3 fix rounds.
- Oct 28, the Meta look: the same 11 ideas rebuilt on a Meta-style template. Three judges compared each pair blind, and the new builds won 30 of 33 votes, 7.17 against 5.53.
- Nov 1, on the test model with made-up data: 11 recipes across 8 builds passed their smoke tests and the judge. Previews don't publish, so they have no live link.

**Muse Privacy** and **the Jetson**: the numbers in "What it does" above.

### What isn't proven yet

- The chain as one run, from a sentence to an app answering with its own tuned model.
- Anything the one-sentence flow made, running on a real board. Its board step is simulated.
- Platform launch of a tune, https callbacks, the sweep and Hugging Face upload from the site. The upload is built and tested against a fake Hub only.
- A general-capability or safety check on a tune. The blind check covers the task only.
- Muse Privacy with real users, on its sealed test set, or inside the real Muse app. The cause of the Oct 30 leaks.
- A finished long build on Muse Wonder.

Source: STORY.md marks; PROVE_RESULTS.md, "Not proven anywhere"; MESSAGING.md, Gaps.

### What's next

- One paid end-to-end chain run, so the steps above run as one.
- A tuned model served as an app's own backend, and that app answering from it.
- A general set and a safety set in the blind check, to follow Meta's guide in full.
- A network capture for Muse Privacy: plant a string, record every outbound request, and show whether it goes out.
- A name of its own. Muse is Meta's brand, so Muse Muse is a hackathon codename.

### Built during the event

Before kickoff there was only a scaffold, committed exactly as received in `e3ba154`: design docs, the Meta model catalog, prompt drafts, the template's rules and skills, types, the database schema, config, and route stubs that returned 501. All working code was written from Oct 26 on. An Oct 27 audit found five small scaffold helpers still in use and rewrote them the same day. The README's Status section has the details.

## 3. Video

The script and shot list are in [VIDEO.md](VIDEO.md): three acts, 2:50, with a 2:30 cut. Shots that need the chain run, or Hussam's Jetson footage, are tagged and have fallbacks.

## 4. Checklist

### Done

- [x] **Live site**, open with no sign-in (`OPEN_ACCESS=guest`). Every visitor shares one guest account with a daily build cap, and a platform-wide daily spend cap stops builds and gateway calls.
- [x] **Fine-tuning results**, public and read-only at `/fine-tuning`.
- [x] **Repo docs.** The README has what it does, an architecture diagram, setup, and what existed before kickoff.
- [x] **Outside quotes checked** on their primary sources (MESSAGING.md, Nov 2).
- [x] **Video script and shot list**, drafted (VIDEO.md).

### Left (steps and times in docs/HANDOFF.md, "Waiting on the owner")

- [ ] Pick the demo story, then take "DRAFT" off this file and VIDEO.md.
- [ ] Approve or skip the end-to-end chain run. Without it, the video uses the fallbacks.
- [ ] Read the `/privacy` and `/terms` draft and turn on `TRUST_LEGAL_PAGES`.
- [ ] Pick a LICENSE.
- [ ] Before the repo goes public: change the fleet's ngrok domain, confirm the rented GPU machines are terminated, settle Hugging Face visibility (PR #46), and rotate keys.
- [ ] The training-data rights question (docs/DATA_RIGHTS.md).
- [ ] Production settings for judging: Contributor or Wonder, and the daily spend cap.
- [ ] Turn on `STORY_PAGES` before recording.
- [ ] Hussam's Jetson shots, then record and upload the video.
- [ ] Fill in the form from section 1, and add any field it asks that isn't there.
