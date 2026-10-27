# Build plan, Oct 26 to Nov 4

About 44 hours: 3 a night on weekdays and 10 on Saturday and Sunday. Submissions are due Nov 4 at 9 PM ET.

## Rules check

The Official Rules weren't on the public event pages as of Oct 26 at 9:30 PM ET. Check your acceptance email and the Discord, then answer these:

- [x] Is code written before Oct 26 allowed? If so, does it need disclosure? **Answer (Oct 27): a scaffold is fine, code is not.** The scaffold is commit e3ba154, exactly as received.
- [ ] Can one person submit more than one project?
- [ ] What does the submission need: video length, public repo, write-up, live link, test access for judges?
- [ ] Are there any limits on open-source use? (The Vercel Open Agents template and the v0-style builder guide are useful references.)
- [x] Do judges need their own credits, or will they spend yours? This decides how open the live demo can be. **Answer (Oct 27): we have our own credit.** Production runs with no sign-in (`OPEN_ACCESS=guest`) on the platform's key.
- [x] Is there anything on using Meta's brand, look or content? This affects the dashboard-native UI and the rebuilds of Meta's videos. **Answer (Oct 27): Meta's brand is fine, and the UI should be near identical to Meta's dashboard.**

## Day-one spikes

Each spike has a pass condition. If one fails, use its fallback and keep moving.

| # | Spike | Pass condition | Fallback |
|---|---|---|---|
| 1 | Muse Code headless inside a Vercel Sandbox. Install it, set `META_API_KEY=brokered`, broker the real key for `api.meta.ai`, run `muse exec --json --yolo "create hello.txt"`. Then try `muse exec --image inspo/sketch.png "describe this image in DESCRIPTION.md"` | Exit 0, `hello.txt` exists, JSONL saved, no real key visible in the sandbox env. Record whether `--image` works | A dedicated low-budget key inside the sandbox, egress limited to `api.meta.ai` and npm. Without `--image`, rely on the brief's written descriptions of the inspo |
| 2 | Template builds and previews in the sandbox. `npm ci`, `next dev -H 0.0.0.0 -p 3000`, open `sandbox.domain(3000)` | Preview loads in a browser | Use `next build && next start` for the preview |
| 3 | Gateway plus the four Meta helpers in `template/lib/meta`. One real call each to Spark 1.3, Muse Image, SAM 3.1 and Voice Transcribe. Confirm Meta accepts the `detail` field that `imagePart` sends, and the `/v1/asr/transcribe` request format | All four return results through `/api/gateway/v1/*` with a product token | Drop `detail` in `imagePart`. Mark Voice as file-only or drop it from v1 |
| 4 | Publish from the platform. Read files out of the sandbox, create a Vercel project, set env vars, deploy | Live URL serves the template and its gateway call works | Deploy prebuilt output |
| 5 | Snapshot. Save a warm builder snapshot with Muse Code and `node_modules` | New sandbox from snapshot is ready to build in under 30 seconds | Accept a slower cold start |

## Schedule

| Day | Hours | Work | Done when |
|---|---|---|---|
| Mon Oct 26 | 3 | Rules check. Repo, Vercel project, Neon, env vars. Spike 1 | Muse Code runs headless in a sandbox |
| Tue Oct 27 | 3 | Spikes 2 and 3. Implement `template/lib/meta/*` and the gateway route | Template preview works and calls Meta through the gateway |
| Wed Oct 28 | 3 | Brief writer that reads inspo (images, video, PDF, voice memo). Muse page with inspo upload and note. Build room with live events | A photo plus a note turns into a brief and a sandbox build you can watch |
| Thu Oct 29 | 3 | Verify loop: `npm run verify`, screenshots, judge, fix rounds. Demo recording with Playwright and ffmpeg | A deliberately broken product gets fixed automatically and passes with an MP4 demo |
| Fri Oct 30 | 3 | Spike 4, then the deploy and register steps | First muse ships to its own URL end to end |
| Sat Oct 31 | 10 | Run the rebuild set and the user muses below. Improve skills and AGENTS.md from every failure. Quotas, rate limits, kill switch. Spike 5 | **Checkpoint: 6 of the 10 rebuilds ship working, recorded products unattended** |
| Sun Nov 1 | 10 | Batch runner and the Rebuilds gallery. Dashboard-native shell. MCP endpoint and the Muse app connector. Product page with "how it was built" | One command rebuilds the whole list, and the Muse app calls a shipped product |
| Mon Nov 2 | 3 | Feature freeze. Run the full rebuild batch unattended and time it. That total is the headline stat | Gallery is complete with time and cost totals |
| Tue Nov 3 | 3 | Record the video from the auto-recorded demos and the build-room time-lapse. README, architecture diagram, setup steps | Video and repo are ready |
| Wed Nov 4 | 3 | Fixes only. Submit by 8 PM ET | Submitted |

If Saturday's checkpoint fails, cut the MCP connector, refinements and the shell polish, and spend Sunday on reliability. The rebuild gallery stays, because it's the pitch.

## Rebuild set

From `catalog/meta-resources.json`. These ten are the main test set and the hero of the demo.

| # | Rebuild of | Fit | Models |
|---|---|---|---|
| 1 | Fine-tuning Llama for structured image extraction | Reframe, no fine-tuning needed | Spark 1.3 |
| 2 | Multimodal WhatsApp chatbot with Llama 4 | Partial, web chat only | Spark 1.3, Muse Image, Voice Transcribe |
| 3 | Technical blogs from your docs with Llama and RAG | Clean | Spark 1.3, Muse Image |
| 4 | Rich insights from rich documents | Clean | Spark 1.3, SAM 3.1 |
| 5 | Fine-tuning Llama in the real world | Reframe, few-shot check | Spark 1.3 |
| 6 | Llama Protections | Reframe, Spark safety check | Spark 1.3 |
| 7 | First SAM 3.1 demo | New | SAM 3.1 |
| 8 | First Muse Image demo | New | Muse Image |
| 9 | First Voice Transcribe demo | New | Voice Transcribe, Spark 1.3 |
| 10 | First Muse Wonder demo | New | Muse Wonder |

## User muses

Three inspo-first muses to show that Muse Muse works beyond Meta's catalog. Number 3 also checks that a real app's screenshot becomes a product with its own name and design.

| # | Inspo | Note | Models it should pick |
|---|---|---|---|
| 1 | Photo of a bookshelf in a café | "Make me one for my wall" | SAM 3.1, Muse Image, Spark 1.3 |
| 2 | 15-second video of birds at a feeder | "Count them for me" | SAM 3.1 video tracking |
| 3 | Screenshot of a recipe app you like | "But it reads my handwritten recipe cards" | Spark 1.3 vision |

For every run, track:

- whether it shipped
- how many fix rounds it took
- how long it took and what it cost
- what broke
- whether anything got copied that shouldn't have

Every repeated failure becomes a line in AGENTS.md or a skill.

## Submission checklist

- [ ] Live platform URL with sign-in and a daily build cap
- [ ] Rebuilds gallery live, with each product's recorded demo, build time and cost
- [ ] Dated screenshots of the OpenRouter numbers and Meta's Videos page for the opening of the video
- [ ] Video of two to three minutes, following the demo script in DESIGN.md
- [ ] Repo with README, architecture diagram, setup, and a note on what existed before kickoff
- [ ] A list of every Meta model and tool used, and where
