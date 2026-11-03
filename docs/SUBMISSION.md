# Muse Muse submission

Rewritten Nov 2, 2026, on branch tg-submission-fields (from `e4beadc1`, main plus the edge track), around the real form. The field drafts came from a read of the public event pages and every doc they cite; the form itself needs a sign-in, so Ethan checks the order and wording when opening it and adds anything missing here.

Meta Global AI Developer Hackathon. Startup track ("Judged on technical execution and whether it holds up in production"). Due Wed Nov 4, 2026, 9 PM ET; Ethan submits by noon ET.

**Revised Nov 3, about noon ET, on branch tg-c-claims, as a draft for the owner to approve before merge.** From the readiness audit's claim fixes (items 7, 14, 15 and 17, and its story recommendation): Contributor is credited where it ran, Muse Privacy is said as cloud and invented data, the edge fallback is rules in code plus SAM 3.1 on the board (not one-bit Glimmer), Nov 3's proven results are added, the Hugging Face weights are kept apart from the app, and field 4 and the opening problem line have two versions, one per theme. The evidence for each new line is in docs/BUILD_LOG.md, "Nov 3, 2026, about noon ET: claim fixes".

Every answer below names its source. A claim is allowed only if a Checked row in [MESSAGING.md](MESSAGING.md), a mark in [STORY.md](STORY.md) or a logged run in [BUILD_LOG.md](BUILD_LOG.md) allows it. Anything that hasn't run says "is built so". Answers that must change later carry one of these tags:

- **[after the chain run]**: change it once the approved chain run (O2 in [EDGE_PLAN.md](EDGE_PLAN.md)) is logged in BUILD_LOG.
- **[after the board take]**: change it once tonight's board take (VIDEO.md, shot 7) is logged in BUILD_LOG.
- **[owner]**: only Ethan or Hussam can answer it.
- **[data rights]**: feature it only once the owner settles DATA_RIGHTS.md Q1 to Q3 for that model (its table "What each answer changes, by model"). Cut the line if the answer is no.

## What the organizers said

**Meta models only (Discord, Nov 2, 3:57 PM; MESSAGING.md, "What the rules say").** Llama does not count as a Meta model here, and every model the project calls at runtime must be Meta's, helpers included. So no answer below credits Llama, LFM, Bolt or any other non-Meta model with project work, and their numbers are not project results. The edge app's board fallback is rules in code plus Meta's SAM 3.1 on the board, not one-bit Glimmer: one-bit Glimmer runs on jetson-02 but called a 6 C controller and probe gap "ok" in every setup tried, "so the edge fallback stays rules in code" (BUILD_LOG.md, "Nov 3, 2026, 10:05 to 10:30 AM ET"). Muse Privacy runs Muse Glimmer in the cloud on invented data.

Nov 2, from the organizers:

> "Judges mainly work from your 3-minute demo video and your public GitHub repo, so the video is the core of the demo. Judges may also try the project themselves, using their own keys if needed, so the repo must run from its setup instructions. A hosted demo is optional."

What that means for us:

1. **The video carries the score.** The script is [VIDEO.md](VIDEO.md), with the edge act approved (O1 and O6, yes).
2. **The repo has to be public by submission**, and has to run from the README. The going-public plan is in [HANDOFF.md](HANDOFF.md), "Going public".
3. **The README's setup has gaps** (a clean-clone test on Nov 2):
   - The first Quickstart command is Docker, and the README itself says the image "has not been built or run yet".
   - With no keys, `npm ci && npm run dev:local` opens the site (every page returned 200, but a local run starts empty), and the Node and Muse Privacy test suites pass.
   - To make one product, a judge needs a Meta key (`MODEL_API_KEY`) **and** a Vercel account linked for Vercel Sandbox. With only a Meta key, the build pays for a brief and then fails at provisioning. `BUILDER_SNAPSHOT_ID` is optional locally (a slower first build).
   - The edge drills run with no keys against a fake edge server: `npm run drill` passed 11 of 11 on Nov 3 (BUILD_LOG.md, "Nov 3, 2026, 10:30 AM ET: demos in check for judges"), and the README's Judge path lists it.
   - Never write in any field that a judge can build a product, or write a brief, with only a Meta key: a brief is a build's first step, and without Sandbox credentials it is refused with `no_sandbox` (`buildSetupRefusal` in lib/quota.ts).
4. **The live site is optional.** It stays up as a bonus: https://www.musemuse.dev

## Two headlines

Both go in the description and the video, side by side.

**The frontier.** Muse Muse is built so one sentence becomes a tuned model you keep, inside an app built for it, with marks that show what was proven. (STORY.md, the frontier claim. "Is built so" until the chain has run as one.)

**The edge, and defending infrastructure.** Muse Muse is built so the app it makes can keep answering on a Jetson when the cloud is cut, flag a controller reading that disagrees with an independent probe by a rule in code, and keep watching the door with Meta's SAM 3.1 on the board. Our scenario is a simulated cold room. What has run: SAM 3.1 on a Jetson Orin Nano 8GB at 1.42 s a look, a SAM 3.1 tune on the same kind of board, and an edge build that passed all 8 simulated outage drills in its own build sandbox (BUILD_LOG.md, Nov 3 entries). The unplug itself is "is built so" until the board take is logged. (EDGE_PLAN.md, "When each claim may be said"; MESSAGING.md, "Edge facts, Nov 2".)

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

