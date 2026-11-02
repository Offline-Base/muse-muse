# What we can say

This is for whoever writes the submission, the video and the posts. Written Nov 2, 2026.

It comes from three deep-research reports the owner ran in a browser: Meta's direction, evidence for the problem, and a short third one. I checked them against this repo's copy of Meta's docs (`content/meta-docs/`) and against web search. I didn't open the reports' own citations. A line counts as proven only if it's marked Checked below.

## Quotes and facts

| Line | Source | Status | Use it for |
|---|---|---|---|
| "you own the weights, the runtime, and the data" | Meta's Muse Glimmer docs | Checked, word for word: `content/meta-docs/pages/muse-glimmer.md` line 5 | The "own it" idea, credited to Meta, not claimed as ours |
| "Run Muse Glimmer locally and escalate to Muse Spark only after you approve the text the tool is about to send" | Meta cookbook, "Local agent that asks first" | Checked: `content/meta-docs/pages/cookbook/glimmer-api-agent.md` | Not a pitch line. It's the closest thing Meta ships to Muse Privacy; see point 1 below |
| "Compare your fine-tuned model against the base model on a held-out test set before deploying. Track both your task metric and a general-capability benchmark so you catch regressions from over-fitting." | Meta's Glimmer post-training docs | Checked: `content/meta-docs/pages/muse-glimmer/post-training.md` line 371 | Shows our blind check follows Meta's own advice. We do the first half only; see Gaps |
| Meta's smallest Glimmer files are 16.8 GB (Q4_K_M) and 19.7 GB | Meta's quantization docs | Checked: `content/meta-docs/pages/muse-glimmer/quantization.md` lines 11 to 12 | Shows how far below Meta's smallest file our 8 GB board run goes |
| Meta names LM Studio, Ollama and Unsloth as ways to run Glimmer | Meta's Glimmer docs | Checked: `muse-glimmer.md` lines 36 to 42 | Why "a UI for fine-tuning" isn't new |
| A fully private mode for personal agents, where even Meta can't see or grant access to your information | Zuckerberg's letter, Aug 10, 2026 | Many outlets report the commitment, but they word it differently, and one gives the letter a different title | Copy the exact sentence from the letter before putting it on screen |
| "People are starting to be able to manifest ideas themselves without having to raise money or build large teams." | Zuckerberg, same letter, per the report | Not found. A search for these words turned up nothing | Don't use it until someone finds it in the letter. The report's suggested opener is this line, so check it first |
| Johns Hopkins Bayview notified 3,182 patients after a worker uploaded a patient spreadsheet to an AI tool the hospital hadn't approved. The upload was found Sept 21, 2026 | The hospital's statement, reported by WMAR, HealthExec and the Baltimore Banner | Checked across outlets, which differ on what was in the sheet | Muse Privacy's "why". Say "a patient spreadsheet" and "3,182 patients", nothing more about its contents |
| All 12 federal agencies GAO reviewed restricted generative AI in some way, some to public data only | GAO-25-107653, July 2025 | The report exists. The 12-of-12 detail wasn't confirmed | Check the report's text before using it |
| Judging weights: impact 30, Meta tooling 25, demo 25, technical depth 20 | Secondary write-ups of the event waiver | Matches the scoring the owner pasted earlier. I didn't find it in Meta's own text | Planning, not quoting |
| "Show us what becomes possible when these models meet the real world." | The event page, per the report | Not checked | Check the event page first |
| "The access decision does not depend on the agent behaving as intended." | Meta Engineering, "PrivacyLib: Privacy Controls at the Data Access Boundary", Oct 27, 2026 (pasted by the owner) | Its authors and reviewers have engineering.fb.com author pages, and PrivacyLib appears in Meta's 2025 privacy posts. This 2026 post itself wasn't found by search | Muse Privacy's design: enforce at the exit, outside the model. Open the post before quoting it |
| "Keep the complexity in text files that are readable by both humans and agents, rather than fine-tuned model weights." | Meta Engineering, "An Organizational Second Brain", Sep 2, 2026 (pasted by the owner) | The post and its authors' pages exist on engineering.fb.com. One listing dates it Aug 11, 2025 | It argues against tuning weights for an organization's knowledge, so it cuts against a tune-first pitch. Say we tune for behavior on small devices and keep knowledge in files. Open the post first |

## What the research changes

