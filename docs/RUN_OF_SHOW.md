# Run of show: the stories and the 3:00 script

Written Nov 3, 2026, about 12:30 PM ET, from the owner's Nov 3 direction answers (they override older docs where they disagree). docs/VIDEO.md is the older script and is being edited by another agent; this file is the plan to film from. Its readiness checklist and go or no-go times come from the Nov 3 run of show (snapshot, deploy, rehearsals), summed up in "Owner commands" below.

What changed from VIDEO.md, per the owner: several stories instead of the cold room only, teachers among the hero users, the new problem line, both founders on camera the whole time, app building and tuning shown as one run, full beats for Muse Privacy, tuning on the site and Hussam on the boards, credit "Muse Spark" in general, and exactly 3:00.

## Rules for the cut

- **Exactly 3:00.** 360 spoken words, 120 a minute (the cap is 140), with numbers counted as spoken. No spoken segment goes over 140 a minute. Read it aloud against a timer once before the edit.
- **Both faces the whole time.** Screen on the left, Ethan and Hussam in two camera boxes on the right. The one talking is a little larger. Record both cameras for the full cut, even when the other one narrates.
- **Real time, with one jump.** Everything plays in real time except the build wait in story 1, which is one hard cut with the card "[N] minutes of building, cut". Anything else that has to be shortened gets the label "Sped up".
- **Music:** royalty-free only, from the YouTube Audio Library or Pixabay Music. Check the license line on the track's page when downloading, keep it about 20 dB under the voices, and write the track's title and license in docs/BUILD_LOG.md.
- **No users or customers.** Every hero user is an example: say "say a teacher", show the lower third "Example task. Made-up class", and never imply that a school, teacher, team or company uses Muse Muse.
- **Labels carry the honesty:** "Test model: Muse Spark 1.3 Contributor" on every build and product shot, "Made-up data" (or "Invented data" on Muse Privacy), "Built with Muse Spark Open. 18 and over." on every r30b or Glimmer tune shot.
- **Never in frame:** .env.local, the Vercel, AWS, Lambda, Baseten, Modal or fleet consoles, admin job pages, the Hub token page, board addresses, the ngrok domain, jetson-05, a "What was checked" list with red rows, the deploy line with the image URI, and the Claude or ChatGPT tab labels.
- Browser at 1440x900, light theme, 100% zoom, signed out unless a shot needs the builder sign-in. No em dashes in captions or cards.

## The script

| Time | Beat | Who | Spoken words | Line |
|---|---|---|---|---|
| 0:00 to 0:06 | Problem | Ethan | 14 | "People know their jobs, but getting custom software built takes engineering they don't have." |
| 0:06 to 0:18 | Firsthand, ed tech | Ethan | 28 | "I'm in ed tech. Teachers hop tool to tool for one day's lessons, and paste private data into AI. My family asks if ChatGPT gets them in trouble." |
| 0:18 to 0:26 | Firsthand, mission-critical | Hussam | 18 | "In aerospace and at TSMC, mission-critical work bans or limits chatbots, instead of tuning and testing one." |
| 0:26 to 0:32 | Before and after | Ethan | 13 | "Before this week: Jetsons and fleet software. The rest, we built this week." |
| 0:32 to 0:58 | Story 1, a class game | Ethan | 48 | "Say a science teacher wants a review game. They type the lesson topic. Muse Code, Meta's coding agent, plans it, writes it and checks it. [N] minutes later, it's live: ten questions on the water cycle, teams, a timer, and a recap of what each team missed." |
| 0:58 to 1:12 | Story 2, a tutor | Ethan | 29 | "Or a tutor that won't hand over answers. Ask it for the answer, and it asks what you'd try first, then checks each step. It runs on Muse Spark." |
| 1:12 to 1:34 | Story 3, Muse Privacy | Ethan | 40 | "Grading means private student work. Muse Privacy lets Muse plan with tags like Student A, never the files. Muse Glimmer reads them, in the cloud here, on invented data. On 200 invented items, zero names or identifiers got out." |
| 1:34 to 2:04 | Story 4, a mission-critical team tunes its own model | Hussam | 60 | "A mission-critical team tunes and tests its own model. One sentence plans the app and the tune. Muse Spark wrote 200 made-up examples. Muse Glimmer trained 32 minutes on one rented GPU, and beat its starting model on 19 of 20 held-out prompts. Baseten hosts it for a second check, and it's on Hugging Face." |
| 2:04 to 2:30 | Story 5, Hussam on the boards | Hussam | 59 | "I run our boards from Muse Muse. This Jetson runs Meta's SAM 3.1 next to an app Muse Muse built. I pull the uplink, open the door, and SAM marks it in [X] seconds. Then I ask Meta's model to read this UNO Q's sensors and drive it. The stop is plain code on the board." |
| 2:30 to 2:50 | Montage | Ethan | 36 | "Every app comes with an MCP server, a command line tool and a plugin. Muse Glimmer ran on a Galaxy S25 and on a Jetson. And Muse Spark Open starts on GPUs we rented." |
| 2:50 to 2:57 | Close (two versions below) | Both | 15 | Theme A or B, below. |
| 2:57 to 3:00 | End card | None | 0 | www.musemuse.dev, the repo URL (only once the repo is public), "Muse Muse, by Offline Base", "Not an official Meta product." |

