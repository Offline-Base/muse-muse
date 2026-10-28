# Muse Muse submission

Meta Global AI Developer Hackathon, Startup track. Due Nov 4, 2026, 9 PM ET.

- **Live site:** https://muse-muse.vercel.app (open to anyone, no sign-in)
- **Repo:** PLACEHOLDER: the GitHub URL, if the rules ask for one
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
2. **Brief.** Muse Spark 1.3 reads the inspo and writes a structured brief: the product, who it's for, the Meta models it needs and why, honest limits, cost per use, and what it takes from the inspo and leaves out. It refuses requests that impersonate people or organizations, clone a real brand, or involve weapons, malware or scams.
3. **Build.** Muse Code runs headless in a Vercel Sandbox microVM and writes a Next.js product from a starter template. You watch the log and a live preview in the build room.
4. **Check.** Typecheck, build, the smoke test Muse Code wrote, a screen check, then Muse Spark 1.3 judging screenshots against the brief. Failures go back to the same Muse Code session with the judge's screenshots, up to three rounds.
5. **Demo video.** The smoke test reruns with video on and becomes an MP4 with a title card and captions.
6. **Ship.** The product deploys as its own Vercel project. It calls Meta only through the platform's metered gateway, with its own scoped, budgeted token.
7. **Use in Muse.** Its actions become an MCP connector that the Muse app (or Claude Code) can add.

Every product it ships is new, metered Meta API usage. The dashboard's headline number is "Meta tokens driven."

Two more parts sit on top:

- **Rebuilds.** One command rebuilds Meta's Llama-era demo videos on current Muse models, plus first demos for the models Meta has no video for: SAM 3.1, Muse Image, Voice Transcribe and Muse Wonder.
- **Fine-tuning lab, "Spark teaches Glimmer."** Muse Spark 1.3 writes a training set, Muse Glimmer 30B learns it with a LoRA adapter on the owner's Lambda GPUs, and Muse Spark 1.3 judges base against tuned, blind. Results are public and read-only at `/fine-tuning`.

### How it uses Meta's models

| Model or tool | Where Muse Muse uses it |
|---|---|
| **Muse Spark 1.3** | Reads every reference (images, video, PDFs) and writes the brief with strict JSON-schema output, or refuses. Judges each build's screenshots. Default model for Muse Code. Writes fine-tuning datasets and judges base against tuned Glimmer. The default model inside products. |
| **Muse Wonder 1.0** | Muse Code's build model when the brief marks a product complex. Inside products that need long, multi-step planning, such as the first Muse Wonder demo. |
| **Muse Image 1.0** | Inside products, for generating and editing images. It also made the three example photos on the Make page. |
| **SAM 3.1** | Inside products, to find, outline and count things in photos and video, such as the first SAM 3.1 demo. Results are parsed with Meta's `@meta-sam/parser`. |
| **Muse Voice Transcribe 1.0** | Turns a voice-memo muse into text before the brief. Inside products, after the browser converts audio to 16 kHz mono WAV, the only format the API accepts. |
| **Muse Code** | Writes every product, headless in a Vercel Sandbox: `muse exec --json` with hardened flags, `--session-id` to resume for fix rounds and refinements, `--image` for inspo and judge screenshots, `muse skills disable` for 15 bundled skills that fight a headless build, and `muse export --redacted` for each product's "How it was built." |
| **Muse Glimmer 30B** | The fine-tuning lab's student: a QLoRA fine-tune on Lambda GPUs, judged by Muse Spark 1.3. Products can also call a hosted Glimmer endpoint through `GLIMMER_URL` when a brief asks for a local or private model. |
| **Meta Model API endpoints** | `responses`, `images/generations`, `images/edits`, `files` and `asr/transcribe`, which products reach only through the platform's gateway. Muse Code also calls `models` and `/muse-code/models` through the sandbox firewall. |
| **Meta's Videos page** | The rebuild set: `catalog/meta-resources.json` links each video and never copies it. |

### What's novel

- **Inspo first.** You show it what you mean instead of writing a long prompt. The brief records what it takes from the inspo and what it leaves out, and the judge fails a build that copies a brand or logo.
- **Real products, not mockups.** Each one passed its own tests, has a recorded demo, a Muse Code transcript, its own deploy and an MCP connector. A product that fails is never shown as working.
- **Untrusted code never holds a Meta key.** The sandbox firewall adds the key only on Muse Code's own routes. Products get scoped, budgeted, revocable tokens through a metered gateway.
- **Meta's own demos as the test set.** The rebuilds turn Meta's Llama-era videos into current demos on Muse models, with honest fit labels: clean, reframe or partial.
- **Measured, including what didn't work.** Muse Code's hidden reminder spend is found and charged. Product quality is scored blind, and a polish round that scored lower was not merged.
- **Spark teaches Glimmer.** The hosted model writes the data, the open model learns it, the hosted model judges blind, and the results are public.