1. **Meta already ships a local-then-cloud pattern.** In its cookbook, Glimmer runs locally, the person sees the exact text, and Muse Spark gets that text only once the person approves it. Each send is logged.
   - `privacy/docs/PRIOR_WORK.md` lists PlanTwin, Minions and PAPILLON but not this. A judge from Meta will know it, so list it first.
   - The difference, from `privacy/README.md`: Muse plans over tags and never gets the documents. A policy file decides what may leave, a check for names and identifiers runs on every result, and a router learns from what was approved before. Nobody has to approve each string.
   - Measured so far: 0 leaks of names or identifiers on invented sets.
   - Research says hybrid splits do leak (PAPILLON's best setup leaked 7.5%). So the claim is always "measured on N invented items", never "never leaves".
2. **Fine-tuning isn't the new part.** Meta documents SFT, LoRA, QLoRA and RL for Glimmer, and points to Unsloth. We tune on Unsloth's 4-bit build, so say so.
   - The claim: one sentence becomes a plan, data, a tune, a blind check against the base model, and a file you keep, plus an app built around it.
3. **The Jetson result is the honest frontier.** Meta's smallest Glimmer is 16.8 GB. The knowledge run's r30b, cut to 5.75 GB, now runs on a real Jetson Orin Nano 8GB (`jetson-02`, llama.cpp).
   - On the board: 5 to 6 tokens a second with poor answers. Its card reports loops on 17 of 60 prompts.
   - On Hussam's 40-receipt bench (PR #62) it gave 0% valid JSON, and the board stopped answering at receipt 23 and needed a power cycle. Bolt on jetson-04 got 88% of fields right and LFM3-VL on jetson-05 82%. So don't film it doing a document task.
   - Show it as "a third the size of Meta's smallest file, and here's what that costs", never as the model doing the reasoning in a demo.
   - r30b is a Derivative of Muse Spark Open (BUILD_LOG, Oct 31, "r30b is a Derivative of Muse Spark Open"). So "Built with Muse Spark Open" goes on screen with it, and its Usage Policy means 18 and over.
4. **Don't pitch a gap in Meta's lineup.** Meta already has Muse (a personal agent with a Secure VM and audit trail), Muse Code, Glimmer and the cookbook above. Replit and Lovable already turn a sentence into an app.
   - The safe contrast, from the report: "Meta now offers frontier cloud models and open models for local use. Muse Muse explores whether one person can move between them, shape the result, and leave with something they control."
5. **Compliance.** The privacy toggles already say none of them makes anyone legally covered. Keep it that way.

## Gaps the research points at

None of these is built.

- **General-capability and safety checks on a tune.** Meta's guide says to track a general benchmark as well as the task metric, and research finds small fine-tunes can weaken safety. Our blind check compares tuned and base on held-out task prompts only. Adding a small general set and a small safety set to the same judge would let us say we follow Meta's guide in full.
- **A network capture for Muse Privacy.** Plant a canary string in a document, record every outbound request during a run, and show that the string never goes out. This is stronger than counting leaks with our own checker.
- **The judge as one signal, not the gate.** Research puts LLM code judges at 17 to 22% false positives. Our build checks run typecheck, build and a smoke test before the judge, so say the judge is one check of four.

## Stale lines, fixed Nov 2 on branch tg-messaging

- `privacy/README.md` and `privacy/CLAUDE.md` said "solo" and the Build for Your World theme. They now say Ethan and Hussam, Push the Frontier.
- `privacy/README.md`, `docs/STORY.md`, `docs/OFFLINE.md` and `lib/story/flow.ts` (the `/offline` page) said no Glimmer had run on a Jetson, or that jetson-02 ran LFM3. They now give the r30b run on jetson-02 with its limits.
- `docs/STORY.md`: the lifted no-company-name rule, and the Oct 30 run with 10 leaks next to the "0 leaks" line.
- `privacy/docs/PRIOR_WORK.md` lists Meta's "Local agent that asks first" first.

Still stale, found by Hussam's PR #61 and left for later because they need a new builder snapshot or are Muse Privacy's own copy:
- `template/.agents/skills/meta-glimmer/SKILL.md` lines 3 and 14, and `lib/prompts/catalog.ts` line 201, still pitch Glimmer for "local, private or offline" use.
- `privacy/README.md` line 13 and `privacy/docs/OTHER_APPS.md` line 5 say the Claude and ChatGPT apps weren't tried, but `privacy/docs/BUILD_LOG.md` for Oct 31 shows both working.

## Don't say

- That Meta hasn't built private AI, fine-tuning or local agents.
- That Muse Privacy solves Meta's local-and-cloud problem.
- That data never leaves the device. Say how many leaks on how many invented items, and what that tested.
- "0 leaks on 300 items" alone. An Oct 30 run (`privacy/eval/reports/device_only_fresh_200.md`) had 10 leaks on 200 items, with no cause recorded and no rerun. Give both, or rerun that set first.
- That fleet or board answers are private. They pass through the product's server, Muse Muse, ngrok and the lead board, and jetson-05's ngrok agent keeps recent request bodies in memory (PR #61).
- That Glimmer 30B runs well on 8 GB.
- That one-bit or 4-bit costs nothing.
- That the whole chain runs end to end. The marks in `docs/STORY.md` decide what's proven.
- HIPAA, FERPA or COPPA compliant, or compliant because it's offline.
- That the judge proves an app works.
- That most non-developers now build software.
- That Muse Spark Open is unrestricted open source, or that LFM is free for any company. LFM's free license covers companies under $10M a year in revenue.
- That Meta is going closed, or that everything Meta makes will be open.
- Any judge's name. None has been made public.
