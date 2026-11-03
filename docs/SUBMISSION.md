# Muse Muse submission

Rewritten Nov 2, 2026, on branch tg-submission-fields (from `e4beadc1`, main plus the edge track), around the real form. The field drafts came from a read of the public event pages and every doc they cite; the form itself needs a sign-in, so Ethan checks the order and wording when opening it and adds anything missing here.

Meta Global AI Developer Hackathon. Startup track ("Judged on technical execution and whether it holds up in production"). Due Wed Nov 4, 2026, 9 PM ET; Ethan submits by noon ET.

Every answer below names its source. A claim is allowed only if a Checked row in [MESSAGING.md](MESSAGING.md), a mark in [STORY.md](STORY.md) or a logged run in [BUILD_LOG.md](BUILD_LOG.md) allows it. Anything that hasn't run says "is built so". Answers that must change later carry one of these tags:

- **[after the chain run]**: change it once the approved chain run (O2 in [EDGE_PLAN.md](EDGE_PLAN.md)) is logged in BUILD_LOG.
- **[after the board take]**: change it once the board runs (M10, M11, M12 in EDGE_PLAN.md) are logged.
- **[owner]**: only Ethan or Hussam can answer it.

## What the organizers said

**Meta models only (Discord, Nov 2, 3:57 PM; MESSAGING.md, "What the rules say").** Llama does not count as a Meta model here, and every model the project calls at runtime must be Meta's, helpers included. So no answer below credits Llama, LFM, Bolt or any other non-Meta model with project work, and their numbers are not project results. The edge model is built to be Muse Glimmer one-bit, and Muse Privacy runs Muse Glimmer in the cloud on invented data.

Nov 2, from the organizers:

> "Judges mainly work from your 3-minute demo video and your public GitHub repo, so the video is the core of the demo. Judges may also try the project themselves, using their own keys if needed, so the repo must run from its setup instructions. A hosted demo is optional."

What that means for us:

1. **The video carries the score.** The script is [VIDEO.md](VIDEO.md), with the edge act approved (O1 and O6, yes).
2. **The repo has to be public by submission**, and has to run from the README. The going-public plan is in [HANDOFF.md](HANDOFF.md), "Going public".
3. **The README's setup has gaps** (a clean-clone test on Nov 2):
   - The first Quickstart command is Docker, and the README itself says the image "has not been built or run yet".
   - With no keys, `npm ci && npm run dev:local` opens the site (every page returned 200, but a local run starts empty), and the Node and Muse Privacy test suites pass.
   - To make one product, a judge needs a Meta key (`MODEL_API_KEY`) **and** a Vercel account linked for Vercel Sandbox. With only a Meta key, the build pays for a brief and then fails at provisioning. `BUILDER_SNAPSHOT_ID` is optional locally (a slower first build).
   - The edge drills are now in the repo (`template/scripts/edge-drill.mjs`) and run with no keys against a fake edge server; the README doesn't mention them yet. Each test file's header has its command, for example `npx tsx --test template/scripts/__tests__/edge-drill.test.mjs`.
   - Fixing the README is a separate unit. Until it lands, don't write in any field that a judge can build a product with only a Meta key.
4. **The live site is optional.** It stays up as a bonus: https://muse-muse.vercel.app

## Two headlines

Both go in the description and the video, side by side.

**The frontier.** Muse Muse is built so one sentence becomes a tuned model you keep, inside an app built for it, with marks that show what was proven. (STORY.md, the frontier claim. "Is built so" until the chain has run as one.)

**The edge, and defending infrastructure.** Muse Muse is built so the app it makes can keep answering on a Jetson when the cloud is cut, and flag a controller reading that disagrees with an independent probe. Our scenario is a simulated cold room. (EDGE_PLAN.md, "When each claim may be said"; MESSAGING.md, "Edge facts, Nov 2".)

The why, in our words: infrastructure has to be ready for any scenario, including the day the cloud is out of reach or a controller can't be trusted. Never say the app stops hacks, is attack-proof, works offline in general, or answers privately or on-device.

## The form, field by field

### 1. Team Name

> Offline Base

