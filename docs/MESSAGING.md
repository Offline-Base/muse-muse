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

## What the research changes

1. **Meta already ships a local-then-cloud pattern.** In its cookbook, Glimmer runs locally, the person sees the exact text, and Muse Spark gets that text only once the person approves it. Each send is logged.
   - `privacy/docs/PRIOR_WORK.md` lists PlanTwin, Minions and PAPILLON but not this. A judge from Meta will know it, so list it first.
   - The difference, from `privacy/README.md`: Muse plans over tags and never gets the documents. A policy file decides what may leave, a check for names and identifiers runs on every result, and a router learns from what was approved before. Nobody has to approve each string.
   - Measured so far: 0 leaks of names or identifiers on invented sets.
   - Research says hybrid splits do leak (PAPILLON's best setup leaked 7.5%). So the claim is always "measured on N invented items", never "never leaves".
2. **Fine-tuning isn't the new part.** Meta documents SFT, LoRA, QLoRA and RL for Glimmer, and points to Unsloth. We tune on Unsloth's 4-bit build, so say so.
   - The claim: one sentence becomes a plan, data, a tune, a blind check against the base model, and a file you keep, plus an app built around it.
3. **The Jetson result is the honest frontier.** Meta's smallest Glimmer is 16.8 GB. The knowledge run's r30b, cut to 5.75 GB, now runs on a real Jetson Orin Nano 8GB (`jetson-02`, llama.cpp).
   - Its card reports 5 to 6 tokens a second, poor answers, and loops on 17 of 60 prompts.
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

## Stale lines found while checking

These belong to the "repo and submission ready" item, which is waiting on the owner.

- `privacy/README.md` line 5 says "Built solo" (it's Ethan and Hussam) and "under the theme Build for Your World" (the entry is Push the Frontier). Line 37 quotes that theme too.
- `privacy/README.md` lines 167 and 182 say Glimmer hasn't run on the Jetson. A different Glimmer file (r30b at 5.75 GB) has now run there; see point 3.
- `docs/STORY.md` says "No Jetson access yet", and lists "anything ran on a Jetson" under What not to say.
- `docs/OFFLINE.md` line 512 says jetson-02 runs LFM3-1.7B. It runs r30b now, with the LFM3 setup backed up on the board.

## Don't say

- That Meta hasn't built private AI, fine-tuning or local agents.
- That Muse Privacy solves Meta's local-and-cloud problem.
- That data never leaves the device. Say how many leaks on how many invented items, and what that tested.
- That Glimmer 30B runs well on 8 GB.
- That one-bit or 4-bit costs nothing.
- That the whole chain runs end to end. The marks in `docs/STORY.md` decide what's proven.
- HIPAA, FERPA or COPPA compliant, or compliant because it's offline.
- That the judge proves an app works.
- That most non-developers now build software.
- That Muse Spark Open is unrestricted open source, or that LFM is free for any company. LFM's free license covers companies under $10M a year in revenue.
- That Meta is going closed, or that everything Meta makes will be open.
- Any judge's name. None has been made public.