Total: 360 spoken words in 3:00 (2:57 of voice, then the end card). Counted as spoken: [N] and [X] as two words each (say [X] as a whole number of seconds), "SAM 3.1" as four, "S25" as three, "200" as two. Story 5 is the tightest, at 136 a minute. Each conditional line below is the same length or shorter, except the M10 fallback (three words longer, still 117 a minute), so a fallback never pushes a segment over the cap.

### The firsthand story (0:06 to 0:26)

Both on camera, no screen, or the screen dimmed under them. It is their own experience, said in the first person, and it says nothing about users.
- Ethan's line keeps the family's question as the owner gave it. If naming ChatGPT feels wrong on the day, say "if AI gets them in trouble" (same length). The class game and the tutor that doesn't give answers, the other two family questions, open stories 1 and 2, so they aren't repeated here.
- Hussam's line: Hussam confirms the wording and that naming TSMC is fine. If not, "In aerospace and chip fabs" in place of "In aerospace and at TSMC" (same length).
- "Testing" stands for "evaluating"; it is shorter to say and means the same here.

## The stories

Each story is one hero user and one finished task. All data is made up.

### Story 1: a teacher's class game (0:32 to 0:58, Ethan)

- **Hero user and task:** a 7th grade science teacher (made up) types a lesson topic and gets a class review game that runs on the classroom screen.
- **On screen, real time with one jump:**
  1. www.musemuse.dev Make page, signed in with the builder code. The note goes in (paste it, about 3 s), then Start.
  2. The build room www.musemuse.dev/b/<id>: the plan card and the first to-dos (about 4 s).
  3. The jump card: "[N] minutes of building, cut". [N] is the room's own whole-build time.
  4. The same room ending on Live (about 2 s).
  5. The live game at musemuse-<slug>.vercel.app: type "the water cycle", the ten questions appear, then one question played with two teams, the scoreboard and the recap (about 15 s).
- **Lower thirds:** "Example task. Made-up class." and "Test model: Muse Spark 1.3 Contributor".
- **The note:** `classgame` in `npx tsx scripts/demo-batch.ts --set=showcase classgame --dry` (511 characters).
- **Say "ten questions on the water cycle, teams, a timer, and a recap" only if the live app does all four.** Otherwise say what it shows, with the same number of words or fewer.

### Story 2: a tutor that doesn't give answers (0:58 to 1:12, Ethan)