### 4. Which problem statement did you build towards?  [owner] [after the board take]

Two versions. The owner picks one tonight, and the opening problem line ("The problem", below) and the video's shot 2 follow the same pick.

**Version 1, Push the Frontier.** Use it if tonight's board take works (the app keeps answering on jetson-04 with the uplink out, or the backup: the app on the laptop with Wi-Fi off and SAM 3.1 on the board).

> Push the Frontier

Opening problem line for this version:

> Your own AI, on your own hardware, ready for any scenario. Shops, clinics and schools run equipment on the internet with no engineering team, and this fall suspected hacks shut down supermarket freezers across Europe. Muse Muse turns one sentence into an app on Meta's models that watches that equipment, and keeps watching with Meta's SAM 3.1 on a Jetson when the cloud is cut.

(The last clause is "is built so" until the take is logged; then it may be said as run. Freezer line: MESSAGING.md, "Edge facts, Nov 2", Bloomberg row, Checked.)

**Version 2, Build for Your World.** Use it if the take fails or the owner prefers the builder story.

> Build for Your World

Opening problem line for this version (the owner's words, Nov 3):

> People know their jobs, but getting custom software built takes engineering resources they often don't have. Muse Muse turns a sentence or photo into a working app they can use and keep improving.

(Evidence that it does this: 18 apps built overnight on Nov 3 from notes with made-up data, 7 of which a hands-on audit found working, 9 with gaps and 2 broken; Results, below. "Keep improving": a refinement resumes the same Muse Code session and ships again only if its checks pass; README.md, "What it does".)

Why version 1 was the default: the pages never say "problem statement". The rules' Impact line asks "whether it fits one of the problem statements", and the only candidates are the two themes. Both headlines land on Push the Frontier's own words: "Give a machine a new capability" (a sentence becomes a tuned model on a small board) and "unlock a better way to understand and control a physical system ... when these models meet the real world" (the cold-room watcher). On Nov 2 we judged that Build for Your World fit only Muse Privacy; the owner's Nov 3 line above makes the builder story itself the fit. Source: MESSAGING.md, the Push the Frontier row (Checked).

### 5. Most Viral: X post link  [owner] [after the board take]

> PLACEHOLDER: the X post's URL

- **What it is.** The public pages name a "most viral project award" only inside the Bonus Prizes clause (up to $50,000 in all, announced on or about Nov 10). There are no published rules on what counts, no tags or handles, and no deadline for the post. The rules say a project enters "one (1) track only", so this reads as a bonus award, not a second track. Ask on Discord if the form makes it look like one.
- **The post has to exist before Ethan submits** (Wed noon ET), since its link goes in the form.
- **The video.** The 60-second cut in [VIDEO.md](VIDEO.md), "The X posts": shot 0, shot 3 sped up, shot 4, shot 7 (cable out) and shot 9's card, with the same labels. If the take hasn't happened, use shot 7's backup or post the teaser without the unplug.
- **Post text, before the take:**

  > Your own AI, on your own hardware, ready for any scenario. We built Muse Muse for Meta's AI Developer Hackathon: one sentence becomes a working app on Meta's models. Its edge act: a simulated cold-room watcher that is built so it keeps answering on a Jetson when the cloud is cut, with Meta's SAM 3.1 on the board. Code: https://github.com/Offline-Base/muse-muse

- **Post text, after the take** (N and X from that take only):

  > One sentence becomes a cold-room watcher. Muse Muse built it on Meta's models, and with the uplink pulled it kept answering on one Jetson while Meta's SAM 3.1 on the board saw the door open in X seconds. Simulated cold room, real board, real unplug. Code: https://github.com/Offline-Base/muse-muse

  (X from the take only. The old "N of 5 drills, X tokens a second" line assumed a Glimmer text fallback on the board, which is cut.)

- Check the post against every line of MESSAGING.md "Don't say", the edge lines included. No news logos or footage; the rights grant (section "Before you tick the rights box") covers the post too.

### 6. Project Description  [after the chain run] [after the board take] [data rights]

Paste version A today. Swap in each B line only after its run is logged in BUILD_LOG.md. If field 4 is Build for Your World, replace the first paragraph's first sentence with that version's opening problem line.

> **Your own AI, on your own hardware, ready for any scenario.** Muse Muse turns one sentence into a working app on Meta's models. Muse Code, Meta's coding agent, writes each app headless in a Vercel Sandbox microVM on our starter template, and the platform runs typecheck, build, a smoke test, simulated outage drills and a screenshot judge on it, with up to four fix rounds. Overnight on Nov 3 it built 18 apps from notes with made-up data on Muse Spark 1.3 Contributor, for $0.17 to $0.40 each, most in 33 to 100 minutes. A hands-on audit of all 18 found 7 that work, 9 with gaps and 2 broken, though every one had passed our judge, so each defect became a code check.
>
> **The edge, and defending infrastructure.** Building for any scenario includes the day the cloud is out of reach or a controller can't be trusted. On Nov 2, supermarkets across Europe reported suspected freezer hacks, and the Pentagon is treating freezer failures at at least six commissaries as a suspected cyberattack. Muse Muse is built so a sentence like "watch this cold room" becomes an app that reads a controller, an independent probe, the door, defrost and power, flags a controller that disagrees with the probe by a rule in code, and keeps watching the door with Meta's SAM 3.1 on a Jetson when the cloud fails. What has run: SAM 3.1 on a Jetson Orin Nano 8GB, 1.42 s a look once warm; SAM 3.1's detector tuned on the same kind of board to find a new word, "muse" (our mascot), from 0 to 38 of 38 held-out made-up images, though Meta's SAM 3.1 already finds it as "plush toy", so the tune adds a name, not accuracy; and an edge build that passed all 8 simulated outage drills (cloud refused, cloud hung, both down, tampered reply, for its text answer and its SAM look) in its own build sandbox. The cold room and its readings are simulated.
>
> **Models you keep.** Separately from the apps, we publish Muse Glimmer weights on Hugging Face. A one-bit file of our 2026-knowledge Glimmer (5.75 GB, about a third the size of Meta's smallest 16.8 GB file) runs on a Jetson Orin Nano 8GB at about 5 tokens a second with short answers that are often wrong, and a 6.53 GB one-bit file ran on a Galaxy S25 at 1.94 tokens a second (AWS Device Farm, Nov 1, 3 of 3 simple questions). Built with Muse Spark Open. The apps don't call these files: their board fallback is rules in code plus SAM 3.1.
>
> **What isn't proven.** The chain from a sentence to an app answering with its own tuned model hasn't run as one, and no app has yet kept answering on a board with its uplink pulled. Muse Privacy is a separate connector, measured only on invented items, with Muse Glimmer 30B in the cloud: on Nov 2, 0 leaks of names or identifiers on 200 items, with the router right 71.5% of the time.

Optional tune sentence, after "Models you keep." [data rights]: "On Nov 3 the site itself tuned Muse Glimmer for a cold-room handoff task on one H100 in 32 minutes for $1.75, and the tune beat the model it started from on 19 of 20 held-out prompts (8.4 to 4.8), judged blind by Muse Spark 1.3 Contributor." Its rows were written by Contributor and its base is r30b, so it needs Q1 to Q3. The Oct lab result (A100, 42 minutes, $1.39, 40 of 40, 8.88 to 1.95, judged by Muse Spark 1.3) needs Q2, since Muse Spark 1.3 wrote its rows.

B lines (EDGE_PLAN.md, "When each claim may be said"), each replacing the matching "is built so" or "isn't proven" words:

- After the chain run (O2): add the chain run's own numbers, and "The chain ... hasn't run as one" comes out. Use STORY.md's marks as they stand after the run.
- After the board take: "With the uplink pulled, this app kept answering on one Jetson, and SAM 3.1 on the board saw the door open in [X] seconds." Then STORY.md's "On your own hardware" mark may move up, and "no app has yet kept answering on a board" comes out. If the take used the backup, say "the app kept answering on the laptop with Wi-Fi off, and SAM 3.1 on a Jetson saw the door over a cable in [X] seconds".

Sources, by paragraph:
- First: the 18 builds, BUILD_LOG.md "Nov 3, 2026, 2 to 3 AM ET: overnight batch results" (12 notes, $0.17 to $0.30, 33 to 92 minutes) and "Nov 3, 2026, 5:30 AM ET: target audit" (6 targets, $0.27 to $0.40, 46 to 100 minutes); the 7, 9 and 2 tally, BUILD_LOG.md "Nov 3, 2026, about noon ET: claim fixes"; four fix rounds, `MAX_FIX_ROUNDS` 4 ("Nov 3, 2026, 12:19 AM ET").
- Second: MESSAGING.md "Edge facts, Nov 2" (Bloomberg's "suspected", Reuters' "at least six commissaries"); SAM 3.1 and the tune, BUILD_LOG.md "Nov 3, 2026, 2:15 to 4 AM ET: the boards, checked for real"; rules in code, "Nov 3, 2026, 10:05 to 10:30 AM ET"; the 8 drills, cold-room-watcher-2's product page, logged in "Nov 3, 2026, about noon ET: claim fixes".
- Third: the Jetson file, BUILD_LOG.md "Nov 3, 2026, 2:15 to 4 AM ET" and MESSAGING.md point 3; the Galaxy S25, docs/GLIMMER_DEVICES.md and BUILD_LOG.md "Nov 3, 2026, 10:05 to 10:30 AM ET"; Meta's 16.8 GB, MESSAGING.md, quantization row.
- Fourth: STORY.md marks; the Muse Privacy rerun, BUILD_LOG.md "Nov 2, 2026, 9:35 to 10:23 PM". Muse Privacy gets one line here; its full write-up is under "Muse Privacy, in full" below. The "0 leaks on 300" and "Oct 30: 10 leaks on 200" numbers were measured with LFM3-VL-2B, which isn't a Meta model, so they are out of the submission. Muse Privacy's numbers come only from runs on Glimmer.

### 7. Public GitHub Repository  [owner]

> https://github.com/Offline-Base/muse-muse

- **Still private.** Make it public before submitting by flipping the current repo in place (owner decision, HANDOFF.md, "Owner decisions, Nov 2 night"): a private backup copy, delete the backup refs and stale branches, Hussam changes the ngrok domain first, then flip and check signed out. The owner runs the commands.
- Before that, owner to-dos 4 to 7 in HANDOFF.md (LICENSE, ngrok domain and GPU machines, data rights, Hugging Face visibility).
- The edge track is on main (#68, merged Nov 2, 3:40 PM ET; HANDOFF.md).
- Judges may run it with their own keys, so fix the README gaps above first.

### 8. 3-Minute Demo Video  [owner] [after the chain run] [after the board take]

> PLACEHOLDER: the YouTube link

The cut runs about 2:45 (VIDEO.md, revised Nov 3: about 300 words of narration at 140 a minute). Every edge shot says "Simulated" somewhere on screen.

### 9. Describe your use of Meta products

> **Muse Spark 1.3 Contributor** runs the live site's builds: it writes the briefs, drives Muse Code through the builds and fix rounds, and judges the screenshots. All 18 apps built on Nov 3 ran on it, with made-up data. **Muse Code** writes every app headless on our starter template (`muse exec --json`, `--session-id` for fix rounds, `--image` for screenshots, `muse export --redacted` for each app's build story). **Muse Wonder 1.0** is the platform's default when the Contributor switch is off. **SAM 3.1** runs inside apps in the cloud, and on a Jetson Orin Nano 8GB at 1.42 s a look; its detector was tuned on the same kind of board to find a new word. **Muse Image 1.0 and Muse Voice Transcribe 1.0** run inside apps. **Muse Glimmer 30B** does Muse Privacy's steps on invented data, in the cloud. It is also QLoRA-tuned on rented GPUs, judged blind against the model it started from, and cut to one-bit files we publish on Hugging Face, which run on a Jetson and a Galaxy S25. **Muse Spark Open** wrote training data, so that Glimmer (r30b) is a Derivative of it. The **Meta Model API** (`responses`, `images/generations`, `images/edits`, `files`, `asr/transcribe`) is reached only through a metered gateway, and generated code never sees the key. **Meta's docs:** the blind check follows the post-training guide's held-out comparison.

Source: the model table under "How it uses Meta's models" below. Contributor: HANDOFF.md, "Wonder stays off" (`BUILDS_ON_CONTRIBUTOR` on), and the Nov 3 batch entries in BUILD_LOG.md ("Times 33 to 92 minutes, costs $0.17 to $0.30 each on Contributor"). SAM on the board and its tune: BUILD_LOG.md, "Nov 3, 2026, 2:15 to 4 AM ET". The Galaxy S25: docs/GLIMMER_DEVICES.md. If production is switched to Wonder before judging, or the hero build runs on Wonder, add that here (HANDOFF.md, to-do 9). [after the chain run]: add what the chain run used.

### 10. Why are Meta's models important to your solution?

> The project works only because Meta offers both ends. The cloud models (Muse Wonder, Muse Code) do the heavy work once: planning, writing the app, judging. The open model (Muse Glimmer) is what comes out, a file you keep. Meta's Glimmer docs put it as "you own the weights, the runtime, and the data". For infrastructure that has to keep working when the cloud doesn't, that matters: Meta's SAM 3.1 runs on an 8 GB Jetson at about 1.4 s a look, so the app is built to keep watching from the board when the cloud is cut, with its decisions in code. And Meta's smallest Glimmer file is 16.8 GB; we cut one to 5.75 GB so it fits the same board, slowly and with weak answers, which is why the app doesn't lean on it. One vendor's models on both sides means one prompt style, one tool-call shape and one set of licenses, from the sentence to the board.

Source: MESSAGING.md rows 13, 16 and 23; STORY.md, alignment paragraph; BUILD_LOG.md, "Nov 3, 2026, 2:15 to 4 AM ET" (SAM 1.42 s, Glimmer about 5 tokens a second, often wrong) and "Nov 3, 2026, 10:05 to 10:30 AM ET" (rules in code). The last sentence is our framing, not a measured claim; cut it if you prefer.

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
  > SAM 3.1 is the Meta model that works on an 8 GB Jetson today: about 1.4 s a look, and its detector can be tuned on the board itself. One-bit Glimmer answers short chats there at about 5 tokens a second, and on a Galaxy S25 at 1.94, but its answers are often wrong: with Meta's recommended sampling it loops, and it called a 6 C controller and probe gap "ok" in every setup we tried. Glimmer is the right size in the cloud, and not yet reliable on 8 GB.

  Source: BUILD_LOG.md, "Nov 3, 2026, 2:15 to 4 AM ET" and "Nov 3, 2026, 10:05 to 10:30 AM ET"; docs/GLIMMER_DEVICES.md; MESSAGING.md point 3. The old first sentence ("Tuned Glimmer won 40 of 40") is [data rights], Q2.
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
- A partner prize for hosting a tuned model on a partner's inference and evaluating it there. The owner says one is tied to this (Nov 3). Its source is unconfirmed on the public pages: on Nov 3 the event page names Baseten, Modal and Fireworks only as giving $100 in credits each, and the rules page names no partner prize. Find its source before saying it anywhere. Until a partner eval has run and is logged in BUILD_LOG.md, don't say a tuned model was evaluated on a partner either (docs/TRAINING.md, "Evaluate on a partner").
- "Works offline", "private" or "on-device" for board answers, "stops hacks", "attack-proof", and anything about surviving a power loss (MESSAGING.md, "Don't say").
- The DC substation outage as an attack. Pepco: "no indication of foul play".
- PR #67's on-board tune: it tuned Llama, which isn't a Meta model here, so it is out of the submission. Never say Llama or Glimmer was tuned on a board. The one board tune we may say is Meta SAM 3.1's detector learning the word "muse" on jetson-03 (Nov 3), with the "plush toy" caveat (MESSAGING.md, Meta-models-only lines).
- Bolt, LFM or Llama numbers as project results, and "device-only" or "nothing leaves the device" for Muse Privacy while its submitted path is cloud Glimmer (MESSAGING.md, "Don't say").

## Reference for the answers

The longer write-up the fields draw on. Same rules: if a mark changes, change the line here.

### The problem

> "People are starting to be able to manifest ideas themselves without having to raise money or build large teams."
> Mark Zuckerberg, "The Future is for Everyone", Aug 10, 2026

The opening problem line follows field 4's pick:
- **Push the Frontier:** "Your own AI, on your own hardware, ready for any scenario. Shops, clinics and schools run equipment on the internet with no engineering team, and this fall suspected hacks shut down supermarket freezers across Europe."
- **Build for Your World:** "People know their jobs, but getting custom software built takes engineering resources they often don't have. Muse Muse turns a sentence or photo into a working app they can use and keep improving."

Meta now offers frontier cloud models and open models for local use. Muse Muse explores whether one person can move between them, shape the result, and leave with something they control. Going from a sentence to a model that's yours still takes data, a GPU, a fair test against the base model, a file small enough for a device, and an app around it.

Some of that work can't go to any cloud. Johns Hopkins Bayview notified 3,182 patients after a worker uploaded a patient spreadsheet to an AI tool the hospital hadn't approved. GAO found that "all 12 selected agencies that allow the use of generative AI reported that the agency limits or restricts that use in some capacity" (GAO-25-107653, July 2025).

Source: MESSAGING.md, all Checked.

### The chain, step by step [after the chain run]

| Step | Mark | What ran |
|---|---|---|
| One sentence to a plan and data | Proven, by harness | 900 rows to train on and 100 kept aside, for an invented hobby, $0.22. The one-box page hasn't started a real run |
| A tuned model on a rented GPU | Proven | The lab's own flow tuned Muse Glimmer 30B on an A100 in 42 minutes for $1.39. On Nov 3 the live site's own launch path (`POST /api/train/plan`, then `POST /api/train/runs`, from scripts/demo-tunes.ts) tuned the 2026-knowledge Glimmer for a cold-room handoff task on one H100 in 32 minutes for $1.75 (job 83ae46c8) [data rights] |
| A blind check against base | Proven | Muse Spark 1.3 judged the lab's tuned Glimmer blind against base on 40 held-out prompts: tuned won all 40, 8.88 to 1.95. Spark 1.3 Contributor judged job 83ae46c8: 19 of 20, 8.4 to 4.8. The task only, not general skill [data rights] |
| A file small enough for a device | Proven, by harness | The real quantize recipe, made-up data: a tuned Glimmer became a 6.53 GB one-bit file [data rights] |
| On your own hardware | Simulated, for this flow | Nothing the one-sentence flow tuned has run on a board. Separately, Meta's SAM 3.1 runs on a Jetson, and one-bit Glimmer weights run on a Jetson and a Galaxy S25 ("On a Jetson", below) [after the board take] |
| An app built for it | Proven | Test builds on the test model with made-up data, on a local site with no live link |
| That app answering with its tuned model | Not run yet | Planned behind a flag. Products answer on Muse Wonder until their model passes and is served |
| Checks showing what was proven | Proven | Typecheck, build, a smoke test Muse Code wrote, and a judge reading screenshots. The judge is one check of four |

The steps haven't run as one chain yet. Source: STORY.md.

### The edge track [after the board take]

| Piece | State on Nov 3 |
|---|---|
| Cloud-to-edge fallback (`template/lib/meta/edge.ts`) | Built, unit-tested. The cloud first with a 10 s limit, then the board, checked against a schema. A cloud that turns a request down is the answer; the board isn't asked around it |
| SAM 3.1's board fallback (`segmentOrEdge` in the same file) | Built, and ran in real builds: cold-door-watch (Nov 2) passed its 4 SAM drills in its build sandbox, and cold-room-watcher-2 (Nov 3) passed all 8 drills, 4 text and 4 SAM, against a simulated board (BUILD_LOG.md, "Nov 2, 2026, 10:14 PM ET" and "Nov 3, 2026, about noon ET: claim fixes") |
| The keyless judge drill (`npm run drill`) | Ran, 11 of 11 on loopback (BUILD_LOG.md, "Nov 3, 2026, 10:30 AM ET: demos in check for judges") |
| Edge target and a drill inside every edge build | On in production since Nov 2 night (`EDGE_BUILDS`, `EDGE_ENABLED`; BUILD_LOG.md, "merged #98 and #99") |
| SAM 3.1 on jetson-04 | Runs: first look 3.27 s, then 1.42 to 1.43 s a look on Meta's 1800 x 1200 truck photo (BUILD_LOG.md, "Nov 3, 2026, 2:15 to 4 AM ET") |
| SAM 3.1 tuned on jetson-03 | Ran: the word "muse" from 0 to 38 of 38 on 50 held-out made-up images, no wrong boxes, the truck photo unchanged. Meta's SAM 3.1 already finds the same mascot as "plush toy" or "toy", so on these images the tune adds a name, not accuracy. The tuned file runs beside Meta's weights on jetson-04 (same entry) |
| The board's text fallback | Rules in code (the probe-disagreement rule and thresholds), no model. One-bit Glimmer runs on jetson-02 but was wrong on the cold-room reading in every setup tried (BUILD_LOG.md, "Nov 3, 2026, 10:05 to 10:30 AM ET") |
| Board build (`scripts/edge/build-arm64.sh`, `docs/EDGE_DEMO.md`) | Built. Syntax-checked only; the Docker build hasn't run |
| Drill data (`scripts/dev/drill-bench.py`) | Built. Simulated cold-room windows written by code from a fixed seed: 900 training rows, 50 kept aside, 100 sealed held-out, scored per field by code, with a rule that a controller that disagrees with the probe by more than 3.0 C is never trusted |
| An app on a board with its uplink pulled | Not run. Tonight's take (VIDEO.md, shot 7) |

Source: EDGE_PLAN.md, EDGE_DEMO.md and the BUILD_LOG.md entries named in each row.

### Muse Privacy, in full

Muse can reach your files through connectors, but what it reads lands in its cloud computer, names and all. Muse Privacy is a connector you run yourself, and its policy file stays with you. Muse plans with tags like [Student A] and never gets the documents. For the submission, Muse Glimmer 30B does every step that touches them, in the cloud through OpenRouter, on invented data only. Glimmer on your own device is the target, not a result. A policy file decides what can leave, and a final check runs on every result before it leaves.

- Today's setup on Glimmer through OpenRouter (Nov 2, `privacy/eval/reports/glimmer_fresh_200_b_2026-11-02.md`): 0 leaks of names or identifiers on 200 invented items, with the 58 releases the simulated teacher approved checked too. Nothing was shared that should have waited or stayed on the device. The router was right 71.5% of the time (143 of 200) and asks too often: 101 approval requests, 50 of them needless. On the holdout, 75.0% (15 of 20) with 0 leaks (`glimmer_holdout_2026-11-02.md`). `fresh_200_b` is a development set, not the sealed one.
- An earlier version on Glimmer through OpenRouter (Oct 27, `privacy/eval/reports/final.md`): 0 leaks of names or identifiers on 100 invented items, with the router right 76% of the time on those 100 and 75% on the holdout. Cloud numbers on an earlier code state, not today's setup.
- "Leaks" counts names and identifiers. A summary can still point at someone without naming them.
- No real users, the sealed test set hasn't been scored, and the attacks are hand-written.

Meta's cookbook already has a local agent that asks before each send ("Local agent that asks first"). The difference here is that a policy file decides, and a router learns from what was approved before. It shares the idea in Meta Engineering's PrivacyLib post: "The access decision does not depend on the agent behaving as intended." The check sits at the exit, outside the model. A toggle doesn't make anyone legally covered.

Source: STORY.md, privacy paragraph; MESSAGING.md, Checked rows and point 1.

### On a Jetson

**Meta's SAM 3.1** runs on jetson-04, a Jetson Orin Nano 8GB, at 1.42 s a look once warm, and its detector was tuned on jetson-03 to find a new word (the edge track table above). This is the board model the edge apps use.

**Muse Glimmer weights, separate from the apps.** These are files we publish on Hugging Face from the knowledge run, not anything the one-sentence flow made, and no app calls them. Meta's smallest Glimmer files are 16.8 GB and 19.7 GB. By hand, the knowledge run's Glimmer (r30b), cut to one-bit size (IQ1_S, 5.75 GB), runs on a real Jetson Orin Nano 8GB, about a third the size of Meta's smallest file. Here's the cost: about 5 tokens a second, with short answers that are often wrong, and with Meta's recommended sampling it loops. On 40 invented receipts it gave no valid JSON, and the board stopped answering at receipt 23. A 6.53 GB one-bit r30b file ran on a Galaxy S25 (12 GB, CPU) in AWS Device Farm on Nov 1 at 1.94 tokens a second, 3 of 3 simple questions right, from adb shell, not an app. r30b is a Derivative of Muse Spark Open: Built with Muse Spark Open, 18 and over. [data rights]

Source: BUILD_LOG.md, "Nov 3, 2026, 2:15 to 4 AM ET" and "Nov 3, 2026, 10:05 to 10:30 AM ET"; docs/GLIMMER_DEVICES.md; MESSAGING.md, quantization row (Checked) and point 3; STORY.md, device-file row.

### Under all of it: the build platform

Muse Code runs headless in a Vercel Sandbox microVM and writes a Next.js app from a template. The checks run, and failures go back to the same Muse Code session with the judge's screenshots, up to `MAX_FIX_ROUNDS` rounds (4 in production since Nov 3). Apps reach Meta only through a metered gateway, each with its own scoped, budgeted token, and the sandbox firewall adds the Meta key only on Muse Code's own routes. Every app gets a demo video cut from its own passing test, with model waits sped up and labeled. Builds run in Vercel Sandbox; Modal is added as a second host behind a flag, smoke-tested on Modal with no full build there yet. Source: README.md, BUILD_LOG.md and MODAL_HOST.md.

### How it uses Meta's models

| Model or tool | Where |
|---|---|
| **Muse Spark 1.3 Contributor** | The live site's model while `BUILDS_ON_CONTRIBUTOR` is on, as it is now (owner, Nov 2: Wonder stays off): briefs, builds, fix rounds and judging. All 18 Nov 3 builds ran on it. Also the test model for test builds with made-up data. Meta may train on contributor prompts, so products on it show a notice |
| **Muse Wonder 1.0** | The default for briefs, builds, fix rounds, judging and products when `BUILDS_ON_CONTRIBUTOR` is off. A few gallery products stay on it under the switch (`WONDER_DEMO_SLUGS`). Check production before submitting (docs/JUDGING_WEEK.md) |
| **Muse Spark 1.3** | Wrote the lab's first dataset (400 examples for $1.51) and judged both lab runs. Not used since Oct 29 |
| **Muse Code** | Writes every app headless: `muse exec --json` with hardened flags, `--session-id` to resume for fix rounds, `--image` for screenshots, and `muse export --redacted` for each app's "How it was built" |
| **Muse Glimmer 30B** | The tuned student: QLoRA on rented GPUs, judged blind against base, quantized to one-bit files published on Hugging Face. Its knowledge-run version runs on a Jetson and a Galaxy S25, apart from the apps. It also does Muse Privacy's steps, in the cloud on invented data |
| **Muse Spark Open** | r30b is a Derivative of it |
| **SAM 3.1** | Inside apps, in the cloud through the gateway, and on jetson-04 as the edge apps' board look (1.42 s a look). Its detector was tuned on jetson-03 |
| **Muse Image 1.0, Muse Voice Transcribe 1.0** | Inside apps: making and editing images, and speech to text |
| **Meta Model API** | `responses`, `images/generations`, `images/edits`, `files` and `asr/transcribe`, which apps reach only through the gateway |
| **Meta's docs** | The post-training guide's check against base on a held-out set, which the blind check follows (its general-benchmark half isn't built yet). The quantization docs for the 16.8 GB size. The cookbook's "Local agent that asks first", the closest Meta pattern to Muse Privacy |

### What was hard

1. **Keeping the key away from generated code while Muse Code still works.** Muse Code holds a per-sandbox placeholder, and the firewall swaps it for the real key on four routes only. Every other request to `api.meta.ai` gets a 403.
2. **Muse Code with nobody watching.** Its launcher tries to self-update from a blocked host and may start a device sign-in, so the runner turns both off. Its own sandbox can't run in the microVM, so the VM is the boundary. Fifteen bundled skills fought the template, so the snapshot turns them off.
3. **Honest cost.** `run.usage` counts only the main agent. Reminder agents were 31% to 43% of each build's real Muse Code spend, so the platform reads Muse Code's session logs and charges them.
4. **A fair blind check.** The first real Glimmer run lost 28 to 11. The cause was an eval bug: training put every answer on Glimmer's final channel, but the eval let the model choose, and the tuned answers never left the reasoning channel. After the fix, tuned won 40 of 40.
5. **GPUs that bill by the hour.** Three things terminate every instance: the job's workflow, the instance's done callback, and a sweep every 5 minutes. Jobs won't launch unless the sweep ran in the last 15 minutes.
6. **One-bit files that still answer.** One-bit size costs a lot: tuned Glimmer at IQ1_S answered 8.1% of new-knowledge probes, against 29.9% at Q4_K_M. A KL limit leaves out a file that drifts too far from its source.
7. **A fallback that doesn't route around a refusal.** The edge fallback is built to answer only when the cloud can't be reached or sent a reply that doesn't match its schema. A cloud that turned a request down (a refusal, a budget limit) is the answer, so the board isn't asked around it. And a cloud drill fails if the product never tried the cloud first, so a product can't pass the outage drills by skipping the cloud. Both are unit-tested, and the drills have run inside real edge builds (cold-room-watcher-2, 8 of 8, Nov 3).

Source: BUILD_LOG.md and README.md; item 6, STORY.md and `lib/story/flow.ts`; item 7, commit `5c679d87` and EDGE_DEMO.md.

### Results

**On Nov 3** (BUILD_LOG.md, the Nov 3 entries named below)

- **18 live builds overnight** on Muse Spark 1.3 Contributor with made-up data: 12 notes started at 12:19 AM ($0.17 to $0.30 each) and 6 target builds at 2:21 AM ($0.27 to $0.40 each), most in 33 to 100 minutes. Every one passed its judge. A hands-on runtime audit of all 18, on desktop and a 390 px phone, found **7 that work, 9 with gaps and 2 broken** (the list is in "Nov 3, 2026, about noon ET: claim fixes"; three of the 7 were called "works, with gaps", so the stricter count is 4, 12 and 2). Each defect became a code check, the 6 broken or self-contradicting apps are hidden from the gallery until rebuilt, and 4 rebuilds wait on a new builder snapshot ("Nov 3, 2026, 10:30 AM ET: demos in check for judges").
- **SAM 3.1 on a Jetson:** 1.42 s a look on jetson-04 once warm. **SAM 3.1 tuned on a board:** "muse" from 0 to 38 of 38 held-out made-up images on jetson-03, with Meta's weights already at 38 of 38 for "plush toy" ("Nov 3, 2026, 2:15 to 4 AM ET").
- **An edge build passed all 8 simulated outage drills** in its build sandbox (cold-room-watcher-2), and `npm run drill` passes 11 of 11 with no key.
- **A tune launched from the site itself** (job 83ae46c8): one H100, 32 minutes, $1.75, 19 of 20 held-out prompts against the model it started from, judged by Spark 1.3 Contributor. [data rights]
- **One-bit Glimmer on a Galaxy S25**, Nov 1: 1.94 tokens a second, 3 of 3 simple questions (docs/GLIMMER_DEVICES.md). Weights, not an app.

**Tuning and files** (STORY.md and `lib/story/flow.ts`)

- Muse Glimmer 30B, the lab's own flow: A100, 42 minutes, $1.39. Tuned won all 40 held-out prompts, 8.88 against 1.95, judged by Muse Spark 1.3. Results are public and read-only at `/fine-tuning`. [data rights], Q2: Muse Spark 1.3 wrote its rows.
- A Nov 1 Glimmer run through the harness also won 40 of 40, 7.93 against 2.5 (PROVE_RESULTS.md). Hold this one until the owner settles the training-data question (docs/DATA_RIGHTS.md): its rows were written by Muse Spark 1.3 Contributor.
- Quantized, made-up data: a 6.53 GB one-bit Glimmer file. [data rights]: STORY.md doesn't name which tune's rows it used, and the readiness audit counts it with the Q2 lines, so check before featuring it.

**Builds** (README.md, BUILD_LOG.md, PROVE_RESULTS.md)

- Oct 27, a local batch: 24 of 24 builds passed their checks, at 3 to 9 minutes and about $0.30 to $1.80 each. Local runs stop before the deploy step, so none of these 24 was deployed.
- Oct 28, on the live site: 9 of 10 catalog rebuilds went live, including all 6 of Meta's videos, for $24.70 in total. The Muse Wonder first demo failed its smoke test in all 3 fix rounds. A Nov 2 audit found that none of those six fully teaches its lesson (2 wrong, 4 partly), so they now sit on the Learn page (/learn) with a plan to redo each, and are not claimed as rebuilds.
- Oct 28, the Meta look: the same 11 ideas rebuilt on a Meta-style template. Three judges compared each pair blind, and the new builds won 30 of 33 votes, 7.17 against 5.53.
- Nov 1, on the test model with made-up data: 11 recipes across 8 builds passed their smoke tests and the judge. Previews don't publish, so they have no live link.

### What isn't proven yet [after the chain run] [after the board take]

- The chain as one run, from a sentence to an app answering with its own tuned model.
- Anything the one-sentence flow made, running on a real board with its uplink pulled. The drills so far ran in build sandboxes against a simulated board.
- Hugging Face upload from the site. The upload is built and tested against a fake Hub only. (A tune launched from the site ran once, Nov 3, job 83ae46c8, with publishing off.)
- A tuned SAM that sees better than Meta's weights. The tune taught a name; the held-out images are composites with no other toys.
- A general-capability or safety check on a tune. The blind check covers the task only.
- Muse Privacy with real users, on its sealed test set, on a device, or inside the real Muse app.
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
- [x] **Edge track code**, merged (#68, Nov 2) and on in production (`EDGE_BUILDS`, `EDGE_ENABLED`, Nov 2 night).
- [x] **Keyless judge drill**, 11 of 11 (Nov 3).
- [x] **Claims pass on VIDEO, SUBMISSION, MESSAGING, README and OFFLINE** (Nov 3, tg-c-claims), waiting on the owner's approval.
- [x] **Lambda key rotated** (Nov 2).

### Left (steps in docs/HANDOFF.md)

- [ ] Add Ethan to Team Members, and confirm Hussam's surname.
- [ ] Fix the README's setup gaps, since judges may run the repo with their own keys.
- [ ] Make the repo public by flipping it in place (HANDOFF.md, "Owner decisions, Nov 2 night").
- [ ] Pick a LICENSE; settle DATA_RIGHTS.md Q1 to Q3; Hugging Face visibility.
- [ ] The board take (VIDEO.md, shot 7), then swap the [after the board take] answers. Pick field 4's version.
- [ ] Settle DATA_RIGHTS.md Q1 to Q3, then keep or cut every [data rights] line.
- [ ] Production settings for judging: Contributor or Wonder, and the daily spend cap. Turn on `STORY_PAGES` before recording.
- [ ] Record and upload the video; post the 60-second cut on X before Wed noon ET.
- [ ] Fill in the form from this file, field by field.
