# The video

The script to film, rewritten Nov 2, 2026, night, from the owner's answers to the plan-to-win form (rounds 1 and 2). It replaces the "one sentence becomes a tuned model" script, which is at `git show 282c0d87:docs/VIDEO.md` if anyone needs it.

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
- Target length 2:50. About 390 words of narration at 140 a minute: read it aloud once with a timer.

## Timing

| # | Time | Shot | Voice | Ready when |
|---|---|---|---|---|
| 0 | 0:00 to 0:06 | Zuckerberg's line | none | Now |
| 1 | 0:06 to 0:14 | Before and after | Ethan, on camera | Now |
| 2 | 0:14 to 0:26 | Who it's for | Ethan, on camera | Now |
| 3 | 0:26 to 0:54 | The build | Ethan | After the hero build (needs the edge-vision PR and the new snapshot) |
| 4 | 0:54 to 1:06 | The product | Ethan | After the hero build |
| 5 | 1:06 to 1:26 | A leak is a bad day too | Ethan | After PR #98 is deployed with STORY_PAGES on |
| 6 | 1:26 to 1:38 | Where it ran | Ethan | Now (Dinner Split Helper); better after the cold-room device runs |
| 7 | 1:38 to 2:14 | Cable out | Hussam | Tue 7 to 9 PM take, after the edge-vision PR |
| 8 | 2:14 to 2:38 | Under the hood | Ethan | Now, plus the Spark Open card once a product has used it |
| 9 | 2:38 to 2:50 | Close | Both, on camera | Now |

## Shots

**0. Zuckerberg's line (0:00 to 0:06)**
- Card: "People are starting to be able to manifest ideas themselves without having to raise money or build large teams." Under it: "Mark Zuckerberg, The Future is for Everyone, Aug 10, 2026." No narration.
- Source: docs/MESSAGING.md, Checked.

**1. Before and after (0:06 to 0:14)**
- On screen: Ethan on camera, then a two-column card. "Before Oct 26": Offline Base's Jetson fleet and the software that runs it; a Muse Muse scaffold of notes and stubs with no working code. "Built this week": Muse Muse, Muse Privacy, the edge track.
- Say: "Before this week, Offline Base had a fleet of Jetson boards and the software that runs them. Everything Muse Muse does in this video, we built this week."
- Source: README.md, "Before the event".

**2. Who it's for (0:14 to 0:26)**
- On screen: Ethan on camera. Text cards with sources: "Paris prosecutors opened an investigation into a large-scale cyberattack on supermarket refrigerators. Oct 2026" and "Supermarkets across Europe report new suspected freezer hacks. Bloomberg, Nov 2, 2026". No news footage or logos.
- Say: "Think of a corner shop, a clinic or a school. Equipment on the internet, and no engineering team. This fall, suspected hacks shut down supermarket freezers in France and across Europe. Muse Muse is your own AI, on your own hardware, ready for any scenario."
- Source: docs/MESSAGING.md, "Edge facts, Nov 2" (BleepingComputer and Bloomberg rows, Checked).

**3. The build (0:26 to 0:54)**
- On screen: the live site's Make page. Type: "A watcher for my cold room that reads the controller, a second probe, the door camera, defrost and power, and keeps answering when the cloud is down." Then the plan card, the requirements to-do card ticking, Muse Code writing, and the checks: typecheck, build, smoke test, the outage drills (text and vision), the judge's screenshots. End on "Live".
- Labels: "Sped up. Real build." and, if it ran on Contributor, "Test model".
- Say: "I describe what I need in one sentence. Muse Code, Meta's coding agent, plans it, writes it and checks it: types, a build, a smoke test, outage drills, and a judge that looks at the screens. [N] minutes later, it's live."
- [N] from the hero build's log entry. If Look first is on and passed its test build, keep 3 seconds of the first screens with sample data and add "It shows me the screens first."

**4. The product (0:54 to 1:06)**
- On screen: the live product. Readings in; the controller at −18 °C and the probe at +9 °C and rising; the app says not to trust the controller. Then a door photo, and SAM 3.1 marks the open door.
- Label: "Simulated cold room".
- Say: "It reads the controller, a second probe, the door and the power. When the controller says minus 18 and the probe says plus 9 and climbing, it says don't trust the controller. Meta's SAM 3.1 watches the door."