- **Hero user and task:** a made-up 8th grader asks the tutor for the answer to 3x + 5 = 20 and gets a guiding question instead, then a step check.
- **On screen, real time:** the live tutor at musemuse-<slug>.vercel.app. Type "just tell me x". The tutor asks what to do first. Type "subtract 5 from both sides". It checks the step and asks the next question.
- **Lower thirds:** "Example task. Made-up student." and "Test model: Muse Spark 1.3 Contributor".
- **The note:** `tutor` in the same set (531 characters). No build-room footage is needed, so it can run from the script.
- **"It runs on Muse Spark" is true** because the product's calls run on Spark 1.3 Contributor, a Muse Spark model, under `BUILDS_ON_CONTRIBUTOR`. If it was built or is filmed after the Nov 4 flip, check the Models chip before saying it (see "Credit wording").

### Story 3: private student work with Muse Privacy (1:12 to 1:34, Ethan, full beat)

- **Hero user and task:** the same kind of teacher grading essays (invented), with Muse planning from tags while Muse Glimmer reads the files.
- **On screen, real time (the replay has no network calls, so each click shows the next step at once):**
  1. www.musemuse.dev/private, as a guest, mascot hidden (the "..." next to Guest, Settings, "Muse on screen"). The header and top note (about 3 s). With `STORY_PAGES=1` deployed, the Before and after cards: Dana Whitfield, ID 900142, then [Student A] scored 3 of 4 (about 4 s).
  2. "See one run", scene Grading essays: Next step four times, ending on save_on_device saved (about 7 s).
  3. Scene "Pushing for private records", one step: refused (about 4 s).
  4. "What the tests show": 0 of 200 wrong shares, 71.5% with 101 approvals (about 4 s).
- **Labels:** "Recorded Nov 2, not live." and "Muse Glimmer 30B in the cloud for this demo. Invented data."
- **Never:** "on the device", "nothing leaves the device", "it leaked nothing", FERPA, or that a real teacher or school ran it.

### Story 4: a mission-critical team tunes and tests its own model (1:34 to 2:04, Hussam, full beat)