Source: CLAUDE.md ("Offline Base's entry"). "Muse Muse" is the project's codename, not the team name.

### 2. Team Members  [owner]

> Ethan Castro (Representative, submits)
> Hussam Ali (GitHub hussam2444)

- **Both names must be listed.** When the owner opened the form, only Hussam showed. Add Ethan too, or the form lists one of two members.
- Confirm Hussam's surname with Hussam before submitting. The docs say only "Hussam"; "Ali" comes from the author name on one of Hussam's commits.
- Source: the Official Rules ask the Representative to "identify all other team members in the project submission", and on the startup track the Representative "must be an active employee of the startup" (MESSAGING.md, "What the rules say").

### 3. Track

> Startup

Source: the event page; README.md.

### 4. Which problem statement did you build towards?

> Push the Frontier

Why: the pages never say "problem statement". The rules' Impact line asks "whether it fits one of the problem statements", and the only candidates are the two themes. Both headlines land on Push the Frontier's own words: "Give a machine a new capability" (a sentence becomes a tuned model on a small board) and "unlock a better way to understand and control a physical system ... when these models meet the real world" (the cold-room watcher). Build for Your World fits only Muse Privacy. Source: MESSAGING.md, the Push the Frontier row (Checked).

### 5. Most Viral: X post link  [owner] [after the board take]

> PLACEHOLDER: the X post's URL

- **What it is.** The public pages name a "most viral project award" only inside the Bonus Prizes clause (up to $50,000 in all, announced on or about Nov 10). There are no published rules on what counts, no tags or handles, and no deadline for the post. The rules say a project enters "one (1) track only", so this reads as a bonus award, not a second track. Ask on Discord if the form makes it look like one.
- **The post has to exist before Ethan submits** (Wed noon ET), since its link goes in the form.
- **The video.** The 60-second cut in [VIDEO.md](VIDEO.md), "The 60-second X cut": shot 1 (or its fallback), E2 if the tune ran, E3a (cables out), then shot 12's URL card, with the same labels and lower third. If the take (M12) hasn't happened, E3a falls back down the ladder in EDGE_PLAN.md: at level 4, shot 10 plus a "Simulated outage" card.
- **Post text, before the take:**

  > One sentence becomes a tuned model you keep, and an app built for it. We built Muse Muse for Meta's AI Developer Hackathon. Its edge act: a simulated cold-room watcher that is built so it keeps answering on a Jetson when the cloud is cut. Code: https://github.com/Offline-Base/muse-muse

- **Post text, after the take** (N and X from that take only):

  > One sentence becomes a cold-room watcher. Muse Muse built it on Meta's cloud models, and this app kept answering on one Jetson with its network unplugged, N of 5 drills, X tokens a second. Simulated cold room, real board, real unplug. Code: https://github.com/Offline-Base/muse-muse

- Check the post against every line of MESSAGING.md "Don't say", the edge lines included. No news logos or footage; the rights grant (section "Before you tick the rights box") covers the post too.

### 6. Project Description  [after the chain run] [after the board take]

Paste version A today. Swap in each B line only after its run is logged in BUILD_LOG.md.