### What was hard

1. **Keeping the key away from generated code while Muse Code still works.** A blanket key transform would give any code in the VM the key's power. Now Muse Code holds a per-sandbox placeholder, and the firewall swaps it for the real key on four routes only. Every other request to `api.meta.ai` gets the firewall's 403.
2. **Muse Code with nobody watching.** Its launcher tries to self-update from a host the firewall blocks and may start a device sign-in, so the runner sets `MUSE_NO_AUTO_UPDATE=1` and `MUSE_LOGIN=0`. Its own bubblewrap sandbox can't run in the microVM, so `--yolo` is used and the VM is the boundary. Fifteen bundled skills fought the template, so the snapshot turns them off and checks. Flags differ between versions, so the runner adds optional ones only when `muse exec --help` lists them.
3. **Honest cost.** `run.usage` counts only the main agent. Reminder agents were 31% to 43% of each build's real Muse Code spend. The platform now reads the usage records in Muse Code's session logs, drops the records that reminder agents' own logs repeat, counts only the current run, and charges the rest.
4. **Media limits.** Voice Transcribe takes only mono 16-bit PCM WAV at 16 or 24 kHz, so products convert audio in the browser. Vercel Functions cap request bodies at 4.5 MB, so large files go straight to Vercel Blob with short-lived upload tickets. Meta fetches media by URL, so the Blob store has to be public.
5. **Products that work but look generic.** A blind review averaged 5.5 out of 10. A template polish raised a canary from 5.14 to 5.91. A second round scored 5.50 and cost 64% more, so it stayed on a branch.
6. **GPUs that bill by the hour.** Three things terminate every instance: the job's workflow, the instance's done callback, and a sweep every 5 minutes. Jobs won't launch unless that sweep ran in the last 15 minutes. The first real run then lost 28 to 11, and the cause was an eval bug, not the training (see Results).

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

**Fine-tuning**

- Smoke test on a real Lambda A10: about 3 minutes, $0.06.
- Dry run of the full loop on an A100: $0.13.
- Dataset "Muse Muse brief writer," written by Muse Spark 1.3: 400 examples (360 to train on, 40 held out) for $1.51.
- First real Glimmer 30B QLoRA run: A100 40 GB, 120 steps, final loss 0.47, 47 minutes, $1.59. Base won 28 to 11. That exposed an eval bug: training put every answer on Glimmer's final channel, but the eval prompt let the model choose, and the tuned answers never left the reasoning channel.
- The fix and a "short prompt" distillation setup are deployed. Eval prompts now continue on the final channel, as training does. Both models train and answer under a one-line role prompt instead of the teacher's full task prompt, so the score measures what training taught.
- Second run, with the fix and the short prompt: A100 40 GB, 120 steps, final loss 0.52, 42 minutes, $1.39 on the GPU plus $0.15 for judging. **Tuned Glimmer won all 40 held-out prompts**, average score 8.88 against 1.95 for base. Under the one-line role prompt, base Glimmer answers like a general assistant ("I can't see any photo attached, could you upload it again?"); the tuned model writes a full Muse Muse brief with the right models, honest limits and a cost per run.

### What's next

- Connect the public Blob store, run the rebuild batch on the live site, and publish every product to its own link.
- Serve a tuned Glimmer adapter as a product backend through `GLIMMER_URL`, so a product can run on an open model the lab trained.
- Spoken replies and realtime voice once the Model API has text-to-speech and speech-to-speech. Products use browser speech synthesis until then.
- More lab tasks, each judged the same way against its own held-out prompts.
- Check whether Muse app connectors work inside scheduled jobs.
- A name of its own. Muse is Meta's brand, so Muse Muse is a hackathon codename.

### Built during the event

Before kickoff there was only a scaffold, committed exactly as received in `e3ba154`: design docs, the Meta model catalog, prompt drafts, the product template's rules and skills, types, the database schema, config, and route stubs that returned 501. All working code was written from Oct 26 on. An Oct 27 audit found five small scaffold helpers still in use and rewrote them the same day. The README's Status section has the details.