This is the owner's "app builder and tuning as one run": one sentence in the Make box plans both.
- **Hero user and task:** a team with mission-critical handoffs (made up: a restaurant's cold room shift handoff) tunes and tests its own summarizer instead of banning chatbots.
- **On screen, real time:**
  1. **The plan, a new take (about 6 s).** Signed in as admin, the home page's Make box. Type the cold-room handoff sentence the overnight run used. The plan card shows the app and the tune together, with "What it costs". Don't press Start. Caption: "Plan made live. The results next are from the Nov 3 run of this sentence."
  2. **The run (about 4 s).** Signed in: www.musemuse.dev/fine-tuning/runs/ebad9aad-0167-495e-8679-c3fab7472720, the top only, steps done. Keep the admin Hugging Face, Local files and SimTune cards out of frame.
  3. **The result (about 10 s).** Signed out: www.musemuse.dev/fine-tuning/83ae46c8-4e57-4086-866c-da69a39a20d0. The run (1x H100, 32 min, $1.75), the 19 of 20 strip, Prompt 20 (base 2, tuned 9).
  4. **The partner check (about 5 s).** The run room's "Evaluated on Baseten" card, after the owner's partner eval run.
  5. **Hugging Face (about 5 s).** The public model page, signed out, the card's top and Results.
- **Captions:** "Judged by Spark 1.3 Contributor. One task, 20 held-out prompts." "Built with Muse Spark Open. 18 and over." "Test model. Made-up data."
- **Partners, as the owner asked (all, or pick):** pick **Baseten**. Fireworks can't host it: it refuses r30b adapters and regex target modules, and its account answered 412 on Nov 2. Modal is the second choice (`PARTNER_EVALS=modal`, about $4.85 an hour), but its first deploy may not fit the 4-minute sandbox. One partner, run once, is enough for the line.
- **Data rights:** the owner said yes on Nov 3 to publishing weights trained on Spark-written data (Q2 in docs/DATA_RIGHTS.md). Q1 (Fireworks-written rows in r30b) and Q3 (NC or ND sources) were accepted for publishing on Oct 31; write the owner's yes for the submission into DATA_RIGHTS.md before pressing Publish.
- **Conditional words, each the same length or shorter:**
  - No plan take: "One sentence plans the app and the tune." becomes "It starts from one plain sentence."
  - No partner run logged: "Baseten hosts it for a second check, and it's on Hugging Face." becomes "And it's on Hugging Face." Neither logged: "Every number is on its page."
  - Hub not public on a signed-out check: drop "and it's on Hugging Face"; a private repo is shown only signed in, with the Private badge in frame.
- **Never:** "judged by Muse Wonder", that it beats Glimmer in general, "r30b", 19 of 20 next to 40 of 40, or that the tune runs on a board or phone.

### Story 5: Hussam runs the boards from Muse Muse (2:04 to 2:30, Hussam, full beat)

Two takes, both Hussam's; he owns the boards, `muse-device` and the rover kit.
- **Jetson (about 14 s, one take, not sped up, 7 to 9 PM tonight).** jetson-04 beside the prop door, cold-door-watch (built by Muse Muse) running on the board with Meta SAM 3.1 on loopback. Hussam pulls the uplink, opens the door, and the app answers "Seen on the board by Meta SAM 3.1". Label: "Simulated cold room. Real board, real unplug." It has never run. Kit and checks: docs/EDGE_DEMO.md section 6 and scripts/edge/sam3/LOCAL.md.
- **UNO Q (about 12 s, go or no-go 3:30 PM).** The rover on the floor (phone camera), then /device on the tg-d-hussam-devices Preview, signed in as admin, fleet card out of frame. Hussam asks "Read the rover's distance sensors, then drive forward slowly for one second." The answer shows rover_ranges then rover_drive, and the rover brakes by the box. Lower third: "Real rover on an Arduino UNO Q. Muse Wonder through our office fleet." The ask runs Muse Wonder, so crediting Wonder here is true.
- **What the owner asked that isn't there:** "Muse Muse building something that controls the UNO Q." No product can drive it today: the rover tools aren't in `PRODUCT_GADGET_TOOLS`, and product robotics is simulated only. So the film shows Muse Muse's own /device page connecting to the UNO Q and driving it, and never says Muse Muse built the controller. Building one needs Hussam's `muse-device` work and is his call; it is not on tonight's plan.
- **Conditional words:**
  - Jetson at fallback B (the app on the laptop with Wi-Fi off, SAM on the board over the cable): "This Jetson runs Meta's SAM 3.1, and our laptop is offline." Fallback D (office network, uplink in): "This Jetson in our office runs Meta's SAM 3.1." and drop the uplink sentence; give its seconds to the rover.
  - Say "marks it" only if open and shut separated in the warm-up; otherwise "finds the door".
  - Rover by drive pad only: "Then I drive this Arduino UNO Q from Muse Muse's device page." and drop the Wonder lower third. (The full name is on the lower third either way.)
  - Rover cut: the Jetson take gets all 26 s, and the last sentence stays only if a board in the shot has a stop in code.

## The montage (2:30 to 2:50, Ethan)

Ten 2-second shots, captions carrying the facts. Order as listed; drop from the bottom if a shot isn't ready, and give its time to the shot before it.

| # | Shot | Caption, exact |
|---|---|---|
| M1 | www.musemuse.dev/p/handbook-proof-checker, Get it, CLI tab with the Tested badge, then the terminal's verified answer (Section 4.2, page 4) | "Every app comes with an MCP server, a CLI, a plugin and a gadget pack. Tested on this one." |
| M2 | /p/dinner-split-helper, "Where it ran" | "Another app Muse Muse built: a Mac, a PC, and a real Galaxy S25 in AWS Device Farm. iPhone: simulated." |
| M3 | Still card from the Nov 1 Device Farm run | "Muse Glimmer 30B, one-bit, on a real Galaxy S25 in AWS Device Farm: about 2 tokens a second. Nov 1. Built with Muse Spark Open. 18 and over." |
| M4 | jetson-02 answering one short chat, framed on the tokens-a-second readout | "Our one-bit Muse Glimmer 30B on a Jetson Orin Nano 8 GB: about 5 tokens a second. Speed only." |
| M5 | compare.py from jetson-04: Meta's weights and the tune on "muse" and "plush toy" | "SAM 3.1 learned the word "muse" on a Jetson. Meta's weights already find it as "plush toy". Made-up images." |
| M6 | paper-lantern-museum in the browser's simulated Quest 3 | "A VR app Muse Muse built. Simulated Quest 3, no headset tried." |
| M7 | market-day-reader, web fallback reading a stall sign | "A glasses app Muse Muse built, shown on its phone fallback. Made-up market." |
| M8 | austin-budget-weekender, the run with three searches and sourced plans | "An agent Muse Muse built: three web searches, plans with sources. Made-up couple." |
| M9 | The yard-sale app (allapis): outlines, transcript, prices with sources, the listing photo | "One app, four of Meta's models and Meta's web search. Test model. Made-up data." |
| M10 | Terminal: `spark_endpoint.py status` InService, spark-take rows, then `delete` and absent | "Muse Spark Open 816B on 8 GPUs we rented on AWS. Nov 3. Then shut down." |

- **Spoken fallback for M10 if the take doesn't run or isn't logged:** "And Muse Spark Open wrote over 100,000 of our rows." (12 spoken words in place of 9), over huggingface.co/datasets/OfflineBase/Muse-Glimmer-30B-2026-Knowledge-Data/viewer/spark-stage1/train with the release column in view and the caption "Muse Spark Open wrote 112,318 of these rows on hosted endpoints. Each row names its host."
- **M4 is speed only.** Never film a document task or an answer someone could check; jetson-02's answers are short and often wrong (BUILD_LOG, Nov 3, 2:15 AM).
- **M5 carries its caveat on screen:** the tune adds a word, not accuracy, on made-up composite images.
- **M7 is the weakest:** in the Nov 3 target audit its spoken prices contradicted the sign it read. Film only a frame where the answer matches the sign, or drop it first.

## The close: two theme versions

Pick after tonight's board take (story 5's Jetson half). A is 15 spoken words and B is 16, at 2:50 to 2:57, both on camera.