**5. A leak is a bad day too (1:06 to 1:26)**
- On screen: `/private`, before and after, then a few seconds of the replay recorded on Muse Glimmer, then the numbers card.
- Labels: "Muse Glimmer 30B in the cloud for this demo. Invented data."
- Say: "A leak is a bad day too. Muse Privacy lets Muse plan with tags like Student A, never the files. Muse Glimmer reads them, in the cloud here, on invented data, and a last check runs on every result. On 200 invented items, zero names or identifiers got out."
- Why this wording (Nov 3): the submitted path runs Muse Glimmer 30B on OpenRouter, so "keeps documents on hardware you own" was false for what is filmed, and "leaked nothing" claims more than the checker counts (the page itself says no run shows that nothing gets out).
- "Before and after" only renders with `STORY_PAGES=1` (read at build time, so it takes a redeploy). With it off, open on the page header and the replay instead; everything else in this shot is on the live page today.
- Hide the walking mascot first (the "..." next to Guest, then Settings, "Muse on screen"), or it crosses the replay's buttons.
- The card, from the Nov 2 rerun (PR #98): "Muse Glimmer 30B in the cloud, through OpenRouter, today's setup, Nov 2: 0 leaks of names or identifiers on 200 invented items. Nothing shared that should have waited or stayed. The router right 71.5% of the time, with 101 approval requests, 50 of them not needed."
- Film the replay by stepping through it: scene A's grading wait is 125 s and scene E's overnight run 627 s. Scene F (government records) isn't in the cloud recording, so don't show or mention it.
- Never "device-only" or "nothing leaves the device" while Glimmer runs in the cloud.
- Source: the Muse Privacy rerun entry in docs/BUILD_LOG.md (PR tg-privacy-glimmer).

**6. Where it ran (1:26 to 1:38)**
- On screen: the product page's "Where it ran" stage: a Mac and a Windows PC from the AWS device lab, a real Galaxy S25 through AWS Device Farm, and the iPhone simulator, each playing the run made on that device.
- Say: "And it runs where people are: on a Mac and a Windows PC in our device lab, and on a real Galaxy S25 through AWS Device Farm."
- If the cold-room product's device runs haven't happened, film Dinner Split Helper's stage with the caption "Another app Muse Muse built", and keep the iPhone labeled "Simulated".
- Source: docs/BUILD_LOG.md, the device runs (lab demo-1102, Device Farm run 3abcc4b7, or the cold-room runs once logged).

**7. Cable out (1:38 to 2:14)** [Hussam films]
- On screen, one take, not sped up: a Jetson Orin Nano 8GB on a desk next to the prop "cold room" (Hussam picks the prop; it needs a door SAM can see). The cold-room app runs on the board with Meta's SAM 3.1 beside it. Hussam pulls the uplink; a terminal shows Meta's API unreachable. The app keeps answering on the board. The door opens; the laptop camera sends a frame over the local link; SAM 3.1 on the board marks the door. A spoofed reading (controller −18, probe +9) is flagged.
- Labels: "Simulated cold room. Real board, real unplug." and the app's own "Seen on the board by Meta SAM 3.1".
- Say (Hussam): "This is an eight-gigabyte Jetson running the app Muse Muse built, and Meta's SAM 3.1. I'm pulling the uplink. Meta's cloud is gone, and the app keeps answering from the board. I open the door, and SAM, on the board, sees it in [X] seconds. A spoofed controller reading: flagged."
- [X] from this take only.
- Optional 4 seconds, only if the jetson-02 clip exists: Muse Glimmer one-bit answering one short chat. Say: "And that's Muse Glimmer, Meta's 30-billion-parameter model, cut to one bit, answering on the same kind of board." Lower third: "Muse Glimmer 30B, one-bit (IQ1_S). Built with Muse Spark Open. 18 and over." Never a document task.
- Plan B, if SAM on the board isn't ready: the app's fixed rules on the board flag the spoofed reading, labeled "Answered on the board by fixed rules, no model", and the door beat is dropped.

**8. Under the hood (2:14 to 2:38)**
- On screen: one card per model, with its number.
  - Muse Code: "wrote every line of every app".
  - Muse Wonder: "plans and judges".
  - SAM 3.1: "sees, in the cloud and on the board".
  - Muse Spark Open, on Fireworks: "runs inside apps" (only once a product has used it and it's logged).
  - Muse Glimmer 30B: "tuned in 42 minutes for $1.39; beat base Glimmer on all 40 held-out prompts, judged blind by Muse Spark 1.3".
  - Then "[N] apps live" and "more than 4,000 tests".
- Say: "Every line of that app was written by Muse Code. Muse Wonder plans and judges. SAM 3.1 sees, in the cloud and on the board. Muse Spark Open runs inside apps through Fireworks. We tuned Muse Glimmer in 42 minutes for a dollar thirty-nine, and in a blind check it beat the base model on all 40 prompts it had never seen. [N] apps Muse Muse built are live today."
- Drop the Spark Open sentence if it isn't logged. [N] from the gallery count on recording day.
- Source: docs/STORY.md and docs/MESSAGING.md for the tune; docs/BUILD_LOG.md for Spark Open.

**9. Close (2:38 to 2:50)**
- On screen: Ethan and Hussam on camera, then a card with https://muse-muse.vercel.app, the repo URL and "Not an official Meta product."
- Say: Hussam: "We're Offline Base." Ethan: "Muse Muse: your own AI, on your own hardware, ready for any scenario."

## The X posts (Most Viral, engagement counts through Nov 8)

- **Tuesday night teaser, about 15 seconds:** shot 7 cut down: the cable comes out, the door opens, SAM marks it on the board. Post text: "Cable out. Still watching. An app Muse Muse built on Meta's models, running on a Jetson with SAM 3.1. Simulated cold room, real board, real unplug. Full demo tomorrow."
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
| 7 to 9 PM | Hussam, Ethan | Two rehearsals and one take of shot 7; the jetson-02 Glimmer clip if there's time. Hard stop at 9 PM |
| Night | Ethan, Hussam | Edit; post the teaser |
| Wed by 9 AM | Ethan | Upload the cut, check the link signed out, post the 60 seconds |
| Wed by noon | Ethan | Submit, with both of you listed |