## 2. Video script

Target length 2:50. Shot 7 is the first cut if it runs long, which brings it to 2:35. The narration is about 410 words, which is about 150 words a minute, a normal reading pace.

### Before you record

- The public Blob store is connected and the live site can build.
- `npm run rebuild-all` has run against the live site, so Rebuilds and Gallery are full of published products with recorded demos.
- The second fine-tuning run is judged (tuned won 40 of 40), and its placeholders are filled in.
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
| 7 | 1:35-1:50 | Gallery (cut first) |
| 8 | 1:50-2:05 | Dashboard and the connector |
| 9 | 2:05-2:20 | Usage |
| 10 | 2:20-2:42 | Fine-tuning lab |
| 11 | 2:42-2:50 | Close |

### Shots

**1. The problem (0:00-0:13)**

- On screen: the dated OpenRouter rankings screenshot, slow zoom on the list of top model authors. Cut to the dated screenshot of Meta's Videos page, every card a Llama demo.
- Say: "Meta's models read photos, video and PDFs, make images, outline objects and transcribe speech. Yet Meta isn't in OpenRouter's top nine model authors, and every demo on its own Videos page still shows Llama."

**2. Make page (0:13-0:25)**

- On screen: open https://muse-muse.vercel.app. The sidebar, the "Start from an example" title and three cards show. Click **Receipt to spreadsheet**. The receipt photo attaches as a chip and the note fills in. Move the pointer over the right panel: Model `muse-spark-1.3`, Builder Muse Code, Fix rounds Up to 3. Click the blue send button.
- Say: "Muse Muse starts from an example instead of a long prompt. Drop in a photo, a sketch, a video, a voice memo or a PDF, and Muse Code builds the product."

**3. Build room: brief and build (0:25-0:44)**

- On screen: the build room opens with the muse as the user turn. The brief turn renders: product name, the models table, limits, cost per use, and what it takes and leaves out. Start the time-lapse, labeled "Sped up. Real build." Muse Code's log lines scroll, "Edited N files" lines appear, and a "Muse Code started its ... reminder" line passes. The step rail moves through Brief, Provision, Build and Preview, and the live preview card appears in the right panel.
- Say: "Muse Spark 1.3 reads the inspo and writes a brief: the models it needs, honest limits and the cost. Then Muse Code runs headless in a Vercel Sandbox microVM. The firewall adds the Meta key only on Muse Code's own routes, so the code it writes never sees the key."

**4. Build room: checks and fix rounds (0:44-0:59)**

- On screen: the check results turn: verify, the smoke test, the judge's screenshots and its verdict. If this build had a fix round, show the fix turn with the attached screenshots. The rail reaches Check, Record and Deploy. Hold on the metadata line with time, tokens and cost.
- Say: "Then it checks its own work: typecheck, build, the smoke test Muse Code wrote, and Spark judging screenshots against the brief. A failure goes back to the same Muse Code session with the judge's screenshots attached. Three rounds at most."

**5. Product page and its recorded demo (0:59-1:16)**

- On screen: in the right panel's Links, click **Product page**. The live product shows in the frame. Click **Open**, drop the receipt photo into the product and show the CSV it returns. Go back and play the **Recorded demo** for about 3 seconds. Move the pointer over Models, Limits, the Muse app connector URL and **How it was built**.
- Say: "Every product ships as its own Vercel project with its own link. It reaches Meta only through our gateway, with a scoped, budgeted token. It comes with a demo recorded from its own test, and the Muse Code transcript of how it was built."

**6. Rebuilds (1:16-1:35)**

- On screen: click **Rebuilds** in the sidebar. Hold on the header with the "N of 6 rebuilt for $Y" total. Scroll the cards: Meta's original video link, the fit pill (Clean, Reframe or Partial), the rebuilt product, its demo, build time and cost. Scroll to "Demos Meta doesn't have yet." Click one card's original video link, then its rebuilt product.
- Say: "We pointed it at Meta's own demo videos and rebuilt them on current Muse models, plus first demos for SAM 3.1, Muse Image, Voice Transcribe and Muse Wonder. In our test batch, 24 of 24 builds went live, in 3 to 9 minutes, for about 30 cents to $1.80 each."

**7. Gallery (1:35-1:50, cut first)**