**A. Build for Your World** (if the Jetson take is a no-go or runs at fallback D):
- Ethan: "You know your job. Muse Muse builds the software, on Meta's models." (12)
- Hussam: "By Offline Base." (3)
- **Form's theme line:** "Muse Muse turns one plain sentence from a teacher, a shop or a mission-critical team into a working app, or a model tuned and tested on their own task, on Meta's models."
- **Problem statement field:** Build for Your World. Its exact theme text isn't in docs/MESSAGING.md yet: copy it from the event page and mark it Checked before using it.

**B. Push the Frontier** (only if the cable-out take passed and is logged):
- Hussam: "Meta's models, on a board we own, with the cable out." (11)
- Ethan: "Muse Muse. Built this week." (5; the card adds "by Offline Base")
- **Form's theme line:** "Muse Muse turns one sentence into an app or a tuned model on Meta's models, and an app it built kept answering on a Jetson with SAM 3.1 when we pulled the cable."
- **Problem statement field:** Push the Frontier (docs/SUBMISSION.md field 4, already written for it; the theme text is Checked in MESSAGING.md).

The first 2:50 is the same under both themes.

## Every shot: source, state today, fallback

"Exists" means it can be filmed now (after the production deploy of current main). "Build" and "Take" need the owner command listed in the next section.

