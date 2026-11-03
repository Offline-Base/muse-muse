# The video

The script to film, rewritten Nov 2, 2026, night, from the owner's answers to the plan-to-win form (rounds 1 and 2). It replaces the "one sentence becomes a tuned model" script, which is at `git show 282c0d87:docs/VIDEO.md` if anyone needs it.

**Revised Nov 3, about noon ET (branch tg-c-claims, a draft for the owner to approve before merge),** from the readiness audit's claim fixes (items 7 and 15 and its story recommendation): credits now name Muse Spark 1.3 Contributor where it ran, Muse Privacy is said as cloud and invented data, the edge fallback is rules in code plus SAM 3.1 on the board, the one-bit Glimmer clip and the Spark Open card are cut, Nov 3's board results are in, and the narration is cut to about 300 words for 2:45. Every number cites docs/BUILD_LOG.md.

**The story, in the owner's words:** Muse Muse is your own AI, on your own hardware, ready for any scenario. It's for a shop, a clinic or a school with equipment on the internet and no engineering team, and for anyone with an idea and no team. The hero is a cold-room watcher that Muse Muse builds, that runs on a Mac, a PC and a phone, and that keeps running on a Jetson when the cable comes out, with Meta's SAM 3.1 watching the door on the board.

## Rules for every shot

- **Organizers (Discord, Nov 2):** the opening says what existed before the event and what was built this week. Judges mainly score from this video and the public repo.
- **Meta models only.** Every model doing work on screen is Meta's. No Llama, LFM or Bolt in any shot, card or caption.
- **Labels carry the honesty, so the narration doesn't have to.** Each label goes in a corner or lower third:
  - "Sped up. Real build." on any sped-up footage.
  - "Test model" on builds run on Muse Spark 1.3 Contributor.
  - "Simulated cold room. Real board, real unplug." on every edge shot.
  - "Invented data" on every Muse Privacy shot.
- **Only say what the shot shows.** Every number comes from docs/BUILD_LOG.md. Never "attack-proof", "stops hacks", "works offline" in general, "private" or "on-device" for the cloud Glimmer path, or that anything survives a power loss. The freezer incidents are always "suspected". docs/MESSAGING.md has the full don't-say list.
- **Never in frame:** `.env.local`, the Vercel, AWS or Lambda consoles, admin job pages, the fleet console, any ngrok domain or board address, jetson-05.
- Browser at 1440×900, light theme, 100% zoom, signed out unless a shot needs the builder sign-in. No em dashes in captions or cards.
- Target length 2:45. About 300 words of narration at 140 a minute, plus the silent opening card and the pauses in shot 7: read it aloud once with a timer.

## Timing

| # | Time | Shot | Voice | Ready when |
|---|---|---|---|---|
| 0 | 0:00 to 0:05 | Zuckerberg's line | none | Now |
| 1 | 0:05 to 0:16 | Before and after | Ethan, on camera | Now |
| 2 | 0:16 to 0:32 | Who it's for | Ethan, on camera | Now |
| 3 | 0:32 to 0:50 | The build | Ethan | After the hero build (needs the new snapshot) |
| 4 | 0:50 to 1:03 | The product | Ethan | After the hero build |
| 5 | 1:03 to 1:11 | Muse Privacy, in one line | Ethan | After STORY_PAGES is on in production |
| 6 | 1:11 to 1:23 | Where it ran | Ethan | Now (Dinner Split Helper); better after the cold-room device runs |
| 7 | 1:23 to 1:58 | Cable out | Hussam | Tue 7 to 9 PM take |
| 8 | 1:58 to 2:33 | Under the hood | Ethan | Now; the Glimmer tune card waits on DATA_RIGHTS.md Q2 |
| 9 | 2:33 to 2:45 | Close | Both, on camera | Now |

## Shots

**0. Zuckerberg's line (0:00 to 0:05)**
- Card: "People are starting to be able to manifest ideas themselves without having to raise money or build large teams." Under it: "Mark Zuckerberg, The Future is for Everyone, Aug 10, 2026." No narration.
- Source: docs/MESSAGING.md, Checked.