> Muse Muse is built so one sentence becomes a tuned model you keep, inside an app built for it, with marks that show what was proven.
>
> **The frontier.** Meta now offers frontier cloud models and open models for local use. Muse Muse explores whether one person can move between them, shape the result, and leave with something they control. Muse Code writes each app headless in a Vercel Sandbox microVM, and the platform runs typecheck, build, a smoke test and a screenshot judge on it, with up to three fix rounds. Muse Glimmer 30B, tuned on a rented A100 in 42 minutes for $1.39, beat base Glimmer on all 40 held-out prompts in a blind check judged by Muse Spark 1.3, 8.88 to 1.95. On a test harness with made-up data, the real quantize recipe cut a tuned Glimmer to a 6.53 GB one-bit file. By hand, a one-bit Muse Glimmer (5.75 GB, about a third the size of Meta's smallest 16.8 GB file) runs on a Jetson Orin Nano 8GB, at 5 to 6 tokens a second with weak answers. Built with Muse Spark Open.
>
> **The edge, and defending infrastructure.** Building for any scenario includes the day the cloud is out of reach or a controller can't be trusted. On Nov 2, supermarkets across Europe reported suspected freezer hacks, and the Pentagon is treating freezer failures at at least six commissaries as a suspected cyberattack. Muse Muse is built so a sentence like "watch this cold room" becomes an app that reads a controller, an independent probe, the door, defrost and power, flags a reading that disagrees with the probe, and falls back from Meta's cloud models to Muse Glimmer, cut to one bit, on a Jetson when the cloud fails. The cold room and its readings are simulated.
>
> **What is true today.** The cloud-to-edge fallback, the edge target, four outage drills (cloud refused, cloud hung, both down, tampered reply rejected) built to run inside each edge build, the board build script and the drill data (900 training rows, 50 kept aside, 100 sealed) are built and unit-tested, with flags off. None has run in a real build or on a board yet.
>
> **What isn't proven.** The chain hasn't run as one, and nothing the one-sentence flow made has run on a board. Muse Privacy is a separate connector, measured only on invented items, with Muse Glimmer 30B in the cloud: an earlier version had 0 leaks of names or identifiers on 100 items (Oct 27). [pending rerun on Glimmer] for today's setup.

B lines (EDGE_PLAN.md, "When each claim may be said"), each replacing the matching "is built so" or "isn't proven" words:

- After the chain run (O2): the frontier paragraph's harness numbers become the chain run's own, and "The chain hasn't run as one" comes out. Use STORY.md's marks as they stand after the run.
- After one real edge build has run its drills (M7 with M5): "Every edge build runs four simulated outage drills before it ships."
- After M8 (planned only if Hussam's schema gate on jetson-02 passes and the owner approves the spend): "Tuned on the scenario's invented data, Muse Glimmer 30B one-bit (IQ1_S) scored [X] against base [Y] on 100 sealed held-out items, scored by code." If tuned didn't beat base, say both numbers.
- After M10 or M11: "On jetson-02, Muse Glimmer 30B one-bit (IQ1_S) scored [X] on 100 invented held-out items, at [N] tokens a second." Add "tuned" only once a tuned run is logged. If the gate fails, the board fallback is fixed code (thresholds plus the probe-disagreement rule, no model): say that, and give no model score for the board.
- After M12: "This app kept answering on one Jetson with its network unplugged, [N] of 5 drills, [X] tokens a second." Then STORY.md's "On your own hardware" mark may move up, and "nothing the one-sentence flow made has run on a board" comes out.

Sources: SUBMISSION "One line" (STORY.md); MESSAGING.md point 4 and rows 16 and 23; STORY.md marks; MESSAGING.md "Edge facts, Nov 2" (Bloomberg's "suspected", Reuters' "at least six commissaries"); EDGE_PLAN.md unit status; commits `a4e191b1`, `e81e6f66`, `193a1c30`, `5c679d87`. Muse Privacy gets one line here so both headlines fit; its full write-up is under "Muse Privacy, in full" below. The "0 leaks on 300" and "Oct 30: 10 leaks on 200" numbers were measured with LFM3-VL-2B, which isn't a Meta model, so they are out of the submission. Muse Privacy's numbers come only from runs on Glimmer.

### 7. Public GitHub Repository  [owner]

> https://github.com/Offline-Base/muse-muse

- **Still private.** Make it public before submitting, by the plan in HANDOFF.md, "Going public": a fresh public repo with history rewritten by `git filter-repo`. The owner runs the commands.
- Before that, owner to-dos 4 to 7 in HANDOFF.md (LICENSE, ngrok domain and GPU machines, data rights, Hugging Face visibility).
- Merge the edge track (`tg-edge`) first, or the edge lines have no code behind them in the public repo.
- Judges may run it with their own keys, so fix the README gaps above first.

### 8. 3-Minute Demo Video  [owner] [after the chain run] [after the board take]

> PLACEHOLDER: the YouTube link

The cut with the edge act runs about 2:54 (VIDEO.md, "Proposed revision: the edge act", now approved). Every edge shot says "Simulated" somewhere on screen.

### 9. Describe your use of Meta products

> **Muse Wonder 1.0** writes briefs, builds, fix rounds and judging. **Muse Spark 1.3 Contributor** is the test model for builds with made-up data. **Muse Spark 1.3** wrote the lab's first dataset and judged the lab runs. **Muse Code** writes every app headless (`muse exec --json`, `--session-id` for fix rounds, `--image` for screenshots, `muse export --redacted` for each app's build story). **Muse Glimmer 30B** was QLoRA-tuned on rented GPUs, judged blind against base and cut to one-bit files, one of which runs on a Jetson. One-bit Glimmer is the edge model the cold-room watcher is built to fall back to, and Glimmer 30B does Muse Privacy's steps on invented data, in the cloud. **Muse Spark Open** wrote training data, so that Glimmer (r30b) is a Derivative of it. **Muse Image 1.0, SAM 3.1 and Muse Voice Transcribe 1.0** run inside apps. The **Meta Model API** (`responses`, `images/generations`, `images/edits`, `files`, `asr/transcribe`) is reached only through a metered gateway, and generated code never sees the key. **Meta's docs:** the blind check follows the post-training guide's held-out comparison.

Source: the model table under "How it uses Meta's models" below; EDGE_PLAN.md for Glimmer's edge role. Before submitting, check whether production is on Wonder or Contributor (HANDOFF.md, to-do 9). [after the chain run]: add what the chain run used.

### 10. Why are Meta's models important to your solution?

> The project works only because Meta offers both ends. The cloud models (Muse Wonder, Muse Code) do the heavy work once: planning, writing the app, judging. The open model (Muse Glimmer) is what comes out, a file you keep. Meta's Glimmer docs put it as "you own the weights, the runtime, and the data". For infrastructure that has to keep working when the cloud doesn't, that matters: Meta's smallest Glimmer file is 16.8 GB, we cut one to 5.75 GB so it fits an 8 GB Jetson, slowly, and the app is built to fall back to it there. One vendor's models on both sides means one prompt style, one tool-call shape and one set of licenses, from the sentence to the board.

Source: MESSAGING.md rows 13, 16 and 23; STORY.md, alignment paragraph. The last sentence is our framing, not a measured claim; cut it if you prefer.

### 11. Partner feedback: Fireworks, Modal, Baseten

> All three hosted Muse Spark Open, which wrote training data for our 2026-knowledge Glimmer. A 45-passage test batch passed on all three at about $0.005 a passage. Estimated spend from list prices: Fireworks about $100, Baseten $49, Modal $16.
>
> **Fireworks** carried the most, but rate-limited at about 96 concurrent requests, so about 290 passages were retried at lower concurrency. For training, it can't run our recipe or take our chat template, it refuses r30b adapters and regex target modules, and it has no plan or dry-run call: estimatedCost exists only on a created job. Free Glimmer SFT until Nov 30 is generous. Clearer terms would help: 2.2(c) and 3.3(v) (no "machine-generated content" in Input) are hard to square with distillation-style data.
>
> **Modal:** our plan credits didn't cover shared endpoints, so it rejected requests mid-run and Fireworks took its share. For hosting a tune, `modal app stop` exits 1 for an app that is already gone, and CLI output wraps at 80 columns, which can split the endpoint address. GPU Sandboxes can be preempted.
>
> **Baseten** handled its share (32,731 published rows) without a logged failure. Its deploy needs the Truss CLI, so we run it in a short-lived sandbox. It refuses a plain Glimmer adapter without a pinned full-weights commit.

Source: KNOWLEDGE_RUN_LOG.md (the batch, spend, rate limit and Modal credits); BUILD_LOG.md (the training and hosting notes); DATA_RIGHTS.md (Fireworks' terms and Baseten's rows). The logs don't say whether the $100 partner credits were used; add it if they were. [owner]

### 12. How likely are you to build with Meta Model API?  [owner]

An opinion, so pick it yourself. Facts that bear on it: about $33.52 of Meta plus sandbox spend of $150, in one Oct 31 entry (BUILD_LOG.md); a 64-minute Wonder build for $16.55 that didn't finish (BUILD_LOG.md); 9 of 10 catalog rebuilds went live for $24.70 ("Results" below).

### 13. Overall opinion of Meta Model API  [owner]

An opinion. Supporting facts: the scoped per-app tokens and the gateway worked as designed. The pain points are in the survey answers below.

### 14. Optional survey

- **Recommend Meta Model API / Muse Code:** [owner] scores.
- **Biggest obstacle:**
  > Running Muse Code with nobody watching. Its launcher tries to self-update from a blocked host and may start a device sign-in, its own sandbox can't run in a microVM, and 15 bundled skills fought our template. Also, `run.usage` counts only the main agent, while reminder agents were 31% to 43% of real spend.
- **How Meta's models compared:**
  > Tuned Glimmer won 40 of 40 against base in the cloud. On an 8 GB Jetson, one-bit Glimmer answers short chats at 5 to 6 tokens a second, but gave no valid JSON on 40 invented receipts without a schema, and the board hung at receipt 23. Glimmer is the right size in the cloud, and not yet reliable on 8 GB.

  Source: STORY.md; MESSAGING.md point 3. [after the board take]: add the one-bit Glimmer board numbers from M10 or M11, only once logged.
- **What matters most when choosing:** [owner]. Suggested: a license we can ship, weights we own, and cost we can see per call.
- **What makes switching hardest:**
  > Chat templates and output channels. Our first Glimmer eval lost 28 to 11 because answers stayed on the reasoning channel, and hosts differ on whether they take a template.
- **What would stop production use:**
  > Model API Terms 10.1(ix) leave "competes" undefined for tuning Meta's own open models on API outputs, and the Contributor tier may train on prompts.

  Source: DATA_RIGHTS.md Q2; the Muse Spark 1.3 Contributor row below.

### Before you tick the rights box  [owner]

The grant is perpetual, irrevocable, worldwide and royalty-free, and covers "the Submission for any purpose without restriction", marketing included (DATA_RIGHTS.md; the event rules). The repo, the video and the X post all count. Before ticking:

- Settle DATA_RIGHTS.md Q1 to Q3 for any model the video or description features. If Q2 is no, drop the Nov 1 Glimmer result (7.93 against 2.5).
- Pick a LICENSE (HANDOFF.md, to-do 4).
- Keep news logos and footage out of the video and the post. Quote the news as text, with credit and "suspected".
- Don't name any judge.

### Lines left out, and why

- An "Open Weights prize" naming Glimmer or Spark Open: no such prize is on the public pages. Find its source before saying it anywhere.
- "Works offline", "private" or "on-device" for board answers, "stops hacks", "attack-proof", and anything about surviving a power loss (MESSAGING.md, "Don't say").
- The DC substation outage as an attack. Pepco: "no indication of foul play".
- PR #67's on-board tune: it tuned Llama, which isn't a Meta model here, so it is out of the submission. Don't say anything in the project was tuned on a board.
- Bolt, LFM or Llama numbers as project results, and "device-only" or "nothing leaves the device" for Muse Privacy while its submitted path is cloud Glimmer (MESSAGING.md, "Don't say").

## Reference for the answers

The longer write-up the fields draw on. Same rules: if a mark changes, change the line here.

### The problem

> "People are starting to be able to manifest ideas themselves without having to raise money or build large teams."
> Mark Zuckerberg, "The Future is for Everyone", Aug 10, 2026

Meta now offers frontier cloud models and open models for local use. Muse Muse explores whether one person can move between them, shape the result, and leave with something they control. Going from a sentence to a model that's yours still takes data, a GPU, a fair test against the base model, a file small enough for a device, and an app around it.

Some of that work can't go to any cloud. Johns Hopkins Bayview notified 3,182 patients after a worker uploaded a patient spreadsheet to an AI tool the hospital hadn't approved. GAO found that "all 12 selected agencies that allow the use of generative AI reported that the agency limits or restricts that use in some capacity" (GAO-25-107653, July 2025).

Source: MESSAGING.md, all Checked.

### The chain, step by step [after the chain run]

| Step | Mark | What ran |
|---|---|---|
| One sentence to a plan and data | Proven, by harness | 900 rows to train on and 100 kept aside, for an invented hobby, $0.22. The one-box page hasn't started a real run |
| A tuned model on a rented GPU | Proven, by harness | The lab's own flow tuned Muse Glimmer 30B on an A100 in 42 minutes for $1.39. A test harness also tuned the 2026-knowledge Glimmer on the invented hobby, 120 steps on an H100 |
| A blind check against base | Proven, by harness | Muse Spark 1.3 judged the lab's tuned Glimmer blind against base on 40 held-out prompts: tuned won all 40, 8.88 to 1.95. The task only, not general skill |
| A file small enough for a device | Proven, by harness | The real quantize recipe, made-up data: a tuned Glimmer became a 6.53 GB one-bit file |
| On your own hardware | Simulated | A simulated board only, for this flow [after the board take] |
| An app built for it | Proven | Test builds on the test model with made-up data, on a local site with no live link |
| That app answering with its tuned model | Not run yet | Planned behind a flag. Products answer on Muse Wonder until their model passes and is served |
| Checks showing what was proven | Proven | Typecheck, build, a smoke test Muse Code wrote, and a judge reading screenshots. The judge is one check of four |

The steps haven't run as one chain yet. Source: STORY.md.

### The edge track [after the board take]

| Piece | State on `e4beadc1` |
|---|---|
| Cloud-to-edge fallback (`template/lib/meta/edge.ts`) | Built, unit-tested. The cloud first with a 10 s limit, then an OpenAI-compatible edge server, checked against a schema. A cloud that turns a request down is the answer; the board isn't asked around it |
| Outage drills (`template/scripts/edge-fake.mjs`, `edge-blackhole.mjs`, `edge-drill.mjs`) | Built, unit-tested on loopback with a fake model: cloud refused, cloud hung, both down, tampered reply rejected |
| Edge target and a drill inside every edge build | Built, unit-tested with the sandbox faked. Not run in a real build |
| Board build (`scripts/edge/build-arm64.sh`, `docs/EDGE_DEMO.md`) | Built. Syntax-checked only; the Docker build hasn't run |
| Drill data (`scripts/dev/drill-bench.py`) | Built. Simulated cold-room windows written by code from a fixed seed: 900 training rows, 50 kept aside, 100 sealed held-out, scored per field by code, with a rule that a controller that disagrees with the probe by more than 3.0 C is never trusted |
| Muse Glimmer 30B one-bit (IQ1_S) as the edge model on jetson-02 | Not run. Hussam's $0 schema gate comes first. A cold-room tune of Glimmer is planned only if it passes. If it fails, the board fallback is fixed code (thresholds plus the probe-disagreement rule, no model) |
| The cut on camera | Not run |

All behind `EDGE_ENABLED` and `EDGE_BUILDS`, off by default. Source: EDGE_PLAN.md, EDGE_DEMO.md.

### Muse Privacy, in full

Muse can reach your files through connectors, but what it reads lands in its cloud computer, names and all. Muse Privacy is a connector you run yourself, and its policy file stays with you. Muse plans with tags like [Student A] and never gets the documents. For the submission, Muse Glimmer 30B does every step that touches them, in the cloud through OpenRouter, on invented data only. Glimmer on your own device is the target, not a result. A policy file decides what can leave, and a final check runs on every result before it leaves.

- Today's setup on Glimmer: [pending rerun on Glimmer]. Leaks, decision accuracy, approval requests and the holdout all wait on that run.
- An earlier version on Glimmer through OpenRouter (Oct 27, `privacy/eval/reports/final.md`): 0 leaks of names or identifiers on 100 invented items, with the router right 76% of the time on those 100 and 75% on the holdout. Cloud numbers on an earlier code state, not today's setup.
- "Leaks" counts names and identifiers. A summary can still point at someone without naming them.
- No real users, the sealed test set hasn't been scored, and the attacks are hand-written.

Meta's cookbook already has a local agent that asks before each send ("Local agent that asks first"). The difference here is that a policy file decides, and a router learns from what was approved before. It shares the idea in Meta Engineering's PrivacyLib post: "The access decision does not depend on the agent behaving as intended." The check sits at the exit, outside the model. A toggle doesn't make anyone legally covered.

Source: STORY.md, privacy paragraph; MESSAGING.md, Checked rows and point 1.

### On a Jetson

Meta's smallest Glimmer files are 16.8 GB and 19.7 GB. By hand, the knowledge run's Glimmer (r30b), cut to one-bit size (IQ1_S, 5.75 GB), runs on a real Jetson Orin Nano 8GB, about a third the size of Meta's smallest file. Here's the cost: 5 to 6 tokens a second with weak answers. On 40 invented receipts it gave no valid JSON, and the board stopped answering at receipt 23. r30b is a Derivative of Muse Spark Open: Built with Muse Spark Open, 18 and over. Nothing the one-sentence flow made has run on a board.

Source: MESSAGING.md, quantization row (Checked) and point 3; STORY.md, device-file row.

### Under all of it: the build platform

Muse Code runs headless in a Vercel Sandbox microVM and writes a Next.js app from a template. The checks run, and failures go back to the same Muse Code session with the judge's screenshots, up to three rounds. Apps reach Meta only through a metered gateway, each with its own scoped, budgeted token, and the sandbox firewall adds the Meta key only on Muse Code's own routes. Every app gets a demo video cut from its own passing test, with model waits sped up and labeled. Builds run in Vercel Sandbox; Modal is added as a second host behind a flag, smoke-tested on Modal with no full build there yet. Source: README.md, BUILD_LOG.md and MODAL_HOST.md.

### How it uses Meta's models

| Model or tool | Where |
|---|---|
| **Muse Wonder 1.0** | The default for briefs, builds, fix rounds, judging and products when `BUILDS_ON_CONTRIBUTOR` is off. Check production before submitting: the site runs on Contributor until someone flips it (docs/JUDGING_WEEK.md) |
| **Muse Spark 1.3 Contributor** | The live site's model while `BUILDS_ON_CONTRIBUTOR` is on, and the test model for test builds with made-up data. Meta may train on contributor prompts, so products on it show a notice |
| **Muse Spark 1.3** | Wrote the lab's first dataset (400 examples for $1.51) and judged both lab runs. Not used since Oct 29 |
| **Muse Code** | Writes every app headless: `muse exec --json` with hardened flags, `--session-id` to resume for fix rounds, `--image` for screenshots, and `muse export --redacted` for each app's "How it was built" |
| **Muse Glimmer 30B** | The tuned student: QLoRA on rented GPUs, judged blind against base, quantized to one-bit files. Its knowledge-run version runs on a Jetson, and one-bit Glimmer is the edge model the cold-room watcher is built to fall back to. It also does Muse Privacy's steps, in the cloud on invented data |
| **Muse Spark Open** | r30b is a Derivative of it |
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
7. **A fallback that doesn't route around a refusal.** The edge fallback is built to answer only when the cloud can't be reached or sent a reply that doesn't match its schema. A cloud that turned a request down (a refusal, a budget limit) is the answer, so the board isn't asked around it. And a cloud drill fails if the product never tried the cloud first, so a product can't pass the outage drills by skipping the cloud. Both are unit-tested, not run in a real build.

Source: BUILD_LOG.md and README.md; item 6, STORY.md and `lib/story/flow.ts`; item 7, commit `5c679d87` and EDGE_DEMO.md.

### Results

**Tuning and files** (STORY.md and `lib/story/flow.ts`)

- Muse Glimmer 30B, the lab's own flow: A100, 42 minutes, $1.39. Tuned won all 40 held-out prompts, 8.88 against 1.95, judged by Muse Spark 1.3. Results are public and read-only at `/fine-tuning`.
- A Nov 1 Glimmer run through the harness also won 40 of 40, 7.93 against 2.5 (PROVE_RESULTS.md). Hold this one until the owner settles the training-data question (docs/DATA_RIGHTS.md): its rows were written by Muse Spark 1.3 Contributor.
- Quantized, made-up data: a 6.53 GB one-bit Glimmer file.

**Builds** (README.md, BUILD_LOG.md, PROVE_RESULTS.md)

- Oct 27, a local batch: 24 of 24 builds passed their checks, at 3 to 9 minutes and about $0.30 to $1.80 each. Local runs stop before the deploy step, so none of these 24 was deployed.
- Oct 28, on the live site: 9 of 10 catalog rebuilds went live, including all 6 of Meta's videos, for $24.70 in total. The Muse Wonder first demo failed its smoke test in all 3 fix rounds. A Nov 2 audit found that none of those six fully teaches its lesson (2 wrong, 4 partly), so they now sit on the Learn page (/learn) with a plan to redo each, and are not claimed as rebuilds.
- Oct 28, the Meta look: the same 11 ideas rebuilt on a Meta-style template. Three judges compared each pair blind, and the new builds won 30 of 33 votes, 7.17 against 5.53.
- Nov 1, on the test model with made-up data: 11 recipes across 8 builds passed their smoke tests and the judge. Previews don't publish, so they have no live link.

### What isn't proven yet [after the chain run] [after the board take]

- The chain as one run, from a sentence to an app answering with its own tuned model.
- Anything the one-sentence flow made, running on a real board. Its board step is simulated.
- Any edge build in a real sandbox, any edge drill on a board, and one-bit Glimmer as the edge model on a board.
- Platform launch of a tune, https callbacks, the sweep and Hugging Face upload from the site. The upload is built and tested against a fake Hub only.
- A general-capability or safety check on a tune. The blind check covers the task only.
- Muse Privacy on today's setup with Glimmer (the rerun is pending), with real users, on its sealed test set, on a device, or inside the real Muse app.
- A finished long build on Muse Wonder.

Source: STORY.md marks; PROVE_RESULTS.md, "Not proven anywhere"; MESSAGING.md, Gaps; EDGE_PLAN.md.

### What's next

- One paid end-to-end chain run, so the steps above run as one (approved: O2).
- The cold-room watcher on a real board with its network unplugged (M12).
- A tuned model served as an app's own backend, and that app answering from it.
- A general set and a safety set in the blind check, to follow Meta's guide in full.
- A name of its own. Muse is Meta's brand, so Muse Muse is a hackathon codename.

### Built during the event

Before kickoff there was only a scaffold, committed exactly as received in `e3ba154`: design docs, the Meta model catalog, prompt drafts, the template's rules and skills, types, the database schema, config, and route stubs that returned 501. All working code was written from Oct 26 on. An Oct 27 audit found five small scaffold helpers still in use and rewrote them the same day. The README's Status section has the details. The going-public plan keeps commit dates, so this stays provable. Also before the event and not in this repo: Offline Base's Jetson fleet and its control software (`jetson-infra`, created Sep 29), the other companies' models some boards run (not part of the submitted project), and Base Drive (June). The README's "Before the event" lists them, and the video's opening line says so, as the organizers require (Discord, Nov 2).

## Checklist

### Done

- [x] **Live site**, open with no sign-in (`OPEN_ACCESS=guest`). Every visitor shares one guest account with a daily build cap, and a platform-wide daily spend cap stops builds and gateway calls.
- [x] **Fine-tuning results**, public and read-only at `/fine-tuning`.
- [x] **Outside quotes checked** on their primary sources (MESSAGING.md, Nov 2), edge facts included.
- [x] **Video script and shot list**, with the edge act (VIDEO.md; O1 and O6 yes).
- [x] **Every form field drafted** (this file).
- [x] **Edge track code**, built and unit-tested, flags off (`e4beadc1`).
- [x] **Lambda key rotated** (Nov 2).

### Left (steps in docs/HANDOFF.md)

- [ ] Add Ethan to Team Members, and confirm Hussam's surname.
- [ ] Fix the README's setup gaps, since judges may run the repo with their own keys.
- [ ] Merge the edge track, then make the repo public by the plan in HANDOFF.md, "Going public".
- [ ] Pick a LICENSE; settle DATA_RIGHTS.md Q1 to Q3; Hugging Face visibility.
- [ ] The chain run (O2) and the board runs (M10 to M12), then swap the tagged answers.
- [ ] Production settings for judging: Contributor or Wonder, and the daily spend cap. Turn on `STORY_PAGES` before recording.
- [ ] Record and upload the video; post the 60-second cut on X before Wed noon ET.
- [ ] Fill in the form from this file, field by field.