- On screen: click **Gallery**. Scroll the grid slowly. Point at two cards' model chips and their "Built in ... · $..." line. Click one to show its demo poster.
- Say: "A blind review scored our first 24 products 5.5 out of 10. After a template polish, 11 of the same muses went from 5.14 to 5.91. A second polish scored lower and cost more, so we dropped it."

**8. Dashboard and the connector (1:50-2:05)**

- On screen: click **Dashboard**. The "Use your products in Muse" card shows. Click the **Muse app** tab, pick a product tab, and click copy on the connector URL. Cut to the Muse app: add it as a custom connector, ask Muse to run the product's main action, and show the answer. If the Muse app connector isn't tested by recording day, use the **Claude Code** tab and show Claude Code calling the product's tool instead, or the **cURL** tab listing its tools.
- Say: "Each product's actions become an MCP connector. Copy the URL from the dashboard, add it to the Muse app, and Muse can use the product."

**9. Usage (2:05-2:20)**

- On screen: click **Usage**. Hold on "Meta tokens driven" with its stacked Products and Building bars. Pan down to Spend (est.) and Builds, then the By product table.
- Say: "Every Meta call is metered, and the headline is Meta tokens driven. Muse Code's own usage report left out its reminder agents, 31 to 43 percent of a build's real spend. We read its session logs and charge them."

**10. Fine-tuning lab (2:20-2:42)**

- On screen: click **Fine-tuning**. Show the three steps: Write, Train, Judge. Show the Results table with both runs. Click the second run: the summary strip, then scroll the side-by-side items (prompt, Spark's reference, base answer, tuned answer, verdict).
- Say: "And Spark teaches Glimmer. Muse Spark 1.3 wrote 400 training examples for a dollar fifty-one. Muse Glimmer 30B learns them on a Lambda GPU, and Spark judges base against tuned, blind. Our first run lost 28 to 11, and that exposed an eval bug." Then one line on the second run: "After the fix, tuned Glimmer won all 40, scoring 8.9 out of 10 against 2. A 30 billion parameter open model learned to write our briefs, for under two dollars of GPU time."

**11. Close (2:42-2:50)**

- On screen: back to the Make page. Hold on the sidebar's mark, the Concept pill and "Not an official Meta product." Overlay the live URL and the repo URL.
- Say: "Muse Muse. Give it a muse, and Meta's models make it."

## 3. Submission checklist

From [BUILD_PLAN.md](BUILD_PLAN.md#submission-checklist), updated Oct 27.

### Done

- [x] **Live platform URL.** https://muse-muse.vercel.app, open with no sign-in (`OPEN_ACCESS=guest`). The Oct 27 rules answer was that we spend our own credit. Every visitor shares one guest account with a daily build cap, and a platform-wide daily spend cap stops builds and gateway calls.
- [x] **Rebuilds and Gallery pages live**, with each product's recorded demo, build time and cost on its card. All 10 catalog rebuilds went live in the Oct 27 local batch, each with a recorded MP4.
- [x] **Repo docs.** The README has what it does, an architecture diagram, setup, and the note on what existed before kickoff (its Status section).
- [x] **Every Meta model and tool used, and where.** See "How it uses Meta's models" above.
- [x] **Fine-tuning lab** with public, read-only results at `/fine-tuning`.
- [x] **Video script.** Section 2 above.
- [x] **Rules answers** on pre-kickoff code, credits and Meta's brand (Oct 27, in BUILD_PLAN.md).

### Left

- [ ] **A public Vercel Blob store, so the live site can build.** The store made so far is private: it rejects public uploads, and Meta can't fetch from it. Connect a public store and set `BLOB_READ_WRITE_TOKEN` on the Vercel project. Then run `npm run rebuild-all` against the live site, so Rebuilds and Gallery fill with published products.
- [ ] **A GitHub repo, if the rules need one.** The repo is local with no remote. Push `main` with its full history, so the scaffold commit `e3ba154` stays visible.
- [ ] **Record the video** from section 2, including the dated OpenRouter and Meta Videos page screenshots for the opening.
- [x] Fill in the second fine-tuning run's result (tuned won 40 of 40).
- [ ] **After the event, rotate the Vercel token and the Lambda API key.**

### Worth checking before you submit

- The rules questions still open in BUILD_PLAN.md: more than one project per person, what the submission must include (video length, public repo, write-up, live link, judge access), and limits on open-source use.
- Every visitor shares the guest account's daily build cap (`MAX_BUILDS_PER_USER_PER_DAY`). Set it for the number of judges you expect, and keep `DAILY_SPEND_CAP_USD` above what those builds cost.