**1. Before and after (0:05 to 0:16)**
- On screen: Ethan on camera, then a two-column card. "Before Oct 26": Offline Base's Jetson fleet and the software that runs it; a Muse Muse scaffold of notes and stubs with no working code. "Built this week": Muse Muse, Muse Privacy, the edge track.
- Say: "Before this week, Offline Base had a fleet of Jetson boards and the software that runs them. Everything Muse Muse does here, we built this week."
- Source: README.md, "Before the event".

**2. Who it's for (0:16 to 0:32)**
- On screen: Ethan on camera. Text cards with sources: "Paris prosecutors opened an investigation into a large-scale cyberattack on supermarket refrigerators. Oct 2026" and "Supermarkets across Europe report new suspected freezer hacks. Bloomberg, Nov 2, 2026". No news footage or logos.
- Say: "A corner shop, a clinic, a school: equipment online, and no engineering team. This fall, suspected hacks shut down supermarket freezers across Europe. Muse Muse is your own AI, on your own hardware, ready for any scenario."
- If the owner picks Build for Your World (docs/SUBMISSION.md, field 4), say instead: "People know their jobs, but getting custom software built takes engineering resources they often don't have. Muse Muse turns a sentence or photo into a working app they can use and keep improving." Keep the freezer cards only with the Push the Frontier line.
- Source: docs/MESSAGING.md, "Edge facts, Nov 2" (BleepingComputer and Bloomberg rows, Checked).

**3. The build (0:32 to 0:50)**
- On screen: the live site's Make page. Type: "A watcher for my cold room that reads the controller, a second probe, the door camera, defrost and power, and keeps answering when the cloud is down." Then the plan card, the requirements to-do card ticking, Muse Code writing, and the checks: typecheck, build, smoke test, the outage drills (text and vision), the judge's screenshots. End on "Live".
- Labels: "Sped up. Real build." and "Test model" (production builds run on Muse Spark 1.3 Contributor while `BUILDS_ON_CONTRIBUTOR` is on; docs/HANDOFF.md, "Wonder stays off").
- Say: "One sentence. Muse Code, Meta's coding agent, writes the app on our starter template, then checks it: types, a build, a smoke test, outage drills and a judge. [N] minutes later, it's live."
- [N] from the hero build's log entry. If Look first is on and passed its test build, keep 3 seconds of the first screens with sample data and add "It shows me the screens first."

**4. The product (0:50 to 1:03)**
- On screen: the live product. Readings in; the controller at −18 °C and the probe at +9 °C and rising; the app says not to trust the controller. Then a door photo, and SAM 3.1 marks the open door.
- Labels: "Simulated cold room" and, on the verdict, "Decided by a rule in code".
- Say: "When the controller says minus 18 and the probe says plus 9 and climbing, a rule in code says don't trust the controller. Meta's SAM 3.1 watches the door."
- Check on screen before filming that the hero build decides the probe gap in code (the drill data's rule: a gap over 3.0 C means the controller isn't trusted; docs/SUBMISSION.md, "The edge track").