| Shot | Source URL or screen | State, Nov 3 midday | Fallback |
|---|---|---|---|
| Problem and firsthand | Both cameras, no screen | Take, $0 | Audio only over the gallery page, faces still in their boxes |
| Before and after card | Card made in the edit from README.md "Before the event" | Exists | None needed |
| Story 1, the note and room | www.musemuse.dev (Make, signed in), then www.musemuse.dev/b/<id> | Build: `classgame`, needs the new builder snapshot | The handbook-proof-checker room replay (www.musemuse.dev/b/6f98efc0-78fa-4977-88d8-e7e1942680fa) with the VO's first sentence "Say a team needs a handbook checker" and its last "[N] minutes later, it's live, and it quotes the handbook." |
| Story 1, the live game | musemuse-<slug>.vercel.app | Build, then two rehearsals | Cut to the tutor if it is Live and the game isn't; otherwise the fallback room above and its live product |
| Story 2, the tutor | musemuse-<slug>.vercel.app | Build: `tutor` | Cut story 2 and give its 14 s to story 3 (the full replay and the Before and after cards) |
| Story 3, Muse Privacy | www.musemuse.dev/private | Exists (copy fix on main; Before and after needs `STORY_PAGES=1` and a redeploy) | Today's page without Before and after; crop the top note if the copy fix isn't live |
| Story 4, the plan | Home Make box, signed in as admin | Take, cents (plan call only) | The run room ebad9aad top, with the conditional words |
| Story 4, the run and result | /fine-tuning/runs/ebad9aad-0167-495e-8679-c3fab7472720 (signed in), /fine-tuning/83ae46c8-4e57-4086-866c-da69a39a20d0 (signed out, 200) | Exists | If the run room shows anything admin-only that can't be framed out, use the result page alone |
| Story 4, Baseten | The run room's partner card | Take: one partner eval run, $3 to $5 | Drop the Baseten clause |
| Story 4, Hugging Face | huggingface.co/<HF_NAMESPACE>/muse-glimmer-30b-a-cold-room-handoff-summarizer-lora-83ae46c8 | Take: Publish, $0 to $1 | Private badge signed in, or drop the clause |
| Story 5, Jetson | jetson-04, the prop door, camera on the desk | Take, 7 to 9 PM, never run | Fallbacks B, C, D in LOCAL.md and EDGE_DEMO.md section 6 |
| Story 5, UNO Q | Phone camera on the floor, /device on the tg-d-hussam-devices Preview | Take, go or no-go 3:30 PM, about $1 | Drive pad only, then cut |
| M1 | /p/handbook-proof-checker CLI tab and terminal | Exists | The recorded CLI Prove it video, "Recorded Nov 3 by Muse Muse's own check" |
| M2 | /p/dinner-split-helper | Exists (captions need the deploy) | Frame the device screens without their captions |
| M3 | Still card | Exists, $0 | None needed |
| M4 | jetson-02 through `ask_fleet_model`, Hussam's screen | Take, $0, Hussam | A still card with the logged 5.2 to 5.5 tokens a second |
| M5 | compare.py page, office network | Take, $0, Hussam | Drop |
| M6 | paper-lantern-museum | Exists | Drop |
| M7 | market-day-reader | Exists, weak | Drop first |
| M8 | austin-budget-weekender | Exists (1 of 2 runs worked; film a good run) | Drop |
| M9 | The yard-sale app | Build: `allapis` | The 3-app cut: room-restyle-studio, standup-scribe-notes, parking-policy-reader, "Three apps Muse Muse built, three Meta APIs. Test model." |
| M10 | Terminal, AWS profile, no console | Take, $45 to $62 | The Hub dataset viewer and the spoken fallback above |
| End card | Made in the edit | Exists | Leave the repo URL off until the repo is public |

## Credit wording

