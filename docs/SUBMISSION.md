# Muse Muse submission

Meta Global AI Developer Hackathon, Startup track. Due Nov 4, 2026, 9 PM ET.

- **Live site:** https://muse-muse.vercel.app (open to anyone, no sign-in)
- **Repo:** https://github.com/Offline-Base/muse-muse (private until the owner makes it public)
- **Video:** PLACEHOLDER: the link, once recorded

This file has three parts: the write-up, the video script and the submission checklist.

## 1. Write-up

### One line

Give it a muse and Muse makes it: drop in an example, and get a tested, deployed product built by Muse Code on Meta's models.

### The problem

Meta's Model API reads photos, video and PDFs, makes and edits images, outlines and tracks objects, and transcribes speech. Few developers build on it.

- On OpenRouter's rankings for the week of Oct 19, 2026, Meta wasn't among the top nine model authors.
- Meta's own Videos page still shows Llama-era demos. All six on the first page use Llama (checked Oct 26). None shows Muse Spark, SAM 3.1, Muse Image or Voice Transcribe.

App builders also start from a text prompt. People usually know what they want by pointing at it: a photo, a screenshot of an app, a sketch on a napkin.

### What it does

1. **Muse.** You drop in inspo (photos, screenshots, sketches, a short video, a voice memo or a PDF) and an optional note, like "make this, but for my bakery."
2. **Brief.** Muse Wonder reads the inspo and writes a structured brief: the product, who it's for, the Meta models it needs and why, honest limits, cost per use, and what it takes from the inspo and leaves out. It refuses requests that impersonate people or organizations, clone a real brand, or involve weapons, malware or scams.
3. **Build.** Muse Code runs headless on Muse Wonder in a Vercel Sandbox microVM and writes a Next.js product from a starter template. Every product shares a Meta-family look (Facebook's design tokens, Inter and Montserrat, an app bar, segmented choices, a composer, AI result cards) that the template's `meta-ui` skill teaches. You watch the log and a live preview in the build room.
4. **Check.** Typecheck, build, the smoke test Muse Code wrote, a screen check, then Muse Wonder judging screenshots against the brief. Failures go back to the same Muse Code session with the judge's screenshots, up to three rounds.
5. **Demo video.** Demo Studio replays the smoke test with a recorder, then edits a 1920×1080 launch clip: an intro card, the app in a browser window with its real URL, a cursor that glides to each control, typing key by key, a camera that zooms in on what is typed and on each result, model waits sped up with a badge that says by how much ("Waited 14 s, sped up"), captions below the window, and an outro with the live link.
6. **Ship.** The product deploys as its own Vercel project. It calls Meta only through the platform's metered gateway, with its own scoped, budgeted token.
7. **Use in Muse.** Its actions become an MCP connector that the Muse app (or Claude Code) can add.

Every product it ships is new, metered Meta API usage. The dashboard's headline number is "Meta tokens driven."

Two more parts sit on top:

- **Rebuilds.** One command rebuilds Meta's Llama-era demo videos on current Muse models, plus first demos for the models Meta has no video for: SAM 3.1, Muse Image, Voice Transcribe and Muse Wonder.
- **Fine-tuning lab, "Spark teaches Glimmer."** Muse Wonder writes a training set, Muse Glimmer 30B learns it with a LoRA adapter on the owner's Lambda GPUs, and Muse Wonder judges base against tuned, blind. The name comes from the runs so far: Muse Spark 1.3 wrote their dataset and judged them. Results are public and read-only at `/fine-tuning`. Each judged adapter then publishes itself to Hugging Face with its training data and a card that tells why it was made.

### How it uses Meta's models

| Model or tool | Where Muse Muse uses it |
|---|---|
| **Muse Wonder 1.0** | The default for every platform role. Reads every reference (images, video, PDFs) and writes the brief with strict JSON-schema output, or refuses, and checks each refinement request against the same policy. Muse Code's model for every build and its fix rounds. Judges each build's screenshots. The default model inside products, for their own text and vision calls. For new fine-tuning runs, writes the dataset, judges base against tuned Glimmer, and writes the "Why this exists" story on each Hugging Face card. |
| **Muse Spark 1.3** | Not used since Oct 29, and the brief writer no longer offers it. Before that it was the default for briefs, builds, judging and products. It wrote the lab's dataset (400 examples for $1.51) and judged both runs. |
| **Muse Spark 1.3 Contributor** | Runs wherever Spark 1.3 is still forced. A refinement of a product built on Spark 1.3 resumes Muse Code on it, and the gateway serves any live product that still asks for `muse-spark-1.3` with it, metered at its price ($0.10 in and $0.20 out per million tokens). It is also the test model: nearly all of the Nov 1 test builds ran on it, with made-up data. A flag, `BUILDS_ON_CONTRIBUTOR`, can run every build on it; check its production value before submitting, because this table says Muse Wonder builds. Meta may train on contributor prompts. |
| **Muse Image 1.0** | Inside products, for generating and editing images. It also made the three example photos on the Make page. |
| **SAM 3.1** | Inside products, to find, outline and count things in photos and video, such as the first SAM 3.1 demo. Results are parsed with Meta's `@meta-sam/parser`. |
| **Muse Voice Transcribe 1.0** | Turns a voice-memo muse into text before the brief. Inside products, after the browser converts audio to 16 kHz mono WAV, the only format the API accepts. |
| **Muse Code** | Writes every product, headless in a Vercel Sandbox: `muse exec --json` with hardened flags, `--session-id` to resume for fix rounds and refinements, `--image` for inspo and judge screenshots, `muse skills disable` for 15 bundled skills that fight a headless build, and `muse export --redacted` for each product's "How it was built." |
| **Muse Glimmer 30B** | The fine-tuning lab's student: a QLoRA fine-tune on Lambda GPUs, judged by Muse Wonder (Muse Spark 1.3 judged the runs so far), served live for side-by-side answers, and published to Hugging Face as a PEFT adapter with its data and card. Products can also call a hosted Glimmer endpoint through `GLIMMER_URL` when a brief asks for a local or private model. |
| **Meta Model API endpoints** | `responses`, `images/generations`, `images/edits`, `files` and `asr/transcribe`, which products reach only through the platform's gateway. Muse Code also calls `models` and `/muse-code/models` through the sandbox firewall. |
| **Meta's Videos page** | The rebuild set: `catalog/meta-resources.json` links each video and never copies it. |

### What's novel

- **Inspo first.** You show it what you mean instead of writing a long prompt. The brief records what it takes from the inspo and what it leaves out, and the judge fails a build that copies a brand or logo.
- **Real products, not mockups.** Each one passed its own tests, has a recorded demo, a Muse Code transcript, its own deploy and an MCP connector. A product that fails is never shown as working.
- **Untrusted code never holds a Meta key.** The sandbox firewall adds the key only on Muse Code's own routes. Products get scoped, budgeted, revocable tokens through a metered gateway.
- **Meta's own demos as the test set.** The rebuilds turn Meta's Llama-era videos into current demos on Muse models, with honest fit labels: clean, reframe or partial.
- **Measured, including what didn't work.** Muse Code's hidden reminder spend is found and charged. Product quality is scored blind, and a polish round that scored lower was not merged.
- **Spark teaches Glimmer.** The hosted model writes the data, the open model learns it, the hosted model judges blind, and the results are public, on the site and on Hugging Face.
- **Demos that edit themselves.** Every product's video is cut from its own passing test, with the waits sped up and labeled honestly, so a judge sees the product work instead of a spinner.

### What was hard

1. **Keeping the key away from generated code while Muse Code still works.** A blanket key transform would give any code in the VM the key's power. Now Muse Code holds a per-sandbox placeholder, and the firewall swaps it for the real key on four routes only. Every other request to `api.meta.ai` gets the firewall's 403.
2. **Muse Code with nobody watching.** Its launcher tries to self-update from a host the firewall blocks and may start a device sign-in, so the runner sets `MUSE_NO_AUTO_UPDATE=1` and `MUSE_LOGIN=0`. Its own bubblewrap sandbox can't run in the microVM, so `--yolo` is used and the VM is the boundary. Fifteen bundled skills fought the template, so the snapshot turns them off and checks. Flags differ between versions, so the runner adds optional ones only when `muse exec --help` lists them.
3. **Honest cost.** `run.usage` counts only the main agent. Reminder agents were 31% to 43% of each build's real Muse Code spend. The platform now reads the usage records in Muse Code's session logs, drops the records that reminder agents' own logs repeat, counts only the current run, and charges the rest.
4. **Media limits.** Voice Transcribe takes only mono 16-bit PCM WAV at 16 or 24 kHz, so products convert audio in the browser. Vercel Functions cap request bodies at 4.5 MB, so large files go straight to Vercel Blob with short-lived upload tickets. Meta fetches media by URL, so the Blob store has to be public.
5. **Products that work but look generic.** A blind review averaged 5.5 out of 10. A template polish raised a canary from 5.14 to 5.91. A second round scored 5.50 and cost 64% more, so it stayed on a branch. What worked was a design system: Meta's look, researched from public sources and taught as a skill. Three judges compared 11 builds of the same muses blind, and the Meta-look builds won 30 of 33 votes (7.17 against 5.53).
6. **Demo videos that were half spinner.** The first videos replayed the test with Playwright's recorder: a static "Working…" screen for half the clip, captions over the app's buttons, no cursor, blurry text. Demo Studio records a timeline of every action, change on screen and wait, and edits from it: actions and results at real speed, waits sped up with a badge, and each new result scrolled into view and held.
7. **GPUs that bill by the hour.** Three things terminate every instance: the job's workflow, the instance's done callback, and a sweep every 5 minutes. Jobs won't launch unless that sweep ran in the last 15 minutes. The first real run then lost 28 to 11, and the cause was an eval bug, not the training (see Results).

### Results from the Oct 27 test runs

**Builds**

- 24 product builds in a local batch: 24 of 24 went live. The first batch of 17 covered all 10 catalog rebuilds and every model: Spark, Muse Image, SAM 3.1, Voice and Wonder. Then came 7 more.
- 3 to 9 minutes each, about $0.30 to $1.80 in Meta credits each.
- Every product got a recorded MP4 demo, a Muse Code transcript and an MCP manifest with actions.
- Local runs stop before the deploy step, so these 24 are not on the live Gallery yet.

**Cost accounting**

- Muse Code's `run.usage` left out its reminder agents. They were 31% to 43% of each build's real Muse Code spend. The platform now reads Muse Code's session logs and charges them.

**Product quality**

- A judge-style blind review of 24 products' screenshots averaged 5.5 out of 10.
- After the template polish (themes, shared parts, a screen check in each product's own tests, copy rules), an 11-build canary of the same muses scored 5.91, up from 5.14 for those 11. All 11 went live.
- A second polish round scored lower (5.50) and cost 64% more, so it was not merged.
- Oct 28, the Meta look: the same 11 muses rebuilt on the Meta-family template, all 11 live with no fix rounds, for $13.99 against $11.81. Three judges saw each pair side by side, with the sides shuffled and nothing saying which was new. The Meta-look builds won 30 of 33 votes and 10 of 11 pairs, scoring 7.17 against 5.53 overall and 7.94 against 2.39 for looking like a Meta app. The one loss was a spreadsheet whose chart drew no bars, which led to a check that fails a build whose last screen shows an error or an empty state.

**Fine-tuning**

- Smoke test on a real Lambda A10: about 3 minutes, $0.06.
- Dry run of the full loop on an A100: $0.13.
- Dataset "Muse Muse brief writer," written by Muse Spark 1.3: 400 examples (360 to train on, 40 held out) for $1.51.
- First real Glimmer 30B QLoRA run: A100 40 GB, 120 steps, final loss 0.47, 47 minutes, $1.59. Base won 28 to 11. That exposed an eval bug: training put every answer on Glimmer's final channel, but the eval prompt let the model choose, and the tuned answers never left the reasoning channel.
- The fix and a "short prompt" distillation setup are deployed. Eval prompts now continue on the final channel, as training does. Both models train and answer under a one-line role prompt instead of the teacher's full task prompt, so the score measures what training taught.
- Second run, with the fix and the short prompt: A100 40 GB, 120 steps, final loss 0.52, 42 minutes, $1.39 on the GPU plus $0.15 for judging. **Tuned Glimmer won all 40 held-out prompts**, average score 8.88 against 1.95 for base. Under the one-line role prompt, base Glimmer answers like a general assistant ("I can't see any photo attached, could you upload it again?"); the tuned model writes a full Muse Muse brief with the right models, honest limits and a cost per run.

### Results from the Nov 1 test runs

Full table with ids and costs: [PROVE_RESULTS.md](PROVE_RESULTS.md). Nearly all of these ran on a low-cost test model (Muse Spark 1.3 Contributor) with made-up data, and Previews don't publish, so these products have no live link.

**What passed, on the test model**

- 11 recipes across 8 builds went live, with smoke tests and the judge passing: verified agent, case agent, API, agent patterns, code sessions, visual reports, image, voice, SAM media, games and simulated loops. Most hand tests were shallow. Clip Scribe's transcription and Lantern Run's game were not finished by hand.
- A product with saved data kept its rows after a reload, seen from a second browser by the platform's own checks.
- Real Muse Code tasks ran inside a built product, confirmed at the gateway.
- Keep editing, restore, source download and the Code page. A restored version was byte-identical to the original in all 79 files.
- VR on an emulated Quest, glasses on a fake bridge, an extension loaded in real Chromium, a gadget on a simulated board, an agent with real web search, and Android, Mac and Windows packages from an admin route.

**Device lab, run directly on the boxes**

- A live product opened on Mac, Windows, an Android emulator and an iPhone simulator.
- On a real Samsung Galaxy S25 through Device Farm, it loaded in 1.3 seconds.
- Mock glasses connected on iOS 18.4, on a test page. They still fail on iOS 26.5, and the cause isn't known.

**Fine-tuning, run directly on rented GPUs through a test harness**

- Muse Glimmer 30B: tuned won 40 of 40 kept-aside prompts, 7.93 against 2.5, for about $1.86 of GPU. A short run on an invented subject, which is an easy test.
- Llama 3.2 3B: tuned 6.67 against base 2.55, won 95 of 100. A two-round tuning loop on top of it ran but did not improve the score (6.67, 6.67, 6.54).
- A short reinforcement learning run: tuned 40 of 40, base 27 of 40, on easy arithmetic. It also exposed a scoring bug, now fixed, that had reported 16 of 40 for the same adapter.
- A tuned Llama model became a 2 GB GGUF that answered at 168.8 tokens a second on the GPU.

**What did not work**

- A long build on Muse Wonder ran 64 minutes and $16.55 and did not finish. Its first five milestones failed, each round cut at 5 to 8 minutes, and no subagents started.
- The case agent never stopped to ask a person for evidence in a live run, and Larkfield's stop-and-ask was not seen.
- Sandbox previews don't respond in a browser without a config line that isn't in the template yet.

**Found and fixed along the way**

- Vercel's sandbox API refuses IPv6 ranges, so Muse Code sessions could not start on Vercel at all. Only real builds showed this.

### What's next

- Serve a tuned Glimmer adapter as a product backend through `GLIMMER_URL`, so a product can run on an open model the lab trained.
- Spoken replies and realtime voice once the Model API has text-to-speech and speech-to-speech. Products use browser speech synthesis until then.
- More lab tasks, each judged the same way against its own held-out prompts.
- Chained builds and platform powers, so one product can span many sessions and products can start their own. Both are built behind flags, tested with fakes only, and have never run for real.
- A time cap that lets big milestone builds finish on Muse Wonder.
- Check whether Muse app connectors work inside scheduled jobs.
- A name of its own. Muse is Meta's brand, so Muse Muse is a hackathon codename.

### Built during the event

Before kickoff there was only a scaffold, committed exactly as received in `e3ba154`: design docs, the Meta model catalog, prompt drafts, the product template's rules and skills, types, the database schema, config, and route stubs that returned 501. All working code was written from Oct 26 on. An Oct 27 audit found five small scaffold helpers still in use and rewrote them the same day. The README's Status section has the details.

## 2. Video script

Target length 2:50. Shot 7 is the first cut if it runs long, which brings it to 2:35. The narration is about 440 words, which needs about 155 words a minute, slightly brisk. Cutting shot 7 brings it to about 400.

### Before you record

- The public Blob store is connected and the live site can build.
- `npm run rebuild-all` has run against the live site, so Rebuilds and Gallery are full of published products with recorded demos.
- The second fine-tuning run is judged (tuned won 40 of 40), and its placeholders are filled in.
- Decide which model the live site builds on (`BUILDS_ON_CONTRIBUTOR`). Shots 2 to 4 say Muse Wonder. If the flag is on, change those lines to match what is on screen.
- The Nov 1 fine-tuning run was through a test harness, so it is not on the public page. Show its numbers as a labeled title card.
- Download the recipe demo clips linked in [PROVE_RESULTS.md](PROVE_RESULTS.md) for shot 7. Their Previews are behind a sign-in, so don't film those pages. Label every clip "Test model."
- Take dated screenshots of OpenRouter's rankings and Meta's Videos page on the day you record. The numbers move.
- Record one real build from the Make page to the end. Speed it up in editing and label it "Sped up. Real build."
- Browser at 1280×720 or 1440×900, light theme, 100% zoom, a clean profile with no other tabs or bookmarks. Stay signed out, so the site shows what judges see: "Guest, Builder, sign-in off."
- Never show `.env.local`, the Vercel or Lambda consoles, or an admin job page, which shows the instance's IP and region. Film the Lab's public, read-only view.

### Timing

| # | Time | Shot |
|---|---|---|
| 1 | 0:00-0:13 | The problem |
| 2 | 0:13-0:25 | Make page |
| 3 | 0:25-0:44 | Build room: brief and build |
| 4 | 0:44-0:59 | Build room: checks and fix rounds |
| 5 | 0:59-1:16 | Product page and its recorded demo |
| 6 | 1:16-1:35 | Rebuilds |
| 7 | 1:35-1:50 | What it can build (cut first) |
| 8 | 1:50-2:05 | Dashboard and the connector |
| 9 | 2:05-2:20 | Usage |
| 10 | 2:20-2:42 | Fine-tuning lab |
| 11 | 2:42-2:50 | Close |

### Shots

**1. The problem (0:00-0:13)**

- On screen: the dated OpenRouter rankings screenshot, slow zoom on the list of top model authors. Cut to the dated screenshot of Meta's Videos page, every card a Llama demo.
- Say: "Meta's models read photos, video and PDFs, make images, outline objects and transcribe speech. Yet Meta isn't in OpenRouter's top nine model authors, and every demo on its own Videos page still shows Llama."

**2. Make page (0:13-0:25)**

- On screen: open https://muse-muse.vercel.app. The sidebar, the "What should Muse make?" headline, the composer and three cards show. Click **Receipt to spreadsheet**. The receipt photo attaches as a chip and the note fills in. Open **Build setup** under the cards: Model `muse-wonder-1.0`, Builder Muse Code, Fix rounds Up to 3. Click the blue send button.
- Say: "Muse Muse starts from an example instead of a long prompt. Drop in a photo, a sketch, a video, a voice memo or a PDF, and Muse Code builds the product."

**3. Build room: brief and build (0:25-0:44)**

- On screen: the build room opens with the muse as the user turn. The brief turn renders: product name, the models table, limits, cost per use, and what it takes and leaves out. Start the time-lapse, labeled "Sped up. Real build." Muse Code's log lines scroll, "Edited N files" lines appear, and a "Muse Code started its ... reminder" line passes. The step rail moves through Brief, Provision, Build and Preview, and the live preview card appears in the right panel.
- Say: "Muse Wonder reads the inspo and writes a brief: the models it needs, honest limits and the cost. Then Muse Code runs headless in a Vercel Sandbox microVM. The firewall adds the Meta key only on Muse Code's own routes, so the code it writes never sees the key."

**4. Build room: checks and fix rounds (0:44-0:59)**

- On screen: the check results turn: verify, the smoke test, the judge's screenshots and its verdict. If this build had a fix round, show the fix turn with the attached screenshots. The rail reaches Check, Record and Deploy. Hold on the metadata line with time, tokens and cost.
- Say: "Then it checks its own work: typecheck, build, the smoke test Muse Code wrote, and Muse Wonder judging screenshots against the brief. A failure goes back to the same Muse Code session with the judge's screenshots attached. Three rounds at most."

**5. Product page and its recorded demo (0:59-1:16)**

- On screen: in the right panel's Links, click **Product page**. The live product shows in the frame. Click **Open**, drop the receipt photo into the product and show the CSV it returns. Go back and play the **Recorded demo** for about 5 seconds, through the "Waited ... sped up" badge and the zoom onto the result. Move the pointer over Models, Limits, the Muse app connector URL and **How it was built**.
- Say: "Every product ships as its own Vercel project with its own link. It reaches Meta only through our gateway, with a scoped, budgeted token. Its demo video is cut from its own passing test: the cursor, the typing, the result, and the model's wait sped up and labeled. Plus the Muse Code transcript of how it was built."

**6. Rebuilds (1:16-1:35)**

- On screen: click **Rebuilds** in the sidebar. Hold on the header with the "N of 6 rebuilt for $Y" total. Scroll the cards: Meta's original video link, the fit pill (Clean, Reframe or Partial), the rebuilt product, its demo, build time and cost. Scroll to "Demos Meta doesn't have yet." Click one card's original video link, then its rebuilt product.
- Say: "We pointed it at Meta's own demo videos and rebuilt them on current Muse models, plus first demos for SAM 3.1, Muse Image, Voice Transcribe and Muse Wonder. In our test batch, 24 of 24 builds went live, in 3 to 9 minutes, for about 30 cents to $1.80 each."

**7. What it can build (1:35-1:50, cut first)**

- On screen: quick cuts of the recorded demos: Harbor Report Studio, Mill Floor Sim, Lantern Run, Brief Desk. Corner label on each: "Test model." Then the VR shot at Score 3 of 3, labeled "Emulated Quest," and the phone on Device Farm, labeled "Galaxy S25."
- Say: "It also builds more than web pages. In our Nov 1 tests on a low-cost model, eleven recipes went live, from report studios to a 3D maze. VR passed on an emulated headset, and a product opened on a real Galaxy phone."

**8. Dashboard and the connector (1:50-2:05)**

- On screen: click **Dashboard**. The "Use your products in Muse" card shows. Click the **Muse app** tab, pick a product tab, and click copy on the connector URL. Cut to the Muse app: add it as a custom connector, ask Muse to run the product's main action, and show the answer. If the Muse app connector isn't tested by recording day, use the **Claude Code** tab and show Claude Code calling the product's tool instead, or the **cURL** tab listing its tools.
- Say: "Each product's actions become an MCP connector. Copy the URL from the dashboard, add it to the Muse app, and Muse can use the product."

**9. Usage (2:05-2:20)**

- On screen: click **Usage**. Hold on "Meta tokens driven" with its stacked Products and Building bars. Pan down to Spend (est.) and Builds, then the By product table.
- Say: "Every Meta call is metered, and the headline is Meta tokens driven. Muse Code's own usage report left out its reminder agents, 31 to 43 percent of a build's real spend. We read its session logs and charge them."

**10. Fine-tuning lab (2:20-2:42)**

- On screen: click **Fine-tuning**. Show the three steps: Write, Train, Judge. Show the Results table with both runs. Click the second run: the summary strip, then scroll the side-by-side items (prompt, Spark's reference, base answer, tuned answer, verdict). End on a title card: "Nov 1, short run, invented subject: tuned 7.93, base 2.5, 40 of 40."
- Say: "And Spark teaches Glimmer. The hosted model writes the training set, Muse Glimmer 30B learns it on a rented GPU, and the hosted model judges blind. Our first run lost 28 to 11, which exposed an eval bug. After the fix, tuned won all 40, 8.9 against 2. A Nov 1 run on a made-up subject also won 40 of 40."

**11. Close (2:42-2:50)**

- On screen: back to the Make page. Hold on the sidebar's mark, the Concept pill and "Not an official Meta product." Overlay the live URL and the repo URL.
- Say: "Muse Muse. Give it a muse, and Meta's models make it."

## 3. Submission checklist

From [BUILD_PLAN.md](BUILD_PLAN.md#submission-checklist), updated Nov 1.

### Done

- [x] **Live platform URL.** https://muse-muse.vercel.app, open with no sign-in (`OPEN_ACCESS=guest`). The Oct 27 rules answer was that we spend our own credit. Every visitor shares one guest account with a daily build cap, and a platform-wide daily spend cap stops builds and gateway calls.
- [x] **Rebuilds and Gallery pages live**, with each product's recorded demo, build time and cost on its card. All 10 catalog rebuilds went live in the Oct 27 local batch, each with a recorded MP4.
- [x] **Repo docs.** The README has what it does, an architecture diagram, setup, and the note on what existed before kickoff (its Status section).
- [x] **Every Meta model and tool used, and where.** See "How it uses Meta's models" above.
- [x] **Fine-tuning lab** with public, read-only results at `/fine-tuning`.
- [x] **Video script.** Section 2 above, updated Nov 1 from real results.
- [x] **Test results.** [PROVE_RESULTS.md](PROVE_RESULTS.md) lists every Nov 1 item with its state, evidence and cost.
- [x] **Rules answers** on pre-kickoff code, credits and Meta's brand (Oct 27, in BUILD_PLAN.md).
- [x] **A public Blob store on the live site.** "muse-blob" is connected through OIDC (`BLOB_STORE_ID`, no read-write token). The server signs in with the request's OIDC token and browsers upload through presigned URLs. `npm run rebuild-all` then ran against the live site on Oct 28: 9 of 10 catalog rebuilds went live, including all 6 of Meta's videos, for $24.70 in total. The Muse Wonder first demo failed its smoke test in all 3 fix rounds.
- [x] **Try tuned Glimmer live.** A time-boxed GPU demo answers visitors' app ideas with base and tuned Muse Glimmer side by side on the run's public page. Tested in production on Oct 28: about 90 seconds per answer pair, about $1.50 for a 30-minute window.

- [x] **Demo Studio.** Launch-clip demo videos for every product: cursor, camera, sped-up waits with a badge, captions below the window, intro and outro cards, and a poster on the result.
- [x] **The Meta look for products**, with the `meta-ui` skill, and measured blind: 30 of 33 votes against the old template.
- [x] **Hugging Face export** of tuned adapters, their training data and a card story, built and tested against a fake Hub. Waiting on a write token.

### Left

- [ ] **Make the repo public, if the rules need it.** It is on GitHub and private. Only an owner can change that. Check that the scaffold commit `e3ba154` is still visible first.
- [ ] **Merge the open PRs** (#24 to #27). #24, #25 and #26 have conflicts. Until #26 lands, Muse Code sessions can't start on Vercel from main.
- [ ] **Answer the open plan items:** track, company and team, and Silly Doodle Pages.
- [ ] **Replace the rented GPU addresses** still in 5 finished knowledge scripts, if you want them gone before the repo goes public.
- [ ] **Record the video** from section 2, including the dated OpenRouter and Meta Videos page screenshots for the opening.
- [ ] **Hugging Face:** set `HF_TOKEN` and `HF_NAMESPACE` on Vercel, then publish run 2 with a `glimmer-publish` job and check both repos and cards on the Hub.
- [ ] **Rebuild the catalog on the live site** with the new snapshot, so Rebuilds and Gallery show the Meta look and Demo Studio videos.
- [x] Fill in the second fine-tuning run's result (tuned won 40 of 40).
- [ ] **After the event, rotate the Vercel token and the Lambda API key.**

### Worth checking before you submit

- The rules questions still open in BUILD_PLAN.md: more than one project per person, what the submission must include (video length, public repo, write-up, live link, judge access), and limits on open-source use.
- Every visitor shares the guest account's daily build cap (`MAX_BUILDS_PER_USER_PER_DAY`). Set it for the number of judges you expect, and keep `DAILY_SPEND_CAP_USD` above what those builds cost.