**5. Muse Privacy, in one line (1:03 to 1:11)**
- On screen: `/private`, a few seconds of the replay recorded on Muse Glimmer, then the numbers card.
- Labels: "Muse Glimmer 30B in the cloud. Invented data."
- Say: "Muse Privacy, our second connector, ran in the cloud on 200 invented items with Muse Glimmer: zero leaks."
- The card, from the Nov 2 rerun (PR #98): "Muse Glimmer 30B in the cloud, through OpenRouter, Nov 2: 0 leaks of names or identifiers on 200 invented items."
- Film the replay by stepping through it: scene A's grading wait is 125 s and scene E's overnight run 627 s. Scene F (government records) isn't in the cloud recording, so don't show or mention it.
- Never "keeps documents on hardware you own", "device-only" or "nothing leaves the device": the submitted path is Glimmer in the cloud on invented data.
- Source: the Muse Privacy rerun entry in docs/BUILD_LOG.md (Nov 2, 9:35 to 10:23 PM, PR tg-privacy-glimmer).

**6. Where it ran (1:11 to 1:23)**
- On screen: the product page's "Where it ran" stage: a Mac and a Windows machine from the AWS device lab, a real Galaxy S25 through AWS Device Farm, and the iPhone simulator, each playing the run made on that device.
- Say: "And it runs where people are: a Mac and a Windows machine in our AWS lab, and a real Galaxy S25 on AWS Device Farm."
- If the cold-room product's device runs haven't happened, film Dinner Split Helper's stage with the caption "Another app Muse Muse built", and keep the iPhone labeled "Simulated".
- Source: docs/BUILD_LOG.md, the device runs (lab demo-1102, Device Farm run 3abcc4b7, or the cold-room runs once logged).

**7. Cable out (1:23 to 1:58)** [Hussam films]
- On screen, one take, not sped up: a Jetson Orin Nano 8GB on a desk next to the prop "cold room" (Hussam picks the prop; it needs a door SAM can see). The cold-room app runs on the board with Meta's SAM 3.1 beside it. Hussam pulls the uplink; a terminal shows Meta's API unreachable. The app keeps answering on the board. The door opens; the laptop camera sends a frame over the local link; SAM 3.1 on the board marks the door.
- Labels: "Simulated cold room. Real board, real unplug." and the app's own "Seen on the board by Meta SAM 3.1".
- Say (Hussam): "An eight-gigabyte Jetson, running the app Muse Muse built and Meta's SAM 3.1. I pull the uplink. Meta's cloud is gone; the app keeps answering from the board. I open the door: SAM, on the board, sees it in [X] seconds."
- [X] from this take only. For scale, SAM 3.1 on jetson-04 took 1.42 s a look once warm on Nov 3 (docs/BUILD_LOG.md, "Nov 3, 2026, 2:15 to 4 AM ET: the boards, checked for real").
- Optional, only if the take shows it: a spoofed reading (controller −18, probe +9) flagged. Say: "A spoofed reading: flagged, by a rule in code." Lower third: "Fixed rule in code, no model". jetson-04 serves no text model, so never say a model judged it.
- Backup, if the board kit doesn't run by the 1 PM go or no-go: the app runs on the laptop with Wi-Fi off, and SAM 3.1 runs on the board over the local link (scripts/edge/sam3/LOCAL.md). Say instead: "The laptop's Wi-Fi is off. The app keeps answering, and SAM 3.1 on this Jetson, over a cable, sees the door in [X] seconds." Label: "App on the laptop, SAM 3.1 on the board."
- Cut from this shot: the one-bit Glimmer clip. It runs on jetson-02, but its answers are often wrong (docs/BUILD_LOG.md, "Nov 3, 2026, 10:05 to 10:30 AM ET"), and the edge fallback is rules in code, not Glimmer.

**8. Under the hood (1:58 to 2:33)**
- On screen: one card per model, with its number.
  - Muse Code: "wrote every app, on our starter template".
  - Muse Spark 1.3 Contributor: "planned, built with Muse Code and judged this app" (the hero build only: Dinner Split Helper in shot 6 predates `BUILDS_ON_CONTRIBUTOR`, so never say "every build in this video"). Check the hero build's log entry first: if it ran on Muse Wonder, credit Wonder on this card instead. Muse Wonder gets a card only if a logged build in the video ran on it.
  - SAM 3.1: "1.42 s a look on a Jetson Orin Nano 8GB. Tuned on a board to find a new word, 'muse': 0 to 38 of 38 held-out made-up images. Meta's SAM 3.1 already finds the same mascot as 'plush toy'."
  - Then "18 apps built overnight on the test model, most for $0.17 to $0.40" and "[N] apps live". (17 costs are logged; the legal case agent's isn't.)
  - Only if DATA_RIGHTS.md Q2 is yes: Muse Glimmer 30B: "tuned by the site for a cold room in 32 minutes for $1.75. Beat the model it started from on 19 of 20 held-out prompts, judged blind by Muse Spark 1.3 Contributor. Built with Muse Spark Open. 18 and over."
- Say: "Muse Code wrote the app on Muse Spark 1.3 Contributor, which also planned and judged it. SAM 3.1 sees in the cloud and on the board, and we taught it a new word on the same kind of board. Overnight, Muse Muse built 18 apps, most for under forty cents. [N] are live today."
- If Q2 is yes, swap the overnight sentence for: "And the site tuned Muse Glimmer for this cold room: it beat the model it started from on 19 of 20 held-out prompts, for a dollar seventy-five."
- [N] from the gallery count on recording day.
- Sources: SAM on jetson-04, the SAM tune and its "plush toy" baseline: docs/BUILD_LOG.md, "Nov 3, 2026, 2:15 to 4 AM ET: the boards, checked for real". The 18 builds: "Nov 3, 2026, 2 to 3 AM ET: overnight batch results" ($0.17 to $0.30, 12 notes) and "Nov 3, 2026, 5:30 AM ET: target audit" ($0.27 to $0.40, 6 targets). The tune: job 83ae46c8's public page and docs/BUILD_LOG.md, "Nov 3, 2026, about 10:30 AM ET: partner evals" (19 of 20, 8.4 vs 4.8), with the run's cost logged in "Nov 3, 2026, about noon ET: claim fixes".
- Cut: the Muse Wonder "plans and judges" card (the logged Nov 3 builds ran on Contributor, with Wonder off by the owner's call; docs/HANDOFF.md, "Wonder stays off"), the Muse Spark Open on Fireworks card (Fireworks' account answered 412 on Nov 2, and no logged product call ran on it), and the 40 of 40 lab card unless Q2 is yes (its rows were written by Muse Spark 1.3; docs/DATA_RIGHTS.md).

**9. Close (2:33 to 2:45)**
- On screen: Ethan and Hussam on camera, then a card with https://www.musemuse.dev, the repo URL and "Not an official Meta product."
- Say: Hussam: "We're Offline Base." Ethan: "Muse Muse: your own AI, on your own hardware, ready for any scenario."

## The X posts (Most Viral, engagement counts through Nov 8)

- **Tuesday night teaser, about 15 seconds:** shot 7 cut down: the cable comes out, the door opens, SAM marks it on the board. Post text: "Cable out. Still watching. An app Muse Muse built on Meta's models, running on a Jetson with SAM 3.1. Simulated cold room, real board, real unplug. Full demo tomorrow." If the take used the backup, say "An app Muse Muse built on Meta's models keeps answering with the Wi-Fi off, and SAM 3.1 on a Jetson keeps watching the door."
- **Wednesday morning, 60 seconds:** shot 0 (3 s), shot 3 sped up (15 s), shot 4 (8 s), shot 7 (25 s), shot 9's card (9 s). Post text: "Your own AI, on your own hardware, ready for any scenario. Muse Muse turns one sentence into a working app with Meta's models, then keeps it running on a Jetson when the cable comes out. Built this week for Meta's AI Developer Hackathon. Code: [repo URL]"
- Post from @ethancastr and @electricalaliee before Ethan submits, and put the link in the form. Check both posts against docs/MESSAGING.md "Don't say".

## Tuesday, Nov 3 (ET)

| When | Who | What |
|---|---|---|
| Morning | Owner | Merge the ready PRs (edge vision, Spark Open, public-ready, Privacy rerun) |
| Morning | Lead | New builder snapshot, one smoke build, the edge preview check, then the hero build (shots 3 and 4) |
| Morning | Hussam | The cold-room app's source on jetson-04 next to sam3.service (docs/EDGE_DEMO.md); pick the prop; check free memory |
| Midday | Lead | Cold-room device runs (lab and Device Farm) for shot 6 |
| Afternoon | Ethan | Film shots 0, 1, 2, 5, 6, 8, 9 |
| By 6 PM | Owner, Hussam | Going public: backup copy, delete backup refs and stale branches, Hussam changes the ngrok domain, flip, check signed out |
| 7 to 9 PM | Hussam, Ethan | Two rehearsals and one take of shot 7. Hard stop at 9 PM |
| Night | Ethan, Hussam | Edit; post the teaser |
| Wed by 9 AM | Ethan | Upload the cut, check the link signed out, post the 60 seconds |
| Wed by noon | Ethan | Submit, with both of you listed |