- **Say "Muse Spark" in general (owner's choice).** It is true because every build and product shown before Nov 4 ran on Muse Spark 1.3 Contributor, which is a Muse Spark model. The lower third names it exactly: "Test model: Muse Spark 1.3 Contributor".
- **Never name Muse Wonder for a run that didn't use it.** The only Wonder run on screen is the rover ask on /device. "Judged by Muse Wonder" is never said: the tune was judged by Spark 1.3 Contributor.
- **Muse Spark Open** is named on its own: it wrote the knowledge rows behind r30b ("Built with Muse Spark Open. 18 and over." on every r30b or tune shot), and M10's take if it runs.
- **From Nov 4, judging runs on Muse Wonder** after the flip. Say it only in the submission text and only after the flip is deployed: "Judges' builds run on Muse Wonder." Any shot filmed on Nov 4 after the flip gets its lower third from the product's Models chip, not from this file.
- Muse Code is "Meta's coding agent". Muse Glimmer and SAM 3.1 are named as themselves.

## Owner commands, with costs

Nothing below has run. The spend cap is $100 through Nov 4, Wonder judging included.

1. **Before any build:** the new builder snapshot and a deploy of current main, as in the Nov 3 run of show (`npm run snapshot` in a worktree with .env.local, commit lib/sandbox/snapshots.json, set Production `BUILDER_SNAPSHOT_ID`, push). $0 in Meta credits, Sandbox minutes only.
2. **Story 1, filmed:** sign in on www.musemuse.dev with the builder code, start the screen recorder, print the note with `npx tsx scripts/demo-batch.ts --set=showcase classgame --dry`, paste it and press Start. About $0.27 to $0.40 in Meta credits on Contributor (the Nov 3 target builds' range), 46 to 100 minutes, capped by the build token's $10.
3. **Story 2 and M9, no footage needed:** from a worktree with .env.local, `npm run demo-batch -- --set=showcase tutor allapis`. About $0.27 to $0.40 for the tutor and $0.40 to $1.20 for allapis. **Note:** `npm run demo-batch -- --set=showcase` with no ids now starts all three (allapis, classgame, tutor); name the ids to start fewer.
4. **Rehearsals:** each live product twice before filming, about $0.03 a run, about $0.25 in all.
5. **Story 4, the plan take:** signed in as admin, type the sentence in the Make box and film the plan card. Don't press Start. Cents for the plan call. (Pressing Start makes a new both-run: about $1.80 for the tune plus $0.27 to $0.40 for the build, 41 to 45 minutes or more. Not needed.)
6. **Story 4, Hugging Face:** read the run room's Hub card, then case 3a or 3b from the tune segment: `printf '1' | vercel env add HF_PUBLIC production --force` and a redeploy, then Publish in the run room. $0 if the adapter is already up, at most $1 (likely about $0.25) for a glimmer-publish job if not. Read the card signed out before filming.
7. **Story 4, Baseten:** the seven steps in docs/BUILD_LOG.md, "Owner steps to try it once on the overnight cold-room tune" (merge is already done; set `BASETEN_API_KEY` and `HOST_HF_TOKEN` at the prompt, `printf '1' | vercel env add HOST_TUNED production --force`, `printf 'baseten' | vercel env add PARTNER_EVALS production --force`, redeploy, then `curl -sS -X POST https://www.musemuse.dev/api/train/jobs/83ae46c8-4e57-4086-866c-da69a39a20d0/partner-eval -H "authorization: Bearer $AUTOMATION_SECRET" -H 'content-type: application/json' -d '{"provider":"baseten"}'`). About $3 to $5, at most $8.10. **Turn both flags off right after** (`vercel env rm PARTNER_EVALS production`, `vercel env rm HOST_TUNED production`): with them on, every tuned and published job starts a paid deploy by itself. Do step 6 first: every partner path loads the adapter from the Hub. The owner chose a public page, so step 6's public repo serves both. (To stay private until filming, use the partner entry's `printf '0' | vercel env add HF_PUBLIC production --force` instead, publish, run the eval, then switch to 1 and Publish again.)
8. **M10, the Spark Open take (owner's yes; AWS had no machine twice on Oct 30):**
   - `.data/aws/venv/bin/python scripts/knowledge/aws/spark_endpoint.py deploy --hours 1.5` (auto-deletes after 1.5 hours, about $62 at $41.43 an hour; the earlier plan's `--hours 2` caps at about $83).
   - Poll `.data/aws/venv/bin/python scripts/knowledge/aws/spark_endpoint.py status` until InService (load timeouts are 60 minutes).
   - `.data/aws/venv/bin/python scripts/knowledge/aws/relay.py --endpoint muse-spark-open-knowledge`. **The `--endpoint` flag is required:** relay.py defaults to `muse-glimmer-knowledge`, so without it the take talks to an endpoint that doesn't exist.
   - `npx tsx scripts/knowledge/spark-take.ts --host sagemaker-own --yes` (rehearse first with `--dry-run`, $0).
   - `.data/aws/venv/bin/python scripts/knowledge/aws/spark_endpoint.py delete`, then `status` until it prints absent, then a BUILD_LOG entry. InService by 5 PM or delete.
9. **Story 5:** Hussam's rover steps (power ArduinoQ-01, a dedicated admin `jpt_` token, the Preview of tg-d-hussam-devices with `ROVER_ENABLED`, `BOARD_FLEET_URL` and `BOARD_FLEET_TOKEN` on that Preview only), about $1 in Wonder calls; revoke the token and remove the Preview vars after. The Jetson take: LOCAL.md and EDGE_DEMO.md section 6, $0.
10. **Nov 4, the Wonder flip:** docs/JUDGING_WEEK.md, "Flip to Wonder" (check `BRIEF_MODEL`, `JUDGE_MODEL`, `BUILD_MODEL` and `COMPLEX_BUILD_MODEL` are `muse-wonder-1.0` first). Set `DAILY_SPEND_CAP_USD` to what is left of the $100; a Wonder build is about $4.

### Spend under the $100 cap

| Item | Estimate | Worst case |
|---|---|---|
| classgame, tutor, allapis builds | $0.94 to $2.00 | $30 (three $10 build caps; no build has come near) |
| Rehearsals and the plan take | about $0.30 | $1 |
| Hugging Face publish | $0 to $0.25 | $1 |
| Baseten partner eval | $3 to $5 | $8.10 |
| Rover asks on Wonder | about $1 | $2 |
| Spark Open take, `--hours 1.5` | $45 to $62 | $62 |
| **Before judging** | **about $50 to $70** | |
| Left for Wonder judging on Nov 4 | about $30 to $50 | set `DAILY_SPEND_CAP_USD` to it |

Without the Spark Open take, everything before judging is about $5 to $9, leaving about $90 for Wonder judging.

## Rehearsal checks for the new stories

The checks for Privacy, the tune page, the CLI, the yard-sale app, the rover and the cable-out take are in the Nov 3 run of show. New ones:
- **Class game:** the room says Live with the model-credits check passed; "the water cycle" makes ten questions a 7th grader could answer, with an answer key that can be edited; two teams, a timer and a scoreboard work by mouse on a 1440x900 screen; the recap lists each team's misses. Twice, under about 90 s a run, no error banner.
- **Tutor:** "just tell me x" gets a guiding question and no answer, three times in a row; a right step is confirmed and a wrong one gets a hint; the answer is confirmed only after the student writes x = 5. If it gives the answer once in the three tries, use Change with one line ("never state the final answer before the student does"), about $0.10 to $0.30, or cut story 2.
- **Both:** the footer shows the Contributor notice, and the Models chip reads Spark 1.3 Contributor.
- **The script:** read all of it aloud with a timer. If a line runs long, cut words, not seconds.
